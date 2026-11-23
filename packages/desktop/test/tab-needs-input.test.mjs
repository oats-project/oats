// #558: an open terminal tab shows Needs input. Executes the shipped syncTabNeedsInput (shell.mjs) over
// tab triggers built by the shipped createTabChrome (tab-a11y.mjs); no shell startup, Electron or session.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { createTabChrome, tabNameTailStart, setTabTitle } from "../renderer/tab-a11y.mjs";
import { paintDotColor } from "../renderer/instance-dot.mjs";
import { terminalKey } from "../renderer/instance-tree-view.mjs";
import { tabShowsRow } from "../renderer/retired-tabs.mjs";
import { iconElement } from "../renderer/shell-icons.mjs";
import { syncWaitingRow } from "../renderer/waiting-row.mjs";
import { createTabBoards } from "../renderer/agent-board-tabs.mjs";
import { BOARD_FEATURE, boardData } from "../../client/instance-board.mjs";
import { waitingClaim, waitingDetail, waitingClock } from "../../client/waiting-on-you.mjs";
import { rowStale } from "../../client/roster-sections.mjs";
import { remotePanel, unavailableGroups } from "../../client/remote-roster.mjs";
import { kernelRemoteRow, kernelRemoteGroup, remoteRows } from "./helpers/kernel-remote-row.mjs";
/** The time a remote panel is made at: remotePanel reads no clock, its caller gives the time. */
const AT = "2026-10-11T12:00:00.000Z";

