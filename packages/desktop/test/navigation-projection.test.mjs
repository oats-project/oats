// Exercise shipped shell ordering, including real nav classes, layer/context
// projection, split DOM reparenting and native focusin. Only view loading and
// roster I/O are synthetic; no browser/server, Electron, IPC or terminal writes.
import test from "node:test";
import { createInstanceRecency, recencyIdFromTerminalKey } from "../renderer/instance-recency.mjs";
import { viewContext } from "./helpers/view-context.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { withShellWindowGlobals } from './helpers/shell-window-globals.mjs';
import { JSDOM } from "jsdom";
import { NAV, NAV_TABS, PINNED, pinnedRowFor, navTab, stageSidebarMode } from "../renderer/shell-nav.mjs";
import { isShown } from "../renderer/focus-regions.mjs";
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

// Live evidence 13/14 used the hover token #f0e9d2, not selected #dce7e8.
// The driver's last click (123.5, 112.03125) remained over Souls after the
// workspace menu closed (the menu is now the sidebar's always-shown list). JSDOM cannot prove browser hit-testing/hover; these
// tests assert real .active classes instead of inferring selection from pixels.
const source = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function shell(t, shellSource = source) {
  const dom = new JSDOM(`<body><span id="ws-context"></span><aside><section id="ws-list"><div id="ws-options"><button type="button" class="ws-option" tabindex="0" data-workspace-id="B">B</button></div></section><nav id="nav"></nav><div id="nav-foot"></div></aside>
    <div id="stagehost"></div><div id="tabstrip"><div id="tabbar-row"><div id="tabbar"></div><div id="tab-actions"></div></div></div><div id="tabhost"></div>`);
  t.after(() => dom.window.close());
  const document = dom.window.document, loads = [], contexts = [], focusCalls = [], navWrites = [], preselected = [], regionCalls = [];
  const navEl = document.getElementById("nav");
  for (const view of PINNED) { // the rows the shell pins (Home, Workspace, Automations: slice 2b)
    const b = document.createElement("button"); b.className = "nav-item";
    b.dataset.view = view.name; b.textContent = view.label; navEl.append(b);
  }
  const c = {
    document, console, navigator: { platform: "MacIntel" }, NAV, NAV_TABS, navTab, pinnedRowFor, stageSidebarMode, isShown,
    // The Workspace page's module, as openWorkspaceSouls imports it: only its tab preselection is read.
    loadSpawnView: async () => ({ preselectWorkspaceTab: tab => { preselected.push(tab); return true; } }),
    focusRegions: { focusRegion: name => { regionCalls.push(name); return false; } },
    workspace: "A", generation: 0, tabWorkspace: "A", contextWorkspace: "A", activeInstanceMenu: null,
    stage: null, stageOp: 0, stageHost: document.getElementById("stagehost"), navEl,
    tabs: new Map(), nextTabId: 1, activeTab: null, split: null, sidebarMode: "overview", tabLayerVisible: false,
    contextRosterGen: 0, contextInstances: [], contextRosterEl: null, rosterState: null, rosterStale: false, contextDeploymentNote: null, ...viewContext(), rosterSignaturePainted: null,
    tabbar: document.getElementById("tabbar"), tabhost: document.getElementById("tabhost"),
    tabActionsEl: document.getElementById("tab-actions"),
    // The palette's last-focus record (Spec C), inert here: the shell code under test writes to it.
    instanceRecency: createInstanceRecency({ storage: null }), recencyIdFromTerminalKey,
    wsActiveTerminal: new Map(), workspaceTabMemory: createWorkspaceTabMemory(), brainIntents: createIntentGate(),
    currentWorkspace: () => c.workspace, workspaceGeneration: () => c.generation,
    setActiveContexts: value => contexts.splice(0, contexts.length, ...value),
    workspaceLabel: { reset() {} }, refreshContextRoster() {}, renderContextRoster() {}, updateSplitControls() {}, revealInStrip, tabStripResize: null /* spec F: the shipped active-tab reveal runs too */, numberTabStrips, tabNumberObserver: null,
    createSelectionOwnership, wirePaneSelection, createViewLifecycle, createTabChrome, tabKeyAction, focusAfterLastTab,
    reserveKey, whenKeyFree, prepareOwnedOpen, projectSplitDom, ...layout, ...workspaceTabs,
    loadStageView(name) { const gate = { ...deferred(), name }; loads.push(gate); return gate.promise; },
    // These fixtures mount inert views; panel ownership is tested separately.
    syncContextPanel() {}, contextPanel: {},
    createPanelOwner: () => ({ dispose() {} }),
    ctx: { notify: message => assert.fail(`unexpected notice: ${message}`) },
  };
  const names = ["closeStage", "showStage", "setNavActive", "showTabLayer", "updateActiveContexts", "setSidebarMode", "updateContextTabs",
    "addTab", "selectTab", "activateTab", "revealActiveRosterRow", "closeTab", "tabStrips", "revealActiveTabs", "observeTabStrips", "onTabKeydown", "walkedTabs", "visibleTabEntries", "renderSplit", "selectEmptyGroup", "restoreWorkspaceTabs", "showTerminalContext", "openViewTab", "openWorkspaceSouls", "showStageFocused", "openWorkspaceTabFocused"];
  const functions = names.map(name => {
    const match = shellSource.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
    assert.ok(match, `execute shipped ${name}`); return match[0];
  }).join("\n").replace('import(`./views/${name}.mjs`)', "loadStageView(name)").replace('import("./views/spawn.mjs")', "loadSpawnView()");
  const setup = [/const tabOpenIntents = [^\n]+/, /const WORKSPACE_TAB_NAMES = [^\n]+/].map(re => shellSource.match(re)[0]).join("\n");
  const s = runInNewContext(`${setup}\n${functions}\n({ ${names.join(", ")}, tabOpenIntents });`, withShellWindowGlobals(c));
  // Trace actual class writes, not a fake setNavActive implementation. Useful
  // when a synchronous focus restoration re-enters the shell during projection.
  for (const b of navEl.children) {
    const toggle = b.classList.toggle.bind(b.classList);
    b.classList.toggle = (name, on) => { if (name === "active" && on) navWrites.push(b.dataset.view); return toggle(name, on); };
    b.addEventListener("click", () => s.showStage(b.dataset.view));
  }
  return {
    ...s, c, document, loads, contexts, focusCalls, navWrites, preselected, regionCalls,
    nav: () => [...navEl.querySelectorAll(".active")].map(b => b.dataset.view),
    // A row of the workspace list: where focus is when the operator picks a workspace there.
    listRow: () => document.querySelector("#ws-options .ws-option"),
    seed(kind = "terminal", title = `${c.workspace}-${kind}`) {
      const made = s.addTab({ title, key: `${c.workspace}:${c.nextTabId}`, kind,
        focusContent: () => focusCalls.push(made.id) });
      const input = document.createElement("textarea"); made.paneEl.append(input);
      return { ...made, input };
    },
    async stage(name) {
      const done = s.showStage(name); await tick();
      if (!c.stage || c.stage.name !== name) {
        assert.equal(loads.at(-1).name, name);
        loads.at(-1).resolve({ mount(el) { el.textContent = name; return () => {}; } });
      }
      await done;
    },
    switchTo(workspace) { c.workspace = workspace; c.generation++; s.restoreWorkspaceTabs(); },
    snapshot() { return structuredClone({ split: c.split, activeTab: c.activeTab, sidebarMode: c.sidebarMode,
      tabLayerVisible: c.tabLayerVisible, nav: this.nav(), contexts,
      panes: [...c.tabs].filter(([, tab]) => !tab.paneEl.hidden).map(([id]) => id) }); },
  };
}
function filled(orientation, ids, weights) {
  const model = layout.openTabInFocusedGroup(layout.requestSplit(null, orientation, ids.slice(0, -1), ids[0]).split, ids.at(-1)).split;
  return layout.resizeSplitGroups(model, model.groups.map((g, i) => ({ id: g.id, weight: weights[i] })));
}
function terminalForeground(s) {
  assert.equal(s.c.tabs.get(s.c.activeTab).kind, "terminal");
  assert.equal(s.c.tabLayerVisible, true);
  assert.equal(s.c.stageHost.style.display, "none");
  assert.deepEqual(s.nav(), [], "terminal foreground must have no active stage nav");
  assert.deepEqual(s.contexts, ["tabs"]);
}

