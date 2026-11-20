// Slice 1b of the Desktop UI rework: lines for same work (the spec's pinned acceptance, by name). Joan's decision of
// 2026-11-20, at Pepe's request, narrowing D26 ("no lines"): the roster draws the solid lineage elbow and stem from a
// parent to a child only when its host flags the child doing its parent's work (packages/client/same-work.mjs
// `sameWorkFlagged`), and the dotted sibling cue between declared siblings; a child without the flag is indented with
// no line. Executes the shipped roster paint (shell.mjs renderContextRoster) on the shipped index.html and shell.css.
// No shell startup, HTTP, Electron, CLI or session. The connectors' own rules are instance-tree.test.mjs's and
// same-work-lines.test.mjs's (the palette keeps `drawsParentLine`); their geometry is roster-spacing.test.mjs's.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { viewContext } from "./helpers/view-context.mjs";
import * as treeShared from "../../client/instance-tree.mjs";
import * as sameWork from "../../client/same-work.mjs";
import * as treeView from "../renderer/instance-tree-view.mjs";
import { instanceActions, captureInstanceActionMenu } from "../renderer/instance-actions.mjs";
import { instanceActionTarget } from "../renderer/instance-action-target.mjs";
import { instanceSplitPlan } from "../renderer/instance-split.mjs";
import { runtimeState, unsupportedSession } from "../../client/instance-presentation.mjs";
import { canAddressRemote, rowReason } from "../../client/remote-address.mjs";
import { iconElement, mountShellIcons } from "../renderer/shell-icons.mjs";
const tree = { ...treeShared, ...treeView, ...sameWork }; // the renderer's client imports, shipped

