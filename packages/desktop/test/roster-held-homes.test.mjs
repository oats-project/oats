// #802: homes the kernel holds. A spawn running its worktree hooks (`spawnInProgress: true`) reads
// "Setting up worktree…" in the pending row's treatment; a home a spawn or a retire left half cleaned
// (`rollbackIncomplete`, the kernel's `retire` failed or interrupted) reads so and offers Retire only. #1247: a
// home being retired (the kernel's `retire` running or unknown, an older kernel's bare `retirePending`, this
// window's own retire in flight) reads "Retiring…", never as a failure, and keeps Retire only in its menu, never
// as its default. Projections (deployment-data, /api/panel), the shipped roster render (shell.mjs
// renderContextRoster + pendingSpawnRow) against a stub store, the hover card and the row's context menu (#1559:
// a right-click, Shift+F10 or the Menu key on the row; no ⋯ trigger); no shell startup, HTTP, Electron, CLI or session.
import test from "node:test";
import { viewContext } from "./helpers/view-context.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import * as treeShared from "../../client/instance-tree.mjs";
import * as sameWork from "../../client/same-work.mjs";
import * as treeView from "../renderer/instance-tree-view.mjs";
const tree = { ...treeShared, ...treeView, ...sameWork }; // the renderer's client imports, shipped
import { instanceActions, captureInstanceActionMenu } from "../renderer/instance-actions.mjs";
import { instanceActionTarget, sameInstanceActionTarget } from "../renderer/instance-action-target.mjs";
import { instanceSplitPlan } from "../renderer/instance-split.mjs";
import { runtimeState, unsupportedSession } from "../../client/instance-presentation.mjs";
import { canAddressRemote, rowReason } from "../../client/remote-address.mjs";
import { waitingClock } from "../../client/waiting-on-you.mjs";
import { projectActivePanel } from "../renderer/active-observation.mjs";
import { deploymentStatusData } from "../../client/deployment-data.mjs";
import { panelInstance } from "../../client/deployment-panel.mjs";
import { heldLine } from "../renderer/speaker-line.mjs";
import { RETIRE_INTERRUPTED } from "./helpers/instance-menu-probe.mjs";

const read = name => readFileSync(new URL(`../renderer/${name}`, import.meta.url), "utf8");
const css = read("shell.css"), html = read("index.html"), shell = read("shell.mjs");
const fn = name => shell.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
const source = ["renderContextRoster", "pendingSpawnRow", "announceSpawn"].map(name => { const s = fn(name); assert.ok(s, name); return s; }).join("\n");
const instance = (name, parentInstance, extra = {}) => ({ instance: name, parentInstance, agent: "dev",
  home: `/synthetic/${name}`, agentsRoot: "/synthetic/agents", repoName: "desktop-repo", running: true, ...extra });
const roster = [instance("root"), instance("solo")];
const job = (extra = {}) => ({ id: "spawn-1", instance: "dev-new", home: "/synthetic/dev-new", agent: "dev", agentsRoot: "/synthetic/agents",
  parentInstance: "root", pending: "spawning", ...extra });
// A fixed local start, so the "since" line is the shared clock's words for it.
const STARTED = new Date(2026, 9, 8, 14, 3).getTime();

