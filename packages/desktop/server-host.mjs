import { StringDecoder } from "node:string_decoder";
import { withoutControlToken } from "../client/control-environment.mjs";
import { requireControlToken } from "./control-token.mjs";
// Server host — owns the app's backend-server child process lifecycle and the
// ownership/trust-state transitions. Extracted from main.mjs so the REAL
// production seam is importable in tests (review wsadd3: regressions that
// reimplement `|| transition` or cache invalidation in mocks pin nothing —
// deleting the production line left them green).
//
// Invariants owned here:
//  - ownership persists across a replacement (owned() is true from the
//    moment replace() starts until it finishes) — adds arriving mid-
//    transition queue instead of failing foreign;
//  - a child's late exit can only clear the reference to ITSELF, never to
//    a successor;
//  - replace() awaits the old child's actual exit (SIGKILL fallback) before
//    the caller rebinds the port, and invalidates the advertised trust
//    state at transition start via onInvalidate() — stale entries from the
//    outgoing server must never validate anything.
//  - the child's stdin is the owner lifeline (#698): a pipe whose write end
//    only this process holds, never written to and never ended. When this
//    process ends by any path (quit, crash, SIGKILL) the kernel closes it, and
//    the server, started with --exit-on-stdin-close, sees EOF and exits.
//    Node creates the pipe close-on-exec, so no other child (CLI runs, ptys,
//    a tmux server) inherits the write end and keeps the server alive.

/** The argument that tells the server its stdin is the owner lifeline. */
export const LIFELINE_FLAG = "--exit-on-stdin-close";

/**
 * How main starts the bundled server: THE production argv and options,
 * importable so a test starts the real server exactly as main does
 * (dropping the lifeline flag or the stdin pipe here fails a test).
 *
 * @param {object} o
 * @param {string} o.execPath          the executable (the packaged Electron, run as Node)
 * @param {string} o.bin               server/oats-web.mjs
 * @param {string[]} o.dirs            deployments to serve
 * @param {number} o.port
 * @param {string|null} [o.oatsBin]    the persisted user-chosen oats binary
 * @param {string} o.pathSource        where the inherited PATH came from
 * @param {string|null} [o.pathError]
 * @param {string} o.remoteIdentityFile
 * @param {string} o.home              cwd when no deployment is served
 * @param {string} o.controlToken     this launch's token (server only)
 * @param {object} o.env               this process's environment
 * @returns {{ command: string, args: string[], options: object }}
 */
export function serverSpawnSpec(o) {
  return {
    command: o.execPath,
    args: [o.bin, "start", "--port", String(o.port),
      ...o.dirs.flatMap((d) => ["--dir", d]), ...(o.oatsBin ? ["--oats-bin", o.oatsBin] : []),
      // Where the PATH it inherits came from, for /api/cli diagnostics.
      "--path-source", o.pathSource, ...(o.pathError ? ["--path-error", o.pathError] : []),
      // The remembered remote workspace identities (#482): the server owns the file, written atomically.
      "--remote-identity", o.remoteIdentityFile,
      LIFELINE_FLAG],
    options: {
      // stdin: the owner lifeline (header). Never "ignore": /dev/null is EOF at once.
      stdio: ["pipe", "pipe", "pipe"],
      // Never the launch folder (`/` from Finder): it is not a deployment unless it is served.
      cwd: o.dirs[0] ?? o.home,
      // execPath is the packaged Electron executable. The backend and its
      // collector children must run as Node, not relaunch the app. This is the
      // one child that gets main's whole environment: the executable starts as
      // it always did (on an AppImage that includes the library path into the
      // mount), and the backend then drops what the Desktop and its packaging
      // added before it loads anything else (packages/client/own-environment.mjs).
      // Every other program main starts gets cliEnvironment(process.env),
      // computed when it starts.
      env: { ...withoutControlToken(o.env), ELECTRON_RUN_AS_NODE: "1", OATS_DESKTOP_TOKEN: requireControlToken(o.controlToken) },
    },
  };
}

