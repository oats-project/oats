// The OATS vocabulary of the agent status (aweb-acah.3): what one home's
// kernel state and provider readiness mean for whether it can hear you now.
// The table is docs/design/2026-10-14-agent-health-publisher.md §2; the first
// matching row wins. Codes are an OATS contract and only ever added; texts
// come from a fixed phrase file per language, because readiness messages carry
// paths and hostnames. On a native channel home, the channel's receipt of an
// open stream proves receive; without one, `yes` means "running, with its
// channel loaded and nothing known wrong", not "delivery proven". A home under
// session delivery never has a receipt: the broker rows judge it.
import {readFileSync} from 'node:fs';

const phrases = (language) => JSON.parse(readFileSync(new URL(`../phrases/${language}.json`, import.meta.url), 'utf8'));
export const PHRASES = {en: phrases('en')};
/** The phrase table for `language`, or en when there is none. */
const phrasesFor = (language) => (Object.hasOwn(PHRASES, language) ? PHRASES[language] : PHRASES.en);

const GRANT_EXPIRING_MS = 24 * 3600 * 1000;
const RANK = {yes: 0, degraded: 1, no: 2, unknown: 3};

/** Provider readiness problem codes, in table order, each to its row. */
const PROBLEM_ROWS = [
  [['custody'], 'no', 'oats.custody_down', 'operator'],
  [['grant-expired'], 'no', 'oats.grant_expired', 'operator'],
  [['grant-revoked'], 'no', 'oats.grant_revoked', 'operator'],
  [['wake-daemon-not-running', 'wake-status-unavailable', 'wake-stream-unavailable', 'wake-worker-unavailable'], 'no', 'oats.wake_broker_down', 'operator'],
  [['wake-target-missing', 'wake-stream-missing', 'wake-target-inactive', 'wake-target-binding', 'receive-record-unavailable'], 'no', 'oats.wake_not_registered', 'operator'],
  [['wake-target-paused'], 'no', 'oats.wake_paused', 'operator'],
  [['channel-not-connected'], 'no', 'oats.channel_not_loaded', 'operator'],
  [['receive-inspection-unproven', 'wake-status-stale', 'wake-status-timestamp-unknown', 'wake-daemon-version-unknown'], 'unknown', 'oats.receive_unknown', 'unknown'],
];
// `receive-inspection-aged` is not among them. The inspection the broker
// records is its worker's, made only at startup and before a delivery (its
// presence heartbeat inspects but records nothing), so an idle home's
// recorded inspection ages without a fault (#332). Readiness is read only for a home this tick's own
// session inspect found alive, the same observation, made fresh.
const RECEIVE_UNPROVEN_WARNINGS = ['receive-ownership-unproven', 'receive-observation-aged', 'receive-observation-unproven'];
/** Launch prompt outcomes that show the channel was loaded: a confirmed
 *  development prompt, or approved mode, where no prompt is engaged. */
const CHANNEL_LOADED = ['completed', 'not-engaged'];

const row = (reachable, code, by) => ({reachable, code, by});

/** The first matching row of the table for one home. `liveness` is
 *  {state: alive|shell|stopped|not-launched|unobservable, lastEvent};
 *  `readiness` is the provider's {status, problems, warnings}, or null when
 *  it could not be read; `identity` is {kind: 'primary'} or
 *  {kind: 'joined', receive}; `receive` is {native, receipt}, where native
 *  says the home receives through its own channel and receipt is proven,
 *  stale or absent. */
function classify({now, liveness, launchPrompts, readiness, grant, identity, receive}) {
  const {state, lastEvent} = liveness;
  if (state !== 'alive' && state !== 'unobservable') {
    if (lastEvent === 'stopped') return row('no', 'oats.stopped', 'nobody');
    if (state === 'not-launched' || !lastEvent) return row('no', 'oats.not_started', 'operator');
    return row('no', 'oats.not_running', 'operator');
  }
  if (state === 'unobservable') return row('unknown', 'oats.session_unobservable', 'unknown');
  if (launchPrompts?.status === 'blocked') return row('no', 'oats.launch_prompt_waiting', 'operator');
  // Only the home's own channel was ignored; a joined identity is woken by the broker.
  if (launchPrompts?.status === 'flag-ignored' && identity?.kind !== 'joined') return row('no', 'oats.channel_not_loaded', 'operator');
  if (!readiness) return row('unknown', 'oats.readiness_unavailable', 'unknown');
  const problems = new Set((readiness.problems || []).map((p) => p.code));
  const warnings = new Set((readiness.warnings || []).map((w) => w.code));
  if (readiness.status === 'needs-configuration' && !problems.size) problems.add('needs-configuration');
  if (problems.has('needs-configuration')) return row('no', 'oats.needs_configuration', 'operator');
  if (readiness.status === 'authorization-required') return row('no', 'oats.authorization_required', 'operator');
  for (const [codes, reachable, code, by] of PROBLEM_ROWS) if (codes.some((c) => problems.has(c))) return row(reachable, code, by);
  if (problems.size) return row('unknown', 'oats.unclassified', 'unknown');
  const expiresAt = Date.parse(grant?.expiresAt);
  if (warnings.has('grant-expiring') && expiresAt - now <= GRANT_EXPIRING_MS) return row('degraded', 'oats.grant_expiring', 'operator');
  if (identity?.kind === 'joined' && identity.receive === 'poll') return identity.expectedPoll === true ? row('yes') : row('degraded', 'oats.joined_team_poll_only', 'operator');
  if (RECEIVE_UNPROVEN_WARNINGS.some((c) => warnings.has(c))) return row('degraded', 'oats.receive_unproven', 'unknown');
  if (receive?.native && identity?.kind !== 'joined') {
    if (receive.receipt === 'proven') return row('yes');
    if (receive.receipt === 'stale') return row('no', 'oats.channel_stream_down', 'operator');
  }
  if (warnings.has('native-receive-unproven') && !CHANNEL_LOADED.includes(launchPrompts?.status)) return row('unknown', 'oats.receive_unknown', 'unknown');
  return row('yes');
}

/** One home's {reachable, reason?, fixing?}, worded in `language` (falling
 *  back to en) with `operator` as the role that fixes what needs a person. */
export function assessHealth(input) {
  const {reachable, code, by} = classify(input);
  if (reachable === 'yes') return {reachable};
  const words = phrasesFor(input.language);
  const reason = {code, text: words.reasons[code] ?? PHRASES.en.reasons[code]};
  const fixing = by === 'operator' ? {by, text: input.operator || words.operator}
    : by === 'nobody' ? {by, text: words.nobody}
    : {by};
  return {reachable, reason, fixing};
}

/** A resident whose seats on this host are all retired. */
export function retiredHealth({language} = {}) {
  const words = phrasesFor(language);
  return {reachable: 'no', reason: {code: 'oats.retired', text: words.reasons['oats.retired'] ?? PHRASES.en.reasons['oats.retired']}, fixing: {by: 'nobody', text: words.nobody}};
}

/** One resident's status from its seats on this host: the best seat wins. */
export function combineSeats(seats) {
  return seats.reduce((best, seat) => (RANK[seat.reachable] < RANK[best.reachable] ? seat : best));
}
