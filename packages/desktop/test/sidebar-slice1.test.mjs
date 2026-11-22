// Slice 1 of the Desktop UI rework: the sidebar and the roster (the spec's pinned acceptance, by name). Executes the
// shipped roster paint (shell.mjs renderContextRoster), the shipped foot (sidebar-foot.mjs, and the shell's
// focusFirstNeedingYou), the shipped nav build with its Automations failure mark, the shipped palette command list and
// the failure mark's reader (automations-failure.mjs), on the shipped index.html and shell.css. No shell startup,
// HTTP, Electron, CLI or session. The shared row facts are test/client-roster-row-facts.test.mjs's.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { viewContext } from "./helpers/view-context.mjs";
import * as treeShared from "../../client/instance-tree.mjs";
import * as relatedWork from "../../client/related-work.mjs";
import * as treeView from "../renderer/instance-tree-view.mjs";
import { instanceActions, captureInstanceActionMenu } from "../renderer/instance-actions.mjs";
import { instanceActionTarget, sameInstanceActionTarget } from "../renderer/instance-action-target.mjs";
import { instanceSplitPlan } from "../renderer/instance-split.mjs";
import { runtimeState, unsupportedSession } from "../../client/instance-presentation.mjs";
import { canAddressRemote, rowReason } from "../../client/remote-address.mjs";
import { iconElement, shellIcon, mountShellIcons } from "../renderer/shell-icons.mjs";
import { createSidebarFoot, newLabel, needYouText, needYouName, emptyRosterText } from "../renderer/sidebar-foot.mjs";
import { DESKTOP_NOUNS, DESKTOP_TERMS } from "../renderer/desktop-terms.mjs";
import { createAutomationsFailure, failedRuns, lastRunFailed, FAILED_RUN_TEXT, AUTOMATIONS_FAILURE_TTL } from "../renderer/automations-failure.mjs";
import { automationRow } from "../renderer/automation-rows.mjs";
import { createWorkspaceSwitcher } from "../renderer/workspace-switcher.mjs";
import { createFocusRegions } from "../renderer/focus-regions.mjs";
import { NAV, NAV_TABS, PINNED } from "../renderer/shell-nav.mjs";
import { rosterRowFacts } from "../../client/roster-row-facts.mjs";
import { THEMES } from "../renderer/theme.mjs";
import { PIN_LABELS } from "../renderer/instance-pin-menu.mjs";
const tree = { ...treeShared, ...treeView, ...relatedWork }; // the renderer's client imports, shipped

