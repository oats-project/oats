// Server host — owns the app's backend-server child process lifecycle, the
// lease of each server generation (backend-client.mjs) and the ownership/
// trust-state transitions. Extracted from main.mjs so the REAL production
// seam is importable in tests (review wsadd3: regressions that reimplement
// `|| transition` or cache invalidation in mocks pin nothing — deleting the
// production line left them green).
//
// Invariants owned here:
//  - main uses only a server it started: every child is started here, with
//    a private socket directory and a fresh credential of its own
//    (launchServerChild), and talked to only through its lease;
//  - a lease becomes ready only on its own child's stdout ready line, and is
//    revoked on that child's exit or error, on stop() and at the START of
//    replace(), so no request reaches a successor with its predecessor's
//    secret, nor the predecessor with the successor's;
//  - ownership persists across a replacement (owned() is true from the
//    moment replace() starts until it finishes) — adds arriving mid-
//    transition queue instead of failing foreign;
//  - a child's late exit can only clear the reference to ITSELF, never to
//    a successor;
//  - replace() awaits the old child's actual exit (SIGKILL fallback) before
//    it starts the successor, and invalidates the advertised trust state at
//    transition start via onInvalidate() — stale entries from the outgoing
//    server must never validate anything;
//  - each generation's socket directory is removed when that generation ends;
//  - the child's stdin is the owner lifeline (#698): a pipe whose write end
//    only this process holds, never written to and never ended. When this
//    process ends by any path (quit, crash, SIGKILL) the kernel closes it, and
//    the server, started with --exit-on-stdin-close, sees EOF and exits.
//    Node creates the pipe close-on-exec, so no other child (CLI runs, ptys,
//    a tmux server) inherits the write end and keeps the server alive.
//  - the child's fd 3 carries its credential: written once and ended at once;
//    the server reads it to EOF and closes it before anything else starts.
import { randomBytes } from "node:crypto";
import { makeSocketDir } from "./backend-socket.mjs";
import { watchReadyLine } from "./backend-client.mjs";

/** The argument that tells the server its stdin is the owner lifeline. */
export const LIFELINE_FLAG = "--exit-on-stdin-close";
/** The descriptor the credential reaches the server on. */
export const TOKEN_FD = 3;

/** A fresh credential for one server child: 32 random bytes, base64url (43 characters). */
export const newServerSecret = () => randomBytes(32).toString("base64url");

/**
 * How main starts the bundled server: THE production argv and options,
 * importable so a test starts the real server exactly as main does
 * (dropping the lifeline flag, the stdin pipe or fd 3 here fails a test).
 * The credential is in neither: it goes over fd 3 (launchServerChild).
 *
 * @param {object} o
 * @param {string} o.execPath          the executable (the packaged Electron, run as Node)
 * @param {string} o.bin               server/oats-web.mjs
 * @param {string[]} o.dirs            deployments to serve
 * @param {string} o.socketPath        the private socket (backend-socket.mjs)
 * @param {string|null} [o.cliChoiceFile]  userData/oats-cli-choice.json, which main writes after its own file dialog
 * @param {string} o.pathSource        where the inherited PATH came from
 * @param {string|null} [o.pathError]
 * @param {string} o.remoteIdentityFile
 * @param {string} o.home              cwd when no deployment is served
 * @param {object} o.env               this process's environment
 * @returns {{ command: string, args: string[], options: object }}
 */
export function serverSpawnSpec(o) {
  return {
    command: o.execPath,
    args: [o.bin, "start", "--socket", o.socketPath, "--token-fd", String(TOKEN_FD),
      ...o.dirs.flatMap((d) => ["--dir", d]), ...(o.cliChoiceFile ? ["--cli-choice", o.cliChoiceFile] : []),
      // Where the PATH it inherits came from, for /api/cli diagnostics.
      "--path-source", o.pathSource, ...(o.pathError ? ["--path-error", o.pathError] : []),
      // The remembered remote workspace identities (#482): the server owns the file, written atomically.
      "--remote-identity", o.remoteIdentityFile,
      LIFELINE_FLAG],
    options: {
      // stdin: the owner lifeline (header). Never "ignore": /dev/null is EOF at once.
      // fd 3: the credential (header).
      stdio: ["pipe", "pipe", "pipe", "pipe"],
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
      env: { ...o.env, ELECTRON_RUN_AS_NODE: "1" },
    },
  };
}

