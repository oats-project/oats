// messaging:mail (mailApi 1): a read-only view of an instance's own mail,
// received and sent, newest first, across every identity of the instance
// (the primary one and each joined team's). It NEVER acknowledges or marks
// anything read: the only aw commands it may run are the ones
// assertReadOnlyAwArgv admits (`version`, `whoami`, `mail threads`,
// `mail show`), each a server GET or a local read. Every other command is
// refused here before it runs: `mail inbox` acknowledges what it shows, and
// `mail ack`, `mail reply` and `mail send` acknowledge or write. (Contract v2
// listed `mail inbox --count-only` too; the read needs no count, so it is
// out, and the tests call it directly to compare unread counts.)
//
// The answer is the messaging layer's contract (docs in the OATS kernel's
// docs/desktop-cli-api.md, "Mail (mailApi 1)"): a view's `documents` plus one
// structured field, `mail`. Provider ids are opaque strings to clients.
//
// How a page is found. aw lists an identity's threads newest activity first
// (`mail threads`), and reads one conversation's OLDEST messages
// (`mail show --conversation-id --limit 500`). The read walks each identity's
// threads in activity order and merges their messages. A message is CERTAIN
// once it is newer than the latest activity of every thread not read yet:
// nothing unread can be newer. The page is the newest `limit` certain
// messages. It stops reading once it has `limit` of them, or at its read
// budget, when it answers only what is certain.

export const MAIL_API = 1;
/** The first aw with `mail threads` (aw 91ea73f, 2026-11-01). */
export const MAIL_AW_MIN = '1.36.53';
export const MAIL_LIMIT_DEFAULT = 50;
export const MAIL_LIMIT_MAX = 200;
/** Each body is cut at this many UTF-8 bytes, at a character boundary. */
export const MAIL_BODY_MAX_BYTES = 16 * 1024;
/** The whole `result` ({documents, mail}) as UTF-8 JSON. */
export const MAIL_RESULT_MAX_BYTES = 256 * 1024;
/** aw's ceiling for one conversation read: a full window may be partial. */
export const MAIL_SHOW_LIMIT = 500;
export const MAIL_THREADS_PAGE = 50;
/** Conversation reads one answer may spend, across every identity. */
export const MAIL_MAX_CONVERSATION_READS = 300;
export const MAIL_AW_CONCURRENCY = 6;
/** The read stops starting aw calls after this, well inside the kernel's
 *  240 s operation bound, and answers what it has. */
export const MAIL_READ_BUDGET_MS = 150 * 1000;
/** The excerpt of each body in the plain `documents` rendering; the full
 *  (bounded) body is in `mail.messages[].body`. */
export const MAIL_DOCUMENT_EXCERPT_CHARS = 500;

export const MAIL_VERIFICATION = Object.freeze(['verified', 'unverified', 'failed', 'unknown']);
export const MAIL_PRIORITY = Object.freeze(['normal', 'high', 'unknown']);
/** identities[].error codes. */
export const MAIL_IDENTITY_ERRORS = Object.freeze({
  missing: 'identity-missing',
  unreadable: 'identity-unreadable',
  noMailRead: 'no-mail-read',
  threads: 'threads-unreadable',
  conversation: 'conversation-unreadable',
  tooMany: 'too-many-threads',
});

const fail = (code, message, details) => Object.assign(new Error(message), { code, ...(details ? { details } : {}) });

// ---------------------------------------------------------------------------
// The argv this read may run. Anything else is refused BEFORE it runs.

const FLAG_VALUE = (value) => typeof value === 'string' && value.length > 0 && !value.startsWith('-');
const POSITIVE_INT = (value) => /^[1-9][0-9]{0,3}$/.test(String(value));
/** Throws E_MAIL_ARGV unless `args` (after an optional leading
 *  `--identity-home <dir>`) is one of the read-only commands. */
