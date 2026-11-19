/** The agent's board (feature `instance-board`, `boardApi: 1`; docs/desktop-cli-api.md, "The agent's board"): the
 * facts an agent keeps in a person's view and the questions it asks them, as the kernel reports them on an
 * `oats status --json` row (`board`) and, with history and context, on `oats inspect --home <h> --board --json`.
 * Agent-reported and display only (instance-activity-is-reported-not-inferred): nothing here reads a terminal.
 *
 * One shared design: both clients read the board through this module, so the facts a client shows, the order,
 * the bounds and the answer it types are the same everywhere. Pure, no DOM, never throws. A contract module: the
 * server imports it (deployment-data, remote-roster), so it imports contract modules only.
 *
 * Every text is validated against the kernel's own bounds, and a value out of the contract drops only itself:
 * a malformed fact or question is left out, the rest of the board stays. The row's `board` is absent without the
 * feature and `null` when the home has no board file; both read as "no board" (`boardData` → null), and a row
 * whose kernel lacks the feature keeps today's terminal and waiting row (`rowHasBoard`). */
import { record } from './readiness-contract.mjs';
import { NOT_NOTE_TEXT, UNSAFE } from './display-text.mjs';

export const BOARD_FEATURE = 'instance-board';
export const BOARD_API = 1;
/** The kernel's bounds (contract v4): facts per board, open questions, options per question, history per fact. */
export const BOARD_LIMITS = Object.freeze({ facts: 12, questions: 9, optionsMin: 2, optionsMax: 4, history: 20,
  label: 40, value: 80, unit: 16, option: 60, question: 200, context: 2000, link: 512 });
/** The facts shown before the fold. */
export const FACTS_SHOWN = 3;
/** The producer of the board's own needs-input claim (reason `attention`). */
export const BOARD_PRODUCER = 'oats.board';
/** The claim reasons that say a harness's own dialog is on the agent's screen (a screen an Enter answers). */
export const DIALOG_REASONS = Object.freeze(['permission', 'question']);

const KEY = /^[a-z0-9][a-z0-9-]{0,15}$/;
const points = v => [...v].length;
/** A one-line text of at most `max` code points: non-empty, not only spaces, none of the refused characters. */
const line = (v, max) => typeof v === 'string' && v.trim() !== '' && points(v) <= max && !NOT_NOTE_TEXT.test(v);
/** The kernel's time: an ISO-8601 instant that parses. */
const instant = v => typeof v === 'string' && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v));
/** An absolute https: URL of at most 512 ASCII characters, with a host and no credentials. */
export function boardLink(v) {
  if (typeof v !== 'string' || !v || v.length > BOARD_LIMITS.link || !/^[\x21-\x7e]+$/.test(v)) return null;
  let url;
  try { url = new URL(v); } catch { return null; }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
  return { href: v, host: url.hostname };
}
/** Whether a text the agent wrote may be shown as it is: valid, and not UNSAFE (a secret, a credentialed URL), which
 * the display filter would withhold whole. */
const shown = v => !UNSAFE.test(v);

function fact(v) {
  if (!record(v) || typeof v.key !== 'string' || !KEY.test(v.key) || !line(v.label, BOARD_LIMITS.label)
    || !line(v.value, BOARD_LIMITS.value) || !instant(v.at)) return null;
  const unit = v.unit == null ? null : line(v.unit, BOARD_LIMITS.unit) ? v.unit : undefined;
  const link = v.link == null ? null : boardLink(v.link) ?? undefined;
  if (unit === undefined || link === undefined) return null;
  return { key: v.key, label: v.label, value: v.value, unit, link, at: v.at, withheld: !shown(v.label) || !shown(v.value) || (unit !== null && !shown(unit)) };
}
function question(v) {
  if (!record(v) || typeof v.id !== 'string' || !KEY.test(v.id) || !line(v.question, BOARD_LIMITS.question) || !instant(v.since)
    || !Array.isArray(v.options) || v.options.length < BOARD_LIMITS.optionsMin || v.options.length > BOARD_LIMITS.optionsMax
    || !v.options.every(o => line(o, BOARD_LIMITS.option))) return null;
  return { id: v.id, question: v.question, options: [...v.options], hasContext: v.hasContext === true, since: v.since,
    // A text the display filter withholds is never shown, so it is never typed either (answerText).
    withheld: !shown(v.question), optionsWithheld: v.options.map(o => !shown(o)) };
}
/** The first of each key (facts) or id (questions), in the kernel's order, up to `max`. */
function unique(list, make, by, max) {
  const out = [], seen = new Set();
  for (const item of list) {
    if (out.length >= max) break;
    const made = make(item);
    if (made && !seen.has(made[by])) { seen.add(made[by]); out.push(made); }
  }
  return out;
}