function fixture(t, rows, extra = {}) {
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  // jsdom has no top-layer API: model only the popover's open/close events (as instance-actions.test.mjs does).
  for (const [method, newState] of [["showPopover", "open"], ["hidePopover", "closed"]]) {
    dom.window.HTMLElement.prototype[method] = function () {
      const event = new dom.window.Event("beforetoggle");
      Object.defineProperty(event, "newState", { value: newState });
      this.dispatchEvent(event);
    };
  }
  const doc = dom.window.document;
  const announced = new Set(), lifecycle = [], forgets = [], said = [], opened = [];
  let painted = [];
  const context = {
    ...tree, document: doc, instanceActions, captureInstanceActionMenu, runtimeState, unsupportedSession, canAddressRemote, rowReason,
    instanceActionTarget, instanceSplitPlan, connectionGeneration: 0, menuState() {}, runAction: assert.fail, sayInHint: line => said.push(line),
    applyChordTitles() {}, updateActiveContexts() {}, getBinding: () => null, formatChord: c => c, isMac: true,
    contextRosterEl: doc.querySelector("#instance-roster"), contextWorkspace: "A",
    rosterState: { hasData: true, state: "ready" }, rosterStale: false, contextDeploymentNote: null, ...viewContext(),
    currentWorkspace: () => "A", workspaceGeneration: () => 0, collapsedInstances: new Set(),
    spawnJobs: { rows: ws => ws === "A" ? rows() : [], announce: id => !announced.has(id) && !!announced.add(id), check() {} },
    tabs: new Map(), activeTab: null, tabOpenIntents: { applyFocus: f => f() },
    // A held row opens and starts nothing (recorded: a throw inside a jsdom listener would not fail the test).
    // Retire goes to the plan dialog, Forget… to its confirmation.
    openTerminalTab: row => opened.push(["terminal", row.instance]), openInstanceStart: row => opened.push(["start", row.instance]),
    openLifecycleDialog: (...args) => lifecycle.push(args), openForgetDialog: (...args) => forgets.push(args), onRosterRowKey() {},
    api: assert.fail, showStage: assert.fail, refreshContextRoster: assert.fail,
    ...(extra.context || {}),
  };
  context.splitOpenState = () => ({ split: null, activeId: null, tabs: context.tabs, workspace: "A", visible: false });
  context.ownsInstanceTarget = target => painted.filter(row => sameInstanceActionTarget(target, row, "A")).length === 1;
  const paint = runInNewContext(`${source}\nrenderContextRoster`, context);
  const render = instances => { painted = instances; paint(instances); };
  const list = doc.querySelector(".ctx-list");
  const row = name => [...list.querySelectorAll(".ctx-inst")].find(b => b.querySelector(".ctx-name")?.dataset.name === name);
  const wrap = name => row(name).closest(".ctx-tree-row");
  const menu = name => [...wrap(name).querySelectorAll("[role=menuitem]")].map(item => item.dataset.action);
  // The row's context menu: a right-click at the pointer, or a key's (Shift+F10, the Menu key: clientX = clientY = 0).
  const contextMenu = (name, { x = 0, y = 0 } = {}) => row(name).dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  const key = (el, key) => el.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  return { doc, render, list, row, wrap, menu, contextMenu, key, lifecycle, forgets, said, opened, live: () => doc.querySelector("#instance-roster > .ctx-spawn-live") };
}

// No Start…, no PR link, no Check result: nothing overlays the row (and no row has a ⋯ trigger, #1559).
const noTools = (u, name) => {
  assert.equal(u.wrap(name).querySelector(".ctx-row-tools"), null, `${name}: no tools`);
  assert.equal(u.wrap(name).querySelector(".ctx-instance-actions"), null, `${name}: no ⋯ trigger`);
};

test("projection: spawnInProgress is kept as boolean true only; anything else is dropped without failing the roster", () => {
  const doc = value => ({ root: "/d/agents", agents: [{ name: "dev", dir: "/d/agents/dev",
    instances: [{ instance: "dev-a", home: "/d/agents/dev/instances/dev-a", ...(value === undefined ? {} : { spawnInProgress: value }) }] }] });
  const row = value => deploymentStatusData(doc(value), "/d").agents[0].instances[0];
  assert.equal(row(true).spawnInProgress, true);
  for (const value of [false, "yes", 1, {}, null, [true], undefined]) assert.equal(Object.hasOwn(row(value), "spawnInProgress"), false, JSON.stringify(value));
});

test("projection: /api/panel forwards spawnInProgress (true only), beside the quarantine flags", () => {
  const project = panelInstance;
  const base = { instance: "dev-a", agentsRoot: "/d/agents", home: "/d/agents/dev/instances/dev-a" };
  assert.equal(project({ ...base, spawnInProgress: true }).spawnInProgress, true);
  for (const value of [undefined, false, "yes", 1]) assert.equal(Object.hasOwn(project({ ...base, spawnInProgress: value }), "spawnInProgress"), false, String(value));
  assert.deepEqual([project({ ...base, rollbackIncomplete: true }).rollbackIncomplete, project({ ...base, retirePending: true }).retirePending], [true, true]);
  // The canvas's own projection keeps them too (true only), so its actions are gated on them.
  const active = projectActivePanel({ instances: [{ ...base, spawnInProgress: true, rollbackIncomplete: "yes" }] }).instances[0];
  assert.deepEqual([active.spawnInProgress, Object.hasOwn(active, "rollbackIncomplete")], [true, false]);
});

