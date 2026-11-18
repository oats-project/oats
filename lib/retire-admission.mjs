// Internal lifecycle admission shared by Remove plans and retire apply.
// The record and cleanup readers live here; core re-exports only its existing API.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { directoryRollbackPath, isCapturedHome, readHomeRecord, unreadableRecordSaid } from "./instance-listing.mjs";
import { isPlainObject } from "./session-inspect.mjs";
import { processLiveness } from "./worktree-hooks.mjs";
import { lifecycleBusy, oatsError } from "./errors.mjs";

/** The work modes spawn accepts — also the enum a quarantine cleanup descriptor
 * must satisfy, so the retry cannot skip Git cleanup on an unrecognised value. */
export const WORK_MODES = ["worktree", "checkout", "attached", "workspace", "directory"];
/** The quarantine cleanup-descriptor contract version. Bump when the shape the
 * retry consumes changes, so an older/newer marker fails closed instead of
 * driving a retry that cannot do what it claims.
 *
 * The rule applies from the first RELEASE of this shape onward. Markers are only
 * ever written when a `required` spawn hook fails, and required hooks do not
 * exist in any released kernel — so no deployment can hold a marker of an earlier
 * v1 shape, and there is nothing to migrate from. A migration path for a file
 * that has never existed would be dead code claiming to protect real data. */
export const QUARANTINE_CLEANUP_VERSION = 1;
/** The rollback-owned Git steps a quarantine can still owe. */
export const QUARANTINE_GIT_DEBT = ["worktree", "branch"];


/** The refusal of a lifecycle verb (retire, stop, session start) for a home whose record is there
 *  and cannot be read: E_UNIDENTIFIED_INSTANCE_HOME, with the file, the reason, `nothing` (what the
 *  verb had done by then: nothing; a spawn that names the home says "nothing was spawned") and the
 *  one remedy that exists. Every caller raises it before any effect: a client reads this code from
 *  a stop or a retire as "refused, nothing happened". `--force` does not apply to it: it removes a
 *  home that has NO record, never, blind, one whose record cannot be read. */
function unreadableRecordRefusal(record, nothing = "nothing was done") {
  return oatsError("E_UNIDENTIFIED_INSTANCE_HOME", `${unreadableRecordSaid(record)}; ${nothing}. Restoring the file from a copy makes the home usable again; removing such a home through OATS is not possible yet.`);
}
/** The one check a lifecycle verb makes when it has resolved its home, before it takes a claim or
 *  reads anything of the home: a record that cannot be read refuses the verb (unreadableRecordRefusal).
 *  → the record as read (readHomeRecord), a record or an absent one. */
export function identifiedHomeRecord(home, nothing) {
  const record = readHomeRecord(home);
  if (record.state === "unreadable") throw unreadableRecordRefusal(record, nothing);
  return record;
}
export function nonEmptyString(v) { return typeof v === "string" && !!v.trim(); }
export function usableCleanupDescriptor(marker) {
  const c = marker?.cleanup;
  if (!isPlainObject(c)) return false;
  if (c.version !== QUARANTINE_CLEANUP_VERSION) return false;
  if (!nonEmptyString(c.repo)) return false;
  if (!WORK_MODES.includes(c.work)) return false;
  if (c.work === "worktree" && !nonEmptyString(c.branch)) return false;
  if (c.branch !== undefined && !nonEmptyString(c.branch)) return false;
  if (c.capabilityMeta !== undefined && !isPlainObject(c.capabilityMeta)) return false;
  const directoryDebt = c.outstanding?.directory === true && c.work === "directory";
  if (c.outstanding?.directory !== undefined && !directoryDebt) return false;
  // A worktree directory whose git admin entry is gone (awebai/oats#444) is debt too: the retry proves it
  // cleared when the directory is no longer there or has its admin entry back.
  const orphanDebt = c.outstanding?.orphanedWork === true && c.work === "worktree";
  if (c.outstanding?.orphanedWork !== undefined && !orphanDebt) return false;
  if (!Array.isArray(c.capabilityRuntime) || (!c.capabilityRuntime.length && !directoryDebt && !orphanDebt)) return false;
  if (!c.capabilityRuntime.every((cap) => isPlainObject(cap) && nonEmptyString(cap.id))) return false;
  if (!isPlainObject(c.outstanding) || !Array.isArray(c.outstanding.hooks) || !Array.isArray(c.outstanding.git)) return false;
  if (!c.outstanding.hooks.every(nonEmptyString)) return false;
  if (!c.outstanding.git.every((g) => QUARANTINE_GIT_DEBT.includes(g))) return false;
  // Git debt only exists where the rollback owns Git steps, so claiming it in any
  // other work mode describes a quarantine that could not have happened.
  if (c.outstanding.git.length && c.work !== "worktree") return false;
  // The decisive invariant: a quarantine with NOTHING outstanding is a proof
  // obligation of zero. Directory preservation is also real debt: the retry's
  // independent-authority inspection and verified snapshots must succeed even
  // when no capability has a retire hook. It is never a Git/shared-work escape.
  if (!c.outstanding.hooks.length && !c.outstanding.git.length && !directoryDebt && !orphanDebt) return false;
  // The retry must be ABLE to rerun what it must prove: an outstanding hook whose
  // capability is not in the set could never run, so the quarantine would never
  // clear — and the home would be unremovable without --force.
  const known = new Set(c.capabilityRuntime.map((cap) => cap.id));
  if (!c.outstanding.hooks.every((id) => known.has(id))) return false;
  return true;
}

