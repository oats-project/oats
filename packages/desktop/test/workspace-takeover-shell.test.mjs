// A take-over in the shell, both sides. The holder (another window took its workspace over, main's
// window:release-workspace): the shipped releaseTakenWorkspace answers main first, with the layout it shows of
// the workspace (layout-handover.mjs describeLayout: its terminals and split), then leaves the workspace
// (views/common.mjs leaveTakenWorkspace, faked here: it is pinned by window-workspace.test.mjs), then closes
// every tab of it through the shipped background close (a terminal's through its own teardown, its viewer
// detached) and forgets its layout. Tabs of other workspaces stay. The window that took it: the shipped
// restoreHandedLayout opens the handed terminals again, in order, and lays them out (composeLayout), under one
// intent that a selection, a switch or a new connection ends. Real shipped shell close/select/open and terminal
// lifecycle (the harness of retired-tabs-shell.test.mjs); only xterm, IPC and panel answers are synthetic.
import test from "node:test";
import { createInstanceRecency, recencyIdFromTerminalKey } from "../renderer/instance-recency.mjs";
import { viewContext } from "./helpers/view-context.mjs";
import assert from "node:assert/strict";
import { opened, confirmed, ready as terminalReady } from './helpers/terminal-wire.mjs';
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { withShellWindowGlobals } from './helpers/shell-window-globals.mjs';
import { JSDOM } from "jsdom";
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
import { instanceSplitPlan, instanceSplitIdentity } from '../renderer/instance-split.mjs';
import { sameInstanceActionTarget } from '../renderer/instance-action-target.mjs';
import * as layout from "../renderer/split-layout.mjs";
import * as workspaceTabs from "../renderer/workspace-tabs.mjs";
import { canAddressRemote, rowReason } from "../../client/remote-address.mjs";
import { revealInStrip, revealInScrollport } from "../renderer/reveal-in-scrollport.mjs";
import { tabShowsRow } from "../renderer/retired-tabs.mjs";
import { instanceId, rosterParentId } from "../../client/instance-tree.mjs";
import { describeLayout, composeLayout, validLayout } from "../renderer/layout-handover.mjs";
import { takenWorkspaceIds } from "../renderer/views/common.mjs";
import { navTab } from "../renderer/shell-nav.mjs";

const source = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
const tick = () => new Promise(setImmediate);
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const instance = name => ({ instance: name, running: true, home: `/synthetic/${name}`, agentsRoot: "/synthetic/agents",
  tmux: { session: "synthetic-only", window: name } });
const SERVED = [{ id: "A", name: "a" }, { id: "B", name: "b" }];

