/** The boundary every kernel verb that writes one field of an instance's own record goes through: `oats instance
 * color` (instance-color.mjs, #1421 §2), `oats instance background` (instance-background.mjs, #1579) and `oats
 * instance pin` (instance-pin.mjs, feature instance-pin). The
 * kernel is the only writer of that record; this module validates the request against the row the backend holds,
 * gates it on the feature, runs the verb (argv only; cli-adapter.mjs) and decodes its answer. It is the teams
 * boundary's pattern (teams.mjs), but it also routes: a remote row's record is written on its host, with
 * `--server`, as `oats instance stop` is routed. The answer's statuses are Forget's (server-forget.mjs).
 *
 * What differs per verb is a small descriptor (`verb`, below): the request's field and its values, the feature,
 * the CLI call, how the kernel's answer is read and the boundary's own sentences. Everything else is shared, so the
 * verbs cannot drift apart in how they admit, gate, serialize, route or decode.
 *
 * Request (POST /api/instance-<verb>?ws=<id>, a bounded JSON object):
 *   { instance, home, <field>: value }   the value the verb writes
 *   { instance, home, check: true }      nothing runs: whether the verb can run here (a dialog or menu asks first)
 * Answer:
 *   { status: 'ok', instance, <field>, changed }        the kernel's answer for exactly that instance
 *   { status: 'ok', instance, check: true }             a check: the verb can run
 *   { status: 'refused', reason: { code, message } }    an error the installed CLI printed (kernel-made.mjs)
 *   { status: 'unknown', reason: { code } }             no kernel answer (a timeout, no envelope, a crash) or
 *                                                       one that is not the contract's: the record may have changed
 *   { status: 'not-run', reason: { code, message, details? } }   nothing ran: this boundary's own reason
 *
 * The gate is the feature, never a refusal: locally, this computer's CLI lists the verb's feature; for a remote row,
 * this CLI routes and relays the hosts' features (`server-probe-features`) and the held roster row's own
 * `probe.features` names it (composed-gate.mjs hostAdvertises). Without it: not-run with the verb's `unavailable`
 * code, `details.where` `local` when this computer's CLI lacks what it needs (also `server-probe-features`, for a
 * remote row), else `server` (the caller's sentence says which).
 * One write per home at a time, per verb (E_BUSY): a client never sends two, so a second is another window's. */
import { isAbsolute } from 'node:path';
import { hostAdvertises, PROBE_FEATURES_FEATURE } from '../../client/composed-gate.mjs';
import { canAddressRemote } from '../../client/remote-address.mjs';
import { madeByKernel } from '../../client/kernel-made.mjs';

const CODE = /^E_[A-Z0-9_]{1,62}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FIELD = /^[a-z][A-Za-z]{0,31}$/;
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
const advertises = (cli, feature) => !!cli?.ok && Array.isArray(cli.features) && cli.features.includes(feature);

/** A verb's "nothing ran" answers: `sentences` maps each of the boundary's codes (E_BAD_ARGS, E_WORKSPACE_UNKNOWN,
 * E_SNAPSHOT_UNKNOWN, E_BUSY and the verb's `unavailable` code) to its fixed sentence. */
export function recordNotRun(sentences) {
  const fixed = Object.freeze({ ...sentences });
  return (code, details) => ({ status: 'not-run', reason: { code, message: fixed[code], ...(details ? { details } : {}) } });
}

/** What the command answered, as a client reads it. Only an error the installed CLI printed is a refusal
 * (kernel-made.mjs); one the adapter wrote (a timeout, no envelope, a nonzero exit) is an unknown outcome, as is a
 * success `answer(result)` does not read as the contract's (it returns the ok answer, or null). */
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
  return { status: 'unknown', reason: { code: typeof error?.code === 'string' && /^E_CLI_[A-Z_]+$/.test(error.code) ? error.code : 'E_OUTCOME_UNKNOWN' } };
}

/** The route re-reads the roster at once after this answer: a change, or an outcome not known (the record may have
 * changed). A refusal, a check and nothing run leave the roster as it is. */
export const rereadsRoster = result => (result?.status === 'ok' && result.changed === true) || result?.status === 'unknown';

