// Workspace views (#482): nothing saved is dropped. Per-workspace state keyed by a deployment id (a
// local path, `remote:<server>:<target>`) — the selection, the tab layout memory, the active-terminal
// memory, open terminal/view/file tabs, collapsed rows and stored spawn jobs — moves to the view that
// holds that deployment now; a remote that reports another workspace takes its terminals with it; a
// deployment that never reports keeps its own view and nothing moves. Pure module tests, then the
// shipped shell functions run in a vm context against a scripted /api/panel.
import test from "node:test";
import { createInstanceRecency, recencyIdFromTerminalKey } from "../renderer/instance-recency.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { withShellWindowGlobals } from './helpers/shell-window-globals.mjs';
import { JSDOM } from "jsdom";
import * as common from "../renderer/views/common.mjs";
import { createViewMembership, rehomeMap, rehomeKey, rehomeTabs, rehomeActiveTerminals, rehomeCollapsed, tabTarget } from "../renderer/workspace-rehome.mjs";
import { createWorkspaceTabMemory } from "../renderer/workspace-tab-memory.mjs";
import { createSpawnJobs, SPAWN_STORAGE_KEY } from "../renderer/spawn-jobs.mjs";
import { rosterResponseOwns, rosterSignature, terminalKey } from "../renderer/instance-tree-view.mjs";
import { collapseKey } from "../../client/instance-tree.mjs";
import { removeSplitTab } from "../renderer/split-layout.mjs";
import { createPendingWatch, NOT_SERVED_CODE, NO_ANSWER_CODE } from "../renderer/deployment-header.mjs";
import { createWorkspaceSwitcher } from "../renderer/workspace-switcher.mjs";
import { mountShellIcons } from "../renderer/shell-icons.mjs";
import { viewContext } from "./helpers/view-context.mjs";

const PATH = "/Users/op/Agents/oats", REMOTE = "remote:devbox:web-1", LOOSE = "remote:laptop:v1";
const VIEW = "ws:0123456789abcdef0123", OTHER = "ws:fedcba9876543210fedc";
const served = (...views) => views;
const view = (id, deployments, extra = {}) => ({ id, name: id.startsWith("ws:") ? "oats" : id, team: null, deployments, ...extra });

test("rehomeMap: each deployment id a view holds maps to that view; a never-reporting group and served view ids never move", () => {
  const list = served(view(VIEW, [PATH, REMOTE]), view(LOOSE, [LOOSE], { unattached: true }));
  const map = rehomeMap(list);
  assert.deepEqual([...map], [[PATH, VIEW], [REMOTE, VIEW]]);
  assert.equal(map.has(LOOSE), false, "its view id IS its deployment id: nothing moves");
  assert.equal(map.has(VIEW), false);
  assert.equal(rehomeMap([]).size, 0); assert.equal(rehomeMap(undefined).size, 0);
});

test("rehomeMap: a view id no longer served follows its deployments when ONE view holds them now, never when they split", () => {
  const membership = createViewMembership();
  membership.note([view(OTHER, [REMOTE]), view(VIEW, [PATH])]);
  assert.equal(membership.name(OTHER), "oats");
  assert.equal(rehomeMap([view(VIEW, [PATH, REMOTE])], membership).get(OTHER), VIEW, "its remote now reports the other workspace");
  membership.note([view("ws:gone", [PATH, REMOTE])]);
  assert.equal(rehomeMap([view(VIEW, [PATH]), view(OTHER, [REMOTE])], membership).has("ws:gone"), false, "split across views: tabs follow their own deployments");
});

test("rehomeKey: terminal and view/file keys move with their workspace; other keys stay", () => {
  assert.equal(rehomeKey(terminalKey(PATH, "/h/dev"), PATH, VIEW), terminalKey(VIEW, "/h/dev"));
  assert.equal(rehomeKey(`term:${REMOTE}:server:devbox\u0000/h/x`, REMOTE, VIEW), `term:${VIEW}:server:devbox\u0000/h/x`);
  assert.equal(rehomeKey(JSON.stringify([PATH, "view:brain"]), PATH, VIEW), JSON.stringify([VIEW, "view:brain"]));
  assert.equal(rehomeKey(JSON.stringify([OTHER, "file:/a"]), PATH, VIEW), JSON.stringify([OTHER, "file:/a"]), "another workspace's key stays");
  assert.equal(rehomeKey("picked-file:3", PATH, VIEW), "picked-file:3");
  assert.equal(rehomeKey("[not json", PATH, VIEW), "[not json");
});

