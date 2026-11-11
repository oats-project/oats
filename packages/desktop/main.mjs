// OATS desktop — Electron main process.
//
// Responsibilities (per the desktop-app contract):
//   * window + security posture: contextIsolation ON, nodeIntegration OFF,
//     all privileged work behind explicit IPC channels.
//   * server management: connect to a running desktop backend server (default
//     127.0.0.1:4820) or spawn the bundled `server/oats-web.mjs start`
//     as a child; the renderer's ctx.api() proxies to it over IPC.
//   * integrated terminal: node-pty running `tmux attach-session` per
//     terminal tab, bytes streamed to xterm.js over IPC. Closing a tab kills
//     the pty ONLY — the tmux session is the durable host and must survive.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, shell } from "electron";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync, lstatSync, statSync, fstatSync, opendirSync, openSync, readSync, closeSync, watch,
  mkdirSync, writeSync, fsyncSync, unlinkSync, readlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { apiUrl, apiInit, classifyApiRoute, createUnservedRefusal, servedSelectors, windowRefusal } from "./api-url.mjs";
import { scopedRequest } from "./renderer/workspace-routes.mjs";
import { forgeProxyOptions, FORGE_EPOCH_HEADER, installForgeAuthHandlers, trustedForgeFrame } from "./forge-proxy.mjs";
import { createGhRunner, forgeEnvironment } from "./forge-cli.mjs";
import { createForgeAuthBroker, verifyAuthCli } from "./forge-auth.mjs";
import { forgeFailure } from "./renderer/forge-contract.mjs";
import { lifecycleFailure } from '../client/lifecycle-contract.mjs';
import { lifecycleFrameRefusal } from './renderer/lifecycle-frame.mjs';
import { DESKTOP_TERMS } from './renderer/desktop-terms.mjs';
import { sweepViewers, listedTables } from "./tmux-target.mjs";
import { tmuxSocketArgs } from "./local-tmux-io.mjs";
import { createTerminalOwnerBroker, installTerminalHandlers } from './terminal-owner.mjs';
import { createTerminalIo } from './terminal-io.mjs';
import { ensureServerOnPort, serverCompatible } from "./server-compat.mjs";
import { createServerHost, createServerAdapter, serverSpawnSpec } from "./server-host.mjs";
import { cliWorkspace, validWorkspaceRef } from "../client/workspace-cli.mjs";
import { onboardData } from "../client/deployment-data.mjs";
import { validateWorkspace } from "../client/workspace-admission.mjs";
import { cliDeploymentList } from "../client/deployment-list-cli.mjs";
import { workspaceSuggestions, listState, createRemoveListed, unsavedOpenSet, importDesktopLists, createSerialQueue, settledCli, listDeployment, decideAdd, createGenerations, createAddExecutor, restoreWorkspaceDirs, saveWorkspaceDirs, commitOpenSet, startupOpenSet, matchWorkspaceDirs, createOnboardOffers, createOnboardExecutor,
  savedWorkspacePaths, persistableDirs, stageDirs, pickedFolderChoices, createPerformAdd, createSuggestionCalls } from "./workspace-registry.mjs";
import { workspaceNotServed } from "./renderer/deployment-header.mjs";
import { appMenuTemplate } from "./app-menu.mjs";
import { resolveLoginPath } from "./login-path.mjs";
import { cliEnvironment } from "../client/cli-environment.mjs";
import { pickerDefaultPath, workspacePickerCandidates, cliPickerCandidates, parseLastWorkspaceParent, lastWorkspaceParentState } from "./picker-default-path.mjs";
import { proxyReadiness } from './readiness-proxy.mjs';
import { proxySpawnPreview } from './spawn-preview-proxy.mjs';
import { proxyInstanceEvents } from './instance-events-proxy.mjs';
import { proxySpawnApply } from './spawn-apply-proxy.mjs';
import { startSingleInstance, launchDirectory, launchInstance, createLaunchReporter, createLaunchOpener, createVersionHandoff, ownLaunch } from "./single-instance.mjs";
import { createActivityNotifier, createViewsNotifier } from "./window-activity.mjs";
import { createHostThemeSource, installHostThemeHandlers, omarchyHost, OMARCHY_ARG } from "./host-theme.mjs";
import { createChordFamilySource, installChordFamilyHandlers } from "./chord-family.mjs";
import { frameWorkspace, trustedRendererUrl, workspaceHash } from "./renderer/window-binding.mjs";
import { validWorkspaceId } from "./renderer/workspace-id.mjs";
import { validLayout } from "./renderer/layout-handover.mjs";
import { createWindowSet } from "./window-set.mjs";
import { parseWindowRecords, resolveView, restorePlan, clampBounds, windowTitle, createWindowRecords } from "./window-records.mjs";
import { createResumeWiring } from "./session-resume-launch.mjs";
import { createResumeTrigger, localDeploymentIds } from "../client/session-resume-trigger.mjs";

const require = createRequire(import.meta.url);
const pty = require("node-pty");

const HERE = dirname(fileURLToPath(import.meta.url));

let port = Number(process.env.OATS_DESKTOP_PORT || 4820);
const base = () => `http://127.0.0.1:${port}`;
// Window activity → backend refresh cadence: the server backs its kernel
// polling off while every window is blurred/hidden and refreshes promptly
// when one returns. Main posts directly (as it already does for /api/panel
// and /api/cli): it alone sees all windows, and the renderer must not gain a
// new IPC surface for a fact main already holds. Edge-triggered in
// window-activity.mjs so an event burst is one POST.
const activity = createActivityNotifier({
  post: body => fetch(`${base()}/api/window-state`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(1500),
  }),
});
const noteWindowActivity = () => { activity.update(BrowserWindow.getAllWindows()); };
// The views the windows show → the backend's remote roster read (#1124): it reads the machines of these
// windows' workspaces only. Posted whole on every change of the window set (createWindowSet's onChange)
// and again for each server main learns (serverEpoch), and retried at the next served-list update
// (noteServed, which every panel read reaches) when a post failed. One post at a time, in order.
const windowViewsNotifier = createViewsNotifier({
  post: async (body) => (await fetch(`${base()}/api/windows`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(1500),
  })).ok,
});
const noteWindowViews = () => { void windowViewsNotifier.update(windows.entries().map(([, key]) => key), serverEpoch); };
// The launch folder: --dir <path> or OATS_DESKTOP_DIR or the cwd the app was
// launched from (`/` from Finder). It is served only when it is a deployment;
// the packaged app never infers a framework repo root. With no deployment to
// serve, the window chooses: the switcher, with Add local workspace… (#518).
const argDir = (() => {
  const i = process.argv.indexOf("--dir");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
})();
const WORKSPACE = resolve(argDir || process.env.OATS_DESKTOP_DIR || process.cwd());
// Mutable workspace set: the served deployments, set at startup and by runtime
// adds — the repeated --dir list an app-owned server is (re)started with. Empty
// when nothing validates: the server then serves no local deployment.
const workspaceDirs = [];
// The persisted open set (workspace-open.json): the saved paths, kept even while they do not
// validate, plus what was added. The served set above is only what validates (#472).
let openDirs = [];
// Every deployment path this Desktop has had open or saved this session (the saved set as read,
// the open set, each committed add). A known deployment the server does not serve is reported
// (E_WORKSPACE_NOT_SERVED) and may be re-added; an unknown id is adopted as before (#461).
const knownDirs = new Set();
const knowDirs = (dirs) => { for (const d of dirs) if (typeof d === "string" && d.startsWith("/")) knownDirs.add(d); };

// ---- the login shell's PATH (login-path.mjs, awebai/oats#468) ----------
// Opened from Finder or the Dock, the app inherits launchd's PATH, which has
// no Homebrew or nvm node for a `#!/usr/bin/env node` CLI (nor tmux, nor gh's
// git). Resolved once at startup, BEFORE anything is spawned, and merged into
// this process's own PATH, so the backend server, every oats call, the CLI
// probe, tmux and terminals inherit it. Only PATH is taken from the shell.
// The shell itself is started with the cleaned environment (cli-environment.mjs),
// like every other program main starts. What it answers is not assumed clean: a
// profile can print an entry under the AppImage's mount, and this process's own
// PATH is whatever the merge returns. Each child is filtered when it starts; gh's
// environment is the one copy made at module load, so its PATH is taken again
// here from this process's environment, which still has APPDIR.
let loginPath = { source: "inherited", error: null };
async function applyLoginPath() {
  const r = await resolveLoginPath({ env: cliEnvironment(process.env) });
  loginPath = { source: r.source, error: r.error };
  if (r.source !== "login-shell") { console.error(`oats-desktop: keeping the inherited PATH: ${r.error}`); return; }
  process.env.PATH = r.path;
  const path = forgeEnvironment().PATH;
  if (path === undefined) delete forgeEnv.PATH;
  else forgeEnv.PATH = path;
}

