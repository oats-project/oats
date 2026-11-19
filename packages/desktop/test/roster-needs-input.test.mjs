// Spec D: "Needs input" on the sidebar roster: a waiting row's dot is the needs-input mark (the product owner,
// 2026-10-26), and a collapsed parent rolls up the waiting rows it hides. Executes the shipped roster render (shell.mjs
// renderContextRoster + needsInputMark) and the shipped card (roster-tip.mjs) against a stub store;
// no shell startup, HTTP, Electron, CLI or session.
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
import { createRuntimeBadge } from "../renderer/identity-marks.mjs";
import { iconElement } from "../renderer/shell-icons.mjs";
import { createRosterTip, rosterTipFacts } from "../renderer/roster-tip.mjs";
import { waitingClock } from "../../client/waiting-on-you.mjs";
import { createTabChrome, setTabTitle } from "../renderer/tab-a11y.mjs";
import { prChip, prText } from "../renderer/roster-pr.mjs";
import { NO_ANSWER_CODE, unservedError } from "../renderer/deployment-header.mjs";
import { remotePanel, unavailableGroups } from "../../client/remote-roster.mjs";
import { kernelRemoteRow, kernelRemoteGroup, remoteRows } from "./helpers/kernel-remote-row.mjs";
import { SPEAKERS, HERDR, MARKUP, CONTROL, DETAIL_WITHHELD, shown } from "./helpers/speaker-cases.mjs";
import { spokenText } from "./helpers/spoken-text.mjs";
/** The time a remote panel is made at: remotePanel reads no clock, its caller gives the time. */
const AT = "2026-10-11T12:00:00.000Z";

const read = name => readFileSync(new URL(`../renderer/${name}`, import.meta.url), "utf8");
const css = read("shell.css"), html = read("index.html"), shell = read("shell.mjs");
const fn = name => shell.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
// The shipped tab sync and overdue-read path too (#558): a roster paint re-syncs the open terminal tabs.
const source = ["renderContextRoster", "needsInputMark", "syncTabNeedsInput", "failRosterUnserved"].map(name => { const s = fn(name); assert.ok(s, name); return s; }).join("\n");

const SINCE = "2026-10-03T09:00:00.000Z";
const claim = (extra = {}) => ({ since: SINCE, producer: "claude-hooks", reason: "permission", message: null, ...extra });
const instance = (name, parentInstance, extra = {}) => ({ instance: name, parentInstance, agent: "dev",
  home: `/synthetic/${name}`, agentsRoot: "/synthetic/agents", repoName: "desktop-repo", running: true, runtimeState: "running", ...extra });

function fixture(t, extra = {}) {
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const tips = new Map();
  const context = {
    ...tree, document: doc, instanceActions, captureInstanceActionMenu, runtimeState, unsupportedSession, canAddressRemote, rowReason, createRuntimeBadge,
    iconElement, setTabTitle, NO_ANSWER_CODE, unservedError, instanceActionTarget, instanceSplitPlan, connectionGeneration: 0, menuState() {}, sayInHint() {}, runAction: assert.fail,
    applyChordTitles() {}, updateActiveContexts() {}, getBinding: () => null, formatChord: c => c, isMac: true,
    contextRosterEl: doc.querySelector("#instance-roster"), contextWorkspace: "A",
    rosterState: { hasData: true, state: "ready" }, rosterStale: false, contextDeploymentNote: null, ...viewContext(),
    currentWorkspace: () => "A", workspaceGeneration: () => 0, collapsedInstances: new Set(),
    rosterTip: { bind(el, facts) { tips.set(el.dataset.treeInstance, facts); }, hide() {}, sync() {} }, rosterTipFacts,
    rosterPrs: { get: () => null, refresh() {} },
    spawnJobs: { rows: () => [], announce: () => false, check() {}, ...(extra.jobs || {}) },
    tabs: new Map(), activeTab: null, tabOpenIntents: { applyFocus: f => f() },
    openTerminalTab() {}, openInstanceStart() {}, openLifecycleDialog: assert.fail, onRosterRowKey() {},
    api: assert.fail, showStage: assert.fail, refreshContextRoster: assert.fail,
    ...(extra.context || {}),
  };
  context.splitOpenState = () => ({ split: null, activeId: null, tabs: context.tabs, workspace: "A", visible: false });
  context.ownsInstanceTarget = () => true;
  // The shell's paint time (Date.now() in shell.mjs) reads this realm's Date at each access, so a test's
  // mock.timers clock reaches the VM too (a VM has its own Date otherwise).
  Object.defineProperty(context, "Date", { get: () => Date, enumerable: true });
  const { render, failRosterUnserved } = runInNewContext(`${source}\n({ render: renderContextRoster, failRosterUnserved })`, context);
  const list = doc.querySelector(".ctx-list");
  const row = name => [...list.querySelectorAll(".ctx-inst")].find(b => b.querySelector(".ctx-name")?.dataset.name === name);
  // Every needs-input mark a row draws: its own (the dot) and the roll-up (the meta line's pill).
  const marks = name => [...(row(name)?.querySelectorAll(".ctx-dot.waiting, .ctx-attn") || [])];
  const own = name => row(name)?.querySelector(".ctx-dot.waiting") ?? null;
  const rollup = name => row(name)?.querySelector(".ctx-attn") ?? null;
  const facts = name => tips.get(row(name)?.dataset.treeInstance)?.();
  const fact = (name, key) => facts(name)?.rows.find(([k]) => k === key)?.[1];
  // A terminal tab as openTerminalTabInner draws it, in workspace "A" unless given.
  const openTab = (inst, workspace = "A") => {
    const id = context.tabs.size + 1, chrome = createTabChrome(doc, id, inst.instance, true, { dot: "on" });
    doc.body.append(chrome.tabEl);
    const tab = { ...chrome, key: tree.terminalKey(workspace, inst), kind: "terminal", workspace };
    context.tabs.set(id, tab);
    return tab;
  };
  return { doc, dom, context, render, failRosterUnserved, openTab, list, row, marks, own, rollup, facts, fact };
}

