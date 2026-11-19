// Workspace views (#482), renderer side: no deployments block in the sidebar, the roster grouped by
// deployment ONLY with two or more deployments (one deployment looks exactly as before), the
// workspace list's one-line entries (unmatched views among them, by name), and the "On <deployment>"
// line of deployment-level surfaces. DOM and computed-token checks in jsdom; no Electron, HTTP or CLI.
import test from "node:test";
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
import * as vdShared from "../../client/roster-sections.mjs";
import * as vdView from "../renderer/view-deployments.mjs";
const vd = { ...vdShared, ...vdView };
import * as hierarchy from "../renderer/views/hierarchy.mjs";
import { createWorkspaceSwitcher } from "../renderer/workspace-switcher.mjs";
import { workspaceChoiceLabels, workspaceChoicePlace } from "../../client/workspace-choices.mjs";
import { onDeploymentTabRequest } from "../renderer/deployment-tabs.mjs";
import { mountShellIcons } from "../renderer/shell-icons.mjs";
import { deploymentScopeLabel, createDeploymentScopeLine, deploymentScopeCSS } from "../renderer/deployment-scope-line.mjs";
import { createAutomationsView, automationsCSS } from "../renderer/views/automations.mjs";
import { inspectorCSS } from "../renderer/soul-inspector.mjs";
import { currentWorkspace, setWorkspace } from "../renderer/views/common.mjs";
import { viewContext } from "./helpers/view-context.mjs";
import { DESKTOP_TERMS } from "../renderer/desktop-terms.mjs";

const read = (name) => readFileSync(new URL(`../renderer/${name}`, import.meta.url), "utf8");
const css = read("shell.css"), theme = read("theme.css"), html = read("index.html"), shellSource = read("shell.mjs");
const tick = () => new Promise((resolve) => setImmediate(resolve));

const LOCAL = { id: "/Users/op/Agents/oats", machine: "This Mac", path: "/Users/op/Agents/oats", label: "~/Agents/oats", local: true,
  reachable: true, identityFrom: "reported", primary: true };
const DEVBOX = { id: "remote:devbox:web", machine: "devbox", path: "/home/op/Agents/web", label: "~/Agents/web", local: false,
  reachable: false, identityFrom: "remembered", primary: false, reason: "devbox timed out; it is tried again on the next read.",
  note: "devbox now reports workspace web." };
const LOCAL2 = { id: "/Users/op/example/oats-qa", machine: "This Mac", path: "/Users/op/example/oats-qa", label: "~/example/oats-qa", local: true,
  reachable: true, identityFrom: "reported", primary: false };
const tag = (d) => ({ id: d.id, machine: d.machine, path: d.path });
const row = (name, d, fields = {}) => ({ instance: name, agent: "soul", agentsRoot: `${d.path}/agents`, home: `${d.path}/agents/soul/instances/${name}`,
  repoName: "repo", running: true, deployment: tag(d), ...(d.local ? {} : { server: d.machine, addressable: true }), ...fields });

/* ── deployment states, and no deployments block in the sidebar ── */
test("deploymentState says live, remembered, not reached and not observed in words", () => {
  assert.deepEqual(vd.deploymentState(LOCAL), { key: "live", text: "live", detail: "" });
  assert.deepEqual(vd.deploymentState(DEVBOX), { key: "remembered", text: "remembered", detail: `Last report, not live now. ${DEVBOX.reason}` });
  assert.deepEqual(vd.deploymentState({ ...DEVBOX, identityFrom: null }), { key: "unreached", text: "not reached", detail: DEVBOX.reason });
  assert.deepEqual(vd.deploymentState({ ...LOCAL, reachable: false, reason: "Reading the deployment…" }), { key: "unobserved", text: "not observed", detail: "Reading the deployment…" });
});

