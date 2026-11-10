import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execFile, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLaunchCommand, renderLaunchCommand, withLaunchModel, withSafeTaskPrompt, startInstanceSession, restartInstanceSession, inspectInstanceSession } from "../lib/core.mjs";
import { startRemote } from "../lib/servers.mjs";
import { inspectSessionTarget } from "../lib/session-input.mjs";
import { liveWaiting, readEvents, setWaiting } from "../lib/instance-events.mjs";
import { acrossPaneExit, isolateSessionEnvironment, oatsSocket, waitUntil } from "./helpers/host-fixture.mjs";
import { v2Deployment } from "./helpers/v2-deployment.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, "..", "bin", "oats.mjs");
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The shapes spawn renders today (lib/core.mjs launch command), verbatim in structure.
const claudeCmd = (home, model) => `OATS_INSTANCE='n' OATS_INSTANCE_HOME=${shq(home)} AWEB_DELIVERY='session' '/opt/homebrew/bin/claude' --dangerously-skip-permissions${model ? ` --model ${shq(model)}` : ""} --dangerously-load-development-channels plugin:aweb-channel@awebai-marketplace -- "$(cat TASK.md)"`;
const codexCmd = (home) => `OATS_INSTANCE='n' OATS_INSTANCE_HOME=${shq(home)} '/opt/homebrew/bin/codex' --cd ${shq(home)} --yolo -c ${shq(`projects={${JSON.stringify(home)}={trust_level="trusted"}}`)} -- "$(cat TASK.md)"`;
const piCmd = (home) => `OATS_INSTANCE='n' OATS_INSTANCE_HOME=${shq(home)} '/opt/homebrew/bin/pi' --no-skills --skill ${shq(join(home, ".agents", "skills"))} --no-context-files --no-prompt-templates --append-system-prompt ${shq(join(home, "AGENTS.md"))} --approve --name 'n' '@TASK.md'`;

test("persisted launch commands re-render with a model and keep everything else byte-identical", () => {
  const home = "/tmp/it's home";
  for (const [cmd, harness] of [[claudeCmd(home), "claude"], [codexCmd(home), "codex"], [piCmd(home), "pi"]]) {
    const parsed = parseLaunchCommand(cmd);
    assert.equal(renderLaunchCommand(parsed.tokens), cmd, `${harness} round-trips`);
    assert.equal(parsed.modelIndex, -1);
    const withModel = withLaunchModel(cmd, "m-1");
    const p2 = parseLaunchCommand(withModel);
    assert.equal(p2.tokens[p2.modelIndex].value, "m-1");
    assert.equal(p2.tokens[p2.modelIndex - 1].value, "--model");
    assert.equal(p2.modelIndex, p2.binary + 2, "inserted right after the binary");
    // Every original token survives in order; only the two model tokens are new.
    const orig = parsed.tokens.map((t) => t.text);
    const now = p2.tokens.map((t) => t.text).filter((t, i) => i !== p2.modelIndex && i !== p2.modelIndex - 1);
    assert.deepEqual(now, orig);
    assert.equal(withLaunchModel(withModel, "m-2"), withModel.replace("'m-1'", "'m-2'"), "an existing value is replaced in place");
  }
  const existing = claudeCmd(home, "claude-x");
  assert.equal(withLaunchModel(existing, "claude-y"), existing.replace("'claude-x'", "'claude-y'"));
  assert.equal(parseLaunchCommand(existing).tokens.filter((t) => t.kind === "env").length, 3);
});

test("commands OATS did not render are refused, never rewritten by substring", () => {
  for (const cmd of [
    "claude --model x -- \"$(cat TASK.md)\"", // unquoted binary
    "'claude' --model 'x' -- \"$(cat OTHER.md)\"", // a different prompt expression
    "'claude' `whoami` -- \"$(cat TASK.md)\"",
    "'claude' --model 'x'; rm -rf /",
    "'claude' --model 'x $(id)'x -- \"$(cat TASK.md)\"",
    "'claude' --model",
    "'claude' --mo\\del 'x'",
    "'claude' --model --yolo",
    "'claude' --model 'first' --model 'last'",
    "FOO=bar 'claude'",
    "",
  ]) {
    assert.throws(() => parseLaunchCommand(cmd), (e) => e.code === "E_LAUNCH_COMMAND_UNSUPPORTED", cmd);
  }
});

// ---- real tmux: the fixture's own `oats` server ------------------------------------
// Every home here is recorded on the server OATS creates sessions on (`tmux -L oats`, in the fixture's
// private TMUX_TMPDIR), so a window the kernel has to create again lands on the socket the home
// recorded. A home recorded on ANOTHER server is test/tmux-own-server.test.mjs.
// short, and its OATS_HOME_DIR is <base>/h: that holds ssh's control socket (ssh/<40 hex>), which ssh needs
// within 86 bytes, under the root run's directory of the file (docs/implementation.md, fixtures)
const base = realpathSync(mkdtempSync(join(tmpdir(), "o-ss-")));
const session = "t";
const restoreEnvironment = isolateSessionEnvironment(base);
const socket = oatsSocket();
const tmux = (...args) => execFileSync("tmux", ["-u", "-S", socket, ...args], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }).trim();
const windows = () => { try { return tmux("list-windows", "-t", session, "-F", "#{window_name}").split("\n").filter(Boolean); } catch { return []; } };
// Every home is a real workspace-model spawn (0.26.0 starts no other kind); the
// session facts each test needs are then written onto that spawned home.
const fx = v2Deployment();
test.after(() => { try { tmux("kill-server"); } catch { /* gone */ } finally { restoreEnvironment(); rmSync(base, { recursive: true, force: true }); fx.cleanup(); } });

