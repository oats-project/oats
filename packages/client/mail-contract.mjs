/** An agent's own mail, read without acknowledging anything: the messaging layer's `messaging:mail` view operation
 * (docs/desktop-cli-api.md, "Mail", `mailApi: 1`), run as `oats operation run messaging:mail --home <abs> [--arg
 * limit=…] [--arg cursor=…] [--arg conversation=…] [--server <id>] --json`. Any messaging provider may answer it;
 * oats.aweb is the first. The provider's values are opaque strings here: identity, message and conversation ids,
 * team labels. Nothing in this module parses a provider-specific shape.
 *
 * The run's `result` is `{documents, mail}`: `documents` is the plain rendering every view carries, `mail` the
 * structured field this module decodes, exactly as the contract states it (shapes are closed: an unknown key, a
 * value outside its set or a bound passed is the whole answer unreadable, never a partial guess). An answer that
 * says it acknowledged (`acknowledges` other than false) is unreadable too: a client never shows mail read by
 * marking it read.
 *
 * Pure: no DOM, no IO, never throws. Shared by both clients (the Terminal UI renders the same sheet later). */
import { NOT_NOTE_TEXT } from './display-text.mjs';

export const MAIL_OPERATION = 'messaging:mail';
/** What a client asks for at a time (the contract's default) and at most. */
export const MAIL_PAGE = 50, MAIL_MAX_LIMIT = 200;
/** A body's bound, in UTF-8 bytes: past it the provider cuts and says `truncated: true`. */
export const MAIL_BODY_BYTES = 16 * 1024;
export const VERIFICATIONS = Object.freeze(['verified', 'unverified', 'failed', 'unknown']);
export const PRIORITIES = Object.freeze(['normal', 'high', 'unknown']);
export const DIRECTIONS = Object.freeze(['received', 'sent']);
export const PARTIAL_OLDEST_FIRST = 'oldest-first-only';

const MAIL_KEYS = ['mailApi', 'acknowledges', 'observedAt', 'identities', 'messages', 'conversations', 'hasMore', 'nextCursor'];
const IDENTITY_KEYS = ['team', 'alias', 'identity', 'primary', 'error'];
const MESSAGE_KEYS = ['id', 'conversationId', 'threadTitle', 'direction', 'team', 'from', 'to', 'subject', 'body', 'truncated',
  'createdAt', 'readByAgent', 'encrypted', 'verification', 'priority'];
