// RecordStore — the on-disk turn record per docs/turn-record-sot.md.
//
// Layout:
//   <root>/streams/<stream-id>/journal.jsonl   replicated, append-only, owner-write
//   <root>/objects/sha256/<hh>/<hex>           replicated, immutable
//   <root>/index/                              derived, rebuildable, never replicated
//
// Invariants enforced here:
//   - appends go only to streams owned by this store's configured owner;
//   - a truncated final journal line is ignored by readers and repaired
//     (truncated away) by the owner on its next append;
//   - merge of two copies of one stream requires the prefix relation;
//   - the effective record is the id-deduplicated union across streams,
//     minus turns hidden by valid tombstones.

import { bufferLines, fileChunks } from "./file-lines.mjs";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  openSync,
  opendirSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { DerivedState, fileVersion, sameVersion, invalidateLegacyMaps } from "./derived-state.mjs";
import { captureContext } from "./capture-context.mjs";
import { PRIVATE_FILE, makePrivateDir } from "./private-files.mjs";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";

import { finishTurn, sha256Hex, verifyTurnId } from "./canonical.mjs";
import { jsonlLines } from "./formats.mjs";

export class StoreError extends Error {}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function syncPath(path) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Repair a torn journal tail without reading the whole file: our writer
// appends complete lines in one write, so the only crash artifact is a
// final line without its newline. Truncate back to the last newline,
// scanning backward in bounded chunks.
export function repairTail(path) {
  if (!existsSync(path)) return;
  const size = statSync(path).size;
  if (size === 0) return;
  const fd = openSync(path, "r+");
  try {
    const one = Buffer.alloc(1);
    readSync(fd, one, 0, 1, size - 1);
    if (one[0] === 10) return; // ends with \n: intact
    const CHUNK = 65536;
    let pos = size - 1; // last byte is already known not to be \n
    while (pos > 0) {
      const start = Math.max(0, pos - CHUNK);
      const buf = Buffer.alloc(pos - start);
      readSync(fd, buf, 0, buf.length, start);
      const nl = buf.lastIndexOf(10);
      if (nl !== -1) {
        ftruncateSync(fd, start + nl + 1);
        return;
      }
      pos = start;
    }
    ftruncateSync(fd, 0); // the whole file was one torn line
  } finally {
    closeSync(fd);
  }
}

// A stream id is `<owner>~<source>`; `~` cannot appear in aweb aliases or
// DID identifiers, and neither side may contain path separators.
export function streamOwner(streamId) {
  const i = streamId.indexOf("~");
  if (i <= 0) throw new StoreError(`invalid stream id ${JSON.stringify(streamId)}`);
  return streamId.slice(0, i);
}

export function validStreamId(streamId) {
  return /^[A-Za-z0-9._-]+~[A-Za-z0-9._-]+$/.test(streamId);
}

// Parse journal text into turns. The final line may be a torn write: if it
// does not end in a newline or is not valid JSON, it is ignored and its byte
// offset reported so the owner can repair. Interior blank lines are
// tolerated as no-ops (they cannot hide data and must stay self-healable);
// interior invalid non-blank lines are corruption and throw.
export function parseJournal(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  const turns = [];
  let validEnd = 0;
  let offset = 0;
  while (offset < bytes.length) {
    let nl = bytes.indexOf(10, offset);
    const isFinal = nl === -1;
    if (isFinal) nl = bytes.length;
    let text = null;
    try {
      text = bytes.toString("utf8", offset, nl);
    } catch {
      // single line beyond the string limit: treat as torn if final,
      // corrupt if interior (same rule as unparseable JSON below)
    }
    if (text !== null && text.trim() === "") {
      if (isFinal) break;
      validEnd = nl + 1;
      offset = nl + 1;
      continue;
    }
    let turn = null;
    if (text !== null) {
      try {
        turn = JSON.parse(text);
      } catch {
        turn = null;
      }
    }
    if (turn === null) {
      if (isFinal) break; // torn tail: ignored, repaired on next append
      throw new StoreError(`corrupt interior journal line at byte ${offset}`);
    }
    if (isFinal) break; // valid JSON but no newline: still a torn tail
    turns.push(turn);
    validEnd = nl + 1;
    offset = nl + 1;
  }
  return { turns, validEnd, torn: validEnd < bytes.length };
}

