/** K3 projection/validation only. No IO, kernel decisions or executable paths. */
import { gitRevision } from './instance-git-contract.mjs';
import { displayLine, cleanLine, DETAIL_WITHHELD } from './display-text.mjs';
import { kernelCode } from './remote-address.mjs';
import { requireTerms } from './client-terms.mjs';
export const LIFECYCLE_API = 1;
export const MAX_LIFECYCLE_TARGETS = 128;
export const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
export const text = (v, max = 4096) => typeof v === 'string' && v.length <= max && !v.includes('\0')
  && !/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}|https?:\/\/[^/\s]+@/.test(v);
const nullable = v => v === null || text(v);
const absolute = v => text(v) && v.startsWith('/');
const count = v => Number.isSafeInteger(v) && v >= 0;
const numberOrNull = v => v === null || count(v);
export const planRevision = v => typeof v === 'string' && /^[a-f0-9]{24}$/.test(v);
export const planReference = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const at = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
const strings = v => Array.isArray(v) && v.length <= 64 && v.every(n => text(n));
const messages = {
  E_BAD_ARGS: 'Invalid lifecycle request.',
  // The kernel's, for a stop or a retire missing its argument (the usage line is its message). Answered only before any effect.
  E_USAGE: 'Invalid lifecycle request.', E_WORKSPACE_UNKNOWN: 'Choose an advertised workspace.',
  E_SESSION_UNKNOWN: 'This instance is no longer in the current roster.', E_AMBIGUOUS_INSTANCE: 'Select an exact instance home.',
  E_HOME_MISMATCH: 'The instance home no longer matches this selection.',
  // The kernel's, for a home it cannot work from: a record that is there and cannot be read, a rollback
  // marker that cannot drive a retry, or neither a record nor a cleanup descriptor. Answered only before any effect.
  E_UNIDENTIFIED_INSTANCE_HOME: "OATS couldn't find or read what it needs in this instance's home folder, so nothing was done.",
  'cli-unavailable': 'Choose a compatible installed OATS CLI.',
  E_LIFECYCLE_UNAVAILABLE: terms => `This OATS can't stop or retire instances from ${terms.name}. Update OATS.`,
  'unsupported-remote-operation': "This computer's OATS can't route this to the server. Update OATS here.",
  E_PLAN_REQUIRED: 'Open a fresh Stop or Retire confirmation; unguarded retirement is unavailable.',
  E_PLAN_EXPIRED: 'This confirmation expired. Review again to check the current state.',
  E_PLAN_CHANGED: 'The instance or OATS changed. Review again before confirming.',
  E_OPTION_UNAVAILABLE: 'Only an instance with its own worktree can delete it. Review the choice again.',
  E_PLAN_STALE: 'Something changed since you opened this. Review it and confirm again.',
  E_PLAN_LIMIT: terms => `This would act on more instances than ${terms.name} can show. Nothing was submitted.`,
  E_LIFECYCLE_BUSY: 'Another stop or retire is already running. Wait for it to finish, then review again.',
  E_INSTANCE_RETIRING: 'An instance in this plan is already being retired.',
  E_CHILDREN_RUNNING: "A child instance wouldn't stop, so nothing was retired. Other children may already have stopped.",
  E_SESSION_STOP_FAILED: "The session didn't stop in time. Nothing was forced.",
  E_WORK_PRESERVATION_FAILED: "Its work couldn't be saved safely, so the home folder is kept. Earlier retirement steps may have run.",
  E_WORK_INSPECTION_FAILED: "Retirement was refused: OATS couldn't inspect the instance's home or work. The home folder is kept; its session may already have been stopped, and earlier retirement steps may have run.",
  E_RETIRE_INCOMPLETE: "Retirement didn't finish cleaning up. Check what was kept before trying again.",
  // True of both things the kernel answers it for: a session window it could not show gone, and the hook
  // group an interrupted spawn left that survived both signals. The outcome is unknown; this is its cause.
  E_RUNTIME_QUIESCE_FAILED: "OATS tried to end a session or a process and couldn't confirm that it ended.",
  E_CLI_TIMEOUT: "OATS didn't answer in time.", E_CLI_OUTPUT_LIMIT: terms => `OATS's answer was larger than ${terms.name} reads safely.`,
  E_CLI_PROTOCOL: terms => `OATS answered in a form ${terms.name} can't read.`, E_CLI_FAILED: "OATS couldn't be run for this.",
  E_OUTCOME_UNKNOWN: "OATS didn't confirm the result. Check again before assuming nothing happened.",
};
/** Every code the table has a sentence for. */
export const LIFECYCLE_CODES = Object.freeze(Object.keys(messages));
/** The code as the table knows it: itself, or `E_CLI_FAILED` for one it has no sentence for. Needs no terms. */
export const lifecycleCode = code => (Object.hasOwn(messages, code) ? code : 'E_CLI_FAILED');
/** The code and its sentence, in the client's terms (client-terms.mjs): a sentence that names the client is
 * built from them. */
