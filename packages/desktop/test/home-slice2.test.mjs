// The Desktop UI rework, slice 2: Home. The spec's pinned acceptance tests, by name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { NAV, PINNED, pinnedRowFor } from "../renderer/shell-nav.mjs";
import { createHome, mount, OVERVIEW, overviewLine, firstRunCopy } from "../renderer/views/home.mjs";
import { homeBoard, homeAgents, startedBy } from "../../client/home-board.mjs";
import { rosterGroups } from "../../client/instance-tree.mjs";

const shell = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
const claim = (message = "Pick the copy", since = "2026-11-19T10:00:00.000Z") => ({ since, producer: "agent", reason: "attention", message });
const row = (instance, extra = {}) => ({ instance, agent: "oats-expert", running: true, runtimeState: "running", createdAt: "2026-11-01T00:00:00.000Z", ...extra });

function fixture(t, { rows = [], phase = "ready", deployments = [], api = async () => ({ agents: [1, 2, 3] }), post = async () => ({ status: "ok", capabilities: { capabilities: [1, 2] } }) } = {}) {
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
  const home = createHome(el, ctx, { doc });
  t.after(() => { home.dispose(); dom.window.close(); });
  const buttons = () => [...el.querySelectorAll("button")];
  return {
    doc, el, home, opened, tabs, ctx,
    set(next) { state = { ...state, ...next }; for (const fn of listeners) fn(); },
    groups: () => [...el.querySelectorAll(".home-group")].map((g) => [g.querySelector("h3").textContent, [...g.querySelectorAll("[data-home-agent]")].map((b) => b.dataset.homeAgent)]),
    agentButton: (name) => buttons().find((b) => b.dataset.homeAgent === name),
    openButton: (key) => buttons().find((b) => b.dataset.homeOpen === key),
    key: (target, key) => target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })),
    settle: () => new Promise((r) => setTimeout(r, 0)),
  };
}

