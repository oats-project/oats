// `dialogClaims` (feature wake-hold, awebai/oats#1670): a spawn or launch hook says whether this
// session's dialogs become claims, the kernel records it per capability beside `meta`, and
// `oats session inspect` reads it as `wakeHold`. Fixture capabilities pin the kernel's contract; the
// last tests are the real kernel through the real oats.core, on real tmux with private sockets.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { inspectInstanceSession, restartInstanceSession, startInstanceSession } from "../lib/core.mjs";
import { readEvents } from "../lib/instance-events.mjs";
import { v2Deployment } from "./helpers/v2-deployment.mjs";
import { isolateSessionEnvironment, oatsSocket, waitUntil } from "./helpers/host-fixture.mjs";

const CAP = resolve(new URL("../oats-package/capabilities/oats-core", import.meta.url).pathname);
const CLI = resolve(new URL("../bin/oats.mjs", import.meta.url).pathname);
const base = realpathSync(mkdtempSync(join(tmpdir(), "oats-dialog-claims-")));
const session = "d";
const restoreEnvironment = isolateSessionEnvironment(base);
const socket = oatsSocket();
const tmux = (...args) => execFileSync("tmux", ["-u", "-S", socket, ...args], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }).trim();
test.after(() => { try { tmux("kill-server"); } catch { /* gone */ } finally { restoreEnvironment(); rmSync(base, { recursive: true, force: true }); } });
function write(p, c, mode) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); if (mode) chmodSync(p, mode); return p; }
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const answersOf = (home) => readJson(join(home, "instance.json")).dialogClaims;

// A harness that idles (an exec'ed sleep) and answers `--version` as `version`, or fails to.
const binDir = join(base, "bin");
const claude = (name, version) => write(join(binDir, name), `#!/bin/sh\n[ "$1" = --version ] && { ${version ? `echo '${version} (Claude Code)'; exit 0` : "exit 1"}; }\necho $$ > "$OATS_INSTANCE_HOME/pid.txt"\nexec sleep 86400\n`, 0o755);
const supported = claude("claude-new", "2.1.308"), old = claude("claude-old", "2.1.77"), broken = claude("claude-broken", null);
process.env.PATH = `${binDir}:${process.env.PATH}`;
const TMUX = spawnSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim();

// A program that moves while a hook asks it: a supported Claude whose `--version` runs `moves` first,
// so the hook is right about the program it was handed and the launch runs another.
const moving = (path, moves) => write(path, `#!/bin/sh\n[ "$1" = --version ] && { ${moves}; echo '2.1.308 (Claude Code)'; exit 0; }\necho $$ > "$OATS_INSTANCE_HOME/pid.txt"\nexec sleep 86400\n`, 0o755);
const LINK = join(base, "link", "claude");
const relinked = moving(join(binDir, "claude-relinked"), `/bin/rm -f '${LINK}'; /bin/ln -s '${old}' '${LINK}'`);
const linkToSupported = () => { mkdirSync(dirname(LINK), { recursive: true }); rmSync(LINK, { force: true }); symlinkSync(relinked, LINK); };
linkToSupported();
const onPath = (name, version) => write(join(base, name, "claude"), `#!/bin/sh\n[ "$1" = --version ] && { echo '${version} (Claude Code)'; exit 0; }\necho $$ > "$OATS_INSTANCE_HOME/pid.txt"\nexec sleep 86400\n`, 0o755);
const pathWith = (claudePath) => `${dirname(claudePath)}:${process.env.PATH}`;
const sessionPath = (path) => [TMUX, "-u", "-S", socket, "set-environment", "-t", session, "PATH", path];
// The next launch hook of a `test.mover` capability moves the session's PATH here.
const movePathFile = join(base, "move-path");

