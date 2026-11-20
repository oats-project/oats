/** Confirmed K6d input/data boundary. No kernel resolution or renderer key authority. */
import { retainedSpawnDetails, launchFlagIgnored, flagIgnoredFact } from './launch-prompt-outcome.mjs';
import { harnessOf } from './harness-names.mjs';
import { record, previewSupported, previewSelector, previewChoices, previewTarget, previewData, previewFailure, MAX_HOOKS } from './spawn-preview-contract.mjs';
import { spawnDecision, sameSpawnDecision } from './spawn-decision.mjs';
const exact = (v, keys) => record(v) && Object.keys(v).every(k => keys.includes(k));
const bytes = v => new TextEncoder().encode(v).byteLength;
function fits(v, max) { try { return bytes(JSON.stringify(v)) <= max; } catch { return false; } }
const text = (v, max) => typeof v === 'string' && !v.includes('\0') && bytes(v) <= max;
export const WAKE_OUTCOME_UNKNOWN = 'Agent created; wake outcome unavailable — check Schedules';
export const spawnReference = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const spawnApplySupported = cli => previewSupported(cli) && cli.spawnApplyApi === 1
  && cli.features.length <= 128 && cli.features.every(f => typeof f === 'string')
  && cli.features.includes('spawn-apply-2') && cli.features.includes('spawn-idempotency-2');
/** The apply's CLI deadline. 60 s, unless the CLI declares feature worktree-event and the confirmed
 * preview runs n > 0 `worktree` hooks: the kernel bounds each at 30 minutes, so 60 s + n × 30 min + 60 s.
 * Derived from the preview the operator confirmed, never reread. */
export const SPAWN_APPLY_MS = 60000;
export const WORKTREE_HOOK_MS = 30 * 60000;
export function spawnApplyDeadlineMs(cli, preview) {
  const n = Array.isArray(cli?.features) && cli.features.includes('worktree-event') && Array.isArray(preview?.worktreeHooks) ? preview.worktreeHooks.length : 0;
  return n > 0 ? SPAWN_APPLY_MS + n * WORKTREE_HOOK_MS + SPAWN_APPLY_MS : SPAWN_APPLY_MS;
}
/** Whether a deadline is one spawnApplyDeadlineMs can produce (at most MAX_HOOKS hooks). */
export const spawnApplyDeadline = v => v === SPAWN_APPLY_MS
  || Number.isSafeInteger(v) && v > 2 * SPAWN_APPLY_MS && (v - 2 * SPAWN_APPLY_MS) % WORKTREE_HOOK_MS === 0 && (v - 2 * SPAWN_APPLY_MS) / WORKTREE_HOOK_MS <= MAX_HOOKS;
export function spawnApplyChoicesSupported(cli, choices, wakeRequested = false) {
  const has = (values, value) => Array.isArray(values) && values.includes(value);
  return !!choices && (!choices.harness || has(cli?.harnesses, choices.harness))
    && (!choices.backend || has(cli?.sessionBackends, choices.backend))
    && (choices.yolo === undefined || has(cli?.launchOptions, 'yolo'))
    && (!choices.launchConfig || has(cli?.features, 'launch-config'))
    && (!wakeRequested || has(cli?.features, 'schedule'))
    && (choices.name === undefined || has(cli?.features, 'spawn-name'))
    && (choices.identity === undefined || has(cli?.features, 'spawn-provider-payload'))
    && (choices.background === undefined || has(cli?.features, 'instance-background'));
}
export function spawnWake(v) {
  if (!exact(v, ['cron', 'tz', 'message', 'enabled']) || !text(v.cron, 256) || !v.cron.trim()
    || !text(v.tz, 128) || !v.tz.trim() || /[\x00-\x1f\x7f]/.test(v.cron + v.tz)
    || !text(v.message, 8192) || !v.message.trim() || v.enabled !== undefined && typeof v.enabled !== 'boolean') return null;
  return { cron: v.cron, tz: v.tz, message: v.message, enabled: v.enabled ?? true };
}
export function spawnPrepareInput(v) {
  if (!exact(v, ['action', 'selector', 'choices', 'task', 'wake']) || v.action !== 'prepare' || !fits(v, 65536)) return null;
  const selector = previewSelector(v.selector), choices = previewChoices(v.choices);
  const task = v.task === undefined ? '' : v.task;
  if (!selector || !choices || !text(task, 32768) || !fits({ selector, choices }, 16384)) return null;
  const wake = Object.hasOwn(v, 'wake') ? spawnWake(v.wake) : undefined;
  if (wake === null) return null;
  return { action: 'prepare', selector, choices, task, ...(wake ? { wake } : {}) };
}
export function spawnRefInput(v) {
  return exact(v, ['action', 'spawnRef']) && ['apply', 'result'].includes(v.action) && spawnReference(v.spawnRef)
    ? { action: v.action, spawnRef: v.spawnRef } : null;
}
/** A READ success alone never creates an executable confirmation. */
export function spawnPreparedData(v, target) {
  const data = previewData(v, target);
  return data && spawnDecision(data.decision, { effectiveRequired: true }) && data.work !== 'attached'
    && data.preflight.status === 'complete' ? data : null;
}
export function spawnWakeOutcome(value, requested) {
  if (value === undefined) return { requested: null, saved: null, error: null };
  if (!record(value) || ![null, true, false].includes(value.requested) || ![null, true, false].includes(value.saved)
    || value.requested !== null && value.requested !== requested
    || value.requested !== true && value.saved !== null) return null;
  let error = null;
  if (value.error !== null) {
    if (!record(value.error) || typeof value.error.code !== 'string' || !value.error.code || value.error.code.length > 128 || value.saved !== false) return null;
    // Wake errors may contain task/credential/provider text. Only the reported
    // failure fact crosses; neither raw message nor an arbitrary code is UI text.
    error = { code: 'E_WAKE_SAVE_FAILED', message: 'The agent was created, but its wake schedule was not saved.' };
  }
  if (value.saved === false && !error) return null;
  return { requested: value.requested, saved: value.saved, error };
}
/** A qualified creation receipt, not executable terminal/session instructions.
 *
 * `flagIgnored` (optional) is the one fact of the kernel's answer the receipt carries as text: a launched
 * spawn where Claude Code ignored the channel option (launchFlagIgnored: `launchPrompts.status`
 * "flag-ignored", with the answer's warnings as bounded display lines). Absent for any other status, for
 * an answer without `launchPrompts`, and for a spawn that was not launched. It holds facts and no sentence.
 * Every other warning of an apply stays a count (`warningCount`). */
