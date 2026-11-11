/** lib/read-call.mjs — one call of a deployment read (awebai/oats#1630): the scope `oats status` and
 *  `oats workspace status` run in (lib/roster-read.mjs, lib/workspace-read.mjs), so that the CLI runs
 *  each once and a long-lived process answers them many times with the same code.
 *
 *  In a one-shot CLI, process exit is what forgets a read's state. A call does that itself: it starts
 *  by resetting every piece of module-level state its reads can reach (READ_STATE, which
 *  test/read-call-state.test.mjs pins against a scan of the reads' import closure), and ends by draining
 *  what its read session found worth telling the operator. A read answers `{ exit, answer, stderr }`:
 *  `answer` the JSON value the CLI prints, every refusal an answer too (refuse); `stderr` the read
 *  session's notices, as the CLI says them. Each read has a data layer beside it (`…View`): `view`, what
 *  bin's text renderer reads, in place of `answer`, without the JSON-only work.
 *
 *  The context: `dir` (absolute), `maxAge` (null, or the --max-age seconds: parseMaxAge), `session` (a
 *  function answering the caller's read session, created by callSession: the CLI's is created at its
 *  first remote read and carries the CLI's exit and signal listeners; a reader's is created at the start
 *  of the request), `cacheDir` (the remote cache, absolute, or none), and `deployments` (an observer of
 *  the deployment the call resolves, settled when the call ends; the CLI passes none and settles its own
 *  at exit, lib/resolved-deployment.mjs). A call registers no process listener and closes no session:
 *  the caller closes it. Nor does it read argv or the working directory: the caller owns the process's
 *  cwd, which still reaches the children the reads run by name (tmux, git: a relative or empty PATH entry
 *  is resolved against it), so a caller answering for a deployment runs the call with that deployment
 *  as its cwd, as the CLI does when run there. Kernel-private, not exported from `./core`. Dependency-free.
 */
import { resetRuntimeNames, runtimeNameWarning } from "./deprecation.mjs";
import { OWN_NAME_FAILURES } from "./errors.mjs";
import { activateLocalInputs, localRevision, resetLocalInputs } from "./local-inputs.mjs";
import { createReadSession, MAX_AGE_LIMIT, READ_REMOTE_BUDGET_MS, resetGitProbes, resetSshCommand } from "./remote.mjs";
import { observeResolvedDeployment, resetResolvedDeployment, settleResolvedDeployment } from "./resolved-deployment.mjs";

/** Every module-level binding the reads' import closure writes, and what a call does with it: `reset`
 *  (forgotten at the start of each call), `scoped` (set and ended by the call itself) or `safe` (kept
 *  across calls, and why that cannot change an answer). A binding the scan finds that is not here fails
 *  test/read-call-state.test.mjs, by module and name. */
export const READ_STATE = [
  { module: "lib/deprecation.mjs", binding: "sources", how: "reset", reset: resetRuntimeNames },
  { module: "lib/local-inputs.mjs", binding: "inputs", how: "reset", reset: resetLocalInputs },
  { module: "lib/remote.mjs", binding: "sshCommandCache", how: "reset", reset: resetSshCommand },
  { module: "lib/remote.mjs", binding: "gitVersions", how: "reset", reset: resetGitProbes },
  { module: "lib/remote.mjs", binding: "protocolPins", how: "reset", reset: resetGitProbes },
  { module: "lib/resolved-deployment.mjs", binding: "reported", how: "reset", reset: resetResolvedDeployment },
  { module: "lib/resolved-deployment.mjs", binding: "observer", how: "scoped", why: "set and settled by the call when it is given `deployments`; else the CLI's own, settled at exit" },
  { module: "lib/remote.mjs", binding: "liveChildren", how: "safe", why: "a registry of live git process groups, each leaving on 'close': empty once a call's session is closed, never cleared (that would lose exit reaping)" },
  { module: "lib/remote.mjs", binding: "cacheLocks", how: "safe", why: "an in-process mutex per cache repo; an entry is removed when its holder releases it" },
  { module: "lib/remote.mjs", binding: "fingerprintMemo", how: "safe", why: "the kernel code's fingerprint, install data: a process that runs a changed install exits first (the warm reader's install stamp)" },
  { module: "lib/dir-lock.mjs", binding: "sections", how: "safe", why: "how many locked sections run now: a section is synchronous, so it is 0 between calls" },
  { module: "lib/dir-lock.mjs", binding: "listening", how: "safe", why: "whether the lock's signal listeners are on: they hold a signal back around a section and decide no answer" },
  { module: "lib/dir-lock.mjs", binding: "idle", how: "safe", why: "the pending removal of those listeners, run once the event loop turns" },
  { module: "packages/record/lib/process-identity.mjs", binding: "processBoot", how: "safe", why: "the boot id: a process never outlives its boot" },
  { module: "lib/session-viewer.mjs", binding: "probed", how: "safe", why: "only an attach's preparation reads it; readSessionViewer asks tmux -V at every call" },
  { module: "lib/session-viewer.mjs", binding: "onQuit", how: "safe", why: "only an attach (attachSessionTarget) sets it" },
  { module: "lib/session-viewer.mjs", binding: "quitHeld", how: "safe", why: "only an attach (attachSessionTarget) sets it" },
  { module: "lib/workspace.mjs", binding: "schemaCache", how: "safe", why: "compiled validators of the kernel's own schema files, install data: the warm reader's install stamp covers them" },
  { module: "lib/workspace.mjs", binding: "regexCache", how: "safe", why: "compiled patterns: a pure function of the pattern text" },
  { module: "lib/workspace.mjs", binding: "workspaceChecks", how: "safe", why: "a WeakMap keyed by a workspace value one call parsed: never reached by another call" },
  { module: "lib/workspace.mjs", binding: "memberRowIndex", how: "safe", why: "a WeakMap keyed by a discovery's members array one call built: never reached by another call" },
  { module: "lib/errors.mjs", binding: "answeredAfterEndedSteps", how: "safe", why: "a WeakSet of refusals one call made: never reached by another call" },
  { module: "lib/process-group.mjs", binding: "closedGroups", how: "safe", why: "a WeakSet of child processes: each one call's own" },
];

