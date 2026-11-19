/** K7 — typed lifecycle events per instance, append-only, producer-attributed.
 *
 * Every event is a fact a kernel action just made true (spawned, launched,
 * stopped, restarted, retired…), written by the code that did it, with the
 * receipt it produced. Nothing here is inferred from transcripts, task files or
 * prose; "waiting on you" is reported only when a producer says so — today no
 * producer does, and the view says `null`, not a guess. Retirement's event
 * outlives the home in the workspace-level log.
 *
 * eventsApi 2 (`instance-events-2`) — the read is BOUNDED and ADDRESSED:
 *  - a source is `lstat`ed first and opened only if it is a regular file; the
 *    reader reads at most the last MAX_BYTES by descriptor, never the whole file;
 *  - rows are the ADDRESS's history: a row whose instance/home is not the
 *    admitted address is dropped and counted (`integrity.foreignRows`), a torn
 *    line is counted (`integrity.unreadableRows`) — never sorted or windowed away;
 *  - every row is tagged with the `incarnation` (the home's instance.json
 *    `createdAt`) that wrote it; the result echoes the current one, so a
 *    recreated same-address instance's earlier rows are visible as earlier;
 *  - `waitingOnYou` is a producer STATE per (producer, current incarnation):
 *    that producer's latest row carrying the field decides, an explicit `false`
 *    clears, and it is computed over the full admitted read, before windowing;
 *  - a claim is LIVE only after the incarnation's latest kernel session
 *    boundary (`launched` | `restarted` | `stopped`): a claim written before
 *    the boundary belongs to a session that has ended (WAITING_BOUNDARY_KINDS).
 *
 * Producers write claims as `waiting` rows through `setWaiting` (the CLI's
 * `oats instance waiting` and `oats instance attention`): data
 * `{waitingOnYou, reason?, message?}`, appended only on a change. A claim
 * authorizes nothing; it may only withhold an automated keystroke: a scheduled
 * wake holds on a live `permission`, `question` or unknown-reason claim
 * (waitingHold). Every other reader takes it as evidence for display.
 *
 * ONE ADDRESS PER HOME (awebai/oats#583). A home has several spellings when its
 * deployment is reached through a symlink or its agents root is one: status
 * addresses it lexically, a session carries the real path. Rows are keyed by
 * the home string, so every exported function here resolves the home it is
 * given to its REAL path first (`addressOf`): rows record it, readers compare
 * against it, and both logs are found from any spelling. `admit` stays strict.
 * That is storage and matching. An ANSWER (readEvents, setWaiting) names the
 * home the way the caller did: `admit` has proved every returned row is this
 * one home's, so its `home` is the address that was asked about, and a consumer
 * that checks "the rows' home is the home I asked for" keeps holding. */
