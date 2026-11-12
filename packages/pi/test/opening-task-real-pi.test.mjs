// The opening-task races of opening-task.test.mjs, run in pi itself. pi is
// not a dependency of this repository: the case runs where a pi on PATH
// resolves to an SDK (@earendil-works/pi-coding-agent) of the 0.85 line the
// PiHost models, and skips, saying why, where none does. Under npm the first
// pi on PATH is node_modules/.bin's, the root's development dependency,
// which can be older; the search goes on past it.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS, assertScenario, expected } from "./opening-scenarios.mjs";

const RUNNER = fileURLToPath(new URL("./run-opening-scenario-real-pi.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const MINIMUM = [0, 85];

/** The pi SDK behind one `pi` binary, or why it does not qualify. */
function sdkOf(bin) {
  for (let d = dirname(realpathSync(bin)); d !== dirname(d); d = dirname(d)) {
    const manifest = join(d, "package.json");
    if (!existsSync(manifest)) continue;
    const { name, version } = JSON.parse(readFileSync(manifest, "utf8"));
    if (name !== PI_PACKAGE) continue;
    const [major, minor] = version.split(".").map(Number);
    if (major < MINIMUM[0] || (major === MINIMUM[0] && minor < MINIMUM[1])) return { reason: `${bin} is ${PI_PACKAGE} ${version}, older than ${MINIMUM.join(".")}` };
    const piAi = [join(d, "node_modules", "@earendil-works", "pi-ai"), join(dirname(d), "pi-ai")].find((p) => existsSync(join(p, "dist", "index.js")));
    if (!piAi) return { reason: `${bin} is ${PI_PACKAGE} ${version} with no resolvable @earendil-works/pi-ai` };
    return { root: d, version, piAiEntry: join(piAi, "dist", "index.js") };
  }
  return { reason: `${bin} is not part of ${PI_PACKAGE}` };
}
/** The first qualifying pi SDK on PATH, or why there is none. */
function findPi() {
  const bins = [...new Set((process.env.PATH || "").split(delimiter).filter(Boolean).map((d) => join(d, "pi")).filter((p) => existsSync(p)))];
  if (!bins.length) return { reason: "no pi on PATH" };
  const reasons = [];
  for (const bin of bins) {
    const sdk = sdkOf(bin);
    if (sdk.root) return sdk;
    reasons.push(sdk.reason);
  }
  return { reason: reasons.join("; ") };
}
const PI = findPi();
const skip = PI.root ? false : `pi SDK not found: ${PI.reason}`;
if (PI.root) console.log(`# real pi: ${PI_PACKAGE} ${PI.version} at ${PI.root}`);
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
