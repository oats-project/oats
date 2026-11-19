/** The agent's board (feature instance-board, `boardApi: 1`): the facts an agent keeps in view for its
 *  person (`oats instance board set|unset`) and the questions it asks them (`oats instance board ask`, closed
 *  with `ask --clear`). Agent-reported, display only: the kernel routes no answer and acts on nothing here.
 *  The contract is docs/desktop-cli-api.md "The agent's board".
 *
 *  ONE HOME FILE, `<home>/.oats-board.json`, kernel-owned (KERNEL_HOME_NAME_PREFIXES, the retire receipts,
 *  the manifest schema), written atomically at mode 0600 under a short lock (`.oats-board.lock`), so that
 *  parallel writes of one agent never lose one. The file:
 *    { boardApi: 1, asked: <n>, facts: { <key>: { label, value, unit, link, at, seq, history: [{ value, at }] } },
 *      questions: [{ id, question, options, context, since }] }
 *  `asked` numbers the default ids (`q<n>`), never reused while the home lives; `seq` keeps the facts in the
 *  order first set (a key such as "1" would otherwise lead a JSON object). A reader takes a regular file
 *  only, without following a link, up to FILE_MAX bytes; a file that is not a valid board in every part
 *  reads as an empty board, never an error; no file reads as null.
 *
 *  FACTS persist across sessions until unset or the home is retired. QUESTIONS are per session: one asked
 *  before the incarnation's latest kernel session boundary (`launched`, `restarted`, `stopped`; the waiting
 *  claim's rule, lib/instance-events.mjs) is not live: it is not shown, and a write drops it.
 *
 *  THE CLAIM. While a question is live, the home holds the waiting claim of producer `oats.board`, reason
 *  `attention` (it holds no scheduled wake), message the oldest live question. Every write sets the claim
 *  to what the board's questions say after it, so the write that fails to record it is repaired by the next.
 *
 *  THE ROW BOUND. The row value (`boardRow`: facts without history, questions without context) is at most
 *  ROW_MAX bytes as UTF-8 JSON: a write that would pass it is refused (E_BOARD_FULL), and a file whose row
 *  passes it is not a valid board. Every client can rely on the bound per row. Dependency-free. */
import { lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readFileHead } from "./bounded-read.mjs";
import { withDirLock } from "./dir-lock.mjs";
import { REFUSED_TEXT } from "./refused-text.mjs";
import { liveSession, setWaiting } from "./instance-events.mjs";
import { BOARD_API } from "./kernel-features.mjs";
import { writeThroughPrivateFile } from "./write-through-private-file.mjs";

/** The record's version, the command answer's and the probe's (defined beside the features, which the
 *  probe reads without loading this module). */
export { BOARD_API };
/** The home file and its lock, kernel-owned. */
export const BOARD_FILE = ".oats-board.json";
export const BOARD_LOCK = ".oats-board.lock";
/** The producer of the board's waiting claim. */
export const BOARD_PRODUCER = "oats.board";
/** The bounds (code points, except ROW_MAX and FILE_MAX in bytes, LINK_MAX in ASCII characters). */
export const BOARD_LIMITS = Object.freeze({ facts: 12, questions: 9, options: { min: 2, max: 4 }, history: 20, key: 16, label: 40, value: 80, unit: 16, option: 60, question: 200, context: 2000, link: 512 });
export const ROW_MAX = 8192;
/** A file larger than this is not a board: 12 facts with 20 values each, and 9 contexts, fit well inside it. */
const FILE_MAX = 256 * 1024;
/** How long a write waits for another write of the same board. */
const LOCK_WAIT_MS = 5000;
/** A fact's key and a question's id. */
export const BOARD_KEY_RE = /^[a-z0-9][a-z0-9-]{0,15}$/;