// ----------------------------------------------------------- stream lock
//
// The per-stream lock is an exclusive-create lockfile carrying an OWNER
// TOKEN: the creating process's pid, its hostname, and a random nonce.
// Two properties follow from the token that a bare lockfile cannot give:
//
//   - staleness is judged against the HOLDER'S LIVENESS, not the lock's
//     age, so a contender that arrives late against a still-running holder
//     waits (or times out) instead of stealing a live lock; and
//   - release unlinks the lock only while it still carries the releaser's
//     nonce, so a holder whose lock was reclaimed cannot delete the
//     replacement lock out from under its new owner.
//
// Crash recovery is preserved: a lock whose pid is gone from this host is
// provably stale and is reclaimed at once, without waiting out any age.
//
// Age remains the fallback for the two cases where liveness is not
// knowable here: a lock created on another host (file sync can copy one
// in) and a lock with no readable token (written by an older version, or
// by hand).

function newLockToken() {
  return {
    pid: process.pid,
    host: hostname(),
    nonce: randomBytes(12).toString("hex"),
    acquiredAt: new Date().toISOString(),
  };
}

// Create the lock, or report that someone else holds it. The payload is
// written to a temp file and hard-linked into place, so the lock never
// exists with partial or empty content: a contender that can see the file
// can always read the whole token.
function createLock(lockPath, dir, token) {
  const tmp = join(dir, `.lock.tmp-${token.pid}-${token.nonce}`);
  try {
    writeFileSync(tmp, JSON.stringify(token) + "\n");
    try {
      linkSync(tmp, lockPath);
      return true;
    } catch (err) {
      if (err.code === "EEXIST") return false;
      throw err;
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* never created, or already gone */
    }
  }
}

// Read the lock as { token, ino, mtimeMs }; token is null when the file
// holds no readable owner token. Returns null when the lock has vanished.
function readLock(lockPath) {
  let st;
  let raw;
  try {
    st = statSync(lockPath);
    raw = readFileSync(lockPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null; // vanished: the holder released
    // Anything else (EACCES, EISDIR, EIO...) is a condition retrying cannot
    // clear. Swallowing it here is what let the acquire loop spin: it read
    // as "vanished" forever. Fail with the underlying code and path so the
    // operator can act on it.
    throw new StoreError(
      `cannot read stream lock ${lockPath}: ${err.code ?? "unknown error"} (${err.message})`,
      { cause: err },
    );
  }
  let token = null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.pid === "number" &&
      typeof parsed.host === "string" &&
      typeof parsed.nonce === "string"
    ) {
      token = parsed;
    }
  } catch {
    /* no token: an older or hand-written lock, judged by age below */
  }
  return { token, ino: st.ino, mtimeMs: st.mtimeMs };
}

// true / false when the holder's liveness is knowable from this process,
// null when it is not (the lock was created on another host). EPERM means
// the process exists and belongs to another user: alive.
function holderAlive(token) {
  if (token.host !== hostname()) return null;
  try {
    process.kill(token.pid, 0);
    return true;
  } catch (err) {
    return err.code === "ESRCH" ? false : true;
  }
}

function lockIsProvenStale(held, staleMs) {
  if (held.token) {
    const alive = holderAlive(held.token);
    if (alive === true) return false; // live holder: never stealable, at any age
    if (alive === false) return true; // dead holder: crash recovery
  }
  return Date.now() - held.mtimeMs > staleMs;
}

// Remove a lock we have proven stale — and only that lock. Re-checking the
// file's identity immediately before the unlink DETECTS a replacement that
// landed while we were proving the old lock stale, so the common cascade
// (reclaiming from whoever reclaimed first) is caught. It is a detection,
// not an exclusion: a replacement landing between this recheck and the
// unlink is still removed, and nothing here defends against that window.
//
// Returns null when there is nothing to report — the lock was removed, was
// already gone, or had been replaced since we proved it stale; all three
// mean "retry". Returns the underlying error when the removal itself keeps
// failing (a read-only or hostile directory), which the caller reports on
// timeout rather than retrying silently forever.
function removeStaleLock(lockPath, held) {
  let st;
  try {
    st = statSync(lockPath);
  } catch (err) {
    return err.code === "ENOENT" ? null : err; // already gone
  }
  if (st.ino !== held.ino || st.mtimeMs !== held.mtimeMs) return null; // replaced
  try {
    unlinkSync(lockPath);
    return null;
  } catch (err) {
    return err.code === "ENOENT" ? null : err; // beaten to it
  }
}

