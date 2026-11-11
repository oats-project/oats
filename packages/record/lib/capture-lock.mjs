// One capture pass per record root at a time. Hook-triggered passes (one per
// agent event, across every live agent) used to overlap, each opening the
// multi-gigabyte search index; a second pass finding the lock exits at once
// and the next pass catches up, since reconciliation is idempotent.
//
// The lock is a DIRECTORY: mkdir is atomic and a directory is never
// observable half-created. The owner record (pid, nonce, start time, host,
// and the boot and process start its holder is judged by)
// is written inside it after the mkdir. A live, unknowable or still
// initializing (owner-less) lock refuses the pass and names the holder and
// the operator recovery; it is never stolen.
//
// A lock whose recorded owner AND registered worker are DEAD is reclaimed (a capture
// killed mid-pass by a hook or caller timeout runs no finally). A record that
// names its holder's boot or start (`bootId`, `processStart`) is judged by them
// (lock-holder.mjs holderLiveness), whatever host it names: a container that is created again
// has another hostname, its pids start low again, and a lock on a volume
// outlives it. A record that names neither is dead only on this host, by its
// pid alone. Records
// without host predate host recording and live under this user's home, so
// they count as this host's (RECLAIM_HOSTLESS_RECORDS). Reclaimers
// are serialized by a guard, `<lock>.reclaim` (exclusive create): under it
// the owner record is read again and the lock removed only while it is still
// that dead owner's, so a reclaimer cannot remove a lock a live pass took
// meanwhile. A guard whose holder died is never removed (that would race
// exactly as removing the lock does); it is named with its recovery.
// Acquire never waits: it reclaims once or skips, and the next pass catches up.
// A supervisor publishes its idle child's identity before permitting work.
// The worker is part of the same lock, not a second independently reclaimed
// lock. A child that runs, or whose liveness cannot be read, prevents release
// and reclamation even when the supervisor died. Callers own child termination/reaping; this module
// never sends a terminating signal or infers a process group.
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { makePrivateDir } from "./private-files.mjs";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { holderIdentity, holderLiveness, namesIdentity, validPid } from "./lock-holder.mjs";

/** Whether an owner record that names no host is reclaimed when its pid is dead here: yes. Records without
 *  host predate host recording and live under this user's home, so they are this host's. */
export const RECLAIM_HOSTLESS_RECORDS = true;

export function captureLockPath(root) { return join(root, ".capture.lock"); }

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const readJson = (path) => {
  let fd;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > 4096n) return undefined;
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const opened = fstatSync(fd, { bigint: true });
    if (!sameFile(before, opened)) return undefined;
    const bytes = Buffer.alloc(Number(opened.size)); let offset = 0;
    while (offset < bytes.length) { const n = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) return undefined; offset += n; }
    if (!sameFile(opened, fstatSync(fd, { bigint: true })) || !sameFile(opened, lstatSync(path, { bigint: true }))) return undefined;
    return JSON.parse(bytes.toString("utf8"));
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
};
const readOwner = (dir) => {
  try { const st = lstatSync(dir); return st.isDirectory() && !st.isSymbolicLink() ? readJson(join(dir, "owner.json")) : undefined; }
  catch { return undefined; }
};
export const readCaptureLockOwner = root => readOwner(captureLockPath(root));

// Diagnostic attribution in a fresh owner record: which command took the
// lock, from which entry and trigger, and the immediate parent process. Fixed
// labels and direct process facts only, never argv, environment or a guessed
// external caller; an entry that is not known is left out. It never confers authority: identity, liveness and reclaim
// read only pid, nonce, startedAt, host, bootId, processStart and worker.
const COMMANDS = new Set(["pass", "home", "file", "reset-cursors", "retry"]);
const ENTRIES = new Set(["oats", "turn-record", "hook-runner", "service-runner"]);
const TRIGGERS = new Set(["manual", "watch", "hook", "setup", "service"]);
export function captureLockAttribution({ command, caller, ppid = process.ppid } = {}) {
  if (command === undefined && caller === undefined) return {};
  if (!COMMANDS.has(command) || caller?.entry !== undefined && !ENTRIES.has(caller.entry) || !TRIGGERS.has(caller?.trigger) ||
      Object.keys(caller).some(key => key !== "entry" && key !== "trigger")) throw new Error("invalid capture lock attribution");
  return { command, caller: { ...(caller.entry !== undefined ? { entry: caller.entry } : {}), trigger: caller.trigger },
    ...(validPid(ppid) ? { ppid } : {}) };
}

