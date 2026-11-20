// Real shipped shell close/select/open/restore and terminal lifecycle; only
// xterm, IPC and panel responses are synthetic. No processes or live sessions.
import test from "node:test";
import { createInstanceRecency, recencyIdFromTerminalKey } from "../renderer/instance-recency.mjs";
import { viewContext } from "./helpers/view-context.mjs";
import assert from "node:assert/strict";
import { opened, confirmed, ready as terminalReady } from './helpers/terminal-wire.mjs';
import { terminalFailure } from '../../client/terminal-contract.mjs';
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
import { DEFAULT_KEYMAP, getBinding, formatChord } from "../renderer/keybindings.mjs";
import { splitControlsState } from "../renderer/split-controls.mjs";
import { instanceSplitPlan, instanceSplitIdentity } from '../renderer/instance-split.mjs';
import { instanceActionTarget, sameInstanceActionTarget } from '../renderer/instance-action-target.mjs';
import * as layout from "../renderer/split-layout.mjs";
import * as workspaceTabs from "../renderer/workspace-tabs.mjs";
import { canAddressRemote, rowReason } from "../../client/remote-address.mjs";
import { revealInStrip, revealInScrollport } from "../renderer/reveal-in-scrollport.mjs";
import { tabShowsRow } from "../renderer/retired-tabs.mjs";
import { instanceId, rosterParentId } from "../../client/instance-tree.mjs";
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
    getBinding, formatChord, stableFocusTarget: () => null,
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
    NAV: [{ name: "automations" }], navTab, stageSidebarMode: () => "overview", // the shipped tab-route lookup (automations is a page of its own, 2026-10-26; hierarchy is Workspace › Machines)
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
  const names = ["setSidebarMode", "updateContextTabs", "showTabLayer", "showStage", "renderSplit", "selectEmptyGroup", "splitPane", "closeSplit", "restoreTerminalGroups",
    "updateSplitControls", "onTabKeydown", "walkedTabs", "visibleTabEntries", "addTab", "selectTab", "activateTab", "revealActiveRosterRow", "closeTab", "tabStrips", "revealActiveTabs", "observeTabStrips", "showTerminalContext",
    "openTerminalTabFlow", "openTerminalTabInner", "restoreWorkspaceTabs", "focusActiveTerminal",
    "syncContextPanel", "refreshPanelInstance", "syncTabNeedsInput", "focusGroup", "rosterEntry"];
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

