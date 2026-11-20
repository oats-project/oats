// The Desktop UI rework, slice 2b: Home focused on what needs you, and the Workspace page in its own place. The
// spec's pinned acceptance tests, by name (`slice2b workspace row highlights for workspace pages` runs the shipped
// shell in test/navigation-projection.test.mjs, beside the harness it needs), then what else the slice asks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { runInNewContext } from "node:vm";
import { TAB_LABELS } from "../renderer/workspace-discovery.mjs";
import { createHome, homeCSS, HOME_LAYOUT, NEEDS_YOU_SHOWN, RUNNING_SHOWN, TILES, summaryLine } from "../renderer/views/home.mjs";
import { homeBoard, homeAgents } from "../../client/home-board.mjs";
import { TEXT_PAIRS, GRAPHIC_PAIRS, TEXT_CONTRAST, GRAPHIC_CONTRAST } from "../renderer/contrast-inventory.mjs";

const renderer = new URL("../renderer/", import.meta.url);
const spawnSource = readFileSync(new URL("views/spawn.mjs", renderer), "utf8");
const claim = (message, since) => ({ since, producer: "agent", reason: "attention", message });
const row = (instance, extra = {}) => ({ instance, agent: "oats-expert", running: true, runtimeState: "running", createdAt: "2026-11-01T00:00:00.000Z", ...extra });
/** Pepe's workspace (2026-11-20): 24 agents, 21 running and 3 waiting on you. `waiting` sets how many wait. */
function pepe(waiting = 3, total = 24) {
  return Array.from({ length: total }, (_, i) => row(`agent-${String(i).padStart(2, "0")}`, {
    createdAt: new Date(Date.UTC(2026, 10, 1, i)).toISOString(),
    ...(i < waiting ? { waitingOnYou: claim(`Question ${i}`, new Date(Date.UTC(2026, 10, 19, i)).toISOString()) } : {}),
  }));
}

function fixture(t, { rows = [], phase = "ready", cli = () => ({ features: [] }), post = async (path) => (path.startsWith("/api/workspace-sync") ? { status: "ok", capabilities: { capabilities: [1, 2] } } : { status: "refused" }),
  failed = false, pins = false } = {}) {
  const dom = new JSDOM("<!doctype html><body><main></main></body>", { pretendToBeVisual: true });
  const doc = dom.window.document, el = doc.querySelector("main");
  const listeners = new Set(), failedListeners = new Set(), opened = [], tabs = [], pages = [];
  let state = { rows, phase, deployments: [], stale: () => false, here: "falcon", pins }, mark = failed;
  const ctx = {
    api: async (path, opts) => (opts?.method === "POST" ? post(path, JSON.parse(opts.body)) : { agents: Array(26).fill(0), catalog: { reason: null } }),
    homeRoster: () => state,
    subscribeHomeRoster: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    openAgent: (r) => { opened.push(r.instance); return true; },
    openWorkspaceTab: (tab, options) => { tabs.push(options ? [tab, options.machinesView] : tab); },
    openPage: (name) => { pages.push(name); },
    automationsFailed: () => mark,
    subscribeAutomationsFailed: (fn) => { failedListeners.add(fn); return () => failedListeners.delete(fn); },
    chordText: () => "",
  };
  const ws = { gen: 1, listeners: new Set() };
  const home = createHome(el, ctx, { doc, cli: () => cli(), subscribeCli: () => () => {}, subscribeWorkspace: (fn) => { ws.listeners.add(fn); return () => ws.listeners.delete(fn); },
    generation: () => ws.gen, setTimeout: () => 0, clearTimeout: () => {} });
  t.after(() => { home.dispose(); dom.window.close(); });
  return {
    doc, el, home, opened, tabs, pages,
    set(next) { state = { ...state, ...next }; for (const fn of listeners) fn(); },
    fail(on) { mark = on; for (const fn of failedListeners) fn(on); },
    switchWorkspace() { ws.gen++; for (const fn of ws.listeners) fn(); },
    needs: () => [...el.querySelectorAll('[data-home-section="needs-you"] [data-home-agent]')].map((b) => b.dataset.homeAgent),
    running: () => [...el.querySelectorAll('[data-home-section="running"] [data-home-agent]')].map((b) => b.dataset.homeAgent),
    tile: (key) => el.querySelector(`[data-home-open="${key}"]`),
    settle: () => new Promise((r) => setTimeout(r, 0)),
  };
}