/**
 * Start one server child: its own private socket directory under `socketBase`, a fresh
 * credential written to its fd 3 and ended at once. `spec(socketPath)` is serverSpawnSpec's
 * output for that socket. Throws (nothing started) when the socket path is too long
 * (backend-socket.mjs SocketPathTooLong). Returns `{ child, socketPath, secret, remove }`.
 */
export function launchServerChild({ spawn, socketBase, spec, secret = newServerSecret(), makeDir = makeSocketDir }) {
  const socket = makeDir(socketBase);
  let child;
  try {
    const s = spec(socket.socketPath);
    child = spawn(s.command, s.args, s.options);
  } catch (e) { socket.remove(); throw e; }
  const pipe = child.stdio?.[TOKEN_FD];
  if (pipe) {
    pipe.on("error", () => { /* the server read and closed it, or never started: its exit is reported */ });
    pipe.end(secret);
  }
  return { child, socketPath: socket.socketPath, secret, remove: socket.remove };
}

export function createServerHost(io) {
  // io: spawnChild(dirs) -> { child, socketPath, secret, remove } (child: kill(sig?), once/on("exit"|"error"), stdout);
  //     client: createBackendClient() — the leases;
  //     onInvalidate() -> void (clear advertised/trust caches)
  let generation = null; // { child, lease, remove } of the server main uses now
  let transition = false;

  function adopt(spawned) {
    const { child } = spawned;
    const lease = io.client.begin({ child, socketPath: spawned.socketPath, secret: spawned.secret });
    const record = { child, lease, remove: spawned.remove ?? (() => {}) };
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      io.client.revoke(lease);
      record.remove();
      if (generation === record) generation = null;
    };
    child.on("exit", end);
    child.on("error", end);
    if (child.stdout) watchReadyLine(child.stdout, () => io.client.markReady(lease));
    generation = record;
    return record;
  }

  return {
    owned: () => !!generation || transition,
    inTransition: () => transition,
    current: () => generation?.child ?? null,
    /** The current generation's lease, or null. */
    lease: () => generation?.lease ?? null,
    /**
     * The current generation, as a check: true while its lease is ready. Every end of a generation revokes
     * its lease (exit, error, replace, stop, a lost socket), and a revoked lease is never ready again
     * (backend-client.mjs), so it is false from then on and a successor never counts for it. A caller that
     * commits a reply after a later await (the reply's own read is covered by backendFetch) asks it right
     * before the commit.
     */
    held() {
      const lease = generation?.lease ?? null;
      return () => lease !== null && lease.ready;
    },
    /** Resolves once the current generation is ready; rejects if it ends first or there is none. */
    whenReady: () => (generation ? io.client.whenReady(generation.lease) : Promise.reject(new Error("no backend server was started"))),
    /** Start the first child (no predecessor). */
    start(dirs) {
      return adopt(io.spawnChild(dirs)).child;
    },
    /** Stop the owned child (awaiting real exit) and start one with `dirs`. */
    async replace(dirs) {
      transition = true;
      const old = generation;
      if (old) io.client.revoke(old.lease); // at the start: nothing more reaches the outgoing server
      io.onInvalidate(); // trust state belongs to the outgoing server
      try {
        if (old) {
          generation = null; // we own the transition; old's exit hook is now a no-op for the successor
          await new Promise((done) => {
            const t = setTimeout(() => { try { old.child.kill("SIGKILL"); } catch { /* gone */ } }, io.forceKillMs ?? 3000);
            old.child.once("exit", () => { clearTimeout(t); done(); });
            try { old.child.kill(); } catch { clearTimeout(t); done(); }
          });
          old.remove();
        }
        adopt(io.spawnChild(dirs));
      } finally {
        transition = false;
      }
    },
    /** Shutdown: revoke the lease and kill the owned child if any; its socket directory goes with it. */
    stop() {
      const g = generation;
      generation = null;
      if (g) {
        io.client.revoke(g.lease);
        try { g.child.kill(); } catch { /* best-effort */ }
        g.remove();
      }
      return g?.child ?? null;
    },
  };
}
