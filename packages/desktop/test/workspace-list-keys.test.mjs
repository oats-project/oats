// The workspace list's keys, through the shipped shell (docs/desktop-keyboard.md, "The leader"; spec PR 3):
// - Ctrl+X then ↑ / ↓ (keymap.mjs LEADER_TABLE workspace-previous / workspace-next) reach the list's
//   step(-1 / 1) by the shipped path: the engine's one keydown listener, app.leader, the leader's onSettle,
//   leaderDispatch, workspaceStep. At an end, the hint's line says so.
// - ⌘K / Ctrl+Alt+K after A → B → A: the palette lists A's instances most recently selected or focused first,
//   as before the switch (the shipped activateTab record, the palette's shipped loadInstances).
// - app.workspaces, the leader's o and the palette's "Workspace: switch…" focus the list's current row
//   (focusWorkspaceList: focus mode left, a hidden sidebar shown).
// The shell's functions are extracted from shell.mjs and run in a vm over the shipped index.html; only IPC
// (switchWorkspace, the desktop bridge) and the roster read are synthetic. No Electron, server or terminal.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { pinPlatform } from "./helpers/platform.mjs";
import { viewContext } from "./helpers/view-context.mjs";
import { withShellWindowGlobals } from "./helpers/shell-window-globals.mjs";
import * as keymap from "../renderer/keybindings.mjs";
import { createWorkspaceSwitcher } from "../renderer/workspace-switcher.mjs";
import { createLeader } from "../renderer/leader.mjs";
import { createLeaderHint } from "../renderer/leader-hint.mjs";
import { createLeaderDispatch } from "../renderer/leader-dispatch.mjs";
import { leaderApplies, leaderLabel } from "../renderer/leader-keys.mjs";
import { splitControlsState } from "../renderer/split-controls.mjs";
import { LEADER_TABLE } from "../../client/keymap.mjs";
import { instanceId } from "../../client/instance-tree.mjs";
import { createInstanceRecency, recencyIdFromTerminalKey } from "../renderer/instance-recency.mjs";
import { terminalKey } from "../renderer/instance-tree-view.mjs";
import { paletteRows } from "../renderer/palette.mjs";
import { panelDeployments } from "../renderer/view-deployments.mjs";
import { NAV, navTab, stageSidebarMode } from "../renderer/shell-nav.mjs";
import { createSelectionOwnership, wirePaneSelection } from "../renderer/selection-ownership.mjs";
import { createIntentGate, prepareOwnedOpen } from "../renderer/open-intent.mjs";
import { createViewLifecycle } from "../renderer/view-lifecycle.mjs";
import { createWorkspaceTabMemory } from "../renderer/workspace-tab-memory.mjs";
import { createTabChrome, tabKeyAction, focusAfterLastTab } from "../renderer/tab-a11y.mjs";
import { numberTabStrips } from "../renderer/tab-numbers.mjs";
import { reserveKey, whenKeyFree } from "../renderer/tab-keys.mjs";
import { projectSplitDom } from "../renderer/split-dom.mjs";
import * as layout from "../renderer/split-layout.mjs";
import * as workspaceTabs from "../renderer/workspace-tabs.mjs";
import { revealInStrip } from "../renderer/reveal-in-scrollport.mjs";
import { createFocusRegions } from "../renderer/focus-regions.mjs";

const memory = new Map();
globalThis.localStorage ??= { getItem: k => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)), removeItem: k => memory.delete(k) };

const source = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
const flush = () => new Promise(setImmediate);
/** A shipped piece of shell.mjs: a function by name, or the first match of a pattern. */
function shipped(what) {
  const re = typeof what === "string" ? new RegExp(`(?:async )?function ${what}\\([^]*?\\n\\}`) : what;
  const found = source.match(re)?.[0];
  assert.ok(found, `exercise the shipped ${what}`);
  return found;
}

// ---------------------------------------------------------------- the list, the leader, focusWorkspaceList

const A = { id: "/w/a", name: "Alpha" }, B = { id: "/w/b", name: "Beta" }, C = { id: "/w/c", name: "Gamma" };

