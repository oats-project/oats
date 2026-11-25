// stop, which archives the thread it stopped (contract r24, A15(1)), and the retire
// hook's archive (contract item 3) and its delete of the home's bb environment (contract
// r32, A17).
import { isAbsolute } from "node:path";
import { bbClient } from "./bb.mjs";
import { ProviderError, bounded, fail, isObject, recode, someOf } from "./errors.mjs";
import { archivedOf, confirmStop, relistOf, stopArchived } from "./halt.mjs";
import { processLook } from "./processes.mjs";
import { loopbackOrigin } from "./settings.mjs";
import { clearHomeProjectEnv } from "./project-env.mjs";
import { RecordError, readRecord, removeRecord } from "./record.mjs";
import { isBbId, isLive, liveInHome, readEndpoint, samePath } from "./threads.mjs";

// The kernel gives a stop call 20 s plus its graceSeconds (1 to 300): the wait for bb to
// settle is the grace, and the calls around it stay inside the 20 s.
const MAX_GRACE_SECONDS = 300;
const DEFAULT_GRACE_SECONDS = 10;
const ISO_UTC = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,9})?Z$/;

// The kernel's word, in the stop input's `reason`, for a stop made by the host's shutdown
// (`oats host run`), which a resume undoes. Exactly this: any other value, and none, is a
// stop that stays.
const HOST_STOP = "host";

// How often a stop with the host looks for the harness to have left the home.
const HARNESS_POLL_MS = 300;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const failed = (error) => recode("E_SESSION_STOP_FAILED", error);

/** The time the kernel's receipt says a launch was sent, in milliseconds, or NaN. Only
 *  the form the kernel writes (toISOString) is a time here, and only a time that exists:
 *  Date.parse alone reads "1" or "May 5" as an old date, and turns 29 February of a common
 *  year into 1 March. Anything else archives nothing. */
export function launchSentOf(value) {
  const match = typeof value === "string" ? ISO_UTC.exec(value) : null;
  if (match === null) return NaN;
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 19) === match[1] ? at : NaN;
}

/** What a stop says when bb did not archive a thread it stopped: one line on the
 *  command's stderr. The wire's stop result is exactly `{ stopped: true }` and its envelope
 *  takes no other key (the kernel reads another key as a failed stop), so the warning has
 *  no place in the answer; the next start names the thread (lib/launch.mjs). */
const warnOnStderr = (message) => { process.stderr.write(`oats bb: warning: ${bounded(message)}\n`); };

/** Archive a thread whose stop is confirmed (contract r24, A15(1)): bb starts a stopped
 *  thread's agent again at the next message to it (bb's composer, `bb thread tell`), and
 *  refuses every message to an archived one. → null, or what to say where bb did not
 *  archive it: the thread is stopped all the same, so that never fails the stop. A thread
 *  bb no longer has, or had archived already, is as good as archived.
 *  What to say is one line, the thread and the remedy before bb's own words: those may be
 *  long, or several lines, and a cut must fall in them. */
async function archiveStopped(bb, threadId) {
  const answer = await bb.archive(threadId);
  if (answer.ok || answer.code === "thread_not_found") return null;
  return `bb thread ${threadId} is stopped, and bb did not archive it: a message to it in bb starts its agent again. Archive it in bb (bb thread archive ${threadId}). bb said: ${String(answer.message).replace(/\s+/g, " ").trim()}`;
}

/** The stop's archive, for a thread confirmStop has just seen settled: ask bb to archive
 *  it, then stop and confirm it once more, by the one rule (confirmStop stops an archived
 *  thread like any other). A message typed in bb between that last look and the archive
 *  starts a turn, or is held in line, and nothing reads an archived thread afterwards: so
 *  a stop never answers "stopped" from a look that came before its archive. Whatever bb
 *  answered to the archive: one cut off by time may have been made all the same. Only a
 *  thread bb no longer has is left alone. → archiveStopped's answer. */
async function archiveAndConfirm(bb, threadId, options) {
  const refused = await archiveStopped(bb, threadId);
  await confirmStop(bb, threadId, options);
  return refused;
}

