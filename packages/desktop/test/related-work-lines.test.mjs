// The related-work lines: the sidebar's and the palette's lines are drawn for related work only, with the builder
// the sidebar used before the Desktop UI rework's D26 (instance-tree-view.mjs treeConnectors). The rule is
// packages/client/related-work.mjs's: a child draws its solid line to its parent when its host reports it related
// (`relatedWork` on a host that declares instance-related-work; `sameWork` on one that declares only
// instance-same-work); two top-level rows are joined by the dotted link when the row whose siblingInstance names the
// other reports `relatedWork` (instance-related-work only). No flag, no line, on every host. The layout does not
// change: the rows, their depth and indent, the groups and the order are as they were. The rule, the gate and the
// order are test/client-related-work.test.mjs's; the sidebar's rendering and words are sidebar-slice1.test.mjs's.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { treeConnectors, treeGuides, siblingLinkSpans } from "../renderer/instance-tree-view.mjs";
import { paletteRows } from "../renderer/palette.mjs";
import { clusterInstances, filterInstanceTree, instanceVisibleInTree, collapseKey, instanceId, backgroundPlacement, relatedSiblings } from "../../client/instance-tree.mjs";
import { withParentGate, RELATED_WORK_FEATURE, SAME_WORK_FEATURE } from "../../client/related-work.mjs";
import { sidebarSections } from "../../client/roster-sections.mjs";
import { DESKTOP_TERMS } from "../renderer/desktop-terms.mjs";

/** A row of a host that declares instance-related-work (the panel's stamp, panel-views.mjs deploymentPanel). */
const known = (instance, extra = {}) => ({ instance, agent: "dev", home: `/w/${instance}`, agentsRoot: "/w", running: true, relatedWorkKnown: RELATED_WORK_FEATURE, ...extra });
/** The same rows from a host that declares only instance-same-work, and from one that declares neither. */
const older = (rows) => rows.map((row) => ({ ...row, relatedWorkKnown: SAME_WORK_FEATURE }));
const unknown = (rows) => rows.map(({ relatedWorkKnown: _gate, ...row }) => row);
/** Each listed row's connectors, `kind@level`, over `items` as listed and `all` as the full roster. */
const lines = (items, all = items) => Object.fromEntries(items.map((i) => [i.instance, treeConnectors(items, i, all).map((c) => `${c.kind}@${c.level}`)]));
const listed = (all) => clusterInstances(all).flatMap((c) => c.instances);
const none = (items) => Object.fromEntries(items.map((i) => [i.instance, []]));
/** A spawn time `n` minutes into the hour: the roster lists newest first (instance-tree.mjs rosterOrder). */
const at = (n) => ({ createdAt: `2026-11-20T10:${String(n).padStart(2, "0")}:00.000Z` });

// A mixed parent: related a and c, unrelated b.
const MIXED = [known("p"), known("b", { parentInstance: "p" }), known("c", { parentInstance: "p", relatedWork: true }), known("a", { parentInstance: "p", relatedWork: true })];

test("a mixed parent: a and c listed first with their elbows, the vertical ending at c; b keeps its indent and has no line", () => {
  const items = listed(MIXED);
  assert.deepEqual(items.map((i) => [i.instance, i.depth]), [["p", 0], ["a", 1], ["c", 1], ["b", 1]]);
  assert.deepEqual(lines(items), {
    p: ["down@0"],
    a: ["elbow@0", "line@0"],
    c: ["elbow@0"],
    b: [],
  });
});

test("no flag, no line: a host that declares neither feature draws no line at all, whatever its rows carry", () => {
  const rows = unknown([...MIXED.map((row) => ({ ...row, sameWork: true })), known("q", { siblingInstance: "p", relatedWork: true })]);
  const items = listed(rows);
  assert.deepEqual(items.map((i) => [i.instance, i.depth]), [["p", 0], ["a", 1], ["b", 1], ["c", 1], ["q", 0]], "the order is by name: no row draws");
  assert.deepEqual(lines(items), none(items));
  // A host that declares the new feature but flags nothing: the same, no line.
  const quiet = listed([known("p"), known("k1", { parentInstance: "p" }), known("k2", { parentInstance: "p" }), known("s", { siblingInstance: "p" })]);
  assert.deepEqual(lines(quiet), none(quiet));
});