// ---- backend server management ----------------------------------------
// Server host (server-host.mjs): owns the child lifecycle, the ownership-
// through-transition invariant, and trust-state invalidation on replace.
let invalidateForgeReads = () => {};
let invalidateTerminalPreparations = () => {};
const serverHost = createServerHost({
  spawnChild: (dirs, onPort) => {
    const bin = join(HERE, "server", "oats-web.mjs");
    if (!existsSync(bin)) throw new Error(`desktop backend server not found at ${bin} and no usable server on port ${onPort}`);
    // The persisted user-chosen oats binary (if any) rides along as the
    // server's top-priority discovery candidate; the server re-probes it.
    const chosen = readCliChoice();
    // The argv and options, including the stdin owner lifeline (#698), are serverSpawnSpec's.
    const spec = serverSpawnSpec({ execPath: process.execPath, bin, dirs, port: onPort, oatsBin: chosen,
      pathSource: loginPath.source, pathError: loginPath.error, remoteIdentityFile: REMOTE_IDENTITY_FILE(),
      home: homedir(), env: process.env });
    const child = spawn(spec.command, spec.args, spec.options);
    // The lifeline's write end: held, never written, never ended (server-host.mjs).
    child.stdin.on("error", () => { /* the server is gone; its exit is reported */ });
    child.stdout.on("data", (d) => process.stdout.write(`[oats-desktop-server] ${d}`));
    child.stderr.on("data", (d) => process.stderr.write(`[oats-desktop-server] ${d}`));
    return child;
  },
  // trust state belongs to the outgoing server — stale entries must never
  // validate ?ws= or decideAdd; repopulated only from the current server.
  onInvalidate: () => { if (allowedWs.size) advertisedBefore = allowedWs; allowedWs = new Set(); serverEpoch++; invalidateForgeReads(); invalidateTerminalPreparations(); },
});
let wsId = null;        // verified workspace id on the server we use
let allowedWs = new Set(); // workspace ids the connected server advertises
// What the outgoing server advertised, kept only to refuse an unserved deployment's reads while a
// restart is in flight: they never validate a ?ws=, they only stop one from being rewritten.
let advertisedBefore = new Set();
let serverEpoch = 0;    // prevents an outgoing server response restoring its allowlist
let servedList = [];    // the served workspace views (/api/panel `workspaces`): window titles and restore
/** The served list changed: remember it, retitle every window from it, and keep each window's record
 * of the deployments its view holds (written only when that changed). A window bound to a deployment
 * whose view now has another id (its identity was observed) moves to that view in main at once,
 * focusing nothing, so no other window can take the workspace before this one's next read follows it
 * there (#482's rehome). If another window already has that view, the follow leaves this one choosing. */
function noteServed(list) {
  servedList = list;
  for (const [win, key] of windows.entries()) {
    const view = key === null ? null : viewKey(key);
    const bound = view !== key && windows.claim(win, view, { focus: false }).ok ? view : key;
    win.setTitle(windowTitle(bound, servedList));
    if (bound !== null) windowRecords?.bind(win, bound, undefined, servedList);
  }
  noteWindowViews();
}
/** What the server advertises, or while a restart is in flight what the outgoing one did. */
const advertisedNow = () => (allowedWs.size ? allowedWs : advertisedBefore);

async function panelWorkspaces() {
  try {
    const r = await fetch(`${base()}/api/panel`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    const d = await r.json();
    const list = d.workspaces || [];
    allowedWs = servedSelectors(list);
    noteServed(list);
    return list;
  } catch { return null; }
}

/** This checkout's bundled-server identity, for the reuse compatibility probe. */
function localServerIdentity() {
  const m = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
  return { capability: m.name, version: m.version };
}

/** Probe GET /api/version on the current port; null on network failure. */
async function probeVersion() {
  try {
    const r = await fetch(`${base()}/api/version`, { signal: AbortSignal.timeout(1500) });
    let body = null; try { body = await r.json(); } catch { /* non-JSON */ }
    return { ok: r.ok, status: r.status, body };
  } catch { return null; }
}

/** The backend must cover every restored workspace before it can be reused. */
function matchWorkspace(workspaces) {
  return matchWorkspaceDirs(workspaceDirs, workspaces);
}

async function freePort(from) {
  const { createServer } = await import("node:net");
  for (let p = from; p < from + 50; p++) {
    const ok = await new Promise((res) => {
      const s = createServer();
      s.once("error", () => res(false));
      s.listen(p, "127.0.0.1", () => s.close(() => res(true)));
    });
    if (ok) return p;
  }
  throw new Error(`no free port in ${from}..${from + 49}`);
}

// Port-committing adapter (server-host.mjs): the production wiring between
// selection and the host — commits the module port before the child starts.
const serverAdapter = createServerAdapter({
  host: serverHost,
  getPort: () => port,
  setPort: (p) => { port = p; },
});
const spawnServer = (onPort, dirs = workspaceDirs) => serverAdapter.spawnServer(onPort, dirs);
const replaceServer = (dirs) => serverAdapter.replaceServer(dirs);

async function ensureServer() {
  // ensureServerOnPort (server-compat.mjs) is the testable seam for the
  // whole step: reuse only a server that covers OUR workspace AND identifies
  // as this checkout via /api/version; otherwise leave it alone and spawn
  // our own — on the next free port when the current one is occupied.
  const r = await ensureServerOnPort({
    panelWorkspaces, probeVersion, matchWorkspace, local: localServerIdentity(),
    port, freePort: (from) => freePort(from), spawnServer: (p) => spawnServer(p),
    log: (m) => console.log(`oats-desktop: ${m}`),
  });
  port = r.port;
  if (!r.spawned) { wsId = r.wsId; return { spawned: false }; }
  // wait for the server to come up (max ~10s) and verify its workspace
  for (let i = 0; i < 40; i++) {
    const ws = await panelWorkspaces();
    if (ws) {
      // With no deployment to serve there is nothing to cover: the window chooses (#518).
      if (!workspaceDirs.length) return { spawned: true };
      const id = matchWorkspace(ws);
      if (!id) throw new Error(`spawned backend serves ${ws.map((w) => w.id).join(", ")} — does not cover ${workspaceDirs.join(", ")}`);
      wsId = id;
      return { spawned: true };
    }
    await new Promise((ok) => setTimeout(ok, 250));
  }
  throw new Error("spawned backend server but it never answered /api/panel");
}

// ---- IPC hardening -------------------------------------------------------
// Privileged channels answer ONLY the app's own renderer file, with no hash
// or the #ws= that binds its window (renderer/window-binding.mjs, #481).
// Should any navigation slip through (or a compromised page end up in the
// window), a foreign frame gets nothing — not the API proxy, not the terminals.
const RENDERER_URL = `${pathToFileURL(join(HERE, "renderer", "index.html"))}`;
function trustedFrame(e) {
  return trustedRendererUrl(e.senderFrame?.url, RENDERER_URL);
}
function guard(e) { if (!trustedFrame(e)) throw new Error("forbidden: untrusted frame"); }

// ---- IPC: the theme of this computer (#602) ------------------------------
// "This computer" is a theme choice. Main reads the host's theme (Omarchy's
// colors.toml, else the system's light or dark appearance), follows it, and
// pushes plain state (colours and polarity: no path, no file content) to every
// window; a window applies it only while that is its choice
// (renderer/host-theme.mjs). No host program is run to read colours.
const hostTheme = createHostThemeSource({
  fs: { statSync, fstatSync, openSync, readSync, closeSync, watch }, home: homedir(), nativeTheme,
  send: (state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      try { if (!win.webContents.isDestroyed()) win.webContents.send("host-theme:changed", state); } catch { /* closing window */ }
    }
  },
});
installHostThemeHandlers({ ipc: ipcMain, guard, source: hostTheme });
// Omarchy's presence, read once at start (host-theme.mjs omarchyHost, the host theme's marker): each window
// hears it as an argument its preload reads (oatsDesktop.isOmarchy), so its first paint is already in the
// right font and terminal size.
const omarchyArguments = Object.freeze(omarchyHost({ fs: { statSync }, home: homedir(), platform: process.platform }) ? [OMARCHY_ARG] : []);

