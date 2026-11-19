// The host's record of certificates that retires left in a people-controlled team.
// `aw workspace delete` cannot remove the member certificate of a team whose controller
// key is held by people (alias_released_reason team_not_hosted): only that controller
// can, with the command retire prints. Retire records each such certificate here, at
// <deployment>/.oats-aweb/retired-certificates.json, so `oats aweb roster` on this host
// can mark the leftover member and print that command. The record holds certificate ids,
// registry origins and commands only, never a secret, and lives only on the host where the
// retire ran.
//
// Any agent running as the deployment's user can write the record, so no text from it
// reaches a person as a command: retire and roster both build the controller's command
// with controllerCleanupCommand, from a validated team, certificate id and registry. The
// stored `command` is written (rebuilt) for older providers that require it, and never read.
//
// Writers (retire) serialise on an exclusive lock file beside the record: each re-reads
// the record under the lock, merges its entries, writes a temp file in the same directory
// and renames it over the record. Readers (roster) never lock: the rename is atomic, so
// they always see a whole file.
//
// No writer ever removes another's lock, however old or whoever held it: a lock path that
// is moved or removed can be taken by a third writer at once, and no later step can undo
// what it did meanwhile. A lock left by a writer that died is reported instead: each later
// retire waits LOCK_WAIT_MS, records nothing and warns, naming the file to remove.
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validAwebTeamId } from "./aweb-team-id.mjs";
import { registryOriginUrl } from "./plain-service.mjs";

export const RETIRED_RECORD_MAX = 500;
const LOCK_WAIT_MS = 5000;
const LOCK_POLL_MS = 20;
const LOCK_RELATIVE = ".oats-aweb/retired-certificates.json.lock";

export const retiredRecordDir = (deployment) => join(deployment, ".oats-aweb");
export const retiredRecordFile = (deployment) => join(retiredRecordDir(deployment), "retired-certificates.json");

const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";
const nullableString = (v) => v === null || typeof v === "string";
/** An entry the record may hold: everything roster shows is present and typed. */
const validEntry = (e) => !!e && typeof e === "object" && !Array.isArray(e)
  && nonEmpty(e.team) && nonEmpty(e.certificateId) && nonEmpty(e.command)
  && typeof e.retiredAt === "string" && !Number.isNaN(Date.parse(e.retiredAt))
  && nullableString(e.alias) && nullableString(e.instance);
const keyOf = (e) => `${e.team}\u0000${e.certificateId}`;

// A certificate id as aw issues them (a UUID): letters, digits, `_` and `-`, starting with
// a letter or digit so it can never read as a flag.
const CERTIFICATE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Why no controller cleanup command can be built from `{team, certificateId, registry}`, or
 *  undefined when one can. `registry` is optional: undefined or null builds a command without
 *  --registry. The reason is fixed text and never echoes the value. */
export function controllerCleanupProblem({ team, certificateId, registry } = {}) {
  if (typeof team !== "string" || !validAwebTeamId(team)) return "its team is not a valid aweb team id";
  if (typeof certificateId !== "string" || !CERTIFICATE_ID_RE.test(certificateId)) return "its certificate id is not valid";
  if (registry != null && !registryOriginUrl(registry)) return "its registry is not a plain registry origin";
  return undefined;
}

/** The command the team's controller runs to remove a member certificate, built only from
 *  validated values; undefined when any of them is invalid (controllerCleanupProblem). */
export function controllerCleanupCommand({ team, certificateId, registry } = {}) {
  if (controllerCleanupProblem({ team, certificateId, registry })) return undefined;
  const [name, namespace] = team.split(":");
  return `aw id team remove-member --namespace ${namespace} --team ${name} --cert-id ${certificateId}${registry ? ` --registry ${registry}` : ""} --json`;
}

/** The record's entries, or null when the text is not a version-1 record whose every
 *  entry is valid: a record with one bad entry is malformed as a whole. */
function parseRecord(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { return null; }
  if (!doc || typeof doc !== "object" || doc.version !== 1 || !Array.isArray(doc.entries)) return null;
  return doc.entries.every(validEntry) ? doc.entries : null;
}

/** The record's entries for roster. `missing` when there is no file; `problem` (a fixed
 *  message) when it cannot be read or is malformed, and then no entries. */