test("heldHome: rollbackIncomplete wins over spawnInProgress, a live spawn over retirePending; spawnInProgress counts only as true", () => {
  const kind = row => tree.heldHome(row)?.kind ?? null;
  assert.equal(kind({ spawnInProgress: true }), "spawning");
  assert.equal(kind({ spawnInProgress: "true" }), null);
  assert.equal(kind({ rollbackIncomplete: true }), "spawn-incomplete");
  assert.equal(kind({ retirePending: true }), "retiring", "an older kernel's pending retire: being retired (#1247)");
  assert.equal(kind({ retire: RETIRE_INTERRUPTED }), "retire-incomplete");
  assert.equal(kind({ spawnInProgress: true, rollbackIncomplete: true }), "spawn-incomplete");
  assert.equal(kind({ spawnInProgress: true, retirePending: true }), "spawning");
  assert.equal(kind({ rollbackIncomplete: false, retirePending: false }), null, "a remote row's false flags hold nothing");
  assert.equal(kind(null), null);
});

test("a row the roster reports setting up its worktree (a spawn made anywhere): the pending treatment, no actions, opens nothing", async t => {
  const u = fixture(t, () => []);
  u.render([...roster, instance("dev-new", "root", { running: false, spawnInProgress: true })]);
  const button = u.row("dev-new");
  assert.equal(button.querySelector(".ctx-spawn-state").textContent, "Setting up worktree…");
  assert.equal(button.querySelector(".ctx-spawn-spinner").getAttribute("aria-hidden"), "true", "the text carries the state; the spinner is decoration");
  assert.equal(button.classList.contains("pending"), true);
  assert.equal(button.getAttribute("aria-disabled"), "true"); assert.match(button.getAttribute("aria-description"), /is setting up its worktree/);
  assert.equal(button.dataset.treeInstance, "/synthetic/dev-new", "the instance's identity");
  assert.equal(button.tagName, "BUTTON", "focusable: in the roving tab order");
  assert.equal(button.querySelector(".ctx-spawn-since"), null, "no job here knows its start");
  noTools(u, "dev-new");
  button.click(); assert.deepEqual(u.opened, [], "activation opens and starts nothing");
  assert.equal(u.live(), null, "no job of this window: nothing is announced");
  // Alone in the roster it is the row the keyboard enters.
  const v = fixture(t, () => []);
  v.render([instance("dev-new", undefined, { running: false, spawnInProgress: true })]);
  assert.equal(v.row("dev-new").tabIndex, 0);
});

test("“since <local time>” only when a job of this window for the same home knows its start", async t => {
  const reported = [...roster, instance("dev-new", "root", { running: false, spawnInProgress: true })];
  const since = u => u.row("dev-new").querySelector(".ctx-spawn-since")?.textContent ?? null;
  for (const pending of ["spawning", "unknown"]) {
    const u = fixture(t, () => [job({ pending, startedAt: STARTED })]);
    u.render(reported);
    assert.equal(since(u), `since ${waitingClock(STARTED)}`, pending);
    assert.ok(u.row("dev-new").querySelector(".ctx-spawn-since").classList.contains("ctx-held-hint"), "muted");
  }
  for (const [label, rows] of [["no startedAt", [job()]], ["a non-finite one", [job({ startedAt: NaN })]],
    ["another home's job", [job({ home: "/synthetic/other", instance: "other", startedAt: STARTED })]],
    ["another agents root", [job({ pending: "unknown", agentsRoot: "/elsewhere/agents", startedAt: STARTED })]]]) {
    const u = fixture(t, () => rows);
    u.render(reported);
    assert.equal(since(u), null, label);
  }
});

