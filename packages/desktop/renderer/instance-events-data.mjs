/** API2 address-history projection. No log parsing, activity inference or IO.
 * Counts/integrity/claims come from the producer, not reconstructed from prose. */
import { harnessOf } from '../../client/harness-names.mjs';
import { record } from '../../client/readiness-contract.mjs';
import { eventsTarget, eventsLimit, eventsTimestamp, eventsId, eventsDetail } from '../../client/instance-events-contract.mjs';
import { waitingMessage } from '../../client/waiting-on-you.mjs';
import { launchPromptDiffered } from '../../client/launch-prompt-outcome.mjs';
const count = v => Number.isSafeInteger(v) && v >= 0;
const birth = v => v === null || eventsTimestamp(v);
const id = eventsId, detail = eventsDetail;
const nullableDetail = (v, max) => v === null ? null : detail(v, max);
export const EVENT_TITLES = Object.freeze({ spawned: 'Spawned', launched: 'Launched', restarted: 'Restarted', stopped: 'Stopped',
  'stop-refused': 'Stop refused', 'retire-planned': 'Retirement planned', retired: 'Retired',
  'worktree-retained': 'Worktree retained', 'worktree-removed': 'Worktree removed', 'branch-deleted': 'Branch deleted',
  'child-spawn-refused': 'Child spawn refused', 'launch-prompt': 'Launch prompt', recomposed: 'Instructions recomposed', waiting: 'Waiting claim',
  'worktree-added': 'Worktree added', 'modules-upgraded': 'Modules upgraded',
  'upgrade-refused': 'Module upgrade refused' });
const strings = {
  spawned: ['agent', 'work', 'branch', 'model', 'parentInstance', 'relation'], launched: ['backend', 'launchConfig'],
  restarted: ['phase', 'signal'], stopped: ['signal', 'state'], 'stop-refused': ['phase', 'signal', 'state'],
  'retire-planned': ['planRevision'], retired: ['agent', 'workRecovery'], 'worktree-retained': ['movedTo', 'branch', 'recordedBranch'],
  'worktree-removed': ['branch'], 'branch-deleted': ['branch'], 'child-spawn-refused': ['child', 'agent'], recomposed: ['previous', 'soulDir'],
  'launch-prompt': ['status', 'class', 'action', 'consentSource'],
};
const numbers = { restarted: ['waitedMs'], stopped: ['waitedMs'], 'stop-refused': ['waitedMs'], 'retire-planned': ['children', 'dirty'], recomposed: ['blocks'] };
const booleans = { spawned: ['launched'], retired: ['keepDir', 'self', 'quarantine'] };
/** Read tolerantly, outside the listed keys above (which refuse the read when malformed): a malformed value
 * drops only its own fact. `worktree-added` (0.49.0): an extra tree `oats worktree add` made.
 * `launch-prompt`: the Claude version the kernel read (0.52.0: a version, or "unknown") and the id of the
 * confirmation it matched. A row's facts follow the kernel that wrote it, and a log keeps its rows:
 * `consentSource` (listed above) is only on rows a 0.44 to 0.51 kernel wrote, `claudeVersion` and `differed`
 * only on rows from 0.52.0. The pane's identity, `startId`, `key`, `signatureDigest` and
 * `claudeVersionSource` are not read. `upgrade-refused`: the step that failed (`hook <capability>` names the module). */
const tolerant = { 'worktree-added': ['purpose', 'path', 'branch', 'base', 'member'], 'launch-prompt': ['claudeVersion', 'signatureId'],
  'upgrade-refused': ['step'] };
const tolerantText = v => typeof v === 'string' && !!v && v.length <= 4096 ? detail(v, 4096) : undefined;
/** A `worktree` hooks' receipt (`worktree-added` `hooks`, `spawned` `worktreeHooks`, 0.49.0) as `[{capability, ok,
 * log}]`, `log` the hook's log file or null (a rolled-back spawn's log is removed). Anything malformed, the value
 * or one entry, is undefined: the fact is dropped, never the read. Idempotent, so the renderer's re-read agrees. */
