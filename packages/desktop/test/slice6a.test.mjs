// The Desktop UI rework, slice 6a: pages as tabs, Details for any agent, the collapsed rail, Home off the sidebar's
// DOM. The spec's pinned acceptance tests, by name. The shell's own functions run as shipped (extracted from
// shell.mjs into a context of doubles), so the tests pin the code the app runs, not a copy of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { NAV, NAV_TABS, PINNED, navTab, pinnedRowFor } from "../renderer/shell-nav.mjs";
import { requestSplit, groupOfTab, removeSplitTab } from "../renderer/split-layout.mjs";
import { splitControlsState } from "../renderer/split-controls.mjs";
import { tabVisibleInContext, canActivateTab } from "../renderer/workspace-tabs.mjs";
import { createSidebarRail } from "../renderer/sidebar-rail.mjs";
import { createContextPanel, contextPanelCSS } from "../renderer/context-panel.mjs";
import { createHome } from "../renderer/views/home.mjs";
import { homeAgents } from "../../client/home-board.mjs";
import { PIN_FEATURE } from "../../client/instance-tree.mjs";

const shell = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
const fn = (name) => {
  const match = shell.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, `shell.mjs ships ${name}`);
  return match[0];
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The shipped page opener (showStage) over a tab table and a split: openViewTab, selectTab and openWorkspaceSouls
 * are doubles that record what they were asked. */
function pages({ split = null, open = [] } = {}) {
  const tabs = new Map(open.map((t, i) => [i + 1, { workspace: "A", ...t }]));
  const c = { tabs, split, NAV, navTab, canActivateTab, groupOfTab, removeSplitTab, opened: [], selected: [], souls: [],
    windowState: () => "bound", showChooser() {}, hideEmptyState() {}, currentWorkspace: () => "A", nextTabId: 1,
    openWorkspaceSouls: (tab) => { c.souls.push(tab); },
    selectTab: (id) => { c.selected.push(id); return true; },
    openViewTab: async (name, title, extra, key, kind) => { c.opened.push({ name, title, key, kind }); const id = tabs.size + 1; tabs.set(id, { kind, page: name, workspace: "A" }); return id; } };
  const run = runInNewContext(`${fn("showStage")}\nconst pageOpens = new Map();\n({ showStage })`, c);
  return { c, showStage: run.showStage };
}

test("slice6a pages open as tabs", async () => {
  // Home, the Workspace page and Automations open as tabs of kind "page", through openViewTab, keyed per page.
  const { c, showStage } = pages();
  await showStage("home"); await showStage("spawn"); await showStage("automations");
  assert.deepEqual(c.opened.map((o) => [o.name, o.kind, o.key.replace(/\d+$/, "N")]),
    [["home", "page", "page:home:N"], ["spawn", "page", "page:spawn"], ["automations", "page", "page:automations"]]);
  assert.equal(c.opened[0].title, "Home");
  // A Workspace section (Machines, NAV_TABS) opens the Workspace page on that tab; so does a soul's or capability's
  // page (openWorkspaceSouls and the preselect hand-offs, below).
  await showStage("hierarchy");
  assert.deepEqual(c.souls, ["machines"]);
  assert.match(fn("openWorkspaceSouls"), /mod\.preselectWorkspaceTab\(tab, options\);\n  await showStage\("spawn"\);/);
  assert.match(shell, /mod\.preselectHome\(instance\); await showStage\("spawn"\);/, "a soul's capabilities page: the Workspace tab");
  // A pinned row focuses the page's open tab, else opens one: a second ask selects the tab it opened.
  const again = pages({ open: [{ kind: "page", page: "automations" }] });
  await again.showStage("automations");
  assert.deepEqual(again.c.selected, [1]); assert.deepEqual(again.c.opened, []);
  assert.deepEqual(PINNED.map((v) => v.name), ["home", "automations"]);
  assert.match(shell, /b\.addEventListener\("click", \(\) => runAction\(`stage\.\$\{v\.name\}`\)\);/, "a pinned row runs its page's action");
  // Home is one per pane: a Home in another group isn't reused for the focused one; one in it is.
  const split = { orientation: "row", nextId: 3, groups: [{ id: 1, tabs: [1], activeTab: 1 }, { id: 2, tabs: [], activeTab: null }], focusedGroup: 2 };
  const home = pages({ split, open: [{ kind: "page", page: "home" }] });
  await home.showStage("home");
  assert.equal(home.c.opened.length, 1, "a new Home for the focused pane");
  home.c.split = { ...split, groups: [{ id: 1, tabs: [1], activeTab: 1 }, { id: 2, tabs: [2], activeTab: 2 }] };
  await home.showStage("home");
  assert.deepEqual(home.c.selected, [2], "the focused pane's own Home is focused");
  // A one-tab page open in another pane moves to the focused one.
  assert.match(fn("showStage"), /if \(!here && split && focusedGroup && groupOfTab\(split, reuse\[0\]\)\) split = \{ \.\.\.removeSplitTab\(split, reuse\[0\]\)\.split, focusedGroup: focusedGroup\.id \};/);
  // Every tab kind lives in the strip and the groups: a page beside a terminal.
  assert.equal(tabVisibleInContext({ kind: "page", workspace: "A" }, "instances", "A"), true);
  assert.equal(splitControlsState(null, 1, "page", true).visible, true, "a page tab can split");
  // The page names its tab: the Workspace page by its section or capability.
  assert.match(readFileSync(new URL("../renderer/views/spawn.mjs", import.meta.url), "utf8"), /pageTitle\(s, SECTION_TITLES\[tab\]\);/);
});

