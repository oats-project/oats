// Spec F, Part 4: F6 / Shift+F6 cycle the window's regions — the sidebar's, top to bottom
// (workspaces → views, the nav under the list → instance roster), then main → instance panel (2026-10-26) —
// skipping hidden ones and landing on each region's current item, never <body>. The sidebar's foot (the bar:
// N need you, New agent and ?, slice 1) is not a region, but an empty roster's stop is its New agent.
// And "back to where you were" after a flow that moved the main surface.
// The shipped index.html and shell.css (scripts are not run), so ids and hiding rules are real.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createFocusRegions, REGIONS, isShown } from "../renderer/focus-regions.mjs";
import { createSidebarWidth } from "../renderer/sidebar-width.mjs";
import { PINNED } from "../renderer/shell-nav.mjs";
import { createSurfaceReturn } from "../renderer/surface-return.mjs";
import { captureFocusReturn } from "../renderer/focus-return.mjs";

const read = name => readFileSync(new URL(`../renderer/${name}`, import.meta.url), "utf8");

/** The foot's buttons, in order (slice 1): N need you (shown while a row needs you), New agent and ?. */
const FOOT = ["sidebar-need-you", "sidebar-spawn", "sidebar-help"];

function shell(t, { tabs = false } = {}) {
  const dom = new JSDOM(read("index.html"));
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const style = doc.createElement("style"); style.textContent = read("shell.css"); doc.head.append(style);
  // What the shell paints: the workspace list (one roving stop, the current row), the nav's items under the list
  // from the shipped manifest (Home current), roster rows (one roving stop), a stage and a panel with tabs.
  doc.getElementById("ws-options").innerHTML = `<ul class="ws-group"><li class="ws-option-row"><button type="button" class="ws-option" aria-current="true" tabindex="0" data-workspace-id="/w/a">Team A</button></li><li class="ws-option-row"><button type="button" class="ws-option" tabindex="-1" data-workspace-id="/w/b">Team B</button></li></ul>`;
  doc.getElementById("nav").innerHTML = PINNED.map(v => v.name === "home"
    ? `<button class="nav-item active" data-view="${v.name}" aria-current="page">${v.label}</button>`
    : `<button class="nav-item" data-view="${v.name}">${v.label}</button>`).join("");
  doc.querySelector("#instance-roster .ctx-list").innerHTML = `<div class="ctx-tree-row"><button class="ctx-inst" tabindex="-1" data-tree-instance="a">a</button></div><div class="ctx-tree-row active"><button class="ctx-inst active" tabindex="0" data-tree-instance="b">b</button></div><div class="ctx-tree-row ctx-spawn-row ctx-spawn-unknown"><button class="ctx-inst pending" tabindex="-1" aria-disabled="true" data-tree-instance="c">c</button><span class="ctx-row-tools ctx-spawn-tools"><button class="act ctx-start ctx-spawn-check">Check result</button></span></div>`;
  // The foot as the shell paints it while one row needs you (sidebar-foot.mjs): its count shown, New agent's words.
  const need = doc.getElementById("sidebar-need-you"); need.hidden = false; need.textContent = "1 need you";
  doc.getElementById("sidebar-spawn").textContent = "New agent";
  doc.getElementById("stagehost").innerHTML = `<div><div class="workspace-tabs"><button role="tab" aria-selected="true" tabindex="0">Souls</button></div><input class="filter"></div>`;
  const panel = doc.getElementById("context-panel"); panel.hidden = false;
  panel.innerHTML = `<div role="tablist"><button role="tab" aria-selected="false" tabindex="-1">Instance</button><button role="tab" aria-selected="true" tabindex="0">Soul</button></div>`;
  let layer = tabs, terminal = null;
  if (tabs) {
    doc.getElementById("stagehost").style.display = "none";
    doc.getElementById("tabhost").style.display = "";
    doc.getElementById("tabbar").innerHTML = `<div class="tab"><button role="tab" aria-selected="true" tabindex="0">dev</button></div>`;
    doc.getElementById("tabhost").innerHTML = `<div class="tab-pane active"><div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div></div>`;
    terminal = doc.querySelector(".xterm-helper-textarea");
  }
  const regions = createFocusRegions({ doc, tabLayerVisible: () => layer, focusMainContent: () => { terminal?.focus(); return !!terminal; } });
  return { dom, doc, regions, terminal, setLayer: v => { layer = v; },
    // Icon buttons have no text here (the shell mounts their icons): they read as their #id. Text is trimmed
    // (a control's markup may span lines).
    where: () => doc.activeElement === doc.body ? "body" : doc.activeElement.textContent.trim() || (doc.activeElement.id && `#${doc.activeElement.id}`) || doc.activeElement.className };
}

