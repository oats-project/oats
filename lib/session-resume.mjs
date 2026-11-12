/** `oats session resume` (feature session-resume, #1559): the machine sweep. After a shutdown, a
 *  reboot or a crash, every launched instance home whose session was lost (status `sessionEnd: lost`)
 *  on every local deployment is started again with `session start --resume`, in its own harness
 *  conversation; running homes are left alone, stopped and exited ones stay stopped.
 *
 *  - The machine's deployments come from the registry, read only (readDeploymentsDocument, never the
 *    first-use import that listDeployments may write); `deployment` narrows the sweep to one
 *    directory, registered or not. Nothing opts a deployment out: stopping an instance with OATS
 *    is what keeps it down.
 *  - Only a loss the kernel can vouch for is resumed (lib/session-seen.mjs resumeEligible, from what
 *    local listings recorded of the home): seen running for its current start, not judged by an
 *    earlier sweep, first seen lost less than 24 hours ago, and, within one boot, lost less than 24
 *    hours after it was last seen running. Any other is `skipped`, `not-seen-recently`. A home the
 *    sweep started is recorded as seen running for its new start. A sweep that
 *    is not a plan judges each lost home it answered (`judgedBy`), so it is answered once.
 *  - Each home starts as a child process of this kernel (`session start --resume --home <home>
 *    --json`, its cwd the home's deployment), so each start resolves its own deployment's scope; at
 *    most RESUME_CONCURRENCY at once. A per-home failure is a row, never the sweep's failure.
 *  - One sweep per machine: the lock `session-resume/lock` under OATS_HOME_DIR (default ~/.oats),
 *    a claim (lib/claim.mjs, through lib/dir-lock.mjs) that names its holder by pid, process start
 *    and boot id; a lock whose holder is gone, or that was taken in another boot, is taken over at
 *    once. A second sweep answers E_RESUME_BUSY; a lock that needs a person, E_RESUME_LOCK_STUCK,
 *    which `oats doctor` reports too (acquireResumeLock, resumeLockProblem).
 *  - No retry storm, and no loss given up for a cause that passes.
 *    A start counts when it launched something (`resumed`, `fresh`, `blocked`), noted as soon as
 *    that start has answered, so a sweep that is killed while other starts run has counted the
 *    ones that answered. A home is started by sweeps at most RESUME_LIMIT times in
 *    RESUME_WINDOW_MS (counted by home: each start makes a new start id), then reported
 *    `keeps-getting-lost` without a start, with `nextAttemptAt`: when the oldest counted start
 *    leaves the window a sweep starts it again.
 *    That is not for ever: a home that uses up its starts in RESUME_SPENT_HOURS hours in a row
 *    is answered `keeps-getting-lost` with no `nextAttemptAt`, and that loss is judged: no sweep
 *    starts it again, and a person does. Hours are in a row when each begins less than
 *    RESUME_WINDOW_MS after the one before it cleared; only an hour without one begins the
 *    count again. No start does, whoever makes it: a person may start a home the sweep gave up,
 *    and if it is lost again in a used-up hour it is given up again at once.
 *    A refused start launched nothing: it is not counted, and it does not judge the loss. It is
 *    noted, and a sweep tries that home and start again no sooner than RETRY_FIRST_MS after the
 *    refusal, doubled at each further refusal up to RETRY_CEILING_MS; until then a sweep reports
 *    it `start-refused-retrying` with the refusal's `code` and `message` and `nextAttemptAt`,
 *    without a start. The retries end when the loss is no longer one the kernel vouches for
 *    (first seen 24 hours ago: `not-seen-recently`).
 *    The note is one boot's (`note.json`): another boot's is replaced whole, so a reboot starts
 *    the count and the delays again. `session start --resume` run by hand is neither bounded
 *    nor counted.
 *    A current-start host-stop receipt identifies an administrative restore: a successful one
 *    bypasses the crash ceiling without spending or clearing the carried budget. A blocked or
 *    failed restore keeps its failure accounting, and eligibility checks still hold.
 *    Without a boot id (neither Linux nor macOS) nothing is noted or counted: each sweep tries again.
 *  The lock and the note are kernel-private, not a contract. `plan` predicts from the note, starting
 *  nothing, taking no lock and writing no note. */
