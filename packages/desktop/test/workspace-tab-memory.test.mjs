import test from "node:test";
import { createInstanceRecency, recencyIdFromTerminalKey } from "../renderer/instance-recency.mjs";
import { viewContext } from "./helpers/view-context.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { createWorkspaceTabMemory } from "../renderer/workspace-tab-memory.mjs";
import { canActivateTab, tabVisibleInContext } from "../renderer/workspace-tabs.mjs";
import { createTabChrome } from "../renderer/tab-a11y.mjs";
import { numberTabStrips } from "../renderer/tab-numbers.mjs";
import { createIntentGate } from "../renderer/open-intent.mjs";
import { createSelectionOwnership } from "../renderer/selection-ownership.mjs";
import { projectSplitDom } from "../renderer/split-dom.mjs";
import {
  requestSplit, openTabInFocusedGroup, focusTab, groupOfTab, isSplitMember, resizeSplitGroups,
} from "../renderer/split-layout.mjs";
import { revealInStrip } from "../renderer/reveal-in-scrollport.mjs";

const source = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
function shellFunction(name) {
  const found = source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  assert.ok(found, `${name} is exercised from the shipped shell`);
  return found[0];
}

function shell(t) {
  const dom = new JSDOM(`<span id="ws-context"></span><div id="stagehost"></div><div id="tabstrip"><div id="tabbar-row"><div id="tabbar"></div><div id="tab-actions"></div></div></div><div id="tabhost"></div><input id="workspace-picker">`);
  t.after(() => dom.window.close());
  const document = dom.window.document;
  const tabs = new Map();
  const tabbar = document.getElementById("tabbar"), tabhost = document.getElementById("tabhost");
  const focusCalls = [];
  for (const [id, workspace, kind] of [[1, "A", "terminal"], [2, "A", "terminal"], [3, "B", "terminal"], [4, "B", "terminal"], [5, "A", "file"], [6, "B", "brain"]]) {
    const tab = { ...createTabChrome(document, id, "same-name", true), workspace, kind,
      key: `${workspace}:${id}`, focusContent: () => focusCalls.push(id) };
    tabbar.append(tab.tabEl); tabhost.append(tab.paneEl); tabs.set(id, tab);
  }
  const context = {
    document, tabs, tabbar, tabhost, focusCalls,
    stageHost: document.getElementById("stagehost"), stage: { name: "hierarchy" },
    tabActionsEl: document.getElementById("tab-actions"),
    workspace: "A", generation: 0, tabWorkspace: "A", contextWorkspace: "A",
    split: null, activeTab: null, sidebarMode: "overview", tabLayerVisible: false,
    contextRosterGen: 0, contextInstances: [], contextRosterEl: null, rosterState: null, rosterStale: false, contextDeploymentNote: null, ...viewContext(), rosterSignaturePainted: null,
    workspaceTabMemory: createWorkspaceTabMemory(),
    // The palette's last-focus record (Spec C), inert here: the shell code under test writes to it.
    instanceRecency: createInstanceRecency({ storage: null }), recencyIdFromTerminalKey,
    wsActiveTerminal: new Map(),
    brainIntents: createIntentGate(),
    workspaceLabel: { reset() {} }, stageSidebarMode: () => "overview",
    setNavActive() {}, refreshContextRoster() {}, renderContextRoster(list) { assert.equal(list.length, 0); },
    // Inert presenter; real shell/panel workspace projection is in split-empty-shell.
    syncContextPanel() {}, updateSplitControls() {},
    currentWorkspace: () => context.workspace, workspaceGeneration: () => context.generation,
    updateActiveContexts: on => { context.tabLayerVisible = on; },
    canActivateTab, tabVisibleInContext, projectSplitDom, resizeSplitGroups,
    isSplitMember, groupOfTab, focusTab, openTabInFocusedGroup,
  };
  context.tabOpenIntents = createSelectionOwnership(context);
  // Spec F: the shipped active-tab reveal runs too (jsdom has no layout or ResizeObserver).
  context.revealInStrip = revealInStrip; context.tabStripResize = null; context.numberTabStrips = numberTabStrips; context.tabNumberObserver = null;
  const api = runInNewContext([
    "setSidebarMode", "updateContextTabs", "showTabLayer", "renderSplit", "selectEmptyGroup", "activateTab", "revealActiveRosterRow", "tabStrips", "revealActiveTabs", "observeTabStrips", "restoreWorkspaceTabs",
  ].map(shellFunction).join("\n") + "\n({ activateTab, restoreWorkspaceTabs, renderSplit });", context);
  return { ...api, context, document, tabs, switchTo(workspace) {
    context.workspace = workspace; context.generation++;
    api.restoreWorkspaceTabs();
  } };
}

