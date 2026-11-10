/** The claim: one file that says which process is doing a thing that must happen once at a time.
 *  One protocol, used by `oats worktree add|remove` (the purpose's claim, lib/worktree.mjs
 *  `withClaim`) and by `oats retire` and `oats instance stop` (the home's claim, lib/core.mjs
 *  `claimHomeFor`), and by the lock of the kernel's shared files and of the machine's resume sweep
 *  (lib/dir-lock.mjs `withDirLock`, `acquireDirLock`).
 *
 *  A claim left by a process that died is taken over, so a killed command can always be run
 *  again: the owner is named by pid AND start time (processLiveness), never by a
 *  pid alone, and a holder whose start cannot be read is never taken for gone.
 *
 *  - Taking it: the owner's facts `{ pid, processStart, nonce, at }`, with what the caller adds to
 *    them (`facts`), are written to a private file and hard-linked to `path`, which fails if
 *    `path` exists. So a claim is never seen without its owner, and the nonce makes each holding
 *    distinct, even for the same process.
 *  - Its owner is alive: waited for up to `waitMs`, then refused (`busy`).
 *  - Its owner is gone (processLiveness "gone", which a zombie is too; "unknown" is refused, never
 *    taken over): the claim is removed under a second claim, `<path>.reclaim-<owner nonce>`, taken
 *    by this same protocol.
 *    Its holder re-reads `path` and removes it only if it still names that owner. Nothing else
 *    removes another's claim: its owner never releases it, and a new acquirer cannot write over an
 *    existing file. Two takeovers of one dead owner are therefore serialized, and neither removes
 *    a claim made after it read. A takeover cut short leaves its own claim behind, which the next
 *    takeover takes over in turn, up to CLAIM_MAX_DEPTH nested levels.
 *  - Its owner is gone and the file cannot be taken over: refused with `cannotTakeOver`, which
 *    says that the holder is gone and what to do with the file. Never with `busy`: nobody is
 *    running (awebai/oats#874). That is a file whose `nonce` is not the 32 hex digits a claim
 *    carries, so no takeover can be serialized on it; the claim of a takeover nested
 *    CLAIM_MAX_DEPTH deep; and, which comes first on the file systems there are, one whose
 *    takeover claim the system refuses to name: each nested level adds 41 bytes to the name, so a
 *    chain of four or five dead takeovers reaches the limit of a file name (ENAMETOOLONG). The
 *    refusal names the file whose takeover could not be named, the one to remove.
 *  - A step the holder recorded in its claim (recordInClaim) is ended by a takeover first
 *    (`endHolderStep`), which refuses, keeping the claim, if the step cannot be ended.
 *  - Once a takeover has ended a holder's step, no later answer of that acquisition says that
 *    nothing was done: whatever it is then refused with, or fails on, is answered
 *    E_LIFECYCLE_FAILED, naming first what was ended. Every refusal is handed what was ended so
 *    far (`ended`, the clauses in order; empty before any effect) and writes its own sentence
 *    for it (lib/errors.mjs nothingAfter, afterEndedSteps; lifecycleBusy takes `ended`): no
 *    message is rewritten here. A refusal that was made without them is still answered after
 *    them (claimUnavailable). A refusal before any effect stays what its caller made it.
 *  - Released by unlinking `path`, only while it still names this holding.
 *  - A claim that could not be WRITTEN is marked as that, for the one caller that then reads it
 *    in place of taking it (`oats instance stop --apply`: lib/core.mjs claimHomeFor). The mark is
 *    made at the place, one of the claim's writes (claimWrite: its directory, its private file,
 *    its link, and the same of a takeover's own claim), for the system's code as it was thrown
 *    there, one of CLAIM_UNWRITABLE_CODES; it travels on the refusal (unwritableCode). No reader
 *    of an answer's code, words or details can tell this failure from another, and none tries:
 *    a defect, and a claim that could not be removed, are E_LIFECYCLE_FAILED too. Whether
 *    anybody holds a claim that was not taken is read by claimUnheld, which says "nobody" only
 *    of a path that is absent or of a claim whose holder is verifiably gone.
 *  - A claim is read back as whatever JSON is in its file, and the file is where others than its
 *    writer can write. Who holds it, and whether that process lives, is decided on the record as
 *    it is; what an ANSWER shows of it is only what shownHolder allows, never the file's text.
 *  - An unreadable claim file is never removed: the command is refused, naming the file. So is a
 *    path that exists and keeps reading as absent (a dangling symbolic link where the claim
 *    belongs), once the retries below are spent.
 *  - Every pass that does not take the claim falls through one check of its time and one pause
 *    (takeClaim): none starts the next pass at once, so no state of the path makes it spin, and
 *    each ends in a refusal within `waitMs` plus CLAIM_FREED_RETRIES pauses (awebai/oats#874).
 *    A claim that every one of those passes found held again by a process that is gone, after it
 *    took the one before over, is refused with `heldAgain`: an ordinary claim, which the next
 *    run takes over.
 *  - A claim that cannot be taken for a reason of the system's (its directory cannot be made, its
 *    private file cannot be written, the link fails otherwise than because the claim exists) is
 *    refused as E_LIFECYCLE_FAILED (claimUnavailable), never with the system's code
 *    (awebai/oats#874): the claim was not taken, so nothing was done.
 *
 *  Everything is synchronous. What is the caller's own goes in `opts`. Each refusal is an error
 *  whose message states its effects, once: in the caller's words for "nothing was done" before
 *  any effect, and as "nothing else was done" when `ended`, its last argument, names what this
 *  acquisition's takeovers ended before it:
 *    busy(holder, unknown, at, ended)       the refusal for a holder that lives (`unknown` unset)
 *                                           or whose liveness cannot be read (`unknown` is the
 *                                           reason); `at` is the claim file that names it
 *    ownStartUnreadable(reason, at, ended)  the refusal when this process's own start cannot be
 *                                           read, so it could not hold `at` verifiably
 *    unreadableClaim(at, ended)             the refusal for a claim file that does not parse, or
 *                                           for a path that exists and cannot be read as one
 *    cannotTakeOver(holder, at, why, ended) the refusal for a holder that is gone and whose claim
 *                                           file `at` this kernel cannot take over; `why` is a
 *                                           clause saying what stops it
 *    heldAgain(holder, at, times, ended)    the refusal for a claim that this command found
 *                                           without a live holder `times` times and that was
 *                                           taken again each time, the last time by `holder`,
 *                                           which is gone: nothing is wrong with `at`
 *    endHolderStep(holder, at, ended)       optional: end the step a dead holder recorded
 *                                           → { refusal?, warning?, ended? }; `refusal` is the
 *                                           caller's answer for a step that could not be ended
 *                                           (`at` is kept); `ended` is a clause naming what it
 *                                           ended, when it ended something
 *    holderGone(holder)              optional: whether a fact of the caller's own in the record
 *                                    says that `holder` is gone, whatever its pid reads as (the
 *                                    resume sweep's lock: taken in another boot, which no process
 *                                    outlives, while a pid and a start counted from the boot can
 *                                    both come again in the next). Asked in place of reading the
 *                                    process; such a holder is taken over as any gone one
 *    waitMs                          how long a live holder is waited for (default CLAIM_WAIT_MS)
 *    warnings                        optional array a takeover's warnings are pushed to
 *    facts                           optional object, what the caller's claim says besides its
 *                                    owner (a home's lifecycle claim: `action`, the holder's verb).
 *                                    It is in the record that is linked, so the claim is never
 *                                    seen without it; the owner's four fields win over it */
import { linkSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isStartToken, processLiveness, processStart } from "./worktree-hooks.mjs";
import { NOTHING_ELSE, afterEndedSteps, asKernelError, nothingAfter } from "./errors.mjs";
import { writeThroughPrivateFile } from "./write-through-private-file.mjs";

export const CLAIM_WAIT_MS = 3000;
const CLAIM_MAX_DEPTH = 8;
/** How long a pass that did not take the claim pauses before the next one. */
const CLAIM_PAUSE_MS = 50;
/** How many passes that found nobody holding the claim (it read as absent, or its holder was gone
 *  and it was taken over) are followed by another once `waitMs` is over; passes before that are
 *  not counted. With `waitMs: 0` that is every retry there is: enough for the true race, a claim
 *  released or freed between two steps of this process, and an end for a path that never becomes
 *  a claim. */
const CLAIM_FREED_RETRIES = 5;
const NONCE_RE = /^[0-9a-f]{32}$/;
const ISO_INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
/** Whether `at` is an instant exactly as `toISOString()` gives it, and one that exists. */
const isInstant = (at) => typeof at === "string" && ISO_INSTANT.test(at) && !Number.isNaN(Date.parse(at)) && new Date(at).toISOString() === at;
const pauseSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The claim at `path` → its record, `{ unreadable: true }` when it does not parse, null when there is none. */
export function readClaim(path) {
  try { const o = JSON.parse(readFileSync(path, "utf8")); return o && typeof o === "object" ? o : { unreadable: true }; }
  catch (e) { return e.code === "ENOENT" ? null : { unreadable: true }; }
}