function shell(t) {
  const dom = new JSDOM(`<div id="app"><span id="ws-context"></span><div id="stagehost"></div><div id="tabstrip"><div id="tabbar-row"><div id="tabbar"></div>
    <div id="tab-actions"><button id="split-right"></button><button id="split-down"></button></div>
    </div></div><div id="tabhost"></div><aside id="roster"><div class="ctx-head"><span>Instances</span><span class="ctx-count"></span></div><div class="ctx-list"></div></aside>
    <nav id="nav"><button class="nav-item active">Overview</button></nav></div>`);
  t.after(() => dom.window.close());
  const document = dom.window.document, requests = [], attachments = [], terms = [], detached = [], log = [];
  const c = {
    document, window: dom.window, canAddressRemote, rowReason, navigator: { platform: "MacIntel" },
    // A restore's quiet notes (a terminal left out) are recorded, not printed.
    warned: [], console: { ...console, warn: message => c.warned.push(message) },
    describeLayout, composeLayout, validLayout, takenWorkspaceIds,
    getBinding, formatChord, stableFocusTarget: () => null,
    connectionGeneration: 0, subscribeConnections: () => () => {},
    workspace: "A", generation: 0, tabWorkspace: "A", contextWorkspace: "A",
    tabs: new Map(), nextTabId: 1, activeTab: null, split: null, sidebarMode: "instances", tabLayerVisible: false,
    contextRosterGen: 0, contextInstances: [],
    // The palette's last-focus record (Spec C), inert here: the shell code under test writes to it.
    instanceRecency: createInstanceRecency({ storage: null }), recencyIdFromTerminalKey,
    wsActiveTerminal: new Map(), pendingTerms: new Set(),
    rosterState: null, rosterStale: false, contextDeploymentNote: null, ...viewContext(), rosterSignaturePainted: null,
    tabbar: document.getElementById("tabbar"), tabhost: document.getElementById("tabhost"),
    tabActionsEl: document.getElementById("tab-actions"), contextRosterEl: document.getElementById("roster"),
    stageHost: document.getElementById("stagehost"), stage: { name: "automations" }, navEl: document.getElementById("nav"),
    // A page of its own (the product owner, 2026-10-26): hierarchy is now a tab of the Workspace page (NAV_TABS).
    NAV: [{ name: "automations" }], navTab /* the shipped NAV_TABS lookup: showStage reads it first */, stageSidebarMode: () => "overview",
    brainIntents: createIntentGate(), workspaceTabMemory: createWorkspaceTabMemory(), workspaceLabel: { reset() {} },
    currentWorkspace: () => c.workspace, workspaceGeneration: () => c.generation,
    updateActiveContexts: on => { c.tabLayerVisible = on; },
    refreshContextRoster() {}, renderContextRoster() {}, setNavActive() {},
    // The instance panel is exercised by retired-tabs-shell.test.mjs; it is inert here.
    syncContextPanel() {}, refreshPanelInstance() {}, contextPanel: { setFocusMode() {} },
    focusRoster() { c.tabOpenIntents.invalidate(); c.rosterEntry()?.focus(); },
    tabShowsRow, instanceId, rosterParentId, revealInScrollport, // the shipped revealActiveRosterRow's
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
      constructor() { this.cols = 80; this.rows = 24; this.focuses = 0; this.disposed = 0; terms.push(this); }
      loadAddon() {} onData() {} onResize() {} attachCustomKeyEventHandler() {} write() {}
      open(wrap) { this.input = document.createElement("textarea"); wrap.append(this.input); }
      focus() { this.focuses++; this.input.focus(); }
      dispose() { this.disposed++; }
    },
    desk: {
      termOpen(spec) { const gate = { ...deferred(), spec }; attachments.push(gate); return gate.promise.then(({ id }) => opened(id)); },
      termReady: terminalReady,
      termClose(h) { detached.push(h.id); log.push(["detach", h.id]); return confirmed(h); }, termResize() {}, termWrite() {},
      onTermData: () => () => {}, onTermExit: () => () => {},
    },
    registerAction() {}, modalOpen: () => false,
    // main's side of the take-over: the answer (refused once main has stopped waiting), and the leave.
    answerResult: { ok: true },
    desktopBridge: { async windowReleaseAnswer(request, payload) { log.push(["answer", request, payload]); return c.answerResult; } },
    async leaveTakenWorkspace(workspace, workspaces) {
      // As views/common.mjs's does: the workspace under any id the served view gives it (a rekeyed deployment id).
      const taken = takenWorkspaceIds(workspace, workspaces);
      log.push(["leave", workspace, workspaces, [...c.tabs.values()].filter(tab => taken.has(tab.workspace)).length]);
      await tick();
      if (taken.has(c.workspace)) { c.workspace = c.leaveTo; c.generation++; s.restoreWorkspaceTabs(); }
    },
    leaveTo: "B",
  };
  c.tabOpenIntents = createSelectionOwnership(c);
  c.revealInStrip = revealInStrip; c.tabStripResize = null; c.numberTabStrips = numberTabStrips; c.tabNumberObserver = null;
  c.splitOpenState = () => ({ split: c.split, activeId: c.activeTab, tabs: c.tabs, workspace: c.workspace, visible: c.tabLayerVisible });
  const names = ["setSidebarMode", "updateContextTabs", "showTabLayer", "showStage", "renderSplit", "selectEmptyGroup", "splitPane", "closeSplit", "restoreTerminalGroups",
    "updateSplitControls", "onTabKeydown", "walkedTabs", "visibleTabEntries", "addTab", "selectTab", "activateTab", "revealActiveRosterRow", "closeTab", "tabStrips", "revealActiveTabs", "observeTabStrips", "showTerminalContext",
    "openTerminalTabFlow", "openTerminalTabInner", "restoreWorkspaceTabs", "focusActiveTerminal", "syncTabNeedsInput", "focusGroup",
    "releaseTakenWorkspace", "closeWorkspaceTabs", "restoreHandedLayout", "rosterEntry"];
  const functions = names.map(name => {
    const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
    assert.ok(match, `execute shipped ${name}`); return match[0];
  });
  const s = runInNewContext(`${functions.join("\n")}\n({ ${names.join(", ")} });`, withShellWindowGlobals(c));
  return {
    ...s, c, document, requests, attachments, terms, detached, log,
    async open(name) {
      const done = s.openTerminalTabFlow(name, message => assert.fail(message));
      requests.at(-1).resolve({ instances: [instance(name)] }); await tick();
      attachments.at(-1).resolve({ id: attachments.length });
      await done;
      return { id: c.activeTab, term: terms.at(-1), handle: attachments.length };
    },
    file(name) {
      const made = s.addTab({ title: name, key: JSON.stringify([c.workspace, `file:/${name}`]), kind: "file", onClose: () => log.push(["file-closed", name]) });
      return made.id;
    },
    switchTo(workspace) { c.workspace = workspace; c.generation++; s.restoreWorkspaceTabs(); },
  };
}

