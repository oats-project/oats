/** "Needs input" (Spec D): the kernel's `waitingOnYou` claim on an `oats status --json` row, validated
 * once here and read through one liveness gate by every surface (row mark, card, description, collapsed
 * roll-up: instance-tree.mjs's waitingRollup). Pure, no DOM, never throws. `null` (or absent) means
 * unknown, never "not waiting". Display-only: nothing in Desktop acts on a claim.
 * The claim contract only: the server imports it (deployment-data, remote-roster), so it imports
 * contract modules and nothing else — no tree traversal, no loading UI. */
import { record } from './readiness-contract.mjs';
import { eventsTimestamp, eventsId, eventsUnsafe, EVENTS_WITHHELD } from './instance-events-contract.mjs';
import { NOT_NOTE_TEXT } from './display-text.mjs';
import { sessionProvider } from './instance-presentation.mjs';

/** A claim's note: a non-empty string of at most 200 code points (not UTF-16 units: 101 emoji is a valid
 * note), with none of NOT_NOTE_TEXT (the set's one definition is in display-text.mjs); unsafe text is
 * withheld (the activity view's house rule: it shows EVENTS_WITHHELD). Anything else → null: the claim
 * itself is kept. Not null is the validity answer the kernel's validWaitingMessage gives (a withheld note
 * is a valid note). Never throws (no length-throwing detail helper on this path). */
export function waitingMessage(v) {
  if (typeof v !== 'string' || !v || [...v].length > 200 || NOT_NOTE_TEXT.test(v)) return null;
  return eventsUnsafe.test(v) ? EVENTS_WITHHELD : v;
}

/** The sidebar's claim: `{ since, producer, reason, message }` or null. Only `since` and `producer` can
 * drop a claim: a missing or malformed reason (never rendered) is null, a malformed message is null, and
 * so is a withheld one (#584) or one with no character but white space (#1502): the row, the card and the
 * tab then show the reason in words (waitingLabel), never the withheld marker or a blank line. Extra keys
 * are ignored (forward compatible). */
export function waitingOnYouData(v) {
  if (!record(v) || !eventsTimestamp(v.since) || !eventsId(v.producer)) return null;
  const reason = typeof v.reason === 'string' && v.reason.length <= 64 ? v.reason : null;
  const message = waitingMessage(v.message);
  return { since: v.since, producer: v.producer, reason, message: message === EVENTS_WITHHELD || !message?.trim() ? null : message };
}

/** The claim a row may show, or null. The only gate: liveness says running (`running === true`, and no
 * reported `runtimeState` other than `running`: a tmux `shell`, a stopped pane, an unreachable or
 * unsupported session never shows it), and the row is current: a remote row whose server was not reached,
 * or a row the roster holds stale (`stale`: its last re-read failed), carries a last-known claim, which is
 * unknown. A null or absent `runtimeState` is "not reported", never "not running" (#582): the kernel's
 * remote roster sends null on every row, so a remote row is gated on the `running` its host reported; a
 * local row always carries the concrete state Desktop liveness observed.
 *
 * A row on a session provider (instance-presentation.mjs `sessionProvider`: "bb", say) has another liveness
 * gate, under the same two rules of currency: it shows the claim the kernel's row carries unless the row is
 * stopped (`running === false`). Its `runtimeState` is never "running" (a provider's states are `unknown`,
 * `shell`, `stopped`, `unreachable`), and an agent that waits on a person is idle there, which the kernel
 * reports as `running: null`: the kernel is such a row's only reader, and it decides whether the row carries
 * a claim at all. A home OATS stopped reads `running: false` and shows none. */
export function waitingClaim(row, { stale = false } = {}) {
  if (stale || !record(row) || row.serverUnreached === true) return null;
  if (sessionProvider(row)) return row.running === false ? null : waitingOnYouData(row.waitingOnYou);
  if (row.running !== true) return null;
  if (row.runtimeState != null && row.runtimeState !== 'running') return null;
  return waitingOnYouData(row.waitingOnYou);
}

/** The rows that need you, newest claim first (the Desktop's palette and Home, the TUI's list later: one order for
 * both clients, the Desktop UI rework, slice 4): each row's claim through the one gate (waitingClaim; `stale(row)`
 * says a row is held stale), as `{ row, claim }`. Equal times keep the rows' own order. */
export function needsYouRows(rows, { stale = () => false } = {}) {
  return (Array.isArray(rows) ? rows : []).map((row, at) => ({ row, at, claim: waitingClaim(row, { stale: stale(row) }) }))
    .filter(({ claim }) => claim)
    .sort((a, b) => Date.parse(b.claim.since) - Date.parse(a.claim.since) || a.at - b.at)
    .map(({ row, claim }) => ({ row, claim }));
}

const LABELS = Object.freeze({ permission: 'Waiting for a tool approval', question: 'Asked you a question', attention: 'Asked for your attention' });
/** The reason in words. The raw reason is never rendered: an unknown one reads "Needs input". */
export const waitingLabel = claim => Object.hasOwn(LABELS, claim?.reason ?? '') ? LABELS[claim.reason] : 'Needs input';
/** What a surface that already says "Needs input" adds after it: the message, else the reason in words,
 * else null, when the claim names no reason of its own and the tag's words say it all (#1502). */
export const waitingDetail = claim => claim?.message ?? (Object.hasOwn(LABELS, claim?.reason ?? '') ? LABELS[claim.reason] : null);

/** How long it has waited (floor): "under a minute", "N min", "N h", "N d". A future `since` (clock skew)
 * reads "under a minute". Computed when shown, never painted into the row. */
export function waitedText(since, now = Date.now()) {
  const ms = now - Date.parse(since);
  if (!Number.isFinite(ms) || ms < 60000) return 'under a minute';
  const min = Math.floor(ms / 60000); if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60); if (h < 24) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

// The app's copy is English; a fixed table keeps the date deterministic (no locale lookup).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = n => String(n).padStart(2, '0');
/** The claim's start in local time, as precise as it needs to be next to `now`: "14:03" on now's local
 * calendar day, "Oct 2, 14:03" on another day of the same year, "2025-10-02 14:03" in another year. */
export function waitingClock(since, now = Date.now()) {
  const at = new Date(since), today = new Date(now);
  if (!Number.isFinite(at.getTime())) return '';
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (at.getFullYear() !== today.getFullYear()) return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}`;
  return at.getMonth() === today.getMonth() && at.getDate() === today.getDate() ? time : `${MONTHS[at.getMonth()]} ${at.getDate()}, ${time}`;
}

/** "dev-a, dev-b" — up to 3 names, then "and N more". */
export function waitingNames(rows) {
  const names = rows.map(r => r.instance);
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
}

/** The card's "Below" fact: "2 need input: dev-a, dev-b". */
export const waitingBelowText = rows => `${rows.length} ${rows.length === 1 ? 'needs' : 'need'} input: ${waitingNames(rows)}`;

/** What an unavailable row (no card) appends to its title/aria-description sentence. Absolute time only:
 * the sentence is painted once; `now` is the paint time (it decides whether the start needs a date). */
export function waitingSentence(claim, below = [], now = Date.now()) {
  const parts = [];
  if (claim) {
    const detail = waitingDetail(claim);
    parts.push(`Needs input${detail ? `: ${detail}` : ''} since ${waitingClock(claim.since, now)}`);
  }
  if (below.length) parts.push(`${below.length} below need input: ${waitingNames(below)}`);
  return parts.map(p => ` · ${p}`).join('');
}
