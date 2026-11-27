// Stopping a bb thread so that nothing of it can run: the one rule every path uses (the
// stop verb, the stop with no endpoint, the retire hook, a launch's cleanup).
//
// Two things bb does make "bb thread stop answered ok" too little:
// - bb's concurrency limit holds a turn in the thread's queue (the thread stays `pending`),
//   `bb thread stop` leaves it there, and bb starts it by itself when a slot frees;
// - bb keeps the Claude process of an archived thread loaded, in the home, until the
//   thread is stopped, and shows nothing that tells such a thread from one without.
import { fail, someOf } from "./errors.mjs";
import { hasQueuedWork, isSettled } from "./threads.mjs";

const POLL_MS = 300;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Take out of bb's line every message it holds for the thread. A delete bb answers with
 *  "not found" may mean bb has just started that message as a turn: the caller looks at
 *  the thread again. → how many were there. */
async function withdraw(bb, threadId) {
  const held = await bb.queue(threadId);
  for (const message of held) await bb.queueDelete(threadId, message.id);
  return held.length;
}

/** Stop one thread and confirm it: returns once bb has acknowledged a stop (or has no
 *  such thread), shows the thread settled, holds nothing in line for it, and shows it
 *  settled again after that last look at its queue. → "settled", or "gone" where bb has
 *  no such thread any more (missing or deleted): nothing is left of it to archive. Anything else by the end of the grace
 *  (or the command's deadline) throws E_SESSION_STOP_FAILED, saying what is still there.
 *
 *  The order matters. A message found in line after the thread settled is withdrawn, but
 *  bb may have started it as a turn in the same instant (the delete then says "not found"
 *  and the queue reads empty): so after every withdrawal the thread is stopped and looked
 *  at again, and "stopped" is never taken from a look that came before the queue's.
 *
 *  `grace` (seconds) is counted from the first stop bb was asked for: finding the thread
 *  takes none of it. `refusal(answer, args)` is the client's way to say bb's own no. */
export async function confirmStop(bb, threadId, { deadline = Infinity, grace, now = Date.now, stopCallTimeoutMs } = {}) {
  let until = null, acknowledged = false, last = "not settled";
  for (;;) {
    // What waits in line first, so that nothing starts while the thread is being stopped.
    await withdraw(bb, threadId);
    const asked = await bb.stop(threadId, stopCallTimeoutMs === undefined ? {} : { timeoutMs: stopCallTimeoutMs });
    if (!asked.ok && asked.code === "thread_not_found") return "gone";
    // bb's stop may wait for the thread to settle, longer than one bb call gets here: a
    // stop cut off by time has still been asked, and it is asked again once the thread is
    // settled, when it answers at once. Any other failure is bb's no.
    if (!asked.ok && !asked.timedOut) throw bb.refusal(asked, ["thread", "stop"]);
    if (asked.ok) acknowledged = true;
    if (until === null) until = Math.min(now() + grace * 1000, deadline);
    for (;;) {
      const thread = await bb.thread(threadId);
      if (thread === null || thread.deletedAt) return "gone";
      if (isSettled(thread)) {
        const inLine = await bb.queue(threadId);
        if (inLine.length > 0) { last = `${thread.status}, with ${inLine.length} message${inLine.length > 1 ? "s" : ""} bb still holds in line for it`; break; } // withdraw, stop and look again
        if (!acknowledged) { last = `${thread.status}, and bb has not acknowledged a stop`; break; }
        // The queue was empty AFTER the thread was seen settled; one more look tells
        // whether a turn started in between.
        const again = await bb.thread(threadId);
        if (again === null || again.deletedAt) return "gone";
        if (isSettled(again)) return "settled";
        last = again.status;
      } else last = thread.status;
      if (now() + POLL_MS >= until) throw fail("E_SESSION_STOP_FAILED", `bb thread ${threadId} is still ${last} ${grace} s after bb thread stop`);
      await sleep(POLL_MS);
    }
    if (now() >= until) throw fail("E_SESSION_STOP_FAILED", `bb thread ${threadId} is ${last}, ${grace} s after bb thread stop: a turn bb holds in line starts by itself when bb has a free slot. Look at it in bb (bb thread queue list ${threadId}), then stop again`);
  }
}

/** The archived, undeleted threads of the projects given (the home's): what a sweep
 *  stops. `since` (milliseconds, or null): only those archived at or after it. A read
 *  only, so a caller can make it before it changes anything. */
