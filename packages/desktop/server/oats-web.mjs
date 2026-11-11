#!/usr/bin/env node
/**
 * OATS desktop backend server — the app's local control-panel API.
 *
 *   node oats-web.mjs start --socket <path> (--token-fd <n> | --token-file <path>)
 *       [--dir <deployment>]... [--cli-choice <file>] [--oats-bin <path>]
 *
 * A zero-dependency HTTP server on a private Unix domain socket (spawned by
 * the Electron main process, which is its only client; the renderer reaches
 * it only through main's IPC proxy):
 *   GET  /api/panel                 roster JSON (instances, task, tmux state; local Git unobserved)
 *   GET  /api/agents                available agents (souls) per workspace root
 *                                   (both: an explicit ?ws= not served → 404 E_WORKSPACE_NOT_SERVED)
 *   POST /api/spawn?ws=<id>         { action: prepare|apply|result, … } → preview-bound spawn (packages/client/spawn-apply.mjs);
 *                                   { agent, agentsRoot, serverId, … } → execution-server spawn only
 *                                   (mutations require the installed `oats` CLI; see cliUnavailable)
 *   POST /api/instance-git?ws=<id>  { action: git|diff, selector, fileId?, revision?, indexRevision? } → qualified K1 read
 *   POST /api/workspace-sync?ws=<id> { action: read|sync, refresh? } → the held `oats capabilities` catalog / `oats sync` (workspace-v2)
 *   POST /api/capabilities?ws=<id>  { action: inspect|run, selector, … } → `oats inspect` / provider operations (server/capabilities.mjs);
 *                                   { action: show|file, capability, path? } → `oats capabilities show` for one held catalog row
 *                                   (server/capability-show.mjs; local only; errors 409/400 { error, code })
 *   POST /api/models                { harness: pi|claude|codex } → advisory model catalog for the spawn modal
 *   GET  /api/cli                   CLI discovery status (bin, version, required range, tried, probePath/pathSource/pathError, reader)
 *   POST /api/cli/reprobe           re-run discovery; body {} or empty (anything else 400 E_BAD_ARGS). The chosen
 *                                   binary is the --cli-choice file's, written by main after its own file dialog
 *   POST /api/window-state          { focused } → the refresh cadence backs off while the window is blurred/hidden
 *   POST /api/windows               { views: [viewId|null, …] } → the views the open windows show: the remote roster
 *                                   reads their workspaces' machines (#1124)
 *   POST /api/remote-roster/refresh → the remote roster read now (or the one in flight), answered once it has landed
 *   GET  /api/brain/<agent>?ws=<id> agent "brain" JSON: soul (AGENTS.md, skills,
 *                                   knowledge tree) + per-instance artifacts (abs paths)
 *   GET  /api/file?path=<abs>       text file content, guarded to workspace roots + agent homes
 *
 *   GET  /api/version               { capability, version } of this bundled server
 *
 * SECURITY: this process can type into your terminals. It listens only on
 * --socket, whose directory must be a real directory owned by this user with
 * no group/other permissions (no TCP listener; --port is refused). Every
 * request, any method and any path, must carry `Authorization: Bearer
 * <secret>`, else 401 E_UNAUTHORIZED before the target is parsed or the body
 * read. The secret is 32 random bytes (base64url, 43 characters), fresh for
 * each server main starts, read once at startup from --token-fd (main's
 * private pipe) or --token-file (an operator's own 0600 file) and never
 * printed. The Host guard (a loopback Host) and the Origin guard on POST stay.
 * After listening, stdout carries the line `oats-desktop-server ready`.
 * Deployment model: every roster/header fact is the installed kernel's
 * `oats status --json` / `oats workspace status --json` (workspace model v2).
 * The server reads no deployment file and has no fallback reader.
 * Load path: status, workspace status and (cold) souls start together and the roster is
 * published as soon as the first two land; souls, the capabilities table and inspect results
 * are held server-side and re-read only when the kernel state they were read under moves
 * (see docs/desktop-load-path.md). Every roster/agents/catalog/inspect answer carries
 * `observedAt` (the kernel's observation time when reported, else the read's completion) and
 * `refreshing` (a read for that data is in flight).
 */
// FIRST, above every other import: this process drops what the Desktop and its packaging added
// to its environment (own-environment.mjs), so each module below, and every program this
// process starts, sees the user's. Nothing here passes the cleaning function to a child.
import { launchEnvironment } from "../../client/own-environment.mjs";
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, lstatSync, unlinkSync, chmodSync, realpathSync, accessSync, constants as fsConstants } from "node:fs";
import { StartupRefusal, readSecretFd, readSecretFile, checkSocketParent, bearerBytes, bearerMatches, sameFile, carriesSecret, CREDENTIAL_IN_REPLY, UNAUTHORIZED } from "./request-checks.mjs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";
import { scheduleRequest } from "./schedules.mjs";
import { capabilityRequest } from "./capabilities.mjs";
import { createDeploymentObserver, mapBounded, MAX_DEPLOYMENT_OBSERVATIONS } from "../../client/deployment-observer.mjs";
import { createWarmReader } from "../../client/warm-reader.mjs";
import { createMachines } from "./machines.mjs";
import { createServerForget, forgetNotRun } from "./server-forget.mjs";
import { machinesGated } from "../../client/machine-contract.mjs";
import { createSoulCatalog, soulCatalogKey } from "../../client/soul-catalog.mjs";
import { createCapabilityCatalog, capabilityCatalogKey } from "../../client/capability-catalog.mjs";
import { capabilityShowRequest, createCapabilityShowCache } from "./capability-show.mjs";
import { createInspectCache } from "../../client/inspect-cache.mjs";
import { createRefreshLoop, REFRESH_FOCUSED_MS, REFRESH_BLURRED_MS } from "../../client/refresh-loop.mjs";
import { createWorkspaceSyncBoundary, syncFailure } from "./workspace-sync.mjs";
import { instanceGitRequest } from "./instance-git.mjs";
import { createLifecycleBoundary } from "../../client/instance-lifecycle.mjs";
import { readinessRequest } from './readiness.mjs';
import { readinessFailure } from '../../client/readiness-contract.mjs';
import { createSpawnPreview } from '../../client/spawn-preview.mjs';
import { teamsRequest, soulTeamsRequest, teamsFailure } from './teams.mjs';
import { instanceColorRequest, instanceColorNotRun } from './instance-color.mjs';
import { instanceBackgroundRequest, instanceBackgroundNotRun } from './instance-background.mjs';
import { rereadsRoster } from './instance-record.mjs';
import { instanceEventsRequest } from './instance-events.mjs';
import { eventsFailure } from '../../client/instance-events-contract.mjs';
import { createSpawnApplyBoundary, ANSWER_WITHIN_MS } from '../../client/spawn-apply.mjs';
import { spawnApplyFailure } from '../../client/spawn-apply-contract.mjs';
import { previewFailure, namingOf, APPLY_SUGGEST_FEATURE } from '../../client/spawn-preview-contract.mjs';
import { forgeBoundary, FORGE_EPOCH_HEADER, validForgeEpoch } from "./forge.mjs";
import { createReviewPaste } from "./review-paste.mjs";
import { launchConfigRequest } from "./launch-configs.mjs";
import { displayLine } from "../../client/display-text.mjs";
import { automationsRequest, automationsFailure } from "./automations.mjs";
import { soulRows } from "../../client/soul-rows.mjs";
import { harnessFlag, HARNESSES } from "../../client/harness-names.mjs";
import { probeChanged } from "../../client/cli-probe-contract.mjs";
import { aboveTestedRefusal, postOperation, postRouteClassified } from "../../client/above-tested.mjs";
import { workspaceNotServed } from "../renderer/deployment-header.mjs";
import { createRemoteIdentityStore } from "./remote-identity.mjs";
import { DESKTOP_TERMS } from "../renderer/desktop-terms.mjs";
import { validWorkspaceId } from "../renderer/workspace-id.mjs";
import { MAX_WINDOW_VIEWS } from "../window-activity.mjs";
import { START_UNCONFIRMED } from "../renderer/start-unconfirmed.mjs";
import { startInstance, verifiedLocalHome as localHomeIn } from "../../client/session-start.mjs";
import { rosterRows, kernelLiveness, livenessInput, livenessAnswers, panelInstances, pendingEntry, failedEntry, observedEntry } from "../../client/deployment-panel.mjs";
import { deployments, viewFor, deploymentFor, surfaceDeployment, viewForgeContext, deploymentRows, isServed, teamMembersFor, machineScope, panelData, cliReadsRemotes, rosterWorkspaceKeys } from "../../client/panel-views.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// Identity (GET /api/version): main checks that the server it started is this
// package's (server-compat.mjs `serverCompatible`). The bundled server's
// identity is the desktop package's name and version.
// The same version is this Desktop's TESTED BOUND (packages/client/cli-locator.mjs testedBound): the
// newest CLI minor it accepts without holding anything back. It is the Desktop's own manifest, the
// version of the app installed, which the version-bump PR moves with the kernel's; the release checks
// (scripts/check-package-dry-runs.mjs checkReleaseVersions) refuse a checkout where they differ.
const MANIFEST = (() => {
  const p = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));
  return { capability: p.name, version: p.version };
})();

const args = process.argv.slice(2);
const sub = args[0];
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true) : undefined;
};
const flagAll = (name) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] && !args[i + 1].startsWith("--") ? [args[i + 1]] : []));

// "collect" is retired: the kernel owns roster collection and the CLI read is
// asynchronous. Terminal liveness is the kernel's rows under feature status-liveness,
// else it runs in packages/client/liveness-main.mjs children.
const USAGE = "usage: oats-web.mjs start --socket <path> (--token-fd <n> | --token-file <path>) [--dir <deployment>]...  (repeat --dir for multiple deployments)";
if (sub !== "start") {
  console.error(USAGE);
  process.exit(1);
}

/* ── Startup checks: before anything listens and before any child process starts ──
   The server listens only on a Unix domain socket whose directory is private to this user, and
   answers only requests carrying the credential it reads here (server/request-checks.mjs). A
   refusal is one stderr line naming the flag, never a value, and exit 1. */
const startupRefusal = (message) => { console.error(`oats-desktop server: ${message}`); process.exit(1); };
let SOCKET_PATH, BEARER;
let CREDENTIAL; // the secret itself: no reply that holds it is sent (send)
let TOKEN_FILE = null; // the --token-file's { dev, ino }: never served, whatever path names it
try {
  if (args.includes("--port")) throw new StartupRefusal("--port is not accepted: the server listens only on --socket <path>");
  const tokenFd = flag("token-fd"), tokenFile = flag("token-file"), socket = flag("socket");
  if (typeof socket !== "string") throw new StartupRefusal(`--socket <path> is required\n${USAGE}`);
  if ((tokenFd === undefined) === (tokenFile === undefined)) throw new StartupRefusal("exactly one of --token-fd <n> or --token-file <path> is required");
  let secret;
  if (tokenFd !== undefined) {
    if (typeof tokenFd !== "string" || !/^[1-9][0-9]{0,3}$/.test(tokenFd) || Number(tokenFd) < 3) throw new StartupRefusal("--token-fd must name a descriptor of 3 or more");
    secret = readSecretFd(Number(tokenFd));
  } else {
    if (typeof tokenFile !== "string") throw new StartupRefusal("--token-file needs a path");
    ({ secret, identity: TOKEN_FILE } = readSecretFile(tokenFile));
  }
  checkSocketParent(socket);
  SOCKET_PATH = socket;
  BEARER = bearerBytes(secret);
  CREDENTIAL = secret;
} catch (e) {
  startupRefusal(e instanceof StartupRefusal ? e.message : "startup checks failed");
}

// The packaged app never imports the framework checkout's kernel module and
// accepts no framework-root override; reads and mutations use the installed CLI.
// These three are in the shared home (packages/client), which the package places beside app.asar
// (electron-builder.config.cjs: extraResources), at the same relative position as here.
const locator = await import(pathToFileURL(join(HERE, "..", "..", "client", "cli-locator.mjs")).href);
const adapter = await import(pathToFileURL(join(HERE, "..", "..", "client", "cli-adapter.mjs")).href);
const remote = await import(pathToFileURL(join(HERE, "..", "..", "client", "remote-roster.mjs")).href);
let remoteGroups = [];
let remoteRead = null; // the remote roster read in flight (refreshRemoteSnapshot)

/** Deployments in view. Each --dir registers one (repeatable); no --dir serves
 * no local deployment, never the cwd (#518). A deployment is identified by its
 * canonical directory, exactly as given to `oats --dir`; the kernel decides
 * whether it is one. */
const ctxs = [...new Set(flagAll("dir").map((d) => resolve(String(d))))];
const DEBUG = flag("debug") === true || process.env.OATSWEB_DEBUG === "1";
/* Internal (#698): stdin is the owner lifeline from Desktop's main (server-host.mjs); exit at its EOF. */
const EXIT_ON_STDIN_CLOSE = args.includes("--exit-on-stdin-close");

/* The remembered remote identities and the roster's answered state (server/remote-identity.mjs). */
const remoteIdentities = createRemoteIdentityStore({ file: typeof flag("remote-identity") === "string" ? flag("remote-identity") : null });
let rosterAnswered = false;  // a roster answer arrived under the current CLI (remembered-only groups then leave)
let rosterFailure = null;    // the roster read's failure while no answer has arrived
/* The views the open windows show (#1124), as main last posted them (POST /api/windows): each window's view id, or
   null for a window showing the switcher. null until main has posted: the roster read is then unfiltered. */
let windowViews = null;
let keptReadAt = new Map();  // the read time of each remote group a filtered answer kept (remote-roster.mjs `keptReadTimes`)
let rosterAnsweredAt = null; // the time of the last roster answer
/* ── Workspace views (#482) ──
   The deployments this server serves and the views over them are the shared home's
   (packages/client/panel-views.mjs): what the switcher lists, a view's panel, and which deployment a
   request is addressed to. They keep nothing. Every call takes what this process holds as `held()`,
   built here from its own variables (the registry, the snapshot, the remote roster's last answer, the
   remembered remote identities, the kernel record), and reads it without changing it. */
const held = () => ({
  ctxs, snapshot, remoteGroups, remembered: remoteIdentities, rosterAnswered, rosterFailure, keptReadAt, cli: cliState,
  observing, remoteCollecting: remoteRead !== null, home: homedir(), at: new Date().toISOString(),
});

/** Spawnable souls of a local v2 deployment: the kernel's spawn catalog
 * (`oats souls --json` — non-private souls of confirmed members, and external
 * souls, each with its declared work mode). Nothing is read from soul.yaml
 * here, and a soul outside the catalog is not offered for spawning. */
