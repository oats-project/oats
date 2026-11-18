// Capture of aw client logs into the record.
//
// Sources:
//   ~/.config/aw/logs/<account>.jsonl   signed-client comm log (mail + chat)
//   <workspace>/.aw/interaction-log.jsonl
//
// All aw-log turns from one machine land in one stream, `<owner>~aw` —
// the stream is the writer (this machine's capture process), not the
// account; account and file identity live in each turn's provenance.
// Projection is deterministic, so the same entry captured on two machines
// dedupes by id. Reconciliation is the capture: scan, project, append what
// is new, in bounded batches.
//
// Inputs are append-only logs. Background growth uses a bounded boundary
// witness and byte cursor; explicit per-file calls retain full reprojection.
// Persistent journal ID lookup makes either path use bounded memory.

import { closeSync, constants, existsSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { DerivedState, statVersion, sameVersion } from "./derived-state.mjs";
import { captureContext } from "./capture-context.mjs";

import {
  projectCommLogEntry,
  projectInteractionLogEntry,
} from "./project-aweb.mjs";
import { loadIgnore } from "./ignore.mjs";
import { bufferLines, fileChunks } from "./file-lines.mjs";

export function defaultCommLogDir(home = homedir()) {
  return join(home, ".config", "aw", "logs");
}

export function awStream(owner) {
  return `${owner}~aw`;
}

export function listCommLogs(dir = defaultCommLogDir()) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => join(dir, name));
}

// The entries of the first `end` bytes of a JSONL log, one at a time, read
// in chunks from `fd` (a comm log can exceed V8's maximum string length).
// A final line without its newline is still an entry when it parses; when it
// does not, it is a torn tail the client is still writing, never counted. An
// interior bad line is skipped and counted (`onSkipped`), never fatal.
function* logEntries(fd, start, end, onSkipped, onConsumed) {
  for (const record of awLogLines(fileChunks(fd, { start, end, size: 65536 }), { start })) {
    if (!record.final && !record.sealed) onConsumed(record.end);
    if (record.skipped) onSkipped();
    if (record.parsed) yield record;
  }
}

// Command units must account for every scanned line, including empty/malformed
// ones. Public capture's wrapper above retains its existing entry counters.
export function* awLogLines(chunks, { start = 0, maxBytes = Infinity, frontier = 0 } = {}) {
  let offset = start;
  for (const line of bufferLines(chunks, { maxBytes, limitFrom: Math.max(0, frontier - start) })) {
    const lineStart = offset;
    offset += line.length;
    const final = line[line.length - 1] !== 10;
    // Even ignored whitespace is scanned progress when newline-terminated.
    // The caller persists it only after its pending append batch is durable.
    const record = { start: lineStart, end: final ? lineStart : offset, bytes: line.length, final };
    try {
      // Inside the try: a line beyond V8's string limit is a bad line like any other.
      const text = line.toString("utf8");
      if (text.trim() === "") { yield record; continue; }
      const entry = JSON.parse(text);
      // Sealed aw client-log envelopes are ciphertext, not projection errors.
      const sealed = entry !== null && typeof entry === "object" &&
        ["v", "key_id", "tag", "enc", "ct"].every(key => Object.hasOwn(entry, key));
      yield { ...record, entry, parsed: true, ...(sealed ? { sealed: true } : {}) };
    } catch {
      yield { ...record, skipped: !final };
    }
  }
}

const APPEND_BATCH = 2000;

// Check only a bounded checkpoint boundary under the append-only source contract.
export function awBoundaryWitness(fd, offset) {
  const size = Math.min(offset, 4096), bytes = Buffer.alloc(size);
  let done = 0;
  while (done < size) {
    const n = readSync(fd, bytes, done, size - done, offset - size + done);
    if (!n) throw new Error("short read of log checkpoint boundary");
    done += n;
  }
  return createHash("sha256").update(bytes).digest("hex");
}

const boundaryWitness = awBoundaryWitness;