/** Workspace A, shown: terminals a1 and a2 side by side and a file tab; workspace B behind it: terminal b1. */
async function holder(t) {
  const s = shell(t);
  s.switchTo("B");
  const b1 = await s.open("b1");
  s.switchTo("A");
  const a1 = await s.open("a1");
  s.splitPane("row");
  const a2 = await s.open("a2");
  const file = s.file("notes.md");
  s.c.wsActiveTerminal.set("A", s.c.tabs.get(a2.id).key);
  assert.ok(s.c.split, "A has a split layout");
  return { s, a1, a2, b1, file };
}
const plain = value => JSON.parse(JSON.stringify(value)); // the vm's objects, compared by value
const tabsOf = (s, workspace) => [...s.c.tabs.values()].filter(tab => tab.workspace === workspace);

test("a take-over answers main first, then leaves the workspace, then closes every tab of it and forgets its layout", async t => {
  const { s, a1, a2, b1 } = await holder(t);
  s.log.length = 0;
  const shown = describeLayout(s.c.tabs, s.c.split, s.c.activeTab, "A");
  await s.releaseTakenWorkspace({ request: 7, workspace: "A", workspaces: SERVED });
  await settle();
  assert.deepEqual(plain(s.log.slice(0, 2)), [["answer", 7, { layout: shown }], ["leave", "A", SERVED, 3]],
    "the answer, with the layout shown of A, then the leave, while every tab of A is still open");
  assert.deepEqual(shown.terminals.map(ref => ref.instance), ["a1", "a2"], "its terminals only: the file tab does not move");
  assert.deepEqual(plain(shown.split), { orientation: "row", focused: 1, groups: [{ tabs: [0], active: 0 }, { tabs: [1], active: 1 }] }, "and its split");
  assert.deepEqual(s.log.slice(2).map(([kind]) => kind).sort(), ["detach", "detach", "file-closed"], "then the closes");
  assert.deepEqual(tabsOf(s, "A"), [], "no tab of A is left");
  assert.equal(a1.term.disposed, 1); assert.equal(a2.term.disposed, 1, "each terminal's own teardown ran");
  assert.deepEqual(s.detached.sort(), [a1.handle, a2.handle].sort(), "both viewers detached, no other: nothing of A stays attached");
  assert.equal(s.c.wsActiveTerminal.has("A"), false);
  assert.deepEqual(s.c.workspaceTabMemory.recall("A", s.c.tabs), { split: null, activeTab: null, sidebarMode: "overview", tabLayerVisible: false },
    "A's layout is forgotten");
  assert.deepEqual(tabsOf(s, "B").map(tab => tab.title), ["b1"], "B's tab stays");
  assert.equal(b1.term.disposed, 0);
  assert.equal(s.c.workspace, "B");
});

/** A roster row as renderContextRoster paints it (the roster's one roving stop). */
function rosterRowOf(s) {
  s.c.contextRosterEl.querySelector(".ctx-list").innerHTML = `<div class="ctx-tree-row"><button class="ctx-inst" tabindex="0" data-tree-instance="/synthetic/r">r</button></div>`;
  return s.c.contextRosterEl.querySelector(".ctx-inst");
}