const read = name => readFileSync(new URL(`../renderer/${name}`, import.meta.url), "utf8");
const shell = read("shell.mjs"), html = read("index.html"), css = read("shell.css");
const fn = name => { const found = shell.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`)); assert.ok(found, name); return found[0]; };
const source = ["renderContextRoster", "needsInputMark", "pendingSpawnRow", "setRovingRow", "focusFirstNeedingYou", "setBackgroundOpen"].map(fn).join("\n");

const SINCE = "2026-10-03T09:00:00.000Z";
const claim = (extra = {}) => ({ since: SINCE, producer: "claude-hooks", reason: "permission", message: null, ...extra });
const local = (name, extra = {}) => ({ instance: name, agent: "oats-desktop-developer", home: `/synthetic/${name}`, agentsRoot: "/synthetic/agents",
  repoName: "desktop-repo", branch: `b/${name}`, harness: "claude", running: true, createdAt: "2026-10-01T00:00:00.000Z", ...extra });
const remote = (name, extra = {}) => ({ instance: name, agent: "oats-maintainer", home: `/srv/agents/oats-maintainer/instances/${name}`, agentsRoot: "/srv/agents",
  server: "polaris-id", repoName: "polaris", addressable: true, harness: "pi", running: true, createdAt: "2026-10-01T00:00:00.000Z", ...extra });

/** The shipped roster paint and foot over the shipped index.html, in workspace "A". */
function fixture(t, { context: extra = {}, nouns = DESKTOP_NOUNS } = {}) {
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  // jsdom has no top-layer API: model the popover's open/close events (instance-actions.test.mjs does the same).
  dom.window.requestAnimationFrame ??= cb => { cb(); return 0; };
  for (const [method, newState] of [["showPopover", "open"], ["hidePopover", "closed"]]) {
    dom.window.HTMLElement.prototype[method] = function () {
      const event = new dom.window.Event("beforetoggle");
      Object.defineProperty(event, "newState", { value: newState });
      this.dispatchEvent(event);
    };
  }
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
    ...extra,
  };
  context.splitOpenState = () => ({ split: null, activeId: null, tabs: context.tabs, workspace: "A", visible: false });
  context.ownsInstanceTarget = target => context.contextInstances.filter(row => sameInstanceActionTarget(target, row, "A")).length === 1;
  Object.defineProperty(context, "Date", { get: () => Date, enumerable: true });
  const s = runInNewContext(`${source}\n({ render: renderContextRoster, focusFirstNeedingYou })`, context);
  // The shell's foot, as it builds it (its count painted by every roster paint).
  context.sidebarFoot = createSidebarFoot(doc, { nouns, onNeedYou: () => s.focusFirstNeedingYou() });
  const list = doc.querySelector(".ctx-list");
  const render = rows => { context.contextInstances = rows; s.render(rows); };
  const row = name => [...list.querySelectorAll(".ctx-inst")].find(b => b.querySelector(".ctx-name")?.dataset.name === name);
  const lines = name => { const r = row(name); return [r.querySelector(".ctx-name > [aria-hidden]").textContent, r.querySelector(".ctx-meta").textContent]; };
  const menu = name => [...row(name).closest(".ctx-tree-row").querySelectorAll(".ctx-instance-menu [role=menuitem]")];
  return { dom, doc, context, render, list, row, lines, menu, need: doc.getElementById("sidebar-need-you") };
}

test("slice1 row shows name and soul, and the machine only for another machine's (slice 3d)", t => {
  const u = fixture(t);
  u.render([local("desktop-mockups"), remote("release-0-68"), local("forgotten-one", { agent: undefined, running: false })]);
  assert.deepEqual(u.lines("desktop-mockups"), ["Desktop mockups", "oats-desktop-developer"], "a running local row: its soul alone (slice 3d, superseding slice 1's this-machine name)");
  assert.deepEqual(u.lines("release-0-68"), ["Release 0 68", "oats-maintainer · polaris"], "a remote row: its server's label");
  assert.deepEqual(u.lines("forgotten-one"), ["Forgotten one", "This Mac"], "a row with no soul known: the machine only");
  // Slice 3d (Joan's 1:1 ask, superseding slice 1's call that a local row names this machine): a local row says no
  // machine, whatever host name the kernel reports (oats-local.yaml host.name, read from the schedule list).
  u.context.thisHostName = "falcon";
  u.render([local("desktop-mockups"), remote("release-0-68")]);
  assert.deepEqual(u.lines("desktop-mockups"), ["Desktop mockups", "oats-desktop-developer"]);
  assert.deepEqual(u.lines("release-0-68"), ["Release 0 68", "oats-maintainer · polaris"], "a remote row keeps its own");
  u.context.thisHostName = null;
  u.render([local("desktop-mockups"), remote("release-0-68"), local("forgotten-one", { agent: undefined, running: false })]);
  for (const name of ["desktop-mockups", "release-0-68", "forgotten-one"]) {
    const r = u.row(name), copy = r.querySelector(".ctx-copy");
    assert.deepEqual([...copy.children].filter(el => !el.classList.contains("sr-only")).map(el => el.className), ["ctx-name", "ctx-meta ctx-row-detail"], `${name}: exactly two lines`);
    assert.doesNotMatch(r.textContent, /desktop-repo|b\//, `${name}: no repository, no branch`);
    assert.equal(r.querySelector(".runtime-badge, .ctx-runtime"), null, `${name}: no harness badge`);
    assert.equal(r.lastElementChild, copy, `${name}: nothing after the two lines`);
    assert.equal(r.firstElementChild.classList.contains("ctx-dot"), true, `${name}: the dot leads the row`);
  }
  // A remote row whose machine didn't answer (the unknown dot, dim): both lines still.
  u.render([remote("far", { running: null, serverUnreached: true, runtimeError: "ssh failed" })]);
  assert.deepEqual(u.lines("far"), ["Far", "oats-maintainer · polaris"]);
  assert.ok(u.row("far").querySelector(".ctx-dot.unknown"));
  // Its state in words, as the card said it (the dot says it by shape and colour alone): running or stopped is heard
  // before opening a terminal or starting an agent, visually hidden, after the two lines.
  u.render([local("same-a"), local("same-b", { running: false }), local("same-c", { running: null })]);
  assert.deepEqual(["same-a", "same-b", "same-c"].map(n => u.row(n).querySelector(".ctx-state")?.textContent), [", running", ", stopped", ", status unknown"]);
  assert.ok(u.row("same-b").querySelector(".ctx-state").classList.contains("sr-only"));
  // A row the roster reports setting up its worktree keeps its reported facts on its tooltip, its soul included (its
  // state takes line 2); a pending row only this window knows guesses none.
  u.render([local("setting-up", { running: false, spawnInProgress: true, branch: "b/setting-up", model: "opus" })]);
  assert.equal(u.row("setting-up").title.split("\n")[1], "Soul: oats-desktop-developer · Repository: desktop-repo · Branch: b/setting-up · Claude · opus");
  u.context.spawnJobs = { rows: () => [{ id: "j1", instance: "fresh", agent: "oats-expert", home: "/synthetic/fresh", agentsRoot: "/synthetic/agents", pending: "spawning" }], announce: () => false, check() {} };
  u.render([]);
  assert.equal(u.row("fresh").title.includes("\n"), false, "nothing reported, nothing added");
  u.context.spawnJobs = { rows: () => [], announce: () => false, check() {} };
  // The facts the card held that the lines don't (an interim the lead agreed): the repository, the branch and the
  // harness and model, on the row's native tooltip only; never in its description, and no card is mounted.
  u.render([local("desktop-mockups", { model: "opus" })]);
  assert.equal(u.row("desktop-mockups").title, "Repository: desktop-repo · Branch: b/desktop-mockups · Claude · opus");
  assert.equal(u.row("desktop-mockups").hasAttribute("aria-description"), false);
  assert.equal(u.doc.querySelector(".ctx-tip, [role=tooltip]"), null);
  // A row with no terminal has no instance panel: its runtime error, with its speaker, is its title and description
  // (the hover card said it), and line 2 stays its soul (a local row's: no machine).
  u.render([local("broken", { running: false, runtimeError: "the last start failed", runtimeErrorOrigin: "kernel" })]);
  assert.equal(u.row("broken").title, "OATS says: the last start failed\nRepository: desktop-repo · Branch: b/broken · Claude", "its error, then its facts");
  assert.equal(u.row("broken").getAttribute("aria-description"), "OATS says: the last start failed");
  assert.deepEqual(u.lines("broken"), ["Broken", "oats-desktop-developer"]);
  u.render([remote("far", { running: null, serverUnreached: true, runtimeError: "ssh failed" })]);
  // The two facts are the shared function's (packages/client roster-row-facts.mjs), never the row's own composition.
  assert.equal(u.lines("far")[1], rosterRowFacts(remote("far"), DESKTOP_TERMS).detail);
  // 44px rows, the dot centred on the row (the row is a flex line centred on its cross axis).
  const rule = selector => [...u.doc.styleSheets].flatMap(sheet => [...sheet.cssRules]).find(r => r.selectorText === selector).style;
  assert.equal(rule(".ctx-tree-row").minHeight, "44px");
  assert.equal(rule(".ctx-inst").alignItems, "center");
  // A long name: one line, cut at its end with an ellipsis (today's rule); the whole name is its accessible name.
  assert.deepEqual([rule(".ctx-name").whiteSpace, rule(".ctx-name").textOverflow], ["nowrap", "ellipsis"]);
});

test("slice1 no hover card or hover tools", t => {
  const u = fixture(t);
  u.render([local("dev-a"), local("dev-b", { running: false }), local("dev-u", { running: null }), local("dev-h", { running: false, rollbackIncomplete: true })]);
  for (const name of ["dev-a", "dev-b", "dev-u", "dev-h"]) {
    const r = u.row(name);
    for (const type of ["mouseenter", "mouseover", "pointerenter"]) r.dispatchEvent(new u.dom.window.MouseEvent(type, { bubbles: true }));
    r.focus(); r.dispatchEvent(new u.dom.window.FocusEvent("focus"));
    assert.equal(u.doc.querySelector(".ctx-tip, #ctx-roster-tip, [role=tooltip]"), null, `${name}: no roster tip`);
    assert.equal(r.closest(".ctx-tree-row").querySelector(".ctx-row-tools, .ctx-start, .ctx-pr-open"), null, `${name}: no tools overlay`);
    assert.equal(r.hasAttribute("aria-describedby"), false, `${name}: described by no card`);
  }
  assert.equal(existsSync(new URL("../renderer/roster-tip.mjs", import.meta.url)), false, "the card's module is gone");
  assert.doesNotMatch(shell, /rosterTip|ctx-row-tools"|ctx-pr-open/, "and nothing builds either");
});

test("slice1 context menu keeps every action", t => {
  const u = fixture(t);
  const rows = { running: local("dev-run"), stopped: local("dev-stop", { running: false }), unknown: local("dev-unk", { running: null }),
    held: local("dev-held", { running: false, rollbackIncomplete: true }), "remote stopped": remote("dev-far", { running: false }) };
  u.render(Object.values(rows));
  // What the removed overlay offered, per row (shell.mjs before slice 1): the pull request's link on a local row that is
  // not held, and Start… on a stopped row that is not held. Today's menu items besides (instance-acts.mjs, #1559).
  const overlay = { running: ["open-pr"], stopped: ["open-pr", "start"], unknown: ["open-pr"], held: [], "remote stopped": ["start"] };
  const today = { running: ["open-split", "open-pr", "inspect", "restart", "stop", "retire"], stopped: ["open-split", "open-pr", "inspect", "start", "stop", "retire"],
    unknown: ["open-split", "open-pr", "inspect", "stop", "retire"], held: ["retire"], "remote stopped": ["open-split", "open-pr", "inspect", "start", "stop", "retire"] };
  for (const [kind, row] of Object.entries(rows)) {
    const items = u.menu(row.instance).map(item => item.dataset.action);
    assert.deepEqual(items, today[kind], `${kind}: today's menu, unchanged`);
    for (const action of overlay[kind]) assert.ok(items.includes(action), `${kind}: the overlay's ${action} is the menu's`);
  }
  // Start… is enabled where the overlay's was (a stopped, addressable row that is not held).
  for (const name of ["dev-stop", "dev-far"]) assert.equal(u.menu(name).find(item => item.dataset.action === "start").disabled, false, name);
  assert.equal(u.menu("dev-run").find(item => item.dataset.action === "open-pr").disabled, false, "Open pull request… on a local row");
  // The menu opens from the keyboard (a key's contextmenu: no pointer), on every kind of row.
  for (const row of Object.values(rows)) {
    const button = u.row(row.instance);
    button.dispatchEvent(new u.dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }));
    assert.equal(button.closest(".ctx-tree-row").querySelector(".ctx-instance-menu").dataset.instanceMenuOpen, "true", `${row.instance}: its menu opens`);
    u.doc.activeElement.dispatchEvent(new u.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  }
});