/** Forget the state of the last read: every `reset` row of READ_STATE, each reset once. */
export function resetReadState() {
  for (const reset of new Set(READ_STATE.map((row) => row.reset).filter(Boolean))) reset();
}

/** `--max-age <raw>` as the read verbs take it: `raw` the flag's value (true when it has none). → `{ maxAge }`,
 *  or `{ refusal: { code, message } }`. Which commands take the flag is the CLI's allow-list. */
export function parseMaxAge(raw) {
  if (raw === true) return { refusal: { code: "E_BAD_ARGS", message: `--max-age needs a value: whole seconds from 0 to ${MAX_AGE_LIMIT}` } };
  if (!/^\d{1,5}$/.test(raw) || Number(raw) > MAX_AGE_LIMIT) return { refusal: { code: "E_BAD_ARGS", message: `--max-age takes whole seconds from 0 to ${MAX_AGE_LIMIT}, got ${JSON.stringify(raw)}` } };
  return { maxAge: Number(raw) };
}

/** The remote budget of these reads (ms): READ_REMOTE_BUDGET_MS, or `OATS_READ_REMOTE_BUDGET_MS` from `env`
 *  when it is a positive integer (a test and ops override, not a contract). */
export function readBudget(env) {
  const override = Number(env.OATS_READ_REMOTE_BUDGET_MS);
  return Number.isSafeInteger(override) && override > 0 ? override : READ_REMOTE_BUDGET_MS;
}

/** The read session of one call: --max-age's reuse window (`maxAge`, null for none) and, with `budgetMs`, a
 *  deadline that far from now. */
export function callSession({ maxAge = null, budgetMs = null } = {}) {
  return createReadSession({ maxAge: maxAge ?? 0, ...(budgetMs !== null ? { deadline: Date.now() + budgetMs } : {}) });
}

/** A refusal of a read: the call answers it as the CLI's JSON failure, `{ schemaVersion: 1, ok: false,
 *  error: { code, message, details? } }` with the deprecated-name warning, and exit 1. */
class ReadRefusal extends Error {}
export function refuse(code, message, details) {
  throw Object.assign(new ReadRefusal(String(message)), { code, details });
}

/** The deprecated-name warning a JSON answer carries (lib/deprecation.mjs), as the envelope spreads it. */
export function answerWarnings() {
  const w = runtimeNameWarning();
  return w ? { warnings: [w] } : {};
}

/** Run one read: `body(call)` answers `{ answer }` or `{ view }`, or refuses (refuse). → `{ exit, answer,
 *  view?, stderr }`. A typed config-shape failure (lib/errors.mjs OWN_NAME_FAILURES) is answered as the
 *  CLI's dispatch answers it. Anything else is thrown, and the session's notices are left in it for the
 *  caller to say. */
export async function runRead(ctx, body) {
  const call = openCall(ctx);
  let result;
  try {
    result = { exit: 0, answer: null, ...(await body(call)) };
  } catch (e) {
    if (e instanceof ReadRefusal) result = { exit: 1, answer: failure(e.code, e.message, e.details) };
    else if (OWN_NAME_FAILURES.has(e?.code)) result = { exit: 1, answer: failure(e.code, e.message, e.details?.unconfirmed === true ? e.details : undefined) };
    else throw e;
  } finally {
    if (ctx.deployments) settleResolvedDeployment();
  }
  return { ...result, stderr: call.notices() };
}

/** A refusal answered before any read runs (a caller's own preamble: lib/reader.mjs), as runRead answers one. */
export function refusalAnswer(code, message, details) {
  return { exit: 1, answer: failure(code, message, details), stderr: "" };
}

function failure(code, message, details) {
  return { schemaVersion: 1, ok: false, error: { code, message: String(message), ...(details !== undefined ? { details } : {}) }, ...answerWarnings() };
}

function openCall({ maxAge = null, session, cacheDir, deployments }) {
  resetReadState();
  if (maxAge !== null) activateLocalInputs(); // observation.localRevision: every local config read from here on
  if (deployments) observeResolvedDeployment(deployments, { atExit: false });
  let used = null;
  const call = {
    maxAge,
    /** The caller's read session, asked for where the read first needs it. */
    session: () => (used ??= session()),
    /** The options every remote read of the call takes. */
    remoteOptions: () => ({ ...(cacheDir ? { cacheDir } : {}), session: call.session() }),
    /** The observation block: the heads' oldest observedAt and reuse, and the local configuration's revision. */
    observation: () => ({ ...call.session().observation(), localRevision: localRevision() }),
    /** A read verb's JSON with the observation block, only when --max-age was given (0 included). */
    withObservation: (doc) => (maxAge === null ? doc : { ...doc, observation: call.observation() }),
    /** What the session found worth telling the operator, taken out of it, as the CLI says it on stderr. */
    notices: () => (used?.notices.splice(0) ?? []).map((notice) => `oats: warning: ${notice}\n`).join(""),
  };
  return call;
}