function agentsData(wsId) {
  const ws = deploymentFor(held(), wsId, DESKTOP_TERMS);
  if (ws?.remote) return { workspace: { id: ws.id, name: ws.name, server: ws.server }, agents: remote.remoteAgents(ws.group), observedAt: null, refreshing: false };
  const deployment = ws ? snapshot.byWs.get(ws.id)?.deployment : null;
  let agents = [], catalog = null;
  if (deployment?.status === "observed") {
    catalog = { reason: deployment.catalog?.reason ?? null, ambiguous: deployment.catalog?.ambiguous ?? [] };
    // One row per soul of the held catalog, sorted by name (packages/client/soul-rows.mjs).
    agents = soulRows(deployment, deployment.catalog?.souls);
  }
  // The souls read's own stamps (it runs apart from the roster reads): when the kernel observed
  // the remotes for this catalog, and whether a re-read is in flight. Both live on the snapshot
  // entry so this projection needs nothing but the snapshot.
  return { workspace: ws ? { id: ws.id, name: ws.name } : null, agents, ...(catalog ? { catalog } : {}),
    observedAt: deployment?.catalog?.observedAt ?? null, refreshing: deployment?.catalog?.refreshing === true };
}

/* ── Model catalog (spawn-modal dropdown) ──
   pi: the authenticated `pi --list-models` catalog — ids are
   "provider/model" exactly as `oats spawn --model` (and pi --model) accept
   them. claude: the claude CLI's model ALIASES plus the anthropic-provider
   ids from the pi catalog when pi is installed (claude accepts full
   claude-* model names). Advisory ONLY: the renderer keeps the field
   free-text (comma-separated preference lists stay valid) and the server
   never gates /api/spawn on catalog membership. Failures resolve to an
   empty list — a missing pi must not break the spawn modal.
   SECURITY (review 9b1e3ff): every cache miss executes a child process
   (pi, possibly a login shell), so this is a POST — POST /api/models
   { harness } → { harness, models: [{ id, label }] } — behind the server's
   Origin guard: a GET with its own Origin check is bypassable by <img>/
   no-cors requests that omit the header, letting a hostile page fan out
   child processes against the fixed loopback port. All concurrent misses
   COALESCE behind one in-flight catalog promise — at most one probe runs
   regardless of request fan-in. */
const CLAUDE_MODEL_ALIASES = ["opus", "sonnet", "haiku", "sonnet[1m]"];
const MODELS_TTL_MS = 60_000;
const modelsCache = new Map(); // harness → { at, models }
function execCapture(cmd, cmdArgs) {
  return new Promise((ok) => {
    execFile(cmd, cmdArgs, { encoding: "utf8", timeout: 10_000, shell: false, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => ok(err ? null : String(stdout)));
  });
}
/* OATSWEB_MODELPARSE_BEGIN — `pi --list-models` stdout → ["provider/model"]
   (header dropped). Extracted by test/desktop-server.test.mjs via block
   markers. */
function parsePiModelList(out) {
  const models = [];
  for (const line of String(out || "").split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2 || cols[0] === "provider") continue;
    models.push(`${cols[0]}/${cols[1]}`);
  }
  return models;
}
/* OATSWEB_MODELPARSE_END */
async function piModelCatalog() {
  // Direct PATH first; a GUI-launched Electron often lacks the login PATH,
  // so fall back to the user's login shell (same pattern as the CLI probe).
  let out = await execCapture("pi", ["--list-models"]);
  if (out === null) {
    const sh = process.env.SHELL || "/bin/sh";
    out = await execCapture(sh, ["-l", "-c", "pi --list-models"]);
  }
  return parsePiModelList(out);
}
// Coalesced probe: concurrent cache misses share ONE child-process run.
let piCatalogInflight = null;
function piModelCatalogOnce() {
  if (!piCatalogInflight) {
    piCatalogInflight = piModelCatalog().finally(() => { piCatalogInflight = null; });
  }
  return piCatalogInflight;
}
async function modelsData(harness) {
  const cached = modelsCache.get(harness);
  if (cached && Date.now() - cached.at < MODELS_TTL_MS) return cached.models;
  // Codex has its own configured providers; Pi's catalog is not authoritative.
  // The model field accepts an explicit id or an empty value for native defaults.
  if (harness === "codex") return [];
  const catalog = await piModelCatalogOnce();
  const models = harness === "pi"
    ? catalog.map((id) => ({ id, label: id }))
    : [
        ...CLAUDE_MODEL_ALIASES.map((id) => ({ id, label: `${id} (alias)` })),
        ...catalog.filter((id) => id.startsWith("anthropic/"))
          .map((id) => ({ id: id.slice("anthropic/".length), label: id.slice("anthropic/".length) })),
      ];
  modelsCache.set(harness, { at: Date.now(), models });
  return models;
}

/** Spawn an instance of an available agent through the discovered `oats` CLI
 * (Desktop CLI API v1) — the app never reimplements kernel spawn logic.
 * Default is NO TASK: the instance comes up awaiting instruction.
 * Validation errors THROW (→ 409); domain/CLI results RESOLVE with the
 * envelope so stable error codes reach the UI. */
/* OATSWEB_SPAWNERR_BEGIN — /api/spawn error shaping. Extracted by
   packages/desktop/test/panel-projection.test.mjs via block markers; the
   HTTP boundary itself is covered by test/desktop-cli-integration.test.mjs.
   Stable code for the degradation UI: cli-unavailable means "install or
   choose a compatible oats CLI", not "bad request". The 300-char cap guards
   against unbounded upstream text, but E_RELATIVE_AMBIGUOUS messages
   legitimately carry multiple absolute instance homes (case-d inherited
   edges) and the renderer surfaces them VERBATIM — any fixed cap can eat
   the actionable tail for deeply nested paths (reviews f1e3211, 835a05f).
   This code's message passes through UNSLICED: it originates from the CLI
   JSON envelope, which the adapter already bounds (maxBuffer 4 MiB — the
   real upstream bound), and the renderer assigns it via textContent. */
function spawnErrorPayload(e) {
  const status = e.code === "cli-unavailable" ? 503 : 409;
  const message = String(e.message || e);
  return {
    status,
    body: {
      error: e.code === "E_RELATIVE_AMBIGUOUS" ? message : message.slice(0, 300),
      ...(e.code ? { code: e.code } : {}),
      ...(e.code === "E_TEAM_CONFLICT" && Array.isArray(e.labels) ? { labels: e.labels } : {}),
      // A remote refusal's structured reason (server/capabilities.mjs); the renderer re-validates it.
      ...(e.reason ? { reason: e.reason } : {}),
    },
  };
}
/* OATSWEB_SPAWNERR_END */

/** Execution-server spawn only (`--server`). A local spawn is always the
 * preview-bound prepare → apply of packages/client/spawn-apply.mjs. */
async function spawnAgent({ agent, agentsRoot, task, purpose, name: instanceName, suggestName, relation, relativeTo, relativeRoot, harness, backend, model, yolo, background, launchConfig, serverId, wake }) {
  const name = String(agent || "");
  const root = resolve(String(agentsRoot || ""));
  const server = String(serverId);
  // agentsRoot must be one of the workspace roots this server was started for —
  // never spawn into an arbitrary caller-supplied directory.
  const known = deployments(held()).flatMap((w) => w.roots);
  const remoteSoul = remoteGroups.some((g) => g.server === server
    && remote.remoteAgents(g).some((a) => a.name === name && a.agentsRoot === agentsRoot));
  if (!remoteSoul && !known.some((r) => resolve(r) === root)) throw new Error(`unknown agents root "${agentsRoot}"`);
  // The agent is validated by the REMOTE kernel against its own workspace
  // (the same team repo on that host); the local roster only supplies the
  // name the operator picked.
  // Mutation boundary: a compatible installed CLI is required — degradation,
  // not a bundled kernel.
  if (!cliState.ok) {
    const err = new Error("spawning requires a compatible installed oats CLI — the desktop app does not bundle a kernel");
    err.code = "cli-unavailable";
    throw err;
  }
  // Local execution support is proven here for a local spawn; a remote spawn
  // is held to what the REMOTE advertises by the router (checkRemoteSupport),
  // and the local guard only needs the remote surface itself.
  locator.requireRemoteSupport(cliState, "spawn");
  // An exact name (--name, feature spawn-name) or a purpose, never both; the host's own spawn-name is the
  // route's check (E_REMOTE_INCOMPATIBLE), this computer's CLI must know the flag to forward it.
  if (instanceName !== undefined && typeof instanceName !== "string") throw Object.assign(new Error("Invalid name"), { code: "E_BAD_ARGS" });
  if (instanceName) {
    if (purpose !== undefined && purpose !== null && purpose !== "") throw Object.assign(new Error("A spawn takes a name or a purpose, not both"), { code: "E_BAD_ARGS" });
    if (!cliState.features?.includes("spawn-name")) throw Object.assign(new Error("Update OATS to give a spawn on another machine its exact name"), { code: "cli-no-spawn-name" });
  }
  // The host names it from its task (--suggest-name on an apply, feature spawn-apply-suggest-name): never beside a name or
  // a purpose, and only where this computer's CLI knows the flag; the host's own feature is the route's check
  // (E_REMOTE_INCOMPATIBLE), which the dialog reads first and never meets.
  if (suggestName !== undefined && typeof suggestName !== "boolean") throw Object.assign(new Error("Invalid suggestName"), { code: "E_BAD_ARGS" });
  if (suggestName) {
    if (instanceName || purpose !== undefined && purpose !== null && purpose !== "") throw Object.assign(new Error("A spawn named from its task takes no name or purpose"), { code: "E_BAD_ARGS" });
    if (!cliState.features?.includes(APPLY_SUGGEST_FEATURE)) throw Object.assign(new Error("Update OATS to have the other machine name the instance from its task"), { code: "cli-no-apply-suggest-name" });
  }
  // Run in background (#1579): this computer's CLI must know the flag to forward it; the host's own feature is the
  // route's check (E_REMOTE_INCOMPATIBLE), which the dialog reads first (it offers the switch only where the host lists it).
  if (background !== undefined) {
    if (typeof background !== "boolean") throw Object.assign(new Error("Invalid background"), { code: "E_BAD_ARGS" });
    if (!cliState.features?.includes("instance-background")) throw Object.assign(new Error("Update OATS to run an instance on another machine in the background"), { code: "cli-no-instance-background" });
  }
  if (launchConfig !== undefined) {
    if (!cliState.features?.includes("launch-config")) throw Object.assign(new Error("Update OATS to choose a launch configuration"), { code: "cli-no-launch-config" });
    locator.requireRemoteSupport(cliState, "launch-config");
  }
  if (wake !== undefined) {
    if (!cliState.features?.includes("schedule")) throw Object.assign(new Error("Update oats to configure recurring wake-ups"), { code: "cli-no-schedule" });
    locator.requireRemoteSupport(cliState, "schedule");
  }
  // Relation flags are a NEWER v1 surface: older v1 CLIs ignore unknown
  // spawn options and report success, silently creating an UNRELATED
  // instance. Fail closed instead of degrading silently (review f921f7d).
  const relErr = locator.relationSupportError(cliState, { relation, relativeTo });
  if (relErr) throw relErr;
  // Spawn-time relations: pass through to the CLI adapter, which owns the
  // argv allowlist and pair validation (relation ⇔ relativeTo) — invalid
  // values resolve as stable E_BAD_ARGS envelopes, never reach the CLI.
  const env = await adapter.cliSpawn(cliState.bin, {
    agent: name,
    workspaceDir: ctxs[0] ?? homedir(), // SSH routes choose their own remote cwd
    task: task ? String(task) : "",
    purpose: purpose ? String(purpose) : undefined,
    name: instanceName || undefined,
    ...(suggestName ? { suggestName: true } : {}),
    relation: relation ? String(relation) : undefined,
    relativeTo: relativeTo ? String(relativeTo) : undefined,
    // Anchor disambiguation: the renderer picker knows each instance's
    // agentsRoot; sending the pair makes related spawns unambiguous under
    // cross-root name shadowing (kernel E_RELATIVE_AMBIGUOUS otherwise).
    relativeRoot: relativeRoot ? String(relativeRoot) : undefined,
    // Harness/model overrides (spawn-modal options): adapter-allowlisted and
    // shape-validated there; empty means "agent definition default". The flag
    // is the local kernel's: its --server route translates for an older host.
    harness: harness ? String(harness) : undefined, harnessFlag: harnessFlag(cliState),
    backend: backend ? String(backend) : undefined,
    yolo,
    ...(background !== undefined ? { background } : {}),
    launchConfig,
    model: model ? String(model) : undefined,
    server,
    wake,
  });
  if (!env.ok) {
    const err = new Error(env.error.message || "spawn failed");
    err.code = env.error.code || "E_SPAWN_FAILED";
    throw err;
  }
  const r = env.result;
  if (r.server) void refreshRemoteSnapshot();
  const spawnedDeployment = remote.spawnedWorkspace(remoteGroups, r);
  // The renderer switches to the reply's workspace: the VIEW that holds the deployment, never a bare deployment id.
  const remoteWorkspaceId = spawnedDeployment ? viewFor(held(), spawnedDeployment, DESKTOP_TERMS)?.id ?? spawnedDeployment : undefined;
  // How the host named it (only with --suggest-name), re-validated as a preview's is.
  const naming = suggestName && Object.hasOwn(r, "naming") ? namingOf(r.naming) : null;
  return { instance: r.instance, agent: r.agent, home: r.home, work: r.work, ...(naming ? { naming } : {}),
    ...(r.wakeSchedule ? { wakeSchedule: r.wakeSchedule } : {}),
    ...(r.wakeScheduleError ? { wakeScheduleError: r.wakeScheduleError } : {}),
    ...(r.routeConflict ? { routeConflict: r.routeConflict } : {}),
           branch: r.branch ?? null, launched: !!r.launched, warnings: r.warnings || [],
           tmux: r.tmux ?? null, ...(r.server ? { server: r.server, target: r.target,
             ...(remoteWorkspaceId ? { workspaceId: remoteWorkspaceId } : {}) } : {}) };
}

/* ── CLI discovery (Desktop CLI API v1) ──
   The server is the privileged process that runs mutations, so it owns the
   probe. The user-chosen binary is only ever the one main's own file dialog
   wrote to the choice file (userData/oats-cli-choice.json), whose path main
   passes as --cli-choice; it is read at the start of every probe. No request
   names a binary. Re-probe runs at startup and on explicit /api/cli/reprobe
   (app focus, Retry, after Choose). */