/** After a stop with the host, whose thread stays live: wait until the thread's harness
 *  has left the home. bb shows a thread settled a moment before its harness process is
 *  gone, and the kernel reads `running` of such a home from that process (lib/threads.mjs):
 *  an inspect made in that moment would read a home stopped with the host as one that came
 *  back. Within the stop's grace, counted from here. → null, or what to say where the
 *  harness is still there at its end (the stop is bb's, and it is confirmed: the answer
 *  stays "stopped"). Where the processes cannot be looked at, nothing is waited for. */
async function harnessLeft(bb, threadId, home, { deadline, grace, now }) {
  if (typeof home !== "string" || !isAbsolute(home)) return null;
  const thread = await bb.thread(threadId);
  if (thread === null || thread.deletedAt) return null;
  const from = now(), until = Math.min(from + grace * 1000, deadline);
  for (;;) {
    let runs;
    // A look of its own each time: what it reads is the processes as they are now.
    try { runs = processLook().runsIn(thread, home); }
    catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      return null;
    }
    if (runs !== true) return null;
    if (now() + HARNESS_POLL_MS >= until) return `bb thread ${threadId} is stopped, and its agent process still works in ${home} ${Math.round((now() - from) / 1000)} s later: until it has left, the home reads as running`;
    await sleep(HARNESS_POLL_MS);
  }
}

/** → { stopped: true } once nothing of the thread can run: bb acknowledged the stop, shows
 *  the thread settled (idle, pending or error) or gone, and holds nothing in line for it
 *  (lib/halt.mjs). E_SESSION_STOP_FAILED otherwise, after the grace.
 *
 *  A stopped thread is then archived (contract r24, A15(1)): an instance OATS stopped
 *  stays stopped from bb's side too. Its conversation stays in bb, readable, as an
 *  archived thread (`bb thread list --archived --project <id>`), and a start is a new
 *  thread. An archive bb refuses does not fail the stop: `stopped: true`, and a warning
 *  (`warn`) that names the thread.
 *
 *  One stop is not archived (contract r25, A16): a stop with the host (`reason: "host"`, the kernel's word for
 *  `oats host run`'s shutdown). Such a home is lost, not stopped: the kernel brings it
 *  back by an input to this same thread, which bb would refuse of an archived one. A
 *  kernel that does not send the key gets the archive, as for any stop. Such a stop also
 *  waits for the thread's harness to have left the home (harnessLeft).
 *
 *  With no endpoint (the kernel compensating a launch whose answer was lost): stop
 *  whatever live thread runs in the home, archive those made since `launchSent`, and stop
 *  the home's archived threads; `stopped: true` also when there is none. */
