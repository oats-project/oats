// The Desktop UI rework, slice 6b: the Graph (views/graph.mjs over packages/client/instance-graph.mjs). The spec's
// pinned acceptance tests, by name, then the rest of its "done when".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createGraph, mount, GRAPH_COPY, nodeLabel, layoutGraph, edgePath, soulHandoff, GRAPH_GEOMETRY } from "../renderer/views/graph.mjs";
import { runInNewContext } from "node:vm";
import { NAV, NAV_TABS, pinnedRowFor } from "../renderer/shell-nav.mjs";
import { OVERVIEW } from "../renderer/views/home.mjs";
import { instanceGraph } from "../../client/instance-graph.mjs";
import { DESKTOP_TERMS } from "../renderer/desktop-terms.mjs";
import { registerAction } from "../renderer/keybindings.mjs";
import { instanceId } from "../../client/instance-tree.mjs";
import { requestDeploymentTab } from "../renderer/deployment-tabs.mjs";
import { currentWorkspace, setWorkspace } from "../renderer/views/common.mjs";
import { cli as eventsCli, target as eventsTarget, data as eventsFixture, birth, deferred } from "./helpers/instance-events-fixture.mjs";
import { eventsData } from "../renderer/instance-events-data.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const DEPLOYMENTS = [
  { id: "/w", machine: "", path: "/w", local: true, primary: true, reachable: true },
  { id: "polaris:/w", machine: "polaris", path: "/w", local: false, reachable: true },
];
const row = (instance, extra = {}) => {
  const server = extra.server ?? null;
  return { instance, agent: "oats-developer", soulKey: "oats-developer", soul: { repoKey: "github.com/acme/agents" },
    home: `/h/${server ?? "here"}/${instance}`, agentsRoot: "/r", running: true, runtimeState: "running",
    createdAt: "2026-11-01T00:00:00.000Z", deployment: { id: server ? `${server}:/w` : "/w" }, ...(server ? { server, remote: true } : {}), ...extra };
};

function fixture(t, { rows = [], phase = "ready", deployments = DEPLOYMENTS, note = null, api = async () => ({}), events = {} } = {}) {
  const dom = new JSDOM("<!doctype html><body><main></main></body>", { pretendToBeVisual: true });
  const doc = dom.window.document, el = doc.querySelector("main");
  const listeners = new Set(), opened = [], details = [], souls = [], registered = [];
  let state = { rows, phase, deployments, note, stale: () => false, here: "falcon", retry: () => { state.retried = true; } };
  const ctx = {
    api,
    homeRoster: () => state,
    subscribeHomeRoster: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    openAgent: (r) => { opened.push(r.instance); return true; },
    openAgentDetails: (r) => { details.push(r.instance); return true; },
    openSoulOf: (ref) => { souls.push(ref); },
  };
  const ws = { gen: 1, listeners: new Set() };
  const graph = createGraph(el, ctx, { doc, generation: () => ws.gen, subscribeWorkspace: (fn) => { ws.listeners.add(fn); return () => ws.listeners.delete(fn); },
    register: (a) => { registered.push(a); return registerAction(a); }, events });
  t.after(() => { graph.dispose(); dom.window.close(); });
  const nodes = () => [...el.querySelectorAll("[data-graph-node]")];
  const nodeOf = (name) => nodes().find((n) => n.getAttribute("aria-label").startsWith(`${name},`));
  return {
    switchWorkspace() { ws.gen++; for (const fn of ws.listeners) fn(); },
    retried: () => state.retried === true,
    dom, doc, el, graph, opened, details, souls, registered, nodes, nodeOf,
    set(next) { state = { ...state, ...next }; for (const fn of listeners) fn(); },
    columns: () => [...el.querySelectorAll(".graph-col-group")].map((g) => ({
      label: g.getAttribute("aria-label"), agents: [...g.querySelectorAll("[data-graph-node]")].map((n) => n.getAttribute("aria-label").split(",")[0]) })),
    key: (target, key, init = {}) => target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })),
    focused: () => doc.activeElement?.getAttribute?.("aria-label")?.split(",")[0] ?? null,
    edges: () => [...el.querySelectorAll(".graph-edges path")],
  };
}

test("slice6b graph columns per machine", (t) => {
  const u = fixture(t, { rows: [row("lead"), row("dev", { parentInstance: "lead" }), row("builder", { server: "polaris" }), row("tester", { server: "polaris" })] });
  const columns = u.columns();
  assert.equal(columns.length, 2, "one column per machine");
  // This computer first, by its own name, then the registered machines by name.
  assert.match(columns[0].label, /^falcon, this computer · 2 agents/);
  assert.deepEqual(columns[0].agents.sort(), ["dev", "lead"]);
  assert.match(columns[1].label, /^polaris, 2 agents/);
  assert.deepEqual(columns[1].agents.sort(), ["builder", "tester"]);
  // Machines by name after this computer, whatever the served order.
  const order = instanceGraph([row("a", { server: "zeta" }), row("b", { server: "alpha" }), row("c")],
    [{ id: "zeta:/w", machine: "zeta", local: false }, { id: "/w", machine: "", local: true, primary: true }, { id: "alpha:/w", machine: "alpha", local: false }], DESKTOP_TERMS, { here: "falcon" });
  assert.deepEqual(order.columns.map((c) => c.label), ["falcon", "alpha", "zeta"]);
  // Each node: the roster's dot, its name and its soul.
  const lead = u.nodeOf("lead");
  assert.ok(lead.querySelector(".ctx-dot.on"), "a running agent's dot is the roster's");
  assert.equal(lead.querySelector(".graph-node-name").textContent, "Lead");
  assert.match(lead.querySelector(".graph-node-sub").textContent, /^oats-developer/);
});