// The sidebar (the product owner, 2026-10-26): the head (the Workspace heading), its list, the main views under it, then
// Instances; the foot last. No section wraps the current workspace's views and Instances any more.
test("UI spec: no deployments block in the sidebar; the workspace list sits under its heading, the nav under it, then the Instances", (t) => {
  const dom = new JSDOM(html); t.after(() => dom.window.close());
  const doc = dom.window.document;
  assert.equal(doc.getElementById("ws-deployments"), null);
  assert.deepEqual([...doc.getElementById("sidebar").children].map((el) => el.id || el.className), ["side-head", "ws-list", "nav", "instance-roster", "nav-foot"]);
  assert.equal(doc.getElementById("ws-current"), null, "no section around the current workspace's views and Instances");
  assert.equal(doc.getElementById("ws-list").previousElementSibling, doc.querySelector(".side-head"), "the list sits under its heading");
  assert.equal(doc.querySelector(".side-head #ws-heading").textContent, "Workspace");
  assert.equal(doc.getElementById("nav").previousElementSibling, doc.getElementById("ws-list"), "the main views are under the list of workspaces");
  assert.equal(doc.getElementById("instance-roster").previousElementSibling, doc.getElementById("nav"), "then the Instances");
  assert.equal(vd.renderDeploymentList, undefined, "the list renderer is gone");
  assert.doesNotMatch(`${css}\n${shellSource}`, /ws-deployment|renderDeploymentList|ctx-deployment-tag|ws-option-reason/);
});

/* ── the sidebar roster ── */
const renderSource = shellSource.match(/function renderContextRoster\(instances\) \{[\s\S]*?\n\}/)?.[0];
// `said`: what the rows' context menus said in the hint's line (sayInHint) when held.
function roster(t, instances, deployments, said = []) {
  const dom = new JSDOM(html); t.after(() => dom.window.close());
  // jsdom has no top-layer API: model only the popover's open/close events (as instance-actions.test.mjs does), and
  // this window paints nothing: the menu's next-frame placement runs at once.
  dom.window.requestAnimationFrame ??= cb => { cb(); return 0; };
  for (const [method, newState] of [["showPopover", "open"], ["hidePopover", "closed"]]) {
    dom.window.HTMLElement.prototype[method] = function () {
      const event = new dom.window.Event("beforetoggle");
      Object.defineProperty(event, "newState", { value: newState });
      this.dispatchEvent(event);
    };
  }
  const doc = dom.window.document;
  const context = {
    ...tree, ...viewContext(), contextDeployments: deployments, document: doc, instanceActions, captureInstanceActionMenu, runtimeState, unsupportedSession,
    canAddressRemote, rowReason, createRuntimeBadge, instanceActionTarget, instanceSplitPlan, connectionGeneration: 0, menuState() {}, runAction: assert.fail, sayInHint: (line) => said.push(line),
    applyChordTitles() {}, updateActiveContexts() {}, getBinding: () => null, formatChord: (c) => c, isMac: true,
    contextRosterEl: doc.querySelector("#instance-roster"), contextWorkspace: "ws:view",
    rosterState: { hasData: true, state: "ready" }, rosterStale: false, contextDeploymentNote: null,
    contextInstances: instances, currentWorkspace: () => "ws:view", workspaceGeneration: () => 0, collapsedInstances: new Set(),
    rosterTip: { bind() {}, hide() {}, sync() {} }, rosterTipFacts: () => ({}), rosterPrs: { get: () => null, refresh() {} },
    spawnJobs: { rows: () => [], announce: () => false, observe() {}, settling: () => false, check() {} },
    tabs: new Map(), activeTab: null, tabOpenIntents: { applyFocus: (fn) => fn() },
    openTerminalTab: assert.fail, openInstanceStart: assert.fail, openLifecycleDialog: assert.fail, onRosterRowKey: assert.fail,
    api: assert.fail, showStage: assert.fail, refreshContextRoster: assert.fail,
  };
  context.splitOpenState = () => ({ split: null, activeId: null, tabs: context.tabs, workspace: "ws:view", visible: false });
  context.ownsInstanceTarget = (target) => context.contextInstances.filter((r) => sameInstanceActionTarget(target, r, "ws:view")).length === 1;
  runInNewContext(`${renderSource}\nrenderContextRoster`, context)(instances);
  return doc.querySelector(".ctx-list");
}

