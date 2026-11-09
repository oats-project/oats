import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, symlinkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { restartInstanceSession, startInstanceSession, inspectInstanceSession } from "../lib/core.mjs";
import { readStartExited } from "../lib/session-end.mjs";
import { readInstanceBackground, writeInstanceBackground } from "../lib/instance-background.mjs";
import { soulFiles, v2Deployment } from "./helpers/v2-deployment.mjs";
import { packageRepo } from "./helpers/package-repo.mjs";
import { isolateSessionEnvironment, oatsSocket, waitUntil } from "./helpers/host-fixture.mjs";

const CLI = resolve(new URL("../bin/oats.mjs", import.meta.url).pathname);
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// ---- real tmux on a private socket, fake harnesses that record and idle ----
const base = realpathSync(mkdtempSync(join(tmpdir(), "oats-session-restart-")));
const session = "r";
const restoreEnvironment = isolateSessionEnvironment(base);
const socket = oatsSocket(); // the fixture's own `oats` server: where the kernel creates windows
const tmux = (...args) => execFileSync("tmux", ["-u", "-S", socket, ...args], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }).trim();
const windows = () => { try { return tmux("list-windows", "-t", session, "-F", "#{window_name}").split("\n").filter(Boolean); } catch { return []; } };
test.after(() => { try { tmux("kill-server"); } catch { /* gone */ } finally { restoreEnvironment(); rmSync(base, { recursive: true, force: true }); } });
function write(p, c) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); }
// A harness that records argv and environment, then idles; `polite` exits on TERM, `stubborn` ignores it.
const binDir = join(base, "bin"); mkdirSync(binDir);
// Publish readiness LAST, after output and signal handlers are installed. Then `exec` the idle: the
// kernel reads a pane holding only shells as the fallback prompt, so a shell loop forking short
// sleeps reads as "shell" between forks (more often under load: #415). The exec keeps the PID and an
// ignored TERM (`trap ''` survives exec); a default TERM ends `polite`.
write(join(binDir, "polite"), `#!/bin/sh\nprintf '%s\\n' "$@" > "$OATS_INSTANCE_HOME/argv.txt"\nenv > "$OATS_INSTANCE_HOME/env.txt"\necho $$ > "$OATS_INSTANCE_HOME/pid.txt"\nexec sleep 86400\n`);
write(join(binDir, "stubborn"), `#!/bin/sh\ntrap '' TERM\necho $$ > "$OATS_INSTANCE_HOME/pid.txt"\nexec sleep 86400\n`);
for (const n of ["polite", "stubborn", "claude", "codex", "pi"]) chmodSync(join(binDir, n === "claude" || n === "codex" || n === "pi" ? "polite" : n), 0o755);
for (const n of ["claude", "codex", "pi"]) { write(join(binDir, n), readFileSync(join(binDir, "polite"), "utf8")); chmodSync(join(binDir, n), 0o755); }
// In-process starts resolve a harness's default binary on THIS process's PATH (`which`), not on the
// environment passed to them: the fakes go first here too, so a host without the real harnesses plans alike.
process.env.PATH = `${binDir}:${process.env.PATH}`;
const env = (extra = {}) => { const e = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, OATS_HOME_DIR: join(base, "oats-home"), ...extra }; for (const k of ["OATS_INSTANCE", "OATS_INSTANCE_HOME", "OATS_HOME", "PI_AGENT_INSTANCE", "PI_AGENT_HOME", "PI_AGENTS_ROOT"]) delete e[k]; return e; };
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
function oats(args, extra = {}) { const r = spawnSync(process.execPath, [CLI, ...args, "--json"], { encoding: "utf8", env: env(extra) }); let json; try { json = JSON.parse(r.stdout.trim()); } catch { throw new Error(`no JSON envelope: ${r.stdout}\n${r.stderr}`); } return { ...r, json }; }

// A workspace deployment: souls in its member repository, capabilities as member modules, and the
// launch configurations a host chooses in its oats-local.yaml (found walking up from a home).
// Launch hooks answer what the test wrote to <home>/answer.json (a home's module copy is pinned).
const answerHook = (extra = "") => `import { existsSync, readFileSync, writeFileSync } from "node:fs"; import { join } from "node:path";\n${extra}const f = join(process.env.OATS_HOME, "answer.json");\nprocess.stdout.write((existsSync(f) ? readFileSync(f, "utf8") : "{}") + "\\n");\n`;
const fx = v2Deployment({
  souls: {
    dev: {},
    late: {},
    hooked: { soul: { capabilities: { "test.extra": { from: "here" }, "test.two": { from: "here" } } } },
    renew: { soul: { capabilities: { "test.renew": { from: "here" } } } },
    req: { soul: { capabilities: { "test.req": { from: "here" } } } },
    teamed: { soul: { capabilities: { "test.teams": { from: "here" } } } },
    seen: { soul: { capabilities: { "test.seen": { from: "here" } } } },
  },
  capabilities: {
    "test.extra": { manifest: { launchPreview: true, hooks: { launch: "bin/launch.mjs" }, environment: ["TEST_NEWVAR", "TEST_OLDVAR", "TEST_SHARED"], settings: { mode: { description: "m", default: "current" } } },
      files: { "bin/launch.mjs": answerHook(`writeFileSync(join(process.env.OATS_HOME, "hooked-settings"), process.env.OATS_SETTINGS);\n`) } },
    "test.two": { manifest: { environment: ["TEST_SHARED"] } },
    "test.renew": { manifest: { hooks: { launch: "bin/launch.mjs" }, environment: [], settings: {} }, files: { "bin/launch.mjs": answerHook() } },
    "test.req": { manifest: { launchPreview: true, hooks: { launch: "bin/launch.mjs" }, requires: [{ harness: "claude", package: "chan@acme-marketplace", marketplace: "acme/claude-plugins", when: { mode: "on" } }], settings: { mode: { description: "m" } } },
      files: { "bin/launch.mjs": `process.stdout.write(JSON.stringify({ launch: { claude: "--req-hook" }, env: {} }) + "\\n");\n` } },
    // Records the teams its launch hook was given (team model v2).
    "test.teams": { manifest: { hooks: { launch: "bin/launch.mjs" }, environment: [], settings: {} },
      files: { "bin/launch.mjs": `import { writeFileSync } from "node:fs"; import { join } from "node:path";\nwriteFileSync(join(process.env.OATS_HOME, "teams-env.json"), JSON.stringify({ old: [process.env.OATS_TEAM_LABELS ?? null, process.env.OATS_TEAM_LABEL ?? null], def: process.env.OATS_DEFAULT_TEAM ?? null, source: process.env.OATS_TEAMS_SOURCE, teams: JSON.parse(process.env.OATS_TEAMS) }));\nprocess.stdout.write("{}\\n");\n` } },
    // Records, per pass, the harness variables its launch hook was given and the harness PID still running.
    "test.seen": { manifest: { launchPreview: true, hooks: { launch: "bin/launch.mjs" }, environment: [], settings: {} },
      files: { "bin/launch.mjs": `import { appendFileSync, readFileSync } from "node:fs"; import { join } from "node:path";\nconst e = process.env; let alive = null;\ntry { const pid = Number(readFileSync(join(e.OATS_HOME, "pid.txt"), "utf8").trim()); if (pid > 1) { process.kill(pid, 0); alive = pid; } } catch { /* none running */ }\nappendFileSync(join(e.OATS_HOME, "seen.jsonl"), JSON.stringify({ preview: e.OATS_LAUNCH_PREVIEW ?? null, harness: e.OATS_HARNESS, runtime: e.OATS_RUNTIME, previousHarness: e.OATS_PREVIOUS_HARNESS, previousRuntime: e.OATS_PREVIOUS_RUNTIME, alive }) + "\\n");\nprocess.stdout.write("{}\\n");\n` } },
  },
  // Team model 3: teamed may join the shared night team (not created yet); the deployment's local teams are allowed.
  workspace: { teams: { global: { description: "Fixture team" }, night: { description: "Night shift" } }, localTeams: true, souls: { "ws/teamed": { teams: ["night"] } } },
  local: { "launch-configs": {
    polite: { harness: "claude", executable: join(binDir, "polite"), args: ["--flag", "a b c"], env: { KEY: { fromEnv: "RESTART_TEST_SRC" }, LIT: "plain" }, model: "claude-opus-5" },
    stubborn: { harness: "claude", executable: join(binDir, "stubborn") },
    codexy: { harness: "codex", executable: join(binDir, "polite") },
    // This host's codex default: a harness-only codex launch runs it, --launch-config none never does.
    codexdef: { harness: "codex", default: true, executable: join(binDir, "polite"), args: ["--from-default"], env: { FROM_DEFAULT: "1" } },
  },
  // A local team: with localTeams: true, every soul may join it.
  teams: { mine: { team: "aweb:fixture.mine" } } },
});
test.after(() => fx.cleanup());
const repo = fx.dep; // the deployment: the scope lifecycle verbs resolve from
const homeOf = (name, soul = "dev") => join(fx.root, soul, "instances", name);
// Homes are SPAWNED through the workspace path (fx.spawn), then given the recorded launch a test
// starts from: the private tmux socket, and a recipe (or the command alone).
async function makeHome(name, { soul = "dev", command, launch, harness = "claude", model, providers, ...spawn } = {}) {
  // The bare harness unless a test names a configuration: this deployment declares several claude configurations.
  const { home } = await fx.spawn(soul, { name, work: "checkout", launch: false, harness, providers, launchConfig: "none", ...spawn });
  assert.equal(home, homeOf(name, soul));
  const meta = { ...readJson(join(home, "instance.json")), harness, ...(model ? { model } : {}), tmux: { session, window: name, socket }, launched: true };
  if (command !== undefined) meta.command = command;
  if (launch) meta.launch = launch;
  write(join(home, "instance.json"), JSON.stringify(meta, null, 2) + "\n");
  // The independent session receipt (the spawn's retirement baseline) records the same endpoint.
  const baselinePath = join(dirname(home), ".oats-retirement", "baselines", `${createHash("sha256").update(home).digest("hex")}.json`);
  const baseline = readJson(baselinePath);
  write(baselinePath, JSON.stringify({ ...baseline, runtime: { launched: true, tmux: { session, window: name, socket } } }, null, 2) + "\n");
  return { home, meta };
}
const recipeFor = (home, name, { executable, args = [], env = {}, hooksEnv = {}, contributions = [] } = {}) => ({ version: 2, harness: "claude", launchConfig: null, launchConfigSource: null, executable, executableDeclared: null, executableResolvedFrom: "PATH", args, env, model: null, yolo: true, hooks: { launch: {}, env: hooksEnv, contributions }, prompt: { kind: "task-file", file: "TASK.md" } });
const renderFor = (home, name, exe, extraEnv = "") => `OATS_INSTANCE=${shq(name)} OATS_INSTANCE_HOME=${shq(home)} PI_AGENT_INSTANCE=${shq(name)} PI_AGENT_HOME=${shq(home)}${extraEnv} ${shq(exe)} --dangerously-skip-permissions -- "$(cat TASK.md)"`;
const waitFor = (pred, description = "harness readiness") => waitUntil(pred, description);
const runningPid = (home) => {
  try {
    const text = readFileSync(join(home, "pid.txt"), "utf8").trim();
    const pid = Number(text);
    // A marker being rewritten can briefly be empty: never turn that into
    // PID 0 and accidentally signal the test runner's entire process group.
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(pid) || pid <= 1) return null;
    process.kill(pid, 0);
    return pid;
  } catch { return null; }
};