export function spawnCreationReceipt(v, { target, preview, wakeRequested = false } = {}) {
  const selected = previewTarget(target), expected = spawnDecision(preview?.decision, { effectiveRequired: true });
  const decision = spawnDecision(v?.decision, { effectiveRequired: true });
  if (!selected || !expected || !record(v) || !sameSpawnDecision(expected, decision)
    || v.agent !== selected.selector.soul || v.instance !== expected.instance || v.home !== expected.home
    || v.branch !== expected.branch || v.repo !== expected.effective.repo || v.work !== expected.effective.work
    || harnessOf(v) !== expected.effective.harness || v.model !== expected.effective.model
    || typeof v.launched !== 'boolean' || typeof v.replayed !== 'boolean'
    || v.yolo !== undefined && v.yolo !== expected.effective.yolo
    || !Array.isArray(v.warnings) || v.warnings.length > 512 || !v.warnings.every(w => typeof w === 'string' && w.length <= 4096)) return null;
  let wake = spawnWakeOutcome(v.wake, wakeRequested);
  // Older first-response compatibility: the CLI may have saved the wake outcome
  // but failed to record it in the home. A reported save failure is still known.
  if (v.wake === undefined && v.wakeScheduleError !== undefined) {
    if (!wakeRequested) return null;
    wake = spawnWakeOutcome({ requested: true, saved: false, error: v.wakeScheduleError }, true);
  }
  if (!wake) return null;
  const flagIgnored = v.launched ? launchFlagIgnored(v) : null;
  return { instance: v.instance, agent: v.agent, home: v.home, agentsRoot: selected.selector.agentsRoot,
    workspace: selected.workspace, server: null, repo: v.repo, work: v.work, branch: v.branch,
    harness: harnessOf(v), model: v.model, launched: v.launched, replayed: v.replayed, decision,
    warningCount: v.warnings.length, wake, ...(flagIgnored ? { flagIgnored } : {}) };
}
/** Project the Desktop HTTP view again at the main/renderer trust boundaries. */
export function spawnApplyView(v, expected = {}) {
  if (!record(v) || v.spawnApplyViewApi !== 1) return null;
  const target = v.target === null ? null : previewTarget(v.target);
  if (v.target !== null && !target || target && expected.workspace && target.workspace !== expected.workspace
    || target && expected.selector && (target.selector.soul !== expected.selector.soul || target.selector.agentsRoot !== expected.selector.agentsRoot)
    || v.spawnRef !== null && !spawnReference(v.spawnRef) || expected.ref && v.spawnRef !== null && v.spawnRef !== expected.ref) return null;
  if (['unavailable', 'refused', 'unknown', 'stale', 'incomplete'].includes(v.status)) {
    const out = spawnApplyFailure(v.reason?.code, { target, spawnRef: v.spawnRef, status: v.status, message: v.reason?.message });
    if (v.status === 'incomplete') {
      const incomplete = retainedSpawnDetails(v.incomplete);
      if (v.reason?.code !== 'E_SPAWN_INCOMPLETE' || !target || !incomplete) return null;
      out.incomplete = incomplete;
    }
    return out;
  }
  if (!['prepared', 'pending', 'complete', 'partial'].includes(v.status) || !target || !spawnReference(v.spawnRef)
    || typeof v.wakeRequested !== 'boolean') return null;
  const preview = spawnPreparedData(v.preview, target);
  if (!preview || !preview.backendStatus.installed) return null;
  let receipt = null, reason = null;
  if (['complete', 'partial'].includes(v.status)) {
    if (!record(v.receipt) || !Number.isInteger(v.receipt.warningCount) || v.receipt.warningCount < 0 || v.receipt.warningCount > 512
      || v.receipt.workspace !== target.workspace || v.receipt.agentsRoot !== target.selector.agentsRoot || v.receipt.server !== null) return null;
    // The receipt is rebuilt from its own keys: the warnings are a count here, so `flagIgnored` is read from
    // the receipt's key through the reader's decoder, never composed again. Tolerant: a value that does not
    // decode is dropped, and the receipt stands.
    receipt = spawnCreationReceipt({ ...v.receipt, warnings: Array(v.receipt.warningCount).fill(''), launchPrompts: undefined }, { target, preview, wakeRequested: v.wakeRequested });
    if (!receipt) return null;
    const flagIgnored = receipt.launched ? flagIgnoredFact(v.receipt.flagIgnored) : undefined;
    if (flagIgnored) receipt.flagIgnored = flagIgnored;
    const partial = v.wakeRequested && receipt.wake.saved !== true;
    if ((v.status === 'partial') !== partial) return null;
    if (partial) reason = receipt.wake.error ?? { code: 'E_WAKE_OUTCOME_UNKNOWN', message: WAKE_OUTCOME_UNKNOWN };
  }
  // The CLI deadline the broker set from this preview (spawnApplyDeadlineMs): the renderer follows a
  // `pending` apply for this long (plus a margin). Absent from an older backend.
  const applyWithinMs = spawnApplyDeadline(v.applyWithinMs) ? v.applyWithinMs : undefined;
  return { spawnApplyViewApi: 1, status: v.status, target, spawnRef: v.spawnRef, preview, wakeRequested: v.wakeRequested,
    receipt, reason, ...(applyWithinMs ? { applyWithinMs } : {}), ...(v.repeated === true ? { repeated: true } : {}) };
}
const errors = {
  E_APPLY_UNAVAILABLE: 'Confirmed spawn requires preview API 2, apply API 1 and advertised spawn-preview-2, spawn-apply-2 and spawn-idempotency-2.',
  E_BAD_ARGS: 'Provide one qualified spawn draft, or only its server-owned confirmation reference.',
  E_PLAN_REQUIRED: 'Review this local spawn and explicitly confirm the server-owned decision.',
  E_PLAN_CHANGED: 'The workspace, soul, anchor or CLI changed. Review a new confirmation.',
  E_INTENT_EXPIRED: 'This confirmation is unavailable. A lost submitted intent does not prove that nothing happened; check the roster before reviewing another spawn.',
  E_BUSY: 'The bounded spawn transaction capacity is in use. Wait for the current operation.',
  E_PREFLIGHT_INCOMPLETE: 'The preview preflight did not complete. It is not an executable confirmation.',
  E_BACKEND_UNAVAILABLE: 'The preview reports that the selected backend is not installed. Observe a new preview after it is available.',
  E_INSTANCE_GONE: 'The previously observed confirmed instance is no longer present. Inspect the roster; this is not an automatic spawn retry.',
  E_DECISION_STALE: 'The confirmed decision changed. Review a fresh preview and explicitly confirm again.',
  E_IDEMPOTENCY_CONFLICT: 'This confirmation key belongs to a different recorded decision. Review a new confirmation; do not retry with a replacement key.',
  E_PLACEMENT_TAKEN: 'Another spawn reserved the confirmed home. Review a new preview before confirming again.',
  // spawn-name: explicit names are unique across the deployment; a taken name is never suffixed.
  E_INSTANCE_NAME_TAKEN: 'Another instance took the confirmed name. Review a new preview before confirming again.',
  E_OUTCOME_UNKNOWN: 'The spawn outcome is unknown. Check this same confirmation; never create a replacement key to retry it.',
  E_SPAWN_INCOMPLETE: 'The confirmed home exists but spawn completion is unconfirmed. Inspect its existing session; do not spawn another instance to recover it.',
  E_FORBIDDEN_FRAME: 'This frame cannot use spawn transactions.',
  E_CLI_PROTOCOL: 'The CLI returned an invalid or mismatched confirmed-spawn result.',
  E_CLI_FAILED: 'The installed CLI could not complete the confirmed-spawn request.',
  E_CLI_TIMEOUT: 'The spawn command timed out. Creation may already have happened; do not start a new confirmation to retry it.',
  E_CLI_OUTPUT_LIMIT: 'The spawn command exceeded its output limit. Its creation outcome is unconfirmed.',
  E_INPUT_PREPARATION: 'Private spawn instruction files could not be prepared; no CLI was invoked.',
  E_INTERRUPTED: 'The spawn was interrupted while its worktree hooks ran.',
  E_REQUIRED_HOOK_FAILED: 'A required worktree hook failed.',
  E_HOOK_ENVIRONMENT_CONTRACT: 'A worktree hook broke the hook environment contract.',
  // Feature sandboxes (D-S1-4): a spawn into a sandbox is bound and keyed by the kernel itself, never by a
  // confirmed apply. Shown only when the kernel's own message cannot travel.
  E_SANDBOX_PLACEMENT: 'This soul runs in a sandbox, which a confirmed spawn cannot reach. Spawn it with `oats spawn <soul>` (OATS binds it to the sandbox itself) or from a schedule.',
};
/** Refusals whose kernel message and `details: {reason, remedy}` travel: the kernel says why and what a
 *  person does next (feature sandboxes, E_SANDBOX_PLACEMENT). Nothing else of their details is kept. */