test("live-driver order: covered Souls stage → independent A/B splits → A has no active stage nav", async t => {
  const s = shell(t); await s.stage("spawn");
  const a1 = s.seed(), a2 = s.seed(); s.seed("file", "notes.md"); s.seed("file", "viewer.js"); const a3 = s.seed();
  s.c.split = filled("row", [a1.id, a2.id, a3.id], [1.3, .7]); s.selectTab(a3.id);
  terminalForeground(s); const a = s.snapshot();
  const row = s.listRow(); row.focus(); s.switchTo("B");
  const b1 = s.seed(), b2 = s.seed();
  s.c.split = filled("col", [b1.id, b2.id], [1.2, .8]); s.selectTab(b2.id);
  terminalForeground(s); const b = s.snapshot();
  for (const [ws, expected] of [["A", a], ["B", b], ["A", a]]) {
    s.navWrites.length = 0;
    s.switchTo(ws); terminalForeground(s); assert.deepEqual(s.snapshot(), expected);
    assert.deepEqual(s.navWrites, [], "restoration must not transiently select a covered stage either");
    assert.equal(s.document.activeElement, row, "workspace restoration never focuses terminal content");
  }
  assert.deepEqual(s.focusCalls, []);
  for (const tab of s.c.tabs.values()) assert.ok(tab.paneEl.isConnected && tab.tabEl.isConnected);
});

