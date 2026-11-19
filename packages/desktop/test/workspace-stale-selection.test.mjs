// A persisted workspace selection the server no longer serves (a deleted
// deployment) must not lock the operator out: both roster paths adopt the
// served workspace, exactly like an empty selection. A served selection
// answered with a different workspace stays a refused mismatch.
import test from "node:test";
import { viewContext } from "./helpers/view-context.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { withShellWindowGlobals } from './helpers/shell-window-globals.mjs';
import { JSDOM } from "jsdom";
import { createPendingWatch, NOT_SERVED_CODE, NO_ANSWER_CODE } from "../renderer/deployment-header.mjs";

// The stored selection is read once at module load: seed persistence BEFORE
// the first import of common.mjs so the stale id is the initial selection and
// the adoption's persistence is observable.
const WS_KEY = "oats.desktop.ws";
const GONE = "/Users/op/OATS-workspace";
const store = new Map([[WS_KEY, GONE]]);
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)); },
  removeItem: (key) => { store.delete(key); },
};
const stored = () => store.get(WS_KEY);

const common = await import("../renderer/views/common.mjs");
const hier = await import("../renderer/views/hierarchy.mjs");
const { rosterResponseOwns, rosterSignature } = await import("../renderer/instance-tree-view.mjs");
const { createWorkspaceSwitcher } = await import("../renderer/workspace-switcher.mjs");
const { mountShellIcons } = await import("../renderer/shell-icons.mjs");

const SERVED = { id: "/Users/op/OATS", name: "OATS" };
const OTHER = { id: "/Users/op/other", name: "other" };
const REMOTE = { id: "remote:builder", name: "builder", server: "builder", remote: true };
const MISMATCH = "The roster reply belongs to a different workspace. Choose the workspace again.";
const reply = (workspace, workspaces, instance = "served-1") => ({
  instances: [{ instance, running: true }], workspace, workspaces,
});

test("staleWorkspaceSelection: stale only when non-empty and absent from the served choices", () => {
  const stale = common.staleWorkspaceSelection;
  assert.equal(stale(GONE, { workspace: SERVED, workspaces: [SERVED, OTHER] }), true);
  assert.equal(stale(GONE, { workspace: SERVED, workspaces: [SERVED] }), true, "a single served workspace still decides");
  assert.equal(stale("", { workspace: SERVED, workspaces: [SERVED] }), false, "empty is not stale, it is empty");
  assert.equal(stale(OTHER.id, { workspace: SERVED, workspaces: [SERVED, OTHER] }), false, "a served choice is a real mismatch");
  assert.equal(stale(SERVED.id, { workspace: SERVED, workspaces: [SERVED] }), false, "the served id itself");
  assert.equal(stale(SERVED.id, { workspace: SERVED, workspaces: [OTHER] }), false, "panel.workspace counts as served even when the list omits it");
  assert.equal(stale(REMOTE.id, { workspace: SERVED, workspaces: [SERVED, REMOTE] }), false, "a remote choice is served");
  assert.equal(stale(GONE, { workspace: REMOTE, workspaces: [SERVED, REMOTE] }), true, "a remote reply resolves a stale selection too");
  assert.equal(stale(GONE, { workspace: SERVED, workspaces: [] }), false, "an empty list decides nothing");
  assert.equal(stale(GONE, { workspace: SERVED }), false, "a missing list (older server) decides nothing");
  assert.equal(stale(GONE, { workspace: SERVED, workspaces: [null, { name: "no id" }] }), true, "malformed entries never match");
});

