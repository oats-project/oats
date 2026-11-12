// A row keeps its roster group under a filter and a collapse (#971). rosterGroups decides a
// cluster's group on the FULL roster: more than one member there is a group under the cluster's
// name, exactly one goes into a run of single instances, an "independent" group in place (#1262), keyed by
// its first member. What is visible decides which rows are listed, and whether a group is listed at all;
// it never moves a row to another group, nor changes a group's key.
import test from "node:test";
import assert from "node:assert/strict";
import { rosterGroups, filterInstanceTree, instanceVisibleInTree, collapseKey, instanceId } from "../../client/instance-tree.mjs";
import { rosterSections } from "../../client/roster-sections.mjs";
import { DESKTOP_TERMS } from "../renderer/desktop-terms.mjs";

const WS = "ws";
const at = (instance, extra = {}) => ({ instance, agent: "dev", home: `/w/${instance}`, agentsRoot: "/w", running: true, ...extra });
// A cluster of two (duo), a cluster of five (lead) and two unrelated instances, out of order.
const ROSTER = [
  at("zed"),
  at("tip-two", { parentInstance: "mid" }),
  at("duo-kid", { parentInstance: "duo" }),
  at("lead"),
  at("side", { parentInstance: "lead" }),
  at("solo"),
  at("mid", { parentInstance: "lead" }),
  at("duo"),
  at("tip-one", { parentInstance: "mid" }),
];
const row = (roster, name) => roster.find(i => i.instance === name);
/** The rows a filter leaves: the matches with their ancestor paths, as the sidebar computes them. */
const filtered = (roster, query) => filterInstanceTree(roster, query);
/** The rows left when the named rows are collapsed, as the sidebar computes them (`section`: the
 * deployment a row is painted in, where the view has several). */
const collapsed = (roster, names, { section } = {}) => {
  const keys = new Set(names.map(name => collapseKey(WS, instanceId(row(roster, name)))));
  return roster.filter(i => instanceVisibleInTree(i, roster, keys, WS, false, { section }));
};
/** [group key, group label, each cluster's row names]. */
const shape = groups => groups.map(g => [g.key, g.label, g.clusters.map(c => c.instances.map(i => i.instance))]);
const LEAD = ["lead", "mid", "tip-one", "tip-two", "side"];
/** An independent run's key: its first member's instanceId in the full roster (#1262). */
const IND = (roster, name) => `independent:${instanceId(row(roster, name))}`;

test("nothing hidden: the groups, their keys, the order and the rows are the ones the roster always drew", () => {
  const groups = rosterGroups(ROSTER, ROSTER);
  // Written out from the rule before #971, for this roster: with every row visible nothing differs.
  assert.deepEqual(groups.map(g => [g.key, g.label, g.clusters.map(c => [c.key, c.instances.map(i => [i.instance, i.depth])])]), [
    ["cluster:0:duo", "duo", [["duo", [["duo", 0], ["duo-kid", 1]]]]],
    ["cluster:1:lead", "lead", [["lead", [["lead", 0], ["mid", 1], ["tip-one", 2], ["tip-two", 2], ["side", 1]]]]],
    [IND(ROSTER, "solo"), "independent", [["solo", [["solo", 0]]], ["zed", [["zed", 0]]]]],
  ]);
  for (const group of groups) {
    assert.deepEqual(Object.keys(group), ["key", "label", "clusters"], "a group's shape");
    for (const cluster of group.clusters) {
      assert.deepEqual(Object.keys(cluster), ["key", "instances"], "a cluster's shape");
      for (const i of cluster.instances) assert.deepEqual(i, { ...row(ROSTER, i.instance), depth: i.depth }, "a row, with its depth");
    }
  }
  assert.deepEqual(rosterGroups([], []), []);
});

test("a cluster of two with its root collapsed: the root stays under the cluster's name, alone", () => {
  const groups = rosterGroups(ROSTER, collapsed(ROSTER, ["duo"]));
  assert.deepEqual(shape(groups), [
    ["cluster:0:duo", "duo", [["duo"]]],
    ["cluster:1:lead", "lead", [LEAD]],
    [IND(ROSTER, "solo"), "independent", [["solo"], ["zed"]]],
  ]);
  assert.equal(groups[0].clusters[0].instances.length, 1, "the header counts the one row shown");
});

test("a cluster of five, the filter matches one leaf: the leaf and its ancestors stay under the cluster's name", () => {
  assert.deepEqual(shape(rosterGroups(ROSTER, filtered(ROSTER, "tip-two"))), [["cluster:1:lead", "lead", [["lead", "mid", "tip-two"]]]]);
});