let cliState = { ok: false, probedAt: 0, tried: [] };
// The revision every deployment read is admitted under: pending reads are revoked (E_DEPLOYMENT_STALE)
// when it moves, so it moves ONLY when the accepted CLI actually changed in a gate-relevant field
// (bin, version, features, API integers, remote support: packages/client/cli-probe-contract.mjs). A focus
// reprobe of the same binary is a no-op here: it neither cancels the observation in flight nor
// wipes the held catalogs, and cliState keeps its identity (the remote roster compares by it).
let cliProbeGeneration = 0;
let probeSequence = 0; // orders concurrent probes; a superseded probe's result is dropped
// The user-chosen binary, the top candidate of a probe: the choice file's `bin` (--cli-choice), read
// when each probe starts; without --cli-choice, an operator's own --oats-bin for a server started by hand.
const CLI_CHOICE_FILE = typeof flag("cli-choice") === "string" ? flag("cli-choice") : null;
const OPERATOR_BIN = typeof flag("oats-bin") === "string" ? flag("oats-bin") : null;
function readCliChoice() {
  if (!CLI_CHOICE_FILE) return OPERATOR_BIN;
  try {
    const raw = readFileSync(CLI_CHOICE_FILE, "utf8");
    if (raw.length > 65536) return null;
    const bin = JSON.parse(raw)?.bin;
    return typeof bin === "string" && bin.startsWith("/") ? bin : null;
  } catch { return null; }
}
let chosenBin = null;
// Where this server's PATH came from (the Electron main process resolves the
// login shell's PATH before starting it: login-path.mjs). The probe and every
// oats call inherit process.env.PATH; a standalone server reports "inherited".
const PATH_SOURCE = flag("path-source") === "login-shell" ? "login-shell" : "inherited";
const PATH_ERROR = typeof flag("path-error") === "string" ? flag("path-error") : null;
const cliIo = {
  persisted: () => chosenBin,
  env: process.env,
  testedVersion: MANIFEST.version,
  isExecutableFile: (p) => {
    try { const st = statSync(p); if (!st.isFile()) return false; accessSync(p, fsConstants.X_OK); return true; }
    catch { return false; }
  },
  canonicalize: (p) => realpathSync(p),
  // Slow sources — ASYNC (never block the serving event loop; review
  // 53a20c7) and evaluated lazily/at-most-once by the locator's source
  // ordering (they only run when every earlier candidate failed).
  npmGlobalBin: () => new Promise((ok) => {
    execFile("npm", ["prefix", "-g"], { encoding: "utf8", timeout: 5000, shell: false },
      (err, stdout) => ok(err ? null : (String(stdout).trim() ? join(String(stdout).trim(), "bin") : null)));
  }),
  loginShellWhich: () => new Promise((ok) => {
    const sh = process.env.SHELL || "/bin/sh";
    execFile(sh, ["-l", "-c", "command -v oats"], { encoding: "utf8", timeout: 5000, shell: false },
      (err, stdout) => { const out = String(stdout || "").trim(); ok(!err && out.startsWith("/") ? out : null); });
  }),
};
// Probe: REJECT on any execFile error — nonzero exit or timeout with
// plausible stdout must never yield the mutation binary (review 53a20c7).
const probeBin = (path) => new Promise((ok, bad) => {
  execFile(path, ["version", "--json"], { encoding: "utf8", timeout: 8000, shell: false, killSignal: "SIGKILL" },
    (err, stdout) => (err ? bad(err) : ok({ stdout })));
});
async function reprobeCli() {
  const sequence = ++probeSequence;
  chosenBin = readCliChoice();
  const r = await locator.discover(cliIo, probeBin);
  if (sequence !== probeSequence) return cliState;
  const first = !cliState.probedAt;
  if (!probeChanged(cliState, r)) {
    // Same CLI: refresh the diagnostics in place (the card reads `tried`), nothing downstream moves.
    Object.assign(cliState, { probedAt: Date.now(), tried: r.tried || [] });
    if (first) void refreshSnapshot({ live: true }); // the first verdict, even "none found", must be published
    return cliState;
  }
  cliProbeGeneration++;
  cliState = { ...r, probedAt: Date.now() };
  rosterAnswered = false; rosterFailure = null; // the roster belongs to the accepted CLI
  // Everything held was read with the previous CLI.
  inspectCache.clear(); capabilityCatalog.forgetAll(); capabilityShowCache.clear(); admitted.clear(); spawnPreview.cache.invalidate();
  void refreshSnapshot({ live: true }); // the deployment observation belongs to the accepted CLI
  void refreshRemoteSnapshot();
  return cliState;
}
/** Stable diagnostics for the degradation card. */
function cliStatus() {
  return {
    ok: !!cliState.ok,
    bin: cliState.bin || null,
    version: cliState.version || null,
    source: cliState.source || null,
    required: { desktopApi: locator.DESKTOP_API, range: locator.acceptRangeText(MANIFEST.version) },
    // Above the tested bound (oats-project/oats#1879): the CLI is accepted, and only the operations
    // packages/client/above-tested.mjs allows stay on. `testedThrough` is this Desktop's own bound, "X.Y".
    aboveTested: cliState.ok === true && cliState.aboveTested === true,
    testedThrough: locator.testedThroughText(locator.testedBound(MANIFEST.version)),
    // The recovery command the degradation card offers, DERIVED rather than
    // spelled: Desktop and the kernel publish in lockstep from one tag, so
    // this app's own version names the exactly-matching CLI — always inside
    // the accepted band and never below a feature floor. A hand-pinned
    // command rots (it sat at 0.18.2 through four releases, i.e. below the
    // 0.18.6 spawn-relations floor it was telling users to install).
    install: `npm install -g @awebai/oats@${MANIFEST.version}`,
    // Capability flag for the spawn form: relation UI renders DISABLED
    // (never hidden) with the required version when the accepted CLI
    // predates spawn-time relations.
    harnesses: cliState.harnesses || ["pi", "claude"],
    harnessesSource: Array.isArray(cliState.harnesses) ? "reported" : "assumed",
    sessionBackends: cliState.sessionBackends || ["tmux"],
    launchOptions: cliState.launchOptions || [],
    features: cliState.features || [],
    scheduleApi: cliState.scheduleApi || null,
    scheduleHistoryApi: cliState.scheduleHistoryApi === 3 ? 3 : null,
    lifecycleApi: cliState.lifecycleApi === 1 ? 1 : null,
    readinessApi: cliState.readinessApi === 2 ? 2 : null,
    automationsApi: cliState.automationsApi === 1 ? 1 : null,
    capabilityShowApi: cliState.capabilityShowApi === 1 ? 1 : null,
    // The inspector's gate (inspect on the workspace model); absent before, so
    // the Workspace inspector could never become available.
    operationsApi: cliState.operationsApi === 2 ? 2 : null,
    spawnPreviewApi: cliState.spawnPreviewApi === 2 ? 2 : null,
    spawnApplyApi: cliState.spawnApplyApi === 1 ? 1 : null,
    eventsApi: cliState.eventsApi === 2 ? 2 : null,
    workspaceApi: cliState.workspaceApi === 2 ? 2 : null,
    remote: cliState.remote || [],
    relations: !!cliState.ok && locator.supportsRelations(cliState.version),
    relationsMin: locator.RELATIONS_MIN.join("."),
    probedAt: cliState.probedAt || null,
    tried: cliState.tried || [],
  };
}
/** /api/cli as served: the probe status plus the PATH it ran with (and every
 * oats call runs with), its source, and why the login shell's PATH could not
 * be used when it was not; and the warm reader's state (packages/client/warm-reader.mjs
 * `status`), a diagnostic no page shows. */
const servedCliStatus = () => ({ ...cliStatus(), probePath: process.env.PATH || "", pathSource: PATH_SOURCE, pathError: PATH_ERROR, reader: warmReader.status() });

/* ── Kernel-observed roster snapshot ──
   Every local deployment fact is one bounded `oats status --json` plus one
   `oats workspace status --json` (deployment-observer.mjs). A kernel with feature
   status-liveness reports the complete local liveness reading in its status rows,
   which are kept as they are: no child, no terminal probe (deployment-panel.mjs
   `kernelLiveness`). For a kernel without it, terminal liveness for the
   kernel-reported targets is observed in a separate short-lived child
   (packages/client/liveness-main.mjs) so tmux latency cannot stall request handling.
   Local roster Git is null; only the on-demand K1 route observes Git.

   Observation reuse (kernel feature observe-max-age): a background cycle lets the kernel reuse
   remote-head observations up to BACKGROUND_MAX_AGE seconds old; the FIRST cycle of a deployment
   (admission), a mutation's follow-up and an explicit user refresh observe live (0). The adapters
   pass no flag at all to a kernel that does not declare the feature. */
let snapshot = { at: 0, byWs: new Map() };   // wsId -> { deployment, instances, generatedAt, observedAt } | remote panel
const BACKGROUND_MAX_AGE = 60;
// The collector's entry is in the shared home too, beside app.asar in the package.
const LIVENESS = join(HERE, "..", "..", "client", "liveness-main.mjs");
const soulCatalog = createSoulCatalog({ terms: DESKTOP_TERMS });
const capabilityCatalog = createCapabilityCatalog({ terms: DESKTOP_TERMS });
const inspectCache = createInspectCache();
// What a capability ships, per (deployment, row, commit[, file]): content at one commit never moves.
const capabilityShowCache = createCapabilityShowCache();
// The read side of /api/workspace-sync answers from the held capabilities table for an
// observed deployment (the current workspace status is its key); a re-read happens only
// when that key moves, at admission, or on refresh:true.
const workspaceSyncRequest = createWorkspaceSyncBoundary({ catalog: capabilityCatalog, maxAge: BACKGROUND_MAX_AGE,
  observed: (id) => { const d = snapshot.byWs.get(id)?.deployment; return d?.status === "observed" ? d.workspaceStatus : null; } });
// The Desktop's one lifecycle boundary: its plans, its kept answers and its one apply at a time are this backend's.
const lifecycleRequest = createLifecycleBoundary({ terms: DESKTOP_TERMS });
// The Desktop's one spawn preview (its two-slot budget and its settled answers) and its one apply broker,
// whose prepare reads through that preview's cache: both are this backend's.
const spawnPreview = createSpawnPreview();
const spawnApplyRequest = createSpawnApplyBoundary({ read: spawnPreview.prepareRead });
const admitted = new Set();  // deployments with at least one successful observation under the current CLI
// Deployments whose observation is in flight right now (/api/panel refreshing: `observing.has`), with how many
// reads of each: a cycle's and a post-spawn read may overlap (#1246 D2), and the deployment stays "refreshing"
// until the last one ends.
const observing = new Map();
const beginObserving = (id) => { observing.set(id, (observing.get(id) ?? 0) + 1); };
const endObserving = (id) => { const n = (observing.get(id) ?? 1) - 1; if (n > 0) observing.set(id, n); else observing.delete(id); };
// Only a registered local deployment, with the CURRENT accepted CLI. The
// probe generation is the revision: a real CLI change revokes pending reads.
const observerContext = (id) => ctxs.includes(id) ? { deployment: id, revision: cliProbeGeneration, cli: cliState } : null;
// The observers' reads (#1630, option C): a background read (--max-age > 0) is answered by one warm
// `oats reader --stdio` child of the accepted CLI where its probe lists the reader, and by the CLI read,
// unchanged, whenever it cannot be (packages/client/warm-reader.mjs). Live reads are the CLI's. This
// process holds the reader's stdin, its lifeline: the reader ends with this process, however it ends.
// A reader that reports the install changed sends the CLI back through discovery.
const warmReader = createWarmReader({ spawn, onStale: () => reprobeCli() });
const deploymentObserver = createDeploymentObserver({ getContext: observerContext, read: warmReader.read });
// Post-spawn reads (#1246 D2): a second observer, made by the same factory over the same context and reads, used
// only on demand, for the one deployment a created spawn changed (observeSpawned). It has no timer and no loop: the
// refresh loop stays the one read loop. It never joins a cycle's read, which started before the apply answered, and
// a busy cycle never refuses it: at most 2 targeted reads at once, beside the cycle's 2.
const spawnObserver = createDeploymentObserver({ getContext: observerContext, read: warmReader.read });
/** Run the liveness collector over its input (deployment-panel.mjs `livenessInput`) and answer what it
 * printed, or null when it failed, timed out or could not start (`livenessAnswers` reads either). No
 * rows start no child. */
function runLivenessCollector(input) {
  return new Promise((done) => {
    if (!input.length) return done(null);
    let child;
    try {
      // The collector is this executable as Node too: it gets the environment this process was
      // started with (the Node-mode flag is in it) and cleans its own. No other child gets it.
      child = execFile(process.execPath, [LIVENESS], { encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024, env: launchEnvironment },
        (err, stdout) => done(err ? null : stdout));
      child.stdin.on("error", () => { /* reported through the exit callback */ });
      child.stdin.end(JSON.stringify(input));
    } catch { done(null); }
  });
}
/** The /api/agents view of a souls-catalog entry: the last good catalog (or none), the latest
 * failure next to it, and its own stamps. `refreshing` is patched on the snapshot entry when a
 * pending read lands, so the projection needs nothing but the snapshot. */
function catalogProjection(entry, refreshing) {
  return { souls: entry?.souls ?? null, ambiguous: entry?.ambiguous ?? [], reason: entry?.reason ?? null,
    observedAt: entry?.observedAt ?? null, refreshing };
}
/** One deployment's panel entry. A transient busy/stale read keeps the last
 * observation; every other failure is shown as unavailable, with the kernel's
 * code/message or the missing feature's name, never as an empty roster.
 * The roster is published as soon as status and workspace status land: the souls catalog
 * is started alongside them on a cold cycle (soulCatalog.prefetch), bound to this cycle's
 * key when the workspace status is known (settle), and attached to the published entry
 * when it lands. The capabilities table follows the same cycle (prefetch, then ensure binds
 * it) and is re-read whenever its key moves, never on the request path. */
