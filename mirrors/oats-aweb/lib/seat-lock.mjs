// The retained seat's lock, `.aw-retained-seat.json` beside a retained identity's
// `identity.source` (awebai/oats-aweb#236). It says which seat holds the standing
// identity: spawn creates it, a take-over (`identity.takeOver: true`) replaces it, a
// spawn's success rewrites it, and retire and a spawn's rollback remove it. Every one
// of those changes goes through `swapSeatLock`, so none acts on a lock it did not
// inspect at the moment it acts.
//
// The protocol, in one statement: every read, replace and remove of the lock happens
// under the guard; no guard spans an aw call; every exit after an aw call states the
// lock's holder as read under the guard, or says it is unknown; every guarded step
// reports what it could not clean, and nothing runs after a step that left anything.
//
// The protocol as a table: one row per operation that touches the lock or its private
// names (all in bin/oats-aweb.mjs). Each makes one guarded step: a read
// (readSeatLockGuarded) or a change (swapSeatLock). What it does for each outcome of
// that step's read of the lock:
// - ours: the lock names this home (in a spawn, with this spawn's takenAt);
// - another: it names another seat; absent: there is none;
// - unknown: its bytes can't be read, or it can't be checked;
// - refused: a guard or a moved-aside lock of another change is beside it, refused
//   with its fix before anything is read (SeatLockRefusal);
// - leftovers: the step left files it could not clean (SeatLockLeftovers): nothing runs
//   after it, and the exit names each file with its fix.
// [tag] is the test that pins the cell: the one marked `protocol: <tag>` in
// test/retained-seat-lock-236.test.mjs; [227: …] and [228: …] are tests of
// test/retained-seat-lock-227.test.mjs and test/retained-seat-killed-spawn-228.test.mjs.
//
// Spawn's read (a read; decides a plain spawn or a take-over). Exit 1, nothing copied,
// on every outcome but "absent" and a take-over:
//   ours, another (home here): refused, unless identity.takeOver
//     [227: a lock whose holder home exists still refuses without takeOver]
//   another (home not here): refused naming it, unless identity.takeOver
//     [227: a lock whose holder home is not on this host refuses, …]
//   absent: the plain take [spawn-read/absent]
//   unknown: refused as a lock that can't be read, unless identity.takeOver
//     [227: a lock that cannot be read refuses the same way; a dangling symlink …];
//     no guard can be made: says to check the directory [spawn-read/no-guard]
//   refused [spawn-read/refused]; leftovers [spawn-read/leftovers]
// Take, or take-over (a change: absent, or the very lock read, to this spawn's lock).
// Exit 1, nothing copied, on every outcome but the expected one:
//   expected: taken; the copy and the aw calls follow [take/expected]
//   another: names it [take/another]; absent (a take-over): spawn again [take/absent]
//   unknown: put back untouched [take/unknown]
//   its write fails: its own bytes removed, the lock put back; bytes it can't remove or
//     read are kept, named as this change's write with their fix [take/write-failed]
//   refused [take/refused]; no guard [take/no-guard]; leftovers, taken or not
//     [take/leftovers]
// Success rewrite (a change: this spawn's lock to one with the alias):
//   ours: rewritten [rewrite/ours]
//   another, absent, unknown, refused: not briefed; the rollback runs [rewrite/another,
//     rewrite/absent, rewrite/unknown, rewrite/refused]
//   leftovers: not briefed; the rollback makes no aw call and no lock step
//     [rewrite/leftovers]
// Read after the spawn's last aw call (a read):
//   ours: briefed, exit 0 [last-read/ours]
//   another, absent, unknown, refused: not briefed; the rollback runs [last-read/another,
//     last-read/absent, last-read/unknown, last-read/refused]
//   leftovers: as for the rewrite [last-read/leftovers]
// The rollback's reads (a read before the legacy home's reconnect, and one after it).
// The spawn's exit, 1, names the holder of the rollback's last guarded read:
//   ours, absent: reconnected, then the release [rollback-read/absent;
//     228: a connect the server accepted but that failed …]
//   another: before: no reconnect, the copy removed; after: the copy removed; the exit
//     names that seat's connect [rollback-read/another]
//   unknown, refused: before: nothing reconnected, the copy kept; after: the exit says
//     the holder is unknown [rollback-read/unknown, rollback-read/refused]
//   leftovers: the copy and the lock kept; the exit names the holder that read saw,
//     with its connect, or says it is unknown [rollback-read/leftovers]
// The rollback's release (a change: this spawn's lock removed):
//   ours: removed [228: a connect the server accepted but that failed …]
//   another: left, named [release/another]; absent: nothing to do [release/absent]
//   unknown, refused: left, the holder unknown [release/unknown, release/refused]
//   leftovers: says whether it was removed [release/leftovers]
// Retire's read (a read). The lock never changes retire's exit status:
//   ours: the removal [retire-read/ours]
//   another: left in place [228: a retained seat's retire leaves a lock another seat
//     has taken over, and says so]
//   absent: "already gone" [retire-read/absent]
//   unknown: left, whether this home holds it unknown [retire-read/unknown; 228: a lock
//     that cannot be read is left in place …; a lock that cannot be checked …]
//   refused [retire-read/refused]; leftovers: left in place [retire-read/leftovers]
// Retire's removal (a change: a lock naming this home removed):
//   ours: removed [retire-remove/ours]
//   another: put back; "this seat no longer owns it" [retire-remove/another]
//   absent: "already gone" [retire-remove/absent]
//   unknown, or the step failed before it checked the lock (its guard, the move, the
//     inspection): put back, whether this home holds it unknown [retire-remove/unknown]
//   refused: left in place [retire-remove/refused]
//   the removal fails: put back, left in place [retire-remove/failed; 228: a lock this
//     home holds but cannot remove …]
//   leftovers: what the step did, with each file's fix [retire-remove/leftovers]
//
// Two private names beside the lock, both written only inside swapSeatLock:
// - `<lock>.guard`: created exclusively (O_CREAT|O_EXCL) for the change and removed
//   after it. One change runs at a time; another waits GUARD_WAIT_MS for it, then
//   refuses. The guarded section is a few file operations and no aw call.
// - `<lock>.held`: the lock, moved aside by rename(2) while it is inspected. The
//   change applies only to what was moved: the expected lock is then removed, or
//   replaced by a fresh exclusive create; any other lock is linked back.
//
// Why this is atomic on a POSIX filesystem: rename(2) moves the name in one step, so
// what is inspected is exactly the file (inode) that was at the lock's name at that
// instant, whatever a writer that ignores the guard does to the name afterwards. A
// writer that overwrites the lock in place before the move changes the moved file
// itself, which is what is compared. link(2) and an O_EXCL create fail with EEXIST
// rather than replace a lock that appeared meanwhile. Among oats.aweb's own changes,
// the exclusive guard serializes them, so the lock's name is never empty in a way
// that lets another spawn create a lock in between.
//
// Where those calls are not atomic (some network and FUSE filesystems: NFS before v3
// has no exclusive create, and a client's retried rename or link can report an
// error for a step that took effect), two changes can both take the guard, or one
// can see a failure for a step that happened. Nothing here detects that. A link that
// the filesystem refuses (no hard links) falls back to an exclusive create of the
// moved lock's bytes.
//
// Nothing here infers age, a pid or liveness. A guard or a moved lock that a killed
// change left behind is found by the next change: it is refused with its whole fix,
// never adopted and never removed automatically.
import { closeSync, fstatSync, linkSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname } from "node:path";

