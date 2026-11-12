// hierarchy view — layout + house async-guard regressions.
import test from "node:test";
import assert from "node:assert/strict";

const hier = await import("../renderer/views/hierarchy.mjs");
const common = await import("../renderer/views/common.mjs");
const { heldLine } = await import("../renderer/speaker-line.mjs");
const { heldHome } = await import("../../client/instance-tree.mjs");
const { pinPlatform } = await import("./helpers/platform.mjs");

test("layoutForest: children sit below and centered under their parent; no overlaps", () => {
  const { nodes, width, height } = hier.layoutForest([
    { instance: "root", running: true },
    { instance: "kid-a", parentInstance: "root", running: true },
    { instance: "kid-b", parentInstance: "root", running: false },
    { instance: "grand", parentInstance: "kid-a", running: true },
    { instance: "lone", running: false },
  ]);
  const at = (n) => nodes.find((x) => x.inst.instance === n);
  assert.equal(nodes.length, 5);
  assert.ok(at("kid-a").y > at("root").y, "child below parent");
  assert.ok(at("grand").y > at("kid-a").y, "grandchild below child");
  assert.equal(at("lone").y, at("root").y, "second root on the root row");
  // parent centered over its children
  const mid = (at("kid-a").x + at("kid-b").x) / 2;
  assert.equal(at("root").x, mid);
  // running child ranks before idle child
  assert.ok(at("kid-a").x < at("kid-b").x, "running child laid out first");
  // no two nodes share a slot
  const seen = new Set(nodes.map((n) => `${n.x}:${n.y}`));
  assert.equal(seen.size, nodes.length, "no overlapping nodes");
  assert.ok(width > 0 && height > 0);
});

test("layoutForest: cross-root parentInstance keeps its edge and depth", () => {
  const { nodes } = hier.layoutForest([
    { instance: "parent-A", workspace: "/team/root-A", running: true },
    { instance: "child-B", workspace: "/team/root-B", parentInstance: "parent-A", running: true },
  ]);
  const parent = nodes.find((n) => n.inst.instance === "parent-A");
  const child = nodes.find((n) => n.inst.instance === "child-B");
  assert.deepEqual(parent.children.map((n) => n.inst.instance), ["child-B"],
    "visual root boundaries must not sever spawn parentage");
  assert.ok(child.y > parent.y, "cross-root child remains below its parent");
});

test("layoutForest: a parentInstance missing from the roster makes the child a root (no crash)", () => {
  const { nodes } = hier.layoutForest([
    { instance: "orphan", parentInstance: "retired-elsewhere", running: true },
  ]);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].y, 0, "orphan treated as a root");
});

test("layoutForest: malformed parent cycles are promoted and never disappear", () => {
  const { nodes, width, height } = hier.layoutForest([
    { instance: "healthy", running: true },
    { instance: "cycle-a", parentInstance: "cycle-b", running: true },
    { instance: "cycle-b", parentInstance: "cycle-a", running: true },
    { instance: "cycle-child", parentInstance: "cycle-b", running: false },
  ]);
  assert.deepEqual(new Set(nodes.map((n) => n.inst.instance)),
    new Set(["healthy", "cycle-a", "cycle-b", "cycle-child"]),
    "healthy and cyclic components are all retained");
  const at = (name) => nodes.find((n) => n.inst.instance === name);
  assert.equal(at("cycle-a").y, 0, "deterministic first cycle node is promoted to root");
  assert.ok(at("cycle-b").y > at("cycle-a").y, "remaining cycle edge becomes a valid child edge");
  assert.ok(at("cycle-child").y > at("cycle-b").y, "valid descendants of cycle remain attached");
  assert.ok(width > 0 && height > 0);
});

test("layoutForest: a pure cycle terminates with unique non-overlapping nodes", () => {
  const { nodes } = hier.layoutForest([
    { instance: "a", parentInstance: "c", running: true },
    { instance: "b", parentInstance: "a", running: true },
    { instance: "c", parentInstance: "b", running: true },
  ]);
  assert.equal(nodes.length, 3);
  assert.equal(new Set(nodes.map((n) => n.inst.instance)).size, 3);
  assert.equal(new Set(nodes.map((n) => `${n.x}:${n.y}`)).size, 3);
});

test("layoutForest: a descendant sorting before idle cycle members keeps its valid parent edge", () => {
  const { nodes } = hier.layoutForest([
    { instance: "running-child", parentInstance: "cycle-b", running: true },
    { instance: "cycle-a", parentInstance: "cycle-b", running: false },
    { instance: "cycle-b", parentInstance: "cycle-a", running: false },
  ]);
  const at = (name) => nodes.find((n) => n.inst.instance === name);
  assert.equal(nodes.filter((n) => n.y === 0).length, 1, "one actual cycle member—not its descendant—is promoted");
  assert.ok(at("running-child").y > at("cycle-b").y, "valid child stays below its declared parent");
  assert.ok(at("cycle-b").children.some((n) => n.inst.instance === "running-child"),
    "cycle recovery does not sever the descendant edge");
});

test("ws generation: a deferred roster from workspace A never paints after switching to B", async () => {
  const gate = [];
  const payload = (name) => ({ ok: true, status: 200, json: async () => ({ instances: [{ instance: name, running: true }], workspaces: [], workspace: null }) });
  const ctx = { api: (pathname) => new Promise((ok) => gate.push({ pathname, ok })) };
  // minimal state double: refresh() touches q('wssel') + render() via s.panel
  const painted = [];
  const s = {
    alive: true, ctx,
    panel: { instances: [] },
    groupOffsets: new Map(), nodeOffsets: new Map(), nodeEls: new Map(), fitted: true, tx: 0, ty: 0, z: 1,
    q: () => ({ style: {}, innerHTML: "", value: "", addEventListener() {} }),
  };
  // stub render by intercepting panel assignment: refresh assigns s.panel then renders,
  // so make canvas/render dependencies inert
  s.canvas = { innerHTML: "", querySelector: () => null, append() {}, classList: { toggle() {}, add() {}, remove() {} } };
  s.nodeEls = new Map();
  const fakeEl = () => ({
    style: {}, dataset: {}, classList: { toggle() {}, add() {}, remove() {} },
    innerHTML: "", textContent: "", title: "",
    append() {}, appendChild() {}, prepend() {}, remove() {},
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, setAttribute() {},
  });
  const hadDoc = Object.prototype.hasOwnProperty.call(globalThis, "document");
  if (!hadDoc) globalThis.document = { createElement: fakeEl, createElementNS: fakeEl };
  const prevWs = common.currentWorkspace();
  try {
    common.setWorkspace("wsA");
    const inFlightA = hier.refresh(s);
    assert.match(gate[0].pathname, /ws=wsA/);
    common.setWorkspace("wsB");
    const inFlightB = hier.refresh(s);
    assert.match(gate[1].pathname, /ws=wsB/);
    // B lands and paints
    gate[1].ok(payload("from-B"));
    await inFlightB;
    assert.equal(s.panel.instances[0].instance, "from-B");
    // A's STALE response lands — must not clobber B's panel
    gate[0].ok(payload("from-A"));
    await inFlightA;
    assert.equal(s.panel.instances[0].instance, "from-B", "stale workspace roster must never paint");
  } finally {
    common.setWorkspace(prevWs);
    if (!hadDoc) delete globalThis.document;
  }
});