test("an older host (instance-same-work only): child lines from sameWork, or a relaying CLI's relatedWork; no sibling link", () => {
  const rows = older([known("p"), known("b", { parentInstance: "p" }), known("c", { parentInstance: "p", sameWork: true }),
    known("a", { parentInstance: "p", relatedWork: true }), known("s", { siblingInstance: "p", relatedWork: true }), known("t", { siblingInstance: "p", sameWork: true })]);
  const items = listed(rows);
  assert.deepEqual(items.map((i) => [i.instance, i.depth]), [["p", 0], ["a", 1], ["c", 1], ["b", 1], ["s", 0], ["t", 0]]);
  assert.deepEqual(lines(items), { p: ["down@0"], a: ["elbow@0", "line@0"], c: ["elbow@0"], b: [], s: [], t: [] },
    "a and c join p (a's flag as a relaying CLI sends it); neither sibling is joined: an older host joins none");
  assert.deepEqual(relatedSiblings(rows), new Map(), "nor said in words");
});

test("a related child under an unrelated child: the inner line is drawn; the outer parent has no stem to the unrelated child", () => {
  const all = [known("g"), known("u", { parentInstance: "g" }), known("x", { parentInstance: "u", relatedWork: true })];
  const items = listed(all);
  assert.deepEqual(items.map((i) => [i.instance, i.depth]), [["g", 0], ["u", 1], ["x", 2]], "the depth does not change");
  assert.deepEqual(lines(items), { g: [], u: ["down@1"], x: ["elbow@1"] });
  // The same with a joined sibling of u: g's vertical ends at it, before u, and passes neither u nor x.
  const wider = [...all, known("j", { parentInstance: "g", relatedWork: true })];
  assert.deepEqual(lines(listed(wider)), { g: ["down@0"], j: ["elbow@0"], u: ["down@1"], x: ["elbow@1"] });
});

test("each host by its own gate: a declaring host's rows follow the flag, an undeclaring host's draw none", () => {
  const local = [known("p"), known("k1", { parentInstance: "p" }), known("k2", { parentInstance: "p", relatedWork: true })];
  const remote = unknown([known("p"), known("k1", { parentInstance: "p" }), known("k2", { parentInstance: "p", relatedWork: true })])
    .map((row) => ({ ...row, server: "host", home: `/r/${row.instance}` }));
  const all = [...local, ...remote];
  const clusters = clusterInstances(all), mine = clusters.find((c) => !c.instances[0].server), theirs = clusters.find((c) => c.instances[0].server);
  assert.deepEqual(mine.instances.map((i) => i.instance), ["p", "k2", "k1"]);
  assert.deepEqual(mine.instances.map((i) => treeConnectors(mine.instances, i, all).map((c) => c.kind)), [["down"], ["elbow"], []]);
  assert.deepEqual(theirs.instances.map((i) => i.instance), ["p", "k1", "k2"]);
  assert.deepEqual(theirs.instances.map((i) => treeConnectors(theirs.instances, i, all).map((c) => c.kind)), [[], [], []]);
});

test("filter and collapse: the visible-row rules hold, and a hidden related sibling extends no vertical", () => {
  const all = [...MIXED, known("a1", { parentInstance: "a", relatedWork: true })];
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
  // Only b shown under p (a filter that drops both related children): p has no stem, b no line.
  const onlyB = items.filter((i) => ["p", "b"].includes(i.instance));
  assert.deepEqual(lines(onlyB, all), { p: [], b: [] });
});

test("a flag of any value but true reads as unflagged and never throws", () => {
  for (const relatedWork of ["true", 1, false, null, {}]) {
    const all = [known("p"), known("k", { parentInstance: "p", relatedWork }), known("s", { siblingInstance: "p", relatedWork })];
    const items = listed(all);
    assert.deepEqual(lines(items), none(items), JSON.stringify(relatedWork));
  }
  // On a host with the new feature, sameWork is not read: a child carrying only it draws nothing.
  const stray = listed([known("p"), known("k", { parentInstance: "p", sameWork: true })]);
  assert.deepEqual(lines(stray), none(stray));
});

// --- Siblings: the dotted link on the dot column -----------------------------------------------------------------

test("siblings: two roots joined by a related link draw the dotted link, collapsed and open, beside the children between them", () => {
  const all = [known("a", at(2)), known("a1", { parentInstance: "a", relatedWork: true, ...at(3) }), known("a2", { parentInstance: "a", ...at(4) }),
    known("b", { siblingInstance: "a", relatedWork: true, ...at(1) })];
  const items = listed(all);
  assert.deepEqual(items.map((i) => i.instance), ["a", "a1", "a2", "b"]);
  assert.deepEqual(lines(items, all), {
    a: ["down@0", "link-out@0"],
    a1: ["elbow@0", "link-through@0"],
    a2: ["link-through@0"],
    b: ["link-in@0"],
  }, "the dotted link passes beside a's children, joined or not: they are a's, a joined root");
  // a collapsed: the two dots joined directly.
  const shut = items.filter((i) => !(i.depth || 0));
  assert.deepEqual(lines(shut, all), { a: ["link-out@0"], b: ["link-in@0"] });
  // The same bundle without the flag on b: no dotted link at all.
  const plain = all.map(({ relatedWork, ...row }) => (row.instance === "b" ? row : { ...row, ...(relatedWork ? { relatedWork } : {}) }));
  assert.deepEqual(lines(listed(plain), plain), { a: ["down@0"], a1: ["elbow@0"], a2: [], b: [] });
});

