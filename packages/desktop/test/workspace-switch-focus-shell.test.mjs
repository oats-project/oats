// A workspace switch puts the keyboard back where it was in that workspace (docs/desktop.md, "Tabs belong to their
// window"; renderer/focus-place.mjs). The shipped restoreWorkspaceTabs takes the place of the workspace left (the
// focus now, else the last focus outside the transit surfaces while it was shown) and focusArrival applies the
// arriving one's under one intent ticket: a terminal's input, a tab's content or control, a roster row once the
// roster has painted (applyRosterPlace), a page control, the views nav, else the region's landing; never <body>.
// The shipped shell functions run in a vm over the real index.html, the shipped focus regions and focus places;
// only xterm, IPC, the roster read and main's switch are synthetic (the harness of workspace-takeover-shell).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { createInstanceRecency, recencyIdFromTerminalKey } from "../renderer/instance-recency.mjs";
import { viewContext } from "./helpers/view-context.mjs";
import { opened, confirmed, ready as terminalReady } from "./helpers/terminal-wire.mjs";
import { withShellWindowGlobals } from "./helpers/shell-window-globals.mjs";
import { createSelectionOwnership, wirePaneSelection } from "../renderer/selection-ownership.mjs";
import { createIntentGate } from "../renderer/open-intent.mjs";
import { createTerminalTab, terminalOptions, fitTerminal, createGlyphRenderer } from "../renderer/terminal-tab.mjs";
import { createTabChrome, tabKeyAction, focusAfterLastTab, tabNameTailStart, setTabTitle } from "../renderer/tab-a11y.mjs";
import { numberTabStrips } from "../renderer/tab-numbers.mjs";
import { reserveKey, whenKeyFree } from "../renderer/tab-keys.mjs";
import { resolveTerminalOpen, terminalKey } from "../renderer/instance-tree-view.mjs";
import { createWorkspaceTabMemory } from "../renderer/workspace-tab-memory.mjs";
import { projectSplitDom } from "../renderer/split-dom.mjs";
import { getBinding, formatChord } from "../renderer/keybindings.mjs";
import { splitControlsState } from "../renderer/split-controls.mjs";
import { instanceSplitPlan, instanceSplitIdentity } from "../renderer/instance-split.mjs";
import { sameInstanceActionTarget } from "../renderer/instance-action-target.mjs";
import * as layout from "../renderer/split-layout.mjs";
import * as workspaceTabs from "../renderer/workspace-tabs.mjs";
import { canAddressRemote, rowReason } from "../../client/remote-address.mjs";
import { revealInStrip, revealInScrollport } from "../renderer/reveal-in-scrollport.mjs";
import { tabShowsRow } from "../renderer/retired-tabs.mjs";
import { instanceId, rosterParentId } from "../../client/instance-tree.mjs";
import { describeLayout, composeLayout, validLayout } from "../renderer/layout-handover.mjs";
import { takenWorkspaceIds } from "../renderer/views/common.mjs";
import { navTab } from "../renderer/shell-nav.mjs";
import { createFocusRegions, firstTabbable, isShown } from "../renderer/focus-regions.mjs";
import { createFocusPlaces, isTransit } from "../renderer/focus-place.mjs";
import { createWorkspaceSwitcher } from "../renderer/workspace-switcher.mjs";
import { mountAutomationsPage } from "../renderer/views/automations.mjs";
import { setWorkspace, onWorkspaceChange } from "../renderer/views/common.mjs";

const source = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
const tick = () => new Promise(setImmediate);
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const instance = name => ({ instance: name, running: true, home: `/synthetic/${name}`, agentsRoot: "/synthetic/agents",
  tmux: { session: "synthetic-only", window: name } });
const ref = name => ({ instance: name, home: `/synthetic/${name}`, agentsRoot: "/synthetic/agents" });
const SERVED = [{ id: "A", name: "a" }, { id: "B", name: "b" }];