test("restart: every preflight before the stop; a polite harness ends on SIGTERM and the new configuration starts in place with literal args and the reference under its alias", async () => {
  const name = "dev-polite";
  const { home } = await makeHome(name, { command: renderFor(homeOf(name), name, join(binDir, "polite")), launch: recipeFor(homeOf(name), name, { executable: join(binDir, "polite") }) });
  tmux("new-session", "-d", "-s", session, "-n", "hq", "-c", home);
  // Feature instance-background: the home's record outlives every start and restart below, which rewrite instance.json.
  writeInstanceBackground(home, true);
  const first = startInstanceSession(home, { env: env() });
  assert.equal(first.reused, "new");
  assert.ok(await waitFor(() => runningPid(home) !== null), "the first harness is up");
  const oldPid = runningPid(home);
  // Preflight refusals leave the running harness alone.
  for (const [sel, code] of [[{ launchConfig: "nope" }, "E_LAUNCH_CONFIG_UNKNOWN"], [{ launchConfig: "polite", harness: "codex" }, "E_LAUNCH_CONFIG_MISMATCH"], [{ launchConfig: "polite" }, "E_LAUNCH_ENV_MISSING"]]) {
    assert.throws(() => restartInstanceSession(home, { ...sel, env: env() }), (e) => e.code === code, code);
    assert.equal(runningPid(home), oldPid, `${code}: still the same harness`);
    assert.equal(existsSync(join(home, ".oats-restart.json")), false, `${code}: no stop was attempted`);
  }
  // The restart: stop observed, then the in-place start; the pane gets the alias, the command names no source variable.
  const r = restartInstanceSession(home, { launchConfig: "polite", env: env({ RESTART_TEST_SRC: "s3cret" }), stopGraceMs: 5000 });
  assert.equal(r.reused, "pane"); assert.equal(r.stop.exited, true); assert.equal(r.stop.signal, "SIGTERM"); assert.equal(r.stop.requested[0].pid, oldPid);
  assert.equal(r.launchConfig, "polite"); assert.equal(r.model, "claude-opus-5");
  assert.ok(await waitFor(() => runningPid(home) !== null && runningPid(home) !== oldPid), "a new harness is up");
  const argv = readFileSync(join(home, "argv.txt"), "utf8").split("\n");
  assert.deepEqual(argv.slice(0, 5), ["--dangerously-skip-permissions", "--model", "claude-opus-5", "--flag", "a b c"], "literal args, spaces intact");
  const paneEnv = Object.fromEntries(readFileSync(join(home, "env.txt"), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  assert.equal(paneEnv.KEY, "s3cret", "the reference resolved in the pane"); assert.equal(paneEnv.LIT, "plain"); assert.equal(paneEnv.OATS_LAUNCH_REF_KEY, "s3cret");
  const meta = readJson(join(home, "instance.json"));
  assert.equal(meta.launch.launchConfig, "polite"); assert.deepEqual(meta.launch.env, { KEY: { fromEnv: "RESTART_TEST_SRC" }, LIT: "plain" });
  assert.ok(meta.command.includes(`KEY="$OATS_LAUNCH_REF_KEY"`) && !meta.command.includes("s3cret") && !meta.command.includes("RESTART_TEST_SRC"), meta.command);
  assert.equal(meta.restartCount, 2); assert.equal(meta.harness, "claude");
  const receipt = readJson(join(home, ".oats-restart.json"));
  assert.equal(receipt.stop.exited, true); assert.equal(receipt.next.launchConfig, "polite");
  assert.ok(!JSON.stringify(receipt).includes("s3cret"));
  assert.deepEqual(windows().filter((w) => w === name), [name], "one window for the home");
  // A model-only start later keeps the recorded configuration and re-checks its references.
  process.kill(runningPid(home), "SIGTERM"); await waitFor(() => runningPid(home) === null, "polite harness exit");
  await waitFor(() => existsSync(join(home, ".oats-start-exited")) && inspectInstanceSession(home).state === "shell", "completed command and idle fallback shell");
  assert.throws(() => startInstanceSession(home, { model: "claude-sonnet-5", env: env() }), (e) => e.code === "E_LAUNCH_ENV_MISSING", "the recorded reference is re-checked on a model-only start");
  const again = startInstanceSession(home, { model: "claude-sonnet-5", env: env({ RESTART_TEST_SRC: "again" }) });
  assert.equal(again.model, "claude-sonnet-5"); assert.equal(again.launchConfig, "polite");
  assert.ok(await waitFor(() => runningPid(home) !== null));
  assert.equal(Object.fromEntries(readFileSync(join(home, "env.txt"), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])).KEY, "again");
  assert.equal(readJson(join(home, "instance.json")).launch.model, "claude-sonnet-5", "the recipe follows the model-only start");
  assert.equal(readInstanceBackground(home), true, "a start, a restart and a start after exit keep the background record");
});

test("restart: a harness that ignores SIGTERM is reported still running after the bounded wait; nothing is escalated or launched; a neighbour window is untouched", async () => {
  const name = "dev-stubborn";
  const { home } = await makeHome(name, { command: renderFor(homeOf(name), name, join(binDir, "stubborn")), launch: recipeFor(homeOf(name), name, { executable: join(binDir, "stubborn") }) });
  tmux("new-window", "-t", `${session}:`, "-n", "neighbour", "-c", home, "sleep 60");
  startInstanceSession(home, { env: env() });
  assert.ok(await waitFor(() => runningPid(home) !== null));
  const pid = runningPid(home);
  const before = readFileSync(join(home, "instance.json"), "utf8");
  // The completed start keeps its receipt as launch evidence; a refused restart leaves it as it was (#691).
  const receiptBefore = readFileSync(join(home, ".oats-start-pending.json"), "utf8");
  const t = Date.now();
  assert.throws(() => restartInstanceSession(home, { launchConfig: "polite", env: env({ RESTART_TEST_SRC: "x" }), stopGraceMs: 1500 }), (e) => e.code === "E_SESSION_STOP_FAILED" && /still running after/.test(e.message) && /nothing was escalated/.test(e.message));
  assert.ok(Date.now() - t < 6000, "bounded");
  assert.equal(runningPid(home), pid, "the stubborn harness is still there, untouched by any stronger signal");
  assert.equal(readFileSync(join(home, "instance.json"), "utf8"), before, "metadata unchanged");
  assert.equal(readFileSync(join(home, ".oats-start-pending.json"), "utf8"), receiptBefore, "no launch receipt was written: the completed start's is kept, unchanged");
  const receipt = readJson(join(home, ".oats-restart.json"));
  assert.equal(receipt.stop.exited, false); assert.deepEqual(receipt.stop.stillRunning, [pid]);
  // The stop was recorded before the harness was asked to end (#1601), and stays: should this
  // harness die later, the home reads `stopped`, not `lost` (the accepted cost of recording first).
  assert.deepEqual([readJson(join(home, ".oats-stop.json")).startId, readJson(join(home, ".oats-stop.json")).stop], [JSON.parse(before).startId, null]);
  assert.ok(windows().includes("neighbour") && windows().filter((w) => w === name).length === 1);
  process.kill(pid, "SIGKILL"); // test cleanup only
});

test("every start of a recipe home goes through the planner: a missing recorded executable or an unknown recipe shape refuses an ordinary start before anything", async () => {
  const name = "dev-badrecipe";
  const home = homeOf(name);
  await makeHome(name, { command: renderFor(home, name, join(binDir, "polite")), launch: recipeFor(home, name, { executable: join(base, "no-such-harness") }) });
  assert.throws(() => startInstanceSession(home, { env: env() }), (e) => e.code === "E_LAUNCH_EXECUTABLE" && /no-such-harness/.test(e.message));
  assert.throws(() => startInstanceSession(home, { model: "claude-x", env: env() }), (e) => e.code === "E_LAUNCH_EXECUTABLE", "model-only starts are planned too");
  const meta = readJson(join(home, "instance.json"));
  write(join(home, "instance.json"), JSON.stringify({ ...meta, launch: { ...meta.launch, version: 7 } }));
  assert.throws(() => startInstanceSession(home, { env: env() }), (e) => e.code === "E_LAUNCH_RECIPE_UNSUPPORTED");
  assert.equal(existsSync(join(home, ".oats-start-pending.json")), false, "nothing was allocated");
  assert.ok(!windows().includes(name));
});

test("a restart to another harness whose metadata write is interrupted is recovered by the next start with ONE allocation and the new recipe; a running recovered target refuses a new selection factually", async () => {
  const name = "dev-recover";
  const home = homeOf(name);
  await makeHome(name, { command: renderFor(home, name, join(binDir, "polite")), launch: recipeFor(home, name, { executable: join(binDir, "polite") }) });
  startInstanceSession(home, { env: env() });
  assert.ok(await waitFor(() => runningPid(home) !== null));
  const oldPid = runningPid(home);
  assert.throws(() => restartInstanceSession(home, { launchConfig: "codexy", env: env(), stopGraceMs: 5000, io: { failBeforeMetadataWrite: true } }), (e) => e.code === "E_SESSION_START_INCOMPLETE");
  const pending = readJson(join(home, ".oats-start-pending.json"));
  assert.deepEqual([pending.harness, pending.launch.launchConfig, pending.launch.harness, pending.model], ["codex", "codexy", "codex", null], "the receipt carries the new recipe");
  assert.equal(readJson(join(home, "instance.json")).harness, "claude", "metadata still says the old harness");
  assert.ok(await waitFor(() => runningPid(home) !== null && runningPid(home) !== oldPid, "replacement harness PID"), "the new harness is up");
  const recovered = startInstanceSession(home, { env: env() });
  assert.equal(recovered.reused, "adopted"); assert.equal(recovered.harness, "codex"); assert.equal(recovered.launchConfig, "codexy"); assert.equal(recovered.model, null);
  const meta = readJson(join(home, "instance.json"));
  assert.deepEqual([meta.harness, meta.launch.launchConfig, meta.launch.harness, meta.model], ["codex", "codexy", "codex", undefined]);
  assert.equal(windows().filter((w) => w === name).length, 1, "one allocation");
  assert.equal(existsSync(join(home, ".oats-start-pending.json")), true, "the receipt stays until the command exits");
  // A choice made now against the running recovered target is refused, not silently ignored.
  assert.throws(() => startInstanceSession(home, { launchConfig: "polite", env: env({ RESTART_TEST_SRC: "x" }) }), (e) => e.code === "E_SESSION_RUNNING" && /was not applied/.test(e.message));
  assert.throws(() => startInstanceSession(home, { harness: "claude", env: env() }), (e) => e.code === "E_SESSION_RUNNING" && /was not applied/.test(e.message));
  // A pending receipt whose recipe is not a shape this kernel starts from is refused before anything.
  write(join(home, ".oats-start-pending.json"), JSON.stringify({ ...pending, launch: { ...pending.launch, version: 9 } }));
  assert.throws(() => startInstanceSession(home, { env: env() }), (e) => e.code === "E_SESSION_UNKNOWN" && /invalid receipt/.test(e.message));
  write(join(home, ".oats-start-pending.json"), JSON.stringify(pending));
  process.kill(runningPid(home), "SIGTERM");
});

// #1345: a home recorded with a named claude configuration (its args, env and model), and what a start's records say.
const namedClaudeRecipe = (home, name) => ({ ...recipeFor(home, name, { executable: join(binDir, "polite"), args: ["--flag", "a b c"], env: { LIT: "plain" } }), launchConfig: "polite", launchConfigSource: repo, model: "claude-opus-5" });
const launchedRow = (home, startId) => {
  const rows = readFileSync(join(home, ".oats-events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "launched" && e.data?.startId === startId);
  assert.equal(rows.length, 1, `one launched event for start ${startId}`);
  return rows[0].data;
};
const seenRuns = (home) => existsSync(join(home, "seen.jsonl")) ? readFileSync(join(home, "seen.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const paneEnvOf = (home) => Object.fromEntries(readFileSync(join(home, "env.txt"), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const ensureSession = (home) => { try { tmux("has-session", "-t", session); } catch { tmux("new-session", "-d", "-s", session, "-n", "hq", "-c", home); } };

test("#1345 --launch-config none --harness codex from a named claude recipe restarts the bare codex, and the result, recipe, harness, restart receipt and launched event all say so; named starts keep their name", async () => {
  const name = "seen-bare";
  const home = homeOf(name, "seen");
  await makeHome(name, { soul: "seen", command: renderFor(home, name, join(binDir, "polite")), launch: namedClaudeRecipe(home, name) });
  ensureSession(home);
  // Control: an unqualified start of the frozen named recipe keeps its name in every record.
  const first = startInstanceSession(home, { env: env() });
  assert.equal(first.launchConfig, "polite");
  assert.equal(launchedRow(home, readJson(join(home, "instance.json")).startId).launchConfig, "polite");
  assert.ok(await waitFor(() => runningPid(home) !== null), "the claude harness is up");
  const oldPid = runningPid(home);
  // Control: a named configuration that disagrees with an explicit harness refuses before any hook, stop or record.
  rmSync(join(home, "seen.jsonl"), { force: true });
  const metaBefore = readFileSync(join(home, "instance.json"), "utf8");
  assert.throws(() => restartInstanceSession(home, { launchConfig: "polite", harness: "codex", env: env(), stopGraceMs: 5000 }), (e) => e.code === "E_LAUNCH_CONFIG_MISMATCH");
  assert.deepEqual(seenRuns(home), [], "no launch hook ran");
  assert.equal(runningPid(home), oldPid); assert.equal(existsSync(join(home, ".oats-restart.json")), false, "no stop was attempted");
  assert.equal(readFileSync(join(home, "instance.json"), "utf8"), metaBefore);

  const r = restartInstanceSession(home, { launchConfig: "none", harness: "codex", env: env(), stopGraceMs: 5000 });
  assert.deepEqual([r.harness, r.launchConfig, r.model, r.stop.exited], ["codex", null, null, true]);
  // The launch hook was told the target harness in its preview and its real pass, the real one before the stop.
  const told = { harness: "codex", runtime: "codex", previousHarness: "claude", previousRuntime: "claude", alive: oldPid };
  assert.deepEqual(seenRuns(home), [{ preview: "1", ...told }, { preview: null, ...told }]);
  assert.ok(await waitFor(() => runningPid(home) !== null && runningPid(home) !== oldPid), "the codex harness is up");
  const meta = readJson(join(home, "instance.json"));
  assert.deepEqual([meta.harness, meta.launch.harness, meta.launch.launchConfig, meta.launch.launchConfigSource], ["codex", "codex", null, null]);
  assert.deepEqual([meta.launch.executable, meta.launch.args, meta.launch.env, meta.launch.model, meta.launch.yolo], [join(binDir, "codex"), [], {}, null, true], "nothing of the named configuration; the recorded yolo as before");
  assert.ok(!/polite|--flag|LIT=|claude-opus-5|--from-default/.test(meta.command), meta.command);
  const argv = readFileSync(join(home, "argv.txt"), "utf8").split("\n");
  assert.ok(!argv.includes("--flag") && !argv.includes("claude-opus-5") && !argv.includes("--from-default"), argv.join(" "));
  assert.deepEqual([paneEnvOf(home).LIT, paneEnvOf(home).FROM_DEFAULT], [undefined, undefined]);
  assert.deepEqual(readJson(join(home, ".oats-restart.json")).next, { harness: "codex", launchConfig: null, model: null });
  assert.deepEqual(launchedRow(home, meta.startId), { harness: "codex", backend: "tmux", launchConfig: null, phase: "restart", startId: meta.startId });

  // Control: on the same harness, --launch-config none stays bare: the host's codex default does not apply.
  const codexPid = runningPid(home);
  const bare = restartInstanceSession(home, { launchConfig: "none", env: env(), stopGraceMs: 5000 });
  assert.deepEqual([bare.harness, bare.launchConfig], ["codex", null]);
  assert.ok(await waitFor(() => runningPid(home) !== null && runningPid(home) !== codexPid), "the bare codex is up again");
  const bareMeta = readJson(join(home, "instance.json"));
  assert.deepEqual([bareMeta.launch.launchConfig, bareMeta.launch.executable, bareMeta.launch.args], [null, join(binDir, "codex"), []]);
  assert.ok(!readFileSync(join(home, "argv.txt"), "utf8").split("\n").includes("--from-default"));
  assert.equal(readJson(join(home, ".oats-restart.json")).next.launchConfig, null);
  assert.equal(launchedRow(home, bareMeta.startId).launchConfig, null);
  // Control: a harness-only start runs that default, and every record names it.
  const barePid = runningPid(home);
  const def = restartInstanceSession(home, { harness: "codex", env: env(), stopGraceMs: 5000 });
  assert.deepEqual([def.harness, def.launchConfig], ["codex", "codexdef"]);
  assert.ok(await waitFor(() => runningPid(home) !== null && runningPid(home) !== barePid), "the default's codex is up");
  const defMeta = readJson(join(home, "instance.json"));
  assert.deepEqual([defMeta.launch.launchConfig, defMeta.launch.args], ["codexdef", ["--from-default"]]);
  assert.equal(readJson(join(home, ".oats-restart.json")).next.launchConfig, "codexdef");
  assert.equal(launchedRow(home, defMeta.startId).launchConfig, "codexdef");
  process.kill(runningPid(home), "SIGTERM");
});

test("#1345 an interrupted none+codex restart from a named claude recipe is adopted from its receipt's bare recipe: the recovered launched event keeps null, not the recorded name; a named receipt keeps its name; a receipt without a recipe falls back to the recorded one", async () => {
  const name = "dev-bare-recover";
  const home = homeOf(name);
  const pendingPath = join(home, ".oats-start-pending.json"), metaPath = join(home, "instance.json");
  await makeHome(name, { command: renderFor(home, name, join(binDir, "polite")), launch: namedClaudeRecipe(home, name) });
  ensureSession(home);
  startInstanceSession(home, { env: env() });
  assert.ok(await waitFor(() => runningPid(home) !== null), "the claude harness is up");
  const oldPid = runningPid(home);
  assert.throws(() => restartInstanceSession(home, { launchConfig: "none", harness: "codex", env: env(), stopGraceMs: 5000, io: { failBeforeMetadataWrite: true } }), (e) => e.code === "E_SESSION_START_INCOMPLETE");
  const pending = readJson(pendingPath);
  assert.deepEqual([pending.harness, pending.launch.harness, pending.launch.launchConfig, pending.launch.args, pending.launch.env, pending.model], ["codex", "codex", null, [], {}, null], "the receipt carries the bare codex recipe");
  const recorded = readFileSync(metaPath, "utf8");
  assert.deepEqual([JSON.parse(recorded).harness, JSON.parse(recorded).launch.launchConfig], ["claude", "polite"], "metadata still names the recorded configuration");
  // The interrupted start recorded its boundary and its restart receipt before the metadata: bare codex.
  assert.deepEqual(launchedRow(home, pending.id), { harness: "codex", backend: "tmux", launchConfig: null, phase: "restart", startId: pending.id });
  assert.deepEqual(readJson(join(home, ".oats-restart.json")).next, { harness: "codex", launchConfig: null, model: null });
  assert.ok(await waitFor(() => runningPid(home) !== null && runningPid(home) !== oldPid, "replacement harness PID"), "the codex harness is up");
  // An adoption completes a boundary no log holds. Each receipt below names its own start, which
  // no log holds yet, over the same recorded metadata.
  const adopt = (suffix, receipt) => {
    write(metaPath, recorded);
    const id = `${pending.id}-${suffix}`;
    write(pendingPath, JSON.stringify({ ...receipt, id }));
    const done = startInstanceSession(home, { env: env() });
    assert.equal(done.reused, "adopted");
    return { done, row: launchedRow(home, id) };
  };
  const { launch: _launch, harness: _harness, ...legacyReceipt } = pending;
  const legacy = adopt("legacy", legacyReceipt);
  assert.deepEqual([legacy.done.launchConfig, legacy.row.launchConfig, legacy.row.phase], ["polite", "polite", "recovered"], "a receipt without a recipe: the recorded configuration");
  const named = adopt("named", { ...pending, launch: { ...pending.launch, launchConfig: "codexy" } });
  assert.deepEqual([named.done.launchConfig, named.row.launchConfig], ["codexy", "codexy"], "a named receipt keeps its name");
  const adopted = adopt("bare", pending);
  assert.deepEqual([adopted.done.harness, adopted.done.launchConfig], ["codex", null]);
  assert.deepEqual(adopted.row, { harness: "codex", backend: "tmux", launchConfig: null, phase: "recovered", startId: `${pending.id}-bare` });
  const meta = readJson(metaPath);
  assert.deepEqual([meta.harness, meta.launch.harness, meta.launch.launchConfig], ["codex", "codex", null]);
  process.kill(runningPid(home), "SIGTERM");
});

test("launch hooks: only capabilities captured for the home take part; a hook answers args + env under the captured settings with the same environment rules as spawn; its answer, even empty, replaces the provider's previous contribution", async () => {
  const polite = join(binDir, "polite");
  const previewOf = (home) => { const r = spawnSync(process.execPath, [CLI, "launch-config", "preview", "--home", home, "--launch-config", "codexy", "--json"], { encoding: "utf8", env: env() }); const out = JSON.parse(r.stdout.trim()); assert.equal(out.ok, true, r.stdout + r.stderr); return out.result; };
  // Not captured: a home spawned before its soul declared the provider has no copy of it; the newly declared provider's launch hook does not run.
  const lateName = "late-newcap", late = homeOf(lateName, "late");
  await makeHome(lateName, { soul: "late", command: renderFor(late, lateName, polite), launch: recipeFor(late, lateName, { executable: polite }) });
  fx.commit(soulFiles("late", { soul: { capabilities: { "test.extra": { from: "here" } } } }), "late declares test.extra");
  write(join(late, "answer.json"), JSON.stringify({ launch: { codex: "--hooked" }, env: { TEST_NEWVAR: "1" } }));
  let v = previewOf(late);
  assert.equal(existsSync(join(late, "hooked-settings")), false, "the newly declared provider's launch hook did not run");
  assert.ok(!v.argv.includes("--hooked"));
  // Captured (spawned with the provider under settings the module default would not give, plus a recorded previous contribution with TEST_OLDVAR and a claude flag): the hook runs with the CAPTURED settings and its answer replaces the old contribution whole.
  const name = "dev-newcap", home = homeOf(name, "hooked");
  await makeHome(name, { soul: "hooked", command: renderFor(home, name, polite), launch: recipeFor(home, name, { executable: polite }), providers: { "test.extra": { mode: "captured" } } });
  const hook = (answer) => write(join(home, "answer.json"), JSON.stringify(answer));
  hook({ launch: { codex: "--hooked" }, env: { TEST_NEWVAR: "1" } });
  rmSync(join(home, "hooked-settings"), { force: true });
  const meta = readJson(join(home, "instance.json"));
  assert.deepEqual(meta.capabilityRuntime.map((c) => c.id).sort(), ["test.extra", "test.two"], "both providers captured at spawn");
  const previous = { capability: "test.extra", layer: null, level: home, settings: { mode: "captured" }, trust: { trusted: true, integrity: null }, launch: { claude: "--old" }, env: ["TEST_OLDVAR"] };
  write(join(home, "instance.json"), JSON.stringify({ ...meta, launch: { ...meta.launch, hooks: { launch: { claude: "--old" }, env: { TEST_OLDVAR: "old" }, contributions: [previous] } } }));
  v = previewOf(home);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "hooked-settings"), "utf8")), { mode: "captured" }, "captured settings, not the module default the deployment resolves now");
  assert.ok(v.argv.includes("--hooked") && !v.argv.includes("--old"), JSON.stringify(v.argv));
  assert.deepEqual(v.environment.filter((e) => ["TEST_NEWVAR", "TEST_OLDVAR"].includes(e.name)).map((e) => e.name), ["TEST_NEWVAR"], "the provider's previous env name is gone, its new one is there");
  assert.match(v.preflight.find((c) => c.check === "capabilities").detail, /refreshed by launch hooks: test.extra/);
  // An empty answer is a replacement too: nothing of the provider's previous contribution remains.
  hook({});
  v = previewOf(home);
  assert.ok(!v.argv.includes("--hooked") && !v.argv.includes("--old"), JSON.stringify(v.argv));
  assert.deepEqual(v.environment.filter((e) => ["TEST_NEWVAR", "TEST_OLDVAR"].includes(e.name)), [], "no stale env from the provider");
  assert.match(v.preflight.find((c) => c.check === "capabilities").detail, /refreshed by launch hooks: test.extra/, "the run is recorded even for an empty answer");
  // An env name the provider did not declare is refused by the same rules as at spawn.
  hook({ env: { TEST_UNDECLARED: "x" } });
  let r = spawnSync(process.execPath, [CLI, "launch-config", "preview", "--home", home, "--launch-config", "codexy", "--json"], { encoding: "utf8", env: env() });
  let out = JSON.parse(r.stdout.trim()); assert.equal(out.ok, true, r.stdout);
  assert.equal(out.result.ok, false); assert.match(out.result.preflight.find((c) => c.check === "capabilities").detail, /TEST_UNDECLARED|environment contract/);
  // Ownership across retained and refreshed contributions: test.two (captured, no launch hook) retains TEST_SHARED from spawn; test.extra's hook may not take it.
  const meta2 = readJson(join(home, "instance.json"));
  const two = { capability: "test.two", layer: null, level: home, settings: {}, trust: { trusted: true, integrity: null }, launch: {}, env: ["TEST_SHARED"] };
  write(join(home, "instance.json"), JSON.stringify({ ...meta2, launch: { ...meta2.launch, hooks: { ...meta2.launch.hooks, env: { ...meta2.launch.hooks.env, TEST_SHARED: "owned-by-two" }, contributions: [...meta2.launch.hooks.contributions, two] } } }));
  hook({ env: { TEST_SHARED: "replacement-from-one" } });
  r = spawnSync(process.execPath, [CLI, "launch-config", "preview", "--home", home, "--launch-config", "codexy", "--json"], { encoding: "utf8", env: env() });
  out = JSON.parse(r.stdout.trim()); assert.equal(out.ok, true, r.stdout);
  assert.equal(out.result.ok, false); assert.match(out.result.preflight.find((c) => c.check === "capabilities").detail, /TEST_SHARED, which test.two contributed at spawn and retains/);
  write(join(home, "instance.json"), JSON.stringify(meta2));
  // A captured provider whose module copy is gone from the home refuses the start: a home is never re-resolved against the deployment.
  hook({});
  rmSync(join(home, ".oats", "modules", "test.extra"), { recursive: true, force: true });
  r = spawnSync(process.execPath, [CLI, "launch-config", "preview", "--home", home, "--launch-config", "codexy", "--json"], { encoding: "utf8", env: env() });
  out = JSON.parse(r.stdout.trim()); assert.equal(out.ok, true, r.stdout);
  assert.equal(out.result.ok, false); assert.match(out.result.preflight.find((c) => c.check === "capabilities").detail, /test.extra was part of this home's launch at spawn but its module copy is missing from .*; respawn the instance; nothing was stopped/);
  assert.doesNotMatch(out.result.preflight.find((c) => c.check === "capabilities").detail, /oats (install|trust)/, "the remedy names no removed verb");
});

test("0.25.5 launch-hook meta is persisted: after a successful start, each capability's launch `meta` lands in instance.json.capabilityMeta over the spawn's record; a hook that answers without meta keeps its prior entry; a failed launch leaves the record untouched", async () => {
  const name = "dev-renew";
  const home = homeOf(name, "renew");
  await makeHome(name, { soul: "renew", command: renderFor(home, name, join(binDir, "polite")), launch: recipeFor(home, name, { executable: join(binDir, "polite") }) });
  const hook = (answer) => write(join(home, "answer.json"), JSON.stringify(answer));
  // Captured provider (spawned from the soul's test.renew) with a spawn-time record: the ORIGINAL grant id, as spawn's hook wrote it.
  const meta0 = readJson(join(home, "instance.json"));
  const captured = { capability: "test.renew", layer: null, level: home, settings: {}, trust: { trusted: true, integrity: null }, launch: {}, env: [] };
  write(join(home, "instance.json"), JSON.stringify({ ...meta0, launch: { ...meta0.launch, hooks: { launch: {}, env: {}, contributions: [captured] } }, capabilityRuntime: [{ id: "test.renew", layer: null, level: repo, settings: {}, trust: { trusted: true, integrity: null }, hooks: { launch: "bin/launch.mjs" }, environment: [] }], capabilityMeta: { "test.renew": { grant: { id: "grant-original" } }, "test.other": { keep: true } } }));
  const start = () => { const r = spawnSync(process.execPath, [CLI, "session", "restart", "--home", home, "--launch-config", "codexy", "--json"], { encoding: "utf8", env: env() }); return { r, out: JSON.parse(r.stdout.trim()) }; };
  // 1. The hook renews: its meta replaces ITS entry; another capability's entry is untouched.
  hook({ meta: { grant: { id: "grant-renewed-1" } } });
  tmux("new-window", "-t", `${session}:`, "-n", name, "-c", home, "exec /bin/sh");
  await waitFor(() => inspectInstanceSession(home).state === "shell", "idle pane shell");
  let { r, out } = start(); assert.equal(out.ok, true, r.stdout + r.stderr);
  assert.ok(await waitFor(() => runningPid(home) !== null));
  let after = readJson(join(home, "instance.json"));
  assert.deepEqual(after.capabilityMeta, { "test.renew": { grant: { id: "grant-renewed-1" } }, "test.other": { keep: true } }, "launch meta persisted per capability; retire will revoke the renewed grant, not the original");
  // 2. A hook answering WITHOUT meta keeps its prior (renewed) entry.
  hook({});
  ({ r, out } = start()); assert.equal(out.ok, true, r.stdout + r.stderr);
  assert.ok(await waitFor(() => runningPid(home) !== null));
  after = readJson(join(home, "instance.json"));
  assert.deepEqual(after.capabilityMeta["test.renew"], { grant: { id: "grant-renewed-1" } }, "no meta → prior entry kept");
  // 3. A failed launch preparation leaves the record untouched (the hook's meta never reached instance.json).
  hook({ meta: { grant: { id: "grant-never-recorded" } }, env: { TEST_UNDECLARED: "x" } });
  ({ r, out } = start()); assert.equal(out.ok, false, r.stdout);
  after = readJson(join(home, "instance.json"));
  assert.deepEqual(after.capabilityMeta["test.renew"], { grant: { id: "grant-renewed-1" } }, "failed launch → record untouched");
});

test("0.30 launch-hook warnings: session start and restart answer them (JSON `warnings`, human output on stderr) and append each as a launch-warning event; a hook without warnings adds nothing", async () => {
  const name = "dev-warned";
  const home = homeOf(name, "renew");
  await makeHome(name, { soul: "renew", command: renderFor(home, name, join(binDir, "polite")), launch: recipeFor(home, name, { executable: join(binDir, "polite") }) });
  const meta0 = readJson(join(home, "instance.json"));
  const captured = { capability: "test.renew", layer: null, level: home, settings: {}, trust: { trusted: true, integrity: null }, launch: {}, env: [] };
  write(join(home, "instance.json"), JSON.stringify({ ...meta0, launch: { ...meta0.launch, hooks: { launch: {}, env: {}, contributions: [captured] } }, capabilityRuntime: [{ id: "test.renew", layer: null, level: repo, settings: {}, trust: { trusted: true, integrity: null }, hooks: { launch: "bin/launch.mjs" }, environment: [] }] }));
  const hook = (answer) => write(join(home, "answer.json"), JSON.stringify(answer));
  const run = (verb, json = true) => spawnSync(process.execPath, [CLI, "session", verb, "--home", home, ...(json ? ["--json"] : [])], { encoding: "utf8", env: env() });
  const warningEvents = () => readFileSync(join(home, ".oats-events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "launch-warning");
  hook({ warning: "grant expires in 2 days; renew it" });
  tmux("new-window", "-t", `${session}:`, "-n", name, "-c", home, "exec /bin/sh");
  await waitFor(() => inspectInstanceSession(home).state === "shell", "idle pane shell");
  // start --json
  let r = run("start"), out = JSON.parse(r.stdout.trim());
  assert.equal(out.ok, true, r.stdout + r.stderr);
  assert.deepEqual(out.result.warnings, ["grant expires in 2 days; renew it"]);
  assert.ok(await waitFor(() => runningPid(home) !== null));
  assert.deepEqual(warningEvents().map((e) => [e.producer, e.data]), [["kernel", { message: "grant expires in 2 days; renew it" }]]);
  // restart --json
  r = run("restart"); out = JSON.parse(r.stdout.trim());
  assert.equal(out.ok, true, r.stdout + r.stderr);
  assert.deepEqual(out.result.warnings, ["grant expires in 2 days; renew it"]);
  assert.ok(await waitFor(() => runningPid(home) !== null));
  assert.equal(warningEvents().length, 2);
  // Human output: the result, and each warning on stderr as spawn prints it.
  r = run("restart", false);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).warnings, ["grant expires in 2 days; renew it"], "stdout stays one JSON document");
  assert.match(r.stderr, /^ {2}WARNING: grant expires in 2 days; renew it$/m);
  assert.ok(await waitFor(() => runningPid(home) !== null));
  assert.equal(warningEvents().length, 3);
  // A hook with no warning: an empty list, no event, nothing printed.
  hook({});
  r = run("restart"); out = JSON.parse(r.stdout.trim());
  assert.equal(out.ok, true, r.stdout + r.stderr);
  assert.deepEqual(out.result.warnings, []);
  assert.ok(await waitFor(() => runningPid(home) !== null));
  r = run("restart", false);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stderr, /WARNING/);
  assert.ok(await waitFor(() => runningPid(home) !== null));
  assert.equal(warningEvents().length, 3, "no event for a hook without warnings");
  // #1749: the row stores the warning made safe and bounded (a newline, an ESC and a bidi override
  // replaced with U+FFFD, cut to 2048 UTF-16 code units ending in `…`); the answer keeps it as the hook said it.
  const dirty = `renew\nnow \u001b[2J \u202Eevil ${"x".repeat(3000)}`;
  hook({ warning: dirty });
  r = run("restart"); out = JSON.parse(r.stdout.trim());
  assert.equal(out.ok, true, r.stdout + r.stderr);
  assert.deepEqual(out.result.warnings, [dirty], "the answer keeps the original");
  assert.ok(await waitFor(() => runningPid(home) !== null));
  assert.deepEqual(warningEvents().at(-1).data, { message: `${"renew\uFFFDnow \uFFFD[2J \uFFFDevil " + "x".repeat(3000)}`.slice(0, 2047) + "…" });
});

test("package module drift appears on start and restart in JSON and text without moving frozen modules", async (t) => {
  const pkg = packageRepo();
  t.after(pkg.cleanup);
  const deployment = v2Deployment({ workspace: { packages: { "acme.pkg": `${pkg.ref}@v1.0.0` } } });
  t.after(deployment.cleanup);
  assert.equal(deployment.cli(["sync", "--json"]).status, 0);
  const homes = [];
  for (const name of ["driftjson", "drifttext"]) {
    const spawned = deployment.cli(["spawn", "acme.pkg/keeper", "--name", name, "--harness", "claude", "--no-launch", "--json"]);
    assert.equal(spawned.status, 0, spawned.stdout + spawned.stderr);
    const { home } = JSON.parse(spawned.stdout).result;
    const meta = readJson(join(home, "instance.json"));
    write(join(home, "instance.json"), JSON.stringify({ ...meta, tmux: { session, window: name, socket }, command: renderFor(home, name, join(binDir, "polite")), launch: recipeFor(home, name, { executable: join(binDir, "polite") }) }));
    write(join(home, ".oats", "upgrade-receipt.completed.json"), JSON.stringify({ action: "upgrade", status: "complete", idempotencyKey: "completed" }));
    homes.push({ name, home, modules: meta.modules, agents: readFileSync(join(home, "AGENTS.md"), "utf8"), skill: readFileSync(join(home, ".agents", "skills", "tool-skill", "SKILL.md"), "utf8") });
  }
  const next = pkg.release("1.1.0", { keeper: {} });
  deployment.commit({ "oats-workspace.yaml": { yaml: { schemaVersion: 2, name: "fixture", members: [deployment.ref], teams: { global: { description: "Fixture team" } }, defaults: { messaging: "none", tasks: "none", knowledge: "none" }, packages: { "acme.pkg": `${pkg.ref}@v1.1.0` } } } }, "bump package");
  assert.equal(deployment.cli(["sync", "--json"]).status, 0);
  const expected = [{ capability: "acme-tool", recorded: { version: "1.0.0", commit: pkg.commit1 }, locked: { version: "1.1.0", commit: next } }];
  try {
    for (const [i, f] of homes.entries()) {
      ensureSession(base);
      for (const verb of ["start", "restart"]) {
        const run = deployment.cli(["session", verb, "--home", f.home, ...(i === 0 ? ["--json"] : [])], { env: { PATH: process.env.PATH } });
        assert.equal(run.status, 0, run.stdout + run.stderr);
        const result = i === 0 ? JSON.parse(run.stdout).result : JSON.parse(run.stdout);
        assert.deepEqual(result.drift, expected);
        if (i === 1) assert.match(run.stderr, new RegExp(`1 package module\\(s\\) behind the lock \\(acme-tool 1.0.0 @ ${pkg.commit1.slice(0, 7)} → 1.1.0 @ ${next.slice(0, 7)}\\); to move them: oats instance stop ${f.name}; oats instance upgrade ${f.name} --plan`));
        assert.ok(await waitFor(() => runningPid(f.home) !== null));
        const after = readJson(join(f.home, "instance.json"));
        assert.deepEqual(after.modules, f.modules, "start and restart retain the recorded module copies");
        assert.equal(readFileSync(join(f.home, "AGENTS.md"), "utf8"), f.agents);
        assert.equal(readFileSync(join(f.home, ".agents", "skills", "tool-skill", "SKILL.md"), "utf8"), f.skill);
      }
    }
    // Commit drift also matters when a package keeps its version string.
    const lockPath = join(deployment.dep, "oats-lock.json");
    const locked = readJson(lockPath);
    locked.packages["acme.pkg"].version = "1.0.0";
    write(lockPath, JSON.stringify(locked));
    let run = deployment.cli(["session", "restart", "--home", homes[0].home, "--json"], { env: { PATH: process.env.PATH } });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.deepEqual(JSON.parse(run.stdout).result.drift, [{ ...expected[0], locked: { version: "1.0.0", commit: next } }]);
    // A removed package is kept, rather than being offered as an upgrade: no drift, and one warning
    // naming the respawn (an upgrade cannot move it), in the answer and as the text's WARNING line.
    delete locked.packages["acme.pkg"];
    write(lockPath, JSON.stringify(locked));
    const respawn = "1 package module(s) cannot move in place (acme-tool: package acme.pkg is no longer locked); an upgrade keeps them as they are, so respawn this instance to move it onto the lock";
    run = deployment.cli(["session", "restart", "--home", homes[0].home], { env: { PATH: process.env.PATH } });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(Object.hasOwn(JSON.parse(run.stdout), "drift"), false, "no drift preserves the existing start answer shape");
    assert.deepEqual(JSON.parse(run.stdout).warnings.filter((w) => /cannot move in place/.test(w)), [respawn]);
    assert.match(run.stderr, new RegExp(`^ {2}WARNING: ${respawn.replace(/[()]/g, "\\$&")}$`, "m"));
    assert.doesNotMatch(run.stderr, /package module\(s\) behind/);
  } finally {
    for (const f of homes) { try { tmux("kill-window", "-t", `=${session}:=${f.name}`); } catch { /* absent */ } }
  }
});

test("package module upgrade refreshes launch contributions without inheriting the prior environment", async () => {
  const name = "upgraded-refreshed";
  const home = homeOf(name, "renew");
  const old = { capability: "test.renew", layer: null, level: home, settings: {}, trust: { trusted: true, integrity: null }, launch: { claude: "--old-hook" }, env: ["TEST_UPGRADE_OLD_ENV"] };
  const launch = { ...recipeFor(home, name, { executable: join(binDir, "polite") }), hooks: { launch: old.launch, env: { TEST_UPGRADE_OLD_ENV: "old" }, contributions: [old] } };
  await makeHome(name, { soul: "renew", command: renderFor(home, name, join(binDir, "polite")), launch });
  ensureSession(base);
  try {
    const manifestPath = join(home, ".oats", "modules", "test.renew", "oats.json");
    const manifest = readJson(manifestPath);
    write(manifestPath, JSON.stringify({ ...manifest, environment: ["TEST_UPGRADE_OLD_ENV"] }));
    write(join(home, "answer.json"), JSON.stringify({ launch: { claude: "--old-hook" }, env: { TEST_UPGRADE_OLD_ENV: "old" } }));
    startInstanceSession(home, { env: env() });
    assert.ok(await waitFor(() => runningPid(home) !== null));
    assert.equal(paneEnvOf(home).TEST_UPGRADE_OLD_ENV, "old", "the old module's real launch supplied its environment");

    write(manifestPath, JSON.stringify({ ...manifest, environment: ["TEST_UPGRADE_NEW_ENV"] }));
    write(join(home, "answer.json"), JSON.stringify({ launch: { claude: "--new-hook" }, env: { TEST_UPGRADE_NEW_ENV: "new" } }));
    restartInstanceSession(home, { env: env() });
    assert.ok(await waitFor(() => runningPid(home) !== null));
    const args = readFileSync(join(home, "argv.txt"), "utf8");
    const actualEnv = paneEnvOf(home);
    assert.doesNotMatch(args, /--old-hook/);
    assert.match(args, /--new-hook/);
    assert.equal(actualEnv.TEST_UPGRADE_OLD_ENV, undefined, "the prior environment is not inherited after its declaration is removed");
    assert.equal(actualEnv.TEST_UPGRADE_NEW_ENV, "new");
    const current = readJson(join(home, "instance.json")).launch.hooks;
    assert.equal(Object.hasOwn(current.env, "TEST_UPGRADE_OLD_ENV"), false);
    assert.deepEqual(current.contributions[0].env, ["TEST_UPGRADE_NEW_ENV"]);
  } finally {
    try { tmux("kill-window", "-t", `=${session}:=${name}`); } catch { /* absent */ }
  }
});

test("a captured provider with no contribution at spawn still takes part (launch hook, conditional requirement); package probes run under the launch's effective environment, not the ambient one", async () => {
  // A wrapper that answers claude's plugin list only under the SELECTED environment; otherwise it is the polite harness.
  const wrapper = join(binDir, "claude-wrapper"); write(wrapper, `#!/bin/sh\nif [ "$1" = "plugin" ] && [ "$2" = "list" ]; then\n  if [ "$TEST_PROBE_TOKEN" = "selected" ]; then printf '[{"id":"chan@acme-marketplace","scope":"user","enabled":true}]'; else printf '[]'; fi\n  exit 0\nfi\nexec ${JSON.stringify(join(binDir, "polite"))} "$@"\n`); chmodSync(wrapper, 0o755);
  write(join(base, "probed.json"), JSON.stringify({ harness: "claude", executable: wrapper, env: { TEST_PROBE_TOKEN: "selected" } }));
  assert.equal(oats(["launch-config", "set", "probed", "--file", join(base, "probed.json"), "--dir", repo]).json.ok, true);
  // A captured provider (spawned from the soul's declaration, no contribution at spawn) declaring a launch hook and a requirement conditional on its captured settings; the spawn itself verified it under the selected configuration.
  const name = "dev-captured";
  const home = homeOf(name, "req");
  await makeHome(name, { soul: "req", command: renderFor(home, name, join(binDir, "polite")), launch: recipeFor(home, name, { executable: join(binDir, "polite") }), providers: { "test.req": { mode: "on" } }, launchConfig: "probed" });
  assert.deepEqual(readJson(join(home, "instance.json")).launch.hooks.contributions, [], "no contribution at spawn");
  const preview = (extra = {}, args = []) => { const r = spawnSync(process.execPath, [CLI, "launch-config", "preview", "--home", home, "--launch-config", "probed", ...args, "--json"], { encoding: "utf8", env: env(extra) }); const out = JSON.parse(r.stdout.trim()); assert.equal(out.ok, true, r.stdout + r.stderr); return out.result; };
  // The captured provider took part although it contributed nothing at spawn: its hook's args are in, its requirement was probed under the selected env and found.
  let v = preview();
  assert.ok(v.argv.includes("--req-hook"), JSON.stringify(v.argv));
  const pk = (x) => x.preflight.find((c) => c.check === "harness-packages");
  assert.equal(pk(v).ok, true, JSON.stringify(pk(v))); assert.match(pk(v).detail, /verified with .*claude-wrapper/);
  assert.equal(v.ok, true);
  // The configuration's environment wins over the ambient one: ambient says selected, the configuration says wrong -> the probe fails.
  write(join(base, "probed2.json"), JSON.stringify({ harness: "claude", executable: wrapper, env: { TEST_PROBE_TOKEN: "wrong" } }));
  assert.equal(oats(["launch-config", "set", "probed", "--file", join(base, "probed2.json"), "--dir", repo]).json.ok, true);
  v = preview({ TEST_PROBE_TOKEN: "selected" });
  assert.equal(pk(v).ok, false, JSON.stringify(pk(v))); assert.match(pk(v).detail, /chan@acme-marketplace/);
  // A reference to the source variable: resolved from the base for the probe; unset -> the environment check fails and nothing is probed.
  write(join(base, "probed3.json"), JSON.stringify({ harness: "claude", executable: wrapper, env: { TEST_PROBE_TOKEN: { fromEnv: "PROBE_SRC" } } }));
  assert.equal(oats(["launch-config", "set", "probed", "--file", join(base, "probed3.json"), "--dir", repo]).json.ok, true);
  v = preview({ PROBE_SRC: "selected" });
  assert.equal(pk(v).ok, true, JSON.stringify(pk(v)));
  v = preview();
  assert.equal(v.preflight.find((c) => c.check === "environment").ok, false); assert.equal(pk(v), undefined, "no probe without the reference");
  // The conditional requirement follows the CAPTURED settings: mode off -> no requirement, nothing probed.
  const meta = readJson(join(home, "instance.json"));
  write(join(home, "instance.json"), JSON.stringify({ ...meta, capabilityRuntime: [{ ...meta.capabilityRuntime[0], settings: { mode: "off" } }] }));
  v = preview({ PROBE_SRC: "wrong" });
  assert.equal(pk(v).ok, true); assert.match(pk(v).detail, /nothing probed|no harness package requirement/);
  // An applicable requirement plus configuration arguments: the probe cannot carry the arguments, so the launch is not reported verified (planner, and spawn before any side effect); without an applicable requirement, arguments are fine and nothing is probed.
  write(join(home, "instance.json"), JSON.stringify(meta));
  write(join(base, "probed-args.json"), JSON.stringify({ harness: "claude", executable: wrapper, args: ["--settings", "/abs/native.json"], env: { TEST_PROBE_TOKEN: "selected" } }));
  assert.equal(oats(["launch-config", "set", "probed", "--file", join(base, "probed-args.json"), "--dir", repo]).json.ok, true);
  v = preview();
  assert.equal(pk(v).ok, false, JSON.stringify(pk(v))); assert.match(pk(v).detail, /cannot carry.*test.req's requirement chan@acme-marketplace cannot be verified.*wrapper executable or the environment/); assert.equal(pk(v).code, "E_LAUNCH_PROBE_UNSUPPORTED");
  assert.throws(() => restartInstanceSession(home, { launchConfig: "probed", env: env() }), (e) => e.code === "E_LAUNCH_PROBE_UNSUPPORTED", "start/restart refuse before anything");
  write(join(home, "instance.json"), JSON.stringify({ ...meta, capabilityRuntime: [{ ...meta.capabilityRuntime[0], settings: { mode: "off" } }] }));
  v = preview();
  assert.equal(pk(v).ok, true); assert.match(pk(v).detail, /nothing probed|no harness package requirement/);
  // Spawn (a workspace deployment): the soul declares the provider with an applicable requirement; a new instance under the args configuration is refused before a home exists; with the requirement off (the provider payload), it spawns.
  const fx2 = v2Deployment({
    souls: { dev: { soul: { capabilities: { "test.req": { from: "here" } } } } },
    capabilities: { "test.req": { manifest: { hooks: { launch: "bin/launch.mjs" }, requires: [{ harness: "claude", package: "chan@acme-marketplace", marketplace: "acme/claude-plugins", when: { mode: "on" } }], settings: { mode: { description: "m" } } },
      files: { "bin/launch.mjs": `process.stdout.write(JSON.stringify({ launch: { claude: "--req-hook" }, env: {} }) + "\\n");\n` } } },
    local: { "launch-configs": { probed: { harness: "claude", executable: wrapper, args: ["--settings", "/abs/native.json"], env: { TEST_PROBE_TOKEN: "selected" } } } },
  });
  try {
    const saved = { HOME: process.env.HOME, OATS_REMOTE_CACHE: process.env.OATS_REMOTE_CACHE };
    Object.assign(process.env, { HOME: fx2.env.HOME, OATS_REMOTE_CACHE: fx2.env.OATS_REMOTE_CACHE });
    try {
      const spawnArgs1 = (mode) => fx2.spawn("dev", { instance: "dev-args1", launchConfig: "probed", providers: { "test.req": { mode } } });
      await assert.rejects(spawnArgs1("on"), (e) => e.code === "E_LAUNCH_PROBE_UNSUPPORTED"); assert.equal(existsSync(join(fx2.root, "dev", "instances", "dev-args1")), false);
      assert.ok((await spawnArgs1("off")).home, "with the requirement off, it spawns");
    } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  } finally { fx2.cleanup(); }
  write(join(home, "instance.json"), JSON.stringify(meta));
  // A provider the home did not capture does not take part, even with a launch hook and a requirement.
  write(join(home, "instance.json"), JSON.stringify({ ...meta, capabilityRuntime: [] }));
  v = preview({ PROBE_SRC: "wrong" });
  assert.ok(!v.argv.includes("--req-hook"), JSON.stringify(v.argv)); assert.match(pk(v).detail, /nothing probed|no harness package requirement/);
});

// ---- K3: stop plan → apply (recursive, retained, bounded, idempotent) and the retire plan ----
import { planStop, applyStop, planRetire, descendantsOf } from "../lib/instance-lifecycle.mjs";
import { retireClaimPath, stopInstanceSession } from "../lib/core.mjs";

test("K3 stop: plan reports real session/work facts and recorded children deepest-first; apply stops children before the parent, retains everything, records an idempotent receipt; stale revision refuses with the fresh plan", async () => {
  const root = fx.root;
  const mk = (name, extraMeta = {}) => makeHome(name, { command: renderFor(join(root, "dev", "instances", name), name, join(binDir, "polite")), launch: recipeFor(join(root, "dev", "instances", name), name, { executable: join(binDir, "polite") }), ...extraMeta });
  const parent = await mk("k3-parent"), child = await mk("k3-child"), grandchild = await mk("k3-grandchild");
  writeInstanceBackground(parent.home, true);
  for (const [h, p] of [[child.home, "k3-parent"], [grandchild.home, "k3-child"]]) { const m = readJson(join(h, "instance.json")); m.parentInstance = p; write(join(h, "instance.json"), JSON.stringify(m, null, 2)); }
  for (const h of [parent.home, child.home, grandchild.home]) { startInstanceSession(h, { env: env() }); assert.ok(await waitFor(() => runningPid(h) !== null)); }
  const kids = descendantsOf(root, "k3-parent");
  assert.deepEqual(kids.map((k) => [k.instance, k.depth]), [["k3-grandchild", 2], ["k3-child", 1]], "deepest first");
  rmSync(join(grandchild.home, "work"), { force: true });
  // A session's state is part of the plan revision: a pane still showing its launching shell reads "shell" for a
  // moment after the stand-in's pid appears. Plan once every target has settled, so two plans moments apart agree
  // (awebai/oats#345).
  assert.ok(await waitFor(() => planStop(repo, root, "k3-parent").targets.every((t) => t.session.present && t.session.state !== "shell")), "the sessions settle");
  const plan = planStop(repo, root, "k3-parent");
  assert.equal(plan.lifecycleApi, 1); assert.equal(plan.recursive, true);
  assert.deepEqual(plan.targets.map((t) => t.instance), ["k3-grandchild", "k3-child", "k3-parent"]);
  for (const t of plan.targets) {
    assert.equal(t.session.present, true); assert.notEqual(t.session.state, "shell"); assert.equal(t.midTask, true, "a running session is reported activity");
    // A spawned checkout home links <home>/work; one whose link is gone is NOT observed, never reported 'clean'.
    if (t.instance === "k3-grandchild") assert.equal(t.work.observed, false, "a checkout home without <home>/work: work is NOT observed, not 'clean'");
    else assert.equal(t.work.observed, true, `${t.instance}: the linked checkout is observed`);
  }
  assert.match(plan.planRevision, /^[a-f0-9]{24}$/);
  const nonRecursive = planStop(repo, root, "k3-parent", { recursive: false });
  assert.deepEqual(nonRecursive.targets.map((t) => t.instance), ["k3-parent"]); assert.deepEqual(nonRecursive.skipped.map((s) => s.instance).sort(), ["k3-child", "k3-grandchild"]);
  // Apply with a stale revision refuses and carries the fresh plan.
  assert.throws(() => applyStop(repo, root, "k3-parent", { planRevision: "0".repeat(24), idempotencyKey: "k1" }), (e) => e.code === "E_PLAN_STALE" && e.plan.planRevision === plan.planRevision);
  assert.throws(() => applyStop(repo, root, "k3-parent", { planRevision: plan.planRevision, idempotencyKey: "bad key!" }), (e) => e.code === "E_BAD_ARGS");
  for (const h of [parent.home, child.home, grandchild.home]) { assert.notEqual(runningPid(h), null, "refusals stopped nothing"); assert.equal(existsSync(retireClaimPath(h)), false, "and the stale apply, which took every target's claim to read its plan again, released it"); }
  const receipt = applyStop(repo, root, "k3-parent", { planRevision: plan.planRevision, idempotencyKey: "k3-once", graceMs: 5000 });
  assert.equal(receipt.ok, true); assert.equal(receipt.replayed, false);
  assert.deepEqual(receipt.results.map((r) => [r.instance, r.stopped]), [["k3-grandchild", true], ["k3-child", true], ["k3-parent", true]], "children first");
  assert.deepEqual(receipt.retained, ["home", "work", "transcript", "launch"]);
  // applyStop returns only once stopHarness has seen every signalled pid gone, so a harness still running here was
  // never signalled: the timeout names the pid, its process and the stop receipt (awebai/oats#526).
  const stopEvidence = (h) => { const pid = runningPid(h); let ps = null; try { ps = execFileSync("ps", ["-o", "pid=,ppid=,stat=,comm=", "-p", String(pid)], { encoding: "utf8" }).trim(); } catch { /* gone */ } let stop = null; try { stop = readJson(join(h, ".oats-stop.json")).stop; } catch { /* none */ } return JSON.stringify({ pid, ps, requested: stop?.requested?.map((r) => r.pid) ?? null, waitedMs: stop?.waitedMs ?? null, state: stop?.state ?? null }); };
  for (const h of [parent.home, child.home, grandchild.home]) { try { await waitFor(() => runningPid(h) === null, "harness gone"); } catch (e) { e.message += ` ${stopEvidence(h)}`; throw e; } assert.ok(existsSync(join(h, "instance.json")) && existsSync(join(h, "TASK.md")), "home retained"); }
  // A stop holds the home's lifecycle claim (beside the homes, the file a retire takes) for the span of the apply, and
  // writes no marker of its own into the home: `.oats-stop-pending.json` was an older kernel's.
  for (const h of [parent.home, child.home, grandchild.home]) { assert.equal(existsSync(join(h, ".oats-stop-pending.json")), false, "no stop marker is written into the home"); assert.equal(existsSync(dirname(retireClaimPath(h))), true, "the apply took the home's claim: its directory is there"); assert.equal(existsSync(retireClaimPath(h)), false, "and released it once the receipt was written"); }
  // Retry with the same key replays the receipt; a new plan says everything is idle.
  const replay = applyStop(repo, root, "k3-parent", { planRevision: "whatever", idempotencyKey: "k3-once" });
  assert.equal(replay.replayed, true); assert.deepEqual(replay.results, receipt.results);
  const after = planStop(repo, root, "k3-parent");
  for (const t of after.targets) assert.ok(["shell", "stopped"].includes(t.session.state), t.session.state);
  assert.notEqual(after.planRevision, plan.planRevision, "the revision follows the facts");
  // Restart still works from the retained launch configuration.
  const again = startInstanceSession(parent.home, { env: env() }); assert.ok(again.reused); assert.ok(await waitFor(() => runningPid(parent.home) !== null));
  const one = stopInstanceSession(parent.home, { graceMs: 5000 }); assert.equal(one.stopped, true);
  assert.equal(readInstanceBackground(parent.home), true, "stop and start keep the background record");
  assert.deepEqual(stopInstanceSession(parent.home), { home: parent.home, backend: "tmux", stopped: false, alreadyIdle: true, state: stopInstanceSession(parent.home).state, receipt: null }, "stopping an idle instance is a no-op that says so");
});

test("K3 stop: a SIGTERM-ignoring child is reported still running in the receipt (ok:false), nothing escalated; the parent is still stopped", async () => {
  const root = fx.root;
  const p = await makeHome("k3-p2", { command: renderFor(join(root, "dev", "instances", "k3-p2"), "k3-p2", join(binDir, "polite")), launch: recipeFor(join(root, "dev", "instances", "k3-p2"), "k3-p2", { executable: join(binDir, "polite") }) });
  const s = await makeHome("k3-stubborn-child", { command: renderFor(join(root, "dev", "instances", "k3-stubborn-child"), "k3-stubborn-child", join(binDir, "stubborn")), launch: recipeFor(join(root, "dev", "instances", "k3-stubborn-child"), "k3-stubborn-child", { executable: join(binDir, "stubborn") }) });
  { const m = readJson(join(s.home, "instance.json")); m.parentInstance = "k3-p2"; write(join(s.home, "instance.json"), JSON.stringify(m, null, 2)); }
  for (const h of [p.home, s.home]) { startInstanceSession(h, { env: env() }); assert.ok(await waitFor(() => runningPid(h) !== null)); }
  const stubbornPid = runningPid(s.home);
  const plan = planStop(repo, root, "k3-p2");
  const receipt = applyStop(repo, root, "k3-p2", { planRevision: plan.planRevision, idempotencyKey: "k3-two", graceMs: 1500 });
  assert.equal(receipt.ok, false);
  const kid = receipt.results.find((r) => r.instance === "k3-stubborn-child"), par = receipt.results.find((r) => r.instance === "k3-p2");
  assert.equal(kid.ok, false); assert.equal(kid.code, "E_SESSION_STOP_FAILED"); assert.deepEqual(kid.stillRunning, [stubbornPid]);
  assert.equal(par.ok, true); assert.equal(par.stopped, true);
  assert.equal(runningPid(s.home), stubbornPid, "the stubborn harness is untouched by any stronger signal");
  process.kill(stubbornPid, "SIGKILL"); // test cleanup only
});

test("K3 retire plan: facts with the design's defaults; pull request is UNKNOWN to the kernel; recorded children listed; ambiguity refuses", () => {
  const root = fx.root;
  const plan = planRetire(repo, root, "k3-p2");
  assert.equal(plan.action, "retire"); assert.equal(plan.facts.pullRequest, "unknown");
  assert.deepEqual(plan.defaults, { retainWorktree: false, deleteBranch: false, stopChildren: true, retainChildren: true }, "checkout mode: nothing to re-home");
  assert.deepEqual(plan.facts.children.map((c) => c.instance), ["k3-stubborn-child"]);
  assert.ok(plan.notes.some((n) => /pull request state is unknown/.test(n)));
  assert.throws(() => planRetire(repo, root, "nope-1"), (e) => e.code === "E_SESSION_UNKNOWN");
});

// ---- K7: typed lifecycle events ----
import { readEvents, appendEvent } from "../lib/instance-events.mjs";
test("K7 events: stop/restart/retire write producer-attributed events to the home AND the workspace log; the workspace log survives retirement; waitingOnYou is null unless a producer said so; window bounded", async () => {
  const root = fx.root;
  const name = "k7-ev";
  const { home } = await makeHome(name, { command: renderFor(join(root, "dev", "instances", name), name, join(binDir, "polite")), launch: recipeFor(join(root, "dev", "instances", name), name, { executable: join(binDir, "polite") }) });
  startInstanceSession(home, { env: env() }); assert.ok(await waitFor(() => runningPid(home) !== null));
  const one = stopInstanceSession(home, { graceMs: 5000 }); assert.equal(one.stopped, true);
  const ev = readEvents(home);
  assert.equal(ev.eventsApi, 2); assert.deepEqual(ev.events.map((e) => e.kind), ["spawned", "launched", "stopped"], "the spawn's event, the start's launch, then the stop"); assert.equal(ev.events[1].data.phase, "start"); assert.equal(ev.events[1].data.backend, "tmux"); assert.equal(ev.events[2].producer, "kernel"); assert.equal(ev.events[2].data.signal, "SIGTERM");
  assert.equal(ev.waitingOnYou, null); assert.equal(ev.lastEvent.kind, "stopped");
  assert.ok(existsSync(join(home, ".oats-events.jsonl")) && existsSync(join(repo, ".agents", "events", `dev--${name}.jsonl`)), "both logs");
  // A producer claim is the only way waitingOnYou becomes non-null.
  appendEvent(home, { kind: "launched", producer: "test.provider", data: { waitingOnYou: true, reason: "question" } });
  const ev2 = readEvents(home); assert.deepEqual(ev2.waitingOnYou, { since: ev2.events.at(-1).at, producer: "test.provider", reason: "question", message: null });
  assert.equal(appendEvent(home, { kind: "made-up" }).ok, false, "unknown kinds are refused, never recorded");
  assert.equal(readEvents(home, { limit: 1 }).returned, 1); assert.equal(readEvents(home, { limit: 1 }).truncated, true);
  // Retire: 'retired' is written; the workspace log outlives the home.
  const r = oats(["retire", name, "--dir", repo]); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(existsSync(home), false);
  const after = readEvents(home);
  assert.ok(after.events.some((e) => e.kind === "retired"), JSON.stringify(after.events.map((e) => e.kind)));
  assert.ok(after.events.some((e) => e.kind === "stopped"), "earlier events survive in the workspace log");
});

test("K3 pins: guarded retire STOPS recorded children first and refuses (E_CHILDREN_RUNNING, nothing retired) if one ignores SIGTERM; stop receipts replay per key; ambiguous parent edges are reported, never acted on", async () => {
  const root = fx.root;
  const mk = (name, exe = "polite") => makeHome(name, { command: renderFor(join(root, "dev", "instances", name), name, join(binDir, exe)), launch: recipeFor(join(root, "dev", "instances", name), name, { executable: join(binDir, exe) }) });
  const parent = await mk("pin-parent"), politeKid = await mk("pin-kid-polite"), stubbornKid = await mk("pin-kid-stubborn", "stubborn");
  for (const h of [politeKid.home, stubbornKid.home]) { const m = readJson(join(h, "instance.json")); m.parentInstance = "pin-parent"; write(join(h, "instance.json"), JSON.stringify(m, null, 2)); }
  for (const h of [parent.home, politeKid.home, stubbornKid.home]) { startInstanceSession(h, { env: env() }); assert.ok(await waitFor(() => runningPid(h) !== null)); }
  const stubbornPid = runningPid(stubbornKid.home);
  const plan = oats(["retire", "pin-parent", "--plan", "--dir", repo]).json.result;
  assert.deepEqual(plan.facts.children.map((c) => c.instance).sort(), ["pin-kid-polite", "pin-kid-stubborn"]);
  // Pin 1: children are stopped FIRST; the stubborn one refuses the whole retirement.
  const refused = oats(["retire", "pin-parent", "--plan-revision", plan.planRevision, "--idempotency-key", "r-1", "--dir", repo]);
  assert.equal(refused.status, 1); assert.equal(refused.json.error.code, "E_CHILDREN_RUNNING");
  const stopped = refused.json.error.details.childrenStopped;
  assert.equal(stopped.find((k) => k.instance === "pin-kid-polite").ok, true, "the polite child was stopped");
  assert.deepEqual(stopped.find((k) => k.instance === "pin-kid-stubborn").stillRunning, [stubbornPid]);
  assert.ok(existsSync(parent.home) && runningPid(parent.home) !== null, "nothing retired: the parent still runs");
  assert.equal(runningPid(stubbornKid.home), stubbornPid, "nothing escalated");
  process.kill(stubbornPid, "SIGKILL"); await waitFor(() => runningPid(stubbornKid.home) === null, "test cleanup");
  // Pin 3: stop receipts replay per key, not only the last one.
  await waitFor(() => runningPid(politeKid.home) === null); startInstanceSession(politeKid.home, { env: env() }); assert.ok(await waitFor(() => runningPid(politeKid.home) !== null));
  const p1 = planStop(repo, root, "pin-kid-polite"); const a = applyStop(repo, root, "pin-kid-polite", { planRevision: p1.planRevision, idempotencyKey: "s-A" });
  assert.equal(a.ok, true); await waitFor(() => runningPid(politeKid.home) === null);
  startInstanceSession(politeKid.home, { env: env() }); assert.ok(await waitFor(() => runningPid(politeKid.home) !== null));
  const p2 = planStop(repo, root, "pin-kid-polite"); const b = applyStop(repo, root, "pin-kid-polite", { planRevision: p2.planRevision, idempotencyKey: "s-B" });
  assert.equal(b.ok, true);
  const replayA = applyStop(repo, root, "pin-kid-polite", { planRevision: "irrelevant", idempotencyKey: "s-A" });
  assert.equal(replayA.replayed, true); assert.equal(replayA.at, a.at, "an EARLIER key replays its own receipt after a later key was used");
  // Pin 4: a child whose parent NAME is not unique under the root is reported as ambiguous and excluded.
  const twinDir = join(root, "ops"); mkdirSync(join(twinDir, "soul"), { recursive: true });
  write(join(twinDir, "soul", "soul.yaml"), "name: ops\nrepo: .\nwork: checkout\nharness: claude\n"); write(join(twinDir, "soul", "AGENTS.md"), "# ops\n");
  const twinHome = join(twinDir, "instances", "pin-parent"); write(join(twinHome, "instance.json"), JSON.stringify({ agent: "ops", instance: "pin-parent", home: twinHome, repo, work: "checkout", branch: null, launched: false }));
  const kids = descendantsOf(root, "pin-parent");
  assert.deepEqual(kids.map((k) => k.instance), [], "no edge is followed to a non-unique parent name");
  assert.deepEqual(kids.ambiguous.map((k) => k.instance).sort(), ["pin-kid-polite", "pin-kid-stubborn"]);
  const amb = planStop(repo, root, "pin-parent", { home: parent.home });
  assert.deepEqual(amb.targets.map((t) => t.instance), ["pin-parent"]); assert.equal(amb.ambiguous.length, 2); assert.ok(amb.notes.some((n) => /not unique/.test(n)));
  rmSync(twinDir, { recursive: true, force: true });
});

// #778: every apply path of `oats retire` does what its plan says about recorded children: stopped
// first (bounded, never escalated) and kept; one still running refuses the retirement.
const kidHome = async (name, parent, { exe = "polite", ...spawn } = {}) => {
  const h = await makeHome(name, { command: renderFor(homeOf(name), name, join(binDir, exe)), launch: recipeFor(homeOf(name), name, { executable: join(binDir, exe) }), ...spawn });
  const m = readJson(join(h.home, "instance.json")); m.parentInstance = parent; write(join(h.home, "instance.json"), JSON.stringify(m, null, 2) + "\n");
  return h;
};
const launched = async (...homes) => { for (const h of homes) { startInstanceSession(h, { env: env() }); assert.ok(await waitFor(() => runningPid(h) !== null)); } };
const eventKinds = (home) => readEvents(home).events.map((e) => e.kind);

test("#778 T1: plain retire stops recorded children (attached included) as its plan says, keeps them, and names them in the receipt and the text", async () => {
  const parent = await kidHome("c778-parent", null);
  const kid = await kidHome("c778-kid", "c778-parent");
  const attached = await kidHome("c778-attached", "c778-parent", { work: "attached", workDir: join(parent.home, "work") });
  await launched(parent.home, kid.home, attached.home);
  const plan = oats(["retire", "c778-parent", "--plan", "--dir", repo]).json.result;
  assert.deepEqual(plan.facts.children.map((c) => c.instance).sort(), ["c778-attached", "c778-kid"]);
  assert.ok(plan.notes.some((n) => /recorded child instance\(s\) are stopped first/.test(n)), JSON.stringify(plan.notes));
  const r = spawnSync(process.execPath, [CLI, "retire", "c778-parent", "--dir", repo], { encoding: "utf8", env: env() });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const name of ["c778-kid", "c778-attached"]) assert.match(r.stdout, new RegExp(`^  child ${name}: stopped$`, "m"), r.stdout);
  assert.equal(existsSync(parent.home), false, "the parent is retired");
  for (const h of [kid.home, attached.home]) {
    assert.ok(await waitFor(() => runningPid(h) === null, "child stopped"));
    assert.ok(existsSync(h), "the child is kept");
    assert.ok(eventKinds(h).includes("stopped"), JSON.stringify(eventKinds(h)));
  }
  // The JSON receipt carries the same outcome, deepest first.
  const again = await kidHome("c778-parent-j", null), jkid = await kidHome("c778-kid-j", "c778-parent-j");
  await launched(again.home, jkid.home);
  const j = oats(["retire", "c778-parent-j", "--dir", repo]);
  assert.equal(j.status, 0, j.stdout + j.stderr);
  assert.deepEqual(j.json.childrenStopped.map(({ instance, ok, stopped, alreadyIdle }) => ({ instance, ok, stopped, alreadyIdle })), [{ instance: "c778-kid-j", ok: true, stopped: true, alreadyIdle: false }]);
  assert.ok(existsSync(jkid.home) && runningPid(jkid.home) === null);
});

test("#778 T2: plain retire refuses (E_CHILDREN_RUNNING, nothing retired, not bypassed by --force) when a child ignores SIGTERM", async () => {
  const parent = await kidHome("c778-p2", null), kid = await kidHome("c778-k2", "c778-p2", { exe: "stubborn" });
  await launched(parent.home, kid.home);
  const kidPid = runningPid(kid.home);
  const refused = oats(["retire", "c778-p2", "--force", "--dir", repo]);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.equal(refused.json.error.code, "E_CHILDREN_RUNNING");
  const [k] = refused.json.error.details.childrenStopped;
  assert.equal(k.instance, "c778-k2"); assert.equal(k.ok, false); assert.equal(k.code, "E_SESSION_STOP_FAILED"); assert.deepEqual(k.stillRunning, [kidPid]);
  assert.equal(refused.json.error.details.plan, undefined, "the plan travels only with a guarded apply");
  assert.ok(existsSync(parent.home) && existsSync(join(parent.home, "work")) && runningPid(parent.home) !== null, "nothing retired: the parent still runs");
  assert.equal(runningPid(kid.home), kidPid, "nothing escalated");
  assert.ok(eventKinds(kid.home).includes("stop-refused"), JSON.stringify(eventKinds(kid.home)));
  assert.ok(!eventKinds(parent.home).includes("retired"));
  // The text names the child and why it counts as running.
  const text = spawnSync(process.execPath, [CLI, "retire", "c778-p2", "--dir", repo], { encoding: "utf8", env: env() });
  assert.notEqual(text.status, 0);
  assert.match(text.stderr, /children still running: c778-k2 \(E_SESSION_STOP_FAILED\); nothing retired/, text.stderr);
  process.kill(kidPid, "SIGKILL"); await waitFor(() => runningPid(kid.home) === null, "test cleanup");
  assert.equal(oats(["retire", "c778-p2", "--dir", repo]).status, 0, "retires once the child is stopped");
});

test("#778 T3: plain retire with an already idle child succeeds and leaves the child untouched", async () => {
  const parent = await kidHome("c778-p3", null), kid = await kidHome("c778-k3", "c778-p3");
  await launched(parent.home);
  const before = eventKinds(kid.home);
  const r = oats(["retire", "c778-p3", "--dir", repo]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json.childrenStopped.map(({ instance, ok, stopped, alreadyIdle }) => ({ instance, ok, stopped, alreadyIdle })), [{ instance: "c778-k3", ok: true, stopped: false, alreadyIdle: true }]);
  assert.ok(existsSync(kid.home)); assert.deepEqual(eventKinds(kid.home), before, "no event for an idle child");
  // A retire without recorded children carries no childrenStopped at all.
  const lone = await kidHome("c778-lone", null); await launched(lone.home);
  const l = oats(["retire", "c778-lone", "--dir", repo]);
  assert.equal(l.status, 0, l.stdout + l.stderr); assert.equal(Object.hasOwn(l.json, "childrenStopped"), false);
  // A guarded receipt always carries it: the Desktop rejects a receipt without the array.
  const g = await kidHome("c778-guarded-lone", null); await launched(g.home);
  const gp = oats(["retire", "c778-guarded-lone", "--plan", "--dir", repo]).json.result;
  const gr = oats(["retire", "c778-guarded-lone", "--plan-revision", gp.planRevision, "--idempotency-key", "c778-g", "--dir", repo]);
  assert.equal(gr.status, 0, gr.stdout + gr.stderr); assert.deepEqual(gr.json.childrenStopped, []);
});

test("#778 T4: a deferred --self retirement stops recorded children before it retires the caller; a refusing child fails the completion and keeps the home", async () => {
  const selfRetire = (name, home) => spawnSync(process.execPath, [CLI, "retire", name, "--self", "--dir", repo, "--json"], { encoding: "utf8", env: { ...env(), OATS_INSTANCE: name, OATS_INSTANCE_HOME: home } });
  const parent = await kidHome("c778-p4", null), kid = await kidHome("c778-k4", "c778-p4");
  await launched(parent.home, kid.home);
  const s = selfRetire("c778-p4", parent.home);
  assert.equal(s.status, 0, s.stdout + s.stderr);
  const scheduled = JSON.parse(s.stdout); assert.equal(scheduled.deferred, true);
  assert.ok(await waitUntil(() => !existsSync(parent.home), "the deferred completion", 60000));
  assert.equal(existsSync(scheduled.resultPath), false, "a successful completion leaves no result file");
  assert.ok(existsSync(kid.home) && runningPid(kid.home) === null, "the child is stopped and kept");
  assert.ok(eventKinds(kid.home).includes("stopped"), JSON.stringify(eventKinds(kid.home)));
  // A child recorded when the retirement was scheduled and retired before the completion runs is
  // no longer a child: it neither refuses the retirement nor counts as running.
  const p6 = await kidHome("c778-p6", null), k6 = await kidHome("c778-k6", "c778-p6");
  await launched(p6.home);
  const s6 = selfRetire("c778-p6", p6.home);
  assert.equal(s6.status, 0, s6.stdout + s6.stderr);
  const r6 = oats(["retire", "c778-k6", "--dir", repo]); assert.equal(r6.status, 0, r6.stdout + r6.stderr);
  assert.equal(existsSync(k6.home), false);
  assert.ok(await waitUntil(() => !existsSync(p6.home) || existsSync(JSON.parse(s6.stdout).resultPath), "the deferred completion", 60000));
  assert.equal(existsSync(p6.home), false, existsSync(JSON.parse(s6.stdout).resultPath) ? readFileSync(JSON.parse(s6.stdout).resultPath, "utf8") : "");
  // A child that ignores SIGTERM: the completion refuses before it quiesces the caller.
  const p5 = await kidHome("c778-p5", null), k5 = await kidHome("c778-k5", "c778-p5", { exe: "stubborn" });
  await launched(p5.home, k5.home);
  const k5Pid = runningPid(k5.home);
  const s5 = selfRetire("c778-p5", p5.home);
  assert.equal(s5.status, 0, s5.stdout + s5.stderr);
  const { resultPath, pendingMarker, completionPid } = JSON.parse(s5.stdout);
  assert.ok(Number.isSafeInteger(completionPid), "fixture premise: the scheduling names its completion");
  assert.ok(await waitUntil(() => existsSync(resultPath), "the completion's failure result", 60000));
  const result = readJson(resultPath);
  assert.equal(result.ok, false); assert.equal(result.error.code, "E_CHILDREN_RUNNING");
  assert.deepEqual(result.childrenStopped.map(({ instance, ok, stillRunning }) => ({ instance, ok, stillRunning })), [{ instance: "c778-k5", ok: false, stillRunning: [k5Pid] }]);
  assert.match(result.retry, /^oats retire c778-p5/);
  assert.ok(existsSync(p5.home), "the home is kept");
  // Refused before a hook was started or anything of the home was removed: the caller is not being
  // retired, and the completion takes its pending marker away (awebai/oats#954). It writes its
  // outcome first and removes the marker after, so the marker is read once the completion has ended.
  await waitUntil(() => { try { process.kill(completionPid, 0); return false; } catch (e) { return e.code === "ESRCH"; } }, "the completion to end", 60000);
  assert.equal(existsSync(pendingMarker), false, "the pending marker is removed: nothing of the home was changed");
  assert.ok(runningPid(p5.home) !== null, "the caller was not quiesced");
  process.kill(k5Pid, "SIGKILL"); await waitFor(() => runningPid(k5.home) === null, "test cleanup");
  assert.equal(oats(["retire", "c778-p5", "--dir", repo]).status, 0, "an external retry completes it");
});

test("session recompose is removed (0.26): E_UNKNOWN_COMMAND naming the re-spawn, and the feature is no longer advertised", async () => {
  const h = await makeHome("recompose-gone");
  const cli = oats(["session", "recompose", "--home", h.home, "--dry-run"]);
  assert.notEqual(cli.status, 0); assert.equal(cli.json.error.code, "E_UNKNOWN_COMMAND"); assert.match(cli.json.error.message, /re-spawn/);
  assert.ok(!oats(["version"]).json.features.includes("session-recompose"));
});

test("team model 3: a session start's launch hook gets the home's LIVE teams — a shared team created after the spawn is seen, a team the workspace takes from the soul disappears — while modules and the spawn-time record stay frozen", async () => {
  const name = "teamed-live";
  const home = homeOf(name, "teamed");
  await makeHome(name, { soul: "teamed", command: renderFor(home, name, join(binDir, "polite")), launch: recipeFor(home, name, { executable: join(binDir, "polite") }) });
  const MINE = { label: "mine", team: "aweb:fixture.mine", default: false, from: "local", via: ["local"] };
  const NIGHT = { label: "night", team: "aweb:fixture.night", default: false, from: "shared", via: ["workspace"] };
  const spawned = readJson(join(home, "instance.json"));
  assert.deepEqual([spawned.teams, spawned.defaultTeam], [[MINE], null], "spawn records the mapped teams as evidence (night has no id yet)");
  const seedWorkspace = join(fx.base, "seed", "oats-workspace.yaml");
  const localFile = join(fx.dep, "oats-local.yaml");
  const { parse, stringify } = await import("yaml");
  const restart = async () => {
    rmSync(join(home, "teams-env.json"), { force: true });
    const r = spawnSync(process.execPath, [CLI, "session", "restart", "--home", home, "--json"], { encoding: "utf8", env: env({ OATS_REMOTE_CACHE: fx.remoteOptions.cacheDir }) });
    assert.equal(JSON.parse(r.stdout.trim()).ok, true, r.stdout + r.stderr);
    assert.ok(await waitFor(() => runningPid(home) !== null));
    return readJson(join(home, "teams-env.json"));
  };
  try { tmux("has-session", "-t", session); } catch { tmux("new-session", "-d", "-s", session, "-n", "hq", "-c", home); }
  tmux("new-window", "-t", `${session}:`, "-n", name, "-c", home, "exec /bin/sh");
  await waitFor(() => inspectInstanceSession(home).state === "shell", "idle pane shell");
  // The shared night team gets its id AFTER the spawn: the next start's hook sees it.
  const ws = parse(readFileSync(seedWorkspace, "utf8"));
  ws.teams.night = { ...ws.teams.night, team: "aweb:fixture.night" };
  fx.commit({ "oats-workspace.yaml": stringify(ws, { lineWidth: 0 }) }, "create night");
  let seen = await restart();
  assert.deepEqual(seen, { old: [null, null], def: null, source: "live", teams: [MINE, NIGHT] }, "the launch hook may act on leaves: the list is live");
  // …and the workspace taking night from the soul takes it away again.
  const ws2 = parse(readFileSync(seedWorkspace, "utf8"));
  ws2.souls["ws/teamed"] = { teams: [] };
  fx.commit({ "oats-workspace.yaml": stringify(ws2, { lineWidth: 0 }) }, "teamed: default only");
  seen = await restart();
  assert.deepEqual(seen.teams, [MINE]);
  const after = readJson(join(home, "instance.json"));
  assert.deepEqual(after.modules, spawned.modules, "modules stay frozen");
  assert.deepEqual(after.teams, spawned.teams, "the spawn-time record is evidence, never rewritten");
});

test("a 0.26.0 home (instance.json `runtime`, a version-1 recipe) inspects, restarts on its recipe and is recorded in the new names, then retires; each command answers one deprecated-runtime-name warning (lead call 6)", async () => {
  const name = "dev-v026";
  const { home } = await makeHome(name, { command: renderFor(homeOf(name), name, join(binDir, "polite")), launch: recipeFor(homeOf(name), name, { executable: join(binDir, "polite") }) });
  // The same home in 0.26.0's names.
  const { harness, launch, ...rest } = readJson(join(home, "instance.json"));
  const { harness: recipeHarness, ...recipe } = launch;
  write(join(home, "instance.json"), JSON.stringify({ ...rest, runtime: harness, launch: { ...recipe, version: 1, runtime: recipeHarness } }, null, 2) + "\n");
  const warned = (r, what) => {
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.json.warnings?.length, 1, `${what}: ${r.stdout}`);
    assert.equal(r.json.warnings[0].code, "deprecated-runtime-name");
    assert.match(r.json.warnings[0].message, /`runtime` was renamed to `harness` in 0\.27\.0/);
    assert.ok(r.json.warnings[0].sources.some((s) => s.includes(`instance.json of ${home}`)), JSON.stringify(r.json.warnings));
  };
  const inspected = oats(["inspect", "--home", home]);
  warned(inspected, "inspect");
  assert.equal(inspected.json.result.instance.harness, "claude", "runtime is read as harness");
  const status = oats(["status", "--dir", repo]);
  warned(status, "status");
  assert.equal(status.json.agents.flatMap((a) => a.instances).find((i) => i.instance === name)?.harness, "claude", "the roster (a bare document) carries the warning beside its rows");
  assert.deepEqual(Object.keys(readJson(join(home, "instance.json"))).filter((k) => k === "runtime"), ["runtime"], "reading rewrites nothing");
  const started = oats(["session", "restart", "--home", home, "--stop-grace", "5"]);
  warned(started, "restart");
  assert.equal(started.json.result.harness, "claude");
  assert.ok(await waitFor(() => runningPid(home) !== null), "the recipe's harness is up");
  const meta = readJson(join(home, "instance.json"));
  assert.equal(Object.hasOwn(meta, "runtime"), false, "the start records the new names");
  assert.equal(meta.harness, "claude");
  assert.equal(meta.launch.version, 2); assert.equal(meta.launch.harness, "claude"); assert.equal(Object.hasOwn(meta.launch, "runtime"), false);
  assert.equal(meta.launch.executable, join(binDir, "polite"), "the same recipe, re-recorded");
  const quiet = oats(["inspect", "--home", home]);
  assert.equal(quiet.status, 0); assert.equal(Object.hasOwn(quiet.json, "warnings"), false, "a rewritten home is read without a warning");
  assert.equal(stopInstanceSession(home, { graceMs: 5000 }).stopped, true);
  const r = oats(["retire", name, "--dir", repo]); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(existsSync(home), false);
});

