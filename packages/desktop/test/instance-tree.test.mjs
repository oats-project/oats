import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { collapseKey, hasInstanceChildren, instanceRepoLabel, filterInstanceTree, instanceMatchesFilter, instanceVisibleInTree, clusterInstances,
  ROSTER_SORTS, rosterRank, groupRosterFamilies, rosterGroupKey } from "../../client/instance-tree.mjs";
import { treeGuideSegments, captureTreeRenderState, clusterSeparator, treeConnectors, rosterResponseOwns } from "../renderer/instance-tree-view.mjs";
import { RELATED_WORK_FEATURE } from "../../client/related-work.mjs";

/** Rows of a host that declares instance-related-work, each reporting related work (to its parent, or to the
 * sibling its siblingInstance names): every line is drawn, as every unflagged row drew before related work. */
const related = (rows) => rows.map((row) => ({ ...row, relatedWorkKnown: RELATED_WORK_FEATURE, relatedWork: true }));

const instances = [
  { instance: "root" },
  { instance: "child", parentInstance: "root" },
  { instance: "grand", parentInstance: "child" },
  { instance: "sibling", parentInstance: "root" },
  { instance: "other" },
];

test("instance tree collapse hides arbitrary-depth descendants but not peers", () => {
  const collapsed = new Set([collapseKey("wsA", "child")]);
  const visible = (name, ws = "wsA", filtering = false) => instanceVisibleInTree(
    instances.find((i) => i.instance === name), instances, collapsed, ws, filtering,
  );
  assert.equal(visible("root"), true);
  assert.equal(visible("child"), true, "collapsed parent itself stays visible");
  assert.equal(visible("grand"), false);
  assert.equal(visible("sibling"), true);
  assert.equal(visible("other"), true);
  assert.equal(visible("grand", "wsB"), true, "collapse state is workspace-scoped");
  assert.equal(visible("grand", "wsA", true), true, "filtering reveals matching descendants without changing state");
});

test("tree guides terminate final siblings and continue only real ancestor branches", () => {
  const flat = related([
    { instance: "root", depth: 0 },
    { instance: "child-a", parentInstance: "root", depth: 1 },
    { instance: "grand", parentInstance: "child-a", depth: 2 },
    { instance: "child-b", parentInstance: "root", depth: 1 },
  ]);
  assert.deepEqual(treeGuideSegments(flat, flat[1]), ["branch"], "non-final child continues below its elbow");
  assert.deepEqual(treeGuideSegments(flat, flat[2]), ["continue", "end"],
    "grandchild keeps a real ancestor continuation and ends its own branch");
  assert.deepEqual(treeGuideSegments(flat, flat[3]), ["end"], "last child line stops at its elbow");

  const onlyBranch = flat.slice(0, 3);
  assert.deepEqual(treeGuideSegments(onlyBranch, onlyBranch[2]), ["none", "end"],
    "descendants do not extend an exhausted parent sibling line");
  // No flag, no line: the same rows unflagged draw no segment of their own.
  const plain = flat.map(({ relatedWork: _flag, ...row }) => row);
  assert.deepEqual(plain.slice(1).map((row) => treeGuideSegments(plain, row)), [["none"], ["none", "none"], ["none"]]);
});

test("instance repo label prefers roster name and falls back to path basename", () => {
  assert.equal(instanceRepoLabel({ repoName: "oats", repo: "/tmp/ignored" }), "oats");
  assert.equal(instanceRepoLabel({ repo: "/work/projects/desktop-app" }), "desktop-app");
  assert.equal(instanceRepoLabel({ workspace: "/work/team" }), "team");
  assert.equal(instanceRepoLabel({}), "workspace");
});

test("instance tree detects disclosure parents and survives malformed cycles", () => {
  assert.equal(hasInstanceChildren(instances, "root"), true);
  assert.equal(hasInstanceChildren(instances, "grand"), false);
  const cyclic = [
    { instance: "a", parentInstance: "b" },
    { instance: "b", parentInstance: "a" },
  ];
  assert.equal(instanceVisibleInTree(cyclic[0], cyclic, new Set(), "ws"), true);
  assert.equal(instanceVisibleInTree(cyclic[0], cyclic, new Set([collapseKey("ws", "b")]), "ws"), false);
});

test("DOM rerender preserves focused disclosure/terminal identity and scroll across toggle and poll", () => {
  const dom = new JSDOM(`<!doctype html><body><div id="list"></div></body>`);
  const list = dom.window.document.getElementById("list");
  Object.defineProperty(list, "scrollTop", { value: 73, writable: true });
  const paint = (control = "disclosure") => {
    list.innerHTML = `<button data-tree-instance="root" data-tree-control="${control}">${control}</button>`;
  };
  paint();
  list.querySelector("button").focus();
  let restore = captureTreeRenderState(list);
  paint(); // disclosure toggle rebuild
  list.scrollTop = 0;
  assert.equal(restore(), true);
  assert.equal(dom.window.document.activeElement.dataset.treeControl, "disclosure");
  assert.equal(list.scrollTop, 73);

  restore = captureTreeRenderState(list);
  paint(); // polling refresh/reorder rebuild
  const replacement = list.querySelector("button");
  const nativeFocus = replacement.focus.bind(replacement);
  let focusOptions;
  replacement.focus = (options) => {
    focusOptions = options;
    nativeFocus(options);
    list.scrollTop = 0; // simulate Chromium scrolling the focused/reordered row
  };
  list.scrollTop = 5;
  assert.equal(restore(), true);
  assert.deepEqual(focusOptions, { preventScroll: true });
  assert.equal(dom.window.document.activeElement.dataset.treeInstance, "root");
  assert.equal(list.scrollTop, 73, "saved scroll is reapplied after focus-induced scrolling");
  dom.window.close();
});