function shell(t) {
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const document = dom.window.document, requests = [], attachments = [], terms = [], log = [];
  // The list of workspaces as workspace-switcher.mjs draws it: one row per workspace, the current one the stop.
  document.getElementById("ws-options").innerHTML = `<ul class="ws-group">${["A", "B", "C"].map(id =>
    `<li class="ws-option-row"><button type="button" class="ws-option" data-workspace-id="${id}" tabindex="${id === "A" ? 0 : -1}">${id}</button></li>`).join("")}</ul>`;
  document.getElementById("nav").innerHTML = `<button class="nav-item" data-view="spawn">Workspace</button><button class="nav-item" data-view="automations" aria-current="page">Automations</button>`;
  document.getElementById("stagehost").innerHTML = `<div><button id="page-control">Page control</button><button id="page-other">Other</button></div>`;
  const c = {
    document, window: dom.window, canAddressRemote, rowReason, navigator: { platform: "Linux" },
    warned: [], console: { ...console, warn: message => c.warned.push(message) },
    describeLayout, composeLayout, validLayout, takenWorkspaceIds,
    getBinding, formatChord, stableFocusTarget: () => null,
    connectionGeneration: 0, subscribeConnections: () => () => {},
    workspace: "A", generation: 0, tabWorkspace: "A", contextWorkspace: "A",
    tabs: new Map(), nextTabId: 1, activeTab: null, split: null, sidebarMode: "instances", tabLayerVisible: false,
    contextRosterGen: 0, contextInstances: [],
    instanceRecency: createInstanceRecency({ storage: null }), recencyIdFromTerminalKey,
    wsActiveTerminal: new Map(), pendingTerms: new Set(),
    rosterState: null, rosterStale: false, contextDeploymentNote: null, ...viewContext(), rosterSignaturePainted: null,
    tabbar: document.getElementById("tabbar"), tabhost: document.getElementById("tabhost"),
    tabActionsEl: document.getElementById("tab-actions"), contextRosterEl: document.getElementById("instance-roster"),
    stageHost: document.getElementById("stagehost"), stage: { name: "automations" }, navEl: document.getElementById("nav"),
    NAV: [{ name: "automations" }], navTab, stageSidebarMode: () => "overview",
    brainIntents: createIntentGate(), workspaceTabMemory: createWorkspaceTabMemory(), workspaceLabel: { reset() {} },
    currentWorkspace: () => c.workspace, workspaceGeneration: () => c.generation,
    updateActiveContexts: on => { c.tabLayerVisible = on; },
    refreshContextRoster() {}, renderContextRoster() {}, setNavActive() {},
    syncContextPanel() {}, refreshPanelInstance() {}, contextPanel: { setFocusMode() {} },
    focusRoster() { c.tabOpenIntents.invalidate(); c.rosterEntry()?.focus(); },
    tabShowsRow, instanceId, rosterParentId, revealInScrollport,
    api(path) { const gate = { ...deferred(), path }; requests.push(gate); return gate.promise; },
    updateSidebarControls() {},
    resolveTerminalOpen, terminalKey, reserveKey, whenKeyFree, wirePaneSelection, createTabChrome, tabKeyAction, focusAfterLastTab, tabNameTailStart, setTabTitle,
    splitControlsState, instanceSplitPlan, instanceSplitIdentity, sameInstanceActionTarget, ...layout, ...workspaceTabs, projectSplitDom,
    terminalOptions, wireTerminalSelection: () => () => {}, fitTerminal, createGlyphRenderer, terminalTypography: () => ({ fontSize: 13, fontFamily: "mono" }), xtermTheme: () => ({}), terminalFontWeight: () => 400,
    onThemeChange: () => () => {}, onTerminalTypographyChange: () => () => {}, requestAnimationFrame: fn => fn(),
    FitAddon: { FitAddon: class { fit() {} } },
    createTerminalTab: options => createTerminalTab({ ...options, observe: () => () => {} }),
    Terminal: class {
      parser = { registerOscHandler: () => ({ dispose() {} }) };
      constructor() { this.cols = 80; this.rows = 24; this.focuses = 0; terms.push(this); }
      loadAddon() {} onData() {} onResize() {} attachCustomKeyEventHandler() {} write() {}
      open(wrap) { this.input = document.createElement("textarea"); this.input.className = "xterm-helper-textarea"; wrap.append(this.input); }
      focus() { this.focuses++; this.input.focus(); }
      dispose() {}
    },
    desk: {
      termOpen(spec) { const gate = { ...deferred(), spec }; attachments.push(gate); return gate.promise.then(({ id }) => opened(id)); },
      termReady: terminalReady,
      termClose(h) { return confirmed(h); }, termResize() {}, termWrite() {},
      onTermData: () => () => {}, onTermExit: () => () => {},
    },
    registerAction() {},
    modalOpen: () => [...document.querySelectorAll('[aria-modal="true"]')].some(dialog => isShown(dialog)),
    isShown, firstTabbable, isTransit,
    // views/common.mjs landsFocusPlace: a landing on `unplaced` places nothing (a caller's own target, a step from the
    // list of workspaces, a view followed, a take-over's layout).
    unplaced: null, landsFocusPlace: ws => c.unplaced !== ws,
    // spawn-follow.mjs watchOperator: the operator's keys and clicks, counted by the test.
    inputs: 0, pointers: 0, operator: { input: () => c.inputs, pointer: () => c.pointers },
    answerResult: { ok: true },
    desktopBridge: { async windowReleaseAnswer(request, payload) { log.push(["answer", request, payload]); return c.answerResult; } },
    async leaveTakenWorkspace(workspace, workspaces) {
      const taken = takenWorkspaceIds(workspace, workspaces);
      log.push(["leave", workspace]);
      await tick();
      if (taken.has(c.workspace)) { c.workspace = c.leaveTo; c.generation++; s.restoreWorkspaceTabs(); }
    },
    leaveTo: "B",
  };
  c.tabOpenIntents = createSelectionOwnership(c);
  c.revealInStrip = revealInStrip; c.tabStripResize = null; c.numberTabStrips = numberTabStrips; c.tabNumberObserver = null;
  c.splitOpenState = () => ({ split: c.split, activeId: c.activeTab, tabs: c.tabs, workspace: c.workspace, visible: c.tabLayerVisible });
  // The shell's composition (shell.mjs, after createFocusRegions): the shipped regions and places, and the tracker.
  c.focusRegions = createFocusRegions({ doc: document, tabLayerVisible: () => c.tabLayerVisible, focusMainContent: () => s.focusMainContent() });
  c.focusPlaces = createFocusPlaces({ doc: document, regionOfFocus: () => c.focusRegions.regionOfFocus(),
    activeTab: () => (c.tabLayerVisible && c.activeTab != null && c.tabs.has(c.activeTab) ? { id: c.activeTab, paneEl: c.tabs.get(c.activeTab).paneEl } : null) });
  document.addEventListener("focusin", () => c.focusPlaces.note(c.tabWorkspace));
  c.rosterPlace = null; c.pageWatch = null;
  c.queueMicrotask = queueMicrotask; c.MutationObserver = dom.window.MutationObserver;
  // initContextRoster's: a native focus entry into the sidebar is a newer intent, unless the shell restores it.
  document.getElementById("sidebar").addEventListener("focusin", () => { if (!c.tabOpenIntents.isApplyingFocus()) c.tabOpenIntents.invalidate(); });
  const names = ["setSidebarMode", "updateContextTabs", "showTabLayer", "closeStage", "showStage", "renderSplit", "selectEmptyGroup", "splitPane", "closeSplit", "restoreTerminalGroups",
    "updateSplitControls", "onTabKeydown", "walkedTabs", "visibleTabEntries", "addTab", "selectTab", "activateTab", "revealActiveRosterRow", "closeTab", "tabStrips", "revealActiveTabs", "observeTabStrips", "showTerminalContext",
    "openTerminalTabFlow", "openTerminalTabInner", "restoreWorkspaceTabs", "focusActiveTerminal", "syncTabNeedsInput", "focusGroup",
    "releaseTakenWorkspace", "closeWorkspaceTabs", "restoreHandedLayout", "rosterEntry", "setRovingRow",
    "focusMainContent", "focusOn", "focusArrival", "applyRosterPlace", "watchPage", "focusLost"];
  const functions = names.map(name => {
    const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
    assert.ok(match, `execute shipped ${name}`); return match[0];
  });
  const s = runInNewContext(`${functions.join("\n")}\n({ ${names.join(", ")} });`, withShellWindowGlobals(c));
  const row = id => document.querySelector(`#ws-options [data-workspace-id="${id}"]`);
  return {
    ...s, c, document, requests, attachments, terms, log,
    async open(name) {
      const done = s.openTerminalTabFlow(name, message => assert.fail(message));
      requests.at(-1).resolve({ instances: [instance(name)] }); await tick();
      attachments.at(-1).resolve({ id: attachments.length });
      await done; await settle();
      return { id: c.activeTab, term: terms.at(-1) };
    },
    /** A file tab with a control in its content (a viewer's link). */
    file(name) {
      const made = s.addTab({ title: name, key: JSON.stringify([c.workspace, `file:/${name}`]), kind: "file", onClose() {} });
      const link = document.createElement("a"); link.href = "#"; link.textContent = `${name} link`; link.id = `link-${name}`;
      made.paneEl.append(link);
      return { id: made.id, link };
    },
    row,
    /** Main bound the switch, and it lands: the shell's workspace listener runs, then every other one (a page landing
     * waits for them: focusArrival's watchPage). */
    async land(workspace) { c.workspace = workspace; c.generation++; s.restoreWorkspaceTabs(); await settle(); },
    /** A pick from the list of workspaces: the focus goes to its row first (a click or Enter there), then the switch. */
    async pick(workspace) { row(workspace).focus(); await this.land(workspace); },
    /** The roster's rows, painted as renderContextRoster paints them (nodes replaced), then its paint hook. */
    paintRoster(ids, { stop = ids[0] } = {}) {
      document.querySelector("#instance-roster .ctx-list").innerHTML = ids.map(id =>
        `<div class="ctx-tree-row"><button class="ctx-inst" data-tree-instance="${id}" data-tree-control="terminal" tabindex="${id === stop ? 0 : -1}">${id}</button></div>`).join("");
      s.applyRosterPlace();
    },
    active: () => document.activeElement,
  };
}