import { appendFileSync, closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { REFUSED_TEXT, safeText } from "./refused-text.mjs";

export const EVENTS_API = 2;
const HOME_LOG = ".oats-events.jsonl";
const MAX_BYTES = 4 * 1024 * 1024;

/** The kind of the row a retire hook's warning is recorded as (#1749): the one name the writer
 *  (retireInstance) and its tests use. */
export const RETIRE_HOOK_WARNING_KIND = "retire-warning";
/** The kinds whose `data.message` is a hook's or the kernel's warning text, and the longest one a
 *  row stores, in UTF-16 code units: the Desktop events reader's default detail bound
 *  (`eventsDetail`), which refuses the WHOLE read past it, as for RETIRE_REFUSED_REASON_MAX. */
const WARNING_KINDS = ["launch-warning", RETIRE_HOOK_WARNING_KIND];
export const WARNING_MESSAGE_MAX = 2048;

export const EVENT_KINDS = ["spawned", "launched", "restarted", "stopped", "stop-refused", "retire-planned", "retired", "retire-refused", RETIRE_HOOK_WARNING_KIND, "worktree-retained", "worktree-removed", "worktree-added", "branch-deleted", "child-spawn-refused", "launch-warning", "launch-prompt", "recomposed", "modules-upgraded", "upgrade-refused", "waiting", "wake-held"];

/** The longest `reason` a `retire-refused` row carries, in UTF-16 code units. The bound is not the
 *  kernel's: the Desktop's events reader refuses a whole read that holds a longer detail
 *  (`eventsDetail`, packages/client/instance-events-contract.mjs), so the kernel writes none.
 *  test/retire-refused-reader.test.mjs pins the two together; nothing under lib/ reads that package. */
export const RETIRE_REFUSED_REASON_MAX = 2048;
/** The `reason` of a `retire-refused` row for the sentence a retire answered: on one line (each run
 *  of whitespace, newlines among them, is one space) and at most RETIRE_REFUSED_REASON_MAX code
 *  units. A longer one is cut and ends with `…`, the mark counted in the bound, and never through a
 *  surrogate pair. */
export function retireRefusedReason(sentence) {
  return cutToUnits(String(sentence).replace(/\s+/g, " ").trim(), RETIRE_REFUSED_REASON_MAX);
}
/** `text` at most `max` UTF-16 code units: a longer one is cut and ends with `…`, the mark counted
 *  in the bound, and never through a surrogate pair. */
function cutToUnits(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  // A high surrogate at the end was the first half of a pair the cut went through.
  return `${last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut}…`;
}

/** Kernel rows that end or begin a session: a waiting claim older than the
 *  incarnation's latest one is not live. */
export const WAITING_BOUNDARY_KINDS = ["launched", "restarted", "stopped"];
const sessionBoundary = (r) => (r.producer ?? "kernel") === "kernel" && WAITING_BOUNDARY_KINDS.includes(r.kind);
/** The closed set of reasons a positive claim carries. A claim authorizes nothing; it may only
 *  withhold an automated keystroke. `attention` never marks a screen an Enter answers: a producer
 *  that wants one uses `question`, and review catches that. */
export const WAITING_REASONS = ["permission", "question", "attention"];
/** A producer id: what `--producer` accepts (`kernel` is reserved). */
export const WAITING_PRODUCER_RE = /^[a-z0-9][a-z0-9._/-]{0,63}$/;
export const WAITING_MESSAGE_MAX = 200;
/** Characters a claim's message may not contain: the kernel's refused set (lib/refused-text.mjs). */
const WAITING_MESSAGE_REFUSED = REFUSED_TEXT;
/** A claim's message: a non-empty string of 1 to 200 code points with none of
 *  WAITING_MESSAGE_REFUSED. The writer refuses anything else; the reader turns a stored
 *  message that fails it (a hand-edited log) into null. */
export function validWaitingMessage(m) {
  return typeof m === "string" && m.length > 0 && [...m].length <= WAITING_MESSAGE_MAX && !WAITING_MESSAGE_REFUSED.test(m);
}
// A reason read back from a log is shown as given only when it is one of the
// closed set; anything else reads as null, and the claim still counts.
/** A stored reason outside the closed set (a hand-edited or foreign row) reads as null. */
const readReason = (r) => (WAITING_REASONS.includes(r) ? r : null);
/** An event time: a string that parses as a date. The writer refuses anything else. */
const validTime = (at) => typeof at === "string" && Number.isFinite(Date.parse(at));

/** A stored message as the reader shows it: one with a refused character anywhere is null; one
 *  over WAITING_MESSAGE_MAX code points (a row another producer or an older writer made, a
 *  remote kernel's claim) is cut to that many, the last one `…`, so the bound holds for every
 *  reader; then the message is valid or null. */
function readMessage(m) {
  if (typeof m !== "string" || WAITING_MESSAGE_REFUSED.test(m)) return null;
  const points = [...m];
  const cut = points.length > WAITING_MESSAGE_MAX ? `${points.slice(0, WAITING_MESSAGE_MAX - 1).join("")}…` : m;
  return validWaitingMessage(cut) ? cut : null;
}

/** The READ rule for one claim `{since, producer, reason, message}`, the same for a
 *  row of this machine's log and for a claim another kernel reports (a remote roster
 *  row): `since` is a valid date and `producer` is `kernel` or a producer id, or there
 *  is no claim (null); a reason outside the closed set reads as null, a message over
 *  WAITING_MESSAGE_MAX code points is cut (readMessage), and one that then fails
 *  validWaitingMessage reads as null: the claim still counts. Anything that is not
 *  such an object is null. */
export function readWaitingClaim(claim) {
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) return null;
  const { since, producer } = claim;
  if (!validTime(since)) return null;
  // A producer the writer would refuse (a hand-edited log) is never shown as one.
  if (producer !== "kernel" && !(typeof producer === "string" && WAITING_PRODUCER_RE.test(producer))) return null;
  return { since, producer, reason: readReason(claim.reason), message: readMessage(claim.message) };
}