test('frame10 exact Open in split moves the existing viewer; no second PTY or lost source tabs', async t => {
  const s = shell(t); await s.open('base'); const ref = { ...instance('chosen'), agent: 'dev', createdAt: '2026-09-23T00:00:00.000Z' }; const old = await s.open(ref);
  const pending = s.openTerminalTabFlow(ref, assert.fail, { inSplit: true, expected: instanceActionTarget('A', ref) });
  s.requests.at(-1).resolve({ instances: [ref] }); await pending;
  assert.equal(s.attachments.length, 2); assert.equal(s.terms.length, 2); assert.deepEqual(s.detached, []);
  assert.deepEqual(s.c.split.groups.map(g => [...g.tabs]), [[1], [old.id]]); assert.equal(s.c.activeTab, old.id); assert.equal(s.c.tabs.size, 2);
});
for (const reject of [false, true]) test(`frame10 newer destination intent revokes old split ${reject ? 'failure' : 'success'}`, async t => {
  const s = shell(t); await s.open('base'); const pending = s.openTerminalTabFlow(instance('chosen'), assert.fail, { inSplit: true });
  s.splitPane('col'); const next = s.c.split;
  if (reject) s.requests.at(-1).reject(Error('PRIVATE')); else s.requests.at(-1).resolve({ instances: [instance('chosen')] });
  await pending; assert.equal(s.c.split, next); assert.equal(s.attachments.length, 1); assert.equal(s.c.activeTab, null);
});
test('frame10 split refuses unsignaled layout drift and a reused home before committing a destination', async t => {
  const s = shell(t); await s.open('base'); const errors = [], ref = { ...instance('base'), agent: 'dev', createdAt: '2026-09-23T00:00:00.000Z' };
  let pending = s.openTerminalTabFlow(ref, m => errors.push(m), { inSplit: true }); s.c.activeTab = null;
  s.requests.at(-1).resolve({ instances: [ref] }); await pending; assert.match(String(errors.pop()), /destination changed/); assert.equal(s.c.split, null);
  s.c.activeTab = 1;
  pending = s.openTerminalTabFlow(ref, m => errors.push(m), { inSplit: true, expected: instanceActionTarget('A', ref) });
  s.requests.at(-1).resolve({ instances: [{ ...ref, createdAt: '2026-09-24T00:00:00.000Z' }] }); await pending;
  assert.match(String(errors.pop()), /identity changed/); assert.equal(s.c.split, null); assert.equal(s.attachments.length, 1);
});
for (const count of [1, 3]) test(`${count} initial tab(s): shipped close → select empty → reopen retains the chosen destination`, async t => {
  const s = shell(t), opened = [];
  for (let i = 0; i < count; i++) opened.push(await s.open(`instance-${i}`));
  const original = opened.at(-1);
  s.splitPane("row");
  assert.equal(s.c.activeTab, null, "split's new empty destination has no active terminal");
  assert.deepEqual([...s.c.split.groups[0].tabs], opened.map(o => o.id), "first split seeds every original tab together");
  const cells = s.cells(), empty = s.empty(2);
  s.c.tabs.get(original.id).closeEl.click(); await tick();
  assert.deepEqual(s.cells(), cells, "closing a tab must not remove either group cell");
  assert.equal(s.empty(2), empty, "the destination owns a stable placeholder");
  s.event(empty, "pointerdown"); empty.focus();
  assert.equal(s.c.split.focusedGroup, 2); assert.equal(s.c.activeTab, null);
  s.actions.get("tabs.close")(); s.actions.get("terminal.focusActive")();
  assert.equal(s.c.tabs.size, count - 1, "commands cannot target the previous terminal");
  assert.equal(s.document.activeElement, empty);
  const reopened = await s.open(`instance-${count - 1}`);
  assert.equal(layout.groupOfTab(s.c.split, reopened.id).id, 2, "reopen lands in the chosen empty panel, not the first panel");
  assert.equal(s.c.tabs.size, count); assert.equal(s.attachments.length, count + 1);
  assert.deepEqual(s.detached, [count], "close detaches only that tab; no surviving terminal is reacquired");
  assert.deepEqual(s.attachments.at(-1).spec, s.attachments[count - 1].spec, "exact resolved terminal identity is unchanged");
  assert.equal(reopened.term.focuses, 1); assert.equal(s.document.activeElement, reopened.term.input);
  assert.deepEqual(s.cells(), cells);
});

for (const count of [1, 3]) test(`${count} initial tab(s): open → split → select current terminal MOVES the same retained tab`, async t => {
  const s = shell(t), opened = [];
  for (let i = 0; i < count; i++) opened.push(await s.open(`retained-${i}`));
  const original = opened.at(-1), pane = s.c.tabs.get(original.id).paneEl;
  s.splitPane("row");
  // Force the difficult projection path: a retained input is focused while its
  // pane moves. Native focus restoration must not supersede the open ticket.
  s.c.tabOpenIntents.applyFocus(() => original.term.input.focus());
  const again = await s.open(`retained-${count - 1}`);
  assert.equal(again.id, original.id); assert.equal(s.c.tabs.get(again.id).paneEl, pane);
  assert.equal(layout.groupOfTab(s.c.split, again.id).id, 2);
  assert.equal(s.attachments.length, count); assert.deepEqual(s.detached, []);
  assert.equal(s.c.tabOpenIntents.ownsFocus(again.id), true);
  assert.equal(s.document.activeElement, original.term.input);
  if (count === 1) assert.ok(s.empty(1), "moving the only tab leaves a selectable source, not a collapsed group");
});