export function lifecycleReason(code, terms) {
  requireTerms(terms, 'lifecycleReason');
  const known = lifecycleCode(code), message = messages[known];
  return { code: known, message: typeof message === 'function' ? message(terms) : message };
}
/** A kernel's error answer whose code has no sentence here. It says "OATS answered", so it is chosen only
 * for a code read out of the kernel's own error envelope: by where the code came from, which only the caller
 * knows, never by the code's shape. lifecycleReason is given codes of every origin and keeps E_CLI_FAILED
 * ("OATS couldn't be run for this.") for one it does not know; that sentence is never shown for an answer
 * the kernel gave. It names the client that has no description, by the client's own `name`. */
const undescribed = terms => `OATS answered with an error that ${terms.name} has no description for.`;
/** The reason for a code the KERNEL answered and no sentence describes: its own code and the fallback
 * sentence, or null when the code has a sentence, or is not in the kernel's code shape (an older kernel's
 * system code, `ENOENT`, which keeps E_CLI_FAILED's sentence). The caller vouches for the origin. */
export function undescribedAnswer(code, terms) {
  requireTerms(terms, 'undescribedAnswer');
  return kernelCode(code) && !Object.hasOwn(messages, code) ? { code, message: undescribed(terms) } : null;
}
/** Re-validate a relayed reason (server → main → renderer) that reads by the fallback sentence, or null:
 * a kernel code without a sentence, the fixed fallback sentence, and a detail that is a display line (else
 * none). The reply's sentence is the server's word that the kernel answered; nothing else of it is shown.
 * `terms`: the reader's, which are the server's: the sentence compared is the one built from them. */
export function undescribedRefusal(reason, terms) {
  const fallback = undescribed(requireTerms(terms, 'undescribedRefusal'));
  return object(reason) && reason.message === fallback && undescribedAnswer(reason.code, terms)
    ? { code: reason.code, message: fallback, detail: cleanLine(reason.detail) ? reason.detail : null } : null;
}
/** Codes only Desktop raises (its CLI adapter, its lifecycle boundary, main): the kernel never answers with
 * one. A new entry of `messages` that the kernel does not raise is listed here too. */
const desktopCodes = new Set(['E_WORKSPACE_UNKNOWN', 'cli-unavailable', 'E_LIFECYCLE_UNAVAILABLE', 'unsupported-remote-operation',
  'E_PLAN_REQUIRED', 'E_PLAN_EXPIRED', 'E_PLAN_CHANGED', 'E_OPTION_UNAVAILABLE', 'E_PLAN_LIMIT',
  'E_CLI_TIMEOUT', 'E_CLI_OUTPUT_LIMIT', 'E_CLI_PROTOCOL', 'E_CLI_FAILED', 'E_OUTCOME_UNKNOWN']);
/** A code whose local failure may show the CLI's own message as a detail beside the fixed sentence: the
 * code has its own sentence and the kernel raises it. Never one of Desktop's own, whatever came with it;
 * a code without a sentence shows no CLI text either. */
export const lifecycleDetailCode = code => Object.hasOwn(messages, code) && !desktopCodes.has(code);
/** The kernel feature from which every E_LIFECYCLE_BUSY of a stop or a retire carries `error.details.holder`
 * (docs/desktop-cli-api.md): whether waiting ends the refusal, as data. */
const CLAIM_STOP_FEATURE = 'lifecycle-claim-stop';
/** E_LIFECYCLE_BUSY by who holds the claim. `headline` is the status line. `lead` introduces the kernel's own
 * sentence, shown under it as the main text: for these holders the kernel's message names the step that ends
 * the refusal, and Desktop shows the whole line, never a part of it. `running` promises that waiting ends
 * it, and is the only one that does; its kernel sentence stays in Details. `unstated`: the field is absent
 * or holds a value outside the kernel's list, read as the weaker claim. */