export async function archivedOf(bb, projectIds, { since = null } = {}) {
  const found = [];
  for (const projectId of projectIds) {
    for (const thread of await bb.archivedThreads(projectId)) {
      if (thread.deletedAt) continue;
      if (since !== null && typeof thread.archivedAt === "number" && thread.archivedAt < since) continue;
      found.push(thread);
    }
  }
  return found;
}

/** How the threads of those projects read now, archived and live: for stopArchived. */
export const relistOf = (bb, projectIds) => async () => {
  const rows = [];
  for (const projectId of projectIds) rows.push(...await bb.archivedThreads(projectId));
  rows.push(...await bb.threads());
  return rows;
};

// How many acknowledgement stops of archived threads run at once. A home's archived
// threads only grow (every start archives one, and a new home at the same path inherits
// them), and the sweep starts over at every call. Most of a bb call's cost is the CLI's own
// start, which is processor time: several at once fit about twice as many threads in a
// stop's time on two processors, up to four times on eight (measured at 0.50.1: 0.39 s a
// call alone, 0.23 s on two processors, 0.10 s on eight). Past that, the stop says so.
const SWEEP_AT_ONCE = 8;

/** Stop each archived thread given, so that no Claude of it is left in the home, and
 *  confirm it by what bb shows AFTER the stops, never by the rows they were found in: bb
 *  acknowledges each stop, then the lists are read once more, and every thread stopped
 *  here must show settled with nothing in line (or be gone). One that does not, or that
 *  had work in line to begin with, goes through the whole rule (confirmStop). So the rule
 *  is the same as for a live thread; only the reads are shared between the threads, and
 *  the stops run several at a time, since a home's archived threads can be many.
 *  `relist()` → the threads to look in (archived and live). Throws on the first thread
 *  that cannot be confirmed; where the command's time ran out, it says how many of how
 *  many were stopped and what to do about it. */
export async function stopArchived(bb, threads, relist, options = {}) {
  const asked = [];
  const plain = [];
  for (const thread of threads) {
    if (hasQueuedWork(thread)) await confirmStop(bb, thread.id, options);
    else plain.push(thread.id);
  }
  let next = 0, refused = null;
  const slow = [], unreached = [];
  const worker = async () => {
    while (next < plain.length && refused === null) {
      const id = plain[next];
      next += 1;
      const answer = await bb.stop(id);
      if (answer.ok) asked.push(id);
      else if (answer.code === "thread_not_found") continue;
      // Two different ends: the command's own time was up (the call was cut by it, or
      // never made), or bb did not answer one call in that call's time, with time left.
      else if (answer.timedOut) (Date.now() >= (options.deadline ?? Infinity) ? unreached : slow).push(id);
      else refused ??= bb.refusal(answer, ["thread", "stop"]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SWEEP_AT_ONCE, plain.length) }, worker));
  if (refused !== null) throw refused;
  if (unreached.length > 0) {
    // Too many for the command's time. The count and the remedy first: the kernel relays
    // 500 characters. (Stop before delete: whether bb releases a deleted thread's process
    // is not known, and a deleted thread is out of this sweep's sight.)
    const stopped = threads.length - slow.length - unreached.length;
    throw fail("E_SESSION_STOP_FAILED", `this home's bb project holds ${threads.length} archived threads, and ${slow.length + unreached.length} of them could not be stopped in the time this command has (${stopped} were): an agent process of one may still be loaded in the home. Remove old archived threads of that project in bb (bb thread list --project <id> --archived; for each, bb thread stop <id>, then bb thread delete --yes <id>), and try again`);
  }
  if (slow.length > 0) {
    throw fail("E_SESSION_STOP_FAILED", `bb did not acknowledge the stop of ${slow.length} archived thread${slow.length > 1 ? "s" : ""} of this home in time, so ${slow.length > 1 ? "their agent processes" : "its agent process"} may still be loaded there. Try again; if it repeats, look at ${slow.length > 1 ? "them" : "it"} in bb: ${someOf(slow)}`);
  }
  if (asked.length === 0) return;
  const now = await relist();
  for (const id of asked) {
    const row = now.find((thread) => thread.id === id);
    if (row === undefined || row.deletedAt) continue;
    // At rest by what bb says now, in one row: settled, and its queue said to be empty in
    // so many words. A row that does not say (no `queuedWork`) proves nothing.
    if (isSettled(row) && row.queuedWork === "none") continue;
    await confirmStop(bb, id, options);
  }
}