test("multiple empty cells are independently focusable, resizable and controllable with activeTab=null", async t => {
  const s = shell(t);
  const first = await s.open("first"); s.splitPane("row");
  const second = await s.open("second"); s.splitPane("row");
  const cells = s.cells();
  s.closeTab(first.id); s.closeTab(second.id); await tick();
  assert.equal(s.cells().length, 3); assert.equal(s.c.tabs.size, 0);
  const empties = cells.map(cell => cell.querySelector(".split-empty"));
  assert.equal(new Set(empties).size, 3);
  for (let i = 0; i < empties.length; i++) {
    assert.equal(empties[i].tabIndex, 0);
    assert.ok(empties[i].getAttribute("aria-label").includes(String(s.c.split.groups[i].id)));
    empties[i].focus(); // native keyboard focus traversal emits focusin
    assert.equal(s.c.split.focusedGroup, s.c.split.groups[i].id); assert.equal(s.c.activeTab, null);
    assert.equal(cells[i].classList.contains("focused-group"), true);
    assert.equal(cells[i].querySelector("#tab-actions"), s.c.tabActionsEl);
  }
  cells[0].getBoundingClientRect = cells[1].getBoundingClientRect = () => ({ width: 400, height: 200 });
  s.event(cells[0].querySelector(".split-resizer"), "keydown", { key: "ArrowRight" });
  assert.equal(s.c.split.groups[0].weight, 1.1);
  assert.equal(s.c.tabActionsEl.hidden, false);
  assert.equal(s.document.getElementById("split-right").disabled, true, "fill existing groups before adding more");
  assert.equal(s.document.getElementById("split-down").disabled, false);
  s.actions.get("split.horizontal")();
  assert.equal(s.c.split.orientation, "col"); assert.equal(s.c.split.groups[0].weight, 1.1);
  assert.deepEqual(s.cells(), cells); assert.deepEqual(cells.map(cell => cell.querySelector(".split-empty")), empties);
  // The roster as renderContextRoster paints it: one roving stop.
  s.c.contextRosterEl.querySelector(".ctx-list").innerHTML = `<div class="ctx-tree-row"><button class="ctx-inst" tabindex="-1" data-tree-instance="a">a</button></div><div class="ctx-tree-row"><button class="ctx-inst" tabindex="0" data-tree-instance="b">b</button></div>`;
  s.actions.get("split.close")();
  assert.equal(s.document.activeElement, s.c.contextRosterEl.querySelector('.ctx-inst[tabindex="0"]'),
    "no terminal left: focus goes to the roster's current row (it has no filter)");
  assert.equal(s.c.split, null); assert.equal(s.c.tabLayerVisible, false);
  assert.equal(s.c.tabActionsEl.parentElement.id, "tabbar-row"); assert.equal(s.c.tabActionsEl.hidden, true);
  assert.equal(s.cells().length, 0); assert.equal(s.document.querySelector(".split-empty"), null);
  assert.equal(s.document.querySelector(".split-resizer"), null);
});

// The leader's Tab (docs/desktop-keyboard.md, "The leader"): the shipped split.focusNextGroup.
test("split.focusNextGroup: the next group's active tab, or the empty group itself, wrapping; nothing without a split", async t => {
  const s = shell(t);
  const first = await s.open("first");
  s.actions.get("split.focusNextGroup")();
  assert.equal(s.c.split, null); assert.equal(s.c.activeTab, first.id, "no split: nothing moves");
  s.splitPane("row");
  const second = await s.open("second"); s.splitPane("row");
  const ids = () => s.c.split.groups.map(g => g.id);
  assert.equal(ids().length, 3);
  const start = s.c.split.focusedGroup, visited = [];
  for (let i = 0; i < 3; i++) {
    const from = ids().indexOf(s.c.split.focusedGroup);
    s.actions.get("split.focusNextGroup")();
    const to = ids().indexOf(s.c.split.focusedGroup);
    assert.equal(to, (from + 1) % 3, "the next group, wrapping");
    const group = s.c.split.groups[to];
    if (group.activeTab != null) assert.equal(s.c.activeTab, group.activeTab, "its active tab is selected");
    else assert.equal(s.document.activeElement, s.empty(group.id), "an empty group takes focus itself");
    visited.push(group.activeTab);
  }
  assert.equal(s.c.split.focusedGroup, start, "three presses are a full round");
  assert.deepEqual(visited.map(String).sort(), [first.id, second.id, null].map(String).sort());
});