const body = s => s.document.body;

test("focus places: transit surfaces are never a place; the tab layer, the roster and the rest are described", t => {
  const s = shell(t), { document } = s;
  for (const el of [s.row("B"), document.getElementById("ws-add-open")]) {
    assert.equal(isTransit(el), true, `${el.id || el.textContent} is a transit surface`);
  }
  const dialog = document.createElement("div"); dialog.setAttribute("role", "dialog"); dialog.innerHTML = "<button>ok</button>";
  const menu = document.createElement("div"); menu.setAttribute("role", "menu"); menu.innerHTML = "<button>item</button>";
  const palette = document.createElement("div"); palette.className = "palette-overlay"; palette.innerHTML = "<input>";
  document.body.append(dialog, menu, palette);
  for (const el of [dialog.firstChild, menu.firstChild, palette.firstChild]) assert.equal(isTransit(el), true);
  assert.equal(isTransit(document.getElementById("page-control")), false);
  document.getElementById("page-control").focus();
  assert.deepEqual({ ...s.c.focusPlaces.describe(), handle: undefined }, { kind: "other", region: "main", handle: undefined });
  document.querySelector("#nav .nav-item").focus();
  assert.equal(s.c.focusPlaces.describe().region, "views");
  document.getElementById("sidebar-help").focus();
  assert.equal(s.c.focusPlaces.describe().region, null, "the foot is no region");
  s.row("A").focus();
  assert.equal(s.c.focusPlaces.describe(), null, "the list of workspaces: none");
  assert.equal(s.c.focusPlaces.take("A").region, null, "leaving from the list: the last focus outside it (the foot)");
  assert.equal(s.c.focusPlaces.take("B"), null, "never another workspace's");
});