// Amendment 1 (B, Pepe, 2026-11-20) keeps a Running group, cropped: this pinned test now holds what B keeps of it. Slice
// 2's 21 running rows, each saying "running", are gone: RUNNING_SHOWN rows under one heading, and the summary line.
test("slice2b home has no running list", (t) => {
  const u = fixture(t, { rows: pepe() });
  assert.deepEqual(u.needs(), ["agent-02", "agent-01", "agent-00"], "the three waiting, newest claim first");
  assert.equal(u.running().length, RUNNING_SHOWN, "never the whole running list until asked");
  assert.equal(u.el.querySelectorAll("[data-home-agent]").length, 3 + RUNNING_SHOWN);
  assert.doesNotMatch([...u.el.querySelectorAll("[data-home-agent]")].map((b) => b.textContent).join(" "), /\brunning\b/, "no row says running");
  const summary = u.el.querySelector(".home-summary");
  assert.equal(summary.textContent, "24 agents · 21 running · 3 need you · 0 stopped");
  assert.equal(summary.tagName, "P", "a line of text, not a list");
  assert.equal(summary.querySelector("button, li"), null);
  // The counts are the shared model's (packages/client/home-board.mjs), so the TUI says the same.
  assert.deepEqual(homeBoard(pepe()).counts, { agents: 24, running: 21, needYou: 3, stopped: 0, unknown: 0 });
  assert.equal(summaryLine({ agents: 1, running: 0, needYou: 0, stopped: 1, unknown: 0 }), "1 agent · 0 running · 0 need you · 1 stopped");
  assert.equal(summaryLine({ agents: 3, running: 1, needYou: 0, stopped: 1, unknown: 1 }), "3 agents · 1 running · 0 need you · 1 stopped · 1 status unknown");
});

test("slice2b needs you first, capped at 8 with show all", (t) => {
  const u = fixture(t, { rows: pepe(11) });
  const section = u.el.querySelector('[data-home-section="needs-you"]');
  assert.equal(u.el.querySelector(".home-inner > h1").nextElementSibling, section, "Needs you comes first, under the title");
  assert.equal(section.querySelector("h2").textContent, "Needs you");
  assert.equal(NEEDS_YOU_SHOWN, 8);
  assert.deepEqual(u.needs(), ["agent-10", "agent-09", "agent-08", "agent-07", "agent-06", "agent-05", "agent-04", "agent-03"], "8, newest claim first");
  // Each row: the needs-input mark, the name, soul · machine, and its message.
  const first = u.el.querySelector('[data-home-agent="agent-10"]');
  assert.ok(first.querySelector(".attn-mark"), "the needs-input mark");
  assert.equal(first.querySelector(".home-row-name").textContent, "Agent 10");
  assert.equal(first.querySelector(".home-row-meta").textContent, "oats-expert · falcon");
  assert.equal(first.querySelector(".home-row-message").textContent, "Question 10");
  const showAll = () => u.el.querySelector('[data-home-more="needs"]');
  const more = showAll();
  assert.equal(more.textContent, "Show all 11"); assert.equal(more.tagName, "BUTTON");
  more.focus(); u.set({ rows: pepe(11) });
  assert.equal(u.doc.activeElement, showAll(), "a repaint keeps the focus on Show all");
  showAll().click();
  assert.equal(u.needs().length, 11, "expands in place");
  assert.equal(showAll(), null);
  assert.equal(u.doc.activeElement.dataset.homeAgent, "agent-02", "focus on the first row it showed");
  u.set({ rows: pepe(11) }); assert.equal(u.needs().length, 11, "stays expanded on a repaint");
  u.switchWorkspace(); u.set({ rows: pepe(11) }); assert.equal(u.needs().length, 8, "another workspace starts folded");
  // Enter on a row opens it as the roster does.
  u.el.querySelector('[data-home-agent="agent-05"]').click();
  assert.deepEqual(u.opened, ["agent-05"]);
  // Exactly 8: no Show all. None: one quiet line.
  u.set({ rows: pepe(8) }); assert.equal(u.needs().length, 8); assert.equal(showAll(), null);
  u.set({ rows: pepe(0) });
  assert.equal(u.el.querySelector('[data-home-section="needs-you"] .home-quiet').textContent, "Nothing needs you.");
});