test("filter includes ancestor paths without mutating persisted collapse state", () => {
  assert.deepEqual(filterInstanceTree(instances, "grand").map((i) => i.instance), ["root", "child", "grand"]);
  const collapsed = new Set([collapseKey("ws", "root")]);
  assert.equal(instanceVisibleInTree(instances[2], instances, collapsed, "ws", true), true, "filtering reveals the matching path");
  assert.deepEqual([...collapsed], [collapseKey("ws", "root")], "the user's collapse choice survives the filter");
});

test("the roster filter matches a row's name, soul and repository, and nothing else it carries", () => {
  const row = { instance: "builder-one", agent: "desktop-dev", repoName: "widgets", home: "/w/agents/desktop-dev/instances/builder-one", branch: "topic/polish" };
  for (const query of ["builder", "ONE", "desktop-dev", "  Widgets  "]) assert.equal(instanceMatchesFilter(row, query), true, query);
  for (const query of ["", "   ", null, undefined]) assert.equal(instanceMatchesFilter(row, query), true, "no query matches every row");
  assert.equal(instanceMatchesFilter(row, "polish"), false, "the branch is not searched");
  // No panel row carries a `task`; one given by hand is not searched either.
  const withTask = { ...row, task: "Ship the quarterly report" };
  assert.equal(instanceMatchesFilter(withTask, "quarterly"), false);
  assert.deepEqual(filterInstanceTree([withTask], "quarterly"), []);
  assert.deepEqual(filterInstanceTree([withTask], "widgets"), [withTask]);
});

// Replaces the Redesign v3 group-header test: Workspace v4 marks agent groups
// without a title or collapse control, by a separator: a 14px gap (6px from
// 2026-10-23, 14px again since the product owner's return of 2026-10-26).
test("agent-group separator: a titleless gap that still names the group for assistive technology", () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const gap = clusterSeparator(dom.window.document, { label: "docs-writer-1", count: 2 });
  assert.equal(gap.tagName, "DIV"); assert.equal(gap.getAttribute("role"), "separator");
  assert.equal(gap.getAttribute("aria-label"), "docs-writer-1, 2 instances");
  assert.equal(gap.textContent, "", "no visible title");
  assert.equal(gap.tabIndex, -1, "never a tab stop");
  assert.equal(clusterSeparator(dom.window.document, { label: "independent", count: 1 }).getAttribute("aria-label"), "independent, 1 instance");
  dom.window.close();
});

test("tree connectors start at the dots: a parent stem from its dot, solid elbows to children, dotted links between sibling roots", () => {
  const all = related([{ instance: "a" }, { instance: "a1", parentInstance: "a" }, { instance: "a2", parentInstance: "a" },
    { instance: "a2x", parentInstance: "a2" }, { instance: "b", siblingInstance: "a" }]);
  const items = clusterInstances(all)[0].instances;
  const kinds = Object.fromEntries(items.map((i) => [i.instance, treeConnectors(items, i, all).map((c) => `${c.kind}@${c.level}`)]));
  assert.deepEqual(kinds, {
    a: ["down@0", "link-out@0"],
    a1: ["elbow@0", "line@0", "link-through@0"],
    a2: ["elbow@0", "down@1", "link-through@0"],
    a2x: ["elbow@1", "link-through@0"],
    b: ["link-in@0"],
  });
  const lone = related([{ instance: "solo" }]);
  assert.deepEqual(treeConnectors(lone, lone[0], lone), [], "an independent row draws no connector");
  // No flag, no line: the same tree from a host that reports no related work draws nothing at all.
  const plain = all.map(({ relatedWorkKnown: _gate, relatedWork: _flag, ...row }) => row);
  const plainItems = clusterInstances(plain)[0].instances;
  assert.deepEqual(plainItems.map((i) => treeConnectors(plainItems, i, plain)), plainItems.map(() => []));
});

// #1312: the dotted sibling link and the solid lineage sit on separate columns, so the dotted line
// never borrows the solid one: every row between two sibling roots draws its own link-through.
test("tree connectors: a root's children carry the dotted link through to a later sibling root, whatever their level-0 segment", () => {
  const all = related([{ instance: "a" }, { instance: "a1", parentInstance: "a" }, { instance: "a2", parentInstance: "a" },
    { instance: "b", siblingInstance: "a" }]);
  const items = clusterInstances(all)[0].instances;
  const at = (name) => treeConnectors(items, items.find((i) => i.instance === name), all).map((c) => `${c.kind}@${c.level}`);
  assert.deepEqual(items.map((i) => i.instance), ["a", "a1", "a2", "b"]);
  assert.deepEqual(at("a"), ["down@0", "link-out@0"], "the root's dotted link leaves its dot beside its solid stem");
  assert.deepEqual(at("a1"), ["elbow@0", "line@0", "link-through@0"], "a branch row (level 0 continues) still draws the link");
  assert.deepEqual(at("a2"), ["elbow@0", "link-through@0"], "the last child (level 0 ends) draws link-through, not link-out");
  assert.deepEqual(at("b"), ["link-in@0"]);

  // The parent's vertical is whole through a non-last child's row: a full-height line beside the elbow
  // (the elbow's rounded corner leaves it), never a half-height `down` that left a notch above the corner.
  // The last child's row ends the vertical at its elbow.
  assert.ok(at("a1").includes("line@0") && !at("a1").includes("down@0"), "a branch row's vertical spans the whole row");
  assert.ok(!at("a2").some((c) => c.endsWith("@0") && /^(line|down)@/.test(c)), "the last child's vertical stops at its elbow");

  const parentOnly = related([{ instance: "p" }, { instance: "p1", parentInstance: "p" }, { instance: "p2", parentInstance: "p" }]);
  const lone = clusterInstances(parentOnly)[0].instances;
  assert.deepEqual(lone.map((i) => treeConnectors(lone, i, parentOnly).map((c) => c.kind)),
    [["down"], ["elbow", "line"], ["elbow"]], "a lone root with children draws no dotted link");

  const roots = related([{ instance: "r1" }, { instance: "r2", siblingInstance: "r1" }, { instance: "r3", siblingInstance: "r1" }]);
  const flat = clusterInstances(roots)[0].instances;
  assert.deepEqual(flat.map((i) => treeConnectors(flat, i, roots).map((c) => c.kind)),
    [["link-out"], ["link-in", "link-out"], ["link-in"]], "three sibling roots: one dotted line through every dot");
});