// The sidebar's order top to bottom, then the main area: the views (the nav) sit under the list of workspaces,
// above the roster. "nav" and "footer" are no region names any more.
test("F6 order: workspaces → views → roster → main → panel → workspaces, each on its current item", t => {
  const s = shell(t);
  // The agent view's facts and questions (S2-D) sit either side of main; they are in the cycle only while the active tab
  // shows them (agent-view.test.mjs), so this window, with no agent view, walks the five below.
  assert.deepEqual(REGIONS, ["workspaces", "views", "roster", "facts", "main", "questions", "panel"]);
  for (const old of ["nav", "footer"]) {
    assert.equal(s.regions.visible(old), false, `the old region name ${old} is gone`);
    assert.equal(s.regions.focusRegion(old), false);
  }
  const visited = [];
  for (let i = 0; i < 6; i++) { assert.equal(s.regions.cycle(1), true); visited.push(s.where()); }
  assert.deepEqual(visited, ["Team A", "Home", "b", "Souls", "Soul", "Team A"],
    "the list's tab stop, the current view's nav item, the selected roster row, the stage's first control, the panel's selected tab");
  const back = [];
  for (let i = 0; i < 5; i++) { s.regions.cycle(-1); back.push(s.where()); }
  assert.deepEqual(back, ["Soul", "Souls", "b", "Home", "Team A"], "Shift+F6 walks it backwards");
});

// Where each sidebar region lands when its first choice is missing: never <body>, never a control of
// another region.
test("workspaces lands on the list's tab stop, else Add local workspace…; views on the current nav item, else the first, else nothing", t => {
  const s = shell(t);
  // The list's stop is the row last focused (the roving tabindex), not necessarily the current one.
  const [a, b] = s.doc.querySelectorAll("#ws-options .ws-option");
  a.tabIndex = -1; b.tabIndex = 0;
  assert.equal(s.regions.focusRegion("workspaces"), true); assert.equal(s.where(), "Team B");
  s.doc.getElementById("ws-options").innerHTML = ""; // no workspace listed yet
  assert.equal(s.regions.focusRegion("workspaces"), true); assert.equal(s.where(), "#ws-add-open");
  assert.equal(s.regions.regionOfFocus(), "workspaces");
  const nav = s.doc.getElementById("nav");
  assert.deepEqual([...nav.querySelectorAll("button")].map(b => b.textContent), ["Home", "Workspace", "Automations"],
    "the views under the list: Home, Workspace, then Automations (the Desktop UI rework, slice 2b)");
  assert.equal(s.regions.focusRegion("views"), true); assert.equal(s.where(), "Home", "the current view's nav item");
  nav.querySelector('[aria-current="page"]').removeAttribute("aria-current"); // a terminal in front: no current view
  nav.querySelector(".nav-item:last-child").focus(); // focus elsewhere, so the landing is the region's, not where it was
  assert.equal(s.regions.focusRegion("views"), true); assert.equal(s.where(), "Home", "else the first nav item (Home, first in NAV)");
  nav.innerHTML = "";
  const before = s.doc.activeElement;
  assert.equal(s.regions.focusRegion("views"), false, "no nav item: nothing to land on (never the foot's buttons)");
  assert.equal(s.doc.activeElement, before, "focus stays where it was, never <body>");
});

