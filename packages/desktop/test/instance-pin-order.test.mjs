// Pinned instances (feature instance-pin; Pepe, 2026-11-19), the shared order every client of the roster draws:
// pinned first at every level, ahead of the roster's order (spawn time, newest first; then unknown times; then
// name, then instanceId). A node ranks pinned when it or a descendant in its tree is pinned, so a pinned child
// lifts its whole group and the path down to it. Read only as exactly `true`, and only where the CLI lists the
// feature (`pins`). The same order in the sidebar's sections, the Background section and the palette's
// never-focused rows; a filter never reorders.
import test from "node:test";
import assert from "node:assert/strict";
import { clusterInstances, rosterGroups, instanceSiblings, instanceId, filterInstanceTree, backgroundPlacement, rowPinned, PIN_FEATURE } from "../../client/instance-tree.mjs";
import { rosterSections, sidebarSections } from "../../client/roster-sections.mjs";
import { DESKTOP_TERMS } from "../renderer/desktop-terms.mjs";
import { deploymentStatusData } from "../../client/deployment-data.mjs";
import { panelInstance } from "../../client/deployment-panel.mjs";
import { projectActivePanel, activeSignature } from "../renderer/active-observation.mjs";
import { remotePanel } from "../../client/remote-roster.mjs";

const at = (instance, created, extra = {}) => ({ instance, agent: "dev", home: `/w/${instance}`, agentsRoot: "/w",
  running: true, ...(created ? { createdAt: `2026-11-${String(created).padStart(2, "0")}T10:00:00.000Z` } : {}), ...extra });
const PIN = { pinned: true };
const ON = { pins: true };
/** Each cluster's rows in drawn order, with their depths. */
const drawn = clusters => clusters.flatMap(c => c.instances.map(i => `${i.instance}@${i.depth}`));
const groupsDrawn = groups => groups.map(g => [g.label, drawn(g.clusters)]);

test("the feature's name is the kernel's", () => {
  assert.equal(PIN_FEATURE, "instance-pin");
});

test("a. roots A (newer), B (older, pinned): B, then A", () => {
  const roster = [at("a", 10), at("b", 5, PIN)];
  assert.deepEqual(drawn(clusterInstances(roster, ON)), ["b@0", "a@0"]);
  assert.deepEqual(drawn(clusterInstances([...roster].reverse(), ON)), ["b@0", "a@0"], "whatever the input order");
  assert.deepEqual(drawn(clusterInstances(roster)), ["a@0", "b@0"], "without the feature, the roster's order");
});

test("b. root R (older) with child C (pinned), root S (newer): R's cluster first, and C first among R's children", () => {
  const roster = [
    at("r", 1),
    at("c-old", 2, { parentInstance: "r", ...PIN }),
    at("c-new", 3, { parentInstance: "r" }),
    at("s", 9),
  ];
  assert.deepEqual(drawn(clusterInstances(roster, ON)), ["r@0", "c-old@1", "c-new@1", "s@0"]);
  assert.deepEqual(drawn(clusterInstances(roster)), ["s@0", "r@0", "c-new@1", "c-old@1"], "without the feature");
});

test("b. the path down to a pinned grandchild rises among its siblings at each level; its own subtree keeps the roster's order", () => {
  const roster = [
    at("root", 1),
    at("mid-old", 2, { parentInstance: "root" }),
    at("mid-new", 3, { parentInstance: "root" }),
    at("leaf-old", 4, { parentInstance: "mid-old", ...PIN }),
    at("leaf-new", 5, { parentInstance: "mid-old" }),
    at("under-leaf-a", 6, { parentInstance: "leaf-old" }),
    at("under-leaf-b", 7, { parentInstance: "leaf-old" }),
  ];
  assert.deepEqual(drawn(clusterInstances(roster, ON)),
    ["root@0", "mid-old@1", "leaf-old@2", "under-leaf-b@3", "under-leaf-a@3", "leaf-new@2", "mid-new@1"]);
});