test("first-launch deferred roster owns both completion orders but rejects a true switch", async () => {
  const owns = (current, dispatchGeneration = 1, currentGeneration = 1) => rosterResponseOwns({
    dispatchWorkspace: "", responseWorkspace: "wsA", currentWorkspace: current,
    dispatchGeneration, currentGeneration,
  });
  // Roster resolves first: current selection is still empty and adopts wsA.
  assert.equal(owns(""), true);
  // Hierarchy resolves first: it silently adopted the SAME server workspace.
  await Promise.resolve();
  assert.equal(owns("wsA"), true);
  // A real selection/generation change must still reject the old response.
  assert.equal(owns("wsB"), false);
  assert.equal(owns("wsA", 1, 2), false);
});

test("a stale dispatch selection owns both completion orders like an empty one; a served one does not", () => {
  const owns = (current, { staleDispatch, dispatchGeneration = 1, currentGeneration = 1 }) => rosterResponseOwns({
    dispatchWorkspace: "/gone", responseWorkspace: "wsA", currentWorkspace: current,
    dispatchGeneration, currentGeneration, staleDispatch,
  });
  // Roster resolves first: the stale selection is still current, then adopts wsA.
  assert.equal(owns("/gone", { staleDispatch: true }), true);
  // Hierarchy resolved first and adopted the SAME served workspace.
  assert.equal(owns("wsA", { staleDispatch: true }), true);
  // A served (non-stale) dispatch answered with another workspace is not owned once current moved on.
  assert.equal(owns("wsA", { staleDispatch: false }), false);
  // A real switch or generation change still rejects the stale-dispatch reply.
  assert.equal(owns("wsB", { staleDispatch: true }), false);
  assert.equal(owns("wsA", { staleDispatch: true, currentGeneration: 2 }), false);
});

/* ── agent clusters (feature/agent-relations) ── */

test("clusterInstances: connected components over parent + sibling links; unrelated are single-node clusters", async () => {
  const { clusterInstances, instanceLinks } = await import("../../client/instance-tree.mjs");
  const roster = [
    { instance: "coord-1", running: true },
    { instance: "dev-a", parentInstance: "coord-1", running: true },
    { instance: "dev-b", parentInstance: "coord-1", running: false },
    { instance: "reviewer-1", parentInstance: "dev-a", running: true },
    // sibling-linked pair, no shared parent — still one cluster
    { instance: "peer-1", siblingInstance: "peer-2", relation: "sibling", relativeTo: "peer-2", running: false },
    { instance: "peer-2", running: false },
    // unrelated
    { instance: "loner", running: true },
  ];
  const clusters = clusterInstances(roster);
  const byKey = new Map(clusters.map((c) => [c.key, c.instances.map((i) => i.instance)]));
  assert.equal(clusters.length, 3);
  assert.deepEqual(byKey.get("coord-1"), ["coord-1", "dev-a", "reviewer-1", "dev-b"],
    "cluster keeps parent-first tree order (siblings by name, #1262)");
  assert.deepEqual(new Set(byKey.get("peer-1")), new Set(["peer-1", "peer-2"]),
    "sibling link alone joins a cluster");
  assert.deepEqual(byKey.get("loner"), ["loner"], "unrelated instance is its own cluster");
  // depths: tree depth inside the cluster; sibling-only members at depth 0
  const coord = clusters.find((c) => c.key === "coord-1").instances;
  assert.deepEqual(coord.map((i) => i.depth), [0, 1, 2, 1]);
  const peers = clusters.find((c) => byKey.get(c.key).includes("peer-2")).instances;
  assert.ok(peers.every((i) => i.depth === 0), "sibling-linked peers sit at depth 0");
  // link extractor reads the canonical contract: parentInstance + siblingInstance
  assert.deepEqual(instanceLinks({ instance: "x", parentInstance: "p", siblingInstance: "s" }), ["p", "s"]);
  assert.deepEqual(instanceLinks({ instance: "x", siblingInstance: "x" }), [], "self links dropped");
  assert.deepEqual(instanceLinks({ instance: "x", siblingInstance: "" }), [], "empty links dropped");
});

test("clusterInstances: malformed parent cycles keep every member visible", async () => {
  const { clusterInstances } = await import("../../client/instance-tree.mjs");
  const roster = [
    { instance: "a", parentInstance: "b", running: false },
    { instance: "b", parentInstance: "a", running: false },
  ];
  const clusters = clusterInstances(roster);
  assert.equal(clusters.length, 1);
  assert.deepEqual(new Set(clusters[0].instances.map((i) => i.instance)), new Set(["a", "b"]));
});

test("clusterInstances: edges to instances outside the roster do not join or crash", async () => {
  const { clusterInstances } = await import("../../client/instance-tree.mjs");
  const clusters = clusterInstances([
    { instance: "x", parentInstance: "ghost", siblingInstance: "phantom", running: true },
    { instance: "y", running: true },
  ]);
  assert.equal(clusters.length, 2, "dangling links leave both as single-node clusters");
});