test("slice2b tiles visible without scrolling", async (t) => {
  const u = fixture(t, { rows: pepe(11) });
  await u.settle(); await u.settle();
  // Layout order: the title, Needs you, the summary line, then the tiles, and Running below them (Amendment 1: under the
  // tiles, so the tiles stay in the first viewport); nothing between.
  const parts = [...u.el.querySelector(".home-inner").children];
  assert.deepEqual(parts.map((n) => n.dataset.homeSection ?? n.className ?? n.tagName), ["", "needs-you", "home-summary", "workspace", "running"]);
  assert.equal(parts[0].tagName, "H1");
  const tiles = [...parts[3].querySelectorAll("button")];
  assert.deepEqual(tiles.map((b) => b.dataset.homeOpen), ["agents", "souls", "capabilities", "teams", "machines", "automations"]);
  assert.equal(parts[3].querySelectorAll("ul.home-tiles").length, 1, "one row of tiles");
  assert.match(homeCSS, new RegExp(`\\.home-tiles \\{[^}]*grid-template-columns:repeat\\(${TILES.length}, minmax\\(0, 1fr\\)\\)`), "every tile in one row");
  // The compact height budget, from the numbers homeCSS is built from (jsdom has no layout; the live screenshot at
  // 1280×800 proves it): the title, Needs you with 8 rows and Show all, the summary line and the tiles.
  const L = HOME_LAYOUT;
  assert.match(homeCSS, new RegExp(`\\.home-needs \\.home-row \\{ height:${L.needRow}px`));
  assert.match(homeCSS, new RegExp(`\\.home-tile \\{[^}]*height:${L.tile}px`));
  assert.match(homeCSS, new RegExp(`\\.home \\{[^}]*padding:${L.padTop}px`));
  const bottom = L.padTop + L.title + L.titleGap + L.heading + L.headingGap + NEEDS_YOU_SHOWN * L.needRow + (NEEDS_YOU_SHOWN - 1) * L.rowGap
    + L.rowGap + L.more + L.summaryGap + L.summary + L.summaryGap + L.tile;
  // 800px tall, less the window's chrome around the stage (the status line, the tab strip's room): 640px of page.
  assert.ok(bottom <= 640, `the tiles end at ${bottom}px, inside the first viewport`);
});

test("slice2b workspace page title", () => {
  // Above the tab bar, "Workspace › <its tab>", styled as Home's head; a soul's, capability's or team's page hides it.
  const markup = spawnSource.match(/<h1 class="workspace-title">Workspace<\/h1>\s*<header class="workspace-header"><\/header>/);
  assert.ok(markup, "the title is the page's first line, above the tab bar");
  assert.match(spawnSource, /function syncWorkspaceTitle\(s\) \{\n  const title = s\.q\("workspace-title"\);\n  if \(title\) title\.textContent = `Workspace › \$\{TAB_LABELS\[s\.discovery\?\.tab \?\? "souls"\] \?\? TAB_LABELS\.souls\}`;\n\}/);
  assert.match(spawnSource, /onTab: tab => \{\n      syncWorkspaceTitle\(s\);/, "it follows the tab");
  assert.match(spawnSource, /applyWorkspaceTab\(s\);\n  syncWorkspaceTitle\(s\);/, "and says the tab the page opened on");
  assert.match(spawnSource, /s\.q\("workspace-header"\)\.hidden = !!mode;\n  s\.q\("workspace-title"\)\.hidden = !!mode;/, "a page keeps its own breadcrumb");
  const title = spawnSource.match(/\.workspace-title \{[^}]*\}/)[0];
  const head = homeCSS.match(/\.home h1 \{[^}]*\}/)[0];
  for (const rule of ["font-size:24px", "font-weight:700", `line-height:${HOME_LAYOUT.title}px`]) {
    assert.ok(title.includes(rule) && head.includes(rule), `the same head as Home's: ${rule}`);
  }
  // Run the shipped function on the page's own markup, for each tab.
  const dom = new JSDOM(`<div class="souls"><h1 class="workspace-title">Workspace</h1><header class="workspace-header"></header></div>`);
  const fn = spawnSource.match(/function syncWorkspaceTitle\(s\) \{[^]*?\n\}/)[0];
  const sync = runInNewContext(`${fn}\nsyncWorkspaceTitle`, { TAB_LABELS });
  const s = { q: (cls) => dom.window.document.querySelector(`.${cls}`), discovery: { tab: "souls" } };
  for (const [tab, said] of [["souls", "Souls"], ["capabilities", "Capabilities"], ["teams", "Teams"], ["machines", "Machines"], ["sources", "Setup"]]) {
    s.discovery.tab = tab; sync(s);
    assert.equal(s.q("workspace-title").textContent, `Workspace › ${said}`);
  }
  dom.window.close();
});