async function observeDeployment(id, { live = false, observer = deploymentObserver } = {}) {
  const previous = snapshot.byWs.get(id);
  // Before the first CLI probe settles there is no verdict to report.
  if (!cliState.probedAt) return pendingEntry(previous, new Date().toISOString());
  const cli = cliState, admission = !admitted.has(id);
  const maxAge = live || admission ? 0 : BACKGROUND_MAX_AGE;
  beginObserving(id);
  try {
    // Cold: souls and the capabilities table start WITH the roster reads (unbound), and are bound to
    // this cycle's key once the workspace status lands. Warm: nothing starts here.
    soulCatalog.prefetch(id, cli, { maxAge }); capabilityCatalog.prefetch(id, cli, { maxAge });
    const result = await observer.observe(id, { maxAge });
    // A busy or stale read keeps the entry held; an unreadable remote keeps the last observation, marked
    // with the failure; anything else is unavailable (packages/client/deployment-panel.mjs `failedEntry`).
    if (!result.ok) return failedEntry(previous, result.reason, new Date().toISOString());
    admitted.add(id);
    const { roster, workspaceStatus, observedAt } = result;
    const catalogKey = soulCatalogKey(cli, workspaceStatus);
    // Bind (or start) the souls read for this workspace state; never wait for it here. Age alone never
    // makes this cycle re-read: a catalog past HELD_TTL_MS is re-read when someone looks (/api/agents →
    // revalidateCatalog), so an idle app costs nothing and no deployment file is ever named to find out.
    const { entry: catalogEntry, pending } = soulCatalog.settle(id, cli, workspaceStatus, { maxAge });
    capabilityCatalog.ensure(id, cli, workspaceStatus, { maxAge });
    // The rows, the collector's input and its answers, and the projection are the shared home's
    // (packages/client/deployment-panel.mjs); running the collector is this process's. Under feature
    // status-liveness, decided on the probe record this cycle read with (`cli`), the kernel's rows are the
    // liveness reading: no collector child, no answers, each row's running/runtimeState/runtimeError/tmux
    // as the kernel reported them. Without it, the collector runs.
    const rows = rosterRows(roster, cli);
    const answers = kernelLiveness(cli) ? [] : livenessAnswers(rows, await runLivenessCollector(livenessInput(rows)));
    const instances = panelInstances(rows, answers);
    const entry = observedEntry({ roster, workspaceStatus, observedAt }, instances, new Date().toISOString());
    // The Desktop's own facts of the deployment: its held souls catalog and the key it was read under.
    Object.assign(entry.deployment, { catalog: catalogProjection(catalogEntry, !!pending), catalogKey });
    // Attach the catalog when it lands: to THIS cycle's entry (it may land before the entry is published —
    // publication still waits on the liveness child, when one runs, and on the other deployments) and to whatever entry is
    // published by then.
    if (pending) attachCatalog(id, pending, entry);
    return entry;
  } finally { endObserving(id); }
}
/** Put a landed souls catalog on the entries that were read under its key: `entry` (a cycle's, possibly not yet
 * published) and whatever is published for the deployment by then. Only an entry read under the same key takes
 * it (an unadopted flight lands under null and is re-read next cycle). */
function attachCatalog(id, pending, entry = null) {
  pending.then((landed) => {
    const projection = catalogProjection(landed, soulCatalog.refreshing(id));
    for (const target of [entry, snapshot.byWs.get(id)]) {
      if (target?.deployment?.status === "observed" && landed?.key === target.deployment.catalogKey) target.deployment.catalog = projection;
    }
  }).catch(() => { /* the entry keeps the last good catalog; the next cycle re-reads */ });
}
/** /api/agents found a held catalog past its TTL: answer from it (the caller projects it, with `refreshing`)
 * and start one re-read behind the answer, attached to the published entry when it lands. Request-driven on
 * purpose, and gated on window focus: the renderer's Spawn/Workspace view polls /api/agents every 8 s while
 * mounted, blurred or minimized included, so without the gate age would become a periodic `oats souls` run
 * again. Focused with that view open, the catalog is re-read about once per TTL + read; blurred, never. */
function revalidateCatalog(wsId) {
  if (!refreshLoop.focused()) return;
  const ws = deploymentFor(held(), wsId, DESKTOP_TERMS);
  const published = ws && !ws.remote ? snapshot.byWs.get(ws.id) : null, d = published?.deployment;
  if (d?.status !== "observed" || !cliState.ok) return;
  const pending = soulCatalog.revalidate(ws.id, cliState, d.workspaceStatus, { maxAge: BACKGROUND_MAX_AGE });
  if (!pending) return;
  d.catalog = { ...d.catalog, refreshing: true }; // this answer says a re-read is in flight
  attachCatalog(ws.id, pending);
}
/** The remote panels of the snapshot, in place: the `remote:` keys go and each group held gets its panel
 * (packages/client/remote-roster.mjs `remotePanelEntries`), made at the time of this merge. */
function mergeRemotePanels(byWs) {
  for (const id of byWs.keys()) if (id.startsWith("remote:")) byWs.delete(id);
  for (const [id, panel] of remote.remotePanelEntries(remoteGroups, new Date().toISOString(), keptReadAt)) byWs.set(id, panel);
  return byWs;
}
/** One outcome of the roster read into what this process holds. What it becomes is the shared home's
 * (remote-roster.mjs `remoteRosterState`); the groups of an answer go to the remembered identities. */
function takeRosterOutcome(outcome) {
  const at = new Date().toISOString();
  const next = remote.remoteRosterState({ remoteGroups, rosterAnswered, rosterFailure }, outcome, at);
  ({ remoteGroups, rosterAnswered, rosterFailure } = next);
  keptReadAt = remote.keptReadTimes(keptReadAt, next, rosterAnsweredAt);
  if (next.reported) rosterAnsweredAt = at;
  if (next.reported) remoteIdentities.observe(next.reported);
  mergeRemotePanels(snapshot.byWs);
}
/** What one roster read asks for (#1124): with a CLI that lists `roster-workspace-key`, the keys of the
 * workspaces the open windows show, read now from the window set main last posted and what is held
 * (panel-views.mjs `rosterWorkspaceKeys`), and how a held group's key is known for the merge
 * (remote-roster.mjs `lastKnownKey`); null for the unfiltered read. */
function rosterAsk(probe) {
  if (!probe.features?.includes("roster-workspace-key")) return null;
  const keys = rosterWorkspaceKeys(held(), windowViews, DESKTOP_TERMS);
  return keys?.length ? { keys, keyOf: (group) => remote.lastKnownKey(group, remoteIdentities) } : null;
}
/* OATSWEB_REMOTEREAD_BEGIN — the remote roster read, one at a time and joined, extracted by tests */
/** The roster read: one at a time, and a caller that asks while one runs joins it: the promise resolves once
 * an outcome read under the accepted kernel record is held. An answer read with a kernel record that is no
 * longer the accepted one is dropped and the read runs again, inside the same promise. */
function refreshRemoteSnapshot() {
  remoteRead ||= (async () => {
    let probe;
    do { probe = cliState; await readRemoteRoster(probe); } while (cliState !== probe);
  })().finally(() => { remoteRead = null; });
  return remoteRead;
}
/** A roster read that begins after this call (#1131: the read after a forget). A read in flight, whoever started
 * it (the loop, a Retry), began before the call: it is let finish, then one more runs, which a caller arriving
 * meanwhile shares. The refresh loop cannot promise this: its run joins a Retry's read in flight. */
let remoteReadAfter = null;
function refreshRemoteSnapshotAfter() {
  if (!remoteRead) return refreshRemoteSnapshot();
  remoteReadAfter ||= remoteRead.catch(() => {}).then(() => { remoteReadAfter = null; return refreshRemoteSnapshot(); });
  return remoteReadAfter;
}
async function readRemoteRoster(probe) {
  if (!cliReadsRemotes(probe)) { takeRosterOutcome({ gated: true }); return; }
  try {
    const asked = rosterAsk(probe); // the open windows' workspaces at this read, or null: unfiltered
    const envelope = await (asked ? adapter.cliRemoteRoster(probe.bin, { workspaceKeys: asked.keys }) : adapter.cliRemoteRoster(probe.bin));
    if (cliState !== probe) return;
    takeRosterOutcome(asked ? { envelope, asked } : { envelope });
  } catch (e) {
    if (cliState !== probe) return;
    takeRosterOutcome({ thrown: e.message });
  }
}
/* OATSWEB_REMOTEREAD_END */
/* OATSWEB_SPAWNREAD_BEGIN — the post-spawn observation (#1246 D2), extracted by tests */
/** Every observation is stamped with when it started; per deployment, the later start wins at publish (an older
 * cycle's entry never replaces a targeted read that started after it). */
let observationSeq = 0;
const observationStart = new WeakMap(); // entry -> its observation's start stamp
// A read that kept the held entry (busy, stale, no CLI verdict yet: deployment-panel.mjs `failedEntry`, `pendingEntry`)
// answers that same object, which is never this read's: it keeps the stamp of the read that made it, if any.
function observedFrom(started, entry, held) {
  if (entry && typeof entry === "object" && entry !== held && !observationStart.has(entry)) observationStart.set(entry, started);
  return entry;
}
/** One deployment's read (observeDeployment), stamped when it starts: `started`, and its panel entry, stamped
 * with it unless the read kept the held entry. `observer` is the cycle's (deploymentObserver) or the post-spawn
 * one (spawnObserver). */
function observeStamped(id, options) {
  const started = ++observationSeq, held = snapshot.byWs.get(id);
  return { started, entry: observeDeployment(id, options).then((entry) => observedFrom(started, entry, held)) };
}
const stampOf = (entry) => (entry && observationStart.get(entry)) ?? 0;
const newerThan = (entry, other) => !other || stampOf(entry) > stampOf(other);
/** A successful observation: observed, and not a kept failure (whose `error` is a string). */
const succeeded = (entry) => entry?.deployment?.status === "observed" && typeof entry.error !== "string";
/** Publish a targeted read that started at `started`: only a successful observation of its own (never the held
 * entry a busy read answers), only when it started after the one published. A failed read publishes nothing; the
 * next cycle publishes as it always did. Answers whether the snapshot now holds a successful observation that
 * started no earlier than this read: this one, or a newer one already published (a newer failure is not one). */
function publishSpawned(id, entry, started) {
  if (!succeeded(entry) || stampOf(entry) !== started) return false;
  if (newerThan(entry, snapshot.byWs.get(id))) snapshot.byWs.set(id, entry);
  const published = snapshot.byWs.get(id);
  return succeeded(published) && stampOf(published) >= started;
}
/** A cycle's entries, as it publishes them: a deployment whose published entry started after this cycle's read of
 * it (a post-spawn read) keeps that entry. */
const cycleEntries = (entries) => new Map(entries.map(([id, entry]) => {
  const published = snapshot.byWs.get(id);
  return [id, newerThan(entry, published) ? entry : published];
}));
/** Observe one deployment now, through the post-spawn observer, and publish it when it lands. Per deployment one
 * read runs and at most one waits: a request while one runs queues one read that starts after it (never joining a
 * read that started earlier); a further request rides on the queued one, which starts after it too. Resolves once
 * the read this request waits for has landed, with whether it published (publishSpawned); never rejects. */
const spawnReads = new Map(); // deployment -> { running, queued }
function observeSpawned(id) {
  const held = spawnReads.get(id);
  if (held?.queued) return held.queued;
  const start = () => {
    const { started, entry } = observeStamped(id, { live: true, observer: spawnObserver });
    const running = entry
      .then((landed) => publishSpawned(id, landed, started), () => false /* a failed read publishes nothing */)
      .finally(() => { const slot = spawnReads.get(id); if (slot?.running === running && !slot.queued) spawnReads.delete(id); });
    return running;
  };
  if (!held) { const running = start(); spawnReads.set(id, { running, queued: null }); return running; }
  held.queued = held.running.then(() => { const running = start(); Object.assign(held, { running, queued: null }); return running; });
  return held.queued;
}
/** A created spawn's answer waits until the targeted read of its deployment has published: at most
 * CREATED_OBSERVE_WITHIN_MS, and never past ANSWER_WITHIN_MS since the request arrived (`arrivedAt`, on `now`'s
 * clock). A read that lands without publishing (failed, unavailable, busy, a kept failure) ends nothing: the answer
 * goes at the bound, and the next cycle publishes as it always did. */
const CREATED_OBSERVE_WITHIN_MS = 5000;
const CREATED_STATUSES = ["complete", "partial", "incomplete"];
async function awaitSpawned(id, arrivedAt, now = () => performance.now()) {
  const left = Math.min(CREATED_OBSERVE_WITHIN_MS, ANSWER_WITHIN_MS - (now() - arrivedAt));
  const read = observeSpawned(id); // at once, whatever the wait
  if (left <= 0) return;
  let timer;
  await new Promise((resolve) => {
    timer = setTimeout(resolve, left);
    read.then((published) => { if (published) resolve(); });
  });
  clearTimeout(timer);
}
/* OATSWEB_SPAWNREAD_END */
/** One observation cycle over every registered deployment; the refresh loop owns when it runs. */
async function observeAll({ live = false } = {}) {
  try {
    // At most as many deployments at once as the observer admits, so every one is read each cycle (#461).
    const entries = await mapBounded(ctxs, MAX_DEPLOYMENT_OBSERVATIONS, async (id) => [id, await observeStamped(id, { live }).entry]);
    const byWs = cycleEntries(entries);
    for (const [id, panel] of snapshot.byWs) if (id.startsWith("remote:")) byWs.set(id, panel);
    snapshot = { at: Date.now(), byWs: mergeRemotePanels(byWs) };
  } catch (e) { if (DEBUG) console.log(`[snapshot] refresh failed: ${e.message}`); }
}
// Cadence: the next cycle starts a fixed interval AFTER the previous one completed (a slow
// kernel is never asked twice at once), 5 s while a window is focused, 30 s while every window
// is blurred or hidden (/api/window-state); focus returning runs one prompt cycle. A cycle
// requested during a cycle (a mutation's result must be observed) runs exactly once right after.
const refreshLoop = createRefreshLoop({ run: observeAll, focusedMs: REFRESH_FOCUSED_MS, blurredMs: REFRESH_BLURRED_MS });
// The remote roster (`server roster`, one bounded CLI read) follows the same shape: 10 s focused, the same 30 s blurred.
const remoteLoop = createRefreshLoop({ run: () => refreshRemoteSnapshot(), focusedMs: 10_000, blurredMs: REFRESH_BLURRED_MS });
/* A workspace's own machines (#517): Where to run, the Setup tab's Machines, Add a machine. */
const machines = createMachines({ adapter, cli: () => cliState });
/* Forget a remote instance its host no longer lists (#1131): one `server forget` per pressed row at a time, and only
 * for a row the held roster shows gone (#1170). */
const serverForget = createServerForget({ adapter, cli: () => cliState, held: () => remoteGroups });
/** Observe now (or right after the cycle in flight); `live` makes the kernel observe the remotes afresh. */
function refreshSnapshot(options = {}) { return refreshLoop.request(options); }
/** A mutation this backend performed for a workspace: what inspect reported may have changed, and the
 * roster must observe the result live. Inspections are held under the workspace's SCOPE (the deployment
 * directory the kernel was pointed at), which is the id for a local deployment but not for a remote one. */