import { hostRunAdmissionOpen, hostRunChildArgs } from "./host-run-admission.mjs";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { oatsError } from "./errors.mjs";
import { deploymentState, readDeploymentsDocument } from "./deployments.mjs";
import { acquireDirLock, dirLockHeld, stuckLockRemedy } from "./dir-lock.mjs";
import { homeClaimHolder, listInstances, launchEnvRefs, missingLaunchEnvRefs, owedRetireSaid, resumeConversation } from "./core.mjs";
import { checkStartEnv, launchEnvChangedMessage, launchEnvMissingMessage, launchEnvUnverifiedWarning } from "./start-env.mjs";
import { FRESH_REASON, NOT_SWEPT, OUTCOME, RESUME_WAITING, ROW_REASON, SESSION_END } from "./session-resume-contract.mjs";
import { bootId, homeKey, judgeLosses, readSeen, recordSeen, resumeEligible, resumeStateDir, sameBoot, takenInAnotherBoot } from "./session-seen.mjs";
import { isAgentScopeWarning } from "./tmux-server-scope.mjs";
import { hostStoppedAt as readHostStoppedAt } from "./session-end.mjs";

export { bootId, resumeStateDir };

export const RESUME_SCHEMA = 1;
/** At most this many starts run at once. */
export const RESUME_CONCURRENCY = 4;
/** At most this many sweep starts of one home in RESUME_WINDOW_MS. */
export const RESUME_LIMIT = 3;
/** The span over which a home's sweep starts are counted. */
export const RESUME_WINDOW_MS = 60 * 60_000;
/** A home that uses up its starts in this many hours in a row is not started by a sweep again. */
export const RESUME_SPENT_HOURS = 3;
/** How long after a refused start a sweep tries it again: this after the first refusal, doubled at
 *  each further one, never more than RETRY_CEILING_MS. */
export const RETRY_FIRST_MS = 60_000;
export const RETRY_CEILING_MS = 15 * 60_000;
const lockPath = () => join(resumeStateDir(), "lock");
const notePath = () => join(resumeStateDir(), "note.json");

const readJson = (path) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; } };

/** A sweep's lock `path` that needs a person, found as lib/dir-lock.mjs says it (`why`, `found`) →
 *  what is said of it and what to do. Exported for its test. */
export function resumeLockStuck(path, why, found) {
  return {
    lock: path, found,
    said: `the session resume lock ${path} cannot be taken (${why})`,
    remedy: stuckLockRemedy(path, found, "oats session resume"),
  };
}

/** Take the machine's resume lock → its release function. The lock is a claim (lib/dir-lock.mjs
 *  acquireDirLock) whose record also names the boot it was taken in.
 *   - A sweep that runs holds it: E_RESUME_BUSY, at once.
 *   - A holder that is gone (exited, killed, its pid another process's) is taken over at once. So
 *     is one that took the lock in another boot (takenInAnotherBoot).
 *   - A lock that needs a person is E_RESUME_LOCK_STUCK, with what was found and what to do, its
 *     `details` `{ lock, found }` (`found`: lib/dir-lock.mjs), and is left as it is: a holder
 *     whose liveness cannot be read, a record that does not parse, a gone holder's record that
 *     cannot be taken over, a lock taken again each time it was found free, this process's own
 *     start unreadable, and a directory at the lock's path, the lock of an earlier kernel, which
 *     is never judged and never removed. */
export function acquireResumeLock({ boot = bootId() } = {}) {
  const path = lockPath();
  mkdirSync(resumeStateDir(), { recursive: true, mode: 0o700 });
  const busy = (why, { found }) => {
    if (found === "running") return oatsError("E_RESUME_BUSY", `another session resume on this machine holds ${path} (${why}); nothing was started`);
    const stuck = resumeLockStuck(path, why, found);
    return Object.assign(oatsError("E_RESUME_LOCK_STUCK", `${stuck.said}; ${stuck.remedy}; nothing was started`), { details: { lock: path, found } });
  };
  return acquireDirLock(path, { bootId: boot }, { busy, holderGone: takenInAnotherBoot(boot) });
}

