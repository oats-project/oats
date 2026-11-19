// The sidebar's disclosure (the product owner, 2026-11-19): a row with children shows a chevron and the count of the
// rows under it, a click on that mark opens or closes the row, and a root of the roster starts collapsed, so the
// sidebar shows the top-level rows only until one is opened. A waiting row a default collapse hides still rolls up
// onto its root (decision needs-input-preserves-liveness-and-recognition). Executes the shipped roster render, the
// row keys and Show in roster (shell.mjs renderContextRoster, onRosterRowKey, setRovingRow, showInRoster) with the
// shipped disclosure (roster-disclosure.mjs) against a stub store; no shell startup, HTTP, Electron, CLI or session.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { viewContext } from "./helpers/view-context.mjs";
import { spokenText } from "./helpers/spoken-text.mjs";
import * as treeShared from "../../client/instance-tree.mjs";
import * as sameWork from "../../client/same-work.mjs";
import * as treeView from "../renderer/instance-tree-view.mjs";
import { instanceActions, captureInstanceActionMenu } from "../renderer/instance-actions.mjs";
import { instanceActionTarget } from "../renderer/instance-action-target.mjs";
import { instanceSplitPlan } from "../renderer/instance-split.mjs";
import { runtimeState, unsupportedSession } from "../../client/instance-presentation.mjs";
import { canAddressRemote, rowReason } from "../../client/remote-address.mjs";
import { createRuntimeBadge } from "../renderer/identity-marks.mjs";
import { iconElement } from "../renderer/shell-icons.mjs";
import { rosterTipFacts } from "../renderer/roster-tip.mjs";
import { setTabTitle } from "../renderer/tab-a11y.mjs";
import { NO_ANSWER_CODE, unservedError } from "../renderer/deployment-header.mjs";
import { rosterKeyAction, moveTarget } from "../renderer/roster-keys.mjs";
import { revealInScrollport } from "../renderer/reveal-in-scrollport.mjs";
const tree = { ...treeShared, ...treeView, ...sameWork }; // the renderer's client imports, shipped

const read = name => readFileSync(new URL(`../renderer/${name}`, import.meta.url), "utf8");
const css = read("shell.css"), html = read("index.html"), shell = read("shell.mjs");
const fn = name => shell.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
const source = ["renderContextRoster", "pendingSpawnRow", "announceSpawn", "needsInputMark", "onRosterRowKey", "setRovingRow", "showInRoster"]
  .map(name => { const s = fn(name); assert.ok(s, name); return s; }).join("\n");

const instance = (name, parentInstance, extra = {}) => ({ instance: name, parentInstance, agent: "dev",
  home: `/synthetic/${name}`, agentsRoot: "/synthetic/agents", repoName: "desktop-repo", running: true, runtimeState: "running", ...extra });
// A lead with a child that has its own child, and a second child; a pair; one row on its own.
const ROWS = [instance("lead"), instance("mid", "lead"), instance("tip", "mid"), instance("side", "lead"),
  instance("duo"), instance("duo-kid", "duo"), instance("solo")];

