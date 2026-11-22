// The Desktop UI rework, slice 2: Home. The spec's pinned acceptance tests, by name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { NAV, PINNED, pinnedRowFor } from "../renderer/shell-nav.mjs";
import { createHome, mount, TILES, tileCount, firstRunCopy } from "../renderer/views/home.mjs";
import { homeBoard, homeAgents, startedBy } from "../../client/home-board.mjs";
import { rosterGroups } from "../../client/instance-tree.mjs";

const shell = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
const claim = (message = "Pick the copy", since = "2026-11-19T10:00:00.000Z") => ({ since, producer: "agent", reason: "attention", message });
const row = (instance, extra = {}) => ({ instance, agent: "oats-expert", running: true, runtimeState: "running", createdAt: "2026-11-01T00:00:00.000Z", ...extra });

function fixture(t, { rows = [], phase = "ready", deployments = [], api = async () => ({ agents: [1, 2, 3] }), post = async () => ({ status: "ok", capabilities: { capabilities: [1, 2] } }),
  cli = () => ({ features: [] }) } = {}) {
  const dom = new JSDOM('<!doctype html><body><main></main></body>', { pretendToBeVisual: true });
  const doc = dom.window.document, el = doc.querySelector("main");
  const listeners = new Set(), opened = [], tabs = [];
  let state = { rows, phase, deployments, stale: () => false, here: "falcon", retry: () => { state.retried = true; } };
  const ctx = {
    api: async (path, opts) => (opts?.method === "POST" ? post(path, JSON.parse(opts.body)) : api(path)),
    homeRoster: () => state,
    subscribeHomeRoster: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    openAgent: (r) => { opened.push(r.instance); return true; },
    openWorkspaceTab: (tab, options) => { tabs.push(options ? [tab, options.machinesView] : tab); },
    chordText: (id) => ({ "app.quickOpenSouls": "Ctrl+N", "app.palette": "Ctrl+K" })[id] ?? "",
  };
  // The window's workspace and the CLI's probe, as Home reads them, driven by the test.
  const ws = { gen: 1, listeners: new Set() }, cliListeners = new Set();
  // Home's own retry timers, run by the test (`tick`), never by the clock.
  const timers = new Map(); let nextTimer = 1;
  const home = createHome(el, ctx, { doc, cli: () => cli(), subscribeCli: (fn) => { cliListeners.add(fn); return () => cliListeners.delete(fn); },
    subscribeWorkspace: (fn) => { ws.listeners.add(fn); return () => ws.listeners.delete(fn); }, generation: () => ws.gen,
    setTimeout: (fn) => { const id = nextTimer++; timers.set(id, fn); return id; }, clearTimeout: (id) => timers.delete(id) });
  t.after(() => { home.dispose(); dom.window.close(); });
  const buttons = () => [...el.querySelectorAll("button")];
  return {
    doc, el, home, opened, tabs, ctx,
    switchWorkspace() { ws.gen++; for (const fn of ws.listeners) fn(); },
    timers,
    tick() { const due = [...timers.values()]; timers.clear(); for (const fn of due) fn(); },
    cliAnswered() { for (const fn of cliListeners) fn(); },
    set(next) { state = { ...state, ...next }; for (const fn of listeners) fn(); },
    agentButton: (name) => buttons().find((b) => b.dataset.homeAgent === name),
    openButton: (key) => buttons().find((b) => b.dataset.homeOpen === key),
    key: (target, key) => target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })),
    settle: () => new Promise((r) => setTimeout(r, 0)),
  };
}

