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
 *    hours after it was last seen running. Any other is `skipped`, `not-seen-recently`. A sweep that
 *    is not a plan judges each lost home it answered (`judgedBy`), so it is answered once.
 *  - Each home starts as a child process of this kernel (`session start --resume --home <home>
 *    --json`, its cwd the home's deployment), so each start resolves its own deployment's scope; at
 *    most RESUME_CONCURRENCY at once. A per-home failure is a row, never the sweep's failure.
 *  - One sweep per machine: the lock `session-resume/lock` under OATS_HOME_DIR (default ~/.oats),
 *    a claim (lib/claim.mjs, through lib/dir-lock.mjs) that names its holder by pid, process start
 *    and boot id; a lock whose holder is gone, or that was taken in another boot, is taken over at
 *    once. A second sweep answers E_RESUME_BUSY; a lock that needs a person, E_RESUME_LOCK_STUCK,
 *    which `oats doctor` reports too (acquireResumeLock, resumeLockProblem).
 *  - No retry storm. A loss the sweep answered is judged (above) and not started again, whatever the
 *    boot; one note per boot (`note.json`) backs that: a refused resume is noted, and a later sweep
 *    in the same boot reports it again (`refused-this-boot`) without starting it, also when its
 *    judgement was lost (a home whose start id changed since is not matched); and a home is started by sweeps at most RESUME_LIMIT
 *    times in a boot (counted by home: each start makes a new start id), then reported
 *    `keeps-getting-lost` without a start. A start counts when it launched something (`resumed`,
 *    `fresh`, `blocked`), noted as soon as that start has answered, so a sweep that is killed while
 *    other starts run has counted the ones that answered. `session start --resume` run by hand is
 *    neither bounded nor counted.
 *    Without a boot id (neither Linux nor macOS) nothing is noted or counted: each sweep tries again.
 *  The lock and the note are kernel-private, not a contract. `plan` predicts from the note, starting
 *  nothing, taking no lock and writing no note. */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { oatsError } from "./errors.mjs";
import { deploymentState, readDeploymentsDocument } from "./deployments.mjs";
import { acquireDirLock, dirLockHeld } from "./dir-lock.mjs";
import { homeClaimHolder, listInstances, missingLaunchEnvRefs, owedRetireSaid, resumeConversation } from "./core.mjs";
import { checkStartEnv, fromEnvNames, launchEnvChangedMessage, launchEnvMissingMessage, launchEnvUnverifiedWarning } from "./start-env.mjs";
import { FRESH_REASON, NOT_SWEPT, OUTCOME, RESUME_WAITING, ROW_REASON, SESSION_END } from "./session-resume-contract.mjs";
import { bootId, homeKey, judgeLosses, readSeen, resumeEligible, resumeStateDir } from "./session-seen.mjs";
import { isAgentScopeWarning } from "./tmux-server-scope.mjs";

export { bootId, resumeStateDir };

export const RESUME_SCHEMA = 1;
/** At most this many starts run at once. */
export const RESUME_CONCURRENCY = 4;
/** At most this many sweep starts of one home in one boot. */
export const RESUME_LIMIT = 3;
const lockPath = () => join(resumeStateDir(), "lock");
const notePath = () => join(resumeStateDir(), "note.json");

const readJson = (path) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; } };

/** Whether the sweep's lock record `holder` was taken in another boot than `boot`: its holder is
 *  gone then, whatever its pid reads as. A boot ends every process, and a pid and a start counted
 *  from the boot can both come again in the next (in a container, a boot is one run:
 *  lib/session-seen.mjs bootId). Without a boot id on either side the process alone is judged. */
const takenInAnotherBoot = (boot) => (holder) => Boolean(boot) && typeof holder.bootId === "string" && holder.bootId !== "" && holder.bootId !== boot;

/** A sweep's lock `path` that needs a person, found as lib/dir-lock.mjs says it (`why`, `found`) →
 *  what is said of it and what to do. A directory is the lock of a kernel that locked with one:
 *  nothing here tells whether that kernel's sweep runs, so it is the operator who removes it. */
