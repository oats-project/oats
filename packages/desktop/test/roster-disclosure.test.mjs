// The disclosure's pure rules (roster-disclosure.mjs, the product owner, 2026-11-19): which rows have children in
// their own section, which rows are drawn collapsed (those closed by hand, and the roots of each section not opened
// by hand), how many rows sit under a row, and how opening or closing a row by hand is kept.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { collapseKey, instanceId } from "../../client/instance-tree.mjs";
import { sectionChildren, collapsedRows, rowsUnder, rowDisclosure, setRowOpen } from "../renderer/roster-disclosure.mjs";

const at = (instance, parentInstance, extra = {}) => ({ instance, parentInstance, agent: "dev", home: `/w/${instance}`, agentsRoot: "/w", ...extra });
const ROWS = [at("lead"), at("mid", "lead"), at("tip", "mid"), at("side", "lead"), at("solo")];
const one = () => "main";
const id = name => instanceId(ROWS.find(r => r.instance === name) ?? { instance: name, home: `/w/${name}`, agentsRoot: "/w" });
const keys = (...names) => new Set(names.map(name => collapseKey("A", id(name))));

test("sectionChildren: each parent's children, and no entry for a row with none", () => {
  const children = sectionChildren(ROWS, one);
  assert.deepEqual([...children.keys()], [id("lead"), id("mid")]);
  assert.deepEqual(children.get(id("lead")), [id("mid"), id("side")]);
  assert.deepEqual(children.get(id("mid")), [id("tip")]);
});

test("sectionChildren: a child painted in another section is a root there, and its parent has nothing to collapse for it", () => {
  const section = row => (row.instance === "side" || row.instance === "kid" ? "background" : "main");
  const rows = [...ROWS, at("kid", "solo")];
  const children = sectionChildren(rows, section);
  assert.deepEqual(children.get(id("lead")), [id("mid")], "side is in the Background section");
  assert.equal(children.has(id("solo")), false, "solo's only child is in another section");
});

test("collapsedRows: by default every root with children is collapsed, and a row under a root is not", () => {
  const children = sectionChildren(ROWS, one);
  assert.deepEqual(collapsedRows("A", { collapsed: new Set(), expanded: new Set(), children }), keys("lead"));
});

test("collapsedRows: a root opened by hand is open; a row closed by hand is closed, root or not", () => {
  const children = sectionChildren(ROWS, one);
  assert.deepEqual(collapsedRows("A", { collapsed: new Set(), expanded: keys("lead"), children }), new Set());
  assert.deepEqual(collapsedRows("A", { collapsed: keys("mid"), expanded: keys("lead"), children }), keys("mid"));
  // Another workspace's choices never open this one's roots.
  assert.deepEqual(collapsedRows("A", { collapsed: new Set(), expanded: new Set([collapseKey("B", id("lead"))]), children }), keys("lead"));
});

test("collapsedRows: a root its lifecycle takes (startsOpen) starts open; closed by hand, it is closed", () => {
  const children = sectionChildren(ROWS, one);
  const startsOpen = rowId => rowId === id("lead");
  assert.deepEqual(collapsedRows("A", { collapsed: new Set(), expanded: new Set(), children, startsOpen }), new Set());
  assert.deepEqual(collapsedRows("A", { collapsed: keys("lead"), expanded: new Set(), children, startsOpen }), keys("lead"));
});

test("collapsedRows: a root of the Background section starts collapsed too", () => {
  const section = row => (["side", "kid"].includes(row.instance) ? "background" : "main");
  const rows = [...ROWS, at("kid", "side")];
  const children = sectionChildren(rows, section);
  assert.deepEqual(collapsedRows("A", { collapsed: new Set(), expanded: new Set(), children }), new Set([...keys("lead"), collapseKey("A", id("side"))]));
});

test("rowsUnder: every row under a row, at every depth, and a cycle counts each row once", () => {
  const children = sectionChildren(ROWS, one);
  assert.equal(rowsUnder(children, id("lead")), 3);
  assert.equal(rowsUnder(children, id("mid")), 1);
  assert.equal(rowsUnder(children, id("solo")), 0);
  const loop = new Map([["a", ["b"]], ["b", ["a", "c"]]]);
  assert.equal(rowsUnder(loop, "a"), 2);
});

test("setRowOpen: opening moves a key out of the closed set and into the opened one; closing the other way", () => {
  const state = { collapsed: new Set(["k"]), expanded: new Set() };
  setRowOpen(state, "k", true);
  assert.deepEqual([[...state.collapsed], [...state.expanded]], [[], ["k"]]);
  setRowOpen(state, "k", false);
  assert.deepEqual([[...state.collapsed], [...state.expanded]], [["k"], []]);
});

test("rowDisclosure: a chevron, the count hidden from assistive tech, and the words a screen reader hears", t => {
  const dom = new JSDOM("<!doctype html><body></body>");
  t.after(() => dom.window.close());
  const mark = rowDisclosure(dom.window.document, { count: 3 });
  assert.equal(mark.className, "ctx-disclosure");
  assert.deepEqual([...mark.children].map(el => el.getAttribute("class")), ["shell-icon ctx-disclosure-chevron", "ctx-disclosure-count", "sr-only"]);
  assert.equal(mark.children[0].getAttribute("aria-hidden"), "true");
  assert.equal(mark.children[1].textContent, "3");
  assert.equal(mark.children[1].getAttribute("aria-hidden"), "true");
  assert.equal(mark.children[2].textContent, ", 3 below");
});