function fixture(t, rows = ROWS, extra = {}) {
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const opened = [];
  const context = {
    ...tree, document: doc, instanceActions, captureInstanceActionMenu, runtimeState, unsupportedSession, canAddressRemote, rowReason, createRuntimeBadge,
    iconElement, setTabTitle, NO_ANSWER_CODE, unservedError, instanceActionTarget, instanceSplitPlan, connectionGeneration: 0, menuState() {}, sayInHint() {}, runAction: assert.fail,
    applyChordTitles() {}, updateActiveContexts() {}, getBinding: () => null, formatChord: c => c, isMac: true,
    contextRosterEl: doc.querySelector("#instance-roster"), contextWorkspace: "A",
    rosterState: { hasData: true, state: "ready" }, rosterStale: false, contextDeploymentNote: null, ...viewContext(),
    // The shipped default: no root opened by hand.
    expandedInstances: new Set(),
    currentWorkspace: () => "A", workspaceGeneration: () => 0, collapsedInstances: new Set(),
    rosterTip: { bind() {}, hide() {}, sync() {} }, rosterTipFacts,
    rosterPrs: { get: () => null, refresh() {} },
    spawnJobs: { rows: () => [], announce: () => false, check() {} },
    tabs: new Map(), activeTab: null, tabOpenIntents: { applyFocus: f => f(), invalidate() {} },
    openTerminalTab: (i) => opened.push(i.instance), openInstanceStart: assert.fail, openLifecycleDialog: assert.fail,
    rosterKeyAction, moveTarget, revealInScrollport,
    api: assert.fail, showStage: assert.fail, refreshContextRoster: assert.fail,
    contextInstances: rows,
    ...extra,
  };
  context.splitOpenState = () => ({ split: null, activeId: null, tabs: context.tabs, workspace: "A", visible: false });
  context.ownsInstanceTarget = () => true;
  Object.defineProperty(context, "Date", { get: () => Date, enumerable: true });
  const s = runInNewContext(`${source}\n({ render: renderContextRoster, onRosterRowKey, showInRoster })`, context);
  // The shell binds the row keys inside the render; the stub above is replaced by the shipped handler.
  context.onRosterRowKey = s.onRosterRowKey;
  const list = doc.querySelector(".ctx-list");
  const row = name => [...list.querySelectorAll(".ctx-inst")].find(b => b.querySelector(".ctx-name")?.dataset.name === name) ?? null;
  const drawn = () => [...list.querySelectorAll(".ctx-inst .ctx-name")].map(n => n.dataset.name);
  const mark = name => row(name)?.querySelector(".ctx-disclosure") ?? null;
  const click = el => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  const key = (name, k) => row(name).dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  s.render(rows);
  return { doc, dom, context, s, list, row, drawn, mark, click, key, opened };
}

test("by default only the top-level rows are drawn: each root with children is collapsed and shows a chevron and the count under it", t => {
  const u = fixture(t);
  assert.deepEqual(new Set(u.drawn()), new Set(["lead", "duo", "solo"]), "the top-level rows only");
  for (const [name, count] of [["lead", 3], ["duo", 1]]) {
    const r = u.row(name), m = u.mark(name);
    assert.equal(r.getAttribute("aria-expanded"), "false", `${name} reads collapsed`);
    assert.equal(r.dataset.rosterCollapsed, "1");
    assert.ok(m, `${name} wears the disclosure`);
    assert.equal(m.parentElement.className, "ctx-name-line", "beside the name");
    assert.equal(m.parentElement.firstElementChild.className, "ctx-name", "after the name");
    assert.ok(m.querySelector(":scope > svg.ctx-disclosure-chevron"), "a chevron");
    assert.equal(m.querySelector(".ctx-disclosure-count").textContent, String(count), "every row under it, at every depth");
    assert.equal(m.querySelector(".ctx-disclosure-count").getAttribute("aria-hidden"), "true");
    assert.match(spokenText(r), new RegExp(`^${name}, ${count} below`), "a screen reader hears the count after the name");
  }
  const solo = u.row("solo");
  assert.equal(solo.hasAttribute("aria-expanded"), false, "a row with no children has nothing to open");
  assert.equal(u.mark("solo"), null, "and no disclosure");
  assert.equal(solo.querySelector(".ctx-name-line"), null, "its name line is its name alone");
});

test("a click on the disclosure opens the root as the group was drawn before, and opens no terminal; a second click closes it", t => {
  const u = fixture(t);
  u.click(u.mark("lead"));
  assert.deepEqual(new Set(u.drawn()), new Set(["lead", "mid", "tip", "side", "duo", "solo"]), "the whole group: a row under a root starts open");
  assert.equal(u.row("lead").getAttribute("aria-expanded"), "true");
  assert.equal(u.row("mid").getAttribute("aria-expanded"), "true", "a nested parent starts open");
  assert.equal(u.mark("mid").querySelector(".ctx-disclosure-count").textContent, "1", "and shows its own count");
  assert.deepEqual(u.opened, [], "the click opened nothing");
  assert.equal(u.doc.activeElement, u.row("lead"), "the focus is on the row clicked");
  assert.equal(u.row("lead").tabIndex, 0, "and the roving tab stop with it");
  u.click(u.mark("lead"));
  assert.deepEqual(new Set(u.drawn()), new Set(["lead", "duo", "solo"]));
  assert.equal(u.row("lead").getAttribute("aria-expanded"), "false");
  assert.deepEqual(u.opened, []);
});