// The head's control belongs to the list it heads: Add local workspace… to the workspaces. The views are the nav. The
// Instances heading holds no control; the foot (the bar: N need you, New agent and ?, slice 1) is no region.
test("regionOfFocus: the head's + and the rows are workspaces; the nav items are views; the foot, New agent with it, is none", t => {
  const s = shell(t);
  assert.equal(s.doc.getElementById("sidebar-tools"), null, "no tools row");
  const head = s.doc.querySelector("#sidebar > .side-head");
  assert.deepEqual([...head.querySelectorAll("button")].map(b => b.id), ["ws-add-open"], "the head's one control (slice 1: no Show only the current workspace)");
  for (const el of [s.doc.getElementById("ws-add-open"), ...s.doc.querySelectorAll("#ws-options .ws-option")]) {
    el.focus(); assert.equal(s.regions.regionOfFocus(), "workspaces", s.where());
  }
  for (const el of s.doc.querySelectorAll("#nav button")) { el.focus(); assert.equal(s.regions.regionOfFocus(), "views", s.where()); }
  assert.deepEqual([...s.doc.querySelectorAll("#instance-roster .ctx-head button")], [], "the Instances heading holds no control");
  const bar = s.doc.getElementById("sidebar-bar");
  assert.equal(bar.getAttribute("role"), "group"); assert.equal(bar.getAttribute("aria-label"), "Sidebar tools");
  assert.deepEqual([...s.doc.getElementById("nav-foot").children], [bar], "the foot holds only the bar");
  assert.deepEqual([...bar.children].map(el => el.id), ["sidebar-need-you", "sidebar-spawn", "sidebar-help"],
    "the bar (slice 1): N need you, then New agent and ? at the right; no mark, no toggle, no cog");
  assert.equal(s.doc.querySelector("#sidebar-spawn kbd, #nav-foot kbd"), null, "no chord hint in New agent: its chord is in its tooltip");
  const foot = [...s.doc.querySelectorAll("#nav-foot button")].map(b => b.id);
  assert.deepEqual(foot, FOOT, "the foot's buttons");
  for (const el of s.doc.querySelectorAll("#nav-foot button")) { el.focus(); assert.equal(s.regions.regionOfFocus(), null, `${s.where()}: no region`); }
  // With rows to land on; an empty roster's stop is the foot's New agent (below).
  assert.equal(REGIONS.some(name => s.regions.visible(name) && s.regions.currentItem(name)?.closest("#nav-foot")), false, "no region lands in the foot");
});


test("from a control inside a region (the workspace list, a row's tools, a head's control) F6 moves on to the next region", t => {
  const s = shell(t);
  s.doc.querySelector('#ws-options .ws-option[aria-current="true"]').focus(); s.regions.cycle(1);
  assert.equal(s.where(), "Home", "the workspace list is the first region: next are the views under it");
  s.doc.getElementById("ws-add-open").focus(); s.regions.cycle(1);
  assert.equal(s.where(), "Home", "so is the head's Add local workspace…");
  s.doc.getElementById("ws-add-open").focus(); s.regions.cycle(-1);
  assert.equal(s.where(), "Soul", "Shift+F6 from the head's + goes back to the panel");
  s.doc.querySelector('#ws-options .ws-option[tabindex="-1"]').focus(); s.regions.cycle(-1);
  assert.equal(s.where(), "Soul", "Shift+F6 from the list goes back to the panel");
  s.doc.querySelector(".ctx-spawn-check").focus(); s.regions.cycle(1);
  assert.equal(s.where(), "Souls", "from a pending row's Check result, main");
  s.doc.querySelector("#nav button:last-child").focus(); s.regions.cycle(1);
  assert.equal(s.where(), "b", "from a nav item, the roster");
  s.doc.querySelector("#nav button:last-child").focus(); s.regions.cycle(-1);
  assert.equal(s.where(), "Team A", "Shift+F6 from a nav item, the workspaces");
  // The foot is below the roster and no region: F6 goes on to main, Shift+F6 back to the roster (its row).
  for (const id of FOOT) {
    s.doc.getElementById(id).focus(); s.regions.cycle(1);
    assert.equal(s.where(), "Souls", `from the foot's ${id}, main`);
    s.doc.getElementById(id).focus(); s.regions.cycle(-1);
    assert.equal(s.where(), "b", `Shift+F6 from the foot's ${id}, the roster`);
  }
});