/** A row's `board`, validated: `{ facts, questions, malformed, dropped }` (facts in the order first set, questions in
 * the order asked), or null when the row has none (absent or `null`: the home has no board file). A value that is not
 * a board is `malformed` (nothing shown from it), and `dropped` counts the entries left out as out of the contract, so
 * the view can say the board was not read whole: neither ever reads as "no questions". Never throws. */
export function boardData(v) {
  if (v === null || v === undefined) return null;
  if (!record(v)) return { facts: [], questions: [], malformed: true, dropped: 0 };
  const lists = Array.isArray(v.facts ?? []) && Array.isArray(v.questions ?? []);
  const rawFacts = Array.isArray(v.facts) ? v.facts : [], rawQuestions = Array.isArray(v.questions) ? v.questions : [];
  const facts = unique(rawFacts, fact, 'key', BOARD_LIMITS.facts), questions = unique(rawQuestions, question, 'id', BOARD_LIMITS.questions);
  return { facts, questions, malformed: !lists,
    dropped: Math.min(rawFacts.length, BOARD_LIMITS.facts) - facts.length + Math.min(rawQuestions.length, BOARD_LIMITS.questions) - questions.length };
}
/** Whether the agent view replaces the plain terminal for this row: its kernel reports the board (the CLI lists
 * BOARD_FEATURE and the row carries the field, `null` included). A remote row carries `board` only when its host
 * relays it. Without it the tab is today's terminal with its waiting row. */
export const rowHasBoard = (row, features) => record(row) && Object.hasOwn(row, 'board')
  && Array.isArray(features) && features.includes(BOARD_FEATURE);

/** `oats inspect --home <h> --board --json`'s board, validated, as one of five outcomes the view tells apart:
 *  - `{ state: 'ok', facts, questions }`: each fact's `history` (`[{ value, at }]`, oldest first, at most 20, each value
 *    within the contract's bounds) and each question's `context` (boardContext, or null) with its `since`;
 *  - `{ state: 'none' }`: the answer's board is `null` (the home has no board file);
 *  - `{ state: 'unsupported' }`: the answer has no board at all (an OATS, or a routed host, without the feature: the
 *    backend dropped the flag);
 *  - `{ state: 'malformed' }`: the answer is not an inspection, or its board is not one.
 * The fifth, `failed` (the read refused or failed), is the caller's. The board is the answer's `board`, or its
 * `instance.board`. Never throws. */
export function boardDetailData(v) {
  if (!record(v)) return { state: 'malformed' };
  const has = Object.hasOwn(v, 'board') ? 'board' : record(v.instance) && Object.hasOwn(v.instance, 'board') ? 'instance' : null;
  if (!has) return { state: 'unsupported' };
  const board = has === 'board' ? v.board : v.instance.board;
  if (board === null) return { state: 'none' };
  if (!record(board) || !Array.isArray(board.facts ?? []) || !Array.isArray(board.questions ?? [])) return { state: 'malformed' };
  const facts = new Map(), questions = new Map();
  for (const f of Array.isArray(board.facts) ? board.facts : []) {
    if (!record(f) || typeof f.key !== 'string' || !KEY.test(f.key) || facts.has(f.key)) continue;
    const history = (Array.isArray(f.history) ? f.history : [])
      .filter(h => record(h) && line(h.value, BOARD_LIMITS.value) && instant(h.at))
      .slice(-BOARD_LIMITS.history).map(h => ({ value: h.value, at: h.at }));
    facts.set(f.key, { history });
    if (facts.size >= BOARD_LIMITS.facts) break;
  }
  for (const q of Array.isArray(board.questions) ? board.questions : []) {
    if (!record(q) || typeof q.id !== 'string' || !KEY.test(q.id) || questions.has(q.id)) continue;
    // Its `since` too: the view shows a context only under the occurrence it was read for.
    questions.set(q.id, { context: boardContext(q.context), since: instant(q.since) ? q.since : null });
    if (questions.size >= BOARD_LIMITS.questions) break;
  }
  return { state: 'ok', facts, questions };
}
/** A question's context: lines of text (LF only), at most 2000 code points, none of the refused characters but the
 * line feed, not UNSAFE; null otherwise. Kept as the agent wrote it, line breaks included: shown as a quote. */
export function boardContext(v) {
  if (typeof v !== 'string' || !v.trim() || points(v) > BOARD_LIMITS.context) return null;
  if (v.split('\n').some(l => NOT_NOTE_TEXT.test(l)) || UNSAFE.test(v)) return null;
  return v;
}

/** A sparkline's points from a fact's history: the numeric values (the first number in each value, so "0.4312"
 * and "41 %" both read), oldest first. Null under two numbers: a line needs two points. */