test("staleWorkspaceSelection (#482): a deployment id saved before views is stale once a view holds it, so its view is adopted", () => {
  const stale = common.staleWorkspaceSelection;
  const view = { id: "ws:0123456789abcdef0123", name: "oats", deployments: ["/Users/op/Agents/oats", "remote:devbox:web-1"] };
  const loose = { id: "remote:laptop:x", name: "laptop", deployments: ["remote:laptop:x"], unattached: true };
  assert.equal(stale("/Users/op/Agents/oats", { workspace: view, workspaces: [view, loose] }), true, "a local path answered with its view");
  assert.equal(stale("remote:devbox:web-1", { workspace: view, workspaces: [view, loose] }), true, "a remote group answered with its view");
  assert.equal(stale(view.id, { workspace: view, workspaces: [view, loose] }), false, "the view id itself");
  assert.equal(stale(loose.id, { workspace: loose, workspaces: [view, loose] }), false, "an unattached view's id IS its deployment id: nothing moves");
  assert.equal(stale(loose.id, { workspace: view, workspaces: [view, loose] }), false, "a served unattached view answered with another view stays a mismatch");
});

/* ── hierarchy refresh: the shipped view mounted in JSDOM ── */
function hierarchyView(t) {
  const dom = new JSDOM(`<div id="root"></div>`, { pretendToBeVisual: true });
  const g = globalThis;
  const prev = { window: g.window, document: g.document };
  g.window = dom.window; g.document = dom.window.document;
  const gate = [];
  const ctx = { hasWorkspaceSwitcher: true, api: (pathname) => new Promise((ok) => gate.push({ pathname, ok })), openTerminal() {} };
  const el = dom.window.document.getElementById("root");
  const un = hier.mount(el, ctx);            // mount issues request 0
  t.after(() => { un(); dom.window.close(); g.window = prev.window; g.document = prev.document; });
  const respond = async (index, data) => { gate[index].ok({ ok: true, status: 200, json: async () => data }); await new Promise((r) => setTimeout(r, 20)); };
  const notice = () => (el.querySelector(".hier-notice").hidden ? "" : el.querySelector(".hier-notice-message").textContent);
  const nodes = () => [...el.querySelectorAll("[role=treeitem]")].map((n) => n.textContent).join(" ");
  const summary = () => el.querySelector(".hier-sum").textContent;
  return { el, gate, respond, notice, nodes, summary };
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("hierarchy: a stale stored selection adopts the served workspace, renders its roster and persists the id", async (t) => {
  assert.equal(common.currentWorkspace(), GONE, "the seeded stale selection is the initial one");
  const { gate, respond, notice, nodes, summary } = hierarchyView(t);
  assert.match(gate[0].pathname, new RegExp(`ws=${escapeRe(encodeURIComponent(GONE))}`), "the request still asks for the stored selection");
  await respond(0, reply(SERVED, [SERVED, OTHER]));
  assert.match(nodes(), /served-1/, "the served roster is painted");
  assert.match(summary(), /1.*running/);
  assert.equal(notice(), "", "no different-workspace refusal");
  assert.equal(common.currentWorkspace(), SERVED.id, "the selection is the served id");
  assert.equal(stored(), SERVED.id, "and it is persisted");
});

test("hierarchy: a served selection answered with another workspace is still refused", async (t) => {
  common.setWorkspace(OTHER.id);
  const { respond, notice, nodes, summary } = hierarchyView(t);
  await respond(0, reply(SERVED, [SERVED, OTHER], "foreign"));
  assert.doesNotMatch(nodes(), /foreign/, "a foreign roster never paints over an explicit selection");
  assert.equal(summary(), "Roster unknown");
  assert.equal(notice(), `Roster unavailable: ${MISMATCH}. No current observation.`, "the existing refusal, verbatim");
  assert.equal(common.currentWorkspace(), OTHER.id, "the explicit selection stands");
  assert.equal(stored(), OTHER.id);
});

test("hierarchy: without a served list nothing is guessed (existing refusal, selection kept)", async (t) => {
  for (const workspaces of [undefined, []]) {
    common.setWorkspace(GONE);
    const { respond, notice, nodes } = hierarchyView(t);
    await respond(0, { instances: [{ instance: "x", running: true }], workspace: SERVED, ...(workspaces ? { workspaces } : {}) });
    assert.doesNotMatch(nodes(), /\bx\b/);
    assert.match(notice(), /different workspace/);
    assert.equal(common.currentWorkspace(), GONE, `list ${JSON.stringify(workspaces)}: not adopted`);
    assert.equal(stored(), GONE);
  }
});

test("hierarchy: a stored id equal to the served id is neither stale nor a mismatch", async (t) => {
  common.setWorkspace(SERVED.id);
  const { respond, notice, nodes } = hierarchyView(t);
  await respond(0, reply(SERVED, [SERVED]));
  assert.match(nodes(), /served-1/);
  assert.equal(notice(), "");
  assert.equal(common.currentWorkspace(), SERVED.id);
});

test("hierarchy: a switch in flight wins over a late stale-selection reply (generation guard unchanged)", async (t) => {
  common.setWorkspace(GONE);
  const { gate, respond, nodes, notice } = hierarchyView(t);
  common.setWorkspace(OTHER.id);            // the operator picks a real workspace meanwhile: request 1
  assert.equal(gate.length, 2);
  await respond(1, reply(OTHER, [SERVED, OTHER], "other-1"));
  assert.match(nodes(), /other-1/);
  await respond(0, reply(SERVED, [SERVED, OTHER], "served-1"));   // the stale-selection reply lands after the switch
  assert.match(nodes(), /other-1/);
  assert.doesNotMatch(nodes(), /served-1/, "the older generation never paints");
  assert.equal(notice(), "");
  assert.equal(common.currentWorkspace(), OTHER.id, "and never adopts over the switch");
  assert.equal(stored(), OTHER.id);
});

test("hierarchy: a remote served workspace resolves a stale selection", async (t) => {
  common.setWorkspace(GONE);
  const { respond, notice, nodes } = hierarchyView(t);
  await respond(0, reply(REMOTE, [REMOTE], "remote-1"));
  assert.match(nodes(), /remote-1/);
  assert.equal(notice(), "");
  assert.equal(common.currentWorkspace(), REMOTE.id);
});

/* ── shell context-panel roster ── */
const source = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
const fn = (name) => {
  const found = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(found, `exercise shipped ${name}`);
  return found[0];
};
function shellRoster(t) {
  const dom = new JSDOM(html, { url: "https://fixture.invalid" });
  t.after(() => dom.window.close());
  const document = dom.window.document;
  mountShellIcons(document);
  const requests = [], rendered = [], selected = [];
  const c = {
    document, contextRosterGen: 0, contextWorkspace: "", contextInstances: [], tabWorkspace: common.currentWorkspace(),
    rosterState: null, rosterStale: false, contextDeploymentNote: null, ...viewContext(), rosterSignaturePainted: null, rosterSignature, rosterPendingWatch: createPendingWatch(), NOT_SERVED_CODE, NO_ANSWER_CODE, failRosterUnserved: assert.fail, tabs: new Map(), activeTab: null, connectionGeneration: 0,
    currentWorkspace: common.currentWorkspace, adoptWorkspace: common.adoptWorkspace,
    staleWorkspaceSelection: common.staleWorkspaceSelection, rosterResponseOwns,
    contextRosterEl: document.getElementById("instance-roster"),
    api(path) { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); requests.push({ path, resolve, reject }); return promise; },
    renderContextRoster(instances) { rendered.push(instances.map((i) => i.instance)); },
    refreshPanelInstance() {}, rosterPrs: { get: () => null, refresh() {} }, spawnJobs: { rows: () => [], announce: () => false, observe() {}, settling: () => false, check() {} },
    workspaceLabel: createWorkspaceSwitcher({ document, selectWorkspace: (id) => selected.push(id), discoverSuggestions: async () => [], addWorkspace: async () => ({}), pickWorkspace: async () => ({}) }),
  };
  const s = runInNewContext(`${fn("refreshContextRoster")}\n({ refreshContextRoster });`, withShellWindowGlobals(c));
  return { c, s, document, requests, rendered, selected };
}