test("slice2 home is the landing surface", () => {
  // Home is the first pinned row. Slice 2b (supersedes slice 2's "Home's row stands for the Workspace page"): the
  // Workspace page has its own row, after Home's, then Automations.
  assert.deepEqual(PINNED.map((v) => v.name), ["home", "spawn", "automations"]);
  assert.equal(NAV[0].name, "home"); assert.equal(NAV[0].label, "Home");
  assert.equal(pinnedRowFor("spawn"), "spawn"); assert.equal(pinnedRowFor("automations"), "automations");
  // A workspace lands on Home: at start and when a window is bound again.
  assert.match(shell, /\nshowStage\("home"\);/);
  assert.match(shell, /void showStage\("home"\); \/\/ the landing surface: Home/);
  assert.doesNotMatch(shell, /\nshowStage\("spawn"\);/);
  assert.match(shell, /for \(const v of PINNED\) \{/);
  // The stage contract: mount returns its own disposer.
  const dom = new JSDOM("<!doctype html><body><main></main></body>"), el = dom.window.document.querySelector("main");
  const dispose = mount(el, { api: async () => ({}), homeRoster: () => ({ rows: [], deployments: [], phase: "loading", stale: () => false }) });
  assert.equal(typeof dispose, "function"); dispose(); dom.window.close();
});

test("slice2 board groups", async (t) => {
  // Slice 2b: Needs you, the summary line, and (Amendment 1) a cropped Running group under the tiles.
  const rows = [
    row("waits-old", { waitingOnYou: claim("Old question", "2026-11-19T09:00:00.000Z"), createdAt: "2026-11-05T00:00:00.000Z" }),
    row("waits-new", { waitingOnYou: claim("Newer question", "2026-11-19T11:00:00.000Z"), createdAt: "2026-11-02T00:00:00.000Z" }),
    row("runs-old", { createdAt: "2026-11-01T00:00:00.000Z" }),
    row("runs-new", { createdAt: "2026-11-09T00:00:00.000Z" }),
    row("stopped", { running: false, runtimeState: "stopped" }),
    row("unknown", { running: null, runtimeState: null }),
    row("unreached", { serverUnreached: true }),
  ];
  const u = fixture(t, { rows });
  const needs = () => [...u.el.querySelectorAll('[data-home-section="needs-you"] [data-home-agent]')].map((b) => b.dataset.homeAgent);
  const summary = () => u.el.querySelector(".home-summary")?.textContent ?? null;
  // Needs you, newest claim first, with its message; Running in the roster's order; stopped and unknown are counted only.
  assert.deepEqual(needs(), ["waits-new", "waits-old"]);
  assert.match(u.agentButton("waits-new").textContent, /Newer question/);
  assert.match(u.agentButton("waits-new").textContent, /oats-expert/, "its soul, as the roster says it (slice 3d: no machine for a local agent)");
  assert.doesNotMatch(u.agentButton("waits-new").textContent, /· falcon/);
  assert.deepEqual([...u.el.querySelectorAll('[data-home-section="running"] [data-home-agent]')].map((b) => b.dataset.homeAgent), ["runs-new", "runs-old"]);
  assert.doesNotMatch(u.agentButton("runs-new").textContent, /\brunning\b/, "the heading says it, not each row");
  assert.equal(summary(), "7 agents · 2 running · 2 need you · 1 stopped · 2 status unknown");
  // None needs you: one quiet line.
  u.set({ rows: [row("only-runs")] });
  assert.deepEqual(needs(), []);
  assert.match(u.el.textContent, /Nothing needs you\./);
  assert.equal(summary(), "1 agent · 1 running · 0 need you · 0 stopped");
  // A stale roster's claim is unknown: the row isn't counted as needing you.
  u.set({ rows: [row("stale-wait", { waitingOnYou: claim() })], stale: () => true });
  assert.deepEqual(needs(), []);
  assert.equal(summary(), "1 agent · 1 running · 0 need you · 0 stopped");
  // Enter (a click) opens the row as the roster does.
  u.set({ rows: [row("open-me", { waitingOnYou: claim() })], stale: () => false });
  u.agentButton("open-me").click();
  assert.deepEqual(u.opened, ["open-me"]);
  // Distinct loading and failed states, with no summary line.
  u.set({ rows: [], phase: "loading" });
  assert.match(u.el.querySelector('[role="status"]').textContent, /Reading your agents…/);
  assert.equal(summary(), null);
  u.set({ phase: "failed" });
  assert.match(u.el.textContent, /Couldn't read your agents\./);
  assert.equal(summary(), null);
  [...u.el.querySelectorAll("button")].find((b) => b.textContent === "Retry").click();
  assert.equal(u.ctx.homeRoster().retried, true);
});

test("slice2 overview counts and enter opens section, esc returns", async (t) => {
  // Slice 2b: the overview is one row of tiles, each its count; no Graph tile (the Graph is frozen), and Automations.
  const u = fixture(t, { rows: [row("a"), row("b", { running: false })], deployments: [{ id: "/w", machine: "falcon" }, { id: "ssh://build-host/w", machine: "build-host" }] });
  assert.deepEqual([...u.el.querySelectorAll("[data-home-open]")].map((b) => b.dataset.homeOpen), TILES.map((o) => o.key));
  assert.deepEqual(TILES.map((o) => o.label), ["Agents", "Souls", "Capabilities", "Teams", "Machines", "Automations"]);
  assert.match(u.openButton("souls").textContent, /Counting…/, "a count being read says so");
  await u.settle(); await u.settle();
  assert.equal(u.openButton("agents").getAttribute("aria-label"), "Agents, 2");
  assert.equal(u.openButton("souls").getAttribute("aria-label"), "Souls, 3");
  assert.equal(u.openButton("capabilities").getAttribute("aria-label"), "Capabilities, 2");
  assert.equal(u.openButton("machines").getAttribute("aria-label"), "Machines, 2");
  assert.equal(tileCount("souls", { souls: 1 }), "1");
  assert.equal(tileCount("souls", { souls: "failed" }), "Couldn't count");
  // Enter on a section opens the Workspace page on its tab; Machines opens the Machines tab's List.
  u.openButton("souls").click(); u.openButton("teams").click(); u.openButton("machines").click();
  assert.deepEqual(u.tabs, ["souls", "teams", ["machines", "list"]]);
  // Esc on the Workspace page comes back to Home (shell.mjs): only an Esc nothing on the page took, from no field.
  assert.match(shell, /if \(e\.key !== "Escape" \|\| e\.defaultPrevented \|\| e\.altKey \|\| e\.ctrlKey \|\| e\.metaKey \|\| e\.shiftKey \|\| stage\?\.name !== "spawn"\) return;/);
  assert.match(shell, /e\.preventDefault\(\);\n  void showStageFocused\("home"\);/);
  // Agents opens Home › Agents here, and Esc returns to the board with focus on Agents.
  u.openButton("agents").click();
  assert.equal(u.home.view, "agents");
  u.key(u.doc.activeElement, "Escape");
  assert.equal(u.home.view, "board");
  assert.equal(u.doc.activeElement, u.openButton("agents"));
  // A failed count says so; the others stand.
  const v = fixture(t, { rows: [row("a")], api: async () => { throw new Error("down"); } });
  await v.settle(); await v.settle();
  assert.match(v.openButton("souls").textContent, /Couldn't count/);
});

test("slice2 home agents flat list", async (t) => {
  const rows = [
    row("child", { parentInstance: "lead-one", createdAt: "2026-11-03T00:00:00.000Z", running: false, runtimeState: "stopped" }),
    row("lead-one", { attributedHuman: "Joan", createdAt: "2026-11-02T00:00:00.000Z", waitingOnYou: claim() }),
    row("lone", { createdAt: "2026-11-04T00:00:00.000Z", running: null, runtimeState: null }),
    row("plain-runs", { createdAt: "2026-11-01T00:00:00.000Z" }),
  ];
  const u = fixture(t, { rows });
  u.openButton("agents").click();
  const listed = [...u.el.querySelectorAll("[data-home-agent]")];
  assert.deepEqual(listed.map((b) => b.dataset.homeAgent), ["lone", "child", "lead-one", "plain-runs"], "every agent, running or stopped, newest first");
  assert.match(listed[1].textContent, /Child.*oats-expert.*stopped · started by Lead one/s);
  // The roster's dot grammar (the lead's return): a waiting row wears the needs-input mark and says "needs you" first.
  assert.match(listed[2].textContent, /needs you · started by Joan/);
  assert.match(listed[2].querySelector(".home-row-copy").textContent, /Pick the copy/, "its claim's message, as merged (review r1, slice 2b)");
  assert.ok(listed[2].querySelector(".attn-mark"), "the needs-input mark, not a running dot");
  assert.equal(listed[2].querySelector(".home-dot"), null);
  assert.match(listed[3].textContent, /running$/);
  assert.equal(listed[3].querySelector(".attn-mark"), null); assert.ok(listed[3].querySelector(".home-dot.on"));
  assert.match(listed[0].textContent, /status unknown/);
  // Back is the app's quiet back control (as the capability page's), named for where it goes.
  const back = u.doc.activeElement;
  assert.equal(back.className, "home-back"); assert.equal(back.getAttribute("aria-label"), "Back to Home");
  assert.equal(back.textContent, "Home"); assert.ok(back.querySelector("svg"), "its chevron");
  listed[1].click();
  assert.deepEqual(u.opened, ["child"]);
  assert.equal(startedBy({ instance: "x" }), null);
  assert.deepEqual(homeAgents([{ instance: "" }, null, row("ok")]).map((r) => r.instance), ["ok"]);
});

test("slice2 first run", (t) => {
  const u = fixture(t, { rows: [] });
  const first = u.el.querySelector('[data-home-section="first-run"]');
  assert.ok(first, "a workspace with no agents shows the first run");
  assert.equal(first.querySelectorAll("p").length, 2, "OATS in two lines");
  assert.deepEqual([...first.querySelectorAll("li")].map((li) => li.textContent), ["New agent: Ctrl+N", "Command palette: Ctrl+K", "Home: Home in the palette"]);
  assert.ok(u.el.querySelector('[data-home-section="workspace"]'), "then the tiles (slice 2b)");
  assert.equal(u.el.querySelector('[data-home-section="needs-you"]'), null);
  assert.equal(u.el.querySelector(".home-summary"), null);
  assert.deepEqual(firstRunCopy(() => "").keys.map((k) => k.label), ["New agent", "Command palette", "Home"]);
});

test("slice2 roster order unchanged by board", () => {
  const rows = [row("old", { createdAt: "2026-11-01T00:00:00.000Z" }), row("waits", { createdAt: "2026-11-02T00:00:00.000Z", waitingOnYou: claim() }),
    row("new", { createdAt: "2026-11-03T00:00:00.000Z" })];
  const before = rows.map((r) => r.instance);
  const order = () => rosterGroups(rows, rows).flatMap((g) => g.clusters.flatMap((c) => c.instances.map((i) => i.instance)));
  const rosterBefore = order();
  const board = homeBoard(rows);
  assert.deepEqual(board.needsYou.map((e) => e.row.instance), ["waits"]);
  assert.deepEqual(rows.map((r) => r.instance), before, "the board sorts its own lists, never the roster's rows");
  assert.deepEqual(order(), rosterBefore, "the roster's order is the same with the board drawn");
  assert.deepEqual(rosterBefore, ["new", "waits", "old"], "newest spawn first, a waiting row where it stands");
  assert.doesNotMatch(shell, /home-board\.mjs/, "the shell's roster never reads the board's grouping");
});

// Review round 1 (slice 2): the counts follow the window's workspace, the CLI's probe, and a refused Teams read.
test("slice2 counts follow a workspace switch; a late answer for the one left is dropped", async (t) => {
  let souls = 3; const pending = [];
  const u = fixture(t, { rows: [row("a")], api: async () => { const n = souls; return new Promise((resolve) => pending.push(() => resolve({ agents: Array(n).fill(0) }))); } });
  await u.settle();
  assert.match(u.openButton("souls").textContent, /Counting…/);
  souls = 1; u.switchWorkspace(); await u.settle();
  pending[0](); await u.settle(); await u.settle();
  assert.match(u.openButton("souls").textContent, /Counting…/, "A's late answer is not B's count");
  pending[1](); await u.settle(); await u.settle();
  assert.equal(u.openButton("souls").getAttribute("aria-label"), "Souls, 1", "B's own count");
  // Home › Agents was A's place: a switch shows B's board.
  u.openButton("agents").click(); assert.equal(u.home.view, "agents");
  u.switchWorkspace(); assert.equal(u.home.view, "board");
});

test("slice2 Teams waits for the CLI's probe, and a refused Teams read fails Teams alone", async (t) => {
  let status = null; const asked = [];
  const post = async (path, body) => {
    asked.push(path.split("?")[0]);
    if (path.startsWith("/api/workspace-teams")) return { status: "refused", reason: { code: "E_UNREACHABLE", message: "Cannot reach deployment" } };
    return { status: "ok", capabilities: { capabilities: [1] } };
  };
  const rejections = []; const onRejection = (e) => rejections.push(e); process.on("unhandledRejection", onRejection);
  t.after(() => process.off("unhandledRejection", onRejection));
  const u = fixture(t, { rows: [row("a")], post, cli: () => status });
  await u.settle(); await u.settle();
  assert.match(u.openButton("teams").textContent, /Counting…/, "the probe is pending: not 'no teams'");
  assert.equal(asked.includes("/api/workspace-teams"), false);
  status = { features: ["team-model-3"] }; u.cliAnswered();
  await u.settle(); await u.settle(); await u.settle();
  assert.equal(asked.filter((p) => p === "/api/workspace-teams").length, 1, "one Teams read once the CLI says it has teams");
  assert.match(u.openButton("teams").textContent, /Couldn't count/, "a refusal is Teams' failure");
  assert.equal(u.openButton("souls").getAttribute("aria-label"), "Souls, 3", "the other counts stand");
  assert.equal(u.openButton("capabilities").getAttribute("aria-label"), "Capabilities, 1");
  u.cliAnswered(); await u.settle();
  assert.equal(asked.filter((p) => p === "/api/workspace-teams").length, 1, "a second CLI answer asks nothing again");
  assert.deepEqual(rejections, [], "no read rejects unhandled");
  // A CLI with no team model: Teams has no count line.
  const v = fixture(t, { rows: [row("a")], cli: () => ({ features: [] }) });
  assert.equal(v.openButton("teams").textContent, "Teams");
});

test("slice2 Enter on a section lands focus on its Workspace tab, so Esc goes straight back to Home", async () => {
  // The shipped handoff and the shipped Esc listener, run on a stage host whose Workspace page mounts its tabs.
  const dom = new JSDOM('<!doctype html><body><div id="stagehost"><div class="home"><button id="from">Souls</button></div></div></body>');
  const document = dom.window.document, stageHost = document.getElementById("stagehost"), went = [];
  const c = { document, stageHost, stage: { name: "home" }, stageOp: 0, tabLayerVisible: false,
    isShown: (el) => el.isConnected, focusRegions: { focusRegion: (name) => went.push(`region:${name}`) },
    openWorkspaceSouls: async (tab) => {
      c.stageOp += 1; stageHost.innerHTML = `<div role="tablist"><button id="workspace-tab-${tab}" role="tab">tab</button></div>`; c.stage = { name: "spawn" };
    },
    showStageFocused: async (name) => went.push(name) };
  const handoff = shell.match(/async function openWorkspaceTabFocused\(tab, options\) \{[^]*?\n\}/)[0];
  const esc = shell.match(/stageHost\.addEventListener\("keydown", \(e\) => \{[^]*?\n\}\);/)[0];
  const { runInNewContext } = await import("node:vm");
  const run = runInNewContext(`${handoff}\n${esc}\n({ openWorkspaceTabFocused })`, Object.assign(c, { Element: dom.window.Element }));
  document.getElementById("from").focus();
  await run.openWorkspaceTabFocused.call(c, "souls");
  assert.equal(document.activeElement.id, "workspace-tab-souls", "the page's tab control, not <body>");
  document.activeElement.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.deepEqual(went, ["home"], "the first Esc goes back to Home");
  dom.window.close();
});

// Review round 2 (slice 2): a souls catalog still reading is no count of zero, and a row is known by its identity.
test("slice2 Souls waits for the catalog: pending is Counting…, a refusal is a failure, never 0 souls", async (t) => {
  let answer = { agents: [], refreshing: true, catalog: { reason: null } }, reads = 0;
  const u = fixture(t, { rows: [row("a")], api: async () => { reads++; return answer; } });
  await u.settle(); await u.settle();
  assert.match(u.openButton("souls").textContent, /Counting…/, "the catalog still reading: not 0 souls");
  answer = { agents: [{}, {}, {}], catalog: { reason: null } };
  u.set({ rows: [row("a")] }); await u.settle();
  assert.equal(reads, 1, "a roster paint is no read clock (an unchanged roster read paints nothing)");
  assert.equal(u.timers.size, 1, "Home's own retry is scheduled");
  u.tick(); // its retry asks again
  await u.settle(); await u.settle();
  assert.equal(u.openButton("souls").getAttribute("aria-label"), "Souls, 3");
  assert.equal(reads, 2);
  assert.equal(u.timers.size, 0, "a settled count schedules nothing more");
  const v = fixture(t, { rows: [row("a")], api: async () => ({ agents: [], catalog: { reason: { code: "E_UNREACHABLE", message: "Cannot read souls" } } }) });
  await v.settle(); await v.settle();
  assert.match(v.openButton("souls").textContent, /Couldn't count/, "a refused catalog is a failure");
  const w = fixture(t, { rows: [row("a")], api: async () => ({ agents: [], catalog: { reason: null } }) });
  await w.settle(); await w.settle();
  assert.equal(w.openButton("souls").getAttribute("aria-label"), "Souls, 0", "a settled empty catalog is zero");
});

test("slice2 a repaint keeps focus and activation on the same agent when names repeat across roots and hosts", async (t) => {
  // Each waits on you, so Home lists it (slice 2b: Home lists no running rows).
  const rows = [row("same", { home: "/one/a", createdAt: "2026-11-02T00:00:00.000Z", waitingOnYou: claim() }), row("same", { home: "/two/a", createdAt: "2026-11-01T00:00:00.000Z", waitingOnYou: claim() }),
    row("same", { home: "/one/a", server: "build-host", createdAt: "2026-11-03T00:00:00.000Z", waitingOnYou: claim() })];
  const opened = [];
  const u = fixture(t, { rows });
  u.ctx.openAgent = (r) => { opened.push(`${r.server ?? ""}${r.home}`); return true; };
  const buttons = () => [...u.el.querySelectorAll("[data-home-agent]")];
  const second = buttons().find((b) => b.dataset.homeAgent === "/two/a");
  second.focus();
  u.set({ rows: [...rows].reverse() }); // a repaint, in another order
  assert.equal(u.doc.activeElement.dataset.homeAgent, "/two/a", "the same agent keeps the focus");
  u.doc.activeElement.click();
  assert.deepEqual(opened, ["/two/a"]);
  u.openButton("agents").click();
  const remote = buttons().find((b) => b.dataset.homeAgent.startsWith("server:build-host"));
  remote.focus(); u.set({ rows: [...rows] });
  assert.ok(u.doc.activeElement.dataset.homeAgent.startsWith("server:build-host"), "in Home › Agents too, across hosts");
});

// Review round 3 (slice 2): an unobserved deployment is no empty workspace, and a catalog still reading never becomes 0.
test("slice2 an unavailable deployment is a failed read on Home, never the first run or 0 agents", (t) => {
  const u = fixture(t, { rows: [], phase: "unavailable" });
  u.set({ note: "OATS answered with an error (E_WORKSPACE_SCHEMA). It says: invalid workspace file" });
  assert.equal(u.el.querySelector('[data-home-section="first-run"]'), null, "no first run");
  assert.match(u.el.textContent, /Couldn't read your agents\./);
  assert.match(u.el.textContent, /E_WORKSPACE_SCHEMA\). It says: invalid workspace file/, "the sidebar's own words for why");
  assert.ok([...u.el.querySelectorAll("button")].some((b) => b.textContent === "Retry"));
  assert.match(u.openButton("agents").textContent, /Couldn't count/, "never 0 agents");
  assert.match(u.openButton("machines").textContent, /Couldn't count/);
  // The shell says unavailable whenever it holds a deployment note (the kernel could not observe it).
  assert.match(shell, /const phase = contextDeploymentNote !== null \? "unavailable"/);
});

test("slice2 a catalog that keeps reading stays Counting…, however many retries ask again", async (t) => {
  let reads = 0;
  const u = fixture(t, { rows: [row("a")], api: async () => { reads++; return { agents: [], refreshing: true, catalog: { reason: null } }; } });
  await u.settle(); await u.settle();
  for (let i = 0; i < 12; i++) { u.tick(); await u.settle(); await u.settle(); }
  assert.match(u.openButton("souls").textContent, /Counting…/, "still reading is never 0 souls");
  assert.equal(reads, 13, "asked again on each retry while pending, one read at a time");
  const before = [...u.timers.keys()];
  u.switchWorkspace(); await u.settle(); await u.settle();
  assert.ok(before.length && before.every((id) => !u.timers.has(id)), "a switch drops the old workspace's retry (the new one asks for itself)");
  u.home.dispose();
  assert.equal(u.timers.size, 0, "disposal clears every retry");
  // A remote view's answer has no catalog of its own: its list is the count, zero included.
  const v = fixture(t, { rows: [row("a")], api: async () => ({ workspace: { id: "remote:x", server: "build-host" }, agents: [], refreshing: false }) });
  await v.settle(); await v.settle();
  assert.equal(v.openButton("souls").getAttribute("aria-label"), "Souls, 0");
});