test("a running, waiting row's dot is the needs-input mark; its meta line stays; “Needs input” stays in the row's accessible name", async t => {
  const u = fixture(t);
  u.render([instance("dev-a", undefined, { waitingOnYou: claim(), branch: "feature/x", color: "sage" }), instance("dev-b")]);
  const dot = u.own("dev-a");
  assert.ok(dot, "the dot is the mark");
  // The product owner, 2026-10-26: the mark in place of the dot, in the dot's slot (the first child of the row).
  assert.equal(dot.className, "ctx-dot waiting");
  assert.equal(u.row("dev-a").firstElementChild, dot);
  assert.equal(u.row("dev-a").querySelectorAll(".ctx-dot").length, 1, "one dot: the mark replaces it");
  const svg = dot.querySelector(":scope > svg.attn-mark");
  assert.ok(svg, "the app's needs-input mark (shell-icons.mjs attention)");
  assert.deepEqual([...svg.children].map(el => el.getAttribute("class")), ["attn-disc", "attn-glyph", "attn-glyph"], "a disc with the “!” cut out");
  assert.equal(svg.getAttribute("aria-hidden"), "true", "the words carry the state; the mark is decoration");
  assert.equal(dot.dataset.instanceColor, undefined, "the instance's colour does not apply to it");
  // No pill: the meta line keeps its soul and repository.
  assert.equal(u.rollup("dev-a"), null, "no Needs input pill");
  const line = u.row("dev-a").querySelector(".ctx-meta");
  assert.equal(line.className, "ctx-meta ctx-soul-repo");
  assert.deepEqual([...line.children].map(el => [el.className, el.textContent]), [["ctx-meta-soul", "dev"], ["ctx-meta-repo", "desktop-repo"]]);
  assert.equal(line.title, "Soul: dev\nRepository: desktop-repo");
  // The words, once, right after the name: visually hidden (the name's own sr-only copy is its real name).
  const said = u.row("dev-a").querySelectorAll(".ctx-copy > .sr-only");
  assert.equal(said.length, 1);
  assert.equal(said[0].textContent, " Needs input");
  assert.equal(said[0].previousElementSibling.className, "ctx-name");
  assert.equal(spokenText(u.row("dev-a")), "dev-a Needs inputdevdesktop-repo", "in the row button's name");
  assert.match(spokenText(u.row("dev-a")).replace(/dev-a/, ""), /^ Needs input/, "said once, after the name");
  assert.equal(u.row("dev-a").querySelector(".ctx-name-line"), null, "the name line is the name alone");
  // The repository and branch stay in the hover card.
  assert.deepEqual([u.fact("dev-a", "Repo"), u.fact("dev-a", "Branch")], ["desktop-repo", "feature/x"]);
  const kept = u.row("dev-b").querySelector(".ctx-meta");
  assert.equal(kept.className, "ctx-meta ctx-soul-repo", "a row without a mark keeps its meta line");
  assert.deepEqual([...kept.children].map(el => [el.className, el.textContent]), [["ctx-meta-soul", "dev"], ["ctx-meta-repo", "desktop-repo"]]);
  assert.ok(u.row("dev-b").querySelector(".ctx-dot.on"), "a row that is not waiting keeps its liveness dot");
  assert.equal(u.marks("dev-b").length, 0);
  assert.equal(u.row("dev-b").querySelector(".ctx-copy > .sr-only"), null);
  assert.equal(u.row("dev-b").querySelector(".ctx-name-line"), null, "a row without marks keeps its plain name");
});

test("the mark replaces the dot whatever the liveness the row reports, and only while the claim holds", async t => {
  const u = fixture(t);
  // waitingClaim gates on Desktop's running observation; a remote row in the kernel's shape has no runtimeState.
  const [remote] = remoteRows([kernelRemoteRow("dev-r", { waitingOnYou: claim() })]);
  u.render([instance("dev-a", undefined, { waitingOnYou: claim(), color: "clay" }), remote]);
  for (const name of ["dev-a", "dev-r"]) assert.equal(u.row(name).querySelector(".ctx-dot").className, "ctx-dot waiting", name);
  u.render([instance("dev-a", undefined, { color: "clay" }), instance("dev-s", undefined, { waitingOnYou: claim(), running: false, runtimeState: "stopped" })]);
  const dot = u.row("dev-a").querySelector(".ctx-dot");
  assert.equal(dot.className, "ctx-dot on", "the liveness dot is back on the first repaint after the claim clears");
  assert.equal(dot.dataset.instanceColor, "clay", "with the instance's colour");
  assert.equal(dot.childElementCount, 0);
  assert.equal(u.row("dev-s").querySelector(".ctx-dot").className, "ctx-dot off", "a stopped row's claim is not shown");
});

test("never on a row whose Desktop liveness is not running, whose server was not reached, or that the roster holds stale", async t => {
  const waiting = { waitingOnYou: claim() };
  const rows = [
    instance("shell", undefined, { ...waiting, running: false, runtimeState: "shell" }),
    instance("stopped", undefined, { ...waiting, running: false, runtimeState: "stopped" }),
    instance("unreachable", undefined, { ...waiting, running: null, runtimeState: "unreachable" }),
    instance("unsupported", undefined, { ...waiting, running: null, runtimeState: "unsupported" }),
    instance("kernel-running", undefined, { ...waiting, runtimeState: "shell" }), // the kernel said running; tmux says shell
    // A remote server that did not answer: its last-known kernel rows, as remotePanel projects them.
    ...unavailableGroups([kernelRemoteGroup([kernelRemoteRow("unreached", waiting)])], { code: "E_SSH", message: "Connection refused" })
      .flatMap(group => remotePanel(group, AT).instances),
    ...remoteRows([kernelRemoteRow("remote-stopped", { ...waiting, running: false, tmux: undefined }),
      kernelRemoteRow("remote-unreachable", { ...waiting, running: null, runtimeState: "unreachable", runtimeError: "tmux is unavailable" })]),
  ];
  assert.deepEqual(rows.slice(-3).map(r => [r.instance, r.runtimeState, r.serverUnreached]),
    [["unreached", null, true], ["remote-stopped", null, false], ["remote-unreachable", "unreachable", false]]);
  const u = fixture(t);
  u.render(rows);
  for (const r of rows) assert.equal(u.marks(r.instance).length, 0, r.instance);
  for (const r of rows) assert.equal(u.fact(r.instance, "Waiting"), undefined, `${r.instance}: no card row either`);
  const stale = fixture(t, { context: { rosterStale: true } });
  stale.render([instance("dev-a", undefined, waiting)]);
  assert.equal(stale.marks("dev-a").length, 0, "a held-stale row's claim is last-known: unknown");
  assert.equal(stale.fact("dev-a", "Waiting"), undefined);
});

