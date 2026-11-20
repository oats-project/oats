// #1577: the sidebar's and the palette's solid parent→child lines join only a child that draws its parent line
// (packages/client/related-work.mjs `drawsParentLine`: on a host that declares instance-same-work, a child the kernel
// flagged `sameWork: true`; on any other host, every child, as before). The layout does not change: the rows, their
// depth and indent, the groups, and the dotted sibling links are as they were. The line is the flag's only sign:
// no label, no tag, nothing to assistive technology. The rule, the gate and the order are
// test/client-related-work.test.mjs's.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { treeConnectors, treeGuides } from "../renderer/instance-tree-view.mjs";
import { paletteRows } from "../renderer/palette.mjs";
import { clusterInstances, filterInstanceTree, instanceVisibleInTree, collapseKey, instanceId, backgroundPlacement } from "../../client/instance-tree.mjs";
import { withParentGate } from "../../client/related-work.mjs";
import { sidebarSections } from "../../client/roster-sections.mjs";
import { DESKTOP_TERMS } from "../renderer/desktop-terms.mjs";

/** A row of a host that declares the feature (the panel's stamp, panel-views.mjs deploymentPanel). */
const known = (instance, extra = {}) => ({ instance, agent: "dev", home: `/w/${instance}`, agentsRoot: "/w", running: true, sameWorkKnown: true, ...extra });
const unknown = (rows) => rows.map(({ sameWorkKnown: _gate, ...row }) => row);
/** Each listed row's connectors, `kind@level`, over `items` as listed and `all` as the full roster. */
const lines = (items, all = items) => Object.fromEntries(items.map((i) => [i.instance, treeConnectors(items, i, all).map((c) => `${c.kind}@${c.level}`)]));
const listed = (all) => clusterInstances(all).flatMap((c) => c.instances);

// A mixed parent: flagged a and c, unflagged b.
const MIXED = [known("p"), known("b", { parentInstance: "p" }), known("c", { parentInstance: "p", sameWork: true }), known("a", { parentInstance: "p", sameWork: true })];

test("a mixed parent: a and c listed first with their elbows, the vertical ending at c; b keeps its indent and has no line", () => {
  const items = listed(MIXED);
  assert.deepEqual(items.map((i) => [i.instance, i.depth]), [["p", 0], ["a", 1], ["c", 1], ["b", 1]]);
  assert.deepEqual(lines(items), {
    p: ["down@0"],
    a: ["elbow@0", "line@0"],
    c: ["elbow@0"],
    b: [],
  });
  // Today's lines on a host without the feature: the same rows by name, every child joined.
  const today = listed(unknown(MIXED));
  assert.deepEqual(today.map((i) => i.instance), ["p", "a", "b", "c"]);
  assert.deepEqual(lines(today), { p: ["down@0"], a: ["elbow@0", "line@0"], b: ["elbow@0", "line@0"], c: ["elbow@0"] });
});

test("a flagged child under an unflagged child: the inner line is drawn; the outer parent has no stem to the unflagged child", () => {
  const all = [known("g"), known("u", { parentInstance: "g" }), known("x", { parentInstance: "u", sameWork: true })];
  const items = listed(all);
  assert.deepEqual(items.map((i) => [i.instance, i.depth]), [["g", 0], ["u", 1], ["x", 2]], "the depth does not change");
  assert.deepEqual(lines(items), { g: [], u: ["down@1"], x: ["elbow@1"] });
  // The same with a joined sibling of u: g's vertical ends at it, before u, and passes neither u nor x.
  const wider = [...all, known("j", { parentInstance: "g", sameWork: true })];
  assert.deepEqual(lines(listed(wider)), { g: ["down@0"], j: ["elbow@0"], u: ["down@1"], x: ["elbow@1"] });
});