const BUSY = {
  running: { headline: 'Another OATS command is already running. Wait for it to finish, then review again.' },
  unknown: { headline: "Nothing was done. OATS can't tell whether another command is still running.", lead: 'It says what to check:' },
  none: { headline: 'Nothing was done, and there is no other command to wait for.', lead: 'OATS says what to do:' },
  unstated: { headline: 'Nothing was done: OATS refused this as busy.', lead: 'It says:' },
};
const HOLDERS = ['running', 'unknown', 'none'];
/** How a kernel's E_LIFECYCLE_BUSY is read: one of BUSY's keys, or null when the rule does not apply and
 * the code keeps its fixed sentence. For the kernel's own answer only (the caller says so; Desktop's own busy
 * carries no details), under that code only (`details.holder` on any other code means nothing to a client),
 * and only when `features` (the answering kernel's, answeringFeatures) names lifecycle-claim-stop: a kernel
 * without it answers the code for a command that may be running. */
export function busyHolder(code, details, features) {
  if (code !== 'E_LIFECYCLE_BUSY' || !names(features, CLAIM_STOP_FEATURE)) return null;
  return object(details) && HOLDERS.includes(details.holder) ? details.holder : 'unstated';
}
export const busyHeadline = holder => BUSY[holder].headline;
/** The target of a stop plan that a home names, when it is not the instance acted on: `{instance, home}`,
 * else null. The `details` of a stop's claim refusal are of the target whose claim refused, which in a
 * recursive stop may be a child. Matched by home against the plan's own targets, so a name shown is always
 * one the plan already showed. */
export function busyAbout(plan, home) {
  if (!object(plan) || plan.action !== 'stop' || typeof home !== 'string' || home === plan.home) return null;
  const target = plan.targets.find(t => t.home === home);
  return target ? { instance: target.instance, home: target.home } : null;
}
/** Re-validate a relayed busy reason (server → main → renderer) that says who holds, or null: the reason then
 * reads by its code's fixed sentence. `{ headline, about, lead, sentence, details }`, each a line or null,
 * in the order they are shown: the headline; `about`, when the refusal is of another target of `plan` (the
 * reader's own plan snapshot: a name that is not in it is not shown); then `lead` and the kernel's `sentence`
 * as the main text. A sentence the display filter withheld, or one that is not there, is not introduced:
 * no lead, and `details` holds what Details shows (the code and the filter's line), as for any other code.
 * The headline is chosen here from `holder`; the reply's `message` is never shown. */
export function busyRefusal(reason, plan = null) {
  if (!object(reason) || reason.code !== 'E_LIFECYCLE_BUSY' || !Object.hasOwn(reason, 'holder') || typeof reason.holder !== 'string' || !Object.hasOwn(BUSY, reason.holder)) return null;
  const { headline, lead } = BUSY[reason.holder], detail = cleanLine(reason.detail) ? reason.detail : null;
  const target = object(reason.about) ? busyAbout(plan, reason.about.home) : null;
  const about = target && target.instance === reason.about.instance ? `This is about ${target.instance}, which is in this plan.` : null;
  const main = !!lead && !!detail && detail !== DETAIL_WITHHELD;
  return { headline, about, lead: main ? lead : null, sentence: main ? detail : null, details: !main && detail ? { code: reason.code, detail } : null };
}
export function lifecycleFailure(code, terms, extra = {}) {
  requireTerms(terms, 'lifecycleFailure');
  return lifecycleFailureOf(lifecycleReason(code, terms), extra);
}
/** A lifecycle failure whose reason is ready: one a client words itself, for a code of its own that the shared
 * table does not know (the Desktop's frame guard). It words nothing, so it takes no terms. */
export function lifecycleFailureOf(reason, extra = {}) {
  return { lifecycleApi: LIFECYCLE_API, status: 'unavailable', target: null, planRef: null, plan: null, receipt: null, reason, ...extra };
}
export function lifecycleOptions(operation, v) {
  if (!object(v)) return null;
  if (operation === 'stop' && Object.keys(v).length === 1 && Object.hasOwn(v, 'recursive') && typeof v.recursive === 'boolean') return { recursive: v.recursive };
  // Retire has one choice, the worktree. It never deletes a branch: any other key is refused.
  if (operation === 'retire' && Object.keys(v).length === 1 && Object.hasOwn(v, 'discardWorktree')
    && typeof v.discardWorktree === 'boolean') return { discardWorktree: v.discardWorktree };
  return null;
}
/** Whether the choices made for `plan` apply to it. A stop's always do. Deleting the worktree applies only to
 * an instance's own tree (ownWorktreeOf). */