test("slice6b started-by edges and you root", (t) => {
  const u = fixture(t, { rows: [
    row("lead", { attributedHuman: "Joan" }),
    row("dev", { parentInstance: "lead", sameWork: true, sameWorkKnown: true }),
    row("reviewer", { parentInstance: "dev" }),
    row("loner"),
  ] });
  // parent → child, solid.
  const started = u.edges().filter((p) => p.dataset.kind === "started");
  assert.deepEqual(started.map((p) => [p.dataset.from, p.dataset.to]), [["/h/here/lead", "/h/here/dev"], ["/h/here/dev", "/h/here/reviewer"]]);
  for (const p of started) assert.ok(!p.classList.contains("cross"), "started-by edges are solid");
  // The same-work child is marked in words, on its node and in its name.
  const dev = u.nodeOf("dev");
  assert.match(dev.querySelector(".graph-node-sub").textContent, /same work/);
  assert.match(dev.getAttribute("aria-label"), /, same work,/);
  assert.doesNotMatch(u.nodeOf("reviewer").getAttribute("aria-label"), /same work/, "only the flagged child");
  // "You" above the agents with an attributed human and no parent; not above a child, nor a root nobody started.
  const you = u.el.querySelectorAll("[data-graph-you]");
  assert.equal(you.length, 1); assert.equal(you[0].textContent, GRAPH_COPY.you);
  assert.deepEqual(u.edges().filter((p) => p.dataset.kind === "you").map((p) => p.dataset.to), ["/h/here/lead"]);
  assert.match(u.nodeOf("lead").getAttribute("aria-label"), /started by you/);
  assert.equal(u.nodeOf("lead").getAttribute("aria-level"), "2", "under You");
  assert.doesNotMatch(u.nodeOf("loner").getAttribute("aria-label"), /started by/);
  // The accessible name: "<name>, <soul>, on <machine>, started by <parent or you>, <state>".
  assert.equal(u.nodeOf("reviewer").getAttribute("aria-label"), "reviewer, oats-developer, on falcon, started by dev, running");
  // A child of a parent with an attributed human isn't under You itself.
  const model = instanceGraph([row("lead", { attributedHuman: "Joan" }), row("kid", { parentInstance: "lead", attributedHuman: "Joan" })], DEPLOYMENTS, DESKTOP_TERMS);
  assert.deepEqual(model.columns[0].rows.map((r) => [r.kind, r.depth, r.row?.instance ?? null]), [["you", 0, null], ["agent", 1, "lead"], ["agent", 2, "kid"]]);
});