async function restoredFile(t, context, shellSource = source) {
  const s = shell(t, shellSource), expected = context === "souls" ? ["spawn"] : []; // the Workspace page's own row (slice 2b)
  await s.stage(context === "souls" ? "spawn" : "automations");
  if (context === "instances") s.seed();
  const file = s.seed("file");
  assert.deepEqual(s.nav(), expected);
  s.listRow().focus();
  s.switchTo("B"); await s.stage(context === "souls" ? "automations" : "spawn");
  s.switchTo("A");
  assert.equal(s.c.activeTab, file.id); assert.equal(s.c.sidebarMode, context);
  assert.deepEqual(s.nav(), expected, "file restoration must project remembered context instead of inheriting the other workspace's nav");
  assert.deepEqual(s.contexts, ["tabs"]);
  assert.equal(s.document.activeElement, s.listRow());
}
for (const context of ["instances", "souls"]) {
  test(`restored file projects its remembered ${context} context, not B's stage highlight`, t => restoredFile(t, context));
  test(`mutation: file nav projection cannot depend on changing sidebar mode (${context})`, async t => {
    const from = `  } else if (current?.kind === "file") {\n    if (sidebarMode !== "instances" && sidebarMode !== "souls") setSidebarMode("instances");`;
    const to = `  } else if (current?.kind === "file" && sidebarMode !== "instances" && sidebarMode !== "souls") {\n    setSidebarMode("instances");`;
    assert.ok(source.includes(from));
    await assert.rejects(restoredFile(t, context, source.replace(from, to)), /file restoration must project remembered context/);
  });
}

test("brain restoration keeps Souls navigation; returning to a stage reflects the visible stage", async t => {
  const s = shell(t); await s.stage("spawn"); const brain = s.seed("brain");
  s.switchTo("B"); await s.stage("automations"); s.switchTo("A");
  assert.equal(s.c.activeTab, brain.id); assert.deepEqual(s.nav(), ["spawn"]);
  await s.stage("automations");
  assert.equal(s.c.tabLayerVisible, false); assert.deepEqual(s.nav(), ["automations"]);
  assert.deepEqual(s.contexts, ["stage:automations"]);
});