// A window with no workspace hides the roster (shell.mjs): the foot, below where the roster would be, still
// moves on as from there.
test("F6 with the roster hidden: from the foot on to main, Shift+F6 back to the views, never the first region", t => {
  const s = shell(t);
  s.doc.getElementById("instance-roster").hidden = true;
  assert.deepEqual(REGIONS.filter(s.regions.visible), ["workspaces", "views", "main", "panel"]);
  for (const id of FOOT) {
    s.doc.getElementById(id).focus(); assert.equal(s.regions.cycle(1), true);
    assert.equal(s.where(), "Souls", `from the foot's ${id}, main (not the workspaces)`);
    s.doc.getElementById(id).focus(); assert.equal(s.regions.cycle(-1), true);
    assert.equal(s.where(), "Home", `Shift+F6 from the foot's ${id}, the views above the hidden roster`);
  }
  s.doc.querySelector("#nav button").focus(); s.regions.cycle(1);
  assert.equal(s.where(), "Souls", "from the views past the hidden roster, main");
  s.regions.cycle(-1);
  assert.equal(s.where(), "Home", "and Shift+F6 from main back to the views");
});

test("hidden regions are skipped: a hidden sidebar, focus mode, an empty panel", t => {
  const s = shell(t);
  s.doc.getElementById("app").classList.add("sidebar-hidden");
  s.doc.body.focus(); s.regions.cycle(1); assert.equal(s.where(), "Souls");
  s.regions.cycle(1); assert.equal(s.where(), "Soul");
  s.regions.cycle(1); assert.equal(s.where(), "Souls", "the workspaces, views and roster are skipped");
  s.doc.getElementById("app").classList.replace("sidebar-hidden", "focus-mode");
  s.doc.getElementById("context-panel").hidden = true;
  assert.deepEqual(REGIONS.filter(s.regions.visible), ["main"]);
  s.regions.cycle(1); assert.equal(s.where(), "Souls");
});

test("never <body>: a region with nothing to focus is passed over", t => {
  const s = shell(t);
  s.doc.getElementById("stagehost").innerHTML = "<p>Loading…</p>";
  s.doc.querySelector(".ctx-inst.active").focus(); // in the roster
  s.regions.cycle(1);
  assert.equal(s.where(), "Soul", "main had no control: on to the panel");
  assert.notEqual(s.doc.activeElement, s.doc.body);
});

test("a closed panel is out of the cycle (Spec B), the hidden-region rule; main is the active terminal", t => {
  const s = shell(t, { tabs: true });
  s.doc.getElementById("context-panel").hidden = true; // closed: no rail stands in for it
  s.doc.getElementById("show-panel").hidden = false;
  assert.deepEqual(REGIONS.filter(s.regions.visible), ["workspaces", "views", "roster", "main"]);
  s.terminal.focus();
  s.regions.cycle(1); assert.equal(s.where(), "Team A", "from the terminal past the closed panel, back to the workspaces");
  s.regions.cycle(-1); assert.equal(s.doc.activeElement, s.terminal, "and Shift+F6 back to the terminal");
  s.regions.cycle(-1); assert.equal(s.where(), "b", "Shift+F6 from the terminal: the roster");
  s.regions.cycle(1);
  assert.equal(s.doc.activeElement, s.terminal, "main in the tab layer is the terminal's input");
  assert.equal(s.regions.regionOfFocus(), "main");
  s.doc.getElementById("show-panel").focus();
  assert.equal(s.regions.regionOfFocus(), "main", "Show instance panel belongs to the Main region");
  s.doc.getElementById("app").classList.add("sidebar-hidden"); s.doc.getElementById("show-sidebar").hidden = false;
  s.doc.getElementById("show-sidebar").focus();
  assert.equal(s.regions.regionOfFocus(), "main", "and so does Show sidebar");
});