test("slice6b keyboard moves and opens", (t) => {
  const u = fixture(t, { rows: [
    row("lead", { createdAt: "2026-11-03T00:00:00.000Z" }), row("dev", { parentInstance: "lead" }),
    row("builder", { server: "polaris", createdAt: "2026-11-05T00:00:00.000Z" }), row("tester", { server: "polaris" }),
  ] });
  // One tab stop (a roving tabindex), each node a treeitem with a visible focus rule.
  assert.equal(u.nodes().filter((n) => n.tabIndex === 0).length, 1);
  assert.ok(u.nodes().every((n) => n.getAttribute("role") === "treeitem"));
  assert.match(read("../renderer/views/graph.mjs"), /\.graph-node:focus-visible \{ border-color:var\(--accent\); background:var\(--sel\);/);
  u.nodeOf("lead").focus();
  u.key(u.doc.activeElement, "ArrowDown"); assert.equal(u.focused(), "dev", "↓ the next agent of the column");
  u.key(u.doc.activeElement, "ArrowUp"); assert.equal(u.focused(), "lead", "↑ back");
  u.key(u.doc.activeElement, "ArrowRight"); assert.equal(u.focused(), "builder", "→ the next machine, at the same row");
  u.key(u.doc.activeElement, "ArrowDown"); assert.equal(u.focused(), "tester");
  u.key(u.doc.activeElement, "ArrowRight"); assert.equal(u.focused(), "tester", "the last machine stays");
  u.key(u.doc.activeElement, "ArrowLeft"); assert.equal(u.focused(), "dev", "← the nearest agent of the machine before");
  assert.equal(u.doc.activeElement.tabIndex, 0, "the tab stop follows the focus");
  u.key(u.doc.activeElement, "Enter");
  assert.deepEqual(u.opened, ["dev"], "Enter opens the focused agent, as the roster's Enter does");
  // The node's menu replaces the old popup: Open terminal, Details, Open soul, and its recent events.
  u.doc.activeElement.dispatchEvent(new u.dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const menu = u.el.querySelector('[role="menu"]');
  assert.ok(menu, "the context menu opens");
  assert.deepEqual([...menu.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent), ["Open terminal", "Details", "Open soul", "Recent events…"]);
  menu.querySelector('[data-action="details"]').click();
  assert.deepEqual(u.details, ["dev"]); assert.equal(u.focused(), "dev", "the menu closes back on its node");
  u.doc.activeElement.dispatchEvent(new u.dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  u.el.querySelector('[role="menu"] [data-action="soul"]').click();
  assert.deepEqual(u.souls, [{ name: "oats-developer", key: "oats-developer", repoKey: "github.com/acme/agents", agentsRoot: "/r" }],
    "the exact soul it was spawned from: its key and its source");
  u.doc.activeElement.dispatchEvent(new u.dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  u.key(u.el.querySelector('[role="menu"]'), "Escape");
  assert.equal(u.el.querySelector('[role="menu"]'), null); assert.equal(u.focused(), "dev");
  // A repaint (a roster poll) keeps the focus on the same agent.
  u.set({ rows: [...u.graph.graph.columns.flatMap((c) => c.rows.filter((r) => r.kind === "agent").map((r) => r.row)), row("newcomer")] });
  assert.equal(u.focused(), "dev");
});

test("slice6b m toggles one field", (t) => {
  const u = fixture(t, { rows: [row("lead"), row("dev", { parentInstance: "lead" }), row("builder", { server: "polaris" })] });
  assert.equal(u.columns().length, 2);
  u.nodeOf("lead").focus();
  u.key(u.doc.activeElement, "m");
  assert.equal(u.graph.mode, "field");
  const field = u.columns();
  assert.equal(field.length, 1, "one field");
  assert.deepEqual(field[0].agents.sort(), ["builder", "dev", "lead"], "every agent in it");
  assert.match(u.nodeOf("builder").querySelector(".graph-node-sub").textContent, /polaris/, "machines as labels on the nodes");
  assert.equal(u.focused(), "lead", "the focus stays on its agent");
  u.key(u.doc.activeElement, "m");
  assert.equal(u.graph.mode, "columns"); assert.equal(u.columns().length, 2);
  // m and the zoom keys are rebindable actions of the Graph's own view context.
  assert.deepEqual(u.registered.map((a) => [a.id, a.defaultChord, a.context]), [
    ["graph.toggleField", "M", "view:graph"], ["graph.zoomIn", "=", "view:graph"], ["graph.zoomInPlus", "Shift+=", "view:graph"],
    ["graph.zoomOut", "-", "view:graph"], ["graph.fit", "0", "view:graph"]]);
});

test("slice6b cross-machine edge dotted", (t) => {
  const u = fixture(t, { rows: [row("lead"), row("builder", { server: "polaris", parentInstance: "lead" })] });
  const cross = u.edges().filter((p) => p.dataset.kind === "cross");
  assert.equal(cross.length, 1);
  assert.equal(cross[0].dataset.from, "/h/here/lead"); assert.equal(cross[0].dataset.to, instanceId(row("builder", { server: "polaris" })));
  assert.ok(cross[0].classList.contains("cross"));
  assert.match(read("../renderer/views/graph.mjs"), /\.graph-edges path\.cross \{ stroke-dasharray:/, "drawn dotted");
  // Between the columns: from the parent's side, along the gap between them, into the child's side.
  assert.match(cross[0].getAttribute("d"), /^M [\d.]+ [\d.]+ H [\d.]+ V [\d.]+ H [\d.]+$/);
  // Not by the line's style alone: the node says where its parent runs.
  const builder = u.nodeOf("builder");
  assert.match(builder.querySelector(".graph-node-sub").textContent, /started by lead on falcon/);
  assert.match(builder.getAttribute("aria-label"), /started by lead on falcon/);
  // A name two other machines' rows share is no edge: the row is a root that still says who it records.
  const twice = instanceGraph([row("lead"), row("lead", { server: "zeta" }), row("builder", { server: "polaris", parentInstance: "lead" })],
    [...DEPLOYMENTS, { id: "zeta:/w", machine: "zeta", local: false }], DESKTOP_TERMS);
  assert.equal(twice.edges.filter((e) => e.kind === "cross").length, 0);
  assert.equal(twice.columns.find((c) => c.key === "polaris:/w").rows[0].recordedParent, "lead");
});

test("slice6b machines toggle gone", async (t) => {
  // Machines is the list: no List | Map, no canvas mounted in it.
  const discovery = read("../renderer/workspace-discovery.mjs"), spawn = read("../renderer/views/spawn.mjs");
  for (const source of [discovery, spawn]) {
    assert.doesNotMatch(source, /machinesView|MACHINES_VIEWS|data-machines-view|workspace-machines-panel/);
    assert.doesNotMatch(source, /views\/hierarchy\.mjs|\.\/hierarchy\.mjs/);
  }
  // The Graph is a page of its own: Home › Graph opens it, and so does the palette's "Workspace: Graph".
  const graph = NAV.find((v) => v.name === "graph");
  assert.ok(graph && graph.pinned === false); assert.equal(graph.command, "Workspace: Graph");
  assert.equal(pinnedRowFor("graph"), "home");
  assert.deepEqual(NAV_TABS.map((v) => [v.name, v.tab]), [["hierarchy", "machines"]], "⌘1 still opens Machines, the list");
  assert.deepEqual(OVERVIEW.find((e) => e.key === "graph"), { key: "graph", label: "Graph", opens: "graph", stage: true });
  assert.deepEqual(OVERVIEW.find((e) => e.key === "machines"), { key: "machines", label: "Machines", opens: "machines" });
  const shell = read("../renderer/shell.mjs");
  assert.match(shell, /label: v\.command \?\? `View: \$\{v\.label\}`/, "the palette and the shortcuts editor name it by its command");
  assert.match(shell, /openStage: \(name\) => showStageFocused\(name\)/);
  // Home's Graph row opens the stage.
  const { createHome } = await import("../renderer/views/home.mjs");
  const dom = new JSDOM("<!doctype html><body><main></main></body>"), doc = dom.window.document, stages = [], tabs = [];
  const home = createHome(doc.querySelector("main"), { api: async () => ({ agents: [] }), homeRoster: () => ({ rows: [row("a")], deployments: [], phase: "ready", stale: () => false }),
    openStage: (name) => stages.push(name), openWorkspaceTab: (tab) => tabs.push(tab) }, { doc, cli: () => ({ features: [] }), subscribeCli: () => () => {}, subscribeWorkspace: () => () => {}, generation: () => 1 });
  t.after(() => { home.dispose(); dom.window.close(); });
  [...doc.querySelectorAll("button")].find((b) => b.dataset.homeOpen === "graph").click();
  [...doc.querySelectorAll("button")].find((b) => b.dataset.homeOpen === "machines").click();
  assert.deepEqual(stages, ["graph"]); assert.deepEqual(tabs, ["machines"]);
});

test("slice6b states: loading, failed, unavailable, empty", (t) => {
  const u = fixture(t, { phase: "loading" });
  const line = () => u.el.querySelector(".graph-state");
  assert.equal(line().hidden, false); assert.equal(line().textContent, GRAPH_COPY.reading);
  assert.equal(line().getAttribute("role"), "status"); assert.equal(u.el.querySelector(".graph").getAttribute("aria-busy"), "true");
  assert.equal(u.el.querySelector(".graph-canvas").hidden, true);
  u.set({ phase: "failed" });
  assert.match(line().textContent, /Couldn't read your agents\./);
  line().querySelector(".graph-retry").click();
  assert.equal(u.retried(), true, "Retry reads the roster again");
  u.set({ phase: "unavailable", note: "OATS can't read this workspace yet." });
  assert.match(line().textContent, /OATS can't read this workspace yet\./);
  u.set({ phase: "ready", rows: [] });
  assert.equal(line().textContent, GRAPH_COPY.empty); assert.equal(u.el.querySelector(".graph").hasAttribute("aria-busy"), false);
  u.set({ rows: [row("a")] });
  assert.equal(line().hidden, true); assert.equal(u.el.querySelector(".graph-canvas").hidden, false);
  // A machine with no agents says so in its column; one not reached says why above the canvas.
  u.set({ deployments: [DEPLOYMENTS[0], { ...DEPLOYMENTS[1], reachable: false, reason: "ssh: connect to host polaris: timed out" }] });
  assert.ok([...u.el.querySelectorAll(".graph-col-empty")].some((e) => e.textContent === GRAPH_COPY.emptyColumn));
  assert.match(u.columns()[1].label, /not reached/);
  assert.equal(u.el.querySelector(".graph-notes").hidden, false);
  assert.match(u.el.querySelector(".graph-notes").textContent, /timed out/);
});

test("slice6b layout: no crossings inside a column at 50+ agents", () => {
  // Every edge inside a column runs down its parent's guide and across to its child, and a child sits below its
  // parent: an outline tree, so no two of its edges cross.
  const rows = [row("root")];
  for (let i = 0; i < 60; i++) rows.push(row(`a${i}`, { parentInstance: i < 6 ? "root" : `a${i % 6}`, createdAt: `2026-11-01T00:${String(i).padStart(2, "0")}:00.000Z` }));
  const graph = instanceGraph(rows, DEPLOYMENTS, DESKTOP_TERMS), place = layoutGraph(graph);
  assert.equal(graph.columns[0].rows.length, 61);
  const index = new Map(graph.columns[0].rows.map((r, i) => [r.id, i]));
  for (const e of graph.edges) {
    assert.ok(index.get(e.to) > index.get(e.from), "a child below its parent");
    // The subtree of `from` is contiguous below it: every row between them is a descendant of `from`.
    const between = graph.columns[0].rows.slice(index.get(e.from) + 1, index.get(e.to));
    const depth = graph.columns[0].rows[index.get(e.from)].depth;
    assert.ok(between.every((r) => r.depth > depth), "no edge passes another branch");
    assert.match(edgePath(e, place, graph.mode), /^M [\d.]+ [\d.]+ V [\d.]+ H [\d.]+$/);
  }
});

test("slice6b the node's name and the roster's dot grammar", (t) => {
  const waiting = { since: "2026-11-19T10:00:00.000Z", producer: "agent", reason: "question", message: "Which copy?" };
  const u = fixture(t, { rows: [row("asks", { waitingOnYou: waiting }), row("off", { running: false, runtimeState: "stopped" }), row("dunno", { running: null, runtimeState: null })] });
  assert.ok(u.nodeOf("asks").querySelector(".ctx-dot.waiting .attn-mark"), "needs input: the roster's mark");
  assert.match(u.nodeOf("asks").getAttribute("aria-label"), /, needs you$/);
  assert.ok(u.nodeOf("off").querySelector(".ctx-dot.off")); assert.match(u.nodeOf("off").getAttribute("aria-label"), /, stopped$/);
  assert.ok(u.nodeOf("dunno").querySelector(".ctx-dot.unknown")); assert.match(u.nodeOf("dunno").getAttribute("aria-label"), /, status unknown$/);
  const labels = new Map([["/w", "falcon"]]);
  assert.equal(nodeLabel({ row: row("x"), machine: "falcon", byYou: false, parent: null, recordedParent: "gone", sameWork: false }, { rowsById: new Map(), labels }),
    "x, oats-developer, on falcon, started by gone, running");
});

test("slice6b mount contract", () => {
  const dom = new JSDOM("<!doctype html><body><main></main></body>"), el = dom.window.document.querySelector("main");
  const dispose = mount(el, { homeRoster: () => ({ rows: [], deployments: [], phase: "loading", stale: () => false }) });
  assert.equal(typeof dispose, "function"); dispose(); dom.window.close();
});

test("slice6b a deployment request focuses its column; a workspace switch closes the menu and the events dialog", (t) => {
  const was = currentWorkspace(); setWorkspace("ws"); t.after(() => setWorkspace(was));
  const u = fixture(t, { rows: [row("lead"), row("builder", { server: "polaris" })] });
  requestDeploymentTab("ws", "polaris:/w", null);
  assert.equal(u.focused(), "builder", "the switcher's Not matched entry lands on that machine's column");
  u.nodeOf("lead").focus();
  u.doc.activeElement.dispatchEvent(new u.dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  u.el.querySelector('[role="menu"] [data-action="events"]').click();
  const dialog = u.el.querySelector('[role="dialog"]');
  assert.ok(dialog, "Recent events opens by its node"); assert.match(dialog.getAttribute("aria-label"), /Recent events of lead/);
  assert.ok(dialog.querySelector(".events-view"), "the events view, as the popup had it");
  u.key(dialog, "Escape");
  assert.equal(u.el.querySelector('[role="dialog"]'), null); assert.equal(u.focused(), "lead", "Esc closes it back on its node");
  u.doc.activeElement.dispatchEvent(new u.dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  u.el.querySelector('[role="menu"] [data-action="events"]').click();
  assert.ok(u.el.querySelector('[role="dialog"]'));
  u.switchWorkspace();
  assert.equal(u.el.querySelector('[role="dialog"]'), null, "the events dialog belonged to the workspace left");
  u.nodeOf("lead").focus();
  u.doc.activeElement.dispatchEvent(new u.dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  assert.ok(u.el.querySelector('[role="menu"]'));
  u.switchWorkspace();
  assert.equal(u.el.querySelector('[role="menu"]'), null, "and so did the menu");
});

test("slice6b hostile names stay text", (t) => {
  const hostile = `x'"><img src=x onerror=bad()>`;
  const u = fixture(t, { rows: [row(hostile, { agent: hostile }), row("kid", { parentInstance: hostile })] });
  assert.equal(u.el.querySelector("img,script,iframe"), null);
  assert.ok(u.nodes().every((n) => !n.id.includes("<")), "no identity becomes an id");
  assert.match(u.nodeOf("kid").getAttribute("aria-label"), /started by x'"><img/);
});

test("slice6b Open soul hands the exact soul, and says why it can't", (t) => {
  // A local row: its recorded soul key and source; a remote row: its agent dir, root and server.
  assert.deepEqual(soulHandoff(row("a"), DEPLOYMENTS), { ref: { name: "oats-developer", key: "oats-developer", repoKey: "github.com/acme/agents", agentsRoot: "/r" } });
  const primaryRemote = [{ ...DEPLOYMENTS[1], primary: true }, { ...DEPLOYMENTS[0], primary: false }];
  assert.deepEqual(soulHandoff(row("b", { server: "polaris" }), primaryRemote), { ref: { name: "oats-developer", agentsRoot: "/r", server: "polaris" } });
  // Nothing recorded; another deployment than the one the Workspace page shows.
  assert.match(soulHandoff(row("c", { soulKey: undefined }), DEPLOYMENTS).reason, /doesn't record the soul it was spawned from/);
  assert.equal(soulHandoff(row("d", { server: "polaris" }), DEPLOYMENTS, new Map([["/w", "falcon"], ["polaris:/w", "polaris"]])).reason,
    "This agent is on polaris; the Workspace page shows only the souls of falcon.");
  // The menu shows the reason on a disabled Open soul.
  const u = fixture(t, { rows: [row("lead"), row("far", { server: "polaris" })] });
  u.nodeOf("far").focus();
  u.doc.activeElement.dispatchEvent(new u.dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const soul = u.el.querySelector('[role="menu"] [data-action="soul"]');
  assert.equal(soul.disabled, true); assert.equal(soul.querySelector("small").textContent, "This agent is on polaris; the Workspace page shows only the souls of falcon.");
  assert.equal(soul.title, soul.querySelector("small").textContent);
  // The shell's hand-off passes the key and the source to the Workspace page, and words a replaced soul's miss.
  const shell = read("../renderer/shell.mjs");
  const fn = shell.match(/async function openSoulPage\([^]*?\n\}/)[0].replace('import("./views/spawn.mjs")', "loadSpawn()");
  const handed = [], notes = [], stages = [];
  const run = runInNewContext(`(${fn})`, { tabOpenIntents: { begin: () => () => true }, currentWorkspace: () => "/w", workspaceGeneration: () => 1,
    ctx: { notify: (m) => notes.push(m) }, showStage: (n) => stages.push(n), loadSpawn: async () => ({ preselectSoul: (ref) => { handed.push(ref); ref.onMiss(0); } }) });
  return run({ workspace: "/w", name: "dev", agentsRoot: "/r", key: "old-key", repoKey: "old/repo" }).then(() => {
    assert.deepEqual(handed.map(({ onMiss: _m, ...ref }) => ref), [{ name: "dev", agentsRoot: "/r", server: undefined, key: "old-key", repoKey: "old/repo" }]);
    assert.match(notes[0], /The soul dev was spawned from \(old-key\) is not among this workspace's souls now\./);
    assert.deepEqual(stages, ["spawn"]);
  });
});

test("slice6b Details inspects the agent, stopped or held, and never starts it", async () => {
  const shell = read("../renderer/shell.mjs");
  const fn = shell.match(/function openRosterDetails\(i\) \{[^]*?\n\}/)[0].replace('import("./views/spawn.mjs")', "loadSpawn()");
  const stopped = row("off", { running: false, runtimeState: "stopped" }), held = row("busy", { spawnInProgress: true });
  let owned = true;
  const seen = [], stages = [], started = [];
  const c = { instanceId, shownRows: (rows) => rows, contextInstances: [stopped, held], tabOpenIntents: { begin: () => () => owned },
    currentWorkspace: () => "/w", ctx: { notify() {} }, showStage: (n) => stages.push(n), openInstanceStart: (r) => started.push(r.instance),
    loadSpawn: async () => ({ preselectHome: (r) => seen.push(r.instance) }) };
  const details = runInNewContext(`(${fn})`, c);
  assert.equal(details(stopped), true); await new Promise((r) => setTimeout(r, 0));
  assert.equal(details(held), true); await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(seen, ["off", "busy"]); assert.deepEqual(stages, ["spawn", "spawn"]); assert.deepEqual(started, [], "never the Start path");
  // A newer navigation before the module loads drops it; a row the roster doesn't have opens nothing.
  owned = false; assert.equal(details(stopped), true); await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(seen, ["off", "busy"]);
  assert.equal(details(row("gone")), false);
});

test("slice6b deep trees: no edge passes through a node, at any depth", () => {
  const rows = [row("c0")];
  for (let i = 1; i <= 9; i++) rows.push(row(`c${i}`, { parentInstance: `c${i - 1}` }));
  rows.push(row("kidA", { parentInstance: "c9", createdAt: "2026-11-02T00:00:00.000Z" }), row("kidB", { parentInstance: "c9" }), row("kidA1", { parentInstance: "kidA" }));
  const graph = instanceGraph(rows, DEPLOYMENTS, DESKTOP_TERMS), place = layoutGraph(graph);
  const boxes = [...place.at.entries()];
  for (const e of graph.edges) {
    const d = edgePath(e, place, graph.mode), [, x, y1, y2, x2] = d.match(/^M ([\d.]+) ([\d.]+) V ([\d.]+) H ([\d.]+)$/).map(Number);
    for (const [id, b] of boxes) {
      if (id === e.from || id === e.to) continue;
      const vertical = x > b.x && x < b.x + b.w && y2 > b.y && y1 < b.y + b.h;
      const horizontal = y2 > b.y && y2 < b.y + b.h && Math.max(x, x2) > b.x && Math.min(x, x2) < b.x + b.w;
      assert.ok(!vertical && !horizontal, `${e.from} → ${e.to} passes ${id}`);
    }
  }
  // Every node keeps its minimum width, the column widening to hold the deepest.
  for (const [, b] of boxes) if (b.h === GRAPH_GEOMETRY.NODE_H) assert.ok(b.w >= GRAPH_GEOMETRY.MIN_NODE_W);
});

test("slice6b two folders of one computer: two columns, a solid edge between them, never dotted", (t) => {
  const deps = [DEPLOYMENTS[0], { id: "/v", machine: "", path: "/v", local: true, reachable: true }];
  const u = fixture(t, { deployments: deps, rows: [row("lead"), row("kid", { deployment: { id: "/v" }, parentInstance: "lead" })] });
  const between = u.edges().filter((p) => p.dataset.to === "/h/here/kid");
  assert.deepEqual(between.map((p) => [p.dataset.kind, p.classList.contains("cross")]), [["column", false]]);
  assert.match(between[0].getAttribute("d"), / H [\d.]+ V [\d.]+ H /, "drawn between the columns");
  assert.match(u.nodeOf("kid").getAttribute("aria-label"), /started by lead on falcon · w/);
});

test("slice6b an open menu survives a roster change, on the item it was on", (t) => {
  const u = fixture(t, { rows: [row("a"), row("b")] });
  u.nodeOf("a").focus();
  u.doc.activeElement.dispatchEvent(new u.dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  u.key(u.doc.activeElement, "ArrowDown");
  assert.equal(u.doc.activeElement.dataset.action, "details");
  u.set({ rows: [row("a"), row("b"), row("newcomer")] });
  assert.ok(u.el.querySelector('[role="menu"]'), "reopened on the same agent");
  assert.equal(u.doc.activeElement.dataset.action, "details", "on the same item");
  // Its agent gone: the menu goes, and the focus lands on a node, never on <body>.
  u.set({ rows: [row("b"), row("newcomer")] });
  assert.equal(u.el.querySelector('[role="menu"]'), null);
  assert.ok(u.doc.activeElement?.dataset?.graphNode, "a node has the focus");
});

test("slice6b a deployment request made before the Graph mounts is still taken (the stage loads lazily)", (t) => {
  const was = currentWorkspace(); setWorkspace("ws"); t.after(() => setWorkspace(was));
  requestDeploymentTab("ws", "polaris:/w", null);
  const u = fixture(t, { rows: [row("lead"), row("builder", { server: "polaris" })] });
  assert.equal(u.focused(), "builder"); assert.equal(u.nodeOf("builder").tabIndex, 0);
  u.set({ rows: [row("lead"), row("builder", { server: "polaris" }), row("x")] });
  u.nodeOf("lead").focus(); u.set({ rows: [row("lead"), row("builder", { server: "polaris" })] });
  assert.equal(u.focused(), "lead", "taken once: a later paint doesn't move the focus back");
});

test("slice6b a root whose recorded parent resolves to no row says who it records, visibly", (t) => {
  const u = fixture(t, { rows: [row("orphan", { parentInstance: "retired-parent" }),
    row("lead", { server: "polaris" }), row("lead", { server: "vega", deployment: { id: "vega:/w" } }), row("twin-kid", { parentInstance: "lead" })],
    deployments: [...DEPLOYMENTS, { id: "vega:/w", machine: "vega", path: "/w", local: false, reachable: true }] });
  assert.match(u.nodeOf("orphan").querySelector(".graph-node-sub").textContent, /started by retired-parent/);
  assert.match(u.nodeOf("twin-kid").querySelector(".graph-node-sub").textContent, /started by lead$/, "an ambiguous name: no edge, the name it records");
  assert.equal(u.edges().filter((p) => p.dataset.to.endsWith("twin-kid")).length, 0);
});

test("slice6b Fit fits a 50+ agent column whatever the zoom floor", (t) => {
  const rows = Array.from({ length: 61 }, (_, i) => row(`solo-${i}`));
  const u = fixture(t, { rows });
  const canvas = u.el.querySelector(".graph-canvas");
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600 });
  u.graph.focus(); u.key(u.doc.activeElement, "0");
  const scale = Number(u.el.querySelector(".graph-stage").style.transform.match(/scale\(([\d.]+)\)/)[1]);
  const place = layoutGraph(u.graph.graph);
  assert.ok(place.height * scale <= 600 - 2 * GRAPH_GEOMETRY.PAD, `the whole column is on screen (${place.height} × ${scale})`);
  assert.ok(scale < 0.3, "below the manual floor");
  u.key(u.doc.activeElement, "-");
  assert.equal(Number(u.el.querySelector(".graph-stage").style.transform.match(/scale\(([\d.]+)\)/)[1]), scale, "zooming out from there stays");
  u.key(u.doc.activeElement, "=");
  assert.ok(Number(u.el.querySelector(".graph-stage").style.transform.match(/scale\(([\d.]+)\)/)[1]) > scale, "and zooming in moves up from it");
});

// Recent events keeps the old popup's ownership: a read belongs to the agent's incarnation it was asked for, on
// success and on rejection, and the dialog goes with its agent.
for (const outcome of ["success", "rejection"]) test(`slice6b Recent events: a newer incarnation at the same address revokes an older read (${outcome})`, async (t) => {
  const devA = (createdAt = birth) => ({ instance: "dev-a", agent: "dev", agentsRoot: eventsTarget.selector.agentsRoot, home: eventsTarget.home, createdAt,
    running: true, runtimeState: "running", deployment: { id: "ws" } });
  const pending = deferred(), reads = [];
  const u = fixture(t, { rows: [devA()], api: (path) => { reads.push(path); return pending.promise; },
    events: { cli: () => eventsCli, subscribeCli: () => () => {}, generation: () => 1, connectionGeneration: () => 0, subscribeConnections: () => () => {} } });
  u.nodes()[0].focus();
  u.doc.activeElement.dispatchEvent(new u.dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  u.el.querySelector('[role="menu"] [data-action="events"]').click();
  const dialog = u.el.querySelector('[role="dialog"]');
  dialog.querySelector(".events-load").click();
  assert.equal(reads.length, 1, "the read was asked");
  u.set({ rows: [devA("2026-11-19T00:00:00.000Z")] });
  const said = dialog.querySelector(".events-status").textContent;
  if (outcome === "success") pending.resolve({ instanceEventsViewApi: 1, status: "available", target: structuredClone(eventsTarget), data: eventsData(eventsFixture(), eventsTarget), reason: null });
  else pending.reject(Object.assign(new Error("read failed"), { code: "E_CLI_PROTOCOL" }));
  await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
  assert.doesNotMatch(dialog.textContent, /Reported observation loaded|Current recorded incarnation/, "the older read lands nowhere");
  assert.equal(dialog.querySelector(".events-status").textContent, said, "its outcome says nothing either");
  // The agent gone: its dialog goes with it.
  u.set({ rows: [row("someone-else")] });
  assert.equal(u.el.querySelector('[role="dialog"]'), null);
});

/** The segments of an orthogonal path ("M x y H x V y …") as [[x1, y1, x2, y2], …]. */
function segments(d) {
  const parts = d.trim().split(/\s+/), out = [];
  let x = Number(parts[1]), y = Number(parts[2]);
  for (let i = 3; i < parts.length; i += 2) {
    const v = Number(parts[i + 1]), [nx, ny] = parts[i] === "H" ? [v, y] : [x, v];
    out.push([x, y, nx, ny]); x = nx; y = ny;
  }
  return out;
}
const crosses = ([x1, y1, x2, y2], b) => Math.max(x1, x2) > b.x && Math.min(x1, x2) < b.x + b.w && Math.max(y1, y2) > b.y && Math.min(y1, y2) < b.y + b.h;

test("slice6b an edge between columns never runs through a node, next to each other or further apart", () => {
  const deps = [{ id: "/w", machine: "", path: "/w", local: true, primary: true }, { id: "alpha:/w", machine: "alpha", path: "/w", local: false },
    { id: "zeta:/w", machine: "zeta", path: "/w", local: false }];
  const rows = [row("parent"), row("other"), row("unrelated", { server: "alpha" }), row("busy", { server: "alpha" }), row("near", { server: "alpha", parentInstance: "other" }),
    row("child", { server: "zeta", parentInstance: "parent" }), row("back", { server: "zeta" }), row("left", { parentInstance: "back" })];
  const graph = instanceGraph(rows, deps, DESKTOP_TERMS), place = layoutGraph(graph);
  const between = graph.edges.filter((e) => e.kind === "cross");
  assert.equal(between.length, 3, "parent → child (two columns over), other → near (next door), back → left (leftward, two over)");
  for (const e of between) {
    const d = edgePath(e, place, graph.mode);
    assert.match(d, /^M [\d.]+ [\d.]+( [HV] [\d.]+)+$/, "orthogonal");
    for (const [id, b] of place.at) {
      if (id === e.from || id === e.to) continue;
      for (const seg of segments(d)) assert.ok(!crosses(seg, b), `${e.from} → ${e.to} passes ${id}`);
    }
  }
  // The far edges run below every column, each in its own lane, and the picture is tall enough to hold them.
  assert.equal(place.lanes.size, 2);
  assert.ok(place.height > place.columnsHeight);
});

test("slice6b removing the agent of a focused events dialog leaves the focus on a node", (t) => {
  const u = fixture(t, { rows: [row("a"), row("b")] });
  u.nodeOf("a").focus();
  u.doc.activeElement.dispatchEvent(new u.dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  u.el.querySelector('[role="menu"] [data-action="events"]').click();
  assert.ok(u.el.querySelector('[role="dialog"]').contains(u.doc.activeElement));
  u.set({ rows: [row("b")] });
  assert.equal(u.el.querySelector('[role="dialog"]'), null);
  assert.equal(u.focused(), "b", "a surviving node, never <body>");
});
