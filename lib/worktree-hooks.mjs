/** The `worktree` lifecycle event's runner (#796), and the process facts its
 *  recovery reads. Dependency-free; the caller (lib/core.mjs for a spawn,
 *  lib/worktree.mjs for `oats worktree add`) builds each hook's environment.
 *
 *  Only this event runs this way. Every other hook keeps `runLifecycleHooks`
 *  (execSync, buffered, 120 s, cwd the home). A `worktree` hook installs
 *  dependencies, so it may run for minutes and print a lot:
 *    - its cwd is the new tree; stdin is /dev/null; it has no terminal;
 *    - it is spawned detached (its own session and process group), so a
 *      timeout or an interrupt ends the whole group (terminateGroup);
 *    - stdout and stderr go to `<home>/.oats/logs/worktree-<p|work>-<cap>.log`
 *      (0600, truncated per run) and, when asked (`oats worktree add`), to the
 *      kernel's stderr — never its stdout, which holds only the envelope;
 *    - the result is the exit status; of the last stdout line's JSON only
 *      `warning` is read, and `env` is a contract error (as at retire).
 *  The timeout is fixed (WORKTREE_HOOK_TIMEOUT_MS). OATS_TEST_WORKTREE_HOOK_TIMEOUT_MS
 *  is a test seam, not a setting. */
import { spawn as spawnProcess, execFileSync } from "node:child_process";
import { closeSync, fchmodSync, mkdirSync, openSync, realpathSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { terminateGroup, watchGroup, TERM_GRACE_MS } from "./process-group.mjs";
import { processLiveness, processStart, processStartToken } from "../packages/record/lib/process-identity.mjs";

export { PS_ENV, isStartToken, processLiveness, processStart, processStartToken, runPs } from "../packages/record/lib/process-identity.mjs";

export const WORKTREE_HOOK_TIMEOUT_MS = 30 * 60 * 1000;
/** The fixed timeout, or the test seam's value (a positive integer of milliseconds). */
export function worktreeHookTimeoutMs(env = process.env) {
  const seam = Number(env.OATS_TEST_WORKTREE_HOOK_TIMEOUT_MS);
  return Number.isSafeInteger(seam) && seam > 0 ? seam : WORKTREE_HOOK_TIMEOUT_MS;
}

/** The signals an interrupted parent receives (condition A); SIGKILL cannot be caught. */
export const INTERRUPT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const SIGNAL_NUMBERS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
/** The exit status of a process ended by `signal`: 128 + its number. */
export const interruptExitStatus = (signal) => 128 + (SIGNAL_NUMBERS[signal] ?? 15);

/** This process, as a record names it: { pid, processStart } (null when its start cannot be read;
 *  the callers that need it refuse then). */
export function selfIdentity() {
  return { pid: process.pid, processStart: processStartToken(process.pid) };
}

/** Whether a record's process is verifiably the one still running (processLiveness "alive"). */
export const verifiedAlive = (record) => processLiveness(record).state === "alive";

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const groupHasMembers = (pgid) => { try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

/** End a hook process group a killed parent left behind (`{ hookPgid, hookStart }`
 *  from its record), synchronously: SIGTERM, then SIGKILL after `graceMs`.
 *  The group is signalled only when its leader (pid = pgid) is alive with the
 *  recorded start token: that alone proves the pgid is still this run's. A
 *  group whose leader is gone is never signalled, members or not — the record
 *  may have outlived the group and its id been reused by an unrelated one
 *  (lessons/observation-must-not-harm-the-observer.md: verified pids only).
 *  A group with members whose leader's start cannot be read is not signalled either, and is
 *  "unknown", never "unverified": its leader may be this run's and still running, so callers keep
 *  what they hold and refuse (unknownGroupNote) instead of warning and going on. An empty group is
 *  "none", whatever its leader reads as: the kernel answers that, not procfs or ps.
 *  → "none" (nothing to end) | "terminated" | "killed" | "survived"
 *    | "foreign" (the leader is someone else) | "unverified" (leader gone, members left: not signalled)
 *    | "unknown" (members left, the leader's start unreadable: not signalled). */
export function terminateRecordedGroup(rec, graceMs = TERM_GRACE_MS) {
  const pgid = rec?.hookPgid;
  if (!Number.isSafeInteger(pgid) || pgid <= 1 || !groupHasMembers(pgid)) return "none";
  const leader = processStart(pgid);
  if (leader.state === "unknown") return "unknown";
  if (leader.state === "gone") return groupHasMembers(pgid) ? "unverified" : "none";
  if (leader.token !== rec.hookStart) return "foreign";
  return endGroupSync(pgid, graceMs);
}

/** The warning a recovery reports for an "unverified" group (terminateRecordedGroup): a hook's, or a git step's. */
export const unverifiedGroupWarning = (pgid, what = "hook") =>
  `${what} process group ${pgid} was not signalled: its leader exited, so the group cannot be proven to be this run's; end any leftover processes yourself`;

/** What a refusal says of an "unknown" group (terminateRecordedGroup): its id, the recorded start
 *  of its leader and why that start cannot be read now. The caller adds what it kept and the way out.
 *  The recorded start is printed only when it is a token of the kernel's (isStartToken), else as
 *  `none`: `rec` is read from a file (a claim, a tree record, a spawn's marker). The id is an
 *  integer whenever a group is "unknown". */
export function unknownGroupNote(rec, what = "hook") {
  const s = processStart(rec.hookPgid);
  const reason = s.state === "unknown" ? s.reason : "its leader's start time could not be read";
  return `${what} process group ${rec.hookPgid} (leader pid ${rec.hookPgid}, recorded start ${isStartToken(rec.hookStart) ? rec.hookStart : "none"}) still has members, and its leader's start cannot be read (${reason}), so whether it is still that ${what} cannot be told and it was not signalled`;
}

/** End the group of a hook this process is running, synchronously, once its leader has
 *  closed after a timeout or an interrupt (runOne). The group was this process's when
 *  it was signalled with the leader alive, and is probed without a gap from then on:
 *  no pid is allocated while it is a live group's id, so a group seen non-empty is
 *  still ours (process-group.mjs, terminateGroup, the same rule). Never for a group
 *  read back from a record: that is terminateRecordedGroup. */
export function endOwnGroupSync(pgid, graceMs = TERM_GRACE_MS) {
  if (!Number.isSafeInteger(pgid) || pgid <= 1 || !groupHasMembers(pgid)) return "none";
  return endGroupSync(pgid, graceMs);
}

function endGroupSync(pgid, graceMs) {
  try { process.kill(-pgid, "SIGTERM"); } catch { /* gone in between */ }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!groupHasMembers(pgid)) return "terminated";
    sleepSync(50);
  }
  try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ }
  for (let i = 0; i < 20 && groupHasMembers(pgid); i++) sleepSync(50);
  return groupHasMembers(pgid) ? "survived" : "killed";
}