test("clusterInstances: cluster key is deterministic under liveness changes (review f921f7d nit)", async () => {
  const { clusterInstances } = await import("../../client/instance-tree.mjs");
  const pair = (aRunning, bRunning) => [
    { instance: "b-peer", siblingInstance: "a-peer", running: bRunning },
    { instance: "a-peer", running: aRunning },
  ];
  const keyOf = (list) => clusterInstances(list)[0].key;
  assert.equal(keyOf(pair(true, false)), "a-peer");
  assert.equal(keyOf(pair(false, true)), "a-peer",
    "which member is running must not change the visible cluster name");
  // parented cluster: the label is the root, regardless of who is running
  const tree = (rootRunning) => [
    { instance: "z-root", running: rootRunning },
    { instance: "a-child", parentInstance: "z-root", running: !rootRunning },
  ];
  assert.equal(keyOf(tree(true)), "z-root");
  assert.equal(keyOf(tree(false)), "z-root", "root name labels the cluster even when idle");
});

/* ── roster grouping: repo → agent family, sort modes ── */

const roster = [
  { instance: "b-idle", agent: "beta", repoName: "repo1", running: false },
  { instance: "a-run", agent: "beta", repoName: "repo1", running: true },
  { instance: "kid", agent: "beta", repoName: "repo1", parentInstance: "a-run", running: false },
  { instance: "solo", agent: "alpha", repoName: "repo1", running: false },
  { instance: "other", agent: "gamma", repoName: "repo0", running: true },
];

test("groupRosterFamilies groups repo → family alphabetically with lineage order inside", () => {
  const grouped = groupRosterFamilies(roster, "status");
  assert.deepEqual([...grouped.keys()], ["repo0", "repo1"], "repos alphabetical");
  assert.deepEqual([...grouped.get("repo1").keys()], ["alpha", "beta"], "families alphabetical");
  const beta = grouped.get("repo1").get("beta");
  assert.deepEqual(beta.map((i) => i.instance), ["a-run", "kid", "b-idle"],
    "status sort: running root first, child under its parent, idle root last");
  assert.deepEqual(beta.map((i) => i.depth), [0, 1, 0], "depth annotated");
});

test("groupRosterFamilies name sort is alphabetical regardless of running state", () => {
  const beta = groupRosterFamilies(roster, "name").get("repo1").get("beta");
  assert.deepEqual(beta.map((i) => i.instance), ["a-run", "kid", "b-idle"],
    "children still nest under parents");
  const flat = groupRosterFamilies([
    { instance: "z", agent: "f", repoName: "r", running: true },
    { instance: "a", agent: "f", repoName: "r", running: false },
  ], "name").get("r").get("f");
  assert.deepEqual(flat.map((i) => i.instance), ["a", "z"]);
});

test("rosterRank falls back to status for unknown sort ids and ROSTER_SORTS covers both modes", () => {
  assert.deepEqual(ROSTER_SORTS.map((s) => s.id), ["status", "name"]);
  const rank = rosterRank("bogus-persisted-value");
  assert.ok(rank({ instance: "z", running: true }, { instance: "a", running: false }) < 0,
    "unknown id ranks running first (status fallback)");
});

test("groupRosterFamilies cuts cross-family parent links and survives cycles", () => {
  const cross = [
    { instance: "p", agent: "fam1", repoName: "r", running: true },
    { instance: "c", agent: "fam2", repoName: "r", parentInstance: "p", running: true },
    { instance: "x", agent: "loop", repoName: "r", parentInstance: "y", running: false },
    { instance: "y", agent: "loop", repoName: "r", parentInstance: "x", running: false },
  ];
  const grouped = groupRosterFamilies(cross);
  assert.deepEqual(grouped.get("r").get("fam2").map((i) => ({ n: i.instance, d: i.depth })),
    [{ n: "c", d: 0 }], "cross-family child renders as a root of its own family");
  const loop = grouped.get("r").get("loop").map((i) => i.instance).sort();
  assert.deepEqual(loop, ["x", "y"], "malformed cycle members all render exactly once");
});

test("rosterGroupKey is workspace-scoped and repo vs repo+family keys differ", () => {
  assert.notEqual(rosterGroupKey("wsA", "repo"), rosterGroupKey("wsB", "repo"));
  assert.notEqual(rosterGroupKey("ws", "repo"), rosterGroupKey("ws", "repo", "fam"));
});

test("groupRosterFamilies tolerates malformed workspace-controlled metadata (non-string agent/repoName)", () => {
  const grouped = groupRosterFamilies([
    { instance: "ok", agent: "fam", repoName: "r", running: true },
    { instance: "bad-agent", agent: {}, repoName: "r", running: false },
    { instance: "bad-repo", agent: "fam", repoName: { x: 1 }, running: false },
    { instance: "no-agent", repoName: "r", running: false },
  ]);
  const all = [...grouped.values()].flatMap((f) => [...f.values()].flat()).map((i) => i.instance);
  assert.deepEqual(all.sort(), ["bad-agent", "bad-repo", "no-agent", "ok"],
    "every instance renders once; no localeCompare throw blanks the roster");
  assert.ok(grouped.get("r").has("fam"), "well-formed family survives alongside malformed peers");
  assert.ok(grouped.get("r").has("?"), "missing agent coalesces to '?'");
});