test("slice2 home is the landing surface", () => {
  // Home is the first pinned row, then Automations; the Workspace page stays a destination without a row of its own,
  // its row being Home's while it shows.
  assert.deepEqual(PINNED.map((v) => v.name), ["home", "automations"]);
  assert.equal(NAV[0].name, "home"); assert.equal(NAV[0].label, "Home");
  assert.ok(NAV.some((v) => v.name === "spawn" && v.pinned === false), "the Workspace page keeps its stage, its key and its palette command");
  assert.equal(pinnedRowFor("spawn"), "home"); assert.equal(pinnedRowFor("automations"), "automations");
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
  // Needs you (newest claim first, with its message), then Running (newest first). Stopped and unknown aren't listed.
  assert.deepEqual(u.groups(), [["Needs you", ["waits-new", "waits-old"]], ["Running", ["runs-new", "runs-old"]]]);
  assert.match(u.agentButton("waits-new").textContent, /Newer question/);
  assert.match(u.agentButton("runs-new").textContent, /oats-expert · falcon/, "soul · machine, as the roster says it");
  assert.match(u.agentButton("runs-new").textContent, /running/, "running, never working or idle: there is no such fact");
  assert.ok(!u.groups().some(([title]) => title === "New"), "no New group: no stopped-since-you-looked fact exists");
  // Empty groups are hidden.
  u.set({ rows: [row("only-runs")] });
  assert.deepEqual(u.groups(), [["Running", ["only-runs"]]]);
  u.set({ rows: [row("only-waits", { waitingOnYou: claim() })] });
  assert.deepEqual(u.groups(), [["Needs you", ["only-waits"]]]);
  u.set({ rows: [row("idle-stopped", { running: false, runtimeState: "stopped" })] });
  assert.deepEqual(u.groups(), []);
  assert.match(u.el.textContent, /Nothing needs you, and no agent is running\./);
  // A stale roster's claim is unknown: the row isn't counted as needing you.
  u.set({ rows: [row("stale-wait", { waitingOnYou: claim() })], stale: () => true });
  assert.deepEqual(u.groups(), [["Running", ["stale-wait"]]]);
  // Enter (a click) opens the row as the roster does.
  u.set({ rows: [row("open-me")], stale: () => false });
  u.agentButton("open-me").click();
  assert.deepEqual(u.opened, ["open-me"]);
  // Distinct loading and failed states.
  u.set({ rows: [], phase: "loading" });
  assert.match(u.el.querySelector('[role="status"]').textContent, /Reading your agents…/);
  u.set({ phase: "failed" });
  assert.match(u.el.textContent, /Couldn't read your agents\./);
  [...u.el.querySelectorAll("button")].find((b) => b.textContent === "Retry").click();
  assert.equal(u.ctx.homeRoster().retried, true);
});

test("slice2 overview counts and enter opens section, esc returns", async (t) => {
  const u = fixture(t, { rows: [row("a"), row("b", { running: false })], deployments: [{ id: "/w", machine: "falcon" }, { id: "ssh://polaris/w", machine: "polaris" }] });
  assert.deepEqual([...u.el.querySelectorAll("[data-home-open]")].map((b) => b.dataset.homeOpen), OVERVIEW.map((o) => o.key));
  assert.deepEqual(OVERVIEW.map((o) => o.label), ["Agents", "Souls", "Capabilities", "Teams", "Machines", "Graph"]);
  assert.match(u.openButton("souls").textContent, /Counting…/, "a count being read says so");
  await u.settle(); await u.settle();
  assert.match(u.openButton("agents").textContent, /You have 2 agents/);
  assert.match(u.openButton("souls").textContent, /You have 3 souls/);
  assert.match(u.openButton("capabilities").textContent, /You have 2 capabilities/);
  assert.match(u.openButton("machines").textContent, /You have 2 machines/);
  assert.match(u.openButton("graph").textContent, /2 agents on 2 machines/);
  assert.equal(overviewLine("souls", { souls: 1 }), "You have 1 soul");
  assert.equal(overviewLine("souls", { souls: "failed" }), "Couldn't count them");
  // Enter on a section opens the Workspace page on its tab; Machines opens the Machines tab's List, the Graph its
  // Map (today's canvas, until slice 6).
  u.openButton("souls").click(); u.openButton("teams").click(); u.openButton("machines").click(); u.openButton("graph").click();
  assert.deepEqual(u.tabs, ["souls", "teams", ["machines", "list"], ["machines", "map"]]);
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
  assert.match(v.openButton("souls").textContent, /Couldn't count them/);
});

test("slice2 home agents flat list", async (t) => {
  const rows = [
    row("child", { parentInstance: "lead-one", createdAt: "2026-11-03T00:00:00.000Z", running: false, runtimeState: "stopped" }),
    row("lead-one", { attributedHuman: "Joan", createdAt: "2026-11-02T00:00:00.000Z", waitingOnYou: claim() }),
    row("lone", { createdAt: "2026-11-04T00:00:00.000Z", running: null, runtimeState: null }),
  ];
  const u = fixture(t, { rows });
  u.openButton("agents").click();
  const listed = [...u.el.querySelectorAll("[data-home-agent]")];
  assert.deepEqual(listed.map((b) => b.dataset.homeAgent), ["lone", "child", "lead-one"], "every agent, running or stopped, newest first");
  assert.match(listed[1].textContent, /Child.*oats-expert · falcon.*stopped · started by Lead one/s);
  assert.match(listed[2].textContent, /running · started by Joan/);
  assert.match(listed[0].textContent, /status unknown/);
  assert.equal(u.doc.activeElement.textContent, "Back to Home");
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
  assert.deepEqual([...first.querySelectorAll("li")].map((li) => li.textContent), ["New agent: Ctrl+N", "Command palette: Ctrl+K", "Home: View: Home in the palette"]);
  assert.ok(u.el.querySelector('[data-home-section="overview"]'), "then the overview");
  assert.equal(u.el.querySelector('[data-home-section="board"]'), null);
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