test("a remote row in the kernel's shape (runtimeState null: not reported) shows the mark, the card and its tab's cue (#582)", async t => {
  // What the renderer receives for a kernel roster row: every relayed fact null unless the host reported it.
  const [waitingRow, quiet] = remoteRows([kernelRemoteRow("dev-r", { waitingOnYou: claim({ reason: "question", message: "Which branch?" }) }), kernelRemoteRow("dev-q")]);
  assert.deepEqual([waitingRow.running, waitingRow.runtimeState, waitingRow.serverUnreached], [true, null, false]);
  const u = fixture(t), tab = u.openTab(waitingRow);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(SINCE) + 5 * 60e3 });
  u.render([waitingRow, quiet]);
  assert.equal(u.own("dev-r")?.className, "ctx-dot waiting");
  assert.equal(u.marks("dev-q").length, 0);
  assert.equal(u.fact("dev-r", "Waiting"), `Asked you a question · 5 min (since ${waitingClock(SINCE)})`);
  assert.equal(u.fact("dev-r", "Message"), "Which branch?");
  assert.ok(tabCue(tab), "its open terminal tab is lit");
  assert.equal(tab.triggerEl.title, `dev-r\nNeeds input: Which branch? since ${waitingClock(SINCE)}`);
  // The same row once its server stops answering: last-known, so nothing is shown.
  const [group] = unavailableGroups([kernelRemoteGroup([kernelRemoteRow("dev-r", { waitingOnYou: waitingRow.waitingOnYou })])], { code: "E_SSH", message: "Connection refused" });
  u.render(remotePanel(group, AT).instances);
  assert.equal(u.marks("dev-r").length, 0);
  assert.equal(tabCue(tab), null);
});

test("an invalid claim is dropped and the roster still renders", async t => {
  const u = fixture(t);
  u.render([instance("dev-a", undefined, { waitingOnYou: { since: "yesterday", producer: "x" } }),
    instance("dev-b", undefined, { waitingOnYou: claim({ producer: "https://evil.example/x" }) }), instance("dev-c")]);
  assert.equal(u.list.querySelectorAll(".ctx-inst").length, 3);
  assert.equal(u.list.querySelectorAll(".ctx-dot.waiting, .ctx-attn").length, 0);
});

test("the mark disappears on the first repaint after the claim clears", async t => {
  const u = fixture(t);
  u.render([instance("dev-a", undefined, { waitingOnYou: claim() })]);
  assert.equal(u.marks("dev-a").length, 1);
  u.render([instance("dev-a", undefined, { waitingOnYou: null })]);
  assert.equal(u.marks("dev-a").length, 0);
  u.render([instance("dev-a")]);
  assert.equal(u.marks("dev-a").length, 0, "absent is unknown, never a mark");
});

test("with New: New stays on the name line, Needs input is said after it, and the meta line stays", async t => {
  const u = fixture(t, { jobs: { isNew: (_ws, i) => i.instance === "dev-a" } });
  u.render([instance("dev-a", undefined, { waitingOnYou: claim() })]);
  const line = u.row("dev-a").querySelector(".ctx-name-line");
  assert.deepEqual([...line.children].map(el => el.className), ["ctx-name", "ctx-new"]);
  assert.deepEqual([line.nextElementSibling.className, line.nextElementSibling.textContent], ["sr-only", " Needs input"]);
  assert.equal(line.nextElementSibling.nextElementSibling.className, "ctx-meta ctx-soul-repo");
  assert.equal(spokenText(u.row("dev-a")), "dev-aNew Needs inputdevdesktop-repo");
  assert.ok(u.own("dev-a"));
});

test("a waiting row with a pull request: no chip and no branch on the row; the card and the row tools keep the PR", async t => {
  const pr = { home: "/synthetic/dev-a", number: 317, state: "OPEN", isDraft: false, url: "https://github.com/o/r/pull/317" };
  const u = fixture(t, { context: { prChip, prText, rosterPrs: { get: home => home === pr.home ? pr : null, refresh() {} } } });
  u.render([instance("dev-a", undefined, { waitingOnYou: claim(), branch: "feature/x" }), instance("dev-b", undefined, { home: pr.home.replace("dev-a", "dev-b") })]);
  assert.equal(u.row("dev-a").querySelector(".ctx-pr"), null, "no chip on the row");
  assert.equal(u.row("dev-a").querySelector(".ctx-meta").textContent, "devdesktop-repo", "its soul and repository");
  assert.ok(u.own("dev-a"));
  assert.equal(u.fact("dev-a", "Pull request"), prText(pr));
  assert.ok(u.row("dev-a").parentElement.querySelector(".ctx-pr-open"), "its Open pull request tool stays");
});

test("a row with no card (unavailable) whose mark replaced its meta line says the repository and branch in its description; the line keeps its soul and repository title", async t => {
  // A local root whose state is unknown (unavailable: no card), collapsed over a running, waiting child.
  const rows = [instance("root", undefined, { running: null, runtimeState: "unreachable", branch: "feature/root" }), instance("kid", "root", { waitingOnYou: claim() })];
  const u = fixture(t, { context: { collapsedInstances: new Set([tree.collapseKey("A", "/synthetic/root")]) } });
  u.render(rows);
  const root = u.row("root"), said = root.getAttribute("aria-description");
  assert.equal(root.getAttribute("aria-disabled"), "true");
  assert.equal(u.marks("root")[0].textContent, "1 below need input");
  assert.match(said, / · desktop-repo · feature\/root · 1 below need input: kid$/, "why, then where, then the wait");
  assert.equal(root.title, said);
  assert.equal(root.querySelector(".ctx-attn-line").title, "Soul: dev\nRepository: desktop-repo");
  // A row whose line is its own (no mark) keeps its description as it was.
  u.render([instance("root", undefined, { running: null, runtimeState: "unreachable", branch: "feature/root" })]);
  assert.doesNotMatch(u.row("root").getAttribute("aria-description") ?? "", /desktop-repo/);
});