async function makeHome(name, { launched = true, withSocket = true } = {}) {
  // Spawned with the fixture's inert harnesses on PATH (the isolated PATH has no claude).
  const path = process.env.PATH;
  process.env.PATH = fx.env.PATH;
  let spawned;
  try { spawned = await fx.spawn("dev", { name, harness: "claude" }); } finally { process.env.PATH = path; }
  const home = spawned.home;
  const harness = join(base, "fakeharness");
  if (!existsSync(harness)) {
    // A real process with explicit ready/release markers. It cannot exit just
    // because a busy test runner took longer than an arbitrary sleep.
    writeFileSync(harness, `#!/usr/bin/env node
const { existsSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const home = process.env.OATS_INSTANCE_HOME;
writeFileSync(join(home, "harness-argv.json"), JSON.stringify(process.argv.slice(2)));
writeFileSync(join(home, "harness-ready"), String(process.pid));
setInterval(() => { if (existsSync(join(home, "release-" + process.pid))) process.exit(0); }, 25);
`);
    chmodSync(harness, 0o755);
  }
  writeFileSync(join(home, "TASK.md"), "task\n");
  const command = `OATS_INSTANCE=${shq(name)} OATS_INSTANCE_HOME=${shq(home)} ${shq(harness)} --dangerously-skip-permissions -- "$(cat TASK.md)"`;
  const tmuxMeta = { session, window: name, ...(withSocket ? { socket } : {}) };
  // The spawned metadata with a frozen command in place of the launch recipe:
  // these tests pin the persisted-command start path (a recipe start goes
  // through the planner, pinned in session-restart).
  const { launch: _recipe, ...spawnedMeta } = readJson(join(home, "instance.json"));
  const meta = { ...spawnedMeta, tmux: tmuxMeta, command, launched };
  writeFileSync(join(home, "instance.json"), JSON.stringify(meta, null, 2) + "\n");
  const key = createHash("sha256").update(home).digest("hex");
  const baselinePath = join(dirname(home), ".oats-retirement", "baselines", `${key}.json`);
  assert.ok(existsSync(baselinePath), "the spawn wrote the independent session receipt");
  const baseline = { ...readJson(baselinePath), runtime: launched ? { launched: true, tmux: { session, window: name, socket } } : { launched: false } };
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n", { mode: 0o600 });
  return { home, meta, baselinePath, command };
}
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const releaseHarness = (home) => writeFileSync(join(home, `release-${readFileSync(join(home, "harness-ready"), "utf8")}`), "");
const harnessReady = (f, window = f.meta.instance) => waitUntil(() => {
  try {
    const pid = Number(readFileSync(join(f.home, "harness-ready"), "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 1) return false;
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}, `${window} fixture harness ready`);
function heldWindow(f, window = f.meta.instance) {
  tmux("new-window", "-t", session, "-n", window, "-c", f.home, f.command);
  return harnessReady(f, window);
}
const pendingFor = (f, target, fields = {}) => ({ id: `test-${f.meta.instance}`, target, command: f.command, model: null, startedAt: "2026-09-06T00:00:00.000Z", ...fields });

test("package module upgrade partial receipts block start and restart before any session or hook effects", async () => {
  const f = await makeHome("upgradepartial", { launched: false });
  const receipts = join(f.home, ".oats");
  const receiptPath = join(receipts, "upgrade-receipt.retry-upgrade.json");
  mkdirSync(receipts, { recursive: true });
  writeFileSync(receiptPath, JSON.stringify({ action: "upgrade", status: "partial", instance: f.meta.instance, idempotencyKey: "retry-upgrade", planRevision: "revision-partial" }));
  const before = readFileSync(join(f.home, "instance.json"), "utf8");
  let effects = 0;
  const io = { exec: () => { effects++; throw new Error("must not execute"); }, kill: () => { effects++; throw new Error("must not signal"); } };
  for (const restart of [false, true]) {
    writeFileSync(receiptPath, JSON.stringify({ action: "upgrade", status: "partial", undo: restart, instance: f.meta.instance, idempotencyKey: "retry-upgrade", planRevision: "revision-partial" }));
    assert.throws(() => startInstanceSession(f.home, { restart, io }), (e) => e.code === "E_UPGRADE_PARTIAL" && e.message.includes("retry-upgrade") && e.message.includes("oats instance upgrade") && e.message.includes("--idempotency-key") && e.message.includes("revision-partial") && e.message.includes("--undo") === restart);
    assert.equal(effects, 0);
    assert.equal(existsSync(join(f.home, ".oats-start.lock")), false);
    assert.equal(readFileSync(join(f.home, "instance.json"), "utf8"), before);
    const run = spawnSync(process.execPath, [bin, "session", restart ? "restart" : "start", "--home", f.home, "--json"], { encoding: "utf8" });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.equal(JSON.parse(run.stdout).error.code, "E_UPGRADE_PARTIAL");
  }
});

test("package module upgrade file mutex refuses starts while active and after owner exit, naming the same-key retry; an earlier OATS's start lock directory is refused, named and left", async () => {
  const f = await makeHome("upgradefilemutex", { launched: false });
  const lock = join(f.home, ".oats-start.lock");
  const owner = { action: "upgrade", instance: f.meta.instance, home: f.home, planRevision: "file-mutex-revision", idempotencyKey: "file-mutex-key", undo: true };
  const child = execFile(process.execPath, ["--input-type=module", "-e", `import { openSync, writeFileSync } from "node:fs";
const fd = openSync(process.argv[1], "wx");
writeFileSync(fd, process.argv[2]);
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);`, lock, JSON.stringify(owner)], { cwd: f.home });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let effects = 0;
  const io = { exec: () => { effects++; throw new Error("must not execute"); } };
  const refuses = () => {
    for (const restart of [false, true]) assert.throws(() => startInstanceSession(f.home, { restart, io }), (e) => e.code === "E_SESSION_START_BUSY"
      && e.message.includes("oats instance upgrade upgradefilemutex --undo --plan-revision file-mutex-revision --idempotency-key file-mutex-key")
      && !e.message.includes("remove that directory"));
    assert.equal(effects, 0);
    assert.equal(readFileSync(lock, "utf8"), JSON.stringify(owner), "start never reclaims the upgrade mutex");
  };
  try {
    await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); });
    refuses();
    child.kill("SIGTERM");
    await exited;
    refuses();
    writeFileSync(lock, "");
    assert.throws(() => startInstanceSession(f.home, { io }), (e) => e.code === "E_SESSION_START_BUSY" && e.message.includes("oats instance upgrade upgradefilemutex")
      && e.message.includes("--plan-revision") && e.message.includes("original") && e.message.includes("--idempotency-key") && !e.message.includes("remove that directory"));
    assert.equal(readFileSync(lock, "utf8"), "", "an empty crashed write is retained too");
    rmSync(lock);
    // A directory there is only ever an earlier OATS's start lock: refused, named, and left as it is.
    mkdirSync(lock);
    writeFileSync(join(lock, "keep.txt"), "earlier start");
    // A person must act on it: its own code, never the busy one an unattended caller waits out.
    assert.throws(() => startInstanceSession(f.home, { io }), (e) => e.code === "E_SESSION_START_LOCK_STUCK"
      && e.message === `${lock} is the start lock directory of an earlier OATS; nothing was stopped or started. Once no earlier oats is running, remove that directory and retry`);
    assert.equal(effects, 0);
    assert.equal(readFileSync(join(lock, "keep.txt"), "utf8"), "earlier start", "the directory is left byte for byte");
    rmSync(lock, { recursive: true });
    symlinkSync(join(f.home, "instance.json"), lock);
    assert.throws(() => startInstanceSession(f.home, { io }), (e) => e.code === "E_SESSION_START_LOCK_STUCK"
      && e.message === `${lock} is neither a package upgrade's file nor an earlier OATS's start lock directory; nothing was stopped or started. Remove it and retry`);
  } finally {
    child.kill("SIGTERM");
    await exited;
    rmSync(lock, { recursive: true, force: true });
  }
});