for (const boundary of ["load", "mount"]) for (const outcome of ["resolve", "reject"]) {
  test(`late stage ${boundary} ${outcome} cannot change restored terminal foreground/nav/focus`, async t => {
    const s = shell(t); await s.stage("spawn"); const a = s.seed();
    const pending = s.showStage("automations"); await tick();
    const gate = boundary === "load" ? s.loads.at(-1) : deferred();
    if (boundary === "mount") { s.loads.at(-1).resolve({ mount: () => gate.promise }); await tick(); }
    s.selectTab(a.id); const row = s.listRow(); row.focus();
    s.switchTo("B"); s.seed(); s.switchTo("A"); const before = s.snapshot();
    if (outcome === "resolve") gate.resolve(boundary === "load" ? { mount() {} } : undefined);
    else gate.reject(new Error("late stage failure"));
    await pending;
    terminalForeground(s); assert.deepEqual(s.snapshot(), before);
    assert.equal(s.document.activeElement, row); assert.deepEqual(s.focusCalls, []);
  });
}

for (const boundary of ["load", "mount"]) for (const outcome of ["resolve", "reject"]) {
  // Two pages of their own (Workspace, Automations; the product owner, 2026-10-26): from no stage, the older switch and the newer one are
  // three distinct states, so neither "the older one" nor "where it started" can pass for the newer.
  test(`late stage ${boundary} ${outcome} preserves a newer real stage selection (not a blanket nav reset)`, async t => {
    const s = shell(t);
    const old = s.showStage("automations"); await tick();
    const gate = boundary === "load" ? s.loads.at(-1) : deferred();
    if (boundary === "mount") { s.loads.at(-1).resolve({ mount: () => gate.promise }); await tick(); }
    const newer = s.showStage("spawn");
    if (outcome === "resolve") gate.resolve(boundary === "load" ? { mount() {} } : undefined);
    else gate.reject(new Error("superseded stage failure"));
    await old; await tick();
    assert.equal(s.loads.at(-1).name, "spawn");
    s.loads.at(-1).resolve({ mount() {} }); await newer;
    assert.deepEqual(s.nav(), ["spawn"]); assert.deepEqual(s.contexts, ["stage:spawn"]);
    assert.equal(s.c.tabLayerVisible, false);
  });
}

for (const outcome of ["resolve", "reject"]) test(`older artifact module ${outcome} cannot replace restored terminal navigation`, async t => {
  const s = shell(t); await s.stage("spawn"); s.seed();
  const pending = s.openViewTab("markdown", "old file"); await tick(); const gate = s.loads.at(-1);
  s.listRow().focus(); s.switchTo("B"); s.seed(); s.switchTo("A");
  const before = s.snapshot();
  if (outcome === "resolve") gate.resolve({ mount() { assert.fail("stale artifact must not mount"); } });
  else gate.reject(new Error("old file module failure"));
  await pending;
  terminalForeground(s); assert.deepEqual(s.snapshot(), before); assert.equal(s.c.tabs.size, 2);
  assert.equal(s.document.activeElement, s.listRow());
});

async function reentrantFocus(t, shellSource = source) {
  const s = shell(t, shellSource); await s.stage("spawn"); const first = s.seed(), second = s.seed();
  s.selectTab(first.id); first.input.focus();
  const intent = s.tabOpenIntents.begin();
  s.c.split = filled("row", [first.id, second.id], [1.3, .7]);
  s.selectTab(second.id, { intent }); // projectSplitDom reparents the focused first input
  terminalForeground(s);
  assert.equal(s.c.activeTab, second.id, "restoring first input focus must not re-enter selectTab(first)");
  assert.equal(intent(), true); assert.equal(s.document.activeElement, first.input);
  assert.equal(s.c.split.focusedGroup, s.c.split.groups[1].id);
  assert.deepEqual(s.focusCalls, []);
}
test("retained split focus restoration is not a second explicit selection", t => reentrantFocus(t));
test("mutation: restored focusin must not re-enter tab selection", async t => {
  const guard = "isApplyingFocus: () => tabOpenIntents.isApplyingFocus(),";
  assert.ok(source.includes(guard));
  await assert.rejects(reentrantFocus(t, source.replace(guard, "isApplyingFocus: () => false,")), /restoring first input focus must not re-enter/);
});