export const RESUME_LOCK_STUCK = "resume-lock-stuck";
/** `oats doctor`'s `resume-lock-stuck` problem: the machine's resume lock when it needs a person
 *  → `{ code, message, remedy }`, or null. The lock is read where a sweep would take it
 *  (lib/dir-lock.mjs dirLockHeld, with the same boot rule), and nothing is taken or changed. Every
 *  state acquireResumeLock answers E_RESUME_LOCK_STUCK for a lock it finds is one; a free lock, a
 *  sweep that runs and a lock a gone sweep left, which the next sweep takes over, are not. */
export function resumeLockProblem({ boot = bootId() } = {}) {
  const path = lockPath(), held = dirLockHeld(path, { holderGone: takenInAnotherBoot(boot) });
  if (!held || held.found === "running") return null;
  const stuck = resumeLockStuck(path, held.why, held.found);
  return { code: RESUME_LOCK_STUCK, message: `${stuck.said}: oats session resume starts nothing on this machine while it is there`, remedy: stuck.remedy };
}

/** This boot's note as it is stored: `{ bootId, refused: [{ home, startId, code, message, at,
 *  attempts }], starts: { <home>: [<ISO time of a sweep start that launched something>] },
 *  spent: { <home>: { hours, since } } }` (`since` the oldest counted start of the home's last
 *  used-up hour, `hours` how many such hours in a row that makes), each home by its real path
 *  (lib/session-seen.mjs homeKey); empty for another boot's note, an unreadable one, or no boot id. */
function readNote(boot) {
  const note = boot ? readJson(notePath()) : undefined;
  const map = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  if (!note || !sameBoot(note.bootId, boot)) return { bootId: boot, refused: [], starts: {}, spent: {} };
  const starts = {};
  if (note.starts && typeof note.starts === "object" && !Array.isArray(note.starts)) {
    for (const [home, times] of Object.entries(note.starts)) if (Array.isArray(times)) starts[home] = times.filter((t) => typeof t === "string" && Number.isFinite(Date.parse(t)));
  }
  const spent = Object.fromEntries(Object.entries(map(note.spent)).filter(([, v]) => v && Number.isSafeInteger(v.hours) && v.hours > 0 && Number.isFinite(Date.parse(v.since))));
  return { bootId: boot, refused: Array.isArray(note.refused) ? note.refused.filter((r) => r && typeof r.home === "string") : [], starts, spent };
}
/** The used-up hour that begins with the counted start `since`, after the home's earlier mark
 *  `mark` (a note's `spent` entry, or none) → `{ hours, since }`: the same hour again is the mark
 *  itself; an hour that begins less than RESUME_WINDOW_MS after the marked one cleared is one
 *  more in a row; any other is the first. */
export function spentHours(mark, since) {
  if (mark && mark.since === since) return { hours: mark.hours, since };
  const inARow = mark && Date.parse(since) - (Date.parse(mark.since) + RESUME_WINDOW_MS) < RESUME_WINDOW_MS;
  return { hours: inARow ? mark.hours + 1 : 1, since };
}
/** The times in `times` that are inside the counting window at `now`, oldest first. */
const inWindow = (times = [], now) => times.filter((t) => now - Date.parse(t) < RESUME_WINDOW_MS).sort();
/** This boot's note: `{ bootId, refused, resumes: { <home>: n } }`, `refused` as it is stored
 *  (readNote) and `n` the sweep starts of the home counted at `now`: those of the last
 *  RESUME_WINDOW_MS. */
export function readBootNote(boot = bootId(), now = Date.now()) {
  const note = readNote(boot), resumes = {};
  for (const [home, times] of Object.entries(note.starts)) { const n = inWindow(times, now).length; if (n > 0) resumes[home] = n; }
  return { bootId: boot, refused: note.refused, resumes };
}
/** When a sweep tries the refused start `prior` (a note's entry) again, in ms: RETRY_FIRST_MS
 *  after its refusal, doubled for each refusal before it, at most RETRY_CEILING_MS. An entry
 *  whose time does not read is due at once. */