// The leader's Shift+Tab and the chord group-previous: the shipped split.focusPrevGroup, the mirror.
test("split.focusPrevGroup: the previous group's active tab, or the empty group itself, wrapping; nothing without a split", async t => {
  const s = shell(t);
  const first = await s.open("first");
  s.actions.get("split.focusPrevGroup")();
  assert.equal(s.c.split, null); assert.equal(s.c.activeTab, first.id, "no split: nothing moves");
  s.splitPane("row");
  await s.open("second"); s.splitPane("row");
  const ids = () => s.c.split.groups.map(g => g.id);
  const start = s.c.split.focusedGroup;
  for (let i = 0; i < 3; i++) {
    const from = ids().indexOf(s.c.split.focusedGroup);
    s.actions.get("split.focusPrevGroup")();
    const to = ids().indexOf(s.c.split.focusedGroup);
    assert.equal(to, (from + 2) % 3, "the previous group, wrapping");
    const group = s.c.split.groups[to];
    if (group.activeTab != null) assert.equal(s.c.activeTab, group.activeTab, "its active tab is selected");
    else assert.equal(s.document.activeElement, s.empty(group.id), "an empty group takes focus itself");
  }
  assert.equal(s.c.split.focusedGroup, start, "three presses are a full round");
  s.actions.get("split.focusNextGroup")(); s.actions.get("split.focusPrevGroup")();
  assert.equal(s.c.split.focusedGroup, start, "next then previous comes back");
});

test("closing a focused group's last tab keeps that empty group, not a neighboring terminal", async t => {
  const s = shell(t), a = await s.open("left"); s.splitPane("row"); const b = await s.open("right");
  s.c.tabs.get(b.id).closeEl.click(); await tick();
  assert.equal(s.c.activeTab, null); assert.equal(s.c.split.focusedGroup, 2);
  assert.equal(s.document.activeElement, s.empty(2)); assert.equal(s.c.tabs.get(a.id).paneEl.hidden, false);
  assert.equal(s.c.tabOpenIntents.ownsFocus(a.id), false);
  s.actions.get("split.close")();
  assert.equal(s.c.split, null); assert.equal(s.c.activeTab, a.id, "Close split explicitly joins surviving tabs into the flat strip");
  assert.equal(s.c.tabs.get(a.id).paneEl.parentNode, s.c.tabhost); assert.equal(s.cells().length, 0);
  assert.equal(s.attachments.length, 2); assert.deepEqual(s.detached, [2]);
});

test("empty layout survives a workspace round-trip; old-cell callbacks cannot select or resize the new visit", async t => {
  assert.match(source, /label: "Split: return to terminal groups"[^\n]*run: \(\) => restoreTerminalGroups\(\)/,
    "return command must be reachable from the shipped palette");
  assert.equal(DEFAULT_KEYMAP["split.restore"], undefined, "recovery adds no keyboard default");
  const s = shell(t), a = await s.open("workspace-a"); s.splitPane("row"); s.closeTab(a.id); await tick();
  s.empty(1).focus();
  const [left, right] = s.cells();
  left.getBoundingClientRect = right.getBoundingClientRect = () => ({ width: 400, height: 200 });
  s.event(left.querySelector(".split-resizer"), "keydown", { key: "ArrowRight" });
  const saved = structuredClone(s.c.split), oldCell = right, oldEmpty = s.empty(2), oldCallbacks = s.projections.at(-1);
  // (Slice 6a: no stage covers the layout any more: a page opens as a tab into the focused group, slice6a.test.mjs.)
  assert.deepEqual(structuredClone(s.c.split), saved); assert.equal(s.c.activeTab, null); assert.equal(s.c.tabLayerVisible, true);
  s.document.getElementById("workspace").focus();
  s.switchTo("B"); await s.open("workspace-b"); s.splitPane("col");
  s.document.getElementById("workspace").focus(); s.switchTo("A");
  assert.deepEqual(structuredClone(s.c.split), saved); assert.equal(s.c.activeTab, null); assert.equal(s.c.tabLayerVisible, true);
  assert.equal(s.cells()[0].style.flexGrow, "1.1");
  assert.equal(s.document.activeElement.id, "workspace", "restoration must be focus-neutral");
  const live = s.c.tabOpenIntents.begin();
  s.event(oldEmpty, "pointerdown"); oldCallbacks.onSelectEmpty(2, oldCell);
  // Even a current cell cannot make an old visit's captured callback current.
  oldCallbacks.onSelectEmpty(2, s.cells()[1]);
  oldCallbacks.onResize([{ id: 1, weight: 5 }]);
  assert.equal(live(), true); assert.deepEqual(structuredClone(s.c.split), saved);
  assert.equal(s.attachments.length, 2); assert.deepEqual(s.detached, [1]);
});