export function lifecycleChoicesApplicable(plan, choices) {
  if (plan.action === 'stop') return true;
  return !choices.discardWorktree || ownWorktreeOf(plan).own;
}
/** The kernel feature from which a retire plan says as a fact whether `work/` is the instance's own work
 * tree, the one the retire keeps or deletes: `facts.ownWorktree`, a boolean (docs/desktop-cli-api.md, the
 * retire plan). A stop plan does not carry it. */
export const OWN_WORKTREE_FEATURE = 'retire-plan-own-worktree';
/** A retire plan's `facts.ownWorktree` as the answering kernel's `features` (answeringFeatures) have it read:
 * `{ value }` when it is read, `{}` when the plan has none, `null` for a malformed plan.
 *   the kernel lists the feature   the key is required and a boolean: anything else is no plan, as every
 *                                  other malformed fact (a plan authorizes a removal: no fallback to the record);
 *   it does not list it            the key is not read, whatever it holds;
 *   its features are not known     the key is read when it is there as a boolean, else the plan has none.
 * "Not known" is anything but a list: null, nothing, and the renderer's second pass over a plan the server
 * already read, which holds the key exactly when the server read it. */
function ownWorktreeFact(facts, features) {
  const known = Array.isArray(features), listed = known && features.includes(OWN_WORKTREE_FEATURE);
  if (known && !listed) return {};
  if (typeof facts.ownWorktree === 'boolean') return { value: facts.ownWorktree };
  return listed ? null : {};
}
/** Whether `work/` is the instance's own work tree, the one a retire keeps or deletes, from a retire plan
 * that lifecyclePlan read: `{ own, from }`.
 *   from 'fact'    the plan holds `facts.ownWorktree`, the kernel's answer of the one reading of `work/` its
 *                  retire acts on. `own` is that boolean, whatever the record says.
 *   from 'record'  the plan holds none (a kernel that does not list the feature), and the record's work mode
 *                  answers. The record can disagree with what is at `work/` (a link or a directory of the
 *                  home under a record that says the tree is the instance's), and such a plan cannot tell:
 *                  a reader words it from the record alone.
 * Every reader that asks whose tree it is asks this (lifecycleChoicesApplicable, the Remove dialog), and this
 * is the one place a plan's work mode is compared with a word: packages/desktop/test/lifecycle-own-worktree.test.mjs
 * holds that. Neither `defaults.retainWorktree` (the default of an option) nor a note is read for it. */
export function ownWorktreeOf(plan) {
  const facts = plan.facts;
  return typeof facts.ownWorktree === 'boolean' ? { own: facts.ownWorktree, from: 'fact' }
    : { own: facts.workMode === 'worktree', from: 'record' };
}
export function lifecycleSession(v) {
  if (!object(v) || !text(v.state, 128) || !v.state || typeof v.established !== 'boolean' || ![null, true, false].includes(v.present)
    || !nullable(v.backend) || (!v.established && (v.state !== 'unestablished' || v.present !== null))
    || (v.established && (v.present === null || v.state === 'unestablished'))) return null;
  return { state: v.state, established: v.established, present: v.present, backend: v.backend,
    ...(!v.established ? { reason: text(v.reason, 256) ? v.reason : 'unavailable' } : {}) };
}
export function lifecycleWork(v) {
  if (!object(v) || typeof v.observed !== 'boolean') return null;
  if (!v.observed) return text(v.reason, 256) ? { observed: false, reason: v.reason } : null;
  if (!gitRevision(v.revision) || !nullable(v.branch) || typeof v.detached !== 'boolean' || typeof v.drift !== 'boolean'
    || (v.detached && v.branch !== null) || !count(v.changed) || !count(v.untracked)) return null;
  for (const c of [v.upstream, v.base]) if (!object(c) || !nullable(c.ref) || !numberOrNull(c.ahead) || !numberOrNull(c.behind)
    || (c.ref === null && (c.ahead !== null || c.behind !== null))) return null;
  if (v.remote !== null && (!object(v.remote) || !nullable(v.remote.host) || !nullable(v.remote.path))) return null;
  return { observed: true, revision: v.revision, branch: v.branch, detached: v.detached, drift: v.drift,
    changed: v.changed, untracked: v.untracked,
    upstream: { ref: v.upstream.ref, ahead: v.upstream.ahead, behind: v.upstream.behind },
    base: { ref: v.base.ref, ahead: v.base.ahead, behind: v.base.behind },
    remote: v.remote === null ? null : { host: v.remote.host, path: v.remote.path } };
}
function identity(v) {
  return object(v) && text(v.instance, 255) && !!v.instance && text(v.agent, 255) && !!v.agent && absolute(v.home)
    && v.home.split('/').at(-1) === v.instance ? { instance: v.instance, agent: v.agent, home: v.home } : null;
}
function rows(value, project) {
  if (!Array.isArray(value) || value.length > MAX_LIFECYCLE_TARGETS) return null;
  const result = value.map(project);
  return result.some(v => !v) || new Set(result.map(v => v.home)).size !== result.length ? null : result;
}
const excluded = v => { const i = identity(v); return i && text(v.reason) ? { ...i, reason: v.reason } : null; };
/** Read a plan: a kernel's own answer, or the server's projection of one. `features`: the answering kernel's
 * (answeringFeatures), which decide how a retire plan's `facts.ownWorktree` is read (ownWorktreeFact). The
 * server gives them, for a relayed plan its host's; the renderer, which reads the server's projection, gives
 * none. The plan read holds the key only when it was read. */