// ---- IPC: the chord family, keys.json (chord-family.mjs) -------------------
// On Linux/Windows the shared chords are Alt or, by this user's keys.json (shared with the
// TUI, beside tui.json), Ctrl+Alt or Ctrl+Shift. Main reads the file when a window asks and when the operator
// comes back to Desktop, writes it when the Shortcuts page changes the choice (only `chords`,
// atomically), and hands the family to every window at once. Plain state only: no path, no content.
const chordFamily = createChordFamilySource({
  fs: { openSync, fstatSync, readSync, closeSync, mkdirSync, writeSync, fsyncSync, renameSync, unlinkSync, lstatSync, realpathSync, readlinkSync },
  env: process.env, home: homedir(),
  send: (state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      try { if (!win.webContents.isDestroyed()) win.webContents.send("chord-family:changed", state); } catch { /* closing window */ }
    }
  },
});
installChordFamilyHandlers({ ipc: ipcMain, guard, source: chordFamily });

// ---- IPC: workspace suggestions + runtime add ---------------------------
// Privileged side of the runtime workspace switcher (phase-2 hook 3; the
// renderer owns the modal). Discovery is bounded: known deployment dirs and
// this computer's deployments list, read from the kernel (#1390). The kernel
// reads the deployment itself. workspace:add only ever replaces an app-OWNED
// server; foreign servers fail closed.
const wsGens = createGenerations();
/** The window a privileged workspace call comes from (#481): its own generations and provenance. */
const windowScope = (e) => String(e.sender.id);
// The recently-added list of Desktops before #1390: read once, for the import into this computer's
// deployments list, then renamed (RECENTS_IMPORTED_FILE) and never read or written again.
const RECENTS_FILE = () => join(app.getPath("userData"), "workspace-recents.json");
const RECENTS_IMPORTED_FILE = () => join(app.getPath("userData"), "workspace-recents.imported.json");
const OPEN_WORKSPACES_FILE = () => join(app.getPath("userData"), "workspace-open.json");
// The last workspace identity each remote roster group reported (server/remote-identity.mjs, #482).
const REMOTE_IDENTITY_FILE = () => join(app.getPath("userData"), "remote-identity.json");

// A workspace-model v2 deployment is a directory holding a regular (lstat,
// non-following) oats-local.yaml. Existence only: never parsed here.
const wsValidate = (p) => validateWorkspace(p, {
  isDeployment: (path) => {
    try { return lstatSync(join(path, "oats-local.yaml")).isFile(); } catch { return false; }
  },
});

// This computer's deployments list (#1390): every call a kernel verb, through the server's accepted CLI
// (the binary every other kernel verb uses). Gated on its deployments-list feature; nothing falls back.
const readServedCli = async () => (await fetch(`${base()}/api/cli`, { signal: AbortSignal.timeout(10_000) })).json();
async function deploymentList(options) {
  let cli;
  try { cli = await readServedCli(); } catch { cli = null; }
  return cliDeploymentList(cli, options);
}
// Adds (their listing included) and Removes, one after the other (createSerialQueue).
const servingQueue = createSerialQueue();
/** At startup, once the CLI is known (#1390): the Desktop's own lists imported once, then the launch's
 * own deployment (`--dir`, or a cwd that is one) listed. Both best effort, both only logged: no window
 * owns them. */
async function startupDeploymentList(launched) {
  const cli = await settledCli(readServedCli, { attempts: 60 });
  if (!cli) return;
  const read = (file) => { try { return readFileSync(file, "utf8"); } catch { return null; } };
  const imported = await importDesktopLists({
    readRecents: () => read(RECENTS_FILE()),
    readOpen: () => read(OPEN_WORKSPACES_FILE()),
    importPaths: (paths) => cliDeploymentList(cli, { action: "import", from: "desktop", paths }),
    retire: () => renameSync(RECENTS_FILE(), RECENTS_IMPORTED_FILE()),
  });
  if (imported.status === "kept") console.error(`oats-desktop: the saved workspaces were not imported into this computer's deployments list yet: ${imported.reason}`);
  if (launched) await servingQueue(() => listOnComputer(launched));
}
/** Each committed add, and the launch's own deployment, is listed once the server's probe has settled (a
 * replacement server's is pending at first); the failure, or null. Never the restored open set: a
 * deployment removed with `oats deployments remove` would come back at every launch. */
async function listOnComputer(path) {
  const failure = await listDeployment(path, { cli: () => settledCli(readServedCli), run: cliDeploymentList });
  if (failure) console.error(`oats-desktop: could not list ${path} on this computer: ${failure.code}: ${failure.message}`);
  return failure;
}
// Lost sessions resumed (session-resume-launch.mjs, ../client/session-resume-trigger.mjs): one trigger per app
// launch, armed by the primary instance's startup only, after its deployments-list step settles, then asked
// again by each accepted /api/panel reply (the api handler). Its sweeps' children are detached and file-backed:
// shutdown() never touches them, and the trigger is never disposed at quit.
const resumeTrigger = createResumeWiring({
  createTrigger: createResumeTrigger, cli: () => settledCli(readServedCli, { attempts: 60 }),
  error: (line) => console.error(line),
});
// Where Add workspace → Browse… opens next (picker-default-path.mjs): the
// parent of the workspace most recently added or opened, across launches.
const LAST_WORKSPACE_PARENT_FILE = () => join(app.getPath("userData"), "last-workspace-parent.json");
function readLastWorkspaceParent() {
  try { return parseLastWorkspaceParent(readFileSync(LAST_WORKSPACE_PARENT_FILE(), "utf8")); }
  catch { return null; }
}
function rememberWorkspaceParent(workspacePath) {
  try { writeFileSync(LAST_WORKSPACE_PARENT_FILE(), lastWorkspaceParentState(workspacePath)); } catch { /* best-effort */ }
}

// Per window: the deployments offered beside its latest refused pick (#461).
const lastPickChoices = new Map();

const executeAdd = createAddExecutor({
  getDirs: () => [...workspaceDirs],
  stage: (dirs, path) => stageDirs(dirs, path, wsValidate),
  commitDirs: (dirs) => {
    // Persistence failure leaves the old set intact; the executor restores
    // the previous backend and reports the failed add to the user. The persisted
    // set keeps every saved deployment, served or not (#472).
    const next = commitOpenSet({ open: openDirs }, dirs, (open) => saveWorkspaceDirs(OPEN_WORKSPACES_FILE(), open));
    openDirs = next.open;
    workspaceDirs.length = 0; workspaceDirs.push(...next.served);
    knowDirs(dirs);
  },
  replaceServer,
  refreshAdvertised: async () => (await panelWorkspaces()) !== null, // true only when the server ANSWERED
  probeVersion,
  // any 2xx is NOT enough during a same-port race — identity must match
  isCompatible: (v) => serverCompatible(v, localServerIdentity()).compatible,
  advertises: async (id) => { await panelWorkspaces(); return allowedWs.has(id); },
});

// Each window's latest call, and the canonical paths it offered (createSuggestionCalls).
const suggestionCalls = createSuggestionCalls({
  generations: wsGens,
  refresh: () => panelWorkspaces(), // refresh allowedWs from the live server
  list: async () => {
    const read = await deploymentList({ action: "list" });
    return {
      suggestions: workspaceSuggestions({
        // Every deployment this Desktop knows (the saved set as read included): a saved one that is not
        // served, such as one whose volume was mounted after launch, is offered again (#472, #518).
        knownPaths: [...knownDirs],
        listed: read.ok ? read.value.rows : null,
        advertised: allowedWs,
        validate: wsValidate,
      }),
      list: listState(read),
    };
  },
});
ipcMain.handle("workspace:suggestions", async (e) => {
  guard(e);
  return suggestionCalls.suggest(windowScope(e));
});

// Remove a row of this computer's deployments list (#1390): only one the asking window was offered as
// removable, never one that is served (#476). Its saved open-set entry goes with it.
const removeListed = createRemoveListed({
  serial: servingQueue,
  removable: (scope) => suggestionCalls.removable(scope),
  served: (path) => workspaceDirs.includes(path) || allowedWs.has(path),
  remove: (path) => deploymentList({ action: "remove", path }),
  unsave: (path) => {
    if (openDirs.includes(path)) {
      const open = unsavedOpenSet(openDirs, path);
      saveWorkspaceDirs(OPEN_WORKSPACES_FILE(), open);
      openDirs = open;
    }
    knownDirs.delete(path); // no longer offered as a saved entry
  },
});
ipcMain.handle("workspace:remove-listed", async (e, path) => {
  guard(e);
  return removeListed(path, windowScope(e));
});

