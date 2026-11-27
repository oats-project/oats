// What a bb thread means for OATS: contract item 4's table, and one thread per home.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { ProviderError, fail, isObject, someOf } from "./errors.mjs";
import { loopbackOrigin } from "./settings.mjs";

// bb's thread statuses (bb packages/domain thread-status). bb has no "stopped": a stopped
// thread settles to idle, and the kernel records OATS's own stop.
const TURN_IN_PROGRESS = new Set(["starting", "active", "stopping"]);
const SETTLED = new Set(["pending", "idle"]);

// What a home with no session reads as: a thread that is gone, and a lost one.
const MISSING = Object.freeze({ present: false, state: "stopped", running: false });
// A turn bb holds in line (its concurrency limit has not started it yet) starts by itself
// when a slot frees: such a thread is busy, whatever is loaded now.
const HELD = Object.freeze({ present: true, state: "unknown", running: true });

/** `running` of a thread at rest (idle or pending with nothing that waits to start in
 *  line, a failed message included, or in error with its harness alive): whether its harness works in the home now, asked of the processes
 *  (lib/processes.mjs, `runsIn`). bb's word is the same for a thread whose agent is loaded,
 *  waiting for its next message, and for one `bb thread stop` released: only the process
 *  tells them apart, and the kernel needs it to tell a home stopped with the host from one
 *  that came back (contract r25, A16).
 *  true: the harness bb started for the thread works in the home. false: no harness of
 *  the thread does. null: it cannot be told (no /proc on this host; what started a harness
 *  in the home cannot be read), or no home was given: never a guess. And the look's own
 *  UNRECOGNISED, for a harness in the home that bb's known runner did not start: the
 *  caller settles it by bb's version (lib/inspect.mjs: false at the provider's pin, where
 *  it is one the agent itself left running; null at any other version). */
function harnessRuns(thread, processes, home) {
  if (typeof home !== "string") return null;
  try { return processes.runsIn(thread, home); }
  catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    return null;
  }
}

/** The inspect answer for one existing bb thread: only what bb shows and what this host's
 *  processes show, nothing inferred. A status word this provider does not know is an
 *  error, never a guess. `home`: the home the thread is inspected for.
 *
 *  `error` (contract r23, A13(1) and A14) is bb's word for a thread whose last turn failed, and
 *  bb says the same of one whose agent is gone. Seen at bb-app 0.50.1, for pi and for
 *  Claude alike: after a turn the model endpoint refused, the thread is `error` while its
 *  agent process is still loaded in the home, and the next tell starts a turn and brings
 *  it back to idle. Read as a lost session, the kernel would resume it beside that
 *  process, and refuses to: the home would be stuck. So which of the two it is is decided
 *  here, at every call, from the processes themselves, never from bb's word alone:
 *  `processes.has(thread)` says whether the thread's harness lives on this host: the
 *  process named pi or claude that carries the thread's id, never a command the agent left
 *  running (lib/processes.mjs).
 *  - it lives: the thread is there and at rest, and an input recovers it. `running` is
 *    then read as for any thread at rest: true where that harness works in the home
 *    (a stopped home a person started again in bb, whose turn then failed, still runs),
 *    false where it works somewhere else;
 *  - none: a lost session, as the kernel reads one, which it may resume with an input;
 *  - it cannot be told (the look throws): an error, never either of the two. */
export function inspectAnswer(thread, processes, home) {
  const status = thread.status;
  if (TURN_IN_PROGRESS.has(status)) return { present: true, state: "unknown", running: true };
  if (isSettled(thread)) {
    // A turn bb holds in line starts by itself, whatever is loaded now.
    if (willStartByItself(thread)) return { ...HELD };
    // A word for the thread's queue that this provider does not know: whether something
    // will start cannot be told, and neither "it runs" nor "it does not" is said.
    if (hasQueuedWork(thread) && !QUEUE_WORDS.has(thread.queuedWork)) return { present: true, state: "unknown", running: null };
    // (`failed`: a queued message whose dispatch failed. It does not say a turn will
    // start, so the thread reads by its harness, below. bb may still retry such a message
    // by itself, and the word hides a message that waits behind it: see QUEUE_WORDS.)
  }
  if (SETTLED.has(status)) return { present: true, state: "unknown", running: harnessRuns(thread, processes, home) };
  if (status === "error") return processes.has(thread) ? { present: true, state: "unknown", running: harnessRuns(thread, processes, home) } : { ...MISSING };
  throw fail("E_SESSION_UNAVAILABLE", `bb reports thread ${thread.id} as ${JSON.stringify(status)}, a status this provider does not know`);
}

