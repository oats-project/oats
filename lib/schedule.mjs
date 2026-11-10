/** OATS schedules: workspace-scoped definitions and host-owned execution.
 *  (The captured-execution definitions of 0.24–0.25 were removed in 0.26: a
 *  stored one is reported invalid on its job and never runs.)
 *
 *  A definition lives in <scope>/oats-schedules.json, where the scope is the
 *  deployment directory (the one holding oats-local.yaml, found walking up;
 *  see scheduleScopeOf), and is evaluated by the host that holds that
 *  scope: one host registry, one host lock, one host timer that runs
 *  `oats schedule tick --host` once a minute. The tick is a short-lived
 *  process; there is no daemon, no queue and no retry. Only the current
 *  minute is evaluated, so minutes missed while the machine slept are
 *  skipped, never replayed. Cron expressions (five fields, an explicit IANA
 *  zone) are evaluated by croner; nothing here parses cron.
 *
 *  Three kinds: `spawn` launches one disposable instance per due minute,
 *  `command` runs an oats-only argv in a scope cwd and tracks any instance
 *  the envelope names, `wake` starts an existing home when it is stopped and
 *  delivers a literal message once when it is active. Outcomes say what was
 *  observed (launched, active, ended, stopped, launch-failed, unknown;
 *  delivered, started, skipped for wake) and never claim that a task
 *  succeeded. A launch whose side effects cannot be confirmed stays
 *  `unknown`, its job blocked until `reconcile` proves what happened; it keeps
 *  its host slot too, unless it is a command whose process exit was observed. */
import { runScheduleCommand } from "./schedule-command.mjs";
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Cron } from "croner";
import { loadLocal } from "./workspace.mjs";
import { noteRuntimeName } from "./deprecation.mjs";
import { herdrSettingRemoved } from "./errors.mjs";
import { withDirLock as withSharedDirLock } from "./dir-lock.mjs";
import { pollSourced, tickTriggers } from "./triggers.mjs";
import { SCHEDULE_NAME_RE, HOST_NAME_RE, readSnapshot, hostOf, trusted, parseOwner, MODEL_RE, automationError, baseRow, localEntry, localId, soulOriginOf, splitId, validateDescription } from "./automations.mjs";
import { MAX_INSTANCE_NAME, shq, shellWord, findAgent, findInstanceHomes, inspectInstanceSession, inputInstanceSession, sessionServerGone, startInstanceSession, retirePendingMarkerPath } from "./core.mjs";
import { writeThroughPrivateFile } from "./write-through-private-file.mjs";
import { readStartExited } from "./session-end.mjs";
import { appendEvent, waitingHold } from "./instance-events.mjs";
import { childEnv, scopeAutomations } from "./automation-scope.mjs";
export { SCHEDULE_API } from "./automation-api.mjs";
export { childEnv, scopeAutomations } from "./automation-scope.mjs";

export const SCHEDULE_FILE = "oats-schedules.json";
const ID_RE = SCHEDULE_NAME_RE;
const HARNESSES = new Set(["pi", "claude", "codex"]);
const MESSAGE_MAX = 256 * 1024;
const OATS_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "oats.mjs");
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

export function scheduleError(code, message, extra) { return Object.assign(new Error(message), { code, ...(extra || {}) }); }
/** describe's `executionStatus` (a released wire, kept as it was): a definition is
 *  `legacy` — the only kind that runs — or `invalid` (a captured one included,
 *  since 0.26), and so is its unresolved attempt. */
export function scheduleExecutionStatus(def, intent, lock) {
  const versioned = CAPTURED_SCHEDULE_KEYS.some((key) => def?.[key] !== undefined);
  const result = versioned ? { kind: "invalid", capture: "unknown", migrationRequired: true, reason: shapeError(def) } : { kind: "legacy", capture: "unknown", migrationRequired: true };
  if (!intent) return result;
  try {
    validateAttemptExecution(intent, lock);
    return { ...result, intent: { kind: "legacy", capture: "unknown", migrationRequired: true } };
  } catch (error) {
    return { ...result, intent: { kind: "invalid", capture: "unknown", migrationRequired: true, reason: error.message, errorCode: error.code } };
  }
}

/** The definition keys of a captured (versioned) schedule. That path was removed in 0.26. */
export const CAPTURED_SCHEDULE_KEYS = Object.freeze(["definitionVersion", "recurrencePolicy", "execution", "preparation"]);
const CAPTURED_SCHEDULE_REMOVED = "captured schedules are refused (the captured/portable path was removed in 0.26); remove this job, or re-add it without definitionVersion, recurrencePolicy, execution and preparation";
/** runtime → harness (0.27.0, lead call 6: read either, write new): a definition's
 *  `runtime` is its `harness`. Stored jobs are read with the new name (readDefinitions)
 *  and the next write stores it; a job naming both, differently, is invalid on its own. */
export const HARNESS_CONFLICT = "harness and runtime (its pre-0.27 name) disagree: keep harness: and remove runtime:";
export function shapeError(def) {
  if (!def || typeof def !== "object" || Array.isArray(def)) return "definition is not an object";
  if (def.kind === "trigger") return "a trigger is managed by oats trigger, not oats schedule";
  if (!["spawn", "command", "wake", "operation"].includes(def.kind)) return `kind ${JSON.stringify(def.kind)} is not spawn, command, wake or operation`;
  if (typeof def.cron !== "string" || typeof def.tz !== "string") return "cron and tz must be strings";
  if (def.kind === "spawn" && typeof def.agent !== "string") return "agent must be a string";
  if (def.kind === "command" && (typeof def.cwd !== "string" || !Array.isArray(def.argv))) return "cwd and argv are required";
  if (def.kind === "wake" && (typeof def.home !== "string" || typeof def.message !== "string")) return "home and message are required";
  if (def.kind === "operation" && (typeof def.operation !== "string" || typeof def.home !== "string")) return "operation and home are required";
  // A stored captured (versioned) definition is never evaluated or run (removed in 0.26): it reads
  // as invalid, migration required, on that job only.
  if (CAPTURED_SCHEDULE_KEYS.some((key) => def[key] !== undefined)) return CAPTURED_SCHEDULE_REMOVED;
  if (def.runtime !== undefined && def.harness !== undefined && def.runtime !== def.harness) return HARNESS_CONFLICT;
  return null;
}

// ---------------------------------------------------------------- scope

/** The one schedule-owning scope for a directory: the deployment, i.e. the
 *  directory holding the oats-local.yaml found walking up. No deployment in
 *  reach is E_LOCAL_MISSING; an ambient OATS_ROOT / PI_AGENTS_ROOT never
 *  chooses the scope (lead decision c3-5). */
export function scheduleScopeOf(dir) {
  let found;
  try { found = loadLocal(dir); }
  catch (e) {
    if (e?.code === "E_LOCAL_MISSING") throw scheduleError("E_LOCAL_MISSING", `schedules belong to a workspace deployment, and none is in reach of ${resolve(dir)} (no oats-local.yaml walking up; \`oats onboard\` creates one)`, { details: { dir: resolve(dir) } });
    throw e;
  }
  return dirname(found.path);
}
/** The scope's one agents root: <deployment>/agents. */
export function scopeRoots(scope) { return [resolve(scope, "agents")]; }

// ------------------------------------------------------------- files

export function oatsHomeDir() { return process.env.OATS_HOME_DIR || join(homedir(), ".oats"); }
export function hostScheduleDir() { return join(oatsHomeDir(), "schedules"); }
export function definitionsPath(ws) { return join(ws, SCHEDULE_FILE); }
export function stateDir(ws) { return join(ws, ".agents", "schedules"); }
function statePath(ws) { return join(stateDir(ws), "state.json"); }
function lockDir(ws, id) { return join(stateDir(ws), "locks", id); }

export const SCHEDULE_HISTORY_API = 3;
export const SCHEDULE_FILE_BUDGET = 1024 * 1024;
/** K8b — bounded, descriptor-safe JSON read: lstat → regular file only →
 *  O_NOFOLLOW|O_NONBLOCK open → fstat dev/ino identity → whole file only if
 *  within budget (an over-budget file is REFUSED as a typed error, never
 *  truncated into fabricated JSON). Returns { value, source }. */
function readJsonBounded(path, fallback, label, { atomicReplace = false } = {}) {
  let st;
  try { st = lstatSync(path); }
  catch (e) { if (e.code === "ENOENT") return { value: fallback, source: { path: label, status: "absent", bytes: 0 } }; throw scheduleError("E_SCHEDULE_INVALID", `${path} cannot be read: ${e.message}`, { field: "file", source: { path: label, status: "refused", bytes: 0 } }); }
  if (!st.isFile()) throw scheduleError("E_SCHEDULE_INVALID", `${path} is not a regular file`, { field: "file", source: { path: label, status: "refused", bytes: 0 } });
  if (st.size > SCHEDULE_FILE_BUDGET) throw scheduleError("E_SCHEDULE_STATE_OVERSIZE", `${path} is ${st.size} bytes; the read budget is ${SCHEDULE_FILE_BUDGET}`, { field: "file", source: { path: label, status: "oversize", bytes: st.size } });
  let fd, text;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const fst = fstatSync(fd);
    // The registry is atomically replaced by concurrent writers. Its opened,
    // no-follow regular-file descriptor is a coherent old/new snapshot even
    // when rename changed the inode since lstat. Other readers pin identity.
    if (!fst.isFile() || (!atomicReplace && (fst.dev !== st.dev || fst.ino !== st.ino)) || fst.size > SCHEDULE_FILE_BUDGET) throw new Error("swapped or grew past budget");
    const buf = Buffer.alloc(fst.size); let got = 0;
    while (got < fst.size) { const n = readSync(fd, buf, got, fst.size - got, got); if (n <= 0) break; got += n; }
    text = buf.toString("utf8"); st = fst;
  } catch (e) { throw scheduleError("E_SCHEDULE_INVALID", `${path} cannot be read safely: ${e.message}`, { field: "file", source: { path: label, status: "refused", bytes: st.size } }); }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* nothing to recover */ } }
  try { return { value: JSON.parse(text), source: { path: label, status: "ok", bytes: st.size } }; }
  catch (e) { throw scheduleError("E_SCHEDULE_INVALID", `${path} is not valid JSON: ${e.message}`, { field: "file", source: { path: label, status: "corrupt", bytes: st.size } }); }
}
function readJson(path, fallback) { return readJsonBounded(path, fallback, basename(path)).value; }
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeThroughPrivateFile(path, `${path}.tmp-${process.pid}`, JSON.stringify(value, null, 2) + "\n");
}
export function readDefinitions(ws) {
  const doc = readJsonBounded(definitionsPath(ws), { version: 1, jobs: {} }, "definitions").value;
  if (doc.jobs && typeof doc.jobs === "object" && !Array.isArray(doc.jobs)) {
    for (const [id, def] of Object.entries(doc.jobs)) {
      if (!def || typeof def !== "object" || Array.isArray(def) || def.runtime === undefined) continue;
      noteRuntimeName(`schedule ${id} in ${definitionsPath(ws)} (its next save records harness)`);
      if (def.harness === undefined) { const { runtime, ...rest } = def; doc.jobs[id] = { ...rest, harness: runtime }; }
      else if (def.harness === def.runtime) { const { runtime, ...rest } = def; void runtime; doc.jobs[id] = rest; }
    }
  }
  if (![1, 2].includes(doc.version) || typeof doc.jobs !== "object" || doc.jobs === null || Array.isArray(doc.jobs)) throw scheduleError("E_SCHEDULE_INVALID", `${definitionsPath(ws)} must be {version: 1|2, jobs: {}}`, { field: "file" });
  return doc;
}
export function writeDefinitions(ws, doc) { writeJson(definitionsPath(ws), doc); }
export function readState(ws) { const st = readJsonBounded(statePath(ws), { jobs: {} }, "state").value; if (!st.jobs || typeof st.jobs !== "object") st.jobs = {}; return st; }
/** Integrity facts for a scope's two files, without throwing. */
export function scheduleIntegrity(ws) {
  const sources = [];
  for (const [path, label, fallback] of [[definitionsPath(ws), "definitions", { version: 1, jobs: {} }], [statePath(ws), "state", { jobs: {} }]]) {
    try { sources.push(readJsonBounded(path, fallback, label).source); }
    catch (e) { sources.push(e.source ?? { path: label, status: "refused", bytes: 0 }); }
  }
  return { sources };
}
/** K8 — bounded run history. Every time a job's lastRun reaches a settled
 *  outcome (not "active"/"starting"), it is appended once to `recentRuns`
 *  (newest first, max 50), keyed by scheduledFor+startedAt so re-saves of the
 *  same run never duplicate it. Recording happens on save: producers keep
 *  writing lastRun exactly as they do; nothing is inferred. */
export const RECENT_RUNS_MAX = 50;
/** K8b — a run's identity is WHEN it was scheduled and started (plus the
 *  attempt id when one exists), never its outcome: unknown→ended is one run
 *  with two transitions, not two rows. */
export function runIdOf(lr) {
  if (!lr || typeof lr !== "object" || (!lr.scheduledFor && !lr.startedAt)) return null;
  return createHash("sha256").update(`${lr.scheduledFor ?? ""}|${lr.startedAt ?? ""}|${lr.execution?.attemptId ?? lr.attemptId ?? ""}`).digest("hex").slice(0, 24);
}
const SETTLED_OUTCOMES = new Set(["ended", "stopped", "delivered", "skipped", "blocked", "invalid", "failed", "unknown", "refused", "completed"]);
function recordRecentRuns(st, now = new Date()) {
  for (const js of Object.values(st.jobs || {})) {
    const lr = js.lastRun;
    if (!lr || typeof lr !== "object" || ["active", "starting"].includes(lr.outcome)) continue;
    const runId = runIdOf(lr); if (!runId) continue;
    js.recentRuns ||= [];
    const settled = SETTLED_OUTCOMES.has(lr.outcome) && lr.pending !== true;
    const existing = js.recentRuns.find((r) => r.runId === runId);
    if (existing) {
      // same run, later facts: update in place, keep the outcome sequence
      const prev = existing.outcome;
      // Object.assign removes nothing: a run that is no longer held leaves no hold on its row.
      if (existing.held && !lr.held) { delete existing.held; delete existing.reason; }
      Object.assign(existing, lr, { runId, settled, recordedAt: now.toISOString() });
      existing.transitions = [...(existing.transitions || [prev]), ...(prev !== lr.outcome ? [lr.outcome] : [])];
      continue;
    }
    // legacy rows (pre-K8b, keyed by outcome) are left as they are: never merged, reported as legacy
    js.recentRuns.unshift({ runId, ...lr, settled, recordedAt: now.toISOString(), transitions: [lr.outcome] });
    if (js.recentRuns.length > RECENT_RUNS_MAX) js.recentRuns.length = RECENT_RUNS_MAX;
  }
}
export function writeState(ws, st) { recordRecentRuns(st); writeJson(statePath(ws), st); }

// ------------------------------------------------------- host registry

const DEFAULT_MAX_CONCURRENT = 5;
const scheduleCap = (reg) => reg.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;