test("the background close moves no focus and reopens no layer of the workspace left", async t => {
  const { s } = await holder(t);
  const rosterRow = rosterRowOf(s); // a roster row, where the operator goes
  s.c.leaveTo = "B";
  await s.releaseTakenWorkspace({ request: 1, workspace: "A", workspaces: SERVED });
  rosterRow.focus();
  await settle();
  assert.equal(s.document.activeElement, rosterRow, "where the operator is, focus stays");
  assert.ok(![...s.c.tabs.values()].some(tab => tab.workspace === "A"));
});

test("a late release (main stopped waiting and refuses the answer) ends the same way", async t => {
  for (const late of [{ ok: false, code: "unknown-request" }, null]) {
    const { s, a1, a2 } = await holder(t);
    if (late) s.c.answerResult = late;
    else s.c.desktopBridge.windowReleaseAnswer = async () => { throw new Error("main is gone"); };
    await s.releaseTakenWorkspace({ request: 3, workspace: "A", workspaces: SERVED });
    await settle();
    assert.deepEqual(tabsOf(s, "A"), [], late ? late.code : "a rejected answer");
    assert.deepEqual(s.detached.sort(), [a1.handle, a2.handle].sort(), "nothing attached");
    assert.equal(s.c.workspace, "B");
    assert.equal(s.c.workspaceTabMemory.recall("A", s.c.tabs).split, null);
  }
});

test("the tabs close even when the window could not leave (the leave failed), and a window already elsewhere closes them too", async t => {
  const { s } = await holder(t);
  s.c.leaveTakenWorkspace = async () => { s.log.push(["leave"]); throw new Error("main refused"); };
  await assert.rejects(s.releaseTakenWorkspace({ request: 4, workspace: "A", workspaces: SERVED }));
  await settle();
  assert.deepEqual(tabsOf(s, "A"), [], "closed in finally");
  const other = await holder(t);
  other.s.switchTo("B");
  other.s.log.length = 0;
  await other.s.releaseTakenWorkspace({ request: 5, workspace: "A", workspaces: SERVED });
  await settle();
  assert.deepEqual(other.s.log[0], ["answer", 5, null], "a window showing another workspace hands over no layout");
  assert.deepEqual(tabsOf(other.s, "A"), [], "a workspace it no longer shows: its tabs close all the same");
  assert.deepEqual(tabsOf(other.s, "B").map(tab => tab.title), ["b1"]);
});

test("a release naming no workspace does nothing: no answer, no leave, no close", async t => {
  const { s } = await holder(t);
  s.log.length = 0;
  for (const message of [null, {}, { request: 1, workspace: "" }, { request: 1, workspace: 7 }]) await s.releaseTakenWorkspace(message);
  await settle();
  assert.deepEqual(s.log, []);
  assert.equal(tabsOf(s, "A").length, 3);
});

/* ── the window that took the workspace: restoreHandedLayout ── */

const ref = name => ({ instance: name, home: `/synthetic/${name}`, agentsRoot: "/synthetic/agents" });
/** A window that has just switched to A, taken over: nothing of A open here yet. */
function receiver(t) {
  const s = shell(t);
  s.switchTo("X"); s.switchTo("A");
  return s;
}
/** Run the restore: the panel answers `roster`, and each attach is answered as it is asked, in turn. */
async function restore(s, layout, roster) {
  const done = s.restoreHandedLayout("A", layout);
  let finished = false; done.then(() => { finished = true; });
  await tick();
  assert.equal(s.requests.at(-1).path, "/api/panel?ws=A", "one read of the workspace's roster");
  s.requests.at(-1).resolve({ instances: roster });
  for (let answered = 0; !finished;) {
    await tick();
    while (answered < s.attachments.length) s.attachments[answered].resolve({ id: 100 + answered++ });
  }
  await settle();
}
const idOf = (s, name) => [...s.c.tabs].find(([, tab]) => tab.instanceRef?.instance === name)?.[0] ?? null;

