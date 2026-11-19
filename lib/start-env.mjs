/** What a start's launch environment was (feature session-resume, #1559): the record that lets a
 *  resume refuse to start under a reference value that changed since the start it brings back.
 *  Kernel-private files in the home, not a contract:
 *   - `.oats-start-env.key`: 32 random bytes, mode 0600, made once, at the first start that records.
 *     It never leaves the home: never logged, answered or put in an event.
 *   - `.oats-start-env.json`: `{ startId, digests: { <reference source (env name or file:path)>: <hex HMAC-SHA256(key,
 *     value)> } }`, written whole (tmp + rename) at every start that renders a recipe, for that
 *     start's id; `digests` is `{}` for a launch with no reference. A value is never written: a
 *     reference value may be a credential, and only its keyed one-way digest is kept.
 *  The record is best effort: a write that fails leaves the previous record (for another start) or
 *  none, which a resume reads as unverified. A retire's recovery copy of the home leaves both out
 *  (lib/core.mjs copyRecoveryHome). Uses only Node built-ins and kernel helpers: the start, the spawn and the sweep's
 *  `--plan` read and write it through here. */
import { fileReferenceProblems, fileReferenceRemedy } from "./launch-env.mjs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const START_ENV_FILE = ".oats-start-env.json";
export const START_ENV_KEY_FILE = ".oats-start-env.key";
/** A temporary file of either, left by a write that was cut short. */
export const START_ENV_TMP = /^\.oats-start-env\.(json|key)\.tmp-.+$/;
const KEY_BYTES = 32;
const RECORD_MAX = 64 * 1024;
const DIGEST = /^[0-9a-f]{64}$/;

/** The source names of a recipe's `{fromEnv}` references, sorted, each once. */
export function fromEnvNames(recipeEnv) {
  return [...new Set(Object.values(recipeEnv || {}).filter((v) => v && typeof v === "object" && typeof v.fromEnv === "string" && v.fromEnv).map((v) => v.fromEnv))].sort();
}

/** The message of a resume refused for references that are not set (E_LAUNCH_ENV_MISSING). */
export function launchEnvMissingMessage(names, harness) {
  const files = fileReferenceProblems(names);
  if (files.length) {
    const variables = names.filter((name) => !name.startsWith("file:"));
    return [...(variables.length ? [`launch references ${variables.join(", ")}, not set on this host`] : []), ...files, "nothing was created or started"].join("; ") + fileReferenceRemedy(names, harness);
  }
  return `this home's launch references ${names.join(", ")}, not set on this host; nothing was started${fileReferenceRemedy(names, harness)}`;
}
/** The message of a resume refused for a changed value (E_LAUNCH_ENV_CHANGED): names only, sorted. */
export function launchEnvChangedMessage(names) {
  return `this home's launch environment changed since its last start (${[...names].sort().join(", ")}); nothing was started: start it yourself to use the new values`;
}
/** The warning of a resume whose launch environment has no record to check against. */
export function launchEnvUnverifiedWarning(instance) {
  return `${instance}'s launch environment could not be verified this once (it was last started before OATS recorded it); its next start records it`;
}

/** The home's key, or null when there is none, it cannot be read, or it is not 32 bytes. */
function readKey(home) {
  try {
    const key = readFileSync(join(home, START_ENV_KEY_FILE));
    return key.length === KEY_BYTES ? key : null;
  } catch { return null; }
}
const digestOf = (key, value) => createHmac("sha256", key).update(String(value), "utf8").digest("hex");

/** `bytes` to `path` through a new temporary file beside it (O_EXCL, mode 0600), then renamed over
 *  it: the file is either the old one or the whole new one. */
function writeWhole(path, bytes) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(tmp, bytes, { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* the failure is the one to report */ }
    throw e;
  }
}

/** Record the launch environment of start `startId` of `home`: the digest of each of `names` (source
 *  names, fromEnvNames or launchEnvRefs source fields) as `env` holds it. A home without a usable key gets a new one first, and its
 *  old record goes before the key is replaced, so no record is ever read with a key it was not made
 *  with. Never throws: → true when the record was written. */
export function recordStartEnv(home, startId, names, env) {
  try {
    let key = readKey(home);
    if (!key) {
      rmSync(join(home, START_ENV_FILE), { force: true });
      key = randomBytes(KEY_BYTES);
      writeWhole(join(home, START_ENV_KEY_FILE), key);
    }
    // No prototype: every valid source name, `__proto__` included, is an entry of its own.
    const digests = Object.create(null);
    for (const name of names) if (env[name] !== undefined) digests[name] = digestOf(key, env[name]);
    writeWhole(join(home, START_ENV_FILE), JSON.stringify({ startId, digests }, null, 2) + "\n");
    return true;
  } catch { return false; }
}

/** Whether `env` gives `names` (the references of the launch a resume runs) the values start
 *  `startId` of `home` recorded. Reads only: it never makes a key or a record. → `{ ok: true }`;
 *  `{ changed: [names] }`, sorted: a name whose value differs, is now unset, or is on one side only;
 *  or `{ unverified: true }`: no record, a record of another start, one that does not read, or no
 *  usable key. Never throws. */
export function checkStartEnv(home, startId, names, env) {
  let record;
  try {
    const text = readFileSync(join(home, START_ENV_FILE));
    if (text.length > RECORD_MAX) return { unverified: true };
    record = JSON.parse(text.toString("utf8"));
  } catch { return { unverified: true }; }
  if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.startId !== "string" || !record.startId || record.startId !== startId) return { unverified: true };
  const digests = record.digests;
  if (!digests || typeof digests !== "object" || Array.isArray(digests) || Object.values(digests).some((d) => typeof d !== "string" || !DIGEST.test(d))) return { unverified: true };
  const key = readKey(home);
  if (!key) return { unverified: true };
  const changed = [];
  for (const name of new Set([...Object.keys(digests), ...names])) {
    if (!Object.hasOwn(digests, name) || !names.includes(name) || env[name] === undefined) { changed.push(name); continue; }
    const now = Buffer.from(digestOf(key, env[name]), "hex"), then = Buffer.from(digests[name], "hex");
    if (!timingSafeEqual(now, then)) changed.push(name);
  }
  return changed.length ? { changed: changed.sort() } : { ok: true };
}
