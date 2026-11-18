// Private command work, one bounded log batch under the shared stream group.
// Explicit per-file public APIs keep their full-reprojection defaults.
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { basename } from "node:path";
import { awBoundaryWitness, awLogLines, awStream, SEALED_AW_LOG_REASON } from "./capture-aw.mjs";
import { captureContext } from "./capture-context.mjs";
import { CAPTURE_POLICY } from "./capture-budget.mjs";
import { fileVersion, statVersion, sameVersion } from "./derived-state.mjs";
import { fileChunks, RecordSizeError } from "./file-lines.mjs";
import { loadIgnore } from "./ignore.mjs";
import { projectCommLogEntry, projectInteractionLogEntry } from "./project-aweb.mjs";

export function captureAwUnit(store, { owner, path, kind = "comm", selfName, workspace, ignore,
  maxRecords = 2000, maxBytes = 8388608, maxRecordBytes = CAPTURE_POLICY.maxRecordBytes,
  stopped = () => false, work } = {}) {
  const stream = awStream(owner), key = `${stream}:${path}`, account = basename(path, ".jsonl");
  const context = captureContext(store), state = context?.state;
  if (!state?.depth || !context.held.has(stream)) throw new Error("AW command unit requires its stream work group");
  if (!["comm", "interaction"].includes(kind) || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 2000 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > context.batchBytes ||
      !Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1 || maxRecordBytes > CAPTURE_POLICY.maxRecordBytes) {
    throw new Error("invalid AW command unit budget");
  }
  const result = { stream, key, entries: 0, skipped: 0, failed: 0, appended: 0, bytesCommitted: 0, complete: false, pending: false };
  if ((ignore ?? loadIgnore(store.root)).ignores(path, [basename(path), account])) {
    state.delete("set-aside", key);
    return { ...result, ignored: true, complete: true };
  }
  const blocked = state.get("set-aside", key);
  if (blocked && !blocked.retry) return { ...result, setAside: blocked,
    ...(blocked.reason === SEALED_AW_LOG_REASON ? { sealed: 1 } : {}) };
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const observe = () => {
      const stat = fstatSync(fd, { bigint: true });
      if (!stat.isFile()) throw new Error("AW source is not a regular file");
      const version = statVersion(stat);
      if (!sameVersion(version, fileVersion(path))) throw new Error("AW source descriptor differs from its named file");
      return version;
    };
    const version = observe(), generation = state.get("reset", `${owner}:aw`) ?? "",
      retryGeneration = state.get("source-retry", key) ?? "";
    const projection = JSON.stringify(kind === "comm" ? [kind, account] : [kind, selfName ?? null, workspace ?? null]);
    const journal = store.validateJournal(stream, state, { maxRecords, maxBytes, stopped, work: work?.journal });
    if (!journal.complete) return { ...result, phase: "journal" };
    const witness = offset => {
      if (work) work.sourceProbeBytes = (work.sourceProbeBytes ?? 0) + Math.min(4096, offset);
      return awBoundaryWitness(fd, offset);
    };
    const matches = value => value && Number.isSafeInteger(value.bytes) && value.bytes >= 0 && value.bytes <= version.size &&
      value.generation === generation && (value.retryGeneration ?? "") === retryGeneration && value.epoch === journal.epoch && value.version &&
      (value.projection === projection || value.projection === undefined && kind === "comm") &&
      (sameVersion(value.version, version) || value.version.dev === version.dev && value.version.ino === version.ino &&
        version.size > value.version.size && witness(value.bytes) === value.witness);
    let job = state.get("aw-unit", key);
    if (!matches(job) || !Number.isSafeInteger(job.end) || job.end < job.bytes || job.end > version.size) {
      job = null; state.delete("aw-unit", key);
    }
    if (!job) {
      const cursor = state.get("aw", key), qualified = matches(cursor) && !blocked;
      if (qualified && cursor.complete && sameVersion(cursor.version, version)) {
        // The public API's complete flag means the snapshot was scanned; an
        // unconsumed final fragment still prevents command sweep success.
        return { ...result, unchanged: true, complete: cursor.bytes === version.size,
          pending: cursor.bytes < version.size, phase: "captured" };
      }
      // A cursor that no longer qualifies (new epoch, reset, retry, an older
      // release's shape) still proves what it captured from this same file:
      // records before its bytes are rescanned without the record limit. A
      // rescan's cursor also carries the frontier it is still below, so a
      // second invalidation between its units keeps the larger proof.
      const sameFile = cursor?.version?.dev === version.dev && cursor?.version?.ino === version.ino;
      const proof = (bytes, mark) => sameFile && Number.isSafeInteger(bytes) && bytes > 0 && bytes <= version.size &&
        typeof mark === "string" && witness(bytes) === mark ? [bytes, mark] : [0, undefined];
      const [frontier, frontierWitness] = [qualified ? [0, undefined] : proof(cursor?.bytes, cursor?.witness),
        proof(cursor?.frontier, cursor?.frontierWitness)].reduce((a, b) => b[0] > a[0] ? b : a);
      job = { bytes: qualified ? cursor.bytes : 0, end: version.size, version, generation, retryGeneration,
        epoch: journal.epoch, projection, frontier, frontierWitness };
    }
    const unitStart = job.bytes, boundary = witness(version.size);
    const chunks = function* () {
      for (const bytes of fileChunks(fd, { start: unitStart, end: job.end, size: 65536, check: () => { stopped(); } })) {
        if (work) work.sourceBytes = (work.sourceBytes ?? 0) + bytes.length;
        yield bytes;
      }
    };
    const project = kind === "comm" ? entry => projectCommLogEntry(entry, { selfName: account }) :
      entry => projectInteractionLogEntry(entry, { selfName, workspace });
    let bytes = 0, records = 0, scanned = false, oversized = null, sealed = null;
    const turns = [], iterator = awLogLines(chunks(), { start: unitStart, maxBytes: maxRecordBytes, frontier: job.frontier ?? 0 });
    try {
      while (records < maxRecords && bytes < maxBytes && !stopped()) {
        const next = iterator.next();
        if (next.done) { scanned = true; break; }
        const record = next.value;
        if (records && bytes + record.bytes > maxBytes) break;
        if (record.sealed) {
          result.entries++; result.sealed = 1; sealed = record.start;
          if (work) work.sourceRecords = (work.sourceRecords ?? 0) + 1;
          break;
        }
        records++; bytes += record.bytes; job.bytes = record.end;
        if (work) work.sourceRecords = (work.sourceRecords ?? 0) + 1;
        if (record.skipped) result.skipped++;
        if (record.parsed) {
          result.entries++;
          // Projection refusal is consumed input, not a failed durable append.
          // Reset requests replay; ordinary growth never retries the old line.
          try { turns.push(project(record.entry)); }
          catch { result.failed++; }
        }
        if (record.final) { result.pending = true; scanned = true; break; }
      }
    } catch (error) {
      if (!(error instanceof RecordSizeError)) throw error;
      // The raw record was rejected before allocation. Every complete record
      // before it is still processable: commit them below, then set aside.
      oversized = unitStart + error.offset;
      if (oversized !== job.bytes) throw new Error("AW oversized record does not follow the consumed records");
    } finally { iterator.return(); }
    const after = observe();
    if (!sameVersion(version, after) && !(after.dev === version.dev && after.ino === version.ino &&
        after.size > version.size && witness(version.size) === boundary)) throw new Error("AW source changed during unit");
    if (turns.length) result.appended = store.appendUniqueBatch(stream, turns);
    result.bytesCommitted = job.bytes - unitStart;
    job.version = version; job.witness = witness(job.bytes);
    const atEnd = job.bytes === job.end;
    state.set("aw", key, { bytes: job.bytes, version, witness: job.witness, generation, retryGeneration,
      epoch: journal.epoch, projection, complete: (scanned || atEnd) && job.end === version.size,
      ...(job.frontier > job.bytes && job.frontierWitness ? { frontier: job.frontier, frontierWitness: job.frontierWitness } : {}) });
    if (blocked && (job.bytes > blocked.offset || atEnd)) state.delete("set-aside", key);
    if (scanned || atEnd) state.delete("aw-unit", key);
    else state.set("aw-unit", key, job);
    if (sealed !== null) {
      const row = { owner, source: "aw", path, offset: sealed, reason: SEALED_AW_LOG_REASON, retry: false };
      state.set("set-aside", key, row);
      return { ...result, setAside: row };
    }
    if (oversized !== null) {
      // Not captured past its exact start. Later records wait for an edited
      // source or an ignore of the whole input.
      const row = { owner, source: "aw", path, offset: oversized, reason: "record-too-large", retry: false };
      state.set("set-aside", key, row);
      return { ...result, setAside: row };
    }
    return { ...result, complete: atEnd, phase: "capture" };
  } finally { closeSync(fd); }
}
