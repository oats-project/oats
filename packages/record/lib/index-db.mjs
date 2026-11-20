// Derived SQLite index over the record: turn metadata + FTS5 text.
// The index is cache: deleting <root>/index/ loses nothing; rebuild()
// reconstructs it from the streams. It is never replicated.
//
// update() is incremental: it indexes only journal lines appended since the
// last pass (per-stream position in index_state), so a capture pass costs
// seconds, not a rescan of the record. rebuild() is reset + update-from-zero
// — one code path, identical semantics.
//
// Session turns are one per native transcript event (body.line holds the
// verbatim record); text is extracted from that line, so a hit names the
// turn AND the event's line in the original transcript.

import { closeSync, existsSync, openSync, readSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { keysetRows } from "./sqlite-rows.mjs";
import { captureContext } from "./capture-context.mjs";
import { ensurePrivateFile, makePrivateDir } from "./private-files.mjs";
import { DerivedState, fileVersion, sameVersion } from "./derived-state.mjs";
import { validJournalCheckpoint } from "./store.mjs";
import { INDEX_SCHEMA_VERSION as SCHEMA_VERSION, TEXT_SCHEMA, resetIndexTables } from "./index-reset.mjs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

import { extractCcText, extractSessionTextFor } from "./formats.mjs";
import { parseOutfit, parseTag } from "./tags.mjs";
import { parseSegment, parseSpawn } from "./segments.mjs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  from_name TEXT NOT NULL,
  to_name TEXT,
  thread TEXT,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  fidelity TEXT NOT NULL,
  stream TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  superseded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS turns_thread ON turns(thread);
CREATE INDEX IF NOT EXISTS turns_ts ON turns(ts);
CREATE TABLE IF NOT EXISTS tombstones (
  ref TEXT NOT NULL,
  from_name TEXT NOT NULL,
  PRIMARY KEY (ref, from_name)
);
CREATE TABLE IF NOT EXISTS index_state (
  stream TEXT PRIMARY KEY,
  indexed_count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS index_bytes (
  stream TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL,
  indexed_count INTEGER NOT NULL,
  epoch TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tags (
  tag_id TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  about TEXT NOT NULL,
  acts TEXT NOT NULL,
  case_slug TEXT,
  note TEXT NOT NULL,
  PRIMARY KEY (tag_id)
);
CREATE INDEX IF NOT EXISTS tags_target ON tags(target_ref);
CREATE INDEX IF NOT EXISTS tags_case ON tags(case_slug);
CREATE TABLE IF NOT EXISTS outfits (
  outfit_id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  status TEXT NOT NULL,
  members TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS segments (
  note_id TEXT PRIMARY KEY,
  thread TEXT NOT NULL,
  start_n INTEGER NOT NULL,
  end_n INTEGER,
  type TEXT NOT NULL,
  outcome TEXT NOT NULL,
  about TEXT NOT NULL,
  established TEXT NOT NULL,
  lesson TEXT,
  ts TEXT NOT NULL,
  ts_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS segments_thread ON segments(thread, start_n);
CREATE TABLE IF NOT EXISTS spawns (
  note_id TEXT PRIMARY KEY,
  agent_thread TEXT NOT NULL,
  outfit_id TEXT NOT NULL,
  task TEXT,
  harness TEXT,
  grant_ref TEXT,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS spawns_agent ON spawns(agent_thread);
${TEXT_SCHEMA}
`;

export class RecordIndex {
  constructor(store) {
    const { DatabaseSync } = require("node:sqlite");
    this.store = store;
    const dir = join(store.root, "index");
    makePrivateDir(dir);
    const path = join(dir, "turns.db");
    const open = () => {
      ensurePrivateFile(path);
      const db = new DatabaseSync(path);
      // Concurrent index users (watcher pass, manual reindex, recall)
      // wait for each other instead of dying on "database is locked".
      db.exec("PRAGMA busy_timeout = 60000; PRAGMA cache_size = -2048; PRAGMA temp_store = FILE");
      return db;
    };
    this.db = open();
    const version = this.db.prepare("PRAGMA user_version").get().user_version;
    const isNew = !this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'turns'")
      .get();
    if (!isNew && version !== SCHEMA_VERSION) {
      // Old-schema index: self-heal by starting over. Deleting the cache
      // loses nothing; an in-place ALTER would just be a second way to
      // get this wrong.
      this.db.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          if (existsSync(path + suffix)) unlinkSync(path + suffix);
        } catch {
          // Two processes self-healing at the same instant: the loser's
          // unlink races the winner's; either way the schema ends fixed.
        }
      }
      this.db = open();
    }
    this.db.exec(SCHEMA);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    this.statements = new Map();
  }

  close() {
    this.statements.clear();
    this.db.close();
  }

  // One prepared statement per SQL text for this connection. Only for
  // statements run to completion (run/get/all), never left iterating.
  statement(sql) {
    let prepared = this.statements.get(sql);
    if (!prepared) { prepared = this.db.prepare(sql); this.statements.set(sql, prepared); }
    return prepared;
  }

  recordOwner() {
    if (this.store.owner) return this.store.owner;
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'owner'").get();
    return row ? row.value : null;
  }

  // Old releases keep writing index_state's count. A separate cursor table
  // leaves that schema/writer compatible; differing counts invalidate our
  // cursor rather than trusting a byte position left behind by a downgrade.
  //
  // One capture.db connection serves the whole pass. A census without locks
  // proves a stream current only when its complete validation checkpoint
  // names the journal's exact current version and the search cursor agrees
  // with it in bytes, count (both tables) and epoch; such a stream needs no
  // lock and no validation. Every other stream is a candidate and is
  // re-read under its stream lock. The census is not an atomic snapshot of
  // concurrent writers: a change after a stream is observed is indexed by a
  // later pass, as with any sequential pass.
  update() {
    const context = captureContext(this.store);
    const state = context ? context.state : new DerivedState(this.store.root);
    try {
      // Skip evidence is read from this connection: it must still be the file.
      if (!context) state.assertFile();
      const current = this.#reconcile(state, !context);
      this.#catchUp(state, !context, current);
      if (!context) state.assertFile();
    } finally { if (!context) state.close(); }
  }

  // Indexed streams whose evidence is incomplete are validated under their
  // locks first: if any proves the union stale (missing or replaced journal,
  // new epoch, invalid cursor, legacy count disagreement), the whole union
  // resets before any stream catches up, and no stream is current against
  // the new, empty generation. → the streams proven current, each with the
  // search-cursor row its proof used.
  #reconcile(state, owned) {
    const current = new Map();
    const rows = keysetRows(this.db, `SELECT s.stream, s.indexed_count, b.bytes,
      b.indexed_count AS byte_count, b.epoch FROM index_state s
      LEFT JOIN index_bytes b ON s.stream = b.stream`, "stream");
    for (const row of rows) {
      const path = this.store.journalPath(row.stream);
      // Inside a capture work group every stream still goes through the
      // group's membership check: only a pass owning its connection skips.
      if (owned && proven(row, state.get("journal", row.stream), fileVersion(path))) { current.set(row.stream, row); continue; }
      const checkpoint = this.store.withStreamLock(row.stream, () => {
        if (owned) state.assertFile();
        return this.store.validateJournal(row.stream, state);
      });
      let boundary = true;
      if (Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes < checkpoint.bytes) {
        const fd = openSync(path, "r"), byte = Buffer.alloc(1);
        try { boundary = readSync(fd, byte, 0, 1, row.bytes - 1) === 1 && byte[0] === 10; }
        finally { closeSync(fd); }
      }
      if (!Number.isSafeInteger(row.bytes) || row.bytes < 0 || !boundary || row.indexed_count !== row.byte_count ||
          row.epoch !== checkpoint.epoch || row.bytes > checkpoint.bytes || row.byte_count > checkpoint.count) {
        // Deleting a stream or changing its history can change tombstone authority
        // and cross-stream dedupe. Rebuild the derived union, not only its FTS rows.
        this.reset();
        return new Map();
      }
    }
    return current;
  }

  // Index the new bytes of every live stream not proven current, each under
  // its stream lock, in bounded transactions that commit rows and cursors
  // together. No transaction is open while the next stream lock is taken.
  // A proof holds only for the cursor it read: another index connection may
  // have reset the union or moved the cursor since, so the cursor is read
  // again when the stream's turn comes and a changed one makes it a candidate.
  #catchUp(state, owned, current) {
    const owner = this.store.owner;
    if (owner) this.db.prepare("INSERT INTO meta (key, value) VALUES ('owner', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(owner);
    const effectiveOwner = this.recordOwner();
    const getState = this.statement("SELECT * FROM index_bytes WHERE stream = ?");
    const setCount = this.statement("INSERT INTO index_state VALUES (?, ?) ON CONFLICT(stream) DO UPDATE SET indexed_count=excluded.indexed_count");
    const setBytes = this.statement("INSERT INTO index_bytes VALUES (?, ?, ?, ?) ON CONFLICT(stream) DO UPDATE SET bytes=excluded.bytes, indexed_count=excluded.indexed_count, epoch=excluded.epoch");
    const cursor = this.statement(`SELECT s.indexed_count, b.bytes, b.indexed_count AS byte_count, b.epoch FROM index_state s
      LEFT JOIN index_bytes b ON s.stream = b.stream WHERE s.stream = ?`);
    for (const streamId of this.store.iterateStreams()) {
      const proof = current.get(streamId);
      if (proof) {
        const now = cursor.get(streamId);
        if (now?.indexed_count === proof.indexed_count && now.bytes === proof.bytes &&
            now.byte_count === proof.byte_count && now.epoch === proof.epoch) continue;
      }
      this.store.withStreamLock(streamId, () => {
        if (owned) state.assertFile();
        const checkpoint = this.store.validateJournal(streamId, state);
        const row = getState.get(streamId);
        const previous = row?.stream != null ? row : null;
        let position = previous?.bytes ?? 0, count = previous?.indexed_count ?? 0;
        if (previous && previous.epoch !== checkpoint.epoch) throw new Error("journal changed during index update; retry to rebuild derived state");
        if (previous && position === checkpoint.bytes) return;
        const iterator = this.store.iterateJournal(streamId, { start: position, end: checkpoint.bytes });
        let done = false;
        try {
          while (!done) {
            this.db.exec("BEGIN IMMEDIATE");
            try {
              let batch = 0, bytes = 0;
              while (batch < 2000 && bytes < 8 * 1024 * 1024) {
                const next = iterator.next();
                if (next.done) { done = true; break; }
                const entry = next.value;
                if (entry.turn !== null) { this.addTurn(entry.turn, streamId, effectiveOwner); count++; }
                position = entry.end; bytes += entry.bytes; batch++;
              }
              setCount.run(streamId, count);
              setBytes.run(streamId, position, count, checkpoint.epoch);
              this.db.exec("COMMIT");
            } catch (err) { this.db.exec("ROLLBACK"); throw err; }
          }
        } finally { iterator.return(); }
      });
    }
  }

  // Full rebuild = reset + update from zero. Same code path as update().
  reset() {
    this.statements.clear();
    this.db.exec("BEGIN");
    try {
      resetIndexTables(this.db);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  rebuild() { this.reset(); this.update(); }

  // Insert one turn, maintaining the hidden invariant in both arrival
  // orders (tombstone before or after target). Duplicate ids across
  // streams: first seen wins.
  addTurn(turn, streamId, owner) {
    if (typeof turn.id !== "string") return;
    const existing = this.statement("SELECT stream FROM turns WHERE id = ?").get(turn.id);
    if (existing) {
      // Duplicate id across streams. Keep attribution deterministic and in
      // agreement with RecordStore.readAll(): alphabetically first stream,
      // regardless of indexing order.
      if (streamId < existing.stream) {
        this.statement("UPDATE turns SET stream = ? WHERE id = ?").run(streamId, turn.id);
      }
      return;
    }

    const fromName = String(turn.from ?? "");
    // Hidden if a valid tombstone already arrived for this id.
    const hidden = this.statement("SELECT 1 AS found FROM tombstones WHERE ref = ? AND (from_name = ? OR from_name = ?) LIMIT 1")
      .get(turn.id, fromName, owner ?? fromName)?.found === 1 ? 1 : 0;

    // Sessions are one turn per native event (no snapshots, nothing to
    // supersede); events/superseded columns remain for schema stability.
    const events = 0;
    const superseded = 0;

    this.statement(
      `INSERT INTO turns (id, ts, from_name, to_name, thread, kind, source, fidelity, stream, events, hidden, superseded)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .run(
        turn.id,
        String(turn.ts ?? ""),
        fromName,
        turn.to === undefined ? null : Array.isArray(turn.to) ? turn.to.join(",") : String(turn.to),
        turn.thread ?? null,
        String(turn.kind ?? ""),
        String(turn.provenance?.source ?? ""),
        String(turn.provenance?.fidelity ?? ""),
        streamId,
        events,
        hidden,
        superseded,
      );

    if (turn.kind === "tombstone") {
      for (const link of turn.links ?? []) {
        if (link.rel !== "tombstones" || typeof link.ref !== "string") continue;
        this.statement("INSERT OR IGNORE INTO tombstones (ref, from_name) VALUES (?, ?)")
          .run(link.ref, fromName);
        // Apply to a target that arrived first.
        const target = this.statement("SELECT id, from_name FROM turns WHERE id = ? AND hidden = 0")
          .get(link.ref);
        if (target && (target.from_name === fromName || (owner && fromName === owner))) {
          this.statement("UPDATE turns SET hidden = 1 WHERE id = ?").run(target.id);
          this.statement("DELETE FROM turn_text WHERE turn_id = ?").run(target.id);
          this.statement("DELETE FROM segments WHERE note_id = ?").run(target.id);
          this.statement("DELETE FROM spawns WHERE note_id = ?").run(target.id);
        }
      }
    }

    if (!hidden && !superseded) {
      const insText = this.statement(
        "INSERT INTO turn_text (turn_id, loc, role, text) VALUES (?, ?, ?, ?)",
      );
      for (const doc of this.extractText(turn)) {
        insText.run(turn.id, doc.loc, doc.role, doc.text);
      }
    }

    // Selection map: tags, outfits, segments, and spawns are note turns
    // with structured bodies; the index makes them queryable. A malformed
    // note turn must never break indexing — the rebuild invariant (one
    // bad turn anywhere cannot make the index unrecoverable) outranks
    // completeness of the selection map.
    let tag = null;
    let outfitParsed = null;
    let segParsed = null;
    let spawnParsed = null;
    if (turn.kind === "note") {
      try {
        tag = parseTag(turn);
        outfitParsed = parseOutfit(turn);
        segParsed = parseSegment(turn);
        spawnParsed = parseSpawn(turn);
      } catch {
        tag = null;
        outfitParsed = null;
        segParsed = null;
        spawnParsed = null;
      }
    }
    if (tag) {
      this.statement(
        "INSERT OR IGNORE INTO tags (tag_id, target_ref, about, acts, case_slug, note) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .run(turn.id, tag.target, JSON.stringify(tag.about), JSON.stringify(tag.acts), tag.caseSlug, tag.note);
    }
    const outfit = outfitParsed;
    if (outfit) {
      this.statement("INSERT OR IGNORE INTO outfits (outfit_id, task, status, members) VALUES (?, ?, ?, ?)")
        .run(turn.id, outfit.task, outfit.status, JSON.stringify(outfit.members));
    }
    if (segParsed && !hidden) {
      const locN = (r) => Number(/line:(\d+)/.exec(r ?? "")?.[1] ?? null);
      const tsMs = Date.parse(String(turn.ts ?? ""));
      this.statement(
        `INSERT OR IGNORE INTO segments (note_id, thread, start_n, end_n, type, outcome, about, established, lesson, ts, ts_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .run(
          turn.id,
          segParsed.thread,
          locN(segParsed.start) ?? 0,
          segParsed.end ? locN(segParsed.end) : null,
          segParsed.type,
          segParsed.outcome,
          JSON.stringify(segParsed.about),
          segParsed.established,
          segParsed.lesson,
          String(turn.ts ?? ""),
          Number.isFinite(tsMs) ? tsMs : 0,
        );
      // Full established+lesson searchable under role "segment".
      this.statement("INSERT INTO turn_text (turn_id, loc, role, text) VALUES (?, ?, ?, ?)")
        .run(turn.id, "", "segment", segParsed.established + (segParsed.lesson ? "\n" + segParsed.lesson : ""));
    }
    if (spawnParsed && !hidden) {
      this.statement(
        "INSERT OR IGNORE INTO spawns (note_id, agent_thread, outfit_id, task, harness, grant_ref, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
        .run(turn.id, spawnParsed.agent, spawnParsed.outfit, spawnParsed.task, spawnParsed.harness, spawnParsed.grant, String(turn.ts ?? ""));
    }
  }

  // The segment catalog: latest revision per (thread, start), structural
  // filters + optional FTS over established/lesson. Dead ends and
  // superseded judgments are excluded unless asked for.
  segmentCatalog({ thread, type, outcome, about, q, includeDead = false, limit = 50 } = {}) {
    let rows = this.db
      .prepare(
        `SELECT * FROM segments s WHERE NOT EXISTS (
           SELECT 1 FROM segments s2 WHERE s2.thread = s.thread AND s2.start_n = s.start_n
             AND (s2.ts_ms > s.ts_ms OR (s2.ts_ms = s.ts_ms AND s2.note_id > s.note_id)))`,
      )
      .all();
    if (q) {
      const hits = new Set(this.search(q, { role: "segment", limit: 500 }).map((h) => h.id));
      rows = rows.filter((r) => hits.has(r.note_id));
    }
    rows = rows.filter((r) => {
      if (thread && r.thread !== thread) return false;
      if (type && r.type !== type) return false;
      if (outcome && r.outcome !== outcome) return false;
      if (!outcome && !includeDead && (r.outcome === "dead-end" || r.outcome === "superseded")) return false;
      if (about && !JSON.parse(r.about).includes(about)) return false;
      return true;
    });
    rows.sort((a, b) => a.thread.localeCompare(b.thread) || a.start_n - b.start_n);
    return rows.slice(0, limit).map((r) => ({ ...r, about: JSON.parse(r.about) }));
  }

  // Creation mapping lookups for quality assessment.
  spawnsFor({ agent, outfit } = {}) {
    const rows = this.db.prepare("SELECT * FROM spawns").all();
    return rows.filter(
      (r) => (!agent || r.agent_thread === agent) && (!outfit || r.outfit_id === outfit),
    );
  }

  // Turn refs tagged with a case or topic slug (exact slug match).
  // The unfiltered scan is v1 debt: fine while the mind stream is small,
  // needs paging when tags accumulate over the record's lifetime.
  taggedRefs({ caseSlug, about } = {}) {
    const rows = caseSlug
      ? this.db
          .prepare("SELECT target_ref, about, acts, case_slug, note FROM tags WHERE case_slug = ?")
          .all(caseSlug)
      : this.db.prepare("SELECT target_ref, about, acts, case_slug, note FROM tags").all();
    return rows
      .filter((r) => {
        if (caseSlug && r.case_slug !== caseSlug) return false;
        if (about && !JSON.parse(r.about).includes(about)) return false;
        return true;
      })
      .map((r) => ({
        ref: r.target_ref,
        about: JSON.parse(r.about),
        acts: JSON.parse(r.acts),
        caseSlug: r.case_slug,
        note: r.note,
      }));
  }

  outfitsFor(taskWords) {
    const rows = this.db.prepare("SELECT outfit_id, task, status, members FROM outfits").all();
    const words = taskWords.toLowerCase().split(/\s+/).filter(Boolean);
    return rows
      .filter((r) => words.some((w) => r.task.toLowerCase().includes(w)))
      .map((r) => ({ id: r.outfit_id, task: r.task, status: r.status, members: JSON.parse(r.members) }));
  }

  // Text documents for one turn. Mail/chat: one doc. Session: one doc per
  // conversational event extracted from the transcript blob.
  extractText(turn) {
    return extractTurnText(turn);
  }

  // FTS query with optional filters. Returns rows with turn metadata and a
  // snippet. Hidden (tombstoned) and superseded turns never match.
  //
  // User text is not FTS5 syntax: a colon, a trailing AND, or an unbalanced
  // quote raises a parse error inside SQLite. First try the query as given
  // (so power users keep operators), then fall back to quoting every term
  // as a literal, then to no matches — never a crash.
  search(query, opts = {}) {
    try {
      return this.searchRaw(query, opts);
    } catch {
      const quoted = String(query)
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => '"' + t.replaceAll('"', '""') + '"')
        .join(" ");
      if (!quoted) return [];
      try {
        return this.searchRaw(quoted, opts);
      } catch {
        return [];
      }
    }
  }

  searchRaw(query, { kind, thread, from, role, limit = 20 } = {}) {
    let sql = `
      SELECT t.id, t.ts, t.from_name, t.to_name, t.thread, t.kind, t.source, t.stream,
             x.loc, x.role, snippet(turn_text, 3, '', '', ' … ', 24) AS snip
      FROM turn_text x
      JOIN turns t ON t.id = x.turn_id
      WHERE turn_text MATCH ? AND t.hidden = 0 AND t.superseded = 0`;
    const params = [query];
    if (kind) {
      sql += " AND t.kind = ?";
      params.push(kind);
    }
    if (thread) {
      sql += " AND t.thread = ?";
      params.push(thread);
    }
    if (from) {
      sql += " AND t.from_name = ?";
      params.push(from);
    }
    if (role) {
      sql += " AND x.role = ?";
      params.push(role);
    }
    sql += " ORDER BY rank LIMIT ?";
    params.push(limit);
    return this.db.prepare(sql).all(...params);
  }

  counts() {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS turns,
                SUM(hidden) AS hidden,
                SUM(superseded) AS superseded,
                (SELECT COUNT(*) FROM turn_text) AS docs
         FROM turns`,
      )
      .get();
    return {
      turns: Number(row.turns ?? 0),
      hidden: Number(row.hidden ?? 0),
      superseded: Number(row.superseded ?? 0),
      docs: Number(row.docs ?? 0),
    };
  }
}

// Journal text extraction is independent of the derived search database.
export function extractTurnText(turn) {
  if (turn.kind === "note" && turn.body?.segment) return []; // dedicated role "segment" row
  if (turn.kind === "mail" || turn.kind === "chat" || turn.kind === "note") {
    const subject = turn.body?.subject ?? "";
    const text = turn.body?.text ?? "";
    const joined = subject ? subject + "\n" + text : text;
    return joined.trim() ? [{ loc: "", role: turn.kind, text: joined }] : [];
  }
  if (turn.kind === "session" && typeof turn.body?.line === "string") {
    const loc = `line:${turn.provenance?.origin?.line ?? 0}`;
    return extractSessionTextFor(turn.provenance?.source, Buffer.from(turn.body.line, "utf8")).map(
      (d) => ({ ...d, loc }),
    );
  }
  return [];
}

// Claude Code text extraction, re-exported for compatibility; the
// per-format extractors live in formats.mjs.
export const extractSessionText = extractCcText;

// A stream whose search cursor is complete against a complete validation of
// the journal's exact current version. Anything missing, malformed, partial
// or disagreeing is unproven, never a reason to skip.
function proven(row, checkpoint, version) {
  return version !== null && validJournalCheckpoint(checkpoint, version.size) && checkpoint.complete && !checkpoint.resetting &&
    sameVersion(checkpoint.version, version) && row.epoch === checkpoint.epoch &&
    Number.isSafeInteger(row.bytes) && row.bytes === checkpoint.bytes &&
    row.byte_count === row.indexed_count && row.byte_count === checkpoint.count;
}

export function dropIndex(store) {
  rmSync(join(store.root, "index"), { recursive: true, force: true });
}

// Resolve a turn id wherever it lives: bulk streams first, then (for
// session-event turns, whose streams bulk reads exclude) via the index's
// stream column and a targeted journal read.
export function resolveTurn(store, index, id, byId = null) {
  const bulk = byId ?? store.readAll();
  const hit = bulk.get(id);
  if (hit) return hit.turn;
  const row = index.db.prepare("SELECT stream FROM turns WHERE id = ?").get(id);
  if (!row) return null;
  for (const t of store.readStream(row.stream)) if (t.id === id) return t;
  return null;
}