/** What of the claim record `record` may be shown in an answer → `{ pid, since, start }`, each
 *  null unless it has the shape takeClaim writes it in:
 *    pid    the record's `pid`, a positive safe integer;
 *    since  the record's `at`, exactly what `toISOString()` gives (`2026-01-01T00:00:00.000Z`);
 *    start  the record's `processStart`, a token of the kernel's (worktree-hooks isStartToken).
 *  A claim is a file in a directory that other instances of the deployment can write, and it is
 *  read back as whatever JSON is there: text of it is never part of an answer. Every refusal of a
 *  claim names its holder through this, in its message and in its `details`; a caller's own
 *  fact (`facts`) has its own closed reading (lib/core.mjs claimAction). Only for what is shown:
 *  who holds the claim, and whether it lives, is decided on the record as it is. */
export function shownHolder(record) {
  const { pid, at, processStart: start } = record && typeof record === "object" ? record : {};
  return {
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    since: isInstant(at) ? at : null,
    start: isStartToken(start) ? start : null,
  };
}

/** The system's codes for which a claim that cannot be written is read in place of being taken, by
 *  the one verb that may (a stop apply). Each is here for one reason: what stops this process
 *  from writing a claim in that directory stops a retire or another stop of the same user as
 *  well, so a claim that reads as held by nobody is held by nobody.
 *    ENOSPC  the file system is full
 *    EDQUOT  this user's quota is spent
 *    EROFS   the file system is read-only
 *    EACCES, EPERM  the claims directory is not writable by this user (EPERM also where the file
 *            system has no hard links). Every instance of a deployment can change that
 *            directory, and one that takes write permission from it must not take Stop from the
 *            operator.
 *  It is not true of space that is freed a moment later, nor of a process of another user. Any
 *  other code (EIO, EMFILE, ENAMETOOLONG, EEXIST from a file where the directory belongs) says
 *  nothing about who else could write there, and is never in this list. */
export const CLAIM_UNWRITABLE_CODES = Object.freeze(["ENOSPC", "EDQUOT", "EROFS", "EACCES", "EPERM"]);
const UNWRITABLE = Symbol("oats.claimUnwritable");
/** Make one of a claim's writes: `write()`, and what it returns. An error of the system's it
 *  throws with a code of CLAIM_UNWRITABLE_CODES is marked with that code and thrown as it is:
 *  the place and the code as thrown are what make a claim "one that could not be written"
 *  (unwritableCode). For the writes of taking a claim and for no other call: its directory
 *  (the caller's mkdir), its private file, its link. */
export function claimWrite(write) {
  try { return write(); }
  catch (e) {
    if (e instanceof Error && typeof e.syscall === "string" && CLAIM_UNWRITABLE_CODES.includes(e.code)) Object.defineProperty(e, UNWRITABLE, { value: e.code });
    throw e;
  }
}
/** The code for which the claim behind `refusal` could not be written (CLAIM_UNWRITABLE_CODES),
 *  when that is why it was not taken and nothing was ended before; else undefined. `refusal` is
 *  what acquireClaim or claimUnavailable answered. */
export const unwritableCode = (refusal) => (refusal instanceof Error ? refusal[UNWRITABLE] : undefined);

/** The refusal for a claim `path` that could not be taken because of `e`, an error that is not the
 *  kernel's. The caller's command did nothing: it acts only once it holds its claim. Also for a
 *  caller that fails to make the claim's directory. `ended` is what this acquisition's takeovers
 *  ended before `e`: with it the answer names that first and says "nothing else was done". An
 *  error that is the kernel's is returned as it is before any effect, and after what was ended
 *  otherwise: the refusals of a claim are made for `ended` already, and one that was not still
 *  never says, by its code, that nothing happened. The one error on the way to a claim that itself
 *  comes after something was done says so (takeOver: the claim of a gone holder that cannot be
 *  removed once that holder's step was ended). */
export function claimUnavailable(path, e, ended) {
  const refusal = asKernelError(e, "E_LIFECYCLE_FAILED", `the claim ${path} could not be taken (${e?.message ?? e}); ${nothingAfter(ended)}`);
  // The mark of a write that failed (claimWrite) goes with the refusal. Once something was ended
  // the answer is another error, made below, and carries none: nobody reads a claim in the place
  // of an answer that says what was done.
  const code = unwritableCode(e);
  if (code && refusal !== e) Object.defineProperty(refusal, UNWRITABLE, { value: code });
  return afterEndedSteps(ended, refusal);
}