// ── Machines is a tab of the Workspace page (the product owner, 2026-10-26) ─────────────
// stage.hierarchy (⌘1 / Ctrl+1), the palette's "View: Workspace › Machines", a deployment tab request and
// ctx.openView("hierarchy") all run showStage("hierarchy"): the shipped showStage routes the NAV_TABS name through
// openWorkspaceSouls, which preselects the Machines tab and shows the Workspace page. No "hierarchy" page loads.
async function machinesFrom(t, start, shellSource = source) {
  const s = shell(t, shellSource);
  if (start) await s.stage(start);
  const before = s.loads.length, done = s.showStageFocused("hierarchy");
  for (let i = 0; i < 3 && s.loads.length === before; i++) await tick();
  if (start !== "spawn") { assert.equal(s.loads.at(-1).name, "spawn"); s.loads.at(-1).resolve({ mount(el) { el.textContent = "spawn"; return () => {}; } }); }
  await done;
  return s;
}
test("the sidebar's views: Home, the Workspace page (its own row again: slice 2b) and Automations, each a page; Machines is the Workspace page's tab", () => {
  assert.deepEqual(NAV.map(v => [v.name, v.label]), [["home", "Home"], ["spawn", "Workspace"], ["automations", "Automations"]]);
  assert.deepEqual(NAV.filter(v => v.pinned !== false).map(v => v.name), ["home", "spawn", "automations"]);
  assert.deepEqual(NAV_TABS, [{ name: "hierarchy", label: "Workspace › Machines", page: "spawn", tab: "machines" }]);
  assert.deepEqual(navTab("hierarchy"), NAV_TABS[0]);
  assert.equal(navTab("automations"), null, "a page of its own again"); assert.equal(navTab("spawn"), null);
});
for (const start of [null, "automations"]) test(`stage.hierarchy from ${start ?? "no stage"}: the Workspace page, its Machines tab preselected`, async t => {
  const s = await machinesFrom(t, start);
  assert.deepEqual(s.preselected, ["machines"], "the tab is chosen before the page shows");
  assert.equal(s.c.stage.name, "spawn");
  assert.ok(!s.loads.some(load => load.name === "hierarchy"), "Machines is no page of its own");
  assert.deepEqual(s.nav(), ["spawn"], "the Workspace row is the current one, never Home's (slice 2b)");
  assert.equal(s.c.sidebarMode, "souls"); assert.deepEqual(s.contexts, ["stage:spawn"]);
  // showStageFocused compares the stage on screen with the PAGE (spawn), so a keyboard open keeps focus on a control.
  assert.deepEqual(s.regionCalls, ["main"], "focus was on <body>: the stage's first control");
});