// The meta line (the product owner, 2026-10-26): the soul at the left, the repository at the right, in two spans; no
// branch and no pull request chip on it (the hover card keeps both, the row tools the PR's link). Its title names
// both. A waiting row keeps it (its dot is the mark); the roll-up still replaces the whole line. In CSS the soul is
// cut first; the repository keeps min(10ch, 100%) of the line.
test("the meta line: the soul left, the repository right, no branch and no PR chip; its title names both; a waiting row keeps it", async t => {
  const pr = { home: "/synthetic/dev-a", number: 317, state: "OPEN", isDraft: false, url: "https://github.com/o/r/pull/317" };
  const u = fixture(t, { context: { prChip, prText, rosterPrs: { get: home => home === pr.home ? pr : null, refresh() {} } } });
  u.render([instance("dev-a", undefined, { branch: "feature/x", agent: "desktop-dev" }),
    instance("dev-u", undefined, { running: null, runtimeState: "unreachable", branch: "feature/u", repoName: "other-repo" }),
    instance("dev-w", undefined, { waitingOnYou: claim(), branch: "feature/w" })]);
  const meta = u.row("dev-a").querySelector(".ctx-meta");
  assert.equal(meta.className, "ctx-meta ctx-soul-repo");
  assert.equal(meta.previousElementSibling.className, "ctx-name", "under the name");
  assert.deepEqual([...meta.childNodes].map(el => [el.className, el.textContent]),
    [["ctx-meta-soul", "desktop-dev"], ["ctx-meta-repo", "desktop-repo"]], "the soul first (left), then the repository (right), nothing else");
  assert.equal(meta.title, "Soul: desktop-dev\nRepository: desktop-repo");
  assert.doesNotMatch(meta.textContent, /feature/, "no branch on the line");
  assert.equal(meta.querySelector(".ctx-pr, .ctx-meta-lead, .ctx-meta-tail"), null, "no PR chip on the line");
  assert.equal(u.row("dev-a").querySelector(".ctx-pr"), null, "nor anywhere on the row");
  assert.doesNotMatch(u.row("dev-a").textContent, /#317|feature/);
  // The hover card keeps the branch and the pull request; the row tools the PR's link.
  assert.deepEqual([u.fact("dev-a", "Repo"), u.fact("dev-a", "Branch"), u.fact("dev-a", "Pull request")], ["desktop-repo", "feature/x", prText(pr)]);
  assert.ok(u.row("dev-a").parentElement.querySelector(".ctx-pr-open"), "its Open pull request tool stays");
  // A row's reason label follows the soul, on the soul's side; the repository stays on its own.
  const unknown = u.row("dev-u").querySelector(".ctx-meta");
  assert.deepEqual([...unknown.childNodes].map(el => [el.className, el.textContent]),
    [["ctx-meta-soul", "dev · state unknown"], ["ctx-meta-repo", "other-repo"]]);
  assert.equal(unknown.title, "Soul: dev\nRepository: other-repo");
  // A waiting row's line is the same: its dot carries the mark (the product owner, 2026-10-26).
  const line = u.row("dev-w").querySelector(".ctx-meta");
  assert.equal(line.className, "ctx-meta ctx-soul-repo");
  assert.deepEqual([...line.childNodes].map(el => [el.className, el.textContent]), [["ctx-meta-soul", "dev"], ["ctx-meta-repo", "desktop-repo"]]);
  assert.doesNotMatch(line.textContent, /feature|Needs input/);
  assert.equal(line.title, "Soul: dev\nRepository: desktop-repo");
  // CSS: one flex line; the soul takes the left and is cut with an ellipsis (min-width 0), the repository sits at
  // the right in the mono face and keeps min(10ch, 100%) before it is cut too.
  const rule = selector => css.match(new RegExp(`^${selector.replace(/[.]/g, "\\.")} \\{([^}]*)\\}`, "m"))?.[1].replace(/\s+/g, " ");
  const line_ = rule(".ctx-meta.ctx-soul-repo"), soul = rule(".ctx-meta-soul"), repo = rule(".ctx-meta-repo");
  assert.ok(line_ && soul && repo, "the three rules are shipped");
  assert.match(line_, /display: flex;/); assert.match(line_, /width: 100%;/);
  assert.match(soul, /flex: 1 1000 auto;/, "the soul takes the line's left, and is cut first: its shrink is far above the repository's"); assert.match(soul, /min-width: 0;/, "and can be cut to nothing");
  assert.match(repo, /flex: 0 1 auto;/); assert.match(repo, /min-width: min\(10ch, 100%\);/, "the repository keeps about 10ch");
  assert.match(repo, /text-align: right;/); assert.match(repo, /font-family: var\(--mono\);/);
  for (const r of [soul, repo]) {
    assert.match(r, /overflow: hidden;/); assert.match(r, /text-overflow: ellipsis;/); assert.match(r, /white-space: nowrap;/);
  }
});

test("a held home keeps its state on the meta line; its dot is the mark and its description says the wait", async t => {
  const u = fixture(t);
  u.render([instance("dev-a", undefined, { waitingOnYou: claim(), retireInFlight: true })]);
  assert.equal(u.rollup("dev-a"), null, "the held state wins the line");
  assert.ok(u.own("dev-a"), "the dot is the mark whatever the row's state");
  assert.equal(u.row("dev-a").querySelector(".ctx-copy > .sr-only"), null, "its description says it, so its name does not");
  assert.equal(u.row("dev-a").querySelector(".ctx-meta").className, "ctx-meta ctx-spawn-state");
  assert.match(u.row("dev-a").getAttribute("aria-description"), /Needs input: Waiting for a tool approval since /);
});

test("CSS: the roll-up's pill keeps its size, paints its own opaque surface with background-color, and never animates", () => {
  const rule = css.match(/\.ctx-attn \{([^}]*)\}/)?.[1];
  assert.ok(rule, ".ctx-attn rule");
  for (const decl of ["flex: none", "display: inline-flex", "background-color: var(--attn-bg)", "color: var(--warn)",
    "border: 1px solid var(--attn-border)", "font-size: 10.5px", "font-weight: 600", "line-height: 15px"]) assert.ok(rule.includes(decl), decl);
  assert.doesNotMatch(rule, /background:|opacity|animation|transition/);
  assert.match(css, /\.ctx-meta\.ctx-attn-line \{ display: flex; min-width: 0; \}/, "the mark's line keeps its place");
  assert.doesNotMatch(css, /\.ctx-attn[^{]*\{[^}]*animation/);
});

test("the card shows the reason, the message and the age, computed when shown", async t => {
  const u = fixture(t);
  u.render([instance("dev-a", undefined, { waitingOnYou: claim({ message: "Allow Bash(rm -rf build)?" }) }),
    instance("dev-b", undefined, { waitingOnYou: claim({ reason: "approval" }) })]);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(SINCE) + 3 * 3600e3 + 59 * 60e3 });
  assert.equal(u.fact("dev-a", "Waiting"), `Waiting for a tool approval · 3 h (since ${waitingClock(SINCE)})`);
  assert.equal(u.fact("dev-a", "Message"), "Allow Bash(rm -rf build)?");
  const keys = u.facts("dev-a").rows.map(([k]) => k);
  assert.equal(keys.indexOf("Waiting"), keys.indexOf("Status") + 1, "after Status");
  assert.equal(u.fact("dev-b", "Waiting"), `Needs input · 3 h (since ${waitingClock(SINCE)})`, "an unknown reason is never shown raw: the card has no tag, so its Waiting fact says the shared word once");
  assert.equal(u.fact("dev-b", "Message"), undefined, "no message, no row");
  t.mock.timers.setTime(Date.parse(SINCE) + 2 * 86400e3 + 5);
  assert.equal(u.fact("dev-a", "Waiting"), `Waiting for a tool approval · 2 d (since ${waitingClock(SINCE)})`, "not frozen at paint");
  assert.match(u.fact("dev-a", "Waiting"), /\(since Oct \d{1,2}, \d\d:\d\d\)$/, "two days later the start carries its date (#559)");
});