/** The shipped shell's list (workspaceLabel), leader (the hint, onSettle, the dispatch), app.workspaces and
 * focusWorkspaceList, on the shipped index.html, with the platform pinned. */
function rig(t, { platform = "Linux x86_64" } = {}) {
  pinPlatform(t, platform);
  keymap.resetAllBindings();
  const dom = new JSDOM(html, { pretendToBeVisual: true, url: "https://fixture.invalid" });
  const document = dom.window.document;
  const switched = [], added = [], offs = [];
  let asked = 0;
  const c = {
    document, window: dom.window, navigator: { platform }, console, setTimeout, clearTimeout, queueMicrotask,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    // The list (shell.mjs workspaceLabel), its main-side calls recorded.
    createWorkspaceSwitcher, switchWorkspace: (id, options) => { switched.push([id, { ...options }]); return Promise.resolve({ ok: true }); },
    desktopBridge: {
      workspaceSuggestions: async () => { asked++; return { suggestions: [] }; },
      workspaceAdd: async path => { added.push(path); return { ok: true, workspace: { ...C } }; },
      windowOpenWorkspace() {},
    },
    unavailableWorkspaceService: () => Promise.reject(new Error("unavailable")), noteUnlisted: result => result,
    notifications: { notify() {} }, showStage() {}, onWorkspaceChange: () => () => {},
    // The leader's part: the window's state with no terminal open, no roster row focused.
    createLeader, createLeaderHint, createLeaderDispatch, LEADER_TABLE, leaderApplies, leaderLabel, splitControlsState, instanceId,
    modalOpen: () => false, tabLayerVisible: false, tabs: new Map(), activeTab: null, split: null, walkedTabs: () => [],
    canActivateTab: () => false, currentWorkspace: () => A.id, contextInstances: [], shownRows: rows => rows, contextRosterEl: null,
    rosterActsHeld: () => null,
    // focusWorkspaceList's: the panel's focus mode (its class on #app, as context-panel.mjs sets it), the tab intents.
    contextPanel: {
      setFocusMode: on => document.getElementById("app").classList.toggle("focus-mode", on),
      isFocusMode: () => document.getElementById("app").classList.contains("focus-mode"),
    },
    tabOpenIntents: { invalidations: 0, invalidate() { this.invalidations++; }, applyFocus: fn => fn() },
    // The leader's workspaceStep asks the F6 regions whether the focus is in the list of workspaces.
    focusRegions: createFocusRegions({ doc: document }),
    registerAction: action => { const off = keymap.registerAction(action); offs.push(off); return off; },
    runAction: keymap.runAction, handleKeydown: keymap.handleKeydown, getBinding: keymap.getBinding, formatChord: keymap.formatChord,
  };
  const pieces = [
    shipped(/const workspaceLabel = createWorkspaceSwitcher\(\{[^]*?\n\}\);/),
    shipped(/const isMac = navigator\.platform\.includes\("Mac"\);/),
    shipped(/const chordDetail = \(id\) => \(\) => \{[^]*?\n\};/),
    shipped(/const SIDEBAR_HIDDEN_KEY = [^\n]+/),
    // Shown again with Show sidebar focused, the sidebar hands the focus to the roster's way in (rosterEntry, slice 1).
    shipped("sidebarHidden"), shipped("updateSidebarControls"), shipped("rosterEntry"), shipped("setSidebarHidden"), shipped("focusWorkspaceList"),
    shipped(/registerAction\(\{ id: "app\.workspaces"[^\n]+/),
    // The engine's one window keydown listener, and the leader as the shell builds and binds it.
    shipped(/window\.addEventListener\("keydown", \(e\) => handleKeydown\(e\)\);/),
    shipped(/const leaderHint = createLeaderHint\([^\n]+/), shipped(/let hintLineArmed = [^\n]+/), shipped("sayInHint"),
    shipped(/for \(const type of \["keydown", "pointerdown", "focusin", "focusout"\]\) \{\n[^\n]+\n\}/),
    shipped(/let terminalOpening = [^\n]+/), shipped(/const rosterInstance = [^\n]+/),
    shipped("leaderState"), shipped("leaderTargetId"), shipped("openingInstanceId"), shipped("leaderOrigin"), shipped("notApplicable"),
    shipped(/const leaderDispatch = createLeaderDispatch\(\{[^]*?\n\}\);/), shipped(/const leader = createLeader\(\{[^]*?\n\}\);/),
    shipped(/registerAction\(\{ id: "app\.leader"[^\n]*\n[^\n]*/),
  ];
  // The palette's command for the list, as shipped (one entry of its commands).
  const paletteEntry = shipped(/\{ label: "Workspace: switch…"[^\n]+\},/);
  const s = runInNewContext(`${pieces.join("\n")}\n({ workspaceLabel, focusWorkspaceList, leader, leaderDispatch, leaderHint, setSidebarHidden, sidebarHidden, paletteCommand: [${paletteEntry}][0] });`, c);
  t.after(() => { s.leader.dispose(); s.workspaceLabel.dispose(); offs.forEach(off => off()); keymap.resetAllBindings(); dom.window.close(); });
  const fire = (target, init) => {
    for (const type of ["keydown", "keyup"]) target.dispatchEvent(new dom.window.KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));
  };
  const rows = () => [...document.querySelectorAll("#ws-options .ws-option")];
  return {
    ...s, c, dom, document, switched, added, rows, asked: () => asked,
    current: () => document.querySelector('#ws-options .ws-option[aria-current="true"]'),
    row: key => rows().find(row => row.dataset.workspaceId === key) ?? null,
    line: () => document.querySelector("#leader-hint .leader-hint-line")?.textContent ?? null,
    /** Ctrl+X (the leader on both platforms), then `key`, pressed where focus is. */
    leaderThen(key) {
      const at = document.activeElement === document.body ? document.getElementById("sidebar-spawn") : document.activeElement;
      at.focus();
      fire(at, { key: "x", code: "KeyX", keyCode: 88, ctrlKey: true });
      assert.ok(s.leader.isWaiting(), "Ctrl+X opens the leader");
      fire(document.activeElement, key === "up" ? { key: "ArrowUp", code: "ArrowUp", keyCode: 38 } : key === "down" ? { key: "ArrowDown", code: "ArrowDown", keyCode: 40 }
        : { key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0) });
    },
    /** What main answers once a switch is bound: the window shows `workspace`, its served views `list`. */
    shows(workspace, list) { s.workspaceLabel.begin()(workspace, list); },
  };
}

for (const platform of ["Linux x86_64", "MacIntel"]) test(`${platform}: Ctrl+X then ↓ / ↑ step the list as drawn, as a click does, wrapping at the ends; with no other workspace the hint says so`, async t => {
  const r = rig(t, { platform });
  r.shows(A, [A, B, C]); await flush();
  // The rows are the served views alone: the list asks main for nothing (this computer's deployments are Add's).
  assert.deepEqual(r.rows().map(row => row.dataset.workspaceId), [A.id, B.id, C.id]);
  assert.equal(r.asked(), 0);
  // At the top: ↑ goes on from the other end, to Gamma, the last row. Made from outside the list (the foot), the
  // focus goes back where it was in the workspace shown.
  r.leaderThen("up");
  assert.deepEqual(r.switched, [[C.id, { focusPlace: true, takeOver: true }]], "the moves wrap");
  r.switched.length = 0;
  r.shows(C, [A, B, C]);
  // ↓ from Gamma: Alpha, the first row again.
  r.leaderThen("down");
  assert.deepEqual(r.switched, [[A.id, { focusPlace: true, takeOver: true }]]);
  r.switched.length = 0;
  r.shows(A, [A, B, C]);
  // ↓: B, even if another window shows it: it is taken over into this window, as its click is.
  r.leaderThen("down");
  assert.deepEqual(r.switched, [[B.id, { focusPlace: true, takeOver: true }]], "a pick from the list always shows the workspace here");
  r.switched.length = 0;
  r.shows(B, [A, B, C]);
  // ↓ from B: Gamma; every row opens, so nothing is passed over.
  r.leaderThen("down");
  assert.deepEqual(r.switched, [[C.id, { focusPlace: true, takeOver: true }]]);
  r.shows(C, [A, B, C]);
  assert.equal(r.current()?.dataset.workspaceId, C.id);
  // ↑ from Gamma: Beta, then Alpha.
  r.switched.length = 0;
  r.leaderThen("up");
  assert.deepEqual(r.switched, [[B.id, { focusPlace: true, takeOver: true }]]);
  r.shows(B, [A, B, C]);
  r.leaderThen("up");
  assert.deepEqual(r.switched.at(-1), [A.id, { focusPlace: true, takeOver: true }]);
  assert.deepEqual(r.added, [], "a move adds nothing");
  // No instance was opened or stepped: the leader's arrows are the workspace moves only.
  assert.equal(r.c.tabs.size, 0);
  // A click on a row: the same switch, with no focus option of its own (the focus goes back where it was there).
  r.shows(A, [A, B, C]);
  r.row(C.id).click();
  assert.deepEqual(r.switched.at(-1), [C.id, { takeOver: true }], "the click: the same switch");
  // One workspace, the current one: nothing moves, and the hint's line says why.
  const alone = rig(t, { platform });
  alone.shows(A, [A]); await flush();
  for (const key of ["down", "up"]) {
    alone.leaderThen(key);
    assert.deepEqual(alone.switched, [], `${key}: nothing to show`);
    assert.equal(alone.line(), "No other workspace to show.");
  }
});

test("the leader's ↓ from a row of the list itself moves the workspace, not the list's focus", async t => {
  const r = rig(t);
  r.shows(A, [A, B]); await flush();
  r.current().focus();
  r.leaderThen("down");
  assert.deepEqual(r.switched, [[B.id, { focusPlace: false, takeOver: true }]], "made from the list: the focus stays on the list");
  assert.equal(r.document.activeElement, r.row(A.id), "the arrow was the leader's: the list's own Down did not run");
});

test("app.workspaces, the leader's o and the palette's Workspace: switch… focus the list's current row: focus mode left, the sidebar shown", async t => {
  const r = rig(t);
  r.shows(A, [A, B]); await flush();
  const app = r.document.getElementById("app");
  assert.equal(keymap.listActions().find(action => action.id === "app.workspaces")?.label, "Focus the list of workspaces");
  const ways = {
    "app.workspaces": () => keymap.runAction("app.workspaces"),
    "the leader's o": () => r.leaderThen("o"),
    "Workspace: switch…": () => r.paletteCommand.run(),
  };
  for (const [way, run] of Object.entries(ways)) {
    for (const away of ["focus mode", "hidden sidebar", "both"]) {
      r.document.getElementById("sidebar-spawn").focus();
      if (away !== "hidden sidebar") r.c.contextPanel.setFocusMode(true);
      if (away !== "focus mode") r.setSidebarHidden(true);
      const before = r.c.tabOpenIntents.invalidations;
      run();
      assert.equal(app.classList.contains("focus-mode"), false, `${way} (${away}): focus mode left`);
      assert.equal(r.sidebarHidden(), false, `${way} (${away}): the sidebar shown`);
      assert.equal(r.document.activeElement, r.current(), `${way} (${away}): the current row has focus`);
      assert.equal(r.document.activeElement.dataset.workspaceId, A.id);
      assert.ok(r.c.tabOpenIntents.invalidations > before, `${way}: a pending tab open no longer owns the focus`);
    }
  }
  assert.deepEqual(r.switched, [], "focusing the list switches nothing");
  assert.equal(r.paletteCommand.label, "Workspace: switch…");
  // Another row focused last in the list (its Tab stop now) does not change where these land: the current row.
  r.row(B.id).focus(); r.document.getElementById("sidebar-spawn").focus();
  keymap.runAction("app.workspaces");
  assert.equal(r.document.activeElement, r.current(), "the current row, not the row last focused");
});

// ---------------------------------------------------------------- ⌘K order after A → B → A

const at = (ws, instance) => ({ instance, agent: "dev", home: `${ws}/agents/dev/instances/${instance}`, agentsRoot: `${ws}/agents`, running: true });
const ROSTERS = { A: ["a1", "a2", "a3", "a4"].map(name => at("/w/a", name)), B: ["b1", "b2"].map(name => at("/w/b", name)) };

function memoryStorage() {
  const map = new Map();
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) };
}
/** The shipped tab layer (addTab, selectTab, activateTab, restoreWorkspaceTabs…), the record it writes (Spec C,
 * instance-recency.mjs) and the palette's shipped loadInstances over the same record. */
function tabsRig(t) {
  const dom = new JSDOM(`<body><aside><section id="ws-list"><div id="ws-options"></div></section><nav id="nav"></nav><div id="nav-foot"></div></aside>
    <div id="stagehost"></div><div id="tabstrip"><div id="tabbar-row"><div id="tabbar"></div><div id="tab-actions"></div></div></div><div id="tabhost"></div>`);
  t.after(() => dom.window.close());
  const document = dom.window.document, navEl = document.getElementById("nav");
  let clock = 1000;
  const c = {
    document, console, navigator: { platform: "MacIntel" }, NAV, navTab, stageSidebarMode,
    workspace: "A", generation: 0, tabWorkspace: "A", contextWorkspace: "A", activeInstanceMenu: null,
    stage: null, stageOp: 0, stageHost: document.getElementById("stagehost"), navEl,
    tabs: new Map(), nextTabId: 1, activeTab: null, split: null, sidebarMode: "overview", tabLayerVisible: false,
    contextRosterGen: 0, contextInstances: [], contextRosterEl: null, rosterState: null, rosterStale: false, contextDeploymentNote: null, ...viewContext(), rosterSignaturePainted: null,
    tabbar: document.getElementById("tabbar"), tabhost: document.getElementById("tabhost"), tabActionsEl: document.getElementById("tab-actions"),
    // The real record, on a per-test storage and a clock that never repeats.
    instanceRecency: createInstanceRecency({ storage: memoryStorage(), now: () => clock++ }), recencyIdFromTerminalKey,
    wsActiveTerminal: new Map(), workspaceTabMemory: createWorkspaceTabMemory(), brainIntents: createIntentGate(),
    currentWorkspace: () => c.workspace, workspaceGeneration: () => c.generation,
    setActiveContexts() {}, workspaceLabel: { reset() {} }, refreshContextRoster() {}, renderContextRoster() {}, updateSplitControls() {},
    revealInStrip, tabStripResize: null, numberTabStrips, tabNumberObserver: null,
    createSelectionOwnership, wirePaneSelection, createViewLifecycle, createTabChrome, tabKeyAction, focusAfterLastTab,
    reserveKey, whenKeyFree, prepareOwnedOpen, projectSplitDom, ...layout, ...workspaceTabs,
    loadStageView: () => new Promise(() => {}), syncContextPanel() {}, contextPanel: {}, createPanelOwner: () => ({ dispose() {} }), ctx: {},
    // The palette's read: this window's state, and the roster of the workspace it asks for.
    windowState: () => "bound", panelDeployments, api: async path => ({ instances: ROSTERS[new URLSearchParams(path.split("?")[1]).get("ws")] }),
  };
  const names = ["closeStage", "showStage", "setNavActive", "showTabLayer", "updateActiveContexts", "setSidebarMode", "updateContextTabs",
    "addTab", "selectTab", "activateTab", "revealActiveRosterRow", "closeTab", "tabStrips", "revealActiveTabs", "observeTabStrips", "onTabKeydown",
    "walkedTabs", "visibleTabEntries", "renderSplit", "selectEmptyGroup", "restoreWorkspaceTabs", "showTerminalContext", "openViewTab"];
  const functions = names.map(name => shipped(name)).join("\n").replace('import(`./views/${name}.mjs`)', "loadStageView(name)");
  // The palette's loadInstances, as shipped (createPalette's first option).
  const load = shipped(/ {2}loadInstances: async \(\) => \{[^]*?\n {2}\},/);
  const s = runInNewContext(`${shipped(/const tabOpenIntents = [^\n]+/)}\n${functions}\n({ ${names.join(", ")}, loadInstances: ({ ${load} }).loadInstances });`, withShellWindowGlobals(c));
  const ids = new Map();
  return {
    ...s, c,
    /** Open `name`'s terminal tab in the current workspace (the tab key the shell mints for it). */
    seed(name) {
      const inst = ROSTERS[c.workspace].find(i => i.instance === name);
      const made = s.addTab({ title: name, key: terminalKey(c.workspace, inst), kind: "terminal", instanceRef: inst, focusContent() {} });
      ids.set(`${c.workspace}:${name}`, made.id);
      return made.id;
    },
    tab: name => ids.get(`${c.workspace}:${name}`),
    /** Two groups side by side, each showing one of `names`' tabs (the split-layout model the shell renders). */
    splitOf(names) {
      const [first, second] = names.map(name => ids.get(`${c.workspace}:${name}`));
      return layout.openTabInFocusedGroup(layout.requestSplit(null, "row", [first], first).split, second).split;
    },
    /** A terminal taking keyboard focus: its pane's focusin selects its tab (wirePaneSelection). */
    focusIn(name) { c.tabs.get(ids.get(`${c.workspace}:${name}`)).paneEl.dispatchEvent(new dom.window.Event("focusin", { bubbles: true })); },
    switchTo(workspace) { c.workspace = workspace; c.generation++; s.restoreWorkspaceTabs(); },
    /** The palette's instance rows as ⌘K / Ctrl+Alt+K lists them now: the shipped read, then its rows. */
    async palette() {
      const data = await s.loadInstances();
      return paletteRows(data, [], "", { openTerminal() {} }).filter(row => row.group).map(row => row.label);
    },
  };
}

test("⌘K / Ctrl+Alt+K after A → B → A: A's instances most recently selected or focused first, as before the switch", async t => {
  const s = tabsRig(t);
  // In A, oldest first: a2 selected, a3 focused (its terminal, shown beside a2, took keyboard focus), a1 selected.
  // a4 has no tab.
  for (const name of ["a1", "a2", "a3"]) s.seed(name);
  s.c.split = s.splitOf(["a2", "a3"]);
  s.selectTab(s.tab("a2"));
  s.focusIn("a3");
  s.selectTab(s.tab("a1"));
  const before = await s.palette();
  assert.deepEqual(before, ["a1", "a3", "a2", "a4"], "newest first; never focused after");
  // Away to B, where other instances are selected and focused: B's own order.
  s.switchTo("B");
  for (const name of ["b1", "b2"]) s.seed(name);
  s.selectTab(s.tab("b1"));
  s.selectTab(s.tab("b2"));
  assert.deepEqual(await s.palette(), ["b2", "b1"]);
  // And back to A: the order A had, unchanged by the visit (A's restored tab is the one it showed, a1).
  s.switchTo("A");
  assert.equal(s.c.tabs.get(s.c.activeTab).title, "a1", "A shows the tab it showed");
  assert.deepEqual(await s.palette(), before);
  // A selection made now still moves its instance to the top.
  s.selectTab(s.tab("a2"));
  assert.deepEqual(await s.palette(), ["a2", "a1", "a3", "a4"]);
  s.switchTo("B"); s.switchTo("A");
  assert.deepEqual(await s.palette(), ["a2", "a1", "a3", "a4"], "and is kept across another visit");
  assert.deepEqual([...s.c.instanceRecency.snapshot("B").keys()].map(id => id.split("/").at(-1)).sort(), ["b1", "b2"], "B's record is B's alone");
});

// Slice 1 of the Desktop UI rework dropped Show only the current workspace: the palette lists no entry for it.
test("the palette has no Show only the current workspace (the list always shows every workspace)", () => {
  const src = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
  const commands = src.slice(src.indexOf("  commands: [\n"), src.indexOf("\n  ],\n});", src.indexOf("  commands: [\n")));
  assert.ok(commands.length > 100, "the palette's commands");
  assert.doesNotMatch(commands, /show only the current workspace|workspaces\.currentOnly/i);
});