// The entry point of every add (workspace-registry.mjs createPerformAdd): a refusal returns before
// any effect, a non-deployment pick is answered with where the deployment is (or, with none near,
// the onboarding offer), and an accepted add runs the transactional executor (serialized adds,
// staged dirs, identity-checked readiness, commit-after-ready, restore-on-failure). Terminals are
// unaffected throughout: viewers attach to tmux, not the backend.
const performAdd = createPerformAdd({
  generations: wsGens,
  decide: (requestedPath, fromPicker, scope) => decideAdd(requestedPath, {
    realpath: (p) => realpathSync(p),
    validate: wsValidate,
    // Provenance: a suggestion or a deployment offered beside a refused pick in the asking window, or
    // one this Desktop knows (Re-add of a deployment the server stopped serving). Never an arbitrary path.
    suggestedPaths: new Set([...suggestionCalls.offered(scope), ...(lastPickChoices.get(scope) || []), ...knownDirs]),
    fromPicker,
    serverOwned: serverHost.owned(),
    advertised: allowedWs,
  }),
  realpath: (p) => realpathSync(p),
  choices: (dir, scope) => {
    const found = pickedFolderChoices(dir, { list: listEntries, isDeployment: (p) => !!wsValidate(p) });
    lastPickChoices.set(scope, new Set(found.choices.map((c) => c.path)));
    return found;
  },
  offer: (path) => onboardOffers.offer(path),
  execute: (ws, isCurrent) => executeAdd(ws, isCurrent),
  // An add that opened a workspace (or found it already open) remembers its parent for the picker (#460).
  added: (ws) => rememberWorkspaceParent(ws.path),
  // A committed add is listed on this computer (#1390): best effort, its failure a notice in the answer.
  listed: (ws) => listOnComputer(ws.path),
  serial: servingQueue,
});

/** At most `limit` entries of `dir`, typed by the entry itself (a link is not a directory). */
function listEntries(dir, limit) {
  const handle = opendirSync(dir);
  const entries = [];
  try {
    for (let entry; entries.length < limit && (entry = handle.readSync());) entries.push({ name: entry.name, isDirectory: entry.isDirectory() });
    return { entries, limited: entries.length >= limit && handle.readSync() !== null };
  } finally { handle.closeSync(); }
}

const onboardOffers = createOnboardOffers({ token: () => randomBytes(16).toString("hex") });
const onboardExecutor = createOnboardExecutor({
  take: (token) => onboardOffers.take(token),
  offer: (path) => onboardOffers.offer(path),
  realpath: (p) => realpathSync(p),
  isDeployment: (p) => !!wsValidate(p),
  // The server's accepted probe: the same binary every other kernel verb uses.
  readCli: readServedCli,
  run: (cli, options) => cliWorkspace(cli, options, DESKTOP_TERMS),
  project: onboardData,
  add: (dir, scope) => performAdd(dir, true, scope),
  validRef: validWorkspaceRef,
});
ipcMain.handle("workspace:onboard", async (e, token, ref) => {
  guard(e);
  return onboardExecutor(token, ref, windowScope(e));
});

ipcMain.handle("workspace:add", async (e, requestedPath) => {
  guard(e);
  if (typeof requestedPath !== "string" || !requestedPath.startsWith("/")) return { ok: false, code: "bad-path", reason: "path must be an absolute string" };
  return performAdd(requestedPath, false, windowScope(e));
});

const isDirectory = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
ipcMain.handle("workspace:pick", async (e) => {
  guard(e);
  // Explicit separate action: native directory picker feeding the SAME
  // validation path (fromPicker bypasses only the suggestion-set provenance
  // check — canonicalization and workspace validation still apply).
  const win = BrowserWindow.fromWebContents(e.sender);
  // Opens beside the most recently added workspace (picker-default-path.mjs).
  const defaultPath = pickerDefaultPath({
    candidates: workspacePickerCandidates({
      last: readLastWorkspaceParent(), open: workspaceDirs.filter((p) => !!wsValidate(p)),
    }),
    exists: isDirectory,
    home: app.getPath("home"),
  });
  const r = await dialog.showOpenDialog(win, { defaultPath, properties: ["openDirectory"] });
  if (r.canceled || !r.filePaths?.[0]) return { ok: false, code: "cancelled", reason: "picker cancelled" };
  return performAdd(r.filePaths[0], true, windowScope(e));
});

// ---- IPC: CLI binary picker (Choose oats…) --------------------------------
// Native file picker for the degradation card. Persistence lives here (the
// main process owns userData); the picked path goes to the server via the
// renderer's POST /api/cli/reprobe {bin} — the server re-validates with the
// full probe, so a bad pick degrades with diagnostics, never trusts a path.
const CLI_CHOICE_FILE = () => join(app.getPath("userData"), "oats-cli-choice.json");
function readCliChoice() {
  try { const p = JSON.parse(readFileSync(CLI_CHOICE_FILE(), "utf8")).bin; return typeof p === "string" && p.startsWith("/") ? p : null; }
  catch { return null; }
}
function writeCliChoice(bin) {
  try { writeFileSync(CLI_CHOICE_FILE(), JSON.stringify({ bin })); } catch { /* best-effort */ }
}
// The CLI the backend resolved, for the picker's starting directory only.
async function resolvedCliBin() {
  try { const bin = (await (await fetch(`${base()}/api/cli`, { signal: AbortSignal.timeout(1500) })).json()).bin; return typeof bin === "string" ? bin : null; }
  catch { return null; }
}
ipcMain.handle("cli:pick", async (e) => {
  guard(e);
  const win = BrowserWindow.fromWebContents(e.sender);
  // Opens in the chosen or resolved CLI's directory (picker-default-path.mjs).
  const defaultPath = pickerDefaultPath({
    candidates: cliPickerCandidates({ chosen: readCliChoice(), resolved: await resolvedCliBin() }),
    exists: isDirectory,
    home: app.getPath("home"),
  });
  const r = await dialog.showOpenDialog(win, {
    defaultPath,
    title: "Choose the oats CLI binary",
    properties: ["openFile", "showHiddenFiles"],
    message: "Select the oats executable (e.g. from `command -v oats`)",
  });
  if (r.canceled || !r.filePaths?.[0]) return { path: null };
  writeCliChoice(r.filePaths[0]);           // persisted — top discovery priority next launch
  return { path: r.filePaths[0] };
});

// ---- IPC: API proxy -----------------------------------------------------
// The roster/agents read of a deployment this Desktop knows (and that is still one) but the
// server does not advertise: refused with E_WORKSPACE_NOT_SERVED, never fetched (api-url.mjs).
const unservedRefusal = createUnservedRefusal({ base, body: workspaceNotServed,
  state: () => ({ allowedWs: allowedWs.size ? allowedWs : advertisedBefore, known: (path) => knownDirs.has(path) && !!wsValidate(path) }) });