export const GUARD_WAIT_MS = 3000;
const GUARD_POLL_MS = 25;

export const seatGuardPath = (lockPath) => `${lockPath}.guard`;
export const seatHeldPath = (lockPath) => `${lockPath}.held`;

/** A value a lock or guard names, when it is short and printable; the files are
 *  written by whoever runs as this user. */
export const lockField = (v) => typeof v === "string" && v && v.length <= 512 && /^[\x20-\x7e]+$/.test(v) ? v : undefined;
/** A path as one POSIX shell word, for a command a person copies. */
const shellWord = (p) => `'${String(p).replaceAll("'", "'\\''")}'`;
const errorCode = (e) => /^E[A-Z]+$/.test(String(e?.code)) ? e.code : "error";
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** What is at `path`: `{ present: false }`, or `{ present: true, ino, text, doc }`
 *  (`text` null when it cannot be read, with `readError` its code; `doc` the parsed
 *  object or undefined). A lock whose bytes can't be read names no holder: its holder
 *  is unknown, never "another seat".
 *  Throws an error with `code` when `path` cannot be checked. */
export function readSeatLock(path) {
  let st;
  try { st = lstatSync(path); }
  catch (e) { if (e?.code === "ENOENT") return { present: false }; throw e; }
  let text = null, readError;
  try { text = readFileSync(path, "utf8"); } catch (e) { readError = errorCode(e); }
  let doc; try { doc = text === null ? undefined : JSON.parse(text); } catch { doc = undefined; }
  return { present: true, ino: st.ino, text, doc: doc && typeof doc === "object" && !Array.isArray(doc) ? doc : undefined, ...(text === null ? { readError } : {}) };
}
/** True when `now` is the very lock `then` was: the same file and the same bytes. */
export const sameSeatLock = (now, then) => !!now?.present && !!then?.present && now.ino === then.ino && now.text === then.text;

