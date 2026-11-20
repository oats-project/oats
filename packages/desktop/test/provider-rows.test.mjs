// Session providers in the Desktop (spec C1): a roster row whose `backend` is a provider's name ("bb") runs in no
// terminal. What the Desktop draws of it (renderer/provider-row.mjs), on the shipped roster paint (shell.mjs
// renderContextRoster, its row menu and the menu's handler), the row's tooltip and the instance panel's Session
// line. Which rows are a provider's, their acts and the sentence are the shared home's (instance-acts.test.mjs);
// the tab memory is workspace-tab-memory.test.mjs's, retired-tabs.test.mjs's and instance-tree.test.mjs's.
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
import { instanceActionTarget, sameInstanceActionTarget } from "../renderer/instance-action-target.mjs";
import { instanceSplitPlan } from "../renderer/instance-split.mjs";
import { runtimeState, unsupportedSession } from "../../client/instance-presentation.mjs";
import { canAddressRemote, rowReason } from "../../client/remote-address.mjs";
import { iconElement, mountShellIcons } from "../renderer/shell-icons.mjs";
import { createSidebarFoot } from "../renderer/sidebar-foot.mjs";
import { DESKTOP_NOUNS } from "../renderer/desktop-terms.mjs";
import { noTerminal, sessionLine } from "../renderer/provider-row.mjs";
import { rowFactsTitle } from "../renderer/row-facts-title.mjs";
import { createContextPanel } from "../renderer/context-panel.mjs";
import { DETAIL_WITHHELD } from "../../client/display-text.mjs";

const SENTENCE = "Runs in a bb thread; open it in bb.";
const LINK = Object.freeze({ label: "Open in bb", url: "http://127.0.0.1:38886/t/thr_x" });
const local = (name, extra = {}) => ({ instance: name, agent: "oats-desktop-developer", home: `/synthetic/${name}`, agentsRoot: "/synthetic/agents",
  repoName: "desktop-repo", branch: `b/${name}`, harness: "claude", running: true, createdAt: "2026-10-01T00:00:00.000Z", ...extra });
/** A bb row as /api/panel serves it (packages/client deployment-panel.mjs panelInstance). */
const bb = (name, extra = {}) => local(name, { backend: "bb", tmux: null, runtimeState: "unknown", session: { provider: "oats.bb", threadId: "thr_x" }, open: LINK, ...extra });

test("noTerminal: the shared sentence and the link for a provider row, null for every other row and for one that says its own reason", () => {
  assert.deepEqual(noTerminal(bb("a")), { sentence: SENTENCE, link: LINK });
  assert.deepEqual(noTerminal(bb("a", { open: null })), { sentence: SENTENCE, link: null });
  for (const running of [true, false, null]) assert.equal(noTerminal(bb("a", { running })).sentence, SENTENCE, String(running));
  // The label is the provider's text: one display line, and a label with nothing to show, or one withheld, is no link.
  assert.deepEqual(noTerminal(bb("a", { open: { label: "Open\nin  bb", url: LINK.url } })).link, { label: "Open in bb", url: LINK.url });
  for (const label of [" \n ", "token=abcdef0123456789"]) assert.equal(noTerminal(bb("a", { open: { label, url: LINK.url } })).link, null, JSON.stringify(label));
  // Another machine's row: the sentence, no link.
  assert.deepEqual(noTerminal(bb("a", { server: "build", addressable: true })), { sentence: SENTENCE, link: null });
  for (const row of [local("t"), local("t", { backend: "tmux", open: LINK }), local("t", { running: false }), bb("h", { backend: "herdr" }),
    bb("held", { running: false, spawnInProgress: true }), bb("far", { server: "build", addressable: false }), null, undefined]) assert.equal(noTerminal(row), null, JSON.stringify(row));
});

