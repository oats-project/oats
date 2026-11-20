// #1237: a retired instance's tabs close, in every group, through the shipped shell close. Real shipped shell
// close/select/open and terminal lifecycle (the harness of split-empty-shell.test.mjs), with the shipped
// closeRetiredTabs over the shipped rule (retired-tabs.mjs); only xterm, IPC and panel answers are synthetic.
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
import { createContextPanel } from "../renderer/context-panel.mjs";
import { createInstanceGitPanel } from "../renderer/instance-git.mjs";
import { createInstanceTeamsSection } from '../renderer/instance-teams.mjs';
import { createInstanceSoulSection } from '../renderer/instance-soul.mjs';
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
import { iconElement } from "../renderer/shell-icons.mjs";
import { navTab } from "../renderer/shell-nav.mjs";

const source = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
const tick = () => new Promise(setImmediate);
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const instance = name => ({ instance: name, running: true, home: `/synthetic/${name}`, agentsRoot: "/synthetic/agents",
  tmux: { session: "synthetic-only", window: name } });

function shell(t, shellSource = source) {
  const dom = new JSDOM(`<div id="app"><aside id="context-panel"></aside><span id="ws-context"></span><div id="stagehost"></div><div id="tabstrip"><div id="tabbar-row"><div id="tabbar"></div>
    <div id="tab-actions"><button id="split-right"></button><button id="split-down"></button></div>
    </div></div><div id="tabhost"></div><aside id="roster"><div class="ctx-head"><span>Instances</span><span class="ctx-count"></span></div><div class="ctx-list"></div></aside>
    <nav id="nav"><button class="nav-item active">Overview</button></nav><button id="workspace">Workspace</button></div>`);
  t.after(() => dom.window.close());
  const document = dom.window.document, requests = [], attachments = [], terms = [], detached = [], projections = [], actions = new Map();
  const c = {
    document, window: dom.window, createContextPanel, createInstanceGitPanel, createInstanceTeamsSection, createInstanceSoulSection, canAddressRemote, rowReason, console, navigator: { platform: "MacIntel" },
    getBinding, formatChord, stableFocusTarget: () => null, iconElement,
    // The user has opened the instance panel (Spec B: one per-machine preference, closed until opened).
    localStorage: (store => ({ getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) }))(new Map([["oats-desktop-instance-panel-open", "1"]])),
    connectionGeneration: 0, subscribeConnections: () => () => {}, ctx: { openExternal: assert.fail }, openConnections: assert.fail,
    workspace: "A", generation: 0, tabWorkspace: "A", contextWorkspace: "A",
    tabs: new Map(), nextTabId: 1, activeTab: null, split: null, sidebarMode: "instances", tabLayerVisible: false,
    contextRosterGen: 0, contextInstances: [],
    // The palette's last-focus record (Spec C), inert here: the shell code under test writes to it.
    instanceRecency: createInstanceRecency({ storage: null }), recencyIdFromTerminalKey,
    wsActiveTerminal: new Map(), pendingTerms: new Set(),
    rosterState: null, rosterStale: false, contextDeploymentNote: null, ...viewContext(), rosterSignaturePainted: null, // roster loading state (renderContextRoster is stubbed)
    tabbar: document.getElementById("tabbar"), tabhost: document.getElementById("tabhost"),
    tabActionsEl: document.getElementById("tab-actions"), contextRosterEl: document.getElementById("roster"),
    stageHost: document.getElementById("stagehost"), stage: { name: "automations" }, navEl: document.getElementById("nav"),
    NAV: [{ name: "automations" }], navTab /* the shipped NAV_TABS lookup: showStage reads it first (hierarchy is Workspace › Machines; automations a page of its own) */, stageSidebarMode: () => "overview",
    brainIntents: createIntentGate(), workspaceTabMemory: createWorkspaceTabMemory(), workspaceLabel: { reset() {} },
    currentWorkspace: () => c.workspace, workspaceGeneration: () => c.generation,
    updateActiveContexts: on => { c.tabLayerVisible = on; },
    refreshContextRoster() {}, renderContextRoster() {}, setNavActive() {},
    focusRoster() { c.tabOpenIntents.invalidate(); c.rosterEntry()?.focus(); },
    tabShowsRow, instanceId, rosterParentId, revealInScrollport, // the shipped revealActiveRosterRow's
    api(path) { const gate = { ...deferred(), path }; requests.push(gate); return gate.promise; },
    updateSidebarControls() {}, // chrome is exercised by shell-design.test.mjs
    resolveTerminalOpen, terminalKey, reserveKey, whenKeyFree, wirePaneSelection, createTabChrome, tabKeyAction, focusAfterLastTab, tabNameTailStart, setTabTitle,
    splitControlsState, instanceSplitPlan, instanceSplitIdentity, sameInstanceActionTarget, ...layout, ...workspaceTabs,
    projectSplitDom(els, ...args) { projections.push(els); return projectSplitDom(els, ...args); },
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
      termClose(h) { detached.push(h.id); return confirmed(h); }, termResize() {}, termWrite() { assert.fail("selection must not write terminal bytes"); },
      onTermData: () => () => {}, onTermExit: () => () => {},
    },
    registerAction: action => actions.set(action.id, action.run),
  };
  c.tabOpenIntents = createSelectionOwnership(c);
  // Spec F: the shipped active-tab reveal runs too (jsdom has no layout or ResizeObserver).
  c.revealInStrip = revealInStrip; c.tabStripResize = null; c.numberTabStrips = numberTabStrips; c.tabNumberObserver = null;
  c.splitOpenState = () => ({ split: c.split, activeId: c.activeTab, tabs: c.tabs, workspace: c.workspace, visible: c.tabLayerVisible });
  const names = ["setSidebarMode", "updateContextTabs", "showTabLayer", "closeStage", "showStage", "renderSplit", "selectEmptyGroup", "splitPane", "closeSplit", "restoreTerminalGroups",
    "updateSplitControls", "onTabKeydown", "walkedTabs", "visibleTabEntries", "addTab", "selectTab", "activateTab", "revealActiveRosterRow", "closeTab", "tabStrips", "revealActiveTabs", "observeTabStrips", "showTerminalContext",
    "openTerminalTabFlow", "openTerminalTabInner", "restoreWorkspaceTabs", "focusActiveTerminal",
    "syncContextPanel", "refreshPanelInstance", "syncTabNeedsInput", "closeRetiredTabs", "focusGroup", "rosterEntry"];
  const functions = names.map(name => {
    const match = shellSource.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
    assert.ok(match, `execute shipped ${name}`); return match[0];
  });
  // The split actions run under the shipped modal guard (the palette or a dialog shown: none here).
  c.modalOpen = () => false;
  const registry = [source.match(/^const unlessModal = [^\n]+/m)[0], ...source.split("\n").filter(line => /^registerAction\(/.test(line) && /id: "(?:split\.|tabs\.close|terminal\.focusActive)/.test(line))];
  // Execute the shipped panel construction as well as its projection functions:
  // pointer/focus intent must compete with opens exactly as in the real shell.
  const panelSetup = shellSource.slice(shellSource.indexOf("const contextPanel = createContextPanel"), shellSource.indexOf("/** Projection only:"));
  const s = runInNewContext(`${functions.join("\n")}\n${panelSetup}\n${registry.join("\n")}\n({ ${names.join(", ")}, contextPanel });`, withShellWindowGlobals(c));
  t.after(() => s.contextPanel.dispose());
  const event = (el, type, options = {}) => el.dispatchEvent(type === "keydown"
    ? new dom.window.KeyboardEvent(type, { bubbles: true, cancelable: true, ...options })
    : new dom.window.Event(type, { bubbles: true }));
  return {
    ...s, c, document, requests, attachments, terms, detached, projections, actions, event,
    cells: () => [...c.tabhost.querySelectorAll(":scope > .group-cell")],
    empty: id => [...c.tabhost.querySelectorAll(".group-cell")].find(cell => cell.dataset.group === String(id))?.querySelector(".split-empty"),
    field: name => document.querySelector(`[data-context-field="${name}"]`).textContent,
    panelRoot: document.getElementById("context-panel"),
    async open(ref, ready = true, roster = [typeof ref === "string" ? instance(ref) : ref]) {
      const count = attachments.length;
      const done = s.openTerminalTabFlow(ref, message => assert.fail(message));
      requests.at(-1).resolve({ instances: roster }); await tick();
      if (ready && attachments.length > count) attachments.at(-1).resolve({ id: attachments.length });
      if (ready) await done;
      return { done, id: c.activeTab, term: terms.at(-1), gate: attachments.at(-1) };
    },
    switchTo(workspace) { c.workspace = workspace; c.generation++; s.restoreWorkspaceTabs(); },
  };
}

const T1 = "2026-10-01T00:00:00.000Z", T2 = "2026-10-05T00:00:00.000Z", D = "/synthetic";
/** A roster row as the panel tags it: its deployment and its incarnation. */
const row = (name, createdAt = T1) => ({ ...instance(name), agent: "dev", createdAt, deployment: { id: D, machine: "This computer", path: D } });
/** An observed answer of workspace A: its one local deployment reached and current. */
const answer = rows => ({ workspace: { id: "A" }, instances: rows,
  deployments: [{ id: D, machine: "This computer", path: D, local: true, reachable: true, primary: true }] });
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
/** The roster answer lands: dispatched after every read so far, as refreshContextRoster's own. */
const land = async (s, panel) => { s.closeRetiredTabs(panel, ++s.c.panelReads); await settle(); };
const ids = s => s.c.split.groups.map(g => [...g.tabs]);

/** Group 1 [p, a] with a active; group 2 [b, q] with q active, or [b] alone. Group 1 is focused. */
async function twoGroups(t, { loneB = false } = {}) {
  const s = shell(t), p = await s.open(row("p")), a = await s.open(row("a"));
  s.splitPane("row");
  const b = await s.open(row("b")), q = loneB ? null : await s.open(row("q"));
  assert.equal(s.selectTab(a.id), true);
  assert.deepEqual(ids(s), [[p.id, a.id], loneB ? [b.id] : [b.id, q.id]]);
  assert.equal(s.c.split.focusedGroup, 1); assert.equal(s.c.activeTab, a.id);
  return { s, p, a, b, q };
}

test("retired in two groups: both close, each group's successor is active, and focus that was in the closed tab goes to it", async t => {
  const { s, p, a, b, q } = await twoGroups(t);
  s.c.tabOpenIntents.applyFocus(() => a.term.input.focus());
  const cells = s.cells();
  await land(s, answer([row("p"), row("q")]));
  assert.equal(s.c.tabs.has(a.id), false); assert.equal(s.c.tabs.has(b.id), false);
  assert.deepEqual(ids(s), [[p.id], [q.id]]);
  assert.equal(s.c.split.groups[0].activeTab, p.id, "a's group: the previous tab (no next)");
  assert.equal(s.c.split.groups[1].activeTab, q.id, "b's group: its active tab stays");
  assert.equal(s.c.activeTab, p.id);
  assert.equal(s.document.activeElement, s.c.tabs.get(p.id).triggerEl, "focus was in a's xterm: it moves to the successor");
  assert.equal(a.term.disposed, 1); assert.equal(b.term.disposed, 1, "the shipped teardown ran for both");
  assert.deepEqual(s.detached.sort(), [2, 3], "both viewers detached, no other");
  assert.deepEqual(s.cells(), cells, "no group is removed");
});

test("a background close never takes focus from where the operator is", async t => {
  const { s, p, a, q } = await twoGroups(t);
  // The operator is on a roster row (as renderContextRoster paints it).
  s.c.contextRosterEl.querySelector(".ctx-list").innerHTML = `<div class="ctx-tree-row"><button class="ctx-inst" tabindex="0" data-tree-instance="/synthetic/q">q</button></div>`;
  const rosterRow = s.c.contextRosterEl.querySelector(".ctx-inst"); rosterRow.focus();
  await land(s, answer([row("p"), row("q")]));
  assert.deepEqual(ids(s), [[p.id], [q.id]]); assert.equal(s.c.activeTab, p.id);
  assert.equal(s.c.tabs.has(a.id), false);
  assert.equal(s.document.activeElement, rosterRow, "the roster row keeps focus");
});

test("focus that left the closing tab while its teardown ran stays where it went", async t => {
  const { s, a } = await twoGroups(t);
  s.c.tabOpenIntents.applyFocus(() => a.term.input.focus());
  let release; s.c.desk.termClose = h => new Promise(ok => { release = () => ok(confirmed(h)); });
  s.closeRetiredTabs(answer([row("p"), row("b"), row("q")]), ++s.c.panelReads); await tick();
  const dialog = s.document.createElement("button"); s.document.body.append(dialog); dialog.focus();
  release(); await settle();
  assert.equal(s.c.tabs.has(a.id), false);
  assert.equal(s.document.activeElement, dialog, "a dialog that took focus meanwhile keeps it");
});

test("the only tab of its group: the group stays, empty; focus in it goes to the empty group", async t => {
  const { s, p, a, b } = await twoGroups(t, { loneB: true });
  await land(s, answer([row("p"), row("a")]));
  assert.deepEqual(ids(s), [[p.id, a.id], []], "the empty group persists"); assert.equal(s.c.activeTab, a.id);
  assert.equal(s.cells().length, 2);
  assert.equal(s.c.tabs.has(b.id), false);
  // Now the focused group's only tab, focused.
  s.closeTab(p.id); await settle();
  s.c.tabOpenIntents.applyFocus(() => a.term.input.focus());
  await land(s, answer([]));
  assert.deepEqual(ids(s), [[], []]); assert.equal(s.c.activeTab, null);
  assert.equal(s.document.activeElement, s.empty(1), "today's last-tab close: the focused group's empty destination");
});

test("a stale, pending or failed answer, or a stopped instance, closes nothing", async t => {
  const { s, a } = await twoGroups(t);
  const stopped = { ...row("a"), running: false };
  for (const panel of [{ ...answer([]), deployments: [{ ...answer([]).deployments[0], stale: true }] },
    { ...answer([]), deployments: [{ ...answer([]).deployments[0], reachable: false }] },
    { ...answer([]), deployments: [] }, answer([stopped, row("p"), row("b"), row("q")])]) {
    await land(s, panel);
    assert.equal(s.c.tabs.has(a.id), true, JSON.stringify(panel.deployments));
  }
  assert.deepEqual(s.detached, []);
});

test("respawn under the same home: the new row opens a new tab, never the old one, and the old one closes", async t => {
  const s = shell(t), old = await s.open(row("a", T1));
  const respawned = await s.open(row("a", T2), true, [row("a", T2)]);
  assert.notEqual(respawned.id, old.id, "a new tab, not the old one activated");
  assert.equal(s.attachments.length, 2, "its own viewer");
  assert.equal(s.c.tabs.get(old.id).key, s.c.tabs.get(respawned.id).key, "same home, same key: the incarnation tells them apart");
  assert.equal(s.c.activeTab, respawned.id);
  await land(s, answer([row("a", T2)]));
  assert.equal(s.c.tabs.has(old.id), false, "the old incarnation's tab closes (R)");
  assert.equal(s.c.tabs.has(respawned.id), true); assert.equal(s.c.activeTab, respawned.id);
  const again = await s.open(row("a", T2), true, [row("a", T2)]);
  assert.equal(again.id, respawned.id, "the new incarnation's own tab is activated"); assert.equal(s.attachments.length, 2);
});

test("respawn, answer first: the old tab closes, then the row opens a new tab", async t => {
  const s = shell(t), old = await s.open(row("a", T1));
  await land(s, answer([row("a", T2)]));
  assert.equal(s.c.tabs.has(old.id), false);
  const fresh = await s.open(row("a", T2), true, [row("a", T2)]);
  assert.notEqual(fresh.id, old.id); assert.equal(s.attachments.length, 2);
});

test("the old tab never shows the new incarnation's row: no needs-input cue, no panel rebind", async t => {
  const s = shell(t), old = await s.open(row("a", T1));
  const waiting = { ...row("a", T2), waitingOnYou: { since: T2, producer: "agent", reason: "question", message: "Which?" } };
  s.c.tabLayerVisible = true;
  s.refreshPanelInstance([waiting], "A");
  assert.equal(s.c.tabs.get(old.id).instanceRef.createdAt, T1, "the old tab keeps its own incarnation");
  assert.equal(s.c.tabs.get(old.id).triggerEl.querySelector(".tab-attn"), null, "no cue from another incarnation");
  s.refreshPanelInstance([{ ...waiting, createdAt: T1 }], "A");
  assert.ok(s.c.tabs.get(old.id).triggerEl.querySelector(".tab-attn"), "its own incarnation's claim shows");
});

test("an open in flight for an identity a newer answer shows retired opens no tab", async t => {
  const s = shell(t), said = [];
  const flow = s.openTerminalTabFlow(row("a"), message => said.push(message));
  await land(s, answer([])); // read after the open's own, judged while it waits
  s.requests.at(-1).resolve({ instances: [row("a")] }); await flow;
  assert.deepEqual(said, ['unknown instance "a"']); assert.equal(s.c.tabs.size, 0); assert.equal(s.attachments.length, 0);
  // An answer older than the open's own read decides nothing for it.
  const later = s.openTerminalTabFlow(row("a"), message => said.push(message));
  s.c.judgedAnswer = { ...s.c.judgedAnswer, read: 0 };
  s.requests.at(-1).resolve({ instances: [row("a")] }); await tick();
  s.attachments.at(-1).resolve({ id: 1 }); await later;
  assert.equal(s.c.tabs.size, 1); assert.equal(said.length, 1);
});

test("a workspace that is not shown is not judged; it is reconciled when its answer lands", async t => {
  const s = shell(t), a = await s.open(row("a"));
  s.switchTo("B");
  await land(s, { ...answer([]), workspace: { id: "B" } });
  assert.equal(s.c.tabs.has(a.id), true, "B's answer says nothing about A's tabs");
  s.switchTo("A");
  await land(s, answer([]));
  assert.equal(s.c.tabs.has(a.id), false);
});

test("the shell runs the rule on an owned, observed answer only, before it paints", () => {
  const body = source.match(/async function refreshContextRoster\([^]*?\n\}/)[0];
  const call = body.indexOf("closeRetiredTabs(panel, read)");
  assert.match(body, /if \(!reportedFailure && connection === connectionGeneration\) closeRetiredTabs\(panel, read\);/);
  assert.ok(call > body.indexOf("if (!owns(resolvedWs, stale)) return;"), "after the ownership check");
  assert.ok(call > body.indexOf("if (failure && !contextInstances.length) {"), "after the failed-read return");
  assert.ok(call > body.indexOf('if (panel.deployment?.status === "pending" && !panel.workspace?.remote'), "after the pending return");
  assert.ok(call < body.indexOf("refreshPanelInstance(contextInstances, resolvedWs);\n  if (!unchanged)"), "before the panel binding and the paint");
  assert.match(body, /const myGen = \+\+contextRosterGen, read = \+\+panelReads, connection = connectionGeneration;/);
});

test("a background close cancels no pending open: the operator's open made meanwhile still lands", async t => {
  const s = shell(t), a = await s.open(row("a"));
  const flow = s.openTerminalTabFlow(row("c"), assert.fail);
  await land(s, answer([row("c")]));
  assert.equal(s.c.tabs.has(a.id), false);
  s.requests.at(-1).resolve({ instances: [row("c")] }); await tick();
  s.attachments.at(-1).resolve({ id: s.attachments.length }); await flow;
  const c = [...s.c.tabs].find(([, tab]) => tab.title === "c");
  assert.ok(c, "the open made its tab"); assert.equal(s.c.activeTab, c[0], "and selected it");
});

/** One group [a, b, c] with a active and its xterm focused; returns the release of each teardown receipt. */
async function batch(t, names) {
  const s = shell(t), opened = {};
  for (const name of names) opened[name] = await s.open(row(name));
  assert.equal(s.selectTab(opened.a.id), true);
  s.c.tabOpenIntents.applyFocus(() => opened.a.term.input.focus());
  const held = new Map();
  s.c.desk.termClose = h => new Promise(ok => { held.set(h.id, () => ok(confirmed(h))); });
  return { s, opened, release: async name => { held.get(attachmentId(s, opened[name]))(); await settle(); } };
}
/** The handle id the harness gave a tab's attachment (open() resolves it with its 1-based position). */
const attachmentId = (s, tab) => s.attachments.indexOf(tab.gate) + 1;

for (const order of [["a", "b"], ["b", "a"]]) test(`a batch retiring adjacent tabs (${order.join(" then ")} confirmed): focus that was in a reaches the survivor`, async t => {
  const { s, opened, release } = await batch(t, ["a", "b", "c"]);
  s.closeRetiredTabs(answer([row("c")]), ++s.c.panelReads); await tick();
  for (const name of order) await release(name);
  assert.deepEqual([...s.c.tabs.keys()], [opened.c.id]); assert.equal(s.c.activeTab, opened.c.id);
  assert.equal(s.document.activeElement, s.c.tabs.get(opened.c.id).triggerEl);
});

for (const order of [["a", "b"], ["b", "a"]]) test(`a batch retiring the whole group (${order.join(" then ")} confirmed): focus goes to its empty destination`, async t => {
  const { s, opened, release } = await batch(t, ["a", "b"]);
  s.splitPane("row"); assert.equal(s.selectTab(opened.a.id), true); s.c.tabOpenIntents.applyFocus(() => opened.a.term.input.focus());
  s.closeRetiredTabs(answer([]), ++s.c.panelReads); await tick();
  for (const name of order) await release(name);
  assert.deepEqual(ids(s), [[], []]); assert.equal(s.c.activeTab, null);
  assert.equal(s.document.activeElement, s.empty(1));
});

test("a batch never pulls focus the operator moved elsewhere", async t => {
  const { s, opened, release } = await batch(t, ["a", "b", "c"]);
  s.closeRetiredTabs(answer([row("c")]), ++s.c.panelReads); await tick();
  s.c.contextRosterEl.querySelector(".ctx-list").innerHTML = `<div class="ctx-tree-row"><button class="ctx-inst" tabindex="0" data-tree-instance="/synthetic/c">c</button></div>`;
  const rosterRow = s.c.contextRosterEl.querySelector(".ctx-inst"); rosterRow.focus();
  await release("a"); await release("b");
  assert.equal(s.c.activeTab, opened.c.id); assert.equal(s.document.activeElement, rosterRow, "the roster row the operator moved to");
});

test("away and back: a remote tab is kept when its server's held rows say another incarnation or gone", async t => {
  const s = shell(t), far = { ...row("far"), server: "box", addressable: true, deployment: { id: "remote:box:1" } };
  const tab = await s.open(far, true, [far]);
  s.switchTo("B"); s.switchTo("A");
  const held = extra => ({ workspace: { id: "A" }, instances: [{ ...far, running: null, serverUnreached: true, ...extra }],
    deployments: [{ ...answer([]).deployments[0] }, { id: "remote:box:1", local: false, reachable: false }] });
  await land(s, held({ createdAt: T2 }));
  await land(s, held({ missingRemotely: true }));
  assert.equal(s.c.tabs.has(tab.id), true);
});

// Session providers (spec C1, a known limit the spec owner accepted): a home that moves to a session provider while its
// workspace is not shown. Its remembered terminal tab comes back with the workspace (the restore runs before the
// first roster read and judges the row the tab last showed), and closes on that read's answer (retired-tabs.mjs, P).
test("away and back: a tab whose home moved to a session provider while its workspace was away is restored, then closed on the workspace's first roster answer, quietly; the tab beside it stays", async t => {
  const s = shell(t), a = await s.open(row("a")), b = await s.open(row("b"));
  s.switchTo("B"); s.switchTo("A");
  assert.equal(s.c.tabs.has(a.id), true, "restored before any roster read: its pane is the dead tmux window until the answer");
  // The answer: the same home and incarnation, now on bb (its backend moved at a start), in any state.
  const moved = { ...row("a"), backend: "bb", tmux: null, running: true, runtimeState: "unknown", session: { provider: "oats.bb", threadId: "thr_x" } };
  await land(s, answer([moved, row("b")]));
  assert.equal(s.c.tabs.has(a.id), false, "closed on the first roster answer");
  assert.equal(s.c.tabs.has(b.id), true);
  assert.deepEqual(s.detached, [1], "its viewer is detached, no other");
  assert.equal(s.c.activeTab, b.id, "the tab beside it is shown");
});

test("an open that races a home's move to a session provider says where it runs through the open's own say, never \"unknown instance\"; a retired one still says so", async t => {
  const s = shell(t), said = [], notified = [];
  const moved = { ...row("a"), backend: "bb", tmux: null, running: true, runtimeState: "unknown" };
  const racing = async (later, options) => {
    const done = s.openTerminalTabFlow(row("a"), message => notified.push(message), options);
    const request = s.requests.at(-1);
    await land(s, later);                       // a newer roster answer, judged while the open waits for its own read
    request.resolve({ instances: [row("a")] }); // the open's own, older read still shows the tmux row
    await done; await settle();
  };
  await racing(answer([moved]), { say: line => said.push(line) });
  assert.deepEqual([said, notified], [["Runs in a bb thread; open it in bb."], []]);
  await racing(answer([moved]));
  assert.deepEqual([said.length, notified], [1, ["Runs in a bb thread; open it in bb."]], "with no say of its own, the open's notify is told the same sentence");
  await racing(answer([row("a", T2)]), { say: line => said.push(line) });
  assert.deepEqual([said.length, notified.at(-1)], [1, 'unknown instance "a"'], "another incarnation: retired, as before");
  assert.deepEqual([s.c.tabs.size, s.attachments.length], [0, 0], "no tab and no viewer for any of them");
});