// #584 finding 12: the notes eventsUnsafe withholds (a link, a "token: x") read as the reason in words.
const WITHHELD = [["See https://github.com/awebai/oats/pull/552", "attention", "Asked for your attention"],
  ["Which token: A or B?", "question", "Asked you a question"], ["api key: rotate now?", "approval", "Needs input"]];

test("a withheld note: the card shows the reason in Waiting and no Message row, never “[withheld]” (#584)", async t => {
  const u = fixture(t);
  const rows = WITHHELD.map(([message, reason], n) => instance(`dev-${n}`, undefined, { waitingOnYou: claim({ message, reason }) }));
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(SINCE) + 5 * 60e3 });
  u.render([...rows, instance("dev-safe", undefined, { waitingOnYou: claim({ message: "Proceed?", reason: "question" }) })]);
  WITHHELD.forEach(([message, , label], n) => {
    assert.ok(u.own(`dev-${n}`), "the claim is kept");
    assert.equal(u.fact(`dev-${n}`, "Waiting"), `${label} · 5 min (since ${waitingClock(SINCE)})`, message);
    assert.equal(u.fact(`dev-${n}`, "Message"), undefined, "the Waiting row already says it");
    assert.doesNotMatch(JSON.stringify(u.facts(`dev-${n}`)), /withheld/i);
  });
  assert.equal(u.fact("dev-safe", "Message"), "Proceed?", "a safe note still has its row");
});

test("the card renders the message as text: markup is shown literally, never parsed", async t => {
  const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document, tip = createRosterTip(doc);
  const row = doc.createElement("button"); row.dataset.treeInstance = "/synthetic/dev-a"; doc.body.append(row);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  tip.bind(row, () => rosterTipFacts(instance("dev-a", undefined, { waitingOnYou: claim({ message: "<b>bold</b><script>x()</script>" }) }), "Open dev-a terminal"));
  row.dispatchEvent(new dom.window.Event("mouseenter"));
  t.mock.timers.tick(400);
  const card = doc.querySelector(".ctx-tip");
  assert.equal(card.hidden, false);
  const message = [...card.querySelectorAll(".ctx-tip-fact")].find(f => f.querySelector("dt").textContent === "Message");
  assert.equal(message.querySelector("dd").textContent, "<b>bold</b><script>x()</script>");
  assert.equal(card.querySelector("b, script"), null, "no element created from the message");
});

test("a collapsed parent surfaces waiting rows its collapse hides; expanding it hands the marks back", async t => {
  const rows = [instance("root"), instance("dev-a", "root", { waitingOnYou: claim() }), instance("dev-b", "root", { waitingOnYou: claim({ reason: "question" }) }),
    instance("dev-c", "root"), instance("solo")];
  const collapsed = new Set([tree.collapseKey("A", "/synthetic/root")]);
  const u = fixture(t, { context: { collapsedInstances: collapsed } });
  u.render(rows);
  assert.equal(u.row("dev-a"), undefined, "the children are hidden");
  const [mark] = u.marks("root");
  assert.equal(mark.className, "ctx-attn rollup");
  assert.equal(mark.textContent, "2 below need input", "the visible “2 below” plus the visually hidden rest");
  assert.equal(mark.querySelector(".sr-only").textContent, " need input");
  assert.match(u.row("root").textContent, /2 below need input/, "the row's accessible name says it");
  assert.equal(u.fact("root", "Below"), "2 need input: dev-a, dev-b");
  assert.equal(u.fact("root", "Waiting"), undefined, "root itself is not waiting");
  assert.equal(u.marks("solo").length, 0);
  collapsed.clear();
  u.render(rows);
  assert.equal(u.marks("root").length, 0, "the roll-up is derived on every paint");
  assert.deepEqual(["dev-a", "dev-b"].map(n => u.marks(n).map(m => m.className)), [["ctx-dot waiting"], ["ctx-dot waiting"]]);
  assert.equal(u.fact("root", "Below"), undefined);
});

test("a waiting, collapsed parent: its dot is the mark and its meta line the roll-up; its card names the rest", async t => {
  const rows = [instance("root", undefined, { waitingOnYou: claim() }), instance("dev-a", "root", { waitingOnYou: claim() })];
  const u = fixture(t, { context: { collapsedInstances: new Set([tree.collapseKey("A", "/synthetic/root")]) } });
  u.render(rows);
  assert.deepEqual(u.marks("root").map(m => [m.className, m.textContent]), [["ctx-dot waiting", ""], ["ctx-attn rollup", "1 below need input"]]);
  assert.equal(u.rollup("root").parentElement.className, "ctx-meta ctx-attn-line");
  // The disclosure's ", 1 below" (the rows under it, the product owner, 2026-11-19) follows the name, then the wait.
  assert.equal(spokenText(u.row("root")), "root, 1 below Needs input1 below need input", "both, each said once");
  assert.ok(u.fact("root", "Waiting"));
  assert.equal(u.fact("root", "Below"), "1 needs input: dev-a");
});

test("names up to three, then “and N more”; nested collapses attribute to the nearest visible ancestor", async t => {
  const kids = ["k1", "k2", "k3", "k4", "k5"].map(n => instance(n, "mid", { waitingOnYou: claim() }));
  const rows = [instance("root"), instance("mid", "root"), ...kids];
  const u = fixture(t, { context: { collapsedInstances: new Set([tree.collapseKey("A", "/synthetic/mid"), tree.collapseKey("A", "/synthetic/root")]) } });
  u.render(rows);
  assert.equal(u.row("mid"), undefined);
  assert.equal(u.marks("root")[0].textContent, "5 below need input");
  assert.equal(u.fact("root", "Below"), "5 need input: k1, k2, k3 and 2 more");
});

test("no roll-up from a stale or non-running row", async t => {
  const rows = [instance("root"), instance("dev-a", "root", { waitingOnYou: claim() }), instance("dev-b", "root", { waitingOnYou: claim(), running: false, runtimeState: "shell" })];
  const collapsed = new Set([tree.collapseKey("A", "/synthetic/root")]);
  const only = fixture(t, { context: { collapsedInstances: collapsed } });
  only.render(rows);
  assert.equal(only.marks("root")[0].textContent, "1 below need input", "the shell row is not counted");
  const stale = fixture(t, { context: { collapsedInstances: collapsed, rosterStale: true } });
  stale.render(rows);
  assert.equal(stale.list.querySelector(".ctx-attn"), null);
});