/** realpath of `p`, or, when `p` is gone, the realpath of its nearest existing
 *  ancestor with the rest re-appended (retirement writes its rows after the home
 *  is removed). */
function realOrNearest(p) {
  try { return realpathSync(p); } catch { /* absent: resolve what exists */ }
  let d = resolve(p); const tail = [];
  while (!existsSync(d) && dirname(d) !== d) { tail.unshift(basename(d)); d = dirname(d); }
  try { return join(realpathSync(d), ...tail); } catch { return resolve(p); }
}
function metaOf(home) {
  try { const m = JSON.parse(readFileSync(join(home, "instance.json"), "utf8")); return m && typeof m === "object" ? m : null; } catch { return null; }
}
const incarnationIn = (meta) => (typeof meta?.createdAt === "string" ? meta.createdAt : null);

/** <deployment>/.agents/events/<agent>--<instance>.jsonl: deployment-private state
 *  beside installed capabilities and schedules; survives the home's removal.
 *
 *  The DEPLOYMENT decides where it is, not the real home string: under a symlinked
 *  agents root the real home's ancestors are outside the deployment. The rule:
 *   1. the deployment the spawn recorded (instance.json `workspace.deployment`), used
 *      ONLY when it verifies: the real path of its agents/<agent>/instances/<instance>
 *      is this home, with agent and instance taken from the home's path, never from
 *      instance.json;
 *   2. otherwise the fourth ancestor of the home AS THE CALLER SPELLED IT, which is how
 *      the kernel addresses a home with no record, or one already removed (retirement).
 *  The result is resolved, so every spelling of the home gives one path.
 *
 *  Two limits. A home with no recorded deployment (or already removed) that is named
 *  by its REAL path under a symlinked agents root still derives a directory outside
 *  the deployment; no kernel caller does that. And instance.json is home content: a
 *  record edited to name another directory that links back to this home moves the log
 *  there. That is the class the home log is already in (a path the agent can write,
 *  which the kernel appends to under the same uid), so nothing stricter is checked. */
function workspaceLogPath(given, home, meta) {
  const instance = basename(home), agent = basename(dirname(dirname(home))); // <root>/<agent>/instances/<instance>
  const recorded = meta?.workspace?.deployment;
  const verified = typeof recorded === "string" && isAbsolute(recorded) && realOrNearest(join(recorded, "agents", agent, "instances", instance)) === home;
  const deployment = verified ? recorded : dirname(dirname(dirname(dirname(resolve(given)))));
  return join(realOrNearest(deployment), ".agents", "events", `${agent}--${instance}.jsonl`);
}

/** The one address of the home a caller named, in any spelling: the real home, its
 *  instance name and incarnation, its two logs, and `asked`, the caller's spelling. `known`: the
 *  home's record as the caller already read it (a JSON object), else it is read here. */
