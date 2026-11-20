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
import { createDetails } from "../renderer/views/details.mjs";
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

/** The Details view (views/details.mjs) over a row the roster reports, with doubles for its acts and its folded panels. */
function details(t, row, { stale = false } = {}) {
  const dom = new JSDOM("<!doctype html><body><main></main></body>"), doc = dom.window.document, el = doc.querySelector("main");
  const acts = [], listeners = new Set(); let current = row;
  const view = createDetails(el, { detailsRow: () => current, subscribeDetails: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    detailsStale: () => stale, detailsScope: () => ({ deployments: [], here: "falcon" }), detailsWorkspace: () => "A",
    createGitPanel: (host) => { host.append(Object.assign(doc.createElement("div"), { className: "git-double" })); return { update(u) { acts.push(["git", u.active]); }, dispose() {} }; },
    createTeamsSection: () => ({ update() {}, dispose() {} }), createSoulSection: () => ({ update(u) { acts.push(["soul", u.active]); }, dispose() {} }),
    createEventsView: (host) => ({ connected: host.isConnected, sync() { acts.push(["events-sync", host.isConnected]); }, dispose() {} }),
    detailsActs: { openTerminal: (r) => acts.push(["terminal", r.instance]), lifecycle: (verb, r) => acts.push([verb, r.instance]),
      openPullRequest: (r) => acts.push(["pr", r.instance]), openFiles: (r) => acts.push(["files", r.agent]) } }, { doc, now: () => Date.parse("2026-11-19T12:00:00.000Z") });
  t.after(() => { view.dispose(); dom.window.close(); });
  return { doc, el, acts, view, fact: (id) => el.querySelector(`[data-details-fact="${id}"]`)?.textContent ?? null,
    buttons: () => [...el.querySelectorAll(".details-actions button")].map((b) => [b.dataset.detailsKey, b.textContent, b.disabled]),
    retarget(next) { current = next; for (const fn of listeners) fn(); } };
}
const stopped = (extra = {}) => ({ instance: "web-developer-1", agent: "web-developer", agentsRoot: "/w/agents", home: "/w/agents/web-developer/instances/web-developer-1",
  repoName: "northwind", branch: "feat/checkout", harness: "claude", model: "opus", modelFrom: "soul", work: "worktree", running: false,
  createdAt: "2026-11-19T10:00:00.000Z", attributedHuman: "Joan", parentInstance: "lead-1", tmux: { session: "oats-agents" }, ...extra });

