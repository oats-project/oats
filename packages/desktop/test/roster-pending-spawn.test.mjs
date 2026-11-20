// Spec C: a background spawn's pending row in the sidebar roster. Executes the shipped roster
// render (shell.mjs renderContextRoster + pendingSpawnRow + announceSpawn) against a stub store;
// no shell startup, HTTP, Electron, CLI or session.
import test from "node:test";
import { viewContext } from "./helpers/view-context.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import * as treeShared from "../../client/instance-tree.mjs";
import * as relatedWork from "../../client/related-work.mjs";
import * as treeView from "../renderer/instance-tree-view.mjs";
const tree = { ...treeShared, ...treeView, ...relatedWork }; // the renderer's client imports, shipped
import { instanceActions, captureInstanceActionMenu } from "../renderer/instance-actions.mjs";
import { instanceActionTarget, sameInstanceActionTarget } from "../renderer/instance-action-target.mjs";
import { instanceSplitPlan } from "../renderer/instance-split.mjs";
import { runtimeState, unsupportedSession } from "../../client/instance-presentation.mjs";
import { canAddressRemote, rowReason } from "../../client/remote-address.mjs";
import { spokenText } from "./helpers/spoken-text.mjs";

const read = name => readFileSync(new URL(`../renderer/${name}`, import.meta.url), "utf8");
const css = read("shell.css"), html = read("index.html"), shell = read("shell.mjs");
const fn = name => shell.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
const source = ["renderContextRoster", "pendingSpawnRow", "announceSpawn"].map(name => { const s = fn(name); assert.ok(s, name); return s; }).join("\n");
const instance = (name, parentInstance, extra = {}) => ({ instance: name, parentInstance, agent: "dev",
  home: `/synthetic/${name}`, agentsRoot: "/synthetic/agents", repoName: "desktop-repo", running: true, ...extra });
const roster = [instance("root"), instance("child-a", "root"), instance("solo")];
const pending = (extra = {}) => ({ id: "spawn-1", instance: "dev-new", home: "/synthetic/dev-new", agent: "dev", agentsRoot: "/synthetic/agents",
  parentInstance: "root", pending: "spawning", ...extra });

function fixture(t, rows, extra = {}) {
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const announced = new Set(), checked = [];
  const context = {
    ...tree, document: doc, instanceActions, captureInstanceActionMenu, runtimeState, unsupportedSession, canAddressRemote, rowReason,
    instanceActionTarget, instanceSplitPlan, connectionGeneration: 0, menuState() {}, sayInHint() {}, runAction: assert.fail,
    applyChordTitles() {}, updateActiveContexts() {}, getBinding: () => null, formatChord: c => c, isMac: true,
    contextRosterEl: doc.querySelector("#instance-roster"), contextWorkspace: "A",
    rosterState: { hasData: true, state: "ready" }, rosterStale: false, contextDeploymentNote: null, ...viewContext(),
    currentWorkspace: () => "A", workspaceGeneration: () => 0, collapsedInstances: new Set(),
    
    spawnJobs: { rows: ws => ws === "A" ? rows() : [], announce: id => !announced.has(id) && !!announced.add(id), check: id => checked.push(id), ...(extra.jobs || {}) },
    tabs: new Map(), activeTab: null, tabOpenIntents: { applyFocus: f => f() },
    // A pending row opens nothing: any navigation is a test failure.
    openTerminalTab: assert.fail, openInstanceStart: assert.fail, openLifecycleDialog: assert.fail, onRosterRowKey() {},
    api: assert.fail, showStage: assert.fail, refreshContextRoster: assert.fail,
    ...(extra.context || {}),
  };
  context.splitOpenState = () => ({ split: null, activeId: null, tabs: context.tabs, workspace: "A", visible: false });
  context.ownsInstanceTarget = target => roster.filter(row => sameInstanceActionTarget(target, row, "A")).length === 1;
  const render = runInNewContext(`${source}\nrenderContextRoster`, context);
  const list = doc.querySelector(".ctx-list");
  const row = name => [...list.querySelectorAll(".ctx-inst")].find(b => b.querySelector(".ctx-name")?.dataset.name === name);
  return { doc, render, list, row, checked, live: () => doc.querySelector("#instance-roster > .ctx-spawn-live") };
}