function addressOf(given, known) {
  const home = realOrNearest(given);
  const meta = known !== undefined ? known : metaOf(home);
  let workspaceLog;
  return {
    home, asked: given, instance: basename(home), incarnation: incarnationIn(meta), homeLog: join(home, HOME_LOG),
    get workspaceLog() { return (workspaceLog ??= workspaceLogPath(given, home, meta)); },
  };
}

/** THE OUTPUT EDGE, and the only one: canonical inside, the caller's spelling outside.
 *  Whatever this module ANSWERS about an address (an events read, each row in it, a
 *  waiting answer) passes through here, which names the home as the caller spelled
 *  it. Rows on disk and every comparison keep the real path. A new answer that
 *  carries a `home` must go through this too, never write `a.home` out itself. */
const answered = (a, body) => ({ ...body, home: a.asked });

/** The incarnation of the home at `home`: its instance.json `createdAt`, or null. */
export function incarnationOf(home) { return incarnationIn(metaOf(home)); }

/** Append one typed event. Never throws into the caller's action: an event is
 *  evidence, not authority — a failed write is reported in the return value. */
export function appendEvent(home, event, options) { return append(addressOf(home), event, options); }
function append(a, event, { workspaceOnly = false, incarnation, at } = {}) {
  if (!EVENT_KINDS.includes(event.kind)) return { ok: false, reason: `unknown event kind ${event.kind}` };
  // `at`: the time the fact became true, when it is recorded later (a start
  // boundary reconciled from its receipt); readers order rows by it.
  if (at !== undefined && !validTime(at)) return { ok: false, reason: `invalid event time ${at}` };
  // A warning's message is text from outside (a hook's own words, or a kernel line quoting them):
  // stored made safe and bounded here, where no writer can skip it, and never interpreted. A value
  // that is not a string is stored as its JSON. The answer that carried the warning keeps it as given.
  let data = event.data;
  if (WARNING_KINDS.includes(event.kind) && data && typeof data === "object" && Object.hasOwn(data, "message")) {
    const m = data.message;
    // safeText with no bound only replaces; the cut counts the units the Desktop reader counts.
    data = { ...data, message: cutToUnits(safeText(typeof m === "string" ? m : JSON.stringify(m), Infinity), WARNING_MESSAGE_MAX) };
  }
  const row = { eventsApi: EVENTS_API, at: at ?? new Date().toISOString(), instance: a.instance, home: a.home, incarnation: incarnation === undefined ? a.incarnation : incarnation, producer: event.producer || "kernel", kind: event.kind, ...(data !== undefined ? { data } : {}) };
  const line = JSON.stringify(row) + "\n";
  const results = [];
  // Retirement fingerprints the home against its baseline and preserves any
  // changed bytes as "unknown work": events written DURING retirement go only
  // to the workspace log, never into the home being inspected.
  for (const path of [...(workspaceOnly ? [] : [a.homeLog]), a.workspaceLog]) {
    try {
      if (path === a.homeLog && !existsSync(a.home)) { results.push({ path, ok: false, reason: "home absent" }); continue; }
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, line);
      results.push({ path, ok: true });
    } catch (e) { results.push({ path, ok: false, reason: e.message }); }
  }
  return { ok: results.some((r) => r.ok), row, results };
}

/** Bounded, descriptor-safe read of one log: lstat → regular file only → read
 *  at most the last MAX_BYTES. Returns rows plus the source's integrity facts, and
 *  `lastTorn`: where the last torn row sat, as the index in `rows` of the row after it
 *  (-1 with none torn; a row at that index or later was appended after the torn one). */