export async function stop(input, settings, { deadline = Infinity, env = process.env, now = Date.now, stopCallTimeoutMs, warn = warnOnStderr } = {}) {
  try {
    if (!isObject(input)) throw fail("E_SESSION_STOP_FAILED", "the stop input is not an object");
    const options = { deadline, grace: graceOf(input), now, stopCallTimeoutMs };
    if (input.endpoint === null || input.endpoint === undefined) {
      if (typeof input.home !== "string" || !isAbsolute(input.home)) throw fail("E_SESSION_STOP_FAILED", "a stop with no endpoint needs the home's absolute path");
      const bb = bbClient({ cli: settings.cli, hostDaemonPort: settings.hostDaemonPort, server: loopbackOrigin(settings.server, "server"), deadline, env, fallbackCode: "E_SESSION_STOP_FAILED" });
      const { projects, live } = await liveInHome(bb, input.home);
      // The home's archived threads too: bb keeps an archived thread's Claude loaded, in
      // the home. All of them: this call is told no thread to count from. Read before
      // anything is changed.
      const archived = await archivedOf(bb, projects.map((project) => project.id));
      // Which of the home's live threads are the provider's own, with no endpoint to say:
      // only a thread made at or after the time the kernel says the failed launch was sent
      // is that launch's, and nobody recorded it. It is archived once stopped, as every
      // thread the provider stops is, so no message in bb starts it again and the next
      // start is not refused for it. An older thread, or any thread when the time is
      // absent or unreadable, may be one a person opened in the home's bb project for
      // other work: stopped, never archived.
      const sentAt = launchSentOf(input.launchSent);
      const unarchived = [];
      for (const thread of live) {
        const seen = await confirmStop(bb, thread.id, options);
        if (seen === "gone" || !(Number.isFinite(sentAt) && typeof thread.createdAt === "number" && thread.createdAt >= sentAt)) continue;
        // Where bb does not archive it, the thread is still stopped: a warning, and the
        // next launch names it.
        const refused = await archiveAndConfirm(bb, thread.id, options);
        if (refused !== null) unarchived.push(refused);
      }
      await stopArchived(bb, archived, relistOf(bb, projects.map((project) => project.id)), options);
      for (const refused of unarchived) warn(refused);
      return { stopped: true };
    }
    const endpoint = readEndpoint(input.endpoint, "E_SESSION_STOP_FAILED");
    const bb = bbClient({ cli: settings.cli, hostDaemonPort: settings.hostDaemonPort, server: endpoint.server, deadline, env, fallbackCode: "E_SESSION_STOP_FAILED" });
    // By its id, whatever bb shows of it: a thread archived in bb is stopped like any other.
    const seen = await confirmStop(bb, endpoint.threadId, options);
    // Only once it is seen stopped: bb keeps an archived thread's agent loaded until the
    // thread is stopped, and shows nothing that says so. (A thread bb no longer has is
    // not asked for; nor is the thread of a home stopped with the host, which the kernel
    // resumes by an input to it.)
    if (seen === "gone") return { stopped: true };
    const refused = input.reason === HOST_STOP ? await harnessLeft(bb, endpoint.threadId, input.home, options) : await archiveAndConfirm(bb, endpoint.threadId, options);
    if (refused !== null) warn(refused);
    return { stopped: true };
  } catch (error) { throw failed(error); }
}

/** The seconds to wait for bb to settle after `bb thread stop`. */
export function graceOf(input) {
  return isObject(input) && Number.isFinite(input.graceSeconds) && input.graceSeconds >= 0 ? Math.min(input.graceSeconds, MAX_GRACE_SECONDS) : DEFAULT_GRACE_SECONDS;
}


// How long the hook waits for one thread to settle: it runs after the kernel's own stop.
const RETIRE_GRACE_SECONDS = 5;

// The one kind of bb environment a retire deletes (contract r32, A17(1)(a)): a local
// directory bb did not make and does not manage, which is what a home is. bb's own words
// at 0.50.1 (`bb environment show`). For this kind bb's delete touches nothing on disk;
// a worktree or a remote environment is another matter, and is archived only.
const LOCAL_PATH_PROVIDER = "project-checkout";

// What a retire that deleted no environment leaves possible, said once in its warning.
const ARCHIVED_ONLY = "its threads are archived only: if the home is kept, a person can unarchive one in bb and a message then starts its agent with no OATS around it";

/** Why the record does not vouch for the home's threads, in a warning's words. */
function recordGap(record) {
  if (record.state === "missing" || record.state === "mismatch") return "this home has no thread record of the provider's (a home spawned before oats.bb kept one gets none)";
  return `this home's thread record is ${record.state} (${record.why})`;
}

/** The retire's last step (contract r32, A17(1)): delete the home's bb environment, so
 *  that a message to one of its threads, even once a person unarchived it, is refused and
 *  starts nothing in a home that was kept. bb keeps ONE environment per home, shared by
 *  every thread that runs there, a person's own included, and its delete takes it from
 *  all of them. So it is asked only where all of this holds:
 *  - every thread of the home was stopped and archived by this hook's rule, and the home's
 *    archived threads were listed (`rows`);
 *  - the environment is there, is the home's directory, and is of the local-path kind;
 *  - bb's list of the threads on it was read whole, and EVERY thread on it is archived and
 *    is in the home's record: one this provider made for this home.
 *  Anything else leaves the threads archived only, and `why` says so (the hook's warning).
 *  The rule of the warning: it is given whenever a thread of the home is left without a
 *  deleted environment, since with the home kept that thread can be started from bb. So
 *  also for a thread that has no environment yet (bb makes one when a thread's first turn
 *  starts: a home retired before that has nothing to delete), and for a delete bb did
 *  not do. `mine(id)`: whether a thread of the home's bb project is this home's own.
 *
 *  It never waits for bb's teardown (bb answers the delete at once and finishes within
 *  seconds), and never throws for bb's sake: a delete that bb refuses, that does not
 *  answer, or that meets a bb that is down is said on stderr (`note`), with bb's own
 *  words and the command to run, and the retire goes on.
 *
 *  `decided`: whether the question was answered: deleted, or a no that rests on what was
 *  read (the kind, the record, a thread that is not the home's own). False where a read
 *  of bb or a call to it failed, a thread would not stop, or bb did not do the delete: a
 *  retire run again may then still delete, so the caller keeps the record.
 *  → { deleted: [environment ids], why: [text], decided }. */
