/** The local schedule editor's draft: a stored definition (views/schedules.mjs gets it from
 * automation-rows' localScheduleDefinition), read back into the form's exact inputs. The
 * History API3 read projection that lived here left with the old Schedules read path (§3b). */
import { harnessOf, HARNESSES } from '../../client/harness-names.mjs';
import { record } from '../../client/readiness-contract.mjs';
const scheduleId = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
const policyKeys = ['definitionVersion', 'recurrencePolicy', 'execution', 'preparation', 'executionBinding', 'responsibleHuman'];
/** The kernel's summary rule (lib/automations.mjs validateDescription): one line of 1 to 200
 * characters, no control characters, no line or paragraph separator. */
export const DESCRIPTION_MAX = 200;
export const descriptionValid = v => typeof v === 'string' && v.length > 0 && [...v].length <= DESCRIPTION_MAX && !/[\p{Cc}\u2028\u2029]/u.test(v);
const draftString = v => typeof v === 'string' && v.length <= 1048576 && !v.includes('\0');
/** Exact legacy editor inputs only: no previews/redactions/trim, no captured fields.
 * If the adapter cannot preserve a definition, it is not an editable draft.
 * `backends`: the session backends a caller's form can keep (packages/client/session-backends.mjs
 * `sessionBackendNames` gives the names the kernel lists); "tmux" alone when none is given, which is what the
 * Schedules form passes today: it offers and keeps tmux only, so a schedule on a session provider is not a draft
 * and is edited with the CLI. A spawn schedule whose `backend` is one of `backends` is a draft; any other is not. */
export function scheduleDraft(v, { backends = ['tmux'] } = {}) {
  if (!record(v) || policyKeys.some(k => Object.hasOwn(v, k)) || !scheduleId(v.id)
    || !['spawn', 'wake', 'operation'].includes(v.kind) || !draftString(v.cron) || !v.cron.trim()
    || !draftString(v.tz) || !v.tz.trim() || typeof v.enabled !== 'boolean') return null;
  const common = ['id', 'kind', 'cron', 'tz', 'enabled', 'description', 'createdAt', 'updatedAt', 'scope', 'scheduleApi', 'scheduleHistoryApi',
    'executionStatus', 'nextRun', 'lastRun', 'history', 'recentRuns', 'running', 'attempt', 'pendingWake'];
  // A stored job's harness is `harness` (0.27) or a released kernel's `runtime`; the draft speaks harness.
  const fields = v.kind === 'spawn' ? ['agent', 'agentsRoot', 'repo', 'task', 'harness', 'runtime', 'model', 'backend', 'purpose', 'yolo', 'wake']
    : v.kind === 'wake' ? ['home', 'message'] : ['home', 'operation'];
  if (Object.keys(v).some(k => !common.includes(k) && !fields.includes(k))) return null;
  const out = { id: v.id, kind: v.kind, cron: v.cron, tz: v.tz, enabled: v.enabled };
  if (Object.hasOwn(v, 'description')) {
    if (!descriptionValid(v.description)) return null;
    out.description = v.description;
  }
  const required = v.kind === 'spawn' ? ['agent', 'agentsRoot', 'task'] : v.kind === 'wake' ? ['home', 'message'] : ['home', 'operation'];
  if (required.some(k => !draftString(v[k]) || !v[k].trim())) return null;
  for (const k of required) out[k] = v[k];
  if (v.kind === 'spawn') {
    if (Object.hasOwn(v, 'harness') && Object.hasOwn(v, 'runtime')) return null;
    for (const k of ['repo', 'model', 'backend', 'purpose']) if (Object.hasOwn(v, k)) {
      if (!draftString(v[k])) return null;
      out[k] = v[k];
    }
    const harness = harnessOf(v);
    if (harness !== undefined) { if (!draftString(harness)) return null; out.harness = harness; }
    if (Object.hasOwn(v, 'yolo')) { if (typeof v.yolo !== 'boolean') return null; out.yolo = v.yolo; }
    if (Object.hasOwn(v, 'wake')) {
      if (!record(v.wake) || Object.keys(v.wake).some(k => !['cron', 'tz', 'message'].includes(k))
        || ['cron', 'tz', 'message'].some(k => !draftString(v.wake[k]) || !v.wake[k].trim())) return null;
      out.wake = { cron: v.wake.cron, tz: v.wake.tz, message: v.wake.message };
    }
    // The current form cannot retain an unknown select option: a harness it does not list, or a backend that is
    // not one of the caller's `backends`.
    if (out.harness && !HARNESSES.includes(out.harness) || v.backend && !(Array.isArray(backends) && backends.includes(v.backend))) return null;
  }
  return out;
}