export function readRetiredRecord(deployment) {
  let text;
  try { text = readFileSync(retiredRecordFile(deployment), "utf8"); }
  catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return { entries: [], missing: true };
    return { entries: [], problem: "the record of certificates OATS retired on this host could not be read; nothing from it is shown" };
  }
  const entries = parseRecord(text);
  if (!entries) return { entries: [], problem: "the record of certificates OATS retired on this host is malformed; nothing from it is shown" };
  return { entries };
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const fixed = (cause) => Object.assign(new Error(cause), { fixed: true });
const quietly = (fn) => { try { fn(); } catch { /* best effort */ } };

/** Takes the writers' lock, or throws a fixed-cause error. */
function takeLock(lock, { waitMs = LOCK_WAIT_MS } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { closeSync(openSync(lock, "wx", 0o600)); return; }
    catch (e) {
      if (e?.code !== "EEXIST") throw fixed("the record directory is not writable");
    }
    if (Date.now() >= deadline) throw fixed(`another retire holds the record's lock (if none is running, remove ${LOCK_RELATIVE})`);
    sleep(LOCK_POLL_MS);
  }
}

/** Records `entries` ({team, certificateId, registry, alias, instance, retiredAt}) at the
 *  deployment, each with the command controllerCleanupCommand builds from it, replacing any
 *  entry with the same team and certificate id and keeping the newest RETIRED_RECORD_MAX.
 *  Entries no command can be built for (no or an invalid certificate id, team or registry)
 *  are skipped: nothing could be shown for them. Never throws: returns `cause`, the fixed cause of what went wrong, if
 *  anything did (an unreadable or malformed record is replaced, and said so). */
export function recordRetiredCertificates(deployment, entries, { lockWaitMs } = {}) {
  try {
    const fresh = entries
      .map((e) => ({ team: e?.team, certificateId: e?.certificateId, alias: e?.alias ?? null, instance: e?.instance ?? null, retiredAt: e?.retiredAt, registry: e?.registry ?? null, command: controllerCleanupCommand({ team: e?.team, certificateId: e?.certificateId, registry: e?.registry }) }))
      .filter(validEntry);
    if (!fresh.length) return {};
    return writeRecord(deployment, fresh, { lockWaitMs });
  } catch {
    return { cause: "the record could not be written" };
  }
}

function writeRecord(deployment, fresh, { lockWaitMs }) {
  const dir = retiredRecordDir(deployment), file = retiredRecordFile(deployment), lock = `${file}.lock`;
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  catch { return { cause: "the record directory could not be created" }; }
  // A directory that already existed keeps its mode: take group and other access away,
  // leaving the owner's (a directory the owner cannot write stays unwritable).
  try { const { mode } = statSync(dir); if (mode & 0o077) chmodSync(dir, mode & 0o700); }
  catch { return { cause: "the record directory's mode could not be set to 0700" }; }
  try { takeLock(lock, { waitMs: lockWaitMs }); }
  catch (e) { return { cause: e?.fixed ? e.message : "the record's lock could not be taken" }; }
  // Under the lock no other writer runs, so this process's temp name is free unless a
  // crashed writer left it: that one fails this write, is reported, and is removed.
  const tmp = join(dir, `.retired-certificates.${process.pid}.tmp`);
  try {
    let existing = [], cause;
    try {
      existing = parseRecord(readFileSync(file, "utf8"));
      if (!existing) { existing = []; cause = "the previous record was malformed and was replaced"; }
    } catch (e) { if (e?.code !== "ENOENT") cause = "the previous record was unreadable and was replaced"; }
    const replaced = new Set(fresh.map(keyOf));
    const merged = [...existing.filter((e) => !replaced.has(keyOf(e))), ...fresh].slice(-RETIRED_RECORD_MAX);
    try {
      writeFileSync(tmp, `${JSON.stringify({ version: 1, entries: merged }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      chmodSync(tmp, 0o600);
    } catch { return { cause: "the record could not be written" }; }
    try { renameSync(tmp, file); } catch { return { cause: "the record could not be written" }; }
    return cause ? { cause } : {};
  } finally {
    quietly(() => unlinkSync(tmp));
    quietly(() => unlinkSync(lock));
  }
}