test("under one parent, the children that draw their parent line stay first; the pin decides within each part", () => {
  const roster = [
    at("p", 1),
    at("drawn-a", 2, { parentInstance: "p", sameWork: true, sameWorkKnown: true }),
    at("drawn-b", 3, { parentInstance: "p", sameWork: true, sameWorkKnown: true }),
    at("plain-pinned", 4, { parentInstance: "p", sameWorkKnown: true, ...PIN }),
    at("plain", 5, { parentInstance: "p", sameWorkKnown: true }),
  ];
  // drawingFirst is structural: the flagged children first, then the others; the pin ranks within each part.
  const pinnedFlagged = roster.map(r => r.instance === "drawn-a" ? { ...r, ...PIN } : r);
  assert.deepEqual(drawn(clusterInstances(pinnedFlagged, ON)), ["p@0", "drawn-a@1", "drawn-b@1", "plain-pinned@1", "plain@1"]);
});

test("c. two pinned roots by spawn time, newest first; an unpinned root with no time after every unpinned root with one", () => {
  const roster = [at("old-pin", 1, PIN), at("new-pin", 8, PIN), at("timed-old", 2), at("timeless"), at("timed-new", 7)];
  assert.deepEqual(drawn(clusterInstances(roster, ON)), ["new-pin@0", "old-pin@0", "timed-new@0", "timed-old@0", "timeless@0"]);
});

test("d. only exactly true pins, and only with the feature", () => {
  for (const value of ["true", 1, "yes", {}, false, null]) {
    const roster = [at("a", 10), at("b", 5, { pinned: value })];
    assert.deepEqual(drawn(clusterInstances(roster, ON)), ["a@0", "b@0"], JSON.stringify(value));
  }
  const roster = [at("a", 10), at("b", 5, PIN)];
  for (const pins of [false, undefined, "true", 1]) assert.deepEqual(drawn(clusterInstances(roster, { pins })), ["a@0", "b@0"], `pins: ${pins}`);
  assert.equal(rowPinned(roster[1], true), true);
  assert.equal(rowPinned(roster[1], false), false);
  assert.equal(rowPinned({ pinned: "true" }, true), false);
  assert.equal(rowPinned(null, true), false);
});

test("e. a pinned single cluster leads the independent run: rosterGroups gives its group first", () => {
  const roster = [
    at("lead", 9), at("child", 9, { parentInstance: "lead" }),
    at("solo-new", 8), at("solo-pin", 1, PIN), at("solo-old", 2),
  ];
  const all = rosterGroups(roster, roster, ON);
  assert.deepEqual(groupsDrawn(all), [["independent", ["solo-pin@0"]], ["lead", ["lead@0", "child@1"]], ["independent", ["solo-new@0", "solo-old@0"]]]);
  assert.equal(all[0].key, `independent:${instanceId(roster[3])}`, "the run's key is its first member's, as any run's");
  assert.deepEqual(groupsDrawn(rosterGroups(roster, roster)), [["lead", ["lead@0", "child@1"]], ["independent", ["solo-new@0", "solo-old@0", "solo-pin@0"]]]);
  // Two pinned singles: one leading run, in the roster's order.
  const two = roster.map(r => r.instance === "solo-old" ? { ...r, ...PIN } : r);
  assert.deepEqual(groupsDrawn(rosterGroups(two, two, ON)), [["independent", ["solo-old@0", "solo-pin@0"]], ["lead", ["lead@0", "child@1"]], ["independent", ["solo-new@0"]]]);
});

test("f. a cycle with a pinned member ends and lists every member once", () => {
  const roster = [
    at("x", 1, { parentInstance: "z" }),
    at("y", 2, { parentInstance: "x", ...PIN }),
    at("z", 3, { parentInstance: "y" }),
    at("free", 9),
  ];
  const clusters = clusterInstances(roster, ON);
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters[0].instances.map(i => i.instance).sort(), ["x", "y", "z"], "the cycle's cluster, pinned, first");
  assert.deepEqual(drawn(clusters.slice(1)), ["free@0"]);
  // A self-cycle and a two-cycle, each pinned: each ends.
  const tight = [at("p", 1, { parentInstance: "q", ...PIN }), at("q", 2, { parentInstance: "p" }), at("s", 3, { parentInstance: "s", ...PIN })];
  assert.deepEqual(clusterInstances(tight, ON).flatMap(c => c.instances.map(i => i.instance)).sort(), ["p", "q", "s"]);
});

test("a cluster ranks pinned when any member is pinned, a sibling-linked member included", () => {
  const roster = [at("new", 9), at("anchor", 1), at("linked", 2, { siblingInstance: "anchor", ...PIN })];
  assert.deepEqual(drawn(clusterInstances(roster, ON)), ["linked@0", "anchor@0", "new@0"]);
});