// What a hook answers is the test's to say: <base>/answers/<instance>.<spawn|launch|preview>.json,
// `{}` with none. An answer with `exit` exits with it, after printing, as a failing hook does.
const answers = join(base, "answers");
const say = (instance, pass, answer) => write(join(answers, `${instance}.${pass}.json`), JSON.stringify(answer));
const hook = `import { readFileSync } from "node:fs"; import { join } from "node:path";
const pass = process.env.OATS_LAUNCH_PREVIEW === "1" ? "preview" : process.env.OATS_EVENT;
let text = "{}";
try { text = readFileSync(join(${JSON.stringify(answers)}, process.env.OATS_INSTANCE + "." + pass + ".json"), "utf8"); } catch { /* no answer */ }
console.log(text);
process.exit(JSON.parse(text).exit ?? 0);
`;
const fx = v2Deployment({
  souls: { both: { soul: { capabilities: { "test.claims": { from: "here" }, "test.spawnonly": { from: "here" } } } },
    unaware: { soul: { capabilities: { "test.unaware": { from: "here" } } } },
    dev: { soul: { capabilities: { "oats.core": { from: "here" } } } },
    devspawn: { soul: { capabilities: { "oats.core": { from: "here" }, "test.spawnonly": { from: "here" } } } },
    moved: { soul: { capabilities: { "oats.core": { from: "here" }, "test.mover": { from: "here" } } } } },
  capabilityDirs: { "oats-core": CAP },
  capabilities: {
    "test.claims": { manifest: { launchPreview: true, hooks: { spawn: "hook.mjs", launch: "hook.mjs" }, settings: {} }, files: { "hook.mjs": hook } },
    "test.spawnonly": { manifest: { hooks: { spawn: "hook.mjs" }, settings: {} }, files: { "hook.mjs": `console.log('{"dialogClaims":"none"}');\n` } },
    "test.unaware": { manifest: { hooks: { spawn: "hook.mjs", launch: "hook.mjs" }, settings: {} }, files: { "hook.mjs": hook } },
    // No launchPreview: it runs for real in the plan, handed the plan's executable.
    "test.mover": { manifest: { hooks: { spawn: "hook.mjs", launch: "hook.mjs" }, settings: {} }, files: { "hook.mjs": `import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
const file = ${JSON.stringify(movePathFile)};
if (process.env.OATS_EVENT === "launch" && existsSync(file)) { const [bin, ...args] = ${JSON.stringify(sessionPath(""))}; execFileSync(bin, [...args.slice(0, -1), readFileSync(file, "utf8")]); rmSync(file); }
console.log('{"dialogClaims":"reported"}');
` } },
  },
  local: { "launch-configs": {
    probe: { harness: "claude", executable: supported }, older: { harness: "claude", executable: old }, failing: { harness: "claude", executable: broken },
    piprobe: { harness: "pi", executable: supported },
    moves: { harness: "claude", executable: LINK },
    bare: { harness: "claude", executable: "claude" },
    // A reference this host does not set: a start under it fails preflight.
    unset: { harness: "claude", executable: supported, env: { KEY: { fromEnv: "DIALOG_CLAIMS_UNSET" } } },
  } },
});
test.after(() => fx.cleanup());

/** A spawned home, pointed at the private tmux socket as a started home would be, and not running. */
async function spawnHome(soul, name, { launchConfig = "probe", ...opts } = {}) {
  const { home, warnings } = await fx.spawn(soul, { name, work: "checkout", launch: false, launchConfig, ...opts });
  write(join(home, "instance.json"), JSON.stringify({ ...readJson(join(home, "instance.json")), tmux: { session, window: name, socket }, launched: true }, null, 2) + "\n");
  const baseline = join(dirname(home), ".oats-retirement", "baselines", `${createHash("sha256").update(home).digest("hex")}.json`);
  write(baseline, JSON.stringify({ ...readJson(baseline), runtime: { launched: true, tmux: { session, window: name, socket } } }, null, 2) + "\n");
  return { home, warnings };
}
const server = () => { try { tmux("has-session", "-t", session); } catch { tmux("new-session", "-d", "-s", session, "-n", "hq"); } };
const up = async (home) => assert.ok(await waitUntil(() => { try { return !!readFileSync(join(home, "pid.txt"), "utf8"); } catch { return false; } }, "harness up"));
async function start(home, opts = {}) {
  server();
  rmSync(join(home, "pid.txt"), { force: true });
  const r = startInstanceSession(home, { env: { ...process.env }, ...opts });
  await up(home);
  return r;
}
async function restart(home, opts = {}) {
  rmSync(join(home, "pid.txt"), { force: true });
  const r = restartInstanceSession(home, { env: { ...process.env }, stopGraceMs: 5000, ...opts });
  await up(home);
  return r;
}
const hold = (home) => inspectInstanceSession(home).wakeHold;
/** Stop the window so the home reads stopped, and a later start is an ordinary one. */
function stopWindow(home, name) { try { tmux("kill-window", "-t", `=${session}:${name}`); } catch { /* gone */ } rmSync(join(home, ".oats-start-pending.json"), { force: true }); }

