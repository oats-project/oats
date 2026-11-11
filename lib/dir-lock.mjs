/**
 * The lock for short read-modify-write sections over files several oats
 * processes share (the host schedule state, the server registry, this
 * computer's deployments list, a deployment's oats-local.yaml).
 *
 * It is a claim (lib/claim.mjs): one file at the lock's path that names its
 * holder by pid and process start. One process holds it at a time. A lock
 * whose holder is verifiably gone (killed, exited, its pid reused by another
 * process) is taken over by the next acquirer; one whose holder lives, or
 * cannot be judged, never is.
 *
 * A SIGINT or SIGTERM that arrives while a section runs waits for it: the
 * section completes, the lock is released, and then the signal is raised
 * again, so it ends the process as it would have (holdSignals).
 *
 * A holder that keeps the lock across asynchronous work (the machine's resume
 * sweep, lib/session-resume.mjs) takes it with acquireDirLock and releases it
 * itself. No signal is held back for it: a holder a signal ends leaves its
 * lock, and the next acquirer takes it over.
 */

import { lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { acquireClaim, claimUnheld, releaseClaim, shownHolder } from "./claim.mjs";

const isDirectory = (path) => { try { return lstatSync(path).isDirectory(); } catch { return false; } };

/** The claim's refusals (lib/claim.mjs) for the lock `path`, each made with the caller's
 *  `busy(why, { found })`: `why` is a clause that says what was found, for the caller's own
 *  sentence, which names `path` as what to remove; `found` is one word for it:
 *    running               a holder that lives
 *    unknown               a holder whose liveness cannot be established
 *    own-start-unreadable  this process's own start cannot be read, so it could not hold the lock
 *    directory             a directory at `path`, the lock of an earlier kernel
 *    unreadable            a record that does not parse
 *    cannot-take-over      a gone holder's record that cannot be taken over
 *    held-again            a lock found without a live holder and taken again, every time
 *  `at` is the file a refusal is about: `path`, or the claim of a takeover of it
 *  (`<path>.reclaim-<nonce>`), which is then named in full. A holder is named as shownHolder
 *  allows: text of a record is never part of `why`. */
function refusals(path, busy) {
  const pid = (holder) => shownHolder(holder).pid ?? "?";
  const held = (at) => (at === path ? "it" : `${at}, the claim of a takeover of it`);
  return {
    busy: (holder, unknown, at) => (unknown
      ? busy(`whether pid ${pid(holder)}, which holds ${held(at)}, still runs cannot be established: ${unknown}`, { found: "unknown" })
      : busy(`pid ${pid(holder)} holds ${held(at)}`, { found: "running" })),
    ownStartUnreadable: (reason) => busy(`this process's own start time cannot be read (${reason}), so it cannot hold the lock verifiably`, { found: "own-start-unreadable" }),
    // A directory is the lock of a kernel that locked with one. It is never removed here and its
    // owner is never judged: while that kernel runs it holds the directory, which excludes this
    // one; once it is gone the operator removes the directory, as the caller's sentence says.
    unreadableClaim: (at) => (isDirectory(at)
      ? busy(`${at} is a lock directory written by an earlier kernel`, { found: "directory" })
      : busy(`the record at ${at} is unreadable`, { found: "unreadable" })),
    cannotTakeOver: (holder, at, why) => busy(`the holder of ${at}, pid ${pid(holder)}, is gone, and that file cannot be taken over (${why}); it must be removed`, { found: "cannot-take-over" }),
    heldAgain: (holder, at, times) => busy(`${at} was found without a live holder ${times} times and was taken again each time, the last time by a process that is gone; retry`, { found: "held-again" }),
  };
}

/** What stops the lock `path` from being taken, read and not taken → `{ why, found }` as an
 *  acquirer's `busy` is handed them (refusals), or null when nobody holds it: no lock is there, or
 *  its holder is gone and the next acquirer takes it over. A lock that cannot be read for a reason
 *  of the system's is `unreadable`. Nothing is written, removed or waited for. `holderGone` as
 *  acquireDirLock takes it. */
export function dirLockHeld(path, { holderGone } = {}) {
  const found = refusals(path, (why, { found }) => ({ why, found }));
  try { claimUnheld(path, { holderGone, ...found }, found.unreadableClaim(path)); }
  catch (held) {
    if (typeof held?.found === "string") return held;
    throw held;
  }
  return null;
}

/** What to do about a lock `path` that needs a person, by what was found (`found`: refusals), said
 *  to whoever ran `command` (`oats session resume`), the one command that takes the lock. A
 *  directory is the lock of a kernel that locked with one: nothing here tells whether that kernel's
 *  command runs, so it is the operator who removes it. A record that cannot be read, or whose
 *  holder cannot be told to run, is removed once a person has seen that no `command` runs. A gone
 *  holder's record is removed without that. Where nothing is in the way (the lock was taken again
 *  each time, or this process cannot read its own start) there is nothing to remove. */
const STUCK_REMEDY = {
  directory: (path) => `once no earlier oats is running on this machine, remove the directory ${path} and run it again`,
  "cannot-take-over": (path) => `remove ${path} and run it again`,
  "held-again": () => "run it again",
  "own-start-unreadable": (path) => `run it again; nothing at ${path} is to be removed`,
};
export function stuckLockRemedy(path, found, command) {
  return STUCK_REMEDY[found]?.(path) ?? `if no ${command} is running on this machine, remove ${path} and run it again`;
}

/** The signals a section is not cut short by. */
const HELD_SIGNALS = ["SIGINT", "SIGTERM"];
let sections = 0, listening = false, idle = null;
function stopListening() {
  if (idle) { clearImmediate(idle); idle = null; }
  if (!listening) return;
  listening = false;
  for (const signal of HELD_SIGNALS) process.off(signal, onHeldSignal);
}
/** A section is synchronous, so a signal that arrived during one reaches this listener after it,
 *  the lock released. The signal is raised again without this listener: it ends the process by its
 *  default action when nothing else listens for it, and reaches the listeners that do otherwise. */
function onHeldSignal(signal) {
  stopListening();
  process.kill(process.pid, signal);
}
/** Listen for HELD_SIGNALS while a section runs: a listener keeps a signal's default action from
 *  ending the process inside it. → the function to call when the section is over. The listeners
 *  stay until the event loop has turned once with no section running, which is when a signal that
 *  arrived during the section is delivered; taking them off at the section's end would drop it. */
function holdSignals() {
  sections += 1;
  if (idle) { clearImmediate(idle); idle = null; }
  if (!listening) { listening = true; for (const signal of HELD_SIGNALS) process.on(signal, onHeldSignal); }
  return () => { if (--sections === 0) idle = setImmediate(stopListening); };
}

/** Take the lock `path` → the function that releases it, only while the lock still names this
 *  holding. `facts` is what the lock's record says besides its holder.
 *
 *  A holder that lives is waited for up to `retryMs`, then refused with `busy(why, { found })`,
 *  the caller's own error (`found`: refusals). Refused the same way, without waiting, and left as it is:
 *  a holder whose liveness cannot be read, a record that does not parse, a directory at `path`
 *  (the lock of an earlier kernel) and a gone holder's record that cannot be taken over. A lock
 *  whose holder is gone is taken over, so a process killed while it holds the lock stops nobody;
 *  `holderGone(holder)` is the caller's own reading of a record that says so (lib/claim.mjs).
 *
 *  A failure of the system's to make the lock (its directory, its file) is thrown as the system's
 *  own error, for the caller to answer in its own words. */
export function acquireDirLock(path, facts, { retryMs = 0, busy, holderGone } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  let me;
  try { me = acquireClaim(path, { waitMs: retryMs, facts, holderGone, ...refusals(path, busy) }); }
  catch (e) {
    // acquireClaim answers an error that is not the kernel's as E_LIFECYCLE_FAILED, holding it as `cause`.
    throw e?.code === "E_LIFECYCLE_FAILED" && Object.hasOwn(e, "cause") ? e.cause : e;
  }
  return () => releaseClaim(path, me);
}

/** Run `fn` holding the lock `path` (acquireDirLock: how it is taken, and its refusals) → what
 *  `fn` returns; an error `fn` throws propagates once the lock is released. `what` says in the
 *  lock's record what the holder is doing. A SIGINT or SIGTERM during `fn` ends the process only
 *  once `fn` has returned and the lock is released (holdSignals). */
export function withDirLock(path, what, fn, { retryMs = 0, busy } = {}) {
  const release = acquireDirLock(path, { what }, { retryMs, busy });
  const sectionOver = holdSignals();
  try { return fn(); }
  finally { release(); sectionOver(); }
}