test("a pending spawn shows under its parent: “Spawning…” text and a spinner, opens nothing, no actions; the count stays the kernel’s", async t => {
  const u = fixture(t, () => [pending()]);
  u.render(roster);
  const button = u.row("dev-new");
  assert.ok(button, "the pending row is painted");
  const names = [...u.list.querySelectorAll(".ctx-name")].map(n => n.dataset.name);
  assert.ok(names.indexOf("dev-new") > names.indexOf("root") && names.indexOf("dev-new") < names.indexOf("solo"), "in its parent's group");
  assert.equal(button.closest(".ctx-tree-row").style.getPropertyValue("--depth"), "1", "one level under root");
  assert.equal(button.querySelector(".ctx-spawn-state").textContent, "Spawning…");
  assert.equal(button.querySelector(".ctx-spawn-spinner").getAttribute("aria-hidden"), "true", "the text carries the state; the spinner is decoration");
  assert.equal(button.getAttribute("aria-disabled"), "true"); assert.match(button.getAttribute("aria-description"), /being spawned/);
  assert.equal(button.dataset.treeInstance, "/synthetic/dev-new", "the real row's identity");
  button.click(); // openTerminalTab / openInstanceStart would fail the test
  // No live-instance actions: no ⋯ trigger (no row has one, #1559) and no context menu (a pending row is not an instance yet).
  assert.equal(button.closest(".ctx-tree-row").querySelector(".ctx-instance-actions, .ctx-instance-menu"), null, "no live-instance actions");
  assert.match(u.doc.querySelector(".ctx-count").textContent, /^3 running$/, "the pending row is not counted");
});

// A pending row is never flagged (the Desktop's spawn records no related work); it takes its parent's gate
// (related-work.mjs withParentGate), which orders it after the joined children. It draws no line of its own; a
// pending child keeps its indent and says "under <parent>", without "related work".
test("a pending spawn under a parent: listed after the joined children, indented, said under its parent, no line of its own", async t => {
  const declared = roster.map(row => ({ ...row, relatedWorkKnown: relatedWork.RELATED_WORK_FEATURE, ...(row.instance === "child-a" ? { relatedWork: true } : {}) }));
  const u = fixture(t, () => [pending()]);
  u.render(declared);
  const names = [...u.list.querySelectorAll(".ctx-name")].map(n => n.dataset.name);
  assert.deepEqual(names.slice(0, 3), ["root", "child-a", "dev-new"], "the joined child first, the pending row after it");
  const guides = name => [...u.row(name).closest(".ctx-tree-row").querySelectorAll(":scope > .ctx-guides > .ctx-guide")].map(g => g.className.replace("ctx-guide ", ""));
  assert.deepEqual(["root", "child-a", "dev-new"].map(guides), [["down"], ["elbow"], []], "the related child's elbow ends the parent's line before the pending row");
  assert.equal(u.row("dev-new").closest(".ctx-tree-row").querySelector(".ctx-guides"), null, "the pending row carries no guides");
  assert.equal(u.row("dev-new").closest(".ctx-tree-row").style.getPropertyValue("--depth"), "1");
  assert.equal(u.row("dev-new").querySelector(".ctx-relation").textContent, ", under root");
  assert.equal(u.row("child-a").querySelector(".ctx-relation").textContent, ", under root, related work");
  // A host without the feature (no stamp on the parent): no lines either.
  const today = fixture(t, () => [pending()]);
  today.render(roster);
  assert.equal(today.list.querySelector(".ctx-guide, .ctx-guides"), null);
  assert.equal(today.row("dev-new").querySelector(".ctx-relation").textContent, ", under root");
});