function workerDead(owner, { host, liveness }) {
  if (!Object.hasOwn(owner, "worker")) return true;
  const worker = owner.worker;
  return validPid(worker?.pid) && worker.pid !== owner.pid && (namesIdentity(worker) || worker.host === host) && typeof worker.nonce === "string" &&
    worker.nonce.length > 0 && worker.nonce.length <= 128 && typeof worker.startedAt === "string" &&
    Number.isFinite(Date.parse(worker.startedAt)) && liveness(worker) === "dead";
}

/** Whether `owner` is a record whose process is dead, and its worker's: the only lock this module reclaims.
 *  A record that names its boot or start is judged wherever it was written; one that names neither only
 *  when it is this host's. */
function deadHere(owner, { host, liveness, reclaimHostless }) {
  if (!owner || !validPid(owner.pid)) return false;
  const here = namesIdentity(owner) || (owner.host === undefined ? reclaimHostless : owner.host === host);
  return here && liveness(owner) === "dead" && workerDead(owner, { host, liveness });
}

/** Remove the lock `dir` held by the dead `owner`, serialized by the guard `<dir>.reclaim`. → { removed }
 *  (true only when THIS call removed it; otherwise it is left for the next pass), or { abandoned: { guard,
 *  pid } } when a reclaimer died holding the guard. */
function reclaimDeadLock(dir, owner, me, opts) {
  const guard = `${dir}.reclaim`;
  try { writeFileSync(guard, JSON.stringify(me), { flag: "wx", mode: 0o600 }); }
  catch (e) {
    if (e.code !== "EEXIST") return { removed: false };
    const g = readJson(guard);
    return g && deadHere(g, opts) ? { abandoned: { guard, pid: g.pid } } : { removed: false };
  }
  const same = (o) => o && o.pid === owner.pid && o.nonce === owner.nonce && o.startedAt === owner.startedAt && JSON.stringify(o.worker) === JSON.stringify(owner.worker);
  let removed = false;
  try {
    const now = readOwner(dir);
    if (same(now) && deadHere(now, opts)) {
      rmSync(dir, { recursive: true, force: true });
      removed = !existsSync(dir) || !same(readOwner(dir));
    }
  } catch { /* the next pass */ }
  finally { if (readJson(guard)?.nonce === me.nonce) { try { unlinkSync(guard); } catch { /* gone */ } } }
  return { removed };
}

/** Single-quote shell escaping: safe to paste whatever the path contains. */
export function shellQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

/** The operator's recovery line for a lock that is not ours. */
export function recoveryInstruction(dir, owner, liveness) {
  const remove = `rm -r -- ${shellQuote(dir)}`;
  if (owner && Object.hasOwn(owner, "worker")) return `${dir} records supervisor pid ${owner.pid} (${liveness}) and worker pid ${owner.worker?.pid ?? "unknown"}; wait for both to finish. If interrupted, stop capture triggers and verify BOTH processes are gone before removing the lock with: ${remove}  and rerun`;
  if (!owner?.pid) return `${dir} is held by a pass that has not written its owner record yet (initializing, or killed before it could); stop capture triggers (hooks, launchd), verify no capture process is running (pgrep -f capture.mjs), then remove the lock with: ${remove}  and rerun`;
  const who = `pid ${owner.pid} (started ${owner.startedAt || "?"}, now ${liveness})`;
  if (liveness === "alive") return `${dir} is held by ${who}; let it finish, the next pass catches up`;
  return `${dir} is held by ${who}; if that process is gone (ps -p ${owner.pid}), remove the lock with: ${remove}  and rerun`;
}