test("Close split/recreate and filled-cell stale callbacks fail live membership without canceling the latest intent", async t => {
  const s = shell(t); await s.open("kept"); s.splitPane("row");
  const old = s.projections.at(-1), cell = s.cells()[1], empty = s.empty(2);
  s.closeSplit(); s.splitPane("row");
  const current = s.projections.at(-1), currentCell = s.cells()[1];
  await s.open("destination");
  const live = s.c.tabOpenIntents.begin(), snapshot = structuredClone(s.c.split);
  s.event(empty, "pointerdown"); old.onSelectEmpty(2, cell); old.onResize([{ id: 1, weight: 7 }]);
  current.onSelectEmpty(2, currentCell); // group now filled, not an empty selection
  assert.equal(live(), true); assert.deepEqual(structuredClone(s.c.split), snapshot);
});

for (const outcome of ["resolve", "reject"]) test(`empty selection supersedes a pending terminal ${outcome}`, async t => {
  const s = shell(t); await s.open("kept"); s.splitPane("row");
  const pending = s.openTerminalTabFlow("late", () => assert.fail("stale refusal"));
  const request = s.requests.at(-1); s.empty(2).focus();
  const snapshot = structuredClone(s.c.split), focused = s.document.activeElement;
  if (outcome === "resolve") request.resolve({ instances: [instance("late")] });
  else request.reject(new Error("old panel failure"));
  await pending;
  assert.deepEqual(structuredClone(s.c.split), snapshot); assert.equal(s.c.activeTab, null);
  assert.equal(s.document.activeElement, focused); assert.equal(s.attachments.length, 1);
});

for (const outcome of ["resolve", "reject"]) for (const supersede of [false, true]) {
  test(`close/reopen while attachment cleanup ${outcome}: ${supersede ? "new empty choice cancels reopen" : "latest reopen uses chosen empty group"}`, async t => {
    const s = shell(t), old = await s.open("slow", false);
    s.splitPane("row");
    if (supersede) {
      // Seed and close a UI-only neighbor to establish two persistent empty
      // destinations without pretending the pending source has already closed.
      const neighbor = s.addTab({ title: 'neighbor', kind: 'terminal' });
      s.splitPane('row'); s.closeTab(neighbor.id);
    }
    s.c.tabs.get(old.id).closeEl.click();
    s.empty(2).focus();
    const reopened = s.openTerminalTabFlow("slow", () => assert.fail("refusal"));
    s.requests.at(-1).resolve({ instances: [instance("slow")] }); await tick();
    assert.equal(s.attachments.length, 1, "reopen waits for old detach, including late materialization");
    // The closing source stays occupied until confirmed. A third, genuinely
    // empty destination supplies the newer intent (not an imaginary free tab).
    if (supersede) s.empty(3).focus();
    const focused = s.document.activeElement;
    if (outcome === "resolve") old.gate.resolve({ id: 99 }); else old.gate.reject(new Error("old attach failure"));
    await old.done; await tick();
    assert.equal(old.term.focuses, 0); assert.equal(old.term.disposed, 1);
    assert.deepEqual(s.detached, outcome === "resolve" ? [99] : []);
    if (!supersede) {
      assert.equal(s.attachments.length, 2);
      assert.equal(layout.groupOfTab(s.c.split, s.c.activeTab).id, 2);
      s.attachments.at(-1).resolve({ id: 100 });
    }
    await reopened;
    if (supersede) {
      assert.equal(s.attachments.length, 1); assert.equal(s.c.tabs.size, 0);
      assert.equal(s.c.activeTab, null); assert.equal(s.c.split.focusedGroup, 3);
      assert.equal(s.document.activeElement, focused);
    } else assert.equal(s.terms.at(-1).focuses, 1);
    assert.equal(s.cells().length, supersede ? 3 : 2);
  });
}