/** The capabilities whose spawn hooks ran in a captured home (its identities, memberships):
 *  retire cannot run their captured retire hooks, so it names them. */
export function capturedHomeCapabilities(meta) {
  const order = Array.isArray(meta?.captured?.hookOrder) ? meta.captured.hookOrder.filter((id) => typeof id === "string") : [];
  const withMeta = meta?.capabilityMeta && typeof meta.capabilityMeta === "object" ? Object.keys(meta.capabilityMeta) : [];
  const intents = isPlainObject(meta?.captured?.hookIntents) ? Object.keys(meta.captured.hookIntents) : [];
  const failures = Array.isArray(meta?.captured?.hookFailures) ? meta.captured.hookFailures.map(failure => failure?.capability).filter(nonEmptyString) : [];
  return [...new Set([...order, ...withMeta, ...intents, ...failures])].sort();
}
/** Read and admit the recorded cleanup before any lifecycle effect. Shared by
 *  Remove plans and every retire apply, including deferred self retirement.
 *  No current deployment configuration can prove an old home created no state.
 *  `readWork` is core's actual instanceWork reader, passed by both callers to
 *  keep the leaf independent of core while preserving its Git repo resolution. */
export function retireCleanupAdmission(home, name, { force = false } = {}, readWork) {
  const metaPath = join(home, "instance.json");
  const directoryFallbackPath = directoryRollbackPath(home);
  const quarantinePath = existsSync(directoryFallbackPath) ? directoryFallbackPath : join(home, ".oats-rollback-incomplete.json");
  let quarantine;
  let markerUnusable = false;
  let rawMarker;
  // A marker means the home is quarantined, WHETHER OR NOT instance.json exists:
  // the post-launch rollback retains a home that already has one, and gating on
  // its absence meant that quarantine was silently ignored — retire took the
  // ordinary path, where hook failures do not retain, and deleted the credential
  // while the external state survived (reviewer-final0130bc8).
  if (existsSync(quarantinePath)) {
    // A marker without a USABLE cleanup descriptor is NOT a quarantine we can
    // retry — it is an unidentified home. Treating an unusable one as retryable
    // made --force unable to ever clear it: the retry could not run, so the home
    // was retained again, forever (reviewer-adff009). "Parses as JSON" is not
    // the bar; "can actually drive the retry" is, so the shape is checked
    // against what the retry below consumes (reviewer-45ff039r2).
    try {
      const parsed = JSON.parse(readFileSync(quarantinePath, "utf8"));
      rawMarker = parsed;
      if (isPlainObject(parsed) && usableCleanupDescriptor(parsed)) quarantine = parsed;
      else markerUnusable = true;
    } catch { markerUnusable = true; }
  }
  // #796: a marker a spawn wrote before its spawn or worktree hooks (`inProgress`). While that spawn's
  // process is verifiably alive it is a spawn in progress, never a quarantine to retry, --force
  // included. Once it is gone, the hook group it left is ended when its leader is alive at the
  // recorded start time; a group whose leader is gone is never signalled, only reported (its id may
  // be another group's by now). The retry below completes the rollback from the marker like any other.
  // Whether that process still runs may also be unreadable (no procfs and `ps` failing): that is never
  // taken for gone. Retire refuses it, naming the recorded pid and start for a check by hand, and the
  // existing forced path (`--force`) is the way out; a forced retry then keeps the spawn's branch.
  // The same holds for a hook group with members whose leader's start cannot be read.
  const spawnGroupWarnings = [];
  let inProgressUnverified = false;
  if (isPlainObject(rawMarker?.inProgress)) {
    const p = rawMarker.inProgress;
    const live = processLiveness(p);
    if (live.state === "alive") throw lifecycleBusy("running", `${name} is still being spawned (pid ${p.pid}, running its hooks since ${p.startedAt ?? "?"}); nothing was retired`, "wait for the spawn to end, or stop that process, then retire");
    if (live.state === "unknown") {
      if (!force) throw lifecycleBusy("unknown", `${name}: whether its spawn (pid ${p.pid}, recorded start ${p.processStart ?? "none"}, running its hooks since ${p.startedAt ?? "?"}) still runs cannot be read (${live.reason}); nothing was retired`,
        `check that pid by hand, and if it is not that spawn, run \`oats retire ${name} --force\``, { pid: p.pid, processStart: p.processStart ?? null, unknown: live.reason, remedy: `oats retire ${name} --force` });
      inProgressUnverified = true;
      spawnGroupWarnings.push(`retired with --force although whether its spawn (pid ${p.pid}) still runs could not be read (${live.reason}); its branch is kept`);
    }
  }
  // The retire's own read of the record, with the same reader as the resolution: one that became
  // unreadable since then refuses as there. It comes before retireSteps' first signal,
  // so E_UNIDENTIFIED_INSTANCE_HOME for an unreadable record is only ever answered
  // while nothing was done: `reached` is untouched ("before-effects").
  const liveMeta = identifiedHomeRecord(home).meta;
  // A quarantined home may carry an instance.json that is NOT the spawn record:
  // module materialization writes a pre-hook stub ({ modules, providers,
  // resolutionRevision }) before the spawn hooks run, and a required-hook
  // failure retains the home with that stub in place. Trusting it over the
  // cleanup descriptor left meta.repo undefined, so the retry never re-ran the
  // owed retire hook and reported "cleanup descriptor lost its context repo"
  // on every attempt — only --force could clear the home (found by an operator
  // rehearsal on 0.25.3). The descriptor is written FOR this retry; a live
  // record only wins when it is a complete spawn record (repo + work present).
  const liveIsSpawnRecord = !!liveMeta && nonEmptyString(liveMeta.repo) && WORK_MODES.includes(liveMeta.work);
  const meta = liveIsSpawnRecord || !quarantine ? (liveMeta || quarantine?.cleanup || {}) : { ...liveMeta, ...quarantine.cleanup };
  // Compensation metadata is the SPAWN's, from whichever record survived — never
  // a failed retry's report, which says nothing about what still needs undoing.
  if (!liveMeta?.capabilityMeta && quarantine?.cleanup?.capabilityMeta) meta.capabilityMeta = quarantine.cleanup.capabilityMeta;
  if (quarantine && typeof quarantine.cleanup.launched === "boolean") {
    meta.launched = quarantine.cleanup.launched;
    meta.tmux = quarantine.cleanup.tmux;
    meta.sessionTarget = quarantine.cleanup.sessionTarget;
  }
  // A home with NEITHER instance.json NOR a usable cleanup descriptor cannot be
  // retired safely: hooks would be skipped and the directory removed, which is
  // the credential deletion the quarantine exists to prevent — and the spawn
  // path tolerates a failed marker write, so this state is reachable. Fail
  // closed; `force` is the deliberate manual-cleanup escape.
  // A marker that cannot drive a retry is not "ignore me" — it is evidence that
  // cleanup was interrupted and OATS cannot tell what remains. Fail closed even
  // when instance.json is present; `--force` is the deliberate manual escape.
  if (markerUnusable && !force) {
    throw oatsError("E_UNIDENTIFIED_INSTANCE_HOME", `${home} carries a rollback marker that cannot drive a retry (unreadable, or missing the cleanup descriptor fields the retry consumes), so OATS cannot tell what external state still depends on this home. Inspect it, then re-run with \`--force\` to remove it anyway.`);
  }
  if (!existsSync(metaPath) && !quarantine && !force) {
    throw oatsError("E_UNIDENTIFIED_INSTANCE_HOME", `${home} has no instance.json and no cleanup descriptor, so OATS cannot tell whether external state (identities, worktrees) still depends on it. Retiring it would delete whatever it holds without running any cleanup. Inspect it, then re-run with \`--force\` to remove it anyway.`);
  }
  // #962: a missing recorded repo does not mean the own worktree has none.
  // Resolve it with exactly the reader the retire uses; keep the raw record
  // untouched so the plan still shows (and binds) its missing-repo fact.
  const workIs = readWork(home, meta);
  const repoFromGit = workIs.is === "own-tree" && !meta.repo ? workIs.tree?.repo : undefined;
  const hookRepo = meta.repo || repoFromGit;
  // Only positive evidence from this record can authorize skipping cleanup.
  const bindings = meta.capabilityRuntime;
  const knownBindings = Array.isArray(bindings) && bindings.every(cap =>
    isPlainObject(cap) && nonEmptyString(cap.id) &&
    (cap.hooks === undefined || isPlainObject(cap.hooks) &&
      (!Object.hasOwn(cap.hooks, "retire") || nonEmptyString(cap.hooks.retire))));
  const noRetireHooks = knownBindings && !bindings.some(cap => cap.hooks?.retire);
  const captured = isCapturedHome(meta);
  const noCapturedSpawn = Array.isArray(meta.captured?.hookOrder) && meta.captured.hookOrder.length === 0 &&
    (meta.capabilityMeta === undefined || isPlainObject(meta.capabilityMeta) && Object.keys(meta.capabilityMeta).length === 0) &&
    (meta.captured.hookIntents === undefined || isPlainObject(meta.captured.hookIntents) && Object.keys(meta.captured.hookIntents).length === 0) &&
    (meta.captured.hookFailures === undefined || Array.isArray(meta.captured.hookFailures) && meta.captured.hookFailures.length === 0) &&
    (meta.captured.lifecycle === undefined || typeof meta.captured.lifecycle === "string" && !meta.captured.lifecycle.endsWith("-cleanup-required"));
  const cause = captured && !noCapturedSpawn
    ? "is a captured home from before 0.26 whose retire hooks cannot run, and its record does not prove that no capability's spawn hook ran"
    : !captured && !knownBindings
      ? "does not record capabilityRuntime, or its recorded capability hooks cannot be identified (homes spawned before capabilityRuntime need manual cleanup)"
      : !captured && !nonEmptyString(hookRepo) && !noRetireHooks
        ? "names no repository in which its recorded retire hooks can run"
        : null;
  if (!force && cause) {
    const named = [...new Set([...capturedHomeCapabilities(meta),
      ...(Array.isArray(bindings) ? bindings.map(cap => cap?.id).filter(nonEmptyString) : [])])];
    const capabilities = named.length ? `Capabilities that may have left state: ${named.join(", ")}. ` : "";
    throw oatsError("E_UNIDENTIFIED_INSTANCE_HOME", `${metaPath} ${cause}. ${capabilities}External identities or memberships may still depend on this home. Nothing was stopped, run or removed, including children. Inspect the home and clean up that state with the provider's tooling, then remove it with \`oats retire ${name} --force\`; --force removes the home without revoking state whose retire hooks cannot run.`);
  }
  return { meta, liveMeta, workIs, repoFromGit, hookRepo, directoryFallbackPath, quarantinePath, quarantine, hooksKnown: knownBindings, spawnGroupWarnings, inProgressUnverified };
}