test("slice6a details for a stopped agent", (t) => {
  // Details is a tab of its own (views/details.mjs) for the roster's row: no terminal is needed.
  const u = details(t, stopped());
  assert.equal(u.fact("soul"), "web-developer");
  assert.equal(u.fact("harness"), "Claude · opus", "harness · model");
  assert.equal(u.fact("repository"), "northwind"); assert.equal(u.fact("branch"), "feat/checkout");
  assert.equal(u.fact("startedBy"), "Joan", "started by: the attributed human");
  assert.ok(u.fact("createdAt"), "created");
  assert.match(u.el.querySelector(".details-sub").textContent, /stopped · instance of web-developer/);
  // A stopped agent: no Open terminal; Start, Stop and Retire as its menu offers them; the PR and its Files.
  const keys = u.buttons().map(([key]) => key);
  assert.equal(keys.includes("terminal"), false); assert.ok(keys.includes("start")); assert.ok(keys.includes("pr")); assert.ok(keys.includes("files"));
  u.el.querySelector('[data-details-key="start"]').click();
  assert.deepEqual(u.acts.at(-1), ["start", "web-developer-1"], "today's Start dialog");
  // Every way in: i on a row, Ctrl+Shift+I (panel.toggle), the row's menu and the palette (its captured target).
  assert.match(shell, /if \(e\.key !== "i" \|\| e\.altKey \|\| e\.ctrlKey \|\| e\.metaKey \|\| e\.shiftKey\) return;\n          e\.preventDefault\(\); openDetailsTab\(i\);/);
  assert.match(shell, /registerAction\(\{ id: "panel\.toggle", label: "Agent: Details"/);
  assert.match(shell, /\{ action: 'details', actionId: 'panel\.toggle', label: 'Details', reason: '', always: true, secondary: true \},/);
  assert.match(shell, /if \(action === 'details'\) \{ openDetailsTab\(instance\); return; \}/);
  assert.match(shell, /const row = paletteTargetId \? shownRows\(contextInstances\)\.find\(\(r\) => instanceId\(r\) === paletteTargetId\) : null;\n      if \(row\) openDetailsTab\(row\);/);
  assert.match(fn("openDetailsTab"), /void openViewTab\("details", title, detailsContext\(ws\), "details", "details"\);/, "a tab with its own mounted view");
  assert.match(fn("syncContextPanel"), /instance: null, key: null, waiting: null/, "a terminal brings no instance panel");
});

test("slice6a details keeps every old panel fact", (t) => {
  // Each fact the old instance panel showed, at its place in Details (one assertion each).
  const u = details(t, stopped({ running: true, startedAt: "2026-11-19T11:00:00.000Z", siblingInstance: "web-developer-2", identityAddress: "oats.aweb.ai/web-developer-1",
    sameWorkKnown: true, sameWork: true, waitingOnYou: { since: "2026-11-19T11:30:00.000Z", producer: "agent", reason: "attention", message: "Pick the copy" },
    runtimeError: "the last start failed", runtimeErrorOrigin: "kernel" }));
  assert.match(u.el.querySelector("h1").textContent, /Web developer 1/, "the name");
  assert.match(u.el.querySelector(".details-sub").textContent, /running/, "its state");
  assert.match(u.el.querySelector('[data-details-section="waiting"]').textContent, /Needs input · Asked for your attention · .*Pick the copy/s, "Needs input");
  assert.equal(u.fact("work"), "its own worktree", "Work: its mode"); assert.equal(u.fact("repository"), "northwind"); assert.equal(u.fact("branch"), "feat/checkout");
  assert.match(u.el.querySelector(".details-tech").textContent, /\/w\/agents\/web-developer\/instances\/web-developer-1/, "Paths: the home, on the technical line");
  assert.equal(u.fact("harness"), "Claude · opus", "Session: the harness and the model"); assert.equal(u.fact("modelFrom"), "the soul's choice", "where the model came from");
  assert.equal(u.fact("session"), "tmux · oats-agents", "the tmux session"); assert.ok(u.fact("startedAt"), "started"); assert.ok(u.fact("createdAt"), "created");
  assert.equal(u.fact("startedBy"), "Joan", "the owning human"); assert.equal(u.fact("parent"), "Lead 1", "the parent"); assert.equal(u.fact("sibling"), "Web developer 2", "the sibling");
  assert.equal(u.fact("sameWork"), "same work as Lead 1", "same work as its parent");
  assert.equal(u.fact("identity"), "oats.aweb.ai/web-developer-1", "the messaging ID");
  assert.ok(u.el.querySelector('[data-details-section="teams"] > summary'), "Teams, folded");
  assert.match(u.el.querySelector(".details-note").textContent, /the last start failed/, "the runtime error's note");
  assert.ok(u.el.querySelector('[data-details-section="git"] > summary'), "Git (the Developer page: changes, the worktree, the pull request), folded");
  assert.ok(u.el.querySelector('[data-details-section="events"] > summary'), "Recent events, folded");
  assert.deepEqual(u.buttons().map(([key]) => key).filter((k) => k === "terminal" || k === "pr" || k === "files"), ["terminal", "pr", "files"], "the action row");
  // Folding Git open reads it; a retarget repaints for the new agent.
  u.el.querySelector('[data-details-section="git"]').open = true; u.el.querySelector('[data-details-section="git"]').dispatchEvent(new u.doc.defaultView.Event("toggle"));
  assert.ok(u.acts.some(([k, v]) => k === "git" && v === true), "unfolding Git reads it");
  u.retarget(stopped({ instance: "other", agent: "other-soul" }));
  assert.equal(u.fact("soul"), "other-soul");
});

test("slice6a details: the rest of the old panel's facts, a remote row's repository, the folds' reads and focus", (t) => {
  // Review round 2: the as-spawned soul (capabilities, core first) folded; a remote row's repository is its own repo
  // path's tail, never its server's label; a stopped row's last start; the agents root, the folder (shared when
  // linked), the drift and reporting-gap notes, the identity fallback.
  const u = details(t, stopped({ server: "build", repoName: "Build box", repo: "/srv/northwind/", running: false, startedAt: "2026-11-18T09:00:00.000Z",
    work: "checkout", identity: { alias: "web-dev", domain: "oats.aweb.ai" }, soul: { status: "moved" } }));
  assert.equal(u.fact("repository"), "northwind", "the remote row's own repository, not 'Build box'");
  assert.ok(u.fact("startedAt"), "a stopped row's last start"); assert.match(u.el.querySelector('[data-details-fact="startedAt"]').previousElementSibling.textContent, /Last started/);
  assert.equal(u.fact("agentsRoot"), "/w/agents");
  assert.match(u.fact("workFolder"), /\/work \(shared: a link to a tree others share\)$/);
  assert.match(u.el.textContent, /Its soul's repository has moved on since it was spawned\./, "the drift note");
  assert.ok(u.el.querySelector('[data-details-section="soul"] > summary'), "the soul as spawned, folded");
  const soul = u.el.querySelector('[data-details-section="soul"]'); soul.open = true; soul.dispatchEvent(new u.doc.defaultView.Event("toggle"));
  assert.ok(u.acts.some(([k, v]) => k === "soul" && v === true), "unfolding it reads it");
  // The events view is built connected and synced on each paint (its Load activity follows the row).
  assert.ok(u.acts.some(([k, connected]) => k === "events-sync" && connected === true));
  // A repaint keeps focus in a fold: the folds stay in place.
  const summary = u.el.querySelector('[data-details-section="git"] > summary'); summary.tabIndex = 0; summary.focus();
  u.view.refresh();
  assert.equal(u.doc.activeElement, summary, "a roster change doesn't take focus out of Git");
});

test("slice6a details from every row: a held or blocked row's menu keeps Details", async () => {
  const { instanceActions } = await import("../renderer/instance-actions.mjs");
  const dom = new JSDOM("<!doctype html><body></body>"), doc = dom.window.document;
  const row = doc.createElement("button"); doc.body.append(row);
  const ran = [];
  const extra = [{ action: "details", actionId: "panel.toggle", label: "Details", reason: "", always: true, secondary: true }];
  const menu = instanceActions(doc, { instance: "far", server: "far", addressable: false, running: null, home: "/far/h" }, { row, extra, dispatch: (id) => ran.push(id), stale: null });
  row.after(menu);
  const details = [...menu.querySelectorAll("[role=menuitem]")].find((item) => item.dataset.action === "details");
  assert.ok(details, "Details is listed on an unaddressable remote row");
  assert.equal(details.disabled, false, "and usable: it only reads");
  details.click();
  assert.deepEqual(ran, ["panel.toggle"]);
  assert.match(shell, /if \(reported\) row\.addEventListener\("keydown", \(e\) => \{\n    if \(e\.key !== "i"/, "a reported pending row takes i too");
  dom.window.close();
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
  assert.match(fn("openRosterInstance"), /return row \? activateRosterRow\(row\) : false;/, "the agent opens through the roster row's own act");
});

test("slice6a home works with the sidebar hidden", async (t) => {
  // Home hears the roster model, not the sidebar's DOM: no MutationObserver, a signal from each paint of the model.
  assert.doesNotMatch(fn("subscribeHomeRoster"), /MutationObserver|querySelector/, "no DOM watched");
  assert.match(fn("renderContextRoster"), /\n  rosterModelChanged\(\);/);
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
  // The act itself needs no sidebar DOM at all (#1987): the shipped openRosterInstance and activateRosterRow, with no
  // roster element, open a running agent's terminal and a stopped one's Start, and refuse a held or unknown row.
  const calls = [];
  const c = { contextInstances: [{ instance: "run", running: true, home: "/h/run" }, { instance: "stop", running: false, home: "/h/stop" },
    { instance: "held", running: true, home: "/h/held", retirePending: true }, { instance: "unknown", running: null, home: "/h/unknown" }],
    shownRows: (rows) => rows, instanceId: (r) => r.home, heldHome: (r) => (r.retirePending ? { kind: "retiring" } : null), canAddressRemote: () => true,
    rosterStale: false, rowStale: () => false, contextDeployments: [], contextWorkspace: "A", currentWorkspace: () => "A", spawnJobs: {},
    openTerminalTab: (r) => calls.push(["terminal", r.instance]), openInstanceStart: (r) => calls.push(["start", r.instance]) };
  const act = runInNewContext(`${fn("activateRosterRow")}\n${fn("openRosterInstance")}\nopenRosterInstance`, c);
  for (const name of ["run", "stop", "held", "unknown"]) act({ instance: name, home: `/h/${name}` });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["terminal", "run"], ["start", "stop"]], "the row's gates, no DOM");
  assert.match(shell, /activateRosterRow\(i, ws\); \/\/ the row's one act/, "the row runs the same act");
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
    openViewTab: async (name, title, extra, key, kind) => {
      const id = 10 + c.reopened.length; c.reopened.push([name, c.split.focusedGroup]); tabs.set(id, { kind, page: name, workspace: c.ws });
      // as activation would: the new tab joins the focused group, its active one
      c.split = { ...c.split, groups: c.split.groups.map((g) => g.id === c.split.focusedGroup ? { ...g, tabs: [...g.tabs, id], activeTab: id } : g) };
    },
    selectTab: (id) => { c.selected.push(id); return true; }, activateTab() {} };
  const run = runInNewContext(`const workspacePages = new Map();\n${fn("takePageTabs")}\n${fn("closePageTabs")}\n${fn("reopenPageTabs")}\n({ takePageTabs, closePageTabs, reopenPageTabs })`, c);
  const leaving = run.takePageTabs("A");
  assert.deepEqual(JSON.parse(JSON.stringify(leaving.map((p) => [p.page, p.group, p.active]))), [["home", 1, false], ["spawn", 2, true]]);
  run.closePageTabs("A", leaving);
  assert.deepEqual(c.closed, [2, 3], "its page tabs close (they read the current workspace)");
  // (the remembered split, as recall hands it back: the closed page tabs gone from their groups)
  c.split = { ...c.split, groups: [{ id: 1, tabs: [1], activeTab: 1 }, { id: 2, tabs: [], activeTab: null }], focusedGroup: 2 };
  c.ws = "A"; await run.reopenPageTabs("A");
  assert.deepEqual(c.reopened, [["home", 1], ["spawn", 2]], "each page reopens in its group");
  assert.deepEqual(c.selected, [11], "the active page is active again");
  // Every pane as it was: group 1's strip order (terminal, then its Home) and its active member (its Home), and the
  // focused group (2).
  assert.deepEqual(JSON.parse(JSON.stringify(c.split.groups.map((g) => [g.tabs, g.activeTab]))), [[[1, 10], 10], [[11], 11]]);
  assert.equal(c.split.focusedGroup, 2);
  // The real entry point takes the active tab before hiding the tab layer (which clears it).
  const restore = fn("restoreWorkspaceTabs");
  assert.ok(restore.indexOf("leavingActive = activeTab") < restore.indexOf("showTabLayer(false)"), "the active tab is taken before the layer hides");
  assert.match(restore, /closePageTabs\(leaving, leavingPages, leavingActive\);/);
  assert.match(fn("restoreWorkspaceTabs"), /void reopenPageTabs\(tabWorkspace\);/);
});