export function retryDueAt(prior) {
  const at = Date.parse(prior?.at);
  if (!Number.isFinite(at)) return 0;
  const refusals = Number.isSafeInteger(prior.attempts) && prior.attempts > 0 ? prior.attempts : 1;
  return at + Math.min(RETRY_FIRST_MS * 2 ** Math.min(refusals - 1, 30), RETRY_CEILING_MS);
}
/** Note a sweep's `refusals` (each replacing its home's earlier entry), the `launched` homes (each
 *  a start at `now`, and the starts that left the counting window dropped) and the used-up hours
 *  it marked (`spent`: { <home>: { hours, since } }) for this boot; another boot's note is
 *  replaced whole. Nothing is written without a boot id. */
export function noteSweep({ refusals = [], launched = [], spent = {} }, boot = bootId(), now = Date.now()) {
  if (!boot || (!refusals.length && !launched.length && !Object.keys(spent).length)) return;
  const note = readNote(boot);
  const homes = new Set(refusals.map((r) => r.home));
  const starts = {};
  for (const [home, times] of Object.entries(note.starts)) { const kept = inWindow(times, now); if (kept.length) starts[home] = kept; }
  for (const home of launched) starts[home] = [...(starts[home] ?? []), new Date(now).toISOString()];
  const path = notePath();
  mkdirSync(resumeStateDir(), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ bootId: boot, refused: [...note.refused.filter((r) => !homes.has(r.home)), ...refusals], starts, spent: { ...note.spent, ...spent } }, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) { rmSync(tmp, { force: true }); throw e; }
}

/** The deployments a sweep considers: the one `deployment` names (E_BAD_ARGS when it is not a
 *  deployment directory), else the registry's live rows, sorted: a row `oats deployments remove` took
 *  out (a tombstone, `removed: true`) is never swept. Registry errors (E_DEPLOYMENTS_*) throw. */
function sweptDeployments(deployment) {
  if (deployment !== undefined) {
    const dir = resolve(deployment);
    if (deploymentState(dir) !== "ok") throw oatsError("E_BAD_ARGS", `--deployment ${dir} is not a deployment directory (no oats-local.yaml there); nothing was started`);
    return [dir];
  }
  return readDeploymentsDocument().deployments.filter((row) => row && row.removed !== true).map((row) => row.path).sort();
}

/** One deployment: its entry for `deployments[]` and, when it is swept, its homes' rows to act on. */
function readDeployment(dir) {
  const state = deploymentState(dir);
  if (state !== "ok") return { entry: { deployment: dir, state, swept: false, reason: NOT_SWEPT.NOT_OK } };
  let rows;
  try {
    // The status rows `oats status --dir <deployment> --json` lists (listInstances), from the
    // deployment's own instance root.
    const root = join(dir, "agents");
    rows = existsSync(root) ? listInstances(root).flatMap((a) => (a.instances || []).map((i) => ({ deployment: dir, ...i }))) : [];
  } catch (e) {
    return { entry: { deployment: dir, state, swept: false, reason: NOT_SWEPT.UNREADABLE, code: typeof e?.code === "string" && e.code.startsWith("E_") ? e.code : "E_RESUME_UNREADABLE", message: String(e?.message ?? e) } };
  }
  return { entry: { deployment: dir, state, swept: true }, rows };
}

/** The reasons of the rows a sweep answers without judging the loss, so that a later sweep may
 *  resume it: a home OATS was stopping, upgrading or retiring (`lifecycle-busy`), whose next state
 *  is that command's to decide; a start that was refused, which launched nothing and says how the
 *  host was at that moment (`start-refused`, and `start-refused-retrying` while its delay runs);
 *  and a home whose starts of the last RESUME_WINDOW_MS used up the budget (`keeps-getting-lost`),
 *  which a sweep starts again when the window has moved on; unless it did so RESUME_SPENT_HOURS
 *  hours in a row (the sweep's `givenUp`), which is judged. */
const NOT_JUDGED = new Set([ROW_REASON.LIFECYCLE_BUSY, ROW_REASON.START_REFUSED, ROW_REASON.START_REFUSED_RETRYING, ROW_REASON.KEEPS_GETTING_LOST]);
/** Outcomes that can consume the crash budget; a successful host-stop restore is exempt below. */
const LAUNCHED = new Set([OUTCOME.RESUMED, OUTCOME.FRESH, OUTCOME.BLOCKED]);
const base = (row) => ({ deployment: row.deployment, instance: row.instance, home: row.home });