test("the pending row turns into “Setting up worktree…” in place, never flashing to a stopped row with actions", async t => {
  let rows = [job({ startedAt: STARTED })];
  const u = fixture(t, () => rows);
  const step = (instances, state) => {
    u.render(instances);
    assert.equal(u.list.querySelectorAll(".ctx-inst").length, 3, "never both");
    const button = u.row("dev-new");
    assert.equal(button.dataset.treeInstance, "/synthetic/dev-new", "the same identity");
    assert.equal(button.querySelector(".ctx-spawn-state").textContent, state);
    assert.equal(button.getAttribute("aria-disabled"), "true");
    assert.equal(u.list.querySelector(".ctx-start"), null, "no Start…"); noTools(u, "dev-new");
    assert.equal(u.doc.activeElement, button, "focus kept");
    button.click(); assert.deepEqual(u.opened, [], "activation opens and starts nothing");
    return button;
  };
  u.render(roster);
  u.row("dev-new").focus();
  step(roster, "Spawning…");
  const settingUp = step([...roster, instance("dev-new", "root", { running: false, spawnInProgress: true })], "Setting up worktree…");
  assert.ok(settingUp.querySelector(".ctx-spawn-spinner"));
  assert.equal(settingUp.querySelector(".ctx-spawn-since").textContent, `since ${waitingClock(STARTED)}`);
  // The roster reports it without the flag while the job is still spawning: still the pending row, never "stopped".
  step([...roster, instance("dev-new", "root", { running: false })], "Spawning…");
  // Checking a result is in flight too.
  rows = [job({ pending: "checking", startedAt: STARTED })];
  step([...roster, instance("dev-new", "root", { running: false, spawnInProgress: true })], "Setting up worktree…");
  // The job is done: the real row.
  rows = [];
  u.render([...roster, instance("dev-new", "root")]);
  assert.equal(u.row("dev-new").classList.contains("pending"), false);
  assert.equal(u.doc.activeElement, u.row("dev-new"), "focus kept across the replacement");
});

for (const [flag, state, hint, hold] of [["rollbackIncomplete", "Spawn didn't finish", "Retire it to clean up", { rollbackIncomplete: true }],
  ["retire interrupted", "Retire didn't finish", "Retire it again to complete", { retire: RETIRE_INTERRUPTED }],
  ["retire failed", "Retire failed", "Retire it again to finish", { retire: { ...RETIRE_INTERRUPTED, state: "failed" } }]]) {
  test(`${flag}: “${state}”, muted “${hint}”, Retire instance… only, through the plan dialog`, async t => {
    const u = fixture(t, () => []);
    const row = instance("dev-q", "root", { running: false, ...hold });
    u.render([...roster, row]);
    const button = u.row("dev-q");
    assert.equal(button.querySelector(".ctx-spawn-state").textContent, state, "text, not colour alone");
    assert.equal(button.querySelector(".ctx-held-hint").textContent, hint);
    assert.equal(button.getAttribute("aria-disabled"), "true"); assert.match(button.getAttribute("aria-description"), new RegExp(hint));
    button.click(); assert.deepEqual(u.opened, [], "activation starts nothing");
    assert.equal(u.wrap("dev-q").querySelector(".ctx-start"), null, "no Start…");
    assert.deepEqual(u.menu("dev-q"), ["details", "retire"], "Details (slice 6a: every row's) and Retire: no Inspect, Start, Stop or split");
    assert.equal(u.wrap("dev-q").querySelector("[data-action=retire]").textContent, "Retire instance…");
    noTools(u, "dev-q");
    u.contextMenu("dev-q");
    assert.equal(u.wrap("dev-q").querySelector(".ctx-instance-menu").dataset.instanceMenuOpen, "true", "its context menu opens");
    u.wrap("dev-q").querySelector("[data-action=retire]").click();
    await new Promise(r => setImmediate(r));
    assert.equal(u.lifecycle.length, 1, "the ordinary plan → apply dialog");
    assert.equal(u.lifecycle[0][0], "retire"); assert.equal(u.lifecycle[0][1].home, "/synthetic/dev-q");
    for (const [key, value] of Object.entries(hold)) assert.deepEqual(u.lifecycle[0][1][key], value);
    // A running quarantined home offers no Stop or split either.
    const v = fixture(t, () => []);
    v.render([...roster, instance("dev-q", "root", { running: true, ...hold })]);
    assert.deepEqual(v.menu("dev-q"), ["details", "retire"]);
  });
}

