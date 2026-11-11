// OATS desktop — renderer shell: nav rail + tabbed view host.
//
// View contract (binding, from the desktop-app contract): each view is an ES
// module in ./views/ exporting mount(el, ctx) / unmount(), where
//   ctx = { api(pathname, opts), openFile(path), openTerminal(instance) }
// The shell owns tabs/navigation and provides ctx. The full functionality
// (hierarchy, spawn, brain, markdown) lives in the ported views — the shell
// chrome stays a thin rail so nothing is duplicated.
// (groupInstances is not imported here: the feature branch renders the
// sidebar roster via clusterInstances — lineage clusters with identity keys.)
import { currentWorkspace, workspaceGeneration, adoptWorkspace, staleWorkspaceSelection, onWorkspaceChange, postJson, rowDeployment, httpError,
  switchWorkspace, startWindow, windowState, onWindowState, choosingWorkspaces, chooseWorkspace, refreshChoices, leaveTakenWorkspace, handedLayout, takenWorkspaceIds,
  landsFocusPlace } from "./views/common.mjs";
import { describeLayout, composeLayout, validLayout } from "./layout-handover.mjs";
import { instanceActions, captureInstanceActionMenu, pendingActionReason } from "./instance-actions.mjs";
import { instanceActionTarget, sameInstanceActionTarget } from "./instance-action-target.mjs";
import { createInstancePrAction } from "./instance-pr-action.mjs";
import { instanceSplitPlan, instanceSplitIdentity } from "./instance-split.mjs";
import { createInstanceStarter } from "./start-instance.mjs";
import { runtimeState } from "../../client/instance-presentation.mjs";
import { NOT_SERVED_CODE, NO_ANSWER_CODE, unservedError, createPendingWatch } from "./deployment-header.mjs";
import { deploymentUnavailableText, keptFailure } from "../../client/deployment-facts.mjs";
import { panelErrorCause } from "../../client/deployment-contract.mjs";
import {
  initTheme, toggleTheme, setTheme, currentTheme, refreshHostTheme, THEMES, xtermTheme, terminalFontWeight, onThemeChange,
  terminalTypography, setTerminalFontSize, setTerminalFontFamily, resetTerminalTypography, onTerminalTypographyChange,
  initFont, setFont, currentFont, onFontChange, fontChoices, fontFallsBack,
} from "./theme.mjs";
import { createPalette } from "./palette.mjs";
import { createInstanceRecency, recencyIdFromTerminalKey } from "./instance-recency.mjs";
import { createQuickOpen } from "./quick-open.mjs";
import { takePickerFocusReturn } from "./overlay-picker.mjs";
import { createSurfaceReturn } from "./surface-return.mjs";
import { createFocusRegions, firstTabbable, isShown } from "./focus-regions.mjs";
import { createFocusPlaces, isTransit } from "./focus-place.mjs";
import { createFileOpener } from "./open-file.mjs";
import {
  registerAction, setActiveContexts, getBinding, onKeymapChange, formatChord, handleKeydown, matchEvent, runAction, keymapConflicts, pickerCycleDirection,
  paletteGroupDirection, paletteGroupHint,
  listActions, readKeyboardLayout, SIDEBAR_KEYS, setChordFamily,
} from "./keybindings.mjs";
import { createChordFamily } from "./chord-family.mjs";
import { createLeader } from "./leader.mjs";
import { createLeaderHint } from "./leader-hint.mjs";
import { createLeaderDispatch } from "./leader-dispatch.mjs";
import { leaderApplies, leaderLabel } from "./leader-keys.mjs";
import { LEADER_TABLE } from "../../client/keymap.mjs";
import { createKeybindingsEditor } from "./keybindings-editor.mjs";
import { createConnections, connectionsCSS } from "./connections.mjs";
import { createTerminalSettings, settingsTerminalCSS } from "./settings-terminal.mjs";
import { createLifecycleDialog, lifecycleCSS } from './lifecycle-dialog.mjs';
import { createForgetDialog, forgetSuccessor } from './forget-dialog.mjs';
import { createInstanceColorDialog, instanceColorCSS } from './instance-color-dialog.mjs';
import { createInstanceBackgroundMenu } from './instance-background-menu.mjs';
import { successorRow } from "./focus-return.mjs";
import { createThemePicker, createFontPicker, themePickerCSS } from './theme-picker.mjs';
import { rosterKeyAction, moveTarget } from "./roster-keys.mjs";
import { createViewLifecycle } from "./view-lifecycle.mjs";
import { reserveKey, whenKeyFree } from "./tab-keys.mjs";
import { createTerminalTab, terminalOptions, fitTerminal, createGlyphRenderer, holdTerminalResizes } from "./terminal-tab.mjs";
import { createSidebarWidth } from "./sidebar-width.mjs";
import { createTerminalAtlasRecovery } from "./terminal-atlas-recovery.mjs";
import { attachClipboardWrite, attachSelectionCopy, copyTerminalSelection } from "./terminal-clipboard.mjs";
import { attachTerminalMouse } from "./terminal-mouse.mjs";
import { createTabChrome, tabKeyAction, focusAfterLastTab, tabNameTailStart, setTabTitle } from "./tab-a11y.mjs";
import { numberTabStrips } from "./tab-numbers.mjs";
import { dotColor, paintDotColor } from "./instance-dot.mjs";
import { revealInStrip } from "./reveal-in-scrollport.mjs";
import { createIntentGate, prepareOwnedOpen, runOpenFlow } from "./open-intent.mjs";
import { createSelectionOwnership, wirePaneSelection } from "./selection-ownership.mjs";
import { createWorkspaceSwitcher } from "./workspace-switcher.mjs";
import { NAV, NAV_TABS, navTab, stageSidebarMode, loadStageView } from "./shell-nav.mjs";
import { shellIcon, mountShellIcons, iconElement } from "./shell-icons.mjs";
import { createSettingsMenu } from "./sidebar-settings.mjs";
import { createRuntimeBadge, identityCSS } from "./identity-marks.mjs";
import { createContextPanel, contextPanelCSS } from "./context-panel.mjs";
import { createInstanceTeamsSection, teamsCSS } from "./instance-teams.mjs";
import { createInstanceSoulSection, instanceSoulCSS } from "./instance-soul.mjs";
import { createInstanceGitPanel, instanceGitCSS } from "./instance-git.mjs";
import { canAddressRemote, rowReason } from "../../client/remote-address.mjs";
import { rowReasonLine, runtimeErrorLine, unsupportedLine, speakerLine, keptFailureLine, heldLine } from "./speaker-line.mjs";
import { createNotificationCenter, notificationCSS } from "./notifications.mjs";
import { createHostTheme } from "./host-theme.mjs";
import { createSpawnJobs } from "./spawn-jobs.mjs";
import { createSpawnFollow, watchOperator } from "./spawn-follow.mjs";
import { createLaunchFocus } from "./launch-focus.mjs";
import { registerSpawnDialogKeys } from "./spawn-dialog-keys.mjs";
import { revealInScrollport } from "./reveal-in-scrollport.mjs";
import { createRosterTip, rosterTipFacts, rosterTipCSS } from "./roster-tip.mjs";
import { waitingClaim, waitingSentence, waitingDetail, waitingClock } from "../../client/waiting-on-you.mjs";
import { syncWaitingRow } from "./waiting-row.mjs";
import { createRosterPrs, prText, rosterPrCSS } from "./roster-pr.mjs";
import { createPanelOwner } from "./panel-owner.mjs";
import { collapseKey, instanceRepoLabel, instanceVisibleInTree, waitingRollup, instanceId, rosterParentId, heldHome, backgroundPlacement, BACKGROUND_FEATURE } from "../../client/instance-tree.mjs";
import { withParentGate } from "../../client/same-work.mjs";
import { createRetiresInFlight, retiringRows } from "../../client/retire-in-flight.mjs";
import { treeConnectors, treeGuides, captureTreeRenderState, rosterResponseOwns, clusterSeparator, renderRosterCount,
  terminalKey, resolveTerminalOpen, createRosterLoading, rosterSignature, markStaleControl, staleBlocked, ROSTER_STALE_TITLE, rosterName } from "./instance-tree-view.mjs";
import {
  tabVisibleInContext, canActivateTab,
  fallbackTabForContext, restoreTerminalTab,
} from "./workspace-tabs.mjs";
import { createWorkspaceTabMemory } from "./workspace-tab-memory.mjs";
import { retiredTabs, tabShowsRow, otherIncarnation, terminalOrigin } from "./retired-tabs.mjs";
import { notePanel, panelDeployments, deploymentHeading } from "./view-deployments.mjs";
import { deploymentState, rowStale, rosterSectionKey, sidebarSections } from "../../client/roster-sections.mjs";
import { backgroundHeading } from "./background-heading.mjs";
import { cliStatus, onCliChange } from "./views/cli-status.mjs";
import { DESKTOP_TERMS } from "./desktop-terms.mjs";
import { onDeploymentTabRequest } from "./deployment-tabs.mjs";
import { ROSTER_POLL_FOCUSED_MS, rosterPollDue } from "./roster-cadence.mjs";
import { scopedRequest } from "./workspace-routes.mjs";
import { createViewMembership, rehomeMap, rehomeTabs, rehomeActiveTerminals, rehomeCollapsed } from "./workspace-rehome.mjs";
import {
  requestSplit, focusTab, openTabInFocusedGroup, removeSplitTab, isSplitMember, groupOfTab, fillEmptyGroup, resizeSplitGroups,
} from "./split-layout.mjs";
import { splitControlsState } from "./split-controls.mjs";
import { projectSplitDom } from "./split-dom.mjs";

const desk = window.oatsDesktop;
// The font (Omarchy's font or System font; theme.mjs fontStacks) and the terminal size's default, both
// defaulting by whether this is an Omarchy computer (main's check, preload's constant), before the first
// await, so the window's first paint is already in them.
initFont(navigator.platform.includes("Mac"), undefined, { isOmarchy: desk?.isOmarchy === true });
// The chord family (keys.json, which main reads; renderer/chord-family.mjs): asked beside the window's
// start and in place before the window listens to its first key, since the one keydown listener and
// every terminal's key path are installed below these awaits. A change (the Shortcuts page, another
// window, a hand edit seen at app focus) applies at once.
const chordFamily = createChordFamily({ desk, apply: setChordFamily });
const chordFamilyRead = chordFamily.start();
// One window per workspace (#481): settle this window's workspace (its hash, or the shared default
// when no other window has it) before anything reads one. A window left choosing reads nothing.
const windowStart = await startWindow();
await chordFamilyRead;
window.addEventListener("pagehide", () => chordFamily.dispose(), { once: true });
// "This computer" (#602): the stored last host state paints first, synchronously; main's answer and its
// pushes then keep it current, in every window whose choice it is.
const hostTheme = createHostTheme({ desk, storage: (() => { try { return window.localStorage; } catch { return null; } })(), onChange: refreshHostTheme });
// Where no theme was ever chosen: "This computer" on Linux, White elsewhere.
initTheme(hostTheme, navigator.platform.includes("Linux") ? "host" : "light");
hostTheme.start();
window.addEventListener("pagehide", () => hostTheme.dispose(), { once: true });
mountShellIcons(document);
const identityStyle = document.createElement("style");
identityStyle.textContent = identityCSS + contextPanelCSS + teamsCSS + instanceSoulCSS + instanceGitCSS + notificationCSS + connectionsCSS + settingsTerminalCSS + lifecycleCSS + instanceColorCSS + themePickerCSS + rosterTipCSS + rosterPrCSS; document.head.append(identityStyle);
const rosterTip = createRosterTip(document);
// The PR of each local instance's branch (forge-roster), re-read at most once a minute.
const rosterPrs = createRosterPrs({
  request: (ws) => api(`/api/forge-roster?ws=${encodeURIComponent(ws)}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
  onChange: () => renderContextRoster(contextInstances),
});
// Move to background / out of it (#1579; instance-background-menu.mjs): the row menu's items, gated as the route is.
const backgroundMenu = createInstanceBackgroundMenu({ deploymentOf: rowDeployment,
  request: async (row, body) => (await desk.api(`/api/instance-background?ws=${encodeURIComponent(rowDeployment(row))}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).body,
  onGate: () => { if (contextRosterEl && rosterState?.hasData) renderContextRoster(contextInstances); } });
let connectionGeneration = 0;
const connectionListeners = new Set();
const subscribeConnections = fn => { connectionListeners.add(fn); return () => connectionListeners.delete(fn); };
const offForgeChanges = desk.onForgeChanged?.(() => {
  connectionGeneration++;
  for (const fn of [...connectionListeners]) fn();
});
window.addEventListener('pagehide', () => offForgeChanges?.(), { once: true });
const notifications = createNotificationCenter({ document, generation: workspaceGeneration, subscribe: onWorkspaceChange,
  workspace: currentWorkspace, connectionGeneration: () => connectionGeneration, subscribeConnections,
  onIntent: () => { if (!tabOpenIntents.isApplyingFocus()) tabOpenIntents.invalidate(); },
  applyFocus: callback => tabOpenIntents.applyFocus(callback),
  fallbackFocus: () => stableFocusTarget(),
});
window.addEventListener('pagehide', () => notifications.dispose(), { once: true });
hostTheme.attach(notifications.notify); // a host theme that could not be used is said here, once per episode

// ── ctx (shared by all views) ─────────────────────────────────────────────
async function api(pathname, opts) {
  // A window with no workspace sends no workspace-scoped request (#481): Quick Open, a view refreshing
  // on its way out, anything. Main refuses them too; this keeps them from being sent at all.
  if (windowState() === "choosing" && scopedRequest(pathname)) throw Object.assign(new Error("This window has no workspace yet."), { code: "E_NO_WORKSPACE" });
  const r = await desk.api(pathname, opts);
  if (!r.ok) throw httpError(r, pathname);
  return r.body;
}

const ctx = {
  api,
  // Re-add a deployment the server stopped serving, through the normal (main-validated) add (#461).
  reAddWorkspace: typeof window.oatsDesktop?.workspaceAdd === "function" ? (path) => window.oatsDesktop.workspaceAdd(path) : null,
  // Existing broker invalidation covers backend replacement as well as forge
  // account changes. Read views may revoke observations; no new IPC authority.
  connectionGeneration: () => connectionGeneration,
  subscribeConnections,
  hasWorkspaceSwitcher: true,
  // Workspace selections compete with pending shell chooser/tab opens too.
  onSelectionIntent: () => tabOpenIntents.invalidate(),
  // A ticket true while no explicit choice happened since it was taken: an accepted Start/Restart opens
  // its terminal later only while it holds (#525), as a followed spawn does.
  watchSelection: () => tabOpenIntents.watch(),
  notify: notifications.notify,
  notifySpawn: (instance, workspace, epoch) => {
    const target = instanceActionTarget(workspace, instance, { requireBirth: true });
    if (!target || workspace !== currentWorkspace() || epoch !== connectionGeneration) return;
    notifications.notify(`${target.instance} spawned`, {
      descriptor: { kind: 'open-instance', target, connectionEpoch: epoch },
      activate: (descriptor, owns) => openTerminalTab(descriptor.target, { expected: descriptor.target, valid: owns,
        onError: message => { throw new Error(message); } }),
    });
  },
  openFile: (path) => openViewTab("markdown", String(path).split("/").pop(), { path }, `file:${path}`),
  openTerminal: (instance, opts) => openTerminalTab(instance, opts),
  showInRoster: (instance) => showInRoster(instance),
  startInstance: (instance) => openInstanceStart(instance),
  restartInstance: (instance) => openInstanceStart(instance, { restart: true }),
  openBrain: (agent) => openBrainTab(agent),
  // CLI degradation affordances (cli-status.mjs feature-detects both):
  // native binary picker (privileged; main persists the choice) and external
  // link opening (window.open is denied by the shell's window-open handler
  // except for http(s), which routes to the OS browser).
  chooseCliBinary: () => desk.cliPickBinary(),
  openExternal: (url) => window.open(url, "_blank", "noreferrer"),
  // additive shell affordance (views feature-detect it): switch the STAGE
  // to a named sidebar view (stage views are not tabs — see below).
  openView: (name) => showStage(name),
  // #1247: this window's own retires in flight. A view that reads its own roster draws its rows through
  // `retiringRows` and draws them again when `subscribeRetires` says the held set changed.
  retiringRows: (rows) => shownRows(rows),
  subscribeRetires: (fn) => { retireListeners.add(fn); return () => retireListeners.delete(fn); },
};
const openInstanceStart = createInstanceStarter(document, ctx);

// Background spawns (Spec C): a confirmed press in the spawn dialog is handed here and the dialog
// closes; the store runs the transaction, owns the roster's pending rows and the outcome
// notifications, and keeps the draft for Reopen spawn. Repaints are coalesced into one per task.
let spawnRepaint = false;
const spawnJobs = createSpawnJobs({
  post: (ws, body) => postJson(ctx, `/api/spawn?ws=${encodeURIComponent(ws)}`, body),
  notify: notifications.notify,
  notifySpawned: (row, ws, epoch, arrival) => spawnFollow.arrived(row, ws, epoch, arrival),
  reopen: async (job) => {
    const owns = tabOpenIntents.begin();
    let mod;
    try { mod = await import("./views/spawn.mjs"); }
    catch (e) { if (owns()) ctx.notify(`Could not reopen spawn: ${e.message || e}`); return; }
    if (!owns() || currentWorkspace() !== job.workspace) return;
    mod.preselectSpawn({ name: job.soul?.name, agentsRoot: job.soul?.agentsRoot, server: job.soul?.server, draft: job.draft });
    showStage("spawn");
  },
  viewSchedules: async () => {
    const mod = await import("./views/automations.mjs");
    mod.preselectAutomationsTab("schedule");
    await showStage("automations");
  },
  currentWorkspace,
  connection: () => connectionGeneration,
  // Spec D (#383): submitted jobs whose outcome is unknown survive a window reload (no task text, no key).
  storage: (() => { try { return window.sessionStorage; } catch { return null; } })(),
  onChange: () => {
    if (spawnRepaint) return;
    spawnRepaint = true;
    queueMicrotask(() => { spawnRepaint = false; spawnFollow.prune(id => !!spawnJobs.get(id)); if (contextRosterEl && rosterState?.hasData) renderContextRoster(contextInstances); followSpawns(); });
  },
});
// Spec E: a pressed spawn takes the operator to its instance once it runs, unless they acted since the
// press (input, a focus move, a navigation) or an overlay is open; then its row says New until it or its
// tab is first opened. No toast for a success; one polite announcement either way (spawn-follow.mjs).
const spawnFollow = createSpawnFollow({
  watch: () => tabOpenIntents.watch(),
  operator: watchOperator(document),
  overlayOpen: () => modalOpen() || (() => { try { return !!document.querySelector("[popover]:popover-open"); } catch { return false; } })(),
  activeElement: () => document.activeElement,
  currentWorkspace, connection: () => connectionGeneration,
  // Every step of the open, and its terminal's readiness focus, is gated by `valid`. True when the operator
  // was taken there: its terminal is the selected tab, or this open made its tab (addTab selects it at once,
  // before the terminal attaches) and they have moved on since. A refused or superseded open made nothing
  // and selected nothing: the row says New instead.
  open: async (row, workspace, valid) => {
    const target = instanceActionTarget(workspace, row, { requireBirth: true });
    if (!target) return false;
    const key = terminalKey(workspace, target);
    const tabOf = () => { for (const [id, t] of tabs) if (t.kind === "terminal" && t.key === key && !otherIncarnation(t.origin?.incarnation, target.incarnation)) return id; return null; };
    const before = tabOf();
    await openTerminalTab(target, { quiet: true, expected: target, valid, followed: true });
    const after = tabOf();
    return after !== null && (after === activeTab || after !== before);
  },
  markNew: (row, workspace) => spawnJobs.markNew(workspace, row), // its change repaints the roster
  announce: text => { if (contextRosterEl) announceSpawn(text); },
});
// A created instance is awaited: the roster is read at once when a spawn of this workspace is created (#1246:
// the created answer comes once the backend has read that deployment), then at the dialog's former pace
// (700 ms), not the roster's 4 s poll, until the store stops awaiting it (seen, or SPAWN_VISIBLE_WITHIN_MS).
let spawnFollowTimer = 0, spawnFollowReading = false;
const spawnFollowRead = new Set(); // the created jobs a follow read has started since they were created
function followSpawns() {
  const ws = currentWorkspace();
  const created = spawnJobs.rows(ws).map(r => r.id).filter(id => spawnJobs.get(id)?.state === "created");
  for (const id of spawnFollowRead) if (!created.includes(id)) spawnFollowRead.delete(id);
  if (!created.length || spawnFollowReading) return; // a read in flight calls back when it ends
  const fresh = created.some(id => !spawnFollowRead.has(id));
  if (spawnFollowTimer && !fresh) return;
  clearTimeout(spawnFollowTimer); spawnFollowTimer = 0;
  const read = async () => {
    spawnFollowTimer = 0; spawnFollowReading = true;
    for (const id of created) spawnFollowRead.add(id);
    try { await refreshContextRoster(); } finally { spawnFollowReading = false; followSpawns(); }
  };
  if (fresh) void read();
  else spawnFollowTimer = setTimeout(read, 700);
}
ctx.spawnJobs = spawnJobs;
// A trigger's capability source (Automations) opens its capability's page in Workspace. The handoff waits there
// for the catalog; a name the catalog does not list exactly once opens nothing, and says so. A newer tab or view
// choice, or another workspace, made while the Workspace module loads supersedes it, whether the load succeeds or fails.
ctx.openCapability = async (name) => {
  const owns = tabOpenIntents.begin(), workspace = currentWorkspace();
  let mod;
  try { mod = await import("./views/spawn.mjs"); }
  catch (e) { if (owns() && currentWorkspace() === workspace) ctx.notify(`Could not open the capability: ${e.message || e}`); return; }
  if (!owns() || currentWorkspace() !== workspace) return;
  mod.preselectCapability(name, { onMiss: count => ctx.notify(count ? `This workspace lists more than one capability named ${name}. Open it from Workspace.` : `${name} is not in this workspace's capability list.`) });
  await showStage("spawn");
};
ctx.showPendingSpawn = (id) => showPendingSpawn(id);
// Spec E: the press closed the dialog; reveal its pending row (no focus taken) and follow it to its instance.
ctx.followSpawn = (id) => { spawnFollow.follow(id); revealPendingSpawn(id); };
// The spawn dialog's own keys (Mod+Enter, Mod+1–7 in the form's order): listed and rebindable in the editor from the start;
// only the open dialog dispatches them (spawn-dialog-keys.mjs).
registerSpawnDialogKeys();
spawnJobs.recover();
window.addEventListener('pagehide', () => spawnJobs.dispose(), { once: true });

// ── stage: the sidebar-driven main surface ──────────────────────────
// Sidebar items switch the stage view in place; they never create tabs.
// The tab strip is reserved for OPENED ARTIFACTS (terminals, files): things
// you accumulate and close, not places you navigate. Selecting a nav item
// hides the tab layer; activating a tab covers the stage.
const stageHost = document.getElementById("stagehost");
let stage = null;           // { name, life, el, mod }
let stageOp = 0;            // switch generation — a slow mount must not paint over a newer switch

/** Unmount the stage on screen. Resolves to this switch's generation, or null when a newer switch
 * superseded it meanwhile. */
async function closeStage() {
  const myOp = ++stageOp;
  const prev = stage;
  stage = null;
  syncContextPanel(); // hide the old owner before awaiting its unmount
  if (prev) {
    try { await prev.life.close(); } catch (e) { console.error(e); }
    prev.panelOwner?.dispose(); prev.el.remove();
  }
  return myOp === stageOp ? myOp : null;
}

async function showStage(name) {
  // A window with no workspace shows only its choice (#481): no view may read with no workspace.
  if (windowState() === "choosing") { void showChooser(); return; }
  // A destination that is a tab of a page (Machines, of Workspace): that page, on that tab.
  const asTab = navTab(name);
  if (asTab) return openWorkspaceSouls(asTab.tab);
  tabOpenIntents.invalidate(); // navigating away supersedes pending tab selections
  const v = NAV.find((x) => x.name === name);
  setSidebarMode(stageSidebarMode(name));
  setNavActive(name);
  showTabLayer(false);
  if (stage && stage.name === name) return;   // already on this surface
  const myOp = await closeStage();
  if (myOp === null) return;                  // superseded by a faster switch
  let mod;
  try { mod = await loadStageView(name); }
  catch (e) {
    if (myOp !== stageOp) return;
    const notice = document.createElement("div"); notice.className = "placeholder";
    notice.textContent = `${name}: view module failed to load: ${e.message}`;
    stageHost.replaceChildren(notice);
    return;
  }
  if (myOp !== stageOp) return;
  const life = createViewLifecycle(mod, (e) => console.error(e));
  const el = document.createElement("div");
  el.style.height = "100%";
  stageHost.innerHTML = "";
  stageHost.append(el);
  const mounted = stage = { name, life, el, mod };
  mounted.panelOwner = createPanelOwner(contextPanel, mounted, workspaceGeneration);
  syncContextPanel();
  // Re-derive contexts from the CURRENT layer state: the user may have
  // activated a tab while this stage was loading — a late mount completion
  // must not replace the live "tabs" context with a hidden stage context.
  updateActiveContexts();
  try { await life.mounted(el, { ...ctx, rightPanel: mounted.panelOwner }); }
  catch (e) {
    if (myOp !== stageOp || stage !== mounted) return;
    mounted.panelOwner.dispose();
    const notice = document.createElement("div"); notice.className = "placeholder";
    notice.textContent = `${v?.title || name}: mount failed: ${e.message}`;
    el.replaceChildren(notice);
  }
}

/** One window per workspace (#481): a window with no workspace (a New Window, or one whose view moved
 * to a workspace another window has) shows the switcher over an empty state, and reads nothing. Its
 * tabs stay, hidden, until it has a workspace again. */
async function showChooser() {
  tabOpenIntents.invalidate();
  showTabLayer(false);
  if (contextRosterEl) contextRosterEl.hidden = true;
  if (await closeStage() === null || windowState() !== "choosing") return;
  const el = document.createElement("div");
  el.className = "placeholder window-chooser";
  const heading = document.createElement("h2");
  heading.textContent = "Choose a workspace";
  const text = document.createElement("p");
  text.textContent = "This window has no workspace yet.";
  const choose = document.createElement("button");
  choose.type = "button"; choose.className = "primary"; choose.textContent = "Choose a workspace…";
  // With workspaces to show, the button focuses the list; with none served (#518), it opens Add local workspace….
  const chooseOne = () => { if (choosingWorkspaces().length) focusWorkspaceList(); else void workspaceLabel.openModal(choose); };
  choose.addEventListener("click", chooseOne);
  el.append(heading, text, choose);
  stageHost.replaceChildren(el);
  workspaceLabel.choose(choosingWorkspaces());
  // Nothing served, so the list is empty: the window opens the Add dialog at once. Closing it leaves this
  // stage, whose button opens it again.
  chooseOne();
}
onWindowState((state) => {
  if (state === "choosing") { void showChooser(); return; }
  // Bound again (a choice, or an adoption): leaving the choice shows the home surface.
  if (!contextRosterEl?.hidden) return;
  contextRosterEl.hidden = false;
  void showStage("spawn"); // the home surface: Workspace (2026-10-23)
});