/** A start's answered warnings, as strings. */
const startWarnings = (answer) => answer?.ok === true && Array.isArray(answer.result?.warnings) ? answer.result.warnings.filter((w) => typeof w === "string") : [];
/** The warnings of a start's answer that are said of the host, not of its home: today only the
 *  agent-scope warning (isAgentScopeWarning), which every start on a host that cannot scope repeats.
 *  The sweep says each once, in its own `warnings`; the rows leave them out (rowFromStart). */
export function hostWarnings(answer) {
  return startWarnings(answer).filter(isAgentScopeWarning);
}

/** What a start's JSON answer means for the sweep's row: its warnings without the host's (hostWarnings). */
export function rowFromStart(row, answer) {
  if (answer?.ok === true) {
    const r = answer.result ?? {}, resume = r.resume ?? {};
    const warnings = startWarnings(answer).filter((w) => !isAgentScopeWarning(w));
    const extra = warnings.length ? { warnings } : {};
    if (resume.resumed === true) {
      if (resume.waiting === RESUME_WAITING.RESUME_CONFIRMATION) return { ...base(row), outcome: OUTCOME.BLOCKED, reason: ROW_REASON.RESUME_CONFIRMATION, ...(resume.sessionId ? { sessionId: resume.sessionId } : {}), ...extra };
      return { ...base(row), outcome: OUTCOME.RESUMED, ...(resume.sessionId ? { sessionId: resume.sessionId } : {}), ...extra };
    }
    return { ...base(row), outcome: OUTCOME.FRESH, reason: resume.reason ?? FRESH_REASON.NO_CONVERSATION, ...extra };
  }
  const code = typeof answer?.error?.code === "string" ? answer.error.code : "E_SESSION_START_FAILED";
  const message = String(answer?.error?.message ?? "the start gave no answer");
  if (code === "E_SPAWN_INCOMPLETE") return { ...base(row), outcome: OUTCOME.BLOCKED, reason: ROW_REASON.LAUNCH_PROMPT, code, ...(answer.error.details?.launchPrompts ? { launchPrompts: answer.error.details.launchPrompts } : {}) };
  if (code === "E_SESSION_START_BUSY") return { ...base(row), outcome: OUTCOME.SKIPPED, reason: ROW_REASON.START_BUSY, code };
  // The home's lifecycle claim was held, or its retire is owed: whatever OATS is doing decides the
  // home's next state. Not a refusal: none is noted, judged or counted against the loop guard.
  if (code === "E_INSTANCE_RETIRING" || code === "E_LIFECYCLE_BUSY") return { ...base(row), outcome: OUTCOME.SKIPPED, reason: ROW_REASON.LIFECYCLE_BUSY, code, message };
  if (code === "E_RESUME_NOT_LOST" || code === "E_SESSION_RUNNING") return { ...base(row), outcome: OUTCOME.SKIPPED, reason: ROW_REASON.NOT_LOST, code };
  if (code === "E_SESSION_UNKNOWN") return { ...base(row), outcome: OUTCOME.SKIPPED, reason: ROW_REASON.UNKNOWN, code, message };
  return { ...base(row), outcome: OUTCOME.REFUSED, reason: ROW_REASON.START_REFUSED, code, message };
}

/** The environment of a start the sweep runs: this one's, without an instance identity, so a sweep
 *  run from inside an instance starts each home as the home itself, in its deployment. */
function startEnvironment(env) {
  const out = { ...env };
  for (const k of ["OATS_INSTANCE", "OATS_INSTANCE_HOME", "OATS_HOME", "PI_AGENT_INSTANCE", "PI_AGENT_HOME"]) delete out[k];
  return out;
}
/** Run this kernel (`execPath` `bin`) with `argv` as a child process → its JSON answer: the last
 *  line of its stdout. A child that printed none is answered as a failure envelope, `code`, that
 *  says how `what` exited. The child gets `env` without an instance identity (startEnvironment).
 *  Never rejects. */