async function deleteHomeEnvironments(bb, home, { rows, record, allStopped, mine, note }) {
  const deleted = [], why = [];
  // A thread that would not stop is on no archived row, so its environment may never be
  // looked at below: nothing is decided while one is left, whatever the rows show.
  let decided = allStopped;
  if (rows === null) return { deleted, why: ["the home's archived bb threads could not be listed"], decided: false };
  const bare = rows.filter((row) => mine(row.id) && !isBbId(row.environmentId)).map((row) => row.id);
  if (bare.length > 0) why.push(`${bare.length} thread${bare.length > 1 ? "s" : ""} of this home ${bare.length > 1 ? "have" : "has"} no bb environment to delete yet (bb makes one when a thread's first turn starts): ${someOf(bare, 3)}`);
  // The environments the home's threads are on. (A thread row names its environment.)
  const ids = [...new Set(rows.map((row) => row.environmentId).filter((id) => isBbId(id)))];
  for (const id of ids) {
    let environment;
    try { environment = await bb.environment(id); }
    catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      why.push(`bb environment ${id} could not be read (${error.code})`);
      decided = false;
      continue;
    }
    // Gone, or destroyed already (an earlier run of this hook; a person): nothing to delete.
    if (environment === null || environment.status === "destroyed") continue;
    // Not this home's directory: never deleted. Where a thread of the home's own is on it
    // (one moved to another directory, a worktree), that thread keeps an environment, and
    // the warning says so; a person's thread of the home's project that runs elsewhere is
    // not this home's to speak of.
    if (!samePath(environment.path, home)) {
      const here = rows.filter((row) => row.environmentId === id && mine(row.id)).map((row) => row.id);
      if (here.length > 0) why.push(`${here.length} thread${here.length > 1 ? "s" : ""} of this home ${here.length > 1 ? "are" : "is"} on bb environment ${id}, which is not the home's directory and is never deleted: ${someOf(here, 3)}`);
      continue;
    }
    if (environment.environmentProviderId !== LOCAL_PATH_PROVIDER || environment.managed !== false) { why.push(`bb environment ${id} is not a local directory bb leaves alone (it is ${environment.environmentProviderId}${environment.managed ? ", managed by bb" : ""})`); continue; }
    if (!allStopped) { why.push("not every bb thread of this home was stopped and archived"); decided = false; continue; }
    if (record.state !== "ok") { why.push(recordGap(record)); continue; }
    let threads;
    try { threads = await bb.threadsOn(id); }
    catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      why.push(`bb's list of the threads on environment ${id} could not be read (${error.code})`);
      decided = false;
      continue;
    }
    // Whole, by what the hook itself knows: every thread of the home's project that it
    // saw on this environment must be in bb's list of it. One that is not means the list
    // is short (a bb that filters or pages it), and "every thread on it" would rest on less.
    const listedHere = new Set(threads.map((thread) => thread.id));
    if (rows.some((row) => row.environmentId === id && !listedHere.has(row.id))) { why.push(`bb's list of the threads on environment ${id} is not whole (it lacks a thread of this home's bb project that is on it)`); decided = false; continue; }
    const others = threads.filter((thread) => !record.ids.has(thread.id));
    if (others.length > 0) { why.push(`${others.length} thread${others.length > 1 ? "s" : ""} on bb environment ${id} ${others.length > 1 ? "are" : "is"} not in this home's thread record (a person's, one made before oats.bb kept a record, or one the provider could not note): ${someOf(others.map((thread) => thread.id), 3)}`); continue; }
    if (threads.some(isLive)) { why.push(`a thread on bb environment ${id} is not archived`); decided = false; continue; }
    const answer = await bb.environmentDelete(id);
    if (answer.ok) { deleted.push(id); continue; }
    // bb's own words go to stderr, with the remedy before them (they may be long: a cut
    // must fall in them); the warning says only that it was not done, and what to run.
    decided = false;
    why.push(`bb was asked to delete bb environment ${id} and did not: delete it in bb (bb environment delete ${id})`);
    note(`bb did not delete environment ${id} of this home: ${ARCHIVED_ONLY}. Delete it in bb (bb environment delete ${id}). bb said: ${String(answer.message).replace(/\s+/g, " ").trim()}`);
  }
  return { deleted, why: [...new Set(why)], decided };
}