test("a cluster of five, the filter matches only its root: one row, under the cluster's name", () => {
  assert.deepEqual(shape(rosterGroups(ROSTER, filtered(ROSTER, "lead"))), [["cluster:1:lead", "lead", [["lead"]]]]);
});

test("a group with no visible row is not in the answer; a filter that matches nothing leaves no group", () => {
  const groups = rosterGroups(ROSTER, filtered(ROSTER, "duo"));
  assert.deepEqual(shape(groups), [["cluster:0:duo", "duo", [["duo", "duo-kid"]]]], "the lead group is absent, and so is independent");
  assert.ok(groups.every(g => g.clusters.every(c => c.instances.length > 0)), "no empty cluster is carried either");
  assert.deepEqual(filtered(ROSTER, "no-such-row"), []);
  assert.deepEqual(rosterGroups(ROSTER, filtered(ROSTER, "no-such-row")), []);
});

test("the independent group holds only one-member clusters, and is there only when one is visible", () => {
  // Next to a collapsed cluster of five: its root is not independent.
  assert.deepEqual(shape(rosterGroups(ROSTER, collapsed(ROSTER, ["lead", "duo"]))), [
    ["cluster:0:duo", "duo", [["duo"]]],
    ["cluster:1:lead", "lead", [["lead"]]],
    [IND(ROSTER, "solo"), "independent", [["solo"], ["zed"]]],
  ]);
  assert.deepEqual(shape(rosterGroups(ROSTER, filtered(ROSTER, "solo"))), [[IND(ROSTER, "solo"), "independent", [["solo"]]]]);
  // Every one-member cluster filtered out: no independent group.
  const none = rosterGroups(ROSTER, filtered(ROSTER, "tip-one"));
  assert.deepEqual(shape(none), [["cluster:1:lead", "lead", [["lead", "mid", "tip-one"]]]]);
  assert.equal(none.some(g => g.label === "independent"), false);
});

test("a group's key does not depend on what is visible: hiding an earlier group shifts no key", () => {
  const before = rosterGroups(ROSTER, ROSTER), after = rosterGroups(ROSTER, filtered(ROSTER, "side"));
  assert.deepEqual(before.map(g => g.key), ["cluster:0:duo", "cluster:1:lead", IND(ROSTER, "solo")]);
  assert.deepEqual(after.map(g => g.key), ["cluster:1:lead"], "the lead group keeps the key it has with nothing hidden");
  const keyOf = groups => new Map(groups.flatMap(g => g.clusters.flatMap(c => c.instances.map(i => [instanceId(i), g.key]))));
  for (const [id, key] of keyOf(after)) assert.equal(key, keyOf(before).get(id), "every row left is under the key it had");
  // An earlier group hidden by a collapse changes nothing either (a collapsed root is still shown).
  assert.deepEqual(rosterGroups(ROSTER, collapsed(ROSTER, ["duo"])).map(g => g.key), before.map(g => g.key));
});

test("two roots of one name (two agents roots): each group keeps its own key when a filter hides the first one's rows", () => {
  const run = (instance, root, extra = {}) => ({ instance, agent: "dev", home: `${root}/${instance}`, agentsRoot: root, running: true, ...extra });
  const roster = [
    run("lead", "/a"), run("child-a", "/a", { parentInstance: "lead" }),
    run("lead", "/b"), run("child-b", "/b", { parentInstance: "lead" }),
  ];
  assert.deepEqual(shape(rosterGroups(roster, roster)), [["cluster:0:lead", "lead", [["lead", "child-a"]]], ["cluster:1:lead", "lead", [["lead", "child-b"]]]]);
  const second = rosterGroups(roster, filtered(roster, "child-b"));
  assert.deepEqual(shape(second), [["cluster:1:lead", "lead", [["lead", "child-b"]]]]);
  assert.ok(second[0].clusters[0].instances.every(i => i.agentsRoot === "/b"), "the second root's own rows");
  assert.deepEqual(shape(rosterGroups(roster, filtered(roster, "child-a"))), [["cluster:0:lead", "lead", [["lead", "child-a"]]]]);
});