test("slice1 lines for related work only; the tree, the order and the needs-input marks unchanged", t => {
  const u = fixture(t);
  // The related-work lines (superseding in part D26's "no lines"): the roster draws the pre-D26 lines where its host
  // reports related work, and no line elsewhere. The tree stays (indentation, the groups, the gap before the next
  // bundle), its relations are said in words, and the order is spawn time, newest first
  // (rosters-order-by-spawn-time-newest-first): the shared order roster-order.test.mjs pins, untouched.
  const at = day => `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`;
  const R = relatedWork.RELATED_WORK_FEATURE;
  const rows = [local("p", { createdAt: at(1) }), local("b", { parentInstance: "p", createdAt: at(2) }),
    local("c", { parentInstance: "p", relatedWork: true, createdAt: at(3) }), local("solo-old", { createdAt: at(4) }),
    local("solo-mid", { createdAt: at(6), siblingInstance: "solo-old" }),
    local("solo-new", { createdAt: at(9), siblingInstance: "solo-old", relatedWork: true }), local("needs", { createdAt: at(5), waitingOnYou: claim() })]
    .map(r => ({ ...r, relatedWorkKnown: R }));
  u.render(rows);
  const drawn = [...u.list.querySelectorAll(".ctx-inst")].map(b => b.dataset.treeInstance);
  const order = tree.clusterInstances(rows).flatMap(c => c.instances);
  assert.deepEqual(drawn, order.map(tree.instanceId), "the shared cluster order: spawn time, newest first");
  assert.deepEqual(order.map(i => i.instance), ["solo-new", "solo-mid", "solo-old", "needs", "p", "c", "b"],
    "newest bundle first (the sibling-linked rows are one bundle), a waiting row not moved up; the related child first under its parent");
  const guides = name => [...u.row(name).closest(".ctx-tree-row").querySelectorAll(":scope > .ctx-guides > .ctx-guide")]
    .map(g => `${g.className.replace("ctx-guide ", "")}@${g.style.getPropertyValue("--guide-level")}`);
  assert.deepEqual(Object.fromEntries(order.map(i => [i.instance, guides(i.instance)])), {
    "solo-new": ["link-out@0"], "solo-mid": [], "solo-old": ["link-in@0"], needs: [],
    p: ["down@0"], c: ["elbow@0"], b: [],
  }, "the related pair joined on the dot column, the unrelated sibling between them a gap; the related child's elbow, none to b");
  for (const name of ["solo-mid", "needs", "b"]) assert.equal(u.row(name).closest(".ctx-tree-row").querySelector(".ctx-guides"), null, `${name}: no guides at all`);
  assert.ok([...u.list.querySelectorAll(".ctx-guides")].every(g => g.getAttribute("aria-hidden") === "true"), "the lines are aria-hidden");
  // Indentation keeps the tree: a child one step in, its parent at the top level.
  const depth = name => u.row(name).closest(".ctx-tree-row").style.getPropertyValue("--depth");
  assert.deepEqual(["p", "c", "b", "needs"].map(depth), ["0", "1", "1", "0"]);
  // The relations in words, after the name, for assistive technology only: "related work" where the line is drawn.
  const words = name => u.row(name).querySelector(".ctx-relation")?.textContent ?? null;
  assert.equal(words("c"), ", under p, related work"); assert.equal(words("b"), ", under p");
  assert.equal(words("solo-new"), ", sibling of solo-old, related work");
  assert.equal(words("solo-old"), ", sibling of solo-new, related work, sibling of solo-mid", "on both ends; the unrelated sibling without it");
  assert.equal(words("solo-mid"), ", sibling of solo-old");
  assert.equal(words("p"), null); assert.equal(words("needs"), null);
  assert.ok(u.row("c").querySelector(".ctx-relation").classList.contains("sr-only"));
  assert.ok([...u.list.querySelectorAll(".ctx-relation")].every(el => !/same work/.test(el.textContent)), "\"same work\" is said nowhere");
  // An older host (instance-same-work only): the child's line from its flag (here as a relaying CLI sends it), no sibling link.
  u.render(rows.map(r => ({ ...r, relatedWorkKnown: relatedWork.SAME_WORK_FEATURE })));
  assert.deepEqual(["solo-new", "solo-old", "p", "c"].map(guides), [[], [], ["down@0"], ["elbow@0"]]);
  assert.equal(words("c"), ", under p, related work"); assert.equal(words("solo-new"), ", sibling of solo-old");
  // A host that reports neither feature: no line, and no row is said to do related work, a flag on its row included.
  u.render(rows.map(({ relatedWorkKnown: _known, ...r }) => r));
  assert.equal(u.list.querySelector(".ctx-guides, .ctx-guide"), null, "no flag, no line anywhere in the roster");
  assert.equal(words("c"), ", under p", "an unknown feature says nothing of the flag");
  assert.equal(words("solo-new"), ", sibling of solo-old");
  assert.ok(u.row("needs").querySelector(".ctx-dot.waiting"), "the yellow needs-input dot, as today");
  // The collapsed-parent roll-up, as today.
  u.context.collapsedInstances.add(tree.collapseKey("A", tree.instanceId(rows[0])));
  u.render([...rows.slice(0, 3).map((r, i) => i === 2 ? { ...r, waitingOnYou: claim() } : r)]);
  assert.equal(u.row("p").querySelector(".ctx-attn").textContent, "1 below need input");
  // Air between bundles: a spacer between two top-level bundles of one group; the rows keep their order.
  u.context.collapsedInstances.clear();
  u.render([local("x", { createdAt: at(1) }), local("y", { createdAt: at(2) })]);
  assert.deepEqual([...u.list.children].map(el => el.className.split(" ")[0]), ["ctx-group", "ctx-tree-row", "ctx-bundle-gap", "ctx-tree-row"]);
  assert.equal(u.list.querySelector(".ctx-bundle-gap").getAttribute("aria-hidden"), "true");
  for (const file of ["related-work-lines.test.mjs", "roster-order.test.mjs"]) assert.ok(existsSync(new URL(file, import.meta.url)), `${file} still runs`);
});

