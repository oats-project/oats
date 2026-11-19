// The Desktop UI rework, slice 6b: the Graph (views/graph.mjs over packages/client/instance-graph.mjs). The spec's
// pinned acceptance tests, by name, then the rest of its "done when".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createGraph, mount, GRAPH_COPY, nodeLabel, layoutGraph, edgePath } from "../renderer/views/graph.mjs";
import { NAV, NAV_TABS, pinnedRowFor } from "../renderer/shell-nav.mjs";
import { OVERVIEW } from "../renderer/views/home.mjs";
import { instanceGraph } from "../../client/instance-graph.mjs";
import { DESKTOP_TERMS } from "../renderer/desktop-terms.mjs";
import { registerAction } from "../renderer/keybindings.mjs";
import { instanceId } from "../../client/instance-tree.mjs";
import { requestDeploymentTab } from "../renderer/deployment-tabs.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const DEPLOYMENTS = [
  { id: "/w", machine: "", path: "/w", local: true, primary: true, reachable: true },
  { id: "polaris:/w", machine: "polaris", path: "/w", local: false, reachable: true },
];
const row = (instance, extra = {}) => {
  const server = extra.server ?? null;
  return { instance, agent: "oats-developer", home: `/h/${server ?? "here"}/${instance}`, agentsRoot: "/r", running: true, runtimeState: "running",
    createdAt: "2026-11-01T00:00:00.000Z", deployment: { id: server ? `${server}:/w` : "/w" }, ...(server ? { server, remote: true } : {}), ...extra };
};

function fixture(t, { rows = [], phase = "ready", deployments = DEPLOYMENTS, note = null } = {}) {
  const dom = new JSDOM("<!doctype html><body><main></main></body>", { pretendToBeVisual: true });
  const doc = dom.window.document, el = doc.querySelector("main");
  const listeners = new Set(), opened = [], details = [], souls = [], registered = [];
  let state = { rows, phase, deployments, note, stale: () => false, here: "falcon", retry: () => { state.retried = true; } };
  const ctx = {
    api: async () => ({}),
    homeRoster: () => state,
    subscribeHomeRoster: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    openAgent: (r) => { opened.push(r.instance); return true; },
    openAgentDetails: (r) => { details.push(r.instance); return true; },
    openSoulOf: (r) => { souls.push(r.agent); },
  };
  const ws = { gen: 1, listeners: new Set() };
  const graph = createGraph(el, ctx, { doc, generation: () => ws.gen, subscribeWorkspace: (fn) => { ws.listeners.add(fn); return () => ws.listeners.delete(fn); },
    register: (a) => { registered.push(a); return registerAction(a); } });
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
  assert.deepEqual(u.souls, ["oats-developer"]);
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
  // Between the columns: from the parent's side to the child's.
  assert.match(cross[0].getAttribute("d"), /^M \d+ \d+(\.\d+)? C /);
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
    assert.match(edgePath(e, place.at, graph.mode), /^M [\d.]+ [\d.]+ V [\d.]+ H [\d.]+$/);
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