export function lifecyclePlan(v, target, operation, options, { features = null } = {}) {
  if (!object(v) || v.lifecycleApi !== 1 || v.action !== operation || v.instance !== target.instance || v.home !== target.home
    || !planRevision(v.planRevision) || !at(v.at) || !strings(v.notes)) return null;
  const common = { lifecycleApi: 1, action: operation, instance: v.instance, home: v.home, planRevision: v.planRevision, at: v.at, notes: [...v.notes] };
  if (operation === 'stop') {
    if (v.recursive !== options.recursive) return null;
    const targets = rows(v.targets, t => {
      const i = identity(t), session = lifecycleSession(t?.session), work = lifecycleWork(t?.work);
      return i && session && work && count(t.depth) && nullable(t.workMode) && typeof t.launched === 'boolean'
        && typeof t.retiring === 'boolean' && typeof t.stopPending === 'boolean' && [true, false, 'unknown'].includes(t.midTask)
        ? { ...i, depth: t.depth, workMode: t.workMode, launched: t.launched, session, work, retiring: t.retiring, stopPending: t.stopPending, midTask: t.midTask } : null;
    });
    const skipped = rows(v.skipped, excluded), ambiguous = rows(v.ambiguous, excluded);
    if (!targets?.length || !skipped || !ambiguous || targets.length + skipped.length + ambiguous.length > MAX_LIFECYCLE_TARGETS
      || targets.at(-1).home !== target.home || targets.at(-1).agent !== target.agent || targets.at(-1).depth !== 0
      || targets.slice(0, -1).some(t => !t.depth) || (!options.recursive && targets.length !== 1)
      || (options.recursive && skipped.length) || [...skipped, ...ambiguous].some(t => targets.some(x => x.home === t.home))) return null;
    return { ...common, recursive: v.recursive, targets, skipped, ambiguous };
  }
  const f = v.facts, d = v.defaults;
  if (!object(f) || !object(d) || !nullable(f.workMode) || !(f.repo === null || absolute(f.repo)) || !nullable(f.recordedBranch) || f.pullRequest !== 'unknown'
    || typeof d.retainWorktree !== 'boolean' || !(d.deleteBranch === undefined || d.deleteBranch === false) || d.stopChildren !== true || d.retainChildren !== true) return null;
  const session = lifecycleSession(f.session), work = lifecycleWork(f.work);
  const children = rows(f.children, t => { const i = identity(t), s = lifecycleSession(t?.session); return i && s ? { ...i, session: s } : null; });
  const ambiguous = rows(f.ambiguous, excluded);
  const own = ownWorktreeFact(f, features);
  if (!session || !work || !own || !children || !ambiguous || children.length + ambiguous.length + 1 > MAX_LIFECYCLE_TARGETS
    || [...children, ...ambiguous].some(t => t.home === target.home) || ambiguous.some(t => children.some(c => c.home === t.home))) return null;
  return { ...common, facts: { session, work, workMode: f.workMode, ...(Object.hasOwn(own, 'value') ? { ownWorktree: own.value } : {}), repo: f.repo, recordedBranch: f.recordedBranch,
    children, ambiguous, pullRequest: 'unknown' }, defaults: { retainWorktree: d.retainWorktree, stopChildren: true, retainChildren: true } };
}
/** The kernel feature from which `stillRunning: []` in a failed row says the harness exited
 * (docs/desktop-cli-api.md, #still-running). A kernel without it answers `[]` there for a session that was
 * not seen to stop. */