test("clusterInstances: duplicate instance NAMES across repos render as distinct nodes (merged-state review f7c5769)", async () => {
  const { clusterInstances, instanceId } = await import("../../client/instance-tree.mjs");
  // two live instances named "dev-1" in different agents roots — bare-name
  // keying would silently drop one of them
  const roster = [
    { instance: "coord-1", agentsRoot: "/ws1/agents", home: "/ws1/agents/coord/instances/coord-1", running: true },
    { instance: "dev-1", agentsRoot: "/ws1/agents", home: "/ws1/agents/dev/instances/dev-1",
      parentInstance: "coord-1", running: true },
    { instance: "dev-1", agentsRoot: "/ws2/agents", home: "/ws2/agents/dev/instances/dev-1", running: false },
  ];
  const clusters = clusterInstances(roster);
  const allNodes = clusters.flatMap((c) => c.instances);
  assert.equal(allNodes.length, 3, "every instance renders — duplicates never hide a live one");
  assert.equal(new Set(allNodes.map(instanceId)).size, 3, "three distinct identities");
  // the parent edge resolves to the SAME-ROOT dev-1 only
  const ws1Cluster = clusters.find((c) => c.instances.some((i) => i.instance === "coord-1"));
  assert.deepEqual(ws1Cluster.instances.map((i) => `${i.instance}@${i.agentsRoot}`),
    ["coord-1@/ws1/agents", "dev-1@/ws1/agents"], "same-root child nests under its parent");
  assert.equal(ws1Cluster.instances[1].depth, 1);
  const ws2 = clusters.find((c) => c.instances.some((i) => i.agentsRoot === "/ws2/agents"));
  assert.equal(ws2.instances.length, 1, "foreign same-named instance stays its own cluster");
  assert.equal(ws2.instances[0].depth, 0);
});

test("clusterInstances: ambiguous cross-root relation names fail safe (no merge, no hidden node)", async () => {
  const { clusterInstances } = await import("../../client/instance-tree.mjs");
  // parent name matches TWO foreign instances and none in the child's root:
  // the edge must resolve to nothing rather than guess
  const roster = [
    { instance: "boss", agentsRoot: "/a/agents", home: "/a/x", running: true },
    { instance: "boss", agentsRoot: "/b/agents", home: "/b/x", running: true },
    { instance: "worker", agentsRoot: "/c/agents", home: "/c/x", parentInstance: "boss", running: true },
  ];
  const clusters = clusterInstances(roster);
  assert.equal(clusters.length, 3, "ambiguous edge creates no cluster merge");
  assert.equal(clusters.flatMap((c) => c.instances).length, 3, "all nodes still render");
  // but a globally-UNIQUE name still resolves cross-root
  const uniq = clusterInstances([
    { instance: "coord", agentsRoot: "/a/agents", home: "/a/c", running: true },
    { instance: "helper", agentsRoot: "/b/agents", home: "/b/h", parentInstance: "coord", running: true },
  ]);
  assert.equal(uniq.length, 1, "unique cross-root parent name still links");
  assert.equal(uniq[0].instances[1].depth, 1);
});

test("instanceId: home wins, agentsRoot+name fallback, bare name last", async () => {
  const { instanceId } = await import("../../client/instance-tree.mjs");
  assert.equal(instanceId({ instance: "a", home: "/h/a", agentsRoot: "/r" }), "/h/a");
  assert.equal(instanceId({ instance: "a", agentsRoot: "/r" }), "/r\u0000a");
  assert.equal(instanceId({ instance: "a" }), "a");
});

test("resolveLinkId (shared resolver contract): same-root first, unique cross-root, ambiguous → null", async () => {
  const { resolveLinkId, instanceId } = await import("../../client/instance-tree.mjs");
  const a1 = { instance: "x", agentsRoot: "/a/agents", home: "/a/x" };
  const b1 = { instance: "x", agentsRoot: "/b/agents", home: "/b/x" };
  const u = { instance: "uniq", agentsRoot: "/b/agents", home: "/b/u" };
  const byName = new Map([["x", [a1, b1]], ["uniq", [u]]]);
  const from = { instance: "child", agentsRoot: "/a/agents", home: "/a/c" };
  assert.equal(resolveLinkId(from, "x", byName), instanceId(a1), "same-root candidate wins over the foreign twin");
  assert.equal(resolveLinkId(from, "uniq", byName), instanceId(u), "globally-unique name resolves cross-root");
  const foreign = { instance: "far", agentsRoot: "/c/agents", home: "/c/f" };
  assert.equal(resolveLinkId(foreign, "x", byName), null, "ambiguous with no same-root candidate → null (fail safe)");
  assert.equal(resolveLinkId(from, "ghost", byName), null, "unknown name → null");
});

/* ── identity propagation past cluster construction (review 46f3fdc) ── */

test("findRosterInstance: exact identity wins; bare duplicate names refuse to guess", async () => {
  const { findRosterInstance } = await import("../../client/instance-tree.mjs");
  const roster = [
    { instance: "dev-1", agentsRoot: "/ws1/agents", home: "/ws1/h", tmux: { session: "s1", window: "dev-1" } },
    { instance: "dev-1", agentsRoot: "/ws2/agents", home: "/ws2/h", tmux: { session: "s2", window: "dev-1" } },
    { instance: "solo", agentsRoot: "/ws1/agents", home: "/ws1/s" },
  ];
  // each duplicate row's reference resolves to ITS OWN instance (its own tmux target)
  const first = findRosterInstance(roster, { instance: "dev-1", home: "/ws1/h", agentsRoot: "/ws1/agents" });
  const second = findRosterInstance(roster, { instance: "dev-1", home: "/ws2/h", agentsRoot: "/ws2/agents" });
  assert.equal(first.tmux.session, "s1", "first duplicate opens the first root's tmux session");
  assert.equal(second.tmux.session, "s2", "second duplicate opens the SECOND root's tmux session, never the first name match");
  // agentsRoot alone (no home) still disambiguates
  assert.equal(findRosterInstance(roster, { instance: "dev-1", agentsRoot: "/ws2/agents" }).tmux.session, "s2");
  // bare names: unique resolves, duplicate refuses (null), unknown null
  assert.equal(findRosterInstance(roster, "solo").instance, "solo");
  assert.equal(findRosterInstance(roster, "dev-1"), null, "ambiguous bare name never returns the first match");
  assert.equal(findRosterInstance(roster, "ghost"), null);
});