// The roster's fallback after its tab stop: a control it shows (a failed read's Retry), else, on an empty roster,
// its one action, the foot's New agent (2026-10-26; rosterEntry in shell.mjs agrees). From there F6 goes on as
// from the roster and Shift+F6 back as from the roster, not as from the foot.
test("the roster without a row stop lands on a control it shows (a Retry), else the foot's New agent, else it is passed over: it has no filter", t => {
  const s = shell(t);
  const roster = s.doc.getElementById("instance-roster"), list = s.doc.querySelector(".ctx-list");
  assert.equal(roster.querySelector(".ctx-filter, input"), null, "the shipped roster has no filter field");
  assert.deepEqual([...roster.children].map(el => el.className), ["ctx-head", "ctx-list"], "its head, then its list");
  assert.deepEqual([...roster.querySelectorAll("button")].map(b => b.id || b.textContent), ["a", "b", "c", "Check result"], "no control of its own besides the rows (and a pending row's Check result)");
  // A failed first read: no rows, only the failed block's Retry.
  list.innerHTML = `<div class="loading-failed"><button type="button" class="act">Retry</button></div>`;
  assert.equal(s.regions.focusRegion("roster"), true);
  assert.equal(s.where(), "Retry", "the Retry, not the foot's New agent");
  // A stale notice's Retry sits between the heading and the list (instance-tree-view.mjs createRosterLoading).
  list.innerHTML = `<div class="ctx-empty">No agents yet</div>`;
  const notice = s.doc.createElement("div"); notice.className = "ctx-status"; notice.innerHTML = '<button type="button" class="act">Retry</button>';
  list.before(notice);
  assert.equal(s.regions.focusRegion("roster"), true); assert.equal(s.doc.activeElement, notice.firstElementChild, "a stale notice's Retry");
  notice.remove();
  // An empty roster: its one action, the foot's New agent.
  const spawn = s.doc.getElementById("sidebar-spawn");
  assert.ok(s.doc.getElementById("nav-foot").contains(spawn), "New agent is the foot's");
  s.doc.querySelector("#nav button").focus();
  s.regions.cycle(1);
  assert.equal(s.doc.activeElement, spawn, "from the views, the empty roster's New agent");
  assert.equal(s.where(), "New agent");
  assert.equal(s.regions.currentItem("roster"), spawn);
  s.regions.cycle(1);
  assert.equal(s.where(), "Souls", "F6 from the empty roster's stop goes on as from the roster: main");
  spawn.focus(); s.regions.cycle(-1);
  assert.equal(s.where(), "Home", "Shift+F6 from the empty roster's stop goes back as from the roster: the views");
  // The foot's other buttons stay below the roster: Shift+F6 from them is as from main, onto the roster's stop.
  for (const id of ["sidebar-need-you", "sidebar-help"]) {
    s.doc.getElementById(id).focus(); s.regions.cycle(-1);
    assert.equal(s.doc.activeElement, spawn, `Shift+F6 from the foot's ${id}, the empty roster's New agent`);
    s.doc.getElementById(id).focus(); s.regions.cycle(1);
    assert.equal(s.where(), "Souls", `F6 from the foot's ${id}, main`);
  }
  // A disabled New agent is no stop: the region is skipped, never <body>.
  spawn.disabled = true;
  s.doc.querySelector("#nav button").focus();
  assert.equal(s.regions.focusRegion("roster"), false);
  s.regions.cycle(1);
  assert.equal(s.where(), "Souls", "from the views past the empty roster, main");
  // Nor a hidden one.
  spawn.disabled = false; spawn.hidden = true;
  s.doc.querySelector("#nav button").focus();
  assert.equal(s.regions.focusRegion("roster"), false);
  s.regions.cycle(1);
  assert.equal(s.where(), "Souls", "from the views past the empty roster, main");
});