function readLog(path, label) {
  let st;
  try { st = lstatSync(path); } catch (e) { return e.code === "ENOENT" ? { rows: [], unreadable: 0, source: { path: label, status: "absent", bytes: 0 } } : { rows: [], unreadable: 0, source: { path: label, status: "refused", bytes: 0 } }; }
  if (!st.isFile()) return { rows: [], unreadable: 0, source: { path: label, status: "refused", bytes: 0 } }; // symlink, FIFO, device, directory: never opened
  let fd;
  try {
    // Close the lstat→open swap: open WITHOUT following a symlink and without
    // blocking on a FIFO, then verify by descriptor that what was opened is the
    // regular file lstat saw (same device+inode). Anything else is refused.
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.dev !== st.dev || fst.ino !== st.ino) throw new Error("swapped");
    st = fst; // the size of what is actually open
  } catch { if (fd !== undefined) try { closeSync(fd); } catch { /* nothing to recover */ } return { rows: [], unreadable: 0, source: { path: label, status: "refused", bytes: 0 } }; }
  const tail = st.size > MAX_BYTES;
  const length = tail ? MAX_BYTES : st.size;
  const buf = Buffer.alloc(length);
  try {
    let got = 0; while (got < length) { const n = readSync(fd, buf, got, length - got, (tail ? st.size - MAX_BYTES : 0) + got); if (n <= 0) break; got += n; }
  } catch { return { rows: [], unreadable: 0, source: { path: label, status: "refused", bytes: st.size } }; }
  finally { try { closeSync(fd); } catch { /* nothing to recover */ } }
  const text = buf.toString("utf8");
  const lines = text.split("\n");
  if (tail) lines.shift(); // the first line of a tail is (almost surely) partial; it is not counted as torn — the tail itself is reported
  const rows = []; let unreadable = 0, lastTorn = -1;
  for (const line of lines) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { r = null; }
    if (r && typeof r === "object" && Number.isInteger(r.eventsApi) && r.eventsApi >= 1 && typeof r.kind === "string" && typeof r.at === "string") rows.push(r);
    else { unreadable++; lastTorn = rows.length; }
  }
  return { rows, unreadable, lastTorn, source: { path: label, status: tail ? "tail" : "ok", bytes: st.size } };
}

/** The ADDRESS's rows from the given log reads: foreign rows dropped and
 *  counted, oldest first. The logs are merged as a multiset union: a row in
 *  both logs (the same fact, written to each) is kept once, but rows that
 *  genuinely repeat within one log (a set, a clear and the same set again in
 *  one millisecond) are all kept, as many times as the log holding the most
 *  copies has them. */
function admit(home, reads) {
  const instance = basename(home);
  const admitted = new Map(); const rows = []; let foreign = 0;
  for (const read of reads) {
    const inThisLog = new Map();
    for (const r of read.rows) {
      if (r.instance !== instance || r.home !== home) { foreign++; continue; } // another address's row in this log: history of THIS address only
      const k = `${r.producer ?? "kernel"}|${r.at}|${r.kind}|${r.incarnation ?? ""}|${JSON.stringify(r.data ?? null)}`; // same facts from two producers are two rows
      const n = (inThisLog.get(k) ?? 0) + 1; inThisLog.set(k, n);
      if (n <= (admitted.get(k) ?? 0)) continue; // this copy is already in from another log
      admitted.set(k, n); rows.push({ ...r, incarnation: r.incarnation ?? null });
    }
  }
  rows.sort((x, y) => x.at.localeCompare(y.at));
  return { rows, foreign };
}

/** Waiting: a producer STATE for the CURRENT incarnation, decided by that
 *  producer's latest row that carries the field, over the FULL admitted read.
 *  An UNKNOWN current incarnation (unreadable instance.json) admits NO claim:
 *  unknown stays unknown, it never resurrects an earlier incarnation's
 *  positive. A row older than the incarnation's latest kernel session
 *  boundary belongs to an ended session and is not a claim at all, nor is a
 *  row whose producer is neither `kernel` nor a valid producer id. */