const read = name => readFileSync(new URL(`../renderer/${name}`, import.meta.url), "utf8");
const shell = read("shell.mjs"), css = read("shell.css");
const source = shell.match(/function syncTabNeedsInput\([^)]*\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(source, "the shipped syncTabNeedsInput");

const SINCE = "2026-10-03T09:00:00.000Z";
const claim = (extra = {}) => ({ since: SINCE, producer: "agent", reason: "attention", message: "Pick one?", ...extra });
const row = (name, extra = {}) => ({ instance: name, agent: "dev", home: `/ws/agents/dev/instances/${name}`, agentsRoot: "/ws/agents",
  running: true, runtimeState: "running", ...extra });

function fixture(t, { stale = false, boards = null } = {}) {
  const dom = new JSDOM("<!doctype html><body><div class='strip-a'></div><div class='strip-b'></div></body>", { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document, tabs = new Map(), boardCalls = [];
  const context = { document: doc, tabs, terminalKey, tabShowsRow, waitingClaim, waitingDetail, waitingClock, syncWaitingRow, iconElement, rowStale, paintDotColor, setTabTitle,
    contextDeployments: [], rosterStale: stale, tabNeedsInputRoster: { instances: [], workspace: null },
    // The agent view's link (agent-board-tabs.mjs, its own suite agent-view.test.mjs): these rows carry no board, so it
    // never takes the waiting row's claim; `boardCalls` shows each tab's row and claim reach it.
    tabBoards: boards ?? { sync: (tab, row, claim) => { boardCalls.push({ tab: tab.key, row: row?.instance ?? null, claim: claim?.message ?? null }); return false; } } };
  Object.defineProperty(context, "Date", { get: () => Date, enumerable: true }); // the test realm's (mockable) clock
  const sync = runInNewContext(`${source}\nsyncTabNeedsInput`, context);
  let id = 0;
  // A terminal tab exactly as openTerminalTabInner draws it: the name, its live dot, its key and workspace.
  const open = (inst, { workspace = "A", strip = ".strip-a" } = {}) => {
    const tabId = ++id, name = inst.instance;
    const chrome = createTabChrome(doc, tabId, name, true, { dot: inst.running ? "on" : "off", tailAt: tabNameTailStart(name, inst.agent), tailEnd: name.length });
    doc.querySelector(strip).append(chrome.tabEl);
    const wrap = doc.createElement("div"); wrap.className = "term-wrap"; chrome.paneEl.append(wrap); doc.body.append(chrome.paneEl);
    const tab = { ...chrome, title: name, key: terminalKey(workspace, inst), kind: "terminal", workspace };
    tabs.set(tabId, tab);
    return tab;
  };
  return { doc, dom, sync, open, context, tabs };
}
const cue = tab => tab.triggerEl.querySelector(":scope > .tab-attn");
const waitingRow = tab => tab.paneEl.querySelector(":scope > .waiting-row");

test("the cue appears with the claim and clears on the next poll, giving back the drawn dot, label and title", async t => {
  const u = fixture(t), tab = u.open(row("dev-a")), trigger = tab.triggerEl;
  const dot = trigger.querySelector(":scope > .tab-dot"), label = trigger.querySelector(".tab-label");
  assert.equal(trigger.getAttribute("aria-label"), "dev-a");
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(SINCE) + 60e3 });
  u.sync([row("dev-a", { waitingOnYou: claim() })], "A");
  const mark = cue(tab);
  assert.ok(mark, "the alert glyph shows");
  assert.equal(mark.getAttribute("aria-hidden"), "true"); assert.ok(mark.querySelector("svg"));
  assert.equal(trigger.querySelector(":scope > .tab-dot"), null, "it takes the dot's place");
  assert.equal(trigger.firstElementChild, mark, "in the same slot, before the label");
  assert.equal(mark.nextElementSibling, label, "the label is the same element");
  assert.equal(trigger.getAttribute("aria-label"), "dev-a, needs input");
  assert.equal(trigger.title, `dev-a\nNeeds input: Pick one? since ${waitingClock(SINCE, Date.now())}`);
  u.sync([row("dev-a", { waitingOnYou: claim({ message: null, reason: "question" }) })], "A");
  assert.equal(cue(tab), mark, "a repaint keeps the same glyph element");
  assert.match(trigger.title, /\nNeeds input: Asked you a question since /);
  u.sync([row("dev-a", { waitingOnYou: null })], "A");
  assert.equal(cue(tab), null);
  assert.equal(trigger.firstElementChild, dot, "exactly the dot it was drawn with");
  assert.equal(trigger.getAttribute("aria-label"), "dev-a"); assert.equal(trigger.title, "dev-a");
  u.sync([row("dev-a", { waitingOnYou: claim() })], "A"); u.sync([row("dev-a")], "A");
  assert.equal(trigger.firstElementChild, dot, "absent is unknown: no cue, the drawn dot");
});

test("a withheld note: the tab's title reads the reason in words, never “[withheld]” (#584 finding 12)", async t => {
  const u = fixture(t), tab = u.open(row("dev-a")), trigger = tab.triggerEl;
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(SINCE) + 60e3 });
  for (const [message, reason, label] of [["See https://github.com/awebai/oats/pull/552", "attention", "Asked for your attention"],
    ["Which token: A or B?", "question", "Asked you a question"], ["api key: rotate now?", "approval", null]]) {
    u.sync([row("dev-a", { waitingOnYou: claim({ message, reason }) })], "A");
    assert.ok(cue(tab), "the claim is kept");
    assert.equal(trigger.getAttribute("aria-label"), "dev-a, needs input");
    // An unknown reason adds nothing to the tag's words: the note says them once (#1502).
    assert.equal(trigger.title, `dev-a\nNeeds input${label ? `: ${label}` : ""} since ${waitingClock(SINCE, Date.now())}`, message);
  }
  u.sync([row("dev-a", { waitingOnYou: claim({ message: "Pick one?" }) })], "A");
  assert.match(trigger.title, /\nNeeds input: Pick one\? since /, "a safe note is still shown");
});