// ---------- the remote URL a hook and the records see ----------

/** `origin`'s URL without credentials (amendment A2). URL-style
 *  (`scheme://userinfo@host/...`): the whole userinfo goes. scp-style
 *  (`user@host:path`): the `user@` goes. A local path is kept as it is. The
 *  result names the repository and carries no secret; it is the only form the
 *  kernel ever records, prints, logs or hands a hook. */
export function scrubRemoteUrl(url) {
  const s = String(url ?? "").trim();
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/s.exec(s);
  if (scheme) {
    const [, prefix, authority, rest] = scheme;
    const at = authority.lastIndexOf("@");
    return `${prefix}${at >= 0 ? authority.slice(at + 1) : authority}${rest}`;
  }
  // scp-style: [user@]host:path, where the part before the first ':' has no '/'.
  const colon = s.indexOf(":");
  const slash = s.indexOf("/");
  if (colon > 0 && (slash < 0 || colon < slash)) {
    const hostPart = s.slice(0, colon);
    const at = hostPart.lastIndexOf("@");
    return at >= 0 ? `${hostPart.slice(at + 1)}${s.slice(colon)}` : s;
  }
  return s;
}

// ---------- interrupts ----------

/** Hold SIGINT, SIGTERM and SIGHUP while `worktree` hooks and their rollback
 *  run: the first one is recorded (`signal`) and `onSignal` callbacks run; the
 *  process is not ended by it. `restore()` removes the handlers, giving the
 *  previous behaviour back. */
export function signalGuard() {
  const listeners = new Set();
  const guard = {
    signal: null,
    onSignal(cb) { listeners.add(cb); if (guard.signal) cb(guard.signal); return () => listeners.delete(cb); },
    restore() { for (const [sig, fn] of handlers) process.removeListener(sig, fn); handlers.length = 0; },
  };
  const handlers = INTERRUPT_SIGNALS.map((sig) => [sig, () => {
    if (!guard.signal) guard.signal = sig;
    for (const cb of [...listeners]) { try { cb(sig); } catch { /* a callback never ends the guard */ } }
  }]);
  for (const [sig, fn] of handlers) process.on(sig, fn);
  return guard;
}

// ---------- the runner ----------