/** Decode a bounded atomic-file snapshot without locks or filesystem writes. */
function readRegistryDocument() {
  const path = join(hostScheduleDir(), "registry.json");
  const reg = readJsonBounded(path, { version: 1, capsVersion: 2, tickIntervalSec: 60, workspaces: [] }, "registry.json", { atomicReplace: true }).value;
  if (!reg || typeof reg !== "object" || Array.isArray(reg)) throw scheduleError("E_SCHEDULE_INVALID", `${path} must contain a registry object`, { field: "file" });
  return reg;
}
const validCap = (value) => Number.isSafeInteger(value) && value >= 1;
/** Project legacy defaults in memory. Only locked mutations persist this. */
function normalizeRegistry(reg) {
  const path = join(hostScheduleDir(), "registry.json");
  if (!Array.isArray(reg.workspaces)) reg.workspaces = [];
  if (reg.maxConcurrent !== undefined && !validCap(reg.maxConcurrent)) {
    throw scheduleError("E_SCHEDULE_INVALID", `${path}: maxConcurrent must be a positive safe integer, or absent for the default (got ${JSON.stringify(reg.maxConcurrent)}); correct it with oats schedule host install --max-concurrent <N|default> --dir <deployment>`, { field: "maxConcurrent" });
  }
  if (!Number.isInteger(reg.tickIntervalSec) || reg.tickIntervalSec < 60) reg.tickIntervalSec = 60;
  // Trigger and schedule caps are independent; absent trigger cap is unbounded.
  if (reg.triggersMaxConcurrent !== undefined && !validCap(reg.triggersMaxConcurrent)) {
    throw scheduleError("E_SCHEDULE_INVALID", `${path}: triggersMaxConcurrent must be a positive integer, or absent for no host cap (got ${JSON.stringify(reg.triggersMaxConcurrent)})`, { field: "triggersMaxConcurrent" });
  }
  if ((reg.capsVersion ?? 1) < 2) {
    if (reg.maxConcurrent === 1) delete reg.maxConcurrent;
    reg.capsVersion = 2;
  }
  return reg;
}
export function readRegistry() { return normalizeRegistry(readRegistryDocument()); }
/** Raw atomic write: no normalization or locking. Read-modify-write callers
 * must hold registry.lock and reread there; readers never persist migration. */
export function writeRegistry(reg) { writeJson(join(hostScheduleDir(), "registry.json"), reg); }
function updateRegistry(change, caps = {}) {
  return withRegistryLock(() => {
    const raw = readRegistryDocument(), before = JSON.stringify(raw);
    const legacyOne = (raw.capsVersion ?? 1) < 2 && raw.maxConcurrent === 1;
    // A validated explicit replacement can repair an invalid stored schedule
    // cap; an ordinary read or unrelated write must refuse it, never default.
    if (caps.maxConcurrent !== undefined && !validCap(raw.maxConcurrent)) delete raw.maxConcurrent;
    const reg = normalizeRegistry(raw);
    for (const [field, reset] of [["maxConcurrent", "default"], ["triggersMaxConcurrent", "none"]]) {
      if (caps[field] === reset) delete reg[field];
      else if (caps[field] !== undefined) reg[field] = caps[field];
    }
    change(reg);
    // Compare with the raw snapshot so even unchanged membership persists the
    // migration, without a separate write or a stale pre-lock read.
    if (JSON.stringify(reg) !== before) {
      writeRegistry(reg);
      if (legacyOne && (caps.maxConcurrent === undefined || caps.maxConcurrent === "default")) {
        process.stderr.write("oats: warning: migrated legacy maxConcurrent: 1 to the default of 5; an old explicit 1 cannot be distinguished from the old implicit default. To restore one slot, run oats schedule host install --max-concurrent 1 --dir <deployment>. Stop older oats binaries from writing this shared registry.\n");
      }
    }
    return reg;
  });
}
export function registerWorkspace(ws, caps = {}) {
  for (const [field, reset] of [["maxConcurrent", "default"], ["triggersMaxConcurrent", "none"]]) {
    const value = caps[field];
    if (value !== undefined && value !== reset && !validCap(value)) {
      throw scheduleError("E_BAD_ARGS", `${field} must be a positive safe integer or ${reset}`, { field });
    }
  }
  return updateRegistry((reg) => { const abs = resolve(ws); if (!reg.workspaces.includes(abs)) reg.workspaces.push(abs); }, caps);
}
export function unregisterWorkspace(ws) { return updateRegistry((reg) => { reg.workspaces = reg.workspaces.filter((w) => w !== resolve(ws)); }); }
export function readHostState() { return readJson(join(hostScheduleDir(), "state.json"), {}); }
export function writeHostState(st) { writeJson(join(hostScheduleDir(), "state.json"), st); }

// ---------------------------------------------------------------- locks

/** Schedule locks (lib/dir-lock.mjs): a holder still running after the retry is E_SCHEDULER_BUSY, and so is
 *  a lock that cannot be judged; one left by a process that is gone is taken over. `dir` is the lock's file. */
function withDirLock(dir, what, fn, { retryMs = 0 } = {}) {
  return withSharedDirLock(dir, what, fn, { retryMs, busy: (why) => scheduleError("E_SCHEDULER_BUSY", `${what} is locked (${why}). If no oats schedule process is running, remove ${dir} and retry; nothing was changed.`) });
}
export function withHostLock(fn, { retryMs = 0 } = {}) { return withDirLock(join(hostScheduleDir(), "host.lock"), "the host scheduler", fn, { retryMs }); }
/** Registry read-modify-write is serialized on its own short lock. */
function withRegistryLock(fn) { return withDirLock(join(hostScheduleDir(), "registry.lock"), "the host schedule registry", fn, { retryMs: 3000 }); }
/** Definitions and state are read-modify-write; CRUD serializes here briefly. */
export function withScopeLock(ws, fn) { return withDirLock(join(stateDir(ws), "scope.lock"), `schedules of ${ws}`, fn, { retryMs: 3000 }); }

/** A job's slot: the directory `locks/<id>` and its record `owner.json`, which stands for the run
 *  that holds it until that run's instance ends (no process mutex: every taker and releaser holds
 *  the host lock, withHostLock). The slot is never there without its record. Its record is written
 *  in a directory beside the slots (slotStaging), which is then renamed to the slot; a release
 *  renames the slot back there before removing it. A taker or releaser killed at any step leaves
 *  either the slot with its record or no slot, and at most that directory, which the next taker or
 *  releaser of the slot removes. An entry already at the slot is held, whatever it is, and left as
 *  it is: a directory without its record (an earlier kernel made the directory first) reads as
 *  unreadable (jobLockInfo). */
const slotStaging = (ws, id) => join(stateDir(ws), `.slot-${id}`);
export function acquireJobLock(ws, id, owner) {
  const dir = lockDir(ws, id), staging = slotStaging(ws, id);
  mkdirSync(dirname(dir), { recursive: true });
  try { lstatSync(dir); return false; } catch (e) { if (e.code !== "ENOENT") throw e; }
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging);
  try {
    writeFileSync(join(staging, "owner.json"), JSON.stringify({ ...owner, pid: process.pid, at: new Date().toISOString() }, null, 2) + "\n");
    renameSync(staging, dir);
  } catch (e) {
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* the next taker of the slot removes it */ }
    throw e;
  }
  return true;
}
export function jobLockInfo(ws, id) {
  const dir = lockDir(ws, id);
  if (!existsSync(dir)) return null;
  try { return JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")); } catch { return { unreadable: true }; }
}
/** `oats doctor`'s problem for a job's slot whose record cannot be read. */
export const SCHEDULE_SLOT_UNREADABLE = "schedule-slot-unreadable";
/** A schedule's id as a person types it, from the key its state and slot are stored under: a
 *  workspace schedule's key is <member>~<id> (scheduleStateKey), a local one is its id. */
const shownScheduleId = (key) => key.replace("~", "/");
/** The slot of the job `key` in `ws` when its record cannot be read (jobLockInfo: a directory
 *  without its record, a record that does not parse, an entry that is no directory) → `{ said,
 *  remedy }`, the words the tick, reconcile, run-now and doctor give for it; else null. Nobody
 *  can tell from such a slot whether the run it stands for still runs, so it is held and left as
 *  it is until a person has checked and reconcile --clear releases it. `dir` is the `--dir`
 *  argument the commands of the remedy need from another deployment; `defined` false is a slot
 *  whose schedule is not defined, which no tick reads and only reconcile --clear releases. */
function unreadableSlot(ws, key, dir = "", { defined = true } = {}) {
  if (!jobLockInfo(ws, key)?.unreadable) return null;
  const id = shownScheduleId(key), release = `run oats schedule reconcile ${id} --clear${dir} to release the slot`;
  if (!defined) return { said: `the slot ${lockDir(ws, key)} of schedule ${id}, which is not defined, has no readable record`, remedy: `once no run of schedule ${id} is running (oats status lists the instances it started), ${release}` };
  return { said: `the slot ${lockDir(ws, key)} has no readable record`, remedy: `check oats schedule show ${id}${dir}; once its last run is not running, ${release}` };
}
/** Whether `key` names an entry directly among a scope's slots (lockDir), and nothing beyond them. */
const slotName = (key) => typeof key === "string" && key !== "" && key !== "." && key !== ".." && !/[/\\\0]/.test(key);
export function releaseJobLock(ws, id) {
  const staging = slotStaging(ws, id);
  rmSync(staging, { recursive: true, force: true });
  try { renameSync(lockDir(ws, id), staging); } catch (e) { if (e.code === "ENOENT") return; throw e; }
  // The slot is released once it is renamed: what could not be removed of it is removed by the
  // next taker or releaser of the slot.
  try { rmSync(staging, { recursive: true, force: true }); } catch { /* removed next time */ }
}
function liveLocks(wsList) {
  let n = 0;
  for (const ws of wsList) {
    const dir = join(stateDir(ws), "locks");
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) n++;
  }
  return n;
}

// ------------------------------------------------------------ validation

function inside(ws, p) { return (resolve(p) + sep).startsWith(resolve(ws) + sep); }
export function validateCron(cron, tz, field = "cron") {
  if (typeof cron !== "string" || cron.trim().split(/\s+/).length !== 5) throw scheduleError("E_SCHEDULE_INVALID", `${field}: five fields required (minute hour day month weekday)`, { field });
  if (typeof tz !== "string" || !tz.trim()) throw scheduleError("E_SCHEDULE_INVALID", "tz: an explicit IANA time zone is required", { field: "tz" });
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { throw scheduleError("E_SCHEDULE_INVALID", `tz: unknown time zone ${JSON.stringify(tz)}`, { field: "tz" }); }
  try { return new Cron(cron.trim(), { timezone: tz, paused: true }); }
  catch (e) { throw scheduleError("E_SCHEDULE_INVALID", `${field}: ${e.message}`, { field }); }
}
function validateMessage(message, field) {
  if (typeof message !== "string" || !message.trim() || message.includes("\0") || Buffer.byteLength(message) > MESSAGE_MAX) throw scheduleError("E_SCHEDULE_INVALID", `${field}: non-empty text without NUL, at most 256 KiB`, { field });
}

/** The refusal of a spawn job's `backend: herdr` (Herdr was removed in 0.31.0): `where` names the
 *  file and key that set it. */
export function herdrBackendRefusal(where) { return Object.assign(herdrSettingRemoved(`${where}: herdr`), { field: "backend" }); }
/** A stored local spawn job that selects Herdr: its refusal, naming this scope's definitions file. */
function storedHerdrBackend(ws, id, def) {
  return def?.kind === "spawn" && !def.workspace && def.backend === "herdr" ? herdrBackendRefusal(`${definitionsPath(ws)} sets jobs.${id}.backend`) : null;
}

/** Validate and normalize one definition against its scope. `backendSource` names the file and key
 *  a definition read from elsewhere sets its backend in (default: this scope's definitions file). */
