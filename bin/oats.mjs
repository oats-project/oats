#!/usr/bin/env node
/**
 * oats — the OATS command line.
 *
 *   oats doctor [dir] [--soul <s>] [--json] show deployment and offline capture warnings; --soul: composition only
 *   oats onboard [<dir>] --workspace <ref>  realize a workspace here (oats-local.yaml +
 *                                          agents/), then sync
 *   oats sync [--dir <d>] [--plan] [--json] discover the workspace, confirm membership,
 *                                          resolve packages, write the lock (--plan: write nothing)
 *   oats package add|remove ...            edit `packages:` in the workspace file
 *   oats workspace status                  membership table, packages
 *   oats capabilities | oats souls         every visible item of the workspace
 *   oats capabilities show <name> [--member <repoKey> | --package <id>] [--file <path>] [--json]
 *                                          what one capability ships (inject text, skill files)
 *
 * Workspace model v2 (docs/design/2026-09-23-workspace-module-contracts.md §6):
 * nothing is installed. `oats-local.yaml` names the workspace, `oats sync`
 * observes it over Git remotes and writes `oats-lock.json` (lockfileVersion 3).
 * `init` / `use` / `install` / `restore` / `list` / `catalog` / `remove` /
 * `migrate` / `trust` / `inject` are gone with the installed-capability tier.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { constants as osConstants, homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { spawnSync as spawnSyncProc } from "node:child_process";
import { enableCliCompileCache } from "../lib/compile-cache.mjs";
import { hotImport, hotRead } from "../lib/hot-reads.mjs";
import { installStamp } from "../lib/install-stamp.mjs";

// The warm reader's baseline (lib/reader.mjs): its install's stamp before any kernel module loads, so that an
// install changed while the kernel loads is never the install the reader believes it answers from.
const READER_STAMP = process.argv[2] === "reader" ? installStamp() : null;

// Node's compile cache is on before the kernel is parsed (lib/compile-cache.mjs): static imports are
// all parsed and linked before this module's body runs, so they are Node built-ins and the three small
// dependency-free modules above, and the kernel and `yaml` are imported here, in order, once it is on.
enableCliCompileCache();
// A hot read (lib/hot-reads.mjs) imports only the leaves it uses, never core.mjs: each line below takes
// the leaves its names come from, and every other command imports every module, in this order. A hot
// read takes its names from lib/hot-reads.mjs: a name newly used on a hot read's path must be listed
// there, under its line, or its first use throws (a tripwire); test/cli-hot-reads.test.mjs pins what
// each hot read must not load. Each line names its module and imports it by one string literal.
const HOT_READ = hotRead(process.argv.slice(2));
const kernelImport = (name, load) => (HOT_READ ? hotImport(HOT_READ, name) : load());
const { doctorCaptureWarnings } = await kernelImport("doctor-capture", () => import("../lib/doctor-capture.mjs"));
const { assertNoPartialUpgrade } = await kernelImport("upgrade-state", () => import("../lib/upgrade-state.mjs"));
const { runtimeNameWarning, noteRuntimeName } = await kernelImport("deprecation", () => import("../lib/deprecation.mjs"));
const { errorCause, herdrSettingRemoved, isAnswerCode, kernelCode, OWN_NAME_FAILURES, reportDefect, spawnRefusalDetails } = await kernelImport("errors", () => import("../lib/errors.mjs"));
const {
  LAYERS, OATS_VERSION, manifestOperations, upgradeHomeMeta,
  capabilityManifests, capabilityTrust, capabilityExecutablePath,
  officialPackageCatalog, officialCatalogFile, officialCapabilityAliases, resolvedFromHome, resolvedFromPrepared, teamEnv, isWorkspaceHome, preWorkspaceHome, isCapturedHome, capturedHomeRefusal, composeInstanceAgentsMd, parseYamlNested, withConfigFile,
  findInstanceHome, findInstanceHomes, homeLaunchLayers, processScanInformation, enclosingInstanceHome, logicalCwd, readableInstanceHomes, workspaceOf, ensureRoot, findRoot, findAgent, findAgentAt, legacyLocalAgents, legacyCapturedHomes, listAgents, listInstances, servedIdentityLine, spawnInstanceAsync, suggestSpawnName, instanceSoulDir, stableSoulId, preparedSoulIdOf, recordedKernelBin, launchConfigsAt, machineLaunchConfigs, machineLaunchConfigsFile, launchStartNotices, launchReportFor, explicitInstanceName, MAX_INSTANCE_NAME, retireInstance, RETIRE_SELECTED_HOME, RETIRE_UNDER_CLAIM, inspectInstanceSession, inputInstanceSession, attachInstanceSession, startInstanceSession, upgradeHoldsClaim, writeHomeRecord, defaultRepo, RELATIONS, validateLaunchConfig, validateLaunchConfigDefaults, renderLaunchRecipe, describeLaunchCommand, redactLaunchRecipe, withSafeTaskPrompt, LAUNCH_HARNESSES, planLaunch, redactLaunchCommand, restartInstanceSession,
  FAILED_SPAWN_BRANCH_LEFT, RETIRE_DELETE_BRANCH_REFUSED,
} = await kernelImport("core", () => import("../lib/core.mjs"));
const {
  writeFileAtomic, LOCK_FILE, canonicalLock, readLock, readLockIfPresent, writeLock, resolvePackages, memoizedRemote,
  classifyPackageValue, parsePackageRequest } = await kernelImport("packages", () => import("../lib/packages.mjs"));
const { harnessTrust } = await kernelImport("harness-trust-write", () => import("../lib/harness-trust-write.mjs"));
const { previewLaunchEnvironment, previewPaneEnvironment } = await kernelImport("core", () => import("../lib/core.mjs"));
const { PI_BRIDGE, piBridgeFolders, piBridgeSkewWarnings, planPiBridges, piBridgePlanLines, piBridgeStepProblem, piBridgeFailure, kernelLookup, kernelLookupResult, planCliUpdate, desktopFirstLine, bridgeLookup, bridgeLookupProblem } = await kernelImport("pi-bridge", () => import("../lib/pi-bridge.mjs"));
const { loadLocal, validateWorkspace, validateLocal, discoverPackageSouls, unlockedPackages, workspaceWarnings, memberRowByKey } = await kernelImport("workspace", () => import("../lib/workspace.mjs"));
const { discoveredTeamKeys, isTeamRefusal, localTeamsClosedProblem, recordedTeams, reportRows, soulKeyOf, soulTeams, teamKeyOf, teamModel } = await kernelImport("teams", () => import("../lib/teams.mjs"));
const { LAUNCH_KEY_UNCHECKED, LAUNCH_PREFERENCE_UNMATCHED, launchKeyQuoted, launchKeysUnmatched, launchLayers, soulLaunchCommand, unmatchedKeyMessage } = await kernelImport("launch-preference", () => import("../lib/launch-preference.mjs"));
const { terminalText } = await kernelImport("refused-text", () => import("../lib/refused-text.mjs"));
const { qualifiedSoulName, soulCandidates, soulsOffered } = await kernelImport("instance-resolution", () => import("../lib/instance-resolution.mjs"));
const { parseConfigData } = await kernelImport("config-data", () => import("../lib/config-data.mjs"));
const remoteModule = await kernelImport("remote", () => import("../lib/remote.mjs"));
const { sameRepo } = await kernelImport("repo-moves", () => import("../lib/repo-moves.mjs"));
const { OATS_PACKAGE_NAME } = await kernelImport("version", () => import("../lib/version.mjs"));
const { activateLocalInputs, localRevision } = await kernelImport("local-inputs", () => import("../lib/local-inputs.mjs"));
const { default: YAML } = await kernelImport("yaml", () => import("yaml"));
const { attachArgv, checkRemote, connectServer, forgetSnapshot, getServer, inspectRemote, startRemote, restartRemote, launchConfigRemote, scheduleRemote, listSnapshots, learnWorkspaceKey, readServers, redactArgv, reportedWorkspaceKey, rosterGroups, routeCapability, routeCommand, runRemote, serverFlagOf, targetOf, updateServers, validateServer, workspaceKeyOfStatus, workspaceMismatch, SERVERS_FILE } = await kernelImport("servers", () => import("../lib/servers.mjs"));
const { readSessionViewer } = await kernelImport("session-viewer", () => import("../lib/session-viewer.mjs"));
const { tickTriggers } = await kernelImport("triggers", () => import("../lib/triggers.mjs"));
const A = await kernelImport("automations", () => import("../lib/automations.mjs"));
const { parseEnvelopeText, unresolvedScheduleAttempts, scheduleScopeOf, listSchedules, describe: describeSchedule, testSchedule, addSchedule, updateSchedule, updateScheduleDescription, setEnabled: setScheduleEnabled, removeSchedule, runNow: runScheduleNow, reconcile: reconcileSchedule, tickHost, tickWorkspace, scopeAutomations, scheduleKind, registerWorkspace, unregisterWorkspace, readRegistry, schedulerStatus, saveWakeForHome, removeWakeForHome, wakeFromFlags, withHostLock, scheduleError, SCHEDULE_API } = await kernelImport("schedule", () => import("../lib/schedule.mjs"));
const { hostUnitFiles, hostUnitStatus, installHostUnit, uninstallHostUnit } = await kernelImport("schedule-host", () => import("../lib/schedule-host.mjs"));
const { kernelNode, stableNode } = await kernelImport("stable-node", () => import("../lib/stable-node.mjs"));
const { receiveAttachment, uploadAttachment, readStreamBounded, MAX_ATTACHMENT_BYTES } = await kernelImport("attachments", () => import("../lib/attachments.mjs"));
const { observeInstanceGit, diffInstanceFile } = await kernelImport("instance-git", () => import("../lib/instance-git.mjs"));
const { planStop, applyStop, planRetire, retireDefaultsLine, stopClosingLine, descendantsOf, resolveInstance: resolveInstanceForCli, setInstanceColor, setInstanceBackground, setInstanceSameWork, STOP_WARNINGS } = await kernelImport("instance-lifecycle", () => import("../lib/instance-lifecycle.mjs"));
const { extraWorktreeLines, formatBytes, warningLines, workRecoveryLines } = await kernelImport("retire-output", () => import("../lib/retire-output.mjs"));
const { livenessWord, lostLine, statusWord, waitingLine } = await kernelImport("status-words", () => import("../lib/status-words.mjs"));
const { retainedRecoveryLines, retainedWorktreeLines, retainedWorktrees } = await kernelImport("retained-after-retire", () => import("../lib/retained-after-retire.mjs"));
const { retireIncompleteProblems } = await kernelImport("retire-incomplete", () => import("../lib/retire-incomplete.mjs"));
const await_import_lifecycle = () => ({ resolveInstance: resolveInstanceForCli });
const { homeTarget, soulTarget, isWorkspaceContext, inspectDocument, withComposition, withSkills, readinessDocument, policyOf, policySoul, manifestMissingRequires, INSPECT_OPERATIONS_API } = await kernelImport("instance-inspect", () => import("../lib/instance-inspect.mjs"));
const { readEvents, setWaiting, incarnationOf } = await kernelImport("instance-events", () => import("../lib/instance-events.mjs"));
const { CLIENT_VIA, addDeployment, deploymentAtOrAbove, importDesktopDeployments, listDeployments, listResolved, removeDeployment } = await kernelImport("deployments", () => import("../lib/deployments.mjs"));
const { observeResolvedDeployment } = await kernelImport("resolved-deployment", () => import("../lib/resolved-deployment.mjs"));
const { SESSION_RESUME_FEATURE } = await kernelImport("session-resume-contract", () => import("../lib/session-resume-contract.mjs"));
const { KERNEL_FEATURES, READER_API } = await kernelImport("kernel-features", () => import("../lib/kernel-features.mjs"));
const { inheritedContextRefusal } = await kernelImport("captured-context", () => import("../lib/captured-context.mjs"));
const { callSession, parseMaxAge, readBudget } = await kernelImport("read-call", () => import("../lib/read-call.mjs"));
const { cachedWorkspace, legacyLayoutProblems, statusAnswer, statusView } = await kernelImport("roster-read", () => import("../lib/roster-read.mjs"));
const { memberLabel, memberRows, packageRows, standaloneCatalogVersion, standalonePackages, workspaceName, workspaceStatusAnswer, workspaceStatusView } = await kernelImport("workspace-read", () => import("../lib/workspace-read.mjs"));
const { expandInlineValues, flagValue } = await kernelImport("argv", () => import("../lib/argv.mjs"));

const rawArgs = process.argv.slice(2);
const { argv: args, problem: argvProblem, inline: inlineValues } = expandInlineValues(rawArgs);
let cmd = args[0];
const HELP_WORDS = new Set(["help", "--help", "-h"]);
const KERNEL_COMMANDS = new Set(["harness", "automations", "trigger", "capture", "capabilities", "deployments", "doctor", "inspect", "instance", "operation", "package", "readiness", "souls", "soul", "teams", "launch-config", "experimental", "onboard", "pane", "reader", "recall", "retire", "root", "schedule", "server", "session", "setup", "spawn", "status", "sync", "tui", "update", "version", "workspace", "worktree"]);
/** Commands whose argv another parser reads (packages/record, packages/experimental and packages/tui parse process.argv). */
const OWN_ARGV_COMMANDS = new Set(["capture", "recall", "setup", "experimental", "tui"]);
/** Commands `--server <id>` runs on a registered server. */
const ROUTED_COMMANDS = new Set(["spawn", "retire", "status", "session", "okf", "schedule", "inspect", "operation", "launch-config", "readiness", "instance"]);
const flag = (name) => flagValue(args, inlineValues, name);
function yoloFlag() {
  if (args.includes("--yolo") && args.includes("--no-yolo")) cmdFail("E_BAD_ARGS", "choose --yolo or --no-yolo, not both");
  return args.includes("--yolo") ? true : args.includes("--no-yolo") ? false : undefined;
}
function valueFlag(name) {
  const value = flag(name);
  if (value === true) cmdFail("E_BAD_ARGS", `--${name} needs a value`);
  return value;
}
/** `--description=<text>` on the trigger and schedule verbs: undefined when absent, the text
 *  otherwise (`""` clears). The spaced form works too, but only `=` carries an empty value or one
 *  that starts with `--`. */
function descriptionFlag() {
  const value = flag("description");
  if (value === true) throw Object.assign(new Error("--description needs a value: --description=<text> (--description= clears it)"), { code: "E_BAD_ARGS" });
  return value;
}
/** A spec with the --description flag applied: it sets or overrides `description`; `""` removes it. */
function withDescription(spec, description) {
  if (description === undefined || !spec || typeof spec !== "object" || Array.isArray(spec)) return spec;
  const { description: _d, ...rest } = spec; void _d;
  return description === "" ? rest : { ...rest, description };
}
const die = (msg, exit = 1) => { console.error(`oats: ${msg}`); process.exit(exit); };
/** A command's harness: --harness, or --runtime, its pre-0.27 name (the released okf worker and
 *  a 0.26-era Desktop pass it) — read either, with the deprecation warning. Both, disagreeing,
 *  are refused. `get` reads one flag (the command's own reader where it has one). */
function harnessFlag(get = flag) {
  const harness = get("harness"), runtime = get("runtime");
  if (runtime === undefined) return harness;
  if (harness !== undefined && harness !== runtime) cmdFail("E_BAD_ARGS", `--harness ${harness} and --runtime ${runtime} disagree; --runtime is the pre-0.27 name of --harness — give one`);
  noteRuntimeName("the --runtime flag (use --harness)");
  return runtime;
}
const cmdFail = (code, msg, details) => (JSON_MODE ? jsonFail(code, msg, details) : die(msg));
/** Resolve the --dir flag with central validation: a value-taking flag given
 * no value (flag() → true) is E_BAD_ARGS inside the JSON boundary, never an
 * uncaught resolve(true) TypeError (reviewer-6f0a3bd). */
function dirFlag() {
  const v = flag("dir");
  if (v === undefined) return resolve(process.cwd());
  if (v === true || !String(v).trim()) {
    const msg = "--dir needs a directory path";
    if (JSON_MODE) { console.log(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_BAD_ARGS", message: msg } })); process.exit(1); }
    die(msg);
  }
  return resolve(String(v));
}
// Desktop CLI API v1 (JSON mode): every `--json` failure is EXACTLY ONE JSON
// object on stdout — { schemaVersion: 1, ok: false, error: { code, message } } —
// with a nonzero exit; progress prose goes to stderr, never stdout.
const JSON_MODE = args.includes("--json");
// Canonical absolute path of this CLI executable — the versioned OATS_CLI_BIN
// env contract for dispatched package commands (never resolved via PATH).
const CLI_BIN = realpathSync(fileURLToPath(import.meta.url));
// The one deprecated-name warning (lib/deprecation.mjs) rides the envelope, only when there is one.
const envelopeWarnings = () => { const w = runtimeNameWarning(); if (w) warningDelivered = true; return w ? { warnings: [w] } : {}; };
let warningDelivered = false;
/** A forwarded envelope keeps the host's warnings; this command's own deprecated-name
 *  note (a `--runtime` given here) joins the host's into the one warning. */
const withLocalWarnings = (envelope) => {
  const mine = runtimeNameWarning();
  if (!mine || !envelope || typeof envelope !== "object") return envelope;
  warningDelivered = true;
  const theirs = Array.isArray(envelope.warnings) ? envelope.warnings : [];
  const same = theirs.find((w) => w?.code === mine.code);
  if (!same) return { ...envelope, warnings: [...theirs, mine] };
  const sources = [...new Set([...(Array.isArray(same.sources) ? same.sources : []), ...mine.sources])];
  return { ...envelope, warnings: theirs.map((w) => (w === same ? { ...mine, sources, message: mine.message.replace(/\(.*\)/, `(${sources.join("; ")})`) } : w)) };
};
const jsonFail = (code, message, details, exit = 1) => { console.log(JSON.stringify({ schemaVersion: 1, ok: false, error: { code, message: String(message), ...(details !== undefined ? { details } : {}) }, ...envelopeWarnings() })); process.exit(exit); };
/** The door of the lifecycle verbs (retire, instance stop, session, worktree; awebai/oats#892), and of a spawn (spawnFail): the
 *  answer to an error `e` of one of them. Its code is the error's own only when that is a kernel
 *  code (lib/errors.mjs isKernelCode); any other error is answered as `fallback`. One that has a
 *  code (the system's, Node's) and a defect (isDefect: a TypeError and its kind) get
 *  `details.cause` beside the command's `details`, and a defect's stack goes to stderr, in both
 *  modes: the answer must not swallow it. A plain Error without a code is a refusal the kernel
 *  wrote without one, or a child process that failed: the fallback and its message, nothing more.
 *  A typed failure that is not a code (TYPED_CLI_FAILURES) keeps its name, as before. Text mode
 *  prints the same message, with the same exit status. */
const lifecycleFail = (e, fallback, details, exit) => {
  const message = String(e?.message ?? e);
  if (TYPED_CLI_FAILURES.has(e?.code)) return JSON_MODE ? jsonFail(e.code, message, details, exit) : die(message, exit);
  reportDefect(e);
  const cause = isAnswerCode(e?.code) ? undefined : errorCause(e);
  const all = cause ? { ...details, cause } : details;
  return JSON_MODE ? jsonFail(kernelCode(e, fallback), message, all, exit) : die(message, exit);
};
/** The answer to an error of `oats spawn` (feature spawn-kernel-codes, awebai/oats#1047): the
 *  lifecycle verbs' door (lifecycleFail), whose general code for a spawn is E_SPAWN_FAILED. A
 *  kernel code is answered as raised, whatever stage of the spawn raised it; it says nothing about
 *  how far the spawn got (`details.unconfirmed` does). E_INTERRUPTED exits 128 + the signal. */
const spawnFail = (e) => lifecycleFail(e, "E_SPAWN_FAILED", spawnRefusalDetails(e), e?.code === "E_INTERRUPTED" ? e.exitStatus : undefined);
const jsonOk = (result) => { console.log(JSON.stringify({ schemaVersion: 1, ok: true, result, ...envelopeWarnings() })); };
// Text mode (or a JSON answer printed before the read): the warning goes to stderr, never stdout.
process.on("exit", () => { const w = runtimeNameWarning(); if (w && !warningDelivered) process.stderr.write(`oats: warning: ${w.message}\n`); });

function shortPath(p) {
  if (!p) return p;
  const home = homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

/** Shell-safe single-quoting for copyable human commands (paths may contain spaces/metacharacters). */
function shellQuote(s) {
  return /^[A-Za-z0-9._/~-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
}


// ---------- doctor ----------
/** Doctor must diagnose, not crash: a stale activation of a retired
 * capability fails config resolution — surface the cleanup instruction
 * cleanly (text or JSON) instead of an uncaught stack trace. */
function operationalKnowledgeNote(composition, soulName) {
  return composition && !composition.oatsCoreDeclared
    ? `soul ${soulName} has no oats.core capability (the workspace default); it gets no OATS operating instructions` : null;
}
/** `doctor --soul`: the instructions an instance of that soul would carry. The soul
 *  is resolved over the workspace remotes exactly as a spawn preview resolves it
 *  (previewWorkspaceSoul: the soul cache is not written), then composed by the one
 *  composer spawn's path, doctor and inspect share (lib/soul-composition.mjs): kernel
 *  half, then the modules materialized into a scratch home OUTSIDE the deployment
 *  (removed after). Capability blocks are named home-relative
 *  (`.oats/modules/<cap>/<inject>`), where an instance carries them. */
async function doctorComposition(ctx, soulName, ws, bail) {
  if (!soulName) return undefined;
  const { prepareInstance, previewWorkspaceSoul, discoverOrStandalone } = await import("../lib/instance-resolution.mjs");
  const { composeSoulInstructions } = await import("../lib/soul-composition.mjs");
  const deployment = dirname(ws.local.path);
  const root = join(deployment, "agents");
  const remoteOptions = remoteOptionsFromEnv();
  const cleanups = [];
  // A bail exits the process without unwinding: the temporary copies are removed at exit too.
  process.once("exit", () => { for (const c of cleanups) { try { c(); } catch { /* best effort */ } } });
  try {
    const discovery = await discoverOrStandalone(loadLocal(deployment).local, { deployment, remoteOptions });
    const prepared = await prepareInstance(deployment, soulName, { remoteOptions, discovery });
    const pv = await previewWorkspaceSoul(prepared, root);
    cleanups.push(pv.cleanup);
    const { text, blocks, resolved, oatsCoreDeclared } = await composeSoulInstructions({ deployment, prepared, soulDir: pv.soulDir });
    const { resolutionContractWarnings } = await import("../lib/instance-resolution.mjs");
    return { text, blocks, resolved, oatsCoreDeclared, warnings: resolutionContractWarnings(prepared.resolution) };
  } catch (e) {
    if (e?.code?.startsWith?.("E_")) bail(e.code, e.message, e.details);
    throw e;
  } finally { for (const c of cleanups) { try { c(); } catch { /* best effort: temporary copies only */ } } }
}

/** Local teams the workspace does not allow (team model 3: E_WORKSPACE_SCHEMA local-teams-closed), in
 *  doctor, OFFLINE like the rest of doctor: oats-local.yaml, and the workspace file this machine's parsed
 *  cache holds (cachedWorkspace: no git process, no network). Without that file, whether the local teams are
 *  allowed is said to be unchecked (information), never guessed. The standalone view has no workspace
 *  rules. → { problems, information } */
function doctorLocalTeams(local) {
  const standalone = typeof local.standalone === "string" && local.standalone !== "";
  const file = standalone ? null : cachedWorkspace(local.workspace, remoteOptionsFromEnv)?.file ?? null;
  const model = teamModel(file, local);
  const declared = ["teams", "defaultTeam"].some((k) => Object.hasOwn(local, k));
  return { problems: model.closedKeys.length ? [localTeamsClosedProblem(model.closedKeys)] : [],
    information: !standalone && file === null && declared ? ["local-teams-closed: whether oats-workspace.yaml allows oats-local.yaml teams/defaultTeam (localTeams: true) couldn't be checked: this deployment hasn't observed its workspace yet; run oats sync"] : [] };
}

/** Operator coverage in doctor (#671), OFFLINE like the rest of doctor: the souls this workspace offers,
 *  discovered and resolved from this machine's cache only (cacheOnlyRemote: no git process, no network),
 *  for the workspace and EVERY declared team. Warnings in problems; when the cache cannot answer, one
 *  information line that says coverage is unknown, never that the operator is missing.
 *  → { problems: [{ code, message, remedy, label? }], information: [string] } */
async function doctorOperator(ws) {
  const { operatorCoverage, operatorProblems, cacheOnlyRemote } = await import("../lib/operator-coverage.mjs");
  const { discoverOrStandalone } = await import("../lib/instance-resolution.mjs");
  const deployment = dirname(ws.local.path);
  const local = ws.local.value;
  const remote = cacheOnlyRemote();
  const remoteOptions = remoteOptionsFromEnv();
  // Doctor reads the resolutions `oats souls` (and readiness, spawn) leave in the cache; `oats sync` alone
  // does not resolve souls. Online, `oats readiness --soul <soul>` answers the same question.
  const CACHE_REMEDY = "oats sync, then oats souls (it resolves every soul; doctor reads what that keeps), or online: oats readiness --soul <soul>";
  let coverage, workspace = null, unknownRemedy = CACHE_REMEDY;
  try {
    const lock = readLockIfPresent(deployment);
    const discovery = await discoverOrStandalone(local, { lock, deployment, remoteOptions, remote });
    workspace = discovery.workspace?.name ?? null;
    const labels = [...teamModel(discovery.standalone === true ? null : discovery.workspace, local, { workspaceKey: discovery.key ?? null }).labels.keys()].sort();
    coverage = await operatorCoverage({ discovery, local, lock, teams: labels, remoteOptions, remote });
  } catch (e) {
    // A cache miss is the cache's; anything else (an invalid lock, which doctor reports above) is named as itself.
    const missed = e?.code === "E_REMOTE_UNREADABLE";
    coverage = { known: false, reason: missed ? `this machine's cache cannot answer (${e.message})` : `${e?.code ? `${e.code}: ` : ""}${e?.message ?? e}` };
    if (!missed) unknownRemedy = "fix the error named here (doctor reports it), then run doctor again";
  }
  const found = operatorProblems(coverage, { workspace, unknownRemedy });
  const unknown = found.find((p) => p.code === "operator-coverage-unknown");
  if (unknown) return { problems: [], information: [`${unknown.code}: ${unknown.message}; ${unknown.remedy}`] };
  return { problems: found.map(({ code, label, message, remedy }) => ({ code, ...(label ? { label } : {}), message, remedy })), information: [] };
}

/** The keys of oats-local.yaml souls.launch that name no soul (awebai/oats#989), in doctor, OFFLINE like
 *  doctorOperator: the souls are discovered from this machine's cache only, and the one function
 *  (launchKeysUnmatched) decides. A problem per unmatched key, which speaks about this machine's last
 *  read of the souls: a spawn reads the workspace itself and is the authority. A key that could not be
 *  checked, or a cache that cannot answer, is an information line (`launch-preference-unchecked`),
 *  never silence and never a failure of doctor. "*" is never reported.
 *  → { problems: [{ code, key, at, value, suggestions, message, remedy }], information: [string] } */
async function doctorLaunchPreferences(ws) {
  const local = ws.local.value;
  const entries = local?.souls?.launch && typeof local.souls.launch === "object" && !Array.isArray(local.souls.launch) ? local.souls.launch : {};
  const keys = Object.keys(entries).filter((k) => k !== "*").sort();
  if (!keys.length) return { problems: [], information: [] };
  const shown = (list) => (list.length > 3 ? `${list.slice(0, 3).map(launchKeyQuoted).join(", ")} and ${list.length - 3} more` : list.map(launchKeyQuoted).join(", "));
  let found;
  try {
    const { cacheOnlyRemote } = await import("../lib/operator-coverage.mjs");
    const { discoverOrStandalone } = await import("../lib/instance-resolution.mjs");
    const deployment = dirname(ws.local.path);
    const discovery = await discoverOrStandalone(local, { lock: readLockIfPresent(deployment), deployment, remoteOptions: remoteOptionsFromEnv(), remote: cacheOnlyRemote() });
    found = launchKeysUnmatched({ local, offered: soulsOffered(discovery) });
  } catch (e) {
    const why = e?.code === "E_REMOTE_UNREADABLE" ? `this machine's cache cannot answer (${e.message})` : `${e?.code ? `${e.code}: ` : ""}${e?.message ?? e}`;
    return { problems: [], information: [`launch-preference-unchecked: the keys of oats-local.yaml souls.launch (${shown(keys)}) were not checked against the souls this workspace offers: ${why}; oats sync, then oats souls, then run doctor again (a spawn reads the workspace itself and refuses a key that names no soul)`] };
  }
  return {
    problems: found.unmatched.map((row) => ({ code: LAUNCH_PREFERENCE_UNMATCHED, key: row.key, at: row.at, value: row.value, suggestions: row.suggestions,
      message: unmatchedKeyMessage(row, { lastRead: true }),
      remedy: `pin the soul it was meant for (${soulLaunchCommand("set")}), then: ${soulLaunchCommand("remove", { key: row.key })}` })),
    information: found.unchecked.map((row) => `launch-preference-unchecked: oats-local.yaml souls.launch ${launchKeyQuoted(row.key)} was not checked against the souls this workspace offers: ${LAUNCH_KEY_UNCHECKED[row.reason] ?? row.reason}; this is this machine's last read, and a spawn reads the workspace itself`),
  };
}

/** What the deployment's capabilities declare and this kernel ignores (an unknown hook event), for
 *  doctor without --soul, OFFLINE like doctorOperator, from this machine's parsed cache: each member's
 *  capabilities as `oats sync` enumerated them (the workspace's members confirmed by the cached
 *  membership; a standalone deployment's own repository), and every capability of every locked package.
 *  Each source is read on its own, so one the cache cannot answer leaves the others' warnings, and is
 *  said to be unchecked (information, `hook-events-unchecked`), never read as "no warning".
 *  → { warnings: [{ code, capability, path, message }], information } */
async function doctorHookWarnings(ws) {
  const { cacheOnlyRemote } = await import("../lib/operator-coverage.mjs");
  const { lockedPackageCapabilities } = await import("../lib/resolve.mjs");
  const { capabilityContractWarnings, confirmMembership, observeWorkspace } = await import("../lib/workspace.mjs");
  const { locatedContractWarnings } = await import("../lib/capability-contract.mjs");
  const deployment = dirname(ws.local.path);
  const local = ws.local.value;
  const { bindRemote } = await import("../lib/packages.mjs");
  const remoteOptions = remoteOptionsFromEnv();
  // This machine's cache directory travels with every read (discovery binds it the same way).
  const remote = bindRemote(cacheOnlyRemote(), remoteOptions);
  const warnings = [], information = [];
  const unchecked = (what, e) => information.push(`hook-events-unchecked: ${what} not checked for hook events this kernel does not run: ${e?.code === "E_REMOTE_UNREADABLE" ? `this machine's cache cannot answer (${e.message})` : `${e?.code ? `${e.code}: ` : ""}${e?.message ?? e}`}; oats sync, then run doctor again`);
  // A member's capabilities as its enumeration at the observed commit lists them (lib/workspace.mjs enumerateRepo).
  const memberCapabilities = async (ref) => {
    const { commit } = await remote.observeRemote(ref);
    // The cache-only remote never computes; the compute argument keeps bindRemote's options in place.
    return (await remote.memoAtCommit(ref, commit, "enumerate", () => undefined)).capabilities || [];
  };
  const standalone = typeof local.standalone === "string" && local.standalone !== "" ? local.standalone : null;
  if (standalone) {
    try { warnings.push(...capabilityContractWarnings(await memberCapabilities(standalone))); }
    catch (e) { unchecked(`member ${standalone}'s capabilities were`, e); }
  } else {
    let observed = null;
    try { observed = await observeWorkspace(local.workspace, { remote }); }
    catch (e) {
      if (e?.code !== "E_WORKSPACE_SCHEMA" || e?.details?.notAHost !== true) unchecked("member capabilities were", e);
      else {
        // `workspace:` names a member (docs/workspaces.md), as discovery follows it: its host, from the
        // member's cached oats-membership.yaml. Without the host (unreadable, or never read here), the
        // member's own capabilities (discovery's standalone view), and the other members unchecked.
        const member = local.workspace;
        let backlink;
        try { const { commit } = await remote.observeRemote(member); backlink = await remote.memoAtCommit(member, commit, "membership", () => undefined); }
        catch (miss) { backlink = { miss }; }
        if (backlink && !backlink.miss && backlink.kind !== "ok") unchecked("member capabilities were", e);
        else {
          try { if (backlink.miss) throw backlink.miss; observed = await observeWorkspace(backlink.value.workspace, { remote }); }
          catch (host) {
            try { warnings.push(...capabilityContractWarnings(await memberCapabilities(member))); }
            catch (own) { unchecked(`member ${member}'s capabilities were`, own); }
            unchecked("the workspace's other members' capabilities were", host);
          }
        }
      }
    }
    for (const ref of observed?.workspace?.members || []) {
      try {
        const membership = await confirmMembership(observed, ref, { remote });
        if (!membership.confirmed) {
          // Not a member: discovery lists none of its capabilities. Not read: unchecked.
          if (membership.reason === "cannot-read") unchecked(`member ${membership.key}'s capabilities were`, { code: "E_REMOTE_UNREADABLE", message: membership.detail });
          continue;
        }
        warnings.push(...capabilityContractWarnings(await memberCapabilities(ref)));
      } catch (e) { unchecked(`member ${ref}'s capabilities were`, e); }
    }
  }
  let lock = null;
  try { lock = readLockIfPresent(deployment); } catch { lock = null; } // an invalid lock is doctor's own problem, reported above
  let catalog = null; try { catalog = officialPackageCatalog(); } catch { catalog = null; }
  for (const [id, entry] of Object.entries(lock?.packages || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    try {
      const { capabilities } = await lockedPackageCapabilities(id, entry, { catalog, remote, remoteOptions });
      for (const c of capabilities) warnings.push(...locatedContractWarnings(c.manifest, `package:${id}:${c.dir}/oats.json`));
    } catch (e) { unchecked(`package ${id}'s capabilities were`, e); }
  }
  return { warnings, information };
}

/** Workspace-model v2 doctor data, OFFLINE: the deployment declaration found
 * walking up from ctx (oats-local.yaml) and the lock v3 beside it. Doctor never
 * goes to the network for this view (only `--soul`, which resolves the soul like a
 * spawn preview); membership and discovery are `oats sync` / `oats workspace status`. */
function doctorLockData(ctx) {
  const out = { local: null, localError: null, lockFile: null, packages: [], lockError: null };
  let lockDir = ctx;
  try {
    const found = loadLocal(ctx);
    out.local = { path: found.path, workspace: found.local.workspace, value: found.local };
    lockDir = dirname(found.path);
  } catch (e) {
    // An unreadable oats-local.yaml, or a 0.25 oats-config.yaml inside the deployment
    // (E_CONFIG_BROKEN reason legacy-config): doctor answers it as its typed error.
    if (e?.code === "E_WORKSPACE_SCHEMA" || e?.code === "E_CONFIG_BROKEN") out.localError = { code: e.code, message: e.message, details: e.details };
    else if (e?.code !== "E_LOCAL_MISSING") throw e;
  }
  const file = join(lockDir, LOCK_FILE);
  if (!existsSync(file)) return out;
  out.lockFile = file;
  try {
    const lock = readLock(lockDir);
    out.packages = Object.entries(lock.packages).map(([id, p]) => ({ id, version: p.version, source: p.source, path: p.path, commit: p.commit, integrity: p.integrity, capabilities: p.capabilities }));
  } catch (e) {
    if (e?.code !== "E_LOCK_SCHEMA") throw e;
    out.lockError = { code: e.code, message: e.message, file: e.details?.file ?? file };
  }
  return out;
}

// ---------- inspect: one authoritative answer for GUIs ----------
/** Souls, capabilities (installed state and health, separately from
 *  activation), effective layer bindings and declared operations for a
 *  scope, a selected soul, or a running home's snapshot. Read-only; the
 *  integrity scan runs only when asked (a GUI calls this on Refresh, never
 *  from its roster poll). Nothing here is provider-specific: what a
 *  knowledge provider offers is what its manifest declares. */
const INSPECT_TEXT_CAP = 256 * 1024;
/** The agents root a home belongs to, from its path alone:
 *  <root>/<agent>/instances/<instance>. */
function agentsRootOfHome(home) { return dirname(dirname(dirname(home))); }
const SOUL_FIELDS = ["harness", "model", "yolo", "description", "launch-config"];
const realOrResolved = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
/** Every soul of a scope: the persistent souls of every agents root in
 *  scope, plus packaged souls (read-only). One enumeration for inspect and
 *  operation run, so both address souls the same way. */
function scopeSouls(ctx, { extraRoots = [] } = {}) {
  // A home's own agents root is always in scope for that home: its recorded
  // work repository may be another repository entirely (repo overrides), and
  // the config context resolves there while the soul lives with its owner.
  const roots = [...new Set([findRoot(ctx), ...extraRoots].filter(Boolean).map((p) => realOrResolved(resolve(p))))];
  const souls = [];
  for (const root of roots) {
    for (const a of listInstances(root)) {
      const soul = findAgent(root, a.name) || a;
      const e = soulEntry(soul, root);
      e.instances = (a.instances || []).map((i) => i.instance);
      souls.push(e);
    }
  }
  return { roots, souls, diagnostics: [] };
}
/** The one soul a name (and optional agents root) addresses; throws with a
 *  code when none or several match. */
function selectSoul(souls, name, agentsRoot, ctx) {
  let matches = souls.filter((s) => s.name === name);
  if (agentsRoot) matches = matches.filter((s) => realOrResolved(s.agentsRoot) === realOrResolved(agentsRoot));
  if (!matches.length) throw Object.assign(new Error(`no soul ${JSON.stringify(name)} in the scope of ${ctx}${agentsRoot ? ` under ${agentsRoot}` : ""}`), { code: "E_SOUL_UNKNOWN" });
  // Same-named souls under several member roots: the member the caller
  // addressed with --dir breaks the tie; a team root or an unrelated
  // directory does not, and the answer names --agents-root as the remedy.
  if (matches.length > 1) {
    const here = realOrResolved(ctx);
    const own = matches.filter((s) => s.kind !== "capability" && realOrResolved(dirname(s.agentsRoot)) === here);
    if (own.length === 1) return own[0];
    throw Object.assign(new Error(`soul ${JSON.stringify(name)} exists under ${matches.length} agents roots (${matches.map((m) => m.agentsRoot).join(", ")}); pass --agents-root <abs>`), { code: "E_SOUL_AMBIGUOUS" });
  }
  return matches[0];
}
/** The config context a selected soul belongs to: the workspace of its
 *  agents root (a member repository under a team scope). An explicit --dir
 *  may be that context or a scope enclosing it (the team root); another
 *  member's context contradicts the selection and is refused. */
function memberContextOf(soul, ctx, explicitDir, bail) {
  if (soul.kind === "capability") return realOrResolved(ctx);
  const member = realOrResolved(dirname(soul.agentsRoot));
  const given = realOrResolved(ctx);
  if (member === given) return member;
  if (explicitDir && !member.startsWith(given + sep)) bail("E_SCOPE_MISMATCH", `--dir ${ctx} is not the scope of soul ${soul.name} under ${soul.agentsRoot} (${member}); pass that member's directory, an enclosing team scope, or omit --dir`);
  return member;
}
/** A home's context for --dir validation: its recorded repository, or the
 *  workspace that holds its agents root (what a roster derives). */
function homeContexts(home, meta) {
  const out = [];
  if (meta.repo && existsSync(meta.repo)) out.push(resolve(meta.repo));
  out.push(dirname(agentsRootOfHome(realOrResolved(home))));
  return out;
}
/** A soul's own declared requirements/defaults/provenance, read from its
 *  soul.yaml through the kernel's parser (never guessed, never re-parsed by a
 *  consumer). Absent sections are null: an unrecorded provenance is a fact
 *  about the soul, not a prompt to infer one. */
function soulDeclarations(soulDir) {
  const file = join(soulDir, "soul.yaml");
  const empty = { declarations: { requires: null, defaults: null, knowledge: null, teams: null, resources: null, children: null }, provenance: null, problems: [] };
  if (!existsSync(file)) return empty;
  let parsed;
  try { parsed = withConfigFile(file, () => parseYamlNested(readFileSync(file, "utf8"))); }
  catch (e) { return { ...empty, problems: [{ code: "soul-declarations-unreadable", message: e.message }] }; }
  const section = (key) => (parsed[key] !== undefined && parsed[key] !== null && typeof parsed[key] === "object") ? parsed[key] : (parsed[key] === undefined ? null : parsed[key]);
  const provenance = section("provenance");
  return {
    declarations: { requires: section("requires"), defaults: section("defaults"), knowledge: section("knowledge"), teams: section("teams"), resources: section("resources"), children: section("children") },
    provenance: provenance && typeof provenance === "object" ? {
      kind: provenance.kind ?? null, source: provenance.source ?? null, revision: provenance.revision ?? null,
      path: provenance.path ?? null, workspaceRevision: provenance.workspaceRevision ?? null,
    } : null,
    problems: [],
  };
}
function soulEntry(soul, root, { capability } = {}) {
  const dir = soul._dir || soul.soulDir;
  const soulDir = capability ? soul.soulDir : join(dir, "soul");
  const packaged = !!capability;
  const declared = soulDeclarations(soulDir);
  return {
    soulsApi: 1, declarations: declared.declarations, provenance: declared.provenance,
    declarationProblems: declared.problems,
    name: soul.name, kind: packaged ? "capability" : (soul.kind || "persistent"), capability: capability || null,
    type: soul.type ?? null, description: soul.description ?? null, repo: soul.repo ?? null, work: soul.work || "checkout",
    harness: soul.harness || "pi", model: soul.model ?? null, yolo: soul.yolo === true || soul.yolo === "true" ? true : soul.yolo === false || soul.yolo === "false" ? false : null, launchConfig: soul["launch-config"] ?? null,
    agentsRoot: root, dir: packaged ? soulDir : dir, soulFile: join(soulDir, "soul.yaml"), instructionsFile: join(soulDir, "AGENTS.md"),
    editable: packaged
      ? { fields: [], instructions: false, reason: `packaged soul from capability ${capability}: edit the package and update it; scoped bindings still apply through oats use` }
      : { fields: [...SOUL_FIELDS], instructions: true, reason: null },
    instances: [],
  };
}
/** These commands address a scope explicitly (--dir, --home, cwd); the
 *  invoking process's ambient agents-root override must not redirect them
 *  to its own deployment. */
function dropAmbientRoot() { delete process.env.PI_AGENTS_ROOT; }
async function inspectCmd() {
  const bail = (code, msg, details) => (JSON_MODE ? jsonFail(code, msg, details) : die(msg));
  // Feature soul-composed-instructions: opt-in, soul subject only; without it nothing extra is composed.
  const instructions = args.includes("--instructions");
  if (instructions && flag("home") !== undefined) return bail("E_BAD_ARGS", "--instructions composes a soul's instructions before a spawn: it takes --soul, not --home (an instance's composed AGENTS.md is instance.instructions)");
  // Feature soul-skills: opt-in, soul subject only; without it no skill file is read.
  const skills = args.includes("--skills");
  if (skills && flag("home") !== undefined) return bail("E_BAD_ARGS", "--skills lists a soul's own skills before a spawn: it takes --soul, not --home (an instance's skills are in its home's .agents/skills/)");
  // Feature soul-composed-skills: opt-in, soul subject only; it shares --instructions' one scratch composition.
  const composedSkills = args.includes("--composed-skills");
  if (composedSkills && flag("home") !== undefined) return bail("E_BAD_ARGS", "--composed-skills lists the skills a spawn of a soul would give its instance: it takes --soul, not --home (an instance's skills are in its home's .agents/skills/)");
  let t = await workspaceTarget(bail, { command: "inspect" });
  if (t) {
    if (t.resolutionError) return bail(t.resolutionError.code, t.resolutionError.message, t.resolutionError.details ?? undefined);
    if (instructions || composedSkills) t = await withComposition(t, { instructions, skills: composedSkills });
    if (skills) t = await withSkills(t);
    const doc = inspectDocument(t, { kernel: OATS_VERSION });
    if (JSON_MODE) { jsonOk(withObservation(doc)); return; }
    printWorkspaceInspect(doc); return;
  }
}
/** The workspace-model target of inspect / readiness / operation run (lead
 *  decision 4): an instance home with materialized modules (`--home`), or a soul
 *  of a workspace deployment (`--soul`, resolved as its spawn would be). Anything
 *  else is a typed refusal: there is no classic scope answer. */
async function workspaceTarget(bail, { command, liveTeams = true }) {
  dropAmbientRoot();
  const homeFlag = flag("home"), soulFlag = flag("soul"), rootFlag = flag("agents-root");
  if (homeFlag === true) return bail("E_BAD_ARGS", "--home needs an absolute instance home");
  if (soulFlag === true) return bail("E_BAD_ARGS", "--soul needs a soul name");
  if (rootFlag === true) return bail("E_BAD_ARGS", "--agents-root needs an absolute agents directory");
  const remoteOptions = remoteOptionsFromEnv();
  if (homeFlag) {
    if (!isAbsolute(homeFlag)) return bail("E_BAD_ARGS", "--home needs an absolute instance home");
    let meta = null;
    try { meta = JSON.parse(readFileSync(join(homeFlag, "instance.json"), "utf8")); } catch (e) { return bail("E_SESSION_UNKNOWN", `${homeFlag} is not an OATS instance home (${e.code === "ENOENT" ? "no instance.json" : e.message})`); }
    if (isCapturedHome(meta)) { const e = capturedHomeRefusal(homeFlag, "nothing was read"); return bail(e.code, e.message, e.details); }
    if (!meta || typeof meta.modules !== "object" || meta.modules === null) return bail("E_UNSUPPORTED_MODE", `${homeFlag} is not a workspace-model home (it records no modules): it was spawned by an earlier kernel — re-spawn it from the deployment`);
    if (soulFlag && !(await import("../lib/instance-resolution.mjs")).homeSoulMatches(soulFlag, meta)) return bail("E_HOME_MISMATCH", `--soul ${soulFlag} is not the soul of ${homeFlag} (${meta.agent})`);
    const deployment = dirname(dirname(dirname(dirname(realOrResolved(homeFlag)))));
    // A v2 home lives at <deployment>/agents/<soul>/instances/<name>: its deployment is
    // derived, so it must hold oats-local.yaml EXACTLY there (never found by walking up).
    if (!existsSync(join(deployment, "oats-local.yaml"))) return bail("E_HOME_MISMATCH", `${homeFlag} is not at <deployment>/agents/<soul>/instances/<name>: ${deployment} has no oats-local.yaml`, { home: homeFlag, expected: join(deployment, "oats-local.yaml") });
    if (flag("dir") !== undefined) { let given = null; try { given = dirname(loadLocal(dirFlag()).path); } catch { given = dirFlag(); } if (realOrResolved(given) !== realOrResolved(deployment)) return bail("E_HOME_MISMATCH", `--dir ${dirFlag()} is not the deployment of ${homeFlag} (${deployment}); omit --dir for a home`); }
    if (rootFlag && realOrResolved(rootFlag) !== realOrResolved(join(deployment, "agents"))) return bail("E_HOME_MISMATCH", `--agents-root ${rootFlag} is not the agents root of ${homeFlag}`);
    // A typed refusal (the deployment's removed team keys, team model 3) answers as one, as for --soul.
    try { return await homeTarget(homeFlag, meta, { remoteOptions, discover: command === "readiness", live: liveTeams }); }
    catch (e) { if (typeof e?.code === "string" && e.code.startsWith("E_")) return bail(e.code, e.message, e.details); throw e; }
  }
  try { if (!isWorkspaceContext(dirFlag())) return bail("E_LOCAL_MISSING", `${command} reads a workspace deployment, and none is in reach of ${dirFlag()} (no oats-local.yaml walking up; \`oats onboard\` creates one) — or pass --home <abs> of a workspace instance`); }
  catch (e) { return bail(e?.code || "E_WORKSPACE_SCHEMA", e?.message || String(e), e?.details); }
  if (!soulFlag) return bail("E_BAD_ARGS", `${command} on a workspace deployment needs --soul <name> or --home <abs>${command === "inspect" ? " (the deployment's souls and capabilities: oats souls / oats capabilities)" : ""}`);
  const deployment = dirname(loadLocal(dirFlag()).path);
  if (rootFlag && realOrResolved(rootFlag) !== realOrResolved(join(deployment, "agents"))) return bail("E_SOUL_UNKNOWN", `soul "${soulFlag}" is not at agents root ${rootFlag} (this deployment's is ${join(deployment, "agents")})`);
  try { return await soulTarget(dirFlag(), String(soulFlag), { remoteOptions }); }
  catch (e) { if (typeof e?.code === "string" && e.code.startsWith("E_")) return bail(e.code, e.message, e.details); throw e; }
}
function printWorkspaceInspect(doc) {
  const s = doc.subject;
  console.log(`oats inspect — ${s.kind === "instance" ? `instance ${s.instance} (soul ${s.soul}) ${shortPath(s.home)}` : `soul ${s.soul} from ${s.repoKey}`}`);
  if (doc.identity) console.log(`  identity: ${servedIdentityLine(doc.identity)}`);
  for (const l of LAYERS) console.log(`  ${l} capability: ${doc.layers[l].id || "none"}`);
  for (const c of doc.capabilities) console.log(`  ${c.id}@${c.version || "?"} ${c.from?.kind === "package" ? `package ${c.from.package}` : c.from?.kind === "member" ? `member ${c.from.repoKey}` : ""}${c.operations.length ? `  ops: ${c.operations.map((o) => `${o.name}${o.available ? "" : "(unavailable)"}`).join(", ")}` : ""}`);
  for (const p of doc.problems) console.log(`  ! ${p.code}: ${p.message}`);
  for (const w of doc.warnings) console.log(`  warning  ${w.code}  ${w.message}`);
  const composed = doc.souls[0].composedInstructions;
  if (composed !== undefined) console.log(composed ? `\nComposed AGENTS.md (a spawn here, resolution ${composed.resolution ?? "?"}${composed.truncated ? ", truncated" : ""}):\n\n${composed.text}` : "\nComposed AGENTS.md: unavailable (see the problems above)");
  const composedSkills = doc.souls[0].composedSkills;
  if (composedSkills !== undefined) {
    if (!composedSkills) console.log("\nComposed skills: unavailable (see the problems above)");
    else { console.log(`\nComposed skills (a spawn here): ${composedSkills.length || "none"}`); for (const k of composedSkills) console.log(`  ${k.name}  ${k.source === "soul" ? "soul" : k.source.slice("module:".length)}`); }
  }
}

/** `{ teams, defaultTeam, teamsSource }` for a session start of a workspace home: its teams read
 *  live (the workspace host + oats-local.yaml), which the launch hook re-checks joined memberships
 *  against — or the spawn record, marked `recorded`, when the read cannot answer. Anything that is not a readable workspace home gets nothing here — the start
 *  itself refuses it. */
async function homeLiveTeams(home) {
  let meta;
  try { meta = JSON.parse(readFileSync(join(home, "instance.json"), "utf8")); } catch { return {}; }
  if (!isWorkspaceHome(meta)) return {};
  const { liveTeams } = await import("../lib/instance-resolution.mjs");
  const { teams, defaultTeam, source } = await liveTeams(home, meta, { remoteOptions: remoteOptionsFromEnv() });
  return Array.isArray(teams) ? { teams, defaultTeam, teamsSource: source } : {};
}

/** For `--reselect-launch`: what the home's launch layers need of the workspace to say which keys of
 *  souls.launch name no soul (lib/core.mjs homeLaunchLayers), read only when they need it and the layers
 *  decide (`named`: --harness names the launch, so no key is consulted). A home the start will refuse
 *  anyway (no record, no deployment) asks for nothing here: the start says why. A read that fails is
 *  this command's answer, before anything is stopped or started. */
async function homeLaunchOffered(home, { named = false } = {}) {
  if (named) return null;
  let needed = false;
  try { needed = homeLaunchLayers(realpathSync(home), JSON.parse(readFileSync(join(home, "instance.json"), "utf8"))).needsOffered; } catch { return null; }
  const { homeSoulsOffered } = await import("../lib/instance-resolution.mjs");
  return homeSoulsOffered(realpathSync(home), { needed, remoteOptions: remoteOptionsFromEnv() });
}

// ---------- operation run: generic invoke through the capability engine ----------
/** `oats operation run <layer>:<name>`: resolve the provider that fills
 *  <layer> for a running home (its snapshot) or for a soul in a scope (the
 *  config), require the operation to be declared and the executable surface
 *  trusted, then run the provider's own command exactly as `oats <ns> <cmd>`
 *  would, in the home (context home) or the scope (context scope), and relay
 *  its envelope. A view operation must answer { documents: [...] }. No
 *  provider name appears here. */
const OPERATION_ADDRESS_RE = /^(knowledge|messaging|tasks):([a-z][a-z0-9-]*)$/;
/** The same phrasing the scheduler treats as retained effects. */
const reportsRetainedEffectsText = (message) => /INCOMPLETE|quarantin|retain|could not (?:be )?(?:verif|confirm)/i.test(String(message || ""));
// Comfortably below the scheduler's 5-minute command bound and any GUI
// proxy, so the receipt always reaches the caller before a wrapper gives up.
const OPERATION_TIMEOUT_MS = 4 * 60 * 1000;
function finishOperation({ r, bail, address, provider, op, argFlags, cwd, home, meta, cleanupError, intent, settlement, api }) {
  const stderr = String(r.stderr || "").trim();
  const timedOut = r.error?.code === "ETIMEDOUT" || (r.status === null && ["SIGTERM", "SIGKILL"].includes(r.signal) && (!settlement || !r.error));
  const base = { ...(api ? { operationsApi: api } : {}), operation: address, capability: provider.capability, version: provider.version || null, argv: [provider.command, op.command, ...argFlags], cwd, target: home ? { home, instance: meta.instance } : null };
  // Unconfirmed outcomes (a timeout, no valid receipt, a receipt contradicted
  // by the exit status) carry what WAS observed in error.details, so a
  // scheduler can keep the slot as unknown and reconcile by any name the
  // provider managed to answer; they are never confirmed failures.
  const observed = (envelope) => ({ exit: r.status, signal: r.signal || null, unconfirmed: true, ...(envelope && typeof envelope === "object" ? { envelope } : {}),
    ...(stderr ? { stderr: stderr.slice(0, 2000) } : {}), ...(cleanupError ? { cleanup: { code: cleanupError.code || "E_OPERATION_CLEANUP", message: String(cleanupError.message || cleanupError).slice(0, 1000) } } : {}) });
  if (r.error && !timedOut) bail("E_CAPABILITY_BROKEN", `${address}: ${r.error.message || r.error}`, settlement ? observed(parseEnvelopeText(String(r.stdout || ""))) : undefined);
  if (timedOut) bail("E_OPERATION_TIMEOUT", `${address} (${provider.capability} ${op.command}) did not finish within ${OPERATION_TIMEOUT_MS / 1000} s; its effects are unconfirmed`, observed(parseEnvelopeText(String(r.stdout || ""))));
  // Exactly one JSON-v1 envelope on stdout, nothing else, and an exit status
  // that agrees with it: contaminated output or a success envelope from a
  // process that then failed is not a receipt.
  let envelope;
  try { envelope = JSON.parse(String(r.stdout || "").trim()); } catch { envelope = undefined; }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || envelope.schemaVersion !== 1 || typeof envelope.ok !== "boolean") bail("E_OPERATION_RESULT", `${address} (${provider.capability} ${op.command}) did not answer exactly one JSON-v1 envelope on stdout (exit ${r.status}); its effects are unconfirmed${stderr ? `: ${stderr.slice(0, 400)}` : ""}`, observed(parseEnvelopeText(String(r.stdout || ""))));
  if (cleanupError) bail("E_OPERATION_RESULT", `${address} (${provider.capability} ${op.command}) answered, but private invocation cleanup could not be confirmed; its effects are unconfirmed`, observed(envelope));
  // A provider's own failure is relayed with its code; its WHOLE envelope
  // (a partial receipt such as result.instance of something it launched
  // before failing, and any details it gave) travels in error.details so a
  // scheduler can keep an unconfirmed outcome and reconcile that target.
  if (!envelope.ok) bail(envelope.error?.code || "E_OPERATION_FAILED", `${address}: ${envelope.error?.message || "failed"}`, { exit: r.status, envelope, ...(envelope.error?.details?.unconfirmed === true || reportsRetainedEffectsText(envelope.error?.message) ? { unconfirmed: true } : {}) });
  if (r.status !== 0) bail("E_OPERATION_RESULT", `${address} (${provider.capability} ${op.command}) answered ok but exited ${r.status}; the receipt is not trusted and its effects are unconfirmed${stderr ? `: ${stderr.slice(0, 400)}` : ""}`, observed(envelope));
  const result = envelope.result && typeof envelope.result === "object" ? envelope.result : {};
  if (op.kind === "view") {
    const docs = result.documents;
    const bad = !Array.isArray(docs) || docs.some((d) => !d || typeof d !== "object" || typeof d.label !== "string" || !d.label
      || (d.kind !== undefined && !["markdown", "text"].includes(d.kind))
      || (d.path !== undefined && d.path !== null && (typeof d.path !== "string" || !isAbsolute(d.path)))
      || (d.text !== undefined && d.text !== null && typeof d.text !== "string"));
    if (bad) bail("E_OPERATION_RESULT", `${address} is a view operation but ${provider.capability} ${op.command} did not answer { documents: [{label, kind?, path?, text?}] }`);
  }
  // A launch receipt in the delegated result (a harvester the provider
  // spawned) is surfaced as top-level instance/home so the scheduler tracks
  // it exactly as it tracks a command job's launch; the source home itself
  // is `target`, never a launch.
  const receipt = {};
  if (typeof result.instance === "string" && result.instance !== meta?.instance) receipt.instance = result.instance;
  if (typeof result.home === "string" && result.home !== home) receipt.home = result.home;
  const out = { ...base, ...receipt, result, ...(intent ? { intent } : {}), ...(stderr ? { stderr: stderr.slice(0, 2000) } : {}) };
  if (JSON_MODE) { jsonOk(out); return; }
  console.log(`${address} via ${provider.capability}@${provider.version || "?"} (${provider.command} ${op.command}) in ${shortPath(cwd)}: ok`);
  if (op.kind === "view") for (const d of result.documents) console.log(`  - ${d.label}${d.path ? ` (${shortPath(d.path)})` : ""}${d.text ? `: ${String(d.text).split("\n")[0].slice(0, 100)}` : ""}`);
  else console.log(JSON.stringify(result, null, 2));
  if (stderr) console.error(stderr);
}
/** --arg k=v pairs of `oats operation run`. */
function operationArgs(bail) {
  const given = Object.create(null);
  for (let i = 3; i < args.length; i++) {
    if (args[i] !== "--arg") continue;
    const kv = args[i + 1];
    if (!kv || kv.startsWith("--") || !kv.includes("=")) bail("E_BAD_ARGS", "--arg expects name=value");
    const eq = kv.indexOf("=");
    given[kv.slice(0, eq)] = kv.slice(eq + 1);
    i++;
  }
  return given;
}
/** `oats operation run` on the workspace model (operationsApi 2): the provider is
 *  the module filling <layer> — the home's own copy, or the soul's resolved module
 *  fetched into the deployment's module store — with its merged payload as
 *  OATS_SETTINGS and the team facts hooks get. */
async function workspaceOperation(t, { bail, address, layer, opName }) {
  if (t.resolutionError) return bail(t.resolutionError.code, t.resolutionError.message, t.resolutionError.details ?? undefined);
  const name = t.slots[layer];
  const mod = name ? t.modules.find((x) => x.name === name) : null;
  if (!mod?.manifest) return bail("E_OPERATION_UNAVAILABLE", `no ${layer} provider is resolved for ${t.home ? t.home : `soul ${t.soul.name}`}`);
  const provider = { ...mod.manifest, capability: mod.name };
  const op = manifestOperations(provider).find((o) => o.name === opName);
  if (!op) return bail("E_OPERATION_UNKNOWN", `${mod.name} declares no operation ${JSON.stringify(opName)} (declared: ${manifestOperations(provider).map((o) => o.name).join(", ") || "none"})`);
  const missingReq = manifestMissingRequires(provider);
  if (missingReq.length) return bail("E_CAPABILITY_REQUIRES", `${mod.name} requires ${missingReq.map((m) => `"${m.command}" on PATH${m.why ? ` (${m.why})` : ""}${m.install ? ` [install: ${m.install}]` : ""}`).join(", ")}; ${address} was not run`);
  if (op.context === "home" && !t.home) return bail("E_OPERATION_UNAVAILABLE", `${address} runs in an instance home; pass --home <abs>`);
  const given = operationArgs(bail);
  const declared = new Map(op.args.map((a) => [a.name, a]));
  for (const n of Object.keys(given)) if (!declared.has(n)) return bail("E_BAD_ARGS", `${address} takes no arg ${JSON.stringify(n)} (declared: ${[...declared.keys()].join(", ") || "none"})`);
  for (const a of op.args) if (a.required && given[a.name] === undefined) return bail("E_BAD_ARGS", `${address} needs --arg ${a.name}=<value>: ${a.description || "required"}`);
  const argFlags = op.args.flatMap((a) => (given[a.name] === undefined ? [] : [a.flag, given[a.name]]));
  const spec = provider.commands?.[op.command];
  if (typeof spec !== "string" || !spec.trim()) return bail("E_CAPABILITY_BROKEN", `${mod.name}: command ${op.command} is not a non-empty string`);
  let catalog = null; try { catalog = officialPackageCatalog(); } catch { catalog = null; }
  const { layerProvider } = await import("../lib/instance-inspect.mjs");
  let lp;
  try { lp = await layerProvider(t, layer, { catalog, remoteOptions: remoteOptionsFromEnv() }); } catch (e) { return bail(e.code || "E_CAPABILITY_BROKEN", e.message, e.details); }
  const [script, ...rest] = spec.trim().split(/\s+/);
  const abs = lp?.executable(script);
  if (!abs) return bail("E_CAPABILITY_BROKEN", `${mod.name} ${op.command}: script not found (${script})`);
  const settings = lp.settings;
  const cwd = op.context === "home" ? t.home : t.deployment;
  const env = { ...lp.env(mod.name, settings), OATS_OPERATION: address, OATS_CONTEXT: t.deployment, OATS_ROOT: t.agentsRoot, PI_AGENTS_ROOT: t.agentsRoot };
  // The home's identity, never one inherited from the caller (the reserved PI_AGENT_* names included).
  for (const k of ["OATS_INSTANCE", "OATS_INSTANCE_HOME", "OATS_HOME", "PI_AGENT_INSTANCE", "PI_AGENT_HOME"]) delete env[k];
  if (op.context === "home") Object.assign(env, { OATS_INSTANCE: t.meta.instance, OATS_INSTANCE_HOME: t.home, OATS_HOME: t.home });
  await readSession?.closeBatches(); // no idle `git cat-file --batch` child held for the provider's whole run
  const r = spawnSync("node", [abs, ...rest, ...argFlags, "--json"], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024, timeout: OPERATION_TIMEOUT_MS, killSignal: "SIGTERM" });
  finishOperation({ r, bail, address, provider, op, argFlags, cwd, home: t.home, meta: t.meta, api: INSPECT_OPERATIONS_API });
}
async function operationCmd() {
  const bail = (code, msg, details) => (JSON_MODE ? jsonFail(code, msg, details) : die(msg));
  dropAmbientRoot();
  if (args[1] !== "run") bail("E_USAGE", "usage: oats operation run <layer>:<name> (--home <abs> | --soul <name> [--dir <scope>] [--agents-root <abs>]) [--arg k=v ...] [--json]");
  const address = args[2];
  const m0 = typeof address === "string" ? OPERATION_ADDRESS_RE.exec(address) : null;
  if (!m0) bail("E_BAD_ARGS", `operation address must be <layer>:<name> with layer one of ${LAYERS.join(", ")} (got ${JSON.stringify(address)})`);
  const [, layer, opName] = m0;
  // Only the messaging provider's operations act on the teams: others get the record, no remote read.
  const target = await workspaceTarget(bail, { command: "operation run", liveTeams: layer === "messaging" });
  return workspaceOperation(target, { bail, address, layer, opName });
}


/** Doctor answers on a workspace deployment only (lead decision c3-6): the
 *  deployment found walking up from the given directory (positional or --dir),
 *  else E_LOCAL_MISSING; an unreadable oats-local.yaml is its own error. */
function doctorDeployment(dir) {
  const bail = (code, msg, details) => (JSON_MODE ? jsonFail(code, msg, details) : die(msg));
  const ctx = resolve(dir || dirFlag());
  const ws = doctorLockData(ctx);
  if (ws.localError) bail(ws.localError.code, ws.localError.message, ws.localError.details);
  if (!ws.local) bail("E_LOCAL_MISSING", `oats doctor reads a workspace deployment, and none is in reach of ${ctx} (no oats-local.yaml walking up; \`oats onboard\` creates one)`, { dir: ctx });
  return { ctx, ws };
}
async function doctorJson(dir) {
  const { ctx, ws } = doctorDeployment(dir);
  console.log(JSON.stringify(await doctorWorkspaceJson(ctx, flag("soul"), ws), null, 2));
}

/** The v2 doctor payload: the deployment declaration + lock (offline) and, with
 *  --soul, the composed instructions. No v1 keys (chain/layers/acquired/injects…). */
/** What retires left in the deployment (#703 part 2a), read-only: the
 *  `retained-recovery:` and `retained-worktree:` information lines, as one
 *  block per kind (a count line, then one line per item). */
function doctorRetained(ws) {
  const deployment = dirname(ws.local.path);
  const kept = retainedWorktrees(deployment);
  return [retainedRecoveryLines(join(deployment, "agents"), kept), retainedWorktreeLines(kept)].filter((block) => block.length);
}
/** The machine's launch configurations file (awebai/oats#1506) as doctor reports it: its path, whether
 *  it is there, its entries' names and whether it is valid. A broken file is reported, never a failure
 *  of doctor; the launches it would affect refuse it. */
function doctorMachineLaunchConfigs() {
  const file = machineLaunchConfigsFile();
  try {
    const machine = machineLaunchConfigs();
    return { file, present: machine !== null, ok: true, configurations: Object.keys(machine?.configs ?? {}).sort() };
  } catch (e) {
    if (e?.code !== "E_LAUNCH_CONFIG_INVALID") throw e;
    return { file, present: true, ok: false, configurations: [], error: e.message };
  }
}
async function doctorWorkspaceJson(ctx, soulName, ws) {
  const composition = await doctorComposition(ctx, soulName, ws, (code, msg, details) => jsonFail(code, msg, details));
  const agentsRoot = join(dirname(ws.local.path), "agents");
  const localTeams = doctorLocalTeams(ws.local.value);
  const schedules = unresolvedScheduleAttempts(dirname(ws.local.path));
  const operator = await doctorOperator(ws);
  const launchPreferences = await doctorLaunchPreferences(ws);
  // With --soul, the soul's composition; without, the deployment's capabilities (doctorHookWarnings).
  const hookEvents = composition ? { warnings: composition.warnings, information: [] } : await doctorHookWarnings(ws);
  const problems = [...legacyLayoutProblems(agentsRoot), readableInstanceHomes(agentsRoot), ...localTeams.problems, ...schedules.problems, ...operator.problems, ...launchPreferences.problems, ...retireIncompleteProblems(agentsRoot)].filter(Boolean);
  return {
    schemaVersion: 1, workspaceApi: 2, context: ctx,
    workspace: { file: ws.local.path, ref: ws.local.workspace },
    workspaceError: ws.localError, lockFile: ws.lockFile, packages: ws.packages, lockError: ws.lockError,
    information: [...(operationalKnowledgeNote(composition, soulName) ? [operationalKnowledgeNote(composition, soulName)] : []), ...localTeams.information, ...schedules.information, ...operator.information, ...launchPreferences.information, ...hookEvents.information, ...processScanInformation(), ...doctorRetained(ws).flat()],
    machineLaunchConfigs: doctorMachineLaunchConfigs(),
    composedInstructions: composition?.text, instructionBlocks: composition?.blocks,
    ...(problems.length ? { problems } : {}),
    warnings: [...hookEvents.warnings, ...(soulName ? [] : doctorCaptureWarnings())],
  };
}
/** Kernel/bridge version skew (published in lockstep from one tag), in every pi folder a launch
 *  of the deployment uses (lib/pi-bridge.mjs): one warning per folder. Text output only. */
function doctorVersionSkew(deployment) {
  let launchConfigs = {}, unread = null;
  try { launchConfigs = launchConfigsAt(deployment); } catch (e) { unread = e.message; }
  const warnings = piBridgeSkewWarnings(piBridgeFolders({ launchConfigs }), OATS_VERSION);
  if (unread) warnings.push(`pi bridge — the launch configurations could not be read, so only the default pi folder and this shell's were looked at: ${unread}`);
  for (const warning of warnings) console.log(`WARNING: ${terminalText(warning)}`);
  if (warnings.length) console.log("");
}
/** The "Workspace (v2, offline view)" + "Locked packages" sections, shared by both doctor shapes. */
function printDoctorWorkspace(ws) {
  console.log("\nWorkspace (v2, offline view):");
  console.log(`  oats-local.yaml  ${shortPath(ws.local.path)}  → workspace ${ws.local.workspace}`);
  console.log("\nLocked packages (oats-lock.json v3):");
  if (ws.lockError) {
    console.log(`  ERROR: ${ws.lockError.message} [${ws.lockError.code}]`);
    if (ws.lockError.file) console.log(`         the lock is never auto-repaired; delete ${shortPath(ws.lockError.file)} and run \`oats sync\``);
  } else if (!ws.packages.length) console.log(ws.lockFile ? "  (none)" : "  (no lock yet — run `oats sync`)");
  for (const p of ws.packages) {
    console.log(`  ${p.id} ${p.version}  ${p.source}  @ ${p.commit.slice(0, 12)}  ${p.integrity}`);
    if (p.capabilities.length) console.log(`             capabilities: ${p.capabilities.join(", ")}`);
  }
  console.log("  membership, discovery and drift need the remotes: `oats workspace status`, `oats sync`.");
}
async function doctor(dir) {
  const { ctx, ws } = doctorDeployment(dir);
  const soulName = flag("soul");
  console.log(`oats doctor — resolved from ${shortPath(ctx)}\n`);
  doctorVersionSkew(dirname(ws.local.path));
  const composition = await doctorComposition(ctx, soulName, ws, (code, msg) => die(`${msg} [${code}]`));
  printDoctorWorkspace(ws);
  const machine = doctorMachineLaunchConfigs();
  console.log("\nThis machine's launch configurations:");
  console.log(`  ${shortPath(machine.file)}  ${!machine.present ? "(none: no file)" : machine.ok ? (machine.configurations.join(", ") || "(none declared)") : `ERROR: ${terminalText(machine.error)}`}`);
  const agentsRoot = join(dirname(ws.local.path), "agents");
  const localTeams = doctorLocalTeams(ws.local.value);
  for (const p of [...legacyLayoutProblems(agentsRoot), readableInstanceHomes(agentsRoot)].filter(Boolean)) console.log(`\n! ${p.code}: ${p.message}`);
  for (const p of localTeams.problems) console.log(`\n! ${p.code} (${p.condition}): ${p.message}`);
  const schedules = unresolvedScheduleAttempts(dirname(ws.local.path));
  for (const p of schedules.problems) console.log(`\n! ${p.code}: ${p.message}`);
  const operator = await doctorOperator(ws);
  for (const p of operator.problems) console.log(`\n! ${p.code}: ${p.message}\n  ${p.remedy}`);
  const launchPreferences = await doctorLaunchPreferences(ws);
  for (const p of launchPreferences.problems) console.log(`\n! ${p.code}: ${p.message}\n  ${p.remedy}`);
  // Retirements left open (#1747): the command that finishes each, and whose hook failed last.
  for (const p of retireIncompleteProblems(agentsRoot)) console.log(`\n! ${p.code}: ${terminalText(p.message)}\n  ${terminalText(p.remedy)}`);
  const hookEvents = composition ? { warnings: composition.warnings, information: [] } : await doctorHookWarnings(ws);
  for (const w of hookEvents.warnings) console.log(`\nwarning  ${w.code}  ${w.message}`);
  if (!soulName) for (const w of doctorCaptureWarnings()) console.log(`\nwarning  ${w.code}  ${terminalText(w.message)}`);
  for (const line of [...localTeams.information, ...schedules.information, ...operator.information, ...launchPreferences.information, ...hookEvents.information, ...processScanInformation()]) console.log(`\nINFO: ${line}`);
  for (const block of doctorRetained(ws)) console.log(`\n${block.map((line) => `INFO: ${line}`).join("\n")}`);
  if (soulName) {
    const information = operationalKnowledgeNote(composition, soulName);
    if (information) console.log(`\nINFO: ${information}`);
    console.log(`\nFinal composed AGENTS.md for ${soulName}:\n\n${composition.text}`);
  } else console.log("\nPass --soul <name> to inspect final composed AGENTS.md.");
}

// ---------- config editing (structural: parse → mutate → re-serialize the capabilities block) ----------
/** Replace (or append, or drop with "") the top-level launch-configs block:
 *  the span from its key line (bare, quoted, or the inline `launch-configs: {...}`
 *  form) to the next top-level line is replaced; every byte before and after
 *  that span stays exactly as it was. Two declarations of the key are refused
 *  rather than guessed at. */
function replaceLaunchConfigsBlock(text, serialized) {
  const keyLine = /^(["']?)launch-configs\1:(\s*(?:#.*)?|\s+\S.*)?$/;
  const lines = text.split("\n");
  const starts = lines.map((l, i) => keyLine.test(l) ? i : -1).filter((i) => i >= 0);
  if (starts.length > 1) throw Object.assign(new Error(`oats-local.yaml declares launch-configs ${starts.length} times (lines ${starts.map((i) => i + 1).join(", ")}); keep one`), { code: "E_CONFIG_BROKEN" });
  const block = serialized ? serialized.replace(/\n$/, "").split("\n") : [];
  if (!starts.length) {
    if (!serialized) return text;
    const sep = text === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n"; // always its own blank separator, which removal takes back
    return text + sep + serialized;
  }
  const start = starts[0];
  // The block runs to the next real top-level key (a column-zero line that
  // is not a comment). Blank lines and column-zero comments directly ahead
  // of that key, or at the end of the file, are not part of it and stay
  // where they are; a column-zero comment followed by more indented entries
  // is inside the block (and is regenerated away with it).
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] !== "" && !/^\s/.test(lines[i]) && !lines[i].startsWith("#")) { end = i; break; }
  }
  while (end > start + 1 && (lines[end - 1] === "" || lines[end - 1].startsWith("#"))) end--;
  const tail = lines.slice(end);
  if (!tail.length) tail.push(""); // the block ended the file: the result still ends with a newline
  let prefixEnd = start;
  // Dropping the block drops the one blank line that separated it (before it
  // when it was appended, else after it); replacing it keeps one blank line
  // between the block and what follows.
  if (!block.length) { if (start > 0 && lines[start - 1] === "") prefixEnd = start - 1; else if (tail[0] === "" && tail.length > 1) tail.shift(); }
  const replaced = [...lines.slice(0, prefixEnd), ...block];
  if (block.length && tail[0] !== "") replaced.push("");
  return [...replaced, ...tail].join("\n");
}

// ---------- launch configurations ----------
const yamlQuoted = (v) => JSON.stringify(String(v));
/** The `launch-configs:` block, names sorted, every string double-quoted
 *  with JSON escapes (read back by the same rules), lists as block
 *  sequences: spaces, quotes, commas and metacharacters round-trip exactly. */
function serializeLaunchConfigs(map) {
  const names = Object.keys(map).sort();
  if (!names.length) return "";
  const lines = ["launch-configs:"];
  for (const name of names) {
    const e = map[name];
    lines.push(`  ${name}:`, `    harness: ${e.harness}`);
    if (e.executable !== undefined) lines.push(`    executable: ${yamlQuoted(e.executable)}`);
    if (e.args?.length) { lines.push("    args:"); for (const a of e.args) lines.push(`      - ${yamlQuoted(a)}`); }
    const envNames = Object.keys(e.env || {}).sort();
    if (envNames.length) {
      lines.push("    env:");
      for (const n of envNames) { const v = e.env[n]; if (typeof v === "string") lines.push(`      ${n}: ${yamlQuoted(v)}`); else lines.push(`      ${n}:`, `        fromEnv: ${v.fromEnv}`); }
    }
    if (e.model !== undefined) lines.push(`    model: ${yamlQuoted(e.model)}`);
    if (e.yolo !== undefined) lines.push(`    yolo: ${e.yolo}`);
    if (e.default === true) lines.push("    default: true");
  }
  return lines.join("\n") + "\n";
}
/** Only the declared keys, in canonical order, from a validated entry. */
/** A configuration as `launch-config set` writes it: `harness` always — a `runtime` (the
 *  pre-0.27 name, read either) is written back under its new name (lead call 6). */
function normalizeLaunchConfig(e) {
  return {
    harness: Object.hasOwn(e, "harness") ? e.harness : e.runtime,
    ...(e.executable !== undefined ? { executable: e.executable } : {}),
    ...(e.args?.length ? { args: [...e.args] } : {}),
    ...(e.env && Object.keys(e.env).length ? { env: Object.fromEntries(Object.keys(e.env).sort().map((n) => [n, typeof e.env[n] === "string" ? e.env[n] : { fromEnv: e.env[n].fromEnv }])) } : {}),
    ...(e.model !== undefined ? { model: e.model } : {}),
    ...(e.yolo !== undefined ? { yolo: e.yolo } : {}),
    ...(e.default === true ? { default: true } : {}),
  };
}
function readLaunchConfigsModel(local) {
  const map = local["launch-configs"] || {};
  for (const [name, entry] of Object.entries(map)) validateLaunchConfig(name, entry, "oats-local.yaml");
  const out = Object.create(null); // a name may be "constructor": membership is own only
  for (const [n, e] of Object.entries(map)) out[n] = normalizeLaunchConfig(e);
  return out;
}
/** Whether the machine's launch configurations file declares `name`; a broken file declares nothing here
 *  (the launches it affects refuse it). */
/** The file a launch configuration of this machine was declared in, from its `source` directory. */
function launchConfigFile(source) {
  return source === dirname(machineLaunchConfigsFile()) ? machineLaunchConfigsFile() : join(source, "oats-local.yaml");
}
function machineDeclares(name) {
  try { return Object.hasOwn(machineLaunchConfigs()?.configs ?? {}, name); } catch (e) { if (e?.code === "E_LAUNCH_CONFIG_INVALID") return false; throw e; }
}
/** What a GUI or an operator sees of one configuration. Environment values
 *  never leave the file: a literal is answered as {redacted: true} (literals
 *  are non-secret by contract, but no value is shown anywhere) and a
 *  reference as {fromEnv: NAME}. An editor keeps a literal it cannot see with
 *  `set --keep-env`. */
function publicLaunchConfig(e, extra = {}) {
  const env = Object.fromEntries(Object.keys(e.env || {}).sort().map((n) => [n, typeof e.env[n] === "string" ? { redacted: true } : { fromEnv: e.env[n].fromEnv }]));
  return { harness: e.harness, executable: e.executable ?? null, args: [...(e.args || [])], env, model: e.model ?? null, yolo: e.yolo ?? null, default: e.default === true, ...extra };
}
/** The scope a launch-config command reads: --dir (or cwd), a running
 *  home's recorded context (--home), or a soul's own member context
 *  (--soul, with --dir/--agents-root as inspect takes them). */
function launchConfigContext(bail) {
  const homeFlag = flag("home");
  const soulFlag = flag("soul");
  if (homeFlag !== undefined && soulFlag !== undefined) bail("E_BAD_ARGS", "choose --home or --soul, not both");
  if (homeFlag !== undefined) {
    if (homeFlag === true || !isAbsolute(String(homeFlag))) bail("E_BAD_ARGS", "--home needs an absolute instance home");
    const home = realOrResolved(String(homeFlag));
    let meta;
    try { meta = JSON.parse(readFileSync(join(home, "instance.json"), "utf8")); } catch (e) { bail("E_HOME_UNKNOWN", `${home} is not an OATS instance home (${e.message})`); }
    const ctx = homeContexts(home, meta)[0];
    return { context: ctx, selected: { home, instance: meta.instance || null } };
  }
  const ctx = dirFlag();
  if (soulFlag !== undefined) {
    if (soulFlag === true) bail("E_BAD_ARGS", "--soul needs a soul name");
    const agentsRootFlag = flag("agents-root");
    if (agentsRootFlag === true) bail("E_BAD_ARGS", "--agents-root needs an absolute agents directory");
    let soul;
    try { soul = selectSoul(scopeSouls(ctx).souls, String(soulFlag), agentsRootFlag, ctx); } catch (e) { bail(e.code || "E_SOUL_UNKNOWN", e.message); }
    return { context: memberContextOf(soul, ctx, flag("dir") !== undefined, bail), selected: { soul: soul.name, agentsRoot: soul.agentsRoot } };
  }
  return { context: ctx, selected: null };
}
/** oats launch-config preview: what a start of a home (or a new instance of
 *  a soul) would run under a selection, resolved against the current scoped
 *  configuration, preflighted, read-only; environment values withheld and
 *  the prompt named, never the TASK body. */
function launchPreview(bail) {
  for (const k of ["launch-config", "harness", "runtime", "model"]) if (flag(k) === true) bail("E_BAD_ARGS", `--${k} needs a value`);
  const sel = { launchConfig: flag("launch-config"), harness: harnessFlag(), model: flag("model"), yolo: yoloFlag() };
  if (sel.harness !== undefined && !LAUNCH_HARNESSES.includes(sel.harness)) bail("E_BAD_ARGS", `--harness must be one of ${LAUNCH_HARNESSES.join(", ")}`);
  const { context, selected } = launchConfigContext(bail);
  if (!selected) bail("E_BAD_ARGS", "preview needs --home <abs> (an existing instance) or --soul <name> [--dir <scope>] (a new instance)");
  const selectionGiven = sel.launchConfig !== undefined || sel.harness !== undefined || sel.model !== undefined || sel.yolo !== undefined;
  let meta = null, agentLike, home, instance;
  if (selected.home) {
    home = selected.home;
    try { meta = upgradeHomeMeta(JSON.parse(readFileSync(join(home, "instance.json"), "utf8")), home); } catch (e) { bail("E_HOME_UNKNOWN", `${home}: ${e.message}`); }
    instance = meta.instance || basename(home);
    if (!(meta.launch && typeof meta.launch === "object") && !selectionGiven) {
      // A home that predates recipes, asked nothing: its frozen command is
      // described as a start runs it (with its harness's safe task prompt). Under a
      // selection the planner refuses it (E_LAUNCH_LEGACY: re-spawn it from the deployment).
      let d, frozen;
      try { frozen = withSafeTaskPrompt(meta.command, meta.harness); d = describeLaunchCommand(frozen); } catch (e) { bail(e.code || "E_LAUNCH_COMMAND_UNSUPPORTED", e.message); }
      const notices = launchStartNotices(dirname(dirname(dirname(dirname(home)))), meta.harness, frozen);
      jsonOk({ context, selected, ...(notices.length ? { warnings: notices } : {}), selection: { source: "frozen-command", launchConfig: null, harness: null, model: null, yolo: null }, harness: meta.harness, model: meta.model || null, modelSource: meta.model ? "recorded" : "native default", yolo: meta.yolo ?? null, launchConfig: null, launchConfigSource: null, launchConfigDefault: false, executable: { path: d.executable, declared: null, resolvedFrom: "recorded" }, argv: d.argv, environment: d.environment, command: redactLaunchCommand(frozen), prompt: { kind: "task-file", file: "TASK.md" }, hooks: null, preflight: [{ check: "recipe", ok: true, detail: "frozen command; a selection is refused (E_LAUNCH_LEGACY): re-spawn it" }], ok: true });
      return;
    }
    const agentsRoot = agentsRootOfHome(home);
    const agent = (() => { try { return findAgent(agentsRoot, meta.agent); } catch { return undefined; } })();
    agentLike = agent || { harness: meta.harness, model: meta.model, yolo: meta.yolo };
  } else {
    const soul = scopeSouls(context).souls.find((x) => x.name === selected.soul && x.agentsRoot === selected.agentsRoot);
    agentLike = { harness: soul.harness, model: soul.model };
    instance = `${soul.name}-<purpose>`; home = join(selected.agentsRoot, soul.name, "instances", instance);
  }
  // A home's recorded capabilities; a new instance's are its spawn's resolution,
  // which a preview of a soul does not prepare (spawn --preview does).
  let r;
  try { r = meta ? resolvedFromHome(home, meta) : { capabilities: [], launchConfigs: launchConfigsAt(context) }; } catch (e) { bail(e.code || "E_CONFIG_BROKEN", e.message, e.details); }
  // The same planner a start uses, in preview mode: failed checks are listed, nothing is touched.
  // Its checks read the pane a launch would run in, as a command that only reads can know it (a
  // home's recorded session, a soul's session default; with no server running, not established).
  let plan;
  try { plan = planLaunch({ home, instance, meta, contextDir: context, agentLike, selection: sel, resolvedCfg: r, preview: true, pane: () => previewPaneEnvironment(meta ? { home, meta } : { deployment: context }) }); } catch (e) { bail(e.code || "E_BAD_ARGS", e.message); }
  const { recipe } = plan;
  const command = renderLaunchRecipe(recipe, { home, instance, redact: true, trustHome: plan.trustHome });
  const d = describeLaunchCommand(command);
  const environment = d.environment.map((e) => e.reference && recipe.env[e.name]?.fromEnv ? { name: e.name, fromEnv: recipe.env[e.name].fromEnv } : e);
  jsonOk({ context, selected, ...(plan.warnings?.length ? { warnings: plan.warnings } : {}), selection: { source: plan.selectionSource, launchConfig: recipe.launchConfig, harness: sel.harness ?? null, model: sel.model ?? null, yolo: sel.yolo ?? null }, harness: plan.harness, model: recipe.model, modelSource: plan.modelSource, yolo: recipe.yolo ?? null, launchConfig: recipe.launchConfig, launchConfigSource: recipe.launchConfigSource, launchConfigDefault: recipe.launchConfigDefault === true, executable: { path: plan.executable.path, declared: plan.executable.declared ?? null, resolvedFrom: plan.executable.resolvedFrom }, argv: d.argv, environment, command, prompt: recipe.prompt, hooks: redactLaunchRecipe(recipe).hooks, preflight: plan.preflight, ok: plan.ok });
}
async function launchConfigCmd() {
  const bail = (code, msg, details) => (JSON_MODE ? jsonFail(code, msg, details) : die(msg));
  dropAmbientRoot();
  const sub = args[1];
  const usage = "usage: oats launch-config list [--dir <scope> | --home <abs> | --soul <name> [--dir <scope>] [--agents-root <abs>]] [--json] | set <name> --file <json> [--keep-env] [--dir <scope>] [--json] | remove <name> [--dir <scope>] [--json] | preview (--home <abs> | --soul <name> [--dir <scope>]) [--launch-config <name>|none] [--harness r] [--model m] [--yolo|--no-yolo] --json";
  if (sub === "preview") { launchPreview(bail); return; }
  if (!["list", "set", "remove"].includes(sub)) bail("E_USAGE", usage);
  const { context: dir, selected } = sub === "list" ? launchConfigContext(bail) : { context: dirFlag(), selected: null };
  if (sub !== "list" && (flag("home") !== undefined || flag("soul") !== undefined)) bail("E_BAD_ARGS", `launch-config ${sub} writes the deployment's oats-local.yaml: address it with --dir, not --home or --soul`);
  // Lead decision 2: launch configurations are a HOST choice, declared in the
  // deployment's oats-local.yaml (found walking up; a home's own deployment).
  const at = selected?.home ?? dir;
  // A 0.25 oats-config.yaml in reach is refused by loadLocal (E_CONFIG_BROKEN, naming
  // the move), never read as "no configurations".
  let found = null;
  // No deployment in reach answers the (empty) effective set — unless what is in
  // reach is a 0.25 oats-config.yaml, whose launch-configs nothing reads any more.
  try { found = loadLocal(at); } catch (e) { if (e?.code !== "E_LOCAL_MISSING" || e.details?.legacy) bail(e.code || "E_WORKSPACE_SCHEMA", e.message, e.details); }
  const file = found?.path ?? null, level = file ? dirname(file) : null;
  const effective = () => Object.values(launchConfigsAt(at)).sort((a, b) => a.name.localeCompare(b.name)).map((e) => ({ name: e.name, ...publicLaunchConfig(e, { source: e.source, shadows: e.shadows }) }));
  if (sub === "list") {
    let configurations;
    try { configurations = effective(); } catch (e) { bail(e.code || "E_LAUNCH_CONFIG_INVALID", e.message); }
    if (JSON_MODE) { jsonOk({ context: dir, level, file, selected, configurations }); return; }
    if (!configurations.length) { console.log(`No launch configurations are declared${file ? ` in ${shortPath(file)}` : ` (no oats-local.yaml in reach of ${dir})`} or in ${shortPath(machineLaunchConfigsFile())}`); return; }
    for (const c of configurations) {
      const env = Object.entries(c.env).map(([n, v]) => v.fromEnv ? `${n}=$${v.fromEnv}` : `${n}=<redacted>`).join(" ");
      console.log(`${c.name}: ${c.harness}${c.default ? ` (this machine's ${c.harness} default)` : ""}${c.executable ? ` ${c.executable}` : ""}${c.args.length ? ` ${c.args.map((a) => JSON.stringify(a)).join(" ")}` : ""}${env ? ` [${env}]` : ""}${c.model ? ` model ${c.model}` : ""}${c.yolo !== null ? ` yolo ${c.yolo}` : ""} (from ${shortPath(launchConfigFile(c.source))})${c.shadows.length ? ` (replaces ${c.shadows.map(shortPath).join(", ")}'s)` : ""}`);
    }
    return;
  }
  if (!file) bail("E_LOCAL_MISSING", `launch-config ${sub} writes the deployment's oats-local.yaml, and none is in reach of ${dir} — run it from the deployment (\`oats onboard\` creates one)`);
  const name = args[2];
  if (!name || name.startsWith("--")) bail("E_BAD_ARGS", `launch-config ${sub} needs a configuration name`);
  // What needs only the arguments is read and refused here, before the lock is taken: the definition
  // (stdin is read asynchronously, and the edit below is synchronous) and its own validity.
  let entry, f;
  const keepEnv = sub === "set" && args.includes("--keep-env");
  if (sub === "set") {
    f = flag("file");
    if (!f || f === true) bail("E_BAD_ARGS", "launch-config set needs --file <json> (an object with harness and optional executable, args, env, model, yolo)");
    // A parse error is reported without the parser's text: its message can
    // quote the document, and a definition may carry environment literals.
    let raw;
    if (f === "-") {
      // The routed form: the definition's bytes arrive on stdin (the ssh
      // transport); no local file name crosses the wire.
      if (process.stdin.isTTY) bail("E_BAD_ARGS", "--file - reads the definition from stdin");
      try { raw = (await readStreamBounded(process.stdin, INSPECT_TEXT_CAP)).toString("utf8"); } catch (e) { bail(e.code || "E_BAD_ARGS", e.message); }
    } else {
      try { raw = readFileSync(f, "utf8"); } catch (e) { bail("E_BAD_ARGS", `--file ${f}: ${e.code === "ENOENT" ? "no such file" : e.code || "cannot read"}`); }
    }
    try { entry = JSON.parse(raw); } catch { bail("E_BAD_ARGS", `--file ${f} is not valid JSON (one object with harness and optional executable, args, env, model, yolo)`); }
    if (keepEnv && entry && typeof entry === "object" && entry.env !== undefined) bail("E_BAD_ARGS", "--keep-env keeps the environment of the declared definition; omit env from --file");
    // As given. With --keep-env it is judged again under the lock, with the environment it keeps.
    try { validateLaunchConfig(name, entry, `--file ${f}`); } catch (e) { bail(e.code || "E_LAUNCH_CONFIG_INVALID", e.message); }
    if (!Object.hasOwn(entry, "harness")) noteRuntimeName(`runtime in the --file definition (written as harness)`);
  }
  // The write goes through the one path that rewrites oats-local.yaml (lib/local-edit.mjs editLocal): the
  // deployment's local lock, and the file as it is under it. Everything this command derives from the
  // file, it derives there: whether the name is declared, `before`, the environment --keep-env keeps and
  // the one default per harness. The edit runs with the lock held, so it never ends the process: a
  // refusal is thrown with the code, the text and the details it is answered with, and answered below,
  // once the lock is released.
  const refusal = (code, message, details) => Object.assign(new Error(message), { code, details });
  let model, before;
  const { editLocal } = await import("../lib/local-edit.mjs");
  try {
    editLocal({ deployment: level, localPath: file }, { verb: `oats launch-config ${sub}` }, ({ text, local }) => {
      try { model = readLaunchConfigsModel(local); } catch (e) { throw refusal(e.code || "E_LAUNCH_CONFIG_INVALID", e.message); }
      const declaredHere = Object.hasOwn(model, name);
      before = declaredHere ? publicLaunchConfig(model[name]) : null;
      if (sub === "remove") {
        if (!declaredHere) throw refusal("E_LAUNCH_CONFIG_UNKNOWN", `${name} is not declared in ${shortPath(file)}${machineDeclares(name) ? `; it is this machine's, in ${shortPath(machineLaunchConfigsFile())}, which OATS never writes` : ""}`);
        delete model[name];
      } else {
        let written = entry;
        if (keepEnv) {
          // An editor that saw only redacted values keeps the environment of the
          // declared definition of that name: a one-time copy into the complete
          // replacement entry. A name only this machine declares keeps the machine
          // entry's, so the first save of a machine row writes the entry that shadows it.
          let current = declaredHere ? model[name] : undefined;
          if (!current) { try { const machine = machineLaunchConfigs()?.configs ?? {}; if (Object.hasOwn(machine, name)) current = machine[name]; } catch (e) { throw refusal(e.code || "E_LAUNCH_CONFIG_INVALID", e.message, e.details); } }
          if (!current) throw refusal("E_LAUNCH_CONFIG_UNKNOWN", `--keep-env: no launch configuration ${name} is declared in ${shortPath(file)} or in ${shortPath(machineLaunchConfigsFile())}, so there is no environment to keep; declare it with env`);
          if (Object.keys(current.env || {}).length) written = { ...entry, env: { ...current.env } };
          try { validateLaunchConfig(name, written, `--file ${f}`); } catch (e) { throw refusal(e.code || "E_LAUNCH_CONFIG_INVALID", e.message); }
        }
        model[name] = normalizeLaunchConfig(written);
        // One default per harness, over the file as it would be written (no automatic move).
        try { validateLaunchConfigDefaults(model, shortPath(file)); } catch (e) { throw refusal(e.code || "E_LAUNCH_CONFIG_INVALID", e.message, e.details); }
      }
      let next;
      try { next = replaceLaunchConfigsBlock(text, serializeLaunchConfigs(model)); } catch (e) { throw refusal(e.code || "E_CONFIG_BROKEN", `${e.message}; nothing was written`); }
      // What is written must read back as exactly what was asked, by the kernel's
      // own reader, before a byte of the file changes. These refusals are this command's, with its
      // code: editLocal's own look at the text (E_WORKSPACE_SCHEMA) then finds nothing to refuse.
      let readBack;
      let nextLocal;
      try { nextLocal = parseConfigData(next, { origin: { kind: "local", path: file } }).value; readBack = nextLocal["launch-configs"] || {}; } catch (e) { throw refusal("E_LAUNCH_CONFIG_INVALID", `the rewritten block does not parse: ${e.message}; nothing was written`); }
      const schemaProblems = validateLocal(nextLocal);
      if (schemaProblems.length) throw refusal("E_LAUNCH_CONFIG_INVALID", `the rewritten oats-local.yaml would be invalid (${schemaProblems.map((p) => `${p.path || "/"}: ${p.message}`).join("; ")}); nothing was written`);
      const canonical = (m) => JSON.stringify(Object.keys(m).sort().map((n) => [n, normalizeLaunchConfig(m[n])]));
      const same = canonical(readBack) === canonical(model);
      if (!same) throw refusal("E_LAUNCH_CONFIG_INVALID", `${name} would not read back as written; nothing was written`);
      return { text: next };
    });
  } catch (e) { if (typeof e?.code === "string" && e.code.startsWith("E_")) return bail(e.code, e.message, e.details); throw e; }
  let eff = null;
  try { eff = effective().find((c) => c.name === name) || null; } catch (e) { eff = { error: e.message }; }
  const receipt = { name, action: sub, level, file, before, after: Object.hasOwn(model, name) ? publicLaunchConfig(model[name]) : null, effective: eff };
  if (JSON_MODE) { jsonOk(receipt); return; }
  console.log(sub === "set" ? `Declared launch configuration ${name} in ${shortPath(file)}` : `Removed launch configuration ${name} from ${shortPath(file)}`);
}


/** `oats instance waiting <set|clear>` and `oats instance attention` (feature
 *  waiting-on-you): a producer's claim that an instance is blocked on a human,
 *  recorded as a `waiting` event only when the producer's live claim changes
 *  (lib/instance-events.mjs setWaiting). `waiting` addresses a home like
 *  `instance events` (--home, else $OATS_INSTANCE_HOME, else the home enclosing
 *  the cwd; it must be a home of its name under the scope); `attention` is the
 *  agent's own sugar for `waiting --producer agent --reason attention` and acts
 *  only on $OATS_INSTANCE_HOME. Local only (no --server route). A claim is
 *  display-only evidence: nothing in the kernel acts on it. */
function instanceWaitingCmd(sub, bail) {
  dropAmbientRoot();
  const usage = sub === "attention"
    ? "usage: oats instance attention [--message <text>] [--clear] [--json]"
    : "usage: oats instance waiting <set|clear> --producer <id> [--reason permission|question|attention] [--message <text>] [--home <abs>] [--dir <d>] [--json]";
  const value = (name) => { const v = flag(name); if (v === true) throw Object.assign(new Error(`--${name} needs a value${name === "message" ? " (a message that starts with -- goes as --message=<text>)" : ""}`), { code: "E_BAD_ARGS" }); return v; };
  let home, producer, waiting, reason, message;
  try {
    message = value("message");
    if (sub === "attention") {
      if (args[2] && !args[2].startsWith("--")) return bail("E_BAD_ARGS", usage);
      for (const f of ["home", "dir", "producer", "reason"]) if (args.includes(`--${f}`)) return bail("E_BAD_ARGS", `oats instance attention has no --${f}: it records the agent's own claim on the instance it runs in ($OATS_INSTANCE_HOME); ${usage}`);
      home = process.env.OATS_INSTANCE_HOME;
      if (!home || !isAbsolute(home) || incarnationOf(home) === null) return bail("E_USAGE", `oats instance attention runs inside an instance session: $OATS_INSTANCE_HOME is ${home ? `${home}, which is not an instance home (no readable instance.json)` : "unset"}`);
      producer = "agent"; waiting = !args.includes("--clear");
      if (waiting) reason = "attention";
    } else {
      const verb = args[2];
      if (!["set", "clear"].includes(verb)) return bail("E_BAD_ARGS", usage);
      waiting = verb === "set";
      producer = value("producer"); reason = value("reason");
      if (producer === undefined) return bail("E_BAD_ARGS", `--producer is required; ${usage}`);
      // Producer `agent` is the agent's own claim: only `attention` writes it.
      if (producer === "agent") return bail("E_BAD_ARGS", "--producer agent is reserved for the agent's own claim: use `oats instance attention [--message <text>]` or `oats instance attention --clear` from its session");
      const homeOpt = flag("home");
      if (homeOpt === true || (homeOpt !== undefined && !isAbsolute(homeOpt))) return bail("E_BAD_ARGS", "--home needs an absolute instance home");
      home = homeOpt ?? (process.env.OATS_INSTANCE_HOME || enclosingInstanceHome(logicalCwd()));
      if (!home) return bail("E_BAD_ARGS", `no instance home: pass --home <abs>, or run it inside an instance; ${usage}`);
      if (!isAbsolute(home)) return bail("E_BAD_ARGS", `$OATS_INSTANCE_HOME must be an absolute instance home (${home})`);
    }
    if (sub === "attention" && !waiting && message !== undefined) return bail("E_BAD_ARGS", "--message is for setting attention, not --clear");
    if (incarnationOf(home) === null) return bail("E_SESSION_UNKNOWN", `${home} is not an instance home (no readable instance.json)`);
    // The home must be a home of its own name under the scope: --dir when
    // given, else the agents root the home sits in.
    const root = flag("dir") !== undefined ? ensureRoot(dirFlag()) : agentsRootOfHome(home);
    const { resolveInstance } = await_import_lifecycle();
    try { resolveInstance(dirFlag(), root, basename(home), { home }); }
    catch (e) { if (sub === "attention") return bail("E_USAGE", `$OATS_INSTANCE_HOME (${home}) is not an instance home under ${root}: ${e.message}`); throw e; }
    const r = setWaiting(home, { producer, waiting, ...(reason !== undefined ? { reason } : {}), ...(message !== undefined ? { message } : {}) });
    if (JSON_MODE) { jsonOk(r); return; }
    const w = r.waitingOnYou;
    console.log(`${r.instance}: ${r.changed ? "recorded" : "unchanged"} — ${r.producer} ${w ? `needs input (${w.reason})${w.message ? `: ${w.message}` : ""}` : "not waiting"}`);
  } catch (e) { return bail(e.code || "E_EVENTS_FAILED", e.message, e.candidates ? { candidates: e.candidates } : undefined); }
}

/** `oats worktree add|remove` (#796, feature worktree-event): an instance's extra trees,
 *  `<home>/.work-<purpose>`, made from its home (lib/worktree.mjs). The home is
 *  $OATS_INSTANCE_HOME (or $OATS_HOME), else the home enclosing the working directory.
 *  `add` streams the worktree hooks' output to stderr; stdout holds only the answer
 *  (one envelope with --json). An interrupt exits 128+signal after the rollback. */
async function worktreeCmd() {
  const bail = (code, msg, details, exit) => (JSON_MODE ? jsonFail(code, msg, details, exit) : die(msg, exit));
  const sub = args[1];
  const usage = "usage: oats worktree add --purpose <p> --branch <b> --base <remote-branch> [--repo <member key|clone path>] [--preview] [--json] | oats worktree remove --purpose <p> [--json]";
  if (!["add", "remove"].includes(sub)) return bail("E_BAD_ARGS", usage);
  if (flag("server") !== undefined) return bail("E_BAD_ARGS", "oats worktree runs in an instance home on this machine; --server is not accepted");
  for (const f of ["dir", "home"]) if (args.includes(`--${f}`)) return bail("E_BAD_ARGS", `oats worktree has no --${f}: it acts on the instance home it runs in; ${usage}`);
  const value = (name) => { const v = flag(name); if (v === true) throw Object.assign(new Error(`--${name} needs a value`), { code: "E_BAD_ARGS" }); return v === undefined ? undefined : String(v); };
  const homeVariable = ["OATS_INSTANCE_HOME", "OATS_HOME"].find((name) => process.env[name]);
  const home = homeVariable ? process.env[homeVariable] : enclosingInstanceHome(logicalCwd());
  if (!home) return bail("E_BAD_ARGS", `oats worktree runs from an instance home: run it in the home (or below it), or with $OATS_INSTANCE_HOME set; ${usage}`);
  const W = await import("../lib/worktree.mjs");
  // A caller that closes its end of stdout or stderr (a tool shell killed, Desktop gone) has only
  // stopped reading: the add or remove goes on to its consistent end, and what it can no longer
  // print is dropped. Unhandled, that EPIPE would end this process mid-hook, with no rollback.
  const readerGone = (e) => { if (e?.code !== "EPIPE" && e?.code !== "ERR_STREAM_DESTROYED") throw e; };
  process.stdout.on("error", readerGone);
  process.stderr.on("error", readerGone);
  try {
    if (sub === "remove") {
      for (const f of ["branch", "base", "repo", "preview"]) if (args.includes(`--${f}`)) return bail("E_BAD_ARGS", `oats worktree remove takes only --purpose; ${usage}`);
      const r = await W.worktreeRemove(resolve(home), { purpose: value("purpose") });
      if (JSON_MODE) { jsonOk(r); return; }
      console.log(r.rolledBack
        ? `rolled back the interrupted add of ${r.path}; branch ${r.branch} ${r.branchKept ? `kept${r.branchKeptReason ? ` (${r.branchKeptReason})` : ""}` : "not left behind"}`
        : `removed ${r.path}; branch ${r.branch} kept`);
      for (const w of r.warnings || []) console.error(`oats: warning: ${w}`);
      return;
    }
    const r = await W.worktreeAdd(resolve(home), { purpose: value("purpose"), branch: value("branch"), base: value("base"), repo: value("repo"), preview: args.includes("--preview") });
    if (JSON_MODE) { jsonOk(r); return; }
    if (r.preview) {
      console.log(`preview ${r.path} from ${r.clone} (origin ${r.remote || "?"}): branch ${r.branch} at origin's ${r.base}${r.resume === "noop" ? " — already made: add is a no-op" : r.resume === "recover" ? " — an interrupted add is rolled back first" : ""}; nothing was fetched or written`);
      const hooks = r.resume === "noop" ? [] : r.hooks;
      console.log(hooks.length ? `worktree hooks: ${hooks.map((h) => `${h.capability}${h.required ? " (required)" : ""}`).join(", ")}` : "worktree hooks: none");
      return;
    }
    console.log(r.resumed ? `${r.path} is already made (branch ${r.branch} from ${r.base} @ ${String(r.baseOid).slice(0, 12)}); nothing was run` : `made ${r.path}: branch ${r.branch} from origin's ${r.base} @ ${String(r.baseOid).slice(0, 12)}${r.hooks.length ? `; worktree hooks: ${r.hooks.map((h) => `${h.capability} ${h.ok ? "ok" : "FAILED"}`).join(", ")}` : ""}`);
    for (const w of r.warnings || []) console.error(`oats: warning: ${w}`);
  } catch (e) {
    if (TYPED_CLI_FAILURES.has(e?.code)) throw e;
    return lifecycleFail(e, "E_LIFECYCLE_FAILED", e.details, e.exitStatus);
  }
}

/** realpath of `p`, or of its nearest existing ancestor with the rest re-appended:
 *  how lib/instance-events.mjs names a removed home (realOrNearest). */
function realOrNearestPath(p) {
  let d = resolve(p); const tail = [];
  while (!existsSync(d) && dirname(d) !== d) { tail.unshift(basename(d)); d = dirname(d); }
  try { return join(realpathSync(d), ...tail); } catch { return resolve(p); }
}
/** #642: the addresses of a RETIRED instance `name` under `root`, from the
 *  workspace logs that outlive its home (<deployment>/.agents/events/
 *  <agent>--<name>.jsonl), as `{ root, agent, home }` like resolveInstance's
 *  candidates. Asked only when no live home resolves. A `home` (the --home
 *  claim) counts only when it is <root>/<agent>/instances/<name> by real path
 *  and that agent's log exists; the agent is then read from the path, never
 *  from the log's file name, and the row carries the claim as `asked` while
 *  `home` is the scope's spelling, from which the logs are found (an alias of
 *  the agents root elsewhere would lead readEvents to another deployment). */
function retiredInstanceAddresses(root, name, home) {
  const events = join(workspaceOf(root), ".agents", "events"), suffix = `--${name}.jsonl`;
  const logged = (agent) => { try { return lstatSync(join(events, `${agent}${suffix}`)).isFile(); } catch { return false; } };
  if (home !== undefined) {
    const h = resolve(home), agent = basename(dirname(dirname(h)));
    const ok = basename(h) === name && basename(dirname(h)) === "instances" && agent && realOrNearestPath(h) === realOrNearestPath(join(root, agent, "instances", name)) && logged(agent);
    return ok ? [{ root, agent, home: join(root, agent, "instances", name), asked: home }] : [];
  }
  let entries; try { entries = readdirSync(events, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isFile() && e.name.endsWith(suffix) && e.name.length > suffix.length).map((e) => e.name.slice(0, -suffix.length)).sort()
    .map((agent) => ({ root, agent, home: join(root, agent, "instances", name) }));
}

/** `oats instance <git|diff> <instance>` — K1: read-only Git observation of one
 *  instance's work tree. The instance is addressed qualified: an explicit
 *  --home, or a name under the --dir scope (team roots included) that resolves
 *  to exactly one home; several homes refuse with every candidate named. */
async function instanceUpgradeCmd(name, bail) {
  const usage = "usage: oats instance upgrade <instance> [--undo] (--plan | --plan-revision <rev> --idempotency-key <key>) [--home <abs>] [--dir <d>] [--json]";
  if (!name || name.startsWith("--")) return bail("E_BAD_ARGS", usage);
  if (serverFlagOf(args)) return bail("E_BAD_ARGS", "instance upgrade supports local homes only; run it on the deployment host");
  const home = flag("home"), revision = flag("plan-revision"), key = flag("idempotency-key");
  if (home === true || (home !== undefined && !isAbsolute(home))) return bail("E_BAD_ARGS", "--home needs an absolute instance home");
  const planOnly = args.includes("--plan"), undo = args.includes("--undo");
  if (revision === true || key === true || (planOnly && (revision !== undefined || key !== undefined))) return bail("E_BAD_ARGS", usage);
  dropAmbientRoot();
  try {
    const root = ensureRoot(dirFlag());
    const { planUpgrade, applyUpgrade } = await import("../lib/instance-upgrade.mjs");
    const result = planOnly ? await planUpgrade(dirFlag(), root, name, { home, undo })
      : await applyUpgrade(dirFlag(), root, name, { home, undo, planRevision: revision, idempotencyKey: key });
    if (JSON_MODE) { jsonOk(result); return; }
    console.log(`${undo ? "undo package upgrade" : "package upgrade"} ${name}: ${planOnly ? `plan ${result.planRevision}` : result.status}${result.replayed ? " (replayed receipt)" : ""}`);
    for (const row of result.modules) console.log(`  ${row.capability}: ${row.from.version} @ ${row.from.commit.slice(0,12)} → ${row.to.version} @ ${row.to.commit.slice(0,12)}${row.provider?.decision === "refuse" ? `; refused: ${row.provider.reason}` : ""}`);
    for (const row of result.kept || []) console.log(`  ${row.capability}: kept (${row.reason})`);
    for (const row of result.memberDrift || []) console.log(`  ${row.module}: member drift (${row.reason || row.status}); respawn to move it`);
    if (planOnly) console.log(`  home changed since spawn: ${result.homeChangedSinceSpawn ? "yes (retire preserves a recovery copy)" : "no"}`);
    if (planOnly) console.log(`apply with: oats instance upgrade ${name}${undo ? " --undo" : ""} --plan-revision ${result.planRevision} --idempotency-key <key>`);
  } catch (e) { return lifecycleFail(e, "E_UPGRADE_FAILED", { ...e.details, ...(e.plan ? { plan: e.plan } : {}), ...(e.candidates ? { candidates: e.candidates } : {}) }); }
}

/** The flags `oats instance suggest-name` reads, each taking a value (`--json` aside). */
const SUGGEST_NAME_FLAGS = new Set(["soul", "task", "task-file", "harness", "model", "launch-config", "dir"]);
/** `oats instance suggest-name` (feature instance-suggest-name, awebai/oats#1490 §2): the name a spawn
 *  of a soul would get by --suggest-name, chosen here for a spawn that may land on another machine
 *  (lib/core.mjs suggestSpawnName). Never routed: --server is refused before the route dispatch. */
async function instanceSuggestNameCmd(bail) {
  const usage = "usage: oats instance suggest-name --soul <soul> (--task <t> | --task-file <f>) [--harness claude|pi] [--model <m>] [--launch-config <n>] [--dir <d>] [--json]";
  // A flag's value as given, the empty text included (`--task ""` is an empty task, not a missing one).
  const value = (name) => {
    const i = args.indexOf(`--${name}`);
    if (i < 0) return undefined;
    const v = inlineValues.has(name) ? inlineValues.get(name) : args[i + 1];
    if (v === undefined || (!inlineValues.has(name) && v.startsWith("--"))) return bail("E_BAD_ARGS", `--${name} needs a value; ${usage}`);
    return v;
  };
  for (let i = 2; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") continue;
    if (!a.startsWith("--") || !SUGGEST_NAME_FLAGS.has(a.slice(2))) return bail("E_BAD_ARGS", `oats instance suggest-name: unexpected ${a.startsWith("--") ? "flag" : "argument"} ${JSON.stringify(a)}; ${usage}`);
    if (!inlineValues.has(a.slice(2))) i++;
  }
  const soul = value("soul"), task = value("task"), taskFile = value("task-file");
  if (soul === undefined) return bail("E_BAD_ARGS", `--soul is required; ${usage}`);
  if ((task === undefined) === (taskFile === undefined)) return bail("E_BAD_ARGS", `give the task with one of --task or --task-file; ${usage}`);
  let text = task;
  if (taskFile !== undefined) { try { text = readFileSync(taskFile, "utf8"); } catch (e) { return bail("E_BAD_ARGS", `--task-file ${taskFile} cannot be read (${e.code || "error"})`); } }
  let r;
  try { r = await suggestSpawnName({ dir: dirFlag(), soul, task: text, harness: value("harness"), model: value("model"), launchConfig: value("launch-config") }); }
  catch (e) { return bail(e.code || "E_BAD_ARGS", e.message, e.details); }
  if (JSON_MODE) { jsonOk(r); return; }
  console.log(r.name ?? namingLine(r.naming));
}
async function instanceCmd() {
  const bail = (code, msg, details) => (JSON_MODE ? jsonFail(code, msg, details) : die(msg));
  const sub = args[1], name = args[2];
  if (sub === "upgrade") return instanceUpgradeCmd(name, bail);
  if (sub === "waiting" || sub === "attention") return instanceWaitingCmd(sub, bail);
  if (sub === "suggest-name") return instanceSuggestNameCmd(bail);
  const usage = "usage: oats instance waiting <set|clear> --producer <id> [--reason permission|question|attention] [--message <text>] [--home <abs>] [--dir <d>] [--json] | oats instance attention [--message <text>] [--clear] [--json] | oats instance events <instance> [--limit <n>] [--since <iso>] [--home <abs>] [--dir <d>] [--json] | oats instance git <instance> [--home <abs>] [--dir <d>] [--json] | oats instance diff <instance> --file <id> --revision <rev> [--index-revision <rev>] [--home <abs>] [--dir <d>] [--json] | oats instance stop <instance> (--plan | --apply --plan-revision <rev> --idempotency-key <key>) [--no-recursive] [--grace-ms <n>] [--home <abs>] [--dir <d>] [--json] | oats instance color <instance> (<color> | --clear) [--home <abs>] [--dir <d>] [--json] | oats instance background <instance> on|off [--home <abs>] [--dir <d>] [--json] | oats instance same-work <instance> on|off [--home <abs>] [--dir <d>] [--json]";
  if (!["git", "diff", "stop", "events", "color", "background", "same-work"].includes(sub) || !name || name.startsWith("--")) return bail("E_BAD_ARGS", usage);
  dropAmbientRoot();
  if (sub === "events") {
    // K7: typed producer events, bounded window; nothing inferred.
    const homeOpt = flag("home"); if (homeOpt === true || (homeOpt !== undefined && !isAbsolute(homeOpt))) return bail("E_BAD_ARGS", "--home needs an absolute instance home");
    let root; try { root = ensureRoot(dirFlag()); } catch (e) { return bail(e.code || "E_NO_ROOT", e.message); }
    const limit = flag("limit"); const since = flag("since");
    if (limit === true || since === true) return bail("E_BAD_ARGS", usage);
    try {
      const { resolveInstance } = await_import_lifecycle();
      // K7b: --home is an ADDRESS claim, checked like K1 — it must be a home of
      // exactly this name under the scope (E_HOME_MISMATCH otherwise).
      let home, asked;
      try { home = resolveInstance(dirFlag(), root, name, homeOpt ? { home: homeOpt } : {}).home; }
      catch (e) {
        // #642: no live home — a retired instance still answers from the
        // workspace log, which outlives its home (home source absent,
        // incarnation null). A live home never reaches this.
        const gone = homeOpt ? e.code === "E_HOME_MISMATCH" && !existsSync(homeOpt) : e.code === "E_SESSION_UNKNOWN";
        const candidates = gone ? retiredInstanceAddresses(root, name, homeOpt) : [];
        if (candidates.length > 1) return bail("E_AMBIGUOUS_INSTANCE", `retired instance ${JSON.stringify(name)} has ${candidates.length} workspace logs (one per agent); pass --home <abs>`, { candidates });
        if (!candidates.length) throw e;
        home = candidates[0].home;
        // The logs are found from the scope's spelling; the answer names the home as --home spelled it.
        asked = candidates[0].asked;
      }
      const ev = readEvents(home, { ...(limit !== undefined ? { limit: Math.max(1, Math.min(2000, Number(limit) || 200)) } : {}), ...(since ? { since } : {}), ...(asked !== undefined ? { asked } : {}) });
      if (JSON_MODE) { jsonOk(ev); return; }
      console.log(`${ev.instance}: ${ev.returned} of ${ev.count} event(s)${ev.truncated ? " (window truncated)" : ""}${ev.waitingOnYou ? ` — waiting on you since ${ev.waitingOnYou.since} (${ev.waitingOnYou.producer})` : ""}`);
      for (const e of ev.events) console.log(`  ${e.at ?? "?"}  ${e.kind.padEnd(20)} ${e.producer}${e.data ? `  ${JSON.stringify(e.data).slice(0, 120)}` : ""}`);
      return;
    } catch (e) { return bail(e.code || "E_EVENTS_FAILED", e.message, e.candidates ? { candidates: e.candidates } : undefined); }
  }
  if (sub === "color") {
    // Feature instance-color: presentation only, so no plan; addressed as stop addresses an instance.
    const homeOpt = flag("home");
    if (homeOpt === true || (homeOpt !== undefined && !isAbsolute(homeOpt))) return bail("E_BAD_ARGS", "--home needs an absolute instance home");
    const colorUsage = "usage: oats instance color <instance> (<color> | --clear) [--home <abs>] [--dir <d>] [--json]";
    // The words after the instance that are not a flag or the value of --home or --dir: the colour, at most one.
    const words = [];
    for (let i = 3; i < args.length; i++) { if (args[i] === "--home" || args[i] === "--dir") i++; else if (!args[i].startsWith("--")) words.push(args[i]); }
    const clear = args.includes("--clear");
    if (words.length > 1) return bail("E_BAD_ARGS", `oats instance color takes one colour; ${colorUsage}`);
    const value = words[0];
    if (value !== undefined && clear) return bail("E_BAD_ARGS", `give a colour or --clear, not both; ${colorUsage}`);
    if (value === undefined && !clear) return bail("E_BAD_ARGS", `give a colour or --clear; ${colorUsage}`);
    let root; try { root = ensureRoot(dirFlag()); } catch (e) { return lifecycleFail(e, "E_NO_ROOT"); }
    try {
      const r = setInstanceColor(dirFlag(), root, name, { home: homeOpt, color: clear ? null : value });
      if (JSON_MODE) { jsonOk(r); return; }
      console.log(`${r.instance}: ${r.color === null ? "no colour" : `colour ${r.color}`}${r.changed ? "" : " (unchanged)"}`);
      return;
    } catch (e) {
      return lifecycleFail(e, "E_LIFECYCLE_FAILED", e.candidates ? { candidates: e.candidates } : e.details);
    }
  }
  if (sub === "background") {
    // Feature instance-background: presentation only, so no plan; addressed as `instance color` addresses an instance.
    const homeOpt = flag("home");
    if (homeOpt === true || (homeOpt !== undefined && !isAbsolute(homeOpt))) return bail("E_BAD_ARGS", "--home needs an absolute instance home");
    const backgroundUsage = "usage: oats instance background <instance> on|off [--home <abs>] [--dir <d>] [--json]";
    // The words after the instance that are not a flag or the value of --home or --dir: exactly one, on or off.
    const words = [];
    for (let i = 3; i < args.length; i++) { if (args[i] === "--home" || args[i] === "--dir") i++; else if (!args[i].startsWith("--")) words.push(args[i]); }
    if (words.length !== 1 || !["on", "off"].includes(words[0])) return bail("E_BAD_ARGS", `give on or off; ${backgroundUsage}`);
    let root; try { root = ensureRoot(dirFlag()); } catch (e) { return lifecycleFail(e, "E_NO_ROOT"); }
    try {
      const r = setInstanceBackground(dirFlag(), root, name, { home: homeOpt, background: words[0] === "on" });
      if (JSON_MODE) { jsonOk(r); return; }
      console.log(`${r.instance}: ${r.background ? "background" : "not background"}${r.changed ? "" : " (unchanged)"}`);
      return;
    } catch (e) {
      return lifecycleFail(e, "E_LIFECYCLE_FAILED", e.candidates ? { candidates: e.candidates } : e.details);
    }
  }
  if (sub === "same-work") {
    // Feature instance-same-work: presentation only, so no plan; addressed as color addresses an instance.
    const homeOpt = flag("home");
    if (homeOpt === true || (homeOpt !== undefined && !isAbsolute(homeOpt))) return bail("E_BAD_ARGS", "--home needs an absolute instance home");
    const sameWorkUsage = "usage: oats instance same-work <instance> on|off [--home <abs>] [--dir <d>] [--json]";
    // The words after the instance that are not a flag or the value of --home or --dir: exactly one, on or off.
    const words = [];
    for (let i = 3; i < args.length; i++) { if (args[i] === "--home" || args[i] === "--dir") i++; else if (!args[i].startsWith("--")) words.push(args[i]); }
    if (words.length !== 1 || !["on", "off"].includes(words[0])) return bail("E_BAD_ARGS", `give on or off; ${sameWorkUsage}`);
    let root; try { root = ensureRoot(dirFlag()); } catch (e) { return lifecycleFail(e, "E_NO_ROOT"); }
    try {
      const r = setInstanceSameWork(dirFlag(), root, name, { home: homeOpt, on: words[0] === "on" });
      if (JSON_MODE) { jsonOk(r); return; }
      console.log(`${r.instance}: same work ${r.sameWork ? "on" : "off"}`);
      return;
    } catch (e) {
      return lifecycleFail(e, "E_LIFECYCLE_FAILED", e.candidates ? { candidates: e.candidates } : e.details);
    }
  }
  if (sub === "stop") {
    // K3: plan → apply. The plan is what a confirmation shows; apply carries
    // its revision back and refuses if reality moved.
    const homeOpt = flag("home");
    if (homeOpt === true || (homeOpt !== undefined && !isAbsolute(homeOpt))) return bail("E_BAD_ARGS", "--home needs an absolute instance home");
    let root; try { root = ensureRoot(dirFlag()); } catch (e) { return lifecycleFail(e, "E_NO_ROOT"); }
    const recursive = !args.includes("--no-recursive");
    const wantPlan = args.includes("--plan"), wantApply = args.includes("--apply");
    if (wantPlan === wantApply) return bail("E_BAD_ARGS", "stop needs exactly one of --plan or --apply");
    try {
      if (wantPlan) {
        const plan = planStop(dirFlag(), root, name, { home: homeOpt, recursive });
        if (JSON_MODE) { jsonOk(plan); return; }
        console.log(`stop ${name}${recursive ? " (and recorded children)" : ""} — plan ${plan.planRevision}`);
        for (const t of plan.targets) console.log(`  ${"  ".repeat(t.depth)}${t.instance}: session ${t.session.state}${t.work.observed ? `, ${t.work.changed} changed / ${t.work.untracked} untracked on ${t.work.branch ?? "detached"}` : ", work not observed"}${t.midTask === true ? " — mid-task" : t.midTask === "unknown" ? " — activity unknown" : ""}`);
        for (const n of plan.notes) console.log(`  note: ${terminalText(n)}`);
        console.log(`apply with: oats instance stop ${name} --apply --plan-revision ${plan.planRevision} --idempotency-key <key>`);
        return;
      }
      const rev = flag("plan-revision"), key = flag("idempotency-key"), grace = flag("grace-ms");
      if (rev === true || key === true || grace === true) return bail("E_BAD_ARGS", usage);
      const receipt = applyStop(dirFlag(), root, name, { home: homeOpt, recursive, planRevision: rev, idempotencyKey: key, ...(grace !== undefined ? { graceMs: Number(grace) } : {}) });
      // Not part of the receipt, whose shape is contract: on stderr in both modes.
      for (const w of receipt[STOP_WARNINGS] || []) console.error(`oats: warning: ${w}`);
      if (JSON_MODE) { jsonOk(receipt); return; }
      for (const r of receipt.results) console.log(`  ${r.instance}: ${r.ok ? (r.stopped ? "stopped" : `already ${r.state}`) : `${r.code} — ${r.message}`}`);
      console.log(stopClosingLine(receipt));
      if (!receipt.ok) process.exit(1);
      return;
    } catch (e) {
      // The error's own details (a claim's holder; a defect's cause) beside the plan it was refused with.
      const details = { ...e.details, ...(e.plan ? { plan: e.plan } : {}), ...(e.candidates ? { candidates: e.candidates } : {}) };
      return lifecycleFail(e, "E_LIFECYCLE_FAILED", Object.keys(details).length ? details : undefined);
    }
  }
  let home = flag("home");
  if (home === true) return bail("E_BAD_ARGS", "--home needs an absolute instance home");
  if (home !== undefined && !isAbsolute(home)) return bail("E_BAD_ARGS", "--home needs an absolute instance home");
  if (home === undefined) {
    let root;
    try { root = ensureRoot(dirFlag()); } catch (e) { return bail(e.code || "E_NO_ROOT", e.message); }
    const roots = [realOrResolved(root)];
    const candidates = [];
    for (const rt of roots) for (const hit of findInstanceHomes(rt, name)) candidates.push({ root: rt, agent: hit.agent?.name ?? null, home: hit.home });
    if (!candidates.length) return bail("E_SESSION_UNKNOWN", `no instance ${JSON.stringify(name)} under ${roots.join(", ")}`);
    if (candidates.length > 1) return bail("E_AMBIGUOUS_INSTANCE", `instance ${JSON.stringify(name)} has ${candidates.length} homes; pass --home <abs>`, { candidates });
    home = candidates[0].home;
  } else if (basename(home) !== name) return bail("E_HOME_MISMATCH", `--home ${home} is not the home of instance ${JSON.stringify(name)}`);
  try {
    if (sub === "git") {
      const observed = observeInstanceGit(home);
      if (JSON_MODE) { jsonOk(observed); return; }
      const o = observed.observation;
      console.log(`${observed.instance} — ${shortPath(o.worktree)} @ ${o.branch ?? (o.detached ? `detached ${o.revision.slice(0, 12)}` : "unborn")}`);
      console.log(`  upstream: ${observed.upstream.ref ? `${observed.upstream.ref} +${observed.upstream.ahead} -${observed.upstream.behind}` : "none (ahead/behind unknown)"}`);
      console.log(`  base: ${observed.base.ref ? `${observed.base.ref} +${observed.base.ahead} -${observed.base.behind} (merge-base ${observed.base.mergeBase?.slice(0, 12)})` : "unknown"}`);
      console.log(`  files: ${observed.files.length} (${Object.entries(observed.summary).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(", ") || "clean"})`);
      const lines = (f) => (f.binary ? "  binary" : Number.isInteger(f.additions) ? `  +${f.additions} -${f.deletions}` : "");
      for (const f of observed.files) console.log(`    ${f.xy} ${f.origPath ? `${f.origPath} -> ` : ""}${f.path}${lines(f)}  [${f.id}]`);
      for (const n of observed.notes) console.log(`  note: ${terminalText(n)}`);
      return;
    }
    const fileId = flag("file"), revision = flag("revision"), indexRevision = flag("index-revision");
    if (fileId === true || revision === true || indexRevision === true) return bail("E_BAD_ARGS", usage);
    const d = diffInstanceFile(home, { fileId, revision, indexRevision });
    if (JSON_MODE) { jsonOk(d); return; }
    console.log(`${d.file.origPath ? `${d.file.origPath} -> ` : ""}${d.file.path} (${d.file.kind}, against ${d.against})${d.binary ? " [binary]" : ""}${d.truncated ? ` [truncated at ${d.limit} bytes]` : ""}`);
    if (!d.binary) process.stdout.write(d.patch);
  } catch (e) {
    bail(e.code || "E_GIT_FAILED", e.message, e.observation ? { observation: e.observation } : undefined);
  }
}
/** `oats readiness (--soul <name> [--agents-root <abs>] [--dir <d>] | --home <abs>) [--policy] --json` — readinessApi 2. */
async function readinessCmd() {
  const bail = (code, msg, details) => (JSON_MODE ? jsonFail(code, msg, details) : die(msg));
  dropAmbientRoot();
  const homeArg = flag("home");
  // Workspace model (readinessApi 2): an instance or soul subject; checks
  // installed | configured | member | providers. No trusted check.
  if (args.includes("--verify-signatures")) return bail("E_BAD_ARGS", "--verify-signatures was removed with the trusted check (readinessApi 2): declaring a package in packages: is the trust decision, and the lock pins commit + integrity");
  const target = await workspaceTarget(bail, { command: "readiness" });
  {
    const given = (name) => { const v = flag(name); return v && v !== true ? String(v) : null; };
    const selector = homeArg && homeArg !== true ? { kind: "home", home: String(homeArg), soul: given("soul"), agentsRoot: given("agents-root") }
      : { kind: "soul", soul: String(flag("soul")), agentsRoot: given("agents-root"), dir: given("dir") };
    let catalog = null; try { catalog = officialPackageCatalog(); } catch { catalog = null; }
    const doc = await readinessDocument(target, { selector, remoteOptions: remoteOptionsFromEnv(), catalog });
    if (args.includes("--policy")) {
      doc.policy = policyOf({ instanceMeta: target.meta, soul: target.meta ? null : policySoul(target) }).policy;
      doc.notes.push("policy: a lifecycle-authority claim enforced by the spawn route, not an OS sandbox");
    }
    if (JSON_MODE) { jsonOk(doc); return; }
    const s = doc.subject;
    console.log(`readiness — ${s.kind === "instance" ? `instance ${s.instance} (soul ${s.soul})` : `soul ${s.soul}`}: ${doc.summary.ready ? "READY" : `${doc.summary.fail} failing, ${doc.summary.unknown} unknown of ${doc.summary.required} required`}`);
    for (const [name, check] of Object.entries(doc.checks)) {
      console.log(`  ${name}: ${check.status}`);
      for (const i of check.items) console.log(`    ${i.status.padEnd(14)} ${i.subject}${i.required ? "" : " (optional)"}${i.reason ? ` — ${i.reason}` : ""}${i.remedy ? `  → ${i.remedy}` : ""}`);
    }
    if (doc.policy) console.log(`  policy: child spawns ${doc.policy.childSpawns.allowed ? "allowed" : "disabled"} (${doc.policy.childSpawns.origin.kind}${doc.policy.childSpawns.enforced ? ", enforced" : ""}); worktrees ${doc.policy.worktrees.allowed === null ? "unknown" : doc.policy.worktrees.allowed ? "allowed" : "not in this work mode"}`);
    for (const w of doc.warnings) console.log(`  warning  ${w.code}  ${w.message}`);
    for (const n of doc.notes) console.log(`  note: ${terminalText(n)}`);
    return;
  }
}
// ---------- workspace model v2: sync / package / workspace status / capabilities / souls ----------
// Contract: docs/design/2026-09-23-workspace-module-contracts.md §6. Nothing is
// installed: `oats-local.yaml` names the workspace, discovery runs over the Git
// remotes (lib/workspace.mjs), packages resolve to exact commits (lib/packages.mjs,
// lock v3) and the only persisted state is `oats-lock.json` beside oats-local.yaml.

/** This command's read session (lib/remote.mjs createReadSession): one per process, created at the
 *  first remote read, closed when the command ends (the `finally` of the dispatch) and, for the
 *  process.exit paths, on exit — no `git cat-file --batch` child outlives the command. Its git
 *  children run as their own process groups, so a terminal's Ctrl-C no longer reaches them: a
 *  SIGINT, SIGTERM or SIGHUP closes the session and exits (128 + the signal number), which kills them. */
let readSession = null;
/** The validated `--max-age` seconds (checked once at dispatch: maxAgeRefusal), null when not given. */
let maxAgeGiven = null;
/** The remote budget of this command's reads (ms), or null: only the deployment reads `status` and `workspace
 *  status` have one (remote.mjs READ_REMOTE_BUDGET_MS; OATS_READ_REMOTE_BUDGET_MS overrides it), so they answer
 *  inside a caller's own limit. Spawn, sync and every other verb read with no deadline. */
let readBudgetMs = null;
function commandSession() {
  if (!readSession) {
    readSession = callSession({ maxAge: maxAgeGiven, budgetMs: readBudgetMs });
    process.on("exit", () => { sayReadNotices(); readSession.closeNow(); });
    for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.once(signal, () => {
      readSession.closeNow();
      // Another handler (a scheduler lock's release) exits on its own after this one.
      if (process.listenerCount(signal) === 0) process.exit(code);
    });
  }
  return readSession;
}
/** What the read session found worth telling the operator (a remote that cannot serve partial fetches),
 *  once, on stderr when the command ends: stdout, and so every JSON answer, is unchanged. */
function sayReadNotices() {
  for (const notice of readSession?.notices.splice(0) ?? []) process.stderr.write(`oats: warning: ${notice}\n`);
}
/** Which kernel command forms take --max-age: THE allow-list (docs/desktop-cli-api.md "Observation reuse").
 *  → null when this form reads with observation reuse, else the E_BAD_ARGS message. `head` is argv before `--`.
 *  Write verbs refuse it: a writer acting on a reused observation could persist a fact the workspace no
 *  longer holds. A preview-bound spawn apply is the exception: its fence (--expect-decision) binds it to
 *  the decision the operator confirmed, so a reused head applies nothing beyond that decision. */
const MAX_AGE_READS = "status, workspace status, souls, capabilities, capabilities show, inspect --soul|--home, spawn --preview, spawn --expect-decision <revision>, trigger poll, and the read forms of teams and soul teams";
function maxAgeRefusal(command, head) {
  const word = (i) => (head[i] !== undefined && !head[i].startsWith("--") ? head[i] : undefined);
  const refuse = (form) => `--max-age is not accepted by \`oats ${form}\`: only the read verbs and a preview-bound spawn apply reuse observations (${MAX_AGE_READS})`;
  if (head.includes("--server")) return "--max-age cannot be combined with --server: observation reuse is local to this machine";
  switch (command) {
    case "status": case "souls": case "capabilities": case "inspect": return null;
    // A preview reads (feature spawn-preview-max-age); an apply only when a confirmed decision binds it
    // (feature spawn-apply-max-age), with a value as spawn reads it: a bare --expect-decision binds nothing.
    case "spawn": {
      const expected = flag("expect-decision");
      if (head.includes("--preview") || (expected !== undefined && expected !== true)) return null;
      return "--max-age is not accepted by `oats spawn` without --expect-decision: a spawn apply reuses observations only with --expect-decision <revision>, which binds it to the decision a preview showed";
    }
    case "workspace": return word(1) === "status" ? null : refuse(["workspace", word(1)].filter(Boolean).join(" "));
    case "teams": return word(1) === undefined ? null : refuse(`teams ${word(1)}`);
    // `soul teams` only reads (its edit flags were removed in 0.38.0, and refuse as such).
    // `soul launch set|remove` writes, and names its soul from what the workspace offers now: it reads live.
    case "soul": return word(1) === "teams" ? null : refuse(["soul", word(1), word(1) === "launch" ? word(2) : undefined].filter(Boolean).join(" "));
    // A capability source's poll resolves its soul as a read (the tick's child passes --max-age 600).
    case "trigger": return word(1) === "poll" ? null : refuse(["trigger", word(1)].filter(Boolean).join(" "));
    default: {
      const sub = ["package", "schedule", "session", "trigger", "automations", "launch-config", "server", "instance", "operation", "pane"].includes(command) ? word(1) : undefined;
      return refuse([command, sub].filter(Boolean).join(" "));
    }
  }
}
/** The observation block: the heads' oldest observedAt and reuse (the read session) and the revision of
 *  the local configuration this command read (lib/local-inputs.mjs, recording since dispatch). */
const observationBlock = () => ({ ...commandSession().observation(), localRevision: localRevision() });
/** A read verb's JSON with the observation block — only when --max-age was given (0 included); without
 *  it the document is exactly what it was before the feature (Desktop decodes closed shapes). */
const withObservation = (doc) => (maxAgeGiven === null ? doc : { ...doc, observation: observationBlock() });

/** Remote options threaded into every remote call. OATS_REMOTE_CACHE relocates
 * the content-addressed fetch cache (tests never touch ~/.cache); `session` is the command's read session. */
function remoteOptionsFromEnv() {
  const cacheDir = remoteCacheDir();
  return { ...(cacheDir ? { cacheDir } : {}), session: commandSession() };
}
/** OATS_REMOTE_CACHE, absolute, or undefined. */
function remoteCacheDir() {
  const cacheDir = process.env.OATS_REMOTE_CACHE;
  return cacheDir ? resolve(cacheDir) : undefined;
}
/** Say a lifted read's answer (lib/read-call.mjs: `{ exit, answer, stderr }`) as the command always did. JSON
 *  mode prints the answer (`indent`: status's document is printed indented; a failure envelope never is),
 *  text mode a failure as `oats: <message>`; then the read session's notices, and a failure exits. On a
 *  text failure the deprecated-name warning comes before the notices, as the exit hooks said them. */
function sayRead(read, { indent } = {}) {
  if (JSON_MODE) {
    if (read.answer && Object.hasOwn(read.answer, "warnings")) warningDelivered = true;
    console.log(read.exit === 0 && indent ? JSON.stringify(read.answer, null, indent) : JSON.stringify(read.answer));
  } else {
    console.error(`oats: ${read.answer.error.message}`);
    const w = runtimeNameWarning();
    if (w && !warningDelivered) { process.stderr.write(`oats: warning: ${w.message}\n`); warningDelivered = true; }
  }
  process.stderr.write(read.stderr);
  if (read.exit) process.exit(read.exit);
}

/** The v2 deployment context at --dir: { dir, localPath, local, deploymentDir, remoteOptions }. */
function workspaceContext(bail) {
  const dir = dirFlag();
  let found;
  try { found = loadLocal(dir); }
  catch (e) { return bail(e.code || "E_LOCAL_MISSING", e.message, e.details); }
  return { dir, localPath: found.path, local: found.local, deploymentDir: dirname(found.path), remoteOptions: remoteOptionsFromEnv() };
}

/** An explicit host-local operator action; never routed to a remote adapter. */
function harnessTrustCmd() {
  if (args[1] !== "trust") return cmdFail("E_BAD_ARGS", "usage: oats harness trust [--dir <deployment>] [--harness claude|codex|all] [--plan] [--json]");
  const seen = new Set();
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) return cmdFail("E_BAD_ARGS", `duplicate argument ${arg}`);
    seen.add(arg);
    if (["--plan", "--json"].includes(arg)) continue;
    if (["--dir", "--harness"].includes(arg) && args[i + 1] && !args[i + 1].startsWith("-")) { i++; continue; }
    return cmdFail("E_BAD_ARGS", `unsupported argument ${arg}; use oats harness trust --help`);
  }
  const selected = flag("harness") ?? "all";
  if (!["claude", "codex", "all"].includes(selected)) return cmdFail("E_BAD_ARGS", "--harness must be claude, codex, or all");
  const context = workspaceContext(cmdFail);
  const show = (result, log = console.log) => {
    log(`${result.mode}: native harness trust for ${result.root}`);
    const used = (entry) => [...(entry.ambient ? ["ambient"] : []), ...entry.launchConfigs.map((n) => `launch configuration ${n}`)].join(", ");
    for (const entry of result.entries) {
      // A refused file was not read through to its trust value: no current value or digests to show.
      if (entry.status === "refused") log(`${entry.harness}: refused ${entry.file ?? "unresolved file"} ${JSON.stringify(entry.key)} (${used(entry)})`);
      else log(`${entry.harness}: ${entry.status} ${entry.file ?? "unresolved file"} ${JSON.stringify(entry.key)} ${JSON.stringify(entry.current)} -> ${JSON.stringify(entry.desired)} (${entry.beforeDigest ?? "missing"} -> ${entry.afterDigest ?? "unknown/absent"}) (${used(entry)})`);
      if (entry.problem) log(`problem: ${entry.problem}`);
      if (entry.reason) log(`skipped: ${entry.reason}`);
    }
    if (result.audit) log(`audit: ${result.audit.status} ${result.audit.path} ${result.audit.operationId}`);
    for (const warning of result.warnings) log(`warning: ${warning}`);
    if (result.reason) log(`reason: ${result.reason}; native configuration may have changed: ${result.mayHaveChanged}`);
  };
  try {
    // Every configuration file a launch of this deployment reads: its launch configurations' too.
    // The ambient one is the file a launch with no launch configuration reads there (its session's
    // environment over the server's), by the answer every launch check reads; never this shell's own.
    const result = harnessTrust(context.deploymentDir, { harness: selected, plan: args.includes("--plan"), launchConfigs: launchConfigsAt(context.deploymentDir), launch: previewLaunchEnvironment({ deployment: context.deploymentDir }) });
    if (JSON_MODE) jsonOk(result);
    else show(result);
  } catch (e) {
    if (!JSON_MODE && e.details?.operation === "harness-trust") show(e.details, console.error);
    cmdFail(e.code || "E_CONFIG_BROKEN", e.message, e.details);
  }
}

/** The official catalog's package map (package-catalog.json; OATS_PACKAGE_CATALOG overrides). */
function catalogForSync(bail) {
  try { return officialPackageCatalog(); }
  catch (e) { return bail(e.code || "E_PACKAGE_MISSING", e.message); }
}

/** Discover the workspace named by oats-local.yaml over the real remote. */
async function discoverForCli(ctx, bail) {
  // The standalone case (decisions 10/25) is a discovery too: the repo's own view
  // plus the kernel's oats.core default — discoverOrStandalone decides.
  try { const { discoverOrStandalone } = await import("../lib/member-clone.mjs"); return await discoverOrStandalone(ctx.local, { deployment: ctx.deploymentDir, remoteOptions: ctx.remoteOptions }); }
  catch (e) {
    if (typeof e?.code === "string" && e.code.startsWith("E_")) return bail(e.code, e.message, e.details ?? e.provenance);
    throw e;
  }
}

const short = (oid) => (typeof oid === "string" ? oid.slice(0, 8) : "?");
const originOf = (item) => (item.package ? `package ${item.package} v${item.version}` : `member ${item.repoKey} @ ${short(item.commit)}`);

/** A soul's launch here (feature launch-preference): the `Launch` report a spawn with no flags would decide
 *  (souls.launch, the soul's own launch, the host default), and the desktop-facts `harness`, `model`,
 *  `harnessFrom` equal to its effective launch (`harnessFrom` "kernel-default" for the host default). */
function soulLaunchFacts(entry, local, { launchConfigs, contextDir, offered }) {
  const launch = launchReportFor({ layers: launchLayers({ definition: entry.definition, entry, key: soulKeyOf(entry), local, offered }), launchConfigs, contextDir });
  return { harness: launch.effective.harness, model: launch.effective.model, harnessFrom: launch.from === "host" ? "kernel-default" : launch.from, launch };
}

/** Rows of every soul and capability of confirmed members (+ external souls) + locked package
 *  capabilities. Souls have no private mode (0.26.0); a private member capability is listed with
 *  `private: true` — repo-owned: usable only by its own repo's souls (E_CAPABILITY_PRIVATE).
 *  Each soul row carries its teams HERE (team model 3: `teams`, `defaultTeam`), from the committed
 *  workspace and the local teams it allows; both null when its teams do not resolve (isTeamRefusal). */
function workspaceItems(discovery, lock, local, deploymentDir) {
  const souls = [];
  let launchConfigs = {};
  try { launchConfigs = deploymentDir ? launchConfigsAt(deploymentDir) : {}; } catch { launchConfigs = {}; }
  // One description of this read for every soul's launch: which keys of souls.launch name no soul.
  const offered = soulsOffered(discovery);
  // Feature instance-background: `background: true` on a soul that declares it, absent otherwise.
  const soulDefaults = (entry) => ({ ...soulLaunchFacts(entry, local, { launchConfigs, contextDir: deploymentDir, offered }), ...(entry.definition?.background === true ? { background: true } : {}) });
  const capabilities = [];
  const model = teamModel(discovery.standalone === true ? null : discovery.workspace, local, { workspaceKey: discovery.key ?? null });
  const teamsHere = (entry) => {
    try { const t = soulTeams(model, teamKeyOf(entry)); return { teams: reportRows(t.teams), defaultTeam: t.defaultTeam }; }
    catch (e) { if (isTeamRefusal(e)) return { teams: null, defaultTeam: null }; throw e; }
  };
  for (const m of discovery.members) {
    if (!m.confirmed && !(discovery.standalone === true && m.key === discovery.key)) continue;
    for (const s of m.souls) souls.push({ name: s.name, key: soulKeyOf(s), origin: originOf(s), kind: "member", repoKey: s.repoKey, commit: s.commit, ...teamsHere(s), private: s.private, path: s.path, work: s.definition.work ?? null, description: s.definition.description ?? null, ...soulDefaults(s) });
    for (const c of m.capabilities) capabilities.push({ name: c.name, origin: originOf(c), kind: "member", repoKey: c.repoKey, commit: c.commit, private: c.private, path: c.path, layer: c.manifest.layer ?? null, version: c.manifest.version ?? null });
  }
  for (const ext of discovery.external || []) {
    const s = ext.soul;
    souls.push({ name: s.name, key: soulKeyOf(s), origin: `external ${s.repoKey} @ ${short(s.commit)}`, kind: "external", repoKey: s.repoKey, commit: s.commit, ...teamsHere(s), private: s.private, path: s.path, work: s.definition.work ?? null, description: s.definition.description ?? null, ...soulDefaults(s) });
  }
  for (const s of discovery.packageSouls || []) {
    souls.push({ name: s.name, key: soulKeyOf(s), qualifiedName: s.qualifiedName, origin: originOf(s), kind: "package", package: s.package, version: s.version, repoKey: s.repoKey, commit: s.commit, ...teamsHere(s), private: false, path: s.path, work: s.definition.work ?? null, description: s.definition.description ?? null, ...soulDefaults(s) });
  }
  for (const [id, entry] of Object.entries(lock?.packages || {})) {
    for (const name of entry.capabilities) capabilities.push({ name, origin: originOf({ package: id, version: entry.version }), kind: "package", package: id, version: entry.version, commit: entry.commit, private: false });
  }
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0);
  souls.sort(byName);
  capabilities.sort(byName);
  return { souls, capabilities };
}

/** Print a padded table: rows are arrays of strings. */
function printTable(header, rows) {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => String(r[i] ?? "").length)));
  for (const r of all) console.log("  " + r.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  ").trimEnd());
}

/** `--approve` left with package approval (human decision 2026-09-24). */
const APPROVAL_REMOVED = "package approval was removed; declaring a package in packages: is the trust decision";

/** The body of `oats sync` — shared by `sync` and `onboard` (which onboards, then syncs the same
 * way). Given a v2 deployment context: discover over the remotes, confirm membership, resolve
 * `packages:` against the lock (commit + integrity), write the lock. There is no approval step:
 * declaring a package in `packages:` is the trust decision (human decision 2026-09-24).
 * `bail` never returns (it exits the process with the caller's error shape).
 * `plan` (#731, `oats sync --plan`): the same discovery, resolution and report, written nowhere —
 * no lock, no agents/, no automations snapshot; `lockFile` is the lock a sync would write.
 * → { report, lock, discovery, items, lockFile, problems } */
async function performSync(ctx, bail, { onDiscovered, plan = false } = {}) {
  if (args.includes("--approve")) return bail("E_BAD_ARGS", `--approve: ${APPROVAL_REMOVED}`, { flag: "--approve" });
  const catalog = catalogForSync(bail);
  const discovery = await discoverForCli(ctx, bail);
  onDiscovered?.(discovery);
  let previous;
  try { previous = readLock(ctx.deploymentDir); } catch (e) { return bail(e.code || "E_LOCK_SCHEMA", e.message, e.details); }
  let resolved;
  // Standalone: no workspace file → the only package request is the kernel's
  // default, at the catalog's pinned version (decision 25). A catalog that cannot
  // name it is a PROBLEM of this sync (reported, exit unchanged), not a silent empty lock.
  const standalone = discovery.standalone === true ? standalonePackages(catalog) : null;
  const packageSource = standalone ? { packages: standalone.packages } : discovery.workspace;
  const problems = [...discovery.problems, ...(standalone?.problems ?? [])];
  try { resolved = await resolvePackages(packageSource, { catalog, lock: previous, remoteOptions: ctx.remoteOptions }); }
  catch (e) {
    if (typeof e?.code === "string" && e.code.startsWith("E_")) return bail(e.code, e.message, e.details ?? e.provenance);
    throw e;
  }
  const lock = resolved.lock;
  let lockFile = join(resolve(ctx.deploymentDir), LOCK_FILE);
  // A plan validates the lock exactly as writeLock would (canonicalLock), so it never answers ok where the sync fails.
  try { if (plan) canonicalLock(lock); else lockFile = writeLock(ctx.deploymentDir, lock); } catch (e) { return bail(e.code || "E_LOCK_SCHEMA", e.message, e.details); }
  // Package souls come from the lock: list what THIS sync locked, not what the previous lock held.
  if (discovery.standalone !== true) {
    let pkg;
    try { pkg = await discoverPackageSouls(discovery.workspace, lock, { remoteOptions: ctx.remoteOptions }); }
    catch (e) { if (typeof e?.code === "string" && e.code.startsWith("E_")) return bail(e.code, e.message, e.details ?? e.provenance); throw e; }
    const kept = (list) => list.filter((p) => typeof p.package !== "string");
    discovery.packageSouls = pkg.souls;
    discovery.soulsUnread = { ...discovery.soulsUnread, packages: pkg.skipped, unlocked: unlockedPackages(discovery.workspace, lock) };
    discovery.problems = [...kept(discovery.problems), ...pkg.problems];
    discovery.warnings = workspaceWarnings(discovery.workspace, discovery.members, discovery.external || [], pkg.souls);
    problems.splice(0, problems.length, ...kept(problems), ...pkg.problems);
  }
  // The deployment's instance root: <deployment>/agents/ (findRoot's marker). A hand-written
  // oats-local.yaml + sync is a complete deployment; spawn must not answer E_NO_DEPLOYMENT after it.
  // A plan creates nothing: on a deployment that never synced, a schedule whose cwd is under agents/ is reported
  // invalid by the plan and accepted by the sync that creates agents/ first (#731 review, accepted edge).
  if (!plan) try { mkdirSync(join(ctx.deploymentDir, "agents"), { recursive: true }); } catch { /* reported by spawn's E_NO_DEPLOYMENT remedy if it matters */ }
  // Workspace automations (0.29.0): discovered with the members and the new lock (a trigger
  // template instantiates at the locked package commit), kept as the snapshot the host tick reads.
  let automations;
  try { automations = await takeAutomationSnapshot(ctx, discovery, lock, { write: !plan }); }
  catch (e) { if (typeof e?.code === "string" && e.code.startsWith("E_")) return bail(e.code, e.message, e.details); throw e; }
  problems.push(...automations.problems);
  const members = memberRows(discovery);
  const packages = packageRows(lock);
  const changes = resolved.changes;
  const items = workspaceItems(discovery, lock, ctx.local, ctx.deploymentDir);
  const snapshotDue = plan && automationSnapshotDue(ctx.deploymentDir, automations);
  const report = { syncApi: 1, ...(plan ? { plan: true } : {}), automations: automationCounts(automations), standalone: discovery.standalone === true || undefined, workspace: { name: workspaceName(discovery), key: discovery.key, url: discovery.url, commit: discovery.commit, observedAt: discovery.observedAt, local: ctx.localPath, lock: lockFile }, members, packages, changes, problems, warnings: discovery.warnings ?? [] };
  return { report, lock, discovery, items, lockFile, problems, snapshotDue };
}

/** The one-line standalone explanation (decision 10). `standaloneReason` says WHY the view is
 *  standalone: asked for (`standalone:` in oats-local.yaml) or forced (the host is unreadable —
 *  then the access failure is named). Never "cannot be read" when nothing was refused. */
function standaloneNote(discovery, { from = "" } = {}) {
  if (discovery?.standalone !== true) return null;
  const who = memberLabel(discovery.key);
  if (discovery.standaloneReason === "explicit") return `standalone view of ${who} (explicit in oats-local.yaml): its own souls + oats.core`;
  const hf = discovery.hostFailure;
  const why = hf ? ` (${hf.code ?? "E_REMOTE_UNREADABLE"}${hf.reason ? `: ${hf.reason}` : ""}${hf.url ? ` — ${hf.url}` : ""})` : "";
  return `standalone — the workspace of ${who} cannot be read${from}${why}; its own souls + oats.core`;
}

/** The human §8 report of a sync (text mode). */
function printSyncReport(ctx, synced) {
  const { report, discovery, items, lockFile } = synced;
  const { members, packages, changes } = report;
  const disabled = new Set(ctx.local.souls?.disabled || []);
  const isDisabled = (s) => disabled.has(s.name) || disabled.has(s.qualifiedName ?? `${memberLabel(s.repoKey)}/${s.name}`);
  console.log(`workspace  ${discovery.workspace?.name ?? `(${standaloneNote(discovery)})`}  (${discovery.key} @ ${short(discovery.commit)})`);
  console.log(`members    ${members.map((m) => m.confirmed ? `${m.name} ✓↔ (@ ${short(m.commit)})` : `${m.name} ✗ (${m.status})`).join("   ") || "(none)"}`);
  console.log(`packages   ${packages.map((p) => `${p.id} ${p.version} ✓ (@ ${short(p.commit)})`).join("   ") || "(none)"}`);
  const changed = changes.filter((c) => c.to !== null && c.from !== c.to).map((c) => `${c.id}  ${c.from ?? "—"} → ${c.to} (@ ${short(c.commit)})`);
  const removed = changes.filter((c) => c.to === null).map((c) => `${c.id}  ${c.from} → removed`);
  const plan = report.plan === true;
  console.log(`${plan ? "to change " : "changed   "} ${[...changed, ...removed].join("   ") || `(nothing — the lock already ${plan ? "describes" : "described"} this workspace)`}`);
  const memberSouls = items.souls.filter((s) => s.kind === "member");
  const externalSouls = items.souls.filter((s) => s.kind === "external");
  // Souls have no private mode (0.26.0); the private count is of repo-owned member capabilities.
  const repoOwned = items.capabilities.filter((c) => c.kind === "member" && c.private);
  const packageSouls = items.souls.filter((s) => s.kind === "package");
  const disabledHere = items.souls.filter(isDisabled);
  console.log(`souls      ${items.souls.length} discovered (${memberSouls.length} members, ${externalSouls.length} external, ${packageSouls.length ? `${packageSouls.length} package, ` : ""}${disabledHere.length} disabled here) · ${repoOwned.length} private capabilit${repoOwned.length === 1 ? "y" : "ies"}${repoOwned.length ? ` (${repoOwned.map((c) => `${c.name}, ${memberLabel(c.repoKey)} only`).join("; ")})` : ""}`);
  const sharedTeams = Object.keys(discovery.workspace?.teams || {}).sort();
  console.log(`teams      ${sharedTeams.length ? `${sharedTeams.join(", ")} (shared)` : "(no shared teams)"} · this deployment's: oats teams`);
  const ac = report.automations;
  if (ac.triggers || ac.schedules) console.log(`automations ${ac.triggers} trigger${ac.triggers === 1 ? "" : "s"}, ${ac.schedules} schedule${ac.schedules === 1 ? "" : "s"} in the members (oats trigger list · oats schedule list)`);
  for (const p of synced.problems ?? discovery.problems) console.log(`problem    ${p.code}  ${p.repoKey ? `${memberLabel(p.repoKey)}:` : ""}${p.path}  ${p.message}`);
  for (const w of discovery.warnings ?? []) console.log(`warning    ${w.code}  ${w.message}`);
  if (plan) console.log(`\nplan       nothing written: \`oats sync\` would write ${shortPath(lockFile)} ${changes.length ? "with the changes above" : "(unchanged)"}${synced.snapshotDue ? " and the automations snapshot" : ""}`);
  else console.log(`\nlock       ${shortPath(lockFile)}`);
}

/** Discover the workspace automations of a discovery and write the snapshot the host tick reads
 *  (lib/automations.mjs). A trigger's `from:` instantiates the package template at the lock's
 *  commit; a schedule is checked against this deployment. → the snapshot */
async function takeAutomationSnapshot(ctx, discovery, lock, { write = true } = {}) {
  const kinds = await automationKinds(ctx.deploymentDir, lock, ctx.remoteOptions);
  const found = await A.discoverAutomations(discovery, { remote: kinds.remote, memberName: memberLabel, kinds: [kinds.trigger, kinds.schedule], previous: A.readSnapshot(ctx.deploymentDir) });
  const snap = A.snapshotOf(discovery, found, { souls: A.soulIndexOf(discovery, memberLabel) });
  // A workspace with no triggers or schedules leaves nothing behind (onboard creates what the
  // kernel needs and nothing else); a snapshot that existed is replaced, so a removal lands.
  if (write && automationSnapshotDue(ctx.deploymentDir, snap)) A.writeSnapshot(ctx.deploymentDir, snap);
  return snap;
}
/** Whether a sync writes this snapshot: it has entries, or one exists to replace. */
const automationSnapshotDue = (dep, snap) => !!(snap.triggers.length || snap.schedules.length || snap.problems.length || A.readSnapshot(dep));
/** The two kinds' descriptors (lib/triggers.mjs triggerKind, lib/schedule.mjs scheduleKind). */
async function automationKinds(dep, lock, remoteOptions) {
  const T = await import("../lib/triggers.mjs");
  const { bindRemote } = await import("../lib/packages.mjs");
  const remote = bindRemote(remoteModule, remoteOptions);
  return { remote, trigger: T.triggerKind({ lock, remote }), schedule: scheduleKind({ dep }) };
}
const automationCounts = (snap) => ({ triggers: snap.triggers.length, schedules: snap.schedules.length, problems: snap.problems.length, takenAt: snap.takenAt });

/** `oats automations refresh [--dir] [--json]`: re-discover the workspace automations and rewrite
 *  the snapshot (what `oats sync` does for them, without touching the lock). The host tick runs it
 *  when the snapshot is ten minutes old. */
async function automationsCmd() {
  const bail = (code, msg, details) => (JSON_MODE ? jsonFail(code, msg, details) : die(msg));
  if (args[1] !== "refresh") return bail("E_USAGE", "usage: oats automations refresh [--dir <deployment>] [--json]");
  const ctx = workspaceContext(bail);
  const discovery = await discoverForCli(ctx, bail);
  let lock;
  try { lock = readLock(ctx.deploymentDir); } catch (e) { return bail(e.code || "E_LOCK_SCHEMA", e.message, e.details); }
  let snap;
  try { snap = await takeAutomationSnapshot(ctx, discovery, lock); }
  catch (e) { if (typeof e?.code === "string" && e.code.startsWith("E_")) return bail(e.code, e.message, e.details); throw e; }
  const result = { automationsApi: A.AUTOMATIONS_API, snapshot: A.snapshotPath(ctx.deploymentDir), ...automationCounts(snap), problems: snap.problems };
  if (JSON_MODE) return jsonOk(result);
  console.log(`automations ${result.triggers} trigger(s), ${result.schedules} schedule(s) — snapshot ${shortPath(result.snapshot)}`);
  for (const p of snap.problems) console.log(`problem    ${p.code}  ${p.repoKey ? `${memberLabel(p.repoKey)}:` : ""}${p.path}  ${p.message}`);
}

/** `oats trigger|schedule add --workspace <member> --runs-on <host> --owner <host>/<login>`: the
 *  workspace file, written into the member's checkout when `--dir` (or the cwd) is inside one, else
 *  printed. What is written must read back as the same automation (parseAutomationFile + expand). */
async function addWorkspaceAutomation(desc, { id, body, description }) {
  const bail = (code, msg, details) => { throw Object.assign(new Error(msg), { code, details }); };
  const member = flag("workspace"), runsOn = flag("runs-on"), owner = flag("owner");
  // The header's description: refused here when out of the rule (discovery would only warn).
  if (description !== undefined && description !== "") A.validateDescription(description, desc.kind === "trigger" ? "E_TRIGGER_INVALID" : "E_SCHEDULE_INVALID");
  if (typeof member !== "string" || !member) bail("E_BAD_ARGS", "--workspace needs a member name");
  if (typeof runsOn !== "string" || !A.HOST_NAME_RE.test(runsOn)) bail("E_BAD_ARGS", "--runs-on <host>: the host.name (oats-local.yaml) of the machine that runs it");
  if (!A.parseOwner(owner)) bail("E_BAD_ARGS", "--owner <host>/<login>: the GitHub account it acts as, e.g. github.com/acme-kb-bot");
  const ctx = workspaceContext(bail);
  const discovery = await discoverForCli(ctx, bail);
  const row = (discovery.members || []).find((m) => m.confirmed && (memberLabel(m.key) === member || sameRepo(m.key, member)));
  if (!row) bail("E_AUTOMATION_MEMBER", `${member} is not a confirmed member of this workspace (members: ${(discovery.members || []).filter((m) => m.confirmed).map((m) => memberLabel(m.key)).join(", ") || "none"})`, { member });
  const name = memberLabel(row.key);
  const content = A.automationFileText(desc, { id, description: description || undefined, runsOn, owner, body });
  const parsed = A.parseAutomationFile(desc, { stem: id, path: `${desc.folder}/${id}.yaml`, bytes: Buffer.from(content), member: name, repoKey: row.key, commit: row.commit });
  if (parsed.problem) bail(parsed.problem.code, parsed.problem.message, { path: parsed.problem.path });
  const def = await desc.expand(parsed.entry);
  // A capability source's trigger means something only against its soul's resolution: checked before the file is written.
  if (desc.kind === "trigger") await (await import("../lib/triggers.mjs")).checkAddMeaning(ctx.deploymentDir, def, { remoteOptions: ctx.remoteOptions });
  const namesRow = (url) => { try { return sameRepo(remoteModule.parseRepoRef(url).key, row.key); } catch { return false; } };
  const at = A.memberCheckoutFor(dirFlag(), desc, id, { sameRepo: namesRow });
  const file = { member: name, repoKey: row.key, path: `${desc.folder}/${id}.yaml`, content };
  if (!at) return { file, written: false, id: `${name}/${id}` };
  if (existsSync(at.file)) bail(desc.kind === "trigger" ? "E_TRIGGER_EXISTS" : "E_SCHEDULE_EXISTS", `${at.file} already exists; edit it in place`, { path: at.file });
  mkdirSync(dirname(at.file), { recursive: true });
  writeFileSync(at.file, content);
  return { file: { ...file, written: at.file }, written: true, id: `${name}/${id}` };
}
const printWorkspaceAdd = (r) => r.written
  ? `wrote ${shortPath(r.file.written)} — commit and push it; after \`oats sync\` (or within ten minutes) ${r.id} runs on its host`
  : `# ${r.file.path} in ${r.file.member} (${r.file.repoKey}) — this directory is not a checkout of it; save this there, commit and push:\n${r.file.content}`;
/** Enable/disable a WORKSPACE trigger or schedule on this host: oats-local.yaml
 *  `triggers.disabled` / `schedules.disabled`. */
function setDisabledHereCli(ws, kind, qid, enabled) {
  const { path } = loadLocal(ws);
  return A.setDisabledHere({ deployment: dirname(path), localPath: path }, kind, qid, !enabled);
}

const SYNC_USAGE = "usage: oats sync [--dir <deployment>] [--plan] [--json]";
/** Why `oats sync`'s argv is not a sync, or undefined (#731): an unknown flag or a positional is refused
 *  before anything is read or written, never ignored. `--approve` keeps its own refusal (performSync). */
function syncArgvProblem(argv) {
  let dirs = 0;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json" || a === "--plan") continue;
    if (a === "--dir") {
      if (dirs++) return { message: `oats sync: give --dir once\n${SYNC_USAGE}`, details: { flag: a } };
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) i++;
      continue;
    }
    if (a === "--approve") return { message: `--approve: ${APPROVAL_REMOVED}`, details: { flag: a } };
    if (a.startsWith("-")) return { message: `oats sync: unknown flag ${a}\n${SYNC_USAGE}`, details: { flag: a } };
    return { message: `oats sync: unexpected argument ${JSON.stringify(a)}: sync takes no positional (the deployment is --dir <deployment>)\n${SYNC_USAGE}`, details: { argument: a } };
  }
  return undefined;
}

/** `oats sync [--dir] [--plan] [--json]` — contract §6. `--plan` previews: the same report, nothing written. */
async function syncCmd() {
  const bail = (code, msg, details) => (JSON_MODE ? jsonFail(code, msg, details) : die(msg));
  const problem = syncArgvProblem(args);
  if (problem) return bail("E_BAD_ARGS", problem.message, problem.details);
  const ctx = workspaceContext(bail);
  const synced = await performSync(ctx, bail, { plan: args.includes("--plan") });
  // One envelope (or the §8 report); success is exit 0 (a failure bails with its code).
  if (JSON_MODE) jsonOk(synced.report); else printSyncReport(ctx, synced);
}

/** Walk up from dir for oats-workspace.yaml INSIDE a Git checkout → { file, root } | null. */
function workspaceCheckoutFrom(dir) {
  let current = resolve(dir);
  for (;;) {
    const candidate = join(current, "oats-workspace.yaml");
    if (existsSync(candidate)) {
      // The file is edited in place only when it is TRACKED by the checkout it sits in (an untracked
      // copy inside some repository is not the shared workspace file).
      let inCheckout = false;
      for (let d = current; ; d = dirname(d)) { if (existsSync(join(d, ".git"))) { inCheckout = true; break; } if (dirname(d) === d) break; }
      if (!inCheckout) return null;
      const tracked = spawnSync("git", ["-C", current, "ls-files", "--error-unmatch", "--", "oats-workspace.yaml"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 });
      return tracked.status === 0 ? { file: candidate, root: current } : null;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** `oats package add <id> <version|git:<repo>@<ref>> | remove <id> [--dir]` — contract §6. */
async function packageCmd() {
  const bail = (code, msg, details) => (JSON_MODE ? jsonFail(code, msg, details) : die(msg));
  const sub = args[1];
  const id = args[2];
  const value = sub === "add" && typeof args[3] === "string" && !args[3].startsWith("--") ? args[3] : undefined;
  const usage = "usage: oats package add <id> <version|git:<repo>@<ref>> [--dir <d>] | oats package remove <id> [--dir <d>]";
  if (!["add", "remove"].includes(sub) || !id || id.startsWith("--")) return bail("E_USAGE", usage);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) return bail("E_WORKSPACE_SCHEMA", `package id ${JSON.stringify(id)} must match ^[a-z0-9][a-z0-9._-]*$`, { id });
  if (sub === "add") {
    if (!value || value.startsWith("--")) return bail("E_USAGE", usage);
    const c = classifyPackageValue(value);
    if (c.problem) return bail("E_WORKSPACE_SCHEMA", `packages.${id}: ${c.problem} (a package is a bare version like v2.1.3 or git:<repo>@<ref>)`, { id, value });
    if (c.kind === "git") { try { remoteModule.parseRepoRef(c.repo); } catch (e) { return bail(e.code || "E_REPO_REF", e.message, e.details ?? e.provenance); } }
  }
  const line = sub === "add" ? `  ${id}: ${YAML.stringify(value).trim()}` : null;
  const checkout = workspaceCheckoutFrom(dirFlag());
  if (!checkout) {
    // Untracked branch (the workspace file is shared through Git, not edited here). A `remove`
    // still checks the id against the DISCOVERED workspace when this directory realizes one
    // (oats-local.yaml): removing what is not declared is E_PACKAGE_MISSING, as in the tracked branch.
    if (sub === "remove") {
      let ctx = null; try { const found = loadLocal(dirFlag()); ctx = { dir: dirFlag(), localPath: found.path, local: found.local, deploymentDir: dirname(found.path), remoteOptions: remoteOptionsFromEnv() }; }
      catch (e) { if (e?.code !== "E_LOCAL_MISSING") return bail(e.code || "E_WORKSPACE_SCHEMA", e.message, e.details); }
      if (ctx) {
        const discovery = await discoverForCli(ctx, bail);
        const declared = discovery.standalone === true ? standalonePackages(catalogForSync(bail)).packages : (discovery.workspace?.packages || {});
        if (!Object.hasOwn(declared, id)) return bail("E_PACKAGE_MISSING", `packages.${id} is not declared by workspace ${workspaceName(discovery)} (${discovery.key} @ ${short(discovery.commit)})${discovery.standalone === true ? " — standalone: only the kernel's default package is requested" : ""}`, { id, workspace: discovery.key, declared: Object.keys(declared).sort() });
      }
    }
    if (JSON_MODE) { jsonOk({ action: sub, id, value: value ?? null, edited: false, file: null, line: sub === "add" ? `packages:\n${line}` : null, hint: "oats-workspace.yaml is not in this checkout; commit the change in the workspace repo, then `oats sync`" }); return; }
    if (sub === "add") console.log(`oats-workspace.yaml is not in this checkout. Add under packages: in the workspace repo, then \`oats sync\`:\n\npackages:\n${line}`);
    else console.log(`oats-workspace.yaml is not in this checkout. Remove \`${id}\` from packages: in the workspace repo, then \`oats sync\`.`);
    return;
  }
  const text = readFileSync(checkout.file, "utf8");
  let doc;
  try { doc = YAML.parseDocument(text, { keepSourceTokens: true }); } catch (e) { return bail("E_WORKSPACE_SCHEMA", `${checkout.file}: ${e.message}`, { path: checkout.file }); }
  if (doc.errors?.length) return bail("E_WORKSPACE_SCHEMA", `${checkout.file}: ${doc.errors.map((e) => e.message).join("; ")}`, { path: checkout.file });
  const root = doc.contents;
  if (!YAML.isMap(root)) return bail("E_WORKSPACE_SCHEMA", `${checkout.file}: top level must be a mapping`, { path: checkout.file, problems: [{ path: "", message: "top level must be a mapping" }] });
  const packagesNode = root.get("packages", true);
  if (packagesNode !== undefined && packagesNode !== null && !(YAML.isScalar(packagesNode) && packagesNode.value === null) && !YAML.isMap(packagesNode)) {
    return bail("E_WORKSPACE_SCHEMA", `${shortPath(checkout.file)}: packages: must be a mapping of <package-id>: <version>, found ${YAML.isSeq(packagesNode) ? "a sequence" : JSON.stringify(packagesNode.toJSON?.() ?? String(packagesNode))}`, { path: checkout.file, problems: [{ path: "/packages", message: "must be an object" }] });
  }
  const previous = YAML.isMap(packagesNode) ? packagesNode.toJSON() : null;
  const had = previous && Object.hasOwn(previous, id) ? previous[id] : undefined;
  if (sub === "add") {
    if (!YAML.isMap(packagesNode)) root.set("packages", doc.createNode({ [id]: value }));
    else packagesNode.set(id, value);
  } else {
    if (had === undefined) return bail("E_PACKAGE_MISSING", `packages.${id} is not in ${shortPath(checkout.file)}`, { id, path: checkout.file });
    root.get("packages").delete(id);
    if (root.get("packages")?.items?.length === 0) root.delete("packages");
  }
  const next = doc.toString();
  const problems = validateWorkspace(YAML.parse(next), { remote: remoteModule });
  if (problems.length) return bail("E_WORKSPACE_SCHEMA", `${shortPath(checkout.file)} would be invalid: ${problems.map((p) => `${p.path || "/"}: ${p.message}`).join("; ")}`, { path: checkout.file, problems });
  writeFileAtomic(checkout.file, next);
  const receipt = { action: sub, id, value: value ?? null, previous: had ?? null, edited: true, file: checkout.file };
  if (JSON_MODE) { jsonOk(receipt); return; }
  console.log(sub === "add"
    ? `${had === undefined ? "Added" : `Changed (${had} →)`} packages.${id}: ${value} in ${shortPath(checkout.file)}. Commit it, then \`oats sync\` (the lock resolves the version to a commit).`
    : `Removed packages.${id} (${had}) from ${shortPath(checkout.file)}. Commit it, then \`oats sync\`.`);
}

/** `oats workspace status [--dir] [--json]` — contract §6. The read is lib/workspace-read.mjs's. */
async function workspaceCmd() {
  const bail = (code, msg, details) => (JSON_MODE ? jsonFail(code, msg, details) : die(msg));
  if (args[1] !== "status") return bail("E_USAGE", "usage: oats workspace status [--dir <d>] [--json]");
  const ctx = { dir: dirFlag(), maxAge: maxAgeGiven, session: commandSession, cacheDir: remoteCacheDir() };
  if (JSON_MODE) return sayRead(await workspaceStatusAnswer(ctx));
  const read = await workspaceStatusView(ctx);
  if (read.exit) return sayRead(read);
  const { result, discovery, localPath } = read.view;
  const { members, packages, unsynced, stale } = result, standalone = result.standalone === true;
  console.log(`workspace ${workspaceName(discovery)}  (${discovery.key} @ ${short(discovery.commit)})  local ${shortPath(localPath)}\n`);
  if (standalone) console.log(`  (${standaloneNote(discovery)})\n`);
  console.log("Members:");
  printTable(["member", "status", "commit", "souls", "capabilities", "publishes"], members.map((m) => [m.name, m.status, short(m.commit), m.souls.join(",") || "—", m.capabilities.join(",") || "—", m.publishes ? `${m.publishes.package} v${m.publishes.version ?? "?"}` : "—"]));
  for (const m of members.filter((m) => !m.confirmed)) console.log(`    ${m.name}: ${m.detail}`);
  console.log("\nPackages:");
  if (!packages.length) console.log(unsynced.length ? `  (none locked yet — \`oats sync\` resolves ${unsynced.join(", ")})` : "  (none)");
  else printTable(["package", "version", "source", "commit", "capabilities", "souls"], packages.map((p) => [p.id, p.version, p.source, short(p.commit), p.capabilities.join(","), p.souls.join(",") || "—"]));
  if (packages.length && unsynced.length) console.log(`  declared but not locked (run \`oats sync\`): ${unsynced.join(", ")}`);
  if (stale.length) console.log(`  locked but no longer declared (run \`oats sync\`): ${stale.join(", ")}`);
  if (result.external.length) console.log(`\nExternal: ${result.external.map((e) => `${e.soul} (${e.source.replace(/@([0-9a-f]{40})$/, (_, o) => `@${short(o)}`)})`).join("   ")}`);
  if (result.automations.rows.length) {
    console.log(`\nAutomations (this host: ${result.automations.host ?? "unnamed — set host.name in oats-local.yaml"}):`);
    printTable(["kind", "id", "runs on", "owner", "here"], result.automations.rows.map((r) => [r.kind, r.id, r.runsOn, r.owner, r.runsHere ? "runs here" : r.invalid ? "invalid" : r.reason ?? "disabled here"]));
  }
  if (discovery.problems.length) { console.log("\nProblems:"); for (const p of discovery.problems) console.log(`  ${p.code}  ${p.repoKey ? `${memberLabel(p.repoKey)}:` : ""}${p.path}  ${p.message}`); }
  if (result.warnings.length) { console.log("\nWarnings:"); for (const w of result.warnings) console.log(`  ${w.code}  ${w.message}${w.remedy ? `\n    ${w.remedy}` : ""}`); }
  process.stderr.write(read.stderr);
}

/** The deployment's team facts for the team verbs: oats-local.yaml, the committed workspace file and the
 *  souls it offers (the workspace discovered now; none in a standalone view). */
async function teamsContext(bail) {
  const ctx = workspaceContext(bail);
  let discovery;
  try {
    const { discoverOrStandalone } = await import("../lib/instance-resolution.mjs");
    discovery = await discoverOrStandalone(ctx.local, { lock: readLockIfPresent(ctx.deploymentDir), deployment: ctx.deploymentDir, remoteOptions: ctx.remoteOptions });
  } catch (e) { if (typeof e?.code === "string" && e.code.startsWith("E_")) return bail(e.code, e.message, e.details ?? e.provenance); throw e; }
  const standalone = discovery.standalone === true;
  return { deployment: ctx.deploymentDir, localPath: ctx.localPath, local: ctx.local, workspace: standalone ? null : discovery.workspace, workspaceKey: standalone ? null : discovery.key ?? null,
    soulKeys: discoveredTeamKeys(discovery), remoteOptions: ctx.remoteOptions };
}
const positional = (i) => (args[i] !== undefined && !args[i].startsWith("--") ? args[i] : undefined);

/** The flags each `oats teams` form takes (value flags → true), beyond the global `--dir` and `--json`.
 *  Anything else is refused, never ignored: a kernel that ignored `--if-absent` would set unconditionally. */
const TEAMS_FLAGS = {
  "": { "--max-age": true },
  add: { "--team": true, "--description": true, "--no-default": false },
  remove: {},
  default: { "--if-absent": false, "--expect": true },
};
/** The first flag `oats teams <sub>` does not take, or undefined. A value flag's value is skipped as flag()
 *  reads it (the next word unless it starts with `--`). */
function teamsUnknownFlag(sub) {
  const takes = { "--dir": true, "--json": false, ...TEAMS_FLAGS[sub ?? ""] };
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("-")) continue;
    if (!Object.hasOwn(takes, a)) return a;
    if (takes[a] && args[i + 1] !== undefined && !args[i + 1].startsWith("--")) i++;
  }
  return undefined;
}

/** `oats teams [--json] | add <label> --team <id> [--description <d>] [--no-default] | remove <label> |
 *  default <label> [--if-absent | --expect <label>]` — this deployment's teams (team model 3). Config only:
 *  never a provider call. */
async function teamsCmd() {
  const bail = (code, msg, details) => (JSON_MODE ? jsonFail(code, msg, details) : die(msg));
  const usage = "usage: oats teams [--json] | oats teams add <label> --team <id> [--description <d>] [--no-default] | oats teams remove <label> | oats teams default <label> [--if-absent | --expect <label>]  [--dir <deployment>] [--json]";
  // A single-dash word (`-x`) is a flag, never the subcommand: teamsUnknownFlag names it.
  const sub = positional(1)?.startsWith("-") ? undefined : positional(1);
  if (sub !== undefined && !["add", "remove", "default"].includes(sub)) bail("E_USAGE", usage);
  const unknown = teamsUnknownFlag(sub);
  if (unknown !== undefined) {
    const form = sub ? `oats teams ${sub}` : "oats teams";
    bail("E_USAGE", `${form} does not take ${unknown} (an option this kernel does not know may need a newer kernel; nothing was changed) — ${usage}`, { flag: unknown });
  }
  const label = sub ? positional(2) : undefined;
  if (sub && label === undefined) bail("E_BAD_ARGS", `oats teams ${sub} needs a team label — ${usage}`);
  const ctx = await teamsContext(bail);
  const V = await import("../lib/teams-verbs.mjs");
  let result = null;
  try {
    if (sub === "add") result = V.teamsAdd(ctx, label, { team: valueFlag("team"), description: valueFlag("description"), noDefault: args.includes("--no-default") });
    else if (sub === "remove") result = V.teamsRemove(ctx, label);
    else if (sub === "default") result = V.teamsDefault(ctx, label, { ifAbsent: args.includes("--if-absent"), expect: valueFlag("expect") });
  } catch (e) { if (typeof e?.code === "string" && e.code.startsWith("E_")) return bail(e.code, e.message, e.details); throw e; }
  const doc = V.teamsDocument(result ? { ...ctx, local: result.local } : ctx);
  if (JSON_MODE) { jsonOk(result ? { ...doc, changed: result.changed, ...(result.reused ? { reused: true } : {}) } : withObservation(doc)); return; }
  if (result?.reused) console.log(`Team ${label} is already declared with that id: nothing to change`);
  else if (result) console.log(result.changed ? `${sub === "add" ? `Declared team ${label}` : sub === "remove" ? `Removed team ${label}` : `The default team is now ${label}`} in ${shortPath(ctx.localPath)}` : "Nothing to change");
  console.log(`default   ${doc.defaultTeam ? `${doc.defaultTeam.label} (${doc.defaultTeam.from})` : "(none)"}`);
  console.log(`local     ${doc.localTeams === null ? "allowed (standalone)" : doc.localTeams ? "allowed (localTeams: true)" : "not allowed"}`);
  if (!doc.teams.length) console.log("teams     (none: `oats aweb setup` creates them, or `oats teams add <label> --team <id>`)");
  else printTable(["team", "id", "from", ""], doc.teams.map((t) => [t.label, t.team ?? "(no id yet)", t.from, t.default ? "default" : ""]));
  const souls = Object.entries(doc.souls).map(([k, e]) => `${k}: ${[e.default ? `default ${e.default}` : null, e.teams === "any" ? "any" : Array.isArray(e.teams) ? `[${e.teams.join(",")}]` : null].filter(Boolean).join(" ") || "default only"}`);
  if (souls.length) console.log(`souls     ${souls.join(" · ")}`);
  for (const p of doc.problems) console.log(`${p.severity === "failure" ? "problem" : "warning"}   ${p.code}  ${p.message} — ${p.fix}`);
}

/** The `oats soul teams` edit flags team model 3 removed (0.38.0): a soul's teams are the workspace's `souls:`. */
const SOUL_TEAMS_REMOVED_FLAGS = ["--add", "--remove", "--default", "--clear-default"];
const SOUL_TEAMS_REPLACEMENT = "souls: in oats-workspace.yaml (a PR to the workspace file)";

/** `oats soul teams <soul>|'*' [--json]` — which teams a soul may join here, its default, and why (team
 *  model 3: the workspace's `souls:`, and the local teams it allows). Config only, read only. */
async function soulCmd() {
  const bail = (code, msg, details) => (JSON_MODE ? jsonFail(code, msg, details) : die(msg));
  const usage = `usage: oats soul teams <soul>|'*'  [--dir <deployment>] [--max-age <s>] [--json] | ${SOUL_LAUNCH_USAGE}`;
  if (positional(1) === "launch") return soulLaunchCmd(bail, usage);
  const removed = SOUL_TEAMS_REMOVED_FLAGS.find((f) => args.some((a) => a === f || a.startsWith(`${f}=`)));
  if (removed) bail("E_BAD_ARGS", `oats soul teams ${removed} was removed in 0.38.0 (team model 3): which teams a soul may join, and its default, are ${SOUL_TEAMS_REPLACEMENT}`, { flag: removed, replacement: SOUL_TEAMS_REPLACEMENT });
  if (positional(1) !== "teams") bail("E_USAGE", usage);
  const name = positional(2);
  if (name === undefined) bail("E_BAD_ARGS", `oats soul teams needs a soul (or '*') — ${usage}`);
  const ctx = workspaceContext(bail);
  let teamsCtx, soul = "*", key = "*";
  if (name === "*") teamsCtx = await teamsContext(bail);
  else {
    // The soul is named as for spawn: E_SOUL_UNKNOWN / E_SOUL_AMBIGUOUS; package souls come from the lock.
    let lock = null;
    try { lock = readLockIfPresent(ctx.deploymentDir); } catch (e) { return bail(e.code || "E_LOCK_SCHEMA", e.message, e.details); }
    let discovery, entry;
    try {
      const { discoverOrStandalone, findSoulEntry } = await import("../lib/instance-resolution.mjs");
      discovery = await discoverOrStandalone(ctx.local, { lock, deployment: ctx.deploymentDir, remoteOptions: ctx.remoteOptions });
      entry = findSoulEntry(discovery, name);
    } catch (e) { if (typeof e?.code === "string" && e.code.startsWith("E_")) return bail(e.code, e.message, e.details ?? e.provenance); throw e; }
    soul = entry.name; key = teamKeyOf(entry);
    teamsCtx = { deployment: ctx.deploymentDir, localPath: ctx.localPath, local: ctx.local, workspace: discovery.standalone === true ? null : discovery.workspace, workspaceKey: discovery.key ?? null };
  }
  const V = await import("../lib/teams-verbs.mjs");
  let doc;
  try { doc = V.soulTeamsDocument(teamsCtx, { soul, key }); }
  catch (e) { if (typeof e?.code === "string" && e.code.startsWith("E_")) return bail(e.code, e.message, e.details); throw e; }
  if (JSON_MODE) { jsonOk(withObservation(doc)); return; }
  console.log(`${key === "*" ? "unlisted souls (\"*\")" : key} here: default ${doc.defaultTeam ? `${doc.defaultTeam.label} (${doc.defaultTeam.from})` : "(none)"}`);
  console.log(`souls: ${doc.match === null ? "no entry matches" : `teams from ${JSON.stringify(doc.match)}`}${doc.defaultMatch !== null ? `, default from ${JSON.stringify(doc.defaultMatch)}` : ""}`);
  if (doc.teams.length) printTable(["team", "id", "from", "why"], doc.teams.map((t) => [t.default ? `${t.label} (default)` : t.label, t.team ?? "(no id yet)", t.from, t.via.join(",")]));
}

const SOUL_LAUNCH_USAGE = "oats soul launch set <soul>|'*' (--launch-config <name>|none | --harness pi|claude|codex [--model <id>]) [--plan] [--dir <deployment>] [--json] | oats soul launch remove <soul>|'*'|<exact key> [--plan] [--dir <deployment>] [--json]";
/** The flags each `oats soul launch` form takes (value flags → true). Anything else is refused, never
 *  ignored: `--home` and `--soul` among them, since the soul is the argument and the file the deployment's. */
const SOUL_LAUNCH_FLAGS = {
  set: { "--launch-config": true, "--harness": true, "--model": true },
  remove: {},
};
/** A souls.launch entry in words: a launch configuration's name, or the inline harness and model. */
const launchEntryText = (v) => (v === null ? "no entry" : typeof v === "string" ? (v === "none" ? "none (the bare harness)" : `launch configuration ${v}`) : `${v.harness}${v.model ? ` with model ${v.model}` : ""}`);

/** `oats soul launch set <soul>|'*' (--launch-config <name>|none | --harness <h> [--model <id>]) |
 *  remove <soul>|'*'|<exact key>  [--plan] [--dir <deployment>] [--json]` (feature soul-launch): the
 *  writer of oats-local.yaml souls.launch (lib/soul-launch-verbs.mjs). It reads the workspace live. */
async function soulLaunchCmd(bail, usage) {
  const sub = positional(2);
  if (!["set", "remove"].includes(sub)) bail("E_USAGE", usage);
  // Every argument is accounted for before anything is read or written: a flag the form does not take, a
  // value flag with no value at ANY of its occurrences (`--harness codex --harness`), a value flag given
  // twice (flag() would read the first and drop the second) and a second name are refused, never ignored.
  const takes = { "--dir": true, "--json": false, "--plan": false, ...SOUL_LAUNCH_FLAGS[sub] };
  const names = [], given = new Set();
  for (let i = 3; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("-")) { names.push(a); continue; }
    if (!Object.hasOwn(takes, a)) bail("E_USAGE", `oats soul launch ${sub} does not take ${a} (nothing was changed) — usage: ${SOUL_LAUNCH_USAGE}`, { flag: a });
    if (!takes[a]) continue;
    if (args[i + 1] === undefined || args[i + 1].startsWith("--")) bail("E_BAD_ARGS", `${a} needs a value`);
    if (given.has(a)) bail("E_BAD_ARGS", `oats soul launch ${sub} takes ${a} once (nothing was changed)`);
    given.add(a);
    i++;
  }
  if (names.length === 0) bail("E_BAD_ARGS", `oats soul launch ${sub} needs ${sub === "set" ? "a soul (or '*')" : "a soul, '*' or the exact text of a key in souls.launch"} — usage: ${SOUL_LAUNCH_USAGE}`);
  if (names.length > 1) bail("E_BAD_ARGS", `oats soul launch ${sub} takes one ${sub === "set" ? "soul" : "soul or key"}, and got ${names.length}: ${names.map((n) => JSON.stringify(n)).join(", ")} (nothing was changed) — usage: ${SOUL_LAUNCH_USAGE}`);
  const name = names[0];
  const V = await import("../lib/soul-launch-verbs.mjs");
  let value = null;
  if (sub === "set") {
    try { value = V.soulLaunchValue({ launchConfig: valueFlag("launch-config"), harness: valueFlag("harness"), model: valueFlag("model") }); }
    catch (e) { if (typeof e?.code === "string" && e.code.startsWith("E_")) return bail(e.code, e.message, e.details); throw e; }
  }
  const ctx = workspaceContext(bail);
  const readSouls = async () => {
    const { discoverOrStandalone } = await import("../lib/instance-resolution.mjs");
    return discoverOrStandalone(ctx.local, { lock: readLockIfPresent(ctx.deploymentDir), deployment: ctx.deploymentDir, remoteOptions: ctx.remoteOptions });
  };
  let r;
  try { r = await V.soulLaunch({ deployment: ctx.deploymentDir, localPath: ctx.localPath }, { action: sub, name, value, plan: args.includes("--plan") }, { readSouls }); }
  catch (e) { if (typeof e?.code === "string" && e.code.startsWith("E_")) return bail(e.code, e.message, e.details ?? e.provenance); throw e; }
  if (JSON_MODE) { jsonOk(r); return; }
  const key = JSON.stringify(r.key), file = shortPath(r.file);
  if (!r.changed) console.log(`souls.launch ${key} is already ${launchEntryText(r.after)} in ${file}: nothing to change`);
  else if (r.action === "set") console.log(`${r.plan ? "Would set" : "Set"} souls.launch ${key} to ${launchEntryText(r.after)} in ${file}${r.before === null ? "" : ` (it was ${launchEntryText(r.before)})`}${r.plan ? "; nothing was written" : ""}`);
  else console.log(`${r.plan ? "Would remove" : "Removed"} souls.launch ${key} (${launchEntryText(r.before)}) from ${file}${r.plan ? "; nothing was written" : ""}`);
  if (r.unread) { console.log(`The workspace's souls could not be read (${r.unread.code}: ${r.unread.message}), so this says nothing about which soul the key applied to or which keys still match none`); return; }
  if (r.souls && r.souls.length > 1) console.log(`This entry applies to ${r.souls.length} souls: ${r.souls.join(", ")} (a member's soul is keyed by its bare name)`);
  if (r.key === "*") console.log(`"*" is the launch of every soul without an entry of its own`);
  else if (r.launch === null) console.log(`${key} is the key of no soul this workspace offers`);
  else {
    const e = r.launch.effective;
    console.log(`The next spawn of ${r.souls.length > 1 && name !== r.key ? name : r.souls[0]} selects ${e.harness}${e.model ? ` with model ${e.model}` : ""}${e.launchConfig ? ` (launch configuration ${e.launchConfig})` : ""}, from ${r.launch.at ?? "the host default"}${r.launch.problem ? `, and would be refused: ${r.launch.problem.code}: ${r.launch.problem.message}` : ""}`);
  }
  for (const u of r.unmatched) console.log(`souls.launch ${launchKeyQuoted(u.key)} is the key of no soul this workspace offers${u.suggestions.length ? ` (nearest: ${u.suggestions.join(", ")})` : ""}: ${soulLaunchCommand("remove", { key: u.key })}`);
}

/** The catalog's rows of `kind` ("capabilities" | "souls") as `oats capabilities` / `oats souls` list them:
 *  one discovery (honouring --max-age), the lock, workspaceItems. → { ctx, discovery, lock, items }. */
async function catalogRows(kind, bail) {
  const ctx = workspaceContext(bail);
  const discovery = await discoverForCli(ctx, bail);
  let lock;
  try { lock = readLock(ctx.deploymentDir); } catch (e) { return bail(e.code || "E_LOCK_SCHEMA", e.message, e.details); }
  return { ctx, discovery, lock, items: workspaceItems(discovery, lock, ctx.local, ctx.deploymentDir)[kind] };
}

/** `oats capabilities` / `oats souls` [--dir] [--json] — contract §6. */
async function itemsCmd(kind) {
  const bail = (code, msg, details) => (JSON_MODE ? jsonFail(code, msg, details) : die(msg));
  if (kind === "capabilities") {
    const { words } = capabilitiesArgv();
    if (words[0] === "show") return capabilityShowCmd(bail);
    if (words.length) return bail("E_BAD_ARGS", `unknown capabilities subcommand ${JSON.stringify(words[0])}: \`oats capabilities\` lists the catalog, \`oats capabilities show <name>\` reads one capability`, { subcommand: words[0] });
  }
  const { ctx, discovery, lock, items } = await catalogRows(kind, bail);
  // One command's reads at a commit are shared: many souls resolve over the same manifests and listings.
  const remote = memoizedRemote(remoteModule);
  if (kind === "capabilities") await capabilityFacts(items, discovery, lock, ctx, remote);
  if (kind === "souls") await soulFacts(items, discovery, lock, ctx, remote);
  const standalone = discovery.standalone === true;
  // `oats souls` reads souls.launch for every soul it lists: a key that names none of them is a problem
  // of this read, one row per key (the souls a spawn would refuse carry it as launch.problem).
  const unmatched = kind === "souls" ? launchKeysUnmatched({ local: ctx.local, offered: soulsOffered(discovery) }).unmatched.map(unmatchedProblemRow) : [];
  const problems = [...discovery.problems, ...unmatched];
  if (JSON_MODE) { jsonOk(withObservation({ [`${kind}Api`]: 1, standalone: standalone || undefined, workspace: { name: workspaceName(discovery), key: discovery.key, commit: discovery.commit }, [kind]: items, problems })); return; }
  console.log(`${kind} of workspace ${workspaceName(discovery)} (${discovery.key} @ ${short(discovery.commit)})${standalone ? `  — ${standaloneNote(discovery)}` : ""}\n`);
  if (!items.length) console.log("  (none)");
  else if (kind === "souls") printTable(["name", "origin", "teams here", "work"], items.map((s) => [s.name, s.origin, s.teams === null ? "(invalid: oats teams)" : s.teams.map((t) => (t.default ? `${t.label}*` : t.label)).join(",") || "—", s.work ?? "—"]));
  else printTable(["name", "origin", "layer"], items.map((c) => [c.private ? `${c.name} (repo-owned)` : c.name, c.origin, c.layer ?? "—"]));
  const unsynced = Object.keys(discovery.workspace?.packages || {}).filter((id) => !lock.packages[id]);
  if (kind === "capabilities" && unsynced.length) console.log(`\n  package capabilities of ${unsynced.join(", ")} appear after \`oats sync\``);
  for (const p of problems) console.log(`\n${catalogProblemLine(p)}`);
}

/** Owner fields decide context, never message text. A problem source is display data;
 * render that projection without changing the operational external source. */
function catalogProblemLine(p) {
  const owner = p.repoKey || p.package || (p.source ? remoteModule.displayRepoRef(p.source, { pinned: true }) : null);
  const where = owner ? ` [${terminalText(`${owner}: ${p.path}`)}]` : "";
  return `! ${p.code}: ${p.message}${where}`;
}

/** A key of souls.launch that names no soul (lib/launch-preference.mjs launchKeysUnmatched's row) as a
 *  row of `oats souls --json` `problems`: `path` is where the key is. */
function unmatchedProblemRow(row) {
  return { code: LAUNCH_PREFERENCE_UNMATCHED, path: row.at, message: unmatchedKeyMessage(row), key: row.key, value: row.value, suggestions: row.suggestions };
}

/** `oats capabilities` argv after the command: its words (the subcommand first) with every flag and a value
 *  flag's value set aside, and the first flag neither form takes (`unknown`). */
function capabilitiesArgv() {
  const VALUE_FLAGS = new Set(["--member", "--package", "--file", "--dir", "--max-age", "--server"]);
  const words = [];
  let unknown;
  for (let i = 1; i < args.length; i++) {
    if (VALUE_FLAGS.has(args[i])) { if (args[i + 1] !== undefined && !args[i + 1].startsWith("--")) i++; continue; }
    if (args[i].startsWith("--")) { if (args[i] !== "--json") unknown ??= args[i]; continue; }
    words.push(args[i]);
  }
  return { words, unknown };
}

/** `oats capabilities show <name> [--member <repoKey> | --package <id>] [--file <path>] [--dir] [--json]`
 *  (feature capability-show, capabilityShowApi 1; lib/capability-show.mjs): what one catalog row ships, read
 *  at that row's commit — the rows are `oats capabilities`'s own (catalogRows). */
async function capabilityShowCmd(bail) {
  const S = await import("../lib/capability-show.mjs");
  if (flag("server") !== undefined) return bail("E_BAD_ARGS", "oats capabilities show reads this machine's workspace only: --server is not accepted");
  const { words, unknown } = capabilitiesArgv();
  if (unknown) return bail("E_BAD_ARGS", `oats capabilities show: unknown flag ${unknown}`, { flag: unknown });
  const positionals = words.slice(1);
  if (positionals.length !== 1) return bail("E_BAD_ARGS", positionals.length ? `oats capabilities show takes one capability name, got ${positionals.map((p) => JSON.stringify(p)).join(" ")}` : "oats capabilities show needs a capability name (`oats capabilities` lists them)");
  const name = positionals[0];
  const memberArg = valueFlag("member"), packageArg = valueFlag("package"), file = valueFlag("file");
  if (memberArg !== undefined && packageArg !== undefined) return bail("E_BAD_ARGS", "choose --member <repoKey> or --package <id>, not both");
  if (file !== undefined && S.unsafeFilePath(file)) return bail("E_CAPABILITY_FILE_UNSAFE", `${JSON.stringify(file)} is not a relative path inside the capability`, { path: file });
  const { ctx, discovery, lock, items } = await catalogRows("capabilities", bail);
  // --member takes the repo key a row shows, or any ref spelling of it (compared on the canonical key).
  let member = memberArg ?? null;
  if (member !== null && !items.some((r) => sameRepo(r.repoKey, member))) { try { member = remoteModule.parseRepoRef(member).key; } catch { /* matches no row */ } }
  const remote = memoizedRemote(remoteModule);
  const catalog = (() => { try { return officialPackageCatalog(); } catch { return null; } })();
  let doc;
  try {
    const row = S.selectCapabilityRow(items, name, { member, package: packageArg ?? null });
    const source = await S.capabilitySource(row, { discovery, lock, catalog, remote, remoteOptions: ctx.remoteOptions });
    doc = file === undefined ? await S.capabilityShow(source, { remote, remoteOptions: ctx.remoteOptions }) : await S.capabilityFile(source, file, { remote, remoteOptions: ctx.remoteOptions });
  } catch (e) { if (typeof e?.code === "string" && e.code.startsWith("E_")) return bail(e.code, e.message, e.details ?? e.provenance); throw e; }
  if (JSON_MODE) { jsonOk(withObservation(doc)); return; }
  if (file !== undefined) {
    const f = doc.file;
    if (f.binary) console.log(`(${f.path}: binary, ${formatBytes(f.bytes)} — not shown)`);
    else {
      process.stdout.write(f.text.endsWith("\n") || f.text === "" ? f.text : `${f.text}\n`);
      if (f.truncated) console.log(`(${f.path}: truncated — ${formatBytes(f.bytes)}, the first ${formatBytes(S.TEXT_LIMIT)} shown)`);
    }
    // The file's text is stdout's alone: a warning goes to stderr.
    for (const w of doc.warnings) console.error(`warning  ${w.code}  ${w.message}`);
    return;
  }
  console.log(`${doc.name} — ${doc.kind === "member" ? `member ${doc.repoKey}` : `package ${doc.package} v${doc.version} (${doc.repoKey})`} @ ${short(doc.commit)}, ${doc.path}\n`);
  const size = (bytes) => (bytes === null ? "unreadable" : formatBytes(bytes));
  console.log(`  inject: ${doc.inject ? `${doc.inject.path ?? "(unsafe path)"} (${size(doc.inject.bytes)}${doc.inject.binary ? ", binary" : ""}${doc.inject.truncated ? ", truncated" : ""})` : "(none)"}`);
  if (doc.skills === null) console.log("  skills: (cannot be listed — see problems)");
  else if (!doc.skills.length) console.log("  skills: (none)");
  else {
    console.log("  skills:");
    for (const skill of doc.skills) {
      console.log(`    ${skill.name}  ${skill.path}`);
      if (skill.files === null) console.log("      (files cannot be listed — see problems)");
      for (const f of skill.files ?? []) console.log(`      ${f.path}  ${size(f.bytes)}`);
      if (skill.filesTruncated) console.log(`      … more files (the first ${S.FILES_PER_SKILL} are listed)`);
    }
  }
  if (doc.triggerSources !== undefined) {
    // As declared (a malformed declaration is shown, never refused): names, commands and events, made safe to print.
    const { safeText } = await import("../lib/refused-text.mjs");
    const decl = doc.triggerSources && typeof doc.triggerSources === "object" && !Array.isArray(doc.triggerSources) ? doc.triggerSources : null;
    console.log(decl && Object.keys(decl).length ? "  trigger sources:" : `  trigger sources: ${decl ? "(none)" : "(malformed — see trigger source problems)"}`);
    for (const [n, src] of Object.entries(decl ?? {})) {
      const o = src && typeof src === "object" ? src : {};
      console.log(`    ${safeText(n, 60)}  command ${typeof o.command === "string" ? safeText(o.command, 60) : "?"}  events ${Array.isArray(o.events) ? o.events.map((e) => safeText(String(e), 40)).join(",") : "?"}${typeof o.description === "string" ? `  — ${safeText(o.description, 200)}` : ""}`);
    }
    for (const p of doc.triggerSourceProblems ?? []) console.log(`  trigger source problem: ${p.pointer} — ${safeText(p.message, 300)}`);
  }
  for (const p of doc.problems) console.log(`  problem: ${p.code}${p.path ? ` ${p.path}` : ""} — ${p.message}`);
  for (const w of doc.warnings) console.log(`  warning  ${w.code}  ${w.message}`);
  console.log(`\n  a file's text: oats capabilities show ${doc.name}${doc.kind === "package" ? ` --package ${doc.package}` : ""} --file <path>`);
}

/** Capability rows' manifest facts (feature desktop-facts): layer, description, and what each provides
 *  (skills, commands, hooks by name) — member rows from discovery's manifest, package rows from the manifest
 *  at the locked commit (the sync cache; no network beyond sync's). An unreadable package leaves its rows' facts null. */
async function capabilityFacts(rows, discovery, lock, ctx, remote = remoteModule) {
  const { capabilityProvides, lockedPackageCapabilities, memberRef } = await import("../lib/resolve.mjs");
  const remoteOptions = ctx.remoteOptions;
  const catalog = (() => { try { return officialPackageCatalog(); } catch { return null; } })();
  const packages = new Map();
  for (const [id, entry] of Object.entries(lock?.packages || {})) {
    try { packages.set(id, await lockedPackageCapabilities(id, entry, { catalog, remote, remoteOptions })); } catch { packages.set(id, null); }
  }
  // Indexes built once (a scan of every member per row was O(rows × members)): the member row per key
  // (memberRowByKey); the member rows per (key, commit), in row order.
  const capOf = (member, name) => member?.capabilities.find((c) => c.name === name);
  const rowsAt = new Map();
  for (const r of rows) {
    if (r.kind === "package") continue;
    const k = `${r.repoKey}\0${r.commit}`;
    if (!rowsAt.has(k)) rowsAt.set(k, []);
    rowsAt.get(k).push(r);
  }
  // A member capability's fingerprint is its Git tree at the commit (one listing per member commit); a
  // package's is the package integrity (the lock).
  const trees = new Map();
  const treeOf = async ({ repoKey, commit }, ref, dir) => {
    const key = `${repoKey}\0${commit}`;
    if (!trees.has(key)) {
      const member = memberRowByKey(discovery.members, repoKey);
      const dirs = (rowsAt.get(key) || []).map((r) => capOf(member, r.name)?.path).filter(Boolean);
      trees.set(key, remoteModule.remoteTreeOids(ref, commit, [...new Set(dirs)], remoteOptions).catch(() => new Map()));
    }
    return (await trees.get(key)).get(dir) ?? null;
  };
  for (const row of rows) {
    let manifest = null, ref = null, dir = null;
    if (row.kind === "package") {
      const read = packages.get(row.package), cap = read?.capabilities.find((c) => c.name === row.name);
      if (cap) ({ manifest, dir } = cap), ref = read.ref;
    } else {
      const cap = capOf(memberRowByKey(discovery.members, row.repoKey), row.name);
      if (cap) { manifest = cap.manifest; dir = cap.path; ref = memberRef(discovery, remoteModule, row.repoKey); }
    }
    const provides = manifest ? await capabilityProvides({ ref, commit: row.commit, dir, manifest, remote, remoteOptions }) : { skills: null, commands: null, hooks: null };
    const repoKey = row.kind === "package" && ref ? (() => { try { return remoteModule.parseRepoRef(ref).key; } catch { return null; } })() : row.repoKey;
    const file = dir ? { path: `${dir}/oats.json`, url: remoteModule.browseUrl(repoKey, row.commit, `${dir}/oats.json`) } : null;
    const tree = row.kind !== "package" && ref && dir ? await treeOf(row, ref, dir) : null;
    Object.assign(row, { layer: manifest?.layer ?? row.layer ?? null, description: manifest?.description ?? null, ...provides, file, tree });
  }
}

/** Souls rows' spawnability (feature desktop-facts): the refusal a spawn of each would meet, computed from
 *  discovery and the lock without spawning (soulSpawnability), and what the same resolution composes
 *  (`capabilities`, feature souls-capabilities; null when not spawnable). */
async function soulFacts(rows, discovery, lock, ctx, remote = remoteModule) {
  const { soulSpawnability } = await import("../lib/instance-resolution.mjs");
  // Indexes built once, each keeping the FIRST match as `find` did (a scan per row was O(souls × members)).
  const first = (pairs) => { const m = new Map(); for (const [k, v] of pairs) if (!m.has(k)) m.set(k, v); return m; };
  const packageSoul = first((discovery.packageSouls || []).map((p) => [p.qualifiedName, p]));
  const externalSoul = first((discovery.external || []).map((e) => e.soul).map((x) => [`${x.name}\0${x.repoKey}`, x]));
  const entryOf = (row) => row.kind === "package" ? packageSoul.get(row.qualifiedName)
    : row.kind === "external" ? externalSoul.get(`${row.name}\0${row.repoKey}`)
    : memberRowByKey(discovery.members, row.repoKey)?.souls.find((x) => x.name === row.name);
  for (const row of rows) {
    const entry = entryOf(row);
    row.file = { path: `${row.path}/soul.yaml`, url: remoteModule.browseUrl(row.repoKey, row.commit, `${row.path}/soul.yaml`) };
    Object.assign(row, entry ? await soulSpawnability(ctx.local, discovery, lock, entry, { remoteOptions: ctx.remoteOptions, remote }) : { spawnable: false, problem: { code: "E_SOUL_UNKNOWN", message: `${row.name} is not in this discovery` }, capabilities: null });
  }
}

// ---------- roster: status / spawn / retire / create ----------
/** One `modules:` line per module. */
function driftLine(row) {
  const from = row.from || {};
  const origin = from.kind === "package" ? `package ${from.package} v${from.version}` : memberLabel(row.recorded?.repoKey ?? from.repoKey ?? "?");
  const base = `modules: ${row.module} from ${origin} @ ${short7(row.recorded?.commit)}`;
  if (row.status === "moved") return `${base}  [${from.kind === "package" ? "package" : "member"} moved since (now @ ${short7(row.current?.commit)})]`;
  if (row.status === "missing") return `${base}  [${row.reason === "capability-absent" ? "capability no longer present" : row.reason === "package-absent" ? "package no longer locked" : `member ${row.reason || "unconfirmed"}`}]`;
  return base;
}
/** The `soul:` line of an instance — decision 17 for the soul source. */
function soulDriftLine(row, agentName) {
  if (row.package) {
    const base = `soul: ${row.name ?? agentName} from package ${row.package} v${row.version} @ ${short7(row.commit)}`;
    if (row.status === "moved") return `${base}  [package moved since (now v${row.current?.version} @ ${short7(row.current?.commit)})]`;
    if (row.status === "missing") return `${base}  [${row.reason === "soul-absent" ? "soul no longer shipped by the package" : "package no longer locked"}]`;
    return base;
  }
  const base = `soul: ${row.name ?? agentName} from ${memberLabel(row.repoKey)} @ ${short7(row.commit)}`;
  if (row.status === "moved") return `${base}  [member moved since (now @ ${short7(row.current?.commit)})]`;
  if (row.status === "missing") return `${base}  [${row.reason === "soul-absent" ? "soul no longer present" : `member ${row.reason || "unconfirmed"}`}]`;
  return base;
}
/** The roster's `[work: …, repo: …]` for a soul: a workspace soul names its member and commit. */
function soulRepoLabel(a, ws) {
  const stamp = ws?.souls?.get(a.name);
  if (!stamp) return a.repo || "?";
  if (typeof stamp.package === "string") return `package ${stamp.package} v${stamp.version} @ ${short7(stamp.commit)}`;
  const moved = stamp.current && stamp.commit && stamp.current !== stamp.commit ? ` (member now @ ${short7(stamp.current)})` : "";
  return `${memberLabel(stamp.repoKey)} @ ${short7(stamp.commit)}${moved}`;
}
const short7 = (oid) => (typeof oid === "string" ? oid.slice(0, 7) : "?");

/** `oats status [--dir] [--verbose] [--json]`. The read is lib/roster-read.mjs's; `--team` is refused
 *  before --dir is read. */
async function status() {
  const team = args.includes("--team");
  const ctx = { dir: team ? null : dirFlag(), team, maxAge: maxAgeGiven, session: commandSession, cacheDir: remoteCacheDir() };
  if (JSON_MODE) return sayRead(await statusAnswer(ctx), { indent: 2 });
  const read = await statusView(ctx);
  if (read.exit) return sayRead(read);
  printStatus(read.view, args.includes("--verbose"));
  process.stderr.write(read.stderr);
}
function printStatus({ root, agents: data, ws, problems }, verbose) {
  console.log(`oats status — agents root ${shortPath(root)}\n`);
  if (ws?.unreachable) console.log(`  workspace: unreachable (${ws.unreachable.reason}) — drift unknown\n`);
  for (const p of problems) console.log(`  ! ${p.code}: ${p.message}\n`);
  if (data.length === 0) { console.log("  (no agents — a soul is a member repository's souls/<name>; `oats souls` lists the workspace's)"); return; }
  for (const a of data) {
    console.log(`  ${a.name}  [work: ${a.work || "checkout"}, repo: ${soulRepoLabel(a, ws)}]`);
    if (a.description) console.log(`      ${a.description}`);
    for (const i of a.instances) {
      // Feature instance-background: the row is marked; it is listed like any other.
      console.log(`      • ${i.instance}${i.background === true ? " [background]" : ""}  ${statusWord(i)}  (branch ${i.branch || "?"}, ${i.work || "?"})${i.runtimeError ? `  ${i.runtimeError}` : ""}`);
      { const lost = lostLine(i); if (lost) console.log(`          ${lost}`); }
      // Feature waiting-on-you: non-null only on a running row; the reader has
      // already validated the message (one line, no control characters).
      { const waiting = waitingLine(i); if (waiting) console.log(`          ${waiting}`); }
      const key = i.home ?? `${a.name}/${i.instance}`;
      if (i.identity) console.log(`          identity: ${servedIdentityLine(i.identity)}`);
      // The kernel the home's plain `oats` runs (its last launch's), when it is not this one.
      const launchedBy = i.home ? recordedKernelBin(i.home) : null;
      if (typeof launchedBy === "string" && (verbose || launchedBy !== CLI_BIN)) console.log(`          kernel: ${launchedBy}${launchedBy !== CLI_BIN ? " (not this oats)" : ""}`);
      const s = ws?.soul.get(key);
      if (s && (verbose || s.status !== "current")) console.log(`          ${soulDriftLine(s, a.name)}`);
      const rows = ws?.drift.get(key) || [];
      for (const r of rows) if (verbose || r.status !== "current") console.log(`          ${driftLine(r)}`);
    }
    for (const f of a.retireFailures || []) {
      console.log(`      ! deferred retirement of ${f.instance} FAILED${f.completedAt ? ` at ${f.completedAt}` : ""}: ${f.error || (f.incomplete || []).join("; ") || "see result file"} — retry with \`oats retire ${f.instance}\``);
    }
  }
}

/** The flags `oats spawn` reads: those taking a value, and switches. `--provider` takes two words.
 *  `--instance` is refused by a local spawn (with its replacement) but still travels to an older
 *  host through `--server`, whose route reads it. `--max-age` reaches here only on a preview or an
 *  apply bound by --expect-decision: the dispatch allow-list (maxAgeRefusal) refuses it otherwise. */
const SPAWN_VALUE_FLAGS = new Set(["agents-root", "backend", "base", "branch", "dir", "expect-decision", "harness", "idempotency-key", "instance", "launch-config", "max-age", "model", "name", "parent", "purpose", "relation", "relative-root", "relative-to", "repo", "runtime", "task", "task-file", "trigger-event", "wake-cron", "wake-every", "wake-file", "wake-json", "wake-message", "wake-message-file", "wake-tz", "work", "work-dir"]);
const SPAWN_SWITCHES = new Set(["allow-child-spawns", "background", "json", "no-background", "no-child-spawns", "no-launch", "no-yolo", "preview", "same-work", "suggest-name", "yolo"]);
/** `--suggest-name` (features spawn-suggest-name, spawn-apply-suggest-name): a preview's or an apply's,
 *  with no --name, --purpose or --expect-decision. The kernel refuses the same (core.mjs spawnBody); the
 *  CLI says it before anything is read or sent. */
function suggestNameProblem(argv) {
  if (!argv.includes("--suggest-name")) return undefined;
  const given = (flag) => argv.some((a) => a.split("=")[0] === flag);
  if (given("--expect-decision")) return "--suggest-name chooses the name, and --expect-decision's decision already binds one: apply the previewed name with --name <instance> --expect-decision <revision>";
  if (given("--name") || given("--purpose")) return "--suggest-name chooses the name: it takes no --name or --purpose";
  return undefined;
}
/** `--background` / `--no-background` (feature instance-background): one of them, or neither. */
const backgroundProblem = (argv) => (argv.includes("--background") && argv.includes("--no-background") ? "choose --background or --no-background, not both" : undefined);
/** Why `argv` (after `spawn`, the soul first) is not a spawn, or undefined: a positional after the
 *  soul or a flag spawn does not read is never ignored. A value flag consumes its value exactly as
 *  flag() reads it; a missing value is the flag's own check. */
function spawnArgvProblem(argv) {
  const soul = argv[0];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--provider") { i += 2; continue; }
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (SPAWN_SWITCHES.has(name)) continue;
      if (!SPAWN_VALUE_FLAGS.has(name)) return `oats spawn: unknown flag ${a}`;
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) i++;
      continue;
    }
    if (/^[A-Za-z0-9_.-]+=/.test(a)) return `oats spawn: unexpected argument ${JSON.stringify(a)} after the soul ${JSON.stringify(soul)}: a capability setting is given as --provider <capability> key=value (here: --provider <capability> ${a})`;
    return `oats spawn: unexpected argument ${JSON.stringify(a)} after the soul ${JSON.stringify(soul)}: spawn takes one soul`;
  }
  return undefined;
}
/** The Herdr spawn flags (removed in 0.31.0), named for the refusal; undefined when none is given. */
function herdrSpawnFlag() {
  if (flag("backend") === "herdr") return "--backend herdr";
  if (flag("herdr-socket") !== undefined) return "--herdr-socket";
  return undefined;
}
/** How a name was chosen (`naming`: features spawn-suggest-name, spawn-apply-suggest-name,
 *  instance-suggest-name), for a text line; null without one. */
function namingLine(naming) {
  if (naming?.source === "suggested") return `suggested by ${terminalText(naming.harness)}${naming.model ? ` (${terminalText(naming.model)})` : ""} in ${naming.ms} ms`;
  if (naming?.source === "numbered") return `numbered (${terminalText(naming.reason)}: ${terminalText(naming.message)})`;
  return null;
}
/** A spawn preview's text: the local one, or a host's answer to a routed
 *  preview (`server`, its id), which this side printed the same way (#610). */
function printSpawnPreview(r, { server, soulFetched = false } = {}) {
  // A host before 0.27 names the harness `runtime` (it still answers spawn-preview-2).
  const harness = r.harness ?? r.runtime;
  console.log(`preview ${r.agent} → ${r.instance}${server ? ` on ${server}` : ""} (${r.work}${r.branch ? `, branch ${r.branch}${r.base ? ` from ${r.base.ref}@${r.base.oid.slice(0, 12)}` : ""}` : ""}) harness ${harness}${r.model ? ` model ${r.model}` : ` (${r.modelSource})`}${r.launchConfig ? ` via launch configuration ${r.launchConfig}${r.launchConfigDefault ? ` (${server ? "the server's" : "this machine's"} ${harness} default)` : ""}${r.launchConfigSource ? ` from ${server ? terminalText(r.launchConfigSource) : shortPath(launchConfigFile(r.launchConfigSource))}` : ""}` : ""}${r.yolo ? " YOLO" : ""}; nothing was created${soulFetched ? " (the soul source was fetched to a temporary copy, not kept)" : ""}`);
  // Feature spawn-suggest-name: how the name was chosen.
  { const line = namingLine(r.naming); if (line) console.log(`name: ${line}`); }
  if (r.background === true) console.log(`list: background (from the ${r.backgroundFrom === "flag" ? "--background flag" : "soul"})`);
  if (Array.isArray(r.worktreeHooks)) console.log(r.worktreeHooks.length ? `worktree hooks: ${r.worktreeHooks.map((h) => `${h.capability}${h.required ? " (required)" : ""}`).join(", ")}` : "worktree hooks: none");
  for (const w of r.warnings || []) console.log(`  WARNING: ${terminalText(w)}`);
}
async function spawnCmd() {
  // JSON mode: contract envelope, stable error codes, stderr-only progress.
  const bail = (code, msg, details, exit) => (JSON_MODE ? jsonFail(code, msg, details, exit) : die(msg, exit));
  const note = (msg) => (JSON_MODE ? console.error(msg) : console.log(msg));
  const yolo = yoloFlag();
  { const herdr = herdrSpawnFlag(); if (herdr) { const e = herdrSettingRemoved(`${herdr} was given`); bail(e.code, e.message); } }
  const backend = valueFlag("backend");
  if (backend !== undefined && backend !== "tmux") bail("E_BAD_ARGS", "--backend must be tmux");
  const requestedWork = valueFlag("work");
  const workDir = valueFlag("work-dir"), branch = valueFlag("branch"), repo = valueFlag("repo");
  const checkDirectoryOptions = (work) => {
    if (work === "directory" && (workDir !== undefined || branch !== undefined)) bail("E_BAD_ARGS", "--work directory owns only <home>/work; --work-dir and --branch are not allowed");
  };
  checkDirectoryOptions(requestedWork); // before anything is resolved or written
  const name = args[1];
  if (!name || name.startsWith("--")) bail("E_USAGE", "usage: oats spawn <agent> [--task <text>|--task-file <f>] [--purpose <slug>|--name <slug>|--suggest-name] [--preview] [--base <ref>] [--model <id>|@native-default] [--allow-child-spawns|--no-child-spawns] [--relation child|sibling|parent|unrelated --relative-to <instance> [--relative-root <agents-root>]] [--parent <instance>] [--same-work] [--repo <r>] [--work worktree|checkout|attached|workspace|directory] [--work-dir <owner-work>] [--harness pi|claude|codex] [--backend tmux] [--yolo|--no-yolo] [--background|--no-background] [--model <m>] [--branch <b>] [--no-launch] [--json]");
  // Retired boundary flags (maintainer transport ruling): fail LOUDLY before
  // ANY side effect, including root discovery.
  // Local souls (local-agents/) are gone with the workspace model: a soul is a member
  // repository's souls/<name>, so spawn never writes one.
  for (const removed of ["instructions-file", "def-file"]) if (flag(removed) !== undefined) bail("E_BAD_ARGS", `--${removed} created a local soul under local-agents/, which the workspace model removed — author souls/<name>/soul.yaml + AGENTS.md in a member repository, then \`oats sync\``);
  if (args.includes("--instance")) bail("E_BAD_ARGS", "--instance was removed by the runtime-boundary ruling — use --purpose <slug> (deterministic <agent>-<purpose> naming) or --name <slug> (the exact instance name)");
  // --name <slug>: the exact, unprefixed instance name (human decision 2026-09-24).
  const nameFlag = flag("name");
  if (nameFlag === true) bail("E_BAD_ARGS", "--name needs an instance name (a slug: lowercase letters and digits, single dashes between them)");
  if (nameFlag !== undefined && flag("purpose") !== undefined) bail("E_BAD_ARGS", "--name and --purpose are mutually exclusive: --name is the exact instance name, --purpose derives <agent>-<purpose>");
  { const problem = suggestNameProblem(args) ?? backgroundProblem(args); if (problem) bail("E_BAD_ARGS", problem); }
  // The slug rule is checked here too, before any side effect (soul fetch).
  if (nameFlag !== undefined) { try { explicitInstanceName(String(nameFlag)); } catch (e) { bail(e.code, e.message); throw e; } }
  if (args.includes("--ephemeral")) bail("E_BAD_ARGS", "--ephemeral was removed by the runtime-boundary ruling — declare the agent in a capability manifest (agents:) for automatic ephemeral semantics");
  { const problem = spawnArgvProblem(args.slice(1)); if (problem) bail("E_BAD_ARGS", problem); }
  let root;
  // A spawn needs a workspace deployment (lead decision c3-1): no oats-local.yaml
  // in reach is E_LOCAL_MISSING, before anything else is read. The agents root is
  // then <deployment>/agents; an ambient root (the invoking agent's own
  // PI_AGENTS_ROOT / OATS_ROOT) never redirects it — a home outside
  // <deployment>/agents would have no derivable deployment.
  try { loadLocal(dirFlag()); } catch (e) { if (e?.code === "E_LOCAL_MISSING") bail("E_LOCAL_MISSING", `${e.message}: a spawn needs a workspace deployment — \`oats onboard\` creates one`, e.details); else bail(e.code || "E_WORKSPACE_SCHEMA", e.message, e.details); }
  delete process.env.PI_AGENTS_ROOT; delete process.env.OATS_ROOT;
  // A deployment without its agents/ root is E_NO_DEPLOYMENT, naming the remedy.
  try { root = ensureRoot(dirFlag()); }
  catch (e) { bail("E_NO_DEPLOYMENT", e.message || e); throw e; }
  const isPreview = args.includes("--preview");
  // --agents-root <abs>: the exact root the soul must live in (as inspect and
  // readiness take it) — the deployment's one agents root, or E_SOUL_UNKNOWN.
  const agentsRootFlag = flag("agents-root");
  if (agentsRootFlag !== undefined && (agentsRootFlag === true || !isAbsolute(String(agentsRootFlag)))) bail("E_BAD_ARGS", "--agents-root needs an absolute agents root");
  if (agentsRootFlag !== undefined && realOrResolved(String(agentsRootFlag)) !== realOrResolved(root)) bail("E_SOUL_UNKNOWN", `soul "${name}" is not at agents root ${String(agentsRootFlag)} (this scope's root is ${shortPath(root)})`);
  let agent = findAgent(root, name);
  // Workspace model: with an oats-local.yaml the soul is ALWAYS discovered over the
  // remotes and resolved (member = latest state, package = locked) — never
  // "whatever <agents-root>/<name>/soul/ happens to hold": that copy is a per-commit
  // cache (ensureWorkspaceSoul refreshes it when the member moved), so a second
  // spawn sees the member's CURRENT soul, not the first spawn's. A preview runs the
  // same read-only discovery+resolution and writes nothing: it reads the soul from
  // the per-commit cache, or fetches it to a temporary copy (reported as soulFetched).
  const providerPairs = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--provider") { if (!args[i + 1] || !args[i + 2]) bail("E_BAD_ARGS", "--provider needs <capability> <key>=<value>"); providerPairs.push([args[i + 1], args[i + 2]]); i += 2; }
  let wsPrepared, soulFetched = false, wsDiscovery;
  {
    let discovery = null;
    try {
      const { prepareInstance, ensureWorkspaceSoul, previewWorkspaceSoul, parseProviderFlags, discoverOrStandalone, agentDirOf } = await import("../lib/instance-resolution.mjs");
      const remoteOptions = remoteOptionsFromEnv();
      const { local, path: localPath } = loadLocal(dirFlag());
      discovery = wsDiscovery = await discoverOrStandalone(local, { deployment: dirname(localPath), remoteOptions });
      wsPrepared = await prepareInstance(dirFlag(), name, { spawn: { providers: parseProviderFlags(providerPairs) }, remoteOptions, discovery });
      const soulName = agentDirOf(wsPrepared.soulEntry);
      let soulDir;
      if (isPreview) {
        // A preview writes nothing in the deployment: the soul comes from the
        // per-commit cache when complete, else from a temporary fetch removed at exit.
        const pv = await previewWorkspaceSoul(wsPrepared, root);
        process.once("exit", pv.cleanup);
        soulDir = pv.soulDir; soulFetched = pv.fetched;
        agent = findAgentAt(root, soulName, soulDir);
      } else {
        const stampFile = join(root, soulName, ".oats-soul-source.json");
        const stampBefore = (() => { try { return JSON.parse(readFileSync(stampFile, "utf8")); } catch { return null; } })();
        soulDir = await ensureWorkspaceSoul(wsPrepared, root);
        soulFetched = !stampBefore || stampBefore.commit !== wsPrepared.soulEntry.commit || !sameRepo(stampBefore.repoKey, wsPrepared.soulEntry.repoKey);
        if (!agent || soulFetched || agent._dir !== dirname(soulDir)) agent = findAgent(root, soulName);
      }
      if (!agent) bail("E_SOUL_UNKNOWN", `soul "${name}" was fetched to ${shortPath(soulDir)} but is not readable as a soul there`);
      note(`(workspace soul: "${name}" from ${wsPrepared.soulEntry.repoKey} @ ${String(wsPrepared.soulEntry.commit).slice(0, 12)}${wsPrepared.resolution.defaultTeam ? `, team ${wsPrepared.resolution.defaultTeam.label}` : ""}${soulFetched ? "; soul source fetched" : ""})`);
    } catch (e) {
      // Standalone (decisions 10/25): the ONLY package request is the kernel's own
      // default; when the catalog cannot name it, say so instead of "add it to packages:"
      // (there is no workspace file to add it to).
      if (e?.code === "E_PACKAGE_MISSING" && discovery?.standalone === true) {
        const file = officialCatalogFile();
        bail(e.code, `${e.details?.capability ?? "oats.core"}: the catalog has no package providing oats.core (OATS_PACKAGE_CATALOG=${file}) — standalone spawns resolve only the kernel's default package from the catalog`, { ...(e.details ?? {}), standalone: true, reason: "no-catalog", catalog: file });
      }
      if (e?.code?.startsWith?.("E_")) bail(e.code, e.message, e.details);
      else throw e;
    }
  }
  if (agentsRootFlag !== undefined && !agent) bail("E_SOUL_UNKNOWN", `soul "${name}" is not at agents root ${String(agentsRootFlag)}`);
  if (isPreview && !agent) bail("E_SOUL_UNKNOWN", `soul "${name}" is not in ${shortPath(root)}; a preview never creates or imports a soul (known: ${listAgents(root).map((a) => a.name).join(", ") || "none"})`);
  checkDirectoryOptions(requestedWork || agent?.work);
  if (!agent) bail("E_UNKNOWN_AGENT", `unknown agent "${name}" (known: ${listAgents(root).map((a) => a.name).join(", ") || "none"}) — a soul is a member repository's souls/<name>; add it there and run \`oats sync\``);
  for (const information of agent.notes || []) note(`[${information.code}] ${information.message}`);
  // Lineage is explicit: --relation child|sibling|parent|unrelated anchors the new
  // instance to --relative-to <instance>. --parent X is sugar for
  // --relative-to X --relation child (agents spawning sub-agents pass their own
  // name, e.g. --parent "$OATS_INSTANCE"). Without a relation, the spawn lands
  // top-level; caller attribution never supplies parentage.
  const parent = flag("parent");
  if (parent !== undefined && (parent === true || !String(parent).trim())) bail("E_BAD_ARGS", "--parent needs an instance name");
  let relation = flag("relation");
  if (relation !== undefined && (relation === true || !String(relation).trim())) bail("E_BAD_ARGS", "--relation needs a value: child|sibling|parent|unrelated");
  if (relation && !RELATIONS.includes(relation)) bail("E_BAD_ARGS", `unknown --relation "${relation}" (child|sibling|parent|unrelated)`);
  let relativeTo = flag("relative-to");
  if (relativeTo !== undefined && (relativeTo === true || !String(relativeTo).trim())) bail("E_BAD_ARGS", "--relative-to needs an instance name");
  if (relation && relation !== "unrelated" && !relativeTo) bail("E_BAD_ARGS", `--relation ${relation} requires --relative-to <instance>`);
  if (relativeTo && !relation) bail("E_BAD_ARGS", "--relative-to requires --relation child|sibling|parent");
  if (relation === "unrelated" && relativeTo) bail("E_BAD_ARGS", "--relation unrelated takes no --relative-to");
  if (parent && (relation || relativeTo)) bail("E_BAD_ARGS", "--parent is sugar for --relative-to <instance> --relation child — use one form, not both");
  if (parent) { relation = "child"; relativeTo = parent; }
  // Attached agents are ALWAYS children (design decision): the only relation
  // flags allowed are the child form — required when the workDir is not an
  // instance's own <home>/work (integration worktrees). The kernel verifies
  // ownership canonically (including soul-default attached mode).
  if ((flag("work") === "attached") && relation && relation !== "child") bail("E_BAD_ARGS", "attached agents are always children of the work-tree owner — only --parent <instance> (or --relation child) is valid with --work attached");
  // NOTE: explicit "unrelated" is passed through to the kernel.
  if (relativeTo && relation !== "unrelated") {
    if (!findInstanceHome(root, relativeTo)) bail(parent ? "E_PARENT_NOT_FOUND" : "E_RELATIVE_NOT_FOUND", `${parent ? "--parent" : "--relative-to"} "${relativeTo}" does not match any known instance`);
  }
  const taskText = flag("task");
  if (taskText === true) bail("E_BAD_ARGS", "--task needs a value (use --task-file for long tasks)");
  const taskFileFlag = flag("task-file");
  if (taskFileFlag === true) bail("E_BAD_ARGS", "--task-file needs a path");
  if (taskFileFlag && !existsSync(taskFileFlag)) bail("E_BAD_ARGS", `--task-file not found: ${taskFileFlag}`);
  // --trigger-event <file>: the event a trigger spawns this instance for (lib/triggers.mjs). It is
  // copied to <home>/.oats/trigger-event.json (OATS_TRIGGER_EVENT_FILE) and recorded as instance.json.trigger.
  let triggerEvent;
  { const f = flag("trigger-event");
    if (f === true) bail("E_BAD_ARGS", "--trigger-event needs a path");
    if (f !== undefined) {
      if (!existsSync(f)) bail("E_BAD_ARGS", `--trigger-event not found: ${f}`);
      try { triggerEvent = JSON.parse(readFileSync(f, "utf8")); } catch (e) { bail("E_BAD_ARGS", `--trigger-event is not valid JSON: ${e.message}`); }
      // A pull-request event names its repo and number; a capability source's, its subject and key,
      // and its fields, recorded in instance.json, are a plain object of strings.
      const stringMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");
      const ok = triggerEvent && typeof triggerEvent === "object" && !Array.isArray(triggerEvent) && typeof triggerEvent.trigger === "string" && typeof triggerEvent.source === "string" && typeof triggerEvent.event === "string"
        && (triggerEvent.source === "github.pull_request" ? typeof triggerEvent.repo === "string" && Number.isInteger(triggerEvent.number)
          : typeof triggerEvent.subject === "string" && typeof triggerEvent.key === "string" && (triggerEvent.fields === undefined || stringMap(triggerEvent.fields)));
      if (!ok) bail("E_BAD_ARGS", "--trigger-event must hold { trigger, source, repo, number, url, event, headSha, labels, observedAt } (github.pull_request) or { trigger, source, subject, event, key, url?, fields, observedAt } (a capability source; fields an object of strings)");
    } }
  const relativeRoot = flag("relative-root");
  if (relativeRoot !== undefined && (relativeRoot === true || !String(relativeRoot).trim())) bail("E_BAD_ARGS", "--relative-root needs an agents-root path");
  if (relativeRoot && !relativeTo) bail("E_BAD_ARGS", "--relative-root only qualifies --relative-to/--parent");
  // Wake at launch: --wake-file <private JSON {cron, tz, message, enabled}>
  // is the backend bridge; --wake-every/--wake-cron/--wake-tz/--wake-message
  // (or --wake-message-file) are the human sugar for the same object. The
  // wake job is saved AFTER a successful spawn, bound to the returned home.
  let wake;
  try {
    const wakeFile = flag("wake-file");
    if (wakeFile === true) bail("E_BAD_ARGS", "--wake-file needs a path");
    const wakeJson = flag("wake-json");
    if (wakeJson === true) bail("E_BAD_ARGS", "--wake-json needs the wake object as JSON text");
    if (wakeJson) {
      let doc; try { doc = JSON.parse(wakeJson); } catch (e) { bail("E_SCHEDULE_INVALID", `--wake-json is not valid JSON: ${e.message}`); }
      if (!doc || typeof doc !== "object") bail("E_SCHEDULE_INVALID", "--wake-json must hold {cron, tz, message, enabled}");
      wake = { cron: doc.cron, tz: doc.tz, message: doc.message, enabled: doc.enabled === undefined ? true : doc.enabled };
    } else if (wakeFile) {
      if (!existsSync(wakeFile)) bail("E_BAD_ARGS", `--wake-file not found: ${wakeFile}`);
      let doc; try { doc = JSON.parse(readFileSync(wakeFile, "utf8")); } catch (e) { bail("E_SCHEDULE_INVALID", `--wake-file is not valid JSON: ${e.message}`); }
      if (!doc || typeof doc !== "object") bail("E_SCHEDULE_INVALID", "--wake-file must hold {cron, tz, message, enabled}");
      wake = { cron: doc.cron, tz: doc.tz, message: doc.message, enabled: doc.enabled === undefined ? true : doc.enabled };
    } else if (flag("wake-every") !== undefined || flag("wake-cron") !== undefined) {
      const mf = flag("wake-message-file");
      if (mf === true) bail("E_BAD_ARGS", "--wake-message-file needs a path");
      if (mf && !existsSync(mf)) bail("E_BAD_ARGS", `--wake-message-file not found: ${mf}`);
      const message = mf ? readFileSync(mf, "utf8") : flag("wake-message") === true ? undefined : flag("wake-message");
      wake = wakeFromFlags({ every: flag("wake-every") === true ? undefined : flag("wake-every"), cron: flag("wake-cron") === true ? undefined : flag("wake-cron"), tz: flag("wake-tz") === true ? undefined : flag("wake-tz"), message });
    }
    if (wake && (typeof wake.message !== "string" || !wake.message.trim())) bail("E_SCHEDULE_INVALID", "wake message: non-empty text is required");
  } catch (e) { if (e?.code?.startsWith?.("E_")) bail(e.code, e.message); throw e; }
  // Workspace model: when this deployment has an oats-local.yaml, the soul's
  // capabilities are resolved over the workspace's remotes (member = latest,
  // package = locked) and copied whole into the new home. Without one
  // (a bare agents root, tests) the classic soul-directory spawn proceeds.
  let prepared;
  // Workspace model: a `work: worktree|checkout` soul works IN its member's clone on
  // this machine (design doc §4): --repo, else oats-local.yaml `clones:`, else the
  // convention <deployment>/<member name>. Never an ambient Git checkout around the
  // deployment. Resolved once here so a preview sees exactly what the apply would.
  let preparedRepo;
  if (wsPrepared) {
    try {
      const { toCapabilityRows, modulesPreview, requireMemberClone } = await import("../lib/instance-resolution.mjs");
      prepared = wsPrepared;
      prepared.capabilityRows = []; // filled after materialization (paths live in the home); preview uses modulesPreview
      prepared.preview = modulesPreview(prepared.resolution, root, agent.name);
      prepared.toCapabilityRows = toCapabilityRows;
      const effectiveWork = requestedWork || agent.work || "checkout";
      if (effectiveWork === "worktree" || effectiveWork === "checkout") preparedRepo = requireMemberClone(prepared, { explicit: repo });
    } catch (e) { if (e?.code?.startsWith?.("E_")) bail(e.code, e.message, e.details); throw e; }
  }
  let r;
  try {
    if (args.includes("--allow-child-spawns") && args.includes("--no-child-spawns")) bail("E_BAD_ARGS", "--allow-child-spawns and --no-child-spawns contradict");
    if (flag("base") === true) bail("E_BAD_ARGS", "--base needs a ref");
    { const spawnOpts = {
      prepared,
      purpose: flag("purpose"), ...(nameFlag !== undefined ? { name: String(nameFlag) } : {}), task: taskText, taskFile: taskFileFlag, relation, relativeTo, relativeRoot,
      ...(args.includes("--allow-child-spawns") ? { allowChildSpawns: true } : args.includes("--no-child-spawns") ? { allowChildSpawns: false } : {}),
      // Feature instance-same-work: the kernel binds it to the parent the new home records, or refuses.
      ...(args.includes("--same-work") ? { sameWork: true } : {}),
      // Directory execution uses deployment configuration, not an ambient Git
      // checkout (especially when invoked via --dir from a source instance).
      // An attached instance's repository is the repository of the tree it is attached to (derived by the kernel).
      repo: preparedRepo !== undefined ? preparedRepo : ["directory", "attached"].includes(requestedWork || agent.work)
        ? repo : repo || defaultRepo(workspaceOf(root)) || defaultRepo(process.cwd()),
      work: requestedWork, workDir, harness: harnessFlag(), backend, yolo, model: flag("model"), branch,
      launchConfig: valueFlag("launch-config"),
      // Feature instance-background: the flag wins over the soul's `background:`.
      ...(args.includes("--background") ? { background: true } : args.includes("--no-background") ? { background: false } : {}),
      launch: !args.includes("--no-launch"),
      ...(triggerEvent ? { triggerEvent } : {}),
      // K6: --preview decides everything and touches nothing; --base <ref>
      // selects a worktree's start point; --model @native-default is the
      // explicit "harness's own default" (distinct from omitting --model).
      ...(args.includes("--suggest-name") ? { suggestName: true } : {}),
      ...(args.includes("--preview") ? { preview: true, subject: { soul: name, agentsRoot: agentsRootFlag !== undefined ? String(agentsRootFlag) : null, dir: flag("dir") !== undefined && flag("dir") !== true ? String(flag("dir")) : null } } : {}),
      ...(flag("base") !== undefined && flag("base") !== true ? { baseRef: flag("base") } : {}),
      // A confirmed preview binds this apply (K6b): drift → E_DECISION_STALE, nothing created.
      ...(flag("expect-decision") !== undefined && flag("expect-decision") !== true ? { expectDecision: String(flag("expect-decision")) } : {}),
      // K6c: with --idempotency-key, a retry of the SAME confirmed decision replays the recorded home instead of spawning twice.
      ...(flag("idempotency-key") !== undefined && flag("idempotency-key") !== true ? { idempotencyKey: String(flag("idempotency-key")) } : {}),
    };
      r = await spawnInstanceAsync(root, agent, spawnOpts); }
    if (args.includes("--preview")) {
      // A workspace preview may have fetched the soul's SOURCE to a temporary copy
      // (the deployment's cache had no entry for its commit): the result says so.
      if (prepared) r.soulFetched = soulFetched;
      if (JSON_MODE) { jsonOk(withObservation(r)); return; }
      printSpawnPreview(r, { soulFetched });
      return;
    }
  } catch (e) {
    // The kernel's code, as raised, through the door every lifecycle verb has (spawnFail): a refusal
    // with a remedy is never answered as "the spawn mechanism failed". E_SPAWN_FAILED is for an
    // error with no kernel code; a typed CLI failure keeps its own name.
    spawnFail(e); throw e;
  }
  // The instance exists from here on: a failed wake save is reported beside
  // the full receipt, never hidden, and never causes a second spawn.
  let wakeSchedule, wakeScheduleError;
  if (wake && r.replayed !== true) { // a replayed receipt re-saves nothing
    try { wakeSchedule = saveWakeForHome(scheduleScopeOf(workspaceOf(root)), { instance: r.instance, home: r.home, wake }); }
    catch (e) { wakeScheduleError = { code: e.code || "E_SCHEDULE_FAILED", message: e.message }; r.warnings = [...(r.warnings || []), `wake schedule NOT saved: ${e.message}`]; }
    // K6e: record the wake outcome in the home so a same-key replay can report
    // it instead of leaving "saved or not?" to inference.
    if (r.spawnIdempotencyKey) {
      try { const f = join(r.home, "instance.json"); const m = JSON.parse(readFileSync(f, "utf8")); m.wake = { requested: true, saved: !wakeScheduleError, error: wakeScheduleError ?? null }; writeHomeRecord(r.home, m); r.wake = m.wake; } catch { /* the receipt still says it */ }
    }
  } else if (r.spawnIdempotencyKey && r.replayed !== true) {
    try { const f = join(r.home, "instance.json"); const m = JSON.parse(readFileSync(f, "utf8")); m.wake = { requested: false, saved: null, error: null }; writeHomeRecord(r.home, m); r.wake = m.wake; } catch { /* nothing to record */ }
  }
  if (JSON_MODE) {
    // Desktop CLI API v1 spawn result — a FIXED shape (see docs/desktop-cli-api.md).
    jsonOk({
      instance: r.instance, agent: r.agent, home: r.home, work: r.work,
      branch: r.branch || null, base: r.base ?? null, launched: r.launched, warnings: r.warnings || [],
      // #917: what this spawn's start did with Claude's development-channel prompt, as a start answers it.
      ...(r.launchPrompts ? { launchPrompts: r.launchPrompts } : {}),
      ...(wakeSchedule ? { wakeSchedule } : {}), ...(wakeScheduleError ? { wakeScheduleError } : {}),
      tmux: r.tmux || null, backend: "tmux", repo: r.repo || null, harness: r.harness || null,
      model: r.model || null, parent: r.parentInstance || null,
      sibling: r.siblingInstance || null, relation: r.relation || null,
      spawnOrigin: r.spawnOrigin, attach: r.attach,
      ...(r.yolo !== undefined ? { yolo: r.yolo } : {}),
      // Feature instance-background: whether the home is background, and which layer declared it.
      background: r.background === true, ...(r.backgroundFrom ? { backgroundFrom: r.backgroundFrom } : {}),
      // K6b/K6c: what bound this spawn, and whether this receipt is a replay of an earlier one.
      ...(r.decision ? { decision: r.decision } : {}), ...(r.replayed !== undefined ? { replayed: r.replayed } : {}),
      ...(r.wake !== undefined ? { wake: r.wake } : {}), // {requested, saved|null, error}: saved:null = outcome not recorded
      launchConfig: r.launch?.launchConfig ?? null, launch: r.launch || null, // already redacted by the kernel
      // #796: the worktree hooks this spawn ran, with their logs; only when it ran any.
      ...(r.worktreeHooks ? { worktreeHooks: r.worktreeHooks } : {}),
      // Feature spawn-apply-suggest-name: how the name was chosen; only with --suggest-name.
      ...(r.naming ? { naming: r.naming } : {}),
    });
    return;
  }
  console.log(`Spawned ${r.instance} (${r.work}${r.branch ? `, branch ${r.branch}` : ""})${r.launched ? ` — tmux window "${r.tmux.window}"` : " — not launched"}`);
  console.log(`  home:   ${shortPath(r.home)}`);
  if (r.background === true) console.log(`  list:   background (from the ${r.backgroundFrom === "flag" ? "--background flag" : "soul"})`);
  { const line = namingLine(r.naming); if (line) console.log(`  name:   ${line}`); }
  if (r.base) console.log(`  base:   ${r.base.oid.slice(0, 12)} (${r.base.ref === r.workspace?.soul?.repoKey ? `observed head of ${r.base.ref}` : r.base.ref})`);
  for (const h of r.worktreeHooks || []) console.log(`  setup:  ${h.capability} worktree hook ${h.ok ? "ok" : "FAILED"} (log: ${shortPath(h.log)})`);
  if (wakeSchedule) console.log(`  wake:   schedule ${wakeSchedule.id} (${wakeSchedule.cron} ${wakeSchedule.tz}), next ${wakeSchedule.nextRun || "disabled"}`);
  if (wakeScheduleError) console.error(`  wake:   NOT saved — ${wakeScheduleError.message} (the instance is created and launched; add the wake by hand with oats schedule add)`);
  if (!r.launched) console.log(`  launch: oats session start --home ${shellQuote(r.home)}`);
  for (const w of r.warnings || []) console.log(`  WARNING: ${terminalText(w)}`);
  console.log(`  attach: ${r.attach}`);
}

/** The line naming the branch a FAILED_SPAWN_BRANCH_LEFT item speaks of, on a line of its own: the item names
 *  none. The receipt's `retention.recordedBranch` when the worktree step ran; otherwise the retained home's
 *  recorded branch, read here (`local`), or where to read it on the host. Null when no item asks for it. */
function failedSpawnBranchLine(r, items, { local = false, host } = {}) {
  if (!items?.includes(FAILED_SPAWN_BRANCH_LEFT)) return null;
  let name = r.retention?.recordedBranch ?? null;
  if (!name && local && r.retainedHome) { try { name = JSON.parse(readFileSync(join(r.retainedHome, "instance.json"), "utf8")).branch ?? null; } catch { /* said below */ } }
  if (name) return `  branch: ${name}`;
  return r.retainedHome ? `  branch: the "branch" recorded in ${join(r.retainedHome, "instance.json")}${host ? ` on ${host}` : ""}` : null;
}

/** Whether this process's retire (retireCmd) has returned from the kernel: set once, read by the dispatch. */
let retireReturned = false;
function retireCmd() {
  const name = args[1];
  // Refused before anything else: before --plan, a replay, a plan revision or a recorded child is stopped.
  if (args.includes("--delete-branch")) return args.includes("--json") ? jsonFail("E_BAD_ARGS", RETIRE_DELETE_BRANCH_REFUSED) : die(RETIRE_DELETE_BRANCH_REFUSED);
  if (!name || name.startsWith("--")) die("usage: oats retire <instance> [--plan] [--plan-revision <rev> --idempotency-key <key>] [--home <path>] [--self] [--discard-worktree] [--keep-dir] [--force] [--json]");
  let homeFlag = flag("home");
  if (homeFlag === true) die("--home needs the instance home path");
  if (args.includes("--plan")) {
    // K3: what retirement would touch, with the design's defaults — read-only.
    dropAmbientRoot();
    let root; try { root = ensureRoot(dirFlag()); } catch (e) { return lifecycleFail(e, "E_NO_ROOT"); }
    try {
      const plan = planRetire(dirFlag(), root, name, { home: homeFlag });
      if (args.includes("--json")) { jsonOk(plan); return; }
      console.log(`retire ${name} — plan ${plan.planRevision}`);
      console.log(`  session ${plan.facts.session.state}; work ${plan.facts.work.observed ? `${plan.facts.work.changed} changed / ${plan.facts.work.untracked} untracked on ${plan.facts.work.branch ?? (plan.facts.work.detached ? "detached" : "a ref OATS carries no branch name for")}` : `not observed (${plan.facts.work.reason})`}; children ${plan.facts.children.length}; pull request ${plan.facts.pullRequest}`);
      console.log(`  ${retireDefaultsLine(plan)}`);
      for (const n of plan.notes) console.log(`  note: ${terminalText(n)}`);
      return;
    } catch (e) { return lifecycleFail(e, "E_LIFECYCLE_FAILED", e.candidates ? { ...e.details, candidates: e.candidates } : e.details); }
  }
  // The calling instance knows its own home: self-retire never needs to
  // disambiguate a same-named twin by hand.
  if (homeFlag === undefined && process.env.OATS_INSTANCE_HOME && process.env.OATS_INSTANCE === name) homeFlag = process.env.OATS_INSTANCE_HOME;
  const isSelf = process.env.OATS_INSTANCE === name;
  if (isSelf && !args.includes("--self")) die(`"${name}" is the calling instance — self-retire is irreversible; if your task is complete and you were told to retire, re-run with --self (finish your memory files FIRST; your session dies ~8s after)`);
  if (!isSelf && args.includes("--self")) die(`--self given but "${name}" is not the calling instance`);
  const root = ensureRoot(dirFlag());
  // K3: a GUI-driven Remove carries the plan revision it showed and an
  // idempotency key. The revision is revalidated against a fresh plan
  // (E_PLAN_STALE with that plan attached — re-confirm, never act on the old
  // one); a retried key replays the recorded receipt instead of retiring twice.
  const planRev = flag("plan-revision"), idemKey = flag("idempotency-key");
  if (planRev === true || idemKey === true) die("--plan-revision and --idempotency-key need values");
  if ((planRev !== undefined) !== (idemKey !== undefined)) die("--plan-revision and --idempotency-key go together");
  // What the plan says about recorded children holds on every apply path: the
  // retirement stops them first and keeps them (retireInstance, once it has
  // resolved the home). A guarded apply acts on the children of the plan it
  // revalidated; a plain or --self retire computes them as the plan does, and
  // passes none when there are none.
  let replayPath = null, fresh, revalidate, stalePlan, planFailure;
  if (planRev !== undefined) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(idemKey)) die("--idempotency-key: 1-128 chars of [A-Za-z0-9._:-]");
    // Replay first: after a successful retire the home is gone, so the receipt
    // (beside the instances dir, keyed by the idempotency key) is the answer.
    const replay = (dir) => { const p = join(dir, `.oats-retire-receipt.${idemKey}.json`); if (!existsSync(p)) return false; try { const prior = JSON.parse(readFileSync(p, "utf8")); if (prior.retired !== name) return false; if (args.includes("--json")) jsonOk({ ...prior, replayed: true }); else console.log(`retire ${name}: replayed receipt for key ${idemKey}`); return true; } catch { return false; } };
    for (const a of listAgents(root)) if (replay(join(a._dir, "instances"))) return;
    // Before the claim, only the home: where the receipt goes, and the answers of a name that
    // resolves to no home, to several or to another one.
    let target;
    try { target = resolveInstanceForCli(dirFlag(), root, name, { home: homeFlag }); } catch (e) { return lifecycleFail(e, "E_LIFECYCLE_FAILED", e.details); }
    replayPath = join(dirname(target.home), `.oats-retire-receipt.${idemKey}.json`);
    // The plan the revision is checked against is read once, by retireInstance, when it holds the
    // home's claim (RETIRE_UNDER_CLAIM): nobody else is retiring the home by then, so the plan is
    // the state the retire starts from. Against another retire of this home the answer is that one
    // is running (E_LIFECYCLE_BUSY), and no plan is read. A revision that no longer matches is
    // refused there, and nothing was done. What the retire takes from the plan: its children, and
    // its extra trees as it names them (the retire refuses as stale rather than move or remove one
    // that no longer reads that way when it gets to them).
    revalidate = () => {
      try { fresh = planRetire(dirFlag(), root, name, { home: homeFlag }); } catch (e) { planFailure = e; throw e; }
      if (fresh.planRevision !== planRev) throw (stalePlan = Object.assign(new Error(`the retire plan changed since it was shown (${planRev} → ${fresh.planRevision}); review the fresh plan`), { code: "E_PLAN_STALE", details: { plan: fresh } }));
      return { plannedExtraWorktrees: fresh.facts.extraWorktrees, children: fresh.facts.children, ambiguous: fresh.facts.ambiguous };
    };
  } else {
    // A plain or --self retire reads its recorded children the same way: under the claim, as they
    // are when the retire starts (an earlier retire that kept the home has repaired lineage by
    // then), and none when there are none.
    // The instances the plan lists under `ambiguous` go with them: the retire does not act on
    // them, and says what it left the ones attached to a tree it moved or removed with.
    revalidate = () => { const recorded = descendantsOf(root, name); return { ...(recorded.length ? { children: recorded } : {}), ...(recorded.ambiguous?.length ? { ambiguous: recorded.ambiguous } : {}) }; };
  }
  let r;
  try { r = retireInstance(root, name, { home: homeFlag, self: isSelf, discardWorktree: args.includes("--discard-worktree"), keepDir: args.includes("--keep-dir"), force: args.includes("--force"), [RETIRE_UNDER_CLAIM]: revalidate }); }
  catch (e) {
    // The plan could not be read, or its revision is not the one shown: the answers they always had.
    if (e === planFailure) return lifecycleFail(e, "E_LIFECYCLE_FAILED", e.details);
    if (e === stalePlan) return args.includes("--json") ? jsonFail(e.code, e.message, e.details) : die(`the retire plan changed since it was shown; re-run oats retire ${name} --plan`);
    // A child still running (or whose stop could not be established) refused the retirement: the
    // guarded apply returns the plan it acted on, and the text names each child's reason.
    if (e?.code === "E_CHILDREN_RUNNING") {
      const running = e.details.childrenStopped.filter((k) => !k.ok);
      return args.includes("--json") ? jsonFail(e.code, e.message, { ...e.details, ...(planRev !== undefined ? { plan: fresh } : {}) }) : die(`children still running: ${running.map((k) => `${k.instance} (${k.code})`).join(", ")}; nothing retired`);
    }
    // Whatever else the retire answers: retireInstance gives every error a kernel code, and what the
    // retire had done by then (`details.reached`).
    return lifecycleFail(e, "E_LIFECYCLE_FAILED", e.candidates ? { ...e.details, candidates: e.candidates } : e.details);
  }
  // The retire has answered. Whatever throws from here on is not an answer of the retire and is
  // not given one (the dispatch): an error envelope without `reached` would say that nothing was done.
  retireReturned = true;
  if (replayPath) { r.planRevision = planRev; r.idempotencyKey = idemKey; r.replayed = false; try { writeFileAtomic(replayPath, JSON.stringify(r, null, 2)); } catch { /* receipt is evidence, not authority */ } }
  // A retired home's wake jobs are forgotten (definitions only; nothing is
  // stopped by this); a deferred self-retire keeps them until the home is gone.
  // The home is the one the retire selected (awebai/oats#693), as a path.
  const retiringHome = r[RETIRE_SELECTED_HOME];
  if (typeof retiringHome === "string" && r.removedDir !== false && !r.deferred) { try { const gone = removeWakeForHome(scheduleScopeOf(workspaceOf(root)), retiringHome); if (gone.length) r.wakeSchedulesRemoved = gone; } catch (e) { r.warnings = [...(r.warnings || []), `wake schedules not cleaned: ${e.message}`]; } }
  // Deferred self-retire: nothing has been inspected, run, or removed yet. The
  // caller's window dies first; a detached process then retires the instance
  // as an external operator and writes its outcome beside the home.
  if (r.deferred) {
    if (args.includes("--json")) { console.log(JSON.stringify(r, null, 2)); return; }
    console.log(`Retirement of ${r.retired} (agent ${r.agent}) is ${r.alreadyScheduled ? "already " : ""}scheduled — say any goodbyes now.`);
    console.log(`  in ~${r.completesInSec}s a detached completion quiesces this harness (that is what ends this window), preserves work, runs retire hooks and removes the home`);
    console.log(`  if the completion fails, this window stays, the failure shows in \`oats status\` and at ${shortPath(r.resultPath)}, and \`oats retire ${r.retired}\` retries it`);
    return;
  }
  // Forced removal past an incomplete cleanup: the home is gone because the
  // operator said so, but the external state it owed is still out there and
  // nobody else will mention it again.
  if (r.forcedIncomplete) {
    console.error(`Removed ${r.retired} under --force with cleanup INCOMPLETE — this external state was NOT cleaned up and is now yours to remove by hand:`);
    for (const f of r.forcedIncomplete) console.error(`  ${f}`);
    const branch = failedSpawnBranchLine(r, r.forcedIncomplete, { local: true });
    if (branch) console.error(branch);
  }
  if (args.includes("--json")) { console.log(JSON.stringify(r, null, 2)); if (r.rollbackIncomplete) process.exit(1); return; }
  // An unsuccessful cleanup retry must NOT read as a completed retirement: the
  // home and its external state are still there, and a zero exit would tell
  // both a human and any script that the work is done.
  if (r.rollbackIncomplete) {
    console.error(`Cleanup for ${r.retired} is INCOMPLETE — the instance home is retained at ${r.retainedHome} because external state may still exist:`);
    for (const f of r.rollbackIncomplete) console.error(`  ${f}`);
    const branch = failedSpawnBranchLine(r, r.rollbackIncomplete, { local: true });
    if (branch) console.error(branch);
    console.error(`Fix the cause and re-run \`oats retire ${r.retired}\`; the home holds the state that cleanup needs.`);
    process.exit(1);
  }
  console.log(`Retired ${r.retired} (agent ${r.agent})${r.worktreeRemoved ? ", worktree removed" : ""}`);
  // An attached child the retire repointed to a retained worktree, work/ (#718) or an extra tree
  // (#964), as its link now reads.
  const retainedAt = [...(r.retention?.worktree === "retained" ? [r.retention.movedTo] : []), ...(r.extraWorktrees || []).filter((t) => t.outcome === "retained").map((t) => t.movedTo)];
  const followsWorktree = (k) => { try { const to = readlinkSync(join(k.home, "work")); return retainedAt.includes(to) ? to : null; } catch { return null; } };
  for (const k of r.childrenStopped || []) { const to = followsWorktree(k); console.log(`  child ${k.instance}: ${k.alreadyIdle ? "already idle" : "stopped"}${to ? `; its work now links to the retained worktree ${to}` : ""}`); }
  // Preserving work and not saying so leaves the operator believing it is gone,
  // which is most of the harm of deleting it. Name the classes and the path.
  for (const line of workRecoveryLines(r)) console.log(line);
  for (const line of extraWorktreeLines(r)) console.log(line);
  for (const line of warningLines(r)) console.log(line);
  if (isSelf) console.log("This window dies in ~8s — say any goodbyes now.");
}

/** `oats schedule ...`: workspace-scoped definitions, host-owned execution
 *  (lib/schedule.mjs). Every subcommand answers the envelope; nothing here
 *  launches unless a job is due or run-now is asked. */
async function scheduleCmd() {
  const sub = args[1];
  const id = args[2] && !args[2].startsWith("--") ? args[2] : undefined;
  // One schedule-owning scope for a directory: its deployment (the directory
  // holding oats-local.yaml), resolved when a subcommand needs it — inside the
  // try, so no deployment in reach is a typed refusal (E_LOCAL_MISSING).
  let scope;
  const ws = () => (scope ??= scheduleScopeOf(dirFlag()));
  const io = { hostStatus: () => hostUnitStatus() };
  // The workspace automations of this deployment (the snapshot) placed on this host.
  let actx;
  const ctx = () => (actx ??= scopeAutomations(ws(), { io }));
  const isWorkspace = (qid) => A.splitId(qid).scope !== "local";
  const out = (result, text) => { if (JSON_MODE) jsonOk(result); else console.log(text ? text(result) : JSON.stringify(result, null, 2)); };
  const readSpec = () => {
    const inline = flag("spec-json");
    if (inline && inline !== true) { try { return JSON.parse(inline); } catch (e) { throw scheduleError("E_SCHEDULE_INVALID", `--spec-json is not valid JSON: ${e.message}`, { field: "file" }); } }
    const f = flag("file");
    if (!f || f === true) throw scheduleError("E_BAD_ARGS", "--file <spec.json> is required (a private JSON file with the definition)");
    if (!existsSync(f)) throw scheduleError("E_BAD_ARGS", `spec file not found: ${f}`);
    try { return JSON.parse(readFileSync(f, "utf8")); } catch (e) { throw scheduleError("E_SCHEDULE_INVALID", `${f} is not valid JSON: ${e.message}`, { field: "file" }); }
  };
  const needId = () => { if (!id) throw scheduleError("E_BAD_ARGS", `oats schedule ${sub} <id>`); return id; };
  try {
    switch (sub) {
      case "list": { const r = listSchedules(ws(), io, { ctx: ctx() }); out(r); if (!JSON_MODE && r.triggers.count) console.log(`${r.triggers.count} trigger${r.triggers.count === 1 ? " is" : "s are"} not listed here: ${r.triggers.command}`); return; }
      case "show": return out({ schedule: describeSchedule(ws(), needId(), io, { ctx: ctx() }) });
      case "test": return out({ test: testSchedule(ws(), needId(), io, { ctx: ctx() }) }, (r) => `${r.test.qualifiedId}: ${r.test.placement.runsHere ? "runs here" : `not here (${r.test.placement.reason ?? "disabled here"})`}${r.test.soul ? `; soul ${r.test.soul.name} ${r.test.soul.resolves ? "resolves" : `does NOT resolve (${r.test.soul.error?.code})`}` : ""}; next due ${r.test.nextDue ?? "never"}${r.test.problems.length ? `\n  ${r.test.problems.join("\n  ")}` : ""}\n(spawned nothing)`);
      case "add": {
        const spec = withDescription(readSpec(), descriptionFlag());
        if (flag("workspace") !== undefined) {
          const wid = id ?? spec.id;
          if (typeof wid !== "string") throw scheduleError("E_BAD_ARGS", "oats schedule add <id> --workspace <member> …: the id names the file (oats-schedules/<id>.yaml)");
          // A description is the file header's, never the body's.
          const { id: _i, enabled: _e, kind, description, ...rest } = spec; void _i; void _e;
          const r = await addWorkspaceAutomation(scheduleKind({ dep: ws() }), { id: wid, body: { run: kind ?? "spawn", ...rest }, description });
          return out(r, printWorkspaceAdd);
        }
        if (id && spec.id === undefined) spec.id = id;
        if (id && spec.id !== id) throw scheduleError("E_SCHEDULE_INVALID", `id ${JSON.stringify(spec.id)} in the file does not match ${JSON.stringify(id)}`, { field: "id" });
        return out({ schedule: addSchedule(ws(), spec, io) });
      }
      case "update": {
        const description = descriptionFlag();
        // --description alone (no --file/--spec-json) changes only the description.
        if (description !== undefined && flag("file") === undefined && flag("spec-json") === undefined) return out({ schedule: updateScheduleDescription(ws(), needId(), description, io) });
        return out({ schedule: updateSchedule(ws(), needId(), withDescription(readSpec(), description), io) });
      }
      case "enable":
      case "disable": {
        const on = sub === "enable";
        if (!isWorkspace(needId())) return out({ schedule: setScheduleEnabled(ws(), id, on, io) });
        describeSchedule(ws(), id, io, { ctx: ctx() }); // an unknown id is refused before the file changes
        setDisabledHereCli(ws(), "schedule", A.qualifiedId(id), on);
        actx = undefined;
        return out({ schedule: describeSchedule(ws(), id, io, { ctx: ctx() }) });
      }
      case "run": return out(runScheduleNow(ws(), needId(), { io, force: args.includes("--force"), ctx: ctx() }));
      case "remove": return out(removeSchedule(ws(), needId(), { force: args.includes("--force") }));
      case "reconcile": return out(reconcileSchedule(ws(), needId(), { io, clear: args.includes("--clear"), ctx: ctx() }));
      case "tick": {
        const dryRun = args.includes("--dry-run");
        // The minute the timer fired this tick for: this process's start, read before any work.
        const firedAt = new Date(Math.floor(performance.timeOrigin));
        if (args.includes("--host")) return out(tickHost({ firedAt, io, dryRun }));
        const reg = readRegistry();
        const tctx = scopeAutomations(ws(), { io, refresh: !dryRun });
        const considered = withHostLock(() => [...(tctx.refresh && !tctx.refresh.ok ? [{ workspace: ws(), action: "error", error: `automations refresh: ${tctx.refresh.error}` }] : []), ...tickWorkspace(ws(), { firedAt, io, reg, wsList: reg.workspaces.includes(ws()) ? reg.workspaces : [...reg.workspaces, ws()], dryRun, ctx: tctx }), ...tickTriggers(ws(), { io, dryRun, ctx: tctx, reg, wsList: reg.workspaces.includes(ws()) ? reg.workspaces : [...reg.workspaces, ws()] })]);
        return out({ tickedAt: new Date().toISOString(), considered, scheduler: schedulerStatus(ws(), io) });
      }
      case "host": {
        const op = args[2];
        const os = flag("os");
        if (os !== undefined && !(op === "install" && args.includes("--print"))) throw scheduleError("E_BAD_ARGS", "--os is for oats schedule host install --print");
        if (op === "install" && args.includes("--print")) {
          // What install would write, rendered from this environment; nothing is written or loaded.
          if (os !== undefined && os !== "darwin" && os !== "linux") throw scheduleError("E_BAD_ARGS", "--os darwin|linux");
          if (flag("max-concurrent") !== undefined || flag("triggers-max-concurrent") !== undefined) throw scheduleError("E_BAD_ARGS", "--print writes nothing: run install without --print to set a cap");
          const r = hostUnitFiles(os ? { os } : {});
          if (!JSON_MODE) for (const w of r.warnings) console.error(`warning: ${w}`);
          return out(r, (x) => Object.entries(x.files).map(([path, content]) => `==> ${path} <==\n${content}`).join("\n").replace(/\n$/, ""));
        }
        if (op === "install") {
          const cap = (name, reset) => {
            const occurrences = args.filter((arg) => arg === `--${name}`);
            if (occurrences.length > 1) throw scheduleError("E_BAD_ARGS", `use --${name} <N|${reset}> once`);
            const value = flag(name);
            if (value === undefined || value === reset) return value;
            if (typeof value !== "string" || !/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
              throw scheduleError("E_BAD_ARGS", `--${name} requires a positive safe integer or ${reset}`);
            }
            return Number(value);
          };
          const caps = { maxConcurrent: cap("max-concurrent", "default"), triggersMaxConcurrent: cap("triggers-max-concurrent", "none") };
          registerWorkspace(ws(), caps);
          const { warnings } = installHostUnit();
          return out({ scheduler: schedulerStatus(ws(), io), warnings });
        }
        if (op === "uninstall") { unregisterWorkspace(ws()); if (!readRegistry().workspaces.length) uninstallHostUnit(); return out({ scheduler: schedulerStatus(ws(), io) }); }
        if (op === "status") return out({ scheduler: schedulerStatus(ws(), io) });
        throw scheduleError("E_BAD_ARGS", "oats schedule host install [--print [--os darwin|linux]]|uninstall|status");
      }
      default: throw scheduleError("E_BAD_ARGS", "usage: oats schedule list|show <id>|test <id>|add <id> --file <spec.json> [--description=<text>] [--workspace <member> --runs-on <host> --owner <host>/<login>]|update <id> (--file <spec.json> [--description=<text>] | --description=<text>)|enable <id>|disable <id>|run <id> [--force]|remove <id> [--force]|reconcile <id> [--clear]|tick [--dry-run] [--host]|host install [--max-concurrent <N|default>] [--triggers-max-concurrent <N|none>] | host install --print [--os darwin|linux]|uninstall|status [--dir <workspace>|--server <id>] [--json]");
    }
  } catch (e) {
    // K8b: typed refusal details travel (identity mismatch: key/declared; a refused file: its integrity source).
    const details = { ...(e.details && typeof e.details === "object" ? e.details : {}), ...Object.fromEntries(["key", "declared", "source", "field"].filter((k) => e[k] !== undefined).map((k) => [k, e[k]])) };
    if (JSON_MODE) jsonFail(e.code || "E_SCHEDULE_FAILED", e.message, Object.keys(details).length ? details : undefined); else die(e.message);
  }
}

/** `oats trigger …` (lib/triggers.mjs): event-driven spawns stored beside the schedules of the
 *  deployment scope and evaluated by the same host tick. Every subcommand answers the envelope. */
async function triggerCmd() {
  const sub = args[1];
  const id = args[2] && !args[2].startsWith("--") ? args[2] : undefined;
  const T = await import("../lib/triggers.mjs");
  const { REFUSED_TEXT, safeText } = await import("../lib/refused-text.mjs");
  let scope;
  const ws = () => (scope ??= scheduleScopeOf(dirFlag()));
  // A stored definition that fails validation is still listed and shown, as it was written: what a
  // terminal gets of it never carries a refused character. In a row's text it is replaced (`shown`);
  // in the JSON `show` prints as text it is escaped (\uXXXX; the layout's own newlines stay), so the document's value is unchanged.
  const shown = (v, max) => safeText(typeof v === "string" ? v : JSON.stringify(v) ?? String(v), max);
  const escaped = (json) => json.replace(new RegExp(REFUSED_TEXT.source, "gu"), (c) => (c === "\n" ? c : Array.from({ length: c.length }, (_, i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, "0")}`).join("")));
  const out = (result, text) => { if (JSON_MODE) jsonOk(result); else console.log(text ? text(result) : escaped(JSON.stringify(result, null, 2))); };
  const needId = () => { if (!id) throw T.triggerError("E_BAD_ARGS", `oats trigger ${sub} <id>`); return id; };
  const usage = "usage: oats trigger add (--file <trigger.json> | --from <package>:<template> [--set <name>=<value>]… [--id <id>]) [--description=<text>] [--workspace <member> --runs-on <host> --owner <host>/<login>] | update <id> --description=<text> | list | show <id> | enable <id> | disable <id> | remove <id> | test <id> [--run-source] | poll <id> --run-source [--max-age <s>] | status [<id>]  [--dir <deployment>] [--json]   (<id>: local/<id> or <member>/<id>; --run-source: run a capability source's command on this host, which test and poll do only when asked)";
  const where = (t) => (t.origin?.kind === "workspace" ? (t.runsHere ? `runs here as ${t.owner}` : `${t.reason === "assigned-elsewhere" ? `runs on ${t.runsOn}` : t.reason ?? "disabled here"}`) : t.enabledHere ? "local" : "local, disabled");
  // A capability source names its params where the built-in names its repository.
  const watched = (on) => (T.isCapabilitySource(on?.source) ? `${on.source}${Object.keys(on.params || {}).length ? ` ${Object.entries(on.params).map(([k, v]) => `${shown(k, 40)}=${shown(v, 200)}`).join(" ")}` : ""}` : `${on?.source ?? "?"} ${on?.repo ?? "?"}`);
  // One row, one line, whatever an invalid stored definition holds (its id, labels and soul are as written too).
  const line = (t) => safeText(`${t.id}  ${where(t)}  ${watched(t.on)} [${T.isCapabilitySource(t.on?.source) ? shown((t.on?.events || []).join(","), 700) : (t.on?.events || []).join(",")}]${t.on?.labels?.length ? ` labels ${t.on.labels.join(",")}` : ""} every ${t.on?.poll ?? "?"} → spawn ${t.spawn?.soul ?? "?"}${t.spawn?.teams?.length ? ` in ${t.spawn.teams.join(",")}` : ""}${t.invalid ? `  INVALID: ${t.invalid.message}` : ""}`, 8000);
  // A source's own words are printed only under this label, never as the kernel's (docs/schedules.md).
  const said = (x) => (x ? `source says: ${x.code}${x.message ? `: ${x.message}` : ""}` : "");
  // The workspace automations of this deployment (the snapshot) placed on this host.
  let actx;
  const ctx = () => (actx ??= scopeAutomations(ws(), {}));
  const isWorkspace = (qid) => A.splitId(qid).scope !== "local";
  try {
    switch (sub) {
      case "list": return out(T.listTriggers(ws(), ctx(), { io: { hostStatus: () => hostUnitStatus() } }), (r) => r.triggers.length ? r.triggers.map(line).join("\n") : "(no triggers — oats trigger add --file <trigger.json> | --from <package>:<template>)");
      case "show": return out({ trigger: T.describeTrigger(ws(), needId(), ctx()) });
      case "enable":
      case "disable": {
        const on = sub === "enable";
        if (!isWorkspace(needId())) return out({ trigger: T.setTriggerEnabled(ws(), id, on, ctx()) }, (r) => line(r.trigger));
        T.describeTrigger(ws(), id, ctx()); // an unknown id is refused before the file changes
        setDisabledHereCli(ws(), "trigger", A.qualifiedId(id), on);
        actx = undefined;
        return out({ trigger: T.describeTrigger(ws(), id, ctx()) }, (r) => line(r.trigger));
      }
      case "update": {
        // Description only, for now (0.43.0): a full trigger update is remove + add.
        const known = new Set(["--description", "--dir", "--json"]);
        const other = args.slice(2).find((a) => a.startsWith("--") && !known.has(a));
        if (other) throw T.triggerError("E_BAD_ARGS", `oats trigger update: only --description is supported for now (got ${other}); to change anything else, remove the trigger and add it again`);
        const description = descriptionFlag();
        if (description === undefined) throw T.triggerError("E_BAD_ARGS", "oats trigger update <id> --description=<text> (--description= clears it)");
        return out({ trigger: T.updateTriggerDescription(ws(), needId(), description, ctx()) }, (r) => line(r.trigger));
      }
      case "remove": return out(T.removeTrigger(ws(), needId(), ctx()), (r) => `removed trigger ${r.removed}${r.live.length ? ` (its live instances keep running: ${r.live.join(", ")})` : ""}`);
      case "status": return out(T.triggerStatus(ws(), id, ctx()), (r) => r.triggers.map((t) => {
        if (!t.source) return `${t.id}  last poll ${t.lastPoll ? `${t.lastPoll.at} ${t.lastPoll.ok ? `ok (${t.lastPoll.matching}/${t.lastPoll.prs} PRs match)` : `FAILED: ${t.lastPoll.error}`}` : "never"}  pending ${t.pending.length}  fired ${t.firedTotal}  live ${t.live.map((l) => l.instance).join(",") || "none"}${t.lastError ? `\n    last error ${t.lastError.at}: ${t.lastError.message}` : ""}`;
        const lp = t.lastPoll;
        return [`${t.id}  source ${t.source.capability}:${t.source.name}  last poll ${lp ? `${lp.at} ${lp.ok ? `ok (${lp.events} events, ${lp.invalidEvents} invalid, ${lp.skipped} skipped, ${lp.filtered} filtered)` : `FAILED (${lp.cause ?? "?"}): ${lp.error}`}` : "never"}  pending ${t.pending.length}  fired ${t.firedTotal}  live ${t.live.map((l) => l.instance).join(",") || "none"}`,
          ...(t.invalid ? [`    INVALID ${t.invalid.at}: ${t.invalid.code}: ${t.invalid.message}`] : []),
          ...(lp && !lp.ok && lp.source ? [`    ${said(lp.source)}`] : []),
          ...t.invalidEvents.map((x) => `    invalid event (${x.rule}): ${x.text}`),
          ...t.skipped.map((x) => `    skipped ${x.subject}, source says: ${x.why}`),
          ...(t.lastError && !t.invalid ? [`    last error ${t.lastError.at}: ${t.lastError.message}`] : [])].join("\n");
      }).join("\n") || "(no triggers)");
      case "poll": {
        // Runs the capability's source command now (records nothing, spawns nothing), and so only with
        // --run-source: the caller's intent, never trust consent (the tick's child passes it). The tick's own
        // child gets OATS_TRIGGER_POLL_DEADLINE (epoch ms; internal between the tick and its child,
        // not a contract): its source gets only what is left before it (lib/triggers.mjs pollViaChild).
        const raw = process.env.OATS_TRIGGER_POLL_DEADLINE;
        const deadline = raw && /^\d+$/.test(raw) ? Number(raw) : null;
        const r = await T.pollSource(ws(), needId(), { ctx: ctx(), remoteOptions: remoteOptionsFromEnv(), deadline, runSource: args.includes(T.RUN_SOURCE_FLAG) });
        if (JSON_MODE) { jsonOk(withObservation(r)); return; }
        return out(r, (x) => [`trigger ${x.id}: ${x.source.capability}:${x.source.name} listed ${x.events.length} event(s) (nothing recorded, nothing spawned)`,
          ...x.events.map((ev) => `  ${ev.event} ${ev.subject}  ${ev.key}`),
          ...(x.filtered ? [`  ${x.filtered} filtered (events the trigger does not select)`] : []),
          ...x.invalidEvents.map((v) => `  invalid event (${v.rule}): ${v.text}`),
          ...x.skipped.map((k) => `  skipped ${k.subject}, source says: ${k.why}`)].join("\n"));
      }
      case "test": {
        let workspaceTeams = null;
        try {
          const { observeWorkspace } = await import("../lib/workspace.mjs");
          const { local } = loadLocal(ws());
          // The labels declared here: the committed shared teams and this deployment's local ones.
          const shared = typeof local.workspace === "string" && !local.standalone ? (await observeWorkspace(local.workspace, { remoteOptions: remoteOptionsFromEnv() })).workspace : null;
          workspaceTeams = [...teamModel(shared, local).labels.keys()];
        } catch { /* reported as unknown (null) */ }
        // --run-source: a capability source's command runs only when asked (inert for the built-in).
        const tested = await T.testTrigger(ws(), needId(), { workspaceTeams, ctx: ctx(), remoteOptions: remoteOptionsFromEnv(), runSource: args.includes(T.RUN_SOURCE_FLAG) });
        if (tested.source) return out(tested, (r) => [
          `trigger ${r.id}: ${r.ok ? "ready" : "NOT ready"} (${r.source.invalid || r.source.cause === "resolution" ? "the source did not run" : "the source ran"}; nothing was recorded or spawned)`,
          `  placement  ${r.placement.runsOn ? `runs on ${r.placement.runsOn} as ${r.placement.owner}; this host is ${r.placement.host ?? "(unnamed)"} — ${r.placement.runsHere ? "runs here" : r.placement.reason ?? "disabled here"}` : "local (this host)"}`,
          ...(r.gh ? [`  gh auth    ${r.gh.ok ? `ok — ${r.gh.account ?? "?"} via ${r.gh.credentialSource}` : `FAILED${r.gh.detail ? ` — ${r.gh.detail}` : ""}`}`] : []),
          `  source     ${r.source.capability}:${r.source.name} ${r.source.ok ? `listed ${r.source.events.length} event(s), ${r.source.invalidEvents.length} invalid, ${r.source.skipped.length} skipped, ${r.source.filtered} filtered` : r.source.invalid ? `INVALID: ${r.source.invalid.message}` : `FAILED (${r.source.cause ?? "?"}): ${r.source.error.message}`}`,
          ...(r.source.source ? [`             ${said(r.source.source)}`] : []),
          ...r.source.invalidEvents.map((v) => `  invalid    (${v.rule}) ${v.text}`),
          ...r.source.skipped.map((k) => `  skipped    ${k.subject}, source says: ${k.why}`),
          `  soul       ${r.soul.name} ${r.soul.resolves ? `resolves${r.soul.messaging ? ` (messaging ${r.soul.messaging})` : ""}` : `does NOT resolve: ${r.soul.error.code} ${r.soul.error.message}`}`,
          `  teams      ${r.teams.requested.join(", ") || "(none)"}${r.teams.undeclared?.length ? `  undeclared: ${r.teams.undeclared.join(", ")}` : ""}`,
          `  would fire ${r.wouldFire.length ? r.wouldFire.map((w) => `${w.event} ${w.subject}${w.instance ? ` as ${w.instance}` : ""}${w.held ? ` (held: ${w.held})` : ""}`).join(", ") : "nothing now"}`,
          ...r.problems.map((p) => `  problem    ${p}`),
          ...(r.warnings ?? []).map((w) => `  warning    ${w}`),
        ].join("\n"));
        return out(tested, (r) => [
          `trigger ${r.id}: ${r.ok ? "ready" : "NOT ready"} (nothing was spawned)`,
          `  placement  ${r.placement.runsOn ? `runs on ${r.placement.runsOn} as ${r.placement.owner}; this host is ${r.placement.host ?? "(unnamed)"} — ${r.placement.runsHere ? "runs here" : r.placement.reason ?? "disabled here"}` : "local (this host)"}`,
          `  gh auth    ${r.gh.ok ? `ok — ${r.gh.account ?? "?"} via ${r.gh.credentialSource}` : `FAILED${r.gh.detail ? ` — ${r.gh.detail}` : ""}`}`,
          `  repo       ${r.repo.key} ${r.repo.readable ? `readable; push ${r.repo.permissions.push} maintain ${r.repo.permissions.maintain} admin ${r.repo.permissions.admin}` : `NOT readable: ${r.repo.error}`}`,
          `  soul       ${r.soul.name} ${r.soul.resolves ? `resolves${r.soul.messaging ? ` (messaging ${r.soul.messaging})` : ""}` : `does NOT resolve: ${r.soul.error.code} ${r.soul.error.message}`}`,
          `  teams      ${r.teams.requested.join(", ") || "(none)"}${r.teams.undeclared?.length ? `  undeclared: ${r.teams.undeclared.join(", ")}` : ""}`,
          `  would fire ${r.wouldFire.length ? r.wouldFire.map((w) => `${w.event} #${w.number}${w.held ? ` (held: ${w.held})` : ""}`).join(", ") : "nothing now"}`,
          ...r.problems.map((p) => `  problem    ${p}`),
          ...(r.warnings ?? []).map((w) => `  warning    ${w}`),
        ].join("\n"));
      }
      case "add": {
        const file = flag("file"), from = flag("from");
        if ((file === undefined) === (from === undefined)) throw T.triggerError("E_BAD_ARGS", `oats trigger add needs exactly one of --file <trigger.json> or --from <package>:<template>\n${usage}`);
        const sets = {};
        for (let i = 0; i < args.length; i++) if (args[i] === "--set") {
          const kv = args[i + 1];
          if (typeof kv !== "string" || !kv.includes("=")) throw T.triggerError("E_BAD_ARGS", "--set needs <name>=<value>");
          sets[kv.slice(0, kv.indexOf("="))] = kv.slice(kv.indexOf("=") + 1); i++;
        }
        const idFlag = flag("id");
        if (idFlag === true) throw T.triggerError("E_BAD_ARGS", "--id needs a trigger id");
        const description = descriptionFlag();
        let spec;
        if (file !== undefined) {
          if (file === true || !existsSync(file)) throw T.triggerError("E_BAD_ARGS", `--file ${file === true ? "needs a path" : `not found: ${file}`}`);
          if (Object.keys(sets).length) throw T.triggerError("E_BAD_ARGS", "--set fills a package template's parameters; with --file, edit the file");
          try { spec = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw T.triggerError("E_TRIGGER_INVALID", `${file} is not valid JSON: ${e.message}`, { details: { field: "file" } }); }
          if (idFlag !== undefined) spec.id = idFlag;
        }
        if (flag("workspace") !== undefined) {
          // A workspace trigger (0.29.0): the file in the member, from/set when made from a template.
          const kinds = await automationKinds(ws(), readLock(ws()), remoteOptionsFromEnv());
          const wid = typeof idFlag === "string" ? idFlag : from !== undefined ? String(from).split(":")[1] : spec?.id;
          if (typeof wid !== "string") throw T.triggerError("E_BAD_ARGS", "--workspace: name the trigger with --id (or an id in the file)");
          // A description is the file header's (the flag, else the file's), never the body's; made
          // from a template without one, the row shows the template's.
          const body = from !== undefined ? { from: String(from), ...(Object.keys(sets).length ? { set: sets } : {}) } : (({ id: _i, kind: _k, enabled: _e, template: _t, createdAt: _c, updatedAt: _u, description: _d, ...rest }) => rest)(spec);
          const r = await addWorkspaceAutomation(kinds.trigger, { id: wid, body, description: description ?? spec?.description });
          return out(r, printWorkspaceAdd);
        }
        if (spec === undefined) spec = await triggerFromPackage(T, String(from), sets, idFlag);
        // A capability source's meaning needs the soul's resolution (asynchronous, so here, before the write).
        await T.checkAddMeaning(ws(), T.validateTrigger({ ...spec, kind: spec?.kind ?? "trigger" }), { remoteOptions: remoteOptionsFromEnv() });
        return out({ trigger: T.addTrigger(ws(), withDescription(spec, description)) }, (r) => `added ${line(r.trigger)}\n(\`oats trigger test ${r.trigger.id}${T.isCapabilitySource(r.trigger.on?.source) ? ` ${T.RUN_SOURCE_FLAG}\` runs ${r.trigger.on.source}'s source command on this host and checks the soul and the teams)` : "` checks gh, the repository, the soul and the teams on this host)"}`);
      }
      default: throw T.triggerError("E_BAD_ARGS", usage);
    }
  } catch (e) {
    const details = { ...(e.details && typeof e.details === "object" ? e.details : {}), ...(e.field !== undefined ? { field: e.field } : {}) };
    if (JSON_MODE) jsonFail(e.code || "E_TRIGGER_FAILED", e.message, Object.keys(details).length ? details : undefined); else die(e.message);
  }
}
/** A package trigger template (`triggers: [{ id, file }]` in the locked package's oats-package.json),
 *  read at the lock's commit and instantiated with the --set parameters. */
async function triggerFromPackage(T, from, sets, idFlag) {
  const { bindRemote } = await import("../lib/packages.mjs");
  return T.packageTriggerTemplate(readLock(scheduleScopeOf(dirFlag())), from, sets, { id: idFlag, remote: bindRemote(remoteModule, remoteOptionsFromEnv()) });
}

async function sessionCmd() {
  try {
    if (flag("native-record") !== undefined) throw Object.assign(new Error("--native-record outcome inspection is gone (the captured/portable path was removed in 0.26)"), { code: "E_BAD_ARGS" });
    const home = flag("home");
    let result;
    if (args[1] === "attach") {
      if (JSON_MODE) throw Object.assign(new Error("session attach is interactive; omit --json"), { code: "E_BAD_ARGS" });
      // --detach-key (feature session-attach-detach-key): the one key that leaves this viewer, with
      // status 20. Without it every key but the viewer's scrollback key reaches the agent and there is
      // no keyboard exit.
      // What earlier attaches left (a viewer whose attach died without detaching): one line, on
      // stderr, before the client takes the terminal, and only when something was removed.
      const onSwept = ({ sessions, tables }) => {
        const n = (count, what) => `${count} ${what}${count === 1 ? "" : "s"}`;
        if (sessions + tables > 0) console.error(`oats: removed ${n(sessions, "leftover viewer session")} and ${n(tables, "key table")} of earlier attaches`);
      };
      // --no-status-line (feature session-attach-no-status-line): a viewer without its status line,
      // the scroll keys, for a caller that shows them itself.
      process.exitCode = await attachInstanceSession(home, { detachKey: valueFlag("detach-key"), statusLine: !args.includes("--no-status-line"), onSwept });
      return;
    }
    if (args[1] === "resume") {
      // The machine sweep (feature session-resume, #1559): lib/session-resume.mjs. No --home: one home
      // is `session start --resume`.
      const usage = "usage: oats session resume [--deployment <dir>] [--plan] [--json]";
      for (let i = 2; i < args.length; i++) {
        const a = args[i];
        if (a === "--deployment") { i++; continue; }
        if (a.startsWith("--deployment=") || a === "--plan" || a === "--json") continue;
        throw Object.assign(new Error(a.startsWith("-") ? `oats session resume: unknown flag ${a}\n${usage}` : `oats session resume takes no argument ${JSON.stringify(a)}\n${usage}`), { code: "E_BAD_ARGS" });
      }
      const deployment = flag("deployment");
      if (deployment === true || (typeof deployment === "string" && !deployment.trim())) throw Object.assign(new Error(`--deployment needs a deployment directory\n${usage}`), { code: "E_BAD_ARGS" });
      const { resumeSessions } = await import("../lib/session-resume.mjs");
      const answer = await resumeSessions({ deployment, plan: args.includes("--plan"), kernel: { execPath: process.execPath, bin: CLI_BIN } });
      if (JSON_MODE) { jsonOk(answer); return; }
      for (const d of answer.deployments) console.log(`${d.deployment}: ${d.swept ? "swept" : `not swept (${d.reason}${d.code ? `, ${d.code}` : ""})`}`);
      for (const r of answer.rows) console.log(`  ${r.instance}  ${answer.plan ? "would be " : ""}${r.outcome}${r.reason ? ` (${r.reason}${r.code ? `, ${r.code}` : ""})` : ""}${r.message ? `: ${terminalText(r.message)}` : ""}`);
      if (!answer.rows.length) console.log("nothing to resume");
      return;
    }
    if (args[1] === "inspect") result = inspectInstanceSession(home);
    else if (args[1] === "recompose") throw Object.assign(new Error('unknown command "session recompose" — removed by the workspace model v2; use a re-spawn: an instance never changes under itself'), { code: "E_UNKNOWN_COMMAND" });
    else if (args[1] === "start" || args[1] === "restart") {
      const bad = (msg) => { throw Object.assign(new Error(msg), { code: "E_BAD_ARGS" }); };
      const model = flag("model");
      if (model === true) bad("--model needs a model id; omit it to keep the recorded model");
      const launchConfig = flag("launch-config");
      if (launchConfig === true) bad("--launch-config needs a configuration name, or none");
      const harness = harnessFlag();
      if (harness === true || (harness !== undefined && !LAUNCH_HARNESSES.includes(harness))) bad(`--harness must be one of ${LAUNCH_HARNESSES.join(", ")}`);
      // --reselect-launch (feature launch-preference): the home's launch layers decide again; without it a
      // recorded launch stays frozen (a changed preference never reaches an existing home on its own).
      const reselectLaunch = args.includes("--reselect-launch");
      if (reselectLaunch && launchConfig !== undefined) bad("--reselect-launch applies the launch preferences; --launch-config names one explicitly — choose one");
      // --resume (feature session-resume): the recorded launch as it is, in the home's last conversation;
      // refused with a launch choice before anything of the home is read.
      const resume = args.includes("--resume");
      if (resume) {
        if (args[1] === "restart") bad("--resume exists on session start only: it brings back a session that was lost");
        const chosen = ["--launch-config", "--harness", "--model", "--yolo", "--no-yolo", "--reselect-launch"].filter((f) => args.some((a) => a === f || a.startsWith(`${f}=`)));
        if (chosen.length) bad(`--resume runs the launch this home recorded; it cannot be combined with ${chosen.join(", ")}; nothing was read or started`);
      }
      // Refuse before launch selection or live-team discovery can prepare this home. Every start
      // reads it again under the home's lifecycle claim (lib/core.mjs startClaimed), so beside an
      // upgrade that runs (it holds the claim) the start is busy, not a partial upgrade: that one is
      // left to the claim. A resume is always refused under the claim.
      if (!resume && !upgradeHoldsClaim(home)) assertNoPartialUpgrade(home);
      const opts = { model: model || undefined, launchConfig, harness, yolo: yoloFlag(), ...(reselectLaunch ? { reselectLaunch: true, launchOffered: await homeLaunchOffered(home, { named: harness !== undefined }) } : {}), ...(resume ? { resume: true } : {}), env: process.env, ...(await homeLiveTeams(home)) };
      if (args[1] === "restart") {
        const grace = flag("stop-grace");
        if (grace !== undefined) { if (grace === true || !/^\d+$/.test(String(grace)) || Number(grace) < 1 || Number(grace) > 300) bad("--stop-grace needs a number of seconds (1..300) to wait for the harness after SIGTERM"); opts.stopGraceMs = Number(grace) * 1000; }
        result = restartInstanceSession(home, opts);
      } else result = startInstanceSession(home, opts);
    } else if (args[1] === "input") {
      const file = flag("text-file");
      if (file === true) throw Object.assign(new Error("--text-file needs a path"), { code: "E_BAD_ARGS" });
      if (!file && process.stdin.isTTY) throw Object.assign(new Error("provide --text-file or pipe input on stdin"), { code: "E_BAD_ARGS" });
      result = inputInstanceSession(home, readFileSync(file || 0, "utf8"));
    } else if (args[1] === "receive") {
      // Bytes arrive on stdin (the routed upload pipes them through ssh),
      // collected event-driven and bounded before anything is written.
      const name = flag("name");
      if (!name || name === true) throw Object.assign(new Error("session receive needs --name <file name>"), { code: "E_BAD_ARGS" });
      if (!home || home === true) throw Object.assign(new Error("session receive needs --home </absolute/instance>"), { code: "E_BAD_ARGS" });
      if (process.stdin.isTTY) throw Object.assign(new Error("session receive reads the attachment bytes from stdin"), { code: "E_BAD_ARGS" });
      result = receiveAttachment(home, name, await readStreamBounded(process.stdin, MAX_ATTACHMENT_BYTES));
    } else if (args[1] === "upload") {
      const file = flag("file");
      if (!file || file === true) throw Object.assign(new Error("session upload needs --file <local path>"), { code: "E_BAD_ARGS" });
      result = uploadAttachment({ file, home: home === true ? undefined : home });
    } else throw Object.assign(new Error("usage: oats session inspect|input|attach|start|restart|receive|upload --home /absolute/home [--text-file path] [--detach-key key] [--no-status-line] [--model id] [--launch-config name|none | --reselect-launch] [--harness pi|claude|codex] [--yolo|--no-yolo] [--stop-grace seconds] [--name file] [--file path] [--json]"), { code: "E_BAD_ARGS" });
    if (JSON_MODE) jsonOk(result);
    else {
      console.log(JSON.stringify(result, null, 2));
      // A start's launch-hook warnings, as spawn prints its own (stderr keeps stdout one JSON document).
      for (const w of result?.warnings || []) console.error(`  WARNING: ${terminalText(w)}`);
      if (result?.drift?.length) {
        const version = (v) => `${v.version ?? "?"} @ ${String(v.commit ?? "?").slice(0, 7)}`;
        const modules = result.drift.map((d) => `${d.capability} ${version(d.recorded)} → ${version(d.locked)}`).join(", ");
        console.error(terminalText(`${result.drift.length} package module(s) behind the lock (${modules}); to move them: oats instance stop ${shellQuote(result.instance)}; oats instance upgrade ${shellQuote(result.instance)} --plan`));
      }
    }
  } catch (e) { lifecycleFail(e, "E_SESSION_FAILED", e.details); }
}

async function paneCmd() {
  die("`oats pane` has been retired — the OATS Desktop app (packages/desktop) is the control panel now; in a terminal, `oats tui` (preview).");
}

/** `oats tui` (preview, docs/tui.md): the terminal client, shipped inside this package as
 *  packages/tui. It is interactive, so `--json` is refused here, before anything is loaded.
 *  This is the ONLY import of packages/tui in the kernel and the CLI, and it is dynamic: a broken
 *  TUI cannot break another word, and no other word pays for loading it (test/tui-boundary.test.mjs).
 *  packages/tui parses process.argv itself, so the word is spliced out first, as for the record. */
async function tuiCmd() {
  if (args.includes("--json")) return cmdFail("E_BAD_ARGS", "oats tui is interactive and has no --json form; `oats status --json` is the machine view");
  process.argv.splice(2, 1);
  await import(new URL("../packages/tui/bin/tui.mjs", import.meta.url));
}

/**
 * `oats deployments [list] | add [<dir>] | remove <path> | import --from desktop <path>...  [--json]`:
 * this computer's list of its deployments (lib/deployments.mjs; docs/workspaces.md "This computer's
 * deployments"). Runs anywhere, needs no deployment, never routes to another machine. `--via
 * tui|desktop` (add) is the clients' and is not in the usage.
 */
function deploymentsCmd() {
  const usage = "usage: oats deployments [list] | add [<dir>] | remove <path> | import --from desktop <path>...  [--json]";
  const fail = (code, message, details) => cmdFail(code, message, details);
  const positional = [];
  const values = {};
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") continue;
    if (a === "--server") return fail("E_BAD_ARGS", "oats deployments lists this computer's deployments: --server is not accepted");
    if (a === "--via" || a === "--from") {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) return fail("E_BAD_ARGS", `${a} needs a value\n${usage}`);
      if (values[a.slice(2)] !== undefined) return fail("E_BAD_ARGS", `${a} is given twice\n${usage}`);
      values[a.slice(2)] = v; i++; continue;
    }
    if (a.startsWith("--")) return fail("E_BAD_ARGS", `unknown flag ${a}\n${usage}`);
    positional.push(a);
  }
  const sub = positional.length ? positional.shift() : "list";
  if (!["list", "add", "remove", "import"].includes(sub)) return fail("E_BAD_ARGS", `unknown subcommand ${JSON.stringify(sub)}\n${usage}`);
  if (values.via !== undefined && sub !== "add") return fail("E_BAD_ARGS", `--via is for oats deployments add\n${usage}`);
  if (values.from !== undefined && sub !== "import") return fail("E_BAD_ARGS", `--from is for oats deployments import\n${usage}`);
  const run = (fn) => { try { return fn(); } catch (e) { if (typeof e?.code === "string" && e.code.startsWith("E_")) return fail(e.code, e.message, e.details); throw e; } };

  if (sub === "list") {
    if (positional.length) return fail("E_BAD_ARGS", usage);
    const result = run(() => listDeployments());
    if (JSON_MODE) return jsonOk(result);
    if (!result.deployments.length) {
      console.log(`no deployments listed (${shortPath(result.file)}): create one with \`oats onboard <dir> --workspace <ref>\`, or add one with \`oats deployments add <dir>\``);
      return;
    }
    const rows = [["PATH", "STATE", "VIA"], ...result.deployments.map((d) => [shortPath(d.path), d.state, d.via ?? ""])];
    const [pathWidth, stateWidth] = [0, 1].map((i) => Math.max(...rows.map((r) => r[i].length)));
    for (const r of rows) console.log(`${r[0].padEnd(pathWidth)}  ${r[1].padEnd(stateWidth)}  ${r[2]}`.trimEnd());
    return;
  }
  if (sub === "add") {
    if (positional.length > 1) return fail("E_BAD_ARGS", usage);
    if (values.via !== undefined && !CLIENT_VIA.includes(values.via)) return fail("E_BAD_ARGS", `--via takes ${CLIENT_VIA.join(" or ")}, got ${JSON.stringify(values.via)}`);
    const from = resolve(positional[0] ?? process.cwd());
    const found = deploymentAtOrAbove(from);
    if (!found) return fail("E_LOCAL_MISSING", `no oats-local.yaml at or above ${from}: it is not in a deployment (\`oats onboard <dir> --workspace <ref>\` creates one)`, { dir: from });
    const result = run(() => addDeployment(found, { via: values.via ?? "cli" }));
    if (JSON_MODE) return jsonOk(result);
    console.log(result.added ? `listed ${shortPath(result.path)}` : `${shortPath(result.path)} is already listed; nothing was changed`);
    return;
  }
  if (sub === "remove") {
    if (positional.length !== 1) return fail("E_BAD_ARGS", `oats deployments remove takes one path\n${usage}`);
    const result = run(() => removeDeployment(positional[0]));
    if (JSON_MODE) return jsonOk(result);
    console.log(result.removed ? `removed ${shortPath(result.path)} from this computer's list (nothing on disk was touched)` : `${shortPath(result.path)} is not listed; nothing was changed`);
    return;
  }
  // import
  if (values.from !== "desktop") return fail("E_BAD_ARGS", `oats deployments import needs --from desktop\n${usage}`);
  const result = run(() => importDesktopDeployments(positional));
  if (JSON_MODE) return jsonOk(result);
  console.log(result.imported ? `imported the Desktop's deployments: ${result.added.length} listed` : `the Desktop's deployments were imported already (${result.at}); nothing was changed`);
}

/** `oats onboard [<dir>] --workspace <repo ref> [--json]` — workspace model v2 (decision 9).
 *
 * Realizes a workspace on this machine in the directory the operator chooses
 * (docs/workspaces.md): writes
 * `<dir>/oats-local.yaml` naming the workspace, creates `<dir>/agents/` (the
 * instance homes), then runs exactly the `oats sync` path — discover over the
 * remotes, confirm membership, resolve `packages:`, write `oats-lock.json`. Nothing is installed, no soul
 * is created, nothing is spawned, no `oats-config.yaml` is written: the member
 * clones and the workspace's setup expert are the operator's next steps, printed here. */
async function onboardCmd() {
  const bail = (code, message, details) => (JSON_MODE ? jsonFail(code, message, details) : die(message));
  const usage = "usage: oats onboard [<dir>] --workspace <repo ref> [--json]   (or --dir <dir>)";
  let positional, workspaceRef, dirValue;
  const checkOnly = args.includes("--check");
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json" || arg === "--check") continue;
    if (arg === "--dir" || arg === "--workspace") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) return bail("E_BAD_ARGS", `--${arg.slice(2)} needs a value\n${usage}`);
      if (arg === "--dir") { if (dirValue !== undefined) return bail("E_BAD_ARGS", usage); dirValue = value; }
      else { if (workspaceRef !== undefined) return bail("E_BAD_ARGS", usage); workspaceRef = value; }
      i++; continue;
    }
    if (arg.startsWith("--")) return bail("E_BAD_ARGS", `unknown flag ${arg}\n${usage}`);
    if (positional !== undefined) return bail("E_BAD_ARGS", usage);
    positional = arg;
  }
  if (positional !== undefined && dirValue !== undefined) return bail("E_BAD_ARGS", `give the deployment directory once, as <dir> or --dir\n${usage}`);
  if (checkOnly) return onboardCheck(positional ?? dirValue, workspaceRef, bail);
  if (!workspaceRef || !workspaceRef.trim()) return bail("E_BAD_ARGS", `--workspace <repo ref> is required (the repository hosting oats-workspace.yaml)\n${usage}`);
  workspaceRef = workspaceRef.trim();
  // The ref must be one lib/remote.mjs understands BEFORE anything is written.
  try { remoteModule.parseRepoRef(workspaceRef); }
  catch (e) { return bail(e.code || "E_REPO_REF", e.message, e.details ?? e.provenance); }

  const dir = resolve(positional ?? dirValue ?? process.cwd());
  const localFile = join(dir, "oats-local.yaml");
  // (1) Refuse to onboard twice: THIS directory's oats-local.yaml is the mark (an enclosing
  // deployment's file does not count — a nested directory is a different deployment).
  let existing = null;
  try { existing = lstatSync(localFile); } catch (e) { if (e.code !== "ENOENT") return bail("E_ONBOARD_FAILED", `cannot inspect ${localFile}: ${e.message}`); }
  if (existing) return bail("E_ALREADY_ONBOARDED", `${shortPath(localFile)} already exists — this directory realizes a workspace; run \`oats sync --dir ${shortPath(dir)}\` to refresh it`, { local: localFile, dir });
  if (existsSync(dir) && !lstatSync(dir).isDirectory()) return bail("E_ONBOARD_FAILED", `${shortPath(dir)} exists and is not a directory`, { dir });

  // (2) The two files/dirs onboarding owns. Written atomically; rolled back if the sync
  // that follows cannot even read the workspace (a typo'd ref must not leave a
  // half-onboarded directory that looks finished).
  const created = [];
  try {
    if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); created.push(dir); }
    const local = { schemaVersion: 2, workspace: workspaceRef };
    writeFileAtomic(localFile, YAML.stringify(local));
    created.push(localFile);
    const agentsDir = join(dir, "agents");
    if (!existsSync(agentsDir)) { mkdirSync(agentsDir); created.push(agentsDir); }
  } catch (e) {
    rollback();
    return bail(e.code && String(e.code).startsWith("E_") ? e.code : "E_ONBOARD_FAILED", `cannot write ${shortPath(dir)}: ${e.message}`, { dir });
  }
  /** Only what THIS onboard created, only while still exactly ours: our local file, an EMPTY
   * agents/, an otherwise-empty <dir> (rmdirSync refuses a non-empty directory — evidence stays). */
  function rollback() {
    for (const p of [...created].reverse()) {
      try { if (p === localFile) rmSync(p, { force: true }); else rmdirSync(p); }
      catch { /* leave evidence rather than erase another writer's work */ }
    }
  }
  const bailRollback = (code, message, details) => { rollback(); return bail(code, message, { ...(details && typeof details === "object" ? details : {}), dir, rolledBack: true }); };

  // (3) Exactly the `oats sync` body over the deployment just written. A failure while
  // DISCOVERING (unreadable remote, not a workspace host) rolls the two files back; once the
  // workspace has been read, the files stay (a lock may already be written).
  let ctx;
  try {
    const found = loadLocal(dir);
    ctx = { dir, localPath: found.path, local: found.local, deploymentDir: dirname(found.path), remoteOptions: remoteOptionsFromEnv() };
  } catch (e) { return bailRollback(e.code || "E_LOCAL_MISSING", e.message, e.details); }
  let discovered = false;
  const syncBail = (code, message, details) => (discovered
    ? bail(code, message, { ...(details && typeof details === "object" ? details : {}), dir, local: localFile })
    : bailRollback(code, message, details));
  const synced = await performSync(ctx, syncBail, { onDiscovered: () => { discovered = true; } });

  // (4) The taught layout as next steps (design doc §4), and the envelope.
  const standalone = synced.discovery.standalone === true;
  const members = synced.report.members;
  // The setup expert is suggested only when THIS workspace lists one (setupExpertOf); otherwise
  // any listed soul is spawnable.
  const soulNames = synced.items.souls.map((s) => s.name);
  const { OPERATOR_CAPABILITY } = await import("../lib/operator-coverage.mjs");
  const wsName = standalone ? null : synced.discovery.workspace?.name;
  const conventional = typeof wsName === "string" && wsName ? `${wsName}-oats-setup-expert` : null;
  const chosenExpert = setupExpertOf(synced.discovery, { conventional, workspaceName: wsName, capability: OPERATOR_CAPABILITY });
  const setupExpert = chosenExpert?.soul ?? null;
  const spawnHint = setupExpert ? `oats spawn ${setupExpert} --dir ${shortPath(dir)}${chosenExpert.name ? ` --name ${chosenExpert.name}` : ""}` : null;
  const anySoulHint = `oats spawn <soul> --dir ${shortPath(dir)}${soulNames.length ? ` (e.g. ${soulNames.slice(0, 3).join(", ")})` : ""}`;
  // A member's clone goes beside oats-local.yaml under its repo name; `agents/` is the instance
  // homes, so a member called "agents" is cloned as `agents-repo/` (design doc §4). The HOST is
  // listed exactly like any other member when it is one: a clone of it is needed only if someone
  // works IN it — there is no special "workspace clone" (discovery reads the host over the remote).
  const cloneDirOf = (m) => join(dir, m.name === "agents" ? "agents-repo" : m.name);
  const clonePresent = (m, cloneDir) => {
    const declared = ctx.local?.clones && typeof ctx.local.clones === "object" ? Object.entries(ctx.local.clones).find(([written]) => sameRepo(written, m.key))?.[1] : undefined;
    const candidate = typeof declared === "string" && declared.trim() ? resolve(dir, declared) : cloneDir;
    return existsSync(join(candidate, ".git")) ? candidate : null;
  };
  const clones = members.filter((m) => m.confirmed || (standalone && m.key === synced.discovery.key)).map((m) => {
    const cloneDir = cloneDirOf(m);
    const present = clonePresent(m, cloneDir);
    return { key: m.key, name: m.name, url: memberUrlOf(synced.discovery, m.key), dir: present ?? cloneDir, present: present !== null, host: sameRepo(m.key, synced.discovery.key) };
  });
  // Decision 26: the host publishes the member list to whoever can read it. When the host is
  // itself a member (the common `agents` shape) that is fine for an all-private or all-public
  // organisation; a mixed one needs a private host that is NOT a public member. The kernel
  // cannot see forge visibility, so it states the rule rather than judging.
  const hostIsMember = members.some((m) => sameRepo(m.key, synced.discovery.key));
  const hosting = { host: synced.discovery.key, hostIsMember, rule: "If any member is private, host oats-workspace.yaml in a private repo that is not a public member (a dedicated <org>/workspace repo); public contributors then use the standalone case (from: here capabilities + oats.core)." };
  // This computer's deployments list gains what was created (awebai/oats#1390); a failed add never
  // fails the onboard, it is answered in `listed`.
  let listed = true;
  try { addDeployment(dir, { via: "onboard" }); }
  catch (e) { listed = { code: typeof e?.code === "string" && e.code.startsWith("E_") ? e.code : "E_DEPLOYMENTS_WRITE", message: String(e?.message ?? e) }; }
  const result = { onboardApi: 2, standalone: standalone || undefined, local: localFile, dir, agents: join(dir, "agents"), lock: synced.lockFile, sync: synced.report, hosting, next: { clone: clones, spawn: spawnHint, souls: soulNames.slice(0, 3) }, listed };
  if (JSON_MODE) { jsonOk(result); return; }
  if (listed !== true) console.error(`oats: ${shortPath(dir)} was onboarded, but not added to this computer's deployments list: ${listed.message}`);

  console.log(`Onboarded ${shortPath(dir)} into workspace ${workspaceName(synced.discovery)} (${synced.discovery.key} @ ${short(synced.discovery.commit)}).${standalone ? `\n  (${standaloneNote(synced.discovery, { from: " from here" })})` : ""}\n`);
  printSyncReport(ctx, synced);
  console.log(`
This directory (${shortPath(dir)}) is your deployment — any layout works; it now holds what the kernel needs:
  ├── oats-local.yaml     which workspace this machine realizes (+ host settings, disabled souls)
  ├── oats-lock.json      exact commit + integrity per package
  └── agents/             instance homes, each self-contained
Member clones live wherever you keep them (here, or anywhere named in oats-local.yaml clones:).

Next:
  1. Members you will work IN need a clone (discovery and resolution run over the remotes; only a
     soul's work target does):${clones.map((c) => c.present ? `\n       ${shortPath(c.dir)}  ✓ already here${c.host ? "  (the host — a member like the others)" : ""}` : `\n       git clone ${c.url ?? c.key} ${shortPath(c.dir)}   (or point oats-local.yaml clones: { ${c.key}: <abs path> } at an existing clone)${c.host ? "\n         ↑ the host is a member like the others: clone it only if someone works IN it — the workspace file is read over the remote" : ""}`).join("") || "\n       (no confirmed members yet — see the membership rows above)"}${!hostIsMember ? `\n       (the host ${synced.discovery.key} is not a member: nothing to clone — the workspace file is read over the remote)` : ""}
  2. Check who may read the host: ${synced.discovery.key}${hostIsMember ? " is itself a member" : " is a dedicated host"}. The workspace file
     names every member, so if any member is private the host must be a private repo that is not
     a public member; public contributors then get the standalone case (from: here + oats.core).
  3. ${setupExpert ? `Spawn ${setupExpert}, this workspace's OATS setup expert
     (it holds ${OPERATOR_CAPABILITY}), to guide the rest:` : `No soul here holds ${OPERATOR_CAPABILITY} — add a ${conventional ? `${conventional} soul` : "soul"} that declares it,
     or spawn any listed soul:`}
       ${spawnHint ?? anySoulHint}${chosenExpert?.why ? `\n       (${chosenExpert.why})` : ""}`);
}

/** The framework's package soul that sets up a workspace (awebai/oats#1665 D1). */
const FRAMEWORK_SETUP_SOUL = { package: "oats.framework", name: "oats-setup-expert" };

/** The soul `oats onboard` names as the workspace's OATS setup expert (awebai/oats#1314, #1665 D1), among
 *  the souls a spawn can name (soulCandidates) whose own soul.yaml declares `capability` (oats.setup) with
 *  `{ from: … }`, from any source (`off` is no declaration), in this order: the workspace's own soul named
 *  `conventional` (`<workspace name>-oats-setup-expert`, null in a standalone view, which has no workspace
 *  name); else oats.framework's package soul `oats-setup-expert`; else the first by name; else null. A soul
 *  is never chosen by its name alone. Only the soul's own declaration is read, never a resolution:
 *  oats.setup that reaches a soul through the workspace defaults alone is not seen.
 *  → null, or { soul, name, why }: `soul` is the name to spawn it by (the bare name, else
 *  `<member>/<soul>` (`<package>/<soul>`), else `<member repo key>/<soul>`, the first that names this soul
 *  alone); `name` is the instance name for the package soul (packageInstanceName), else null; `why` says
 *  why that name is not the conventional one, else null. */
function setupExpertOf(discovery, { conventional, workspaceName, capability }) {
  const candidates = soulCandidates(discovery);
  const declares = (entry) => {
    const caps = entry.definition?.capabilities;
    const choice = caps !== null && typeof caps === "object" && Object.hasOwn(caps, capability) ? caps[capability] : null;
    return choice !== null && typeof choice === "object" && typeof choice.from === "string" && choice.from !== "";
  };
  const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const entries = candidates.map((c) => c.entry).sort((a, b) => order(a.name, b.name) || order(qualifiedSoulName(a), qualifiedSoulName(b)));
  const isFrameworkSoul = (e) => e.package === FRAMEWORK_SETUP_SOUL.package && e.name === FRAMEWORK_SETUP_SOUL.name;
  const chosen = (conventional && entries.find((e) => e.name === conventional && typeof e.package !== "string" && declares(e)))
    || entries.find((e) => isFrameworkSoul(e) && declares(e))
    || entries.find(declares);
  if (!chosen) return null;
  // The shortest name a spawn resolves to exactly this soul: two members can share a repository
  // basename (github.com/a/agents, github.com/b/agents), so the last form is the full repo key.
  const forms = [chosen.name, qualifiedSoulName(chosen), ...(typeof chosen.package === "string" ? [] : [`${chosen.repoKey}/${chosen.name}`])];
  const only = (name) => { const hits = candidates.filter((c) => c.matches(name)); return hits.length === 1 && hits[0].entry === chosen; };
  const soul = forms.find(only) ?? forms[forms.length - 1];
  return { soul, ...(isFrameworkSoul(chosen) && workspaceName ? packageInstanceName(discovery, workspaceName) : { name: null, why: null }) };
}

/** The instance name the framework's setup soul is spawned by, for the workspace `workspaceName`:
 *  `<workspace>-oats-setup-expert`; `<workspace>-oats-setup` when a soul of this workspace already holds
 *  that name (spawn refuses an instance name that is a soul's); else none, and spawn names it. A name
 *  over the instance-name limit is none too: onboarding never refuses on a long workspace name.
 *  → { name, why }, `why` null for the conventional name. */
function packageInstanceName(discovery, workspaceName) {
  const souls = new Set();
  for (const m of discovery.members || []) for (const s of m.souls || []) if (typeof s?.name === "string") souls.add(s.name);
  for (const x of discovery.external || []) if (typeof x?.soul?.name === "string") souls.add(x.soul.name);
  for (const s of discovery.packageSouls || []) if (typeof s?.name === "string") souls.add(s.name);
  const conventional = `${workspaceName}-oats-setup-expert`, fallback = `${workspaceName}-oats-setup`;
  const shared = "and an instance may not share a soul's name";
  if (conventional.length > MAX_INSTANCE_NAME) return { name: null, why: `no --name: ${conventional} would be ${conventional.length} characters, over the ${MAX_INSTANCE_NAME}-character instance-name limit; spawn names it` };
  if (!souls.has(conventional)) return { name: conventional, why: null };
  if (!souls.has(fallback)) return { name: fallback, why: `named ${fallback}: this workspace has a soul named ${conventional}, ${shared}` };
  return { name: null, why: `no --name: this workspace has souls named ${conventional} and ${fallback}, ${shared}; spawn names it` };
}

/** `oats onboard <dir> [--workspace <ref>] --check`: what onboarding <dir> here would meet, read-only (the
 *  question `oats server connect` asks a host before onboarding there, and `oats server check` asks of a
 *  registered deployment). A leading ~ is this machine's home. `state` is absent | empty | not-empty |
 *  not-a-directory | deployment (oats-local.yaml there; its own workspace is read when --workspace is not
 *  given). `remote` is whether this machine's git reads the workspace remote: an unreadable one is part of
 *  the answer (readable false, with the error, its reason and any hint), never a failure of the check. */
async function onboardCheck(dirArg, workspaceRef, bail) {
  const raw = dirArg ?? process.cwd();
  const dir = raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : resolve(raw);
  let stat = null;
  try { stat = lstatSync(dir); } catch (e) { if (e.code !== "ENOENT") return bail("E_ONBOARD_FAILED", `cannot inspect ${dir}: ${e.message}`, { dir }); }
  const state = !stat ? "absent" : !stat.isDirectory() ? "not-a-directory" : existsSync(join(dir, "oats-local.yaml")) ? "deployment" : readdirSync(dir).length ? "not-empty" : "empty";
  let ref = workspaceRef?.trim();
  if (!ref && state === "deployment") {
    try { ref = loadLocal(dir).local.workspace; } catch (e) { return bail(e.code || "E_CONFIG_BROKEN", e.message, e.details); }
  }
  if (!ref) return bail("E_BAD_ARGS", `--workspace <repo ref> is required: ${dir} is not a deployment whose workspace could be read instead`, { dir, state });
  let parsed;
  try { parsed = remoteModule.parseRepoRef(ref); } catch (e) { return bail(e.code || "E_REPO_REF", e.message, e.details ?? e.provenance); }
  let remote;
  try { remote = { readable: true, commit: (await remoteModule.observeRemote(ref, remoteOptionsFromEnv())).commit }; }
  catch (e) {
    if (e?.code !== "E_REMOTE_UNREADABLE") throw e;
    const d = e.details || {};
    remote = { readable: false, error: { code: e.code, message: e.message, reason: d.reason ?? null, ...(d.hint ? { hint: d.hint, remedy: d.remedy } : {}) } };
  }
  const result = { check: true, dir, state, workspace: { ref, key: parsed.key, url: parsed.url }, remote };
  if (JSON_MODE) { jsonOk(result); return; }
  console.log(`${shortPath(dir)}: ${state}`);
  console.log(`workspace ${parsed.key}: ${remote.readable ? `readable (${short(remote.commit)})` : `NOT readable — ${remote.error.message}`}`);
}

/** The clone URL of a member row: what the remote observed (from the workspace's members: refs;
 *  standalone, the one repo oats-local.yaml named). */
function memberUrlOf(discovery, key) {
  for (const ref of discovery.workspace?.members || []) {
    try { const parsed = remoteModule.parseRepoRef(ref); if (sameRepo(parsed.key, key)) return parsed.url; } catch { /* schema already validated */ }
  }
  if (discovery.standalone === true && sameRepo(discovery.key, key)) return discovery.url ?? null;
  return null;
}

// ---------- capability command dispatch ----------
/**
 * oats <namespace> <command> [args…] — run a command an active capability
 * declares in its manifest (`commands: { name: "script args" }`).
 * Kernel subcommands take precedence over capability namespaces.
 *
 * Three contexts, one contract (OATS_CAPABILITY / OATS_SETTINGS / OATS_CLI_BIN):
 *   - inside an instance home: the home's materialized modules (instance.json.modules);
 *   - from a v2 DEPLOYMENT (oats-local.yaml in reach, no home): operator-level
 *     dispatch — resolve exactly as `oats spawn --soul <x>` would, fetch the
 *     namespace's capability into <deployment>/.oats/modules/<cap>@<commit12>/
 *     and run THAT copy with the soul's merged payload (lib/operator-dispatch.mjs;
 *     contracts doc, "Post-0.25.0 clarifications");
 *   - otherwise no namespace is active (the help fallthrough answers).
 */
async function capabilityCommand() {
  // JSON-aware boundary: in --json mode every dispatch failure — inactive or
  // untrusted capability, duplicate namespace, unknown subcommand, broken
  // metadata/manifests, malformed command values — must still emit exactly
  // one envelope object on stdout. The WHOLE dispatcher runs inside the
  // boundary; only "no namespace matched" escapes (returns false to the help
  // fallthrough).
  const bail = (code, msg, details) => (JSON_MODE ? jsonFail(code, msg, details) : die(msg));
  const NOT_DISPATCHED = Symbol("not-dispatched");
  let outcome;
  try { outcome = await dispatch(); }
  catch (e) {
    // Unexpected throw from discovery/trust/decoding: keep the envelope contract.
    bail("E_CAPABILITY_BROKEN", e.message || e);
    throw e;
  }
  return outcome !== NOT_DISPATCHED;

  /** Operator-level dispatch from a deployment directory (no instance home). */
  async function operatorDispatch() {
    let hit;
    try {
      const { resolveOperatorDispatch } = await import("../lib/operator-dispatch.mjs");
      let catalog = null; try { catalog = officialPackageCatalog(); } catch { /* the lock carries url for catalog packages */ }
      hit = await resolveOperatorDispatch(process.cwd(), cmd, flag("soul"), { remoteOptions: remoteOptionsFromEnv(), catalog });
    } catch (e) {
      if (typeof e?.code === "string" && e.code.startsWith("E_")) bail(e.code, e.message, e.details);
      throw e;
    }
    if (!hit) return NOT_DISPATCHED;
    // Without --soul the dispatch chose the soul (feature operator-default-soul): say which, on stderr,
    // so a provider's stdout (its --json envelope included) is untouched.
    if (hit.defaultSoul) process.stderr.write(`oats ${cmd}: using the settings and teams of soul ${hit.defaultSoul}, the first soul by name in this deployment that provides "${cmd}"; pass --soul <name> to use another\n`);
    // The same team/workspace facts a spawn hook receives (lead decision c3-7).
    const teamCtx = teamEnv(resolvedFromPrepared(hit.prepared, hit.deployment));
    // No home, so no recorded soul: OATS_SOUL is the soul's source at the resolved commit, read
    // as a spawn preview reads it (the per-commit copy a spawn left under the agents root, else a
    // temporary fetch removed when the command ends). Read only when the command runs (after its
    // --help). A soul that cannot be read refuses the command: it never runs with OATS_SOUL unset.
    // Its name and stable id are the ones a spawn of it records and hands its hooks (OATS_AGENT,
    // OATS_SOUL_ID): the agents-root name and the prepared entry's id, never the copy's path.
    const soul = async () => {
      const { previewWorkspaceSoul, agentDirOf } = await import("../lib/instance-resolution.mjs");
      const entry = hit.prepared?.soulEntry;
      const identity = entry ? { agent: agentDirOf(entry), id: preparedSoulIdOf(entry) } : {};
      try { const p = await previewWorkspaceSoul(hit.prepared, join(hit.deployment, "agents")); return { dir: p.soulDir, cleanup: p.cleanup, ...identity }; }
      catch (e) {
        throw Object.assign(new Error(`oats ${cmd}: cannot read soul ${flag("soul")} at ${String(entry?.commit ?? "?").slice(0, 12)}, so the command would run without OATS_SOUL; nothing was run: ${e.message}`),
          { code: typeof e?.code === "string" && e.code.startsWith("E_") ? e.code : "E_REMOTE_UNREADABLE", details: { soul: flag("soul"), repoKey: entry?.repoKey ?? null, commit: entry?.commit ?? null } });
      }
    };
    return runManifestCommand({ capability: hit.module.name, ...hit.manifest }, { settings: hit.settings, origins: hit.resolution?.payloadOrigins?.[hit.module.name] }, teamCtx, hit.ensureTree, soul);
  }

  async function dispatch() {
    let activeIds;
    let context = process.cwd();
    let teamCtx, homeMeta, homeTeamCtx;
    // OATS_INSTANCE_HOME is the identity; OATS_HOME still counts. With neither set (a harness that
    // strips the session env), the home enclosing the cwd. What chose the home is named in every
    // refusal about it.
    const homeVariable = ["OATS_INSTANCE_HOME", "OATS_HOME"].find((name) => process.env[name]);
    const instanceHome = homeVariable ? process.env[homeVariable] : enclosingInstanceHome(logicalCwd());
    const chosenBy = homeVariable ?? "the working directory";
    const metaFile = instanceHome && join(instanceHome, "instance.json");
    // Capability-id keyed — never answer for `constructor`/`toString`. Belt and
    // braces: the ids come from instance.json, which spawn wrote from resolved
    // manifests. Null-prototype because the dispatcher indexes it with the
    // namespace the operator typed on the command line.
    let capSettings = Object.create(null), capOrigins = Object.create(null);
    let deployment = null;
    let soulDir;
    try {
      if (metaFile && existsSync(metaFile)) {
        const meta = JSON.parse(readFileSync(metaFile, "utf8"));
        activeIds = (meta.capabilities || []).map((c) => c.id);
        for (const c of meta.capabilities || []) { capSettings[c.id] = c.settings || {}; capOrigins[c.id] = c.settingsOrigins || {}; }
        // Workspace-model homes only (lead decision c3 Q2).
        if (isCapturedHome(meta)) { const e = capturedHomeRefusal(instanceHome, "nothing was dispatched"); bail(e.code, e.message, e.details); }
        if (!isWorkspaceHome(meta)) { const e = preWorkspaceHome(instanceHome, "nothing was dispatched"); bail(e.code, e.message); }
        context = meta.repo || context;
        soulDir = instanceSoulDir(instanceHome, meta);
        const ws = meta.workspace && typeof meta.workspace === "object" ? meta.workspace : {};
        // Inside a home the namespace is the home's, so a --soul for another soul is refused, never
        // ignored (as inspect's --soul against --home is). The home's own soul, by any of its names, is fine.
        const soulFlag = flag("soul");
        if (soulFlag === true) bail("E_BAD_ARGS", "--soul needs a soul name", { flag: "--soul" });
        if (typeof soulFlag === "string" && !(await import("../lib/instance-resolution.mjs")).homeSoulMatches(soulFlag, meta)) {
          bail("E_HOME_MISMATCH", `--soul ${soulFlag} is not the soul of the instance home ${instanceHome} (${meta.agent}), which ${chosenBy} chose; to run "${cmd}" as a spawn of ${soulFlag} would, run it outside the instance home with OATS_INSTANCE_HOME and OATS_HOME unset`,
            { home: instanceHome, soul: meta.agent, chosenBy, flag: "--soul" });
        }
        // The team/workspace facts the home recorded at spawn, as its hooks got them, with the
        // recorded eligible teams (OATS_TEAMS_SOURCE=recorded). Only the home's MESSAGING module
        // gets them live (below): its team verbs (join/leave/teams) must see what the workspace
        // allows now, and no other command pays a remote read for them.
        const messaging = (meta.capabilities || []).find((c) => c.layer === "messaging")?.id;
        homeMeta = { meta, messaging };
        homeTeamCtx = (t) => teamEnv({ workspace: { key: ws.key, name: ws.name, deployment: ws.deployment }, teams: t.teams, defaultTeam: t.defaultTeam, teamsSource: t.source });
        teamCtx = homeTeamCtx({ ...recordedTeams(meta), source: "recorded" });
      } else {
        // Not inside a home: a v2 deployment (oats-local.yaml in reach) resolves
        // through the workspace, exactly as a spawn of --soul would (below).
        try { const { deploymentOf } = await import("../lib/operator-dispatch.mjs"); deployment = deploymentOf(context); }
        catch (e) { if (typeof e?.code === "string" && e.code.startsWith("E_")) bail(e.code, e.message, e.details); throw e; }
        // No home and no deployment in reach: no capability namespace is active.
        if (!deployment) return NOT_DISPATCHED;
      }
    } catch (e) { bail("E_CONFIG_BROKEN", e.message || e); throw e; }
    if (deployment) return operatorDispatch();
    // Workspace model: an instance's own materialized modules are the command
    // namespaces available to it (instance.json.modules → <home>/.oats/modules).
    const mans = Object.values(capabilityManifests(instanceHome)).filter((m) => m.command === cmd && m.commands);
    if (!mans.length) bail("E_UNKNOWN_COMMAND", `oats ${cmd}: no capability of the instance home ${instanceHome} (soul ${homeMeta.meta.agent}), which ${chosenBy} chose, provides "${cmd}"`, { home: instanceHome, chosenBy, namespace: cmd });
    if (mans.length > 1) bail("E_DUPLICATE_NAMESPACE", `duplicate operational command namespace "${cmd}": ${mans.map((m) => m.capability).join(", ")}`);
    const m = mans[0];
    if (!activeIds.includes(m.capability)) bail("E_CAPABILITY_INACTIVE", `${m.capability} command namespace is not active in the current context/instance`);
    const trust = capabilityTrust(m);
    if (!trust.trusted) bail("E_CAPABILITY_BLOCKED", `${m.capability} executable command is blocked: ${trust.reason}`);
    if (homeMeta && m.capability === homeMeta.messaging) {
      const { liveTeams } = await import("../lib/instance-resolution.mjs");
      let live;
      try { live = await liveTeams(instanceHome, homeMeta.meta, { remoteOptions: remoteOptionsFromEnv() }); }
      catch (e) { if (typeof e?.code === "string" && e.code.startsWith("E_")) return bail(e.code, e.message, e.details); throw e; }
      teamCtx = homeTeamCtx(live);
    }
    // The home's soul as its lifecycle hooks get it: the recorded name and stableSoulId's id.
    const agent = homeMeta.meta.agent;
    return runManifestCommand(m, { settings: capSettings[m.capability] || {}, origins: capOrigins[m.capability] }, teamCtx, () => m._dir,
      () => ({ dir: soulDir, cleanup: () => {}, agent, id: stableSoulId({ home: instanceHome, soulDir, agentName: agent }) }));
  }

  /** Help / unknown-command / spec validation / exec — shared by every context.
   *  `m` is the manifest (with `capability`; `_dir` may be absent until `ensureDir`
   *  resolves the directory holding the executable — the operator branch fetches
   *  the module tree only when a command is actually going to run). */
  async function runManifestCommand(m, { settings, origins }, teamCtx, ensureDir, soul) {
    const sub = args[1];
    const cmds = Object.keys(m.commands);
    // `oats <ns> --help` and `oats <ns> <cmd> --help` answer from the manifest
    // and never run the executable: the command's own help, if it has one,
    // is not worth a side effect (harvest --help once spawned a harvester).
    if (HELP_WORDS.has(sub) || args.slice(2).some((a) => a === "--help" || a === "-h")) {
      const known = sub && !HELP_WORDS.has(sub) && Object.prototype.hasOwnProperty.call(m.commands, sub);
      if (JSON_MODE) { jsonOk({ capability: m.capability, namespace: cmd, command: known ? sub : null, commands: cmds, description: m.description || null, help: "printed from the manifest; the executable was not run" }); return; }
      console.log(`oats ${cmd}${known ? ` ${sub}` : ""} — ${m.capability}${m.description ? `: ${m.description}` : ""}`);
      console.log(`  commands: ${cmds.join(", ") || "(none)"}`);
      console.log(`  (help printed from the manifest; the executable was not run)`);
      process.exit(0);
    }
    // Distinguish an ABSENT key from a declared-but-invalid value: a manifest
    // entry of "" / 0 / false / null is a broken capability, not an unknown
    // command (it is listed in cmds).
    if (!sub || !Object.prototype.hasOwnProperty.call(m.commands, sub)) {
      if (JSON_MODE) jsonFail("E_UNKNOWN_COMMAND", `oats ${cmd}: ${sub ? `unknown command "${sub}"` : "missing command"} — commands: ${cmds.join(", ") || "(none)"}`);
      console.error(`oats ${cmd} — commands: ${cmds.join(", ") || "(none)"}`);
      process.exit(sub ? 1 : 0);
    }
    // Command values come from third-party manifests — validate before decoding.
    const spec = m.commands[sub];
    if (typeof spec !== "string" || !spec.trim()) bail("E_CAPABILITY_BROKEN", `oats ${cmd} ${sub}: manifest command must be a non-empty string (got ${JSON.stringify(spec)})`);
    const [script, ...rest] = spec.trim().split(/\s+/);
    let dir;
    try { dir = await ensureDir(); }
    catch (e) { if (typeof e?.code === "string" && e.code.startsWith("E_")) bail(e.code, e.message, e.details); throw e; }
    const withDir = { ...m, _dir: dir };
    let abs;
    try { abs = capabilityExecutablePath(withDir, script); }
    catch (e) { bail("E_CAPABILITY_BROKEN", e.message); }
    if (!abs) bail("E_CAPABILITY_BROKEN", `${cmd} ${sub}: script not found (${join(dir, script)})`);
    // The soul the command acts for → { dir, cleanup, agent, id }: a home's recorded soul directory, or
    // (operator dispatch) the soul read at its resolved commit, whose temporary copy goes when this
    // process exits; with its name and stable id, as the soul's lifecycle hooks get them.
    let soulDir, soulAgent, soulId;
    try { const read = await soul(); soulDir = read.dir; soulAgent = read.agent; soulId = read.id; process.once("exit", read.cleanup); }
    catch (e) { if (typeof e?.code === "string" && e.code.startsWith("E_")) bail(e.code, e.message, e.details); throw e; }
    // OATS_SOUL, OATS_AGENT and OATS_SOUL_ID are this command's soul or nothing: an ambient value
    // inherited from the invoking process names some other soul (a coordinator's own), never this one.
    const { OATS_SOUL: _ambientSoul, OATS_AGENT: _ambientAgent, OATS_SOUL_ID: _ambientSoulId, ...inherited } = process.env;
    await readSession?.closeBatches(); // no idle `git cat-file --batch` child held for the provider's whole run
    const r = spawnSync("node", [abs, ...rest, ...rawArgs.slice(2)], { stdio: "inherit", env: {
      ...inherited, OATS_CAPABILITY: m.capability,
      // Package-runtime boundary: dispatched commands receive the active
      // capability's EFFECTIVE settings (instance snapshot, resolved context, or
      // the soul's merged payload on operator-level dispatch), same contract as
      // lifecycle hooks — capabilities read their settings here instead of
      // importing the kernel resolver.
      OATS_SETTINGS: JSON.stringify(settings || {}),
      // Where each leaf came from (JSON pointer → { kind, at }), as lifecycle hooks get it.
      OATS_SETTINGS_ORIGINS: JSON.stringify(origins || {}),
      // PATH is not a trusted runtime boundary (maintainer finding 1): pass the
      // canonical absolute executable of THIS CLI; official consumers execFile
      // it directly and never resolve `oats` from PATH or a shell.
      OATS_CLI_BIN: CLI_BIN,
      // The node a command writes into anything that outlives it (lib/stable-node.mjs).
      OATS_NODE_BIN: kernelNode().node,
      ...teamEnv(null), ...(teamCtx || {}),
      // The soul the command acts for (an instance home's recorded soul directory):
      // homes carry no soul link, so providers read it here.
      ...(soulDir ? { OATS_SOUL: soulDir } : {}),
      // Its name and stable identity, the values its hooks get: what a provider keys durable state
      // on (OATS_SOUL is a per-commit or temporary copy, so never a key).
      ...(typeof soulAgent === "string" && soulAgent ? { OATS_AGENT: soulAgent } : {}),
      ...(typeof soulId === "string" && soulId ? { OATS_SOUL_ID: soulId } : {}),
    } });
    // Child never ran (spawn error): nothing reached stdout — keep the envelope contract.
    if (r.error) bail("E_CAPABILITY_BROKEN", `oats ${cmd} ${sub}: ${r.error.message || r.error}`);
    // A provider killed by a signal (a Ctrl-C reaches both it and us; our read session's handler
    // waits for spawnSync) exits as the shell reports a signal death: 128 + its number.
    process.exit(r.status ?? (r.signal ? 128 + (osConstants.signals[r.signal] ?? 0) : 1));
  }
}


// ---------- update ----------
function updateCmd() {
  const checkOnly = args.includes("--check");
  // The deployment whose launch configurations name pi folders: at or above the working
  // directory, or --dir. Without one, or with one that does not load, the update still runs on
  // the default folder and this shell's, and says so first and last: an operator reads the end.
  let deployment = null, launchConfigs = {}, notLookedAt = null;
  try { deployment = dirname(loadLocal(dirFlag()).path); launchConfigs = launchConfigsAt(deployment); }
  catch (e) {
    // An explicit --dir with no deployment at or above it is refused, a 0.25 configuration there included.
    if (e?.code === "E_LOCAL_MISSING" && flag("dir") !== undefined) die(e.message);
    if (e?.code !== "E_LOCAL_MISSING" || e.details?.legacy) notLookedAt = `No launch configuration was looked at: ${deployment ? `the launch configurations of ${deployment} do` : "the deployment does"} not load (${e.message}). Run \`oats doctor\` there, then \`oats update\` again.`;
    else notLookedAt = `No launch configuration was looked at: no deployment at or above ${process.cwd()}. Run \`oats update\` in each deployment, or with --dir <deployment>.`;
    launchConfigs = {};
  }
  const end = (text) => { console.log(text); if (notLookedAt) console.log(`\n${notLookedAt}`); };
  const fail = (text) => die(notLookedAt ? `${text}\n${notLookedAt}` : text);
  // What npm printed is checked to be one version before it reaches a step, an argument or the
  // screen (awebai/oats#1011). Both streams are captured: spawnSync forwards neither.
  const asked = kernelLookup();
  const { version: latest, problem: notChecked } = kernelLookupResult(spawnSync(asked[0], asked.slice(1), { encoding: "utf8", timeout: 30000 }));
  if (notChecked) fail(notChecked);
  console.log(`${OATS_PACKAGE_NAME}  installed: ${OATS_VERSION}  latest: ${latest}`);
  // Forward only: the CLI moves to a newer version of the registry, never back to an older one.
  // `target` is the version the kernel has after the run, which the bridges are brought to.
  const cli = planCliUpdate(OATS_VERSION, latest), { target } = cli;
  if (cli.note) console.log(cli.note);
  // The pi bridge, in every pi folder a launch of the deployment uses (lib/pi-bridge.mjs).
  const plan = planPiBridges(piBridgeFolders({ launchConfigs }), target);
  console.log(`\n${PI_BRIDGE} ${target} (published in lockstep), by pi folder${deployment && !notLookedAt ? ` of ${deployment}` : ""}:`);
  for (const line of piBridgePlanLines(plan, cli)) console.log(line);
  if (notLookedAt) console.log(`  ${notLookedAt}`);
  const moves = plan.filter((entry) => entry.step);
  const untouched = plan.filter((entry) => entry.action === "skip").length;
  const untouchedNote = untouched ? ` ${untouched} pi folder${untouched > 1 ? "s were" : " was"} not touched: see above for what to run there.` : "";
  const steps = [...(cli.step ? [cli.step] : []), ...moves.map((entry) => ({ ...entry.step, entry }))];
  // "Up to date" is not said over a folder it does not touch, nor over a CLI or a bridge ahead.
  const ahead = cli.ahead || plan.some((entry) => entry.ahead);
  if (!steps.length) return end(untouched || ahead ? `\nNothing for \`oats update\` to run.${untouchedNote}` : "\nUp to date.");
  console.log("\nUpdate steps:");
  for (const s of steps) console.log(`  ${s.display}`);
  // A Desktop refuses a CLI of a newer minor (docs/upgrading.md, "Why the Desktop goes first").
  const desktopFirst = desktopFirstLine(cli);
  if (desktopFirst) console.log(`\n${desktopFirst}`);
  if (checkOnly) return end("\n(--check: not executing)");
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  if (interactive) {
    process.stdout.write("\nRun these now? [y/N] ");
    const buf = Buffer.alloc(16);
    let answer = "";
    try { answer = buf.toString("utf8", 0, readSync(0, buf, 0, 16)).trim().toLowerCase(); } catch { /* no input */ }
    if (answer !== "y" && answer !== "yes") return end("Not updating.");
  } else if (!args.includes("--yes")) return end("\nNon-interactive: pass --yes to execute, or run the steps yourself.");
  // Before any step, the CLI's included: the bridge's exact version is seen on the registry by a
  // lookup that revalidates npm's cache (awebai/oats#852). A version is listed a while after it
  // is published, and the kernel's "latest" says nothing about the bridge's.
  if (moves.length) {
    const lookup = bridgeLookup(target);
    console.log(`\n$ ${lookup.join(" ")}`);
    const notSeen = bridgeLookupProblem(spawnSync(lookup[0], lookup.slice(1), { encoding: "utf8", timeout: 30000 }), cli);
    if (notSeen) fail(notSeen);
  }
  for (const [i, s] of steps.entries()) {
    console.log(`\n$ ${s.display}`);
    const r = spawnSync(s.argv[0], s.argv.slice(1), { stdio: "inherit", env: { ...process.env, ...s.env } });
    const ran = r.error ? `${s.argv[0]}: ${r.error.message}` : r.status !== 0 ? (r.signal ? `killed by ${r.signal}` : `exit ${r.status}`) : null;
    const problem = s.entry ? piBridgeStepProblem(s.entry, target, ran) : ran;
    if (problem) fail(piBridgeFailure({ entry: s.entry, display: s.display, problem, notReached: steps.slice(i + 1).filter((next) => next.entry).map((next) => next.entry) }));
  }
  end(`\nUpdated to ${target}.${untouchedNote} Now verify each deployment: run \`oats doctor\` at your workspace/repo scopes — it reports config spellings this version rejects, version skew, and missing requirements. Restart running pi sessions to pick up the new bridge.`);
}

// ---------- version (Desktop CLI API v1 probe) ----------
/** `oats reader --stdio`: the warm reader (lib/reader.mjs), a client's child that answers status and workspace
 *  status on its stdin and stdout until the client ends it. */
async function readerCmd() {
  if (args.length !== 2 || args[1] !== "--stdio") return cmdFail("E_USAGE", "usage: oats reader --stdio (the warm reader: a client's child process that answers status and workspace status reads on stdin and stdout; docs/desktop-cli-api.md \"The warm reader\")");
  const { runReader } = await import("../lib/reader.mjs");
  await runReader({ stamp: READER_STAMP });
}

function versionCmd() {
  if (JSON_MODE) {
    // EXACT Desktop API v1 probe payload — one JSON object, nothing else on
    // stdout. Desktop accepts desktopApi === 1 and a compatible semver range.
    // `remote`: this kernel's remote-side surface: the commands it routes to
    // a registered server with --server, plus `roster` (the local command
    // over registrations and saved routes); a Desktop gates its remote path
    // on it (an older CLI without the surface must fail closed with a
    // reason, not an argument error). `features`: kernel abilities a peer
    // must see before relying on them (retire-home: retire --home).
    // Phase B: `instance-modules` and `spawn-provider-payload` are advertised only once spawn
    // runs on resolve/materialize (contract §6); a feature the binary does not implement is
    // never listed.
    console.log(JSON.stringify({ schemaVersion: 1, name: "@awebai/oats", version: OATS_VERSION, desktopApi: 1, harnesses: ["pi", "claude", "codex"], sessionBackends: ["tmux"], launchOptions: ["yolo"], remote: ["spawn", "retire", "status", "session", "session-start", "session-restart", "launch-config", "roster", "harvest", "schedule", "session-upload", "operations", "readiness", "instance-events", "instance-git", "lifecycle-plans"], features: KERNEL_FEATURES, automationsApi: A.AUTOMATIONS_API, workspaceApi: 2, instanceGitApi: 1, spawnApplyApi: 1, soulsApi: 2, lifecycleApi: 1, readinessApi: 2, spawnPreviewApi: 2, eventsApi: 2, scheduleHistoryApi: 3, scheduleApi: SCHEDULE_API, operationsApi: 2, capabilityShowApi: 1, readerApi: READER_API, sessionViewer: readSessionViewer(), package: OATS_PACKAGE_NAME }));
    return;
  }
  console.log(`${OATS_PACKAGE_NAME} ${OATS_VERSION} (desktop API v1)`);
}

// ---------- the record (core) and experimental tools over it ----------
// The turn record is the core: capture, recall, setup are kernel-level
// subcommands, dispatched to packages/record (shipped inside this package —
// see "files" in package.json). The record bins parse process.argv.slice(2)
// themselves, so the consumed subcommand words are spliced out first.
// Everything that selects or synthesizes over the record (dress, spawn,
// segments, mind) is EXPERIMENTAL and ships only in the oats repo checkout,
// under packages/experimental — absent from the published tarball on
// purpose, so its presence is exactly its status.
const EXPERIMENTAL_CMDS = new Set(["dress", "spawn", "segments", "mind"]);
async function recordCmd(sub) {
  process.argv.splice(2, 1);
  if (sub === "setup") {
    // setup writes a node into the user's Claude settings and into the capture service's unit,
    // and nothing rewrites them but setup run again: it is handed the rule's answer for the node
    // running this kernel (docs/capabilities.md, "The node a hook writes down"). The script is
    // imported into this process, so the variable is set here, over whatever the caller's
    // environment held; packages/record imports nothing of the kernel.
    const { node, warning } = stableNode({ consequence: "the capture hooks and the capture service stop when it goes away", remedy: "run `oats setup` again" });
    if (warning) console.error(`oats: warning: ${warning}`);
    process.env.OATS_NODE_BIN = node;
  }
  await import(new URL(`../packages/record/bin/${sub}.mjs`, import.meta.url));
}
async function experimentalCmd() {
  const sub = args[1];
  if (!sub || !EXPERIMENTAL_CMDS.has(sub)) {
    console.error(
      "usage: oats experimental <dress|spawn|segments|mind> [options]\n" +
        "EXPERIMENTAL tools over the turn record — unproven by design; see packages/experimental/README.md",
    );
    process.exit(sub === undefined ? 0 : 2);
  }
  const url = new URL(`../packages/experimental/bin/${sub}.mjs`, import.meta.url);
  if (!existsSync(url)) {
    die(
      `experimental tools ship only in the oats repo checkout, not in the published package — clone github.com/awebai/oats and run \`oats experimental ${sub}\` from it`,
    );
  }
  process.argv.splice(2, 2);
  await import(url);
}

// ---------- servers: registry and remote routing (docs/execution-targets.md) ----------
/** `oats server add|list|remove|check`. A registration is where and how:
 *  an OpenSSH host alias, the remote workspace, the remote oats path. Keys
 *  and passwords never enter it; ssh owns those. */
async function serverCmd() {
  const bail = (code, msg, details) => (JSON_MODE ? jsonFail(code, msg, details) : die(msg));
  const sub = args[1];
  const usage = "usage: oats server add <id> --ssh <host-alias> --workspace </abs/path> [--oats <path>] [--path <dir:dir>] [--label <text>] [--replace] | connect <id> --ssh <host-alias> [--workspace-ref <ref>] [--dir </abs/path or ~/path on the host>] [--oats <path>] [--path <dir:dir>] [--label <text>] [--install-oats] [--replace] | list [--workspace-ref <ref>] | remove <id> | check <id> | roster [--server <id>] [--workspace-key <key>]... | forget <id> --instance <name>  [--json]";
  if (!["add", "connect", "list", "remove", "check", "roster", "forget"].includes(sub)) bail("E_USAGE", usage);
  if (sub === "connect") return serverConnectCmd(bail);
  if (sub === "forget") {
    // A saved route whose remote instance is gone can be dropped only by
    // the operator: nothing routed can do it, and the changed-registration
    // guard counts it until then.
    const id = args[2];
    const inst = flag("instance");
    if (!id || id.startsWith("--") || !inst || inst === true) bail("E_USAGE", "usage: oats server forget <id> --instance <name> [--json]");
    let snap;
    try { snap = forgetSnapshot(id, inst); } catch (e) { bail(e.code || "E_SNAPSHOT_UNKNOWN", e.message); }
    if (JSON_MODE) { jsonOk({ server: id, instance: inst, home: snap.home, target: snap.target, forgotten: true }); return; }
    console.log(`Forgot the saved route of ${inst} through ${id} (${snap.target?.sshHost}:${snap.home}).`);
    console.log(`  if that home still exists on the host it is no longer managed from here: retire it there with oats retire ${inst} --home ${snap.home}`);
    return;
  }
  if (sub === "roster") {
    // The remote roster for the Desktop and operators: grouped by saved route
    // target, one bounded status pull per target, all at once, saved routes as the action
    // authority. --server narrows to one registry id; --workspace-key (repeatable, every occurrence
    // counts) to the groups that can belong to those workspaces (lib/servers.mjs rosterGroups).
    const only = flag("server") === true ? bail("E_BAD_ARGS", "--server needs a registered server id") : flag("server");
    const ms = (name) => { const v = flag(name); if (v === undefined) return undefined; const n = Number(v); if (!Number.isInteger(n) || n < 1000) bail("E_BAD_ARGS", `--${name} takes whole milliseconds, at least 1000`); return n; };
    let workspaceKeys;
    for (let i = 0; i < args.length; i++) if (args[i] === "--workspace-key") {
      const v = args[i + 1];
      if (!v || v.startsWith("--")) bail("E_BAD_ARGS", "--workspace-key needs a workspace key (as a host's oats status --json workspace.key reports it)");
      (workspaceKeys ||= []).push(v);
      i++;
    }
    let out;
    try { out = await rosterGroups({ server: only, workspaceKeys, io: { budgetMs: ms("budget"), perTargetTimeoutMs: ms("per-target") } }); } catch (e) { bail(e.code || "E_SERVERS_UNREADABLE", e.message); }
    if (JSON_MODE) { jsonOk(out); return; }
    if (!out.groups.length) { console.log(workspaceKeys ? "no remote groups for the given workspace keys" : "no remote groups: no registrations and no saved routes"); return; }
    for (const g of out.groups) {
      console.log(`  ${g.server}${g.label && g.label !== g.server ? `  ${g.label}` : ""}  [${g.id}]  ssh ${g.target.sshHost}  workspace ${g.target.workspace}${g.registrationPresent ? "" : "  (registration removed or changed; saved routes only)"}`);
      console.log(g.probe?.ok ? `      reachable, ${g.souls.length} soul(s)` : `      UNREACHABLE: ${g.probe?.error?.message || "?"}`);
      for (const i of g.instances) {
        console.log(`      • ${i.instance}${i.background === true ? " [background]" : ""}  ${i.missingRemotely ? "GONE on the host (saved route is stale: oats server forget)" : livenessWord(i)}${i.retirePending ? " RETIRING" : ""}${i.rollbackIncomplete ? " QUARANTINED" : ""}${i.savedRoute ? "" : "  (observed only, no saved route)"}${i.runtimeError ? `  ${i.runtimeError}` : ""}`);
        const lost = lostLine(i, { host: g.target.sshHost || g.server }); if (lost) console.log(`          ${lost}`);
      }
      for (const f of g.retireFailures || []) console.log(`      ! deferred retirement of ${f.instance} (${f.agent}) FAILED there${f.error?.message ? `: ${f.error.message}` : ""}${f.retry ? ` — retry on the host: ${f.retry}` : ""}`);
    }
    console.log(`  bounds: ${out.bounds.perTargetTimeoutMs} ms per target within ${out.bounds.budgetMs} ms, ${out.bounds.elapsedMs} ms used`);
    return;
  }
  let servers;
  try { servers = readServers(); } catch (e) { bail(e.code || "E_SERVERS_UNREADABLE", e.message); }
  if (sub === "list") {
    let rows = Object.entries(servers).map(([id, s]) => ({ id, ...s, workspaceKey: s.workspaceKey ?? null, target: targetOf({ id, ...s }), snapshots: listSnapshots(id).length }));
    // --workspace-ref: the servers of one workspace, by canonical key, and the ids whose workspace is not known yet.
    let unknownWorkspace;
    if (flag("workspace-ref") !== undefined) {
      const ref = flag("workspace-ref");
      if (ref === true) bail("E_BAD_ARGS", "--workspace-ref needs a workspace repository reference");
      let key;
      try { key = remoteModule.parseRepoRef(ref).key; } catch (e) { bail(e.code || "E_REPO_REF", e.message, e.details); }
      unknownWorkspace = rows.filter((r) => r.workspaceKey === null).map((r) => r.id);
      rows = rows.filter((r) => sameRepo(r.workspaceKey, key));
    }
    if (JSON_MODE) { jsonOk({ file: SERVERS_FILE(), servers: rows, ...(unknownWorkspace ? { unknownWorkspace } : {}) }); return; }
    if (unknownWorkspace?.length) console.log(`  (workspace not known yet for ${unknownWorkspace.join(", ")}: oats server check <id> learns it)`);
    if (!rows.length) { console.log(`no servers registered (${shortPath(SERVERS_FILE())}) — add one with \`oats server add <id> --ssh <alias> --workspace </path>\``); return; }
    for (const r of rows) console.log(`  ${r.id}${r.label ? `  ${r.label}` : ""}${r.workspaceKey ? `  [${r.workspaceKey}]` : ""}\n      ssh ${r.sshHost}  workspace ${r.workspace}  oats ${r.target.oatsPath}${r.snapshots ? `  (${r.snapshots} remote instance${r.snapshots === 1 ? "" : "s"} spawned from here)` : ""}`);
    return;
  }
  const id = args[2];
  if (!id || id.startsWith("--")) bail("E_USAGE", usage);
  if (sub === "add") {
    const val = (name) => { const v = flag(name); return v === true ? bail("E_BAD_ARGS", `--${name} needs a value`) : v; };
    if (flag("herdr") !== undefined) { const e = herdrSettingRemoved("server add --herdr was given"); bail(e.code, e.message); }
    const entry = { sshHost: val("ssh"), workspace: val("workspace") };
    for (const [k, f] of [["oatsPath", "oats"], ["path", "path"], ["label", "label"]]) { const v = val(f); if (v !== undefined) entry[k] = v; }
    if (!entry.sshHost || !entry.workspace) bail("E_USAGE", usage);
    try { validateServer(id, entry); } catch (e) { bail(e.code, e.message); }
    try {
      updateServers((current) => {
        if (current[id] && !args.includes("--replace")) throw Object.assign(new Error(`server ${id} is already registered (pass --replace to overwrite; existing remote instances keep the route they were spawned with)`), { code: "E_SERVER_EXISTS" });
        current[id] = entry;
      });
    } catch (e) { bail(e.code || "E_SERVERS_UNREADABLE", e.message); }
    // The workspace key is learned from the host, never typed: recorded when the host answers one and
    // the registration is still this one (it may change while the host is asked).
    const warnings = [];
    try {
      const { key, why } = reportedWorkspaceKey(targetOf(entry), { serverId: id, timeoutMs: 60000 });
      if (!key) warnings.push(`workspace key unknown: ${why}; oats server check ${id} learns it once the host answers one`);
      else if (learnWorkspaceKey(id, entry, key) === "recorded") entry.workspaceKey = key;
      else warnings.push(`workspace key not recorded: registration ${id} changed while the host was asked; oats server check ${id} learns it`);
    } catch (e) { warnings.push(`workspace key unknown: ${e.message}; oats server check ${id} learns it once the host answers`); }
    if (JSON_MODE) { jsonOk({ id, ...entry, workspaceKey: entry.workspaceKey ?? null, file: SERVERS_FILE(), ...(warnings.length ? { warnings } : {}) }); return; }
    console.log(`Registered server ${id} → ssh ${entry.sshHost}, workspace ${entry.workspace}${entry.workspaceKey ? ` (workspace ${entry.workspaceKey})` : ""} (${shortPath(SERVERS_FILE())}). Verify it with \`oats server check ${id}\`.`);
    for (const w of warnings) console.error(`oats: warning: ${w}`);
    return;
  }
  if (sub === "remove") {
    try {
      updateServers((current) => {
        if (!current[id]) throw Object.assign(new Error(`no server registered as ${id}`), { code: "E_SERVER_UNKNOWN" });
        delete current[id];
      });
    } catch (e) { bail(e.code || "E_SERVERS_UNREADABLE", e.message); }
    const snaps = listSnapshots(id);
    if (JSON_MODE) { jsonOk({ removed: id, remoteInstancesStillTracked: snaps.map((s) => s.instance) }); return; }
    console.log(`Removed server ${id}${snaps.length ? ` — ${snaps.length} remote instance(s) spawned from it keep their snapshots and can still be retired with --server ${id}` : ""}`);
    return;
  }
  // check: reachability and compatibility, no mutation
  let server; try { server = getServer(id); } catch (e) { bail(e.code, e.message); }
  const target = targetOf(server);
  try {
    const remote = checkRemote(target, { serverId: id });
    const status = routeCommand(id, "status", [], { server });
    const agents = status.envelope.ok ? (status.envelope.result.agents || []).length : undefined;
    // The workspace key: a contradiction is refused (never rewritten), an absent one backfilled.
    const { key: reported } = workspaceKeyOfStatus(status.envelope);
    const learned = reported ? learnWorkspaceKey(id, server, reported) : null;
    if (learned?.mismatch) { const e = workspaceMismatch(id, { ...server, workspaceKey: learned.mismatch }, reported); bail(e.code, e.message, e.details); }
    const workspaceKey = reported ?? server.workspaceKey ?? null;
    // Whether git on the host reads the workspace remote: the host's own read-only onboard check
    // (feature server-connect); null when the host cannot say.
    let workspaceReadable = null, workspaceReadError;
    if (status.envelope.ok && remote.features.includes("server-connect")) {
      const probe = runRemote(target, ["onboard", target.workspace, "--check", "--json"], { serverId: id }).envelope;
      if (probe.ok && probe.result?.remote) {
        workspaceReadable = probe.result.remote.readable === true;
        if (!workspaceReadable) { const { code, message, reason, hint } = probe.result.remote.error || {}; workspaceReadError = { code, message, reason, ...(hint ? { hint } : {}) }; }
      }
    }
    if (JSON_MODE) { jsonOk({ id, target, remote, workspaceKey, workspaceReachable: !!status.envelope.ok, workspaceReadable, ...(workspaceReadError ? { workspaceReadError } : {}), agents, error: status.envelope.ok ? undefined : status.envelope.error }); return; }
    console.log(`${id}: ssh ${target.sshHost} ok, remote oats ${remote.version} (envelope v${remote.schemaVersion})${workspaceKey ? `, workspace ${workspaceKey}` : ""}`);
    if (workspaceReadable === false) console.log(`  the host's git cannot read the workspace remote: ${workspaceReadError.message}`);
    console.log(status.envelope.ok ? `  workspace ${target.workspace}: ${agents} agent(s)` : `  workspace ${target.workspace}: ${status.envelope.error?.message || "not usable"}`);
    if (!status.envelope.ok) process.exit(1);
  } catch (e) { bail(e.code || "E_SSH", e.message, e.details); }
}

/** `oats server connect <id> --ssh <host> --dir <path>`: this deployment's workspace on a host,
 *  registered (lib/servers.mjs connectServer). The workspace ref defaults from the deployment it
 *  runs in; the folder on the host never has a default, inside a deployment too (awebai/oats#1390,
 *  step b): only the person knows where it goes. */
function serverConnectCmd(bail) {
  const id = args[2];
  if (!id || id.startsWith("--")) bail("E_USAGE", "usage: oats server connect <id> --ssh <host-alias> --dir </abs/path or ~/path on the host> [--workspace-ref <ref>] [--oats <path>] [--path <dir:dir>] [--label <text>] [--install-oats] [--replace] [--json]");
  const val = (name) => { const v = flag(name); return v === true ? bail("E_BAD_ARGS", `--${name} needs a value`) : v; };
  const sshHost = val("ssh");
  if (!sshHost) bail("E_BAD_ARGS", "--ssh <host-alias> is required: the OpenSSH host alias of the machine to connect");
  let local = null;
  try { local = loadLocal(process.cwd()); } catch (e) { if (e?.code !== "E_LOCAL_MISSING") bail(e.code || "E_CONFIG_BROKEN", e.message, e.details); }
  const workspaceRef = val("workspace-ref") ?? local?.local.workspace;
  if (!workspaceRef) bail("E_BAD_ARGS", "--workspace-ref <ref> is required outside a deployment (inside one it defaults to oats-local.yaml workspace:)");
  try { remoteModule.parseRepoRef(workspaceRef); } catch (e) { bail(e.code || "E_REPO_REF", e.message, e.details); }
  const dir = val("dir");
  if (!dir) bail("E_BAD_ARGS", `--dir <path on the host> is required: the folder on ${sshHost} for this deployment (absolute, or ~/… resolved there)`);
  let res;
  try {
    res = connectServer({ id, sshHost, workspaceRef, dir, oatsPath: val("oats"), path: val("path"), label: val("label"), installOats: args.includes("--install-oats"), replace: args.includes("--replace"), localVersion: OATS_VERSION });
  } catch (e) {
    if (!JSON_MODE && e.details?.steps) printConnectSteps(id, sshHost, e.details.steps);
    bail(e.code || "E_CONNECT", e.message, e.details);
  }
  const { registeredAs, ...result } = res;
  if (JSON_MODE) { jsonOk(result); return; }
  printConnectSteps(id, sshHost, res.steps);
  if (res.ready) console.log(`\n${registeredAs} is ready: oats spawn <soul> --server ${registeredAs}`);
  else { console.log(`\nnot ready yet; for a human, then re-run this command:`); for (const h of res.human) console.log(`  - ${h.split("\n").join("\n    ")}`); }
}
function printConnectSteps(id, sshHost, steps) {
  console.log(`oats server connect ${id} → ${sshHost}`);
  for (const s of steps) console.log(`  ${s.step.padEnd(11)} ${s.status}${s.detail ? `  ${s.detail.split("\n")[0]}` : ""}`);
}

/** `oats <namespace> <command> … --server <id>`: the capability command, as typed minus the routing
 *  flag, on the server's registered deployment (lib/servers.mjs routeCapability). The host's output and
 *  exit status are relayed; under --json its envelope verbatim, or one envelope here when nothing came
 *  back. An argv is printed only with its --invite values redacted. */
function capabilityRouteCmd() {
  const bail = (code, msg, details) => (JSON_MODE ? jsonFail(code, msg, details) : die(msg));
  const { id, argv } = serverFlagOf(rawArgs);
  if (id === true) bail("E_BAD_ARGS", "--server needs a registered server id (oats server list)");
  let server, r;
  try { server = getServer(id); r = routeCapability(id, argv, { server, json: JSON_MODE }); } catch (e) { bail(e.code || "E_SSH", e.message); }
  const shown = `\`oats ${redactArgv(argv).join(" ")}\``;
  if (JSON_MODE) {
    if (!r.stdout?.length) bail(r.status === 255 ? "E_SSH" : "E_REMOTE_ENVELOPE", r.status === 255 ? `ssh to ${server.sshHost} failed running ${shown} on server ${id}` : `${shown} on server ${id} exited ${r.status} with no envelope`, { server: id, status: r.status });
    process.stdout.write(r.stdout);
  } else if (r.status === 255) console.error(`oats: ${shown} on server ${id} ended with exit 255 (ssh to ${server.sshHost} failed, or the command itself exited 255)`);
  process.exitCode = r.status;
}

/** `oats <spawn|retire|status> --server <id> ...`: run the command on the
 *  registered server's installed oats, same arguments, same envelope. The
 *  local side only routes and keeps the route snapshot per remote instance. */
async function serverRouteCmd() {
  const bail = (code, msg, details, exit) => (JSON_MODE ? jsonFail(code, msg, details, exit) : die(msg, exit));
  const id = flag("server");
  if (id === true || !id) bail("E_BAD_ARGS", "--server needs a registered server id (oats server list)");
  // The operations contract, launch-config and the host's reads address an
  // exact member context on the host, so their explicit --dir travels, as
  // does a retire plan's or guarded apply's (the lifecycle contract's own
  // arguments); every other routed command takes its scope from the
  // registration.
  const explicitScopeOk = ["inspect", "operation", "launch-config", "readiness", "instance"].includes(cmd)
    || (cmd === "retire" && ["--plan", "--plan-revision", "--idempotency-key"].some((f) => args.includes(f)));
  if (!explicitScopeOk && flag("dir") !== undefined) bail("E_BAD_ARGS", "--dir cannot be combined with --server: the remote workspace comes from the server registration");
  if (cmd === "launch-config") {
    const action = args[1];
    const value = (name) => { const v = flag(name); if (v === true) bail("E_BAD_ARGS", `--${name} needs a value`); return v; };
    if (!["list", "set", "remove", "preview"].includes(action)) bail("E_BAD_ARGS", "launch-config --server supports list, set, remove and preview");
    const options = { action, name: args[2], context: value("dir"), home: value("home"), instance: value("instance"), soul: value("soul"), agentsRoot: value("agents-root") };
    if (action === "preview") Object.assign(options, { launchConfig: value("launch-config"), harness: harnessFlag(value), model: value("model"), yolo: yoloFlag() });
    if (action === "set") {
      const file = value("file");
      if (!file) bail("E_BAD_ARGS", "launch-config set needs --file <local JSON file> (or - for stdin)");
      let raw;
      try {
        if (file === "-") {
          if (process.stdin.isTTY) bail("E_BAD_ARGS", "--file - reads the definition from stdin");
          raw = await readStreamBounded(process.stdin, INSPECT_TEXT_CAP);
        } else raw = readFileSync(file);
      } catch (e) { bail("E_BAD_ARGS", `cannot read launch configuration file (${e.code || "read failed"})`); }
      if (raw.length > INSPECT_TEXT_CAP) bail("E_BAD_ARGS", "launch configuration file exceeds the input limit");
      try { options.definition = JSON.parse(raw.toString("utf8")); }
      catch { bail("E_BAD_ARGS", "launch configuration file is not valid JSON"); }
      options.keepEnv = args.includes("--keep-env");
    }
    let out;
    try { out = launchConfigRemote(id, options); } catch (e) { bail(e.code || "E_SSH", e.message, e.details); }
    if (out.stderr?.trim()) process.stderr.write(out.stderr.endsWith("\n") ? out.stderr : out.stderr + "\n");
    if (JSON_MODE) { console.log(JSON.stringify(withLocalWarnings(out.envelope), null, 2)); if (!out.envelope.ok) process.exit(1); return; }
    if (!out.envelope.ok) die(`${id}: ${out.envelope.error?.message || "launch configuration request failed"} (${out.envelope.error?.code || "E_REMOTE"})`);
    console.log(JSON.stringify(out.envelope.result, null, 2));
    return;
  }
  // Interactive viewer: `oats session attach --server <id> --instance <name>`
  // (or --home </abs/remote/home>) runs the execution host's own attach
  // through an ssh PTY with this terminal's stdio; nothing is captured.
  if (cmd === "okf") {
    // `oats okf harvest --server <id> --instance <name>`: the package's
    // harvest command run in the instance's SAVED home on the host.
    if (args[1] !== "harvest") bail("E_USAGE", "--server routes `okf harvest` only among the okf commands");
    const inst = flag("instance");
    if (!inst || inst === true) bail("E_BAD_ARGS", "okf harvest --server needs --instance <name> (spawned from here)");
    let routed;
    try { routed = routeCommand(id, "harvest", [inst]); } catch (e) { bail(e.code || "E_SSH", e.message, e.details); }
    if (routed.stderr?.trim()) process.stderr.write(routed.stderr.endsWith("\n") ? routed.stderr : routed.stderr + "\n");
    if (JSON_MODE) { console.log(JSON.stringify(withLocalWarnings(routed.envelope), null, 2)); if (!routed.envelope.ok) process.exit(1); return; }
    if (!routed.envelope.ok) die(`${id}: ${routed.envelope.error?.message || "harvest failed"} (${routed.envelope.error?.code || "E_REMOTE"})`);
    const hr = routed.envelope.result;
    console.log(`Harvest on ${id} for ${inst}: ${hr.harvest}${hr.reason ? ` (${hr.reason})` : ""}${hr.instance && hr.harvest === "spawned" ? ` — harvester ${hr.instance}` : ""}`);
    if (hr.instance && hr.instance !== inst) console.log(`  the harvester ${hr.instance} runs on ${id}; retire it there when it is done, or let it self-retire`);
    return;
  }
  if (cmd === "schedule") {
    // Host-owned: the subcommand runs in the server's registered workspace.
    // A local --file spec is read here and travels inline; the remote
    // cannot read this machine's files.
    const rest = [];
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === "--server") { i++; continue; }
      if (a === "--json") continue;
      if (a === "--file") {
        const f = args[++i];
        if (!f || f.startsWith("--")) bail("E_BAD_ARGS", "--file needs a path");
        if (!existsSync(f)) bail("E_BAD_ARGS", `spec file not found: ${f}`);
        rest.push("--spec-json", readFileSync(f, "utf8"));
        continue;
      }
      // An inline --description travels inline (it may be empty, or start with --).
      if (a === "--description" && inlineValues.has("description")) { rest.push(`--description=${inlineValues.get("description")}`); continue; }
      rest.push(a);
    }
    let out;
    try { out = scheduleRemote(id, rest); } catch (e) { bail(e.code || "E_SSH", e.message, e.details); }
    if (out.stderr?.trim()) process.stderr.write(out.stderr.endsWith("\n") ? out.stderr : out.stderr + "\n");
    if (JSON_MODE) { console.log(JSON.stringify(withLocalWarnings(out.envelope), null, 2)); if (!out.envelope.ok) process.exit(1); return; }
    if (!out.envelope.ok) die(`${id}: ${out.envelope.error?.message || "schedule command failed"} (${out.envelope.error?.code || "E_REMOTE"})`);
    console.log(JSON.stringify(out.envelope.result, null, 2));
    return;
  }
  if (cmd === "session") {
    const addr = { instance: flag("instance") === true ? undefined : flag("instance"), home: flag("home") === true ? undefined : flag("home") };
    if (args[1] === "inspect") {
      // Desktop preflight before a remote attach: the execution host's own
      // inspect, relayed as its envelope; a failure is a failure, nonzero.
      let out;
      try { out = inspectRemote(id, addr); } catch (e) { bail(e.code || "E_SSH", e.message, e.details); }
      if (out.stderr?.trim()) process.stderr.write(out.stderr.endsWith("\n") ? out.stderr : out.stderr + "\n");
      if (JSON_MODE) { console.log(JSON.stringify(withLocalWarnings(out.envelope), null, 2)); if (!out.envelope.ok) process.exit(1); return; }
      if (!out.envelope.ok) die(`${id}: ${out.envelope.error?.message || "inspect failed"} (${out.envelope.error?.code || "E_REMOTE"})`);
      const r = out.envelope.result;
      console.log(`${r.instance || r.home} on ${id}: ${r.present ? `present, ${r.state || "unknown"}` : "not present"}${r.backend ? ` (${r.backend})` : ""}`);
      return;
    }
    if (args[1] === "start" || args[1] === "restart") {
      const value = (name) => { const v = flag(name); if (v === true) bail("E_BAD_ARGS", `--${name} needs a value`); return v; };
      const choices = { ...addr, model: value("model"), launchConfig: value("launch-config"), harness: harnessFlag(value), yolo: yoloFlag() };
      if (flag("stop-grace") !== undefined) bail("E_BAD_ARGS", "--stop-grace is currently supported on the execution host; omit it to use the remote restart's default wait");
      let out;
      try { out = (args[1] === "restart" ? restartRemote : startRemote)(id, choices); } catch (e) { bail(e.code || "E_SSH", e.message, e.details); }
      if (out.stderr?.trim()) process.stderr.write(out.stderr.endsWith("\n") ? out.stderr : out.stderr + "\n");
      if (JSON_MODE) { console.log(JSON.stringify(withLocalWarnings(out.envelope), null, 2)); if (!out.envelope.ok) process.exit(1); return; }
      if (!out.envelope.ok) die(`${id}: ${out.envelope.error?.message || "start failed"} (${out.envelope.error?.code || "E_REMOTE"})`);
      const r = out.envelope.result;
      console.log(`Started ${r.instance || r.home} on ${id} (${r.backend}${r.model ? `, model ${r.model}` : ""}, ${r.reused === "pane" ? "in its existing pane" : r.reused === "adopted" ? "adopted the pending session" : "new window"})`);
      return;
    }
    if (args[1] === "upload") {
      // Bytes stream to `session receive` on the execution host over the
      // same route as attach; the answer's checksum is verified here.
      const file = flag("file");
      if (!file || file === true) bail("E_BAD_ARGS", "session upload needs --file <local path>");
      let r;
      try { r = uploadAttachment({ file, server: id, ...addr }); } catch (e) { bail(e.code || "E_UPLOAD_FAILED", e.message, e.details); }
      if (r.stderr) process.stderr.write(r.stderr + "\n");
      if (JSON_MODE) { jsonOk(r); return; }
      console.log(`Uploaded ${r.name} (${r.bytes} bytes) to ${r.instance || r.home} on ${id}: ${r.path}`);
      return;
    }
    if (args[1] !== "attach") bail("E_USAGE", "--server routes `session inspect`, `session start`, `session restart`, `session upload` and `session attach`; input runs on the execution host (the wake broker calls it there)");
    // --detach-key travels only to a host that advertises session-attach-detach-key (attachArgv
    // probes for it, under --print too). The key may be C-\, the tty's QUIT character: pressed
    // once ssh has given the tty back, it reaches this process as SIGQUIT, whose default action
    // would replace the relayed status with 131. Held from here until this process exits.
    const detachKey = valueFlag("detach-key");
    if (detachKey !== undefined) process.on("SIGQUIT", () => {});
    let route;
    try { route = attachArgv(id, { ...addr, detachKey, statusLine: !args.includes("--no-status-line") }, { skipVersionCheck: args.includes("--print") }); }
    // ssh failing before the viewer (the version probe, a name resolved through the host's roster)
    // is the failure ssh has under it: exit 255, on which a caller reconnects. Every other refusal,
    // and an ssh that never started (no link can come back), exits 1.
    catch (e) { bail(e.code || "E_BAD_ARGS", e.message, e.details, e.code === "E_SSH" && e.details?.sshStarted !== false ? 255 : 1); }
    if (args.includes("--print")) { console.log(route.argv.map(shellQuote).join(" ")); return; }
    const r = spawnSyncProc(route.argv[0], route.argv.slice(1), { stdio: "inherit" });
    // ssh exits 255 for its own failures: a link that died under the viewer
    // (keepalives unanswered, the master or the host's sshd gone), or one
    // never made. Say what is known rather than ending silently.
    if (r.status === 255) console.error(`\noats: ssh to ${route.target.sshHost} ended with an error (exit 255); if the link was lost, the instance keeps running on ${id}. Reattach with: oats session attach --server ${id} --home ${shellQuote(route.home)}${detachKey !== undefined ? ` --detach-key ${shellQuote(detachKey)}` : ""}`);
    process.exit(r.status ?? 1);
  }
  // A spawn's argv is checked here, before the server is contacted.
  if (cmd === "spawn") {
    const herdr = herdrSpawnFlag();
    if (herdr) { const e = herdrSettingRemoved(`${herdr} was given`); bail(e.code, e.message); }
    const local = args.slice(1).filter((a, i, all) => a !== "--server" && all[i - 1] !== "--server");
    const problem = spawnArgvProblem(local) ?? suggestNameProblem(local) ?? backgroundProblem(local);
    if (problem) bail("E_BAD_ARGS", problem);
  }
  // Everything after the command word travels, minus the routing flags; a
  // local --task-file is read here and travels as --task text, since the
  // remote cannot read this machine's files.
  const rest = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--server") { i++; continue; }
    if (a === "--json") continue;
    if (a === "--task-file") {
      const f = args[++i];
      if (!f || f.startsWith("--")) bail("E_BAD_ARGS", "--task-file needs a path");
      if (!existsSync(f)) bail("E_BAD_ARGS", `task file not found: ${f}`);
      rest.push("--task", readFileSync(f, "utf8"));
      continue;
    }
    // A wake spec for a routed spawn travels as validated JSON text; the
    // host saves it in its own scope. Local files never travel as paths.
    if (a === "--wake-file") {
      const f = args[++i];
      if (!f || f.startsWith("--")) bail("E_BAD_ARGS", "--wake-file needs a path");
      if (!existsSync(f)) bail("E_BAD_ARGS", `wake file not found: ${f}`);
      let doc; try { doc = JSON.parse(readFileSync(f, "utf8")); } catch (e) { bail("E_SCHEDULE_INVALID", `--wake-file is not valid JSON: ${e.message}`); }
      if (!doc || typeof doc !== "object" || !["cron", "tz", "message"].every((k) => typeof doc[k] === "string" && doc[k].trim())) bail("E_SCHEDULE_INVALID", "--wake-file must hold {cron, tz, message, enabled}");
      rest.push("--wake-json", JSON.stringify({ cron: doc.cron, tz: doc.tz, message: doc.message, enabled: doc.enabled === undefined ? true : doc.enabled }));
      continue;
    }
    if (a === "--wake-message-file") {
      const f = args[++i];
      if (!f || f.startsWith("--")) bail("E_BAD_ARGS", "--wake-message-file needs a path");
      if (!existsSync(f)) bail("E_BAD_ARGS", `wake message file not found: ${f}`);
      rest.push("--wake-message", readFileSync(f, "utf8"));
      continue;
    }
    rest.push(a);
  }
  // Refused here too, before anything is sent: a host on an older OATS would still delete the branch.
  if (cmd === "retire" && rest.includes("--delete-branch")) bail("E_BAD_ARGS", RETIRE_DELETE_BRANCH_REFUSED);
  let routed;
  try { routed = routeCommand(id, cmd, rest); }
  catch (e) { bail(e.code || "E_SSH", e.message, e.details); }
  const { envelope, stderr } = routed;
  if (stderr && stderr.trim()) process.stderr.write(stderr.endsWith("\n") ? stderr : stderr + "\n");
  // The host's own reads and plans: its envelope, relayed unchanged.
  if (cmd === "readiness" || cmd === "instance" || (cmd === "retire" && rest.includes("--plan"))) {
    if (JSON_MODE) { console.log(JSON.stringify(withLocalWarnings(envelope), null, 2)); if (!envelope.ok) process.exit(1); return; }
    if (!envelope.ok) die(`${id}: ${envelope.error?.message || "remote command failed"} (${envelope.error?.code || "E_REMOTE"})`);
    console.log(JSON.stringify(envelope.result, null, 2));
    return;
  }
  if (JSON_MODE) { console.log(JSON.stringify(withLocalWarnings(envelope), null, 2)); if (!envelope.ok || envelope.result?.rollbackIncomplete) process.exit(1); return; }
  if (!envelope.ok && !(cmd === "retire" && envelope.result)) die(`${id}: ${envelope.error?.message || "remote command failed"} (${envelope.error?.code || "E_REMOTE"})`);
  const r = envelope.result;
  const target = r.target || {};
  // A routed preview created nothing, there or here: the local preview's lines, naming the server.
  // The host's answer decides, not the flag: one that spawned is reported as the spawn it was.
  if (cmd === "spawn" && rest.includes("--preview") && r.preview === true) printSpawnPreview(r, { server: id, soulFetched: r.soulFetched === true });
  else if (cmd === "spawn") {
    console.log(`Spawned ${r.instance} on ${id} (${r.work}${r.branch ? `, branch ${r.branch}` : ""})${r.launched ? ` — tmux window "${r.tmux?.window}" on ${r.target.sshHost}` : " — not launched"}`);
    console.log(`  remote home: ${r.home}`);
    { const line = namingLine(r.naming); if (line) console.log(`  name: ${line}`); }
    console.log(`  route snapshot: ${r.snapshot ? shortPath(r.snapshot) : "none (see the warning)"}`);
    for (const w of r.warnings || []) console.log(`  WARNING: ${terminalText(w)}`);
    console.log(`  attach: oats session attach --server ${shellQuote(id)} --instance ${shellQuote(r.instance)}`);
  } else if (cmd === "retire") {
    // Everything the local retireCmd tells the operator, for a remote home
    // they cannot see: forced-incomplete state now theirs to remove by hand
    // there, work preserved there and where, and incomplete cleanup.
    if (r.forcedIncomplete) {
      console.error(`Removed ${r.retired} on ${id} under --force with cleanup INCOMPLETE — this external state was NOT cleaned up and is now yours to remove by hand on ${target.sshHost}:`);
      for (const f of r.forcedIncomplete) console.error(`  ${f}`);
      const branch = failedSpawnBranchLine(r, r.forcedIncomplete, { host: target.sshHost });
      if (branch) console.error(branch);
    }
    console.log(`Retired ${r.retired} on ${id}${r.deferred ? " (deferred completion scheduled there)" : ""}${r.rollbackIncomplete ? " — cleanup INCOMPLETE on the server, home retained there" : ""}`);
    for (const line of workRecoveryLines(r, { host: target.sshHost })) console.log(line);
    for (const line of extraWorktreeLines(r, { host: target.sshHost })) console.log(line);
    for (const line of warningLines(r)) console.log(line);
    if (r.rollbackIncomplete) {
      for (const f of r.rollbackIncomplete) console.error(`  ${f}`);
      const branch = failedSpawnBranchLine(r, r.rollbackIncomplete, { host: target.sshHost });
      if (branch) console.error(branch);
      console.error(`Fix the cause there and re-run \`oats retire ${r.retired} --server ${id}\`.`);
      process.exit(1);
    }
  } else {
    console.log(`oats status — server ${id} (ssh ${r.target.sshHost}, workspace ${r.target.workspace})\n`);
    for (const a of r.agents || []) {
      console.log(`  ${a.name}  [work: ${a.work || "checkout"}, repo: ${a.repo || "?"}]`);
      for (const i of a.instances || []) {
        console.log(`      • ${i.instance}${i.background === true ? " [background]" : ""}  ${statusWord(i)}${i.runtimeError ? `  ${i.runtimeError}` : ""}`);
        const lost = lostLine(i, { host: r.target.sshHost || id }); if (lost) console.log(`          ${lost}`);
      }
    }
    const snaps = r.snapshots || [];
    if (snaps.length) console.log(`\n  spawned from this machine: ${snaps.map((s) => s.instance).join(", ")}`);
  }
}

// ---------- main ----------
// Typed config-shape failures are DEPLOYMENT state the operator can fix, not
// kernel bugs: an unsafe mapping key anywhere in the visible config chain is
// raised by the readers, which every command walks before it can do anything.
// Without this boundary `oats doctor`, `oats use` and every --json mode printed a
// raw Node stack with empty stdout — no code, no envelope, nothing to act on.
// Deliberately narrow: only codes with a defined rendering are caught here;
// anything else still crashes loudly.
//
// The dispatch chain below is deliberately NOT re-indented into this try block:
// keeping it at column 0 makes the whole command table one reviewable diff of
// added lines rather than ~150 lines of pure whitespace churn, and keeps `git
// blame` pointing at the commit that last changed each command.
const TYPED_CLI_FAILURES = OWN_NAME_FAILURES; // one list: lib/errors.mjs
/** Removed 0.24 verbs → their v2 replacement (workspace model v2, decision 5). Checked before capability dispatch. */
const REMOVED_VERBS = { prepare: "`oats onboard` / `oats sync` to set up a workspace, and `oats spawn <soul> --preview` to see what a spawn would resolve (the captured/portable path was removed in 0.26)", create: "author souls/<name>/soul.yaml + AGENTS.md in a member repository, then `oats sync`", type: "the soul's own soul.yaml in its member repository (agent types were a classic config block)", install: "oats sync", restore: "oats sync", init: "oats-local.yaml + oats sync", use: "soul.yaml capabilities: { <cap>: { from } } + workspace defaults", trust: "declaring the package in packages: (package approval was removed; oats sync locks commit + integrity)", list: "oats workspace status | oats capabilities", catalog: "oats package add <id> <version> (bare versions resolve through package-catalog.json)", remove: "oats package remove <id>", migrate: "a rebuild (no migration: docs/design/2026-09-23-workspace-module-contracts.md)", config: "oats-local.yaml (host settings) and oats-workspace.yaml (shared)", inject: "injection overrides are not part of the workspace model yet; edit the capability inject in its member repo" };
try {
// The captured/portable path was removed in 0.26 (lead decisions on (e), D2/D3):
// its selectors and an inherited captured context are refused, never quietly
// resolved against the current context instead. `version` answers regardless:
// host protocol negotiation describes this executable.
{
  // The kernel's own argv only: a capability command's flags are its provider's to parse.
  const kernelArgv = (KERNEL_COMMANDS.has(cmd) && !OWN_ARGV_COMMANDS.has(cmd)) || (ROUTED_COMMANDS.has(cmd) && flag("server") !== undefined);
  if (argvProblem && kernelArgv) cmdFail("E_BAD_ARGS", argvProblem);
  const end = args.indexOf("--"), head = end < 0 ? args : args.slice(0, end);
  // `session resume --deployment <dir>` (feature session-resume) reuses the name for a deployment
  // the sweep is limited to, not a captured selector.
  const resumeSweep = cmd === "session" && args[1] === "resume";
  const selector = head.find((a) => /^--(deployment|resolution|artifact-set)$/.test(a) && !(resumeSweep && a === "--deployment"));
  const refuse = (message, details) => { if (JSON_MODE) jsonFail("E_UNSUPPORTED_MODE", message, details); die(message); };
  if (selector) refuse(`${selector}: a captured selector is refused (the captured/portable path was removed in 0.26); run the command in its workspace deployment or instance home instead`, { selector });
  // --max-age (feature observe-max-age): ONE allow-list for every kernel command, here — never a
  // per-command copy. A capability namespace's argv is its provider's.
  if (kernelArgv && head.includes("--max-age")) {
    const refusal = maxAgeRefusal(cmd, head);
    if (refusal) cmdFail("E_BAD_ARGS", refusal);
    const { maxAge, refusal: badAge } = parseMaxAge(flag("max-age"));
    if (badAge) cmdFail(badAge.code, badAge.message);
    maxAgeGiven = maxAge;
    activateLocalInputs(); // observation.localRevision: every local config read from here on is recorded
  }
  if (kernelArgv && !head.includes("--server") && (cmd === "status" || (cmd === "workspace" && head[1] === "status"))) {
    readBudgetMs = readBudget(process.env);
  }
  // The warm reader answers each request as the CLI would, this refusal included (lib/reader.mjs).
  const captured = cmd === "version" || cmd === "reader" ? null : inheritedContextRefusal(process.env);
  if (captured) refuse(captured.message, captured.details);
  if (cmd === "inspect" && head.includes("--request")) {
    const message = "oats inspect --request (portable onboarding inspection) is gone (the captured/portable path was removed in 0.26); use `oats onboard` / `oats sync` to set up a workspace and `oats spawn <soul> --preview` to see what a spawn would resolve";
    if (JSON_MODE) jsonFail("E_UNKNOWN_COMMAND", message, { removed: "inspect --request", replacement: "oats onboard / oats sync; oats spawn --preview" });
    die(message);
  }
}
// This computer's deployments list (awebai/oats#1390, amendment 1 and its performance budget): a
// kernel command that resolves a local deployment lists it when it is not listed yet. The one table
// of those commands is here. The check runs on the command's own resolution, once, at exit, on
// the canonical root when the command resolved one (lib/resolved-deployment.mjs; lib/deployments.mjs
// listResolved): a listed deployment costs one bounded read of the list. Never on --server (the remote's path is not this computer's), never for
// help, and silent: no output, no change to the command's answer or exit status.
const LISTS_ITS_DEPLOYMENT = new Set(["automations", "capabilities", "doctor", "harness", "inspect", "instance", "launch-config", "operation", "package", "pane", "readiness", "retire", "schedule", "session", "soul", "souls", "spawn", "status", "sync", "teams", "trigger", "update", "workspace", "worktree"]);
// `instance suggest-name` records nothing (#1490 §2): the oats-local.yaml it reads is not listed.
// `session resume` reads the list and never writes it (#1559).
if (LISTS_ITS_DEPLOYMENT.has(cmd) && flag("server") === undefined && !(cmd === "instance" && args[1] === "suggest-name") && !(cmd === "session" && args[1] === "resume") && !args.slice(1).some((a) => a === "--help" || a === "-h")) observeResolvedDeployment(listResolved);
if (cmd === "onboard") {
  if (args.includes("--help") || args.includes("-h")) { if (JSON_MODE) jsonOk({ command: cmd, usage: usageLinesFor(cmd) }); else usageFor(cmd); process.exit(0); }
  await onboardCmd();
}
else {
// `--help`/`-h` anywhere after a kernel command prints that command's usage
// and exits 0 BEFORE any dispatch: a fresh operator inspects --help before
// using a command, and `install --help` once ran the bare restore while
// `okf harvest --help` spawned a harvester (BeadHub, 2026-09-05).
const wantsHelp = args.slice(1).some((a) => a === "--help" || a === "-h");
if (cmd && KERNEL_COMMANDS.has(cmd) && wantsHelp) { if (JSON_MODE) { jsonOk({ command: cmd, usage: usageLinesFor(cmd) }); process.exit(0); } usageFor(cmd); process.exit(0); }
if (cmd === "instance" && args[1] === "upgrade" && flag("server") !== undefined) cmdFail("E_BAD_ARGS", "instance upgrade supports local homes only; run it on the deployment host");
// #1490 §2: the name is decided on the machine that asks, for a spawn that lands elsewhere.
if (cmd === "instance" && args[1] === "suggest-name" && flag("server") !== undefined) cmdFail("E_BAD_ARGS", "instance suggest-name takes no --server: it runs this machine's harness, for a spawn that may land on another; the host it lands on makes the name unique (or names an unnamed --suggest-name spawn itself)");
// Session resume is local only (#1559, D1): a server resumes its own instances.
if (cmd === "session" && flag("server") !== undefined && (args[1] === "resume" || args.includes("--resume"))) cmdFail("E_BAD_ARGS", "session resume and session start --resume act on this machine's instances only; a server runs oats session resume itself");
if (flag("server") !== undefined && ROUTED_COMMANDS.has(cmd)) await serverRouteCmd();
else if (cmd === "server") await serverCmd();
else if (cmd === "deployments") deploymentsCmd();
else if (cmd === "inspect") await inspectCmd();
else if (cmd === "operation") await operationCmd();
else if (cmd === "launch-config") await launchConfigCmd();
else if (cmd === "doctor") {
  const doctorDir = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
  await (args.includes("--json") ? doctorJson(doctorDir) : doctor(doctorDir));
}
else if (cmd === "update") {
  // `oats update <package>` left with the installed tier (packages are pinned in
  // the workspace file: `oats package add`); only the kernel self-update remains.
  const t = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
  if (t || flag("to") !== undefined) { cmdFail("E_BAD_ARGS", "oats update takes no package: pin package versions in oats-workspace.yaml (`oats package add <id> <version>`), then `oats sync`; bare `oats update [--check] [--yes]` updates the kernel"); process.exit(1); }
  updateCmd();
}
else if (cmd === "harness") harnessTrustCmd();
else if (cmd === "readiness") await readinessCmd();
else if (cmd === "instance") await instanceCmd();
else if (cmd === "worktree") await worktreeCmd();
else if (cmd === "root") console.log(resolve(new URL("..", import.meta.url).pathname));
else if (cmd === "sync") await syncCmd();
else if (cmd === "package") await packageCmd();
else if (cmd === "workspace") await workspaceCmd();
else if (cmd === "capabilities" || cmd === "souls") await itemsCmd(cmd);
else if (cmd === "teams") await teamsCmd();
else if (cmd === "soul") await soulCmd();
else if (cmd === "status") await status();
else if (cmd === "pane") await paneCmd();
else if (cmd === "tui") await tuiCmd();
else if (cmd === "version" || cmd === "--version" || cmd === "-v") versionCmd();
else if (cmd === "reader") await readerCmd();
else if (cmd === "session") await sessionCmd();
else if (cmd === "schedule") await scheduleCmd();
else if (cmd === "trigger") await triggerCmd();
else if (cmd === "automations") await automationsCmd();
// What a spawn throws outside its kernel stage goes through the same door as the inner catch.
else if (cmd === "spawn") { try { await spawnCmd(); } catch (e) { spawnFail(e); throw e; } }
// What a retire throws outside its own answers (the root, a replay's read) goes through the same door.
// An exception after the retire has returned (retireReturned) is rethrown, here and by the handler
// of typed failures below: a crash is read as "not confirmed", which is the truth, where an error
// answer without `reached` would read as "nothing was done".
else if (cmd === "retire") { try { retireCmd(); } catch (e) { if (retireReturned || TYPED_CLI_FAILURES.has(e?.code)) throw e; lifecycleFail(e, "E_LIFECYCLE_FAILED", e.details); } }
else if (cmd === "capture" || cmd === "recall" || cmd === "setup") await recordCmd(cmd);
else if (cmd === "experimental") await experimentalCmd();
// `!HELP_WORDS.has(cmd)`: usage NEVER depends on deployment state. `help` is a
// word, so without this it reaches the capability dispatch, which resolves the
// config chain and reads every lock in it — and a scope whose lock the kernel
// refuses could then not print its own usage, which is exactly when you need it.
// A removed 0.24 verb names its v2 replacement in BOTH modes, before any capability namespace could shadow it.
else if (cmd && Object.hasOwn(REMOVED_VERBS, cmd)) {
  const message = `unknown command "${cmd}" — removed by the workspace model v2; use ${REMOVED_VERBS[cmd]}`;
  if (JSON_MODE) jsonFail("E_UNKNOWN_COMMAND", message, { removed: cmd, replacement: REMOVED_VERBS[cmd] });
  console.error(`oats: ${message}\n`);
  console.log(usageText());
  process.exit(1);
}
// A capability command with --server runs on the server (feature capability-route); kernel commands keep their own table above.
else if (cmd && !cmd.startsWith("--") && !HELP_WORDS.has(cmd) && serverFlagOf(rawArgs)) capabilityRouteCmd();
else if (cmd && !cmd.startsWith("--") && !HELP_WORDS.has(cmd) && await capabilityCommand()) { /* dispatched */ }
// No matching kernel command or capability namespace: in --json mode the help
// text must NOT contaminate stdout — still one envelope object, nonzero exit.
else if (cmd && !cmd.startsWith("--") && !HELP_WORDS.has(cmd) && JSON_MODE) jsonFail("E_UNKNOWN_COMMAND", `unknown command "${cmd}" — no kernel subcommand or active capability namespace matches`);
else {
  if (cmd && !HELP_WORDS.has(cmd) && !cmd.startsWith("--")) console.error(`oats: unknown command "${cmd}" — no kernel subcommand or active capability namespace matches\n`);
  console.log(usageText());
  // exitCode, not exit(): the usage is ~20 KB, and exit() cuts off whatever a pipe has not drained yet.
  process.exitCode = cmd && !HELP_WORDS.has(cmd) ? 1 : 0;
}
} // end: every command but onboard

/** The usage lines for one kernel command (its `oats <cmd> ...` lines and
 *  their indented continuations), or the whole usage when none match. */
function usageLinesFor(name) {
  const out = [];
  let inside = false;
  for (const line of usageText().split("\n")) {
    if (new RegExp(`^  oats ${name}(\\s|$)`).test(line)) { out.push(line); inside = true; continue; }
    if (inside && /^ {6}/.test(line) && !/^  oats /.test(line)) { out.push(line); continue; }
    inside = false;
  }
  return out;
}
function usageFor(name) {
  const out = usageLinesFor(name);
  console.log(out.length ? `Usage:\n${out.join("\n")}` : usageText());
}

function usageText() {
  return `oats — Open Agent Team Specification

Usage:
  oats version [--json]                      kernel version; --json emits the
                                            Desktop CLI API v1 probe payload
  oats status [--json]                       agents, souls, running instances
      [--max-age <s>]                        reuse head observations up to <s> s old (below)
  oats reader --stdio                        the warm reader: a client starts it as its child and
                                            asks it status and workspace status reads, one JSON
                                            line each way (docs/desktop-cli-api.md "The warm reader")
  oats tui [--dir <path>] [--ascii]          PREVIEW: the full-screen terminal client (docs/tui.md):
                                            the instances of the workspace of the deployment at or
                                            above <path> (default: where you are), on this machine
                                            and on the machines registered here. Enter opens an agent's
                                            terminal; it stops, starts, restarts and retires them after a
                                            confirmation. ? help, w workspaces, q quit. Needs a terminal on
                                            stdin and stdout and has no --json form; --ascii = ASCII rules
                                            and marks
  oats server add <id> --ssh <alias>         register another machine's OATS (OpenSSH alias,
      --workspace </abs/path> [--oats <p>]   remote workspace, remote oats path; no keys stored;
      [--path <dir:dir>]                    --path = dirs prepended to the remote PATH, e.g. ~/.local/bin)
  oats server list|remove <id>|check <id>    registry; check = reachability, version, workspace key
      [--workspace-ref <ref>]               (filled in when missing) and Git readability;
                                            list --workspace-ref = one workspace's servers
  oats server connect <id> --ssh <alias>     put this deployment's workspace on that machine and
      --dir <path> [--workspace-ref <ref>]  register it: ssh, oats, git, deployment, register,
      [--oats <p>] [--path <dir:dir>]       readiness, each re-checked every run; --install-oats
      [--label <t>] [--install-oats]        installs this version with npm there; human steps
      [--replace] [--json]                  come back with the exact remedy (docs/servers.md)
  oats spawn|retire|status ... --server <id> run that command on the server's installed oats
                                            (same flags, same envelope; the saved route per
                                            remote instance lives under ~/.oats/remote/)
  oats <namespace> <command> ... --server <id>
                                            a capability command on the server's deployment
                                            (argv minus --server, stdin forwarded)
  oats server roster [--server <id>]         remote roster grouped by server and saved route
      [--budget <ms>] [--per-target <ms>]   target: one status pull per group within a total
      [--json]                              budget (45 s, 20 s per target); every instance the
                                            server reports is addressable by --home or name
      [--workspace-key <key>]...            only groups that can belong to these workspaces:
                                            registered for one of them, workspace not known,
                                            or saved routes only (repeatable)
  oats server forget <id> --instance <name>  drop a saved route whose remote instance is gone
                                            (the roster shows it as missingRemotely)
  oats retire <instance> --home <path>       retire exactly that home when two agents own an
                                            instance of the same name (else refused)
  oats okf harvest --server <id>             run the knowledge harvest in a remote instance's
      --instance <name> [--json]            saved home on its host
  oats session inspect|attach --server <id>  inspect (envelope) or attach a viewer (ssh PTY) for a
      --instance <name> | --home <abs>       remote instance, by its saved route or the server's
      [--detach-key <key>]                   roster (--print shows attach); oats 0.22.2 or later.
      [--no-status-line]                     attach --detach-key: as below; the server must
                                            advertise session-attach-detach-key.
                                            --no-status-line: as below; a server without
                                            session-attach-no-status-line shows the line
  oats session start --server <id>           start a stopped remote instance in its existing home
      --instance <name> | --home <abs>       by its saved route or the server's roster; it must advertise
      [--model <m>] [--json]                 session-start (oats 0.22.9 or later)
  oats inspect|operation --server <id>        the same commands on a registered server over its
      ... [--dir <remote member>] [--home <abs>]  instance home (an explicit --dir travels as is; a --home
                                            is its own context; else the registered workspace);
                                            the server must advertise operations (oats 0.22.16 or later)
  oats readiness|instance events|git|diff|stop  the Desktop's reads and lifecycle plans, and retire --plan,
      ... --server <id>                      run on the instance's own machine; the host's envelope is
                                            relayed unchanged (the host must advertise the feature)
  oats session upload --server <id>          copy a local file into a remote instance's private
      --instance <name> | --home <abs>       attachments, by its home or name (bytes stream on
      --file <path> [--json]                 ssh stdin; sha256 verified); the server must
                                            advertise session-upload (oats 0.22.13 or later)
  oats onboard [<dir>] --workspace <repo ref> realize a workspace here: writes <dir>/oats-local.yaml
      [--json]                               and agents/, then runs the oats sync path (lock v3)
                                            and prints the
                                            next steps (clone members you work IN, spawn the
                                            workspace's setup expert (the soul holding oats.setup));
                                            creates no soul, spawns nothing; lists <dir> in this
                                            computer's deployments (below)
      [--check]                             --check: write nothing; report <dir> (~ = this home),
                                            its state and whether Git reads the workspace remote
  oats deployments [list] [--json]           this computer's deployments (~/.oats/config/
                                            deployments.json): path, state (ok, missing,
                                            not-a-deployment, unreadable) and how each was listed.
                                            Onboard lists what it creates, and a kernel command run
                                            in an unlisted deployment lists it; ~/Agents is
                                            imported once, on first use
  oats deployments add [<dir>] [--json]      list the deployment at or above <dir> (default: here)
  oats deployments remove <path> [--json]    take <path> off the list (nothing on disk is touched);
                                            nothing lists it again but an explicit add or onboard
  oats deployments import --from desktop <path>... [--json]
                                            the Desktop's one-time import of its own lists
  oats session inspect|input|attach --home <absolute-home> [--text-file <path>] [--json]
  oats session attach --home <absolute-home> [--detach-key <key>] [--no-status-line]
                                            a viewer of one instance. <key> (C-<letter>, M-<letter
                                            or digit>, F1 to F12; 'C-\\' is the suggested one)
                                            leaves it with exit status 20; without one no key
                                            leaves it. Shift+PageUp scrolls back (tmux copy mode:
                                            PageUp, PageDown, q leaves), and so does C-b [ in a
                                            viewer without a key, whose status line says so
                                            (--no-status-line: none); every other key goes to
                                            the agent, C-b and the key after it included
  oats schedule list|show <id>|test <id>|add <id> --file <spec.json>|update <id> --file <spec.json>
      enable|disable|run|remove|reconcile <id>   workspace-scoped, host-owned schedules (spawn,
      tick [--dry-run] [--host]                  command or wake jobs on a five-field cron with an
      host install|uninstall|status              explicit IANA tz; see docs/schedules.md); --server
                                                routes to that host's workspace
        install [--max-concurrent N|default] [--triggers-max-concurrent N|none]
  oats schedule add|update <id> … --description=<text>   a one-line summary (1-200 characters)
  oats schedule update <id> --description=<text>   change only it (--description= clears it)
  oats trigger add (--file <json> | --from <package>:<template> [--set k=v]) | list | show | enable
      | disable | remove <id> | test <id> | poll <id> | status [<id>]   event-driven spawns, polled
                                                by the schedule tick: github.pull_request (the
                                                host's gh) or a capability's <capability>:<source>;
                                                see docs/schedules.md#triggers
  oats trigger test|poll <id> --run-source   run a capability source's command on this host: by
                                                hand, test and poll do it only when asked
  oats trigger add … --description=<text>    a one-line summary (1-200 characters)
  oats trigger update <id> --description=<text>   change only it (--description= clears it)
  oats trigger|schedule add … --workspace <member> --runs-on <host> --owner <host>/<login>
                                                a trigger/schedule declared in Git (<member>/<id>):
                                                writes oats-triggers|oats-schedules/<id>.yaml in a
                                                checkout of the member, else prints it
  oats automations refresh [--json]          re-discover the workspace triggers and schedules
                                                (the snapshot the host tick reads; oats sync does
                                                it too)
  oats spawn ... --wake-file <json> | --wake-every <N> --wake-message <text>  save a wake schedule
                                                bound to the new instance's home (docs/schedules.md)
  oats session upload --file <path>          store a copy of a local file as a private attachment
      --home <absolute-home> [--json]         in the instance home (.oats-attachments/); answers
                                            {path, bytes, sha256}; never types into the session
  oats session receive --home <abs> --name   store attachment bytes read from stdin (the routed
      <file> [--json]                       upload's remote half)
  oats session start --home <absolute-home>  start a STOPPED instance again in its existing home
      [--model m] [--launch-config n|none]  (recorded recipe as is; a selection re-resolves it
      [--harness r] [--yolo|--no-yolo]      against the scope; a named configuration is a unit)
      [--reselect-launch]                   applies the launch preferences now (oats-local.yaml
                                            souls.launch, the soul's launch); a changed preference
                                            never reaches an existing home without it or a respawn
  oats session start --resume --home <abs>   start a home whose session was LOST (a reboot, a dead
                                            tmux server) in its own last conversation, the
                                            recorded launch as is; fresh on TASK.md when none is
                                            found (docs/execution-targets.md#resume-after-a-shutdown)
  oats session resume [--deployment <dir>]   resume every lost session of this computer's
      [--plan] [--json]                     deployments (one sweep per machine; at most 3 resumes
                                            of a home per boot); --plan starts nothing
  oats session restart --home <abs-home>     stop the running harness (SIGTERM, bounded wait,
      [same flags] [--stop-grace <s>]        never escalated) and start it again in place under
                                            the same lock; a stop that is not observed is
                                            reported and nothing is launched
      [--model <m>] [--json]                 (same identity, worktree, notes and launch env; no
                                            spawn hooks); --model replaces the recorded model
                                            for this and later starts; a live harness is refused
  oats spawn <agent> [--task <text> | --task-file <f>]  spawn an instance (tmux; --no-launch
      [--purpose <slug> | --name <slug>]    = scaffold only); the agent is a workspace
      [--repo <path>]                       soul or a capability-defined agent
                                            --purpose derives <agent>-<purpose>;
                                            --name is exact (no prefix), unused in the
                                            deployment, a slug and not a soul name
      [--dir <scope>] [--agents-root <abs>] deployment scope; --agents-root must match
                                            that deployment's agents root
      [--parent <instance>]                 sugar for --relative-to X --relation child
      [--relation child|sibling|parent|unrelated]  anchor with --relative-to (except unrelated);
      [--relative-to <instance>]            default: unrelated, top-level
      [--relative-root <agents-root>]       disambiguates same-named anchors
      [--same-work]                         record that the new instance does the same work as
                                            its parent; clients draw the parent line for it
                                            (needs a relation that records a parent)
      [--work worktree|checkout|attached|workspace|directory]  override the soul's work mode
      [--work-dir <owner-work>]             attached: the owner's work tree (always a child)
      [--branch <b>] [--base <ref>]          worktree branch and starting ref;
                                            --base: worktree only; defaults to the soul
                                            commit observed by spawn (#445)
                                            directory: owned home/work, config context may
                                            be non-Git; rejects --work-dir and --branch
      [--harness pi|claude|codex] [--launch-config <name>|none]  explicit launch selection;
                                            otherwise oats-local.yaml souls.launch.<soul>,
                                            then souls.launch."*", then the soul's launch:, then pi;
                                            a harness uses its host default configuration if set;
                                            none selects the bare harness; a named configuration
                                            is a unit (a conflicting --harness is refused)
      [--model <id>|@native-default]        override the selected model; @native-default
                                            selects the harness's own model default
      [--backend tmux] [--yolo|--no-yolo]    session backend and launch permission option
      [--background|--no-background]        list the instance under Background (presentation
                                            only); default: the soul's background:, else no
      [--no-launch] [--json]                 scaffold without launching; JSON result envelope
      [--allow-child-spawns|--no-child-spawns]  this instance's child-spawn policy (default:
                                            allowed); enforced by OATS, not an OS sandbox
      [--provider <capability> <key>=<value>]  a provider setting for this spawn only
                                            (repeatable; dotted keys nest; recorded in
                                            instance.json providers.<capability>)
      [--preview]                           decide everything, create no instance; --json
                                            includes the decision revision for confirmation
      [--suggest-name]                      no --name, --purpose or --expect-decision: the
                                            soul's harness, on the machine that spawns, names
                                            the instance for its task (<descriptive>-<role>,
                                            made unique); else it is numbered, and
                                            naming.reason says why (claude and pi); on a
                                            preview or an apply
      [--expect-decision <rev>]              bind apply to the previewed decision; drift refuses
      [--idempotency-key <key>]              with --expect-decision, replay the completed receipt
                                            for the same key and confirmed decision; a different
                                            decision conflicts, an unfinished spawn refuses
      [--max-age <s>]                       reuse heads up to <s> seconds old (0-86400; 0 live),
                                            on preview or --expect-decision apply only;
                                            refused with --server; decision binding still holds
      [--wake-file <json-file> | --wake-json <json-text>]  wake object: {cron, tz, message, enabled}
                                            --wake-json wins over --wake-file; either overrides
                                            --wake-every and --wake-cron
      [--wake-every <N> | --wake-cron <expr>]  alternative: cron */N minutes (1-59) or explicit cron
                                            requires --wake-message <text> or --wake-message-file <f>;
                                            --wake-message-file wins over --wake-message
      [--wake-tz <zone>]                     optional for cron/every (default: local zone);
                                            saved after spawn, bound to the new home
      --runtime <harness>                    compatibility alias for --harness (deprecated)
      --instance <name>                      compatibility token for older routed hosts;
                                            refused locally: use --purpose or --name
      --trigger-event <json-file>            internal trigger-runner event input, copied to
                                            <home>/.oats/trigger-event.json, exposed through
                                            OATS_TRIGGER_EVENT_FILE and recorded in
                                            instance.json.trigger (docs/schedules.md)
      [--help|-h]                            global help switches: show usage and exit
  oats spawn <agent> ... --server <id>        routed spawn on the server's installed oats;
                                            --server is consumed before the local flag scanner
  oats retire <instance> [--force]           retire an instance (window, hooks,
      [--self]                              worktree, home); --self = retire the
      [--keep-dir] [--json]                 CALLING instance: the window dies, then
                                            a detached external retirement runs
  oats inspect [--dir <scope>] [--soul <name>   one authoritative JSON answer for a GUI: souls
      [--agents-root <abs>]] [--home <abs>]   (harness defaults, editability, instructions),
      [--instructions] [--skills]           installed capabilities with health, effective
      [--composed-skills] [--max-age <s>]   layer bindings and activation, declared
      [--json]                              operations with availability; --home answers the
                                            running home's recorded modules and their drift
                                            from the deployment; --instructions (--soul only)
                                            adds the AGENTS.md a spawn of the soul here would write;
                                            --skills (--soul only) adds the soul's own skills, the
                                            ones a spawn copies, with each file's text;
                                            --composed-skills (--soul only) adds every skill a spawn
                                            would give the instance, its capabilities' included
  oats operation run <layer>:<name>          run an operation the soul's core capability for that
      (--home <abs> | --soul <name> [--dir <d>])  layer declares (knowledge:harvest, knowledge:
      [--arg k=v ...] [--json]              inspect ...): resolved from the home's recorded
                                            modules or the deployment's soul, trust checked, the provider's
                                            own command run in the home or scope, envelope
                                            relayed; a view answers {documents: [...]}
  oats harness trust [--dir <deployment>]  explicitly trust one canonical deployment root
      [--harness claude|codex|all]         in every native configuration file a launch reads
      [--plan] [--json]                   (the ambient one and each launch configuration's
                                            CLAUDE_CONFIG_DIR / CODEX_HOME); --plan reads only,
                                            bare command applies with a durable audit
  oats launch-config list [--dir <scope>     named launch configurations effective at a scope,
      | --home <abs> | --soul <name>]       a home's recorded context or a soul's own scope:
      [--agents-root <abs>] [--json]        harness, executable, args, env (values redacted,
                                            references shown), model, yolo; the closest
                                            declaring scope provides the whole entry
  oats launch-config set <name> --file <j>   declare or replace one at this scope from a JSON
      [--keep-env] [--dir <scope>] [--json] file (only the launch-configs block is rewritten;
                                            --keep-env copies the effective definition's env)
  oats launch-config remove <name>           remove this scope's declaration; an ancestor's,
      [--dir <scope>] [--json]              if any, becomes effective again
  oats launch-config preview                 what a start would run: resolved harness, model,
      (--home <abs> | --soul <name>)        yolo, executable, argv, environment (redacted),
      [--launch-config <name>|none]         command and preflight; read-only, nothing
      [--harness r] [--model m]             started; a named configuration is a unit, so
      [--yolo | --no-yolo] --json           a disagreeing --harness is refused
  oats doctor [dir] [--soul <name>] [--json] resolved targets and offline capture warnings;
                                            --soul shows final composed AGENTS.md only
  oats update [--check] [--yes]              check npm for a newer kernel and move the pi bridge
      [--dir <deployment>]                  in every pi folder the deployment's launches use
                                            (docs/upgrading.md); then run oats doctor
  oats sync [--dir <d>] [--plan] [--json]    workspace model v2: observe the workspace named by
                                            oats-local.yaml over its Git remote, confirm every
                                            member (reciprocal oats-membership.yaml), resolve
                                            packages: to exact commits + integrity, write
                                            oats-lock.json (v3) and report the diff. --plan:
                                            the same report, nothing written (what a bare sync
                                            would change). No approval step: declaring a
                                            package in packages: is the trust decision
                                            (--approve is E_BAD_ARGS)
  oats package add <id> <version|git:<repo>@<ref>>  edit packages: in oats-workspace.yaml when the
      | remove <id>  [--dir <d>]            workspace repo is the current checkout; otherwise
                                            print the line to add (the file travels through Git)
  oats workspace status [--dir <d>] [--json] membership table (confirmed / no-backlink /
      [--max-age <s>]                       cannot-read / backlink-elsewhere), locked packages
  oats capabilities [--dir <d>] [--json]     every capability of every confirmed member (a
      [--max-age <s>]                       private one is listed as repo-owned: usable only by
                                            its own repo's souls) + the locked packages
  oats capabilities show <name> [--member <repoKey> | --package <id>] [--file <path>]
      [--dir <d>] [--json] [--max-age <s>]  what one capability of that list ships, at its commit:
                                            its inject (text) and each skill's files (sizes);
                                            --file <path>: one listed file's text
  oats souls [--dir <d>] [--json]            every soul of every confirmed member + external souls
      [--max-age <s>]                       (souls have no private mode), with origin
                                            (member <key> @ <commit> | package <id> v<ver>) and its
                                            teams on this deployment
  oats teams [--json] | add <label> --team <id> [--description <d>] [--no-default] | remove <label>
      | default <label> [--if-absent | --expect <label>]
      [--dir <d>]                           this deployment's teams (shared + local), the
      [--max-age <s>] (the read form only)  default, the workspace's souls:; add/remove/default
                                            edit oats-local.yaml (only with localTeams: true);
                                            --no-default: the mapping only (an exact repeat is
                                            reuse); --if-absent / --expect: set the default only
                                            where there is none / it is <label>
  oats soul teams <soul>|'*' [--dir <d>]    which teams a soul may join here, its default, and
      [--max-age <s>] [--json]              why (the workspace's souls: and local teams)
  oats soul launch set <soul>|'*' (--launch-config <name>|none | --harness pi|claude|codex [--model <id>])
      [--plan] [--dir <d>] [--json]         pin a soul's launch on this machine: writes its key
                                            (its bare name, or <package>/<soul>; '*' = every soul
                                            without an entry) in oats-local.yaml souls.launch.
                                            The file is rewritten; every other entry keeps its
                                            value and its comments. --plan: every check, nothing
                                            written. It reads the workspace live (no --max-age)
  oats soul launch remove <soul>|'*'|<exact key> [--plan] [--dir <d>] [--json]
                                            remove one entry of souls.launch: a soul's, '*', or
                                            the exact text of a key in the file (that form works
                                            when the workspace's souls cannot be read, and is how
                                            a key that names no soul is removed); no such entry is
                                            E_LAUNCH_PREFERENCE_UNKNOWN
  oats instance git <instance> [--home <abs>] [--dir <d>] [--json]
                                             read-only Git observation of the instance's work
                                             tree: branch, status (renames kept), ahead/behind
                                             vs upstream AND vs default-branch merge-base
  oats instance diff <instance> --file <id> --revision <rev> [--index-revision <rev>] [--home <abs>] [--dir <d>] [--json]
                                             bounded diff of one observed file; refuses when
                                             the tree moved since the observation
  oats instance events <instance> [--limit <n>] [--since <iso>] [--json]
                                             typed lifecycle events (spawned, launched, stopped,
                                             restarted, retired, worktree-retained…) written by
                                             the action that made them true; nothing inferred
  oats instance waiting <set|clear> --producer <id> [--reason permission|question|attention] [--message <text>] [--home <abs>] [--dir <d>] [--json]
                                             a producer's claim that the instance needs input
                                             from a human; appended only on change; display only
  oats instance attention [--message <text>] [--clear] [--json]
                                             run by the agent from its home: "I need a human's
                                             answer" (waiting --producer agent --reason attention)
  oats instance upgrade <instance> --plan [--undo] [--json]
      Preview package module moves and provider adoption; session must be stopped.
  oats instance upgrade <instance> --plan-revision <rev> --idempotency-key <key> [--undo] [--json]
      Move whole package modules to the verified lock; --undo uses the latest previous copies.
  oats instance stop <instance> --plan [--no-recursive] [--json]
                                             what Stop would touch: session state, recorded
                                             children, dirty work; a planRevision to apply
  oats instance stop <instance> --apply --plan-revision <rev> --idempotency-key <key>
                                             quiesce (SIGTERM, bounded, never escalated),
                                             children first; home/work/launch retained
  oats instance color <instance> (<color> | --clear) [--home <abs>] [--json]
                                             the instance's colour, presentation only: sand,
                                             sage, slate, mauve, clay or olive; --clear removes it
  oats instance background <instance> on|off [--home <abs>] [--json]
                                             whether clients list the instance under
                                             Background, presentation only
  oats instance same-work <instance> on|off [--home <abs>] [--json]
                                             record that this instance does the same work as
                                             its parent (on needs a recorded parent); clients
                                             draw the parent line for it; off removes it
  oats instance suggest-name --soul <soul> (--task <t> | --task-file <f>) [--harness claude|pi]
      [--model <m>] [--launch-config <n>] [--dir <d>] [--json]
                                             a name for a spawn of <soul> (only a name: it gives
                                             the role) by this machine's harness, as a preview's
                                             --suggest-name chooses it, not made unique (where it
                                             lands decides that); else numbered, and naming.reason
                                             says why. Reads only this machine's launch
                                             configurations; writes and reserves nothing; no --server
  oats worktree add --purpose <p> --branch <b> --base <remote-branch>  from an instance home: make the
      [--repo <member key|clone path>]      extra tree <home>/.work-<p> on a new branch at origin's
      [--preview] [--json]                  <base> (the clone's refs are not moved), then run the
                                            worktree hooks of the home's capabilities (they may take
                                            minutes; their output goes to stderr and .oats/logs/);
                                            again with the same arguments: a no-op; --preview:
                                            the clone, path, branch, base and hooks, nothing done
  oats worktree remove --purpose <p> [--json]  git worktree remove of a tree made by add (a dirty
                                            tree is refused: E_WORKTREE_DIRTY; so is the work of an
                                            attached instance whose session is running or cannot
                                            be read: E_CHILDREN_RUNNING); the branch is kept
  oats readiness (--soul <n> | --home <abs>) [--policy] [--json]
                                             readinessApi 2 for a soul or an instance home:
                                             installed | configured | member | providers, each
                                             pass|fail|unknown|not-applicable with items and
                                             remedies; providers relays each bound provider's
                                             own check ({status, problems, warnings});
                                             --policy: enforced child-spawn / worktree policy
                                             with origins (captured homes refuse: the
                                             captured/portable path was removed in 0.26)
  oats retire <instance> --plan [--json]     what Remove would touch, with retention defaults
  oats retire <instance> [--plan-revision <rev> --idempotency-key <key>] [--discard-worktree]
                                             with a plan revision: refuses E_PLAN_STALE (fresh plan
                                             attached) if facts moved; a repeated key replays
                                             retire; a worktree is RETAINED (re-homed under
                                             <workspace>/.agents/worktrees/<repo>/<branch>)
                                             unless discarded; no retire deletes a branch
                                             (--delete-branch is refused)
  oats root                                  print this package's install root
                                            (adapters resolve the kernel from it)

The turn record (core — every conversation captured, searchable, replicated):
  oats capture [--watch|--status]            land Claude Code/pi/codex sessions and aw
      [--owner <name>] [--root <dir>]       client logs in the record: one bounded
                                            supervised reconciliation pass; partial
                                            passes exit 0 with work pending
  oats capture --hook                        launch a detached pass; exit 0 means
                                            capture launched, not completed
  oats capture --health [--json]             offline installation, run and issue
                                            diagnosis; captures nothing
  oats capture --file <path> --format cc|pi|codex --home <instance home> [--json]
                                            one session file (an archived session),
                                            captured as --home capture would
  oats recall [--kind k] [--thread t]        search the whole record — mail, chat,
      [--from f] [--show id] <query>        sessions — with exact turn provenance
  oats setup [--owner <name>] [--root <dir>] [--replace-service]
      [--no-service] [--no-hooks] [--dry-run]
                                            install hooks + periodic capture
                                            (launchd/systemd), then run the first pass

  oats experimental <dress|spawn|segments|mind>   EXPERIMENTAL tools over the record —
                                            selection and agent synthesis; unproven by
                                            design, repo checkout only; see
                                            packages/experimental/README.md

  oats <namespace> <command> [args…]         run an operational command only when its
                                            capability is active (e.g. oats okf harvest)

Observation reuse (feature observe-max-age):
  --max-age <seconds>                        on the read verbs only — status, workspace status,
                                            souls, capabilities, inspect --soul|--home,
                                            spawn --preview (feature spawn-preview-max-age),
                                            and the read forms of teams and soul teams —
                                            reuse a remote head observation up to <seconds>
                                            old (0–86400; 0 is live) instead of asking the
                                            remote again; the JSON
                                            then carries observation { observedAt (the oldest
                                            head used), reused, localRevision (a digest of
                                            the local configuration read) }. A spawn apply
                                            bound by --expect-decision takes it too (feature
                                            spawn-apply-max-age): its decision fence holds,
                                            and its JSON carries no observation. Refused
                                            (E_BAD_ARGS) by every other command, an edit form,
                                            a spawn apply without --expect-decision, and with
                                            --server

Layers: ${LAYERS.join(", ")}. Workspace model v2: docs/design/2026-09-23-workspace-module-contracts.md.`;
}
} catch (e) {
  // After a retire has returned, nothing is answered as an error, a typed failure included (the dispatch).
  if (retireReturned || !TYPED_CLI_FAILURES.has(e?.code)) throw e;
  // Same two renderings as every other typed failure: one envelope on stdout in
  // --json mode, one `oats: <message>` line on stderr otherwise. The message
  // already names the offending file — the readers re-raise it with one.
  if (JSON_MODE) jsonFail(e.code, e.message, e.details?.unconfirmed === true ? e.details : undefined);
  die(e.message);
} finally {
  // The command's read session: every `git cat-file --batch` child ends before the process does.
  sayReadNotices();
  if (readSession) await readSession.close();
}