/** Whether anybody holds the claim `path`, read and not taken: for the caller whose claim could
 *  not be written (unwritableCode). Returns when NOBODY holds it, which is said only of a path
 *  that is absent and of a claim whose holder is verifiably gone and that could be taken over
 *  (it is left as it is). Throws otherwise, what taking it would have answered for what is
 *  there, from the caller's refusals (`opts`, as acquireClaim takes them):
 *    a holder that lives, or whose liveness cannot be read   busy
 *    bytes that are no claim; a directory; a path that is
 *    there and reads as absent (a dangling symbolic link)    unreadableClaim
 *    a gone holder whose claim no kernel can take over       cannotTakeOver
 *  and `otherwise`, the refusal of the write that failed, when the read itself fails for a
 *  reason of the system's: the path was not reached, so neither a holder nor nobody was
 *  established. The read is positive or it is nothing. */
export function claimUnheld(path, opts, otherwise) {
  for (let pass = 0; ; pass++) {
    let text;
    try { text = readFileSync(path, "utf8"); }
    catch (e) {
      // Something is there that is no file to read: no claim, as the taking finds it.
      if (e?.code === "EISDIR") throw opts.unreadableClaim(path, []);
      if (e?.code !== "ENOENT") throw otherwise;
      // Absent, unless the path itself is there: a link to nowhere reads as absent for ever.
      let entry;
      try { entry = lstatSync(path); } catch (e2) { if (e2?.code === "ENOENT") return; throw otherwise; }
      // A claim made between the two reads is read again, once, and is a claim.
      if (entry.isSymbolicLink() || pass) throw opts.unreadableClaim(path, []);
      continue;
    }
    let holder;
    try { holder = JSON.parse(text); } catch { holder = null; }
    // readClaim's own reading of bytes that are no claim, `unreadable` in a record included.
    if (!holder || typeof holder !== "object" || holder.unreadable) throw opts.unreadableClaim(path, []);
    const live = processLiveness(holder);
    if (live.state !== "gone") throw opts.busy(holder, live.state === "unknown" ? live.reason : null, path, []);
    const stuck = cannotBeTakenOver(holder, 0);
    if (stuck) throw opts.cannotTakeOver(holder, path, stuck, []);
    return;
  }
}

/** Take the claim `path` → this holding (`{ pid, processStart, nonce, at }`, with `opts.facts`), to
 *  pass to releaseClaim. Throws the caller's refusal when it cannot be taken, and claimUnavailable for
 *  any error that is not the kernel's. The directory exists. */
export function acquireClaim(path, opts, depth = 0) {
  const endedSteps = [];
  try { return takeClaim(path, opts, depth, endedSteps); }
  catch (e) { throw claimUnavailable(path, e, endedSteps); }
}

/** `endedSteps` collects what the takeovers of one acquisition ended, nested ones included; every
 *  refusal is handed it as it is when the refusal is made. */
function takeClaim(path, opts, depth, endedSteps) {
  const { busy, waitMs = CLAIM_WAIT_MS } = opts;
  const own = processStart(process.pid);
  if (own.state !== "alive") throw opts.ownStartUnreadable(own.reason ?? `pid ${process.pid} reads as ${own.state}`, path, endedSteps);
  const me = { ...opts.facts, pid: process.pid, processStart: own.token, nonce: randomBytes(16).toString("hex"), at: new Date().toISOString() };
  const tmp = `${path}.tmp-${process.pid}-${me.nonce}`;
  try {
    // Inside the block that removes it: a write that fails after the file was created (a full
    // file system does exactly that) leaves nothing behind.
    claimWrite(() => writeFileSync(tmp, JSON.stringify(me) + "\n", { mode: 0o600 }));
    const deadline = Date.now() + waitMs;
    for (let freed = 0; ;) {
      try { claimWrite(() => linkSync(tmp, path)); return me; }
      catch (e) { if (e?.code !== "EEXIST") throw e; }
      const holder = readClaim(path);
      if (holder?.unreadable) throw opts.unreadableClaim(path, endedSteps);
      const live = holder ? (opts.holderGone?.(holder) ? { state: "gone" } : processLiveness(holder)) : null;
      // Unreadable is never taken for gone: the claim is kept, and the refusal names the way out.
      if (live?.state === "unknown") throw busy(holder, live.reason, path, endedSteps);
      const gone = live?.state === "gone";
      const stuck = gone ? cannotBeTakenOver(holder, depth) : null;
      if (stuck) throw opts.cannotTakeOver(holder, path, stuck, endedSteps);
      // Nobody holds it: the link said it exists and it reads as absent (released in between; or a
      // path that never reads, a dangling symbolic link), or its holder is gone and it is taken
      // over below. The next pass is owed even with no time to wait, but not for ever.
      const free = !holder || gone;
      // What this pass answers once its time is up, about the file as it has just been read. A
      // gone holder here is the last of several: each pass took the one before over, and the
      // claim was taken again before this process could. The file is a claim like any other.
      const refusal = !holder ? () => opts.unreadableClaim(path, endedSteps)
        : gone ? () => opts.heldAgain(holder, path, freed, endedSteps)
        : () => busy(holder, null, path, endedSteps);
      // One check of its time and one pause for every pass that did not take the claim: nothing
      // above starts the next pass (lib/remote.mjs withCacheWriteLock, the same rule).
      if (Date.now() >= deadline) {
        if (!(free && freed < CLAIM_FREED_RETRIES)) throw refusal();
        freed++;
      }
      if (gone) takeOver(path, holder, opts, depth, endedSteps);
      pauseSync(CLAIM_PAUSE_MS);
    }
  } finally {
    try { unlinkSync(tmp); } catch { /* gone */ }
  }
}