const KERNEL_CODES_FEATURE = 'lifecycle-kernel-codes';
const PROBE_FEATURES_FEATURE = 'server-probe-features';
const names = (features, feature) => Array.isArray(features) && features.includes(feature);
/** The features of the kernel that answers a command, or null when they are not known. A local command
 * (`routed: false`): the selected CLI's own list. A routed one (`routed: true`): the host's list, which is
 * known only when this computer's CLI relays it (feature server-probe-features), the workspace's roster
 * `group` was read (`probe.ok === true`) and `probe.features` is an array. Anything else is unknown, a
 * missing `routed` too: never decided from a refusal, and never by probing. Pure: it keeps nothing. */
export function answeringFeatures({ cli, routed, group } = {}) {
  if (cli?.ok !== true || !Array.isArray(cli.features)) return null;
  if (routed === false) return [...cli.features];
  const probe = group?.probe;
  return routed === true && cli.features.includes(PROBE_FEATURES_FEATURE) && probe?.ok === true && Array.isArray(probe.features) ? [...probe.features] : null;
}
/** The rows of a stop's `results` or of a retire's `childrenStopped`. `decoded: false` reads a kernel's answer:
 * a failed row's `stillRunning: []` is kept only when `features` (the answering kernel's, answeringFeatures)
 * names lifecycle-kernel-codes, and is `null` otherwise, which is what that kernel's `[]` established.
 * `decoded: true` validates rows a server already decoded, and keeps them as they are. A row's `message` is
 * the kernel's text and is dropped, except under E_LIFECYCLE_BUSY, where it is kept as `detail`, through the
 * display filter. */
function stoppedRows(value, expected, { withState = false, decoded = false, features = null } = {}) {
  if (!Array.isArray(value) || value.length !== expected.length || value.length > MAX_LIFECYCLE_TARGETS) return null;
  const exited = decoded || names(features, KERNEL_CODES_FEATURE);
  const result = value.map((v, index) => {
    if (!object(v) || v.home !== expected[index].home || v.instance !== expected[index].instance || typeof v.ok !== 'boolean') return null;
    if (v.ok) return typeof v.stopped === 'boolean' && typeof v.alreadyIdle === 'boolean' && (!withState || text(v.state, 128))
      ? { instance: v.instance, home: v.home, ok: true, stopped: v.stopped, alreadyIdle: v.alreadyIdle, ...(withState ? { state: v.state } : {}) } : null;
    if (v.stillRunning !== null && (!Array.isArray(v.stillRunning) || v.stillRunning.length > 128 || v.stillRunning.some(p => !Number.isSafeInteger(p) || p <= 0))) return null;
    const code = lifecycleCode(v.code);
    // The row's own sentence is kept for one code only: a child whose home could not be locked, where the
    // sentence is the refusal of that child's stop and names what ends it. One display line, or nothing.
    const detail = code !== 'E_LIFECYCLE_BUSY' ? null : decoded ? cleanLine(v.detail) ? v.detail : null : displayLine(v.message);
    return { instance: v.instance, home: v.home, ok: false, code,
      stillRunning: v.stillRunning === null || !v.stillRunning.length && !exited ? null : [...v.stillRunning], ...(detail ? { detail } : {}) };
  });
  return result.some(v => !v) ? null : result;
}
/** Decode the rows of a kernel's answer. `features`: the answering kernel's (answeringFeatures). Not given,
 * null, or a list without lifecycle-kernel-codes all read a failed row's `[]` as `null`: a caller that
 * forgets the argument makes the weaker claim. From here on `[]` in a failed row has one meaning: the
 * harness exited, and what failed came after. */
export function stoppedTargets(value, expected, withState = false, { features = null } = {}) {
  return stoppedRows(value, expected, { withState, features });
}
/** Validate rows a server already decoded (the reply's `childrenStopped`). Never for a kernel's answer. */
export function decodedStoppedTargets(value, expected) { return stoppedRows(value, expected, { decoded: true }); }
/** What a decoded row is, as data. The only place that reads a row for wording: every reader of a stop's
 * result (a line, the sentence above the rows) decides from this.
 *   idle         ok, the session was already stopped
 *   stopped      ok
 *   retiring     failed with E_INSTANCE_RETIRING: nothing was tried, a retire holds it
 *   locked       failed with E_LIFECYCLE_BUSY: nothing was tried, its home's claim could not be taken
 *   running      failed, and these signalled processes were seen alive after the wait
 *   unrecorded   failed with `stillRunning: []`: the harness exited, and what failed came after
 *   unconfirmed  failed with `stillRunning: null`: nothing is established
 * The two codes decide before `stillRunning` does, and need no feature name: each means the same in every
 * kernel that answers it, and the kernel answers both only before any effect. */