test("slice2b the workspace tiles: buttons named with their counts, Automations with its failure mark", async (t) => {
  const cli = () => ({ ok: true, features: ["automations"], automationsApi: 1 });
  const post = async (path, body) => {
    if (path.startsWith("/api/workspace-sync")) return { status: "ok", capabilities: { capabilities: [1, 2] } };
    if (path.startsWith("/api/automations")) return { status: "ok", result: body.kind === "schedule" ? { schedules: [{ qualifiedId: "a" }, { qualifiedId: "b" }] } : { triggers: [{ qualifiedId: "t" }] } };
    return { status: "refused" };
  };
  const u = fixture(t, { rows: pepe(), cli, post });
  assert.equal(u.tile("automations").getAttribute("aria-label"), "Automations, Counting…", "pending says so, never a 0");
  await u.settle(); await u.settle(); await u.settle();
  assert.deepEqual(TILES.map((e) => u.tile(e.key).getAttribute("aria-label")),
    ["Agents, 24", "Souls, 26", "Capabilities, 2", "Teams", "Machines, 1", "Automations, 3"]);
  assert.equal(u.tile("souls").querySelector(".home-tile-count").textContent, "26");
  assert.equal(u.tile("automations").querySelector(".home-tile-failed"), null);
  u.fail(true);
  assert.equal(u.tile("automations").getAttribute("aria-label"), "Automations, 3, a run failed", "the sidebar row's words");
  assert.equal(u.tile("automations").querySelector(".home-tile-failed").getAttribute("aria-hidden"), "true");
  u.fail(false); assert.equal(u.tile("automations").querySelector(".home-tile-failed"), null);
  u.tile("automations").click(); assert.deepEqual(u.pages, ["automations"], "its own page");
  u.tile("souls").click(); u.tile("machines").click();
  assert.deepEqual(u.tabs, ["souls", ["machines", "list"]]);
  // No Graph tile: the Graph is frozen.
  assert.equal(u.tile("graph"), null);
  // An OATS that serves no automations: no count, the tile still opens the page; a failed read says so.
  const v = fixture(t, { rows: pepe(), cli: () => ({ ok: true, features: [] }) });
  assert.equal(v.tile("automations").getAttribute("aria-label"), "Automations");
  const w = fixture(t, { rows: pepe(), cli, post: async (path) => (path.startsWith("/api/automations") ? { status: "refused" } : { status: "ok" }) });
  await w.settle(); await w.settle(); await w.settle();
  assert.equal(w.tile("automations").getAttribute("aria-label"), "Automations, Couldn't count");
});

test("slice2b keyboard order: Needs you, then the tiles; first run keeps its two lines and three keys, then the tiles", (t) => {
  const u = fixture(t, { rows: pepe(11) });
  const order = [...u.el.querySelectorAll("button")].map((b) => b.dataset.homeAgent ? "row" : b.dataset.homeMore ? `more-${b.dataset.homeMore}` : b.dataset.homeOpen);
  assert.deepEqual(order, [...Array(8).fill("row"), "more-needs", "agents", "souls", "capabilities", "teams", "machines", "automations",
    ...Array(RUNNING_SHOWN).fill("row"), "more-running"], "then Running, under the tiles (Amendment 1)");
  for (const b of u.el.querySelectorAll("button")) assert.equal(b.getAttribute("tabindex"), null, "every one a Tab stop");
  const v = fixture(t, { rows: [] });
  const first = v.el.querySelector('[data-home-section="first-run"]');
  assert.equal(first.querySelectorAll("p").length, 2); assert.equal(first.querySelectorAll("li").length, 3);
  assert.equal(first.nextElementSibling.dataset.homeSection, "workspace", "the tiles still show below it");
});

