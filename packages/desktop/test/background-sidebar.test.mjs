// The sidebar's Background section (#1579): the shipped roster paint (shell.mjs renderContextRoster), its heading
// (background-heading.mjs), the tree keys (onRosterRowKey) and the open state (setBackgroundOpen), run against a
// stub store. Only while this computer's CLI lists the kernel's feature: one heading at the very end of the list,
// closed by default, its own tree when open, the roll-up's Needs input mark while a row in it waits, the steps and
// the focus following the rows drawn. No shell startup, HTTP, Electron, CLI or session.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { viewContext } from "./helpers/view-context.mjs";
import * as treeShared from "../../client/instance-tree.mjs";
import * as treeView from "../renderer/instance-tree-view.mjs";
import * as sameWork from "../../client/same-work.mjs";
import { instanceActions, captureInstanceActionMenu } from "../renderer/instance-actions.mjs";
import { instanceActionTarget } from "../renderer/instance-action-target.mjs";
import { instanceSplitPlan } from "../renderer/instance-split.mjs";
import { runtimeState, unsupportedSession } from "../../client/instance-presentation.mjs";
import { canAddressRemote, rowReason } from "../../client/remote-address.mjs";
import { iconElement } from "../renderer/shell-icons.mjs";
import { setTabTitle } from "../renderer/tab-a11y.mjs";
import { NO_ANSWER_CODE, unservedError } from "../renderer/deployment-header.mjs";
import { rosterKeyAction, moveTarget } from "../renderer/roster-keys.mjs";
import { revealInScrollport } from "../renderer/reveal-in-scrollport.mjs";
import { rosterStep } from "../renderer/leader-dispatch.mjs";
const tree = { ...treeShared, ...treeView, ...sameWork };

const read = name => readFileSync(new URL(`../renderer/${name}`, import.meta.url), "utf8");
const html = read("index.html"), shell = read("shell.mjs");
const fn = name => shell.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
const source = ["renderContextRoster", "activateRosterRow", "needsInputMark", "setBackgroundOpen", "onRosterRowKey", "setRovingRow", "showInRoster", "showPendingSpawn", "revealPendingSpawn"]
  .map(name => { const s = fn(name); assert.ok(s, name); return shell.includes(`async ${s}`) ? `async ${s}` : s; }).join("\n");