test("slice1 switcher head has no show-only-current, add workspace reachable", t => {
  const dom = new JSDOM(html);
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const head = doc.querySelector("#sidebar > .side-head");
  assert.deepEqual([...head.children].map(el => el.id), ["ws-heading", "ws-add-open"]);
  assert.equal(doc.getElementById("ws-current-only"), null, "no Show only the current workspace in the head");
  assert.doesNotMatch(html, /Show only the current workspace|workspaces\.currentOnly/);
  const opened = [];
  const switcher = createWorkspaceSwitcher({ document: doc, selectWorkspace() {}, discoverSuggestions: async () => { opened.push("discover"); return []; },
    addWorkspace: async () => ({}), pickWorkspace: async () => ({}) });
  t.after(() => switcher.dispose());
  switcher.begin()({ id: "/w/a", name: "A" }, [{ id: "/w/a", name: "A" }]);
  const add = doc.getElementById("ws-add-open");
  assert.equal(add.tagName, "BUTTON"); assert.equal(add.getAttribute("aria-label"), "Add local workspace…");
  assert.ok(add.tabIndex >= 0 && !add.hidden && !add.disabled, "a keyboard stop of the switcher");
  add.focus(); assert.equal(doc.activeElement, add);
  add.click();
  assert.equal(doc.getElementById("ws-modal").hidden, false, "it opens Add local workspace…");
  // F6 lands on it when the list has no row to stop on.
  doc.getElementById("ws-options").replaceChildren();
  const regions = createFocusRegions({ doc });
  assert.equal(regions.currentItem("workspaces"), add);
});