const boardError = (code, message, details) => Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
const points = (s) => [...s].length;
const validTime = (at) => typeof at === "string" && Number.isFinite(Date.parse(at));
/** One line of 1 to `max` code points, with none of the kernel's refused characters (REFUSED_TEXT). */
const lineOk = (s, max) => typeof s === "string" && s.length > 0 && points(s) <= max && !REFUSED_TEXT.test(s);
/** A context: 1 to BOARD_LIMITS.context code points; newlines (LF) allowed, every other refused character not. */
const contextOk = (s) => typeof s === "string" && s.length > 0 && points(s) <= BOARD_LIMITS.context && s.split("\n").every((l) => !REFUSED_TEXT.test(l));
/** An absolute `https:` URL of at most BOARD_LIMITS.link printable ASCII characters, with a host. */
export function linkOk(s) {
  if (typeof s !== "string" || s.length > BOARD_LIMITS.link || !/^https:\/\/[\x21-\x7e]+$/.test(s)) return false;
  try { const u = new URL(s); return u.protocol === "https:" && u.hostname.length > 0; } catch { return false; }
}
const TEXT_RULE = "one line with no control character, line separator, bidi control (U+202A-202E, U+2066-2069), U+200B, U+2060, U+FEFF or tag character";

// ---------- reading ----------

/** A stored fact, or null when any part of it is not one. */
function readFact(key, f) {
  if (typeof key !== "string" || !BOARD_KEY_RE.test(key) || !f || typeof f !== "object" || Array.isArray(f)) return null;
  const { label, value, unit = null, link = null, at, seq, history } = f;
  if (!lineOk(label, BOARD_LIMITS.label) || !lineOk(value, BOARD_LIMITS.value) || !validTime(at) || !Number.isSafeInteger(seq) || seq < 0) return null;
  if (unit !== null && !lineOk(unit, BOARD_LIMITS.unit)) return null;
  if (link !== null && !linkOk(link)) return null;
  if (!Array.isArray(history) || history.length < 1 || history.length > BOARD_LIMITS.history) return null;
  if (!history.every((h) => h && typeof h === "object" && lineOk(h.value, BOARD_LIMITS.value) && validTime(h.at))) return null;
  return { key, label, value, unit, link, at, seq, history: history.map((h) => ({ value: h.value, at: h.at })) };
}
/** A stored question, or null when any part of it is not one. */
function readQuestion(q) {
  if (!q || typeof q !== "object" || Array.isArray(q)) return null;
  const { id, question, options, context = null, since } = q;
  if (typeof id !== "string" || !BOARD_KEY_RE.test(id) || !lineOk(question, BOARD_LIMITS.question) || !validTime(since)) return null;
  if (!Array.isArray(options) || options.length < BOARD_LIMITS.options.min || options.length > BOARD_LIMITS.options.max || !options.every((o) => lineOk(o, BOARD_LIMITS.option))) return null;
  if (context !== null && !contextOk(context)) return null;
  return { id, question, options: [...options], context, since };
}
const EMPTY = () => ({ asked: 0, facts: [], questions: [] });
/** The board document of `home`: `{ asked, facts: [...] in first-set order, questions: [...] in the order
 *  asked }`, every question kept (live or not); null for no file; EMPTY for anything that is not a valid
 *  board in every part (not a regular file, a link, over FILE_MAX, not JSON, another boardApi, a fact or a
 *  question out of its rules, too many, a repeated id, a row over ROW_MAX). Never throws. */