function observeMutation(wsId) {
  const scope = deployments(held()).find((w) => w.id === wsId)?.scope;
  if (scope) inspectCache.invalidate(scope);
  // The dialog's held spawn previews are keyed by workspace id, not scope.
  if (wsId) spawnPreview.cache.invalidate(wsId);
  return refreshSnapshot({ live: true });
}
/* OATSWEB_FINDINST_BEGIN — workspace-scoped instance lookup, extracted by tests */
function findInstance(name, wsId, home, server) {
  // Snapshot-only: an unobserved deployment has no instances to act on.
  // With a ws scope, resolve ONLY in that workspace — same-named instances
  // exist across workspaces and "first match anywhere" picks the wrong one.
  // Same-named instances also exist across roots WITHIN one workspace, so
  // "first match in the workspace" is equally wrong for a privileged route:
  // an exact `home` qualifier resolves precisely; a bare name that matches
  // MORE THAN ONE instance in scope returns the AMBIGUOUS sentinel and the
  // route must refuse rather than act on an arbitrary pick (merged-state
  // review @7dd1e7b).
  let scope = wsId
    ? (snapshot.byWs.get(wsId)?.instances || [])
    : [...snapshot.byWs.values()].flatMap((d) => d.instances);
  // Per-instance HTTP references always name a host; absent means local.
  scope = scope.filter((i) => (i.server || "") === (server || ""));
  if (home) return scope.find((i) => i.instance === name && i.home === home);
  const hits = scope.filter((i) => i.instance === name);
  if (hits.length > 1) return findInstance.AMBIGUOUS;
  return hits[0];
}
findInstance.AMBIGUOUS = Symbol("ambiguous-instance");
/** Route helper: resolve or produce the 404/409 payload for send(). */
function resolveInstanceOr(name, wsId, home, server) {
  const inst = findInstance(name, wsId, home, server);
  if (inst === findInstance.AMBIGUOUS)
    return { error: { status: 409, body: { error: `instance name "${name}" is ambiguous in this workspace — pass the exact home qualifier`, code: "E_INSTANCE_AMBIGUOUS" } } };
  if (!inst) return { error: { status: 404, body: { error: `unknown instance "${name}"` } } };
  return { inst };
}
/* OATSWEB_FINDINST_END */

/* OATSWEB_VERIFIEDLOCALHOME_BEGIN — local-home containment, extracted by tests.
   A local start or restart launches in the instance home it names. That home
   must be DERIVED and VERIFIED, never trusted from roster data alone: it must
   be the exact home the kernel's current status reported for this instance in
   a registered local deployment, canonicalize to <...>/instances/<name>, and
   stay inside that deployment's canonical directory. No layout is named.
   Returns the canonical home, or null (a remote row has no local home). */
function verifiedLocalHome(inst) {
  // The rule is the shared home's (session-start.mjs verifiedLocalHome); this server gives it the deployments
  // it holds, with the rows each one's kernel reported, and the file system's realpath.
  return localHomeIn(inst, deployments(held()).map((w) => ({ id: w.id, remote: !!w.remote, instances: snapshot.byWs.get(w.id)?.instances || [] })), realpathSync);
}
/* OATSWEB_VERIFIEDLOCALHOME_END */

/* OATSWEB_TMUXTGT_BEGIN — exact-match anchored tmux target, extracted by
   tests. tmux -t targets are PREFIX-matched by default: in the 3s
   stale-snapshot window an exited window (reviewer-1) can prefix-match a
   similarly named live one (reviewer-15…), exposing its pane to capture or
   — worse — sending it keystrokes/Ctrl-C. `=` anchors each component to an
   exact match, so tmux errors out instead of silently prefix-matching (same
   pattern as packages/desktop/tmux-target.mjs on the attach path). */
function tmuxTarget(inst) {
  const s = String(inst?.tmux?.session ?? "");
  const w = String(inst?.tmux?.window ?? "");
  // conservative charset; ':' is the separator and '=' the anchor — both
  // forbidden inside components so a crafted name cannot re-shape the target
  if (!/^[\w@%.-]+$/.test(s) || !/^[\w@%.-]+$/.test(w)) throw new Error("invalid tmux target");
  return `=${s}:=${w}`;
}
/* OATSWEB_TMUXTGT_END */

// ---- Agent brain: soul + instance artifacts as absolute paths ----
// The desktop brain view renders this map; file CONTENT is fetched separately
// through /api/file (path-guarded there). The soul and its instances are the
// ones the kernel's current `oats status --json` reported for this workspace —
// never a caller-supplied path, soul.yaml lookup or manifest walk. Skill and
// knowledge files are content for viewing, read with per-file containment.
/** Display metadata of a SKILL.md: only the `name:`/`description:` scalars of
 * its frontmatter. Content presentation, not deployment configuration. */