export function hookReceipt(v) {
  if (!Array.isArray(v) || !v.length || v.length > 256) return undefined;
  const out = [];
  for (const h of v) {
    if (!record(h) || typeof h.ok !== 'boolean' || tolerantText(h.capability) === undefined
      || !(h.log == null || tolerantText(h.log) !== undefined)) return undefined;
    out.push({ capability: tolerantText(h.capability), ok: h.ok, log: h.log == null ? null : tolerantText(h.log) });
  }
  return out;
}
const keysFor = (table, kind) => Object.hasOwn(table, kind) ? table[kind] : [];
function facts(kind, v, publicView) {
  if (v === undefined) return {};
  if (!record(v)) throw Error('invalid event facts');
  const out = {};
  for (const key of keysFor(strings, kind)) if (Object.hasOwn(v, key)) out[key] = nullableDetail(v[key], 4096);
  // The harness: `harness` (0.27) or a released kernel's `runtime`.
  if (['spawned', 'launched'].includes(kind) && harnessOf(v) !== undefined) out.harness = nullableDetail(harnessOf(v), 4096);
  for (const key of keysFor(numbers, kind)) if (Object.hasOwn(v, key)) {
    if (!(count(v[key]) || key === 'dirty' && v[key] === null)) throw Error('invalid event count');
    out[key] = v[key];
  }
  for (const key of [...keysFor(booleans, kind), 'waitingOnYou']) if (Object.hasOwn(v, key)) {
    if (typeof v[key] !== 'boolean') throw Error('invalid event boolean');
    out[key] = v[key];
  }
  if (Object.hasOwn(v, 'reason')) out.reason = nullableDetail(v.reason);
  for (const key of keysFor(tolerant, kind)) { const fact = tolerantText(v[key]); if (fact !== undefined) out[key] = fact; }
  const hooks = kind === 'worktree-added' ? 'hooks' : kind === 'spawned' ? 'worktreeHooks' : null;
  const receipt = hooks && hookReceipt(v[hooks]);
  if (receipt) out[hooks] = receipt;
  // What a blocked launch's screen differed in (0.52.0), on the row that records the miss: the outcome
  // reader's decoder and its rule (only beside `blocked`). Tolerant and idempotent, as there.
  const differed = kind === 'launch-prompt' && v.status === 'blocked' ? launchPromptDiffered(v.differed) : undefined;
  if (differed) out.differed = differed;
  // A waiting claim's note (K's `waiting` rows): the claim rule — absent stays absent, malformed is null.
  if (kind === 'waiting' && Object.hasOwn(v, 'message')) out.message = waitingMessage(v.message);
  if (['stopped', 'stop-refused', 'restarted'].includes(kind)) {
    if (publicView && Object.hasOwn(v, 'stillRunningCount')) {
      if (!count(v.stillRunningCount) || v.stillRunningCount > 128) throw Error('invalid target count');
      out.stillRunningCount = v.stillRunningCount;
    } else if (!publicView && Object.hasOwn(v, 'stillRunning')) {
      if (!Array.isArray(v.stillRunning) || v.stillRunning.length > 128) throw Error('invalid targets');
      out.stillRunningCount = v.stillRunning.length; // never publish PID/command arrays
    }
  }
  if (kind === 'child-spawn-refused' && Object.hasOwn(v, 'policy')) {
    if (!record(v.policy) || typeof v.policy.allowed !== 'boolean' || !record(v.policy.origin) || !id(v.policy.origin.kind)) throw Error('invalid policy fact');
    out.policy = { allowed: v.policy.allowed, origin: { kind: v.policy.origin.kind } }; // no raw config/detail
  }
  return out;
}
export function eventsIntegrity(v) {
  if (!record(v) || !count(v.unreadableRows) || !count(v.foreignRows) || !Array.isArray(v.sources) || v.sources.length !== 2) return null;
  const sources = [];
  for (const s of v.sources) {
    if (!record(s) || !['home', 'workspace'].includes(s.path) || sources.some(p => p.path === s.path)
      || !['ok', 'absent', 'refused', 'tail'].includes(s.status) || !count(s.bytes)
      || s.status === 'absent' && s.bytes !== 0 || s.status === 'ok' && s.bytes > 4194304 || s.status === 'tail' && s.bytes <= 4194304) return null;
    sources.push({ path: s.path, status: s.status, bytes: s.bytes });
  }
  return { unreadableRows: v.unreadableRows, foreignRows: v.foreignRows, sources };
}
export const eventsIncomplete = v => !!v && (v.truncated || v.integrity.unreadableRows > 0 || v.integrity.foreignRows > 0
  || v.integrity.sources.some(s => ['tail', 'refused'].includes(s.status)));
export const eventIncarnation = (row, data) => row.incarnation === null || data.incarnation === null ? 'unknown'
  : row.incarnation === data.incarnation ? 'current' : 'earlier';