test("a parent cycle or a missing parent degrades to no roll-up", async t => {
  const rows = [instance("a", "b", { waitingOnYou: claim() }), instance("b", "a"), instance("orphan", "gone", { waitingOnYou: claim() })];
  const u = fixture(t, { context: { collapsedInstances: new Set([tree.collapseKey("A", "/synthetic/a"), tree.collapseKey("A", "/synthetic/b")]) } });
  u.render(rows);
  assert.equal(u.list.querySelector(".ctx-attn.rollup"), null);
  assert.equal(u.own("orphan")?.className, "ctx-dot waiting");
});

test("an unavailable row (no card) says it in its title and description: message or label, absolute time", async t => {
  // Remote rows in the kernel's shape (runtimeState null), made unavailable by `addressable: false`: the only
  // way a row is both running (so its claim shows) and without a card. Today's kernel reports every row its
  // host lists as addressable, so this pins the sentence for a row that cannot open, not a shape it emits.
  const remote = (name, parentInstance, extra = {}) => remoteRows([kernelRemoteRow(name, { parentInstance: parentInstance ?? null, addressable: false, ...extra })])[0];
  const rows = [remote("dev-a", undefined, { waitingOnYou: claim({ message: "Proceed?" }) }), remote("dev-b", undefined, { waitingOnYou: claim({ reason: "question" }) }),
    remote("root"), remote("kid", "root", { waitingOnYou: claim() })];
  const u = fixture(t, { context: { collapsedInstances: new Set([tree.collapseKey("A", tree.instanceId(rows[2]))]) } });
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(SINCE) + 60e3 }); // painted a minute later: the same local day
  u.render(rows);
  const a = u.row("dev-a"), b = u.row("dev-b"), root = u.row("root");
  assert.equal(a.getAttribute("aria-disabled"), "true");
  assert.match(a.getAttribute("aria-description"), new RegExp(` · Needs input: Proceed\\? since ${waitingClock(SINCE)}$`));
  assert.equal(a.title, a.getAttribute("aria-description"));
  assert.match(b.getAttribute("aria-description"), / · Needs input: Asked you a question since \d\d:\d\d$/);
  assert.ok(u.own("dev-a"));
  assert.match(spokenText(a), /^dev-a Needs input/, "its name says it too, as it did with the pill");
  assert.equal(u.marks("root")[0].textContent, "1 below need input");
  assert.match(root.getAttribute("aria-description"), / · 1 below need input: kid$/);
  // A withheld note reads as the reason in words in the row's sentence (#584 finding 12).
  const withheld = WITHHELD.map(([message, reason], n) => remote(`held-${n}`, undefined, { waitingOnYou: claim({ message, reason }) }));
  u.render(withheld);
  WITHHELD.forEach(([message, , label], n) => {
    const said = u.row(`held-${n}`).getAttribute("aria-description");
    // The card's label for an unknown reason is the tag's own word, so the sentence says it once (#1502).
    const detail = label === "Needs input" ? "" : `: ${label}`;
    assert.ok(said.endsWith(` · Needs input${detail} since ${waitingClock(SINCE)}`), `${message}: ${said}`);
    assert.equal(u.row(`held-${n}`).title, said);
    assert.doesNotMatch(said, /withheld/i);
  });
  // Painted two days later, the sentence carries the start's date (#559), from the paint time.
  t.mock.timers.setTime(Date.parse(SINCE) + 2 * 86400e3);
  u.render(rows);
  const dated = u.row("dev-a").getAttribute("aria-description");
  assert.ok(dated.endsWith(` · Needs input: Proceed? since ${waitingClock(SINCE, Date.now())}`), dated);
  assert.match(dated, / since Oct \d{1,2}, \d\d:\d\d$/);
});

test("a roll-up stays inside its deployment section: a unique parent name in another deployment collects nothing", async t => {
  const deployment = id => ({ id, path: id, machine: "This Mac", local: true, reachable: true, primary: id === "/d1" });
  const at = (name, dep, parent, extra = {}) => instance(name, parent, { home: `${dep}/agents/dev/instances/${name}`, agentsRoot: `${dep}/agents`, deployment: deployment(dep), ...extra });
  // /d2's own "lead" is gone (retired): its child's parent name resolves to /d1's lead, the only one left.
  const lead = at("lead", "/d1"), own = at("own-child", "/d1", "lead", { waitingOnYou: claim() }), orphan = at("waiting-d2", "/d2", "lead", { waitingOnYou: claim() });
  const u = fixture(t, { context: { contextDeployments: [deployment("/d1"), deployment("/d2")], collapsedInstances: new Set([tree.collapseKey("A", tree.instanceId(lead))]) } });
  u.render([lead, own, orphan]);
  const [mark] = u.marks("lead");
  assert.equal(mark.textContent, "1 below need input", "only /d1's own child is counted");
  assert.equal(u.list.querySelectorAll(".ctx-attn.rollup").length, 1, "and nothing else rolls up");
});

test("a collapse hides only rows of its own section: another deployment's child of it stays painted, with its own mark (#551's symptom)", async t => {
  const deployment = id => ({ id, path: id, machine: "This Mac", local: true, reachable: true, primary: id === "/d1" });
  const at = (name, dep, parent, extra = {}) => instance(name, parent, { home: `${dep}/agents/dev/instances/${name}`, agentsRoot: `${dep}/agents`, deployment: deployment(dep), ...extra });
  // /d2's own "lead" is gone: its children's parent name resolves to /d1's lead, painted (and collapsed) in /d1's section.
  const lead = at("lead", "/d1"), own = at("own-child", "/d1", "lead", { waitingOnYou: claim() }),
    waiting = at("waiting-d2", "/d2", "lead", { waitingOnYou: claim() }), quiet = at("quiet-d2", "/d2", "lead");
  const rows = [lead, own, waiting, quiet], collapsed = new Set();
  const u = fixture(t, { context: { contextDeployments: [deployment("/d1"), deployment("/d2")], collapsedInstances: collapsed } });
  const guides = name => [...u.row(name).querySelectorAll(".ctx-guide")].map(g => g.className).join("|");
  u.render(rows);
  const open = { waiting: guides("waiting-d2"), quiet: guides("quiet-d2") };
  collapsed.add(tree.collapseKey("A", tree.instanceId(lead)));
  u.render(rows);
  assert.equal(u.row("own-child"), undefined, "the collapse still hides its own section's child");
  assert.equal(u.marks("lead")[0].textContent, "1 below need input", "and rolls it up");
  assert.ok(u.row("waiting-d2"), "/d2's child is not hidden by /d1's collapse");
  assert.ok(u.row("quiet-d2"), "nor is a child that is not waiting");
  const [mark] = u.marks("waiting-d2");
  assert.equal(mark.className, "ctx-dot waiting", "it shows its own mark, not a roll-up");
  assert.equal(u.marks("waiting-d2").length, 1);
  assert.deepEqual({ waiting: guides("waiting-d2"), quiet: guides("quiet-d2") }, open, "its guides are the same as with /d1's lead expanded");
});