for (const outcome of ["resolve", "reject"]) test(`empty selection revokes retained attachment focus on late ${outcome}`, async t => {
  const s = shell(t), pending = await s.open("retained-pending", false);
  s.splitPane("row"); s.empty(2).focus();
  const empty = s.document.activeElement;
  if (outcome === "resolve") pending.gate.resolve({ id: 88 }); else pending.gate.reject(new Error("late attachment error"));
  await pending.done;
  assert.equal(s.c.activeTab, null); assert.equal(s.c.split.focusedGroup, 2);
  assertPanel(s, null);
  assert.equal(s.document.activeElement, empty); assert.equal(pending.term.focuses, 0);
  assert.equal(pending.term.disposed, 0); assert.equal(s.c.tabs.size, 1);
  assert.equal(s.attachments.length, 1); assert.deepEqual(s.detached, []);
});

test("files and brains join the focused group beside the terminals, and split as a terminal does (slice 6a)", async t => {
  const s = shell(t), terminal = await s.open("covered"); s.splitPane("row");
  const file = s.addTab({ title: "file", kind: "file" });
  // A file opens into the focused (empty) group: no tab kind covers another; both groups show.
  assert.equal(layout.groupOfTab(s.c.split, file.id).id, 2); assert.equal(s.cells().length, 2);
  assert.equal(s.c.activeTab, file.id); assert.equal(s.c.tabActionsEl.hidden, false, "split controls for any active tab");
  const brain = s.addTab({ title: "brain", kind: "brain" });
  assert.equal(layout.groupOfTab(s.c.split, brain.id).id, 2, "a brain joins the same focused group");
  assert.equal(layout.groupOfTab(s.c.split, terminal.id).id, 1);
  assert.equal(s.attachments.length, 1); assert.deepEqual(s.detached, []);
});

test('actual shell retains a close-pending terminal and destination; retry removes only after confirmation', async t => {
  const s = shell(t), terminal = await s.open('close-pending'); s.splitPane('row');
  s.c.desk.termClose = async () => terminalFailure('E_TERM_CLOSE_PENDING');
  await s.closeTab(terminal.id, true);
  assert.equal(s.c.tabs.has(terminal.id), true); assert.equal(terminal.term.disposed, 0);
  assert.equal(s.c.tabs.get(terminal.id).paneEl.querySelector('.term-banner').textContent, 'closing… not yet confirmed');
  assert.equal(layout.groupOfTab(s.c.split, terminal.id).id, 1); assert.equal(s.cells().length, 2);
  s.c.desk.termClose = async h => confirmed(h);
  await s.closeTab(terminal.id, true);
  assert.equal(s.c.tabs.has(terminal.id), false); assert.equal(terminal.term.disposed, 1); assert.equal(s.cells().length, 2);
});

test('closing the last terminal returns focus to the roster: its current row, else its first row', async t => {
  const s = shell(t), list = s.c.contextRosterEl.querySelector('.ctx-list');
  const paint = stop => { list.innerHTML = ['a', 'b'].map((id, i) => `<div class="ctx-tree-row"><button class="ctx-inst" tabindex="${i === stop ? 0 : -1}" data-tree-instance="${id}">${id}</button></div>`).join(''); return [...list.querySelectorAll('.ctx-inst')]; };
  let rows = paint(1);
  const one = await s.open('last-one'); s.c.tabs.get(one.id).triggerEl.focus();
  await s.closeTab(one.id, true);
  assert.equal(s.c.tabs.size, 0); assert.equal(s.document.activeElement, rows[1], 'the roving stop');
  rows = paint(-1);
  const two = await s.open('last-two'); s.c.tabs.get(two.id).triggerEl.focus();
  await s.closeTab(two.id, true);
  assert.equal(s.document.activeElement, rows[0], 'no stop: the first row');
  assert.equal(s.c.contextRosterEl.querySelector('input, .ctx-filter'), null);
});