test("refresh after teardown (alive=false) never mutates state", async () => {
  const gate = [];
  const ctx = { api: () => new Promise((ok) => gate.push(ok)) };
  const s = { alive: true, ctx, panel: { instances: [] }, q: () => ({ style: {}, addEventListener() {} }), canvas: {}, nodeEls: new Map() };
  const inFlight = hier.refresh(s);
  s.alive = false; // tab closed while the fetch was in flight
  gate[0]({ ok: true, status: 200, json: async () => ({ instances: [{ instance: "late", running: true }] }) });
  await inFlight;
  assert.equal(s.panel.instances.length, 0, "post-unmount response must not paint");
});

test("layoutForest tolerates sibling-link fields — every instance placed, parent edges intact", () => {
  // feature/agent-relations: rosters may carry sibling-link metadata; the
  // hierarchy layout is parentInstance-driven and must neither crash nor
  // drop sibling-linked nodes (they lay out as separate roots).
  const { nodes } = hier.layoutForest([
    { instance: "coord-1", running: true },
    { instance: "dev-a", parentInstance: "coord-1", running: true },
    { instance: "dev-b", parentInstance: "coord-1", running: false },
    { instance: "peer-1", siblingInstance: "peer-2", relation: "sibling", relativeTo: "peer-2", running: false },
    { instance: "peer-2", siblingInstance: "peer-1", running: false },
  ]);
  assert.equal(nodes.length, 5, "sibling metadata never hides an instance");
  const byName = new Map(nodes.map((n) => [n.inst.instance, n]));
  assert.ok(byName.get("coord-1").children.some((c) => c.inst.instance === "dev-a"), "parent edges survive");
  assert.equal(byName.get("peer-1").y, 0, "sibling-only nodes are roots");
  assert.equal(byName.get("peer-2").y, 0);
});

test("layoutClusters: multi-member clusters get cards; singletons collect in one Independent block", () => {
  const { placed, soloBlock, width, height } = hier.layoutClusters([
    { instance: "root", running: true },
    { instance: "kid", parentInstance: "root", running: true },
    { instance: "peer", running: true, siblingInstance: "root" },
    { instance: "solo-1", running: false },
    { instance: "solo-2", running: true },
  ]);
  assert.equal(placed.length, 1, "one multi-member cluster");
  assert.equal(placed[0].cluster.size, 3);
  assert.deepEqual(placed[0].sibs, [{ a: "peer", b: "root" }], "sibling edge surfaces for rendering");
  assert.equal(soloBlock.nodes.length, 2, "singletons share the Independent block");
  assert.ok(soloBlock.y >= placed[0].y + placed[0].h, "Independent block sits below cluster cards");
  // node coordinates are group-local and inside the card's padded area
  for (const n of placed[0].nodes) assert.ok(n.x >= 0 && n.y > 0);
  assert.ok(width > 0 && height > 0);
});

test("layoutClusters: deterministic across roster order; no instance lost", () => {
  const roster = [
    { instance: "b-root", running: false },
    { instance: "b-kid", parentInstance: "b-root", running: true },
    { instance: "a-root", running: true },
    { instance: "a-kid", parentInstance: "a-root", running: true },
    { instance: "lone", running: false },
  ];
  const l1 = hier.layoutClusters(roster);
  const l2 = hier.layoutClusters([...roster].reverse());
  const namesOf = (l) => l.placed.map((p) => p.cluster.name);
  assert.deepEqual(namesOf(l1), ["a-root", "b-root"], "running-heavy cluster first");
  assert.deepEqual(namesOf(l2), namesOf(l1), "stable across shuffles");
  const all = (l) => [...l.placed.flatMap((p) => p.nodes), ...(l.soloBlock?.nodes || [])].map((n) => n.inst.instance).sort();
  assert.deepEqual(all(l1), ["a-kid", "a-root", "b-kid", "b-root", "lone"]);
});

test("layoutClusters: all-singleton roster yields only the Independent block", () => {
  const { placed, soloBlock } = hier.layoutClusters([
    { instance: "x", running: true }, { instance: "y", running: false },
  ]);
  assert.equal(placed.length, 0);
  assert.equal(soloBlock.nodes.length, 2);
  assert.equal(soloBlock.y, 0, "no cluster cards above — block starts at the top");
});