test("both spawnInProgress and rollbackIncomplete: rollbackIncomplete wins, even over a job still in flight here", async t => {
  const both = instance("dev-new", "root", { running: false, spawnInProgress: true, rollbackIncomplete: true });
  for (const rows of [[], [job({ startedAt: STARTED })]]) {
    const u = fixture(t, () => rows);
    u.render([...roster, both]);
    assert.equal(u.list.querySelectorAll(".ctx-inst").length, 3, "never both");
    assert.equal(u.row("dev-new").querySelector(".ctx-spawn-state").textContent, "Spawn didn't finish");
    assert.equal(u.row("dev-new").querySelector(".ctx-spawn-spinner"), null);
    assert.equal(u.row("dev-new").querySelector(".ctx-spawn-since"), null);
    assert.deepEqual(u.menu("dev-new"), ["details", "retire"]);
  }
});

test("instanceActions: a spawning home has no actions (its context menu opens nothing and says why); a quarantined one Retire only, extras included", t => {
  const dom = new JSDOM("<body></body>", { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  for (const [method, newState] of [["showPopover", "open"], ["hidePopover", "closed"]]) {
    dom.window.HTMLElement.prototype[method] = function () {
      const event = new dom.window.Event("beforetoggle");
      Object.defineProperty(event, "newState", { value: newState });
      this.dispatchEvent(event);
    };
  }
  const doc = dom.window.document;
  const extra = [{ action: "open-split", label: "Open in split", reason: "" }, { action: "open-pr", label: "Open pull request…", reason: "" }];
  const rowFor = () => { const row = doc.createElement("button"); row.className = "ctx-inst"; doc.body.append(row); return row; };
  const contextMenu = row => row.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const said = [], spawningRow = rowFor();
  const spawning = instanceActions(doc, instance("s", undefined, { running: false, spawnInProgress: true }), { row: spawningRow, extra, say: line => said.push(line) });
  assert.equal(spawning.querySelectorAll("[role=menuitem]").length, 0);
  spawningRow.focus(); contextMenu(spawningRow);
  assert.notEqual(spawning.dataset.instanceMenuOpen, "true", "a blocked row's menu opens nothing");
  assert.equal(said.length, 1); assert.match(said[0], /s is setting up its worktree/, "and says why");
  assert.equal(doc.activeElement, spawningRow, "focus stays on the row");
  assert.equal(spawningRow.hasAttribute("aria-disabled") || spawningRow.hasAttribute("title"), false, "the menu marks nothing on the row");
  for (const hold of [{ rollbackIncomplete: true }, { retirePending: true }, { retire: RETIRE_INTERRUPTED }]) {
    const heldRow = rowFor();
    const held = instanceActions(doc, instance("q", undefined, { running: true, ...hold }), { row: heldRow, extra, say: line => said.push(line) });
    heldRow.after(held);
    assert.deepEqual([...held.querySelectorAll("[role=menuitem]")].map(item => item.dataset.action), ["retire"], JSON.stringify(hold) + " (this menu's extras carry no always item)");
    contextMenu(heldRow);
    assert.equal(held.dataset.instanceMenuOpen, "true", `limited, not held: its menu opens (${JSON.stringify(hold)})`);
    held.hidePopover();
  }
  assert.equal(said.length, 1, "nothing said for an open menu");
});

for (const theme of ["light", "solarized", "dark"]) test(`${theme}: the held line is --muted text, no opacity`, async t => {
  const dom = new JSDOM(`<!doctype html><html data-theme="${theme}"><head></head><body><span class="ctx-meta ctx-held-hint">Retire it to clean up</span></body></html>`);
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  for (const sheet of [read("theme.css"), css]) { const style = doc.createElement("style"); style.textContent = sheet; doc.head.append(style); }
  const line = dom.window.getComputedStyle(doc.querySelector(".ctx-held-hint"));
  assert.equal(line.color, "var(--muted)"); assert.equal(line.opacity, "1");
});

/* ── #1247: a retire in progress reads Retiring…, never as a failure ── */
const SINCE = "2026-10-15T00:00:00Z";
const retire = (state, extra = {}) => ({ retire: { state, since: SINCE, self: true, ...extra } });
/** Every way a home reads as being retired: the kernel's running or unknown retire, an older kernel's bare
 * retirePending, this window's own retire in flight (shell.mjs shownRows marks it so). */
const RETIRING = { "running": retire("running"), "unknown": retire("unknown"), "an older kernel's retirePending": { retirePending: true },
  "this window's retire in flight": { retireInFlight: true } };

test("projection: the kernel's retire is passed on read again; one out of the contract is absent, retirePending stays as it is", () => {
  const base = { instance: "dev-a", agentsRoot: "/d/agents", home: "/d/agents/dev/instances/dev-a" };
  const active = raw => projectActivePanel({ instances: [{ ...base, ...raw }] }).instances[0];
  for (const value of [{ state: "running", since: SINCE, self: true }, { state: "unknown", since: SINCE, self: false },
    { state: "interrupted", since: SINCE, self: true }, { state: "failed", since: SINCE, self: true, code: "E_RETIRE_HOOK", message: "the hook exited 1" }]) {
    assert.deepEqual(active({ retire: value }).retire, value, JSON.stringify(value));
  }
  for (const value of [null, { state: "failed", since: SINCE, self: true, code: null }, { state: "failed", since: SINCE, self: true, message: null }, "running", [], { state: "done", since: SINCE, self: true }, { state: "running", self: true }, { state: "running", since: 7, self: true },
    { state: "running", since: SINCE, self: "yes" }, { state: "failed", since: SINCE, self: true, code: "boom" }, { state: "failed", since: SINCE, self: true, message: 7 }]) {
    const row = active({ retire: value });
    assert.equal(Object.hasOwn(row, "retire"), false, JSON.stringify(value));
    assert.equal(tree.heldHome(row), null, `malformed reads as absent: ${JSON.stringify(value)}`);
    // Beside retirePending, a malformed retire is still absent: the row reads as an older kernel's (retiring).
    assert.equal(tree.heldHome(active({ retire: value, retirePending: true })).kind, "retiring", JSON.stringify(value));
  }
  assert.equal(active({ retirePending: true, retire: { state: "interrupted", since: SINCE, self: true } }).retirePending, true);
});

test("heldHome precedence (#1247): this window's retire wins over every kernel fact; then a gone spawn, a live spawn, the kernel's retire", () => {
  const kind = row => tree.heldHome(row)?.kind ?? null;
  for (const state of ["running", "unknown"]) assert.equal(kind(retire(state)), "retiring", state);
  assert.equal(kind(retire("failed")), "retire-failed");
  assert.equal(kind(retire("interrupted")), "retire-incomplete");
  // The kernel's retire wins over retirePending beside it; a row without one is an older kernel's (retiring).
  assert.equal(kind({ retirePending: true, ...retire("failed") }), "retire-failed");
  assert.equal(kind({ retirePending: true, ...retire("interrupted") }), "retire-incomplete");
  for (const hold of [{ rollbackIncomplete: true }, { spawnInProgress: true }, retire("failed"), retire("interrupted"), { retirePending: true }]) {
    assert.equal(kind({ ...hold, retireInFlight: true }), "retiring", `this window's own retire is the newest fact: ${JSON.stringify(hold)}`);
  }
  assert.equal(kind({ retireInFlight: "true" }), null, "true only");
  for (const state of ["running", "failed", "interrupted"]) {
    assert.equal(kind({ rollbackIncomplete: true, ...retire(state) }), "spawn-incomplete", state);
    assert.equal(kind({ spawnInProgress: true, ...retire(state) }), "spawning", state);
  }
});

for (const [name, hold] of Object.entries(RETIRING)) {
  test(`retiring (${name}): “Retiring…”, no hint, opens and starts nothing; its menu keeps Retire, never as the default`, async t => {
    const u = fixture(t, () => []);
    u.render([...roster, instance("dev-r", "root", { running: true, ...hold })]);
    const button = u.row("dev-r");
    assert.equal(button.querySelector(".ctx-spawn-state").textContent, "Retiring…", "text, not colour alone");
    assert.equal(button.querySelector(".ctx-held-hint"), null, "nothing to do but wait: no hint line");
    assert.equal(button.getAttribute("aria-disabled"), "true"); assert.equal(button.getAttribute("aria-description"), "dev-r is being retired.");
    assert.doesNotMatch(button.textContent, /fail|didn't finish/i, "never read as a failure");
    button.click(); assert.deepEqual(u.opened, [], "activation opens and starts nothing");
    assert.equal(u.wrap("dev-r").querySelector(".ctx-start"), null, "no Start…");
    assert.deepEqual(u.menu("dev-r"), ["details", "retire"], "Details and Retire: no Inspect, Start, Stop, Restart or split");
    const retireItem = u.wrap("dev-r").querySelector("[data-action=retire]");
    assert.equal(retireItem.disabled, false); assert.equal(retireItem.dataset.secondary, "true"); assert.equal(retireItem.autofocus, false);
    // No terminal tab is open (the fixture's tabs are empty): the row's context menu, from a key (Shift+F10, the Menu key)
    // or a right-click, lands on the menu itself, not on Retire; Esc hands focus back to the row. The arrows reach
    // Retire, which still opens the plan dialog.
    assert.equal(u.wrap("dev-r").querySelector(".ctx-instance-actions"), null, "no ⋯ trigger");
    const menu = u.wrap("dev-r").querySelector(".ctx-instance-menu");
    for (const [how, at] of [["a key", {}], ["a right-click", { x: 40, y: 20 }]]) {
      button.focus(); u.contextMenu("dev-r", at);
      assert.equal(menu.dataset.instanceMenuOpen, "true", `${how}: opened`);
      assert.equal(u.doc.activeElement, menu, `${how}: focus on the menu, Retire is not the default`);
      u.key(menu, "Escape");
      assert.equal(menu.dataset.instanceMenuOpen, "false"); assert.equal(u.doc.activeElement, button, `${how}: Esc, focus back on the row`);
    }
    assert.deepEqual(u.opened, [], "a right-click activates nothing"); assert.deepEqual(u.said, [], "a limited row's menu is not held");
    menu.openActionMenu();
    assert.equal(u.doc.activeElement, menu);
    menu.dispatchEvent(new u.doc.defaultView.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    assert.equal(u.doc.activeElement, retireItem, "reachable");
    retireItem.click(); await new Promise(r => setImmediate(r));
    assert.equal(u.lifecycle.length, 1); assert.equal(u.lifecycle[0][0], "retire"); assert.equal(u.lifecycle[0][1].home, "/synthetic/dev-r");
  });
}

test("a row its host no longer lists: its context menu offers Forget… alone, which opens the Forget confirmation", async t => {
  const u = fixture(t, () => []);
  const gone = { ...instance("gone"), home: "/srv/agents/dev/instances/gone", agentsRoot: "/srv/agents", server: "build", repoName: "Build box",
    addressable: false, savedRoute: true, missingRemotely: true, running: null };
  u.render([...roster, gone]);
  noTools(u, "gone");
  assert.deepEqual(u.menu("gone"), ["forget"], "Forget… alone");
  u.row("gone").focus(); u.contextMenu("gone");
  const menu = u.wrap("gone").querySelector(".ctx-instance-menu");
  assert.equal(menu.dataset.instanceMenuOpen, "true", "a missing row's menu opens, though the row is blocked"); assert.deepEqual(u.said, []);
  const forget = u.wrap("gone").querySelector("[data-action=forget]");
  assert.equal(u.doc.activeElement, forget, "Forget… is its default");
  forget.click(); await new Promise(r => setImmediate(r));
  assert.equal(u.forgets.length, 1); assert.equal(u.forgets[0][0].home, gone.home); assert.equal(u.forgets[0][1], "A");
  assert.deepEqual(u.lifecycle, []); assert.deepEqual(u.opened, []);
});

test("a right-click on a row opens its context menu and never activates the row: no terminal, no Start", t => {
  const u = fixture(t, () => []);
  u.render([...roster, instance("off", undefined, { running: false })]);
  for (const name of ["root", "off"]) {
    assert.equal(u.wrap(name).querySelector(".ctx-instance-actions"), null, `${name}: no ⋯ trigger`);
    u.row(name).focus();
    const event = new u.doc.defaultView.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 12 });
    u.row(name).dispatchEvent(event);
    assert.equal(event.defaultPrevented, true, `${name}: the page's menu, not the native one`);
    const menu = u.wrap(name).querySelector(".ctx-instance-menu");
    assert.equal(menu.dataset.instanceMenuOpen, "true", `${name}: its menu opens`);
    assert.ok(menu.contains(u.doc.activeElement), `${name}: focus in its menu`);
    u.key(u.doc.activeElement, "Escape");
    assert.equal(u.doc.activeElement, u.row(name), `${name}: Esc, back on the row`);
  }
  assert.deepEqual(u.opened, [], "neither row opened a terminal or Start");
  assert.deepEqual(u.said, []);
});

test("a failed retire with the kernel's message: “Retire failed”, its hint, and the message said after the kernel's words, filtered", async t => {
  const u = fixture(t, () => []);
  const failed = extra => instance("dev-f", "root", { running: false, ...retire("failed", { code: "E_RETIRE_HOOK", ...extra }) });
  u.render([...roster, failed({ message: "the pre-retire hook exited 1" })]);
  const button = u.row("dev-f");
  assert.equal(button.querySelector(".ctx-spawn-state").textContent, "Retire failed");
  assert.equal(button.querySelector(".ctx-held-hint").textContent, "Retire it again to finish");
  assert.equal(button.getAttribute("aria-description"), "OATS says: the pre-retire hook exited 1 (E_RETIRE_HOOK)");
  assert.deepEqual(u.menu("dev-f"), ["details", "retire"]);
  const retireItem = u.wrap("dev-f").querySelector("[data-action=retire]");
  assert.equal(retireItem.dataset.secondary, undefined); assert.equal(retireItem.autofocus, true, "Retire is the way on: the default");
  // A control character withholds the message whole; an over-long one is one bounded line.
  u.render([...roster, failed({ message: "wipe \x1b[2J the screen" })]);
  assert.equal(u.row("dev-f").getAttribute("aria-description"), "[withheld]");
  u.render([...roster, failed({ message: `${"x".repeat(5000)} end` })]);
  const said = u.row("dev-f").getAttribute("aria-description");
  assert.ok(said.startsWith("OATS says: xxx") && said.length <= "OATS says: ".length + 2048, "bounded"); assert.doesNotMatch(said, /\x1b| end/);
  // Only a code: the kernel's code, under its speaker and through the filter, as its message is.
  u.render([...roster, failed({})]);
  assert.equal(u.row("dev-f").getAttribute("aria-description"), "OATS says: E_RETIRE_HOOK");
  assert.equal(heldLine(null), null);
});

test("the same row reads every state of its retire in turn, and back to an ordinary row when the hold is gone", async t => {
  const u = fixture(t, () => []);
  const read = hold => { u.render([...roster, instance("dev-r", "root", { running: true, ...hold })]); return u.row("dev-r").querySelector(".ctx-meta").textContent; };
  assert.equal(read({ retireInFlight: true }), "Retiring…");
  assert.equal(read(retire("running")), "Retiring…");
  assert.equal(read(retire("unknown")), "Retiring…");
  assert.equal(read(retire("failed")), "Retire failed");
  assert.equal(read(retire("interrupted")), "Retire didn't finish");
  const meta = read({});
  assert.doesNotMatch(meta, /Retir/);
  assert.equal(u.row("dev-r").querySelector(".ctx-meta").className, "ctx-meta ctx-row-detail", "its own second line again: the soul and the machine");
  assert.equal(meta, "dev · This Mac");
  assert.ok(u.row("dev-r").querySelector(".ctx-dot.on"), "and its liveness on its dot");
  assert.deepEqual(u.menu("dev-r"), ["details", "open-split", "open-pr", "inspect", "restart", "stop", "retire"]);
});
