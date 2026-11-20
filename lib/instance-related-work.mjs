/** The "related work" flag (feature instance-related-work, awebai/oats#1577 renamed): an instance's declared
 *  "related work" with the instance it is bound to, its parent or its sibling, which clients draw as a line
 *  between the two. A home file of its own, `<home>/.oats-related-work.json`, so that a start, restart, stop or
 *  resume, which rewrite instance.json, never lose it; only `oats instance related-work … off` or retirement
 *  removes it. The kernel never sets it on its own: only `oats spawn --related-work` and the verb do.
 *
 *  The flag is BOUND to the relation it was set against: the home's recorded `parentInstance` when it has
 *  one, else its recorded `siblingInstance` (relatedWorkBinding, the one choice). The record names that
 *  instance and the kind of edge, and the flag is on only while that edge is still the home's
 *  (relatedWorkOf, the one rule). A relink that changes the relation (a retire's splice, a `--relation
 *  parent` spawn re-pointing its anchor) leaves the record bound to the old name, so the flag reads off and
 *  nothing errors. A sibling binding names the sibling the home records: for a sibling of a root, that root;
 *  for a sibling of a sibling, the anchor it was spawned beside (lib/core.mjs records the anchor itself).
 *
 *  The record is `{ relatedWorkApi: 1, parent | sibling, at }`, exactly one of `parent` and `sibling`,
 *  written atomically (writeThroughPrivateFile) at mode 0600; present means on. A reader takes a regular file
 *  only, without following a link, up to RECORD_MAX bytes: anything that is not a valid record reads as no
 *  binding (null), never an error.
 *
 *  The same-work flag this replaces (`.oats-same-work.json`) is not read: an existing one reads off, and is
 *  left where it is (a file the kernel does not read, it does not delete). Its name stays kernel-owned
 *  (lib/capability-contract.mjs KERNEL_HOME_NAME_PREFIXES, lib/core.mjs KERNEL_HOME_RECEIPTS, the manifest
 *  schema), so no capability can claim it. Dependency-free: the status rows, spawn and the command all go
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
/** The file of the same-work flag this one replaced: never read or written, kept kernel-owned. */
export const SAME_WORK_FILE = ".oats-same-work.json";
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

/** The binding `home`'s record holds, `{ parent }` or `{ sibling }`, or null: no file, not a regular file
 *  (a link is never followed), over RECORD_MAX bytes, unreadable, not JSON, another relatedWorkApi, or not
 *  exactly one of a non-empty string `parent` and `sibling`. Never throws. */
export function readRelatedWork(home) {
  try {
    const { bytes, size } = readFileHead(join(home, RELATED_WORK_FILE), RECORD_MAX + 1);
    if (size > RECORD_MAX) return null;
    const record = JSON.parse(bytes.toString("utf8"));
    if (!record || typeof record !== "object" || Array.isArray(record) || record.relatedWorkApi !== RELATED_WORK_API) return null;
    const hasParent = Object.hasOwn(record, "parent"), hasSibling = Object.hasOwn(record, "sibling");
    if (hasParent === hasSibling) return null;
    if (hasParent) return isName(record.parent) ? { parent: record.parent } : null;
    return isName(record.sibling) ? { sibling: record.sibling } : null;
  } catch { return null; }
}

const sameBinding = (a, b) => !!a && !!b && a.parent === b.parent && a.sibling === b.sibling;

/** Bind `home`'s flag to `binding` (`{ parent: <name> }` or `{ sibling: <name> }`), or remove the record when
 *  `binding` is null. → `{ changed }`. A record already holding `binding` is no change: nothing is written.
 *  One holding another binding is rewritten to this one. A removal takes whatever stands at the name (an
 *  unreadable file, a link, a directory) and is a change only when a valid record was there. The caller
 *  decided `binding` (relatedWorkBinding of the home's record) and holds the right to change the home. */
export function writeRelatedWork(home, binding, { now = () => new Date() } = {}) {
  if (binding !== null) {
    const keys = binding && typeof binding === "object" && !Array.isArray(binding) ? Object.keys(binding) : [];
    if (keys.length !== 1 || !["parent", "sibling"].includes(keys[0]) || !isName(binding[keys[0]])) {
      throw new TypeError("writeRelatedWork: binding is { parent: <name> }, { sibling: <name> } or null");
    }
  }
  const path = join(home, RELATED_WORK_FILE);
  const before = readRelatedWork(home);
  if (binding !== null && sameBinding(before, binding)) return { changed: false };
  let present;
  try { present = lstatSync(path); } catch (e) { if (e?.code !== "ENOENT") throw e; }
  // A directory at the name is no record, and a rename cannot replace it: it goes first. A link or a
  // file is replaced by the rename itself, or removed here when the flag is cleared.
  if (present && (binding === null || present.isDirectory())) rmSync(path, { recursive: true, force: true });
  if (binding === null) return { changed: before !== null };
  const bytes = JSON.stringify({ relatedWorkApi: RELATED_WORK_API, ...binding, at: now().toISOString() }) + "\n";
  writeThroughPrivateFile(path, `${path}.tmp-${process.pid}`, bytes, 0o600);
  return { changed: true };
}

/** THE rule: whether `home` does related work, read against the row's current lineage
 *  `{ parentInstance, siblingInstance }`. A parent binding holds only while its name is the current
 *  `parentInstance`; a sibling binding only while the row records no parent and its name is the current
 *  `siblingInstance`. No record, or any other lineage: false. */
export function relatedWorkOf(home, lineage) {
  const bound = readRelatedWork(home);
  return bound !== null && sameBinding(bound, relatedWorkBinding(lineage));
}