test("a terminal place: focus in X's terminal, a pick of B from the list, a pick of A: X's input has the focus, no click", async t => {
  const s = shell(t);
  const x = await s.open("x");
  const y = await s.open("y");
  s.c.tabOpenIntents.begin(); assert.ok(s.selectTab(x.id, { focusContent: true }));
  assert.equal(s.active(), x.term.input, "typing in X");
  await s.pick("B");
  assert.equal(s.active(), s.row("B"), "a first visit to B: the pick keeps the list row");
  await s.pick("A");
  assert.equal(s.c.activeTab, x.id);
  assert.equal(s.active(), x.term.input, "X's terminal is ready to type");
  assert.notEqual(s.active(), y.term.input);
});

test("a terminal place through the moves: workspace.next from the terminal, then workspace.previous from wherever B left it", async t => {
  const s = shell(t);
  const x = await s.open("x");
  s.c.tabOpenIntents.begin(); s.selectTab(x.id, { focusContent: true });
  await s.land("B"); // Alt+↓ from X's terminal: the focus is still there as the switch lands
  assert.notEqual(s.active(), body(s), "never <body>");
  assert.equal(s.active(), s.document.getElementById("page-control"), "a first visit, its terminal hidden: main's landing (the stage's first control)");
  s.document.getElementById("page-other").focus(); // the operator moves on in B
  await s.land("A"); // Alt+↑
  assert.equal(s.active(), x.term.input);
  await s.land("B"); // Alt+↓ again
  assert.equal(s.active(), s.document.getElementById("page-other"), "B's place: where the operator left it");
  await s.land("A");
  assert.equal(s.active(), x.term.input);
});

test("a step made from the list of workspaces (it places nothing) leaves the focus on the list", async t => {
  const s = shell(t);
  const x = await s.open("x");
  s.c.tabOpenIntents.begin(); s.selectTab(x.id, { focusContent: true });
  const focuses = x.term.focuses;
  s.row("A").focus();
  s.c.unplaced = "B"; await s.land("B"); s.c.unplaced = null;
  assert.equal(s.active(), s.row("A"), "the operator is browsing workspaces");
  s.c.unplaced = "A"; await s.land("A"); s.c.unplaced = null;
  assert.equal(s.active(), s.row("A"));
  assert.equal(x.term.focuses, focuses, "X's terminal was not focused again");
  // The shell asks for it only from the list (shell.mjs leaderDispatch's workspaceStep), and the switcher hands it on.
  assert.match(source, /workspaceStep: delta => workspaceLabel\.step\(delta, \{ focusPlace: focusRegions\.regionOfFocus\(\) !== "workspaces" \}\)/);
  assert.match(source, /selectWorkspace: \(id, how\) => switchWorkspace\(id, \{ \.\.\.how, takeOver: true \}\)/);
});