// The Desktop UI rework, slice 2b (supersedes slice 2's "Home's row stands for the Workspace page"; Pepe, 2026-11-20):
// the Workspace page has its own pinned row, and every way onto it marks that row, never Home's. Home's row marks
// Home (and Home › Agents, a view of Home's own stage) only.
test("slice2b workspace row highlights for workspace pages", async t => {
  const shipped = { tile: "openWorkspaceTab: (tab, options) => openWorkspaceTabFocused(tab, options),",
    palette: '...["souls", "capabilities", "teams", "sources"].map((tab) => ({ label: `Workspace › ${WORKSPACE_TAB_NAMES[tab]}`, run: () => openWorkspaceSouls(tab) })),',
    key: "...[...NAV, ...NAV_TABS].map((v) => ({ label: v.label, detail: chordDetail(`stage.${v.name}`), run: () => showStageFocused(v.name) })),",
    row: "b.addEventListener(\"click\", () => runAction(`stage.${v.name}`));" };
  for (const [what, line] of Object.entries(shipped)) assert.ok(source.includes(line), `${what}: the shipped route onto the page`);
  const routes = { tile: s => s.openWorkspaceTabFocused("souls"), palette: s => s.openWorkspaceSouls("souls"), "Mod+2": s => s.showStageFocused("spawn"),
    "its row": s => s.showStage("spawn"), "Workspace › Machines": s => s.showStageFocused("hierarchy") };
  for (const [via, open] of Object.entries(routes)) {
    const s = shell(t); await s.stage("home");
    assert.deepEqual(s.nav(), ["home"], "Home's row on Home");
    s.navWrites.length = 0;
    const before = s.loads.length, done = open(s);
    for (let i = 0; i < 3 && s.loads.length === before; i++) await tick();
    s.loads.at(-1).resolve({ mount(el) { el.innerHTML = '<div role="tablist"><button id="workspace-tab-souls" role="tab">Souls</button></div>'; return () => {}; } });
    await done;
    assert.equal(s.c.stage.name, "spawn", via);
    assert.deepEqual(s.nav(), ["spawn"], `${via}: the Workspace row, not Home's`);
    assert.ok(!s.navWrites.includes("home"), `${via}: Home's row is never marked on the way`);
    assert.equal(s.document.querySelector('#nav [data-view="spawn"]').classList.contains("active"), true);
  }
  // A soul's or capability's page is the Workspace page (views/spawn.mjs): its row too; its files (a brain tab) as well.
  const s = shell(t); await s.stage("spawn"); s.seed("brain");
  assert.deepEqual(s.nav(), ["spawn"]);
});

test("stage.hierarchy while the Workspace page is on screen switches its tab, without reloading the page", async t => {
  const s = await machinesFrom(t, "spawn");
  assert.deepEqual(s.preselected, ["machines"]);
  assert.equal(s.loads.length, 1, "the page already on screen stays mounted");
  assert.equal(s.c.stage.name, "spawn"); assert.deepEqual(s.nav(), ["spawn"]);
  assert.deepEqual(s.regionCalls, ["main"]);
});

test("stage.automations loads the Automations page itself: no tab of the Workspace page is preselected", async t => {
  const s = shell(t); await s.stage("spawn");
  const done = s.showStageFocused("automations"); await tick();
  assert.equal(s.loads.at(-1).name, "automations", "its own page loads");
  s.loads.at(-1).resolve({ mount(el) { el.textContent = "automations"; return () => {}; } }); await done;
  assert.deepEqual(s.preselected, []);
  assert.equal(s.c.stage.name, "automations"); assert.deepEqual(s.nav(), ["automations"]);
  assert.equal(s.c.sidebarMode, "overview"); assert.deepEqual(s.contexts, ["stage:automations"]);
});

test("mutation: showStageFocused must compare the stage with the NAV_TABS page, not the name", async t => {
  const page = "page = navTab(name)?.page ?? name;";
  assert.ok(source.includes(page));
  const s = await machinesFrom(t, "automations", source.replace(page, "page = name;"));
  assert.equal(s.c.stage.name, "spawn");
  assert.deepEqual(s.regionCalls, [], "comparing against \"hierarchy\" leaves focus on <body>");
});

test("mutation: showStage must route a NAV_TABS name to its page", async t => {
  const route = "if (asTab) return openWorkspaceSouls(asTab.tab);";
  assert.ok(source.includes(route));
  const s = shell(t, source.replace(route, ""));
  void s.showStage("hierarchy"); await tick();
  assert.equal(s.loads.at(-1).name, "hierarchy", "without the route it would load a page the sidebar no longer has");
  assert.deepEqual(s.preselected, []);
});
