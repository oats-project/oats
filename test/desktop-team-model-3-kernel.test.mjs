// The Desktop's teams calls against the REAL kernel of this repository (bin/oats.mjs), team model 3
// (feature team-model-3). Where a workspace does not allow local teams (no `localTeams: true`), the
// Desktop offers Remove for local teams still in oats-local.yaml only because the kernel accepts
// `oats teams remove` there (the last step of committing them in the workspace); `add` and `default`
// are refused before anything is written. The calls go through the Desktop's own argv builder
// (packages/client/cli-adapter.mjs cliTeams / cliSoulTeams), never a fake binary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { v2Deployment, CLI } from "./helpers/v2-deployment.mjs";
import { cliTeams, cliSoulTeams } from "../packages/client/cli-adapter.mjs";

function deployment(t, { workspace = {}, localTeams } = {}) {
  const fx = v2Deployment({ t, workspace: { teams: { global: { team: "global:acme.aweb.ai" } }, defaultTeam: "global", ...workspace } });
  const file = join(fx.dep, "oats-local.yaml");
  if (localTeams) writeFileSync(file, YAML.stringify({ ...YAML.parse(readFileSync(file, "utf8")), teams: localTeams }, { lineWidth: 0 }));
  // The kernel runs with the fixture's isolated environment (HOME, caches, no operator identity).
  const exec = (bin, argv, options, callback) => execFile(process.execPath, [bin, ...argv], { ...options, env: fx.env }, callback);
  return { fx, file, teams: (request) => cliTeams(CLI, { ...request, workspaceDir: fx.dep }, { exec }),
    soulTeams: (request) => cliSoulTeams(CLI, { ...request, workspaceDir: fx.dep }, { exec }) };
}

test("local teams closed: the kernel reports local-teams-closed, and accepts remove (the migration's last step)", async (t) => {
  const d = deployment(t, { localTeams: { mine: { team: "mine:alex.aweb.ai" } } });
  const listed = await d.teams({ action: "list" });
  assert.equal(listed.ok, true, JSON.stringify(listed.error));
  assert.equal(listed.result.teamsApi, 2);
  assert.equal(listed.result.localTeams, false);
  const closed = listed.result.problems.find((p) => p.condition === "local-teams-closed");
  assert.ok(closed, JSON.stringify(listed.result.problems));
  assert.equal(closed.code, "E_WORKSPACE_SCHEMA"); assert.equal(closed.severity, "failure"); assert.deepEqual(closed.keys, ["teams"]);
  const removed = await d.teams({ action: "remove", label: "mine" });
  assert.equal(removed.ok, true, `the kernel refused remove where local teams are closed: ${JSON.stringify(removed.error)}`);
  assert.equal(removed.result.changed, true);
  assert.equal(YAML.parse(readFileSync(d.file, "utf8")).teams?.mine, undefined, "removed from oats-local.yaml");
  const after = await d.teams({ action: "list" });
  assert.equal(after.result.problems.some((p) => p.condition === "local-teams-closed"), false, "nothing left to commit");
});

test("local teams closed: add and default are refused before anything is written", async (t) => {
  const d = deployment(t);
  const before = readFileSync(d.file, "utf8");
  for (const request of [{ action: "add", label: "mine", team: "mine:alex.aweb.ai" }, { action: "default", label: "global" }]) {
    const refused = await d.teams(request);
    assert.equal(refused.ok, false, request.action);
    assert.equal(refused.error.code, "E_WORKSPACE_SCHEMA", request.action);
    assert.equal(refused.error.details.reason, "local-teams-closed", request.action);
  }
  assert.equal(readFileSync(d.file, "utf8"), before, "oats-local.yaml untouched");
});

test("local teams allowed: add, default and remove are the deployment's own", async (t) => {
  const d = deployment(t, { workspace: { localTeams: true } });
  assert.equal((await d.teams({ action: "add", label: "mine", team: "mine:alex.aweb.ai" })).ok, true);
  assert.equal((await d.teams({ action: "default", label: "mine" })).ok, true);
  const inUse = await d.teams({ action: "remove", label: "mine" });
  assert.equal(inUse.error?.code, "E_TEAM_IN_USE");
  const listed = await d.teams({ action: "list" });
  assert.equal(listed.result.localTeams, true);
  assert.deepEqual(listed.result.defaultTeam, { label: "mine", team: "mine:alex.aweb.ai", from: "deployment" });
});

test("oats soul teams is read only: a show answers soulTeamsApi 2; the removed edit flags are refused by name", async (t) => {
  const d = deployment(t);
  const shown = await d.soulTeams({ soul: "*" });
  assert.equal(shown.ok, true, JSON.stringify(shown.error));
  assert.equal(shown.result.soulTeamsApi, 2);
  const refused = await d.soulTeams({ soul: "*", add: ["global"] });
  assert.equal(refused.error.code, "E_BAD_ARGS");
  assert.equal(refused.error.details.flag, "--add");
});