function claimsOf(rows, incarnation) {
  const claims = new Map();
  if (incarnation === null) return claims;
  const current = rows.filter((r) => r.incarnation === incarnation);
  // Positional: rows are time-sorted with a stable sort, so rows of the same
  // millisecond keep their append order, and a claim appended before the
  // boundary in that millisecond is still before it.
  const boundary = current.findLastIndex(sessionBoundary);
  for (const r of current.slice(boundary + 1)) {
    if (!r.data || typeof r.data.waitingOnYou !== "boolean") continue;
    const p = r.producer ?? "kernel";
    // A row the read rule refuses (a hand-edited log: its producer, its time) says nothing.
    const claim = readWaitingClaim({ since: r.at, producer: p, reason: r.data.reason, message: r.data.message });
    if (!claim) continue;
    claims.set(p, r.data.waitingOnYou
      ? { producer: p, waiting: true, since: claim.since, reason: claim.reason, message: claim.message }
      : { producer: p, waiting: false, since: claim.since, reason: null, message: null });
  }
  return claims;
}
/** The claim waitingOnYou shows: the newest positive claim that carries a message, so a claim
 *  with no text never hides one a person can read (#1502); the newest text-less claim only adds
 *  the reason it lacks. With no message anywhere, the newest positive claim. */
function positiveOf(claims) {
  const positive = [...claims.values()].filter((c) => c.waiting).sort((x, y) => x.since.localeCompare(y.since));
  const said = positive.filter((c) => c.message !== null).at(-1) ?? null;
  const unsaid = positive.filter((c) => c.message === null).at(-1) ?? null;
  if (said === null) return unsaid;
  return said.reason === null && unsaid !== null ? { ...said, reason: unsaid.reason } : said;
}
const waitingShape = (c) => (c ? { since: c.since, producer: c.producer, reason: c.reason, message: c.message } : null);

/** Events for one instance ADDRESS, newest last, from both logs, with a bounded
 *  window; integrity is reported independently of the selected rows. The answer's
 *  `home`, and each returned row's, is the home as the caller spelled it: `given`,
 *  or `asked` when the caller resolved its own spelling to `given` (a removed home
 *  named through an alias of the agents root, whose logs `given` locates). */
export function readEvents(given, { limit = 200, since = null, asked } = {}) {
  const address = addressOf(given);
  if (asked !== undefined) address.asked = asked;
  const { home, instance, incarnation, homeLog, workspaceLog } = address;
  const a = readLog(homeLog, "home"), b = readLog(workspaceLog, "workspace");
  const { rows, foreign } = admit(home, [a, b]);
  const claims = claimsOf(rows, incarnation);
  const waitingClaims = [...claims.values()];
  const positive = positiveOf(claims);
  const filtered = since ? rows.filter((r) => r.at > since) : rows;
  const window = filtered.slice(-limit).map((r) => answered(address, r));
  const last = window.at(-1) ?? null;
  return answered(address, {
    eventsApi: EVENTS_API, instance, home, incarnation, count: filtered.length, returned: window.length,
    truncated: filtered.length > window.length || a.source.status === "tail" || b.source.status === "tail",
    integrity: { unreadableRows: a.unreadable + b.unreadable, foreignRows: foreign, sources: [a.source, b.source] },
    events: window, lastEvent: last ? { kind: last.kind, at: last.at, producer: last.producer ?? "kernel", incarnation: last.incarnation } : null,
    waitingOnYou: waitingShape(positive),
    waitingClaims,
    notes: [
      "events are producer-attributed facts written by the kernel action that made them true; nothing is inferred from transcripts or task files",
      "this is the ADDRESS's history: rows tagged with an earlier incarnation belong to a previous instance at this address",
      "waitingOnYou is null unless a producer reported it for the current incarnation — null means unknown, not 'not waiting'; an explicit false clears that producer's claim; an unknown current incarnation (null) admits no claim at all",
      "a claim older than the incarnation's latest kernel launched, restarted or stopped row belongs to an ended session and is not counted",
      "integrity counts torn and foreign rows and names each source's status; truncated is true when the window cut rows or a source was read as a tail",
    ],
  });
}