function lockStuck(path, why, found) {
  return {
    lock: path, found,
    said: `the session resume lock ${path} cannot be taken (${why})`,
    remedy: found === "directory"
      ? `once no earlier oats is running on this machine, remove the directory ${path} and run it again`
      : `if no oats session resume is running on this machine, remove ${path} and run it again`,
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
    const stuck = lockStuck(path, why, found);
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
  const stuck = lockStuck(path, held.why, held.found);
  return { code: RESUME_LOCK_STUCK, message: `${stuck.said}: oats session resume starts nothing on this machine while it is there`, remedy: stuck.remedy };
}

/** This boot's note: `{ bootId, refused: [{ home, startId, code, message, at }], resumes: { <home>: n } }`,
 *  each home by its real path (lib/session-seen.mjs homeKey);
 *  empty for another boot's note, an unreadable one, or no boot id. */
export function readBootNote(boot = bootId()) {
  const note = boot ? readJson(notePath()) : undefined;
  if (!note || note.bootId !== boot) return { bootId: boot, refused: [], resumes: {} };
  const resumes = {};
  if (note.resumes && typeof note.resumes === "object" && !Array.isArray(note.resumes)) {
    for (const [home, n] of Object.entries(note.resumes)) if (Number.isSafeInteger(n) && n > 0) resumes[home] = n;
  }
  return { bootId: boot, refused: Array.isArray(note.refused) ? note.refused.filter((r) => r && typeof r.home === "string") : [], resumes };
}
/** Note a sweep's `refusals` (each replacing its home's earlier entry) and the `launched` homes (each
 *  counted once more) for this boot; another boot's note is replaced whole. Nothing is written
 *  without a boot id. */
export function noteSweep({ refusals = [], launched = [] }, boot = bootId()) {
  if (!boot || (!refusals.length && !launched.length)) return;
  const note = readBootNote(boot);
  const homes = new Set(refusals.map((r) => r.home));
  const resumes = { ...note.resumes };
  for (const home of launched) resumes[home] = (resumes[home] ?? 0) + 1;
  const path = notePath();
  mkdirSync(resumeStateDir(), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ bootId: boot, refused: [...note.refused.filter((r) => !homes.has(r.home)), ...refusals], resumes }, null, 2) + "\n", { mode: 0o600 });
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
 *  is that command's to decide. A loop guard's refusal (`keeps-getting-lost`) judges the loss like
 *  any refusal, and nothing brings it back automatically, a reboot included (decided for #1567);
 *  naming it here would let the next boot retry it. */
const NOT_JUDGED = new Set([ROW_REASON.LIFECYCLE_BUSY]);
/** The outcomes of a start that launched something: the ones RESUME_LIMIT counts. */
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
function runStart({ execPath, bin, env }, row) {
  return new Promise((done) => {
    execFile(execPath, [bin, "session", "start", "--resume", "--home", row.home, "--json"], { cwd: row.deployment, env: startEnvironment(env), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      let answer;
      try { answer = JSON.parse(String(stdout).trim().split("\n").pop()); } catch { answer = undefined; }
      if (!answer || typeof answer !== "object") answer = { ok: false, error: { code: "E_SESSION_START_FAILED", message: `the start exited${error?.code !== undefined ? ` with status ${error.code}` : ""}${error?.signal ? ` on ${error.signal}` : ""} without an answer` } };
      done(answer);
    });
  });
}
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
    const note = readBootNote(boot), now = Date.now();
    const toStart = [];
    // Precedence, the first that applies: not seen recently, refused this boot, keeps getting lost,
    // started. The record and the note name a home by its real path (homeKey), whatever spelling the
    // sweep was given; a row shows the path it listed.
    // A home OATS is stopping, upgrading or retiring, or whose retire is owed, comes first: nothing
    // is started there. This read is only a filter (the sweep is not atomic with it): the start's
    // own claim is what keeps a resume off such a home (lib/core.mjs startInstanceSession).
    for (const row of candidates) {
      const startId = row.startId ?? null, key = homeKey(row.home);
      const prior = note.refused.find((r) => r.home === key && (r.startId ?? null) === startId);
      const fit = resumeEligible(seen.get(key), row, { now });
      const busy = lifecycleBusy(row);
      if (busy) rows.push({ ...base(row), outcome: OUTCOME.SKIPPED, reason: ROW_REASON.LIFECYCLE_BUSY, message: busy });
      else if (!fit.eligible) rows.push({ ...base(row), outcome: OUTCOME.SKIPPED, reason: ROW_REASON.NOT_SEEN_RECENTLY, message: `${row.instance} is not resumed automatically: ${fit.why}; start it by hand (oats session start --resume --home ${row.home}) if it should run` });
      else if (prior) rows.push({ ...base(row), outcome: OUTCOME.REFUSED, reason: ROW_REASON.REFUSED_THIS_BOOT, code: prior.code, message: prior.message });
      else if ((note.resumes[key] ?? 0) >= RESUME_LIMIT) rows.push({ ...base(row), outcome: OUTCOME.REFUSED, reason: ROW_REASON.KEEPS_GETTING_LOST, message: `${row.instance} was resumed ${note.resumes[key]} times in this boot and was lost again each time; no sweep starts this loss again: start it by hand (oats session start --resume --home ${row.home})` });
      else if (plan) rows.push(predicted(row, env));
      else toStart.push(row);
    }
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
      const answered = gone ? { ...base(row), outcome: OUTCOME.SKIPPED, reason: ROW_REASON.NOT_LOST, ...(typeof answer?.error?.code === "string" ? { code: answer.error.code } : {}) } : rowFromStart(row, answer);
      const key = homeKey(row.home);
      try {
        noteSweep({
          refusals: answered.outcome === OUTCOME.REFUSED ? [{ home: key, startId: row.startId ?? null, code: answered.code, message: answered.message, at: new Date().toISOString() }] : [],
          launched: LAUNCHED.has(answered.outcome) ? [key] : [],
        }, boot);
      } catch (e) { noteFailure ??= e; }
      return answered;
    }, () => noteFailure !== null)).filter(Boolean);
    rows.push(...started);
    // Each lost home this sweep answered is judged: no later sweep resumes this loss (a status read
    // never uses one up). A plan judges nothing.
    if (!plan) {
      const lost = new Set(candidates.map((c) => c.home)), byDeployment = new Map();
      for (const r of rows) if (lost.has(r.home) && !NOT_JUDGED.has(r.reason)) byDeployment.set(r.deployment, [...(byDeployment.get(r.deployment) ?? []), { home: r.home, startId: candidates.find((c) => c.home === r.home).startId ?? null, outcome: r.outcome }]);
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
  if (missing.length) return refused("E_LAUNCH_ENV_MISSING", launchEnvMissingMessage(missing));
  const fit = checkStartEnv(row.home, row.startId ?? null, fromEnvNames(row.launch.env), env);
  if (fit.changed) return refused("E_LAUNCH_ENV_CHANGED", launchEnvChangedMessage(fit.changed));
  const extra = fit.unverified ? { warnings: [launchEnvUnverifiedWarning(row.instance)] } : {};
  const found = resumeConversation(row.home, row);
  return found.sessionId ? { ...base(row), outcome: OUTCOME.RESUMED, sessionId: found.sessionId, ...extra } : { ...base(row), outcome: OUTCOME.FRESH, reason: found.reason, ...extra };
}
