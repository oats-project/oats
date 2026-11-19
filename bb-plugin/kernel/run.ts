// Runs one `oats` process: an argv array, never a shell, in its own process group, with a time limit
// and an abort signal. bb reaps no child of a plugin on reload or stop (evidence B1), so every live
// child is kept in a `Processes` set, and its whole group is killed on abort, on timeout and by
// `killAll()`. POSIX only (process groups), like OATS's own session backends.
import { spawn, type ChildProcess } from "node:child_process";

export type RunOptions = {
  bin: string;
  argv: readonly string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
};

export type RunOutcome =
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
  | { kind: "spawn-error"; code: string | null; message: string }
  | { kind: "timeout"; timeoutMs: number }
  | { kind: "aborted" }
  | { kind: "overflow"; limit: number };

/** stdout past this is not read: a host RPC answer is capped at 8 MiB anyway. */
export const STDOUT_LIMIT = 16 * 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;
/** How long a signalled `oats` gets to finish (a spawn rolls its home back on SIGTERM) before SIGKILL. */
export const KILL_GRACE_MS = 2_000;
/** How long `killAll` waits: bb gives a host entry's dispose hook five seconds. */
export const DISPOSE_GRACE_MS = 1_500;

type GroupSignal = "sent" | "gone" | "denied";

/** Signals the process group `pid` leads. A group with no member left is "gone". */
function signalGroup(pid: number, signal: NodeJS.Signals): GroupSignal {
  try {
    process.kill(-pid, signal);
    return "sent";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    if (code === "EPERM") return "denied";
    throw error;
  }
}

type Live = { child: ChildProcess; pid: number; stop(reason: "timeout" | "aborted" | "disposed"): void; exited: Promise<void> };

export class Processes {
  readonly #live = new Set<Live>();

  /** The number of `oats` processes still running. */
  get size(): number {
    return this.#live.size;
  }

  run(options: RunOptions): Promise<RunOutcome> {
    const { bin, argv, cwd, timeoutMs, signal, env } = options;
    if (signal?.aborted) return Promise.resolve({ kind: "aborted" });
    return new Promise<RunOutcome>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(bin, [...argv], {
          cwd,
          env: env ?? process.env,
          detached: true, // its own process group: the group is what gets killed
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        resolve({ kind: "spawn-error", code: (error as NodeJS.ErrnoException).code ?? null, message: String((error as Error).message) });
        return;
      }
      const pid = child.pid;
      let settled = false;
      let stopped: "timeout" | "aborted" | "disposed" | "overflow" | null = null;
      let killTimer: NodeJS.Timeout | null = null;
      const out: Buffer[] = [];
      let outBytes = 0;
      let errText = "";
      let markExited: () => void = () => {};
      const exited = new Promise<void>((done) => (markExited = done));

      const finish = (outcome: RunOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const stop = (reason: "timeout" | "aborted" | "disposed" | "overflow") => {
        if (stopped !== null || pid === undefined) return;
        stopped = reason;
        // Overflow is ours to end at once; everything else lets `oats` finish what it holds.
        if (reason === "overflow") {
          signalGroup(pid, "SIGKILL");
          return;
        }
        if (signalGroup(pid, "SIGTERM") !== "sent") return;
        killTimer = setTimeout(() => signalGroup(pid, "SIGKILL"), KILL_GRACE_MS);
        killTimer.unref();
      };
      const onAbort = () => stop("aborted");
      const timer = setTimeout(() => stop("timeout"), timeoutMs);
      timer.unref();
      signal?.addEventListener("abort", onAbort, { once: true });

      const live: Live | null = pid === undefined ? null : { child, pid, stop: (reason) => stop(reason), exited };
      if (live) this.#live.add(live);

      child.stdout?.on("data", (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes > STDOUT_LIMIT) {
          stop("overflow");
          return;
        }
        out.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (errText.length < STDERR_LIMIT) errText += chunk.toString("utf8");
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        // Not started (ENOENT, EACCES), or a signal that could not be delivered.
        if (live) this.#live.delete(live);
        markExited();
        finish({ kind: "spawn-error", code: error.code ?? null, message: error.message });
      });
      child.once("exit", (code, exitSignal) => {
        if (live) this.#live.delete(live);
        if (killTimer) clearTimeout(killTimer);
        // A killed `oats` may leave a child of its own behind in the group: end the group now, while
        // its id cannot have been given to anyone else. A child that exited by itself is left alone:
        // what it started on purpose (a session, a deferred completion) is the kernel's to keep.
        if (stopped !== null && pid !== undefined) signalGroup(pid, "SIGKILL");
        markExited();
        const done = () => {
          if (stopped === "timeout") finish({ kind: "timeout", timeoutMs });
          else if (stopped === "aborted" || stopped === "disposed") finish({ kind: "aborted" });
          else if (stopped === "overflow") finish({ kind: "overflow", limit: STDOUT_LIMIT });
          else finish({ kind: "exit", code, signal: exitSignal, stdout: Buffer.concat(out).toString("utf8"), stderr: errText });
        };
        // The pipes close with the last process that holds them; one that left the group must not
        // keep the answer waiting.
        const drain = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          done();
        }, 250);
        drain.unref();
        child.once("close", () => {
          clearTimeout(drain);
          done();
        });
      });
    });
  }

  /**
   * Ends every `oats` still running, with its process group: SIGTERM, then SIGKILL for a group that
   * is still there after the grace. Resolves when all of them have exited or been killed.
   */
  async killAll(graceMs: number = DISPOSE_GRACE_MS): Promise<void> {
    const targets = [...this.#live];
    if (targets.length === 0) return;
    for (const target of targets) target.stop("disposed");
    let timer: NodeJS.Timeout | undefined;
    const grace = new Promise<void>((done) => {
      timer = setTimeout(done, graceMs);
    });
    await Promise.race([Promise.all(targets.map((target) => target.exited)), grace]);
    clearTimeout(timer);
    for (const target of targets) {
      // Still running after the grace: its group is still ours, so this cannot reach a stranger.
      if (this.#live.has(target)) signalGroup(target.pid, "SIGKILL");
    }
    // SIGKILL cannot be refused by the process; the bound is for a group this user may not signal.
    let last: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(targets.map((target) => target.exited)),
      new Promise<void>((done) => {
        last = setTimeout(done, 1_000);
      }),
    ]);
    clearTimeout(last);
  }
}
