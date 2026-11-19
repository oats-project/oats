/** Whether an instance is pinned (feature instance-pin): presentation like the colour
 *  (lib/instance-color.mjs) and background (lib/instance-background.mjs), never identity or policy. A client
 *  of the machine lists a pinned instance at the top of its list; nothing else about the instance changes.
 *  The pin is the home's, so it is shared: everyone who views that machine sees it. It is a home file of
 *  its own, `<home>/.oats-pinned.json`, so that a start or restart, which rewrites instance.json, can never
 *  lose it, and retire removes it with the home.
 *
 *  The record is `{ pinnedApi: 1, at }` (present means pinned), written atomically (writeThroughPrivateFile)
 *  at mode 0600; absent means not pinned, and `off` removes the file. A reader takes a regular file only,
 *  without following a link, up to RECORD_MAX bytes: anything that is not a valid record reads as not
 *  pinned (false), never an error. Dependency-free: the status rows, inspect and the command all read and
 *  write it through here. */
import { lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readFileHead } from "./bounded-read.mjs";
import { writeThroughPrivateFile } from "./write-through-private-file.mjs";

/** The record's own version, and the command answer's. */
export const PIN_API = 1;
export const INSTANCE_PIN_API = 1;
/** The home file, kernel-owned: in KERNEL_HOME_NAME_PREFIXES (lib/capability-contract.mjs), the retire
 *  fingerprint's receipts (lib/core.mjs KERNEL_HOME_RECEIPTS) and the manifest schema. */
export const PIN_FILE = ".oats-pinned.json";
/** A record larger than this is not one. */
export const RECORD_MAX = 4096;

/** Whether `home` records itself pinned: false for no file, not a regular file (a link is never followed),
 *  over RECORD_MAX bytes, unreadable, not a JSON object or another pinnedApi. Never throws. */
export function readInstancePin(home) {
  try {
    const { bytes, size } = readFileHead(join(home, PIN_FILE), RECORD_MAX + 1);
    if (size > RECORD_MAX) return false;
    const record = JSON.parse(bytes.toString("utf8"));
    return !!record && typeof record === "object" && !Array.isArray(record) && record.pinnedApi === PIN_API;
  } catch { return false; }
}

/** Pin `home` (`on` true), or remove its pin (`on` false). → `{ pinned, changed }`. A home already pinned is
 *  no change: nothing is written. `off` removes whatever stands at the name (a link or an invalid record
 *  included) and is a change only when the home read as pinned. The caller holds the right to change the
 *  home. */
export function writeInstancePin(home, on, { now = () => new Date() } = {}) {
  const path = join(home, PIN_FILE);
  const before = readInstancePin(home);
  // What stands at the name, never followed: null for nothing. The name is kernel-owned, so a directory
  // there is no one's work: `off` removes it, and `on` removes it before the record is renamed into place
  // (a rename cannot replace a directory).
  let standing = null;
  try { standing = lstatSync(path); } catch (e) { if (e?.code !== "ENOENT") throw e; }
  if (!on) {
    if (standing) rmSync(path, { force: true, recursive: standing.isDirectory() });
    return { pinned: false, changed: before };
  }
  if (before) return { pinned: true, changed: false };
  if (standing?.isDirectory()) rmSync(path, { force: true, recursive: true });
  const bytes = JSON.stringify({ pinnedApi: PIN_API, at: now().toISOString() }) + "\n";
  writeThroughPrivateFile(path, `${path}.tmp-${process.pid}`, bytes, 0o600);
  return { pinned: true, changed: true };
}