test("a click on the rest of a parent's row opens its terminal and leaves it collapsed", t => {
  const u = fixture(t);
  u.click(u.row("lead").querySelector(".ctx-name"));
  assert.deepEqual(u.opened, ["lead"]);
  assert.equal(u.row("lead").getAttribute("aria-expanded"), "false");
  assert.deepEqual(new Set(u.drawn()), new Set(["lead", "duo", "solo"]));
});

test("what the operator opens or closes is kept: a nested row closed by hand stays closed when its root closes and opens again", t => {
  const u = fixture(t);
  u.click(u.mark("lead"));
  u.click(u.mark("mid"));
  assert.deepEqual(new Set(u.drawn()), new Set(["lead", "mid", "side", "duo", "solo"]), "mid's child is hidden");
  assert.equal(u.mark("mid").querySelector(".ctx-disclosure-count").textContent, "1");
  u.click(u.mark("lead"));
  u.click(u.mark("lead"));
  assert.deepEqual(new Set(u.drawn()), new Set(["lead", "mid", "side", "duo", "solo"]), "mid is still closed");
  // A repaint (a roster read) keeps both choices.
  u.s.render(ROWS);
  assert.deepEqual(new Set(u.drawn()), new Set(["lead", "mid", "side", "duo", "solo"]));
});

test("the tree keys open and close a root that starts collapsed", t => {
  const u = fixture(t);
  u.row("duo").focus();
  u.key("duo", "ArrowRight");
  assert.deepEqual(new Set(u.drawn()), new Set(["lead", "duo", "duo-kid", "solo"]));
  assert.equal(u.row("duo").getAttribute("aria-expanded"), "true");
  assert.equal(u.doc.activeElement, u.row("duo"), "the focus stays on the row");
  u.key("duo", "ArrowLeft");
  assert.deepEqual(new Set(u.drawn()), new Set(["lead", "duo", "solo"]));
});

test("a root collapsed by default rolls up its hidden waiting row: the needs-input mark is never hidden", t => {
  const claim = { since: "2026-10-03T09:00:00.000Z", producer: "claude-hooks", reason: "permission", message: null };
  const rows = [instance("lead"), instance("mid", "lead"), instance("tip", "mid", { waitingOnYou: claim })];
  const u = fixture(t, rows);
  assert.deepEqual(u.drawn(), ["lead"], "tip is hidden by the default collapse");
  const rollup = u.row("lead").querySelector(".ctx-attn");
  assert.ok(rollup, "its root carries the roll-up");
  assert.equal(rollup.textContent, "1 below need input");
  u.click(u.mark("lead"));
  assert.equal(u.row("lead").querySelector(".ctx-attn"), null, "opened, the roll-up goes");
  assert.ok(u.row("tip").querySelector(".ctx-dot.waiting"), "and the waiting row shows its own mark");
});