test("agent groups are named by their root instance (Redesign v3), matching the sidebar group", async t => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(`<div id="root"></div>`, { pretendToBeVisual: true });
  const g = globalThis;
  const prev = { window: g.window, document: g.document, localStorage: g.localStorage };
  g.window = dom.window; g.document = dom.window.document;
  g.localStorage = { getItem: () => null, setItem: () => {} };
  try {
    const panel = { instances: [
      { instance: "named-root", running: true, parentInstance: null, siblingInstance: null },
      { instance: "kid", running: false, parentInstance: "named-root", siblingInstance: null },
      { instance: "solo", running: true, parentInstance: null, siblingInstance: null },
    ], workspaces: [], workspace: null };
    const ctx = { api: async () => ({ ok: true, status: 200, json: async () => panel }), openTerminal() {} };
    const el = dom.window.document.getElementById("root");
    const un = hier.mount(el, ctx); t.after(() => { un(); dom.window.close(); });
    await new Promise((r) => setTimeout(r, 30));
    const head = el.querySelector(".hier-cluster .hier-chead");
    assert.ok(head, "cluster card has a header");
    assert.equal(head.querySelector(".cnm").textContent, "named-root", "the root instance names the group");
    assert.equal(head.querySelector(".cct").textContent, "2", "member count; no repo was reported");
    assert.ok(!head.textContent.includes("kid"), "a child never names the group");
    const card = el.querySelector(".hier-cluster");
    assert.equal(card.getAttribute("aria-label"), "Agent group named-root: 2 agents, 1 running",
      "the accessible name carries the group name and live counts");
    const soloCard = el.querySelector(".hier-solo");
    assert.equal(soloCard.getAttribute("aria-label"), "Independent agents: 1",
      "Independent is an allowed category label, not a cluster name");
    const soloHead = el.querySelector(".hier-solo .hier-chead");
    assert.ok(soloHead.textContent.startsWith("Independent"), "strip keeps its category label");
    un();
  } finally {
    g.window = prev.window; g.document = prev.document; g.localStorage = prev.localStorage;
  }
});

test("duplicate names across agents roots render as DISTINCT nodes; terminal opens carry identity", async t => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(`<div id="root"></div>`, { pretendToBeVisual: true });
  const g = globalThis;
  const prev = { window: g.window, document: g.document, localStorage: g.localStorage };
  g.window = dom.window; g.document = dom.window.document;
  g.localStorage = { getItem: () => null, setItem: () => {} };
  try {
    const panel = { instances: [
      { instance: "dev", agentsRoot: "/a/agents", home: "/a/agents/dev/i/dev", running: true },
      { instance: "dev", agentsRoot: "/b/agents", home: "/b/agents/dev/i/dev", running: true },
      { instance: "kid", agentsRoot: "/a/agents", home: "/a/agents/kid/i/kid", parentInstance: "dev", running: true },
    ], workspaces: [], workspace: null };
    const opened = [];
    const ctx = { api: async () => ({ ok: true, status: 200, json: async () => panel }),
                  openTerminal: (ref) => opened.push(ref) };
    const el = dom.window.document.getElementById("root");
    const un = hier.mount(el, ctx); t.after(() => { un(); dom.window.close(); });
    await new Promise((r) => setTimeout(r, 30));
    const nodes = [...el.querySelectorAll(".hnode")];
    assert.equal(nodes.length, 3, "duplicate-named instances are distinct nodes — none dropped");
    assert.equal(new Set(nodes.map((n) => n.dataset.id)).size, 3, "node identity keys are unique");
    // the OTHER-root dev is a singleton in the Independent strip, not merged
    assert.equal(el.querySelectorAll(".hier-cluster .hnode").length, 2);
    assert.equal(el.querySelectorAll(".hier-solo .hnode").length, 1);
    // double-click opens with full identity (home/agentsRoot), not a bare name
    const soloNode = el.querySelector(".hier-solo .hnode");
    soloNode.dispatchEvent(new dom.window.Event("dblclick", { bubbles: true }));
    assert.equal(opened.length, 1);
    assert.equal(opened[0].home, "/b/agents/dev/i/dev", "terminal open addresses the exact instance");
    assert.equal(opened[0].agentsRoot, "/b/agents");
    un();
  } finally {
    g.window = prev.window; g.document = prev.document; g.localStorage = prev.localStorage;
  }
});

test("relation resolution keeps FULL-roster scope after clustering: globally-ambiguous edge never reintroduced", () => {
  // /c/kid joins /a/dev's component via an unambiguous sibling link, but
  // kid.parentInstance="dev" is globally AMBIGUOUS (/a/dev vs /b/dev):
  // clustering drops it — the per-cluster forest must NOT resurrect it.
  const roster = [
    { instance: "dev", agentsRoot: "/a", home: "/a/dev", running: true },
    { instance: "dev", agentsRoot: "/b", home: "/b/dev", running: true },
    { instance: "kid", agentsRoot: "/c", home: "/c/kid", parentInstance: "dev",
      siblingInstance: "uniq", running: true },
    // uniq shares /a with its parent "dev" — same-root resolution validly
    // pulls /a/dev into kid's component, making "dev" unique WITHIN the
    // cluster while staying ambiguous in the full roster.
    { instance: "uniq", agentsRoot: "/a", home: "/a/uniq", parentInstance: "dev", running: true },
  ];
  const { placed } = hier.layoutClusters(roster);
  const cl = placed.find((pc) => pc.nodes.some((n) => n.inst.home === "/c/kid"));
  assert.ok(cl.nodes.some((n) => n.inst.home === "/a/dev"),
    "fixture: /a/dev must share kid's cluster for the test to bite");
  const kid = cl.nodes.find((n) => n.inst.home === "/c/kid");
  const parentOfKid = cl.nodes.find((n) => n.children.includes(kid));
  assert.equal(parentOfKid, undefined,
    "ambiguous parent stays dropped inside the cluster forest — kid renders as a root");
});

test("layout determinism with duplicate names: identity tie-break keeps coordinates stable across roster order", () => {
  const roster = [
    { instance: "root", home: "/r/root", running: true },
    { instance: "dev", agentsRoot: "/a", home: "/a/dev", parentInstance: "root", running: true },
    { instance: "dev", agentsRoot: "/b", home: "/b/dev", parentInstance: "root", running: true },
  ];
  const posOf = (lay, home) => {
    const n = lay.nodes.find((x) => x.inst.home === home);
    return `${n.x}:${n.y}`;
  };
  const l1 = hier.layoutForest(roster);
  const l2 = hier.layoutForest([...roster].reverse());
  assert.equal(posOf(l1, "/a/dev"), posOf(l2, "/a/dev"), "same-named children never swap slots");
  assert.equal(posOf(l1, "/b/dev"), posOf(l2, "/b/dev"));
});

