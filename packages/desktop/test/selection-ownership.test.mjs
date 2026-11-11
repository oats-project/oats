// Shipped-shell boundary: real DOM chrome, split projection, selection/open/
// close/workspace functions and terminal lifecycle. Only IPC, xterm and module
// loading are synthetic. No Electron, processes, sockets or operator sessions.
import test from "node:test";
import { createLaunchFocus } from "../renderer/launch-focus.mjs";
import { createInstanceRecency, recencyIdFromTerminalKey } from "../renderer/instance-recency.mjs";
import { viewContext } from "./helpers/view-context.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { createSelectionOwnership, wirePaneSelection } from "../renderer/selection-ownership.mjs";
import { createIntentGate, prepareOwnedOpen } from "../renderer/open-intent.mjs";
import { createTerminalTab, terminalOptions, fitTerminal, createGlyphRenderer, terminalKeyDecision, RECONNECT_DELAYS_MS, RECONNECT_RETRIED, NO_ANSWER_RETRIES, LOST_LINK_EXIT } from "../renderer/terminal-tab.mjs";
import { createTermLifecycle } from "../renderer/term-lifecycle.mjs";
import { opened, confirmed, ready } from './helpers/terminal-wire.mjs';
import { terminalHandle, terminalSameHandle, terminalFailure, terminalMessage } from '../../client/terminal-contract.mjs';
import { wireTerminalAttachments } from '../renderer/terminal-attachments.mjs';
import { createSyncGate } from '../renderer/terminal-sync.mjs';
import { createViewLifecycle } from "../renderer/view-lifecycle.mjs";
import { reserveKey, whenKeyFree } from "../renderer/tab-keys.mjs";
import { createTabChrome, tabKeyAction, focusAfterLastTab, tabNameTailStart, setTabTitle } from "../renderer/tab-a11y.mjs";
import { numberTabStrips } from "../renderer/tab-numbers.mjs";
import * as keymap from "../renderer/keybindings.mjs";
import { createWorkspaceTabMemory } from "../renderer/workspace-tab-memory.mjs";
import * as workspaceTabs from "../renderer/workspace-tabs.mjs";
import * as layout from "../renderer/split-layout.mjs";
import { splitControlsState } from "../renderer/split-controls.mjs";
import { projectSplitDom } from "../renderer/split-dom.mjs";
import * as instanceTreeShared from "../../client/instance-tree.mjs";
import * as instanceTreeView from "../renderer/instance-tree-view.mjs";
const instanceTree = { ...instanceTreeShared, ...instanceTreeView };
import { instanceActions, captureInstanceActionMenu } from "../renderer/instance-actions.mjs";
import { instanceActionTarget, sameInstanceActionTarget } from '../renderer/instance-action-target.mjs';
import { instanceSplitPlan, instanceSplitIdentity } from '../renderer/instance-split.mjs';
import { runtimeState, unsupportedSession } from "../../client/instance-presentation.mjs";
import { canAddressRemote, rowReason } from "../../client/remote-address.mjs";
import { createRuntimeBadge } from "../renderer/identity-marks.mjs";
import { rosterKeyAction, moveTarget } from "../renderer/roster-keys.mjs";
import { revealInStrip, revealInScrollport } from "../renderer/reveal-in-scrollport.mjs";
import { createLeader } from "../renderer/leader.mjs";
import { createLeaderDispatch } from "../renderer/leader-dispatch.mjs";
import { leaderApplies, leaderLabel } from "../renderer/leader-keys.mjs";
import { createLeaderHint, LEADER_ANNOUNCEMENT } from "../renderer/leader-hint.mjs";
import { LEADER_TABLE } from "../../client/keymap.mjs";
import { navTab } from "../renderer/shell-nav.mjs";