// #691: the receipt of a start instance.json already records (same start id, same target) is
// history, never authority. Reconciling it writes nothing; a plain start while it runs answers
// E_SESSION_RUNNING before any write or hook; a restart, or a start after the target is gone, retires
// it and starts from instance.json as it is. A genuinely interrupted start is still adopted. The
// provider's metadata changes only through a supported path: its launch hook answering from the
// provider's own state (<home>/answer.json). instance.json is never edited after setup.
test("#691 a completed start's receipt is never recorded again: no write, no hook run, newest meta kept; an interrupted start is still adopted", async () => {
  const name = "dev-receipt";
  const home = homeOf(name, "renew");
  await makeHome(name, { soul: "renew", command: renderFor(home, name, join(binDir, "polite")), launch: recipeFor(home, name, { executable: join(binDir, "polite") }) });
  const meta0 = readJson(join(home, "instance.json"));
  const captured = { capability: "test.renew", layer: null, level: home, settings: {}, trust: { trusted: true, integrity: null }, launch: {}, env: [] };
  write(join(home, "instance.json"), JSON.stringify({ ...meta0, launch: { ...meta0.launch, hooks: { launch: {}, env: {}, contributions: [captured] } }, capabilityRuntime: [{ id: "test.renew", layer: null, level: repo, settings: {}, trust: { trusted: true, integrity: null }, hooks: { launch: "bin/launch.mjs" }, environment: [] }], capabilityMeta: { "test.renew": { grant: { id: "grant-original" } } } }));
  const provider = (answer) => write(join(home, "answer.json"), JSON.stringify(answer)); // the provider's own state
  const metaPath = join(home, "instance.json"), pendingPath = join(home, ".oats-start-pending.json");
  const ino = (p) => statSync(p).ino;
  const hookRuns = () => { try { return readFileSync(join(home, ".oats-events.jsonl"), "utf8").split("\n").filter((l) => l.includes("provider hook ran")).length; } catch { return 0; } };
  const grant = () => readJson(metaPath).capabilityMeta["test.renew"].grant.id;
  const restart = (o = {}) => restartInstanceSession(home, { launchConfig: "codexy", env: env(), stopGraceMs: 5000, ...o });
  try { tmux("has-session", "-t", session); } catch { tmux("new-session", "-d", "-s", session, "-n", "hq", "-c", home); }
  tmux("new-window", "-t", `${session}:`, "-n", name, "-c", home, "exec /bin/sh");
  await waitFor(() => inspectInstanceSession(home).state === "shell", "idle pane shell");

  // A start completes: its receipt stays, naming the start instance.json records, on the recorded target.
  provider({ meta: { grant: { id: "grant-1" } }, warning: "provider hook ran" });
  restart();
  assert.ok(await waitFor(() => runningPid(home) !== null));
  const pending1 = readJson(pendingPath);
  assert.equal(pending1.id, readJson(metaPath).startId, "the receipt is the recorded start's");
  assert.equal(grant(), "grant-1");

  // (a)+(e) Plain start while it runs: E_SESSION_RUNNING, and nothing written: no instance.json or receipt
  // write (a write replaces the file: a new inode), no launch hook run.
  const before = { meta: readFileSync(metaPath, "utf8"), metaIno: ino(metaPath), pending: readFileSync(pendingPath, "utf8"), pendingIno: ino(pendingPath), runs: hookRuns() };
  const unchanged = (what) => assert.deepEqual({ meta: readFileSync(metaPath, "utf8"), metaIno: ino(metaPath), pending: readFileSync(pendingPath, "utf8"), pendingIno: ino(pendingPath), runs: hookRuns() }, before, what);
  for (const o of [{}, { model: "claude-x" }, { launchConfig: "polite" }]) {
    assert.throws(() => startInstanceSession(home, { env: env(), ...o }), (e) => e.code === "E_SESSION_RUNNING", JSON.stringify(o));
    unchanged(`plain start ${JSON.stringify(o)}: nothing written, no hook run`);
  }
  // A restart refused in its preflight leaves instance.json and the receipt as they were.
  assert.throws(() => restart({ launchConfig: "nope" }), (e) => e.code === "E_LAUNCH_CONFIG_UNKNOWN");
  unchanged("a refused restart: nothing written, the receipt kept");

  // (c) The provider's state moves on; each restart records the newest meta (the regression lock is the
  // no-write check above: through supported paths the receipt and instance.json agree here).
  for (const id of ["grant-2", "grant-3"]) {
    provider({ meta: { grant: { id } }, warning: "provider hook ran" });
    const pid = runningPid(home);
    const r = restart();
    assert.ok(await waitFor(() => runningPid(home) !== null && runningPid(home) !== pid));
    assert.equal(grant(), id, `restart to ${id}: the newest provider meta`);
    assert.ok(r.startedAt); assert.equal(readJson(pendingPath).id, readJson(metaPath).startId, "a new receipt for the new start");
  }
  // A restart whose hook answers no meta keeps the newest one (grant-3), not the previous receipt's.
  provider({});
  { const pid = runningPid(home); restart(); assert.ok(await waitFor(() => runningPid(home) !== null && runningPid(home) !== pid)); }
  assert.equal(grant(), "grant-3");

  // An ordinary restart under another launch configuration: the receipt retired, the new configuration recorded.
  provider({ meta: { grant: { id: "grant-4" } } });
  { const pid = runningPid(home); const count = readJson(metaPath).restartCount;
    const r = restart({ launchConfig: "polite", env: env({ RESTART_TEST_SRC: "x" }) });
    assert.ok(await waitFor(() => runningPid(home) !== null && runningPid(home) !== pid));
    const m = readJson(metaPath);
    assert.equal(r.launchConfig, "polite"); assert.equal(m.launch.launchConfig, "polite"); assert.equal(m.restartCount, count + 1); assert.equal(m.capabilityMeta["test.renew"].grant.id, "grant-4");
    assert.equal(readJson(pendingPath).id, m.startId); }

  // A target that is gone: the completed receipt is retired and the start runs from instance.json as it is.
  provider({ meta: { grant: { id: "grant-5" } } });
  tmux("kill-window", "-t", `${session}:${name}`);
  await waitFor(() => runningPid(home) === null || !windows().includes(name), "window gone");
  { const count = readJson(metaPath).restartCount;
    const r = startInstanceSession(home, { env: env({ RESTART_TEST_SRC: "x" }) });
    assert.equal(r.reused, "new"); assert.equal(r.launchConfig, "polite", "the recorded (newest) configuration, not an older receipt's");
    assert.ok(await waitFor(() => runningPid(home) !== null));
    const m = readJson(metaPath);
    assert.equal(m.restartCount, count + 1); assert.equal(m.capabilityMeta["test.renew"].grant.id, "grant-5"); assert.equal(readJson(pendingPath).id, m.startId); }

  // A harness that exited (its completion marker names the completed start, the pane is a shell): a plain
  // start runs in that pane from instance.json as it is, and its receipt replaces the old one.
  provider({ meta: { grant: { id: "grant-5b" } } });
  { const completedId = readJson(metaPath).startId;
    process.kill(runningPid(home), "SIGTERM");
    await waitFor(() => readStartExited(home)?.startId === completedId && inspectInstanceSession(home).state === "shell", "the harness exited to its fallback shell");
    const r = startInstanceSession(home, { env: env({ RESTART_TEST_SRC: "x" }) });
    assert.equal(r.reused, "pane"); assert.equal(r.launchConfig, "polite");
    assert.ok(await waitFor(() => runningPid(home) !== null));
    const m = readJson(metaPath);
    assert.notEqual(m.startId, completedId); assert.equal(m.capabilityMeta["test.renew"].grant.id, "grant-5b"); assert.equal(readJson(pendingPath).id, m.startId); }

  // (d) A genuinely interrupted start (allocated, metadata write failed) is still adopted, with no second launch.
  provider({ meta: { grant: { id: "grant-6" } } });
  { const pid = runningPid(home);
    assert.throws(() => restart({ env: env({ RESTART_TEST_SRC: "x" }), launchConfig: "polite", io: { failBeforeMetadataWrite: true } }), (e) => e.code === "E_SESSION_START_INCOMPLETE");
    assert.ok(await waitFor(() => runningPid(home) !== null && runningPid(home) !== pid), "the interrupted start's harness runs");
    const interrupted = readJson(pendingPath);
    assert.notEqual(interrupted.id, readJson(metaPath).startId, "instance.json does not record the interrupted start");
    const adoptedPid = runningPid(home);
    const r = startInstanceSession(home, { env: env({ RESTART_TEST_SRC: "x" }) });
    assert.equal(r.reused, "adopted"); assert.equal(runningPid(home), adoptedPid, "no second launch");
    const m = readJson(metaPath);
    assert.equal(m.startId, interrupted.id); assert.equal(m.capabilityMeta["test.renew"].grant.id, "grant-6", "the interrupted start's meta is recorded on adoption"); }

  // Q2: a receipt naming the recorded start on another target is ambiguous. The kernel never writes this
  // state; it is constructed here only to pin the refusal: nothing written, the way out named.
  // A stray window running under the receipt's target name makes it ambiguous while it runs.
  // Its command is two arguments, so tmux execs it with no shell: given as one ("sleep 600") the pane
  // is `sh -c` for an instant on its way to `sleep`, and a pane of only shells under a receipt with no
  // completion marker reads as a start still in progress (E_SESSION_START_BUSY), not as a running target (#908).
  provider({ meta: { grant: { id: "grant-7" } }, warning: "provider hook ran" });
  tmux("new-window", "-d", "-t", `${session}:`, "-n", "stray", "-c", home, "sleep", "600");
  write(pendingPath, JSON.stringify({ ...readJson(pendingPath), id: readJson(metaPath).startId, target: { ...readJson(pendingPath).target, window: "stray" } }));
  const ambiguous = { meta: readFileSync(metaPath, "utf8"), metaIno: ino(metaPath), pending: readFileSync(pendingPath, "utf8"), runs: hookRuns() };
  const refusedAmbiguous = (e) => e.code === "E_SESSION_UNKNOWN" && /receipt is kept and nothing was started/.test(e.message) && /oats session inspect --home/.test(e.message) && /kill-window -t '=r:=stray'/.test(e.message) && /oats session restart --home/.test(e.message);
  assert.throws(() => startInstanceSession(home, { env: env({ RESTART_TEST_SRC: "x" }) }), refusedAmbiguous, "plain start");
  assert.throws(() => restart({ env: env({ RESTART_TEST_SRC: "x" }), launchConfig: "polite" }), refusedAmbiguous, "restart while the stray target runs");
  assert.deepEqual({ meta: readFileSync(metaPath, "utf8"), metaIno: ino(metaPath), pending: readFileSync(pendingPath, "utf8"), runs: hookRuns() }, ambiguous, "nothing written, no hook run");
  // The way out the message names: stop the stray target, then restart from instance.json.
  tmux("kill-window", "-t", `${session}:stray`);
  { const pid = runningPid(home);
    const r = restart({ env: env({ RESTART_TEST_SRC: "x" }), launchConfig: "polite" });
    assert.ok(await waitFor(() => runningPid(home) !== null && runningPid(home) !== pid));
    const m = readJson(metaPath);
    assert.equal(r.target.window, name, "the recorded target"); assert.equal(m.capabilityMeta["test.renew"].grant.id, "grant-7"); assert.equal(readJson(pendingPath).id, m.startId); }
  process.kill(runningPid(home), "SIGKILL"); // test cleanup only
});