// The renderer never talks to the network directly; ctx.api() lands here.
ipcMain.handle("api", async (e, pathname, opts) => {
  // The workspace the sending window is bound to (#481): a request from it carries that workspace,
  // never another's. An unbound window keeps the verified workspace and its rewrite (#461 adoption).
  const bound = (() => { try { return frameWorkspace(e.senderFrame?.url, RENDERER_URL); } catch { return undefined; } })();
  const windowWs = typeof bound === "string" ? bound : null;
  // A window with no workspace to read (a New Window, a window left choosing) reads none: the verified
  // workspace below is only for a window still adopting its first one.
  if (windowWs === null && scopedRequest(pathname) && choosers.has(BrowserWindow.fromWebContents(e.sender))) {
    return { ok: false, status: 409, body: { error: "This window has no workspace yet.", code: "E_NO_WORKSPACE" } };
  }
  // A window whose hash names a workspace main no longer binds it to (a take-over moved it while its page
  // was loading or reloading, and the page has not followed yet) reads none of it (holdsHash).
  if (windowWs !== null && scopedRequest(pathname) && !holdsHash(BrowserWindow.fromWebContents(e.sender), windowWs)) {
    return { ok: false, status: 409, body: { error: "This window does not show that workspace any more.", code: "E_WINDOW_NOT_BOUND" } };
  }
  // A workspace the server does not serve, asked by a bound window, is refused on every
  // workspace-scoped route — never answered with another workspace's data. Main learns what the
  // server advertises from panel replies, so it re-reads that first: a view observed since (its
  // identity is read after the server starts) is served, and a refused window would never bring the
  // reply that says so.
  let notServed = windowRefusal(pathname, base(), windowWs, advertisedNow());
  if (notServed) { await panelWorkspaces(); notServed = windowRefusal(pathname, base(), windowWs, advertisedNow()); }
  // The served choices go with it: the window finds the view that holds its deployments now (#482's
  // rehome) without another read, which would name the same unserved workspace.
  if (notServed) return { ok: false, status: 404, body: { ...workspaceNotServed(notServed), workspaces: servedList } };
  // One normalized classifier owns every specialized routing decision;
  // aliases cannot bypass frame/epoch guards, deadlines or typed failures.
  const route = classifyApiRoute(pathname, base());
  const connection = () => ({ base: base(), wsId: windowWs ?? wsId, allowedWs, bound: windowWs !== null, epoch: serverEpoch, transition: serverHost.inTransition() });
  if (route === 'spawn-apply') return proxySpawnApply(e, pathname, opts, { rendererURL: RENDERER_URL, connection });
  if (route === 'spawn-preview') return proxySpawnPreview(e, pathname, opts, { rendererURL: RENDERER_URL, connection });
  if (route === 'instance-events') return proxyInstanceEvents(e, pathname, opts, { rendererURL: RENDERER_URL, connection });
  if (route === 'readiness') return proxyReadiness(e, pathname, opts, { rendererURL: RENDERER_URL, connection });
  const lifecycle = route === 'lifecycle';
  const forgeRequest = lifecycle || route === 'forge';
  const failure = lifecycle ? (code, extra) => lifecycleFailure(code, DESKTOP_TERMS, extra) : forgeFailure;
  const forbidden = () => (lifecycle ? lifecycleFrameRefusal() : forgeFailure('E_FORBIDDEN_FRAME'));
  const mutation = lifecycle && (() => { try { return (typeof opts?.body === 'string' ? JSON.parse(opts.body) : opts?.body)?.action === 'apply'; } catch { return false; } })();
  if (forgeRequest && !trustedForgeFrame(e, RENDERER_URL)) return { ok: false, status: 403, body: forbidden() };
  const forgeFrame = forgeRequest ? e.senderFrame : null;
  const ownsForgeFrame = () => trustedForgeFrame(e, RENDERER_URL) && e.sender.mainFrame === forgeFrame;
  try {
  guard(e);
  // A deployment this Desktop knows (and that is still one) but the server does not serve is
  // refused by name, never answered with another workspace's data (#461). A bound window's were
  // refused above.
  const refusal = windowWs === null ? unservedRefusal(pathname) : null;
  if (refusal) return refusal;
  // apiUrl rejects off-origin resolution (e.g. "//attacker/x"), and pins
  // the window's workspace (else the verified one) on scoped endpoints
  // unless the caller selects a workspace this server actually advertises
  // (the views' ws switcher).
  const url = apiUrl(pathname, base(), windowWs ?? wsId, allowedWs, { bound: windowWs !== null });
  const epoch = serverHost.inTransition() ? null : serverEpoch;
  // apiInit forwards pre-serialized (string) bodies and headers unchanged —
  // views serialize once in common.mjs::postJson — and serializes object
  // bodies itself.
  // Provider actions may perform bounded work before returning their receipt.
  // Let the CLI's five-minute limit report the outcome before the proxy times out.
  const forge = route === 'forge' ? forgeProxyOptions(url.pathname, opts, currentForgeEpoch()) : null;
  // automations: `trigger test` polls the forge (the adapter allows the CLI 60 s).
  // A plan, an instance Git read or an instance record write (colour, background) may be routed to a server (a 45 s
  // CLI deadline): 50 s lets it report itself.
  // A machine connect: the CLI's 15 minutes (5 for the messaging step) after the registry read (60 s); a check,
  // remove or the list: a registry read and a 60 s check (server/machines.mjs, packages/client/cli-adapter.mjs).
  // A start or restart: the kernel may watch a launch prompt for 30 s and then answers what it kept; the
  // dialog can say that outcome only if this proxy is still waiting for it. It must outlast the CLI call
  // (cli-adapter.mjs `cliStart`; start-proxy-deadline.test.mjs holds the two together). Giving up here ends
  // nothing: the server awaits the call whatever becomes of its request (start-abort-server.test.mjs).
  // A remote window's Retry: the server answers once its roster read landed, which the CLI adapter allows 60 s
  // (`cliRemoteRoster`; remote-roster-proxy-deadline.test.mjs holds the two together).
  const timeout = lifecycle ? mutation ? 610_000 : 50_000 : forge?.timeout ?? (route === 'capabilities' || route === 'workspace-sync' ? 310_000
    : route === 'automations' ? 90_000 : route === 'instance-git' || route === 'instance-color' || route === 'instance-background' ? 50_000 : route === 'machine-connect' ? 980_000 : route === 'machines' ? 130_000
    : route === 'instance-start' || route === 'remote-roster' ? 70_000 : 20_000);
  const init = { ...(forge?.init ?? apiInit(opts)), signal: AbortSignal.timeout(timeout) };
  const r = await fetch(url, init);
  const text = await r.text();
  if ((forge || lifecycle) && !ownsForgeFrame()) return { ok: false, status: 403, body: forbidden() };
  let json; try { json = JSON.parse(text); } catch { json = lifecycle ? failure(mutation ? 'E_OUTCOME_UNKNOWN' : 'E_CLI_PROTOCOL', { status: mutation ? 'unknown' : 'unavailable' })
    : forge ? forgeFailure('E_GH_PROTOCOL') : { raw: text }; }
  if ((forge || lifecycle) && (epoch !== serverEpoch || serverHost.inTransition()
    || forge && forge.init.headers[FORGE_EPOCH_HEADER] !== currentForgeEpoch())) json = lifecycle
      ? failure(mutation ? 'E_OUTCOME_UNKNOWN' : 'E_PLAN_CHANGED', { status: mutation ? 'unknown' : 'unavailable' }) : forgeFailure('E_CONNECTION_CHANGED');
  // Remote discovery can finish after startup. Accept the same server-owned
  // choices the menu receives, without adding requests to workspace polling.
  if (epoch === serverEpoch && !serverHost.inTransition() && r.ok && route === 'panel') {
    if (Array.isArray(json?.workspaces)) {
      allowedWs = servedSelectors(json.workspaces);
      noteServed(json.workspaces);
    }
    // The session resume trigger reads the same accepted reply's instance rows, with the reply's own local
    // deployments: a row is local only by its deployment id (a remote server's rows never count).
    if (Array.isArray(json?.instances)) void resumeTrigger.observed(json.instances, { localDeploymentIds: localDeploymentIds(json) });
  }
  return { ok: r.ok, status: r.status, body: json };
  } catch (error) {
    if (forgeRequest) return ownsForgeFrame() ? { ok: false, status: 503, body: lifecycle
      ? failure(mutation ? 'E_OUTCOME_UNKNOWN' : 'E_CLI_FAILED', { status: mutation ? 'unknown' : 'unavailable' }) : forgeFailure('E_GH_FAILED') }
      : { ok: false, status: 403, body: forbidden() };
    throw error;
  }
});

// ---- IPC: workstation forge auth (separate from ALL agent terminals) ----
const forgeClient = randomBytes(16).toString('hex');
const forgeEnv = forgeEnvironment();
const runGh = createGhRunner({ env: forgeEnv });
const currentForgeEpoch = () => `${forgeClient}:${forgeAuth.generation()}`;
const forgeAuth = createForgeAuthBroker({
  env: forgeEnv,
  readConnection: async connectionRef => {
    const serverLease = serverEpoch, readEpoch = currentForgeEpoch();
    if (serverHost.inTransition()) return forgeFailure('E_CONNECTION_CHANGED');
    try {
      const response = await fetch(`${base()}/api/forge-connections`, {
        method: 'POST', headers: { 'content-type': 'application/json', [FORGE_EPOCH_HEADER]: readEpoch },
        body: JSON.stringify({ hostRef: connectionRef }), signal: AbortSignal.timeout(25_000),
      });
      const result = await response.json();
      if (!response.ok || serverLease !== serverEpoch || serverHost.inTransition() || readEpoch !== currentForgeEpoch()
        || result?.readEpoch !== readEpoch) return forgeFailure('E_CONNECTION_CHANGED');
      return result;
    } catch { return forgeFailure('E_GH_FAILED'); }
  },
  verify: cli => verifyAuthCli(cli, runGh, forgeEnv),
  launchPty: (bin, args, options) => pty.spawn(bin, args, options),
  run: runGh,
  confirm: async ({ owner, host, login, signal }) => {
    const result = await dialog.showMessageBox(BrowserWindow.fromWebContents(owner), {
      type: 'warning', title: 'Disconnect GitHub', message: `Sign out ${login} on ${host}?`,
      detail: 'This removes this account from GitHub CLI on this machine, affecting all workspaces and other uses of gh. It does not revoke the token on GitHub. Another stored account may become active.',
      buttons: ['Cancel', 'Sign out'], defaultId: 0, cancelId: 0, noLink: true, signal,
    });
    return result.response === 1;
  },
  alive: owner => trustedForgeFrame({ sender: owner, senderFrame: owner.mainFrame }, RENDERER_URL),
  emit: (owner, lease, kind, data) => owner.send(`forge:auth-${kind}:${lease}`, data),
  changed: generation => {
    for (const win of BrowserWindow.getAllWindows()) {
      try { if (!win.webContents.isDestroyed()) win.webContents.send('forge:changed', generation); } catch { /* closing window */ }
    }
  },
});
invalidateForgeReads = () => forgeAuth.invalidate();
const forgeOwners = new WeakSet();
installForgeAuthHandlers({ ipc: ipcMain, broker: forgeAuth, rendererUrl: RENDERER_URL, wireOwner: owner => {
  if (forgeOwners.has(owner)) return; forgeOwners.add(owner);
  const drop = () => forgeAuth.dropOwner(owner);
  owner.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => { if (isMainFrame && !inPlace) drop(); });
  owner.on('render-process-gone', drop); owner.once('destroyed', drop);
} });