test("package module upgrade unsafe receipt state refuses start before session effects", async () => {
  const f = await makeHome("upgradeunsafe", { launched: false });
  const receipts = join(f.home, ".oats");
  const receiptPath = join(receipts, "upgrade-receipt.unsafe.json");
  let effects = 0;
  const io = { exec: () => { effects++; throw new Error("must not execute"); } };
  const refuses = () => {
    assert.throws(() => startInstanceSession(f.home, { io }), (e) => e.code === "E_UPGRADE_PARTIAL" && e.message.includes(receipts) && /inspect|respawn/.test(e.message));
    assert.equal(effects, 0);
    assert.equal(existsSync(join(f.home, ".oats-start.lock")), false);
  };
  writeFileSync(receiptPath, "{not json");
  refuses();
  rmSync(receiptPath);
  symlinkSync(join(f.home, "instance.json"), receiptPath);
  refuses();
  rmSync(receiptPath);
  renameSync(receipts, join(f.home, ".oats-real"));
  symlinkSync(".oats-real", receipts);
  assert.throws(() => startInstanceSession(f.home, { io }), e => e.code === "E_LAUNCH_SHIM");
  assert.equal(effects, 0);
});

test("package module upgrade committed cleanup warns on start and restart without blocking the session", async () => {
  const f = await makeHome("upgradecleanup", { launched: false });
  const receiptPath = join(f.home, ".oats", "upgrade-receipt.cleanup-retry.json");
  const receipt = { action: "upgrade", status: "complete", instance: f.meta.instance, idempotencyKey: "cleanup-retry", planRevision: "committed-revision", steps: { cleaned: false } };
  writeFileSync(receiptPath, JSON.stringify(receipt));
  let createdSession = false;
  try { tmux("has-session", "-t", session); } catch { tmux("new-session", "-d", "-s", session, "-n", "hq", "-c", base); createdSession = true; }
  try {
    const result = startInstanceSession(f.home);
    await harnessReady(f);
    const warning = result.warnings.find((message) => message.includes("cleanup-retry"));
    assert.ok(warning, JSON.stringify(result.warnings));
    assert.match(warning, /complete.*cleanup/i);
    assert.match(warning, /oats instance upgrade upgradecleanup --plan-revision committed-revision --idempotency-key cleanup-retry/);
    const run = spawnSync(process.execPath, [bin, "session", "restart", "--home", f.home], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.ok(JSON.parse(run.stdout).warnings.includes(warning));
    assert.ok(run.stderr.includes(`WARNING: ${warning}`), run.stderr);
    await harnessReady(f);
    writeFileSync(receiptPath, JSON.stringify({ ...receipt, steps: { cleaned: true } }));
    const complete = restartInstanceSession(f.home, { stopGraceMs: 5000 });
    assert.equal(complete.warnings.some((message) => message.includes("cleanup-retry")), false, "the warning clears after cleanup finishes");
  } finally {
    try { tmux(createdSession ? "kill-session" : "kill-window", "-t", createdSession ? `=${session}` : `=${session}:=upgradecleanup`); } catch { /* absent */ }
  }
});

// #762: a missing receipt says where it was looked for, why it can be missing and what to do.
test("a home without its session receipt is refused naming the receipt path, the oats status spelling first, and the retire remedy; an unreadable instance.json keeps its own message", async () => {
  const f = await makeHome("noreceipt"); rmSync(f.baselinePath);
  const missing = (e) => e.code === "E_RUNTIME_ENDPOINT_UNKNOWN" && e.message.includes(`no session receipt for ${f.home} at ${f.baselinePath}`)
    && /First address the home exactly as `oats status` prints it/.test(e.message)
    && e.message.includes("`oats retire noreceipt --plan` and `oats retire noreceipt`");
  assert.throws(() => inspectInstanceSession(f.home), missing);
  assert.throws(() => startInstanceSession(f.home), missing);
  const run = spawnSync(process.execPath, [bin, "session", "inspect", "--home", f.home, "--json"], { encoding: "utf8" });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  const cli = JSON.parse(run.stdout);
  assert.equal(cli.error.code, "E_RUNTIME_ENDPOINT_UNKNOWN"); assert.ok(cli.error.message.includes(f.baselinePath), cli.error.message);
  // The receipt is there and instance.json is not valid JSON: that failure keeps its own message.
  const g = await makeHome("badmeta"); writeFileSync(join(g.home, "instance.json"), "{not json\n");
  // It names the record by its path, not the receipt (#1092).
  assert.throws(() => inspectInstanceSession(g.home), (e) => e.code === "E_RUNTIME_ENDPOINT_UNKNOWN" && e.message.startsWith(`cannot read ${join(g.home, "instance.json")}: `) && !e.message.includes("receipt") && !e.message.includes("oats status"));
});

test("refusals happen before any mutation", async () => {
  assert.throws(() => startInstanceSession("relative/home"), (e) => e.code === "E_BAD_ARGS");
  assert.throws(() => startInstanceSession(join(base, "nowhere")), (e) => e.code === "E_RUNTIME_ENDPOINT_UNKNOWN");
  const f = await makeHome("refuse");
  const noBaseline = await makeHome("nobaseline"); rmSync(noBaseline.baselinePath);
  assert.throws(() => startInstanceSession(noBaseline.home), (e) => e.code === "E_RUNTIME_ENDPOINT_UNKNOWN");
  const mismatch = await makeHome("mismatch");
  writeFileSync(join(mismatch.home, "instance.json"), JSON.stringify({ ...mismatch.meta, tmux: { ...mismatch.meta.tmux, window: "other" } }) + "\n");
  assert.throws(() => startInstanceSession(mismatch.home), (e) => e.code === "E_RUNTIME_AUTHORITY_MISMATCH");
  writeFileSync(join(f.home, ".oats-rollback-incomplete.json"), "{}\n");
  assert.throws(() => startInstanceSession(f.home), (e) => e.code === "E_INSTANCE_RETIRING");
  rmSync(join(f.home, ".oats-rollback-incomplete.json"));
  // A self-retirement's marker beside the home (its detached teardown is running).
  writeFileSync(join(dirname(f.home), ".oats-retire-pending-refuse.json"), "{}\n");
  assert.throws(() => startInstanceSession(f.home), (e) => e.code === "E_INSTANCE_RETIRING" && /retire-pending/.test(e.message));
  rmSync(join(dirname(f.home), ".oats-retire-pending-refuse.json"));
  mkdirSync(join(f.home, ".oats-start.lock"));
  assert.throws(() => startInstanceSession(f.home), (e) => e.code === "E_SESSION_START_LOCK_STUCK");
  rmSync(join(f.home, ".oats-start.lock"), { recursive: true });
  assert.throws(() => startInstanceSession(f.home, { model: "openai/gpt-x" }), (e) => e.code === "E_MODEL_UNKNOWN", "a preference claude cannot use is an error, not a silent default");
  const unsupported = await makeHome("unsupported");
  writeFileSync(join(unsupported.home, "instance.json"), JSON.stringify({ ...unsupported.meta, command: "claude `id`" }) + "\n");
  assert.throws(() => startInstanceSession(unsupported.home, { model: "claude-x" }), (e) => e.code === "E_LAUNCH_COMMAND_UNSUPPORTED");
  assert.equal(readJson(f.baselinePath).runtime.launched, true);
  assert.deepEqual(readJson(join(f.home, "instance.json")), f.meta, "metadata untouched by every refusal");
  assert.equal(existsSync(join(f.home, ".oats-start.lock")), false);
});

test("a live harness is refused; a stopped instance starts in its recorded session on its recorded socket", async () => {
  tmux("new-session", "-d", "-s", session, "-n", "hq", "-c", base);
  const f = await makeHome("live");
  await heldWindow(f);
  assert.throws(() => startInstanceSession(f.home), (e) => e.code === "E_SESSION_RUNNING");
  tmux("kill-window", "-t", `=${session}:=live`);
  rmSync(join(f.home, "harness-ready"));
  assert.equal(inspectInstanceSession(f.home).present, false);
  const before = readJson(f.baselinePath);
  const r = startInstanceSession(f.home, { model: "claude-x" });
  assert.equal(r.reused, "new");
  assert.equal(r.model, "claude-x");
  assert.deepEqual(r.target, { backend: "tmux", session, window: "live", socket: resolve(socket) });
  assert.deepEqual(windows().filter((w) => w === "live"), ["live"], "exactly one window with the instance name");
  const meta = readJson(join(f.home, "instance.json"));
  assert.equal(meta.launched, true);
  assert.equal(meta.model, "claude-x");
  assert.equal(meta.command, withSafeTaskPrompt(withLaunchModel(f.command, "claude-x"), "claude"));
  assert.equal(meta.restartCount, 1);
  assert.equal(meta.restarts.length, 1);
  const after = readJson(f.baselinePath);
  assert.deepEqual(after.runtime, { launched: true, tmux: { session, window: "live", socket: resolve(socket) } });
  assert.deepEqual({ ...after, runtime: undefined }, { ...before, runtime: undefined }, "fingerprints and receipts untouched");
  assert.equal(existsSync(join(f.home, ".oats-start-pending.json")), true, "launch evidence survives until the startup shell can be distinguished");
  assert.equal(existsSync(join(f.home, ".oats-start.lock")), false);
  // The receipts the broker and retire read resolve the new target only
  // once the harness has published readiness (not just started its shell).
  await harnessReady(f);
  const live = inspectInstanceSession(f.home);
  assert.equal(live.present, true);
  assert.equal(live.state, "unknown", "a running non-shell process is a harness");
  assert.equal(live.running, true, "and it runs");
  // Explicitly finish the harness; the window drops to a fallback shell,
  // which is a stopped instance that restarts IN PLACE, never a second window.
  releaseHarness(f.home);
  await waitUntil(() => existsSync(join(f.home, ".oats-start-exited")) && inspectInstanceSession(f.home).state === "shell", "harness exit");
  const fallback = inspectInstanceSession(f.home);
  assert.deepEqual([fallback.state, fallback.present, fallback.running], ["shell", true, false], "the fallback shell is present and not running");
  tmux("send-keys", "-t", `=${session}:=live`, `cd ${shq(base)}`, "Enter");
  await waitUntil(() => tmux("display-message", "-p", "-t", `=${session}:=live`, "#{pane_current_path}") === base, "fallback shell navigation");
  const again = startInstanceSession(f.home);
  assert.equal(again.reused, "pane");
  assert.equal(again.model, "claude-x", "omitted model keeps the recorded one");
  assert.deepEqual(windows().filter((w) => w === "live"), ["live"]);
  assert.equal(readJson(join(f.home, "instance.json")).restartCount, 2);
  assert.equal(inspectInstanceSession(f.home).present, true);
  assert.equal(tmux("display-message", "-p", "-t", `=${session}:=live`, "#{pane_current_path}"), f.home, "restart restores the instance cwd after shell navigation");
});

test("a pre-0.31 home recorded in pi-agents starts in pi-agents, whatever the 0.31 session default says", async () => {
  const f = await makeHome("legacy");
  const legacy = { ...f.meta.tmux, session: "pi-agents" };
  writeFileSync(join(f.home, "instance.json"), JSON.stringify({ ...f.meta, tmux: legacy }, null, 2) + "\n");
  writeFileSync(f.baselinePath, JSON.stringify({ ...readJson(f.baselinePath), runtime: { launched: true, tmux: { session: "pi-agents", window: "legacy", socket } } }, null, 2) + "\n", { mode: 0o600 });
  const localPath = join(fx.dep, "oats-local.yaml");
  const local = readFileSync(localPath, "utf8");
  writeFileSync(localPath, `${local}session:\n  tmuxSession: oats-agents\n`);
  const env = { OATS_TMUX_SESSION: process.env.OATS_TMUX_SESSION };
  Object.assign(process.env, { OATS_TMUX_SESSION: "elsewhere" });
  try {
    const r = startInstanceSession(f.home);
    assert.deepEqual(r.target, { backend: "tmux", session: "pi-agents", window: "legacy", socket: resolve(socket) });
    assert.ok(tmux("list-windows", "-t", "pi-agents", "-F", "#{window_name}").split("\n").includes("legacy"));
    assert.deepEqual(readJson(f.baselinePath).runtime.tmux, { session: "pi-agents", window: "legacy", socket: resolve(socket) });
    await harnessReady(f, "legacy");
    // A restart of the running pre-0.31 home stays in its recorded session too.
    const again = restartInstanceSession(f.home, { stopGraceMs: 5000 });
    assert.equal(again.target.session, "pi-agents");
    assert.equal(readJson(f.baselinePath).runtime.tmux.session, "pi-agents");
    await harnessReady(f, "legacy");
    releaseHarness(f.home);
  } finally {
    writeFileSync(localPath, local);
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("a lost tmux server on the recorded socket is a stopped instance: the session comes back on that socket", async () => {
  const f = await makeHome("reboot");
  tmux("kill-server");
  assert.throws(() => inspectInstanceSession(f.home), (e) => e.code === "E_SESSION_UNAVAILABLE", "inspect alone cannot call a lost socket absent");
  const r = startInstanceSession(f.home);
  assert.equal(r.reused, "new");
  assert.equal(r.target.socket, resolve(socket));
  assert.ok(windows().includes("reboot"));
  assert.equal(readJson(f.baselinePath).runtime.tmux.socket, resolve(socket));
});

test("a home recorded with the task's text in argv (\"$(cat TASK.md)\") starts with the safe prompt, and saves it", async () => {
  const f = await makeHome("old-prompt", { launched: false });
  writeFileSync(join(f.home, "TASK.md"), "SECRET-TASK-TEXT-427\n");
  assert.match(f.command, /-- "\$\(cat TASK\.md\)"$/);
  startInstanceSession(f.home);
  await harnessReady(f);
  const argv = readJson(join(f.home, "harness-argv.json"));
  assert.deepEqual(argv.slice(-2), ["--", "@TASK.md"]);
  assert.ok(!argv.join(" ").includes("SECRET-TASK-TEXT-427"), "the task's text is in no argument");
  const saved = readJson(join(f.home, "instance.json")).command;
  assert.equal(saved, f.command.replace('-- "$(cat TASK.md)"', "-- '@TASK.md'"), "the saved command carries the safe prompt");
  releaseHarness(f.home);
});

test("a start that allocated but could not record is adopted by the next start, never duplicated", async () => {
  const f = await makeHome("pending");
  await heldWindow(f);
  // Simulate the partial failure: the actual target is in the pending receipt, metadata still says stopped.
  writeFileSync(join(f.home, ".oats-start-pending.json"), JSON.stringify(pendingFor(f, { backend: "tmux", session, window: "pending", socket })));
  const r = startInstanceSession(f.home);
  assert.equal(r.reused, "adopted");
  assert.deepEqual(windows().filter((w) => w === "pending"), ["pending"]);
  assert.equal(existsSync(join(f.home, ".oats-start-pending.json")), true, "the launch receipt is retained until command exit or target disappearance");
  assert.equal(readJson(join(f.home, "instance.json")).restartCount, 1);
  // A stale receipt whose target is provably gone is dropped and the start proceeds normally.
  tmux("kill-window", "-t", `=${session}:=pending`);
  writeFileSync(join(f.home, ".oats-start-pending.json"), JSON.stringify(pendingFor(f, { backend: "tmux", session, window: "pending", socket }, { id: "stale-target" })));
  assert.equal(startInstanceSession(f.home).reused, "new");
  assert.deepEqual(windows().filter((w) => w === "pending"), ["pending"]);
});

test("an injected metadata write failure after allocation is recovered by the next start through the receipt", async () => {
  const f = await makeHome("crash");
  const before = readJson(f.baselinePath);
  let injected;
  try { injected = startInstanceSession(f.home, { io: { failBeforeMetadataWrite: true } }); } catch (e) { injected = e; }
  assert.ok(injected instanceof Error && injected.code === "E_SESSION_START_INCOMPLETE" && /\.oats-start-pending\.json/.test(injected.message), "injected write failure surfaces as E_SESSION_START_INCOMPLETE naming the receipt");
  // The receipt was updated, the metadata was not.
  assert.deepEqual(readJson(f.baselinePath).runtime, { launched: true, tmux: { session, window: "crash", socket: resolve(socket) } });
  assert.deepEqual({ ...readJson(f.baselinePath), harness: undefined }, { ...before, harness: undefined }, "fingerprints untouched by the failed start");
  assert.deepEqual(readJson(join(f.home, "instance.json")), f.meta);
  assert.equal(existsSync(join(f.home, ".oats-start-pending.json")), true);
  assert.equal(existsSync(join(f.home, ".oats-start.lock")), false, "the guard is released even when recording fails");
  await harnessReady(f);
  const r = startInstanceSession(f.home);
  assert.equal(r.reused, "adopted", "the running session is recorded, not duplicated");
  assert.deepEqual(windows().filter((w) => w === "crash"), ["crash"]);
  assert.equal(existsSync(join(f.home, ".oats-start-pending.json")), true, "the launch receipt is retained until command exit or target disappearance");
  assert.equal(readJson(join(f.home, "instance.json")).restartCount, 1);
  assert.equal(inspectInstanceSession(f.home).present, true);
});

test("waiting-on-you: a start records its session boundary once the session exists; recovering an interrupted start adds no later boundary (a claim the new session made survives); a receipt without one gets it at its launch time", async () => {
  const boundaries = (home) => readEvents(home).events.filter((e) => e.producer === "kernel" && e.kind === "launched" && e.data?.startId);
  const f = await makeHome("bound");
  setWaiting(f.home, { producer: "agent", waiting: true, reason: "attention", message: "old session question" });
  let injected;
  try { startInstanceSession(f.home, { io: { failBeforeMetadataWrite: true } }); } catch (e) { injected = e; }
  assert.equal(injected?.code, "E_SESSION_START_INCOMPLETE");
  assert.equal(boundaries(f.home).length, 1, "the boundary is written before the metadata");
  assert.equal(boundaries(f.home)[0].data.phase, "start");
  assert.equal(liveWaiting(f.home), null, "the replaced session's claim is void");
  await harnessReady(f);
  setWaiting(f.home, { producer: "agent", waiting: true, reason: "attention", message: "new session question" });
  assert.equal(startInstanceSession(f.home).reused, "adopted");
  assert.equal(boundaries(f.home).length, 1, "adoption adds no second boundary");
  assert.equal(liveWaiting(f.home)?.message, "new session question");
  assert.equal(inspectInstanceSession(f.home).waitingOnYou?.message, "new session question");
  releaseHarness(f.home);

  // A receipt left by a start that recorded no boundary (an earlier kernel): adoption writes it at the receipt's startedAt.
  const g = await makeHome("bound-old");
  await heldWindow(g);
  const incarnation = readJson(join(g.home, "instance.json")).createdAt, t = Date.now();
  const row = (at, message) => writeFileSync(join(g.home, ".oats-events.jsonl"), JSON.stringify({ eventsApi: 2, at: new Date(at).toISOString(), instance: "bound-old", home: g.home, incarnation, producer: "agent", kind: "waiting", data: { waitingOnYou: true, reason: "attention", message } }) + "\n", { flag: "a" });
  row(t - 5000, "before the launch");
  writeFileSync(join(g.home, ".oats-start-pending.json"), JSON.stringify(pendingFor(g, { backend: "tmux", session, window: "bound-old", socket }, { startedAt: new Date(t).toISOString() })));
  row(t + 5000, "after the launch");
  assert.equal(startInstanceSession(g.home).reused, "adopted");
  const b = boundaries(g.home);
  assert.equal(b.length, 1); assert.equal(b[0].at, new Date(t).toISOString(), "dated at the launch, not at the adoption"); assert.equal(b[0].data.phase, "recovered");
  assert.equal(liveWaiting(g.home)?.message, "after the launch", "the new session's claim is kept");
  assert.throws(() => startInstanceSession(g.home), (e) => e.code === "E_SESSION_RUNNING", "a further start of the running session is refused");
  assert.equal(boundaries(g.home).length, 1, "and adds no boundary");
  releaseHarness(g.home);
});

test("a recorded pending target that differs from the metadata is reconciled before the equality gate", async () => {
  // The shape a start into a new window leaves after a metadata write failure:
  // receipt and pending name the new target, metadata still names the old one.
  const f = await makeHome("diverged");
  await heldWindow(f, "diverged-2");
  const target = { backend: "tmux", session, window: "diverged-2", socket };
  const baseline = readJson(f.baselinePath);
  writeFileSync(f.baselinePath, JSON.stringify({ ...baseline, runtime: { launched: true, tmux: { session, window: "diverged-2", socket: resolve(socket) } } }));
  writeFileSync(join(f.home, ".oats-start-pending.json"), JSON.stringify(pendingFor(f, target)));
  assert.throws(() => inspectInstanceSession(f.home), (e) => e.code === "E_RUNTIME_AUTHORITY_MISMATCH", "the ordinary gate refuses this home");
  const r = startInstanceSession(f.home);
  assert.equal(r.reused, "adopted");
  assert.deepEqual(r.target, { ...target, socket: resolve(socket) });
  assert.equal(readJson(join(f.home, "instance.json")).tmux.window, "diverged-2");
  assert.equal(existsSync(join(f.home, ".oats-start-pending.json")), true, "the launch receipt is retained until command exit or target disappearance");
  assert.equal(inspectInstanceSession(f.home).present, true, "receipts agree again");
  assert.deepEqual(windows().filter((w) => w.startsWith("diverged")), ["diverged-2"], "no second allocation");
  tmux("kill-window", "-t", `=${session}:=diverged-2`);
});

test("a pending target that cannot be observed is kept and the start refuses; a dead pane restarts in place", async () => {
  const f = await makeHome("unobservable");
  // A recorded tmux window on a reachable server that tmux answers but in which OATS cannot tell the
  // agent's pane (#1569: it was split, and both panes are marked as its agent's pane): not absence,
  // no allocation, receipt kept.
  try { tmux("has-session", "-t", session); } catch { tmux("new-session", "-d", "-s", session, "-n", "hq", "-c", base); }
  tmux("new-window", "-t", session, "-n", "unobservable-split", "-c", base, "sleep 60");
  tmux("split-window", "-t", `=${session}:=unobservable-split`, "sleep 60");
  const panes = tmux("list-panes", "-t", `=${session}:=unobservable-split`, "-F", "#{pane_id}").split("\n");
  for (const pane of panes) tmux("set-option", "-p", "-t", pane, "@oats-agent", "unobservable-split");
  writeFileSync(join(f.home, ".oats-start-pending.json"), JSON.stringify(pendingFor(f, { backend: "tmux", session, window: "unobservable-split", socket })));
  try {
    assert.throws(() => startInstanceSession(f.home), (e) => e.code === "E_SESSION_UNKNOWN" && /receipt .* is kept/.test(e.message) && /the window has 2 panes marked as unobservable-split's agent pane/.test(e.message));
    assert.equal(existsSync(join(f.home, ".oats-start-pending.json")), true);
    assert.deepEqual(windows().filter((w) => w === "unobservable"), []);
    // The same split window on a real server, read with one mark, then none: the marked pane, then
    // the window's own pane (the lowest id), whichever tmux made active.
    const split = { backend: "tmux", session, window: "unobservable-split", socket };
    const [own, added] = panes.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    tmux("set-option", "-p", "-u", "-t", own, "@oats-agent");
    assert.deepEqual(inspectSessionTarget(split, undefined, { includePanes: true }), { backend: "tmux", present: true, state: "unknown", paneId: added, panes: 2 });
    tmux("set-option", "-p", "-u", "-t", added, "@oats-agent");
    assert.equal(inspectSessionTarget(split).paneId, own);
  } finally { tmux("kill-window", "-t", `=${session}:=unobservable-split`); }
  rmSync(join(f.home, ".oats-start-pending.json"));
  // Dead pane: the harness exited and tmux retained the pane (remain-on-exit).
  const d = await makeHome("deadpane");
  await heldWindow(d);
  // A window from before the agent's pane was marked (#1569): a restart in place marks it.
  const mark = () => tmux("display-message", "-p", "-t", `=${session}:=deadpane`, "#{@oats-agent}");
  assert.equal(mark(), "", "a pane OATS did not launch carries no mark");
  tmux("set-option", "-w", "-t", `=${session}:=deadpane`, "remain-on-exit", "on");
  releaseHarness(d.home);
  await waitUntil(() => acrossPaneExit(() => inspectInstanceSession(d.home))?.state === "stopped", "retained dead pane");
  const st = inspectInstanceSession(d.home);
  assert.equal(st.present, false);
  assert.equal(st.state, "stopped");
  assert.equal(st.running, false);
  const r = startInstanceSession(d.home, { model: "claude-z" });
  assert.equal(r.reused, "pane");
  assert.deepEqual(windows().filter((w) => w === "deadpane"), ["deadpane"], "restarted in the retained pane, no second window");
  assert.equal(mark(), "deadpane", "the respawned pane is marked as the agent's");
  await waitUntil(() => inspectInstanceSession(d.home).state === "unknown", "dead pane relaunch");
  assert.equal(inspectInstanceSession(d.home).present, true);
  assert.equal(readJson(join(d.home, "instance.json")).model, "claude-z");
});

test("the CLI advertises session-start and routes it only to a remote that advertises it", () => {
  const probe = JSON.parse(execFileSync(process.execPath, [bin, "version", "--json"], { encoding: "utf8" }));
  assert.ok(probe.features.includes("session-start"));
  assert.ok(probe.remote.includes("session-start"));
  const oatsHome = join(base, "h");
  mkdirSync(oatsHome, { recursive: true });
  writeFileSync(join(oatsHome, "servers.json"), JSON.stringify({ servers: { s: { sshHost: "h", workspace: "/w" } } }));
  const prev = process.env.OATS_HOME_DIR;
  process.env.OATS_HOME_DIR = oatsHome;
  try {
    const calls = [];
    const io = (features) => ({ execFileSync: (b, argv) => {
      const args = argv.join(" ");
      calls.push(args);
      if (args.includes("version --json")) return JSON.stringify({ schemaVersion: 1, ok: true, result: { desktopApi: 1, version: "0.22.8", remote: ["session"], features } });
      return JSON.stringify({ schemaVersion: 1, ok: true, result: { instance: "r", home: "/remote/home", backend: "tmux", reused: "new" } });
    } });
    assert.throws(() => startRemote("s", { home: "/remote/home", model: "m" }, io(["retire-home"])), (e) => e.code === "E_REMOTE_INCOMPATIBLE" && /session-start/.test(e.message));
    assert.equal(calls.filter((c) => c.includes("session start")).length, 0, "refused before any remote mutation");
    const out = startRemote("s", { home: "/remote/home", model: "m" }, io(["retire-home", "session-start"]));
    assert.equal(out.envelope.ok, true);
    assert.equal(out.envelope.result.server, "s");
    assert.equal(out.envelope.result.instance, "r", "explicit-home routes preserve the remote instance name");
    const sent = calls.find((c) => c.includes("session start"));
    assert.match(sent, /session start --home \/remote\/home --model m --json/);
  } finally {
    if (prev === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = prev;
  }
});

test("recovery preserves the actual model and reconciles even an exited allocation", async () => {
  const f = await makeHome("model-recovery");
  const target = { backend: "tmux", session, window: "model-recovery-new", socket };
  const pending = pendingFor(f, target, { command: withLaunchModel(f.command, "claude-old"), model: "claude-old" });
  const receipt = join(f.home, ".oats-start-pending.json");
  await heldWindow(f, target.window);
  writeFileSync(receipt, JSON.stringify(pending));
  assert.throws(() => startInstanceSession(f.home, { model: "claude-new" }), (e) => e.code === "E_SESSION_RUNNING" && /not applied/.test(e.message));
  assert.equal(readJson(join(f.home, "instance.json")).model, "claude-old");
  assert.equal(inspectInstanceSession(f.home).present, true);
  tmux("kill-window", "-t", `=${session}:=${target.window}`);
  // Crash between baseline and metadata writes, followed by target exit.
  writeFileSync(join(f.home, "instance.json"), JSON.stringify(f.meta));
  writeFileSync(receipt, JSON.stringify(pending));
  assert.throws(() => inspectInstanceSession(f.home), (e) => e.code === "E_RUNTIME_AUTHORITY_MISMATCH");
  const r = startInstanceSession(f.home, { model: "claude-new" });
  assert.equal(r.model, "claude-new");
  assert.equal(r.target.window, target.window);
  assert.equal(existsSync(receipt), true, "the new launch keeps its own startup receipt");
});

test("invalid recovery receipts and tmux permission errors preserve evidence and never launch", async () => {
  const f = await makeHome("bad-recovery");
  const receipt = join(f.home, ".oats-start-pending.json");
  for (const bytes of ["{", '{}', '{"target":{"backend":"something"}}']) {
    writeFileSync(receipt, bytes);
    assert.throws(() => startInstanceSession(f.home), (e) => e.code === "E_SESSION_UNKNOWN");
    assert.equal(readFileSync(receipt, "utf8"), bytes);
  }
  rmSync(receipt);
  const io = { exec: (_bin, args) => {
    assert.ok(args.includes("list-panes"), "only inspection is attempted");
    throw Object.assign(new Error("socket failed"), { stderr: `error connecting to ${socket} (Permission denied)` });
  } };
  assert.throws(() => startInstanceSession(f.home, { io }), (e) => e.code === "E_SESSION_UNKNOWN");
  assert.deepEqual(readJson(join(f.home, "instance.json")), f.meta);
});

test("simultaneous CLI starts produce one launch and preserve a never-launched home's saved socket", async () => {
  const f = await makeHome("concurrent", { launched: false });
  const invoke = () => new Promise((resolveRun, reject) => {
    execFile(process.execPath, [bin, "session", "start", "--home", f.home, "--model", "claude-x", "--json"], { timeout: 15000 }, (error, stdout, stderr) => {
      try { resolveRun(JSON.parse(stdout)); } catch { reject(new Error(`${error?.message}: ${stderr}`)); }
    });
  });
  const results = await Promise.all([invoke(), invoke()]);
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
  assert.ok(results.some((r) => ["E_SESSION_START_BUSY", "E_SESSION_RUNNING"].includes(r.error?.code)), JSON.stringify(results));
  assert.deepEqual(windows().filter((w) => w === "concurrent"), ["concurrent"]);
  assert.equal(readJson(join(f.home, "instance.json")).restartCount, 1);
  assert.equal(readJson(join(f.home, "instance.json")).tmux.socket, socket);
});

test("a live startup shell is protected until its command actually exits", async () => {
  // Support running this regression alone, before any earlier test has
  // created the private server. All launches use the isolated shell fixture.
  if (!windows().length) tmux("new-session", "-d", "-s", session, "-n", "hq", "-c", base, "/bin/sh");
  const f = await makeHome("slow-shell");
  const harness = join(base, "slow-shell-wrapper");
  // Builtins only. macOS reports the interpreter as a shell; Linux may
  // report the script name as an active process. Both must refuse a retry.
  // The injected transient-child test below pins the shell-only branch.
  writeFileSync(harness, '#!/bin/bash\nprintf ready > "$OATS_INSTANCE_HOME/slow-ready"\nwhile [[ ! -e "$OATS_INSTANCE_HOME/slow-release" ]]; do :; done\nexit 0\n');
  chmodSync(harness, 0o755);
  writeFileSync(join(f.home, "instance.json"), JSON.stringify({ ...f.meta, command: `OATS_INSTANCE_HOME=${shq(f.home)} ${shq(harness)}` }));
  const first = startInstanceSession(f.home);
  const pane = tmux("display-message", "-p", "-t", `=${session}:=slow-shell`, "#{pane_id}");
  assert.equal(first.reused, "new");
  const mark = () => tmux("display-message", "-p", "-t", pane, "#{@oats-agent}");
  assert.equal(mark(), "slow-shell", "the start marked the pane it created as the agent's (#1569)");
  await waitUntil(() => existsSync(join(f.home, "slow-ready")), "startup shell ready");
  assert.throws(() => startInstanceSession(f.home), (e) => ["E_SESSION_START_BUSY", "E_SESSION_RUNNING"].includes(e.code));
  assert.equal(tmux("display-message", "-p", "-t", `=${session}:=slow-shell`, "#{pane_id}"), pane);
  assert.equal(readJson(join(f.home, "instance.json")).restartCount, 1);
  writeFileSync(join(f.home, "slow-release"), "");
  await waitUntil(() => existsSync(join(f.home, ".oats-start-exited")) && inspectInstanceSession(f.home).state === "shell", "slow shell completion marker");
  assert.equal(inspectInstanceSession(f.home).state, "shell");
  assert.equal(startInstanceSession(f.home).reused, "pane", "the matching exit marker permits a real restart");
  assert.equal(mark(), "slow-shell", "and the restart in place keeps the pane marked");
  assert.equal(readJson(join(f.home, "instance.json")).restartCount, 2, "reconciling a recorded attempt does not count it twice");
});

test("every malformed pending field is rejected before metadata or authority changes", async () => {
  const f = await makeHome("malformed-fields");
  const target = { backend: "tmux", session, window: "malformed-fields", socket };
  const receipt = join(f.home, ".oats-start-pending.json");
  const beforeMeta = readFileSync(join(f.home, "instance.json"), "utf8");
  const beforeBaseline = readFileSync(f.baselinePath, "utf8");
  const io = { exec: () => assert.fail("malformed receipt must refuse before inspection") };
  for (const fields of [{ command: { invalid: "not a command" } }, { command: "'claude' `id`" }, { model: {} }, { model: "bad\0model" }, { startedAt: "never" }, { startedAt: 123 }, { id: null }]) {
    const bytes = JSON.stringify(pendingFor(f, target, fields));
    writeFileSync(receipt, bytes);
    assert.throws(() => startInstanceSession(f.home, { io }), (e) => e.code === "E_SESSION_UNKNOWN");
    assert.equal(readFileSync(receipt, "utf8"), bytes);
    assert.equal(readFileSync(join(f.home, "instance.json"), "utf8"), beforeMeta);
    assert.equal(readFileSync(f.baselinePath, "utf8"), beforeBaseline);
  }
});

test("a transient startup child does not discard the startup guard", async () => {
  const f = await makeHome("transient-child");
  let launched = false, command = "cat", launches = 0;
  const io = { exec: (binary, args) => {
    if (binary === "ps") return "100 1 /bin/zsh\n";
    if (args.includes("list-panes")) {
      if (!launched) throw Object.assign(new Error("absent"), { stderr: "can't find window: transient-child" });
      return `%1\t0\t${command}\t100\n`;
    }
    if (args.includes("list-sessions")) return `${session}\t${socket}\n`;
    if (args.includes("list-windows")) return "hq\n";
    if (args.includes("new-window") || args.includes("respawn-pane")) { launched = true; launches++; return "@1\n"; }
    if (args.includes("set-option")) return "";
    assert.fail(`unexpected ${args}`);
  } };
  startInstanceSession(f.home, { io });
  assert.throws(() => startInstanceSession(f.home, { io }), (e) => e.code === "E_SESSION_RUNNING");
  command = "zsh"; // cat exited; the harness has not exec'd yet
  assert.throws(() => startInstanceSession(f.home, { io }), (e) => e.code === "E_SESSION_START_BUSY");
  assert.equal(launches, 1);
  assert.equal(readJson(join(f.home, "instance.json")).restartCount, 1);
});

test("launch errors never expose saved commands through tmux diagnostics", async () => {
  const secret = "SYNTHETIC_START_SECRET";
  for (const backend of ["respawn", "new-window"]) {
    for (const failure of [{ stderr: secret }, { stderr: "" }, { code: "ENOENT" }, { code: "ETIMEDOUT" }, { signal: "SIGTERM" }]) {
      const f = await makeHome(`redact-${backend}-${Object.keys(failure)[0]}-${String(failure.stderr ?? failure.code ?? failure.signal).length}`);
      const meta = { ...f.meta, command: `REVIEW_TOKEN=${shq(secret)} ${f.command}` };
      writeFileSync(join(f.home, "instance.json"), JSON.stringify(meta));
      const baseline = readFileSync(f.baselinePath, "utf8");
      const io = { exec: (binary, args) => {
        if (binary === "ps") return "100 1 /bin/zsh\n";
        if (args.includes("list-panes")) {
          if (backend === "new-window") throw Object.assign(new Error("absent"), { stderr: "can't find window: agent" });
          return "%1\t0\tzsh\t100\n";
        }
        if (args.includes("list-sessions")) return `${session}\t${socket}\n`;
        if (args.includes("list-windows")) return "hq\n";
        assert.ok(args.includes("respawn-pane") || args.includes("new-window"));
        throw Object.assign(new Error(`Command failed: ${binary} ${args.join(" ")}`), failure);
      } };
      assert.throws(() => startInstanceSession(f.home, { io }), (e) => e.code === "E_SESSION_START_FAILED" && !e.message.includes(secret) && /evidence is retained/.test(e.message));
      assert.ok(readJson(join(f.home, ".oats-start-pending.json")).command.includes(secret));
      assert.deepEqual(readJson(join(f.home, "instance.json")), meta);
      assert.equal(readFileSync(f.baselinePath, "utf8"), baseline);
    }
  }
});

test("successful launch responses omit the private launch command too", async () => {
  const f = await makeHome("private-result");
  const secret = "SYNTHETIC_RESPONSE_SECRET";
  writeFileSync(join(f.home, "instance.json"), JSON.stringify({ ...f.meta, command: `REVIEW_TOKEN=${shq(secret)} ${f.command}` }));
  const io = { exec: (binary, args) => {
    if (args.includes("list-panes")) throw Object.assign(new Error("absent"), { stderr: "can't find window: private-result" });
    if (args.includes("list-sessions")) return `${session}\t${socket}\n`;
    if (args.includes("list-windows")) return "hq\n";
    // The launch's new-window carries the mark's set-option (#1569): it is answered first.
    if (args.includes("new-window")) return "@1\n";
    assert.ok(args.includes("set-option"));
    return "";
  } };
  const result = startInstanceSession(f.home, { io });
  assert.equal("command" in result, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.ok(readJson(join(f.home, "instance.json")).command.includes(secret));
});

test("1569: a start's new window and a restart in place mark the agent's pane in the launch's own tmux call", async () => {
  const launches = [];
  /** No tmux runs. `pane`: the recorded window's one pane, at a shell (the start respawns it), or
   *  none (the window is gone: the start creates one). */
  const io = (pane) => ({ exec: (binary, args) => {
    if (binary === "ps") return "100 1 /bin/zsh\n";
    if (args.includes("list-panes")) {
      if (!pane) throw Object.assign(new Error("absent"), { stderr: "can't find window: mark" });
      return pane;
    }
    if (args.includes("list-sessions")) return `${session}\t${socket}\n`;
    if (args.includes("list-windows")) return "hq\n";
    if (args.includes("new-window") || args.includes("respawn-pane")) { launches.push(args.slice(3)); return "@1\n"; }
    return "";
  } });
  const windowCommand = /; exec "\$\{SHELL:-\/bin\/zsh\}"$/;
  const created = await makeHome("mark-new");
  assert.equal(startInstanceSession(created.home, { io: io(null) }).reused, "new");
  const [window] = launches;
  assert.equal(window[0], "new-window");
  assert.match(window.at(-7), windowCommand, "the window's command, then the mark");
  assert.deepEqual(window.slice(-6), [";", "set-option", "-q", "-p", "@oats-agent", "mark-new"], "the new pane: tmux's current one after new-window");
  // A pane from before the mark (unmarked, %5) restarted in place: the respawn marks it by its id.
  const legacy = await makeHome("mark-legacy");
  assert.equal(startInstanceSession(legacy.home, { io: io("%5\t0\tzsh\t100\n") }).reused, "pane");
  const respawn = launches[1];
  assert.deepEqual(respawn.slice(0, 4), ["respawn-pane", "-k", "-t", "%5"]);
  assert.match(respawn.at(-9), windowCommand);
  assert.deepEqual(respawn.slice(-8), [";", "set-option", "-q", "-p", "-t", "%5", "@oats-agent", "mark-legacy"]);
  assert.equal(launches.length, 2);
});