import { readSameWork, sameWorkOf, writeSameWork } from "../lib/instance-same-work.mjs";
test("#1577 the same-work flag lasts as long as the home: through a start, a restart, a stop and a start, and a resume of a lost session, which rewrite instance.json only", async () => {
  const name = "dev-same-work";
  const { home } = await makeHome(name, { command: renderFor(homeOf(name), name, join(binDir, "polite")), launch: recipeFor(homeOf(name), name, { executable: join(binDir, "polite") }) });
  const metaFile = join(home, "instance.json");
  write(metaFile, JSON.stringify({ ...readJson(metaFile), parentInstance: "dev-lead" }, null, 2) + "\n");
  writeSameWork(home, "dev-lead");
  const flagged = (step) => {
    assert.equal(readSameWork(home), "dev-lead", `${step}: the record is kept`);
    assert.equal(sameWorkOf(home, readJson(metaFile).parentInstance), true, `${step}: still bound to the recorded parent`);
  };
  startInstanceSession(home, { env: env() });
  assert.ok(await waitFor(() => runningPid(home) !== null), "the harness is up");
  flagged("start");
  const before = runningPid(home);
  restartInstanceSession(home, { env: env(), stopGraceMs: 5000 });
  assert.ok(await waitFor(() => runningPid(home) !== null && runningPid(home) !== before), "a new harness is up");
  flagged("restart");
  assert.equal(stopInstanceSession(home, { graceMs: 5000 }).stopped, true);
  await waitFor(() => runningPid(home) === null, "harness gone");
  flagged("stop");
  startInstanceSession(home, { env: env() });
  assert.ok(await waitFor(() => runningPid(home) !== null), "started again");
  flagged("start after stop");
  // The session is lost (its window goes while the harness runs, no stop), then brought back with --resume.
  const lost = runningPid(home);
  tmux("kill-window", "-t", `${session}:${name}`);
  await waitFor(() => runningPid(home) !== lost, "the lost harness is gone");
  startInstanceSession(home, { resume: true, env: env() });
  assert.ok(await waitFor(() => runningPid(home) !== null), "resumed");
  flagged("resume");
  process.kill(runningPid(home), "SIGTERM"); await waitFor(() => runningPid(home) === null, "polite harness exit");
});