export function sparkValues(history) {
  if (!Array.isArray(history)) return null;
  const values = [];
  for (const h of history) {
    const m = typeof h?.value === 'string' ? h.value.match(/-?\d+(?:[.,]\d+)?/) : null;
    if (m) values.push(Number(m[0].replace(',', '.')));
  }
  return values.length >= 2 && values.every(Number.isFinite) ? values : null;
}

/** The facts the strip shows, in the kernel's order: `shown` (at most FACTS_SHOWN, unless `unfolded`), `folded`
 * (the rest of the visible ones) and `hidden` (those the person hid on this computer). `hiddenKeys`: a Map from a
 * fact's key to the value it was hidden at; a fact whose value has changed since shows again (the agent said
 * something new). `limit`: fewer shown where the pane is short (the agent view's budget). */
export function factsView(facts, hiddenKeys = new Map(), { unfolded = false, limit = FACTS_SHOWN } = {}) {
  const visible = [], hidden = [];
  for (const f of facts) (hiddenKeys.has(f.key) && hiddenKeys.get(f.key) === f.value ? hidden : visible).push(f);
  const cut = unfolded ? visible.length : limit;
  return { shown: visible.slice(0, cut), folded: visible.slice(cut), hidden };
}

/** Whether a live claim says the agent's terminal shows a harness dialog: any positive claim, from any producer, whose
 * reason is `permission` or `question` (waiting-claims-may-only-withhold-automated-input). `claims`: the row's
 * `waitingOnYou` and, read while the view is open, the events read's `waitingClaims`. Unknown is not a dialog:
 * the card never sends on its own, so the person's Enter, with the terminal in view, stays the consent. */
export function dialogOpen(claims) {
  return (Array.isArray(claims) ? claims : [claims]).some(c => record(c) && c.waiting !== false
    && typeof c.reason === 'string' && DIALOG_REASONS.includes(c.reason));
}
/** Whether a claim is the board's own (its questions show in the question zone, not in the waiting row). */
export const boardClaim = claim => record(claim) && claim.producer === BOARD_PRODUCER;

/** What pressing option `index` (0-based) of `q` types on the agent's input line: `<id>: <option>`, one line, never
 * a bare digit and never a line end, so nothing is sent until the person presses Enter. Null when there is nothing
 * the person can see to type: no such option, or an option the display filter withholds. */
export function answerText(q, index) {
  if (!record(q) || typeof q.id !== 'string' || !KEY.test(q.id) || !Array.isArray(q.options)) return null;
  const option = q.options[index];
  if (!line(option, BOARD_LIMITS.option) || q.optionsWithheld?.[index] === true || !shown(option)) return null;
  return `${q.id}: ${option}`;
}

/** "question 2 of 3", or null for a single question. */
export const questionCount = (index, total) => total > 1 ? `question ${index + 1} of ${total}` : null;
/** The index after turning by `step` (±1) among `total` questions, wrapping at the ends. */
export const turnQuestion = (index, step, total) => total > 0 ? ((index + step) % total + total) % total : 0;

/** A fact's change, as the strip says it: "updated just now", "updated 4 min ago", "updated 3 h ago",
 * "updated 2 d ago", then the date. A future time (clock skew) reads "just now". */
export function updatedText(at, now = Date.now()) {
  const ms = now - Date.parse(at);
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return 'updated just now';
  const m = Math.floor(s / 60); if (m < 60) return `updated ${m} min ago`;
  const h = Math.floor(m / 60); if (h < 24) return `updated ${h} h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `updated ${d} d ago`;
  return `updated ${new Date(Date.parse(at)).toISOString().slice(0, 10)}`;
}
/** When the view reads the detail again (the maintainer's condition, 2026-11-19): a fact's `at` changed (or a fact
 * came or went), or a question with context was asked (an occurrence: questionOccurrence). Never on an unchanged poll. */
export const detailSignature = board => board ? JSON.stringify([board.facts.map(f => [f.key, f.at]),
  board.questions.filter(q => q.hasContext).map(questionOccurrence)]) : 'none';
/** A question's occurrence: its id and when it was asked. An id the agent clears and asks again (a new `since`) is
 * another question, with its own answer and its own context, even when no poll saw it cleared in between. */
export const questionOccurrence = q => `${q.id}@${q.since}`;
/** A board's identity for repaints: changes when a fact's value or time, or the set of questions, changes. */
export const boardSignature = board => board ? JSON.stringify([board.facts.map(f => [f.key, f.value, f.unit, f.link?.href ?? null, f.at, f.label]),
  board.questions.map(q => [q.id, q.question, q.options, q.hasContext, q.since])]) : 'none';