test("a pending spawn row that joins a cluster by its parent counts as a member", () => {
  const boss = at("boss"), pending = { instance: "boss-new", agent: "dev", agentsRoot: "/w", home: "/w/boss-new", parentInstance: "boss", pendingSpawn: { id: "job-1", pending: "spawning" } };
  assert.deepEqual(shape(rosterGroups([boss], [boss])), [[IND([boss], "boss"), "independent", [["boss"]]]], "alone, it is independent");
  const roster = [boss, pending];
  assert.deepEqual(shape(rosterGroups(roster, roster)), [["cluster:0:boss", "boss", [["boss", "boss-new"]]]]);
  assert.deepEqual(shape(rosterGroups(roster, collapsed(roster, ["boss"]))), [["cluster:0:boss", "boss", [["boss"]]]], "collapsed over its pending child, it keeps its group");
});

test("several deployments: a cluster's size is counted inside its section, and a collapse in one section moves nothing in another", () => {
  const D1 = { id: "/a", machine: "This Mac", path: "/a", label: "~/a", local: true, reachable: true, primary: true };
  const D2 = { id: "remote:devbox:b", machine: "devbox", path: "/b", label: "~/b", local: false, reachable: true, primary: false };
  const inD = (d, instance, extra = {}) => ({ instance, agent: "dev", home: `${d.path}/agents/dev/instances/${instance}`, agentsRoot: `${d.path}/agents`,
    running: true, deployment: { id: d.id }, ...extra });
  const roster = [
    inD(D1, "lead"), inD(D1, "kid", { parentInstance: "lead" }), inD(D1, "solo"),
    inD(D2, "chief"), inD(D2, "aide", { parentInstance: "chief" }), inD(D2, "lone"), inD(D2, "stray", { parentInstance: "lead" }),
  ];
  const sections = visible => rosterSections(roster, visible, [D1, D2], DESKTOP_TERMS).map(s => [s.deployment.id, shape(s.groups)]);
  const open = sections(roster);
  assert.deepEqual(open, [
    [D1.id, [["cluster:0:lead", "lead", [["lead", "kid"]]], [IND(roster, "solo"), "independent", [["solo"]]]]],
    [D2.id, [["cluster:0:chief", "chief", [["chief", "aide"]]], [IND(roster, "lone"), "independent", [["lone"], ["stray"]]]]],
  ], "a parent name in another deployment joins nothing: stray is a cluster of one in its own section");
  // stray's parent name resolves to D1's lead (a unique name), which is painted in another section.
  const shut = sections(collapsed(roster, ["lead"], { section: i => i.deployment.id }));
  assert.deepEqual(shut[0], [D1.id, [["cluster:0:lead", "lead", [["lead"]]], [IND(roster, "solo"), "independent", [["solo"]]]]]);
  assert.deepEqual(shut[1], open[1], "the other section is untouched");
});

test("the arguments are not changed, and `links` still decides the relations", () => {
  const freeze = rows => Object.freeze(rows.map(i => Object.freeze({ ...i })));
  const all = freeze(ROSTER), visible = Object.freeze(filtered(all, "tip-two")), before = JSON.stringify([all, visible]);
  const options = Object.freeze({ links: Object.freeze(i => (i.parentInstance ? [i.parentInstance] : [])) });
  assert.deepEqual(shape(rosterGroups(all, visible, options)), [["cluster:1:lead", "lead", [["lead", "mid", "tip-two"]]]]);
  assert.deepEqual(shape(rosterGroups(all, all)), shape(rosterGroups(ROSTER, ROSTER)));
  assert.equal(JSON.stringify([all, visible]), before);
  // No relation at all: every row is a cluster of one, whatever is visible.
  assert.deepEqual(rosterGroups(all, visible, { links: () => [] }).map(g => g.key), [IND(ROSTER, "duo")], "one run, keyed by its first member in the full roster");
});

// --- A bundle keeps its place (#1262): one sequence by root, in name order ---------------------------
/** The rows in the order drawn, and [group label, its rows] for each group. */
const drawn = groups => groups.flatMap(g => g.clusters.flatMap(c => c.instances.map(i => i.instance)));
const byGroup = groups => groups.map(g => [g.label, g.clusters.flatMap(c => c.instances.map(i => i.instance))]);
const FLAT = ["alpha", "bravo", "charlie", "delta", "echo"].map(name => at(name));