// ---- IPC: integrated terminal (leased linked-window viewers) ------------
// The shared broker owns process-wide reservations, document principals,
// current-owner output and confirmed cleanup. No numeric-ID IPC lane.
const terminalContext = () => serverHost.inTransition() ? null : `${serverEpoch}:${base()}`;
// A terminal opens only from a frame whose hash is the workspace main binds its window to (holdsHash), or from
// one with no hash that is still adopting its first workspace: a window a take-over moved its workspace away
// from, or one with no workspace (choosers), opens none.
const terminalFrame = (e) => {
  const id = (() => { try { return frameWorkspace(e?.senderFrame?.url, RENDERER_URL); } catch { return undefined; } })();
  const win = BrowserWindow.fromWebContents(e.sender);
  if (id === null) return !choosers.has(win);
  return typeof id === "string" && holdsHash(win, id);
};
const terminalBroker = createTerminalOwnerBroker({ rendererUrl: RENDERER_URL, context: terminalContext, admitFrame: terminalFrame,
  io: createTerminalIo({ base, context: terminalContext,
    attachmentDirectory: () => join(app.getPath('userData'), 'attachments'),
    spawnPty: (...args) => pty.spawn(...args), execFileSync, sweep: sweepOrphanViewers,
  }),
});
invalidateTerminalPreparations = () => terminalBroker.invalidatePreparations();
installTerminalHandlers(ipcMain, terminalBroker);

const tmuxRun = (args) => execFileSync("tmux", args, { stdio: "ignore", timeout: 4000, env: cliEnvironment(process.env) });

/** Sweep crashed Desktop viewers on one socket (dead oatsdesk-<pid>- owners only).
 * Startup/quit sweep the default socket; opening a terminal also sweeps its
 * saved socket. Normal close/quit uses each viewer's own scoped cleanup. */
function sweepOrphanViewers(socket) {
  try {
    const prefix = tmuxSocketArgs(socket);
    const read = (args) => execFileSync("tmux", [...prefix, ...args], { encoding: "utf8", timeout: 4000, env: cliEnvironment(process.env) });
    const swept = sweepViewers({
      // The tables first, then the sessions (sweepViewers says why).
      listTables: () => listedTables(read(["list-keys"])),
      listSessions: () => read(["list-sessions", "-F", "#{session_name}"]).split("\n").filter(Boolean),
      killSession: (name) => tmuxRun([...prefix, "kill-session", "-t", `=${name}`]),
      pidAlive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
      emptyTable: (table) => tmuxRun([...prefix, "unbind-key", "-a", "-q", "-T", table]),
    });
    if (swept.length) console.log(`oats-desktop: swept ${swept.length} orphaned viewer session(s): ${swept.join(", ")}`);
  } catch { /* no tmux server — nothing to sweep */ }
}

// ---- window -------------------------------------------------------------
// Application menu policy lives in app-menu.mjs (pure, unit-tested):
// role menu on macOS only (Cmd accelerators cannot collide with terminal
// Ctrl chords); NO menu elsewhere — role menus on Linux/Windows register
// Ctrl accelerators that steal xterm's terminal control keys (review
// befe75b important 1), and Chromium handles clipboard shortcuts natively.
function installAppMenu() {
  const template = appMenuTemplate(process.platform, { newWindow: () => openNewWindow() });
  Menu.setApplicationMenu(template ? Menu.buildFromTemplate(template) : null);
}

// ---- windows: one per workspace (#481) ----------------------------------
// window-set.mjs holds at most one window per workspace view id; a window's
// workspace is its renderer URL's #ws= (renderer/window-binding.mjs).
// windows.json (window-records.mjs) brings them back at the next launch.
const WINDOWS_FILE = () => join(app.getPath("userData"), "windows.json");
const windows = createWindowSet({ create: (key, record) => createWindow(key, record), onChange: () => noteWindowViews() });
let windowRecords = null; // created at startup, once userData is known
// Windows with no workspace to read: a New Window, or a window left choosing. Their first claim never
// takes the shared default (they show the switcher), and they get no workspace's data until they bind.
const choosers = new WeakSet();
/** A window's bounds and state, as a record keeps them. */
const windowState = (win) => ({ bounds: win.getNormalBounds(), maximized: win.isMaximized(), fullscreen: win.isFullScreen() });
const served = (key) => typeof key === "string" && advertisedNow().has(key);
/** The view a served selector names (a deployment id is answered with the view that holds it, as the
 * server's viewFor does): the one key a workspace's window is registered under. */
const viewKey = (id) => resolveView(id, servedList) ?? id;
/** Whether main binds `win` to the workspace `id` its frame's hash names: the same key, or one view by
 * the served list (a deployment id and the view that holds it, #482). False for a window main binds to
 * nothing or to another workspace: a take-over moved it while the page had not followed yet. */
function holdsHash(win, id) {
  const key = win ? windows.keyOf(win) : undefined;
  return typeof key === "string" && typeof id === "string" && (key === id || viewKey(key) === viewKey(id));
}
/** Bind a window to a workspace: its record and title follow (a restored record is rewritten to the view, Q6). */
function bindWindow(win, key) {
  windowRecords?.bind(win, key, windowState(win), servedList);
  win.setTitle(windowTitle(key, servedList));
}
/** Open (or focus) the workspace's window; a restored record brings its bounds. */
function openWorkspaceWindow(key, record = null) {
  const result = windows.open(key, record);
  if (result.opened) {
    if (record) windowRecords?.adopt(result.win, record);
    bindWindow(result.win, key);
  }
  return result;
}
/** File → New Window, the palette's New Window: a window with no workspace, showing the switcher. */
function openNewWindow() {
  const win = windows.openUnbound();
  choosers.add(win);
  return win;
}
/** Launch and macOS `activate`: every recorded window whose workspace is served, plus the launch's own
 * deployment; with none, one window that takes the shared default, as before. With no local deployment
 * served that window chooses from the start (#518): it never adopts or binds what the server answers. */
function restoreWindows(launchKey = null) {
  for (const { key, record } of restorePlan(windowRecords?.records() ?? [], servedList)) openWorkspaceWindow(key, record);
  if (launchKey) openWorkspaceWindow(launchKey);
  if (windows.entries().length) return;
  if (workspaceDirs.length) windows.openUnbound();
  else openNewWindow();
}