export const KERNEL_WORDED_CODES = ['E_SANDBOX_PLACEMENT'];
const MESSAGE_MAX = 2048, REMEDY_MAX = 1024;
const REASON = /^[a-z][a-z0-9-]{0,63}$/;
// As previewFailure bounds a kernel message: at most `max` characters, no control character but a
// newline, no credential-shaped text.
const boundedText = (v, max) => typeof v === 'string' && !!v.trim() && v.length <= max && !v.includes('\0')
  && !/[\x00-\x09\x0b-\x1f\x7f]|https?:\/\/[^/\s]*@|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/.test(v);
/** A kernel-worded refusal's details as they travel: `reason` (a slug) and `remedy` (bounded text), each
 *  only when valid; null when neither is. */
export function kernelWordedDetails(details) {
  if (!record(details)) return null;
  const out = {
    ...(typeof details.reason === 'string' && REASON.test(details.reason) ? { reason: details.reason } : {}),
    ...(boundedText(details.remedy, REMEDY_MAX) ? { remedy: details.remedy } : {}),
  };
  return Object.keys(out).length ? out : null;
}
/** Feature worktree-event: a dispatched spawn failure with one of these codes and no
 * `details.unconfirmed: true` was rolled back by the kernel (confirmed compensation): nothing
 * was created. With the marker its cleanup is owed. Only these three; every other code keeps
 * the unknown-unless-proven rule. */