export function validateDefinition(ws, def, { checkAgent = true, backendSource, io } = {}) {
  if (!def || typeof def !== "object" || Array.isArray(def)) throw scheduleError("E_SCHEDULE_INVALID", "definition must be an object", { field: "definition" });
  if (def.kind === "trigger") throw scheduleError("E_SCHEDULE_INVALID", "kind: a trigger is added with `oats trigger add`, not `oats schedule add`", { field: "kind" });
  const id = def.id;
  if (typeof id !== "string" || !ID_RE.test(id)) throw scheduleError("E_SCHEDULE_INVALID", "id: lowercase letters, digits and dashes, 1 to 100 characters", { field: "id" });
  const enabled = def.enabled === undefined ? true : def.enabled;
  if (typeof enabled !== "boolean") throw scheduleError("E_SCHEDULE_INVALID", "enabled: boolean", { field: "enabled" });
  validateCron(def.cron, def.tz);
  const out = { id, enabled, cron: def.cron.trim(), tz: def.tz.trim(), kind: def.kind };
  // A label for people (list, show, the Desktop), never read by a run (lib/automations.mjs).
  if (def.description !== undefined) out.description = validateDescription(def.description, "E_SCHEDULE_INVALID");
  if (def.kind === "spawn") {
    if (typeof def.agent !== "string" || !def.agent.trim() || def.agent.trim().startsWith("-")) throw scheduleError("E_SCHEDULE_INVALID", "agent: soul name required (not an option)", { field: "agent" });
    out.agent = def.agent.trim();
    if (def.agentsRoot !== undefined) {
      const known = scopeRoots(ws);
      if (typeof def.agentsRoot !== "string" || !isAbsolute(def.agentsRoot) || !inside(ws, def.agentsRoot) || !known.includes(resolve(def.agentsRoot))) throw scheduleError("E_SCHEDULE_INVALID", `agentsRoot: must be one of this scope's agents roots (${known.join(", ") || "none"})`, { field: "agentsRoot" });
      out.agentsRoot = resolve(def.agentsRoot);
    }
    if (def.repo !== undefined) { if (typeof def.repo !== "string" || !def.repo.trim() || def.repo.startsWith("-")) throw scheduleError("E_SCHEDULE_INVALID", "repo: the work repository path, as oats spawn --repo", { field: "repo" }); out.repo = def.repo; }
    if (def.backend === "herdr") throw herdrBackendRefusal(backendSource ?? `${definitionsPath(ws)} sets jobs.${id}.backend`);
    if (def.backend !== undefined) { if (def.backend !== "tmux") throw scheduleError("E_SCHEDULE_INVALID", "backend: tmux", { field: "backend" }); out.backend = def.backend; }
    if (def.purpose !== undefined) { if (typeof def.purpose !== "string" || !/^[a-z0-9-]{1,40}$/.test(def.purpose)) throw scheduleError("E_SCHEDULE_INVALID", "purpose: lowercase letters, digits and dashes", { field: "purpose" }); out.purpose = def.purpose; }
    // A run spawns <agent>-<purpose|id>-<YYYYMMDDHHMM>; instance names are at most
    // MAX_INSTANCE_NAME characters, so refuse here what would fail at every firing.
    { const stem = out.purpose ?? id, derived = `${out.agent}-${stem}-${"0".repeat(12)}`;
      if (derived.length > MAX_INSTANCE_NAME) throw scheduleError("E_SCHEDULE_INVALID", `${out.purpose !== undefined ? "purpose" : "id"}: runs would be named ${out.agent}-${stem}-<YYYYMMDDHHMM> (${derived.length} characters); instance names are at most ${MAX_INSTANCE_NAME} characters — shorten the ${out.purpose !== undefined ? "purpose" : "schedule id (or set a shorter purpose)"}`, { field: out.purpose !== undefined ? "purpose" : "id" }); }
    if (typeof def.task !== "string" || !def.task.trim()) throw scheduleError("E_SCHEDULE_INVALID", "task: non-empty text", { field: "task" });
    out.task = def.task;
    if (def.runtime !== undefined) {
      if (def.harness !== undefined && def.harness !== def.runtime) throw scheduleError("E_SCHEDULE_INVALID", HARNESS_CONFLICT, { field: "runtime" });
      noteRuntimeName(`schedule ${id}: runtime (written as harness)`);
      def = { ...def, harness: def.runtime };
    }
    if (def.launchConfig !== undefined) { if (typeof def.launchConfig !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(def.launchConfig)) throw scheduleError("E_SCHEDULE_INVALID", "launchConfig: the name of a launch configuration on the running host (oats-local.yaml launch-configs)", { field: "launchConfig" }); out.launchConfig = def.launchConfig; }
    if (def.harness !== undefined) { if (!HARNESSES.has(def.harness)) throw scheduleError("E_SCHEDULE_INVALID", "harness: pi, claude or codex", { field: "harness" }); out.harness = def.harness; }
    if (def.model !== undefined) { if (typeof def.model !== "string" || !MODEL_RE.test(def.model)) throw scheduleError("E_SCHEDULE_INVALID", "model: a model id: a letter or digit, then letters, digits and . _ : / @ + - [ ] (at most 128 characters)", { field: "model" }); out.model = def.model; }
    if (def.yolo !== undefined) { if (typeof def.yolo !== "boolean") throw scheduleError("E_SCHEDULE_INVALID", "yolo: boolean", { field: "yolo" }); out.yolo = def.yolo; }
    if (def.wake !== undefined) {
      const w = def.wake;
      if (!w || typeof w !== "object") throw scheduleError("E_SCHEDULE_INVALID", "wake: {cron, tz, message}", { field: "wake" });
      validateCron(w.cron, w.tz, "wake.cron"); validateMessage(w.message, "wake.message");
      out.wake = { cron: w.cron.trim(), tz: w.tz.trim(), message: w.message };
    }
    if (checkAgent) confirmScheduledSoul(ws, out, io);
  } else if (def.kind === "command") {
    if (typeof def.cwd !== "string" || !isAbsolute(def.cwd) || !inside(ws, def.cwd) || !existsSync(def.cwd)) throw scheduleError("E_SCHEDULE_INVALID", "cwd: an existing absolute directory inside the scope", { field: "cwd" });
    if (!Array.isArray(def.argv) || !def.argv.length || def.argv.some((a) => typeof a !== "string" || a.includes("\0")) || def.argv[0] !== "oats") throw scheduleError("E_SCHEDULE_INVALID", "argv: oats-only argument list starting with \"oats\"", { field: "argv" });
    if (def.argv[1] === "schedule") throw scheduleError("E_SCHEDULE_INVALID", "argv: a command job may not run oats schedule (it would wait on the host lock the tick holds)", { field: "argv" });
    const selector = def.argv.slice(1, def.argv.includes("--") ? def.argv.indexOf("--") : undefined).find((a) => /^--(deployment|resolution|artifact-set)(=|$)/.test(a));
    if (selector) throw scheduleError("E_SCHEDULE_INVALID", `argv: ${selector.split("=")[0]} is a captured selector (the captured/portable path was removed in 0.26) — the job would be refused at every firing`, { field: "argv" });
    out.cwd = resolve(def.cwd); out.argv = [...def.argv];
  } else if (def.kind === "wake") {
    if (typeof def.home !== "string" || !isAbsolute(def.home) || !inside(ws, def.home) || !existsSync(join(def.home, "instance.json"))) throw scheduleError("E_SCHEDULE_INVALID", "home: an existing instance home inside the scope", { field: "home" });
    validateMessage(def.message, "message");
    out.home = resolve(def.home); out.message = def.message;
  } else if (def.kind === "operation") {
    // A provider operation in a running home, resolved when the job runs
    // (oats operation run <layer>:<name> --home): the provider is whatever
    // fills that layer for the home then; nothing about it is stored here.
    if (typeof def.operation !== "string" || !/^(knowledge|messaging|tasks):[a-z][a-z0-9-]*$/.test(def.operation)) throw scheduleError("E_SCHEDULE_INVALID", "operation: <layer>:<name>, e.g. knowledge:harvest", { field: "operation" });
    if (typeof def.home !== "string" || !isAbsolute(def.home) || !inside(ws, def.home) || !existsSync(join(def.home, "instance.json"))) throw scheduleError("E_SCHEDULE_INVALID", "home: an existing instance home inside the scope", { field: "home" });
    out.operation = def.operation; out.home = resolve(def.home);
  } else throw scheduleError("E_SCHEDULE_INVALID", "kind: spawn, command, wake or operation", { field: "kind" });
  // Captured (versioned) schedules were removed in 0.26 (lead decisions on (e), D4).
  const captured = CAPTURED_SCHEDULE_KEYS.filter((key) => def[key] !== undefined);
  if (captured.length) throw scheduleError("E_SCHEDULE_INVALID", `${captured.join(", ")}: ${CAPTURED_SCHEDULE_REMOVED}`, { field: captured[0] });
  return out;
}

/** The filesystem-safe key a workspace schedule is stored under in the local run state (job locks
 *  are directories named by it): `<member>~<id>`. Repository names never carry `~`; local ids
 *  (SCHEDULE_ID_RE) never do either. */
export const scheduleStateKey = (qid) => String(qid).replace("/", "~");
/** The jobs a tick, run or reconcile works on: the deployment's local jobs (stored under their
 *  bare id) and, from the automations context (its `schedules`), the workspace schedules THIS host runs (stored
 *  under scheduleStateKey(<member>/<id>), a filesystem-safe key: job locks are directories). */
export function effectiveDefinitions(ws, ctx) {
  const defs = readDefinitions(ws);
  for (const a of ctx?.schedules || []) {
    if (!a.placement.runsHere) continue;
    const key = scheduleStateKey(a.id);
    defs.jobs[key] = { ...a.definition, id: key, enabled: true, purpose: a.definition.purpose ?? a.name, workspace: { qid: a.id, name: a.name, member: a.member, origin: a.origin, runsOn: a.runsOn, owner: a.owner } };
  }
  return defs;
}
/** The stored key of a schedule argument (`local/<id>`, a bare local id, or `<member>/<id>`). */
export function scheduleKeyOf(id) { const { scope, name } = splitId(id); return scope === "local" ? name : scheduleStateKey(`${scope}/${name}`); }
/** A workspace schedule file (0.29.0; the shared header is lib/automations.mjs's):
 *  `oats-schedules/<id>.yaml` or `*.oats-schedule.yaml`, `kind: oats-schedule`. Its body is the
 *  run (`run: spawn | command`, cron, tz, …); a wake or an operation targets an instance home on
 *  one machine and stays local. `expand` checks it against the deployment `dep`. */
export function scheduleKind({ dep = null } = {}) {
  return {
    kind: "schedule", folder: "oats-schedules", suffix: "oats-schedule", fileKind: "oats-schedule",
    bodyKeys: ["run", "cron", "tz", "agent", "task", "purpose", "launchConfig", "harness", "model", "yolo", "backend", "wake", "argv", "cwd"],
    parseBody: (body) => {
      const bad = (message) => Object.assign(new Error(message), { field: "run" });
      const { run = "spawn", ...rest } = body;
      if (run === "wake" || run === "operation") throw bad(`run: ${run} targets an instance home on one machine; declare it locally (oats schedule add), not in Git`);
      if (run !== "spawn" && run !== "command") throw bad("run: spawn or command");
      return { definition: { ...rest, kind: run } };
    },
    expand: (a) => validateWorkspaceSchedule(dep, a),
  };
}
/** A workspace schedule, as a validated kernel definition for the snapshot: the file's run facts
 *  checked like `oats schedule add` (the soul is resolved when it runs, through discovery); a
 *  command's cwd is relative to the deployment. */
export function validateWorkspaceSchedule(dep, a) {
  const d = a.source?.definition || {};
  const spec = { ...d, id: a.name, enabled: true };
  if (spec.kind === "command") {
    if (d.cwd !== undefined && (typeof d.cwd !== "string" || isAbsolute(d.cwd))) throw scheduleError("E_SCHEDULE_INVALID", "cwd: a directory relative to the deployment (a workspace schedule never names a machine path)", { field: "cwd" });
    spec.cwd = resolve(dep, d.cwd ?? ".");
    // Inside the deployment, `..` and symlinks included (re-review B #4): Git content never picks a
    // directory elsewhere on the host.
    const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
    if (!inside(real(dep), real(spec.cwd))) throw scheduleError("E_SCHEDULE_INVALID", `cwd: ${JSON.stringify(d.cwd)} leaves the deployment; a workspace command's cwd is a directory inside it`, { field: "cwd" });
  }
  const out = validateDefinition(dep, spec, { checkAgent: false, backendSource: `${a.origin?.path ?? a.name} sets backend` });
  delete out.enabled;
  return out;
}

/** The soul a spawn job launches, under the deployment's one agents root
 *  (a definition's agentsRoot, when given, must be that root). `repo` is the
 *  work repository and never selects a soul. Every spawn job names its soul as
 *  `oats spawn <soul>` does: the spawn resolves it through discovery (a member or
 *  package soul), whether or not this deployment has spawned it before; the
 *  agents/<soul>/soul copy is only spawn's per-commit cache. A local job still
 *  passes --agents-root (spawn checks it is its root). */
export function resolveScheduledAgent(ws, def) {
  const [root] = scopeRoots(ws);
  if (def.workspace) return { root, agent: { name: def.agent }, discover: true };
  if (def.agentsRoot && resolve(def.agentsRoot) !== root) throw scheduleError("E_SCHEDULE_INVALID", `agentsRoot: ${def.agentsRoot} is not this deployment's agents root (${root})`, { field: "agentsRoot" });
  return { root, agent: { name: def.agent } };
}
/** The save-time check of a local spawn job's soul (`add`, `update`): refuse what `oats spawn`
 *  would refuse. A soul already under the agents root is accepted without a child, so offline
 *  adds and stale cached souls stay accepted; any other name goes through spawn's own preview,
 *  with the job's selectors (a selector the run needs, such as its repo, would otherwise fail
 *  the preview's checks). */
function confirmScheduledSoul(ws, def, io) {
  const { root, discover } = resolveScheduledAgent(ws, def);
  if (findAgent(root, def.agent)) return;
  try { spawnPreview(ws, def, { root, discover }, io); }
  catch (e) {
    if (e.unconfirmed) throw scheduleError("E_SCHEDULE_INVALID", `agent: soul ${JSON.stringify(def.agent)} could not be confirmed: ${e.message}`, { field: "agent" });
    if (e.refusal) throw scheduleError("E_SCHEDULE_INVALID", `agent: ${e.message}`, { field: "agent", details: { code: e.code } });
    throw e;
  }
}

// ----------------------------------------------------------------- time

export function minuteStart(now) { return new Date(Math.floor(now.getTime() / 60000) * 60000); }
export function minuteKey(date) { return date.toISOString().slice(0, 16); }
export function cronOf(def) { return new Cron(def.cron, { timezone: def.tz, paused: true }); }
export function nextRunAfter(def, from) { const n = cronOf(def).nextRun(from); return n ? n.toISOString() : null; }
/** Due exactly at this minute: the first run after (minute - 1 s) is this minute. */
export function dueAt(def, minute) { const n = cronOf(def).nextRun(new Date(minute.getTime() - 1000)); return !!n && n.getTime() === minute.getTime(); }
export function purposeSuffix(minute) { return minute.toISOString().slice(0, 16).replace(/[-T:]/g, ""); }
/** Ordering key for admission: when this job last launched a harness. */
export function launchOrderKey(js) { return String(js?.lastLaunchedAt || ""); }

// ---------------------------------------------------------- observation

/** What a run's instance looks like now. Home gone = ended; a home that is
 *  retiring is still there (its harness may be alive pending teardown) and
 *  keeps its slot; present but no running harness = stopped (needs
 *  attention, never removed), and so is one whose recorded tmux server is
 *  gone (sessionServerGone: after a reboot or a crash); running = active;
 *  not inspectable = unknown. */
export function observeHome(home, io) {
  if (!home) return { outcome: "launched" };
  if (!existsSync(home)) return { outcome: "ended" };
  const retiring = existsSync(retirePendingMarkerPath(home));
  try {
    const s = (io?.inspect || inspectInstanceSession)(home);
    if (s.present && s.state !== "shell") return { outcome: "active", ...(retiring ? { note: "retiring" } : {}) };
    if (retiring) return { outcome: "active", note: "retiring: home present, teardown pending" };
    // A shell right after `session start` is that launch's startup phase
    // until its wrapper writes the exit marker for the launch id; only then
    // (or with no start receipt at all) is a shell a finished harness.
    if (s.present && s.state === "shell" && startupInProgress(home)) return { outcome: "starting" };
    return { outcome: "stopped" };
  } catch (e) {
    const lost = sessionServerGone(home, e.cause);
    if (lost.gone) return { outcome: "stopped", note: "its tmux server is gone" };
    return { outcome: "unknown", error: lost.why ? `cannot inspect session: ${lost.why}` : e.message };
  }
}
function startupInProgress(home) {
  const pendingPath = join(home, ".oats-start-pending.json");
  if (!existsSync(pendingPath)) return false;
  let pending; try { pending = JSON.parse(readFileSync(pendingPath, "utf8")); } catch { return true; }
  // The exit marker in either form (lib/session-end.mjs): the legacy start id, or {startId, status}.
  return readStartExited(home)?.startId !== String(pending?.id);
}

/** All homes for an instance name across the scope's roster (every known
 *  agents root). */
export function findHomesInScope(ws, instance) {
  const homes = new Set();
  for (const root of scopeRoots(ws)) {
    try { for (const h of findInstanceHomes(root, instance)) homes.add(resolve(h.home || h)); } catch { /* unreadable root */ }
    // Durable homes remain discoverable after their source soul definition is
    // removed. The live-soul index is a convenience, never reconciliation
    // authority for an already admitted execution.
    if (existsSync(root)) for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const h = join(root, e.name, "instances", instance);
      if (existsSync(join(h, "instance.json"))) homes.add(resolve(h));
    }
  }
  return [...homes];
}
// --------------------------------------------------------------- runner

function scheduleBlock(def, minute) {
  return `\n\n## Scheduled run\n\nThis instance was launched by OATS schedule "${def.workspace?.qid ?? def.id}" for ${minute.toISOString()} (cron "${def.cron}" in ${def.tz}). It is disposable: finish the task above, bring your memory files up to date, and end with \`oats retire --self\`.\n`;
}
/** The deployment a spawn job runs in (module contract §5, decision 7): the
 *  scope's oats-local.yaml. An unreadable one is reported (E_WORKSPACE_SCHEMA)
 *  by the spawn, never answered some other way. */
export function workspaceSpawnContext(ws) {
  try { const found = loadLocal(ws); return { kind: "local", local: found.path, dir: dirname(found.path) }; }
  catch (e) { return { kind: "local", local: null, dir: ws, error: { code: e.code || "E_WORKSPACE_SCHEMA", message: e.message } }; }
}
/** The `oats spawn` selectors a spawn job's run passes (beside its purpose, task and launch
 *  flags), so a preview checks what the run will: one builder for the run and its previews.
 *  Every value travels as ONE `--flag=value` token. */
