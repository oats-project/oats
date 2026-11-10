/** K3 transactions: immutable admitted plan -> one explicit confirmation intent.
 * No direct Git, kernel import, PID/tmux control or legacy mutation fallback.
 *
 * A client makes its own boundary (createLifecycleBoundary, with its own terms) and owns it; this home makes
 * none, and two boundaries share nothing. What a boundary holds, it holds for its own client's requests only:
 * its limits (32 plans, 4 plan reads, a plan for 5 minutes, a kept answer for 30) and "one apply at a time".
 * Between two clients, or between a client and `oats` run by hand, the kernel's answers are what holds: from
 * OATS 0.52.0 (feature lifecycle-claim-stop) a stop and a retire of one home refuse each other before any
 * effect; a start, `oats worktree add` and a status read still do not see a retire in flight (#866). A boundary
 * made again (the Desktop's backend restarted) knows no plan of the one before it: applying one answers
 * E_PLAN_EXPIRED. */
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { admitInstance, instanceSelector } from './instance-admission.mjs';
import { cliLifecycle } from './lifecycle-cli.mjs';
import { gitTargetKey } from './instance-git-contract.mjs';
import { hostReason } from './remote-address.mjs';
import { displayLine } from './display-text.mjs';
import { object, lifecycleOptions, lifecyclePlan, lifecycleReceipt, stoppedTargets, planReference, lifecycleChoicesApplicable,
  lifecycleFailure, lifecycleReason, lifecycleDetailCode, answeringFeatures, busyHolder, busyHeadline, busyAbout, undescribedAnswer } from './lifecycle-contract.mjs';
import { requireTerms } from './client-terms.mjs';
const clone = value => structuredClone(value);
const cliIdentity = cli => JSON.stringify([cli?.bin, cli?.version, cli?.lifecycleApi,
  Array.isArray(cli?.features) ? [...cli.features].sort() : null]);
export function supportsLifecycle(cli, operation, apply = false) {
  return cli?.ok === true && cli.lifecycleApi === 1 && Array.isArray(cli.features)
    && cli.features.length <= 128 && cli.features.every(f => typeof f === 'string')
    && cli.features.includes('lifecycle-plans')
    && (!apply || operation !== 'retire' || cli.features.includes('retire-retention') && cli.features.includes('retire-home'));
}
/** The codes of an apply's error answer that Desktop reads as "refused, nothing was done to the instance",
 * for a stop and for a retire alike. Every other code is an unknown outcome. Exported so that the kernel's
 * tests can hold this list inside the kernel's own list of the codes it answers only before any effect: a
 * code joins here only once the kernel promises that of it. The promise is about the instance (its sessions,
 * its home), not about the workspace log: a guarded retire may have appended its plan's event there by then,
 * so no sentence built on this list says that nothing was recorded. A routed command's router refuses
 * E_REMOTE_INCOMPATIBLE, E_AMBIGUOUS and E_SNAPSHOT_UNKNOWN before sending, and the host's own resolution
 * refuses them (and E_HOME_MISMATCH) before any effect. E_PLAN_STALE is not here: it is read by its own branch
 * (interpret), by the shape of the answer, never by this set. */
export const BEFORE_EFFECT_CODES = Object.freeze(['E_BAD_ARGS', 'E_USAGE', 'E_INSTANCE_RETIRING', 'E_LIFECYCLE_BUSY',
  'E_HOME_MISMATCH', 'E_SESSION_UNKNOWN', 'E_AMBIGUOUS_INSTANCE', 'E_UNIDENTIFIED_INSTANCE_HOME', 'E_REMOTE_INCOMPATIBLE', 'E_AMBIGUOUS', 'E_SNAPSHOT_UNKNOWN']);
/** The installed CLI printed this error envelope: the kernel answered. Said by the adapter where it builds
 * the envelope (`origin`), never inferred from the envelope's shape: the adapter's own failures and this
 * boundary's have the same shape, and no origin. */