const PARTY_KEYS = ['alias', 'address', 'identity'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const record = v => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const exact = (v, keys) => record(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
/** Text: the contract bounds a body (16 KiB), a page (200 messages) and the whole result (256 KiB, which the transport
 * bounds again), never a subject, a title, an alias or an id: those are any string, and only their display is cut. */
const text = (v, empty = false) => typeof v === 'string' && (empty || v.length > 0);
/** An opaque provider value (an id, a label, an alias): any non-empty string, never parsed. */
const opaque = v => text(v);
const iso = v => typeof v === 'string' && v.length <= 40 && ISO.test(v) && !Number.isNaN(Date.parse(v));
const utf8Bytes = s => {
  let n = 0;
  for (const ch of s) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
  return n;
};

function party(p) {
  return exact(p, PARTY_KEYS) && opaque(p.alias) && (p.address === null || opaque(p.address)) && opaque(p.identity);
}
/** The conversations of one identity that couldn't be read (contract v2's details, Juan's side's ask): present only with
 * the error `conversation-unreadable`, absent otherwise; opaque ids in the order the read met them. It may be empty (a
 * message with no conversation isn't named) and may list fewer than failed (its tail goes first under the 256 KiB bound). */
const UNREADABLE = 'unreadableConversations';
function identity(i) {
  const listed = record(i) && Object.hasOwn(i, UNREADABLE);
  if (listed && !(i.error === 'conversation-unreadable' && Array.isArray(i[UNREADABLE]) && i[UNREADABLE].every(opaque))) return false;
  return exact(i, listed ? [...IDENTITY_KEYS, UNREADABLE] : IDENTITY_KEYS) && opaque(i.team) && opaque(i.alias) && opaque(i.identity) && typeof i.primary === 'boolean'
    // An identity's error: the provider's word for it (oats.aweb: identity-missing, identity-unreadable, no-mail-read,
    // threads-unreadable, conversation-unreadable, too-many-threads), opaque: a client words the ones it knows.
    && (i.error === null || opaque(i.error));
}
function message(m) {
  return exact(m, MESSAGE_KEYS) && opaque(m.id) && (m.conversationId === null || opaque(m.conversationId)) && text(m.threadTitle, true)
    && DIRECTIONS.includes(m.direction) && opaque(m.team) && party(m.from) && party(m.to) && text(m.subject, true)
    && typeof m.body === 'string' && utf8Bytes(m.body) <= MAIL_BODY_BYTES && typeof m.truncated === 'boolean' && iso(m.createdAt)
    && typeof m.readByAgent === 'boolean' && typeof m.encrypted === 'boolean' && VERIFICATIONS.includes(m.verification)
    && PRIORITIES.includes(m.priority);
}

/** The `mail` field of a `messaging:mail` run, decoded; null when the answer is not the contract's. The run is the
 * `oats operation run --json` result (`{operationsApi: 2, operation, result, …}`).
 * Returns `{ observedAt, identities, messages, partial: Set<conversationId>, hasMore, nextCursor }`. */
export function mailAnswer(run) {
  if (!record(run) || run.operationsApi !== 2 || run.operation !== MAIL_OPERATION) return null;
  const r = run.result;
  if (!exact(r, ['documents', 'mail']) || !Array.isArray(r.documents)) return null;
  const d = r.mail;
  if (!exact(d, MAIL_KEYS) || d.mailApi !== 1 || d.acknowledges !== false || !iso(d.observedAt)) return null;
  if (!Array.isArray(d.identities) || !d.identities.every(identity)) return null;
  if (!Array.isArray(d.messages) || d.messages.length > MAIL_MAX_LIMIT || !d.messages.every(message)) return null;
  if (!Array.isArray(d.conversations) || !d.conversations.every(c => exact(c, ['id', 'partial']) && opaque(c.id) && (c.partial === null || c.partial === PARTIAL_OLDEST_FIRST))) return null;
  if (typeof d.hasMore !== 'boolean' || !(d.nextCursor === null || opaque(d.nextCursor))) return null;
  // More to read needs the cursor that reads it; a cursor with nothing more is the provider's slip, and dropped.
  if (d.hasMore && d.nextCursor === null) return null;
  const keys = d.messages.map(messageKey);
  if (new Set(keys).size !== keys.length) return null;
  return {
    observedAt: d.observedAt,
    identities: structuredClone(d.identities),
    messages: structuredClone(d.messages),
    partial: new Set(d.conversations.filter(c => c.partial === PARTIAL_OLDEST_FIRST).map(c => c.id)),
    hasMore: d.hasMore,
    nextCursor: d.hasMore ? d.nextCursor : null,
  };
}

/** A message's identity across pages: its team and its id (ids are the provider's, per identity). */
export const messageKey = m => JSON.stringify([m.team, m.id]);

/** Whether a cursor can travel as an operation argument (cli-adapter.mjs operationArgs: one line of at most 1024
 * characters). One that can't is no way to the next page from this client: the sheet offers none. */
export const cursorUsable = c => typeof c === 'string' && c.length > 0 && c.length <= 1024 && !/[\x00-\x1f\x7f]/.test(c);

/** The arguments of one read: the first page (no cursor) or the page after `cursor`. Only declared arguments. */
export function mailArgs({ cursor = null, limit = MAIL_PAGE } = {}) {
  const n = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAIL_MAX_LIMIT) : MAIL_PAGE;
  return { limit: String(n), ...(cursorUsable(cursor) ? { cursor } : {}) };
}

/** A body as display lines: line breaks kept (CRLF and lone CR as one), tabs as spaces, every other character a note
 * may not hold (control characters, bidi overrides and isolates, zero-width and tag characters) replaced with U+FFFD,
 * so the reader sees something was there. For display only: never evidence of who wrote it. Trailing blank lines go. */
export function mailBodyLines(body) {
  if (typeof body !== 'string') return [];
  const every = new RegExp(NOT_NOTE_TEXT.source, 'gu');
  const lines = body.replace(/\r\n?/g, '\n').split('\n').map(line => line.replace(/\t/g, '    ').replace(every, '\uFFFD'));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}

/** How much of one line of provider text is shown: the rest is cut, with an ellipsis. */
export const MAIL_LINE_SHOWN = 512;
/** One line of provider text (a subject, an alias, a title, an identity's error) as shown: line breaks as spaces, the
 * rest as mailBodyLines does, cut past MAIL_LINE_SHOWN characters (never inside a surrogate pair). */
export function mailLine(value) {
  const line = mailBodyLines(typeof value === 'string' ? value.replace(/[\r\n]+/g, ' ') : '').join(' ').trim();
  if (line.length <= MAIL_LINE_SHOWN) return line;
  const cut = /[\uD800-\uDBFF]/.test(line[MAIL_LINE_SHOWN - 1]) ? MAIL_LINE_SHOWN - 1 : MAIL_LINE_SHOWN;
  return `${line.slice(0, cut)}…`;
}