test("rehomeTabs: tabs under a deployment id move with their keys; a terminal follows its instance's deployment to another view", () => {
  const tabs = new Map([
    [1, { kind: "terminal", workspace: PATH, key: terminalKey(PATH, "/h/a"), instanceRef: { instance: "a" } }],
    [2, { kind: "file", workspace: PATH, key: JSON.stringify([PATH, "file:/x.md"]) }],
    [3, { kind: "terminal", workspace: VIEW, key: terminalKey(VIEW, "/h/far"), instanceRef: { instance: "far", deployment: { id: REMOTE } } }],
    [4, { kind: "terminal", workspace: VIEW, key: terminalKey(VIEW, "/h/near"), instanceRef: { instance: "near", deployment: { id: PATH } } }],
    [5, { kind: "terminal", workspace: LOOSE, key: terminalKey(LOOSE, "/h/l"), instanceRef: { instance: "l", deployment: { id: LOOSE } } }],
  ]);
  const list = served(view(VIEW, [PATH]), view(OTHER, [REMOTE]), view(LOOSE, [LOOSE], { unattached: true }));
  const moves = rehomeTabs(tabs, rehomeMap(list), list);
  assert.deepEqual(moves.map(({ id, from, to }) => [id, from, to]), [[1, PATH, VIEW], [2, PATH, VIEW], [3, VIEW, OTHER]]);
  assert.equal(tabs.get(1).key, terminalKey(VIEW, "/h/a")); assert.equal(tabs.get(2).key, JSON.stringify([VIEW, "file:/x.md"]));
  assert.equal(tabs.get(3).workspace, OTHER); assert.equal(tabs.get(3).key, terminalKey(OTHER, "/h/far"));
  assert.equal(tabs.get(4).workspace, VIEW, "a row of this view stays"); assert.equal(tabs.get(5).workspace, LOOSE, "a group that never reports stays");
  assert.equal(tabTarget({ kind: "brain", workspace: VIEW, instanceRef: { deployment: { id: REMOTE } } }, new Map(), list), null, "only terminals follow a row");
});

test("rehomeActiveTerminals and rehomeCollapsed: memories move, the view's own newer entry is kept", () => {
  const memory = new Map([[PATH, terminalKey(PATH, "/h/a")], [REMOTE, terminalKey(REMOTE, "/h/r")], [VIEW, terminalKey(VIEW, "/h/v")]]);
  rehomeActiveTerminals(memory, new Map([[PATH, OTHER], [REMOTE, VIEW]]));
  assert.deepEqual([...memory], [[VIEW, terminalKey(VIEW, "/h/v")], [OTHER, terminalKey(OTHER, "/h/a")]]);
  const followed = new Map([[VIEW, terminalKey(VIEW, "/h/far")]]);
  rehomeActiveTerminals(followed, new Map(), [{ id: 3, from: VIEW, to: OTHER, fromKey: terminalKey(VIEW, "/h/far"), key: terminalKey(OTHER, "/h/far") }]);
  assert.deepEqual([...followed], [[OTHER, terminalKey(OTHER, "/h/far")]], "the memory follows a moved terminal");
  const collapsed = new Set([collapseKey(PATH, "/h/a"), collapseKey(VIEW, "/h/b")]);
  rehomeCollapsed(collapsed, new Map([[PATH, VIEW]]));
  assert.deepEqual([...collapsed].sort(), [collapseKey(VIEW, "/h/a"), collapseKey(VIEW, "/h/b")].sort());
});