test("shell roster: a stale stored selection adopts the served workspace, renders it and the switcher recovers", async (t) => {
  common.setWorkspace(GONE);
  const { c, s, document, requests, rendered, selected } = shellRoster(t);
  const inFlight = s.refreshContextRoster();
  assert.equal(requests[0].path, `/api/panel?ws=${encodeURIComponent(GONE)}`);
  requests[0].resolve(reply(SERVED, [SERVED, OTHER]));
  await inFlight;
  assert.deepEqual(rendered, [["served-1"]], "the served roster is rendered");
  assert.equal(c.contextWorkspace, SERVED.id);
  assert.equal(c.tabWorkspace, SERVED.id, "tab memory follows the adoption, as for an empty selection");
  assert.equal(common.currentWorkspace(), SERVED.id);
  assert.equal(stored(), SERVED.id, "persisted");
  assert.deepEqual(c.contextDeployments, [], "a reply naming no deployments groups by none (#482)");
  // The workspace list shows the served workspace current and another choice still switches.
  const options = [...document.querySelectorAll(".ws-option")];
  assert.deepEqual(options.map((o) => [o.dataset.workspaceId, o.getAttribute("aria-current")]), [[SERVED.id, "true"], [OTHER.id, null]]);
  options[1].click();
  assert.deepEqual(selected, [OTHER.id]);
});