/** Who a lock (or a guard) names, each field bounded and printable. */
export const seatLockHolderText = (doc) => ["instance " + (lockField(doc?.instance) || "(not recorded)"), "home " + (lockField(doc?.home) || "(not printable)"), "host " + (lockField(doc?.host) || "(not recorded)"), "since " + (lockField(doc?.takenAt) || lockField(doc?.at) || "(not recorded)")].join(", ");

/** A refusal whose message is its whole fix. `kind`: "guard-held", "held-stray" or
 *  "not-a-lock". */
class SeatLockRefusal extends Error {
  constructor(kind, message, path) { super(message); this.kind = kind; this.path = path; }
}
/** A guarded step that left something it could not clean: `leftovers`, each one file
 *  and its whole fix, joined in `recovery` (also the message). `result` is the step's
 *  answer when the step itself was made; `cause` the failure when it was not, whose
 *  `code` and `stage` this error carries too. The caller treats the step as failed:
 *  nothing runs after it (no aw call, no brief). */
class SeatLockLeftovers extends Error {
  constructor(leftovers, { result, cause }) {
    const recovery = [...(cause instanceof SeatLockRefusal ? [cause.message] : []), ...leftovers].join("; ");
    super(recovery);
    this.leftovers = leftovers; this.recovery = recovery; this.result = result; this.cause = cause;
    if (cause && !(cause instanceof SeatLockRefusal)) { this.code = cause.code; this.stage = cause.stage; }
  }
}
export const isSeatLockRefusal = (e) => e instanceof SeatLockRefusal;
export const isSeatLockLeftovers = (e) => e instanceof SeatLockLeftovers;

const guardFix = (guard) => `it is never removed automatically or by age. Once no spawn, take-over or retire of this identity runs on any host that shares ${dirname(guard)}, remove ${guard} and retry`;

/** Create the guard and record this change in it. A guard it created and could not
 *  record itself in is removed while it is still that file (its inode), or left in
 *  `left`. Throws a SeatLockRefusal when another change holds the guard, and the
 *  failure (`stage: "guard"`) when it can't be created or recorded. */
function takeGuard(guard, who, left) {
  const mine = { ...who, host: hostname(), at: new Date().toISOString(), token: randomUUID() };
  const deadline = Date.now() + GUARD_WAIT_MS;
  for (;;) {
    let fd;
    try { fd = openSync(guard, "wx", 0o600); }
    catch (e) {
      if (e?.code !== "EEXIST") throw Object.assign(e, { stage: "guard" });
      if (Date.now() >= deadline) {
        let held; try { held = JSON.parse(readFileSync(guard, "utf8")); } catch { held = undefined; }
        const by = held && typeof held === "object" ? ` (${lockField(held.op) || "a change"} by ${seatLockHolderText(held)})` : "";
        throw new SeatLockRefusal("guard-held", `${guard} exists${by}: another spawn, take-over or retire of this retained identity is changing its lock, or one was killed while it did; the guard is never removed automatically or by age. Once no spawn, take-over or retire of this identity runs on any host that shares ${dirname(guard)}, remove ${guard} and retry`, guard);
      }
      sleep(GUARD_POLL_MS);
      continue;
    }
    // Recorded only when the inode is known, the record written and the file closed;
    // any of those failing leaves a guard this change removes by its inode, or reports.
    // The descriptor is closed once, never retried (close(2) may report a delayed error).
    let ino, failure;
    try { ino = fstatSync(fd).ino; } catch (e) { failure = e; }
    if (!failure) { try { writeSync(fd, JSON.stringify(mine) + "\n"); } catch (e) { failure = e; } }
    try { closeSync(fd); } catch (e) { failure = failure || e; }
    if (failure) {
      if (ino === undefined || !dropUnrecordedGuard(guard, ino)) left.push(`${guard} is this change's guard, left by a step that failed (${errorCode(failure)}); ${guardFix(guard)}`);
      throw Object.assign(failure, { stage: "guard" });
    }
    return mine;
  }
}
/** → true when the guard at `guard` is gone, having removed it only while it is still
 *  the file `ino`. */