test("a file tab place, a tab strip place and an empty split group place", async t => {
  const s = shell(t);
  const x = await s.open("x");
  const notes = s.file("notes.md");
  s.c.tabOpenIntents.begin(); s.selectTab(notes.id); notes.link.focus();
  await s.pick("B"); await s.pick("A");
  assert.equal(s.c.activeTab, notes.id);
  assert.equal(s.active(), notes.link, "the control it had in the file's content");
  s.c.tabs.get(notes.id).triggerEl.focus();
  await s.pick("B"); await s.pick("A");
  assert.equal(s.active(), s.c.tabs.get(notes.id).triggerEl, "the tab in the strip");
  // An empty split group, focused as today's restore makes it.
  s.c.tabOpenIntents.begin(); s.selectTab(x.id);
  s.splitPane("row");
  const empty = s.c.tabhost.querySelector(".focused-group > .split-empty");
  assert.ok(empty); empty.focus();
  await s.pick("B"); await s.pick("A");
  assert.equal(s.active(), s.c.tabhost.querySelector(".focused-group > .split-empty"), "the empty group");
});

test("a page control by identity (the page repainted it), else its region's landing; the views nav", async t => {
  const s = shell(t), { document } = s;
  document.getElementById("page-other").focus();
  await s.pick("B");
  // B's page repaints (a view's workspace listener): the control comes back as a new node with its id.
  document.getElementById("stagehost").innerHTML = `<div><button id="page-control">Page control</button><button id="page-other">Other</button></div>`;
  await s.pick("A");
  assert.equal(s.active(), document.getElementById("page-other"), "the control, by id");
  document.getElementById("stagehost").innerHTML = `<div><button id="new-page">Another page</button></div>`;
  await s.pick("B"); await s.pick("A");
  assert.equal(s.active(), document.getElementById("new-page"), "W shows another page now: main's landing");
  const nav = document.querySelector('#nav [data-view="spawn"]');
  nav.focus();
  await s.pick("B"); await s.pick("A");
  assert.equal(s.active(), nav, "the views nav item");
});

test("the remembered tab closed while A was hidden: the focus goes into the recalled active tab; with no tab left, main's landing", async t => {
  const s = shell(t);
  const x = await s.open("x");
  const y = await s.open("y");
  s.c.tabOpenIntents.begin(); s.selectTab(y.id, { focusContent: true });
  await s.pick("B");
  s.closeTab(y.id, false, { explicit: false, background: true }); // A's roster read showed it retired
  await settle();
  assert.equal(s.c.tabs.has(y.id), false);
  await s.pick("A");
  assert.equal(s.c.activeTab, x.id, "the tab rules' successor");
  assert.equal(s.active(), x.term.input, "its content has the focus");
  await s.pick("B");
  s.closeTab(x.id, false, { explicit: false, background: true });
  await settle();
  await s.pick("A");
  assert.equal(s.c.tabLayerVisible, false, "no tab left: the stage");
  assert.equal(s.active(), s.document.getElementById("page-control"), "main's landing, never <body>");
});

test("no place: a first visit from a pick keeps the list row; one from a terminal lands on main", async t => {
  const s = shell(t);
  await s.pick("B");
  assert.equal(s.active(), s.row("B"));
  const b = await s.open("b");
  s.c.tabOpenIntents.begin(); s.selectTab(b.id, { focusContent: true });
  await s.land("C");
  assert.equal(s.active(), s.document.getElementById("page-control"));
});

test("a switch that places nothing for a caller's own target (handOff, followView): nothing moves", async t => {
  const s = shell(t);
  const x = await s.open("x");
  s.c.tabOpenIntents.begin(); s.selectTab(x.id, { focusContent: true });
  await s.pick("B");
  const focuses = x.term.focuses;
  const target = s.document.getElementById("page-other"); target.focus(); // the caller's own target (the Teams board's show)
  s.c.unplaced = "A"; await s.land("A"); s.c.unplaced = null;
  assert.equal(s.active(), target, "the caller's target wins");
  assert.equal(x.term.focuses, focuses, "X's terminal is not focused");
  const spawn = readFileSync(new URL("../renderer/views/spawn.mjs", import.meta.url), "utf8");
  assert.match(spawn, /switchWorkspace\(workspace, \{ takeOver: true, focusPlace: false \}\)/, "handOff places nothing");
  assert.match(source, /switchWorkspace\(id, \{ focus: false, focusPlace: false \}\)/, "followView places nothing");
});