/** The request a verb takes: { instance, home, <field> } or { instance, home, check: true }, exactly; else null. */
function requestOf(verb, r) {
  if (!record(r) || typeof r.instance !== 'string' || !NAME.test(r.instance) || typeof r.home !== 'string' || !isAbsolute(r.home) || r.home.includes('\0')) return null;
  const keys = Object.keys(r).sort().join(',');
  if (keys === 'check,home,instance') return r.check === true ? { instance: r.instance, home: r.home, check: true } : null;
  if (keys === [verb.field, 'home', 'instance'].sort().join(',')) return verb.valid(r[verb.field]) ? { instance: r.instance, home: r.home, [verb.field]: r[verb.field] } : null;
  return null;
}

/** The boundary for one verb. `verb`:
 *   field        the request's and the answer's field ('color', 'background', 'pinned')
 *   valid(v)     the field's values
 *   feature      the kernel feature that gates it, here and on a remote row's host
 *   unavailable  the not-run code without it (E_INSTANCE_<VERB>_UNAVAILABLE)
 *   notRun       recordNotRun(its sentences)
 *   invoke       the CLI call: (bin, { instance, home, <field>, context | server }, io) → envelope (cli-adapter.mjs)
 *   answer(result, asked)  the kernel's success read as { status: 'ok', instance, <field>, changed }, or null
 * `invoke` (option) replaces the verb's own CLI call (tests). `getContext()` → { workspace, cli, instances, localCwd }:
 * the held workspace, this computer's CLI probe, the rows the backend holds for it and the backend's own cwd (the
 * routed command's). */
export function createInstanceRecordBoundary(verb, { invoke = verb?.invoke } = {}) {
  if (!FIELD.test(verb?.field ?? '') || typeof verb.valid !== 'function' || typeof verb.feature !== 'string' || !CODE.test(verb.unavailable ?? '')
    || typeof verb.notRun !== 'function' || typeof invoke !== 'function' || typeof verb.answer !== 'function') throw new TypeError('createInstanceRecordBoundary: an incomplete verb');
  const notRun = verb.notRun, busy = new Set(); // workspace id + home: one write per home at a time
  return async function instanceRecordRequest(request, getContext) {
    try {
      const asked = requestOf(verb, request);
      if (!asked) return notRun('E_BAD_ARGS');
      const { workspace, cli, instances = [], localCwd } = getContext() || {};
      if (!workspace || typeof workspace.id !== 'string' || typeof workspace.scope !== 'string' || !isAbsolute(workspace.scope)) return notRun('E_WORKSPACE_UNKNOWN');
      // Only a row this computer holds: its name and its home, the pair the kernel resolves.
      const row = instances.find(i => i?.home === asked.home && i?.instance === asked.instance);
      if (!row) return notRun('E_SNAPSHOT_UNKNOWN');
      const remote = !!(workspace.remote || workspace.server);
      if (remote && (!canAddressRemote(row) || typeof workspace.server !== 'string')) return notRun('E_SNAPSHOT_UNKNOWN');
      // This computer's CLI first (it runs or routes the verb, and relays the hosts' features): `local`. Only then the
      // host's own: `server`, so a host that advertises the feature is never blamed for this computer's CLI.
      const here = advertises(cli, verb.feature) && typeof cli?.bin === 'string' && (!remote || advertises(cli, PROBE_FEATURES_FEATURE));
      if (!here) return notRun(verb.unavailable, { where: 'local' });
      if (remote && !hostAdvertises(workspace.group, verb.feature)) return notRun(verb.unavailable, { where: 'server' });
      if (asked.check) return { status: 'ok', instance: asked.instance, check: true };
      const key = `${workspace.id}\0${asked.home}`;
      if (busy.has(key)) return notRun('E_BUSY');
      busy.add(key);
      try {
        const envelope = await invoke(cli.bin, { instance: asked.instance, home: asked.home, [verb.field]: asked[verb.field],
          ...(remote ? { server: workspace.server } : { context: workspace.scope }) }, remote ? { cwd: localCwd } : {});
        return recordOutcome(envelope, result => verb.answer(result, asked));
      } catch { return { status: 'unknown', reason: { code: 'E_OUTCOME_UNKNOWN' } }; }
      finally { busy.delete(key); }
    } catch { return notRun('E_BAD_ARGS'); }
  };
}