export function readBoardDocument(home) {
  let bytes, size;
  try { ({ bytes, size } = readFileHead(join(home, BOARD_FILE), FILE_MAX + 1)); }
  catch (e) { return e?.code === "ENOENT" ? null : EMPTY(); }
  if (size > FILE_MAX) return EMPTY();
  let doc;
  try { doc = JSON.parse(bytes.toString("utf8")); } catch { return EMPTY(); }
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || doc.boardApi !== BOARD_API) return EMPTY();
  const { asked = 0, facts = {}, questions = [] } = doc;
  if (!Number.isSafeInteger(asked) || asked < 0 || !facts || typeof facts !== "object" || Array.isArray(facts) || !Array.isArray(questions)) return EMPTY();
  const keys = Object.keys(facts);
  if (keys.length > BOARD_LIMITS.facts || questions.length > BOARD_LIMITS.questions) return EMPTY();
  const read = keys.map((k) => readFact(k, facts[k]));
  const asks = questions.map(readQuestion);
  if (read.includes(null) || asks.includes(null) || new Set(asks.map((q) => q.id)).size !== asks.length) return EMPTY();
  const out = { asked, facts: read.sort((x, y) => x.seq - y.seq), questions: asks };
  return rowBytes(out) > ROW_MAX ? EMPTY() : out;
}

/** Whether a question asked at `since` belongs to the session that started at `boundaryAt` (null: no
 *  boundary is known, and every question is live). A question of the same millisecond as the boundary is
 *  before it: a stop recorded then ends it. */
const liveAt = (boundaryAt) => (q) => boundaryAt === null || Date.parse(q.since) > Date.parse(boundaryAt);

/** The row value of a document (its questions already the live ones): what `oats status --json` and
 *  `oats server roster --json` rows carry as `board`. */
export function boardRow(doc) {
  return {
    facts: doc.facts.map((f) => ({ key: f.key, label: f.label, value: f.value, unit: f.unit, link: f.link, at: f.at })),
    questions: doc.questions.map((q) => ({ id: q.id, question: q.question, options: [...q.options], hasContext: q.context !== null, since: q.since })),
  };
}
/** The inspect value (`oats inspect --home <h> --board`): the row's, with each fact's history and each
 *  question's context. */
export function boardDetail(doc) {
  const row = boardRow(doc);
  return {
    facts: row.facts.map((f, i) => ({ ...f, history: doc.facts[i].history.map((h) => ({ ...h })) })),
    questions: row.questions.map((q, i) => ({ ...q, context: doc.questions[i].context })),
  };
}
const rowBytes = (doc) => Buffer.byteLength(JSON.stringify(boardRow(doc)), "utf8");

/** The live board of a stored document (`stored`: readBoardDocument's): its questions only the ones of the
 *  current session, or none when the home's incarnation is unknown (no readable instance.json admits no
 *  question, as it admits no claim). `session`: the home's liveSession when the caller has read it (the
 *  status rows), else it is read here, only when the file holds a question. null stays null. */
function liveOf(home, stored, { session, meta } = {}) {
  if (stored === null || !stored.questions.length) return stored;
  const s = session ?? liveSession(home, meta !== undefined ? { meta } : {});
  if (s.incarnation === null) return { ...stored, questions: [] };
  return { ...stored, questions: stored.questions.filter(liveAt(s.boundaryAt)) };
}
const liveDocument = (home, options) => liveOf(home, readBoardDocument(home), options);

/** `board` on a status row: null for a home with no board file, else the row value of its live board.
 *  Never throws: a board that cannot be read is an empty one. */
export function readBoardRow(home, options) {
  try { const doc = liveDocument(home, options); return doc === null ? null : boardRow(doc); }
  catch { return { facts: [], questions: [] }; }
}
/** `instance.board` on `oats inspect --home <h> --board`: as readBoardRow, with history and context. */
export function readBoardDetail(home) {
  try { const doc = liveDocument(home); return doc === null ? null : boardDetail(doc); }
  catch { return { facts: [], questions: [] }; }
}

/** The READ rule for a `board` another kernel reports (a remote roster row): the row value exactly as this
 *  kernel would write it, every fact and question within its rules and the whole within ROW_MAX, or an
 *  empty board. null stays null. */