// Release: unlink only while the lock still carries our nonce. If it was
// reclaimed (we ran long enough to be judged dead, or a sync overwrote
// it), the file now belongs to another holder and is left alone.
function releaseOwnedLock(lockPath, token) {
  // Release runs in a finally block: it must not replace the critical
  // section's own outcome with a lock error. A lock we cannot read is also
  // a lock whose ownership we cannot prove, so leaving it is the correct
  // move as well as the safe one — it is reclaimable by liveness once this
  // process exits.
  let held;
  try {
    held = readLock(lockPath);
  } catch {
    return;
  }
  if (held === null) return;
  if (!held.token || held.token.nonce !== token.nonce) return;
  try {
    unlinkSync(lockPath);
  } catch {
    /* already gone */
  }
}

function describeHolder(held) {
  if (!held || !held.token) return "holder unknown";
  return `held by pid ${held.token.pid} on ${held.token.host} since ${held.token.acquiredAt}`;
}

/** A journal validation checkpoint whose fields can describe a journal of
 *  `size` bytes. Shape only: whether it is complete and still names the
 *  current file version is the caller's question. */
export function validJournalCheckpoint(checkpoint, size) {
  return Boolean(checkpoint) && Number.isSafeInteger(checkpoint.bytes) && checkpoint.bytes >= 0 && checkpoint.bytes <= size &&
    Number.isSafeInteger(checkpoint.count) && checkpoint.count >= 0 && checkpoint.count <= checkpoint.bytes &&
    typeof checkpoint.epoch === "string" && typeof checkpoint.complete === "boolean" &&
    (checkpoint.resetting === undefined || typeof checkpoint.resetting === "boolean") && !(checkpoint.resetting && checkpoint.complete);
}

export class RecordStore {
  constructor(root, { owner, lockTimeoutMs = 10000, lockStaleMs = 30000 } = {}) {
    if (!root) throw new StoreError("record root is required");
    // lockTimeoutMs is how long a contender waits; lockStaleMs is how old a
    // lock must be before it is reclaimed WHEN ITS HOLDER'S LIVENESS CANNOT
    // BE CHECKED (foreign host, no readable token). There is deliberately no
    // ordering constraint between them: safety against stealing a live
    // holder's lock comes from the owner token, not from the two thresholds
    // being ordered — an ordering that never held, because the waiter's
    // timeout starts when the contender arrives while age is measured from
    // the lock's creation.
    this.root = root;
    this.owner = owner ?? null;
    this.lockTimeoutMs = lockTimeoutMs;
    this.lockStaleMs = lockStaleMs;
  }

  // Serialize every read-repair-write sequence on one stream across
  // processes: hooks, watchers and manual passes can all fire close
  // together for the same owner, and an unguarded repair can truncate a
  // concurrent writer's already-fsynced turn. Exclusive-create lockfile
  // carrying an owner token; see the stream-lock helpers above for how
  // staleness is proven and why release is ownership-checked.
  withStreamLock(streamId, fn, { check = () => {} } = {}) {
    check();
    const context = captureContext(this);
    if (context) {
      if (!context.held.has(streamId)) throw new StoreError(`stream outside capture work group: ${streamId}`);
      return fn();
    }
    const dir = join(this.streamsDir(), streamId);
    makePrivateDir(dir);
    const lockPath = join(dir, ".lock");
    const token = newLockToken();
    const deadline = Date.now() + this.lockTimeoutMs;
    // Every iteration that fails to acquire falls through to ONE deadline
    // check and one sleep — there is deliberately no `continue` above them,
    // and no branch that retries "for free". An earlier version checked the
    // deadline only on the readable-and-live branch, so a lock that kept
    // failing to be read, or kept failing to be removed, or kept reading as
    // vanished (a dangling symlink does exactly that) retried forever, hot,
    // with nothing able to stop it. Retrying at once after a reclaim would
    // buy ~25ms on the crash-recovery path and reopen that hole; it is not
    // worth it.
    for (;;) {
      check();
      if (createLock(lockPath, dir, token)) break;
      const held = readLock(lockPath); // throws on anything but ENOENT
      const reclaimError =
        held !== null && lockIsProvenStale(held, this.lockStaleMs)
          ? removeStaleLock(lockPath, held)
          : null;
      if (Date.now() >= deadline) {
        throw new StoreError(
          `timed out waiting for lock on stream ${streamId} (${lockPath}, ${describeHolder(held)})` +
            (reclaimError
              ? `; it was judged stale but could not be removed: ${reclaimError.code ?? "unknown error"} (${reclaimError.message})`
              : ""),
        );
      }
      sleepSync(25);
    }
    try {
      return fn();
    } finally {
      releaseOwnedLock(lockPath, token);
    }
  }