test("The second operator's side's case: a spawn answers `reported`, a start answers nothing, inspect reads `unknown`", async () => {
  const name = "named-case";
  say(name, "spawn", { dialogClaims: "reported" });
  const { home } = await spawnHome("both", name);
  assert.deepEqual(answersOf(home), { "test.claims": "reported", "test.spawnonly": "none" });
  await start(home);
  assert.equal(hold(home), "not-exposed", "test.claims's entry is gone; test.spawnonly's hook didn't run and keeps its");
  assert.deepEqual(answersOf(home), { "test.spawnonly": "none" });
  const only = "named-case-alone";
  say(only, "spawn", { dialogClaims: "reported" });
  const alone = await spawnHome("unaware", only);
  assert.equal(hold(alone.home), "on-claims");
  await start(alone.home);
  assert.equal(answersOf(alone.home), undefined, "no entry is left, so no key");
  assert.equal(hold(alone.home), "unknown");
  stopWindow(alone.home, only);
});

test("an answer at a start sets its entry, from a hook that declares preview awareness or one that doesn't", async () => {
  const aware = "start-answers", unaware = "start-answers-unaware";
  say(aware, "launch", { dialogClaims: "reported" });
  const a = await spawnHome("both", aware);
  await start(a.home);
  assert.deepEqual(answersOf(a.home), { "test.claims": "reported", "test.spawnonly": "none" }, "a real answer differs from the preview's `{}`, and refuses nothing");
  assert.equal(hold(a.home), "on-claims", "any `reported` wins over a `none`");
  say(unaware, "launch", { dialogClaims: "none" });
  const u = await spawnHome("unaware", unaware);
  await start(u.home);
  assert.deepEqual(answersOf(u.home), { "test.unaware": "none" });
  assert.equal(hold(u.home), "not-exposed");
});

test("a preview's answer is never recorded", async () => {
  const name = "preview-answer";
  say(name, "preview", { dialogClaims: "reported" });
  const { home } = await spawnHome("unaware", name);
  const both = "preview-answer-both";
  say(both, "preview", { dialogClaims: "reported" });
  const b = await spawnHome("both", both);
  const r = spawnSync(process.execPath, [CLI, "launch-config", "preview", "--home", b.home, "--launch-config", "probe", "--json"], { encoding: "utf8", env: { ...process.env, ...fx.env } });
  assert.equal(JSON.parse(r.stdout.trim()).ok, true, r.stdout + r.stderr);
  assert.deepEqual(answersOf(b.home), { "test.spawnonly": "none" }, "a launch preview records nothing");
  await start(b.home);
  assert.deepEqual(answersOf(b.home), { "test.spawnonly": "none" }, "a start's own preview pass answered `reported`, its real run nothing");
  assert.equal(answersOf(home), undefined);
});

test("an invalid value is warned about and read as no answer, at a spawn and at a start", async () => {
  const name = "invalid-value";
  say(name, "spawn", { dialogClaims: "protected" });
  const { home, warnings } = await spawnHome("both", name);
  assert.ok(warnings.some((w) => /test\.claims spawn hook answered dialogClaims "protected", neither "reported" nor "none"; read as no answer/.test(w)), JSON.stringify(warnings));
  assert.deepEqual(answersOf(home), { "test.spawnonly": "none" });
  say(name, "launch", { dialogClaims: ["reported", "x".repeat(4000)] });
  const started = await start(home);
  const said = started.warnings.find((w) => /test\.claims launch hook answered dialogClaims/.test(w));
  assert.ok(said && said.length < 200, "bounded: it is a launch-warning event, and the Desktop's reader bounds a detail");
  assert.ok(readEvents(home).events.some((e) => e.kind === "launch-warning" && e.data.message === said));
  assert.deepEqual(answersOf(home), { "test.spawnonly": "none" });
});

test("a failed hook removes its entry at a spawn; a start that fails preparation changes nothing", async () => {
  const failed = "failed-spawn-hook";
  say(failed, "spawn", { dialogClaims: "reported", exit: 1 });
  const f = await spawnHome("both", failed);
  assert.deepEqual(answersOf(f.home), { "test.spawnonly": "none" }, "what a failed hook printed is no answer");

  const name = "failed-start";
  say(name, "spawn", { dialogClaims: "reported" });
  const { home } = await spawnHome("both", name);
  const record = () => readFileSync(join(home, "instance.json"), "utf8");
  const before = record();
  server();
  say(name, "launch", { dialogClaims: "none", exit: 1 });
  assert.throws(() => startInstanceSession(home, { env: { ...process.env } }), (e) => e.code === "E_LAUNCH_PREPARATION");
  assert.equal(record(), before, "a hook that failed for real: nothing recorded");
  say(name, "launch", { dialogClaims: "none" });
  assert.throws(() => startInstanceSession(home, { launchConfig: "unset", env: { ...process.env } }), (e) => e.code === "E_LAUNCH_ENV_MISSING");
  assert.equal(record(), before, "a preflight that failed: nothing recorded");
  assert.equal(hold(home), "on-claims");
});