test("slice1 automations failure mark", async t => {
  const schedule = (outcome, extra = {}) => ({ qualifiedId: `s-${outcome ?? "none"}`, kind: "spawn", lastRun: outcome === undefined ? null : { outcome, scheduledFor: SINCE }, ...extra });
  const answer = (...rows) => [["schedule", { schedules: rows }], ["trigger", { triggers: [{ qualifiedId: "t", lastRun: { at: SINCE, instance: "x" } }] }]];
  assert.equal(failedRuns(answer(schedule("launch-failed"), schedule("ended"))), 1, "one failed last run");
  assert.equal(failedRuns(answer(schedule("invalid"))), 1);
  assert.equal(failedRuns(answer(schedule("ended"), schedule(undefined))), 0, "none failed, or none ran");
  assert.equal(failedRuns(answer(schedule("unknown"))), 0, "an unknown outcome is no failure");
  assert.equal(lastRunFailed(automationRow({ qualifiedId: "t", lastRun: { outcome: "launch-failed" } }, "trigger")), false, "a trigger's last run carries no outcome of its own");
  assert.equal(failedRuns([["schedule", null], ["trigger", "garbage"]]), 0, "an answer that isn't a list counts none");
  // The shipped nav build and its mark: absent, then "Automations, a run failed", then cleared.
  const dom = new JSDOM(html);
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const block = shell.slice(shell.indexOf('const navEl = document.getElementById("nav");'), shell.indexOf("// The foot's controls use exactly the same registry"));
  const { paintAutomationsFailed } = runInNewContext(`${block}\n({ paintAutomationsFailed })`, { document: doc, NAV, PINNED, shellIcon, runAction() {}, FAILED_RUN_TEXT });
  const row = doc.querySelector('#nav .nav-item[data-view="automations"]');
  // Its accessible name: the text that is not aria-hidden.
  const name = () => [...row.querySelectorAll("*")].filter(el => !el.children.length && !el.closest("[aria-hidden=true]")).map(el => el.textContent).join("").replace(/\s+/g, " ").trim();
  assert.equal(name(), "Automations"); assert.equal(row.querySelector(".nav-failed"), null);
  paintAutomationsFailed(1);
  assert.equal(name(), "Automations, a run failed", "its accessible name says so");
  // Slice 3d: the prototype's "1 failed" after the name, shown, the words beside it for assistive tech.
  const count = row.querySelector(".nav-failed-count");
  assert.deepEqual([count.textContent, count.getAttribute("aria-hidden")], ["1 failed", "true"], "the count shown, decoration beside the words");
  assert.equal(row.querySelectorAll(".nav-failed").length, 1);
  paintAutomationsFailed(2); assert.equal(row.querySelectorAll(".nav-failed").length, 1, "never doubled");
  assert.equal(row.querySelector(".nav-failed-count").textContent, "2 failed", "the count follows");
  paintAutomationsFailed(0);
  assert.equal(name(), "Automations"); assert.equal(row.querySelector(".nav-failed"), null, "cleared when no last run is failed");
  // The reader: a latest-intent token per read; a new workspace clears the mark at once; a late answer for another
  // workspace, or a failure, changes nothing; re-read after the TTL.
  let clock = 0; const verdicts = [], counts = [], gates = [];
  const reader = createAutomationsFailure({ now: () => clock, onChange: v => verdicts.push(v), onCount: n => counts.push(n),
    read: (ws, kind) => new Promise((resolve, reject) => gates.push({ ws, kind, resolve, reject })) });
  const failing = { schedules: [{ qualifiedId: "s", kind: "spawn", lastRun: { outcome: "launch-failed" } }] }, fine = { schedules: [], triggers: [] };
  let pending = reader.refresh("A");
  assert.deepEqual(gates.map(g => [g.ws, g.kind]), [["A", "schedule"], ["A", "trigger"]]);
  gates[0].resolve(failing); gates[1].resolve({ triggers: [] }); await pending;
  assert.deepEqual(verdicts, [true]); assert.equal(reader.failed, true);
  assert.deepEqual(counts, [1], "the count, told as it changes (slice 3d: the row's \"1 failed\")"); assert.equal(reader.count, 1);
  await reader.refresh("A"); assert.equal(gates.length, 2, "within the TTL: no read");
  clock = AUTOMATIONS_FAILURE_TTL;
  pending = reader.refresh("A"); const late = gates.slice(2);
  const switched = reader.refresh("B");
  assert.deepEqual(verdicts, [true, false], "a switch clears the mark at once");
  assert.deepEqual(counts, [1, 0], "and its count");
  late[0].resolve(failing); late[1].resolve({ triggers: [] }); await pending;
  assert.equal(reader.failed, false, "A's late answer changes nothing for B");
  const forB = gates.slice(4); forB[0].reject(new Error("down")); forB[1].resolve(fine); await switched;
  assert.equal(reader.failed, false, "a failed read keeps the last verdict");
  await reader.refresh(null); assert.equal(reader.failed, false);
  // The schedule list's host.name is this machine's name, handed on with each owned read.
  // A name taken away hands on null (the rows fall back); a failed read hands on nothing (the last name stands).
  let hostName = "falcon", fail = false; const hosts = [];
  const named = createAutomationsFailure({ ttl: 0, onHost: h => hosts.push(h), read: async (ws, kind) => {
    if (fail) throw new Error("down");
    return kind === "schedule" ? { schedules: [], host: { name: hostName, ghUser: {} } } : { triggers: [] }; } });
  await named.refresh("A"); assert.deepEqual(hosts, ["falcon"]);
  hostName = null; await named.refresh("A"); assert.deepEqual(hosts, ["falcon", null], "a machine with no name recorded: null");
  hostName = "falcon"; await named.refresh("A"); fail = true; await named.refresh("A");
  assert.deepEqual(hosts, ["falcon", null, "falcon"], "a failed read hands on nothing");
  assert.match(shell, /onHost: \(name\) => \{ statusLine\.setMachine\(name\); if \(name !== thisHostName\) \{ thisHostName = name;/, "and the key bar's right shows it (slice 3d)");
  assert.match(shell, /rosterRowFacts\(i, DESKTOP_TERMS, \{ deployments: contextDeployments, here: thisHostName \}\)/);
  // The shell's wiring: a workspace switch (or the chooser) revokes the mark and the read in flight at once, before
  // the new workspace's roster answers, so a late answer for the workspace left marks nothing.
  const wiring = shell.match(/^onWorkspaceChange\(\(\) => \{ void automationsFailure\.refresh\(null\); \}\);$/m)?.[0];
  assert.ok(wiring, "the shipped wiring");
  let switchTo = null; const gatesA = [], seen = [];
  const shown = createAutomationsFailure({ onChange: v => seen.push(v), read: (ws, kind) => new Promise((resolve) => gatesA.push({ ws, kind, resolve })) });
  runInNewContext(wiring, { onWorkspaceChange: fn => { switchTo = fn; }, automationsFailure: shown });
  const readA = shown.refresh("A");
  switchTo("B"); // the switch, before B's roster answers
  gatesA[0].resolve(failing); gatesA[1].resolve({ triggers: [] }); await readA;
  assert.equal(shown.failed, false, "A's late failure never marks B"); assert.deepEqual(seen, []);
});

test("slice1 foot need-you count", t => {
  const u = fixture(t);
  u.render([local("calm")]);
  assert.equal(u.need.hidden, true, "hidden at 0");
  const rows = [local("a-quiet", { createdAt: "2026-10-09T00:00:00.000Z" }), local("b-asks", { createdAt: "2026-10-08T00:00:00.000Z", waitingOnYou: claim() }),
    local("c-asks", { createdAt: "2026-10-07T00:00:00.000Z", waitingOnYou: claim({ reason: "question" }) }),
    local("d-stopped", { createdAt: "2026-10-06T00:00:00.000Z", running: false, waitingOnYou: claim() })];
  u.render(rows);
  assert.equal(u.need.hidden, false);
  assert.equal(u.need.textContent, "2 need you", "the current workspace's rows with a needs-input claim (a stopped row's is none)");
  assert.equal(u.need.getAttribute("aria-label"), "2 agents need you. Go to the first");
  // Activating it focuses the first such row, in the roster's order, and makes it the roving stop.
  u.row("a-quiet").focus();
  u.need.click();
  assert.equal(u.doc.activeElement, u.row("b-asks")); assert.equal(u.row("b-asks").tabIndex, 0);
  // A row nested collapses hide is counted, and the button reveals it (each collapsed ancestor expanded, the roll-up as
  // today until then) and focuses that row itself; its terminal is not opened (openTerminalTab would record it).
  const opened = []; u.context.openTerminalTab = i => opened.push(i.instance);
  const nested = [local("root", { createdAt: "2026-10-09T00:00:00.000Z" }), local("mid", { parentInstance: "root", createdAt: "2026-10-08T00:00:00.000Z" }),
    local("kid", { parentInstance: "mid", createdAt: "2026-10-07T00:00:00.000Z", waitingOnYou: claim() }), local("later", { createdAt: "2026-10-01T00:00:00.000Z", waitingOnYou: claim() })];
  for (const name of ["root", "mid"]) u.context.collapsedInstances.add(tree.collapseKey("A", tree.instanceId(nested.find(r => r.instance === name))));
  u.render(nested);
  assert.equal(u.need.textContent, "2 need you");
  assert.equal(u.row("kid"), undefined, "hidden by the collapses");
  assert.equal(u.row("root").querySelector(".ctx-attn").textContent, "1 below need input", "the roll-up as today");
  u.need.click();
  assert.equal(u.doc.activeElement, u.row("kid"), "the first agent that needs you, itself, though two collapses hid it");
  assert.equal(u.row("kid").tabIndex, 0);
  assert.equal(u.context.collapsedInstances.size, 0, "its ancestors expanded");
  assert.deepEqual(opened, [], "nothing opened");
  // A held parent (being retired) stays open whatever was closed by hand (#1970), so its waiting child is shown; a
  // root collapsed above it hides both. The first in the roster's order is still the one revealed, before a later
  // waiting row the list shows, and the button opens the root and focuses it.
  u.context.collapsedInstances.clear();
  const heldTree = [local("top", { createdAt: "2026-10-10T00:00:00.000Z" }),
    local("held", { parentInstance: "top", retirePending: true, createdAt: "2026-10-09T00:00:00.000Z" }),
    local("held-kid", { parentInstance: "held", createdAt: "2026-10-08T00:00:00.000Z", waitingOnYou: claim() }),
    local("visible-later", { createdAt: "2026-10-01T00:00:00.000Z", waitingOnYou: claim() })];
  u.context.collapsedInstances.add(tree.collapseKey("A", tree.instanceId(heldTree[1])));
  u.render(heldTree);
  assert.ok(u.row("held-kid"), "a held parent closed by hand still shows its children (#1970)");
  u.context.collapsedInstances.add(tree.collapseKey("A", tree.instanceId(heldTree[0])));
  u.render(heldTree);
  assert.equal(u.row("held-kid"), undefined); assert.equal(u.row("held"), undefined);
  assert.equal(u.need.textContent, "2 need you");
  u.need.click();
  assert.equal(u.doc.activeElement, u.row("held-kid"), "the first in the roster's order, not the later visible one");
  assert.equal(u.context.collapsedInstances.has(tree.collapseKey("A", tree.instanceId(heldTree[0]))), false, "the root opened");
  // A row the closed Background section holds: the section opens and the row takes the focus.
  u.context.backgroundShown = () => true;
  u.render([local("main-row", { createdAt: "2026-10-09T00:00:00.000Z" }), local("bg", { background: true, createdAt: "2026-10-08T00:00:00.000Z", waitingOnYou: claim() })]);
  assert.equal(u.row("bg"), undefined, "the section is closed");
  u.need.click();
  assert.equal(u.doc.activeElement, u.row("bg"), "the Background section opened, its waiting row focused");
  u.context.backgroundShown = () => false; u.context.backgroundOpen.clear();
  // A held-stale roster's rows carry no claim; the claim clears: hidden again.
  u.context.rosterStale = true; u.render(rows);
  assert.equal(u.need.hidden, true, "a stale roster's claims are last-known: none counted");
  u.context.rosterStale = false; u.render(rows.map(r => ({ ...r, waitingOnYou: null })));
  assert.equal(u.need.hidden, true);
  // Another workspace's waits are the switcher's mark, never this count: the roster holds this workspace's rows only.
  assert.match(fn("renderContextRoster"), /sidebarFoot\.paint\(pending \? 0 : instances\.filter\(\(row\) => waitingClaim\(row, \{ stale: rosterStale \|\| rowStale\(row, contextDeployments\) \}\)\)\.length\)/);
});

test("slice1 foot and palette", t => {
  const dom = new JSDOM(html);
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  assert.deepEqual([...doc.getElementById("sidebar-bar").children].map(el => el.id), ["sidebar-need-you", "sidebar-help"]);
  assert.equal(doc.getElementById("sidebar-spawn").parentElement, doc.getElementById("instance-roster"), "New agent at the roster's end (slice 3d)");
  assert.equal(doc.querySelector("#sidebar .sidebar-brand, #sidebar img, #sidebar-settings, #sidebar-toggle"), null, "no brand mark, no cog, no Hide sidebar in the foot");
  assert.equal(doc.getElementById("sidebar-help").dataset.action, "app.shortcuts", "? opens the keyboard shortcuts sheet that exists today");
  assert.equal(doc.getElementById("sidebar-spawn").dataset.action, "app.quickOpenSouls", "New opens the existing spawn flow");
  // The palette lists Theme…, Font…, Keyboard shortcuts… and Hide sidebar (the shipped command list, run).
  const start = shell.indexOf("// ── command palette"), end = shell.indexOf("// ── Quick Open", start);
  const ran = [];
  const commands = runInNewContext(`${shell.slice(start, end)}\npalette.commands`, {
    navigator: { platform: "Linux" }, createPalette: options => options, NAV, NAV_TABS, THEMES, getBinding: () => null, formatChord: c => c,
    runAction: id => ran.push(id), openShortcutsEditor: () => ran.push("app.shortcuts"), toggleSidebar: () => ran.push("sidebar.toggle"),
    toggleTheme() {}, openConnections() {}, focusWorkspaceList() {}, focusRoster() {}, splitPane() {}, closeSplit() {}, restoreTerminalGroups() {},
    focusActiveTerminal() {}, setTerminalFontSize() {}, terminalTypography: () => ({ fontSize: 15 }), resetTerminalTypography() {}, showStageFocused() {},
    desktopBridge: {}, takePickerFocusReturn: () => null, openInstanceEdit() {}, windowState: () => "bound", currentWorkspace: () => "A",
    instanceRecency: { snapshot: () => new Map() }, api: async () => ({}), panelDeployments: () => [], heldHome: () => null, shownRows: r => r, heldLine: () => null,
    openTerminalTab() {}, pickerCycleDirection: () => 0, paletteGroupDirection: () => 0, paletteGroupHint: () => "", paletteTargetId: null,
    // Pinned instances: the palette's Agent: Pin to top / Unpin carry their real labels and offer themselves for no target.
    PIN_LABELS, DESKTOP_NOUNS, pinTargetOffer: () => null, runPinCommand: async () => {},
  });
  for (const [label, action] of [[/^Theme: choose…$/, "app.themePicker"], [/^Font: choose…$/, "app.fontPicker"], [/keyboard shortcuts…$/i, "app.shortcuts"], [/^Sidebar: toggle \(hide\/show\)$/, "sidebar.toggle"]]) {
    const command = commands.find(c => label.test(c.label));
    assert.ok(command, `the palette lists ${label}`);
    ran.length = 0; command.run(); assert.deepEqual(ran, [action], `${command.label} runs ${action}`);
  }
  assert.ok(commands.some(c => /hide/i.test(c.label) && /sidebar/i.test(c.label)), "Hide sidebar, by its words");
});

test("slice1 nouns come from desktop-terms", t => {
  // D3 (decided): the Desktop's noun is "agent". Another noun given changes the foot, the New button and the empty roster.
  const other = Object.freeze({ instance: "instance", instances: "instances" });
  assert.deepEqual(DESKTOP_NOUNS, { instance: "agent", instances: "agents" });
  assert.equal(newLabel(DESKTOP_NOUNS), "New agent"); assert.equal(newLabel(other), "New instance");
  assert.equal(emptyRosterText(DESKTOP_NOUNS, "Alt+P"), "No agents yet · Alt+P starts one");
  assert.equal(emptyRosterText(other, "Alt+P"), "No instances yet · Alt+P starts one");
  assert.equal(emptyRosterText(DESKTOP_NOUNS), "No agents yet", "no chord bound: the words alone");
  assert.equal(needYouText(3), "3 need you");
  assert.equal(needYouName(1, DESKTOP_NOUNS), "1 agent needs you. Go to the first"); assert.equal(needYouName(2, other), "2 instances need you. Go to the first");
  // Painted: the foot and the empty roster with the other noun.
  const u = fixture(t, { nouns: other, context: { emptyRosterLine: () => emptyRosterText(other, "Alt+P") } });
  assert.equal(u.doc.getElementById("sidebar-spawn").textContent, "New instance");
  assert.equal(u.doc.getElementById("sidebar-spawn").getAttribute("aria-label"), "New instance");
  u.render([local("x", { waitingOnYou: claim() })]);
  assert.equal(u.need.getAttribute("aria-label"), "1 instance needs you. Go to the first");
  u.render([]);
  assert.equal(u.list.textContent, "No instances yet · Alt+P starts one");
  // The shell reads them from desktop-terms.mjs: the foot's nouns and the empty roster's, and the key from the keymap.
  assert.match(shell, /createSidebarFoot\(document, \{ nouns: DESKTOP_NOUNS,/);
  assert.match(fn("emptyRosterLine"), /getBinding\("app\.quickOpenSouls", mac\)[\s\S]*emptyRosterText\(DESKTOP_NOUNS, chord \? formatChord\(chord, mac\) : ""\)/);
  assert.match(read("desktop-terms.mjs"), /export const DESKTOP_NOUNS = Object\.freeze\(\{ instance: 'agent', instances: 'agents' \}\);/, "one line to change");
  assert.doesNotMatch(html.slice(html.indexOf('<div id="nav-foot">'), html.indexOf("</aside>")), /instance|agent/i, "no noun in the foot's markup");
});