test("siblings are edges, not a star: S links to R and T to S, and the line runs through every joined dot", () => {
  const all = [known("R", at(1)), known("S", { siblingInstance: "R", relatedWork: true, ...at(2) }), known("T", { siblingInstance: "S", relatedWork: true, ...at(3) })];
  const items = listed(all);
  assert.deepEqual(items.map((i) => i.instance), ["T", "S", "R"], "newest first");
  assert.deepEqual(lines(items, all), { T: ["link-out@0"], S: ["link-in@0", "link-out@0"], R: ["link-in@0"] });
  assert.deepEqual(siblingLinkSpans(items, all), { spans: [[0, 1], [1, 2]], joined: new Set([0, 1, 2]) });
  // T→S unrelated: S and R stay joined; T is a gap at the top.
  const half = all.map((row) => (row.instance === "T" ? known("T", { siblingInstance: "S", ...at(3) }) : row));
  assert.deepEqual(lines(listed(half), half), { T: [], S: ["link-out@0"], R: ["link-in@0"] });
});

// The lead's choice B (2026-11-20): no reorder; the dotted line breaks around a top-level row no related link joins.
// Its row, and its children's, carry no dotted segment at all, so nothing touches its dot; the line above ends at
// the bottom edge of the row before it, and starts again at the top edge of the row after.
test("an unrelated root between joined ones: s3 (related to R), s3-kid, s2 (unrelated), R — open and collapsed", () => {
  const all = [known("R", at(1)), known("s2", { siblingInstance: "R", ...at(2) }), known("s3", { siblingInstance: "R", relatedWork: true, ...at(3) }),
    known("s3-kid", { parentInstance: "s3", relatedWork: true, ...at(4) })];
  const items = listed(all);
  assert.deepEqual(items.map((i) => [i.instance, i.depth]), [["s3", 0], ["s3-kid", 1], ["s2", 0], ["R", 0]], "the roster's order, unchanged");
  assert.deepEqual(lines(items, all), {
    s3: ["down@0", "link-out@0"],
    "s3-kid": ["elbow@0", "link-through@0"],
    s2: [],
    R: ["link-in@0"],
  });
  const shut = items.filter((i) => i.instance !== "s3-kid");
  assert.deepEqual(lines(shut, all), { s3: ["link-out@0"], s2: [], R: ["link-in@0"] });
  // The unrelated root's own children are its block: the line passes beside none of them either.
  const withKids = [...all, known("s2-kid", { parentInstance: "s2", relatedWork: true, ...at(5) }), known("s2-kid2", { parentInstance: "s2", ...at(6) })];
  const open = listed(withKids);
  assert.deepEqual(open.map((i) => i.instance), ["s3", "s3-kid", "s2", "s2-kid", "s2-kid2", "R"]);
  assert.deepEqual(lines(open, withKids), {
    s3: ["down@0", "link-out@0"], "s3-kid": ["elbow@0", "link-through@0"],
    s2: ["down@0"], "s2-kid": ["elbow@0"], "s2-kid2": [],
    R: ["link-in@0"],
  }, "s2's own solid line to its related child stays; no dotted segment in s2's block");
});

test("a link to a row not shown, or not top-level, draws nothing; a row linked to itself draws nothing", () => {
  const all = [known("R"), known("S", { siblingInstance: "R", relatedWork: true }), known("C", { parentInstance: "R", relatedWork: true }),
    known("X", { siblingInstance: "C", relatedWork: true }), known("Y", { siblingInstance: "Y", relatedWork: true })];
  const items = listed(all);
  const onlyS = items.filter((i) => i.instance !== "R" && i.instance !== "C");
  assert.deepEqual(lines(onlyS, all), none(onlyS), "R filtered out: S's link has nowhere to go");
  const spans = siblingLinkSpans(items, all).spans.map(([from, to]) => [items[from].instance, items[to].instance].sort());
  assert.deepEqual(spans, [["R", "S"]], "X's link names a child (C): no link; Y's names itself: none");
});