export function readRemoteBoard(board) {
  if (board === null) return null;
  const empty = { facts: [], questions: [] };
  if (!board || typeof board !== "object" || Array.isArray(board) || !Array.isArray(board.facts) || !Array.isArray(board.questions)) return empty;
  if (board.facts.length > BOARD_LIMITS.facts || board.questions.length > BOARD_LIMITS.questions) return empty;
  const facts = board.facts.map((f, i) => (f && typeof f === "object" ? readFact(f.key, { ...f, seq: i, history: [{ value: f.value, at: f.at }] }) : null));
  const questions = board.questions.map((q) => (q && typeof q === "object" && typeof q.hasContext === "boolean" ? readQuestion({ ...q, context: q.hasContext ? "x" : null }) : null));
  if (facts.includes(null) || questions.includes(null) || new Set(facts.map((f) => f.key)).size !== facts.length || new Set(questions.map((q) => q.id)).size !== questions.length) return empty;
  const doc = { asked: 0, facts, questions };
  return rowBytes(doc) > ROW_MAX ? empty : boardRow(doc);
}

// ---------- writing ----------

/** The checks of one fact's fields, as the CLI gives them → the fields, or E_BAD_ARGS naming the first. */
function checkFact({ key, label, value, unit, link }) {
  if (typeof key !== "string" || !BOARD_KEY_RE.test(key)) throw boardError("E_BAD_ARGS", `the key must match ${BOARD_KEY_RE.source} (a lowercase letter or digit, then up to 15 lowercase letters, digits or hyphens)`);
  if (label === undefined) throw boardError("E_BAD_ARGS", "--label is required");
  if (value === undefined) throw boardError("E_BAD_ARGS", "--value is required");
  for (const [name, v, max] of [["label", label, BOARD_LIMITS.label], ["value", value, BOARD_LIMITS.value], ["unit", unit, BOARD_LIMITS.unit]]) {
    if (v !== undefined && !lineOk(v, max)) throw boardError("E_BAD_ARGS", `--${name} must be ${TEXT_RULE}, of 1 to ${max} characters`);
  }
  if (link !== undefined && !linkOk(link)) throw boardError("E_BAD_ARGS", `--link must be an absolute https: URL of at most ${BOARD_LIMITS.link} printable ASCII characters`);
  return { key, label, value, unit: unit ?? null, link: link ?? null };
}
/** The checks of one question → its fields, or E_BAD_ARGS naming the first. */
function checkQuestion({ question, options, id, context }) {
  if (question === undefined) throw boardError("E_BAD_ARGS", "the question is required: oats instance board ask <question> --option <text> --option <text>");
  if (!lineOk(question, BOARD_LIMITS.question)) throw boardError("E_BAD_ARGS", `the question must be ${TEXT_RULE}, of 1 to ${BOARD_LIMITS.question} characters`);
  if (!Array.isArray(options) || options.length < BOARD_LIMITS.options.min || options.length > BOARD_LIMITS.options.max) throw boardError("E_BAD_ARGS", `a question takes ${BOARD_LIMITS.options.min} to ${BOARD_LIMITS.options.max} --option (got ${Array.isArray(options) ? options.length : 0})`);
  for (const o of options) if (!lineOk(o, BOARD_LIMITS.option)) throw boardError("E_BAD_ARGS", `each --option must be ${TEXT_RULE}, of 1 to ${BOARD_LIMITS.option} characters`);
  if (id !== undefined && !BOARD_KEY_RE.test(id)) throw boardError("E_BAD_ARGS", `--id must match ${BOARD_KEY_RE.source}`);
  if (context !== undefined && !contextOk(context)) throw boardError("E_BAD_ARGS", `the context must be 1 to ${BOARD_LIMITS.context} characters, with no control character but newline (LF), line separator, bidi control (U+202A-202E, U+2066-2069), U+200B, U+2060, U+FEFF or tag character`);
  return { question, options: [...options], id, context: context ?? null };
}

/** The file's bytes for a document. */
function serialize(doc) {
  const facts = {};
  for (const f of doc.facts) facts[f.key] = { label: f.label, value: f.value, unit: f.unit, link: f.link, at: f.at, seq: f.seq, history: f.history };
  return JSON.stringify({ boardApi: BOARD_API, asked: doc.asked, facts, questions: doc.questions }) + "\n";
}