test("instanceSiblings: a pinned sibling first, by its own pin", () => {
  const roster = [at("hub", 1), at("s-new", 9, { siblingInstance: "hub" }), at("s-pin", 2, { siblingInstance: "hub", ...PIN })];
  const hub = instanceId(roster[0]);
  assert.deepEqual(instanceSiblings(roster, ON).get(hub).map(i => i.instance), ["s-pin", "s-new"]);
  assert.deepEqual(instanceSiblings(roster).get(hub).map(i => i.instance), ["s-new", "s-pin"]);
});

test("pins in two machine sections each lead their own section; a pinned child whose parent is in another section ranks there", () => {
  const deployments = [{ id: "here", machine: "this computer", local: true, primary: true }, { id: "far", machine: "far", local: false }];
  const roster = [
    at("h-new", 9, { deployment: { id: "here" } }), at("h-pin", 1, { deployment: { id: "here" }, ...PIN }),
    at("f-new", 9, { deployment: { id: "far" } }), at("f-pin", 1, { deployment: { id: "far" }, ...PIN }),
    // Its parent is in the other section: a root of its own section, pinned there; h-new is not lifted.
    at("f-child", 5, { deployment: { id: "far" }, parentInstance: "h-new", ...PIN }),
  ];
  const sections = rosterSections(roster, roster, deployments, DESKTOP_TERMS, ON);
  assert.deepEqual(sections.map(s => [s.deployment.id, s.groups.flatMap(g => drawn(g.clusters))]),
    [["here", ["h-pin@0", "h-new@0"]], ["far", ["f-child@0", "f-pin@0", "f-new@0"]]]);
});

test("a pinned row in the Background section leads that section's own tree; the main tree keeps its order", () => {
  const roster = [at("main-new", 9), at("main-old", 1), at("bg-new", 9, { background: true }), at("bg-pin", 1, { background: true, ...PIN })];
  const placement = backgroundPlacement(roster, true);
  const s = sidebarSections(roster, roster, [], DESKTOP_TERMS, { placement, open: true, pins: true });
  assert.deepEqual(s.main.flatMap(p => p.groups.flatMap(g => drawn(g.clusters))), ["main-new@0", "main-old@0"]);
  assert.deepEqual(s.background.sections.flatMap(p => p.groups.flatMap(g => drawn(g.clusters))), ["bg-pin@0", "bg-new@0"]);
});

test("a filter never reorders: the visible rows keep the full roster's pinned order", () => {
  const roster = [at("alpha-new", 9), at("alpha-pin", 1, PIN), at("beta", 5)];
  const visible = filterInstanceTree(roster, "alpha");
  assert.deepEqual(rosterGroups(roster, visible, ON).flatMap(g => drawn(g.clusters)), ["alpha-pin@0", "alpha-new@0"]);
});

test("the palette's never-focused rows follow the pinned order; a focused row still leads by recency", () => {
  const roster = [at("new", 9), at("pin", 1, PIN), at("mid", 5)];
  const never = rosterSections(roster, roster, [], DESKTOP_TERMS, { lastFocus: new Map(), pins: true });
  assert.deepEqual(never.flatMap(s => s.groups.flatMap(g => drawn(g.clusters))), ["pin@0", "new@0", "mid@0"]);
  const focused = rosterSections(roster, roster, [], DESKTOP_TERMS, { lastFocus: new Map([[instanceId(roster[2]), 100]]), pins: true });
  assert.deepEqual(focused.flatMap(s => s.groups.flatMap(g => drawn(g.clusters))), ["mid@0", "pin@0", "new@0"]);
});

test("pin, then retire: the row is gone and nothing else moves", () => {
  const roster = [at("a", 9), at("b", 5, PIN), at("c", 1)];
  assert.deepEqual(drawn(clusterInstances(roster, ON)), ["b@0", "a@0", "c@0"]);
  assert.deepEqual(drawn(clusterInstances(roster.filter(r => r.instance !== "b"), ON)), ["a@0", "c@0"]);
});

