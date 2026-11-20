// The Souls grid on team model v2 (0.30): /api/agents rows carry `teams`
// [{label, team|null, default, from, mapped}] and `defaultTeam`, and no longer `team`/`labels`
// (engineer, docs audit #280). The rows here are the REAL 0.30 kernel captures
// (test/fixtures/team-model-v2: Northwind, the local default `mine`, release-manager's own
// default engineering) through soulsData → agentsData, as the server builds them.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { JSDOM } from "jsdom";
import * as remote from "../../client/remote-roster.mjs";
import { soulRows } from "../../client/soul-rows.mjs";
import { soulsData, deploymentStatusData } from "../../client/deployment-data.mjs";

const tick = () => new Promise((r) => setTimeout(r, 0));
const v2 = (name) => JSON.parse(readFileSync(new URL(`./fixtures/team-model-v2/${name}.json`, import.meta.url), "utf8"));
const DEPLOYMENT = "/fixture/base/northwind-workspace";
const CLI_OK = { ok: true, bin: "/seed/oats", version: "0.18.0", source: "path", required: { desktopApi: 1, range: ">=0.18.0 <0.21.0" }, probedAt: 1, tried: [] };

/** /api/agents rows from the real 0.30 captures, built by the server's own agentsData. */
function agentRows() {
  const source = readFileSync(new URL("../server/oats-web.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function agentsData("), end = source.indexOf("/* ── Model catalog", start);
  const agentsData = new Function("deploymentFor", "deployments", "snapshot", "remote", "dirname", "resolve", "soulRows",
    `const held = () => null, DESKTOP_TERMS = null; ${source.slice(start, end)}; return agentsData;`);
  const roster = deploymentStatusData(v2("status"), DEPLOYMENT), catalog = soulsData(v2("souls"));
  const snapshot = { byWs: new Map([[DEPLOYMENT, { deployment: { status: "observed", root: roster.root, souls: roster.agents.map(({ instances: _i, ...s }) => s),
    catalog: { souls: catalog.souls, ambiguous: [], reason: null } } }]]) };
  const ws = { id: DEPLOYMENT, name: "northwind", roots: [roster.root] };
  return agentsData(() => ws, () => [ws], snapshot, remote, dirname, resolve, soulRows)().agents;
}

async function mountGrid(t, agents) {
  const dom = new JSDOM("<!doctype html><html><head></head><body><div id=host></div></body></html>", { url: "http://localhost" });
  const saved = { document: globalThis.document, window: globalThis.window, setInterval: globalThis.setInterval };
  Object.assign(globalThis, { document: dom.window.document, window: dom.window, setInterval: () => ({ fake: true }) });
  const common = await import("../renderer/views/common.mjs");
  const spawn = await import("../renderer/views/spawn.mjs");
  const cli = await import("../renderer/views/cli-status.mjs");
  await cli.refreshCli({ api: async () => ({ ok: true, status: 200, json: async () => CLI_OK }) });
  const previous = common.currentWorkspace(); common.setWorkspace(DEPLOYMENT);
  spawn.mount(dom.window.document.getElementById("host"), { api(pathname) {
    if (pathname === "/api/cli" || pathname === "/api/cli/reprobe") return Promise.resolve(CLI_OK);
    if (pathname.startsWith("/api/agents")) return Promise.resolve({ agents });
    return Promise.resolve({ instances: [], workspace: { id: DEPLOYMENT }, workspaces: [] });
  }, openTerminal: () => {} });
  await tick(); await tick();
  t.after(() => { spawn.unmount(); common.setWorkspace(previous); Object.assign(globalThis, saved); dom.window.close(); });
  const doc = dom.window.document;
  const groups = () => Object.fromEntries([...doc.querySelectorAll(".souls-group")].map((g) => [
    g.querySelector(".souls-group-name").textContent, [...g.querySelectorAll(".soul-card")].map((c) => c.dataset.agent)]));
  return { doc, groups };
}

// The Desktop UI rework, slice 3a: souls are grouped by where they come from only; a soul's teams are its page's
// Teams row, not chips on its card, and nothing groups by team.
test("0.30 rows: the grid groups by repository whatever the souls' teams; no team chips, no team grouping", async (t) => {
  const rows = agentRows();
  const rm = rows.find((a) => a.name === "release-manager");
  assert.equal(Object.hasOwn(rm, "team") || Object.hasOwn(rm, "labels"), false, "0.30 rows carry neither team nor labels");
  assert.deepEqual(rm.defaultTeam, { label: "engineering", team: null, from: "soul" }, "captured: release-manager's own (unmapped) default");
  const u = await mountGrid(t, rows);
  const groups = u.groups();
  assert.equal(Object.values(groups).flat().length, rows.length, "every soul once");
  for (const label of ["engineering", "mine", "global", "No team", "No default team"]) assert.equal(Object.hasOwn(groups, label), false, `no ${label} group`);
  assert.equal(u.doc.querySelector(".schip, .souls-group-by, [data-group-by]"), null, "no team chips and no Group by");
  assert.doesNotMatch(u.doc.querySelector('.soul-card[data-agent="release-manager"]').textContent, /engineering|global|mine/, "the card names no team");
});

test("0.29 rows (team + labels) group by repository too", async (t) => {
  const old = (name, labels) => ({ name, agentsRoot: "/w/agents", description: "", work: "workspace", repo: true, repoName: "r", ...(labels ? { labels, team: labels[0] } : {}) });
  const u = await mountGrid(t, [old("a", ["engineering", "global"]), old("b")]);
  assert.deepEqual(u.groups(), { r: ["a", "b"] });
});