// A row its lifecycle takes (a pending row, or a held home's state on its meta line) has no room for the roll-up: it
// is always drawn open and offers no collapse, so a waiting child stays drawn with its own mark (review rounds 1, 2).
// A collapse chosen by hand before is kept, and applies again once the lifecycle is over.
const CLAIM = { since: "2026-10-03T09:00:00.000Z", producer: "claude-hooks", reason: "permission", message: null };
for (const [what, lead, extra] of [
  ["a reported row whose spawn is still being checked", instance("lead"),
    { spawnJobs: { rows: () => [{ id: "job-1", instance: "lead", agent: "dev", home: "/synthetic/lead", agentsRoot: "/synthetic/agents", pending: "checking" }], announce: () => false, check() {} } }],
  ["a home the roster reports still setting up", instance("lead", undefined, { spawnInProgress: true }), {}],
  ["a home whose retire failed", instance("lead", undefined, { running: false, runtimeState: "stopped",
    retire: { state: "failed", since: "2026-11-19T10:00:00Z", self: true, code: "E_CHILDREN_RUNNING", message: "A child could not be stopped." } }), {}],
]) {
  test(`a root drawn as ${what} is drawn open and offers no collapse: its waiting child stays drawn, with its own mark`, t => {
    const rows = [lead, instance("tip", "lead", { waitingOnYou: CLAIM })];
    const u = fixture(t, rows, extra);
    assert.deepEqual(u.drawn(), ["lead", "tip"], "nothing is hidden behind the root");
    assert.ok(u.row("tip").querySelector(".ctx-dot.waiting"), "the waiting child shows its own needs-input mark");
    assert.equal(u.mark("lead"), null, "no disclosure to close it with");
    assert.equal(u.row("lead").hasAttribute("aria-expanded"), false);
    assert.equal(u.row("lead").dataset.rosterChildren, "0", "the tree keys have nothing to collapse");
    u.row("lead").focus();
    u.key("lead", "ArrowLeft");
    assert.deepEqual(u.drawn(), ["lead", "tip"], "Left hides nothing");
    // The same rows once the root's lifecycle is over: the default collapse applies, and the wait rolls up.
    u.context.spawnJobs = { rows: () => [], announce: () => false, check() {} };
    u.s.render([instance("lead"), rows[1]]);
    assert.deepEqual(u.drawn(), ["lead"]);
    assert.equal(u.row("lead").querySelector(".ctx-attn")?.textContent, "1 below need input");
  });

  test(`a root closed by hand, then drawn as ${what}, is drawn open; once its lifecycle is over it is closed again`, t => {
    const rows = [lead, instance("tip", "lead", { waitingOnYou: CLAIM })];
    const u = fixture(t, rows, { ...extra, expandedInstances: new Set(), collapsedInstances: new Set([tree.collapseKey("A", "/synthetic/lead")]) });
    assert.deepEqual(u.drawn(), ["lead", "tip"], "the hand collapse does not hide the waiting child");
    assert.ok(u.row("tip").querySelector(".ctx-dot.waiting"));
    u.context.spawnJobs = { rows: () => [], announce: () => false, check() {} };
    u.s.render([instance("lead"), rows[1]]);
    assert.deepEqual(u.drawn(), ["lead"], "the choice made by hand applies again");
    assert.ok(u.mark("lead"), "with its disclosure back");
    assert.equal(u.row("lead").querySelector(".ctx-attn")?.textContent, "1 below need input");
  });
}

test("Show in roster opens the default-collapsed root of the row it shows, and the root stays open", async t => {
  const u = fixture(t);
  assert.equal(u.row("tip"), null);
  assert.equal(await u.s.showInRoster({ home: "/synthetic/tip" }, { read: false }), true);
  assert.deepEqual(new Set(u.drawn()), new Set(["lead", "mid", "tip", "side", "duo", "solo"]));
  assert.equal(u.doc.activeElement, u.row("tip"));
  u.s.render(ROWS);
  assert.ok(u.row("tip"), "a repaint keeps it open");
});

test("the disclosure's style: muted ink, a chevron that turns down while open, and a name line that never grows", () => {
  const rule = selector => css.match(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`))?.[2] ?? "";
  const mark = rule(".ctx-disclosure");
  assert.match(mark, /color: var\(--muted\)/);
  assert.match(mark, /cursor: pointer/);
  assert.match(mark, /line-height: 15px/, "the name line's 15px");
  assert.match(mark, /margin: -1px 0; padding: 1px /, "its padding sits in a negative margin");
  assert.match(rule('.ctx-inst[aria-expanded="true"] .ctx-disclosure-chevron'), /transform: rotate\(90deg\)/);
  assert.doesNotMatch(mark, /transition|animation/, "nothing animates");
});