test("source pin: the shell's roster groups through the shared sections (sidebarSections, over rosterSections) with the shown view's deployments", () => {
  assert.ok(renderSource);
  // #1579: the main tree and the Background section, each rosterSections over its rows (roster-sections.mjs sidebarSections).
  assert.match(renderSource, /sidebarSections\(instances, visible, contextDeployments, DESKTOP_TERMS,/);
  assert.match(shellSource, /contextDeployments = panelDeployments\(panel\);/);
});

test("roster, one deployment: no deployment heading, and exactly the list a window drew before views", (t) => {
  const rows = [row("lead", LOCAL), row("dev", LOCAL, { parentInstance: "lead" }), row("solo", LOCAL)];
  const before = roster(t, rows, []), one = roster(t, rows, [LOCAL]);
  assert.equal(one.querySelector(".ctx-deployment"), null, "no heading for a single deployment");
  assert.equal(one.innerHTML, before.innerHTML, "the same DOM as a panel naming no deployments");
  assert.deepEqual([...one.querySelectorAll(".ctx-group")].map((g) => g.dataset.group), ["lead", "independent"]);
});

test("roster, two deployments: a heading per deployment, by machine, in order, its own agent groups under it; host kept on remote rows", (t) => {
  const rows = [row("lead", LOCAL), row("dev", LOCAL, { parentInstance: "lead" }), row("far", DEVBOX), row("near", LOCAL)];
  const list = roster(t, rows, [LOCAL, DEVBOX]);
  const heads = [...list.querySelectorAll(".ctx-deployment")];
  assert.deepEqual(heads.map((h) => h.querySelector(".ctx-deployment-label").textContent), ["This Mac", "devbox"], "the machine, no path");
  assert.deepEqual(heads.map((h) => h.querySelector(".ctx-deployment-label").title), [LOCAL.path, DEVBOX.path], "the full path only as the tooltip");
  assert.equal(heads[0].getAttribute("role"), "heading"); assert.equal(heads[0].getAttribute("aria-level"), "3");
  assert.equal(heads[0].querySelector(".deployment-mark"), null, "a live deployment carries no mark");
  const mark = heads[1].querySelector(".deployment-mark");
  assert.equal(mark.getAttribute("role"), "img"); assert.equal(mark.getAttribute("aria-label"), "remembered"); assert.equal(mark.title, "remembered");
  assert.ok(mark.querySelector("svg[aria-hidden=true]"), "the warning shape, decorative under its words");
  assert.equal(heads[0].getAttribute("aria-label"), "This Mac, 3 instances");
  assert.equal(heads[1].getAttribute("aria-label"), "devbox, remembered, 1 instance");
  assert.doesNotMatch(list.textContent, /primary/, "no primary tag");
  assert.equal(heads[1].textContent, "devbox", "one short line: no reason or note in the sidebar");
  // Order: heading, its groups and rows, then the next heading.
  const sequence = [...list.children].map((el) => el.classList.contains("ctx-deployment") ? `#${el.dataset.deployment}`
    : el.classList.contains("ctx-group") ? `group:${el.dataset.group}` : el.querySelector(".ctx-name")?.dataset.name);
  assert.deepEqual(sequence, [`#${LOCAL.id}`, "group:lead", "lead", "dev", "group:independent", "near", `#${DEVBOX.id}`, "group:independent", "far"]);
  assert.equal(list.textContent.includes("oats ·"), false, "rows never repeat the workspace name");
  const far = [...list.querySelectorAll(".ctx-tree-row")].find((r) => r.querySelector(".ctx-name").dataset.name === "far");
  // The identity line (the product owner, 2026-10-26): the soul, then the repository; the host is the heading's.
  const meta = far.querySelector(".ctx-meta.ctx-soul-repo");
  assert.deepEqual([meta.querySelector(".ctx-meta-soul").textContent, meta.querySelector(".ctx-meta-repo").textContent], ["soul", "repo"], "the identity line: soul, then repository");
  assert.equal(meta.title, "Soul: soul\nRepository: repo");
});

test("roster headings: one machine holding two deployments adds the path tail; not reached is marked in words", (t) => {
  const unreached = { ...DEVBOX, identityFrom: null };
  const list = roster(t, [row("a", LOCAL), row("b", LOCAL2), row("c", unreached)], [LOCAL, LOCAL2, unreached]);
  const heads = [...list.querySelectorAll(".ctx-deployment")];
  assert.deepEqual(heads.map((h) => h.querySelector(".ctx-deployment-label").textContent), ["This Mac · oats", "This Mac · oats-qa", "devbox"]);
  assert.deepEqual(heads.map((h) => h.querySelector(".deployment-mark")?.getAttribute("aria-label") ?? null), [null, null, "not reached"]);
  assert.equal(heads[2].getAttribute("aria-label"), "devbox, not reached, 1 instance");
  // The machine is uppercased with the group label; a path tail is case-sensitive and keeps its case.
  const doc = list.ownerDocument, style = doc.createElement("style"); style.textContent = css; doc.head.append(style);
  const win = doc.defaultView;
  assert.deepEqual(heads.map((h) => h.querySelector(".ctx-deployment-path")?.textContent ?? null), ["oats", "oats-qa", null]);
  assert.equal(win.getComputedStyle(heads[1]).textTransform, "uppercase");
  assert.equal(win.getComputedStyle(heads[1].querySelector(".ctx-deployment-path")).textTransform, "none");
  assert.equal(win.getComputedStyle(heads[1].querySelector(".ctx-deployment-path")).letterSpacing, "normal");
});

test("roster: a stale deployment (its last re-read failed) is marked in words, and its held rows' Start and actions wait as on a stale roster", (t) => {
  const stale = { ...LOCAL2, stale: true, short: "Last read failed", reason: "This deployment's last read failed: the cache is locked. It shows what was last observed." };
  assert.deepEqual(vd.deploymentState(stale), { key: "stale", text: "stale", detail: stale.reason });
  const said = [];
  const list = roster(t, [row("a", LOCAL, { running: false }), row("b", stale, { running: false })], [LOCAL, stale], said);
  const heads = [...list.querySelectorAll(".ctx-deployment")];
  assert.deepEqual(heads.map((h) => h.querySelector(".deployment-mark")?.getAttribute("aria-label") ?? null), [null, "stale"]);
  const start = (name) => [...list.querySelectorAll(".ctx-tree-row")].find((r) => r.querySelector(".ctx-name")?.dataset.name === name).querySelector(".ctx-start");
  assert.equal(start("b").getAttribute("aria-disabled"), "true", "the held row waits");
  assert.equal(start("a").hasAttribute("aria-disabled"), false, "the live deployment's row acts as before");
  // Its context menu (#1559: no ⋯ trigger) is held the same: asked, it opens nothing and says why; the live one's opens.
  assert.equal(list.querySelector(".ctx-instance-actions"), null, "no ⋯ trigger");
  const wrap = (name) => start(name).closest(".ctx-tree-row");
  const ask = (name) => wrap(name).querySelector(".ctx-inst").dispatchEvent(new list.ownerDocument.defaultView.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  ask("b");
  assert.deepEqual(said, [tree.ROSTER_STALE_TITLE]); assert.notEqual(wrap("b").querySelector(".ctx-instance-menu").dataset.instanceMenuOpen, "true");
  ask("a");
  assert.deepEqual(said, [tree.ROSTER_STALE_TITLE], "the live row's menu is not held"); assert.equal(wrap("a").querySelector(".ctx-instance-menu").dataset.instanceMenuOpen, "true");
});

test("roster headings: a deployment with no instances has no heading", (t) => {
  const list = roster(t, [row("a", LOCAL), row("b", LOCAL)], [LOCAL, DEVBOX]);
  assert.deepEqual([...list.querySelectorAll(".ctx-deployment")].map((h) => h.dataset.deployment), [LOCAL.id]);
});

test("rosterSections: a pending spawn without a deployment joins the primary; empty deployments are left out", () => {
  const rows = [row("a", LOCAL), { instance: "spawning", agent: "soul", home: "/x/spawning", pendingSpawn: {} }];
  const sections = vd.rosterSections(rows, rows, [LOCAL, DEVBOX], DESKTOP_TERMS);
  assert.deepEqual(sections.map((s) => s.deployment.id), [LOCAL.id]);
  assert.deepEqual(sections[0].groups.flatMap((g) => g.clusters.flatMap((c) => c.instances.map((i) => i.instance))), ["a", "spawning"]);
  assert.equal(vd.rosterSections(rows, rows, [LOCAL], DESKTOP_TERMS).length, 1); assert.equal(vd.rosterSections(rows, rows, [LOCAL], DESKTOP_TERMS)[0].deployment, null);
});

/* ── the workspace list ── */
function switcher(t) {
  const dom = new JSDOM(html, { url: "https://fixture.invalid" }); t.after(() => dom.window.close());
  const document = dom.window.document; mountShellIcons(document);
  const selected = [], tabRequests = [];
  t.after(onDeploymentTabRequest((request) => tabRequests.push(request)));
  const sw = createWorkspaceSwitcher({ document, selectWorkspace: (id) => selected.push(id), discoverSuggestions: async () => [], addWorkspace: async () => ({}), pickWorkspace: async () => ({}) });
  t.after(() => sw.dispose());
  const key = (key, target = document.activeElement) => target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  return { dom, document, sw, selected, tabRequests, key, options: () => [...document.querySelectorAll(".ws-option")] };
}
const SHORT = "OATS too old to report its workspace";
const views = [
  { id: "ws:aaaaaaaaaaaaaaaaaaaa", name: "oats", team: null, key: "github.com/org/oats", deployments: [LOCAL.id, DEVBOX.id],
    deploymentLabels: ["This Mac · ~/Agents/oats", "devbox · ~/Agents/web"], machines: ["This Mac", "devbox"], notLive: 1 },
  { id: "/Users/op/Agents/loose", name: "loose", team: null, deployments: ["/Users/op/Agents/loose"], unattached: true, ref: "github.com/org/loose@main",
    reason: "This deployment's workspace reference names a member whose workspace isn't known yet; run oats sync there.", short: SHORT,
    deploymentLabels: ["This Mac · ~/Agents/loose"], machines: ["This Mac"], notLive: 0 },
  { id: "ws:bbbbbbbbbbbbbbbbbbbb", name: "web", team: null, key: "github.com/org/web", deployments: ["remote:laptop:t1"], server: "laptop", remote: true,
    deploymentLabels: ["laptop · /srv/web"], machines: ["laptop"], notLive: 0 },
];
// Nothing of where a workspace is deployed or how it is: its own pages say that (pr3-simplify).
const RAW = /ws:|remote:|\/Users\/|~\/|\/srv|Server:|Reports |run oats sync|github\.com\/org\/loose|This Mac|devbox|laptop|not live|OATS too old/;

test("switcher entries: one line, the roster's circle and the name; no machine, place, other mark or state, and the tooltip is the name alone", (t) => {
  const s = switcher(t);
  s.sw.begin()(views[0], views);
  assert.equal(s.document.getElementById("ws-list").getAttribute("aria-description"), "Current workspace: oats", "the list never names a ws: id");
  const listbox = s.document.getElementById("ws-options");
  assert.deepEqual(s.options().map((o) => o.dataset.workspaceId), [views[0].id, views[2].id, views[1].id], "matched views first, then the unmatched one");
  assert.deepEqual(s.options().map((o) => o.textContent), ["oats", "web", "loose"]);
  for (const option of s.options()) {
    assert.deepEqual([...option.children].map((c) => c.className), [option.dataset.workspaceId === views[0].id ? "ctx-dot on" : "ctx-dot off", "ws-option-name"], `${option.dataset.workspaceId}: the circle, the name and nothing else`);
    assert.equal(option.title, option.textContent, "the tooltip is the whole name: never a path or machine");
    assert.doesNotMatch(`${option.textContent} ${option.title}`, RAW, option.dataset.workspaceId);
  }
  assert.equal(listbox.querySelector(".deployment-mark, .workspace-avatar, .ws-option-meta, .ws-check, .ws-option-reason, .ws-option-path"), null);
  // A deployment not live changes nothing in the list: that state is the workspace's own pages'.
  const before = listbox.innerHTML;
  views[0].notLive = 2; s.sw.begin()(views[0], views); views[0].notLive = 1;
  assert.equal(listbox.innerHTML, before);
});

test("switcher entries from an older server (no machines): the name only, never a path or id", (t) => {
  const s = switcher(t);
  const old = [{ id: "ws:cccccccccccccccccccc", name: "old", team: null, deployments: ["remote:laptop:t1", "/Users/op/x"] },
    { id: "remote:laptop:t2", name: "far", team: null, deployments: ["remote:laptop:t2"] }];
  s.sw.begin()(old[0], old);
  assert.deepEqual(s.options().map((o) => [o.textContent, o.title]), [["old", "old"], ["far", "far"]]);
  s.sw.begin()(old[1], old);
  assert.equal(s.document.getElementById("ws-list").getAttribute("aria-description"), "Current workspace: far", "a remote id is never the description");
});

test("Not matched: a row by its name in the same flat list, no heading; selecting one opens the Workspace page's Machines tab on its deployment's tab", (t) => {
  const s = switcher(t);
  s.sw.begin()(views[0], views);
  const listbox = s.document.getElementById("ws-options");
  const groups = listbox.querySelectorAll("ul");
  assert.equal(groups.length, 1, "one list"); assert.equal(groups[0].getAttribute("aria-label"), "Workspaces");
  assert.equal(groups[0].hasAttribute("aria-labelledby"), false); assert.equal(listbox.querySelector(".ws-option-section"), null, "no section heading");
  assert.doesNotMatch(listbox.textContent, /Not matched/);
  const loose = s.options().at(-1);
  assert.equal(loose.dataset.workspaceId, views[1].id); assert.equal(loose.textContent, "loose"); assert.equal(loose.title, "loose");
  s.options()[0].click();
  assert.deepEqual(s.tabRequests, [], "a matched view only switches");
  loose.click();
  assert.deepEqual(s.selected, [views[1].id], "selected as before");
  assert.deepEqual(s.tabRequests, [{ view: views[1].id, tab: views[1].deployments[0] }], "then its deployment's tab is requested");
  // A remote group is named by its server: its row is that name.
  const build = { id: "remote:build:cccccccccccc", name: "build", team: null, deployments: ["remote:build:cccccccccccc"], machines: ["build"], notLive: 0,
    unattached: true, short: SHORT, server: "build", remote: true };
  const r = switcher(t);
  r.sw.begin()(views[0], [views[0], build]);
  assert.deepEqual(r.options().map((o) => o.textContent), ["oats", "build"]);
});

test("workspace list: Arrow/Home/End walk every row, unmatched ones included; the list has no filter field", (t) => {
  const s = switcher(t);
  s.sw.begin()(views[0], views);
  assert.equal(s.document.getElementById("ws-menu-search"), null);
  s.sw.focusList(); assert.equal(s.document.activeElement.dataset.workspaceId, views[0].id, "the current row");
  s.key("End"); assert.equal(s.document.activeElement.dataset.workspaceId, views[1].id, "End reaches the unmatched row");
  s.key("ArrowUp"); assert.equal(s.document.activeElement.dataset.workspaceId, views[2].id);
  s.key("ArrowDown"); assert.equal(s.document.activeElement.dataset.workspaceId, views[1].id, "down reaches it again");
  s.key("Home"); assert.equal(s.document.activeElement.dataset.workspaceId, views[0].id);
  s.options()[0].click(); assert.deepEqual(s.selected, [], "the active view is not re-selected");
});

test("switcher labels: two choices of one name are told apart by keys, folder tails or machines, never by ids or full paths", () => {
  const twins = [{ id: "ws:1", name: "web", key: "github.com/a/web", deployments: [] }, { id: "ws:2", name: "web", key: "github.com/b/web", deployments: [] }];
  assert.deepEqual(workspaceChoiceLabels(twins), ["web — github.com/a/web", "web — github.com/b/web"]);
  assert.deepEqual(workspaceChoiceLabels([{ id: "/a/x/oats", name: "oats" }, { id: "remote:laptop:oats", name: "oats", machines: ["laptop"] }, { id: "remote:laptop:o2", name: "oats" }]),
    ["oats — x/oats", "oats — laptop", "oats"]);
  assert.deepEqual(workspaceChoiceLabels([{ id: "remote:laptop:t1" }]), ["Workspace"], "a remote id is never a name");
  assert.equal(workspaceChoicePlace({ id: "/a/b", deployments: ["/a/b"] }), "", "no machines: nothing, never the id");
  assert.equal(workspaceChoicePlace({ id: "ws:1", machines: ["This Mac", "devbox", "", 7] }), "This Mac · devbox");
});

/* ── the "On <deployment>" line ── */
test("deploymentScopeLabel: the primary's label with two or more deployments, null with one", () => {
  assert.equal(deploymentScopeLabel({ deployments: [LOCAL] }), null);
  assert.equal(deploymentScopeLabel({ deployments: [DEVBOX, { ...LOCAL, primary: true }] }), "This Mac · ~/Agents/oats");
  assert.equal(deploymentScopeLabel([{ ...DEVBOX, primary: true }, { ...LOCAL, primary: false }]), "devbox · ~/Agents/web");
  assert.equal(deploymentScopeLabel({}), null);
});

test("a deployment-level surface shows 'On <primary>' only in a view of two or more deployments, and follows the panels", (t) => {
  const dom = new JSDOM("<body></body>"); t.after(() => dom.window.close());
  const doc = dom.window.document;
  vd.notePanel({ workspace: { id: "ws:one" }, deployments: [LOCAL] });
  vd.notePanel({ workspace: { id: "ws:two" }, deployments: [LOCAL, DEVBOX] });
  const one = createDeploymentScopeLine(doc, { workspace: "ws:one" }), two = createDeploymentScopeLine(doc, { workspace: "ws:two" });
  doc.body.append(one.element, two.element);
  assert.equal(one.element.hidden, true); assert.equal(one.element.textContent, "");
  assert.equal(two.element.hidden, false); assert.equal(two.element.textContent, "On This Mac · ~/Agents/oats");
  assert.ok(doc.head.querySelector("style[data-deployment-scope]"), "its style is in the document once");
  vd.notePanel({ workspace: { id: "ws:one" }, deployments: [LOCAL, DEVBOX] });
  assert.equal(one.element.textContent, "On This Mac · ~/Agents/oats", "a view that gains a deployment gains the line");
  vd.notePanel({ workspace: { id: "ws:two" }, deployments: [LOCAL] });
  assert.equal(two.element.hidden, true);
  const byDeployment = createDeploymentScopeLine(doc, { workspace: DEVBOX.id });
  assert.equal(byDeployment.element.textContent, "On This Mac · ~/Agents/oats", "a deployment id reads the view that holds it");
  one.dispose(); two.dispose(); byDeployment.dispose();
});

// Automations names no deployment it reads (the product owner, 2026-10-23), a page of its own again since 2026-10-26.
test("Automations (and Schedules, the same view) carry no 'On <deployment>' line, even in a view of two", async (t) => {
  const dom = new JSDOM("<body><div id=host></div></body>"); t.after(() => dom.window.close());
  const doc = dom.window.document;
  const was = currentWorkspace(); t.after(() => setWorkspace(was));
  setWorkspace("ws:auto");
  vd.notePanel({ workspace: { id: "ws:auto" }, deployments: [LOCAL, DEVBOX] });
  const v = createAutomationsView(doc.getElementById("host"), { kind: "schedule", read: async () => ({ rows: [] }) });
  t.after(() => v.dispose());
  const header = doc.querySelector(".auto-header");
  assert.equal(header.nextElementSibling, doc.querySelector(".auto-body"), "the body right under the header");
  assert.equal(doc.querySelector(".deployment-scope, .auto-scope"), null);
  assert.doesNotMatch(doc.body.textContent, /On This Mac/);
  assert.doesNotMatch(automationsCSS, /auto-scope/, "no rule left for it");
});

/* ── contrast: every new text on its computed surface, in every theme ── */
function channels(hex) { assert.match(hex, /^#[0-9a-f]{6}$/i, hex); return hex.slice(1).match(/../g).map((v) => parseInt(v, 16) / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); }
const luminance = (hex) => { const c = channels(hex); return c[0] * .2126 + c[1] * .7152 + c[2] * .0722; };
const ratio = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
const painted = (win, el) => { for (let p = el; p; p = p.parentElement) { const bg = win.getComputedStyle(p).background; if (/^var\(--/.test(bg)) return bg.slice(6, -1); } return null; };

for (const name of ["light", "solarized", "dark"]) test(`${name}: roster headings and marks, workspace list entries and the scope line meet computed AA`, async (t) => {
  const dom = new JSDOM(html, { url: "https://fixture.invalid" }); t.after(() => dom.window.close());
  const doc = dom.window.document, win = dom.window; doc.documentElement.dataset.theme = name; mountShellIcons(doc);
  for (const source of [theme, css, deploymentScopeCSS, inspectorCSS]) { const style = doc.createElement("style"); style.textContent = source; doc.head.append(style); }
  const list = doc.querySelector("#instance-roster .ctx-list");
  list.append(vd.deploymentHeading(doc, { deployment: LOCAL, label: "This Mac", count: 1 }), vd.deploymentHeading(doc, { deployment: DEVBOX, label: "devbox", count: 1 }));
  const sw = createWorkspaceSwitcher({ document: doc, selectWorkspace() {}, discoverSuggestions: async () => [], addWorkspace: async () => ({}), pickWorkspace: async () => ({}) });
  t.after(() => sw.dispose());
  // The current entry (bold over an accent edge, no fill of its own since b761a2a27: --sel is the nav's current view)
  // and an inactive one, both on the sidebar's --surface: the name is all a row says.
  const marked = [views[0], views[1], views[2]];
  sw.begin()(marked[0], marked);
  // The scope line where it shows: the side panel's soul inspector, on its --surface.
  const section = doc.createElement("aside"); section.className = "soul-inspector"; doc.body.append(section);
  vd.notePanel({ workspace: { id: "ws:contrast" }, deployments: [LOCAL, DEVBOX] });
  const line = createDeploymentScopeLine(doc, { workspace: "ws:contrast" }); section.append(line.element);
  const root = win.getComputedStyle(doc.documentElement);
  const active = '.ws-option[aria-current="true"]', inactive = `.ws-option[data-workspace-id="${marked[2].id}"]`;
  const checks = [
    [".ctx-deployment-label", "muted", "surface"], [".ctx-deployment .deployment-mark", "warn", "surface"],
    [`${active} .ws-option-name`, "fg", "surface"], [`${inactive} .ws-option-name`, "fg", "surface"], [".soul-inspector > .deployment-scope", "muted", "surface"],
  ];
  for (const [selector, fg, surface] of checks) {
    const el = doc.querySelector(selector); assert.ok(el, selector);
    const color = win.getComputedStyle(el).color;
    assert.equal(color, `var(--${fg})`, selector);
    const bg = painted(win, el); assert.equal(bg, surface, `${selector} sits on --${surface}`);
    const r = ratio(root.getPropertyValue(`--${fg}`).trim(), root.getPropertyValue(`--${bg}`).trim());
    assert.ok(r >= 4.5, `${selector}: ${fg} on ${bg} is ${r.toFixed(2)}:1`);
    for (let p = el; p; p = p.parentElement) assert.equal(win.getComputedStyle(p).opacity, "1", `${selector}: no opacity over text`);
  }
  // Hover paints --surface-2 under an entry, and keyboard focus --sel: its name holds on both.
  for (const fill of ["surface-2", "sel"]) assert.ok(ratio(root.getPropertyValue("--fg").trim(), root.getPropertyValue(`--${fill}`).trim()) >= 4.5, `fg on ${fill}`);
  line.dispose();
});
