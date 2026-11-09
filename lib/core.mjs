/**
 * lib/core.mjs — runtime-neutral OATS library (souls & instances, config cascade,
 * capabilities, lifecycle hooks). No pi imports: consumed by both the standalone
 * `oats` CLI (bin/oats.mjs) and the pi extension adapter (extension/index.ts).
 *
 * An "agents root" is the CLOSEST directory named `agents/` found by walking up
 * from cwd (or $PI_AGENTS_ROOT). The root's parent is the "workspace" (scope);
 * soul `repo` paths resolve relative to it. On the workspace model it is
 * <deployment>/agents/.
 *
 * Layout:
 *   <scope>/agents/<agent>/soul/       canonical body: soul.yaml, AGENTS.md (canonical; CLAUDE.md → AGENTS.md),
 *                                      skills/, knowledge/ (OKF bundle)
 *   <scope>/agents/<agent>/instances/<inst>/  instance HOME: generated AGENTS.md, CLAUDE.md → AGENTS.md,
 *                                      .agents/skills (canonical; .claude/skills → ../.agents/skills); no soul link —
 *                                      instance.json soulDir records the soul directory,
 *                                      work/ (worktree or symlink), TASK.md, STATE.md, log.md, notes/, instance.json
 *   <scope>/agents/<agent>/instances/  a capability-defined agent (its soul is read-only in its
 *                                      module): the dir holds only instances/.
 *   <scope>/local-agents/              OATS 0.25 and earlier: never read, spawned into or retired
 *                                      from; only detected (status/doctor report it as
 *                                      `legacy-local-agents`).
 *
 * soul.yaml (flat key: value):
 *   name, description, kind (persistent|local), type (optional agent-type/family, targeted by config),
 *   repo (path rel. to workspace or absolute),
 *   work (worktree|checkout|attached|workspace|directory), harness (pi|claude|codex), model (pi model pattern, optional)
 *   (attached as soul default is for service agents — spawn must supply workDir)
 */
import { canonicalHomePath, realPathOrNearest } from "./real-path.mjs";
import { createLaunchPromptController, neverSettled } from "./launch-prompts.mjs";
import { retainLaunchPromptFrame } from "./launch-prompt-evidence.mjs";
import { launchPromptEngages, claudeVersionOf, CLAUDE_SESSION_HINT } from "./launch-prompt-fixtures.mjs";
import { LAUNCH_PANE_FORMAT, launchPaneTarget, launchPromptTransport } from "./launch-prompt-transport.mjs";
import { execFileSync, execSync, spawn as spawnProcess, spawnSync } from "node:child_process";
import {
  chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { accessSync, constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { initializeNativeHistory, prepareNativeStart } from "../packages/record/lib/native-history.mjs";
import { sameDirectory } from "../packages/record/lib/directory-identity.mjs";
import { noteRuntimeName } from "./deprecation.mjs";
import { attachSessionTarget, requireDetachKey } from "./session-viewer.mjs";
import { AGENT_PANE_OPTION, inspectSessionTarget, inputSessionTarget, resolveAgentPane } from "./session-input.mjs";
import { RETIRE_HOOK_WARNING_KIND, appendEvent, incarnationOf, recordStartBoundary, retireRefusedReason } from "./instance-events.mjs";
import { killGroup } from "./process-group.mjs";
import { NAMING_CALLS, NAMING_TIMEOUT_MS, suggestInstanceName } from "./instance-naming.mjs";
import { interruptExitStatus, isStartToken, originRemoteOf, runWorktreeHooks, selfIdentity, processLiveness, processStartToken, signalGuard, terminateRecordedGroup, treeStillThere, unknownGroupNote, unverifiedGroupWarning, worktreeHooksOf } from "./worktree-hooks.mjs";
import { CLAIM_WAIT_MS, acquireClaim, claimUnavailable, claimUnheld, claimWrite, readClaim, releaseClaim, removeGoneClaim, shownHolder, unwritableCode } from "./claim.mjs";
import { captureLoginEnvironment } from "./login-environment.mjs";
import { kernelNode } from "./stable-node.mjs";
import { assertNoPartialUpgrade, packageRespawnWarning, packageUpgradeDrift, upgradeCleanupWarnings, upgradeMutexRetry, UPGRADE_RECEIPT_NAME_RE } from "./upgrade-state.mjs";

import { oatsError, afterEndedSteps, afterFirstEffect, asKernelError, BEFORE_EFFECT_CODES, checkHolderByHand, errorCause, ifItDoesNotEnd, isAnswerCode, isKernelCode, kernelCode, lifecycleBusy, nothingAfter, reportDefect, OWN_NAME_FAILURES, OWN_START_REMEDY, herdrInstanceBusy, herdrInstanceRemoved, herdrSettingRemoved, HERDR_REMOVED } from "./errors.mjs";
import { envRows, recordedTeams, teamsEnv } from "./teams.mjs";
import { PANE_PATH_FIX, harnessNotOnPanePath, harnessUnavailable, launchConfigAmbiguous, launchConfigUnknown, launchConfigUnknownFix, launchLayers, launchPreferenceUnmatched, launchPreferenceUnmatchedProblem, launchReport, selectionFrom } from "./launch-preference.mjs";
import { shq, shellWord } from "./shell-word.mjs";
import { CONFIG_DIR_VAR, HARNESS_FOLDER_VAR, claudeTrusts, codexTrustsRoot, harnessConfigFile, harnessTrustWarning, launchConfigFolder } from "./harness-trust.mjs";
async function materializePreparedDefault(prepared, home) { const m = await import("./instance-resolution.mjs"); return m.materializePrepared(prepared, home); }
async function plannedSkillsDefault(prepared) { const m = await import("./instance-resolution.mjs"); return m.plannedPreparedSkills(prepared); }
// Capability rows for a PREPARED spawn (workspace model): the one function that
// turns a Resolution's modules into the row shape hooks/environment/requirements/
// retirement consume. Called twice per spawn — PLANNED before the home exists
// (manifest, settings, origin, trust; no skills/inject since the copies are not
// there yet) and REBUILT after materialize against what actually landed. Static
// import: instance-resolution.mjs does not depend on core.mjs (no cycle).
import { cloneRemoteFor, deploymentLock, resolutionContractWarnings, toCapabilityRows, verifyMemberClone } from "./instance-resolution.mjs";
import { GIT_FETCH_TIMEOUT_MS, GIT_TIMEOUT_MS, gitEnv } from "./remote.mjs";
import { loadLocal, loadMachineLaunchConfigs } from "./workspace.mjs";
import { renderInstructionText } from "./instruction-composition.mjs";
import { APPROVED_HOOKS, PORTABLE_ENV_NAME_RE, CORE_LAUNCH_ENV, PROCESS_BOOTSTRAP_ENV, PROCESS_BOOTSTRAP_PREFIXES, manifestContractProblems, disposableHomeRootProblem, disposableHomeRootMatches, contractWarningMessages, locatedContractWarnings } from "./capability-contract.mjs";
import { validateBindingInterface } from "./provider-binding.mjs";
/** Retirement/rollback tree fingerprint (exported for scope tests: kernel-field neutrality is opt-in per instance home),
 *  the exact digest a copied path is compared with (exported so a test holds it to the copier),
 *  a worktree's byte digest and the Git directories it leaves out (exported so a test holds them to exact paths),
 *  the receipts the stored digest passes over in a home (exported so a test holds the manifest grammar to refusing each of them),
 *  and a worktree's untracked and ignored digest, alone and with its bytes from one read (exported so a test holds the one read to the two apart). */
export { exactTreeDigest, fingerprintTree, generatedWorkDigest, KERNEL_HOME_RECEIPTS, storedTreeDigest, worktreeBytes, worktreeDigests, worktreeGitPaths };

import { canonicalJson, parseStrictJson } from "./canonical-json.mjs";
import { readPortableBytes } from "./bounded-read.mjs";
import { copyTreeSafe, entriesAsBytes, joinBytes, pathBytes, treeDisagreement } from "./tree-copy.mjs";
import { readAheadConsumed, readingAhead } from "./read-ahead.mjs";
import { hashFile, readFilePieces, readFileUpTo } from "./file-pieces.mjs";
import { assertSameWorktreeHead, gitRead, gitRefPresence, gitRepoRead, gitRepoRun, headName, worktreeCommitUnreached, worktreeHead } from "./instance-git.mjs";
import { systemTool } from "./system-tools.mjs";
import { SCOPE_ENV_NAMES, agentScope, agentScopeArgv, agentScopeUnit, creatorPlacement, serverScopePlan, serverScopeUnit, serverScopeWarning } from "./tmux-server-scope.mjs";
import { writeThroughPrivateFile } from "./write-through-private-file.mjs";
import { readInstanceBackground, writeInstanceBackground } from "./instance-background.mjs";
import { SAME_WORK_FILE, writeSameWork } from "./instance-same-work.mjs";
import { readStartExited, sessionEndOf, START_EXITED_FILE, STOP_RECEIPT_FILE } from "./session-end.mjs";
import { FRESH_REASON, RESUME_WAITING, SESSION_END } from "./session-resume-contract.mjs";
import { START_ENV_FILE, START_ENV_KEY_FILE, START_ENV_TMP, checkStartEnv, fromEnvNames, launchEnvChangedMessage, launchEnvMissingMessage, launchEnvUnverifiedWarning, recordStartEnv } from "./start-env.mjs";
import { watchResumeConfirmation } from "./launch-prompt-resume.mjs";
import { lastConversation } from "../packages/record/lib/last-conversation.mjs";
import { PKG_ROOT } from "./version.mjs";
import { canonicalDeploymentPath } from "./deployment-path.mjs";
import { INSTANCE_NAME_RE, RESERVED, capabilityAgentDirs, enclosingInstanceHome, findInstanceHomes, listAgents, logicalCwd, readSoul, soulOf, stripInternalAnnotations, withConfigFile, yamlKey } from "./soul-listing.mjs";
import { RETIRE_BASELINE_VERSION, authorityMismatch, findRetirementBaseline, inspectInstanceSession, instanceSessionTarget, instancesRetirementRoot, isPlainObject, launchStateAgrees, missingSessionReceipt, readJsonOrUndefined, receiptHomeIdentity, receiptRecordsHome, recordsHerdr, refuseHerdrHome, retirementBaselinePath, runtimeAuthorityOf, tmuxEndpointAgrees } from "./session-inspect.mjs";
import { CLAIM_VERBS, DEFAULT_TMUX_SESSION, LAUNCH_RECIPE_VERSION, claimAction, defaultTmuxWindows, deferredRetireResultPath, directoryRollbackPath, hostProcesses, isCapturedHome, lookupOnPath, missingSocketUnestablished, namedProcesses, parseLaunchCommand, procReadable, processesWorkingIn, readHomeRecord, readRetirePending, redactLaunchCommand, redactLaunchRecipe, retireClaimPath, retirePendingMarkerPath, retireStateOf, subdirs, tmuxFailure, tmuxOn, tmuxServerAbsence, unreadableRecordSaid, upgradeHomeMeta, upgradeLaunchRecipe } from "./instance-listing.mjs";
import { LAYERS, PACKAGE_ID_RE } from "./package-catalog.mjs";
import { RESERVED_LAUNCH_ENV } from "./reserved-launch-env.mjs";
import { workspaceOf } from "./agents-root.mjs";
export { RESERVED_LAUNCH_ENV } from "./reserved-launch-env.mjs";
export { LAYERS, officialCapabilityAliases, officialCatalogFile, officialPackageCatalog, parsePackageCatalog } from "./package-catalog.mjs";
export { DEFAULT_TMUX_SESSION, IDENTITY_LAUNCH_ENV, LAUNCH_RECIPE_VERSION, deferredRetireResultPath, isCapturedHome, legacyCapturedHomes, legacyLocalAgents, listInstances, parseLaunchCommand, readHomeRecord, recordedKernelBin, redactLaunchCommand, redactLaunchRecipe, retireClaimPath, retirePendingMarkerPath, servedIdentityLine, servedIdentityOf, upgradeHomeMeta, upgradeLaunchRecipe } from "./instance-listing.mjs";
export { findRetirementBaseline, inspectInstanceSession, retirementBaselinePath } from "./session-inspect.mjs";
export { RESERVED, assertSafeConfigKey, enclosingInstanceHome, findInstanceHomes, listAgents, logicalCwd, parseYamlFlat, soulHarnessField, stripInternalAnnotations, withConfigFile } from "./soul-listing.mjs";
export { canonicalAgentsRoot, ensureRoot, findRoot, workspaceOf } from "./agents-root.mjs";
export { canonicalDeploymentPath } from "./deployment-path.mjs";
export { OATS_VERSION, PKG_ROOT } from "./version.mjs";
// Keep the existing public core surface; internal data helpers are not re-exported.
export { oatsError } from "./errors.mjs";
export { copyTreeSafe } from "./tree-copy.mjs";

/** The work modes spawn accepts — also the enum a quarantine cleanup descriptor
 * must satisfy, so the retry cannot skip Git cleanup on an unrecognised value. */
export const WORK_MODES = ["worktree", "checkout", "attached", "workspace", "directory"];
/** The instances directories under the agents root `root`: `<root>/<agent>/instances`, one per
 *  agent directory, whether or not it exists. */
export function instancesDirs(root) {
  return subdirs(root).map((agent) => join(root, agent, "instances"));
}
/** The instance homes under the agents root `root` (a directory <root>/<agent>/instances/<name>
 *  whose instance.json records that name) that other users on the machine can read or enter (any
 *  group or other permission bit): one `home-readable` problem naming them, with the exact chmod,
 *  or null. A home holds identity keys, TASK.md and transcripts; spawn creates it 0700. Only
 *  reported: the operator decides. */
export function readableInstanceHomes(root) {
  if (!root) return null;
  const homes = [];
  for (const agent of subdirs(root)) for (const name of subdirs(join(root, agent, "instances"))) {
    const home = join(root, agent, "instances", name);
    try {
      if (JSON.parse(readFileSync(join(home, "instance.json"), "utf8"))?.instance !== name) continue;
      if (lstatSync(home).mode & 0o077) homes.push(home);
    } catch { /* no readable instance.json, or gone meanwhile: not a home */ }
  }
  if (!homes.length) return null;
  homes.sort();
  const fix = `chmod 700 ${homes.map(shq).join(" ")}`;
  return { code: "home-readable", homes, fix,
    message: `${homes.length} instance home${homes.length === 1 ? " can" : "s can"} be read by other users on this machine (${homes.length === 1 ? "it holds" : "they hold"} identity keys, TASK.md and transcripts); fix: ${fix}` };
}
/**
 * The tmux session a NEW tmux launch opens its window in (0.31): the caller's, else the deployment's
 * oats-local.yaml `session.tmuxSession`, else OATS_TMUX_SESSION, else PI_AGENTS_TMUX_SESSION, else
 * oats-agents, read from `env` at call time. A launched home keeps the session it recorded: session
 * start/restart never read this.
 */
export function sessionDefaults(dir, { tmuxSession } = {}, env = process.env) {
  let local = null;
  try { local = loadLocal(dir); } catch (e) { if (e?.code !== "E_LOCAL_MISSING") throw e; }
  const declared = local?.local?.session ?? {};
  return { tmuxSession: tmuxSession || declared.tmuxSession || env.OATS_TMUX_SESSION || env.PI_AGENTS_TMUX_SESSION || "oats-agents" };
}
/** Skills shipped with the kernel. Only oats-getting-started is ambient; spawn composes selected skills locally. */
export const PACKAGED_SKILLS_DIR = join(PKG_ROOT, "skills");

// ---------- shell helpers ----------
function sh(cmdline) { return execSync(cmdline, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function shTry(cmdline) { try { return sh(cmdline); } catch { return undefined; } }
/** The branch spawn records for an attached or checkout instance (#641): the
 *  name HEAD carries as headName reads it, or null when HEAD is detached or
 *  names a ref OATS carries no branch name for. Never the word "HEAD". A HEAD
 *  that cannot be read (not a Git tree) records none, as before. */
function recordedHeadBranch(dir) { try { return headName(dir).branch; } catch { return undefined; } }
/** A native PROBE (a harness binary asked about its catalogue or packages) under
 *  a preview: bounded by what is left of the shared preflight budget, run in its
 *  own process group and group-killed on timeout. Cheap lookups (`command -v`)
 *  are not probes and never draw from the budget. Outside a preview: shTry. */
function probeTry(cmdline) {
  if (!previewPreflightBudget) return shTry(cmdline);
  const left = previewPreflightBudget.deadline - Date.now();
  if (left <= 0) { previewPreflightBudget.exhausted = true; return undefined; }
  const r = spawnSync("/bin/sh", ["-c", cmdline], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: left, killSignal: "SIGKILL", detached: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false" } });
  if (r.error || r.signal) { killGroup(r); if (r.error?.code === "ETIMEDOUT" || r.signal === "SIGKILL") previewPreflightBudget.exhausted = true; return undefined; }
  return r.status === 0 ? String(r.stdout).trim() : undefined;
}
let previewPreflightBudget = null;
/** execFileSync for a native probe: under a preview budget, the timeout is what
 *  is left of it and the child is group-killed; otherwise the caller's timeout. */
function probeExecFile(file, args, options = {}) {
  if (!previewPreflightBudget) return execFileSync(file, args, options);
  const left = previewPreflightBudget.deadline - Date.now();
  if (left <= 0) { previewPreflightBudget.exhausted = true; throw Object.assign(new Error("preflight budget exhausted"), { code: "E_PREFLIGHT_BUDGET" }); }
  const r = spawnSync(file, args, { ...options, timeout: Math.min(left, options.timeout ?? left), killSignal: "SIGKILL", detached: true });
  if (r.error || r.signal) { killGroup(r); if (r.error?.code === "ETIMEDOUT" || r.signal === "SIGKILL") previewPreflightBudget.exhausted = true; throw r.error || Object.assign(new Error("probe killed"), { code: "E_PREFLIGHT_BUDGET" }); }
  if (r.status !== 0) throw Object.assign(new Error(`probe exited ${r.status}`), { status: r.status, stdout: r.stdout });
  return r.stdout;
}
function shIn(cwd, cmdline, timeout = 45000) {
  return execSync(cmdline, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout }).trim();
}
function shInTry(cwd, cmdline, timeout) { try { return shIn(cwd, cmdline, timeout); } catch { return undefined; } }
// The shell quoting of a printed command lives in lib/shell-word.mjs, which imports nothing, so that
// lib/launch-preference.mjs (imported here) quotes by the same rule.
export { shq, shellWord };
export function slug(s) {
  const r = String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return r || "agent";
}
/** `command -v <bin>`, once per (bin, PATH) in this process: the answer only changes with PATH. */
const whichMemo = new Map();
function which(bin) {
  const key = `${bin}\0${process.env.PATH ?? ""}`;
  if (!whichMemo.has(key)) whichMemo.set(key, shTry(`command -v ${shq(bin)}`));
  return whichMemo.get(key);
}


/** Small dependency-free YAML subset used by oats-config.yaml.
 * Supports nested maps, namespaced/quoted keys, booleans, numbers, and inline arrays/maps. */
function yamlScalar(raw) {
  const trimmed = raw.trim();
  // A double-quoted scalar is read with JSON's escape rules (what the CLI
  // writes for values with spaces, quotes or metacharacters); a single-quoted
  // one with YAML's doubled-quote rule. A trailing comment never cuts a
  // quoted value. Anything the escape rules refuse falls back to the raw text
  // between the quotes, as before.
  if (trimmed.startsWith('"')) {
    let i = 1, esc = false;
    for (; i < trimmed.length; i++) { const c = trimmed[i]; if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') break; }
    if (i < trimmed.length) { const q = trimmed.slice(0, i + 1); try { return JSON.parse(q); } catch { return q.slice(1, -1); } }
  }
  if (trimmed.startsWith("'")) {
    let i = 1, out = "";
    for (; i < trimmed.length; i++) { const c = trimmed[i]; if (c === "'") { if (trimmed[i + 1] === "'") { out += "'"; i++; continue; } break; } out += c; }
    if (i < trimmed.length) return out;
  }
  // Inline collections are split quote- and nesting-aware, so an element
  // may carry commas, "#" or nothing at all; a trailing comment after the
  // closing bracket is dropped, one inside quotes is kept.
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const close = inlineCollectionEnd(trimmed);
    if (close > 0) {
      const inner = trimmed.slice(1, close);
      const parts = splitInline(inner);
      if (trimmed[0] === "[") return parts.map((v) => yamlScalar(v));
      const out = {};
      for (const part of parts) {
        const i = inlineKeyEnd(part);
        if (i < 0) continue;
        const key = yamlKey(part.slice(0, i).trim().replace(/^["']|["']$/g, ""));
        out[key] = yamlScalar(part.slice(i + 1));
      }
      return out;
    }
  }
  const val = trimmed.replace(/\s+#.*$/, "").trim();
  if (/^(true|false)$/i.test(val)) return val.toLowerCase() === "true";
  if (/^(null|~)$/i.test(val)) return null;
  if (/^-?\d+(\.\d+)?$/.test(val)) return Number(val);
  return val.replace(/^["']|["']$/g, "");
}
/** Index of the bracket closing the inline collection that opens `s`, or -1. */
function inlineCollectionEnd(s) {
  let depth = 0, quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === "\\" && quote === '"') { i++; continue; } if (c === quote) { if (quote === "'" && s[i + 1] === "'") { i++; continue; } quote = null; } continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}
/** Top-level comma split of an inline collection body (quotes and nesting respected). */
function splitInline(inner) {
  const parts = []; let depth = 0, quote = null, cur = "", any = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) { cur += c; if (c === "\\" && quote === '"') { cur += inner[i + 1] ?? ""; i++; continue; } if (c === quote) { if (quote === "'" && inner[i + 1] === "'") { cur += "'"; i++; continue; } quote = null; } continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; any = true; continue; }
    if (c === "[" || c === "{") depth++; else if (c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) { parts.push(cur); cur = ""; any = true; continue; }
    if (!/\s/.test(c)) any = true;
    cur += c;
  }
  if (any || cur.trim()) parts.push(cur);
  return parts.filter((p, i) => !(i === parts.length - 1 && !p.trim() && !quoteOnly(p)));
}
const quoteOnly = (p) => /^\s*(""|'')\s*$/.test(p);
/** The first ":" of an inline map entry outside quotes. */
function inlineKeyEnd(part) {
  let quote = null;
  for (let i = 0; i < part.length; i++) {
    const c = part[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === ":") return i;
  }
  return -1;
}
export function parseYamlNested(text) {
  const root = {};
  const stack = [{ indent: -1, node: root }];
  for (const raw of text.split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    // A block sequence item ("- value") belongs to the key that opened the
    // current node; the first item turns that node into an array. Items are
    // scalars only (a "- key: value" item is read as the scalar text).
    const seq = raw.match(/^(\s*)-(?:\s+(.*?))?\s*$/);
    if (seq) {
      const indent = seq[1].length;
      while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
      const top = stack[stack.length - 1];
      if (!Array.isArray(top.node)) {
        if (!top.parent || Object.keys(top.node).length) continue; // not a list position: ignored, as before
        top.node = []; top.parent[top.key] = top.node;
      }
      if (seq[2] !== undefined && seq[2] !== "") top.node.push(yamlScalar(seq[2]));
      continue;
    }
    const m = raw.match(/^(\s*)((?:["'][^"']+["'])|(?:[^:#][^:]*?)):\s*(.*?)\s*$/);
    if (!m) continue;
    const [, ws, rawKey, rawVal] = m;
    const key = yamlKey(rawKey.trim().replace(/^["']|["']$/g, ""));
    const indent = ws.length;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    if (Array.isArray(parent)) continue; // a key line inside a sequence is not part of this subset
    if (rawVal.replace(/\s+#.*$/, "").trim() === "" || rawVal.trim().startsWith("#")) {
      const child = {};
      parent[key] = child;
      stack.push({ indent, node: child, parent, key });
    } else parent[key] = yamlScalar(rawVal);
  }
  return root;
}



// ---------- launch configurations ----------
// A named way to start a harness, independent of any soul: the harness, an
// executable (a wrapper, another binary), literal argv, environment (literal
// values, or references resolved on the execution host at start time), a
// model and yolo. Declared by the host under `launch-configs:` in the
// deployment's oats-local.yaml (lead decision 2: a spawn-time HOST choice,
// never a soul field). Selected at spawn or session start/restart by name.
export const LAUNCH_HARNESSES = ["pi", "claude", "codex"];
export const LAUNCH_CONFIG_KEYS = new Set(["harness", "runtime", "executable", "args", "env", "model", "yolo", "default"]);
/** A launch configuration's harness: `harness`, or `runtime`, its pre-0.27 name (0.26.0
 *  deployments wrote it) — read either (lead call 6). */
export const launchConfigHarness = (entry) => (Object.hasOwn(entry, "harness") ? entry.harness : entry.runtime);
const LAUNCH_CONFIG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const LAUNCH_REF_PREFIX = "OATS_LAUNCH_REF_";
const reservedLaunchEnv = (n) => RESERVED_LAUNCH_ENV.has(n) || n.startsWith(LAUNCH_REF_PREFIX);
export function validateLaunchConfig(name, entry, where) {
  const bad = (why) => { throw oatsError("E_LAUNCH_CONFIG_INVALID", `launch configuration ${JSON.stringify(name)}${where ? ` in ${where}` : ""} ${why}`); };
  if (typeof name !== "string" || !LAUNCH_CONFIG_NAME.test(name)) bad("has an invalid name (letters, digits, dot, underscore, dash; up to 64 characters)");
  if (name === "none") bad("cannot be named none: that word selects no configuration");
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) bad("must be a map");
  for (const key of Object.keys(entry)) if (!LAUNCH_CONFIG_KEYS.has(key)) bad(`has an unsupported key ${JSON.stringify(key)} (harness, executable, args, env, model, yolo, default)`);
  if (Object.hasOwn(entry, "harness") && Object.hasOwn(entry, "runtime") && entry.harness !== entry.runtime) bad(`names harness ${JSON.stringify(entry.harness)} and runtime ${JSON.stringify(entry.runtime)}: \`runtime\` is the pre-0.27 name of \`harness\` — keep one`);
  if (!LAUNCH_HARNESSES.includes(launchConfigHarness(entry))) bad(`needs harness: one of ${LAUNCH_HARNESSES.join(", ")}`);
  const text = (v, what) => { if (typeof v !== "string" || !v.trim() || v.includes("\0")) bad(`${what} must be non-empty text`); };
  if (entry.executable !== undefined) text(entry.executable, "executable");
  if (entry.args !== undefined) {
    if (!Array.isArray(entry.args)) bad("args must be a list of strings");
    for (const a of entry.args) if (typeof a !== "string" || a.includes("\0")) bad("args must be a list of strings");
  }
  if (entry.env !== undefined) {
    if (!entry.env || typeof entry.env !== "object" || Array.isArray(entry.env)) bad("env must be a map of NAME to a string or {fromEnv: NAME}");
    for (const [n, v] of Object.entries(entry.env)) {
      if (!ENV_NAME.test(n)) bad(`env name ${JSON.stringify(n)} is not a valid environment variable name`);
      if (reservedLaunchEnv(n)) bad(`env ${n} is set by the kernel for every launch and cannot be overridden`);
      if (typeof v === "string") { if (v.includes("\0")) bad(`env ${n} must be text`); continue; }
      if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== 1 || typeof v.fromEnv !== "string" || !ENV_NAME.test(v.fromEnv)) bad(`env ${n} must be a string or {fromEnv: NAME}`);
      if (v && typeof v === "object" && v.fromEnv && v.fromEnv.startsWith(LAUNCH_REF_PREFIX)) bad(`env ${n} may not reference a ${LAUNCH_REF_PREFIX}* alias`);
    }
  }
  if (entry.model !== undefined) text(entry.model, "model");
  if (entry.yolo !== undefined && typeof entry.yolo !== "boolean") bad("yolo must be true or false");
  if (entry.default !== undefined && typeof entry.default !== "boolean") bad("default must be true or false");
  return entry;
}
/** At most one `default: true` per harness (0.32, feature launch-config-default): the host's baseline for
 *  that harness has one source. `map` is name → entry; entries are validated first. */
export function validateLaunchConfigDefaults(map, where) {
  const byHarness = new Map();
  for (const [name, entry] of Object.entries(map || {})) {
    if (entry?.default !== true) continue;
    const harness = launchConfigHarness(entry);
    if (byHarness.has(harness)) throw Object.assign(oatsError("E_LAUNCH_CONFIG_INVALID", `launch configurations ${JSON.stringify(byHarness.get(harness))} and ${JSON.stringify(name)}${where ? ` in ${where}` : ""} are both default: true for ${harness}; keep one default per harness`), { details: { harness, configurations: [byHarness.get(harness), name] } });
    byHarness.set(harness, name);
  }
}
function validateLaunchConfigs(map, file) {
  if (map === undefined) return;
  if (!map || typeof map !== "object" || Array.isArray(map)) throw oatsError("E_LAUNCH_CONFIG_INVALID", `launch-configs in ${file} must be a map of name to configuration`);
  for (const [name, entry] of Object.entries(map)) validateLaunchConfig(name, entry, file);
  validateLaunchConfigDefaults(map, file);
}
/** The one-line statement a launch shows when it engages the development-channel
 *  confirmation: what it passes, what OATS does, and what stops it. */
export const DEV_CHANNEL_STATEMENT = "This start passes --dangerously-load-development-channels plugin:aweb-channel@awebai-marketplace; OATS confirms Claude's development-channel prompt once. The messaging provider's delivery or channel-mode setting stops it (the provider's warning says where those settings are).";
/** The warning of a start where Claude ignored the development-channel flag: the
 *  session runs, with no channel. It replaces DEV_CHANNEL_STATEMENT in that start's answer. */
export const FLAG_IGNORED_WARNING = "Claude reported that channels are not currently available and ignored the development-channel flag, so this instance gets no channel delivery: mail and chat will not wake it. Check first for a telemetry opt-out in the launch environment (DISABLE_TELEMETRY, DO_NOT_TRACK or CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: Claude Code disables channels when one is set), then whether this Claude account offers channels; otherwise change the messaging provider's delivery (its readiness warning says where the setting is). See docs/configuration.md#the-development-channel-confirmation.";
/** A start's warnings once Claude ignored the flag: the statement that OATS
 *  confirms the prompt is replaced by what the outcome means. */
const flagIgnoredWarnings = warnings => [...warnings.filter(w => w !== DEV_CHANNEL_STATEMENT), FLAG_IGNORED_WARNING];
/** Whether this launch engages the confirmation: decided from the rendered argv
 *  alone, never from provider settings. */
function devChannelEngaged(harness, command) {
  return launchPromptEngages({ harness, argv: describeLaunchCommand(command).argv });
}
/** A start that does not engage the confirmation still records that, so the
 *  record always describes the last start. */
const notEngaged = startId => ({ status: "not-engaged", startId, at: new Date().toISOString() });
/** The record of a start where Claude ignored the flag: it asked nothing and
 *  runs, so nothing waits for a person. Its launch-prompt event holds the receipt. */
const channelsUnavailable = (startId, result) => ({ status: "flag-ignored", reason: "channels-unavailable", signatureId: result.signatureId, startId, at: new Date().toISOString() });
/** A started session is launched when the confirmation completed, or when Claude
 *  ignored the flag and showed none. */
const promptLaunched = status => status === "completed" || status === "flag-ignored";
/** The warning for a host `launchPromptAnswers` block the validator let through
 *  (only `true` entries, an empty block, `workspaceTrust`): it is ignored. */
export function launchPromptAnswersNotice(deployment) {
  let found;
  try { found = loadLocal(deployment); }
  catch (e) { if (e.code !== "E_LOCAL_MISSING") throw e; }
  if (!found?.local || typeof found.local !== "object" || !Object.hasOwn(found.local, "launchPromptAnswers")) return null;
  return `launchPromptAnswers in ${found.path} is ignored: remove it. OATS confirms Claude's development-channel prompt whenever it launches Claude with --dangerously-load-development-channels plugin:aweb-channel@awebai-marketplace; settings.oats.aweb.claudeChannelMode: approved keeps Claude from being launched that way.`;
}
/** What a start of `command` says before it runs: the ignored-key notice, then
 *  the development-channel statement when the argv engages the confirmation. */
export function launchStartNotices(deployment, harness, command) {
  return [launchPromptAnswersNotice(deployment), devChannelEngaged(harness, command) ? DEV_CHANNEL_STATEMENT : null].filter(Boolean);
}
function assertLaunchHome(home, expected) {
  const actual = directoryIdentity(home);
  if (!expected || actual.dev !== expected.dev || actual.ino !== expected.ino) throw oatsError("E_RUNTIME_AUTHORITY_MISMATCH", "launch home identity changed");
}
function promptController(home, startId, command, io, expectedHomeIdentity) {
  assertLaunchHome(home, expectedHomeIdentity);
  return createLaunchPromptController({ home: realPathOrNearest(home), startId, ...claudeVersionOf(describeLaunchCommand(command).executable), expectedHomeIdentity,
    transport: launchPromptTransport(io), audit: data => appendEvent(home, { kind: "launch-prompt", data }), retainFrame: retainLaunchPromptFrame,
    ...(io?.now ? { now: io.now } : {}), ...(io?.sleep ? { sleep: io.sleep } : {}) });
}
function retainedPromptError(home, instance, target, parentLineageCommitted, launchPrompts) {
  const hint = launchPrompts.claudeSessionShown ? ` ${CLAUDE_SESSION_HINT}` : "";
  // A screen that never settled established no prompt: nothing to read and answer.
  const enterSent = launchPrompts.answers?.some((a) => a.status === "submitted");
  const advice = neverSettled(launchPrompts.reason)
    ? (enterSent
      ? "OATS sent one Enter to Claude's development-channel confirmation, and the screen then never settled into a session within the 30 s bound; no other key is sent: look at the pane, and if Claude's session is running, it started."
      : "The screen never settled within the 30 s bound, so OATS established no prompt and sent no key: look at the pane, and if Claude's session is running, restart the instance.")
    : "If Claude's development-channel confirmation changed, read the prompt and press Enter yourself, or add its captured wording as a tolerance entry in a reviewed change; never broaden the matcher.";
  return Object.assign(oatsError("E_SPAWN_INCOMPLETE", `${launchPrompts.reason}; home and pane retained: inspect ${home}, then use oats session start --home ${shellWord(home)}. ${advice}${hint}`), {
    instance, home, launched: "unknown",
    details: { retained: true, unconfirmed: true, instance, home, launched: "unknown", target, parentLineageCommitted, launchPrompts },
  });
}
function incompleteLaunchPrompt(home, startId, target, reason, previous, expectedHomeIdentity) {
  try { assertLaunchHome(home, expectedHomeIdentity); }
  catch {
    // A replaced/unverifiable home is the explicit audit exception: appendEvent
    // resolves its address from current home metadata, even with workspaceOnly.
    // Neither log is a pinned original-incarnation destination here. Do not read
    // replacement authority or write a row there; zero destinations were tried.
    return { status: "incomplete", answers: previous?.answers ?? [],
      reason: "launch home identity changed; metadata retained at original home",
      receipt: [...(previous?.receipt ?? []), { ok: false, results: [] }] };
  }
  const audit = appendEvent(home, { kind: "launch-prompt", data: { startId, ...target, status: "incomplete", reason } });
  return { status: "incomplete", answers: previous?.answers ?? [], reason: audit.ok === true ? reason : "launch prompt audit failed",
    receipt: [...(previous?.receipt ?? []), { ok: audit.ok === true, ...(audit.row ? { row: audit.row } : {}), results: audit.results ?? [] }] };
}


/** The machine's launch configurations file (awebai/oats#1506), beside the kernel's other per-user
 *  files: `$OATS_HOME_DIR/config/launch-configs.yaml`, else `~/.oats/config/launch-configs.yaml`. */
// The rule of schedule.mjs's oatsHomeDir, kept here as servers.mjs and deployments.mjs keep it:
// schedule.mjs imports this module, so importing it back would read its bindings before they exist.
const oatsHomeDir = () => process.env.OATS_HOME_DIR || join(homedir(), ".oats");
export const machineLaunchConfigsFile = () => join(oatsHomeDir(), "config", "launch-configs.yaml");
/** The machine's launch configurations, validated as a deployment's are → `{ path, configs }`, or null
 *  when there is no file. A broken file throws E_LAUNCH_CONFIG_INVALID naming it. */
export function machineLaunchConfigs() {
  const machine = loadMachineLaunchConfigs(machineLaunchConfigsFile());
  if (machine) validateLaunchConfigs(machine.configs, machine.path);
  return machine;
}

/** The launch configurations effective at `dir`, from two layers, each validated: the machine's
 *  (machineLaunchConfigsFile; a missing file is no layer) and the `launch-configs:` of the
 *  oats-local.yaml found walking up from `dir` (the deployment; none in reach, the machine's alone
 *  apply). A deployment entry replaces the machine's of the same name whole, and its `shadows` names
 *  the machine file. A deployment `default: true` for a harness wins: the machine entries of that
 *  harness are then not default. `source` is the directory the entry was declared in (a relative
 *  `executable` resolves against it). */
export function launchConfigsAt(dir) {
  // Null-prototype: a configuration may legitimately be named constructor or
  // toString, and membership must never be an inherited property.
  const out = Object.create(null);
  const machine = machineLaunchConfigs();
  let found = null;
  try { found = loadLocal(dir); } catch (e) { if (e?.code !== "E_LOCAL_MISSING") throw e; }
  const local = found?.local["launch-configs"];
  if (found) validateLaunchConfigs(local, found.path);
  const entryOf = (name, entry, file, { isDefault, shadows }) => {
    if (!Object.hasOwn(entry, "harness")) noteRuntimeName(`launch-configs.${name}.runtime in ${file}`);
    return { name, harness: launchConfigHarness(entry), ...(entry.executable !== undefined ? { executable: entry.executable } : {}), args: [...(entry.args || [])], env: { ...(entry.env || {}) }, ...(entry.model !== undefined ? { model: entry.model } : {}), ...(entry.yolo !== undefined ? { yolo: entry.yolo } : {}), ...(isDefault ? { default: true } : {}), source: dirname(file), shadows };
  };
  const localDefaults = new Set(Object.values(local || {}).filter((entry) => entry.default === true).map(launchConfigHarness));
  for (const [name, entry] of Object.entries(machine?.configs || {})) {
    out[name] = entryOf(name, entry, machine.path, { isDefault: entry.default === true && !localDefaults.has(launchConfigHarness(entry)), shadows: [] });
  }
  for (const [name, entry] of Object.entries(local || {})) {
    out[name] = entryOf(name, entry, found.path, { isDefault: entry.default === true, shadows: Object.hasOwn(machine?.configs || {}, name) ? [machine.path] : [] });
  }
  return out;
}

/** A hook declaration is either a command string, or `{ command, required }`.
 * `required: true` means the capability cannot function if the hook fails — an
 * aweb spawn hook that cannot mint an identity leaves an instance believing it
 * has messaging it does not have — so the spawn fails and is rolled back
 * instead of proceeding with a half-configured capability. */
function hookDeclaration(value) {
  if (typeof value === "string") return { command: value, required: false };
  if (value && typeof value === "object" && typeof value.command === "string") {
    return { command: value.command, required: value.required === true, ...(Object.hasOwn(value, "inputs") ? { inputs: value.inputs } : {}) };
  }
  return undefined;
}
function manifestHookDeclarations(manifest) {
  return Object.fromEntries(Object.entries(manifest?.hooks || {}).flatMap(([event, value]) => {
    const declaration = hookDeclaration(value);
    return APPROVED_HOOKS.has(event) && declaration ? [[event, declaration.command]] : [];
  }));
}
function manifestHookCommands(manifest) {
  const out = {};
  for (const [ev, command] of Object.entries(manifestHookDeclarations(manifest))) {
    const [script, ...args] = command.split(/\s+/);
    const abs = manifestPath(manifest, script);
    if (abs) out[ev] = ["node", shq(abs), ...args].join(" ");
  }
  return out;
}

const PACKAGED_INJECTS_DIR = join(PKG_ROOT, "injects");

/** A replayed spawn's contract warnings (contractWarningMessages), from the home's module copies in
 *  module-name order; none when they cannot be read (the replay answers what it can, as before). */
function replayedContractWarnings(home) {
  let manifests;
  try { manifests = typeof home === "string" ? capabilityManifests(home) : {}; } catch { return []; }
  return contractWarningMessages(Object.keys(manifests).sort().flatMap((name) => locatedContractWarnings(manifests[name], `.oats/modules/${name}/oats.json`)));
}

function validateCapabilityManifest(m, mf) {
  const id = m.capability;
  if (!id) throw new Error(`capability manifest needs "capability": ${mf}`);
  // Workspace model (contract §2): a capability name is `^[a-z0-9][a-z0-9._-]*$`
  // — a member capability is `nw-deploy`, a package one `oats.okf`. The classic
  // "must be namespaced" rule kept catalog ids unambiguous; the workspace
  // has one flat name space per organisation instead (duplicate → E_CAPABILITY_AMBIGUOUS
  // at resolution), so the grammar is the only requirement.
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new Error(`capability ID must match ^[a-z0-9][a-z0-9._-]*$: "${id}" (${mf})`);
  // Launch environment, hooks and retirement: the shared manifest contract
  // (lib/capability-contract.mjs). The error carries the problem's JSON pointer.
  const problem = manifestContractProblems(m)[0];
  if (problem) throw Object.assign(new Error(problem.message), { pointer: problem.pointer });
  return id;
}


function loadManifestAt(idir, origin, { strict = false } = {}) {
  const mf = join(idir, "oats.json");
  if (!existsSync(mf)) return undefined;
  let raw;
  try { raw = strict ? parseStrictJson(readPortableBytes(mf)) : JSON.parse(readFileSync(mf, "utf8")); }
  catch (e) { if (strict) throw e; throw new Error(`invalid capability manifest JSON ${mf}: ${e.message}`); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`capability manifest ${mf} must be a JSON object (got ${raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw})`);
  // BEFORE any validation or annotation: the artifact declares capability DATA,
  // never kernel annotations about itself.
  const m = stripInternalAnnotations(raw);
  const id = validateCapabilityManifest(m, mf);
  if (!m.version || !m.description) throw new Error(`capability ${id} manifest needs version and description`);
  const targetFields = ["global", "groups", "souls", "targets"].filter((key) => Object.prototype.hasOwnProperty.call(m, key));
  if (targetFields.length) throw new Error(`capability ${id} manifest cannot declare config-owned targets: ${targetFields.join(", ")}`);
  if (m.layer && !LAYERS.includes(m.layer)) throw new Error(`capability ${id} declares unknown layer "${m.layer}"`);
  if (m.command && !/^[a-z0-9][a-z0-9-]*$/.test(m.command)) throw new Error(`capability ${id} has invalid command namespace "${m.command}"`);
  // `agents:` (capability-defined agents) was removed in 0.29.0: resolution refuses a module that
  // declares it (E_CAPABILITY_AGENTS_REMOVED). A copy already recorded in a home still loads here,
  // so that home launches and retires; nothing reads the key.
  validateManifestOperations(m, id);
  validateBindingInterface(m);
  return { ...m, _dir: idir, _origin: origin };
}















/** `operations`: what a capability offers a GUI or scheduler by name, each
 *  delegating to one of its own `commands`. kind "action" runs something;
 *  kind "view" answers { documents: [...] } for presentation (a knowledge
 *  provider's own view of an instance's working knowledge). context "home"
 *  runs in an instance home; "scope" runs in the config scope. */
const OPERATION_NAME_RE = /^[a-z][a-z0-9-]*$/;
function validateManifestOperations(m, id) {
  if (m.operations === undefined) return;
  if (!m.operations || typeof m.operations !== "object" || Array.isArray(m.operations)) throw new Error(`capability ${id} "operations" must be an object map`);
  for (const [name, op] of Object.entries(m.operations)) {
    if (!OPERATION_NAME_RE.test(name)) throw new Error(`capability ${id} operation "${name}": name must match ${OPERATION_NAME_RE.source}`);
    if (!op || typeof op !== "object" || Array.isArray(op)) throw new Error(`capability ${id} operation "${name}" must be an object`);
    if (typeof op.command !== "string" || !Object.prototype.hasOwnProperty.call(m.commands || {}, op.command)) throw new Error(`capability ${id} operation "${name}": "command" must name one of the manifest's commands`);
    if (op.kind !== undefined && !["action", "view"].includes(op.kind)) throw new Error(`capability ${id} operation "${name}": "kind" must be action or view`);
    if (op.context !== undefined && !["home", "scope"].includes(op.context)) throw new Error(`capability ${id} operation "${name}": "context" must be home or scope`);
    if (op.description !== undefined && typeof op.description !== "string") throw new Error(`capability ${id} operation "${name}": "description" must be a string`);
    if (op.args !== undefined) {
      if (!Array.isArray(op.args)) throw new Error(`capability ${id} operation "${name}": "args" must be an array`);
      for (const a of op.args) {
        if (!a || typeof a !== "object" || typeof a.name !== "string" || !OPERATION_NAME_RE.test(a.name)) throw new Error(`capability ${id} operation "${name}": each arg needs a name matching ${OPERATION_NAME_RE.source}`);
        if (a.flag !== undefined && (typeof a.flag !== "string" || !/^--[a-z][a-z0-9-]*$/.test(a.flag))) throw new Error(`capability ${id} operation "${name}" arg "${a.name}": "flag" must look like --name`);
        if (a.required !== undefined && typeof a.required !== "boolean") throw new Error(`capability ${id} operation "${name}" arg "${a.name}": "required" must be a boolean`);
      }
    }
  }
}
/** The normalized operations a manifest declares (empty when none). */
export function manifestOperations(manifest) {
  return Object.entries(manifest?.operations || {}).map(([name, op]) => ({
    name, kind: op.kind || "action", command: op.command, context: op.context || "home",
    description: op.description || null,
    args: (op.args || []).map((a) => ({ name: a.name, flag: a.flag || `--${a.name}`, required: !!a.required, description: a.description || null })),
  }));
}

/** Discover capability manifests. Later sources take precedence: outer scopes < inner scopes; installed < owned within one scope. Duplicates inside one source layer are errors. */
export function capabilityManifests(startDir) {
  // Capability-id keyed — never answer for `constructor`/`toString`: callers
  // index this map with ids read from instance.json and the command line.
  // Only workspace-model copies answer: an instance home's materialized modules,
  // or one entry of the deployment's module store. Anything else has none.
  const out = Object.create(null);
  const layer = new Map(); // capability -> origin of the winning manifest
  const add = (m) => {
    if (!m) return;
    if (out[m.capability] && out[m.capability]._dir !== m._dir && layer.get(m.capability) === m._origin) {
      throw new Error(`duplicate capability ID "${m.capability}" from ${out[m.capability]._dir} and ${m._dir}`);
    }
    out[m.capability] = m; layer.set(m.capability, m._origin);
  };
  // Workspace model: an INSTANCE HOME carries its own materialized modules
  // (<home>/.oats/modules/<cap>/, recorded in instance.json.modules). They are
  // the whole capability set of that instance — nothing from any config chain
  // applies to it — so answer from them and stop. Trust: membership (member
  // modules) or the workspace's packages: declaration (package modules, locked
  // to commit + integrity); the copy is the instance's own.
  // The deployment's module STORE (<deployment>/.oats/modules/<cap>@<commit>/ —
  // where a package capability agent's tree was fetched by the workspace
  // resolver): a store entry answers with its own manifest, trusted like an
  // instance module (the lock pinned the package before the fetch).
  if (startDir && basename(dirname(startDir)) === "modules" && basename(dirname(dirname(startDir))) === ".oats"
      && existsSync(join(dirname(dirname(dirname(startDir))), "oats-local.yaml")) && existsSync(join(startDir, "oats.json"))) {
    const m = loadManifestAt(startDir, `module:${startDir}`);
    if (m) add(m);
    return out;
  }
  const modulesOf = instanceModulesRoot(startDir);
  if (modulesOf) {
    for (const [name, rec] of Object.entries(modulesOf.modules)) {
      if (!PACKAGE_ID_RE.test(name) || name === "__proto__") continue;
      const m = loadManifestAt(join(modulesOf.root, name), `module:${modulesOf.home}`);
      if (m) { m._module = rec; add(m); }
    }
    return out;
  }
  return out;
}
export function capabilityManifest(name, startDir) {
  return capabilityManifests(startDir)[name];
}
/** When `dir` is (or is inside) an instance home materialized under the workspace
 *  model, → { home, root: <home>/.oats/modules, modules: instance.json.modules }; else null.
 *  Walks up from `dir` to the nearest instance.json carrying a `modules` object. */
export function instanceModulesRoot(dir) {
  if (!dir) return null;
  let cur = resolve(dir);
  for (let i = 0; i < 6; i++) {
    const metaFile = join(cur, "instance.json");
    if (existsSync(metaFile)) {
      let meta;
      try { meta = JSON.parse(readFileSync(metaFile, "utf8")); } catch { return null; }
      if (meta && typeof meta === "object" && meta.modules && typeof meta.modules === "object" && !Array.isArray(meta.modules)) {
        const root = join(cur, ".oats", "modules");
        return existsSync(root) ? { home: cur, root, modules: meta.modules } : null;
      }
      return null;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}


/** Trust of a manifest capabilityManifests answered. A materialized module is
 *  trusted by construction — a member capability by membership (decision 2), a
 *  package capability by its declaration in the workspace's packages: (human
 *  decision 2026-09-24: there is no package approval). The copy is the
 *  instance's own. Nothing else is a capability this kernel runs. */
export function capabilityTrust(manifest) {
  if (!manifest) return { trusted: false, reason: "manifest missing" };
  if (!String(manifest._origin).startsWith("module:")) return { trusted: false, reason: `${manifest.capability} is not a workspace module copy` };
  const from = manifest._module?.from;
  return { trusted: true, module: true, reason: from?.kind === "package" ? `package ${from.package} v${from.version} declared in the workspace` : `workspace member ${from?.repoKey ?? "?"}`, package: from?.kind === "package" ? from.package : undefined };
}

// ---------- distribution packages (docs/design/package-engine-contract.md) ----------

/** Default contained package root inside a Git/catalog source when the source
 * contract does not select one (contract §2). NEVER a hardcoded directory at a
 * use site: every resolver reads the configured path and falls back here. */
export const DEFAULT_PACKAGE_PATH = "oats-package";




















/** Resolve a manifest-relative path inside the capability's own copy (its
 * integrity boundary); undefined when the declared resource is absent. */
function manifestPath(manifest, rel) {
  const local = join(manifest._dir, rel);
  if (!existsSync(local)) return undefined;
  const root = realpathSync(manifest._dir); const target = realpathSync(local); const fromRoot = relative(root, target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`capability ${manifest.capability} path escapes its integrity boundary: ${rel}`);
  }
  return local;
}
/** Resolve an executable declared by a manifest through the same artifact boundary as hooks. */
export function capabilityExecutablePath(manifest, rel) { return manifestPath(manifest, rel); }
/** Packaged default injection for a capability or work mode (undefined if none shipped). */
export function packagedInject(name, startDir) {
  const m = capabilityManifest(name, startDir);
  if (m?.inject) { const p = manifestPath(m, m.inject); if (p) return p; }
  const p = join(PACKAGED_INJECTS_DIR, `${name}.md`);
  return existsSync(p) ? p : undefined;
}

/** Capability rows for a prepared spawn BEFORE its home exists: the same shape
 * `toCapabilityRows` builds (manifest, settings, origin, provenance, trust, hooks,
 * environment) with every home-relative path resolved against a placeholder that
 * cannot exist, so `skills` is [] and `inject` is undefined until materialize has
 * copied the module. `planned: true` marks the row so preflight knows those two
 * fields are deferred (the copies are digest-verified by materialize itself). */
const PLANNED_HOME_PLACEHOLDER = join(sep, "oats-planned-home-does-not-exist", "placeholder");
function plannedCapabilityRows(resolution) {
  return toCapabilityRows(resolution, PLANNED_HOME_PLACEHOLDER).map((row) => ({ ...row, level: undefined, dir: undefined, skills: [], inject: undefined, planned: true,
    // Declared command text only (manifest-relative; never executed from a planned row).
    hooks: Object.fromEntries(Object.entries(row.hooks || {}).filter(([event]) => APPROVED_HOOKS.has(event)).map(([event, h]) => [event, typeof h === "string" ? h : h?.command])) }));
}
/** Turn a materialized row's hook declarations (`{ command, cwd, required }` per
 * event, as `toCapabilityRows` records them) into the SHELL STRINGS the kernel's
 * hook runner and the retire path (via instance.json#capabilityRuntime) execute:
 * `node <abs script> <args>`, exactly as `manifestHookCommands` renders a classic
 * capability. The script must exist inside the module's copy under
 * <home>/.oats/modules/<cap>/ — a path escaping it is a manifest defect. Only
 * the events the kernel approves (soul-scaffold, spawn, retire, launch, worktree, upgrade) are kept. */
export function materializedHookCommands(row, home) {
  const out = {};
  const moduleDir = row.dir || join(home, ".oats", "modules", row.id);
  for (const [event, spec] of Object.entries(row.hooks || {})) {
    if (!APPROVED_HOOKS.has(event)) continue;
    const command = typeof spec === "string" ? spec : spec?.command;
    if (typeof command !== "string" || !command.trim()) continue;
    if (/^node\s+'/.test(command)) { out[event] = command; continue; } // already rendered
    const [script, ...args] = command.trim().split(/\s+/);
    const abs = join(moduleDir, script);
    if (!existsSync(abs)) throw oatsError("E_CAPABILITY_RESOURCE_MISSING", `capability ${row.id} declares hook ${event} as ${JSON.stringify(command)}, but ${abs} is not in its materialized copy`);
    const root = realpathSync(moduleDir); const target = realpathSync(abs); const fromRoot = relative(root, target);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw oatsError("E_CAPABILITY_BROKEN", `capability ${row.id} hook ${event} path escapes its module copy: ${script}; respawn the instance from a corrected capability`);
    out[event] = ["node", shq(abs), ...args].join(" ");
  }
  return out;
}

/** Compose, but never mutate, an instance instruction view from canonical soul instructions.
 * `kind` tunes composition: "capability" suppresses the knowledge layer's injection (ephemeral service
 * agents — reviewers, harvesters — carry no episodic memory by design).
 * → { text, body, blocks, resolved, oatsCoreDeclared }: `body` is the soul's AGENTS.md; `blocks` are the
 * capability blocks whose inject already exists (none before materialize), in the resolution's
 * instructionOrder, then the kernel's instance-boundary and work-mode blocks, last. */
export function composeInstanceAgentsMd(soulDir, contextDir, soulName, workMode, kind, prepared = undefined, { launchConfigs = true } = {}) {
  const agentsMd = join(soulDir, "AGENTS.md");
  if (!existsSync(agentsMd)) throw new Error(`canonical soul instructions missing: ${agentsMd}`);
  // Workspace model only (lead decision c3-1): the capability set is the prepared
  // resolution's modules, materialized into the home by the caller. There is no
  // scope configuration to compose from.
  if (!prepared) throw oatsError("E_LOCAL_MISSING", `composing ${soulName ?? basename(dirname(soulDir))} needs a workspace deployment (oats-local.yaml) — its capabilities are the workspace's resolution; \`oats onboard\` creates one`);
  const resolved = resolvedFromPrepared(prepared, contextDir, { launchConfigs });
  const wanted = [];
  // Operational knowledge is a capability (oats.core / oats.setup) the resolution
  // carries like any other; the kernel composes no operational block of its own.
  const oatsCoreDeclared = (prepared.resolution?.modules || []).some((m) => m.name === "oats.core" || m.name === "oats.setup");
  // Capability injects first, in the resolution's instruction order (the soul's
  // listing, then the workspace defaults'), as materialize writes them.
  const order = Array.isArray(prepared.resolution?.instructionOrder) ? prepared.resolution.instructionOrder : [];
  const rank = (cap) => { const i = order.indexOf(cap.id); return i < 0 ? order.length : i; };
  const capabilities = resolved.capabilities.map((cap, i) => ({ cap, i })).sort((a, b) => rank(a.cap) - rank(b.cap) || a.i - b.i).map(({ cap }) => cap);
  for (const cap of capabilities) {
    if (cap.inject && existsSync(cap.inject)) wanted.push([`capability:${cap.id}`, cap.inject]);
  }
  // The kernel's blocks close the document. The home/work boundary is
  // runtime-neutral and mode-independent: every instance — including capability
  // service agents in attached mode — needs to know which directory is its
  // brain and which is the repository, and where `aw`/`oats` resolve their
  // scope from. It precedes the mode block, which then adds only that mode's
  // ownership and branch rules.
  const boundaryInject = packagedInject("instance-boundary");
  if (boundaryInject && existsSync(boundaryInject)) wanted.push(["kernel:instance-boundary", boundaryInject]);
  const workModeInject = packagedInject(`work-${workMode || "checkout"}`);
  if (workModeInject && existsSync(workModeInject)) wanted.push([`work-mode:${workMode || "checkout"}`, workModeInject]);
  const blocks = wanted.map(([source, file]) => ({ source, file, content: readFileSync(file, "utf8").trim() }));
  const body = readFileSync(agentsMd, "utf8");
  return { text: renderInstructionText(body, blocks), body, blocks, resolved, oatsCoreDeclared };
}

/** Per slot `{ capability, from }` (from: "soul" | "workspace" | "team:<label>", the Desktop's
 *  `layers.<layer>.from`), or null for an empty slot. A spawn records these under `workspace.layers`. */
function layerRows(resolution) {
  return Object.fromEntries(Object.entries(resolution?.slots || {}).map(([slot, mod]) => [slot, mod ? { capability: mod, from: resolution.slotsFrom?.[slot] ?? null } : null]));
}

/** The resolved view a prepared spawn composes and records: PLANNED capability rows
 *  (manifest/settings/origin/trust known now; skills and inject paths point into
 *  the home, which does not exist yet, and are rebuilt once materialize has
 *  landed), the workspace, payloads and slots, and the deployment's launch
 *  configurations (left out with `launchConfigs: false`, for a composition that launches nothing).
 *  `prepared.capabilityRows` is honoured only when non-empty. */
export function resolvedFromPrepared(prepared, contextDir, { launchConfigs = true } = {}) {
  return {
    capabilities: Array.isArray(prepared.capabilityRows) && prepared.capabilityRows.length ? prepared.capabilityRows : plannedCapabilityRows(prepared.resolution),
    workspace: { key: prepared.discovery?.key ?? null, name: prepared.discovery?.workspace?.name ?? null, deployment: prepared.deployment ?? null, commit: prepared.discovery?.commit ?? null, standalone: prepared.discovery?.standalone === true, revision: prepared.resolution.revision, slots: prepared.resolution.slots },
    payloads: prepared.resolution.payloads ?? {},
    teams: prepared.resolution.teams ?? [], defaultTeam: prepared.resolution.defaultTeam ?? null, teamsSource: "live",
    layers: layerRows(prepared.resolution),
    ...(launchConfigs ? { launchConfigs: launchConfigsAt(contextDir || prepared.deployment) } : {}),
  };
}

/** The resolved view of an EXISTING home: what it recorded at spawn (its
 *  capability rows, workspace and payloads) and its deployment's launch
 *  configurations. Never re-resolved against the scope. The one live part is
 *  the teams (team model v2): a caller that computed the home's live teams
 *  (liveTeams) passes them; otherwise the spawn-time record. */
export function resolvedFromHome(home, meta, { teams, defaultTeam, teamsSource } = {}) {
  const ws = meta?.workspace && typeof meta.workspace === "object" ? meta.workspace : null;
  const messaging = (Array.isArray(meta?.capabilities) ? meta.capabilities : []).find((c) => c?.layer === "messaging")?.id ?? null;
  const t = Array.isArray(teams) ? { teams, defaultTeam: defaultTeam ?? null, teamsSource: teamsSource === "live" ? "live" : "recorded" } : { ...recordedTeams(meta), teamsSource: "recorded" };
  return {
    capabilities: Array.isArray(meta?.capabilityRuntime) ? meta.capabilityRuntime : [],
    workspace: ws ? { ...ws, slots: { messaging } } : null,
    payloads: meta?.providers ?? {},
    ...t,
    layers: ws && typeof ws.layers === "object" && ws.layers ? ws.layers : {}, // recorded at spawn; none before layers-from
    launchConfigs: launchConfigsAt(home),
  };
}

/** The skill entries a tree contributes — THE discovery rule, shared by preflight
 * and materialization so the two can never disagree about what a tree provides.
 *
 * Note `e.isDirectory()` is false for a symlinked child (readdir uses lstat
 * semantics), so a skill directory represented by a symlink contributes nothing.
 * That is deliberate and matches what actually gets copied; preflight reporting
 * such a tree as empty is the point, not a gap. `oats inspect --soul --skills`
 * (lib/instance-inspect.mjs soulSkills) lists a soul's skills by it too, with
 * `strict`: a marker that cannot be examined (EACCES, ELOOP, …) throws instead
 * of counting as absent, so "could not tell" never reads as "no skill". */
export function skillEntriesIn(tree, { strict = false } = {}) {
  if (!tree || !existsSync(tree)) return [];
  if (hasSkillDoc(tree, strict)) return [{ name: basename(tree), src: tree }];
  const out = [];
  for (const e of readdirSync(tree, { withFileTypes: true })) {
    if (e.isDirectory() && hasSkillDoc(join(tree, e.name), strict)) out.push({ name: e.name, src: join(tree, e.name) });
  }
  return out;
}
/** Does this directory hold a READABLE skill document? `existsSync` is true for
 * a DIRECTORY named SKILL.md, which would let a tree pass every check and still
 * launch an instance with no readable skill (reviewer-d70bc8b). The marker must
 * be a regular file. `strict`: only a missing marker is "no"; any other error throws. */
function hasSkillDoc(dir, strict = false) {
  try { return statSync(join(dir, "SKILL.md")).isFile(); }
  catch (e) { if (strict && e?.code !== "ENOENT") throw e; return false; }
}

/** Enumerate every resource the resolved composition PROMISES this instance,
 * and refuse the spawn if any declared resource did not resolve.
 *
 * The kernel used to fail closed on a missing capability MANIFEST but open on a
 * missing capability RESOURCE: `capabilitySkillDirs()` dropped unresolved paths,
 * the materialization loop skipped non-existent sources, and
 * `composeInstanceAgentsMd()` omitted missing injections. A capability could
 * therefore contribute zero skills while its injection still instructed the
 * agent to load them — observed with oats.aweb in a worktree without its
 * dependencies installed.
 *
 * Preflight runs BEFORE the instance home exists, which is the cheapest possible
 * transaction boundary: the most common failure needs no rollback at all.
 * Installed-but-inactive capabilities are absent from `resolved.capabilities`
 * and so contribute nothing here, by construction.
 */
export function planInstanceResources({ resolved, soulDir, agent, contextDir, composition, prepared }) {
  const expected = [];
  const missing = [];
  /** `declares` marks a tree the manifest PROMISED: it must resolve AND yield at
   * least one discoverable skill. A directory that merely happens to exist (a
   * soul's optional skills/) promises nothing, so an empty one is not a defect. */
  const add = (r, { declares = true } = {}) => {
    if (r.type === "skill-tree") r.entries = skillEntriesIn(r.path).map((e) => e.name);
    expected.push(r);
    if (!r.path) missing.push({ ...r, reason: "did not resolve" });
    else if (declares && r.type === "skill-tree" && !r.entries.length) {
      missing.push({ ...r, reason: `resolved to ${r.path} but contains no skill (no SKILL.md, and no child directory with one — a symlinked skill directory does not count)` });
    }
  };

  const soulSkills = soulDir && join(soulDir, "skills");
  // A soul with no skills/ dir declares nothing — nor does an empty one.
  if (soulSkills && existsSync(soulSkills)) add({ type: "skill-tree", source: "soul", declared: soulSkills, path: soulSkills }, { declares: false });

  for (const cap of resolved.capabilities || []) {
    if (cap.planned === true) {
      // Workspace model, before the home exists: the module's declared skills and
      // inject are promised by its manifest and will be copied WHOLE (and digest-
      // verified) by materialize. They are recorded as expected here — with their
      // future home-relative paths — and asserted against the landed copies in
      // spawnBody's EXPECTED == MATERIALIZED check, not against the filesystem now.
      for (const s of cap.skillsDeclared || []) {
        const declared = typeof s === "string" ? s : s?.declared;
        if (typeof declared !== "string" || !declared) continue;
        expected.push({ type: "skill-tree", source: cap.id, declared, path: undefined, entries: [], deferred: "materialize", origin: cap.origin, module: cap.id });
      }
      if (cap.injectDeclared) expected.push({ type: "injection", source: cap.id, declared: cap.injectDeclared, path: undefined, deferred: "materialize", origin: cap.origin, module: cap.id });
      continue;
    }
    for (const s of cap.skillsDeclared || []) {
      add({ type: "skill-tree", source: cap.id, declared: s.declared, path: s.path, origin: cap.origin, level: cap.level });
    }
    // A capability that declares `inject:` must produce it.
    if (cap.injectDeclared && cap.inject === undefined) {
      add({ type: "injection", source: cap.id, declared: cap.injectDeclared, path: undefined, origin: cap.origin, level: cap.level });
    } else if (cap.inject) {
      add({ type: "injection", source: cap.id, declared: cap.injectDeclared || basename(cap.inject), path: existsSync(cap.inject) ? cap.inject : undefined, origin: cap.origin, level: cap.level });
    }
  }
  if (composition) {
    for (const b of composition.blocks || []) expected.push({ type: "instruction-block", source: b.source, declared: b.file, path: b.file });
  }

  if (missing.length) {
    const detail = missing.map((m) => `  ${m.type} "${m.declared}" declared by ${m.source}${m.origin ? ` (${m.origin})` : ""} ${m.reason}`).join("\n");
    throw oatsError("E_CAPABILITY_RESOURCE_MISSING", `the resolved composition declares ${missing.length} resource(s) that do not exist, so this instance would start without them while its instructions still refer to them:\n${detail}\n\nResources must come from the capability's locked/materialized package content — a path that only exists after an ad-hoc dependency install is a manifest defect. Fix the capability or deselect it for this soul.`);
  }
  return expected;
}

/** Reorder `expected`'s instruction-block entries, in the slots they hold, to `blocks`' order
 *  (the written AGENTS.md's), so the record lists them as the file has them; an entry `blocks`
 *  does not name keeps its relative place after them. Mutates and returns `expected`. */
export function orderInstructionBlocks(expected, blocks) {
  const key = (source, file) => `${source}\u0000${file}`;
  const rank = new Map(blocks.map((b, i) => [key(b.source, b.file), i]));
  const at = (r) => rank.get(key(r.source, r.declared)) ?? blocks.length;
  const slots = [], rows = [];
  expected.forEach((r, i) => { if (r.type === "instruction-block") { slots.push(i); rows.push({ r, i }); } });
  rows.sort((a, b) => at(a.r) - at(b.r) || a.i - b.i).forEach(({ r }, j) => { expected[slots[j]] = r; });
  return expected;
}

// ---------- harness packages (satisfied by a harness's own package manager) ----------

/** pi's config dir, officially relocatable via PI_CODING_AGENT_DIR (pi
 * docs/usage.md). Hard-coding ~/.pi/agent reports an installed package as
 * missing on a relocated host, and then reports a consented install as failed
 * (reviewer-ee6592c). PI_PACKAGE_DIR is deliberately NOT used: it points at pi's
 * own package assets, not at `pi install` output, so treating it as the user
 * package root sends lookups to the wrong tree (reviewer-ad1b9f0). */
const piAgentDir = (env = process.env) => env.PI_CODING_AGENT_DIR || join(env.HOME || "", ".pi", "agent");

/** Harnesses whose own package manager can satisfy a requirement. A harness
 * package is NOT a command on PATH: it is registered with the harness, so both
 * detection and post-install verification read that harness's package list.
 * Null-prototype: `harness:` comes from a soul or a package manifest, and
 * `HARNESS_PACKAGE_MANAGERS[harness]` must answer for the harnesses declared
 * here and for nothing else — an inherited `constructor` would pass the
 * unknown-harness gate and then be dereferenced as a manager. */
export const HARNESS_PACKAGE_MANAGERS = {
  __proto__: null,
  pi: {
    scope: "user-level (pi packages)",
    identity: (spec) => packageSpecIdentity(spec),
    safeSpec: (spec) => typeof spec === "string" && /^[a-z][a-z0-9+.-]*:(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~><=-]+)?$/i.test(spec),
    argv: (spec) => ["pi", "install", spec],
    /** Installed packages as PI reports them. `pi list` is pi's own resolver
     * answer — spec, the resolved install directory, and whether the entry
     * filters the package's resources — so OATS never has to guess at package
     * roots. `--no-approve` keeps a spawn-time probe from trusting
     * project-local files. Falls back to reading settings when pi cannot be
     * run, which yields presence without a verified directory. */
    list: (env = process.env, opts = {}) => {
      try {
        // The SELECTED executable answers (a wrapper or another binary), with
        // pi's own controlled list subcommand only: never a launch argument.
        const out = probeExecFile(opts.bin || "pi", ["list", "--no-approve"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env, timeout: 30000 });
        const rows = [];
        // pi dims the path with chalk; strip any escapes before matching.
        const lines = out.replace(/\u001b\[[0-9;]*m/g, "").split("\n");
        for (let i = 0; i < lines.length; i++) {
          const m = /^ {2}(\S+)(\s+\(filtered\))?\s*$/.exec(lines[i]);
          if (!m) continue;
          // pi prints the install path ONLY when the package is actually
          // installed (`if (pkg.installedPath)` in its list command), so an
          // absent path line is the signal for configured-but-not-installed —
          // not a parsing gap (reviewer-6ad0dde).
          const dir = /^ {4,}(\S.*)$/.exec(lines[i + 1] || "");
          rows.push({ source: m[1], filtered: !!m[2], dir: dir ? dir[1].trim() : undefined });
        }
        return rows;
      } catch {
        // pi could not be run. Settings tell us what was CONFIGURED, never what
        // is installed, so every row is marked unverified and the caller fails
        // closed rather than trusting a config file (reviewer-6ad0dde).
        const file = join(piAgentDir(env), "settings.json");
        if (!existsSync(file)) return [];
        try {
          const cfg = JSON.parse(readFileSync(file, "utf8"));
          return (Array.isArray(cfg.packages) ? cfg.packages : [])
            .map((p) => (typeof p === "string" ? { source: p } : p && typeof p === "object" && typeof p.source === "string" ? { source: p.source } : undefined))
            .filter(Boolean)
            .map((r) => ({ ...r, unverified: "could not run `pi list`" }));
        } catch { return []; } // unreadable settings: "not installed", never a false positive
      }
    },
    /** The entry's explicit `extensions` filter, if any.
     *
     * pi accepts `{ source, extensions: [...] }`, which selects WHICH of the
     * package's extensions load. For a REQUIRED capability package that matters:
     * `[]` loads none, and a non-empty filter may name a wrong or nonexistent
     * path, or simply omit the capability's extension — either way the instance
     * would start claiming wakeable messaging with no channel.
     *
     * OATS must not reimplement pi's glob matcher, which means it CANNOT prove a
     * filtered extension is active. Both cases therefore fail, with different
     * remedies. A filter on other resource kinds (e.g. `skills`) is unrelated
     * and must keep passing — the real oats-aweb entry filters skills only. */
    resourceFilter: (spec, env = process.env) => {
      const file = join(piAgentDir(env), "settings.json");
      if (!existsSync(file)) return undefined;
      try {
        const cfg = JSON.parse(readFileSync(file, "utf8"));
        const want = packageSpecIdentity(spec);
        for (const p of Array.isArray(cfg.packages) ? cfg.packages : []) {
          if (!p || typeof p !== "object" || typeof p.source !== "string") continue;
          if (packageSpecIdentity(p.source) !== want) continue;
          if (!("extensions" in p)) return undefined;
          const list = Array.isArray(p.extensions) ? p.extensions : [];
          return { extensions: list, disabled: list.length === 0 };
        }
      } catch { /* unreadable settings is handled by list() */ }
      return undefined;
    },
  },
  claude: {
    scope: "user-level (Claude Code plugins)",
    /** A plugin id is `name@marketplace`, so "@" separates the SOURCE — stripping
     * it the way a version selector is stripped would collapse plugins from
     * different marketplaces into one identity. */
    identity: (spec) => String(spec || "").trim(),
    safeSpec: (spec) => typeof spec === "string" && /^[a-z0-9][\w.-]*@[a-z0-9][\w.-]*$/i.test(spec),
    /** The executable is SELECTED by the launch (a configuration may name a wrapper
     * such as `claude-personal`). Probing and installing through the literal
     * `claude` would inspect a DIFFERENT account's plugins than the session
     * actually launches with — passing preflight while the real harness lacks
     * the channel, or rejecting one that has it (reviewer-6f1bb9c). */
    bin: (opts) => opts?.bin || "claude",
    argv: (spec, req, opts) => [HARNESS_PACKAGE_MANAGERS.claude.bin(opts), "plugin", "install", String(spec)],
    /** A marketplace must be registered before installing from it, so the plan
     * is a SEQUENCE. Both steps are shown at the consent prompt: agreeing to a
     * plugin also means agreeing to the source it comes from. */
    steps: (spec, req, opts) => {
      const bin = HARNESS_PACKAGE_MANAGERS.claude.bin(opts);
      return [
        ...(req?.marketplace ? [[bin, "plugin", "marketplace", "add", String(req.marketplace)]] : []),
        [bin, "plugin", "install", String(spec)],
      ];
    },
    /** Claude's own structured answer. `--json` carries id, scope, enabled,
     * projectPath and installPath — human output loses scope, and a plugin
     * installed for an UNRELATED project would then satisfy the requirement
     * globally (frontend-design is installed project-scoped for two different
     * projects on this machine). */
    list: (env = process.env, opts = {}) => {
      let out;
      try {
        // DISABLE_TELEMETRY: this listing alone skips Claude's telemetry flush at exit (~0.4 s), same answer; never a launch's (it turns channels off).
        out = probeExecFile(HARNESS_PACKAGE_MANAGERS.claude.bin(opts), ["plugin", "list", "--json"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60000, env: { ...env, DISABLE_TELEMETRY: "1" } });
      } catch { return []; }
      let rows;
      try { rows = JSON.parse(out); } catch { return []; }
      if (!Array.isArray(rows)) return [];
      // Claude reports projectPath in its on-disk spelling: the context is compared in it too.
      const target = opts.context ? canonicalHomePath(opts.context) : undefined;
      return rows
        .filter((r) => r && typeof r.id === "string")
        // A user-scope install applies everywhere. A project/local install
        // applies only inside the project it belongs to.
        .filter((r) => {
          if (r.scope === "user") return true;
          if (!r.projectPath || !target) return false;
          const owner = canonicalHomePath(r.projectPath);
          return target === owner || target.startsWith(owner + sep);
        })
        // verifiedPresent is the "this harness confirms presence without naming a
        // location" override, NOT a blanket exemption: Claude DOES report
        // installPath, and setting it unconditionally meant a stale registration
        // whose install directory had been deleted still satisfied the spawn
        // preflight (reviewer-aggregate2). Claim it only when there is no path
        // to check.
        .map((r) => ({ source: r.id, enabled: r.enabled !== false, scope: r.scope, projectPath: r.projectPath, dir: r.installPath, verifiedPresent: !r.installPath }));
    },
  },
};

/** A package spec without its version selector, so `npm:@awebai/pi@latest`,
 * `npm:@awebai/pi@0.2.1` and `npm:@awebai/pi` are ONE identity. Scoped names
 * keep their leading "@" — the selector separator is the LAST "@", not the first. */
export function packageSpecIdentity(spec) {
  const s = String(spec || "").trim();
  const colon = s.indexOf(":");
  const prefix = colon > 0 ? s.slice(0, colon + 1) : "";
  const rest = colon > 0 ? s.slice(colon + 1) : s;
  if (!rest) return s;
  const scoped = rest.startsWith("@");
  const body = scoped ? rest.slice(1) : rest;
  const at = body.indexOf("@");
  return `${prefix}${scoped ? "@" : ""}${at >= 0 ? body.slice(0, at) : body}`;
}

/** What the harness reports about a required package: is it there, where did it
 * land, and does the user's entry filter its resources? A settings row alone is
 * NOT proof the capability's extension will load (reviewer-8518c49). */
/** The installed version of a harness package: neither pi's nor Claude's
 *  listing reports one, so it is read from the package.json under the
 *  install directory the listing names; undefined when there is none. */
export function installedHarnessPackageVersion(harness, spec, status) {
  const dir = status?.dir;
  if (dir && existsSync(join(dir, "package.json"))) {
    try {
      const v = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
      if (typeof v === "string" && /^\d+\.\d+\.\d+/.test(v)) return v.match(/^\d+\.\d+\.\d+/)[0];
    } catch { /* unreadable manifest: unknowable */ }
  }
  return undefined;
}

export function compareVersionTriples(a, b) {
  const pa = String(a).split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b).split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

export function harnessPackageStatus(harness, spec, env = process.env, opts = {}) {
  const mgr = HARNESS_PACKAGE_MANAGERS[harness];
  if (!mgr) return { installed: false };
  const want = harnessPackageIdentity(harness, spec);
  const row = mgr.list(env, opts).find((r) => harnessPackageIdentity(harness, r.source) === want);
  if (!row) return { installed: false };
  const filter = mgr.resourceFilter ? mgr.resourceFilter(spec, env) : undefined;
  return {
    installed: true,
    source: row.source,
    dir: row.dir,
    unverified: row.unverified,
    // No resolved directory means the package is configured but NOT installed:
    // pi omits the path line entirely in that case, so treating a missing line
    // as "fine" let a stale row through. A named directory that does not exist
    // is the same condition, reported the same way. A harness that confirms
    // presence without naming a directory (Claude's plugin list) says so via
    // verifiedPresent, so it is not judged by a path it never reports.
    missingFiles: row.verifiedPresent ? false : (!row.dir || !existsSync(row.dir)),
    // Installed but switched off will not load, so it does not satisfy a requirement.
    disabled: row.enabled === false,
    // pi's own "(filtered)" marker covers ANY resource filter (skills included),
    // so it must not be conflated with an extensions filter.
    filtered: row.filtered,
    extensionsFilter: filter ? filter.extensions : undefined,
    extensionsDisabled: !!filter?.disabled,
  };
}
/** The identity of a harness package, per that harness's own naming. */
export function harnessPackageIdentity(harness, spec) {
  const mgr = HARNESS_PACKAGE_MANAGERS[harness];
  return mgr?.identity ? mgr.identity(spec) : packageSpecIdentity(spec);
}

/** Gate: a harness package spec must be a plain source token — no shell syntax,
 * whitespace, path traversal, or option-looking leading dash. Fail closed. */
export function safeHarnessPackageSpec(spec, harness = "pi") {
  const mgr = HARNESS_PACKAGE_MANAGERS[harness];
  return mgr?.safeSpec ? mgr.safeSpec(spec) : false;
}
/** A marketplace/source token a requirement may register before installing.
 * No shell syntax, whitespace, traversal or leading dash — it is passed as argv,
 * but a hostile value would still name an attacker-chosen source. */
export function safeHarnessSourceRef(ref) {
  return typeof ref === "string" && /^[a-z0-9][\w.-]*(\/[a-z0-9][\w.-]*)*$/i.test(ref);
}

// ---------- capability lifecycle hooks ----------
/**
 * Run a lifecycle event's hooks for every active capability. Env contract:
 * OATS_EVENT/OATS_INSTANCE/OATS_HOME/OATS_AGENT/OATS_CONTEXT/OATS_LEVEL/OATS_SETTINGS/OATS_META,
 * plus the team/workspace facts (teamEnv: OATS_TEAM_SCOPE, OATS_DEFAULT_TEAM*, OATS_TEAMS, OATS_WORKSPACE_NAME/_KEY);
 * cwd = the instance home. A hook may print JSON { meta, brief, warning, launch, env } — meta
 * is persisted per capability in instance.json (and fed back as OATS_META at retire), brief
 * is added to TASK.md, warning surfaces in the spawn result; launch maps harness → extra
 * launch-command arguments (spawn IS session start: the command built here is stored in
 * instance.json and runs in the tmux window; a capability integrating a harness — e.g.
 * aweb's Claude Code channel plugin — contributes its flags this way). A hook the
 * capability declares REQUIRED fails the spawn and rolls it back; every other
 * hook failure is advisory and only warns. `env` contributes string environment
 * values in the capability vendor's namespace to the launched process. Invalid
 * or colliding environment output is a fatal contract failure and enters the
 * same rollback transaction as a required spawn hook.
 */
class HookEnvironmentContractError extends Error {}

function validateHookEnvironment(capabilityID, value, owners, declarations) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HookEnvironmentContractError(`${capabilityID} hook env must be an object of string values`);
  }
  const vendorComponent = capabilityID.match(/^([^.]+)\./)?.[1];
  if (!vendorComponent || !/^[a-z][a-z0-9]*$/.test(vendorComponent)) {
    throw new HookEnvironmentContractError(`${capabilityID} hook env requires a dotted lowercase alphanumeric vendor component; hyphen, @, and / forms cannot claim an environment namespace`);
  }
  const prefix = `${vendorComponent.toUpperCase()}_`;
  // The harness half of the same contract the manifest validator enforces:
  // a hook may set names under its vendor prefix or under a namespace its
  // trusted manifest declared (environmentNamespaces), and only names the
  // manifest listed. Manifest and harness must permit exactly the same set.
  const declared = declarations.get(capabilityID) || { names: new Set(), namespaces: [] };
  const allowed = [prefix, ...(declared.namespaces || [])];
  const accepted = {};
  for (const name of Object.keys(value).sort()) {
    const envValue = value[name];
    if (!PORTABLE_ENV_NAME_RE.test(name)) {
      throw new HookEnvironmentContractError(`${capabilityID} hook env name ${JSON.stringify(name)} is invalid`);
    }
    if (CORE_LAUNCH_ENV.has(name) || name.startsWith("OATS_") || name.startsWith("PI_AGENT_")) {
      throw new HookEnvironmentContractError(`${capabilityID} hook env name ${name} collides with a reserved core variable`);
    }
    if (PROCESS_BOOTSTRAP_ENV.has(name) || PROCESS_BOOTSTRAP_PREFIXES.some((reserved) => name.startsWith(reserved))) {
      throw new HookEnvironmentContractError(`${capabilityID} hook env name ${name} collides with a reserved process bootstrap variable`);
    }
    if (!allowed.some((ns) => name.startsWith(ns))) {
      throw new HookEnvironmentContractError(`${capabilityID} hook env name ${name} is outside its ${allowed.join(", ")} namespace${allowed.length > 1 ? "s" : ""}`);
    }
    if (!declared.names.has(name)) {
      throw new HookEnvironmentContractError(`${capabilityID} hook env name ${name} is not declared in its trusted manifest environment`);
    }
    if (typeof envValue !== "string") {
      throw new HookEnvironmentContractError(`${capabilityID} hook env value for ${name} must be a string`);
    }
    if (envValue.includes("\0")) throw new HookEnvironmentContractError(`${capabilityID} hook env value for ${name} contains NUL`);
    if (envValue.includes("\n") || envValue.includes("\r")) {
      throw new HookEnvironmentContractError(`${capabilityID} hook env value for ${name} contains a newline`);
    }
    if (Buffer.byteLength(envValue, "utf8") > 8192) {
      throw new HookEnvironmentContractError(`${capabilityID} hook env value for ${name} exceeds 8192 bytes`);
    }
    if (owners.has(name)) {
      throw new HookEnvironmentContractError(`${owners.get(name)} and ${capabilityID} both claim hook env name ${name}`);
    }
    owners.set(name, capabilityID);
    accepted[name] = envValue;
  }
  return accepted;
}

/**
 * A soul's STABLE identity for capability hooks (OATS_SOUL_ID): what a provider
 * may key durable state on. Workspace soul: `<repo key>#<soul name>` — it does not
 * change when the member commits (the per-commit soul directory does) or when the
 * copy moves. Classic soul: the realpath of agents/<name>/soul, i.e. today's value,
 * so 0.24 deployments are unchanged. Order: an explicit `soulId` (a prepared spawn),
 * the home's recorded `instance.json.workspace.soul` (retire/launch of a workspace
 * home), else the path.
 */
export function stableSoulId({ soulId, home, soulDir, agentName } = {}) {
  if (typeof soulId === "string" && soulId) return soulId;
  if (home) {
    try {
      const meta = JSON.parse(readFileSync(join(home, "instance.json"), "utf8"));
      const s = meta?.workspace?.soul;
      if (typeof s?.id === "string" && s.id) return s.id;
      if (typeof s?.repoKey === "string" && s.repoKey) return `${s.repoKey}#${meta.agent ?? agentName ?? ""}`;
    } catch { /* not a workspace home */ }
  }
  if (soulDir) { try { return realpathSync(soulDir); } catch { return soulDir; } }
  return "";
}
export const workspaceSoulId = (repoKey, name) => `${repoKey}#${name}`;
/** A triggered instance's event, inside its home's .oats/ (lib/triggers.mjs). */
export const TRIGGER_EVENT_FILE = "trigger-event.json";
/** A prepared soul entry's id: `<repoKey>#<name>` for a member or external soul, `package:<id>#<name>`
 *  for a package soul (stable across the package's versions and independent of its repo). */
export const preparedSoulIdOf = (entry) => workspaceSoulId(typeof entry.package === "string" ? `package:${entry.package}` : entry.repoKey, entry.name);
/** The soul directory an instance incarnates, as spawn recorded it (instance.json
 *  `soulDir`): a workspace soul's per-commit copy (agents/<soul>/souls/<commit12>) or
 *  the read-only soul inside a capability package. It is what every classic
 *  lifecycle hook and dispatched command sees as OATS_SOUL (captured hooks set
 *  none); instance homes carry no soul link. */
export function instanceSoulDir(home, meta = undefined) {
  if (meta === undefined && home) { try { meta = JSON.parse(readFileSync(join(home, "instance.json"), "utf8")); } catch { meta = null; } }
  return typeof meta?.soulDir === "string" && isAbsolute(meta.soulDir) ? meta.soulDir : undefined;
}

/** The team and workspace facts a lifecycle hook, command or provider check receives (workspace
 * model only, lead decision c3-7): OATS_TEAM_SCOPE is the deployment directory; OATS_WORKSPACE_NAME /
 * _KEY the workspace's name and canonical key; OATS_TEAM_NAME (the 0.25 `team:` block's name) is always
 * empty, so an ambient value never reaches a hook.
 *
 * Team model v2 (docs/desktop-cli-api.md, The provider environment): `resolved.teams` are the soul's
 * TeamRows here and `resolved.defaultTeam` its DefaultTeam; teamsEnv sets OATS_DEFAULT_TEAM(_ID,_FROM),
 * OATS_TEAMS (mapped rows only) and OATS_TEAMS_SOURCE (`live`: the workspace + oats-local.yaml read now,
 * or a fresh resolution; `recorded`: the spawn-time record). A provider LEAVES a joined team only on a
 * `live` list. Teams not known (`resolved.teams` not an array): every team name unset. */
export function teamEnv(resolved) {
  const ws = resolved?.workspace && typeof resolved.workspace === "object" ? resolved.workspace : {};
  const known = Array.isArray(resolved?.teams);
  return {
    OATS_TEAM_NAME: "", OATS_TEAM_SCOPE: typeof ws.deployment === "string" ? ws.deployment : "",
    ...teamsEnv(known ? { teams: resolved.teams, defaultTeam: resolved.defaultTeam ?? null, source: resolved.teamsSource } : null),
    OATS_WORKSPACE_NAME: typeof ws.name === "string" ? ws.name : "", OATS_WORKSPACE_KEY: typeof ws.key === "string" ? ws.key : "",
  };
}
function withoutAmbientHookFacts(env) {
  const { OATS_LAUNCH_PREVIEW: _ambient, OATS_HARNESS_EXECUTABLE: _inherited, OATS_SPAWNER_HOME: _spawner, ...rest } = env;
  return rest;
}
/** A hook's OATS_HARNESS_EXECUTABLE: what the kernel's pane-side selection found, as an absolute real
 *  path, so a hook can ask the program its pane will run. `paneSide` says the path is such an answer:
 *  a recorded recipe's, a declared one, or a lookup on the pane's PATH. A bare name this process's
 *  PATH answered is not (a spawn with no launch, a pane whose PATH is not established), and neither
 *  is a path that does not resolve: the variable is then absent, never guessed. It is the selection
 *  when the hook runs: a bare name is looked up once more on the session a launch gets, and a symlink
 *  can move (replacedExecutableWarning). */
function harnessExecutableEnv(path, paneSide) {
  if (!path || !paneSide) return {};
  try { return { OATS_HARNESS_EXECUTABLE: realpathSync(path) }; } catch { return {}; }
}
/** The warning for a launch that runs another program than its hooks were handed, or null. It names
 *  both real paths: a hook may have decided something from the one it was given. */
function replacedExecutableWarning(handed, launched) {
  const { OATS_HARNESS_EXECUTABLE: now } = harnessExecutableEnv(launched, true);
  if (!handed || !now || handed === now) return null;
  return `the harness executable changed after the hooks ran: hooks were given ${handed}, this launch runs ${now}`;
}
/** The environment one capability's lifecycle hook runs with: the invoker's own
 *  (inherited, as for every hook; the kernel adds no credentials), plus the
 *  standard OATS_* variables (docs/capabilities.md, Commands and hooks) and the
 *  caller's `extraEnv`. One builder for every event, so the `worktree` runner
 *  (lib/worktree-hooks.mjs) hands its hooks exactly what every other hook gets. */
export function lifecycleHookEnv(event, cap, { home, instance, agentName, soulDir, soulId, contextDir, workspaceDir, rootDir, resolved, priorMeta = {}, extraEnv = {} }) {
  return {
    // OATS_LAUNCH_PREVIEW is the kernel's to give (prepareLaunchHooks), never
    // inherited: a real start's hook must not read an ambient one as a preview.
    // Nor are OATS_HARNESS_EXECUTABLE and OATS_SPAWNER_HOME (spawn's
    // callerSpawner): a hook started from inside an instance must not read its caller's.
    ...withoutAmbientHookFacts(process.env),
    // OATS_INSTANCE_HOME is the runtime-neutral contract name for the
    // instance home (absolute). OATS_HOME predates it and stays as a
    // compatibility alias: shipped capability hooks read it
    // (the official oats.aweb and oats.okf packages) and are versioned
    // independently of this kernel. Neither is OATS_HOME_DIR, which is
    // the package STORE root — do not conflate them.
    OATS_EVENT: event, OATS_INSTANCE: instance, OATS_INSTANCE_HOME: home, OATS_HOME: home, OATS_AGENT: agentName,
    OATS_CAPABILITY: cap.id, OATS_LAYER: cap.layer || "", OATS_ROOT: rootDir || "",
    OATS_SOUL: soulDir || "", OATS_SOUL_ID: stableSoulId({ soulId, home, soulDir, agentName }), OATS_CONTEXT: contextDir, OATS_WORKSPACE: workspaceDir || "", OATS_LEVEL: cap.level || "",
    ...teamEnv(resolved),
    ...extraEnv,
    // Hooks also run through direct core callers (not only bin/oats).
    // Author this from the running kernel, never PATH, ambient env or
    // a caller's extraEnv: those may point at a different executable.
    OATS_CLI_BIN: kernelBin(),
    // The node a capability writes into anything that outlives its hook (lib/stable-node.mjs).
    OATS_NODE_BIN: kernelNode().node,
    OATS_SETTINGS: JSON.stringify(cap.settings || {}),
    // Where each leaf of OATS_SETTINGS came from (JSON pointer → { kind, at }; kind is
    // manifest-default | workspace | soul | host | spawn | anchor), so a provider can tell a
    // soul-set value from a host-set one. {} when the home recorded none (spawned before 0.29).
    OATS_SETTINGS_ORIGINS: JSON.stringify(cap.settingsOrigins || {}),
    OATS_META: JSON.stringify(priorMeta[cap.id] || {}),
  };
}
/** What a spawn or launch hook may answer as `dialogClaims`: `reported`, this session's dialogs become
 *  `permission` or `question` claims; `none`, this harness has no dialog an Enter can answer. */
const DIALOG_CLAIMS = ["reported", "none"];
/** instance.json `dialogClaims` once hooks really ran. `ran` is runLifecycleHooks's `dialogClaims`, a
 *  capability's answer or, for a hook that ran with none or failed, null. Replacement includes
 *  absence: an answer sets its entry, null removes it (a harness switch or a downgrade leaves no
 *  `reported` behind), and a capability whose hook didn't run keeps its entry. Undefined when nothing
 *  is left. It travels beside `meta`, never in a contribution row, which a start compares with its
 *  preview: a hook that failed to write would refuse the start. */
function replacedDialogClaims(prior, ran) {
  const next = isPlainObject(prior) ? { ...prior } : {};
  for (const [id, answer] of Object.entries(ran)) { if (answer) next[id] = answer; else delete next[id]; }
  return Object.keys(next).length ? next : undefined;
}
/** A hook's statement is about the program it was handed: for a launch that runs another, each of
 *  `ran` reads as a hook that ran and answered nothing, so its entry goes (replacedDialogClaims). */
function voidedDialogClaims(ran) {
  return ran && Object.fromEntries(Object.keys(ran).map((id) => [id, null]));
}
export function runLifecycleHooks(event, { home, instance, agentName, soulDir, soulId, contextDir, workspaceDir, rootDir, resolved, priorMeta = {}, extraEnv = {}, assertRoots }) {
  const results = { meta: {}, briefs: [], warnings: [], order: [], launch: {}, env: {}, failures: [], contributions: [], volatileEnv: {}, dialogClaims: {} };
  // OATS_SOUL is set for EVERY hook: a caller that does not name the soul (launch,
  // retire) gets the directory the home's spawn recorded.
  if (!soulDir && home) soulDir = instanceSoulDir(home);
  const envOwners = new Map();
  const envDeclarations = new Map((resolved.capabilities || []).map((cap) => [cap.id, { names: new Set(cap.environment || []), namespaces: [...(cap.environmentNamespaces || [])] }]));
  const caps = [...(resolved.capabilities || [])];
  if (event === "retire") caps.reverse();
  for (const cap of caps) {
    for (const miss of cap.missingRequires || []) {
      results.warnings.push(`${cap.id}${cap.layer ? ` (${cap.layer})` : ""}: required command "${miss.command}" not on PATH — ${miss.why || "needed by this capability"}${miss.install ? ` (install: ${miss.install})` : ""}`);
    }
    if (cap.executable && !cap.trust?.trusted) results.warnings.push(`${cap.id}: executable surface disabled — ${cap.trust?.reason || "not trusted"}`);
    const cmd = cap.hooks?.[event];
    if (!cmd) continue;
    assertRoots?.();
    results.order.push(cap.id);
    if (event === "spawn" || event === "launch") results.dialogClaims[cap.id] = null;
    try {
      const stdout = execSync(cmd, {
        cwd: home, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000,
        env: lifecycleHookEnv(event, cap, { home, instance, agentName, soulDir, soulId, contextDir, workspaceDir, rootDir, resolved, priorMeta, extraEnv }),
      }).trim();
      const lastLine = stdout.split("\n").filter(Boolean).pop() || "{}";
      let o = {};
      try { o = JSON.parse(lastLine); } catch { /* non-JSON hook output is fine */ }
      if (o.meta) results.meta[cap.id] = o.meta;
      // A launch hook's answer as given; prepareLaunchHooks validates it.
      if (event === "launch" && o.volatileEnv !== undefined) results.volatileEnv[cap.id] = o.volatileEnv;
      if (o.brief) results.briefs.push(`- ${o.brief}`);
      if (o.warning) results.warnings.push(o.warning);
      if (o.launch && typeof o.launch === "object") for (const [rt, args] of Object.entries(o.launch)) results.launch[rt] = `${results.launch[rt] ? `${results.launch[rt]} ` : ""}${args}`;
      // Provenance of what this capability contributed to the launch: which
      // harnesses it answered launch args for, and which env names, under
      // which settings and trust. A later start or harness switch reads this.
      // A launch hook's run is recorded even when its answer is empty: an
      // empty answer replaces what the provider contributed before.
      if (event === "launch" || (o.launch && typeof o.launch === "object" && Object.keys(o.launch).length) || (o.env && typeof o.env === "object" && Object.keys(o.env).length)) {
        results.contributions.push({ capability: cap.id, layer: cap.layer || null, level: cap.level || null, settings: { ...(cap.settings || {}) }, settingsOrigins: { ...(cap.settingsOrigins || {}) }, trust: { trusted: !!cap.trust?.trusted, integrity: cap.trust?.integrity || null }, launch: o.launch && typeof o.launch === "object" ? { ...o.launch } : {}, env: o.env && typeof o.env === "object" ? Object.keys(o.env).sort() : [] });
      }
      if (o.env !== undefined) {
        if (event !== "spawn" && event !== "launch") throw new HookEnvironmentContractError(`${cap.id} hook env is supported only for spawn and launch, not ${event}`);
        Object.assign(results.env, validateHookEnvironment(cap.id, o.env, envOwners, envDeclarations));
      }
      // Last in the answer: a hook that fails above has given no answer.
      if ((event === "spawn" || event === "launch") && o.dialogClaims !== undefined) {
        if (DIALOG_CLAIMS.includes(o.dialogClaims)) results.dialogClaims[cap.id] = o.dialogClaims;
        else results.warnings.push(`${cap.id} ${event} hook answered dialogClaims ${String(JSON.stringify(o.dialogClaims)).slice(0, 64)}, neither "reported" nor "none"; read as no answer`);
      }
    } catch (e) {
      if (e instanceof HookEnvironmentContractError) {
        const detail = String(e.message || e).slice(0, 200);
        results.warnings.push(`${cap.id} ${event} hook environment contract failed: ${detail}`);
        results.failures.push({ capability: cap.id, event, message: detail, required: true, contract: "environment" });
        // During spawn, stop before any later capability can create more state.
        // During compensation/retirement, keep going in reverse order so one
        // malformed cleanup hook cannot prevent the remaining hooks from
        // attempting their own cleanup.
        if (event === "spawn") return results;
        continue;
      }
      // A failing hook may already have created EXTERNAL state (aweb joins a
      // team before it can report success). Its stdout is the only channel for
      // handing that back, so parse it exactly as the success path does —
      // discarding it strands whatever the hook created, because compensation
      // would call retire with no metadata to act on (reviewer-bb40fa8).
      let reported;
      try {
        const failed = String(e.stdout ?? "").trim().split("\n").filter(Boolean).pop() || "{}";
        const o = JSON.parse(failed);
        if (o && typeof o === "object") {
          if (o.meta) results.meta[cap.id] = o.meta;
          // The hook's OWN diagnosis — "run `oats aweb setup`", "set team.id" —
          // is the actionable part. Without it the caller sees only
          // "Command failed: node …", which tells an operator nothing about
          // what to do (reviewer-5b78764).
          if (typeof o.warning === "string" && o.warning.trim()) reported = o.warning.trim();
        }
      } catch { /* non-JSON output from a failed hook is fine */ }
      const detail = reported || String(e.message || e).slice(0, 200);
      results.warnings.push(`${cap.id} ${event} hook failed (continuing): ${detail}`);
      // Structured failure record — compensation/rollback callers must be able
      // to DETECT hook failures, not just print them (warnings are advisory).
      const required = (cap.requiredHooks || []).includes(event);
      results.failures.push({ capability: cap.id, event, message: detail, required });
    } finally {
      assertRoots?.(); // even a failing hook may have exchanged its cwd
    }
  }
  return results;
}



export function findAgent(root, name) {
  return readSoul(join(root, name));
}
/** A soul homed at `<root>/<name>` but read from `soulDir` — a spawn preview's soul
 *  copy (previewWorkspaceSoul), never the deployment's `soul` pointer. */
export function findAgentAt(root, name, soulDir) {
  const agent = readSoul(join(root, name), soulDir);
  if (agent) agent._soulDir = soulDir;
  return agent;
}


export function defaultRepo(cwd = process.cwd()) {
  return shTry(`git -C ${shq(resolve(cwd))} rev-parse --show-toplevel`);
}
export function resolveRepo(root, repo) {
  if (!repo) return undefined;
  const abs = isAbsolute(repo) ? repo : join(workspaceOf(root), repo);
  if (!existsSync(abs)) throw new Error(`repo not found: ${abs}`);
  if (!shTry(`git -C ${shq(abs)} rev-parse --git-dir`)) throw new Error(`not a git repo: ${abs}`);
  return abs;
}

/** Whose tree an attached spawn's work directory is, and of which repository: the one read both
 *  questions are answered from (awebai/oats#958). An attached instance's repository is the
 *  repository of the tree it is attached to, and the tree's owner is the instance in whose home it
 *  is: the home's `work`, whose repository is the one that instance recorded, or one of the home's
 *  extra trees, whose repository is the one extraWorktreesOf reads from Git (the test of an extra
 *  tree is that function's, never the shape of the path).
 *  → { owner: { name, home } | undefined, repo: string | undefined }. `owner` is the first home
 *  under `root` that holds the tree: every agent dir is scanned, souls and capability-defined
 *  agents alike, and the match is by path, never by name (instance names are only unique per
 *  agent dir). Whether that name resolves back to that home is the caller's check. A tree in no
 *  such home has no owner here; a `work` whose home is not one of them still gives the repository
 *  that home recorded, as it always did. Read-only. */
function attachedTreeOf(root, workDir) {
  const found = { owner: undefined, repo: undefined };
  if (typeof workDir !== "string" || !workDir) return found;
  const wd = resolve(workDir);
  let wdReal;
  try { wdReal = realpathSync(wd); } catch { return found; }
  // A home's work/: the repository its instance recorded. The home is the directory the path is in,
  // as given or as resolved.
  for (const home of new Set([dirname(wd), dirname(wdReal)])) {
    try {
      if (realpathSync(join(home, "work")) !== wdReal) continue;
      const meta = JSON.parse(readFileSync(join(home, "instance.json"), "utf8"));
      if (typeof meta?.repo === "string" && meta.repo) { found.repo = meta.repo; break; }
    } catch { /* not an instance home */ }
  }
  // Lexical form of workDir with the HOME part canonicalized — checkout-mode
  // instances have work as a symlink to the shared repo, so realpath alone
  // would collide across every checkout instance; symlinked work trees only
  // match when workDir IS that home's work path.
  let wdLexical; try { wdLexical = join(realpathSync(dirname(wd)), basename(wd)); } catch { wdLexical = wd; }
  // An extra tree is compared as extraWorktreesOf compares paths, and looked for only in the home
  // the path is directly in: that function runs Git per `.work-*` entry of a home.
  const wdCanonical = canonicalHomePath(wd), treeHome = dirname(wdCanonical);
  let agentsRoot; try { agentsRoot = realpathSync(root); } catch { agentsRoot = root; }
  const hits = [];
  const candidate = (instHome, instName) => {
    let homeReal; try { homeReal = realpathSync(instHome); } catch { return; }
    try {
      if (join(homeReal, "work") === wdLexical) { hits.push({ home: instHome, name: instName }); return; }
      const wp = join(instHome, "work");
      if (!lstatSync(wp).isSymbolicLink() && realpathSync(wp) === wdReal) { hits.push({ home: instHome, name: instName }); return; }
    } catch { /* no work tree */ }
    if (hits.length || canonicalHomePath(instHome) !== treeHome) return;
    const tree = extraWorktreesOf(instHome).find((t) => canonicalHomePath(t.path) === wdCanonical);
    if (tree) hits.push({ home: instHome, name: instName, extraTreeRepo: tree.repo });
  };
  if (existsSync(agentsRoot)) {
    for (const ag of readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!ag.isDirectory() || ag.name.startsWith(".")) continue;
      const dir = join(agentsRoot, ag.name, "instances");
      if (!existsSync(dir)) continue;
      for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) candidate(join(dir, e.name), e.name);
    }
  }
  if (hits.length) {
    found.owner = { name: hits[0].name, home: hits[0].home };
    if (hits[0].extraTreeRepo !== undefined) found.repo = hits[0].extraTreeRepo;
  }
  return found;
}
/** The refusal of an attached spawn on a tree of no known instance: neither a home's `work` nor one
 *  of its extra trees, so nothing is derived. One sentence names every flag still missing
 *  (`parent`, `repo`), so one retry is enough. */
function attachedTreeOfNoInstance(wd, { parent, repo }) {
  const what = `attached workDir ${wd} is not a known instance's <home>/work or an extra tree of a known instance's home (<home>/.work-<purpose>)`;
  if (parent && repo) return `${what}, so neither its owner nor its repository is derived — pass both: --parent <instance> (the owning instance) and --repo <repository>`;
  return parent ? `${what}, so its owner is not derived — name the owning instance explicitly (--parent <instance>)`
    : `${what}, so its repository is not derived — pass --repo <repository>`;
}
/** Only explicit directory execution relaxes the Git requirement. `repo` is
 * still the config/deployment context, never a directory we take ownership of. */
function resolveExecutionContext(root, target, work) {
  if (work !== "directory") return resolveRepo(root, target);
  if (target !== undefined && (typeof target !== "string" || !target.trim() || target.includes("\0"))) {
    throw oatsError("E_BAD_ARGS", "directory mode repo must name an existing context directory");
  }
  const context = target === undefined ? workspaceOf(root) : resolve(workspaceOf(root), target);
  if (!existsSync(context) || !statSync(context).isDirectory()) throw oatsError("E_BAD_ARGS", `directory mode context is not a directory: ${context}`);
  return resolve(context);
}

// ---------- OKF (Open Knowledge Format) helpers ----------
export function todayISO() { return new Date().toISOString().slice(0, 10); }

/**
 * Append a one-line entry to an OKF log.md (newest-first, date-grouped per spec §7).
 * Creates the file with `# <title>` if missing.
 */
export function appendLogEntry(file, entry, title = "Log") {
  const today = todayISO();
  const text = existsSync(file) ? readFileSync(file, "utf8") : `# ${title}\n`;
  const lines = text.split("\n");
  const todayIdx = lines.findIndex((l) => l.trim() === `## ${today}`);
  if (todayIdx !== -1) {
    lines.splice(todayIdx + 1, 0, `* ${entry}`);
  } else {
    let h = lines.findIndex((l) => l.startsWith("# "));
    if (h === -1) h = 0;
    lines.splice(h + 1, 0, "", `## ${today}`, `* ${entry}`);
  }
  writeFileSync(file, lines.join("\n").replace(/\n{3,}/g, "\n\n"));
}

/** Flat soul YAML uses strings; never treat the string "false" as truthy. */
export function resolveYolo(value) {
  if (value === undefined) return undefined;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error("yolo must be true or false");
}

// ---------- instances ----------
/** Every instance home under this deployment's agents root, by name → [home] —
 *  `<root>/<agent>/instances/<name>` read directly (so a home whose soul definition was
 *  removed still counts, and a capability-defined agent's homes count). Instance names are
 *  deployment-wide (human decision 2026-09-24): two souls never hold one name. */
function deploymentInstanceHomes(root) {
  const homes = new Map();
  const collect = (agentDir) => {
    const dir = join(agentDir, "instances");
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || !(e.isDirectory() || e.isSymbolicLink())) continue;
      if (!homes.has(e.name)) homes.set(e.name, []);
      homes.get(e.name).push(join(dir, e.name));
    }
  };
  let entries; try { entries = readdirSync(root, { withFileTypes: true }); } catch { entries = []; }
  for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".")) collect(join(root, e.name));
  return homes;
}

/** Every soul name of this deployment: souls on the agents root and capability
 *  agent dirs there (every agent dir), plus — for a workspace spawn — every soul the
 *  discovery declares (members and external), fetched or not. */
function deploymentSoulNames(root, prepared) {
  const names = new Set(listAgents(root).map((a) => a.name));
  try { for (const e of readdirSync(root, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith(".") && !RESERVED.has(e.name)) names.add(e.name); } catch { /* no root yet */ }
  const discovery = prepared?.discovery;
  for (const m of discovery?.members || []) for (const s of m.souls || []) if (typeof s?.name === "string") names.add(s.name);
  for (const x of discovery?.external || []) if (typeof x?.soul?.name === "string") names.add(x.soul.name);
  return names;
}

/** Instance names are at most 64 characters: the tightest consumer is the
 *  messaging alias (aweb allows 1–64 on both servers). A longer name is refused,
 *  never truncated — a name is never rewritten. */
export const MAX_INSTANCE_NAME = 64;
const nameTooLong = (name, remedy) => oatsError("E_INSTANCE_NAME_INVALID", `instance names are at most ${MAX_INSTANCE_NAME} characters; "${name}" is ${name.length} — ${remedy}`);

/** A derived name (`<soul>-<purpose>`, `<soul>-<n>`), de-duplicated
 *  deployment-wide against every instance and soul name (`-2`, `-3`, …). The
 *  final name, suffix included, is capped at MAX_INSTANCE_NAME. */
function nextInstanceName(root, agent, purpose, prepared) {
  const n = deriveInstanceName(root, agent, purpose, prepared);
  if (n.length <= MAX_INSTANCE_NAME) return n;
  if (!purpose) throw nameTooLong(n, `the soul name "${agent.name}" is too long to derive an instance name from; pass a shorter --name`);
  // Say the budget: the name is <agent name>-<purpose>[-<n>], and a package soul's agent name
  // carries its package id (oats-okf-knowledge-maintainer-…), so its purposes are short.
  const p = slug(purpose), prefix = `${slug(agent.name)}-`, suffix = n.length - prefix.length - p.length;
  const budget = Math.max(0, MAX_INSTANCE_NAME - prefix.length - suffix);
  throw Object.assign(nameTooLong(n, `the purpose ${JSON.stringify(p)} is ${p.length} characters; ${agent.name}'s instances are named ${prefix}<purpose>${suffix > 0 ? "-<n>" : ""}, which leaves at most ${budget} for the purpose — shorten it, or pass --name`), { details: { prefix, purpose: p, maxPurpose: budget } });
}
// The stem is the agent name AS A SLUG: a package soul's agent name holds `--`
// (acme-pkg--keeper) and its instances are acme-pkg-keeper-<purpose>, so the name
// that is length-checked and de-duplicated here is the one the home gets.
function deriveInstanceName(root, agent, purpose, prepared) {
  const stem = slug(agent.name);
  const base = purpose ? `${stem}-${slug(purpose)}` : undefined;
  const instancesDir = join(agent._dir, "instances");
  const own = existsSync(instancesDir) ? readdirSync(instancesDir) : [];
  const instances = deploymentInstanceHomes(root), souls = deploymentSoulNames(root, prepared);
  const taken = (n) => instances.has(n) || souls.has(n);
  if (base) {
    let n = base, i = 2;
    while (taken(n)) n = `${base}-${i++}`;
    return n;
  }
  let i = own.length + 1, n;
  do { n = `${stem}-${i++}`; } while (taken(n));
  return n;
}

/** `--name` (human decision 2026-09-24): the instance name is exactly `name` —
 *  never rewritten, never prefixed. It must already be a slug. (That it is not a
 *  soul name, and not taken, is checked after idempotency-key recovery.) */
export function explicitInstanceName(name) {
  if (typeof name !== "string" || !name || slug(name) !== name) {
    throw oatsError("E_INSTANCE_NAME_INVALID", `instance name ${JSON.stringify(name)} is not a slug (lowercase letters and digits, single dashes between them${typeof name === "string" && name ? `; e.g. ${slug(name)}` : ""}); --name is used exactly as given, never rewritten`);
  }
  if (name.length > MAX_INSTANCE_NAME) throw nameTooLong(name, "pass a shorter --name");
  return name;
}

/** The window names of `session` on the user's DEFAULT tmux server: only for a home that records no
 *  socket (listInstances). OATS creates nothing there: new sessions live on the OATS server below. */
export function tmuxWindows(session = DEFAULT_TMUX_SESSION) { return defaultTmuxWindows(session).windows; }

// ---------- the OATS tmux server ----------
/** The tmux server OATS creates its sessions on, selected by name (`tmux -L oats`): one per host user,
 *  in tmux's own per-user socket directory, with the user's tmux configuration loaded (no `-f`). A
 *  tool that restyles the default server does not reach it. Not configurable. The name selects the
 *  server only while a session is ensured (ensureOatsTmuxSession); every later step, and every record,
 *  uses the absolute socket that step returned, through tmuxOn. docs/execution-targets.md owns the rule. */
const OATS_TMUX_SERVER = "oats";
/** What OATS sets, always at WINDOW scope and by window id, on a window it created: nothing is ever
 *  set server-global or on a session, on any server. Sizing goes on every window OATS creates (the
 *  session's `hq` window and each agent window): viewers attach at their own size and depend on both
 *  options, and a viewer links the window itself, so the window's options travel with it. A sizing
 *  command that tmux refuses is ignored, as it always was (tmux 3.0 has no `window-size latest`).
 *  Colours go on the agent window only: it shows the viewer's colours whatever the server's global
 *  styles are, and a refused colour command fails the launch. */
const OATS_WINDOW_SIZING = [["window-size", "latest"], ["aggressive-resize", "on"]];
const OATS_WINDOW_COLOURS = [["window-style", "default"], ["window-active-style", "default"]];
function tmuxOatsServer(args, io, options = {}) {
  return (io?.exec || execFileSync)("tmux", ["-u", "-L", OATS_TMUX_SERVER, ...args], { encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...options });
}
/** A failed call in one line: the first line of its stderr, else how it ended. */
const failureLine = (e) => String(e?.stderr ?? "").trim().split("\n")[0] || (Number.isInteger(e?.status) ? `exit ${e.status}` : e?.signal ? `signal ${e.signal}` : String(e?.message || "failed"));
/** A failed call that ran to its own exit: it has a status, no signal ended it, and Node reports no
 *  failure of its own. A timeout and an output overflow carry a code and keep what the call had
 *  printed until then, so that text is not the call's answer. Anything else is not a completed call. */
const exitedByItself = (e) => Number.isInteger(e?.status) && e.signal == null && e.code == null;
/** What the OATS server holds, as `list-sessions` answers: whether it runs, its socket (any session
 *  names it), and whether a session named exactly `session` is there. No server and no such session
 *  are the only answers that mean absent, and "no server" is read only from a call that exited by
 *  itself: a line a cut-off call left behind is not tmux's answer. Any other failure is not absence.
 *  A missing socket file is absence only when `missingSocket(detail)` (a session start's check of its
 *  home, missingSocketUnestablished) answers null; its reason refuses the start (#624). Without it, as
 *  today. */
function oatsTmuxSessionSocket(session, io, missingSocket) {
  let listed;
  try { listed = tmuxOatsServer(["list-sessions", "-F", "#{session_name}\t#{socket_path}"], io); }
  catch (e) {
    if (isKernelCode(e?.code)) throw e;
    // A tmux that could not be run at all is the one failure a person can act on: say so.
    if (e?.code === "ENOENT") throw oatsError("E_RUNTIME_ENDPOINT_UNKNOWN", `could not read the OATS tmux server for session ${session}: tmux was not found through this process's PATH. Run this command with a PATH that holds tmux`);
    if (!exitedByItself(e)) throw oatsError("E_RUNTIME_ENDPOINT_UNKNOWN", `could not read the OATS tmux server for session ${session}: tmux list-sessions did not exit by itself (${typeof e?.code === "string" ? e.code : e?.signal || "no exit status"})`);
    const absence = tmuxServerAbsence(e);
    const why = absence === "missing-socket" && missingSocket ? missingSocket(tmuxFailure(e, "tmux list-sessions failed")) : null;
    if (why) throw oatsError("E_SESSION_UNKNOWN", `cannot establish whether the OATS tmux server for session ${session} is running, so nothing was started: ${why}`);
    if (absence) return { server: null, present: false };
    throw oatsError("E_RUNTIME_ENDPOINT_UNKNOWN", `could not read the OATS tmux server for session ${session}: ${tmuxFailure(e, "tmux list-sessions failed")}`);
  }
  let server = null, present = false;
  for (const line of listed.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    server ??= line.slice(tab + 1).trim() || null;
    if (line.slice(0, tab) === session) { server = line.slice(tab + 1).trim() || null; present = true; break; }
  }
  return { server, present };
}
/** The names that mark a process as an OATS instance: the launch identity, and what older kernels
 *  called it. One of them in the environment, even empty, is evidence of an instance. */
const INSTANCE_IDENTITY_ENV = ["OATS_INSTANCE", "OATS_INSTANCE_HOME", "OATS_HOME", "PI_AGENT_INSTANCE", "PI_AGENT_HOME"];
/** Every name the kernel itself generates into a launch or a hook environment, and the three that
 *  tie a process to its own terminal. None of them is part of an environment OATS starts a tmux
 *  server, a session or a window with. Not the whole OATS_ prefix: operators export configuration
 *  under it (OATS_HOME_DIR, OATS_TMUX_SESSION). The inventory: RESERVED_LAUNCH_ENV; what
 *  runLifecycleHooks adds for a hook (capability, layer, level, meta, the spawn and launch facts in
 *  its extraEnv, the team and workspace names of teamEnv); what operator dispatch, retire and a
 *  trigger add. Launch references (OATS_LAUNCH_REF_<NAME>, and the NAME each stands for) are
 *  removed by prefix in withoutKernelEnvironment. No harness's name is here. */
const KERNEL_ENV_NAMES = new Set([...RESERVED_LAUNCH_ENV, "COLORFGBG", "TMUX", "TMUX_PANE",
  "OATS_CAPABILITY", "OATS_LAYER", "OATS_LEVEL", "OATS_META", "OATS_DEPLOYMENT", "OATS_RESOLUTION", "OATS_OPERATION",
  "OATS_REPO", "OATS_BRANCH", "OATS_WORK", "OATS_KIND", "OATS_TASK", "OATS_HARNESS", "OATS_PREVIOUS_HARNESS", "OATS_RUNTIME", "OATS_PREVIOUS_RUNTIME",
  "OATS_LAUNCH_PREVIEW", "OATS_RETIRE_INTENT", "OATS_TRIGGER_EVENT_FILE",
  "OATS_TEAM_NAME", "OATS_TEAM_SCOPE", "OATS_TEAM_ID", "OATS_TEAM_LABEL", "OATS_TEAM_LABELS", "OATS_TEAMS", "OATS_TEAMS_SOURCE",
  "OATS_DEFAULT_TEAM", "OATS_DEFAULT_TEAM_ID", "OATS_DEFAULT_TEAM_FROM", "OATS_WORKSPACE_NAME", "OATS_WORKSPACE_KEY",
  // A worktree hook's tree (#796): never inherited by what such a hook starts.
  "OATS_TREE", "OATS_TREE_CLONE", "OATS_TREE_REMOTE", "OATS_TREE_MEMBER", "OATS_TREE_BASE", "OATS_TREE_BASE_OID", "OATS_PURPOSE", "OATS_TREE_ORIGIN"]);
function withoutKernelEnvironment(source) {
  const env = { ...source };
  for (const name of Object.keys(env)) {
    if (name.startsWith(LAUNCH_REF_PREFIX)) { delete env[name]; delete env[name.slice(LAUNCH_REF_PREFIX.length)]; }
  }
  for (const name of KERNEL_ENV_NAMES) delete env[name];
  return env;
}
/**
 * What `tmux show-environment -g -s` printed, as bytes, read strictly and never executed: the whole
 * text or nothing. tmux (cmd-show-environment.c) prints one entry per variable, each ending in a
 * line feed: `NAME="VALUE"; export NAME;` with `"`, `$`, a backtick and `\` in VALUE each preceded
 * by a backslash, or `unset NAME;` for a removed one. VALUE is read to its closing unescaped quote
 * (a backslash escapes the character after it), so a line feed inside a value stays inside it.
 *
 * Not every value can be known the same way on every tmux. tmux 3.4 and 3.5 write each printed
 * line through vis(3) (server-client.c server_client_print): a control character or a byte that is
 * not UTF-8 arrives as `\a`, `\b`, `\f`, `\r`, `\v` or three octal digits, and tmux 3.4 puts one
 * more backslash before a `$` that a letter, `_` or `{` follows (utf8.c utf8_strvis). Neither
 * changes where a value ends. So nothing is decoded: a variable is left out whole when its VALUE
 * holds a line feed, a `$` (escaped or bare, on every version), or a vis-encoded sequence. A
 * backtick, a quote and a backslash are written the same by every version read, and are carried.
 *
 * Kept: an entry whose NAME is a plain identifier and whose VALUE is none of the above; an `unset`
 * entry carries nothing, and its name is added to `cleared` when the caller passes one (tmux keeps
 * such an entry, and it masks the variable: a session's `unset PATH;` gives its panes no PATH). An
 * entry is left out only once it is framed whole (its name, its value to the closing quote, the
 * exact `; export NAME;` tail); its name is added to `omitted` when the caller passes one. So a
 * name is in the result, in `cleared`, in `omitted`, or absent from the text. null for bytes that
 * are not valid UTF-8 or that this grammar does not consume to the end: a caller refuses, it never
 * uses a partial result.
 */
export function parseTmuxShellEnvironment(bytes, omitted, cleared) {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
  const env = {};
  let i = 0;
  const take = (word) => { if (!text.startsWith(word, i)) return false; i += word.length; return true; };
  while (i < text.length) {
    if (take("unset ")) {
      const end = text.indexOf(";", i);
      if (end <= i || /[\s"=]/.test(text.slice(i, end))) return null;
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(text.slice(i, end))) cleared?.push(text.slice(i, end));
      i = end + 1;
    } else {
      const assign = text.indexOf("=\"", i);
      if (assign <= i) return null;
      const name = text.slice(i, assign);
      i = assign + 2;
      let value = "", closed = false, carried = true;
      while (i < text.length) {
        const c = text[i++];
        if (c === "\"") { closed = true; break; }
        if (c === "$") { carried = false; continue; }
        if (c === "`") return null; // tmux never writes a bare backtick
        if (c !== "\\") { value += c; continue; }
        const next = text[i];
        if (next === "$") { carried = false; i += 1; }
        else if (next !== undefined && "\"`\\".includes(next)) { value += next; i += 1; }
        else if (/^(?:[abfrv]|[0-7]{3})/.test(text.slice(i, i + 3))) { carried = false; i += /[0-7]/.test(next) ? 3 : 1; }
        else return null;
      }
      if (!closed || !take(`; export ${name};`)) return null;
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        if (carried && !value.includes("\n")) env[name] = value; else omitted?.push(name);
      }
    }
    if (!take("\n")) return null;
  }
  return env;
}
/** Whether this process runs inside an OATS instance, as the CLI resolves an in-home command:
 *  `{ home }` for the home OATS_INSTANCE_HOME names when it is one, else the instance home enclosing
 *  the working directory (a harness may strip the session environment). `{ evidence }` when neither
 *  gives a home and yet the environment carries an instance identity name: an instance's environment
 *  without an identified home is not "outside an instance". undefined otherwise. */
function callerInstance() {
  const named = process.env.OATS_INSTANCE_HOME;
  if (named && isAbsolute(named)) {
    try { if (isPlainObject(JSON.parse(readFileSync(join(named, "instance.json"), "utf8")))) return { home: named }; }
    catch { /* names no home */ }
  }
  const enclosing = enclosingInstanceHome(logicalCwd());
  if (enclosing) return { home: enclosing };
  const evidence = INSTANCE_IDENTITY_ENV.find((name) => process.env[name] !== undefined);
  return evidence ? { evidence } : undefined;
}
/** `tmux` as this process's own PATH finds it, always absolute: the creator chooses the tmux that
 *  runs, whatever environment the server it starts is given. A bare name is never run: an exec
 *  looks one up in the PATH of the environment it is passed, which here is the selected one.
 *  Entries in PATH order; a relative entry, and an empty one (an empty PATH is one empty entry),
 *  are this process's working directory, as an exec of `tmux` reads them. With no PATH, or none
 *  that holds a tmux, the creation of `session` is refused, for every creator: no default search
 *  path is assumed. Of the two, only "no PATH" is met in a run: the lookup before this runs the
 *  bare name with this process's own environment, so a PATH that holds no tmux is refused there
 *  first (oatsTmuxSessionSocket), session or no session. The no-match refusal here is the guard
 *  that the creation never runs a bare name, whatever the lookup did. */
function creatorTmux(session) {
  const refuse = (why) => oatsError("E_RUNTIME_ENDPOINT_UNKNOWN", `cannot create tmux session ${session} on the OATS tmux server: ${why}, and the tmux that creates a session is the one this process's own PATH finds; the session was not created. Run this command with a PATH that holds tmux`);
  if (process.env.PATH === undefined) throw refuse("PATH is not set in this process");
  const found = lookupOnPath("tmux", process.env.PATH);
  if (found) return found;
  throw refuse("no tmux was found on this process's PATH");
}
/**
 * The environment a `new-session` on the OATS server runs with: the only tmux call that can start
 * a server, so every one of them gets this, whether or not a server was seen a moment earlier. A
 * tmux server keeps the environment of the client that started it as its global environment, which
 * every pane created on it later inherits, and a new session takes the client's variables that
 * `update-environment` names.
 *
 * When no server answered the lookup (`startsServer`), so that this new-session starts it, the
 * environment is the user's login environment (lib/login-environment.mjs), for every creator: what
 * the login shell from the password database sets up, from a seed that holds nothing of the creator
 * but its locale and, when it is no instance, its session variables (an instance's come from the
 * server its home records, then from the platform's user session). The kernel's names and the
 * instance-identity names are removed from what it answers, and the operator's OATS configuration
 * (OATS_ and PI_AGENTS_ names that are not the kernel's) is the creator's (an instance's: its recorded
 * server's). When it cannot be read (a creator whose HOME is not the user's home directory, a
 * timeout, a non-zero exit, a partial or malformed answer, no HOME or PATH, a shell that is not bash,
 * zsh or fish), one line on stderr says so and names the fallback, never a value, and the creator falls
 * back to what follows. That fallback is degraded: neither a login environment nor a working agent
 * socket is assured.
 *
 * Otherwise (the server runs, or the login environment could not be read): a process inside an OATS
 * instance never passes its own environment (its harness's variables, its credentials, its
 * identity). It passes the global environment of the tmux server its home records: an existing
 * baseline, chosen because a window that instance opened on that server got exactly it; not proof
 * that it holds nothing old. The home's receipt is checked against instance.json first, as every
 * session verb checks its endpoint, and the text is read with the strict reader above, which can
 * leave values out. When any of that fails, or no home is identified, the session is not created:
 * no fallback to the caller's environment, to another server or to a built-in list. Any other
 * creator (an operator's shell, a schedule runner, the Desktop) passes its own environment. In
 * every case the kernel's names are removed from the final set.
 *
 * Environment and endpoint are chosen separately: which server is reached depends only on the
 * creator (its TMUX_TMPDIR, kept or absent as the creator has it, whatever the selected environment
 * says; its tmux); what the server process gets (HOME and so its configuration file, PATH,
 * everything else) comes from the selected environment, with no ambient value filling in. Values
 * travel only as the environment of that tmux process: never in an argument, a message, an event or
 * a file. docs/execution-targets.md owns the rule.
 */
const TMUX_SERVER_START_ENV = ["HOME", "XDG_CONFIG_HOME", "PATH", "SHELL"];
/** The operator's configuration names, carried into a server started with the login environment
 *  (the kernel's own names among them are removed first). */
const OPERATOR_CONFIG_ENV = /^(OATS_|PI_AGENTS_)/;
function oatsSessionEnvironment(session, io, { startsServer = false } = {}) {
  const caller = callerInstance();
  let recorded;
  const recordedServer = () => (recorded ??= recordedServerEnvironment(caller, session, io));
  const creatorsTmpdir = (env) => { if (process.env.TMUX_TMPDIR === undefined) delete env.TMUX_TMPDIR; else env.TMUX_TMPDIR = process.env.TMUX_TMPDIR; return env; };
  if (startsServer) {
    const login = captureLoginEnvironment({ creatorEnv: process.env, instance: !!caller, recorded: caller ? recordedServer().read : null, shell: process.env.OATS_TEST_LOGIN_SHELL || undefined });
    if (login.env) {
      for (const note of login.notes) process.stderr.write(`oats: warning: ${note}\n`);
      const env = withoutKernelEnvironment(login.env);
      for (const name of INSTANCE_IDENTITY_ENV) delete env[name];
      // The operator's own OATS configuration (OATS_HOME_DIR, OATS_TMUX_SESSION, OATS_PACKAGE_CATALOG,
      // any other OATS_ or PI_AGENTS_ name that is not the kernel's) stays the creator's, over what
      // the login shell set: a creator outside every instance gives its own; an instance, what the
      // server its home records has, never its own.
      const configured = caller ? recordedServer().read : process.env;
      for (const [name, value] of Object.entries(withoutKernelEnvironment(configured ?? {}))) if (OPERATOR_CONFIG_ENV.test(name)) env[name] = value;
      return creatorsTmpdir(env);
    }
    const fallback = !caller ? "this process's own environment" : recordedServer().error ? null : "a copy of the environment of the tmux server this instance's home records";
    process.stderr.write(`oats: warning: could not read your login environment (${login.failure}); ${fallback ? `the OATS tmux server is started with ${fallback} instead: a fallback, neither a login environment nor a working agent socket is assured` : "and there is no fallback from inside an instance"}\n`);
  }
  if (!caller) return withoutKernelEnvironment(process.env);
  const { env, error } = recordedServer();
  if (error) throw error;
  return creatorsTmpdir(env);
}
/** The global environment of the tmux server an instance's home records, read strictly: `read` (what
 *  the reader kept, or null), and `env` (a copy without the kernel's names) or `error` (the refusal
 *  a creation from inside an instance gets when it cannot use it). */
function recordedServerEnvironment(caller, session, io) {
  const refuse = (why) => oatsError("E_RUNTIME_ENDPOINT_UNKNOWN", `cannot create tmux session ${session} on the OATS tmux server from inside an OATS instance: ${why}. A tmux server and its sessions keep the environment of the process that creates them, and an instance's own environment must not become theirs; the session was not created. Create it from your own shell, outside every instance home (tmux -L ${OATS_TMUX_SERVER} new-session -d -s ${shellWord(session)} -n hq), or run this command there. tmux resolves -L ${OATS_TMUX_SERVER} with TMUX_TMPDIR: use the same TMUX_TMPDIR as this process, if it has one`);
  if (!caller.home) return { read: null, error: refuse(`this process carries an instance's identity (${caller.evidence}) and neither OATS_INSTANCE_HOME nor the working directory names its home`) };
  let target;
  try { target = instanceSessionTarget(caller.home).target; }
  catch (e) { if (!isKernelCode(e?.code)) throw e; return { read: null, error: refuse(`the session receipt of ${basename(caller.home)} could not be used (${e.code})`) }; }
  if (!target?.socket) return { read: null, error: refuse(`the home of ${basename(caller.home)} records no tmux server`) };
  // Bytes, not text; and nothing of a failed read (tmux's output, its error) goes into the refusal.
  let read = null;
  const omitted = [];
  try {
    const printed = (io?.exec || execFileSync)("tmux", ["-u", "-S", target.socket, "show-environment", "-g", "-s"], { timeout: 10000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    read = parseTmuxShellEnvironment(Buffer.isBuffer(printed) ? printed : Buffer.from(String(printed)), omitted);
  } catch (e) { if (isKernelCode(e?.code)) throw e; }
  if (read === null) return { read, error: refuse(`the environment of the tmux server that ${basename(caller.home)} is recorded on (${target.socket}) could not be read`) };
  // A variable the reader left out is never filled in from this process, and a server is never
  // started when the one left out decides which configuration it loads or which programs it runs.
  // (A recorded server that simply has none of them is copied as it is.)
  const undecided = TMUX_SERVER_START_ENV.find((name) => omitted.includes(name));
  if (undecided) return { read, error: refuse(`the tmux server that ${basename(caller.home)} is recorded on has a ${undecided} that cannot be carried over (its value holds a $, a line break or a character tmux prints encoded), and a tmux server's configuration and programs are chosen by it`) };
  return { read, env: withoutKernelEnvironment(read) };
}
/** The environment a `new-window` client runs with, and the `respawn-pane` client of a restart in
 *  place, for every creator (an instance, the Desktop, an operator's shell): the three names tmux's
 *  client reads its locale from, and nothing else. tmux's client does not start without a UTF-8
 *  locale, and on a host that has neither en_US.UTF-8 nor C.UTF-8 only these name one; tmux gives
 *  the pane none of them. A pane's environment is its session's over the server's global one
 *  (spawn.c environ_for_session), PATH included: tmux puts the client's PATH in its place only when
 *  the client has one, and this client has none. So a PATH and the state that interprets it (a
 *  version manager's bookkeeping, `__MISE_DIFF`, nvm's) come from one environment, the server's or
 *  the session's; OATS no longer overlays a creator's PATH onto it. That does not make an existing
 *  or external server's environment, a session override or a launch configuration's PATH coherent:
 *  OATS uses them as they are. The client is run by an absolute tmux (tmuxOn), since it has no PATH
 *  to look one up with. docs/execution-targets.md owns the rule. */
const TMUX_CLIENT_LOCALE_ENV = ["LANG", "LC_ALL", "LC_CTYPE"];
function oatsWindowEnvironment() {
  const env = {};
  for (const name of TMUX_CLIENT_LOCALE_ENV) if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}
/**
 * What a spawn or a start knows, BEFORE it creates, stops or writes anything, about the session it
 * will open a window in: `{ server, present }` from the lookup and, when `session` is not on the
 * OATS server and this is no preview, `env`: the environment its creation needs, read now, so that a
 * caller that cannot create it is refused with nothing left behind; the answer goes to
 * ensureOatsTmuxSession. It is also what the launch's checks first read (expectedPaneEnvironment). Not the
 * guarantee: ensureOatsTmuxSession decides by what it finds when it creates, and the harness is
 * looked up again on the session it returns; and an environment read for a running server is read
 * again there when that server has gone. undefined when this process has no tmux to run: the
 * caller's backend check refuses that.
 */
function planOatsTmuxSession(session, io, { preview = false, missingSocket } = {}) {
  if (!io?.exec && !which("tmux")) return undefined;
  let server, present;
  try { ({ server, present } = oatsTmuxSessionSocket(session, io, missingSocket)); }
  catch (e) { if (preview) return undefined; throw e; } // a preview reports, it does not refuse on a read
  if (present || preview) return { server, present };
  return { server, present, env: oatsSessionEnvironment(session, io, { startsServer: !server }), startsServer: !server };
}
/** The names a check of a launch reads from the pane the launch will run in, never from this
 *  process: where its harness is looked up, the home directory, and the three variables that move a
 *  harness's configuration folder (HARNESS_CONFIG_SELECTORS). For a selector "not set" is an answer:
 *  the harness then reads its default folder under HOME. For PATH and HOME it is a problem. */
const PANE_ENV_NAMES = ["PATH", "HOME", ...Object.values(HARNESS_FOLDER_VAR)];
/**
 * The environment a pane created in `session` on `socket` starts with, for PANE_ENV_NAMES, read as
 * tmux decides it (spawn.c, environ.c), never computed from this process: for each name the
 * session's own entry when it has one, otherwise the server's global one. `session` null reads the
 * global one only (a session about to be created on a running server). One `show-environment` for
 * the session and one for the server answer every name: each is made when a name first needs it,
 * at most once, and read with the strict reader, as bytes.
 * → `{ of(name), cwd }`. `of(name)` is `{ value, source }`; `{ absent: true, source }` for a selector
 * that neither holds, or that the session clears (the server's is then not the pane's); or
 * `{ source, problem }` when the pane's value cannot be established: a read that failed, a value
 * the strict reader leaves out (unknown), and for PATH and HOME an explicit clear (`unset PATH;`:
 * the pane has none at all; never substituted by the global one or this process's) or a server with
 * none (for PATH tmux would fall back to a compiled-in default, which OATS does not assume).
 * `source` names where the value comes from; no value is ever in it or in `problem`. A problem
 * carries `remedy`: what would make that entry readable, as a tmux command on this socket.
 */
function paneEnvironment(socket, session, io, cwd) {
  const read = (scope) => {
    const omitted = [], cleared = [];
    let env = null;
    try {
      const printed = (io?.exec || execFileSync)("tmux", ["-u", "-S", socket, "show-environment", ...scope, "-s"], { timeout: 10000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
      env = parseTmuxShellEnvironment(Buffer.isBuffer(printed) ? printed : Buffer.from(String(printed)), omitted, cleared);
    } catch (e) { if (isKernelCode(e?.code)) throw e; }
    return { env, omitted, cleared };
  };
  let own, global;
  const server = `the OATS tmux server (${socket})`;
  const tmuxAt = `tmux -S ${shellWord(socket)}`;
  const decide = ({ env, omitted, cleared }, name, source, holder, scope) => {
    const set = `give ${holder} a ${name} that OATS can read (${tmuxAt} set-environment ${scope} ${name} <value>)`;
    if (env === null) return { source, problem: `${source} could not be read`, unreadable: true, remedy: `make \`${tmuxAt} show-environment ${scope} -s\` answer` };
    if (Object.hasOwn(env, name)) return { value: env[name], source };
    if (cleared.includes(name)) return HARNESS_CONFIG_SELECTORS.has(name) ? { absent: true, source: `${holder}, which clears ${name}` } : { source, problem: `${holder} clears ${name} (unset ${name}), so its panes start with no ${name} at all`, remedy: set };
    if (omitted.includes(name)) return { source, problem: `${source} cannot be read as data (its value holds a $, a line break or a character tmux prints encoded)`, unreadable: true, remedy: HARNESS_CONFIG_SELECTORS.has(name) ? `${set}, or remove the entry (${tmuxAt} set-environment ${scope} -u ${name})` : set };
    return null;
  };
  const answers = new Map();
  const of = (name) => {
    if (answers.has(name)) return answers.get(name);
    let answer = session ? decide(own ??= read(["-t", `=${session}`]), name, `the ${name} of tmux session ${session}`, `tmux session ${session}`, `-t ${shellWord(`=${session}`)}`) : null;
    if (!answer) {
      const source = `the global ${name} of ${server}`;
      answer = decide(global ??= read(["-g"]), name, source, server, "-g")
        ?? (HARNESS_CONFIG_SELECTORS.has(name) ? { absent: true, source: `${session ? `tmux session ${session} and ` : ""}${server}, which set${session ? "" : "s"} no ${name}` }
          : { source, problem: `${server} has no ${name}${name === "PATH" ? ", and tmux then gives a pane a compiled-in default that OATS does not assume" : ", so its panes start with none"}`, remedy: `give ${server} a ${name} (${tmuxAt} set-environment -g ${name} <value>)` });
    }
    answers.set(name, answer);
    return answer;
  };
  return { of, cwd };
}
/** Why no prediction of a pane's environment is made, as the tail of "the pane's environment is not
 *  established": no server runs and this command starts none (a preview, a readiness read); this
 *  process could not read the server (no tmux for it, or a preview's read that failed); the spawn
 *  launches nothing; the session a start would create was refused. A tmux that is there and could
 *  not say whether a server runs is a read that failed, not a server known not to run:
 *  previewPaneEnvironment carries that failure (`unread`) beside the reason, so that a command that
 *  writes by this answer refuses instead of writing for this process's file (`oats harness trust`).
 *  A process with no tmux on its PATH makes no read at all: no prediction, and no `unread`. */
const NO_SERVER_YET = Object.freeze({ unestablished: " until a spawn starts the OATS tmux server (none runs)" });
const NO_PANE_READ = Object.freeze({ unestablished: ": this process could not read the OATS tmux server" });
const NO_TMUX = Object.freeze({ unestablished: ": this process has no tmux on its PATH to read the OATS tmux server with" });
const NO_LAUNCH = Object.freeze({ unestablished: ": this spawn launches nothing (--no-launch), and a start reads its own session's" });
const SESSION_REFUSED = Object.freeze({ unestablished: ": the session this start would create was refused" });
const HOME_SESSION_UNREAD = Object.freeze({ unestablished: ": this home's session record could not be read" });
/** The environment a launch's pane is expected to have (paneEnvironment's shape), from a plan
 *  (planOatsTmuxSession): the session's or the server's when a server runs, else the environment the
 *  server will be created with. `{ unestablished }`, with why, when that is not known (no plan, or a
 *  preview with no server: a preview reads no creation environment, which would start the user's
 *  login shell); the checks then read this process's values and say so, and the launch looks again
 *  on the session it actually gets. */
function expectedPaneEnvironment(plan, session, io, cwd) {
  // No plan: this process has no tmux to ask with, or a preview's question to tmux failed.
  if (!plan) return !io?.exec && !which("tmux") ? NO_TMUX : NO_PANE_READ;
  if (plan.server) return paneEnvironment(plan.server, plan.present ? session : null, io, cwd);
  if (!plan.env) return NO_SERVER_YET;
  const of = (name) => {
    const source = `the ${name} the OATS tmux server is created with`;
    if (plan.env[name] !== undefined) return { value: plan.env[name], source };
    if (HARNESS_CONFIG_SELECTORS.has(name)) return { absent: true, source: `the environment the OATS tmux server is created with, which sets no ${name}` };
    return { source, problem: `${source} is not set${name === "PATH" ? ", and tmux then gives a pane a compiled-in default that OATS does not assume" : ", so its panes start with none"}`, remedy: "start the OATS tmux server from your own shell" };
  };
  return { of, cwd };
}
/**
 * The environment a launch will have, for PANE_ENV_NAMES: the one answer to "where will this launch
 * run", which every check of a launch reads (the harness lookup, folder trust, the package probe and
 * the remedy it prints) and none reads from this process in its place. For each name, by precedence:
 *  1. what the launch's command line sets: the launch configuration's `env` (a literal, or a
 *     reference resolved from `env`, the spawning process: by design), over the capabilities' env
 *     (`capabilities`: `{ env, owner(name) }`), which only a start's package probe is given: a
 *     spawn's probe runs before its hooks, and the folder-trust check and the harness lookup do
 *     not read it (awebai/oats#1041);
 *  2. a name the launch removes (`removed`: removedLaunchEnv): absent, with the launch as its
 *     source, whatever the pane holds;
 *  3. the pane's (`pane`: paneEnvironment or expectedPaneEnvironment, or a function giving one,
 *     called once and only when a name is not decided by 1 or 2; `pane()` on the result is that one
 *     read, for a second answer over the same pane);
 *  4. no prediction (`pane` gives `{ unestablished }`, the reason as a clause): this process's
 *     value, carried with that `unestablished`, so that a check that read it says so
 *     (unestablishedNote) and never passes it off as the pane's; and with `unread` when the
 *     reason is a read of the server that failed, which a caller that writes must refuse.
 * → `{ of(name), cwd, pane, removed }` (`removed` for launchEffectiveEnv, built on this answer);
 * `of(name)` is paneEnvironment's answer: `{ value, source }`,
 * `{ absent: true, source }` (a selector only; an empty one is not set, as the harnesses read it) or
 * `{ source, problem }`. A reference whose source is not set gives a problem marked `unresolved`:
 * the caller's own check of references refuses it (E_LAUNCH_ENV_MISSING), not a lookup.
 */
export function launchEnvironment({ configEnv, configName, capabilities, removed = [], env = process.env, pane, cwd }) {
  let read;
  const paneAnswer = () => (read ??= { pane: (typeof pane === "function" ? pane() : pane) ?? NO_PANE_READ }).pane;
  const notThePanes = (answer) => ({ ...(answer.unestablished ? { unestablished: answer.unestablished } : {}), ...(answer.unread ? { unread: answer.unread } : {}) });
  // An empty selector is not set, as the harnesses read it; an empty HOME names no directory.
  const selector = (name, answer) => answer.value !== "" ? answer
    : HARNESS_CONFIG_SELECTORS.has(name) ? { absent: true, source: answer.source, ...notThePanes(answer) }
      : name === "HOME" ? { source: answer.source, problem: `${answer.source} is empty`, ...notThePanes(answer) } : answer;
  const of = (name) => {
    const own = Object.hasOwn(configEnv || {}, name) ? configEnv[name] : undefined;
    if (typeof own === "string") return selector(name, { value: own, source: `the ${name} of launch configuration ${configName}` });
    if (own && typeof own === "object" && own.fromEnv) {
      const source = `the ${name} of launch configuration ${configName} (from ${own.fromEnv})`;
      return env[own.fromEnv] === undefined ? { source, problem: `${name} references ${own.fromEnv}, not set on this host`, unresolved: true } : selector(name, { value: env[own.fromEnv], source });
    }
    if (capabilities?.env && Object.hasOwn(capabilities.env, name) && typeof capabilities.env[name] === "string") return selector(name, { value: capabilities.env[name], source: `the ${name} that ${capabilities.owner?.(name) || "a capability"} sets for this launch` });
    // A selector the launch removes (a manifest may declare one under a namespace it names); PATH
    // and HOME are never removed (removableLaunchEnvName).
    if (removed.includes(name) && HARNESS_CONFIG_SELECTORS.has(name)) return { absent: true, source: `this launch, which removes ${name} (a provider declares it and does not set it)` };
    const from = paneAnswer();
    if (from.of) {
      const answer = selector(name, from.of(name));
      // A relative folder is the pane's own: read against its working directory, the home.
      return HARNESS_CONFIG_SELECTORS.has(name) && typeof answer.value === "string" && cwd && !isAbsolute(answer.value) && !answer.value.startsWith("~") ? { ...answer, value: resolve(cwd, answer.value) } : answer;
    }
    const source = `this process's ${name}`;
    const why = { unestablished: from.unestablished, ...(from.unread ? { unread: from.unread } : {}) };
    // What this process itself would read: its HOME, else its user's home directory.
    const value = name === "HOME" ? env.HOME || homedir() : env[name];
    if (value !== undefined) return selector(name, { value, source, ...why });
    return HARNESS_CONFIG_SELECTORS.has(name) ? { absent: true, source, ...why } : { source, problem: `${source} is not set`, ...why };
  };
  return { of, cwd, pane: paneAnswer, removed };
}
/** What a check says when `names`, which it read, were not all the pane's: that the pane's
 *  environment is not established and why, and what it read instead, name by name (the launch
 *  configuration's value when it sets one, else this process's). null when every one was established. */
export function unestablishedNote(launchEnv, names) {
  const answers = names.map((name) => launchEnv.of(name));
  const why = answers.find((a) => a.unestablished)?.unestablished;
  if (!why) return null;
  return `the pane's environment is not established${why}; read instead: ${answers.map((a) => `${a.source}${a.absent ? " (not set)" : ""}`).join(", ")}`;
}
/**
 * The pane a launch would run in, for a command that only reads (a preview, readiness, `oats
 * harness trust`): expectedPaneEnvironment's shape, and never a creation environment, so never the
 * user's login shell. For a `home` whose recorded pane a start would reuse (running, or left as a
 * shell): that pane's session on its recorded server, as the start reads it. Otherwise the session
 * a launch would open its window in (the home's recorded one; without a home, `deployment`'s
 * session default) on the OATS server, when one runs. `{ unestablished }` when none runs, when
 * this process has no tmux on its PATH to ask with, when the home's session record cannot be read,
 * and when tmux could not say whether the server runs (a refused or cut-off `list-sessions`): that
 * last one with `unread`, the failure and what has to answer, because it is no evidence that no
 * server runs.
 */
export function previewPaneEnvironment({ home = null, meta = null, deployment = null, io } = {}) {
  let session = DEFAULT_TMUX_SESSION;
  if (home) {
    let target;
    try { ({ target } = instanceSessionTarget(home)); } catch (e) { if (!isKernelCode(e?.code)) throw e; return HOME_SESSION_UNREAD; }
    if (target) {
      let state = null;
      try { state = inspectSessionTarget(target, io); } catch (e) { if (isKernelCode(e?.code)) return HOME_SESSION_UNREAD; /* a server that has gone has no pane to reuse */ }
      if (state?.paneId && (state.present || state.state === "stopped")) return paneEnvironment(target.socket, target.session, io, home);
    }
    session = target?.session || meta?.tmux?.session || DEFAULT_TMUX_SESSION;
  } else if (deployment) {
    try { session = sessionDefaults(deployment).tmuxSession; } catch (e) { if (!isKernelCode(e?.code)) throw e; }
  }
  if (!io?.exec && !which("tmux")) return NO_TMUX;
  let found;
  try { found = oatsTmuxSessionSocket(session, io); }
  catch (e) { if (!isKernelCode(e?.code)) throw e; return { unestablished: NO_PANE_READ.unestablished, unread: `${e.message}. What has to answer, as this process: \`tmux -L ${OATS_TMUX_SERVER} list-sessions\`` }; }
  return expectedPaneEnvironment(found, session, io, home ?? undefined);
}
/** The one answer (launchEnvironment) for such a command: what the launch configuration sets
 *  (`configEnv`), else what the launch removes (`removed`), else the pane previewPaneEnvironment
 *  reads, read only when a name needs it. */
export function previewLaunchEnvironment({ configEnv, configName, removed = [], env = process.env, home = null, meta = null, deployment = null, io } = {}) {
  return launchEnvironment({ configEnv, configName, removed, env, pane: () => previewPaneEnvironment({ home, meta, deployment, io }), cwd: home ?? undefined });
}
/** The PATH a launch's harness is looked up on, from the one answer (launchEnvironment): a PATH set
 *  in the launch configuration is what the pane's command line applies, so the lookup uses it;
 *  otherwise the pane's own. A declared absolute or relative executable is never looked up
 *  (resolveLaunchExecutable). → `{ path, source, cwd }`, or `{ source, problem }` when the pane's PATH
 *  cannot be established. undefined: no prediction is made (or a reference is not set, which its own
 *  check refuses), and the lookup uses this process's PATH; the launch looks again on the session it
 *  gets, and a preview says so (unestablishedNote). */
function launchLookup(launchEnv) {
  const answer = launchEnv.of("PATH");
  if (answer.unestablished || answer.unresolved) return undefined;
  return answer.problem ? { source: answer.source, problem: answer.problem } : { path: answer.value, source: answer.source, cwd: launchEnv.cwd };
}
/**
 * Make sure `session` exists on the OATS server and return that server's absolute socket: the one
 * endpoint the caller then creates its window on, records and compensates on. `hq` is the directory
 * of the session's first window; `io.exec` replaces execFileSync (session start guards its roots there).
 * This `new-session`, the one that creates an agents' session, runs with oatsSessionEnvironment
 * (`plan`, when planOatsTmuxSession read it earlier), by the creator's own tmux, on the socket the
 * lookup named when the server runs. (The viewer's temporary session, lib/session-viewer.mjs, is
 * created with the attaching process's environment: awebai/oats#623.)
 * Two creators racing both succeed on one socket: the loser's `duplicate session` is answered by a
 * second lookup. tmux starts a server once: the first successful creator determines its initial
 * environment, and nothing here changes a running server's. E_RUNTIME_ENDPOINT_UNKNOWN when the
 * server cannot be read or names no socket, when this caller may not create the session, or when
 * its own PATH names no tmux to create it with (creatorTmux). `missingSocket` is a session start's
 * check of its home when the server's socket file is missing (oatsTmuxSessionSocket): with a reason,
 * E_SESSION_UNKNOWN and no server is created at that path.
 * A creator inside a systemd service on Linux starts the server in a scope of its own
 * (lib/tmux-server-scope.mjs, awebai/oats#915): the same tmux argv and environment, run by the
 * system's `systemd-run --user --scope`. When that cannot be done, the server starts as before and
 * `warnings` (the caller's answer's) says it lives inside that service.
 */
export function ensureOatsTmuxSession(session, hq, io, plan, missingSocket, warnings) {
  let { server: socket, present } = oatsTmuxSessionSocket(session, io, missingSocket);
  if (!present) {
    // The executable is chosen here, where the creation is about to run, and nowhere earlier: a
    // session that exists needs none, so nothing is refused for it.
    const tmux = creatorTmux(session);
    // The plan's environment, unless it was read for a running server that has gone since: a server
    // this call starts gets what a server start gets.
    const env = plan?.env && (plan.startsServer || socket) ? plan.env : oatsSessionEnvironment(session, io, { startsServer: !socket });
    const address = socket ? ["-S", socket] : ["-L", OATS_TMUX_SERVER];
    const args = ["-u", ...address, "new-session", "-d", "-s", session, "-n", "hq", "-c", hq, "-P", "-F", "#{socket_path}\t#{window_id}"];
    const options = { encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], env };
    const run = (file, argv) => (io?.exec || execFileSync)(file, argv, options).trim();
    // Inside a service: the scope to start in, or the warning a start by this process carries.
    const scope = serverScopePlan(creatorPlacement(io));
    let wrapper = null, unscoped = scope.warn ? serverScopeWarning(scope.warn) : null;
    if (scope.wrap) {
      // The scope's own INVOCATION_ID, which systemd-run exports to what it runs, is removed by the
      // system's env, so the server starts with `env` less any INVOCATION_ID: without both tools, no scope.
      const where = io?.systemToolDirs ? { dirs: io.systemToolDirs } : {};
      const systemdRun = systemTool("systemd-run", where), clean = systemTool("env", where);
      if (systemdRun.file && clean.file) wrapper = [systemdRun.file, ["--user", "--scope", "--collect", "--quiet", "--unit", serverScopeUnit({ socket, env }), "--", clean.file, "-u", "INVOCATION_ID"]];
      else unscoped = serverScopeWarning({ unit: scope.unit, reason: systemdRun.reason ?? clean.reason });
    }
    /** Started by this process outside a scope: said once it has started. */
    const plain = () => { const out = run(tmux, args); if (unscoped) warnings?.push(unscoped); return out; };
    let created;
    try {
      if (!wrapper) created = plain();
      else {
        try { created = run(wrapper[0], [...wrapper[1], tmux, ...args]); }
        catch (e) {
          if (isKernelCode(e?.code)) throw e;
          // Another creator's server (its scope already exists) answers: started, by it.
          const again = oatsTmuxSessionSocket(session, io, missingSocket);
          if (again.present) socket = again.server;
          else { unscoped = serverScopeWarning({ unit: scope.unit, reason: failureLine(e) }); created = plain(); }
        }
      }
    }
    catch (e) {
      if (isKernelCode(e?.code)) throw e;
      const again = oatsTmuxSessionSocket(session, io, missingSocket);
      if (!again.present) throw oatsError("E_RUNTIME_ENDPOINT_UNKNOWN", `could not create tmux session ${session} on the OATS tmux server: ${tmuxFailure(e, "tmux new-session failed")}`);
      socket = again.server;
    }
    if (created !== undefined) {
      const [path, hqWindow] = created.split("\t");
      if (!path) throw oatsError("E_RUNTIME_ENDPOINT_UNKNOWN", `tmux returned no endpoint for session ${session}`);
      socket = path;
      // The session's first window, which this call created: sized like every window OATS creates.
      // A dead server shows in the caller's next step on this socket.
      sizeWindow(socket, hqWindow, io);
    }
  }
  if (!socket) throw oatsError("E_RUNTIME_ENDPOINT_UNKNOWN", `tmux returned no endpoint for session ${session}`);
  return resolve(socket);
}
/** The window names of `session` on the OATS server, creating neither a server nor a session: none is
 *  an empty list. An early read only (an explicit name's refusal); the collision check that counts
 *  lists the socket ensureOatsTmuxSession returned. */
function oatsTmuxWindows(session) {
  try { return tmuxOatsServer(["list-windows", "-t", `=${session}`, "-F", "#{window_name}"]).split("\n").filter(Boolean); }
  catch { return []; }
}
/** The harness's window command: no COLORFGBG in the pane, none of the names only a hook is handed,
 *  and none of the names the launch removes (`removed`: removedLaunchEnv, each a portable name),
 *  whatever the server's global or the session's environment holds; the command's own prefix then sets what the launch sets. tmux runs
 *  the command with the server's `default-shell -c` (the user's shell: sh, bash and zsh all take
 *  `unset NAME…;`), and the fallback shell it execs inherits the result. Never persisted: the
 *  recorded command (meta.command) is the launch command alone. */
/** A launch's command followed by its exit marker (lib/session-end.mjs): the start id and the harness's
 *  exit status, written when the harness ends, by spawn's window and start's alike. */
const exitMarked = (command, startId, path) => `${command}; oats_start_status=$?; printf '{"startId":"%s","status":%d}\\n' ${shq(startId)} "$oats_start_status" > ${shq(path)}`;
const paneCommand = (command, removed = []) => `unset ${["COLORFGBG", "OATS_HARNESS_EXECUTABLE", "OATS_SPAWNER_HOME", ...removed].join(" ")}; ${command}; exec "\${SHELL:-/bin/zsh}"`;
/** The tail that marks the pane a launch creates (new-window: the new pane, tmux's current one after
 *  it) or respawns (`paneId`) as the agent's (AGENT_PANE_OPTION), chained into the launch's own tmux
 *  call. `-q`: a mark that cannot be set never fails the launch; readers then find the pane by id. */
const markAgentPane = (name, paneId) => [";", "set-option", "-q", "-p", ...(paneId ? ["-t", paneId] : []), AGENT_PANE_OPTION, name];
/** The sizing options on one window, each best effort: this command's failure is ignored, nothing is
 *  retried elsewhere and nothing global is written. */
function sizeWindow(socket, windowId, io) {
  if (!/^@\d+$/.test(windowId || "")) return;
  for (const [option, value] of OATS_WINDOW_SIZING) {
    try { tmuxOn(socket, ["set-option", "-w", "-t", windowId, option, value], io); } catch (e) { if (isKernelCode(e?.code)) throw e; }
  }
}
/** The agent window OATS just created, by the id new-window returned: showing the viewer's colours and
 *  sized for its viewers. Never a global option, another window or another server. The colour
 *  commands come first and are strict, so a lost server, a permission or a transport failure surfaces
 *  there and the tolerant sizing after them cannot mask it. The palette (`pane-colours`) is left
 *  alone: a local reset did not neutralise inherited entries. */
function prepareAgentWindow(socket, windowId, io) {
  if (!/^@\d+$/.test(windowId || "")) throw new Error("tmux new-window returned no window id");
  for (const [option, value] of OATS_WINDOW_COLOURS) tmuxOn(socket, ["set-option", "-w", "-t", windowId, option, value], io);
  // cursor-colour exists from tmux 3.3: -q makes an unknown option exit 0. -q also hides a missing
  // target, so only this command has it, and only after the two above succeeded on the same window.
  tmuxOn(socket, ["set-option", "-q", "-w", "-t", windowId, "cursor-colour", "default"], io);
  sizeWindow(socket, windowId, io);
}
/** One line for a start that opened its window on another server than the home recorded. */
const sessionMovedWarning = (instance, from, to) => `${instance} was recorded on the tmux server ${JSON.stringify(from)}; its window had to be created again, and new windows open on the OATS tmux server: it now runs on ${JSON.stringify(to)}, and that socket is recorded`;

/**
 * Spawn an instance of `agent` (as returned by findAgent/listAgents).
 * o: { instance?, purpose?, name?, repo?, work?, harness?, model?, task?, taskFile?, branch?, launch?, tmuxSession? }
 */
/** `oats-claude-config` (a one-line file naming the claude binary, found walking up from the context) is no
 *  longer read (0.32): a host names its claude executable in a default launch configuration. A file still in
 *  reach of a new claude launch refuses it, naming the file and the configuration to declare instead. */
export function legacyClaudeConfigRefusal(contextDir) {
  let d = resolve(contextDir);
  while (true) {
    const f = join(d, "oats-claude-config");
    if (existsSync(f)) {
      let name = null;
      try { name = readFileSync(f, "utf8").split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#")) || null; } catch {}
      const exe = name ? `executable: ${name}, ` : "";
      return Object.assign(oatsError("E_CLAUDE_CONFIG_REMOVED", `${f} is no longer read (OATS 0.32): declare this machine's claude default in oats-local.yaml instead — launch-configs: { <name>: { harness: claude, ${exe}default: true } } (oats launch-config set <name> --file <json>) — then delete ${f}`), { details: { file: f, executable: name, fix: `declare a claude default launch configuration (${exe}default: true), then delete ${f}` } });
    }
    const parent = dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

/** Resolve a model preference LIST (comma-separated "provider/id[:thinking]" patterns)
 * to the first entry whose provider/model is actually available to the harness.
 * pi: checked against `pi --list-models <pattern>` (authenticated providers).
 * claude: pi-style patterns are translated (anthropic/<id> → <id>) or dropped —
 * claude takes aliases/bare claude-* ids only; nothing usable → "" (claude default).
 * codex: translate openai/openai-codex entries to native ids, otherwise use its default.
 * Probe failures: first entry wins (pi errors loudly at launch). */
/** instance.json `modelFrom` (feature desktop-facts): where the model a home runs came from — "soul" (the
 *  soul's preference), "spawn" / "start" (an explicit --model then), "launch-config", "harness-default" (the
 *  harness's native model). A recorded model keeps `prior`. From resolveLaunchSelection's `modelSource`. */
export function modelFromOf(modelSource, { at = "spawn", prior = null } = {}) {
  if (typeof modelSource !== "string") return prior ?? null;
  if (modelSource === "explicit") return at;
  if (modelSource === "soul default" || modelSource === "soul preference") return "soul";
  if (modelSource === "local preference") return "local";
  if (modelSource === "local-default preference") return "local-default";
  if (modelSource.startsWith("launch-config ")) return "launch-config";
  if (modelSource === "recorded") return prior ?? null;
  if (modelSource.startsWith("native default")) return "harness-default";
  return prior ?? null;
}

export function resolveModelPreference(model, harness = "pi") {
  const prefs = String(model || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (harness === "codex") {
    for (const pref of prefs) {
      const bare = pref.replace(/:[a-z]+$/i, "");
      if (!bare.includes("/")) return bare;
      const [provider, ...rest] = bare.split("/");
      if (["openai", "openai-codex"].includes(provider) && rest.length) return rest.join("/");
    }
    return ""; // let Codex use its configured model rather than another provider's id
  }
  if (harness === "claude") {
    // Claude accepts its aliases and bare claude-* ids — NOT pi-style
    // "provider/model[:thinking]" patterns. Agents whose soul default is a
    // pi model are routinely harness-overridden to claude; passing the pi
    // pattern through makes claude reject the model at launch (operator
    // report, dev-coordinator-claude-sessions). Translate anthropic-provider
    // entries to the bare id (strip provider + :thinking) and drop other
    // providers' entries; no usable entry ⇒ "" (claude's own default).
    for (const pref of prefs) {
      const bare = pref.replace(/:[a-z]+$/i, "");
      if (!bare.includes("/")) return bare;              // alias or bare claude-* id
      const [provider, ...rest] = bare.split("/");
      if (provider === "anthropic" && rest.length) return rest.join("/");
    }
    return "";
  }
  if (prefs.length <= 1) return prefs[0] || "";
  if (harness !== "pi") return prefs[0];
  for (const pref of prefs) {
    const bare = pref.replace(/:[a-z]+$/i, ""); // strip :<thinking> for the catalog probe
    const [provider, ...rest] = bare.split("/");
    const id = rest.join("/");
    if (!id) return pref; // bare pattern (no provider) — let pi resolve it
    const out = probeTry(`pi --list-models ${shq(id)} 2>/dev/null`) || "";
    const found = out.split("\n").some((line) => {
      const cols = line.trim().split(/\s+/);
      return cols[0] === provider && cols[1] === id;
    });
    if (found) return pref;
  }
  return prefs[0];
}

// Relations a new instance can declare to an existing one at spawn time.
// "unrelated" is the no-link default (normalized away before recording).
export const RELATIONS = ["child", "sibling", "parent", "unrelated"];

/** Verify the harness packages that ACTIVE capabilities require for `harness`.
 *
 * Each comes from a declared harness-package requirement, so the capability has
 * stated the dependency. Installing it remains the operator's responsibility.
 * We verify PRESENCE and record provenance; we deliberately do NOT resolve the
 * extension's entry file. pi owns that resolution — its manifest supports globs
 * and exclusions, packages without a `pi` manifest use conventional directories,
 * and the package root is relocatable — so reimplementing it here would be a
 * second, wrong copy of pi's rules (reviewer-ad1b9f0). Extensions load through
 * pi's own discovery.
 *
 * Absence still fails the spawn: "aweb on pi requires the aweb pi package" is a
 * promise the instance's INSTRUCTIONS rely on, so starting without it would
 * leave the agent believing it can be woken by mail when it cannot. */
/** A harness-package requirement names its harness `harness` (0.27.0) or, as
 *  released manifests do (oats.aweb), `runtime`: read either, exactly one. */
export function requirementHarness(row) {
  if (!row || typeof row !== "object") return undefined;
  return Object.hasOwn(row, "harness") ? row.harness : row.runtime;
}
function verifyHarnessPackages(harness, resolved, contextDir, { bin, env } = {}) {
  // The probe's environment is the launch's (launchEffectiveEnv: the pane's PATH, HOME and
  // selectors, never this process's in their place), given as it is or as a function called at the
  // first requirement that applies: a launch with none reads nothing of its pane, and one whose
  // pane cannot be read is refused there (E_RUNTIME_ENDPOINT_UNKNOWN), before any probe. The
  // function may carry `note` (probeEnvironment): what the probe read in place of a pane's
  // environment that is not established, which a refusal for a missing package then says; and
  // `executable`, the program the launch's lookup selected, which the probe runs.
  let probeEnv;
  const found = [];
  const problems = [];
  // The session launches with the SELECTED executable (a configuration's,
  // the host's harness default included), so probing another binary would inspect a different
  // account's packages than the instance will actually use. The probe is the
  // manager's controlled list subcommand; no launch argument is added to it. A harness's own
  // name is run as the launch's lookup resolved it (`selected`), never looked up a second time by
  // the probe's exec: this process's working directory is not the pane's, so a relative entry of
  // the pane's PATH would name another program there. The remedy keeps the name as declared.
  const probeOpts = { context: contextDir, ...(bin ? { bin } : {}) };
  const selected = typeof env === "function" ? env.executable : undefined;
  const runOpts = bin || !selected ? probeOpts : { ...probeOpts, bin: selected };
  for (const cap of resolved.capabilities || []) {
    for (const raw of cap.manifest?.requires || []) {
      if (!raw || typeof raw !== "object") continue;
      if (Object.hasOwn(raw, "harness") && Object.hasOwn(raw, "runtime")) { problems.push(`${cap.id}: a requirement declares both \`harness\` and \`runtime\` (its pre-0.27 name); keep one`); continue; }
      if (requirementHarness(raw) !== harness) continue;
      // A requirement may be conditional on the capability's effective
      // settings (`when: { delivery: "channel" }`): rows whose condition does
      // not hold are not requirements of this spawn at all.
      if (raw.when !== undefined && (!raw.when || typeof raw.when !== "object" || Array.isArray(raw.when))) { problems.push(`${cap.id}: a requirement's \`when\` must be an object of setting names to values`); continue; }
      if (raw.when && !Object.entries(raw.when).every(([k, v]) => String(cap.settings?.[k] ?? "") === String(v))) continue;
      const spec = raw.package;
      if (!safeHarnessPackageSpec(spec, harness)) { problems.push(`${cap.id}: ${harness} package spec is not a plain source token (${JSON.stringify(spec)})`); continue; }
      if (raw.marketplace !== undefined && !safeHarnessSourceRef(raw.marketplace)) { problems.push(`${cap.id}: marketplace is not a plain source reference (${JSON.stringify(raw.marketplace)})`); continue; }
      probeEnv ??= typeof env === "function" ? env() : env;
      const status = harnessPackageStatus(harness, spec, probeEnv, runOpts);
      const mgr = HARNESS_PACKAGE_MANAGERS[harness];
      const stepList = mgr?.steps ? mgr.steps(spec, raw, probeOpts) : [mgr?.argv(spec, raw, probeOpts) || []];
      // Keep the remedy in the same resource directory and selected wrapper as
      // the probe; quote argv, never turn a path or package selector into shell code.
      // It starts with the selector the launch will read, as the probe's environment has it (the
      // pane's, never this process's), so that running it fixes the account that starts: Claude's
      // only when the launch has one, pi's folder always (its default is under the launch's HOME).
      // Pi expands ~ against the launch HOME; relative selectors are anchored
      // to the probe cwd before the remedy changes to contextDir.
      const piResourceDir = harness === "pi" ? piAgentDir(probeEnv).replace(/^~(?=$|\/)/, () => probeEnv.HOME) : undefined;
      const resourceEnv = harness === "pi" ? `PI_CODING_AGENT_DIR=${shq(resolve(piResourceDir))} `
        : harness === "claude" && probeEnv.CLAUDE_CONFIG_DIR ? `CLAUDE_CONFIG_DIR=${shq(resolve(probeEnv.CLAUDE_CONFIG_DIR))} ` : "";
      const direct = stepList.filter((a) => a.length).map((a) => resourceEnv + [bin || a[0], ...a.slice(1)].map(shq).join(" ")).join(" && ");
      const remedy = direct ? `ask the operator to run \`cd ${shq(contextDir)} && ${direct}\` with the selected harness's environment; OATS does not install packages during spawn or restart`
        : `ask the operator to install it with the selected harness's package manager`;
      // `ifInstalled: true`: the row constrains a package that may be absent
      // (an ambient extension must honour a contract IF it is there); absence
      // satisfies it. Without the flag, absence fails as before.
      if (!status.installed) { if (raw.ifInstalled === true) continue; problems.push(`${cap.id} requires the ${harness} package ${spec}, which is not installed — ${remedy}`); continue; }
      // A settings row is not proof the extension loads. Both of these leave the
      // capability silently absent, which is the loss this gate exists to stop.
      if (status.unverified) { problems.push(`${cap.id} requires the ${harness} package ${spec}: it is configured, but OATS could not verify it is installed (${status.unverified}) — a config entry is not an installation; ${remedy}`); continue; }
      if (status.missingFiles) {
        problems.push(status.dir
          ? `${cap.id} requires the ${harness} package ${spec}: ${harness} lists it at ${status.dir}, but nothing is installed there — ${remedy}`
          : `${cap.id} requires the ${harness} package ${spec}: ${harness} has it configured but reports no installed location, so it was never installed — ${remedy}`);
        continue;
      }
      if (status.disabled) { problems.push(`${cap.id} requires the ${harness} package ${spec}, which is installed but DISABLED, so it will not load — enable it (\`${probeOpts.bin || harness} plugin enable ${spec}\` for Claude), or drop the capability for this soul`); continue; }
      if (status.extensionsDisabled) { problems.push(`${cap.id} requires the ${harness} package ${spec}, but your ${harness} settings entry sets "extensions": [], which loads none of them — remove that filter, or drop the capability for this soul`); continue; }
      // A floor on the installed version (`minVersion`), checked once presence
      // and loadability are settled: a package whose manifest states an older
      // version, or none, fails closed with the same remedy, since an old
      // extension that ignores a newer contract (AWEB_DELIVERY) is exactly
      // what the floor guards.
      if (raw.minVersion) {
        const have = installedHarnessPackageVersion(harness, spec, status);
        if (!have) { problems.push(`${cap.id} requires the ${harness} package ${spec} at ${raw.minVersion} or later, but its installed version cannot be established (no package manifest under its install directory) — ${remedy}`); continue; }
        if (compareVersionTriples(have, raw.minVersion) < 0) { problems.push(`${cap.id} requires the ${harness} package ${spec} at ${raw.minVersion} or later; ${have} is installed — ${remedy}`); continue; }
      }
      if (status.extensionsFilter?.length) {
        // Unverifiable, not merely auditable: proving the filter selects this
        // capability's extension means implementing pi's glob semantics, and
        // guessing here is how an instance ends up promising a channel it does
        // not have. A filter on other resource kinds (skills) is unaffected.
        problems.push(`${cap.id} requires the ${harness} package ${spec}, but your ${harness} settings entry filters its extensions (${status.extensionsFilter.map((e) => JSON.stringify(e)).join(", ")}). OATS cannot verify that filter selects the required extension without reimplementing ${harness}'s matcher — remove the "extensions" filter for this package (a skills-only filter is fine), or drop the capability for this soul`);
        continue;
      }
      found.push({ capability: cap.id, harness, package: spec, identity: harnessPackageIdentity(harness, spec), dir: status.dir, filtered: status.filtered });
    }
  }
  if (problems.length) {
    const readInstead = typeof env === "function" ? env.note?.() : null;
    throw oatsError("E_HARNESS_RESOURCE_MISSING", `this instance runs on ${harness}, and its active capabilities require harness packages that are not installed:\n${problems.map((p) => `  ${p}`).join("\n")}${readInstead ? `\nThe account this probe read is not known to be the launch's: ${readInstead}` : ""}`);
  }
  const seen = new Set();
  return found.filter((x) => (seen.has(x.identity) ? false : seen.add(x.identity))).sort((a, b) => a.identity.localeCompare(b.identity));
}

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
const LAUNCH_PROMPT = { kind: "task-file", file: "TASK.md" };
/** The fixed prompt a codex launch starts with: it names the task file, never its text (argv is
 *  readable by every local user). Codex reads the file with a tool. */
export const CODEX_TASK_PROMPT = "Read TASK.md in this directory first: it is your briefing and your task.";
/** The prompt each harness gets, so the task's text never travels in argv: Claude Code inlines an
 *  `@file` mention; codex is pointed at the file. pi takes `@TASK.md` among its own arguments. */
const TASK_PROMPT = Object.freeze({ claude: "@TASK.md", codex: CODEX_TASK_PROMPT });
/** The prompt a resumed session gets in place of the task prompt (feature session-resume, R1): without
 *  it, a harness cut off mid-turn would sit idle until someone types. It states only what holds for
 *  every instance a resume brings back. */
export const RESUME_NOTICE = "OATS resumed this session after it was lost (the host restarted or its terminal server ended). Continue from where you were.";

/** The executable a launch uses: a configuration's declared one (a bare name
 *  on PATH; a path against the deployment directory when relative) or the
 *  harness's name on PATH. Never executed. A new claude launch with a legacy `oats-claude-config` in reach
 *  of its context is refused (E_CLAUDE_CONFIG_REMOVED, 0.32), whatever it declares.
 *  `lookup` (launchLookup: `{ path, source, cwd }` or `{ source, problem }`) is the PATH a bare name is
 *  looked up on, the one the pane runs it with; without one, this process's PATH. A result looked up
 *  there carries `lookup`, so a refusal can name where it looked. */
export function resolveLaunchExecutable({ harness, declared, declaringDir, contextDir, lookup }) {
  if (harness === "claude" && contextDir) { const refused = legacyClaudeConfigRefusal(contextDir); if (refused) throw refused; }
  if (declared?.includes("/")) {
    const path = isAbsolute(declared) ? declared : resolve(declaringDir || contextDir, declared);
    return { path, declared, resolvedFrom: isAbsolute(declared) ? "absolute" : `relative to ${declaringDir || contextDir}`, missing: existsSync(path) ? undefined : `${declared} (${path}) does not exist` };
  }
  const name = declared || harness;
  if (lookup) {
    const found = lookup.problem ? null : lookupOnPath(name, lookup.path, lookup.cwd);
    return { path: found, declared: declared || null, resolvedFrom: "PATH", lookup, missing: found ? undefined : lookup.problem ?? `${name} was not found on ${lookup.source}` };
  }
  const found = which(name);
  return { path: found || null, declared: declared || null, resolvedFrom: "PATH", missing: found ? undefined : `${name} binary not found on PATH` };
}
/** The refusal for an executable a launch looked up where its pane looks it up (`executable.lookup`)
 *  and did not find, or could not look up: E_HARNESS_UNAVAILABLE for the harness's own name,
 *  E_LAUNCH_EXECUTABLE for a configuration's declared name. Names the source and the remedies, never
 *  the PATH's contents. */
function executableNotOnPanePath(executable, { harness, config, from, at }) {
  if (!executable.declared) return harnessNotOnPanePath({ harness, from, at, why: executable.missing });
  return oatsError("E_LAUNCH_EXECUTABLE", `launch configuration ${config?.name}: ${executable.missing}; ${PANE_PATH_FIX}`);
}
/** null when `path` is a regular executable file; otherwise why not. */
export function checkLaunchExecutable(path) {
  try {
    const st = statSync(path);
    if (!st.isFile()) return `${path} is not a regular file`;
    accessSync(path, fsConstants.X_OK);
    return null;
  } catch (e) { return `${path} ${e.code === "ENOENT" ? "does not exist" : e.code === "EACCES" ? "is not executable" : e.message}`; }
}
/** Source names of {fromEnv} references absent from `env`. */
export function missingLaunchEnvRefs(configEnv, env = process.env) {
  return Object.values(configEnv || {}).filter((v) => v && typeof v === "object" && v.fromEnv && env[v.fromEnv] === undefined).map((v) => v.fromEnv).sort();
}
/** The selection a start makes: which configuration (explicit name, "none",
 *  a frozen recipe's, or the soul's default), and from it the harness and
 *  model. A named configuration is a unit: an explicit harness that disagrees
 *  with it is refused. On an existing home, --harness alone leaves the old
 *  configuration behind (its executable and args are not carried), and a
 *  model never crosses harnesses: explicit or configured model, else the
 *  frozen model on the same harness, else the harness's native default. */
/** Sentinel a caller passes as `model` to mean "the harness's own default, not the configured/soul preference". */
export const NATIVE_DEFAULT_MODEL = "@native-default";
export function resolveLaunchSelection({ launchConfigs = {}, agent, frozen, selection = {}, preference = null }) {
  const bad = (code, msg) => { throw oatsError(code, msg); };
  let wanted = selection.launchConfig;
  let config = null;
  if (wanted === undefined && frozen && !selection.harness) {
    // An ordinary start of an existing home runs what was recorded: its
    // configuration as captured (executable, args, env, references), whether
    // or not the scope still declares it that way. Only an explicit name
    // applies the current definition.
    // Named or not: the recorded executable (a saved wrapper, say), args and
    // env are what runs; later edits of the scope never change it.
    config = { name: frozen.launchConfig || null, harness: frozen.harness, ...(frozen.executableDeclared ? { executable: frozen.executableDeclared } : {}), executablePath: frozen.executable, args: [...(frozen.args || [])], env: { ...(frozen.env || {}) }, ...(frozen.model ? { model: frozen.model } : {}), ...(frozen.yolo !== undefined ? { yolo: frozen.yolo } : {}), source: frozen.launchConfigSource || null, ...(frozen.launchConfigDefault === true ? { harnessDefault: true } : {}), frozen: true };
    wanted = "none";
  }
  if (wanted === undefined) wanted = frozen ? "none" : (agent?.["launch-config"] || "none");
  if (wanted !== "none") {
    if (typeof wanted !== "string" || !Object.hasOwn(launchConfigs, wanted)) bad("E_LAUNCH_CONFIG_UNKNOWN", `no launch configuration ${JSON.stringify(wanted)} is effective here${frozen?.launchConfig === wanted ? " any more (the home was started with it; an unqualified start still runs the recorded one)" : ""}; oats launch-config list shows what is`);
    config = launchConfigs[wanted];
    if (selection.harness && selection.harness !== config.harness) bad("E_LAUNCH_CONFIG_MISMATCH", `launch configuration ${wanted} starts ${config.harness}; --harness ${selection.harness} disagrees with it (select another configuration, or --launch-config none with --harness)`);
  }
  // A launch preference (feature launch-preference: an inline or soul {harness, model}) stands where the
  // host default would: below the flags and a selected configuration.
  const harness = config?.harness || selection.harness || (frozen ? frozen.harness : preference?.harness || agent?.harness || "pi");
  if (!LAUNCH_HARNESSES.includes(harness)) bad("E_UNSUPPORTED_HARNESS", `unknown harness "${harness}" (pi|claude|codex)`);
  // 0.32 (feature launch-config-default): a launch that selected no configuration runs this host's default
  // for its harness, if one is declared. An explicit `--launch-config none` asks for the bare harness.
  const harnessDefault = !config && !(selection.launchConfig === "none" && !preference) ? harnessDefaultConfig(launchConfigs, harness) : null;
  let model, modelSource;
  // K6: an EXPLICIT "use the harness's native default" is distinct from an
  // omitted model (which inherits the configuration's or soul's preference).
  const nativeDefault = selection.model === NATIVE_DEFAULT_MODEL || (selection.model && typeof selection.model === "object" && selection.model.kind === "native-default");
  const explicit = !nativeDefault && selection.model !== undefined && selection.model !== null && String(selection.model).trim() !== "";
  if (nativeDefault) {
    model = ""; modelSource = "native default (explicit)";
  } else if (explicit) {
    model = resolveModelPreference(String(selection.model), harness); modelSource = "explicit";
    if (!model) bad("E_MODEL_UNKNOWN", `model preference ${JSON.stringify(selection.model)} has no entry usable by harness ${harness}; give a ${harness} model id`);
  } else if (config?.model) {
    model = config.frozen ? config.model : resolveModelPreference(config.model, harness); modelSource = config.frozen ? "recorded" : `launch-config ${config.name}`;
    if (!model) bad("E_MODEL_UNKNOWN", `launch configuration ${config.name} names model ${JSON.stringify(config.model)}, which has no entry usable by harness ${harness}`);
  } else if (preference && preference.harness === harness) {
    // A preference is a unit: its model, or the harness's own — never a lower layer's.
    model = preference.model ? resolveModelPreference(preference.model, harness) : ""; modelSource = model ? `${preference.from} preference` : "native default";
    if (preference.model && !model) bad("E_MODEL_UNKNOWN", `the ${preference.from} launch preference names model ${JSON.stringify(preference.model)}, which has no entry usable by harness ${harness}`);
  } else if (frozen) {
    if (frozen.harness === harness) { model = frozen.model || ""; modelSource = model ? "recorded" : "native default"; }
    else { model = ""; modelSource = "native default (harness changed)"; }
  } else if (harness !== (agent?.harness || "pi")) {
    // A soul's model preference belongs to the soul's harness; a bare alias
    // is no proof it fits another one. Nothing is passed across.
    model = ""; modelSource = "native default (harness differs from the soul's)";
  } else { model = resolveModelPreference(agent?.model || "", harness); modelSource = model ? "soul default" : "native default"; }
  // The harness default's model is the last fallback: below every layer that names one, above the harness's own.
  if (harnessDefault?.model && !model && !nativeDefault) {
    model = resolveModelPreference(harnessDefault.model, harness); modelSource = `launch-config ${harnessDefault.name}`;
    if (!model) bad("E_MODEL_UNKNOWN", `launch configuration ${harnessDefault.name} (the ${harness} default) names model ${JSON.stringify(harnessDefault.model)}, which has no entry usable by harness ${harness}`);
  }
  if (harnessDefault) config = harnessDefault;
  return { config, harness, model, modelSource, configuredYolo: config?.yolo };
}
/** This host's default launch configuration for `harness` (`default: true`), marked `harnessDefault`, or null. */
export function harnessDefaultConfig(launchConfigs, harness) {
  const found = Object.values(launchConfigs || {}).find((c) => c?.default === true && c.harness === harness);
  return found ? { ...found, harnessDefault: true } : null;
}
/** A home's launch layers now (feature launch-preference; --reselect-launch and inspect's launchCurrent): its
 *  RECORDED soul's launch (the soul copy it runs) and its deployment's oats-local.yaml souls.launch.
 *  `offered` is the description of a read of the workspace (lib/instance-resolution.mjs soulsOffered),
 *  which the layers need to say which keys of souls.launch name no soul: only when the home's soul has
 *  no entry of its own and souls.launch holds a key besides "*" (`needsOffered` on the answer says so
 *  when none was given). A start that selects again makes that read (startInstanceSession); inspect's
 *  launchCurrent and readiness make none, and report the layers as they are. */
export function homeLaunchLayers(realHome, meta, { offered = null } = {}) {
  const deployment = dirname(dirname(dirname(dirname(realHome))));
  const found = loadLocal(deployment);
  if (!found.path || resolve(dirname(found.path)) !== resolve(deployment)) throw oatsError("E_LOCAL_MISSING", `${deployment} has no oats-local.yaml: --reselect-launch reads its souls.launch`);
  const soul = isPlainObject(meta?.workspace?.soul) ? meta.workspace.soul : {};
  const soulDir = instanceSoulDir(realHome, meta);
  const file = soulDir ? join(soulDir, "soul.yaml") : null;
  const definition = file && existsSync(file) ? withConfigFile(file, () => parseYamlNested(readFileSync(file, "utf8"))) : null;
  const key = soul.package && typeof soul.qualifiedName === "string" ? soul.qualifiedName : meta.agent;
  const entries = isPlainObject(found.local?.souls?.launch) ? found.local.souls.launch : {};
  const needsOffered = !offered && !Object.hasOwn(entries, key) && Object.keys(entries).some((k) => k !== "*");
  return { ...launchLayers({ definition, entry: { repoKey: soul.repoKey ?? null, path: typeof soul.path === "string" ? soul.path : null, package: soul.package?.id ?? null }, key, local: found.local, offered }), needsOffered };
}
/** A NEW launch selection (a spawn, or a start/restart that reselects) from the flags and the launch
 *  layers (lib/launch-preference.mjs). → { launchSelection (resolveLaunchSelection's), launchChoice:
 *  { from, at, declared } }. A selection the fall-through would decide while souls.launch holds a key that
 *  names no soul is E_LAUNCH_PREFERENCE_UNMATCHED, before every other refusal here (for every new
 *  selection: a spawn, and a start that reselects). A configuration a layer names but the host lacks is
 *  E_LAUNCH_CONFIG_UNKNOWN naming the layer. `refuseAmbiguous` (a spawn) refuses a launch that names no
 *  configuration among several with no default (E_LAUNCH_CONFIG_AMBIGUOUS). Never reads a frozen recipe. */
export function selectNewLaunch({ launchConfigs = {}, agent, flags = {}, layers = null, refuseAmbiguous = false }) {
  const choice = selectionFrom({ flags, layers });
  const unmatched = launchPreferenceUnmatched({ choice, layers });
  if (unmatched) throw unmatched;
  const named = choice.from !== "flag" && choice.selection.launchConfig !== undefined && choice.selection.launchConfig !== "none" ? choice.selection.launchConfig : null;
  if (named !== null && !Object.hasOwn(launchConfigs, named)) throw launchConfigUnknown({ name: named, from: choice.from, at: choice.at });
  const launchSelection = resolveLaunchSelection({ launchConfigs, agent: layers ? {} : agent, selection: choice.selection, preference: choice.preference });
  const ambiguous = refuseAmbiguous ? launchConfigAmbiguous({ launchConfigs, harness: launchSelection.harness, config: launchSelection.config, choice }) : null;
  if (ambiguous) throw ambiguous;
  return { launchSelection, launchChoice: { from: choice.from, at: choice.at, declared: layers?.declared ?? null } };
}
/** The `Launch` report (feature launch-preference) a spawn with no flags would decide HERE, for listings
 *  (`oats souls`, `inspect --soul`): the same layers as selectNewLaunch, but no model catalogue is probed
 *  (`model` is the configured id) and a spawn's refusal becomes `problem` {code, message, fix}. `contextDir`
 *  is the deployment (where a harness executable resolves). A key of souls.launch that names no soul
 *  (E_LAUNCH_PREFERENCE_UNMATCHED) is the problem before any other, as in a spawn; `effective` stays the
 *  launch the fall-through would have given. */
export function launchReportFor({ layers, launchConfigs = {}, contextDir }) {
  const choice = selectionFrom({ layers });
  const unmatched = launchPreferenceUnmatchedProblem({ choice, layers });
  const report = (harness, model, launchConfig, problem = null) => launchReport({ declared: layers?.declared ?? null, harness, model, launchConfig, from: choice.from, at: choice.at,
    problem: unmatched ?? problem });
  let harness = "pi", model = null, config = null;
  if (choice.selection.launchConfig !== undefined && choice.selection.launchConfig !== "none") {
    // An unknown configuration launches nothing (`problem`); `effective` stays a real launch — the host
    // default — so a reader's closed decoder never meets a null harness.
    const name = choice.selection.launchConfig;
    if (!Object.hasOwn(launchConfigs, name)) { const e = launchConfigUnknown({ name, from: choice.from, at: choice.at }); return report("pi", null, null, { code: e.code, message: e.message, fix: launchConfigUnknownFix(name, choice.from) }); }
    config = launchConfigs[name]; harness = config.harness; model = typeof config.model === "string" && config.model ? config.model : null;
  } else if (choice.preference) { harness = choice.preference.harness; model = choice.preference.model ?? null; }
  // As a spawn: a layer naming "none" asks for the bare harness; otherwise no configuration is the harness default.
  if (!config && !(choice.selection.launchConfig === "none" && !choice.preference)) { config = harnessDefaultConfig(launchConfigs, harness); if (config && !model) model = typeof config.model === "string" && config.model ? config.model : null; }
  const ambiguous = launchConfigAmbiguous({ launchConfigs, harness, config, choice });
  if (ambiguous) return report(harness, model, null, { code: ambiguous.code, message: ambiguous.message, fix: ambiguous.details.fix });
  let exe;
  try { exe = resolveLaunchExecutable({ harness, declared: config?.executable, declaringDir: config?.source, contextDir }); }
  catch (e) { if (e?.code !== "E_CLAUDE_CONFIG_REMOVED") throw e; return report(harness, model, config?.name, { code: e.code, message: e.message, fix: `declare a claude default launch configuration (oats launch-config set), then delete ${e.details.file}` }); }
  if (!exe.path && !config?.executable) { const e = harnessUnavailable({ harness, from: choice.from, at: choice.at, why: exe.missing }); return report(harness, model, config?.name, { code: e.code, message: e.message, fix: e.details.fix }); }
  if (!exe.path) return report(harness, model, config.name, { code: "E_LAUNCH_EXECUTABLE", message: `launch configuration ${config.name}: ${exe.missing}`, fix: `fix the executable of launch configuration ${config.name} (oats launch-config set)` });
  return report(harness, model, config?.name);
}
/** The pane environment carrying each reference's value under a
 *  kernel-owned alias (OATS_LAUNCH_REF_<NAME>), which no configuration can
 *  name: the command says NAME="$OATS_LAUNCH_REF_NAME", so no source
 *  variable is ever named in the command and no assignment in the same
 *  prefix can shadow it (zsh evaluates a prefix's assignments in order).
 *  Each goes to the pane as a tmux `-e NAME=value` argument. */
export function launchEnvRefs(recipe, env = process.env) {
  const out = [];
  for (const [name, v] of Object.entries(recipe.env || {})) if (v && typeof v === "object" && v.fromEnv && env[v.fromEnv] !== undefined) out.push({ name: `${LAUNCH_REF_PREFIX}${name}`, value: env[v.fromEnv], target: name, source: v.fromEnv });
  return out;
}

/** The canonical path of this kernel's CLI: what the home's shim points at, and OATS_CLI_BIN. */
export function kernelBin() { return realpathSync(join(PKG_ROOT, "bin", "oats.mjs")); }
/** Where a home's `oats` lives: first on its harness's PATH, so plain `oats` inside an instance is
 *  the kernel that launched it, whatever other `oats` the host's PATH finds first. */
export const kernelShimDir = (home) => join(home, ".oats", "bin");
/** Inspect existing shim parents without following them or creating anything.
 * Receipt fences must preserve this refusal for an unsafe module root. */
function assertKernelShimParents(home) {
  for (const path of [join(home, ".oats"), kernelShimDir(home)]) {
    let stat;
    try { stat = lstatSync(path); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (!stat.isDirectory()) throw oatsError("E_LAUNCH_SHIM", `cannot write the kernel shim ${join(kernelShimDir(home), "oats")}: ${path} is ${stat.isSymbolicLink() ? "a symbolic link" : "not a directory"}; nothing was started`);
  }
}
/** Write <home>/.oats/bin/oats, a symlink to this kernel's CLI, replacing any shim a previous
 *  launch (perhaps by another kernel) left: built aside, then renamed over. `.oats` and `.oats/bin`
 *  must be directories of the home itself: a link there would carry the write outside the home.
 *  The target, or E_LAUNCH_SHIM naming the path and the cause (a launch never runs with the
 *  wrong `oats`), before anything outside the home is touched. */
export function writeKernelShim(home) {
  const dir = kernelShimDir(home), shim = join(dir, "oats");
  let target, aside;
  try {
    target = kernelBin();
    assertKernelShimParents(home);
    for (const d of [join(home, ".oats"), dir]) {
      let st;
      try { st = lstatSync(d); }
      catch (e) { if (e.code !== "ENOENT") throw e; mkdirSync(d); st = lstatSync(d); }
      if (!st.isDirectory()) throw new Error(`${d} is ${st.isSymbolicLink() ? "a symbolic link" : "not a directory"}`);
    }
    if (realpathSync(dir) !== join(realpathSync(home), ".oats", "bin")) throw new Error(`${dir} resolves outside the home`);
    aside = join(dir, `.oats-${randomUUID()}`);
    symlinkSync(target, aside);
    renameSync(aside, shim);
    return target;
  } catch (e) {
    if (aside) rmSync(aside, { force: true });
    throw oatsError("E_LAUNCH_SHIM", `cannot write the kernel shim ${shim}${target ? ` (to ${target})` : ""}: ${e.message}; nothing was started`);
  }
}
/** A parsed launch command's environment prefix with the home's shim directory first on PATH: a
 *  configuration's PATH (literal or reference) follows it, else the PATH the command runs under. */
function shimPathPrefix(tokens, binary, home) {
  const dir = shq(kernelShimDir(home));
  const prefix = tokens.slice(0, binary);
  const texts = prefix.map((t) => t.name !== "PATH" ? t.text : t.kind === "env" ? `PATH=${dir}:${shq(t.value)}` : `PATH=${dir}:"$${t.source}"`);
  if (!prefix.some((t) => t.name === "PATH")) texts.push(`PATH=${dir}:"$PATH"`);
  return texts;
}
/** codex runs tool commands with the PATH it is given here, the one the launching shell has (the
 *  shim first): its value is this host's, so only the execution carries it. The user's login shell,
 *  which Codex runs tool commands through, may still put its own profile entries ahead of it. */
const CODEX_TOOL_PATH = `-c "shell_environment_policy.set.PATH=\\"$PATH\\""`;
/** The binary and its arguments as the execution runs them. */
function executionArgv(tokens, binary, harness) {
  const texts = tokens.slice(binary).map((t) => t.text);
  if (harness === "codex") texts.splice(1, 0, CODEX_TOOL_PATH);
  return texts;
}
/** The persisted launch command as a shell runs it: the same command, with the home's kernel shim
 *  first on PATH. The persisted bytes never carry it (they stay a shape parseLaunchCommand reads). */
export function launchShellCommand(command, home, harness) {
  const { tokens, binary } = parseLaunchCommand(command);
  return [...shimPathPrefix(tokens, binary, home), ...executionArgv(tokens, binary, harness)].join(" ");
}

/** The deployment directory a home belongs to: the one its spawn recorded, else the nearest
 *  ancestor holding oats-local.yaml, else the agents root's parent. */
function deploymentOfHome(home, meta) {
  if (typeof meta?.workspace?.deployment === "string" && meta.workspace.deployment) return realPathOrNearest(meta.workspace.deployment);
  for (let d = dirname(resolve(home)); ; d = dirname(d)) {
    if (existsSync(join(d, "oats-local.yaml"))) return realPathOrNearest(d);
    if (dirname(d) === d) return realPathOrNearest(dirname(dirname(dirname(dirname(resolve(home))))));
  }
}
/** Folder trust for a launch in `home` (lib/harness-trust.mjs, read-only), read from the file the
 *  launch itself will read: the one its selector names, else the default one under its HOME, both
 *  from the one answer (`launch`: launchEnvironment), never from this process. `trustHome` — the
 *  codex launch trusts the home, because that file trusts its deployment root or an ancestor —
 *  `covered`, the `file` read and the warning when folder trust is not established there. `file`
 *  is null with a `problem` when the launch configuration does not resolve it (`configEnv`, its
 *  references read from `env`), and with `unreadable` when the pane's environment could not be
 *  read: the check then warns that the file could not be established and says nothing about
 *  trust, and codex's home is not trusted by a file nobody read. `note`: what was read in place of
 *  a pane's environment that is not established (a readiness read with no server, a spawn that
 *  launches nothing): the file read is then this process's and not known to be the launch's. The
 *  warning says it, in place of where the file comes from, and readiness says it of a file that
 *  does establish trust as well. A
 *  codex launch under yolo trusts its home whatever a file says, so nothing of it rests on the
 *  file: it carries no `note` and no `unreadable`. */
export function launchFolderTrust({ harness, home, meta, yolo, launch, env = process.env, configEnv = {}, launchConfig = null }) {
  if (harness !== "codex" && harness !== "claude") return { trustHome: false, covered: false, file: null, warning: null };
  const root = deploymentOfHome(home, meta);
  const variable = CONFIG_DIR_VAR[harness];
  // Without a file, only codex under yolo is covered: its launch trusts the home whatever a file says.
  const yoloCovers = harness === "codex" && yolo === true;
  const unknown = (facts) => { const covered = yoloCovers; return { trustHome: false, covered, file: null, ...facts, warning: harnessTrustWarning({ harness, root, file: null, covered, ...facts }) }; };
  const unresolved = launchConfigFolder(variable, configEnv, env)?.problem;
  if (unresolved) return unknown({ problem: `launch configuration ${launchConfig || "(recorded)"}: ${unresolved}` });
  const selector = launch.of(variable);
  // The default file is under HOME: read only when the launch has no selector.
  const base = selector.absent ? launch.of("HOME") : null;
  const failed = selector.problem ? selector : base?.problem ? base : null;
  if (failed) return unknown(yoloCovers ? {} : { unreadable: `${failed.problem}${failed.remedy ? `: ${failed.remedy}` : ""}` });
  const read = base ? { HOME: base.value } : { [variable]: selector.value };
  const file = harnessConfigFile(harness, read);
  const trustHome = harness === "codex" && codexTrustsRoot(root, { env: read });
  const covered = harness === "codex" ? trustHome || yolo === true : claudeTrusts(home, { env: read });
  const names = base ? [variable, "HOME"] : [variable];
  const note = yoloCovers ? null : unestablishedNote(launch, names);
  const from = note ?? (base ? `under ${base.source}` : selector.source);
  return { trustHome, covered, file, ...(note ? { note } : {}), warning: harnessTrustWarning({ harness, root, file, from, covered }) };
}

/** The harness command line of a recipe. With no configuration the bytes
 *  equal what spawn rendered before recipes: env prefix, the executable, the
 *  harness's own arguments, capability launch args, the task prompt. A
 *  configuration's args go after the harness's own options and before
 *  capability args; for claude/codex the `--` separator keeps them from
 *  swallowing the task, for pi they follow the task like capability args.
 *
 *  pi starts NORMALLY (decision 13 of the workspace model): its own skill and
 *  context discovery is left intact — the instance's copied capability skills
 *  under <home>/.agents/skills are found from cwd=home like any repo's — and OATS
 *  contributes only the composed AGENTS.md (--append-system-prompt). The task
 *  positional goes ahead of contributed options because pi has no `--`. claude gets `--` before the prompt so a
 *  greedy contributed flag cannot eat it. codex keeps its native policy; it
 *  never stops at Codex's update prompt, and the generated home is trusted for
 *  the launch (projects=...) under yolo or `trustHome`: the operator trusts the
 *  deployment root or an ancestor in Codex's config (lib/harness-trust.mjs),
 *  which Codex itself does not apply to the homes below it. Codex's own form
 *  of the override is the inline table: a dotted projects."<home>" key is not
 *  honoured (codex-cli 0.157.1).
 *
 *  `resume` ({ sessionId, prompt }, feature session-resume): the same launch continuing the harness's
 *  own conversation. Claude takes `--resume <id>` among its own options, before contributed ones, and
 *  the prompt after `--` in place of the task; pi takes `--session <id>`, and the prompt as the
 *  positional where `@TASK.md` stands. Codex has none yet. Only the executed window command is rendered
 *  so: what is persisted stays the ordinary launch. */
export function renderLaunchRecipe(recipe, { home, instance, redact = false, trustHome = false, resume = null }) {
  const { harness, executable, model, yolo } = recipe;
  const cfgArgs = (recipe.args || []).map(shq).join(" ");
  const hookArgs = recipe.hooks?.launch?.[harness] || "";
  const tail = `${cfgArgs ? ` ${cfgArgs}` : ""}${hookArgs ? ` ${hookArgs}` : ""}`;
  // The launch's environment, in prefix order: the instance, the capabilities' env, the
  // configuration's env (a reference by reference, never by value).
  const hookEnv = recipe.hooks?.env || {};
  const env = [["OATS_INSTANCE", instance], ["OATS_INSTANCE_HOME", home]].map(([name, value]) => ({ name, value }));
  for (const name of Object.keys(hookEnv).sort()) env.push({ name, value: redact ? "<redacted>" : hookEnv[name] });
  for (const name of Object.keys(recipe.env || {}).sort()) {
    const v = recipe.env[name];
    env.push(typeof v === "string" ? { name, value: redact ? "<redacted>" : v } : { name, reference: true });
  }
  let cmdline;
  if (harness === "claude") {
    cmdline = `${shq(executable)}${yolo ? " --dangerously-skip-permissions" : ""}${model ? ` --model ${shq(model)}` : ""}${resume ? ` --resume ${shq(resume.sessionId)}` : ""}${tail} -- ${shq(resume ? resume.prompt : TASK_PROMPT.claude)}`;
  } else if (harness === "codex") {
    // No resume selector until a Codex resume is proven end to end on a signed-in host: start
    // --resume takes a Codex home's fresh path (resume-unproven) and never asks for one.
    if (resume) throw new Error("renderLaunchRecipe: codex has no resume rendering");
    // Codex compares the key with its own working directory, in its on-disk spelling.
    const codexTrust = `projects={${JSON.stringify(canonicalHomePath(home))}={trust_level="trusted"}}`;
    // Codex may run tool commands outside the session's process (its shared app-server daemon),
    // so the env the prefix below gives the session is also set for them. A reference's value
    // never goes on argv, and PATH is the execution's (CODEX_TOOL_PATH: the shim first).
    const toolEnvArgs = env.filter((e) => !e.reference && e.name !== "PATH")
      .map((e) => ` -c ${shq(`shell_environment_policy.set.${e.name}=${JSON.stringify(e.value)}`)}`).join("");
    cmdline = `${shq(executable)} --cd ${shq(home)} -c check_for_update_on_startup=false${yolo ? " --yolo" : ""}${yolo || trustHome ? ` -c ${shq(codexTrust)}` : ""}${toolEnvArgs}${model ? ` --model ${shq(model)}` : ""}${tail} -- ${shq(TASK_PROMPT.codex)}`;
  } else {
    // Decision 13: pi starts NORMALLY — its own skill discovery (~/.pi/agent/skills,
    // .agents/skills up the tree, so the instance's copied capability skills are
    // found from cwd=home) and context files stay ambient. OATS contributes only
    // the composed instructions.
    cmdline = `${shq(executable)} --append-system-prompt ${shq(join(home, "AGENTS.md"))} --approve --name ${shq(instance)}${model ? ` --model ${shq(model)}` : ""}${resume ? ` --session ${shq(resume.sessionId)}` : ""} ${shq(resume ? resume.prompt : "@TASK.md")}${tail}`;
  }
  return `${env.map((e) => e.reference ? `${e.name}="$${LAUNCH_REF_PREFIX}${e.name}"` : `${e.name}=${shq(e.value)}`).join(" ")} ${cmdline}`;
}

/** Execution, not preview: mark pending before dispatch, then resolve native
 * storage inside the backend shell under the actual command environment.
 * The original executable/argv is exec'd unchanged after recording succeeds,
 * with the home's kernel shim first on PATH (every launch runs through here).
 * `start` is the launch's one native start (prepareNativeStart), prepared once and reused by every
 * render of that launch, so that the command dispatched is the only one with a pending receipt.
 * With `scope` (agentScopeOn's wrapper), that shell runs in a systemd scope of its own, named per
 * launch (lib/tmux-server-scope.mjs agentScope): execution only, like paneCommand's `unset`; the
 * persisted command, the recipe and the receipts never carry it. The wrapper is chosen only after
 * the probe started a scope in this pane's environment, so a failed systemd-run is not the
 * harness's exit. What remains is a race: systemd-run failing between the probe and the pane. The
 * pane's shell then reads exit status 1, the scope runner's: an ordinary exit (below 128, no
 * signal), which the start's exit marker (.oats-start-exited) reads as a harness that exited, never
 * one to relaunch, so the race cannot cause a spurious resume. No home file tells the two apart. */
function nativeRecordCommand(command, home, harness, { start, scope } = {}) {
  const { tokens, binary } = parseLaunchCommand(command);
  const args = tokens.slice(binary + 1).map(t => t.value ?? t.text);
  const id = start ?? prepareNativeStart(home, harness);
  const recorder = join(PKG_ROOT, "packages", "record", "bin", "record-native-start.mjs");
  const inner = `${shq(process.execPath)} ${shq(recorder)} ${shq(home)} ${shq(id)} ${shq(harness)} ${shq(JSON.stringify(args))} && exec ${executionArgv(tokens, binary, harness).join(" ")}`;
  const wrapper = scope ? agentScopeArgv(scope, agentScopeUnit({ home })).map(shq) : [];
  return `${[...shimPathPrefix(tokens, binary, home), ...wrapper].join(" ")} /bin/sh -c ${shq(inner)}`;
}
/** The agent's scope of the launch of `command` in a pane with `pane`'s environment (paneEnvironment)
 *  → agentScope's answer. The values the probe gets for SCOPE_ENV_NAMES are the ones systemd-run
 *  will run with: what the command's environment prefix sets (a literal, or a reference whose source
 *  is one of `refs`, the pane's `-e` values, else the pane's own), else nothing for a name the launch
 *  removes (paneCommand's `unset`), else the pane's. `io` is a test's (agentScope). */
function agentScopeOn(command, { pane, removed = [], refs = [] }, io) {
  return agentScope({ io, paneEnv: () => {
    const { tokens, binary } = parseLaunchCommand(command);
    const prefix = tokens.slice(0, binary);
    const given = new Map(refs.map((r) => [r.name, r.value]));
    const ofPane = (name) => {
      if (removed.includes(name)) return {};
      const answer = pane.of(name);
      if (answer.unestablished || answer.unreadable) return { reason: `the pane's ${name} cannot be read (${answer.problem || `the pane's environment is not established${answer.unestablished}`})` };
      return typeof answer.value === "string" ? { value: answer.value } : {};
    };
    const env = {};
    for (const name of SCOPE_ENV_NAMES) {
      const set = prefix.findLast((t) => t.name === name);
      const answer = !set ? ofPane(name) : set.kind === "env" ? { value: set.value } : given.has(set.source) ? { value: given.get(set.source) } : ofPane(set.source);
      if (answer.reason) return answer;
      if (answer.value) env[name] = answer.value;
    }
    return { env };
  } });
}


/** A recorded recipe this kernel understands, or a refusal before anything
 *  is observed or stopped. */
export function assertLaunchRecipe(recipe, what) {
  const bad = (why) => { throw oatsError("E_LAUNCH_RECIPE_UNSUPPORTED", `${what} records a launch recipe this kernel cannot start from (${why}); inspect launch in its instance.json`); };
  if (!recipe || typeof recipe !== "object") bad("not an object");
  recipe = upgradeLaunchRecipe(recipe);
  if (recipe.version !== LAUNCH_RECIPE_VERSION) bad(`version ${JSON.stringify(recipe.version)}, expected ${LAUNCH_RECIPE_VERSION}`);
  if (!LAUNCH_HARNESSES.includes(recipe.harness)) bad(`harness ${JSON.stringify(recipe.harness)}`);
  if (typeof recipe.executable !== "string" || !recipe.executable) bad("no executable");
  if (!Array.isArray(recipe.args) || recipe.args.some((a) => typeof a !== "string")) bad("args are not a list of strings");
  if (!recipe.env || typeof recipe.env !== "object" || Array.isArray(recipe.env)) bad("env is not a map");
  for (const [n, v] of Object.entries(recipe.env)) if (!(typeof v === "string" || (v && typeof v === "object" && typeof v.fromEnv === "string"))) bad(`env ${n} is neither a string nor a reference`);
  if (recipe.model !== null && recipe.model !== undefined && typeof recipe.model !== "string") bad("model is not text");
  if (recipe.yolo !== undefined && typeof recipe.yolo !== "boolean") bad("yolo is not a boolean");
  if (!recipe.hooks || typeof recipe.hooks !== "object") bad("no hooks record");
  return recipe;
}
/** The harness-package requirements that apply: declared for this harness
 *  and, for a conditional row, holding under the provider's (captured)
 *  settings. Nothing else is probed or restricted. */
export function applicableRequirements(harness, providers) {
  const holds = (cap, r) => !r.when || (r.when && typeof r.when === "object" && !Array.isArray(r.when) && Object.entries(r.when).every(([k, v]) => String(cap.settings?.[k] ?? "") === String(v)));
  const out = [];
  for (const cap of providers || []) for (const r of cap.manifest?.requires || []) if (r && typeof r === "object" && requirementHarness(r) === harness && holds(cap, r)) out.push({ capability: cap.id, package: r.package });
  return out;
}
function requirementsWithArgsMessage(harness, providers, config) {
  const rows = applicableRequirements(harness, providers);
  return `launch configuration ${config?.name || "(recorded)"} passes arguments (${config.args.map((a) => JSON.stringify(a)).join(", ")}) that the ${harness} package probe cannot carry, so ${rows.map((r) => `${r.capability}'s requirement ${r.package}`).join(", ")} cannot be verified for that launch; native configuration a required package must see belongs in a wrapper executable or the environment (env / fromEnv), not in args`;
}
/** ONE planner for what a start would run, used by preview and by starts of
 *  existing homes alike: the recorded recipe (or, under a selection, the
 *  current scoped configuration) resolved, preflighted, rendered. `preview`
 *  collects every failed check into `preflight` instead of throwing. Launch
 *  hooks of capabilities declaring `launchPreview` run here only as a preview
 *  (OATS_LAUNCH_PREVIEW=1); the others run here for real when a start plans,
 *  and not at all for a preview. A home
 *  that records no launch recipe (an earlier kernel spawned it) is not planned:
 *  E_LAUNCH_LEGACY, re-spawn it from the deployment. `pane`: the environment the launch's pane is
 *  expected to have (paneEnvironment's shape, or a function giving it, called only when a check
 *  needs a name the launch itself does not set); every check here reads it through the one answer
 *  (launchEnvironment), and says so when it is not established. */
export function planLaunch({ home, instance, meta, contextDir, agentLike, selection = {}, launchConfigs, resolvedCfg, env = process.env, preview = false, assertRoots, reselect = null, pane }) {
  assertRoots?.();
  const problems = [];
  const fail = (check, code, detail) => { if (!preview) throw oatsError(code, detail); problems.push({ check, ok: false, detail, code }); };
  // A recorded recipe is validated before anything is observed. A home without
  // one predates recipes: there is nothing this kernel plans from.
  if (meta && !(meta.launch && typeof meta.launch === "object")) throw oatsError("E_LAUNCH_LEGACY", `${meta.instance || home} records no launch recipe (an earlier kernel spawned it): re-spawn it from the deployment; nothing was changed`);
  const frozen = meta ? assertLaunchRecipe(meta.launch, meta.instance || home) : null;
  // The home's deployment declares the launch configurations (its oats-local.yaml,
  // found walking up from the home) — never the context directory, which may be a
  // member clone outside the deployment.
  const scopeConfigs = launchConfigs || (home ? launchConfigsAt(home) : resolvedCfg?.launchConfigs) || {};
  // A NEW selection (feature launch-preference) — `reselect` (the home's launch layers, --reselect-launch)
  // or explicit --launch-config / --harness — records which layer decided it (`launchChoice`); otherwise
  // the recorded launch stays frozen (launchChoice null).
  let chosen, launchChoice = null;
  if (reselect) ({ launchSelection: chosen, launchChoice } = selectNewLaunch({ launchConfigs: scopeConfigs, agent: {}, flags: { launchConfig: selection.launchConfig, harness: selection.harness, model: selection.model }, layers: reselect }));
  else {
    chosen = resolveLaunchSelection({ launchConfigs: scopeConfigs, agent: agentLike, frozen, selection });
    if (selection.launchConfig !== undefined || selection.harness !== undefined) launchChoice = { from: "flag", at: null, declared: meta?.launchDeclared ?? null };
  }
  const { config, harness, model, modelSource } = chosen;
  // A recorded yolo that came from a harness default belongs to that default: it never carries into a launch
  // the default no longer decides (a bare --launch-config none, another harness).
  const frozenYolo = frozen && !(frozen.launchConfigDefault === true && !config?.frozen) ? frozen.yolo : undefined;
  const yolo = resolveYolo(selection.yolo ?? chosen.configuredYolo ?? (frozen ? frozenYolo : agentLike?.yolo ?? resolvedCfg?.yolo));
  // Where this launch will run (launchEnvironment): what its configuration sets, else its pane's.
  const launchEnv = launchEnvironment({ configEnv: config?.env, configName: config?.name, env, pane, cwd: home });
  // A frozen recipe keeps its recorded path. Otherwise a bare name is looked up where the pane will
  // look it up (launchLookup: the configuration's PATH, else the pane's, the start's expected
  // session or server PATH; a start looks again on the session it gets).
  const executable = config?.frozen
    ? { path: config.executablePath, declared: frozen.executableDeclared ?? null, resolvedFrom: frozen.executableResolvedFrom || "recorded", missing: existsSync(config.executablePath) ? undefined : `${config.executablePath} (recorded) does not exist` }
    : resolveLaunchExecutable({ harness, declared: config?.executable, declaringDir: config?.source, contextDir, lookup: config?.executable?.includes("/") ? undefined : launchLookup(launchEnv) });
  // What the hooks are handed: the pane-side answer, not one this process's PATH gave.
  const executablePaneSide = !!(config?.frozen || config?.executable?.includes("/") || executable.lookup);
  // A bare name looked up on this process's PATH because the pane's is not established: said.
  const lookupNote = !config?.frozen && !config?.executable?.includes("/") && !executable.lookup ? unestablishedNote(launchEnv, ["PATH"]) : null;
  const notOnPane = !executable.path && executable.lookup ? executableNotOnPanePath(executable, { harness, config, from: launchChoice?.from, at: launchChoice?.at }) : null;
  if (notOnPane) {
    if (!preview) throw notOnPane;
    problems.push({ check: "executable", ok: false, detail: notOnPane.message, code: notOnPane.code });
  } else if (!executable.path && !config?.executable && launchChoice) {
    const e = harnessUnavailable({ harness, from: launchChoice.from, at: launchChoice.at, why: executable.missing });
    if (!preview) throw e;
    problems.push({ check: "executable", ok: false, detail: e.message, code: e.code });
  }
  const exeProblem = executable.path ? checkLaunchExecutable(executable.path) : notOnPane || (!config?.executable && launchChoice) ? null : executable.missing;
  if (exeProblem) fail("executable", "E_LAUNCH_EXECUTABLE", `launch configuration ${config?.name || "(harness default)"}: ${exeProblem}`); else if (!notOnPane) problems.push({ check: "executable", ok: true, detail: `${executable.path} (${executable.resolvedFrom})${lookupNote ? `; ${lookupNote}` : ""}` });
  // Capability contributions: recorded at spawn with provenance; a harness
  // switch needs the new harness's launch args from the same capabilities.
  let hooks = { launch: {}, env: {}, contributions: [], pending: true };
  if (frozen) {
    // Recorded contributions, refreshed by capabilities that declare a
    // launch hook; a harness change needs the new harness's arguments from
    // every capability that gave harness-specific ones; recorded arguments
    // of a capability the scope no longer trusts are not reused. Hooks that
    // declare launchPreview run here under OATS_LAUNCH_PREVIEW=1, for a start
    // too (it runs them for real once its preflight passed); the others run
    // here for real on a start, and not at all for a preview.
    try {
      hooks = prepareLaunchHooks({ frozen, harness, resolvedCfg, home, meta, contextDir, extraEnv: harnessExecutableEnv(executable.path, executablePaneSide), assertRoots, pass: preview ? "preview" : "plan" });
      const current = new Map((resolvedCfg?.capabilities || []).map((c) => [c.id, c]));
      const untrusted = hooks.contributions.filter((c) => c.capability && current.has(c.capability) && !current.get(c.capability).trust?.trusted).map((c) => c.capability);
      const inactive = hooks.contributions.filter((c) => c.capability && !current.has(c.capability)).map((c) => c.capability);
      if (untrusted.length) fail("capabilities", "E_LAUNCH_PREPARATION", `${untrusted.join(", ")} contributed to this launch at spawn but is no longer trusted in the scope; respawn the instance; nothing was stopped`);
      else problems.push({ check: "capabilities", ok: true, detail: `${harness !== frozen.harness ? "prepared for the new harness" : "recorded contributions reused"}${hooks.refreshed?.length ? `; refreshed by launch hooks: ${hooks.refreshed.join(", ")}` : ""}${hooks.notRun?.length ? `; recorded contribution shown, launch hook not run for a preview (not preview-aware): ${hooks.notRun.join(", ")}` : ""}${inactive.length ? `; no longer active in the scope, recorded contribution kept: ${inactive.join(", ")}` : ""}` });
    } catch (e) {
      if (e.code !== "E_LAUNCH_PREPARATION") throw e;
      fail("capabilities", e.code, e.message);
      hooks = { launch: { ...(frozen.hooks?.launch || {}) }, env: { ...(frozen.hooks?.env || {}) }, contributions: frozen.hooks?.contributions || [] };
    }
  } else problems.push({ check: "capabilities", ok: true, detail: "decided by the capabilities' spawn hooks" });
  // A configuration may not override environment a capability owns.
  const configEnv = config?.env || {};
  // What this launch removes (removedLaunchEnv): the names its providers declare that their payload and
  // the configuration leave out. Its checks read them as removed and its window command unsets them.
  // A plan with no recorded launch (meta null) has no payload yet: the spawn decides it.
  const declaredEnv = frozen ? homeDeclaredLaunchEnv(meta, frozen, launchManifestDir(home, meta) ? capabilityManifests(home) : {}) : [];
  const removedEnv = removedLaunchEnv({ declared: declaredEnv, hooksEnv: hooks.env, configEnv });
  const owned = Object.keys(configEnv).filter((n) => Object.hasOwn(hooks.env, n));
  if (owned.length) {
    const owner = (n) => hooks.contributions.find((c) => (c.env || []).includes(n))?.capability || "a capability";
    fail("environment", "E_LAUNCH_ENV_CONFLICT", `${owned.map((n) => `${n} (set by ${owner(n)})`).join(", ")} cannot be overridden by launch configuration ${config?.name}; change the capability's setting instead`);
  }
  const missing = missingLaunchEnvRefs(configEnv, env);
  if (missing.length) fail("environment", "E_LAUNCH_ENV_MISSING", `launch configuration ${config?.name} references ${missing.join(", ")}, not set on this host; nothing was stopped or started`);
  else if (!owned.length) problems.push({ check: "environment", ok: true, detail: `${Object.keys(configEnv).length} value(s), references resolved on the execution host at start` });
  problems.push({ check: "model", ok: true, detail: model ? `${model} (${modelSource})` : `native default (${modelSource})` });
  // Harness package requirements: the captured providers' (bindings united
  // with contributions, by id, current manifest, captured settings for
  // conditional rows) for an existing home, the scope's for a new instance;
  // probed under the launch's EFFECTIVE environment with the selected
  // executable, only when some requirement is declared for this harness and
  // every reference resolved. Configuration arguments cannot be applied to a
  // package probe (it must never start a conversation), which is stated. A pane
  // whose environment cannot be read is refused with its own code, and one that
  // is not established is probed with what the item names.
  if (executable.path && !missing.length && !owned.length) {
    const providers = frozen
      ? capturedProviders(meta, frozen).map((p) => { const dir = launchManifestDir(home, meta); const manifest = dir ? capabilityManifest(p.id, dir) : undefined; return manifest ? { id: p.id, manifest, settings: p.settings } : null; }).filter(Boolean)
      : (resolvedCfg?.capabilities || []);
    const declared = applicableRequirements(harness, providers).length > 0;
    if (declared && (config?.args || []).length) {
      // The controlled probe cannot carry configuration arguments, so with
      // an applicable requirement a launch under such arguments cannot be
      // reported verified: refused, truthfully, with the way out.
      fail("harness-packages", "E_LAUNCH_PROBE_UNSUPPORTED", requirementsWithArgsMessage(harness, providers, config));
    } else if (declared) {
      // The check fails with the code the gate refused with, never another name for it (#1047):
      // E_HARNESS_RESOURCE_MISSING, or E_RUNTIME_ENDPOINT_UNKNOWN for a pane whose environment it
      // cannot read (#993). Anything else it throws is a fault, not a missing package:
      // thrown on, as the capabilities check above does, for the command's door to answer.
      try {
        // The probe's answer also holds what the capabilities set, over the same read of the pane.
        const probeLaunch = launchEnvironment({ configEnv, configName: config?.name, capabilities: { env: hooks.env, owner: (name) => hooks.contributions.find((c) => (c.env || []).includes(name))?.capability }, removed: removedEnv, env, pane: launchEnv.pane, cwd: home });
        verifyHarnessPackages(harness, { capabilities: providers }, contextDir, { ...(config?.executable || config?.frozen ? { bin: executable.path } : {}), env: probeEnvironment(() => launchEffectiveEnv({ base: env, hooksEnv: hooks.env, configEnv, launch: probeLaunch, harness }), probeLaunch, harness, executable.path) });
        const probeNote = unestablishedNote(probeLaunch, probeNames(harness));
        problems.push({ check: "harness-packages", ok: true, detail: `verified with ${executable.path}${(config?.args || []).length ? "; configuration arguments are not applied to the probe: native configuration the packages must see belongs in a wrapper or the environment" : ""}${probeNote ? `; ${probeNote}` : ""}` });
      } catch (e) { if (!["E_HARNESS_RESOURCE_MISSING", "E_RUNTIME_ENDPOINT_UNKNOWN"].includes(e?.code)) throw e; fail("harness-packages", e.code, e.message); }
    } else problems.push({ check: "harness-packages", ok: true, detail: "no harness package requirement declared for this harness; nothing probed" });
  }
  const recipe = {
    version: LAUNCH_RECIPE_VERSION, harness, launchConfig: config?.name || null, launchConfigSource: config?.source || null, ...(config?.harnessDefault ? { launchConfigDefault: true } : {}),
    executable: executable.path || executable.declared || harness, executableDeclared: executable.declared ?? null, executableResolvedFrom: executable.resolvedFrom,
    args: [...(config?.args || [])], env: { ...configEnv }, model: model || null, ...(yolo !== undefined ? { yolo } : {}),
    hooks: frozen ? { launch: hooks.launch, env: hooks.env, contributions: hooks.contributions } : hooks, prompt: LAUNCH_PROMPT, kernelBin: kernelBin(),
    ...(frozen?.legacy ? { legacy: { ...frozen.legacy, ...(hooks.refreshed?.length ? { replacedBy: hooks.refreshed } : {}) } } : {}),
  };
  const inst = instance || meta?.instance || basename(home);
  const trustLaunch = removedEnv.length ? launchEnvironment({ configEnv: config?.env, configName: config?.name, removed: removedEnv, env, pane: launchEnv.pane, cwd: home }) : launchEnv;
  const { trustHome } = launchFolderTrust({ harness, home, meta, yolo: recipe.yolo, launch: trustLaunch, env, configEnv, launchConfig: config?.name });
  const command = renderLaunchRecipe(recipe, { home, instance: inst, trustHome });
  const selectionSource = frozen ? (config?.frozen || (!config && !selection.launchConfig && !selection.harness) ? "frozen" : "config") : "config";
  // A preview states what the start will do; the start states it in its own output.
  const previewNotices = preview ? launchStartNotices(dirname(dirname(dirname(dirname(home)))), harness, command) : [];
  return { recipe, command, trustHome, declaredEnv, removedEnv, harness, model: model || undefined, modelSource, yolo, config, executable, executablePaneSide, preflight: problems, ok: problems.every((c) => c.ok), selectionSource, frozen, launchChoice, warnings: [...(hooks.warnings || []), ...previewNotices], previewedHooks: hooks.previewed || [], volatileEnv: hooks.volatileEnv || [], ...(hooks.meta ? { hookMeta: hooks.meta } : {}), ...(hooks.dialogClaims ? { hookDialogClaims: hooks.dialogClaims } : {}) };
}
/** The names a package probe of `harness` depends on: where its program is found and runs, the
 *  home directory, and that harness's own selector. */
const probeNames = (harness) => ["PATH", "HOME", ...(HARNESS_FOLDER_VAR[harness] ? [HARNESS_FOLDER_VAR[harness]] : [])];
/** The package probe's environment as verifyHarnessPackages takes it: `make`, called at the first
 *  requirement that applies, carrying `note`: what the probe read in place of a pane's environment
 *  that is not established (unestablishedNote; null when every name is the pane's), and
 *  `executable`: the absolute path the launch's lookup selected, which is the program the probe runs. */
const probeEnvironment = (make, launchEnv, harness, executable) => Object.assign(make, { note: () => unestablishedNote(launchEnv, probeNames(harness)), executable });
/** A PATH as a pane whose working directory is `cwd` reads it, for a process that runs elsewhere:
 *  a relative entry, and an empty one, are `cwd` (lookupOnPath). Unchanged without a `cwd`. */
const panePathFrom = (path, cwd) => cwd ? path.split(":").map((dir) => resolve(cwd, dir || ".")).join(":") : path;
/** The environment a planned launch is judged under by what runs a program for it (the package
 *  probe): this process's `base` without the names the launch removes (`launch.removed`:
 *  removedLaunchEnv), the capabilities' validated env, the configuration's literals and
 *  its references resolved from the BASE (never from the prefix beside them); and, for
 *  PANE_ENV_NAMES, the one answer (`launch`: launchEnvironment) in place of this process's values:
 *  each is set as the launch will have it, or removed when the launch will have none. So a probe
 *  selects the account the launch will, and runs what its pane would. A name the probe depends on
 *  (PATH, HOME, `harness`'s own selector) that cannot be established is refused
 *  (E_RUNTIME_ENDPOINT_UNKNOWN: which name, where it was read, what makes it readable), never
 *  answered from this process; another harness's selector in that state is left out. Every other
 *  name stays this process's: only these five are read from the pane. The pane's PATH is given
 *  with its relative entries resolved against the pane's working directory (panePathFrom). */
export function launchEffectiveEnv({ base = process.env, hooksEnv = {}, configEnv = {}, launch, harness } = {}) {
  const out = { ...base };
  // What the launch removes (launch.removed: removedLaunchEnv) is not this process's either.
  for (const name of launch?.removed || []) delete out[name];
  Object.assign(out, hooksEnv);
  for (const [name, v] of Object.entries(configEnv || {})) {
    if (typeof v === "string") out[name] = v;
    else if (v && typeof v === "object" && v.fromEnv && base[v.fromEnv] !== undefined) out[name] = base[v.fromEnv];
  }
  for (const name of PANE_ENV_NAMES) {
    const answer = launch.of(name);
    if (answer.unresolved) continue; // a reference that is not set: the caller's own check refuses it
    // The pane's PATH, as the pane reads it: the probe and what it starts run in this process's
    // working directory, where a relative entry would name another directory than the pane's.
    if (!answer.problem) { if (answer.absent) delete out[name]; else out[name] = name === "PATH" && !answer.unestablished ? panePathFrom(answer.value, launch.cwd) : answer.value; continue; }
    if (probeNames(harness).includes(name)) throw oatsError("E_RUNTIME_ENDPOINT_UNKNOWN", `cannot verify the harness packages this ${harness} launch requires: ${answer.problem}. The probe runs with the ${name} the launch's pane will have, never with this process's in its place; nothing was probed. To make it readable: set ${name} in the launch configuration (env)${answer.remedy ? `, or ${answer.remedy}` : ""}`);
    delete out[name];
  }
  return out;
}
/** A name a launch may remove: one a manifest could declare (the portable grammar, no core,
 *  OATS_, PI_AGENT_ or process bootstrap name). A recorded list (instance.json) is read through it,
 *  so no other name ever reaches the window's `unset`. */
const removableLaunchEnvName = (name) => typeof name === "string" && PORTABLE_ENV_NAME_RE.test(name) && !CORE_LAUNCH_ENV.has(name) && !name.startsWith("OATS_") && !name.startsWith("PI_AGENT_")
  && !PROCESS_BOOTSTRAP_ENV.has(name) && !PROCESS_BOOTSTRAP_PREFIXES.some((reserved) => name.startsWith(reserved));
/** The environment names `capabilities` declare (each one's manifest `environment`), united and sorted. */
export const declaredLaunchEnv = (capabilities) => [...new Set((capabilities || []).flatMap((c) => Array.isArray(c?.environment) ? c.environment : []))].filter(removableLaunchEnvName).sort();
/**
 * The names a launch removes from the environment its harness starts with (awebai/oats#1123): every
 * name a provider composed into the launch declares (`declared`: declaredLaunchEnv) that neither the
 * providers' merged payload (`hooksEnv`) nor the launch configuration (`configEnv`, the operator's
 * explicit setting on the launch's own command) sets. A declared name is its provider's to decide:
 * left out of the payload (a hook that answered without it, that failed, or none), the launch has
 * none, never a value the pane would inherit (the tmux server's or session's environment, a login
 * shell's, the Desktop's). Sorted. The window command unsets them (paneCommand), and the checks of
 * the launch read them as removed (launchEnvironment `removed`).
 */
export function removedLaunchEnv({ declared = [], hooksEnv = {}, configEnv = {} } = {}) {
  return [...new Set(declared)].filter((name) => removableLaunchEnvName(name) && !Object.hasOwn(hooksEnv || {}, name) && !Object.hasOwn(configEnv || {}, name)).sort();
}
/** The names declared by the providers a home's launch composes (capturedProviders, as a start's
 *  launch hooks run them): each one's manifest in the home's module copy (`manifests`:
 *  capabilityManifests of the home), else the environment its spawn recorded (capabilityRuntime). */
export function homeDeclaredLaunchEnv(meta, frozen, manifests = {}) {
  const recorded = new Map((Array.isArray(meta?.capabilityRuntime) ? meta.capabilityRuntime : []).map((b) => [b?.id, b]));
  return declaredLaunchEnv(capturedProviders(meta, frozen).map((p) => (Object.hasOwn(manifests || {}, p.id) ? manifests[p.id] : undefined) ?? recorded.get(p.id)));
}
/** argv (after the executable) and environment names of a rendered command,
 *  from the parser: what a GUI shows, never the TASK body. */
export function describeLaunchCommand(command) {
  const { tokens, binary } = parseLaunchCommand(command);
  const environment = tokens.slice(0, binary).map((t) => t.kind === "envref" ? { name: t.name, reference: true, ...(t.source.startsWith(LAUNCH_REF_PREFIX) ? {} : { fromEnv: t.source }) } : { name: t.name, redacted: true });
  const argv = tokens.slice(binary + 1).map((t) => t.kind === "sep" ? "--" : t.kind === "prompt" ? t.text : t.value);
  return { executable: tokens[binary].value, argv, environment };
}
/** Spawn. With `o.prepared` (workspace model: a resolution prepared by
 *  instance-resolution.mjs) this is ASYNC — capabilities are fetched and copied
 *  into the home. Without it (classic soul-directory spawn: schedules, tests,
 *  bare agents roots) it stays synchronous and returns the result directly. */
/** A spawn needs a workspace deployment (lead decision c3-1): the prepared
 *  resolution is async (discovery over remotes, materialize), so the one entry
 *  point is spawnInstanceAsync with `o.prepared`. This synchronous name remains
 *  only to refuse, typed, for callers of the 0.25 kernel API. */
export function spawnInstance(root, agent, o = {}) {
  if (o.prepared) throw new Error("spawnInstance: a prepared (workspace) spawn is async — call spawnInstanceAsync");
  throw localMissingForSpawn(agent);
}
function localMissingForSpawn(agent) {
  return oatsError("E_LOCAL_MISSING", `spawning ${agent?.name ?? "an instance"} needs a workspace deployment (oats-local.yaml, found walking up from the deployment): a soul's capabilities are the workspace's resolution, prepared before the spawn — \`oats onboard\` creates the deployment`);
}
/** Which instance runs this spawn, as its inherited identity (OATS_INSTANCE, OATS_INSTANCE_HOME) says:
 *  `{ spawnOrigin, caller }`. Only consistent evidence resolving to an extant home of this deployment
 *  (an immediate child of an instances/ directory of `root`) whose readable instance.json names it
 *  counts: `spawnOrigin` "instance" and `caller` `{ instance, home }` (the canonical home); anything
 *  else is "operator" and null. A stopped home still counts. Invalid evidence must not refuse a spawn.
 *  `spawnOrigin` is informational attribution, never permission or lineage. `caller` is what
 *  callerSpawner adds liveness to, and that one is not only informational: as OATS_SPAWNER_HOME it
 *  selects who signs the new instance's identity (feature spawn-attribution). */
function callerSpawnOrigin(root) {
  const operator = { spawnOrigin: "operator", caller: null };
  const name = process.env.OATS_INSTANCE, home = process.env.OATS_INSTANCE_HOME;
  if (name === undefined && home === undefined) return operator;
  try {
    if (name !== undefined && !INSTANCE_NAME_RE.test(name)) return operator;
    if (home !== undefined && !isAbsolute(home)) return operator;
    let matches;
    if (home === undefined) {
      matches = findInstanceHomes(root, name);
      if (matches.length !== 1) return operator;
    }
    const canonical = realpathSync(home ?? matches[0].home);
    // Name lookup's immediate-child check also applies to the agents root: an
    // instances/ directory symlinked to another deployment cannot qualify it.
    if (basename(dirname(canonical)) !== "instances" || dirname(dirname(dirname(canonical))) !== realpathSync(root)) return operator;
    const record = readHomeRecord(canonical);
    if (record.state !== "record" || record.meta.instance !== basename(canonical) || (name !== undefined && record.meta.instance !== name)) return operator;
    matches ??= findInstanceHomes(root, record.meta.instance);
    return matches.some((m) => realpathSync(m.home) === canonical) ? { spawnOrigin: "instance", caller: { instance: record.meta.instance, home: canonical } } : operator;
  } catch { return operator; }
}
/** Feature spawn-attribution: `spawnedBy`, the instance whose session runs this spawn, `{ instance, home }`,
 *  or null; a kernel fact apart from lineage (parentInstance, relation). It is callerSpawnOrigin's caller
 *  unless the kernel's own liveness read (inspectInstanceSession, status's `running`) finds its session
 *  gone: not running (a fallback shell, a dead or absent pane, a home never launched), or its tmux server
 *  gone. A read that cannot tell (tmux unreadable, the session receipt unusable) keeps the spawner: as far
 *  as anyone knows that instance runs this command, and reading it as a person's spawn would have the
 *  deployment agent sign the child. Never a refusal. So spawnedBy non-null implies spawnOrigin "instance",
 *  and "instance" with null means the session was found gone. It reads the environment only: a harness
 *  that strips its session's environment reads as a person's spawn. */
function callerSpawner(caller, io) {
  if (!caller) return null;
  try { return inspectInstanceSession(caller.home, { io }).running === false ? null : caller; }
  catch (e) {
    // inspectInstanceSession keeps the tmux failure as the cause of E_SESSION_UNAVAILABLE.
    return e?.code === "E_SESSION_UNAVAILABLE" && e.cause && sessionServerGone(caller.home, e.cause, io).gone ? null : caller;
  }
}
/** A soul name as a spawn names it, by shape only: a slug, after an optional `<package or member>/`
 *  and an optional `<package>--` (lib/instance-naming.mjs soulRole reads its role from the same). */
const SOUL_NAME_SHAPE = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*\/)?(?:[a-z0-9]+(?:-[a-z0-9]+)*--)?[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** `oats instance suggest-name` (feature instance-suggest-name, awebai/oats#1490 §2): the name a spawn
 *  of `soul` would get by `--suggest-name`, chosen on THIS machine for a spawn that may land on another.
 *  `soul` is only a name (it gives the role) and needn't exist here: nothing resolves it. It resolves no
 *  souls, members, lock or remote: it reads only this machine's launch configurations (the
 *  oats-local.yaml in reach of `dir`) and the OATS tmux server's environment, writes nothing and
 *  reserves no name. The name is not made unique: the host the spawn lands on owns uniqueness
 *  (E_INSTANCE_NAME_TAKEN at its apply). The harness: `harness`, else the configuration's, else claude;
 *  its executable and environment are what a spawn here would launch it with (`launchConfig`, else this
 *  machine's default configuration for the harness), and the call is the preview's (lib/instance-
 *  naming.mjs: its argv, isolation and bounds), the only process it starts. The model: `model`, else the
 *  configuration's (`@native-default` for none; a list's first entry, with no catalogue probe). → Promise
 *  of `{ name?, naming }`, `name` only when `naming.source` is "suggested". A naming failure is never an
 *  error (an executable that is not there is `harness-failed`); bad arguments are. */
export async function suggestSpawnName({ dir = process.cwd(), soul, task, harness: asked, model: askedModel, launchConfig: named } = {}) {
  if (typeof soul !== "string" || soul.length > 256 || !SOUL_NAME_SHAPE.test(soul)) throw oatsError("E_BAD_ARGS", `--soul ${JSON.stringify(soul)} is not a soul name (a slug, optionally qualified as <package>/<soul>)`);
  if (typeof task !== "string") throw oatsError("E_BAD_ARGS", "the task must be text");
  if (asked !== undefined && !LAUNCH_HARNESSES.includes(asked)) throw oatsError("E_BAD_ARGS", `--harness must be one of ${LAUNCH_HARNESSES.join("|")}`);
  if (askedModel !== undefined && (typeof askedModel !== "string" || !askedModel)) throw oatsError("E_BAD_ARGS", "--model needs a model id");
  let deployment = null;
  try { deployment = dirname(loadLocal(dir).path); } catch (e) { if (e?.code !== "E_LOCAL_MISSING") throw e; }
  const configs = launchConfigsAt(deployment ?? dir);
  let config = null;
  if (named !== undefined && named !== "none") {
    if (typeof named !== "string" || !Object.hasOwn(configs, named)) throw launchConfigUnknown({ name: named, from: "flag", at: "--launch-config" });
    config = configs[named];
    if (asked !== undefined && asked !== config.harness) throw oatsError("E_BAD_ARGS", `launch configuration ${named} runs ${config.harness}, not ${asked}: a named configuration is a unit; drop --harness or name another configuration`);
  }
  const harness = asked ?? config?.harness ?? "claude";
  if (named === undefined) config = harnessDefaultConfig(configs, harness);
  // Where a spawn here would look: the configuration's env, else the OATS tmux server's when one runs
  // (never started for this), else this process's; relative PATH entries from this process's directory.
  const launchEnv = launchEnvironment({ configEnv: config?.env, configName: config?.name, env: process.env, pane: () => previewPaneEnvironment({ deployment: deployment ?? dir }), cwd: process.cwd() });
  let bin = null, problem = null;
  const missing = missingLaunchEnvRefs(config?.env || {}, process.env);
  if (missing.length) problem = `launch configuration ${config.name} references ${missing.join(", ")}, not set in this environment`;
  else {
    try {
      const executable = resolveLaunchExecutable({ harness, declared: config?.executable, declaringDir: config?.source, contextDir: deployment ?? undefined, lookup: config?.executable?.includes("/") ? undefined : launchLookup(launchEnv) });
      if (!executable.path) problem = config?.executable ? `launch configuration ${config.name}: ${executable.missing}` : `${harness} is not installed on this machine (${executable.missing})`;
      else {
        const bad = checkLaunchExecutable(executable.path);
        if (bad) problem = config ? `launch configuration ${config.name}: ${bad}` : bad; else bin = executable.path;
      }
    } catch (e) { if (!isKernelCode(e?.code)) throw e; problem = e.message; }
  }
  // The model, read as a spawn reads it (resolveLaunchSelection) but with no catalogue probe: the naming
  // call is the only process this command starts. `@native-default` is none; a pi preference list names
  // its first entry (pi answers one it cannot use as harness-failed); another harness's list is
  // resolveModelPreference's, which starts nothing for it.
  const preference = askedModel ?? (typeof config?.model === "string" && config.model ? config.model : undefined);
  const firstEntry = (list) => list.split(",").map((m) => m.trim()).find(Boolean) ?? "";
  const namingModel = preference === undefined || preference === NATIVE_DEFAULT_MODEL ? null : (harness === "pi" ? firstEntry(preference) : resolveModelPreference(preference, harness)) || null;
  const seam = Number(process.env.OATS_TEST_NAMING_TIMEOUT_MS);
  const call = {
    soulName: soul, harness, bin, task, timeoutMs: seam > 0 ? seam : NAMING_TIMEOUT_MS,
    instanceModel: namingModel,
    env: () => launchEffectiveEnv({ base: process.env, configEnv: config?.env || {}, launch: launchEnv, harness }),
    taken: () => false,
  };
  // The call's own answers come first (no task, a harness with no naming call); then no executable.
  if (problem && task.trim() && Object.hasOwn(NAMING_CALLS, harness)) return { naming: { source: "numbered", reason: "harness-failed", message: `${harness} could not be run: ${problem}`, ms: 0 } };
  return suggestInstanceName(call);
}
export async function spawnInstanceAsync(root, agent, o = {}) {
  const it = spawnBody(root, agent, o);
  let step = it.next();
  while (!step.done) {
    // The single yield hands back a promise-producing thunk; await it and feed the
    // result (or throw the failure) back into the body.
    try { const value = await step.value(); step = it.next(value); }
    catch (e) { step = it.throw(e); }
  }
  return step.value;
}
/** The producer sets this only when dispatched effects or their compensation
 * cannot be confirmed. A diagnostic's wording or home path is not evidence. */
function unconfirmedSpawn(error) {
  error.details = { ...error.details, unconfirmed: true };
  return error;
}
function* spawnBody(root, agent, o = {}) {
  // Capture the caller before target scaffolding or hooks supply the new instance's identity.
  const { spawnOrigin, caller } = callerSpawnOrigin(root), spawnedBy = callerSpawner(caller, o.io);
  if (!o.prepared) throw localMissingForSpawn(agent);
  const deliver = (r) => r;
  const work = o.work || agent.work || "checkout";
  if (!WORK_MODES.includes(work)) throw new Error(`unknown work mode "${work}" (${WORK_MODES.join("|")})`);
  if (work === "directory" && (o.workDir !== undefined || o.branch !== undefined)) {
    throw oatsError("E_BAD_ARGS", "directory mode owns only <home>/work; workDir/--work-dir and branch/--branch are not allowed");
  }
  if (work === "attached" && !o.workDir) throw new Error(`attached mode needs workDir — the owning instance's work tree (its <home>/work)`);
  if (o.task !== undefined && typeof o.task !== "string") throw new Error(`task must be a string (got ${typeof o.task}) — a flag parser handing --task's next flag through shows up here`);
  if (o.launchConfig !== undefined && (typeof o.launchConfig !== "string" || !o.launchConfig.trim())) throw oatsError("E_BAD_ARGS", "launchConfig must be a configuration name or none");
  const { tmuxSession: session } = sessionDefaults(root, { tmuxSession: o.tmuxSession });
  const backend = o.backend || "tmux";
  if (backend === "herdr") throw herdrSettingRemoved("backend herdr was given");
  if (o.herdrSocket !== undefined) throw herdrSettingRemoved("herdrSocket was given");
  if (backend !== "tmux") throw new Error(`unknown session backend "${backend}" (tmux)`);
  const launch = o.launch !== false;
  // Workspace model (`o.prepared`) + work: workspace: ./work is the deployment
  // boundary — the directory holding oats-local.yaml (`prepared.deployment`), which
  // is a plain directory with member clones beside it, not a Git checkout. It is
  // the execution/config context too; no Git identity is required or recorded.
  const preparedDeployment = work === "workspace" && typeof o.prepared.deployment === "string" && o.prepared.deployment ? resolve(o.prepared.deployment) : undefined;
  if (preparedDeployment !== undefined && !(existsSync(preparedDeployment) && statSync(preparedDeployment).isDirectory())) throw oatsError("E_BAD_ARGS", `workspace mode: the deployment directory ${preparedDeployment} (where oats-local.yaml lives) is not a directory`);
  // A soul declares no repository (lead decision c3 Q6): the caller passes one, and an
  // attached instance's repository is the repository of the tree it is attached to
  // (attachedTreeOf, read once here: its owner is taken from the same read, below).
  const attachedTree = work === "attached" ? attachedTreeOf(root, o.workDir) : undefined;
  const repoTarget = o.repo !== undefined ? o.repo : attachedTree?.repo;
  const repoAbs = preparedDeployment ?? resolveExecutionContext(root, repoTarget, work);
  if (!repoAbs) {
    // A tree of no known instance: the owner is not derived either, so a caller that named none
    // is told both at once (awebai/oats#958).
    if (work === "attached" && !attachedTree.owner) {
      const childOf = (typeof o.parent === "string" && o.parent.trim()) || (typeof o.relation === "string" && o.relation.trim() === "child" && typeof o.relativeTo === "string" && o.relativeTo.trim());
      throw oatsError("E_BAD_ARGS", attachedTreeOfNoInstance(typeof o.workDir === "string" ? resolve(o.workDir) : o.workDir, { parent: !childOf, repo: true }));
    }
    throw oatsError("E_BAD_ARGS", `${agent.name}: no repository for a ${work} instance — pass --repo${work === "attached" ? " (the work tree's owner records none)" : ""}`);
  }
  // Launch selection: a named configuration (explicit, or the soul's
  // launch-config default), or none; the harness and model follow from it.
  // K6b: a preview's native probes (model catalogue, harness packages) share
  // ONE budget from here to the return; each probe is group-killed on timeout.
  const preflightStarted = Date.now(), preflightBudgetMs = o.preview === true ? (Number(process.env.OATS_PREVIEW_PREFLIGHT_BUDGET_MS) || 20000) : undefined;
  let preflight = { status: "complete", budgetMs: preflightBudgetMs ?? null };
  if (o.preview === true) previewPreflightBudget = { deadline: preflightStarted + preflightBudgetMs };
  // Feature launch-preference: the flags, else the machine's souls.launch, else the soul's own launch,
  // else the host default — `launchChoice` says which layer decided (instance.json launchFrom/launchAt).
  let launchSelection, launchChoice;
  try { ({ launchSelection, launchChoice } = selectNewLaunch({ launchConfigs: launchConfigsAt(root), agent, flags: { launchConfig: o.launchConfig, harness: o.harness, model: o.model }, layers: o.prepared.launch, refuseAmbiguous: true })); }
  catch (e) { previewPreflightBudget = null; throw e; }
  const launchConfig = launchSelection.config;
  const harness = launchSelection.harness;
  const model = launchSelection.model;
  // Instance homes belong in the soul-owning repo's PRIMARY checkout, never in a
  // linked worktree (see canonicalDeploymentPath). The CLI resolves this through
  // ensureRoot, but the kernel is its own validation boundary — the desktop
  // server, the pi adapter and tests call spawnInstance directly — and the check
  // must run in the RAW caller shape, before mkdir or any lifecycle hook.
  //
  // BOTH paths are checked, because the home is `agent._dir/instances/<name>`,
  // NOT `root/...`: a caller can pass a canonical root together with an agent
  // resolved from the linked root (findAgent(linkedRoot, name)) and the home
  // would still land in the worktree with a root-only check (reviewer-2366d09).
  // A capability-defined agent's dir (<root>/<name>/, instances/ only) is
  // agent._dir too, so agent._dir is the authority in every case.
  for (const [label, path] of [["agents root", root], [`agent directory for "${agent.name}"`, agent._dir]]) {
    if (!path) continue;
    const canonical = canonicalDeploymentPath(path);
    if (resolve(canonical) !== resolve(path)) {
      throw oatsError("E_NO_CANONICAL_ROOT", `${label} ${resolve(path)} is inside a linked Git worktree — instance homes must be created in the primary checkout (${canonical}), where they survive the worktree and are visible to the deployment`);
    }
  }

  // --suggest-name (features spawn-suggest-name, spawn-apply-suggest-name: awebai/oats#1421 §3,
  // #1490 §3): a spawn that also chooses the name, by a naming call through this launch's harness and
  // executable, under its environment, after the preflight's probes (below, where the executable is
  // known): a preview's within its one budget, an apply's within NAMING_TIMEOUT_MS. Until then the
  // spawn proceeds with the numbered name, holding any refusal that is that name's own
  // (`provisional`); a suggested name is then placed exactly as `--name <suggested>` is, so a
  // preview's instance, home, branch and decision are that preview's, and an apply with `--name
  // <instance> --expect-decision <revision>` matches it. Otherwise the numbered name stands, its held
  // refusal with it. `naming` says which, and why; a failed call is never an error.
  let naming, provisional;
  const suggesting = o.suggestName === true;
  if (suggesting && (o.name !== undefined || o.purpose !== undefined || o.instance !== undefined || o.expectDecision !== undefined)) {
    throw oatsError("E_BAD_ARGS", o.expectDecision !== undefined ? "--suggest-name chooses the name, and --expect-decision's decision already binds one: apply the previewed name with --name <instance> --expect-decision <revision>" : "--suggest-name chooses the name: it takes no --name or --purpose");
  }
  if (o.name !== undefined && (o.purpose !== undefined || o.instance !== undefined)) throw oatsError("E_BAD_ARGS", "name and purpose are mutually exclusive: --name is the exact instance name, --purpose derives <soul>-<purpose>");
  let instance;
  if (o.name !== undefined) instance = explicitInstanceName(o.name);
  else {
    instance = o.instance || nextInstanceName(root, agent, o.purpose, o.prepared);
    if (!instance.startsWith(agent.name) && !instance.startsWith(slug(agent.name))) instance = `${agent.name}-${slug(instance)}`;
    instance = slug(instance);
    if (instance.length > MAX_INSTANCE_NAME) throw nameTooLong(instance, "pass a shorter instance name");
  }

  // K6e: key recovery FIRST — before any placement, branch, base, preflight or
  // backend work — so a retry of a spawn that already created its explicit
  // branch (or whose base moved) still reaches its own receipt.
  if (o.idempotencyKey !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(o.idempotencyKey))) throw oatsError("E_BAD_ARGS", "--idempotency-key must be 1-128 chars of [A-Za-z0-9._:-]");
  if (o.expectDecision !== undefined && o.idempotencyKey !== undefined) {
    const instancesDir = join(agent._dir, "instances");
    const prior = (existsSync(instancesDir) ? readdirSync(instancesDir) : []).filter((n) => !n.startsWith("."))
      .map((n) => { try { return JSON.parse(readFileSync(join(instancesDir, n, "instance.json"), "utf8")); } catch { return null; } })
      .find((m) => m && m.spawnIdempotencyKey === o.idempotencyKey);
    if (prior) {
      if (prior.decision?.revision !== o.expectDecision) throw Object.assign(oatsError("E_IDEMPOTENCY_CONFLICT", `idempotency key ${o.idempotencyKey} was used for a different decision (${prior.decision?.revision ?? "unrecorded"}); a key binds one confirmed decision`), { instance: prior.instance, home: prior.home });
      // Completion custody: the home exists from the first metadata write, but
      // the launch/lineage/events that make it a finished spawn may not have
      // happened (crash in the interval). Say which, never replay a half-spawn.
      if (["blocked", "incomplete"].includes(prior.launchPrompts?.status)) throw retainedPromptError(prior.home, prior.instance, prior.launchPromptTarget ?? prior.tmux, prior.parentLineageCommitted === true, prior.launchPrompts);
      if (prior.spawnCompleted !== true) throw unconfirmedSpawn(Object.assign(oatsError("E_SPAWN_INCOMPLETE", `${prior.instance} was created for this key but its spawn did not complete (launch or lineage unfinished); inspect it with oats session inspect --home ${prior.home} — do not spawn again`), { instance: prior.instance, home: prior.home, launched: prior.launched === true ? "unknown" : false }));
      // The receipt's warnings that are facts of the composition (a hook event this kernel ignores),
      // from the home's module copies: nothing runs again, and the captured composition is unchanged.
      return { ...prior, background: readInstanceBackground(prior.home), replayed: true, launch: undefined, command: undefined, wake: prior.wake ?? { requested: null, saved: null, error: null }, warnings: replayedContractWarnings(prior.home) };
    }
  }

  // An explicit name may not be a soul name (soul and instance references stay
  // unambiguous) and is taken when any soul of this deployment holds it, or — launched
  // or not — a live window of the session on the OATS tmux server carries it (an early read that
  // creates no server; the launch below checks again on the socket it resolved):
  // a typed refusal, never a silent `-2` (the operator typed it). Checked after
  // key recovery, so a retried keyed spawn still reaches its own receipt; the
  // placement below re-checks after its reservation (a concurrent spawn of
  // another soul under the same name).
  if (o.name !== undefined) {
    if (deploymentSoulNames(root, o.prepared).has(instance)) throw oatsError("E_INSTANCE_NAME_INVALID", `instance name "${instance}" is a soul name in this deployment; an instance may not share a soul's name`);
    const holder = deploymentInstanceHomes(root).get(instance)?.[0];
    if (holder) throw Object.assign(oatsError("E_INSTANCE_NAME_TAKEN", `instance name "${instance}" is taken in this deployment (${holder}); instance names are unique across every soul — pick another --name`), { instance, home: holder });
    if (oatsTmuxWindows(session).includes(instance)) throw Object.assign(oatsError("E_INSTANCE_NAME_TAKEN", `instance name "${instance}" is taken: a live tmux window of that name exists in session ${session} — pick another --name`), { instance, session });
  }
  // A caller that will have to create the tmux session reads the environment for it here, before
  // any scaffold, work tree, identity or hook, so that an instance that cannot is refused with
  // nothing left behind; the harness is first looked up on the PATH this plan expects (below). A
  // preview reads only what exists.
  const tmuxSessionPlan = launch ? planOatsTmuxSession(session, undefined, { preview: o.preview === true }) : undefined;

  // Forward-only lineage: EXPLICIT only. Relations (child|sibling|parent|unrelated)
  // anchor the new instance to an EXISTING instance (o.relativeTo). o.parent
  // (CLI --parent) is sugar for relation=child. Parsed and resolved BEFORE any
  // scaffolding or lifecycle hooks so an invalid relation or missing anchor
  // never leaves a half-created home behind. ATTACHED mode is special by design
  // decision: an attached agent shares its owner's work tree and is ALWAYS the
  // owner's child — relation flags that say anything else are contradictory and
  // rejected. Caller identity is attribution only: it never supplies a lineage
  // edge. Without an explicit relation a spawn stays top-level.
  const legacyParent = typeof o.parent === "string" && o.parent.trim() ? o.parent.trim() : undefined;
  let relation = typeof o.relation === "string" && o.relation.trim() ? o.relation.trim() : undefined;
  let relativeTo = typeof o.relativeTo === "string" && o.relativeTo.trim() ? o.relativeTo.trim() : undefined;
  // Validate the RAW combination BEFORE normalization — the kernel is its own
  // validation boundary (programmatic callers bypass the CLI's checks), and
  // silently normalizing contradictory options into a different spawn shape
  // (e.g. dropping a dangling relativeTo → top-level) hides caller bugs.
  if (relation && !RELATIONS.includes(relation)) throw new Error(`unknown relation "${relation}" (child|sibling|parent|unrelated)`);
  if (legacyParent && (relation || relativeTo)) throw new Error(`parent is sugar for relativeTo + relation "child" — pass one form, not both`);
  if (relativeTo && !relation) throw new Error(`relativeTo "${relativeTo}" needs a relation (child|sibling|parent)`);
  if (relation === "unrelated" && relativeTo) throw new Error(`relation "unrelated" takes no relativeTo`);
  if (relation && relation !== "unrelated" && !relativeTo) throw new Error(`relation "${relation}" needs a relative-to instance`);
  if (typeof o.relativeRoot === "string" && o.relativeRoot.trim() && !relativeTo && !legacyParent) throw new Error(`relativeRoot only qualifies relativeTo/parent`);
  if (o.sameWork !== undefined && typeof o.sameWork !== "boolean") throw oatsError("E_BAD_ARGS", "sameWork must be true or false");
  if (!relation && legacyParent) { relation = "child"; relativeTo = legacyParent; }
  if (relation === "unrelated") { relation = undefined; relativeTo = undefined; }

  // Attached = child of the work-tree owner, always (design decision). The
  // owner is CANONICALLY resolved BY PATH (attachedTreeOf, read above with the
  // repository): the instance in whose home the tree is, as that home's work
  // or as one of its extra trees — never by name, since
  // instance names are only unique per agent dir and a same-named local
  // instance must not shadow the tree's true owner. For trees that are in no
  // instance's home (e.g. a coordinator's integration worktree), the
  // spawner must name the owner explicitly with a child relation — nothing
  // else can attach there.
  let attachedOwner;
  if (work === "attached" && o.workDir) {
    const wd = resolve(o.workDir);
    let ownerName;
    const owner = attachedTree.owner;
    if (owner) {
      ownerName = owner.name;
      // The owner must be representable unambiguously from the CHILD's root:
      // the recorded name, resolved like every other lineage edge, must land
      // back on the matched home.
      const check = findInstanceHome(root, ownerName);
      let resolvesBack = false;
      try { resolvesBack = !!check && realpathSync(check.home) === realpathSync(owner.home); } catch { /* not resolvable */ }
      if (!resolvesBack) throw new Error(`attached workDir ${wd} belongs to instance "${ownerName}" (${owner.home}), but that name resolves to a different instance from this deployment root — the parent link would be ambiguous; retire/rename the shadowing instance or attach to a tree owned here`);
    }
    if (ownerName) {
      attachedOwner = ownerName;
      if (relation && !(relation === "child" && relativeTo === attachedOwner)) {
        throw new Error(`attached agents are always children of the work-tree owner (${attachedOwner}) — drop the relation flags or use --work worktree for a different relation`);
      }
    } else {
      // The tree is in NO known instance's home: require an explicit,
      // validated child link so the "attached = child" invariant still holds.
      if (!relation) throw oatsError("E_BAD_ARGS", attachedTreeOfNoInstance(wd, { parent: true, repo: false }));
      if (relation !== "child") throw new Error(`attached agents are always children — only --parent <instance> (child) is valid for a non-instance work tree`);
      attachedOwner = relativeTo;
    }
    if (o.relation === "unrelated") throw new Error(`attached agents are always children of the work-tree owner — "unrelated" contradicts attached mode`);
  }

  // Resolve the anchor's home so sibling and parent relations can read/re-point
  // the anchor's recorded lineage. Bare names are only unique per agent dir, so
  // resolution must be AMBIGUITY-SAFE (same posture as attached ownership):
  //  - enumerate ALL matches under the deployment's agents root;
  //  - multiple matches need o.relativeRoot (CLI --relative-root) to pick one;
  //  - the recorded edge must ROUND-TRIP: the anchor's bare name, resolved from
  //    the NEW instance's root (local-first, like every lineage consumer),
  //    must land on the chosen home — else a same-named shadow would corrupt
  //    lineage. For relation=parent the reverse edge (anchor → new instance,
  //    by the new instance's bare name from the ANCHOR's root) must round-trip
  //    too, since the anchor's instance.json is re-pointed.
  let anchorHome;
  let anchorRoot;
  let reverseShadow = () => null;
  if (relativeTo) {
    const hits = [];
    for (const h of findInstanceHomes(root, relativeTo)) hits.push({ root, home: h.home });
    if (relation && !hits.length) throw new Error(`relation "${relation}": instance "${relativeTo}" was not found in this deployment`);
    let chosen = hits[0];
    if (hits.length > 1) {
      const wanted = typeof o.relativeRoot === "string" && o.relativeRoot.trim() ? resolve(o.relativeRoot.trim()) : undefined;
      const inRoot = wanted ? hits.filter((h) => resolve(h.root) === wanted) : [];
      // Two agents under ONE root can own the same name (generated-name
      // collisions); --relative-root cannot split those — inherently ambiguous.
      if (inRoot.length > 1) throw Object.assign(
        new Error(`relative-to "${relativeTo}" matches multiple instances under ${o.relativeRoot} (${inRoot.map((h) => h.home).join(", ")}) — inherently ambiguous; retire/rename one`),
        { code: "E_RELATIVE_AMBIGUOUS" });
      chosen = inRoot[0];
      if (!chosen) throw Object.assign(
        new Error(`relative-to "${relativeTo}" is ambiguous — it matches multiple instances (${hits.map((h) => h.home).join(", ")}); pass --relative-root <agents-root> to pick one`),
        { code: "E_RELATIVE_AMBIGUOUS" });
    } else if (chosen && typeof o.relativeRoot === "string" && o.relativeRoot.trim() && resolve(o.relativeRoot.trim()) !== resolve(chosen.root)) {
      throw Object.assign(new Error(`relative-to "${relativeTo}" does not home under --relative-root ${o.relativeRoot} (found at ${chosen.home})`), { code: "E_RELATIVE_AMBIGUOUS" });
    }
    if (chosen) {
      // Round-trip: the bare name recorded on the edge must resolve back to the
      // chosen home from the NEW instance's root, or the edge is a lie.
      const back = findInstanceHome(root, relativeTo);
      let ok = false;
      try { ok = !!back && realpathSync(back.home) === realpathSync(chosen.home); } catch { ok = false; }
      if (!ok) throw Object.assign(
        new Error(`relative-to "${relativeTo}" at ${chosen.home} is shadowed by a same-named instance closer to this deployment root — the lineage edge would resolve to the wrong instance; retire/rename the shadowing instance`),
        { code: "E_RELATIVE_AMBIGUOUS" });
      anchorHome = chosen.home;
      anchorRoot = chosen.root;
      // relation=parent re-points the ANCHOR at the NEW instance by bare name:
      // that reverse edge must round-trip from the ANCHOR's root as well.
      if (relation === "parent") {
        // The new instance does not exist yet — a hit here IS a shadow.
        reverseShadow = (name) => {
          const rev = findInstanceHome(chosen.root, name);
          return rev ? Object.assign(
            new Error(`relation "parent": an existing instance named "${name}" (${rev.home}) would shadow the new instance from the anchor's root — the re-pointed edge would resolve to the wrong instance; pick a different --purpose or --name`),
            { code: "E_RELATIVE_AMBIGUOUS" }) : null;
        };
        const shadow = reverseShadow(instance);
        if (shadow && !suggesting) throw shadow;
        provisional ??= shadow ?? undefined;
      }
    }
  }
  // The anchor's record gives the lineage, and a parent's its child-spawn policy: one that is there
  // and cannot be read refuses the spawn, which would otherwise guess either (#896).
  if (anchorHome) identifiedHomeRecord(anchorHome, "nothing was spawned");
  const anchorMetaPath = anchorHome ? join(anchorHome, "instance.json") : undefined;
  const anchorOriginal = anchorMetaPath && existsSync(anchorMetaPath) ? readFileSync(anchorMetaPath, "utf8") : null;
  const anchorMeta = anchorOriginal === null ? undefined : JSON.parse(anchorOriginal);
  if ((relation === "sibling" || relation === "parent") && !anchorMeta) {
    throw new Error(`relation "${relation}" needs the anchor's recorded lineage, but instance "${relativeTo}" has no instance.json`);
  }

  let parentInstance;
  let siblingInstance;
  if (relation === "child") {
    parentInstance = relativeTo;
  } else if (relation === "sibling") {
    // Peer at the same level: share the anchor's parent. When the anchor is a
    // root (no parent), record an explicit sibling link so the two still form
    // one cluster (derivable from status --json via parentInstance+siblingInstance edges).
    if (anchorMeta?.parentInstance) parentInstance = anchorMeta.parentInstance;
    else siblingInstance = relativeTo;
  } else if (relation === "parent") {
    // The NEW instance becomes the anchor's parent: it inherits the anchor's old
    // slot in the tree (old parent, if any), and the anchor is re-pointed below.
    parentInstance = anchorMeta?.parentInstance;
    if (anchorMeta?.siblingInstance) siblingInstance = anchorMeta.siblingInstance;
  }
  if (!relation && attachedOwner && attachedOwner !== instance) parentInstance = attachedOwner;
  // Feature instance-same-work: the flag binds the parent the new home records, whichever relation gave
  // it (child, a sibling of a non-root, --relation parent under a parented anchor, attached). None: refused
  // here, before any home, worktree or hook, a preview's included.
  if (o.sameWork === true && !(parentInstance && parentInstance !== instance)) {
    throw oatsError("E_BAD_ARGS", `--same-work needs a parent: ${instance} would record no parent instance${relation ? ` (relation ${relation}${relativeTo ? ` to ${relativeTo}` : ""})` : ""}; spawn it with --parent <instance>, or without --same-work; nothing was spawned`);
  }
  // K5 §4 — child-spawn permission is ENFORCED here, by the spawn route. The
  // parent's recorded policy (instance.json policy.childSpawns) says whether
  // it may have children; off refuses, attributed to that policy and its
  // origin. Absent policy = allowed (today's behaviour), reported as such.
  // A lifecycle-authority claim, not an OS sandbox.
  const childPolicyOf = (metaOf) => metaOf?.policy?.childSpawns && typeof metaOf.policy.childSpawns === "object"
    ? metaOf.policy.childSpawns : { allowed: true, origin: { kind: "default", detail: "no recorded policy: children allowed" } };
  if (parentInstance && parentInstance !== instance) {
    const parentHome = parentInstance === relativeTo && anchorHome ? anchorHome
      : findInstanceHome(root, parentInstance)?.home;
    const parentRecord = parentHome ? identifiedHomeRecord(parentHome, "nothing was spawned") : undefined;
    const parentMeta = parentRecord?.state === "record" ? parentRecord.meta : anchorMeta;
    const policy = childPolicyOf(parentMeta);
    if (policy.allowed === false) {
      // A preview touches nothing — not even the parent's event log; the
      // typed refusal IS the preview's answer.
      if (parentHome && o.preview !== true) appendEvent(parentHome, { kind: "child-spawn-refused", data: { child: instance, agent: agent.name, policy } });
      throw Object.assign(oatsError("E_CHILD_SPAWNS_DISABLED", `${parentInstance} does not allow child spawns (policy origin: ${policy.origin?.kind ?? "recorded"}${policy.origin?.detail ? ` — ${policy.origin.detail}` : ""}); nothing was spawned. Spawn without a parent relation, or respawn the parent with --allow-child-spawns.`),
        { parent: parentInstance, policy });
    }
  }
  // This instance's own policy: a spawn option (a soul declares none — lead
  // decision c3 Q6), recorded so the route above and the readiness view can read it.
  const ownChildPolicy = o.allowChildSpawns !== undefined
    ? { allowed: o.allowChildSpawns === true, origin: { kind: "spawn-option", detail: o.allowChildSpawns ? "--allow-child-spawns" : "--no-child-spawns" } }
    : { allowed: true, origin: { kind: "default", detail: "no spawn option: children allowed" } };

  // Inherited edges must round-trip too. Sibling and parent relations copy
  // names from the ANCHOR's instance.json (anchorMeta.parentInstance /
  // .siblingInstance) — names the ANCHOR resolved from ITS root. The NEW
  // instance's root may resolve the same bare name to a different (same-named)
  // instance, silently mislinking. Before scaffolding: resolve each final
  // inherited name from the anchor's root AND from the new root; both must
  // canonicalize to the same home.
  if (relation === "sibling" || relation === "parent") {
    for (const inherited of [parentInstance, siblingInstance]) {
      if (!inherited || inherited === relativeTo || inherited === instance) continue;
      const fromAnchor = findInstanceHome(anchorRoot, inherited);
      const fromNew = findInstanceHome(root, inherited);
      let same = false;
      try { same = !!fromAnchor && !!fromNew && realpathSync(fromAnchor.home) === realpathSync(fromNew.home); } catch { same = false; }
      // A vanished referent (no hit from the anchor root) is a dangling edge —
      // inheriting it is harmless only if the new root ALSO cannot resolve it.
      if (!fromAnchor && !fromNew) continue;
      if (!same) throw Object.assign(
        new Error(`relation "${relation}": inherited lineage "${inherited}" resolves to ${fromAnchor?.home || "nothing"} from the anchor's root but ${fromNew?.home || "nothing"} from this deployment root — the inherited edge would mislink; disambiguate or retire/rename the shadowing instance`),
        { code: "E_RELATIVE_AMBIGUOUS" });
    }
  }

  // The home and its placement checks, for a name: the numbered one here, a suggested one again below.
  const place = (name) => {
    const home = join(agent._dir, "instances", name);
    // A home that exists already is the same refusal as losing the exclusive mkdir below (a
    // concurrent apply that got there first, or anything else): E_PLACEMENT_TAKEN, nothing created.
    if (existsSync(home)) throw Object.assign(oatsError("E_PLACEMENT_TAKEN", `${name} already exists at ${home}; nothing was created by this call`), { instance: name, home });
    // AUTHORITATIVE placement check, on the DESTINATION rather than on lexical
    // paths, immediately before the first side effect. The earlier root/agent-dir
    // checks are lexical and can be walked around by a symlink anywhere along the
    // way — `agents/alias -> <linked-worktree>/agents/dev`, or a pre-existing
    // `agent._dir/instances` symlink — which classifies as the primary checkout
    // while the home is really created in the worktree (reviewer-249aa7b).
    // Resolving through the nearest existing ancestor is what closes that.
    const homeReal = realPathOrNearest(home);
    const homeCanonical = canonicalDeploymentPath(homeReal);
    if (resolve(homeCanonical) !== resolve(homeReal)) {
      throw oatsError("E_NO_CANONICAL_ROOT", `instance home ${home} resolves to ${homeReal}, inside a linked Git worktree — homes must be created in the primary checkout (${homeCanonical}); a symlink on the path to the agent directory or its instances/ dir does not change where the home really lands`);
    }
    // CONTAINMENT, which the check above does not give. canonicalDeploymentPath
    // only redirects paths inside a LINKED WORKTREE; an escape to a directory Git
    // does not own at all comes back unchanged and passed (reviewer-aggregate2 —
    // reproduced: a pre-existing `instances/` symlink to a sibling temp dir spawned
    // successfully, reporting a home under the deployment while the real one, with
    // the capability credentials a hook writes into it, was created outside).
    // The home must BE the immediate `instances/` child of the resolved agent
    // directory, and that directory must live in this deployment.
    const withinDir = (child, parent) => {
      const rel = relative(parent, child);
      return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
    };
    const agentDirReal = realPathOrNearest(agent._dir);
    // The only base is the agents root: souls and capability-defined agents alike
    // live directly under it (the 0.25 local-agents/ bases are gone). The root itself
    // may legitimately be a symlink (it is the deployment anchor, and OATS is pointed
    // AT it); the agent dirs OATS derives from it may not lead somewhere else.
    const allowedBases = [realPathOrNearest(root)];
    if (!allowedBases.some((b) => withinDir(agentDirReal, b))) {
      throw oatsError("E_NO_CANONICAL_ROOT", `agent directory for "${agent.name}" resolves to ${agentDirReal}, which is outside this deployment (${allowedBases.join(", ")}) — a symlinked agent directory would place the home, and any capability credentials written into it, outside the deployment entirely`);
    }
    const expectedHome = join(agentDirReal, "instances", name);
    if (resolve(homeReal) !== resolve(expectedHome)) {
      throw oatsError("E_NO_CANONICAL_ROOT", `instance home ${home} resolves to ${homeReal}, not to ${expectedHome} — a symlinked instances/ directory does not change where the home really lands, and OATS will not create an instance (or the capability credentials that go in it) outside the agent's own directory`);
    }
    return { home, homeReal, expectedHome };
  };
  let home, homeReal, expectedHome;
  try { ({ home, homeReal, expectedHome } = place(instance)); }
  catch (e) { if (!suggesting) throw e; provisional ??= e; home = join(agent._dir, "instances", instance); }
  // Compose and PREFLIGHT before the home exists. Composition is pure (it only
  // reads the soul, config chain and capability content), so resolving it here
  // lets every "declared but missing" failure happen with zero side effects to
  // roll back — no home, no worktree, no identity, no tmux window.
  // A workspace soul carries _soulDir (its per-commit soul cache: findAgentAt).
  const soulDir = agent._soulDir || soulOf(agent._dir);
  const composition = composeInstanceAgentsMd(soulDir, repoAbs, agent.name, work, agent.kind, o.prepared);
  const resolvedCfg = composition.resolved;
  const yolo = resolveYolo(o.yolo ?? launchSelection.configuredYolo);
  // Feature instance-background (#1579): the flag, else the soul's `background:`, else not background.
  // `backgroundFrom` names the layer that declared it, and is absent when neither did.
  if (o.background !== undefined && typeof o.background !== "boolean") throw oatsError("E_BAD_ARGS", "background must be true or false");
  const soulBackground = o.prepared?.soulEntry?.definition?.background;
  const backgroundFrom = o.background !== undefined ? "flag" : typeof soulBackground === "boolean" ? "soul" : null;
  const background = o.background ?? soulBackground === true;
  const expectedResources = planInstanceResources({ resolved: resolvedCfg, soulDir, agent, contextDir: repoAbs, composition, prepared: o.prepared });
  // Harness extensions selected by ACTIVE capabilities for THIS instance's
  // harness. Strict launch disables ambient extension discovery, so each one has
  // to be named by path — and a required harness package that is not installed
  // must fail here, loudly, rather than produce an instance that silently lost
  // its channel. `--harness` can override a soul default long after install-time
  // reconciliation, so this spawn-time check is the authoritative one.

  // Prerequisites must fail before creating a home, worktree, or identity.
  // Where this launch will run (launchEnvironment): what its configuration sets, else its pane's.
  // `expectedEnv` is the preflight's answer, over the pane this plan expects; the launch reads the
  // session it actually gets (below). A spawn that launches nothing has no pane to read.
  // The pane's working directory only resolves the relative entries of its PATH and its harness
  // configuration folders. While the name is open (a suggesting preview), a sibling of the homes that
  // no instance can be named stands in for the home: its `..` entries resolve as the home's do, and
  // nothing is inside either, so the executable and the probes are the ones the final home would get,
  // and the naming call runs that same executable.
  let paneCwd = suggesting ? join(agent._dir, "instances", ".oats-suggest-name") : home;
  const launchEnvOn = (pane, removed = []) => launchEnvironment({ configEnv: launchConfig?.env, configName: launchConfig?.name, removed, env: process.env, pane, cwd: paneCwd });
  const expectedEnv = launchEnvOn(launch ? () => expectedPaneEnvironment(tmuxSessionPlan, session, undefined, paneCwd) : NO_LAUNCH);
  // A launched harness is looked up where its pane will look it up (launchLookup): this is the
  // preflight against the expected PATH; the launch looks again on the session it gets. Without a
  // launch (or a known destination) the lookup is this process's PATH, as before.
  const lookupFor = (launchEnv) => launch && !launchConfig?.executable?.includes("/") ? launchLookup(launchEnv) : undefined;
  const executable = resolveLaunchExecutable({ harness, declared: launchConfig?.executable, declaringDir: launchConfig?.source, contextDir: repoAbs, lookup: lookupFor(expectedEnv) });
  if (!executable.path && executable.lookup) { previewPreflightBudget = null; throw executableNotOnPanePath(executable, { harness, config: launchConfig, from: launchChoice.from, at: launchChoice.at }); }
  // No executable for the chosen harness (none declared by a configuration): E_HARNESS_UNAVAILABLE names the
  // layer that chose it and the fix. Never a fallback to another harness.
  if (!executable.path && !launchConfig?.executable) { previewPreflightBudget = null; throw harnessUnavailable({ harness, from: launchChoice.from, at: launchChoice.at, why: executable.missing }); }
  if (!executable.path) throw oatsError("E_LAUNCH_EXECUTABLE", `launch configuration ${launchConfig.name}: ${executable.missing}`);
  { const bad = checkLaunchExecutable(executable.path); if (bad) throw oatsError("E_LAUNCH_EXECUTABLE", `launch configuration ${launchConfig?.name || "(harness default)"}: ${bad}`); }
  const bin = executable.path;
  const missingRefs = missingLaunchEnvRefs(launchConfig?.env || {}, process.env);
  if (missingRefs.length) throw oatsError("E_LAUNCH_ENV_MISSING", `launch configuration ${launchConfig.name} references ${missingRefs.join(", ")}, not set in this environment; nothing was created`);
  // A configuration's executable answers the package probe (without one the
  // context-selected name does, as before: its remedies name that command),
  // under the environment the launch will have (launchEffectiveEnv: the
  // configuration's, and its pane's PATH, HOME and selectors, never this
  // process's in their place); the capabilities' own env is not known before
  // their spawn hooks run, which happens after the home exists
  // (awebai/oats#1041). `probed` keeps what the gate judged (null: no
  // requirement applied, so nothing was probed and nothing of the pane was
  // read), to compare with the pane the spawn actually gets.
  if ((launchConfig?.args || []).length && applicableRequirements(harness, resolvedCfg.capabilities).length) throw oatsError("E_LAUNCH_PROBE_UNSUPPORTED", `${requirementsWithArgsMessage(harness, resolvedCfg.capabilities, launchConfig)}; nothing was created`);
  let probed = null;
  const recordedHarnessPackages = (found) => found.map((x) => ({ capability: x.capability, harness: x.harness, package: x.package, dir: x.dir, filtered: x.filtered, loadedBy: "harness-discovery" }));
  const probeEnvOn = (launchEnv, selected = bin) => probeEnvironment(() => (probed = launchEffectiveEnv({ base: process.env, configEnv: launchConfig?.env || {}, launch: launchEnv, harness })), launchEnv, harness, selected);
  const harnessPackages = verifyHarnessPackages(harness, resolvedCfg, repoAbs, { ...(launchConfig?.executable ? { bin } : {}), env: probeEnvOn(expectedEnv) });
  // What a preview of a launch says when no pane's environment is established (no server runs, or
  // it could not be read): the checks that read this process's values in its place, in one line
  // that names every name read that way, PATH among them: the lookup of a bare name and the package
  // probe. A spawn that launches nothing says nothing here: its checks read this process by design,
  // a start checks again on its own session, and it says whose values it read only where it already
  // says something (the folder-trust warning, a refusal of the package gate).
  const previewReadWarning = () => {
    if (!launch) return null;
    const checks = [...(!launchConfig?.executable?.includes("/") && !executable.lookup ? [["the harness lookup", ["PATH"]]] : []), ...(probed ? [["the harness package check", probeNames(harness)]] : [])];
    const note = unestablishedNote(expectedEnv, [...new Set(checks.flatMap(([, names]) => names))]);
    return note ? `${checks.map(([what]) => what).join(", ")}: ${note}` : null;
  };
  const task = o.task ?? (o.taskFile ? readFileSync(o.taskFile, "utf8") : "");
  // The naming call (#1421 §3): a preview's probes have run, so it takes what is left of their budget
  // (at most its own 20 s). Its time counts in the preflight's elapsedMs, but the preflight's status
  // stays its checks': a call the budget ends is `naming.reason` "timeout", and the numbered preview it
  // leaves is as confirmable as a plain one. An apply has no such budget: the call takes its own 20 s,
  // before anything is placed, and every later bound of the apply (hooks, the launch) starts after it.
  let suggested;
  if (suggesting) {
    const seam = Number(process.env.OATS_TEST_NAMING_TIMEOUT_MS), own = seam > 0 ? seam : NAMING_TIMEOUT_MS;
    const left = o.preview === true ? preflightStarted + preflightBudgetMs - Date.now() : own, souls = deploymentSoulNames(root, o.prepared), homes = deploymentInstanceHomes(root);
    let windows;
    const suggestion = yield () => suggestInstanceName({
      soulName: agent.name, harness, bin, instanceModel: model || null, task, timeoutMs: Math.min(own, left),
      env: () => launchEffectiveEnv({ base: process.env, configEnv: launchConfig?.env || {}, launch: expectedEnv, harness }),
      taken: (n) => homes.has(n) || souls.has(n) || (windows ??= oatsTmuxWindows(session)).includes(n),
    });
    naming = suggestion.naming;
    suggested = suggestion.name;
  }
  if (o.preview === true) { preflight = { status: previewPreflightBudget?.exhausted ? "timeout" : "complete", budgetMs: preflightBudgetMs, elapsedMs: Date.now() - preflightStarted }; previewPreflightBudget = null; }
  // A suggested name is placed as `--name` places it (its shadow, its home); otherwise the numbered name
  // keeps its own refusal. From here the home is known: an apply's launch reads its pane from there.
  if (suggested) {
    instance = suggested;
    const shadow = reverseShadow(instance);
    if (shadow) throw shadow;
    ({ home, homeReal, expectedHome } = place(instance));
  } else if (provisional) throw provisional;
  if (suggesting) paneCwd = home;

  if (existsSync(directoryRollbackPath(homeReal))) throw oatsError("E_WORK_INSPECTION_FAILED", `directory cleanup is still owed for ${home}; restore and retire the retained home before reusing its name`);
  // K6: everything a spawn decides is decided by here — and nothing has been
  // touched. Branch/base for a worktree are named now (not after mkdir) so the
  // preview and the apply agree on them; `o.baseRef` selects the start point.
  let plannedBranch = null, plannedBase = null, observedBase = null;
  if (work === "worktree") {
    plannedBranch = o.branch || `agents/${instance}`;
    // Validity is Git's own rule (check-ref-format), not a stricter charset:
    // every later git call takes the name as an argv element, never through a
    // shell, so a valid-but-hostile name is safe and stays exercisable.
    try { execFileSync("git", ["check-ref-format", "--branch", plannedBranch], { stdio: ["ignore", "pipe", "pipe"] }); }
    catch { throw oatsError("E_BAD_ARGS", `branch ${JSON.stringify(plannedBranch)} is not a valid branch name`); }
    if (shInTry(repoAbs, `git rev-parse --verify --quiet ${shq("refs/heads/" + plannedBranch)}`) !== undefined) throw oatsError("E_BRANCH_EXISTS", `branch ${plannedBranch} already exists in ${repoAbs}; choose another name or reuse it deliberately`);
    // Without --base, a clone of the soul's repository branches from the commit this spawn observed it at
    // (the one the resolution, and so the decision, binds), never from what the clone has checked out: a
    // clone is often a human's checkout or a shared reference, far behind (awebai/oats#445).
    observedBase = o.baseRef ? null : observedSoulBase(o.prepared, repoAbs);
    if (observedBase) plannedBase = { ref: observedBase.key, oid: observedBase.oid };
    else {
      const baseRef = o.baseRef || "HEAD";
      const baseOid = shInTry(repoAbs, `git rev-parse --verify --quiet ${shq(baseRef + "^{commit}")}`);
      if (baseOid === undefined) throw oatsError("E_BASE_UNKNOWN", `base ${JSON.stringify(baseRef)} does not resolve to a commit in ${repoAbs}`);
      plannedBase = { ref: baseRef, oid: baseOid };
    }
  }
  // The decision a confirmation binds: placement AND what would actually
  // launch (inherited defaults re-resolved at apply must not drift silently).
  const buildDecision = () => {
    const d = { instance, home, branch: plannedBranch, base: plannedBase,
      effective: { repo: repoAbs, work, harness, model: model || null, launchConfig: launchConfig?.name ?? null, yolo: yolo ?? null, backend, // backend regardless of --no-launch: the decision is what WOULD launch
        childSpawns: ownChildPolicy.allowed, relation: relation ? { kind: relation, anchor: { instance: relativeTo ?? null, agentsRoot: anchorHome ? dirname(dirname(dirname(anchorHome))) : null } } : null,
        // Feature instance-background: bound only when true, so a decision without it keeps its revision.
        ...(background ? { background: true } : {}) } };
    // Workspace model: the decision binds WHAT WILL BE MATERIALIZED — the
    // resolution revision (member commits, package commits, payloads). A member
    // that moved between preview and apply changes it → E_DECISION_STALE.
    {
      d.resolution = o.prepared.resolution.revision;
      // Decision 27 (K1′): the decision also binds the merged per-module payloads the spawn will
      // hand each provider (exactly what reaches OATS_SETTINGS) — so a confirmed apply covers every
      // provider fact (an identity choice, a delivery mode) by value, not only through the
      // resolution revision. Kernel-agnostic: whatever keys the payloads carry.
      d.effective.providers = structuredClone(o.prepared.resolution.payloads ?? {});
    }
    d.revision = createHash("sha256").update(canonicalJson(d)).digest("hex").slice(0, 24);
    return d;
  };
  const launchPromptNotice = launchPromptAnswersNotice(o.prepared.deployment || workspaceOf(root));
  if (o.preview === true) {
    const decision = buildDecision();
    // Workspace model (M3): the preview reports what APPLY will produce — every
    // module as a capability (name + origin) and every module skill with a
    // `module:<cap>` source — not the classic chain's view. The skill names are the
    // ones materialize copies, by its own precedence (lib/materialize.mjs
    // plannedModuleSkills: the resolution's rows, else the manifest's, else skills/*
    // read over the remote), so a root of skills (`skills: ["skills"]`) lists each skill
    // under it and a manifest with no `skills` its skills/ children, as
    // `inspect --soul --composed-skills` does.
    const preparedCapabilities = o.prepared.resolution.modules.map((m) => ({ name: m.name, origin: m.from.kind === "package" ? `package:${m.from.package}@${m.from.version}` : `member:${m.from.repoKey}@${m.from.commit}` }));
    const preparedSkills = (yield () => (o.plannedSkills ?? plannedSkillsDefault)(o.prepared)).map((s) => ({ name: s.name, source: `module:${s.module}` }));
    // R5 (0.25.2, decision 14): the preview shows the provider payloads the apply
    // will record — `providers` is the --provider map exactly as parsed (what the
    // operator typed; prepareInstance keeps it on prepared.spawn.providers) and
    // `settings.<cap>` is the MERGED payload per module (workspace ⊕ soul ⊕
    // local.settings ⊕ --provider), i.e. what the provider receives. Reserved and
    // poison keys were refused by resolveSoul before this point (E_WORKSPACE_SCHEMA).
    const preparedProviders = structuredClone(o.prepared.spawn?.providers && typeof o.prepared.spawn.providers === "object" ? o.prepared.spawn.providers : {});
    // Addendum 5: where each leaf of `settings.<cap>` came from (JSON pointer → { kind, at }):
    // manifest-default | workspace | soul | host | spawn, the last layer that set it.
    const preparedSettingsOrigins = Object.fromEntries(o.prepared.resolution.modules.map((m) => [m.name, structuredClone(o.prepared.resolution.payloadOrigins?.[m.name] ?? {})]));
    // The preview's warnings are strings: the launchPromptAnswers notice, then what a module declares and this kernel ignores.
    // The development-channel statement is the apply's: no launch hook runs here, so the argv is unknown.
    const previewWarnings = [...(launchPromptNotice ? [launchPromptNotice] : []), ...contractWarningMessages(resolutionContractWarnings(o.prepared.resolution)), ...[previewReadWarning()].filter(Boolean)];
    const preparedSettings = Object.fromEntries(o.prepared.resolution.modules.map((m) => [m.name, structuredClone(o.prepared.resolution.payloads?.[m.name] && typeof o.prepared.resolution.payloads[m.name] === "object" ? o.prepared.resolution.payloads[m.name] : {})]));
    return deliver({
      // Team model v2: the soul's teams here (unmapped rows included) and its default — the choice a
      // Desktop offers before anything is minted; joining any but the default is the provider's explicit act.
      ...{ modules: o.prepared.preview ?? null, teams: structuredClone(o.prepared.resolution.teams ?? []), defaultTeam: structuredClone(o.prepared.resolution.defaultTeam ?? null), resolution: o.prepared.resolution.revision, declRevision: o.prepared.resolution.declRevision ?? null, payloadRevision: o.prepared.resolution.payloadRevision ?? null, workspace: o.prepared.discovery?.key ?? null, standalone: o.prepared.discovery?.standalone === true, providers: preparedProviders, settings: preparedSettings, settingsOrigins: preparedSettingsOrigins },
      spawnPreviewApi: 2, preview: true, ...(previewWarnings.length ? { warnings: previewWarnings } : {}), agent: agent.name, kind: agent.kind || "persistent", instance, home, repo: repoAbs, work,
      subject: o.subject ?? { soul: agent.name, agentsRoot: root, context: null },
      decision, preflight,
      backendStatus: launch ? { name: backend, installed: !!which(backend), started: false } : null,
      harness, model: model || null, modelSource: launchSelection.modelSource ?? null, launchConfig: launchConfig?.name ?? null, launchConfigSource: launchConfig?.source ?? null, launchConfigDefault: launchConfig?.harnessDefault === true, yolo, backend,
      background, ...(backgroundFrom ? { backgroundFrom } : {}),
      launch: launchReport({ declared: launchChoice.declared, harness, model, launchConfig: launchConfig?.name, from: launchChoice.from, at: launchChoice.at }),
      branch: plannedBranch, base: plannedBase, worktree: work === "worktree" ? join(home, "work") : null,
      // #796: the `worktree` hooks a worktree-mode spawn would fire, in the order they run; null in other modes.
      worktreeHooks: work === "worktree" ? worktreeHooksOf(resolvedCfg.capabilities).map((h) => ({ capability: h.id, required: h.required })) : null,
      relation: relation || null, parentInstance: parentInstance && parentInstance !== instance ? parentInstance : null,
      policy: { childSpawns: ownChildPolicy }, executable: bin, capabilities: preparedCapabilities,
      skills: [...expectedResources.filter((r) => r.type === "skill-tree" && !r.deferred).flatMap((r) => r.entries || []), ...preparedSkills], task: task || null,
      ...(naming ? { naming } : {}),
    });
  }
  if (o.expectDecision !== undefined) {
    // A confirmed preview binds THIS apply: same name, home, branch and base
    // oid, recomputed here under the same placement path. Any drift is a typed
    // refusal carrying the fresh decision — nothing is created, nothing is
    // auto-suffixed or silently re-based.
    const fresh = buildDecision();
    if (fresh.revision !== o.expectDecision) throw Object.assign(oatsError("E_DECISION_STALE", `the previewed decision changed (${o.expectDecision} → ${fresh.revision}): ${fresh.instance}${plannedBase ? ` from ${plannedBase.ref}@${plannedBase.oid.slice(0, 12)}` : ""}; preview again`), { decision: fresh });
  }
  // The observed base must be in the clone before anything is placed; a commit that cannot be fetched
  // refuses the spawn, never falling back to the clone's own branch.
  if (observedBase) fetchObservedBase(repoAbs, observedBase);
  // Backend PRESENCE is a prerequisite, checked before anything is placed (M1):
  // an absent tmux binary must fail with nothing created, never after a
  // populated home exists.
  if (launch && !which(backend)) throw new Error(`${backend} not installed (brew install tmux); nothing was created`);
  // Exclusive placement reservation: the parent may be created, the home
  // itself never with `recursive` — EEXIST means another spawn (a concurrent
  // apply of the same decision, or anything else) got here first, and this one
  // has touched nothing.
  mkdirSync(dirname(home), { recursive: true });
  // 0700: the home holds the instance's identity keys, TASK.md and transcripts.
  try { mkdirSync(home, { mode: 0o700 }); }
  catch (e) {
    if (e?.code === "EEXIST") throw Object.assign(oatsError("E_PLACEMENT_TAKEN", `${instance} already exists at ${home} (a concurrent spawn won the placement); nothing was created by this call`), { instance, home });
    throw e;
  }
  const createdHomeIdentity = directoryIdentity(home);
  // Names are deployment-wide, but the reservation above is per soul: a concurrent
  // spawn of ANOTHER soul under the same name reserves its own directory. Re-check
  // now that ours exists — two holders means neither may keep it (at most one
  // winner, possibly none; each loser created nothing that survives).
  if (o.instance === undefined) {
    const holders = deploymentInstanceHomes(root).get(instance) ?? [];
    if (holders.length > 1) {
      try { rmdirSync(home); } catch { /* empty by construction; leave it rather than recurse */ }
      const other = holders.find((h) => resolve(h) !== resolve(home)) ?? null;
      // A suggested name is refused as the same name given with --name would be.
      if (o.name !== undefined || suggested) throw Object.assign(oatsError("E_INSTANCE_NAME_TAKEN", `instance name "${instance}" was taken by a concurrent spawn in this deployment (${other}); nothing was created by this call — ${suggested ? "spawn again to have another name suggested" : "pick another --name"}`), { instance, home: other });
      throw Object.assign(oatsError("E_PLACEMENT_TAKEN", `${instance} was taken by a concurrent spawn of another soul (${other}); nothing was created by this call — preview again`), { instance, home: other });
    }
  }
  // TOCTOU: the placement checks above ran BEFORE composition and the harness
  // package preflight, both of which shell out — a window in which anything able
  // to write in the agent directory can swap `instances/` for a link elsewhere,
  // and mkdirSync follows it (reviewer-a6aa1c5). Re-assert on the directory that
  // now exists, before a single file is written into it (materialize included)
  // or any hook runs.
  // This narrows the window to the mkdir itself rather than closing it outright:
  // Node has no openat/O_NOFOLLOW-relative API, so a truly hostile filesystem
  // needs OS-level protection on the deployment, not a pathname check.
  const createdReal = realpathSync(home);
  if (resolve(createdReal) !== resolve(expectedHome)) {
    // Remove only what we just made, only if it is still empty, and never
    // recursively — whatever lives at an unexpected destination is not ours.
    try { rmdirSync(createdReal); } catch { /* not empty or not removable: leave it and say so */ }
    throw oatsError("E_NO_CANONICAL_ROOT", `instance home ${home} was created at ${createdReal}, not at ${expectedHome} — the path changed after it was validated (a swapped instances/ link), so nothing has been written into it and the spawn is aborted`);
  }
  // One rollback from here to the first lifecycle hook: the home is ours
  // (placement won) and nothing outside it exists yet, so removing the home
  // WHOLE is the entire compensation. `rmSync` recursive: a prepared home is
  // populated by materialize (modules, skills, AGENTS.md, instance.json) — a
  // non-recursive rmdir would leave it behind and the retry would find its
  // name taken (M1). Nothing of a classic home exists at this point either.
  const rollbackEmptyOrPreparedHome = (e) => {
    try { rmSync(home, { recursive: true, force: true }); }
    catch (x) { e.message += ` — rollback INCOMPLETE, remove ${home} manually: ${x.message}`; unconfirmedSpawn(e); }
    return e;
  };
  // Workspace model: copy every resolved capability WHOLE into the new home
  // (.oats/modules/<cap>/, its skills flat in .agents/skills/<skill>/) and record modules/providers
  // in instance.json. Then REBUILD the capability rows against the copies that
  // landed (H1): until now `resolvedCfg.capabilities` were PLANNED rows (no
  // skills, no inject, no dir) — hooks, environment, requirements, retirement
  // and instance.json all read the rebuilt rows from here on.
  let materializeOutcome = null;
  if (o.prepared) {
    // The soul's AGENTS.md is the body materialize composes onto: the capability
    // injects in the resolution's instruction order, then the kernel's blocks.
    try {
      const kernelBlocks = composition.blocks.filter((b) => !b.source.startsWith("capability:"));
      materializeOutcome = yield () => (o.materialize ?? materializePreparedDefault)({ ...o.prepared, soulAgentsMd: composition.body, blocks: kernelBlocks, soulDir }, home);
      const rows = (typeof o.prepared.toCapabilityRows === "function" ? o.prepared.toCapabilityRows : toCapabilityRows)(o.prepared.resolution, home);
      if (!Array.isArray(rows)) throw new Error("toCapabilityRows returned no rows");
      for (const row of rows) row.hooks = materializedHookCommands(row, home);
      resolvedCfg.capabilities = rows;
      // S1: the capability blocks materialize appended are part of the composed
      // instructions. Read the markers back from the AGENTS.md that was WRITTEN
      // (the authority on what the instance sees) and merge them into the
      // composition so meta.instructions / composition.expected and the
      // completeness check below describe the whole file, not only the kernel's
      // half.
      const written = readFileSync(join(home, "AGENTS.md"), "utf8");
      const known = new Set(composition.blocks.map((b) => `${b.source}\u0000${b.file}`));
      const outcomeBlocks = Array.isArray(materializeOutcome?.blocks) ? materializeOutcome.blocks : [];
      for (const m of written.matchAll(/^<!-- oats:(capability:[^\s]+) src=(.+?) -->$/gm)) {
        const source = m[1], file = m[2];
        if (known.has(`${source}\u0000${file}`)) continue;
        const fromOutcome = outcomeBlocks.find((b) => b.source === source && b.file === file);
        const content = fromOutcome?.content ?? (existsSync(file) ? readFileSync(file, "utf8").trim() : "");
        composition.blocks.push({ source, file, content, materialized: true });
        // S1: the appended block is part of what the composition PROMISES the instance.
        expectedResources.push({ type: "instruction-block", source, declared: file, path: file, materialized: true });
        known.add(`${source}\u0000${file}`);
      }
      // The record lists the blocks in the order the written file has them
      // (capability injects, then the kernel's); a block not found keeps its place after them.
      const bodyEnd = composition.body.replace(/\n*$/, "\n").length;
      const at = (b) => { const i = written.indexOf(`<!-- oats:${b.source} src=${b.file} -->\n`, bodyEnd); return i < 0 ? Infinity : i; };
      composition.blocks = composition.blocks.map((b, i) => ({ b, i, at: at(b) })).sort((x, y) => (x.at === y.at ? x.i - y.i : x.at < y.at ? -1 : 1)).map(({ b }) => b);
      orderInstructionBlocks(expectedResources, composition.blocks);
      // The expected resources deferred to materialize (module skills/injects)
      // are now resolvable: fill their paths so the record and the completeness
      // check compare promised against landed.
      for (const r of expectedResources) {
        if (r.deferred !== "materialize") continue;
        const row = rows.find((c) => c.id === r.module);
        if (r.type === "injection") { r.path = row?.inject; continue; }
        if (r.type === "skill-tree") {
          // Module skills land flat in the canonical skills root; the entries are
          // the names materialize placed for this module (what the resolution
          // promised), verified against the root in the completeness check.
          const skillsRoot = join(home, ".agents", "skills");
          r.path = existsSync(skillsRoot) ? skillsRoot : undefined;
          r.entries = Array.isArray(materializeOutcome?.skills)
            ? materializeOutcome.skills.filter((s) => s.module === r.module).map((s) => s.name)
            : (row?.skills || []).map((p) => basename(p));
        }
      }
    } catch (e) { throw rollbackEmptyOrPreparedHome(e); }
  }
  initializeNativeHistory(home);

  // Body: instructions are a generated instance-local view; the home carries no soul
  // link (the composed AGENTS.md already holds the soul's instructions). The soul
  // directory this instance incarnates is RECORDED (instance.json `soulDir`) and handed
  // to every classic lifecycle hook and dispatched command as OATS_SOUL. A workspace soul (o.prepared)
  // lives in the per-commit cache agents/<name>/souls/<commit12>/ and agents/<name>/soul
  // is only the kernel-owned "current" POINTER (swapped by every ensureWorkspaceSoul,
  // including a preview's). The record names ITS commit's directory by realpath — never
  // the pointer — so a later fetch can move "current" without changing what a running
  // instance's hooks see (decision 7); the OKF hook's owner pin stays valid.
  let homeSoulTarget = soulDir;
  if (o.prepared?.soulEntry?.commit) {
    const perCommit = join(agent._dir, "souls", String(o.prepared.soulEntry.commit).slice(0, 12));
    if (existsSync(join(perCommit, "soul.yaml"))) homeSoulTarget = realpathSync(perCommit);
  }
  if (homeSoulTarget === soulDir) {
    // Not prepared (or the cache entry is absent): still never link a swappable pointer —
    // when agents/<name>/soul is the kernel's pointer into souls/, link what it shows now.
    try {
      if (lstatSync(soulDir).isSymbolicLink()) {
        const real = realpathSync(soulDir), soulsReal = realpathSync(join(dirname(soulDir), "souls"));
        const rel = relative(soulsReal, real);
        if (rel && !rel.startsWith("..") && !isAbsolute(rel) && !rel.includes(sep)) homeSoulTarget = real;
      }
    } catch { /* absent souls/ or unreadable link: record the soul dir itself */ }
  }
  if (!existsSync(join(home, "CLAUDE.md"))) symlinkSync("AGENTS.md", join(home, "CLAUDE.md"));

  // Skills: module skills were copied WHOLE and FLAT into <home>/.agents/skills/<skill>/
  // by materialize (decision 7/13); here only the soul's own skills join them, one
  // directory each, at the same level — the one level every harness discovers. There
  // is no override: a soul skill named like a module's skill is a duplicate (decision 16). The harness is launched with its normal
  // discovery — the machine's and the repo's skills are the harness's business.
  const sources = [];
  const soulSkills = join(soulDir, "skills");
  if (existsSync(soulSkills)) sources.push({ id: "soul", path: soulSkills });
  const chosen = new Map();
  // Names compare case-insensitively: one directory per skill on a case-insensitive
  // filesystem (APFS, NTFS) must not silently merge `Foo` into `foo`.
  const moduleSkillOwner = new Map((materializeOutcome?.skills || []).map((s) => [s.name.toLowerCase(), s.module]));
  const chosenKeys = new Map();
  const offer = (name, src, source) => {
    const key = name.toLowerCase();
    if (chosenKeys.has(key) || moduleSkillOwner.has(key) || existsSync(join(home, ".agents", "skills", name))) {
      const other = chosenKeys.get(key) ?? (moduleSkillOwner.has(key) ? `module ${moduleSkillOwner.get(key)}'s skill` : `the existing .agents/skills/${name}`);
      throw oatsError("E_SKILL_DUPLICATE", `skill "${name}" from ${source} collides with ${other}`);
    }
    chosen.set(name, { src, source });
    chosenKeys.set(key, source);
  };
  // A refusal here comes after materialize populated the home: remove it whole,
  // like every other failure between materialize and the completeness check.
  try {
    // Same enumerator preflight used, so "what a tree promises" and "what gets
    // copied" cannot drift apart.
    for (const source of sources) for (const entry of skillEntriesIn(source.path)) offer(entry.name, entry.src, source.id);
    mkdirSync(join(home, ".agents", "skills"), { recursive: true });
    mkdirSync(join(home, ".claude"), { recursive: true });
    for (const [name, selected] of [...chosen].sort(([a], [b]) => a.localeCompare(b))) {
      // Pi's recursive skill scanner does not descend through directory symlinks.
      // Copy each selected tree so the exact instance-local set is real and immutable.
      copyTreeSafe(realpathSync(selected.src), join(home, ".agents", "skills", name));
    }
    if (!existsSync(join(home, ".claude", "skills"))) symlinkSync(join("..", ".agents", "skills"), join(home, ".claude", "skills"));
  } catch (e) { throw rollbackEmptyOrPreparedHome(e); }

  // EXPECTED == MATERIALIZED. Preflight proved every declared resource resolves;
  // this proves the copies actually landed, so "the composition is complete" is
  // an asserted fact rather than an inference from no error having been thrown.
  // `.agents/skills` is canonical and `.claude/skills` aliases it, so the alias
  // is verified to resolve exactly onto the canonical tree and nowhere else.
  const materialized = [...chosen].sort(([a], [b]) => a.localeCompare(b)).map(([name, v]) => ({ name, source: v.source, from: v.src }));
  const incomplete = [];
  for (const m of materialized) {
    if (!hasSkillDoc(join(home, ".agents", "skills", m.name))) incomplete.push(`skill "${m.name}" (from ${m.source}) did not materialize as a readable SKILL.md`);
  }
  // Reconcile against what was PROMISED, not only against what was selected:
  // iterating `materialized` alone can never notice a promised skill that never
  // entered the set (reviewer-400c1e6). Matching is by NAME because an explicit
  // skill-override may legitimately satisfy a promised name from another source.
  for (const r of expectedResources) {
    if (r.deferred === "materialize") continue; // module skills: verified against the landed copies just below
    for (const name of r.entries || []) {
      if (!chosen.has(name)) incomplete.push(`skill "${name}", promised by ${r.source} (${r.declared}), is missing from the composed set`);
    }
  }
  // Prepared spawn: every module's declared skill must have been copied to
  // .agents/skills/<skill>/ by materialize — verify the copies landed as
  // readable skills, one level deep, where the harnesses discover them.
  if (o.prepared) {
    for (const r of expectedResources) {
      if (r.deferred !== "materialize" || r.type !== "skill-tree") continue;
      if (!r.path) { incomplete.push(`module "${r.module}" declares skill tree ${r.declared} but .agents/skills is absent`); continue; }
      if (!r.entries.length) incomplete.push(`module "${r.module}" declares skill tree ${r.declared} but none of its skills was copied into .agents/skills`);
      for (const name of r.entries) if (!hasSkillDoc(join(r.path, name))) incomplete.push(`skill "${name}" (module ${r.module}) did not materialize as a readable SKILL.md`);
    }
  }
  for (const r of expectedResources) {
    if (r.type !== "injection") continue;
    if (r.deferred === "materialize" && !r.path) { incomplete.push(`injection from ${r.source} (${r.declared}) was not materialized into the module copy`); continue; }
    if (!composition.blocks.some((b) => b.file === r.path)) incomplete.push(`injection from ${r.source} (${r.declared}) resolved but is not present in the composed AGENTS.md`);
  }
  const aliasTarget = realPathOrNearest(join(home, ".claude", "skills"));
  if (aliasTarget !== realPathOrNearest(join(home, ".agents", "skills"))) {
    incomplete.push(`.claude/skills resolves to ${aliasTarget}, not the canonical .agents/skills tree`);
  }
  if (incomplete.length) {
    // Nothing outside the home exists yet (no worktree, no hooks, no window), so
    // removing the scaffold is the whole rollback.
    let removal = "", removalFailed = false;
    try { rmSync(home, { recursive: true, force: true }); } catch (e) { removalFailed = true; removal = ` — rollback INCOMPLETE, remove ${home} manually: ${e.message}`; }
    const error = oatsError("E_COMPOSITION_INCOMPLETE", `the instance composition did not materialize completely:\n${incomplete.map((m) => `  ${m}`).join("\n")}${removal}`);
    throw removalFailed ? unconfirmedSpawn(error) : error;
  }

  // Work tree.
  let branch;
  let worktreeCanonical; // captured immediately after add, before setup/hooks can mutate/remove it
  if (work === "worktree") {
    branch = plannedBranch;
    const wt = join(home, "work");
    let added = false;
    try {
      execFileSync("git", ["-C", repoAbs, "worktree", "add", wt, "-b", branch, plannedBase.oid],
        { stdio: ["ignore", "pipe", "pipe"] });
      added = true;
      // Git registers a canonical path. Retain it now: compensation hooks can
      // remove/make the directory inaccessible before rollback verification.
      worktreeCanonical = realpathSync(wt);
    } catch (e) {
      const original = e.stderr?.toString().trim() || e.message;
      const incomplete = [];
      if (added) {
        // Canonicalization failed AFTER add: cleanup is a transaction too.
        // Capture every failure and verify Git effects; because canonical
        // identity was unavailable, never claim confirmed worktree absence.
        const run = (argv) => {
          try { return { ok: true, out: execFileSync(argv[0], argv.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
          // With encoding:"utf8" a silent command yields stderr === "" — FALSY — so
          // `e2.stderr || e2.message` fell through to "Command failed: …" and made
          // every clean probe look like a failed one. `git rev-parse --verify
          // --quiet` on an absent ref is exactly that case, so a successful branch
          // deletion could never be confirmed and rollback always reported
          // INCOMPLETE. Distinguish "no output" from "no stderr captured".
          catch (e2) { return { ok: false, status: e2.status, err: String(e2.stderr ?? e2.message ?? "").trim() }; }
        };
        const remove = run(["git", "-C", repoAbs, "worktree", "remove", "--force", wt]);
        if (!remove.ok) incomplete.push(`git worktree ${wt}: remove failed (${remove.err || `exit ${remove.status}`})`);
        const prune = run(["git", "-C", repoAbs, "worktree", "prune"]);
        if (!prune.ok) incomplete.push(`git worktree ${wt}: prune failed (${prune.err || `exit ${prune.status}`})`);
        const list = run(["git", "-C", repoAbs, "worktree", "list", "--porcelain", "-z"]);
        if (!list.ok) incomplete.push(`git worktree ${wt}: could not verify removal (${list.err || "worktree list failed"})`);
        else incomplete.push(`git worktree ${wt}: could not verify removal (canonical path unavailable after add)`);
        incomplete.push(...deleteBranchAsCreated(run, repoAbs, branch, plannedBase.oid));
      }
      try { rmSync(home, { recursive: true, force: true }); } catch (e2) { incomplete.push(`instance home ${home}: ${e2.message}`); }
      const note = incomplete.length ? ` — rollback INCOMPLETE — clean up manually: ${incomplete.join("; ")}` : "";
      const error = new Error(`git worktree add/canonicalization failed: ${original}${note}`);
      throw incomplete.length ? unconfirmedSpawn(error) : error;
    }
  } else if (work === "directory") {
    // An owned execution directory, not a link to the source or a fake Git repo.
    mkdirSync(join(home, "work"));
  } else if (work === "attached") {
    // Attach to ANOTHER instance's work tree (o.workDir): sibling home, shared tree.
    // The tree belongs to its owner — retire never removes it (work/ is a symlink).
    if (!o.workDir || !existsSync(o.workDir)) { rmSync(home, { recursive: true, force: true }); throw new Error(`attached mode needs workDir (got: ${o.workDir})`); }
    symlinkSync(resolve(o.workDir), join(home, "work"));
    branch = recordedHeadBranch(o.workDir);
  } else if (work === "workspace") {
    // Cross-repo coordinator: ./work is the deployment boundary (the directory
    // holding oats-local.yaml, prepared.deployment), not a repo — member repos are
    // read-context; repo edits are routed, not made.
    const wsRoot = preparedDeployment;
    if (!wsRoot) {
      rmSync(home, { recursive: true, force: true });
      throw oatsError("E_LOCAL_MISSING", "workspace mode needs its deployment directory (the one holding oats-local.yaml) so ./work has a root");
    }
    symlinkSync(resolve(wsRoot), join(home, "work"));
    branch = undefined; // no repo identity: the workspace is not a git tree
  } else {
    symlinkSync(repoAbs, join(home, "work"));
    branch = recordedHeadBranch(repoAbs);
  }

  // What the composed modules declare and this kernel ignores (an unknown hook event), as the preview said.
  const warnings = [...(launchPromptNotice ? [launchPromptNotice] : []), ...contractWarningMessages(resolutionContractWarnings(o.prepared?.resolution))];

  // Establish directory ownership while these are still the kernel's own roots.
  // A hook may replace either path; it must never mint authority for that target.
  if (work === "directory") {
    assertDirectoryRoots(home, homeReal);
    writeRetirementBaseline(home, join(home, "work"), work, resolvedCfg.capabilities, { launched: false });
  }

  // Capability lifecycle hooks (spawn) — the knowledge integration scaffolds instance
  // memory (STATE.md/log.md/notes/ are OKF conventions, not kernel ones); the
  // messaging integration mints the comms identity. Kernel stays memory-agnostic.
  const preparedSoulId = o.prepared ? preparedSoulIdOf(o.prepared.soulEntry) : undefined;
  // A trigger's event (lib/triggers.mjs): a private copy in the home, named to hooks and the harness
  // as OATS_TRIGGER_EVENT_FILE. Its PR title/body are never in the task: the soul reads them from here.
  let triggerEventFile = null;
  if (o.triggerEvent && typeof o.triggerEvent === "object") {
    triggerEventFile = join(home, ".oats", TRIGGER_EVENT_FILE);
    mkdirSync(dirname(triggerEventFile), { recursive: true });
    writeFileSync(triggerEventFile, JSON.stringify(o.triggerEvent, null, 2) + "\n", { mode: 0o600 });
  }
  // Hooks read the soul the HOME links (the per-commit directory for a workspace
  // soul), never the swappable agents/<name>/soul pointer: a provider that pins a
  // path must pin this instance's content, and OATS_SOUL_ID is what it keys on.
  const harnessExecutableHanded = harnessExecutableEnv(bin, !!(executable.lookup || launchConfig?.executable?.includes("/")));
  const hookRes = runLifecycleHooks("spawn", {
    home, instance, agentName: agent.name, soulDir: homeSoulTarget, soulId: preparedSoulId, contextDir: repoAbs,
    workspaceDir: workspaceOf(root), rootDir: root, resolved: resolvedCfg,
    extraEnv: { OATS_TASK: task, OATS_REPO: repoAbs, OATS_BRANCH: branch || "", OATS_WORK: work, OATS_HARNESS: harness, ...harnessExecutableHanded, OATS_RUNTIME: harness, OATS_KIND: agent.kind || "persistent", ...(triggerEventFile ? { OATS_TRIGGER_EVENT_FILE: triggerEventFile } : {}), ...(spawnedBy ? { OATS_SPAWNER_HOME: spawnedBy.home } : {}) },
  });
  warnings.push(...hookRes.warnings);
  if (kernelNode().warning) warnings.push(kernelNode().warning);
  // Which capability hooks RAN (in order) and how each ended — recorded on the
  // `spawned` event below: the instance's event log is the auditable fact that
  // a capability configured itself, independent of whatever the hook printed.
  const hookReceipt = (res) => { const failedBy = new Map((res.failures || []).map((f) => [f.capability, f])); return (res.order || []).map((id) => ({ capability: id, ok: !failedBy.has(id), ...(failedBy.has(id) ? { required: failedBy.get(id).required === true, contract: failedBy.get(id).contract ?? null } : {}), meta: Object.hasOwn(res.meta || {}, id) })); };
  const requiredFailures = (hookRes.failures || []).filter((f) => f.required);
  let parentLineageCommitted = false, anchorWritten;
  const commitParentLineage = () => {
    if (relation !== "parent" || !anchorMeta || !anchorMetaPath || parentLineageCommitted) return;
    const next = { ...anchorMeta, parentInstance: instance };
    delete next.siblingInstance;
    anchorWritten = JSON.stringify(next, null, 2) + "\n";
    // Preserve the established atomic parent-write contract, including the
    // instance-scoped temp path, error context and unconfirmed temp cleanup.
    const tmpPath = `${anchorMetaPath}.tmp-${instance}`;
    try {
      if (readFileSync(anchorMetaPath, "utf8") !== anchorOriginal) throw new Error("parent anchor changed during spawn preparation");
      const anchorMode = statSync(anchorMetaPath).mode & 0o7777;
      writeFileSync(tmpPath, anchorWritten, { mode: anchorMode });
      chmodSync(tmpPath, anchorMode);
      renameSync(tmpPath, anchorMetaPath);
      parentLineageCommitted = true;
    } catch (e) {
      try { rmSync(tmpPath, { force: true }); }
      catch (cleanupError) { ancillaryCleanup.push(`temp file ${tmpPath}: ${cleanupError.message}`); }
      throw new Error(`relation "parent": failed to re-point anchor "${relativeTo}" (${e.message})`);
    }
  };
  // #796: the `worktree` hooks this spawn fires (work: worktree only), their run, and the
  // in-progress marker that covers a parent killed while they run.
  const treeHooks = work === "worktree" ? worktreeHooksOf(resolvedCfg.capabilities) : [];
  let worktreeRun = null, treeGuard = null, inProgressMarker = false;
  const writeSpawnInProgressMarker = (hook) => {
    const retireOwed = new Set((hookRes.order || []).filter((id) => resolvedCfg.capabilities.find((c) => c.id === id)?.hooks?.retire));
    writeQuarantineMarker(home, buildQuarantineMarker({
      instance, agent, soulDir: homeSoulTarget, soulId: preparedSoulId,
      incomplete: ["the spawn is running its worktree hooks; until its process is gone this home is a spawn in progress"],
      failed: [{ capability: "oats.kernel", event: "worktree" }],
      outstandingHooks: retireOwed, outstandingGit: new Set(branch ? ["worktree", "branch"] : ["worktree"]),
      repoAbs, work, branch, resolvedCfg, hookMeta: hookRes.meta || {}, launched: false, tmux: { session, window: instance },
      reason: "spawn interrupted while its worktree hooks ran",
    }), { inProgress: { ...selfIdentity(), startedAt: inProgressStartedAt, branch, baseOid: plannedBase.oid, ...hook } });
    if (!inProgressMarker) {
      inProgressMarker = true;
      writeRetirementBaseline(home, join(home, "work"), work, resolvedCfg.capabilities, { launched: false, tmux: { session, window: instance } });
    }
  };
  const inProgressStartedAt = new Date().toISOString();
  // The spawn's commit point for the marker: the final instance.json and baseline are written.
  const clearSpawnInProgressMarker = () => {
    if (!inProgressMarker) return;
    rmSync(join(home, ".oats-rollback-incomplete.json"), { force: true });
    inProgressMarker = false;
  };
  let promptDispatched = false, promptTarget, promptResult, promptStartId;
  let windowMayExist = false;
  let spawnTmux;
  const ancillaryCleanup = [];
  // One compensation owner, from the first hook result through launch and
  // the final lineage write. Preserve the original failure and retain any
  // credentials/metadata whose cleanup could not be confirmed.
  const compensateSpawn = () => {
    const failed = requiredFailures.length
      ? requiredFailures.map((f) => ({ capability: f.capability, event: f.event, ...(f.contract ? { contract: f.contract } : {}) }))
      : [{ capability: "oats.kernel", event: "spawn" }];
    const incomplete = [...ancillaryCleanup];
    const probe = (argv) => {
      try { return { ok: true, out: execFileSync(argv[0], argv.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
      // An absent ref exits 1 with empty stderr; preserve that distinction.
      catch (e2) { return { ok: false, status: e2.status, err: String(e2.stderr ?? e2.message ?? "").trim() }; }
    };
    // Retain cleanup owners so a retry must actually discharge their debt.
    const outstandingHooks = new Set();
    const outstandingGit = new Set();
    // A failed new-window command may still have created its window. Verify
    // quiescence before removing credentials or work that harness may be using.
    // On the socket recorded for this spawn: windowMayExist is only set once it is.
    if (windowMayExist) {
      const socket = spawnTmux.socket;
      try { tmuxOn(socket, ["kill-window", "-t", `=${session}:=${instance}`]); } catch { /* verify the effect below */ }
      const winProbe = probe(["tmux", "-u", "-S", socket, "list-windows", "-t", `=${session}`, "-F", "#{window_name}"]);
      const unresolved = !winProbe.ok || winProbe.out.split("\n").includes(instance);
      if (unresolved) {
        incomplete.push(!winProbe.ok
          ? `tmux window ${session}:${instance}: could not verify removal (${winProbe.err || "list-windows failed"})`
          : `tmux window ${session}:${instance} still running`);
        for (const cap of resolvedCfg.capabilities) if (cap.hooks?.retire) outstandingHooks.add(cap.id);
        if (work === "worktree") {
          outstandingGit.add("worktree");
          if (branch) outstandingGit.add("branch");
        }
        return { unconfirmed: true, note: quarantineInstanceHome({
          home, instance, agent, soulDir: homeSoulTarget, soulId: preparedSoulId, incomplete, failed, outstandingHooks, outstandingGit,
          repoAbs, work, branch, resolvedCfg, hookMeta: hookRes.meta || {},
          launched: true, tmux: spawnTmux, directoryHome: homeReal, recordRetirementBaseline: true,
        }) };
      }
    }
    // Once hooks ran, directory execution may already hold authored results.
    // Preserve before compensation and again afterwards, just like retirement.
    // Failure to copy retains the home, never converts a failed spawn into loss.
    const directoryRecoveries = [];
    let lastDirectoryFingerprint;
    let compensationMeta = {};
    const retainDirectory = (error) => {
      incomplete.push(`directory preservation: ${error.message}`);
      // No successful copy means no destructive cleanup. Even after a partial
      // compensation pass, retry with the ORIGINAL spawn receipt, not its report.
      for (const cap of resolvedCfg.capabilities) {
        if (cap.hooks?.retire || (hookRes.order?.includes(cap.id) && hookRes.meta?.[cap.id])) outstandingHooks.add(cap.id);
      }
      const note = quarantineInstanceHome({
        home, instance, agent, soulDir: homeSoulTarget, soulId: preparedSoulId, incomplete, failed, outstandingHooks, outstandingGit,
        repoAbs, work, branch, resolvedCfg, hookMeta: hookRes.meta || {}, compensationMeta,
        launched: false, directoryPreservation: true, directoryHome: homeReal,
        recordRetirementBaseline: true,
      });
      return { unconfirmed: true, note: `${note}${directoryRecoveries.length ? `; prior work recovery: ${directoryRecoveries.join(", ")}` : ""}` };
    };
    const preserveDirectory = () => {
      if (work !== "directory") return;
      assertDirectoryRoots(home, homeReal);
      const path = join(home, "work");
      if (!readdirSync(path).length) return;
      const directoryFingerprint = directoryBytes(path);
      if (lastDirectoryFingerprint === directoryFingerprint) return;
      const receipt = preserveRetirementWork({ home, work: path, directory: true, directoryFingerprint, classes: ["directory work bytes"] }, { work, repo: repoAbs }, instance);
      directoryRecoveries.push(receipt.path);
      lastDirectoryFingerprint = directoryFingerprint;
    };
    try { preserveDirectory(); }
    catch (e) { return retainDirectory(e); }
    try {
      const comp = runLifecycleHooks("retire", {
        home, instance, agentName: agent.name, soulDir: homeSoulTarget, soulId: preparedSoulId, contextDir: repoAbs,
        workspaceDir: workspaceOf(root), rootDir: root, resolved: resolvedCfg,
        priorMeta: hookRes.meta || {},
      });
      for (const f of comp.failures || []) { incomplete.push(`retire hook ${f.capability}: ${f.message}`); outstandingHooks.add(f.capability); }
      // A compensation hook may exit 0 yet report that it did not finish. Only
      // an explicit "nothing to undo" counts as complete; anything else means
      // external state (a remote identity) may still exist, and the rollback
      // must not be announced as clean while the local key that could delete it
      // is about to be removed.
      for (const [capId, m] of Object.entries(comp.meta || {})) {
        if (m && typeof m === "object" && m.retired === false && m.reason !== "nothing-to-delete") {
          incomplete.push(`retire hook ${capId}: reported incomplete cleanup${m.reason ? ` (${m.reason})` : ""} — external state may remain`);
          outstandingHooks.add(capId);
        }
      }
      compensationMeta = { ...compensationMeta, ...(comp.meta || {}) };
    } catch (e2) {
      incomplete.push(`retire hooks: ${e2.message}`);
      // The whole pass died, so which hooks ran is unknown: every capability that
      // HAS a retire hook is outstanding until a retry proves otherwise.
      for (const cap of resolvedCfg.capabilities) if (cap.hooks?.retire) outstandingHooks.add(cap.id);
    }
    if (work === "worktree") {
      const wt = join(home, "work");
      probe(["git", "-C", repoAbs, "worktree", "remove", "--force", wt]);
      probe(["git", "-C", repoAbs, "worktree", "prune"]);
      const wtProbe = probe(["git", "-C", repoAbs, "worktree", "list", "--porcelain", "-z"]);
      if (!wtProbe.ok) { incomplete.push(`git worktree ${worktreeCanonical || wt}: could not verify removal (${wtProbe.err || "worktree list failed"})`); outstandingGit.add("worktree"); }
      else {
        const registered = wtProbe.out.split("\0").filter((f) => f.startsWith("worktree ")).map((f) => f.slice("worktree ".length));
        if (worktreeCanonical && registered.includes(worktreeCanonical)) { incomplete.push(`git worktree ${worktreeCanonical}: still registered`); outstandingGit.add("worktree"); }
      }
      if (branch) {
        const branchDebt = deleteBranchAsCreated(probe, repoAbs, branch, plannedBase.oid);
        if (branchDebt.length) { incomplete.push(...branchDebt); outstandingGit.add("branch"); }
      }
    }
    // Any attempted spawn hook may have created state before a later hook (or
    // its own environment output) failed. Metadata is its receipt. If that
    // capability has no retire hook, OATS cannot prove the receipt was undone,
    // even when it was not the hook that ultimately failed.
    const attempted = new Set(hookRes.order || []);
    for (const cap of resolvedCfg.capabilities.filter((c) => attempted.has(c.id))) {
      if (cap?.hooks?.retire) continue;
      if (!hookRes.meta?.[cap.id]) continue;
      incomplete.push(`${cap.id}: its spawn hook reported state it created, but the capability declares no retire hook, so OATS cannot undo it`);
      outstandingHooks.add(cap.id);
    }
    try { preserveDirectory(); }
    catch (e) { return retainDirectory(e); }
    let note;
    if (outstandingHooks.size || outstandingGit.size) {
      // Preserve credentials and the original hook receipt until cleanup
      // succeeds. The harness is stopped; Git cleanup was independently safe.
      note = quarantineInstanceHome({
        home, instance, agent, soulDir: homeSoulTarget, soulId: preparedSoulId, incomplete,
        failed,
        outstandingHooks, outstandingGit, repoAbs, work, branch, resolvedCfg,
        hookMeta: hookRes.meta || {}, compensationMeta, launched: false,
        directoryHome: homeReal, recordRetirementBaseline: true,
      });
    } else {
      try { rmSync(home, { recursive: true, force: true }); } catch (e2) { incomplete.push(`instance home ${home}: ${e2.message}`); }
      if (existsSync(home) && !incomplete.some((m) => m.startsWith("instance home"))) incomplete.push(`instance home ${home}: still present`);
      note = incomplete.length ? ` — rollback INCOMPLETE, clean up manually: ${incomplete.join("; ")}` : " — spawn rolled back";
    }
    return { unconfirmed: incomplete.length > 0, note: `${note}${directoryRecoveries.length ? `; directory work preserved at ${directoryRecoveries.join(", ")}` : ""}` };
  };

  try {
    if (requiredFailures.length) {
      const detail = requiredFailures.map((f) => `  ${f.capability} ${f.event} ${f.contract === "environment" ? "environment contract" : "hook (declared required)"}: ${f.message}`).join("\n");
      const code = requiredFailures.some((f) => f.contract === "environment") ? "E_HOOK_ENVIRONMENT_CONTRACT" : "E_REQUIRED_HOOK_FAILED";
      // The spawn hooks that ran, in the worktree receipt's shape. A spawn hook keeps no log (`log: null`),
      // and nothing of its output is carried here.
      const hooks = (hookRes.order || []).map((id) => {
        const f = (hookRes.failures || []).find((x) => x.capability === id);
        const cap = resolvedCfg.capabilities.find((c) => c.id === id);
        return { capability: id, ok: !f, required: (cap?.requiredHooks || []).includes("spawn") || f?.contract === "environment", log: null, ...(f?.contract ? { contract: f.contract } : {}) };
      });
      throw Object.assign(oatsError(code, `a capability this soul activates could not configure itself:\n${detail}\n\nThe instance would have started with an invalid or missing capability configuration`), { details: { hooks } });
    }
    // #796: the `worktree` event, once, for the ./work this spawn created, after the spawn hooks
    // succeeded and inside this transaction (lib/worktree-hooks.mjs says how it runs). A killed
    // parent is recovered by `oats retire` from the in-progress marker written before the first hook.
    if (treeHooks.length) {
      const tree = worktreeCanonical || realpathSync(join(home, "work"));
      const cloneReal = realPathOrNearest(repoAbs);
      // The marker names this process by pid and start; one whose start cannot be read could not be told
      // apart from a dead one after a kill, so the spawn does not run its worktree hooks without it.
      if (!processStartToken(process.pid)) throw oatsError("E_SPAWN_FAILED", `this process's start time cannot be read, so a spawn killed while its worktree hooks ran could not be recovered safely; no worktree hook ran`);
      writeSpawnInProgressMarker({});
      treeGuard = signalGuard();
      const treeEnv = {
        OATS_TREE: tree, OATS_TREE_CLONE: cloneReal, OATS_TREE_REMOTE: originRemoteOf(cloneReal),
        OATS_TREE_MEMBER: o.prepared?.soulEntry?.repoKey && cloneOfMember(cloneReal, o.prepared.soulEntry.repoKey) ? o.prepared.soulEntry.repoKey : "",
        OATS_BRANCH: branch, OATS_TREE_BASE: plannedBase.ref, OATS_TREE_BASE_OID: plannedBase.oid, OATS_PURPOSE: "", OATS_TREE_ORIGIN: "spawn",
      };
      worktreeRun = yield () => runWorktreeHooks(treeHooks, {
        envFor: (cap) => lifecycleHookEnv("worktree", cap, { home, instance, agentName: agent.name, soulDir: homeSoulTarget, soulId: preparedSoulId, contextDir: repoAbs, workspaceDir: workspaceOf(root), rootDir: root, resolved: resolvedCfg, priorMeta: hookRes.meta || {}, extraEnv: treeEnv }),
        cwd: tree, home, purpose: "", guard: treeGuard,
        onStart: ({ pgid, hookStart }) => writeSpawnInProgressMarker({ hookPgid: pgid, hookStart }),
      });
      warnings.push(...worktreeRun.warnings);
      if (worktreeRun.interrupted) {
        throw Object.assign(oatsError("E_INTERRUPTED", `the spawn was interrupted by ${worktreeRun.interrupted} while its worktree hooks ran; the running hook's process group was ended`),
          { exitStatus: interruptExitStatus(worktreeRun.interrupted), details: { signal: worktreeRun.interrupted, hooks: worktreeRun.receipt } });
      }
      // A hook may itself remove or move the tree: the tree must still be this worktree.
      if (!treeStillThere(tree)) {
        const msg = `the tree ${tree} is no longer there (or no longer this worktree) after the worktree hooks ran`;
        if (treeHooks.some((h) => h.required)) worktreeRun.failures.push({ capability: "oats.kernel", event: "worktree", message: msg, required: true });
        else warnings.push(msg);
      }
      const logOf = (id) => worktreeRun.receipt.find((r) => r.capability === id)?.log;
      for (const f of worktreeRun.failures.filter((x) => !x.required)) warnings.push(`${f.capability} worktree hook failed (continuing): ${f.message}${logOf(f.capability) ? ` (log: ${logOf(f.capability)})` : ""}`);
      const treeFailures = worktreeRun.failures.filter((x) => x.required);
      if (treeFailures.length) {
        requiredFailures.push(...treeFailures);
        // The logs are in the home, which the rollback may remove: where they are is said after it (below).
        const detail = treeFailures.map((f) => `  ${f.capability} worktree ${f.contract === "environment" ? "environment contract" : "hook (declared required)"}: ${f.message}`).join("\n");
        throw Object.assign(oatsError(treeFailures.some((f) => f.contract === "environment") ? "E_HOOK_ENVIRONMENT_CONTRACT" : "E_REQUIRED_HOOK_FAILED", `a capability could not set up the new worktree:\n${detail}`), { details: { hooks: worktreeRun.receipt } });
      }
    }
    treeGuard?.restore();
    // Hooks have finished, but no TASK, launch recipe, successful scaffold, or
    // backend operation may be published until the owned roots are revalidated.
    if (work === "directory") assertDirectoryRoots(home, homeReal);
    {
      const owned = Object.keys(launchConfig?.env || {}).filter((n) => Object.hasOwn(hookRes.env, n));
      if (owned.length) {
        const owner = (n) => (hookRes.contributions || []).find((c) => (c.env || []).includes(n))?.capability || "a capability";
        throw oatsError("E_LAUNCH_ENV_CONFLICT", `${owned.map((n) => `${n} (set by ${owner(n)})`).join(", ")} cannot be overridden by launch configuration ${launchConfig.name}; change the capability's setting instead`);
      }
    }
    const briefLines = hookRes.briefs.length ? `\n${hookRes.briefs.join("\n")}` : "";
    // A checkout or attached tree may be on no branch OATS can name (#641): a detached HEAD. With a
    // branch the text is as it always was; only a missing one is said another way.
    const noBranch = "no branch that OATS can name, e.g. a detached HEAD";
    const workDesc = work === "worktree"
      ? `a dedicated git worktree of ${repoAbs} on branch "${branch}" — commit freely there`
      : work === "attached"
      ? `ATTACHED to another instance's work tree (${o.workDir}, ${branch ? `branch ${branch}` : noBranch}) — you share it with that instance; make your changes and commits focused, and never switch branches`
      : work === "directory"
      ? `an instance-owned execution directory — not a Git worktree or a link to ${repoAbs}; that path supplies configuration only`
      : work === "workspace"
      ? `the WHOLE WORKSPACE (${realpathSync(join(home, "work"))}) — every member repo is read-context; you coordinate, you do not edit member repos (see your work-mode briefing)`
      : `a symlink to the ${repoAbs} checkout — you share it; ${branch ? `work on the currently checked-out branch (${branch})` : `work on what is checked out (${noBranch})`} and do not switch branches without being asked`;
    writeFileSync(join(home, "TASK.md"), `# Instance briefing: ${instance}

You are instance "${instance}" of agent "${agent.name}".
- Home: ${home}
- Work tree: ./work — ${workDesc}
- Do all repository work inside ./work. Read ./work/AGENTS.md or ./work/CLAUDE.md first if present.${briefLines}${harness === "codex" ? "\n## Harness notification delivery\n\nNative Codex has no built-in messaging channel. Follow the explicit delivery briefing for this instance from your messaging capability, if present; it may arrange notification through this terminal. Shared channel instructions alone do not establish that delivery is configured. Without an instance delivery briefing, check your messaging capability's inbox and pending commands at task boundaries or when the operator asks; do not assume messages will wake this session.\n" : ""}
${task.trim() ? `\n## Task\n\n${task.trim()}\n` : "\nNo task was provided at spawn time — await instructions.\n"}`, { mode: 0o600 }); // human text: the owner's only
    // Feature instance-background: the home's record, beside its other files, so the spawn's rollback
    // (which removes the home) leaves nothing of it.
    if (background) writeInstanceBackground(home, true);

    // Launch command. Spawn IS session start: the recipe is persisted in
    // instance.json beside its rendering, which is executed in the instance's
    // tmux window. Capabilities contributed harness-specific arguments and
    // environment through their spawn hook; both are recorded with provenance.
    // The home's `oats` is this kernel, launched now or later (--no-launch).
    const shimTarget = writeKernelShim(home);
    const recipe = {
      version: LAUNCH_RECIPE_VERSION, harness,
      launchConfig: launchConfig?.name || null, launchConfigSource: launchConfig?.source || null, ...(launchConfig?.harnessDefault ? { launchConfigDefault: true } : {}),
      executable: bin, executableDeclared: executable.declared, executableResolvedFrom: executable.resolvedFrom,
      args: [...(launchConfig?.args || [])], env: { ...(launchConfig?.env || {}) },
      model: model || null, ...(yolo !== undefined ? { yolo } : {}),
      hooks: { launch: { ...hookRes.launch }, env: { ...hookRes.env }, contributions: hookRes.contributions || [] },
      prompt: LAUNCH_PROMPT, kernelBin: shimTarget,
    };
    if (triggerEventFile) recipe.env.OATS_TRIGGER_EVENT_FILE = triggerEventFile;
    // What this launch removes (removedLaunchEnv): the names the composed capabilities declare that
    // their spawn hooks' payload and the configuration leave out. Folder trust and the checks on the
    // pane the spawn gets read them as removed; the window command unsets them.
    const removedEnv = removedLaunchEnv({ declared: declaredLaunchEnv(resolvedCfg.capabilities), hooksEnv: hookRes.env, configEnv: recipe.env });
    // Folder trust, read on the pane this plan expects: the command is rendered from it. A launch
    // reads it again on the session it gets, and warns from that (below); a spawn that launches
    // nothing warns from this, and the warning says whose values were read.
    const folderTrustOn = (launchEnv) => launchFolderTrust({ harness, home, meta: { workspace: { deployment: o.prepared?.deployment } }, yolo, launch: launchEnv, configEnv: launchConfig?.env, launchConfig: launchConfig?.name });
    let folderTrust = folderTrustOn(launchEnvOn(expectedEnv.pane, removedEnv));
    if (!launch && folderTrust.warning) warnings.push(folderTrust.warning);
    let cmdline = renderLaunchRecipe(recipe, { home, instance, trustHome: folderTrust.trustHome });

    // Module skills as materialize landed them (flat, .agents/skills/<skill>/),
    // beside the soul's own: per-skill provenance `module:<cap>` (lead decision c3),
    // `from` = the home's module copy the skill was copied from.
    const moduleSkills = (materializeOutcome?.skills || []).map((row) => ({ name: row.name, source: `module:${row.module}`, from: join(home, row.from) }));
    const meta = {
      agent: agent.name, kind: agent.kind || "persistent", instance, home, soulDir: homeSoulTarget,
      repo: repoAbs, work, branch, ...(plannedBase ? { base: plannedBase } : {}), harness, model: model || undefined, modelFrom: modelFromOf(launchSelection.modelSource, { at: "spawn" }) ?? undefined,
      // Feature launch-preference: the layer that decided this launch, and the soul's own preference then.
      launchFrom: launchChoice.from, launchAt: launchChoice.at, launchDeclared: launchChoice.declared,
      ...(yolo !== undefined ? { yolo } : {}),
      parentInstance: parentInstance && parentInstance !== instance ? parentInstance : undefined,
      siblingInstance: siblingInstance && siblingInstance !== instance ? siblingInstance : undefined,
      relation: relation || undefined,
      relativeTo: relation ? relativeTo : undefined,
      spawnOrigin,
      spawnedBy,
      policy: { childSpawns: ownChildPolicy },
      ...(triggerEventFile ? { trigger: { id: o.triggerEvent.trigger, key: o.triggerEvent.key ?? null, source: o.triggerEvent.source, repo: o.triggerEvent.repo ?? null, number: o.triggerEvent.number ?? null, subject: o.triggerEvent.subject ?? null, url: o.triggerEvent.url ?? null, event: o.triggerEvent.event, headSha: o.triggerEvent.headSha ?? null, observedAt: o.triggerEvent.observedAt ?? null, eventFile: triggerEventFile,
        // A capability source's event carries its declared fields (a pull request's never does).
        ...(o.triggerEvent.fields && typeof o.triggerEvent.fields === "object" ? { fields: o.triggerEvent.fields } : {}) } } : {}),
      // K6c: a decision-bound spawn records what bound it, so a retry with the
      // same key replays this receipt instead of spawning again.
      // The FULL bound decision (placement + effective), exactly as the fence
      // compared it — a receipt echoes what it was bound to, not a subset.
      ...(o.expectDecision !== undefined ? { decision: buildDecision() } : {}),
      ...(o.idempotencyKey !== undefined ? { spawnIdempotencyKey: String(o.idempotencyKey), spawnCompleted: false } : {}),
      capabilityMeta: Object.keys(hookRes.meta).length ? hookRes.meta : undefined,
      dialogClaims: replacedDialogClaims(undefined, hookRes.dialogClaims),
      capabilities: resolvedCfg.capabilities.map((cap) => ({
        id: cap.id, layer: cap.layer, command: cap.command, origin: cap.origin, level: cap.level,
        settings: cap.settings, settingsOrigins: cap.settingsOrigins ?? {}, provenance: cap.provenance, skills: cap.skills || [],
        hooks: Object.keys(cap.hooks || {}), trusted: !!cap.trust?.trusted,
        ...(cap.environment?.length ? { environment: [...cap.environment] } : {}),
        ...(cap.environmentNamespaces?.length ? { environmentNamespaces: [...cap.environmentNamespaces] } : {}),
      })),
      skills: [...[...chosen].sort(([a], [b]) => a.localeCompare(b)).map(([name, v]) => ({ name, source: v.source })), ...moduleSkills.map(({ name, source }) => ({ name, source }))],
      instructions: composition.blocks.map((b) => ({ source: b.source, file: b.file })),
      // The auditable record of the curriculum: what the resolved composition
      // PROMISED, and what actually landed. Both are asserted equal before launch;
      // keeping both makes an instance's surface reviewable after the fact without
      // re-resolving config that may since have changed.
      composition: {
        expected: expectedResources.map((r) => ({ type: r.type, source: r.source, declared: r.declared, resolved: r.path, origin: r.origin, level: r.level, ...(r.deferred ? { deferred: r.deferred } : {}) })),
        materialized: {
          skills: [...materialized.map((m) => ({ name: m.name, source: m.source, from: m.from })), ...moduleSkills],
          instructions: composition.blocks.map((b) => ({ source: b.source, file: b.file })),
          // `filtered` records that the operator's settings entry narrows this
          // package's resources. A non-empty filter is a deliberate choice whose
          // glob semantics belong to the harness, so it is auditable here rather
          // than second-guessed at spawn.
          harnessPackages: recordedHarnessPackages(harnessPackages),
          // What this instance ACTUALLY sees beyond the OATS-composed set. Recorded
          // so the deviation from strict composition is auditable instead of
          // implied — the honest contract, not an aspiration.
          harnessPosture: harness === "claude"
            ? {
              oatsComposed: "skills via .claude/skills -> ../.agents/skills; instructions via CLAUDE.md -> AGENTS.md",
              ambient: ["user skills", "project and ancestor skills to the repository root", "user and project plugins", "user and project settings", "user and ancestor CLAUDE.md"],
              why: "founder ruling: Claude Code's own global and per-repo configuration stays enabled — it is powerful, and the operator decides. An all-OATS setup is the way to opt out.",
            }
            : harness === "codex" ? {
              oatsComposed: "skills via .agents/skills; instructions via AGENTS.md; task via initial prompt",
              ambient: ["user and ancestor instructions", "user, project, admin and system skills", "user and project configuration and MCP servers"],
              why: yolo ? "Codex keeps native configuration with approval prompts and sandbox disabled by the OATS yolo setting." : "Codex keeps the operator's native configuration and approval policy, including approval handling for work paths outside the home.",
            } : {
              oatsComposed: "skills via --skill <instance-home>/.agents/skills; instructions via --append-system-prompt",
              curtailed: ["user skills", "project and ancestor skills", "package skills", "ambient AGENTS.md/CLAUDE.md discovery", "ambient prompt templates"],
              ambient: ["globally configured pi extensions, and any resources they contribute"],
              why: "founder ruling: shared cross-agent pi extensions (web search, output formatting) stay available to every instance.",
            },
          canonicalSkillTree: join(home, ".agents", "skills"),
          skillAlias: { path: join(home, ".claude", "skills"), target: join("..", ".agents", "skills") },
        },
      },
      capabilityRuntime: resolvedCfg.capabilities.map((cap) => ({
        id: cap.id, layer: cap.layer, level: cap.level, settings: cap.settings, settingsOrigins: cap.settingsOrigins ?? {},
        hooks: cap.hooks, requiredHooks: cap.requiredHooks, environment: cap.environment, environmentNamespaces: cap.environmentNamespaces,
        missingRequires: cap.missingRequires, trust: cap.trust,
        executable: cap.executable,
      })),
      tmux: { session, window: instance },
      launch: recipe, command: cmdline, createdAt: new Date().toISOString(),
    };
    // Workspace model: materialize recorded modules/providers (and the module
    // digests) in instance.json before this metadata is assembled — carry them.
    if (o.prepared) {
      try { const prior = JSON.parse(readFileSync(join(home, "instance.json"), "utf8")); if (prior.modules) meta.modules = prior.modules; if (prior.providers) meta.providers = prior.providers; } catch { /* materialize wrote it; absent means nothing to carry */ }
      // M5/3a: the workspace's name and the deployment directory are recorded, so a home
      // answers them (inspect/operation run --home, OATS_WORKSPACE_NAME) without discovery.
      meta.workspace = { key: o.prepared.discovery?.key ?? null, name: o.prepared.discovery?.workspace?.name ?? null, deployment: o.prepared.deployment ?? null, commit: o.prepared.discovery?.commit ?? null, resolution: o.prepared.resolution.revision, standalone: o.prepared.discovery?.standalone === true, soul: { id: preparedSoulIdOf(o.prepared.soulEntry), repoKey: o.prepared.soulEntry.repoKey, commit: o.prepared.soulEntry.commit, ...(typeof o.prepared.soulEntry.package === "string" ? { name: o.prepared.soulEntry.name, qualifiedName: o.prepared.soulEntry.qualifiedName, package: { id: o.prepared.soulEntry.package, version: o.prepared.soulEntry.version, commit: o.prepared.soulEntry.commit, digest: o.prepared.soulEntry.digest, path: o.prepared.soulEntry.path } } : {}) }, layers: layerRows(o.prepared.resolution) };
      // Team model v2: the teams at spawn, exactly as the providers received them (OATS_TEAMS: mapped
      // rows only) and the default, recorded as EVIDENCE beside `providers` (never inside that
      // capability-keyed map). A home's hooks and operations get the LIVE set (liveTeams); this is
      // what they fall back to when the workspace cannot answer.
      meta.teams = envRows(o.prepared.resolution.teams ?? []);
      meta.defaultTeam = structuredClone(o.prepared.resolution.defaultTeam ?? null);
    }
    const spawnWarnings = warnings;
    // Feature instance-same-work: bound to the parent the home records, written before the launch so that
    // the instance's first status shows it; the home's removal on a rollback takes it with the rest.
    if (o.sameWork === true && meta.parentInstance) writeSameWork(home, meta.parentInstance);

    spawnTmux = meta.tmux;
    if (work === "directory") assertDirectoryRoots(home, homeReal);
    // The launch's one native start, prepared before anything is created; every render below reuses it.
    const nativeStart = launch ? prepareNativeStart(home, harness) : null;
    let unscoped = null; // the harness's agent-scope warning, an event once the launch is recorded
    if (launch) {
      // The session on the OATS server, then everything on the one socket that answered: the collision
      // check, the records, the window and (in compensateSpawn) its removal.
      const socket = ensureOatsTmuxSession(session, existsSync(root) ? root : workspaceOf(root), undefined, tmuxSessionPlan, undefined, spawnWarnings);
      // The environment this window's pane will actually start with, whoever created the session and
      // with whatever environment (a race lost to another creator, a session that overrides a name):
      // one read of it answers the three checks below, each of which reads it only when it has to.
      const pane = paneEnvironment(socket, session, undefined, home);
      const actualEnv = launchEnvOn(pane, removedEnv);
      // The harness looked up again on that PATH. Not there: refused, and the spawn is compensated.
      // Found elsewhere than the preflight found it: the launch runs that one.
      if (executable.lookup) {
        const actual = resolveLaunchExecutable({ harness, declared: launchConfig?.executable, declaringDir: launchConfig?.source, lookup: lookupFor(actualEnv) });
        if (!actual.path) throw executableNotOnPanePath(actual, { harness, config: launchConfig, from: launchChoice.from, at: launchChoice.at });
        const bad = checkLaunchExecutable(actual.path);
        if (bad) throw oatsError("E_LAUNCH_EXECUTABLE", `launch configuration ${launchConfig?.name || "(harness default)"}: ${bad}`);
        if (actual.path !== recipe.executable) {
          recipe.executable = actual.path;
          meta.command = cmdline = renderLaunchRecipe(recipe, { home, instance, trustHome: folderTrust.trustHome });
        }
      }
      // Whatever moved it (that lookup, a symlink changed under a declared path), and the same pathname
      // can be another program. An unattended spawn's answer often goes unread: the home keeps it too.
      const replaced = replacedExecutableWarning(harnessExecutableHanded.OATS_HARNESS_EXECUTABLE, recipe.executable);
      if (replaced) {
        spawnWarnings.push(replaced);
        appendEvent(home, { kind: "launch-warning", data: { message: replaced } });
        delete meta.dialogClaims;
      }
      // The package gate judged the pane this spawn expected (`probed`). When the pane it got differs
      // in a name the probe depends on, or the lookup above found the harness elsewhere there, the gate
      // judges again, on that one and with that program: a pane that cannot be
      // read (E_RUNTIME_ENDPOINT_UNKNOWN) or whose account lacks a package
      // (E_HARNESS_RESOURCE_MISSING) is refused, and the spawn is compensated as for the lookup
      // above. Equal, as it is unless another creator won the server's creation: nothing more is probed.
      if (probed) {
        const judged = probed, actual = probeEnvOn(actualEnv)();
        if (recipe.executable !== bin || probeNames(harness).some((name) => judged[name] !== actual[name])) {
          meta.composition.materialized.harnessPackages = recordedHarnessPackages(verifyHarnessPackages(harness, resolvedCfg, repoAbs, { ...(launchConfig?.executable ? { bin: recipe.executable } : {}), env: probeEnvironment(() => actual, actualEnv, harness, recipe.executable) }));
        }
      }
      // Folder trust on the same pane: the warning is about the file this launch reads, and codex's
      // trust of the home follows that file.
      const actualTrust = folderTrustOn(actualEnv);
      if (actualTrust.warning) spawnWarnings.push(actualTrust.warning);
      if (actualTrust.trustHome !== folderTrust.trustHome) {
        meta.command = cmdline = renderLaunchRecipe(recipe, { home, instance, trustHome: actualTrust.trustHome });
      }
      folderTrust = actualTrust;
      let present;
      try { present = tmuxOn(socket, ["list-windows", "-t", `=${session}`, "-F", "#{window_name}"]).split("\n").filter(Boolean); }
      catch (e) { throw new Error(`could not list the windows of tmux session ${session} on ${socket}: ${tmuxFailure(e, "tmux list-windows failed")}`); }
      if (present.includes(instance)) throw new Error(`tmux window "${instance}" already exists in session ${session}`);
      meta.tmux.socket = socket;
      meta.launched = true;
      promptStartId = randomUUID();
      // The spawn's launch is the home's first start: its id names it in the exit marker and a stop's
      // receipt (lib/session-end.mjs), as a start's does.
      meta.startId = promptStartId;
      const engaged = devChannelEngaged(harness, cmdline);
      if (engaged) warnings.push(DEV_CHANNEL_STATEMENT);
      else meta.launchPrompts = notEngaged(promptStartId);
      // Commit the final child metadata and its independent byte authority before
      // the managed harness can write. No child-home transition follows launch.
      writeHomeRecord(home, meta);
      writeRetirementBaseline(home, join(home, "work"), work, resolvedCfg.capabilities, { launched: true, tmux: meta.tmux });
      clearSpawnInProgressMarker();
      // The first start's launch environment (lib/start-env.mjs), after the baseline, as a start records its own.
      recordStartEnv(home, promptStartId, fromEnvNames(recipe.env), process.env);
      // Wrap the command so the window drops into an interactive shell when the
      // agent exits (e.g. Ctrl-C) instead of tmux killing the window.
      const refs = launchEnvRefs(recipe, process.env);
      // On the same pane, for the command it runs: whether the harness runs in a scope of its own.
      const scope = agentScopeOn(cmdline, { pane, removed: removedEnv, refs });
      if (scope.warning) spawnWarnings.push(unscoped = scope.warning);
      // The exit marker records how this launch's harness ended (lib/session-end.mjs), as a start's does.
      const windowCmd = paneCommand(exitMarked(nativeRecordCommand(cmdline, home, harness, { start: nativeStart, scope: scope.wrapper }), promptStartId, join(home, START_EXITED_FILE)), removedEnv);
      const paneEnvFlags = refs.flatMap((r) => ["-e", `${r.name}=${r.value}`]);
      const launchFailed = (step, refused, e) => oatsError("E_SPAWN_LAUNCH_FAILED", `tmux ${step} failed for ${instance} (${e.code === "ENOENT" ? "tmux unavailable" : refused}); the command line and tmux's output are withheld from this message because they can carry reference values; run tmux -S ${shellWord(socket)} list-windows -t ${shellWord(session)} to inspect`);
      // Only a launch that engages the confirmation needs lineage committed before
      // dispatch: its uncertain input outcome retains the new process and parent
      // link. Other launches keep their established post-launch commit/rollback.
      if (engaged) commitParentLineage();
      const controller = engaged ? promptController(home, promptStartId, cmdline, undefined, createdHomeIdentity) : null;
      windowMayExist = true;
      promptDispatched = !!controller;
      let windowId;

      try { windowId = tmuxOn(socket, ["new-window", "-P", "-F", controller ? LAUNCH_PANE_FORMAT : "#{window_id}", "-t", `=${session}:`, "-n", instance, "-c", home, ...paneEnvFlags, windowCmd, ...markAgentPane(instance)], undefined, oatsWindowEnvironment()).trim(); }
      catch (e) { throw launchFailed("new-window", "the window command was refused", e); }
      if (controller) { promptTarget = { ...meta.tmux, ...launchPaneTarget(socket, windowId) }; windowId = promptTarget.windowId; }
      try { prepareAgentWindow(socket, windowId); }
      catch (e) { throw launchFailed("set-option", "the new window's options were refused", e); }
      if (controller) {
        promptResult = controller.observeNew(promptTarget);
        if (promptResult.status === "flag-ignored") warnings.splice(0, warnings.length, ...flagIgnoredWarnings(warnings));
        meta.launchPrompts = promptResult.status === "flag-ignored" ? channelsUnavailable(promptStartId, promptResult) : promptResult;
        meta.launchPromptTarget = promptTarget;
        meta.parentLineageCommitted = parentLineageCommitted;
        meta.launched = promptLaunched(promptResult.status);
        assertLaunchHome(home, createdHomeIdentity);
        writeHomeRecord(home, meta);
        if (!meta.launched) throw retainedPromptError(home, instance, promptTarget, parentLineageCommitted, promptResult);
      }
    } else {
      meta.launched = false;
      writeHomeRecord(home, meta);
      writeRetirementBaseline(home, join(home, "work"), work, resolvedCfg.capabilities, { launched: false, tmux: meta.tmux });
      clearSpawnInProgressMarker();
    }

    // Ordinary launches and scaffolds commit here; launches that engage the
    // development-channel confirmation already committed before dispatch, so
    // retained prompt failures keep their lineage.
    commitParentLineage();

    appendEvent(home, { kind: "spawned", data: { agent: agent.name, work, branch: branch ?? null, harness, model: model || null, parentInstance: meta.parentInstance ?? null, relation: relation ?? null, spawnedBy, launched: launch, hooks: hookReceipt(hookRes), ...(worktreeRun ? { worktreeHooks: worktreeRun.receipt } : {}) } });
    if (launch) appendEvent(home, { kind: "launched", data: { harness, backend, launchConfig: launchConfig?.name ?? null } });
    if (unscoped) appendEvent(home, { kind: "launch-warning", data: { message: unscoped } });
    if (o.idempotencyKey !== undefined) {
      // Only now is the spawn a finished receipt a same-key retry may replay.
      meta.spawnCompleted = true;
      writeHomeRecord(home, meta); // a kernel-owned field: the baseline fingerprint ignores it
    }
    return deliver({ ...meta, background, ...(backgroundFrom ? { backgroundFrom } : {}), ...(o.expectDecision !== undefined ? { replayed: false } : {}), ...(worktreeRun ? { worktreeHooks: worktreeRun.receipt } : {}), launch: redactLaunchRecipe(recipe), command: redactLaunchCommand(cmdline), attach: launch ? `tmux -S ${shellWord(meta.tmux.socket)} attach -t ${shellWord(session)}` : `oats session attach --home ${shellWord(home)}`, warnings: spawnWarnings.length ? spawnWarnings : undefined, ...(naming ? { naming } : {}) });
  } catch (error) {
    if (promptDispatched) {
      // Once a launch that engages the confirmation was dispatched, uncertainty retains all effects.
      // The independent baseline remains launched:true: metadata is not proof of quiescence.
      let result = promptResult?.status === "blocked" || promptResult?.status === "incomplete" ? promptResult : incompleteLaunchPrompt(home, promptStartId, promptTarget ?? spawnTmux, "launch prompt dispatch or recording incomplete", promptResult, createdHomeIdentity);
      try {
        assertLaunchHome(home, createdHomeIdentity);
        const retained = JSON.parse(readFileSync(join(home, "instance.json"), "utf8"));
        retained.launched = false; retained.launchPrompts = result;
        retained.launchPromptTarget = promptTarget ?? spawnTmux;
        retained.parentLineageCommitted = parentLineageCommitted;
        retained.spawnCompleted = false;
        writeHomeRecord(home, retained);
      } catch { result = incompleteLaunchPrompt(home, promptStartId, promptTarget ?? spawnTmux, "launch prompt metadata recording incomplete", result, createdHomeIdentity); }
      throw retainedPromptError(home, instance, promptTarget ?? spawnTmux, parentLineageCommitted, result);
    }
    if (parentLineageCommitted) {
      try {
        if (readFileSync(anchorMetaPath, "utf8") !== anchorWritten) throw new Error("parent anchor changed; cannot restore lineage safely");
        writeHomeRecord(anchorHome, JSON.parse(anchorOriginal));
        parentLineageCommitted = false;
      } catch (anchorError) {
        // A concurrent anchor edit must survive, but cannot prevent cleanup of
        // this spawn's independent window, hooks and scaffold.
        error.message += ` — rollback INCOMPLETE: parent lineage could not be restored: ${anchorError.message}`;
        unconfirmedSpawn(error);
      }
    }
    try {
      const compensation = compensateSpawn();
      error.message += compensation.note;
      if (compensation.unconfirmed) unconfirmedSpawn(error);
    } catch (cleanupError) {
      // An interrupted compensation pass cannot establish that effects ended.
      error.message += ` — rollback INCOMPLETE: cleanup could not be completed: ${cleanupError.message}`;
      unconfirmedSpawn(error);
    } finally {
      // Interrupts were held through the rollback of a spawn that ran worktree hooks (#796).
      treeGuard?.restore();
    }
    // #796: the worktree hooks' logs are in the home. A rollback that removed it removed them: no
    // answer names a path that is gone (each entry's `log` is null); a retained home keeps them.
    if (worktreeRun && error?.details?.hooks === worktreeRun.receipt) {
      if (existsSync(home)) {
        const logs = error.details.hooks.map((h) => h.log).filter(Boolean);
        if (logs.length) error.message += `; the worktree hooks' logs are kept in the retained home: ${logs.join(", ")}`;
      } else {
        error.details = { ...error.details, hooks: error.details.hooks.map((h) => ({ ...h, log: null })) };
        error.message += "; the worktree hooks' output was logged in the instance home, which the rollback removed: run the setup in an existing instance with `oats worktree add` to see it";
      }
    }
    throw error;
  }
}

export function findInstanceHome(root, name) {
  const all = findInstanceHomes(root, name);
  return all.length ? all[0] : undefined;
}


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


function assertDirectoryHome(home, canonicalHome = realPathOrNearest(home)) {
  let st;
  try { st = lstatSync(home); } catch { /* fail closed below */ }
  if (!st?.isDirectory() || st.isSymbolicLink() || realpathSync(home) !== canonicalHome) {
    throw oatsError("E_WORK_INSPECTION_FAILED", `directory instance home was removed or exchanged: ${home}; restore the owned home before retrying cleanup`);
  }
}

/** A directory of the home (instanceWork) is still the real directory the retire read it as: a
 *  retire hook, or anything else, may have exchanged it since. */
function assertHomeDirectory(work) {
  let st;
  try { st = lstatSync(work); } catch { /* fail closed below */ }
  if (!st?.isDirectory() || st.isSymbolicLink()) {
    throw oatsError("E_WORK_INSPECTION_FAILED", `${work} was a real directory when this retire first read it and is not one now (it is missing, a link or another filesystem type), so what the retire would copy is not what it read; restore it, or remove what is there, before retrying`);
  }
}

/** A link at work/ (instanceWork) is still a link, or gone: a retire hook, or anything else, may
 *  have put a directory or a file there since. The home's copy leaves `work/` out and the home's
 *  removal takes whatever is there, so what replaced the link would be removed uncopied (#973).
 *  The refusal says what was there and what is there now, and how it ends, by what is there now.
 *  A directory: the next retire reads the home as it is now, and the plan shows what it would do.
 *  It promises no copy: that depends on the record as it is then and on the spawn's receipt (a
 *  directory of the home is copied and removed with it; an own tree's directory has no admin entry
 *  and is kept after the hooks ran, until a person moves it: #1019). A file, or an entry that is
 *  none of the three: no retire removes it (under a record that says `worktree` it is kept after
 *  the hooks ran, under another record the inspection refuses) and the plan does not say so, so
 *  the refusal names the step and not the plan. An entry that cannot be read: nothing is known of
 *  it but that the next retire reads it again. */
function assertStillLink(work, instance) {
  let st;
  try { st = lstatSync(work); } catch (e) { if (e?.code === "ENOENT") return; /* else fail closed below */ }
  if (!st?.isSymbolicLink()) {
    const now = !st ? "an entry that cannot be read" : st.isDirectory() ? "a directory" : st.isFile() ? "a file" : "an entry that is neither a link, a directory nor a file";
    const next = !st ? "The retire reads it again when it is run again"
      : st.isDirectory() ? `\`oats retire ${instance} --plan\` shows what a retire would do with what is there now, and running the retire again does that`
      : "No retire removes it: move it out of the home or remove it, then run the retire again";
    throw oatsError("E_WORK_INSPECTION_FAILED", `${work} was a link when this retire first read the home, and ${now} is there now. The home is kept and nothing of it was removed. ${next}`);
  }
}

function assertDirectoryRoots(home, canonicalHome) {
  assertDirectoryHome(home, canonicalHome);
  const work = join(home, "work");
  let st;
  try { st = lstatSync(work); } catch { /* fail closed below */ }
  if (!st?.isDirectory() || st.isSymbolicLink()) {
    throw oatsError("E_WORK_INSPECTION_FAILED", `directory work must remain an owned directory, not missing, a link or another filesystem type: ${work}; restore the owned work root before retrying cleanup`);
  }
}

function directoryIdentity(path) {
  const st = lstatSync(path);
  return { dev: st.dev, ino: st.ino };
}
/** A directory-mode root as the spawn baseline records it: its identity and its birth time,
 *  a decimal string of ns (JSON holds no BigInt), which sameDirectory reads on darwin. */
function directoryRootIdentity(path) {
  const st = lstatSync(path, { bigint: true });
  return { dev: Number(st.dev), ino: Number(st.ino), birthtimeNs: String(st.birthtimeNs) };
}

// Read independently of mutable instance bytes, BEFORE realpath(home), hooks,
// lock creation or backend observation. A metadata mode edit cannot disable it.
function sessionDirectoryGuard(home) {
  let baseline;
  try { baseline = JSON.parse(readFileSync(findRetirementBaseline(home), "utf8")); }
  catch (e) { if (e.code === "ENOENT") return () => {}; throw oatsError("E_RUNTIME_ENDPOINT_UNKNOWN", "independent session receipt is unreadable"); }
  const expected = join(realPathOrNearest(dirname(home)), basename(home));
  const check = () => {
    if (baseline.directoryWork === true) {
      if (baseline.version !== RETIRE_BASELINE_VERSION || !receiptRecordsHome(baseline, receiptHomeIdentity(home))) throw oatsError("E_WORK_INSPECTION_FAILED", "invalid independent directory home authority");
      assertDirectoryRoots(home, expected);
      for (const [name, path] of [["home", home], ["work", join(home, "work")]]) {
        if (!sameDirectory(baseline.directoryRoots?.[name], directoryRootIdentity(path))) throw oatsError("E_WORK_INSPECTION_FAILED", `directory ${name} was exchanged; restore the owned root before retrying start`);
      }
    }
    let meta;
    try { meta = JSON.parse(readFileSync(join(home, "instance.json"), "utf8")); } catch { return; } // ordinary receipt validation reports this
    if ((meta.work === "directory") !== (baseline.directoryWork === true)) throw oatsError("E_WORK_INSPECTION_FAILED", "directory work mode disagrees with independent session authority");
    if (baseline.executionBinding && (meta.incarnationId !== baseline.incarnationId || canonicalJson(meta.executionBinding ?? null) !== canonicalJson(baseline.executionBinding))) throw oatsError("E_RUNTIME_AUTHORITY_MISMATCH", "captured native baseline differs from current incarnation binding");
  };
  check();
  return check;
}

/** The commit a worktree spawn of a workspace soul observed its repository at, when `repoAbs` is a clone of
 *  that repository: { key, oid, remote } (the clone's remote that names it), else null (a package soul, or a
 *  --repo that is not a clone of the soul's repository: the clone's HEAD stays the base). */
function observedSoulBase(prepared, repoAbs) {
  const entry = prepared?.soulEntry;
  if (!entry || typeof entry.package === "string" || typeof entry.repoKey !== "string") return null;
  const oid = entry.memberCommit ?? entry.commit;
  if (typeof oid !== "string" || !/^[0-9a-f]{40,64}$/.test(oid)) return null;
  const remote = cloneRemoteFor(repoAbs, entry.repoKey);
  return remote ? { key: entry.repoKey, oid, remote } : null;
}

/** Make the observed base present in the clone: fetched by id from the remote that names the soul's
 *  repository, never prompting (remote.mjs's git environment), and touching no branch, remote-tracking ref,
 *  FETCH_HEAD or work tree of the clone. */
function fetchObservedBase(repoAbs, { key, oid, remote }) {
  const env = gitEnv();
  const present = () => spawnSync("git", ["-C", repoAbs, "cat-file", "-e", `${oid}^{commit}`], { stdio: "ignore", env, timeout: GIT_TIMEOUT_MS }).status === 0;
  if (present()) return;
  const r = spawnSync("git", ["-C", repoAbs, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--end-of-options", remote, oid],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env, timeout: GIT_FETCH_TIMEOUT_MS });
  if (r.status === 0 && present()) return;
  const lines = String(r.stderr || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const why = r.error?.code === "ETIMEDOUT" ? "timeout" : (lines.find((l) => /^(fatal|error):/.test(l)) ?? lines[0] ?? `git fetch exited ${r.status ?? r.signal}`);
  // A server that only serves advertised refs (protocol v0 without allowAnySHA1InWant) refuses a commit its
  // branches have moved past, and the fetch by hand fails the same way: --base is then the way on.
  throw Object.assign(oatsError("E_REMOTE_UNREADABLE", `cannot fetch commit ${oid.slice(0, 12)} of ${key} into the clone ${repoAbs} from its remote ${remote} (${why}); the instance branch starts at the commit this spawn observed, never at the clone's own branch — fetch it (git -C ${shq(repoAbs)} fetch --end-of-options ${shq(remote)} ${oid}) or name a start point with --base; nothing was created`),
    { details: { repo: repoAbs, repoKey: key, commit: oid, remote } });
}

/** Whether `clone` is a clone of the member `key`, read from its local remotes only (never the network):
 *  OATS_TREE_MEMBER names a member only when this holds. */
export function cloneOfMember(clone, key) {
  try { verifyMemberClone(clone, key); return true; } catch { return false; }
}

/** A failed spawn's compare-and-delete of the branch it created at `oid`: `git update-ref -d` refuses
 *  atomically if the tip moved (something was committed there), and the branch is then kept. `run`
 *  answers { ok, out, status, err }. → what is still owed, as messages ([] when the branch is gone). */
function deleteBranchAsCreated(run, repoAbs, branch, oid) {
  const del = run(["git", "-C", repoAbs, "update-ref", "-d", `refs/heads/${branch}`, oid]);
  const ref = run(["git", "-C", repoAbs, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (ref.ok && ref.out.trim() !== oid) return [`git branch ${branch}: kept; its tip moved from ${oid.slice(0, 12)}, where this spawn created it`];
  if (ref.ok) return [`git branch ${branch}: still exists${del.ok ? "" : ` (deletion failed: ${del.err || `exit ${del.status}`})`}`];
  if (ref.status !== 1 || ref.err) return [`git branch ${branch}: could not verify deletion (${ref.err || `exit ${ref.status}`})`];
  return [];
}
/** Retain the home and its cleanup receipt when spawn compensation or retirement
 * cannot finish. Keeping the original credentials makes cleanup retryable. */
/** The quarantine marker (`.oats-rollback-incomplete.json`) a rollback that cannot finish leaves:
 *  the cleanup descriptor a retry consumes (usableCleanupDescriptor). One builder for the
 *  rollback below and for a spawn's in-progress marker (#796), which adds `inProgress`. */
function buildQuarantineMarker({ instance, agent, soulDir, soulId, incomplete, failed, outstandingHooks, outstandingGit, repoAbs, work, branch, resolvedCfg, hookMeta, compensationMeta, launched, tmux, reason, directoryPreservation = false, orphanedWork = false }) {
  return {
      // `reason` is optional and DEFAULTS to the spawn wording, so every existing
      // caller is byte-identical; only a caller that supplies one differs. The
      // quarantine shape is now reached from two events and a fixed "spawn"
      // string mislabelled the retire one (reviewer nit on 5c8b724).
      instance, agent: agent.name, reason: reason || "spawn rolled back and compensation did not complete",
      // Capability/hook names and cleanup diagnostics only — never hook output.
      failed, incomplete, retainedFor: "credentials/metadata needed to retry cleanup",
      // What the failed compensation reported, kept OUT of the cleanup
      // descriptor so it can never displace the spawn metadata a retry needs.
      ...(compensationMeta && Object.keys(compensationMeta).length ? { compensationReported: compensationMeta } : {}),
      cleanup: {
        version: QUARANTINE_CLEANUP_VERSION,
        repo: repoAbs, work, branch, launched, tmux,
        // The soul the spawn's hooks saw (its per-commit directory and stable id):
        // a retry must hand the retire hook the same soul, and a quarantined home's
        // instance.json may be only the pre-hook stub, which records neither.
        ...(typeof soulDir === "string" && soulDir ? { soulDir } : {}),
        ...(typeof soulId === "string" && soulId ? { soulId } : {}),
        outstanding: { hooks: [...outstandingHooks], git: [...outstandingGit], ...(directoryPreservation ? { directory: true } : {}), ...(orphanedWork ? { orphanedWork: true } : {}) },
        capabilityRuntime: (resolvedCfg.capabilities || []).map((cap) => ({
          id: cap.id, layer: cap.layer, level: cap.level, settings: cap.settings, settingsOrigins: cap.settingsOrigins ?? {},
          hooks: cap.hooks, requiredHooks: cap.requiredHooks, environment: cap.environment, environmentNamespaces: cap.environmentNamespaces,
          missingRequires: cap.missingRequires,
          trust: cap.trust, executable: cap.executable,
        })),
        capabilityMeta: hookMeta || {},
      },
      createdAt: new Date().toISOString(),
  };
}
/** Write a quarantine marker by rename, so a marker that replaces another (a spawn's
 *  compensation over its in-progress marker) never leaves two files or a moment with none.
 *  `extra` adds top-level fields (`inProgress`). */
function writeQuarantineMarker(home, marker, extra = {}, mode) {
  writeJsonAtomic(join(home, ".oats-rollback-incomplete.json"), { ...marker, ...extra }, mode);
}
function quarantineInstanceHome({ home, instance, agent, soulDir, soulId, incomplete, failed, outstandingHooks, outstandingGit, repoAbs, work, branch, resolvedCfg, hookMeta, compensationMeta, launched, tmux, recordRetirementBaseline = false, reason, directoryPreservation = false, orphanedWork = false, directoryHome = realPathOrNearest(home) }) {
  const marker = buildQuarantineMarker({ instance, agent, soulDir, soulId, incomplete, failed, outstandingHooks, outstandingGit, repoAbs, work, branch, resolvedCfg, hookMeta, compensationMeta, launched, tmux, reason, directoryPreservation, orphanedWork });
  try {
    if (work === "directory") {
      assertDirectoryHome(home, directoryHome);
      writeQuarantineMarker(home, marker, {}, 0o600);
    } else writeQuarantineMarker(home, marker);
  } catch {
    if (work === "directory") {
      // Never write through a substituted home (even its metadata paths).
      // The original parent is outside the disposable home; no recovery copy is
      // needed to retain the frozen hook inputs and the cleanup obligations.
      try {
        const path = directoryRollbackPath(directoryHome);
        if (realpathSync(dirname(path)) !== dirname(path)) throw new Error("directory cleanup parent was redirected; refusing to write through it");
        writeJsonAtomic(path, marker, 0o600);
        incomplete.push(`cleanup descriptor retained at ${path}; restore the home before retrying`);
      } catch (fallbackError) { incomplete.push(`cleanup descriptor could not be stored: ${fallbackError.message}`); }
    }
  }
  if (recordRetirementBaseline) {
    try {
      if (work === "directory") assertDirectoryRoots(home, directoryHome);
      writeRetirementBaseline(home, join(home, "work"), work, resolvedCfg.capabilities || [], { launched: launched === true, tmux });
    } catch (e) {
      incomplete.push(`independent retirement authority: ${e.message}`);
    }
  }
  return ` — rollback INCOMPLETE. The instance home is RETAINED at ${home} because it holds the state needed to finish cleanup; it is not a live instance. Retry with \`oats retire ${instance}\`, then remove it once cleanup succeeds. Outstanding: ${incomplete.join("; ")}`;
}

function nonEmptyString(v) { return typeof v === "string" && !!v.trim(); }
function usableCleanupDescriptor(marker) {
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

/** The version of the stored digests a spawn baseline is written with (fingerprintTrees,
 *  generatedWorkDigest); a baseline without `digestVersion` holds the legacy ones, 1. */
const BASELINE_DIGEST_VERSION = 2;
/** The version of a baseline's stored digests (`homeFingerprint`, `generatedWorkFingerprint`):
 *  1 when it has no `digestVersion` (or there is no baseline), 2 when it says 2, and undefined for
 *  any other value, which no digest this kernel takes matches. It is never inferred. */
function baselineDigestVersion(baseline) {
  if (!baseline || !Object.hasOwn(baseline, "digestVersion")) return 1;
  return baseline.digestVersion === BASELINE_DIGEST_VERSION ? BASELINE_DIGEST_VERSION : undefined;
}

/** Where retire writes the recovery copies of the homes in the instances directory `instances`. */
export function retirementRecoveryRoot(instances) {
  return join(instancesRetirementRoot(instances), "recovery");
}







/** git's output for a large tree (status with untracked and ignored files,
 *  the index listing, a large blob) easily exceeds Node's 1 MiB default child
 *  buffer; the spawn then dies with ENOBUFS and retirement reports the
 *  recovery as unverifiable (cjr, ~9500 tracked long paths). Every git call
 *  on the retirement path gets this bound instead. It raises the practical
 *  limit, it does not remove it: a single blob over 512 MiB would still fail,
 *  loudly, and streaming is deliberately not attempted in this change. */
const GIT_MAX_BUFFER = 512 * 1024 * 1024;

/** How the retire runs Git on the instance's work, its repository, a
 *  repository under the work and a recovery clone (awebai/oats#662, #679):
 *  argv only, no shell; optional locks off (`--no-optional-locks` and
 *  GIT_OPTIONAL_LOCKS=0), so a status never refreshes, and so never rewrites,
 *  the index it inspects; no helper that a repository's own configuration
 *  names can run (fsmonitor, hooks, an external diff), nor any command a
 *  fetch would run (GIT_NO_LAZY_FETCH=1: an object a promisor repository
 *  lacks is a failed read, never fetched through a remote, helper, ssh
 *  command or credential helper its configuration names; Git before 2.44
 *  ignores the variable); and nothing of the caller's environment redirects
 *  what is read. Git's own list of
 *  repository-local variables (`git rev-parse --local-env-vars`: GIT_DIR,
 *  GIT_WORK_TREE, GIT_INDEX_FILE, GIT_COMMON_DIR, the object directories,
 *  GIT_CONFIG and GIT_CONFIG_PARAMETERS, …) and the GIT_CONFIG_KEY_<n> and
 *  GIT_CONFIG_VALUE_<n> pairs are left out. `env` adds variables after that:
 *  a read that names its own GIT_INDEX_FILE keeps it.
 *  The operator's global and system configuration stay read, unlike
 *  lib/instance-git.mjs's READ_ONLY_GIT with gitEnv(): the spawn baseline was
 *  taken under them, and without them a status reads differently (a global
 *  core.excludesFile, core.autocrlf, a filter), which would add a copy
 *  attempt to every existing instance's retire. These flags leave a status as
 *  it was. They are the operator's own; what the retire guards against is
 *  configuration the retired agent could write.
 *  Known limit: a filter driver that the repository's configuration names and
 *  its .gitattributes select can still run during `git status`; turning it
 *  off would change what status reports. */
const RETIRE_GIT_FLAGS = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.external="];
const RETIRE_GIT_DROPPED_ENV = new Set(["GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_DEFAULT_REF_FORMAT", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE", "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX", "GIT_SHALLOW_FILE", "GIT_COMMON_DIR"]);
function retireGitEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!RETIRE_GIT_DROPPED_ENV.has(key) && !/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) out[key] = value;
  }
  return { ...out, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", ...env };
}
/** One retire Git command in `repo` (`-C`; null for none, as for a clone) →
 *  its stdout (a Buffer, or text with `encoding`); throws what execFileSync
 *  throws. */
function retireGit(repo, args, { env, input, encoding } = {}) {
  return execFileSync("git", [...RETIRE_GIT_FLAGS, ...(repo === null ? [] : ["-C", repo]), ...args],
    { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], input, encoding, maxBuffer: GIT_MAX_BUFFER, shell: false, env: retireGitEnv(env) });
}
/** retireGit that never throws → spawnSync's result, for a caller that reads the exit status. */
function retireGitProbe(repo, args, { encoding } = {}) {
  return spawnSync("git", [...RETIRE_GIT_FLAGS, "-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"], encoding, maxBuffer: GIT_MAX_BUFFER, shell: false, env: retireGitEnv() });
}

/** Kernel-owned receipts the kernel itself appends to a home after the spawn
 *  baseline (events log, stop/restart receipts). They are evidence about the
 *  instance, not the instance's work, so the stored digest a spawn baseline is
 *  compared with passes over them — otherwise every stop or event write would
 *  read as "changed home bytes". The home copy carries them, so the exact
 *  digest, which says whether the retire hooks moved the home, holds them.
 *  A new kernel-written top-level home entry, whether or not it belongs here,
 *  MUST be added in the same change to the names a capability may not declare
 *  as its own (`retirement.disposable.home`: KERNEL_HOME_NAMES and
 *  KERNEL_HOME_NAME_PREFIXES in lib/capability-contract.mjs, and the schema). */
// `.oats-color.json` (feature instance-color) and `.oats-background.json` (feature instance-background) are
// presentation anyone may change at any time: never work.
// `.oats-same-work.json` (feature instance-same-work) is kernel presentation of the same kind.
// `.oats-start-exited` (lib/session-end.mjs) is the window's record of how the harness ended: every
// launched home whose harness ever ended holds it.
// `.oats-start-env.json` and its key (lib/start-env.mjs) are written at every start that renders a
// recipe, after the spawn's baseline: every launched home holds them.
const KERNEL_HOME_RECEIPTS = new Set([".oats-events.jsonl", ".oats-stop.json", ".oats-stop-receipt.json", ".oats-restart.json", ".oats-color.json", ".oats-background.json", SAME_WORK_FILE, START_EXITED_FILE, START_ENV_FILE, START_ENV_KEY_FILE]);
// `instance.json.tmp-<pid>` is what a process killed between the two steps of writeJsonAtomic leaves
// of the record: not a hidden name, so a capability cannot declare it (disposableHomeRootProblem).
const KERNEL_HOME_RECEIPT_PATTERNS = [/^\.oats-stop-receipt\..+\.json$/, /^\.oats-agents-md\..+\.previous$/, /^instance\.json\.tmp-\d+$/, START_ENV_TMP];
/** Harness project settings in the home are configuration, not work: the
 *  home's `.claude/` is harness layout the kernel already shapes (the skills
 *  alias), and capabilities keep their own entries current in its
 *  settings.json at every launch. The stored digest passes over exactly that
 *  path, home-relative; the exact digest holds it, as the home copy does. */
const HARNESS_HOME_SETTINGS = new Set([join(".claude", "settings.json")]);
/** Kernel state written under `.oats/` after the spawn baseline (#796): the extra
 *  trees' records (`oats worktree add|remove`) and the `worktree` hooks' logs.
 *  Receipts, not work: the stored digest passes over them as it does over the
 *  kernel's top-level receipts; the exact digest and the home copy hold them.
 *  They live under `.oats`, which a capability may not declare as its own. */
const KERNEL_HOME_STATE_DIRS = new Set([join(".oats", "trees"), join(".oats", "logs")]);
/** The refusal for an entry that is not a file, a directory or a symbolic link
 *  (a socket, a FIFO, a device): it has no bytes to read or to copy. One
 *  sentence for every caller of fingerprintTree, at spawn and at retire, so it
 *  names neither. It does not say "remove": the entry may be a live endpoint. */
const unsupportedEntry = (path) => oatsError("E_WORK_INSPECTION_FAILED", `${path} has an unsupported filesystem type: it is not a file, a directory or a symbolic link, so it cannot be read or copied. Safely stop the process or resource that owns it, or move the entry elsewhere, before retrying`);
const PATH_SEPARATOR_BYTES = Buffer.from(sep);
const GIT_NAME = Buffer.from(".git");
/** The digests of a tree, from one walk that reads each file once → { stored,
 *  exact }; each only when asked for (`stored` by default).
 *
 *  Both hash, for each entry in order, its path under the root, its
 *  permission bits, its kind, and a file's bytes or a link's target. Entry
 *  names and link targets are read and hashed as bytes, never as decoded
 *  text: two trees that differ only in bytes that are not UTF-8 have two
 *  digests, and an entry with such a name is read, not missed. copyTreeSafe
 *  reads, joins and writes names as bytes too, so such an entry is copied.
 *  `root` is a path, as text or as bytes.
 *
 *  A name's text (its bytes decoded as UTF-8, the way readdirSync decodes
 *  them: replacement characters for bytes that are not UTF-8, a byte order
 *  mark kept) is used only to test membership: the names a digest passes over
 *  and `instance.json`, as they have always been tested, and to order the
 *  entries for the legacy stored digest. Both digests pass over what a copy
 *  does not carry: `excludeRoot`, names at the top level tested as text, and
 *  `excludePaths`, exact paths under the root as bytes (a list of Buffers):
 *  an entry is passed over only where its whole path is one of them, whatever
 *  its kind, never by its name alone. Only the stored digest also passes over
 *  the kernel's receipts and the harness settings of a home.
 *
 *  `stored` is the digest a spawn baseline holds and is compared with, in the
 *  version `digestVersion` names (the baseline's own: baselineDigestVersion).
 *  Both versions hold a home's `instance.json` without the fields the kernel
 *  writes after spawn (kernelNeutralInstanceJson), so they read alike two
 *  `instance.json` files that parse to the same value; one over
 *  NEUTRAL_INSTANCE_JSON_BYTES is held as its bytes, so a baseline taken
 *  of its neutral form reads that home as changed.
 *  - 1, the legacy digest: what a baseline without `digestVersion` holds,
 *    written by a kernel before 0.49.0. It never changes: its framing (each
 *    field followed by NUL, no lengths) and its order (the names as text,
 *    compared by localeCompare, so it depends on the locale). For a tree whose
 *    names and link targets are all valid UTF-8 it is what it was when they
 *    were read as text: hashing a text hashes its UTF-8, which is those bytes.
 *    Without lengths it reads alike a file whose bytes spell the entry that
 *    follows it and those two entries.
 *  - 2 (BASELINE_DIGEST_VERSION), what a spawn writes now: the framing of the
 *    exact digest below, and the entries ordered by the bytes of their names,
 *    which no locale changes. Two trees it does not read alike are two
 *    trees, but for the receipts, the harness settings and the neutral form
 *    of `instance.json` it passes over.
 *
 *  `exact` is for every comparison of a tree with itself later, or with its
 *  copy: whether the retire hooks left it as it was. It is kept nowhere. It
 *  holds every entry the copy carries: of a home, the kernel's receipts and
 *  the harness settings too, which the copy carries and a retire hook can
 *  write. Two different trees cannot give it the same stream: an entry is its
 *  path, its mode, its kind and its content, where the path and the content
 *  carry their length and the mode and the kind end in NUL, so the stream can
 *  be read back into its entries in one way only, and a tree is the set of
 *  its entries. A home's `instance.json` goes in as the bytes it has. It
 *  follows the walk's order: the legacy digest's when the walk takes that
 *  one too, the order of the bytes otherwise. An exact digest is compared
 *  only with one taken with the same options (an inspection's, with the
 *  same baseline), so the two are taken in one order.
 *
 *  The root's own permission bits, which are no entry of the walk, are in
 *  the exact digest: a path the recovery copier copies is compared with its
 *  own bits, because copyTreeSafe ends with a chmod of what it made.
 *  `children` is for a root the copier creates itself (a home, a worktree):
 *  its copy is made inside a directory the copier creates, so the root's bits
 *  are no part of what it carries, and the root is compared through its
 *  children alone. The stored digest never holds the root's bits.
 *
 *  `taps` (paths under the root, as bytes; not with the legacy digest) are
 *  entries read into a digest of their own from the same read: each one's
 *  stored digest of version 2, as storedTreeDigest takes it of that path
 *  alone, in `taps` of the answer (a Map by the hex of the path). A tap the
 *  walk does not read whole has none there: one it passes over or does not
 *  reach, one inside another tap, and one that holds a path it passes over
 *  (the caller does not ask for those; worktreeDigests).
 *
 *  The walk reads every byte it hashes itself, in this order, each file in
 *  pieces of a fixed size (file-pieces.mjs); a home's `instance.json`, which
 *  the stored digest takes in its neutral form, is read whole up to
 *  NEUTRAL_INSTANCE_JSON_BYTES. While it does,
 *  worker threads read the files it reads next into the page cache
 *  (read-ahead.mjs), which changes nothing it computes or throws. */
function fingerprintTrees(root, options = {}) {
  const { excludeRoot = new Set(), excludePaths = [], stored = true, digestVersion = 1 } = options;
  // The files are read ahead in this walk's order (read-ahead.mjs); the digest is the read below, alone.
  return readingAhead([root], { order: stored && digestVersion === 1 ? "locale" : "bytes", excludeRoot, excludePaths }, () => treeDigests(root, options));
}
function treeDigests(root, { excludeRoot = new Set(), excludePaths = [], instanceHome = false, stored = true, digestVersion = 1, exact = false, children = false, taps = [] } = {}) {
  if (stored && digestVersion !== 1 && digestVersion !== BASELINE_DIGEST_VERSION) throw new Error(`no stored digest of version ${digestVersion}`);
  const legacy = stored && digestVersion === 1;
  if (taps.length && legacy) throw new Error("taps are read in the order of the names' bytes, which the legacy digest does not take");
  // Each tap's digest, by the hex of its path; undefined until the walk has read it.
  const tapDigests = new Map(taps.map((tap) => [tap.toString("hex"), undefined]));
  const excluded = new Set(excludePaths.map((path) => path.toString("hex")));
  // The stored digest: `s` when it is the legacy one, `v` when it is version 2.
  const s = legacy ? createHash("sha256") : null, v = stored && !legacy ? createHash("sha256") : null, x = exact ? createHash("sha256") : null;
  const digests = () => ({ stored: s || v ? `sha256:${(s || v).digest("hex")}` : undefined, exact: x ? `sha256:${x.digest("hex")}` : undefined, ...(taps.length ? { taps: tapDigests } : {}) });
  /** A field whose length is not fixed, in the exact digest or in version 2: its length, NUL, its bytes. */
  const sizedIn = (hash, bytes) => { hash.update(String(bytes.length)); hash.update("\0"); hash.update(bytes); };
  const sized = (bytes) => sizedIn(x, bytes);
  /** A file's bytes into the digests, read in pieces (readFilePieces): in each,
   *  "file" and NUL, then in the legacy digest (`legacyHash`) its bytes, and in
   *  each of `framed` its length, NUL and its bytes; the same stream as the
   *  whole file read at once gives. */
  const fileInto = (path, legacyHash, framed) => {
    const hashes = [legacyHash, ...framed].filter(Boolean);
    for (const hash of hashes) hash.update("file\0");
    readAheadConsumed(readFilePieces(path, (size) => { for (const hash of framed) hash?.update(`${size}\0`); }, (bytes) => { for (const hash of hashes) hash.update(bytes); }));
  };
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory()) {
    const mode = String(rootStat.mode & 0o7777);
    s?.update(mode); s?.update("\0");
    v?.update("entry\0"); v?.update(mode); v?.update("\0");
    x?.update("entry\0"); x?.update(mode); x?.update("\0");
    if (rootStat.isSymbolicLink()) { const target = readlinkSync(root, "buffer"); s?.update("link\0"); s?.update(target); if (v) { v.update("link\0"); sizedIn(v, target); } if (x) { x.update("link\0"); sized(target); } }
    else if (rootStat.isFile()) fileInto(root, s, [v, x]);
    else throw unsupportedEntry(String(root));
    return digests();
  }
  v?.update("tree\0");
  x?.update(children ? "tree\0" : `tree with its mode\0${rootStat.mode & 0o7777}\0`);
  // `dir` and `rel` are bytes: the directory, and its path under the root
  // (empty at the root). `relText` is `rel` as text, for the name tests.
  // `storedOn` is false inside an entry the stored digest passes over.
  // `tap`: inside a tap, its hash and where its paths start in `rel`.
  const walk = (dir, rel, relText, storedOn, tap) => {
    // The legacy order is the one it has always been: the names as text,
    // compared by localeCompare, on the listing as readdirSync returns it.
    // The sort is stable and the listing is the same whether its names come
    // as text or as bytes, so a tree whose names are all valid UTF-8 is
    // walked in the order it always was. Names that decode alike (two that
    // are not UTF-8, or one and a name that really holds the replacement
    // character) keep the listing's order. Where that order is not fixed, two
    // reads of one directory can differ, which adds a copy attempt; two
    // different trees cannot read alike for it, because the bytes of every
    // name are hashed. Every other walk is in the order of the names' bytes
    // (entriesAsBytes), which is fixed.
    const entries = legacy
      ? readdirSync(dir, { encoding: "buffer" }).map((bytes) => ({ bytes, name: bytes.toString("utf8") })).sort((a, b) => a.name.localeCompare(b.name))
      : entriesAsBytes(dir).map((e) => ({ bytes: e.name, name: e.name.toString("utf8") }));
    for (const { bytes: nameBytes, name } of entries) {
      const childRel = rel.length ? Buffer.concat([rel, PATH_SEPARATOR_BYTES, nameBytes]) : nameBytes;
      if ((!relText && excludeRoot.has(name)) || (excluded.size && excluded.has(childRel.toString("hex")))) continue;
      const childRelText = relText ? join(relText, name) : name;
      const storedPassesOver = instanceHome && ((!relText && (KERNEL_HOME_RECEIPTS.has(name) || KERNEL_HOME_RECEIPT_PATTERNS.some((p) => p.test(name)))) || HARNESS_HOME_SETTINGS.has(childRelText) || KERNEL_HOME_STATE_DIRS.has(childRelText) || (relText === ".oats" && (UPGRADE_RECEIPT_NAME_RE.test(name) || /^\.staging-upgrade-[a-f0-9]+$/.test(name))));
      if (storedPassesOver && !x) continue;
      const on = storedOn && !storedPassesOver;
      const s = on ? outerS : null, v = on ? outerV : null;
      const path = Buffer.concat([dir, PATH_SEPARATOR_BYTES, nameBytes]);
      const st = lstatSync(path);
      const mode = String(st.mode & 0o7777);
      s?.update(childRel); s?.update("\0"); s?.update(mode); s?.update("\0");
      if (v) { sizedIn(v, childRel); v.update(mode); v.update("\0"); }
      if (x) { sized(childRel); x.update(mode); x.update("\0"); }
      // A tap is framed as the stored digest of version 2 frames a root of its own: a directory
      // as "tree", anything else as one entry without a path. Not one inside another: the inner
      // one is read apart.
      if (tap) { sizedIn(tap.hash, childRel.subarray(tap.at)); tap.hash.update(mode); tap.hash.update("\0"); }
      const opens = !tap && tapDigests.size && tapDigests.has(childRel.toString("hex")) ? createHash("sha256") : null;
      if (opens) opens.update(st.isDirectory() ? "tree\0" : `entry\0${mode}\0`);
      const t = tap?.hash ?? opens;
      if (st.isSymbolicLink()) {
        const target = readlinkSync(path, "buffer");
        s?.update("link\0"); s?.update(target); s?.update("\0");
        if (v) { v.update("link\0"); sizedIn(v, target); }
        if (x) { x.update("link\0"); sized(target); }
        if (t) { t.update("link\0"); sizedIn(t, target); }
      } else if (st.isFile()) {
        // Kernel-field neutrality applies ONLY when the tree IS an instance home, and only to the
        // stored digest; a work tree's instance.json is the agent's bytes.
        const bytes = (s || v) && instanceHome && !relText && name === "instance.json" ? readFileUpTo(path, NEUTRAL_INSTANCE_JSON_BYTES) : null;
        if (bytes) {
          readAheadConsumed(bytes.length);
          const storedBytes = kernelNeutralInstanceJson(bytes);
          s?.update("file\0"); s?.update(storedBytes);
          if (v) { v.update("file\0"); sizedIn(v, storedBytes); }
          if (x) { x.update("file\0"); sized(bytes); }
          if (t) { t.update("file\0"); sizedIn(t, bytes); }
        } else fileInto(path, s, [v, x, t]);
        s?.update("\0");
      } else if (st.isDirectory()) {
        s?.update("dir\0"); v?.update("dir\0"); x?.update("dir\0"); tap?.hash.update("dir\0");
        walk(path, childRel, childRelText, on, tap ?? (opens ? { hash: opens, at: childRel.length + PATH_SEPARATOR_BYTES.length } : null));
      }
      else throw unsupportedEntry(join(String(root), childRelText));
      if (opens) tapDigests.set(childRel.toString("hex"), `sha256:${opens.digest("hex")}`);
    }
  };
  const outerS = s, outerV = v;
  walk(Buffer.from(root), Buffer.alloc(0), "", true, null);
  return digests();
}
/** The legacy stored digest of a tree (fingerprintTrees, version 1): what a spawn baseline without
 *  `digestVersion` holds and is compared with. */
function fingerprintTree(root, options = {}) {
  return fingerprintTrees(root, { ...options, stored: true, digestVersion: 1, exact: false }).stored;
}
/** The stored digest of a tree in `digestVersion` (fingerprintTrees): 1, the legacy one, or 2. */
function storedTreeDigest(root, digestVersion, options = {}) {
  return fingerprintTrees(root, { ...options, stored: true, digestVersion, exact: false }).stored;
}
/** The exact digest of a tree (fingerprintTrees): what a tree is compared with itself later, or with its copy. */
function exactTreeDigest(root, options = {}) {
  return fingerprintTrees(root, { ...options, stored: false, exact: true }).exact;
}
/** The bytes of a directory instance's work/, as their exact digest, with the
 *  permission bits of work/ itself: what a copy of it carries. Kept nowhere. */
const directoryBytes = (work) => exactTreeDigest(work);

/** A worktree directory whose git admin entry is gone: no `.git`, an unreadable one, or a gitfile naming an
 *  admin directory that no longer exists. Read from the gitfile, not asked of git, which would walk up into
 *  whatever repository encloses the home. A `.git` directory is a repository of its own, not this case.
 *  The gitfile is parsed as Git parses it (setup.c, read_gitfile_gently): the file starts with `gitdir: `,
 *  and the path is the rest of it with its trailing run of line feeds and carriage returns removed, white
 *  space kept (awebai/oats#647). A file Git would not read as a gitfile names no admin entry. */
function worktreeAdminMissing(work) {
  const dotGit = join(work, ".git");
  let stat;
  try { stat = lstatSync(dotGit); } catch { return true; }
  if (stat.isDirectory()) return false;
  if (!stat.isFile()) return true;
  let text;
  try { text = readFileSync(dotGit, "utf8"); } catch { return true; }
  if (!text.startsWith("gitdir: ")) return true;
  const path = text.slice("gitdir: ".length).replace(/[\r\n]+$/, "");
  if (!path) return true;
  return !existsSync(join(resolve(work, path), "HEAD"));
}
/** A repository's status as Git printed it, as bytes. A path that is not
 *  UTF-8 is in there as it is: the work state compares these bytes
 *  (repositoryGitState). Output that does not decode is not a failure; only
 *  a `git status` that fails is. */
function worktreeStatusBytes(repo) {
  try {
    return retireGit(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none"]);
  } catch (e) {
    throw oatsError("E_WORK_INSPECTION_FAILED", `could not inspect instance worktree: ${String(e.stderr ?? e.message ?? "").trim() || "git status failed"}`);
  }
}
/** The same status as text, for what reads its rows: the classes, the rows a
 *  spawn baseline was taken from, the comparison of a copy with its source.
 *  Bytes that are not UTF-8 read as replacement characters here, so this
 *  text is never what proves a worktree unchanged. */
function worktreeStatus(repo) {
  return worktreeStatusBytes(repo).toString("utf8");
}

/** `git status --porcelain=v1 -z` as Map<path, XY>; a rename/copy row names its source (`R  ← old`). */
function statusRows(z) {
  const rows = new Map(), parts = z.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const row = parts[i];
    if (!row) continue;
    const xy = row.slice(0, 2), path = row.slice(3);
    rows.set(path, xy[0] === "R" || xy[0] === "C" ? `${xy} ← ${parts[++i]}` : xy);
  }
  return rows;
}
const STATUS_DISAGREEMENT_CAP = 10;
/** Where two statuses disagree, by path: { rows: [{ path, source, recovery }] (null = absent; sorted, the
 *  first `cap`), total }. What E_WORK_PRESERVATION_FAILED shows, so an operator sees `!! .scratch/` against
 *  an absent row directly. */
export function statusDisagreement(sourceStatus, recoveredStatus, cap = STATUS_DISAGREEMENT_CAP) {
  const a = statusRows(sourceStatus), b = statusRows(recoveredStatus);
  const paths = [...new Set([...a.keys(), ...b.keys()])].filter((p) => a.get(p) !== b.get(p)).sort();
  return { rows: paths.slice(0, cap).map((path) => ({ path, source: a.get(path) ?? null, recovery: b.get(path) ?? null })), total: paths.length };
}
const RECOVERY_DISAGREEMENT_SHOWN = 5;
/** The refusal of a copy whose exact digest is not its source's (`what`), with where the two differ
 *  now (treeDisagreement, read with the same `excludePaths`) as `recoveryDisagreement`, and the first
 *  of those in the message. The digest comparison has refused already; this reading only says where
 *  to look, and its `basis: "current"` says that it is the source as it is now, not the bytes the
 *  comparison recorded. Exported for its test. */
export function recoveryDisagreed(what, source, copy, excludePaths) {
  const diff = treeDisagreement(source, copy, { excludePaths });
  const shown = diff.entries.slice(0, RECOVERY_DISAGREEMENT_SHOWN).map((d) => `${d.path} (${d.kind})`).join("; ");
  const more = diff.entries.length > RECOVERY_DISAGREEMENT_SHOWN ? `; and ${diff.entries.length - RECOVERY_DISAGREEMENT_SHOWN} more` : "";
  const unfinished = diff.complete ? "" : `${shown ? "; " : ""}the search stopped (${diff.stoppedBy})`;
  const found = shown || unfinished ? `${shown}${more}${unfinished}` : "no difference between the current source and the copy";
  return Object.assign(new Error(`${what}; where they differ now (diagnostic only): ${found}`), { recoveryDisagreement: { basis: "current", ...diff } });
}
/** The details of E_WORK_PRESERVATION_FAILED for `e`: the disagreements it carries, beside `home`.
 *  Exported for its test. */
export function preservationDetails(home, e) {
  if (!e.statusDisagreement && !e.recoveryDisagreement) return undefined;
  return { home, ...(e.statusDisagreement ? { statusDisagreement: e.statusDisagreement } : {}), ...(e.recoveryDisagreement ? { recoveryDisagreement: e.recoveryDisagreement } : {}) };
}
/** Refuse a recovery whose Git status is not the source's, naming the differing rows (capped). */
function assertStatusAgrees(source, recovered, what, repo) {
  const sourceStatus = worktreeStatus(source), recoveredStatus = worktreeStatus(recovered);
  if (sourceStatus === recoveredStatus) return;
  const diff = statusDisagreement(sourceStatus, recoveredStatus);
  const shown = diff.rows.map((r) => `${r.path} (source ${r.source ?? "absent"}, recovery ${r.recovery ?? "absent"})`).join("; ");
  const more = diff.total > diff.rows.length ? `; and ${diff.total - diff.rows.length} more` : "";
  throw Object.assign(new Error(`${what}${shown ? `: ${shown}${more}` : ""}`), { statusDisagreement: { repo, ...diff } });
}

/** The digest of a worktree's untracked (`??`) and ignored (`!!`) paths, outside the disposable
 *  roots, that a spawn baseline stores as `generatedWorkFingerprint`, in the baseline's digest
 *  version (baselineDigestVersion) → the digest, or undefined for a version this kernel does not
 *  take. `statusBytes` is the worktree's status as bytes (worktreeStatusBytes). */
function generatedWorkFingerprintIn(digestVersion, work, statusBytes, disposableRoots = []) {
  if (digestVersion === 1) return generatedWorkFingerprint(work, statusBytes.toString("utf8"), disposableRoots);
  if (digestVersion === BASELINE_DIGEST_VERSION) return generatedWorkDigest(work, statusBytes, disposableRoots);
  return undefined;
}
/** Version 2 of generatedWorkFingerprint. The paths are the status's bytes (untrackedOrIgnoredPaths),
 *  so a name that is not UTF-8 is read by its own name, and they are in the order of those bytes. A
 *  path is hashed as its length and its bytes, then, by lstat (a link is never followed): `missing`
 *  for one that is not there, else its stored digest of version 2 (a link is its target's bytes,
 *  whether or not the target exists). A trailing `/` (an ignored directory's row) is hashed with the
 *  path but not used to read it, so a link in its place is read as the link. A disposable root owns
 *  a path that is it or under it, compared as bytes, as the legacy digest compares it as text.
 *  A path that cannot be tested (lstat fails otherwise than for an entry that is not there) or read
 *  (an entry under it without permission, for example) is no path the digest can prove anything
 *  of: it throws E_WORK_INSPECTION_FAILED, `could not inspect <path>: <reason>`, the path as text. */
function generatedWorkDigest(work, statusBytes, disposableRoots = []) {
  const paths = generatedWorkPaths(statusBytes, disposableRoots);
  return readingAhead(paths.map((rel) => generatedWorkPath(work, rel)), {}, () => generatedWorkDigestOf(work, paths));
}
/** The paths generatedWorkDigest reads, under the worktree, in its order: the
 *  untracked and ignored ones, outside the disposable roots, as bytes. */
function generatedWorkPaths(statusBytes, disposableRoots) {
  const roots = disposableRoots.map((root) => [Buffer.from(root), Buffer.from(`${root}${sep}`)]);
  const owned = (path) => roots.some(([root, under]) => path.equals(root) || (path.length >= under.length && path.subarray(0, under.length).equals(under)));
  return untrackedOrIgnoredPaths(statusBytes).filter((path) => !owned(path)).sort(Buffer.compare);
}
/** Where generatedWorkDigest reads the status's path `rel`: without the `/` an ignored directory's row ends in. */
const generatedWorkPath = (work, rel) => joinBytes(work, rel.length > 1 && rel[rel.length - 1] === 0x2f ? rel.subarray(0, -1) : rel);
/** generatedWorkDigest of `paths` (generatedWorkPaths), each read as it is in
 *  there, or as `read` has it already: a Map of a path's stored digest by the
 *  hex of where it is read (worktreeDigests). */
function generatedWorkDigestOf(work, paths, read = new Map()) {
  const hash = createHash("sha256");
  for (const rel of paths) {
    hash.update(String(rel.length)); hash.update("\0"); hash.update(rel);
    const path = generatedWorkPath(work, rel);
    const known = read.get(path.subarray(pathBytes(work).length + PATH_SEPARATOR_BYTES.length).toString("hex"));
    if (known !== undefined) { hash.update(known); hash.update("\0"); continue; }
    const uninspectable = (e) => (e?.code === "E_WORK_INSPECTION_FAILED" ? e : oatsError("E_WORK_INSPECTION_FAILED", `could not inspect ${path.toString()}: ${e.message}`));
    try { lstatSync(path); }
    catch (e) {
      if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") throw uninspectable(e);
      hash.update("missing\0"); continue;
    }
    let digest;
    try { digest = storedTreeDigest(path, BASELINE_DIGEST_VERSION); }
    catch (e) { throw uninspectable(e); }
    hash.update(digest); hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}
/** A worktree's generatedWorkDigest and its bytes (worktreeBytes) from one
 *  read of each file (#1247): one walk of the worktree for its bytes, in
 *  which each path of the digest that the walk reads whole is a tap
 *  (fingerprintTrees), read into its stored digest from the same bytes. A
 *  path it cannot read whole (one under a link or a Git directory the bytes
 *  leave out, one that holds such a directory, one inside another path, one
 *  that is not there) is read apart, as generatedWorkDigest reads it.
 *  → { generated, bytes, gitPaths }, the values the two give apart; or
 *  undefined when anything fails: the caller then takes them apart, as
 *  before, so that whatever fails fails in their order, with their words. */
function worktreeDigests(work, statusBytes, disposableRoots = []) {
  try {
    const gitPaths = worktreeGitPaths(work);
    const paths = generatedWorkPaths(statusBytes, disposableRoots);
    const under = pathBytes(work).length + PATH_SEPARATOR_BYTES.length;
    const holdsLeftOut = (rel) => gitPaths.some((git) => git.length > rel.length && git[rel.length] === PATH_SEPARATOR_BYTES[0] && git.subarray(0, rel.length).equals(rel));
    const taps = paths.map((rel) => generatedWorkPath(work, rel).subarray(under)).filter((rel) => rel.length && !holdsLeftOut(rel));
    const { exact, taps: read } = fingerprintTrees(work, { stored: false, exact: true, excludePaths: gitPaths, children: true, taps });
    return { generated: generatedWorkDigestOf(work, paths, read ?? new Map()), bytes: exact, gitPaths };
  } catch {
    return undefined;
  }
}
/** The legacy generatedWorkFingerprint (digest version 1), for a baseline without `digestVersion`.
 *  It never changes: the decoded status's paths, tested with existsSync, which follows a link. */
function generatedWorkFingerprint(work, status, disposableRoots = []) {
  const owned = (path) => disposableRoots.some((root) => path === root || path.startsWith(`${root}${sep}`));
  const paths = status.split("\0").filter(Boolean)
    .filter((row) => row.startsWith("?? ") || row.startsWith("!! "))
    .map((row) => row.slice(3)).filter((path) => !owned(path)).sort();
  return readingAhead(paths.map((rel) => join(work, rel)), { order: "locale" }, () => {
    const hash = createHash("sha256");
    for (const rel of paths) {
      const path = join(work, rel);
      hash.update(rel); hash.update("\0");
      if (!existsSync(path)) { hash.update("missing\0"); continue; }
      hash.update(fingerprintTree(path)); hash.update("\0");
    }
    return `sha256:${hash.digest("hex")}`;
  });
}

function retirementDisposableRoots(work, capabilities) {
  const receipts = [
    ...capabilities.flatMap((cap) => (cap.retirement?.disposable?.work || []).map((root) => ({ owner: cap.id, root }))),
  ];
  const roots = [];
  for (const receipt of receipts) {
    // The manifest check (capability-contract.mjs, disposableWorkRootProblem) refuses
    // the first two before a spawn gets here; they stay for a copy read without it.
    if (typeof receipt.root !== "string" || !receipt.root || isAbsolute(receipt.root)) throw oatsError("E_CAPABILITY_BROKEN", `retirement disposable root from ${receipt.owner} must be relative`);
    const normalized = receipt.root.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) throw oatsError("E_CAPABILITY_BROKEN", `unsafe retirement disposable root from ${receipt.owner}: ${receipt.root}`);
    const path = join(work, normalized);
    // lstat, never existsSync: a link whose target is missing is a link all the same.
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw oatsError("E_CAPABILITY_BROKEN", `retirement disposable root from ${receipt.owner} is a symlink: ${normalized}`);
    if (roots.some((r) => normalized === r.root || normalized.startsWith(`${r.root}/`) || r.root.startsWith(`${normalized}/`))) throw oatsError("E_CAPABILITY_BROKEN", `overlapping retirement disposable roots: ${normalized}`);
    roots.push({ owner: receipt.owner, root: normalized });
  }
  return roots;
}

/** The fields the KERNEL writes into a home's instance.json after the spawn's
 *  retirement baseline was taken (completion marker, wake record). The
 *  baseline fingerprint hashes instance.json with exactly these removed, so a
 *  kernel write does not read as the agent's change — and NOTHING ELSE in the
 *  home is ever re-blessed: an agent's STATE.md written seconds after launch
 *  is still recovered at retire. (Replaces a whole-home re-stamp that could
 *  bless authored bytes written in the launch→completion interval.) */
const KERNEL_POST_SPAWN_FIELDS = ["spawnCompleted", "wake", "launchPrompts", "launchPromptTarget", "parentLineageCommitted"];
// What a digest holds of a home instance.json to take its neutral form (#617); a larger one is hashed raw, in pieces.
const NEUTRAL_INSTANCE_JSON_BYTES = 16 * 1024 * 1024;
function kernelNeutralInstanceJson(bytes) {
  try {
    // Bytes that are not UTF-8 would each read as the replacement character,
    // and two such files would then read alike: a file that does not decode
    // and encode back to the same bytes is hashed as it is, like one that is
    // not JSON.
    const text = String(bytes);
    if (!Buffer.from(text).equals(bytes)) return bytes;
    const m = JSON.parse(text);
    if (!m || typeof m !== "object" || Array.isArray(m)) return bytes;
    for (const k of KERNEL_POST_SPAWN_FIELDS) delete m[k];
    return Buffer.from(JSON.stringify(m));
  } catch { return bytes; }
}
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** The provider-owned home entries the active capabilities declare
 *  (`retirement.disposable.home`, lib/capability-contract.mjs) → [{ owner, root }],
 *  sorted by owner then root. Recorded in the spawn baseline: retirement reads
 *  them from there and from nowhere else. */
function retirementDisposableHome(capabilities) {
  const rows = new Map();
  for (const cap of capabilities || []) {
    for (const root of cap?.retirement?.disposable?.home || []) {
      if (disposableHomeRootProblem(root)) throw new Error(`retirement disposable home entry from ${cap.id} is not declarable: ${JSON.stringify(root)}`);
      rows.set(`${cap.id}\0${root}`, { owner: cap.id, root });
    }
  }
  return [...rows.values()].sort((a, b) => byCodeUnit(a.owner, b.owner) || byCodeUnit(a.root, b.root));
}
/** A baseline's `disposableHome`, or no exclusions at all: it must be an array
 *  of { owner, root } whose every root passes the manifest grammar. Anything
 *  else (absent, an older baseline, a malformed or widened row) excludes
 *  nothing, so the home is copied whole. Never the manifest in the home's
 *  module copy, the capability as it is today, or instance.json. */
function baselineDisposableHome(baseline) {
  const rows = baseline?.disposableHome;
  if (!Array.isArray(rows) || !rows.every((r) => isPlainObject(r) && nonEmptyString(r.owner) && !disposableHomeRootProblem(r.root))) return [];
  return rows.map((r) => ({ owner: r.owner, root: r.root })).sort((a, b) => byCodeUnit(a.owner, b.owner) || byCodeUnit(a.root, b.root));
}
/** One pass's resolved exclusion set: the home's top-level entries that
 *  `disposableHome` rows cover, matched by name (a symlink is its name; it is
 *  never followed). The fingerprint, the copy and the copy's verification of
 *  that pass all use this one set. → { excludeRoot: Set (work/ and the covered
 *  names), notCopied: [{ scope: "home", path, owner }] sorted by path }: names
 *  and owners only. Two owners of one entry: the first in owner order. */
function resolveHomeExclusions(home, disposableHome = [], extraTrees = []) {
  const excludeRoot = new Set(["work"]);
  const notCopied = [];
  const extra = new Set(extraTrees.map((t) => t.name));
  if (!disposableHome.length && !extra.size) return { excludeRoot, notCopied };
  for (const name of readdirSync(home).sort(byCodeUnit)) {
    const owner = extra.has(name) ? EXTRA_WORKTREE_OWNER : name === "work" ? undefined : disposableHome.find((r) => disposableHomeRootMatches(r.root, name))?.owner;
    if (!owner) continue;
    excludeRoot.add(name);
    notCopied.push({ scope: "home", path: name, owner });
  }
  return { excludeRoot, notCopied };
}

/** The `notCopied` owner of a verified extra tree: the retire's extra-tree
 *  step handles it, not the home recovery. */
const EXTRA_WORKTREE_OWNER = "kernel:extra-worktree";
/** `git worktree list --porcelain -z` → [{ worktree, locked }]: `locked` is
 *  the lock's reason ("" when it gives none), undefined when not locked. */
function parseWorktreeList(out) {
  const records = [];
  for (const field of out.split("\0")) {
    if (field.startsWith("worktree ")) records.push({ worktree: field.slice("worktree ".length) });
    else if (records.length && (field === "locked" || field.startsWith("locked "))) records.at(-1).locked = field.slice("locked ".length);
  }
  return records;
}
/** The home's extra trees (awebai/oats#674), in every work mode: top-level
 *  entries named `.work-*` that are real directories (not symlinks), whose
 *  `.git` is a regular file, and that Git confirms are registered linked
 *  worktrees of a repository outside the home: the git dir differs from the
 *  common dir, the toplevel is the entry, and the repository's worktree list
 *  names it. The repository is that list's first entry (its main worktree, or
 *  the bare dir), as for the primary checkout (canonicalDeploymentPath).
 *  Anything else named `.work-*` is ordinary home bytes. Read-only probes
 *  (gitRead). → [{ name, path, repo, gitDir, commonDir, locked }] sorted by
 *  name: `commonDir` is the repository's Git directory, which the step and
 *  the reachability read name it by (bare or not). */
function extraWorktreesOf(home) {
  const trees = [];
  let names;
  try { names = readdirSync(home); } catch { return trees; }
  // Git reports paths in their on-disk spelling: the home and each tree are compared in it too.
  const realHome = canonicalHomePath(home);
  for (const name of names.sort(byCodeUnit)) {
    if (!name.startsWith(".work-")) continue;
    const path = join(home, name);
    const tree = registeredLinkedWorktree(path, realHome);
    if (tree) trees.push({ name, path, ...tree });
  }
  return trees;
}
/** The kernel's test of a tree of a home, for `path` in the home whose
 *  canonical spelling is `realHome`: a real directory (not a symlink) whose
 *  `.git` is a regular file, and that Git confirms is a registered linked
 *  worktree of a repository outside the home (extraWorktreesOf says how).
 *  The one test of an extra tree and of `work/` (instanceWork). Read-only
 *  probes (gitRead). → { repo, gitDir, commonDir, locked }, or undefined. */
function registeredLinkedWorktree(path, realHome) {
  const inHome = (p) => { const rel = relative(realHome, canonicalHomePath(p)); return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)); };
  try {
    if (!lstatSync(path).isDirectory() || !lstatSync(join(path, ".git")).isFile()) return undefined;
  } catch { return undefined; }
  const dirs = gitRead(path, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"]);
  if (!dirs.ok) return undefined;
  const [gitDir, commonDir, toplevel] = dirs.out.split("\n");
  if (!gitDir || !commonDir || !toplevel || realPathOrNearest(gitDir) === realPathOrNearest(commonDir)) return undefined;
  const real = canonicalHomePath(path);
  // A repository inside the home goes with the home: its trees are home bytes.
  if (canonicalHomePath(toplevel) !== real || inHome(commonDir)) return undefined;
  const list = gitRead(path, ["worktree", "list", "--porcelain", "-z"]);
  if (!list.ok) return undefined;
  const records = parseWorktreeList(list.out);
  const self = records.find((r) => canonicalHomePath(r.worktree) === real);
  if (!records.length || !self) return undefined;
  return { repo: records[0].worktree, gitDir, commonDir: realPathOrNearest(commonDir), locked: self.locked };
}
/** What is at `<home>/work` (awebai/oats#962): the one answer the retire
 *  (retireInstance) and its plan (planRetire) both read. `record` is the
 *  home's record as the caller read it. → { path, at, is, tree }.
 *
 *  `at` is the entry: "link", "directory" (a real one), "other" (any other
 *  kind of entry) or "none". `is` is what it is to the instance:
 *
 *  - "directory-mode": the record says `directory`. Whatever is there, the
 *    retire holds it against the spawn's receipt (inspectRetirementWork).
 *  - "own-tree": the instance's own work tree. The retire re-homes it, or
 *    removes it through Git when told to.
 *  - "home-directory": a real directory that is not that. It is bytes of the
 *    home that the home's copy leaves out: the retire copies it to recovery,
 *    checks the copy against what it inspected, and removes it with the
 *    home. Never a Git removal, and never left out of the copy.
 *  - "link": a symbolic link, whatever the record says (awebai/oats#973). A
 *    link is never the instance's own tree: it goes with the home, and no
 *    step reads what it leads to as a tree to copy, move or remove. Neither
 *    the receipt nor Git is read for it.
 *  - "none", "other": the entry, for a record that does not say `worktree`.
 *    The retire reads an "other" entry (a file, say) as a worktree, and its
 *    inspection refuses it. Under a record that says `worktree` such an
 *    entry is the own tree, as nothing at `work/` is (below): the retire
 *    then finds a work directory whose Git admin entry is missing, runs its
 *    hooks, and keeps the entry and the home as an incomplete item.
 *
 *  A real directory is the instance's own tree when the spawn's receipt (a
 *  valid retirement baseline) holds what only a `worktree` spawn writes
 *  (`generatedWorkFingerprint`). A valid receipt without it says the
 *  instance was given no tree, whatever the record says now: the record is
 *  the instance's to write, the receipt is not. With no valid receipt the
 *  record decides: `worktree` is the own tree; `attached`, `checkout` and
 *  `workspace` were given a link, so a directory there is the home's; and a
 *  record with no work mode, or one this kernel does not know, has the own
 *  tree exactly when Git confirms that the directory is a registered linked
 *  worktree (`tree`, registeredLinkedWorktree).
 *
 *  Nothing at `work/`, or an entry that is neither a link nor a directory, is
 *  what the record says, as before this function: a `worktree` record's own
 *  tree, else the entry. `tree` is set for a real directory Git confirms, in
 *  either answer: the repository of an own tree whose record names none, and
 *  what a directory of the home leaves registered in its repository. */
export function instanceWork(home, record) {
  const path = join(home, "work");
  const mode = record?.work;
  let st;
  try { st = lstatSync(path); } catch { /* nothing that can be read is there */ }
  const at = !st ? "none" : st.isSymbolicLink() ? "link" : st.isDirectory() ? "directory" : "other";
  if (mode === "directory") return { path, at, is: "directory-mode", tree: undefined };
  // The record is the instance's to write; what a link leads to is not the instance's (#973).
  if (at === "link") return { path, at, is: "link", tree: undefined };
  if (at !== "directory") return { path, at, is: mode === "worktree" ? "own-tree" : at, tree: undefined };
  const baseline = readJsonOrUndefined(findRetirementBaseline(home));
  const tree = registeredLinkedWorktree(path, canonicalHomePath(home));
  const own = retirementBaselineValid(baseline, home) ? typeof baseline.generatedWorkFingerprint === "string"
    : mode === "worktree" || (!WORK_MODES.includes(mode) && !!tree);
  return { path, at, is: own ? "own-tree" : "home-directory", tree };
}
/** Where retire re-homes the worktrees it retains, one directory per repository under it. */
export function retainedWorktreesRoot(workspace) {
  return join(workspace, ".agents", "worktrees");
}
/** The longest retained-worktree leaf before its `-N` suffix, in bytes (awebai/oats#821). The
 *  leaf is one path component, so it must fit NAME_MAX (255 on the usual filesystems). 16 bytes
 *  are kept as a margin, as the test fixtures keep: nothing appends to the leaf's name today
 *  (`git worktree move` renames to the path it is given, which does not exist, and adds nothing),
 *  so the margin is headroom only. 8 more are kept for the `-N` suffix (`-` and up to seven
 *  digits). A leaf is then at most 231 bytes, and at most 239 with its suffix. */
export const RETAINED_LEAF_MAX = 255 - 16 - 8;
/** Where a retired worktree is re-homed: `<workspace>/.agents/worktrees/<repoName>/<leaf>`,
 *  the leaf being the branch, else `detached-<commit>`, with every run of characters outside
 *  `[A-Za-z0-9._-]` made `-`; when that exists (or `taken` holds it), `<leaf>-2`, `-3`, … A leaf
 *  over RETAINED_LEAF_MAX is cut to fit, its trailing `-` trimmed, and followed by `-` and 6 hex
 *  of the SHA-256 of the full branch name: deterministic, readable, and one per branch. The
 *  character class keeps the leaf ASCII, so its length in characters is its length in bytes;
 *  widen the class and the bound must measure bytes. The one naming rule of work/ and of the
 *  extra trees, the plan's `movedTo` and the apply's alike. Creates nothing. */
function retainedWorktreeDest(workspace, repo, branch, commit, taken = new Set()) {
  const repoName = basename(realPathOrNearest(repo)).replace(/\.git$/, "") || "repo";
  const name = branch ?? `detached-${(commit || "unknown").slice(0, 12)}`;
  const flat = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "work";
  const hash = () => createHash("sha256").update(name, "utf8").digest("hex").slice(0, 6);
  /** The leaf in `room` bytes: as it is when it fits, else cut and hashed. */
  const fit = (room) => flat.length <= room ? flat : `${flat.slice(0, room - 7).replace(/-+$/, "")}-${hash()}`;
  const retainedRoot = join(retainedWorktreesRoot(workspace), repoName);
  let dest = join(retainedRoot, fit(RETAINED_LEAF_MAX));
  // The 8 bytes kept for `-N` hold `-2` to `-9999999`; a longer suffix takes its extra bytes from
  // the leaf's readable part, never its hash, so a leaf with its suffix never passes
  // RETAINED_LEAF_MAX + 8.
  for (let n = 2; existsSync(dest) || taken.has(dest); n++) dest = join(retainedRoot, `${fit(Math.min(RETAINED_LEAF_MAX, RETAINED_LEAF_MAX + 7 - String(n).length))}-${n}`);
  taken.add(dest);
  return dest;
}
/** What retirement does with each extra tree (`trees`: extraWorktreesOf) →
 *  [{ path, repo, branch, detachedAt, disposition, movedTo, reason }], one row
 *  per tree in order: the retire plan's `extraWorktrees` and the binding the
 *  retire checks before it acts. `remove` when the tree is clean: an empty
 *  status (ignored and untracked files count), no operation in progress, and
 *  a HEAD commit some ref of the repository reaches: its shared refs, never
 *  the tree's own HEAD, reflog or refs/worktree/, which go with its admin
 *  entry when it is removed. `retain` (to `movedTo`) otherwise, with why
 *  in `reason`; a HEAD that cannot be read is not clean. `refuse` for a locked
 *  tree, which Git will neither move nor remove. Read-only. */
function extraWorktreeRows(trees, root) {
  const taken = new Set();
  return trees.map((tree) => {
    let name = null, commit = null;
    try { name = headName(tree.path); } catch { /* not clean, below */ }
    try { commit = worktreeHead(tree.path).commit; } catch { /* not clean, below */ }
    const row = { path: tree.path, repo: tree.repo, branch: name?.branch ?? null, detachedAt: name?.detached ? commit : null, disposition: "remove", movedTo: null, reason: null };
    if (tree.locked !== undefined) return { ...row, disposition: "refuse", reason: `it is locked${tree.locked ? ` (${tree.locked})` : ""}; unlock it with \`git worktree unlock\`, or move it out of the home, then retire again` };
    const why = [];
    if (!name || !commit) why.push("its HEAD could not be read");
    const status = gitRead(tree.path, ["status", "--porcelain", "-z", "--ignored", "--untracked-files=all", "--ignore-submodules=none"]);
    if (!status.ok) why.push(`its status could not be read (${status.err})`);
    else if (status.out.length) why.push("it holds uncommitted, untracked or ignored files");
    if (gitOperationInProgress(tree.gitDir, tree.path)) why.push("an operation is in progress in it");
    if (commit) {
      const reach = gitRepoRead(tree.commonDir, ["for-each-ref", "--contains", commit, "--count=1", "--format=%(objectname)"]);
      if (!reach.ok) why.push(`which refs reach its HEAD commit could not be read (${reach.err})`);
      else if (!reach.out.length) why.push("its HEAD commit is reached by no ref");
    }
    if (!why.length) return row;
    return { ...row, disposition: "retain", movedTo: retainedWorktreeDest(workspaceOf(root), tree.repo, row.branch, commit, taken), reason: why.join("; ") };
  });
}
/** The retire plan's view of a home's extra trees: extraWorktreeRows of what
 *  is there now. */
export function extraWorktreePlan(home, root) {
  return extraWorktreeRows(extraWorktreesOf(home), root);
}
function unionNotCopied(...lists) {
  const byPath = new Map();
  for (const row of lists.flatMap((list) => list || [])) if (!byPath.has(row.path)) byPath.set(row.path, row);
  return [...byPath.values()].sort((a, b) => byCodeUnit(a.path, b.path));
}
function retirementBaselineValid(baseline, home) {
  return baseline?.version === RETIRE_BASELINE_VERSION && receiptRecordsHome(baseline, canonicalHomePath(home));
}
/** What a retire plan may say about recovery without hashing anything: where a
 *  recovery would be written, and the home entries the spawn baseline declares
 *  as not copied (none without a valid baseline). */
export function retirementRecoveryFacts(home) {
  const baseline = readJsonOrUndefined(findRetirementBaseline(home));
  return { recoveryRoot: retirementRecoveryRoot(dirname(home)), disposableHome: retirementBaselineValid(baseline, home) ? baselineDisposableHome(baseline) : [] };
}
/** A projection is local to one fingerprint, never a persistent exclusion. */
function retirementTransientFiles(home, transientHomePaths) {
  if (!Array.isArray(transientHomePaths) || transientHomePaths.some(path => typeof path !== "string" || !path || isAbsolute(path) || /[\x00*?\[\]{}]/.test(path) || path.split(/[\/\\]/).some(part => !part || part === "." || part === ".."))) throw oatsError("E_BAD_ARGS", "retirement baseline transientHomePaths must be exact relative paths without globs");
  return transientHomePaths.map(path => {
    let at = home;
    const parts = path.split(/[\/\\]/);
    try {
      for (const component of parts.slice(0, -1)) {
        at = join(at, component);
        if (!lstatSync(at).isDirectory()) throw new Error("not a real parent directory");
      }
      at = join(at, parts.at(-1));
      const stat = lstatSync(at);
      if (!stat.isFile()) throw new Error("not a regular file");
      return { relative: pathBytes(join(...parts)), path: at, stat };
    } catch { throw oatsError("E_WORK_INSPECTION_FAILED", `retirement baseline transient path ${path} must exist as a regular file inside ${home}`); }
  });
}

function assertRetirementTransientsUnchanged(transientFiles) {
  for (const file of transientFiles) {
    let now;
    try { now = lstatSync(file.path); } catch { /* refused below */ }
    if (!now?.isFile() || now.dev !== file.stat.dev || now.ino !== file.stat.ino) throw oatsError("E_WORK_INSPECTION_FAILED", `retirement baseline transient file changed while projecting ${file.path}`);
  }
}

/** Upgrade may adjust the fingerprint only while preserving a valid independent
 * baseline. Missing authority is never reconstructed from mutable home metadata. */
function upgradeRetirementBaseline(home) {
  const path = findRetirementBaseline(home);
  const baseline = readJsonOrUndefined(path);
  const digestVersion = baselineDigestVersion(baseline);
  if (!retirementBaselineValid(baseline, home) || digestVersion === undefined || typeof baseline.homeFingerprint !== "string" || !/^sha256:[a-f0-9]{64}$/.test(baseline.homeFingerprint)) {
    throw oatsError("E_UPGRADE_INTEGRITY", `the independent retirement baseline at ${path} is missing or invalid; restore the original baseline or respawn the instance before upgrading; no retirement authority was replaced`);
  }
  return { path, baseline, digestVersion };
}

function upgradeHomeFingerprint(home, baseline, digestVersion, transientHomePaths) {
  const transientFiles = retirementTransientFiles(home, transientHomePaths);
  // Retire resolves exclusions from the independent spawn record and verified
  // extra trees, never from the newly installed capability manifests.
  const extraTrees = extraWorktreesOf(home);
  const homeExclusions = resolveHomeExclusions(home, baselineDisposableHome(baseline), extraTrees);
  const digest = storedTreeDigest(home, digestVersion, { excludeRoot: homeExclusions.excludeRoot, excludePaths: transientFiles.map(file => file.relative), instanceHome: true });
  assertRetirementTransientsUnchanged(transientFiles);
  return digest;
}

/** Read before upgrade creates previous copies or staging: the same stored
 * digest and exclusions retire compares with the original spawn baseline. */
export function retirementHomeChanged(home, { transientHomePaths = [] } = {}) {
  const { baseline, digestVersion } = upgradeRetirementBaseline(home);
  return baseline.homeFingerprint !== upgradeHomeFingerprint(home, baseline, digestVersion, transientHomePaths);
}

/** A dirty home retains its original baseline byte for byte, so old kernels
 * also preserve its pre-upgrade edits. A clean home's authorized module move
 * changes only homeFingerprint; work, exclusion and runtime authority stay as
 * recorded, including a legacy digest version or its absence. */
export function rebaseUpgradeRetirementBaseline(home, { homeChangedSinceSpawn } = {}) {
  if (typeof homeChangedSinceSpawn !== "boolean") throw oatsError("E_BAD_ARGS", "upgrade baseline rebase needs the pre-upgrade homeChangedSinceSpawn boolean");
  const { path, baseline, digestVersion } = upgradeRetirementBaseline(home);
  if (homeChangedSinceSpawn) return;
  const homeFingerprint = upgradeHomeFingerprint(home, baseline, digestVersion, [".oats-start.lock"]);
  writeJsonAtomic(path, { ...baseline, homeFingerprint }, 0o600);
}

/** Project transaction-owned temporary files out of this baseline only. Later
 * fingerprints still hold them: a stale mutex is work to preserve, not invisible state. */
export function writeRetirementBaseline(home, work, mode, capabilities, runtime, { exclusive = false, incarnationId, executionBinding, transientHomePaths = [] } = {}) {
  const transientFiles = retirementTransientFiles(home, transientHomePaths);
  if (mode === "directory") assertDirectoryRoots(home);
  const isWorktree = mode === "worktree";
  const statusBytes = isWorktree && existsSync(work) ? worktreeStatusBytes(work) : Buffer.alloc(0);
  const disposableReceipts = isWorktree ? retirementDisposableRoots(work, capabilities) : [];
  const disposableHome = retirementDisposableHome(capabilities);
  const baseline = {
    version: RETIRE_BASELINE_VERSION,
    digestVersion: BASELINE_DIGEST_VERSION,
    ...(incarnationId ? { incarnationId, executionBinding } : {}),
    ...(mode === "directory" ? { directoryWork: true, directoryRoots: { home: directoryRootIdentity(home), work: directoryRootIdentity(work) } } : {}),
    home: canonicalHomePath(home),
    homeFingerprint: storedTreeDigest(home, BASELINE_DIGEST_VERSION, { excludeRoot: resolveHomeExclusions(home, disposableHome).excludeRoot, excludePaths: transientFiles.map(file => file.relative), instanceHome: true }),
    disposableReceipts,
    disposableHome,
    generatedWorkFingerprint: isWorktree ? generatedWorkDigest(work, statusBytes, disposableReceipts.map((r) => r.root)) : undefined,
    runtime: {
      launched: runtime?.launched === true,
      ...(runtime?.tmux ? { tmux: { session: runtime.tmux.session, window: runtime.tmux.window, ...(runtime.tmux.socket ? { socket: resolve(runtime.tmux.socket) } : {}) } } : {}),
    },
  };
  assertRetirementTransientsUnchanged(transientFiles);
  const path = retirementBaselinePath(home);
  mkdirSync(dirname(path), { recursive: true });
  // Replacements must leave readable independent session authority even if a
  // short write or SIGKILL interrupts publication. Spawn's exclusive option
  // still creates directly with wx and never replaces an existing receipt.
  if (exclusive) writeFileSync(path, JSON.stringify(baseline, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  else writeJsonAtomic(path, baseline, 0o600);
}

/** The repositories a recovery rebuilds from a clone, under a worktree at
 *  any depth → their paths, as bytes: each directory (never a link to one)
 *  whose `.git` stat finds, a link to one followed. Names are read as bytes,
 *  so a directory whose name is not UTF-8 is found, not missed. The walk does
 *  not go into a repository it found: no path is under another, and a
 *  repository inside one is no root of its own (it comes along as its
 *  parent's plain files, its `.git` included: repositoriesUnder's `inner`). */
function nestedGitRoots(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of entriesAsBytes(dir)) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      const path = joinBytes(dir, e.name);
      if (existsSync(joinBytes(path, GIT_NAME))) { out.push(path); continue; }
      walk(path);
    }
  };
  walk(pathBytes(root));
  return out;
}

/** Whether the recovery can copy the branch recorded at spawn: only when Git
 *  shows it (exit 0). Asked by a quarantine retry for a worktree that is gone:
 *  a failed spawn's rollback may have deleted the branch. A branch Git cannot
 *  show (absent, or a damaged ref) is not copied; no retire deletes it, so it
 *  stays in the repository, and the quarantine's own check of the branch says
 *  whether it could be shown gone. */
function recordedBranchExists(repo, branch) {
  if (!repo || !branch) return true;
  const r = retireGitProbe(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  return !r.error && r.status === 0;
}










function tmuxServerLost(e) { return tmuxServerAbsence(e) !== null; }
/** Whether the tmux server of `home`'s recorded session is gone, judged from `error`, a failed tmux
 *  call on its socket (#921). No server on the socket is gone. A missing socket file is gone only when
 *  no process works in the home (#624); otherwise `why` says what is not established. Any other
 *  failure is not gone, with no `why`. → { gone, why } */
export function sessionServerGone(home, error, io) {
  const absence = tmuxServerAbsence(error);
  const why = absence === "missing-socket" ? missingSocketUnestablished(tmuxFailure(error, error.message), processesInHome(home, io)) : null;
  return { gone: absence !== null && !why, why };
}
/** Which process scan this host offers, checked cheaply and without scanning (doctor reports it):
 *  /proc on Linux, else lsof when it is on PATH. → { mechanism: "proc" | "lsof" } | { mechanism: null, error } */
export function processScanAvailability() {
  const proc = procReadable();
  if (proc.ok) return { mechanism: "proc" };
  if (process.env.PATH !== undefined && lookupOnPath("lsof", process.env.PATH)) return { mechanism: "lsof" };
  return { mechanism: null, error: `${proc.error}, and lsof is not on PATH` };
}
/** Doctor's information line when this host has no process scan (`availability`, from
 *  processScanAvailability); none when it has one. */
export function processScanInformation(availability = processScanAvailability()) {
  if (availability.mechanism) return [];
  return [`process-scan-unavailable: ${availability.error}; retire refuses where it must rule out a live process in an instance home (a home without its session receipt, a missing recorded tmux socket, a Herdr home), and session start/stop refuse when a recorded tmux socket is missing; install lsof`];
}
/**
 * The live processes (other than this one and its direct children) whose working directory is
 * inside `home`, from one scan of the host (hostProcesses: /proc on Linux, else lsof). A pid and a
 * program name, never an argument list.
 * → { ok: true, processes: [{pid, command}] } | { ok: false, error } (the scan could not run, did
 * not complete or listed no process: a caller must treat that as unknown, never as none).
 */
export function processesInHome(home, io) {
  const scan = hostProcesses(io);
  return scan.ok ? { ok: true, processes: processesWorkingIn(scan.processes, home) } : scan;
}

/**
 * A home without a valid independent session receipt (spawned before 0.25.9)
 * has no endpoint OATS may quiesce. It can still be observed ABSENT, which is
 * all a retirement needs: `{ absent: true, backend, note }` only when
 * instance.json records no launch, or the recorded tmux server is gone, or it
 * no longer has the recorded window and no pane on it works in this home —
 * AND no live process on the host works in the home (a harness started by
 * hand on another server is invisible to the recorded endpoint).
 * Anything else (the window is there, a pane or a process works in the home,
 * the process scan cannot run, a launch without an endpoint,
 * tmux failing otherwise) is `{ absent: false, note }`: live or ambiguous,
 * never killed on mutable metadata.
 */
export function observeSessionWithoutReceipt(home, meta, io) {
  const recorded = recordedSessionAbsence(home, meta, io);
  if (!recorded.absent) return recorded;
  const scan = processesInHome(home, io);
  if (!scan.ok) return { absent: false, backend: recorded.backend, note: `could not scan for a process working in this home (${scan.error})` };
  if (scan.processes.length) return { absent: false, backend: recorded.backend, note: `a process works in this home (${namedProcesses(scan.processes)}); stop it, then retire` };
  return recorded;
}
function recordedSessionAbsence(home, meta, io) {
  const tmux = meta?.tmux;
  // A --no-launch home keeps its planned tmux names with `launched: false`: nothing was started there.
  if (meta?.launched !== true) return { absent: true, backend: null, note: "no session receipt (a home from before 0.25.9); instance.json records no launch" };
  if (!tmux) return { absent: false, backend: null, note: "instance.json records a launch but no session endpoint" };
  if (![tmux.session, tmux.window, tmux.socket].every((v) => typeof v === "string" && v.length > 0)) return { absent: false, backend: "tmux", note: "instance.json records an incomplete tmux endpoint" };
  const where = `${tmux.session}:${tmux.window} on ${tmux.socket}`;
  let rows;
  try { rows = tmuxOn(tmux.socket, ["list-panes", "-a", "-F", "#{session_name}\t#{window_name}\t#{pane_current_path}"], io).split("\n").filter(Boolean).map((l) => l.split("\t")); }
  catch (e) {
    if (tmuxServerLost(e)) return { absent: true, backend: "tmux", note: `no session receipt (a home from before 0.25.9); the recorded tmux server ${tmux.socket} is not running` };
    return { absent: false, backend: "tmux", note: `tmux could not list ${tmux.socket}: ${String(e.stderr ?? e.message ?? "").trim() || "tmux failed"}` };
  }
  if (rows.some(([s, w]) => s === tmux.session && w === tmux.window)) return { absent: false, backend: "tmux", note: `the recorded window ${where} is still present` };
  // tmux reports each pane's cwd in its on-disk spelling: the home is compared in it too.
  const realHome = canonicalHomePath(home);
  const inHome = rows.find(([, , cwd]) => { const p = cwd ? canonicalHomePath(cwd) : ""; return p === realHome || p.startsWith(`${realHome}/`); });
  if (inHome) return { absent: false, backend: "tmux", note: `a tmux pane (${inHome[0]}:${inHome[1]}) on ${tmux.socket} works in this home` };
  return { absent: true, backend: "tmux", note: `no session receipt (a home from before 0.25.9); the recorded window ${where} is gone` };
}
/** K3: quiesce one instance's session and RETAIN everything else — home,
 *  worktree, transcript, launch configuration — so `restart` can bring it back.
 *  Exactly restart's stop half under the same independent endpoint authority
 *  (`instanceSessionTarget`), bounded and never escalated: a harness still
 *  there after the grace is reported still running, nothing is killed harder.
 *  A no-launch or already-idle instance is a no-op that says so. A missing socket
 *  file is idle only when no process works in the home (#624). */
export function stopInstanceSession(home, o = {}) {
  if (typeof home !== "string" || !isAbsolute(home)) throw oatsError("E_BAD_ARGS", "session stop needs an absolute instance home");
  requireStopGrace(o.graceMs);
  // Under the home's lifecycle claim, the caller's (STOP_UNDER_CLAIM: a stop apply holds the claim
  // of every target before it stops the first) or, for the span of this one stop, its own (a
  // retire stopping a recorded child): no retire inspects or removes a home this stop writes
  // into, and a holder is answered before anything is signalled (lifecycleClaimRefusals:
  // E_INSTANCE_RETIRING beside a retire, E_LIFECYCLE_BUSY beside a stop). A home that is not
  // there has no claim to take and nothing to stop: it answers as it always did.
  if (o[STOP_UNDER_CLAIM] || !existsSync(home)) return stopSessionClaimed(home, o);
  const held = claimHomeFor("stop", basename(home), home);
  try { return stopSessionClaimed(home, o); } finally { releaseHomeClaim(held); }
}
/** An option of stopInstanceSession: the caller holds the home's lifecycle claim (claimHomeFor)
 *  for this stop. A symbol, so no caller can set it from parsed arguments or JSON. */
export const STOP_UNDER_CLAIM = Symbol("oats.stopUnderClaim");
/** Refuse a stop's grace that is not 1-300000 ms (undefined is the default): before any effect. */
export function requireStopGrace(graceMs) {
  if (graceMs !== undefined && (!Number.isSafeInteger(graceMs) || graceMs < 1 || graceMs > 300000)) throw oatsError("E_BAD_ARGS", "stop grace must be 1-300000 ms");
}
/** The start a stop ends: the home's recorded `startId`, null when it records none (or cannot be read). */
function stopStartId(home) {
  const id = readJsonOrUndefined(join(home, "instance.json"))?.startId;
  return typeof id === "string" && id ? id : null;
}
/** Record that OATS stopped the session of `home`'s current start (lib/session-end.mjs): the stop
 *  receipt `.oats-stop.json`, `stop` being what was done to the harness (stopHarness's receipt, or
 *  null when nothing was signalled). Its `startId` names the start, so the home reads `stopped`
 *  and no resume brings that start back. The one writer of the receipt: a stop, an idle stop, and
 *  a retire and a restart before they end the session. Throws what the write throws. */
function recordStop(home, stop) {
  writeJsonAtomic(join(home, STOP_RECEIPT_FILE), { instance: basename(home), at: new Date().toISOString(), stop, retained: ["home", "work", "transcript", "launch"], startId: stopStartId(home) });
}
/** An explicit stop of a launched home found idle whose session reads `lost` (the host went down or
 *  its tmux server died; or a home from before 0.69 whose harness ended): nothing is signalled, but
 *  the stop is recorded (`stop: null`), so a resume does not bring the home back. Best effort: a
 *  home that cannot be written (a full disk) answers as any idle stop, and stays `lost`. */
function recordIdleStop(realHome) {
  const meta = readJsonOrUndefined(join(realHome, "instance.json"));
  if (meta?.launched !== true || sessionEndOf(realHome, meta) !== SESSION_END.LOST) return;
  try { recordStop(realHome, null); }
  catch { /* the idle stop's answer is unchanged: see above */ }
}
/** The stop of stopInstanceSession, under the home's claim. The pending self-retire marker is read
 *  here, under it: a `--self` retire writes the marker while it holds the claim. */
function stopSessionClaimed(home, o) {
  const realHome = realPathOrNearest(home);
  // `signalling`: the stop reached the step that signals the harness; `receipt`: that step's answer.
  let signalling = false, receipt;
  try {
    if (existsSync(retirePendingMarkerPath(realHome))) throw oatsError("E_INSTANCE_RETIRING", `${basename(realHome)} is being retired; nothing was stopped`);
    const s = instanceSessionTarget(realHome);
    if (!s.target) return { home: s.home, backend: null, stopped: false, alreadyIdle: true, state: "not-launched", receipt: null };
    let before;
    try { before = inspectSessionTarget(s.target); }
    catch (e) {
      const lost = sessionServerGone(realHome, e, o.io);
      if (lost.gone) before = { present: false, state: "stopped" };
      else throw oatsError("E_SESSION_UNAVAILABLE", `cannot establish whether ${basename(realHome)} is running, so nothing was stopped: ${lost.why ?? e.message}`);
    }
    if (!before.present || before.state === "shell" || before.state === "stopped") {
      recordIdleStop(realHome);
      return { home: s.home, backend: s.target.backend, stopped: false, alreadyIdle: true, state: before.state, receipt: null };
    }
    signalling = true;
    receipt = stopHarness(s.target, { graceMs: o.graceMs ?? 20000, kill: o.io?.kill, sleep: o.io?.sleep });
    recordStop(realHome, receipt);
    appendEvent(realHome, { kind: receipt.exited ? "stopped" : "stop-refused", data: { signal: receipt.signal, waitedMs: receipt.waitedMs, stillRunning: receipt.stillRunning ?? [], state: receipt.state } });
    if (!receipt.exited) throw Object.assign(oatsError("E_SESSION_STOP_FAILED", `${basename(realHome)} was asked to stop (${receipt.signal} to ${receipt.requested.map((r) => `${r.comm} pid ${r.pid}`).join(", ")}) and is still running after ${receipt.waitedMs} ms; nothing was escalated`), { receipt });
    return { home: s.home, backend: s.target.backend, stopped: true, alreadyIdle: false, state: receipt.state, receipt };
  } catch (e) {
    // An error that is not the kernel's (the home removed under the stop, a write refused) is a
    // stop that failed, never the system's code (awebai/oats#891): its text, and what is true of
    // the harness by then. The receipt goes with it, so the caller reports what it established.
    // A receipt alone is not a signal: stopHarness answers one for a harness it found idle, having
    // signalled nothing (`sentAt: null`), and names as "already gone" a process its signal missed.
    const reached = receipt?.sentAt != null && receipt.requested.some((r) => r.note !== "already gone");
    const harness = reached ? `its harness was signalled (${receipt.signal}) and ${receipt.exited ? "has exited" : "is still running"}`
      : receipt ? `no signal reached its harness, which ${receipt.exited ? "had already exited" : "was not seen to exit"}`
      : signalling ? "whether its harness was signalled is not known" : "its harness was not signalled";
    const failure = isAnswerCode(e?.code) ? e : Object.assign(asKernelError(e, "E_SESSION_STOP_FAILED", `${basename(realHome)}: ${e?.message ?? e}; ${harness}`), receipt ? { receipt } : {});
    if (signalling) stopsThatSignalled.add(failure);
    throw failure;
  }
}
/** What a failed stop (an error of stopInstanceSession) established of the processes it signalled,
 *  for its row of results: [] only when its receipt says the harness exited; the pids its receipt
 *  names as still alive; and null when nothing is established. That is a stop without a receipt,
 *  and one whose receipt says "not exited" and names no live pid: every process it signalled is
 *  gone but the session did not read as idle (stopHarness's last answer), so something still runs
 *  there that the stop cannot name. A reader takes [] as "stopped", which that is not. */
export function stillRunningOf(e) {
  const receipt = e?.receipt;
  if (!receipt) return null;
  if (receipt.exited) return [];
  return Array.isArray(receipt.stillRunning) && receipt.stillRunning.length ? receipt.stillRunning : null;
}
/** What a retire says of the recorded children that did not stop (`rows`, each `ok: false`). A
 *  child is "still running" only where its stop established processes that run (`stillRunning`
 *  lists them). Of any other nothing of the kind is known: its stop was refused before it began (a
 *  claim held, a self-retire scheduled) or failed, and it is said with its row's code. */
function childrenNotStopped(rows) {
  const established = (k) => Array.isArray(k.stillRunning) && k.stillRunning.length > 0;
  const running = rows.filter(established);
  return [...(running.length ? [`${running.map((k) => k.instance).join(", ")} ${running.length === 1 ? "is" : "are"} still running after a bounded stop`] : []),
    ...rows.filter((k) => !established(k)).map((k) => `${k.instance} could not be stopped (${k.code})`)].join("; ");
}

/** The errors of stopInstanceSession thrown once it had reached the step that signals the harness:
 *  whoever reports what a stop touched (a retire's `reached.sessionStopAttempted`) reads it here. */
const stopsThatSignalled = new WeakSet();

/** What a retire plan promises about recorded children, applied: each is stopped
 *  (default grace, never escalated) in the order given (the plan's: deepest first)
 *  and kept. Every outcome is collected, so a refusal names each child that is
 *  still running or whose stop could not be established. `signalled` is called
 *  for each child whose stop reached the step that signals its harness. */
function stopRecordedChildren(children, signalled) {
  return children.map((kid) => {
    try {
      const s = stopInstanceSession(kid.home, {});
      if (s.stopped) signalled?.();
      return { instance: kid.instance, home: kid.home, ok: true, stopped: s.stopped, alreadyIdle: s.alreadyIdle };
    } catch (e) {
      if (stopsThatSignalled.has(e)) signalled?.();
      reportDefect(e); // the error becomes a row here: its stack would otherwise be lost
      return { instance: kid.instance, home: kid.home, ok: false, code: kernelCode(e, "E_SESSION_STOP_FAILED"), message: e.message, stillRunning: stillRunningOf(e) };
    }
  });
}

export async function attachInstanceSession(home, { detachKey, statusLine, onSwept } = {}) {
  if (detachKey !== undefined) requireDetachKey(detachKey);
  const s = instanceSessionTarget(home);
  if (!s.target) throw oatsError("E_SESSION_NOT_RUNNING", "instance was not launched");
  return attachSessionTarget(s.target, { detachKey, statusLine, onSwept });
}

export function inputInstanceSession(home, text) {
  if (typeof text !== "string" || !text.trim() || text.includes("\0") || Buffer.byteLength(text) > 256 * 1024) throw oatsError("E_BAD_ARGS", "session input must be nonempty text without NUL, at most 256 KiB");
  const s = instanceSessionTarget(home);
  if (!s.target) throw oatsError("E_SESSION_NOT_RUNNING", "instance was not launched");
  try { return { home: s.home, ...inputSessionTarget(s.target, text) }; }
  catch (e) { throw oatsError("E_SESSION_INPUT_FAILED", `cannot submit session input: ${e.message}`); }
}

// ---------------------------------------------------------------- session start

/** A recorded command with its harness's safe task prompt: a `"$(cat TASK.md)"` token becomes
 *  TASK_PROMPT[harness]. Applied when a home starts from its recorded command, which is saved so. */
export function withSafeTaskPrompt(command, harness) {
  const { tokens } = parseLaunchCommand(command);
  if (!tokens.some((t) => t.kind === "prompt")) return command;
  if (!Object.hasOwn(TASK_PROMPT, harness)) throw oatsError("E_LAUNCH_COMMAND_UNSUPPORTED", `a ${harness} command never carried the task as "$(cat TASK.md)"; inspect the saved command in instance.json`);
  return renderLaunchCommand(tokens.map((t) => t.kind === "prompt" ? { kind: "word", value: TASK_PROMPT[harness], quoted: true, text: shq(TASK_PROMPT[harness]) } : t));
}


export function renderLaunchCommand(tokens) { return tokens.map((t) => t.text).join(" "); }

/** The persisted command with `model` as its --model value: an existing
 *  --model value is replaced; otherwise the pair is inserted right after the
 *  binary, before any option that could be waiting for a value. Capability
 *  env, flags, launch args and the prompt expression are untouched. */
export function withLaunchModel(command, model) {
  const { tokens, binary, modelIndex } = parseLaunchCommand(command);
  const valueToken = { kind: "word", value: model, quoted: true, text: shq(model) };
  if (modelIndex >= 0) tokens[modelIndex] = valueToken;
  else tokens.splice(binary + 1, 0, { kind: "word", value: "--model", quoted: false, text: "--model" }, valueToken);
  return renderLaunchCommand(tokens);
}


/** Write `value` as JSON at `path` through a private file beside it (`<path>.tmp-<pid>`), renamed
 *  over it, by the kernel's one such writer (lib/write-through-private-file.mjs): when the write or
 *  the rename fails the private file is removed and the error thrown is that failure's
 *  (awebai/oats#963, #1076). */
function writeJsonAtomic(path, value, mode) {
  writeThroughPrivateFile(path, `${path}.tmp-${process.pid}`, JSON.stringify(value, null, 2) + "\n", mode);
}
/** The kernel's write of a home's record, the record of a live session's home among them: a status,
 *  a listing or a start that reads it meets the record before or after, never part of one (#1659,
 *  #1660). The record keeps the mode it has, exactly: the private file's mode is what the rename
 *  leaves, the retirement baseline digests it, and the process writing may not be the one that made
 *  the home. A record not yet there takes lib/materialize.mjs's; a mode that cannot be read refuses
 *  the write, never a guess. The one exception to whole records is a retire's lineage repair. */
export function writeHomeRecord(home, meta) {
  const path = join(home, "instance.json");
  let mode;
  try { mode = statSync(path).mode & 0o7777; } catch (e) { if (e.code !== "ENOENT") throw e; }
  writeThroughPrivateFile(path, `${path}.tmp-${process.pid}`, JSON.stringify(meta, null, 2) + "\n", mode ?? 0o644, { exact: mode !== undefined });
}

// ---------- stopping a harness, selecting on an existing home ----------
/** The harness processes under a tmux session target: EVERY descendant
 *  of the agent's pane's launcher process (`paneId`, when given, the pane the caller inspected) (the launcher shell itself is left so
 *  that, once its command ends, it becomes the fallback shell the start
 *  path recognizes); a wrapper that does not exec the harness, the harness
 *  and their children are all included, topmost first. Each row:
 *  { pid, ppid, pgid, comm, depth }. */
export function harnessProcesses(target, io, { paneId } = {}) {
  const ps = () => ((io?.exec || execFileSync)("ps", ["-axo", "pid=,ppid=,pgid=,comm="], { encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }))
    .split("\n").map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean)
    .map(([, pid, ppid, pgid, comm]) => ({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), comm: basename(comm).replace(/^-/, "") }));
  // The agent's pane (resolveAgentPane), never the first one listed: a split's pane is never signalled.
  const panes = tmuxOn(target.socket, ["list-panes", "-t", `=${target.session}:=${target.window}`, "-F", `#{pane_id}\t#{pane_pid}\t#{${AGENT_PANE_OPTION}}`], io)
    .split("\n").filter(Boolean).map((line) => { const [id, pid, mark = ""] = line.split("\t"); return { paneId: id, pid, mark }; });
  if (!panes.every((p) => /^%\d+$/.test(p.paneId))) throw oatsError("E_SESSION_UNKNOWN", "invalid tmux pane response");
  const { pane, error } = resolveAgentPane(panes, target.window);
  if (error) throw oatsError("E_SESSION_UNKNOWN", `${error}; nothing was signalled`);
  // `paneId`: the pane the caller inspected. Another one now is no pane to signal on that reading.
  if (paneId && pane?.paneId !== paneId) throw oatsError("E_SESSION_UNKNOWN", `the agent's pane was ${paneId} and is now ${pane?.paneId ?? "gone"}; nothing was signalled`);
  if (!/^\d+$/.test(pane?.pid || "")) throw oatsError("E_SESSION_UNKNOWN", "tmux returned no pane process id");
  const panePid = Number(pane.pid);
  const rows = ps();
  const byParent = new Map();
  for (const r of rows) { if (!byParent.has(r.ppid)) byParent.set(r.ppid, []); byParent.get(r.ppid).push(r); }
  const out = [];
  const walk = (pid, depth) => { for (const child of byParent.get(pid) || []) { out.push({ ...child, depth }); walk(child.pid, depth + 1); } };
  walk(panePid, 1);
  return out;
}
/** Ask the harness under `target` to end: SIGTERM to every process found
 *  under the pane's launcher, one by one, topmost first (no process-group
 *  signalling: the launcher shell must survive to become the fallback
 *  shell), then a bounded wait for the signalled processes to be gone and
 *  the session to read as stopped or a bare shell. Nothing is escalated: a
 *  harness still there when the wait ends is reported as such, still
 *  running. Elapsed time is never taken as exit. */
export function stopHarness(target, { graceMs = 20000, signal = "SIGTERM", io = {}, kill = process.kill, sleep } = {}) {
  const wait = sleep || ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  // "Already idle" must be a STABLE reading: the shell-vs-harness decision walks
  // `ps`, which under load can miss a just-forked descendant for one sample.
  // One momentary "shell" must never be taken as exit with nothing signalled.
  const idle = (s) => !s.present || s.state === "shell" || s.state === "stopped";
  let before = inspectSessionTarget(target, io);
  if (idle(before)) { wait(250); const again = inspectSessionTarget(target, io); if (idle(again)) return { requested: [], signal, sentAt: null, observedAt: new Date().toISOString(), exited: true, waitedMs: 0, state: again.state, stillRunning: [] }; before = again; }
  const procs = harnessProcesses(target, io, { paneId: before.paneId });
  if (!procs.length) throw oatsError("E_SESSION_UNKNOWN", `the session reads as ${before.state} but no harness process was found under its pane; nothing was signalled`);
  const requested = [];
  const sentAt = new Date().toISOString();
  for (const r of procs) {
    try { kill(r.pid, signal); requested.push({ pid: r.pid, pgid: r.pgid, comm: r.comm, signal }); }
    catch (e) { if (e.code !== "ESRCH") throw oatsError("E_SESSION_STOP_FAILED", `could not signal ${r.comm} (pid ${r.pid}): ${e.message}`); requested.push({ pid: r.pid, pgid: r.pgid, comm: r.comm, signal, note: "already gone" }); }
  }
  const started = Date.now();
  const alive = (pid) => { try { kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
  let st = before, idleStreak = 0;
  while (Date.now() - started <= graceMs) {
    wait(250);
    try { st = inspectSessionTarget(target, io); } catch { st = { present: true, state: "unknown" }; }
    const gone = requested.every((r) => !alive(r.pid));
    idleStreak = gone && idle(st) ? idleStreak + 1 : 0;
    // Exit needs two consecutive agreeing samples, not one.
    if (idleStreak >= 2) return { requested, signal, sentAt, observedAt: new Date().toISOString(), exited: true, waitedMs: Date.now() - started, state: st.state };
  }
  return { requested, signal, sentAt, observedAt: null, exited: false, waitedMs: Date.now() - started, state: st.state, stillRunning: requested.filter((r) => alive(r.pid)).map((r) => r.pid) };
}

/** Where a home's launch providers' manifests are read: its own module copies
 *  (a workspace-model home), else nowhere. */
function launchManifestDir(home, meta) {
  return home && isWorkspaceHome(meta) ? home : null;
}
/** The providers captured for a home: every recorded capability binding
 *  (meta.capabilityRuntime) united with every recorded contribution's id,
 *  each with its contribution (if it made one) and its captured settings.
 *  Already-recorded metadata; a provider bound to the scope after the spawn
 *  is not in it. */
export function capturedProviders(meta, frozen) {
  const contributions = (frozen?.hooks?.contributions || []).filter((c) => c.capability);
  const bindings = Array.isArray(meta?.capabilityRuntime) ? meta.capabilityRuntime : [];
  const ids = [...new Set([...bindings.map((b) => b.id), ...contributions.map((c) => c.capability)])].filter(Boolean);
  return ids.map((id) => {
    const contribution = contributions.find((c) => c.capability === id) || null;
    const binding = bindings.find((b) => b.id === id) || null;
    // The origins travel with the settings they describe (the contribution's, else the binding's).
    const settingsOrigins = (contribution?.settings ? contribution.settingsOrigins : binding?.settingsOrigins) ?? {};
    return { id, contribution, binding, settings: contribution?.settings ?? binding?.settings ?? {}, settingsOrigins };
  });
}
/** Capability contributions for a start of an existing home: the recorded
 *  ones, refreshed by any capability that declares a `launch` hook (asked
 *  for the target harness; spawn hooks are never re-run). A harness change
 *  needs the new harness's launch arguments from every capability that
 *  contributed harness-specific ones.
 *  The hook contract: a launch hook may do idempotent provider registration
 *  on a real start. A capability whose manifest (the home's module copy)
 *  declares `launchPreview: true` promises that its hook changes nothing
 *  under OATS_LAUNCH_PREVIEW=1 and returns the same contribution (launch
 *  arguments and env) either way, except for the env names its preview
 *  answer lists in `volatileEnv`, whose values only the real run knows.
 *  `pass` says which hooks run, and how:
 *  - "preview" (a launch preview): declaring hooks under the flag; the others
 *    do not run, and their recorded contributions stand (`notRun`);
 *  - "plan" (a start's preflight): declaring hooks under the flag, the others
 *    once, for real;
 *  - "real" (a start after its preflight passed): declaring hooks for real,
 *    over `frozen.hooks` = the planned contributions; startInstanceSession
 *    refuses a contribution that differs from the preview's. */
export function prepareLaunchHooks({ frozen, harness, resolvedCfg, home, meta, contextDir, extraEnv = {}, assertRoots, pass = "plan" }) {
  const contributions = (frozen.hooks?.contributions || []).map((c) => ({ ...c }));
  const env = { ...(frozen.hooks?.env || {}) };
  const refreshed = [];
  let warnings = [];
  // The providers that took part in this home's launch are the CAPTURED ones
  // (its recorded contributions). Each is resolved by id through the scope's
  // current installed manifest and trust, whatever the scope's bindings say
  // now: a captured provider that is no longer installed, or no longer
  // trusted, refuses the start; a provider bound to the scope after the
  // spawn is never adopted. A captured provider that declares a launch hook
  // prepares the target harness under its CAPTURED settings.
  const ctx = launchManifestDir(home, meta);
  const withLaunchHook = [];
  let hookMeta;
  for (const p of capturedProviders(meta, frozen)) {
    const manifest = ctx ? capabilityManifest(p.id, ctx) : undefined;
    if (!manifest) throw oatsError("E_LAUNCH_PREPARATION", `${p.id} was part of this home's launch at spawn but its module copy is missing from ${join(home, ".oats", "modules")}; respawn the instance; nothing was stopped`);
    const trust = capabilityTrust(manifest);
    if (!trust.trusted) throw oatsError("E_LAUNCH_PREPARATION", `${p.id} was part of this home's launch at spawn but is no longer trusted in the scope (${trust.reason || "not trusted"}); respawn the instance; nothing was stopped`);
    const hooks = manifestHookCommands(manifest);
    if (hooks.launch) withLaunchHook.push({ id: p.id, capability: p.id, manifest, layer: p.contribution?.layer ?? p.binding?.layer ?? manifest.layer ?? null, level: p.contribution?.level ?? p.binding?.level ?? null, settings: p.settings, settingsOrigins: p.settingsOrigins, hooks, trust, environment: [...(manifest.environment || [])], environmentNamespaces: [...(manifest.environmentNamespaces || [])], missingRequires: [] });

  }
  const aware = withLaunchHook.filter((c) => c.manifest.launchPreview === true);
  const unaware = withLaunchHook.filter((c) => c.manifest.launchPreview !== true);
  const runs = (pass === "real" ? [[aware, false]] : pass === "preview" ? [[aware, true]] : [[unaware, false], [aware, true]]).filter(([caps]) => caps.length);
  const notRun = pass === "preview" ? unaware.map((c) => c.id) : [];
  const previewed = runs.filter(([, asPreview]) => asPreview).flatMap(([caps]) => caps.map((c) => c.id));
  const volatileEnv = [];
  let hookDialogClaims;
  if (runs.length) {
    const results = runs.map(([caps, asPreview]) => ({ asPreview, res: runLifecycleHooks("launch", { assertRoots, home, instance: meta.instance, agentName: meta.agent, soulDir: instanceSoulDir(home, meta), contextDir: ctx, rootDir: dirname(dirname(dirname(home))), resolved: { ...(resolvedCfg || {}), capabilities: caps }, priorMeta: meta.capabilityMeta || {}, extraEnv: { OATS_HARNESS: harness, OATS_PREVIOUS_HARNESS: frozen.harness || "", OATS_RUNTIME: harness, OATS_PREVIOUS_RUNTIME: frozen.harness || "", ...(asPreview ? { OATS_LAUNCH_PREVIEW: "1" } : {}), ...extraEnv } }) }));
    const failed = results.flatMap(({ res }) => res.failures || []).map((f) => `${f.capability}: ${f.message}`);
    if (failed.length) throw oatsError("E_LAUNCH_PREPARATION", `a capability could not prepare the ${harness} launch:\n  ${failed.join("\n  ")}`);
    const fresh = results.flatMap(({ res }) => res.contributions || []);
    // Ownership holds across retained AND refreshed contributions, as the
    // spawn runner holds it across providers: a refreshed provider may
    // replace its own previous keys, never a key another provider retains,
    // nor one another provider's hook set in this pass.
    const refreshedIds = new Set(fresh.map((c) => c.capability));
    const retainedOwner = new Map();
    for (const c of contributions) if (c.capability && !refreshedIds.has(c.capability)) for (const name of c.env || []) retainedOwner.set(name, c.capability);
    const freshOwner = new Map();
    for (const c of fresh) for (const name of c.env || []) {
      if (retainedOwner.has(name)) throw oatsError("E_LAUNCH_PREPARATION", `${c.capability}'s launch hook set ${name}, which ${retainedOwner.get(name)} contributed at spawn and retains; one provider owns an environment name; nothing was stopped`);
      if (freshOwner.has(name) && freshOwner.get(name) !== c.capability) throw oatsError("E_LAUNCH_PREPARATION", `${c.capability}'s launch hook set ${name}, which ${freshOwner.get(name)}'s launch hook also set; one provider owns an environment name; nothing was stopped`);
      freshOwner.set(name, c.capability);
    }
    // A preview answer may name env whose values only the real run knows
    // (a credential minted at start). Each is a name the same hook returned,
    // and never a harness's configuration selector: the package probe reads
    // that under the preview's value before the real run.
    for (const { asPreview, res } of results) if (asPreview) for (const [id, names] of Object.entries(res.volatileEnv || {})) {
      if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) throw oatsError("E_LAUNCH_PREPARATION", `${id}'s launch hook answered volatileEnv that is not an array of environment names; nothing was stopped`);
      const returned = (res.contributions || []).find((c) => c.capability === id)?.env || [];
      for (const name of names) {
        if (!returned.includes(name)) throw oatsError("E_LAUNCH_PREPARATION", `${id}'s launch hook declared ${name} volatile but did not return it in env; nothing was stopped`);
        if (HARNESS_CONFIG_SELECTORS.has(name)) throw oatsError("E_LAUNCH_PREPARATION", `${id}'s launch hook declared ${name} volatile, but ${name} selects a harness's configuration, which the start's package probe reads before the real run; a volatile value must not affect harness package resolution; nothing was stopped`);
        volatileEnv.push(name);
      }
    }
    for (const c of fresh) {
      const idx = contributions.findIndex((x) => x.capability === c.capability);
      // The provider's previous contribution goes whole, its env names
      // included, before its new (validated) one is merged: an empty answer
      // is a replacement too.
      for (const name of contributions[idx]?.env || []) delete env[name];
      const row = { ...c, source: "launch-hook" };
      if (idx >= 0) contributions[idx] = row; else contributions.push(row);
      refreshed.push(c.capability);
    }
    for (const { res } of results) Object.assign(env, res.env || {});
    // What the caller records comes from real runs only; a launch preview
    // answers its own runs' warnings.
    const recorded = results.filter(({ asPreview }) => asPreview === (pass === "preview")).map(({ res }) => res);
    // A launch hook's `meta` is part of its documented return (the same shape
    // spawn persists as capabilityMeta). It was collected and then dropped
    // here, so a provider that re-issues a credential at every start — a
    // renewed session grant, for instance — left the ORIGINAL id on record and
    // retire undid the wrong one. Carry it to the caller; the start records it.
    const metaOf = Object.assign({}, ...recorded.map((res) => res.meta || {}));
    hookMeta = Object.keys(metaOf).length ? metaOf : undefined;
    // `dialogClaims` comes from real runs only: a preview's answer is never recorded.
    const answered = Object.assign({}, ...results.filter(({ asPreview }) => !asPreview).map(({ res }) => res.dialogClaims));
    hookDialogClaims = Object.keys(answered).length ? answered : undefined;
    // The hooks' advisory warnings go to the start's answer and events, as
    // spawn's do; they were dropped here before 0.30.
    warnings = recorded.flatMap((res) => res.warnings || []);
  }
  // A hook not run for a preview keeps its recorded contribution: whether it
  // has arguments for the target harness is its own run's answer, at start.
  const unprepared = contributions.filter((c) => !refreshed.includes(c.capability) && !notRun.includes(c.capability) && c.launch && c.launch[frozen.harness] !== undefined && c.launch[harness] === undefined).map((c) => c.capability);
  if (unprepared.length) throw oatsError("E_LAUNCH_PREPARATION", `${unprepared.join(", ")} contributed ${frozen.harness} launch arguments at spawn and none for ${harness}; change that capability's setting (for example its delivery mode), or the provider must declare a launch hook; nothing was stopped`);
  const launch = {};
  for (const c of contributions) { for (const [rt, args] of Object.entries(c.launch || {})) if (args) launch[rt] = `${launch[rt] ? `${launch[rt]} ` : ""}${args}`; }
  return { launch, env, contributions, refreshed, notRun, previewed, volatileEnv, warnings, ...(hookMeta ? { meta: hookMeta } : {}), ...(hookDialogClaims ? { dialogClaims: hookDialogClaims } : {}) };
}
/** Environment that selects which configuration (account, packages) a
 *  harness reads, under which the package probe inspects its packages. */
const HARNESS_CONFIG_SELECTORS = new Set(Object.values(HARNESS_FOLDER_VAR));


export function restartInstanceSession(home, o = {}) { return startInstanceSession(home, { ...o, restart: true }); }
/** Does this instance.json describe a workspace-model home (it records its modules)? */
export function isWorkspaceHome(meta) {
  return !!meta && typeof meta.modules === "object" && meta.modules !== null && !Array.isArray(meta.modules);
}
/** The refusal for a captured home: E_UNSUPPORTED_MODE (lead decisions on (e), D1). */
export function capturedHomeRefusal(home, what) {
  return Object.assign(oatsError("E_UNSUPPORTED_MODE", `${home} is a captured home (0.24–0.25; the captured/portable path was removed in 0.26): it has no 0.26 runtime — retire it (\`oats retire\` still works on it) and re-spawn from the deployment; ${what}`), { details: { home, captured: true } });
}
/** The capabilities whose spawn hooks ran in a captured home (its identities, memberships):
 *  retire cannot run their captured retire hooks, so it names them. */
export function capturedHomeCapabilities(meta) {
  const order = Array.isArray(meta?.captured?.hookOrder) ? meta.captured.hookOrder.filter((id) => typeof id === "string") : [];
  const withMeta = meta?.capabilityMeta && typeof meta.capabilityMeta === "object" ? Object.keys(meta.capabilityMeta) : [];
  return [...new Set([...order, ...withMeta])].sort();
}
/** The refusal for a home an earlier (0.25) kernel spawned: E_UNSUPPORTED_MODE. */
export function preWorkspaceHome(home, what) {
  return oatsError("E_UNSUPPORTED_MODE", `${home} is not a workspace-model home (it records no modules): it was spawned by an earlier kernel — re-spawn it from the deployment (\`oats retire\` still works on it); ${what}`);
}
/** The conversation a resume of `home` continues (feature session-resume, design §4): the newest
 *  transcript of this incarnation whose cwd is the home, in the locations its native-record receipts
 *  name (packages/record lib/last-conversation.mjs), `since` its recorded `createdAt` (a reused name
 *  reuses the path). → { harness, sessionId } or { harness, reason, warning? }: no conversation (R2)
 *  is the ordinary fresh start on TASK.md. Codex is never resumed until a signed-in host proves it
 *  end to end (`resume-unproven`). A lookup that fails is a fresh start too, and says why. */
export function resumeConversation(home, meta) {
  const harness = meta.launch?.harness ?? meta.harness;
  if (harness === "codex") return { harness, reason: FRESH_REASON.RESUME_UNPROVEN };
  let found;
  try { found = lastConversation(home, { harness, since: meta.createdAt }); }
  catch (e) { return { harness, reason: FRESH_REASON.NO_CONVERSATION, warning: `the last conversation of ${meta.instance} could not be looked up (${e?.message ?? e}): it starts a fresh conversation on TASK.md` }; }
  return found?.sessionId ? { harness, sessionId: found.sessionId } : { harness, reason: found?.none === "no-receipts" ? FRESH_REASON.NO_RECEIPTS : FRESH_REASON.NO_CONVERSATION };
}
/** The `resume` object of a `session start --resume` answer (its one producer): what it continued
 *  (resumeConversation's `resume`), and `waiting` when the start succeeded and waits for its human. */
export function resumeAnswer(resume, waiting = null) {
  return { resumed: !!resume.sessionId, ...(resume.sessionId ? {} : { reason: resume.reason }), harness: resume.harness, ...(resume.sessionId ? { sessionId: resume.sessionId } : {}), ...(waiting ? { waiting } : {}) };
}
/** The pane a resumed launch runs in, from its creation's LAUNCH_PANE_FORMAT output; null when that
 *  output cannot be read (the watch is then skipped: it only reports). */
function resumePaneTarget(target, socket, output) {
  try { return { ...target, ...launchPaneTarget(socket, output) }; } catch { return null; }
}
export function startInstanceSession(home, o = {}) {
  if (typeof home !== "string" || !isAbsolute(home)) throw oatsError("E_BAD_ARGS", "session start needs an absolute instance home");
  if (o.resume !== true) return startClaimed("start", home, o);
  // --resume (feature session-resume) runs the recorded launch as it is: a launch choice cannot go with it.
  if (o.restart) throw oatsError("E_BAD_ARGS", "--resume brings back a session that was lost; it is not a restart: use session start --resume");
  const chosen = [[o.launchConfig !== undefined, "--launch-config"], [o.harness !== undefined, "--harness"], [o.model !== undefined && o.model !== null, "--model"], [o.yolo === true, "--yolo"], [o.yolo === false, "--no-yolo"], [o.reselectLaunch === true, "--reselect-launch"]].filter(([given]) => given).map(([, name]) => name);
  if (chosen.length) throw oatsError("E_BAD_ARGS", `--resume runs the launch this home recorded; it cannot be combined with ${chosen.join(", ")}; nothing was read or started`);
  return startClaimed("resume", home, o);
}
/** A start under the home's lifecycle claim, taken for `verb` ("start", or "resume" for --resume)
 *  for the whole start, as a retire, a stop and an upgrade take it (claimHomeFor): none of them runs
 *  while it starts, and it starts nothing beside one of them (lifecycleClaimRefusals:
 *  E_INSTANCE_RETIRING beside a retire, E_LIFECYCLE_BUSY beside a stop or an upgrade,
 *  E_SESSION_START_BUSY beside another start). What it reads under the claim (a resume: the retire
 *  it owes, whether its session is still lost) is what it starts from. A restart holds this one
 *  claim across its stop and its launch: its stop is stopHarness within the start, which takes no
 *  claim, so no retire comes between the two. The claim is released on every exit of the start;
 *  a start that dies leaves a holder that is gone, which the next taker takes over. A path with no
 *  record it can read (nothing there, a directory that is no home, a record that cannot be read) is
 *  no home to hold: it takes no claim, writes nothing beside itself and answers as it always did,
 *  as every lifecycle verb reads its record first (identifiedHomeRecord). The claim is the one of
 *  the home as it is on disk, through any link to the home itself, and the start runs on that path,
 *  never on the spelling it was given again: a link changed after the claim was taken does not move the
 *  start to a home whose claim it does not hold. A home given through a link is held to the home
 *  the given path names (requestedHomeGuard), before the claim. A spawn's own launch is no start
 *  here: it makes its window itself, and a retire handles a spawn in progress. */
function startClaimed(verb, home, o) {
  if (readHomeRecord(home).state !== "record") return startSession(home, o);
  const real = canonicalHomePath(home);
  let requested = null;
  if (real !== resolve(home)) {
    // The refusals a start of this spelling answered before any guard, in their order, before the
    // check of its authority: a link does not change what a start of the home as given answers.
    startRefusals(home, { partialUpgrade: !upgradeHoldsClaim(real) });
    requested = requestedHomeGuard(home, real);
  }
  const held = claimHomeFor(verb, basename(real), real);
  try { return startSession(real, requested ? { ...o, [REQUESTED_HOME_GUARD]: requested } : o); } finally { releaseHomeClaim(held); }
}
/** The check of the home as it was given (`home`), when its path on disk (`real`, where the start
 *  runs and claims) is another spelling. Its own independent authority, on the path as given
 *  (sessionDirectoryGuard reads that path's session receipt before it follows the path), and, for
 *  an owned directory home, that the path on disk is the home its receipt records: the two are
 *  bound by the paths the receipt names, never by two separate reads of the disk, so a directory
 *  home exchanged for a link to another home, even one restored between the two reads, starts
 *  nothing there. A spelling with no receipt of its own (a link outside the instances directory)
 *  names no home but the one it leads to. → the check, made again with every check of the
 *  start's roots (REQUESTED_HOME_GUARD). */
function requestedHomeGuard(home, real) {
  const check = sessionDirectoryGuard(home);
  let baseline;
  try { baseline = JSON.parse(readFileSync(findRetirementBaseline(home), "utf8")); } catch { return check; } // none, or refused by the check above
  if (baseline?.directoryWork === true && !receiptRecordsHome(baseline, receiptHomeIdentity(real))) throw oatsError("E_WORK_INSPECTION_FAILED", `${home} is an owned directory home, and its path leads to another home (${real}); restore the owned root before retrying start`);
  return check;
}
/** An option of startSession: the check of the authority of the home as it was given, when that
 *  spelling is not the home's path on disk (startClaimed). A symbol, so no caller can set it from
 *  parsed arguments or JSON. */
const REQUESTED_HOME_GUARD = Symbol("oats.requestedHomeGuard");
/** What a start of `home` refuses before any guard or receipt reads it, in this order. Without
 *  `partialUpgrade` it leaves a partial upgrade to the start's own claim (startClaimed: an upgrade
 *  that holds the claim makes the start busy, not partial). */
function startRefusals(home, { partialUpgrade = true } = {}) {
  // A home whose record is there and cannot be read is refused before anything of it is read (#896).
  identifiedHomeRecord(home);
  // A home opened in Herdr, or an earlier start that allocated a Herdr pane, is refused before any
  // guard or receipt reads it.
  refuseHerdrHome(realPathOrNearest(home));
  if (readJsonOrUndefined(join(realPathOrNearest(home), ".oats-start-pending.json"))?.target?.backend === "herdr") throw herdrInstanceRemoved(basename(realPathOrNearest(home)));
  if (existsSync(directoryRollbackPath(home))) throw oatsError("E_INSTANCE_RETIRING", `${home} has retained directory cleanup; restore and retire it before starting anything there`);
  assertKernelShimParents(home);
  if (partialUpgrade) assertNoPartialUpgrade(realPathOrNearest(home));
}
/** The start of startInstanceSession, its arguments checked, under the home's claim (startClaimed). */
function startSession(home, o) {
  startRefusals(home);
  const ownGuard = sessionDirectoryGuard(home), requestedGuard = o[REQUESTED_HOME_GUARD];
  const directoryGuard = requestedGuard ? () => { requestedGuard(); ownGuard(); } : ownGuard;
  {
    let metadata; try { metadata = parseStrictJson(readPortableBytes(join(home, "instance.json"))); } catch { /* the receipt checks below report unreadable metadata */ }
    if (isCapturedHome(metadata)) throw capturedHomeRefusal(home, "nothing was started");
  }
  const checkRoots = directoryGuard;
  const realHome = realPathOrNearest(home);
  let originalHomeIdentity;
  try { originalHomeIdentity = directoryIdentity(realHome); } catch { /* missing home reported below */ }
  const rawIo = o.io;
  const guardedExec = (...args) => { checkRoots(); return (rawIo?.exec || execFileSync)(...args); };
  o = { ...o, io: { ...rawIo, exec: guardedExec, kill: (...args) => { checkRoots(); return (rawIo?.kill || process.kill)(...args); } } };
  const metaPath = join(realHome, "instance.json");
  if (!existsSync(metaPath)) throw oatsError("E_RUNTIME_ENDPOINT_UNKNOWN", `${realHome} is not an OATS instance home (no instance.json); nothing was started`);
  const lock = join(realHome, ".oats-start.lock");
  const pendingPath = join(realHome, ".oats-start-pending.json");
  const exitedPath = join(realHome, ".oats-start-exited");
  // The same reader as the check above: a record that became unreadable since then refuses as there.
  const readMeta = () => {
    const record = identifiedHomeRecord(realHome);
    if (record.state !== "record") throw oatsError("E_RUNTIME_ENDPOINT_UNKNOWN", `cannot read ${metaPath}: it is no longer there`);
    return upgradeHomeMeta(record.meta, realHome);
  };
  // Workspace-model homes only (lead decision c3 Q2): a home an earlier kernel
  // spawned records no modules, and there is no scope configuration left to
  // re-resolve it against. Retire still works on it.
  if (!isWorkspaceHome(readMeta())) throw preWorkspaceHome(realHome, "nothing was started");
  let drift; // Read under the start lock, so an upgrade cannot swap modules between reads.
  let cleanupWarnings = [];
  // A missing socket file is a stopped server only when no process works in this home (#624): its
  // check, for a recorded session and for the OATS server lookup. A failed read of a recorded session
  // is `{ stopped: true }` when its server is gone (or its socket file is missing and that check
  // passes), else `{ stopped: false, why }`: the check's reason, or null for another failure.
  const missingSocket = (detail) => missingSocketUnestablished(detail, processesInHome(realHome, rawIo));
  const lostServer = (e) => {
    const lost = sessionServerGone(realHome, e, rawIo);
    return lost.gone ? { stopped: true } : { stopped: false, why: lost.why };
  };
  const launchFailure = (error) => {
    // execFileSync errors embed argv (including capability environment) in
    // message; backend stderr can echo it too. Neither belongs in the API.
    const reason = error.code === "ENOENT" ? "backend executable unavailable"
      : error.code === "ETIMEDOUT" || error.signal === "SIGTERM" ? "backend command timed out" : "backend command failed";
    return oatsError("E_SESSION_START_FAILED", `tmux start of ${basename(realHome)} could not be confirmed (${reason}); inspect the recorded session before retrying. Launch evidence is retained in ${pendingPath}`);
  };
  // The independent receipt first (retire and session consult it), then the
  // mutable metadata; both tmp+rename. A failure between them is what the
  // pending receipt exists for.
  const record = (meta, { id, target, model, command, startedAt, reused, launch, harness: newHarness, yolo: newYolo, stop, nativeRecordId, hookMeta, hookDialogClaims, modelFrom, launchFrom, launchAt, launchDeclared, launchPrompts, launchPromptTarget }, clearPending = true) => {
    checkRoots();
    const baselinePath = findRetirementBaseline(realHome);
    let baseline;
    try { baseline = JSON.parse(readFileSync(baselinePath, "utf8")); } catch (e) {
      if (e.code === "ENOENT") throw missingSessionReceipt(realHome);
      throw oatsError("E_RUNTIME_ENDPOINT_UNKNOWN", `independent session receipt is missing or unreadable for ${realHome}: ${e.message}`);
    }
    if (baseline.version !== RETIRE_BASELINE_VERSION || !receiptRecordsHome(baseline, canonicalHomePath(realHome)) || !runtimeAuthorityOf(baseline)) throw oatsError("E_RUNTIME_ENDPOINT_UNKNOWN", `independent session receipt is invalid for ${realHome}`);
    baseline.runtime = { launched: true, tmux: { session: target.session, window: target.window, socket: resolve(target.socket) } };
    writeJsonAtomic(baselinePath, baseline, 0o600);
    if (o.io?.failBeforeMetadataWrite && reused !== "adopted") throw new Error("injected metadata write failure"); // the write after THIS start's allocation
    const recorded = meta.startId === id;
    const restarts = (Array.isArray(meta.restarts) ? meta.restarts : []).slice(recorded ? -20 : -19);
    if (!recorded) restarts.push({ startedAt, model: model ?? null, reused });
    const next = { ...meta, model, command, launched: true, startId: id, restarts, restartCount: (meta.restartCount || 0) + (recorded ? 0 : 1), ...(modelFrom ? { modelFrom } : {}),
      ...(launch ? { launch } : {}), ...(newHarness ? { harness: newHarness } : {}), ...(newYolo !== undefined ? { yolo: newYolo } : {}),
      ...(launchFrom ? { launchFrom, launchAt: launchAt ?? null, launchDeclared: launchDeclared ?? null } : {}),
      // Launch-hook meta lands per capability over the spawn's record; a hook
      // that answered without meta keeps its previous entry (retire reads it).
      ...(hookMeta ? { capabilityMeta: { ...(meta.capabilityMeta || {}), ...hookMeta } } : {}) };
    if (hookDialogClaims) {
      next.dialogClaims = replacedDialogClaims(meta.dialogClaims, hookDialogClaims);
      if (!next.dialogClaims) delete next.dialogClaims;
    }
    // The record describes the last start, a start that did not engage the confirmation included.
    if (launchPrompts?.status === "not-engaged") { next.launchPrompts = launchPrompts; delete next.launchPromptTarget; }
    else if (launchPrompts) {
      next.launchPrompts = launchPrompts; next.launchPromptTarget = launchPromptTarget ?? target;
      next.launched = promptLaunched(launchPrompts.status);
    } else { delete next.launchPrompts; delete next.launchPromptTarget; }
    next.tmux = { session: target.session, window: target.window, socket: resolve(target.socket) };
    writeHomeRecord(realHome, next);
    if (clearPending) { checkRoots(); rmSync(pendingPath, { force: true }); }
    return { ...(drift.length ? { drift } : {}), instance: meta.instance, agent: meta.agent, home: realHome, harness: next.harness, backend: "tmux", model: model ?? null, launchConfig: next.launch?.launchConfig ?? null, yolo: next.yolo ?? null, target, startedAt, restartCount: next.restartCount, reused, warnings: cleanupWarnings, ...(launchPrompts ? { launchPrompts } : {}), ...(nativeRecordId ? { nativeRecordId } : {}), ...(stop ? { stop } : {}) };
  };
  try { mkdirSync(lock); }
  catch (e) {
    if (e.code === "EEXIST") {
      const retry = upgradeMutexRetry(realHome);
      if (retry) throw oatsError("E_SESSION_START_BUSY", `a package upgrade of ${basename(realHome)} holds the start mutex (${lock}); nothing was stopped or started. Retry ${retry} to finish the upgrade before starting`);
      throw oatsError("E_SESSION_START_BUSY", `another start of ${basename(realHome)} is in progress (${lock}); if no start is running, remove that directory and retry`);
    }
    throw e;
  }
  try {
    // Upgrade holds this same start lock while applying; re-read after taking it.
    assertNoPartialUpgrade(realHome);
    cleanupWarnings = upgradeCleanupWarnings(realHome);
    // Compare the frozen package copies with the local deployment lock; starting never moves them.
    const driftDeployment = dirname(dirname(dirname(dirname(realHome))));
    let driftLock;
    try { driftLock = deploymentLock(driftDeployment); }
    catch (error) {
      // Drift is advisory; an unreadable deployment lock cannot invalidate a frozen home's launch.
      cleanupWarnings.push(`package module drift could not be read from ${join(driftDeployment, "oats-lock.json")}: ${error.message}`);
    }
    drift = driftLock === undefined ? [] : packageUpgradeDrift(readMeta(), { lock: driftLock });
    // The package modules an upgrade cannot move (gone from the lock): one line naming the respawn.
    const respawn = driftLock === undefined ? null : packageRespawnWarning(readMeta(), { lock: driftLock });
    if (respawn !== null) cleanupWarnings.push(respawn);
    if (existsSync(join(realHome, ".oats-rollback-incomplete.json"))) throw oatsError("E_INSTANCE_RETIRING", `${realHome} is a quarantined home whose cleanup is incomplete; finish its retirement (oats retire) before starting anything there`);
    // A self-retirement leaves this marker while its detached teardown runs:
    // the home is about to disappear, so nothing is relaunched into it.
    if (existsSync(retirePendingMarkerPath(realHome))) throw oatsError("E_INSTANCE_RETIRING", `${basename(realHome)} is being retired (${retirePendingMarkerPath(realHome)} is present); nothing was started`);
    // A start that leaves the server the home recorded says so: one line per move (see the docs'
    // "Existing instances"), in the answer and as a launch-warning event.
    const movedWarnings = [];
    // 1. Reconcile a pending receipt before the equality gate: it may be the
    //    only record of a session an earlier start allocated.
    if (existsSync(pendingPath)) {
      let pending;
      try { pending = JSON.parse(readFileSync(pendingPath, "utf8")); } catch { pending = undefined; }
      const pt = pending?.target;
      const validTarget = pt?.backend === "tmux" && [pt.session, pt.window, pt.socket].every((v) => typeof v === "string" && v.length > 0) && isAbsolute(pt.socket);
      let validCommand = false;
      try { parseLaunchCommand(pending?.command); validCommand = true; } catch { /* preserve invalid receipt below */ }
      let validLaunch = true;
      if (pending?.launch !== undefined) { try { assertLaunchRecipe(pending.launch, "the pending start"); } catch { validLaunch = false; } }
      if (pending?.harness !== undefined && !LAUNCH_HARNESSES.includes(pending.harness)) validLaunch = false;
      if (pending?.yolo !== undefined && typeof pending.yolo !== "boolean") validLaunch = false;
      const validReceipt = validTarget && validCommand && validLaunch
        && typeof pending.id === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(pending.id)
        && (pending.model === null || (typeof pending.model === "string" && !!pending.model.trim() && !pending.model.includes("\0")))
        && typeof pending.startedAt === "string" && Number.isFinite(Date.parse(pending.startedAt));
      if (!validReceipt) throw oatsError("E_SESSION_UNKNOWN", `an earlier start left an unreadable or invalid receipt at ${pendingPath}; inspect it before retrying; nothing was started`);
      let st;
      checkRoots();
      try { st = inspectSessionTarget(pending.target, o.io); }
      catch (e) {
        const lost = lostServer(e);
        if (lost.stopped) st = { present: false, state: "stopped" };
        else throw oatsError("E_SESSION_UNKNOWN", `an earlier start of ${basename(realHome)} recorded a session (tmux ${pending.target.session}:${pending.target.window} on ${pending.target.socket}) that cannot be observed now: ${lost.why ?? (String(e.stderr ?? e.message ?? "").trim() || e.message)}; the receipt ${pendingPath} is kept and nothing was started`);
      }
      // A launch may still consist entirely of shells (startup files, a
      // shell-script harness). Only its own completion marker proves this
      // is a fallback shell. Never respawn an accepted launch in that gap.
      if (st.present && st.state === "shell") {
        const exited = readStartExited(realHome)?.startId === pending.id;
        if (!exited) throw oatsError("E_SESSION_START_BUSY", `${basename(realHome)} is still starting; refresh its status before retrying`);
      }
      const meta = readMeta();
      // A completed start (#691): its receipt names the start instance.json already records, on the
      // target it records. The receipt is history then, never authority: nothing of it is recorded
      // again, so a newer launch recipe or provider metadata stays as it is.
      const rt = meta.tmux;
      const sameTarget = rt && rt.session === pt.session && rt.window === pt.window && typeof rt.socket === "string" && !!rt.socket && resolve(rt.socket) === resolve(pt.socket);
      const running = st.present && st.state !== "shell";
      // The same start on another target is ambiguous while that other target runs; a restart once it
      // no longer runs is the way out (the recorded target is instance.json's, the ordinary path's).
      if (meta.startId === pending.id && !sameTarget && (!o.restart || running)) {
        throw oatsError("E_SESSION_UNKNOWN", `the start ${pending.id} of ${meta.instance} is recorded on tmux ${rt?.session ?? "?"}:${rt?.window ?? "?"} on ${rt?.socket ?? "?"} (\`oats session inspect --home ${realHome}\` shows it), but its receipt ${pendingPath} names tmux ${pt.session}:${pt.window} on ${pt.socket}; the receipt is kept and nothing was started. If that other target is not this instance's session, stop it (\`tmux -S ${shq(pt.socket)} kill-window -t ${shq(`=${pt.session}:=${pt.window}`)}\`), then run \`oats session restart --home ${realHome}\``);
      }
      if (meta.startId === pending.id) {
        if (running && !o.restart) {
          const asked = (o.model != null && String(o.model).trim() && resolveModelPreference(String(o.model), meta.harness) !== meta.model) || o.launchConfig !== undefined || o.harness !== undefined || o.yolo !== undefined || o.reselectLaunch === true;
          throw oatsError("E_SESSION_RUNNING", `${meta.instance} is already running; nothing was started${asked ? "; the requested model, launch configuration, harness or yolo was not applied: use session restart" : ""}`);
        }
        // A restart, or a target that is gone or a harness that exited: the ordinary start below
        // reads instance.json as it is, and its own receipt replaces this one when it launches. A
        // start refused before that leaves this receipt as it was. The completed start recorded its
        // own session boundary; it is not recorded again.
      } else {
        // Reconcile even an exited target: the independent baseline may
        // already name it while metadata still names the old allocation.
        // The adopted start's session boundary, at its launch time, completed
        // in whichever log the interrupted start did not record it. The receipt's
        // recipe names its configuration (null: the bare harness); only a receipt
        // without a recipe falls back to the recorded one.
        recordStartBoundary(realHome, { startId: pending.id, startedAt: pending.startedAt, harness: pending.harness ?? meta.harness ?? null, backend: "tmux", launchConfig: (pending.launch ? pending.launch.launchConfig : meta.launch?.launchConfig) ?? null, phase: "recovered" });
        const done = record(meta, { ...pending, model: pending.model ?? undefined, reused: "adopted" }, !st.present || st.state === "shell");
        // The adopted target is on another server than the home recorded (the start that allocated it
        // could not record it): this adoption records it, and says so once, here.
        const recordedSocket = typeof meta.tmux?.socket === "string" && meta.tmux.socket ? resolve(meta.tmux.socket) : null;
        if (recordedSocket && recordedSocket !== resolve(pending.target.socket)) {
          const message = sessionMovedWarning(meta.instance, recordedSocket, resolve(pending.target.socket));
          appendEvent(realHome, { kind: "launch-warning", data: { message } });
          movedWarnings.push(message);
        }
        if (st.present && st.state !== "shell") {
          if (o.restart) { rmSync(pendingPath, { force: true }); }
          else {
            // The recovered target runs what the receipt says; a choice made
            // now (model, configuration, harness, yolo) was not applied to it.
            if (o.model != null && String(o.model).trim() && resolveModelPreference(String(o.model), done.harness || meta.harness) !== done.model) throw oatsError("E_SESSION_RUNNING", `${meta.instance} is already running with its previously requested model; its target was recovered, but the new model was not applied`);
            if (o.launchConfig !== undefined || o.harness !== undefined || o.yolo !== undefined) throw oatsError("E_SESSION_RUNNING", `${meta.instance} is already running (its pending start was recovered); the requested launch configuration, harness or yolo was not applied; stop it, or use session restart`);
            return { ...done, warnings: [...done.warnings, ...movedWarnings] };
          }
        }
      }
    }
    // 2. The ordinary gate and observation, all under the lock.
    const receipt = instanceSessionTarget(realHome);
    const meta = readMeta();
    const harness = meta.harness;
    if (!["pi", "claude", "codex"].includes(harness)) throw oatsError("E_LAUNCH_COMMAND_UNSUPPORTED", `instance ${meta.instance || realHome} records harness ${JSON.stringify(harness)}, which this kernel cannot relaunch`);
    let command = meta.command;
    let model = meta.model || undefined;
    // What this start launches: the frozen command (optionally with another
    // model, re-rendered in place), or, under a selection, the recipe
    // re-resolved against the home's current scoped configuration. Every
    // preflight happens here, before anything is observed or stopped.
    // --reselect-launch (feature launch-preference): apply the home's launch layers now (souls.launch,
    // the recorded soul's launch, the host default) instead of the frozen recipe.
    // `launchOffered`: the caller's read of the workspace's souls (homeSoulsOffered), which the layers need
    // to tell a key of souls.launch that names no soul. A selection the layers would decide never goes on
    // without it: a key that was not checked must not let the launch fall through.
    const reselect = o.reselectLaunch === true ? homeLaunchLayers(realHome, meta, { offered: o.launchOffered }) : null;
    if (reselect?.needsOffered && o.launchConfig === undefined && o.harness === undefined) throw oatsError("E_BAD_ARGS", `--reselect-launch of ${meta.instance || realHome} needs a read of the workspace's souls: oats-local.yaml souls.launch holds a key besides "*" and this home's soul has no entry of its own (the caller passes that read as launchOffered: lib/instance-resolution.mjs homeSoulsOffered)`);
    // The session this start opens its window in when it has to create one, and what its creation
    // needs (planOatsTmuxSession), read at most once: by the plan's lookup or by the creation's preflight.
    const planSession = receipt.target?.session || meta.tmux?.session || DEFAULT_TMUX_SESSION;
    let sessionPlanRead;
    const sessionPlan = () => {
      if (!sessionPlanRead) { try { sessionPlanRead = { plan: planOatsTmuxSession(planSession, o.io, { missingSocket }) }; } catch (e) { sessionPlanRead = { error: e }; } }
      if (sessionPlanRead.error) throw sessionPlanRead.error;
      return sessionPlanRead.plan;
    };
    // The recorded target, observed once: by the plan's lookup, which must know whether the pane will
    // be reused before it chooses where to look, or by the gate below. A lost server is a stopped one
    // (lostServer); any other failure is the gate's refusal (E_SESSION_UNKNOWN), and the lookup does
    // not decide it.
    let recordedRead;
    const recordedState = () => {
      if (!recordedRead) {
        try { recordedRead = { state: receipt.target ? inspectSessionTarget(receipt.target, o.io) : { present: false, state: "not-launched" } }; }
        catch (e) { const lost = lostServer(e); recordedRead = lost.stopped ? { state: { present: false, state: "stopped" } } : { error: lost.why ? new Error(lost.why) : e }; }
      }
      return recordedRead;
    };
    // A pane the start reuses where it is: one the recorded target shows, running or left as a shell.
    const reusable = (state) => !!(state?.paneId && (state.present || state.state === "stopped"));
    const selected = reselect !== null || o.launchConfig !== undefined || o.harness !== undefined || o.yolo !== undefined;
    const hasRecipe = meta.launch && typeof meta.launch === "object";
    let launchPlan = null, launchHooksPass = null, handedExecutable, hookMeta, hookDialogClaims, explicitModelFrom = null, warnings = [];
    // --resume: only a home whose session was lost, read here, under the lock, before any launch hook
    // runs. Then the conversation it continues, or the reason it starts fresh (resumeConversation).
    let resume = null;
    if (o.resume === true) {
      if (!hasRecipe) throw oatsError("E_LAUNCH_LEGACY", `${meta.instance || realHome} records no launch recipe (an earlier kernel spawned it): re-spawn it from the deployment; nothing was changed`);
      const observed = recordedState();
      if (observed.error) { const e = observed.error; throw oatsError("E_SESSION_UNKNOWN", `cannot establish whether ${meta.instance} is running, so nothing was started: ${String(e.stderr ?? e.message ?? "").trim() || e.message}`); }
      if (observed.state.present && observed.state.state !== "shell") throw oatsError("E_SESSION_RUNNING", `${meta.instance} is running (${observed.state.state}); nothing was started`);
      // A home whose retire runs, cannot be told, failed or was interrupted is owed it, never a
      // resume (read as its status row reads it, under the claim this resume holds).
      const owed = owedRetire(realHome);
      if (owed) throw oatsError("E_INSTANCE_RETIRING", `${owedRetireSaid(meta.instance, owed.state)}; nothing was started`);
      const end = meta.launched === true ? sessionEndOf(realHome, meta) : "never-launched";
      if (end !== SESSION_END.LOST) throw oatsError("E_RESUME_NOT_LOST", `${meta.instance} did not lose its session (${end === "never-launched" ? "it was never launched" : `it ${end}`}); --resume brings back only a lost session; nothing was started (an ordinary session start opens a fresh conversation)`);
      resume = resumeConversation(realHome, meta);
    }
    if (selected || hasRecipe) {
      // Every start of a home with a recipe (ordinary, model-only, or under a
      // selection) goes through the one planner: recipe shape, the recorded
      // or selected executable, references, capability contributions under
      // the captured settings and current trust. A home without a recipe that
      // is asked for a selection is refused (E_LAUNCH_LEGACY).
      const context = meta.repo && existsSync(meta.repo) ? resolve(meta.repo) : dirname(dirname(dirname(dirname(realHome))));
      // o.teams / o.defaultTeam: the home's LIVE teams, computed by an async caller (liveTeams) —
      // the launch hook re-checks joined memberships against them.
      const resolvedCfg = resolvedFromHome(realHome, meta, { teams: o.teams, defaultTeam: o.defaultTeam, teamsSource: o.teamsSource });
      let agent; try { agent = findAgent(dirname(dirname(dirname(realHome))), meta.agent); } catch { agent = undefined; }
      // The environment the plan's checks read for this launch's pane (the harness lookup by name,
      // the package probe, folder trust): a pane the start will reuse, on its own recorded session,
      // whatever the OATS server holds; otherwise the session's or the server's when a server runs;
      // when none does, the environment this start will create the server with (read once, here,
      // for the plan and for the creation below). For a creator that may not create the server no
      // pane's environment is established: the plan's checks read this process's, and the refusal
      // comes at the creation's own place, after the start's other preflights.
      const pane = () => {
        const recorded = recordedState();
        if (reusable(recorded.state)) return paneEnvironment(receipt.target.socket, receipt.target.session, o.io, realHome);
        if (recorded.error) return NO_PANE_READ; // the gate refuses below; no check decides it
        const preview = planOatsTmuxSession(planSession, o.io, { preview: true, missingSocket });
        if (!preview || preview.server) return expectedPaneEnvironment(preview, planSession, o.io, realHome);
        try { return expectedPaneEnvironment(sessionPlan(), planSession, o.io, realHome); } catch (e) { if (isKernelCode(e?.code)) return SESSION_REFUSED; throw e; }
      };
      const plan = planLaunch({ home: realHome, instance: meta.instance, meta, contextDir: context, agentLike: agent || { harness: meta.harness, model: meta.model, yolo: meta.yolo }, selection: { launchConfig: o.launchConfig, harness: o.harness, model: o.model, yolo: o.yolo }, reselect, resolvedCfg, env: o.env || process.env, assertRoots: checkRoots,
        pane });
      launchPlan = { recipe: plan.recipe, command: plan.command, declaredEnv: plan.declaredEnv, harness: plan.harness, model: plan.model, yolo: plan.yolo, executable: plan.executable, executablePaneSide: plan.executablePaneSide, config: plan.config, launchChoice: plan.launchChoice, trustHome: plan.trustHome, modelFrom: modelFromOf(plan.modelSource, { at: "start", prior: meta.modelFrom ?? null }),
        ...(plan.launchChoice ? { launchFrom: plan.launchChoice.from, launchAt: plan.launchChoice.at, launchDeclared: plan.launchChoice.declared } : {}) };
      // The plan ran preview-aware launch hooks as a preview: their real run, over the planned
      // contributions, waits for the rest of preflight.
      handedExecutable = harnessExecutableEnv(plan.executable.path, plan.executablePaneSide).OATS_HARNESS_EXECUTABLE;
      if (plan.previewedHooks.length) launchHooksPass = { frozen: { ...plan.frozen, hooks: plan.recipe.hooks }, harness: plan.harness, resolvedCfg, contextDir: context, previewed: plan.recipe.hooks, volatileEnv: plan.volatileEnv, trustHome: plan.trustHome };
      command = launchPlan.command; model = launchPlan.model;
      // The other launch hooks ran for real in the plan: their warnings are
      // events now, whatever the start does next, and the answer carries them.
      hookMeta = plan.hookMeta;
      hookDialogClaims = plan.hookDialogClaims;
      warnings = plan.warnings;
      for (const message of warnings) appendEvent(realHome, { kind: "launch-warning", data: { message } });
    } else if (o.model !== undefined && o.model !== null && String(o.model).trim() !== "") {
      const resolved = resolveModelPreference(String(o.model), harness);
      if (!resolved) throw oatsError("E_MODEL_UNKNOWN", `model preference ${JSON.stringify(o.model)} has no entry usable by harness ${harness}; give a ${harness} model id`);
      command = withLaunchModel(command, resolved);
      model = resolved; explicitModelFrom = "start";
    } else parseLaunchCommand(command);
    // A recorded command starts, and is saved, with its harness's safe task prompt.
    if (!launchPlan) command = withSafeTaskPrompt(command, harness);
    // References recorded for this home must resolve on this host on every
    // start path, and the source variables go to the pane, not the command.
    const recipeForEnv = launchPlan?.recipe || (meta.launch && typeof meta.launch === "object" ? meta.launch : null);
    if (recipeForEnv) { const missing = missingLaunchEnvRefs(recipeForEnv.env, o.env || process.env); if (missing.length) throw oatsError("E_LAUNCH_ENV_MISSING", launchEnvMissingMessage(missing)); }
    // A resume starts only under the values the start it brings back recorded (lib/start-env.mjs): a
    // changed one refuses, after a missing one; a start with no record to check (an earlier kernel's,
    // or one that does not read) is resumed and says so once. Ordinary starts never compare.
    let envUnverified = null;
    if (resume && recipeForEnv) {
      const fit = checkStartEnv(realHome, meta.startId, fromEnvNames(recipeForEnv.env), o.env || process.env);
      if (fit.changed) throw oatsError("E_LAUNCH_ENV_CHANGED", launchEnvChangedMessage(fit.changed));
      if (fit.unverified) warnings.push(envUnverified = launchEnvUnverifiedWarning(meta.instance));
    }
    const paneEnv = recipeForEnv ? launchEnvRefs(recipeForEnv, o.env || process.env) : [];
    const paneEnvFlags = paneEnv.flatMap((r) => ["-e", `${r.name}=${r.value}`]);
    checkRoots(); // preparation has run; no backend has been changed
    let target = receipt.target;
    const recorded = recordedState();
    if (recorded.error) { const e = recorded.error; throw oatsError("E_SESSION_UNKNOWN", `cannot establish whether ${meta.instance} is running, so nothing was started: ${String(e.stderr ?? e.message ?? "").trim() || e.message}`); }
    let state = recorded.state;
    if (state.present && state.state !== "shell" && !o.restart) throw oatsError("E_SESSION_RUNNING", `${meta.instance} is running (${state.state}); nothing was started`);
    // A caller that will have to create the tmux session reads the environment for it here, unless
    // the plan's lookup read it already with no server running (an instance that cannot is refused
    // here either way): after the start's preflights and its planning,
    // so each of their refusals still answers first, and before the real run of preview-aware
    // launch hooks, a stop and any write of the home's launch state (record, receipt, pending
    // start). A launch hook that does not declare launchPreview has already run and its warnings
    // are already events (above), as before any other late refusal of a start (E_SESSION_RUNNING,
    // E_LAUNCH_ENV_MISSING); nothing undoes what it did, and the hook contract (above
    // prepareLaunchHooks) allows such a hook idempotent provider registration, which the next
    // start repeats. Only when this start will have to create a window: a retained pane is reused
    // where it is. A restart whose window goes away during its stop is decided at the creation.
    const retained = reusable(state);
    const tmuxSessionPlan = retained ? undefined : sessionPlan();
    // A harness the plan looked up by name is looked up again where its pane will look it up, before
    // anything is stopped: the retained pane's own session, or the session this start will create
    // its window in (as planned). Once more on the session ensureOatsTmuxSession returns (below).
    // Not there: refused. Found elsewhere: the launch runs that one, and records it. Every executable
    // named bare (the harness's name, a declared name) is looked up again, also one the plan could only
    // look up on this process's PATH; a recorded (frozen) or a declared path never is.
    const lookAgain = (pane) => {
      if (!launchPlan || launchPlan.config?.frozen || launchPlan.config?.executable?.includes("/")) return false;
      const { config, launchChoice } = launchPlan;
      const actual = resolveLaunchExecutable({ harness: launchPlan.harness, declared: config?.executable, declaringDir: config?.source, lookup: launchLookup(launchEnvironment({ configEnv: config?.env, configName: config?.name, env: o.env || process.env, pane, cwd: realHome })) });
      if (!actual.path) throw executableNotOnPanePath(actual, { harness: launchPlan.harness, config, from: launchChoice?.from, at: launchChoice?.at });
      const bad = checkLaunchExecutable(actual.path);
      if (bad) throw oatsError("E_LAUNCH_EXECUTABLE", `launch configuration ${config?.name || "(harness default)"}: ${bad}; nothing was started`);
      launchPlan.executablePaneSide = !!actual.lookup;
      if (actual.path === launchPlan.recipe.executable) return false;
      launchPlan.recipe = { ...launchPlan.recipe, executable: actual.path };
      command = launchPlan.command = renderLaunchRecipe(launchPlan.recipe, { home: realHome, instance: meta.instance, trustHome: launchPlan.trustHome });
      return true;
    };
    /** The launch runs another program than the hooks that have run were handed: said, and kept in the home. */
    const noteReplacedExecutable = () => {
      const replaced = replacedExecutableWarning(handedExecutable, launchPlan?.recipe.executable);
      if (!replaced) return;
      handedExecutable = undefined;
      hookDialogClaims = voidedDialogClaims(hookDialogClaims);
      warnings.push(replaced);
      appendEvent(realHome, { kind: "launch-warning", data: { message: replaced } });
    };
    lookAgain(retained ? () => paneEnvironment(target.socket, target.session, o.io, realHome) : () => expectedPaneEnvironment(tmuxSessionPlan, planSession, o.io, realHome));
    // Every preflight has passed: the preview-aware launch hooks run for real
    // (they may register the home with their provider), before a restart's
    // stop, and must contribute exactly what they contributed as a preview,
    // which is what the command was rendered and preflighted from, except the
    // values of the env their preview declared volatile: those come from this
    // run, and the command is rendered again with them.
    if (launchHooksPass) {
      const { previewed, volatileEnv, trustHome, ...pass } = launchHooksPass;
      // The looks above have settled what this start expects: that is what its real hooks are handed.
      const handed = harnessExecutableEnv(launchPlan.recipe.executable, launchPlan.executablePaneSide);
      // Hooks that ran for real in the plan were handed the plan's: their statements don't reach this one.
      if (handed.OATS_HARNESS_EXECUTABLE !== handedExecutable) hookDialogClaims = voidedDialogClaims(hookDialogClaims);
      handedExecutable = handed.OATS_HARNESS_EXECUTABLE;
      const real = prepareLaunchHooks({ ...pass, extraEnv: handed, home: realHome, meta, assertRoots: checkRoots, pass: "real" });
      const canon = (v) => canonicalJson(JSON.parse(JSON.stringify(v ?? null)));
      const stable = (h) => Object.fromEntries(Object.entries(h.env).filter(([n]) => !volatileEnv.includes(n)));
      if (canon({ launch: real.launch, env: stable(real), contributions: real.contributions }) !== canon({ launch: previewed.launch, env: stable(previewed), contributions: previewed.contributions })) {
        // A provider's row names its env; the values are in the merged env.
        const rowOf = (h, id) => { const row = h.contributions.find((c) => c.capability === id); return canon({ row, values: (row?.env || []).map((n) => volatileEnv.includes(n) ? null : h.env[n]) }); };
        const differing = [...new Set([...real.contributions, ...previewed.contributions].map((c) => c.capability))].filter((id) => rowOf(real, id) !== rowOf(previewed, id));
        throw oatsError("E_LAUNCH_PREPARATION", `the launch hook of ${differing.join(", ") || "a capability"} returned a contribution that differs from its preview contribution (a launch hook returns the same contribution under OATS_LAUNCH_PREVIEW, apart from the values of its volatileEnv); nothing was stopped or started`);
      }
      launchPlan.recipe = { ...launchPlan.recipe, hooks: { launch: real.launch, env: real.env, contributions: real.contributions } };
      command = launchPlan.command = renderLaunchRecipe(launchPlan.recipe, { home: realHome, instance: meta.instance, trustHome });
      if (real.meta) hookMeta = { ...(hookMeta || {}), ...real.meta };
      if (real.dialogClaims) hookDialogClaims = { ...(hookDialogClaims || {}), ...real.dialogClaims };
      // The real run's warnings are events now, whatever the start does next,
      // and the answer carries them.
      warnings = [...warnings, ...real.warnings];
      for (const message of real.warnings) appendEvent(realHome, { kind: "launch-warning", data: { message } });
      checkRoots();
    }
    noteReplacedExecutable();
    const planExtra = launchPlan ? { launch: launchPlan.recipe, harness: launchPlan.harness, yolo: launchPlan.yolo, ...(launchPlan.modelFrom ? { modelFrom: launchPlan.modelFrom } : {}),
      ...(launchPlan.launchFrom ? { launchFrom: launchPlan.launchFrom, launchAt: launchPlan.launchAt, launchDeclared: launchPlan.launchDeclared } : {}),
      ...(hookMeta ? { hookMeta } : {}), ...(hookDialogClaims ? { hookDialogClaims } : {}) } : (explicitModelFrom ? { modelFrom: explicitModelFrom } : {});
    if (resume?.warning) { warnings.push(resume.warning); appendEvent(realHome, { kind: "launch-warning", data: { message: resume.warning } }); }
    warnings.push(...launchStartNotices(dirname(dirname(dirname(dirname(home)))), launchPlan?.harness || harness, command));
    if (kernelNode().warning) warnings.push(kernelNode().warning);
    const engaged = devChannelEngaged(launchPlan?.harness || harness, command);
    let stopReceipt = null;
    if (state.present && state.state !== "shell") {
      // Restart: every preflight above passed, so ask the running harness to
      // end and wait, bounded. A harness still there afterwards is reported
      // as running; nothing is escalated and nothing is launched.
      // The stop is recorded first, for the start instance.json still names (recordStop, as a
      // retire does), so a relaunch that fails, or a process that dies before it, leaves a home
      // that reads `stopped`, never `lost`: no resume brings back what was being restarted. The
      // relaunch records a new start, which the record does not name. A stop refused here leaves
      // the record with the harness running: should that harness die later, the home reads
      // `stopped`. A record that cannot be written (a full disk) does not block the restart.
      try { recordStop(realHome, null); } catch { /* see above */ }
      stopReceipt = stopHarness(target, { graceMs: o.stopGraceMs ?? 20000, io: o.io, kill: o.io?.kill, sleep: o.io?.sleep });
      writeJsonAtomic(join(realHome, ".oats-restart.json"), { instance: meta.instance, at: new Date().toISOString(), stop: stopReceipt, next: { harness: launchPlan?.harness || harness, launchConfig: launchPlan?.recipe.launchConfig ?? null, model: model ?? null } }, 0o600);
      appendEvent(realHome, { kind: stopReceipt.exited ? "restarted" : "stop-refused", data: { phase: "restart-stop", signal: stopReceipt.signal, waitedMs: stopReceipt.waitedMs, stillRunning: stopReceipt.stillRunning ?? [] } });
      if (!stopReceipt.exited) throw oatsError("E_SESSION_STOP_FAILED", `${meta.instance} was asked to stop (${stopReceipt.signal} to ${stopReceipt.requested.map((r) => `${r.comm} pid ${r.pid}`).join(", ")} at ${stopReceipt.sentAt}) and was still running after ${stopReceipt.waitedMs} ms (${stopReceipt.state}); nothing was escalated and nothing was started; stop it yourself, or retry with a longer --stop-grace. Receipt: ${join(realHome, ".oats-restart.json")}`);
      try { state = inspectSessionTarget(target, o.io); }
      catch (e) {
        const lost = lostServer(e);
        if (lost.stopped) state = { present: false, state: "stopped" };
        else throw oatsError("E_SESSION_UNKNOWN", `after the stop, cannot establish the state of ${meta.instance}, so nothing was started: ${lost.why ?? (String(e.stderr ?? e.message ?? "").trim() || e.message)}`);
      }
      if (state.present && state.state !== "shell") throw oatsError("E_SESSION_UNKNOWN", `${meta.instance} read as stopped and then as ${state.state} again; nothing was started`);
    }
    // The kernel that launches the harness is the one the agent's plain `oats` runs.
    checkRoots();
    writeKernelShim(realHome);
    const startedAt = new Date().toISOString();
    const id = randomUUID();
    if (!engaged) planExtra.launchPrompts = notEngaged(id);
    // This start's launch environment, recorded just before its pane is made (best effort: never a
    // refusal). A home without a recipe renders none and records nothing.
    const recordEnv = () => { if (recipeForEnv) recordStartEnv(realHome, id, fromEnvNames(recipeForEnv.env), o.env || process.env); };
    const makeLaunchController = () => engaged ? promptController(realHome, id, command, o.io, originalHomeIdentity) : null;
    let launchController;
    let launchPromptTarget, launchPrompts, beforeRespawn, promptDispatched = false;
    // A resumed Claude session is watched for its resume-cost dialog once it runs (after the record):
    // the pane's identity is read at its creation, as the controller reads it.
    const watchResume = !!resume?.sessionId && launchPlan.harness === "claude";
    let resumeTarget = null;
    checkRoots();
    // The names this launch removes, from the recipe it runs (a preview-aware hook's real run included).
    // A home without a recipe (an earlier kernel's) composes no providers at launch: nothing.
    const removed = launchPlan ? removedLaunchEnv({ declared: launchPlan.declaredEnv, hooksEnv: launchPlan.recipe.hooks?.env, configEnv: launchPlan.recipe.env }) : [];
    // The launch's one native start; every render of its window command reuses it.
    const nativeStart = prepareNativeStart(realHome, launchPlan?.harness || harness);
    // What the window runs: the planned command, or, for a resume that found its conversation, the same
    // recipe rendered with the harness's resume selector and the resume notice. Only the window carries
    // it: instance.json, the pending receipt and the recipe keep the ordinary launch, so a later start
    // opens a fresh conversation (and the native-record roots never see a recorded --session).
    const executedCommand = () => resume?.sessionId ? renderLaunchRecipe(launchPlan.recipe, { home: realHome, instance: meta.instance, trustHome: launchPlan.trustHome, resume: { sessionId: resume.sessionId, prompt: RESUME_NOTICE } }) : command;
    const windowCommand = (scope) => paneCommand(exitMarked(nativeRecordCommand(executedCommand(), realHome, launchPlan?.harness || harness, { start: nativeStart, scope }), id, exitedPath), removed);
    // Whether the harness runs in a scope of its own (nativeRecordCommand), judged on the pane it
    // will run in for the command it runs; a warning is said, and is an event once the start is recorded.
    let unscoped = null;
    const scopeOn = (pane) => {
      // The caller's own io (a test's), not the guarded one every start runs with.
      const scope = agentScopeOn(command, { pane, removed, refs: paneEnv }, rawIo);
      if (scope.warning) warnings.push(unscoped = scope.warning);
      return scope.wrapper;
    };
    let reused = "new";
    const session = target?.session || meta.tmux?.session || DEFAULT_TMUX_SESSION;
    const window = target?.window || meta.tmux?.window || meta.instance;
    let socket = target?.socket || meta.tmux?.socket;
    let windowCmd = windowCommand();
    let moved = null;
    // A fallback shell (no harness descendant) or a retained dead pane is
    // the agent's own pane (resolveAgentPane): the command runs there, on the
    // server the home recorded, no other window or pane touched and no option
    // set but that pane's mark.
    const inPlace = state.paneId && (state.present || state.state === "stopped");
    try {
      if (inPlace) {
        const scope = scopeOn(paneEnvironment(socket, session, o.io, realHome));
        if (scope) windowCmd = windowCommand(scope);
        launchController = makeLaunchController();
        if (launchController) {
          try {
            const oldTarget = launchPromptTransport(o.io).identity(socket, state.paneId);
            beforeRespawn = launchController.captureBeforeRespawn(oldTarget);
          } catch { /* a missing prior capture can never authorize input */ }
        }
        checkRoots();
        recordEnv();
        writeJsonAtomic(pendingPath, { id, target, command, model: model ?? null, startedAt, ...planExtra }, 0o600);
        promptDispatched = !!launchController;
        try {
          const output = tmuxOn(socket, ["respawn-pane", "-k", "-t", state.paneId, "-c", realHome, ...paneEnvFlags, windowCmd, ...markAgentPane(window, state.paneId), ...(launchController || watchResume ? [";", "display-message", "-p", "-t", state.paneId, LAUNCH_PANE_FORMAT] : [])], o.io, oatsWindowEnvironment());
          if (launchController) launchPromptTarget = { ...target, ...launchPaneTarget(socket, output) };
          if (watchResume) resumeTarget = resumePaneTarget(target, socket, output);
        }
        catch (e) { throw launchFailure(e); }
        reused = "pane";
      } else {
        const instancesRoot = dirname(realHome);
        const hq = existsSync(dirname(dirname(instancesRoot))) ? dirname(dirname(instancesRoot)) : realHome;
        checkRoots();
        // A replacement window (never launched, recorded window gone, recorded server gone) is created
        // on the OATS server, wherever the home was recorded: one socket from here to the record.
        const recordedSocket = socket ? resolve(socket) : null;
        socket = ensureOatsTmuxSession(session, hq, o.io, tmuxSessionPlan, missingSocket, warnings);
        // One read of the pane's environment answers both: the executable and the scope.
        const pane = paneEnvironment(socket, session, o.io, realHome);
        const looked = lookAgain(() => pane);
        if (looked) planExtra.launch = launchPlan.recipe;
        noteReplacedExecutable();
        if (hookDialogClaims) planExtra.hookDialogClaims = hookDialogClaims;
        const scope = scopeOn(pane);
        if (looked || scope) windowCmd = windowCommand(scope);
        let names;
        try { names = tmuxOn(socket, ["list-windows", "-t", `=${session}`, "-F", "#{window_name}"], o.io).split("\n").filter(Boolean); }
        catch (e) {
          if (isKernelCode(e?.code)) throw e;
          throw oatsError("E_SESSION_UNKNOWN", `cannot list tmux windows on ${socket}: ${tmuxFailure(e, "tmux list-windows failed")}`);
        }
        if (names.includes(window)) throw oatsError("E_SESSION_RUNNING", `tmux window ${session}:${window} appeared on ${socket} during the start; nothing was started`);
        target = { backend: "tmux", session, window, socket };
        launchController = makeLaunchController();
        checkRoots();
        recordEnv();
        writeJsonAtomic(pendingPath, { id, target, command, model: model ?? null, startedAt, ...planExtra }, 0o600);
        promptDispatched = !!launchController;
        try {
          const output = tmuxOn(socket, ["new-window", "-P", "-F", launchController || watchResume ? LAUNCH_PANE_FORMAT : "#{window_id}", "-t", `=${session}:`, "-n", window, "-c", realHome, ...paneEnvFlags, windowCmd, ...markAgentPane(window)], o.io, oatsWindowEnvironment()).trim();
          if (launchController) launchPromptTarget = { ...target, ...launchPaneTarget(socket, output) };
          if (watchResume) resumeTarget = resumePaneTarget(target, socket, output);
          prepareAgentWindow(socket, launchController ? launchPromptTarget.windowId : watchResume ? output.split("\t")[0] : output, o.io);
        }
        catch (e) { throw launchFailure(e); }
        if (recordedSocket && recordedSocket !== socket) moved = sessionMovedWarning(meta.instance, recordedSocket, socket);
      }
      if (launchController) launchPrompts = inPlace ? launchController.observeRespawn(launchPromptTarget, beforeRespawn) : launchController.observeNew(launchPromptTarget);
      if (launchPrompts?.status === "flag-ignored") { launchPrompts = channelsUnavailable(id, launchPrompts); warnings = flagIgnoredWarnings(warnings); }
    } catch (error) {
      if (!promptDispatched) throw error;
      launchPrompts = incompleteLaunchPrompt(realHome, id, launchPromptTarget ?? target, "launch prompt dispatch or recording incomplete", launchPrompts, originalHomeIdentity);
    }
    target = { backend: "tmux", session, window, socket: resolve(socket) };
    if (launchPrompts) {
      try { assertLaunchHome(realHome, originalHomeIdentity); }
      catch { throw retainedPromptError(realHome, meta.instance, launchPromptTarget ?? target, false, incompleteLaunchPrompt(realHome, id, launchPromptTarget ?? target, "launch home identity changed; metadata retained at original home", launchPrompts, originalHomeIdentity)); }
      planExtra.launchPrompts = launchPrompts;
      planExtra.launchPromptTarget = launchPromptTarget ?? target;
      // Recovery retains evidence but never reconstructs this invocation's answer authority.
      try { writeJsonAtomic(pendingPath, { id, target, command, model: model ?? null, startedAt, ...planExtra }, 0o600); }
      catch { throw retainedPromptError(realHome, meta.instance, launchPromptTarget ?? target, false, incompleteLaunchPrompt(realHome, id, launchPromptTarget ?? target, "launch prompt pending receipt incomplete", launchPrompts, originalHomeIdentity)); }
    }
    // The session exists: its boundary (lib/instance-events.mjs) is recorded
    // now, before the metadata, so a start whose metadata write fails still
    // voids the claims of the session it replaced; its adoption only completes a log it missed.
    // The planned recipe names the configuration (null: the bare harness), never the recorded recipe's.
    recordStartBoundary(realHome, { startId: id, startedAt, harness: launchPlan?.harness || harness, backend: "tmux", launchConfig: launchPlan?.recipe.launchConfig ?? null, phase: o.restart ? "restart" : "start" });
    // Keep launch evidence until the command exits or the target disappears.
    // A transient child (for example the native-start recorder) is not proof that startup
    // has finished. A later start reconciles the receipt without a watcher.
    let done;
    try { done = record(meta, { id, target, model, command, startedAt, reused, ...planExtra, ...(stopReceipt ? { stop: stopReceipt } : {}) }, false); }
    catch (e) {
      if (launchPrompts) throw retainedPromptError(realHome, meta.instance, launchPromptTarget ?? target, false, incompleteLaunchPrompt(realHome, id, launchPromptTarget ?? target, "launch prompt metadata recording incomplete", launchPrompts, originalHomeIdentity));
      if (e.code && String(e.code).startsWith("E_")) throw e;
      throw oatsError("E_SESSION_START_INCOMPLETE", `${meta.instance} was started (tmux ${target.session}:${target.window} on ${target.socket}) but its metadata could not be recorded: ${e.message}; the actual target is kept in ${pendingPath} and the next start adopts it instead of allocating another`);
    }
    if (launchPrompts && !promptLaunched(launchPrompts.status)) throw retainedPromptError(realHome, meta.instance, launchPromptTarget ?? target, false, launchPrompts);
    // As spawn says it once launched: a start refused before this point leaves no event.
    if (unscoped) appendEvent(realHome, { kind: "launch-warning", data: { message: unscoped } });
    if (envUnverified) appendEvent(realHome, { kind: "launch-warning", data: { message: envUnverified } });
    // Said once the new socket is recorded: a start that could not record leaves it to the adoption.
    if (moved) { appendEvent(realHome, { kind: "launch-warning", data: { message: moved } }); movedWarnings.push(moved); }
    // A resume answers what it continued. A resumed Claude session that stops at its resume-cost dialog
    // is a start that succeeded and waits for its human: reported (`waiting`), never answered.
    const waiting = resumeTarget && watchResumeConfirmation({ transport: launchPromptTransport(o.io), target: resumeTarget, notice: RESUME_NOTICE, ...(o.io?.now ? { now: o.io.now } : {}), ...(o.io?.sleep ? { sleep: o.io.sleep } : {}) }).waiting === RESUME_WAITING.RESUME_CONFIRMATION ? RESUME_WAITING.RESUME_CONFIRMATION : null;
    const resumed = resume ? { resume: resumeAnswer(resume, waiting) } : {};
    return { ...done, warnings: [...done.warnings, ...warnings, ...movedWarnings], ...resumed };
  } finally {
    // A hook may have replaced the home itself. Never follow that replacement
    // to remove a target's lock; keep the original retry state with its home.
    try {
      const st = lstatSync(realHome);
      if (st.isDirectory() && !st.isSymbolicLink() && st.dev === originalHomeIdentity?.dev && st.ino === originalHomeIdentity?.ino) rmSync(lock, { recursive: true, force: true });
    } catch { /* retain retry state when its authority is lost */ }
  }
}

/** One Git call of a retirement inspection → its stdout, as bytes: a text
 *  with one code unit per byte (latin1), so that no byte is replaced. Git
 *  prints ref names and paths as the bytes they are, and decoded as UTF-8 two
 *  names that differ only in bytes that are not UTF-8 would read alike: a
 *  state a hook changed would compare equal, and a copy would be skipped.
 *  What is compared is this text, never a decoded one. A value that is also
 *  used as a path is decoded where it is used (repositoryGitState).
 *  With `absent`, Git's quiet exit 1 ("no such ref", nothing on stderr)
 *  gives null. Any other failure throws E_WORK_INSPECTION_FAILED: a state
 *  that could not be read is never taken for an unchanged one. What a failed
 *  read of the state means for the retire is inspectRetirementWork's
 *  decision: not provable. */
function inspectGit(repo, args, { absent = false, env } = {}) {
  try {
    return retireGit(repo, args, { env }).toString("latin1");
  } catch (e) {
    const detail = String(e.stderr ?? "").trim();
    if (absent && e.status === 1 && !detail) return null;
    throw oatsError("E_WORK_INSPECTION_FAILED", `could not inspect the Git state of ${repo}: ${detail || String(e.message ?? "").trim() || `git ${args[0]} failed`}`);
  }
}
/** Whether an entry is there, for a read of the Git state. Only "not there"
 *  is absence: a test that fails for any other reason (no permission on a
 *  directory above it, for example) throws, so an entry the kernel cannot see
 *  is never taken for one that does not exist. A link is followed, as
 *  existsSync follows it. */
function inspectedEntryExists(path) {
  try { statSync(path); return true; }
  catch (e) {
    if (e.code === "ENOENT") return false;
    throw oatsError("E_WORK_INSPECTION_FAILED", `could not inspect ${path}: ${e.message}`);
  }
}
/** inspectedEntryExists with a link not followed: a link is there as itself,
 *  also one that leads nowhere. What the copier asks of an entry it copies
 *  with copyTreeSafe, which copies a link as a link, and what the comparison
 *  asks of the same entry (copiedGitPathDigest), so both read one thing
 *  (awebai/oats#1038). Absence is ENOENT alone, as there. */
function inspectedEntryPresent(path) {
  try { lstatSync(path); return true; }
  catch (e) {
    if (e.code === "ENOENT") return false;
    throw oatsError("E_WORK_INSPECTION_FAILED", `could not inspect ${path}: ${e.message}`);
  }
}
/** How the recovery copier resolves what it reads from a repository, read by
 *  the copier and by the comparison alike (repositoryGitState), so that the
 *  comparison holds the files the copy carries, found where the copy finds
 *  them. Git's answer decoded as UTF-8, exactly as Git printed it but for the
 *  one line feed that ends it: a path that begins or ends in white space is
 *  the path Git reads, so the copier reads the file Git reads
 *  (awebai/oats#647).
 *  A worktree whose `core.worktree` (per-worktree configuration) names a
 *  directory other than `<home>/work` never gets here: each inspection
 *  refuses it first (assertWorktreeTopLevel, awebai/oats#648). */
const copierGitText = (repo, args) => retireGit(repo, args, { encoding: "utf8" }).replace(/\n$/, "");
/** The Git directory the copier copies the index and the operation entries from. */
const copierGitDir = (repo) => copierGitText(repo, ["rev-parse", "--absolute-git-dir"]);
/** The common directory the copier reads info/exclude, info/attributes and the stash's log from. */
const copierCommonDir = (repo) => copierGitText(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
/** The file the copier reads for core.excludesFile; null when it reads none:
 *  the value is unset, empty or cannot be read. */
function copierExcludesFile(repo) {
  let value = "";
  try { value = copierGitText(repo, ["config", "--path", "--get", "core.excludesFile"]); } catch { /* unset: Git's default applies to both repositories alike */ }
  return value ? resolve(copierGitText(repo, ["rev-parse", "--show-toplevel"]), value) : null;
}
/** What a recovery's work copy holds of the worktree's repository beside the
 *  bytes of its files: everything copyRecoveryWork carries or restores, read
 *  the way it reads it, without reading the files. The rule: the work is
 *  unchanged only if everything its copy would carry is byte-for-byte equal,
 *  and anything that cannot be compared exactly counts as changed.
 *   - its status text (the copy is verified against it);
 *   - its HEAD as the copier reads it (headName): the whole ref, as its
 *     bytes, which decides whether the copy is cloned on a branch or
 *     detached; and the commit;
 *   - the index the copier copies, by what it holds and not by its bytes:
 *     its entries as `git ls-files -s -v` lists them (mode, object, stage and path, with the
 *     skip-worktree and assume-unchanged marks), its resolve-undo records
 *     (`git ls-files --resolve-undo`: resolving a conflict can add them while
 *     every entry, status row and byte ends up as it was), and the file's
 *     mode, which copyFileSync gives the copy. Its bytes also hold a stat
 *     cache that a read-only Git command rewrites, and extensions derived
 *     from the entries: those are a deliberate semantic exception, never
 *     compared;
 *   - each path the copier copies from the Git directories (COPIED_GIT_PATHS:
 *     an operation in progress, info/attributes, the stash's log), by what its
 *     copy carries, the permission bits included (copiedGitPathDigest);
 *   - its tags: a clone brings them, and removing the remote leaves them;
 *   - the stash ref (detachRecoveryClone fetches it);
 *   - its exclude rules as carryExcludes reads them: the core.excludesFile
 *     value, the file carryExcludes reads for it (copierExcludesFile), and
 *     info/exclude. They are written into the copy as new text, so their
 *     bytes are what it carries;
 *   - its status settings as carryStatusConfig reads them: the effective
 *     value of each STATUS_CONFIG key. The keys, not the configuration file:
 *     Git rewrites that file for an upstream or a remote, which no copy
 *     carries;
 *   - `cloneHead`, for a worktree whose HEAD the copier copies detached (no
 *     branch, a ref that is not a branch, a name that is not UTF-8): that copy
 *     is cloned without --branch, so it keeps a local branch for the HEAD of
 *     the repository it is cloned from, and none when that HEAD is not on a
 *     branch. That HEAD is read as its whole ref.
 *  The repository's other branches are not here: they outlive the worktree,
 *  and the copy does not hold them. Its tags, stash, rules and settings are
 *  the shared repository's: one made there by anyone while the retire hooks
 *  run adds a copy attempt. The repository's objects and the settings a clone
 *  of it is served under (its shallow boundary, grafts, hidden refs) stay in
 *  it and are not compared: a custody boundary, which holds because no
 *  retire removes that repository or deletes a branch.
 *  Every read is inspectGit's, a file read or an existence test
 *  (inspectedEntryExists): only Git's quiet "not set" and an entry that is
 *  not there are absence; any other failure throws, and the worktree is then
 *  not provable (inspectRetirementWork).
 *  Everything in the list is compared as its bytes; nothing of it goes
 *  through a decoding that replaces a byte. Git's output is inspectGit's
 *  text of bytes, the status is the status bytes as such a text, a file is
 *  the digest of its bytes, and a copied path is its exact digest
 *  (fingerprintTrees), which reads names and link targets as bytes. The
 *  three `rev-parse` paths and the `core.excludesFile` value are in the state
 *  as Git printed them (`paths`, and the first of `excludesFile`), compared
 *  as their bytes; a `rev-parse` path that does not decode to an existing one
 *  throws below, and the worktree is not provable. Every file and directory
 *  the state reads is found where the copier finds it, by the copier's own
 *  functions (copierGitDir, copierCommonDir, copierExcludesFile, headName):
 *  the state is what the copy carries, read the way the copy reads it. A
 *  file the copier does not reach is not there for the state either.
 *  `status`: the repository's worktreeStatusBytes, when the caller has it.
 *  `cloneSource`: the repository the copy is cloned from (meta.repo). */
function repositoryGitState(repo, { status, cloneSource } = {}) {
  /** One of the copier's reads; any failure makes the worktree not provable. */
  const asCopier = (read) => {
    try { return read(repo); }
    catch (e) {
      if (e?.code === "E_WORK_INSPECTION_FAILED") throw e;
      throw oatsError("E_WORK_INSPECTION_FAILED", `could not inspect the Git state of ${repo}: ${String(e?.stderr ?? "").trim() || String(e?.message ?? "").trim()}`);
    }
  };
  // Three paths, one per line. A path with a line feed in it prints more
  // lines, and taken apart wrongly every test below would read "not there",
  // before the hooks and after them alike. So: exactly three, absolute, there.
  /** A value Git printed, as the path the kernel's text paths name with it. */
  const pathOf = (value) => Buffer.from(value, "latin1").toString("utf8");
  const printed = inspectGit(repo, ["rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-common-dir", "--show-toplevel"]).split("\n");
  if (printed.at(-1) === "") printed.pop();
  const paths = printed.map(pathOf);
  if (paths.length !== 3 || !paths.every((path) => isAbsolute(path) && inspectedEntryExists(path))) {
    throw oatsError("E_WORK_INSPECTION_FAILED", `could not inspect the Git state of ${repo}: git rev-parse did not give its Git directory, its common directory and its top level as three existing absolute paths`);
  }
  const [gitDir, commonDir] = paths;
  const bytesOf = (path) => {
    try { return hashFile(createHash("sha256"), path).digest("hex"); }
    catch (e) {
      if (e.code === "ENOENT") return null;
      throw oatsError("E_WORK_INSPECTION_FAILED", `could not read ${path}: ${e.message}`);
    }
  };
  /** The permission bits a copyFileSync gives the copy of `path`; null when it is not there. */
  const modeOf = (path) => {
    try { return statSync(path).mode & 0o7777; }
    catch (e) {
      if (e.code === "ENOENT") return null;
      throw oatsError("E_WORK_INSPECTION_FAILED", `could not read ${path}: ${e.message}`);
    }
  };
  /** One value Git may not have: null when it is not set. */
  const valueOf = (...args) => inspectGit(repo, args, { absent: true })?.replace(/\n$/, "") ?? null;
  const sourceValueOf = (...args) => inspectGit(cloneSource, args, { absent: true })?.replace(/\n$/, "") ?? null;
  const head = asCopier(headName);
  const copierGit = asCopier(copierGitDir), copierCommon = asCopier(copierCommonDir);
  const excludesFile = valueOf("config", "--path", "--get", "core.excludesFile");
  const excludesRead = asCopier(copierExcludesFile);
  const copied = COPIED_GIT_PATHS.map((entry) => copiedGitPathDigest(entry, copiedGitPath(entry, copierGit, copierCommon)));
  const stash = valueOf("rev-parse", "--verify", "--quiet", "refs/stash");
  return {
    paths: printed,
    status: (status ?? worktreeStatusBytes(repo)).toString("latin1"),
    head: head.ref === null ? null : head.ref.toString("latin1"),
    commit: valueOf("rev-parse", "--verify", "--quiet", "HEAD"),
    // The index the copier copies (copierGitDir), named explicitly
    // (GIT_INDEX_FILE), read as an index. One that is not there lists nothing.
    index: inspectGit(repo, ["ls-files", "-s", "-v", "-z"], { env: { GIT_INDEX_FILE: join(copierGit, "index") } }),
    resolveUndo: inspectGit(repo, ["ls-files", "--resolve-undo", "-z"], { env: { GIT_INDEX_FILE: join(copierGit, "index") } }),
    indexMode: modeOf(join(copierGit, "index")),
    copied,
    // What the copy carries through Git rather than as files (awebai/oats#1038), read as the
    // copier reads it: the operation's refs it writes, and the stash's entries where its log
    // is not a file (stashEntries).
    operationRefs: asCopier(() => operationRefsWritten(repo, copierGit)),
    stashEntries: stash !== null && copied[COPIED_GIT_PATHS.indexOf(GIT_STASH_LOG)] === null ? asCopier(() => stashEntries(repo).map((e) => e.line)) : null,
    tags: inspectGit(repo, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/tags"]),
    stash,
    excludesFile: excludesFile === null && excludesRead === null ? null : [excludesFile, excludesRead, excludesRead && bytesOf(excludesRead)],
    exclude: bytesOf(join(copierCommon, "info", "exclude")),
    statusConfig: STATUS_CONFIG.map((key) => valueOf("config", "--get", key)),
    // The copy is cloned from the repository the instance was spawned from
    // (`cloneSource`, meta.repo), which can be a linked worktree of it: that
    // repository's HEAD is read there, as its whole ref, not the common
    // directory's.
    cloneHead: head.branch === null && gitDir !== commonDir && cloneSource
      ? [sourceValueOf("symbolic-ref", "--quiet", "HEAD"), sourceValueOf("rev-parse", "--verify", "--quiet", "HEAD")]
      : null,
  };
}
/** Every repository under a worktree, at any depth → [{ path, inner }]:
 *  nestedGitRoots, and (`inner`) the repositories inside those. A recovery
 *  rebuilds a nested repository from a clone; one inside it comes along as
 *  plain files, its Git directory included, which the copy's verification
 *  holds as bytes (worktreeGitPaths) and which no read-only Git command can
 *  describe whole.
 *  A directory whose `.git` cannot be tested (inspectedEntryExists throws),
 *  or is a dangling symbolic link (a link `stat` cannot follow, which the
 *  copy carries as a link and the copy's verification holds), is listed
 *  as { path, unknown: true }: it is not taken for a directory without a
 *  repository, and not for a repository either. So every directory with a
 *  `.git` entry of any kind is listed: a directory, a file, a link to
 *  anything, a dangling link, and a `.git` that cannot be tested. */
function repositoriesUnder(work) {
  const out = [];
  // Asked only where `stat` found no `.git`: whether there is an entry all the same.
  const entryIsThere = (path) => {
    try { lstatSync(path); return true; }
    catch (e) {
      if (e.code === "ENOENT") return false;
      throw oatsError("E_WORK_INSPECTION_FAILED", `could not inspect ${path.toString()}: ${e.message}`);
    }
  };
  // Names are read as bytes (`path` is a Buffer), so a directory whose name
  // is not UTF-8 is walked like any other.
  const walk = (dir, inner) => {
    for (const e of entriesAsBytes(dir)) {
      if (!e.isDirectory() || e.isSymbolicLink() || e.name.equals(GIT_NAME)) continue;
      const path = joinBytes(dir, e.name);
      let repository = false;
      try {
        repository = inspectedEntryExists(joinBytes(path, GIT_NAME));
        if (!repository && entryIsThere(joinBytes(path, GIT_NAME))) out.push({ path, unknown: true });
      } catch (e) {
        if (e?.code !== "E_WORK_INSPECTION_FAILED") throw e;
        out.push({ path, unknown: true });
      }
      if (repository) out.push({ path, inner });
      walk(path, inner || repository);
    }
  };
  walk(pathBytes(work), false);
  return out;
}
/** The work state of a worktree instance, without the bytes of its files: the
 *  worktree's Git state (repositoryGitState), as one text. Two inspections of
 *  an untouched tree give the same text. The bytes are the other part, read
 *  only when needed: observedWorkBytes. A repository under the worktree is not
 *  part of it: such a worktree is not provable (inspectRetirementWork). */
function worktreeGitState(work, status, cloneSource) { // `status`: the worktree's status bytes
  return JSON.stringify({ worktree: repositoryGitState(work, { status, cloneSource }) });
}
/** The `.git` entries a worktree's bytes leave out, as paths under it in
 *  bytes: the worktree's own, and that of each repository the copier rebuilds
 *  from a clone (nestedGitRoots, materializeNestedRepositories). Exact paths,
 *  never a name: any other entry named `.git` is bytes like any other
 *  (awebai/oats#663), such as a dangling `.git` link, or the `.git` of a
 *  repository inside a nested one, which the copy carries as plain files.
 *  Read from the source and used for the source and its copy alike: a
 *  rebuilt `.git` is a directory in the copy where the source's can be a
 *  file, and the path covers both. */
function worktreeGitPaths(work) {
  const under = pathBytes(work).length + PATH_SEPARATOR_BYTES.length;
  return [GIT_NAME, ...nestedGitRoots(work).map((root) => joinBytes(root.subarray(under), GIT_NAME))];
}
/** The bytes of a worktree, its Git directories (`gitPaths`, worktreeGitPaths of
 *  the source) left out, as their exact digest: what a work copy is verified
 *  with, and what proves that the hooks left the files as they were. One full
 *  read. Kept nowhere. */
const worktreeBytes = (work, gitPaths = worktreeGitPaths(work)) => exactTreeDigest(work, { excludePaths: gitPaths, children: true });
/** The byte part of an observed worktree's work state, read at most once per
 *  observation and kept on it with the Git directories it leaves out
 *  (`workGitPaths`, for the copy's verification); undefined where the
 *  observation saw no worktree. An inspection reads it only with its own walk,
 *  for inspectedWorkBytes, and never sets it. The retire reads it before it
 *  writes the pre-hook recovery, the copy's verification uses it (so a pass
 *  that copies the work costs no extra read), and so does the proof that the
 *  retire hooks left the work as it was (movedByHooks). */
function observedWorkBytes(observation) {
  if (observation.worktree && observation.workBytes === undefined) {
    // A read that fails is an inspection that failed, with its code: where the
    // retire reads before it writes, nothing else gives the failure one.
    try {
      const gitPaths = worktreeGitPaths(observation.work);
      observation.workBytes = worktreeBytes(observation.work, gitPaths);
      observation.workGitPaths = gitPaths;
    }
    catch (e) {
      if (e?.code === "E_WORK_INSPECTION_FAILED") throw e;
      throw oatsError("E_WORK_INSPECTION_FAILED", `could not read the worktree at ${observation.work}: ${e.message}`);
    }
  }
  return observation.workBytes;
}
/** observedWorkBytes, taken from the inspection's own read where it took one
 *  (`inspectedWorkBytes`, worktreeDigests): it read the worktree whole for its
 *  untracked and ignored digest, and nothing has written the worktree since.
 *  Asked only where the retire reads the bytes right after that inspection
 *  (#1247): before the pre-hook recovery, and in movedByHooks. */
function inspectedWorkBytes(observation) {
  if (observation.workBytes === undefined && observation.inspectedWorkBytes) {
    observation.workBytes = observation.inspectedWorkBytes.bytes;
    observation.workGitPaths = observation.inspectedWorkBytes.gitPaths;
  }
  return observedWorkBytes(observation);
}
/** What the retire hooks moved, between the observation before them and the
 *  one after → { home, work }. Nothing when the later observation has nothing
 *  to preserve. The home moved when its exact digest did: that is its bytes,
 *  `instance.json` as it is. (The stored digest, which a baseline is compared
 *  with, leaves the kernel's own fields of that file out and passes over the
 *  kernel's receipts, so it reads alike some homes that differ.)
 *  The work moved unless it is proven unchanged: a directory by its bytes
 *  (its exact digest); a worktree by its Git state and, only when that is
 *  equal, by its bytes. A status text or a class list alone proves nothing: a
 *  hook can rewrite a file that was already modified. `before` must hold its
 *  bytes already (the retire reads them before it writes the pre-hook
 *  recovery); without them the work counts as moved. So does a worktree that
 *  cannot be proven unchanged at all (`workProvable` false: a worktree that
 *  holds a repository, or a read of the Git state that failed). */
function movedByHooks(before, after) {
  if (!after.classes.length) return { home: false, work: false };
  const home = after.homeBytes !== before.homeBytes;
  let work = after.workFingerprint !== before.workFingerprint;
  if (!work && after.worktree) work = !before.workProvable || !after.workProvable || before.workBytes === undefined || inspectedWorkBytes(after) !== before.workBytes;
  return { home, work };
}

/** The check made before a worktree's status is trusted (awebai/oats#648):
 *  Git's top level for the worktree at `work` is `work` itself, both in
 *  their canonical spelling (canonicalHomePath, so a path reached through a
 *  link, or spelled in another letter case on a case-insensitive
 *  filesystem, is the same path). A per-worktree `core.worktree` can name
 *  another directory: Git's status then describes that one, while the
 *  retire reads, copies and removes `work`. That, and a top level that
 *  cannot be read, throws E_WORK_INSPECTION_FAILED with `disclosure` (what
 *  the retire has and has not done by then) as its last sentence. */
function assertWorktreeTopLevel(work, disclosure) {
  const refuse = (why) => oatsError("E_WORK_INSPECTION_FAILED", `${why}, so its Git status describes another directory than the one the retire reads, copies and removes.${disclosure ? ` ${disclosure}.` : ""}`);
  let top;
  try { top = retireGit(work, ["rev-parse", "--show-toplevel"]).toString("utf8").replace(/\n$/, ""); }
  catch (e) { throw refuse(`could not read the top level of the worktree at ${work} (${String(e.stderr ?? e.message ?? "").trim() || "git rev-parse failed"})`); }
  if (!top || canonicalHomePath(top) !== canonicalHomePath(work)) {
    throw refuse(`Git reads the worktree at ${work} as the directory ${top || "(none)"} (its core.worktree names another directory)`);
  }
}

function inspectRetirementWork(home, work, isWorktree, { recordedBranch, worktreeRemoval, directory = false, directoryMode = directory, link = false, instance, orphanedWork = false, disclosure, readWorkBytes = false } = {}) {
  // `directory`: work/ is read, copied and checked as a directory's bytes. `directoryMode`: the
  // record says `directory`. They differ for a directory of the home (instanceWork, #962), which
  // is copied the same way and is no directory instance: it has no receipt of its roots.
  if (directoryMode) assertDirectoryRoots(home);
  else if (directory) assertHomeDirectory(work);
  // `link`: work/ was read as a link, which goes with the home. Nothing of what it leads to is read.
  else if (link) assertStillLink(work, instance);
  const classes = [];
  let baseline;
  const path = findRetirementBaseline(home);
  try {
    if (existsSync(path)) baseline = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw oatsError("E_WORK_INSPECTION_FAILED", `could not read the independent retirement baseline: ${e.message}`);
  }
  const baselineValid = retirementBaselineValid(baseline, home);
  // This pass's one resolved exclusion set: provider-owned entries the spawn
  // baseline declared, and the home's verified extra trees (whatever the
  // baseline), which the retire's extra-tree step handles from this same set.
  // Every home fingerprint here and the copy made from this observation use it.
  const extraTrees = extraWorktreesOf(home);
  const homeExclusions = resolveHomeExclusions(home, baselineValid ? baselineDisposableHome(baseline) : [], extraTrees);
  // One walk of the home, two digests: the stored one for the comparison with
  // the baseline, which must not see the kernel's own fields of instance.json,
  // and the exact one for the comparison after the hooks, which must see
  // every byte. The stored one is in the baseline's digest version; a
  // version this kernel does not take matches nothing, and the walk is then
  // the one version 2 takes, for the exact digest alone.
  const digestVersion = baselineDigestVersion(baseline);
  let homeDigests;
  const fingerprintHome = () => (homeDigests ??= fingerprintTrees(home, { excludeRoot: homeExclusions.excludeRoot, instanceHome: true, digestVersion: digestVersion ?? BASELINE_DIGEST_VERSION, exact: true, children: true })).stored;
  if (!baselineValid) {
    classes.push("unknown instance-home provenance");
  } else if (digestVersion === undefined || baseline.homeFingerprint !== fingerprintHome()) {
    classes.push("changed instance-home bytes");
  }
  // A mutable mode must not turn owned directory bytes into an excluded shared
  // tree (or authorize Git deletion). Require the independent spawn authority.
  // It is the record's mode that is held against the receipt, as before #962:
  // a directory of the home passes it as any home that is not in directory
  // mode does, and what it then gets is a checked copy, never either of those.
  if (directoryMode !== (baselineValid && baseline.directoryWork === true)) {
    throw oatsError("E_WORK_INSPECTION_FAILED", "directory work mode disagrees with independent retirement authority");
  }
  let directoryFingerprint;
  if (directory) {
    directoryFingerprint = directoryBytes(work);
    // Never stamp hook-created or authored execution bytes as disposable.
    if (readdirSync(work).length) classes.push("directory work bytes");
  }
  // For a quarantine retry whose worktree is gone, whether the recorded branch
  // is still there to copy. Every other retire takes it to be there. Not asked
  // for a link that leads nowhere: nothing is copied through a link (#973).
  const branchExists = !directory && !link && recordedBranch && !existsSync(work) ? recordedBranchExists(recordedBranch.repo, recordedBranch.branch) : true;
  // Before anything of the worktree is read: its status describes it, not another directory.
  if (!directory && isWorktree && existsSync(work)) assertWorktreeTopLevel(work, disclosure);
  // A retire that will remove the worktree asks whether a ref that outlives it
  // reaches its commit. `head` is kept for the check before the removal.
  const unreached = worktreeRemoval?.removes && worktreeRemoval.repo && !directory && isWorktree && existsSync(work) ? worktreeCommitUnreached(worktreeRemoval.repo, work) : undefined;
  if (unreached?.unreached) classes.push("worktree commits no ref reaches");
  const worktree = isWorktree && existsSync(work);
  let gitState = "", workProvable = true, inspectedBytes;
  if (worktree) {
    // Read once, as bytes. The bytes go into the Git state and into the
    // comparison with the spawn baseline (its legacy digest reads them as
    // text); the rows and the classes read them as text.
    const statusBytes = worktreeStatusBytes(work);
    const status = statusBytes.toString("utf8");
    const rows = status.split("\0").filter(Boolean);
    if (rows.some((row) => !row.startsWith("?? ") && !row.startsWith("!! "))) classes.push("tracked or index worktree state");
    const disposableRoots = baseline?.disposableReceipts?.map((r) => r.root) || [];
    // A path the digest cannot inspect refuses, with what this retire has
    // and has not done by now, as the other refusals of an inspection do.
    // `readWorkBytes`: the retire will read the worktree's bytes right after
    // this inspection, so both digests come from one read (worktreeDigests),
    // or, where that cannot be done, apart as before.
    let generated, both;
    try {
      if (readWorkBytes && baseline && digestVersion === BASELINE_DIGEST_VERSION) both = worktreeDigests(work, statusBytes, disposableRoots);
      generated = both ? both.generated : baseline && digestVersion !== undefined ? generatedWorkFingerprintIn(digestVersion, work, statusBytes, disposableRoots) : undefined;
    }
    catch (e) {
      if (e?.code !== "E_WORK_INSPECTION_FAILED") throw e;
      throw oatsError(e.code, `${e.message}.${disclosure ? ` ${disclosure}.` : ""}`);
    }
    if (generated === undefined || baseline.generatedWorkFingerprint !== generated) classes.push("untracked or ignored worktree bytes");
    const found = repositoriesUnder(work);
    if (found.some((r) => !r.unknown)) classes.push("nested repository state");
    // The one place where a read of the Git state that fails is decided. It
    // is never taken for "not set" or for "unchanged", and it does not refuse
    // either: main's inspection read none of this and let such a retire go
    // on. The worktree is then not provable, and the copy decides, as it did
    // on main: nothing to preserve retires, anything else is copied before
    // the hooks (homeOnlyRecovery) and again after them (movedByHooks).
    // `git status` is not part of this: it failed the inspection on main too.
    try { gitState = worktreeGitState(work, statusBytes, worktreeRemoval?.repo); }
    catch (e) {
      if (!e?.code) throw e;
      workProvable = false;
    }
    // A worktree that holds a repository is not provable either: a directory
    // under it with a `.git` entry of any kind (repositoriesUnder, the
    // predicate the class reads): a directory, a file, a link to anything, a
    // dangling link, and a `.git` that cannot be tested. Only a repository
    // the predicate can see adds the class; the last two make the work
    // unprovable without it, and so never home-only (homeOnlyRecovery): a
    // change to the home alone can then cause a work-copy attempt before
    // the hooks that main did not make, and any failure of that attempt can
    // refuse the retirement. The retire hooks run between the two copies and
    // can change such a repository in ways no read of its state covers (its
    // configuration, its objects, what a clone of it is shown), so its work
    // is copied again after them, whatever they did. What stays in the repository the
    // worktree belongs to needs no copy: no retire removes it or deletes a
    // branch, and a worktree commit no ref reaches is preserved (the class
    // above, `unreached`).
    if (found.length) workProvable = false;
    if (both && workProvable) inspectedBytes = { bytes: both.bytes, gitPaths: both.gitPaths };
  }
  // Two values, so the post-hook pass can tell which part a hook moved: the
  // home's bytes (its exact digest), and the work state's fingerprint. A
  // directory's work state is its bytes (`directoryFingerprint`, an exact
  // digest too). A worktree's is its Git state here, and its bytes, which the
  // observation holds apart (observedWorkBytes): an inspection asked to
  // (`readWorkBytes`) reads them with its untracked and ignored digest, and
  // keeps them as `inspectedWorkBytes` for inspectedWorkBytes to adopt; it
  // never sets them. `workProvable`: whether
  // that state could be read and covers everything a copy of the work would
  // carry. None of these is kept in a baseline, a receipt or recovery.json.
  // When the worktree will be removed, its HEAD (the commit and the ref's
  // bytes) and whether a ref reaches that commit are part of the work state: a
  // hook that deletes the ref that reached the commit changes nothing else
  // the state holds, and the commit must still be preserved again after it.
  fingerprintHome();
  const workFingerprint = createHash("sha256").update(directory ? (directoryFingerprint || "missing") : gitState)
    .update("\0").update(unreached ? `${unreached.head.commit}\0${unreached.unreached ? "unreached" : "reached"}\0` : "")
    .update(unreached?.head.ref ?? "")
    .digest("hex");
  return { classes: [...new Set(classes)], home, work, directory, orphanedWork, worktree, workProvable, directoryFingerprint, homeBytes: homeDigests.exact, workFingerprint, inspectedWorkBytes: inspectedBytes, homeExclude: homeExclusions.excludeRoot, notCopied: homeExclusions.notCopied, extraTrees, branchExists, head: unreached?.head, runtimeAuthority: baselineValid ? runtimeAuthorityOf(baseline) : undefined };
}

/** Copy the entries of `src` into `dest` (created), names as bytes, except
 *  the top-level names in `excludeRoot`, tested as text the way the digests
 *  test them (fingerprintTrees). */
function copyRecoveryTree(src, dest, { excludeRoot = new Set() } = {}) {
  mkdirSync(dest, { recursive: true });
  for (const e of entriesAsBytes(src)) {
    if (excludeRoot.has(e.name.toString("utf8"))) continue;
    copyTreeSafe(joinBytes(src, e.name), joinBytes(dest, e.name));
  }
}
/** Make the top level of `dest`, a fresh clone, the top level of `source`,
 *  names as bytes: every entry of `dest` but its `.git` is removed, then
 *  every entry of `source` but its `.git` is copied (copyTreeSafe). A mirror,
 *  not an overlay: a tracked top-level entry the source deleted or renamed is
 *  not left in the copy as the clone checked it out (awebai/oats#656). The
 *  `.git` of `dest` is never touched: the copy's Git state is restored
 *  separately (restoreStandaloneGitState). */
function mirrorTopLevel(source, dest) {
  for (const e of entriesAsBytes(dest)) if (!e.name.equals(GIT_NAME)) rmSync(joinBytes(dest, e.name), { recursive: true, force: true });
  for (const e of entriesAsBytes(source)) if (!e.name.equals(GIT_NAME)) copyTreeSafe(joinBytes(source, e.name), joinBytes(dest, e.name));
}

/** What a recovery's work copy takes from a worktree's own Git directory: the
 *  state of an operation, and what an operation that ended left there. It is
 *  the list of what is copied, never the test for "an operation is in
 *  progress" (gitOperationInProgress). */
export const RECOVERABLE_GIT_ADMIN = [
  "MERGE_HEAD", "MERGE_MSG", "AUTO_MERGE", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD",
  "BISECT_LOG", "BISECT_START", "BISECT_NAMES", "rebase-apply", "rebase-merge", "sequencer",
];

/** The entries of a worktree's own Git directory by which `git status` decides
 *  that an operation is in progress there (Git's wt-status.c,
 *  wt_status_get_state, and sequencer.c, sequencer_get_last_command):
 *   - `rebase-apply`, else `rebase-merge`: a rebase, or `git am`;
 *   - `MERGE_HEAD`: a merge;
 *   - `CHERRY_PICK_HEAD`, `REVERT_HEAD`: a cherry-pick, a revert;
 *   - `sequencer/todo`: a cherry-pick or a revert of several commits, between
 *     two of them;
 *   - `BISECT_LOG`: a bisect.
 *  It is not the list of what a recovery copies (RECOVERABLE_GIT_ADMIN): Git
 *  leaves `REBASE_HEAD`, `AUTO_MERGE` and `MERGE_MSG` behind operations that
 *  ended, reads `BISECT_START` and `BISECT_NAMES` only during a bisect, and
 *  reads nothing of a `sequencer` directory but its `todo`. None of them says
 *  that an operation is in progress, and a copy still takes each. */
export const GIT_OPERATION_ENTRIES = Object.freeze([
  "rebase-apply", "rebase-merge", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer/todo", "BISECT_LOG",
]);
/** The two of them that are refs. In the files format a ref is a file of the
 *  Git directory; in the reftable format it is not, and only Git can say
 *  whether it is there. */
const GIT_OPERATION_REFS = Object.freeze(["CHERRY_PICK_HEAD", "REVERT_HEAD"]);

/** Whether something is at `path`, a link not followed → true, false when it
 *  is not there (ENOENT, ENOTDIR), null when it cannot be looked at. */
function gitEntryAt(path) {
  try { lstatSync(path); return true; }
  catch (e) { return e?.code === "ENOENT" || e?.code === "ENOTDIR" ? false : null; }
}
/** Whether the repository of the worktree whose own Git directory is `gitDir`
 *  may store its refs in the reftable format: a `reftable` entry in that
 *  directory, which a linked worktree's has too, or in the common directory
 *  its `commondir` file names. No Git command runs for it. What cannot be
 *  read is not "no": then Git is asked. */
function refsMayBeReftable(gitDir) {
  if (gitEntryAt(join(gitDir, "reftable")) !== false) return true;
  let common;
  try { common = readFileSync(join(gitDir, "commondir"), "utf8").trim(); }
  catch (e) { return !(e?.code === "ENOENT" || e?.code === "ENOTDIR"); }
  return gitEntryAt(join(resolve(gitDir, common), "reftable")) !== false;
}

/** Whether a Git operation is in progress in the worktree at `tree` whose own
 *  Git directory is `gitDir`: the one answer to that question, for a retire's
 *  extra trees, for the recovery of its own tree and for the listing of what
 *  retires retained. A tree is removed on this answer, so it differs from
 *  Git's own where that keeps a tree:
 *   - an entry counts when it exists, as whatever it is and without following
 *     a link. Git also resolves the two refs and reads the todo's first word;
 *     a `CHERRY_PICK_HEAD` that does not resolve and a todo Git cannot read
 *     are operations here;
 *   - an entry that cannot be looked at, for any reason but its absence
 *     (ENOENT, ENOTDIR), is an operation.
 *  The entries are files in every format but the two refs. In a repository
 *  that stores its refs in the reftable format a cherry-pick or a revert left
 *  open in a tree with no change leaves no entry at all, so there, and only
 *  there, Git is asked for each of the two in the tree (gitRefPresence).
 *  Whatever is not Git's plain "not there" is an operation: a failure, a
 *  timeout, no Git, no `tree` to ask in. In the files format no Git command
 *  runs. */
export function gitOperationInProgress(gitDir, tree) {
  if (GIT_OPERATION_ENTRIES.some((entry) => gitEntryAt(join(gitDir, entry)) !== false)) return true;
  return refsMayBeReftable(gitDir) && GIT_OPERATION_REFS.some((name) => gitRefPresence(tree, name) !== "absent");
}

/** The paths of a repository's Git directories that a recovery's work copy
 *  takes by copying them, beside the clone, the files and the index: one
 *  selection, read by the copier (restoreStandaloneGitState,
 *  carryStatusConfig, detachRecoveryClone) and by the comparison
 *  (repositoryGitState), so that each copied path is compared by what its
 *  copy carries (copiedGitPathDigest). `dir`: the repository's own Git
 *  directory ("git") or its common directory ("common"). `copy`: copyTreeSafe
 *  ("tree") or copyRegularFile ("file").
 *  The index is copied whole and is not in the selection: it is compared by
 *  its entries, its resolve-undo records and its mode, never by its bytes,
 *  which hold a cache that a read-only Git command rewrites. That is a
 *  deliberate semantic exception (repositoryGitState). */
const COPIED_GIT_PATHS = [
  ...RECOVERABLE_GIT_ADMIN.map((name) => ({ dir: "git", path: [name], copy: "tree" })),
  { dir: "common", path: ["info", "attributes"], copy: "file" },
  { dir: "common", path: ["logs", "refs", "stash"], copy: "file" },
];
const [GIT_ATTRIBUTES, GIT_STASH_LOG] = COPIED_GIT_PATHS.slice(-2);
const copiedGitPath = ({ dir, path }, gitDir, commonDir) => join(dir === "git" ? gitDir : commonDir, ...path);
/** What the copy of one selected path carries, as a digest; null when the
 *  path is not there. copyTreeSafe gives a copy the entry's kind, bytes or
 *  target, and the bits of the entry and of everything under it: its exact
 *  digest. copyRegularFile follows a link and gives the copy the bytes and the
 *  mode of what it reaches: those. So a "tree" path is looked at as the copier
 *  looks at it, a link not followed (inspectedEntryPresent): a link that leads
 *  nowhere is there, as a link. Any failure but "not there" throws, as a
 *  read of the Git state does, and so does a file path that is not a file. */
function copiedGitPathDigest(entry, at) {
  if (!(entry.copy === "tree" ? inspectedEntryPresent(at) : inspectedEntryExists(at))) return null;
  try {
    if (entry.copy === "tree") return exactTreeDigest(at);
    const st = statSync(at);
    if (!st.isFile()) throw new Error("it is not a file");
    return hashFile(createHash("sha256").update(`${st.mode & 0o7777}\0`), at).digest("hex");
  } catch (e) {
    if (e?.code === "E_WORK_INSPECTION_FAILED") throw e;
    throw oatsError("E_WORK_INSPECTION_FAILED", `could not read ${at}: ${e.message}`);
  }
}

/** Object ids among `oids` that `repo` does not have, from one
 *  `cat-file --batch-check` process. */
export function missingGitObjects(repo, oids) {
  if (!oids.length) return [];
  const out = retireGit(repo, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { input: oids.join("\n") + "\n", encoding: "utf8" });
  const missing = [];
  for (const line of out.split("\n")) {
    if (!line.endsWith(" missing")) continue;
    missing.push(line.slice(0, line.indexOf(" ")));
  }
  return missing;
}

/** A fetch into a recovery clone from the repository it copies. Protocol
 *  version 2, whatever the user's configuration says: its upload-pack serves
 *  an object id the source has although no ref advertises it, which is how
 *  the copier fetches a detached HEAD and the commits only a log names. A
 *  client setting; it runs nothing. */
function copierFetch(recovered, source, refspecs, { input } = {}) {
  retireGit(recovered, ["-c", "protocol.version=2", "fetch", "--quiet", "--no-tags", source, ...refspecs], input === undefined ? {} : { input });
}

/** The commits a reflog file names: the new object id of each entry, which is
 *  what `git log -g` shows for it, the zero id left out. A file that is not
 *  there names none. Read from the copy of the file, so that what is proven
 *  is what the copy carries. */
function reflogCommits(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "latin1").split("\n")) {
    const m = /^[0-9a-f]{40}(?:[0-9a-f]{24})? ([0-9a-f]{40}(?:[0-9a-f]{24})?) /.exec(line);
    if (m && !/^0+$/.test(m[1])) out.push(m[1]);
  }
  return out;
}

/** The blobs an index listing names (`git ls-files --stage -z` or
 *  `--resolve-undo -z`): rows `<mode> <oid> <stage>\t<path>`. Gitlink rows
 *  (mode 160000) name commits of nested repositories, which
 *  materializeNestedRepositories restores; they and the zero id are never
 *  blobs here. */
function indexBlobs(rows) {
  const out = [];
  for (const row of rows.toString("latin1").split("\0")) {
    const m = /^(\d+) ([0-9a-f]+) \d\t/.exec(row);
    if (m && m[1] !== "160000" && !/^0+$/.test(m[2])) out.push(m[2]);
  }
  return out;
}

/** The one step that makes a recovery copy hold every object the Git
 *  metadata it carries names (awebai/oats#654, #655, #657): measure, repair,
 *  re-measure. One `cat-file --batch-check` asks which of the named objects
 *  the copy lacks; the missing commits are fetched from `source` by id (one
 *  fetch, with everything they reach), the missing blobs, which can be in no
 *  commit (staged content, a resolved conflict's sides), are copied by
 *  content (`cat-file blob` → `hash-object -w`), and so are the missing trees
 *  (`cat-file tree` → `hash-object -t tree -w`: the tree AUTO_MERGE names
 *  and the trees under it that hold a conflict's files, which no commit
 *  reaches, awebai/oats#1038); then the whole set is
 *  checked again. A fetch or a read that fails is not the failure itself:
 *  whatever is still missing after the repair is, named by its id, and the
 *  copy is refused (E_WORK_PRESERVATION_FAILED). That covers an object the
 *  source itself lacks, which GIT_NO_LAZY_FETCH keeps the copier from
 *  fetching from a promisor remote. */
function carryNamedObjects(source, recovered, { commits = [], blobs = [], trees = [] }) {
  const named = [...new Set([...commits, ...blobs, ...trees])];
  if (!named.length) return;
  const missing = new Set(missingGitObjects(recovered, named));
  const fetch = [...new Set(commits)].filter((oid) => missing.has(oid));
  if (fetch.length) {
    try { copierFetch(recovered, source, ["--stdin"], { input: fetch.join("\n") + "\n" }); }
    catch { /* the re-measure names what the fetch did not bring */ }
  }
  for (const [type, oids] of [["blob", blobs], ["tree", trees]]) {
    for (const oid of new Set(oids)) {
      if (!missing.has(oid)) continue;
      let content;
      try { content = retireGit(source, ["cat-file", type, oid]); }
      catch { continue; /* the re-measure names it */ }
      const restored = retireGit(recovered, ["hash-object", "-t", type, "-w", "--stdin"], { input: content, encoding: "utf8" }).trim();
      if (restored !== oid) throw new Error(`recovered Git object ${restored} did not match source ${oid}`);
    }
  }
  const stillMissing = missingGitObjects(recovered, named);
  if (stillMissing.length) {
    const more = stillMissing.length > 3 ? ` and ${stillMissing.length - 3} more` : "";
    throw new Error(`the recovery lacks ${stillMissing.length} Git object(s) that its copied Git metadata names, and ${source} could not supply them: ${stillMissing.slice(0, 3).join(", ")}${more}`);
  }
}

/** Copy `source` to `dest` as one file: how the recovery's copier takes the
 *  paths it copies "as a file" (the index, the entries of COPIED_GIT_PATHS
 *  with copy "file", a nested repository's reflogs). The kernel decides what
 *  is copied that way, never the file system: copyFileSync of an empty
 *  directory fails on one (EISDIR) and writes an empty file on another, where
 *  a directory's size is 0, so the same retire refused on one host and went
 *  through on the other (awebai/oats#1029).
 *  The look follows a link, as Git does at each of these paths (it reads the
 *  index, info/attributes and a reflog through one) and as the comparison
 *  does (copiedGitPathDigest): what Git reads there decides.
 *  → true: a regular file is there, in place or at a link's end, and `dest`,
 *  whose directory is made, now holds its bytes and mode as a plain file.
 *  → false: nothing is there (ENOENT, ENOTDIR), also at the end of a link
 *  that leads nowhere; nothing is written, and the caller does what it always
 *  did for an absent path.
 *  Anything else throws, naming the path and what is there in the kernel's
 *  own words (notCopiedAsFile), never the system's message. `source` and
 *  `dest` are strings or Buffers (a ref's log is named by its bytes). */
export function copyRegularFile(source, dest) {
  const absent = (e) => e?.code === "ENOENT" || e?.code === "ENOTDIR";
  let st;
  try { st = lstatSync(source); }
  catch (e) {
    if (absent(e)) return false;
    throw notCopiedAsFile(source, "an entry that cannot be read");
  }
  const link = st.isSymbolicLink();
  if (link) {
    try { st = statSync(source); }
    catch (e) {
      if (absent(e)) return false;
      throw notCopiedAsFile(source, "a link that cannot be followed");
    }
  }
  if (!st.isFile()) {
    const what = st.isDirectory() ? "a directory" : "an entry that is neither a file nor a directory";
    throw notCopiedAsFile(source, link ? `a link to ${what}` : what);
  }
  mkdirSync(Buffer.isBuffer(dest) ? parentOf(dest) : dirname(dest), { recursive: true });
  copyFileSync(source, dest);
  return true;
}
/** The copier's refusal of a path it copies as a file. `what`: one of the
 *  words copyRegularFile has for what is there. */
const notCopiedAsFile = (path, what) => new Error(`the recovery copies ${Buffer.isBuffer(path) ? path.toString("utf8") : path} as a file, and ${what} is there`);

function restoreStandaloneGitState(sourceWork, recoveredRepo) {
  const sourceGit = copierGitDir(sourceWork);
  const recoveredGit = join(recoveredRepo, ".git");
  // The blobs the copied index names, read from the index file the copier
  // copies (awebai/oats#647), not from Git's own idea of the index: its
  // staged entries and its resolve-undo records (awebai/oats#655). The clone
  // already holds every blob reachable from a commit; carryNamedObjects asks
  // once which the copy lacks and copies only those. Copying every row cost
  // two Git processes per index entry: a clean 9,500 file tree took ~19,000
  // launches and looked like a hang.
  const index = { env: { GIT_INDEX_FILE: join(sourceGit, "index") } };
  const blobs = [
    ...indexBlobs(retireGit(sourceWork, ["ls-files", "--stage", "-z"], index)),
    ...indexBlobs(retireGit(sourceWork, ["ls-files", "--resolve-undo", "-z"], index)),
  ];
  carryNamedObjects(sourceWork, recoveredRepo, { blobs });
  // The index is the selection's one exception (COPIED_GIT_PATHS): copied
  // whole, compared by its entries, resolve-undo records and mode. A tree
  // with no index file (`git worktree add --no-checkout`, the file removed)
  // is carried as one: the index the clone's checkout wrote is removed, so
  // that the copy reads to Git as the source does, every committed file a
  // staged deletion (awebai/oats#1048).
  if (!copyRegularFile(join(sourceGit, "index"), join(recoveredGit, "index"))) rmSync(join(recoveredGit, "index"), { force: true });
  // A link at one of these names is copied as a link, also one that leads
  // nowhere: the look does not follow it (inspectedEntryPresent), and
  // copyTreeSafe copies a link as a link (awebai/oats#1038).
  for (const entry of COPIED_GIT_PATHS.filter((e) => e.dir === "git")) {
    const source = copiedGitPath(entry, sourceGit);
    if (!inspectedEntryPresent(source)) continue;
    const dest = copiedGitPath(entry, recoveredGit);
    rmSync(dest, { recursive: true, force: true });
    copyTreeSafe(source, dest);
  }
  carryOperationRefs(sourceWork, recoveredRepo, sourceGit);
}

/** The refs an operation leaves in a worktree's own Git directory that the
 *  copy above takes as files where they are files. In the reftable format they
 *  are refs, not files (awebai/oats#1038). A fixed list: no name is ever read
 *  from the source. */
const CARRIED_OPERATION_REFS = Object.freeze(["CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "AUTO_MERGE"]);
/** A full object id of `repo`'s object format, as a pattern. */
function objectIdPattern(repo) {
  const format = retireGit(repo, ["rev-parse", "--show-object-format"], { encoding: "utf8" }).trim();
  if (format === "sha1") return /^[0-9a-f]{40}$/;
  if (format === "sha256") return /^[0-9a-f]{64}$/;
  throw new Error(`${repo} uses the object format ${JSON.stringify(format)}, which the recovery does not know`);
}
/** The object id the ref named exactly `name` holds in `repo`, or null when
 *  there is no such ref. `show-ref --exists` takes the name as it is (a branch
 *  or a tag of the same name, which `rev-parse` would find in its place, is not
 *  that ref) and does not ask for the object; once the ref is there, `rev-parse`
 *  reads it, the ref at the Git directory's top level coming first in its
 *  order. Only Git's answer that the ref does not exist (exit 2) is "none";
 *  any other failure throws. Asked only of a repository whose refs may be in
 *  the reftable format, which needs a Git that has `--exists` (2.43). */
function exactRefValue(repo, name) {
  try { retireGit(repo, ["show-ref", "--exists", name]); }
  catch (e) { if (e.status === 2) return null; throw e; }
  return retireGit(repo, ["rev-parse", "--verify", "--quiet", name], { encoding: "utf8" }).trim();
}
/** The trees and blobs under the tree `tree`, itself included, that
 *  `recovered` lacks, read from `source`: one level at a time, and only below
 *  a tree the copy lacks. A tree the clone holds came with what it reaches, so
 *  AUTO_MERGE's tree, which is the whole worktree's, costs the trees on the
 *  conflict's paths, not the whole tree's. Gitlinks name commits of other
 *  repositories and are not followed. */
function missingTreeObjects(source, recovered, tree) {
  const trees = [], blobs = [];
  for (let level = missingGitObjects(recovered, [tree]); level.length;) {
    trees.push(...level);
    const children = [];
    for (const t of level) {
      for (const row of retireGit(source, ["ls-tree", "-z", t]).toString("latin1").split("\0")) {
        const m = /^\d+ (blob|tree) ([0-9a-f]+)\t/.exec(row);
        if (m) children.push({ type: m[1], oid: m[2] });
      }
    }
    const missing = new Set(missingGitObjects(recovered, [...new Set(children.map((c) => c.oid))]));
    blobs.push(...new Set(children.filter((c) => c.type === "blob" && missing.has(c.oid)).map((c) => c.oid)));
    level = [...new Set(children.filter((c) => c.type === "tree" && missing.has(c.oid)).map((c) => c.oid))];
  }
  return { trees, blobs };
}
/** Clone into a recovery, `args` being what follows `git clone`, its last the
 *  destination. A recovery's refs are files, whatever the operator's Git
 *  configuration or environment makes a new repository: the copy takes an
 *  operation's refs as files of the Git directory, which a repository whose
 *  refs are in the reftable format does not read (awebai/oats#1038). So the
 *  clone is told the files format (`init.defaultRefFormat`, which a Git older
 *  than the reftable format ignores; GIT_DEFAULT_REF_FORMAT, which would come
 *  first, is not passed to the retire's Git: retireGitEnv), and a clone whose
 *  Git directory still holds `reftable` refuses the copy. */
function cloneRecovery(args) {
  retireGit(null, ["-c", "init.defaultRefFormat=files", "clone", ...args]);
  if (gitEntryAt(join(args.at(-1), ".git", "reftable")) !== false) throw new Error(`the recovery clone ${args.at(-1)} does not store its refs as files`);
}
/** The refs of an operation whose objects the recovery carries, whichever way
 *  the ref came: written by carryOperationRefs, or copied as a file of the Git
 *  directory. MERGE_HEAD is a file in every format, and is never written. */
const OPERATION_OBJECT_REFS = Object.freeze([...CARRIED_OPERATION_REFS, "MERGE_HEAD"]);
/** The object ids the operation ref `name` names in the recovery, read after
 *  the copy from the file at its name: Git writes each of these refs, in the
 *  files format, as one id per line (a merge of several commits names one per
 *  line in MERGE_HEAD, of which a Git read gives the first only), and Git
 *  would refuse to read a ref whose object is not yet there. A link at the
 *  name is carried as itself (restoreStandaloneGitState), and what it leads
 *  to is not read: it names nothing here. */
function recoveredOperationObjects(recoveredRepo, name) {
  const at = join(recoveredRepo, ".git", name);
  let st;
  try { st = lstatSync(at); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
  if (!st.isFile()) return [];
  return readFileSync(at, "latin1").split("\n").filter((line) => line !== "");
}
/** The type of each of `oids` in `repo` (`cat-file --batch-check`), "missing"
 *  for one it does not hold. */
function gitObjectTypes(repo, oids) {
  const types = new Map();
  if (!oids.length) return types;
  const out = retireGit(repo, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { input: oids.join("\n") + "\n", encoding: "utf8" });
  for (const line of out.split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0) types.set(line.slice(0, space), line.slice(space + 1));
  }
  return types;
}
/** The operation's refs that the copy writes through Git, as { name, oid }:
 *  each of CARRIED_OPERATION_REFS that the source's Git holds by its exact
 *  name and that has nothing at its name in the worktree's own Git directory
 *  `gitDir`, which the copy of the Git directory's files therefore does not
 *  take. Asked only where the refs may be in the reftable format
 *  (refsMayBeReftable); in the files format each is a file. The one read for
 *  the copier (carryOperationRefs) and for the comparison (repositoryGitState),
 *  so that what the copy writes is what is compared. */
function operationRefsWritten(work, gitDir) {
  if (!refsMayBeReftable(gitDir)) return [];
  const refs = [];
  for (const name of CARRIED_OPERATION_REFS) {
    if (inspectedEntryPresent(join(gitDir, name))) continue;
    const oid = exactRefValue(work, name);
    if (oid !== null) refs.push({ name, oid });
  }
  return refs;
}
/** Give the recovery the operation's refs and the objects they name
 *  (awebai/oats#1038):
 *   - each of CARRIED_OPERATION_REFS that the source's Git holds and that has
 *     nothing at its name in the source's own Git directory, which the copy of
 *     the Git directory's files therefore did not take, is written with `git
 *     update-ref` at the same object id. Git is asked only where the refs may
 *     be in the reftable format (refsMayBeReftable): in the files format each
 *     of these refs is a file, and the copy took it;
 *   - every object an operation ref of the recovery names (OPERATION_OBJECT_REFS,
 *     written or copied) is carried before any ref is written, with
 *     carryNamedObjects: a commit by id, a tree with what under it the copy
 *     lacks (AUTO_MERGE's), a blob by content. Such an object is often in no
 *     branch (a commit reset away, a conflict's tree), and a clone does not
 *     bring it. One the source itself lacks is not carried: the recovery's ref
 *     names nothing there either. Git refuses to write a ref whose object is
 *     not there, so a reftable ref the source holds without its object refuses
 *     the copy.
 *  Every id is checked as a full object id of the repository's object format
 *  before use: a written ref's that is not one refuses the copy; a line of a
 *  copied file that is not one names nothing, as for Git, carries no object
 *  and is not used. A Git step that fails throws, as a failed copy does. */
function carryOperationRefs(sourceWork, recoveredRepo, sourceGit) {
  const written = operationRefsWritten(sourceWork, sourceGit);
  const copied = [];
  for (const name of OPERATION_OBJECT_REFS) if (!written.some((r) => r.name === name)) copied.push(...recoveredOperationObjects(recoveredRepo, name));
  if (!written.length && !copied.length) return;
  const full = objectIdPattern(sourceWork);
  for (const { name, oid } of written) if (!full.test(oid)) throw new Error(`${name} of ${sourceWork} holds ${JSON.stringify(oid)}, which is not a full object id of the repository's object format`);
  // A line of a copied file that is no full object id names no object: the copy holds the same
  // file, which Git reads as naming nothing there either, and the line reaches no Git command.
  const named = [...written.map((r) => r.oid), ...copied.filter((oid) => full.test(oid))];
  if (!named.length) return;
  const commits = [], trees = [], blobs = [];
  for (const [oid, type] of gitObjectTypes(sourceWork, [...new Set(named)])) {
    if (type === "tree") { const under = missingTreeObjects(sourceWork, recoveredRepo, oid); trees.push(...under.trees); blobs.push(...under.blobs); }
    else if (type === "blob") blobs.push(oid);
    else if (type !== "missing") commits.push(oid);
  }
  carryNamedObjects(sourceWork, recoveredRepo, { commits, trees, blobs });
  for (const { name, oid } of written) retireGit(recoveredRepo, ["update-ref", name, oid]);
}

/** Give a recovery clone the source's effective exclude rules, so the status comparison sees the same
 *  ignored paths. A fresh clone has neither the common dir's info/exclude nor a repository-configured
 *  core.excludesFile, so a path excluded only there is `!!` in the source and `??` in the clone. Both are
 *  written into the clone's own info/exclude (self-contained): core.excludesFile first, then
 *  info/exclude, which keeps Git's precedence (a later pattern wins, and info/exclude outranks
 *  core.excludesFile). → the sources carried, [{ kind, path }]. */
function carryExcludes(sourceWork, recoveredRepo) {
  const carried = [], parts = [];
  // A file with no pattern line (Git's template info/exclude is comments only) changes nothing: not carried.
  const carry = (kind, file) => {
    if (!existsSync(file)) return;
    const text = readFileSync(file, "utf8");
    if (!text.split("\n").some((line) => line.trim() && !line.startsWith("#"))) return;
    parts.push(text); carried.push({ kind, path: file });
  };
  const excludesFile = copierExcludesFile(sourceWork);
  if (excludesFile) carry("core.excludesFile", excludesFile);
  carry("info/exclude", join(copierCommonDir(sourceWork), "info", "exclude"));
  if (!carried.length) return carried;
  mkdirSync(join(recoveredRepo, ".git", "info"), { recursive: true });
  writeFileSync(join(recoveredRepo, ".git", "info", "exclude"), parts.map((t) => (t.endsWith("\n") ? t : `${t}\n`)).join(""));
  return carried;
}

/** Repository settings that change what `git status` reports for the same bytes and index. */
const STATUS_CONFIG = ["core.fileMode", "core.ignoreCase", "core.precomposeUnicode", "core.symlinks", "core.autocrlf", "core.eol"];
/** Give a recovery clone the source's status-affecting settings, so the status comparison judges the same
 *  bytes the same way. A fresh clone probes its own core.fileMode/ignoreCase/… and lacks the common dir's
 *  info/attributes, so e.g. core.fileMode=false with a mode-only change is clean in the source and ` M` in
 *  the clone. Each key whose effective value differs is set (or, unset in the source, unset) in the
 *  clone's local config; info/attributes is copied to the clone's (the same precedence). → what was
 *  carried: [{ kind: "config", key, value } | { kind: "info/attributes", path }]. */
function carryStatusConfig(sourceWork, recoveredRepo) {
  const get = (repo, key) => {
    try { return retireGit(repo, ["config", "--get", key], { encoding: "utf8" }).replace(/\n$/, ""); }
    catch (e) { if (e.status === 1) return null; throw e; }
  };
  const carried = [];
  for (const key of STATUS_CONFIG) {
    const value = get(sourceWork, key);
    if (value === get(recoveredRepo, key)) continue;
    retireGit(recoveredRepo, ["config", "--local", ...(value === null ? ["--unset-all", key] : [key, value])]);
    carried.push({ kind: "config", key, value });
  }
  const common = copierCommonDir(sourceWork);
  const attributes = copiedGitPath(GIT_ATTRIBUTES, null, common);
  if (copyRegularFile(attributes, copiedGitPath(GIT_ATTRIBUTES, null, join(recoveredRepo, ".git")))) carried.push({ kind: "info/attributes", path: attributes });
  return carried;
}

/** Make a recovery clone stand on its own: give it the source's stash (the
 *  ref, its log, and every commit the copied log names: awebai/oats#654),
 *  prove it holds those and `commits` (what the caller's carried metadata
 *  names) with carryNamedObjects, then remove the remote it was cloned from.
 *  The log is copied as a file where it is one. In the reftable format it is
 *  not (awebai/oats#1038): its entries are read through Git (stashEntries) and
 *  written back with `git stash store`, so that `git stash list` reads the
 *  same in the copy. */
function detachRecoveryClone(source, recovered, commits = []) {
  const named = [...commits];
  let stash, entries = [];
  try { stash = retireGit(source, ["rev-parse", "--verify", "--quiet", "refs/stash"], { encoding: "utf8" }).trim(); }
  catch { stash = undefined; }
  if (stash) {
    copierFetch(recovered, source, ["refs/stash:refs/stash"]);
    named.push(stash);
    const sourceCommon = copierCommonDir(source);
    const stashLog = copiedGitPath(GIT_STASH_LOG, null, sourceCommon);
    const recoveredLog = copiedGitPath(GIT_STASH_LOG, null, join(recovered, ".git"));
    if (copyRegularFile(stashLog, recoveredLog)) named.push(...reflogCommits(recoveredLog));
    else {
      entries = stashEntries(source);
      named.push(...entries.map((e) => e.oid));
    }
  }
  carryNamedObjects(source, recovered, { commits: named });
  if (entries.length) storeStashEntries(source, recovered, entries);
  try { retireGit(recovered, ["remote", "remove", "origin"]); } catch { /* no remote is already independent */ }
}
/** The stash's entries as Git reads them from its reflog, oldest first:
 *  { oid, subject, line }, `subject` the entry's message (`%gs`), `line` its row
 *  as read. Read only where the log is not a file (the reftable format). A
 *  message that is not UTF-8 cannot be given back to Git as an argument: that
 *  refuses the copy, as an object id that is not a full one does. */
function stashEntries(source) {
  const full = objectIdPattern(source);
  const rows = retireGit(source, ["reflog", "show", "--format=%H %gs", "refs/stash", "--"]);
  const out = [];
  for (const bytes of splitLines(rows)) {
    const line = bytes.toString("utf8");
    if (!Buffer.from(line).equals(bytes)) throw new Error(`a stash entry of ${source} has a message that is not UTF-8, and Git cannot be given it back`);
    const space = line.indexOf(" ");
    const oid = space < 0 ? line : line.slice(0, space);
    if (!full.test(oid)) throw new Error(`a stash entry of ${source} names ${JSON.stringify(oid)}, which is not a full object id of the repository's object format`);
    out.push({ oid, subject: space < 0 ? "" : line.slice(space + 1), line });
  }
  return out.reverse();
}
/** Write `entries` (stashEntries) into the copy's stash, oldest first, over the
 *  fetched ref and its empty log, then check that the copy's stash reads as the
 *  source's, entry for entry. */
function storeStashEntries(source, recovered, entries) {
  retireGit(recovered, ["update-ref", "-d", "refs/stash"]);
  for (const { oid, subject } of entries) retireGit(recovered, ["stash", "store", "-m", subject, oid]);
  const copied = splitLines(retireGit(recovered, ["reflog", "show", "--format=%H %gs", "refs/stash", "--"])).map((b) => b.toString("utf8")).reverse();
  if (copied.length !== entries.length || copied.some((line, i) => line !== entries[i].line)) {
    throw new Error(`the recovery's stash does not read as the stash of ${source}: ${entries.length} entries there, ${copied.length} written`);
  }
}
/** The lines of Git's output, each as bytes, without the line feed that ends it. */
function splitLines(out) {
  const lines = [];
  for (let at = 0; at < out.length;) {
    let end = out.indexOf(10, at);
    if (end < 0) end = out.length;
    if (end > at) lines.push(out.subarray(at, end));
    at = end + 1;
  }
  return lines;
}

/** The commit at a repository's HEAD as the copier reads it, or null when
 *  its HEAD has none: a branch nobody has committed on (`git init` and no
 *  commit, `git switch --orphan`). Only Git's own quiet answer (exit 1) is
 *  "none"; any other failure of the read throws. */
function copierHeadCommit(repo) {
  try { return retireGit(repo, ["rev-parse", "--verify", "--quiet", "HEAD"], { encoding: "utf8" }).trim(); }
  catch (e) { if (e.status === 1) return null; throw e; }
}

/** A path under a Git directory for a ref name read as bytes: a branch name
 *  need not be UTF-8, and the file Git keeps for it is named by its bytes. */
const gitPathOf = (dir, ...parts) => Buffer.concat([Buffer.from(`${dir}${sep}`), ...parts]);
const parentOf = (path) => path.subarray(0, path.lastIndexOf(sep.charCodeAt(0)));

/** Give the clone of a nested repository the source's refs where they matter
 *  for recovering work (awebai/oats#657): every local branch under its name at
 *  its commit, HEAD on the source's branch when the source is on one (`name`:
 *  headName) and detached at `head` otherwise, and the source's reflogs of
 *  HEAD and of each branch, copied over the clone's own. `head` is null when
 *  the source's HEAD has no commit (copierHeadCommit: `git init` and nothing
 *  committed, `git switch --orphan`): the copy's HEAD is then put on the same
 *  branch and checked to have no commit either. The branches are the
 *  source's own `refs/heads`, not the clone's `refs/remotes/origin/*`: those
 *  are only what the source advertises, and its configuration can hide a
 *  branch from a clone (`uploadpack.hideRefs`). A tip the clone lacks is
 *  fetched by id (carryNamedObjects), and the copy's branches are then
 *  checked to be the source's, name and commit, byte for byte. Its local
 *  configuration is not carried beyond the status settings
 *  (carryStatusConfig): a recovery must be inert to inspect, and
 *  configuration can name programs Git runs. → the commits the copied
 *  reflogs name, for carryNamedObjects: a commit only a reflog reaches is not
 *  in the clone until it is fetched. */
function carryNestedRefs(source, dest, name, head) {
  const BRANCHES = ["for-each-ref", "--format=%(objectname)%00%(refname)", "refs/heads/"];
  const listing = retireGit(source, BRANCHES);
  const branches = [];
  for (let at = 0; at < listing.length;) {
    let end = listing.indexOf(0x0a, at);
    if (end < 0) end = listing.length;
    const row = listing.subarray(at, end);
    at = end + 1;
    if (!row.length) continue;
    const nul = row.indexOf(0);
    branches.push({ oid: row.subarray(0, nul).toString("latin1"), ref: row.subarray(nul + 1) });
  }
  carryNamedObjects(source, dest, { commits: branches.map((b) => b.oid) });
  if (branches.length) {
    retireGit(dest, ["update-ref", "--stdin"], { input: Buffer.concat(branches.flatMap(({ oid, ref }) => [Buffer.from("update "), ref, Buffer.from(` ${oid}\n`)])) });
  }
  if (!retireGit(dest, BRANCHES).equals(listing)) throw new Error(`nested recovery ${dest} does not have the local branches of its source`);
  if (name.branch !== null) retireGit(dest, ["symbolic-ref", "HEAD", `refs/heads/${name.branch}`]);
  else retireGit(dest, ["checkout", "--quiet", "--detach", head]);
  const recovered = copierHeadCommit(dest);
  if (head === null) {
    // No commit to be at: the copy's HEAD names the source's branch, and has no commit either.
    if (recovered !== null) throw new Error(`nested recovery ${dest} is at ${recovered}, and the HEAD of its source has no commit`);
    if (!headName(dest).ref?.equals(name.ref)) throw new Error(`nested recovery ${dest} is not on the branch the HEAD of its source names`);
  } else if (recovered !== head) throw new Error(`nested recovery ${dest} is at ${recovered ?? "no commit"}, not at the commit ${head} its source has checked out`);
  // The reflogs last, so that nothing above writes to them after the copy.
  const named = [];
  const carryLog = (from, to) => {
    if (copyRegularFile(from, to)) named.push(...reflogCommits(to));
    else rmSync(to, { force: true });
  };
  const destGit = join(dest, ".git");
  carryLog(gitPathOf(copierGitDir(source), Buffer.from("logs/HEAD")), gitPathOf(destGit, Buffer.from("logs/HEAD")));
  const sourceCommon = copierCommonDir(source);
  for (const { ref } of branches) carryLog(gitPathOf(sourceCommon, Buffer.from("logs/"), ref), gitPathOf(destGit, Buffer.from("logs/"), ref));
  return named;
}

/** Rebuild each nested repository (nestedGitRoots) in the copy of a worktree
 *  at `recoveredRepo`, from a clone, and mirror its files into it
 *  (mirrorTopLevel). It runs after the worktree's own mirror, which put every
 *  nested repository's plain files in place; each rebuild replaces one of
 *  them. No root is under another (nestedGitRoots does not go into a
 *  repository), so no mirror here removes a repository rebuilt before it.
 *  Git is run on each repository by its path, which Node passes as UTF-8
 *  text: a repository whose path is not valid UTF-8 cannot be named to Git,
 *  and refuses the copy. */
function materializeNestedRepositories(sourceWork, recoveredRepo) {
  const excludes = [], statusConfig = [];
  for (const root of nestedGitRoots(sourceWork)) {
    const source = root.toString("utf8");
    if (!Buffer.from(source).equals(root)) throw new Error(`nested repository ${source} has a path that is not valid UTF-8, and Git cannot be run on such a path; rename the directory, then retire again`);
    const rel = relative(sourceWork, source);
    const dest = join(recoveredRepo, rel);
    const name = headName(source);
    const head = copierHeadCommit(source);
    // No commit to detach the copy at, and no branch to put it on. What its
    // HEAD holds is not said: it is a file's content, and need not be text.
    if (head === null && name.branch === null) throw new Error(`nested repository ${source} has no commit at its HEAD, and its HEAD names no local branch`);
    rmSync(dest, { recursive: true, force: true });
    cloneRecovery(["--no-local", "--quiet", source, dest]);
    detachRecoveryClone(source, dest, carryNestedRefs(source, dest, name, head));
    restoreStandaloneGitState(source, dest);
    for (const c of carryExcludes(source, dest)) excludes.push({ repo: rel, ...c });
    for (const c of carryStatusConfig(source, dest)) statusConfig.push({ repo: rel, ...c });
    mirrorTopLevel(source, dest);
    if (existsSync(join(dest, ".git", "objects", "info", "alternates"))) throw new Error(`nested recovery ${rel} depends on object alternates`);
    assertStatusAgrees(source, dest, `nested recovery ${rel} Git state disagreed with source`, rel);
  }
  return { excludes, statusConfig };
}

/** Bytes a path holds, never following a symlink (a link counts as its own
 *  entry). `path` is a string or a Buffer; names under it are read as bytes. */
function treeBytes(path) {
  let st; try { st = lstatSync(path); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const name of readdirSync(path, { encoding: "buffer" })) n += treeBytes(joinBytes(path, name));
  return n;
}
/** The paths of the untracked (`??`) and ignored (`!!`) rows of
 *  `git status --porcelain=v1 -z` output, as bytes. */
function untrackedOrIgnoredPaths(z) {
  const out = [];
  for (let at = 0; at < z.length;) {
    let end = z.indexOf(0, at);
    if (end < 0) end = z.length;
    const row = z.subarray(at, end);
    at = end + 1;
    const xy = row.subarray(0, 3).toString("latin1");
    if (xy === "?? " || xy === "!! ") out.push(row.subarray(3));
  }
  return out;
}
/** The outputs a recovery copies beyond committed and tracked state — a worktree's
 *  untracked and ignored paths (its status), or a directory's work entries —
 *  grouped by top-level entry with their bytes, largest first. There is no
 *  disposable declaration on the workspace model, so node_modules/ or build/
 *  outputs are copied too: the retire summary names them and what they cost. */
function preservedOutputs(work, directory) {
  // Paths as bytes, so every one is read by its own name; each group is
  // named as text, a name that is not UTF-8 with replacement characters.
  const rows = directory ? readdirSync(work, { encoding: "buffer" }) : untrackedOrIgnoredPaths(worktreeStatusBytes(work));
  const SLASH = 0x2f;
  const groups = new Map();
  for (const rel of rows) {
    const trailing = rel.length > 0 && rel[rel.length - 1] === SLASH;
    const slash = rel.indexOf(SLASH);
    const first = slash < 0 ? rel : rel.subarray(0, slash);
    const isDir = (slash >= 0 && slash < rel.length - 1) || trailing || (directory && lstatSync(joinBytes(work, rel)).isDirectory());
    const key = isDir ? `${first.toString("utf8")}/` : first.toString("utf8");
    groups.set(key, (groups.get(key) || 0) + treeBytes(joinBytes(work, rel)));
  }
  const paths = [...groups].map(([path, bytes]) => ({ path, bytes })).sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  return { paths, bytes: paths.reduce((n, p) => n + p.bytes, 0) };
}

/** The home part of a recovery at `dest`: everything but work/ and this pass's
 *  excluded provider-owned entries (observation.homeExclude), verified against
 *  the source with that same set. The copy is hashed whole, so an excluded
 *  entry that reached it fails the verification. Source and copy are compared
 *  in this run, so whatever version the baseline holds, the stored digest of
 *  version 2 is what is compared (fingerprintTrees): its order is the bytes'
 *  and its fields carry their lengths. It leaves the kernel's own fields of
 *  instance.json out, so a kernel write there between the copy and this check
 *  is not a disagreement. That is why this is not an exact verification of
 *  the whole home: the stored digest also passes over the kernel's receipts
 *  and the harness settings, and reads instance.json through a parse. */
function copyRecoveryHome(observation, dest) {
  // The launch environment's key and the digests made with it never leave the home
  // (lib/start-env.mjs): a recovery copy leaves them, and any temporary file of theirs, out.
  const excludeRoot = new Set(observation.homeExclude || ["work"]);
  for (const name of readdirSync(observation.home)) if (name === START_ENV_FILE || name === START_ENV_KEY_FILE || START_ENV_TMP.test(name)) excludeRoot.add(name);
  copyRecoveryTree(observation.home, dest, { excludeRoot });
  if (storedTreeDigest(observation.home, BASELINE_DIGEST_VERSION, { excludeRoot, instanceHome: true }) !== storedTreeDigest(dest, BASELINE_DIGEST_VERSION, { instanceHome: true })) {
    throw new Error("home recovery verification disagreed with the source");
  }
}

/** The work part of a recovery under `parent`, copied and verified: `repo/`, a
 *  standalone clone of a worktree instance's repository carrying its
 *  uncommitted state, or `work/`, a directory instance's bytes. A worktree's
 *  source bytes are the observation's (observedWorkBytes), so the verified
 *  value is also its byte state. → { copied, branchDrift?, excludes?,
 *  statusConfig? }; `copied` is false where neither applies (another work
 *  mode, a worktree home with no repo, or one whose worktree is gone and
 *  whose record holds no branch). A HEAD that
 *  cannot be read is an inspection failure, not a failed copy: its error is
 *  put in `unreadableHeads`, and the callers throw it as it is. */
const unreadableHeads = new WeakSet();
function copyRecoveryWork(observation, meta, parent, { rereadSource = true } = {}) {
  let branchDrift, excludes, statusConfig, copied = false;
  // A worktree that is there is copied from itself: only one that is gone needs the recorded
  // branch, to be copied from the repository. (An own tree whose record holds no branch, #962.)
  if (meta.work === "worktree" && meta.repo && (existsSync(observation.work) || (meta.branch && observation.branchExists))) {
    const recoveredRepo = join(parent, "repo");
    // The branch is derived from the worktree while it exists: an instance
    // that legitimately switched branches during its task must still be
    // recoverable, and the recorded spawn-time branch is only the fallback
    // when the worktree is gone. A HEAD that is detached, or on a ref OATS
    // carries no name for, recovers detached at its exact commit.
    let ref;
    try { ref = existsSync(observation.work) ? worktreeHead(observation.work) : { branch: meta.branch, commit: null }; }
    catch (e) { unreadableHeads.add(e); throw e; }
    if (meta.branch && ref.branch !== meta.branch) branchDrift = { recordedBranch: meta.branch, worktreeBranch: ref.branch, detachedAt: ref.branch === null ? ref.commit : null };
    if (ref.branch !== null) cloneRecovery(["--no-local", "--quiet", "--branch", ref.branch, meta.repo, recoveredRepo]);
    else {
      cloneRecovery(["--no-local", "--quiet", "--no-checkout", meta.repo, recoveredRepo]);
      copierFetch(recoveredRepo, observation.work, [ref.commit]);
      retireGit(recoveredRepo, ["checkout", "--quiet", "--detach", ref.commit]);
    }
    const sourceGitContext = existsSync(observation.work) ? observation.work : meta.repo;
    detachRecoveryClone(sourceGitContext, recoveredRepo);
    if (existsSync(observation.work)) {
      restoreStandaloneGitState(observation.work, recoveredRepo);
      excludes = carryExcludes(observation.work, recoveredRepo).map((c) => ({ repo: ".", ...c }));
      statusConfig = carryStatusConfig(observation.work, recoveredRepo).map((c) => ({ repo: ".", ...c }));
      // The worktree's top level first, then each nested repository rebuilt
      // inside it (materializeNestedRepositories): that order is what keeps
      // a rebuilt repository from being removed by a mirror.
      mirrorTopLevel(observation.work, recoveredRepo);
      const nested = materializeNestedRepositories(observation.work, recoveredRepo);
      excludes.push(...nested.excludes); statusConfig.push(...nested.statusConfig);
    }
    if (existsSync(join(recoveredRepo, ".git", "objects", "info", "alternates"))) throw new Error("recovery clone depends on object alternates");
    if (existsSync(observation.work)) {
      // The source's bytes as this observation holds them: read before the
      // pre-hook recovery was written, or by the proof that the hooks moved
      // nothing, or else here. Either way they are kept as the observation's
      // byte state.
      // The Git directories the comparison leaves out are the source's
      // (worktreeGitPaths), read with its bytes, for both sides.
      let sourceBytes, gitPaths;
      if (observation.worktree) { sourceBytes = observedWorkBytes(observation); gitPaths = observation.workGitPaths ?? worktreeGitPaths(observation.work); }
      else { gitPaths = worktreeGitPaths(observation.work); sourceBytes = worktreeBytes(observation.work, gitPaths); }
      if (sourceBytes !== worktreeBytes(recoveredRepo, gitPaths)) throw recoveryDisagreed("worktree recovery verification disagreed with the source", observation.work, recoveredRepo, gitPaths);
      assertStatusAgrees(observation.work, recoveredRepo, "recovered Git index/status disagreed with the source", ".");
    }
    // The proof of the copy: its HEAD is the commit the worktree has checked
    // out. A branch of the repository can be at another commit with the
    // same files, so the branch's tip there proves nothing about the copy.
    // With the worktree gone there is no such commit to read, and the copy
    // is the recorded branch as the repository has it.
    const recoveredHead = retireGit(recoveredRepo, ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const sourceHead = ref.commit
      ?? retireGit(meta.repo, ["rev-parse", `refs/heads/${ref.branch}`], { encoding: "utf8" }).trim();
    if (recoveredHead !== sourceHead) throw new Error(ref.commit ? "recovery clone is not at the commit the worktree has checked out" : "recovery clone does not retain the instance branch tip");
    copied = true;
  }
  if (observation.directory && observation.directoryFingerprint) {
    const recoveredWork = join(parent, "work");
    copyTreeSafe(observation.work, recoveredWork);
    // The copy is read back and held against the inspected bytes. A change to
    // the source before the copy read it is in the copy, and refuses here. One
    // made during the copy, to a file already copied, is not: the source is
    // read again for that unless `rereadSource` is false, which only the
    // retire's pre-hook copy passes. There the inspection after the hooks
    // reads the source again in any case, sees the change and copies the work
    // again, verified, under after-hooks/ (#1247). Every other copy is the
    // last read of its source before the home is removed.
    if ((rereadSource && directoryBytes(observation.work) !== observation.directoryFingerprint) || directoryBytes(recoveredWork) !== observation.directoryFingerprint) {
      throw new Error("directory recovery verification disagreed with the inspected source");
    }
    copied = true;
  }
  return { copied, branchDrift, excludes, statusConfig };
}

/** The top-level entries of a recovery's home snapshot with their bytes,
 *  largest first; a directory ends in `/`. What the retire summary names as
 *  copied from the home. */
function preservedHome(recoveredHome) {
  const paths = entriesAsBytes(recoveredHome)
    .map((e) => ({ path: e.isDirectory() ? `${e.name.toString("utf8")}/` : e.name.toString("utf8"), bytes: treeBytes(joinBytes(recoveredHome, e.name)) }))
    .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  return { paths, bytes: paths.reduce((n, p) => n + p.bytes, 0) };
}

/** Whether a recovery of this observation holds the home only. A home-only
 *  change (notes, harness files, credentials) needs a home snapshot, not
 *  another copy of an otherwise disposable clean worktree. In-progress Git
 *  operations retain the full standalone recovery even when porcelain status
 *  has no changed paths. An orphaned work directory (no git admin entry) stays
 *  where it is, never moved or removed, and git cannot read it: only the home
 *  is snapshotted. A worktree that cannot be proven unchanged (workProvable
 *  false) is never home-only: after the hooks it could be neither proven nor
 *  taken as copied, so its work goes into the snapshot before them. */
function homeOnlyRecovery(observation, meta) {
  if (observation.orphanedWork === true) return true;
  if (observation.workProvable === false) return false;
  if (!(observation.classes.length === 1 && observation.classes[0] === "changed instance-home bytes" && meta.work === "worktree" && existsSync(observation.work))) return false;
  return !gitOperationInProgress(copierGitDir(observation.work), observation.work);
}

/** Remove a recovery's staging directory, after a copy that failed or that had
 *  nothing to keep. The copy gives each directory its source's mode
 *  (tree-copy.mjs), and a read-only one (a Go module cache, 0555) keeps
 *  rmSync from unlinking what is in it: each directory is made u+rwx first,
 *  before it is read (an unreadable one could not be listed), symbolic links
 *  are never followed, and then the tree is removed. Names are listed and
 *  joined as bytes, as the copier writes them, so a directory whose name is
 *  not UTF-8 is reached too (#827). Never throws: a cleanup
 *  must not replace the error that made it (#659). → null when the staging is
 *  gone, else the clause a refusal adds to name what is left. */
function removeStaging(staging) {
  const open = (dir) => {
    let names;
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory()) return;
      if ((st.mode & 0o700) !== 0o700) chmodSync(dir, (st.mode & 0o7777) | 0o700);
      names = entriesAsBytes(dir).map((e) => e.name);
    } catch { return; }
    for (const name of names) open(joinBytes(dir, name));
  };
  try { open(staging); rmSync(staging, { recursive: true, force: true }); } catch { /* named below */ }
  try { lstatSync(staging); } catch (e) { if (e?.code === "ENOENT") return null; }
  return `; its partial copy ${staging} could not be removed: remove it by hand`;
}

/** Write one verified recovery of an observed home and work: staged beside its
 *  final name and renamed into place. `phase` goes into recovery.json:
 *  "before-hooks" for the snapshot a retirement takes before its retire hooks
 *  (completeRetirementRecovery concludes it), "complete" for a recovery nothing
 *  will add to. → { receipt, manifest }: the receipt retire reports, and
 *  recovery.json as written. */
function writeRetirementRecovery(observation, meta, instance, phase) {
  const recoveryRoot = retirementRecoveryRoot(dirname(observation.home));
  mkdirSync(recoveryRoot, { recursive: true });
  if (observation.directory && realpathSync(recoveryRoot) !== join(realpathSync(dirname(observation.home)), ".oats-retirement", "recovery")) {
    throw oatsError("E_WORK_PRESERVATION_FAILED", "directory recovery storage was redirected; retain the source home rather than copying into an unowned or disposable location");
  }
  const staging = mkdtempSync(join(recoveryRoot, `.${instance}-`));
  const recovery = join(recoveryRoot, basename(staging).slice(1));
  try {
    const homeOnly = homeOnlyRecovery(observation, meta);
    const recoveredHome = join(staging, "home");
    copyRecoveryHome(observation, recoveredHome);
    const { branchDrift, excludes, statusConfig } = homeOnly ? {} : copyRecoveryWork(observation, meta, staging, { rereadSource: phase !== "before-hooks" });
    const repoCopy = homeOnly ? { copied: false, reason: "Only instance-home bytes changed; no work state requires a repository copy", source: meta.repo, branch: meta.branch } : undefined;
    // What the copy cost: the home entries it carries and the untracked/ignored (or directory) outputs, named.
    const home = preservedHome(recoveredHome);
    const workCopied = observation.directory ? !!observation.directoryFingerprint : !homeOnly && meta.work === "worktree" && existsSync(observation.work);
    const outputs = workCopied ? preservedOutputs(observation.work, observation.directory) : undefined;
    const notCopied = observation.notCopied?.length ? observation.notCopied : undefined;
    const manifest = { version: 1, phase, instance, classes: observation.classes, sourceHome: observation.home, createdAt: new Date().toISOString(), ...(repoCopy ? { repoCopy } : {}), ...(branchDrift ? { branchDrift } : {}), ...(excludes?.length ? { excludes } : {}), ...(statusConfig?.length ? { statusConfig } : {}), home, ...(outputs ? { outputs } : {}), ...(notCopied ? { notCopied } : {}) };
    writeFileSync(join(staging, "recovery.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    const bytes = treeBytes(staging);
    mkdirSync(dirname(recovery), { recursive: true });
    renameSync(staging, recovery);
    return { receipt: { path: recovery, classes: observation.classes, bytes, home, ...(outputs ? { outputs } : {}), ...(repoCopy ? { repoCopy } : {}), ...(notCopied ? { notCopied } : {}) }, manifest };
  } catch (e) {
    const left = removeStaging(staging);
    if (unreadableHeads.has(e)) { if (left) e.message += left; throw e; }
    const details = preservationDetails(observation.home, e);
    throw Object.assign(oatsError("E_WORK_PRESERVATION_FAILED", `retirement work remains at ${observation.home}; recovery could not be verified: ${e.message}${left ?? ""}`, details), details ? { details } : {});
  }
}

/** One complete recovery, for a caller with no retire hooks still to run
 *  between the snapshot and the removal. → its receipt. */
function preserveRetirementWork(observation, meta, instance) {
  return writeRetirementRecovery(observation, meta, instance, "complete").receipt;
}

/** The post-hook check on the recovery a retirement wrote before its retire
 *  hooks. Each part a hook moved (movedByHooks: the home by its bytes, the work
 *  unless it is proven unchanged) is copied again, whole and verified, under
 *  `after-hooks/`; nothing under the pre-hook `home/`, `repo/` or `work/` is
 *  written, moved or removed. The home is not copied again merely because the
 *  work is: a home whose every byte the hooks left as it was (its exact
 *  digest) is in the pre-hook snapshot as it still is.
 *  `after-hooks/` is staged inside the recovery under a dot-name and renamed
 *  into place; an `after-hooks` entry that already exists is a failure, never
 *  replaced. Then ONE atomic rewrite of recovery.json records `afterHooks` and
 *  moves `phase` to "complete" (the same rewrite, without `afterHooks`, when
 *  the hooks changed nothing). Until that rewrite the manifest says
 *  "before-hooks", so an interrupted pass under-reports and can never read as
 *  complete. A failure removes the staging, leaves the pre-hook snapshot and
 *  its manifest as they were, and refuses: the caller keeps the home.
 *  Directory mode: the retire hooks ran since the pre-hook pass verified that
 *  the recovery sits in the owned storage beside the home, so that is verified
 *  again before anything is written through its path.
 *  → the receipt, updated: `classes` and `notCopied` are the union of both
 *  passes, `bytes` covers the whole directory. */
function completeRetirementRecovery({ receipt, manifest }, before, after, meta) {
  const recovery = receipt.path;
  const moved = movedByHooks(before, after);
  const wantHome = moved.home;
  const final = join(recovery, "after-hooks");
  const manifestPath = join(recovery, "recovery.json");
  const manifestTmp = join(recovery, `.recovery.json.${process.pid}.tmp`);
  const occupied = () => { try { lstatSync(final); return true; } catch { return false; } };
  const assertOwnedStorage = () => {
    if (!after.directory) return;
    let owned = false;
    try { owned = realpathSync(recovery) === join(realpathSync(dirname(after.home)), ".oats-retirement", "recovery", basename(recovery)); } catch { /* gone: not the owned storage */ }
    if (!owned) throw new Error("directory recovery storage was redirected");
  };
  let staging;
  try {
    assertOwnedStorage();
    // Work that is not proven unchanged is copied. So is work this recovery does
    // not hold yet: a pre-hook snapshot that was home-only stands for no work,
    // so "unchanged" proves nothing about it. When the observation after the
    // hooks is not home-only by that pass's own rule, the work is copied, moved
    // or not: a class can appear from outside the work state (the baseline is
    // gone). That rule only ever adds a copy attempt here; it never skips one.
    // It asks Git, so it is decided in here: a failure refuses like any other
    // in this pass.
    const firstWorkCopy = receipt.repoCopy?.copied === false && after.classes.length > 0 && !homeOnlyRecovery(after, meta);
    const wantWork = !after.orphanedWork && (moved.work || firstWorkCopy);
    let afterHooks;
    if (wantHome || wantWork) {
      if (occupied()) throw new Error(`${final} already exists`);
      staging = mkdtempSync(join(recovery, ".after-hooks-"));
      if (wantHome) copyRecoveryHome(after, join(staging, "home"));
      const workCopied = wantWork && copyRecoveryWork(after, meta, staging).copied;
      if (wantHome || workCopied) {
        if (occupied()) throw new Error(`${final} already exists`);
        renameSync(staging, final);
        afterHooks = { home: wantHome, work: workCopied };
      } else {
        const left = removeStaging(staging);
        staging = undefined;
        if (left) throw new Error(`nothing was copied after the hooks${left}`);
      }
      staging = undefined;
    }
    const classes = [...new Set([...receipt.classes, ...after.classes])];
    const notCopied = unionNotCopied(receipt.notCopied, after.notCopied);
    const { notCopied: _before, ...rest } = manifest;
    assertOwnedStorage();
    // A failed write or rename removes its private file and throws its own error (#1076).
    writeThroughPrivateFile(manifestPath, manifestTmp, JSON.stringify({ ...rest, phase: "complete", classes, ...(notCopied.length ? { notCopied } : {}), ...(afterHooks ? { afterHooks } : {}) }, null, 2) + "\n", 0o600);
    const { notCopied: _was, ...kept } = receipt;
    return { ...kept, classes, bytes: treeBytes(recovery), ...(notCopied.length ? { notCopied } : {}), ...(afterHooks ? { afterHooks } : {}) };
  } catch (e) {
    const left = staging ? removeStaging(staging) : null;
    if (unreadableHeads.has(e)) { if (left) e.message += left; throw e; }
    const details = preservationDetails(after.home, e);
    throw Object.assign(oatsError("E_WORK_PRESERVATION_FAILED", `retirement work remains at ${after.home}; recovery could not be verified: ${e.message}${left ?? ""}`, details), details ? { details } : {});
  }
}

/** The `work` link of the instance at `kidHome` when it is attached to the
 *  tree at `tree` (#718, #964), else null. `tree` is a tree of a home: its
 *  `<home>/work`, or an extra tree of it (`<home>/.work-<purpose>`). Attached:
 *  instance.json says `work: "attached"`, and its `work` is a symbolic link
 *  that leads to the tree, as written (in any spelling of the home) or
 *  through other links (`--work-dir` given as an alias of the tree). The
 *  latter is seen only while the tree exists, so whoever moves or removes the
 *  tree asks first. The one test of who is attached to a tree: the retire,
 *  its plan and `oats worktree remove` read it. → the link's target as
 *  written: the evidence a later relink checks is still there. */
export function attachedWorkLink(kidHome, tree) {
  if (readJsonOrUndefined(join(kidHome, "instance.json"))?.work !== "attached") return null;
  const link = join(kidHome, "work");
  let written;
  try { written = readlinkSync(link); } catch { return null; }
  const target = resolve(kidHome, written), at = resolve(tree);
  if (target === at) return written;
  // Existing paths are compared in their one spelling on disk (realpathSync.native, as
  // canonicalHomePath): on a case-insensitive filesystem JS realpathSync keeps the caller's letter
  // case, so a tree named as `.WORK-X` and as `.work-x` would read as two trees.
  try { if (basename(target) === basename(at) && realpathSync.native(dirname(target)) === realpathSync.native(dirname(at))) return written; } catch { /* below */ }
  try { return realpathSync.native(link) === realpathSync.native(at) ? written : null; } catch { return null; }
}
/** Point an attached instance's `work` link at `to`, atomically: a new link
 *  beside it is renamed over the old one, so the link is never missing. */
function relinkAttachedWork(kidHome, to) {
  const tmp = join(kidHome, `.work.relink-${process.pid}`);
  try { rmSync(tmp, { force: true }); symlinkSync(to, tmp); renameSync(tmp, join(kidHome, "work")); }
  catch (e) { try { rmSync(tmp, { force: true }); } catch { /* the first error is the one reported */ } throw e; }
}


/** The retire `home` owes, as a status row's `retire` reads it (retireStateOf), or undefined. */
function owedRetire(home) {
  return retireStateOf(home, readRetirePending(home).marker);
}
/** Why `instance`, whose status row's `retire` has `state`, is not resumed: one clause. */
export function owedRetireSaid(instance, state) {
  const said = { running: "is running", unknown: "cannot be told", failed: "failed", interrupted: "was interrupted" }[state] ?? "cannot be told";
  return `${instance} is owed a retire (its retire ${said}); a home OATS is retiring is never resumed`;
}



/** What the detached completion of a self-retire runs. Its intent is its own input: it takes the
 *  variable out of its environment once it has read it, before the retire runs anything, so that
 *  nothing it starts (a retire hook, Git, the stop of a child) inherits it. A hook's environment
 *  is this process's, with what the kernel adds (lifecycleHookEnv). */
const DEFERRED_RETIRE_SCRIPT = `import { completeDeferredRetirement } from ${JSON.stringify(import.meta.url)};
const intent = process.env.OATS_RETIRE_INTENT;
delete process.env.OATS_RETIRE_INTENT;
process.exitCode = completeDeferredRetirement(JSON.parse(intent)) ? 0 : 1;`;

/** Self-retire (aweb-abep): persist intent, then hand the retirement to a
 *  detached process that runs it as an ORDINARY external retirement after the
 *  caller's window has died. Nothing destructive happens in the caller: no
 *  inspection, no hooks, no removal — the harness is still alive, and the
 *  quiesce rule stays intact. The child owns its own process group so the
 *  tmux window kill (SIGHUP to the pane's group) cannot take it down, and the
 *  caller's instance env is stripped so the child is an external operator,
 *  not another self-retire. The intent travels to the child in its env; the
 *  marker beside the home is the operator-visible promise and is written only
 *  once a completion process exists (reviewer D2). */
function scheduleDeferredSelfRetirement(root, found, name, o, session) {
  const delaySec = o.selfKillDelaySec ?? 8;
  const marker = retirePendingMarkerPath(found.home);
  const resultPath = deferredRetireResultPath(found.home);
  const logPath = resultPath.replace(/\.json$/, ".log");
  // A second `--self` while the first completion is still on its way must not
  // start a second, racing retirement: report the one already owed.
  if (existsSync(marker) && !existsSync(resultPath)) {
    let prior; try { prior = JSON.parse(readFileSync(marker, "utf8")); } catch { prior = undefined; }
    if (prior?.resultPath) {
      return { retired: name, agent: found.agent.name, deferred: true, alreadyScheduled: true, pendingMarker: marker, resultPath: prior.resultPath, logPath, completesInSec: prior.delaySec ?? delaySec, requestedAt: prior.requestedAt };
    }
  }
  const intent = {
    instance: name, agent: found.agent.name, root: resolve(root),
    requestedAt: new Date().toISOString(), requestedByPid: process.pid, delaySec,
    // A confirmed plan's extra trees go with the intent, so the completion is bound by them as well.
    options: { home: found.home, ...(o.keepDir ? { keepDir: true } : {}), tmuxSession: session, ...(Array.isArray(o.plannedExtraWorktrees) ? { plannedExtraWorktrees: o.plannedExtraWorktrees } : {}),
      // The recorded children as they were when the retirement was scheduled: the completion stops them first.
      ...(Array.isArray(o.children) ? { children: o.children.map((c) => ({ instance: c.instance, home: c.home })) } : {}) }, resultPath,
  };
  // The completion is told who scheduled it: this process, by pid and by the start token its
  // holding of the home's claim records (lib/claim.mjs takes both from the same reading). It is
  // told in its environment and nowhere else: the marker's format is as it was, and the completion
  // compares the claim against what it was given, never against what it reads later beside the
  // home (completeDeferredRetirement).
  const requestedByStart = processStartToken(process.pid);
  const env = { ...process.env, OATS_RETIRE_INTENT: JSON.stringify({ ...intent, ...(requestedByStart ? { requestedByStart } : {}) }) };
  for (const k of CORE_LAUNCH_ENV) delete env[k];
  rmSync(resultPath, { force: true });
  const scheduleFailed = (why) => oatsError("E_SELF_RETIRE_SCHEDULE_FAILED", `could not start the deferred retirement of ${name}: ${why}. Nothing was inspected, run, or removed; the instance is still live and can be retired externally with \`oats retire ${name} --home ${found.home}\``);
  let fd, child;
  try {
    fd = openSync(logPath, "w");
    child = spawnProcess(process.execPath, ["--input-type=module", "-e", DEFERRED_RETIRE_SCRIPT], {
      detached: true, stdio: ["ignore", fd, fd], env, cwd: dirname(found.home),
    });
  } catch (e) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
    rmSync(logPath, { force: true });
    throw scheduleFailed(e.message);
  }
  // From here a completion process may exist. It acts only once its delay has passed and this
  // retire has released the home's claim (completeDeferredRetirement), so whatever fails before the
  // marker is written ends it first, under the claim: the handle's own SIGKILL, never a pid looked
  // up. A scheduling that fails therefore leaves no completion behind, and "nothing was
  // inspected, run, or removed" stays true after this call has answered.
  let wroteMarker = false;
  try {
    closeSync(fd);
    if (!child.pid) throw scheduleFailed("no process was created");
    // A spawn failure Node reports asynchronously (EAGAIN, EMFILE) would arrive
    // after this returns; record it as a failed outcome so status shows the
    // debt instead of an uncaught exception behind a success message.
    child.on("error", (e) => {
      try {
        writeFileSync(resultPath, JSON.stringify({ instance: name, agent: found.agent.name, requestedAt: intent.requestedAt, completedAt: new Date().toISOString(), ok: false, error: { code: kernelCode(e, "E_SELF_RETIRE_SCHEDULE_FAILED"), message: `the deferred retirement could not start: ${e.message}` }, retry: `oats retire ${name} --home ${found.home}` }, null, 2) + "\n");
      } catch { /* the marker alone then shows RETIRING; status names its age */ }
    });
    child.unref();
    // The marker names its completion (pid and start time; the start is null when it cannot be read):
    // while that process lives, any other retire of this home is refused (refusePendingCompletion).
    const completionStart = processStartToken(child.pid);
    writeFileSync(marker, JSON.stringify({ ...intent, completionPid: child.pid, completionStart }, null, 2) + "\n");
    wroteMarker = true;
    // The marker promises a completion that is on its way. One that has ended by now is not: it
    // looked for its marker before this call wrote one, and nothing would ever remove it. So the
    // scheduling failed. A completion does not start its retire while it reads the claim as this
    // call's, alive (completeDeferredRetirement). So one that has ended by now either did not read
    // it so (this call's liveness could not be read, and its retire answered for that) and left
    // its outcome at `resultPath` (this call removed any earlier one before it started it), or
    // left none: it was killed, or could not write it. Gone is what the kernel reads of a holder
    // that died (processLiveness); a completion whose liveness cannot be read is not gone, and is
    // scheduled.
    if (existsSync(resultPath)) throw scheduleFailed("its completion gave up waiting for this command and has ended");
    if (processLiveness({ pid: child.pid, processStart: completionStart }).state === "gone") throw scheduleFailed("its completion has ended and left no outcome");
  } catch (e) {
    // No outcome is recorded for a completion this call ends itself: the answer below is the outcome.
    child.removeAllListeners("error");
    child.on("error", () => {});
    if (child.pid) { try { child.kill("SIGKILL"); } catch { /* it never ran */ } }
    // Its log, and the outcome it may have recorded: a completion kept waiting for this retire's
    // claim past its own patience gives up and says so there, before the kill reaches it. Both
    // paths are this retire's own (it removed any earlier result before it started the completion),
    // so what is removed here can only be that completion's.
    // Not closed: Node cannot wait for a child synchronously, so a kill that lands inside the
    // completion's own write of that outcome could leave a result after this removal. It would say
    // E_LIFECYCLE_BUSY of a retire that has since answered, and a later `oats retire` removes it.
    // And the marker, when this call wrote it: it names a completion that is not running.
    for (const left of [logPath, resultPath, ...(wroteMarker ? [marker] : [])]) { try { rmSync(left, { force: true }); } catch { /* none is a debt of the instance */ } }
    // "is not running": killed here, or gone by itself before the kill.
    throw e?.code === "E_SELF_RETIRE_SCHEDULE_FAILED" ? e : scheduleFailed(`${e?.message ?? e}; the completion this command had started is not running`);
  }
  return {
    retired: name, agent: found.agent.name, deferred: true, pendingMarker: marker,
    resultPath, logPath, completesInSec: delaySec, completionPid: child.pid,
  };
}

/** The item a quarantine retry reports while the branch its failed spawn created is still there. It
 *  names no branch: the name is the receipt's `retention.recordedBranch`, or the retained home's
 *  instance.json `branch`. */
export const FAILED_SPAWN_BRANCH_LEFT = "the branch the failed spawn created is left: OATS does not delete it. Inspect it and delete it with Git if it is not wanted, then retry";
/** What a `retire-refused` event says of a completion whose cleanup did not finish. It names no item. */
const RETIRE_INCOMPLETE_SENTENCE = (instance) => `the retirement of ${instance} is incomplete: its cleanup did not finish, and the home is retained`;
const OBSOLETE_DELETE_BRANCH_SENTENCE = "this self-retire was requested with --delete-branch by an older OATS; retirement no longer deletes branches, so the branch and the worktree were left";
/** The one internal option that says the retirement completes such an intent.
 *  A symbol, so no caller can set it from parsed arguments or JSON. */
const OBSOLETE_DELETE_BRANCH = Symbol("an older self-retire intent with --delete-branch");
/** The one internal option that says the retirement is a deferred self-retire's completion
 *  (completeDeferredRetirement). A symbol, so no caller can set it from parsed arguments or JSON. */
const COMPLETES_DEFERRED = Symbol("the completion of a deferred self-retire");
/** How long a self-retire's completion waits for the retire that scheduled it to release the
 *  home's claim before it goes on without it (completeDeferredRetirement). Long beside the wait of
 *  a retire for any other holder (CLAIM_WAIT_MS, lib/claim.mjs): the scheduling is this
 *  completion's own, and what it is waited for is a few file writes on a host that may be slow. */
export const SCHEDULING_WAIT_MS = 10 * 60 * 1000;
/** How long a completion pauses between two looks at the claim its scheduling still holds. */
const SCHEDULING_PAUSE_MS = 50;
export const RETIRE_DELETE_BRANCH_REFUSED = "oats retire no longer deletes branches: --delete-branch is not accepted. Retire without it; the branch is left in the repository. Inspect it there and delete it with Git if it is no longer wanted.";

/** Run by the detached child: wait for the caller's window to be gone, then
 *  retire the instance as an ordinary external operator. Returns true only
 *  when the home is actually gone, and then leaves no file behind. Accepts the
 *  intent object (the child gets it in its env) or a marker path.
 *
 *  A completion that does not complete (the retire threw, or its cleanup is incomplete) says so,
 *  since nobody is at a terminal to read its answer (awebai/oats#954). It leaves its outcome beside
 *  the home, which `oats status` lists and `oats retire <name>` retries and clears, and one
 *  `retire-refused` event. Its pending marker follows how far the retire got: it stays when a retire
 *  hook was started or the removal of the home began, because the home is then owed a retire (after
 *  hooks ran, the usual quarantine stays too); otherwise it goes, and the instance is a stopped or
 *  running instance like any other, not one that reads RETIRING for a retire that is not happening.
 *  How far the retire got is read from what it answers (`details.reached`, retireFailure), never
 *  from its code.
 *
 *  A retire whose cleanup is left incomplete by retire hooks alone is tried again first, up to three
 *  times (RETIRE_RETRY_DELAYS_MS; awebai/oats#1747), before that outcome is written, and then the
 *  outcome says how many attempts ran (`attempts`). An outcome after no retry is as it was. */
export function completeDeferredRetirement(intentOrMarkerPath, opts = {}) {
  let intent = intentOrMarkerPath;
  if (typeof intentOrMarkerPath === "string") {
    try { intent = JSON.parse(readFileSync(intentOrMarkerPath, "utf8")); }
    catch (e) { console.error(`deferred retirement: cannot read ${intentOrMarkerPath}: ${e.message}`); return false; }
  }
  if (!isPlainObject(intent) || !intent.instance || !intent.root) { console.error("deferred retirement: intent is not usable"); return false; }
  const record = (payload) => {
    if (!intent.resultPath) return;
    try {
      writeFileSync(intent.resultPath, JSON.stringify({
        instance: intent.instance, agent: intent.agent, requestedAt: intent.requestedAt,
        completedAt: new Date().toISOString(), ...payload,
      }, null, 2) + "\n");
    } catch (e) { console.error(`deferred retirement: cannot write ${intent.resultPath}: ${e.message}`); }
  };
  // An intent an older OATS recorded for `--self --delete-branch`. The
  // retirement it owes is completed; the obsolete option authorizes nothing:
  // the branch and the worktree are left, and the retire says so.
  const obsoleteDeleteBranch = intent.options?.deleteBranch === true;
  const delayMs = Math.max(0, Number(opts.delaySec ?? intent.delaySec ?? 8) * 1000);
  if (delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  // The home this completion answers for is the one its intent names, as every scheduling records
  // it. For an intent that names none the retire finds the instance by its name, and the
  // completion touches no marker and writes no event: a name can stand for more than one home.
  const home = typeof intent.options?.home === "string" && intent.options.home ? intent.options.home : null;
  // The retire that scheduled this completion writes the pending marker last, under the home's
  // claim. Until it has released that claim the completion does not start its retire: it would be
  // refused by its own scheduling for nothing but slowness, and would look for a marker that is
  // not written yet. So it waits here, for exactly one reading of the claim: its holder is the
  // command that scheduled this completion, by pid AND by recorded start, and reads as alive.
  // Who that command is comes from the intent this process was started with, and from nothing it
  // reads later: the claim is only compared against it. An intent that does not say both (a marker
  // the completion is run from, an older kernel's, a start that could not be read) waits for
  // nobody. Every other reading is not waited for, and the retire below answers it as for every
  // retire: that holder gone (taken over), its liveness unreadable, another holder in any state, a
  // file that is no claim, no claim.
  // The wait ends when the scheduling does: it returned (the marker is written by then), it failed
  // (and ended this completion itself), or it died. It also ends at its bound (SCHEDULING_WAIT_MS;
  // `opts.schedulingWaitMs` for a test), and nothing is decided there: the completion goes on to
  // the retire below, which waits and answers for a holder that is still there as for every
  // retire. A scheduling that comes back after that finds its completion's outcome, or a
  // completion that is gone, and has failed (scheduleDeferredSelfRetirement).
  const scheduledBy = Number.isSafeInteger(intent.requestedByPid) && isStartToken(intent.requestedByStart) ? { pid: intent.requestedByPid, start: intent.requestedByStart } : null;
  const schedulingHoldsClaim = () => {
    const held = home && scheduledBy ? homeClaimHolder(home) : null;
    return held !== null && held.holder.pid === scheduledBy.pid && held.holder.processStart === scheduledBy.start && held.state === "alive";
  };
  for (const until = Date.now() + (opts.schedulingWaitMs ?? SCHEDULING_WAIT_MS); schedulingHoldsClaim() && Date.now() < until;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SCHEDULING_PAUSE_MS);
  // Read before the retire runs: instance.json may be gone when the event is written.
  const incarnation = home ? incarnationOf(home) : null;
  /** Remove the pending marker, and only this completion's own: the one of the scheduling it
   *  completes (the same `requestedAt`), whose named completion is absent (an older kernel's
   *  marker), this process, or a process that is verifiably gone (a completion run from the marker
   *  for a scheduling whose own completion died). A marker a later `--self` wrote, one that names
   *  a process that runs or whose liveness cannot be read, and one that cannot be read are left.
   *  The retire has released the home's claim by now, so a `--self` that lands between this read
   *  and the removal loses its marker until its own completion runs; that completion still runs,
   *  under the claim. → whether it removed one. */
  const removeOwnMarker = () => {
    if (!home) return false;
    const path = retirePendingMarkerPath(home), marker = readJsonOrUndefined(path);
    if (!isPlainObject(marker) || typeof intent.requestedAt !== "string" || marker.requestedAt !== intent.requestedAt) return false;
    const pid = marker.completionPid;
    if (Number.isSafeInteger(pid) && pid !== process.pid && processLiveness({ pid, processStart: marker.completionStart }).state !== "gone") return false;
    try { rmSync(path); return true; }
    catch (e) { if (e?.code !== "ENOENT") console.error(`deferred retirement: cannot remove ${path}: ${e.message}`); return false; }
  };
  /** The one way out of a completion that did not complete → false. `payload` is its outcome as
   *  the result file takes it; `homeChanged` is false when no retire hook was started and nothing
   *  of the home was removed. In this order: the outcome is written before the marker goes, since
   *  a second `--self` reads a marker without an outcome as "already scheduled"; the event is
   *  last, and evidence only, so one that cannot be written is said in the log and nothing else
   *  changes. The row goes to the workspace's log alone, whatever `homeChanged` is: the
   *  completion holds no claim here, and another retire may be inspecting or removing the home,
   *  so it writes nothing into it. */
  const notCompleted = (payload, { code, homeChanged, sentence }) => {
    record(payload);
    if (!homeChanged && removeOwnMarker()) console.error(`deferred retirement of ${intent.instance}: no retire hook was started and nothing of the home was removed, so its pending marker is removed; ${intent.instance} is not being retired`);
    if (!home) { console.error(`deferred retirement of ${intent.instance}: no retire-refused event was recorded: its intent names no home`); return false; }
    const written = appendEvent(home, { kind: "retire-refused", data: { code, homeChanged, reason: retireRefusedReason(sentence) } }, { workspaceOnly: true, incarnation });
    if (!written.ok) console.error(`deferred retirement of ${intent.instance}: its retire-refused event could not be written: ${written.reason ?? (written.results ?? []).map((r) => `${r.path}: ${r.reason}`).join("; ")}`);
    return false;
  };
  const retry = `oats retire ${intent.instance}${intent.options?.home ? ` --home ${intent.options.home}` : ""}`;
  const retireOnce = (underClaim) => retireInstance(intent.root, intent.instance, {
    home: intent.options?.home, keepDir: !!intent.options?.keepDir, tmuxSession: intent.options?.tmuxSession,
    ...(Array.isArray(intent.options?.plannedExtraWorktrees) ? { plannedExtraWorktrees: intent.options.plannedExtraWorktrees } : {}),
    ...(Array.isArray(intent.options?.children) ? { children: intent.options.children } : {}),
    ...(obsoleteDeleteBranch ? { [OBSOLETE_DELETE_BRANCH]: true } : {}),
    // The retire that scheduled this completion was waited for above. Any other live holder of
    // the claim is waited for by the retire itself, for the time a completion's retire has
    // always waited, and then answers as for every retire.
    [COMPLETES_DEFERRED]: true,
    ...(underClaim ? { [RETIRE_UNDER_CLAIM]: underClaim } : {}),
  });
  // A retire whose cleanup is incomplete with retire hooks alone owed (RETIRE_HOOK_DEBT_ONLY) is
  // tried again, after each delay of RETIRE_RETRY_DELAYS_MS (`opts.retryDelaysMs` for a test), as a
  // plain retire like the first: it takes the claim, and its quarantine retry clears only when the
  // hooks are shown to have run. Every attempt records its own `retired` row. The retries stop at the
  // first that answers an error or whose cleanup owes more than retire hooks, and before any retry
  // whose home is gone or whose pending marker is no longer this completion's (another `requestedAt`,
  // or none): that is checked after the wait, and again by the retry itself once it holds the home's
  // claim, before it reads or does anything. While it waits, the completion keeps its retry state at
  // retireRetryPath, which another retire's refusal reads (refusePendingCompletion); it removes that
  // file on every way out.
  const delays = (Array.isArray(opts.retryDelaysMs) ? opts.retryDelaysMs : RETIRE_RETRY_DELAYS_MS).map((ms) => Math.max(0, Number(ms) || 0));
  const attempts = 1 + delays.length;
  const retryPath = home ? retireRetryPath(home) : null;
  const dropRetryState = () => {
    if (!retryPath) return;
    try { rmSync(retryPath, { force: true }); } catch (e) { console.error(`deferred retirement: cannot remove ${retryPath}: ${e.message}`); }
  };
  /** Why the home may not be retried now, or null: it is there, and its pending marker is still the
   *  one of this completion's scheduling. */
  const notOwed = () => {
    if (!home) return "its intent names no home";
    if (!existsSync(home)) return "its home is gone";
    const marker = readJsonOrUndefined(retirePendingMarkerPath(home));
    if (!isPlainObject(marker) || typeof intent.requestedAt !== "string" || marker.requestedAt !== intent.requestedAt) return "its pending marker is no longer this completion's";
    return null;
  };
  /** Why the retire whose attempt `attempt` left `result` is not tried again, or null when it is. */
  const notRetried = (attempt, result) => {
    if (!result[RETIRE_HOOK_DEBT_ONLY]) return "its cleanup owes more than retire hooks";
    if (attempt >= attempts) return "it was the last attempt";
    return notOwed();
  };
  const items = (result) => result.rollbackIncomplete.join("; ");
  /** The way out of a retire left incomplete after `run` attempts → false. `said` is the log's line
   *  for it: none for a first attempt that owes more than hooks, which says what it said before. */
  const incomplete = (run, result, said) => {
    if (said) console.error(said);
    // A result and not an error, so it has no code. The retire worked on the home and left it
    // quarantined: the home is changed. The items are text of hooks and of Git, which the outcome
    // and the log hold and the event does not.
    dropRetryState();
    notCompleted({ ok: false, result, retry, ...(run > 1 ? { attempts: run } : {}) },
      { code: null, homeChanged: true, sentence: RETIRE_INCOMPLETE_SENTENCE(intent.instance) });
    console.error(`deferred retirement of ${intent.instance} is INCOMPLETE; the home is retained:\n  ${result.rollbackIncomplete.join("\n  ")}`);
    return false;
  };
  /** What a retry throws under the home's claim when the home is no longer owed it: nothing was done.
   *  Never answered as it is: the completion knows it by identity, and an answer code passes through
   *  retireInstance unwrapped. */
  const cancelled = lifecycleBusy("none", `the retry of the retirement of ${intent.instance} was not started: its pending marker is no longer this completion's; nothing was done`,
    "nothing to do: the scheduling that marker names owns the retirement now", { instance: intent.instance, home });
  const ownStart = processStartToken(process.pid);
  let result;
  for (let attempt = 1; ; attempt++) {
    if (attempt > 1) {
      const why = notOwed();
      if (why) return incomplete(attempt - 1, result, `deferred retirement of ${intent.instance}: attempt ${attempt} of ${attempts} is not started: ${why}`);
    }
    const last = result;
    try {
      result = retireOnce(attempt > 1 ? () => { if (notOwed()) throw cancelled; } : undefined);
    } catch (e) {
      if (e === cancelled) return incomplete(attempt - 1, last, `deferred retirement of ${intent.instance}: attempt ${attempt} of ${attempts} is not started: ${notOwed() ?? "its pending marker was not this completion's under the home's claim"}`);
      const code = kernelCode(e, "E_LIFECYCLE_FAILED");
      // An answer without `reached` is one in which the retire of the home had not begun (retireInstance).
      // A retry's home was changed by the attempts before it: their hooks ran, and it is quarantined.
      const reached = e?.details?.reached;
      const homeChanged = attempt > 1 || (isPlainObject(reached) && (reached.hooksStarted === true || reached.home !== "kept"));
      dropRetryState();
      notCompleted({ ok: false, error: { code, message: e.message }, ...(e.details?.childrenStopped ? { childrenStopped: e.details.childrenStopped } : {}), ...(obsoleteDeleteBranch ? { warnings: [OBSOLETE_DELETE_BRANCH_SENTENCE] } : {}), retry, ...(attempt > 1 ? { attempts: attempt } : {}) },
        { code, homeChanged, sentence: e.message });
      console.error(`deferred retirement of ${intent.instance} failed${attempt > 1 ? ` on attempt ${attempt} of ${attempts}` : ""}: ${e.message}`);
      // A defect's stack goes to the completion's log (lib/errors.mjs isDefect).
      reportDefect(e);
      return false;
    }
    if (obsoleteDeleteBranch && attempt === 1) console.log(OBSOLETE_DELETE_BRANCH_SENTENCE);
    if (!result.rollbackIncomplete) break;
    const why = notRetried(attempt, result);
    // The first attempt of a retire that owes more than hooks says what it said before this rule.
    if (why) return incomplete(attempt, result, attempt > 1 || result[RETIRE_HOOK_DEBT_ONLY] ? `deferred retirement of ${intent.instance}: attempt ${attempt} of ${attempts} is incomplete (${items(result)}); it is not tried again: ${why}` : null);
    // When the next attempt starts, and the earliest the last one can: each wait follows the end of
    // the attempt before it, whose length cannot be known here.
    const now = Date.now(), wait = delays[attempt - 1];
    const nextAt = new Date(now + wait).toISOString(), lastAt = new Date(now + delays.slice(attempt - 1).reduce((a, b) => a + b, 0)).toISOString();
    console.error(`deferred retirement of ${intent.instance}: attempt ${attempt} of ${attempts} is incomplete (${items(result)}); attempt ${attempt + 1} runs at ${nextAt}`);
    // Without its file the retry still runs; a refusal meanwhile only says less.
    try { writeFileSync(retryPath, JSON.stringify({ requestedAt: intent.requestedAt, completionPid: process.pid, completionStart: ownStart, attempt: attempt + 1, attempts, nextAt, lastAt }, null, 2) + "\n"); }
    catch (e) { console.error(`deferred retirement: cannot write ${retryPath}: ${e.message}; it retries without it`); }
    if (wait) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  }
  dropRetryState();
  if (intent.options?.keepDir) {
    // The kept home is the one the intent names, never a same-named twin.
    const retained = intent.options?.home ? { home: intent.options.home } : findInstanceHome(intent.root, intent.instance);
    if (retained) rmSync(retirePendingMarkerPath(retained.home), { force: true });
  }
  // Success leaves nothing beside the home: the home is gone, the marker went
  // with it, and a kept success record per retired reviewer or harvester would
  // accumulate forever (reviewer D4). Only failures leave files, and they are
  // the ones status surfaces and a retry clears.
  try { rmSync(intent.resultPath.replace(/\.json$/, ".log"), { force: true }); } catch { /* nothing to keep */ }
  return true;
}

/** The key of the home a retire selected (a string) on retireInstance's result
 *  (awebai/oats#693): the CLI cleans that home's wake schedules. A symbol, so
 *  the printed and JSON receipt, and a recorded one, do not carry it. */
export const RETIRE_SELECTED_HOME = Symbol("oats.retireSelectedHome");
/** On retireInstance's result: true when its cleanup is incomplete and what it owes is retire hooks
 *  and nothing else (no Git step, directory preservation, orphaned work directory, or item no rerun
 *  of the hooks can clear). A deferred completion retries only such a retire
 *  (completeDeferredRetirement). A symbol, so the printed and JSON receipts do not carry it. */
const RETIRE_HOOK_DEBT_ONLY = Symbol("oats.retireHookDebtOnly");
/** How long a deferred completion whose retire owes retire hooks alone waits after each failed
 *  attempt before the next (completeDeferredRetirement): three retries, at about 1, 5 and 15 minutes. */
export const RETIRE_RETRY_DELAYS_MS = Object.freeze([60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000]);
/** Where a deferred completion keeps its retry state while it waits between attempts, beside the
 *  home: `{ requestedAt, completionPid, completionStart, attempt, attempts, nextAt, lastAt }`.
 *  Kernel-internal. Read only by refusePendingCompletion, and only while the completion it names
 *  is the live one the pending marker names; any retire that removes the home removes it too. */
function retireRetryPath(home) {
  return join(dirname(home), `.oats-retire-retry-${basename(home)}.json`);
}
/** An option of retireInstance: a function it calls once it holds the home's claim, has resolved
 *  the home again and has found no pending self-retire, before it reads anything else. What the
 *  function throws is the retire's answer, and nothing was done; what it returns, `{ children?,
 *  plannedExtraWorktrees? }`, sets those two options. `oats retire` reads here what the retire
 *  acts on, so that it is the state the retire starts from, never one another retire changed
 *  afterwards: a guarded apply its plan, once, refusing a revision that is not the one shown
 *  (E_PLAN_STALE); a plain or `--self` retire its recorded children. Against a retire in flight
 *  the answer is that it is running, and neither is read. A symbol, so no caller can set it from
 *  parsed arguments or JSON. */
export const RETIRE_UNDER_CLAIM = Symbol("oats.retireUnderClaim");
/** How many times a retire starts over because the name resolved to another home once it held the
 *  claim of the first (that one removed, a same-named home of another agent made, in between). */
const RETIRE_CLAIM_RESTARTS = 2;


/** The command that takes a home's claim for `action`, as a person types it. */
const claimCommand = (action) => action === "resume" ? "oats session start --resume" : action === "start" ? "oats session start or restart" : ["stop", "upgrade"].includes(action) ? `oats instance ${action}` : `oats ${action}`;
/** What each verb that meets a held claim says it did not do: the words its refusals end with,
 *  before any effect. After a takeover ended a dead holder's step, every verb says the same
 *  (lib/errors.mjs nothingAfter). */
const CLAIM_NOTHING = { upgrade: "no modules were upgraded", retire: "nothing was done", stop: "nothing was stopped", resume: "nothing was started", start: "nothing was started", "worktree add": "no tree was made", "instance color": "the colour was not changed", "instance same-work": "the flag was not changed", "instance background": "the background was not changed" };

/** The refusals of `arriving` ("retire", "stop", "upgrade", "resume", "start", or "worktree add", which
 *  reads the claim and does not take it) of `name` (home `home`) that meets the lifecycle claim `lock`, as lib/claim.mjs asks
 *  for them: one builder for every pair (arriving verb, holder's verb), so that the pair table of
 *  docs/desktop-cli-api.md has one source. One line each, saying what was not done, once.
 *  - A live holder: E_INSTANCE_RETIRING when the holder is a retire and the arriving verb is not
 *    one (the instance is on its way out: waiting does not make the stop or the tree possible);
 *    E_LIFECYCLE_BUSY otherwise, `holder: "running"`. Live is what was established of the pid
 *    and its start, not that the process is that command: both name, after the dash, the check
 *    for a holder that does not end (lib/errors.mjs ifItDoesNotEnd), the second after the wait.
 *  - A holder whose liveness cannot be read: E_LIFECYCLE_BUSY, `holder: "unknown"`, whatever the
 *    two verbs are, with that same check as its step (checkHolderByHand).
 *  - Two starts, live or of a liveness that cannot be read: E_SESSION_START_BUSY, as when the
 *    second met the first's start lock before starts took the claim, with no details. That is a
 *    start arriving beside a start or a resume, and a resume arriving beside a start (startPair). A
 *    resume beside a resume stays E_LIFECYCLE_BUSY, as it was before.
 *  `details` is `{ instance, home, lock, pid, since, action }`: `lock` is the file that names the
 *  holder, `action` the HOLDER's verb (claimAction). The holder is named as lib/claim.mjs
 *  shownHolder allows, in the message and in `details` alike: `pid` and `since` are null, and the
 *  message says `?` or `none`, for a field that does not have the shape the kernel writes.
 *  `ended`, the last argument of each, is what the claim's takeovers ended before the refusal
 *  (lib/claim.mjs). With some, the sentence says "nothing else was done" and the answer is
 *  E_LIFECYCLE_FAILED, what was ended first (lib/errors.mjs afterEndedSteps), with these details. */
export function lifecycleClaimRefusals(arriving, name, home, lock) {
  const nothing = (ended) => nothingAfter(ended, CLAIM_NOTHING[arriving]);
  const own = { instance: name, home };
  const holders = "oats retire, oats instance stop, oats instance upgrade, oats session start or oats session restart";
  // The holder of `at`, as an answer names it: `shown` for the message, `details` beside it.
  const held = (holder, at) => {
    const shown = shownHolder(holder), action = claimAction(holder);
    return { shown, action, details: { ...own, lock: at, pid: shown.pid, since: shown.since, action } };
  };
  return {
    busy: (holder, unknown, at = lock, ended = []) => {
      const { shown, action, details } = held(holder, at);
      const command = `an ${claimCommand(action)}`;
      if (startPair(arriving, action)) return afterEndedSteps(ended, oatsError("E_SESSION_START_BUSY", unknown
        ? `another start of ${name} may be in progress: whether the ${action} that holds ${at} (pid ${shown.pid ?? "?"}, recorded start ${shown.start ?? "none"}) still runs cannot be read (${unknown}); ${nothing(ended)} — ${checkHolderByHand(command, at)}`
        : `another start of ${name} is in progress (pid ${shown.pid ?? "?"}, since ${shown.since ?? "?"}); ${nothing(ended)} — ${ifItDoesNotEnd(command, at)}`));
      if (unknown) return lifecycleBusy("unknown", `whether the ${action} of ${name} that holds ${at} (pid ${shown.pid ?? "?"}, recorded start ${shown.start ?? "none"}) still runs cannot be read (${unknown}); ${nothing(ended)}`,
        checkHolderByHand(command, at), { ...details, unknown }, ended);
      // Alive is all that was established of the pid, never that it is that command: both
      // answers below name the check for a holder that does not end. A retire's holder is not
      // waited for by a verb that is not one (the instance is on its way out).
      if (action === "retire" && arriving !== "retire") return afterEndedSteps(ended, Object.assign(oatsError("E_INSTANCE_RETIRING", `${name} is being retired (pid ${shown.pid ?? "?"}, since ${shown.since ?? "?"}); ${nothing(ended)} — ${ifItDoesNotEnd(command, at)}`), { details }));
      return lifecycleBusy("running", `a ${action} of ${name} is already running (pid ${shown.pid ?? "?"}, since ${shown.since ?? "?"}); ${nothing(ended)}`, `wait for it to finish; ${ifItDoesNotEnd(command, at)}`, details, ended);
    },
    // Nobody is running in the four below, so never the sentence above that says to wait
    // (awebai/oats#874). The first sends nobody to a pid of this process, which is gone when the
    // answer is read: its remedy is a check in the reader's own shell (the reason names the read
    // that failed, as the reader made it).
    ownStartUnreadable: (reason, at, ended = []) => lifecycleBusy("none", `this process's start time cannot be read (${reason}), so ${claimCommand(arriving)} cannot hold ${at} verifiably; ${nothing(ended)}`,
      OWN_START_REMEDY, { ...own, lock: at }, ended),
    unreadableClaim: (at, ended = []) => lifecycleBusy("unknown", `${at} is not a readable claim; ${nothing(ended)}`, `inspect it and remove it if no ${holders} holds it, then retry`, { ...own, lock: at }, ended),
    cannotTakeOver: (holder, at, why, ended = []) => lifecycleBusy("none", `the process that held ${at} (pid ${held(holder, at).shown.pid ?? "?"}) is gone, and this file is not a claim this kernel can take over (${why}); ${nothing(ended)}`,
      `inspect ${at} and remove it if no ${holders} holds it, then retry`, held(holder, at).details, ended),
    // Nothing is wrong with the file: each command that took the claim died, and this one came
    // after each of them. The next run takes over the one that is there.
    heldAgain: (holder, at, times, ended = []) => lifecycleBusy("none", `the claim ${at} was found without a live holder ${times} times and was taken again each time, the last time by a process that is gone (pid ${held(holder, at).shown.pid ?? "?"}); ${nothing(ended)}`,
      "run the command again", held(holder, at).details, ended),
  };
}
/** Whether `arriving` beside a holder of `action` is two starts (lifecycleClaimRefusals): the pairs
 *  that met at the start lock before an ordinary start took the claim. */
const startPair = (arriving, action) => (arriving === "start" && (action === "start" || action === "resume")) || (arriving === "resume" && action === "start");
/** The refusals of a retire of `name` that cannot take its claim `lock` (lifecycleClaimRefusals).
 *  Exported for its tests. */
export function retireClaimRefusals(name, home, lock) {
  return lifecycleClaimRefusals("retire", name, home, lock);
}

/** An option of claimHomeFor: when the claim cannot be WRITTEN, read it in its place, and answer
 *  that nobody holds it when nobody does. Passed by a stop apply and by no other caller (a
 *  retire, a retire's stop of a recorded child and every later verb need the claim): a stop is
 *  what an operator reaches for when a disk is full, and a stop that leaves a session running
 *  because it could not write a file protects nobody. A symbol, so no caller can set it from
 *  parsed arguments or JSON. */
export const READ_CLAIM_WHEN_UNWRITABLE = Symbol("oats.readClaimWhenUnwritable");

/** Take the lifecycle claim of `home` for `verb` (one of CLAIM_VERBS) → the holding, for
 *  releaseHomeClaim. The one way a verb takes it: the record carries the verb from the instant the
 *  file exists, and a holder of any verb is refused at once (`waitMs: 0`; only a deferred
 *  self-retire's completion waits, for the retire that scheduled it). The claim's directory is
 *  made as retire makes it for its recovery copies; the claims are private. A directory that
 *  cannot be made is a claim that cannot be taken: nothing was done (awebai/oats#874).
 *
 *  → `{ lock, me }`, the holding. With READ_CLAIM_WHEN_UNWRITABLE, also
 *  → `{ lock, me: null, unwritable, look }` (awebai/oats#946): the claim could not be written,
 *    for the system's code `unwritable` (lib/claim.mjs CLAIM_UNWRITABLE_CODES) at one of its
 *    writes, and it was read where it would have been taken: nobody holds it. Nothing is held,
 *    so nothing excludes a command that takes the claim later; `look()` makes the same read
 *    again and throws what it throws. A holder, or a file that is no claim, is refused as when
 *    the claim can be written, by the same builder; a read that does not reach the path throws
 *    the refusal of the write, as without the option (lib/claim.mjs claimUnheld).
 *  What decides is the place of the failure and the system's code as it was thrown there
 *  (claimWrite, unwritableCode): never the code, the words or the details of an answer. */
export function claimHomeFor(verb, name, home, { waitMs = 0, [READ_CLAIM_WHEN_UNWRITABLE]: readInstead = false } = {}) {
  if (!CLAIM_VERBS.includes(verb)) throw new TypeError(`claimHomeFor: ${JSON.stringify(verb)} is not a verb that takes a home's claim (${CLAIM_VERBS.join(", ")})`);
  const lock = retireClaimPath(home);
  const refusals = lifecycleClaimRefusals(verb, name, home, lock);
  try {
    try {
      claimWrite(() => mkdirSync(dirname(dirname(lock)), { recursive: true }));
      claimWrite(() => mkdirSync(dirname(lock), { recursive: true, mode: 0o700 }));
    } catch (e) { throw claimUnavailable(lock, e); }
    return { lock, me: acquireClaim(lock, { ...refusals, facts: { action: verb }, waitMs }) };
  } catch (refusal) {
    const unwritable = readInstead ? unwritableCode(refusal) : undefined;
    if (!unwritable) throw refusal;
    const look = () => claimUnheld(lock, refusals, refusal);
    look();
    return { lock, me: null, unwritable, look };
  }
}
/** Release a holding of claimHomeFor, only while its file still names it. A claim that was only
 *  read (READ_CLAIM_WHEN_UNWRITABLE) holds nothing to release. */
export function releaseHomeClaim(holding) {
  if (holding.me) releaseClaim(holding.lock, holding.me);
}
/** Who holds the lifecycle claim of `home` now, read and not taken → `{ lock, holder, action,
 *  state, reason? }` (`state` is processLiveness's: "alive", "unknown" with its `reason`, "gone"),
 *  or null when there is no claim or the file does not read as one. For the readers that do not
 *  take the claim: a stop plan's `retiring` and `stopPending`, and `oats worktree add`. */
export function homeClaimHolder(home) {
  const lock = retireClaimPath(home);
  const holder = readClaim(lock);
  if (!holder || holder.unreadable) return null;
  const live = processLiveness(holder);
  return { lock, holder, action: claimAction(holder), state: live.state, ...(live.reason ? { reason: live.reason } : {}) };
}
/** Whether an upgrade holds the lifecycle claim of `home`, any spelling of it (a link to the home
 *  included, as the start claims it), and is not established gone: read only, for the order of a
 *  start's refusals (the start's own claim decides). */
export function upgradeHoldsClaim(home) {
  const held = homeClaimHolder(canonicalHomePath(home));
  return held?.action === "upgrade" && held.state !== "gone";
}
/** Whether the claim path `lock` holds something that is no claim anybody can read: a file that
 *  does not parse as one, or a path that is there and never reads (a dangling symbolic link, which
 *  reads as absent: lib/claim.mjs readClaim). A verb that TAKES the claim learns the second from
 *  its link, which says the path exists (takeClaim); a verb that only reads asks the path itself.
 *  A claim made between the two reads here is read again, and is a claim. */
function claimPathUnreadable(lock) {
  const read = readClaim(lock);
  if (read) return read.unreadable === true;
  let entry;
  try { entry = lstatSync(lock); } catch (e) { return e?.code !== "ENOENT"; }
  return entry.isSymbolicLink() ? readClaim(lock) === null : readClaim(lock)?.unreadable === true;
}
/** Refuse `arriving` ("worktree add"), a verb that reads the lifecycle claim of `home` and does
 *  not take it, when a retire holds it: E_INSTANCE_RETIRING beside a live one, E_LIFECYCLE_BUSY
 *  (`holder: "unknown"`) beside one whose liveness cannot be read, and beside a file that does not
 *  read as a claim, with the words a stop and a retire have for that file: one file has one
 *  reading, and this verb makes a tree in a home that may be going away. Nothing refuses for a
 *  holder that is gone (whoever takes the claim next takes it over) or for a stop (a tree does
 *  not depend on the session). */
export function refuseBesideRetire(arriving, home) {
  const lock = retireClaimPath(home);
  const refusals = lifecycleClaimRefusals(arriving, basename(home), home, lock);
  if (claimPathUnreadable(lock)) throw refusals.unreadableClaim(lock);
  const held = homeClaimHolder(home);
  if (!held || held.action !== "retire" || held.state === "gone") return;
  throw refusals.busy(held.holder, held.state === "unknown" ? held.reason : null);
}

/** The homes `name` resolves to under `root`, and the one a retire acts on. Names are unique per
 *  agent dir only: two agents can own an instance of the same name (dev --purpose foo-1 and agent
 *  dev-foo). Retirement is destructive, so a name that resolves to several homes is refused unless
 *  the caller says which home (--home), and a home is accepted only when it is one of that name's
 *  homes under this root. A home whose record is there and cannot be read is refused here
 *  (identifiedHomeRecord), `--force` or not: before the claim, and again under it. */
function resolveRetireHome(root, name, o) {
  const matches = findInstanceHomes(root, name);
  if (!matches.length) throw oatsError("E_SESSION_UNKNOWN", `no instance named "${name}"`);
  const sameHome = (a, b) => { try { return realpathSync(a) === realpathSync(b); } catch { return resolve(a) === resolve(b); } };
  let found = matches[0];
  if (o.home) {
    found = matches.find((m) => sameHome(m.home, o.home));
    if (!found) throw oatsError("E_HOME_MISMATCH", `instance "${name}" has no home at ${o.home} under this agents root (its home${matches.length === 1 ? " is" : "s are"} ${matches.map((m) => m.home).join(", ")})`);
  } else if (matches.length > 1) {
    throw oatsError("E_AMBIGUOUS_INSTANCE", `"${name}" names ${matches.length} instances under this agents root (${matches.map((m) => `${m.agent.name}: ${m.home}`).join("; ")}); retire with --home <path> to say which`);
  }
  identifiedHomeRecord(found.home);
  return found;
}

/** `name` has no home under `root`: remove a retire claim of that name whose holder is gone, in
 *  each instances directory the lookup searches (a retire killed after it removed the home and
 *  before it released). One whose holder is alive, unknown or unreadable is left as it is. `name`
 *  is the caller's: no path is built from one outside the instance-name grammar. */
function removeAbandonedRetireClaims(root, name) {
  if (typeof name !== "string" || !INSTANCE_NAME_RE.test(name)) return;
  const dirs = new Set([...listAgents(root).map((a) => a._dir), ...capabilityAgentDirs(root).map((c) => c.dir)]);
  for (const dir of dirs) {
    const home = join(dir, "instances", name);
    const lock = retireClaimPath(home);
    // Whatever stops the removal, the answer is the same: there is no such instance.
    try { removeGoneClaim(lock, { ...retireClaimRefusals(name, home, lock), waitMs: 0 }); } catch { /* left as it is */ }
  }
}

/** A deferred self-retire is scheduled for `home` and its completion has not started: every other
 *  retire of the home is refused while that completion lives. The pending marker
 *  (scheduleDeferredSelfRetirement) names it. Nothing refuses when there is no marker, when the
 *  completion left its outcome (it failed: this retire retries it), when the marker names no
 *  completion (an older kernel wrote it), when this process is that completion, or when that
 *  process is gone (it died: this retire does what it owed). */
function refusePendingCompletion(name, home) {
  const marker = retirePendingMarkerPath(home);
  if (!existsSync(marker) || existsSync(deferredRetireResultPath(home))) return;
  const pending = readJsonOrUndefined(marker);
  const pid = pending?.completionPid;
  if (!Number.isSafeInteger(pid) || pid === process.pid) return;
  const live = processLiveness({ pid, processStart: pending.completionStart });
  if (live.state === "gone") return;
  const start = typeof pending.completionStart === "string" ? pending.completionStart : "none";
  const details = { instance: name, home, lock: marker, pid, since: pending.requestedAt ?? null, action: "retire" };
  if (live.state === "alive") throw lifecycleBusy("running", `a retire of ${name} is already scheduled (its completion, pid ${pid}, requested at ${pending.requestedAt ?? "?"})${retryingSaid(home, pending)}; nothing was done`, "wait for it to finish", details);
  throw lifecycleBusy("unknown", `whether the completion of the scheduled retire of ${name} that ${marker} names (pid ${pid}, recorded start ${start}) still runs cannot be read (${live.reason}); nothing was done`,
    `check that pid by hand, and if it is not an oats retire, remove ${marker}, then retry`, { ...details, unknown: live.reason });
}

/** What a refusal adds while the completion `pending` names waits to retry a cleanup that did not
 *  finish: the clause of its retry state (retireRetryPath) when that file names the same scheduling
 *  and the same completion, else "". Its numbers and times are checked before they are said. */
function retryingSaid(home, pending) {
  const r = readJsonOrUndefined(retireRetryPath(home));
  if (!isPlainObject(r) || r.requestedAt !== pending.requestedAt || r.completionPid !== pending.completionPid || r.completionStart !== (pending.completionStart ?? null)) return "";
  if (![r.attempt, r.attempts].every((n) => Number.isSafeInteger(n) && n > 0) || r.attempt > r.attempts) return "";
  if (![r.nextAt, r.lastAt].every((t) => typeof t === "string" && !Number.isNaN(Date.parse(t)) && new Date(Date.parse(t)).toISOString() === t)) return "";
  return `; it is retrying cleanup that did not finish: attempt ${r.attempt} of ${r.attempts} runs at ${r.nextAt}, the last no earlier than ${r.lastAt}`;
}

/** Retire one instance. One retire of a home at a time (awebai/oats#863): the home's claim
 *  (retireClaimPath; lib/claim.mjs) is taken as soon as the home is resolved, before anything the
 *  retire acts on is read, and held until this returns or throws. Any other retire of that home
 *  is refused at once (E_LIFECYCLE_BUSY) before it stops, copies or runs anything; `--force` does
 *  not bypass it. A claim left by a killed retire is taken over. Every apply path runs this
 *  function: the CLI, the deferred completion, and `--server` on the host. Synchronous. */
export function retireInstance(root, name, o = {}) {
  // No answer of a retire carries a code that is not the kernel's (awebai/oats#892). The retire of
  // the home gives its own (retireClaimed); what fails before it (the resolution, the claim, the
  // plan the caller reads under it) has touched nothing of the instance.
  try { return retireUnderClaim(root, name, o); }
  catch (e) { throw isAnswerCode(e?.code) ? e : statedFailure(e, "E_LIFECYCLE_FAILED", `Nothing was done: ${name} is not retired.`); }
}
function retireUnderClaim(root, name, o) {
  if (o.deleteBranch) throw oatsError("E_BAD_ARGS", RETIRE_DELETE_BRANCH_REFUSED);
  let found;
  try { found = resolveRetireHome(root, name, o); }
  catch (e) {
    if (e.code === "E_SESSION_UNKNOWN") removeAbandonedRetireClaims(root, name);
    throw e;
  }
  for (let restarts = 0; ; restarts++) {
    // No waiting: a live holder, a retire or a stop, is refused at once. Only a deferred completion
    // waits, for the retire that scheduled it to return.
    const held = claimHomeFor("retire", name, found.home, { waitMs: o[COMPLETES_DEFERRED] ? CLAIM_WAIT_MS : 0 });
    const { lock } = held;
    try {
      // Resolved again under the claim: another retire may have removed the home between the
      // first resolution and the claim. Gone is what a retire of a retired instance answers.
      const now = resolveRetireHome(root, name, o);
      if (retireClaimPath(now.home) !== lock) {
        // The name is another home's now, whose claim this does not hold: start over on that one.
        if (restarts >= RETIRE_CLAIM_RESTARTS) throw lifecycleBusy("none", `the home of ${name} changed while its claim was being taken (it is now ${now.home}); nothing was done`, "retry", { instance: name, home: now.home, lock: retireClaimPath(now.home) });
        found = now;
        continue;
      }
      // Every retire that runs here, in this process: a `--self` that only schedules answers that
      // one is already scheduled (scheduleDeferredSelfRetirement).
      if (o.self !== true || o.keepDir) refusePendingCompletion(name, now.home);
      // What the caller confirms once nobody else can be retiring this home (a guarded apply reads
      // its plan and checks the revision): after the two answers above, before the retire reads
      // anything of the home. What it returns of the plan binds the retire.
      const confirmed = o[RETIRE_UNDER_CLAIM]?.();
      const bound = confirmed ? { ...o, ...(confirmed.children ? { children: confirmed.children } : {}), ...(confirmed.plannedExtraWorktrees ? { plannedExtraWorktrees: confirmed.plannedExtraWorktrees } : {}), ...(confirmed.ambiguous ? { ambiguous: confirmed.ambiguous } : {}) } : o;
      return retireClaimed(root, name, bound, now);
    } finally {
      releaseHomeClaim(held);
    }
  }
}

/** `e` as the answer of a retire at a point where it knows what it has done: a kernel error whose
 *  message ends with `said`, the sentence of that point with its own full stop. One that has a
 *  kernel code keeps its code, its details and its provenance; any other is wrapped as `fallback`
 *  (asKernelError), its text after `lead` when one is given. A message that already ends with the
 *  sentence is left as it is: it is said once. */
function statedFailure(e, fallback, said, lead) {
  const kernel = asKernelError(e, fallback, lead ? `${lead}: ${e?.message ?? e}` : undefined);
  // A failure answered under its own name (an unsafe key in a document) keeps its own words too.
  if (OWN_NAME_FAILURES.has(kernel.code) || kernel.message.endsWith(said)) return kernel;
  const stated = oatsError(kernel.code, `${kernel.message.replace(/\.$/, "")}. ${said}`, kernel.provenance);
  if (kernel.details) stated.details = kernel.details;
  if (Object.hasOwn(kernel, "cause")) stated.cause = kernel.cause; // whatever was thrown, undefined included (defectOf)
  return stated;
}
/** A retire's recovery as it is on disk at `path` → { path, phase }, the phase its recovery.json
 *  holds now; null without a path, or when the manifest cannot be read or holds another phase. */
function recoveryOnDisk(path) {
  try {
    if (!path) return null;
    const phase = readJsonOrUndefined(join(path, "recovery.json"))?.phase;
    return phase === "before-hooks" || phase === "complete" ? { path, phase } : null;
  } catch { return null; } // total: a read that fails names no copy
}
/** What is at `home` now, for a retire whose removal began (`removing`): "kept" when it did not,
 *  "removed" when nothing is there, "partial" when something is (or that cannot be told). */
function homeOnDisk(home, removing) {
  if (!removing) return "kept";
  try { lstatSync(home); return "partial"; } catch (e) { return e?.code === "ENOENT" ? "removed" : "partial"; } // total
}

/** The retire of the home `found`, under its claim (retireInstance). Whatever fails in it is
 *  answered with a kernel code and with what the retire had done by then (awebai/oats#892):
 *  `details.reached` on every error, and, on one that is not the kernel's, the sentence of that
 *  point (`at.said`, kept current by retireSteps). Such an error is E_LIFECYCLE_FAILED; the steps
 *  that inspect the home or the work give E_WORK_INSPECTION_FAILED themselves.
 *
 *  `reached` is `{ phase, sessionStopAttempted, hooksStarted, home, recovery }`. `phase` is how
 *  far the retire got: "before-effects" (nothing happened: never answered once a process may have
 *  been signalled), "before-hooks" (from the step that stops its recorded children on, whether or
 *  not it had anything to signal, or earlier, from the end of the hook group an interrupted spawn
 *  left), "after-hooks" (from the call of the retire hooks on),
 *  "removal" (from the removal of the home on). In the other fields the untouched value is a
 *  guarantee, and the other value says only that the retire reached that step, which may not have
 *  completed (docs/desktop-cli-api.md, `error.details.reached`: the shape is contract):
 *  - `sessionStopAttempted: false`: it signalled neither the instance's session nor a child's
 *    harness;
 *  - `hooksStarted: false`: no retire hook was started;
 *  - `home: "kept"`: the removal did not begin; else what is on disk now, "partial" or "removed";
 *  - `recovery: null`: no copy of this retire whose manifest can be read; else its path and the
 *    phase its recovery.json holds now ("before-hooks" or "complete"), read when the error is
 *    answered. */
function retireClaimed(root, name, o, found) {
  const at = { phase: "before-effects", sessionTouched: false, hooksStarted: false, removing: false, recoveryPath: null, said: () => "Nothing was stopped, run or removed", lead: null };
  try { return retireSteps(root, name, o, found, at); }
  catch (e) { throw retireFailure(e, at, found.home); }
}
/** The error a retire of `home` answers for `e`, thrown while the retire was at `at`
 *  (retireClaimed): a kernel error that carries `details.reached`. It never throws, whatever `e` and
 *  `at` are: an answer of a retire without `reached` says that the retire of the home had not
 *  begun and that nothing was done (retireInstance), and no error from here may read so. `reached`
 *  is made first, from the tracker and two reads that cannot fail; if the sentence of that point
 *  cannot be made, or the error cannot carry details, the answer is the error's own message, with
 *  `reached`. Exported for its test. */
export function retireFailure(e, at, home) {
  const reached = { phase: at.phase, sessionStopAttempted: at.sessionTouched, hooksStarted: at.hooksStarted, home: homeOnDisk(home, at.removing), recovery: recoveryOnDisk(at.recoveryPath) };
  // A code this verb answers only before any effect (lib/errors.mjs BEFORE_EFFECT_CODES), raised
  // once the retire is past "before-effects": the same fact `reached.phase` states, never a second
  // record of how far the retire got. A net: no known place raises one there.
  const late = at.phase !== "before-effects";
  try {
    const answered = isAnswerCode(e?.code) ? e : statedFailure(e, "E_LIFECYCLE_FAILED", `${at.said()}.`, at.lead?.());
    const failure = late ? afterFirstEffect(answered, "retire", `phase ${at.phase}`) : answered;
    failure.details = { ...failure.details, reached };
    return failure;
  } catch (unsaid) {
    reportDefect(unsaid);
    // The net again, where its sentence could not be built: never the refusal's own code past the
    // first effect, nor its words alone, which say that nothing happened.
    const lateRefusal = late && BEFORE_EFFECT_CODES.retire.includes(e?.code);
    const plain = new Error(`${lateRefusal ? `oats retire answered ${e.code} after its first effect (phase ${at.phase}): ` : ""}${String(e?.message ?? e)}`, { cause: e });
    plain.code = lateRefusal ? "E_LIFECYCLE_FAILED" : kernelCode(e, "E_LIFECYCLE_FAILED");
    const cause = isAnswerCode(e?.code) ? undefined : errorCause(e);
    plain.details = { ...(isAnswerCode(e?.code) && isPlainObject(e.details) ? e.details : {}), ...(cause ? { cause } : {}), reached };
    return plain;
  }
}
/** The steps of a retire. `at` is where it is (retireClaimed): each step that changes what a
 *  failure may truthfully say moves it first. */
function retireSteps(root, name, o, found, at) {
  const session = o.tmuxSession || DEFAULT_TMUX_SESSION;
  // self-retire: the caller IS the instance. Without --keep-dir the whole
  // retirement is deferred to a detached external completion (below); with
  // --keep-dir the old in-process path runs and kills the window LAST.
  const self = o.self === true;
  const metaPath = join(found.home, "instance.json");
  // A QUARANTINED home (spawn failed after a required hook and compensation did
  // not finish) has no instance.json — it never got that far. Its marker carries
  // the cleanup descriptor in the same shape, so retire can rerun compensation
  // instead of silently skipping every hook and deleting the credentials.
  const directoryFallbackPath = directoryRollbackPath(found.home);
  const quarantinePath = existsSync(directoryFallbackPath) ? directoryFallbackPath : join(found.home, ".oats-rollback-incomplete.json");
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
  // #796: a marker a spawn wrote before its worktree hooks (`inProgress`). While that spawn's
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
    if (live.state === "alive") throw lifecycleBusy("running", `${name} is still being spawned (pid ${p.pid}, running its worktree hooks since ${p.startedAt ?? "?"}); nothing was retired`, "wait for the spawn to end, or stop that process, then retire");
    if (live.state === "unknown") {
      if (!o.force) throw lifecycleBusy("unknown", `${name}: whether its spawn (pid ${p.pid}, recorded start ${p.processStart ?? "none"}, running its worktree hooks since ${p.startedAt ?? "?"}) still runs cannot be read (${live.reason}); nothing was retired`,
        `check that pid by hand, and if it is not that spawn, run \`oats retire ${name} --force\``, { pid: p.pid, processStart: p.processStart ?? null, unknown: live.reason, remedy: `oats retire ${name} --force` });
      inProgressUnverified = true;
      spawnGroupWarnings.push(`retired with --force although whether its spawn (pid ${p.pid}) still runs could not be read (${live.reason}); its branch is kept`);
    }
  }
  // The retire's own read of the record, with the same reader as the resolution: one that became
  // unreadable since then refuses as there. It comes before the first signal a retire can send
  // (below), so that E_UNIDENTIFIED_INSTANCE_HOME for an unreadable record is only ever answered
  // while nothing was done: `reached` is untouched ("before-effects").
  const liveMeta = identifiedHomeRecord(found.home).meta;
  // What this retire did to the hook group an interrupted spawn left, when it signalled it. Ending
  // that group is the first signal a retire can send: from that call on the retire is no longer
  // "before-effects", and no answer says that nothing was stopped.
  let spawnGroupSaid = null;
  const nothingYet = () => spawnGroupSaid ? `${spawnGroupSaid}; no session was stopped, no retire hook was run and nothing was removed` : "Nothing was stopped, run or removed";
  at.said = nothingYet;
  if (quarantine?.inProgress) {
    const p = quarantine.inProgress;
    const group = `The worktree hook process group ${p.hookPgid} that an interrupted spawn left`;
    at.phase = "before-hooks";
    spawnGroupSaid = `${group} was signalled and may still run`;
    const ended = terminateRecordedGroup(p);
    if (ended === "terminated" || ended === "killed") spawnGroupSaid = `${group} was ended`;
    else if (ended !== "survived") { spawnGroupSaid = null; at.phase = "before-effects"; } // nothing was signalled
    // Two signals were sent by now: never a code that says nothing happened (awebai/oats#895).
    if (ended === "survived") throw oatsError("E_RUNTIME_QUIESCE_FAILED", `${name}: the worktree hook process group ${p.hookPgid} that an interrupted spawn left could not be ended (it survived SIGTERM and SIGKILL, and still runs); no session was stopped, no retire hook was run and nothing was removed. End that group by hand (kill -KILL -- -${p.hookPgid}), then retire again.`);
    if (ended === "unverified") spawnGroupWarnings.push(unverifiedGroupWarning(p.hookPgid));
    // A group whose leader's start cannot be read may still be that spawn's hook: never signalled,
    // and refused like an unreadable spawn above, with the same way out.
    if (ended === "unknown") {
      const note = unknownGroupNote(p);
      if (!o.force) throw lifecycleBusy("unknown", `${name}: the worktree hook ${note}; nothing was retired`,
        `check process group ${p.hookPgid} by hand: if it is that hook, end it (kill -TERM -- -${p.hookPgid}) and retire again; if it is not, run \`oats retire ${name} --force\``, { hookPgid: p.hookPgid, hookStart: p.hookStart ?? null, remedy: `oats retire ${name} --force` });
      inProgressUnverified = true;
      spawnGroupWarnings.push(`retired with --force although the worktree ${note}; its branch is kept`);
    }
  }
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
  if (markerUnusable && !o.force) {
    throw oatsError("E_UNIDENTIFIED_INSTANCE_HOME", `${found.home} carries a rollback marker that cannot drive a retry (unreadable, or missing the cleanup descriptor fields the retry consumes), so OATS cannot tell what external state still depends on this home. Inspect it, then re-run with \`--force\` to remove it anyway.`);
  }
  if (!existsSync(metaPath) && !quarantine && !o.force) {
    throw oatsError("E_UNIDENTIFIED_INSTANCE_HOME", `${found.home} has no instance.json and no cleanup descriptor, so OATS cannot tell whether external state (identities, worktrees) still depends on it. Retiring it would delete whatever it holds without running any cleanup. Inspect it, then re-run with \`--force\` to remove it anyway.`);
  }

  const workPath = join(found.home, "work");
  // What work/ is, by the one function the plan reads too (instanceWork, #962). Read once, here.
  const workIs = instanceWork(found.home, meta);
  const directoryMode = workIs.is === "directory-mode";
  // A real directory that is not the instance's own tree is bytes of the home: inspected, copied to
  // recovery and checked as a directory instance's work is, and removed with the home. It never
  // reaches the worktree step, and no pass leaves it out of its copy.
  const homeDirectory = workIs.is === "home-directory";
  const directory = directoryMode || homeDirectory;
  const isWorktree = workIs.is === "own-tree" || workIs.is === "other";
  // A link is never the instance's own tree, whatever the record says (#973): it goes with the
  // home, and what it leads to is not copied, moved, removed or read through Git by any step.
  const link = workIs.is === "link";
  // The record as the work steps read it, never written anywhere: an own tree is a worktree's,
  // whatever work mode the record holds, and when the record names no repository its repository
  // is the one Git names for the tree. A directory of the home is no worktree, whatever it holds,
  // and neither is a link, under a record that says `worktree` too: every step that asks whether
  // this home is a worktree's (the recovery's writers, the rollback retry) asks this record.
  const repoFromGit = workIs.is === "own-tree" && !meta.repo ? workIs.tree?.repo : undefined;
  const workMeta = workIs.is === "own-tree" ? { ...meta, work: "worktree", repo: meta.repo || repoFromGit }
    : homeDirectory || link ? { ...meta, work: undefined } : meta;
  // A live harness cannot establish a stable final work inspection of itself,
  // so self-retire never inspects, runs hooks, or removes anything here. It
  // persists the intent and hands the whole retirement to a detached process
  // that runs it as an ordinary EXTERNAL retirement once the harness is gone
  // (aweb-abep). `--keep-dir` keeps the old in-process path: nothing to inspect.
  // A home opened in Herdr (removed in 0.31.0) has no endpoint OATS can quiesce in-process. A
  // quarantined home's cleanup descriptor overrides the live record's endpoint: either may name it.
  const herdrHome = recordsHerdr(meta, readJsonOrUndefined(findRetirementBaseline(found.home))) || recordsHerdr(liveMeta);
  if (self && (!o.keepDir || herdrHome)) {
    // scheduleDeferredSelfRetirement ends the completion it started before it throws, whatever fails.
    at.said = () => `${spawnGroupSaid ? `${spawnGroupSaid}. ` : ""}This command inspected, ran and removed nothing, and left no detached completion running`;
    return scheduleDeferredSelfRetirement(root, found, name, o, session);
  }
  // A worktree directory whose git admin entry is gone cannot be inspected, moved or removed through git, and
  // what it holds may exist nowhere else: it is never removed. Without --force the hooks still run and it is
  // an incomplete item; --force (which removes the home it sits in) refuses before anything runs.
  // (An own tree: a directory of the home under a record that says `worktree` is no worktree that lost
  // its entry. It is copied and removed with the home, #962.)
  const orphanedWork = workIs.is === "own-tree" && meta.work === "worktree" && existsSync(workPath) && worktreeAdminMissing(workPath);
  if (orphanedWork && o.force) {
    throw oatsError("E_WORK_PRESERVATION_FAILED", `${name}: the work directory ${workPath} has no git admin entry in ${meta.repo ?? "its repository"}, so retiring the home would delete it with whatever it holds; move it out or delete it by hand, then retire again; nothing was run or removed`);
  }
  const orphanItem = orphanedWork ? `git worktree ${workPath}: its admin entry is missing; the directory is kept — move it out or delete it by hand, then retire again` : null;
  const inspectableWorktree = isWorktree && !orphanedWork;
  // First inspection is non-destructive. Only after it succeeds may OATS quiesce
  // the managed harness; recovery copying never races a live managed Pi.
  const owesWorktree = !!quarantine && (quarantine.cleanup.outstanding?.git || []).includes("worktree");
  const recordedBranch = quarantine ? { repo: meta.repo, branch: meta.branch } : undefined;
  // Whether this retire removes the worktree, when it gets to that step.
  const worktreeRemoval = { removes: !!(o.discardWorktree || owesWorktree), repo: workMeta.repo };
  // An inspection of the home and the work. Whatever fails in it, a walk that meets an entry it
  // cannot read or that is gone included, is an inspection that failed (E_WORK_INSPECTION_FAILED),
  // and says what the retire has and has not done by then (`disclosure`), once. Classified here,
  // at the retire's own calls: the digests' other callers do not answer that code for it.
  // `readWorkBytes`: whether the worktree's bytes are likely to be read right after this inspection,
  // so that it takes them in its own read (worktreeDigests). A guess either way costs time, never a proof.
  const inspect = (disclosure, readWorkBytes = false) => {
    try { return inspectRetirementWork(found.home, workPath, inspectableWorktree, { recordedBranch, worktreeRemoval, directory, directoryMode, link, instance: name, orphanedWork, disclosure, readWorkBytes }); }
    catch (e) { throw statedFailure(e, "E_WORK_INSPECTION_FAILED", `${disclosure}.`, `could not inspect the home of ${name} or its work`); }
  };
  const initialObservation = inspect(nothingYet());
  // An own tree with no repository, recorded or read from Git, has no step: the retire cannot re-home it,
  // and its copy needs the repository too. Removing the home would delete it uncopied, so it is refused
  // here, --force included (#962): after the inspection, whose own refusals of such a directory keep
  // their words, and before the session is stopped and before any retire hook runs.
  if (workIs.is === "own-tree" && workIs.at === "directory" && !workMeta.repo && !orphanedWork && !o.keepDir) {
    throw oatsError("E_WORK_PRESERVATION_FAILED", `${name}: ${workPath} is the instance's own work tree, but its record names no repository and Git does not read it as a registered worktree of one, so the retire can neither re-home it nor copy it, and retiring the home would delete it with whatever it holds; move it out or delete it by hand, then retire again; nothing was run or removed`);
  }
  // A locked extra tree is known from the home as it is now: Git will neither move nor remove it, so a retire that
  // would remove the home refuses here, before the session is stopped and before any retire hook runs (the hooks
  // revoke identities a kept home would still need). The extra-tree step keeps its own check, for a lock that appears
  // during the hooks. --force does not bypass it: it covers hook debt, not local work.
  if (!o.keepDir) {
    const locked = initialObservation.extraTrees.filter((t) => t.locked !== undefined);
    if (locked.length) {
      throw oatsError("E_WORK_PRESERVATION_FAILED", `${name}: ${locked.map((t) => `the extra worktree ${t.path} is locked${t.locked ? ` (${t.locked})` : ""}`).join("; ")}; Git will neither move nor remove a locked worktree. Unlock it with \`git worktree unlock\`, or move it out of the home, then retire again; nothing was run or removed`);
    }
  }
  // Harness identity is destructive authority. The mutable child metadata may
  // describe it for humans, but only the independent baseline can authorize the
  // endpoint that proves quiescence.
  let runtimeAuthority;
  if (herdrHome) {
    // Nothing to quiesce without Herdr: the retirement goes on only when no process works in the
    // home, exactly as for a session observed absent.
    const scan = processesInHome(found.home);
    if (!scan.ok) throw oatsError("E_RUNTIME_ENDPOINT_UNKNOWN", `cannot retire ${name}: it was opened in Herdr (${HERDR_REMOVED}), and whether a process still works in its home could not be established (${scan.error}); nothing was removed`);
    if (scan.processes.length) throw herdrInstanceBusy(name, scan.processes.map((p) => p.pid));
  } else if (liveMeta || quarantine) {
    runtimeAuthority = initialObservation.runtimeAuthority;
    // A home without its receipt (spawned before 0.25.9) has nothing OATS may
    // quiesce; when its session is observably absent, quiescing is vacuous and
    // the retirement goes on (hooks, work preservation). Live or ambiguous
    // still refuses, --force included: a harness is never left running under
    // a removed home.
    const unowned = runtimeAuthority ? null : observeSessionWithoutReceipt(found.home, meta);
    if (unowned && !unowned.absent) {
      throw oatsError("E_RUNTIME_ENDPOINT_UNKNOWN", `cannot quiesce ${name}: independent runtime endpoint authority is missing or invalid, and its session is not observably absent (${unowned.note}); stop that session yourself, then retire again`);
    }
  }
  if (runtimeAuthority) {
    const metaAgrees = launchStateAgrees(meta, runtimeAuthority) && (!runtimeAuthority.launched || tmuxEndpointAgrees(meta, runtimeAuthority));
    if (!metaAgrees) {
      throw authorityMismatch(`cannot quiesce ${name}: mutable instance metadata disagrees with independent runtime endpoint authority`, meta, runtimeAuthority);
    }
  }
  // The plan's promise about recorded children (`o.children`, computed the way
  // the plan computes them): stopped first and kept, after every refusal above
  // that changes nothing and before this instance is quiesced. One still running,
  // or whose stop could not be established, refuses the retirement: nothing is
  // retired, nothing is escalated, and --force does not bypass it. A child whose
  // instance.json is gone by now (a --self snapshot's child retired in between)
  // is no longer an instance, and the plan would not list it: it is not stopped.
  // What this retire did to the instance's own session: "unverified" once the kill is sent and
  // until the window is seen gone. `childStopReached`: a child's stop got to signal its harness.
  let ownSession = "untouched", childStopReached = false;
  const sessionSaid = () => ownSession === "stopped" ? "its session has been stopped"
    : ownSession === "unverified" ? "its session was asked to end, and whether it did was not established"
    : childStopReached ? `this retire stopped no session of ${name}; a stop of its recorded children was attempted`
    : "this retire stopped no session";
  // What a refusal before the hooks tells the operator about the retire so far.
  const soFar = (kept) => `${name} is not retired and ${kept}; ${sessionSaid()}`;
  const beforeHooks = () => `No retire hook has run and nothing was deleted: ${soFar("its home and work are kept")}`;
  // What a refusal after the hooks tells the operator about the retire so far.
  const hooksSaid = () => at.hooksStarted ? "The retire hooks have run" : "No retire hook was run";
  const afterHooks = () => `${hooksSaid()}; the home, its work and the pre-hook recovery (if any) are kept; ${sessionSaid()}`;
  at.phase = "before-hooks";
  at.said = beforeHooks;
  let childrenStopped;
  if (Array.isArray(o.children)) {
    childrenStopped = stopRecordedChildren(o.children.filter((kid) => existsSync(join(kid.home, "instance.json"))), () => { at.sessionTouched = true; childStopReached = true; });
    const notStopped = childrenStopped.filter((k) => !k.ok);
    if (notStopped.length) throw Object.assign(oatsError("E_CHILDREN_RUNNING", `${childrenNotStopped(notStopped)}; nothing was retired and nothing was escalated`), { details: { childrenStopped } });
  }
  // `=` forces exact matching: tmux targets otherwise PREFIX-match window names.
  // A no-launch instance is already quiesced. A launched one must have exact
  // window absence established before recovery copying begins.
  if (!self && runtimeAuthority?.launched) {
    const runtimeSession = runtimeAuthority.tmux.session;
    const runtimeWindow = runtimeAuthority.tmux.window;
    const runtimeSocket = runtimeAuthority.tmux.socket;
    const tmux = ["-S", runtimeSocket];
    at.sessionTouched = true;
    ownSession = "unverified";
    // The stop is recorded before the window is ended, so that at no instant the window is gone
    // and the home reads `lost` (a resume would bring it back): a retire that fails after this
    // leaves a home that reads `stopped`. A record that cannot be written (a full disk) does not
    // fail the retire: the home reads lost, and this retire's claim keeps a resume off it while it
    // runs. Should the retire then fail too, nothing records that it was asked for, and the home
    // reads lost as it did before this record existed.
    try { recordStop(found.home, null); } catch { /* see above */ }
    try { execFileSync("tmux", [...tmux, "kill-window", "-t", `=${runtimeSession}:=${runtimeWindow}`], { stdio: ["ignore", "pipe", "pipe"] }); } catch { /* verify the effect below */ }
    try {
      const windows = execFileSync("tmux", [...tmux, "list-windows", "-t", runtimeSession, "-F", "#{window_name}"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n").filter(Boolean);
      if (windows.includes(runtimeWindow)) throw new Error(`tmux window ${runtimeSession}:${runtimeWindow} is still running`);
    } catch (e) {
      const detail = String(e.stderr ?? e.message ?? "").trim();
      const unestablished = (why) => oatsError("E_RUNTIME_QUIESCE_FAILED", `could not establish that ${runtimeSession}:${runtimeWindow} stopped on ${runtimeSocket}: ${why}`);
      if (!/no server running|can't find session|no sessions/i.test(detail)) {
        const absence = tmuxServerAbsence(e);
        if (!absence) throw unestablished(detail || "tmux inspection failed");
        // A missing socket file, in any tmux's words (a reboot clears tmux's socket directory). A server
        // outlives its socket file, so that alone does not say the window is gone: it is taken as gone
        // only when no process works in the home, as for a home without its receipt (#624).
        const why = absence === "missing-socket" ? missingSocketUnestablished(detail, processesInHome(found.home)) : null;
        if (why) throw unestablished(why);
      }
    }
    ownSession = "stopped";
  }
  // Its bytes are read before the pre-hook recovery when it has something to preserve, which the
  // first inspection, of the same work before the stop, foretells.
  const stableObservation = inspect(beforeHooks(), initialObservation.classes.length > 0 && initialObservation.workProvable);
  // The bytes of the worktree as they are before the hooks: after the hooks,
  // "the work did not move" is then proven, never taken from a status text.
  // Read before the recovery is written, so that a worktree that cannot be
  // read (an entry that is not a file, a directory or a symbolic link)
  // refuses here and leaves no recovery behind, however often it is retried.
  // The refusal says what this retire has and has not done by now: a launched
  // instance's session was stopped above. A pre-hook copy of the work
  // verifies itself against this same read. A worktree that cannot be proven
  // unchanged is copied again in any case, and with nothing to preserve
  // before the hooks there is nothing to prove: any class after them is
  // preserved.
  if (stableObservation.classes.length && stableObservation.workProvable) {
    try { inspectedWorkBytes(stableObservation); }
    catch (e) {
      throw statedFailure(e, "E_WORK_INSPECTION_FAILED", `No recovery was written and nothing was deleted: ${soFar("its home is kept")}`);
    }
  }
  // One recovery per retirement. The snapshot taken here, before the retire
  // hooks, is the gate: it is verified before any hook runs and is never
  // rewritten. What the hooks change is added to it afterwards. A copy that
  // cannot be made or verified refuses here, with the same disclosure.
  let preHookRecovery;
  if (stableObservation.classes.length) {
    // Whatever fails here, not only a copy that could not be verified, says the same.
    try { preHookRecovery = writeRetirementRecovery(stableObservation, workMeta, name, "before-hooks"); }
    catch (e) {
      throw statedFailure(e, "E_LIFECYCLE_FAILED", `No retire hook has run, no recovery was written and nothing was deleted: ${soFar("its home and work are kept")}`);
    }
    at.recoveryPath = preHookRecovery.receipt.path;
  }
  let workRecovery = preHookRecovery?.receipt;

  // Capability lifecycle hooks (retire) — run BEFORE the dir (and any package state in it,
  // e.g. aweb signing keys) is removed. The knowledge integration harvests notes/ here;
  // the kernel itself is memory-agnostic.
  let hookResults;
  if (meta.repo) {
    // The hooks this home recorded at spawn. A home an earlier kernel spawned
    // without them still retires (lead decision c3 Q2): no hook runs, and the
    // result says so.
    const resolved = { ...resolvedFromHome(found.home, meta), capabilities: Array.isArray(meta.capabilityRuntime) ? meta.capabilityRuntime : [] };
    // The soul this home was spawned from, as recorded (a workspace home records its
    // per-commit directory; agents/<name>/soul may since point elsewhere) — the same
    // value spawn's hook saw.
    // From the call on the hooks count as run: one that fails part-way has started some.
    at.phase = "after-hooks";
    at.hooksStarted = true;
    at.said = () => `The retire hooks were started and may not all have run; the home, its work and the pre-hook recovery (if any) are kept; ${sessionSaid()}`;
    hookResults = runLifecycleHooks("retire", {
      home: found.home, instance: name, agentName: found.agent.name,
      soulDir: instanceSoulDir(found.home, meta) || found.agent._soulDir || join(found.agent._dir, "soul"),
      ...(nonEmptyString(meta.soulId) ? { soulId: meta.soulId } : {}),
      contextDir: meta.repo, workspaceDir: workspaceOf(root), rootDir: root, resolved, priorMeta: meta.capabilityMeta || {},
    });
    // The hooks ran: their warnings are events now, whatever the retire does
    // next (a refusal, a quarantine), so an action a hook names outlives the
    // answer (#1749). Recorded as given, in the workspace log only.
    for (const message of hookResults.warnings || []) appendEvent(found.home, { kind: RETIRE_HOOK_WARNING_KIND, data: { message } }, { workspaceOnly: true });
  }
  at.phase = "after-hooks";
  at.said = afterHooks;

  // ORDINARY retirement must not delete a home whose cleanup did not finish.
  // The failures were already collected above; until now they were read ONLY on
  // the quarantine-retry path, so a FIRST failure was discarded and the home —
  // with the credential needed to undo surviving external state — was removed
  // anyway. That asymmetry is the bug the comment further down already
  // describes. A hook that reports nothing, or reports retired:true, is
  // unaffected; only an explicit "I did not finish" changes the outcome.
  let ordinaryIncomplete = [];
  // The IN-PROCESS self path (--self --keep-dir only, since aweb-abep) is
  // excluded: that caller is the instance and cannot hold the authority to
  // complete owner cleanup (reviewer-5c8b724). A plain --self never reaches
  // here as `self`: its deferred completion calls retireInstance as an
  // external operator, so a self-retiring reviewer or harvester whose hook
  // reports incomplete cleanup IS quarantined like any other instance.
  if (!quarantine && !self) {
    for (const f of hookResults?.failures || []) ordinaryIncomplete.push(`retire hook ${f.capability}: ${f.message}`);
    // A hook may exit 0 and still report it did not finish. Only an explicit
    // "nothing to undo" counts as complete — same rule the rollback path uses.
    for (const [capId, m] of Object.entries(hookResults?.meta || {})) {
      if (m && typeof m === "object" && m.retired === false && m.reason !== "nothing-to-delete") {
        ordinaryIncomplete.push(`retire hook ${capId}: reported incomplete cleanup${m.reason ? ` (${m.reason})` : ""} — external state may remain`);
      }
    }
    if (orphanItem) ordinaryIncomplete.push(orphanItem);
  }
  // A quarantine retry's outcome apart from Git: what the hooks it reran left undone, and what they owed and
  // did not run. Known before the worktree step, which waits for it.
  const retryFailures = [];
  // How many of them no rerun of the retire hooks can clear: a capability with no retire hook, hooks
  // that cannot be rerun, an orphaned work directory. The rest are hook debt (retireHookDebtOnly).
  let retryNonHook = 0;
  if (quarantine) {
    for (const f of hookResults?.failures || []) retryFailures.push(`retire hook ${f.capability}: ${f.message}`);
    for (const [capId, m] of Object.entries(hookResults?.meta || {})) {
      if (m && typeof m === "object" && m.retired === false && m.reason !== "nothing-to-delete") {
        retryFailures.push(`retire hook ${capId}: reported incomplete cleanup${m.reason ? ` (${m.reason})` : ""}`);
      }
    }
    // The decisive check: not "did anything fail" but "did the work that was
    // outstanding actually happen". A retry that resolves zero capabilities —
    // because the descriptor named none, or config drifted since the spawn —
    // otherwise reports a clean sweep it never performed, and the home and its
    // credential go with it (reviewer-dd03a98).
    const ran = new Set(hookResults?.order || []);
    for (const capId of quarantine.cleanup.outstanding?.hooks || []) {
      if (ran.has(capId)) continue;
      const cap = (meta.capabilityRuntime || []).find((c) => c.id === capId);
      const noHook = !!cap && !cap.hooks?.retire;
      if (noHook) retryNonHook++;
      retryFailures.push(noHook
        ? `${capId}: declares no retire hook, so OATS cannot verify or undo what its failed spawn hook may have created — clean up by hand, then remove the home with \`oats retire ${name} --force\``
        : `retire hook ${capId}: did not run on this retry, so the cleanup it owed is unverified`);
    }
    if (!hookResults) { retryNonHook++; retryFailures.push("retire hooks could not be rerun (cleanup descriptor lost its context repo)"); }
    if (orphanItem) { retryNonHook++; retryFailures.push(orphanItem); }
  }

  // Hooks are allowed to mutate the inspected tree, so inspect again after
  // them. A recovery written before the hooks gains a separately verified
  // snapshot of each part they moved, under its after-hooks/, and its manifest
  // is concluded; a home that only now has something to preserve gets its one
  // recovery here. Nothing was preserved before the hooks only when there was
  // no class then, so a class now is something new to preserve, whether it
  // came from the home, from the work or from outside both (another ref, the
  // baseline): it does not have to be a move of the observed state. Either
  // way this finishes, or refuses and keeps the home, before the worktree
  // step and before the home is removed.
  // A refusal here says what has and has not happened, as one before the hooks
  // does: the hooks have run, and what is kept (#659).
  // Its bytes are read when movedByHooks compares them with the bytes read before the hooks.
  const finalObservation = inspect(afterHooks(), !!preHookRecovery && stableObservation.workBytes !== undefined);
  try {
    if (preHookRecovery) workRecovery = completeRetirementRecovery(preHookRecovery, stableObservation, finalObservation, workMeta);
    else if (finalObservation.classes.length) {
      workRecovery = preserveRetirementWork({ ...finalObservation, notCopied: unionNotCopied(stableObservation.notCopied, finalObservation.notCopied) }, workMeta, name);
    }
  } catch (e) {
    throw statedFailure(e, "E_LIFECYCLE_FAILED", `${afterHooks()}.`);
  }
  if (workRecovery?.path) at.recoveryPath = workRecovery.path;

  // Lineage repair: any instance pointing at the retiree (parentInstance from a
  // child/parent relation, siblingInstance from a root-sibling link) would be
  // left dangling. Splice the retiree out of the graph: orphans inherit the
  // retiree's COMPLETE surviving lineage — both its parent and its sibling link,
  // whichever edge type pointed at it — so a parent-relation reviewer that
  // retires hands its children back to the parent it displaced at spawn AND
  // restores any sibling cluster link it had absorbed; a link-less retiree's
  // orphans become roots. The scan covers the deployment's agents root.
  // Instance names are only unique per agent dir, so a bare name match is NOT
  // identity: an edge is repaired only when the name, resolved from the
  // ORPHAN's agents root exactly as spawn resolves anchors, lands on the
  // retiring home — which is why the splice runs BEFORE the home is removed.
  const retireeHome = (() => { try { return realpathSync(found.home); } catch { return resolve(found.home); } })();
  const relinked = [];
  const inheritedParent = meta.parentInstance && meta.parentInstance !== name ? meta.parentInstance : undefined;
  const inheritedSibling = meta.siblingInstance && meta.siblingInstance !== name ? meta.siblingInstance : undefined;
  const edgeIsRetiree = (orphanRoot, orphanHome) => {
    if (resolve(orphanHome) === resolve(found.home)) return false; // the retiree itself
    const hit = findInstanceHome(orphanRoot, name);
    if (!hit) return false;
    try { return realpathSync(hit.home) === retireeHome; } catch { return false; }
  };
  const repair = (orphanRoot, instHome) => {
    // Another home's record: one that is absent or cannot be read names no edge to repair.
    const record = readHomeRecord(instHome);
    if (record.state !== "record") return;
    const p = record.path, m = record.meta;
    if (m.parentInstance !== name && m.siblingInstance !== name) return;
    if (!edgeIsRetiree(orphanRoot, instHome)) return; // same NAME, different instance — leave it
    // Drop every edge to the retiree, then graft the retiree's own links —
    // whichever edge TYPE referenced it, the orphan inherits the full slot
    // (parent AND sibling) so clusters stay connected across mixed edge types.
    if (m.parentInstance === name) delete m.parentInstance;
    if (m.siblingInstance === name) delete m.siblingInstance;
    if (!m.parentInstance && inheritedParent && inheritedParent !== m.instance) m.parentInstance = inheritedParent;
    if (!m.siblingInstance && inheritedSibling && inheritedSibling !== m.instance) m.siblingInstance = inheritedSibling;
    // Another home's record, whose session may run. A record this process may not write refuses as
    // a write in place does, which a rename would not. The one write of a record that is not always
    // atomic (#1660): on any failure of the atomic write (a home that refuses the private file, a
    // refused rename, a full disk) it is written in place, as it always was, and that write's own
    // failure is the answer, so a reader there can still meet a torn record. A record write is no
    // new cause of a home that cannot be retired, and a full disk is when one must be.
    closeSync(openSync(p, "r+"));
    try { writeHomeRecord(instHome, m); }
    catch { writeFileSync(p, JSON.stringify(m, null, 2) + "\n"); }
    relinked.push({ instance: m.instance, parentInstance: m.parentInstance, siblingInstance: m.siblingInstance });
  };
  const scanRoot = (agentsRoot) => {
    for (const a of listAgents(agentsRoot)) {
      const dir = join(a._dir, "instances");
      if (!existsSync(dir)) continue;
      for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) repair(agentsRoot, join(dir, e.name));
    }
    for (const { dir: agentDir } of capabilityAgentDirs(agentsRoot)) {
      const dir = join(agentDir, "instances");
      if (!existsSync(dir)) continue;
      for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) repair(agentsRoot, join(dir, e.name));
    }
  };
  scanRoot((() => { try { return realpathSync(root); } catch { return root; } })());

  // K3b — retention is the default (lifecycle decision §1): the worktree,
  // branch and any PR outlive the home. The worktree cannot stay under
  // <home>/work once the home is removed, so it is RE-HOMED with
  // `git worktree move` to the deployment-level worktrees root and the move is
  // recorded in the receipt. `discardWorktree` restores removal. No retire
  // deletes a branch. A failed move keeps the home (fail closed).
  // The worktree step runs only once nothing else is outstanding (awebai/oats#444): a hook that did not finish
  // may need the worktree, and its retry needs the home, the worktree and its admin entry exactly as they
  // were. --force removes the home regardless, so the step runs first and no admin entry is left dangling.
  // A failed spawn's quarantine that owes the worktree removes it; any other retire retains it unless
  // --discard-worktree. An orphaned work directory is never touched.
  const outstandingBeforeWorktree = quarantine ? retryFailures : ordinaryIncomplete;
  // The home's extra trees (awebai/oats#674), in every work mode, before the
  // work/ step so that a refusal here leaves work/ as it is. Only when the
  // home is going to be removed: not under --keep-dir, and not when it is
  // kept for a retry (the work/ step's condition). The trees are the final
  // inspection's verified set, the one its recovery left out of the home's
  // bytes. A clean tree is removed (its branch stays in its repository); any
  // other is re-homed like work/; a locked one, or one Git will not move or
  // remove, refuses and keeps the home, --force included: it covers hook
  // debt, not local work. --discard-worktree does not apply. An applied plan
  // (`plannedExtraWorktrees`) binds what is done: trees that no longer read
  // as planned refuse as stale before any of them is touched.
  let extraWorktrees;
  let retention = null;
  // An attached child's `work` is a link to a tree of this home: to its work/ (#718) or to one of
  // its extra trees (#964). A tree the retire moves or removes would leave that link pointing at a
  // path that is gone. The children looked at are the recorded ones this retire stopped; each tree's
  // are found while the tree is still there (a link through an alias of the tree resolves only
  // then), each with its link as written. What the retire could not do for one, or leaves it with,
  // is a warning in the receipt: the retire is not undone.
  const relinkWarnings = [];
  const stoppedKids = (childrenStopped || []).filter((k) => k.ok);
  // The instances the plan lists under `ambiguous` (`o.ambiguous`, handed in with the children: this
  // function reads no lineage) are attached by their link as well. The retire does not act on them:
  // they are not stopped, and a write to an instance that may be running is not made. A tree that is
  // moved or removed leaves their link pointing at a path that is gone, and the receipt says so.
  const attachedTo = (tree) => [...stoppedKids, ...(Array.isArray(o.ambiguous) ? o.ambiguous.map((k) => ({ instance: k.instance, home: k.home, ambiguous: true })) : [])]
    .map((k) => ({ ...k, link: attachedWorkLink(k.home, tree) })).filter((k) => k.link !== null);
  const NOT_STOPPED = "it records this instance as its parent under a name that is not unique, so the retire did not stop it";
  // The attachment as it was found, still: attached, and the same link. One that changed is
  // someone else's now, and is left as it is.
  const stillAttached = (kid) => { try { return readJsonOrUndefined(join(kid.home, "instance.json"))?.work === "attached" && readlinkSync(join(kid.home, "work")) === kid.link; } catch { return false; } };
  /** Repoint each of `kids` to `to`, where the tree that was at `from` is retained. It is a write to
   *  another instance, so it is made only once the move is done and seen done: the tree is at its
   *  new path and nothing is left at the old one. The child's AGENTS.md still names the old path. */
  const repointAttached = (kids, from, to) => {
    const present = (p) => { try { lstatSync(p); return true; } catch { return false; } };
    const moved = kids.length > 0 && (() => { try { return lstatSync(to).isDirectory(); } catch { return false; } })() && !present(from);
    for (const kid of kids) {
      if (kid.ambiguous) {
        if (stillAttached(kid)) relinkWarnings.push(`${kid.instance}: its work was ${from}, which this retire re-homed to ${to}; its work link ${join(kid.home, "work")} was not repointed and now points at a path that is gone (${NOT_STOPPED}); to repoint it by hand: ln -sfn ${shq(to)} ${shq(join(kid.home, "work"))}`);
        continue;
      }
      if (!stillAttached(kid)) {
        relinkWarnings.push(`${kid.instance}: its attachment changed during the retire, so its work was left as it is now and not repointed to the retained worktree ${to}; inspect ${join(kid.home, "work")}`);
        continue;
      }
      try {
        if (!moved) throw new Error(`the worktree was not seen at ${to} with nothing left at ${from}`);
        relinkAttachedWork(kid.home, to);
      } catch (e) {
        relinkWarnings.push(`${kid.instance}: its work link could not be repointed to the retained worktree ${to} (${e.message}) and still points at ${kid.link}; repoint it by hand: ln -sfn ${shq(to)} ${shq(join(kid.home, "work"))}`);
      }
    }
  };
  /** Say of each of `kids` that the tree at `tree`, which this retire removed, was its work: its
   *  link, when it is still the one that was found, now points at a path that is gone. */
  const leftWithoutWork = (kids, tree, why) => {
    for (const kid of kids) if (stillAttached(kid)) relinkWarnings.push(`${kid.instance}: its work was ${tree}, which this retire removed (${why}); its work link ${join(kid.home, "work")} now points at a path that is gone${kid.ambiguous ? ` (${NOT_STOPPED})` : ""}`);
  };
  // From here on the retire removes and re-homes trees: a failure no longer says that the work is
  // kept, only what is still true, which trees it has dealt with, and what that left an attached
  // child with.
  const attachedSaid = () => relinkWarnings.length ? `. Attached children: ${relinkWarnings.join("; ")}` : "";
  const treesDone = () => {
    const done = [...(extraWorktrees || []).map((r) => r.outcome === "removed" ? `${r.path} removed` : `${r.path} re-homed to ${r.movedTo}`),
      ...(retention?.worktree === "removed" ? [`${workPath} removed`] : retention?.worktree === "retained" ? [`${workPath} re-homed to ${retention.movedTo}`] : [])];
    return done.length ? `. Already done in this retire: ${done.join(", ")}${attachedSaid()}` : "";
  };
  at.said = () => `${hooksSaid()}; the home is kept, and so is any recovery the retire wrote; ${sessionSaid()}${treesDone()}`;
  // The same for a refusal that has its own sentence, once the extra-tree step has dealt with a
  // tree: the refusals of that step, and every one of the work/ step, which comes after it.
  const alreadyDone = () => extraWorktrees?.length ? ` Already done in this retire: ${extraWorktrees.map((r) => r.outcome === "removed" ? `${r.path} removed` : `${r.path} re-homed to ${r.movedTo}`).join(", ")}${attachedSaid()}.` : "";
  if (!o.keepDir && !(outstandingBeforeWorktree.length > 0 && !o.force)) {
    const rows = extraWorktreeRows(finalObservation.extraTrees, root);
    if (o.plannedExtraWorktrees && JSON.stringify(rows) !== JSON.stringify(o.plannedExtraWorktrees)) {
      // After the hooks: never E_PLAN_STALE, which says that nothing happened (awebai/oats#895).
      throw oatsError("E_WORK_PRESERVATION_FAILED", `${name}: the home's extra worktrees changed since the retire plan was shown, so none of them was moved or removed. The retire hooks have run; the home and its work are kept. Review the fresh plan (\`oats retire ${name} --plan\`) and apply it again.`);
    }
    const refused = rows.filter((r) => r.disposition === "refuse");
    if (refused.length) {
      throw oatsError("E_WORK_PRESERVATION_FAILED", `${name}: ${refused.map((r) => `the extra worktree ${r.path}: ${r.reason}`).join("; ")}. No extra worktree was moved or removed and work/ is untouched; the retire hooks have run and the home is kept so nothing is lost.`);
    }
    extraWorktrees = [];
    // Who is attached to each tree, asked before any of them is moved or removed.
    const attachedOf = new Map(rows.map((row) => [row.path, attachedTo(row.path)]));
    // Each row's repository, by its Git directory: the commands run helper-free (gitRepoRun).
    const gitDirOf = new Map(finalObservation.extraTrees.map((tree) => [tree.path, tree.commonDir]));
    const git = (row, argv) => gitRepoRun(gitDirOf.get(row.path), argv);
    const failed = (row, what, e) => oatsError("E_WORK_PRESERVATION_FAILED", `${name}: the extra worktree ${row.path} ${what} (${String(e?.stderr ?? e?.message ?? e ?? "").trim()}).${alreadyDone()} work/ is untouched; the retire hooks have run and the home is kept so nothing is lost — resolve and retry.`);
    for (const row of rows) {
      if (row.disposition === "remove") {
        try {
          git(row, ["worktree", "remove", row.path]);
          git(row, ["worktree", "prune"]);
          const real = canonicalHomePath(row.path);
          if (existsSync(row.path) || parseWorktreeList(git(row, ["worktree", "list", "--porcelain", "-z"])).some((r) => canonicalHomePath(r.worktree) === real)) throw new Error("it is still there after `git worktree remove`");
        } catch (e) { throw failed(row, "could not be removed, or its removal could not be verified", e); }
        extraWorktrees.push({ ...row, outcome: "removed" });
        appendEvent(found.home, { kind: "worktree-removed", data: { branch: row.branch, extra: true, path: row.path } }, { workspaceOnly: true });
        leftWithoutWork(attachedOf.get(row.path), row.path, "an extra worktree of the retired instance, clean: its branch and commits stay in its repository");
      } else {
        try {
          mkdirSync(dirname(row.movedTo), { recursive: true });
          git(row, ["worktree", "move", row.path, row.movedTo]);
        } catch (e) { throw failed(row, `could not be re-homed to ${row.movedTo}`, e); }
        extraWorktrees.push({ ...row, outcome: "retained" });
        appendEvent(found.home, { kind: "worktree-retained", data: { movedTo: row.movedTo, branch: row.branch, recordedBranch: null, extra: true, path: row.path } }, { workspaceOnly: true });
        // Right after this tree's move, not at the end as for work/: the work/ step below can still
        // refuse and keep the home, and the tree has left it either way.
        repointAttached(attachedOf.get(row.path), row.path, row.movedTo);
      }
    }
    if (!extraWorktrees.length) extraWorktrees = undefined;
  }
  // The attached children this retire stopped whose work is this home's work/
  // (#718), found while work/ is still here.
  const attachedKids = attachedTo(workPath);
  const worktreeStep = isWorktree && !!workMeta.repo && !orphanedWork;
  const worktreeDeferred = worktreeStep && existsSync(workPath) && outstandingBeforeWorktree.length > 0 && !o.force;
  const keptForRetry = worktreeDeferred ? `git worktree ${workPath}: kept for the retry; outstanding: ${outstandingBeforeWorktree.join("; ")}` : null;
  // The repository of work/, by its common Git directory (awebai/oats#679), read once from meta.repo: the
  // step's commands and the quarantine's verification below run helper-free against it (gitRepoRun,
  // gitRepoRead), as the extra-tree step's do. A bare repository is named as its Git directory.
  // → { dir } or { error }.
  let workRepo;
  const workRepoGitDir = () => {
    if (workRepo) return workRepo;
    const args = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
    let r = gitRead(workMeta.repo, args);
    if (!r.ok) { const asGitDir = gitRepoRead(workMeta.repo, args); if (asGitDir.ok) r = asGitDir; }
    const dir = r.ok ? r.out.replace(/\n$/, "") : "";
    return (workRepo = dir && !dir.includes("\n") ? { dir: realPathOrNearest(dir) } : { error: r.ok ? `git rev-parse printed no single Git directory for ${workMeta.repo}` : r.err });
  };
  // Whether an entry is at the path: lstat, so a dangling link is an entry; one that cannot be tested counts.
  const entryAt = (path) => { try { lstatSync(path); return true; } catch (e) { return e?.code !== "ENOENT"; } };
  // A removal that work/ was not there for, from a repository that could not be read: nothing was verified.
  let removalUnverified;
  if (worktreeStep && !worktreeDeferred) {
    // A HEAD that cannot be read here is recorded as no branch and no commit, and the worktree is retained.
    const ref = existsSync(workPath) ? (() => { try { return worktreeHead(workPath); } catch { return { branch: null, commit: null }; } })() : { branch: meta.branch ?? null, commit: null };
    const verifiedBranch = ref.branch;
    // --discard-worktree, or a quarantine that owes the worktree, removes it. Plain retire retains.
    if (worktreeRemoval.removes) {
      // HEAD as it is now against HEAD as the final inspection read it: a
      // worktree whose HEAD moved since is not removed, and nothing else is
      // done. Whatever moved it may have made a commit only it reaches.
      if (existsSync(workPath)) {
        let now;
        try { now = worktreeHead(workPath); }
        catch (e) { throw oatsError("E_WORK_INSPECTION_FAILED", `${e.message}. The worktree was not removed.${alreadyDone()} The home and the worktree are kept, and so is any recovery the retire wrote; retry the retire.`); }
        try { assertSameWorktreeHead(finalObservation.head, now); }
        catch (e) { throw oatsError(e.code, `${e.message}${alreadyDone()}`); }
      }
      // The removal is verified as the extra-tree step's is: nothing is at work/ and the repository's
      // worktree list does not name it. A removal that did not happen, or cannot be shown to have
      // happened, refuses and keeps the home, --force included. One exception: nothing at work/ and a
      // repository that cannot be read is recorded as absent, never removed; a quarantine keeps that
      // as an item its retry could not verify (below).
      const present = entryAt(workPath);
      const gitDir = workRepoGitDir();
      if (gitDir.error && !present) {
        removalUnverified = gitDir.error;
        retention = { worktree: "absent", branch: verifiedBranch, recordedBranch: meta.branch ?? null };
      } else {
        const real = canonicalHomePath(workPath);
        try {
          if (gitDir.error) throw new Error(gitDir.error);
          if (present) gitRepoRun(gitDir.dir, ["worktree", "remove", "--force", workPath]);
          gitRepoRun(gitDir.dir, ["worktree", "prune"]);
          if (entryAt(workPath) || parseWorktreeList(gitRepoRun(gitDir.dir, ["worktree", "list", "--porcelain", "-z"])).some((r) => canonicalHomePath(r.worktree) === real)) throw new Error("it is still there after `git worktree remove`");
        } catch (e) {
          throw oatsError("E_WORK_PRESERVATION_FAILED", `${name}: the worktree at ${workPath} could not be removed, or its removal could not be verified (${String(e?.stderr || e?.message || e || "").trim() || "unknown error"}).${alreadyDone()} The retire hooks have run; the home is kept, and so is any recovery the retire wrote; ${sessionSaid()}. Check what is left at ${workPath}, then retry the retire.`);
        }
        retention = { worktree: "removed", branch: verifiedBranch, recordedBranch: meta.branch ?? null };
      }
    } else if (existsSync(workPath)) {
      const dest = retainedWorktreeDest(workspaceOf(root), workMeta.repo, verifiedBranch, ref.commit);
      mkdirSync(dirname(dest), { recursive: true });
      try {
        const gitDir = workRepoGitDir();
        if (gitDir.error) throw new Error(gitDir.error);
        gitRepoRun(gitDir.dir, ["worktree", "move", workPath, dest]);
      } catch (e) {
        throw oatsError("E_WORK_PRESERVATION_FAILED", `${name}: the worktree at ${workPath} could not be re-homed to ${dest} (${String(e.stderr ?? e.message ?? "").trim()})${alreadyDone() ? `.${alreadyDone()} The` : "; the"} home is kept so nothing is lost — resolve and retry, or pass --discard-worktree to remove the worktree instead`);
      }
      retention = { worktree: "retained", movedTo: dest, branch: verifiedBranch, detachedAt: verifiedBranch === null ? ref.commit : null, recordedBranch: meta.branch ?? null };
    } else retention = { worktree: "absent", branch: verifiedBranch, recordedBranch: meta.branch ?? null };
  }
  if (retention) {
    if (retention.worktree === "retained") appendEvent(found.home, { kind: "worktree-retained", data: { movedTo: retention.movedTo, branch: retention.branch, recordedBranch: retention.recordedBranch } }, { workspaceOnly: true });
    else if (retention.worktree === "removed") appendEvent(found.home, { kind: "worktree-removed", data: { branch: retention.branch } }, { workspaceOnly: true });
  }
  // `hooks`: which retire hooks ran (in order) and how each ended — the same
  // receipt `spawned` carries, so the workspace log shows both halves of a
  // capability's lifecycle after the home is gone.
  const retireHookReceipt = (() => { const res = hookResults || {}; const failedBy = new Map((res.failures || []).map((f) => [f.capability, f])); return (res.order || []).map((id) => ({ capability: id, ok: !failedBy.has(id), meta: Object.hasOwn(res.meta || {}, id) })); })();
  const retiredEvent = appendEvent(found.home, { kind: "retired", data: { agent: found.agent.name, keepDir: !!o.keepDir, self, quarantine: !!quarantine, workRecovery: workRecovery?.path ?? null, hooks: retireHookReceipt, ...(o[OBSOLETE_DELETE_BRANCH] ? { reason: OBSOLETE_DELETE_BRANCH_SENTENCE } : {}) } }, { workspaceOnly: true });
  // Retrying a quarantine only clears it if compensation ACTUALLY completed.
  // Otherwise the home — and the credentials in it — must survive again, or the
  // retry becomes the deletion the quarantine was preventing.
  let stillIncomplete;
  // Whether what is still incomplete is retire hooks and nothing else (RETIRE_HOOK_DEBT_ONLY).
  // `keptForRetry` is not debt of its own: it is the worktree kept because of those items, and a
  // retry runs the worktree step once they clear.
  let hookDebtOnly = false;
  // Ordinary path: quarantine instead of deleting, using the SAME writer the
  // spawn rollback uses. Two copies of this logic is how a previous divergence
  // happened (see quarantineInstanceHome), so there is still exactly one.
  if (!quarantine && !self && ordinaryIncomplete.length) {
    if (keptForRetry) ordinaryIncomplete.push(keptForRetry);
    const outstandingHooks = new Set();
    for (const f of hookResults?.failures || []) outstandingHooks.add(f.capability);
    for (const [capId, m] of Object.entries(hookResults?.meta || {})) {
      if (m && typeof m === "object" && m.retired === false && m.reason !== "nothing-to-delete") outstandingHooks.add(capId);
    }
    // What the writer adds to the items is debt of its own: a descriptor kept outside the home, or
    // one that could not be stored, owes a restoration no rerun of the hooks makes.
    const itemsBeforeQuarantine = ordinaryIncomplete.length;
    quarantineInstanceHome({
      home: found.home, instance: name, agent: found.agent,
      soulDir: instanceSoulDir(found.home, meta), soulId: nonEmptyString(meta.soulId) ? meta.soulId : undefined,
      incomplete: ordinaryIncomplete, failed: [...outstandingHooks],
      outstandingHooks, outstandingGit: new Set(),
      repoAbs: meta.repo, work: meta.work, branch: meta.branch,
      resolvedCfg: { capabilities: meta.capabilityRuntime || [] },
      hookMeta: meta.capabilityMeta || {}, compensationMeta: hookResults?.meta || {},
      orphanedWork: !!orphanedWork,
      reason: outstandingHooks.size ? "retire hook reported incomplete cleanup" : "the work directory has no git admin entry",
    });
    stillIncomplete = ordinaryIncomplete;
    hookDebtOnly = outstandingHooks.size > 0 && !orphanItem && ordinaryIncomplete.length === itemsBeforeQuarantine;
  }
  let branchDeletedByRetry = false, branchKeptReason;
  if (quarantine) {
    const failures = [...retryFailures];
    if (keptForRetry) failures.push(keptForRetry);
    // What the hooks left, before the Git verification below adds its own items.
    const hookItems = failures.length;
    // The quarantine may exist BECAUSE Git cleanup failed, so a retry has to
    // redo those steps and verify them — not just rerun hooks. No retire deletes a branch.
    if (workMeta.work === "worktree" && workMeta.repo) {
      // A worktree this retry removed (the step above ran) must be verified gone; one it retained or kept for
      // the next retry stays registered by design. The removal is not attempted a second time here: only the
      // worktree step removes, after its check of HEAD, so a worktree it failed to remove is still registered
      // and the next retry goes through that step again.
      // Its commands run helper-free against the repository's common Git directory (workRepoGitDir).
      const gitDir = workRepoGitDir();
      if (retention?.worktree === "removed") {
        const wtCanonical = canonicalHomePath(workPath);
        let wtProbe;
        if (gitDir.error) wtProbe = { ok: false, err: gitDir.error };
        else {
          try { gitRepoRun(gitDir.dir, ["worktree", "prune"]); } catch { /* the list below decides */ }
          wtProbe = gitRepoRead(gitDir.dir, ["worktree", "list", "--porcelain", "-z"]);
        }
        if (!wtProbe.ok) failures.push(`git worktree ${wtCanonical}: could not verify removal (${wtProbe.err || "worktree list failed"})`);
        else if (parseWorktreeList(wtProbe.out).some((r) => canonicalHomePath(r.worktree) === wtCanonical)) failures.push(`git worktree ${wtCanonical}: still registered`);
      } else if (retention?.worktree === "absent" && removalUnverified !== undefined) {
        failures.push(`git worktree ${realPathOrNearest(workPath)}: could not verify removal (${removalUnverified})`);
      }
      // The branch is a debt only when the failed spawn's rollback still owes its deletion. A retry never
      // deletes it: the debt is cleared only when the branch is shown to be gone. Git's quiet exit 1 is
      // "gone"; any other answer, or any text on standard error (a damaged ref file warns there), is
      // "could not verify", and the debt stays. The text is never matched: this read can only err
      // toward keeping the debt.
      const owesBranch = (quarantine.cleanup.outstanding?.git || []).includes("branch");
      // The one exception (#796): a spawn killed while its worktree hooks ran never reached its own
      // compensation. Its marker carries `inProgress` (its process verified dead above) with the branch
      // and the commit the spawn created it at. Once the retire hooks ran and the worktree's removal is
      // verified, the retry finishes that compensation: an atomic compare-and-delete at that commit,
      // refused when the tip moved, the branch is checked out anywhere, or the ref cannot be read. A
      // branch still at its creation commit holds no work. Every other quarantine keeps the rule above.
      const ip = quarantine.inProgress;
      if (owesBranch && meta.branch && ip && ip.branch === meta.branch && inProgressUnverified) branchKeptReason = "the spawn's process or its hook group could not be verified gone (retired with --force)";
      else if (owesBranch && meta.branch && ip && ip.branch === meta.branch && /^[0-9a-f]{40,64}$/.test(String(ip.baseOid ?? "")) && retention?.worktree === "removed" && !failures.length) {
        const ref = `refs/heads/${meta.branch}`;
        // Retire's Git, bounded and helper-free (retireGit, #809): two reads, then the one write.
        const tip = retireGitProbe(workMeta.repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", ref], { encoding: "utf8" });
        const list = retireGitProbe(workMeta.repo, ["worktree", "list", "--porcelain", "-z"], { encoding: "utf8" });
        const listOk = !list.error && list.status === 0;
        const checkedOut = listOk && list.stdout.split("\0").includes(`branch ${ref}`);
        if (tip.error || tip.status !== 0 || tip.stderr.length) branchKeptReason = "the branch could not be read";
        else if (tip.stdout.trim() !== ip.baseOid) branchKeptReason = `its tip moved from ${ip.baseOid.slice(0, 12)}, where the spawn created it`;
        else if (!listOk) branchKeptReason = "whether it is checked out could not be read";
        else if (checkedOut) branchKeptReason = "it is checked out in a worktree";
        else {
          const del = retireGitProbe(workMeta.repo, ["update-ref", "-d", ref, ip.baseOid], { encoding: "utf8" });
          if (del.error || del.status !== 0) branchKeptReason = `git refused to delete it (${String(del.stderr || del.error?.message || "").trim().split("\n")[0] || "update-ref failed"})`;
          else branchDeletedByRetry = true;
        }
      }
      if (owesBranch && meta.branch) {
        let br;
        if (gitDir.error) br = { error: new Error(gitDir.error) };
        else {
          try { gitRepoRun(gitDir.dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${meta.branch}`]); br = { status: 0, stderr: "" }; }
          catch (e2) { br = { error: e2.status === undefined || e2.status === null ? e2 : undefined, status: e2.status, stderr: String(e2.stderr ?? "") }; }
        }
        if (!br.error && br.status === 0) failures.push(FAILED_SPAWN_BRANCH_LEFT);
        else if (br.error || br.status !== 1 || br.stderr.length) failures.push(`git branch ${meta.branch}: could not verify whether it still exists (${String(br.stderr ?? "").trim() || br.error?.message || `rev-parse exit ${br.status}`})`);
      }
    }
    // Git debt is proven by the verification block above, which only runs for a
    // worktree in a known repo. If it could not run, the debt stands.
    if (quarantine.cleanup.outstanding?.git?.length && !(workMeta.work === "worktree" && workMeta.repo)) {
      failures.push(`git ${quarantine.cleanup.outstanding.git.join(", ")}: not re-verified on this retry, so the cleanup they owed is unverified`);
    }
    if (failures.length) {
      stillIncomplete = failures;
      // Hook debt alone: a retire hook is still owed, nothing no rerun can clear is, no Git step was
      // added by the verification above, and the marker owes no Git step, directory or orphaned work.
      const owed = quarantine.cleanup.outstanding;
      hookDebtOnly = retryFailures.length > 0 && retryNonHook === 0 && failures.length === hookItems
        && !owed?.git?.length && owed?.directory !== true && owed?.orphanedWork !== true;
      try {
        writeFileSync(quarantinePath, JSON.stringify({ ...quarantine, incomplete: failures, lastRetryAt: new Date().toISOString() }, null, 2) + "\n");
      } catch { /* the quarantine stands regardless */ }
    }
  }
  // An attached child whose `work` links to this home's work/ would dangle once
  // the worktree is re-homed (#718): each one this retire stopped is repointed
  // to the retained worktree, whether or not the home is then removed (the work
  // has left it either way). It is a write to another instance, so it comes
  // last, once the move is done and seen done: the worktree is at its new path
  // and nothing is left at work/. One that fails is a warning; the retire is
  // not undone. The child's AGENTS.md still names the old path.
  if (retention?.worktree === "retained") repointAttached(attachedKids, workPath, retention.movedTo);
  // A work/ this retire removed (--discard-worktree, or a failed spawn's quarantine that owed it)
  // leaves each of them with a link to a path that is gone (#964): said, by name.
  else if (retention?.worktree === "removed") leftWithoutWork(attachedKids, workPath, o.discardWorktree ? "--discard-worktree" : "the worktree of a spawn that failed");
  // Forcing is the operator overriding the fail-closed default with their eyes
  // open: the home goes, and what remains outstanding is reported rather than
  // swallowed. Without this, a quarantine whose cleanup can never succeed (a
  // capability that offers no way to undo its own setup, a permanently
  // unreachable remote) would be unremovable through OATS forever — the same
  // dead end the unusable-marker fixes closed, just reached from a valid one.
  const forced = !!(stillIncomplete && o.force);
  // Where a link under a record that says `worktree` leads, for the receipt (#973): once the home
  // is removed nothing else says it. The system's answer for the link, read here and only read:
  // never the text stored in the link, and no step acts on the path. null: it does not resolve.
  const linkLed = link && meta.work === "worktree" && !o.keepDir && (!stillIncomplete || forced)
    ? (() => { try { return { path: realpathSync(workPath) }; } catch { return { path: null }; } })() : undefined;
  if (!o.keepDir && (!stillIncomplete || forced)) {
    // The removal. A failure in it (a directory that is written into, or that cannot be emptied)
    // says what the retire did and what is at the home now, as it is on disk when it is answered.
    at.phase = "removal";
    at.removing = true;
    at.said = () => {
      const recovery = recoveryOnDisk(at.recoveryPath);
      const home = homeOnDisk(found.home, true);
      return [hooksSaid(),
        recovery ? `its recovery (${recovery.phase}) is at ${recovery.path}` : at.recoveryPath ? `its recovery at ${at.recoveryPath} could not be read` : "it wrote no recovery",
        retiredEvent.ok ? "its retired event is recorded" : "its retired event could not be recorded",
        home === "removed" ? `nothing is left at ${found.home}` : `what is left at ${found.home} may not be a whole instance home`,
        sessionSaid()].join("; ") + treesDone();
    };
    at.lead = () => `${name}: the directory at ${found.home} could not be removed`;
    rmSync(found.home, { recursive: true, force: true });
    at.lead = () => `${name}: its home was removed, and a file the retire leaves beside it could not be`;
    rmSync(directoryFallbackPath, { force: true });
    // The owed retirement is paid: clear the pending marker, and the failed
    // outcome an earlier deferred attempt may have left beside the home; a
    // deferred completion writes its own outcome after this returns.
    rmSync(retirePendingMarkerPath(found.home), { force: true });
    rmSync(deferredRetireResultPath(found.home), { force: true });
    rmSync(deferredRetireResultPath(found.home).replace(/\.json$/, ".log"), { force: true });
    // And the retry state a completion that was killed while it waited may have left (retireRetryPath).
    rmSync(retireRetryPath(found.home), { force: true });
    at.lead = null;
  }

  const result = { retired: name, agent: found.agent.name, workRecovery, retention, extraWorktrees, worktreeRemoved: isWorktree && !!retention && retention.worktree !== "retained", branchDeleted: false, ...(branchDeletedByRetry || branchKeptReason ? { spawnCompensation: { branch: meta.branch, branchDeleted: branchDeletedByRetry, ...(branchKeptReason ? { reason: branchKeptReason } : {}) } } : {}), removedDir: !o.keepDir && (!stillIncomplete || forced), rollbackIncomplete: forced ? undefined : stillIncomplete, forcedIncomplete: forced ? stillIncomplete : undefined, retainedHome: stillIncomplete && !forced ? found.home : undefined, relinked: relinked.length ? relinked : undefined, childrenStopped, capabilityMeta: hookResults?.meta, warnings: (() => {
    const w = [...spawnGroupWarnings, ...(hookResults?.warnings || []), ...relinkWarnings];
    // What the retire read from Git about work/ where the record did not say it (#962).
    if (repoFromGit) w.push(`the record names no repository for the work tree at ${workPath}: the retire used the one Git names for it, ${repoFromGit}; the record was not changed`);
    if (homeDirectory && workIs.tree && !o.keepDir && (!stillIncomplete || forced)) w.push(`${workPath} was a registered worktree of ${workIs.tree.repo} and not this instance's own tree: it was copied to recovery and removed with the home as a directory of the home. Its entry stays in that repository until a prune (git -C ${shq(workIs.tree.repo)} worktree prune); its branch and commits are untouched`);
    if (linkLed) w.push(`${workPath} was a link though the record says work mode worktree: nothing was retained or removed as a work tree, and ${linkLed.path === null ? "it led nowhere that could be read" : `what it led to (${linkLed.path}) was not touched`}`);
    if (o[OBSOLETE_DELETE_BRANCH]) w.push(OBSOLETE_DELETE_BRANCH_SENTENCE);
    if (isCapturedHome(meta) && !quarantine) {
      // A captured home retires through the workspace path; its captured retire hooks do not
      // run (lead decisions on (e), D1), so each capability whose spawn hook ran is named.
      const caps = capturedHomeCapabilities(meta);
      for (const cap of caps) w.push(`${cap}: its retire hook did NOT run (captured home; the captured/portable path was removed in 0.26) — identities/memberships it created are not revoked; remove them with the provider's own tooling`);
      if (!caps.length) w.push("captured home: no retire hook ran (the captured/portable path was removed in 0.26) — any identities/memberships its capabilities created are not revoked; remove them with the provider's own tooling");
    } else if (!Array.isArray(meta?.capabilityRuntime) && !quarantine) w.push("this home records no capability hooks (an earlier kernel spawned it): no retire hook ran; any external state its capabilities created is the operator's to clean up");
    return w.length ? w : undefined;
  })() };
  result[RETIRE_SELECTED_HOME] = found.home;
  result[RETIRE_HOOK_DEBT_ONLY] = !!stillIncomplete && !forced && hookDebtOnly;
  if (self) {
    // The caller is the instance: its process lives in the window we are about to
    // kill. Detach the kill so this function can return and the caller can report
    // before dying. The delay is the caller's window to print its last words.
    // The window the home RECORDED (a pre-0.31 home lives in pi-agents), never the default for new ones.
    const killSession = runtimeAuthority?.tmux?.session || meta?.tmux?.session || session;
    const killWindow = runtimeAuthority?.tmux?.window || meta?.tmux?.window || name;
    // On the socket the receipt (else instance.json) records, both the scheduling and the kill; a home
    // that records none keeps the ambient server. run-shell expands its command as a format: a
    // literal # in the socket path is written ##.
    const killSocket = runtimeAuthority?.tmux?.socket || meta?.tmux?.socket;
    const killTarget = shq(`=${killSession}:=${killWindow}`);
    // The home `--keep-dir` keeps reads `stopped` once its window is gone, never `lost` (recordStop,
    // as above). A record that cannot be written stops nothing: the home then reads lost, as before.
    if (o.keepDir) { try { recordStop(found.home, null); } catch { /* see above */ } }
    if (typeof killSocket === "string" && killSocket) {
      const kill = `sleep ${o.selfKillDelaySec ?? 8}; tmux -u -S ${shq(killSocket)} kill-window -t ${killTarget} 2>/dev/null || true`;
      shTry(`tmux -u -S ${shq(killSocket)} run-shell -b ${shq(kill.replace(/#/g, "##"))}`);
    } else shTry(`tmux run-shell -b 'sleep ${o.selfKillDelaySec ?? 8}; tmux kill-window -t ${killTarget} 2>/dev/null || true'`);
    result.selfKillScheduled = true;
  }
  return result;
}