// A window binding itself in place (a switch, or a view that moved under it). A deployment id binds
// the view that holds it, and a success names the workspace bound (`workspace`). `id` null leaves it
// unbound. A workspace another window holds is refused: that window is focused (`focused-other`),
// or not when `focus` is false (`open-elsewhere`). A New Window's first claim of the shared default
// (`initial`) is refused with `choose`: it shows the switcher instead. A default the server does not
// serve is refused with `not-served`. A refusal carries the served choices (the switcher's list), so
// a window left choosing reads no workspace to offer them. `takeOver`: see takeOverWorkspace above.
// A take-over (a pick from the list of workspaces, a view's workspace select, going to an instance in
// another workspace): a workspace another window holds moves to the asking window instead of being
// refused, and the holder is never focused. Main asks the holder to release it
// (window:release-workspace, answered once with window:release-answer) and moves the binding when it
// answers or after RELEASE_WAIT_MS, whichever comes first. Its answer may hand over the workspace's layout
// (its terminals and its split: renderer/layout-handover.mjs), which goes on to the asking window when it is
// valid, whole, and never in part. The holder is then bound to nothing: it
// leaves that workspace whenever its renderer runs, on time or late (views/common.mjs
// leaveTakenWorkspace), closing its tabs of it and showing its previous workspace, else the switcher.
const RELEASE_WAIT_MS = 2000;
const releases = new Map(); // request id -> { holder, settle(payload) }
let releaseRequests = 0;
/** Ask `holder` to release `key`; resolves with its answer's payload, or null when it did not answer in time. */
function askRelease(holder, key) {
  return new Promise((resolve) => {
    const request = ++releaseRequests;
    let timer = null;
    const settle = (payload) => {
      if (!releases.has(request)) return;
      releases.delete(request); clearTimeout(timer); resolve(payload);
    };
    releases.set(request, { holder, key, settle });
    timer = setTimeout(() => settle(null), RELEASE_WAIT_MS);
    try { holder.webContents.send("window:release-workspace", { request, workspace: key, workspaces: servedList }); }
    catch { settle(null); }
  });
}
/** The layout a holder's answer hands over: `{ layout }` with a descriptor renderer/layout-handover.mjs
 * accepts, else none. An answer of any other shape is refused whole, never in part; the take-over still
 * happens, without it. */
const handedLayout = (answer) => (answer !== null && typeof answer === "object" && !Array.isArray(answer)
  && Object.keys(answer).length === 1 && validLayout(answer.layout) ? answer.layout : null);
async function takeOverWorkspace(win, key) {
  const from = windows.windowOf(key);
  const layout = from && from !== win ? handedLayout(await askRelease(from, key)) : null;
  const result = windows.takeOver(win, key, from);
  if (!result.ok) return { ...result, workspaces: servedList };
  const released = result.released;
  if (released && !released.isDestroyed()) {
    choosers.add(released); // it has nothing to read until it binds again
    windowRecords?.close(released, { served: true }); // the workspace's record is the asking window's now
    released.setTitle(windowTitle(null, servedList));
  }
  choosers.delete(win);
  bindWindow(win, key);
  return { ok: true, workspace: key, ...(layout ? { layout } : {}) };
}
// The holder's answer to a release: accepted once, from the window asked, for a request still open.
ipcMain.handle("window:release-answer", (e, request, payload) => {
  if (!trustedForgeFrame(e, RENDERER_URL)) return { ok: false, code: "forbidden" };
  const win = BrowserWindow.fromWebContents(e.sender);
  const pending = Number.isSafeInteger(request) ? releases.get(request) : undefined;
  if (!win || !pending || pending.holder !== win) return { ok: false, code: "unknown-request" };
  pending.settle(payload ?? null);
  return { ok: true };
});
ipcMain.handle("window:claim-workspace", (e, id, options) => {
  if (!trustedForgeFrame(e, RENDERER_URL)) return { ok: false, code: "forbidden" };
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || windows.keyOf(win) === undefined) return { ok: false, code: "unknown-window" };
  if (options?.initial === true && choosers.has(win)) return { ok: false, code: "choose", workspaces: servedList };
  if (id === null) {
    windows.unbind(win);
    choosers.add(win); // it has nothing to read until it binds again
    windowRecords?.close(win, { served: false }); // the record stays; the window no longer owns it
    win.setTitle(windowTitle(null, servedList));
    return { ok: true };
  }
  if (!validWorkspaceId(id)) return { ok: false, code: "bad-workspace" };
  // The shared default is taken only while the server serves it; otherwise the window reads with
  // the verified workspace and adopts the one served, as before, then binds that.
  if (options?.initial === true && !served(id)) return { ok: false, code: "not-served" };
  const key = viewKey(id);
  // A holder claiming the workspace main is asking it to release: its page loaded or reloaded since the
  // ask (a just-opened window, a Reload), so the ask's answer will never come. The release settles now,
  // without a layout, and the window does not keep the workspace: it chooses, as it would have on the answer.
  if (options?.takeOver !== true) {
    for (const pending of releases.values()) {
      if (pending.holder !== win || viewKey(pending.key) !== key) continue;
      pending.settle(null);
      return { ok: false, code: "open-elsewhere", workspaces: servedList };
    }
  }
  if (options?.takeOver === true && options?.initial !== true) return takeOverWorkspace(win, key);
  const result = windows.claim(win, key, { focus: options?.focus !== false });
  if (!result.ok) {
    // A first claim refused because another window has the default: this window chooses from now on.
    if (options?.initial === true) choosers.add(win);
    return { ...result, workspaces: servedList };
  }
  choosers.delete(win);
  bindWindow(win, key);
  return { ok: true, workspace: key };
});
// The served choices, re-read now, for a window with no workspace (#521): its list follows the
// workspaces served after its first claim (remote views arrive seconds after launch), while it reads no
// workspace's data itself. Read-only: it binds nothing.
ipcMain.handle("window:choices", async (e) => {
  if (!trustedForgeFrame(e, RENDERER_URL)) return { ok: false, code: "forbidden" };
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || windows.keyOf(win) === undefined) return { ok: false, code: "unknown-window" };
  await panelWorkspaces();
  return { ok: true, workspaces: servedList };
});
// Open in new window, and New Window (`id` null): the workspace's window is focused if it has one.
ipcMain.handle("window:open-workspace", (e, id) => {
  if (!trustedForgeFrame(e, RENDERER_URL)) return { ok: false, code: "forbidden" };
  if (id === null) { openNewWindow(); return { ok: true, opened: true }; }
  if (!validWorkspaceId(id)) return { ok: false, code: "bad-workspace" };
  const result = openWorkspaceWindow(viewKey(id));
  return { ok: true, ...(result.opened ? { opened: true } : { focused: true }) };
});