test("under a modal dialog or the palette, an arrival moves nothing: their own return owns the focus", async t => {
  const s = shell(t);
  const x = await s.open("x");
  s.c.tabOpenIntents.begin(); s.selectTab(x.id, { focusContent: true });
  await s.pick("B");
  const dialog = s.document.createElement("div"); dialog.setAttribute("aria-modal", "true"); dialog.innerHTML = "<button>Close</button>";
  s.document.body.append(dialog); dialog.firstChild.focus();
  await s.land("A");
  assert.equal(s.active(), dialog.firstChild);
});

test("a roster place: applied by the first paint of A's rows, by the instance's identity (the rows are new nodes)", async t => {
  const s = shell(t);
  s.paintRoster(["/synthetic/r1", "/synthetic/r2"]);
  s.document.querySelector('[data-tree-instance="/synthetic/r2"]').focus();
  await s.pick("B");
  s.paintRoster(["/synthetic/b1"]);
  assert.equal(s.active(), s.row("B"), "B's paint: B has no place");
  await s.pick("A");
  assert.equal(s.active(), s.row("A"), "not before A's roster is painted");
  s.paintRoster(["/synthetic/r1", "/synthetic/r2"]);
  const r2 = s.document.querySelector('[data-tree-instance="/synthetic/r2"]');
  assert.equal(s.active(), r2, "that instance's row");
  assert.equal(r2.tabIndex, 0, "the roster's tab stop follows it");
  assert.equal(s.document.querySelector('[data-tree-instance="/synthetic/r1"]').tabIndex, -1);
  s.paintRoster(["/synthetic/r1", "/synthetic/r2"]);
  assert.equal(s.c.rosterPlace, null, "once: a later paint applies nothing");
});

test("a roster place is not applied once the operator acted, a selection was made or the workspace changed meanwhile", async t => {
  for (const meanwhile of [
    s => { s.c.inputs++; }, // a key
    s => { s.c.pointers++; s.document.getElementById("page-control").focus(); }, // a click that moved the focus
    s => { s.c.tabOpenIntents.begin(); }, // a selection, an open
    s => { void s.land("C"); }, // another switch
  ]) {
    const s = shell(t);
    s.paintRoster(["/synthetic/r1"]);
    s.document.querySelector(".ctx-inst").focus();
    await s.pick("B"); await s.pick("A");
    meanwhile(s);
    const before = s.active();
    s.paintRoster(["/synthetic/r1"]);
    assert.equal(s.active(), before, "where the operator is, the focus stays");
  }
  const clicked = shell(t);
  clicked.paintRoster(["/synthetic/r1"]);
  clicked.document.querySelector(".ctx-inst").focus();
  await clicked.pick("B"); await clicked.pick("A");
  clicked.c.pointers++; // a click that moved nothing
  clicked.paintRoster(["/synthetic/r1"]);
  assert.equal(clicked.active(), clicked.document.querySelector(".ctx-inst"), "a click that left the focus where it was cancels nothing");
});

test("a roster place whose instance is gone: the roster's landing; hidden sidebar or focus mode: main", async t => {
  const s = shell(t);
  s.paintRoster(["/synthetic/r1", "/synthetic/r2"]);
  s.document.querySelector('[data-tree-instance="/synthetic/r2"]').focus();
  await s.pick("B"); await s.pick("A");
  s.paintRoster(["/synthetic/r1", "/synthetic/r3"], { stop: "/synthetic/r3" });
  assert.equal(s.active(), s.document.querySelector('[data-tree-instance="/synthetic/r3"]'), "its selected row (the tab stop)");
  // A failed read: the failed block's Retry is the roster's landing.
  await s.pick("B"); await s.pick("A");
  s.document.querySelector("#instance-roster .ctx-list").innerHTML = "";
  const retry = s.document.createElement("button"); retry.textContent = "Retry"; s.document.querySelector("#instance-roster .ctx-list").append(retry);
  s.applyRosterPlace();
  assert.equal(s.active(), retry);
  for (const hide of ["sidebar-hidden", "focus-mode"]) {
    const h = shell(t);
    h.paintRoster(["/synthetic/r1"]);
    h.document.querySelector(".ctx-inst").focus();
    await h.pick("B");
    h.document.getElementById("app").classList.add(hide);
    await h.land("A");
    assert.equal(h.active(), h.document.getElementById("page-control"), `${hide}: main, and it is not left for it`);
    assert.equal(h.document.getElementById("app").classList.contains(hide), true);
    assert.equal(h.c.rosterPlace, null);
  }
});