export function stoppedRowKind(row) {
  if (row.ok) return row.alreadyIdle ? 'idle' : 'stopped';
  if (row.code === 'E_INSTANCE_RETIRING') return 'retiring';
  if (row.code === 'E_LIFECYCLE_BUSY') return 'locked';
  return !Array.isArray(row.stillRunning) ? 'unconfirmed' : row.stillRunning.length ? 'running' : 'unrecorded';
}
/** A row's line, after its name. "Not stopped" for a row nothing was tried on; "Didn't stop" for one that
 * was tried. The busy line says only what the code means: a row carries no holder, and the code covers
 * causes where nobody runs. A `locked` row's own sentence (`detail`) is shown under the line, as a quote. */
export function stoppedRowText(row) {
  const kind = stoppedRowKind(row);
  return kind === 'idle' ? 'Was already stopped' : kind === 'stopped' ? 'Stopped'
    : kind === 'retiring' ? 'Not stopped: it is being retired' : kind === 'locked' ? "Not stopped: OATS couldn't lock its home"
    : kind === 'unrecorded' ? "Stopped, but OATS couldn't record it"
    : kind === 'running' ? `Didn't stop (still running: ${row.stillRunning.join(', ')})` : "Didn't stop";
}
/** Some row failed, and every failed row is `unrecorded`: each session stopped, and OATS could not record all of it. */
const stoppedUnrecorded = rows => rows.some(r => !r.ok) && rows.every(r => r.ok || stoppedRowKind(r) === 'unrecorded');
/** How a stop's result that is not `ok` reads above its rows: `{ status, title }`. A reader words a stop's
 * result from the rows, through this and childrenRefusedMessage, never from the reply's `reason.message`
 * (a partial stop's reason stays E_SESSION_STOP_FAILED's sentence, whatever the rows say). */
export function stopResultWords(rows) {
  if (!stoppedUnrecorded(rows)) return { status: 'Not every session stopped:', title: 'Not every session stopped' };
  return { title: 'Stopped, but not recorded', status: rows.length === 1 ? `${rows[0].instance} stopped, but OATS couldn't record it.`
    : "Every session stopped, but OATS couldn't record all of them:" };
}
const CHILDREN_UNRECORDED = "The child instances stopped, but OATS couldn't record it for all of them, so nothing was retired.";
/** The sentence for a retire refused with E_CHILDREN_RUNNING, chosen from its child rows. "Nothing was
 * retired" rests on the code (an answer with no result, refused before the retire's own effects); "the
 * child instances stopped" rests on the rows: every one is ok, or failed with `[]`. Like stopResultWords,
 * a reader asks this, never the reply's `reason.message`. */
export const childrenRefusedMessage = rows => stoppedUnrecorded(rows) ? CHILDREN_UNRECORDED : messages.E_CHILDREN_RUNNING;
/** The one branch deletion a retire reports (feature `worktree-event`, 0.49.0): it finished the compensation of a
 * spawn killed while its `worktree` hooks ran. `{branch, branchDeleted: true}`, or `{branch, branchDeleted: false,
 * reason}`. Additive and read tolerantly: anything else is ignored (null), never a refused receipt. Its text is
 * the kernel's, raw: shown only through displayLine. It is not retire's own `branchDeleted`, which stays refused. */
export function spawnCompensationOf(v) {
  const label = (x, max) => typeof x === 'string' && !!x && x.length <= max;
  if (!object(v) || !label(v.branch, 1024) || typeof v.branchDeleted !== 'boolean') return null;
  if (v.branchDeleted) return { branch: v.branch, branchDeleted: true };
  return label(v.reason, 4096) ? { branch: v.branch, branchDeleted: false, reason: v.reason } : null;
}
/** Decode a kernel's receipt. `server`: the request was routed there. The routed retire's result then may
 * also carry `server` and `target` (its route); a local result carrying them is refused. `features`: the
 * answering kernel's (answeringFeatures), for its rows (stoppedTargets).
 * Desktop asks for no branch deletion, so a retire result that reports one, or a skipped one, is not the
 * answer to its request and is refused whole, a deferred one too: nothing of it is projected. The kernel's one
 * exception, an interrupted spawn's branch (`spawnCompensation`), is not such a report: it is projected. */
