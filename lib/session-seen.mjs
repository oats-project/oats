/** What the kernel has seen of each launched home's session (feature session-resume, #1559;
 *  awebai/oats#1567 item 3): the record the sweep reads so that it resumes only a loss it can vouch
 *  for. Kernel-private, not a contract, under OATS_HOME_DIR beside the per-boot note: one file per
 *  deployment, `session-resume/seen/<first 16 hex of sha256(instances root)>.json`,
 *    { deployment, root, homes: { <home's real path>: { startId, lastSeenRunningAt, lastSeenRunningBoot,
 *      firstNotRunningAt, firstNotRunningBoot, judgedBy } } }
 *  (times ISO; boots bootId's, null without one; `judgedBy` `{ at, boot, outcome }` or null).
 *
 *  - Observations have one producer, a local `listInstances` (`oats status`, the sweep's own read
 *    and every other local listing): recordSeen. A status routed to another machine reads nothing
 *    here; a start writes nothing.
 *  - `judgedBy` has one writer, a sweep that is not a plan (judgeLosses), once its rows are known:
 *    a status read never uses up a loss.
 *  - Never in the way of what reads it: an unreadable file is an empty record (which resumes
 *    nothing), every write error is swallowed and nothing is printed. A write is one atomic rename
 *    of the whole file, made only when something changed; two writers race harmlessly (the last
 *    rename wins whole).
 *  - Whether a loss is resumed is one pure function, resumeEligible.
 *  Dependency-free. */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { thisBoot } from "../packages/record/lib/process-identity.mjs";

export { bootId, takenInAnotherBoot, thisBoot } from "../packages/record/lib/process-identity.mjs";

/** A loss first seen this long ago or more is not resumed. */
export const FIRST_SEEN_MAX_MS = 24 * 60 * 60_000;
/** Within one boot, a loss first seen this long or more after the last running look is not resumed. */
export const WITHIN_BOOT_GAP_MS = 24 * 60 * 60_000;
/** A running home's last running look is rewritten at most this often in one boot. */
export const RUNNING_REFRESH_MS = 10 * 60_000;

const oatsHomeDir = () => process.env.OATS_HOME_DIR || join(homedir(), ".oats");
/** The kernel-private directory of the sweep's lock, its per-boot note and this record. */
export const resumeStateDir = () => join(oatsHomeDir(), "session-resume");

const realOrResolved = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
/** The key of `home` in a record: its real path, so a deployment reached through a symlink (an
 *  explicit `--deployment` spelled so, a cwd under one) reads and writes the same entry. */
export const homeKey = (home) => realOrResolved(home);
/** The record file of the deployment whose instances root is `root` (its real path, the same way). */
export function seenFile(root) {
  return join(resumeStateDir(), "seen", `${createHash("sha256").update(realOrResolved(root)).digest("hex").slice(0, 16)}.json`);
}

/** The record of `root` → `{ homes, readable }`: no file is an empty, readable record; a file that
 *  cannot be read or parsed is an empty, unreadable one (rewritten whole by the next change). */