test("terminalKey: same-named instances from different roots are DIFFERENT terminals", async () => {
  const { terminalKey } = await import("../renderer/instance-tree-view.mjs");
  const a = { instance: "dev-1", home: "/ws1/h", agentsRoot: "/ws1/agents" };
  const b = { instance: "dev-1", home: "/ws2/h", agentsRoot: "/ws2/agents" };
  assert.notEqual(terminalKey("w", a), terminalKey("w", b), "duplicate names dedupe separately");
  assert.equal(terminalKey("w", a), terminalKey("w", a), "same identity dedupes together");
  assert.notEqual(terminalKey("w1", a), terminalKey("w2", a), "still workspace-scoped");
  assert.equal(terminalKey("w", "legacy-name"), "term:w:legacy-name", "bare-name callers keep their key shape");
});

test("collapse state keys by identity: collapsing one duplicate never hides the other's subtree", async () => {
  const m = { ...await import("../../client/instance-tree.mjs"), ...await import("../renderer/instance-tree-view.mjs") };
  const roster = [
    { instance: "coord", agentsRoot: "/ws1/agents", home: "/ws1/c" },
    { instance: "kid", agentsRoot: "/ws1/agents", home: "/ws1/k", parentInstance: "coord" },
    { instance: "coord", agentsRoot: "/ws2/agents", home: "/ws2/c" },
    { instance: "kid2", agentsRoot: "/ws2/agents", home: "/ws2/k2", parentInstance: "coord" },
  ];
  // collapse ONLY the /ws1 coord (by its identity)
  const collapsed = new Set([m.collapseKey("w", m.instanceId(roster[0]))]);
  const vis = (i) => m.instanceVisibleInTree(i, roster, collapsed, "w");
  assert.equal(vis(roster[1]), false, "ws1 kid hidden under its collapsed parent");
  assert.equal(vis(roster[3]), true, "ws2 kid STAYS VISIBLE — the other root's same-named parent is not collapsed");
  assert.equal(vis(roster[2]), true, "the ws2 parent itself stays visible");
});

test("instanceVisibleInTree with sections: a collapse hides only rows of its own section (#551's symptom); without them, unchanged", async () => {
  const m = { ...await import("../../client/instance-tree.mjs"), ...await import("../renderer/instance-tree-view.mjs") };
  // /d2's own lead is gone: kid2's parent name resolves cross-root to /d1's lead, painted in /d1's section.
  const lead = { instance: "lead", agentsRoot: "/d1/agents", home: "/d1/lead" };
  const kid = { instance: "kid", agentsRoot: "/d1/agents", home: "/d1/kid", parentInstance: "lead" };
  const kid2 = { instance: "kid2", agentsRoot: "/d2/agents", home: "/d2/kid2", parentInstance: "lead" };
  const grand2 = { instance: "grand2", agentsRoot: "/d2/agents", home: "/d2/grand2", parentInstance: "kid2" };
  const roster = [lead, kid, kid2, grand2], section = r => r.agentsRoot;
  const vis = (i, collapsedRows, opts) => m.instanceVisibleInTree(i, roster, new Set(collapsedRows.map(r => m.collapseKey("w", m.instanceId(r)))), "w", false, opts);
  assert.equal(vis(kid2, [lead]), false, "without sections: the cross-root collapse hides it, as before");
  assert.equal(vis(grand2, [lead]), false);
  assert.equal(vis(kid2, [lead], { section }), true, "with sections: /d1's collapse does not hide /d2's child");
  assert.equal(vis(grand2, [lead], { section }), true, "nor its subtree");
  assert.equal(vis(kid, [lead], { section }), false, "a same-section collapse still hides");
  assert.equal(vis(grand2, [kid2], { section }), false, "including within /d2");
  assert.equal(vis(kid2, [lead], { section: () => null }), false, "one section for all: unchanged");
});

test("distinguishingRootTags: colliding single-segment tags grow to a unique suffix (review cbd5bb3)", async () => {
  const { distinguishingRootTags } = await import("../../client/instance-tree.mjs");
  // the naive one-segment tag would be "project" for BOTH
  const tags = distinguishingRootTags(["/a/project/agents", "/b/project/agents"]);
  assert.notEqual(tags.get("/a/project/agents"), tags.get("/b/project/agents"),
    "duplicate option labels actually differ");
  assert.match(tags.get("/a/project/agents"), /a\/project/, "suffix grows until distinguishing");
  // non-colliding roots keep the short tag
  const short = distinguishingRootTags(["/x/alpha/agents", "/y/beta/agents"]);
  assert.equal(short.get("/x/alpha/agents"), "alpha");
  assert.equal(short.get("/y/beta/agents"), "beta");
  // identical roots (same instance listed once per name) fall back to the full root
  const same = distinguishingRootTags(["/only/one/agents"]);
  assert.equal(same.get("/only/one/agents"), "one");
});

test("hasInstanceChildren by identity: a childless duplicate-name parent gets NO disclosure (review 7d740f9)", async () => {
  const m = { ...await import("../../client/instance-tree.mjs"), ...await import("../renderer/instance-tree-view.mjs") };
  const roster = [
    { instance: "coord", agentsRoot: "/ws1/agents", home: "/ws1/c" },                       // has a child
    { instance: "kid", agentsRoot: "/ws1/agents", home: "/ws1/k", parentInstance: "coord" },
    { instance: "coord", agentsRoot: "/ws2/agents", home: "/ws2/c" },                       // childless twin
  ];
  assert.equal(m.hasInstanceChildren(roster, roster[0]), true, "the real parent discloses");
  assert.equal(m.hasInstanceChildren(roster, roster[2]), false,
    "the childless same-named twin gets no disclosure control");
  // legacy bare-name shape still works for identity-less rosters
  assert.equal(m.hasInstanceChildren([{ instance: "a", parentInstance: "p" }], "p"), true);
  assert.equal(m.hasInstanceChildren([{ instance: "a", parentInstance: "p" }], "a"), false);
});