function spawnSelectorArgs(opts) {
  const argv = [];
  if (opts.launchConfig) argv.push(`--launch-config=${opts.launchConfig}`);
  if (opts.harness) argv.push(`--harness=${opts.harness}`);
  if (opts.model) argv.push(`--model=${opts.model}`);
  if (opts.backend) argv.push(`--backend=${opts.backend}`);
  if (opts.repo) argv.push(`--repo=${opts.repo}`);
  return argv;
}
/** The kernel's own `oats spawn <agent> --preview --json` in the deployment, with the job's
 *  selectors (spawnSelectorArgs): what the run's spawn would resolve and refuse, written nowhere.
 *  Answers the preview's result; throws spawn's refusal (its code and message, `refusal: true`),
 *  an unconfirmed answer (`unconfirmed: true`: interrupted, timed out, no envelope), or the
 *  deployment's own error. */
function spawnPreview(ws, def, { root, discover }, io) {
  const context = workspaceSpawnContext(ws);
  if (context.error) throw scheduleError(context.error.code, context.error.message);
  if (String(def.agent).startsWith("-")) throw scheduleError("E_SCHEDULE_INVALID", `agent: ${JSON.stringify(def.agent)} is not a soul name`, { field: "agent" });
  const argv = ["spawn", def.agent, `--dir=${context.dir}`, ...(discover ? [] : [`--agents-root=${root}`]), "--preview", "--json", ...spawnSelectorArgs(def)];
  const r = runScheduleCommand(process.execPath, [io?.oatsBin || OATS_BIN, ...argv], { cwd: context.dir, timeout: io?.commandTimeoutMs || COMMAND_TIMEOUT_MS, graceMs: io?.commandGraceMs, maxBuffer: 16 * 1024 * 1024, env: childEnv() });
  const unconfirmed = (message) => scheduleError("E_SPAWN_FAILED", message, { unconfirmed: true });
  if (r.interrupted === true) throw unconfirmed("the spawn preview was interrupted; its result is unconfirmed");
  if (r.error?.code === "ETIMEDOUT" || (r.status === null && ["SIGTERM", "SIGKILL"].includes(r.signal))) throw unconfirmed("the spawn preview timed out; its result is unconfirmed");
  const envelope = parseEnvelopeText(r.stdout);
  if (!envelope || typeof envelope.ok !== "boolean") throw unconfirmed(`the spawn preview answered no valid envelope (exit ${r.status ?? r.signal})`);
  if (!envelope.ok) throw scheduleError(envelope.error?.code || "E_SPAWN_FAILED", String(envelope.error?.message || "spawn preview failed"), { refusal: true });
  return envelope.result;
}
/** A workspace spawn materializes EXACTLY like `oats spawn` — prepareInstance →
 *  ensureWorkspaceSoul → spawnInstanceAsync (resolve over the remotes, copy every
 *  module whole into the home, compose AGENTS.md from the modules' injects).
 *  That chain is asynchronous (it reads Git remotes); the tick chain is
 *  synchronous by design (one short-lived process under the host lock, no
 *  daemon). So the tick delegates to the kernel's own CLI as a child process,
 *  like a command job: `oats spawn <soul> --json …` in the deployment, and
 *  reads back the one JSON envelope. The child holds no host lock (a spawn
 *  takes only the scope lock, briefly, for a wake it saves — and the schedule
 *  passes no wake flags: the wake is saved here, from the run record).
 *  `io.oatsBin`, `io.commandTimeoutMs` and `io.noLaunch` are the test seams. */
function spawnViaCli(ws, root, agent, opts, context, io) {
  if (context.error) throw scheduleError(context.error.code, `this deployment realizes a workspace (${context.dir}) but its oats-local.yaml cannot be read: ${context.error.message}`);
  // Every value travels as ONE `--flag=value` token, so no value can be read as a flag of its own;
  // the soul is the one positional, and an option-shaped one is refused.
  if (String(agent.name).startsWith("-")) throw scheduleError("E_SCHEDULE_INVALID", `agent: ${JSON.stringify(agent.name)} is not a soul name`, { field: "agent" });
  const argv = ["spawn", agent.name, `--dir=${context.dir}`, ...(opts.discover ? [] : [`--agents-root=${root}`]), `--purpose=${opts.purpose}`, "--json", ...spawnSelectorArgs(opts)];
  if (opts.yolo === true) argv.push("--yolo"); else if (opts.yolo === false) argv.push("--no-yolo");
  if (opts.launch === false) argv.push("--no-launch");
  // The task is multi-line text of arbitrary size: it travels as a private file, never in argv.
  mkdirSync(join(stateDir(ws), "tasks"), { recursive: true });
  const taskFile = join(stateDir(ws), "tasks", `${opts.purpose}-${process.pid}.md`);
  writeFileSync(taskFile, opts.task, { mode: 0o600 });
  argv.push(`--task-file=${taskFile}`);
  let r;
  try { r = runScheduleCommand(process.execPath, [io?.oatsBin || OATS_BIN, ...argv], { cwd: context.dir, timeout: io?.commandTimeoutMs || COMMAND_TIMEOUT_MS, graceMs: io?.commandGraceMs, maxBuffer: 16 * 1024 * 1024, env: childEnv() }); }
  finally { try { rmSync(taskFile, { force: true }); } catch { /* best effort */ } }
  const interrupted = r.interrupted === true;
  const timedOut = r.error?.code === "ETIMEDOUT" || (!interrupted && r.status === null && ["SIGTERM", "SIGKILL"].includes(r.signal));
  const envelope = parseEnvelopeText(r.stdout);
  // The child may have created (and launched) a home before dying: unconfirmed, never a confirmed failure.
  // The thrown message reports RETAINED effects so the tick keeps the attempt and its slot for reconcile.
  if (interrupted) throw scheduleError("E_SPAWN_UNCONFIRMED", "workspace spawn was interrupted; its effects could not be confirmed (a home may have been created) — run oats schedule reconcile");
  if (timedOut) throw scheduleError("E_SPAWN_UNCONFIRMED", "workspace spawn timed out; its effects could not be confirmed (a home may have been created) — run oats schedule reconcile");
  if (!envelope || typeof envelope !== "object" || typeof envelope.ok !== "boolean") throw scheduleError("E_SPAWN_UNCONFIRMED", `workspace spawn answered no valid envelope (exit ${r.status ?? r.signal}); its effects could not be confirmed — run oats schedule reconcile${r.stderr ? `: ${String(r.stderr).trim().split("\n").pop()}` : ""}`);
  if (!envelope.ok) {
    const e = envelope.error || {};
    // E_SPAWN_INCOMPLETE: the kernel created a home it could not finish or roll back — retained effects.
    const retained = e.code === "E_SPAWN_INCOMPLETE" || e.details?.home;
    throw scheduleError(e.code || "E_SPAWN_FAILED", retained ? `${e.message} (home retained; effects unconfirmed)` : String(e.message || "spawn failed"), { details: e.details });
  }
  const res = envelope.result || {};
  return { instance: res.instance, home: res.home, launched: res.launched, materialized: "workspace", ...runWarnings(res) };
}
/** Launch one spawn job. `io.spawn(root, agent, opts)` overrides the whole
 *  launcher for tests. Otherwise the kernel's own `oats spawn` runs in the
 *  deployment (workspace materialization: `.oats/modules`, module skills and
 *  injects). */
/** A launch answer's warnings, for the run's record (feature schedule-run-warnings): present only when
 *  there are some. */
export function runWarnings(answer) {
  const w = Array.isArray(answer?.warnings) ? answer.warnings.filter((x) => typeof x === "string") : [];
  return w.length ? { warnings: w } : {};
}
/** A record updated in place by a later run keeps no earlier run's warnings. */
function withoutWarnings(record) {
  const { warnings: _w, ...rest } = record || {}; void _w;
  return rest;
}
/** A run after a hold carries neither of the hold's fields: a merge over the last record removes no key. */
function withoutHold(record) {
  if (!record?.held) return record;
  const { held: _h, reason: _r, ...rest } = record; void _h; void _r;
  return rest;
}
function launchSpawn(ws, def, minute, io) {
  const { root, agent, discover } = resolveScheduledAgent(ws, def);
  const purpose = `${def.purpose || def.id}-${purposeSuffix(minute)}`;
  const opts = { discover, task: def.task.trimEnd() + scheduleBlock(def, minute), purpose, launchConfig: def.launchConfig, harness: def.harness, model: def.model, yolo: def.yolo, backend: def.backend, repo: def.repo, launch: io?.noLaunch === true ? false : true };
  let r;
  if (io?.spawn) r = io.spawn(root, agent, opts);
  else r = spawnViaCli(ws, root, agent, opts, workspaceSpawnContext(ws), io);
  const run = { instance: r.instance, home: r.home, launched: !!r.instance, kind: "spawn", ...(r.materialized ? { materialized: r.materialized } : {}), ...runWarnings(r) };
  if (def.wake && r.home) {
    try { run.wakeSchedule = saveWakeForHome(ws, { instance: r.instance, home: r.home, wake: def.wake }); }
    catch (e) { run.wakeScheduleError = { code: e.code || "E_SCHEDULE_INVALID", message: e.message }; }
  }
  return run;
}
/** The command job an operation job becomes when it runs: the kernel's own
 *  operation runner in the home, which resolves the provider at that moment
 *  and reports a launch receipt (instance/home) only for what the provider
 *  launched, never for the source home. */
export function operationAsCommand(def) {
  return { ...def, kind: "command", cwd: def.home, argv: ["oats", "operation", "run", def.operation, "--home", def.home] };
}
/** Parse a command's stdout as one JSON document (remote output can be
 *  multi-line); fall back to the last {...} block; null when nothing parses. */
export function parseEnvelopeText(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* fall through */ }
  const i = s.lastIndexOf("\n{");
  if (i >= 0) { try { return JSON.parse(s.slice(i + 1)); } catch { /* fall through */ } }
  const j = s.indexOf("{");
  if (j >= 0) { try { return JSON.parse(s.slice(j)); } catch { /* give up */ } }
  return null;
}
/** Run one command job: oats-only argv in the job's cwd. A timeout or an
 *  unparseable answer means the side effects are unconfirmed: `unknown`,
 *  never `launch-failed`. An unconfirmed answer carries `exit` ({status,
 *  signal}) when the process's exit was observed. The supervisor sends SIGTERM
 *  at the timeout and SIGKILL after the grace, and observes the direct child's
 *  exit before returning. `io.command`, `io.oatsBin`, `io.commandTimeoutMs`
 *  and `io.commandGraceMs` are test seams; `io.command` counts as exited. */
function launchCommand(ws, def, io) {
  const argv = def.argv.includes("--json") ? def.argv.slice(1) : [...def.argv.slice(1), "--json"];
  let envelope, timedOut = false, interrupted = false, raw = "", exit;
  if (io?.command) { envelope = io.command({ cwd: def.cwd, argv }); exit = { status: null, signal: null }; }
  else {
    const r = runScheduleCommand(process.execPath, [io?.oatsBin || OATS_BIN, ...argv], { cwd: def.cwd, timeout: io?.commandTimeoutMs || COMMAND_TIMEOUT_MS, graceMs: io?.commandGraceMs, maxBuffer: 16 * 1024 * 1024, env: childEnv() });
    interrupted = r.interrupted === true;
    timedOut = r.error?.code === "ETIMEDOUT" || (!interrupted && r.status === null && ["SIGTERM", "SIGKILL"].includes(r.signal));
    if (r.status !== null || r.signal !== null) exit = { status: r.status, signal: r.signal };
    raw = String(r.stdout || "");
    envelope = parseEnvelopeText(raw);
  }
  const exited = exit ? { exit } : {};
  // No envelope, a malformed one, a timeout, or supervisor interruption: the process may still have
  // created a home. That is unconfirmed, never a confirmed failure.
  if (interrupted || timedOut || !envelope || typeof envelope !== "object" || typeof envelope.ok !== "boolean") return { kind: "command", launched: false, unconfirmed: true, ...exited, error: interrupted ? "command was interrupted; its side effects are unconfirmed" : timedOut ? "command timed out; its side effects are unconfirmed" : "command answered no valid envelope; its side effects are unconfirmed" };
  const res = envelope?.result || {};
  const instance = typeof res.instance === "string" ? res.instance : undefined;
  let home = typeof res.home === "string" ? res.home : undefined;
  if (instance && !home) { const found = findHomesInScope(ws, instance); if (found.length === 1) home = found[0]; }
  if (envelope.ok && instance && !home) return { kind: "command", launched: true, instance, unconfirmed: true, ...exited, error: `the envelope names instance ${instance} but no home for it is in this scope's roster; run oats schedule reconcile once it appears` };
  // A valid ok:false answer that reports an incomplete rollback (a harvest
  // spawn whose compensation could not stop or remove everything), or an
  // operation runner's unconfirmed outcome (timeout, no valid receipt, a
  // receipt contradicted by the exit status), is not a confirmed failure.
  // Whatever name the provider managed to answer travels in error.details
  // so reconcile can adopt it.
  if (!envelope.ok && (UNCONFIRMED_ERROR_CODES.has(envelope.error?.code) || envelope.error?.details?.unconfirmed === true || reportsRetainedEffects(envelope.error?.message))) {
    const partial = envelope.error?.details?.envelope?.result;
    const named = instance || (partial && typeof partial.instance === "string" ? partial.instance : undefined);
    return { kind: "command", launched: false, unconfirmed: true, ...exited, ...(named ? { instance: named } : {}), error: `command outcome unconfirmed: ${envelope.error?.message}`, errorCode: envelope.error?.code };
  }
  // Provenance the recorder has at write time: the answering server (remote
  // spawn) and the launched home's incarnation. Never a transcript.
  const server = typeof res.server === "string" ? res.server : undefined;
  return { kind: "command", launched: envelope.ok === true, ...(instance ? { instance } : {}), ...(home ? { home, incarnation: incarnationOfHome(home) } : {}), ...(server ? { server } : {}), ...(envelope.ok ? {} : { error: envelope.error?.message || "command failed", errorCode: envelope.error?.code }) };
}

/** A captured attempt or job lock left by 0.24–0.25 (the captured path, removed in
 *  0.26) is never run, adopted or released here: only removing its job clears it. */
const CAPTURED_ATTEMPT_REMOVED = "this job holds a captured schedule attempt (the captured/portable path was removed in 0.26); remove the job (oats schedule remove --force <id>)";
function validateAttemptExecution(attempt, lock) {
  if (attempt?.execution !== undefined || attempt?.schemaVersion !== undefined) throw scheduleError("migration-required", CAPTURED_ATTEMPT_REMOVED);
  if (lock?.executionId !== undefined) throw scheduleError("E_SCHEDULE_INVALID", `captured job lock: ${CAPTURED_ATTEMPT_REMOVED}`);
}
function validateActiveExecution(js, lock) {
  if (lock?.unreadable) throw scheduleError("E_SCHEDULE_INVALID", "job lock custody is unreadable");
  if (js.attempt) return validateAttemptExecution(js.attempt, lock);
  if (lock && (js.lastRun?.execution !== undefined || lock.executionId !== undefined)) validateAttemptExecution({ execution: js.lastRun?.execution }, lock);
}
/** One wake. `startIfStopped` false between due minutes (a harness that
 *  keeps exiting is not restarted every minute); `canStart` false when the
 *  host bound is reached (a new harness takes a slot; a delivery does not). */
/** A failure message that reports effects the kernel could not undo or
 *  confirm (spawn compensation's "rollback INCOMPLETE", a quarantined or
 *  retained home): the launch's effects are unconfirmed, never a confirmed
 *  failure. Shared by caught spawn errors and ok:false command envelopes. */