function skillFrontmatter(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const meta = {};
  for (const line of m ? m[1].split(/\r?\n/) : []) {
    const f = line.match(/^(name|description):\s*(.*?)\s*$/);
    if (f) meta[f[1]] = f[2].replace(/^["']|["']$/g, "");
  }
  return meta;
}
/** The canonical path of `path` when it stays inside the canonical `parent`;
 * null otherwise (absent, or a symlink escaping the deployment). */
function canonicalInside(path, parent) {
  try {
    const real = realpathSync(path), base = realpathSync(parent);
    return real === base || real.startsWith(base.endsWith(sep) ? base : base + sep) ? real : null;
  } catch { return null; }
}
function containedIn(base) {
  let real;
  try { real = realpathSync(base); } catch { return () => false; }
  return (file) => { try { const target = realpathSync(file); return target === real || target.startsWith(real + sep); } catch { return false; } };
}
function listSkills(dir, contained) {
  // skills live as <dir>/<skill>/SKILL.md with `name`/`description` frontmatter
  const skills = [];
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const s = skillEntry(join(dir, e.name), contained);
      if (s) skills.push(s);
    }
  } catch { /* no skills dir */ }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
function skillEntry(skillDir, contained) {
  const p = join(skillDir, "SKILL.md");
  if (!existsSync(p)) return null;
  // A nested SKILL.md symlink can escape its owning tree even when the tree
  // dir itself is contained — reject per file.
  if (contained && !contained(p)) return null;
  let meta = {};
  try { if (!sameFile(statSync(p), TOKEN_FILE)) meta = skillFrontmatter(readFileSync(p, "utf8")); } catch { /* unreadable skill */ }
  return { name: meta.name || basename(skillDir), path: p, description: String(meta.description || "").trim() };
}
function mdTree(dir) {
  // all markdown files of a knowledge bundle, depth-first, absolute paths
  const out = [];
  const walk = (d, depth) => {
    if (depth > 6) return; // bundles are shallow; guard against cycles
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}
const mdIf = (p) => (existsSync(p) ? p : null);
function brainData(agentName, wsId) {
  const ws = deploymentFor(held(), wsId, DESKTOP_TERMS);
  const observed = ws && !ws.remote ? snapshot.byWs.get(ws.id) : null;
  if (observed?.deployment?.status !== "observed") return null;
  const root = observed.deployment.root;
  const def = observed.deployment.souls.find((s) => s.name === agentName);
  // The soul directory must canonically belong to this deployment.
  if (!def?.dir || !canonicalInside(def.dir, ws.id)) return null;
  const soulDir = join(def.dir, "soul");
  /* OATSWEB_BRAINSKILLS_BEGIN — skill-path expansion, extracted by tests */
  const expandSkillPath = (p, exists, list, entry) =>
    // a path is either a leaf skill dir (contains SKILL.md) or a parent tree
    // of skill dirs (a materialized module's `.agents/skills/<module>/`).
    exists(join(p, "SKILL.md")) ? [entry(p)].filter(Boolean) : list(p);
  const mergeSkills = (...groups) => {
    const byName = new Map();
    for (const g of groups) for (const s of g) if (!byName.has(s.name)) byName.set(s.name, s);
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  };
  /* OATSWEB_BRAINSKILLS_END */
  // Soul content is workspace-member content: every file must stay inside the
  // kernel-reported soul directory (a per-commit copy behind the soul pointer).
  const soulContained = containedIn(def.dir);
  const soulSkills = mergeSkills(listSkills(join(soulDir, "skills"), soulContained));
  const knowledgeDir = join(soulDir, "knowledge");
  // Instances are exactly the kernel-reported rows of this soul and root.
  const rows = (observed.instances || []).filter((i) => !i.server && i.agent === def.name && i.agentsRoot === root
    && canonicalInside(i.home, ws.id))
    .sort((a, b) => String(a.instance).localeCompare(String(b.instance)));
  const instances = rows.map((live) => {
    const home = live.home;
    const homeContained = containedIn(home);
    const skillsDir = join(home, ".agents", "skills");
    let entries = [];
    try { entries = readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { /* none */ }
    const skills = mergeSkills(entries.flatMap((e) => expandSkillPath(join(skillsDir, e.name), existsSync,
      (d) => listSkills(d, homeContained), (d) => skillEntry(d, homeContained))));
    const notesDir = join(home, "notes");
    return {
      instance: live.instance, home, running: live.running === true,
      agentsMd: mdIf(join(home, "AGENTS.md")),
      skills,
      state: mdIf(join(home, "STATE.md")),
      task: mdIf(join(home, "TASK.md")),
      notes: existsSync(notesDir) ? mdTree(notesDir) : [],
    };
  });
  return {
    agent: def.name, description: def.description || "", agentsRoot: root,
    soul: {
      agentsMd: mdIf(join(soulDir, "AGENTS.md")),
      skills: soulSkills,
      knowledge: {
        index: mdIf(join(knowledgeDir, "index.md")),
        tree: existsSync(knowledgeDir) ? mdTree(knowledgeDir) : [],
      },
    },
    instances,
  };
}

// ---- File serving (markdown/brain viewers) ----

/* OATSWEB_FILEGUARD_BEGIN — path-traversal guard for /api/file, extracted by
   tests. A requested path is readable ONLY if its realpath (symlinks resolved)
   sits under one of the allowed roots. CONTRACT: allowedRoots are
   PRE-CANONICALIZED strings captured at admission time — the guard must
   NEVER re-resolve them (review 9db1e81: re-running realpathSync on a root
   at use time re-opened the admission-to-use TOCTOU — a dir→symlink swap
   between fileRoots() and this check made root and request resolve into the
   same outside target). Only the REQUESTED path is canonicalized here; `..`
   segments, sneaky prefixes (/root-evil vs /root) and request-side symlink
   escapes all fail closed against the immutable root strings. */
function underRoot(realPath, realRoot) {
  return realPath === realRoot || realPath.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
}
function resolveGuardedFile(requested, allowedRoots) {
  if (typeof requested !== "string" || !requested.startsWith("/")) return { error: "path must be absolute", code: 400 };
  let real;
  try { real = realpathSync(resolve(requested)); } catch { return { error: "no such file", code: 404 }; }
  if (!allowedRoots.some((root) => underRoot(real, root))) return { error: "path outside allowed roots", code: 403 };
  return { real };
}
/* OATSWEB_FILEGUARD_END */

const MARKDOWN_EXT = new Set([".md", ".markdown", ".mdown", ".mkd"]);
const FILE_MAX_BYTES = 2 * 1024 * 1024;

/** Allowed roots for /api/file: every agents root of every workspace (agent
 * homes — souls, instances, knowledge) plus the known instances' work trees
 * and repos (the brain/markdown viewers open files there too).
 * EVERY returned root is canonicalized HERE, exactly once — the guard
 * compares against these immutable strings without re-resolving (see the
 * FILEGUARD contract above): a dir→symlink swap after this admission
 * changes nothing the guard consults. */
function fileRoots() {
  const roots = [];
  const admit = (p) => { try { roots.push(realpathSync(p)); } catch { /* absent — skip */ } };
  for (const w of deployments(held())) for (const r of w.roots) admit(r);
  // Every soul directory the kernel reported for an observed local deployment
  // (its souls/knowledge/instances are viewable), admitted only when its
  // canonical path stays inside the canonical deployment: a symlinked soul
  // directory must not widen the file roots. Canonicalized once here.
  for (const [id, d] of snapshot.byWs) {
    if (d.deployment?.status !== "observed") continue;
    for (const soul of d.deployment.souls) {
      const real = canonicalInside(soul.dir, id);
      if (real) roots.push(real);
    }
  }
  for (const [id, d] of snapshot.byWs) {
    for (const i of d.instances) {
      if (i.server) continue; // Remote paths never grant access to local files.
      // The home itself must canonicalize inside its deployment; its work tree
      // and repo are operator checkouts that legitimately live elsewhere.
      const home = i.home ? canonicalInside(i.home, id) : null;
      if (home) { roots.push(home); admit(join(i.home, "work")); } // <home>/work = the work tree (i.work is the MODE)
      if (i.repo) admit(i.repo);
    }
  }
  return roots;
}

function fileData(requested) {
  const g = resolveGuardedFile(requested, fileRoots());
  if (g.error) return g;
  const st = statSync(g.real);
  if (sameFile(st, TOKEN_FILE)) return { error: "forbidden", code: 403 };
  if (!st.isFile()) return { error: "not a regular file", code: 400 };
  if (st.size > FILE_MAX_BYTES) return { error: `file too large (${st.size} bytes)`, code: 413 };
  const buf = readFileSync(g.real);
  if (buf.includes(0)) return { error: "binary file", code: 415 };
  return {
    body: {
      path: g.real, name: basename(g.real), size: st.size, mtime: st.mtime.toISOString(),
      markdown: MARKDOWN_EXT.has(extname(g.real).toLowerCase()),
      content: buf.toString("utf8"),
    },
  };
}

// ---- HTTP ----
const send = (res, code, body, type = "application/json") => {
  let data = type === "application/json" ? JSON.stringify(body) : body;
  // No reply carries the credential, whatever route built it: a file, a skill or a Git diff that
  // holds the --token-file's content (a copy or a hard link included) is refused with no content.
  if (carriesSecret(data, CREDENTIAL)) { code = 403; type = "application/json"; data = JSON.stringify(CREDENTIAL_IN_REPLY); }
  res.writeHead(code, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
  res.end(data);
};
const readBody = (req) => new Promise((ok) => {
  let b = ""; req.on("data", (c) => { b += c; if (b.length > 65536) req.destroy(); });
  req.on("end", () => { try { ok(JSON.parse(b || "{}")); } catch { ok({}); } });
});

// New read commands cannot turn malformed JSON into an empty valid request.
// Keep the legacy parser for the other existing request families.
const readStrictBody = (req, limit = 65536, measured = false) => new Promise((ok, reject) => {
  const bad = () => reject(Object.assign(new Error(`Expected a JSON object body up to ${limit} bytes`), { code: "E_BAD_ARGS" }));
  const chunks = []; let size = 0;
  req.on("data", c => {
    size += Buffer.byteLength(c);
    if (size > limit) { chunks.length = 0; bad(); }
    else chunks.push(Buffer.from(c));
  });
  req.on("end", () => {
    if (size > limit) return;
    try {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = JSON.parse(raw.trim() ? raw : "{}");
      if (!body || typeof body !== "object" || Array.isArray(body)) return bad();
      ok(measured ? { body, bytes: size } : body);
    } catch { bad(); }
  });
  req.on("error", bad);
  req.on("aborted", bad);
});

/* Above the tested bound (oats-project/oats#1879; packages/client/above-tested.mjs). Every POST handler
   below asks `heldBack(...)` with its (route, action) once its body is read and before it runs anything: an
   operation the allowlist does not name is answered with the notice sentence, and no CLI process starts.
   One answer for every route: 409, { status: "refused", code, error, reason: { code, message }, release }.
   Before any of them, a POST to a route the table does not name is refused the same way (`unclassifiedRoute`),
   so a handler added without a classification is held back too.
   test/above-tested-inventory.test.mjs holds every POST route here to a class there. */
const heldBack = (route, action) => aboveTestedRefusal(cliState, postOperation(route, action));
const unclassifiedRoute = (path) => (postRouteClassified(path) ? null : aboveTestedRefusal(cliState, "POST ?"));
const refuseHeld = (res, refusal) => send(res, 409, { status: "refused", code: refusal.code, error: refusal.message,
  reason: { code: refusal.code, message: refusal.message }, ...(refusal.release ? { release: refusal.release } : {}) });

const server = createServer(async (req, res) => {
  // Host guard: EVERY request must carry a loopback Host.
  const host = String(req.headers.host || "").replace(/:\d+$/, "");
  const okHost = (h) => h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1";
  if (!okHost(host)) return send(res, 403, { error: "forbidden origin" });
  // The credential: every request, any method and any path, carries exactly `Bearer <secret>`
  // (server/request-checks.mjs), checked before the target is parsed and before the body is read.
  // No route is exempt.
  if (!bearerMatches(req.headers.authorization, BEARER)) return send(res, 401, UNAUTHORIZED);
  try {
    let url;
    try { url = new URL(req.url, "http://localhost"); } catch { return send(res, 400, { error: "malformed request target", code: "E_BAD_ARGS" }); }
    const path = url.pathname;
    // Origin guard: mutating requests must also come from a loopback origin.
    if (req.method === "POST") {
      let originOk = true;
      if (req.headers.origin !== undefined) {
        // "Origin: null" (sandboxed pages) and malformed origins must 403, not throw.
        try { originOk = okHost(new URL(String(req.headers.origin)).hostname); } catch { originOk = false; }
      }
      if (!originOk) return send(res, 403, { error: "forbidden origin" });
    }
    if (req.method === "POST") { const refused = unclassifiedRoute(path); if (refused) return refuseHeld(res, refused); }
    if (req.method === "GET" && path === "/api/version") {
      return send(res, 200, { capability: MANIFEST.capability, version: MANIFEST.version });
    }
    if (req.method === "GET" && (path === "/api/panel" || path === "/api/agents")) {
      const asked = url.searchParams.get("ws") || undefined;
      // An explicit workspace this server does not serve (a path, an id, a remote it no longer has) is
      // refused, never answered with another workspace's data. No ?ws= still means the first workspace.
      // A view id or a deployment id (a deployment answers with its view: a selection saved before views opens it).
      if (asked && !isServed(held(), asked, DESKTOP_TERMS)) return send(res, 404, workspaceNotServed(asked));
      // Served from the latest kernel observation; never waits on a CLI read.
      if (path === "/api/panel") return send(res, 200, panelData(held(), asked, DESKTOP_TERMS));
      revalidateCatalog(asked);
      return send(res, 200, agentsData(asked));
    }
    if (path === "/api/launch-configs" && req.method === "POST") {
      const asked = url.searchParams.get("ws");
      try {
        const request = await readBody(req);
        const refused = heldBack(path, request?.action);
        if (refused) return refuseHeld(res, refused);
        const workspace = surfaceDeployment(held(), asked, request, DESKTOP_TERMS);
        const result = await launchConfigRequest(request, {
          workspace, cli: cliState, localCwd: ctxs[0] ?? homedir(),
          agents: workspace ? agentsData(workspace.id).agents : [],
          instances: workspace ? deploymentRows(held(), workspace) : [],
        }).finally(() => { if (workspace && ['set', 'remove'].includes(request?.action)) spawnPreview.cache.invalidate(workspace.id); }); // the default launch a preview reports
        return send(res, 200, result);
      } catch (e) {
        const { status, body } = spawnErrorPayload(e);
        // One code's message is not cut at 300: the Start dialog quotes it as a line under its own sentence.
        // It is answered as that line, the shared filter over OATS's own message as it came (display-text.mjs
        // displayLine: withheld whole, or folded and bounded), and empty when OATS gave none, never the
        // stand-in a refusal without a message is given. #1026 lifts the cut for every refusal and removes
        // this exception.
        if (e.code !== "E_LAUNCH_CONFIG_AMBIGUOUS") return send(res, status, body);
        return send(res, status, { ...body, error: displayLine(e.kernelMessage) ?? "" });
      }
    }
    if (["/api/forge-connections", "/api/instance-forge", "/api/forge-roster", "/api/instance-review-threads"].includes(path) && req.method === "POST") {
      try {
        const epoch = req.headers[FORGE_EPOCH_HEADER] ?? "standalone:0";
        if (!validForgeEpoch(epoch)) throw new Error("bad epoch");
        const request = await readStrictBody(req);
        const refused = heldBack(path, path === "/api/instance-review-threads" ? request?.action : undefined);
        if (refused) return refuseHeld(res, refused);
        if (path === "/api/forge-connections") {
          if (url.search) throw new Error("unexpected query");
          return send(res, 200, await forgeBoundary.connections(request, epoch));
        }
        if (url.searchParams.getAll("ws").length !== 1 || !url.searchParams.get("ws") || [...url.searchParams.keys()].some(k => k !== "ws")) throw new Error("bad workspace query");
        const getContext = () => {
          const workspace = deployments(held()).find(w => w.id === url.searchParams.get("ws"));
          const observed = workspace ? snapshot.byWs.get(workspace.id) : null;
          // clones[]: the kernel's member keys and this computer's clone paths (#217), for the roster.
          return { workspace, cli: cliState, instances: observed?.instances || [], clones: observed?.deployment?.workspaceStatus?.clones || [] };
        };
        // The pull-request roster is the VIEW's: every local deployment's rows (keyed by home) and clones.
        // A view with no local deployment is remote, as a remote deployment was before views.
        if (path === "/api/forge-roster") return send(res, 200, await forgeBoundary.roster(request, () => viewForgeContext(held(), url.searchParams.get("ws"), DESKTOP_TERMS), epoch));
        if (path === "/api/instance-review-threads") {
          // The paste goes to the instance's agent pane, as the kernel answers it, in its own anchored tmux
          // window in THIS workspace, looked up fresh.
          const find = (target) => (getContext().instances || []).find((i) => i.home === target.home && i.instance === target.instance) || null;
          const inspect = (inst) => (cliState.ok ? adapter.cliSessionInspect(cliState.bin, { home: inst?.home }) : Promise.resolve(null));
          return send(res, 200, await forgeBoundary.reviewThreads(request, getContext, epoch, createReviewPaste({ find, tmuxTarget, inspect })));
        }
        return send(res, 200, await forgeBoundary.pull(request, getContext, epoch));
      } catch {
        return send(res, 400, { forgeApi: 1, status: "unavailable", data: null,
          reason: { code: "E_BAD_ARGS", message: "Invalid forge request." } });
      }
    }
    if (path === '/api/instance-events' && req.method === 'POST') {
      try {
        if (url.searchParams.getAll('ws').length !== 1 || !url.searchParams.get('ws') || [...url.searchParams.keys()].some(k => k !== 'ws')) throw new Error('bad query');
        const request = await readStrictBody(req, 16384);
        const refused = heldBack(path, request?.action);
        if (refused) return refuseHeld(res, refused);
        const getContext = () => {
          const workspace = deployments(held()).find(w => w.id === url.searchParams.get('ws'));
          return { workspace, cli: cliState, epoch: cliProbeGeneration, localCwd: ctxs[0] ?? homedir(),
            instances: workspace ? snapshot.byWs.get(workspace.id)?.instances || [] : [] };
        };
        return send(res, 200, await instanceEventsRequest(request, getContext));
      } catch { return send(res, 400, eventsFailure('E_BAD_ARGS')); }
    }
    if (path === '/api/workspace-spawn-preview' && req.method === 'POST') {
      try {
        if (url.searchParams.getAll('ws').length !== 1 || !url.searchParams.get('ws') || [...url.searchParams.keys()].some(k => k !== 'ws')) throw new Error('bad query');
        // A preview's body is at most 16 KiB. A suggest read (feature spawn-suggest-name, awebai/oats#1421 §3) also
        // carries the task, at most 32 KiB as at apply, so its body may take the apply's 64 KiB.
        const { body: request, bytes } = await readStrictBody(req, 65536, true);
        // A suggest-name read (feature instance-suggest-name, awebai/oats#1490 §2) carries the task as well.
        const suggest = request.action === 'suggest' || request.action === 'suggest-name';
        if (!suggest && bytes > 16384) throw new Error('body too large');
        const refused = heldBack(path, request?.action);
        if (refused) return refuseHeld(res, refused);
        const getContext = () => {
          const workspace = deploymentFor(held(), url.searchParams.get('ws'), DESKTOP_TERMS);
          return { workspace, cli: cliState, agents: workspace && !workspace.remote && !workspace.server ? agentsData(workspace.id).agents : [],
            instances: workspace ? snapshot.byWs.get(workspace.id)?.instances || [] : [] };
        };
        // Settled answers are reused for 60 s here, and prepare takes them up to PREPARE_REUSE_MS old, the drift
        // fenced by apply's --expect-decision (packages/client/spawn-preview.mjs). A suggest read has its own lane: one
        // per workspace, a newer one ending the older (E_SUPERSEDED).
        if (request.action === 'suggest-name') return send(res, 200, await spawnPreview.suggestName(request, getContext));
        if (suggest) return send(res, 200, await spawnPreview.suggest(request, getContext));
        return send(res, 200, await spawnPreview.read(request, getContext));
      } catch { return send(res, 400, previewFailure('E_BAD_ARGS')); }
    }
    if (path === '/api/workspace-readiness' && req.method === 'POST') {
      try {
        if (url.searchParams.getAll('ws').length !== 1 || !url.searchParams.get('ws') || [...url.searchParams.keys()].some(k => k !== 'ws')) throw new Error('bad query');
        const request = await readStrictBody(req);
        const refused = heldBack(path, request?.action);
        if (refused) return refuseHeld(res, refused);
        const getContext = () => {
          const workspace = deployments(held()).find(w => w.id === url.searchParams.get('ws'));
          return { workspace, cli: cliState, agents: workspace && !workspace.remote && !workspace.server ? agentsData(workspace.id).agents : [],
            localCwd: ctxs[0] ?? homedir(), instances: workspace ? snapshot.byWs.get(workspace.id)?.instances || [] : [] };
        };
        return send(res, 200, await readinessRequest(request, getContext));
      } catch { return send(res, 400, readinessFailure('E_BAD_ARGS')); }
    }
    // Team model v2: the deployment's teams and a soul's teams, through the kernel verbs (the
    // only writer of oats-local.yaml). POST, so the Origin guard above covers every action.
    if ((path === '/api/workspace-teams' || path === '/api/workspace-soul-teams') && req.method === 'POST') {
      try {
        if (url.searchParams.getAll('ws').length !== 1 || !url.searchParams.get('ws') || [...url.searchParams.keys()].some(k => k !== 'ws')) throw new Error('bad query');
        const request = await readStrictBody(req, 4096);
        const refused = heldBack(path, request?.action);
        if (refused) return refuseHeld(res, refused);
        const getContext = () => ({ workspace: deploymentFor(held(), url.searchParams.get('ws'), DESKTOP_TERMS), cli: cliState });
        const result = await (path === '/api/workspace-teams' ? teamsRequest : soulTeamsRequest)(request, getContext);
        // The writing actions change oats-local.yaml; inspect reports a soul's teams, so the held inspections go
        // (held under the workspace's scope, see observeMutation).
        if (['add', 'remove', 'default', 'clear-default'].includes(request.action)) {
          const { scope, id } = getContext().workspace || {};
          if (scope) inspectCache.invalidate(scope);
          if (id) spawnPreview.cache.invalidate(id); // a spawn preview reports the soul's teams
        }
        return send(res, 200, result);
      } catch { return send(res, 400, teamsFailure('E_BAD_ARGS')); }
    }
    // A field of an instance's own record (instance-record.mjs): its colour (feature instance-color, #1421 §2:
    // `oats instance color`) and whether it runs in the background (feature instance-background, #1579: `oats
    // instance background`), local or routed to the row's host. POST, so the Origin guard above covers them. A change,
    // or an outcome not known, re-reads the roster at once, so every dot and section follows.
    // Each route its boundary and its "nothing ran" answer, for a request that is not even a request. Resolved here, in
    // the handler, by path: the handler is the unit tests evaluate (workspace-views-fixture.mjs HANDLER), and only the
    // route asked names its boundary.
    const instanceRecord = req.method !== 'POST' ? undefined
      : path === '/api/instance-color' ? { request: instanceColorRequest, notRun: instanceColorNotRun }
      : path === '/api/instance-background' ? { request: instanceBackgroundRequest, notRun: instanceBackgroundNotRun } : undefined;
    if (instanceRecord) {
      try {
        if (url.searchParams.getAll('ws').length !== 1 || !url.searchParams.get('ws') || [...url.searchParams.keys()].some(k => k !== 'ws')) throw new Error('bad query');
        const request = await readStrictBody(req, 4096);
        const refused = heldBack(path);
        if (refused) return refuseHeld(res, refused);
        const getContext = () => {
          const workspace = deployments(held()).find(w => w.id === url.searchParams.get('ws'));
          return { workspace, cli: cliState, localCwd: ctxs[0] ?? homedir(), instances: workspace ? snapshot.byWs.get(workspace.id)?.instances || [] : [] };
        };
        const result = await instanceRecord.request(request, getContext);
        if (rereadsRoster(result)) {
          try { if (getContext().workspace?.remote) void remoteLoop.request(); else observeMutation(url.searchParams.get('ws')); }
          catch { /* a refresh must not erase the answer */ }
        }
        return send(res, 200, result);
      } catch { return send(res, 400, instanceRecord.notRun('E_BAD_ARGS')); }
    }
    if (path === '/api/instance-lifecycle' && req.method === 'POST') {
      try {
        if (url.searchParams.getAll('ws').length !== 1 || !url.searchParams.get('ws') || [...url.searchParams.keys()].some(k => k !== 'ws')) throw new Error('bad query');
        const request = await readStrictBody(req);
        const refused = heldBack(path, request?.action);
        if (refused) return refuseHeld(res, refused);
        const getContext = () => {
          const workspace = deployments(held()).find(w => w.id === url.searchParams.get('ws'));
          return { workspace, cli: cliState, localCwd: ctxs[0] ?? homedir(), instances: workspace ? snapshot.byWs.get(workspace.id)?.instances || [] : [] };
        };
        const result = await lifecycleRequest(request, getContext);
        if (request.action === 'apply' && ['complete', 'partial', 'refused', 'unknown'].includes(result.status)) {
          // A remote apply (even an unknown outcome) re-reads the remote roster at once: the operator sees current state.
          try { if (getContext().workspace?.remote) void remoteLoop.request(); else observeMutation(url.searchParams.get('ws')); }
          catch { /* a refresh must not erase a mutation receipt */ }
        }
        return send(res, 200, result);
      } catch {
        return send(res, 400, { lifecycleApi: 1, status: 'unavailable', target: null, planRef: null, plan: null, receipt: null,
          reason: { code: 'E_BAD_ARGS', message: 'Lifecycle requests require one workspace and a bounded JSON object.' } });
      }
    }
    if (path === "/api/instance-git" && req.method === "POST") {
      try {
        if (url.searchParams.getAll("ws").length !== 1 || !url.searchParams.get("ws") || [...url.searchParams.keys()].some(key => key !== "ws")) {
          throw Object.assign(new Error("Expected one workspace selector"), { code: "E_BAD_ARGS" });
        }
        const request = await readStrictBody(req);
        const refused = heldBack(path, request?.action);
        if (refused) return refuseHeld(res, refused);
        const workspace = deployments(held()).find(w => w.id === url.searchParams.get("ws"));
        // Never collect Git here or fall back to another workspace.
        // An absent exact snapshot is unavailable; refreshing the roster is
        // the existing collector's job, not an authority to infer another home.
        const result = await instanceGitRequest(request, { workspace, cli: cliState, localCwd: ctxs[0] ?? homedir(),
          instances: workspace ? snapshot.byWs.get(workspace.id)?.instances || [] : [] });
        return send(res, 200, result);
      } catch (error) {
        const bad = error?.code === "E_BAD_ARGS";
        return send(res, bad ? 400 : 503, { code: bad ? "E_BAD_ARGS" : "E_CLI_FAILED",
          error: bad ? "Git inspection requires one workspace selector and a JSON object body up to 64 KiB" : "Git inspection is unavailable" });
      }
    }
    if (path === "/api/workspace-sync" && req.method === "POST") {
      // Workspace model v2: catalog read and sync through the installed kernel
      // (server/workspace-sync.mjs). One local deployment.
      try {
        if (url.searchParams.getAll("ws").length !== 1 || !url.searchParams.get("ws") || [...url.searchParams.keys()].some(k => k !== "ws")) throw new Error("bad query");
        const request = await readStrictBody(req, 16384);
        const refused = heldBack(path, request?.action);
        if (refused) return refuseHeld(res, refused);
        const workspace = deploymentFor(held(), url.searchParams.get("ws"), DESKTOP_TERMS);
        const result = await workspaceSyncRequest(request, { workspace, cli: cliState });
        if (request?.action === "sync" && result.status === "ok") {
          try { observeMutation(workspace?.id); } catch { /* a refresh must not erase the sync report */ }
        }
        return send(res, 200, result);
      } catch { return send(res, 400, syncFailure("E_BAD_ARGS")); }
    }
    if (path === "/api/capabilities" && req.method === "POST") {
      const asked = url.searchParams.get("ws");
      try {
        const request = await readStrictBody(req);
        const refused = heldBack(path, request?.action);
        if (refused) return refuseHeld(res, refused);
        const workspace = surfaceDeployment(held(), asked, request, DESKTOP_TERMS);
        if (request?.action === "show" || request?.action === "file") {
          // What a capability ships (server/capability-show.mjs): its own gate (capability-show), not the
          // operations API's. The selector must match a row of the held table; with none held yet for an
          // observed deployment, the catalog read (held answer at once, else one kernel read) supplies it.
          try {
            const result = await capabilityShowRequest(request, { workspace, cli: cliState, cache: capabilityShowCache, maxAge: BACKGROUND_MAX_AGE,
              catalog: async () => {
                const d = workspace && !workspace.remote ? snapshot.byWs.get(workspace.id)?.deployment : null;
                const entry = d?.status === "observed" ? await capabilityCatalog.read(workspace.id, cliState, d.workspaceStatus, { maxAge: BACKGROUND_MAX_AGE })
                  : capabilityCatalog.held(workspace.id);
                return entry?.capabilities?.capabilities ?? null;
              } });
            return send(res, 200, result);
          } catch (e) {
            const code = typeof e?.code === "string" ? e.code : "E_CLI_FAILED";
            return send(res, code === "E_BAD_ARGS" ? 400 : 409, { error: String(e?.message || "").slice(0, 4096), code });
          }
        }
        // Inspections are served from the held cache (keyed by the soul catalog's key or the instance's
        // reported identity) and coalesced; `refresh: true` observes live. A run never touches the cache.
        // A soul inspection's key is the capabilities key (member/workspace commits, package rows, lock currency);
        // what no key can see (local configuration edited outside Desktop) is bounded by the cache TTL.
        const observed = workspace && !workspace.remote ? snapshot.byWs.get(workspace.id)?.deployment : null;
        const result = await capabilityRequest(request, {
          workspace, cli: cliState, localCwd: ctxs[0] ?? homedir(),
          agents: workspace ? agentsData(workspace.id).agents : [],
          instances: workspace ? deploymentRows(held(), workspace) : [],
          cache: inspectCache, maxAge: BACKGROUND_MAX_AGE,
          catalogKey: observed?.status === "observed" ? capabilityCatalogKey(cliState, observed.workspaceStatus) : null,
        }).finally(() => { if (workspace && request?.action === "run") spawnPreview.cache.invalidate(workspace.id); }); // an operation can change what a spawn preview reads
        return send(res, 200, result);
      } catch (e) { const { status, body } = spawnErrorPayload(e); return send(res, status, body); }
    }
    if (path === '/api/automations') {
      // Triggers and schedules (feature automations): one local workspace, the kernel's lists and verbs ({ kind, action, key?, runSource? }).
      if (req.method !== 'POST') return send(res, 405, automationsFailure('E_BAD_ARGS'));
      let request;
      try { ({ body: request } = await readStrictBody(req, 4096, true)); } catch { return send(res, 400, automationsFailure('E_BAD_ARGS')); }
      if (url.searchParams.getAll('ws').length !== 1 || !url.searchParams.get('ws') || [...url.searchParams.keys()].some(k => k !== 'ws')) return send(res, 400, automationsFailure('E_BAD_ARGS'));
      // The operation is `<kind>:<action>`: a list is a read, every switch, run and description is held back.
      const refused = heldBack(path, typeof request?.kind === 'string' && typeof request?.action === 'string' ? `${request.kind}:${request.action}` : null);
      if (refused) return refuseHeld(res, refused);
      const workspace = deploymentFor(held(), url.searchParams.get('ws'), DESKTOP_TERMS);
      return send(res, 200, await automationsRequest(request, { workspace, cli: cliState }));
    }
    if (path === '/api/schedules') {
      // The local schedule form's verbs (add/update/remove, reconcile, host-*). Reading and
      // enable/disable/run/test are the kernel's automations (/api/automations, §2.3a).
      if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed', code: 'E_METHOD_NOT_ALLOWED' });
      let request;
      try { ({ body: request } = await readStrictBody(req, 65536, true)); } catch { return send(res, 400, { error: 'Invalid schedule request', code: 'E_BAD_ARGS' }); }
      const refused = heldBack(path);
      if (refused) return refuseHeld(res, refused);
      // No default workspace: a mutation names its workspace.
      const workspace = surfaceDeployment(held(), url.searchParams.get('ws'), request, DESKTOP_TERMS);
      try {
        const result = await scheduleRequest(request, {
          workspace, cli: cliState, localCwd: ctxs[0] ?? homedir(),
          agents: workspace ? agentsData(workspace.id).agents : [],
          instances: workspace ? deploymentRows(held(), workspace) : [],
        });
        return send(res, 200, result);
      } catch (e) { const { status, body } = spawnErrorPayload(e); return send(res, status, body); }
    }
    const bm = path.match(/^\/api\/brain\/([A-Za-z0-9._-]+)$/);
    if (bm && req.method === "GET") {
      if (deploymentFor(held(), url.searchParams.get("ws"), DESKTOP_TERMS)?.remote) return send(res, 409, { error: "Remote files are available through the agent terminal", code: "E_REMOTE_FILES" });
      const d = brainData(bm[1], url.searchParams.get("ws") || undefined);
      return d ? send(res, 200, d) : send(res, 404, { error: `unknown agent "${bm[1]}"` });
    }
    if (req.method === "POST" && path === "/api/models") {
      // POST (not GET) so the CSRF Origin guard above covers this
      // command-running route — see the model-catalog SECURITY note.
      const body = await readBody(req);
      const refused = heldBack(path);
      if (refused) return refuseHeld(res, refused);
      const harness = typeof body.harness === "string" && body.harness ? body.harness : "pi";
      if (!HARNESSES.includes(harness)) return send(res, 400, { error: `unknown harness "${harness}" (pi|claude|codex)` });
      return send(res, 200, { harness, models: await modelsData(harness) });
    }
    if (req.method === "GET" && path === "/api/team-members") {
      // Who is in each team, wherever it runs (spec 02): the held observations only, no command.
      if (url.searchParams.getAll("ws").length !== 1 || [...url.searchParams.keys()].some(k => k !== "ws")) return send(res, 400, { error: "Expected one workspace selector", code: "E_BAD_ARGS" });
      // The VIEW's members (#482): its deployments only, each member tagged with its deployment and machine.
      const result = teamMembersFor(held(), url.searchParams.get("ws"), DESKTOP_TERMS);
      if (!result) return send(res, 400, { error: "Select a known workspace", code: "E_WORKSPACE_UNKNOWN" });
      return send(res, 200, result);
    }
    if (req.method === "GET" && path === "/api/servers") {
      // Registered execution servers, read through the CLI (the Desktop
      // holds no registry of its own). Without a compatible CLI there are
      // no servers to offer, which the renderer renders as "local only".
      if (!cliState.ok) return send(res, 200, { servers: [], reason: "cli-unavailable" });
      // #517: with servers-per-workspace and server-connect, only the window's own machines (server/machines.mjs).
      if (machinesGated(cliState)) {
        if (url.searchParams.getAll("ws").length > 1 || [...url.searchParams.keys()].some((k) => k !== "ws")) return send(res, 400, { error: "Expected one workspace selector", code: "E_BAD_ARGS" });
        const scope = machineScope(held(), url.searchParams.get("ws"), DESKTOP_TERMS);
        if (!scope) return send(res, 400, { error: "Select a known workspace", code: "E_WORKSPACE_UNKNOWN" });
        try { return send(res, 200, await machines.forScope(scope)); }
        catch (e) { return send(res, 200, { servers: [], key: scope.key, filtered: true, deployment: null, aweb: false, error: { code: e.code || "E_SERVERS", message: e.message || "The server registry could not be read" } }); }
      }
      const env = await adapter.cliServers(cliState.bin);
      if (!env.ok) return send(res, 200, { servers: [], reason: env.error?.code || "E_SERVERS" });
      return send(res, 200, { servers: (env.result.servers || []).map((s) => ({ id: s.id, label: s.label || s.id, sshHost: s.sshHost, workspace: s.workspace })) });
    }
    if (req.method === "POST" && ["/api/server-check", "/api/server-remove", "/api/server-connect"].includes(path)) {
      // #517: Check, Remove and Add a machine for the window's workspace (server/machines.mjs admits each id
      // by its workspace key). Fixed argv through the CLI; its envelope is relayed, never its stderr.
      if (url.searchParams.getAll("ws").length !== 1 || [...url.searchParams.keys()].some((k) => k !== "ws")) return send(res, 400, { error: "Expected one workspace selector", code: "E_BAD_ARGS" });
      let body;
      try { body = await readStrictBody(req, 4096); } catch (e) { return send(res, 400, { error: e.message, code: "E_BAD_ARGS" }); }
      const refused = heldBack(path);
      if (refused) return refuseHeld(res, refused);
      const scope = machineScope(held(), url.searchParams.get("ws"), DESKTOP_TERMS);
      if (!scope) return send(res, 400, { error: "Select a known workspace", code: "E_WORKSPACE_UNKNOWN" });
      try {
        if (path === "/api/server-check") return send(res, 200, await machines.check(scope, body.id));
        const envelope = path === "/api/server-remove" ? await machines.remove(scope, body.id) : await machines.connect(scope, body);
        // A registration changed: the remote roster reads it now, so the view gains (or loses) that deployment.
        if (envelope?.ok) void remoteLoop.request();
        return send(res, 200, envelope);
      } catch (e) {
        return send(res, e.code === "E_BUSY" || e.code === "E_FEATURE" ? 409 : 400, { error: e.message, code: e.code || "E_BAD_ARGS" });
      }
    }
    if (req.method === "POST" && path === "/api/server-forget") {
      // #1131: forget the saved route of a remote row its host no longer lists (server/server-forget.mjs). The
      // body is that row's { server, instance }; the argv is composed there, never taken from the request.
      // After any command that ran, whatever it answered, the remote roster is read again: this route is the one
      // owner of that read, and the renderer issues none. refreshRemoteSnapshotAfter() runs a read now, or one
      // right after the read already in flight, whoever started it (that one began before the command). The
      // answer does not wait for it: the forget is a local file removal, and a read waits on the slowest server.
      // The row leaves /api/panel when the read lands; nothing here edits it.
      if (url.search) return send(res, 400, forgetNotRun("E_BAD_ARGS"));
      let body;
      try { body = await readStrictBody(req, 4096); } catch { return send(res, 400, forgetNotRun("E_BAD_ARGS")); }
      const refused = heldBack(path);
      if (refused) return refuseHeld(res, refused);
      const { http, ran, answer } = await serverForget.forget(body);
      if (ran) { try { void refreshRemoteSnapshotAfter().catch(() => {}); } catch { /* a re-read must not erase the outcome */ } }
      return send(res, http, answer);
    }
    if (req.method === "GET" && path === "/api/cli") {
      return send(res, 200, servedCliStatus());
    }
    if (req.method === "POST" && path === "/api/window-state") {
      // Window activity from the Electron main process (window-activity.mjs): the refresh cadence backs off
      // while every window is blurred or hidden, and focus returning runs one prompt cycle. POST, so the
      // Host/Origin guards above cover it; the body is one boolean and nothing else.
      let body;
      try { body = await readStrictBody(req, 1024); } catch { return send(res, 400, { error: "body needs { focused: boolean }", code: "E_BAD_ARGS" }); }
      if (typeof body.focused !== "boolean" || Object.keys(body).length !== 1) return send(res, 400, { error: "body needs { focused: boolean }", code: "E_BAD_ARGS" });
      const refused = heldBack(path);
      if (refused) return refuseHeld(res, refused);
      refreshLoop.setFocused(body.focused); remoteLoop.setFocused(body.focused);
      return send(res, 200, { focused: refreshLoop.focused() });
    }
    if (req.method === "POST" && path === "/api/windows") {
      // The views the open windows show, from the Electron main process (main.mjs, window-activity.mjs
      // `createViewsNotifier`), posted whole whenever they change and whenever main learns this server (#1124).
      // POST, so the Host/Origin guards above cover it; it runs no command. The roster read asks for these
      // windows' workspaces; a window showing a workspace the last set did not ask for gets a read now, whatever
      // that set was: a set says what the next read asks for, never what the last read covered.
      let body;
      try { body = await readStrictBody(req); } catch { return send(res, 400, { error: "body needs { views: [view id | null] }", code: "E_BAD_ARGS" }); }
      const views = body?.views;
      if (Object.keys(body ?? {}).length !== 1 || !Array.isArray(views) || views.length > MAX_WINDOW_VIEWS || !views.every((v) => v === null || validWorkspaceId(v)))
        return send(res, 400, { error: "body needs { views: [view id | null] }", code: "E_BAD_ARGS" });
      const refused = heldBack(path);
      if (refused) return refuseHeld(res, refused);
      const terms = DESKTOP_TERMS, before = rosterWorkspaceKeys(held(), windowViews, terms);
      windowViews = [...views];
      const after = rosterWorkspaceKeys(held(), windowViews, terms);
      // Only for a CLI that filters: without the word every read covers every machine already, as before.
      if (cliState.features?.includes("roster-workspace-key") && (after === null ? before !== null : after.some((k) => !before?.includes(k)))) void remoteLoop.request();
      return send(res, 200, { views: windowViews.length });
    }
    if (req.method === "POST" && path === "/api/remote-roster/refresh") {
      // A remote window's Retry (#1117): the read the background loop runs, now, or the one already in flight.
      // Its outcome is held (the panels republished) before this answers; /api/panel then serves it.
      const refused = heldBack(path);
      if (refused) return refuseHeld(res, refused);
      await refreshRemoteSnapshot();
      return send(res, 200, { refreshed: true });
    }
    if (req.method === "POST" && path === "/api/cli/reprobe") {
      // Re-probe triggers (contract): launch, app focus, explicit Retry, and
      // after choosing a binary. The body names nothing: `{}` or empty. The
      // chosen binary is the choice file's (--cli-choice), read by the probe.
      let body;
      try { body = await readStrictBody(req, 1024); } catch { return send(res, 400, { error: "the body must be {} or empty", code: "E_BAD_ARGS" }); }
      if (Object.keys(body).length) return send(res, 400, { error: "the body must be {} or empty", code: "E_BAD_ARGS" });
      const refused = heldBack(path);
      if (refused) return refuseHeld(res, refused);
      await reprobeCli();
      return send(res, 200, servedCliStatus());
    }
    if (req.method === "POST" && path === "/api/spawn") {
      const arrivedAt = performance.now(); // a created answer waits for its deployment's read, never past ANSWER_WITHIN_MS from here
      let body;
      try { body = await readStrictBody(req, 65536); }
      catch { const failure = spawnApplyFailure('E_BAD_ARGS'); return send(res, 400, { ...failure, code: failure.reason.code, error: failure.reason.message }); }
      // The operation is the body's action (prepare, apply, result), or an execution-server spawn without one.
      const refused = heldBack(path, Object.hasOwn(body, 'action') ? body.action : 'execution-server');
      if (refused) return refuseHeld(res, refused);
      if (Object.hasOwn(body, 'action')) {
        if (url.searchParams.getAll('ws').length !== 1 || !url.searchParams.get('ws') || [...url.searchParams.keys()].some(k => k !== 'ws')) {
          const failure = spawnApplyFailure('E_BAD_ARGS'); return send(res, 400, { ...failure, code: failure.reason.code, error: failure.reason.message });
        }
        const getContext = () => {
          const workspace = deploymentFor(held(), url.searchParams.get('ws'), DESKTOP_TERMS);
          return { workspace, cli: cliState, agents: workspace && !workspace.remote && !workspace.server ? agentsData(workspace.id).agents : [],
            instances: workspace ? snapshot.byWs.get(workspace.id)?.instances || [] : [] };
        };
        // A spawn in the air changes what a preview answers (the next instance number, the roster): held
        // previews go when it starts, and again when it ends (observeMutation), so a preview read meanwhile
        // never refills them with the pre-spawn answer (the cache's flight clock).
        if (body.action === 'apply') { try { spawnPreview.cache.invalidate(url.searchParams.get('ws')); } catch { /* never blocks the apply */ } }
        // An apply that answered `pending` keeps its CLI running in the broker: refresh again when it settles.
        const refresh = () => { try { spawnPreview.cache.invalidate(url.searchParams.get('ws')); observeMutation(url.searchParams.get('ws')); } catch { /* a refresh must not erase a spawn receipt */ } };
        const result = await spawnApplyRequest(body, getContext, { settled: refresh });
        // #1246 D2: a created outcome (the apply's, or a `result` that found a pending apply settled) is answered once
        // its deployment's targeted read has published, or after the bounded wait. Local deployments only: the
        // boundary admits no other.
        const spawned = CREATED_STATUSES.includes(result?.status) ? deploymentFor(held(), url.searchParams.get('ws'), DESKTOP_TERMS) : null;
        const observed = spawned && !spawned.remote && !spawned.server && ctxs.includes(spawned.id)
          ? awaitSpawned(spawned.id, arrivedAt).catch(() => { /* never blocks the answer */ }) : null;
        if (body.action === 'apply') { try { observeMutation(url.searchParams.get('ws')); } catch { /* a refresh must not erase a spawn receipt */ } }
        if (observed) await observed;
        return send(res, 200, result);
      }
      // Only an actual remote argv route exempts a fully capable CLI from the
      // local confirmation fence. Truthy arrays/objects must not bypass it.
      const remoteRequest = typeof body.serverId === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(body.serverId);
      if (!remoteRequest) {
        const failure = spawnApplyFailure('E_PLAN_REQUIRED'); return send(res, 409, { ...failure, code: failure.reason.code, error: failure.reason.message });
      }
      // Ordinary older/remote spawn never gains the new options or a caller key.
      if (body && (['base', 'branch', 'work', 'modelMode', 'expectDecision', 'choices', 'spawnRef', 'idempotencyKey', 'decision'].some(k => Object.hasOwn(body, k))
        || typeof body.model === 'object' && body.model !== null || body.model === '@native-default')) {
        return send(res, 409, { code: 'E_UNSUPPORTED_OPTION', error: 'An execution-server spawn takes only the ordinary spawn options.' });
      }
      if (typeof body.agent !== "string" || !body.agent || typeof body.agentsRoot !== "string" || !body.agentsRoot)
        return send(res, 400, { error: "body needs { agent, agentsRoot }" });
      try { return send(res, 200, { spawned: true, ...(await spawnAgent(body)) }); }
      catch (e) { const { status, body: b } = spawnErrorPayload(e); return send(res, status, b); }
    }
    const hm = path.match(/^\/api\/(retire|start|restart)\/([A-Za-z0-9._-]+)$/);
    if (hm && req.method === "POST") {
      const refused = heldBack(`/api/${hm[1]}`);
      if (refused) return refuseHeld(res, refused);
      if (hm[1] === 'retire') return send(res, 409, { code: 'E_PLAN_REQUIRED', error: 'Open a fresh Retire confirmation. Unguarded retirement is unavailable, including remote retirement.' });
      // The caller only names an instance: the home a start launches in is the one this privileged
      // backend RESOLVED (and, for a local row, verified); it can never steer it.
      const r = resolveInstanceOr(hm[2], url.searchParams.get("ws") || undefined, url.searchParams.get("home") || undefined, url.searchParams.get("server") || undefined);
      if (r.error) return send(res, r.error.status, r.error.body);
      const inst = r.inst;
      if (!cliState.ok) return send(res, 503, { error: `${hm[1]} requires a compatible installed oats CLI`, code: "cli-unavailable" });
      /* OATSWEB_START_BEGIN — resolved instance start, exercised without launching a harness. */
      if (hm[1] === "start" || hm[1] === "restart") {
        // The start rule is the shared home's (packages/client/session-start.mjs): the gate's seven rules, the
        // home check, then the CLI call in its own session with its wait. The renderer decides through the same
        // gate and never sends a start it has refused; this reads the row again and checks the home, so it may.
        const body = await readBody(req);
        const started = await startInstance(cliState, inst, { model: body.model, launchConfig: body.launchConfig, harness: body.harness, yolo: body.yolo },
          { restart: hm[1] === "restart", localCwd: ctxs[0] ?? homedir(), verifyHome: verifiedLocalHome, start: adapter.cliStart, terms: DESKTOP_TERMS,
            group: deployments(held()).find((w) => w.id === url.searchParams.get("ws"))?.group });
        if (started.ok || started.ran) { observeMutation(url.searchParams.get("ws")); void refreshRemoteSnapshot(); }
        if (started.ok) return send(res, 200, started.result);
        // The wait for the start ended and the start goes on (cli-adapter.mjs cliStart): the Desktop's own sentence.
        if (started.code === "E_START_UNCONFIRMED") return send(res, 409, { error: START_UNCONFIRMED.message, code: START_UNCONFIRMED.code });
        // A refusal before the CLI ran answers the rule's sentence. After it ran: the kernel's message, through the
        // display filter (`detail`), else the rule's sentence for the code. A start that stopped at a launch prompt
        // carries its retained outcome as `incomplete`, decoded, when it names the instance this route resolved
        // (not the home: the kernel reports its real path). A start refused because of something else on the
        // home carries the rule's sentence as `startedNothing`, which the dialog shows over the kernel's message.
        return send(res, started.code === "E_BAD_ARGS" ? 400 : 409, { error: (started.ran ? started.detail ?? started.sentence : started.sentence) ?? "", code: started.code,
          ...(started.atClaim ? { startedNothing: started.sentence } : {}),
          ...(started.incomplete ? { incomplete: started.incomplete } : {}) });
      }
      /* OATSWEB_START_END */
    }
    if (req.method === "GET" && path === "/api/file") {
      const r = fileData(url.searchParams.get("path") || "");
      return r.error ? send(res, r.code, { error: r.error }) : send(res, 200, r.body);
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    if (e.code === "unsupported-remote-operation") return send(res, 409, { error: e.message, code: e.code });
    return send(res, 500, { error: String(e.message || e).slice(0, 300) });
  }
});

server.on("error", (e) => {
  console.error(`oats-desktop server: cannot listen on --socket: ${e.code || e.message}`);
  process.exit(1);
});
// The socket: a stale one at the path (a socket, by lstat, inside the directory checked above) is
// removed; anything else there is refused. Once listening, one ready line on stdout, which main's
// lease waits for. The socket file is removed on every exit this process controls.
let listenedIno = null;
function unlinkOwnSocket() {
  try { const st = lstatSync(SOCKET_PATH); if (st.isSocket() && st.ino === listenedIno) unlinkSync(SOCKET_PATH); } catch { /* gone */ }
}
try {
  const st = lstatSync(SOCKET_PATH);
  if (!st.isSocket()) startupRefusal("--socket: something other than a socket is at that path");
  unlinkSync(SOCKET_PATH);
} catch (e) { if (e?.code !== "ENOENT") startupRefusal("--socket: cannot remove the stale socket at that path"); }
process.on("exit", unlinkOwnSocket);
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.once(signal, () => { unlinkOwnSocket(); process.kill(process.pid, signal); });
}
server.listen(SOCKET_PATH, () => {
  try { chmodSync(SOCKET_PATH, 0o600); listenedIno = lstatSync(SOCKET_PATH).ino; } catch { /* the directory is private either way */ }
  console.log(`oats-desktop server — API on a private socket  (workspaces: ${deployments(held()).map((w) => w.name).join(", ") || "none"})`);
  console.log("This process can type into your agent terminals: every request must carry its credential.");
  console.log("oats-desktop-server ready");
});
// The owner lifeline (#698): Desktop's main holds the only write end of this
// process's stdin and never writes to it, so EOF, close or an error there means
// main has ended, by quit, crash or SIGKILL alike. Stop listening (without
// waiting on keep-alive sockets) and exit. CLI children in flight get no
// signal, as on the quit path. Without the flag stdin is never read, so a
// server started by hand behaves as before, whatever its stdin.
if (EXIT_ON_STDIN_CLOSE) {
  let ownerGone = false;
  const onOwnerGone = (how) => {
    if (ownerGone) return;
    ownerGone = true;
    console.log(`oats-desktop server: the app that started it has ended (stdin ${how}) — exiting`);
    server.close();
    server.closeAllConnections();
    process.exit(0);
  };
  process.stdin.on("data", () => { /* never written; read only to see its end */ });
  process.stdin.once("end", () => onOwnerGone("closed"));
  process.stdin.once("close", () => onOwnerGone("closed"));
  process.stdin.once("error", (e) => onOwnerGone(`error ${e.code || e.message}`));
}
// The warm reader ends with this process: its stdin closes on any exit (and with the process itself, on a
// SIGKILL), and the reader exits on that EOF without finishing a read.
process.on("exit", () => warmReader.stop());
void refreshLoop.start();                // the first cycle publishes "pending" until the CLI probe settles
reprobeCli().then((s) => {
  console.log(s.ok
    ? `oats-desktop server: oats CLI ${s.version} at ${s.bin} (${s.source})`
    : `oats-desktop server: no compatible oats CLI found — reads and terminals work; Spawn, Start and other changes disabled (${(s.tried || []).length} candidate(s) tried)`);
});
void remoteLoop.start();                 // coalesced host reads, independent of terminal traffic