test("resolveTerminalOpen, A4: a row on a session provider resolves to no terminal, before any key exists, with the shared sentence; a restore leaves it out", async () => {
  const m = { ...await import("../../client/instance-tree.mjs"), ...await import("../renderer/instance-tree-view.mjs") };
  const { openAct } = await import("../../client/instance-acts.mjs");
  const a = { instance: "a", agentsRoot: "/ws1/agents", home: "/ws1/a", running: true, backend: "bb", tmux: null };
  const roster = [a, { instance: "b", agentsRoot: "/ws1/agents", home: "/ws1/b", running: true, tmux: { session: "s1" } }];
  for (const ref of ["a", { instance: "a", home: "/ws1/a", agentsRoot: "/ws1/agents" }]) {
    const r = m.resolveTerminalOpen(roster, ref, "w");
    assert.deepEqual(r, { error: "no-terminal", name: "a", row: a, sentence: openAct(a).reason.sentence });
    assert.equal(r.sentence, "Runs in a bb thread; open it in bb.");
  }
  // Whatever its state, and when the kernel holds it (its own reason is the row's; the open still has no terminal).
  for (const extra of [{ running: false }, { running: null }, { running: true, rollbackIncomplete: true }]) {
    const r = m.resolveTerminalOpen([{ ...a, ...extra }], "a", "w");
    assert.equal(r.error, "no-terminal", JSON.stringify(extra)); assert.equal(r.key, undefined); assert.ok(r.sentence);
  }
  // The tmux row beside it, and a row that names tmux, resolve as they always did.
  assert.equal(m.resolveTerminalOpen(roster, "b", "w").error, undefined);
  assert.equal(m.resolveTerminalOpen([{ ...a, backend: "tmux" }], "a", "w").inst.instance, "a");
  // The shell's restore of a handed layout (restoreHandedLayout) leaves out every reference that resolves with an
  // error, and says nothing: a remembered terminal of 'a' is one.
  const shell = (await import("node:fs")).readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
  assert.match(shell, /const r = resolveTerminalOpen\(panel\.instances \|\| \[\], ref, ws\);\n    if \(r\.error\) continue;/);
});

test("resolveTerminalOpen: string and object refs of one identity mint ONE key; ambiguity refuses before any key exists (review 7d740f9)", async () => {
  const m = { ...await import("../../client/instance-tree.mjs"), ...await import("../renderer/instance-tree-view.mjs") };
  const uniqueRoster = [
    { instance: "dev-1", agentsRoot: "/ws1/agents", home: "/ws1/h", running: true, tmux: { session: "s1" } },
    { instance: "solo", agentsRoot: "/ws1/agents", home: "/ws1/s", running: true },
  ];
  // string-vs-object opens of the SAME identity dedupe to one tab key
  const byName = m.resolveTerminalOpen(uniqueRoster, "dev-1", "w");
  const byObject = m.resolveTerminalOpen(uniqueRoster, { instance: "dev-1", home: "/ws1/h", agentsRoot: "/ws1/agents" }, "w");
  assert.ok(!byName.error && !byObject.error);
  assert.equal(byName.key, byObject.key, "palette (bare name) and sidebar (object) share ONE tab for one identity");
  assert.equal(byName.inst.home, "/ws1/h", "both resolve to the canonical roster instance");
  // the name later becomes AMBIGUOUS: resolution refuses BEFORE any key can
  // match a stale bare-name tab — no wrong-session activation path
  const shadowedRoster = [...uniqueRoster,
    { instance: "dev-1", agentsRoot: "/ws2/agents", home: "/ws2/h", running: true, tmux: { session: "s2" } }];
  const nowAmbiguous = m.resolveTerminalOpen(shadowedRoster, "dev-1", "w");
  assert.equal(nowAmbiguous.error, "ambiguous", "previously unique bare name refuses once shadowed");
  assert.equal(nowAmbiguous.key, undefined, "no key minted — stale-tab dedup can never activate on ambiguity");
  // exact refs still resolve under shadowing, each to its own key
  const a = m.resolveTerminalOpen(shadowedRoster, { instance: "dev-1", home: "/ws1/h", agentsRoot: "/ws1/agents" }, "w");
  const b = m.resolveTerminalOpen(shadowedRoster, { instance: "dev-1", home: "/ws2/h", agentsRoot: "/ws2/agents" }, "w");
  assert.ok(!a.error && !b.error);
  assert.notEqual(a.key, b.key, "exact refs keep distinct terminals under shadowing");
});

test("resolveLinkId: intra-root duplicate names are inherently ambiguous — no first-candidate edge (merged-state review @7dd1e7b)", async () => {
  const m = { ...await import("../../client/instance-tree.mjs"), ...await import("../renderer/instance-tree-view.mjs") };
  const from = { instance: "child-1", agentsRoot: "/ws/agents", home: "/ws/agents/c/instances/child-1" };
  const dupA = { instance: "coord", agentsRoot: "/ws/agents", home: "/ws/agents/coord/instances/coord" };
  const dupB = { instance: "coord", agentsRoot: "/ws/agents", home: "/ws/agents/local~coord/instances/coord" };
  const byName = new Map([["coord", [dupA, dupB]]]);
  assert.equal(m.resolveLinkId(from, "coord", byName), null,
    "two same-root candidates: kernel classifies the name inherently ambiguous — resolve to nothing, never a false edge");
  // exactly one same-root candidate among cross-root noise still resolves
  const other = { instance: "coord", agentsRoot: "/elsewhere/agents", home: "/elsewhere/agents/coord/instances/coord" };
  const byName2 = new Map([["coord", [dupA, other]]]);
  assert.equal(m.resolveLinkId(from, "coord", byName2), m.instanceId(dupA), "single same-root candidate wins over cross-root");
  // and clustering treats the intra-root-duplicate parent edge as absent:
  // the child is NOT merged into either duplicate's cluster
  const child = { ...from, parentInstance: "coord" };
  const clusters = m.clusterInstances([child, dupA, dupB]);
  const childCluster = clusters.find((c) => c.instances.some((i) => i.instance === "child-1"));
  assert.equal(childCluster.instances.length, 1, "ambiguous edge ignored — child stays a single-node cluster");
});