export const isSettled = (thread) => SETTLED.has(thread.status) || thread.status === "error";
// bb's words for a thread's queue in its list row (bb-app 0.50.1's own enum, `bb guide
// json`: `queuedWork ("none" | "waiting" | "failed")`): nothing in line; a message that
// waits to start, which bb starts by itself (its concurrency limit, a busy thread); a
// queued message whose dispatch failed. `failed` wins over `waiting` in bb's row, and
// covers two states of bb's (its guide): `failed_retrying`, which bb retries by itself
// later, and `failed_exhausted`, which waits for a person. So a thread that reads
// `failed` MAY still start a turn by itself, and the row cannot tell. It is read by its
// harness all the same: taken for "it runs", a home stopped with the host whose thread
// holds only a message that will never start would be read as one that came back, and a
// false "it runs" is the dangerous answer; a false "it does not" corrects itself when bb
// starts the turn (the thread is then in a turn, or its harness is seen).
const QUEUE_WORDS = new Set(["none", "waiting", "failed"]);
/** Whether bb's list row says a turn of the thread will start by itself: a message waits
 *  in line (`queuedWork: "waiting"`). Not `failed`, which does not say so, and not a word
 *  this provider does not know. What `running` is answered from without a look at the
 *  processes: a false "it runs" here would have the kernel take a home stopped with the
 *  host, whose thread holds only a failed message, for one that came back. */
export const willStartByItself = (thread) => thread.queuedWork === "waiting";
/** Whether bb's list row says the thread has anything in line, a failed message and a
 *  word this provider does not know included (`queuedWork`, "none" when there is none):
 *  what a stop must clear and a launch must not start over (lib/halt.mjs, lib/launch.mjs). `bb thread show` does not carry the field: only a list row is asked. */
export const hasQueuedWork = (thread) => typeof thread.queuedWork === "string" && thread.queuedWork !== "none";
export const isLive = (thread) => isObject(thread) && !thread.archivedAt && !thread.deletedAt;

/** One of bb's ids (thr_…, proj_…, qmsg_…). An id is an argument to bb: it must never
 *  read as an option. */
export const isBbId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);

/** The endpoint the kernel recorded, checked: bb's own ids and a loopback server. */
export function readEndpoint(endpoint, code = "E_SESSION_UNAVAILABLE") {
  if (!isObject(endpoint)) throw fail(code, "the recorded endpoint is not an object");
  for (const key of ["server", "projectId", "threadId"]) {
    if (typeof endpoint[key] !== "string" || !endpoint[key]) throw fail(code, `the recorded endpoint has no ${key}`);
  }
  for (const key of ["projectId", "threadId"]) {
    if (!isBbId(endpoint[key])) throw fail(code, `the recorded endpoint's ${key} is not a bb id`);
  }
  return { server: loopbackOrigin(endpoint.server, "server"), projectId: endpoint.projectId, threadId: endpoint.threadId };
}

/** The same directory: the same path, or (where bb recorded the path it resolved) the
 *  same real path. Exactly the home: never a parent, never a directory inside it. */
export function samePath(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (resolve(a) === resolve(b)) return true;
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

/** The bb projects rooted at the home (a local source whose path is the home). */
export function projectsOfHome(projects, home) {
  return projects.filter((project) => isObject(project) && Array.isArray(project.sources)
    && project.sources.some((source) => isObject(source) && samePath(source.path, home)));
}

/** The live (unarchived, undeleted) threads that run in the home: those of the projects
 *  given, and any thread whose environment is the home itself. */
export function liveThreadsOfHome(threads, home, projectIds) {
  const ids = new Set(projectIds);
  return threads.filter((thread) => isLive(thread) && (ids.has(thread.projectId) || samePath(thread.environmentPath, home)));
}

/** What a client may open instead of a terminal. */
export function openLink({ server, projectId, threadId }) {
  return { label: "Open in bb", url: `${server}/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}` };
}

/** The inspect answer of one home, from one list of the server's threads. Throws
 *  E_SESSION_UNAVAILABLE when a second live thread runs in the home.
 *  The home's thread is its recorded thread while that is live. Archived (in bb's UI, or
 *  by a retire) it is no longer the home's session: bb refuses every tell to an archived
 *  thread, so it reads as missing, and a start replaces it. */
export function inspectHome({ home, endpoint }, threads, processes) {
  const recorded = threads.find((thread) => isObject(thread) && thread.id === endpoint.threadId && isLive(thread)) ?? null;
  const others = liveThreadsOfHome(threads, home, [endpoint.projectId]).filter((thread) => thread.id !== endpoint.threadId);
  if (others.length > 0) {
    // The remedy and the count first: the list may be long, and a message is cut at 500.
    const ids = others.map((thread) => thread.id);
    const named = someOf(ids);
    throw fail("E_SESSION_UNAVAILABLE", `more than one live bb thread runs in ${home}. One home is one thread: archive the ${ids.length > 1 ? `${ids.length} others` : "other"} in bb. The recorded thread is ${endpoint.threadId}${recorded ? "" : " (missing or archived)"}; the other${ids.length > 1 ? "s" : ""}: ${named}`);
  }
  if (!recorded) return { ...MISSING };
  return { ...inspectAnswer(recorded, processes, home), open: openLink(endpoint) };
}

/** What runs in a home now: its bb projects, and its live threads. Two reads of bb. */
export async function liveInHome(bb, home) {
  const [allProjects, threads] = [await bb.projects(), await bb.threads()];
  const projects = projectsOfHome(allProjects, home);
  return { projects, live: liveThreadsOfHome(threads, home, projects.map((project) => project.id)) };
}