const tabCue = tab => tab.triggerEl.querySelector(":scope > .tab-attn");

test("every roster paint re-syncs the open terminal tabs: an overdue read's stale paint clears a lit tab (#558)", async t => {
  const rows = [instance("dev-a", undefined, { waitingOnYou: claim() })];
  const fails = [];
  const u = fixture(t, { context: { rosterState: { hasData: true, state: "ready", fail: e => fails.push(e.code) } } });
  const tab = u.openTab(rows[0]);
  u.context.contextInstances = rows;
  u.render(rows);
  assert.ok(tabCue(tab), "the paint lights the tab");
  assert.equal(tab.triggerEl.getAttribute("aria-label"), "dev-a, needs input");
  u.failRosterUnserved(NO_ANSWER_CODE, "A"); // what rosterOverdue runs when the pending watch expires
  assert.deepEqual(fails, [NO_ANSWER_CODE]);
  assert.equal(u.context.rosterStale, true, "the rows are kept, held stale");
  assert.equal(u.marks("dev-a").length, 0, "the row's mark goes");
  assert.equal(tabCue(tab), null, "and so does the tab's, in the same paint");
  assert.equal(tab.triggerEl.getAttribute("aria-label"), "dev-a");
  assert.equal(tab.triggerEl.title, "dev-a");
});

test("a reset subject's pending paint clears the tabs and the last-painted roster before a tab is restored (#558)", async t => {
  const rows = [instance("dev-a", undefined, { waitingOnYou: claim() })];
  const u = fixture(t);
  const tab = u.openTab(rows[0]);
  u.render(rows);
  assert.ok(tabCue(tab));
  assert.equal(u.context.tabNeedsInputRoster.instances, rows);
  // restoreWorkspaceTabs: a new subject, no data yet, the roster painted pending with no rows.
  u.context.contextInstances = []; u.context.rosterState = { hasData: false, state: "loading" };
  u.render([]);
  assert.equal(tabCue(tab), null, "no observation: unknown, so no cue");
  const cached = u.context.tabNeedsInputRoster; // the VM's own objects: compared by fields, not prototypes
  assert.equal(cached.instances.length, 0, "a restored tab syncs against no rows"); assert.equal(cached.workspace, "A");
});

/* ── #982: a row's own text is shown with who made it ── */
test("a row that cannot open says who made its text in its title and description: each speaker, none, and hostile text as text", t => {
  const u = fixture(t), text = "the session did not answer";
  const rows = shown(text).map(([origin, line], n) => [instance(`dev-${n}`, undefined, { running: null, runtimeState: "unknown", runtimeError: text, ...(origin ? { runtimeErrorOrigin: origin } : {}) }), line]);
  rows.push([instance("dev-markup", undefined, { running: null, runtimeState: "unknown", runtimeError: MARKUP, runtimeErrorOrigin: "kernel" }), `OATS says: ${MARKUP}`]);
  rows.push([instance("dev-control", undefined, { running: null, runtimeState: "unknown", runtimeError: CONTROL, runtimeErrorOrigin: "kernel" }), DETAIL_WITHHELD]);
  // A row with no text of its own keeps the sentence written for it, under no speaker's name whatever mark it carries.
  rows.push([instance("dev-bare", undefined, { running: null, runtimeState: "unknown", runtimeErrorOrigin: "kernel" }), "dev-bare: status unknown"]);
  // A text beside no speaker, or beside a mark that is none of the three: its reason is unattributed, so it is shown filtered, with no lead.
  for (const [n, mark] of [{}, { runtimeErrorOrigin: "someone-else" }, { runtimeErrorOrigin: "unattributed" }].entries()) {
    rows.push([instance(`dev-lost-${n}`, undefined, { running: null, runtimeState: "unknown", runtimeError: CONTROL, ...mark }), DETAIL_WITHHELD]);
    rows.push([instance(`dev-bidi-${n}`, undefined, { running: null, runtimeState: "unknown", runtimeError: "safe\u202Etxt.exe", ...mark }), "safe\uFFFDtxt.exe"]);
    rows.push([instance(`dev-odd-${n}`, undefined, { running: null, runtimeState: "unknown", runtimeError: { message: "x" }, ...mark }), "state unknown"]);
  }
  // A sentence the shared home wrote is shown as written: the filter reads no credential's shape in an instance's name.
  rows.push([instance("vault-secret", undefined, { running: null, runtimeState: "unknown" }), "vault-secret: status unknown"]);
  u.render(rows.map(([row]) => row));
  for (const [row, line] of rows) {
    const el = u.row(row.instance);
    assert.equal(el.title, line, row.instance); assert.equal(el.getAttribute("aria-description"), line, row.instance);
    assert.equal(el.getAttribute("aria-disabled"), "true");
  }
  assert.equal(u.list.querySelector("b, script"), null, "no element is made from a row's text");
});

test("another machine's row: the kernel's text reads under OATS, the reader's own under the Desktop's read of other machines", t => {
  const u = fixture(t), remote = (name, extra) => instance(name, undefined, { server: "box", repoName: "box-repo", addressable: true, running: null, runtimeState: "unknown", serverUnreached: true, ...extra });
  u.render([remote("dev-k", { runtimeError: "E_SSH: no route", runtimeErrorOrigin: "kernel" }), remote("dev-r", { runtimeError: "the read did not answer", runtimeErrorOrigin: "roster-read" }), remote("dev-n", {})]);
  assert.equal(u.row("dev-k").title, "OATS says: E_SSH: no route");
  assert.equal(u.row("dev-r").title, "Desktop's read of other machines says: the read did not answer");
  assert.equal(u.row("dev-n").title, "box-repo was not reached.", "a sentence written here has no lead");
});