test("every wakeHold value on a home that isn't running, and on a missing one", async () => {
  const never = await fx.spawn("both", { name: "never-launched", work: "checkout", launch: false, launchConfig: "probe" });
  assert.deepEqual([inspectInstanceSession(never.home).state, hold(never.home)], ["not-launched", "not-exposed"]);
  for (const [value, wakeHold] of [
    [{ a: "reported" }, "on-claims"], [{ a: "none", b: "reported" }, "on-claims"], [{ a: "none" }, "not-exposed"],
    [{}, "unknown"], [undefined, "unknown"], ["reported", "unknown"], [["reported"], "unknown"], [null, "unknown"], [{ a: "maybe" }, "unknown"],
  ]) {
    const name = `stopped-${createHash("sha256").update(JSON.stringify(value) ?? "none").digest("hex").slice(0, 8)}`;
    const { home } = await spawnHome("unaware", name);
    server();
    const meta = readJson(join(home, "instance.json"));
    write(join(home, "instance.json"), JSON.stringify({ ...meta, dialogClaims: value }, null, 2) + "\n");
    const seen = inspectInstanceSession(home);
    assert.deepEqual([seen.state, seen.present, seen.running, seen.wakeHold], ["stopped", false, false, wakeHold], JSON.stringify(value));
  }
  const gone = join(base, "no-such-home");
  assert.equal(inspectInstanceSession(gone).wakeHold, "unknown");
  const r = spawnSync(process.execPath, [CLI, "session", "inspect", "--home", gone, "--json"], { encoding: "utf8", env: { ...process.env, ...fx.env } });
  assert.equal(JSON.parse(r.stdout.trim()).result.wakeHold, "unknown", r.stdout + r.stderr);
  assert.ok(JSON.parse(spawnSync(process.execPath, [CLI, "version", "--json"], { encoding: "utf8" }).stdout).features.includes("wake-hold"));
});

// ---- the real kernel through the real oats.core ----

test("oats.core: a Claude that takes the hooks reads on-claims, from the spawn and from a start; the settings are in the home", async () => {
  const { home } = await spawnHome("dev", "core-supported");
  assert.deepEqual(answersOf(home), { "oats.core": "reported" }, "the spawn's hook wrote the settings and asked this executable");
  assert.equal(hold(home), "on-claims");
  await start(home);
  assert.equal(hold(home), "on-claims");
  assert.ok(readJson(join(home, ".claude", "settings.json")).hooks.StopFailure);
});

test("oats.core: 2.1.77 selected and a failed --version answer nothing, so `unknown`, and an earlier `reported` doesn't survive (the second operator's side, end to end)", async () => {
  const name = "core-downgrade";
  const { home } = await spawnHome("dev", name);
  await start(home);
  assert.equal(hold(home), "on-claims");
  await restart(home, { launchConfig: "older" });
  assert.equal(answersOf(home), undefined);
  assert.equal(hold(home), "unknown", "a supported start followed by an unsupported one");
  await restart(home, { launchConfig: "probe" });
  assert.equal(hold(home), "on-claims");
  await restart(home, { launchConfig: "failing" });
  assert.equal(hold(home), "unknown");
  const spawned = await spawnHome("dev", "core-spawned-old", { launchConfig: "older" });
  assert.equal(hold(spawned.home), "unknown");
});

test("oats.core: an unknown executable answers nothing, and the settings are written all the same", async () => {
  // A bare name a spawn with no launch found on its own PATH, a supported one: no pane-side answer, so the kernel hands none.
  claude("claude", "2.1.308");
  const { home } = await spawnHome("dev", "core-unknown", { launchConfig: "none", harness: "claude" });
  assert.equal(hold(home), "unknown");
  assert.equal(answersOf(home), undefined);
  assert.ok(readJson(join(home, ".claude", "settings.json")).hooks.PreToolUse, "written: what is unknown is whether they fire");
});