function captureLogFile(store, { streamId, path, project, knownIds, incremental = false }) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let state;
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile()) throw new Error(`log source is not a regular file: ${path}`);
    const version = statVersion(stat), end = version.size;
    state = captureContext(store)?.state ?? new DerivedState(store.root);
    const generation = state.get("reset", streamId.split("~")[0] + ":aw") ?? "";
    const key = `${streamId}:${path}`;
    let previous = incremental ? state.get("aw", key) : null;
    if (previous && (!Number.isSafeInteger(previous.bytes) || previous.bytes < 0 || previous.bytes > end || !previous.version)) previous = null;
    const journal = store.journalCheckpoint(streamId);
    let start = 0;
    if (previous && previous.generation === generation && previous.epoch === journal.epoch) {
      if (previous.complete && sameVersion(previous.version, version)) return { entries: 0, appended: 0, skipped: 0, failed: 0, unchanged: true };
      const old = previous.version;
      if (old.dev === version.dev && old.ino === version.ino && (version.size > old.size || sameVersion(old, version)) &&
          previous.bytes <= end && boundaryWitness(fd, previous.bytes) === previous.witness) start = previous.bytes;
    }
    let entries = 0, skipped = 0, failed = 0, appended = 0, batch = [], batchBytes = 0, consumed = start, complete = false, sealed = 0;
    const checkpoint = () => {
      if (!incremental) return;
      const bytes = consumed;
      state.set("aw", key, { bytes, version, witness: boundaryWitness(fd, bytes), epoch: journal.epoch, generation, complete });
    };
    const flush = () => {
      if (batch.length) {
        if (knownIds) { store.appendBatch(streamId, batch); appended += batch.length; }
        else appended += store.appendUniqueBatch(streamId, batch);
        batch = []; batchBytes = 0;
      }
      checkpoint();
    };
    const batchLimit = captureContext(store)?.batchBytes ?? 8 * 1024 * 1024;
    for (const record of logEntries(fd, start, end, () => skipped++, (offset) => { consumed = offset; })) {
      if (batch.length && batchBytes + record.bytes > batchLimit) {
        // The parser has reported this complete line as scanned, but it has
        // not yet been appended. An earlier batch may checkpoint only up to
        // this line's START, including intervening consumed blank lines.
        const scanned = consumed; consumed = record.start;
        flush(); consumed = scanned;
      }
      entries++;
      if (record.sealed) { consumed = record.start; sealed++; break; }
      let turn;
      // Projection refusal consumes this complete entry just like a skipped
      // malformed line. Resetting source cursors is the explicit retry path;
      // an old refusal must not pin every background pass to historical bytes.
      consumed = record.end;
      try { turn = project(record.entry); }
      catch { failed++; continue; }
      if (knownIds) { if (knownIds.has(turn.id)) continue; knownIds.add(turn.id); }
      batch.push(turn); batchBytes += record.bytes;
      if (batch.length >= APPEND_BATCH || batchBytes >= batchLimit) flush();
    }
    // Complete refused/malformed/blank lines are consumed; an unfinished final
    // fragment keeps its starting boundary so later growth can finish it.
    complete = sealed === 0;
    flush();
    return { entries, appended, skipped, failed, ...(sealed ? { sealed } : {}) };
  } finally { try { if (!captureContext(store)) state?.close(); } finally { closeSync(fd); } }
}

// Capture one comm-log file into `<owner>~aw`. The account name is the
// filename stem. `knownIds`, when given, is the caller's own id set, kept up to
// date, and decides instead of a read of the journal.
//
// Deliberately does NOT consult the ignore list: this is an explicit
// "capture this file" command, and the caller has named the file. The
// `<root>/ignore` policy is enforced at the pass level (captureAwLogs),
// which is the only entry point the capture bin uses.
export function captureCommLog(store, { owner, path, knownIds = null }) {
  const account = basename(path, ".jsonl");
  const streamId = awStream(owner);
  const r = captureLogFile(store, { streamId, path, knownIds, project: (e) => projectCommLogEntry(e, { selfName: account }) });
  return { account, stream: streamId, ...r };
}

// Capture one workspace interaction log into `<owner>~aw`. Like
// captureCommLog, this deliberately bypasses the ignore list: it is an
// explicit per-file command; pass-level entry points enforce the policy.
export function captureInteractionLog(store, { owner, path, selfName, workspace, knownIds = null }) {
  const streamId = awStream(owner);
  const r = captureLogFile(store, { streamId, path, knownIds, project: (e) => projectInteractionLogEntry(e, { selfName, workspace }) });
  return { stream: streamId, ...r };
}

// Retain sorted basename metadata, preserving listCommLogs' code-unit account
// order in both background capture and public results. Content is streamed;
// discovery metadata still grows with the number of log files.
function* iterateCommLogs(dir) {
  let names;
  try { names = readdirSync(dir); }
  catch (err) { if (err.code === "ENOENT") return; throw err; }
  for (const name of names.sort()) if (name.endsWith(".jsonl")) yield join(dir, name);
}
function* captureAwEntries(store, { owner, commLogDir, ignore }) {
  const ign = ignore ?? loadIgnore(store.root);
  for (const path of iterateCommLogs(commLogDir ?? defaultCommLogDir())) {
    const account = basename(path, ".jsonl");
    if (ign.ignores(path, [basename(path), account])) { yield { account, path, ignored: true }; continue; }
    const stream = awStream(owner);
    const result = captureLogFile(store, { streamId: stream, path, incremental: true,
      project: entry => projectCommLogEntry(entry, { selfName: account }) });
    if (!result.unchanged) yield { account, stream, ...result };
  }
}
export function captureAwLogs(store, { owner, commLogDir, ignore = null, collect = true } = {}) {
  const results = captureAwEntries(store, { owner, commLogDir, ignore });
  return collect ? [...results] : results;
}