test("focus on a tab trigger survives a poll that toggles the cue; the trigger and tab are never rebuilt", async t => {
  const u = fixture(t), tab = u.open(row("dev-a")), { tabEl, triggerEl } = tab;
  triggerEl.focus();
  assert.equal(u.doc.activeElement, triggerEl);
  for (const waiting of [claim(), null, claim(), null]) {
    u.sync([row("dev-a", { waitingOnYou: waiting })], "A");
    assert.equal(u.doc.activeElement, triggerEl, "focus stays");
    assert.equal(tabEl.firstElementChild, triggerEl); assert.ok(tabEl.isConnected);
    assert.equal(triggerEl.id, "tab-1");
  }
});

test("every open terminal tab, in every editor group strip, follows its own row", async t => {
  const u = fixture(t), a = u.open(row("dev-a")), b = u.open(row("dev-b"), { strip: ".strip-b" });
  u.sync([row("dev-a", { waitingOnYou: claim() }), row("dev-b", { waitingOnYou: claim({ message: "Other" }) })], "A");
  assert.ok(cue(a) && cue(b));
  u.sync([row("dev-a"), row("dev-b", { waitingOnYou: claim() })], "A");
  assert.equal(cue(a), null); assert.ok(cue(b));
});

test("a same-named instance in another root, or the same home in another workspace, never lights a tab", async t => {
  const u = fixture(t), tab = u.open(row("dev-a")), other = u.open(row("dev-a"), { workspace: "B" });
  const twin = row("dev-a", { home: "/other/agents/dev/instances/dev-a", agentsRoot: "/other/agents", waitingOnYou: claim() });
  u.sync([row("dev-a"), twin], "A");
  assert.equal(cue(tab), null, "matched by its qualified key (home), never the bare name");
  u.sync([row("dev-a", { waitingOnYou: claim() })], "A");
  assert.ok(cue(tab));
  assert.equal(cue(other), null, "workspace B's tab is not painted by workspace A's roster");
  assert.equal(other.triggerEl.getAttribute("aria-label"), "dev-a");
});

test("a stale, non-running or unreachable row never lights a tab, and a held-stale roster clears a lit one", async t => {
  const u = fixture(t), tab = u.open(row("dev-a"));
  // A positive control each time (#584): the same row lights this tab without the condition, so the
  // cleared cue is the gate's doing, never a row that stopped matching the tab.
  for (const extra of [{ running: false, runtimeState: "shell" }, { running: false, runtimeState: "stopped" }, { running: null, runtimeState: "unreachable" },
    { running: null, runtimeState: "unsupported" }]) {
    u.sync([row("dev-a", { waitingOnYou: claim() })], "A");
    assert.ok(cue(tab), `lit without ${JSON.stringify(extra)}`);
    u.sync([row("dev-a", { waitingOnYou: claim(), ...extra })], "A");
    assert.equal(cue(tab), null, JSON.stringify(extra));
  }
  // A remote row's tab is keyed by its server, so it is opened from the remote row. The row is what
  // remotePanel makes of a kernel roster row: runtimeState null, "not reported" (#582).
  const [reached] = remoteRows([kernelRemoteRow("dev-r", { waitingOnYou: claim() })]);
  const [group] = unavailableGroups([kernelRemoteGroup([kernelRemoteRow("dev-r", { waitingOnYou: claim() })])], { code: "E_SSH", message: "Connection refused" });
  const [lastKnown] = remotePanel(group, AT).instances;
  assert.deepEqual([reached.runtimeState, reached.serverUnreached, lastKnown.serverUnreached], [null, false, true]);
  const remoteTab = u.open(reached);
  assert.equal(remoteTab.key, terminalKey("A", lastKnown), "the unreached row is the same tab's row");
  assert.notEqual(remoteTab.key, tab.key);
  for (const unreached of [{ ...reached, serverUnreached: true }, lastKnown]) {
    u.sync([reached], "A");
    assert.ok(cue(remoteTab), "a reached remote row lights its tab");
    assert.equal(cue(tab), null, "and no other tab");
    u.sync([unreached], "A");
    assert.equal(cue(remoteTab), null, "its server was not reached: last-known is unknown");
  }
  u.sync([row("dev-a", { waitingOnYou: claim() })], "A");
  assert.ok(cue(tab));
  u.context.rosterStale = true;
  u.sync([row("dev-a", { waitingOnYou: claim() })], "A");
  assert.equal(cue(tab), null, "last-known is unknown");
  assert.equal(tab.triggerEl.getAttribute("aria-label"), "dev-a");
  u.context.rosterStale = false;
  u.sync([], "A");
  assert.equal(cue(tab), null, "a roster without the row (a failed read) is unknown");
});