/** Error codes whose meaning is "the effects are unconfirmed" by contract. */
const UNCONFIRMED_ERROR_CODES = new Set(["E_OPERATION_TIMEOUT", "E_OPERATION_RESULT"]);
export function reportsRetainedEffects(message) { return /INCOMPLETE|quarantin|retain|could not (?:be )?(?:verif|confirm)/i.test(String(message || "")); }
/** A start refused at the home's lifecycle claim (lib/core.mjs startClaimed): before any effect,
 *  so no harness was allocated and the slot it reserved is free again. */
const claimRefused = (e) => e?.code === "E_LIFECYCLE_BUSY" || e?.code === "E_INSTANCE_RETIRING";
/** What a claim refusal of a start (claimRefused) established, in stable words, from its code and
 *  `details.holder` (lib/errors.mjs BUSY_HOLDERS): never that an act runs when that is not known. */
function claimRefusalSaid(e) {
  if (e.code === "E_INSTANCE_RETIRING") return "the home is being retired";
  const action = typeof e.details?.action === "string" ? e.details.action : null;
  if (e.details?.holder === "running") return `a ${action ?? "lifecycle act"} of the home is running`;
  if (e.details?.holder === "unknown") return action ? `a ${action} of the home may be running (its liveness cannot be read)` : "the home's lifecycle claim cannot be read";
  return "the home's lifecycle claim cannot be taken";
}
/** What holds this wake's keystroke now, read live at every attempt (lib/instance-events.mjs
 *  waitingHold). A read that throws holds as unreadable. `io.waitingHold` is the test seam. */
function wakeHeldBy(home, io) {
  try { return (io?.waitingHold || waitingHold)(home); }
  catch { return { claimReason: null, producer: null, unreadable: "the claims could not be read" }; }
}
function performWake(def, io, { startIfStopped = true, canStart = true, reserve, unreserve } = {}) {
  const seen = observeHome(def.home, io);
  if (seen.outcome === "ended") return { kind: "wake", action: "skipped", reason: "home is gone", pending: false };
  if (seen.outcome === "unknown") return { kind: "wake", action: "skipped", reason: `cannot observe the session: ${seen.error}`, pending: true };
  if (seen.outcome === "starting") return { kind: "wake", action: "skipped", reason: "session is starting; delivery pending", pending: true };
  if (seen.outcome === "stopped") {
    if (!startIfStopped) return { kind: "wake", action: "skipped", reason: "session stopped; it is started again only at the next due minute; delivery pending", pending: true };
    if (!canStart) return { kind: "wake", action: "skipped", reason: "host busy: starting this session needs a launch slot; delivery pending", pending: true };
    // The slot is persisted BEFORE the start call and kept on a start
    // exception: an error code does not prove nothing was allocated (core
    // can refuse while recording, after the session exists). The next
    // observation releases it once the harness is proven stopped or absent;
    // at worst a refused start occupies a slot for one tick. The exception is
    // a refusal at the home's lifecycle claim, which is before any effect by
    // contract: a skip, its slot released, retried at the next due minute.
    if (reserve && !reserve()) return { kind: "wake", action: "skipped", reason: "the job's slot is held by another process; delivery pending", pending: true };
    try {
      const r = (io?.start || startInstanceSession)(def.home);
      return { kind: "wake", action: "started", instance: r.instance, target: r.target, home: def.home, incarnation: incarnationOfHome(def.home), reason: "session was stopped; the message is pending until the session is active", pending: true, startedHarness: true, ...runWarnings(r) };
    } catch (e) {
      if (claimRefused(e)) {
        unreserve?.();
        return { kind: "wake", action: "skipped", reason: `start refused before any effect: ${claimRefusalSaid(e)} (${e.code}); the session is started again at the next due minute; delivery pending`, error: e.message, errorCode: e.code, pending: true };
      }
      return { kind: "wake", action: "skipped", reason: `start did not complete (${e.code || "error"}): ${e.message}; the slot is kept until the session is observed stopped or absent`, error: e.message, errorCode: e.code, pending: true, startedHarness: "unconfirmed" };
    }
  }
  // A hold waits as long as the claim lives: no expiry, and no key of any kind because it ran long.
  const held = wakeHeldBy(def.home, io);
  if (held) return { kind: "wake", action: "skipped", reason: "waiting-on-you", pending: true, held };
  try {
    const r = (io?.input || inputInstanceSession)(def.home, def.message);
    // Delivery custody: name the instance ONLY when the input result names it; the home's current incarnation at record time.
    return { kind: "wake", action: "delivered", pending: false, ...(typeof r?.instance === "string" ? { instance: r.instance } : {}), home: def.home, incarnation: incarnationOfHome(def.home) };
  }
  catch (e) { return { kind: "wake", action: "skipped", reason: `input refused: ${e.message}`, pending: true }; }
}

/** A held run as the tick records it: `held.since` is the first skip's time, kept on
 *  `js.pendingWake.heldSince` across ticks (the sites set and drop it), and the hold's start is one
 *  `wake-held` event, never a claim. A failed write doesn't change the hold (appendEvent never
 *  throws). A retiring home's row goes to the workspace log only: retirement fingerprints the home. */
function heldRun(id, def, js, run, now) {
  if (!run.held) return run;
  const since = js.pendingWake?.heldSince ?? now.toISOString();
  const held = { since, ...run.held };
  if (!js.pendingWake?.heldSince) appendEvent(def.home, { kind: "wake-held", data: { schedule: id, ...held } }, { workspaceOnly: existsSync(retirePendingMarkerPath(def.home)) });
  return { ...run, held };
}

// -------------------------------------------------------------- tick

/** Observe the previous run of one job. The tracked identity is what was
 *  launched (the lock's or lastRun's home), never the current definition,
 *  so an edit cannot make a slot forget its harness. A wake slot is held
 *  while its started harness is active, starting, unknown or retiring and
 *  released when that harness is proven stopped (the start receipt's exit
 *  marker) or its home is gone: a persistent home outliving its process
 *  does not keep a slot. Returns a spawn job's observed outcome, as it is
 *  recorded (a dry run records nothing), when its previous run is tracked. */
function observePrevious(ws, id, def, js, io, now, { mutate }) {
  // An invalid definition (a stored captured one included) is reported on its
  // job by the tick and never observed.
  if (shapeError(def)) return;
  const lock = jobLockInfo(ws, id);
  validateActiveExecution(js, lock); // No observation may erase invalid custody.
  if (js.attempt) return; // Unconfirmed effects need reconcile.
  const lr = js.lastRun;
  const home = def.kind === "wake" ? (lock?.home || lr?.home || def.home) : (lock?.home || lr?.home);
  const tracked = def.kind === "wake" ? !!lock : !!home && ["launched", "active", "starting", "stopped", "unknown"].includes(lr?.outcome);
  if (!tracked || !home) return;
  const seen = observeHome(home, io);
  const outcome = seen.outcome === "starting" ? "active" : seen.outcome;
  if (!mutate) return def.kind === "wake" ? undefined : outcome;
  if (def.kind === "wake") {
    if (seen.outcome === "ended" || seen.outcome === "stopped") {
      releaseJobLock(ws, id);
      if (seen.outcome === "ended") delete js.pendingWake;
      if (lr) js.lastRun = { ...lr, ...(seen.outcome === "ended" ? { endedAt: now.toISOString() } : { stoppedAt: now.toISOString() }), note: seen.outcome === "ended" ? "started harness ended" : "started harness stopped; slot released" };
    }
    return;
  }
  // An observation's error and note replace the previous observation's.
  const { error: _error, note: _note, ...run } = lr;
  js.lastRun = { ...run, outcome, ...(seen.error ? { error: seen.error } : {}), ...(seen.note ? { note: seen.note } : {}), ...(seen.outcome === "ended" ? { endedAt: now.toISOString() } : {}) };
  if (seen.outcome === "ended") releaseJobLock(ws, id);
  return outcome;
}
/** Why a due spawn job whose slot is held is skipped: the instance it
 *  launched (`outcome`, as observed) stopped, which needs a person, or it
 *  still runs. */
function heldSlotReason(js, outcome) {
  if (outcome !== "stopped") return "still running";
  const { instance, home } = js.lastRun;
  return `previous instance stopped: retire it (oats retire ${shellWord(instance || basename(home))}) or start it again (oats session start --home ${shellWord(home)})`;
}

/** Evaluate every enabled job of `ws` for the current minute (or, with
 *  `only`, run that one job now). Caller holds the host lock. `dryRun`
 *  reads only: no lock, state or definition is touched. Due jobs are
 *  visited least-recently-launched first so one job cannot monopolize the
 *  slot. An invalid definition is recorded on that job and the rest continue. */
/** `firedAt` is when the timer fired this tick (the process start, before any
 *  work): the minute evaluated. `now` is the clock for every timestamp. */
export function tickWorkspace(ws, { now = new Date(), firedAt = now, io, reg, wsList, dryRun = false, only, observeOnly = false, candidates, ctx = null } = {}) {
  const minute = minuteStart(firedAt);
  const key = minuteKey(minute);
  const registry = reg || readRegistry();
  const bound = scheduleCap(registry);
  const wsAll = wsList || [ws];
  const defs = effectiveDefinitions(ws, ctx);
  const st = readState(ws);
  const considered = [];
  const stateOf = (id) => (st.jobs[id] ||= {});
  const record = (id, action, extra = {}) => considered.push({ workspace: ws, id, minute: key, action, ...extra });
  // First observe every job's previous run (freeing the slots of homes that
  // are gone), then decide launches: a job ordered earlier must not see a
  // slot still held by a home that has already ended.
  // `candidates` (the host tick) means the host already observed every scope.
  // Triggers (kind "trigger") live in the same file and are evaluated by tickTriggers, not here.
  for (const [id, def] of Object.entries(defs.jobs)) if (def && def.kind === "trigger") delete defs.jobs[id];
  // A job whose slot cannot be read is not observed: it is reported invalid below, on its own.
  if (!candidates) for (const [id, def] of Object.entries(defs.jobs)) if (!unreadableSlot(ws, id)) observePrevious(ws, id, def, stateOf(id), io, now, { mutate: !dryRun });
  if (observeOnly) { if (!dryRun) writeState(ws, st); return considered; }
  // Least recently LAUNCHED first: only an actual harness launch counts, a
  // skipped or pending job keeps its place at the front of the line.
  const order = (candidates || Object.keys(defs.jobs)).filter((id) => Object.prototype.hasOwnProperty.call(defs.jobs, id) && (!only || id === only)).sort((a, b) => launchOrderKey(st.jobs[a]).localeCompare(launchOrderKey(st.jobs[b])) || a.localeCompare(b));
  for (const id of order) {
    const def = defs.jobs[id];
    const js = stateOf(id);
    let due, cronError;
    const invalidShape = shapeError(def), herdr = invalidShape ? null : storedHerdrBackend(ws, id, def);
    const shape = invalidShape ?? herdr?.message;
    const slot = shape ? null : unreadableSlot(ws, id);
    if (slot) { record(id, "invalid", { error: `${slot.said}; ${slot.remedy}`, errorCode: "E_SCHEDULE_INVALID" }); continue; }
    if (!shape) validateActiveExecution(js, jobLockInfo(ws, id)); // Also covers host pre-observed candidates.
    if (shape) { cronError = shape; due = false; }
    else { try { due = only ? true : dueAt(def, minute); } catch (e) { cronError = e.message; due = false; } }
    const errorCode = herdr ? { errorCode: herdr.code } : {};
    if (cronError) { if (!dryRun) js.lastRun = { ...withoutWarnings(js.lastRun), outcome: "invalid", error: `definition cannot be evaluated: ${cronError}`, ...errorCode }; record(id, "invalid", { error: cronError, ...errorCode }); continue; }
    if (def.kind === "wake" && js.pendingWake && def.enabled && !dryRun && !only) {
      const dueNow = due && js.lastAttemptedMinute !== key;
      const held = !!jobLockInfo(ws, id);
      const canStart = held || liveLocks(wsAll) < bound;
      const run = heldRun(id, def, js, performWake(def, io, { startIfStopped: dueNow, canStart, reserve: () => held || acquireJobLock(ws, id, { scheduledFor: js.pendingWake.scheduledFor, wake: true, home: def.home }), unreserve: () => { if (!held) releaseJobLock(ws, id); } }), now);
      if (run.startedHarness) js.lastLaunchedAt = now.toISOString();
      if (!existsSync(def.home)) releaseJobLock(ws, id);
      js.lastRun = { ...withoutHold(withoutWarnings(js.lastRun)), ...run, outcome: run.action, completedPending: run.action === "delivered", pendingSince: js.pendingWake.scheduledFor, startedAt: js.lastRun?.startedAt || now.toISOString() };
      if (!run.pending) delete js.pendingWake;
      else if (run.held) js.pendingWake.heldSince = run.held.since;
      else delete js.pendingWake.heldSince;
      if (dueNow) js.lastAttemptedMinute = key;
      record(id, run.action, { ...(run.reason ? { reason: run.reason } : {}), pending: !!run.pending, ...(run.held ? { held: run.held } : {}) });
      continue;
    }
    if (!def.enabled && !only) continue;
    if (js.lastAttemptedMinute === key && !only) continue;
    if (!due) continue;
    if (dryRun) {
      // A dry run recorded no observation: the held slot's instance is observed here.
      const reason = js.attempt ? "an earlier launch has no recorded result; run oats schedule reconcile" : jobLockInfo(ws, id) && def.kind !== "wake" ? heldSlotReason(js, observePrevious(ws, id, def, js, io, now, { mutate: false })) : liveLocks(wsAll) >= bound && def.kind !== "wake" ? "host busy" : undefined;
      record(id, reason ? "skipped" : "due", reason ? { reason } : {});
      continue;
    }
    js.lastAttemptedMinute = key;
    if (js.attempt) {
      let invalid;
      try { validateAttemptExecution(js.attempt, jobLockInfo(ws, id)); } catch (error) { invalid = error; }
      record(id, invalid ? "invalid" : "skipped", { reason: invalid ? `admitted attempt is invalid (${invalid.code || "error"}): ${invalid.message}` : "an earlier launch has no recorded result; run oats schedule reconcile", ...(invalid ? { errorCode: invalid.code } : {}) });
      // Older kernels kept the cause only on lastRun. Adopt it only for this
      // attempt: a crash before recording the result can leave a prior run there.
      const sameRun = js.lastRun?.outcome === "unknown" && js.lastRun.scheduledFor === js.attempt.scheduledFor && js.lastRun.startedAt === js.attempt.startedAt;
      js.attempt.error ??= (sameRun ? js.lastRun.error : null) ?? "launch attempt without a recorded result";
      js.lastRun = { ...(sameRun ? js.lastRun : { kind: def.kind }), outcome: "unknown", error: invalid ? `invalid admitted attempt: ${invalid.message}` : js.attempt.error, ...(invalid ? { errorCode: invalid.code } : {}), scheduledFor: js.attempt.scheduledFor, startedAt: js.attempt.startedAt };
      continue;
    }
    if (def.kind === "wake") {
      // A delivery to a running session takes no slot; starting a stopped
      // one does, and the slot is held (the job lock) until that home ends.
      const holdsSlot = !!jobLockInfo(ws, id);
      const run = heldRun(id, def, js, performWake(def, io, { startIfStopped: true, canStart: holdsSlot || liveLocks(wsAll) < bound, reserve: () => holdsSlot || acquireJobLock(ws, id, { scheduledFor: minute.toISOString(), wake: true, home: def.home }), unreserve: () => { if (!holdsSlot) releaseJobLock(ws, id); } }), now);
      if (run.startedHarness) js.lastLaunchedAt = now.toISOString();
      if (!existsSync(def.home)) releaseJobLock(ws, id);
      if (run.pending) js.pendingWake = { scheduledFor: minute.toISOString(), ...(run.held ? { heldSince: run.held.since } : {}) }; else delete js.pendingWake;
      js.lastRun = { scheduledFor: minute.toISOString(), startedAt: now.toISOString(), home: def.home, ...run, outcome: run.action, ...(run.instance ? { instance: run.instance } : {}) };
      record(id, run.action, { ...(run.reason ? { reason: run.reason } : {}), pending: !!run.pending, ...(run.held ? { held: run.held } : {}) });
      continue;
    }
    if (jobLockInfo(ws, id)) { record(id, "skipped", { reason: heldSlotReason(js, js.lastRun?.outcome) }); continue; }
    if (liveLocks(wsAll) >= bound) { record(id, "skipped", { reason: "host busy" }); continue; }
    // Persist the attempt before even reserving the launch slot. A crash in
    // the following gap leaves an inspectable unresolved attempt, never an
    // ownerless lock.
    js.attempt = { scheduledFor: minute.toISOString(), startedAt: now.toISOString(), wallClock: new Date().toISOString() };
    writeState(ws, st);
    if (!acquireJobLock(ws, id, { scheduledFor: minute.toISOString() })) {
      delete js.attempt; writeState(ws, st); record(id, "skipped", { reason: "still running" }); continue;
    }
    js.lastLaunchedAt = now.toISOString();
    writeState(ws, st);
    let run;
    try { run = def.kind === "spawn" ? launchSpawn(ws, def, minute, io) : launchCommand(ws, def.kind === "operation" ? operationAsCommand(def) : def, io); }
    catch (e) {
      // spawnInstance compensates its own failures, but its rollback can be
      // INCOMPLETE (a pane it could not stop, a quarantined home it kept):
      // then the effects are unconfirmed. A command that threw is
      // unconfirmed as well.
      run = { kind: def.kind, launched: false, error: e.message, errorCode: e.code, unconfirmed: def.kind !== "spawn" || reportsRetainedEffects(e.message) };
    }
    if (run.unconfirmed) {
      // Side effects unconfirmed: keep the attempt, with its first error; reconcile decides.
      // A command (or operation) whose process exit was observed runs nothing any more,
      // so it frees its host slot; its attempt still blocks the job itself. Anything else
      // (a spawn, a command that threw) keeps the slot.
      const { exit, ...facts } = run;
      js.attempt = { ...js.attempt, error: run.error, ...(exit ? { exited: true, exitStatus: exit.status, exitSignal: exit.signal } : {}) };
      js.lastRun = { scheduledFor: minute.toISOString(), startedAt: now.toISOString(), ...facts, outcome: "unknown" };
      if (exit) releaseJobLock(ws, id);
      record(id, "unknown", { error: run.error });
      continue;
    }
    delete js.attempt;
    const outcome = run.launched ? "launched" : "launch-failed";
    js.lastRun = { scheduledFor: minute.toISOString(), startedAt: now.toISOString(), ...run, outcome };
    if (!run.launched || !run.home) releaseJobLock(ws, id);
    record(id, outcome, { ...(run.error ? { error: run.error } : {}), ...(run.instance ? { instance: run.instance } : {}) });
  }
  if (!dryRun) writeState(ws, st);
  return considered;
}