test("oats.core: a settings file it refuses reads unknown, and takes `reported` away", async () => {
  const { home } = await spawnHome("dev", "core-refused");
  assert.equal(hold(home), "on-claims");
  write(join(home, ".claude", "settings.json"), "not json");
  const started = await start(home);
  assert.ok(started.warnings.some((w) => /is not valid JSON/.test(w)), JSON.stringify(started.warnings));
  assert.equal(hold(home), "unknown");
  assert.equal(answersOf(home), undefined);
});

test("oats.core: a pi home answers nothing and reads unknown", async () => {
  const { home } = await spawnHome("dev", "core-pi", { launchConfig: "piprobe" });
  assert.equal(hold(home), "unknown");
  await start(home);
  assert.equal(hold(home), "unknown");
  assert.equal(answersOf(home), undefined);
});

// ---- a launch that runs another program than its hooks were handed ----

const replaced = (warnings) => warnings.filter((w) => /the harness executable changed after the hooks ran/.test(w));

test("oats.core: a spawn whose symlink moved while the hook asked it warns, and its `reported` isn't recorded: the statement was about the other program", async () => {
  linkToSupported();
  const r = fx.cli(["spawn", "dev", "--name", "core-moved-spawn", "--launch-config", "moves", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const { home, warnings } = r.json().result;
  await up(home);
  assert.equal(replaced(warnings).length, 1, JSON.stringify(warnings));
  assert.equal(realpathSync(LINK), old, "the launch ran 2.1.77");
  assert.equal(answersOf(home), undefined);
  assert.equal(hold(home), "unknown");
});

test("oats.core: a start whose symlink moved removes the earlier `reported`, and a capability whose hook didn't run keeps its entry", async () => {
  linkToSupported();
  const name = "core-moved-start";
  const { home } = await spawnHome("devspawn", name);
  assert.deepEqual(answersOf(home), { "oats.core": "reported", "test.spawnonly": "none" });
  const started = await start(home, { launchConfig: "moves" });
  assert.equal(replaced(started.warnings).length, 1, JSON.stringify(started.warnings));
  assert.deepEqual(answersOf(home), { "test.spawnonly": "none" });
  assert.equal(hold(home), "not-exposed");
  stopWindow(home, name);
});

test("a start whose window's session looks the harness up elsewhere, after the hooks ran: the record, which reads the start's receipt, keeps no answer of theirs", async () => {
  const name = "core-moved-window", unsupported = onPath("session-old", "2.1.77");
  // oats.core's `--version` moves the session's PATH: nothing changes until the look at the window's creation.
  const handed = moving(join(base, "session-new", "claude"), `${sessionPath(pathWith(unsupported)).map((a) => `'${a}'`).join(" ")}`);
  const { home } = await spawnHome("dev", name);
  assert.equal(hold(home), "on-claims");
  server();
  execFileSync(sessionPath("")[0], [...sessionPath("").slice(1, -1), pathWith(handed)]);
  try {
    const started = await start(home, { launchConfig: "bare" });
    assert.equal(replaced(started.warnings).length, 1, JSON.stringify(started.warnings));
    assert.equal(readJson(join(home, "instance.json")).launch.executable, unsupported, "the launch ran the one the session found");
    assert.equal(answersOf(home), undefined);
    assert.equal(hold(home), "unknown");
  } finally { tmux("set-environment", "-u", "-t", session, "PATH"); stopWindow(home, name); }
});

test("a hook that ran in the plan was handed the plan's executable: moved before the real pass, its answer goes and the real pass's stays", async () => {
  const name = "plan-pass-moved", first = onPath("plan-first", "2.1.308"), second = onPath("plan-second", "2.1.308");
  const { home } = await spawnHome("moved", name);
  assert.deepEqual(answersOf(home), { "oats.core": "reported", "test.mover": "reported" });
  server();
  execFileSync(sessionPath("")[0], [...sessionPath("").slice(1, -1), pathWith(first)]);
  write(movePathFile, pathWith(second));
  try {
    await start(home, { launchConfig: "bare" });
    assert.equal(existsSync(movePathFile), false, "the plan's hook ran");
    assert.equal(readJson(join(home, "instance.json")).launch.executable, second);
    assert.deepEqual(answersOf(home), { "oats.core": "reported" }, "oats.core ran after the move, on the program this launch runs");
  } finally { tmux("set-environment", "-u", "-t", session, "PATH"); stopWindow(home, name); }
});