const kernelAnswered = envelope => envelope?.origin === 'kernel' && envelope.schemaVersion === 1 && envelope.ok === false;
/** A failed command's reason. Remote: the host's code and message under its headline. Local: the fixed
 * sentence for `code`, and the kernel's own message beside it as `detail`, through the display filter, only
 * when the kernel answered (kernelAnswered) and the code may show one (lifecycleDetailCode: it has its own
 * sentence and is not one Desktop raises). Otherwise the reason is `{code, message}` alone.
 * A code the kernel answered that has no sentence keeps its own code and reads by the fallback sentence
 * (undescribedAnswer), with the kernel's message as its detail: "OATS couldn't be run for this." is never
 * the sentence for an answer the kernel gave. A code that did not come from the kernel never reaches it.
 * A kernel's E_LIFECYCLE_BUSY whose kernel (`features`: the answering kernel's) says who holds the claim
 * reads by that (`holder`, busyHolder), local or remote, and names the target of `plan` the refusal is
 * about when that is not the instance acted on (`about`). */
function failureReason(envelope, remote, terms, { code = envelope?.error?.code, features = null, plan = null } = {}) {
  const kernel = kernelAnswered(envelope), undescribed = kernel ? undescribedAnswer(code, terms) : null;
  const reason = undescribed || lifecycleReason(code, terms), details = envelope?.error?.details;
  const holder = kernel ? busyHolder(code, details, features) : null, about = holder ? busyAbout(plan, details?.home) : null;
  const busy = holder ? { holder, ...(about ? { about } : {}) } : {};
  const message = holder ? busyHeadline(holder) : reason.message;
  if (remote) { const host = hostReason({ ...envelope?.error, code }, remote.label, message); return host ? { ...host, ...busy } : reason; }
  const detail = kernel && (undescribed || lifecycleDetailCode(code)) ? displayLine(envelope.error?.message) : null;
  return { ...reason, message, ...(detail ? { detail } : {}), ...busy };
}
/** How long a boundary waits for an apply's answer. The wait ends; the apply does not (lifecycle-cli.mjs). */
export const APPLY_WAIT_MS = 600_000;
/** One client's lifecycle boundary: `lifecycleRequest(request, getContext)`, a plan or an apply.
 *   invoke  the CLI call (lifecycle-cli.mjs `cliLifecycle`); now  the clock of its limits (ms, monotonic)
 *   clock   the wall clock (ms since the epoch), for when a running apply started (`running.since`)
 *   after   `after(ms, fn)` runs fn once after ms and answers a cancel; mint  the reference and key maker
 *   terms   the client's own (client-terms.mjs): every reason is worded with them; required
 *   exec    optional: the client's own execFile, passed to `invoke` as `invoke(bin, args, { exec })` for the plan
 *           read and for the apply alike; without it `invoke` is given no third argument and cliLifecycle's own
 *           defaults run. A given exec runs every call cliLifecycle hands it; one with `detached: true` is an apply,
 *           which it runs in a session of its own (as execFileInSession does) and never ends, neither at a deadline
 *           nor by a signal to its group.
 * An apply's answer is awaited APPLY_WAIT_MS. When that passes the boundary answers `unknown` and the apply stays
 * in flight here: its reference, its key, its place as the one apply. Its answer, whenever it comes, is read and
 * kept 30 minutes like any other; the same reference meanwhile is answered at once (`unknown` while it runs, the
 * kept answer with `repeated` after). The cost: a CLI that never answers holds this client's applies until the
 * client is restarted; killing it instead could strand the instance (#889; a stop on a kernel before 0.52.0).
 * Every reply given because this client's own apply is running carries `running: { target, operation, since }`:
 * the busy refusal of another apply, and the `unknown` of that apply after its wait. The kernel's own
 * E_LIFECYCLE_BUSY never carries it, and this client's busy refusal carries no `details`, so the kernel's busy
 * holder (lifecycle-contract.mjs busyHolder) is never read of it.
 * `getContext()` is read at every admission and answers the deployment the request names and what this
 * client holds of it: `{ workspace: { id, scope, remote?, group? }, cli, localCwd, instances }`. `group` is
 * the workspace's roster group (its `probe` says which features a routed command's host answers with,
 * lifecycle-contract.mjs `answeringFeatures`); `instances` are that deployment's own rows. */