/** The instance's live waiting state, `{since, producer, reason, message}` or
 *  null: what `oats status` rows and `oats session inspect` carry. The same
 *  bounded read and the same claim rule as readEvents, over the home log only
 *  (the workspace log only when the home log is absent): every row a producer
 *  or a session boundary writes goes to both. `meta`: the home's record, when the caller has just
 *  read it (lib/instance-listing.mjs listInstances), so that one read parses it once. */
export function liveWaiting(home, { meta } = {}) {
  const a = addressOf(home, meta);
  if (a.incarnation === null) return null;
  let log = readLog(a.homeLog, "home");
  if (log.source.status === "absent") log = readLog(a.workspaceLog, "workspace");
  return waitingShape(positiveOf(claimsOf(admit(a.home, [log]).rows, a.incarnation)));
}

/** What holds a scheduled wake at this home: null (no hold), `{claimReason, producer}` (a claim), or
 *  `{claimReason: null, producer: null, unreadable}` (a read that can't be trusted, `unreadable` a
 *  short sentence that goes in the events, where the Desktop's reader bounds a detail). Never
 *  liveWaiting: positiveOf shows one claim, and an `attention` claim with text can hide a text-less
 *  `permission` one. Both logs, merged, and every live claim: `permission`, `question` and a null
 *  reason hold (a stored reason outside the closed set is a claim that can't be read), the newest if
 *  several; `attention` alone does not. A log that can't prove the session holds no claim is
 *  unreadable: refused, cut to a tail with no boundary of this incarnation, or with a torn row after
 *  its last boundary (anywhere, with none). A boundary voids what is before it, so a tail that holds
 *  one, or a torn row before one, is fine; so is an absent log. */
export function waitingHold(given) {
  const a = addressOf(given);
  const unreadable = (why) => ({ claimReason: null, producer: null, unreadable: why });
  if (a.incarnation === null) return unreadable("no readable instance.json");
  const logs = [readLog(a.homeLog, "home"), readLog(a.workspaceLog, "workspace")];
  for (const log of logs) {
    const { path, status } = log.source;
    if (status === "refused") return unreadable(`the ${path} events log was refused`);
    const boundary = log.rows.findLastIndex((r) => r.instance === a.instance && r.home === a.home && r.incarnation === a.incarnation && sessionBoundary(r));
    if (status === "tail" && boundary < 0) return unreadable(`the ${path} events log's tail holds no session boundary`);
    if (log.lastTorn > boundary) return unreadable(`the ${path} events log has a torn row in this session`);
  }
  const claims = [...claimsOf(admit(a.home, logs).rows, a.incarnation).values()].filter((c) => c.waiting && c.reason !== "attention");
  const newest = claims.sort((x, y) => x.since.localeCompare(y.since)).at(-1);
  return newest ? { claimReason: newest.reason, producer: newest.producer } : null;
}

const waitingError = (code, message) => Object.assign(new Error(message), { code });

/** Set or clear one producer's waiting claim on an instance home; appends a
 *  `waiting` row only when the producer's LIVE claim changes (a positive set
 *  whose reason or message differs is a change; a clear of a claim that is
 *  not positive is not). Each log is judged on its own, so a row that reached
 *  only one log earlier is repaired by the next call rather than hidden by the
 *  other log; success means both logs took the row. Validates its input
 *  (E_BAD_ARGS); a home without a readable instance.json is
 *  E_SESSION_UNKNOWN; a write either log refused is E_EVENTS_FAILED (a retry
 *  repairs it). The answer's `home` is the home as the caller spelled it; the row
 *  records the real path. Evidence, not authority: nothing else is touched. */