test("a background spawn into the view's second deployment sits under that deployment's heading (#482)", async t => {
  // The row as spawnJobs.rows() hands it over: `deployment` is already `{ id }`, kept as is.
  const deployments = [{ id: "/a", path: "/a", local: true, machine: null, status: "observed", primary: true },
    { id: "/b", path: "/b", local: true, machine: null, status: "observed" }];
  const onA = roster.map(r => ({ ...r, deployment: { id: "/a" } }));
  const u = fixture(t, () => [pending({ parentInstance: undefined, deployment: { id: "/b" } })], { context: { contextDeployments: deployments } });
  u.render([...onA, instance("dev-b", undefined, { deployment: { id: "/b" } })]);
  const order = [...u.list.children].map(el => el.classList.contains("ctx-deployment") ? `#${el.querySelector(".ctx-deployment-label").textContent}`
    : el.querySelector(".ctx-name")?.dataset.name).filter(Boolean);
  assert.deepEqual(order, ["#This Mac · a", "root", "child-a", "solo", "#This Mac · b", "dev-b", "dev-new"]);
});

test("announced once through a polite live region", async t => {
  const u = fixture(t, () => [pending()]);
  u.render(roster);
  assert.equal(u.live().getAttribute("aria-live"), "polite"); assert.equal(u.live().textContent, "Spawning dev-new…");
  u.live().textContent = "";
  u.render(roster); u.render(roster);
  assert.equal(u.live().textContent, "", "a repaint never announces it again");
});

test("#802: while its job is in flight the reported row keeps the pending presentation; then the real row replaces it in place and keeps its focus", async t => {
  let rows = [pending()];
  const u = fixture(t, () => rows);
  u.render(roster);
  u.row("dev-new").focus();
  const real = [...roster, instance("dev-new", "root", { running: false })];
  u.render(real); // the job is still spawning: the roster's row is drawn as the pending one, never a stopped row with actions
  assert.equal(u.list.querySelectorAll(".ctx-inst").length, 4, "never both");
  const held = u.row("dev-new");
  assert.equal(held.classList.contains("pending"), true); assert.equal(held.querySelector(".ctx-spawn-state").textContent, "Spawning…");
  assert.equal(held.closest(".ctx-tree-row").querySelector(".ctx-row-tools"), null, "no Start, no actions");
  assert.equal(u.doc.activeElement, held, "focus kept");
  held.click(); // openTerminalTab / openInstanceStart would fail the test
  rows = [pending({ pending: "unknown" })]; // no longer in flight: the reported row is the real one
  u.render(real);
  assert.equal(u.list.querySelectorAll(".ctx-inst").length, 4, "never both");
  const replaced = u.row("dev-new");
  assert.equal(replaced.classList.contains("pending"), false);
  assert.equal(u.doc.activeElement, replaced, "focus kept across the replacement");
  rows = [];
  u.render(real);
  assert.equal(u.doc.activeElement, u.row("dev-new"));
});

test("an unknown outcome reads “Outcome unknown” with a visible Check result named for the instance", async t => {
  let rows = [pending({ pending: "unknown" })];
  const u = fixture(t, () => rows);
  u.render(roster);
  const button = u.row("dev-new");
  assert.equal(button.querySelector(".ctx-spawn-state").textContent, "Outcome unknown");
  assert.equal(button.querySelector(".ctx-spawn-spinner"), null, "no spinner: nothing is known to be moving");
  const check = button.closest(".ctx-tree-row").querySelector(".ctx-spawn-check");
  assert.equal(check.getAttribute("aria-label"), "Check result for dev-new"); assert.equal(check.textContent, "Check result");
  assert.ok(check.closest(".ctx-spawn-tools"), "its tools are always visible");
  check.focus(); check.click(); assert.deepEqual(u.checked, ["spawn-1"]);
  rows = [pending({ pending: "checking" })];
  u.render(roster);
  const again = u.list.querySelector(".ctx-spawn-check");
  assert.equal(again.getAttribute("aria-disabled"), "true"); assert.equal(u.doc.activeElement, again, "focus stays on it while checking");
  again.click(); assert.deepEqual(u.checked, ["spawn-1"], "one check at a time");
  assert.equal(u.row("dev-new").querySelector(".ctx-spawn-state").textContent, "Checking result…");
});

test("another workspace's pending rows are not painted", async t => {
  const u = fixture(t, () => [pending()]);
  u.render(roster);
  assert.ok(u.row("dev-new"));
  const other = fixture(t, () => []);
  other.render(roster);
  assert.equal(other.row("dev-new"), undefined);
});