test("slice2b Home › Agents follows the roster's order, pinned first where the roster shows pins (#1974)", (t) => {
  const rows = [row("old", { createdAt: "2026-11-01T00:00:00.000Z", pinned: true }), row("new", { createdAt: "2026-11-03T00:00:00.000Z" }),
    row("mid", { createdAt: "2026-11-02T00:00:00.000Z" })];
  assert.deepEqual(homeAgents(rows, { pins: true }).map((r) => r.instance), ["old", "new", "mid"]);
  assert.deepEqual(homeAgents(rows).map((r) => r.instance), ["new", "mid", "old"], "no pins without the CLI's feature");
  const u = fixture(t, { rows, pins: true });
  u.tile("agents").click();
  assert.deepEqual([...u.el.querySelectorAll("[data-home-agent]")].map((b) => b.dataset.homeAgent), ["old", "new", "mid"]);
});

// WCAG AA in every theme: each colour Home paints is a token (never a raw colour, no opacity), and each ink on each
// fill it is drawn on (at rest, hovered, focused) is a pair of the contrast inventory, which theme-contrast.test.mjs
// holds to AA in every built-in palette and the "This computer" derivation.
test("slice2b Home's colours are inventory pairs in every theme", () => {
  assert.doesNotMatch(homeCSS, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, "no raw colour");
  assert.doesNotMatch(homeCSS, /opacity/, "no opacity compositing over text");
  const rule = (sel) => { const m = homeCSS.match(new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`)); assert.ok(m, sel); return m[1]; };
  const token = (decl, prop) => decl.match(new RegExp(`(?:^|[;{\\s])${prop}:var\\(--([\\w-]+)\\)`))?.[1];
  const text = [], graphic = [];
  // Rows (Needs you, Home › Agents) on the page's --bg, hovered --surface-2, focused --sel.
  for (const bg of ["bg", "surface-2", "sel"]) {
    text.push([token(rule(".home-row"), "color"), bg], [token(rule(".home-row-meta"), "color"), bg], [token(rule(".home-row-message"), "color"), bg]);
    text.push([token(rule(".home button.home-more"), "color"), bg]);
  }
  text.push([token(rule(".home-summary"), "color"), "bg"]);
  // Tiles on their own --surface, hovered --surface-2, focused --sel; the failure dot a graphic on each.
  assert.equal(token(rule(".home-tile"), "background"), "surface");
  assert.equal(token(rule(".home-tile:hover"), "background"), "surface-2");
  assert.equal(token(rule(".home-tile:focus-visible"), "background"), "sel");
  for (const bg of ["surface", "surface-2", "sel"]) {
    for (const sel of [".home-tile-name", ".home-tile-count", ".home-tile-count.pending"]) text.push([token(rule(sel), "color"), bg]);
    graphic.push([token(rule(".home-tile-failed"), "background"), bg]);
  }
  const has = (list, [fg, bg]) => list.some(([f, b]) => f === fg && b === bg);
  for (const pair of text) assert.ok(has(TEXT_PAIRS, pair), `--${pair[0]} on --${pair[1]} is held to ${TEXT_CONTRAST}:1`);
  for (const pair of graphic) assert.ok(has(TEXT_PAIRS, pair) || has(GRAPHIC_PAIRS, pair), `--${pair[0]} on --${pair[1]} is held to ${GRAPHIC_CONTRAST}:1`);
  // The Workspace page's title: --fg on the page's --bg.
  assert.match(spawnSource.match(/\.workspace-title \{[^}]*\}/)[0], /color:var\(--fg\)/);
  assert.ok(has(TEXT_PAIRS, ["fg", "bg"]));
});

// Amendment 1, B (Pepe, 2026-11-20: "que la llista de running agents estigui cropped i sigui expandible").
test("slice2b running cropped at 5, show all expands and collapses", (t) => {
  const pinnedRows = pepe(3).map((r, i) => (i === 20 ? { ...r, pinned: true } : r));
  const u = fixture(t, { rows: pinnedRows, pins: true });
  assert.equal(RUNNING_SHOWN, 5);
  const section = u.el.querySelector('[data-home-section="running"]');
  assert.equal(section.querySelector("h2").textContent, "Running");
  // The roster's order: pinned first, then newest spawn first.
  assert.deepEqual(u.running(), ["agent-20", "agent-23", "agent-22", "agent-21", "agent-19"]);
  for (const b of section.querySelectorAll("[data-home-agent]")) {
    assert.equal(b.querySelector(".home-row-side"), null, "no right-aligned state word");
    assert.ok(b.querySelector(".home-dot.on"), "the running dot");
  }
  const toggle = () => u.el.querySelector('[data-home-more="running"]');
  assert.equal(toggle().textContent, "Show all 21 running");
  toggle().click();
  assert.equal(u.running().length, 21, "expands in place");
  assert.equal(u.doc.activeElement.dataset.homeAgent, "agent-18", "focus on the first row it showed");
  assert.equal(toggle().textContent, "Show fewer");
  u.set({ rows: pinnedRows }); assert.equal(u.running().length, 21, "stays expanded on a repaint");
  toggle().click();
  assert.equal(u.running().length, RUNNING_SHOWN, "folds back");
  assert.equal(u.doc.activeElement, toggle(), "the focus stays on the toggle");
  u.running(); u.el.querySelector('[data-home-agent="agent-23"]').click();
  assert.deepEqual(u.opened, ["agent-23"], "a row opens as the roster's does");
  // Five or fewer: no toggle. None running: no group.
  u.set({ rows: pepe(3, 8) }); assert.equal(u.running().length, 5); assert.equal(toggle(), null);
  u.set({ rows: pepe(3, 3) }); assert.equal(u.el.querySelector('[data-home-section="running"]'), null);
  u.switchWorkspace(); u.set({ rows: pinnedRows }); assert.equal(u.running().length, RUNNING_SHOWN, "another workspace starts folded");
});

// Amendment 1, A (Pepe: "que vagi centered").
test("slice2b home centered", (t) => {
  const rule = homeCSS.match(/\.home-inner \{([^}]*)\}/)[1];
  assert.match(rule, /max-width:880px/); assert.match(rule, /margin:0 auto/);
  const u = fixture(t, { rows: pepe() });
  u.tile("agents").click();
  assert.ok(u.el.querySelector(".home-inner [data-home-section=agents]"), "Home › Agents is in the same centred column");
});

// Amendment 1, C (Pepe: "mes font hierarchy en els soul cards"): the Souls grid's card in the information-role scale
// (chrome-typography-follows-information-role): the name a card title, what it does body and muted, the agents and
// kind a secondary meta line.
test("slice2b soul card type hierarchy", () => {
  const rules = [...spawnSource.matchAll(/^\.soul-card (?:\.stitle|\.sdesc|\.sfoot|\.sactivity\.running) \{[^}]*\}/gm)].map((m) => m[0]).join("\n");
  const dom = new JSDOM(`<style>${rules}</style><button class="soul-card"><span class="stitle">dev</span><p class="sdesc">Build and review</p>
    <span class="sfoot"><span class="sactivity running">2 agents running</span><span class="skind">· other</span></span></button>`);
  const style = (sel) => dom.window.getComputedStyle(dom.window.document.querySelector(sel));
  const px = (sel) => parseFloat(style(sel).fontSize);
  assert.deepEqual([style(".stitle").fontSize, style(".stitle").fontWeight], ["17px", "700"], "the name: the card title's 17 / 700");
  assert.doesNotMatch(rules.match(/\.soul-card \.stitle \{[^}]*\}/)[0], /color:/, "the name keeps the card's --fg");
  assert.deepEqual([style(".sdesc").fontSize, style(".sdesc").color], ["13px", "var(--muted)"], "what it does: body, muted");
  assert.deepEqual([style(".sfoot").fontSize, style(".sfoot").color], ["12px", "var(--muted)"], "the meta line: secondary, muted");
  assert.deepEqual([style(".sactivity.running").color, style(".sactivity.running").fontWeight], ["var(--muted)", "400"], "its count is meta, the name leads");
  assert.ok(px(".stitle") > px(".sdesc") && px(".sdesc") > px(".sfoot"), "three steps: name, body, meta");
  dom.window.close();
});