/** A stage switch from the keyboard (a chord, the palette, a nav button) keeps focus on a
 * control: where it was when that is still shown (the nav button), else the stage's first
 * control — never <body> after the terminal it was in is hidden (spec F audit). */
async function showStageFocused(name) {
  const op = stageOp, page = navTab(name)?.page ?? name;
  await showStage(name);
  if (stage?.name !== page || tabLayerVisible || (stageOp !== op && stageOp !== op + 1)) return;
  const active = document.activeElement;
  if (!active || active === document.body || !isShown(active)) focusRegions.focusRegion("main");
}

// A request to open one deployment's tab of the Machines tab (the switcher's "Not matched" entries,
// deployment-tabs.mjs) shows that stage; the page itself reads the requested tab.
onDeploymentTabRequest(() => { void showStageFocused("hierarchy"); });

function setNavActive(name) {
  for (const b of navEl.querySelectorAll(".nav-item")) {
    const active = b.dataset.view === name;
    b.classList.toggle("active", active);
    if (active) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
}

function showTabLayer(on) {
  document.getElementById("tabhost").style.display = on ? "" : "none";
  document.getElementById("tabstrip").style.display = on ? "" : "none";
  updateActiveContexts(on);
  if (!on) {
    stageHost.style.display = "";
    activeTab = null;
    updateSplitControls();
    for (const t of tabs.values()) {
      t.tabEl.classList.remove("active");
      t.triggerEl.setAttribute("aria-selected", "false");
      t.triggerEl.tabIndex = -1;
      t.paneEl.classList.remove("active");
      t.paneEl.hidden = true;
    }
  } else {
    stageHost.style.display = "none";
    updateContextTabs();
  }
  syncContextPanel();
}

function updateContextTabs() {
  for (const t of tabs.values()) {
    const visible = tabVisibleInContext(t, sidebarMode, currentWorkspace());
    t.tabEl.hidden = !visible;
  }
}

// ── one contextual sidebar: nav + recursive instance roster ─────────────
let sidebarMode = "overview";
let contextRosterGen = 0;
// The roster read that last handed its rows to the spawn store (#1246): the post-spawn open resolves against it
// instead of reading again, while no later read has started and the workspace is the same. `read` is that read's
// panelReads stamp, which the open keeps (#1237: a newer roster answer still vetoes a retired row).
let shownRoster = null;
let contextRosterEl = null;
let contextInstances = [];
let contextWorkspace = "";
// #1237: the dispatch order of every /api/panel read (the roster's and an open's), and the newest roster answer the
// retired-tab rule ran on ({ read, workspace, panel }): an open whose own read is older than it checks it before its tab.
let panelReads = 0;
let judgedAnswer = null;
// #1247: the retires this window applied (packages/client/retire-in-flight.mjs). The lifecycle dialog begins
// and settles each; a row is held as retiring (Retiring…, its Retire secondary) from the send until an
// observed roster read begun after the answer lands (refreshContextRoster's `landed`), or at once released
// by a refusal. Its mark is the roster's read generation. Every surface draws rows through `shownRows`.
const retires = createRetiresInFlight({ mark: () => contextRosterGen, onChange: () => retiresChanged() });
const retireListeners = new Set();
// The roster's loading state (desktop/loading-states): the controller owns the
// pending skeleton, "Refreshing…", the stale line and Retry; shell owns the
// latest-intent tokens (contextRosterGen / owns()) and calls it only for a
// read it still owns. rosterStale: the last owned read failed with data on
// screen, so Start… and the row's context menu are held until one succeeds.
// rosterSignaturePainted: what the list last painted; an identical poll skips the rebuild.
let rosterState = null;
let rosterStale = false;
let rosterSignaturePainted = null;
// The deployment note ("Reading the deployment…", a kernel refusal): its own truthful state above the rows.
let contextDeploymentNote = null;
// The shown view's deployments (#482, panel.deployments): two or more group the roster by deployment.
let contextDeployments = [];
// Which deployments each served view held, so state under a view id that stops being served can follow
// its deployments to the view that holds them now (workspace-rehome.mjs).
const viewMembership = createViewMembership();
let activeInstanceMenu = null;
const splitOpenState = () => ({ split, activeId: activeTab, tabs, workspace: currentWorkspace(), visible: tabLayerVisible });
const ownsInstanceTarget = target => target?.workspace === currentWorkspace() && contextWorkspace === currentWorkspace()
  && contextInstances.filter(row => sameInstanceActionTarget(target, row, currentWorkspace())).length === 1;
function menuState(value, element) {
  if (value) activeInstanceMenu = value;
  else if (activeInstanceMenu?.element === element) activeInstanceMenu = null;
  updateActiveContexts();
}
const collapsedInstances = new Set();
// #1579: the workspaces whose Background section this window draws open. Closed by default in every new window,
// kept in memory per workspace as a collapse is, and re-homed with the collapsed rows (rehomeWorkspaceState).
const backgroundOpen = new Set();
// The section exists only while this computer's CLI lists the kernel's feature (BACKGROUND_FEATURE): without it
// nothing moves, whatever a row carries. A probe that changes the answer repaints the roster.
const backgroundShown = () => { const features = cliStatus()?.features; return Array.isArray(features) && features.includes(BACKGROUND_FEATURE); };
let backgroundFeature = backgroundShown();
onCliChange(() => {
  if (backgroundShown() === backgroundFeature) return;
  backgroundFeature = !backgroundFeature;
  if (contextRosterEl && rosterState?.hasData) renderContextRoster(contextInstances);
});
// Collapsed agent groups (sidebar group headers), keyed like instances.
const desktopBridge = window.oatsDesktop;
const unavailableWorkspaceService = () => Promise.reject(new Error("Workspace discovery is not available in this desktop service yet."));
// An add that opened its workspace but that this computer's deployments list did not record (#1390): said
// once, and the add is not undone. The window switches to the added workspace right after, which clears
// the notifications, so it is said once that switch is made (or after 3 s, when no switch comes).
const noteUnlisted = (result) => {
  if (result?.ok && result.listed) {
    const name = result.workspace?.name || result.workspace?.path || "the workspace";
    const message = `Opened ${name}. This computer's list of deployments didn't record it: ${result.listed.message || result.listed.code}`;
    let posted = false, timer = null;
    const post = () => { if (posted) return; posted = true; off(); clearTimeout(timer); notifications.notify(message); };
    const off = onWorkspaceChange(() => queueMicrotask(post));
    timer = setTimeout(post, 3000);
  }
  return result;
};
const workspaceLabel = createWorkspaceSwitcher({
  document,
  // Main binds a switch first (#481). A pick from the list always shows the workspace in THIS window: one
  // another window shows moves here (main takes it over from that window, which shows its previous one).
  // `how`: a step's (workspaceStep) focusPlace.
  selectWorkspace: (id, how) => switchWorkspace(id, { ...how, takeOver: true }),
  openInNewWindow: typeof desktopBridge.windowOpenWorkspace === "function" ? (id) => { void desktopBridge.windowOpenWorkspace(id); } : null,
  mac: navigator.platform.includes("Mac"),
  storage: (() => { try { return window.localStorage; } catch { return null; } })(),
  // Its repaint keeps the focus on the row that had it: no new intent (a switch's waiting roster place stays owned).
  applyFocus: fn => tabOpenIntents.applyFocus(fn),
  // Feature-detected while tui-dev lands the approved privileged contract.
  // The final adapter names are intentionally isolated to these three lines.
  discoverSuggestions: desktopBridge.workspaceSuggestions || unavailableWorkspaceService,
  addWorkspace: desktopBridge.workspaceAdd ? (path) => desktopBridge.workspaceAdd(path).then(noteUnlisted) : unavailableWorkspaceService,
  pickWorkspace: desktopBridge.workspacePick ? () => desktopBridge.workspacePick().then(noteUnlisted) : unavailableWorkspaceService,
  onboardWorkspace: desktopBridge.workspaceOnboard ? (token, ref) => desktopBridge.workspaceOnboard(token, ref).then((result) => { noteUnlisted(result?.added); return result; }) : null,
  // The Add dialog's Remove of a row of this computer's list that can't be opened (#1390).
  removeListed: desktopBridge.workspaceRemoveListed || null,
  // After the kernel onboarded and the add selected the new deployment: land
  // on its Workspace view.
  onboarded: () => {
    notifications.notify("Workspace onboarded. The lock is written.");
    void showStage("spawn");
  },
});
window.addEventListener("pagehide", () => workspaceLabel.dispose(), { once: true });
/** The list of workspaces at the sidebar's top (`w`, the leader's `o`, Alt+O / ⌘⌥O, the palette's
 * "Workspace: switch…", the chooser's button): shown (focus mode left, the sidebar back), its current row
 * focused, or the row last focused there. */
function focusWorkspaceList() {
  tabOpenIntents.invalidate();
  contextPanel.setFocusMode(false);
  setSidebarHidden(false);
  workspaceLabel.focusList();
}

// ── keybinding contexts ──────────────────────────────────────────────────────────
// The engine dispatches an action only when its context is active. "tabs"
// is live while the tab layer covers the stage; "stage:<name>" while that
// stage is the visible surface. Views register their own view-local actions
// (context stage:<name>) in mount and dispose them in unmount.
let tabLayerVisible = false;
function updateActiveContexts(tabLayerOn = tabLayerVisible) {
  tabLayerVisible = tabLayerOn;
  const set = new Set();
  if (tabLayerOn) set.add("tabs");
  else if (stage) set.add(`stage:${stage.name}`);
  // The sidebar's plain keys (context `sidebar`, sidebar.key.*): live while focus is in the sidebar
  // (the list of workspaces, its nav, the roster rows, the headings' controls, the foot), never inside an open
  // popup there (an instance row's context menu, the settings cog's menu) and never in an editable field (the sidebar has none since its roster filter
  // went; one added later keeps its own keys), where a rebind to a modified chord would otherwise take the
  // field's own key. Editable as the engine's plain-key guard reads it (keybindings.mjs isEditableTarget).
  const focused = document.activeElement;
  if (focused && document.getElementById("sidebar")?.contains(focused) && !focused.closest('[role="menu"], [role="listbox"]')
    && !/^(INPUT|TEXTAREA|SELECT)$/i.test(focused.tagName || "") && !focused.isContentEditable) set.add("sidebar");
  if (activeInstanceMenu?.element.isConnected && activeInstanceMenu.element.dataset.instanceMenuOpen === 'true' && activeInstanceMenu.element.contains(document.activeElement) && activeInstanceMenu.owns()) set.add('instance-menu');
  setActiveContexts(set);
}

// The sidebar context follows focus.
document.addEventListener("focusin", () => updateActiveContexts());
document.addEventListener("focusout", () => queueMicrotask(() => updateActiveContexts()));

function initContextRoster() {
  contextRosterEl = document.getElementById("instance-roster");
  rosterState = createRosterLoading(document, contextRosterEl, { onRetry: () => { void refreshContextRoster({ user: true }); } });
  renderRosterCount(contextRosterEl.querySelector(".ctx-count"), [], { pending: true });
  // Native pointer/keyboard entry is a newer UI intent, even if no command
  // ran. Retained attachments stay alive.
  const sidebar = document.getElementById("sidebar");
  sidebar.addEventListener("pointerdown", () => tabOpenIntents.invalidate());
  sidebar.addEventListener("focusin", () => {
    if (!tabOpenIntents.isApplyingFocus()) tabOpenIntents.invalidate();
  });
  refreshContextRoster();
}

function setSidebarMode(mode) {
  sidebarMode = mode;
  if (typeof tabs !== "undefined") updateContextTabs();
}

// How long the shown deployment, on this connection, has been without an observation: past
// PENDING_LIMIT_MS the roster says it got no answer instead of waiting silently (#461). The deadline is
// its own timer, so it fires even while a read that never answers holds the single-flight poll.
const rosterPendingWatch = createPendingWatch({ onOverdue: (subject) => rosterOverdue(subject) });

/** The bounded wait ran out for the subject still shown: said now, whatever read is in flight. A later
 * observation of it still lands (the read in flight, or the next poll's). */
function rosterOverdue(subject) {
  const ws = currentWorkspace();
  if (!contextRosterEl || subject !== `${connectionGeneration}\n${ws}`) return;
  failRosterUnserved(NO_ANSWER_CODE, ws);
}

/** A deployment the server does not serve, or keeps answering "pending" for (#461): the failed
 * state names it, with Retry, and Re-add workspace when it is not served. No row of another
 * read stays: the server's answer is not about this deployment. */
function failRosterUnserved(code, ws) {
  if (code === NO_ANSWER_CODE && rosterState?.hasData) {
    // The rows on screen are this deployment's last observation: kept, stale, with the reason.
    rosterState.fail(unservedError(code, ws));
    if (!rosterStale) { rosterStale = true; renderContextRoster(contextInstances); }
    return;
  }
  if (rosterState?.hasData) rosterState.reset();
  contextInstances = []; contextDeploymentNote = null; rosterStale = false; rosterSignaturePainted = null;
  refreshPanelInstance([], ws);
  const action = code === NOT_SERVED_CODE && ws?.startsWith("/") && typeof desktopBridge?.workspaceAdd === "function"
    ? { label: "Re-add workspace", onActivate: () => { void reAddRosterWorkspace(ws); } } : null;
  rosterState?.fail(unservedError(code, ws), { action });
  renderContextRoster([]);
}

/** Re-add through the normal add path (main validates it and restarts the server with the whole set).
 * Latest intent: only the newest Re-add, in the same workspace selection, acts on its outcome, and a
 * failure never replaces an observation that landed meanwhile (the add itself restarts the server). */
let rosterReAddLease = 0;
async function reAddRosterWorkspace(ws) {
  const lease = ++rosterReAddLease, generation = workspaceGeneration();
  rosterState?.begin({ user: true });
  let result;
  try { result = await desktopBridge?.workspaceAdd?.(ws); } catch (error) { result = { ok: false, reason: error?.message }; }
  if (lease !== rosterReAddLease || generation !== workspaceGeneration() || currentWorkspace() !== ws) return;
  if (result?.ok) { noteUnlisted(result); rosterPendingWatch.reset(); void refreshContextRoster({ user: true }); return; }
  if (rosterState?.hasData) return; // a newer observation of this deployment stands
  const error = new Error(`Couldn't re-add ${ws}: ${result?.reason || "the add failed"}`); error.code = NOT_SERVED_CODE;
  contextInstances = []; rosterStale = false; rosterSignaturePainted = null;
  rosterState?.fail(error, { action: { label: "Re-add workspace", onActivate: () => { void reAddRosterWorkspace(ws); } } });
  renderContextRoster([]);
}

/** A view that moved under this window (#482) is followed through main without focusing anything (nor moving
 * the keyboard: the same work under a new id); one another window has leaves this window choosing, its tabs kept (#481). */
async function followView(id) {
  const result = await switchWorkspace(id, { focus: false, focusPlace: false });
  if (!result.ok && result.code === "open-elsewhere") await chooseWorkspace(result.workspaces);
}

/** A window with no workspace reads nothing; its switcher's choices follow what main serves (#521). */
async function refreshChooserChoices() {
  const list = await refreshChoices();
  if (list && windowState() === "choosing") workspaceLabel.choose(list);
}

async function refreshContextRoster({ user = false } = {}) {
  if (!contextRosterEl) return;
  if (windowState() === "choosing") return refreshChooserChoices(); // no workspace: nothing to read
  // A Retry restarts the bounded wait for an answer.
  if (user) rosterPendingWatch.reset();
  const myGen = ++contextRosterGen, read = ++panelReads, connection = connectionGeneration;
  const commitWorkspaceLabel = workspaceLabel.begin();
  const ws = currentWorkspace();
  // A stale dispatch selection (persisted, not among the served choices) is
  // owned like an empty one: the hierarchy may have adopted the served
  // workspace while this request was in flight, and this reply resolves the
  // same selection. A real switch still bumps contextRosterGen and loses.
  const owns = (responseWs = ws, staleDispatch = false) => rosterResponseOwns({
    dispatchWorkspace: ws,
    responseWorkspace: responseWs,
    currentWorkspace: currentWorkspace(),
    dispatchGeneration: myGen,
    currentGeneration: contextRosterGen,
    staleDispatch,
  });
  const listEl = contextRosterEl.querySelector(".ctx-list");
  // The bounded wait (#461) runs from the first read of this deployment, on this connection, that brought
  // no observation: answered "pending", or not answered at all. Any other answer from the server ends it.
  const subject = `${connectionGeneration}\n${ws}`;
  if (rosterPendingWatch.observe(subject, true)) failRosterUnserved(NO_ANSWER_CODE, ws);
  // pending (skeleton after 150ms) without data, refreshing (content stays) with it. A background re-read of
  // a failed roster is not announced again; a Retry, or a changed outcome, is.
  else if (user || rosterState?.state !== "failed") rosterState?.begin({ user });
  let panel;
  try {
    panel = await api(`/api/panel${ws ? `?ws=${encodeURIComponent(ws)}` : ""}`);
  } catch (e) {
    if (owns() && e?.code === NOT_SERVED_CODE) {
      rosterPendingWatch.observe(null, false); // an answer: not served
      failRosterUnserved(NOT_SERVED_CODE, ws);
      // The switcher still offers what the server does serve, with this deployment named as the
      // current choice, so the window is never left without a way to another workspace. A bound
      // window's refusal carries those choices (#481); a window with no workspace yet reads them.
      let served = Array.isArray(e.workspaces) ? { workspaces: e.workspaces } : null;
      if (!served) try { served = await api("/api/panel"); } catch { /* the choices stay as they were */ }
      // A view id no longer served whose deployments another view holds now (a remote that reports
      // another workspace, #482): the window and its state follow them there.
      const moved = served && owns() ? rehomeMap(served.workspaces, viewMembership).get(ws) : null;
      if (moved) { rehomeWorkspaceState(served.workspaces); void followView(moved); return; }
      const current = { id: ws, name: viewMembership.name(ws) || (ws.startsWith("ws:") ? "Workspace" : ws.split("/").filter(Boolean).at(-1) || ws), team: null };
      if (served && owns()) commitWorkspaceLabel(current, Array.isArray(served.workspaces) ? served.workspaces : []);
      return;
    }
    // No answer past the bound (the proxy timed the read out, the bridge is down): said by name.
    if (owns() && rosterPendingWatch.observe(subject, true)) { failRosterUnserved(NO_ANSWER_CODE, ws); return; }
    if (owns()) {
      // With data: stale — the list is kept, its actions disabled, the
      // controller paints "Couldn't refresh instances · observed <age>" + Retry.
      // Without: the controller paints the failed block where the skeleton stood.
      rosterState?.fail(e);
      // The rows are rebuilt once, to disable their actions; a repeat failure keeps them. Without
      // data, the count's pill stops (nothing is loading): the reserved box, empty and still.
      if (rosterState?.hasData && !rosterStale) { rosterStale = true; renderContextRoster(contextInstances); }
      else if (rosterState && !rosterState.hasData) { renderRosterCount(contextRosterEl.querySelector(".ctx-count"), [], { failed: true }); applyRosterPlace(); }
      refreshPanelInstance([], ws);
    }
    return;
  }
  const resolvedWs = panel.workspace?.id || ws;
  const stale = staleWorkspaceSelection(ws, panel);
  if (!owns(resolvedWs, stale)) return;
  if ((!currentWorkspace() || stale) && resolvedWs) {
    adoptWorkspace(resolvedWs);
    tabWorkspace = resolvedWs;
  }
  // Views (#482): state under a deployment id (a selection saved before views, an unattached
  // deployment that matched since) moves to the view that holds it now; the "On …" lines learn the
  // view's deployments, and the roster groups by them.
  rehomeWorkspaceState(panel.workspaces);
  notePanel(panel);
  contextDeployments = panelDeployments(panel);
  commitWorkspaceLabel(panel.workspace, panel.workspaces);
  contextWorkspace = resolvedWs;
  // A failed read with no instances keeps the rows already shown for this workspace (stale), so the
  // previous list survives that reply; every other reply replaces it.
  const previousInstances = contextInstances;
  // "Still reading" is not an empty roster, with or without rows on screen; past the bound it is no answer.
  const pendingRead = panel.deployment?.status === "pending" && !panel.workspace?.remote && !(panel.instances || []).length;
  if (!pendingRead) rosterPendingWatch.observe(null, false); // the server answered
  else if (rosterPendingWatch.observe(subject, true)) { failRosterUnserved(NO_ANSWER_CODE, resolvedWs); return; }
  else if (rosterState?.hasData) { rosterState.cancel(); return; } // the rows stay, as they were
  // The read's failure, if any: the kernel's message with its bounded cause (Spec D). A remote the kernel
  // could not read keeps the last observation (panel.error + errorCause); a cache problem with nothing
  // observed yet is a failed read with that message, never an empty roster.
  const unreadable = !panel.workspace?.remote && panel.deployment?.status === "unavailable" && panel.deployment.reason?.code === "E_REMOTE_UNREADABLE"
    ? panelErrorCause({ code: "E_REMOTE_UNREADABLE", ...(panel.deployment.reason.cause || {}) }) : null;
  // Whether a failure is kept is the shared home's rule (keptFailure), never a test of the message. Either
  // message is shown with who made it (speaker-line.mjs): the kept one by the panel's `errorOrigin`, the
  // unobserved one by its reason's `origin` (the reader's mark, on this computer's own deployment only).
  const kept = keptFailure(panel);
  const failure = kept
    ? { message: keptFailureLine(kept), ...(panelErrorCause(panel.errorCause) ? { code: panel.errorCause.code, cause: panelErrorCause(panel.errorCause) } : {}) }
    : unreadable?.reason === "cache" && typeof panel.deployment.reason.message === "string"
      ? { message: speakerLine(panel.deployment.reason.origin === "kernel" ? "kernel" : null, panel.deployment.reason.message), code: unreadable.code, cause: unreadable } : null;
  if (!(failure && !(panel.instances || []).length && rosterState?.hasData)) contextInstances = panel.instances || [];
  // A deployment the kernel could not observe is not an empty one: name the
  // missing feature or keep the kernel's refusal (never an optimistic read).
  // It is its own truthful state, painted above the rows by renderContextRoster
  // on every path (module state, so a collapse keeps it).
  contextDeploymentNote = panel.deployment && panel.deployment.status !== "observed" && !panel.workspace?.remote && !failure
    ? deploymentUnavailableText(panel.deployment, DESKTOP_TERMS) : null;
  const signature = rosterSignature(contextInstances, {
    workspace: resolvedWs, error: failure, deploymentNote: contextDeploymentNote, deployments: contextDeployments,
    activeKey: tabs.get(activeTab)?.key ?? null, activeIncarnation: tabs.get(activeTab)?.origin?.incarnation ?? null, connection: connectionGeneration,
  });
  // A panel that reports an error is the kernel's failed read, not an observed
  // roster: with instances beside it (a remote server the kernel could not
  // reach, its last roster) the list is kept and goes stale; with none, it is a
  // failed read — the failed block with Retry where the skeleton stood, or the
  // previous rows of this workspace kept and marked stale. Never "No instances.".
  if (failure && !contextInstances.length) {
    refreshPanelInstance([], resolvedWs);
    rosterState?.fail(failure);
    if (rosterState?.hasData && !rosterStale) { rosterStale = true; renderContextRoster(previousInstances); }
    else if (rosterState && !rosterState.hasData) { renderRosterCount(contextRosterEl.querySelector(".ctx-count"), [], { failed: true }); applyRosterPlace(); }
    return;
  }
  const reportedFailure = !!failure;
  // Before the server's first observation the panel says deployment "pending"
  // with no instances: that is not an observed empty roster. The note is the
  // whole content (its existing copy, no skeleton), the count keeps its pill,
  // and the controller stays without data until an observation lands.
  if (panel.deployment?.status === "pending" && !panel.workspace?.remote && !contextInstances.length && !rosterState?.hasData) {
    rosterState?.defer();
    refreshPanelInstance(contextInstances, resolvedWs);
    if (signature !== rosterSignaturePainted) { rosterSignaturePainted = signature; renderContextRoster(contextInstances); }
    return;
  }
  const unchanged = !!rosterState?.hasData && signature === rosterSignaturePainted && rosterStale === reportedFailure;
  // The controller learns of the data before the paint (hasData gates the
  // empty copy). A reported failure with data already present skips
  // succeed(): its stale line then updates in place instead of being
  // announced anew on every poll.
  // A focused Retry goes with succeed(), before this answer's rows are painted: the failed block's (no row yet:
  // focusFallback holds focus outside the roster) or the stale line's (focusFallback's row is the last answer's,
  // which the paint below may remove). After the paint, a Retry that went (a stale line updated in place keeps
  // its own) leaves focus on a row, else on rosterEntry().
  const focusedRetry = [...contextRosterEl.querySelectorAll(".loading-failed, .loading-notice")]
    .some(el => el.contains(document.activeElement)) ? document.activeElement : null;
  if (rosterState && (!reportedFailure || !rosterState.hasData)) {
    rosterState.succeed({ observedAt: typeof panel.observedAt === "string" ? panel.observedAt : null, empty: !contextInstances.length });
  }
  rosterStale = reportedFailure;
  // #1237: a retired instance's tabs close on this observed answer of the shown workspace, on this connection (a
  // stale or pending answer proves nothing). First, so nothing below repaints or re-binds a closing tab.
  if (!reportedFailure && connection === connectionGeneration) closeRetiredTabs(panel, read);
  // Background spawns: a created instance the roster now reports becomes its real row; outcomes held
  // for this workspace are posted. Only an observed roster counts (never a failed read's last rows).
  if (!reportedFailure && !panel.workspace?.remote) {
    shownRoster = { gen: myGen, read, ws: resolvedWs, instances: contextInstances };
    spawnJobs.observe(resolvedWs, contextInstances);
  }
  void rosterPrs.refresh(panel.workspace?.remote ? null : resolvedWs);
  refreshPanelInstance(contextInstances, resolvedWs);
  if (!unchanged) {
    rosterSignaturePainted = signature;
    renderContextRoster(contextInstances);
  }
  // A launch's --instance waits for an observed read of this computer's rows, painted (launch-focus.mjs).
  if (!reportedFailure && !panel.workspace?.remote) launchFocus.observe(contextInstances);
  if (focusedRetry && !focusedRetry.isConnected && !contextRosterEl.querySelector(".ctx-list")?.contains(document.activeElement)) {
    const entry = rosterEntry();
    if (entry?.matches(".ctx-inst, .ctx-background-toggle")) setRovingRow(entry.closest(".ctx-list"), entry);
    else if (!document.activeElement || document.activeElement === document.body) entry?.focus({ preventScroll: true });
  }
  if (reportedFailure) rosterState?.fail(failure);
  // #1247: an observed read begun after a retire's answer says what the retire left: its row is let go (and the
  // rows drawn again), present or gone. Never a failed read, nor one served while a newer observation runs
  // (`refreshing`: the rows served may predate the answer), and only for a row of a deployment this read observed
  // live (`target.workspace` is the row's deployment, lifecycle-dialog.mjs): another workspace's read, or one whose
  // deployment is stale, not reached or not observed, says nothing of it.
  // A read that lists no deployments (an older server) covers the one it answered for, when it observed it.
  if (!reportedFailure && panel.refreshing !== true) retires.landed(myGen, (target) => {
    if (contextDeployments.length) {
      const deployment = contextDeployments.find((d) => d.id === target?.workspace);
      return !!deployment && deploymentState(deployment).key === "live";
    }
    const observed = !!panel.workspace?.remote || !panel.deployment || panel.deployment.status === "observed";
    return observed && target?.workspace === resolvedWs;
  });
}

/** #1237: close every terminal tab this owned roster answer shows retired (retired-tabs.mjs: the one evidence rule),
 * in every group, through closeTab's own teardown. A background close: it cancels no pending open, its group's
 * successor takes over, and focus moves there only when it was in the closed tab (its trigger or its pane). */
function closeRetiredTabs(panel, read) {
  judgedAnswer = { read, workspace: panel.workspace?.id ?? null, panel };
  for (const id of retiredTabs(tabs, panel)) {
    const t = tabs.get(id), at = document.activeElement;
    const focused = !!at && at !== document.body && (t.triggerEl.contains(at) || t.paneEl.contains(at));
    closeTab(id, focused, { explicit: false, background: true });
  }
}

/** Spec D's roll-up: "N below" on a row whose collapse hides N waiting rows, a shape plus text, never colour
 * alone, with a visually hidden " need input" so the row's accessible name says what the short text means.
 * A waiting row's own mark is its dot (renderContextRoster), not a pill (the product owner, 2026-10-26). */
function needsInputMark(below) {
  const mark = document.createElement("span"); mark.className = "ctx-attn rollup";
  mark.append(iconElement(document, "attention", { size: 10, className: "shell-icon attn-mark" }), `${below} below`);
  const said = document.createElement("span"); said.className = "sr-only"; said.textContent = " need input"; mark.append(said);
  return mark;
}

/** The roster's rows as this window draws them and offers acts on them (#1247): each row of a retire this
 * window has in flight held as retiring (`retireInFlight`), whatever the row says. */
function shownRows(rows) {
  return retiringRows(rows, retires.ids());
}

/** A retire of this window began, was refused or was read after: the roster rows, the instance panel and
 * any view that reads its own roster are drawn again from the rows they hold. */
function retiresChanged() {
  if (contextRosterEl && rosterState?.hasData) renderContextRoster(contextInstances);
  refreshPanelInstance(contextInstances, contextWorkspace || currentWorkspace());
  for (const fn of [...retireListeners]) { try { fn(); } catch { /* a view's repaint changes nothing here */ } }
}

function renderContextRoster(instances) {
  instances = shownRows(instances);
  const listEl = contextRosterEl.querySelector(".ctx-list");
  const restoreTreeState = captureTreeRenderState(listEl);
  // #1579: what had focus in the list, for the Background heading (no instance identity: it keeps its own focus)
  // and for a focused row this paint moves into the closed section (its focus goes to the heading).
  const focusedBefore = listEl.contains(document.activeElement) ? document.activeElement : null;
  const restoreActionMenu = captureInstanceActionMenu(listEl);
  // No read of this subject has succeeded yet (desktop/loading-states): the
  // skeleton or the failed block own the list and the count is a skeleton
  // pill. Rows of the previous subject go; the empty copy is never painted.
  const pending = !!rosterState && !rosterState.hasData, failed = pending && rosterState.state === "failed";
  renderRosterCount(contextRosterEl.querySelector(".ctx-count"), instances, { pending: pending && !failed, failed, stale: rosterStale });
  const ws = contextWorkspace || currentWorkspace();
  // #558: every paint re-syncs the open terminal tabs through the row's own gate, before any early return:
  // a stale paint (an overdue read) or a pending one (a reset subject: no rows yet) clears their cues too.
  syncTabNeedsInput(pending ? [] : instances, ws);
  // The deployment note is painted on every path (poll, collapse, PR change), first in the list.
  const paintNote = () => {
    if (contextDeploymentNote === null) return;
    const note = document.createElement("div"); note.className = "ctx-empty ctx-deployment-note"; note.setAttribute("role", "status");
    note.textContent = contextDeploymentNote;
    listEl.prepend(note);
  };
  if (pending) {
    for (const el of listEl.querySelectorAll(":scope > .ctx-tree-row, :scope > .ctx-group, :scope > .ctx-empty, :scope > .ctx-background")) el.remove();
    paintNote();
    tabOpenIntents.applyFocus(restoreTreeState);
    if (failed) applyRosterPlace(); // its Retry is the roster's landing
    return;
  }
  listEl.innerHTML = "";
  // Background spawns (Spec C): this workspace's pending rows join the layout where the real row will
  // stand (its relation), so the real row replaces them in place. #802: while its job is in flight
  // (spawning, checking) a row the roster reports for its home is still drawn as the pending row, with
  // the roster's facts and the pending row's treatment, so it never flashes to a stopped instance with
  // actions; once the job is not in flight the reported row is the real one. A row the kernel reports
  // `rollbackIncomplete` is the real one at once: the spawn is gone, and its Retire is the way on. The
  // count above stays the kernel's observation only.
  const jobs = ws && ws === currentWorkspace() ? spawnJobs.rows(ws) : [];
  // Only what the kernel decided (name, home, soul, relation): never a guessed runtime state.
  const decided = jobs.map((p) => ({ instance: p.instance, agent: p.agent, agentsRoot: p.agentsRoot, home: p.home,
    ...(p.parentInstance ? { parentInstance: p.parentInstance } : {}), ...(p.siblingInstance ? { siblingInstance: p.siblingInstance } : {}),
    ...(p.background === true ? { background: true } : {}), ...(p.deployment ? { deployment: p.deployment } : {}), pendingSpawn: p }));
  const inFlight = new Map(decided.filter((d) => ["spawning", "checking"].includes(d.pendingSpawn.pending)).map((d) => [instanceId(d), d.pendingSpawn]));
  const reported = new Set(instances.map(instanceId));
  if (inFlight.size) instances = instances.map((i) => inFlight.has(instanceId(i)) && !i.rollbackIncomplete
    ? { ...i, pendingSpawn: inFlight.get(instanceId(i)), reportedSpawn: true } : i);
  const spawning = decided.filter((p) => !reported.has(instanceId(p)));
  if (spawning.length) {
    // #1577: a pending row is this window's own, so the panel stamped no same-work gate on it: it takes its parent's
    // (same-work.mjs `withParentGate`). This Desktop's spawn never passes --same-work, so on a host that declares
    // the feature it draws no parent line, as its reported row will not.
    const all = [...instances, ...spawning], byId = new Map(all.map((i) => [instanceId(i), i]));
    instances = [...instances, ...spawning.map((p) => withParentGate(p, byId.get(rosterParentId(all, instanceId(p))) ?? null))];
  }
  // "since <local time>" on a row setting up its worktree: the start of a job of this window for its home, if any.
  const spawnStart = (i) => {
    const job = i.pendingSpawn || jobs.find((p) => p.home === i.home && p.agentsRoot === i.agentsRoot);
    return Number.isFinite(job?.startedAt) ? job.startedAt : null;
  };
  const rosterGeneration = workspaceGeneration();
  // #1579: the rows the Background section holds, over the rows painted (a pending spawn under a background
  // parent included: it has no flag of its own), only while this computer's CLI lists the feature.
  const placement = backgroundPlacement(instances, backgroundShown());
  // The section each row is painted in: its deployment's (#482), in the main tree or in the Background section
  // (rosterSectionKey). A collapse hides, and rolls up, only rows of its own section, so nothing hides or rolls
  // up across the main tree and the Background section.
  const rowSection = rosterSectionKey(contextDeployments, placement);
  const visible = instances.filter((i) => instanceVisibleInTree(
    i, instances, collapsedInstances, ws, false, { section: rowSection },
  ));
  // A row the roster holds stale (the last read failed, or its deployment's re-read did) carries last-known facts.
  const rowHeldStale = (row) => rosterStale || rowStale(row, contextDeployments);
  // Needs input (Spec D): waiting rows a collapse hides, on their nearest visible ancestor. Derived on every
  // paint over the full roster, so expanding the parent drops it and the children show their own marks.
  const waitingBelow = waitingRollup(instances, collapsedInstances, ws, { stale: rowHeldStale, section: rowSection });
  // The main tree's sections, then the Background section (sidebarSections): null when no row is in it, else its
  // heading's count and wait, and its own tree while it is open. Every row in it may be: then the main tree is
  // empty and the heading is the list.
  const { main, background } = sidebarSections(instances, visible, contextDeployments, DESKTOP_TERMS,
    { placement, open: backgroundOpen.has(ws), stale: rowHeldStale });
  if (!visible.length && !background) {
    listEl.innerHTML = `<div class="ctx-empty">No instances.</div>`;
    paintNote();
    tabOpenIntents.applyFocus(restoreTreeState);
    applyRosterPlace();
    return;
  }
  // Sidebar groups by agent CLUSTER (connected relations), not per repo:
  // the repo is the small label under each instance. Groups read purely
  // from SPACING/STRUCTURE (human re-test: no visible glyph): each group
  // gets an invisible separator that still exposes the group boundary to
  // AT (role=separator + aria-label).
  // Agent groups (Redesign v3): one sequence in name order (#1262), each
  // multi-member relation cluster under its deterministic name and each run
  // of unrelated instances under "independent", in place (rosterGroups,
  // shared with the command palette). A cluster's group is
  // decided on the FULL roster (#971): a collapse decides which
  // rows are drawn and never moves a row to another group, a group with no
  // visible row draws nothing, and a header counts the rows drawn under it.
  // Clusters are computed on the FULL roster then projected to visible
  // members — clustering a filtered subset could forge edges from globally
  // ambiguous names (merged-state review @3e76616).
  // Views (#482): with two or more deployments, each deployment's agent groups sit under its heading
  // (rosterSections); with one, the groups are exactly these clusters and no heading is drawn.
  // #1579: the main tree's groups, then the Background heading at the very end, then (open) the section's own
  // groups, drawn by this one loop: a machine's sub-heading in the section sits a level under the heading.
  // Each part is a tree of its own (sidebarSections), so a cluster's rows (`items`, the connectors' rows) are
  // one part's: no stem, elbow or sibling link reaches a row of the other part.
  const partGroups = (sections, level) => sections.flatMap((section) => section.groups.map((group, at) => ({ ...group, heading: at === 0 && section.deployment ? section : null, level })));
  const groups = [...partGroups(main, 3), ...(background ? [{ background }, ...partGroups(background.sections, 4)] : [])];
  // A row's disclosure counts only children of its own section: a main row whose children are all in the
  // Background section has nothing to collapse here.
  const parentsHere = new Set();
  for (const child of instances) {
    const pid = rosterParentId(instances, instanceId(child)), parent = pid ? instances.find((r) => instanceId(r) === pid) : null;
    if (parent && rowSection(parent) === rowSection(child)) parentsHere.add(pid);
  }
  for (const group of groups) {
    if (group.background) {
      const head = backgroundHeading(document, group.background), toggle = head.querySelector(".ctx-background-toggle");
      toggle.addEventListener("click", () => setBackgroundOpen(ws, !group.background.open));
      toggle.addEventListener("keydown", onRosterRowKey);
      listEl.append(head);
      continue;
    }
    if (group.heading) {
      const { deployment, label, machine, tail, groups: own } = group.heading;
      const head = deploymentHeading(document, { deployment, label, machine, tail, count: own.reduce((n, g) => n + g.clusters.reduce((m, c) => m + c.instances.length, 0), 0) });
      if (group.level > 3) head.setAttribute("aria-level", String(group.level));
      listEl.append(head);
    }
    listEl.append(clusterSeparator(document, { label: group.label, count: group.clusters.reduce((n, c) => n + c.instances.length, 0) }));
    for (const cluster of group.clusters) {
      const items = cluster.instances;
      for (const i of items) {
        // #802: a home the roster reports setting up its worktree (spawned here or anywhere) wears the pending row's treatment too.
        const held = heldHome(i);
        if (i.pendingSpawn || held?.kind === "spawning") { listEl.append(pendingSpawnRow(i, items, instances, spawnStart(i))); continue; }
        const rowWrap = document.createElement("div");
        rowWrap.className = "ctx-tree-row";
        rowWrap.style.setProperty("--depth", String(i.depth || 0));
        // The active terminal tab shows this row: its key and incarnation (#1237: a respawn under the same home is another row).
        const isActive = tabShowsRow(tabs.get(activeTab), ws, i);
        // Collapse and focus state key by IDENTITY, not bare name: two
        // same-named instances from different agents roots collapse and
        // focus independently (review 46f3fdc).
        const key = collapseKey(ws, instanceId(i));
        const hasChildren = parentsHere.has(instanceId(i));
        const collapsed = collapsedInstances.has(key);

        // Design connectors drawn from the dots: rounded solid elbows into
        // children, solid stems/pass-throughs, dotted sibling links.
        const guides = treeGuides(document, treeConnectors(items, i, instances));

        const row = document.createElement("button");
        row.type = "button";
        row.dataset.treeInstance = instanceId(i);
        row.dataset.treeControl = "terminal";
        const state = runtimeState(i);
        row.className = "ctx-inst" + (state === "stopped" ? " idle" : "") + (isActive ? " active" : "");
        rowWrap.classList.toggle("active", isActive);
        if (hasChildren) row.setAttribute("aria-expanded", String(!collapsed));
        // A row that can't open (unknown state, a remote row the kernel does not report addressable) stays
        // focusable (aria-disabled, spec F): its tools and its context menu (Shift+F10, the Menu key: Inspect/Stop/
        // Retire) must stay reachable from the keyboard. Its activation does nothing and says why.
        const unavailable = i.running == null || !canAddressRemote(i);
        // #802: a home a spawn or a retire left half cleaned, or one being retired (#1247; held: the spawning one drew
        // above), opens and starts nothing either; its context menu offers Retire only (secondary while retiring).
        if (unavailable || held) { row.setAttribute("aria-disabled", "true"); row.classList.add("unavailable"); }
        // Why it can't open: a short label on the meta line, the full sentence as its title and description.
        // A sentence that is the row's own text is said with who made it (speaker-line.mjs).
        const reason = rowReason(i);
        const why = rowReasonLine(reason) || heldLine(held) || runtimeErrorLine(i) || (i.running ? `Open ${i.instance} terminal` : `Start ${i.instance}`);
        // Workspace v4: an enabled row explains itself in the hover/focus card; an unavailable one keeps its reason as a title.
        const pr = held || i.server || i.remote ? null : rosterPrs.get(i.home);
        const heldStale = rowHeldStale(i);
        // Needs input: this row's own claim (waitingClaim is the only gate), and the waiting rows hidden under it.
        const claim = waitingClaim(i, { stale: heldStale }), below = waitingBelow.get(instanceId(i)) || [];
        // Spec D (human, 2026-10-20): the name line keeps the name, whole; the roll-up takes the meta line in place
        // of its text (the repository, pull request and branch stay in the hover card, as a held home's do; a row
        // with no card says them in its title and description, and the line keeps its own title). A row's own
        // claim marks its dot instead, so a waiting parent shows both. A held home's state wins that line: its
        // description says the wait. "New" stays beside the name.
        const attn = held || !below.length ? null : needsInputMark(below.length);
        if (unavailable) {
          const replaced = attn ? [instanceRepoLabel(i), pr ? prText(pr) : null, i.branch].filter(Boolean).map(part => ` · ${part}`).join("") : "";
          const said = why + replaced + waitingSentence(claim, below, Date.now()); row.title = said; row.setAttribute("aria-description", said);
        }
        else {
          rosterTip.bind(row, () => rosterTipFacts(i, why, pr, { below, stale: heldStale }));
          // A held home's state takes its meta line over the mark (below): its description says the wait.
          if (held) row.setAttribute("aria-description", why + waitingSentence(claim, below, Date.now()));
        }
        // A waiting row's dot is the needs-input mark (the product owner, 2026-10-26): the --warn disc with its "!"
        // cut out, the only yellow mark (unknown liveness is a --muted bullseye), whatever the liveness, never in the
        // instance's colour. Its words are the visually hidden "Needs input" after the name (a held home's
        // description says the wait), so the row's name reads as it did with the pill.
        const dot = document.createElement("span");
        if (claim) {
          dot.className = "ctx-dot waiting";
          dot.append(iconElement(document, "attention", { size: 10, className: "shell-icon attn-mark" }));
        } else {
          dot.className = `ctx-dot ${state === "running" ? "on" : state === "stopped" ? "off" : "unknown"}`;
          paintDotColor(dot, i, state);
        }
        const copy = document.createElement("span");
        copy.className = "ctx-copy";
        const name = rosterName(document, i.instance);
        const spoken = claim && !held ? document.createElement("span") : null;
        if (spoken) { spoken.className = "sr-only"; spoken.textContent = " Needs input"; }
        // The meta line (the product owner, 2026-10-26): the soul at the left, the repository at the right; the
        // soul is cut first, the repository keeps about 10ch. The branch and the pull request are the hover card's
        // (rosterTipFacts); the pull request's link stays in the row tools.
        const meta = document.createElement("span");
        meta.className = "ctx-meta ctx-soul-repo";
        const soulPart = document.createElement("span"); soulPart.className = "ctx-meta-soul";
        soulPart.textContent = [i.agent, reason?.label].filter(Boolean).join(" · ");
        const repoPart = document.createElement("span"); repoPart.className = "ctx-meta-repo";
        repoPart.textContent = instanceRepoLabel(i) || "";
        meta.append(soulPart, repoPart);
        meta.title = `Soul: ${i.agent || "unknown"}\nRepository: ${instanceRepoLabel(i)}`;
        // #802: a quarantined home reads its state (text, never colour alone) and what finishes it, muted; its
        // repository and branch stay in the hover card.
        const heldLines = [];
        if (held) {
          meta.className = "ctx-meta ctx-spawn-state"; meta.removeAttribute("title"); meta.textContent = held.state;
          // #1247: a retiring home has no hint (nothing to do but wait).
          if (held.hint) { const hint = document.createElement("span"); hint.className = "ctx-meta ctx-held-hint"; hint.textContent = held.hint; heldLines.push(hint); }
        }
        // Spec E: a spawn the operator was not taken to says New (text and a dot, never colour alone)
        // until its row is opened, or its tab is (the first paint where it is the active row).
        if (isActive) spawnJobs.seen?.(ws, i);
        if (attn) { meta.className = "ctx-meta ctx-attn-line"; meta.replaceChildren(attn); }
        const isNew = !!spawnJobs.isNew?.(ws, i);
        if (isNew) {
          const line = document.createElement("span"); line.className = "ctx-name-line";
          const mark = document.createElement("span"); mark.className = "ctx-new";
          const markDot = document.createElement("span"); markDot.className = "ctx-new-dot"; markDot.setAttribute("aria-hidden", "true");
          mark.append(markDot, "New"); line.append(name, mark);
          copy.append(line, ...[spoken].filter(Boolean), meta, ...heldLines);
        } else copy.append(name, ...[spoken].filter(Boolean), meta, ...heldLines);
        row.append(dot, copy);
        if (typeof i.harness === "string" && i.harness) {
          const runtime = createRuntimeBadge(document, i.harness);
          runtime.classList.add("ctx-runtime");
          row.append(runtime);
        }
        // pass the FULL reference: same-named instances in other agents
        // roots must open THEIR tmux session, not the first name match
        // A stale roster (the last read failed) may say running:false for an instance that is running by now:
        // the row's activation (click, Enter) then starts nothing and says why; opening a running row's
        // terminal stays allowed (the maintainer's return on #322).
        // A row of a stale deployment (#482: its last re-read failed) is held the same way.
        const staleStart = heldStale && !i.running;
        if (staleStart) { row.title = ROSTER_STALE_TITLE; row.setAttribute("aria-description", ROSTER_STALE_TITLE); }
        row.addEventListener("click", () => { if (staleStart || unavailable || held) return; spawnJobs.seen?.(ws, i); i.running ? openTerminalTab(i) : openInstanceStart(i); });
        // full keyboard tree operability (roving tabindex; policy in
        // roster-keys.mjs). Enter is the button's native activation.
        row.dataset.rosterChildren = hasChildren ? "1" : "0";
        row.dataset.rosterCollapsed = collapsed ? "1" : "0";
        row.tabIndex = -1;
        row.addEventListener("keydown", onRosterRowKey);
        rowWrap.append(guides, row);
        // Row tools (the PR link, Start…) overlay the row end on hover/focus only.
        const tools = document.createElement("span");
        tools.className = "ctx-row-tools";
        if (pr?.url) {
          const open = document.createElement("button"); open.type = "button"; open.className = "act ctx-pr-open"; open.dataset.verb = "pr";
          open.append(iconElement(document, "external", { size: 13 })); open.title = `Open pull request ${prText(pr)} on GitHub`;
          open.setAttribute("aria-label", `Open ${i.instance}'s pull request ${prText(pr)} on GitHub`);
          open.addEventListener("click", () => ctx.openExternal(pr.url));
          tools.append(open);
        }
        if (i.running === false && !held) {
          const start = document.createElement("button"); start.className = "act ctx-start";
          start.textContent = "Start…"; start.setAttribute("aria-label", `Start ${i.instance}`);
          start.disabled = !canAddressRemote(i);
          if (heldStale) markStaleControl(start);
          start.addEventListener("click", () => { if (!staleBlocked(start)) openInstanceStart(i); });
          tools.append(start);
        }
        const actionTarget = instanceActionTarget(ws, i), menuConnection = connectionGeneration;
        const menuOwner = () => currentWorkspace() === ws && workspaceGeneration() === rosterGeneration && connectionGeneration === menuConnection
          && (!actionTarget || ownsInstanceTarget(actionTarget));
        // The row's context menu (#1559: a right-click, Shift+F10 or the Menu key on the row; no ⋯ button): beside the
        // row, never in its tools, which hide by visibility. A stale roster's or a stale deployment's row holds it:
        // asked, it opens nothing and says why in the hint's line, as the leader's keys do.
        const rowMenu = instanceActions(document, i, {
          row, say: sayInHint, stale: heldStale ? ROSTER_STALE_TITLE : null,
          scope: ws, owner: menuOwner, onMenuState: menuState, onFocusChange: () => updateActiveContexts(), dispatch: runAction,
          shortcut: id => { const chord = getBinding(id, isMac); return chord ? formatChord(chord, isMac) : ''; },
          extra: [
            { action: 'open-split', actionId: 'instance.openSplit', label: 'Open in split', reason: () => !actionTarget ? 'Instance identity is not fully reported.'
              : unsupportedLine(i) || (i.running !== true ? 'No live terminal is reported.' : instanceSplitPlan(splitOpenState()).reason) },
            { action: 'open-pr', actionId: 'instance.openPullRequest', label: 'Open pull request…', reason: !actionTarget ? 'Instance identity is not fully reported.'
              : i.server || i.remote ? 'Remote PR inspection is unavailable; no local fallback.' : '' },
            ...backgroundMenu.items(i, placement),
          ],
          invoke: async (action, instance) => {
            if (currentWorkspace() !== ws || workspaceGeneration() !== rosterGeneration) throw new Error("Workspace changed; select the instance again");
            if (backgroundMenu.handles(action)) return backgroundMenu.run(action, instance);
            if (action === 'open-split') return openTerminalTab(instance, { inSplit: true, expected: actionTarget, valid: menuOwner });
            if (action === 'open-pr') return instancePrAction.open(actionTarget);
            if (action === "start" || action === "restart") { openInstanceStart(instance, { restart: action === "restart" }); return; }
            if (action === "inspect") {
              const owns = tabOpenIntents.begin();
              let mod;
              try { mod = await import("./views/spawn.mjs"); }
              catch (error) { if (!owns()) return; throw error; }
              if (!owns()) return;
              mod.preselectHome(instance); await showStage("spawn"); return;
            }
            // Every menu action is handled above (stop and retire open their plan dialog in
            // instance-actions.mjs). An action without a handler is refused: no request path is
            // ever built from an action's name.
            throw new Error(`Unknown instance action "${action}"`);
          },
          openLifecycle: (operation, instance) => {
            if (currentWorkspace() !== ws || workspaceGeneration() !== rosterGeneration) return;
            openLifecycleDialog(operation, instance, ws);
          },
          openForget: instance => {
            if (currentWorkspace() !== ws || workspaceGeneration() !== rosterGeneration) return;
            openForgetDialog(instance, ws);
          },
          done: () => {},
          report: (headline, { detail } = {}) => {
            if (currentWorkspace() !== ws || workspaceGeneration() !== rosterGeneration) return;
            notifications.notify(headline, { detail });
          },
        });
        // Only what the row holds overlays its end: a running row without a known pull request has no tools.
        if (tools.childElementCount) rowWrap.append(tools);
        rowWrap.append(rowMenu);
        listEl.append(rowWrap);
      }
    }
  }
  paintNote();
  const heading = listEl.querySelector(".ctx-background-toggle");
  // A row (by instanceId) the closed section holds: it is not drawn.
  const closedHere = (id) => !!heading && !background.open && placement.has(id);
  // Polling restores the same logical focus; it must not cancel a pending
  // terminal open from that row as if the user had re-entered the sidebar.
  tabOpenIntents.applyFocus(() => {
    // The heading had focus (its own toggle repaints the list), or a row it now holds closed did. A heading that
    // is gone (its last row moved out or was retired, or the feature was withdrawn) hands the focus to the row
    // drawn last, the one that stood above it, so the focus stays in the roster.
    const toHeading = focusedBefore?.dataset.rosterBackground === "1" || closedHere(focusedBefore?.dataset.treeInstance);
    if (!restoreTreeState() && toHeading) (heading || [...listEl.querySelectorAll(".ctx-inst")].at(-1))?.focus({ preventScroll: true });
    restoreActionMenu();
  });
  rosterTip.sync(listEl);
  // roving tabindex: exactly one row enters the tab order — the focused row
  // when it survived the rebuild, else the selected one (its terminal is the
  // active tab), else the Background heading when the closed section holds the selected one (#1579), else the first
  applyChordTitles(); updateActiveContexts();
  const rowsAfter = [...listEl.querySelectorAll(".ctx-inst, .ctx-background-toggle")];
  const focusedRow = rowsAfter.find((r) => r === listEl.ownerDocument.activeElement);
  const selectedClosed = activeTab != null && instances.some((i) => closedHere(instanceId(i)) && tabShowsRow(tabs.get(activeTab), ws, i));
  const tabbable = focusedRow || rowsAfter.find((r) => r.classList.contains("active"))
    || (selectedClosed ? heading : null) || rowsAfter[0];
  if (tabbable) tabbable.tabIndex = 0;
  applyRosterPlace();
}

/* A pending spawn's row (Spec C): "Spawning…" text and a spinner (never colour alone), announced once;
   it opens nothing and has no instance actions until the real row replaces it. It keeps the real row's
   identity (data-tree-instance), so a focused pending row stays focused across the replacement. An
   unknown outcome reads "Outcome unknown" with a visible Check result (the existing result action).
   #802: a home the roster reports setting up its worktree (spawnInProgress, this window's job or a spawn
   made anywhere) reads "Setting up worktree…" in the same treatment, with no tools, and "since <local
   time>" when a job of this window knows its start (`startedAt`). A row the roster reports (a held home,
   or an in-flight job's home) explains itself in the hover card, with the roster's facts. */
function pendingSpawnRow(i, items, instances, startedAt = null) {
  const p = i.pendingSpawn ?? null, held = heldHome(i), settingUp = held?.kind === "spawning";
  const unknown = !settingUp && !!p && p.pending !== "spawning", checking = unknown && p.pending === "checking";
  const reported = !p || !!i.reportedSpawn;
  const rowWrap = document.createElement("div");
  rowWrap.className = "ctx-tree-row ctx-spawn-row" + (unknown ? " ctx-spawn-unknown" : "") + (p?.revealed ? " ctx-spawn-revealed" : "");
  rowWrap.style.setProperty("--depth", String(i.depth || 0));
  const guides = treeGuides(document, treeConnectors(items, i, instances));
  const row = document.createElement("button");
  row.type = "button";
  row.className = "ctx-inst pending";
  row.dataset.treeInstance = instanceId(i);
  row.dataset.treeControl = "terminal";
  row.dataset.rosterChildren = "0";
  row.dataset.rosterCollapsed = "0";
  row.setAttribute("aria-disabled", "true");
  const why = settingUp ? held.sentence(i.instance) : unknown ? `The outcome of spawning ${i.instance} is not known yet. Check result asks again.`
    : reported ? `${i.instance} is being spawned. It opens once the spawn finishes.` : `${i.instance} is being spawned. It opens once the roster reports it.`;
  row.setAttribute("aria-description", why);
  if (reported) rosterTip.bind(row, () => rosterTipFacts(i, why, null, {}));
  else row.title = why;
  const mark = document.createElement("span");
  mark.setAttribute("aria-hidden", "true");
  mark.className = unknown && !checking ? "ctx-dot unknown" : "ctx-spawn-spinner";
  const copy = document.createElement("span");
  copy.className = "ctx-copy";
  const name = rosterName(document, i.instance);
  const meta = document.createElement("span");
  meta.className = "ctx-meta ctx-spawn-state";
  meta.textContent = settingUp ? held.state : checking ? "Checking result…" : unknown ? "Outcome unknown" : "Spawning…";
  copy.append(name, meta);
  const since = settingUp && startedAt !== null ? waitingClock(startedAt) : "";
  if (since) { const line = document.createElement("span"); line.className = "ctx-meta ctx-held-hint ctx-spawn-since"; line.textContent = `since ${since}`; copy.append(line); }
  row.append(mark, copy);
  row.tabIndex = -1;
  row.addEventListener("keydown", onRosterRowKey);
  rowWrap.append(guides, row);
  if (unknown) {
    const tools = document.createElement("span");
    tools.className = "ctx-row-tools ctx-spawn-tools";
    const check = document.createElement("button");
    check.type = "button"; check.className = "act ctx-start ctx-spawn-check";
    check.textContent = "Check result"; check.setAttribute("aria-label", `Check result for ${i.instance}`);
    check.dataset.treeInstance = instanceId(i); check.dataset.treeControl = "check-result";
    // aria-disabled while checking, not disabled: focus stays on it across the repaint.
    if (checking) check.setAttribute("aria-disabled", "true");
    check.addEventListener("click", () => { if (!checking) void spawnJobs.check(p.id); });
    tools.append(check);
    rowWrap.append(tools);
  }
  if (p && spawnJobs.announce(p.id)) announceSpawn(`Spawning ${i.instance}…`);
  return rowWrap;
}

/* The roster's polite live region for pending spawns (outside the rebuilt list). */
function announceSpawn(text) {
  let region = contextRosterEl.querySelector(":scope > .ctx-spawn-live");
  if (!region) {
    region = document.createElement("div");
    region.className = "loading-sr ctx-spawn-live";
    region.setAttribute("aria-live", "polite");
    contextRosterEl.append(region);
  }
  region.textContent = text;
}

/* #1579: open or close this window's Background section of workspace `ws` (in memory, per workspace) and repaint;
   the heading keeps the focus it had (renderContextRoster restores it). The heading opens and closes it, and an
   explicit ask to see a row (showInRoster, revealPendingSpawn) opens it; passive tab selection, the palette or a
   step to a background row never does. */
function setBackgroundOpen(ws, open) {
  if (open) backgroundOpen.add(ws); else backgroundOpen.delete(ws);
  renderContextRoster(contextInstances);
}

/* Keyboard walk over the rendered roster rows. Every row takes focus, an
   unavailable one included (aria-disabled: its tools stay reachable);
   expanding/collapsing re-renders and the focused instance is restored by
   captureTreeRenderState. */
function onRosterRowKey(e) {
  const btn = e.currentTarget;
  // #1579: the Background heading's disclosure toggles on Enter and Space here, once (its default activation
  // prevented), and takes the tree keys as a collapsible row: Right opens it, Left closes it.
  if (btn.dataset.rosterBackground === "1" && (e.key === "Enter" || e.key === " ") && !e.ctrlKey && !e.altKey && !e.metaKey) {
    tabOpenIntents.invalidate();
    e.preventDefault();
    btn.click();
    return;
  }
  const action = rosterKeyAction(e, {
    hasChildren: btn.dataset.rosterChildren === "1",
    collapsed: btn.dataset.rosterCollapsed === "1",
  });
  if (!action) return;
  tabOpenIntents.invalidate(); // keyboard tree navigation is explicit, not a polling restoration
  e.preventDefault();
  const listEl = contextRosterEl.querySelector(".ctx-list");
  const rows = [...listEl.querySelectorAll(".ctx-inst, .ctx-background-toggle")];
  const at = rows.indexOf(btn);
  const id = btn.dataset.treeInstance; // instanceId(i) — composite identity
  const ws = contextWorkspace || currentWorkspace();
  const focusInstance = (targetId) => {
    const target = [...listEl.querySelectorAll(".ctx-inst")]
      .find((r) => r.dataset.treeInstance === targetId && !r.disabled);
    if (target) setRovingRow(listEl, target);
    return !!target;
  };
  if (action.type === "expand" || action.type === "collapse") {
    if (btn.dataset.rosterBackground === "1") { setBackgroundOpen(ws, action.type === "expand"); return; }
    const key = collapseKey(ws, id);
    if (action.type === "expand") collapsedInstances.delete(key); else collapsedInstances.add(key);
    renderContextRoster(contextInstances);
    focusInstance(id);
    return;
  }
  if (action.type === "parent") {
    if (btn.dataset.rosterBackground === "1") return;
    // rows carry instanceId, so resolve the CURRENT item and its parent by
    // IDENTITY — a bare-name lookup never matches identity-bearing rows
    // (ArrowLeft dead) and is unsafe for duplicate names (review 96b037b)
    const pid = rosterParentId(contextInstances, id);
    // #1579: a root of the Background section (drawn after its heading; a parent it has is in the main tree)
    // steps to the heading, never across to the main tree.
    const cut = rows.findIndex((r) => r.dataset.rosterBackground === "1");
    if (cut >= 0 && at > cut && !(pid && rows.findIndex((r) => r.dataset.treeInstance === pid) > cut)) setRovingRow(listEl, rows[cut]);
    else if (pid) focusInstance(pid);
    return;
  }
  // PageUp/PageDown move by the rows that fit the list.
  const rowHeight = btn.closest(".ctx-tree-row")?.getBoundingClientRect().height || btn.getBoundingClientRect().height;
  const pageSize = rowHeight > 0 ? Math.floor(listEl.clientHeight / rowHeight) : 1;
  const to = moveTarget(action, at, rows.length, pageSize);
  if (to < 0 || to === at) return;
  // Every row takes focus (an unavailable one is aria-disabled, never disabled).
  setRovingRow(listEl, rows[to]);
}

/* Move focus AND the single tab-order slot to `row` (roving tabindex). The list has no visible
   scrollbar: the row (its whole box, so its tools shown on focus too) is revealed inside the list
   only, never by the focus scroll, which can move scrollable ancestors. */
function setRovingRow(listEl, row) {
  for (const r of listEl.querySelectorAll('.ctx-inst[tabindex="0"], .ctx-background-toggle[tabindex="0"]')) r.tabIndex = -1;
  row.tabIndex = 0;
  row.focus({ preventScroll: true });
  revealInScrollport(listEl, row.closest(".ctx-tree-row") || row);
}

/** Select a roster row of this workspace (by server and home) and move keyboard focus to it: through any
 * collapsed ancestor. False when the roster does not list it (yet). #1579: an explicit ask to see the row, so a
 * row the Background section holds opens the section; only the ancestors of its own part are expanded.
 * `read` false (a launch's --instance): only the rows painted now count, the roster is not read again, and the
 * selection is made before this returns, so nothing the person does can come between. */
async function showInRoster(instance, { read = true } = {}) {
  const ws = currentWorkspace();
  const find = () => contextWorkspace === ws ? contextInstances.find(i => (i.server || null) === (instance?.server || null) && i.home === instance?.home) : null;
  if (!find()) {
    if (!read) return false;
    await refreshContextRoster();
  }
  const row = find();
  if (!row || ws !== currentWorkspace() || !contextRosterEl) return false;
  const placed = backgroundPlacement(contextInstances, backgroundShown()), inBackground = placed.has(instanceId(row));
  for (let id = rosterParentId(contextInstances, instanceId(row)), seen = new Set(); id && !seen.has(id) && placed.has(id) === inBackground; id = rosterParentId(contextInstances, id)) {
    seen.add(id); collapsedInstances.delete(collapseKey(ws, id));
  }
  if (inBackground) backgroundOpen.add(ws);
  renderContextRoster(contextInstances);
  const listEl = contextRosterEl.querySelector(".ctx-list");
  const target = listEl && [...listEl.querySelectorAll(".ctx-inst")].find(r => r.dataset.treeInstance === instanceId(row));
  if (!target) return false;
  tabOpenIntents.invalidate(); // an explicit navigation, not a polling restoration
  setRovingRow(listEl, target);
  return true;
}

/* "Show its row" (Spec D): focus a background spawn's pending row, revealing it like showInRoster. */
function showPendingSpawn(id) {
  const target = revealPendingSpawn(id);
  if (!target) return false;
  tabOpenIntents.invalidate(); // an explicit navigation, not a polling restoration
  setRovingRow(target.closest(".ctx-list"), target);
  return true;
}

/* Spec E: after a press, the pending row is revealed and highlighted (its ancestors expanded, scrolled
   into view) without taking focus or cancelling anything pending. Returns the row, or null. #1579: a pending
   row the Background section holds (its own choice, or a background parent) opens the section, as an ask to see
   the row; only the ancestors of its own part are expanded. */
function revealPendingSpawn(id) {
  const ws = currentWorkspace();
  const pending = spawnJobs.rows(ws).find(p => p.id === id);
  if (!pending || !contextRosterEl) return null;
  const all = [...contextInstances, { instance: pending.instance, agent: pending.agent, agentsRoot: pending.agentsRoot, home: pending.home,
    ...(pending.parentInstance ? { parentInstance: pending.parentInstance } : {}), ...(pending.siblingInstance ? { siblingInstance: pending.siblingInstance } : {}),
    ...(pending.background === true ? { background: true } : {}) }];
  const self = all.at(-1);
  const placed = backgroundPlacement(all, backgroundShown()), inBackground = placed.has(instanceId(self));
  for (let pid = rosterParentId(all, instanceId(self)), seen = new Set(); pid && !seen.has(pid) && placed.has(pid) === inBackground; pid = rosterParentId(all, pid)) {
    seen.add(pid); collapsedInstances.delete(collapseKey(ws, pid));
  }
  if (inBackground) backgroundOpen.add(ws);
  spawnJobs.reveal(id);
  renderContextRoster(contextInstances);
  const listEl = contextRosterEl.querySelector(".ctx-list");
  const target = listEl && [...listEl.querySelectorAll(".ctx-inst")].find(r => r.dataset.treeInstance === instanceId(self));
  if (!target) return null;
  revealInScrollport(listEl, target.closest(".ctx-tree-row") || target);
  return target;
}

function showTerminalContext() {
  setSidebarMode("instances");
  refreshContextRoster();
  // Per-workspace active-tab memory: switching back to a workspace restores
  // the terminal that was active there (stale/foreign keys fall back to the
  // most recently opened terminal of the workspace).
  if (split) {
    const focused = split.groups.find(g => g.id === split.focusedGroup);
    if (activateTab(focused?.activeTab ?? null, { keepGroupFocus: true })) return;
  }
  const ws = currentWorkspace();
  const restored = restoreTerminalTab(tabs, ws, wsActiveTerminal.get(ws));
  if (restored) { activateTab(restored[0]); return; }
  // With the tree permanently visible, closing/switching away from the last
  // terminal restores the prior stage surface.
  setSidebarMode(stageSidebarMode(stage?.name));
  showTabLayer(false);
  setNavActive(stage?.name || "spawn");
}

// ── tabs ──────────────────────────────────────────────────────────────────
const tabbar = document.getElementById("tabbar");
const tabhost = document.getElementById("tabhost");
const tabs = new Map(); // id -> { tabEl, triggerEl, closeEl, paneEl, title, key, onClose, onShow, term }
// After a GPU process restart every terminal's glyph atlas is cleared in one pass, hidden tabs included (#1190).
const atlasRecovery = createTerminalAtlasRecovery({ doc: document, terminals: () => [...tabs.values()].flatMap(t => t.term ? [t.term] : []) });
let nextTabId = 1;
let activeTab = null;
const wsActiveTerminal = new Map(); // workspace id -> last-active terminal tab key
const instanceRecency = createInstanceRecency(); // per-machine: when each instance's terminal was last focused (palette order)
const brainIntents = createIntentGate();
// Terminal and artifact opens compete for the same foreground selection.
const tabOpenIntents = createSelectionOwnership({ currentWorkspace, workspaceGeneration });
const instancePrAction = createInstancePrAction({ ctx, beginIntent: () => tabOpenIntents.begin(), currentTarget: ownsInstanceTarget,
  generation: workspaceGeneration, connectionGeneration: () => connectionGeneration, report: message => ctx.notify(message), openExternal: ctx.openExternal });
window.addEventListener('pagehide', () => instancePrAction.dispose(), { once: true });
const contextPanel = createContextPanel({
  document, connectionGeneration: () => connectionGeneration, subscribeConnections,
  createGitPanel: (parent, focus) => createInstanceGitPanel(parent, { ...focus,
    generation: workspaceGeneration,
    connectionGeneration: () => connectionGeneration, subscribeConnections,
    connect: choice => openConnections(choice), openExternal: ctx.openExternal,
    requestForge: (workspace, body) => api(`/api/instance-forge?ws=${encodeURIComponent(workspace)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    // W6 item 4 (#248): preview / send a PR's review threads to this instance's terminal (the server composes the text).
    requestThreads: (workspace, body) => api(`/api/instance-review-threads?ws=${encodeURIComponent(workspace)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    request: (workspace, body) => api(`/api/instance-git?ws=${encodeURIComponent(workspace)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }),
  }),
  // Teams (teams contract): the instance's own teams through its messaging provider's operations.
  createTeamsSection: (host, options) => createInstanceTeamsSection(host, { ...options, generation: workspaceGeneration,
    request: (workspace, body) => api(`/api/capabilities?ws=${encodeURIComponent(workspace)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
  }),
  // Soul tab (W6): the soul as the instance was spawned — its own `oats inspect --home` read.
  createSoulSection: (host, { onPresence }) => createInstanceSoulSection(host, { onPresence, generation: workspaceGeneration,
    request: (workspace, body) => api(`/api/capabilities?ws=${encodeURIComponent(workspace)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
  }),
  // W6 footer: the roster menu's own lifecycle dialogs (plan-backed Stop/Retire, Start/Restart with…).
  lifecycle: {
    start: (instance, workspace) => { if (workspace === currentWorkspace()) openInstanceStart(instance); },
    restart: (instance, workspace) => { if (workspace === currentWorkspace()) openInstanceStart(instance, { restart: true }); },
    stop: (instance, workspace) => { if (workspace === currentWorkspace()) openLifecycleDialog('stop', instance, workspace); },
    retire: (instance, workspace) => { if (workspace === currentWorkspace()) openLifecycleDialog('retire', instance, workspace); },
    forget: (instance, workspace) => openForgetDialog(instance, workspace),
  },
  // Soul tab → the soul in the Workspace view (same hand-off as Quick Open).
  openSoul: async ({ workspace, name, agentsRoot, server }) => {
    const owns = tabOpenIntents.begin();
    let mod;
    try { mod = await import("./views/spawn.mjs"); }
    catch (e) { if (owns()) ctx.notify(`Could not open soul: ${e.message || e}`); return; }
    if (!owns() || workspace !== currentWorkspace()) return;
    // The hand-off is intent-guarded by the view (a newer selection drops it); a miss says why nothing opened.
    const gen = workspaceGeneration();
    mod.preselectSoul({ name, agentsRoot, server, onMiss: count => { if (workspaceGeneration() === gen) ctx.notify(count ? `Several souls are named ${name}; pick it in the Workspace view.` : `${name} is not in this workspace's souls.`); } });
    showStage("spawn");
  },
  onIntent: () => { if (!tabOpenIntents.isApplyingFocus()) tabOpenIntents.invalidate(); },
  applyFocus: callback => tabOpenIntents.applyFocus(callback),
  onFocusModeChange: () => updateSidebarControls(),
  // Focus mode hides the sidebar: focus that was there lands on the active tab, else a stable visible control.
  fallbackFocus: () => stableFocusTarget(),
  // Spec B: instance details open or closed is one per-machine preference, closed until the user opens
  // it ("1" open; absent closed), persisted like oats-desktop-sidebar-hidden and never in a deployment.
  instanceOpen: {
    read: () => localStorage.getItem("oats-desktop-instance-panel-open") === "1",
    write: open => { if (open) localStorage.setItem("oats-desktop-instance-panel-open", "1"); else localStorage.removeItem("oats-desktop-instance-panel-open"); },
  },
  // Closing it with focus inside hands focus to Show instance panel, which appears in its place.
  closedFocus: () => { const show = document.getElementById("show-panel"); return show && !show.hidden ? show : null; },
  onChange: state => updatePanelControl(state),
});
window.addEventListener("pagehide", () => contextPanel.dispose(), { once: true });

/** Show instance panel (Spec B), at the end of the main area's top bar: shown while the panel is
 * closed (or hidden by focus mode) and has something to show. It carries the Developer page's change
 * dot, and says so. Hidden under focus, its focus goes to the panel it opened. */
function updatePanelControl({ present, open, changes }) {
  const show = document.getElementById("show-panel");
  if (!show) return;
  const hide = !present || open, focused = document.activeElement === show;
  show.hidden = hide;
  show.querySelector(".main-edge-dot").hidden = !changes;
  const label = changes ? "Show instance panel, Developer has changes" : "Show instance panel";
  if (show.getAttribute("aria-label") !== label) {
    show.setAttribute("aria-label", label); baseTitles.set(show, label); applyChordTitles();
  }
  // Opened by its chord while it had focus: focus follows into the panel (never <body>).
  if (hide && focused && !contextPanel.focus()) stableFocusTarget()?.focus();
}
/** Projection only: foreground comes from the committed active tab/stage. */
function syncContextPanel() {
  const tab = tabLayerVisible ? tabs.get(activeTab) : null;
  const terminal = tab?.kind === "terminal" && canActivateTab(tab, currentWorkspace());
  contextPanel.setContext({ workspace: currentWorkspace(), owner: tabLayerVisible ? null : stage,
    instance: terminal ? tab.instanceRef : null, key: terminal && tab.instanceRef ? tab.key : null });
}
function activeTabTrigger() { return activeTab != null ? tabs.get(activeTab)?.triggerEl ?? null : null; }
/** Where focus goes when the control holding it disappears: the active tab's trigger when it is shown, else a
 * stable visible control (the sidebar toggle, or Show sidebar, which focus mode and a hidden sidebar
 * show, or Show instance panel), never <body>. */
function stableFocusTarget() {
  const shown = el => {
    if (!el?.isConnected || el.disabled) return false;
    for (let node = el; node; node = node.parentElement) {
      if (node.hidden || node.inert || document.defaultView.getComputedStyle(node).display === "none") return false;
    }
    return true;
  };
  return [activeTabTrigger(), ...["sidebar-toggle", "show-sidebar", "show-panel"].map(id => document.getElementById(id))].find(shown) ?? null;
}
function refreshPanelInstance(instances, workspace) {
  syncTabNeedsInput(instances, workspace); // also on a poll whose roster signature is unchanged (no repaint)
  const tab = tabs.get(activeTab);
  if (!tabLayerVisible || tab?.kind !== "terminal" || tab.workspace !== workspace) return;
  // #1247: the panel's row reads as the roster's does (this window's retires in flight held as retiring).
  const matches = shownRows(instances).filter(instance => tabShowsRow(tab, workspace, instance));
  // Preserve identity, but do not present a retained Running observation as
  // current when the latest roster cannot identify the selected home uniquely.
  if (matches.length === 1) tab.instanceRef = matches[0];
  else if (tab.instanceRef) tab.instanceRef = { ...tab.instanceRef, running: null };
  syncContextPanel();
}
/** Needs input on an open terminal tab (#558). Every roster paint calls this with the painted roster
 * (refreshPanelInstance): each terminal tab of that workspace, in whichever editor group holds it, finds
 * its row by its qualified key (terminalKey: a home, never a bare name) and reads it through the one
 * gate (waitingClaim, with the sidebar's held-stale rule). It MUTATES only the trigger's mark,
 * aria-label and the title's note (setTabTitle: the name and the tab's key stay their writers') — never
 * rebuilds the trigger or the tab — so strip focus, an open tab menu or a drag survive the poll. Cleared
 * (or unknown), the tab gets back exactly the mark and label it was drawn with, and no note. The same pass keeps the dot's colour (instance-dot.mjs) the row's, so a colour set
 * or cleared reaches an open tab; the dot's state stays as it was drawn. The same claim draws the waiting row over the
 * tab's terminal (waiting-row.mjs, #1502), so each group's shown tab carries its own. */
let tabNeedsInputRoster = { instances: [], workspace: null };
function syncTabNeedsInput(instances, workspace) {
  tabNeedsInputRoster = { instances, workspace };
  const now = Date.now();
  for (const tab of tabs.values()) {
    if (tab.kind !== "terminal" || tab.workspace !== workspace) continue;
    const trigger = tab.triggerEl;
    const rows = instances.filter((i) => tabShowsRow(tab, workspace, i));
    const row = rows.length === 1 ? rows[0] : null;
    const claim = row ? waitingClaim(row, { stale: rosterStale || rowStale(row, contextDeployments) }) : null;
    const drawn = tab.needsInputDrawn ??= { mark: trigger.querySelector(":scope > .tab-dot"), label: trigger.getAttribute("aria-label") };
    if (row && drawn.mark) paintDotColor(drawn.mark, row, drawn.mark.classList.contains("on") ? "running" : "stopped");
    let attn = trigger.querySelector(":scope > .tab-attn");
    let label = drawn.label, note = null;
    if (claim) {
      if (!attn) {
        attn = document.createElement("span"); attn.className = "tab-attn"; attn.setAttribute("aria-hidden", "true");
        attn.append(iconElement(document, "alert", { size: 12 }));
        if (drawn.mark?.parentNode === trigger) drawn.mark.replaceWith(attn); else trigger.prepend(attn);
      }
      label = `${drawn.label}, needs input`;
      const detail = waitingDetail(claim);
      note = `Needs input${detail ? `: ${detail}` : ""} since ${waitingClock(claim.since, now)}`;
    } else if (attn) {
      if (drawn.mark) attn.replaceWith(drawn.mark); else attn.remove();
    }
    if (trigger.getAttribute("aria-label") !== label) trigger.setAttribute("aria-label", label);
    setTabTitle(trigger, { note });
    syncWaitingRow(tab.paneEl, claim, now);
  }
}
const workspaceTabMemory = createWorkspaceTabMemory();
let tabWorkspace = currentWorkspace();
let nextPickedFileId = 0;
const fileOpener = createFileOpener({
  document,
  beginIntent: () => tabOpenIntents.begin(),
  report: message => alert(message),
  openFile: (pickedFile, owns) => openViewTab("markdown", pickedFile.name,
    { pickedFile }, `picked-file:${++nextPickedFileId}`, "file", undefined, owns),
});

// ── editor groups: a split of the tab LAYER into persistent groups ─────
// Pure transitions live in split-layout.mjs; the shell owns the DOM through
// projectSplitDom (split-dom.mjs): each group renders its own tab strip and
// pane cell inside #tabhost, the top #tabstrip hides while the split is
// visible, and the flat restore is byte-identical to the non-split shell.
// VS Code semantics: the layout persists across tab switches; new terminal
// tabs open into the FOCUSED group; group focus follows the active tab.
// Terminal FitAddon refit is automatic: each tab's ResizeObserver fires
// when its pane is resized by the layout.
let split = null; // editor-group model (split-layout.mjs) | null
function renderSplit(splitVisible) {
  const generation = workspaceGeneration();
  let cells;
  // Reprojection may restore a moved trigger/input/placeholder's DOM focus.
  // That focusin is not a second selection (including side-effect restores).
  tabOpenIntents.applyFocus(() => projectSplitDom({
    tabhost, tabstrip: document.getElementById("tabstrip"), tabbar,
    actionsEl: tabActionsEl, actionsHome: document.getElementById("tabbar-row"),
    isApplyingFocus: tabOpenIntents.isApplyingFocus,
    onSelectEmpty: (groupId, cell) => {
      if (generation !== workspaceGeneration() || !tabLayerVisible || !splitVisible
          || cell.parentNode !== tabhost) return;
      selectEmptyGroup(groupId); // validates LIVE model membership/emptiness
    },
    onResize: sizes => {
      if (generation === workspaceGeneration() && tabLayerVisible && splitVisible && cells?.length
          && cells.every(cell => cell.parentNode === tabhost
          && split?.groups.some(g => String(g.id) === cell.dataset.group))) split = resizeSplitGroups(split, sizes);
    },
  }, split, splitVisible, [...tabs]));
  cells = [...tabhost.querySelectorAll(":scope > .group-cell")];
  observeTabStrips();
}

// ── the selected tab stays visible (spec F) ──────────────────────────────
// Whenever a tab becomes active, a tab closes, or a strip resizes (window,
// sidebar, panel, split), each strip scrolls its active tab fully into view.
// Only the strip's scrollLeft moves (revealInStrip): never another ancestor.
function tabStrips() {
  return [tabbar, ...tabhost.querySelectorAll(":scope > .group-cell > .group-tabbar")];
}
function revealActiveTabs() {
  for (const strip of tabStrips()) {
    const active = strip.querySelector(":scope > .tab.active:not([hidden])");
    if (active) revealInStrip(strip, active);
  }
}
const tabStripResize = typeof ResizeObserver === "function" ? new ResizeObserver(() => revealActiveTabs()) : null;
// The tabs' numbers (tab-numbers.mjs): any change to a strip's tabs (addTab, closeTab, updateContextTabs'
// hidden flips, the split moving tabs between strips) renumbers every strip. The observer ignores its own
// .tab-num writes, and a pass with nothing to change writes nothing.
const tabNumberObserver = typeof MutationObserver === "function" ? new MutationObserver(records => { if (records.some(r => !r.target.closest?.(".tab-num"))) numberTabStrips(tabStrips()); }) : null;
/** Group strips come and go with the split: observe exactly the current ones, and number them now. */
function observeTabStrips() {
  if (tabNumberObserver) {
    tabNumberObserver.disconnect(); // drops records queued for strips that left; the pass below covers them
    for (const strip of tabStrips()) tabNumberObserver.observe(strip, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
  }
  numberTabStrips(tabStrips());
  if (!tabStripResize) return;
  tabStripResize.disconnect();
  for (const strip of tabStrips()) tabStripResize.observe(strip);
}
observeTabStrips();
// A tab's tooltip names the key its number stands for (tab-numbers.mjs): a rebind of a go-to-tab
// key, or another chord family, changes it.
onKeymapChange(() => numberTabStrips(tabStrips()));

/** Explicit empty-destination selection. Never leave terminal commands aimed
 * at the previously active tab; projection and native focus are separate. */
function selectEmptyGroup(groupId) {
  if (!tabLayerVisible || !split?.groups.some(g => g.id === groupId && !g.tabs.length)) return false;
  tabOpenIntents.invalidate();
  split = { ...split, focusedGroup: groupId };
  return activateTab(null, { keepGroupFocus: true });
}

// ── tab-strip split controls: clickable twins of the split.* actions ──
// The buttons run the SAME registered actions (runAction is context-gated
// exactly like chord dispatch); enablement dry-runs the same model
// transition the actions perform — no duplicated gating logic.
const tabActionsEl = document.getElementById("tab-actions");
for (const [btnId, actionId] of [
  ["split-right", "split.vertical"], ["split-down", "split.horizontal"],
]) {
  document.getElementById(btnId).addEventListener("click", () => runAction(actionId));
}
function updateSplitControls() {
  const t = activeTab != null ? tabs.get(activeTab) : null;
  const s = splitControlsState(split, activeTab, t?.kind ?? null, tabLayerVisible);
  tabActionsEl.hidden = !s.visible;
  document.getElementById("split-right").disabled = !s.splitRow;
  document.getElementById("split-down").disabled = !s.splitCol;
}

function splitPane(orientation) {
  const t = tabs.get(activeTab);
  const controls = splitControlsState(split, activeTab, t?.kind ?? null, tabLayerVisible);
  if (!(orientation === "row" ? controls.splitRow : controls.splitCol)) return; // terminal layer only
  // The first split seeds group 1 with ALL of the layer's current terminal
  // tabs (they stay together — human requirement) and creates a focused
  // empty group; further splits add a group after the focused one.
  const seed = [...tabs]
    .filter(([, tab]) => tab.kind === "terminal" && tab.workspace === currentWorkspace())
    .map(([id]) => id);
  const r = requestSplit(split, orientation, seed, activeTab);
  split = r.split;
  if (!r.changed) return;
  tabOpenIntents.invalidate();
  // A newly focused empty group has no active terminal. Reproject without
  // re-selecting the source tab and silently stealing the destination back.
  const focused = split.groups.find(g => g.id === split.focusedGroup);
  activateTab(focused.activeTab, { keepGroupFocus: true });
  // an empty focused group is filled by picking an instance — take the user there
  if (!focused.tabs.length) focusRoster();
}

function closeSplit() {
  tabOpenIntents.invalidate();
  if (!split) return;
  split = null;
  renderSplit(false); // also clears cells/controls when activeTab is null
  if (!tabLayerVisible) { updateSplitControls(); return; }
  if (activeTab != null) activateTab(activeTab);
  else {
    showTerminalContext(); // join surviving terminals, or return to the stage
    if (activeTab != null) tabs.get(activeTab)?.triggerEl.focus();
    else focusAfterLastTab("terminal", { instancesEntry: rosterEntry() });
  }
  updateSplitControls();
}

/** Return from a stage/file without opening an instance just to recover empty
 * destinations. Explicit, palette-discoverable; no new default shortcut. */
function restoreTerminalGroups() {
  if (!split) return;
  tabOpenIntents.invalidate();
  showTerminalContext();
  if (activeTab == null) tabOpenIntents.applyFocus(() => {
    tabhost.querySelector(".focused-group > .split-empty")?.focus();
  });
}

/** key: optional dedup key — activating an existing tab instead of opening a
 * twin. View modules keep module-level state (they are singletons by design),
 * so one tab per view/file is also a correctness requirement. Callers of a
 * KEYED open must `await whenKeyFree(key)` first: a reopen during a closed
 * tab's deferred cleanup queues behind it instead of being dropped or torn
 * down by the stale lifecycle. */
function onTabKeydown(e, id) {
  // Per-group keyboard navigation: arrows/Home/End walk the strip the tab is in (walkedTabs).
  const visible = walkedTabs(id);
  const at = visible.findIndex(([tid]) => tid === id);
  if (at < 0) return;
  const action = tabKeyAction(e, at, visible.length);
  if (!action) return;
  e.preventDefault();
  if (action.type === "close") { closeTab(id, true); return; }
  const [nextId, tab] = visible[action.index];
  if (selectTab(nextId)) tab.triggerEl.focus();
}

function addTab({ decor = null, title, key, kind = "artifact", workspace = currentWorkspace(), instanceRef = null, origin = null, onClose, confirmClose = null, onShow, focusContent = null, focusOnActivate = false, intent = null, term = null }) {
  if (key) {
    // A terminal tab is one incarnation (#1237): another incarnation's tab under the same key is not this one.
    for (const [tid, t] of tabs) if (t.key === key && !otherIncarnation(t.origin?.incarnation, origin?.incarnation)) {
      if (instanceRef && (!intent || intent())) t.instanceRef = instanceRef;
      if (intent) selectTab(tid, { intent, focusContent: focusOnActivate });
      else activateTab(tid);
      return null;
    }
  }
  const id = nextTabId++;
  const { tabEl, triggerEl, closeEl, paneEl } = createTabChrome(
    document, id, title, navigator.platform.includes("Mac"), decor ?? { kind },
  );
  tabbar.append(tabEl);
  tabhost.append(paneEl);
  // A click is a selection: on the tab that is already active it still reveals the tab's roster row.
  triggerEl.addEventListener("click", () => {
    const again = activeTab === id;
    if (selectTab(id) && again) revealActiveRosterRow(tabs.get(id));
  });
  triggerEl.addEventListener("keydown", (e) => onTabKeydown(e, id));
  closeEl.addEventListener("click", (e) => { e.stopPropagation(); closeTab(id, true); });
  // Pane interaction supersedes pending opens, including an already-active
  // pane. Selection does not force focus: xterm owns native pointer focus.
  wirePaneSelection(paneEl, {
    isVisible: () => tabLayerVisible && !paneEl.hidden && canActivateTab(tabs.get(id), currentWorkspace()),
    isApplyingFocus: () => tabOpenIntents.isApplyingFocus(),
    select: () => selectTab(id),
  });
  tabs.set(id, { tabEl, triggerEl, closeEl, paneEl, title, key, kind, workspace, instanceRef, origin, onClose, confirmClose, onShow, focusContent, term });
  if (intent) selectTab(id, { intent, focusContent: focusOnActivate });
  else activateTab(id);
  return { id, paneEl };
}

/** Explicit selection seam for tab/group commands. Omit intent for a new
 * user action; async opens pass their dispatch ticket (never mint on arrival).
 * focusContent opts into input focus, including a terminal still attaching.
 * Strip/pane navigation leaves DOM focus to its caller/native event. */
function selectTab(id, { focusContent = false, intent = tabOpenIntents.begin() } = {}) {
  if (!intent() || !canActivateTab(tabs.get(id), currentWorkspace())) return false;
  if (focusContent) tabOpenIntents.focus(id, intent);
  // Projection can restore DOM focus after moving a retained pane. Like
  // term.focus(), that synchronous focusin is not a second user selection.
  return tabOpenIntents.applyFocus(() => {
    if (!activateTab(id)) return false;
    if (focusContent) tabs.get(id)?.focusContent?.();
    return true;
  });
}

/** Projection/restoration only — does not create explicit selection or focus
 * intent. keepGroupFocus preserves the destination chosen by a model transition
 * (e.g. the new empty group after splitting). User commands use selectTab. */
function activateTab(id, { keepGroupFocus = false } = {}) {
  const current = tabs.get(id);
  // Hidden is not security: reject every cross-workspace artifact activation at
  // the mutation boundary before its pane can become active/receive input.
  const emptyFocused = id == null && !!split?.groups.some(g => g.id === split.focusedGroup && !g.tabs.length);
  if (!emptyFocused && !canActivateTab(current, currentWorkspace())) return false;
  const before = activeTab; // a stage between two activations clears it (showTabLayer(false))
  activeTab = id;
  if (current?.kind === "terminal" && split && !keepGroupFocus) {
    // Editor-group semantics: an existing member activation moves its
    // group's active tab + group focus; a NEW terminal tab (any open path
    // — roster, palette, quick-open) joins the FOCUSED group. Either way
    // the split persists — switching tabs never dismantles it.
    split = isSplitMember(split, id)
      ? focusTab(split, id).split
      : openTabInFocusedGroup(split, id).split;
  }
  if (current?.kind === "terminal" && current.workspace) {
    wsActiveTerminal.set(current.workspace, current.key);
  }
  // The palette's last-focus order (Spec C): any activation of a terminal tab, and
  // a terminal taking keyboard focus (wirePaneSelection selects its tab), lands here.
  if (current?.kind === "terminal") instanceRecency.record(current.workspace, recencyIdFromTerminalKey(current.workspace, current.key));
  if (current?.kind === "terminal" || emptyFocused) {
    setSidebarMode("instances");
    setNavActive(null);
    refreshContextRoster();
  } else if (current?.kind === "brain") {
    setSidebarMode("souls");
    setNavActive("spawn");
  } else if (current?.kind === "file") {
    if (sidebarMode !== "instances" && sidebarMode !== "souls") setSidebarMode("instances");
    // Workspace restoration sets the remembered context BEFORE activation.
    // Project its nav even when the mode already fits, rather than retaining
    // the stage highlight left by the workspace we just departed.
    setNavActive(sidebarMode === "souls" ? "spawn" : null);
  }
  showTabLayer(true);
  // The split renders for a terminal OR its empty focused destination;
  // activating a non-terminal tab (file/brain)
  // COVERS it without destroying the group state — the split re-materializes
  // when the user returns to a terminal tab.
  const splitVisible = !!split && (current?.kind === "terminal" || emptyFocused);
  for (const [tid, t] of tabs) {
    const selected = tid === id;
    // Per-group a11y: while the split renders, each .group-tabbar is its
    // own tablist — single selection and the roving tabindex hold PER
    // GROUP (the group's active tab is selected/tabbable in its strip).
    // Flat state keeps the classic single-selection strip.
    const groupActive = splitVisible && groupOfTab(split, tid)?.activeTab === tid;
    const on = canActivateTab(t, currentWorkspace()) && (splitVisible ? groupActive : selected);
    t.tabEl.classList.toggle("active", on);
    t.triggerEl.setAttribute("aria-selected", String(on));
    t.triggerEl.tabIndex = on ? 0 : -1;
    t.paneEl.classList.toggle("active", on);
    t.paneEl.classList.toggle("split-cell", splitVisible && on);
    t.paneEl.hidden = !on;
  }
  renderSplit(splitVisible);
  updateSplitControls();
  revealActiveTabs();
  // Only a change of the active tab (or the tab layer coming back from a stage) reveals its roster row:
  // a re-projection of the same tab never moves the roster from where the user scrolled it.
  if (before !== id) revealActiveRosterRow(current);
  tabs.get(id)?.onShow?.();
  return true;
}

/** Spec B (PR 5): the active terminal tab's roster row reads as selected at once (the repaint that the
 * activation's roster read brings paints the same) and is scrolled into the list just enough
 * (revealInScrollport; nothing when it is fully shown). It never takes focus; the roving tab stop
 * follows the selection only while focus is outside the list. Nothing scrolls while the sidebar is
 * hidden or in focus mode; a row under a
 * collapsed parent reveals the nearest shown ancestor's row, without expanding it. */
function revealActiveRosterRow(tab) {
  const listEl = contextRosterEl?.querySelector(".ctx-list");
  if (tab?.kind !== "terminal" || !listEl) return;
  const ws = contextWorkspace || currentWorkspace();
  if (tab.workspace !== ws) return;
  const instance = contextInstances.find(i => tabShowsRow(tab, ws, i));
  const rows = new Map([...listEl.querySelectorAll(".ctx-inst")].map(r => [r.dataset.treeInstance, r]));
  const selected = instance ? rows.get(instanceId(instance)) : null;
  for (const r of rows.values()) {
    r.classList.toggle("active", r === selected);
    r.closest(".ctx-tree-row")?.classList.toggle("active", r === selected);
  }
  if (selected && !listEl.contains(document.activeElement)) {
    for (const r of listEl.querySelectorAll('.ctx-inst[tabindex="0"], .ctx-background-toggle[tabindex="0"]')) r.tabIndex = -1;
    selected.tabIndex = 0;
  }
  const app = document.getElementById("app");
  if (!instance || app?.classList.contains("sidebar-hidden") || app?.classList.contains("focus-mode")) return;
  let target = selected;
  // A row that is not painted is one a collapsed ancestor hides: reveal that ancestor instead. #1579: or one the
  // closed Background section holds: reveal its heading, which the selection never opens.
  const closedHeading = target ? null : listEl.querySelector('.ctx-background-toggle[aria-expanded="false"]');
  if (closedHeading && backgroundPlacement(contextInstances, backgroundShown()).has(instanceId(instance))) target = closedHeading;
  if (!target) {
    for (let id = rosterParentId(contextInstances, instanceId(instance)), seen = new Set(); id && !seen.has(id) && !target; id = rosterParentId(contextInstances, id)) {
      seen.add(id); target = rows.get(id) || null;
    }
  }
  if (target) revealInScrollport(listEl, target.closest(".ctx-tree-row") || target);
}

function closeTab(id, restoreFocus = false, { explicit = true, confirmed = false, passive = false, background = false } = {}) {
  // All public close paths supersede foreground work, even for inactive tabs.
  // Internal replacement (brain open) is part of its enclosing open intent.
  if (explicit) tabOpenIntents.invalidate();
  const t = tabs.get(id);
  if (!t) return;
  if (t.confirmClose && !confirmed) {
    // A background close (#1237: a retired instance's tab) cancels nothing pending — its ticket only watches —
    // and never takes over a close already in flight; a user's close takes over a background one.
    if (!background || !t.closeFlight) t.closeIntent = { owns: background ? tabOpenIntents.watch() : tabOpenIntents.begin(), restoreFocus, background };
    if (t.closeFlight) return t.closeFlight;
    let work;
    try { work = t.confirmClose(); } catch { return; }
    const flight = Promise.resolve(work).then(result => {
      if (tabs.get(id) !== t || t.closeFlight !== flight) return;
      const latest = t.closeIntent.owns();
      if (result?.terminalApi === 2 && result.ok && result.status === 'closed') {
        if (!t.closeIntent.background) closeTab(id, t.closeIntent.restoreFocus && latest, { explicit: false, confirmed: true, passive: !latest });
        else {
          // Focus follows when it is in this tab now (a batch's earlier close may have handed it this trigger), or
          // was when the answer landed and is not elsewhere now (its xterm went with the teardown): background work
          // never takes it from where the operator is. Passive: a covered layer stays covered.
          const at = document.activeElement;
          const inside = !!at && at !== document.body && (t.triggerEl.contains(at) || t.paneEl.contains(at));
          const stayed = !at || at === document.body || inside;
          closeTab(id, inside || (t.closeIntent.restoreFocus && stayed), { explicit: false, confirmed: true, passive: true });
        }
      }
      // Pending/failure retains the exact tab, its literal state and key.
    }, () => { /* failure does not repaint, navigate, focus or remove the tab */ })
      .finally(() => { if (tabs.get(id) === t && t.closeFlight === flight) t.closeFlight = null; });
    t.closeFlight = flight;
    if (t.key) reserveKey(t.key, flight);
    return flight;
  }
  // onClose may return a promise (deferred cleanup while a mount is pending);
  // reserve the key until it resolves — reopen requests queue behind it via
  // whenKeyFree() instead of mounting under the stale lifecycle.
  try {
    const r = t.onClose?.();
    if (r && typeof r.then === "function" && t.key) reserveKey(t.key, r);
  } catch (e) { console.error(e); }
  t.tabEl.remove();
  syncWaitingRow(t.paneEl, null);
  t.paneEl.remove();
  tabs.delete(id);
  revealActiveTabs(); // the remaining tabs widen: the active one may have moved out of view
  const wasSplitMember = isSplitMember(split, id);
  // Closing a tab never closes a destination. If the terminal layer is
  // visible, stay in its focused group even when it (or every group) is empty.
  const removed = removeSplitTab(split, id);
  const splitSuccessor = activeTab === id ? removed.successor : null;
  split = removed.split;
  // Delayed cleanup never reopens a covered terminal layer/other workspace.
  if (passive && (!tabLayerVisible || t.workspace !== currentWorkspace())) {
    if (activeTab === id) activeTab = null;
    return;
  }
  if (wasSplitMember && tabLayerVisible
      && (activeTab == null || activeTab === id || tabs.get(activeTab)?.kind === "terminal")) {
    const next = activeTab === id ? splitSuccessor : activeTab;
    activateTab(next, { keepGroupFocus: true });
    if (restoreFocus) tabOpenIntents.applyFocus(() => {
      if (next != null) tabs.get(next)?.triggerEl.focus();
      else tabhost.querySelector(".focused-group > .split-empty")?.focus();
    });
    return;
  }
  if (activeTab === id) {
    const fallback = fallbackTabForContext(tabs, sidebarMode, currentWorkspace());
    if (fallback) {
      activateTab(fallback[0]);
      if (restoreFocus) fallback[1].triggerEl.focus();
    } else if (t.kind === "terminal") {
      showTerminalContext();
      if (restoreFocus) focusAfterLastTab("terminal", { instancesEntry: rosterEntry() });
    } else {
      activeTab = null;
      showTabLayer(false);
      if (stage) setNavActive(stage.name);
      if (restoreFocus) focusAfterLastTab("artifact", {
        stageEntry: navEl.querySelector(".nav-item.active") || navEl.querySelector(".nav-item"),
      });
    }
  } else if (restoreFocus) {
    tabs.get(activeTab)?.triggerEl.focus();
  }
  // a member closed while another member stayed active: re-render the layout
  if (wasSplitMember && activeTab != null && activeTab !== id) activateTab(activeTab, { keepGroupFocus: true });
}

// ── view host: load ./views/<name>.mjs, mount into a tab ─────────────────
async function openBrainTab(agent) {
  // One brain tab per workspace; other workspaces keep their own mounted
  // selection. Supersede earlier opens before deferred cleanup/module loading.
  const owns = brainIntents.begin();
  for (const [id, t] of tabs) if (t.kind === "brain" && t.workspace === currentWorkspace()) closeTab(id, false, { explicit: false });
  return openViewTab("brain", agent, { agent }, "view:brain", "brain", owns);
}

async function openViewTab(name, title, extra = {}, key = `view:${name}`,
  kind = name === "markdown" ? "file" : "artifact", parentOwns = () => true, selectionOwns = null) {
  const workspace = currentWorkspace();
  const latest = selectionOwns ?? tabOpenIntents.begin();
  const owns = () => parentOwns() && latest();
  if (!owns()) return;
  key = JSON.stringify([workspace, key]);
  // Built as text: an exception's message is not Desktop's own string.
  const placeholder = (message) => {
    const box = document.createElement("div"), heading = document.createElement("h2"), body = document.createElement("div");
    box.className = "placeholder"; heading.textContent = name; body.textContent = message;
    box.append(heading, body);
    return box;
  };
  let mod;
  try {
    mod = await prepareOwnedOpen({
      owns,
      waitForKey: () => whenKeyFree(key),
      load: () => import(`./views/${name}.mjs`),
    });
    if (!mod) return;
  } catch (e) {
    if (!owns()) return;
    const made = addTab({ title: `${title} (missing)`, key, kind, workspace, intent: owns });
    if (made) made.paneEl.replaceChildren(placeholder(`view module failed to load: ${e.message}`));
    return;
  }
  const life = createViewLifecycle(mod, (e) => console.error(e));
  const made = addTab({
    title,
    key,
    kind,
    workspace,
    intent: owns,
    // Close is safe at any time — including while the async mount is still
    // pending: the lifecycle defers cleanup until mount settles and then
    // runs THAT mount's disposer (never the module-wide unmount mid-flight,
    // which would clear every open mount of the module).
    onClose: () => life.close(),
  });
  if (!made) return; // existing tab activated
  const el = document.createElement("div");
  el.style.height = "100%";
  made.paneEl.append(el);
  try {
    // Retained artifacts never change identity with the global workspace bus.
    // Late events from a hidden/closed artifact cannot open work in another scope.
    const visibleOwner = () => tabs.has(made.id) && currentWorkspace() === workspace;
    await life.mounted(el, {
      ...ctx, ...extra, workspace,
      // Once created, an immutable file belongs to its tab, not foreground
      // selection. Hidden reads may finish without activating/focusing it;
      // returning to the tab must not leave a permanently stale Loading state.
      owns: () => tabs.has(made.id),
      openFile: path => visibleOwner() && ctx.openFile(path),
      openBrain: agent => visibleOwner() && ctx.openBrain(agent),
      openTerminal: (instance, opts) => visibleOwner() && ctx.openTerminal(instance, opts),
    });
    if (!owns()) return;
  }
  catch (e) {
    if (owns()) el.replaceChildren(placeholder(`mount failed: ${e.message}`));
  }
}

// ── integrated terminal tab (the shell's own flagship view) ──────────────
const pendingTerms = new Set(); // [key, incarnation] with a tab CREATION in flight (post-resolution — dedup for concurrent opens of one resolved identity)
let terminalOpening = null; // the newest terminal open (openTerminalTabFlow): { ref, inst (once resolved), owns, pending }
/** ref: either a bare instance name (views, palette — resolved only when
 * unambiguous) or { instance, home?, agentsRoot? } (sidebar rows — exact).
 * opts.quiet (post-spawn auto-open): failures report via console.warn
 * instead of a blocking alert() — an automated handoff must never park a
 * modal dialog over the app; the user recovers from the sidebar roster.
 * ORDER MATTERS (review 7d740f9): the reference is resolved against the
 * roster FIRST and the dedup key derives from the RESOLVED instance, so a
 * bare-name open and a sidebar open of the same identity share one tab —
 * and an existing tab can never be activated for a name that has since
 * become ambiguous (resolution refuses before dedup can activate). */
async function openTerminalTab(ref, { quiet = false, inSplit = false, expected = null, valid = () => true, followed = false, onError, refuse, focusContent = true } = {}) {
  const notify = onError || (quiet ? (msg) => console.warn(`[terminal open] ${msg}`) : (msg) => alert(msg));
  // Quiet opens must NEVER reject either (review ff70e1c nit): the refusal
  // messages route through notify, but transport failures (the panel fetch,
  // the tab mount) would still escape as an unhandled rejection from an
  // automated caller that does not await. runOpenFlow catches every quiet
  // rejection into notify; interactive opens keep throwing.
  return runOpenFlow(() => openTerminalTabFlow(ref, notify, { inSplit, expected, valid, followed, refuse, focusContent }), { quiet, notify });
}

async function openTerminalTabFlow(ref, notify, options = {}) {
  if (options.valid && !options.valid()) return;
  // Opens following an observed row (post-spawn or launch) reuse that roster while it is current (no read
  // started since, same workspace), instead of reading /api/panel again. Taken before this open's own repaint
  // below, which starts a read. Other opens read for themselves.
  const shown = options.followed && shownRoster?.gen === contextRosterGen && shownRoster.ws === currentWorkspace() ? shownRoster : null;
  const planned = options.inSplit ? instanceSplitPlan(splitOpenState()) : null;
  const layoutIdentity = planned ? instanceSplitIdentity(splitOpenState()) : null;
  if (planned && !planned.available) return notify(planned.reason);
  // A sidebar-tree selection opens its terminal directly — the persistent
  // sidebar roster IS the instances surface (there is no Instances stage;
  // scope correction of PR #29).
  setSidebarMode("instances");
  setNavActive(null);
  refreshContextRoster();
  // Honor the views' workspace bus: an instance selected in a secondary
  // (server-advertised) workspace must resolve against THAT roster, and a
  // same-named instance in another workspace — or another agents root
  // (review 46f3fdc) — is a different terminal.
  const ws = currentWorkspace();
  const selected = tabOpenIntents.begin(), connection = connectionGeneration;
  const owns = () => selected() && connection === connectionGeneration && (!options.valid || options.valid());
  const commitDestination = () => {
    if (!planned) return true;
    if (!owns() || instanceSplitIdentity(splitOpenState()) !== layoutIdentity) return false;
    split = planned.split; return true;
  };
  // While it is in flight, and after it while its tab is the one shown, the instance steps go on from it
  // (openingInstanceId): a press before /api/panel answers or the terminal attaches is a move, not lost.
  const opening = { ref, inst: null, owns, pending: true };
  terminalOpening = opening;
  try {
    let panel;
    // The shown answer keeps the stamp of the read that brought it; only a request of this open's own takes a new one.
    const reuse = shown && shown.ws === ws ? shown : null;
    const read = reuse ? reuse.read : ++panelReads;
    try {
      panel = reuse ? { instances: reuse.instances } : await api(`/api/panel${ws ? `?ws=${encodeURIComponent(ws)}` : ""}`);
    } catch (e) {
      if (!owns()) return; // stale rejection belongs to the old workspace
      throw e;
    }
    if (!owns()) return;
    // Identity-aware resolution BEFORE any key/tab decision (resolveTerminalOpen
    // encodes the ordering; review 7d740f9): an exact home/agentsRoot reference
    // finds ITS instance; a bare name resolves only when unambiguous — the
    // first same-named match could be another agents root's tmux session.
    const r = resolveTerminalOpen(panel.instances, ref, ws);
    if (r.error) {
      return notify(r.error === "ambiguous"
        ? `several instances are named "${r.name}" — open it from the sidebar tree, which addresses the exact one`
        : `unknown instance "${r.name}"`);
    }
    const { inst, key } = r;
    opening.inst = inst;
    if (options.expected && !sameInstanceActionTarget(options.expected, inst, ws)) return notify('The selected instance identity changed. Use the current roster.');
    try { await whenKeyFree(key); }
    catch (e) { if (!owns()) return; throw e; }
    if (!owns()) return;
    // Explicit jumps focus terminal input. Launch opens opt out, including tab reuse and readiness.
    // Only a tab of this incarnation (#1237): a respawn under the same home opens its own tab.
    for (const [tid, t] of tabs) if (t.key === key && !otherIncarnation(t.origin?.incarnation, inst.createdAt)) {
      if (!commitDestination()) return notify('The terminal destination changed. Select the instance again.');
      t.instanceRef = inst;
      split = fillEmptyGroup(split, tid);
      selectTab(tid, { intent: owns, focusContent: options.focusContent !== false }); return;
    }
    // A caller's own refusal of a NEW tab for the resolved row (the palette's: a held home opens nothing new, #802,
    // #1247); its tab already open is shown above, as any open tab is.
    const refused = options.refuse?.(inst);
    if (refused) return notify(refused);
    const pending = JSON.stringify([key, terminalOrigin(inst).incarnation]); // one incarnation's creation
    if (pendingTerms.has(pending)) return; // an open for this key is already in flight
    pendingTerms.add(pending);
    try {
      await openTerminalTabInner(inst, ws, key, owns, notify, commitDestination, read, options.focusContent !== false);
    } finally {
      pendingTerms.delete(pending);
    }
  } finally {
    opening.pending = false;
  }
}

async function openTerminalTabInner(inst, ws, key, owns, notify = (msg) => alert(msg), commitDestination = () => true, read = 0, focusContent = true) {
  // inst is the RESOLVED roster instance (openTerminalTab resolves + keys
  // before dedup; review 7d740f9). Re-check ownership here — whenKeyFree
  // may have waited across a workspace switch.
  if (!owns()) return;
  const name = inst.instance;
  if (!canAddressRemote(inst)) return notify(rowReasonLine(rowReason(inst)));
  if (!inst.running || (!inst.server && !inst.tmux?.session)) return notify(runtimeErrorLine(inst) || `"${name}" has no live terminal session`);
  const origin = terminalOrigin(inst);
  // #1237: a roster answer read after this open's own (and judged while it waited) that shows this incarnation
  // retired wins — no tab opens for a row the roster no longer has.
  const judged = judgedAnswer;
  if (judged && judged.read > read && judged.workspace === ws
    && retiredTabs([[0, { kind: "terminal", workspace: ws, key, origin }]], judged.panel).length) return notify(`unknown instance "${name}"`);

  if (!commitDestination()) return notify('The terminal destination changed. Select the instance again.');
  const wrap = document.createElement("div");
  wrap.className = "term-wrap";

  const type = terminalTypography();
  const term = new Terminal(terminalOptions({
    fontSize: type.fontSize,
    fontFamily: type.fontFamily,
    fontWeight: terminalFontWeight(),
    theme: xtermTheme(),
  }));
  // A drag is xterm's own selection, and copies reach the clipboard (#520, #672).
  const unwireSelection = wireTerminalSelection(term, wrap);
  const unwire = () => { offTheme(); offTypography(); unwireSelection(); };
  // live terminals follow app theme (colours and text weight) + persisted typography preferences
  const offTheme = onThemeChange(() => { term.options.theme = xtermTheme(); term.options.fontWeight = terminalFontWeight(); });
  const offTypography = onTerminalTypographyChange((next) => {
    term.options.fontFamily = next.fontFamily;
    term.options.fontSize = next.fontSize;
    requestAnimationFrame(() => { try { fitTerminal(term, fit); } catch {} });
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  // Box drawing and blocks as a native terminal draws them (WebGL, DOM fallback).
  const glyphs = createGlyphRenderer({ term, Addon: globalThis.WebglAddon?.WebglAddon,
    onChange: () => requestAnimationFrame(() => { try { fitTerminal(term, fit); } catch {} }),
    onRecovered: () => atlasRecovery.schedule() });

  // Composition (setup-inside-onReady, teardown symmetry) lives in
  // terminal-tab.mjs so its ordering is unit-testable (review termlc2).
  const tab = createTerminalTab({
    desk,
    term,
    tmux: inst.tmux,
    remote: inst.server ? { serverId: inst.server, instance: inst.instance, home: inst.home } : undefined,
    // A remote row's repoName is its server's registered label, else the server id.
    serverLabel: inst.server ? inst.repoName || inst.server : undefined,
    wrap,
    isActive: () => made.paneEl.classList.contains("active"),
    // Visibility is a fit concern, not permission to focus. Consult the
    // CURRENT explicit intent so re-focusing a pending retained tab works.
    ownsFocus: () => tabLayerVisible && activeTab === made.id
      && canActivateTab(tabs.get(made.id), currentWorkspace())
      && tabOpenIntents.ownsFocus(made.id),
    focusInput: () => tabOpenIntents.applyFocus(() => term.focus()),
    fit: () => fitTerminal(term, fit),
    // Terminal-allowlisted shortcuts (engine policy: TERMINAL_ALLOWLIST, e.g.
    // app.palette, tabs.next/prev/close, split.*, focus.leaveTerminal) must be
    // intercepted BEFORE xterm writes to the pty — its handler consumes e.g.
    // Alt+K or ⌘⇧F6 and stops propagation, so the bubble-phase window
    // listener never sees it. matchEvent applies the allowlist (insideTerminal);
    // the action runs once on keydown, and every phase of a matched chord
    // is claimed so no control byte leaks to the attached program.
    interceptKey: (ev) => {
      if (!matchEvent(ev, { insideTerminal: true })) return false;
      if (ev.type === "keydown") handleKeydown(ev, { insideTerminal: true });
      return true;
    },
  });

  const made = addTab({
    title: `${name}${inst.server ? ` · ${inst.server}` : ""}`,
    // Workspace v4 (W6): a terminal tab carries only its name and status; the branch lives in the bottom bar.
    // A shrunk tab keeps its name's end ("oats-…palette"); a host suffix gives way first.
    decor: { dot: inst.running ? "on" : "off", color: dotColor(inst, inst.running ? "running" : "stopped"), tailAt: tabNameTailStart(name, inst.agent), tailEnd: name.length },
    key,
    kind: "terminal",
    workspace: ws,
    instanceRef: inst,
    origin, // the incarnation, deployment and server it opened (#1237: retired-tabs.mjs)
    intent: owns,
    // Keep the pane/key while cleanup is pending or unconfirmed. Theme hooks
    // belong to the retained view and are removed only on confirmed disposal.
    confirmClose: () => tab.close(),
    onClose: () => unwire(),
    onShow: () => { requestAnimationFrame(() => { try { glyphs.ensure(); fitTerminal(term, fit); } catch {} }); },
    // user-initiated activation → keyboard lands in the xterm textarea
    focusContent: () => tab.focus(),
    focusOnActivate: focusContent, // also applies to addTab's dedup and delayed terminal readiness
    term, // the GPU-restart recovery clears its glyph atlas
  });
  if (!made) { unwire(); term.dispose(); return; } // lost a race to an identical tab
  // A tab opened on a waiting instance shows it at once, from the last painted roster (#558).
  syncTabNeedsInput(tabNeedsInputRoster.instances, tabNeedsInputRoster.workspace);
  made.paneEl.append(wrap);
  term.open(wrap);
  glyphs.ensure();
  fitTerminal(term, fit);

  await tab.start();
}

// ── nav rail ──────────────────────────────────────────────────────────────
// First-class stage destinations come from shell-nav.mjs (NAV) so tests can
// prove every entry resolves to a real mount-exporting view. The permanent
// instance tree in the sidebar is the instances surface itself — selecting
// an instance opens its terminal; there is no separate Instances stage.
const navEl = document.getElementById("nav");
for (const v of NAV) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "nav-item";
  b.title = v.title;
  b.dataset.view = v.name;
  b.dataset.action = `stage.${v.name}`;
  b.innerHTML = `<span class="icon"></span><span class="label"></span>`;
  b.querySelector(".icon").innerHTML = shellIcon(v.icon);
  b.querySelector(".label").textContent = v.label;
  b.addEventListener("click", () => runAction(`stage.${v.name}`));
  navEl.append(b);
}

// The foot's controls use exactly the same registry as keyboard actions (the nav's buttons run theirs above):
// Spawn instance (Quick Open, app.quickOpenSouls: the product owner, 2026-10-26), the bar's sidebar toggle, and its
// settings cog's menu.
for (const button of document.querySelectorAll("#nav-foot [data-action]")) {
  button.addEventListener("click", () => runAction(button.dataset.action));
}
const settingsMenu = createSettingsMenu(document, document.getElementById("sidebar-settings"), {
  run: (id) => runAction(id), shortcut: (id) => { const chord = getBinding(id, isMac); return chord ? formatChord(chord, isMac) : ""; },
});

// This is a chooser entry, not a launch or an inspection preselection. Capture
// workspace visit + selection before import, and contain stale rejections too.
// The leader's 3 opens the same way on Capabilities (`tab`), and stage.hierarchy on Machines.
const WORKSPACE_TAB_NAMES = { machines: "Machines", souls: "Souls", capabilities: "Capabilities" };
async function openWorkspaceSouls(tab = "souls") {
  const selectionOwns = tabOpenIntents.begin();
  const owns = () => selectionOwns() && ![...document.querySelectorAll('[aria-modal="true"]')]
    .some(dialog => !dialog.closest("[hidden]"));
  let mod;
  try { mod = await import("./views/spawn.mjs"); }
  catch (e) {
    if (!owns()) return;
    ctx.notify(`Could not open Workspace ${WORKSPACE_TAB_NAMES[tab] ?? tab}: ${e.message || e}`);
    return;
  }
  if (!owns()) return;
  mod.preselectWorkspaceTab(tab);
  await showStage("spawn");
}

// ── command palette (⌘K): jump to an instance or run a command ─────────
const isMac = navigator.platform.includes("Mac");
const chordDetail = (id) => () => {
  const b = getBinding(id, isMac);
  return b ? formatChord(b, isMac) : "";
};
const palette = createPalette({
  loadInstances: async () => {
    if (windowState() === "choosing") return { instances: [], deployments: [] }; // no workspace: nothing to read (#481)
    const ws = currentWorkspace();
    // The last-focus record as the palette opens: its order (#1383).
    const recent = instanceRecency.snapshot(ws);
    const p = await api(`/api/panel${ws ? `?ws=${encodeURIComponent(ws)}` : ""}`);
    // One snapshot: the palette sections and clusters by these deployments, as the sidebar does.
    return { instances: p.instances || [], deployments: panelDeployments(p), recent };
  },
  // A held home (spawning, retiring, left half cleaned) opens nothing from here either, as its roster row does not:
  // the row as this window reads it (its own retires in flight held), said as the row says it.
  openTerminal: (name) => openTerminalTab(name, { refuse: (inst) => { const held = heldHome(shownRows([inst])[0]); return held ? heldLine(held) : null; } }),
  // While open, ⌘K / Alt+K moves down and Shift + it up (live keymap); Esc closes, Enter opens.
  cycleKey: (e) => pickerCycleDirection(e, "app.palette", isMac),
  // While open, ⌘N / ⌥⌘N (Alt+Shift+↓ / ↑ elsewhere) jump to the next / previous group, over
  // app.chooseSoul and roster.openNext / openPrevious; the footer names them.
  groupKey: (e) => paletteGroupDirection(e, isMac),
  footer: paletteGroupHint(isMac),
  commands: [
    // View commands derive from the nav manifest so a new rail destination
    // can never be palette-invisible (review 8441961 nit).
    ...[...NAV, ...NAV_TABS].map((v) => ({ label: `View: ${v.label}`, detail: chordDetail(`stage.${v.name}`), run: () => showStageFocused(v.name) })),
    { label: "Souls: choose a soul to spawn (Workspace › Souls)", detail: chordDetail("app.chooseSoul"), run: () => runAction("app.chooseSoul") },
    { label: "Souls: quick open…", detail: chordDetail("app.quickOpenSouls"), run: () => runAction("app.quickOpenSouls") },
    { label: "File: open read-only…", detail: chordDetail("app.openFile"), run: () => runAction("app.openFile") },
    { label: "Theme: choose…", detail: chordDetail("app.themePicker"), run: () => runAction("app.themePicker") },
    { label: "Theme: cycle White / Solarized / Dark / This computer", detail: chordDetail("app.themeToggle"), run: () => toggleTheme() },
    ...THEMES.map(({ id, label }) => ({ label: `Theme: ${label}`, detail: chordDetail(`app.theme.${id}`), run: () => runAction(`app.theme.${id}`) })),
    { label: "Font: choose…", detail: chordDetail("app.fontPicker"), run: () => runAction("app.fontPicker") },
    { label: "Shortcuts: edit keyboard shortcuts…", detail: chordDetail("app.shortcuts"), run: () => openShortcutsEditor() },
    { label: "Settings: Connections…", detail: "GitHub CLI accounts on this machine", run: () => openConnections() },
    { label: "Workspace: switch…", detail: chordDetail("app.workspaces"), run: () => focusWorkspaceList() },
    // The palette hands focus to its command: back where it was opened first (a row the toggle hides then passes it to
    // the current row; a terminal keeps it), then the toggle, as its chord does from there.
    { label: "Workspaces: show only the current workspace (on / off)", detail: chordDetail("workspaces.currentOnly"),
      run: () => { takePickerFocusReturn(document)?.restore(); runAction("workspaces.currentOnly"); } },
    // One window per workspace (#481): on macOS also File → New Window ⌘⇧N; elsewhere no default chord.
    ...(typeof desktopBridge.windowOpenWorkspace === "function" ? [{ label: "Window: new window",
      detail: () => chordDetail("app.newWindow")() || (isMac ? formatChord("Mod+Shift+N", true) : ""), run: () => runAction("app.newWindow") }] : []),
    { label: "Instances: focus the sidebar roster", detail: chordDetail("sidebar.focusFilter"), run: () => focusRoster() },
    // The instance it acts on is the leader's target when the palette opened (paletteTargetId). The palette hands
    // focus back where it was opened first, as the Workspaces toggle does: with no target ("No instance is focused or
    // selected.") the focus stays there, never on <body>; the dialog returns to it when it closes.
    { label: "Instance: name and colour…", detail: chordDetail("instance.edit"),
      run: () => { takePickerFocusReturn(document)?.restore(); openInstanceEdit(paletteTargetId); } },
    { label: "Sidebar: toggle (hide/show)", detail: chordDetail("sidebar.toggle"), run: () => toggleSidebar() },
    { label: "Sidebar: reset width", detail: chordDetail("sidebar.resetWidth"), run: () => runAction("sidebar.resetWidth") },
    { label: "Instance panel: show / hide", detail: chordDetail("panel.toggle"), run: () => runAction("panel.toggle") },
    { label: "Focus mode: toggle", detail: chordDetail("app.focusMode"), run: () => runAction("app.focusMode") },
    { label: "Split: terminal right (side by side)", detail: chordDetail("split.vertical"), run: () => splitPane("row") },
    { label: "Split: terminal down (stacked)", detail: chordDetail("split.horizontal"), run: () => splitPane("col") },
    { label: "Split: return to terminal groups", detail: chordDetail("split.restore"), run: () => restoreTerminalGroups() },
    { label: "Split: close (back to single pane)", detail: chordDetail("split.close"), run: () => closeSplit() },
    { label: "Terminal: focus the active terminal input", detail: chordDetail("terminal.focusActive"), run: () => focusActiveTerminal() },
    { label: "Terminal: increase font size", detail: chordDetail("terminal.fontBigger"), run: () => setTerminalFontSize(terminalTypography().fontSize + 1) },
    { label: "Terminal: decrease font size", detail: chordDetail("terminal.fontSmaller"), run: () => setTerminalFontSize(terminalTypography().fontSize - 1) },
    { label: "Terminal: set font family…", run: () => {
      const current = terminalTypography().fontFamily;
      const next = window.prompt("Terminal font family (CSS font-family value)", current);
      if (next !== null) setTerminalFontFamily(next);
    } },
    { label: "Terminal: reset typography", detail: chordDetail("terminal.fontReset"), run: () => resetTerminalTypography() },
  ],
});

// ── Quick Open for souls (⌘P / Ctrl+Alt+P): find a soul, open its spawn dialog ──
// Selection hands off to Workspace (preselectSpawn — consumed by the view's
// next roster paint): the spawn dialog scoped to that soul, exactly as its
// card's Spawn opens it. A soul that can't be spawned here (attached only,
// refused, no verified CLI) opens its page instead, which says why.
// Dismissing the dialog returns to where the operator was before Quick Open
// (surface-return.mjs). Terminal policy (documented): app.quickOpenSouls is
// terminal-allowlisted — ⌘P on macOS, Alt+P on Linux/Windows (ESC P: Esc, then P), or
// Ctrl+Alt+P (ESC Ctrl+P) in that family; plain Ctrl+P stays the shell's history.
const quickOpen = createQuickOpen({
  loadSouls: async () => {
    const ws = currentWorkspace();
    return api(`/api/agents${ws ? `?ws=${encodeURIComponent(ws)}` : ""}`);
  },
  onPick: (soul) => soulSpawn.open(soul),
});
/** Quick Open's pick path: the spawn dialog for `soul`, scoped as its card's Spawn opens it (a soul
 * that can't be spawned here opens its page, which says why); dismissing it returns to where the
 * operator was. The leader's N takes it for the target instance's soul (`onMiss`: no such soul). */
const soulSpawn = {
  async open(soul, { onMiss } = {}) {
    // Capture before module loading: a new tab/stage/sidebar intent or an
    // A→B→A workspace visit must not turn this old callback into a new pick.
    const owns = tabOpenIntents.begin();
    // Where the operator was (the picker kept the control they opened it from).
    const origin = surfaceReturn.capture(takePickerFocusReturn(document));
    let mod;
    try { mod = await import("./views/spawn.mjs"); }
    catch (e) {
      if (!owns()) return;
      ctx.notify(`Could not open soul: ${e.message || e}`);
      return;
    }
    if (!owns()) return;
    mod.preselectSpawn({ ...soul, ...(onMiss ? { onMiss } : {}), onDismiss: () => surfaceReturn.restore(origin) });
    showStage("spawn");
  },
};
// Both pickers contain workspace-scoped references. Close synchronously on
// every workspace visit; their own lifetimes discard late lists and row clicks.
onWorkspaceChange(() => {
  quickOpen.close();
  palette.close();
});

// ── shortcuts editor (the settings cog's Keyboard shortcuts… + palette + Mod+,) ────────────
const shortcutsEditor = createKeybindingsEditor({ doc: document, isMac, chordFamily });
// Stored rebinds vs the effective keymap (spec F review): a clash is never resolved silently;
// the settings cog and its Keyboard shortcuts… item carry a warn dot and a description until the operator rebinds or resets.
function markShortcutClashes() {
  const clashes = keymapConflicts(isMac).length;
  const item = settingsMenu.items.find(el => el.dataset.menuAction === "app.shortcuts");
  for (const button of [document.getElementById("sidebar-settings"), item]) {
    if (!button) continue;
    button.classList.toggle("has-clash", clashes > 0);
    if (clashes) button.setAttribute("aria-description", `${clashes === 1 ? "1 shortcut you set clashes" : `${clashes} shortcuts you set clash`} with another: open Keyboard shortcuts… to review`);
    else button.removeAttribute("aria-description");
  }
}
let clashCheckQueued = false;
onKeymapChange(() => {
  if (clashCheckQueued) return;
  clashCheckQueued = true;
  queueMicrotask(() => { clashCheckQueued = false; markShortcutClashes(); });
});
function openShortcutsEditor() { tabOpenIntents.invalidate(); lifecycleDialog.close(); connections.close(); shortcutsEditor.open(); }
const connections = createConnections({ doc: document, desk,
  request: body => api('/api/forge-connections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  subscribe: subscribeConnections, generation: () => connectionGeneration, openShortcuts: openShortcutsEditor,
  onIntent: () => tabOpenIntents.invalidate(), applyFocus: fn => tabOpenIntents.applyFocus(fn), captureFocus: () => tabOpenIntents.begin(),
  // Settings → Terminal: the font size stepper, on the keys' and the palette's own store.
  sections: [() => createTerminalSettings({ doc: document, chords: {
    bigger: chordDetail("terminal.fontBigger")(), smaller: chordDetail("terminal.fontSmaller")(), reset: chordDetail("terminal.fontReset")() } })],
  terminalFactory: mount => {
    const term = new Terminal({ ...terminalOptions({ ...terminalTypography(), fontWeight: terminalFontWeight(), theme: xtermTheme() }), scrollback: 200, allowProposedApi: false });
    const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(mount);
    const offTheme = onThemeChange(() => { term.options.theme = xtermTheme(); term.options.fontWeight = terminalFontWeight(); });
    // A size or family change keeps the mount's box, so its ResizeObserver need not fire: the adapter tells its resize
    // listeners itself, and Connections refits the grid and sends it to the sign-in PTY (forgeAuthResize).
    const observers = new Set(), resizeListeners = new Set();
    const offType = onTerminalTypographyChange(value => {
      term.options.fontSize = value.fontSize; term.options.fontFamily = value.fontFamily;
      for (const fn of [...resizeListeners]) fn();
    });
    return {
      get cols() { return term.cols; }, get rows() { return term.rows; },
      write: value => term.write(value), focus: () => term.focus(), fit: () => fit.fit(),
      onData: fn => term.onData(fn), setKeyHandler: fn => term.attachCustomKeyEventHandler(fn),
      onResize: fn => { const observer = new ResizeObserver(fn); observers.add(observer); resizeListeners.add(fn); observer.observe(mount);
        return { dispose: () => { observer.disconnect(); observers.delete(observer); resizeListeners.delete(fn); } }; },
      dispose: () => { for (const observer of observers) observer.disconnect(); resizeListeners.clear(); offTheme(); offType(); term.dispose(); },
    };
  },
});
function openConnections(choice = {}) { tabOpenIntents.invalidate(); lifecycleDialog.close(); shortcutsEditor.close(); connections.open(choice); }
window.addEventListener('pagehide', () => connections.dispose(), { once: true });
const lifecycleDialog = createLifecycleDialog({ doc: document,
  request: async (workspace, body) => {
    const response = await desk.api(`/api/instance-lifecycle?ws=${encodeURIComponent(workspace)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return response.body; // retain typed unknown outcomes even on proxy transport failures
  },
  gitRequest: (workspace, body) => api(`/api/instance-git?ws=${encodeURIComponent(workspace)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }),
  forgeRequest: (workspace, body) => api(`/api/instance-forge?ws=${encodeURIComponent(workspace)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }),
  generation: workspaceGeneration, subscribeWorkspace: onWorkspaceChange,
  subscribeConnections, connectionGeneration: () => connectionGeneration,
  onIntent: () => tabOpenIntents.invalidate(), applyFocus: fn => tabOpenIntents.applyFocus(fn),
  onSettled: () => { void refreshContextRoster(); }, openExternal: ctx.openExternal, fallbackFocus: () => lifecycleFallbackFocus(),
  retires,
});
/** The roster's rows (by identity) when the confirmation opened, and where its instance stood among them. */
let lifecycleRowOrder = null;
/** Where focus lands when a confirmation closes and its opener is gone (a retired row left the roster): the
 * row that followed it, else the one before it, else the roster's tab-order row, else a stable shell control. */
function lifecycleFallbackFocus() {
  const listEl = contextRosterEl?.querySelector(".ctx-list");
  const shown = el => el?.isConnected && !el.disabled && !el.closest("[hidden]") && document.defaultView.getComputedStyle(el).display !== "none" && !sidebarHidden();
  const rows = listEl ? [...listEl.querySelectorAll(".ctx-inst")].filter(shown) : [];
  const { order = [], at = -1 } = lifecycleRowOrder || {};
  const row = successorRow(rows, order, at) || rows.find(r => r.tabIndex === 0) || rows[0];
  if (!row) return stableFocusTarget();
  for (const r of listEl.querySelectorAll('.ctx-inst[tabindex="0"], .ctx-background-toggle[tabindex="0"]')) r.tabIndex = -1;
  row.tabIndex = 0; return row;
}
function openLifecycleDialog(operation, instance, workspace) {
  connections.close(); shortcutsEditor.close();
  const order = [...(contextRosterEl?.querySelectorAll(".ctx-list .ctx-inst") || [])].map(r => r.dataset.treeInstance);
  lifecycleRowOrder = { order, at: order.indexOf(instanceId(instance)) };
  // The callers check the workspace on screen (`workspace`); the plan and apply are addressed to the
  // row's own deployment (#482), which the server's echoed target names too.
  void workspace;
  lifecycleDialog.open({ operation, instance, workspace: rowDeployment(instance) });
}
window.addEventListener('pagehide', () => lifecycleDialog.dispose(), { once: true });
/* Forget… (#1131): a row its host no longer lists (forget-dialog.mjs). The server composes the command from the
 * row's { server, instance }, answers its outcome, and reads the remote roster again (the one owner of that read);
 * the row leaves this window's roster when that read lands, at the roster's own refresh. Nothing here edits a row. */
const forgetDialog = createForgetDialog({ doc: document,
  request: async body => (await desk.api('/api/server-forget', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).body,
  notify: text => notifications.notify(text),
  nextFocus: () => forgetNextFocus(),
  generation: workspaceGeneration, subscribeWorkspace: onWorkspaceChange,
  onIntent: () => tabOpenIntents.invalidate(), applyFocus: fn => tabOpenIntents.applyFocus(fn),
});
/** The roster's rows (by identity) when the Forget confirmation opened, and where its row stood among them. */
let forgetRowOrder = null;
/** Where focus goes once a row is forgotten: the first row that followed it when the confirmation opened and is
 * still shown (the forgotten row may already be gone, by this re-read or an earlier poll), else the roster itself,
 * else a stable shell control when the sidebar is hidden. */
function forgetNextFocus() {
  const listEl = contextRosterEl?.querySelector(".ctx-list");
  if (!listEl || sidebarHidden()) return stableFocusTarget();
  const shown = el => el?.isConnected && !el.disabled && !el.closest("[hidden]") && document.defaultView.getComputedStyle(el).display !== "none";
  const rows = [...listEl.querySelectorAll(".ctx-inst")].filter(shown);
  const { order = [], at = -1 } = forgetRowOrder || {};
  const next = forgetSuccessor(rows, order, at);
  if (!next) { contextRosterEl.tabIndex = -1; return contextRosterEl; }
  for (const r of listEl.querySelectorAll('.ctx-inst[tabindex="0"], .ctx-background-toggle[tabindex="0"]')) r.tabIndex = -1;
  next.tabIndex = 0; return next;
}
function openForgetDialog(instance, workspace) {
  if (workspace !== currentWorkspace() || forgetDialog.busy()) return;
  connections.close(); shortcutsEditor.close(); lifecycleDialog.close();
  const order = [...(contextRosterEl?.querySelectorAll(".ctx-list .ctx-inst") || [])].map(r => r.dataset.treeInstance);
  forgetRowOrder = { order, at: order.indexOf(instanceId(instance)) };
  forgetDialog.open(instance);
}
window.addEventListener('pagehide', () => forgetDialog.dispose(), { once: true });
/* Name and colour (#1421 §2; instance-color-dialog.mjs), for the leader's target: its chord (instance.edit) and
 * the palette's entry. The server runs `oats instance color` for the row's deployment and reads the roster again
 * after a change; the dots follow that read. Nothing here edits a row. */
const instanceColorDialog = createInstanceColorDialog({ doc: document,
  request: async (row, body) => (await desk.api(`/api/instance-color?ws=${encodeURIComponent(rowDeployment(row))}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).body,
  generation: workspaceGeneration, subscribeWorkspace: onWorkspaceChange,
  onIntent: () => tabOpenIntents.invalidate(), applyFocus: fn => tabOpenIntents.applyFocus(fn),
});
/** Opens it for the instance `id` names (leaderTargetId), as this window's roster shows it (its own retires in
 * flight held); with none, the hint says so. */
function openInstanceEdit(id) {
  const instance = rosterInstance(id);
  if (!instance) { sayInHint("No instance is focused or selected."); return; }
  connections.close(); shortcutsEditor.close(); lifecycleDialog.close(); forgetDialog.close();
  const held = heldHome(instance);
  instanceColorDialog.open(instance, { held: held ? heldLine(held) : null });
}
window.addEventListener('pagehide', () => instanceColorDialog.dispose(), { once: true });
// The settings cog's Theme…, the palette and the chord (app.themePicker) open it; a choice goes through setTheme,
// so it is stored as a palette choice is.
const themePicker = createThemePicker({ doc: document, themes: THEMES, current: currentTheme, choose: setTheme,
  subscribe: onThemeChange, onIntent: () => tabOpenIntents.invalidate(), applyFocus: fn => tabOpenIntents.applyFocus(fn) });
window.addEventListener('pagehide', () => themePicker.dispose(), { once: true });
// The font picker (app.fontPicker, the palette's Font: choose…): the same picker over this platform's
// fonts; a choice goes through setFont, stored per computer and applied in place (open terminals
// switch family and refit through onTerminalTypographyChange, keeping their state).
// Its rows are read at each open and on each font notification, so the Omarchy row's fallback note follows
// the latest fontDraws verdict (fontFallsBack), not the one at start.
const fontPicker = createFontPicker({ doc: document, fonts: () => fontChoices(navigator.platform.includes("Mac"), fontFallsBack()), current: currentFont, choose: setFont,
  subscribe: onFontChange, onIntent: () => tabOpenIntents.invalidate(), applyFocus: fn => tabOpenIntents.applyFocus(fn) });
window.addEventListener('pagehide', () => fontPicker.dispose(), { once: true });

/** The sidebar's way into the instances, never nothing (the roster's filter was that once): the roster's current
 * row (the roving stop), else its first row, else a control the roster shows (Retry, after a failed read), else, on
 * an empty roster, its one action, the foot's Spawn instance (F6's stop there too, focus-regions.mjs:
 * one way into an empty roster), else, while the roster is hidden (no workspace), the list of workspaces' stop, else
 * its Add local workspace…, always shown with the sidebar. */
function rosterEntry() {
  const list = contextRosterEl?.querySelector(".ctx-list");
  const spawn = document.getElementById("sidebar-spawn");
  // A control the roster shows (Retry, in its notice or its failed block) before the foot's Spawn instance.
  // #1579: the Background heading is a stop of the roster's roving order, and the list's only one when every row is in its closed section.
  return list?.querySelector('.ctx-inst[tabindex="0"], .ctx-background-toggle[tabindex="0"]') || list?.querySelector(".ctx-inst, .ctx-background-toggle")
    || contextRosterEl?.querySelector(':scope > :not(.ctx-head) button:not([disabled])')
    // Spawn instance is in the foot, shown with the sidebar: it is the roster's way in only while the roster is.
    || (contextRosterEl && !contextRosterEl.hidden && spawn && !spawn.disabled ? spawn : null)
    || document.querySelector('#ws-options [tabindex="0"]') || document.getElementById("ws-add-open");
}

/** sidebar.focusFilter, kept under its id (a keys.json rebind still applies) since the roster's filter went
 * (the command palette finds an instance by name): focus the roster's current row, else rosterEntry's next best
 * (an empty roster's Spawn instance). */
function focusRoster() {
  tabOpenIntents.invalidate(); // also when the roster already has DOM focus
  contextPanel.setFocusMode(false);
  setSidebarHidden(false); // a shortcut must not focus display:none content
  const entry = rosterEntry();
  if (entry?.matches(".ctx-inst, .ctx-background-toggle")) setRovingRow(entry.closest(".ctx-list"), entry);
  else entry?.focus({ preventScroll: true });
}

// ── hideable sidebar: full-width terminals on demand ───────────────────
// Class-driven (display:flex on #sidebar beats the hidden attribute) and
// persisted like the other shell prefs. Terminal refits ride each tab's
// ResizeObserver — the panes change width when the sidebar goes away.
const SIDEBAR_HIDDEN_KEY = "oats-desktop-sidebar-hidden";
function sidebarHidden() {
  return document.getElementById("app").classList.contains("sidebar-hidden");
}
function updateSidebarControls() {
  const visible = !sidebarHidden() && !contextPanel.isFocusMode();
  document.getElementById("sidebar-toggle").setAttribute("aria-expanded", String(visible));
  // Show sidebar (Spec B) is shown only while the sidebar is away: it is always the collapsed side.
  const show = document.getElementById("show-sidebar");
  const focused = document.activeElement === show;
  show.hidden = visible;
  if (visible && focused) document.getElementById("sidebar-toggle").focus();
}
function setSidebarHidden(on) {
  document.getElementById("app").classList.toggle("sidebar-hidden", on);
  updateSidebarControls();
  // Hiding by mouse or keyboard must not strand focus in display:none: it goes to Show sidebar, which
  // appears in the sidebar's place (and back to the sidebar's own toggle when it returns).
  if (on && document.getElementById("sidebar").contains(document.activeElement)) {
    document.getElementById("show-sidebar").focus();
  }
  try {
    if (on) localStorage.setItem(SIDEBAR_HIDDEN_KEY, "1");
    else localStorage.removeItem(SIDEBAR_HIDDEN_KEY);
  } catch { /* storage-less */ }
}
function toggleSidebar() {
  if (contextPanel.isFocusMode()) { contextPanel.setFocusMode(false); setSidebarHidden(false); }
  else setSidebarHidden(!sidebarHidden());
}
// Spec B: a closed sidebar leaves nothing behind. Show sidebar, at the start of the main area's top bar
// (shown only while the sidebar is hidden or focus mode is on), runs the SAME sidebar.toggle as the
// chord, the palette and the foot's sidebar toggle (it leaves focus mode too). Show instance panel, at its end,
// runs panel.toggle and then moves focus into the panel it opened.
document.getElementById("show-sidebar").addEventListener("click", () => runAction("sidebar.toggle"));
document.getElementById("show-panel").addEventListener("click", () => { runAction("panel.toggle"); contextPanel.focus(); });
try { if (localStorage.getItem(SIDEBAR_HIDDEN_KEY) === "1") setSidebarHidden(true); } catch { /* storage-less */ }
// The sidebar's width (sidebar-width.mjs): the handle on its right edge, kept on this computer beside the theme.
// Hiding the sidebar leaves the width as it was.
const sidebarWidth = createSidebarWidth({ doc: document, win: window, hold: holdTerminalResizes,
  storage: (() => { try { return window.localStorage; } catch { return null; } })() });

// Terminal copies (#672). Each open terminal tab's xterm, by its wrap, for terminal.copySelection.
const terminalSelections = new Map();
const writeClipboard = text => navigator.clipboard.writeText(text);
const clipboardRefused = error => notifications.notify("Couldn't copy to the clipboard.", { detail: String(error?.message || error) });
/** An OSC 52 write the clipboard refused. tmux sends its copies to every client showing the pane, and the
 * clipboard refuses a write from an unfocused window, so a copy made in another terminal would stack
 * toasts here: it is said only while this window has focus, and otherwise dropped (nothing could have been
 * written). The explicit copies (the chord, the action) always say a refusal. (#694) */
function osc52Refused(error) {
  if (document.hasFocus()) clipboardRefused(error);
}
/** A terminal tab's selection and copies; returns its teardown, run from the tab's onClose. The far
 * side's mouse tracking is recorded, never obeyed, so a drag is xterm's own selection, and the wheel is
 * reported to it (terminal-mouse.mjs). ⌘C / Edit › Copy and right-click › Copy copy it with line ends
 * trimmed. No drag reaches tmux, whatever the remote's version; tmux's own copies (copy mode from the
 * keyboard, or a drag after the mixed-sequence fallback hands tracking to xterm) arrive as OSC 52
 * (write-only, terminal-clipboard.mjs). */
function wireTerminalSelection(term, wrap) {
  const mouse = attachTerminalMouse(term);
  const copies = attachSelectionCopy(term, wrap);
  const clipboard = attachClipboardWrite(term, writeClipboard, osc52Refused);
  terminalSelections.set(wrap, term);
  return () => { clipboard.dispose(); copies.dispose(); mouse.dispose(); if (terminalSelections.get(wrap) === term) terminalSelections.delete(wrap); };
}
/** The selection of the terminal a chord was pressed in; from the palette or the editor (no key event
 * in a terminal), the active tab's. A chord pressed outside a terminal copies nothing. Nothing selected:
 * nothing is written, and nothing reaches the pty. */
function copyTerminalSelectionFrom(e) {
  const pressed = e?.target?.closest?.(".term-wrap");
  if (e?.target && !pressed) return;
  const wrap = pressed || (activeTab != null ? tabs.get(activeTab)?.paneEl?.querySelector(".term-wrap") : null);
  const term = wrap ? terminalSelections.get(wrap) : null;
  if (term) copyTerminalSelection(term, writeClipboard, clipboardRefused);
}

/** Focus the ACTIVE terminal tab's xterm input from anywhere in the shell
 * (explicit action — rebindable, editor-visible). No default chord: every
 * safe candidate is taken or terminal-hostile (any Ctrl chord belongs to
 * the pty on Linux/Windows; plain keys are guarded off editables) — users
 * who want one bind it in the shortcuts editor. */
function focusActiveTerminal() {
  const t = activeTab != null ? tabs.get(activeTab) : null;
  if (t?.kind === "terminal") selectTab(activeTab, { focusContent: true });
}

function visibleTabEntries() {
  return [...tabs].filter(([, t]) => !t.tabEl.hidden);
}

/** A keyboard tab switch keeps focus where the operator works: in the content (a terminal's
 * input) when it was in a tab's content or nowhere, on the new tab when it was on the strip. */
function switchTab(id) {
  const active = document.activeElement;
  const inContent = tabhost.contains(active) || !active || active === document.body;
  if (!selectTab(id, { focusContent: inContent })) return;
  if (!inContent && tabbar.contains(active)) tabs.get(id)?.triggerEl.focus();
}

/** The tabs the tab keys walk, in the order their strip draws them: [[id, tab]]. While the split
 * renders, the CLOSED SET of one group's strip (each .group-tabbar is its own tablist): `id`'s group,
 * or with no tab the focused group, which may be empty. Else every context-visible tab of the flat
 * strip, which split-dom.mjs keeps in creation order. tabs.next/prev and their second chords,
 * tabs.goto1..9 (the active tab's strip) and the strip's own arrows (the focused trigger's). */
function walkedTabs(id = activeTab) {
  const splitShown = tabLayerVisible && !!split && (activeTab == null || tabs.get(activeTab)?.kind === "terminal");
  const group = !splitShown ? null
    : id == null ? split.groups.find(g => g.id === split.focusedGroup) ?? null : groupOfTab(split, id);
  return group ? group.tabs.map((tid) => [tid, tabs.get(tid)]).filter(([, t]) => t) : visibleTabEntries();
}

/** Next / previous tab of the active tab's strip, wrapping; with no active tab in a strip that has tabs,
 * next is the first and previous the last. (The tab keys are off on a stage: context `tabs`.) */
function cycleTab(delta) {
  const vis = walkedTabs();
  if (!vis.length) return;
  const at = vis.findIndex(([tid]) => tid === activeTab);
  const [nextId] = vis[at < 0 ? (delta > 0 ? 0 : vis.length - 1) : (at + delta + vis.length) % vis.length];
  switchTab(nextId);
}

/** Go to tab n (1-based) of the active tab's strip; 9 is the last tab, as in browsers. */
function gotoTab(n) {
  const vis = walkedTabs();
  if (!vis.length) return;
  const [id] = n >= 9 ? vis.at(-1) : vis[n - 1] ?? [];
  if (id != null) switchTab(id);
}

// ── keyboard regions (F6 / Shift+F6) and "back to where you were" ──────
// focus-regions.mjs owns the order and each region's current item; the
// shell supplies the active tab's content (a terminal focuses through its
// selection intent, like every explicit terminal focus).
function focusMainContent() {
  if (activeTab == null) {
    const empty = tabhost.querySelector(".focused-group > .split-empty");
    if (empty) tabOpenIntents.applyFocus(() => empty.focus());
    return !!empty && document.activeElement === empty;
  }
  const t = tabs.get(activeTab);
  if (!t) return false;
  if (t.focusContent) { selectTab(activeTab, { focusContent: true }); return t.paneEl.contains(document.activeElement); }
  const first = firstTabbable(t.paneEl);
  if (first) tabOpenIntents.applyFocus(() => first.focus());
  return !!first && document.activeElement === first;
}
const focusRegions = createFocusRegions({ doc: document, tabLayerVisible: () => tabLayerVisible, focusMainContent });

// ── a workspace switch puts the keyboard back where it was there ──────────
// focus-place.mjs describes where the focus is; every focus outside the transit surfaces (the list of
// workspaces, the palette, dialogs, menus) is kept with the workspace shown, and restoreWorkspaceTabs takes
// the workspace's place as it is left and applies the arriving one's (focusArrival).
const focusPlaces = createFocusPlaces({ doc: document, regionOfFocus: () => focusRegions.regionOfFocus(),
  activeTab: () => (tabLayerVisible && activeTab != null && tabs.has(activeTab) ? { id: activeTab, paneEl: tabs.get(activeTab).paneEl } : null) });
document.addEventListener("focusin", () => focusPlaces.note(tabWorkspace));
// The operator's own keys and clicks (spawn-follow.mjs): a roster place waiting for its paint is dropped after them.
const operator = watchOperator(document);
let rosterPlace = null; // a roster place waiting for the arriving workspace's roster (applyRosterPlace)

/** Focus `el`; true when it holds the focus. */
function focusOn(el) {
  el?.focus();
  return !!el && document.activeElement === el;
}

/** A switch landed (restoreWorkspaceTabs): the keyboard goes back where it was in the workspace shown, its focus
 * `place` (focus-place.mjs), under one intent ticket, so a click, a key, an open or another switch made meanwhile
 * supersedes it. A place that is gone falls to what the tab rules left active, or its region's landing, never
 * <body>. With no place, the focus stays where it is while that is shown, else lands on main. Nothing moves for a
 * landing that places nothing (views/common.mjs landsFocusPlace: a caller focusing its own target, a step from the
 * list of workspaces, a view followed, a take-over's layout) or under a modal dialog or the palette (their own return
 * owns the focus). The DOM focus only: the window itself is never focused or raised for it. */
function focusArrival(place) {
  rosterPlace = null;
  pageWatch?.disconnect(); pageWatch = null;
  const ws = currentWorkspace();
  if (!ws || !landsFocusPlace(ws) || modalOpen()) return;
  const owns = tabOpenIntents.begin();
  const main = () => focusRegions.focusRegion("main");
  if (place?.kind === "roster") {
    // Focus mode, or the sidebar hidden: the roster can't be shown for it, and neither is left for it.
    if (!focusRegions.visible("roster")) { watchPage(owns, main); return; }
    // Its rows arrive with the roster's read: the first paint of them applies it (applyRosterPlace).
    rosterPlace = { owns, handle: place.handle, input: operator.input(), pointer: operator.pointer(), focus: document.activeElement };
    return;
  }
  if (place?.kind === "tab" && place.content && selectTab(place.tab, { focusContent: true, intent: owns })) {
    const t = tabs.get(place.tab);
    if (t.paneEl.contains(document.activeElement)) return;
    // A terminal's input takes the focus only while it can be typed in: one attaching or reconnecting takes it once
    // ready (its readiness focus, still this ticket's), and one whose session ended never does. Its tab has the focus
    // meanwhile, and nothing typed there reaches a terminal. A tab with no input of its own: the control that had the
    // focus in it, else its first one.
    tabOpenIntents.applyFocus(() => (t.focusContent ? focusOn(t.triggerEl) : place.handle.restoreExact()) || main());
    return;
  }
  if (place?.kind === "tab" && tabLayerVisible) {
    const t = activeTab != null ? tabs.get(activeTab) : null;
    // A control of the tab layer (the strip, the split controls, an empty group), else the active tab's (its trigger,
    // or the focused empty group); a content place whose tab closed meanwhile: what the tab rules left active.
    tabOpenIntents.applyFocus(() => (!place.content && (place.handle.restoreExact() || focusOn(t?.triggerEl ?? tabhost.querySelector(".focused-group > .split-empty")))) || main());
    return;
  }
  // No place: the focus stays where the switch found it while that is still shown once the page has repainted (a
  // pick keeps its row of the list), else lands on main.
  if (!place) { watchPage(owns, () => !focusLost() || main()); return; }
  // The rest lands on the page, the views, the instance panel or the foot: by identity, or a control near it in its
  // own region (never a transit surface, never another region), else that region's landing.
  watchPage(owns, () => {
    if (place?.kind !== "other") return main();
    const target = place.handle.resolve();
    if (target && !isTransit(target) && focusOn(target) && focusRegions.regionOfFocus() === place.region) return true;
    return (!!place.region && focusRegions.focusRegion(place.region)) || main();
  });
}

/** The focus is nowhere: on <body>, or on a control no longer shown (a page repaint removed it). */
function focusLost() {
  const at = document.activeElement;
  return !at || at === document.body || !isShown(at);
}

/** A landing on the page (focusArrival): the mounted views repaint for the workspace in their own listeners, which run
 * after the shell's, and some again when their reads answer. So `land` runs once every workspace listener has run,
 * then again at each repaint of the page while it has not landed yet (the page still loading) or the repaint left
 * the focus on <body> (or on a control no longer shown), until the operator presses a key or clicks, the ticket is
 * gone (a selection, an open, another switch) or a modal opens. `land` answers whether the focus landed. */
let pageWatch = null;
function watchPage(owns, land) {
  const input = operator.input(), pointer = operator.pointer();
  const quiet = () => owns() && !modalOpen() && operator.input() === input && operator.pointer() === pointer;
  queueMicrotask(() => {
    if (!quiet()) return;
    let landed = tabOpenIntents.applyFocus(land);
    if (typeof MutationObserver !== "function") return;
    const watch = pageWatch = new MutationObserver(() => {
      if (!quiet()) { watch.disconnect(); if (pageWatch === watch) pageWatch = null; return; }
      if (!landed || focusLost()) landed = tabOpenIntents.applyFocus(land);
    });
    watch.observe(stageHost, { childList: true, subtree: true });
  });
}

/** A roster place (focusArrival) is applied by the arriving workspace's first roster paint of rows, or of a failed
 * read (its Retry): the row by its instance, else the roster's landing (its selected row, else its first control).
 * Never once its ticket is gone (a selection, an open, another switch) or the operator has acted since the switch
 * (a key, or a click that moved the focus), nor under a modal dialog or the palette. Every roster paint calls it. */
function applyRosterPlace() {
  const place = rosterPlace;
  if (!place) return;
  rosterPlace = null;
  if (!place.owns() || modalOpen() || operator.input() !== place.input
    || (operator.pointer() !== place.pointer && document.activeElement !== place.focus)) return;
  tabOpenIntents.applyFocus(() => {
    if (!focusRegions.visible("roster")) return focusRegions.focusRegion("main");
    if (place.handle.restoreExact()) {
      const row = document.activeElement;
      // The row that has the focus is the roster's tab stop (renderContextRoster's roving rule).
      if (row.classList.contains("ctx-inst")) setRovingRow(row.closest(".ctx-list"), row);
      return true;
    }
    return focusRegions.focusRegion("roster") || focusRegions.focusRegion("main");
  });
}
/** A modal (a dialog, the palette) keeps focus inside itself: regions don't cycle out of it. */
const modalOpen = () => [...document.querySelectorAll('[aria-modal="true"]')].some(dialog => isShown(dialog));
function cycleRegion(delta) {
  if (modalOpen()) return;
  tabOpenIntents.invalidate();
  focusRegions.cycle(delta);
}
const surfaceReturn = createSurfaceReturn({ doc: document, currentWorkspace, workspaceGeneration,
  surface: () => ({ stage: stage?.name ?? null, tab: activeTab, tabLayerVisible,
    workspaceTab: stage?.name === "spawn" ? stage.mod?.currentWorkspaceTab?.() ?? null : null }),
  tabPane: id => { const t = tabs.get(id); return t && canActivateTab(t, currentWorkspace()) ? t.paneEl : null; },
  showStage, selectTab: (id, opts) => selectTab(id, opts), focusRegion: name => focusRegions.focusRegion(name),
  selectWorkspaceTab: name => stage?.name === "spawn" && stage.mod?.preselectWorkspaceTab?.(name)
    && stage.mod.currentWorkspaceTab?.() === name ? document.getElementById(`workspace-tab-${name}`) : null,
  host: "spawn" });

// ── action registry: every mouse affordance, one keyboard action ────────
// Default chords live in the engine's DEFAULT_KEYMAP (keybindings.mjs);
// user overrides persist in localStorage via the shortcuts editor.
for (const [id, action, label] of [['instance.openSplit', 'open-split', 'Instance menu: Open in split'], ['instance.openPullRequest', 'open-pr', 'Instance menu: Open pull request']]) {
  registerAction({ id, label, context: 'instance-menu', run: () => {
    const menu = activeInstanceMenu;
    if (menu?.owns() && menu.element.isConnected && menu.element.dataset.instanceMenuOpen === 'true' && menu.element.contains(document.activeElement)) void menu.run(action);
  } }); // no new default chord, especially no terminal Ctrl interception
}
/** The leader's target (leaderTargetId) where the palette was opened from: its instance entries act on it. */
let paletteTargetId = null;
registerAction({ id: "app.palette", label: "Open the command palette", context: "global", run: () => { tabOpenIntents.invalidate(); if (!palette.isOpen()) paletteTargetId = leaderTargetId(document.activeElement); palette.toggle(); } });
registerAction({ id: "app.quickOpenSouls", label: "Quick open a soul to spawn", context: "global", run: () => { tabOpenIntents.invalidate(); quickOpen.toggle(); } });
registerAction({ id: "app.chooseSoul", label: "Souls: choose a soul to spawn (Workspace › Souls)", context: "global", run: () => openWorkspaceSouls() });
registerAction({ id: "app.shortcuts", label: "Edit keyboard shortcuts", context: "global", run: () => openShortcutsEditor() });
registerAction({ id: "app.connections", label: "Settings: Connections…", context: "global", run: () => openConnections() });
// A window with no workspace, showing the switcher (#481). No default chord: Ctrl+Shift+N stays Choose soul.
if (typeof desktopBridge.windowOpenWorkspace === "function") {
  registerAction({ id: "app.newWindow", label: "Window: new window", context: "global", run: () => { void desktopBridge.windowOpenWorkspace(null); } });
}
const unregisterOpenFile = registerAction({ id: "app.openFile", label: "File: open read-only…", context: "global", defaultChord: "Mod+O", run: () => fileOpener.choose() });
window.addEventListener("pagehide", () => { tabOpenIntents.invalidate(); unregisterOpenFile(); fileOpener.dispose(); }, { once: true });
// stage-switch actions derive from the nav manifest (same rule as the
// palette): a new rail destination can never be shortcut-invisible.
[...NAV, ...NAV_TABS].forEach((v) => registerAction({
  id: `stage.${v.name}`, label: `View: ${v.label}`, context: "global",
  run: () => showStageFocused(v.name),
}));
// A held chord (key repeat) does nothing: it never opens and closes the picker over and over.
registerAction({ id: "app.themePicker", label: "Choose a theme…", context: "global", run: (e) => { if (!e?.repeat) themePicker.toggle(); } });
registerAction({ id: "app.fontPicker", label: "Font: choose…", context: "global", run: (e) => { if (!e?.repeat) fontPicker.toggle(); } });
registerAction({ id: "app.themeToggle", label: "Cycle White / Solarized / Dark / This computer theme", context: "global", run: () => toggleTheme() });
// Explicit theme choices are rebindable, but add no default keyboard chords.
THEMES.forEach(({ id, label }) => registerAction({
  id: `app.theme.${id}`, label: `Theme: ${label}`, context: "global", run: () => setTheme(id),
}));
registerAction({ id: "app.workspaces", label: "Focus the list of workspaces", context: "global", run: () => focusWorkspaceList() });
registerAction({ id: "workspaces.currentOnly", label: "Show only the current workspace", context: "global", run: () => workspaceLabel.toggleCurrentOnly() });
registerAction({ id: "sidebar.focusFilter", label: "Focus the instance roster", context: "global", run: () => focusRoster() });
registerAction({ id: "sidebar.toggle", label: "Toggle the sidebar", context: "global", run: () => toggleSidebar() });
registerAction({ id: "sidebar.resetWidth", label: "Reset the sidebar's width", context: "global", run: () => sidebarWidth.reset() });
registerAction({ id: "panel.toggle", label: "Show or hide the instance panel", context: "global", run: () => { tabOpenIntents.invalidate(); contextPanel.toggle(); } });
// Focus mode lives on the keyboard (rebindable, no default chord) and the palette.
registerAction({ id: "app.focusMode", label: "Toggle focus mode (sidebar and instance panel)", context: "global", run: () => { tabOpenIntents.invalidate(); contextPanel.toggleFocusMode(); } });
// splits live on the tab layer (they arrange terminal tabs); the actions
// are terminal-allowlisted so the chords work inside xterm too.
registerAction({ id: "split.vertical", label: "Split terminal right (side by side)", context: "tabs", run: () => splitPane("row") });
registerAction({ id: "split.horizontal", label: "Split terminal down (stacked)", context: "tabs", run: () => splitPane("col") });
registerAction({ id: "split.close", label: "Close the split (single pane)", context: "tabs", run: () => closeSplit() });
// Recovery must also work from the stage. No new default keyboard binding.
registerAction({ id: "split.restore", label: "Return to terminal groups", context: "global", run: () => restoreTerminalGroups() });
// Ctrl+Shift+C on Linux/Windows (DEFAULT_KEYMAP), terminal-allowlisted; macOS copies with ⌘C, the menu role.
registerAction({ id: "terminal.copySelection", label: "Terminal: copy the selection", context: "global", run: (e) => copyTerminalSelectionFrom(e) });
// No defaultChord (documented): safe candidates are exhausted — rebindable in the editor.
registerAction({ id: "terminal.focusActive", label: "Focus the active terminal input", context: "global", run: () => focusActiveTerminal() });
registerAction({ id: "terminal.fontBigger", label: "Terminal: increase font size", context: "global", run: () => setTerminalFontSize(terminalTypography().fontSize + 1) });
registerAction({ id: "terminal.fontSmaller", label: "Terminal: decrease font size", context: "global", run: () => setTerminalFontSize(terminalTypography().fontSize - 1) });
registerAction({ id: "terminal.fontReset", label: "Terminal: reset typography", context: "global", run: () => resetTerminalTypography() });
// tabs: cycle + close work whether or not a tab trigger has focus (the
// tab-a11y roving arrows stay as focus keys on the strip itself). Tab switching
// never happens under an open modal (the palette, a sheet, a dialog), as F6 doesn't.
const unlessModal = (fn) => () => { if (!modalOpen()) fn(); };
registerAction({ id: "tabs.next", label: "Next tab", context: "tabs", run: unlessModal(() => cycleTab(1)) });
registerAction({ id: "tabs.prev", label: "Previous tab", context: "tabs", run: unlessModal(() => cycleTab(-1)) });
registerAction({ id: "tabs.close", label: "Close the active tab", context: "tabs", run: () => { if (activeTab != null) closeTab(activeTab, true); } });
// Second chords for tab cycling, the shared tab moves (Alt+Shift+→/← on Linux and Windows,
// ⌘⌥→/← on macOS): their own ids, so each stays rebindable and unbindable on its own.
registerAction({ id: "tabs.nextPage", label: "Next tab (second shortcut)", context: "tabs", run: unlessModal(() => cycleTab(1)) });
registerAction({ id: "tabs.prevPage", label: "Previous tab (second shortcut)", context: "tabs", run: unlessModal(() => cycleTab(-1)) });
for (let n = 1; n <= 9; n++) {
  registerAction({ id: `tabs.goto${n}`, label: n === 9 ? "Go to the last tab" : `Go to tab ${n}`, context: "tabs", run: unlessModal(() => gotoTab(n)) });
}
// Regions: workspaces → views (the nav) → instance roster → main → instance panel (focus-regions.mjs).
registerAction({ id: "focus.nextRegion", label: "Focus the next region (workspaces, views, instances, main, panel)", context: "global", run: () => cycleRegion(1) });
registerAction({ id: "focus.prevRegion", label: "Focus the previous region", context: "global", run: () => cycleRegion(-1) });
// F6 stays the program's inside a terminal (mc, htop, nano): this terminal-allowlisted chord
// leaves it for the next region, same order as F6; from there plain F6 works.
registerAction({ id: "focus.leaveTerminal", label: "Leave the terminal (focus the next region)", context: "global", run: () => cycleRegion(1) });

// The leader's Tab and Shift+Tab (docs/desktop-keyboard.md, "The leader"): the next / previous editor
// group's active tab, or the group itself when it is empty, wrapping. Their chords are the shared
// group-next and group-previous (Alt+Shift+→/←; Ctrl+Alt+A / Ctrl+Alt+Shift+A; ⌘⌥A, none on macOS).
registerAction({ id: "split.focusNextGroup", label: "Focus the next editor group", context: "tabs", run: unlessModal(() => focusGroup(1)) });
registerAction({ id: "split.focusPrevGroup", label: "Focus the previous editor group", context: "tabs", run: unlessModal(() => focusGroup(-1)) });
/** The group `delta` (1 next, -1 previous) from the focused one, wrapping. */
function focusGroup(delta) {
  if (!tabLayerVisible || !split || split.groups.length < 2) return;
  const at = split.groups.findIndex(g => g.id === split.focusedGroup);
  const next = split.groups[(at + delta + split.groups.length) % split.groups.length];
  tabOpenIntents.invalidate();
  if (next.activeTab != null) { selectTab(next.activeTab, { focusContent: true }); return; }
  if (selectEmptyGroup(next.id)) tabOpenIntents.applyFocus(() => tabhost.querySelector(".focused-group > .split-empty")?.focus());
}


// THE one window keydown listener. The engine owns the terminal policy
// (⌘ chords on mac; the action-id allowlist on Linux/Windows, where the
// allowlisted defaults leave plain Ctrl+letter the program's). View-local handlers (hierarchy canvas,
// roster rows, palette input) preventDefault the keys they consume; the
// engine must not double-dispatch them.
// The engine skips already-consumed (defaultPrevented) events itself.
window.addEventListener("keydown", (e) => handleKeydown(e));
// macOS: a ⌘⌥ / ⌃⌥ chord names its key by the layout's character for it (keybindings.mjs
// readKeyboardLayout), read now and whenever the window comes back (the layout may have changed).
if (isMac) {
  void readKeyboardLayout(navigator);
  window.addEventListener("focus", () => { void readKeyboardLayout(navigator); });
}

// ── the leader (Ctrl+X, the TUI's): one key after it, from every focus ─────────────────────
// leader.mjs settles the wait on the next key; leader-keys.mjs says which rows apply and their
// words; leader-dispatch.mjs runs a `does` (the leader's and the sidebar keys' alike); the hint
// shows nothing while it waits (the wait is announced to a screen reader; the shortcuts editor lists
// the keys) and says, in one line, why a key did not run.
const actionLabel = id => listActions().find(action => action.id === id)?.label ?? null;
const leaderHint = createLeaderHint({ doc: document, host: document.getElementById("main"), before: document.getElementById("show-panel") });
let hintLineArmed = false;
/** One line in the hint: it stays until the next keydown, click or focus change (never on a timer). */
function sayInHint(line) {
  leaderHint.say(line);
  hintLineArmed = false;
  setTimeout(() => { hintLineArmed = leaderHint.mode() === "line"; }, 0);
}
for (const type of ["keydown", "pointerdown", "focusin", "focusout"]) {
  window.addEventListener(type, () => { if (hintLineArmed && leaderHint.mode() === "line") { hintLineArmed = false; leaderHint.hide(); } }, true);
}
/** What the window shows now, for the rows that apply (leader-keys.mjs leaderApplies). */
function leaderState() {
  const ws = currentWorkspace();
  const terminalOpen = tabLayerVisible && [...tabs.values()].some(t => t.kind === "terminal" && canActivateTab(t, ws));
  const active = activeTab != null ? tabs.get(activeTab) : null;
  const controls = splitControlsState(split, activeTab, active?.kind ?? null, tabLayerVisible);
  // The tabs ←/→ walk (walkedTabs): with the tabs split, the focused group's, so an empty or one-tab group says why.
  return { terminalOpen, tabs: tabLayerVisible ? walkedTabs().length : 0,
    canSplitRow: !!controls.splitRow, canSplitCol: !!controls.splitCol, split: tabLayerVisible && !!split && split.groups.length >= 2 };
}
/** The instance a key acts on, read where it was pressed: the focused roster row's, else the shown
 * terminal tab's (a key pressed in a terminal, or nowhere), else none. Its instanceId. A terminal
 * holding focus counts only as the shown one: focus can stay in a pane hidden since. */
function leaderTargetId(el) {
  // The row itself, or one of its tools (Start…, the PR link) or its context menu's items, which sit beside
  // it in its .ctx-tree-row.
  const row = el?.closest?.("#instance-roster .ctx-inst") ?? el?.closest?.("#instance-roster .ctx-tree-row")?.querySelector(".ctx-inst");
  if (row?.dataset.treeInstance) return row.dataset.treeInstance;
  const active = activeTab != null ? tabs.get(activeTab) : null;
  return active?.kind === "terminal" && active.instanceRef ? instanceId(active.instanceRef) : null;
}
/** The instance the newest terminal open is opening while it is in flight, and after it while its tab is the
 * one shown, as long as no other selection came since (its ticket owns); else null. */
function openingInstanceId() {
  const opening = terminalOpening;
  // The resolved row, else the reference when it is a row (a bare name means nothing until resolved).
  const of = opening?.inst ?? (opening?.ref && typeof opening.ref === "object" ? opening.ref : null);
  if (!of || !opening.owns()) return null;
  const id = instanceId(of);
  const shown = activeTab != null ? tabs.get(activeTab) : null;
  return opening.pending || (shown?.kind === "terminal" && shown.instanceRef && instanceId(shown.instanceRef) === id) ? id : null;
}
/** What a key after the leader, a sidebar key or a chord that does one's work acts on, read when that key is
 * pressed at `el`: `targetId` (leaderTargetId), and `stepFromId` the instance ↑/↓ go on from: an open in
 * flight's (a press faster than /api/panel or the attach moves on from it), else the target. */
function leaderOrigin(el) {
  const targetId = leaderTargetId(el);
  return { targetId, stepFromId: openingInstanceId() ?? targetId };
}
const rosterInstance = id => (id == null ? null : shownRows(contextInstances).find(i => instanceId(i) === id) ?? null);
/** Why a key cannot do its row's work now (leader-keys.mjs leaderApplies): the key, after the leader or in
 * the sidebar, says why in the hint's line rather than doing nothing silently. */
function notApplicable(does) {
  const row = LEADER_TABLE.find(r => r.does === does);
  if (!row) return null;
  const state = leaderState();
  if (leaderApplies(row, state)) return null;
  if (row.terminal && !state.terminalOpen) return "No terminal tab is open.";
  if (does === "tab-previous" || does === "tab-next") return "There is no other tab.";
  if (does === "split-right" || does === "split-down") return "The active tab can't be split that way now.";
  return "The tabs are not split.";
}
/** The row's context menu's own block for `instance`, or null: an act of its menu still in flight
 * (instance-actions.mjs pendingActionReason), or a stale roster or a stale deployment's row
 * (renderContextRoster's heldStale, which holds the menu). Read from that state, not from the
 * drawn row, so a row a collapse leaves undrawn is held the same. */
function rosterActsHeld(instance) {
  const waiting = pendingActionReason(contextWorkspace || currentWorkspace(), instance);
  if (waiting) return waiting;
  return rosterStale || rowStale(instance, contextDeployments) ? ROSTER_STALE_TITLE : null;
}
const leaderDispatch = createLeaderDispatch({
  say: sayInHint,
  targetId: origin => origin.targetId ?? null,
  stepFrom: origin => origin.stepFromId ?? null,
  target: origin => rosterInstance(origin.targetId ?? null),
  rosterRows: () => [...(contextRosterEl?.querySelectorAll(".ctx-list .ctx-inst:not(.pending)") || [])].map(row => {
    const instance = rosterInstance(row.dataset.treeInstance);
    return { id: row.dataset.treeInstance, openable: instance?.running === true && row.getAttribute("aria-disabled") !== "true", open: () => row.click() };
  }),
  menuReason: rosterActsHeld,
  openAct: (verb, instance) => {
    const ws = contextWorkspace || currentWorkspace();
    if (verb === "stop" || verb === "retire") openLifecycleDialog(verb, instance, ws);
    else openInstanceStart(instance, { restart: verb === "restart" });
  },
  spawnSoul: instance => soulSpawn.open({ name: instance.agent, agentsRoot: instance.agentsRoot, ...(instance.server ? { server: instance.server } : {}) }, {
    onMiss: count => sayInHint(count ? `Several souls are named ${instance.agent}; pick it in the Workspace view.` : `${instance.agent} is not in this workspace's souls.`),
  }),
  palette: () => runAction("app.palette"),
  instances: () => {
    const ws = currentWorkspace();
    if ([...tabs.values()].some(t => t.kind === "terminal" && canActivateTab(t, ws))) showTerminalContext();
    else void showStageFocused("hierarchy");
  },
  souls: () => runAction("app.chooseSoul"),
  capabilities: () => openWorkspaceSouls("capabilities"),
  // The TUI's zoom is a toggle, so this one is: focus mode on or off, and the active terminal focused either way.
  zoom: () => { runAction("app.focusMode"); focusActiveTerminal(); },
  closeTab: () => runAction("tabs.close"),
  tabPrevious: () => runAction("tabs.prev"),
  tabNext: () => runAction("tabs.next"),
  splitRight: () => runAction("split.vertical"),
  splitDown: () => runAction("split.horizontal"),
  nextGroup: () => runAction("split.focusNextGroup"),
  previousGroup: () => runAction("split.focusPrevGroup"),
  closeSplit: () => runAction("split.close"),
  quickOpen: () => runAction("app.quickOpenSouls"),
  filter: () => runAction("sidebar.focusFilter"),
  workspaces: () => runAction("app.workspaces"),
  // A step made from the list of workspaces leaves the focus there (the operator is browsing workspaces with
  // the moves); from anywhere else, the workspace shown puts it back where it was there (focusArrival).
  workspaceStep: delta => workspaceLabel.step(delta, { focusPlace: focusRegions.regionOfFocus() !== "workspaces" }),
  help: () => runAction("app.shortcuts"),
  list: () => {
    if (sidebarHidden() || contextPanel.isFocusMode()) runAction("sidebar.toggle");
    tabOpenIntents.invalidate();
    focusRegions.focusRegion("roster");
  },
  refresh: () => { void refreshContextRoster({ user: true }); },
});
const leader = createLeader({ win: window, isMac, modalOpen,
  // A key the Desktop has no operation for (m) cancels, as one outside the table does. A key whose row
  // does not apply now (nothing to split, no terminal) settles, and its line says why.
  supports: does => leaderDispatch.supports(does),
  onOpen: () => leaderHint.announce(),
  onClose: () => { if (leaderHint.mode() === "wait") leaderHint.hide(); },
  // The target is read at the key, not when the leader was pressed: whatever moved focus meanwhile is what the user sees.
  onSettle: does => { const why = notApplicable(does); if (why) sayInHint(why); else leaderDispatch.run(does, leaderOrigin(document.activeElement)); },
});
window.addEventListener("pagehide", () => leader.dispose(), { once: true });
// The chord, from every focus, a terminal's and an editable field's included. Under a modal dialog
// or the palette it is not there at all (`when`): the key goes where it goes without it.
registerAction({ id: "app.leader", label: "Leader: the commands that follow one key", context: "global", when: () => !modalOpen(),
  run: () => { leader.start(); } });
/** A key that does what the leader then a key does, from where it was pressed: the leader's own
 * target (leaderOrigin) and rules (notApplicable's line when it cannot act). */
function runAsLeaderKey(does, e) {
  const why = notApplicable(does);
  if (why) { sayInHint(why); return; }
  leaderDispatch.run(does, leaderOrigin(e?.target ?? document.activeElement));
}
// The sidebar's plain keys (the TUI's, shared PLAIN_KEYS): one action per key, the same `does` as
// the leader's, acting on the focused roster row (on a nav or heading control: the selected row).
for (const { id, does } of SIDEBAR_KEYS) {
  registerAction({ id, label: leaderLabel(does, actionLabel), context: "sidebar", run: (e) => runAsLeaderKey(does, e) });
}
// The previous / next instance, the previous / next workspace and the leader's z on chords (the shared
// CHORDS previous, next, workspace-previous, workspace-next, zoom: Alt+Shift+↑/↓, Alt+↑/↓ and Alt+Z;
// ⌘⌥↑/↓ and ⌘⌥Z, and no workspace chord, on macOS): the instance steps have no leader key (the leader's
// ↑ / ↓ move between workspaces); each runs the one dispatch, for the leader's target, from every focus.
// Inert under a modal dialog or the palette, as the leader is.
for (const [id, does] of [["roster.openPrevious", "previous"], ["roster.openNext", "next"],
  ["workspace.previous", "workspace-previous"], ["workspace.next", "workspace-next"], ["terminal.focusMode", "zoom"]]) {
  registerAction({ id, label: leaderLabel(does, actionLabel), context: "global", when: () => !modalOpen(), run: (e) => runAsLeaderKey(does, e) });
}
// The instance's name and colour (#1421; CHORDS edit-instance, no leader key): the leader's target, from
// every focus, a terminal's included. Inert under a modal dialog or the palette, as the leader is.
registerAction({ id: "instance.edit", label: "Instance: name and colour…", context: "global", when: () => !modalOpen(),
  run: (e) => openInstanceEdit(leaderTargetId(e?.target ?? document.activeElement)) });

// Chord-suffixed tooltips, live against the keymap: any control that
// declares data-action gets “ … (chord)” appended to its base title.
const baseTitles = new WeakMap();
function applyChordTitles() {
  settingsMenu.refresh();
  for (const el of document.querySelectorAll("[data-action]")) {
    if (!baseTitles.has(el)) baseTitles.set(el, el.title || "");
    const chord = getBinding(el.dataset.action, isMac);
    const base = baseTitles.get(el);
    el.title = chord ? `${base} (${formatChord(chord, isMac)})` : base;
  }
  for (const el of document.querySelectorAll("[data-shortcut]")) {
    const chord = getBinding(el.dataset.shortcut, isMac);
    el.textContent = chord ? formatChord(chord, isMac) : "";
    el.hidden = !chord;
  }
}
onKeymapChange(() => applyChordTitles());
applyChordTitles();

// A launch's --instance (launch-focus.mjs): its row is selected as "show in roster" selects it, once an observed
// roster read lists it, unless the person chose something first. Running rows open through the click's path,
// keeping keyboard focus on the roster. Other rows select only; a launch never starts an instance.
const launchFocus = createLaunchFocus({
  watch: () => tabOpenIntents.watch(), operator,
  select: (row) => showInRoster(row, { read: false }),
  open: async (row, valid) => {
    const selected = showInRoster(row, { read: false });
    // showInRoster selects synchronously with read:false, invalidating the previous ticket itself.
    let owns = tabOpenIntents.watch();
    try {
      if (!await selected || !owns() || !valid()) return;
      if (heldHome(shownRows([row])[0]) || rosterStale || rowStale(row, contextDeployments) || !canAddressRemote(row)) return;
      const target = instanceActionTarget(currentWorkspace(), row);
      if (!target) return;
      const opening = openTerminalTab(row, { expected: target, valid, followed: true, focusContent: false });
      // The opener begins its own selection intent; failures belong to that intent from here on.
      owns = tabOpenIntents.watch();
      await opening;
    } catch (error) {
      if (owns() && valid()) alert(error?.message || String(error));
    }
  },
  notify: (text) => notifications.notify(text),
});
window.addEventListener('pagehide', () => launchFocus.dispose(), { once: true });

// Persistent recursive instance tree: always available between the list of
// workspaces' views and the foot, with no second/contextual sidebar and no width jump.
initContextRoster();
onWorkspaceChange(restoreWorkspaceTabs);
// After it: a take-over's layout, once the workspace it came with is this window's (restoreHandedLayout).
onWorkspaceChange((ws) => { const handed = handedLayout(ws); if (handed) void restoreHandedLayout(ws, handed); });
// A take-over: another window took this window's workspace (main's window:release-workspace).
desktopBridge?.onWorkspaceRelease?.((message) => { void releaseTakenWorkspace(message); });
// A launch asks this window to select an instance (main's window:focus-instance). The rows of the newest roster read,
// painted for the workspace shown, answer it at once (an earlier visit's rows never do: a read begun since, a
// switch's included, moves contextRosterGen on); otherwise the next roster read does.
desktopBridge?.onLaunchFocus?.((message) => {
  launchFocus.request(message);
  const painted = shownRoster?.gen === contextRosterGen && shownRoster.ws === currentWorkspace() && contextWorkspace === shownRoster.ws;
  if (painted && launchFocus.pending()) launchFocus.observe(shownRoster.instances);
});
/** Another window took `workspace` over. This window answers main at once, with the layout it shows of it
 * (layout-handover.mjs: its terminals and its split; file, brain and view tabs do not move), then leaves it
 * (views/common.mjs leaveTakenWorkspace: its previous workspace, else the switcher), then closes every tab it
 * has of it, each terminal's viewer with it, and forgets that workspace's layout: nothing of it stays attached
 * or writable here. A late release (main moved the binding without waiting) ends the same way. */
async function releaseTakenWorkspace(message) {
  const workspace = typeof message?.workspace === "string" && message.workspace ? message.workspace : null;
  if (!workspace) return;
  // Under any id it names here: main may have rekeyed this window from a deployment id to its view first.
  const taken = takenWorkspaceIds(workspace, message.workspaces);
  const shown = currentWorkspace();
  const layout = taken.has(shown) ? describeLayout(tabs, split, activeTab, shown) : null;
  try { await desktopBridge.windowReleaseAnswer?.(message.request, layout ? { layout } : null); } catch { /* main moves it after its wait */ }
  try { await leaveTakenWorkspace(workspace, message.workspaces); }
  finally { closeWorkspaceTabs(taken); }
}
/** Close every tab of the workspace `taken` names (a Set of its ids: one this window no longer shows): a
 * background close, which cancels no pending open and moves no focus, and a terminal's goes through its own
 * teardown (its viewer closed). */
function closeWorkspaceTabs(taken) {
  for (const [id, t] of [...tabs]) if (taken.has(t.workspace)) closeTab(id, false, { explicit: false, background: true, passive: true });
  for (const workspace of taken) { workspaceTabMemory.forget(workspace); focusPlaces.forget(workspace); wsActiveTerminal.delete(workspace); }
}
/** A take-over's layout (layout-handover.mjs), handed over by the window the workspace came from: its terminals
 * opened here again (fresh viewers; the agents keep running) and laid out as they were, under ONE intent ticket, so
 * any selection made meanwhile (a click, a key, another open) supersedes what is left of it, as does a switch or a new
 * connection. A terminal that no longer resolves in this workspace's roster, or no longer runs, is left out, as a
 * stale memory's is (workspace-tab-memory.mjs recall). A layout off the descriptor's shape (main refuses one; this
 * is the backstop) restores nothing, and throws nothing. */
async function restoreHandedLayout(ws, layout) {
  if (!validLayout(layout)) return;
  const owns = tabOpenIntents.begin(), gen = workspaceGeneration(), connection = connectionGeneration;
  const still = () => owns() && workspaceGeneration() === gen && currentWorkspace() === ws && connection === connectionGeneration;
  const read = ++panelReads;
  let panel;
  try { panel = await api(`/api/panel?ws=${encodeURIComponent(ws)}`); } catch { return; }
  if (!still()) return;
  const quiet = (msg) => console.warn(`[take-over] ${msg}`);
  const opened = [];
  for (const ref of layout.terminals) {
    opened.push(null);
    const r = resolveTerminalOpen(panel.instances || [], ref, ws);
    if (r.error) continue;
    try { await whenKeyFree(r.key); } catch { return; }
    if (!still()) return;
    const pending = JSON.stringify([r.key, terminalOrigin(r.inst).incarnation]);
    if (!pendingTerms.has(pending)) {
      pendingTerms.add(pending);
      try { await openTerminalTabInner(r.inst, ws, r.key, still, quiet, () => true, read); }
      catch (error) { quiet(error?.message || String(error)); }
      finally { pendingTerms.delete(pending); }
    }
    if (!still()) return;
    opened[opened.length - 1] = [...tabs].find(([, t]) => t.key === r.key && t.workspace === ws)?.[0] ?? null;
  }
  const composed = composeLayout(layout, (i) => opened[i]);
  if (!opened.some((id) => id !== null)) return;
  // This window's own terminals of the workspace (kept from when it showed it before) join the focused group,
  // as a handed one no group lists does: in a split, every terminal is in a group.
  if (composed.split) {
    const placed = new Set(composed.split.groups.flatMap((group) => group.tabs));
    const into = composed.split.groups.find((group) => group.id === composed.split.focusedGroup);
    for (const [id, t] of tabs) if (t.kind === "terminal" && t.workspace === ws && !placed.has(id)) into.tabs.push(id);
  }
  split = composed.split;
  setSidebarMode("instances");
  setNavActive(null);
  if (composed.activeTab == null) { activateTab(null, { keepGroupFocus: true }); updateContextTabs(); return; }
  selectTab(composed.activeTab, { intent: owns, focusContent: true });
  updateContextTabs();
}
function restoreWorkspaceTabs() {
  contextRosterGen++;
  brainIntents.invalidate();
  tabOpenIntents.invalidate();
  workspaceLabel.reset(currentWorkspace());
  // Where the keyboard was in the workspace left (focus-place.mjs), taken before its tabs are hidden.
  workspaceTabMemory.remember(tabWorkspace, { split, activeTab, sidebarMode, tabLayerVisible, place: focusPlaces.take(tabWorkspace) });
  // Hide synchronously and park ALL nodes before replacing group identities.
  // Workspace-local group ids can overlap; deleting old cells first would
  // otherwise orphan their retained tabs/panes (and live terminals).
  showTabLayer(false);
  renderSplit(false);
  tabWorkspace = currentWorkspace();
  const restored = workspaceTabMemory.recall(tabWorkspace, tabs);
  split = restored.split;
  contextInstances = [];
  contextWorkspace = tabWorkspace;
  // A new subject: forget the data, the stale mark and the painted signature.
  // The list clears into pending (a skeleton pill for the count); the rows of
  // the new workspace arrive with the refresh below, never "No instances".
  rosterState?.reset();
  rosterStale = false; rosterSignaturePainted = null; contextDeploymentNote = null; contextDeployments = [];
  renderContextRoster([]);
  if (restored.tabLayerVisible) {
    setSidebarMode(restored.sidebarMode);
    activateTab(restored.activeTab, { keepGroupFocus: true });
  } else {
    setSidebarMode(stageSidebarMode(stage?.name));
    setNavActive(stage?.name || "spawn");
  }
  updateContextTabs();
  focusArrival(restored.place ?? null);
  refreshContextRoster();
}
/** Workspace views (#482): per-workspace state saved under a deployment id — a selection from before
 * views, an unattached deployment that has matched a workspace since — or under a view id the server
 * no longer serves moves to the view that holds that deployment now, and an open terminal follows its
 * instance's deployment (a remote that reports another workspace). Open tabs (workspace and key), the
 * active-terminal and layout memories, collapsed rows and spawn jobs move together; nothing is
 * dropped (workspace-rehome.mjs). Runs for every served list a roster read brings. */
function rehomeWorkspaceState(workspaces) {
  if (!Array.isArray(workspaces) || !workspaces.length) return;
  const map = rehomeMap(workspaces, viewMembership);
  viewMembership.note(workspaces);
  const moves = rehomeTabs(tabs, map, workspaces);
  if (!map.size && !moves.length) return;
  rehomeActiveTerminals(wsActiveTerminal, map, moves);
  instanceRecency.rehome(map);
  workspaceTabMemory.rehome(map);
  focusPlaces.rehome(map);
  rehomeCollapsed(collapsedInstances, map);
  // #1579: an open Background section follows its view, as its collapsed rows do.
  const openMoved = [...backgroundOpen].filter((id) => map.has(id));
  for (const id of openMoved) backgroundOpen.delete(id);
  for (const id of openMoved) backgroundOpen.add(map.get(id));
  spawnJobs.rehome(map);
  if (map.has(tabWorkspace)) tabWorkspace = map.get(tabWorkspace);
  if (map.has(contextWorkspace)) contextWorkspace = map.get(contextWorkspace);
  if (!moves.length) return;
  // A terminal whose deployment moved to another view leaves this window's layout (it opens there).
  const shown = currentWorkspace(), leaving = moves.filter((m) => m.from === shown && m.to !== shown);
  for (const { id } of leaving) split = removeSplitTab(split, id).split;
  updateContextTabs();
  if (!leaving.length || !tabLayerVisible) return;
  if (leaving.some((m) => m.id === activeTab)) showTerminalContext();
  else if (activeTab != null) activateTab(activeTab, { keepGroupFocus: true });
}
// One background read at a time: a slow or unanswered read is not superseded every 4 s, so its outcome
// is always someone's to show; the bounded wait has its own timer (rosterPendingWatch). A switch or a
// Retry reads at once, as before. A new connection replaces the poll's read at once: the old read's
// outcome is revoked (contextRosterGen) and the new subject's deadline is armed at its dispatch, so
// neither waits for the old read to settle; only the newest poll clears the slot.
// An unfocused window polls at the server's blurred cadence (roster-cadence.mjs, #481); focus reads at once.
let rosterPoll = null, rosterPolledAt = 0;
function pollContextRoster() {
  rosterPolledAt = Date.now();
  const poll = rosterPoll = refreshContextRoster().finally(() => { if (rosterPoll === poll) rosterPoll = null; });
}
setInterval(() => {
  if (!rosterPoll && rosterPollDue({ focused: document.hasFocus(), last: rosterPolledAt, now: Date.now() })) pollContextRoster();
}, ROSTER_POLL_FOCUSED_MS);
window.addEventListener("focus", () => { if (!rosterPoll) pollContextRoster(); });
subscribeConnections(() => { if (contextRosterEl) pollContextRoster(); });

// Contract re-probe triggers: launch (initial refresh) and app focus. The
// cli-status module owns the shared state; the Spawn view (and any future
// mutation surface) subscribes for consistent enable/disable.
import("./views/cli-status.mjs").then(({ refreshCli, reprobeCli }) => {
  refreshCli(ctx);
  desk.onAppFocus?.(() => reprobeCli(ctx));
});

// Home surface: the Workspace page (Workspace overview), on Souls, when no instance is open (the product owner, 2026-10-23).
showStage("spawn");