test("slice6a new pane opens Home", async () => {
  const tabs = new Map([[1, { kind: "terminal", workspace: "A" }]]);
  const c = { tabs, split: null, activeTab: 1, tabLayerVisible: true, canActivateTab, requestSplit, splitControlsState, currentWorkspace: () => "A",
    asked: [], tabOpenIntents: { invalidate() {}, watch: () => () => true }, activateTab() {}, focusRoster() {},
    showStage: async (name) => { c.asked.push(name); } };
  const run = runInNewContext(`${fn("splitPane")}\n({ splitPane })`, c);
  run.splitPane("row");
  await settle();
  assert.equal(c.split.groups.length, 2);
  assert.deepEqual(c.split.groups[1].tabs, [], "a new, focused pane");
  assert.equal(c.split.focusedGroup, c.split.groups[1].id);
  assert.deepEqual(c.asked, ["home"], "the new pane opens Home as its first tab");
});

function panel(t) {
  const dom = new JSDOM(`<!doctype html><body><div id="app"><main id="main"><div class="tab-pane"></div></main><aside id="context-panel"></aside></div></body>`);
  const document = dom.window.document, style = document.createElement("style"); style.textContent = contextPanelCSS; document.head.append(style);
  const p = createContextPanel({ document, root: document.getElementById("context-panel"), createTeamsSection: () => ({ update() {}, dispose() {} }), openSoul() {} });
  t.after(() => { p.dispose(); dom.window.close(); });
  return { document, p, q: (s) => document.querySelector(s), row: (id) => document.querySelector(`#context-panel [data-row="${id}"]`),
    field: (id) => document.querySelector(`[data-context-field="${id}"]`) };
}
const stopped = (extra = {}) => ({ instance: "web-developer-1", agent: "web-developer", agentsRoot: "/w/agents", home: "/w/agents/web-developer/instances/web-developer-1",
  repoName: "northwind", branch: "feat/checkout", harness: "claude", model: "opus", modelFrom: "soul", work: "worktree", running: false,
  createdAt: "2026-11-19T10:00:00.000Z", attributedHuman: "Joan", parentInstance: "lead-1", tmux: { session: "oats-agents" }, ...extra });