test("full-roster scope covers SIBLING edges too: globally-ambiguous sibling name never becomes a false edge", () => {
  // /c/kid declares siblingInstance="dev" — globally AMBIGUOUS (/a/dev vs
  // /b/dev), so clustering drops it. But /a/dev is validly in kid's cluster
  // (child of the same root), so a cluster-scoped index would see exactly
  // one "dev" and resurrect the pair as a false sibling arc.
  const roster = [
    { instance: "root", home: "/c/root", running: true },
    { instance: "kid", agentsRoot: "/c", home: "/c/kid", parentInstance: "root",
      siblingInstance: "dev", running: true },
    { instance: "dev", agentsRoot: "/a", home: "/a/dev", parentInstance: "root", running: true },
    { instance: "dev", agentsRoot: "/b", home: "/b/dev", running: true },
  ];
  const { placed } = hier.layoutClusters(roster);
  const cl = placed.find((pc) => pc.nodes.some((n) => n.inst.home === "/c/kid"));
  assert.ok(cl.nodes.some((n) => n.inst.home === "/a/dev"),
    "fixture: /a/dev must share kid's cluster for the narrowed-scope bug to bite");
  assert.deepEqual(cl.sibs, [],
    "ambiguous sibling name stays dropped — no false arc from cluster-local uniqueness");
});

test("remote overview opens the selected server and shows unknown separately from stopped", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const prev = { window: globalThis.window, document: globalThis.document, localStorage: globalThis.localStorage };
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  let un;
  try {
    const panel = { instances: [
      { instance: "dev", agent: "dev", home: "/same/home", agentsRoot: "/agents", server: "one", addressable: true, running: true },
      { instance: "dev", agent: "dev", home: "/same/home", agentsRoot: "/agents", server: "two", addressable: true, running: true },
      { instance: "unreachable", home: "/unknown", server: "two", running: null },
      { instance: "ended", home: "/stopped", server: "two", running: false },
    ], workspaces: [], workspace: null };
    const opened = [];
    const el = dom.window.document.getElementById("root");
    un = hier.mount(el, { api: async () => ({ ok: true, json: async () => panel }),
      openTerminal: (ref) => opened.push(ref) });
    await new Promise((r) => setTimeout(r, 30));
    const nodes = [...el.querySelectorAll('.hnode')];
    const twins = nodes.filter((n) => n.dataset.name === 'dev');
    for (const node of twins) node.dispatchEvent(new dom.window.Event('dblclick', { bubbles: true }));
    assert.deepEqual(opened.map((r) => r.server).sort(), ['one', 'two']);
    assert.ok(opened.every((r) => r.home === '/same/home'));
    const unknown = nodes.find((n) => n.dataset.name === 'unreachable');
    assert.match(unknown.getAttribute('aria-label'), /unknown/);
    assert.match(unknown.textContent, /state unknown/);
    assert.equal(unknown.classList.contains('idle'), false);
    assert.match(el.querySelector('.hier-sum').textContent, /2 running.*1 stopped.*1 unknown/);
    twins[0].dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    // No Workspace page to go to in this host: Go to soul says so, and reads no catalog.
    assert.equal(el.querySelector('.psoul').disabled, true);
    assert.equal(el.querySelector('.psoul').title, 'The Workspace page is not available here.');
  } finally { un?.(); Object.assign(globalThis, prev); dom.window.close(); }
});

test("edges follow OAS: parent→child is a bottom-centre to top-centre S-curve; siblings are dashed shallow arcs", async t => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(`<div id="root"></div>`, { pretendToBeVisual: true });
  const g = globalThis;
  const prev = { window: g.window, document: g.document, localStorage: g.localStorage };
  g.window = dom.window; g.document = dom.window.document;
  g.localStorage = { getItem: () => null, setItem: () => {} };
  try {
    const panel = { instances: [
      { instance: "root", running: true },
      { instance: "kid", running: true, parentInstance: "root" },
      { instance: "peer", running: false, siblingInstance: "root" },
    ], workspaces: [], workspace: null };
    const ctx = { api: async () => ({ ok: true, status: 200, json: async () => panel }), openTerminal() {} };
    const el = dom.window.document.getElementById("root");
    const un = hier.mount(el, ctx); t.after(() => { un(); dom.window.close(); });
    await new Promise((r) => setTimeout(r, 30));
    const box = (name) => {
      const n = el.querySelector(`.hnode[data-name="${name}"]`);
      return { x: parseFloat(n.style.left), y: parseFloat(n.style.top) };
    };
    const W = 220, H = 60, num = String.raw`(-?[\d.]+)`;
    const parentEdge = el.querySelector('.hier-edges path[data-parent="root"][data-child="kid"]');
    assert.ok(parentEdge && !parentEdge.classList.contains("sib"), "parent edge is a solid path");
    const [, x1, y1, c1x, c1y, c2x, c2y, x2, y2] = parentEdge.getAttribute("d")
      .match(new RegExp(`^M ${num} ${num} C ${num} ${num}, ${num} ${num}, ${num} ${num}$`)).map(Number);
    const r = box("root"), k = box("kid");
    assert.deepEqual([x1, y1], [r.x + W / 2, r.y + H], "starts at the parent's bottom-centre");
    assert.deepEqual([x2, y2], [k.x + W / 2, k.y], "ends at the child's top-centre");
    const my = (y1 + y2) / 2;
    assert.deepEqual([c1x, c1y, c2x, c2y], [x1, my, x2, my], "both control points sit on the vertical midpoint");

    const sib = el.querySelector(".hier-edges path.sib");
    assert.ok(sib, "the sibling edge carries the dashed class");
    const [, sx1, sy1, sc1x, sc1y, sc2x, sc2y, sx2, sy2] = sib.getAttribute("d")
      .match(new RegExp(`^M ${num} ${num} C ${num} ${num}, ${num} ${num}, ${num} ${num}$`)).map(Number);
    const [left, right] = [box("root"), box("peer")].sort((a, b) => a.x - b.x);
    assert.deepEqual([sx1, sy1], [left.x + W, left.y + H / 2], "leaves the left box's right-edge midpoint");
    assert.deepEqual([sx2, sy2], [right.x, right.y + H / 2], "reaches the right box's left-edge midpoint");
    const mx = (sx1 + sx2) / 2;
    assert.deepEqual([sc1x, sc1y, sc2x, sc2y], [mx, sy1, mx, sy2], "a shallow arc through the horizontal midpoint");
    assert.match(hier.hierarchyCSS, /\.hier-edges path\.sib \{ stroke-dasharray:\s*5 4; \}/,
      "siblings differ by dash, not colour alone");
    assert.match(hier.hierarchyCSS, /\.hier-edges path \{ stroke: var\(--graph-edge\); stroke-width: 1\.5;/);
    assert.match(hier.hierarchyCSS, /\.hier-edges path\.lit \{ stroke: var\(--accent\); stroke-width: 2; \}/);
    un();
  } finally {
    g.window = prev.window; g.document = prev.document; g.localStorage = prev.localStorage;
  }
});