// ── surface-return: back to where the operator was ─────────────────────

function surfaces(t, start) {
  const s = shell(t, { tabs: start.tab != null });
  const state = { workspace: "A", generation: 0, stage: start.stage, tab: start.tab ?? null, layer: start.tab != null, workspaceTab: start.workspaceTab ?? null };
  const calls = [];
  const pane = s.doc.querySelector(".tab-pane");
  const back = createSurfaceReturn({ doc: s.doc, currentWorkspace: () => state.workspace, workspaceGeneration: () => state.generation,
    surface: () => ({ stage: state.stage, tab: state.tab, tabLayerVisible: state.layer, workspaceTab: state.stage === "spawn" ? state.workspaceTab : null }),
    tabPane: id => (id === 1 ? pane : null),
    showStage: async name => { calls.push(["stage", name]); state.stage = name; state.layer = false; },
    selectTab: (id, opts) => { calls.push(["tab", id, opts.focusContent]); state.layer = true; state.tab = id; if (opts.focusContent) s.terminal.focus(); return true; },
    focusRegion: name => { calls.push(["region", name]); return s.regions.focusRegion(name); },
    // The Workspace page's tabs, as views/spawn.mjs answers them: the tab shown, its panel (re)mounted, its control.
    selectWorkspaceTab: name => { calls.push(["workspaceTab", name]); if (!hooks.selectable) return null; state.workspaceTab = name; hooks.remount?.(name); return s.doc.getElementById(`workspace-tab-${name}`); },
    host: "spawn" });
  const hooks = { selectable: true, remount: null };
  // Quick Open → the Workspace stage with the dialog, which opens on Souls (the flow under test moves the surface).
  const move = () => { state.stage = "spawn"; state.layer = false; state.workspaceTab = "souls"; s.doc.activeElement?.blur(); };
  return { ...s, state, calls, back, move, hooks };
}

test("return: from a terminal tab, re-activate it with its terminal focused (and the stage under it)", async t => {
  const u = surfaces(t, { stage: "automations", tab: 1 });
  u.terminal.focus();
  const origin = u.back.capture(captureFocusReturn(u.doc));
  u.move();
  assert.equal(u.back.restore(origin), true);
  assert.deepEqual(u.calls, [["stage", "automations"], ["tab", 1, true]]);
  assert.equal(u.doc.activeElement, u.terminal);
});

test("return: from a stage, the same stage and the control left, else that region's current item", async t => {
  const u = surfaces(t, { stage: "automations" });
  const filter = u.doc.querySelector("#stagehost .filter"); filter.id = "kept"; filter.focus();
  const origin = u.back.capture(captureFocusReturn(u.doc));
  u.move();
  assert.equal(u.back.restore(origin), true);
  await new Promise(setImmediate);
  assert.deepEqual(u.calls, [["stage", "automations"]]);
  assert.equal(u.doc.activeElement, filter);
  // The control is gone after the stage remounts: the stage's first control instead.
  const again = u.back.capture(captureFocusReturn(u.doc));
  u.move(); filter.remove();
  u.back.restore(again); await new Promise(setImmediate);
  assert.equal(u.where(), "Souls", "a control of the same stage, never <body>");
});

test("return: from a roster row while a terminal was visible, the tab comes back and focus goes to the row", async t => {
  const u = surfaces(t, { stage: "spawn", tab: 1 });
  const row = u.doc.querySelector(".ctx-inst.active"); row.focus();
  const origin = u.back.capture(captureFocusReturn(u.doc));
  u.move();
  assert.equal(u.back.restore(origin), true);
  assert.deepEqual(u.calls, [["tab", 1, false]], "same stage under it: no stage switch; the tab without taking focus");
  assert.equal(u.doc.activeElement, row);
});

