/** The "related work" flag (feature instance-related-work; the same-work flag of awebai/oats#1577, renamed):
 *  an instance's declared "related work" with the instance it is bound to, its parent or its sibling, which
 *  clients draw as a line between the two. A home file of its own, `<home>/.oats-related-work.json`, so that a
 *  start, restart, stop or resume, which rewrite instance.json, never lose it; only `oats instance
 *  related-work … off` or retirement removes it. The kernel never sets it on its own: only `oats spawn
 *  --related-work` and the verb do (and their deprecated aliases, `--same-work` and `oats instance same-work`).
 *
 *  The flag is BOUND to the relation it was set against: the home's recorded `parentInstance` when it has
 *  one, else its recorded `siblingInstance` (relatedWorkBinding, the one choice). The record names that
 *  instance and the kind of edge, and the flag is on only while that edge is still the home's
 *  (relatedWorkHeld, the one rule). A relink that changes the relation (a retire's splice, a `--relation
 *  parent` spawn re-pointing its anchor) leaves the record bound to the old name, so the flag reads off and
 *  nothing errors. A sibling binding names the sibling the home records: for a sibling of a root, that root;
 *  for a sibling of a sibling, the anchor it was spawned beside (lib/core.mjs records the anchor itself).
 *
 *  The record is `{ relatedWorkApi: 1, parent | sibling, at }`, exactly one of `parent` and `sibling`,
 *  written atomically (writeThroughPrivateFile) at mode 0600; present means on. A reader takes a regular file
 *  only, without following a link, up to RECORD_MAX bytes: anything that is not a valid record reads as no
 *  binding (null), never an error.
 *
 *  The compatibility layer with the same-work flag it replaced (item 4 of the related-work contract), all of
 *  it in this module and its callers named here: the old home file `.oats-same-work.json`,
 *  `{ sameWorkApi: 1, parent, at }`, reads as a parent binding while nothing stands at the new name
 *  (readRelatedWork); the write that creates the new file removes the old one, and a removal takes both
 *  (writeRelatedWork). Both names are kernel-owned (lib/capability-contract.mjs KERNEL_HOME_NAME_PREFIXES,
 *  lib/core.mjs KERNEL_HOME_RECEIPTS, the manifest schema). The old row field `sameWork: true` stands beside
 *  `relatedWork: true` for a parent binding (lib/instance-listing.mjs), and the old spellings are aliases
 *  (lib/command-flags.mjs SAME_WORK_ALIASES). Dependency-free: the status rows, spawn and the command all go
 *  through here. */
import { lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readFileHead } from "./bounded-read.mjs";
import { writeThroughPrivateFile } from "./write-through-private-file.mjs";

/** The record's own version. */
export const RELATED_WORK_API = 1;
/** The home file, kernel-owned: in KERNEL_HOME_NAME_PREFIXES (lib/capability-contract.mjs), the retire
 *  fingerprint's receipts (lib/core.mjs KERNEL_HOME_RECEIPTS) and the manifest schema. */
export const RELATED_WORK_FILE = ".oats-related-work.json";
/** The file of the same-work flag the new one replaced: read while the new one is absent, never written,
 *  removed by the write that creates the new one and by a removal; kernel-owned. */
export const SAME_WORK_FILE = ".oats-same-work.json";
/** The old record's own version. */
const SAME_WORK_API = 1;
/** A record larger than this is not one. */
export const RECORD_MAX = 4096;

const isName = (v) => typeof v === "string" && v !== "";

/** The binding a home with lineage `{ parentInstance, siblingInstance }` (its instance.json, or a spawn's
 *  lineage before it is written) takes: `{ parent }` when it records a parent, else `{ sibling }` when it
 *  records a sibling, else null (no flag can be set). The one choice: spawn, the verb and the route ask it. */
export function relatedWorkBinding(lineage) {
  if (isName(lineage?.parentInstance)) return { parent: lineage.parentInstance };
  if (isName(lineage?.siblingInstance)) return { sibling: lineage.siblingInstance };
  return null;
}

/** The JSON object in the file at `path`, or null: no file, not a regular file (a link is never followed),
 *  over RECORD_MAX bytes, unreadable, not a JSON object. Never throws. */
function readRecord(path) {
  try {
    const { bytes, size } = readFileHead(path, RECORD_MAX + 1);
    if (size > RECORD_MAX) return null;
    const record = JSON.parse(bytes.toString("utf8"));
    return record && typeof record === "object" && !Array.isArray(record) ? record : null;
  } catch { return null; }
}