test("restore: the handed terminals open in the descriptor's order, and its split and active tab are composed", async t => {
  const s = receiver(t);
  const layout = { terminals: [ref("a2"), ref("a1"), ref("a3")],
    split: { orientation: "col", focused: 1, groups: [{ tabs: [0, 2], active: 2 }, { tabs: [1], active: 1, weight: 2 }] }, active: 1 };
  await restore(s, layout, [instance("a1"), instance("a2"), instance("a3")]);
  assert.deepEqual(s.attachments.map(gate => gate.spec.window), ["a2", "a1", "a3"], "fresh viewers, in order");
  const [a2, a1, a3] = ["a2", "a1", "a3"].map(name => idOf(s, name));
  assert.ok(a1 && a2 && a3);
  assert.deepEqual(plain(s.c.split), plain(composeLayout(layout, i => [a2, a1, a3][i]).split), "composeLayout's split");
  assert.deepEqual(s.c.split.groups.map(group => [group.tabs, group.activeTab]), [[[a2, a3], a3], [[a1], a1]]);
  assert.equal(s.c.split.focusedGroup, 2);
  assert.equal(s.c.activeTab, a1, "the descriptor's active tab");
  assert.equal(s.document.activeElement, s.c.tabs.get(a1) && s.terms[1].input, "its terminal takes the focus");
  assert.deepEqual([...s.c.tabs.values()].map(tab => tab.kind), ["terminal", "terminal", "terminal"], "nothing but terminals opens");
});

test("restore: a handed layout described by the holder comes back with the same shape", async t => {
  const { s: from } = await holder(t);
  const layout = plain(describeLayout(from.c.tabs, from.c.split, from.c.activeTab, "A"));
  const s = receiver(t);
  await restore(s, layout, [instance("a1"), instance("a2")]);
  assert.equal(layout.active, null, "the holder's active tab was its file tab, which does not move");
  assert.deepEqual(plain(describeLayout(s.c.tabs, s.c.split, s.c.activeTab, "A")), { ...layout, active: 1 },
    "the same terminals and split; active, the focused group's active terminal");
});

test("restore: a terminal that no longer resolves, or no longer runs, is left out; the rest open and lay out", async t => {
  const s = receiver(t);
  const layout = { terminals: [ref("gone"), ref("a1"), ref("stopped"), ref("a2")], split: null, active: 0 };
  await restore(s, layout, [instance("a1"), instance("a2"), { ...instance("stopped"), running: false }]);
  assert.deepEqual(s.attachments.map(gate => gate.spec.window), ["a1", "a2"]);
  assert.deepEqual([...s.c.tabs.values()].map(tab => tab.instanceRef.instance), ["a1", "a2"]);
  assert.equal(s.c.split, null);
  assert.equal(s.c.activeTab, idOf(s, "a1"), "the active one left out: the first that opened");
  assert.ok(s.c.warned.length >= 1, "quietly: no alert");
  const none = receiver(t);
  await restore(none, { terminals: [ref("gone")], split: null, active: 0 }, []);
  assert.equal(none.c.tabs.size, 0); assert.equal(none.c.split, null, "nothing opened: nothing is laid out");
});

test("restore: a layout off the shape (a terminals array with holes) restores nothing, reads nothing and throws nothing", async t => {
  for (const layout of [{ terminals: new Array(3), split: null, active: null }, { terminals: [, ref("a1")], split: null, active: 0 }, null]) { // eslint-disable-line no-sparse-arrays
    const s = receiver(t);
    const before = s.requests.length;
    await s.restoreHandedLayout("A", layout);
    assert.equal(s.requests.length, before, "no roster read");
    assert.equal(s.c.tabs.size, 0); assert.deepEqual(s.attachments, []);
  }
});

test("restore: a selection made meanwhile stops what is left: no further open, no focus taken", async t => {
  const s = receiver(t);
  const entry = rosterRowOf(s);
  const done = s.restoreHandedLayout("A", { terminals: [ref("a1"), ref("a2")], split: null, active: 1 });
  await tick();
  s.requests.at(-1).resolve({ instances: [instance("a1"), instance("a2")] });
  await tick();
  assert.equal(s.attachments.length, 1, "a1 is attaching");
  s.c.tabOpenIntents.begin(); entry.focus(); // the operator selects something else
  s.attachments[0].resolve({ id: 1 });
  await done; await settle();
  assert.equal(s.attachments.length, 1, "a2 never opens");
  assert.equal(s.terms[0].focuses, 0); assert.equal(s.document.activeElement, entry, "focus stays where the operator put it");
  assert.equal(s.c.split, null);
});