/**
 * Port-committing adapter between the selection seam (ensureServerOnPort /
 * the add executor) and the host — THE production wiring, importable so
 * regressions exercise it rather than a reimplementation (review wsadd5:
 * a test-local wrapper left `port = onPort` deletable without failures).
 *
 * The invariant it owns: the port is COMMITTED (setPort) before the child
 * starts, so the child's --port, readiness probes, and the API proxy always
 * agree — ensureServerOnPort selects a fresh port BEFORE the caller's
 * module-level port is reassigned.
 *
 * @param {object} io
 * @param {{ start: Function, replace: Function }} io.host   createServerHost instance
 * @param {() => number} io.getPort
 * @param {(p: number) => void} io.setPort
 * @returns {{ spawnServer: (onPort: number, dirs: string[]) => any,
 *             replaceServer: (dirs: string[]) => Promise<void> }}
 */
export function createServerAdapter(io) {
  return {
    spawnServer(onPort, dirs) {
      io.setPort(onPort); // commit BEFORE start — probes/proxy must agree with the child
      return io.host.start([...dirs], onPort);
    },
    async replaceServer(dirs) {
      await io.host.replace([...dirs], io.getPort());
    },
  };
}

export function createServerHost(io) {
  // io: spawnChild(dirs, port) -> child (kill(sig?), once/on("exit", cb));
  //     onInvalidate() -> void (clear advertised/trust caches)
  let child = null;
  let transition = false;

  function adopt(c) {
    c.on("exit", () => { if (child === c) child = null; });
    child = c;
    return c;
  }

  return {
    owned: () => !!child || transition,
    inTransition: () => transition,
    current: () => child,
    /** Start the first child (no predecessor) on `port`. */
    start(dirs, port) {
      return adopt(io.spawnChild(dirs, port));
    },
    /** Stop the owned child (awaiting real exit) and start one with `dirs` on `port`. */
    async replace(dirs, port) {
      transition = true;
      io.onInvalidate(); // trust state belongs to the outgoing server
      try {
        const old = child;
        if (old) {
          child = null; // we own the transition; old's exit hook is now a no-op
          await new Promise((done) => {
            const t = setTimeout(() => { try { old.kill("SIGKILL"); } catch { /* gone */ } }, io.forceKillMs ?? 3000);
            old.once("exit", () => { clearTimeout(t); done(); });
            try { old.kill(); } catch { clearTimeout(t); done(); }
          });
        }
        adopt(io.spawnChild(dirs, port));
      } finally {
        transition = false;
      }
    },
    /** Shutdown: kill the owned child if any. */
    stop() {
      const c = child;
      child = null;
      if (c) { try { c.kill(); } catch { /* best-effort */ } }
      return c;
    },
  };
}

/** Observe only the owned child's complete ready line; never infer its binding from HTTP. */
export function trackServerBinding(child) {
  let pending = '', port = null, ended = false;
  const decoder = new StringDecoder('utf8');
  const waiters = new Set();
  const alive = () => !ended && !child.killed && child.exitCode == null && child.signalCode == null;
  const boundPort = () => alive() ? port : null;
  const notify = () => { for (const notify of [...waiters]) notify(); };
  const onData = bytes => {
    pending += typeof bytes === 'string' ? bytes : decoder.write(bytes);
    const lines = pending.split('\n'); pending = lines.pop().slice(-4096);
    for (const line of lines) {
      const match = /^oats-desktop server — API at http:\/\/127\.0\.0\.1:(\d+)  \(workspaces:.*\)\r?$/.exec(line);
      const reported = Number(match?.[1]);
      if (match && Number.isInteger(reported) && reported > 0 && reported <= 65535) port = reported;
    }
    notify();
  };
  const onEnd = () => { ended = true; child.stdout?.removeListener('data', onData); notify(); };
  child.stdout?.on('data', onData);
  child.once('exit', onEnd); child.once('error', onEnd);
  return {
    boundPort,
    wait({ timeout = 10000 } = {}) {
      return new Promise((resolve, reject) => {
        let timer;
        const check = () => {
          if (alive() && port === null) return;
          clearTimeout(timer); waiters.delete(check);
          if (alive()) resolve(port);
          else reject(new Error('Desktop backend ended before a live binding was available'));
        };
        waiters.add(check);
        timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error('Desktop backend did not report a binding'));
        }, timeout);
        check();
      });
    },
  };
}
