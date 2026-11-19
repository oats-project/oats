// A persisted workspace selection the server no longer serves (a deleted
// deployment) must not lock the operator out: both roster paths adopt the
// served workspace, exactly like an empty selection. A served selection
// answered with a different workspace stays a refused mismatch. (The Machines
// canvas, the second path, became the Graph in slice 6b: it reads the shell's
// roster, so the shell's path is the one left.)
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
const { rosterResponseOwns, rosterSignature } = await import("../renderer/instance-tree-view.mjs");
const { createWorkspaceSwitcher } = await import("../renderer/workspace-switcher.mjs");
const { mountShellIcons } = await import("../renderer/shell-icons.mjs");

const SERVED = { id: "/Users/op/OATS", name: "OATS" };
const OTHER = { id: "/Users/op/other", name: "other" };
const REMOTE = { id: "remote:builder", name: "builder", server: "builder", remote: true };
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
    refreshPanelInstance() {}, spawnJobs: { rows: () => [], announce: () => false, observe() {}, settling: () => false, check() {} },
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

test("shell roster: another view adopting first does not orphan the shell's in-flight stale-selection reply", async (t) => {
  common.setWorkspace(GONE);
  const { c, s, requests, rendered } = shellRoster(t);
  const inFlight = s.refreshContextRoster();
  common.adoptWorkspace(SERVED.id);                    // another view's reply landed first
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