test("a pending spawn's row takes its parent's gate and carries no flag: it draws no line of its own", () => {
  const parent = known("lead"), sibling = known("dev-a", { parentInstance: "lead", relatedWork: true });
  const pending = withParentGate({ instance: "dev-new", agent: "dev", home: "/w/dev-new", agentsRoot: "/w", parentInstance: "lead", pendingSpawn: { pending: "spawning" } }, parent);
  assert.equal(pending.relatedWorkKnown, RELATED_WORK_FEATURE, "the parent's gate");
  const items = listed([parent, sibling, pending]);
  assert.deepEqual(items.map((i) => i.instance), ["lead", "dev-a", "dev-new"]);
  assert.deepEqual(lines(items), { lead: ["down@0"], "dev-a": ["elbow@0"], "dev-new": [] });
  // On a host that declares nothing, the same rows draw nothing at all.
  const [oldParent, oldSibling] = unknown([parent, sibling]);
  const oldPending = withParentGate({ ...pending }, oldParent);
  assert.equal(Object.hasOwn(oldPending, "relatedWorkKnown"), false);
  assert.deepEqual(lines(listed([oldParent, oldSibling, oldPending])), { lead: [], "dev-a": [], "dev-new": [] });
  // A pending child of a joined root between two joined roots: the dotted line passes beside it, as beside any child.
  const bundle = [known("b", { siblingInstance: "a", relatedWork: true, ...at(1) }), known("a", at(2)),
    withParentGate({ instance: "a-new", agent: "dev", home: "/w/a-new", agentsRoot: "/w", parentInstance: "a", pendingSpawn: { pending: "spawning" }, ...at(3) }, known("a"))];
  assert.deepEqual(lines(listed(bundle), bundle), { a: ["link-out@0"], "a-new": ["link-through@0"], b: ["link-in@0"] });
});

test("the palette draws the sidebar's lines over the same order, and its words are unchanged: only aria-hidden guides", () => {
  const rows = paletteRows([...MIXED, known("q", { siblingInstance: "p", relatedWork: true })], [], "", { openTerminal() {} }).filter((row) => row.group);
  assert.deepEqual(rows.map((r) => [r.label, r.depth, r.under || null, r.sibling || null, r.connectors.map((c) => `${c.kind}@${c.level}`)]), [
    ["p", 0, null, "sibling of q", ["down@0", "link-out@0"]],
    ["a", 1, "under p", null, ["elbow@0", "line@0", "link-through@0"]],
    ["c", 1, "under p", null, ["elbow@0", "link-through@0"]],
    ["b", 1, "under p", null, ["link-through@0"]],
    ["q", 0, null, "sibling of p", ["link-in@0"]],
  ], "the relation words are unchanged: b is still under p");
  const dom = new JSDOM("<!doctype html><body></body>");
  const guides = treeGuides(dom.window.document, rows[3].connectors);
  assert.equal(guides.getAttribute("aria-hidden"), "true");
  assert.deepEqual([...guides.children].map((g) => g.className), ["ctx-guide link-through"], "the unjoined child: the sibling link beside it only");
  dom.window.close();
  // Without the feature, the palette draws no line either.
  const plain = paletteRows(unknown(MIXED), [], "", { openTerminal() {} }).filter((row) => row.group);
  assert.ok(plain.every((r) => r.connectors.length === 0));
});

// #1577 with #1579: the sidebar's main tree and its Background section are separate trees (roster-sections.mjs
// sidebarSections), so no line crosses between them; inside the Background section the lines and the order under a
// parent follow the related-work rule as anywhere else.
test("sections: no parent line crosses into the Background section; inside it, lines and order follow relatedWork", () => {
  const all = [
    known("lead"), known("dev-a", { parentInstance: "lead", relatedWork: true }),
    known("bg", { parentInstance: "lead", relatedWork: true, background: true }),
    known("bg-y", { parentInstance: "bg" }), known("bg-x", { parentInstance: "bg", relatedWork: true }), known("bg-z", { parentInstance: "bg", relatedWork: true }),
  ];
  const placement = backgroundPlacement(all, true);
  const { main, background } = sidebarSections(all, all, [], DESKTOP_TERMS, { placement, open: true });
  const rows = (sections) => sections.flatMap((s) => s.groups.flatMap((g) => g.clusters.map((c) => c.instances)));
  const drawn = (sections) => Object.assign({}, ...rows(sections).map((items) => lines(items, all)));
  assert.deepEqual(rows(main.length ? main : []).flat().map((i) => [i.instance, i.depth]), [["lead", 0], ["dev-a", 1]]);
  assert.deepEqual(drawn(main), { lead: ["down@0"], "dev-a": ["elbow@0"] }, "lead's line ends at dev-a: bg, related, is in the other section");
  assert.deepEqual(rows(background.sections).flat().map((i) => [i.instance, i.depth]), [["bg", 0], ["bg-x", 1], ["bg-z", 1], ["bg-y", 1]],
    "bg is a root of the Background section; under it the related children come first");
  assert.deepEqual(drawn(background.sections), { bg: ["down@0"], "bg-x": ["elbow@0", "line@0"], "bg-z": ["elbow@0"], "bg-y": [] },
    "no line from bg to lead; bg's line ends at its last joined child, bg-y keeps its indent");
});
