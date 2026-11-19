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
const CODE = /^E_[A-Z0-9_]{1,64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const record = v => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const exact = (v, keys) => record(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const text = (v, max, empty = false) => typeof v === 'string' && v.length <= max && (empty || v.length > 0);
/** An opaque provider value (an id, a label, an alias): one line, bounded, never empty. */
const opaque = (v, max = 512) => text(v, max) && !NOT_NOTE_TEXT.test(v);
const iso = v => typeof v === 'string' && v.length <= 40 && ISO.test(v) && !Number.isNaN(Date.parse(v));
const utf8Bytes = s => {
  let n = 0;
  for (const ch of s) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
  return n;
};

function party(p) {
  return exact(p, PARTY_KEYS) && opaque(p.alias, 256) && (p.address === null || opaque(p.address, 512)) && opaque(p.identity);
}
function identity(i) {
  return exact(i, IDENTITY_KEYS) && opaque(i.team, 256) && opaque(i.alias, 256) && opaque(i.identity) && typeof i.primary === 'boolean'
    && (i.error === null || (typeof i.error === 'string' && CODE.test(i.error)));
}
function message(m) {
  return exact(m, MESSAGE_KEYS) && opaque(m.id) && (m.conversationId === null || opaque(m.conversationId)) && text(m.threadTitle, 1024, true)
    && DIRECTIONS.includes(m.direction) && opaque(m.team, 256) && party(m.from) && party(m.to) && text(m.subject, 1024, true)
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
  if (!Array.isArray(d.identities) || d.identities.length > 64 || !d.identities.every(identity)) return null;
  if (!Array.isArray(d.messages) || d.messages.length > MAIL_MAX_LIMIT || !d.messages.every(message)) return null;
  if (!Array.isArray(d.conversations) || d.conversations.length > MAIL_MAX_LIMIT * 4
    || !d.conversations.every(c => exact(c, ['id', 'partial']) && opaque(c.id) && (c.partial === null || c.partial === PARTIAL_OLDEST_FIRST))) return null;
  if (typeof d.hasMore !== 'boolean' || !(d.nextCursor === null || opaque(d.nextCursor, 4096))) return null;
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

/** The arguments of one read: the first page (no cursor) or the page after `cursor`. Only declared arguments. */
export function mailArgs({ cursor = null, limit = MAIL_PAGE } = {}) {
  const n = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAIL_MAX_LIMIT) : MAIL_PAGE;
  return { limit: String(n), ...(typeof cursor === 'string' && cursor ? { cursor } : {}) };
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

/** One line of provider text (a subject, an alias, a title): line breaks as spaces, the rest as mailBodyLines does. */
export function mailLine(value) {
  return mailBodyLines(typeof value === 'string' ? value.replace(/[\r\n]+/g, ' ') : '').join(' ').trim();
}