/* ── the card's two acts: Go to instance and Go to soul ── */

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const OKF = "github.com/awebai/oats-okf", ACME = "github.com/acme/agents";
// A row of the package soul oats.okf/dev, whose agent dir (dev-pkg) is not the catalog's name for it (dev).
const row = (name, fields = {}) => ({ instance: name, agent: "dev-pkg", agentsRoot: "/team/agents", home: `/team/agents/dev-pkg/instances/${name}`,
  running: true, soulKey: "oats.okf/dev", soul: { repoKey: OKF }, ...fields });
// The package soul, and member souls of the same bare name: at the same root, and at another.
const PACKAGE_SOUL = { name: "dev", key: "oats.okf/dev", agentsRoot: "/team/agents", soulSource: { repoKey: OKF }, description: "The package's dev soul", work: "worktree" };
const MEMBER_SOUL = { name: "dev", key: "dev", agentsRoot: "/team/agents", soulSource: { repoKey: ACME }, description: "The member's dev soul", work: "worktree" };
const ELSEWHERE_SOUL = { ...MEMBER_SOUL, agentsRoot: "/other/agents", description: "Another root's dev soul" };

const CLI_OK = { ok: true, bin: "/seed/oats", version: "0.18.0", source: "path", required: { desktopApi: 1, range: ">=0.18.0 <0.21.0" }, probedAt: 1, tried: [] };

/** The Deployments view mounted on a fixture roster. `agents(path)` answers /api/agents (a value, a promise, or a throw).
 * `inPage`: as the app mounts it since 2026-10-26, inside the Workspace page (views/spawn.mjs), on its Machines tab
 * (preselected, as stage.hierarchy does; syncMachines mounts the view in .workspace-machines-panel with the page's
 * ctx, whose openView("spawn") is the page's Souls tab). The page and the view then read the same fixture, as they read
 * the same server; `pagePoll` is the page's own roster poll. */
async function card(t, { instances, deployments = null, agents = () => ({ agents: [PACKAGE_SOUL, ELSEWHERE_SOUL] }), ctx: extra = {}, inPage = false } = {}) {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<body><main id="host"></main><div id="spawn"></div></body>', { url: "http://localhost" });
  const doc = dom.window.document;
  const old = { window: globalThis.window, document: globalThis.document, setInterval: globalThis.setInterval, ws: common.currentWorkspace() };
  globalThis.window = dom.window; globalThis.document = doc;
  doc.hasFocus = () => true;
  common.setWorkspace("/team");
  const unmounts = [];
  t.after(() => { for (const off of unmounts.reverse()) off(); common.setWorkspace(old.ws); Object.assign(globalThis, { window: old.window, document: old.document, setInterval: old.setInterval }); dom.window.close(); });
  // Every roster poll is the test's to run: the view's first, then (in the page) the page's own.
  const polls = [];
  globalThis.setInterval = (fn) => { polls.push(fn); return 0; };
  const calls = [], opened = [], started = [], views = [], notes = [];
  const api = (path) => {
    calls.push(path);
    if (path.startsWith("/api/cli")) return CLI_OK;
    if (path.startsWith("/api/panel")) return { instances, workspace: { id: "/team" }, workspaces: [{ id: "/team", name: "Team" }], generatedAt: "now", ...(deployments ? { deployments } : {}) };
    if (path.startsWith("/api/agents")) return agents(path);
    throw new Error(`unexpected ${path}`);
  };
  const ctx = { hasWorkspaceSwitcher: true, api, openTerminal: (ref) => opened.push(ref), startInstance: (ref) => started.push(ref),
    openView: (name) => views.push(name), notify: (message) => notes.push(message), ...extra };
  let host = doc.querySelector("main"), spawn = null;
  if (inPage) {
    const { refreshCli, resetCliStateForTests } = await import("../renderer/views/cli-status.mjs");
    spawn = await import("../renderer/views/spawn.mjs");
    await refreshCli({ api: async () => CLI_OK });
    assert.equal(spawn.preselectWorkspaceTab("machines"), true);
    spawn.mount(doc.getElementById("spawn"), ctx);
    unmounts.push(() => { spawn.unmount(); resetCliStateForTests(); });
    host = doc.querySelector("#spawn .workspace-machines-panel");
    assert.equal(polls.length, 2, "the view's roster poll, then the page's");
    for (let i = 0; i < 4; i++) await tick();
  } else {
    unmounts.push(hier.mount(host, ctx));
    await tick();
  }
  host.querySelector(".hier-canvas").getBoundingClientRect = () => ({ left: 0, top: 0, width: 1200, height: 800 });
  const mounted = calls.length; // in the page, the view's reads are those made from here on (the page read its souls already)
  const node = (name) => [...host.querySelectorAll(".hnode")].find((n) => n.dataset.name === name);
  return { dom, doc, host, calls, opened, started, views, notes, node, spawn,
    select: async (name) => { node(name).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, button: 0 })); await tick(); await tick(); },
    poll: async () => { polls[0](); await tick(); await tick(); },
    pagePoll: async () => { polls[1](); for (let i = 0; i < 4; i++) await tick(); },
    key: (key) => { const e = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }); host.querySelector(".hier-canvas").dispatchEvent(e); return e; },
    term: () => host.querySelector(".pterm"), soul: () => host.querySelector(".psoul"), status: () => host.querySelector(".pstatus").textContent,
    agentsReads: () => calls.slice(inPage ? mounted : 0).filter((p) => p.startsWith("/api/agents")) };
}

test("the card offers exactly two acts, Go to instance then Go to soul: no Git, Restart with…, Brain, Workspace or notes", async (t) => {
  const u = await card(t, { instances: [row("dev-1")] });
  await u.select("dev-1");
  // The acts row; the activity section's own Load activity button is part of the facts, not an act.
  assert.deepEqual([...u.host.querySelectorAll(".hier-pop .pacts button")].map((b) => [b.className, b.textContent]),
    [["act pterm", "Go to instance"], ["act psoul", "Go to soul"]]);
  const anywhere = [...u.host.querySelectorAll(".hier-pop button")].map((b) => b.textContent.trim());
  for (const gone of ["Git", "Restart with…", "Brain", "Workspace", "Terminal"]) assert.ok(!anywhere.includes(gone), `no ${gone} button anywhere in the popover`);
  for (const gone of [".pgit", ".prestart", ".pbrain", ".pworkspace", ".pactions-note"]) assert.equal(u.host.querySelector(gone), null, gone);
  assert.doesNotMatch(u.host.querySelector(".hier-pop").textContent, /K1\/P1|Brain|choose the exact soul/);
});