test("filterInstanceTree: identity-aware — same-named twins don't leak into each other's filters; ambiguous ancestors include nothing (merged-state review @3e76616)", async () => {
  const m = { ...await import("../../client/instance-tree.mjs"), ...await import("../renderer/instance-tree-view.mjs") };
  const parentA = { instance: "coord", agentsRoot: "/A/agents", home: "/A/agents/c/instances/coord" };
  const parentB = { instance: "coord", agentsRoot: "/B/agents", home: "/B/agents/c/instances/coord" };
  const childA = { instance: "dev-child", agentsRoot: "/A/agents", home: "/A/agents/d/instances/dev-child", parentInstance: "coord" };
  const roster = [parentA, parentB, childA];
  // childA matches; its ancestor "coord" is AMBIGUOUS (two candidates, one
  // per root but resolution is same-root-first): only /A's coord is included
  const out = m.filterInstanceTree(roster, "dev-child");
  assert.deepEqual(out.map((i) => i.home), [parentA.home, childA.home],
    "ancestor resolves via resolveLinkId to the SAME-ROOT parent only — the /B twin never leaks in");
  // intra-root duplicate ancestors: inherently ambiguous → no ancestor included
  const dupA = { instance: "coord", agentsRoot: "/A/agents", home: "/A/agents/c2/instances/coord" };
  const out2 = m.filterInstanceTree([parentA, dupA, childA], "dev-child");
  assert.deepEqual(out2.map((i) => i.home), [childA.home],
    "ambiguous parent edge includes NO ancestor — never an arbitrary same-named pick");
  // inclusion keys by identity: filtering for the /A parent's repo does not
  // drag in the /B twin
  const out3 = m.filterInstanceTree(roster, "coord");
  assert.equal(out3.length, 2, "both name matches included (each on its own identity)");
});

test("visibleClusters: clusters computed on the FULL roster, projected to visible — filtering never forges an edge from a globally ambiguous name (merged-state review @3e76616)", async () => {
  const m = { ...await import("../../client/instance-tree.mjs"), ...await import("../renderer/instance-tree-view.mjs") };
  const dupA = { instance: "coord", agentsRoot: "/A/agents", home: "/A/c1/coord" };
  const dupB = { instance: "coord", agentsRoot: "/A/agents", home: "/A/c2/coord" };
  const child = { instance: "dev-child", agentsRoot: "/A/agents", home: "/A/d/dev-child", parentInstance: "coord" };
  const full = [dupA, dupB, child];
  // full-roster resolution: the parent edge is ambiguous → child is a
  // single-node cluster. If clusters were computed on the FILTERED subset
  // [dupA, child], the name would become unique and forge a false edge.
  const projected = m.visibleClusters(full, [dupA, child]);
  const childCluster = projected.find((c) => c.instances.some((i) => i.instance === "dev-child"));
  assert.equal(childCluster.instances.length, 1,
    "ambiguity judged on the FULL roster — hiding one duplicate cannot re-link the child");
  // clusters with no visible member disappear; visible members keep depth
  const parent = { instance: "solo-parent", agentsRoot: "/A/agents", home: "/A/p/solo-parent" };
  const kid = { instance: "kid", agentsRoot: "/A/agents", home: "/A/k/kid", parentInstance: "solo-parent" };
  const projected2 = m.visibleClusters([parent, kid, dupA], [kid]);
  assert.equal(projected2.length, 1, "cluster with no visible members dropped");
  assert.equal(projected2[0].instances[0].instance, "kid");
  assert.equal(projected2[0].instances[0].depth, 1, "depth from the FULL-roster tree is preserved");
});

test("rosterParentId: ArrowLeft parent focus is identity-aware — composite row ids resolve, duplicate parents refuse (review 96b037b)", async () => {
  const m = { ...await import("../../client/instance-tree.mjs"), ...await import("../renderer/instance-tree-view.mjs") };
  const parentA = { instance: "coord", agentsRoot: "/A/agents", home: "/A/agents/c/instances/coord" };
  const parentB = { instance: "coord", agentsRoot: "/B/agents", home: "/B/agents/c/instances/coord" };
  const child = { instance: "kid", agentsRoot: "/A/agents", home: "/A/agents/k/instances/kid", parentInstance: "coord" };
  // rows carry instanceId (home when present) — the pre-fix bare-name lookup
  // (i.instance === id) never matched an identity-bearing row: ArrowLeft dead
  const roster1 = [parentA, child];
  assert.equal(m.rosterParentId(roster1, m.instanceId(child)), m.instanceId(parentA),
    "composite row id finds its row and resolves the unique parent");
  assert.equal(m.rosterParentId(roster1, child.instance), null,
    "a bare name is NOT a row id when the row has identity — no accidental match");
  // duplicate parent names across roots: same-root candidate wins exactly
  const roster2 = [parentA, parentB, child];
  assert.equal(m.rosterParentId(roster2, m.instanceId(child)), m.instanceId(parentA),
    "same-root parent wins over the cross-root twin — focus can never land on /B's coord");
  // intra-root duplicates: inherently ambiguous — no focus jump at all
  const dupA2 = { instance: "coord", agentsRoot: "/A/agents", home: "/A/agents/c2/instances/coord" };
  assert.equal(m.rosterParentId([parentA, dupA2, child], m.instanceId(child)), null,
    "ambiguous parent -> null: ArrowLeft is a no-op, never an arbitrary pick");
  // parentless / unknown rows
  assert.equal(m.rosterParentId(roster1, m.instanceId(parentA)), null, "root row has no parent");
  assert.equal(m.rosterParentId(roster1, "ghost"), null, "unknown id is a no-op");
});