test("slice6a details for a stopped agent", (t) => {
  // Details shows the roster's row for the agent asked for: no terminal is needed (key: an open terminal's, or none).
  const sync = fn("syncContextPanel");
  assert.match(sync, /const details = tab\?\.kind === "details" && canActivateTab\(tab, currentWorkspace\(\)\);/);
  assert.match(sync, /const instance = details \? liveRow\(tab\.detailsRef\) : null;/);
  assert.match(sync, /instance, key: terminalKey,/);
  const u = panel(t);
  u.p.setContext({ workspace: "A", instance: stopped(), key: null });
  const text = u.q("#context-panel").textContent;
  assert.match(text, /web-developer/, "soul");
  assert.match(u.field("harness").textContent, /Claude/); assert.match(u.field("model").textContent, /opus/, "harness · model");
  assert.match(u.q("[data-context-work]").textContent, /northwind/, "repository"); assert.match(u.q("[data-context-work]").textContent, /feat\/checkout/, "branch");
  assert.match(u.row("attributedHuman").textContent, /Joan/, "started by");
  assert.match(u.field("createdAt").textContent.trim(), /\S/, "created");
  assert.match(text, /Stopped/);
  // Every way in: i on a row, Ctrl+Shift+I (panel.toggle), the row's menu and the palette.
  assert.match(shell, /if \(e\.key !== "i" \|\| e\.altKey \|\| e\.ctrlKey \|\| e\.metaKey \|\| e\.shiftKey \|\| typeof openDetailsTab !== "function"\) return;\n          e\.preventDefault\(\); openDetailsTab\(i\);/);
  assert.match(shell, /registerAction\(\{ id: "panel\.toggle", label: "Agent: Details"/);
  assert.match(shell, /\{ action: 'details', actionId: 'panel\.toggle', label: 'Details', reason: '', always: true, secondary: true \},/);
  assert.match(shell, /if \(action === 'details'\) \{ openDetailsTab\(instance\); return; \}/);
  assert.match(shell, /\{ label: "Agent: Details", detail: chordDetail\("panel\.toggle"\)/);
});

test("slice6a details keeps every old panel fact", (t) => {
  // Details is the old instance panel's own content in a tab (placeContextPanel moves it into the Details pane), so
  // each fact the panel showed is where it was, for any row. One assertion per fact, at its place in Details.
  const u = panel(t);
  u.p.setContext({ workspace: "A", instance: stopped({ running: true, startedAt: "2026-11-19T11:00:00.000Z", siblingInstance: "web-developer-2", identityAddress: "oats.aweb.ai/web-developer-1" }), key: null,
    waiting: { since: "2026-11-19T11:30:00.000Z", producer: "agent", reason: "attention", message: "Pick the copy" } });
  const q = u.q;
  assert.ok(q('[data-context-tab="instance"]'), "the Instance page"); assert.ok(q('[data-context-tab="soul"]'), "the Soul page");
  assert.ok(q('[data-context-tab="git"]'), "the Developer page (Git, the pull request): the folded Git section");
  assert.ok(q(".context-panel-identity-name"), "the name"); assert.ok(q('[data-context-section="waiting"]'), "Needs input");
  assert.ok(q("[data-context-work]"), "Work: the mode and its sentence"); assert.ok(u.row("workFolder"), "Paths: the folder"); assert.ok(u.row("home"), "Paths: the home");
  assert.ok(u.field("harness"), "Session: the harness"); assert.ok(u.field("model"), "the model"); assert.ok(u.field("modelFrom"), "where the model came from");
  assert.match(q(".context-panel-session-tmux").textContent, /oats-agents/, "the tmux session"); assert.ok(u.field("startedAt"), "started"); assert.ok(u.field("createdAt"), "created");
  assert.ok(u.row("attributedHuman"), "the owning human"); assert.ok(u.row("parentInstance"), "the parent"); assert.ok(u.row("siblingInstance"), "the sibling");
  assert.ok(u.row("identity"), "the messaging ID"); assert.ok(q('[data-context-section="teams"]'), "Teams");
  assert.ok(q("[data-context-status-note]"), "the runtime error's note"); assert.ok(q(".context-panel-session-note"), "the reporting gap's note");
  assert.ok([...q("#context-panel").querySelectorAll("button")].some((b) => /Stop…|Start…/.test(b.textContent)), "the lifecycle footer");
  // In a tab it fills the pane.
  assert.match(contextPanelCSS, /#context-panel\.context-panel\.in-details \{ flex:1 1 auto; width:auto;/);
  assert.match(fn("placeContextPanel"), /if \(pane\) \{ if \(el\.parentElement !== pane\) pane\.prepend\(el\); el\.classList\.add\("in-details"\); return; \}/);
  // Recent events (the lead's addition): the instance-events view, folded, under the panel's content.
  assert.match(fn("openDetailsTab"), /summary\.textContent = "Recent events";/);
  assert.match(fn("openDetailsTab"), /events = createInstanceEventsView\(host, \{ ctx,/);
});

test("slice6a rail", (t) => {
  const dom = new JSDOM("<!doctype html><body></body>"), doc = dom.window.document; t.after(() => dom.window.close());
  const opened = [], rail = createSidebarRail(doc, { onAgent: (row) => opened.push(row.instance), onPinned() {} });
  doc.body.append(rail.element);
  rail.update({ pinned: PINNED.map((v) => ({ name: v.name, label: v.label, icon: v.icon, current: v.name === "home" })),
    agents: [{ row: { instance: "b" }, id: "b", name: "Bravo", state: "running", waiting: false },
      { row: { instance: "a" }, id: "a", name: "Alpha", state: "stopped", waiting: true }], needYou: 1 });
  const agents = [...rail.element.querySelectorAll(".rail-agents button")];
  assert.deepEqual(agents.map((b) => b.getAttribute("aria-label")), ["Bravo, running", "Alpha, stopped, needs input"], "one dot per agent, in the order given, named with its state");
  assert.ok(agents[1].querySelector(".attn-mark"), "its needs-input mark"); assert.ok(agents[0].querySelector(".rail-dot.on"));
  assert.equal(agents[0].title, "Bravo", "the tooltip is the name");
  agents[0].click();
  assert.deepEqual(opened, ["b"], "a click (Enter, natively) opens it as its roster row does");
  assert.equal(rail.element.querySelector(".rail-need").hidden, false, "the need-you count's mark");
  assert.equal(rail.element.querySelectorAll(".rail-pinned button").length, 2);
  // The shell hands it the roster's order (its sections, pins first) and cycles full ↔ rail on sidebar.toggle.
  assert.match(fn("railAgents"), /sidebarSections\(instances, instances, contextDeployments, DESKTOP_TERMS, \{ placement, open: true, stale, pins: pinsShown\(\) \}\)/);
  assert.match(fn("toggleSidebar"), /setSidebarRail\(!sidebarRail\(\)\);/);
  assert.match(fn("openRosterInstance"), /el\.click\(\);/, "the agent opens through its roster row's own act");
});

test("slice6a home works with the sidebar hidden", async (t) => {
  // Home hears the roster model, not the sidebar's DOM: no MutationObserver, a signal from each paint of the model.
  assert.doesNotMatch(fn("subscribeHomeRoster"), /MutationObserver|querySelector/, "no DOM watched");
  assert.match(fn("renderContextRoster"), /if \(typeof rosterModelChanged === "function"\) rosterModelChanged\(\);/);
  // Its board follows a roster change, and Enter opens an agent, whatever the sidebar shows.
  const dom = new JSDOM('<!doctype html><body><div id="app" class="sidebar-hidden"><aside id="sidebar"></aside><main></main></div></body>');
  t.after(() => dom.window.close());
  const doc = dom.window.document, el = doc.querySelector("main"), listeners = new Set(), opened = [];
  let state = { rows: [], phase: "ready", deployments: [], stale: () => false, here: "falcon" };
  const home = createHome(el, { api: async () => ({ agents: [1] }), homeRoster: () => state,
    subscribeHomeRoster: (f) => { listeners.add(f); return () => listeners.delete(f); }, openAgent: (row) => opened.push(row.instance) },
  { doc, cli: () => ({ features: [] }), subscribeCli: () => () => {}, subscribeWorkspace: () => () => {}, generation: () => 1, setTimeout: () => 0, clearTimeout() {} });
  t.after(() => home.dispose());
  state = { ...state, rows: [{ instance: "late", agent: "s", running: true, runtimeState: "running" }] };
  for (const f of listeners) f();
  const row = [...el.querySelectorAll("[data-home-agent]")].find((b) => b.dataset.homeAgent === "late");
  assert.ok(row, "the board follows the roster change");
  row.click();
  assert.deepEqual(opened, ["late"]);
});

test("slice6a home agents pins first", () => {
  const rows = [{ instance: "new", createdAt: "2026-11-03T00:00:00.000Z" }, { instance: "pinned-old", createdAt: "2026-11-01T00:00:00.000Z", pinned: true },
    { instance: "mid", createdAt: "2026-11-02T00:00:00.000Z" }];
  assert.deepEqual(homeAgents(rows, { pins: true }).map((r) => r.instance), ["pinned-old", "new", "mid"], "pinned first, then newest spawn first");
  assert.deepEqual(homeAgents(rows, { pins: false }).map((r) => r.instance), ["new", "mid", "pinned-old"], "without the CLI's pins, no pin");
  assert.equal(PIN_FEATURE, "instance-pin");
  assert.match(readFileSync(new URL("../renderer/views/home.mjs", import.meta.url), "utf8"), /homeAgents\(data\.rows, \{ pins: data\.pins === true \}\)/);
});

test("slice6a tab memory restores page tabs", async () => {
  // Leaving a workspace closes its page tabs and keeps them by page and group; coming back reopens them, the active
  // one active again.
  const tabs = new Map([[1, { kind: "terminal", workspace: "A" }], [2, { kind: "page", page: "home", workspace: "A" }], [3, { kind: "page", page: "spawn", workspace: "A" }]]);
  const split = { orientation: "row", nextId: 3, groups: [{ id: 1, tabs: [1, 2], activeTab: 2 }, { id: 2, tabs: [3], activeTab: 3 }], focusedGroup: 2 };
  const c = { tabs, split, activeTab: 3, groupOfTab, NAV, canActivateTab, nextTabId: 1, ws: "A", closed: [], reopened: [], selected: [],
    currentWorkspace: () => c.ws, tabOpenIntents: { watch: () => () => true },
    closeTab: (id) => { c.closed.push(id); tabs.delete(id); },
    showStage: async () => {},
    openViewTab: async (name, title, extra, key, kind) => { const id = 10 + c.reopened.length; c.reopened.push([name, c.split.focusedGroup]); tabs.set(id, { kind, page: name, workspace: c.ws }); },
    selectTab: (id) => { c.selected.push(id); return true; } };
  const run = runInNewContext(`const workspacePages = new Map();\n${fn("takePageTabs")}\n${fn("closePageTabs")}\n${fn("reopenPageTabs")}\n({ takePageTabs, closePageTabs, reopenPageTabs })`, c);
  const leaving = run.takePageTabs("A");
  assert.deepEqual(JSON.parse(JSON.stringify(leaving.map((p) => [p.page, p.group, p.active]))), [["home", 1, false], ["spawn", 2, true]]);
  run.closePageTabs("A", leaving);
  assert.deepEqual(c.closed, [2, 3], "its page tabs close (they read the current workspace)");
  c.ws = "A"; await run.reopenPageTabs("A");
  assert.deepEqual(c.reopened, [["home", 1], ["spawn", 2]], "each page reopens in its group");
  assert.deepEqual(c.selected, [11], "the active page is active again");
  assert.match(fn("restoreWorkspaceTabs"), /closePageTabs\(leaving, leavingPages\);/);
  assert.match(fn("restoreWorkspaceTabs"), /void reopenPageTabs\(tabWorkspace\);/);
});