export function setWaiting(given, { producer, waiting, reason, message } = {}) {
  if (typeof producer !== "string" || !WAITING_PRODUCER_RE.test(producer)) throw waitingError("E_BAD_ARGS", `--producer must match ${WAITING_PRODUCER_RE.source}`);
  if (producer === "kernel") throw waitingError("E_BAD_ARGS", "--producer kernel is reserved for the kernel's own events");
  if (typeof waiting !== "boolean") throw waitingError("E_BAD_ARGS", "waiting must be set or clear");
  if (waiting) {
    if (!WAITING_REASONS.includes(reason)) throw waitingError("E_BAD_ARGS", `--reason must be one of ${WAITING_REASONS.join(", ")}`);
    if (message !== undefined && !validWaitingMessage(message)) throw waitingError("E_BAD_ARGS", `--message must be one line of 1 to ${WAITING_MESSAGE_MAX} characters with no control character, line separator, bidi control (U+202A-202E, U+2066-2069), U+200B, U+2060, U+FEFF or tag character`);
  } else {
    if (reason !== undefined) throw waitingError("E_BAD_ARGS", "--reason is for set, not clear");
    if (message !== undefined) throw waitingError("E_BAD_ARGS", "--message is for set, not clear");
  }
  const a = addressOf(given);
  const { home, incarnation } = a;
  if (incarnation === null) throw waitingError("E_SESSION_UNKNOWN", `${given} is not an instance home (no readable instance.json)`);
  const live = [readLog(a.homeLog, "home"), readLog(a.workspaceLog, "workspace")]
    .map((log) => { const c = claimsOf(admit(home, [log]).rows, incarnation).get(producer); return c?.waiting ? c : null; });
  const agrees = (c) => (waiting ? !!c && c.reason === reason && c.message === (message ?? null) : !c);
  const answer = (changed, claim) => answered(a, { eventsApi: EVENTS_API, instance: a.instance, home, producer, changed, waitingOnYou: waitingShape(claim) });
  if (live.every(agrees)) return answer(false, waiting ? live[0] : null);
  const data = waiting ? { waitingOnYou: true, reason, ...(message !== undefined ? { message } : {}) } : { waitingOnYou: false };
  const res = append(a, { producer, kind: "waiting", data }, { incarnation });
  const failed = (res.results || []).filter((r) => !r.ok);
  if (!res.ok || failed.length) throw waitingError("E_EVENTS_FAILED", `could not record the waiting claim in ${failed.map((r) => `${r.path} (${r.reason})`).join(", ") || res.reason}; retry to complete it`);
  return answer(true, waiting ? { producer, since: res.row.at, reason, message: message ?? null } : null);
}

/** The kernel session boundary of one start receipt: a `launched` row tagged
 *  `startId`, dated at the receipt's `startedAt`, written once to each log. A
 *  start records it as soon as its session exists; recovering an interrupted
 *  start (its receipt adopted later) completes it: a log that already has the
 *  row is left alone, a log missing it gets a copy of the same row (same time,
 *  same data), and only when neither has it is the row made, still at the
 *  launch time, so a claim the new session made since is kept. `ok` is true
 *  only when every log holds the row; evidence, never authority. */
export function recordStartBoundary(given, { startId, startedAt, ...data }) {
  const a = addressOf(given);
  const { home, instance } = a;
  const paths = [a.homeLog, a.workspaceLog];
  const isIt = (r) => r.instance === instance && r.home === home && (r.producer ?? "kernel") === "kernel" && r.kind === "launched" && r.data?.startId === startId;
  const found = paths.map((path) => readLog(path, "log").rows.find(isIt) ?? null);
  if (found.every(Boolean)) return { ok: true, existed: true };
  const existing = found.find(Boolean);
  if (!existing) {
    const res = append(a, { kind: "launched", data: { ...data, startId } }, { at: startedAt });
    return { ...res, ok: res.ok && (res.results || []).every((r) => r.ok) };
  }
  // The row exactly as the other log holds it: same time, incarnation and data.
  const line = JSON.stringify(existing) + "\n";
  const results = paths.filter((_, i) => !found[i]).map((path) => {
    try {
      if (path === a.homeLog && !existsSync(home)) return { path, ok: false, reason: "home absent" };
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, line);
      return { path, ok: true };
    } catch (e) { return { path, ok: false, reason: e.message }; }
  });
  return { ok: results.every((r) => r.ok), repaired: true, row: existing, results };
}