test("a take-over arrival: the handed layout's active terminal has the focus, and no remembered place is applied", async t => {
  const s = shell(t);
  s.document.getElementById("page-other").focus(); // A's stale place in this window
  await s.pick("B");
  s.row("A").focus();
  s.c.unplaced = "A"; await s.land("A"); s.c.unplaced = null; // views/common.mjs: a take-over that brought a layout places nothing
  assert.equal(s.active(), s.row("A"), "the place is not applied");
  const done = s.restoreHandedLayout("A", { terminals: [ref("a1"), ref("a2")], split: null, active: 1 });
  await tick();
  s.requests.at(-1).resolve({ instances: [instance("a1"), instance("a2")] });
  for (let answered = 0; answered < 2;) { await tick(); while (answered < s.attachments.length) s.attachments[answered].resolve({ id: 100 + answered++ }); }
  await done; await settle();
  assert.equal(s.active(), s.terms[1].input, "the handed active terminal (restoreHandedLayout's selectTab, focusContent)");
});

test("the window that fell back after a take-over focuses its own place for the workspace it shows now", async t => {
  const s = shell(t);
  await s.pick("B");
  const b = await s.open("b1");
  s.c.tabOpenIntents.begin(); s.selectTab(b.id, { focusContent: true });
  await s.pick("A");
  await s.open("a1"); // typing in A when another window takes it over
  await s.releaseTakenWorkspace({ request: 1, workspace: "A", workspaces: SERVED });
  await settle();
  assert.equal(s.c.workspace, "B");
  assert.equal(s.active(), b.term.input, "B's place: its terminal (the DOM focus only; the leave claims nothing)");
  assert.equal(s.c.workspaceTabMemory.recall("A", s.c.tabs).place, undefined, "A's place is forgotten with its layout");
});

test("rapid steps: each landing applies its own place, the last one wins", async t => {
  const s = shell(t);
  const a = await s.open("a");
  s.c.tabOpenIntents.begin(); s.selectTab(a.id, { focusContent: true });
  await s.land("B");
  const b = await s.open("b");
  s.c.tabOpenIntents.begin(); s.selectTab(b.id, { focusContent: true });
  await s.land("C");
  await s.land("B"); await s.land("A");
  assert.equal(s.active(), a.term.input);
  await s.land("B");
  assert.equal(s.active(), b.term.input);
});

test("a roster place survives the list of workspaces' own repaint as the roster's answer lands (no new intent)", async t => {
  const s = shell(t);
  // The real list, wired as the shell wires it: its repaint keeps the focus on the row that had it, as a restoration.
  const list = createWorkspaceSwitcher({ document: s.document, selectWorkspace() {}, applyFocus: fn => s.c.tabOpenIntents.applyFocus(fn) });
  t.after(() => list.dispose());
  list.begin()(SERVED[0], SERVED);
  s.paintRoster(["/synthetic/r1", "/synthetic/r2"]);
  s.document.querySelector('[data-tree-instance="/synthetic/r2"]').focus();
  s.document.querySelector('#ws-options [data-workspace-id="B"]').focus(); s.c.workspace = "B"; s.c.generation++; s.restoreWorkspaceTabs();
  s.paintRoster(["/synthetic/b1"]);
  s.document.querySelector('#ws-options [data-workspace-id="A"]').focus(); s.c.workspace = "A"; s.c.generation++; s.restoreWorkspaceTabs();
  assert.ok(s.c.rosterPlace?.owns(), "waiting for A's roster");
  list.begin()(SERVED[0], SERVED); // refreshContextRoster commits the list before it paints the rows
  assert.ok(s.c.rosterPlace.owns(), "the list's repaint is no new intent");
  s.paintRoster(["/synthetic/r1", "/synthetic/r2"]);
  assert.equal(s.active(), s.document.querySelector('[data-tree-instance="/synthetic/r2"]'));
  // An operator's own move in the list is one: it still cancels.
  s.paintRoster(["/synthetic/r1", "/synthetic/r2"]);
  s.document.querySelector('#ws-options [data-workspace-id="B"]').focus(); s.c.workspace = "B"; s.c.generation++; s.restoreWorkspaceTabs();
  s.document.querySelector('#ws-options [data-workspace-id="A"]').focus(); s.c.workspace = "A"; s.c.generation++; s.restoreWorkspaceTabs();
  s.document.querySelector('#ws-options [data-workspace-id="B"]').focus(); // the operator moves in the list
  s.paintRoster(["/synthetic/r1", "/synthetic/r2"]);
  assert.equal(s.active(), s.document.querySelector('#ws-options [data-workspace-id="B"]'));
});