/** Try to take the root's capture lock. Returns { path, release, reclaimed? }
 *  when taken, or { path, held: { pid, startedAt, liveness, recovery, guard? },
 *  reclaimed? } when a lock is held. A lock it did not create is removed only
 *  when its recorded owner and worker are dead, under the reclaim guard (the
 *  header); `reclaimed: { pid, startedAt }` says THIS call removed it (whether
 *  or not it then won the lock), and `held.guard` names a guard a dead
 *  reclaimer left. Every other lock is left alone.
 *
 *  Two failure points are reported rather than left behind. If the owner
 *  record cannot be written after THIS call created the directory (a full
 *  disk, say), the directory is removed only while it is still the very
 *  directory this call created (same inode) and carries no other owner's
 *  record; a replacement that appeared meanwhile (operator recovery, then a
 *  newer pass) is left alone. The original error is rethrown with
 *  `lockCleanup: { path, removed, reason?, owner?, error?, recovery? }`
 *  saying what happened. And `release()` never throws: it answers
 *  `{ released: true }` only when the lock is verifiably gone, otherwise
 *  `{ released: false, reason: "gone" | "unknown-owner" | "not-owner" |
 *  "remove-failed" | "worker-active", ... }` with the actual observation, never a guess.
 *
 *  The owner record carries a per-acquisition nonce, so a release kept from
 *  an earlier acquisition cannot erase a later one by the same pid (an
 *  operator recovery followed by a new pass in the same long-lived process).
 *
 *  `io` exists for fault injection in tests only. */