test("the hover card's Status says who made the row's text; the card shows it as text", async t => {
  const text = "the session did not answer";
  for (const [origin, line] of shown(text)) {
    const facts = rosterTipFacts(instance("dev-a", undefined, { running: false, runtimeState: "stopped", runtimeError: text, ...(origin ? { runtimeErrorOrigin: origin } : {}) }), "Start dev-a");
    assert.equal(facts.rows.find(([key]) => key === "Status")[1], `stopped · ${line}`, String(origin));
  }
  const status = extra => rosterTipFacts(instance("dev-a", undefined, { running: false, runtimeState: "stopped", ...extra })).rows.find(([key]) => key === "Status")[1];
  assert.equal(status({ runtimeErrorOrigin: "kernel" }), "stopped", "a mark beside no text shows nothing");
  assert.equal(status({ runtimeError: CONTROL, runtimeErrorOrigin: "terminal-probe" }), `stopped · ${DETAIL_WITHHELD}`, "an unsafe text is withheld, under no speaker's name");
  const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document, tip = createRosterTip(doc);
  const row = doc.createElement("button"); row.dataset.treeInstance = "/synthetic/dev-a"; doc.body.append(row);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  tip.bind(row, () => rosterTipFacts(instance("dev-a", undefined, { running: false, runtimeState: "stopped", runtimeError: MARKUP, runtimeErrorOrigin: "terminal-probe" }), "Start dev-a"));
  row.dispatchEvent(new dom.window.Event("mouseenter"));
  t.mock.timers.tick(400);
  const card = doc.querySelector(".ctx-tip");
  const fact = [...card.querySelectorAll(".ctx-tip-fact")].find(f => f.querySelector("dt").textContent === "Status");
  assert.equal(fact.querySelector("dd").textContent, `stopped · ${SPEAKERS["terminal-probe"]} ${MARKUP}`);
  assert.equal(card.querySelector("b, script"), null, "no element created from the text");
});

test("a row that still opens carries its text with its speaker into the card's sentence", t => {
  const u = fixture(t);
  u.render([instance("dev-a", undefined, { running: false, runtimeState: "stopped", runtimeError: "the last start failed", runtimeErrorOrigin: "kernel" })]);
  assert.equal(u.facts("dev-a").why, "OATS says: the last start failed");
  assert.equal(u.fact("dev-a", "Status"), "stopped · OATS says: the last start failed");
});

test("Open in split on a Herdr row: the kernel's reason under OATS, the stand-in for an older kernel's row with no lead", t => {
  const u = fixture(t);
  u.render([instance("dev-k", undefined, { running: null, runtimeState: "unsupported", runtimeError: `${HERDR} (dev-k)`, runtimeErrorOrigin: "kernel" }),
    instance("dev-lost", undefined, { running: null, runtimeState: "unsupported", runtimeError: `${HERDR} (dev-lost)` }),
    instance("dev-old", undefined, { backend: "herdr" }),
    instance("dev-markup", undefined, { running: null, runtimeState: "unsupported", runtimeError: `E_HERDR_REMOVED: ${MARKUP}`, runtimeErrorOrigin: "kernel" })]);
  const split = name => u.row(name).closest(".ctx-tree-row").querySelector('[data-action="open-split"]');
  for (const [name, line] of [["dev-k", `OATS says: ${HERDR} (dev-k)`], ["dev-lost", `${HERDR} (dev-lost)`], ["dev-old", HERDR], ["dev-markup", `OATS says: E_HERDR_REMOVED: ${MARKUP}`]]) {
    assert.equal(split(name).disabled, true, name); assert.equal(split(name).title, line, name);
    assert.equal(split(name).querySelector("small").textContent, line, name);
  }
  assert.equal(u.list.querySelector("b, script"), null);
});

// The pill's mark at its computed size (2026-10-23): .shell-icon's 16px would otherwise win over the SVG's own 10px,
// so the size is read through the shipped stylesheets, for the roll-up's pill.
test("the roll-up pill's mark is 10px under the shipped stylesheets, concentric with its end", () => {
  const sheets = ["theme.css", "shell.css"].map(name => readFileSync(new URL(`../renderer/${name}`, import.meta.url), "utf8")).join("\n");
  const dom = new JSDOM(`<!doctype html><html><head><style>${sheets}</style></head><body></body></html>`);
  const doc = dom.window.document;
  const mark = runInNewContext(`(${fn("needsInputMark")})`, { document: doc, iconElement });
  for (const pill of [mark(1), mark(12)]) {
    doc.body.append(pill);
    assert.equal(pill.className, "ctx-attn rollup");
    const svg = pill.querySelector("svg.attn-mark"); assert.ok(svg, "the mark leads the pill");
    assert.equal(pill.firstElementChild, svg);
    const style = dom.window.getComputedStyle(svg);
    assert.deepEqual([style.width, style.height], ["10px", "10px"], pill.textContent);
    assert.equal(dom.window.getComputedStyle(pill).paddingLeft, "2.5px", "1px border + 2.5px + 5px is the pill's 8.5px radius");
  }
  dom.window.close();
});

// The waiting row's dot (the product owner, 2026-10-26), through the shipped stylesheets: the mark at 10px, centred on
// the 8px dot's slot (-1px each side, so the name and the guides keep their place), with the dot's 2px ring in the
// row's fill and that fill under the disc, no border of its own.
test("a waiting row's dot is the 10px mark centred on the 8px dot's slot, with the dot's ring in the row's fill", async t => {
  const sheets = ["theme.css", "shell.css"].map(name => readFileSync(new URL(`../renderer/${name}`, import.meta.url), "utf8")).join("\n");
  const u = fixture(t);
  u.doc.head.insertAdjacentHTML("beforeend", `<style>${sheets}</style>`);
  u.render([instance("dev-a", undefined, { waitingOnYou: claim() }), instance("dev-b")]);
  const view = u.dom.window, waiting = view.getComputedStyle(u.own("dev-a")), plain = view.getComputedStyle(u.row("dev-b").querySelector(".ctx-dot"));
  assert.deepEqual([waiting.width, waiting.height], ["10px", "10px"]);
  assert.deepEqual([plain.width, plain.height], ["8px", "8px"]);
  assert.deepEqual([waiting.marginLeft, waiting.marginRight], ["-1px", "-1px"], "its footprint is the 8px dot's");
  assert.equal(waiting.borderTopWidth, "0px");
  assert.equal(waiting.boxShadow, plain.boxShadow, "the dot's 2px ring in the row's fill");
  assert.match(waiting.backgroundColor, /row-solid/, "the row's fill under the disc");
  assert.equal(waiting.zIndex, plain.zIndex, "above the guides, as the dot");
  const svg = view.getComputedStyle(u.own("dev-a").querySelector("svg"));
  assert.deepEqual([svg.width, svg.height], ["10px", "10px"]);
});