/** Whether anything at all stands at `path` (a file, a link, a directory, one that can't be read). */
function standsAt(path) {
  try { lstatSync(path); return true; } catch (e) { return e?.code !== "ENOENT"; }
}

/** The binding `home`'s record holds, `{ parent }` or `{ sibling }`, or null. The new record, while anything
 *  stands at its name: null when it is not a record (readRecord), another relatedWorkApi, or not exactly one
 *  of a non-empty string `parent` and `sibling`. With nothing at the new name, the old same-work record, as
 *  a parent binding: null when it is not a record, another sameWorkApi, or no non-empty string `parent`.
 *  The one read of both files. Never throws. */
export function readRelatedWork(home) {
  const path = join(home, RELATED_WORK_FILE);
  if (!standsAt(path)) {
    const old = readRecord(join(home, SAME_WORK_FILE));
    return old?.sameWorkApi === SAME_WORK_API && isName(old.parent) ? { parent: old.parent } : null;
  }
  const record = readRecord(path);
  if (!record || record.relatedWorkApi !== RELATED_WORK_API) return null;
  const hasParent = Object.hasOwn(record, "parent"), hasSibling = Object.hasOwn(record, "sibling");
  if (hasParent === hasSibling) return null;
  if (hasParent) return isName(record.parent) ? { parent: record.parent } : null;
  return isName(record.sibling) ? { sibling: record.sibling } : null;
}

const sameBinding = (a, b) => !!a && !!b && a.parent === b.parent && a.sibling === b.sibling;

/** Remove whatever stands at `path` (a file, a link, a directory), and nothing when nothing does. */
const removeAt = (path) => { if (standsAt(path)) rmSync(path, { recursive: true, force: true }); };

/** Bind `home`'s flag to `binding` (`{ parent: <name> }` or `{ sibling: <name> }`), or remove it when
 *  `binding` is null. → `{ changed }`. A home already holding `binding` (readRelatedWork: from either file)
 *  is no change: nothing is written. Otherwise the new record is written, and the old same-work file, if
 *  anything stands at its name, is removed after it. A removal takes whatever stands at either name (an
 *  unreadable file, a link, a directory), and is a change only when a valid binding was read. The caller
 *  decided `binding` (relatedWorkBinding of the home's record) and holds the right to change the home. */
export function writeRelatedWork(home, binding, { now = () => new Date() } = {}) {
  if (binding !== null) {
    const keys = binding && typeof binding === "object" && !Array.isArray(binding) ? Object.keys(binding) : [];
    if (keys.length !== 1 || !["parent", "sibling"].includes(keys[0]) || !isName(binding[keys[0]])) {
      throw new TypeError("writeRelatedWork: binding is { parent: <name> }, { sibling: <name> } or null");
    }
  }
  const path = join(home, RELATED_WORK_FILE), oldPath = join(home, SAME_WORK_FILE);
  const before = readRelatedWork(home);
  if (binding !== null && sameBinding(before, binding)) return { changed: false };
  if (binding === null) {
    removeAt(path);
    removeAt(oldPath);
    return { changed: before !== null };
  }
  // A directory at the name is no record, and a rename cannot replace it: it goes first. A link or a file
  // is replaced by the rename itself.
  let present;
  try { present = lstatSync(path); } catch (e) { if (e?.code !== "ENOENT") throw e; }
  if (present?.isDirectory()) rmSync(path, { recursive: true, force: true });
  const bytes = JSON.stringify({ relatedWorkApi: RELATED_WORK_API, ...binding, at: now().toISOString() }) + "\n";
  writeThroughPrivateFile(path, `${path}.tmp-${process.pid}`, bytes, 0o600);
  // The new record stands: the old one would never be read again.
  removeAt(oldPath);
  return { changed: true };
}

/** THE rule: the binding of `home` that holds against the row's current lineage `{ parentInstance,
 *  siblingInstance }`, or null. A parent binding holds only while its name is the current `parentInstance`;
 *  a sibling binding only while the row records no parent and its name is the current `siblingInstance`. */
export function relatedWorkHeld(home, lineage) {
  const bound = readRelatedWork(home);
  return bound !== null && sameBinding(bound, relatedWorkBinding(lineage)) ? bound : null;
}

/** Whether `home` does related work, by the rule (relatedWorkHeld). */
export function relatedWorkOf(home, lineage) {
  return relatedWorkHeld(home, lineage) !== null;
}