/** One read-modify-write of `home`'s board, under its lock. `change(doc, now)` (doc: the live board, an
 *  empty one for no file) returns `{ changed, ...answer }` and may change `doc`; a change is checked against
 *  the bounds and written, and then the claim is set to what the questions say. → the answer with `board`,
 *  the row value after it. The caller holds the right to change the home. */
function updateBoard(home, change, { now = () => new Date() } = {}) {
  const path = join(home, BOARD_FILE), lock = join(home, BOARD_LOCK);
  return withDirLock(lock, "oats instance board", () => {
    const stored = readBoardDocument(home);
    const live = liveOf(home, stored);
    const doc = live === null ? EMPTY() : { ...live, facts: [...live.facts], questions: [...live.questions] };
    const out = change(doc, now().toISOString());
    // A question a session boundary ended is dropped by any write: a change, or one that only prunes.
    const pruned = stored !== null && stored.questions.length !== doc.questions.length;
    const written = out.changed || pruned;
    if (written) {
      if (doc.facts.length > BOARD_LIMITS.facts) throw boardError("E_BOARD_FULL", `the board holds at most ${BOARD_LIMITS.facts} facts: unset one first (oats instance board unset <key>); nothing was changed`);
      if (doc.questions.length > BOARD_LIMITS.questions) throw boardError("E_BOARD_FULL", `at most ${BOARD_LIMITS.questions} questions are open at once: clear one you have read first (oats instance board ask --clear <id>); nothing was changed`);
      const bytes = rowBytes(doc);
      if (bytes > ROW_MAX) throw boardError("E_BOARD_FULL", `the board would be ${bytes} bytes on a status row, over its ${ROW_MAX}-byte bound: shorten it, or unset a fact or clear a question first; nothing was changed`, { bytes, max: ROW_MAX });
      // What stands at the name, never followed: a directory there is no one's work (the name is kernel-owned),
      // and a rename cannot replace it.
      let standing = null;
      try { standing = lstatSync(path); } catch (e) { if (e?.code !== "ENOENT") throw e; }
      if (standing?.isDirectory()) rmSync(path, { force: true, recursive: true });
      writeThroughPrivateFile(path, `${path}.tmp-${process.pid}`, serialize(doc), 0o600);
    }
    // Under the lock, so that two writes set the claim in the order they wrote the board.
    syncClaim(home, doc);
    const { changed, ...rest } = out;
    return { ...rest, changed, board: stored === null && !written ? null : boardRow(doc) };
  }, { retryMs: LOCK_WAIT_MS, busy: (why) => boardError("E_BOARD_BUSY", `the board of ${home} is being written by another oats process (${why}); retry; if no oats process is writing it, remove ${lock}; nothing was changed`, { lock }) });
}

/** Set the `oats.board` claim to what the live questions say: the oldest one's text while any is open, none
 *  otherwise. setWaiting writes only a change. A write it refuses is E_EVENTS_FAILED, after the board was
 *  written: the next board command repairs it. */
function syncClaim(home, doc) {
  const oldest = doc.questions[0];
  try {
    setWaiting(home, oldest ? { producer: BOARD_PRODUCER, waiting: true, reason: "attention", message: oldest.question } : { producer: BOARD_PRODUCER, waiting: false });
  } catch (e) {
    throw boardError(e.code || "E_EVENTS_FAILED", `the board was written, but its needs-input claim was not: ${e.message}; run the same board command again to repair it`);
  }
}

/** `oats instance board set <key>`: upsert one fact. A set that changes nothing writes nothing; a new value
 *  joins the key's history (its last BOARD_LIMITS.history values). → `{ key, changed, board }`. */