function dropUnrecordedGuard(guard, ino) {
  try { if (lstatSync(guard).ino !== ino) return false; unlinkSync(guard); return true; }
  catch (e) { return e?.code === "ENOENT"; }
}
/** Remove this change's guard. One that can't be read or removed is left in `left`;
 *  another change's guard (another token) is not this change's to clean. */
function releaseGuard(guard, mine, left) {
  let text;
  try { text = readFileSync(guard, "utf8"); }
  catch (e) { if (e?.code !== "ENOENT") left.push(`${guard}, this change's guard, could not be read to remove it (${errorCode(e)}); ${guardFix(guard)}`); return; }
  let now; try { now = JSON.parse(text); } catch { now = undefined; }
  if (!now || typeof now !== "object") { left.push(`${guard} no longer holds this change's record (it cannot be read as a guard); ${guardFix(guard)}`); return; }
  if (now.token !== mine.token) return;
  try { unlinkSync(guard); }
  catch (e) { if (e?.code !== "ENOENT") left.push(`${guard} is this change's guard, and it could not be removed (${errorCode(e)}); ${guardFix(guard)}`); }
}
/** The step's answer, or what it left: run `step` under the guard, release the guard,
 *  and throw a SeatLockLeftovers when anything is left, else the step's own failure. */
function guarded(lock, who, step) {
  const guard = seatGuardPath(lock), held = seatHeldPath(lock), left = [];
  let mine;
  try { mine = takeGuard(guard, who, left); }
  catch (e) { if (left.length) throw new SeatLockLeftovers(left, { cause: e }); throw e; }
  let result, cause;
  try { result = step(held, left); } catch (e) { cause = e; }
  // The moved-aside name exists only inside a step: one still there at its end is a
  // leftover, reported here when the step did not (one another change left is the
  // step's refusal, made before it moved anything).
  if (!(cause instanceof SeatLockRefusal && cause.kind === "held-stray") && !left.some((t) => t.includes(held))) {
    let stray; try { stray = readSeatLock(held); } catch (e) { stray = { present: true, doc: undefined, code: errorCode(e) }; }
    if (stray.present) left.push(stray.code ? `${held} could not be checked (${stray.code}); ${strayHeldText(lock, held, stray)}` : strayHeldText(lock, held, stray));
  }
  releaseGuard(guard, mine, left);
  if (left.length) throw new SeatLockLeftovers(left, { result, cause });
  if (cause) throw cause;
  return result;
}

/** The whole fix for a moved-aside lock (`stray`, as readSeatLock answers for `held`),
 *  by what is at the lock's name: nothing, a lock, or bytes that are not a lock (a
 *  write that did not finish), which the moved lock may replace. `failed`: the lock at
 *  the name is the one a change that failed just wrote, which the moved lock replaces. */
function strayHeldText(lock, held, stray, { failed = false, failedIf } = {}) {
  let at; try { at = readSeatLock(lock); } catch { at = { present: true, doc: undefined }; }
  const fix = failedIf && at.present
    ? `if ${failedIf}, which is what the change that failed wrote, move it back over that (\`mv -f -- ${shellWord(held)} ${shellWord(lock)}\`); otherwise remove ${held}`
    : failed && at.present
    ? `move it back over ${lock}, which holds what the change that failed wrote (\`mv -f -- ${shellWord(held)} ${shellWord(lock)}\`)`
    : at.present && !at.doc
    ? `if the seat it names still holds the identity, move it back over ${lock}, which is not a lock that can be read (\`mv -f -- ${shellWord(held)} ${shellWord(lock)}\`); otherwise remove ${held}`
    : `if the seat it names still holds the identity and ${lock} does not exist, move it back (\`mv -- ${shellWord(held)} ${shellWord(lock)}\`); otherwise remove ${held}`;
  return `${held} is this retained identity's lock, moved aside by a spawn, take-over or retire that did not finish (${stray.doc ? seatLockHolderText(stray.doc) : "it cannot be read"}); it is never adopted or removed automatically. Once no spawn, take-over or retire of this identity runs on any host that shares ${dirname(lock)}: ${fix}; then retry`;
}
const heldNow = (held) => { try { return readSeatLock(held); } catch { return { present: true, doc: undefined }; } };
function refuseStrayHeld(lock, held) {
  const stray = readSeatLock(held);
  if (stray.present) throw new SeatLockRefusal("held-stray", strayHeldText(lock, held, stray), held);
}
/** A directory at the lock's name is never a lock: a change that moved it aside could
 *  neither replace it with a file nor put it back over one, so it is refused before
 *  anything moves. A name that can't be checked is left to the step's own move. */