/** Why the claim of the gone `holder`, met at `depth`, cannot be taken over → a clause, or null
 *  when it can. A takeover is serialized on the holder's nonce, so a file without one that this
 *  kernel writes is not removed by anybody (removeGoneClaim skips it too). */
function cannotBeTakenOver(holder, depth) {
  if (typeof holder.nonce !== "string" || !NONCE_RE.test(holder.nonce)) return "its nonce is not the 32 hexadecimal digits a claim carries";
  if (depth >= CLAIM_MAX_DEPTH) return `it is the claim of a takeover nested ${CLAIM_MAX_DEPTH} deep`;
  return null;
}

/** Remove `path`, held by the dead `holder`, under the claim that serializes takeovers of it. What
 *  it ended of the holder's goes to `endedSteps`, once the claim is removed. */
function takeOver(path, holder, opts, depth, endedSteps) {
  const reclaim = `${path}.reclaim-${holder.nonce}`;
  let me;
  try { me = takeClaim(reclaim, opts, depth + 1, endedSteps); }
  catch (e) {
    // The system will not name the claim of this takeover: `path` is as deep as takeovers nest
    // here. Its own answer is read, never a limit assumed, so this holds on any file system; and
    // it comes before the holder's step is ended or anything is removed. A refusal from a level
    // below is a kernel error and passes as it is, so the answer names the deepest claim reached.
    if (e?.code === "ENAMETOOLONG") throw opts.cannotTakeOver(holder, path, "the claim of one more takeover would have a name longer than this file system allows", endedSteps);
    throw claimUnavailable(reclaim, e, endedSteps);
  }
  try {
    const now = readClaim(path);
    if (now?.nonce === holder.nonce) {
      const ended = opts.endHolderStep?.(now, path, endedSteps) ?? {};
      if (ended.refusal) throw ended.refusal;
      if (ended.warning) opts.warnings?.push(ended.warning);
      try { unlinkSync(path); }
      catch (e) {
        // The holder's step is ended by now: "nothing was done" (claimUnavailable) would not be true.
        if (!ended.ended) throw e;
        throw asKernelError(e, "E_LIFECYCLE_FAILED", `the claim ${path} could not be taken (${e?.message ?? e}): ${ended.ended}, and the claim it left is kept; ${NOTHING_ELSE}`);
      }
      if (ended.ended) endedSteps.push(ended.ended);
    }
  } finally {
    releaseClaim(reclaim, me);
  }
}

/** Release the claim `path`, only while it still names the holding `me`. */
export function releaseClaim(path, me) {
  if (readClaim(path)?.nonce === me.nonce) { try { unlinkSync(path); } catch { /* gone */ } }
}

/** Record (or, with null, clear) a step of the holding `me` in its claim `path`, for a takeover to
 *  end (`endHolderStep`). Only the live holder writes its claim. */
export function recordInClaim(path, me, step) {
  writeThroughPrivateFile(path, `${path}.tmp-${process.pid}-${me.nonce}`, JSON.stringify({ ...me, ...(step ?? {}) }) + "\n", 0o600);
}

/** Remove the claim `path` when its holder is verifiably gone, through the takeover above, and
 *  take nothing: for a claim nobody will come back for. → whether it was removed. A claim whose
 *  holder is alive, unknown or unreadable, or that cannot be taken over (cannotBeTakenOver), is
 *  left as it is. Throws what a takeover throws. */
export function removeGoneClaim(path, opts) {
  const holder = readClaim(path);
  if (!holder || holder.unreadable || cannotBeTakenOver(holder, 0)) return false;
  if (processLiveness(holder).state !== "gone") return false;
  takeOver(path, holder, opts, 0, []);
  return readClaim(path)?.nonce !== holder.nonce;
}