test("return: a terminal tab over Workspace › Machines comes back with Machines under it, not Souls", async t => {
  // Workspace › Machines, a terminal tab opened over it, Quick Open, a soul picked (the dialog opens on Souls), Esc.
  const u = surfaces(t, { stage: "spawn", tab: 1, workspaceTab: "machines" });
  u.terminal.focus();
  const origin = u.back.capture(captureFocusReturn(u.doc));
  assert.equal(origin.workspaceTab, "machines", "the page under the tabs is part of where they were");
  u.move();
  assert.equal(u.back.restore(origin), true);
  assert.deepEqual(u.calls, [["workspaceTab", "machines"], ["tab", 1, true]], "the page's tab first, then the terminal, focused");
  assert.equal(u.doc.activeElement, u.terminal);
  // Closing the terminal shows the stage under it: Machines, not the Souls tab the dialog opened on.
  u.state.layer = false;
  assert.equal(u.state.stage, "spawn");
  assert.equal(u.state.workspaceTab, "machines");
  // A tab the page can't show any more: the terminal still comes back (the page stays where it is).
  const v = surfaces(t, { stage: "spawn", tab: 1, workspaceTab: "machines" });
  v.terminal.focus();
  const again = v.back.capture(captureFocusReturn(v.doc));
  v.move(); v.hooks.selectable = false;
  assert.equal(v.back.restore(again), true);
  assert.deepEqual(v.calls, [["workspaceTab", "machines"], ["tab", 1, true]]);
  assert.equal(v.doc.activeElement, v.terminal);
  assert.equal(v.state.workspaceTab, "souls");
  // Already on that tab: no tab switch.
  const w = surfaces(t, { stage: "spawn", tab: 1, workspaceTab: "souls" });
  w.terminal.focus();
  const same = w.back.capture(captureFocusReturn(w.doc));
  w.move();
  assert.equal(w.back.restore(same), true);
  assert.deepEqual(w.calls, [["tab", 1, true]]);
});

// Workspace › Machines: the dialog opens on Souls, and leaving Machines disposes its panel (views/spawn.mjs
// syncMachines unmounts the Deployments view, views/hierarchy.mjs).
function onMachines(t) {
  const u = surfaces(t, { stage: "spawn", workspaceTab: "machines" });
  const tabs = u.doc.querySelector("#stagehost .workspace-tabs");
  tabs.insertAdjacentHTML("beforeend", `<button role="tab" id="workspace-tab-machines" aria-selected="true" tabindex="0">Machines</button>`);
  tabs.insertAdjacentHTML("afterend", `<div id="workspace-machines" class="workspace-machines-panel" role="tabpanel"></div>`);
  const panel = u.doc.getElementById("workspace-machines");
  const mount = () => { panel.innerHTML = `<button id="hier-tab-local" role="tab">This machine</button><button class="hier-retry">Retry</button>`; };
  mount();
  // The dialog over Souls: Machines' panel is gone.
  const moveAndDispose = () => { u.move(); panel.replaceChildren(); };
  return { ...u, panel, mount, moveAndDispose };
}

test("return within Workspace: back on the tab left (Machines), its panel remounted, on the control left", async t => {
  const u = onMachines(t);
  u.doc.getElementById("hier-tab-local").focus();
  const origin = u.back.capture(captureFocusReturn(u.doc));
  assert.equal(origin.workspaceTab, "machines", "the page's tab is part of where they were");
  u.moveAndDispose();
  u.hooks.remount = () => u.mount();
  assert.equal(u.back.restore(origin), true);
  assert.deepEqual(u.calls, [["workspaceTab", "machines"]], "no stage switch: the same stage, its tab");
  assert.equal(u.state.workspaceTab, "machines");
  assert.equal(u.doc.activeElement, u.doc.getElementById("hier-tab-local"), "the control left, by its identity, in the remounted panel");
});