test("CSS: the spinner turns only without reduced motion, and the Check result tools stay visible", () => {
  assert.match(css, /\.ctx-spawn-spinner \{[^}]*animation: oats-spin/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.ctx-spawn-spinner \{ animation: none; \} \}/);
  assert.match(css, /\.ctx-tree-row > \.ctx-spawn-tools \{ visibility: visible; \}/);
});

// ── Spec E: the pressed spawn's pending row is highlighted; a spawn not followed says New ────────────

test("Spec E: the pending row of the spawn just pressed wears the selection's fill (revealed), others do not", async t => {
  const u = fixture(t, () => [pending({ revealed: true }), pending({ id: "spawn-2", instance: "dev-two", home: "/synthetic/dev-two", parentInstance: undefined })]);
  u.render(roster);
  assert.equal(u.row("dev-new").closest(".ctx-tree-row").classList.contains("ctx-spawn-revealed"), true);
  assert.equal(u.row("dev-two").closest(".ctx-tree-row").classList.contains("ctx-spawn-revealed"), false);
  assert.notEqual(u.doc.activeElement, u.row("dev-new"), "revealed, not focused");
  assert.match(css, /\.ctx-tree-row\.ctx-spawn-revealed \{ --row-solid: var\(--sel\); background-color: var\(--sel\); \}/);
});

test("Spec E: a just-spawned row says New (text and a dot) until its row is opened, or it is the active row", async t => {
  const fresh = new Set(["/synthetic/solo"]), opened = [];
  const jobs = { isNew: (ws, row) => ws === "A" && fresh.has(row.home), seen: (ws, row) => fresh.delete(row.home) };
  const u = fixture(t, () => [], { jobs, context: { openTerminalTab: row => opened.push(row.instance) } });
  u.render(roster);
  const mark = u.row("solo").querySelector(".ctx-new");
  assert.ok(mark, "the mark"); assert.equal(mark.textContent, "New", "text, not colour alone");
  assert.equal(mark.querySelector(".ctx-new-dot").getAttribute("aria-hidden"), "true");
  assert.match(spokenText(u.row("solo")), /^soloNew/, "the row's name says it to assistive tech too");
  assert.equal(u.row("root").querySelector(".ctx-new"), null, "only the new one");
  assert.equal(u.row("solo").querySelector(".ctx-name").dataset.name, "solo");
  u.row("solo").click();
  assert.deepEqual(opened, ["solo"]); assert.equal(fresh.size, 0, "opening its row clears it");
  u.render(roster); assert.equal(u.row("solo").querySelector(".ctx-new"), null);
  // Opened another way (the palette, say): the first paint where it is the active row clears it.
  fresh.add("/synthetic/root");
  const tab = { kind: "terminal", key: tree.terminalKey("A", roster[0]) };
  const v = fixture(t, () => [], { jobs, context: { tabs: new Map([[7, tab]]), activeTab: 7 } });
  v.render(roster);
  assert.equal(v.row("root").querySelector(".ctx-new"), null); assert.equal(fresh.size, 0);
});

function luminance(hex) {
  assert.match(hex, /^#[0-9a-f]{6}$/i);
  const c = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
}
for (const theme of ["light", "solarized", "dark"]) test(`Spec E, ${theme}: “New” is muted text that meets AA on every row fill, with no opacity`, async t => {
  const dom = new JSDOM(`<!doctype html><html data-theme="${theme}"><head></head><body><span class="ctx-new"><span class="ctx-new-dot"></span>New</span></body></html>`);
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  for (const source of [read("theme.css"), css]) { const style = doc.createElement("style"); style.textContent = source; doc.head.append(style); }
  const view = dom.window, root = view.getComputedStyle(doc.documentElement), mark = doc.querySelector(".ctx-new");
  assert.equal(view.getComputedStyle(mark).color, "var(--muted)");
  assert.equal(view.getComputedStyle(mark).opacity, "1");
  assert.equal(view.getComputedStyle(doc.querySelector(".ctx-new-dot")).background, "var(--accent)");
  const fg = luminance(root.getPropertyValue("--muted").trim());
  for (const fill of ["surface", "surface-2", "sel"]) {
    const bg = luminance(root.getPropertyValue(`--${fill}`).trim());
    assert.ok((Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05) >= 4.5, `${theme}: muted on ${fill}`);
  }
});