export function kernelAnswer({ execPath, bin, env }, argv, { cwd, code, what }) {
  return new Promise((done) => {
    execFile(execPath, hostRunChildArgs(bin, argv), { cwd, env: startEnvironment(env), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      let answer;
      try { answer = JSON.parse(String(stdout).trim().split("\n").pop()); } catch { answer = undefined; }
      if (!answer || typeof answer !== "object") answer = { ok: false, error: { code, message: `${what} exited${error?.code !== undefined ? ` with status ${error.code}` : ""}${error?.signal ? ` on ${error.signal}` : ""} without an answer` } };
      done(answer);
    });
  });
}
const runStart = (kernel, row) => kernelAnswer(kernel, ["session", "start", "--resume", "--home", row.home, "--json"], { cwd: row.deployment, code: "E_SESSION_START_FAILED", what: "the start" });
/** `fn` over `items`, at most `limit` at once; once `stop()` holds no item is taken any more, and the
 *  answer waits for every one already taken. */
async function inBatches(items, limit, fn, stop = () => false) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (!stop() && next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The sweep → `{ schemaVersion, plan, deployments, rows, warnings? }` (docs/desktop-cli-api.md):
 *  `warnings`, only when there is one, holds each distinct host-wide warning of its starts once. `kernel`:
 *  `{ execPath, bin }`, how a start is run; `env` the environment each start gets. `start` (tests):
 *  row → Promise of the start's JSON answer, in place of the child process. */
export async function resumeSessions({ deployment, plan = false, kernel, env = process.env, boot = bootId(), start = (row) => runStart({ ...kernel, env }, row) } = {}) {
  const release = plan ? null : acquireResumeLock({ boot });
  try {
    const deployments = [], candidates = [], rows = [], seen = new Map();
    for (const dir of sweptDeployments(deployment)) {
      const { entry, rows: found } = readDeployment(dir);
      deployments.push(entry);
      // What the kernel has seen of each home (lib/session-seen.mjs), read after the deployment's own
      // listing recorded what it saw now.
      const { homes } = found ? readSeen(join(dir, "agents")) : { homes: {} };
      for (const [home, record] of Object.entries(homes)) seen.set(home, record);
      for (const row of found ?? []) {
        if (row.running === true) rows.push({ ...base(row), outcome: OUTCOME.ALREADY_RUNNING });
        else if (row.running === null) rows.push({ ...base(row), outcome: OUTCOME.SKIPPED, reason: ROW_REASON.UNKNOWN });
        // A launched home that is owed a self-retire reads no sessionEnd (its marker withholds it):
        // it is listed as the lost ones are, so that the sweep says it is skipped (lifecycleBusy).
        else if (row.sessionEnd === SESSION_END.LOST || (row.retirePending && row.launched === true && row.running === false)) candidates.push(row);
      }
    }
    const now = Date.now(), note = readNote(boot);
    const toStart = [], hostStopped = new Set(), refusedBefore = new Map(), marked = {}, givenUp = new Set();
    const iso = (ms) => new Date(ms).toISOString();
    // Precedence, the first that applies: not seen recently, refused and not yet due again, keeps
    // getting lost, started. The record and the note name a home by its real path (homeKey), whatever spelling the
    // sweep was given; a row shows the path it listed.
    // A home OATS is stopping, upgrading or retiring, or whose retire is owed, comes first: nothing
    // is started there. This read is only a filter (the sweep is not atomic with it): the start's
    // own claim is what keeps a resume off such a home (lib/core.mjs startInstanceSession).
    for (const row of candidates) {
      const startId = row.startId ?? null, key = homeKey(row.home);
      const prior = note.refused.find((r) => r.home === key && (r.startId ?? null) === startId);
      const record = seen.get(key), at = readHostStoppedAt(row.home, row, { now });
      const hostStoppedAt = at !== null && at <= Date.parse(record?.firstNotRunningAt) ? at : null;
      const fit = resumeEligible(record, row, { now, hostStoppedAt });
      const busy = lifecycleBusy(row);
      // A recorded stop of this start with the host is administrative, not another crash.
      // Keep the crash budget, but neither charge a successful restore nor let it prevent one.
      if (hostStoppedAt !== null) hostStopped.add(key);
      if (busy) rows.push({ ...base(row), outcome: OUTCOME.SKIPPED, reason: ROW_REASON.LIFECYCLE_BUSY, message: busy });
      else if (!fit.eligible) rows.push({ ...base(row), outcome: OUTCOME.SKIPPED, reason: ROW_REASON.NOT_SEEN_RECENTLY, message: `${row.instance} is not resumed automatically: ${fit.why}; start it by hand (oats session start --resume --home ${row.home}) if it should run` });
      else if (prior && now < retryDueAt(prior)) rows.push({ ...base(row), outcome: OUTCOME.REFUSED, reason: ROW_REASON.START_REFUSED_RETRYING, code: prior.code, message: prior.message, nextAttemptAt: iso(retryDueAt(prior)) });
      else if (!hostStopped.has(key) && inWindow(note.starts[key], now).length >= RESUME_LIMIT) {
        const counted = inWindow(note.starts[key], now), again = iso(Date.parse(counted[0]) + RESUME_WINDOW_MS);
        const hour = spentHours(note.spent[key], counted[0]);
        if (!plan && (note.spent[key]?.since !== hour.since || note.spent[key]?.hours !== hour.hours)) marked[key] = hour;
        const by = `start it by hand (oats session start --resume --home ${row.home})`;
        if (hour.hours >= RESUME_SPENT_HOURS) {
          givenUp.add(row.home);
          rows.push({ ...base(row), outcome: OUTCOME.REFUSED, reason: ROW_REASON.KEEPS_GETTING_LOST, message: `${row.instance} was resumed ${counted.length} times an hour for ${hour.hours} hours in a row and was lost again each time; no sweep starts it again: ${by}` });
        } else rows.push({ ...base(row), outcome: OUTCOME.REFUSED, reason: ROW_REASON.KEEPS_GETTING_LOST, nextAttemptAt: again, message: `${row.instance} was resumed ${counted.length} times in the last hour and was lost again each time; a sweep starts it again after ${again}, or ${by}` });
      }
      else if (plan) rows.push(predicted(row, env));
      else { toStart.push(row); if (prior) refusedBefore.set(key, prior); }
    }
    if (Object.keys(marked).length) noteSweep({ spent: marked }, boot, now);
    // Each start's answer is noted as it comes, under the lock (noteSweep is synchronous: two answers
    // never interleave in it), before the sweep waits on the others. A note that cannot be written
    // takes no more home; the lock is held until every start already running has answered, and the
    // failure is the sweep's after that.
    let noteFailure = null;
    const hostWide = new Set();
    const started = (await inBatches(toStart, RESUME_CONCURRENCY, async (row) => {
      const answer = await start(row);
      for (const w of hostWarnings(answer)) hostWide.add(w);
      // A home removed between the read and its start (a retire finished in between) is not lost:
      // whatever its start answered.
      const gone = answer?.ok !== true && !existsSync(row.home);
      const key = homeKey(row.home);
      // A refusal is noted with how many times this home and start were refused, which sets when a
      // sweep tries it again; the row says when.
      const refusal = { home: key, startId: row.startId ?? null, at: iso(Date.now()), attempts: (refusedBefore.get(key)?.attempts ?? 0) + 1 };
      const from = gone ? { ...base(row), outcome: OUTCOME.SKIPPED, reason: ROW_REASON.NOT_LOST, ...(typeof answer?.error?.code === "string" ? { code: answer.error.code } : {}) } : rowFromStart(row, answer);
      const answered = from.outcome === OUTCOME.REFUSED && boot ? { ...from, nextAttemptAt: iso(retryDueAt(refusal)) } : from;
      try {
        noteSweep({
          refusals: answered.outcome === OUTCOME.REFUSED ? [{ ...refusal, code: answered.code, message: answered.message }] : [],
          launched: LAUNCHED.has(answered.outcome) && (!hostStopped.has(key) || answered.outcome === OUTCOME.BLOCKED) ? [key] : [],
        }, boot);
      } catch (e) { noteFailure ??= e; }
      return answered;
    }, () => noteFailure !== null || !hostRunAdmissionOpen())).filter(Boolean);
    rows.push(...started);
    // A home this sweep started is recorded as seen running for its new start. Only a listing
    // writes that record (recordSeen), and a home lost again before the next listing would have
    // none for its start: no later sweep would resume it, and its starts would never be counted.
    const launchedIn = new Map();
    for (const r of started) if (r.outcome === OUTCOME.RESUMED || r.outcome === OUTCOME.FRESH) launchedIn.set(r.deployment, (launchedIn.get(r.deployment) ?? new Set()).add(r.home));
    for (const [dir, homes] of launchedIn) {
      const root = join(dir, "agents");
      try { recordSeen(root, listInstances(root).flatMap((a) => a.instances || []).map((i) => (homes.has(i.home) ? { ...i, running: true } : i)), { boot }); } catch { /* the next listing records it */ }
    }
    // Each lost home this sweep answered is judged, but for the rows of NOT_JUDGED: no later sweep
    // resumes a judged loss (a status read never uses one up). A plan judges nothing.
    if (!plan) {
      const lost = new Set(candidates.map((c) => c.home)), byDeployment = new Map();
      for (const r of rows) if (lost.has(r.home) && (!NOT_JUDGED.has(r.reason) || givenUp.has(r.home))) byDeployment.set(r.deployment, [...(byDeployment.get(r.deployment) ?? []), { home: r.home, startId: candidates.find((c) => c.home === r.home).startId ?? null, outcome: r.outcome }]);
      for (const [dir, judged] of byDeployment) judgeLosses(join(dir, "agents"), judged, { boot });
    }
    if (noteFailure) throw noteFailure;
    rows.sort((a, b) => (a.deployment < b.deployment ? -1 : a.deployment > b.deployment ? 1 : a.home < b.home ? -1 : a.home > b.home ? 1 : 0));
    return { schemaVersion: RESUME_SCHEMA, plan: !!plan, deployments, rows, ...(hostWide.size ? { warnings: [...hostWide].sort() } : {}) };
  } finally { release?.(); }
}

/** Why a lost home's status row says OATS is stopping, upgrading, retiring or starting it (a
 *  holder's verb, claimAction: a start holder's home is skipped, never judged lost), or that its
 *  retire is owed, as one line; null when it says none of that. Read only: the row's `retire` (any
 *  value: running, unknown, failed, interrupted) or `retirePending`, then the holder of the home's lifecycle claim,
 *  alive or of a liveness that cannot be read (homeClaimHolder). A holder that is gone is not one:
 *  the start takes its claim over. */
function lifecycleBusy(row) {
  if (row.retire || row.retirePending) return owedRetireSaid(row.instance, row.retire?.state ?? "unknown");
  const held = homeClaimHolder(row.home);
  if (!held || held.state === "gone") return null;
  return `${row.instance} is held by ${held.state === "alive" ? "a" : "what may still be a"} ${held.action} (${held.lock}); that command decides what the home is next`;
}

/** `--plan`'s prediction for a lost home, from what its start would check, read only: refused for a
 *  home with no recipe, a reference not set in `env` (the environment each start gets) or one whose
 *  value changed since the start it would bring back (lib/start-env.mjs, the start's own check), else
 *  resumed or fresh as the conversation lookup reads now, with the start's warning when its launch
 *  environment has no record to check. */
function predicted(row, env) {
  const refused = (code, message) => ({ ...base(row), outcome: OUTCOME.REFUSED, reason: ROW_REASON.START_REFUSED, code, message });
  if (!(row.launch && typeof row.launch === "object")) return refused("E_LAUNCH_LEGACY", `${row.instance} records no launch recipe (an earlier kernel spawned it): re-spawn it from the deployment`);
  const missing = missingLaunchEnvRefs(row.launch.env, env);
  if (missing.length) return refused("E_LAUNCH_ENV_MISSING", launchEnvMissingMessage(missing, row.launch.harness));
  const refs = launchEnvRefs(row.launch, env);
  const fit = checkStartEnv(row.home, row.startId ?? null, refs.map((r) => r.source), Object.fromEntries(refs.map((r) => [r.source, r.value])));
  if (fit.changed) return refused("E_LAUNCH_ENV_CHANGED", launchEnvChangedMessage(fit.changed));
  const extra = fit.unverified ? { warnings: [launchEnvUnverifiedWarning(row.instance)] } : {};
  const found = resumeConversation(row.home, row);
  return found.sessionId ? { ...base(row), outcome: OUTCOME.RESUMED, sessionId: found.sessionId, ...extra } : { ...base(row), outcome: OUTCOME.FRESH, reason: found.reason, ...extra };
}