test("only one host declaring: its rows follow the flag, another's keep today's lines", () => {
  // A local CLI with the feature and a remote host without it: the panel stamps the local rows only.
  const local = [known("p"), known("k1", { parentInstance: "p" }), known("k2", { parentInstance: "p", sameWork: true })];
  const remote = unknown([known("p"), known("k1", { parentInstance: "p" }), known("k2", { parentInstance: "p", sameWork: true })])
    .map((row) => ({ ...row, server: "host", home: `/r/${row.instance}` }));
  const all = [...local, ...remote];
  const clusters = clusterInstances(all), mine = clusters.find((c) => !c.instances[0].server), theirs = clusters.find((c) => c.instances[0].server);
  assert.deepEqual(mine.instances.map((i) => i.instance), ["p", "k2", "k1"]);
  assert.deepEqual(mine.instances.map((i) => treeConnectors(mine.instances, i, all).map((c) => c.kind)), [["down"], ["elbow"], []]);
  assert.deepEqual(theirs.instances.map((i) => i.instance), ["p", "k1", "k2"]);
  assert.deepEqual(theirs.instances.map((i) => treeConnectors(theirs.instances, i, all).map((c) => c.kind)), [["down"], ["elbow", "line"], ["elbow"]]);
});

test("filter and collapse: the visible-row rules hold, and a hidden flagged sibling extends no vertical", () => {
  const all = [...MIXED, known("a1", { parentInstance: "a", sameWork: true })];
  const items = listed(all);
  // c filtered out: a is now the last joined child shown, and the vertical ends at it.
  const query = filterInstanceTree(items, "a");
  assert.deepEqual(query.map((i) => i.instance), ["p", "a", "a1"]);
  assert.deepEqual(lines(query, all), { p: ["down@0"], a: ["elbow@0", "down@1"], a1: ["elbow@1"] });
  // a collapsed: a1 is hidden; a draws no stem and p's vertical still runs to c.
  const collapsed = new Set([collapseKey("ws", instanceId(all.find((i) => i.instance === "a")))]);
  const visible = items.filter((i) => instanceVisibleInTree(i, all, collapsed, "ws"));
  assert.deepEqual(visible.map((i) => i.instance), ["p", "a", "c", "b"]);
  assert.deepEqual(lines(visible, all), { p: ["down@0"], a: ["elbow@0", "line@0"], c: ["elbow@0"], b: [] });
  // Only b shown under p (a filter that drops both flagged children): p has no stem, b no line.
  const onlyB = items.filter((i) => ["p", "b"].includes(i.instance));
  assert.deepEqual(lines(onlyB, all), { p: [], b: [] });
});

test("sameWork of any value but true reads as unflagged and never throws; a flagged root changes nothing", () => {
  for (const sameWork of ["true", 1, false, null, {}]) {
    const all = [known("p"), known("k", { parentInstance: "p", sameWork })];
    assert.deepEqual(lines(listed(all)), { p: [], k: [] }, JSON.stringify(sameWork));
  }
  const roots = [known("r1", { sameWork: true }), known("r2", { siblingInstance: "r1" }), known("r3", { parentInstance: "gone", sameWork: true })];
  const today = unknown(roots);
  const perCluster = (all) => clusterInstances(all).map((c) => lines(c.instances, all));
  assert.deepEqual(perCluster(roots), perCluster(today), "roots draw as before: the dotted sibling link only");
  assert.deepEqual(perCluster(roots), [{ r1: ["link-out@0"], r2: ["link-in@0"] }, { r3: [] }]);
});

test("the dotted sibling links are siblinghood, not parentage: unchanged beside an unjoined child", () => {
  const all = [known("a"), known("a1", { parentInstance: "a" }), known("a2", { parentInstance: "a", sameWork: true }), known("b", { siblingInstance: "a" })];
  const items = clusterInstances(all)[0].instances;
  assert.deepEqual(items.map((i) => i.instance), ["a", "a2", "a1", "b"]);
  assert.deepEqual(lines(items, all), {
    a: ["down@0", "link-out@0"],
    a2: ["elbow@0", "link-through@0"],
    a1: ["link-through@0"],
    b: ["link-in@0"],
  });
});