export function readSeen(root) {
  let text;
  try { text = readFileSync(seenFile(root), "utf8"); }
  catch (e) { return { homes: {}, readable: e?.code === "ENOENT" }; }
  try {
    const doc = JSON.parse(text);
    if (!doc || typeof doc !== "object" || !doc.homes || typeof doc.homes !== "object" || Array.isArray(doc.homes)) return { homes: {}, readable: false };
    const homes = {};
    for (const [home, r] of Object.entries(doc.homes)) if (r && typeof r === "object" && !Array.isArray(r)) homes[home] = r;
    return { homes, readable: true };
  } catch { return { homes: {}, readable: false }; }
}
function writeSeen(root, homes) {
  const path = seenFile(root), tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const real = realOrResolved(root);
    writeFileSync(tmp, JSON.stringify({ deployment: dirname(real), root: real, homes }, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
  } catch { try { rmSync(tmp, { force: true }); } catch { /* nothing to remove */ } }
}

const startIdOf = (row) => (typeof row?.startId === "string" && row.startId ? row.startId : null);

/** The record after one listing of `rows` (status rows) at `now` in `boot` → `{ homes, changed }`.
 *  Per row:
 *   - running, another start or no record: a new record, seen running now (a new start resets it);
 *   - running, the same start: its last running look moves to now when it is RUNNING_REFRESH_MS old
 *     or more, or from another boot;
 *   - not running, launched, the same start, no loss seen yet: the loss is first seen now (once);
 *   - running unknown (null): unchanged.
 *  A home no longer listed is dropped. Pure. */
export function nextSeen(homes, rows, { now, boot }) {
  const at = new Date(now).toISOString(), out = {};
  let changed = false;
  for (const row of rows) {
    if (typeof row?.home !== "string") continue;
    const prior = homes[row.home], startId = startIdOf(row);
    let next = prior;
    if (row.running === true) {
      if (!prior || prior.startId !== startId) next = { startId, lastSeenRunningAt: at, lastSeenRunningBoot: boot, firstNotRunningAt: null, firstNotRunningBoot: null, judgedBy: null };
      else if (!(now - Date.parse(prior.lastSeenRunningAt) < RUNNING_REFRESH_MS) || prior.lastSeenRunningBoot !== boot) next = { ...prior, lastSeenRunningAt: at, lastSeenRunningBoot: boot };
    } else if (row.running === false && row.launched === true && prior && prior.startId === startId && !prior.firstNotRunningAt) {
      next = { ...prior, firstNotRunningAt: at, firstNotRunningBoot: boot };
    }
    if (next) out[row.home] = next;
    if (next !== prior) changed = true;
  }
  if (Object.keys(homes).some((home) => !Object.hasOwn(out, home))) changed = true;
  return { homes: out, changed };
}

/** Record one local listing of `root`'s homes (listInstances, its every row). Never throws, never
 *  prints: what reads the listing answers the same whatever happens here. */
export function recordSeen(root, rows, { now = Date.now(), boot = thisBoot() } = {}) {
  try {
    const before = readSeen(root);
    const { homes, changed } = nextSeen(before.homes, rows.map((row) => ({ ...row, home: typeof row?.home === "string" ? homeKey(row.home) : row?.home })), { now, boot });
    if (changed || !before.readable) writeSeen(root, homes);
  } catch { /* the record is the sweep's, never the reader's problem */ }
}

/** A sweep's answers for the lost homes of `root` (`[{ home, startId, outcome }]`), written once
 *  into each home's record as `judgedBy`, when the record is of that start and not judged yet: the
 *  file is read again just before the write, so a status write in between is kept. A `judgedBy` lost
 *  to a status write that renames over this one is harmless: a resumed home has a new start id; a
 *  refused one is still held by the per-boot refusal note; a skipped or blocked one is judged the
 *  same again. Never throws. */
export function judgeLosses(root, judged, { now = Date.now(), boot = thisBoot() } = {}) {
  try {
    const { homes } = readSeen(root);
    let changed = false;
    for (const { home, startId, outcome } of judged) {
      const key = homeKey(home), r = homes[key];
      if (!r || r.startId !== (startId ?? null) || r.judgedBy) continue;
      homes[key] = { ...r, judgedBy: { at: new Date(now).toISOString(), boot, outcome } };
      changed = true;
    }
    if (changed) writeSeen(root, homes);
  } catch { /* best effort: see above */ }
}

/** Whether the sweep resumes the lost home of `row` (a status row) on its `record`, at `now` in
 *  `boot` → `{ eligible: true }` or `{ eligible: false, why }`. All four must hold:
 *   1. the record saw it running for its current start;
 *   2. no earlier sweep judged this loss (`judgedBy`);
 *   3. the loss was first seen less than FIRST_SEEN_MAX_MS ago;
 *   4. within one boot (both looks in the same boot, or either without a boot id), the last running
 *      look is less than WITHIN_BOOT_GAP_MS before the first not-running look. Across a reboot it
 *      does not apply.
 *  The rule reads the boots the record holds, not this one's. Pure. */
export function resumeEligible(record, row, { now }) {
  const no = (why) => ({ eligible: false, why });
  const lastRunning = Date.parse(record?.lastSeenRunningAt);
  if (!record || record.startId !== startIdOf(row) || !Number.isFinite(lastRunning)) return no("OATS never saw it running for its current start");
  if (record.judgedBy) return no(`an earlier sweep already answered this loss (${record.judgedBy.outcome ?? "answered"}${record.judgedBy.at ? ` at ${record.judgedBy.at}` : ""})`);
  const firstLost = Date.parse(record.firstNotRunningAt);
  if (!Number.isFinite(firstLost)) return no("OATS has not seen it stop since it last saw it running");
  if (now - firstLost >= FIRST_SEEN_MAX_MS) return no(`its loss was first seen ${record.firstNotRunningAt}, 24 hours ago or more`);
  const oneBoot = !record.lastSeenRunningBoot || !record.firstNotRunningBoot || record.lastSeenRunningBoot === record.firstNotRunningBoot;
  if (oneBoot && firstLost - lastRunning >= WITHIN_BOOT_GAP_MS) return no(`in the boot it was lost in, it was last seen running ${record.lastSeenRunningAt}, 24 hours or more before its loss was seen`);
  return { eligible: true };
}