export const ROLLED_BACK_CODES = ['E_INTERRUPTED', 'E_REQUIRED_HOOK_FAILED', 'E_HOOK_ENVIRONMENT_CONTRACT'];
/** The kernel's message travels for ROLLED_BACK_CODES (it names the capability and its log) and
 * KERNEL_WORDED_CODES; bounded here, and shown through displayLine. */
const kernelText = v => typeof v === 'string' && !!v.trim() && v.length <= 4096 && !v.includes('\0');
export function spawnApplyReason(code, kernelMessage) {
  if (typeof code !== 'string') code = 'E_CLI_FAILED';
  if (ROLLED_BACK_CODES.includes(code)) return { code, message: kernelText(kernelMessage) ? kernelMessage : errors[code] };
  if (KERNEL_WORDED_CODES.includes(code)) return { code, message: boundedText(kernelMessage, MESSAGE_MAX) ? kernelMessage : errors[code] };
  if (Object.hasOwn(errors, code)) return { code, message: errors[code] };
  const reason = previewFailure(code).reason;
  return reason.code === code && code !== 'E_CLI_FAILED' ? reason : { code: 'E_CLI_FAILED', message: errors.E_CLI_FAILED };
}
export function spawnApplyFailure(code, { target = null, spawnRef = null, status = 'unavailable', message } = {}) {
  return { spawnApplyViewApi: 1, status: ['unavailable', 'unknown', 'refused', 'stale', 'incomplete'].includes(status) ? status : 'unavailable',
    target: previewTarget(target), spawnRef: spawnReference(spawnRef) ? spawnRef : null,
    preview: null, receipt: null, reason: spawnApplyReason(code, message) };
}