for (const outcome of ['resolve', 'reject']) test(`close ${outcome} after workspace/selection change never steals newer foreground`, async t => {
  const s = shell(t), terminal = await s.open(`late-close-${outcome}`), gate = deferred(); let held;
  s.c.desk.termClose = h => { held = h; return gate.promise; };
  const closing = s.closeTab(terminal.id, true);
  s.switchTo('B'); const newer = s.addTab({ title: 'newer', kind: 'file' });
  s.c.tabs.get(newer.id).triggerEl.focus(); const focused = s.document.activeElement;
  if (outcome === 'resolve') gate.resolve(confirmed(held)); else gate.reject(new Error('private transport detail'));
  await closing;
  assert.equal(s.c.workspace, 'B'); assert.equal(s.c.activeTab, newer.id); assert.equal(s.document.activeElement, focused);
  assert.equal(s.c.tabs.has(terminal.id), outcome === 'reject');
});

test('close confirmation in the same workspace cannot steal a newer editable focus', async t => {
  const s = shell(t), terminal = await s.open('same-ws-close'), gate = deferred(); let held;
  s.c.desk.termClose = h => { held = h; return gate.promise; };
  const closing = s.closeTab(terminal.id, true);
  const newer = s.addTab({ title: 'newer', kind: 'file' });
  const input = s.document.createElement('input'); newer.paneEl.append(input); input.focus();
  gate.resolve(confirmed(held)); await closing;
  assert.equal(s.c.activeTab, newer.id); assert.equal(s.document.activeElement, input);
});

test('repeated close coalesces cleanup but retains the latest explicit close focus intent', async t => {
  const s = shell(t), terminal = await s.open('repeated-close'), newer = s.addTab({ title: 'newer', kind: 'file' });
  const gate = deferred(); let held, calls = 0;
  s.c.desk.termClose = h => { held = h; calls++; return gate.promise; };
  const first = s.closeTab(terminal.id, true), second = s.closeTab(terminal.id, true);
  assert.equal(first, second); assert.equal(calls, 1);
  gate.resolve(confirmed(held)); await second;
  assert.equal(s.c.activeTab, newer.id); assert.equal(s.document.activeElement, s.c.tabs.get(newer.id).triggerEl);
});

/** Slice 6a (Details for any agent, superseding closed-panels-return-main-area-space's right-hand instance panel): a
 * terminal tab, committed or retained, brings no instance panel; the agent's facts are its Details tab's own view
 * (views/details.mjs, slice6a.test.mjs). `ref`: the terminal the old panel followed, naming the case only. */
function assertPanel(s, ref) {
  assert.equal(s.panelRoot.hidden, true, `no instance panel beside a terminal${ref ? ` (${ref.instance})` : ''}: Details is a tab`);
}

test('resolved instance context is committed before pending PTY readiness; no panel opens beside it', async t => {
  const s = shell(t), resolved = { ...instance('pending'), harness: 'pi', model: 'reported-model' };
  const pending = await s.open({ instance: 'pending' }, false, [resolved]);
  assertPanel(s, resolved);
  assert.equal(s.c.tabs.get(pending.id).instanceRef, resolved, 'store the resolver result, not the caller reference');
  assert.equal(pending.term.focuses, 0); assert.equal(s.attachments.length, 1);
  pending.gate.resolve({ id: 301 }); await pending.done;
  assertPanel(s, resolved);
  assert.equal(s.c.tabs.size, 1); assert.deepEqual(s.detached, []);
});