test("a page place on a mounted page that rebuilds for the workspace in its own listener (after the shell's): applied after it", async t => {
  const s = shell(t);
  setWorkspace("A");
  const off = onWorkspaceChange(ws => { s.c.workspace = ws; s.c.generation++; s.restoreWorkspaceTabs(); }); // the shell's listener, first
  t.after(off);
  s.document.getElementById("stagehost").replaceChildren();
  const page = mountAutomationsPage(s.document.getElementById("stagehost"), { api: async () => ({ status: "ok", result: { triggers: [], schedules: [] } }) },
    "trigger", undefined, { cli: () => ({ ok: true, features: ["automations"], automationsApi: 1 }), subscribeCli: () => () => {} });
  t.after(() => page.dispose());
  await settle();
  const refresh = () => s.document.querySelector(".auto-header button");
  assert.ok(refresh(), "the real Automations page's Refresh");
  const before = refresh();
  before.focus();
  s.row("B").focus(); setWorkspace("B"); await settle();
  s.row("A").focus(); setWorkspace("A"); await settle();
  assert.notEqual(refresh(), before, "the page rebuilt itself for A");
  assert.notEqual(s.active(), s.document.body, "never <body>");
  assert.ok(s.document.getElementById("stagehost").contains(s.active()), "the page's control (else its first one)");
  assert.equal(s.active().textContent, refresh().textContent, "its Refresh, drawn again for A");
});

test("no place (a first visit) from a control of a page that rebuilds for the workspace: main's landing, never <body>; a pick keeps its row", async t => {
  const s = shell(t);
  setWorkspace("A");
  const off = onWorkspaceChange(ws => { s.c.workspace = ws; s.c.generation++; s.restoreWorkspaceTabs(); });
  t.after(off);
  s.document.getElementById("stagehost").replaceChildren();
  const page = mountAutomationsPage(s.document.getElementById("stagehost"), { api: async () => ({ status: "ok", result: { triggers: [], schedules: [] } }) },
    "trigger", undefined, { cli: () => ({ ok: true, features: ["automations"], automationsApi: 1 }), subscribeCli: () => () => {} });
  t.after(() => page.dispose());
  await settle();
  const before = s.document.querySelector(".auto-header button");
  before.focus();
  setWorkspace("B"); await settle(); // workspace.next from the page: B was never shown here
  assert.equal(before.isConnected, false, "the page rebuilt itself for B");
  assert.notEqual(s.active(), s.document.body, "never <body>");
  assert.ok(s.document.getElementById("stagehost").contains(s.active()), "main's landing: the page's first control");
  s.row("C").focus(); setWorkspace("C"); await settle(); // a pick of a first visit
  assert.equal(s.active(), s.row("C"), "the list row it was picked from, still shown");
});

test("a page landing is applied again when a later repaint of the page drops the focus, until the operator acts", async t => {
  const s = shell(t);
  s.document.getElementById("page-other").focus();
  await s.pick("B"); await s.pick("A");
  assert.equal(s.active(), s.document.getElementById("page-other"));
  // The page's read answers: its content is drawn again (the focused node goes).
  s.document.getElementById("stagehost").innerHTML = `<div><button id="page-control">Page control</button><button id="page-other">Other</button></div>`;
  await settle();
  assert.equal(s.active(), s.document.getElementById("page-other"), "back on the control, by identity");
  s.c.inputs++; // a key: the operator has moved on
  s.document.getElementById("stagehost").innerHTML = `<div><button id="page-control">Page control</button><button id="page-other">Other</button></div>`;
  await settle();
  assert.notEqual(s.active(), s.document.getElementById("page-other"), "after the operator acted, no repaint moves the focus");
});

test("a terminal whose session ended while A was hidden: its tab is selected and its tab has the focus; nothing reaches its input", async t => {
  const s = shell(t);
  let exit;
  s.c.desk.onTermExit = (h, fn) => { exit = () => fn({ handle: h, exitCode: 0 }); return () => {}; };
  const x = await s.open("x");
  s.c.tabOpenIntents.begin(); s.selectTab(x.id, { focusContent: true });
  await s.pick("B");
  exit(); await settle();
  await s.pick("A");
  assert.equal(s.c.activeTab, x.id, "its tab is selected");
  assert.equal(s.active(), s.c.tabs.get(x.id).triggerEl, "its tab has the focus, not the list");
  assert.notEqual(s.active(), x.term.input, "the ended terminal takes no input focus (terminal-tab.mjs)");
});
