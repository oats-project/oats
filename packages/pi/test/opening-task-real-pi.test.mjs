// The opening-task races of opening-task.test.mjs, run in pi itself, where a
// pi SDK of the 0.85 line the PiHost models is found (real-pi.mjs); the cases
// skip, saying why, where none is.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS, assertScenario, expected } from "./opening-scenarios.mjs";
import { PI, skip } from "./real-pi.mjs";

const RUNNER = fileURLToPath(new URL("./run-opening-scenario-real-pi.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
// pi 1.2 and later count a run as active from before its before_agent_start (awebai/oats#1322).
const [major, minor] = (PI.version ?? "0.0").split(".").map(Number);
const startsRunFirst = major > 1 || (major === 1 && minor >= 2);

function run(t, scenario) {
  const home = mkdtempSync(join(tmpdir(), "oats-pi-opening-real-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, "instance.json"), "{}\n");
  const env = { ...process.env, OATS_PKG_ROOT: REPO_ROOT };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [RUNNER, PI.root, PI.piAiEntry, scenario, home], { env, encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
for (const scenario of SCENARIOS.filter((s) => !s.hostOnly)) {
  const want = expected(scenario, startsRunFirst);
  test(`real pi, ${want.title}`, { skip }, (t) => assertScenario(run(t, scenario.name), want));
}