test("Go to instance: a running row opens its exact terminal, a stopped one says Start… and opens the Start dialog; unknown, held, unsupported and unaddressable rows are disabled with why", async (t) => {
  pinPlatform(t);
  const HERDR = "E_HERDR_REMOVED: Herdr is no longer supported by OATS (removed in 0.31.0); tmux is the only session backend.";
  const GENERIC = "Requires a current, addressed instance with known runtime state and an available route.";
  const held = row("held", { running: false, spawnInProgress: true });
  const u = await card(t, { instances: [row("run"), row("stop", { running: false }), row("unk", { running: null }), held,
    row("herdr", { running: null, runtimeState: "unsupported", runtimeError: HERDR }),
    row("far", { server: "devbox", addressable: false, savedRoute: true, home: "/srv/agents/dev-pkg/instances/far", agentsRoot: "/srv/agents" })] });
  const expect = { run: ["Go to instance", false, "Open this exact instance terminal"], stop: ["Start…", false, "Stopped: no terminal to go to. Opens the Start dialog."],
    unk: ["Go to instance", true, GENERIC], held: ["Start…", true, heldLine(heldHome(held))], herdr: ["Go to instance", true, HERDR], far: ["Go to instance", true, GENERIC] };
  for (const [name, [label, disabled, title]] of Object.entries(expect)) {
    await u.select(name);
    assert.deepEqual([u.term().textContent, u.term().disabled, u.term().title], [label, disabled, title], name);
    u.term().click(); // a disabled button's click acts on nothing
  }
  assert.deepEqual(u.opened, [{ instance: "run", home: "/team/agents/dev-pkg/instances/run", agentsRoot: "/team/agents" }]);
  assert.deepEqual(u.started.map((i) => [i.instance, i.home]), [["stop", "/team/agents/dev-pkg/instances/stop"]]);
  // Double-click, Enter and T take exactly the button's act.
  u.node("run").dispatchEvent(new u.dom.window.Event("dblclick", { bubbles: true }));
  await u.select("stop"); u.key("Enter"); u.key("T");
  for (const name of ["unk", "held", "herdr", "far"]) { u.node(name).dispatchEvent(new u.dom.window.Event("dblclick", { bubbles: true })); await u.select(name); u.key("Enter"); u.key("T"); }
  assert.deepEqual([u.opened.length, u.started.length], [2, 3], "one more terminal (double-click), two more Start dialogs (Enter, T); nothing for the rest");
});

// Go to soul from the Machines tab (2026-10-26): the soul is handed to the Workspace page the view lives in, which
// turns to Souls and shows the soul's page; the Machines view leaves with its tab (syncMachines), so what the
// handoff says after that (a miss) is a notification, not the card's status line.
const soulsTab = (u) => u.doc.getElementById("workspace-tab-souls"), machinesPanel = (u) => u.doc.getElementById("workspace-machines");

test("Go to soul: a package soul is found by its key, source and root (not its agent dir), and the press hands that exact soul to the Workspace page and shows it", async (t) => {
  const u = await card(t, { instances: [row("dev-1")], inPage: true });
  assert.equal(u.doc.getElementById("workspace-tab-machines").getAttribute("aria-selected"), "true", "the view is the Machines tab's");
  await u.select("dev-1");
  assert.equal(u.soul().disabled, false);
  assert.equal(u.soul().title, "Open oats.okf/dev on the Workspace page");
  assert.deepEqual(u.agentsReads(), ["/api/agents?ws=%2Fteam"], "the row's own deployment's catalog, read once");
  // A roster refresh reads it again, once.
  await u.poll();
  assert.equal(u.agentsReads().length, 2); assert.equal(u.soul().disabled, false);
  u.soul().click(); await tick(); await tick();
  assert.deepEqual(u.views, [], "no stage switch: the Workspace page is the one already shown");
  assert.equal(soulsTab(u).getAttribute("aria-selected"), "true", "the page turns to Souls");
  assert.equal(u.spawn.currentWorkspaceTab(), "souls");
  assert.equal(machinesPanel(u).hidden, true); assert.equal(machinesPanel(u).childElementCount, 0, "the Machines view left with its tab");
  const page = u.doc.querySelector(".workspace-soul-page");
  assert.equal(page.hidden, false, "the soul's page is open");
  // The page alone: the press's own Workspace (openView) on the page already on Souls shows nothing under it.
  for (const id of ["souls-grid", "souls-bar", "workspace-header"]) assert.equal(u.doc.querySelector(`.${id}`).hidden, true, `${id} stays hidden under the soul's page`);
  assert.match(page.textContent, /The package's dev soul/); assert.doesNotMatch(page.textContent, /Another root's dev soul/);
  assert.deepEqual(u.notes, [], "nothing to say");
});

test("Go to soul: a miss on arrival (the catalog changed in between) is said, and the member soul of the same name is never opened instead", async (t) => {
  let catalog = [PACKAGE_SOUL, ELSEWHERE_SOUL];
  const u = await card(t, { instances: [row("dev-1")], agents: () => ({ agents: catalog }), inPage: true });
  await u.select("dev-1");
  assert.equal(u.soul().disabled, false);
  catalog = [MEMBER_SOUL]; await u.pagePoll(); // the package soul is gone now: the page read its catalog again
  u.soul().click(); await tick(); await tick();
  assert.deepEqual(u.notes, ["oats.okf/dev is not among this deployment's souls now."], "said once the card has left with the Machines tab");
  assert.equal(soulsTab(u).getAttribute("aria-selected"), "true");
  assert.equal(u.doc.querySelector(".workspace-soul-page").hidden, true, "the member soul of the same name is never opened instead");
});