const filled = (orientation, a, b) => openTabInFocusedGroup(requestSplit(null, orientation, [a], a).split, b).split;
const visible = tabs => [...tabs].filter(([, tab]) => !tab.paneEl.hidden).map(([id]) => id);

test("shipped workspace transition restores independent layouts, active/focused tabs and sizes without detaching nodes", t => {
  const s = shell(t), c = s.context;
  c.split = filled("row", 1, 2);
  s.activateTab(1);
  // Resize through the REAL separator: model memory must not depend on DOM life.
  const [a, b] = c.tabhost.querySelectorAll(".group-cell");
  a.getBoundingClientRect = b.getBoundingClientRect = () => ({ width: 400, height: 200 });
  a.querySelector(".split-resizer").dispatchEvent(new s.document.defaultView.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  const layoutA = structuredClone(c.split);
  assert.equal(layoutA.groups[0].weight, 1.1);
  const picker = s.document.getElementById("workspace-picker"); picker.focus();
  s.switchTo("B");
  assert.deepEqual(visible(s.tabs), [], "empty destination hides every old pane synchronously");
  for (const tab of s.tabs.values()) assert.equal(tab.paneEl.classList.contains("active"), false,
    "hidden terminals must also be inactive for readiness/focus callbacks and CSS");
  assert.equal(s.activateTab(1), false, "even explicit activation cannot expose the foreign terminal");
  for (const tab of s.tabs.values()) assert.ok(tab.paneEl.isConnected && tab.tabEl.isConnected);
  c.split = filled("col", 3, 4); s.activateTab(4);
  const layoutB = structuredClone(c.split);
  s.switchTo("A");
  assert.deepEqual(c.split, layoutA);
  assert.equal(c.activeTab, 1);
  assert.deepEqual(visible(s.tabs), [1, 2]);
  assert.equal(c.tabhost.querySelector(".group-cell").style.flexGrow, "1.1");
  assert.equal(s.document.activeElement, picker, "workspace restoration must not steal terminal focus");
  assert.deepEqual(c.focusCalls, [], "no content focus/attachment on layout restoration");
  s.switchTo("B");
  assert.deepEqual(c.split, layoutB); assert.equal(c.activeTab, 4);
  assert.deepEqual(visible(s.tabs), [3, 4]);
  for (const tab of s.tabs.values()) assert.ok(tab.paneEl.isConnected && tab.tabEl.isConnected);
});

test("files and brains join the focused group beside the terminals, and hide with their workspace (slice 6a)", t => {
  const s = shell(t), c = s.context;
  c.split = resizeSplitGroups(requestSplit(null, "row", [1, 2], 1).split, [{ id: 1, weight: .6 }, { id: 2, weight: 1.4 }]);
  s.activateTab(1, { keepGroupFocus: true });
  s.activateTab(5); // a file opens into the focused (empty) group, beside the terminal: no tab kind covers another
  assert.deepEqual(visible(s.tabs), [1, 5]);
  assert.deepEqual(c.split.groups.map(g => g.tabs), [[1, 2], [5]]);
  const layoutA = structuredClone(c.split);
  s.switchTo("B");
  assert.deepEqual(visible(s.tabs), []);
  assert.equal(s.tabs.get(5).tabEl.hidden, true);
  assert.equal(s.activateTab(5), false);
  s.activateTab(6);
  s.switchTo("A");
  assert.equal(c.activeTab, 5); assert.deepEqual(visible(s.tabs), [1, 5]);
  assert.deepEqual(c.split, layoutA, "the layout comes back with its file in its group");
  assert.deepEqual([...c.tabhost.querySelectorAll(".group-cell")].map(el => el.style.flexGrow), ["0.6", "1.4"]);
  s.switchTo("B"); assert.equal(c.activeTab, 6); assert.deepEqual(visible(s.tabs), [6]);
});

test("memory snapshots do not alias callers and never resurrect closed/foreign tabs", () => {
  const memory = createWorkspaceTabMemory();
  const split = filled("row", 1, 2);
  memory.remember("A", { split, activeTab: 2, sidebarMode: "instances", tabLayerVisible: true });
  split.groups[0].tabs.push(999);
  const entries = new Map([[1, { kind: "terminal", workspace: "A" }], [2, { kind: "terminal", workspace: "B" }]]);
  const state = memory.recall("A", entries);
  assert.equal(state.activeTab, null, "pruned active tab leaves its destination empty, not a different terminal selected");
  assert.deepEqual(state.split.groups.map(g => g.tabs), [[1], []]);
  assert.equal(state.split.focusedGroup, 2);
  assert.equal(state.tabLayerVisible, true);
  const empty = memory.recall("A", []);
  assert.equal(empty.activeTab, null); assert.equal(empty.tabLayerVisible, true);
  assert.deepEqual(empty.split.groups.map(g => g.tabs), [[], []]);
  assert.equal(memory.recall("B", entries).split, null);
});