  streamsDir() {
    return join(this.root, "streams");
  }

  journalPath(streamId) {
    if (!validStreamId(streamId)) {
      throw new StoreError(`invalid stream id ${JSON.stringify(streamId)}`);
    }
    return join(this.streamsDir(), streamId, "journal.jsonl");
  }

  listStreams() {
    const dir = this.streamsDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => validStreamId(name) && existsSync(join(dir, name, "journal.jsonl")))
      .sort();
  }

  *iterateStreams() {
    let dir;
    try { dir = opendirSync(this.streamsDir()); }
    catch (err) { if (err.code === "ENOENT") return; throw err; }
    try {
      for (let entry; (entry = dir.readSync()) !== null;) {
        if (validStreamId(entry.name) && existsSync(join(this.streamsDir(), entry.name, "journal.jsonl"))) yield entry.name;
      }
    } finally { dir.closeSync(); }
  }

  readStream(streamId) {
    const path = this.journalPath(streamId);
    if (!existsSync(path)) return [];
    return parseJournal(readFileSync(path)).turns;
  }

  // Bulk consumers need one turn at a time, not a buffer and parsed array
  // for an entire historical journal (some exceed 800 MB). Keep at most
  // one complete line plus read chunks, with the same corruption/torn-tail
  // rules as readStream. Joining fragments only at a newline avoids
  // repeatedly copying long lines as each chunk arrives.
  *iterateStream(streamId) {
    for (const entry of this.iterateJournal(streamId)) if (entry.turn !== null) yield entry.turn;
  }

  // Absolute byte boundaries, including blank lines, permit durable seeks.
  // The final fragment never advances a cursor: it is the owner's torn tail.
  *iterateJournal(streamId, { start = 0, end = Infinity, check = () => {} } = {}) {
    let fd;
    try { fd = openSync(this.journalPath(streamId), "r"); }
    catch (e) { if (e.code === "ENOENT") return; throw e; }
    let position = start;
    try {
      for (const line of bufferLines(fileChunks(fd, { start, end, size: 65536, check }))) {
        if (line[line.length - 1] !== 10) return;
        let parsed;
        try { parsed = parseJournal(line); }
        catch (e) {
          if (e instanceof StoreError) throw new StoreError(`corrupt interior journal line at byte ${position}`);
          throw e;
        }
        position += line.length;
        yield { turn: parsed.turns[0] ?? null, end: position, bytes: line.length };
      }
    } finally { closeSync(fd); }
  }

  withDerived(fn) {
    const context = captureContext(this);
    if (context) return fn(context.state);
    const state = new DerivedState(this.root);
    try { return fn(state); } finally { state.close(); }
  }

  // Caller holds the stream lock. Only a version recorded after validation or
  // our fsynced append can skip history. Unknown writes (including old releases),
  // replacement and shrink start a new epoch and invalidate dependent cursors.
  // Partial validation is resumable, but cannot authorize an append.
  validateJournal(streamId, state, { maxRecords = Infinity, maxBytes = Infinity, stopped = () => false, work } = {}) {
    const path = this.journalPath(streamId), version = fileVersion(path);
    let checkpoint = state.get("journal", streamId);
    if (checkpoint && !validJournalCheckpoint(checkpoint, version?.size ?? 0)) checkpoint = null;
    if (checkpoint && sameVersion(checkpoint.version, version) && checkpoint.complete) return checkpoint;
    if (!checkpoint || !sameVersion(checkpoint.version, version)) {
      checkpoint = { version, epoch: randomBytes(16).toString("hex"), bytes: 0, count: 0, complete: false, resetting: true };
      state.transaction(() => state.set("journal", streamId, checkpoint));
    }
    let recordsUsed = 0, bytesUsed = 0;
    // Clearing a large obsolete lookup is recovery work too. Its durable
    // phase marker prevents a deadline stop from restarting that deletion.
    while (checkpoint.resetting) {
      if (recordsUsed >= maxRecords || stopped()) return checkpoint;
      state.transaction(() => {
        const limit = Math.min(2000, maxRecords - recordsUsed);
        const removed = Number(state.statement(`DELETE FROM journal_ids WHERE rowid IN
          (SELECT rowid FROM journal_ids WHERE stream = ? LIMIT ?)`).run(streamId, limit).changes);
        recordsUsed += removed;
        if (work) work.deletedIds = (work.deletedIds ?? 0) + removed;
        if (removed < limit) { delete checkpoint.resetting; state.set("journal", streamId, checkpoint); }
      });
    }
    const addId = state.statement("INSERT OR IGNORE INTO journal_ids VALUES (?, ?)");
    const iterator = this.iterateJournal(streamId, { start: checkpoint.bytes, end: version?.size ?? 0,
      check: () => { stopped(); } });
    let done = false;
    try {
    while (!done) {
      if (recordsUsed >= maxRecords || bytesUsed >= maxBytes || stopped()) return checkpoint;
      state.transaction(() => {
        let batch = 0, bytes = 0;
        while (batch < 2000 && bytes < 8 * 1024 * 1024 && recordsUsed < maxRecords && bytesUsed < maxBytes && !stopped()) {
          const next = iterator.next();
          if (next.done) { done = true; break; }
          const entry = next.value;
          if (entry.turn !== null) {
            checkpoint.count++;
            if (typeof entry.turn.id === "string") addId.run(streamId, entry.turn.id);
          }
          checkpoint.bytes = entry.end;
          bytes += entry.bytes; bytesUsed += entry.bytes; batch++; recordsUsed++;
          if (work) { work.records = (work.records ?? 0) + 1; work.bytes = (work.bytes ?? 0) + entry.bytes; }
        }
        if (!sameVersion(version, fileVersion(path))) throw new StoreError(`journal changed during validation: ${path}`);
        checkpoint.complete = done;
        state.set("journal", streamId, checkpoint);
      });
    }
    return checkpoint;
    } finally { iterator.return(); }
  }

  journalCheckpoint(streamId) {
    this.journalPath(streamId);
    return this.withStreamLock(streamId, () => this.withDerived(state => this.validateJournal(streamId, state)));
  }

  // The ids among `candidates` that the stream holds, in one streamed read of
  // its journal: a dedupe for a few ids never builds the whole stream's set.
  idsAmong(streamId, candidates) {
    const found = new Set();
    if (candidates.size === 0) return found;
    for (const turn of this.iterateStream(streamId)) if (candidates.has(turn.id)) found.add(turn.id);
    return found;
  }

  // Is this a session-content stream (`<owner>~<source>.<session-id>`)?
  // Their journals hold whole conversations and can be large, so bulk
  // reads exclude them unless asked; access them per-thread instead.
  static isSessionStream(streamId) {
    return /~(cc|pi|codex)\./.test(streamId);
  }

  // Streams holding the turns of one session thread, across owners.
  sessionStreamsFor(thread) {
    const m = /^(cc|pi|codex):session:(.+)$/.exec(thread);
    if (!m) return [];
    const suffix = `~${m[1]}.${m[2]}`;
    return this.listStreams().filter((s) => s.endsWith(suffix));
  }

  // Read every turn in the store, id-deduplicated union across streams.
  // Session-content streams are excluded by default (their journals hold
  // whole conversations; read those per-thread via sessionStreamsFor).
  // Returns Map id -> { turn, stream }.
  readAll({ includeSessionContent = false } = {}) {
    const byId = new Map();
    for (const streamId of this.listStreams()) {
      if (!includeSessionContent && RecordStore.isSessionStream(streamId)) continue;
      for (const turn of this.readStream(streamId)) {
        if (typeof turn.id === "string" && !byId.has(turn.id)) {
          byId.set(turn.id, { turn, stream: streamId });
        }
      }
    }
    return byId;
  }

  // Ids hidden by valid tombstones. v1 authority: the tombstone's `from`
  // must equal the target turn's `from`, or the record owner.
  hiddenIds(byId = this.readAll()) {
    const claims = this.tombstoneClaims(byId);
    const hidden = new Set();
    for (const { turn } of byId.values()) {
      if (this.claimHides(claims, turn)) hidden.add(turn.id);
    }
    return hidden;
  }

  // Tombstone claims by target ref: ref -> Set of tombstoning authors.
  // hiddenIds() resolves claims against the turns present in byId; use
  // claims + claimHides() directly when iterating turns that are NOT in
  // byId — session streams are excluded from readAll() by default, yet a
  // tombstone in any stream must still hide a session event (per-line
  // redaction is a first-class operation in the per-event model).
  tombstoneClaims(byId = this.readAll()) {
    const claims = new Map();
    for (const { turn } of byId.values()) {
      if (turn.kind !== "tombstone") continue;
      for (const link of turn.links ?? []) {
        if (link.rel !== "tombstones" || typeof link.ref !== "string") continue;
        let authors = claims.get(link.ref);
        if (!authors) claims.set(link.ref, (authors = new Set()));
        authors.add(turn.from);
      }
    }
    return claims;
  }

  // v1 authority: a claim hides a turn when its author is the turn's
  // author or the record owner.
  claimHides(claims, turn) {
    const authors = claims.get(turn.id);
    if (!authors) return false;
    return authors.has(turn.from) || (this.owner !== null && authors.has(this.owner));
  }

  // Append a finished turn (id present and correct) to an owned stream.
  // Repairs a torn tail first. Durability: fsync after append.
  append(streamId, turn) {
    this.appendBatch(streamId, [turn]);
  }

  // Build, finish (compute id), dedupe, and append in one step.
  // Returns { turn, appended } — appended=false when the id already exists.
  appendCore(streamId, core, knownIds = null) {
    const turn = finishTurn(core);
    if (knownIds) {
      if (knownIds.has(turn.id)) return { turn, appended: false };
      this.append(streamId, turn);
      knownIds.add(turn.id);
      return { turn, appended: true };
    }
    return { turn, appended: this.appendUniqueBatch(streamId, [turn]) === 1 };
  }

  appendUniqueBatch(streamId, turns) {
    return this.appendBatch(streamId, turns, 8 * 1024 * 1024, true);
  }

  // Append many finished turns with bounded writes and one fsync. Same
  // ownership and id checks as append(); an empty batch is a no-op. The
  // read-repair-append sequence runs under the stream lock. Writes are
  // chunked by bytes, never one join of the whole batch: a large session
  // captured in one pass is a single batch, and joining it can exceed
  // V8's maximum string length (this crashed the first live recapture).
  appendBatch(streamId, turns, maxChunkBytes = 32 * 1024 * 1024, unique = false) {
    if (turns.length === 0) return 0;
    if (!this.owner) throw new StoreError("store has no owner; cannot append");
    if (streamOwner(streamId) !== this.owner) {
      throw new StoreError(
        `stream ${streamId} is not owned by ${this.owner}; appends are owner-only`,
      );
    }
    for (const turn of turns) {
      if (!verifyTurnId(turn)) throw new StoreError("turn id missing or does not match content");
    }
    const path = this.journalPath(streamId);
    return this.withStreamLock(streamId, () => {
      invalidateLegacyMaps(this.root);
      return this.withDerived(state => {
      const checkpoint = this.validateJournal(streamId, state);
      repairTail(path);
      // Node 22.5 returns a null-valued row on no match; object truthiness
      // is not an existence test across the supported SQLite runtimes.
      const hasId = state.db.prepare("SELECT 1 AS found FROM journal_ids WHERE stream = ? AND id = ?");
      const addId = state.db.prepare("INSERT OR IGNORE INTO journal_ids VALUES (?, ?)");
      let chunk = [], chunkBytes = 0, appended = 0;
      const flush = () => {
        if (!chunk.length) return;
        appendFileSync(path, chunk.join("\n") + "\n", { mode: PRIVATE_FILE });
        chunk = []; chunkBytes = 0;
      };
      // A failed transaction can leave appended journal bytes. Its old version
      // checkpoint then fails qualification and a later pass validates/rebuilds.
      return state.transaction(() => {
        for (const turn of turns) {
          if (unique && hasId.get(streamId, turn.id)?.found === 1) continue;
          const line = JSON.stringify(turn), bytes = Buffer.byteLength(line) + 1;
          if (chunkBytes && chunkBytes + bytes > maxChunkBytes) flush();
          chunk.push(line); chunkBytes += bytes;
          addId.run(streamId, turn.id); appended++;
        }
        flush();
        if (existsSync(path)) syncPath(path);
        checkpoint.version = fileVersion(path);
        checkpoint.bytes = checkpoint.version?.size ?? 0;
        checkpoint.count += appended;
        state.set("journal", streamId, checkpoint);
        return appended;
      });
      });
    });
  }

  // ------------------------------------------------------------- objects

  objectPath(hexDigest) {
    if (!/^[0-9a-f]{64}$/.test(hexDigest)) {
      throw new StoreError(`invalid sha256 digest ${JSON.stringify(hexDigest)}`);
    }
    return join(this.root, "objects", "sha256", hexDigest.slice(0, 2), hexDigest);
  }

  putObject(bytes) {
    const digest = sha256Hex(bytes);
    const path = this.objectPath(digest);
    if (!existsSync(path)) {
      makePrivateDir(join(this.root, "objects", "sha256", digest.slice(0, 2)));
      const tmp = path + ".tmp-" + process.pid;
      writeFileSync(tmp, bytes, { mode: PRIVATE_FILE });
      renameSync(tmp, path);
    }
    return "sha256:" + digest;
  }

  hasObject(ref) {
    return existsSync(this.objectPath(refDigest(ref)));
  }

  getObject(ref) {
    return readFileSync(this.objectPath(refDigest(ref)));
  }

  // ---------------------------------------------------------------- merge

  // Merge a foreign copy of a stream into this store. Copies of one stream
  // must be prefix-related; the longer wins. Non-prefix copies are
  // quarantined (written beside the journal), never merged silently.
  mergeStreamCopy(streamId, foreignTurns) {
    for (const turn of foreignTurns) {
      if (!verifyTurnId(turn)) {
        throw new StoreError(`foreign copy of ${streamId} contains a turn with a bad id`);
      }
    }
    const path = this.journalPath(streamId);
    return this.withStreamLock(streamId, () => {
      const local = this.readStream(streamId);
      const [shorter, longer] =
        local.length <= foreignTurns.length ? [local, foreignTurns] : [foreignTurns, local];
      for (let i = 0; i < shorter.length; i++) {
        if (shorter[i].id !== longer[i].id) {
          const qPath = join(this.streamsDir(), streamId, `quarantine-${Date.now()}.jsonl`);
          writeFileSync(qPath, foreignTurns.map((t) => JSON.stringify(t)).join("\n") + "\n", { mode: PRIVATE_FILE });
          throw new StoreError(
            `non-prefix copies of stream ${streamId}: foreign copy quarantined at ${qPath}`,
          );
        }
      }
      if (longer === local) return { extended: 0 };
      repairTail(path);
      const suffix = longer.slice(local.length);
      appendFileSync(path, suffix.map((t) => JSON.stringify(t)).join("\n") + "\n", { mode: PRIVATE_FILE });
      syncPath(path);
      return { extended: suffix.length };
    });
  }
}

function refDigest(ref) {
  if (typeof ref !== "string" || !ref.startsWith("sha256:")) {
    throw new StoreError(`invalid object ref ${JSON.stringify(ref)}`);
  }
  return ref.slice("sha256:".length);
}