export function assertReadOnlyAwArgv(args) {
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) throw fail('E_MAIL_ARGV', 'aw argv must be an array of strings');
  let rest = args;
  if (rest[0] === '--identity-home') {
    if (!FLAG_VALUE(rest[1])) throw fail('E_MAIL_ARGV', '--identity-home needs a directory');
    rest = rest.slice(2);
  }
  const refuse = () => { throw fail('E_MAIL_ARGV', `messaging:mail never runs aw ${rest.join(' ')}: it may run only version, whoami, mail threads and mail show`); };
  const flags = (from, allowed) => {
    const seen = new Set();
    for (let i = from; i < rest.length; i++) {
      const flag = rest[i];
      if (!Object.hasOwn(allowed, flag) || seen.has(flag)) refuse();
      seen.add(flag);
      if (allowed[flag]) { if (!allowed[flag](rest[i + 1])) refuse(); i++; }
    }
    return seen;
  };
  const [a, b] = rest;
  if (a === 'version' && rest.length === 1) return;
  if (a === 'whoami') { flags(1, { '--json': null }); return; }
  if (a !== 'mail') refuse();
  if (b === 'threads') { flags(2, { '--limit': POSITIVE_INT, '--cursor': FLAG_VALUE, '--json': null }); return; }
  if (b === 'show') {
    const seen = flags(2, { '--conversation-id': FLAG_VALUE, '--message-id': FLAG_VALUE, '--limit': POSITIVE_INT, '--json': null });
    if (seen.has('--conversation-id') === seen.has('--message-id')) refuse();
    return;
  }
  refuse();
}

// ---------------------------------------------------------------------------
// Arguments and the cursor.

/** `--limit`, `--cursor`, `--conversation` as the kernel passes them
 *  (`--flag value`), plus `--json` and `--home`. */