/** A stored minute key as a time, or null when it is not one. */
function minuteTime(key) {
  const t = typeof key === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(key) ? Date.parse(`${key}:00Z`) : NaN;
  return Number.isFinite(t) ? t : null;
}
/** The host tick: every registered scope under the host lock. It evaluates the
 *  minute it was fired for (`firedAt`, see tickWorkspace). */
export function tickHost({ now = new Date(), firedAt = now, io, dryRun = false } = {}) {
  const minute = minuteStart(firedAt);
  const reg = readRegistry();
  const wsList = reg.workspaces.filter((w) => existsSync(w));
  // When this tick started: no trigger source's poll may end later than 50 s after it; `sourced`
  // collects every scope's due capability-source triggers, polled host-wide below (lib/triggers.mjs).
  const tick = { start: (io?.clock ?? Date.now)(), sourced: [] };
  const body = () => {
    const considered = [];
    // Observe every registered scope first, then admit in one host-wide
    // order (least recently launched first, then scope, then id), so an
    // every-minute job in the first registered scope cannot monopolize the
    // bound. An unreadable scope is recorded and the rest continue.
    const jobs = [];
    // Each scope's workspace automations, placed on this host once per tick (one gh identity
    // lookup per GitHub host), the snapshot refreshed first when it is ten minutes old.
    const cache = new Map(), contexts = new Map();
    for (const ws of wsList) contexts.set(ws, scopeAutomations(ws, { io, now, refresh: !dryRun, cache }));
    for (const ctx of contexts.values()) if (ctx.refresh && !ctx.refresh.ok) considered.push({ workspace: ctx.ws, action: "error", error: `automations refresh: ${ctx.refresh.error}` });
    for (const ws of wsList) {
      const ctx = contexts.get(ws);
      try {
        considered.push(...tickWorkspace(ws, { now, firedAt, io, reg, wsList, dryRun, observeOnly: true, ctx }));
        const defs = effectiveDefinitions(ws, ctx), st = readState(ws);
        for (const [id, def] of Object.entries(defs.jobs)) if (def?.kind !== "trigger") jobs.push({ ws, id, key: launchOrderKey(st.jobs[id]) });
      } catch (e) { considered.push({ workspace: ws, action: "error", error: e.message }); }
    }
    jobs.sort((a, b) => a.key.localeCompare(b.key) || a.ws.localeCompare(b.ws) || a.id.localeCompare(b.id));
    for (const j of jobs) {
      try { considered.push(...tickWorkspace(j.ws, { now, firedAt, io, reg, wsList, dryRun, candidates: [j.id], ctx: contexts.get(j.ws) })); }
      catch (e) { considered.push({ workspace: j.ws, id: j.id, action: "error", error: e.message }); }
    }
    // Triggers: each scope's event-driven spawns, polled at their own interval (lib/triggers.mjs).
    for (const ws of wsList) {
      try { considered.push(...tickTriggers(ws, { now, io, dryRun, ctx: contexts.get(ws), reg, wsList, tick })); }
      catch (e) { considered.push({ workspace: ws, action: "error", error: `triggers: ${e.message}` }); }
    }
    // Capability sources: every scope's in one most-overdue-first order, under the tick's one deadline.
    try { considered.push(...pollSourced(tick.sourced, { now, io, dryRun, reg, wsList, tickStart: tick.start, reserved: tick.reserved ?? 0 })); }
    catch (e) { considered.push({ action: "error", error: `trigger sources: ${e.message}` }); }
    // The host's minute only moves forward: a slow tick that finishes after the
    // next minute's tick leaves the later minute.
    if (!dryRun) {
      const host = readHostState();
      const stored = minuteTime(host.minute);
      writeHostState({ ...host, lastTick: now.toISOString(), minute: stored !== null && stored > minute.getTime() ? host.minute : minuteKey(minute) });
    }
    return { tickedAt: now.toISOString(), minute: minuteKey(minute), considered, scheduler: schedulerStatus(undefined, io) };
  };
  return dryRun ? body() : withHostLock(body);
}

/** Run one job now, ignoring its cron, under the same lock and bound; the
 *  previous run is observed under the host lock before any lock is judged. */
export function runNow(ws, qid, { now = new Date(), io, force = false, ctx = null } = {}) {
  const id = scheduleKeyOf(qid);
  const defs = effectiveDefinitions(ws, ctx);
  const def = defs.jobs[id];
  if (!def || def.kind === "trigger") throw notHere(ws, qid, ctx);
  if (!def.enabled && !force) throw scheduleError("E_SCHEDULE_DISABLED", `schedule ${id} is disabled; enable it or pass --force`);
  const reg = readRegistry();
  const wsList = reg.workspaces.includes(resolve(ws)) ? reg.workspaces : [...reg.workspaces, resolve(ws)];
  return withHostLock(() => {
    const st = readState(ws);
    const js = st.jobs[id] || (st.jobs[id] = {});
    const slot = unreadableSlot(ws, id);
    if (slot) throw scheduleError("E_SCHEDULE_INVALID", `schedule ${id}: ${slot.said}; ${slot.remedy}`);
    observePrevious(ws, id, def, js, io, now, { mutate: true });
    writeState(ws, st);
    if (js.attempt) throw scheduleError("E_SCHEDULE_UNRESOLVED", `schedule ${id} has a launch attempt without a recorded result; run oats schedule reconcile ${id} first`);
    if (def.kind !== "wake" && jobLockInfo(ws, id)) {
      const reason = heldSlotReason(js, js.lastRun?.outcome);
      throw scheduleError("E_SCHEDULE_RUNNING", reason === "still running" ? `schedule ${id} is still running` : `schedule ${id}: ${reason}`);
    }
    if (def.kind !== "wake" && liveLocks(wsList) >= scheduleCap(reg)) throw scheduleError("E_SCHEDULER_BUSY", `host concurrency ${scheduleCap(reg)} reached`);
    const considered = tickWorkspace(ws, { now, io, reg, wsList, only: id, ctx });
    const after = readState(ws);
    if (after.jobs[id]) { after.jobs[id].lastAttemptedMinute = minuteKey(minuteStart(now)); writeState(ws, after); }
    return { schedule: describe(ws, qid, io, { ctx }), run: after.jobs[id]?.lastRun || null, considered };
  });
}

/** Resolve an attempt whose result was never recorded, under the host lock:
 *  a spawn attempt adopts the instance named for its minute (deterministic
 *  identity), a command attempt only the instance its answer NAMED. Nothing
 *  is inferred from file times. An unnamed command effect stays unknown
 *  until the operator has checked by hand and passes `clear`. */
export function reconcile(ws, qid, { io, now = new Date(), clear = false, ctx = null } = {}) {
  const id = scheduleKeyOf(qid);
  const defs = effectiveDefinitions(ws, ctx);
  const def = defs.jobs[id];
  if (!def && slotName(id) && unreadableSlot(ws, id, "", { defined: false })) return reconcileOrphanSlot(ws, qid, id, { clear, ctx });
  if (!def || def.kind === "trigger") throw notHere(ws, qid, ctx);
  const describeHere = () => describe(ws, qid, io, { ctx });
  return withHostLock(() => {
    const st = readState(ws);
    const js = st.jobs[id] || (st.jobs[id] = {});
    const attempt = js.attempt || (js.lastRun?.outcome === "unknown" ? { scheduledFor: js.lastRun.scheduledFor, startedAt: js.lastRun.startedAt, ...(js.lastRun.execution !== undefined ? { execution: js.lastRun.execution } : {}) } : undefined);
    // A slot whose record cannot be read is released only once a person has checked (--clear);
    // an attempt beside it is then reconciled as any other.
    const slot = unreadableSlot(ws, id);
    if (slot && !clear) return { schedule: describeHere(), reconciled: "unknown", remedy: `${slot.said}; ${slot.remedy}` };
    if (slot) {
      releaseJobLock(ws, id);
      if (!attempt) return { schedule: describeHere(), reconciled: "cleared" };
    }
    if (!attempt) return { schedule: describeHere(), reconciled: "nothing to reconcile" };
    try { validateAttemptExecution(attempt, jobLockInfo(ws, id)); }
    catch (error) { throw scheduleError("E_SCHEDULE_INVALID", error.message); }
    const attemptKind = def.kind;
    let adopted, ambiguous;
    if (attemptKind === "spawn" && attempt.scheduledFor) {
      const purpose = `${def.purpose || def.id}-${purposeSuffix(new Date(attempt.scheduledFor))}`;
      // Only a home of THIS schedule's soul: instance names are deployment-wide
      // (0.26.0), so another soul's instance can never be this run's — a name it
      // holds made this run's spawn derive a suffixed name instead.
      const homes = findHomesInScope(ws, `${def.agent}-${purpose}`).filter((h) => {
        try { const agent = JSON.parse(readFileSync(join(h, "instance.json"), "utf8")).agent; return typeof agent !== "string" || agent === def.agent; } catch { return true; }
      });
      if (homes.length === 1) adopted = { instance: `${def.agent}-${purpose}`, home: homes[0] };
      else if (homes.length > 1) ambiguous = `${homes.length} homes named ${def.agent}-${purpose}: ${homes.join(", ")}`;
      else if (!clear && !runNameProven(ws, def)) return { schedule: describeHere(), reconciled: "unknown", remedy: `spawn names the runs of soul ${def.agent} after its own stem, not ${def.agent}-${purpose}, so the spawn's effects cannot be proven from its name; check the roster and the host by hand, then run oats schedule reconcile ${id} --clear to record launch-failed and free the slot, or oats schedule remove --force ${id}` };
    } else if (attemptKind === "command" || attemptKind === "operation") {
      const named = namedHomes(ws, js);
      if (named.length === 1) adopted = named[0];
      else if (named.length > 1) ambiguous = `${named.length} homes named ${js.lastRun.instance}: ${named.map((c) => c.home).join(", ")}`;
      else if (!clear) return { schedule: describeHere(), reconciled: "unknown", remedy: `the command's effects cannot be proven from a matching admitted receipt; check the roster and the host by hand, then run oats schedule reconcile ${id} --clear to record launch-failed and free the slot, or oats schedule remove --force ${id}` };
    }
    if (ambiguous && !clear) return { schedule: describeHere(), reconciled: "unknown", remedy: `${ambiguous}; retire or adopt by hand, then run oats schedule reconcile ${id} --clear or oats schedule remove --force ${id}` };
    if (ambiguous) adopted = undefined;
    delete js.attempt;
    if (adopted) {
      const seen = observeHome(adopted.home, io);
      js.lastRun = { scheduledFor: attempt.scheduledFor, startedAt: js.lastRun?.startedAt || attempt.startedAt, kind: attemptKind, launched: true, ...adopted, outcome: seen.outcome, ...(seen.error ? { error: seen.error } : {}), ...(seen.note ? { note: seen.note } : {}) };
      if (seen.outcome !== "ended") { if (!jobLockInfo(ws, id)) acquireJobLock(ws, id, { scheduledFor: attempt.scheduledFor, reconciled: true }); } else releaseJobLock(ws, id);
    } else {
      js.lastRun = { scheduledFor: attempt.scheduledFor, startedAt: js.lastRun?.startedAt || attempt.startedAt, kind: attemptKind, launched: false, outcome: "launch-failed", error: clear ? "cleared by the operator after checking by hand" : "no instance found in the scope's roster for the unrecorded attempt" };
      releaseJobLock(ws, id);
    }
    writeState(ws, st);
    return { schedule: describeHere(), reconciled: adopted ? "adopted" : "cleared" };
  });
}

/** Reconcile the slot `id` of a schedule that is not defined, whose record cannot be read: under
 *  the host lock, as every reconcile. Without `clear` it answers what it found and leaves it;
 *  with `clear` it releases it. `schedule` is null: there is no schedule to describe. */