const read = name => readFileSync(new URL(`../renderer/${name}`, import.meta.url), "utf8");
const shell = read("shell.mjs"), html = read("index.html"), css = read("shell.css");
const fn = name => { const found = shell.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`)); assert.ok(found, name); return found[0]; };
const source = ["renderContextRoster", "needsInputMark", "pendingSpawnRow", "setRovingRow"].map(fn).join("\n");

const at = day => `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`;
/** A row of this computer, its host declaring instance-same-work (the panel's stamp, `sameWorkKnown`). */
const row = (name, day, extra = {}) => ({ instance: name, agent: "dev", home: `/synthetic/${name}`, agentsRoot: "/synthetic/agents",
  harness: "claude", running: true, createdAt: at(day), sameWorkKnown: true, ...extra });

/** The shipped roster paint in workspace "A". Every root drawn open unless `open` is false (roots then start
 * collapsed, #1970); pins shown when `pins` (feature instance-pin). */
function fixture(t, { open = true, pins = false } = {}) {
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  dom.window.requestAnimationFrame ??= cb => { cb(); return 0; };
  const doc = dom.window.document;
  mountShellIcons(doc);
  const style = doc.createElement("style"); style.textContent = css; doc.head.append(style);
  const context = {
    ...tree, ...viewContext(), document: doc, instanceActions, captureInstanceActionMenu, runtimeState, unsupportedSession, canAddressRemote, rowReason,
    iconElement, instanceActionTarget, instanceSplitPlan, connectionGeneration: 0, menuState() {}, sayInHint() {}, runAction: assert.fail,
    applyChordTitles() {}, updateActiveContexts() {}, getBinding: () => null, formatChord: c => c, isMac: true,
    contextRosterEl: doc.querySelector("#instance-roster"), contextWorkspace: "A", contextInstances: [],
    rosterState: { hasData: true, state: "ready" }, rosterStale: false, contextDeploymentNote: null,
    currentWorkspace: () => "A", workspaceGeneration: () => 0, collapsedInstances: new Set(),
    spawnJobs: { rows: () => [], announce: () => false, check() {} },
    tabs: new Map(), activeTab: null, tabOpenIntents: { applyFocus: f => f(), invalidate() {} },
    openTerminalTab() {}, openInstanceStart() {}, openLifecycleDialog: assert.fail, onRosterRowKey() {},
    api: assert.fail, showStage: assert.fail, refreshContextRoster: assert.fail, revealInScrollport() {},
    ...(open ? {} : { expandedInstances: new Set() }),
    pinsShown: () => pins,
  };
  context.splitOpenState = () => ({ split: null, activeId: null, tabs: context.tabs, workspace: "A", visible: false });
  context.ownsInstanceTarget = () => true;
  Object.defineProperty(context, "Date", { get: () => Date, enumerable: true });
  const s = runInNewContext(`${source}\n({ render: renderContextRoster })`, context);
  const list = doc.querySelector(".ctx-list");
  const render = rows => { context.contextInstances = rows; s.render(rows); };
  const rowEl = name => [...list.querySelectorAll(".ctx-inst")].find(b => b.querySelector(".ctx-name")?.dataset.name === name) ?? null;
  const wrap = name => rowEl(name).closest(".ctx-tree-row");
  /** A row's lines, `kind@level`, in the order drawn. */
  const lines = name => [...wrap(name).querySelectorAll(".ctx-guide")].map(g => `${g.className.replace("ctx-guide ", "")}@${g.style.getPropertyValue("--guide-level")}`);
  const drawn = () => [...list.querySelectorAll(".ctx-inst")].map(b => b.querySelector(".ctx-name").dataset.name);
  const depth = name => wrap(name).style.getPropertyValue("--depth");
  const words = name => rowEl(name).querySelector(".ctx-relation")?.textContent ?? null;
  return { context, doc, list, render, rowEl, wrap, lines, drawn, depth, words };
}

test("slice1b same-work child has a line", t => {
  const u = fixture(t);
  // p has a flagged child (a), an unflagged one (b), and under b a flagged grandchild (c).
  const rows = [row("p", 1), row("a", 2, { parentInstance: "p", sameWork: true }), row("b", 3, { parentInstance: "p" }),
    row("c", 4, { parentInstance: "b", sameWork: true })];
  u.render(rows);
  assert.deepEqual(u.drawn(), ["p", "a", "b", "c"], "the joined child first under its parent (same-work.mjs drawingFirst), as before");
  assert.deepEqual(Object.fromEntries(u.drawn().map(n => [n, u.lines(n)])), {
    p: ["down@0"], // the stem leaves p's dot to a's elbow, and ends there: it never passes b
    a: ["elbow@0"],
    b: ["down@1"], // no flag: indented, no elbow into p; its own stem leaves its dot to its flagged child
    c: ["elbow@1"],
  });
  assert.deepEqual(["p", "a", "b", "c"].map(u.depth), ["0", "1", "1", "2"], "the unflagged child is indented as the flagged one is");
  // The lines are drawing only: aria-hidden, and the words stay as slice 1 says them.
  for (const name of ["p", "a", "b", "c"]) for (const g of u.wrap(name).querySelectorAll(".ctx-guides")) assert.equal(g.getAttribute("aria-hidden"), "true");
  assert.equal(u.wrap("b").querySelector(".ctx-guides"), u.wrap("b").firstElementChild, "the guides lead the row, as before slice 1");
  assert.deepEqual(["p", "a", "b", "c"].map(u.words), [null, ", under p, same work", ", under p", ", under b, same work"]);
  // The geometry is main's before slice 1: 1.5px, the solid lineage one step right of the dot column.
  assert.match(css, /\.ctx-guide \{[^}]*left: calc\(13\.25px \+ var\(--tree-branch-offset\) \+ var\(--guide-level\) \* var\(--tree-step\)\);[^}]*border-left: 1\.5px solid var\(--tree-line\);/);
  // A host that doesn't declare the feature flags no child: every child indented, no line at all.
  u.render(rows.map(({ sameWorkKnown: _known, ...r }) => r));
  assert.equal(u.list.querySelector(".ctx-guide, .ctx-guides"), null, "no line without the flag");
  assert.deepEqual(["p", "a", "b", "c"].map(u.depth), ["0", "1", "1", "2"]);
  // A flag of any value but true is no flag.
  u.render([row("p", 1), row("a", 2, { parentInstance: "p", sameWork: "true" })]);
  assert.equal(u.list.querySelector(".ctx-guide"), null);
});

test("slice1b sibling dotted cue", t => {
  const u = fixture(t);
  // hub, and two siblings declared on it, one with an unflagged child; solo is unrelated.
  const rows = [row("hub", 1), row("s-one", 2, { siblingInstance: "hub" }), row("s-two", 3, { siblingInstance: "hub" }),
    row("kid", 4, { parentInstance: "s-two" }), row("solo", 5)];
  u.render(rows);
  assert.deepEqual(u.drawn(), ["solo", "s-two", "kid", "s-one", "hub"], "the bundle in the roster's order, newest first");
  assert.deepEqual(Object.fromEntries(u.drawn().map(n => [n, u.lines(n)])), {
    solo: [],
    "s-two": ["link-out@0"],
    kid: ["link-through@0"], // the dotted cue passes beside a child to the next sibling; the child itself has no line
    "s-one": ["link-in@0", "link-out@0"],
    hub: ["link-in@0"],
  });
  assert.equal(u.wrap("solo").querySelector(".ctx-guides"), null, "an unrelated row carries no guides");
  // Dotted, on the dot column, 2px left of its centre, in --tree-link (theme-contrast holds it at 3:1): as before.
  assert.match(css, /\.ctx-guide\.link-in, \.ctx-guide\.link-out, \.ctx-guide\.link-through \{ left: calc\(13\.25px - var\(--tree-link-shift, 0px\) \+ var\(--guide-level\) \* var\(--tree-step\)\);\s*border-left: 1\.5px dotted var\(--tree-link\); \}/);
  // The words stay.
  assert.equal(u.words("hub"), ", sibling of s-two and s-one");
  assert.equal(u.words("kid"), ", under s-two");
});

test("slice1b collapsed and pinned unchanged", t => {
  // #1970: a root with children starts collapsed: no line runs into the rows it hides, and its disclosure says them.
  const c = fixture(t, { open: false });
  const rows = [row("p", 1), row("a", 2, { parentInstance: "p", sameWork: true }), row("b", 3, { parentInstance: "p" })];
  c.render(rows);
  assert.deepEqual(c.drawn(), ["p"]);
  assert.deepEqual(c.lines("p"), [], "no stem into hidden rows");
  assert.equal(c.wrap("p").querySelector(".ctx-guides"), null);
  assert.equal(c.rowEl("p").getAttribute("aria-expanded"), "false");
  assert.ok(c.rowEl("p").querySelector(".ctx-name-line > .ctx-disclosure:first-child"), "the chevron, first on the name line");
  assert.equal(c.rowEl("p").querySelector(".ctx-disclosure-count").textContent, "2", "N below");
  // Opened, the lines are drawn.
  c.context.expandedInstances.add(tree.collapseKey("A", tree.instanceId(rows[0])));
  c.render(rows);
  assert.deepEqual(["p", "a", "b"].map(c.lines), [["down@0"], ["elbow@0"], []]);

  // #1974: a pinned row keeps its line when it has the flag; a pinned row without it has none, and the joined child
  // stays first, so the stem never passes it.
  const p = fixture(t, { pins: true });
  const pinned = [row("p", 1), row("a", 2, { parentInstance: "p", sameWork: true, pinned: true }), row("b", 3, { parentInstance: "p", pinned: true }),
    row("d", 4, { parentInstance: "p", sameWork: true })];
  p.render(pinned);
  assert.deepEqual(p.drawn(), ["p", "a", "d", "b"], "drawingFirst, then the pin, then the roster's order (#1974)");
  assert.deepEqual(Object.fromEntries(p.drawn().map(n => [n, p.lines(n)])), { p: ["down@0"], a: ["elbow@0", "line@0"], d: ["elbow@0"], b: [] });
  for (const name of ["a", "b"]) assert.ok(p.rowEl(name).querySelector(".ctx-pin"), `${name}: its pin mark, as #1974 draws it`);
});