const source = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
const names = [
  "setSidebarMode", "updateContextTabs", "showTabLayer", "renderSplit", "selectEmptyGroup", "showStage",
  "splitPane", "closeSplit", "onTabKeydown", "addTab", "selectTab", "activateTab", "revealActiveRosterRow", "closeTab", "tabStrips", "revealActiveTabs", "observeTabStrips",
  "openViewTab", "openTerminalTabFlow", "openTerminalTabInner", "focusActiveTerminal",
  "visibleTabEntries", "walkedTabs", "switchTab", "cycleTab", "gotoTab", "restoreWorkspaceTabs", "showTerminalContext",
  "initContextRoster", "renderContextRoster", "rosterEntry", "focusRoster", "onRosterRowKey", "setRovingRow", "showInRoster", "syncTabNeedsInput",
];
// The leader's part of the shell (shell.mjs "the leader"): what a key after it, or a chord that does
// one's work, acts on, and the shipped dispatch and engine that run it.
const leaderNames = ["leaderTargetId", "leaderOrigin", "openingInstanceId", "runAsLeaderKey", "notApplicable", "leaderState"];
const leaderSetup = [/let terminalOpening = [^\n]+/, /const rosterInstance = [^\n]+/,
  /const leaderDispatch = createLeaderDispatch\(\{[^]*?\n\}\);/, /const leader = createLeader\(\{[^]*?\n\}\);/,
  /registerAction\(\{ id: "app\.leader"[^\n]*\n[^\n]*/, /for \(const \[id, does\] of \[\["roster\.openPrevious"[^]*?\n\}/];
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const flush = () => new Promise(setImmediate);

function shell(t, { shellSource = source, ownership = createSelectionOwnership, terminal = createTerminalTab, leader = false } = {}) {
  const dom = new JSDOM(`<span id="ws-context"></span><div id="stagehost"></div><div id="tabstrip"><div id="tabbar-row"><div id="tabbar"></div><div id="tab-actions"></div></div></div><div id="tabhost"></div><aside id="sidebar"><div class="side-head"><span id="ws-heading" class="ws-heading">Workspace</span><button id="ws-add-open" class="ws-add-open side-icon-button" type="button">+</button></div><section id="ws-list"><div id="ws-options"></div></section><nav id="nav"><button class="nav-item active">Workspace overview</button></nav><section id="instance-roster"><div class="ctx-head"><span>Instances</span><span class="ctx-count"></span></div><div class="ctx-list"></div></section><div id="nav-foot"><div id="sidebar-bar" role="group" aria-label="Sidebar tools"><span class="sidebar-brand" aria-hidden="true"></span><button id="sidebar-toggle" class="side-icon-button" type="button" data-action="sidebar.toggle">Hide the sidebar</button><button id="sidebar-spawn" type="button" data-action="app.quickOpenSouls" aria-label="Spawn instance">Spawn instance</button><button id="sidebar-settings" class="side-icon-button sidebar-settings" type="button" aria-label="Settings"></button></div></div></aside>`);
  t.after(() => dom.window.close());
  const document = dom.window.document;
  // The shell's one window keydown listener (shell.mjs), on this harness's platform.
  document.addEventListener("keydown", e => keymap.handleKeydown(e, { isMac: true }));
  keymap.setActiveContexts(new Set(["tabs"])); t.after(() => keymap.setActiveContexts(new Set()));
  const requests = [], loads = [], attachments = [], terms = [], detached = [], actions = new Map();
  const c = {
    document, console, navigator: { platform: "MacIntel" },
    workspace: "A", generation: 0, tabWorkspace: "A", contextWorkspace: "A", connectionGeneration: 0,
    instanceActionTarget, sameInstanceActionTarget, instanceSplitPlan, instanceSplitIdentity,
    modal: false, modalOpen: () => c.modal,
    menuState() {}, sayInHint() {}, getBinding: () => null, formatChord: c => c, isMac: true, applyChordTitles() {}, runAction: id => actions.get(id)?.(),
    tabs: new Map(), nextTabId: 1, activeTab: null, split: null, sidebarMode: "instances", tabLayerVisible: false,
    contextRosterGen: 0, contextInstances: [], collapsedInstances: new Set(), focusRegions: { focusRegion: () => false, regionOfFocus: () => null },
    rosterState: null, rosterStale: false, contextDeploymentNote: null, ...viewContext(), rosterSignaturePainted: null, // initContextRoster builds the real controller; tests mark it ready before rendering rows
    rosterTip: { bind() {}, hide() {}, sync() {} }, rosterTipFacts: () => ({}), rosterPrs: { get: () => null, refresh() {} }, spawnJobs: { rows: () => [], announce: () => false, observe() {}, settling: () => false, check() {} },
    // The palette's last-focus record (Spec C), inert here: the shell code under test writes to it.
    instanceRecency: createInstanceRecency({ storage: null }), recencyIdFromTerminalKey,
    wsActiveTerminal: new Map(), pendingTerms: new Set(),
    tabbar: document.getElementById("tabbar"), tabhost: document.getElementById("tabhost"),
    tabActionsEl: document.getElementById("tab-actions"),
    stageHost: document.getElementById("stagehost"), stage: { name: "automations" },
    navEl: document.getElementById("nav"), contextRosterEl: null,
    brainIntents: createIntentGate(), workspaceTabMemory: createWorkspaceTabMemory(),
    workspaceLabel: { reset() {} }, stageSidebarMode: () => "overview", NAV: [{ name: "automations" }] /* a page of its own; hierarchy is a tab of the Workspace page (2026-10-26) */, navTab /* the shipped NAV_TABS lookup: showStage reads it first */,
    currentWorkspace: () => c.workspace, workspaceGeneration: () => c.generation,
    updateActiveContexts: (on = c.tabLayerVisible) => { c.tabLayerVisible = on; },
    // Panel behavior is covered with the real presenter in split-empty-shell.
    syncContextPanel() {}, contextPanel: { setFocusMode() {} },
    updateSplitControls() {}, revealInStrip, revealInScrollport, tabStripResize: null /* spec F: the shipped active-tab reveal runs too */, numberTabStrips, tabNumberObserver: null, refreshContextRoster() {}, setNavActive() {}, setSidebarHidden() {},
    ...instanceTree, instanceActions, captureInstanceActionMenu, runtimeState, unsupportedSession, canAddressRemote, rowReason, createRuntimeBadge, rosterKeyAction, moveTarget,
    api: () => { const gate = deferred(); requests.push(gate); return gate.promise; },
    prepareOwnedOpen: opts => prepareOwnedOpen({ ...opts, load() {
      const gate = deferred(); loads.push(gate); return gate.promise;
    } }),
    // Keep identity resolution out of this test; keys/targets remain distinct.
    resolveTerminalOpen: (instances, ref, ws) => ({ inst: { instance: ref, running: true, tmux: { session: "synthetic", window: ref } }, key: `${ws}:${ref}` }),
    ctx: {}, reserveKey, whenKeyFree, createViewLifecycle, createTabChrome, tabKeyAction, focusAfterLastTab, tabNameTailStart, setTabTitle,
    createLaunchFocus, createSelectionOwnership: ownership, wirePaneSelection, terminalOptions, wireTerminalSelection: () => () => {}, fitTerminal, createGlyphRenderer,
    ...workspaceTabs, ...layout, projectSplitDom, splitControlsState,
    // tabs.close also goes into the real keymap: the strip's close chord is the keymap's, not tab-a11y's.
    registerAction: action => { actions.set(action.id, action.run); if (action.id === "tabs.close") t.after(keymap.registerAction(action)); },
    terminalTypography: () => ({ fontSize: 13, fontFamily: "mono" }), xtermTheme: () => ({}), terminalFontWeight: () => 400,
    onThemeChange: () => () => {}, onTerminalTypographyChange: () => () => {},
    requestAnimationFrame: fn => fn(),
    FitAddon: { FitAddon: class { fit() {} } },
    createTerminalTab: opts => terminal({ ...opts, observe: () => () => {} }),
    Terminal: class {
      parser = { registerOscHandler: () => ({ dispose() {} }) };
      constructor() { this.cols = 80; this.rows = 24; this.focuses = 0; this.disposed = 0; terms.push(this); }
      loadAddon() {}
      // xterm's own element holds its input, as the leader's target reads it (leaderTargetId).
      open(wrap) { const xterm = document.createElement("div"); xterm.className = "xterm"; this.input = document.createElement("textarea"); xterm.append(this.input); wrap.append(xterm); }
      onData() {} onResize() {} attachCustomKeyEventHandler() {} write() {}
      focus() { this.focuses++; this.input.focus(); }
      dispose() { this.disposed++; }
    },
    desk: {
      termOpen(spec) { const gate = { ...deferred(), spec }; attachments.push(gate); return gate.promise.then(({ id }) => opened(id)); },
      termReady: ready,
      termClose: h => { detached.push(h.id); return confirmed(h); }, termWrite() {}, termResize() {},
      onTermData: () => () => {}, onTermExit: () => () => {},
    },
  };
  c.splitOpenState = () => ({ split: c.split, activeId: c.activeTab, tabs: c.tabs, workspace: c.workspace, visible: c.tabLayerVisible });
  c.ownsInstanceTarget = target => target?.workspace === c.workspace && c.contextInstances.filter(row => sameInstanceActionTarget(target, row, c.workspace)).length === 1;
  if (leader) Object.assign(c, {
    window: dom.window, createLeader, createLeaderDispatch, LEADER_TABLE, leaderApplies, leaderLabel, actionLabel: () => null, rosterActsHeld: () => null,
    said: [], sayInHint: line => { c.said.push(line); c.leaderHint.say(line); }, leaderHint: createLeaderHint({ doc: document, host: document.body }),
    // A roster row's click opens its terminal (renderContextRoster); the opens are recorded, then run as shipped.
    opened: [], failed: [], openTerminalTab: ref => {
      c.opened.push(ref.instance);
      const flow = c.openTerminalTabFlow(ref, message => assert.fail(message));
      flow.catch(e => c.failed.push(e.message));
      return flow;
    },
    resolveTerminalOpen: (instances, ref, ws) => ({ inst: { ...ref, tmux: { session: "synthetic", window: ref.instance } }, key: `${ws}:${ref.instance}` }),
    // The leader's ↑/↓ move between workspaces (the list's step, recorded); its X opens the Stop dialog (recorded).
    steppedWorkspaces: [], steppedHow: [], workspaceLabel: { step: (delta, how) => { c.steppedWorkspaces.push(delta); c.steppedHow.push({ ...how }); return true; } },
    acts: [], openLifecycleDialog: (verb, instance) => c.acts.push([verb, instance.instance]), openInstanceStart: () => assert.fail("no start here"),
  });
  const functions = [...names, ...(leader ? leaderNames : [])].map(name => {
    const match = shellSource.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
    assert.ok(match, `exercise shipped ${name}`); return match[0];
  });
  // The shipped modal guard for tab switching (unlessModal), over a modal flag the test sets.
  const setup = [/const tabOpenIntents = [^\n]+/, /const unlessModal = [^\n]+/, /for \(let n = 1; n <= 9; n\+\+\) \{\n[^\n]+\n\}/, ...(leader ? leaderSetup : [])].map(re => {
    const match = shellSource.match(re);
    assert.ok(match, `exercise shipped ${re}`); return match[0];
  }).join("\n");
  const registry = shellSource.split("\n").filter(line => /^registerAction\(/.test(line)
    && /id: "(?:tabs\.|split\.close|terminal\.focusActive)/.test(line));
  const s = runInNewContext(`${setup}\n${functions.join("\n")}\n${registry.join("\n")}\n({ ${names.join(", ")}, tabOpenIntents${leader ? `, ${leaderNames.join(", ")}, leader` : ""} });`, c);
  if (leader) { c.openTerminalTabFlow = s.openTerminalTabFlow; t.after(() => s.leader.dispose()); }
  s.initContextRoster();
  // refreshContextRoster is stubbed here: the roster's loading state reads as observed, so rows paint.
  c.rosterState.succeed();
  const dispatch = (el, type, options = {}) => el.dispatchEvent(type === "keydown"
    ? new dom.window.KeyboardEvent(type, { bubbles: true, cancelable: true, ...options })
    : new dom.window.Event(type, { bubbles: true }));
  return {
    ...s, c, document, requests, loads, attachments, terms, detached, actions, dispatch,
    seed(name) { return s.addTab({ title: name, key: `${c.workspace}:${name}`, kind: "terminal" }).id; },
    async pending(ref) {
      const result = s.openTerminalTabFlow(ref, message => assert.fail(message));
      requests.at(-1).resolve({ instances: [] }); await flush();
      assert.equal(attachments.length, terms.length);
      return { result, gate: attachments.at(-1), term: terms.at(-1), id: c.activeTab };
    },
    switchTo(workspace, restore = true) {
      c.workspace = workspace; c.generation++;
      if (restore) s.restoreWorkspaceTabs();
    },
  };
}

const actions = {
  cycle: s => s.actions.get("tabs.next")(),
  pointer: s => s.dispatch(s.c.tabs.get(1).paneEl, "pointerdown"),
  focus: s => s.dispatch(s.c.tabs.get(1).paneEl, "focusin"),
  "active-pointer": s => s.dispatch(s.c.tabs.get(2).paneEl, "pointerdown"),
  "active-focus": s => s.dispatch(s.c.tabs.get(2).paneEl, "focusin"),
  "strip-click": s => s.c.tabs.get(1).triggerEl.click(),
  "strip-arrow": s => s.dispatch(s.c.tabs.get(2).triggerEl, "keydown", { key: "ArrowLeft" }),
  "close-button": s => s.c.tabs.get(2).closeEl.click(),
  "inactive-close-button": s => s.c.tabs.get(1).closeEl.click(),
  "close-delete": s => s.dispatch(s.c.tabs.get(2).triggerEl, "keydown", { key: "Delete" }),
  "close-chord": s => s.dispatch(s.c.tabs.get(2).triggerEl, "keydown", { key: "w", metaKey: true }),
  "close-command": s => s.actions.get("tabs.close")(),
  "close-direct": s => s.closeTab(2),
  "close-split": s => s.actions.get("split.close")(),
};

async function olderOpen(t, kind, outcome, action, options) {
  const s = shell(t, options);
  s.seed("one"); s.splitPane("row"); s.seed("two");
  const old = kind === "terminal" ? s.openTerminalTabFlow("one", () => assert.fail("stale refusal"))
    : s.openViewTab("markdown", "old artifact", {}, "file:old");
  await flush();
  const request = (kind === "terminal" ? s.requests : s.loads).at(-1);
  assert.ok(request, "open is pending at its shipped async boundary");
  actions[action](s);
  const selected = s.c.activeTab, ids = [...s.c.tabs.keys()], focused = s.document.activeElement;
  if (outcome === "resolve") request.resolve(kind === "terminal" ? { instances: [] } : { mount() {} });
  else request.reject(new Error("older selection failed"));
  await old;
  assert.equal(s.c.activeTab, selected, "older open must not replace explicit selection");
  assert.deepEqual([...s.c.tabs.keys()], ids, "stale artifact success/error must not create a tab");
  assert.equal(s.document.activeElement, focused, "no late focus steal");
  assert.equal(s.attachments.length, 0, "selection never reacquires a retained terminal");
}

for (const kind of ["terminal", "artifact"]) for (const outcome of ["resolve", "reject"]) {
  for (const action of Object.keys(actions)) {
    test(`${action} supersedes older ${kind} ${outcome}`, t => olderOpen(t, kind, outcome, action));
  }
}

for (const action of ["cycle", "pointer", "focus", "active-pointer", "active-focus", "close-split", "close-button", "inactive-close-button"]) {
  test(`delayed attachment after ${action}: retain lifetime, never steal focus`, async t => {
    const s = shell(t);
    s.seed("one"); s.splitPane("row");
    const pending = await s.pending("two");
    assert.equal(pending.id, 2);
    actions[action](s);
    const focus = s.document.activeElement;
    pending.gate.resolve({ id: 71 }); await pending.result;
    assert.equal(pending.term.focuses, 0, "visibility (including a split) is insufficient focus authority");
    assert.equal(s.document.activeElement, focus);
    assert.equal(s.attachments.length, 1);
    const closed = action === "close-button";
    assert.equal(pending.term.disposed, closed ? 1 : 0);
    assert.deepEqual(s.detached, closed ? [71] : [], "only explicit close detaches");
  });
}

for (const outcome of ["resolve", "reject"]) for (const visits of [["B"], ["B", "A"]]) {
  test(`pending attachment ${outcome} across ${["A", ...visits].join("→")} cannot focus, detach or reacquire`, async t => {
    const s = shell(t), pending = await s.pending("one");
    const entry = s.document.getElementById("ws-add-open"); entry.focus();
    for (const workspace of visits) s.switchTo(workspace);
    if (outcome === "resolve") pending.gate.resolve({ id: 72 });
    else pending.gate.reject(new Error("attachment unavailable"));
    await pending.result;
    assert.equal(pending.term.focuses, 0);
    assert.equal(s.document.activeElement, entry);
    assert.equal(s.attachments.length, 1); assert.deepEqual(s.detached, []);
    assert.equal(pending.term.disposed, 0, "retained error/success still belongs to its tab");
    assert.equal(s.c.tabs.get(pending.id).paneEl.hidden, visits.at(-1) !== "A");
  });
}

test("fresh open and later direct focus work; pending focus uses the NEW explicit owner", async t => {
  const s = shell(t), first = await s.pending("one");
  assert.equal(first.term.focuses, 0, "no input focus before attachment readiness");
  first.gate.resolve({ id: 73 }); await first.result;
  assert.equal(first.term.focuses, 1, "normal direct open focuses exactly once (including native focusin)");
  s.document.getElementById("ws-add-open").focus();
  s.actions.get("terminal.focusActive")();
  assert.equal(first.term.focuses, 2);
  const second = await s.pending("two");
  s.switchTo("B"); s.switchTo("A");
  // Later explicit jump to an already-open pending terminal must not be tied
  // to its original open ticket, and must not start another acquisition.
  const reopened = s.openTerminalTabFlow("two", () => assert.fail("refusal"));
  s.requests.at(-1).resolve({ instances: [] }); await reopened;
  assert.equal(second.term.focuses, 0);
  second.gate.resolve({ id: 74 }); await second.result;
  assert.equal(second.term.focuses, 1);
  assert.equal(s.document.activeElement, second.term.input);
  assert.equal(s.attachments.length, 2); assert.deepEqual(s.detached, []);
});

test("focusActive on a pending tab schedules readiness focus without an extra attach", async t => {
  const s = shell(t), pending = await s.pending("one");
  s.c.tabs.get(pending.id).triggerEl.click(); // selection but no input focus
  s.actions.get("terminal.focusActive")();
  pending.gate.resolve({ id: 75 }); await pending.result;
  assert.equal(pending.term.focuses, 1); assert.equal(s.attachments.length, 1);
});

test("strip focus, side-effect projection and workspace restoration do not focus retained ready inputs", async t => {
  const s = shell(t), pending = await s.pending("one");
  pending.gate.resolve({ id: 76 }); await pending.result;
  const entry = s.document.getElementById("ws-add-open"); entry.focus();
  s.activateTab(pending.id); s.switchTo("B"); s.switchTo("A");
  s.c.tabs.get(pending.id).triggerEl.click();
  assert.equal(pending.term.focuses, 1); assert.equal(s.document.activeElement, entry);
  assert.equal(s.attachments.length, 1); assert.deepEqual(s.detached, []);
});

for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) for (const mod of ["ctrlKey", "altKey", "metaKey", "shiftKey"]) {
  test(`shipped strip leaves ${mod}+${key} unconsumed and does not supersede a pending open`, async t => {
    const s = shell(t); s.seed("one"); s.seed("two");
    const old = s.openTerminalTabFlow("one", () => assert.fail("refusal"));
    assert.equal(s.dispatch(s.c.tabs.get(2).triggerEl, "keydown", { key, [mod]: true }), true);
    s.requests.at(-1).resolve({ instances: [] }); await old;
    assert.equal(s.c.activeTab, 1, "modifier chord did not issue a local selection");
  });
}

// Mutation checks run only in memory. Never modify shared worktree source.
function mutatedFactory(fn, from, to, deps = {}) {
  assert.ok(fn.toString().includes(from), "mutation still targets the essential guard");
  return runInNewContext(`(${fn.toString().replace(from, to)})`, deps);
}

for (const outcome of ["resolve", "reject"]) {
  test(`mutation: selection serial guard is essential on older ${outcome}`, async t => {
    const ownership = mutatedFactory(createSelectionOwnership, "token === serial &&", "");
    await assert.rejects(olderOpen(t, "artifact", outcome, "cycle", { ownership }), /older open must not replace explicit selection/);
  });
  test(`mutation: cycle must use explicit selection on older ${outcome}`, async t => {
    // cycleTab → switchTab: the switch must be an explicit selection, not a projection.
    const shellSource = source.replace("  if (!selectTab(id, { focusContent: inContent })) return;", "  if (!activateTab(id)) return;");
    assert.notEqual(shellSource, source);
    await assert.rejects(olderOpen(t, "artifact", outcome, "cycle", { shellSource }), /older open must not replace explicit selection/);
  });
}

async function generationRace(t, outcome, ownership = createSelectionOwnership) {
  const s = shell(t, { ownership }); s.seed("one"); s.seed("two");
  const old = s.openTerminalTabFlow("one", () => assert.fail("refusal"));
  // Bypass the shell listener to isolate global generation from its separate
  // invalidation. This matches a completion racing workspace notification.
  s.switchTo("B", false); s.switchTo("A", false);
  if (outcome === "resolve") s.requests.at(-1).resolve({ instances: [] });
  else s.requests.at(-1).reject(new Error("old workspace failure"));
  await old;
  assert.equal(s.c.activeTab, 2, "global workspace generation must reject the old visit");
}
for (const outcome of ["resolve", "reject"]) {
  test(`workspace generation alone rejects older ${outcome}`, t => generationRace(t, outcome));
  test(`mutation: workspace generation is essential for older ${outcome}`, async t => {
    const ownership = mutatedFactory(createSelectionOwnership, "&& generation === workspaceGeneration()", "");
    await assert.rejects(generationRace(t, outcome, ownership), /global workspace generation|old workspace failure/);
  });
}

test("mutation: readiness must consult current focus ownership, not pane visibility", async t => {
  async function run(terminal = createTerminalTab) {
    const s = shell(t, { terminal }); s.seed("one"); s.splitPane("row");
    const pending = await s.pending("two");
    s.c.tabs.get(2).triggerEl.click(); // still active and visible, but strip owns focus
    pending.gate.resolve({ id: 77 }); await pending.result;
    assert.equal(pending.term.focuses, 0, "readiness must not steal focus");
  }
  await run();
  const terminal = mutatedFactory(createTerminalTab, "!ownsFocus()", "!isActive()", { createTermLifecycle, terminalKeyDecision, terminalHandle, terminalSameHandle, terminalFailure,
    terminalMessage, wireTerminalAttachments, createSyncGate, RECONNECT_DELAYS_MS, RECONNECT_RETRIED, NO_ANSWER_RETRIES, LOST_LINK_EXIT });
  await assert.rejects(run(terminal), /readiness must not steal focus/);
});

test("closing a newer tab restores a pending retained terminal without reviving its focus intent", async t => {
  const s = shell(t), pending = await s.pending("one");
  s.seed("two"); s.closeTab(2, true);
  assert.equal(s.c.activeTab, 1);
  const focused = s.document.activeElement;
  pending.gate.resolve({ id: 78 }); await pending.result;
  assert.equal(pending.term.focuses, 0); assert.equal(s.document.activeElement, focused);
  assert.equal(s.attachments.length, 1); assert.deepEqual(s.detached, []);
});

test("direct jump that rehomes a focused retained pane keeps its selection ticket", async t => {
  const s = shell(t), pending = await s.pending("one");
  pending.gate.resolve({ id: 79 }); await pending.result;
  s.splitPane("row");
  const open = s.openTerminalTabFlow("one", () => assert.fail("refusal"));
  s.requests.at(-1).resolve({ instances: [] }); await open;
  assert.equal(s.c.activeTab, 1);
  assert.equal(s.tabOpenIntents.ownsFocus(1), true, "projection's focus restoration is not a new intent");
  assert.equal(s.document.activeElement, pending.term.input);
  assert.equal(pending.term.focuses, 2);
  assert.equal(s.attachments.length, 1); assert.deepEqual(s.detached, []);
});

test("mutation: the shell must bind readiness to its current tab focus ticket", async t => {
  async function run(shellSource = source) {
    const s = shell(t, { shellSource }), pending = await s.pending("one");
    s.switchTo("B"); s.switchTo("A");
    pending.gate.resolve({ id: 80 }); await pending.result;
    assert.equal(pending.term.focuses, 0, "restoring active tab must not revive old focus");
  }
  await run();
  const shellSource = source.replace("&& tabOpenIntents.ownsFocus(made.id)", "");
  assert.notEqual(shellSource, source);
  await assert.rejects(run(shellSource), /restoring active tab must not revive old focus/);
});

for (const outcome of ["resolve", "reject"]) {
  for (const [action, from, to] of [
    ["pointer", "select: () => selectTab(id)", "select: () => activateTab(id)"],
    ["close-direct", "if (explicit) tabOpenIntents.invalidate();", "/* mutation: close does not supersede */"],
  ]) test(`mutation: ${action} ownership boundary is essential on older ${outcome}`, async t => {
    const shellSource = source.replace(from, to); assert.notEqual(shellSource, source);
    await assert.rejects(olderOpen(t, "artifact", outcome, action, { shellSource }), /older open must not replace explicit selection/);
  });

  for (const action of ["pointerdown", "focusin", "close-last"]) {
    test(`flat ${action} supersedes an older artifact ${outcome}`, async t => {
      const s = shell(t); s.seed("one");
      const old = s.openViewTab("markdown", "old artifact", {}, "file:old"); await flush();
      if (action === "close-last") s.c.tabs.get(1).closeEl.click();
      else s.dispatch(s.c.tabs.get(1).paneEl, action);
      const focused = s.document.activeElement;
      if (outcome === "resolve") s.loads.at(-1).resolve({ mount() {} });
      else s.loads.at(-1).reject(new Error("older artifact failure"));
      await old;
      assert.equal(s.c.tabs.size, action === "close-last" ? 0 : 1);
      assert.equal(s.document.activeElement, focused);
      if (action === "close-last") {
        assert.equal(s.c.tabLayerVisible, false);
        // The roster's entry (rosterEntry): with no rows, its one action, the foot's Spawn instance (2026-10-26).
        assert.equal(focused, s.document.getElementById("sidebar-spawn"));
      }
    });
  }
}

const roster = ["one", "two"].map(instance => ({ instance, running: true, agentsRoot: "/team/agents", home: `/team/${instance}` }));
// A sidebar control other than the roster's rows: the workspace list's Add local workspace… (the roster had a
// filter field until the product owner removed it).
function sidebarIntent(s, kind) {
  const add = s.document.getElementById("ws-add-open");
  if (kind === "pointer-add") {
    // A pointerdown is still an intent when the control was already focused
    // before the open began and the browser emits no new focusin.
    s.dispatch(add, "pointerdown"); add.focus();
  } else if (kind === "keyboard-add") {
    // JSDOM does not implement Tab's default focus traversal. Use native DOM
    // focus (which emits focusin), not a synthetic focusin or focusRoster().
    add.focus();
  } else if (kind === "keyboard-roster") {
    s.dispatch(s.document.activeElement, "keydown", { key: "ArrowDown" });
  } else if (kind === "pointer-sidebar") {
    s.dispatch(s.c.navEl.querySelector("button"), "pointerdown");
    s.c.navEl.querySelector("button").focus();
  } else s.focusRoster();
}
function prepareSidebar(s, kind) {
  s.c.contextInstances = roster; s.renderContextRoster(roster);
  if (kind === "keyboard-roster") s.c.contextRosterEl.querySelector(".ctx-inst").focus();
  else if (kind === "pointer-add") s.document.getElementById("ws-add-open").focus();
  // sidebar.focusFilter's run, already on the roster's row: the command is still an intent.
  else if (kind === "command-roster") s.focusRoster();
}

async function sidebarAttachment(t, kind, outcome, shellSource = source) {
  const s = shell(t, { shellSource }); prepareSidebar(s, kind);
  const pending = await s.pending("pending");
  sidebarIntent(s, kind);
  const focused = s.document.activeElement;
  assert.ok(s.document.getElementById("sidebar").contains(focused));
  if (kind === "keyboard-roster") assert.equal(focused.dataset.treeInstance, roster[1].home);
  if (outcome === "resolve") pending.gate.resolve({ id: 81 });
  else pending.gate.reject(new Error("late attachment failure"));
  await pending.result;
  assert.equal(pending.term.focuses, 0, "sidebar owns input, not the attaching terminal");
  assert.equal(s.document.activeElement, focused);
  assert.equal(s.c.activeTab, pending.id, "focus cancellation does not dispose or hide the selected pane");
  assert.equal(pending.term.disposed, 0); assert.deepEqual(s.detached, []);
  assert.equal(s.attachments.length, 1);
}

for (const kind of ["pointer-add", "keyboard-add", "keyboard-roster", "pointer-sidebar", "command-roster"]) {
  for (const outcome of ["resolve", "reject"]) test(`sidebar ${kind} revokes delayed attachment focus on ${outcome} without closing it`, async t => {
    await sidebarAttachment(t, kind, outcome);
  });

  for (const outcome of ["resolve", "reject"]) test(`sidebar ${kind} supersedes an older pre-attachment open ${outcome}`, async t => {
    const s = shell(t); prepareSidebar(s, kind); s.seed("one");
    const pending = s.openTerminalTabFlow("two", () => assert.fail("stale refusal"));
    sidebarIntent(s, kind);
    const focused = s.document.activeElement;
    if (outcome === "resolve") s.requests.at(-1).resolve({ instances: [] });
    else s.requests.at(-1).reject(new Error("older request failure"));
    await pending;
    assert.equal(s.c.activeTab, 1); assert.equal(s.c.tabs.size, 1);
    assert.equal(s.attachments.length, 0); assert.equal(s.document.activeElement, focused);
  });
}

test("roster polling restores logical focus without superseding a terminal selection or readiness", async t => {
  const s = shell(t); prepareSidebar(s, "keyboard-roster");
  const pending = await s.pending("pending");
  const owner = s.tabOpenIntents.ownsFocus(pending.id);
  assert.equal(owner, true);
  s.renderContextRoster(roster); // real DOM replacement + focus restoration
  assert.equal(s.document.activeElement.dataset.treeInstance, roster[0].home);
  assert.equal(s.tabOpenIntents.ownsFocus(pending.id), true, "restored row focus is not new user intent");
  pending.gate.resolve({ id: 82 }); await pending.result;
  assert.equal(pending.term.focuses, 1);
  assert.equal(s.document.activeElement, pending.term.input);
  assert.equal(s.attachments.length, 1); assert.deepEqual(s.detached, []);
});

function ambiguousClusterGuides(t, ambiguity, shellSource = source) {
  const s = shell(t, { shellSource });
  const full = [
    { instance: "parent", home: "/a/parent", agentsRoot: "/a/agents", siblingInstance: "worker", running: true },
    { instance: "parent", home: "/b/parent", agentsRoot: ambiguity === "same-root" ? "/a/agents" : "/b/agents", running: true },
    { instance: "worker", home: "/c/worker", agentsRoot: ambiguity === "same-root" ? "/a/agents" : "/c/agents", parentInstance: "parent", running: true },
    { instance: "child", home: "/c/child", agentsRoot: "/c/agents", parentInstance: "worker", running: true },
  ];
  assert.equal(instanceTree.visibleClusters(full, full).length, 2, "duplicate parent is outside the worker's cluster");
  s.renderContextRoster(full);
  const rows = [...s.document.querySelectorAll(".ctx-tree-row")];
  assert.equal(rows.length, full.length, "ambiguity must not hide a row");
  const row = name => rows.find(r => r.querySelector(".ctx-name").dataset.name === name);
  assert.equal(row("worker").querySelectorAll(".ctx-guide.elbow").length, 0, "shipped caller must not forge an ambiguous parent guide");
  assert.equal(row("child").querySelectorAll(".ctx-guide.elbow").length, 1, "unambiguous parent still draws its elbow");
}
for (const ambiguity of ["same-root", "cross-root"]) {
  test(`shipped roster guides use the full roster for ${ambiguity} ambiguity across clusters`, t => ambiguousClusterGuides(t, ambiguity));
  test(`mutation: omitting the full roster for ${ambiguity} guides is caught at the shipped caller`, t => {
    const mutant = source.replace("treeConnectors(items, i, instances)", "treeConnectors(items, i)");
    assert.notEqual(mutant, source);
    assert.throws(() => ambiguousClusterGuides(t, ambiguity, mutant), /shipped caller must not forge/);
  });
}

for (const [kind, from] of [
  ["pointer-add", 'sidebar.addEventListener("pointerdown", () => tabOpenIntents.invalidate());'],
  ["keyboard-add", 'if (!tabOpenIntents.isApplyingFocus()) tabOpenIntents.invalidate();'],
  ["command-roster", 'tabOpenIntents.invalidate(); // also when the roster already has DOM focus'],
]) test(`mutation: sidebar ${kind} must revoke pending content-focus authority`, async t => {
  const name = kind === "command-roster" ? "focusRoster" : "initContextRoster";
  const block = source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(block); assert.equal(block.split(from).length, 2, 'weaken this sidebar owner, not another component with the same guard');
  const mutant = source.replace(block, block.replace(from, "/* mutation: sidebar did not cancel */"));
  assert.notEqual(mutant, source);
  await assert.rejects(sidebarAttachment(t, kind, "resolve", mutant), /sidebar owns input/);
});

// The roster's filter is gone (the product owner; the command palette finds an instance by name). Its command,
// sidebar.focusFilter, focuses the roster's current row, and with no row still lands in the sidebar.
test("sidebar.focusFilter's run focuses the roster's tab stop, else the sidebar's next way in, never nothing", t => {
  const s = shell(t);
  assert.equal(s.c.contextRosterEl.querySelector("input"), null, "no filter field in the roster");
  const team = [
    { instance: "lead", home: "/t/lead", agentsRoot: "/t/agents", running: true },
    { instance: "worker", home: "/t/worker", agentsRoot: "/t/agents", parentInstance: "lead", running: true },
  ];
  s.c.contextInstances = team; s.renderContextRoster(team);
  const rows = [...s.c.contextRosterEl.querySelectorAll(".ctx-inst")];
  rows[0].tabIndex = -1; rows[1].tabIndex = 0;
  s.focusRoster();
  assert.equal(s.document.activeElement, rows[1], "the roving stop, not the first row");
  assert.deepEqual(rows.map(r => r.tabIndex), [-1, 0]);
  // No instances: the roster's one action, the foot's Spawn instance (the product owner, 2026-10-26), never <body>.
  s.c.contextInstances = []; s.renderContextRoster([]);
  s.focusRoster();
  assert.equal(s.document.activeElement, s.document.getElementById("sidebar-spawn"));
  // Spawn instance disabled: the list of workspaces' Add (always shown with the sidebar).
  s.document.getElementById("sidebar-spawn").disabled = true;
  s.focusRoster();
  assert.equal(s.document.activeElement, s.document.getElementById("ws-add-open"));
});


test("under an open modal the tab-switch actions do nothing (as F6 doesn't); close still works", t => {
  const s = shell(t);
  s.seed("one"); s.seed("two");
  const before = s.c.activeTab;
  s.c.modal = true;
  for (const id of ["tabs.next", "tabs.prev"]) { s.actions.get(id)(); assert.equal(s.c.activeTab, before, id); }
  s.c.modal = false;
  s.actions.get("tabs.next")();
  assert.notEqual(s.c.activeTab, before, "without a modal, Ctrl+Tab switches");
});

test("shell wiring: every tab-switch action (Ctrl+Tab, Alt+Shift+←/→, go-to-tab) is modal-guarded", () => {
  for (const id of ["tabs.next", "tabs.prev", "tabs.nextPage", "tabs.prevPage"]) {
    assert.match(source, new RegExp(`id: "${id.replace(".", "\\.")}".*run: unlessModal\\(`), id);
  }
  assert.match(source, /id: `tabs\.goto\$\{n\}`.*run: unlessModal\(\(\) => gotoTab\(n\)\)/);
});

test("a remote row's terminal tab carries the row's server label, else the server id; a local tab has none", async t => {
  for (const [row, label] of [
    [{ server: "build", repoName: "Build box" }, "Build box"],
    [{ server: "build" }, "build"],
    [{}, undefined],
  ]) {
    const seen = [];
    const s = shell(t, { terminal: opts => { seen.push(opts); return createTerminalTab(opts); } });
    s.c.resolveTerminalOpen = (_instances, ref, ws) => ({ key: `${ws}:${ref}`, inst: row.server
      ? { instance: ref, running: true, addressable: true, home: `/srv/${ref}`, ...row }
      : { instance: ref, running: true, tmux: { session: "synthetic", window: ref } } });
    await s.pending("dev");
    assert.equal(seen.at(-1).serverLabel, label);
  }
});

test("showInRoster: the row with that server and home is revealed (a collapsed parent opened), selected and focused", async t => {
  const s = shell(t);
  const row = (name, extra = {}) => ({ instance: name, agent: "dev", agentsRoot: "/srv/agents", home: `/srv/agents/dev/instances/${name}`,
    server: "build", addressable: true, running: true, repoName: "Build box", ...extra });
  const parent = row("lead"), child = row("helper", { parentInstance: "lead" }), twin = row("helper", { server: "other", repoName: "Other box" });
  s.c.contextInstances = [parent, child, twin];
  s.c.collapsedInstances.add(s.c.collapseKey("A", s.c.instanceId(parent)));
  s.renderContextRoster(s.c.contextInstances);
  assert.equal([...s.document.querySelectorAll(".ctx-inst")].some(b => b.dataset.treeInstance === s.c.instanceId(child)), false, "hidden to begin with");
  assert.equal(await s.showInRoster({ server: "build", home: child.home }), true);
  const active = s.document.activeElement;
  assert.equal(active.dataset.treeInstance, s.c.instanceId(child), "the build row, not its same-named twin on another server");
  assert.equal(active.tabIndex, 0);
  assert.equal(s.c.collapsedInstances.size, 0, "its collapsed parent is opened");
  assert.equal(await s.showInRoster({ server: "build", home: "/srv/agents/dev/instances/nobody" }), false);
});

// ── the tab keys walk the focused group's strip (docs/desktop-keyboard.md, "The keymap as shipped") ──
// G1 [A, C], G2 [B, D]: creation order A B D C, so a walk of every tab would leave the group.
function twoGroups(t) {
  const s = shell(t);
  const A = s.seed("A"); s.splitPane("row");
  const B = s.seed("B"), D = s.seed("D");
  s.selectTab(A);
  const C = s.seed("C");
  const group = id => s.c.split.groups.find(g => g.tabs.includes(id));
  assert.deepEqual([group(A).tabs, group(B).tabs], [[A, C], [B, D]]);
  return { s, A, B, C, D, group };
}

test("split: each next / previous press (Ctrl+Tab, the second chord) changes the focused group's tab and stays in it", t => {
  const { s, A, C, group } = twoGroups(t);
  s.selectTab(A);
  const g1 = group(A);
  for (const id of ["tabs.next", "tabs.nextPage", "tabs.prev", "tabs.prevPage", "tabs.next"]) {
    const before = s.c.activeTab;
    s.actions.get(id)();
    assert.notEqual(s.c.activeTab, before, `${id} changes the shown tab`);
    assert.ok(g1.tabs.includes(s.c.activeTab), `${id} stays in the focused group`);
    assert.equal(s.c.split.focusedGroup, g1.id);
    assert.equal(s.c.split.groups.find(g => g.id === g1.id).activeTab, s.c.activeTab, `${id}: the group shows it`);
  }
  assert.equal(s.c.activeTab, C);
});

test("split: go to tab N picks the Nth tab of the focused group, go to the last its last", t => {
  const { s, A, B, C, D } = twoGroups(t);
  s.selectTab(D);
  s.actions.get("tabs.goto1")();
  assert.equal(s.c.activeTab, B, "G2's first, not the window's");
  s.actions.get("tabs.goto9")();
  assert.equal(s.c.activeTab, D, "G2's last");
  s.actions.get("tabs.goto3")();
  assert.equal(s.c.activeTab, D, "G2 has no third tab: nothing moves");
  s.selectTab(A);
  s.actions.get("tabs.goto2")();
  assert.equal(s.c.activeTab, C);
});

test("split with an empty focused group: the tab keys do nothing there", t => {
  const s = shell(t);
  s.seed("A"); s.seed("B"); s.splitPane("row");
  assert.equal(s.c.activeTab, null, "the new group is empty and focused");
  for (const id of ["tabs.next", "tabs.prev", "tabs.nextPage", "tabs.prevPage", "tabs.goto1", "tabs.goto9"]) {
    s.actions.get(id)();
    assert.equal(s.c.activeTab, null, id);
  }
});

test("flat strip: three presses over three tabs visit each once, in strip order", t => {
  const s = shell(t);
  const ids = ["one", "two", "three"].map(name => s.seed(name));
  const seen = [];
  for (let i = 0; i < 3; i++) { s.actions.get("tabs.next")(); seen.push(s.c.activeTab); }
  assert.deepEqual(seen, ids);
});

// cycleTab's rule for a strip with no active tab. The tab keys are not live on a stage (context `tabs`,
// updateActiveContexts), so this is the shipped function's own rule, run directly.
test("cycleTab with no active tab: next is the first tab, previous the last (not the second)", t => {
  const s = shell(t);
  const ids = ["one", "two", "three"].map(name => s.seed(name));
  s.showTabLayer(false);
  assert.equal(s.c.activeTab, null);
  s.cycleTab(1);
  assert.equal(s.c.activeTab, ids[0]);
  s.showTabLayer(false);
  s.cycleTab(-1);
  assert.equal(s.c.activeTab, ids.at(-1));
});
// ── the instance steps (roster.openPrevious/openNext, the chords): N presses, N moves ──────
// The leader's ↑/↓ are the workspace moves now (packages/client/keymap.mjs); its keys with a target (X, R, S, D,
// N) read it at the key, as the chords do.
const steps = ["A", "B", "C", "D"].map(instance => ({ instance, running: true, agentsRoot: "/team/agents", home: `/team/${instance}` }));
function stepShell(t) {
  const s = shell(t, { leader: true });
  s.c.contextInstances = steps; s.renderContextRoster(steps);
  let attached = 90;
  s.open = async (row) => {
    const result = s.c.openTerminalTab(row);
    s.requests.at(-1).resolve({ instances: [] }); await flush();
    s.attachments.at(-1).resolve({ id: attached++ }); await result;
    assert.equal(s.c.tabs.get(s.c.activeTab).instanceRef.home, row.home);
    s.c.opened.length = 0;
  };
  // The chord, pressed where focus is (or on the body), as the shipped action runs.
  s.press = (delta = 1) => {
    const at = s.document.activeElement ?? s.document.body;
    s.actions.get(delta > 0 ? "roster.openNext" : "roster.openPrevious")({ target: at });
  };
  // The leader then `key`, pressed where focus is.
  s.leaderKey = key => {
    s.actions.get("app.leader")({ target: s.document.activeElement ?? s.document.body });
    s.dispatch(s.document.activeElement ?? s.document.body, "keydown", { key, code: key.startsWith("Arrow") ? key : `Key${key.toUpperCase()}`, shiftKey: key === "X" });
  };
  s.row = name => [...s.document.querySelectorAll(".ctx-inst")].find(row => row.dataset.treeInstance === `/team/${name}`);
  return s;
}

for (const from of ["terminal", "roster"]) {
  test(`chord from the ${from}: a second press while the first open still waits for /api/panel moves on, not back`, async t => {
    const s = stepShell(t);
    await s.open(steps[0]);
    if (from === "roster") s.row("A").focus();
    s.press();
    assert.deepEqual(s.c.opened, ["B"]);
    const first = s.requests.at(-1);
    s.press();
    assert.deepEqual(s.c.opened, ["B", "C"], "the second press steps from B, the open in flight");
    s.press();
    assert.deepEqual(s.c.opened, ["B", "C", "D"], "and the third from C");
    s.press();
    assert.deepEqual(s.c.opened, ["B", "C", "D"], "at the end nothing moves");
    assert.equal(s.c.said.at(-1), "No instance below this one has a terminal to open.");
    s.press(-1);
    assert.deepEqual(s.c.opened, ["B", "C", "D", "C"], "back up from D, still opening");
    first.resolve({ instances: [] }); await flush();
    assert.equal(s.attachments.length, 1, "the superseded opens attach nothing");
  });
}

test("the leader's ↑/↓ move between workspaces: from a terminal they open no instance", async t => {
  const s = stepShell(t);
  await s.open(steps[0]);
  s.leaderKey("ArrowDown");
  s.leaderKey("ArrowUp");
  assert.deepEqual(s.c.steppedWorkspaces, [1, -1], "the list's step, down then up");
  assert.deepEqual(s.c.steppedHow, [{ focusPlace: true }, { focusPlace: true }], "made outside the list: the focus goes back where it was there");
  assert.deepEqual(s.c.opened, [], "no instance step");
});

test("the leader pressed, then the open resolves and attaches, then X: the target is read at the key", async t => {
  const s = stepShell(t);
  await s.open(steps[0]);
  s.press();
  assert.deepEqual(s.c.opened, ["B"]);
  s.actions.get("app.leader")({ target: s.document.activeElement });
  s.requests.at(-1).resolve({ instances: [] }); await flush();
  s.attachments.at(-1).resolve({ id: 99 }); await flush();
  assert.equal(s.c.tabs.get(s.c.activeTab).instanceRef.home, "/team/B");
  s.dispatch(s.document.activeElement, "keydown", { key: "X", code: "KeyX", shiftKey: true });
  assert.deepEqual(s.c.acts, [["stop", "B"]], "B, shown when the key was pressed, not A, shown when the leader was");
});

test("focus left in a hidden pane counts for nothing: the shown terminal is the target", async t => {
  const s = stepShell(t);
  await s.open(steps[0]);
  const hiddenInput = s.c.tabs.get(s.c.activeTab).paneEl.querySelector("textarea");
  await s.open(steps[1]);
  hiddenInput.focus();
  assert.equal(s.c.tabs.get(s.c.activeTab).instanceRef.home, "/team/B");
  assert.equal(s.c.tabs.get(1).paneEl.hidden, true, "focus is in A's hidden pane");
  assert.equal(s.document.activeElement, hiddenInput);
  s.press();
  assert.deepEqual(s.c.opened, ["C"], "the chord steps from B");
  s.requests.at(-1).resolve({ instances: [] }); await flush();
  s.attachments.at(-1).resolve({ id: 101 }); await flush();
  s.selectTab([...s.c.tabs].find(([, tab]) => tab.instanceRef.home === "/team/B")[0]);
  hiddenInput.focus();
  s.leaderKey("X");
  assert.deepEqual(s.c.acts, [["stop", "B"]], "the leader's target is B too");
});

test("an open that fails leaves no target behind: the next press steps from what is shown", async t => {
  const s = stepShell(t);
  await s.open(steps[0]);
  s.press();
  assert.deepEqual(s.c.opened, ["B"]);
  s.requests.at(-1).reject(new Error("panel unreadable"));
  await flush();
  assert.deepEqual(s.c.failed, ["panel unreadable"]);
  s.press();
  assert.deepEqual(s.c.opened, ["B", "B"], "A is still shown: the step is from A again, not from the dead B");
});

test("the leader shows nothing while it waits, announced once; a key after it that cannot act says why in the line", async t => {
  const s = stepShell(t);
  await s.open(steps[0]);
  const hint = s.c.leaderHint.element;
  s.actions.get("app.leader")({ target: s.document.activeElement });
  assert.deepEqual([...hint.children].map(child => [child.className, child.textContent]), [["sr-only", LEADER_ANNOUNCEMENT]], "no keys panel");
  assert.equal(s.c.leaderHint.isShown(), false);
  s.dispatch(s.document.activeElement, "keydown", { key: "ArrowRight", code: "ArrowRight" });
  assert.equal(s.c.leaderHint.mode(), "line", "one tab: → cannot act");
  assert.equal(hint.textContent, "There is no other tab.");
  // The leader's ? is the shortcuts editor, which lists its keys.
  let editor = 0; s.actions.set("app.shortcuts", () => editor++);
  s.actions.get("app.leader")({ target: s.document.activeElement });
  s.dispatch(s.document.activeElement, "keydown", { key: "?", code: "Slash", shiftKey: true });
  assert.equal(editor, 1);
  assert.equal(s.c.leaderHint.mode(), null, "a key that ran: the wait's announcement is gone, nothing shows");
});

test("the leader's ← / → in a split: an empty or one-tab focused group says there is no other tab, and nothing moves", async t => {
  const s = shell(t, { leader: true });
  const A = s.seed("A"), C = s.seed("C");
  s.splitPane("row");
  const press = key => {
    s.actions.get("app.leader")({ target: s.document.activeElement ?? s.document.body });
    s.dispatch(s.document.activeElement ?? s.document.body, "keydown", { key, code: key });
  };
  assert.equal(s.c.activeTab, null, "G2 is empty and focused");
  for (const key of ["ArrowRight", "ArrowLeft"]) {
    s.c.said.length = 0; press(key);
    assert.deepEqual(s.c.said, ["There is no other tab."], `empty group, ${key}`);
    assert.equal(s.c.activeTab, null);
  }
  const B = s.seed("B");
  assert.deepEqual(s.c.split.groups.map(g => g.tabs), [[A, C], [B]]);
  for (const key of ["ArrowRight", "ArrowLeft"]) {
    s.c.said.length = 0; press(key);
    assert.deepEqual(s.c.said, ["There is no other tab."], `one-tab group, ${key}`);
    assert.equal(s.c.activeTab, B);
  }
  s.selectTab(A);
  s.c.said.length = 0; press("ArrowRight");
  assert.deepEqual(s.c.said, []);
  assert.equal(s.c.activeTab, C, "two tabs in the focused group: → moves within it");
});


test('launch opens a new or retained terminal without keyboard focus, including after attachment', async t => {
  for (const retained of [false, true]) {
    const s = shell(t, { leader: true });
    const row = { instance: 'launch-probe', agent: 'dev', home: '/fixture/agents/dev/instances/launch-probe',
      agentsRoot: '/fixture/agents', deployment: { id: '/fixture' }, running: true,
      tmux: { session: 'synthetic', window: 'launch-probe' } };
    s.c.contextInstances = [row];
    s.renderContextRoster([row]);
    if (retained) {
      const opened = s.c.openTerminalTab(row);
      s.requests.at(-1).resolve({ instances: [row] }); await flush();
      s.attachments.at(-1).resolve({ id: 201 }); await opened;
    }
    s.c.tabOpenIntents = s.tabOpenIntents;
    s.c.heldHome = instanceTree.heldHome;
    s.c.showInRoster = s.showInRoster;
    s.c.operator = { input: () => 0, pointer: () => 0 };
    s.c.notifications = { notify: message => assert.fail(message) };
    s.c.shownRoster = { gen: 0, ws: 'A', instances: [row], read: 1 };
    s.c.openTerminalTab = (ref, opts) => s.openTerminalTabFlow(ref, message => assert.fail(message), opts);
    s.c.alert = message => assert.fail(message);
    const creation = source.slice(source.indexOf("// A launch's --instance (launch-focus.mjs): its row is selected"),
      source.indexOf('// Persistent recursive instance tree'));
    const focus = runInNewContext(`${creation}\nlaunchFocus`, s.c);
    t.after(() => focus.dispose());
    focus.request({ deployment: '/fixture', name: 'launch-probe' });
    focus.observe([row]); await flush();
    const input = s.terms.at(-1).input;
    assert.equal(s.c.tabs.size, 1);
    assert.equal(s.c.tabs.get(s.c.activeTab).instanceRef.instance, row.instance);
    assert.equal(s.document.activeElement.dataset.treeInstance, s.c.instanceId(row));
    assert.equal(input.contains(s.document.activeElement), false);
    if (!retained) { s.attachments.at(-1).resolve({ id: 202 }); await flush(); }
    assert.equal(s.document.activeElement.dataset.treeInstance, s.c.instanceId(row), 'readiness keeps focus on the row');
    assert.equal(s.attachments.length, 1, 'retained opens attach once');
    assert.equal(s.terms.at(-1).focuses, retained ? 1 : 0, 'launch adds no input focus');
    s.focusActiveTerminal();
    assert.equal(s.document.activeElement, input, 'the existing explicit focus action still enters the terminal');
  }
});