test("workspace tab memory: a layout remembered under a deployment id is recalled under its view", () => {
  const memory = createWorkspaceTabMemory();
  const tabs = new Map([[7, { kind: "terminal", workspace: PATH }]]);
  // The focus place (focus-place.mjs) the workspace was left with moves with its layout.
  const place = { kind: "tab", tab: 7, content: true, handle: null };
  memory.remember(PATH, { split: null, activeTab: 7, sidebarMode: "instances", tabLayerVisible: true, place });
  memory.remember(VIEW, { split: null, activeTab: null, sidebarMode: "overview", tabLayerVisible: false });
  memory.remember(REMOTE, { split: null, activeTab: 9, sidebarMode: "instances", tabLayerVisible: true });
  memory.rehome(new Map([[PATH, OTHER], [REMOTE, VIEW]]));
  tabs.get(7).workspace = OTHER;
  assert.deepEqual(memory.recall(OTHER, tabs), { split: null, activeTab: 7, sidebarMode: "instances", tabLayerVisible: true, place });
  assert.equal(memory.recall(VIEW, tabs).place, null, "the view's own memory keeps its own place (none)");
  assert.equal(memory.recall(VIEW, tabs).sidebarMode, "overview", "the view's own memory is kept");
  assert.equal(memory.recall(PATH, tabs).activeTab, null, "nothing left under the old id");
});

const memoryStorage = (seed) => { const m = new Map(seed ? [[SPAWN_STORAGE_KEY, JSON.stringify(seed)]] : []); return { getItem: (k) => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), raw: () => m.get(SPAWN_STORAGE_KEY) ?? null }; };

test("spawn jobs stored before views come back, move to the view, and stay addressed to their deployment", async () => {
  const storage = memoryStorage([{ workspace: PATH, spawnRef: "a".repeat(64), soul: { name: "dev", agentsRoot: `${PATH}/agents` }, selector: { soul: "dev", agentsRoot: `${PATH}/agents` },
    instance: "dev-1", home: `${PATH}/agents/dev/instances/dev-1`, placement: {}, startedAt: 1 }]);
  const posts = [];
  const jobs = createSpawnJobs({ storage, post: (ws, body) => { posts.push([ws, body.action]); return new Promise(() => {}); }, notify: () => false, currentWorkspace: () => VIEW });
  assert.equal(jobs.recover(), 1);
  assert.deepEqual(jobs.rows(PATH).map((r) => [r.instance, r.deployment?.id]), [["dev-1", PATH]]);
  assert.equal(jobs.rehome(new Map([[PATH, VIEW]])), 1);
  assert.deepEqual(jobs.rows(PATH), []); assert.deepEqual(jobs.rows(VIEW).map((r) => r.instance), ["dev-1"], "the view's roster shows it");
  assert.deepEqual(posts, [[PATH, "result"]], "its transaction is still read from its deployment");
  const kept = JSON.parse(storage.raw());
  assert.deepEqual(kept.map((e) => [e.workspace, e.deployment]), [[VIEW, PATH]], "a reload keeps both");
  jobs.dispose();
});