function event(v, target, publicView) {
  if (!record(v) || ![1, 2].includes(v.eventsApi) || v.instance !== target.selector.instance || v.home !== target.home
    || !birth(v.incarnation) || !eventsTimestamp(v.at) || !id(v.kind) || !id(v.producer)) throw Error('invalid event identity');
  return { eventsApi: v.eventsApi, instance: v.instance, home: v.home, incarnation: v.incarnation,
    at: v.at, producer: v.producer, kind: v.kind, data: facts(v.kind, v.data, publicView) };
}
/** The publicView switch is an INTERNAL caller contract (IPC reprojection), not
 * a request field. Private PID arrays are projected only on the CLI boundary. */
export function eventsData(v, expected, limit = 100, { publicView = false } = {}) {
  try {
    const target = eventsTarget(expected), integrity = eventsIntegrity(v?.integrity);
    if (!target || !eventsLimit(limit) || !record(v) || v.eventsApi !== 2 || v.instance !== target.selector.instance || v.home !== target.home
      || !birth(v.incarnation) || v.incarnation !== target.incarnation || !integrity || !count(v.count) || !count(v.returned)
      || typeof v.truncated !== 'boolean' || !Array.isArray(v.events) || v.events.length !== v.returned
      || v.returned !== Math.min(v.count, limit) || v.truncated !== (v.count > v.returned || integrity.sources.some(s => s.status === 'tail'))
      || !Array.isArray(v.waitingClaims) || v.waitingClaims.length > 200) return null;
    const events = v.events.map(row => event(row, target, publicView));
    if (events.some((row, index) => index > 0 && row.at < events[index - 1].at)) return null;
    const last = events.at(-1), expectedLast = last ? { kind: last.kind, at: last.at, producer: last.producer, incarnation: last.incarnation } : null;
    if (last ? !record(v.lastEvent) || Object.keys(expectedLast).some(k => v.lastEvent[k] !== expectedLast[k]) : v.lastEvent !== null) return null;
    const claims = [];
    for (const c of v.waitingClaims) {
      if (!record(c) || !id(c.producer) || claims.some(p => p.producer === c.producer) || typeof c.waiting !== 'boolean'
        || !eventsTimestamp(c.since) || !c.waiting && c.reason !== null) return null;
      // `message` is optional (kernels before waiting-on-you omit it): absent or malformed → null, the claim kept.
      claims.push({ producer: c.producer, waiting: c.waiting, since: c.since, reason: nullableDetail(c.reason), message: waitingMessage(c.message) });
    }
    // Unknown incarnation cannot license ANY current-incarnation claim. Do not
    // repeat the PR89 producer's null-incarnation/all-history fallback.
    if (v.incarnation === null && claims.length) return null;
    // The kernel's rule (lib/instance-events.mjs positiveOf, #1502): the newest positive claim that carries a message,
    // so a claim with no text never hides one a person can read; the newest text-less claim only adds the reason it
    // lacks. With no message anywhere, the newest positive claim. (Before, this read the newest positive claim alone,
    // and refused as a protocol error every answer where a text-less claim, a harness's dialog, came after one with
    // text, such as the board's own question.)
    // The message is compared raw when either side owns it (a missing key is null): one-sided is a mismatch.
    const message = side => Object.hasOwn(side, 'message') ? side.message : null;
    const positives = v.waitingClaims.filter(c => c.waiting).sort((a, b) => a.since.localeCompare(b.since));
    const said = positives.filter(c => message(c) !== null).at(-1), unsaid = positives.filter(c => message(c) === null).at(-1);
    const positive = said ? (said.reason === null && unsaid ? { ...said, reason: unsaid.reason } : said) : unsaid;
    let waitingOnYou = null;
    if (positive) {
      if (!record(v.waitingOnYou) || ['producer', 'since', 'reason'].some(k => v.waitingOnYou[k] !== positive[k])
        || message(v.waitingOnYou) !== message(positive)) return null;
      waitingOnYou = { producer: positive.producer, since: positive.since, reason: nullableDetail(positive.reason), message: waitingMessage(v.waitingOnYou.message) };
    } else if (v.waitingOnYou !== null) return null;
    if (!integrity.sources.some(s => ['ok', 'tail'].includes(s.status)) && (v.count || integrity.unreadableRows || integrity.foreignRows || claims.length)) return null;
    return { eventsApi: 2, instance: v.instance, home: v.home, incarnation: v.incarnation,
      count: v.count, returned: v.returned, truncated: v.truncated, integrity, events, lastEvent: expectedLast, waitingOnYou, waitingClaims: claims };
  } catch { return null; }
}