export function parseMailArgs(argv) {
  const out = { limit: MAIL_LIMIT_DEFAULT, cursor: null, conversation: null, json: false, home: undefined };
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (typeof v !== 'string' || v === '' || v.startsWith('--')) throw fail('E_BAD_ARGS', `${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const [flag, inline] = arg.startsWith('--') && eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    const take = () => (inline !== undefined ? inline : value(i++, flag));
    if (flag === '--json' && inline === undefined) out.json = true;
    else if (flag === '--limit') out.limit = take();
    else if (flag === '--cursor') out.cursor = take();
    else if (flag === '--conversation') out.conversation = take();
    else if (flag === '--home') out.home = take();
    else throw fail('E_BAD_ARGS', `oats aweb mail takes --limit, --cursor, --conversation, --home and --json, not ${arg}`);
  }
  if (typeof out.limit === 'string') {
    if (!/^[0-9]+$/.test(out.limit) || Number(out.limit) < 1 || Number(out.limit) > MAIL_LIMIT_MAX) throw fail('E_BAD_ARGS', `limit must be a whole number from 1 to ${MAIL_LIMIT_MAX}`);
    out.limit = Number(out.limit);
  }
  if (out.conversation !== null && (out.conversation.length > 200 || /[\s\u0000-\u001f]/.test(out.conversation) || out.conversation.startsWith('-'))) throw fail('E_BAD_ARGS', 'conversation must be one conversation id');
  if (out.cursor !== null) out.cursor = decodeCursor(out.cursor, out.conversation);
  return out;
}

const CURSOR_VERSION = 1;
export function encodeCursor(message, conversation) {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, at: message.createdAt, id: message.id, team: message.team, ...(conversation ? { c: conversation } : {}) })).toString('base64url');
}
export function decodeCursor(text, conversation = null) {
  let doc;
  try {
    if (!/^[A-Za-z0-9_-]{1,2000}$/.test(text)) throw new Error('shape');
    doc = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch { throw fail('E_BAD_ARGS', 'cursor is not a nextCursor from a previous answer'); }
  const key = (v) => typeof v === 'string' && v.length > 0 && v.length <= 500;
  if (!doc || doc.v !== CURSOR_VERSION || !key(doc.at) || !Number.isFinite(Date.parse(doc.at)) || !key(doc.id) || !key(doc.team)) throw fail('E_BAD_ARGS', 'cursor is not a nextCursor from a previous answer');
  if ((doc.c ?? null) !== (conversation ?? null)) throw fail('E_BAD_ARGS', 'cursor belongs to another read: pass the same conversation (or none) as the answer that gave it');
  return { createdAt: doc.at, id: doc.id, team: doc.team, ms: timeOf(doc.at), sub: subMsOf(doc.at) };
}

// ---------------------------------------------------------------------------
// Order: newest first by createdAt, then by id, then by team, all descending.

function timeOf(iso) { const t = Date.parse(iso); return Number.isFinite(t) ? t : -Infinity; }
/** The fraction of a second below the millisecond that Date.parse drops, in
 *  nanoseconds (aweb gives microseconds): `.000100` and `.000900` differ. */
function subMsOf(iso) { const m = /T[^.]*\.(\d+)/.exec(String(iso)); return m ? Number(`${m[1].slice(3)}000000`.slice(0, 6)) : 0; }
/** > 0 when a is newer (comes first), < 0 when older. */
function compareKeys(a, b) {
  if (a.ms !== b.ms) return a.ms > b.ms ? 1 : -1;
  if (a.sub !== b.sub) return a.sub > b.sub ? 1 : -1;
  if (a.id !== b.id) return a.id > b.id ? 1 : -1;
  if (a.team !== b.team) return a.team > b.team ? 1 : -1;
  return 0;
}
const newestFirst = (a, b) => compareKeys(b, a);

// ---------------------------------------------------------------------------
// One aw message as a contract message.

const str = (v) => (typeof v === 'string' ? v : '');
const strOrNull = (v) => (typeof v === 'string' && v.trim() ? v : null);

/** `text` cut to at most `max` UTF-8 bytes, never inside a character. */
export function truncateUtf8(text, max = MAIL_BODY_MAX_BYTES) {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= max) return { text, truncated: false };
  let used = 0, end = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (used + size > max) break;
    used += size; end += ch.length;
  }
  return { text: text.slice(0, end), truncated: true };
}

/** aw's verification_status in the contract's set. */
export function mailVerification(status) {
  if (['verified', 'verified_legacy', 'verified_custodial'].includes(status)) return 'verified';
  if (status === 'unverified') return 'unverified';
  if (['failed', 'identity_mismatch'].includes(status)) return 'failed';
  return 'unknown';
}
/** aw's priority (low|normal|high|urgent) in the contract's set. */
export function mailPriority(priority) {
  if (priority === 'normal' || priority === 'low') return 'normal';
  if (priority === 'high' || priority === 'urgent') return 'high';
  return 'unknown';
}

const identityOf = (stableId, did) => strOrNull(stableId) || str(did);
function authoredBySelf(self, m) {
  return (!!self.did && str(m.from_did) === self.did) || (!!self.stableId && str(m.from_stable_id) === self.stableId);
}

function messageRecord(m, state, threadTitle) {
  const self = state.self;
  const sent = authoredBySelf(self, m);
  const body = truncateUtf8(str(m.body));
  const createdAt = str(m.created_at);
  const peer = (side) => ({
    alias: str(m[`${side}_alias`]),
    address: strOrNull(m[`${side}_address`]),
    identity: identityOf(m[`${side}_stable_id`], m[`${side}_did`]),
  });
  const from = peer('from'), to = peer('to');
  // The side that is this identity names it, when aw leaves it out.
  const mine = sent ? from : to;
  if (!mine.alias) mine.alias = self.alias;
  if (!mine.address) mine.address = self.address;
  if (!mine.identity) mine.identity = self.identity;
  return {
    id: str(m.message_id),
    conversationId: strOrNull(m.conversation_id),
    threadTitle: threadTitle || str(m.subject),
    direction: sent ? 'sent' : 'received',
    team: state.row.team,
    from, to,
    subject: str(m.subject),
    body: body.text,
    truncated: body.truncated,
    createdAt,
    // read_at is the recipient's read state. The agent wrote what it sent.
    readByAgent: sent ? true : (typeof m.read_at === 'string' && m.read_at !== ''),
    encrypted: m.content_mode === 'encrypted_v2' || m.message_version === 2 || (m.encrypted_envelope !== undefined && m.encrypted_envelope !== null),
    verification: mailVerification(m.verification_status),
    priority: mailPriority(m.priority),
    // Order key; dropped from the answer.
    ms: timeOf(createdAt),
    sub: subMsOf(createdAt),
  };
}

// ---------------------------------------------------------------------------
// The read.

const parseJson = (text) => {
  const trimmed = String(text ?? '').trim();
  try { return JSON.parse(trimmed); } catch { /* progress lines may come first */ }
  const lines = trimmed.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trimStart().startsWith('{')) continue;
    try { return JSON.parse(lines.slice(i).join('\n')); } catch { /* not the whole remainder */ }
  }
  return undefined;
};
const notFound = (r) => /not found/i.test(`${r.stderr ?? ''}\n${r.stdout ?? ''}`);
const forbidden = (r) => /\b403\b|forbidden|mail\.read|scope/i.test(`${r.stderr ?? ''}\n${r.stdout ?? ''}`);

/** A small pool: runs `tasks` (functions returning promises), at most `n` at once. */
async function pool(tasks, n) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => { while (next < tasks.length) { const i = next++; results[i] = await tasks[i](); } };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
  return results;
}

/**
 * Read this instance's mail.
 *
 * - `identities`: [{team, identityHome, primary}], the primary first. `team`
 *   is the team's label, shown as given.
 * - `aw(identityHome, args)`: runs `aw --identity-home <identityHome> ...args`
 *   and resolves {status, stdout, stderr}. Every args is checked by
 *   assertReadOnlyAwArgv first.
 * - `exists(path)`: whether an identity home is there.
 *
 * Resolves the view's `result` ({documents, mail}). Throws E_MAIL_UNREADABLE
 * when no identity could be read.
 */
export async function readMail({
  identities, limit = MAIL_LIMIT_DEFAULT, cursor = null, conversation = null, aw, exists = () => true,
  now = () => new Date(), clock = () => Date.now(),
  maxReads = MAIL_MAX_CONVERSATION_READS, budgetMs = MAIL_READ_BUDGET_MS, concurrency = MAIL_AW_CONCURRENCY,
  resultMaxBytes = MAIL_RESULT_MAX_BYTES,
}) {
  const started = clock();
  const outOfTime = () => clock() - started > budgetMs;
  const run = (state, args) => {
    const argv = ['--identity-home', state.row.identityHome, ...args];
    assertReadOnlyAwArgv(argv);
    return aw(state.row.identityHome, args);
  };
  // `listedUntil`: the activity of the last thread listed so far. Threads come
  // newest activity first, so a page not yet listed holds nothing newer.
  const states = identities.map((row) => ({ row, self: null, error: null, readable: false, queue: [], threadsCursor: null, threadsDone: false, listedUntil: Infinity, unreadable: [] }));
  const setError = (state, code) => { if (!state.error) state.error = code; };
  const conversations = new Map();
  const collected = [];
  const keep = (record) => { if (!cursor || compareKeys(record, cursor) < 0) collected.push(record); };

  // Who each identity is. Run together: one aw call each.
  await Promise.all(states.map(async (state) => {
    if (!state.row.identityHome || !exists(state.row.identityHome)) { setError(state, MAIL_IDENTITY_ERRORS.missing); return; }
    const r = await run(state, ['whoami', '--json']);
    const who = r.status === 0 ? parseJson(r.stdout) : undefined;
    if (!who || typeof who !== 'object' || (!str(who.did) && !str(who.stable_id))) { setError(state, MAIL_IDENTITY_ERRORS.unreadable); return; }
    state.self = { did: str(who.did), stableId: str(who.stable_id), alias: str(who.alias), address: strOrNull(who.address), identity: identityOf(who.stable_id, who.did) };
    if (Array.isArray(who.grant_scopes) && !who.grant_scopes.includes('mail.read')) setError(state, MAIL_IDENTITY_ERRORS.noMailRead);
  }));
  const live = () => states.filter((s) => s.self && s.error !== MAIL_IDENTITY_ERRORS.noMailRead);

  /** One conversation read into `collected`. A legacy thread has a message id only. */
  const readThread = async (state, thread) => {
    const conversationId = str(thread.conversation_id);
    const legacyId = str(thread.legacy_message_id);
    const args = conversationId
      ? ['mail', 'show', '--conversation-id', conversationId, '--limit', String(MAIL_SHOW_LIMIT), '--json']
      : ['mail', 'show', '--message-id', legacyId, '--json'];
    const r = await run(state, args);
    const doc = r.status === 0 ? parseJson(r.stdout) : undefined;
    if (!doc || !Array.isArray(doc.messages)) {
      if (conversation && notFound(r)) return;
      // One conversation's failure, a refusal included, is that conversation's:
      // the identity's other conversations are still read.
      setError(state, MAIL_IDENTITY_ERRORS.conversation);
      if (conversationId && !state.unreadable.includes(conversationId)) state.unreadable.push(conversationId);
      return;
    }
    state.readable = true;
    const title = str(thread.title) || str(thread.subject);
    for (const m of doc.messages) if (m && typeof m === 'object' && str(m.message_id)) keep(messageRecord(m, state, title));
    if (conversationId) {
      const key = `${state.row.team}\u0000${conversationId}`;
      const partial = doc.messages.length >= MAIL_SHOW_LIMIT ? 'oldest-first-only' : null;
      if (!conversations.has(key) || partial) conversations.set(key, { id: conversationId, partial });
    }
  };

  let capped = false;
  let frontier = -Infinity;
  if (conversation) {
    await pool(live().map((state) => () => readThread(state, { conversation_id: conversation })), concurrency);
  } else {
    /** Loads the identity's next page of threads when its queue is empty. */
    const fill = async (state) => {
      if (state.queue.length || state.threadsDone || state.error === MAIL_IDENTITY_ERRORS.threads) return;
      const r = await run(state, ['mail', 'threads', '--limit', String(MAIL_THREADS_PAGE), ...(state.threadsCursor ? ['--cursor', state.threadsCursor] : []), '--json']);
      const doc = r.status === 0 ? parseJson(r.stdout) : undefined;
      if (!doc || !Array.isArray(doc.conversations)) {
        setError(state, forbidden(r) ? MAIL_IDENTITY_ERRORS.noMailRead : MAIL_IDENTITY_ERRORS.threads);
        state.threadsDone = true;
        return;
      }
      state.readable = true;
      state.queue.push(...doc.conversations.filter((t) => t && typeof t === 'object' && (str(t.conversation_id) || str(t.legacy_message_id)) && (!t.conversation_type || t.conversation_type === 'mail')));
      const listed = doc.conversations.filter((t) => t && typeof t === 'object').map(activity);
      if (listed.length) state.listedUntil = Math.min(state.listedUntil, ...listed);
      state.threadsCursor = str(doc.next_cursor) || null;
      if (!state.threadsCursor || !doc.conversations.length) state.threadsDone = true;
    };
    const activity = (thread) => { const t = Date.parse(str(thread.last_message_at)); return Number.isFinite(t) ? t : Infinity; };
    /** The newest activity this identity may still hold unread: its next
     *  queued thread, else (a page not listed yet) the last listed activity,
     *  else nothing. */
    const head = (state) => (state.queue.length ? activity(state.queue[0]) : !state.threadsDone ? state.listedUntil : -Infinity);
    let reads = 0;
    for (;;) {
      if (outOfTime()) { capped = true; }
      else await Promise.all(live().map(fill));
      const heads = live().filter((s) => head(s) > -Infinity);
      frontier = heads.length ? Math.max(...heads.map(head)) : -Infinity;
      if (!heads.length || capped) break;
      const certain = collected.filter((m) => m.ms > frontier).length;
      if (certain >= limit) break;
      if (reads >= maxReads) { capped = true; break; }
      // The next threads in activity order, across identities, one batch.
      const batch = [];
      while (batch.length < concurrency && reads + batch.length < maxReads) {
        const next = heads.filter((s) => s.queue.length).sort((a, b) => head(b) - head(a))[0];
        if (!next) break;
        batch.push([next, next.queue.shift()]);
      }
      reads += batch.length;
      await pool(batch.map(([state, thread]) => () => readThread(state, thread)), concurrency);
    }
  }

  const readable = states.filter((s) => s.readable || (s.self && !s.error));
  if (!readable.length) {
    throw fail('E_MAIL_UNREADABLE', `no identity of this instance could be read (${states.map((s) => `${s.row.team}: ${s.error || 'unread'}`).join('; ') || 'it has none'})`, { identities: identityRows(states) });
  }

  collected.sort(newestFirst);
  const certain = collected.filter((m) => m.ms > frontier);
  let page = certain.slice(0, limit);
  let hasMore = certain.length > limit || frontier !== -Infinity;
  if (capped && !page.length) {
    // Nothing could be proven newest within the budget: say so, per identity.
    for (const s of live()) if (s.queue.length || !s.threadsDone) setError(s, MAIL_IDENTITY_ERRORS.tooMany);
    hasMore = false;
  }
  const observedAt = now().toISOString();
  return boundedResult({ page, hasMore, states, conversations, observedAt, conversation, resultMaxBytes });
}

/** identities[]: one row per identity. With conversation-unreadable, the row
 *  names those conversations (`unreadableConversations`), the first `idsCap`
 *  of them when the bound needs a shorter list. */
function identityRows(states, idsCap = Infinity) {
  return states.map((s) => ({ team: s.row.team, alias: s.self?.alias ?? '', identity: s.self?.identity ?? '', primary: !!s.row.primary, error: s.error,
    ...(s.error === MAIL_IDENTITY_ERRORS.conversation ? { unreadableConversations: s.unreadable.slice(0, idsCap) } : {}) }));
}

const publicMessage = ({ ms: _ms, sub: _sub, ...m }) => m;

/** The answer, cut to `resultMaxBytes`: messages are dropped from the oldest
 *  end until it fits, and then `hasMore` is true with a cursor. */
function boundedResult({ page, hasMore, states, conversations, observedAt, conversation, resultMaxBytes }) {
  let idsCap = Infinity;
  const build = (messages, more) => {
    const used = new Set(messages.map((m) => `${m.team}\u0000${m.conversationId}`));
    const mail = {
      mailApi: MAIL_API, acknowledges: false, observedAt,
      identities: identityRows(states, idsCap),
      messages: messages.map(publicMessage),
      // A partial conversation is listed even when none of its (old) messages
      // made this page: a client must still say its newest can't be read.
      conversations: [...conversations].filter(([key, c]) => used.has(key) || c.partial).map(([, c]) => c),
      hasMore: more,
      nextCursor: more && messages.length ? encodeCursor(messages.at(-1), conversation) : null,
    };
    return { documents: [{ label: 'Mail', kind: 'markdown', text: renderMail(mail) }], mail };
  };
  const size = (result) => Buffer.byteLength(JSON.stringify(result), 'utf8');
  const fits = (result) => size(result) <= resultMaxBytes;
  const tooLarge = () => fail('E_MAIL_TOO_LARGE', `this instance's mail answer can't fit the ${resultMaxBytes / 1024} KiB bound, even with no messages (${states.length} identities)`, { identities: states.length, bound: resultMaxBytes });
  // Without any message, the answer is its identities and partial conversations:
  // if those alone don't fit, no page can.
  let result = build(page, hasMore);
  if (fits(result)) return result;
  // The unreadable-conversation lists give way first, before any message:
  // their tails go, to the longest lists with which the whole page fits.
  const longest = Math.max(0, ...states.map((st) => st.unreadable.length));
  if (longest) {
    let low = 0, high = longest;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      idsCap = mid;
      if (fits(build(page, hasMore))) low = mid; else high = mid - 1;
    }
    idsCap = low;
    result = build(page, hasMore);
    if (fits(result)) return result;
  }
  // Without any list, the answer is its identity rows and partial
  // conversations: if those alone don't fit, no page can.
  if (!fits(build([], hasMore))) throw tooLarge();
  // Too big: find the most messages that fit, by bisection.
  let lo = 0, hi = page.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(build(page.slice(0, mid), true))) lo = mid; else hi = mid - 1;
  }
  if (lo === 0) {
    // The newest message alone doesn't fit (only bodies are cut at 16 KiB):
    // cut its subject and thread title, as a body is cut, to the most that
    // fits, so a page never comes back empty with more to read.
    const [first] = page;
    // More only if there is: older messages on this page, or past it.
    const more = hasMore || page.length > 1;
    const cut = (bytes) => {
      const subject = truncateUtf8(first.subject, bytes), title = truncateUtf8(first.threadTitle, bytes);
      return { ...first, subject: subject.text, threadTitle: title.text, truncated: first.truncated || subject.truncated || title.truncated };
    };
    let low = 0, high = Math.max(Buffer.byteLength(first.subject), Buffer.byteLength(first.threadTitle));
    if (!fits(build([cut(0)], more))) throw tooLarge();
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(build([cut(mid)], more))) low = mid; else high = mid - 1;
    }
    result = build([cut(low)], more);
  } else result = build(page.slice(0, lo), true);
  if (!fits(result) || (result.mail.hasMore && !result.mail.nextCursor)) throw tooLarge();
  return result;
}

// ---------------------------------------------------------------------------
// The plain rendering, for a generic view reader and the CLI. Sender text is
// untrusted: it is escaped, so it cannot add markdown structure, and quoted.

const MD_SPECIAL = /[\\`*_{}[\]()#+\-.!|<>~]/g;
export const escapeMarkdown = (text) => String(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(MD_SPECIAL, (c) => `\\${c}`);

export function renderMail(mail) {
  const lines = ['# Mail', '', `Read ${mail.observedAt}; never acknowledges. ${mail.messages.length} message${mail.messages.length === 1 ? '' : 's'}, newest first.`];
  for (const id of mail.identities) {
    lines.push(`- ${escapeMarkdown(id.team)}: ${escapeMarkdown(id.alias || 'unknown alias')}${id.primary ? ' (primary)' : ''}${id.error ? `: ${id.error}` : ''}`);
  }
  for (const c of mail.conversations) if (c.partial) lines.push(`- Conversation ${escapeMarkdown(c.id)}: older part of a long conversation shown; the newest messages can't be read yet.`);
  for (const m of mail.messages) {
    const who = m.direction === 'sent' ? `to ${m.to.alias || m.to.address || m.to.identity}` : `from ${m.from.alias || m.from.address || m.from.identity}`;
    const marks = [m.encrypted ? 'encrypted' : '', m.verification !== 'verified' ? m.verification : '', m.priority === 'high' ? 'high priority' : '', m.direction === 'received' && !m.readByAgent ? 'unread' : '', m.truncated ? 'body truncated' : ''].filter(Boolean);
    lines.push('', `## ${escapeMarkdown(m.subject || m.threadTitle || '(no subject)')}`, '', `${m.direction} ${escapeMarkdown(who)} in ${escapeMarkdown(m.team)}, ${m.createdAt}${marks.length ? ` (${marks.join(', ')})` : ''}`, '');
    const excerpt = [...m.body].length > MAIL_DOCUMENT_EXCERPT_CHARS ? `${[...m.body].slice(0, MAIL_DOCUMENT_EXCERPT_CHARS).join('')}…` : m.body;
    for (const line of (excerpt || '(empty)').split(/\r?\n/)) lines.push(`> ${escapeMarkdown(line)}`);
  }
  if (mail.hasMore) lines.push('', mail.nextCursor ? 'More: pass this answer\'s nextCursor as the cursor.' : 'More mail exists than this read could order.');
  return lines.join('\n');
}