test("Go to soul: the soul's source is handed over too: the same key from another source on arrival is a miss", async (t) => {
  let catalog = [PACKAGE_SOUL, ELSEWHERE_SOUL];
  const u = await card(t, { instances: [row("dev-1")], agents: () => ({ agents: catalog }), inPage: true });
  await u.select("dev-1");
  catalog = [{ ...PACKAGE_SOUL, soulSource: { repoKey: "github.com/fork/oats-okf" } }]; await u.pagePoll();
  u.soul().click(); await tick(); await tick();
  assert.deepEqual(u.notes, ["oats.okf/dev is not among this deployment's souls now."]);
  assert.equal(u.doc.querySelector(".workspace-soul-page").hidden, true);
});

test("Go to soul: a namesake that joined the soul's root by the time the handoff arrives stops it, and says why", async (t) => {
  // The card read one dev at the root; the Workspace page's catalog has gained a member soul named dev there since.
  let catalog = [PACKAGE_SOUL];
  const u = await card(t, { instances: [row("dev-1")], agents: () => ({ agents: catalog, catalog: { reason: null, ambiguous: [] } }), inPage: true });
  await u.select("dev-1");
  assert.equal(u.soul().disabled, false);
  catalog = [PACKAGE_SOUL, MEMBER_SOUL]; await u.pagePoll();
  u.soul().click(); await tick(); await tick();
  assert.deepEqual(u.notes, ["Another soul in this deployment is also named dev, so the Workspace page cannot open oats.okf/dev."]);
  assert.equal(u.doc.querySelector(".workspace-soul-page").hidden, true, "a page whose inspection would be refused is never opened");
});

test("Go to soul: a remote row's soul is its agent dir on its own host and root", async (t) => {
  const remote = { instance: "far-1", agent: "remote-dev", agentsRoot: "/srv/agents", home: "/srv/agents/remote-dev/instances/far-1", server: "devbox", addressable: true, running: true };
  const u = await card(t, { instances: [remote, { ...remote, instance: "far-2", home: "/srv/agents/remote-dev/instances/far-2", server: "laptop" }],
    agents: () => ({ agents: [{ name: "remote-dev", agentsRoot: "/srv/agents", server: "devbox" }, { name: "remote-dev", agentsRoot: "/other/agents", server: "laptop" }] }) });
  await u.select("far-1");
  assert.equal(u.soul().disabled, false); assert.equal(u.soul().title, "Open remote-dev on the Workspace page");
  const second = [...u.host.querySelectorAll(".hnode")].find((n) => n.dataset.name === "far-2");
  second.dispatchEvent(new u.dom.window.MouseEvent("click", { bubbles: true, button: 0 })); await tick(); await tick();
  assert.equal(u.soul().disabled, true, "laptop's remote-dev is of another root");
  assert.equal(u.soul().title, "remote-dev is not among this deployment's souls now.");
});

test("Go to soul is disabled with why: no recorded soul, no catalog row, several, ambiguous, another source or root, a shared name, a failed read", async (t) => {
  const failing = new Set();
  const u = await card(t, {
    instances: [row("bare", { soulKey: undefined, soul: undefined }), row("nul", { soulKey: null }), row("nosrc", { soul: undefined }),
      row("gone", { soulKey: "oats.okf/gone" }), row("twin", { soulKey: "twin" }), row("amb", { soulKey: "amb" }),
      row("moved", { soul: { repoKey: "github.com/fork/oats-okf" } }), row("rooted", { agentsRoot: "/elsewhere/agents", home: "/elsewhere/agents/dev-pkg/instances/rooted" }),
      row("shared", { soulKey: "oats.okf/ops" }), row("failing")],
    agents: () => {
      if (failing.size) throw new Error("HTTP 500");
      return { agents: [PACKAGE_SOUL, ELSEWHERE_SOUL, { ...PACKAGE_SOUL, name: "twin-a", key: "twin" }, { ...PACKAGE_SOUL, name: "twin-b", key: "twin" },
        // A package soul and a member soul both named ops at one root: the soul page reads a soul by name and root.
        { ...PACKAGE_SOUL, name: "ops", key: "oats.okf/ops" }, { ...MEMBER_SOUL, name: "ops", key: "ops" }],
        catalog: { reason: null, ambiguous: ["amb"] } };
    } });
  const NOT_RECORDED = "This instance does not record the soul it was spawned from.";
  for (const [name, title] of [["bare", NOT_RECORDED], ["nul", NOT_RECORDED], ["nosrc", NOT_RECORDED]]) {
    await u.select(name);
    assert.deepEqual([u.soul().disabled, u.soul().title], [true, title], name);
  }
  assert.deepEqual(u.agentsReads(), [], "an instance that records no soul reads no catalog");
  for (const [name, title] of [["gone", "oats.okf/gone is not among this deployment's souls now."],
    ["twin", "Several souls match twin; open it from the Workspace page."], ["amb", "Several souls match amb; open it from the Workspace page."],
    ["moved", "oats.okf/dev is not among this deployment's souls now."], ["rooted", "oats.okf/dev is not among this deployment's souls now."],
    ["shared", "Another soul in this deployment is also named ops, so the Workspace page cannot open oats.okf/ops."]]) {
    await u.select(name);
    assert.deepEqual([u.soul().disabled, u.soul().title], [true, title], name);
    u.soul().click(); assert.deepEqual(u.views, [], `${name}: a disabled Go to soul opens nothing`);
  }
  failing.add("all");
  await u.select("failing");
  assert.deepEqual([u.soul().disabled, u.soul().title], [true, "Could not read this deployment's souls: HTTP 500."]);
});

test("Go to soul: checking until the catalog answers, and a late answer for an earlier selection never enables the button", async (t) => {
  const reads = [];
  const u = await card(t, { instances: [row("a"), row("b")], agents: () => { const d = deferred(); reads.push(d); return d.promise; } });
  await u.select("a");
  assert.deepEqual([u.soul().disabled, u.soul().title], [true, "Checking this instance's soul…"]);
  await u.select("b");
  assert.equal(reads.length, 2, "a new selection reads again");
  reads[0].resolve({ agents: [PACKAGE_SOUL] }); await tick(); await tick();
  assert.deepEqual([u.soul().disabled, u.soul().title], [true, "Checking this instance's soul…"], "a's late answer is not b's");
  reads[1].resolve({ agents: [], catalog: { reason: null, ambiguous: [] } }); await tick(); await tick();
  assert.deepEqual([u.soul().disabled, u.soul().title], [true, "oats.okf/dev is not among this deployment's souls now."]);
  // A roster refresh reads again; until it answers, the last answer stands (no "Checking…" on every poll).
  await u.poll();
  assert.equal(reads.length, 3);
  assert.deepEqual([u.soul().disabled, u.soul().title], [true, "oats.okf/dev is not among this deployment's souls now."]);
  reads[2].resolve({ agents: [PACKAGE_SOUL] }); await tick(); await tick();
  assert.deepEqual([u.soul().disabled, u.soul().title], [false, "Open oats.okf/dev on the Workspace page"]);
  // An answer after the popover closed changes nothing and reads nothing more.
  await u.select("a"); u.key("Escape");
  reads[3].resolve({ agents: [PACKAGE_SOUL] }); await tick(); await tick();
  assert.equal(u.host.querySelector(".hier-pop"), null); assert.equal(reads.length, 4);
});

