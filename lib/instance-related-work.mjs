/** The "same work" flag (feature instance-same-work, awebai/oats#1577): a child instance's declared
 *  "same work as my parent", which clients draw as the parent→child line. A home file of its own,
 *  `<home>/.oats-same-work.json`, so that a start, restart, stop or resume, which rewrite instance.json,
 *  never lose it; only `oats instance same-work … off` or retirement removes it.
 *
 *  The flag is BOUND to the parent it was set against: the record names that parent, and the flag is on
 *  only while it is still the home's recorded `parentInstance` (sameWorkOf, the one rule). A reparent (a
 *  retire's relink, a `--relation parent` spawn re-pointing its anchor) leaves the record bound to the
 *  old name, so the flag reads off and nothing errors.
 *
 *  The record is `{ sameWorkApi: 1, parent, at }`, written atomically (writeThroughPrivateFile) at mode
 *  0600; present means on. A reader takes a regular file only, without following a link, up to
 *  RECORD_MAX bytes: anything that is not a valid record reads as no binding (null), never an error.
 *  Dependency-free: the status rows, spawn and the command all go through here. */
import { lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readFileHead } from "./bounded-read.mjs";
import { writeThroughPrivateFile } from "./write-through-private-file.mjs";

/** The record's own version. */
export const SAME_WORK_API = 1;
/** The home file, kernel-owned: in KERNEL_HOME_NAME_PREFIXES (lib/capability-contract.mjs), the retire
 *  fingerprint's receipts (lib/core.mjs KERNEL_HOME_RECEIPTS) and the manifest schema. */
export const SAME_WORK_FILE = ".oats-same-work.json";
/** A record larger than this is not one. */
export const RECORD_MAX = 4096;

/** The parent `home`'s record is bound to, or null: no file, not a regular file (a link is never
 *  followed), over RECORD_MAX bytes, unreadable, not JSON, another sameWorkApi or no non-empty string
 *  `parent`. Never throws. */
export function readSameWork(home) {
  try {
    const { bytes, size } = readFileHead(join(home, SAME_WORK_FILE), RECORD_MAX + 1);
    if (size > RECORD_MAX) return null;
    const record = JSON.parse(bytes.toString("utf8"));
    if (!record || typeof record !== "object" || Array.isArray(record) || record.sameWorkApi !== SAME_WORK_API) return null;
    return typeof record.parent === "string" && record.parent !== "" ? record.parent : null;
  } catch { return null; }
}

/** Bind `home`'s flag to `parent` (an instance name), or remove the record when `parent` is null.
 *  → `{ changed }`. A record already bound to `parent` is no change: nothing is written. One bound to
 *  another (old) parent is rewritten to this one. A removal takes whatever stands at the name (an
 *  unreadable file, a link, a directory) and is a change only when a valid record was there. The caller
 *  decided `parent` (the home's recorded parentInstance) and holds the right to change the home. */
export function writeSameWork(home, parent, { now = () => new Date() } = {}) {
  if (parent !== null && (typeof parent !== "string" || parent === "")) throw new TypeError("writeSameWork: parent is an instance name or null");
  const path = join(home, SAME_WORK_FILE);
  const before = readSameWork(home);
  if (parent !== null && before === parent) return { changed: false };
  let present;
  try { present = lstatSync(path); } catch (e) { if (e?.code !== "ENOENT") throw e; }
  // A directory at the name is no record, and a rename cannot replace it: it goes first. A link or a
  // file is replaced by the rename itself, or removed here when the flag is cleared.
  if (present && (parent === null || present.isDirectory())) rmSync(path, { recursive: true, force: true });
  if (parent === null) return { changed: before !== null };
  const bytes = JSON.stringify({ sameWorkApi: SAME_WORK_API, parent, at: now().toISOString() }) + "\n";
  writeThroughPrivateFile(path, `${path}.tmp-${process.pid}`, bytes, 0o600);
  return { changed: true };
}

/** THE rule: whether `home` does the same work as its parent, read against the row's current
 *  `parentInstance` (a non-empty string, else false): true only when the record is bound to exactly it. */
export function sameWorkOf(home, parentInstance) {
  if (typeof parentInstance !== "string" || parentInstance === "") return false;
  return readSameWork(home) === parentInstance;
}