/** How long a hook's output is drained after the hook exits, when something it started holds the pipes. */
const OUTPUT_DRAIN_MS = 2_000;
const LOG_NAME_UNSAFE = /[^A-Za-z0-9._-]+/g;
/** `<home>/.oats/logs/worktree-<purpose|work>-<cap>.log`. */
export function worktreeHookLogPath(home, purpose, capability) {
  return join(home, ".oats", "logs", `worktree-${purpose || "work"}-${String(capability).replace(LOG_NAME_UNSAFE, "-")}.log`);
}

/** The capabilities whose `worktree` hook fires, in capability-name order:
 *  [{ id, command, required }]. `caps` are capability rows (hooks rendered as
 *  shell strings, requiredHooks listing "worktree" when declared required). */
export function worktreeHooksOf(caps) {
  return (caps || [])
    .filter((cap) => typeof cap?.hooks?.worktree === "string" && cap.hooks.worktree.trim())
    .map((cap) => ({ id: cap.id, command: cap.hooks.worktree, required: (cap.requiredHooks || []).includes("worktree"), cap }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Run each hook in `hooks` (worktreeHooksOf) in order, one at a time.
 *  - `envFor(cap)`: the hook's whole environment;
 *  - `cwd`: the new tree; `home`/`purpose`: where the logs go;
 *  - `stream`: also copy the hook's output to process.stderr. A caller that closes its end
 *    (EPIPE: a tool shell killed, Desktop gone) stops the copy for the rest of the run, and only
 *    the copy: the hooks run on, their logs stay whole, and the run ends as it would have;
 *  - `guard`: a signalGuard; a signal ends the running hook's group and stops
 *    the run (`interrupted`);
 *  - `onStart({ capability, pgid, hookStart })`: called once each hook's group
 *    exists, before it can do anything long, so a caller records it for a
 *    recovery after SIGKILL.
 *  → { receipt: [{ capability, ok, required, log, exitCode?, signal?, timedOut?, contract? }],
 *      failures: [{ capability, event, message, required, contract? }], warnings: [], interrupted: signal|null } */
export async function runWorktreeHooks(hooks, { envFor, cwd, home, purpose, stream = false, guard, onStart, timeoutMs = worktreeHookTimeoutMs() }) {
  const out = { receipt: [], failures: [], warnings: [], interrupted: null };
  // A write to a closed pipe is an "error" event on process.stderr, fatal while nobody listens for it.
  const sink = { open: stream };
  const closed = (e) => {
    if (!sink.open) return;
    sink.open = false;
    out.warnings.push(`the caller's stderr closed while the worktree hooks ran (${e?.code || e?.message}); the rest of their output is in their logs only`);
  };
  if (stream) process.stderr.on("error", closed);
  try {
    for (const hook of hooks) {
      if (guard?.signal) { out.interrupted = guard.signal; break; }
      const log = worktreeHookLogPath(home, purpose, hook.id);
      const one = await runOne(hook, { env: envFor(hook.cap), cwd, log, sink, closed, guard, onStart, timeoutMs });
      out.receipt.push({ capability: hook.id, ok: one.ok, required: hook.required, log, ...one.facts });
      out.warnings.push(...one.warnings);
      if (!one.ok) {
        // An env answer is a contract error, which fails closed like a required hook (spawn's rule).
        out.failures.push({ capability: hook.id, event: "worktree", message: one.message, required: hook.required || one.facts.contract === "environment", ...(one.facts.contract ? { contract: one.facts.contract } : {}) });
      }
      if (one.facts.signal && guard?.signal) { out.interrupted = guard.signal; break; }
    }
    if (!out.interrupted && guard?.signal) out.interrupted = guard.signal;
    return out;
  } finally {
    if (stream) process.stderr.off("error", closed);
  }
}

function runOne(hook, { env, cwd, log, sink, closed, guard, onStart, timeoutMs }) {
  return new Promise((resolve) => {
    const warnings = [];
    let fd = null, logBroken = false;
    try {
      mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
      fd = openSync(log, "w", 0o600);
      fchmodSync(fd, 0o600); // a log left by an earlier run keeps its old mode otherwise
    } catch (e) { logBroken = true; warnings.push(`${hook.id} worktree hook: its log ${log} could not be opened (${e.code || e.message}); the hook ran without it`); }
    const toLog = (chunk) => {
      if (fd === null || logBroken) return;
      try { writeSync(fd, chunk); }
      catch (e) { logBroken = true; warnings.push(`${hook.id} worktree hook: writing its log ${log} failed (${e.code || e.message}); the hook kept running, the rest of its output is not in the log`); }
    };
    let stdoutTail = "";
    let child;
    try {
      child = spawnProcess(hook.command, { cwd, env, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      if (fd !== null) closeSync(fd);
      resolve({ ok: false, message: `could not start: ${e.message}`, facts: {}, warnings });
      return;
    }
    watchGroup(child);
    let timedOut = false, signalled = null, settled = false, drain = null;
    const end = () => terminateGroup(child);
    const timer = setTimeout(() => { timedOut = true; end(); }, timeoutMs);
    const unwatch = guard ? guard.onSignal((sig) => { signalled = sig; end(); }) : () => {};
    const hookStart = child.pid ? processStartToken(child.pid) : null;
    if (child.pid) onStart?.({ capability: hook.id, pgid: child.pid, hookStart });
    const toCaller = (chunk) => {
      if (!sink.open) return;
      if (process.stderr.destroyed || process.stderr.writableEnded) return closed({ code: "ERR_STREAM_DESTROYED" });
      try { process.stderr.write(chunk); } catch (e) { closed(e); }
    };
    child.stdout.on("data", (chunk) => {
      toLog(chunk);
      toCaller(chunk);
      stdoutTail = (stdoutTail + chunk.toString("utf8")).slice(-65536);
    });
    child.stderr.on("data", (chunk) => { toLog(chunk); toCaller(chunk); });
    const finish = (code, signal, spawnError) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(drain); unwatch();
      // An ended hook's group is ended for certain before the answer: terminateGroup's SIGKILL is a timer the
      // process may exit before, and a member that ignores SIGTERM would outlive it.
      if ((timedOut || signalled) && child.pid) endOwnGroupSync(child.pid);
      if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } }
      const facts = { exitCode: code ?? null, ...(signal ? { signal } : {}), ...(timedOut ? { timedOut: true } : {}) };
      if (signalled) facts.signal = signalled;
      let answer = {};
      const last = stdoutTail.split("\n").map((l) => l.trim()).filter(Boolean).pop();
      if (last) { try { const o = JSON.parse(last); if (o && typeof o === "object" && !Array.isArray(o)) answer = o; } catch { /* non-JSON output is fine */ } }
      if (typeof answer.warning === "string" && answer.warning.trim()) warnings.push(`${hook.id} worktree hook: ${answer.warning.trim()}`);
      if (spawnError) return resolve({ ok: false, message: `could not start: ${spawnError.message}`, facts, warnings });
      if (signalled) return resolve({ ok: false, message: `interrupted by ${signalled}; its process group was ended`, facts, warnings });
      if (timedOut) return resolve({ ok: false, message: `timed out after ${Math.round(timeoutMs / 1000)} s; its process group was ended`, facts, warnings });
      if (code !== 0) return resolve({ ok: false, message: `${typeof answer.warning === "string" && answer.warning.trim() ? `${answer.warning.trim()} — ` : ""}exited ${code ?? signal}`, facts, warnings });
      if (answer.env !== undefined) return resolve({ ok: false, message: `returned env, which a worktree hook may not (only spawn and launch hooks hand environment back)`, facts: { ...facts, contract: "environment" }, warnings });
      resolve({ ok: true, facts, warnings });
    };
    child.on("error", (e) => finish(null, null, e));
    child.on("close", (code, signal) => finish(code, signal));
    // A process the hook left running (in its group or escaped from it) may hold the output pipes open, and
    // 'close' would then never come: once the hook itself has exited, its output is drained for a moment and
    // the pipes are let go. The leftover process is not the kernel's to end; the warning names it.
    child.on("exit", (code, signal) => {
      drain = setTimeout(() => {
        if (settled) return;
        warnings.push(`${hook.id} worktree hook: it exited, but a process it started still holds its output; that process was left running`);
        child.stdout.destroy(); child.stderr.destroy();
        finish(code, signal);
      }, OUTPUT_DRAIN_MS);
    });
  });
}

// ---------- git facts about a tree and its clone ----------

const gitOut = (argv) => { try { return execFileSync("git", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 }).trim(); } catch { return null; } };

/** The clone's `origin` URL, scrubbed (scrubRemoteUrl); "" when it has no `origin`. */
export function originRemoteOf(clone) {
  const url = gitOut(["-C", clone, "remote", "get-url", "--end-of-options", "origin"]);
  return url ? scrubRemoteUrl(url) : "";
}

/** Whether `tree` (canonical) is still a directory whose Git toplevel is itself:
 *  the check after the hooks, which may remove or move it. */
export function treeStillThere(tree) {
  const top = gitOut(["-C", tree, "rev-parse", "--path-format=absolute", "--show-toplevel"]);
  if (!top) return false;
  try { return realpathSync(top) === tree; } catch { return false; }
}
