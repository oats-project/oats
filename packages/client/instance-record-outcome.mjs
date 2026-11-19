/** What a kernel verb that writes one field of an instance's own record answered (`oats instance color`,
 * `oats instance background`, `oats instance pin`), as a client reads it: the Desktop's backend boundary
 * (packages/desktop/server/instance-record.mjs) and the TUI's pin key (instance-pin.mjs) read it here, once. Only
 * an error the installed CLI printed is a refusal (kernel-made.mjs); one the adapter wrote (a timeout, no envelope,
 * a nonzero exit) is an unknown outcome, as is a success the verb's `answer(result)` does not read as the
 * contract's (it returns the ok answer, or null).
 *
 * Answers: `{ status: 'ok', … }` (the verb's own), `{ status: 'refused', reason: { code, message } }`, or
 * `{ status: 'unknown', reason: { code } }` (the record may have changed: read the roster again). */
import { madeByKernel } from './kernel-made.mjs';

const CODE = /^E_[A-Z0-9_]{1,62}$/;
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);

/** The codes this client's CLI runner gives a run that ended without an answer (own-codes.mjs): such a run's outcome
 * is unknown, and its code says why. Any other code there reads as E_OUTCOME_UNKNOWN. */
const CLI_RUN_CODES = new Set(['E_CLI_FAILED', 'E_CLI_OUTPUT_LIMIT', 'E_CLI_PROTOCOL', 'E_CLI_TIMEOUT', 'E_CLI_UNAVAILABLE']);

export function recordOutcome(envelope, answer) {
  if (envelope?.ok === true) {
    let ok = null;
    try { ok = record(envelope.result) ? answer(envelope.result) : null; } catch { ok = null; }
    return ok ?? { status: 'unknown', reason: { code: 'E_OUTCOME_UNKNOWN' } };
  }
  const error = envelope?.ok === false ? envelope.error : null;
  if (madeByKernel(error) && typeof error.code === 'string' && CODE.test(error.code)) {
    return { status: 'refused', reason: { code: error.code, message: text(error.message, 512) ? error.message : '' } };
  }
  return { status: 'unknown', reason: { code: CLI_RUN_CODES.has(error?.code) ? error.code : 'E_OUTCOME_UNKNOWN' } };
}