function reconcileOrphanSlot(ws, qid, id, { clear, ctx }) {
  return withHostLock(() => {
    const slot = unreadableSlot(ws, id, "", { defined: false });
    if (!slot) throw notHere(ws, qid, ctx);
    if (!clear) return { schedule: null, reconciled: "unknown", remedy: `${slot.said}; ${slot.remedy}` };
    releaseJobLock(ws, id);
    return { schedule: null, reconciled: "cleared" };
  });
}

/** Whether a spawn job's runs are named `<agent>-<purpose>`, so a home's absence proves a lost
 *  receipt launched nothing: only for a bare name of a member soul under the agents root, whose
 *  agent name is that name. Spawn names a run after the soul's stem (core.mjs
 *  deriveInstanceName): a qualified name is resolved by spawn, and a package soul homes at
 *  <package>--<soul>, its runs named <package>-<soul>-<purpose>. */
function runNameProven(ws, def) {
  if (typeof def.agent !== "string" || def.agent.includes("/") || def.agent.includes("--")) return false;
  const [root] = scopeRoots(ws);
  return findAgent(root, def.agent)?.name === def.agent;
}
/** The homes in the scope of the instance a command attempt's answer named: its only adoptable
 *  receipt. Exactly one is adoptable; none or several leave its effects unproven. */
function namedHomes(ws, js) {
  const instance = js.lastRun?.instance;
  return instance ? findHomesInScope(ws, instance).map((home) => ({ instance, home })) : [];
}

/** Offline guidance only: saved placement can prove an exclusion, never current
 * authorization. In particular, do not call placementOf here: it probes gh. */
function workspaceReconcileRemedy(id, snapshot, local, localError) {
  const preserve = "Preserve the retained state and inspect its effects with the deployment owner; this diagnostic does not clear attempts or slots.";
  let unknown, excluded;
  const entries = snapshot?.schedules;
  const matches = entries?.filter((entry) => entry?.id === id) || [];
  const entry = matches[0];
  if (localError) unknown = `local configuration is invalid or unreadable (${localError.code || "read error"})`;
  else if (!snapshot) unknown = "the saved automation snapshot is missing, invalid or unreadable";
  else if (entries.some((e) => !e || typeof e.id !== "string") || matches.length > 1) unknown = "the saved automation snapshot is invalid";
  else if (!entry) excluded = "the definition is missing from the saved snapshot (this is not proof of remote deletion)";
  else if (entry.invalid || shapeError(entry.definition) || typeof entry.runsOn !== "string" || !HOST_NAME_RE.test(entry.runsOn)
    || (entry.enabled !== undefined && typeof entry.enabled !== "boolean") || !parseOwner(entry.owner)) unknown = "the saved schedule definition is invalid or incomplete";
  else {
    const host = hostOf(local);
    if (entry.enabled === false || host.disabled.schedule.has(id)) excluded = "the schedule is disabled in the saved definition or local schedules.disabled";
    else if (!host.name) excluded = "local host.name is not configured";
    else if (entry.runsOn !== host.name) excluded = `the saved schedule is assigned elsewhere (${entry.runsOn}); this host is ${host.name}`;
    else if (!trusted(host, id)) excluded = "the schedule is untrusted by local automations.trust";
  }
  if (excluded) return `Retained-state reconciliation is currently unavailable under this placement: ${excluded}. ${preserve}`;
  if (unknown) return `Workspace authorization cannot be verified offline: ${unknown}. ${preserve}`;
  return `Current workspace authorization is unverified offline; reconciliation requires current host, owner and trust authorization. ${preserve}`;
}

/** `oats doctor`: retained launch attempts and unknown last observations, and the slots whose
 * record cannot be read (SCHEDULE_SLOT_UNREADABLE, unreadableSlot), in this deployment and the
 * other scopes sharing its slots. Reads saved state only; workspace guidance cannot promise
 * authorization or an executable recovery. */
export function unresolvedScheduleAttempts(dep, { now = new Date() } = {}) {
  const problems = [], information = [];
  const here = resolve(dep);
  let scopes = [here];
  try { scopes = [here, ...readRegistry().workspaces.filter((w) => resolve(w) !== here && existsSync(w))]; }
  catch (e) { information.push(`the host schedule registry could not be read, so only this deployment's schedules were checked: ${e.message}`); }
  for (const ws of scopes) {
    const dir = ws === here ? "" : ` --dir ${/^[\w./@%+=:,-]+$/.test(ws) ? ws : shq(ws)}`;
    let defs, st, unread = null;
    try { defs = readDefinitions(ws); st = readState(ws); }
    catch (e) { unread = e; }
    // Read the last discovery snapshot directly: placement and refresh would
    // require credentials/network, and unresolved work matters even when offline.
    const snapshot = readSnapshot(ws);
    const workspaceKinds = new Map((snapshot?.schedules || []).filter((entry) => entry && typeof entry.id === "string").map((entry) => [entry.id, entry.definition?.kind]));
    // Every slot there is, as liveLocks counts them: the tick reports each one of a defined job
    // invalid, and reads none of a schedule that is not defined. Definitions that cannot be read
    // say nothing of which it is.
    const slots = join(stateDir(ws), "locks");
    let slotEntries = [];
    try { slotEntries = readdirSync(slots, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); }
    catch (e) { if (e.code !== "ENOENT") information.push(`the schedule slots of ${ws} could not be read: ${e.message}`); }
    for (const key of slotEntries) {
      const id = shownScheduleId(key);
      const defined = unread !== null || (key.includes("~") ? workspaceKinds.has(id) : !!defs.jobs[key]);
      const slot = unreadableSlot(ws, key, dir, { defined });
      if (!slot) continue;
      const where = ws === here ? "" : ` (in ${ws})`;
      problems.push({ code: SCHEDULE_SLOT_UNREADABLE, severity: "warning", scope: ws, id,
        message: defined
          ? `schedule ${id}${where}: its slot ${lockDir(ws, key)} has no readable record; the tick reports this job invalid and starts nothing of it, and the slot counts against maxConcurrent`
          : `schedule ${id}${where}, which is not defined: its slot ${lockDir(ws, key)} has no readable record, and the slot counts against maxConcurrent`,
        remedy: slot.remedy });
    }
    if (unread) { information.push(`the schedules of ${ws} could not be read: ${unread.message}`); continue; }
    let local, localError;
    try {
      const found = loadLocal(ws);
      if (resolve(dirname(found.path)) !== resolve(ws)) throw scheduleError("E_LOCAL_MISSING", "this scope has no local configuration");
      local = found.local;
    } catch (e) { localError = e; }
    for (const [key, js] of Object.entries(st.jobs)) {
      if (!js?.attempt && js?.lastRun?.outcome !== "unknown") continue;
      // A workspace schedule's state key is <member>~<id> (scheduleStateKey); a local one is its id.
      const workspace = key.includes("~");
      if (!workspace && !defs.jobs[key]) continue;
      const id = workspace ? key.replace("~", "/") : key;
      const kind = (workspace ? workspaceKinds.get(id) : defs.jobs[key]?.kind) ?? js.lastRun?.kind ?? null;
      const scheduledFor = js.attempt?.scheduledFor ?? js.lastRun?.scheduledFor ?? null;
      const startedAt = js.attempt?.startedAt ?? js.lastRun?.startedAt ?? null;
      const started = Date.parse(startedAt);
      const ageSeconds = Number.isNaN(started) ? null : Math.max(0, Math.floor((now.getTime() - started) / 1000));
      const lock = jobLockInfo(ws, key);
      const holdsSlot = !!lock;
      const error = js.attempt?.error ?? js.lastRun?.error ?? null;
      const unproven = (kind === "command" || kind === "operation") && namedHomes(ws, js).length !== 1;
      let unavailable = localError ? `local configuration is invalid or unreadable (${localError.code || "read error"})` : null;
      if (!workspace && !unavailable) {
        unavailable = !SCHEDULE_ID_RE.test(id) ? "the stored schedule ID is invalid" : shapeError(defs.jobs[key]);
        if (!unavailable && defs.jobs[key].id !== undefined && defs.jobs[key].id !== key) unavailable = "the stored definition has a different ID";
        try { validateAttemptExecution(js.attempt || { execution: js.lastRun?.execution }, lock); }
        catch { unavailable ||= "the retained attempt or lock uses unsupported captured execution state"; }
      }
      const slot = workspace || unavailable ? null : unreadableSlot(ws, key, dir);
      const remedy = workspace ? workspaceReconcileRemedy(id, snapshot, local, localError)
        : unavailable ? `Doctor does not recommend reconciling this job because ${unavailable}; preserve the retained state and inspect its effects with the deployment owner.`
        : slot ? slot.remedy
        : `oats schedule reconcile ${id}${unproven ? " --clear" : ""}${dir}`;
      const subject = js.attempt ? `${kind ? `a ${kind}` : "a"} launch attempt for ${scheduledFor} has no recorded result`
        : `the last ${kind || "schedule"} run for ${scheduledFor} has an unknown observation`;
      const blocking = js.attempt ? "This persisted attempt blocks another run until it is reconciled"
        : "There is no persisted launch attempt blocking execution; an eligible tick may re-observe the last run, without a guarantee of clearance";
      const guidance = workspace || unavailable ? remedy : slot ? `${slot.said}: ${remedy}` : unproven ? `Its effects can't be proven: check the roster and the host by hand, then run ${remedy}` : `Run ${remedy}`;
      const message = `schedule ${id}${ws === here ? "" : ` (in ${ws})`}: ${subject} (started ${startedAt}${ageSeconds === null ? "" : `, ${formatAge(ageSeconds)} ago`})${error ? `: ${error}` : ""}. ${blocking}, and ${holdsSlot ? "it holds a host slot (counted against maxConcurrent)" : "it holds no host slot"}. ${guidance}`;
      problems.push({ code: "schedule-unresolved", severity: "warning", scope: ws, id, kind, scheduledFor, startedAt, ageSeconds, holdsSlot, exited: js.attempt?.exited === true, error, remedy, message });
    }
  }
  return { problems, information };
}
function formatAge(s) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

// -------------------------------------------------------- definitions CRUD

export const SCHEDULE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A schedule id this host cannot run: unknown, or a workspace schedule placed elsewhere. */
/** `oats schedule test <id>`: what running it on this host would do, without running it — its
 *  placement, whether its soul resolves (the kernel's own `oats spawn <soul> --preview`, which
 *  writes nothing) and when it is next due. Spawns nothing, records nothing, takes no lock. */
export function testSchedule(ws, qid, io, { now = new Date(), ctx = null } = {}) {
  const row = describe(ws, qid, io, { now, ctx });
  const { scope, name } = splitId(qid);
  const entry = scope === "local" ? null : (ctx?.schedules || []).find((x) => x.id === `${scope}/${name}`);
  const def = entry ? { ...entry.definition, workspace: { qid: entry.id } } : readDefinitions(ws).jobs[name];
  const problems = [];
  if (row.invalid) problems.push(`${row.qualifiedId} is invalid: ${row.invalid.message}`);
  if (!row.runsHere) problems.push(`${row.qualifiedId} does not run on this host (${row.reason ?? "disabled here"}${row.reasonDetail ? `: ${row.reasonDetail}` : ""})`);
  if (!row.enabled) problems.push(`${row.qualifiedId} is disabled (oats schedule enable ${row.qualifiedId})`);
  // The next cron match, whether or not this host runs it (placement says that).
  let nextDue = null; try { nextDue = def?.cron ? nextRunAfter(def, now) : null; } catch (e) { problems.push(`cron: ${e.message}`); }
  let soul = null;
  if (def?.kind === "spawn") {
    soul = { name: def.agent, origin: row.soul?.origin ?? null, resolves: false, error: null };
    try {
      const { root, discover } = resolveScheduledAgent(ws, def);
      spawnPreview(ws, def, { root, discover }, io);
      soul.resolves = true;
    } catch (e) {
      soul.error = { code: e.code || "E_SPAWN_FAILED", message: e.message };
      problems.push(`soul ${def.agent} does not resolve: ${e.message}`);
    }
  }
  return {
    id: row.id, qualifiedId: row.qualifiedId, kind: row.kind,
    placement: { runsHere: row.runsHere, reason: row.reason, ...(row.reasonDetail ? { reasonDetail: row.reasonDetail } : {}), enabledHere: row.enabledHere, runsOn: row.runsOn, owner: row.owner, host: ctx?.host?.name ?? null },
    soul, nextDue, spawned: false, problems, ok: problems.length === 0,
  };
}
function notHere(ws, qid, ctx) {
  const { scope } = splitId(qid);
  const a = scope !== "local" ? (ctx?.schedules || []).find((x) => x.id === qid) : null;
  if (a) return automationError("E_AUTOMATION_NOT_HERE", `${qid} does not run on this host (${a.placement.reason ?? (a.invalid ? "invalid" : "disabled here")}${a.placement.detail ? `: ${a.placement.detail}` : a.invalid ? `: ${a.invalid.message}` : ""})`, { id: qid, reason: a.placement.reason, runsOn: a.runsOn, owner: a.owner });
  return scheduleError("E_SCHEDULE_UNKNOWN", `no schedule ${JSON.stringify(qid)} in ${ws}${scope !== "local" && !ctx?.snapshot ? " (no automations snapshot yet: run oats sync)" : ""}`);
}
function incarnationOfHome(home) { try { const m = JSON.parse(readFileSync(join(home, "instance.json"), "utf8")); return typeof m?.createdAt === "string" ? m.createdAt : null; } catch { return null; } }
/** K8b — session PROVENANCE of a run (facts the recorder had), never a
 *  transcript: there is no reader behind this block. */
function sessionProvenanceOf(r) {
  if (!r || typeof r !== "object") return null;
  const delivery = r.startedHarness || r.startedRuntime ? "launched" : r.action === "delivered" || r.outcome === "delivered" || r.completedPending ? "delivered-active" : r.launched === true || r.instance ? "launched" : "none";
  return { instance: typeof r.instance === "string" ? r.instance : null, home: typeof r.home === "string" ? r.home : null, incarnation: typeof r.incarnation === "string" ? r.incarnation : null, server: typeof r.server === "string" ? r.server : null, delivery };
}
/** Read-time projection of one job's stored history: bounded to
 *  RECENT_RUNS_MAX, legacy rows marked, corruption isolated to the job. */
function projectHistory(js) {
  const stored = js?.recentRuns;
  if (stored === undefined || stored === null) return { history: { status: "ok", stored: 0, truncated: false }, recentRuns: [] };
  if (!Array.isArray(stored)) return { history: { status: "corrupt", stored: null, truncated: false }, recentRuns: [] };
  const rows = [];
  for (const r of stored.slice(0, RECENT_RUNS_MAX)) {
    if (!r || typeof r !== "object") { rows.push({ runId: null, legacy: true, corrupt: true }); continue; }
    const { key, ...rest } = r;
    const legacy = typeof r.runId !== "string";
    rows.push({ ...rest, runId: legacy ? null : r.runId, legacy, ...(legacy ? { settled: null, transitions: null } : {}), session: sessionProvenanceOf(rest) });
  }
  return { history: { status: "ok", stored: stored.length, truncated: stored.length > RECENT_RUNS_MAX }, recentRuns: rows };
}
/** One schedule's row: the stored job's facts (a workspace schedule this host runs is a job
 *  under its state key) plus the automations row (docs/desktop-cli-api.md "Automations"). A
 *  workspace schedule another host runs has no local facts: its definition and placement only. */