test("the field passes the client allow-lists as exactly true, anything else is absent", () => {
  const status = (value) => deploymentStatusData({ root: "/d/agents", agents: [{ name: "dev", dir: "/d/agents/dev",
    instances: [{ instance: "dev-1", home: "/d/agents/dev/instances/dev-1", ...(value === undefined ? {} : { pinned: value }) }] }] }, "/d");
  assert.equal(status(true).agents[0].instances[0].pinned, true);
  for (const bad of [false, "true", 1, null, undefined]) assert.equal(Object.hasOwn(status(bad).agents[0].instances[0], "pinned"), false, String(bad));
  const base = { instance: "dev-1", home: "/d/agents/dev/instances/dev-1", agentsRoot: "/d/agents", running: true };
  assert.equal(panelInstance({ ...base, pinned: true }).pinned, true);
  assert.equal(Object.hasOwn(panelInstance({ ...base, pinned: "yes" }), "pinned"), false);
  const panel = (value) => ({ workspace: { id: "team" }, instances: [{ ...base, ...(value === undefined ? {} : { pinned: value }) }] });
  assert.equal(projectActivePanel(panel(true)).instances[0].pinned, true);
  assert.equal(Object.hasOwn(projectActivePanel(panel(1)).instances[0], "pinned"), false);
  assert.notEqual(activeSignature(projectActivePanel(panel(true))), activeSignature(projectActivePanel(panel(undefined))), "a pin redraws");
});

test("a remote row pins only when its own host lists instance-pin: an older host, an unknown list or a failed read never pins, nor marks", () => {
  // The kernel relays a row's pinned whatever its host lists; the host's own list (probe.features, relayed by a CLI
  // with server-probe-features) is the gate, as same-work's is.
  const remote = (features, ok = true) => ({
    id: "host-a", server: "host", label: "Build", registrationPresent: true, target: { workspace: "/remote/p" },
    probe: ok ? { ok: true, ...(features === undefined ? {} : { features }) } : { ok: false, error: { message: "unreachable" } },
    agentsRoot: "/remote/p/agents", souls: [{ name: "dev" }],
    instances: [
      { instance: "new", agent: "dev", home: "/remote/p/agents/dev/instances/new", createdAt: "2026-10-11T09:00:00.000Z", running: true },
      { instance: "old", agent: "dev", home: "/remote/p/agents/dev/instances/old", createdAt: "2026-10-01T09:00:00.000Z", running: true, pinned: true },
    ],
  });
  const read = (group) => {
    const rows = remotePanel(group, "2026-10-11T12:00:00.000Z").instances;
    return { order: clusterInstances(rows, { pins: true }).flatMap((c) => c.instances.map((i) => i.instance)), pinned: rows.filter((r) => rowPinned(r, true)).map((r) => r.instance) };
  };
  for (const [why, group] of [["a host whose list lacks it", remote([])], ["a host with another list", remote(["instance-background"])],
    ["a host whose list is not relayed", remote(undefined)], ["a list that is not an array", remote("instance-pin")], ["a failed read", remote([PIN_FEATURE], false)]]) {
    assert.deepEqual(read(group), { order: ["new", "old"], pinned: [] }, why);
  }
  assert.deepEqual(read(remote([PIN_FEATURE])), { order: ["old", "new"], pinned: ["old"] }, "a host that lists it: its pin leads");
});

test("two pinned clusters keep the existing rule between them: a cluster ranks by its first root without pins, whichever root holds the pin", () => {
  // A's roots: a-new (newest, unpinned) and a-old (pinned, sibling-linked); B: one pinned root between them in time.
  const row = (instance, day, extra = {}) => ({ instance, home: `/w/${instance}`, agentsRoot: "/w", createdAt: `2026-11-${String(day).padStart(2, "0")}T10:00:00Z`, ...extra });
  const rows = [row("a-new", 19), row("a-old", 1, { siblingInstance: "a-new", pinned: true }), row("b", 10, { pinned: true }), row("c", 20)];
  const order = (pins) => clusterInstances(rows, { pins }).map((c) => c.instances.map((i) => i.instance));
  // Without pins: A by a-new (19), then B (10)... and c (20) first.
  assert.deepEqual(order(false), [["c"], ["a-new", "a-old"], ["b"]]);
  // With them: both pinned clusters lead, A still before B (a-new's 19 over b's 10), the pinned root first inside A.
  assert.deepEqual(order(true), [["a-old", "a-new"], ["b"], ["c"]]);
});