test("a pending spawn's row takes its parent's gate: under a declaring host it draws no line, elsewhere today's", () => {
  // shell.mjs: the Desktop's spawn never passes --same-work, and the pending row is this window's own (no stamp).
  const parent = known("lead"), sibling = known("dev-a", { parentInstance: "lead", sameWork: true });
  const pending = withParentGate({ instance: "dev-new", agent: "dev", home: "/w/dev-new", agentsRoot: "/w", parentInstance: "lead", pendingSpawn: { pending: "spawning" } }, parent);
  const items = listed([parent, sibling, pending]);
  assert.deepEqual(items.map((i) => i.instance), ["lead", "dev-a", "dev-new"]);
  assert.deepEqual(lines(items), { lead: ["down@0"], "dev-a": ["elbow@0"], "dev-new": [] });
  const [oldParent, oldSibling] = unknown([parent, sibling]);
  const oldPending = withParentGate({ ...pending }, oldParent);
  assert.deepEqual(lines(listed([oldParent, oldSibling, oldPending])), { lead: ["down@0"], "dev-a": ["elbow@0", "line@0"], "dev-new": ["elbow@0"] });
});

test("the palette draws the sidebar's lines over the same order, and says nothing more: no word, no label, only aria-hidden guides", () => {
  const rows = paletteRows(MIXED, [], "", { openTerminal() {} }).filter((row) => row.group);
  assert.deepEqual(rows.map((r) => [r.label, r.depth, r.under || null, r.connectors.map((c) => `${c.kind}@${c.level}`)]), [
    ["p", 0, null, ["down@0"]],
    ["a", 1, "under p", ["elbow@0", "line@0"]],
    ["c", 1, "under p", ["elbow@0"]],
    ["b", 1, "under p", []],
  ], "the relation words are unchanged: b is still under p");
  assert.ok(rows.every((r) => !JSON.stringify(r).toLowerCase().includes("same")), "no row carries a word for the flag");
  const dom = new JSDOM("<!doctype html><body></body>");
  const guides = treeGuides(dom.window.document, rows[3].connectors);
  assert.equal(guides.getAttribute("aria-hidden"), "true");
  assert.equal(guides.children.length, 0, "the unjoined child's guides are empty");
  dom.window.close();
});

// #1577 with #1579: the sidebar's main tree and its Background section are separate trees (roster-sections.mjs
// sidebarSections), so no parent line crosses between them; inside the Background section the lines and the order
// under a parent follow the same-work rule as anywhere else.
test("sections: no parent line crosses into the Background section; inside it, lines and order follow sameWork", () => {
  const all = [
    known("lead"), known("dev-a", { parentInstance: "lead", sameWork: true }),
    known("bg", { parentInstance: "lead", sameWork: true, background: true }),
    known("bg-y", { parentInstance: "bg" }), known("bg-x", { parentInstance: "bg", sameWork: true }), known("bg-z", { parentInstance: "bg", sameWork: true }),
  ];
  const placement = backgroundPlacement(all, true);
  const { main, background } = sidebarSections(all, all, [], DESKTOP_TERMS, { placement, open: true });
  const rows = (sections) => sections.flatMap((s) => s.groups.flatMap((g) => g.clusters.map((c) => c.instances)));
  const drawn = (sections) => Object.assign({}, ...rows(sections).map((items) => lines(items, all)));
  assert.deepEqual(rows(main.length ? main : []).flat().map((i) => [i.instance, i.depth]), [["lead", 0], ["dev-a", 1]]);
  assert.deepEqual(drawn(main), { lead: ["down@0"], "dev-a": ["elbow@0"] }, "lead's line ends at dev-a: bg, flagged, is in the other section");
  assert.deepEqual(rows(background.sections).flat().map((i) => [i.instance, i.depth]), [["bg", 0], ["bg-x", 1], ["bg-z", 1], ["bg-y", 1]],
    "bg is a root of the Background section; under it the flagged children come first");
  assert.deepEqual(drawn(background.sections), { bg: ["down@0"], "bg-x": ["elbow@0", "line@0"], "bg-z": ["elbow@0"], "bg-y": [] },
    "no line from bg to lead; bg's line ends at its last joined child, bg-y keeps its indent");
});