test("shell roster: the hierarchy adopting first does not orphan the shell's in-flight stale-selection reply", async (t) => {
  common.setWorkspace(GONE);
  const { c, s, requests, rendered } = shellRoster(t);
  const inFlight = s.refreshContextRoster();
  common.adoptWorkspace(SERVED.id);                    // the hierarchy's reply landed first
  requests[0].resolve(reply(SERVED, [SERVED, OTHER]));
  await inFlight;
  assert.deepEqual(rendered, [["served-1"]], "same selection, same resolution: owned and painted");
  assert.equal(c.contextWorkspace, SERVED.id);
  assert.equal(c.tabWorkspace, SERVED.id);
});

test("shell roster: a switch in flight discards a late stale-selection reply", async (t) => {
  common.setWorkspace(GONE);
  const { c, s, requests, rendered } = shellRoster(t);
  const late = s.refreshContextRoster();
  common.setWorkspace(OTHER.id); c.contextRosterGen++;   // restoreWorkspaceTabs bumps the roster generation on a switch
  requests[0].resolve(reply(SERVED, [SERVED, OTHER]));
  await late;
  assert.deepEqual(rendered, [], "nothing painted");
  assert.equal(common.currentWorkspace(), OTHER.id, "nothing adopted");
  assert.equal(stored(), OTHER.id);
});

test("shell roster: without a served list the reply is handled as today and nothing is adopted", async (t) => {
  common.setWorkspace(GONE);
  const { c, s, requests, rendered } = shellRoster(t);
  const inFlight = s.refreshContextRoster();
  requests[0].resolve({ instances: [{ instance: "x", running: true }], workspace: SERVED });
  await inFlight;
  assert.deepEqual(rendered, [["x"]]);
  assert.equal(c.contextWorkspace, SERVED.id, "existing behaviour: the reply's workspace is the context");
  assert.equal(c.tabWorkspace, GONE, "existing behaviour: no adoption");
  assert.equal(common.currentWorkspace(), GONE);
  assert.equal(stored(), GONE);
});

test("shell roster: a served selection answered with another workspace is not adopted (unchanged)", async (t) => {
  common.setWorkspace(OTHER.id);
  const { c, s, requests } = shellRoster(t);
  const inFlight = s.refreshContextRoster();
  requests[0].resolve(reply(SERVED, [SERVED, OTHER]));
  await inFlight;
  assert.equal(common.currentWorkspace(), OTHER.id);
  assert.equal(c.tabWorkspace, OTHER.id);
  assert.equal(stored(), OTHER.id);
});