// The previous / next instance steps read the rows drawn, by the shipped selector (shell.mjs leaderDispatch rosterRows).
const STEP_ROWS = shell.match(/rosterRows: \(\) => \[\.\.\.\(contextRosterEl\?\.querySelectorAll\("([^"]+)"\)/)?.[1];

const CLAIM = { since: "2026-10-27T09:00:00.000Z", producer: "claude-hooks", reason: "permission", message: null };
const at = (name, extra = {}) => ({ instance: name, agent: "dev", home: `/synthetic/${name}`, agentsRoot: "/synthetic/agents",
  repoName: "desktop-repo", running: true, runtimeState: "running", ...extra });
// lead (main) → maint (background) → expert → helper; solo (main); cron (a background root of its own).
const ROSTER = [
  at("lead"),
  at("maint", { parentInstance: "lead", background: true }),
  at("expert", { parentInstance: "maint" }),
  at("helper", { parentInstance: "expert" }),
  at("solo"),
  at("cron", { background: true }),
];
const waits = (roster, name) => roster.map(r => (r.instance === name ? { ...r, waitingOnYou: CLAIM } : r));

function fixture(t, { feature = true, deployments = [] } = {}) {
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const context = {
    ...tree, ...viewContext(), document: doc, instanceActions, captureInstanceActionMenu, runtimeState, unsupportedSession, canAddressRemote, rowReason,
    iconElement, setTabTitle, NO_ANSWER_CODE, unservedError, instanceActionTarget, instanceSplitPlan,
    connectionGeneration: 0, menuState() {}, sayInHint() {}, runAction: assert.fail,
    applyChordTitles() {}, updateActiveContexts() {}, getBinding: () => null, formatChord: c => c, isMac: true,
    contextRosterEl: doc.querySelector("#instance-roster"), contextWorkspace: "A", contextInstances: [], contextDeployments: deployments,
    rosterState: { hasData: true, state: "ready" }, rosterStale: false, contextDeploymentNote: null,
    currentWorkspace: () => "A", workspaceGeneration: () => 0, collapsedInstances: new Set(),
    spawnJobs: { rows: () => [], announce: () => false, check() {} },
    tabs: new Map(), activeTab: null, tabOpenIntents: { applyFocus: f => f(), invalidate() {} },
    openTerminalTab() {}, openInstanceStart() {}, openLifecycleDialog: assert.fail,
    api: assert.fail, showStage: assert.fail, refreshContextRoster: assert.fail,
    rosterKeyAction, moveTarget, revealInScrollport,
    // The row menu's Background actions (another part of #1579): none offered here.
    backgroundMenu: { items: () => [], handles: () => false, run: assert.fail },
    // The kernel's feature on this computer's CLI, and this window's open sections (shell.mjs backgroundShown, backgroundOpen).
    backgroundShown: () => feature, backgroundOpen: new Set(),
  };
  context.splitOpenState = () => ({ split: null, activeId: null, tabs: context.tabs, workspace: "A", visible: false });
  context.ownsInstanceTarget = () => true;
  Object.defineProperty(context, "Date", { get: () => Date, enumerable: true });
  const s = runInNewContext(`${source}\n({ renderContextRoster, setBackgroundOpen, onRosterRowKey, showInRoster, showPendingSpawn })`, context);
  const list = doc.querySelector(".ctx-list");
  const render = rows => { context.contextInstances = rows; s.renderContextRoster(rows); };
  const heading = () => list.querySelector(".ctx-background-toggle");
  const rowEl = name => [...list.querySelectorAll(".ctx-inst")].find(b => b.querySelector(".ctx-name")?.dataset.name === name) ?? null;
  // The rows drawn, in order, with their depths; the heading as "|Background|".
  const drawn = () => [...list.querySelectorAll(".ctx-inst, .ctx-background-toggle")].map(el => (el.classList.contains("ctx-background-toggle") ? "|Background|"
    : `${el.querySelector(".ctx-name").dataset.name}@${el.closest(".ctx-tree-row").style.getPropertyValue("--depth")}`));
  const key = (el, k) => el.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  return { doc, dom, context, s, list, render, heading, rowEl, drawn, key };
}

test("without the kernel's feature nothing moves: no heading, a stray field ignored, the tree as before", t => {
  const u = fixture(t, { feature: false });
  u.render(ROSTER);
  assert.equal(u.heading(), null);
  assert.equal(u.list.querySelector(".ctx-background"), null);
  assert.deepEqual(u.drawn(), ["cron@0", "lead@0", "maint@1", "expert@2", "helper@3", "solo@0"]);
});

test("with the feature but no background row: no heading", t => {
  const u = fixture(t);
  u.render([at("lead"), at("solo", { parentInstance: "lead" })]);
  assert.equal(u.heading(), null);
  assert.deepEqual(u.drawn(), ["lead@0", "solo@1"]);
});

test("one heading at the very end of the list, closed by default, with the count and its name", t => {
  const u = fixture(t);
  u.render(ROSTER);
  assert.deepEqual(u.drawn(), ["lead@0", "solo@0", "|Background|"]);
  const head = u.heading(), wrap = head.parentElement;
  assert.equal(u.list.lastElementChild, wrap, "the very end of the list");
  assert.equal(u.list.querySelectorAll(".ctx-background").length, 1);
  // The machine heading's type and role, with a real button for the disclosure.
  assert.deepEqual([wrap.className, wrap.getAttribute("role"), wrap.getAttribute("aria-level")], ["ctx-deployment ctx-background", "heading", "3"]);
  assert.equal(head.tagName, "BUTTON");
  assert.equal(head.type, "button");
  assert.equal(head.getAttribute("aria-expanded"), "false");
  assert.equal(head.getAttribute("aria-label"), "Background, 4 instances");
  assert.equal(head.querySelector(".ctx-background-count").textContent, "4");
  assert.ok(head.querySelector("svg.ctx-background-chevron"), "the chevron");
  assert.equal(head.querySelector(".ctx-attn"), null, "nothing waits");
  // A main row whose only children are in the section has nothing to collapse here.
  assert.equal(u.rowEl("lead").hasAttribute("aria-expanded"), false);
});

test("click, Enter and Space toggle it; open, the section is its own tree", t => {
  const u = fixture(t);
  u.render(ROSTER);
  u.heading().click();
  assert.equal(u.heading().getAttribute("aria-expanded"), "true");
  // maint is a root of the section though its parent (lead) is in the main tree; its foreground child nests under it.
  assert.deepEqual(u.drawn(), ["lead@0", "solo@0", "|Background|", "cron@0", "maint@0", "expert@1", "helper@2"]);
  assert.equal(u.rowEl("maint").getAttribute("aria-expanded"), "true", "its children are in its own section");
  u.heading().focus();
  u.key(u.heading(), "Enter");
  assert.equal(u.heading().getAttribute("aria-expanded"), "false");
  assert.equal(u.doc.activeElement, u.heading(), "the heading keeps the focus across the repaint");
  assert.deepEqual(u.drawn(), ["lead@0", "solo@0", "|Background|"]);
  u.key(u.heading(), " ");
  assert.equal(u.heading().getAttribute("aria-expanded"), "true");
  assert.equal(u.doc.activeElement, u.heading());
  // Right on an open heading moves down; Left closes it, and Left on a closed one does nothing.
  u.key(u.heading(), "ArrowRight");
  assert.equal(u.doc.activeElement, u.rowEl("cron"));
  u.heading().focus();
  u.key(u.heading(), "ArrowLeft");
  assert.equal(u.heading().getAttribute("aria-expanded"), "false");
  u.key(u.heading(), "ArrowLeft");
  assert.equal(u.heading().getAttribute("aria-expanded"), "false");
  assert.equal(u.doc.activeElement, u.heading());
  u.key(u.heading(), "ArrowRight");
  assert.equal(u.heading().getAttribute("aria-expanded"), "true");
});

test("the roving keys reach the heading: Up and Down, Left from a section root, one tab stop", t => {
  const u = fixture(t);
  u.render(ROSTER);
  u.s.setBackgroundOpen("A", true);
  u.rowEl("solo").focus();
  u.key(u.rowEl("solo"), "ArrowDown");
  assert.equal(u.doc.activeElement, u.heading());
  assert.deepEqual([...u.list.querySelectorAll('[tabindex="0"]')], [u.heading()], "one stop");
  u.key(u.heading(), "ArrowDown");
  assert.equal(u.doc.activeElement, u.rowEl("cron"));
  u.key(u.rowEl("cron"), "ArrowUp");
  assert.equal(u.doc.activeElement, u.heading());
  // Left on a section root steps to the heading: cron (no parent), and maint (its parent, lead, is in the main
  // tree: never across), once its first Left has collapsed it.
  u.rowEl("cron").focus();
  u.key(u.rowEl("cron"), "ArrowLeft");
  assert.equal(u.doc.activeElement, u.heading());
  u.rowEl("maint").focus();
  u.key(u.rowEl("maint"), "ArrowLeft");
  assert.equal(u.rowEl("maint").getAttribute("aria-expanded"), "false");
  assert.equal(u.doc.activeElement, u.rowEl("maint"));
  u.key(u.rowEl("maint"), "ArrowLeft");
  assert.equal(u.doc.activeElement, u.heading());
  u.key(u.rowEl("maint"), "ArrowRight");
  // Inside the section, Left still steps to the parent.
  u.rowEl("helper").focus();
  u.key(u.rowEl("helper"), "ArrowLeft");
  assert.equal(u.doc.activeElement, u.rowEl("expert"));
});

test("Needs input on the heading while a row in the section waits, closed and open; none for a main row's wait", t => {
  const u = fixture(t);
  const mark = () => u.heading().querySelector(".ctx-attn");
  u.render(waits(ROSTER, "helper"));
  assert.ok(mark(), "closed: the heading carries the mark");
  assert.equal(mark().textContent, "Needs input", "the fixed words, no time");
  assert.ok(mark().querySelector(":scope > svg.attn-mark"), "the needs-input icon: text and icon, never colour alone");
  assert.equal(u.heading().getAttribute("aria-label"), "Background, 4 instances, needs input");
  // Open: the heading keeps it, and the row shows its own mark.
  u.s.setBackgroundOpen("A", true);
  assert.ok(mark(), "open: still on the heading");
  assert.ok(u.rowEl("helper").querySelector(".ctx-dot.waiting"), "the row's own mark");
  // A collapsed background parent rolls up the waits it hides, inside the section.
  u.context.collapsedInstances.add(tree.collapseKey("A", tree.instanceId(ROSTER[1])));
  u.render(waits(ROSTER, "helper"));
  assert.equal(u.rowEl("maint").querySelector(".ctx-attn")?.textContent, "1 below need input");
  // A collapsed main parent never rolls up a background row's wait.
  u.context.collapsedInstances.clear();
  u.context.collapsedInstances.add(tree.collapseKey("A", tree.instanceId(ROSTER[0])));
  u.render(waits(ROSTER, "maint"));
  assert.equal(u.rowEl("lead").querySelector(".ctx-attn"), null);
  assert.ok(u.rowEl("maint"), "a main collapse hides nothing in the section");
  // A main row's wait is not the section's.
  u.context.collapsedInstances.clear();
  u.render(waits(ROSTER, "solo"));
  assert.equal(mark(), null);
  assert.equal(u.heading().getAttribute("aria-label"), "Background, 4 instances");
});

test("every instance background: the heading alone, never “No agents yet”", t => {
  const u = fixture(t);
  u.render([at("a", { background: true }), at("b", { parentInstance: "a" })]);
  assert.equal(u.list.querySelector(".ctx-empty"), null);
  assert.doesNotMatch(u.list.textContent, /No instances/);
  assert.deepEqual(u.drawn(), ["|Background|"]);
  assert.equal(u.heading().tabIndex, 0, "the list's tab stop");
  u.render([]);
  assert.equal(u.list.textContent, "No agents yet", "an empty roster still says so");
});

test("the open state is per workspace, kept across repaints, closed for a workspace never opened", t => {
  const u = fixture(t);
  u.render(ROSTER);
  u.heading().click();
  u.render(ROSTER);
  u.render([...ROSTER]);
  assert.equal(u.heading().getAttribute("aria-expanded"), "true", "a repaint keeps it");
  assert.deepEqual([...u.context.backgroundOpen], ["A"]);
  // Another workspace's roster on screen: its own state, closed.
  u.context.contextWorkspace = "B"; u.context.currentWorkspace = () => "B";
  u.render(ROSTER);
  assert.equal(u.heading().getAttribute("aria-expanded"), "false");
  u.context.contextWorkspace = "A"; u.context.currentWorkspace = () => "A";
  u.render(ROSTER);
  assert.equal(u.heading().getAttribute("aria-expanded"), "true");
});

test("previous / next instance steps follow the rows drawn: closed background rows are skipped", t => {
  const u = fixture(t);
  assert.ok(STEP_ROWS, "the shipped rosterRows selector");
  const rows = () => [...u.context.contextRosterEl.querySelectorAll(STEP_ROWS)].map(r => ({ id: r.dataset.treeInstance, openable: r.getAttribute("aria-disabled") !== "true" }));
  const id = name => tree.instanceId(ROSTER.find(r => r.instance === name));
  const name = row => ROSTER.find(r => tree.instanceId(r) === row?.id)?.instance ?? null;
  u.render(ROSTER);
  assert.equal(name(rosterStep(rows(), id("solo"), 1)), null, "nothing after the main tree while closed");
  assert.equal(name(rosterStep(rows(), null, -1)), "solo", "the last drawn row");
  u.s.setBackgroundOpen("A", true);
  assert.equal(name(rosterStep(rows(), id("solo"), 1)), "cron", "open: the section's rows are steps");
});

test("a focused row the repaint moves into the closed section hands its focus to the heading", t => {
  const u = fixture(t);
  const before = [at("lead"), at("x"), at("y", { background: true })];
  u.render(before);
  u.rowEl("x").focus();
  assert.equal(u.doc.activeElement, u.rowEl("x"));
  u.render([at("lead"), at("x", { background: true }), at("y", { background: true })]);
  assert.equal(u.doc.activeElement, u.heading());
  assert.equal(u.heading().tabIndex, 0);
  // Open, the row is drawn: it keeps the focus.
  u.s.setBackgroundOpen("A", true);
  u.rowEl("x").focus();
  u.render([at("lead"), at("x", { background: true }), at("y", { background: true })]);
  assert.equal(u.doc.activeElement, u.rowEl("x"));
});

test("the selected row in the closed section gives the heading the roster's tab stop; the section stays closed", t => {
  const u = fixture(t);
  const tab = { kind: "terminal", workspace: "A", key: tree.terminalKey("A", ROSTER[5]) };
  u.context.tabs.set(1, tab); u.context.activeTab = 1;
  u.render(ROSTER);
  assert.equal(u.heading().getAttribute("aria-expanded"), "false");
  assert.deepEqual([...u.list.querySelectorAll('[tabindex="0"]')], [u.heading()]);
});

test("no relation crosses the parts: a section root is a root (no indent, no \"under\"), and the roster draws no lines", t => {
  const u = fixture(t);
  u.render(ROSTER);
  u.s.setBackgroundOpen("A", true);
  // Slice 1 (D26): no lineage or sibling lines; indentation and the relations in words show the tree.
  assert.equal(u.list.querySelector(".ctx-guide, .ctx-guides"), null, "no lines");
  const depth = name => u.rowEl(name).closest(".ctx-tree-row").style.getPropertyValue("--depth");
  const words = name => u.rowEl(name).querySelector(".ctx-relation")?.textContent ?? null;
  // lead's only child is in the section: nothing of lead's says it has one here.
  assert.equal(u.rowEl("lead").hasAttribute("aria-expanded"), false, "no disclosure for a child of the other part");
  // maint is a root of the section: no indent, no "under lead"; expert is under it.
  assert.deepEqual([depth("maint"), words("maint")], ["0", null]);
  assert.deepEqual([depth("expert"), words("expert")], ["1", ", under maint"]);
});

test("two deployments: the section keeps the machine sub-headings, a level under the heading", t => {
  const deployments = [{ id: "here", machine: "this computer", local: true, reachable: true, primary: true }, { id: "far", machine: "far", local: false, reachable: true }];
  const u = fixture(t, { deployments });
  const roster = [at("a", { deployment: { id: "here" }, background: true }), at("b", { deployment: { id: "far" }, background: true }), at("c", { deployment: { id: "far" } })];
  u.render(roster);
  u.s.setBackgroundOpen("A", true);
  const headings = [...u.list.querySelectorAll('[role="heading"]')].map(h => [h.classList.contains("ctx-background") ? "Background" : h.dataset.deployment, h.getAttribute("aria-level")]);
  assert.deepEqual(headings, [["far", "3"], ["Background", "3"], ["here", "4"], ["far", "4"]]);
  assert.equal(u.heading().getAttribute("aria-label"), "Background, 2 instances");
});

test("an explicit ask to see a row opens the section: Show in roster and Show its row (the expert, 2026-10-27)", async t => {
  const u = fixture(t);
  u.render(ROSTER);
  assert.equal(u.heading().getAttribute("aria-expanded"), "false");
  const helper = ROSTER.find(r => r.instance === "helper");
  // A background row's ancestors are folded: Show in roster opens the section and them, and focuses the row.
  u.context.collapsedInstances.add(treeShared.collapseKey("A", treeShared.instanceId(ROSTER.find(r => r.instance === "maint"))));
  assert.equal(await u.s.showInRoster({ home: helper.home }), true);
  assert.equal(u.heading().getAttribute("aria-expanded"), "true");
  assert.equal(u.doc.activeElement, u.rowEl("helper"));
  // Show its row: a pending spawn the decision binds background is drawn in the section, which opens for it.
  u.s.setBackgroundOpen("A", false);
  const pending = { id: "spawn-1", instance: "newbie", agent: "dev", agentsRoot: "/synthetic/agents", home: "/synthetic/newbie", background: true,
    deployment: { id: "A" }, pending: "spawning", startedAt: 0 };
  u.context.spawnJobs = { rows: () => [pending], reveal: () => true, announce: () => false, check() {}, isNew: () => false, seen() {} };
  // The pending row's own drawing is Spec C's (shell.mjs pendingSpawnRow): a stand-in with the row's identity and name.
  u.context.pendingSpawnRow = i => {
    const wrap = u.doc.createElement("div"); wrap.className = "ctx-tree-row"; wrap.style.setProperty("--depth", String(i.depth || 0));
    const row = u.doc.createElement("button"); row.className = "ctx-inst"; row.dataset.treeInstance = treeShared.instanceId(i);
    const name = u.doc.createElement("span"); name.className = "ctx-name"; name.dataset.name = i.instance;
    row.append(name); wrap.append(row); return wrap;
  };
  u.render(ROSTER);
  assert.equal(u.drawn().includes("newbie@0"), false, "closed: the pending row is in the section");
  assert.equal(u.s.showPendingSpawn("spawn-1"), true);
  assert.equal(u.heading().getAttribute("aria-expanded"), "true");
  assert.ok(u.drawn().indexOf("newbie@0") > u.drawn().indexOf("|Background|"), "the pending row stands in the section");
});

test("the focused heading going away (its last row moved out, or the feature withdrawn) leaves the focus in the roster (review round 1)", t => {
  for (const after of [[at("lead"), at("solo"), at("bg")], "withdrawn"]) {
    const u = fixture(t);
    const before = [at("lead"), at("solo"), at("bg", { background: true })];
    u.render(before);
    u.heading().focus();
    if (after === "withdrawn") u.context.backgroundShown = () => false;
    assert.doesNotThrow(() => u.render(after === "withdrawn" ? before : after), String(after));
    assert.equal(u.heading(), null);
    // The row drawn last (the one above the heading) takes the focus, and it is the one tab stop.
    const rows = [...u.list.querySelectorAll(".ctx-inst")];
    assert.equal(u.doc.activeElement, rows.at(-1), String(after));
    assert.deepEqual(rows.filter(r => r.tabIndex === 0), [rows.at(-1)]);
  }
});