/* ── the shipped shell functions ── */
const source = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
const fn = (name) => { const found = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`)); assert.ok(found, name); return found[0]; };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function shell(t, { tabs = new Map(), memory = new Map(), selection, claim = { ok: true } }) {
  const dom = new JSDOM(html, { url: "https://fixture.invalid" }); t.after(() => dom.window.close());
  const document = dom.window.document; mountShellIcons(document);
  common.setWorkspace(selection);
  const requests = [], switched = [], storage = memoryStorage();
  const spawnJobs = createSpawnJobs({ storage, post: () => new Promise(() => {}), notify: () => false, currentWorkspace: common.currentWorkspace });
  t.after(() => spawnJobs.dispose());
  const c = {
    document, contextRosterGen: 0, contextWorkspace: selection, contextInstances: [], tabWorkspace: selection,
    rosterState: null, rosterStale: false, contextDeploymentNote: null, ...viewContext(), rosterSignaturePainted: null, rosterSignature,
    rosterPendingWatch: createPendingWatch(), NOT_SERVED_CODE, NO_ANSWER_CODE, failRosterUnserved() {}, connectionGeneration: 0,
    currentWorkspace: common.currentWorkspace, adoptWorkspace: common.adoptWorkspace, staleWorkspaceSelection: common.staleWorkspaceSelection, rosterResponseOwns,
    // One window per workspace (#481): the switch main binds; `claim` is main's answer.
    switchWorkspace: async (id, options) => { switched.push(id); c.switchOptions = options; if (claim.ok) common.setWorkspace(id); return claim; },
    chooseWorkspace: async (workspaces) => { c.chose = workspaces; },
    contextRosterEl: document.getElementById("instance-roster"),
    api(path) { const gate = { ...deferred(), path }; requests.push(gate); return gate.promise; },
    renderContextRoster() {}, refreshPanelInstance() {}, rosterPrs: { get: () => null, refresh() {} }, spawnJobs,
    workspaceLabel: createWorkspaceSwitcher({ document, selectWorkspace() {}, discoverSuggestions: async () => [], addWorkspace: async () => ({}), pickWorkspace: async () => ({}) }),
    // Re-homing's own state.
    tabs, activeTab: null, split: null, tabLayerVisible: false,
    // The palette's last-focus record (Spec C), inert here: the shell code under test writes to it.
    instanceRecency: createInstanceRecency({ storage: null }), recencyIdFromTerminalKey,
    wsActiveTerminal: memory, workspaceTabMemory: createWorkspaceTabMemory(), collapsedInstances: new Set(),
    rehomeTabs, rehomeActiveTerminals, rehomeCollapsed, removeSplitTab, updated: 0,
    updateContextTabs() { c.updated++; }, showTerminalContext() { c.contextShown = true; }, activateTab() {},
  };
  const s = runInNewContext(`${["followView", "refreshContextRoster", "rehomeWorkspaceState"].map(fn).join("\n")}\n({ refreshContextRoster, rehomeWorkspaceState });`, withShellWindowGlobals(c));
  return { c, s, requests, switched, storage, document };
}

for (const [label, saved] of [["a local path", PATH], ["a remote group id", REMOTE]]) test(`shell: ${label} saved before views opens its view, with its tabs, memories and spawn jobs`, async (t) => {
  const tabs = new Map([
    [1, { kind: "terminal", workspace: saved, key: terminalKey(saved, "/h/dev"), instanceRef: { instance: "dev" } }],
    [2, { kind: "brain", workspace: saved, key: JSON.stringify([saved, "view:brain"]) }],
  ]);
  const u = shell(t, { tabs, memory: new Map([[saved, terminalKey(saved, "/h/dev")]]), selection: saved });
  u.c.workspaceTabMemory.remember(saved, { split: null, activeTab: 1, sidebarMode: "instances", tabLayerVisible: true });
  u.c.collapsedInstances.add(collapseKey(saved, "/h/dev"));
  u.c.spawnJobs.submit({ token: {}, workspace: saved, soul: { name: "dev" }, selector: { soul: "dev" }, input: { action: "prepare" }, decision: { instance: "dev-2", home: "/h/dev-2" } });
  const reading = u.s.refreshContextRoster();
  assert.equal(u.requests[0].path, `/api/panel?ws=${encodeURIComponent(saved)}`, "asked for the saved deployment id");
  const deployments = [{ id: PATH, machine: "This Mac", path: PATH, label: "~/Agents/oats", local: true, reachable: true, identityFrom: "reported", primary: true },
    { id: REMOTE, machine: "devbox", path: "/home/op/web", label: "~/web", local: false, reachable: true, identityFrom: "reported", primary: false }];
  u.requests[0].resolve({ workspace: { id: VIEW, name: "oats" }, workspaces: [view(VIEW, [PATH, REMOTE])], deployments, instances: [] });
  await reading;
  assert.equal(common.currentWorkspace(), VIEW, "the view id is adopted (stale-selection adoption)");
  assert.equal(u.c.tabWorkspace, VIEW); assert.equal(u.c.contextWorkspace, VIEW);
  assert.deepEqual([...tabs.values()].map((tab) => [tab.workspace, tab.key]),
    [[VIEW, terminalKey(VIEW, "/h/dev")], [VIEW, JSON.stringify([VIEW, "view:brain"])]], "open tabs open in the view");
  assert.deepEqual([...u.c.wsActiveTerminal], [[VIEW, terminalKey(VIEW, "/h/dev")]]);
  assert.equal(u.c.workspaceTabMemory.recall(VIEW, tabs).activeTab, 1, "its tab memory is the view's");
  assert.deepEqual([...u.c.collapsedInstances], [collapseKey(VIEW, "/h/dev")]);
  assert.deepEqual(u.c.spawnJobs.rows(VIEW).map((r) => [r.instance, r.deployment?.id]), [["dev-2", saved]], "a spawn job moves, its address stays");
  assert.equal(u.c.updated, 1, "the tab strip is re-projected once");
  assert.deepEqual(u.c.contextDeployments.map((d) => d.id), [PATH, REMOTE], "the roster learns the view's deployments");
  assert.deepEqual(u.switched, [], "an adoption, not a switch");
});

test("shell: a remote that reports another workspace takes its terminal to that view; this view keeps the rest", async (t) => {
  const tabs = new Map([
    [1, { kind: "terminal", workspace: VIEW, key: terminalKey(VIEW, "/h/far"), instanceRef: { instance: "far", deployment: { id: REMOTE } } }],
    [2, { kind: "terminal", workspace: VIEW, key: terminalKey(VIEW, "/h/near"), instanceRef: { instance: "near", deployment: { id: PATH } } }],
  ]);
  const u = shell(t, { tabs, memory: new Map([[VIEW, terminalKey(VIEW, "/h/far")]]), selection: VIEW });
  Object.assign(u.c, { split: { groups: [{ id: 1, tabs: [1, 2], activeTab: 1 }], focusedGroup: 1, orientation: "row" }, activeTab: 1, tabLayerVisible: true });
  const reading = u.s.refreshContextRoster();
  u.requests[0].resolve({ workspace: { id: VIEW, name: "oats" }, workspaces: [view(VIEW, [PATH]), view(OTHER, [REMOTE], { name: "web" })], instances: [] });
  await reading;
  assert.deepEqual([...tabs.values()].map((tab) => tab.workspace), [OTHER, VIEW]);
  assert.equal(tabs.get(1).key, terminalKey(OTHER, "/h/far"));
  assert.deepEqual([...u.c.wsActiveTerminal], [[OTHER, terminalKey(OTHER, "/h/far")]], "its memory goes with it");
  assert.deepEqual(u.c.split.groups.flatMap((g) => g.tabs), [2], "it leaves this window's layout");
  assert.equal(u.c.contextShown, true, "the active terminal left: this view shows its own terminals");
  assert.equal(common.currentWorkspace(), VIEW, "the window stays on its view");
});

test("shell: a group that never reports keeps its own view; nothing moves", async (t) => {
  const tabs = new Map([[1, { kind: "terminal", workspace: LOOSE, key: terminalKey(LOOSE, "/h/l"), instanceRef: { instance: "l", deployment: { id: LOOSE } } }]]);
  const u = shell(t, { tabs, memory: new Map([[LOOSE, terminalKey(LOOSE, "/h/l")]]), selection: LOOSE });
  const reading = u.s.refreshContextRoster();
  u.requests[0].resolve({ workspace: { id: LOOSE, name: "laptop", remote: true, server: "laptop" }, workspaces: [view(VIEW, [PATH]), view(LOOSE, [LOOSE], { unattached: true })], instances: [] });
  await reading;
  assert.equal(common.currentWorkspace(), LOOSE);
  assert.deepEqual([...tabs.values()].map((tab) => [tab.workspace, tab.key]), [[LOOSE, terminalKey(LOOSE, "/h/l")]]);
  assert.deepEqual([...u.c.wsActiveTerminal], [[LOOSE, terminalKey(LOOSE, "/h/l")]]);
  assert.equal(u.c.updated, 0);
});

test("shell: an unattached deployment that matches later moves its view's state to the matched view", async (t) => {
  const tabs = new Map([[1, { kind: "terminal", workspace: REMOTE, key: terminalKey(REMOTE, "/h/r"), instanceRef: { instance: "r", deployment: { id: REMOTE } } }]]);
  const u = shell(t, { tabs, selection: REMOTE });
  const first = u.s.refreshContextRoster();
  u.requests[0].resolve({ workspace: { id: REMOTE, name: "devbox" }, workspaces: [view(VIEW, [PATH]), view(REMOTE, [REMOTE], { unattached: true })], instances: [] });
  await first;
  assert.equal(tabs.get(1).workspace, REMOTE, "unattached: its own view");
  const second = u.s.refreshContextRoster();
  u.requests[1].resolve({ workspace: { id: VIEW, name: "oats" }, workspaces: [view(VIEW, [PATH, REMOTE])], instances: [] });
  await second;
  assert.equal(common.currentWorkspace(), VIEW, "the deployment id is stale now: its view is adopted");
  assert.deepEqual([tabs.get(1).workspace, tabs.get(1).key], [VIEW, terminalKey(VIEW, "/h/r")]);
});

test("shell: a selected view that is no longer served follows its deployments to the view that holds them", async (t) => {
  const tabs = new Map([[1, { kind: "terminal", workspace: OTHER, key: terminalKey(OTHER, "/h/far"), instanceRef: { instance: "far", deployment: { id: REMOTE } } }]]);
  const u = shell(t, { tabs, selection: OTHER });
  u.c.viewMembership.note([view(OTHER, [REMOTE], { name: "web" })]);
  const reading = u.s.refreshContextRoster();
  u.requests[0].reject(Object.assign(new Error("not served"), { code: NOT_SERVED_CODE }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(u.requests[1].path, "/api/panel", "the served list is read");
  u.requests[1].resolve({ workspace: { id: VIEW, name: "oats" }, workspaces: [view(VIEW, [PATH, REMOTE])], instances: [] });
  await reading;
  assert.deepEqual(u.switched, [VIEW], "the window follows its deployments");
  assert.deepEqual({ ...u.c.switchOptions }, { focus: false, focusPlace: false }, "through main, focusing nothing (#481), the keyboard left where it is");
  assert.deepEqual([tabs.get(1).workspace, tabs.get(1).key], [VIEW, terminalKey(VIEW, "/h/far")]);
  assert.equal(u.c.tabWorkspace, VIEW, "the live layout is remembered under the view it moved to");
});

test("shell: a view that moved to a workspace another window has leaves this window choosing, its tabs kept (#481)", async (t) => {
  const tabs = new Map([[1, { kind: "terminal", workspace: OTHER, key: terminalKey(OTHER, "/h/far"), instanceRef: { instance: "far", deployment: { id: REMOTE } } }]]);
  const choices = [view(VIEW, [PATH, REMOTE])];
  const u = shell(t, { tabs, selection: OTHER, claim: { ok: false, code: "open-elsewhere", workspaces: choices } });
  u.c.viewMembership.note([view(OTHER, [REMOTE], { name: "web" })]);
  const reading = u.s.refreshContextRoster();
  u.requests[0].reject(Object.assign(new Error("not served"), { code: NOT_SERVED_CODE }));
  await new Promise((resolve) => setImmediate(resolve));
  u.requests[1].resolve({ workspace: { id: VIEW, name: "oats" }, workspaces: choices, instances: [] });
  await reading; await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(u.switched, [VIEW]);
  assert.equal(u.c.chose, choices, "this window chooses, with main's choices");
  assert.equal(tabs.size, 1, "its tab stays in this window (never duplicated into the other)");
  assert.equal(common.currentWorkspace(), OTHER, "nothing switched here");
});

/* ── composed with main's shipped api handler (#481, review F1) ── */
import { shippedMainApi } from "./helpers/shipped-main-api.mjs";
import { httpError } from "../renderer/views/common.mjs";

for (const [label, claim] of [["the destination is free", { ok: true, workspace: VIEW }],
  ["the destination is open in another window", { ok: false, code: "open-elsewhere", workspaces: [view(VIEW, [PATH, REMOTE])] }]]) {
  test(`shell + main: a bound view the server dropped finds the view holding its deployments (${label})`, async (t) => {
    const served = [view(VIEW, [PATH, REMOTE])];
    // Main: this window is bound to OTHER, which the server no longer serves; VIEW holds its deployment now.
    const main = shippedMainApi({ window: OTHER, advertised: new Set([VIEW, PATH, REMOTE]), reread: new Set([VIEW, PATH, REMOTE]), served });
    const tabs = new Map([[1, { kind: "terminal", workspace: OTHER, key: terminalKey(OTHER, "/h/far"), instanceRef: { instance: "far", deployment: { id: REMOTE } } }]]);
    const u = shell(t, { tabs, selection: OTHER, claim });
    u.c.api = async (path) => { const r = await main.call(path); if (!r.ok) throw httpError(r, path); return r.body; };
    u.c.viewMembership.note([view(OTHER, [REMOTE], { name: "web" })]);
    await u.s.refreshContextRoster();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(main.fetched, [], "main refused the read: nothing about another workspace was fetched");
    assert.deepEqual(u.switched, [VIEW], "the window claims the view that holds its deployment, from the refusal's choices");
    assert.deepEqual({ ...u.c.switchOptions }, { focus: false, focusPlace: false });
    if (claim.ok) assert.equal(tabs.get(1).workspace, VIEW, "its tabs move with it");
    else { assert.ok(u.c.chose, "open elsewhere: this window chooses"); assert.equal(tabs.size, 1, "its tab stays here"); }
  });
}