/** The retire hook: stop and archive every live thread that runs in the home, after the
 *  kernel's stop, and stop the home's threads that were archived before. → the hook's
 *  final JSON line: the provider's own receipt of what bb holds of the home when the hook
 *  ends.
 *  - `archived`: every thread of the home that is archived in bb then: those this hook
 *    archived, then those it found archived already (by the stop inside the retire, which
 *    archives the home's thread; by a person; by an earlier start), in bb's order. Where
 *    the home's archived threads could not be listed, only those this hook archived.
 *    Where the provider's record of the home's threads is there and is this home's
 *    (lib/record.mjs), those it found archived already are only the ones in it: a home
 *    made at a path an earlier home had does not report that home's threads.
 *  - `environments`: the bb environments it asked bb to delete, where it did (below).
 *  - `retired: true`: bb has at least one thread of the home, live or archived, and none
 *    is left live (or the env of its project was removed).
 *  - `{retired: false, reason: "nothing-to-delete"}`: bb has no thread of the home at all
 *    (a home that never ran on bb), and no env was removed.
 *
 *  It is safe to run twice and after a spawn that never launched (nothing to archive is
 *  a complete cleanup). A thread is archived only once its stop is
 *  confirmed. A bb that does not answer does not hold the retire: what is left is said in
 *  a warning, and readiness reports it (`session-provider-orphaned`) once the home is gone.
 *
 *  Last, it deletes the home's bb environment where every thread on it is the provider's
 *  own for this home (deleteHomeEnvironments; contract r32, A17), and removes the home's
 *  record, which has then answered the one question it is kept for. Where bb could not be
 *  asked, could not be read on the way, or did not do the delete, the record stays:
 *  nothing was decided, and a retire run again decides. */