test("#1262: a top-level instance that gains a child stays where it was, a group in place, and every other row stays too", () => {
  const before = rosterGroups(FLAT, FLAT);
  assert.deepEqual(byGroup(before), [["independent", ["alpha", "bravo", "charlie", "delta", "echo"]]]);
  const grown = [...FLAT, at("aaa-kid", { parentInstance: "charlie" })];
  const after = rosterGroups(grown, grown);
  assert.deepEqual(byGroup(after), [["independent", ["alpha", "bravo"]], ["charlie", ["charlie", "aaa-kid"]], ["independent", ["delta", "echo"]]]);
  assert.deepEqual(drawn(after).filter(n => n !== "aaa-kid"), drawn(before), "every row keeps its place");
  assert.deepEqual(after.map(g => g.key), [`independent:${instanceId(row(FLAT, "alpha"))}`, "cluster:0:charlie", `independent:${instanceId(row(FLAT, "delta"))}`]);
  // It loses the child: back in the run, at the same place.
  assert.deepEqual(byGroup(rosterGroups(FLAT, FLAT)), byGroup(before));
});

test("#1262: the lower of two top-level instances that spawns a child stays below the other; the run splits around it", () => {
  const two = [at("top"), at("bottom"), at("middle")];
  const grown = [...two, at("a-kid", { parentInstance: "middle" })];
  assert.deepEqual(byGroup(rosterGroups(grown, grown)), [["independent", ["bottom"]], ["middle", ["middle", "a-kid"]], ["independent", ["top"]]]);
});

test("#1262: a running child whose name sorts first moves its bundle nowhere; a cluster ranks by its first root", () => {
  const roster = [at("mike", { running: false }), at("bravo", { running: false }), at("aaa", { parentInstance: "mike", running: true }), at("zulu")];
  assert.deepEqual(byGroup(rosterGroups(roster, roster)), [["independent", ["bravo"]], ["mike", ["mike", "aaa"]], ["independent", ["zulu"]]]);
  // Joined only by a sibling link: two roots, ranked by the first.
  const siblings = [at("yankee", { siblingInstance: "kilo" }), at("kilo"), at("charlie"), at("xray")];
  assert.deepEqual(byGroup(rosterGroups(siblings, siblings, { links: i => i.siblingInstance ? [i.siblingInstance] : [] })),
    [["independent", ["charlie"]], ["kilo", ["kilo", "yankee"]], ["independent", ["xray"]]]);
});

test("#1262: a start or a stop moves no row, roots or siblings", () => {
  const roster = [at("lead"), at("b-kid", { parentInstance: "lead" }), at("a-kid", { parentInstance: "lead" }), at("solo"), at("echo"), at("delta", { parentInstance: "echo" })];
  const order = drawn(rosterGroups(roster, roster));
  assert.deepEqual(order, ["echo", "delta", "lead", "a-kid", "b-kid", "solo"]);
  for (const name of roster.map(i => i.instance)) for (const running of [false, null]) {
    const toggled = roster.map(i => i.instance === name ? { ...i, running } : i);
    assert.deepEqual(drawn(rosterGroups(toggled, toggled)), order, `${name} ${running}`);
  }
});

test("#1262: every row keeps its place across any change that only adds or removes children", () => {
  const base = [at("delta"), at("alpha"), at("echo"), at("bravo"), at("charlie"), at("mid", { parentInstance: "bravo" })];
  const order = drawn(rosterGroups(base, base));
  for (const parent of base.map(i => i.instance)) for (const kid of ["aa-kid", "zz-kid"]) {
    const grown = [...base, at(kid, { parentInstance: parent })];
    assert.deepEqual(drawn(rosterGroups(grown, grown)).filter(n => n !== kid), order, `${kid} under ${parent}`);
  }
  const shrunk = base.filter(i => i.instance !== "mid");
  assert.deepEqual(drawn(rosterGroups(shrunk, shrunk)), order.filter(n => n !== "mid"), "bravo's last child goes: bravo stays");
});

test("#1262: an independent run's key is its first member's in the full roster, whatever a filter or a collapse hides", () => {
  const roster = [...FLAT, at("aaa-kid", { parentInstance: "charlie" })];
  const keys = groups => groups.map(g => g.key);
  const all = keys(rosterGroups(roster, roster));
  const hiddenFirst = roster.filter(i => i.instance !== "alpha" && i.instance !== "delta");
  assert.deepEqual(keys(rosterGroups(roster, hiddenFirst)), all, "the runs keep their keys with their first members hidden");
  assert.deepEqual(keys(rosterGroups(roster, collapsed(roster, ["charlie"]))), all, "a collapse moves no key");
  assert.deepEqual(byGroup(rosterGroups(roster, filtered(roster, "echo"))), [["independent", ["echo"]]]);
  assert.deepEqual(keys(rosterGroups(roster, filtered(roster, "echo"))), [all[2]]);
});