test("return within Workspace: a panel still loading its controls lands on its tab, never a neighbour", async t => {
  const u = onMachines(t);
  u.panel.querySelector(".hier-retry").focus(); // no id: only its ancestors could find a replacement
  const origin = u.back.capture(captureFocusReturn(u.doc));
  u.moveAndDispose();
  assert.equal(u.back.restore(origin), true);
  assert.equal(u.doc.activeElement, u.doc.getElementById("workspace-tab-machines"), "the tab itself, not the Souls tab or the sidebar");
  // A tab the page can't show any more: refused, the dialog restores focus itself.
  const v = onMachines(t);
  v.doc.getElementById("hier-tab-local").focus();
  const again = v.back.capture(captureFocusReturn(v.doc));
  v.moveAndDispose(); v.hooks.selectable = false;
  assert.equal(v.back.restore(again), false);
  // The same tab (Souls, where the dialog opens): no tab switch, the control left as before.
  const w = surfaces(t, { stage: "spawn", workspaceTab: "souls" });
  const filter = w.doc.querySelector("#stagehost .filter"); filter.focus();
  const same = w.back.capture(captureFocusReturn(w.doc));
  w.move();
  assert.equal(w.back.restore(same), true);
  assert.deepEqual(w.calls, []); assert.equal(w.doc.activeElement, filter);
});

test("return is refused when the operator moved on: another workspace, a tab over the dialog, another stage, a closed tab", async t => {
  for (const moveOn of [
    u => { u.state.workspace = "B"; u.state.generation++; },
    u => { u.state.generation++; },
    u => { u.state.layer = true; },
    u => { u.state.stage = "automations"; },
  ]) {
    const u = surfaces(t, { stage: "automations" });
    u.doc.querySelector("#stagehost .filter").focus();
    const origin = u.back.capture(captureFocusReturn(u.doc));
    u.move(); moveOn(u);
    assert.equal(u.back.restore(origin), false);
    assert.deepEqual(u.calls, [], "nothing is forced");
  }
  const u = surfaces(t, { stage: "automations", tab: 1 });
  const origin = u.back.capture(captureFocusReturn(u.doc));
  u.move(); origin.tab = 2; // a tab that no longer exists
  assert.equal(u.back.restore(origin), false);
});

test("a stage return that a newer action overtakes does not steal focus", async t => {
  const u = surfaces(t, { stage: "automations" });
  u.doc.querySelector("#stagehost .filter").focus();
  const origin = u.back.capture(captureFocusReturn(u.doc));
  u.move();
  u.back.restore(origin);
  const row = u.doc.querySelector('#ws-options .ws-option[aria-current="true"]');
  row.focus(); // the operator is already elsewhere (the workspace list) when the stage mounts
  await new Promise(setImmediate);
  assert.equal(u.doc.activeElement, row);
});

// The sidebar's width handle is a Tab stop, the sidebar's last (after the foot), and counts as the foot:
// no region, F6 on to main and Shift+F6 back to the roster. A hidden sidebar hides it.
test("the sidebar's width handle: a Tab stop after the foot that F6 treats as the foot", t => {
  const s = shell(t);
  const { handle } = createSidebarWidth({ doc: s.doc, win: s.dom.window });
  assert.equal(s.doc.getElementById("sidebar").lastElementChild, handle, "the sidebar's last element");
  assert.equal(s.doc.getElementById("nav-foot").compareDocumentPosition(handle) & s.dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    s.dom.window.Node.DOCUMENT_POSITION_FOLLOWING, "after the foot in Tab order");
  assert.equal(handle.tabIndex, 0);
  handle.focus(); assert.equal(s.doc.activeElement, handle);
  assert.equal(s.regions.regionOfFocus(), null, "no region");
  s.regions.cycle(1); assert.equal(s.where(), "Souls", "F6: main");
  handle.focus(); s.regions.cycle(-1); assert.equal(s.where(), "b", "Shift+F6: the roster's stop");
  assert.equal(REGIONS.some(name => s.regions.visible(name) && s.regions.currentItem(name) === handle), false, "no region lands on it");
  for (const cls of ["sidebar-hidden", "focus-mode"]) {
    s.doc.getElementById("app").classList.add(cls);
    assert.equal(isShown(handle), false, `${cls}: hidden with the sidebar`);
    s.doc.getElementById("app").classList.remove(cls);
  }
});