export async function retire(home, readSettings, { deadline, env = process.env, note = warnOnStderr } = {}) {
  // The hook runs for every home that has the capability, and is not told the home's
  // backend; nothing in the home says it either (the home is its agent's to write, and
  // the provider keeps nothing of its own there). So bb is asked for every home, and where
  // it cannot be asked the hook warns, whatever the home: it never fails or holds a retire.
  // Threads left that way are what readiness reports as orphaned.
  try {
    const settings = readSettings();
    const bb = bbClient({ cli: settings.cli, hostDaemonPort: settings.hostDaemonPort, server: loopbackOrigin(settings.server, "server"), deadline, env });
    const { projects, live } = await liveInHome(bb, home);
    const options = { deadline, grace: RETIRE_GRACE_SECONDS };
    // What this hook archived, and what it could not stop or archive.
    const archived = [], left = [];
    for (const thread of live) {
      // Nothing waiting to run and no process left behind, confirmed, before the archive:
      // bb keeps an archived thread's Claude loaded, in the home, unless it was stopped.
      try { await confirmStop(bb, thread.id, options); }
      catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        left.push(thread.id);
        continue;
      }
      ((await archiveStopped(bb, thread.id)) === null ? archived : left).push(thread.id);
    }
    // The home's threads archived before now (in bb's UI, or by an earlier start) may
    // hold a process too: all are stopped. The hook is told no thread to count from.
    // Read after this hook's own archives: the listing holds them too, and it is what
    // the receipt's `archived` is told from (one read for the sweep and for the receipt).
    let unswept = null, listed = null;
    try {
      const ids = projects.map((project) => project.id);
      listed = await archivedOf(bb, ids);
      await stopArchived(bb, listed, relistOf(bb, ids), options);
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      // The sweep's own account (how many, the remedy) is carried; bb's raw words are not.
      unswept = error.code === "E_SESSION_STOP_FAILED" ? error.message : `bb could not be asked (${error.code}): an agent process of one may still be loaded; look at them in bb (bb thread list --project <id> --archived)`;
    }
    // What a pi launch wrote into the env of the home's bb project goes with the home: the
    // project stays in bb (its archived threads are its history), its env does not.
    const projectEnv = await clearHomeProjectEnv(home, null, { bb, projects });
    const warnings = [];
    // The sweep's own words first: they begin with the count and the remedy, and the cut
    // to what the kernel relays then falls in a list of ids.
    if (unswept !== null) warnings.push(`the home's archived bb threads could not all be stopped: ${unswept}`);
    if (left.length > 0) warnings.push(`${left.length} bb thread${left.length > 1 ? "s" : ""} of this home could not be stopped and archived: stop and archive ${left.length > 1 ? "them" : "it"} in bb (bb thread stop <id>, bb thread archive <id>). ${left.length > 1 ? "They are" : "It is"} ${someOf(left)}`);
    if (projectEnv.warning !== null) warnings.push(projectEnv.warning);
    // Last, the home's bb environment (contract r32, A17): deleted where every thread on
    // it is in the provider's record of this home's threads, and only then. Once that is
    // decided, yes or no, the record has answered its one question, and goes. Where it
    // is not (bb could not be read, or did not do it), the record stays for a retire run again.
    const record = readRecord(home, { env });
    // Which threads of the home's bb project are this home's: those in its record, where
    // it has one that vouches for them, and those this hook archived; with no such record,
    // every one. (A home made at a path an earlier home had shares that home's bb project.)
    const ofThisHome = record.state === "ok" ? (id) => record.ids.has(id) || archived.includes(id) : () => true;
    const environments = await deleteHomeEnvironments(bb, home, { rows: listed, record, allStopped: left.length === 0 && unswept === null, mine: ofThisHome, note });
    try { if (environments.decided) removeRecord(record); }
    catch (error) {
      if (!(error instanceof RecordError)) throw error;
      note(`${error.message}: it holds thread ids only, and the next home at this path replaces it (${record.file})`);
    }
    if (environments.why.length > 0) warnings.push(`the home's bb environment was not deleted (${environments.why.join("; ")}): ${ARCHIVED_ONLY}`);
    const gone = environments.deleted.length > 0 ? { environments: environments.deleted } : {};
    // Every thread of the home that is archived in bb now: this hook's own first, then
    // the ones it found archived already. (Where the listing could not be read, its own.)
    // Where the home's record vouches for its threads, only those (ofThisHome, above).
    const inBb = [...archived, ...(listed ?? []).map((thread) => thread.id).filter((id) => !archived.includes(id) && !left.includes(id) && ofThisHome(id))];
    if (warnings.length > 0) return { meta: { archived: inBb, ...(left.length > 0 ? { left } : {}), ...(unswept !== null ? { unswept: true } : {}), ...(projectEnv.removed.length > 0 ? { env: projectEnv.removed.length } : {}), ...gone }, warning: bounded(warnings.join(". ")) };
    // bb has no thread of this home at all, live or archived, and held no env for it.
    // (With no warning every live thread was archived, and is in the list: none in it, none live.)
    if (inBb.length === 0 && projectEnv.removed.length === 0 && environments.deleted.length === 0) return { meta: { retired: false, reason: "nothing-to-delete" } };
    return { meta: { retired: true, archived: inBb, ...(projectEnv.removed.length > 0 ? { env: projectEnv.removed.length } : {}), ...gone } };
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    // Why, in the provider's own words (they may carry bb's), cut short: the remedy stands before it.
    return { meta: { archived: [], unchecked: true }, warning: `the home's bb threads were not archived: oats readiness reports them as session-provider-orphaned once bb answers; stop and archive them in bb. Why bb could not be asked: ${bounded(error.message).slice(0, 260)}` };
  }
}