test('terminals in two groups bring no panel whichever is focused', async t => {
  const s = shell(t), left = await s.open('left-panel'); s.splitPane('row');
  assertPanel(s, null);
  const right = await s.open('right-panel');
  for (const tab of [left, right, left]) {
    s.event(s.c.tabs.get(tab.id).paneEl, 'pointerdown'); tab.term.input.focus();
    assert.equal(s.c.activeTab, tab.id);
    assertPanel(s, null);
  }
  s.selectTab(right.id); await s.closeTab(right.id); assertPanel(s, null);
  // Reopening an existing terminal moves its original pane into the empty
  // destination, rather than creating a third attachment or copying context.
  const again = await s.open('left-panel');
  assert.equal(again.id, left.id); assertPanel(s, null);
  assert.equal(layout.groupOfTab(s.c.split, left.id).id, 2);
  assert.equal(s.attachments.length, 2); assert.deepEqual(s.detached, [2]);
});

test('a terminal opens no panel in either workspace across A→B→A, without reacquiring retained terminals', async t => {
  const s = shell(t); await s.open('a-panel');
  assertPanel(s, instance('a-panel'));
  s.document.getElementById('workspace').focus(); s.switchTo('B'); assertPanel(s, null);
  await s.open('b-panel'); assertPanel(s, instance('b-panel'));
  s.document.getElementById('workspace').focus(); s.switchTo('A'); assertPanel(s, instance('a-panel'));
  assert.equal(s.document.activeElement.id, 'workspace');
  s.switchTo('B'); assertPanel(s, instance('b-panel'));
  assert.equal(s.attachments.length, 2); assert.deepEqual(s.detached, []);
});

// (The panel-choice races, a late terminal lookup against a click into the panel beside the terminal, went with that
// panel in slice 6a; Details is a tab, whose pane takes selection as every tab's does.)

test('same-name roots/hosts stay distinct and exact-key metadata refresh is focus-neutral', async t => {
  const s = shell(t);
  const local = { ...instance('same'), agentsRoot: '/one/agents', home: '/one/same', model: 'one' };
  const otherRoot = { ...local, agentsRoot: '/two/agents', home: '/two/same', model: 'two' };
  const remote = { ...local, server: 'saved-host', addressable: true, model: 'remote' };
  const roster = [local, otherRoot, remote], opened = [];
  for (const ref of roster) {
    opened.push(await s.open(ref, true, roster)); assertPanel(s, ref); assert.equal(s.c.tabs.get(s.c.activeTab).instanceRef.model, ref.model);
  }
  assert.equal(new Set([...s.c.tabs.values()].map(tab => tab.key)).size, 3);
  assert.deepEqual(structuredClone(s.attachments[2].spec.remote), { serverId: 'saved-host', instance: 'same', home: '/one/same' });
  const selected = opened[0]; s.selectTab(selected.id);
  const input = s.c.tabs.get(selected.id).paneEl.querySelector('textarea') ?? s.terms[0].input; input.focus();
  const ticket = s.c.tabOpenIntents.begin(), exact = { ...local, running: false, model: 'new observation' };
  s.refreshPanelInstance([remote, otherRoot, exact], 'A');
  assert.equal(s.c.tabs.get(selected.id).instanceRef, exact, 'the exact key (home and root), never the same name elsewhere');
  assert.equal(ticket(), true, 'polling is not user intent'); assert.equal(s.document.activeElement, input);
  s.refreshPanelInstance([{ ...local, model: 'foreign workspace' }], 'B');
  assert.equal(s.c.tabs.get(selected.id).instanceRef, exact, 'another workspace\'s poll changes nothing here');
  assert.equal(s.attachments.length, 3); assert.deepEqual(s.detached, []);
});

for (const ambiguity of ['missing', 'duplicate']) test(`${ambiguity} exact-key polling never presents a retained Running observation as current`, async t => {
  const s = shell(t), ref = instance('missing-state'); await s.open(ref);
  const input = s.terms[0].input; input.focus();
  const ticket = s.c.tabOpenIntents.begin();
  s.refreshPanelInstance(ambiguity === 'missing' ? [] : [ref, { ...ref, running: false }], 'A');
  assert.ok(s.panelRoot.hidden || s.field('running') === 'Not reported', 'missing/ambiguous observation must hide or explicitly mark session unknown');
  assert.equal(s.document.activeElement, input); assert.equal(ticket(), true);
  assert.equal(s.attachments.length, 1); assert.deepEqual(s.detached, []);
});