function createWindow(workspaceId, record = null) {
  const bounds = record ? clampBounds(record.bounds, screen.getAllDisplays()) : null;
  const win = new BrowserWindow({
    ...(bounds ?? { width: 1400, height: 900 }),
    title: windowTitle(workspaceId, servedList),
    backgroundColor: "#16161e",
    webPreferences: {
      preload: join(HERE, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs require() for contextBridge; renderer stays isolated
      additionalArguments: [...omarchyArguments],
    },
  });
  // Register hooks before loadFile or any terminal request/preparation.
  terminalBroker.register(win.webContents);
  if (record?.maximized) win.maximize();
  if (record?.fullscreen) win.setFullScreen(true);
  // Titles are main's, from the served list (window-records.mjs windowTitle), never the page's.
  win.on("page-title-updated", (event) => event.preventDefault());
  win.on("focus", () => windows.focused(win));
  for (const ev of ["move", "resize", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"]) {
    win.on(ev, () => windowRecords?.update(win, windowState(win)));
  }
  // The operator closing a window whose workspace is served forgets it; quitting forgets nothing, and
  // neither does closing a window whose workspace isn't served (#472).
  win.on("close", () => { if (!quitStarted) windowRecords?.close(win, { served: served(windows.keyOf(win)) }); });
  const scope = String(win.webContents.id);
  win.on("closed", () => { windows.remove(win); suggestionCalls.forget(scope); lastPickChoices.delete(scope); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  // Navigation lock: the window may only ever show our renderer file. Links
  // in future views (markdown) open externally; everything else is
  // denied — a navigated-to page would otherwise inherit the preload bridge.
  win.webContents.on("will-navigate", (event, url) => {
    if (trustedRendererUrl(url, RENDERER_URL)) return;
    event.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
  win.loadFile(join(HERE, "renderer", "index.html"), workspaceId ? { hash: workspaceHash(workspaceId).slice(1) } : {})
    .catch((error) => console.error(`oats-desktop: window did not load: ${error.message}`));
  // Right-click copy for selected transcript/view text (and standard edit
  // actions in editable fields). Menu items come from Electron's editFlags —
  // nothing shows when nothing is applicable.
  win.webContents.on("context-menu", (_event, params) => {
    const items = [];
    if (params.isEditable) {
      items.push({ role: "cut", enabled: params.editFlags.canCut });
      items.push({ role: "copy", enabled: params.editFlags.canCopy });
      items.push({ role: "paste", enabled: params.editFlags.canPaste });
      items.push({ role: "selectAll", enabled: params.editFlags.canSelectAll });
    } else if (params.selectionText.trim()) {
      items.push({ role: "copy", enabled: params.editFlags.canCopy });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
  return win;
}

// A launch's --instance (single-instance.mjs launchInstance), first or repeated: the window of its --dir
// deployment is asked to select that instance (renderer/launch-focus.mjs), with the deployment's id and the
// validated name, or only that the value was not a name. It only selects: main starts, attaches and writes nothing
// for it. A window still loading is asked once its page has loaded (the preload keeps an ask the shell has not
// subscribed to yet).
function selectLaunchInstance(win, instance, dir, report = () => {}) {
  let deployment = null;
  try { deployment = wsValidate(realpathSync(dir))?.id ?? null; } catch { /* gone since */ }
  if (!deployment) { report("--dir is not an OATS deployment"); return; }
  if (!win || win.isDestroyed()) { report("no window"); return; }
  const message = instance.ok ? { deployment, name: instance.name } : { invalid: true };
  const send = () => {
    if (win.isDestroyed()) { report("no window"); return; }
    win.webContents.send("window:focus-instance", message);
    report();
  };
  if (win.webContents.isLoading()) {
    const closed = () => report("no window");
    win.once("closed", closed);
    win.webContents.once("did-finish-load", () => {
      win.removeListener("closed", closed);
      send();
    });
  }
  else send();
}

// A repeated launch (single-instance.mjs): its --dir, or a working directory that is a deployment, is
// admitted through the validated add path and its workspace's window opened or focused.
const openLaunch = createLaunchOpener({
  isDeployment: (dir) => !!wsValidate(realpathSync(dir)),
  admit: async (dir) => {
    const result = await performAdd(dir, true, "launch");
    if (!result?.ok) return null;
    return resolveView(result.workspace.id, (await panelWorkspaces()) ?? servedList);
  },
  open: (key) => openWorkspaceWindow(key).win,
  focusRecent: () => windows.focusRecent(),
  select: selectLaunchInstance,
});
// A repeated launch of another version (an installer replaced while this app runs): after its window is
// opened or focused, a box over that window says so and offers to restart into the launched copy.
const offerVersionRestart = createVersionHandoff({
  running: app.getVersion(),
  ask: (win, box) => (win && !win.isDestroyed() ? dialog.showMessageBox(win, box) : dialog.showMessageBox(box)),
  isRegularFile: (path) => statSync(path).isFile(),
  relaunch: (options) => app.relaunch(options),
  quit: () => app.quit(),
});

const primaryInstance = startSingleInstance(app, (argv, workingDirectory) => {
  const dir = launchDirectory(argv, workingDirectory);
  return openLaunch(dir, launchInstance(argv), createLaunchReporter(argv, dir));
}, async () => {
  await applyLoginPath(); // first: everything below may spawn
  installAppMenu();
  let savedWindows = "[]";
  try { savedWindows = readFileSync(WINDOWS_FILE(), "utf8"); } catch { /* first launch */ }
  windowRecords = createWindowRecords({ file: WINDOWS_FILE(), initial: parseWindowRecords(savedWindows) });
  // A record naming only folders that are not deployments (a window bound to `/`) is dropped: such a
  // folder is never served, so its window could never come back (#518).
  windowRecords.forgetNonDeployments((path) => { try { return existsSync(path) && !wsValidate(realpathSync(path)); } catch { return false; } });
  app.on("will-quit", () => windowRecords.flush());
  sweepOrphanViewers(); // default socket now; saved sockets are swept when opened
  let saved = "[]";
  try { saved = readFileSync(OPEN_WORKSPACES_FILE(), "utf8"); } catch { /* first launch */ }
  workspaceDirs.splice(0, workspaceDirs.length,
    ...restoreWorkspaceDirs(WORKSPACE, saved, (p) => wsValidate(realpathSync(p))));
  // Launching on a workspace (--dir, or a workspace cwd) is an open.
  let launchedPath = null;
  try { const launched = wsValidate(realpathSync(WORKSPACE)); if (launched) { rememberWorkspaceParent(launched.path); launchedPath = launched.path; } } catch { /* not a workspace */ }
  knowDirs([...savedWorkspacePaths(saved), ...workspaceDirs]);
  // A launch from a folder that is not a deployment (a parent folder as the cwd or --dir) opens
  // the saved set and nothing else, and says so (#461).
  const startupIsDeployment = (() => { try { return !!wsValidate(realpathSync(WORKSPACE)); } catch { return false; } })();
  if (!startupIsDeployment) console.log(persistableDirs(workspaceDirs, wsValidate).length
    ? `oats-desktop: ${WORKSPACE} is not an OATS deployment (no oats-local.yaml); opened the saved workspaces instead`
    : `oats-desktop: ${WORKSPACE} is not an OATS deployment (no oats-local.yaml) and no saved workspace could be opened`);
  // Deployments only, and never an empty set over the saved one: a launch from a parent folder
  // must not replace the open set with that folder (#461). A saved deployment that is missing for
  // a moment (a volume not mounted yet) stays saved, served again once it is back (#472).
  const startupSet = startupOpenSet(saved, workspaceDirs, wsValidate);
  openDirs = startupSet.open;
  try {
    await ensureServer();
    // Written only when the launch opened a deployment the saved set lacks.
    if (serverHost.owned() && startupSet.write) saveWorkspaceDirs(OPEN_WORKSPACES_FILE(), startupSet.open);
  }
  catch (e) { console.error(`oats-desktop: ${e.message}`); }
  // This computer's deployments list (#1390): the one-time import, then the launch's own deployment. Then,
  // whether it succeeded or failed, the session resume trigger is armed with the launch's sweep (it reads the
  // registry the import fills).
  void startupDeploymentList(launchedPath).catch((e) => console.error(`oats-desktop: ${e?.message || e}`))
    .finally(() => resumeTrigger.launch());
  // Window activity: visibility flips that are not focus flips, hooked on
  // every window BEFORE the first one exists (focus/blur are app-level below).
  app.on("browser-window-created", (_event, win) => {
    for (const ev of ["show", "hide", "minimize", "restore"]) win.on(ev, noteWindowActivity);
  });
  // The launch's own deployment (--dir, or a cwd that is one) gets its window beside the restored ones.
  const servedViews = (await panelWorkspaces()) ?? [];
  let launchKey = null;
  try { if (startupIsDeployment) launchKey = resolveView(realpathSync(WORKSPACE), servedViews); } catch { /* gone since */ }
  restoreWindows(launchKey);
  // Its --instance, beside a --dir that is a deployment, is selected in that deployment's window.
  const startupInstance = launchInstance(process.argv);
  const reportLaunch = createLaunchReporter(process.argv, WORKSPACE);
  if (startupInstance && launchKey) selectLaunchInstance(windows.windowOf(launchKey), startupInstance, WORKSPACE, reportLaunch);
  else reportLaunch(startupIsDeployment ? "no window" : "--dir is not an OATS deployment");
  // Contract re-probe trigger "app focus": notify the renderer, which calls
  // POST /api/cli/reprobe (the server owns probe state and rate semantics).
  app.on("browser-window-focus", () => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.webContents.isDestroyed()) w.webContents.send("app:focus");
    }
    noteWindowActivity();
  });
  app.on("browser-window-blur", noteWindowActivity);
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) restoreWindows(); });
}, ownLaunch(app), offerVersionRestart);

if (primaryInstance) app.on("window-all-closed", () => { app.quit(); });

// The theme of this computer (#602): read once the app is ready, read again whenever the
// operator comes back to Desktop (which also corrects a missed watch event), closed at quit.
if (primaryInstance) {
  app.whenReady().then(() => hostTheme.start());
  app.on("browser-window-focus", () => hostTheme.refresh());
  app.on("will-quit", () => hostTheme.dispose());
}
// keys.json edited by hand (or by another tool) reaches every window when the operator comes back
// (chord-family.mjs: read again, and handed on only when it changed).
if (primaryInstance) app.on("browser-window-focus", () => chordFamily.refresh());

async function shutdown() {
  try { forgeAuth.dispose(); } catch { /* other resource cleanup must still run */ } // ephemeral gh child only
  // Detach every pty and kill its viewer session (never the durable
  // sessions); stop the server only if we started it; sweep any orphans.
  await terminalBroker.dispose(); // bounded grace for async viewer cleanup, never a fake release
  sweepOrphanViewers();
  serverHost.stop();
}
let quitStarted = false, quitReady = false;
if (primaryInstance) app.on('before-quit', event => {
  if (quitReady) return;
  event.preventDefault();
  if (quitStarted) return;
  quitStarted = true;
  void shutdown().catch(() => { /* quit remains bounded; no raw errors/extra signals */ })
    .finally(() => { quitReady = true; app.quit(); });
});
// Existing quit signals enter the same bounded cleanup path; no extra signal
// or PID fallback is sent to terminals or their durable sources.
for (const sig of primaryInstance ? ["SIGTERM", "SIGINT", "SIGHUP"] : []) {
  process.on(sig, () => app.quit());
}