export function lifecycleReceipt(v, plan, key, { server = null, features = null } = {}) { return receipt(v, plan, key, { server, features }); }
function receipt(v, plan, key, { server = null, features = null, decoded = false } = {}) {
  if (!object(v) || v.idempotencyKey !== key || v.planRevision !== plan.planRevision || typeof v.replayed !== 'boolean') return null;
  if (!server ? Object.hasOwn(v, 'server') || Object.hasOwn(v, 'target')
    : plan.action !== 'retire' && (Object.hasOwn(v, 'server') || Object.hasOwn(v, 'target'))
      || Object.hasOwn(v, 'server') && v.server !== server || Object.hasOwn(v, 'target') && !object(v.target)) return null;
  if (plan.action === 'stop') {
    const results = stoppedRows(v.results, plan.targets, { withState: true, decoded, features });
    if (v.lifecycleApi !== 1 || v.action !== 'stop' || v.instance !== plan.instance || v.home !== plan.home || !at(v.at)
      || !results || v.ok !== results.every(r => r.ok) || !Array.isArray(v.retained)
      || JSON.stringify(v.retained) !== JSON.stringify(['home', 'work', 'transcript', 'launch'])) return null;
    return { action: 'stop', instance: v.instance, home: v.home, planRevision: v.planRevision, replayed: v.replayed, at: v.at,
      ok: v.ok, results, retained: [...v.retained] };
  }
  if (!(v.branchDeleted === undefined || v.branchDeleted === false)
    || object(v.retention) && (Object.hasOwn(v.retention, 'branchDeleted') || Object.hasOwn(v.retention, 'branchDeletionSkipped'))) return null;
  if (v.retired === plan.instance && v.deferred === true) return { action: 'retire', instance: plan.instance, home: plan.home,
    planRevision: v.planRevision, replayed: v.replayed, deferred: true };
  if (v.retired !== plan.instance || typeof v.removedDir !== 'boolean' || typeof v.worktreeRemoved !== 'boolean'
    || (v.rollbackIncomplete !== undefined && !strings(v.rollbackIncomplete)) || !(v.retainedHome === undefined || v.retainedHome === plan.home)) return null;
  const childrenStopped = stoppedRows(v.childrenStopped, plan.facts.children, { decoded, features });
  if (!childrenStopped || childrenStopped.some(c => !c.ok)) return null;
  let retention = null;
  if (v.retention !== null) {
    const r = v.retention;
    if (!object(r) || !['retained', 'removed', 'absent'].includes(r.worktree) || !nullable(r.branch) || !nullable(r.recordedBranch)
      || (r.worktree === 'retained' && (!absolute(r.movedTo) || !nullable(r.detachedAt)))) return null;
    retention = { worktree: r.worktree, branch: r.branch, recordedBranch: r.recordedBranch,
      ...(r.worktree === 'retained' ? { movedTo: r.movedTo, detachedAt: r.detachedAt } : {}) };
  }
  const recovery = v.workRecovery?.path, compensation = spawnCompensationOf(v.spawnCompensation);
  return { action: 'retire', instance: plan.instance, home: plan.home, planRevision: v.planRevision, replayed: v.replayed,
    removedDir: v.removedDir, worktreeRemoved: v.worktreeRemoved, retention, childrenStopped,
    incomplete: !!v.rollbackIncomplete?.length, retainedHome: v.retainedHome ?? null,
    recoveryPath: absolute(recovery) ? recovery : null, ...(compensation ? { spawnCompensation: compensation } : {}) };
}
/** Validate the public projection without exposing the server's private key. Its rows were decoded by
 * the server and are kept as they are: this takes no features and never reads a kernel's own row. */
export function publicLifecycleReceipt(v, plan) {
  if (!object(v) || v.action !== plan.action || v.instance !== plan.instance || v.home !== plan.home) return null;
  if (v.action === 'stop') return receipt({ ...v, lifecycleApi: 1, idempotencyKey: 'public' }, plan, 'public', { decoded: true });
  if (v.deferred !== true && (typeof v.incomplete !== 'boolean' || !(v.retainedHome === null || v.retainedHome === plan.home)
    || !(v.recoveryPath === null || absolute(v.recoveryPath)))) return null;
  return receipt({ ...v, retired: v.instance, idempotencyKey: 'public',
    retainedHome: v.retainedHome || undefined, rollbackIncomplete: v.incomplete ? ['reported incomplete cleanup'] : undefined,
    workRecovery: v.recoveryPath ? { path: v.recoveryPath } : undefined }, plan, 'public', { decoded: true });
}