test("the title's start carries its date when the claim is not from today (#559)", async t => {
  const u = fixture(t), tab = u.open(row("dev-a"));
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(SINCE) + 2 * 86400e3 });
  u.sync([row("dev-a", { waitingOnYou: claim() })], "A");
  assert.match(tab.triggerEl.title, / since Oct \d{1,2}, \d\d:\d\d$/);
});

test("CSS: the glyph fills the dot's 12px slot (never clipped, the name never moves), in --warn, never animated", () => {
  const rule = name => css.match(new RegExp(`${name.replace(".", "\\.")} \\{([^}]*)\\}`))?.[1] || "";
  const px = (body, prop) => Number(body.match(new RegExp(`(?:^|[;\\s])${prop}:\\s*(-?[\\d.]+)px`))?.[1]);
  const attn = rule(".tab-attn"), dot = rule(".tab-dot");
  // The trigger clips its overflow: a glyph overhanging its slot (the old -5px end margin) lost its end whenever it
  // ended the line (no branch, or a branch squeezed to nothing).
  assert.match(rule(".tab-trigger"), /overflow: hidden/);
  assert.doesNotMatch(attn, /margin/, "the glyph advances its whole width, no overhang");
  // The same advance in both states, so the name gets the same room whichever mark shows: a narrower dot let a
  // constrained name grow into 5px the glyph then took back, and its visible tail jumped. The dot is centred in it.
  const dotMargin = dot.match(/(?:^|[;\s])margin: 0 ([\d.]+)px;/)?.[1];
  assert.equal(px(dot, "width") + 2 * Number(dotMargin), px(attn, "width"), "the 7px dot + 2.5px each side = the 12px glyph");
  assert.match(css, /\.tab-dot, \.tab-attn \{ order: 1; \}/, "after the name");
  // The label's flex basis reserves room for the number and its gap (7 + 8), then the gap and the slot: the glyph
  // stays on the first line, the one the trigger shows, at every width down to the floor.
  const reserve = Number(rule(".tab-label").match(/100% - (\d+)px/)?.[1]);
  assert.ok(7 + 8 + 8 + px(attn, "width") <= reserve, `number, gap and slot fit the label's ${reserve}px reserve`);
  // The slot's 5px goes on the floor of a tab that has one, in either state, and on no other tab: a file, brain or
  // view tab (its icon leads, no slot) keeps its floor, so its strip fits as many tabs as before.
  assert.match(css, /\n\.tab \{\n  --tab-min: 176px;/, "the floor of a tab with no status slot");
  assert.match(css, /\n\.tab:has\(> \.tab-trigger > :is\(\.tab-dot, \.tab-attn\)\) \{ --tab-min: 181px; \}/,
    "the floor of a tab with one, the same with the dot or the glyph");
  assert.match(attn, /flex: none/); assert.match(attn, /color: var\(--warn\)/);
  assert.doesNotMatch(attn, /animation|transition|opacity/);
  assert.match(css, /\.tab-attn > \.shell-icon \{ width: 12px; height: 12px; \}/);
});

test("shell: closing a tab ends its waiting row, so a tab closed while waiting leaves no pane observation (#1502)", () => {
  assert.match(shell, /\n  syncWaitingRow\(t\.paneEl, null\);\n  t\.paneEl\.remove\(\);/);
  assert.equal(shell.match(/paneEl\.remove\(\)/g).length, 1, "the one place a pane leaves the DOM");
});

test("shell: every roster paint syncs the tabs, and a new terminal tab syncs at once", () => {
  assert.match(shell, /function refreshPanelInstance\(instances, workspace\) \{\n  syncTabNeedsInput\(instances, workspace\);/);
  assert.match(shell, /lost a race to an identical tab\n[^\n]*\n  syncTabNeedsInput\(tabNeedsInputRoster\.instances, tabNeedsInputRoster\.workspace\);/);
});

test("each terminal pane carries its own waiting row (#1502): a split with one waiting group, and the gate clears it", async t => {
  const u = fixture(t), a = u.open(row("dev-a")), b = u.open(row("dev-b"), { strip: ".strip-b" });
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(SINCE) + 12 * 60e3 });
  u.sync([row("dev-a", { waitingOnYou: claim() }), row("dev-b")], "A");
  assert.ok(waitingRow(a), "the waiting group's pane has the row");
  assert.equal(waitingRow(b), null, "the other group's pane has none");
  assert.equal(waitingRow(a).textContent, "Needs input · 12 minPick one?");
  assert.equal(waitingRow(a).nextElementSibling, a.paneEl.querySelector(":scope > .term-wrap"), "over the terminal");
  u.sync([row("dev-a", { waitingOnYou: claim({ message: null, reason: "permission" }) }), row("dev-b")], "A");
  assert.equal(waitingRow(a).querySelector(".waiting-message").textContent, "Waiting for a tool approval");
  u.context.rosterStale = true;
  u.sync([row("dev-a", { waitingOnYou: claim() })], "A");
  assert.equal(waitingRow(a), null, "a held-stale roster is unknown: no row");
  u.context.rosterStale = false;
  u.sync([row("dev-a", { waitingOnYou: claim(), running: false, runtimeState: "stopped" })], "A");
  assert.equal(waitingRow(a), null, "nor for a row that is not running");
  u.sync([row("dev-a"), row("dev-b", { waitingOnYou: claim() })], "A");
  assert.equal(waitingRow(a), null, "cleared"); assert.ok(waitingRow(b));
});