function refuseDirectory(lock) {
  let st; try { st = lstatSync(lock); } catch { return; }
  if (st.isDirectory()) throw new SeatLockRefusal("not-a-lock", `${lock} is a directory, not this retained identity's lock, and is never replaced or removed automatically. Once you know nothing in it is needed, remove it (\`rmdir -- ${shellWord(lock)}\` when it is empty) or move it elsewhere; then retry`, lock);
}
/** Put the moved lock back at its name, never over a lock that is there now. What it
 *  can't put back or clean is left in `left`. → true when the lock is at its name. */
function restoreHeld(lock, held, captured, left) {
  try { linkSync(held, lock); }
  catch (e) {
    // A filesystem with no hard links: the moved lock's bytes, created exclusively.
    let why = e?.code === "EEXIST" ? `a new lock appeared at ${lock} while it was moved aside` : captured.text === null ? `it could not be linked back (${errorCode(e)})` : undefined;
    if (!why) {
      try { writeFileSync(lock, captured.text, { flag: "wx", mode: 0o600 }); }
      catch (e2) { why = e2?.code === "EEXIST" ? `a new lock appeared at ${lock} while it was moved aside` : `it could not be put back (${errorCode(e2)})`; }
    }
    if (why) { left.push(`the lock this change inspected was not put back (${why}); ${strayHeldText(lock, held, heldNow(held))}`); return false; }
  }
  try { unlinkSync(held); }
  catch (e) { if (e?.code !== "ENOENT") left.push(`${held} is a second name of the lock now at ${lock}, left because it could not be removed (${errorCode(e)}); once no spawn, take-over or retire of this identity runs on any host that shares ${dirname(lock)}, remove ${held}; then retry`); }
  return true;
}
/** After this change could not remove the lock it moved aside: the change is undone by
 *  moving that lock back to its name, over this change's new lock when it wrote one
 *  (under the guard nothing else writes either name), or left in `left`. */
function undoFailedRemove(lock, held, next, left) {
  try { renameSync(held, lock); }
  catch (e) { left.push(`the moved lock could not be put back (${errorCode(e)}); ${strayHeldText(lock, held, heldNow(held), { failed: next !== null })}`); }
}
/** After this change's exclusive create of the lock failed: what it left at the lock's
 *  name (all of its bytes or a prefix: a write can fail after the last byte) is removed
 *  when it is a prefix of the bytes it wrote (under the guard nothing else writes that
 *  name), and the moved lock is put back; what can't be is left in `left`, with the
 *  fix for this change's own write, whole or not, which names no seat. */
function undoFailedWrite(lock, held, captured, next, left) {
  let at; try { at = readSeatLock(lock); } catch (e) { at = { present: true, text: null, readError: errorCode(e) }; }
  let stuck;
  if (at.present && at.text !== null && next.startsWith(at.text)) {
    try { unlinkSync(lock); at = { present: false }; } catch (e) { stuck = errorCode(e); }
  }
  if (!at.present) { if (captured.present) restoreHeld(lock, held, captured, left); return; }
  // Under the guard only this change writes the lock's name, so bytes there that can't
  // be read are this change's write as far as can be told: kept, with the fix for it.
  const unread = at.text === null ? at.readError || "error" : undefined;
  let mine; try { mine = JSON.parse(next); } catch { mine = undefined; }
  const named = lockField(mine?.home) ? `names home ${mine.home}${lockField(mine.takenAt) ? ` since ${mine.takenAt}` : ""} or ` : "";
  const until = `Once no spawn, take-over or retire of this identity runs on any host that shares ${dirname(lock)}`;
  if (stuck === undefined && unread === undefined) {
    if (captured.present) left.push(strayHeldText(lock, held, heldNow(held)));
    else left.push(`${lock} was left, and it is not this change's write. ${until}: if it is not a lock that can be read, remove it; then retry`);
    return;
  }
  const why = stuck !== undefined
    ? `${lock} holds this change's write, which could not be removed (${stuck})`
    : `${lock} could not be read (${unread}) to check whether it is this change's write, so it was left`;
  if (captured.present) {
    left.push(`${why}; ${strayHeldText(lock, held, heldNow(held), stuck !== undefined ? { failed: true } : { failedIf: `${lock} still ${named}is not a lock that can be read` })}`);
    return;
  }
  left.push(`${why}; this change failed, so a lock it wrote names no seat that holds the identity. ${until}: remove ${lock} if it still ${named}is not a lock that can be read; then retry`);
}