export function describe(ws, qid, io, { defs, st, now = new Date(), ctx = null } = {}) {
  if (typeof qid !== "string" || !qid) throw scheduleError("E_BAD_ARGS", `oats schedule show <id> (local/<id> or <member>/<id>)`);
  const { scope, name } = splitId(qid);
  if (scope !== "local" && (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(scope) || !SCHEDULE_NAME_RE.test(name))) throw scheduleError("E_BAD_ARGS", `a workspace schedule id is <member>/<id> (got ${JSON.stringify(qid)})`);
  const entry = scope === "local" ? null : (ctx?.schedules || []).find((x) => x.id === `${scope}/${name}`);
  if (scope !== "local" && !entry) throw notHere(ws, `${scope}/${name}`, ctx);
  if (entry && !entry.placement.runsHere) return scheduleRow(ws, entry, { ...(entry.definition || {}), scope: ws, scheduleApi: 2, scheduleHistoryApi: SCHEDULE_HISTORY_API, nextRun: null, lastRun: null, running: false }, ctx);
  const id = scope === "local" ? name : scheduleStateKey(entry.id);
  if (scope === "local" && !SCHEDULE_ID_RE.test(id)) throw scheduleError("E_BAD_ARGS", `schedule id must match ${SCHEDULE_ID_RE} (got ${JSON.stringify(qid)})`);
  defs ||= effectiveDefinitions(ws, ctx); st ||= readState(ws);
  const def = defs.jobs[id];
  if (!def) throw scheduleError("E_SCHEDULE_UNKNOWN", `no schedule ${JSON.stringify(qid)} in ${ws}`);
  if (def.kind === "trigger") throw scheduleError("E_SCHEDULE_UNKNOWN", `${qid} is a trigger, not a schedule — use oats trigger show ${qid}`);
  // Subject truth: the definition's own id must be the key it is stored under.
  if (def.id !== undefined && def.id !== id) throw scheduleError("E_SCHEDULE_IDENTITY", `schedule stored under ${JSON.stringify(id)} declares id ${JSON.stringify(def.id)}`, { key: id, declared: def.id });
  const js = st.jobs[id] || {};
  let nextRun = null; try { nextRun = def.enabled ? nextRunAfter(def, now) : null; } catch { nextRun = null; }
  const lock = jobLockInfo(ws, id);
  const intent = js.attempt || (lock ? (js.lastRun?.execution !== undefined ? { execution: js.lastRun.execution } : {}) : undefined);
  const { history, recentRuns } = projectHistory(js);
  const { workspace: _w, ...stored } = def; void _w;
  const base = { ...stored, id, scope: ws, scheduleApi: 2, scheduleHistoryApi: SCHEDULE_HISTORY_API, executionStatus: scheduleExecutionStatus(def, intent, lock), nextRun, lastRun: js.lastRun ? { ...js.lastRun, runId: runIdOf(js.lastRun), session: sessionProvenanceOf(js.lastRun) } : null, history, recentRuns, running: !!lock, ...(js.attempt ? { attempt: js.attempt } : {}), ...(js.pendingWake ? { pendingWake: js.pendingWake } : {}) };
  const herdr = entry ? null : storedHerdrBackend(ws, id, def);
  return scheduleRow(ws, entry ?? localEntry("schedule", { ...def, id: name }, { dep: ws, ...(herdr ? { invalid: { code: herdr.code, message: herdr.message, field: herdr.field } } : {}) }), base, ctx);
}
/** A schedule's list row: its stored facts, the fields every trigger and schedule row share
 *  (lib/automations.mjs baseRow) and the schedule's own: `kind` is its run (spawn, command, wake,
 *  operation), the soul it spawns, the task, the cron and tz, the last run and the next due. */
function scheduleRow(ws, entry, base, ctx) {
  const { enabled: _e, ...rest } = base; void _e;
  const def = entry.definition || {};
  const soul = def.kind === "spawn" ? def.agent ?? null : null;
  const local = entry.member === "local";
  return {
    ...rest, ...baseRow(entry),
    // A local schedule keeps its bare id (the 0.28 contract every consumer reads); its qualified
    // form is qualifiedId. A workspace schedule's id IS qualified: <member>/<id>.
    id: local ? entry.name : entry.id, qualifiedId: entry.id,
    kind: base.kind ?? def.kind ?? null,
    soul: soul ? { name: soul, origin: soulOriginOf(ctx?.snapshot?.souls, soul) } : null,
    task: def.task ?? null, cron: def.cron ?? null, tz: def.tz ?? null,
    teams: [], launchConfig: def.launchConfig ?? null, harness: def.harness ?? null, model: def.model ?? null, concurrency: null,
    lastRun: base.lastRun ?? null, nextDue: entry.placement.runsHere ? base.nextRun ?? null : null,
    enabled: entry.enabled !== false,
  };
}
export function listSchedules(ws, io, { now = new Date(), ctx = null } = {}) {
  const defs = readDefinitions(ws), st = readState(ws);
  const all = effectiveDefinitions(ws, ctx);
  // One job's bad identity or history does not fail the others: it is reported as its own row.
  const row = (qid) => {
    try { return describe(ws, qid, io, { defs: all, st, now, ctx }); }
    catch (e) { return { id: splitId(qid).scope === "local" ? splitId(qid).name : qid, qualifiedId: qid, name: splitId(qid).name, scope: ws, scheduleApi: 2, scheduleHistoryApi: SCHEDULE_HISTORY_API, unreadable: { code: e.code || "E_SCHEDULE_INVALID", message: e.message }, history: { status: "corrupt", stored: null, truncated: false }, recentRuns: [] }; }
  };
  const local = Object.keys(defs.jobs).filter((id) => defs.jobs[id]?.kind !== "trigger").sort().map((id) => row(localId(id)));
  const workspace = (ctx?.schedules || []).map((a) => row(a.id));
  // Triggers share the definitions file but not this listing: a pointer, so they are never invisible.
  const triggers = Object.values(defs.jobs).filter((d) => d?.kind === "trigger").length + (ctx?.triggers || []).length;
  return { scope: ws, scheduleApi: 2, scheduleHistoryApi: SCHEDULE_HISTORY_API, integrity: scheduleIntegrity(ws), host: { name: ctx?.host?.name ?? null, ghUser: ctx?.ghUsers ? ctx.ghUsers() : {} }, schedules: [...local, ...workspace], triggers: { count: triggers, command: "oats trigger list" }, snapshot: ctx?.snapshot ? { takenAt: ctx.snapshot.takenAt, problems: (ctx.snapshot.problems || []).length } : null, scheduler: schedulerStatus(ws, io) };
}
export function addSchedule(ws, spec, io) {
  const def = validateDefinition(ws, spec, { io });
  return withScopeLock(ws, () => {
    const defs = readDefinitions(ws);
    if (defs.jobs[def.id]) throw scheduleError("E_SCHEDULE_EXISTS", `schedule ${def.id} already exists in ${ws}`);
    const now = new Date().toISOString();
    defs.jobs[def.id] = { ...def, createdAt: now, updatedAt: now };
    writeDefinitions(ws, defs);
    return describe(ws, localId(def.id), io);
  });
}
/** Update under the host lock (so the busy check cannot race a tick's
 *  admission) and the scope lock. What a run is tracked or reconciled by
 *  (kind, agent, agentsRoot, repo, purpose, home, cwd, argv) cannot change
 *  while the job holds a slot or has an unresolved attempt; timing and text can. */
export function updateSchedule(ws, qid, spec, io) {
  const id = localScheduleId(qid, "update");
  const def = validateDefinition(ws, { ...spec, id }, { io });
  return withHostLock(() => withScopeLock(ws, () => {
    const defs = readDefinitions(ws);
    if (!defs.jobs[id] || defs.jobs[id].kind === "trigger") throw scheduleError("E_SCHEDULE_UNKNOWN", `no schedule ${JSON.stringify(id)} in ${ws}${defs.jobs[id] ? " (it is a trigger: use oats trigger)" : ""}`);
    const identity = (d) => JSON.stringify([d.kind, d.agent, d.agentsRoot, d.repo, d.purpose, d.home, d.cwd, d.argv, d.operation, d.definitionVersion, d.recurrencePolicy, d.execution, d.preparation]);
    const busy = !!jobLockInfo(ws, id) || !!readState(ws).jobs[id]?.attempt;
    if (busy && identity(defs.jobs[id]) !== identity(def)) throw scheduleError("E_SCHEDULE_RUNNING", `schedule ${id} is running or has an unresolved attempt; its execution identity, kind, target and captured policy cannot change until it ends (cron, tz and enabled can)`);
    defs.jobs[id] = { ...def, createdAt: defs.jobs[id].createdAt, updatedAt: new Date().toISOString() };
    writeDefinitions(ws, defs);
    return describe(ws, localId(id), io);
  }), { retryMs: 3000 });
}
/** Change only a local schedule's description (`oats schedule update <id> --description=<text>`),
 *  under the same locks as an update. A label is not what a run is tracked by, so it may change
 *  while the job runs or has an unresolved attempt; nothing else of the stored job is touched or
 *  re-validated. `""` or null removes it. */
export function updateScheduleDescription(ws, qid, description, io) {
  const id = localScheduleId(qid, "update");
  const clear = description === "" || description === null || description === undefined;
  if (!clear) validateDescription(description, "E_SCHEDULE_INVALID");
  return withHostLock(() => withScopeLock(ws, () => {
    const defs = readDefinitions(ws);
    if (!defs.jobs[id] || defs.jobs[id].kind === "trigger") throw scheduleError("E_SCHEDULE_UNKNOWN", `no schedule ${JSON.stringify(id)} in ${ws}${defs.jobs[id] ? " (it is a trigger: use oats trigger)" : ""}`);
    const { description: _d, ...rest } = defs.jobs[id]; void _d;
    defs.jobs[id] = { ...rest, ...(clear ? {} : { description }), updatedAt: new Date().toISOString() };
    writeDefinitions(ws, defs);
    return describe(ws, localId(id), io);
  }), { retryMs: 3000 });
}
export function setEnabled(ws, qid, enabled, io) {
  const id = localScheduleId(qid, "change");
  return withScopeLock(ws, () => {
    const defs = readDefinitions(ws);
    if (!defs.jobs[id] || defs.jobs[id].kind === "trigger") throw scheduleError("E_SCHEDULE_UNKNOWN", `no schedule ${JSON.stringify(id)} in ${ws}${defs.jobs[id] ? " (it is a trigger: use oats trigger)" : ""}`);
    defs.jobs[id] = { ...defs.jobs[id], enabled, updatedAt: new Date().toISOString() };
    writeDefinitions(ws, defs);
    return describe(ws, localId(id), io);
  });
}
/** Remove under the host lock (state changes under a live tick are refused
 *  by the lock, not raced). */
export function removeSchedule(ws, qid, { force = false } = {}) {
  const id = localScheduleId(qid, "remove");
  return withHostLock(() => withScopeLock(ws, () => {
    const defs = readDefinitions(ws);
    if (!defs.jobs[id] || defs.jobs[id].kind === "trigger") throw scheduleError("E_SCHEDULE_UNKNOWN", `no schedule ${JSON.stringify(id)} in ${ws}${defs.jobs[id] ? " (it is a trigger: use oats trigger)" : ""}`);
    const st = readState(ws), job = st.jobs[id];
    if ((jobLockInfo(ws, id) || job?.attempt || job?.lastRun?.outcome === "unknown") && !force) throw scheduleError("E_SCHEDULE_RUNNING", `schedule ${id} is running or has unresolved effects; reconcile first, or --force forgets the job without stopping anything`);
    delete defs.jobs[id];
    writeDefinitions(ws, defs);
    delete st.jobs[id]; writeState(ws, st);
    releaseJobLock(ws, id);
    return { removed: id };
  }));
}
/** The stored id of a LOCAL schedule argument; a workspace schedule is changed in Git (enabled or
 *  disabled on this host through oats-local.yaml schedules.disabled). */
function localScheduleId(qid, verb) {
  const { scope, name } = splitId(qid);
  if (scope !== "local") throw automationError("E_AUTOMATION_WORKSPACE", `${qid} is a workspace schedule, defined in Git: ${verb} its file there${verb === "remove" ? `, or stop it on this host: oats schedule disable ${qid}` : ""}`, { id: qid });
  return name;
}
/** Save the wake job for a freshly spawned instance (id wake-<instance>). */
export function saveWakeForHome(ws, { instance, home, wake }) {
  const id = `wake-${instance}`.slice(0, 100).replace(/-+$/, "");
  const spec = { id, enabled: wake.enabled === undefined ? true : wake.enabled, cron: wake.cron, tz: wake.tz, kind: "wake", home, message: wake.message };
  return addSchedule(ws, spec);
}
/** Retirement hook: wake definitions bound to this home are removed (nothing is stopped). */
export function removeWakeForHome(ws, home) {
  if (!existsSync(definitionsPath(ws))) return [];
  // A retirement waits briefly for a running tick rather than failing.
  return withHostLock(() => withScopeLock(ws, () => {
    const defs = readDefinitions(ws);
    const gone = [];
    for (const [id, def] of Object.entries(defs.jobs)) if (def.kind === "wake" && resolve(def.home) === resolve(home)) { delete defs.jobs[id]; gone.push(id); releaseJobLock(ws, id); }
    if (gone.length) { writeDefinitions(ws, defs); const st = readState(ws); for (const id of gone) delete st.jobs[id]; writeState(ws, st); }
    return gone;
  }), { retryMs: 10000 });
}
/** Translate the human spawn flags into the wake object. */
export function wakeFromFlags({ every, cron, tz, message }) {
  if (every === undefined && cron === undefined) return undefined;
  if (every !== undefined && cron !== undefined) throw scheduleError("E_SCHEDULE_INVALID", "use --wake-every or --wake-cron, not both", { field: "cron" });
  let expr = cron;
  if (every !== undefined) {
    const n = Number(every);
    if (!Number.isInteger(n) || n < 1 || n > 59) throw scheduleError("E_SCHEDULE_INVALID", "--wake-every: whole minutes from 1 to 59 (cadence is cron: */N fires at :00 and every N minutes after)", { field: "cron" });
    expr = `*/${n} * * * *`;
  }
  const zone = tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (message === undefined) throw scheduleError("E_SCHEDULE_INVALID", "a wake schedule needs --wake-message or --wake-message-file", { field: "message" });
  return { cron: expr, tz: zone, message, enabled: true };
}
export function schedulerStatus(ws, io) {
  const reg = readRegistry();
  const host = readHostState();
  let unit = { installed: false, active: false };
  try { unit = (io?.hostStatus || (() => ({ installed: false, active: false, unavailable: true })))(); } catch (e) { unit = { installed: false, active: false, error: e.message }; }
  return { installed: !!unit.installed, active: !!unit.active, ...(unit.unit ? { unit: unit.unit } : {}), ...(unit.error ? { error: unit.error } : {}), problems: Array.isArray(unit.problems) ? unit.problems : [], lastTick: host.lastTick || null, maxConcurrent: scheduleCap(reg), triggersMaxConcurrent: reg.triggersMaxConcurrent ?? null, tickIntervalSec: reg.tickIntervalSec, ...(ws ? { workspace: resolve(ws), registered: reg.workspaces.includes(resolve(ws)) } : {}), workspaces: reg.workspaces, live: liveLocks(reg.workspaces.filter((w) => existsSync(w))) };
}