test("restore: a workspace switch or a new connection meanwhile stops it too", async t => {
  const switched = receiver(t);
  const one = switched.restoreHandedLayout("A", { terminals: [ref("a1")], split: null, active: 0 });
  await tick();
  switched.switchTo("B");
  switched.requests.find(gate => gate.path === "/api/panel?ws=A").resolve({ instances: [instance("a1")] });
  await one; await settle();
  assert.deepEqual(switched.attachments, [], "switched away before the roster answered: nothing opens");
  const reconnected = receiver(t);
  const two = reconnected.restoreHandedLayout("A", { terminals: [ref("a1"), ref("a2")],
    split: { orientation: "row", focused: 0, groups: [{ tabs: [0], active: 0 }, { tabs: [1], active: 1 }] }, active: 0 });
  await tick();
  reconnected.requests.at(-1).resolve({ instances: [instance("a1"), instance("a2")] });
  await tick();
  reconnected.c.connectionGeneration++;
  reconnected.attachments[0].resolve({ id: 1 });
  await two; await settle();
  assert.equal(reconnected.attachments.length, 1, "a new connection: no further open");
  assert.equal(reconnected.c.split, null, "and no layout composed");
  const failed = receiver(t);
  const three = failed.restoreHandedLayout("A", { terminals: [ref("a1")], split: null, active: 0 });
  await tick();
  failed.requests.at(-1).reject(new Error("panel unreachable"));
  await three;
  assert.deepEqual(failed.attachments, [], "an unread roster opens nothing");
});

// A window can take back a workspace it showed before (its tabs of it kept, as every switch keeps them) from the
// window that has it now. The composed split replaces this window's own; a terminal of the workspace already
// open here and not in the handed layout is then in no group of it. Proposed fix (shell.mjs restoreHandedLayout):
// before `split = composed.split`, add this window's other terminal tabs of `ws` to the focused group, as
// composeLayout does with a handed terminal no group lists.
test("restore: a terminal of the workspace already open here joins the composed split", async t => {
  const s = shell(t);
  s.switchTo("A");
  const own = await s.open("a5");
  s.switchTo("X"); s.switchTo("A");
  await restore(s, { terminals: [ref("a1"), ref("a2")], split: { orientation: "row", focused: 0, groups: [{ tabs: [0], active: 0 }, { tabs: [1], active: 1 }] }, active: 0 },
    [instance("a1"), instance("a2"), instance("a5")]);
  assert.ok(s.c.split.groups.some(group => group.tabs.includes(own.id)), "a5 is in a group");
});

// Main rekeys a window bound to a deployment id to the view that holds it (#482) before this window's selection
// follows: a take-over then names the view. The release is of what this window holds under the deployment id.
test("a release naming the view of the deployment this window still holds it under: described, left and closed the same", async t => {
  for (const late of [false, true]) {
    const { s, a1, a2, b1 } = await holder(t);
    if (late) s.c.answerResult = { ok: false, code: "unknown-request" };
    s.log.length = 0;
    const views = [{ id: "ws:aaaa", name: "a", deployments: ["A"] }, { id: "B", name: "b" }];
    const shown = describeLayout(s.c.tabs, s.c.split, s.c.activeTab, "A");
    await s.releaseTakenWorkspace({ request: 5, workspace: "ws:aaaa", workspaces: views });
    await settle();
    assert.deepEqual(plain(s.log[0]), ["answer", 5, { layout: plain(shown) }], "its terminals and split are handed over");
    assert.deepEqual(tabsOf(s, "A"), [], late ? "late: no tab of it is left" : "no tab of it is left");
    assert.deepEqual(s.detached.sort(), [a1.handle, a2.handle].sort(), "both viewers detached: nothing stays attached");
    assert.equal(s.c.wsActiveTerminal.has("A"), false);
    assert.equal(s.c.workspace, "B", "it left");
    assert.equal(b1.term.disposed, 0, "B's terminal stays");
  }
});