test("sessionLine: tmux and its session, a provider and its thread, or nothing; the thread id only as a display line", () => {
  assert.equal(sessionLine(local("t", { tmux: { session: "oats-agents", window: "t" } })), "tmux · oats-agents");
  assert.equal(sessionLine(local("t", { backend: "tmux", tmux: { session: "oats-agents" } })), "tmux · oats-agents");
  assert.equal(sessionLine(bb("a")), "bb · thread thr_x");
  for (const session of [undefined, null, {}, { provider: "oats.bb" }, { endpoint: { threadId: "thr_endpoint" } }, { threadId: 7 }, { threadId: " \n " },
    { threadId: "token=abcdef0123456789" }]) assert.equal(sessionLine(bb("a", { session })), "bb", JSON.stringify(session));
  assert.equal(sessionLine(bb("a", { session: { threadId: "thr\n_x" } })), "bb · thread thr _x");
  assert.doesNotMatch(sessionLine(bb("a", { session: { threadId: "token=abcdef0123456789" } })), new RegExp(DETAIL_WITHHELD.replace(/[[\]]/g, "\\$&")));
  // A provider row never names a tmux session, whatever else it carries; a row with neither says nothing.
  assert.equal(sessionLine(bb("a", { tmux: { session: "oats-agents" } })), "bb · thread thr_x");
  for (const row of [local("t"), local("t", { tmux: null }), local("t", { tmux: { session: "" } }), null]) assert.equal(sessionLine(row), "");
});

test("the row's tooltip facts: a provider row adds where it runs; a tmux row's line is as it was", () => {
  assert.equal(rowFactsTitle(bb("a", { model: "opus" })), "Repository: desktop-repo · Branch: b/a · Claude · opus · bb · thread thr_x");
  assert.equal(rowFactsTitle(bb("a", { session: undefined })), "Repository: desktop-repo · Branch: b/a · Claude · bb");
  // A backend that is no name is shown as one display line, never raw; one with nothing to show is "session provider".
  assert.equal(sessionLine(bb("a", { backend: "Not\nA  Name", session: undefined })), "Not A Name");
  assert.equal(sessionLine(bb("a", { backend: "token=abcdef0123456789" })), "session provider · thread thr_x");
  assert.equal(noTerminal(bb("a", { backend: "Not A Name" })).sentence, "Runs outside tmux; it has no terminal to open.");
  assert.equal(rowFactsTitle(local("t", { model: "opus", tmux: { session: "oats-agents" } })), "Repository: desktop-repo · Branch: b/t · Claude · opus");
});

// ── The instance panel's Session line (done when 4) ──
test("the instance panel's Session line shows the backend: tmux and its session, or the provider and its thread id", t => {
  const dom = new JSDOM(`<!doctype html><body><aside id="context-panel"></aside></body>`);
  const document = dom.window.document, root = document.getElementById("context-panel");
  const panel = createContextPanel({ document, root, onIntent() {}, applyFocus: f => f(), onFocusModeChange() {}, fallbackFocus: () => null, closedFocus: () => null });
  t.after(() => { panel.dispose(); dom.window.close(); });
  const line = () => document.querySelector(".context-panel-session-tmux");
  const select = row => panel.setContext({ workspace: "A", instance: row, key: row.home });
  select(bb("a"));
  assert.equal(line().hidden, false); assert.equal(line().textContent, "bb · thread thr_x");
  assert.doesNotMatch(root.textContent, /proj_|38886|undefined/, "no link and nothing else of the row's session is in the panel");
  select(bb("a", { session: { provider: "oats.bb" } }));
  assert.equal(line().textContent, "bb", "no thread id reported: the backend alone");
  select(bb("a", { session: { threadId: "<img src=x onerror=alert(1)>" } }));
  assert.equal(line().textContent, "bb · thread <img src=x onerror=alert(1)>"); assert.equal(line().children.length, 0, "text, never markup");
  select(local("t", { home: "/synthetic/t", tmux: { session: "oats-agents", window: "t" } }));
  assert.equal(line().textContent, "tmux · oats-agents");
  // The lifecycle controls of a provider row are the shared table's, as any row's.
  select(bb("a"));
  const shown = () => ["restart", "start", "stop", "retire"].filter(verb => { const b = document.querySelector(`[data-lifecycle="${verb}"]`); return b && !b.hidden; });
  assert.deepEqual(shown(), ["restart", "stop", "retire"]);
  select(bb("a", { running: null }));
  assert.deepEqual(shown(), ["stop", "retire"]);
});