test("Go to soul in a view of two deployments: the primary deployment's row goes, another deployment's row says why and reads nothing", async (t) => {
  const deployments = [
    { id: "/team", machine: "", path: "/team", label: "~/team", local: true, reachable: true, identityFrom: "reported", primary: true },
    { id: "remote:devbox", machine: "devbox", path: "/srv", label: "~/srv", local: false, reachable: true, identityFrom: "reported", primary: false },
  ];
  const u = await card(t, { deployments, instances: [row("here", { deployment: { id: "/team", path: "/team" } }),
    row("there", { deployment: { id: "remote:devbox", machine: "devbox", path: "/srv" }, server: "devbox", addressable: true,
      agentsRoot: "/srv/agents", home: "/srv/agents/dev-pkg/instances/there" })] });
  await u.select("here");
  assert.equal(u.soul().disabled, false);
  assert.deepEqual(u.agentsReads(), ["/api/agents?ws=%2Fteam"]);
  await u.select("there");
  assert.equal(u.soul().disabled, true);
  assert.equal(u.soul().title, "This instance is on devbox · ~/srv; the Workspace page shows only the souls of This Mac · ~/team.");
  assert.deepEqual(u.agentsReads(), ["/api/agents?ws=%2Fteam"], "no catalog read for a deployment the Workspace page cannot show");
});

test("Go to soul reads the catalog's reply as the Workspace page does: a kernel failure is a failed read, a catalog not read yet is still checking", async (t) => {
  let reply = null;
  const u = await card(t, { instances: [row("dev-1")], agents: () => reply });
  const title = async (answer) => { reply = answer; await u.select("dev-1"); return [u.soul().disabled, u.soul().title]; };
  const reason = { code: "E_GIT_TIMEOUT", message: "timed out" };
  // The last good list beside a failure is never proof, and an empty one does not mean the soul is gone.
  assert.deepEqual(await title({ agents: [PACKAGE_SOUL], catalog: { reason, ambiguous: [] } }), [true, "Could not read this deployment's souls. OATS says: timed out"]);
  assert.deepEqual(await title({ agents: [], catalog: { reason, ambiguous: [] } }), [true, "Could not read this deployment's souls. OATS says: timed out"]);
  assert.deepEqual(await title({ agents: [], catalog: { reason: { code: "E_GIT_TIMEOUT" }, ambiguous: [] } }), [true, "Could not read this deployment's souls."]);
  assert.deepEqual(await title({ agents: [], catalog: { reason: { message: "token: abc123" }, ambiguous: [] } }), [true, "Could not read this deployment's souls: [withheld]."]);
  // Still being read: an observed catalog's first read, and a deployment whose catalog is not observed yet.
  assert.deepEqual(await title({ agents: [], refreshing: true, observedAt: null, catalog: { reason: null, ambiguous: [] } }), [true, "Checking this instance's soul…"]);
  assert.deepEqual(await title({ workspace: { id: "/team", name: "Team" }, agents: [], observedAt: null, refreshing: false }), [true, "Checking this instance's soul…"]);
  // A read that listed nothing is an answer.
  assert.deepEqual(await title({ agents: [], refreshing: false, catalog: { reason: null, ambiguous: [] } }), [true, "oats.okf/dev is not among this deployment's souls now."]);
  assert.deepEqual(await title({ agents: [PACKAGE_SOUL], refreshing: true, catalog: { reason: null, ambiguous: [] } }), [false, "Open oats.okf/dev on the Workspace page"]);
});

test("Go to soul: a press whose row no longer resolves to the same soul when the Workspace page's module arrives hands nothing over", async (t) => {
  let replaced = false;
  const listeners = new Set();
  // The shell's held set (#1247) redraws the canvas at once, without a roster read: here it carries the row's new soul.
  const u = await card(t, { instances: [row("dev-1")], ctx: {
    retiringRows: (rows) => rows.map((r) => replaced ? { ...r, soulKey: "oats.okf/replacement" } : r),
    subscribeRetires: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } } });
  await u.select("dev-1");
  assert.equal(u.soul().disabled, false);
  const pop = u.host.querySelector(".hier-pop");
  u.soul().click(); // the module import is in flight
  replaced = true; for (const fn of listeners) fn();
  assert.equal(u.host.querySelector(".hier-pop"), pop, "the same popover, for the same home");
  await tick(); await tick();
  assert.deepEqual(u.views, [], "the old soul is not opened, and the Workspace page is not shown");
  assert.deepEqual([u.soul().disabled, u.soul().title], [true, "oats.okf/replacement is not among this deployment's souls now."]);
});

test("why a shared name fails closed: the soul page's inspection admits a soul by bare name and root only when no other soul of the root shares it", async () => {
  const { capabilityAdmission } = await import("../../client/inspect-boundary.mjs");
  const context = (agents) => ({ workspace: { id: "/team", scope: "/team", name: "Team" }, cli: { ok: true, operationsApi: 2 }, agents });
  // What the Workspace page's soul page sends for the soul Go to soul opened (spawn.mjs inspectSoul).
  const request = { action: "inspect", selector: { soul: "dev", agentsRoot: "/team/agents" } };
  assert.equal(capabilityAdmission(request, context([PACKAGE_SOUL, ELSEWHERE_SOUL])).soul, "dev", "unique at its root: admitted");
  assert.throws(() => capabilityAdmission(request, context([PACKAGE_SOUL, MEMBER_SOUL])), /Select one soul and its agents root/);
});