// The agent view (S2-D): on a row with a board, the board's own claim shows in the question zone and the waiting row
// gives way; another producer's claim keeps today's waiting row. Without the feature the tab is as it was.
test("the agent view: the board's claim moves from the waiting row to the question zone; any other claim stays in the row", t => {
  const boards = createTabBoards({ features: () => [BOARD_FEATURE], post: () => new Promise(() => {}), openLink: () => {},
    hidden: { get: () => new Map(), hide() {}, showAll() {} } });
  const u = fixture(t, { boards }), tab = u.open(row("dev-a"));
  const board = boardData({ facts: [], questions: [{ id: "q1", question: "Pick one?", options: ["A", "B"], hasContext: false, since: SINCE }] });
  u.sync([row("dev-a", { board, waitingOnYou: claim({ producer: "oats.board" }) })], "A");
  assert.equal(waitingRow(tab), null, "no waiting row for the board's own question");
  assert.ok(tab.paneEl.querySelector(":scope > .agent-questions"), "the question zone shows it");
  assert.ok(cue(tab), "the tab's needs-input mark stays");
  u.sync([row("dev-a", { board, waitingOnYou: claim({ producer: "agent" }) })], "A");
  assert.ok(waitingRow(tab), "another producer's claim keeps the waiting row");
  u.sync([row("dev-a", { waitingOnYou: claim({ producer: "oats.board" }) })], "A");
  assert.ok(waitingRow(tab), "a row without the field (an older kernel): today's waiting row");
  assert.equal(tab.paneEl.querySelector(":scope > .agent-questions"), null);
});