// ── The roster row and its context menu, on the shipped paint ──
const read = name => readFileSync(new URL(`../renderer/${name}`, import.meta.url), "utf8");
const shell = read("shell.mjs"), html = read("index.html"), css = read("shell.css");
const fn = name => { const found = shell.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`)); assert.ok(found, name); return found[0]; };
const source = ["renderContextRoster", "needsInputMark", "pendingSpawnRow", "setRovingRow", "focusFirstNeedingYou", "setBackgroundOpen"].map(fn).join("\n");
const tree = { ...treeShared, ...treeView, ...sameWork };

/** The shipped roster paint over the shipped index.html, in workspace "A" (the fixture of sidebar-slice1.test.mjs),
 * recording what a row's activation and its menu open. */
function fixture(t) {
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  t.after(() => dom.window.close());
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
  const calls = [];
  const context = {
    ...tree, ...viewContext(), document: doc, instanceActions, captureInstanceActionMenu, runtimeState, unsupportedSession, canAddressRemote, rowReason,
    iconElement, instanceActionTarget, instanceSplitPlan, connectionGeneration: 0, menuState() {}, sayInHint: line => calls.push(["say", line]), runAction: assert.fail,
    applyChordTitles() {}, updateActiveContexts() {}, getBinding: () => null, formatChord: c => c, isMac: true,
    contextRosterEl: doc.querySelector("#instance-roster"), contextWorkspace: "A", contextInstances: [],
    rosterState: { hasData: true, state: "ready" }, rosterStale: false, contextDeploymentNote: null,
    currentWorkspace: () => "A", workspaceGeneration: () => 0, collapsedInstances: new Set(),
    spawnJobs: { rows: () => [], announce: () => false, check() {} },
    tabs: new Map(), activeTab: null, tabOpenIntents: { applyFocus: f => f(), invalidate() {} },
    openTerminalTab: (row, options) => calls.push(["terminal", row.instance, options?.inSplit === true]), openInstanceStart: row => calls.push(["start", row.instance]),
    openLifecycleDialog: assert.fail, onRosterRowKey() {},
    ctx: { openExternal: url => calls.push(["external", url]) },
    api: assert.fail, showStage: assert.fail, refreshContextRoster: assert.fail, revealInScrollport() {},
  };
  context.splitOpenState = () => ({ split: null, activeId: null, tabs: context.tabs, workspace: "A", visible: false });
  context.ownsInstanceTarget = target => context.contextInstances.filter(row => sameInstanceActionTarget(target, row, "A")).length === 1;
  Object.defineProperty(context, "Date", { get: () => Date, enumerable: true });
  const s = runInNewContext(`${source}\n({ render: renderContextRoster, focusFirstNeedingYou })`, context);
  context.sidebarFoot = createSidebarFoot(doc, { nouns: DESKTOP_NOUNS, onNeedYou: () => s.focusFirstNeedingYou() });
  const list = doc.querySelector(".ctx-list");
  const render = rows => { context.contextInstances = rows; s.render(rows); };
  const row = name => [...list.querySelectorAll(".ctx-inst")].find(b => b.querySelector(".ctx-name")?.dataset.name === name);
  const menu = name => [...row(name).closest(".ctx-tree-row").querySelectorAll(".ctx-instance-menu [role=menuitem]")];
  const item = (name, action) => menu(name).find(each => each.dataset.action === action);
  /** The row's context menu opened from the keyboard, then `action` chosen. */
  const choose = async (name, action) => {
    row(name).dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }));
    item(name, action).click();
    await new Promise(setImmediate);
  };
  return { dom, doc, calls, render, row, menu, item, choose };
}

test("a provider row that runs: drawn as running, its activation opens nothing and its title and description say where it runs", t => {
  const u = fixture(t);
  u.render([bb("bb-run", { model: "opus" }), local("tmux-run")]);
  const row = u.row("bb-run");
  assert.ok(row.querySelector(".ctx-dot.on"), "its dot is the kernel's state");
  assert.equal(row.querySelector(".ctx-state").textContent, ", running");
  assert.equal(row.getAttribute("aria-disabled"), "true");
  assert.equal(row.title, `${SENTENCE}\nRepository: desktop-repo · Branch: b/bb-run · Claude · opus · bb · thread thr_x`);
  assert.equal(row.getAttribute("aria-description"), SENTENCE);
  row.click();
  assert.deepEqual(u.calls, [], "no terminal, no Start…, nothing said elsewhere");
  // The tmux row beside it opens its terminal, as before.
  assert.equal(u.row("tmux-run").hasAttribute("aria-disabled"), false);
  u.row("tmux-run").click();
  assert.deepEqual(u.calls, [["terminal", "tmux-run", false]]);
});

test("a provider row, stopped or of unknown state: Start… on a stopped one as any row; an unknown one says its state and where it runs", t => {
  const u = fixture(t);
  u.render([bb("bb-stopped", { running: false, runtimeState: "stopped" }), bb("bb-idle", { running: null })]);
  const stopped = u.row("bb-stopped"), idle = u.row("bb-idle");
  assert.equal(stopped.hasAttribute("aria-disabled"), false);
  assert.doesNotMatch(stopped.title, /Runs in a bb thread/, "a stopped row's activation is Start…, so it says no reason");
  stopped.click();
  assert.deepEqual(u.calls, [["start", "bb-stopped"]]);
  assert.equal(idle.getAttribute("aria-disabled"), "true");
  assert.equal(idle.getAttribute("aria-description"), `bb-idle: status unknown · ${SENTENCE}`);
  idle.click();
  assert.deepEqual(u.calls, [["start", "bb-stopped"]], "nothing more");
});

test("a provider row's menu: its link first, under the provider's label, opened as an external link; Open in split listed, not enabled, with the sentence; the acts of its state", async t => {
  const u = fixture(t);
  u.render([bb("bb-run"), bb("bb-plain", { open: null }), bb("bb-idle", { running: null }), local("tmux-run")]);
  assert.deepEqual(u.menu("bb-run").map(item => item.dataset.action), ["open-link", "open-split", "open-pr", "inspect", "restart", "stop", "retire"]);
  assert.deepEqual(u.menu("bb-plain").map(item => item.dataset.action), ["open-split", "open-pr", "inspect", "restart", "stop", "retire"], "no link reported: no item");
  assert.deepEqual(u.menu("bb-idle").map(item => item.dataset.action), ["open-link", "open-split", "open-pr", "inspect", "stop", "retire"]);
  assert.deepEqual(u.menu("tmux-run").map(item => item.dataset.action), ["open-split", "open-pr", "inspect", "restart", "stop", "retire"], "a tmux row's menu is as it was");
  const link = u.item("bb-run", "open-link");
  assert.equal(link.querySelector("span:not(.ctx-menu-icon)").textContent, "Open in bb");
  assert.equal(link.disabled, false);
  assert.ok(link.querySelector(".ctx-menu-icon svg, .ctx-menu-icon use, .ctx-menu-icon *"), "the external-link mark");
  await u.choose("bb-run", "open-link");
  assert.deepEqual(u.calls, [["external", LINK.url]], "the system browser, through the shell's external-link path; no terminal");
  for (const name of ["bb-run", "bb-plain", "bb-idle"]) {
    const split = u.item(name, "open-split");
    assert.equal(split.disabled, true, name); assert.equal(split.title, SENTENCE, name);
    split.click();
  }
  await new Promise(setImmediate);
  assert.deepEqual(u.calls, [["external", LINK.url]], "a disabled Open in split opens nothing");
});

test("the menu's handler, as shipped: open-link opens the row's own link through the external-link path, and nothing when the row has none", async () => {
  const start = shell.indexOf("invoke: async (action, instance) => {"), end = shell.indexOf("\n          openLifecycle:", start);
  assert.ok(start > 0 && end > start, "the roster menu handler is found in shell.mjs");
  const handler = shell.slice(start + "invoke: ".length, end).trim().replace(/,$/, "");
  for (const [elsewhere, expected] of [[{ sentence: SENTENCE, link: LINK }, [LINK.url]], [{ sentence: SENTENCE, link: null }, []], [null, []]]) {
    const opened = [];
    const invoke = runInNewContext(`(${handler})`, { ws: "A", rosterGeneration: 1, currentWorkspace: () => "A", workspaceGeneration: () => 1, actionTarget: {}, menuOwner: () => true,
      backgroundMenu: { handles: () => false }, pinMenu: { handles: () => false }, openTerminalTab: assert.fail, openInstanceStart: assert.fail,
      api: assert.fail, postJson: assert.fail, elsewhere, ctx: { openExternal: url => opened.push(url) } });
    await invoke("open-link", bb("a"));
    assert.deepEqual(opened, expected);
  }
});

// ── An open from anywhere else (the palette, a view's Open, a launch's --instance) ──
test("an interactive open of a provider row says where it runs in a notice, never in an alert; a quiet open and one with its own onError keep their notify; no tab, no key, no terminal", async () => {
  const flowSource = shell.match(/async function openTerminalTabFlow\(ref, notify, options = \{\}\) \{[\s\S]*?\n\}/)?.[0];
  const openSource = shell.match(/async function openTerminalTab\(ref, \{[\s\S]*?\n\}/)?.[0];
  assert.ok(flowSource && openSource, "the shell's open and its flow are found");
  const rows = [bb("bb-run"), local("tmux-run", { tmux: { session: "oats" } })];
  const said = { notice: [], alert: [], warn: [], own: [] }, inner = [], keys = [];
  const c = {
    tabs: new Map(), activeTab: null, pendingTerms: new Set(), panelReads: 0, split: null, connectionGeneration: 0, shownRoster: null, contextRosterGen: 0,
    currentWorkspace: () => "A", workspaceGeneration: () => 0, terminalOpening: null,
    setSidebarMode() {}, setNavActive() {}, refreshContextRoster() {}, instanceSplitPlan() {}, instanceSplitIdentity() {}, splitOpenState() {},
    otherIncarnation: () => false, terminalOrigin: () => ({ incarnation: null }), sameInstanceActionTarget: () => true,
    api: async () => ({ instances: rows }), resolveTerminalOpen: treeView.resolveTerminalOpen,
    whenKeyFree: async key => { keys.push(key); }, openTerminalTabInner: async inst => { inner.push(inst.instance); },
    tabOpenIntents: { begin: () => () => true },
    runOpenFlow: async (run, { quiet, notify }) => { try { return await run(); } catch (error) { if (!quiet) throw error; notify(error.message); } },
    notifications: { notify: line => said.notice.push(line) }, alert: line => said.alert.push(line), console: { warn: line => said.warn.push(line) },
  };
  const open = runInNewContext(`${flowSource}\n${openSource}\nopenTerminalTab`, c);
  // The palette's bare name, and a row's exact reference.
  for (const ref of ["bb-run", { instance: "bb-run", home: "/synthetic/bb-run", agentsRoot: "/synthetic/agents" }]) await open(ref);
  assert.deepEqual(said, { notice: [SENTENCE, SENTENCE], alert: [], warn: [], own: [] });
  await open("bb-run", { quiet: true });
  assert.deepEqual([said.notice.length, said.alert, said.warn], [2, [], [`[terminal open] ${SENTENCE}`]], "a quiet open keeps its own line");
  await open("bb-run", { onError: line => said.own.push(line) });
  assert.deepEqual([said.notice.length, said.alert, said.own], [2, [], [SENTENCE]], "a caller's own onError is the one told");
  assert.deepEqual([inner, keys, c.tabs.size], [[], [], 0], "no tab, no key and no terminal for any of them");
  // The tmux row beside it opens, and an unknown name is still an alert, as before.
  await open("tmux-run");
  assert.deepEqual(inner, ["tmux-run"]);
  await open("nobody");
  assert.deepEqual(said.alert, ['unknown instance "nobody"']);
});