export function acquireCaptureLock(root, { now = Date.now, pid = process.pid, liveness = holderLiveness, host = hostname(), reclaimHostless = RECLAIM_HOSTLESS_RECORDS, io = {}, command, caller } = {}) {
  if (!validPid(pid)) throw new Error("capture lock owner must have a positive process ID");
  const attribution = captureLockAttribution({ command, caller });
  const fs = { writeFileSync, rmSync, openSync, closeSync, lstatSync, fsyncSync, renameSync, ...io };
  const dir = captureLockPath(root);
  const nonce = randomBytes(8).toString("hex");
  makePrivateDir(root); // the store creates the root lazily; the lock may come first
  let reclaimed;
  for (let attempt = 0; ; attempt++) {
    try { mkdirSync(dir, { mode: 0o700 }); break; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      const owner = readOwner(dir);
      const opts = { host, liveness, reclaimHostless };
      // A record with this pass's own pid that names another boot or start is another process's.
      if (attempt === 0 && (owner?.pid !== pid || namesIdentity(owner)) && deadHere(owner, opts)) {
        const r = reclaimDeadLock(dir, owner, { pid, nonce, host, ...holderIdentity(pid) }, opts);
        if (r.abandoned) {
          const { guard, pid: reclaimer } = r.abandoned;
          return { path: dir, held: { pid: owner.pid, startedAt: owner.startedAt, liveness: "dead", guard,
            recovery: `${guard} was left by pid ${reclaimer}, which died while reclaiming ${dir}; once no capture process is running (pgrep -f capture.mjs), remove both with: rm -- ${shellQuote(guard)}; rm -r -- ${shellQuote(dir)}  and rerun` } };
        }
        // Gone, whoever removed it (another reclaimer may have): try the lock once more.
        if (r.removed) reclaimed = { pid: owner.pid, startedAt: owner.startedAt };
        if (r.removed || !existsSync(dir)) continue;
      }
      const now = readOwner(dir);
      // Gone between the mkdir and this read (a release or a reclaim): try once more. A directory that
      // exists without a record is initializing or mid-removal, and is reported so.
      if (!now && attempt === 0 && !existsSync(dir)) continue;
      const live = now ? (now.pid === pid && !namesIdentity(now) ? "alive" : liveness(now)) : "unknown";
      return { path: dir, ...(reclaimed ? { reclaimed } : {}), held: { pid: now?.pid, startedAt: now?.startedAt, liveness: live, recovery: recoveryInstruction(dir, now, live) } };
    }
  }
  let directoryFd, identity;
  try {
    // Keep the directory alive until initialization or its cleanup finishes.
    // Otherwise Linux can reuse its inode immediately after an unlink, making
    // a record-less replacement look like the directory we created.
    directoryFd = fs.openSync(dir, "r");
    identity = fstatSync(directoryFd);
    fs.writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid, nonce, startedAt: new Date(now()).toISOString(), host, ...holderIdentity(pid), ...attribution }), { mode: 0o600 });
  } catch (err) {
    // Ownership was proven by the mkdir, not by the moment of cleanup: the
    // directory is removed only if it is still ours (same inode) and holds
    // no other pass's record. Anything else is reported, not deleted.
    let cleanupError, reason;
    const cur = readOwner(dir);
    const same = (() => { try { const current = lstatSync(dir); return identity && current.dev === identity.dev && current.ino === identity.ino; } catch { return false; } })();
    if (!existsSync(dir)) reason = "gone";
    else if (!identity) reason = "unverified";
    else if (!same || (cur && (cur.pid !== pid || cur.nonce !== nonce))) reason = "replaced";
    else { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e2) { cleanupError = e2; } }
    const removed = reason === undefined && !existsSync(dir);
    err.lockCleanup = {
      path: dir,
      removed,
      ...(reason ? { reason } : {}),
      ...(reason === "replaced" && cur ? { owner: cur } : {}),
      ...(cleanupError ? { error: cleanupError.message } : {}),
      ...(removed || reason === "gone" || reason === "replaced" ? {} : { recovery: recoveryInstruction(dir, undefined, "unknown") }),
    };
    throw err;
  } finally {
    if (directoryFd !== undefined) fs.closeSync(directoryFd);
  }
  const ownCurrent = message => {
    const current = readOwner(dir), st = fs.lstatSync(dir);
    if (st.dev !== identity.dev || st.ino !== identity.ino || current?.pid !== pid || current?.nonce !== nonce) throw new Error(message);
    return current;
  };
  // Durably replace this acquisition's owner record with `next`, only while it
  // is still exactly `current` in the directory this call created.
  const replaceOwner = (current, next, what, label) => {
    const temp = join(dir, `${label}-${nonce}.tmp`); let fd, dirFd, rootFd, temporary, published = false;
    try {
      dirFd = fs.openSync(dir, constants.O_RDONLY | constants.O_NOFOLLOW);
      const pinned = fstatSync(dirFd);
      if (pinned.dev !== identity.dev || pinned.ino !== identity.ino) throw new Error(`capture lock changed before ${what}`);
      fd = fs.openSync(temp, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify(next));
      fs.fsyncSync(fd); temporary = fstatSync(fd, { bigint: true });
      const again = readOwner(dir), named = fs.lstatSync(dir);
      if (named.dev !== identity.dev || named.ino !== identity.ino || JSON.stringify(again) !== JSON.stringify(current) || !sameFile(temporary, fs.lstatSync(temp, { bigint: true }))) throw new Error(`capture lock changed during ${what}`);
      fs.renameSync(temp, join(dir, "owner.json"));
      published = true;
      // Publish file bytes, their rename, and the lock directory's parent
      // entry before GO. A failure is not permission to start the worker.
      fs.fsyncSync(dirFd);
      rootFd = fs.openSync(root, "r"); fs.fsyncSync(rootFd);
    } finally {
      // Never remove a path another caller replaced, even after a failed
      // publication. An unpublished/unverifiable file is conservatively kept.
      if (!published && temporary) {
        try {
          const named = fs.lstatSync(dir);
          if (named.dev === identity.dev && named.ino === identity.ino && sameFile(temporary, fs.lstatSync(temp, { bigint: true }))) unlinkSync(temp);
        } catch { /* absent or unknown: preserve */ }
      }
      if (fd !== undefined) fs.closeSync(fd);
      if (rootFd !== undefined) fs.closeSync(rootFd);
      if (dirFd !== undefined) fs.closeSync(dirFd);
    }
  };
  return {
    path: dir,
    nonce,
    ...(reclaimed ? { reclaimed } : {}),
    // The child must remain idle until this durable publication succeeds.
    // A dead supervisor's lock cannot then be reclaimed while its worker lives.
    registerWorker(worker, { previous } = {}) {
      if (!validPid(worker?.pid) || worker.pid === pid || typeof worker.nonce !== "string" || !worker.nonce || worker.nonce.length > 128 || typeof worker.startedAt !== "string" || !Number.isFinite(Date.parse(worker.startedAt))) throw new Error("invalid capture worker identity");
      const current = ownCurrent("capture lock changed before worker registration");
      // Continuation never drops the root lock between children. Replace only
      // the caller's exact previous publication, after positive death proof;
      // a worker that runs, or of uncertain liveness, preserves the old lock unchanged.
      if (Object.hasOwn(current, "worker")) {
        if (!previous || current.worker?.pid !== previous.pid || current.worker?.nonce !== previous.nonce ||
            current.worker?.startedAt !== previous.startedAt || !workerDead(current, { host, liveness })) {
          throw new Error("previous capture worker is not proven dead and unchanged");
        }
      } else if (previous) throw new Error("capture lock changed before worker continuation");
      replaceOwner(current, { ...current, worker: { pid: worker.pid, nonce: worker.nonce, startedAt: worker.startedAt, host, ...holderIdentity(worker.pid) } }, "worker registration", "worker");
    },
    // A cooperative stop request for this acquisition's worker, which reads the
    // owner record between bounded units. It is not a lock release, changes no
    // identity field and confers nothing: reclaim and release ignore it.
    requestStop() {
      const current = ownCurrent("capture lock changed before stop request");
      if (current.stop === true) return;
      replaceOwner(current, { ...current, stop: true }, "stop request", "stop");
    },
    release: () => {
      if (!existsSync(dir)) return { released: false, reason: "gone" };
      const cur = readOwner(dir);
      if (!cur) return { released: false, reason: "unknown-owner", recovery: recoveryInstruction(dir, undefined, "unknown") };
      if (cur.pid !== pid || cur.nonce !== nonce) return { released: false, reason: "not-owner", owner: cur };
      try {
        const named = fs.lstatSync(dir);
        if (!named.isDirectory() || named.dev !== identity.dev || named.ino !== identity.ino) return { released: false, reason: "not-owner", owner: cur };
      } catch (err) {
        return { released: false, reason: "remove-failed", error: err.message,
          recovery: "could not verify capture lock identity before removal; inspect the filesystem error and rerun capture" };
      }
      if (!workerDead(cur, { host, liveness })) return { released: false, reason: "worker-active", recovery: recoveryInstruction(dir, cur, "alive") };
      let error;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { error = e; }
      let remains;
      try { fs.lstatSync(dir); remains = true; }
      catch (err) {
        if (err.code === "ENOENT") remains = false;
        else return { released: false, reason: "remove-failed", error: err.message,
          recovery: "could not verify capture lock removal; inspect the filesystem error and rerun capture" };
      }
      if (!remains) {
        // A removal may throw after changing the filesystem. Absence does
        // not erase that failure from a final-capture receipt.
        if (error) return { released: false, reason: "remove-failed", error: error.message,
          recovery: "the lock is now absent, but removal reported an error; inspect the failure and rerun capture" };
        return { released: true };
      }
      // Our own lock could not be removed. We are the holder and, as far as
      // this process can tell, alive; the operator gets a conditional line.
      const live = pid === process.pid ? "alive" : liveness(cur);
      const recovery = `${dir} is still held by pid ${pid} (this pass, ${live} when it reported this); its removal failed${error ? ` (${error.message})` : ""}; once that process has exited (ps -p ${pid}), remove the lock with: rm -r -- ${shellQuote(dir)}  and rerun`;
      return { released: false, reason: "remove-failed", liveness: live, ...(error ? { error: error.message } : {}), recovery };
    },
  };
}