export function setBoardFact(home, fields, options) {
  const fact = checkFact(fields);
  return updateBoard(home, (doc, now) => {
    const i = doc.facts.findIndex((f) => f.key === fact.key);
    const old = i >= 0 ? doc.facts[i] : null;
    if (old && old.label === fact.label && old.value === fact.value && old.unit === fact.unit && old.link === fact.link) return { key: fact.key, changed: false };
    if (!old && doc.facts.length >= BOARD_LIMITS.facts) throw boardError("E_BOARD_FULL", `the board holds at most ${BOARD_LIMITS.facts} facts: unset one first (oats instance board unset <key>); nothing was changed`);
    const history = old ? (old.value === fact.value ? old.history : [...old.history, { value: fact.value, at: now }].slice(-BOARD_LIMITS.history)) : [{ value: fact.value, at: now }];
    const next = { ...fact, at: now, seq: old ? old.seq : Math.max(-1, ...doc.facts.map((f) => f.seq)) + 1, history };
    if (old) doc.facts[i] = next; else doc.facts.push(next);
    return { key: fact.key, changed: true };
  }, options);
}

/** `oats instance board unset <key>`: remove one fact and its history. → `{ key, changed, board }`. */
export function unsetBoardFact(home, key, options) {
  if (typeof key !== "string" || !BOARD_KEY_RE.test(key)) throw boardError("E_BAD_ARGS", `the key must match ${BOARD_KEY_RE.source}`);
  return updateBoard(home, (doc) => {
    const i = doc.facts.findIndex((f) => f.key === key);
    if (i < 0) return { key, changed: false };
    doc.facts.splice(i, 1);
    return { key, changed: true };
  }, options);
}

/** `oats instance board ask <question>`: open one question. Its id is `--id`, else `q<n>` (n numbered per
 *  home, never reused while it lives). The same question asked again under an open id is no change, so a
 *  retry is safe; a different one under an open id is refused. → `{ id, changed, board }`. */
export function askBoardQuestion(home, fields, options) {
  const ask = checkQuestion(fields);
  return updateBoard(home, (doc, now) => {
    const open = ask.id !== undefined ? doc.questions.find((q) => q.id === ask.id) : undefined;
    if (open) {
      if (open.question === ask.question && open.context === ask.context && open.options.length === ask.options.length && open.options.every((o, i) => o === ask.options[i])) return { id: open.id, changed: false };
      throw boardError("E_BAD_ARGS", `question ${ask.id} is open with other text: clear it first (oats instance board ask --clear ${ask.id}), or ask under another --id; nothing was changed`);
    }
    if (doc.questions.length >= BOARD_LIMITS.questions) throw boardError("E_BOARD_FULL", `at most ${BOARD_LIMITS.questions} questions are open at once: clear one you have read first (oats instance board ask --clear <id>); nothing was changed`);
    let id = ask.id;
    if (id === undefined) {
      const taken = new Set(doc.questions.map((q) => q.id));
      do { doc.asked += 1; id = `q${doc.asked}`; } while (taken.has(id));
    } else {
      // An explicit q<n> moves the count past it, so a default id never repeats it.
      const n = /^q([1-9][0-9]{0,14})$/.exec(id);
      if (n) doc.asked = Math.max(doc.asked, Number(n[1]));
    }
    doc.questions.push({ id, question: ask.question, options: ask.options, context: ask.context, since: now });
    return { id, changed: true };
  }, options);
}

/** `oats instance board ask --clear <id>`: close one question; an id that is not open is no change.
 *  → `{ id, changed, board }`. */
export function clearBoardQuestion(home, id, options) {
  if (typeof id !== "string" || !BOARD_KEY_RE.test(id)) throw boardError("E_BAD_ARGS", `--clear takes the id of an open question (${BOARD_KEY_RE.source})`);
  return updateBoard(home, (doc) => {
    const i = doc.questions.findIndex((q) => q.id === id);
    if (i < 0) return { id, changed: false };
    doc.questions.splice(i, 1);
    return { id, changed: true };
  }, options);
}
