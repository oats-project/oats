/** A home's independent receipt (its retirement baseline, which is also its session receipt): where
 *  it is kept, outside the home, and how a home is told from another. A leaf, with nothing of the
 *  kernel above it, so that whatever must read a receipt can (lib/session-inspect.mjs reads a
 *  home's session by it; lib/home-integrity.mjs reads what a provider home may run). */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalHomePath, realPathOrNearest } from "./real-path.mjs";

export function isPlainObject(v) { return !!v && typeof v === "object" && !Array.isArray(v); }
export function readJsonOrUndefined(path) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; } }

// The stored digests are versioned apart (`digestVersion`, BASELINE_DIGEST_VERSION): this version
// also gates runtime, directory-home and provider-exclusion authority, so a bump would refuse them all.
export const RETIRE_BASELINE_VERSION = 2;

export function retirementStateRoot(home) {
  // Independent of the bytes it authenticates, but colocated with the agent's
  // already instance-owned storage rather than the source repository or user
  // config home. Retiring <instances>/<name> never removes this sibling.
  return instancesRetirementRoot(dirname(home));
}
/** The retirement state of the homes in the instances directory `instances`. */
export function instancesRetirementRoot(instances) {
  return join(instances, ".oats-retirement");
}

/** A home's identity as a receipt records it: its on-disk spelling, own name included. A home that
 *  is a symlink is not followed: its parent's on-disk spelling and its name as given (a home
 *  exchanged for a symlink is not the home it points at). */
export function receiptHomeIdentity(home) {
  let st;
  try { st = lstatSync(home); } catch { /* not there: spelled as the nearest existing ancestor */ }
  return st && !st.isSymbolicLink() ? canonicalHomePath(home) : join(canonicalHomePath(dirname(home)), basename(home));
}

/** Whether a receipt's recorded home is this home, whatever spelling either was written in.
 *  `current` is the home as the caller resolves it for the comparison. */
export function receiptRecordsHome(baseline, current) {
  return typeof baseline?.home === "string" && receiptHomeIdentity(baseline.home) === current;
}

export function retirementBaselineFile(identity) {
  return join(retirementStateRoot(identity), "baselines", `${createHash("sha256").update(identity).digest("hex")}.json`);
}

/** Where a spawn writes a home's receipt: keyed by its canonical identity. */
export function retirementBaselinePath(home) {
  return retirementBaselineFile(receiptHomeIdentity(home));
}

/** Where a kernel before 0.49.0 wrote it: keyed by the parent's realpath in the spawn's own
 *  spelling, which on a case-insensitive filesystem need not be the on-disk one. */
export function legacyRetirementBaselinePath(home) {
  return retirementBaselineFile(join(realPathOrNearest(dirname(home)), basename(home)));
}

/** The receipt every reader uses: the canonical one if it exists, else one an earlier kernel left
 *  under this caller's spelling, else the canonical path (absent). Read-only: a receipt found at the
 *  legacy key is used where it is, never moved, copied or rewritten elsewhere.
 *
 *  Limits. A legacy receipt written under spelling S is found only from S, or from the canonical
 *  spelling when that is S: a third spelling of such a home misses it (address the home as
 *  `oats status` prints it, the spawn's spelling). Receipts outlive retire, so a reused name can
 *  leave an earlier incarnation's receipt behind; the canonical one wins, which is right for every
 *  home spawned from 0.49.0 on. It is wrong in one case: two incarnations of the same name, both
 *  spawned by a kernel before 0.49.0 under different spellings, the earlier one under the canonical
 *  spelling. The later home then reads the earlier one's receipt. Its stale endpoint disagrees with
 *  instance.json (E_RUNTIME_AUTHORITY_MISMATCH) unless the later incarnation sits at the same
 *  endpoint, where session control already targets the right session. Retire finds the home
 *  fingerprint changed and preserves the home, less the stale receipt's disposable roots; a
 *  directory-work disagreement is E_WORK_INSPECTION_FAILED; and a start's record rewrites the stale
 *  file, as a kernel before 0.49.0 already does when a caller's spelling matches an earlier
 *  incarnation's. */
export function findRetirementBaseline(home) {
  const canonical = retirementBaselinePath(home);
  if (existsSync(canonical)) return canonical;
  const legacy = legacyRetirementBaselinePath(home);
  return legacy !== canonical && existsSync(legacy) ? legacy : canonical;
}