/** Inspect the lock and change it in one guarded step. `expect(captured)` says
 *  whether the lock now at its name is the one this change may act on (`captured` as
 *  readSeatLock answers). If it is, `next` (the new lock's text) replaces it, or it is
 *  removed when `next` is null; if it is not, it is put back untouched.
 *  → `{ done, captured }`. Every guarded step reports what it could not clean, and
 *  nothing runs after a step that left anything: it throws a SeatLockLeftovers (with
 *  this answer as its `result` when the step was made). Otherwise it throws a
 *  SeatLockRefusal for a guard or a moved lock left by another change, and an error
 *  with `code` and `stage` when a step fails, having undone its own effect. `who`
 *  ({op, instance, home}) is written into the guard, for the refusal another change
 *  prints. */
export function swapSeatLock(lock, { who, expect, next }) {
  return guarded(lock, who, (held, left) => {
    refuseStrayHeld(lock, held);
    refuseDirectory(lock);
    let moved = false;
    try { renameSync(lock, held); moved = true; }
    catch (e) { if (e?.code !== "ENOENT") throw Object.assign(e, { stage: "move" }); }
    let captured;
    try { captured = readSeatLock(held); }
    catch (e) {
      // The moved lock could not be inspected: it goes back to its name untouched.
      if (moved) restoreHeld(lock, held, { text: null }, left);
      throw Object.assign(e, { stage: "inspect" });
    }
    if (!expect(captured)) { if (captured.present) restoreHeld(lock, held, captured, left); return { done: false, captured }; }
    if (next !== null) {
      try { writeFileSync(lock, next, { flag: "wx", mode: 0o600 }); }
      catch (e) {
        if (e?.code === "EEXIST") {
          // Our moved lock stays at its private name, beside the new one.
          if (captured.present) left.push(`a new lock appeared at ${lock} while it was moved aside, so the one this change inspected is kept; ${strayHeldText(lock, held, heldNow(held))}`);
          return { done: false, captured: readSeatLock(lock) };
        }
        undoFailedWrite(lock, held, captured, next, left);
        throw Object.assign(e, { stage: "write" });
      }
    }
    if (captured.present) {
      try { unlinkSync(held); }
      catch (e) { undoFailedRemove(lock, held, next, left); throw Object.assign(e, { stage: "remove" }); }
    }
    return { done: true, captured };
  });
}

/** The lock as it is between changes: read under the guard, so never in the moment
 *  another change has it moved aside. → what readSeatLock answers. Throws as
 *  swapSeatLock does: a SeatLockLeftovers when the step left anything (its `result` the
 *  read), a SeatLockRefusal when a guard or a moved-aside lock left by another change
 *  is beside it (so every next change reports a killed change's leftovers), and an
 *  error with `code` when it can't be checked (`stage: "guard"` when the guard itself
 *  can't be created, so no change of the lock could be made either). Every decision on
 *  who holds the lock is made on this read or inside swapSeatLock. */
export function readSeatLockGuarded(lock, { who }) {
  try { return guarded(lock, who, (held) => { refuseStrayHeld(lock, held); return readSeatLock(lock); }); }
  catch (e) {
    // No guard, so no change of the lock can be made. A check of the lock's name only
    // says which failure that is (a directory that can't be searched, or only not
    // written); nothing is decided on it.
    if (e?.stage === "guard" && !(e instanceof SeatLockLeftovers)) { try { lstatSync(lock); } catch (e2) { if (e2?.code !== "ENOENT") throw e2; } }
    throw e;
  }
}