export function createLifecycleBoundary({ invoke = cliLifecycle, now = () => performance.now(), clock = () => Date.now(), mint = () => randomBytes(32).toString('hex'),
  after = (ms, fn) => { const timer = setTimeout(fn, ms); timer.unref?.(); return () => clearTimeout(timer); }, terms, exec } = {}) {
  requireTerms(terms, 'createLifecycleBoundary');
  // The CLI call, with the client's exec when it gave one: the same exec for a plan read and an apply.
  const call = (bin, args) => (exec ? invoke(bin, args, { exec }) : invoke(bin, args));
  const plans = new Map(), actions = new Map(), reads = new Map(), beforeEffect = new Set(BEFORE_EFFECT_CODES);
  let reservedPlans = 0, activeApply = null;
  const sweep = () => { for (const map of [plans, actions]) for (const [key, value] of map) {
    if (!value.pending && value.expires <= now()) map.delete(key);
  } };
  const denied = (code, target = null, extra = {}) => lifecycleFailure(code, terms, { target, ...extra });
  function admitted(selector, operation, getContext, apply = false) {
    const context = getContext();
    const result = admitInstance(selector, { ...context, operation: 'lifecycle-plans' });
    if (result.code) return { failure: denied(result.code, result.target, result.reason ? { reason: result.reason } : {}) };
    if (!supportsLifecycle(context.cli, operation, apply)) return { failure: denied('E_LIFECYCLE_UNAVAILABLE', result.target) };
    // Which kernel answers the command this read admits: its features decide how its answer is read.
    return { ...result, identity: cliIdentity(context.cli),
      features: answeringFeatures({ cli: context.cli, routed: !!result.remote, group: context.workspace?.group }) };
  }
  const same = (a, b) => !b.failure && a.bin === b.bin && a.context === b.context && a.identity === b.identity && gitTargetKey(a.target) === gitTargetKey(b.target);
  function storePlan(plan, selection, choices) {
    if (plans.size + reservedPlans >= 32) return null;
    const id = mint(); if (!planReference(id) || plans.has(id) || actions.has(id)) return null;
    const entry = { target: clone(selection.target), context: selection.context, scope: selection.scope, remote: selection.remote ? clone(selection.remote) : null, bin: selection.bin,
      identity: selection.identity, selector: clone(selection.selector), choices: clone(choices), plan: clone(plan), id, expires: now() + 300_000 };
    plans.set(id, entry); return entry;
  }
  const displayed = (entry, status = 'plan', reason = null) => ({ lifecycleApi: 1, status, target: entry.target, planRef: entry.id,
    plan: entry.plan, options: entry.choices, receipt: null, reason });
  async function plan(request, getContext) {
    const choices = lifecycleOptions(request.operation, request.options);
    if (!choices || !instanceSelector(request.selector) || Object.keys(request).some(k => !['action', 'operation', 'selector', 'options'].includes(k))) return denied('E_BAD_ARGS');
    const selected = admitted(request.selector, request.operation, getContext);
    if (selected.failure) return selected.failure;
    if (plans.size + reservedPlans >= 32) return denied('E_LIFECYCLE_BUSY', selected.target);
    const key = JSON.stringify([selected.identity, selected.context, gitTargetKey(selected.target), request.operation, choices]);
    if (!reads.has(key) && reads.size >= 4) return denied('E_LIFECYCLE_BUSY', selected.target);
    if (!reads.has(key)) {
      const args = { operation: request.operation, phase: 'plan', instance: selected.target.instance, home: selected.target.home, context: selected.context,
        ...(selected.remote ? { server: selected.remote.server } : {}), choices };
      const pending = Promise.resolve().then(() => call(selected.bin, args)).catch(() => ({ ok: false, error: { code: 'E_CLI_FAILED' } })).finally(() => reads.delete(key));
      reads.set(key, pending);
    }
    reservedPlans++;
    let envelope;
    try { envelope = await reads.get(key); } finally { reservedPlans--; }
    // The CLI read can be shared, but each confirmation gets its OWN ref/key.
    const current = admitted(request.selector, request.operation, getContext);
    if (!same(selected, current)) return denied('E_PLAN_CHANGED', selected.target);
    if (envelope?.schemaVersion !== 1 || envelope.ok !== true) {
      const code = envelope?.error?.code || 'E_CLI_PROTOCOL';
      return denied(code, selected.target, { reason: failureReason(envelope, selected.remote, terms, { code, features: selected.features }) });
    }
    // The plan is read by the features of the kernel that made it: for a relayed plan its host's, never this computer's.
    const data = lifecyclePlan(envelope.result, selected.target, request.operation, choices, { features: selected.features });
    if (!data) return denied('E_CLI_PROTOCOL', selected.target);
    const entry = storePlan(data, { ...selected, scope: getContext().workspace.scope, selector: clone(request.selector) }, choices);
    return entry ? displayed(entry) : denied('E_LIFECYCLE_BUSY', selected.target);
  }
  function interpret(envelope, entry, features) {
    const extra = { planRef: entry.id, options: entry.choices };
    const failure = (code, status, more = {}) => denied(code, entry.target, { ...extra, status, ...more });
    if (envelope?.schemaVersion !== 1 || typeof envelope.ok !== 'boolean') return failure('E_OUTCOME_UNKNOWN', 'unknown');
    // A failed retire can still carry a bounded incomplete-cleanup receipt.
    if (envelope.result) {
      const receipt = lifecycleReceipt(envelope.result, entry.plan, entry.key, { server: entry.remote?.server ?? null, features });
      if (!receipt) return failure('E_OUTCOME_UNKNOWN', 'unknown', { cause: lifecycleReason('E_CLI_PROTOCOL', terms) });
      const complete = receipt.action === 'stop' ? receipt.ok : receipt.removedDir && !receipt.incomplete;
      return { lifecycleApi: 1, status: receipt.deferred ? 'pending' : complete ? 'complete' : 'partial', target: entry.target, planRef: entry.id,
        options: entry.choices, plan: null, receipt, reason: complete ? null : lifecycleReason(receipt.action === 'stop' ? 'E_SESSION_STOP_FAILED' : 'E_RETIRE_INCOMPLETE', terms) };
    }
    const code = envelope.error?.code;
    // E_PLAN_STALE means "nothing happened" only in its documented shape: the answer carries the fresh plan, which
    // is read for this target and act and offered for review. Any other E_PLAN_STALE (no plan, or one that does not
    // read) is an unknown outcome: a kernel before 0.52.0 could answer it planless after a guarded retire's hooks had
    // run (#895). The boundary reads only the shape: an E_PLAN_STALE that carried a valid plan after an effect
    // could not be told apart by any client.
    if (code === 'E_PLAN_STALE') {
      const fresh = lifecyclePlan(envelope.error?.details?.plan, entry.target, entry.plan.action, entry.choices, { features });
      if (!fresh) return failure('E_OUTCOME_UNKNOWN', 'unknown', { cause: lifecycleReason('E_CLI_PROTOCOL', terms) });
      const replacement = storePlan(fresh, entry, entry.choices);
      return replacement ? displayed(replacement, 'stale', lifecycleReason(code, terms)) : failure(code, 'stale', { plan: fresh });
    }
    if (code === 'E_CHILDREN_RUNNING' && entry.plan.action === 'retire') {
      const fresh = lifecyclePlan(envelope.error?.details?.plan, entry.target, 'retire', entry.choices, { features });
      const childrenStopped = fresh && stoppedTargets(envelope.error?.details?.childrenStopped, fresh.facts.children, false, { features });
      if (!childrenStopped || childrenStopped.every(c => c.ok)) return failure('E_OUTCOME_UNKNOWN', 'unknown');
      // This is the attempted plan, NOT a new executable confirmation: some
      // children have already stopped. The user must explicitly read a new plan.
      return failure(code, 'refused', { plan: fresh, childrenStopped });
    }
    if (beforeEffect.has(code)) return failure(code, 'refused', { reason: failureReason(envelope, entry.remote, terms, { features, plan: entry.plan }) });
    return failure('E_OUTCOME_UNKNOWN', 'unknown', { cause: failureReason(envelope, entry.remote, terms, { features }) });
  }
  /** The apply of this client that is running, as a reply names it. */
  const runningOf = entry => ({ target: clone(entry.target), operation: entry.plan.action, since: entry.started });
  function apply(request, getContext, ws) {
    if (Object.keys(request).some(k => !['action', 'planRef'].includes(k)) || !planReference(request.planRef)) return Promise.resolve(denied('E_BAD_ARGS'));
    const entry = actions.get(request.planRef) || plans.get(request.planRef);
    if (!entry) return Promise.resolve(denied('E_PLAN_EXPIRED'));
    const context = getContext();
    if (!context.workspace || context.workspace.id !== ws || ws !== entry.target.workspace || context.workspace.scope !== entry.scope
      || cliIdentity(context.cli) !== entry.identity
      || !supportsLifecycle(context.cli, entry.plan.action, true)) return Promise.resolve(denied('E_PLAN_CHANGED', entry.target));
    if (entry.pending) return entry.pending;
    if (entry.reply) return Promise.resolve({ ...entry.reply, repeated: true }); // no CLI, even if home was removed/recreated
    // Its wait has ended and its CLI still works: answered at once, never a second wait.
    if (entry.waited) return Promise.resolve(clone(entry.waited));
    // The 32-action cap is no running apply: that refusal names none.
    if (activeApply || actions.size >= 32) return Promise.resolve(denied('E_LIFECYCLE_BUSY', entry.target, activeApply ? { running: runningOf(activeApply) } : {}));
    if (!lifecycleChoicesApplicable(entry.plan, entry.choices)) return Promise.resolve(denied('E_OPTION_UNAVAILABLE', entry.target));
    const current = admitted(entry.selector, entry.plan.action, getContext, true);
    if (!same(entry, current)) return Promise.resolve(denied('E_PLAN_CHANGED', entry.target));
    // Reserve synchronously, before any awaited work. One ref = one submitted
    // intent; loss of an HTTP response cannot mint a second idempotency key.
    entry.key = mint(); entry.expires = Infinity; entry.started = clock(); activeApply = entry;
    plans.delete(entry.id); actions.set(entry.id, entry);
    const args = { operation: entry.plan.action, phase: 'apply', instance: entry.target.instance, home: entry.target.home,
      context: entry.context, ...(entry.remote ? { server: entry.remote.server } : {}), choices: clone(entry.choices), revision: entry.plan.planRevision, key: entry.key };
    let cancel = () => {};
    const answered = Promise.resolve().then(() => call(entry.bin, args)).then(result => interpret(result, entry, current.features))
      .catch(() => denied('E_OUTCOME_UNKNOWN', entry.target, { status: 'unknown', planRef: entry.id }))
      .then(result => { entry.reply = clone(result); return result; })
      .finally(() => { cancel(); entry.pending = null; entry.waited = null; entry.expires = now() + 30 * 60_000; if (activeApply === entry) activeApply = null; });
    // The wait ends; the apply does not. What is answered then is what a CLI that did not answer in time reads as.
    const waited = new Promise(resolve => { cancel = after(APPLY_WAIT_MS, () => resolve(null)); });
    entry.pending = Promise.race([answered, waited]).then(result => {
      if (result) return result;
      entry.pending = null;
      entry.waited = { ...interpret({ schemaVersion: 1, ok: false, error: { code: 'E_CLI_TIMEOUT' } }, entry, current.features), running: runningOf(entry) };
      return clone(entry.waited);
    });
    return entry.pending;
  }
  return async function lifecycleRequest(request, getContext) {
    try {
      sweep();
      if (!object(request) || !['plan', 'apply'].includes(request.action)) return denied('E_BAD_ARGS');
      const context = getContext();
      if (!context.workspace || typeof context.workspace.id !== 'string') return denied('E_WORKSPACE_UNKNOWN');
      return clone(await (request.action === 'plan' ? plan(request, getContext) : apply(request, getContext, context.workspace.id)));
    } catch { return denied('E_CLI_FAILED'); }
  };
}
