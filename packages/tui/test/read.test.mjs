// The effects of the TUI (lib/read.mjs): the reads of every served deployment, the roster of other
// machines, the looks at the file system and the exec of the start's one kernel call, with real
// child processes wherever the behaviour is about processes. The kernel and the collector are
// FAKES (fixtures/fake.mjs), copied into a temp directory: no test runs a real `oats` against a
// deployment, and none starts tmux.
// A test signals only a pid a fake wrote down, and only after it has seen that the pid is its fake.
import test from "node:test";
import assert from "node:assert/strict";
import { ChildProcess, execFile as nodeExecFile, execFileSync, spawn as nodeSpawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COLLECTOR, DETACH_KEY_FEATURE, INSTANCE_VARIABLES, MAX_DEPLOYMENT_OBSERVATIONS, acceptProbe, cliReadsRemotes, cliRecord, cliRemoteRoster, createResumeTrigger, failedEntry, livenessInput, observeIdentities, prepareRemoteTerm, remoteRosterState } from "../lib/client.mjs";
import { CHANGE_FILES, IDENTITY_BUDGET_MS, KERNEL_BIN, KERNEL_VERSION, admitDeployment, createIdentityReads, createReader, findDeployment, leaveInstance, probeKernel, startExec } from "../lib/read.mjs";
import { PANEL_FS } from "../lib/panel.mjs";
import { resumeObservation } from "../lib/model.mjs";
import { initialState, reduce } from "../lib/store.mjs";

const FAKE = fileURLToPath(new URL("./fixtures/fake.mjs", import.meta.url));
const LEAVE = fileURLToPath(new URL("./fixtures/leave.mjs", import.meta.url));
const REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url));
/** The version this checkout's kernel reports: the accepted band always admits its own release. */
const VERSION = JSON.parse(readFileSync(path.join(REPOSITORY, "package.json"), "utf8")).version;
/** What the shared observer requires of a kernel, and the feature that puts --max-age on a read. */
const FEATURES = ["workspace-v2", "instance-modules", "served-identity", "packages-no-approval", "observe-max-age"];
const EIGHT = ["PI_AGENTS_ROOT", "PI_AGENT_HOME", "PI_AGENT_INSTANCE", "OATS_HOME", "OATS_INSTANCE_HOME", "OATS_INSTANCE", "OATS_DEPLOYMENT", "OATS_RESOLUTION"];

const ROOT = realpathSync(mkdtempSync(path.join(os.tmpdir(), "oats-tui-read-")));
/** This suite may itself run inside an instance: the fakes get an environment that has left it. */
const CLEAN_ENV = leaveInstance({ ...process.env });
const worlds = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quietly = (act) => { try { return act(); } catch { return undefined; } };
/** Poll until `check()` answers something; it is asked once more after the time is up. */
async function waitFor(what, check, ms = 20_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(15);
  }
}
/** Whether `promise` settles within `ms`. The timer keeps the event loop alive meanwhile: an ended child is unref'd. */
async function settled(promise, ms = 20_000) {
  let timer;
  const answer = await Promise.race([promise.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); })]);
  clearTimeout(timer);
  return answer;
}
/** Stop this process's event loop for `ms`: it reads no pipe and runs no timer, as a stopped process does not. */
const freeze = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** A process's fields after its name in /proc (state, parent, group, session); without a /proc, ONE field: what `ps` says of its state. */
function stateOf(pid) {
  if (existsSync("/proc/self/stat")) {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  }
  return [execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().slice(0, 1)];
}
/** Signal 0 only: whether the pid names a process at all. False once it ended AND was reaped. */
function exists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}
/** Whether the process still runs. One that ended and was not reaped yet (a zombie) does not. */
function alive(pid) {
  if (!exists(pid)) return false;
  try { return stateOf(pid)[0] !== "Z"; } catch { return false; }
}
/** Whether the pid is one of this suite's fakes NOW: its command line names the temp directory. */
function ours(pid) {
  try {
    const command = existsSync("/proc/self/stat") ? readFileSync(`/proc/${pid}/cmdline`, "utf8") : execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    return command.includes(ROOT);
  } catch { return false; }
}
const gone = (pids, ms = 2000) => waitFor(`pid ${pids.join(", ")} to be gone`, () => pids.every((pid) => !alive(pid)), ms);
/** The process group a process is in: /proc's field where there is a /proc, else what `ps` says (macOS has no /proc). Null unless that is a number. */
function groupOf(pid) {
  const text = quietly(() => (existsSync("/proc/self/stat") ? stateOf(pid)[2] : execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim()));
  return /^[0-9]+$/.test(text ?? "") ? Number(text) : null;
}
/** This process's own group. Null where neither source names it: there the tests below compare no child's group with it. */
const OWN_GROUP = groupOf(process.pid);

test.after(() => {
  // Nothing is left behind: whatever a fake wrote down and still runs as that fake is killed.
  for (const world of worlds) for (const { pid } of world.calls()) if (alive(pid) && ours(pid)) quietly(() => process.kill(pid, "SIGKILL"));
  rmSync(ROOT, { recursive: true, force: true });
});

/** A temp directory with a deployment directory, the three fakes and their plan. */
function makeWorld(plan = {}) {
  const dir = path.join(ROOT, `world-${worlds.length + 1}`), deployment = path.join(dir, "deployment"), log = path.join(dir, "calls.jsonl");
  mkdirSync(deployment, { recursive: true });
  for (const name of ["oats", "collector", "sleeper"]) copyFileSync(FAKE, path.join(dir, `${name}.mjs`));
  const world = {
    dir, deployment, bin: path.join(dir, "oats.mjs"), collector: path.join(dir, "collector.mjs"),
    plan(next) { writeFileSync(path.join(dir, "plan.json"), JSON.stringify(next)); },
    /** One more deployment directory of this world: its path. */
    another(name) { const more = path.join(dir, name); mkdirSync(more); return more; },
    /** What the fakes wrote down, in order; `calls("status", "start")` narrows it. */
    calls(action, event) {
      const all = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
      return all.filter((call) => (action === undefined || call.action === action) && (event === undefined || call.event === event));
    },
  };
  // The record of a kernel that reads no other machine, and of one that does (`remote` lists `roster`).
  world.cli = cliRecord({ version: VERSION, workspaceApi: 2, features: FEATURES }, { bin: world.bin, source: "tui" });
  world.remoteCli = cliRecord({ version: VERSION, workspaceApi: 2, features: FEATURES, remote: ["roster"] }, { bin: world.bin, source: "tui" });
  world.plan(plan);
  worlds.push(world);
  return world;
}
/** One instance as the kernel reports it. */
const kernelRow = (name, more = {}) => ({ instance: name, running: true, runtimeState: "running", tmux: { session: "oats", window: name, socket: null }, ...more });
/** The smallest `status --json` the shared reader accepts for `deployment`, with these instances under one soul. */
function statusDocument(deployment, rows = [], souls = []) {
  const dir = path.join(deployment, "agents", "dev");
  return { root: path.join(deployment, "agents"), agents: [
    { name: "dev", description: "The developer", dir, instances: rows.map((row) => ({ ...row, home: path.join(dir, "instances", row.instance) })) },
    ...souls.map((soul) => ({ ...soul, dir: path.join(deployment, "agents", soul.name), instances: [] })),
  ] };
}
/** The smallest `workspace status --json` the shared reader accepts for `deployment`. */
const workspaceDocument = (deployment) => ({ schemaVersion: 1, ok: true, result: { workspaceStatusApi: 1,
  workspace: { name: "fake-workspace", key: "local//fake", local: path.join(deployment, "oats-local.yaml") },
  members: [], packages: [], declaredPackages: [], unsynced: [], stale: [], external: [], problems: [] } });
const kernelError = (code, message, details) => ({ stdout: JSON.stringify({ schemaVersion: 1, ok: false, error: { code, message, ...(details ? { details } : {}) } }), exit: 1 });
/** A plan in which the kernel answers `rows` and the collector answers `answers` (as they are, when a string). */
function answering(world, rows = [], answers = [], more = {}) {
  return { status: { stdout: JSON.stringify(statusDocument(world.deployment, rows)) }, workspace: { stdout: JSON.stringify(workspaceDocument(world.deployment)) },
    collector: { stdout: typeof answers === "string" ? answers : JSON.stringify(answers) }, ...more };
}
/** The kernel's two answers about one deployment, as a plan's steps. */
const serving = (deployment, rows = []) => ({ status: { stdout: JSON.stringify(statusDocument(deployment, rows)) }, workspace: { stdout: JSON.stringify(workspaceDocument(deployment)) } });
/** The deployment a kernel call was asked about. */
const askedAbout = (call) => call.argv[call.argv.indexOf("--dir") + 1];
/** The `at` of the n-th cycle of a reader made by `reading`. */
const at = (n) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
/** What a store holds of the other machines before any read. */
const noRoster = () => ({ remote: { remoteGroups: [], rosterAnswered: false, rosterFailure: null }, memory: new Map(), notes: new Map() });
/** A reader over a world, with the caller's side of it: a store (an entry per deployment, `entry` the world's own; what it
 *  holds of the other machines), what was emitted, every process started. `served` is the list getServed() answers, or the
 *  function itself; it is the world's one deployment when none is given. `spawn` starts the process; every start is recorded. */
function reading(t, world, { served = [world.deployment], spawn = nodeSpawn, ...options } = {}) {
  const entries = [], rosters = [], spawned = [];
  const store = { entries: new Map(), roster: noRoster(), get entry() { return this.entries.get(world.deployment) ?? null; } };
  let cycles = 0;
  const reader = createReader({
    cli: world.cli, env: CLEAN_ENV, collector: world.collector,
    getServed: typeof served === "function" ? served : () => served,
    getEntry: (id) => store.entries.get(id) ?? null,
    getRoster: () => store.roster,
    onEntry: (emitted) => { entries.push(emitted); store.entries.set(emitted.id, emitted.entry); },
    onRoster: (event) => { rosters.push(event); if (event.roster) store.roster = { remote: event.roster.remote, memory: event.roster.memory, notes: event.roster.notes }; },
    clock: () => at(++cycles),
    spawn: (file, args, opts) => { spawned.push({ file, args, options: opts }); return spawn(file, args, opts); },
    ...options,
  });
  t.after(() => reader.stop());
  return { reader, entries, rosters, spawned, store, begun: () => cycles };
}
/** Timers that fire when the test says so, with node's own names. */
function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    setTimeout(fn, ms) { const id = next++; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    delays: () => [...pending.values()].map((timer) => timer.ms).sort((a, b) => a - b),
    idOf: (ms) => [...pending].find(([, timer]) => timer.ms === ms)?.[0] ?? null,
    /** Fire the pending timers `match` picks: exactly `count` of them. */
    fire(match, count = 1) {
      const found = [...pending].filter(([, timer]) => match(timer.ms));
      assert.equal(found.length, count, `${count} to fire among ${[...pending.values()].map((timer) => timer.ms).join(", ")}`);
      for (const [id, timer] of found) { pending.delete(id); timer.fn(); }
    },
  };
}
const shown = (entry) => entry.instances.map((row) => [row.instance, row.running, row.runtimeState]);

// ── leaveInstance ─────────────────────────────────────────────────────────────

test("leaveInstance deletes the eight instance variables from the object it is given, and nothing else", () => {
  assert.deepEqual([...INSTANCE_VARIABLES].sort(), [...EIGHT].sort());
  const env = { PATH: "/usr/bin", HOME: "/home/someone", OATS_OTHER: "kept", PI_AGENT: "kept", ...Object.fromEntries(EIGHT.map((name) => [name, "set"])) };
  assert.equal(leaveInstance(env), env, "in place: the same object");
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/someone", OATS_OTHER: "kept", PI_AGENT: "kept" });
  assert.deepEqual(leaveInstance({}), {});
});

// ── findDeployment ────────────────────────────────────────────────────────────

test("findDeployment walks up from the canonical start, the root included, and reads only whether each directory is a deployment", () => {
  const asked = [];
  const io = (isDeployment, realpath = (p) => p) => ({ realpath, isDirectory: () => true, isDeployment: (dir) => { asked.push(dir); return isDeployment(dir); } });
  assert.deepEqual(findDeployment("/a/b/c", io(() => false)), { ok: false, dir: "/a/b/c" });
  assert.deepEqual(asked.splice(0), ["/a/b/c", "/a/b", "/a", "/"]);
  assert.deepEqual(findDeployment("/given/link", io((dir) => dir === "/real", () => "/real/x/y")), { ok: true, deployment: "/real" });
  assert.deepEqual(asked.splice(0), ["/real/x/y", "/real/x", "/real"], "from the canonical path, and no further than the first that answers");
  assert.deepEqual(findDeployment("/a/b", io((dir) => dir === "/")), { ok: true, deployment: "/" }, "the root is asked too");
  assert.deepEqual(findDeployment("/a/b", io((dir) => dir === "/a/b" || dir === "/a")), { ok: true, deployment: "/a/b" }, "the nearest one");
  assert.deepEqual(findDeployment("/a/b", io((dir) => { if (dir === "/a/b") throw new Error("EACCES"); return dir === "/a"; })), { ok: true, deployment: "/a" }, "a directory that cannot be asked is not one");
  asked.length = 0;
  assert.deepEqual(findDeployment("/a/b", { realpath: () => { throw new Error("ENOENT"); }, isDirectory: () => true, isDeployment: () => true }), { ok: false, dir: "/a/b" });
  assert.deepEqual(findDeployment("/a/file", { ...io(() => true), isDirectory: () => false }), { ok: false, dir: "/a/file" });
  assert.deepEqual(asked, [], "a start that is not a directory is not walked from");
});

test("findDeployment on a real tree: the deployment, deep inside it, a file, a missing path, outside, a linked oats-local.yaml, a linked start", (t) => {
  const base = path.join(ROOT, "find"), deployment = path.join(base, "deployment"), deep = path.join(deployment, "agents", "dev", "instances", "dev-one");
  const inner = path.join(deployment, "nested"), outside = path.join(base, "outside", "somewhere"), linked = path.join(base, "linked"), folder = path.join(base, "folder");
  for (const dir of [deep, path.join(inner, "below"), outside, linked, path.join(folder, "oats-local.yaml")]) mkdirSync(dir, { recursive: true });
  for (const dir of [deployment, inner]) writeFileSync(path.join(dir, "oats-local.yaml"), "");
  writeFileSync(path.join(deep, "TASK.md"), "a file");
  symlinkSync(path.join(deployment, "oats-local.yaml"), path.join(linked, "oats-local.yaml"));
  symlinkSync(deep, path.join(base, "to-deep"));
  symlinkSync(outside, path.join(base, "to-outside"));
  // Where the machine's own temp directory is inside a deployment, "outside" still finds that one.
  const above = findDeployment(ROOT);
  if (above.ok) t.diagnostic(`the temp directory is itself inside a deployment (${above.deployment})`);
  const none = (dir) => (above.ok ? above : { ok: false, dir });

  assert.deepEqual(findDeployment(deployment), { ok: true, deployment });
  assert.deepEqual(findDeployment(deep), { ok: true, deployment });
  assert.deepEqual(findDeployment(`${deep}${path.sep}`), { ok: true, deployment }, "a trailing separator");
  assert.deepEqual(findDeployment(path.join(inner, "below")), { ok: true, deployment: inner }, "the nearest deployment");
  assert.deepEqual(findDeployment(path.join(deep, "TASK.md")), { ok: false, dir: path.join(deep, "TASK.md") }, "a file, even inside one");
  assert.deepEqual(findDeployment(path.join(deep, "missing")), { ok: false, dir: path.join(deep, "missing") }, "a missing path, even inside one");
  assert.deepEqual(findDeployment(outside), none(outside));
  assert.deepEqual(findDeployment(linked), none(linked), "oats-local.yaml as a symbolic link is not a deployment's file");
  assert.deepEqual(findDeployment(folder), none(folder), "nor is a directory of that name");
  assert.deepEqual(findDeployment(path.join(base, "to-deep")), { ok: true, deployment }, "a start given through a link");
  assert.deepEqual(findDeployment(path.join(base, "to-outside")), none(outside), "and outside, the canonical directory is the one named");
});

// ── probeKernel ───────────────────────────────────────────────────────────────

const record = (more = {}) => ({ schemaVersion: 1, name: "@awebai/oats", version: VERSION, desktopApi: 1, workspaceApi: 2, features: FEATURES, harnesses: ["pi", "claude"], ...more });
const STDERR = "SECRET-ON-STDERR first line\nsecond line\n";

test("KERNEL_BIN is this install's own bin/oats.mjs, and its `version --json` is a record the probe accepts", async () => {
  assert.equal(KERNEL_BIN, path.join(REPOSITORY, "bin", "oats.mjs"));
  assert.equal(existsSync(KERNEL_BIN), true);
  // The kernel prints its record and reads no deployment for it.
  const probe = await probeKernel({ env: CLEAN_ENV });
  assert.equal(probe.ok, true, probe.reason);
  assert.deepEqual([probe.cli.bin, probe.cli.version, probe.cli.source, probe.cli.workspaceApi], [KERNEL_BIN, VERSION, "tui", 2]);
  for (const feature of FEATURES) assert.equal(probe.cli.features.includes(feature), true, feature);
});

test("#1879: the TUI judges its kernel against that kernel's own version, so on its own kernel it never sees aboveTested; a newer kernel is refused", async () => {
  assert.equal(KERNEL_VERSION, VERSION, "the tested version is the kernel package's own");
  const probe = await probeKernel({ env: CLEAN_ENV });
  assert.equal(probe.ok, true, probe.reason);
  assert.equal(Object.hasOwn(probe.cli, "aboveTested"), false);
  assert.equal(Object.hasOwn(probe.cli, "testedThrough"), false);
  assert.equal(acceptProbe(record(), KERNEL_VERSION).aboveTested, undefined, "its own record is inside its own bound");
  const [major, minor] = VERSION.split(".").map(Number);
  const newer = makeWorld({ version: { stdout: JSON.stringify(record({ version: `${major}.${minor + 1}.0` })), stderr: STDERR } });
  const refused = await probeKernel({ bin: newer.bin, env: CLEAN_ENV });
  assert.deepEqual(refused, { ok: false, reason: `version ${major}.${minor + 1}.0 is newer than this TUI's kernel ${VERSION}` });
  const untested = await probeKernel({ env: CLEAN_ENV, testedVersion: null });
  assert.equal(untested.ok, false, "without its kernel's version the probe refuses, as acceptProbe does");
  assert.match(untested.reason, /no tested client version/);
});

test("this suite knows its own process group on Linux and on macOS: no test that compares a child's group with it is skipped there", () => {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  assert.equal(Number.isInteger(OWN_GROUP) && OWN_GROUP > 0, true, `the group of pid ${process.pid} reads ${OWN_GROUP}`);
});

test("probeKernel accepts a kernel that answers its record: one exec of `node <bin> version --json`, not detached, and the shared record", async () => {
  const world = makeWorld({ version: { stdout: JSON.stringify(record()), stderr: STDERR } });
  const seen = [], env = { ...CLEAN_ENV };
  const probe = await probeKernel({ bin: world.bin, env, execFile: (file, args, options, callback) => { seen.push({ file, args, options }); return nodeExecFile(file, args, options, callback); } });
  assert.deepEqual(probe, { ok: true, cli: cliRecord(record(), { bin: world.bin, source: "tui" }) });
  assert.deepEqual([probe.cli.ok, probe.cli.bin, probe.cli.version, probe.cli.source, Array.isArray(probe.cli.features)], [true, world.bin, VERSION, "tui", true]);
  assert.equal(seen.length, 1);
  assert.deepEqual([seen[0].file, seen[0].args], [process.execPath, [world.bin, "version", "--json"]]);
  assert.deepEqual({ ...seen[0].options, env: null }, { timeout: 10_000, shell: false, encoding: "utf8", maxBuffer: 1024 * 1024, env: null });
  assert.equal(seen[0].options.env, env, "the environment it was given, as it is");
  const [call] = world.calls("version", "start");
  assert.deepEqual(call.argv, ["version", "--json"]);
  if (OWN_GROUP !== null) assert.equal(call.pgid, OWN_GROUP, "in the TUI's own process group: a Ctrl+C before the terminal is taken ends it too");
});

test("probeKernel refuses with acceptProbe's own reason, or with one of its four when there was no answer to judge; never with the error's text", async () => {
  const reasons = [];
  const probe = async (version, options = {}) => {
    const world = makeWorld({ version });
    const answer = await probeKernel({ bin: world.bin, env: CLEAN_ENV, ...options });
    assert.deepEqual(Object.keys(answer), ["ok", "reason"]);
    assert.equal(answer.ok, false);
    reasons.push([answer.reason, world]);
    return answer.reason;
  };
  for (const refused of [record({ name: "other" }), record({ version: "0.1.0" }), record({ desktopApi: 7 }), record({ version: `${VERSION}-rc.1` })]) {
    // Judged against the TUI's own kernel's version, as the probe judges it (KERNEL_VERSION).
    assert.equal(acceptProbe(refused, VERSION).ok, false);
    assert.equal(await probe({ stdout: JSON.stringify(refused), stderr: STDERR }), acceptProbe(refused, VERSION).reason);
  }
  assert.equal(reasons[0][0], "not the oats CLI (name: other, not @awebai/oats or @oats-project/oats)");
  assert.match(reasons[1][0], new RegExp("^version 0\\.1\\.0 outside >="));
  for (const garbage of ["this is not JSON {", "", "null", "42", `${JSON.stringify(record())} and more`]) assert.equal(await probe({ stdout: garbage, stderr: STDERR }), "it answered something that is not a version record", garbage);
  assert.equal(await probe({ stdout: JSON.stringify(record()), stderr: STDERR, exit: 1 }), "it failed", "a valid record and then exit 1");
  assert.equal(await probe({ stdout: "", stderr: STDERR, exit: 3 }), "it failed");
  assert.equal(await probe({ sleep: true, stderr: STDERR }, { timeoutMs: 400 }), "it did not answer within 0.4 seconds");
  const silent = reasons.at(-1)[1];
  // Not detached: execFile's timeout ended the one process it started.
  await gone(silent.calls("version", "start").map((call) => call.pid), 5000);

  const missing = await probeKernel({ bin: path.join(ROOT, "no-such-kernel.mjs"), env: CLEAN_ENV });
  assert.deepEqual(missing, { ok: false, reason: "it failed" }, "node ran and found no such file");
  const never = (file, args, options, callback) => nodeExecFile(path.join(ROOT, "no-such-node"), args, options, callback);
  assert.deepEqual(await probeKernel({ bin: silent.bin, env: CLEAN_ENV, execFile: never }), { ok: false, reason: "it did not start" });
  assert.deepEqual(await probeKernel({ bin: silent.bin, env: CLEAN_ENV, execFile: () => { throw new Error("spawn EAGAIN SECRET"); } }), { ok: false, reason: "it did not start" });
  const late = (file, args, options, callback) => { setImmediate(() => callback(Object.assign(new Error(`Command failed: ${args.join(" ")}\n${STDERR}`), { killed: true, signal: "SIGTERM", code: null }), JSON.stringify(record()), STDERR)); };
  assert.deepEqual(await probeKernel({ bin: silent.bin, env: CLEAN_ENV, execFile: late }), { ok: false, reason: "it did not answer within 10 seconds" }, "the default limit, and a valid record does not undo a timeout");

  for (const [reason, world] of reasons) {
    assert.equal(typeof reason, "string");
    assert.equal(reason.includes("\n") || reason.includes("SECRET") || reason.includes("second line") || reason.includes(world.dir) || reason.includes("Command failed"), false, reason);
  }
});

// ── startExec: the exec of the read of this computer's deployments list at a start ──

test("startExec runs `node <bin> <argv…>` with the options it is given, not detached, and answers its callback as execFile does", async () => {
  const dir = mkdtempSync(path.join(ROOT, "start-exec-")), bin = path.join(dir, "echo.mjs");
  // What the child was given, and the group it runs in where /proc names it.
  writeFileSync(bin, [
    'import { readFileSync } from "node:fs";',
    'const stat = (() => { try { return readFileSync("/proc/self/stat", "utf8"); } catch { return null; } })();',
    'const pgid = stat === null ? null : Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);',
    'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), marker: process.env.OATS_TUI_START_EXEC ?? null, pgid }));',
  ].join("\n"));
  const env = { ...CLEAN_ENV, OATS_TUI_START_EXEC: "given" };
  const argv = ["deployments", "--json", "a value with spaces"];
  const answer = await new Promise((resolve) => {
    const child = startExec(bin, argv, { cwd: dir, env, encoding: "utf8", shell: false, timeout: 10_000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    assert.equal(child instanceof ChildProcess, true, "the child execFile returns");
  });
  assert.deepEqual([answer.error, answer.stderr], [null, ""]);
  const seen = JSON.parse(answer.stdout);
  assert.deepEqual([seen.argv, seen.cwd, seen.marker], [argv, dir, "given"], "the argv as it was given, after the bin; the cwd and the environment of the options");
  if (OWN_GROUP !== null && seen.pgid !== null) assert.equal(seen.pgid, OWN_GROUP, "in the TUI's own process group: a Ctrl+C before the terminal is taken ends it too");

  // A child that fails is answered as execFile answers it.
  writeFileSync(bin, 'process.stdout.write("partial"); process.exit(3);');
  const failed = await new Promise((resolve) => startExec(bin, [], { encoding: "utf8" }, (error, stdout) => resolve({ error, stdout })));
  assert.deepEqual([failed.error?.code, failed.stdout], [3, "partial"]);
});

// ── a cycle ───────────────────────────────────────────────────────────────────

test("a cycle: the kernel's roster goes to the collector as the shared livenessInput, and the entry's rows carry the collector's answers", async (t) => {
  const world = makeWorld();
  const rows = [kernelRow("dev-one"), kernelRow("dev-two")];
  world.plan(answering(world, rows, [{ running: false, runtimeState: "stopped", tmux: null }, { running: true, runtimeState: "running", tmux: { session: "oats", window: "dev-two", socket: null } }]));
  const { reader, entries, spawned, store } = reading(t, world);

  assert.deepEqual(reader.children(), []);
  await reader.request();
  assert.equal(entries.length, 1, "exactly one entry for the cycle");
  const [{ id, entry, number, read }] = entries;
  assert.deepEqual(Object.keys(entries[0]).sort(), ["entry", "id", "number", "read"]);
  assert.equal(read, true, "an entry made from the kernel's answer is marked read (#1247); a failed read's is not (below)");
  assert.equal(id, world.deployment);
  assert.equal(number, 1);
  assert.equal(entry.deployment.status, "observed");
  assert.deepEqual([entry.deployment.root, entry.deployment.workspace.name, entry.generatedAt, typeof entry.observedAt], [path.join(world.deployment, "agents"), "fake-workspace", at(1), "string"]);
  assert.deepEqual(entry.deployment.souls.map((soul) => soul.name), ["dev"]);
  // The kernel said both run; the collector said dev-one stopped. Running first, then by name: the shared order.
  assert.deepEqual(shown(entry), [["dev-two", true, "running"], ["dev-one", false, "stopped"]]);
  assert.deepEqual(entry.instances.map((row) => [row.agent, row.home]), [["dev", path.join(world.deployment, "agents", "dev", "instances", "dev-two")], ["dev", path.join(world.deployment, "agents", "dev", "instances", "dev-one")]]);
  assert.deepEqual(reader.children(), [], "every child is forgotten when it ends");

  // The collector read exactly what the shared function makes of the rows, and nothing built by hand.
  const collected = world.calls("collector", "start");
  assert.equal(collected.length, 1);
  assert.equal(collected[0].stdin, JSON.stringify(livenessInput(rows)));
  assert.deepEqual(JSON.parse(collected[0].stdin).map((row) => [row.instance, row.running]), [["dev-one", true], ["dev-two", true]]);

  // One exec for every kernel call: node, the record's bin, the shared reader's argv and options, and detached.
  assert.equal(spawned.length, 3);
  assert.equal(spawned.every((call) => call.file === process.execPath && call.options.detached === true && call.options.shell === false), true);
  assert.equal(spawned.every((call) => EIGHT.every((name) => !(name in call.options.env))), true);
  const kernel = spawned.filter((call) => call.args[0] === world.bin);
  assert.deepEqual(kernel.map((call) => call.args.slice(1)).sort(), [["status", "--dir", world.deployment, "--max-age", "60", "--json"], ["workspace", "status", "--dir", world.deployment, "--max-age", "60", "--json"]]);
  for (const call of kernel) assert.deepEqual({ ...call.options, env: null }, { cwd: world.deployment, env: null, shell: false, detached: true }, "what the shared reader asked for, and detached");
  assert.deepEqual(world.calls("status", "start").map((call) => [call.argv, call.cwd]), [[["status", "--dir", world.deployment, "--max-age", "60", "--json"], world.deployment]]);
  const [collector] = spawned.filter((call) => call.args[0] === world.collector);
  assert.deepEqual(collector.args, [world.collector]);
  assert.deepEqual({ ...collector.options, env: null }, { env: null, shell: false, detached: true });
  assert.equal(collector.options.env, CLEAN_ENV);

  // The next cycle is the next number; a live one asks the kernel for nothing reused.
  await reader.request({ live: true });
  assert.deepEqual(entries.map((emitted) => emitted.number), [1, 2]);
  assert.equal(entries[1].entry.generatedAt, at(2));
  assert.deepEqual(spawned.slice(3).filter((call) => call.args[0] === world.bin).map((call) => call.args.slice(-3)), [["--max-age", "0", "--json"], ["--max-age", "0", "--json"]]);
  assert.equal(store.entry, entries[1].entry);
  assert.equal(COLLECTOR.endsWith(path.join("client", "liveness-main.mjs")), true, "the default collector is the shared program");
});

test("a deployment with no instance is observed without starting the collector", async (t) => {
  const world = makeWorld();
  world.plan(answering(world, [], "never read"));
  const { reader, entries, spawned } = reading(t, world);
  await reader.request();
  assert.deepEqual([entries.length, entries[0].entry.deployment.status, entries[0].entry.instances.length], [1, "observed", 0]);
  assert.deepEqual([spawned.length, world.calls("collector").length], [2, 0]);
});

test("a collector that fails, prints garbage, answers for another number of rows or does not exist: every row is unknown, and the entry is still observed", async (t) => {
  const rows = [kernelRow("dev-one"), kernelRow("dev-two", { running: false, runtimeState: "stopped" })];
  const good = JSON.stringify([{ running: true, runtimeState: "running" }, { running: true, runtimeState: "running" }]);
  const cases = [
    ["exits 1 after a valid answer", { stdout: good, exit: 1 }],
    ["prints garbage", { stdout: "Segmentation fault" }],
    ["prints nothing", { stdout: "" }],
    ["answers for one row of two", { stdout: JSON.stringify([{ running: true, runtimeState: "running" }]) }],
    ["does not exist", null],
  ];
  for (const [name, collector] of cases) {
    const world = makeWorld();
    world.plan({ ...answering(world, rows), ...(collector ? { collector } : {}) });
    const { reader, entries } = reading(t, world, collector ? {} : { collector: path.join(world.dir, "no-such-collector.mjs") });
    await reader.request();
    assert.equal(entries.length, 1, name);
    assert.equal(entries[0].entry.deployment.status, "observed", name);
    assert.deepEqual(shown(entries[0].entry).sort(), [["dev-one", null, "unreachable"], ["dev-two", null, "unreachable"]], name);
    assert.equal(entries[0].entry.instances.every((row) => row.runtimeError === "Terminal status is unavailable"), true, `${name}: the shared rule's own words`);
    assert.deepEqual(reader.children(), [], name);
  }
});

test("a collector that dies without reading a large input: the EPIPE of the write is heard, and every row is unknown", async (t) => {
  const world = makeWorld();
  const rows = Array.from({ length: 80 }, (_, n) => kernelRow(`dev-${String(n).padStart(2, "0")}`, { running: null, runtimeState: "unreachable", runtimeError: "e".repeat(8000), tmux: null }));
  assert.equal(JSON.stringify(livenessInput(rows)).length > 512 * 1024, true, "more than a pipe holds");
  world.plan(answering(world, rows));
  const { reader, entries } = reading(t, world, { collector: path.join(world.dir, "no-such-collector.mjs") });
  await reader.request();
  await sleep(150); // an error nobody hears would arrive by now, as an uncaught exception
  assert.deepEqual([entries.length, entries[0].entry.deployment.status, entries[0].entry.instances.length], [1, "observed", 80]);
  assert.equal(entries[0].entry.instances.every((row) => row.running === null && row.runtimeState === "unreachable"), true);
});

test("a row the kernel answered running: null reaches the collector with running: null", async (t) => {
  const world = makeWorld();
  const rows = [kernelRow("dev-one"), kernelRow("dev-lost", { running: null, runtimeState: "unreachable", runtimeError: "the terminal server could not be read", tmux: null })];
  world.plan(answering(world, rows, [{ running: true, runtimeState: "running" }, { running: null, runtimeState: "unreachable", runtimeError: "the terminal server could not be read" }]));
  const { reader, entries } = reading(t, world);
  await reader.request();
  const [call] = world.calls("collector", "start");
  assert.equal(call.stdin, JSON.stringify(livenessInput(rows)));
  assert.deepEqual(JSON.parse(call.stdin)[1], { instance: "dev-lost", running: null, tmux: null, runtimeState: "unreachable", runtimeError: "the terminal server could not be read" });
  assert.deepEqual(shown(entries[0].entry), [["dev-one", true, "running"], ["dev-lost", null, "unreachable"]]);
});

test("the kernel's error envelope becomes the shared failedEntry over the entry the caller holds, and the collector is not started", async (t) => {
  const world = makeWorld();
  const good = answering(world, [kernelRow("dev-one")], [{ running: true, runtimeState: "running" }]);
  world.plan(good);
  const { reader, entries, spawned, store } = reading(t, world);
  assert.equal(reader.begun(), 0, "no cycle begun yet");
  await reader.request();
  const observed = entries[0].entry;
  assert.equal(observed.deployment.status, "observed");
  // A read that answered says so, and the cycle it began under is the last begun: lib/main.mjs lets a
  // retire it holds go for such a read only (#1247). Each failure below carries no such mark (deepEqual).
  assert.deepEqual([entries[0].read, entries[0].number, reader.begun()], [true, 1, 1]);
  const collectors = () => [spawned.filter((call) => call.args[0] === world.collector).length, world.calls("collector", "start").length];
  assert.deepEqual(collectors(), [1, 1]);

  // A remote the kernel could not read, over an observed entry: the rows stay, marked with the failure.
  world.plan({ ...good, status: kernelError("E_REMOTE_UNREADABLE", "could not read the workspace remote", { reason: "network", url: "https://git.example.com/team/agents.git", path: "/private/cache" }) });
  await reader.request({ live: true });
  const unreadable = { code: "E_REMOTE_UNREADABLE", message: "could not read the workspace remote", origin: "kernel", cause: { reason: "network", host: "git.example.com" } };
  assert.deepEqual(entries[1], { id: world.deployment, entry: failedEntry(observed, unreadable, at(2)), number: 2 });
  assert.deepEqual([entries[1].entry.deployment.status, entries[1].entry.error, entries[1].entry.errorCause], ["observed", unreadable.message, { code: unreadable.code, ...unreadable.cause }]);
  assert.deepEqual(entries[1].entry.instances, observed.instances);
  assert.deepEqual(collectors(), [1, 1], "no collector for a read that failed");

  // Another refusal: unavailable, with the kernel's reason and this cycle's time; never an empty roster.
  world.plan({ ...good, status: kernelError("E_LOCK_HELD", "another oats command holds the lock") });
  const held = store.entry;
  await reader.request();
  const refused = { code: "E_LOCK_HELD", message: "another oats command holds the lock", origin: "kernel" };
  assert.deepEqual(entries[2], { id: world.deployment, entry: failedEntry(held, refused, at(3)), number: 3 });
  assert.deepEqual(entries[2].entry, { deployment: { status: "unavailable", reason: refused }, instances: [], generatedAt: at(3) });
  assert.equal(reader.begun(), 3, "every cycle counts as begun, whatever it read");

  // With no observation to keep, an unreadable remote is unavailable too. And a kernel that prints no envelope.
  world.plan({ ...good, workspace: kernelError("E_REMOTE_UNREADABLE", "could not read the workspace remote") });
  await reader.request();
  assert.deepEqual(entries[3].entry.deployment, { status: "unavailable", reason: { code: "E_REMOTE_UNREADABLE", message: "could not read the workspace remote", origin: "kernel" } });
  world.plan({ ...good, status: { stdout: "Error: something broke", stderr: STDERR, exit: 1 } });
  await reader.request();
  assert.deepEqual([entries[4].entry.deployment.status, entries[4].entry.deployment.reason.code], ["unavailable", "E_CLI_FAILED"]);
  assert.equal(JSON.stringify(entries[4].entry).includes("SECRET"), false);
  assert.deepEqual(collectors(), [1, 1]);

  world.plan(good);
  await reader.request();
  assert.deepEqual([entries[5].entry.deployment.status, shown(entries[5].entry)], ["observed", [["dev-one", true, "running"]]]);
  assert.deepEqual(entries.map((emitted) => emitted.number), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(collectors(), [2, 2]);
});

test("a lost session in the kernel's status answer reaches the resume trigger through the real readers: the row keeps sessionEnd, and what lib/main.mjs observes of it after the store took it starts a sweep (#1559)", async (t) => {
  const world = makeWorld();
  const rows = [kernelRow("dev-running", { sessionEnd: "lost" }), kernelRow("dev-lost", { running: false, runtimeState: "stopped", tmux: null, sessionEnd: "lost" }), kernelRow("dev-stopped", { running: false, runtimeState: "stopped", tmux: null, sessionEnd: "stopped" })];
  world.plan(answering(world, rows, [{ running: true, runtimeState: "running", tmux: { session: "oats", window: "dev-running", socket: null } }, { running: false, runtimeState: "stopped", tmux: null }, { running: false, runtimeState: "stopped", tmux: null }]));
  const { reader, entries } = reading(t, world);
  await reader.request();
  const [event] = entries, { entry, read } = event;
  assert.equal(read, true);
  // The status reader and the panel's projection both keep the kernel's sessionEnd.
  assert.deepEqual(entry.instances.map((row) => [row.instance, row.running, row.sessionEnd]), [["dev-running", true, "lost"], ["dev-lost", false, "lost"], ["dev-stopped", false, "stopped"]]);
  // What lib/main.mjs hands the shared trigger once the store took that read (resumeObservation: the view's rows,
  // tagged with their deployment, and its local deployment ids), with a fake run: the launch sweep, then, once the
  // floor has passed, a sweep for the lost home that is not running.
  const state = reduce(initialState({ deployment: world.deployment, cli: world.cli, home: "/home/u" }), event).state;
  const observation = resumeObservation(state, world.deployment, at(2));
  assert.deepEqual(observation.localDeploymentIds, [world.deployment]);
  assert.deepEqual(observation.rows.map((row) => [row.instance, row.deployment?.id, row.sessionEnd]), [["dev-running", world.deployment, "lost"], ["dev-lost", world.deployment, "lost"], ["dev-stopped", world.deployment, "stopped"]]);
  const cli = { ...world.cli, features: [...world.cli.features, "session-resume"] }, runs = [], readings = [];
  let now = 0;
  const trigger = createResumeTrigger({ cli: () => cli, now: () => now, onReading: (reading) => readings.push(reading.kind),
    run: (asked) => { runs.push(asked); return Promise.resolve({ schemaVersion: 1, ok: true, result: { schemaVersion: 1, plan: false, deployments: [], rows: [] } }); } });
  await trigger.launch();
  now += 30_000;
  await trigger.observed(observation.rows, { localDeploymentIds: observation.localDeploymentIds });
  assert.deepEqual([runs.length, runs.every((asked) => asked === cli), readings], [2, true, ["answered", "answered"]], "the launch sweep, then the one the lost row started");
});

test("the cycle numbers grow strictly, a failed cycle and a void one included", async (t) => {
  const world = makeWorld();
  const good = answering(world);
  world.plan(good);
  const { reader, entries, begun } = reading(t, world);
  await reader.request();
  world.plan({ ...good, status: kernelError("E_LOCK_HELD", "held") });
  await reader.request();
  world.plan(good);
  const third = reader.request();
  for (let i = 0; i < 20 && begun() < 3; i++) await Promise.resolve();
  reader.voidInFlight();
  await third;
  await reader.request({ live: true });
  assert.deepEqual(entries.map((emitted) => [emitted.number, emitted.entry.deployment.status]), [[1, "observed"], [2, "unavailable"], [4, "observed"]]);
  for (let i = 1; i < entries.length; i++) assert.equal(entries[i].number > entries[i - 1].number, true);
});

// ── the exec's own limits: what the shared reader is told of a child that did not answer ──

test("a kernel that prints more than the shared reader's size limit is ended there and then, and the read is the shared E_CLI_OUTPUT_LIMIT", async (t) => {
  // It prints too much and then does not exit: only a reader that counts as it reads ends this read.
  const world = makeWorld();
  world.plan({ ...answering(world), status: { stdout: "x".repeat(4 * 1024 * 1024 + 65_536), linger: true } });
  const { reader, entries } = reading(t, world);
  assert.equal(await settled(reader.request(), 20_000), true, "long before the time limit");
  assert.deepEqual([entries.length, entries[0].entry.deployment.status, entries[0].entry.deployment.reason.code], [1, "unavailable", "E_CLI_OUTPUT_LIMIT"]);
  assert.deepEqual(reader.children(), []);
  await gone(world.calls("status", "start").map((call) => call.pid));
});

test("a kernel that does not answer within the shared reader's time limit is ended with its process group, and the read is the shared E_CLI_TIMEOUT", async (t) => {
  const world = makeWorld();
  world.plan({ ...answering(world, [kernelRow("dev-one")]), status: { sleep: true, grandchild: true }, workspace: { sleep: true } });
  const timers = fakeTimers();
  const { reader, entries } = reading(t, world, { timers });
  const first = reader.request();
  const pids = await waitFor("the kernels and the grandchild to start", () => {
    const started = [world.calls("status", "start")[0], world.calls("workspace", "start")[0], world.calls("sleeper", "start")[0]];
    return started.every(Boolean) && started.map((call) => call.pid);
  });
  assert.deepEqual(timers.delays(), [30_000, 30_000], "one limit per read: the shared reader's 30 s");
  timers.fire((ms) => ms === 30_000, 2);
  assert.deepEqual(reader.children(), [], "answered for at once, without waiting for the child");
  await first;
  assert.deepEqual([entries.length, entries[0].entry.deployment.status, entries[0].entry.deployment.reason.code], [1, "unavailable", "E_CLI_TIMEOUT"]);
  assert.equal(world.calls("collector").length, 0);
  assert.deepEqual(timers.delays(), []);
  await gone(pids);
});

test("a time limit that is overdue when a stopped process continues: the read is answered a turn later, so voidInFlight() in that turn comes first", async (t) => {
  const world = makeWorld();
  const good = answering(world);
  world.plan({ ...good, status: { sleep: true }, workspace: { sleep: true } });
  const timers = fakeTimers();
  const { reader, entries } = reading(t, world, { timers });
  const first = reader.request();
  const pids = await waitFor("the kernels to start", () => {
    const started = [world.calls("status", "start")[0], world.calls("workspace", "start")[0]];
    return started.every(Boolean) && started.map((call) => call.pid);
  });
  // What a process stopped past the limit does when it continues: its overdue timers, then every
  // promise they settled, and only then the handler of the signal that continued it.
  timers.fire((ms) => ms === 30_000, 2);
  for (let i = 0; i < 200; i++) await Promise.resolve();
  assert.deepEqual(entries, [], "the timeout is not an entry yet");
  reader.voidInFlight();
  await first;
  assert.deepEqual(entries, [], "and it never is: no 'unavailable' after a long stop");
  await gone(pids);
  world.plan(good);
  await reader.request({ live: true });
  assert.deepEqual(entries.map((emitted) => [emitted.number, emitted.entry.deployment.status]), [[2, "observed"]]);
});

test("a collector that does not answer within 30 s is ended, and every row is unknown", async (t) => {
  const world = makeWorld();
  world.plan({ ...answering(world, [kernelRow("dev-one")]), collector: { sleep: true } });
  const timers = fakeTimers();
  const { reader, entries } = reading(t, world, { timers });
  const first = reader.request();
  const pid = await waitFor("the collector to start", () => world.calls("collector", "start")[0]?.pid);
  assert.deepEqual(timers.delays(), [30_000]);
  timers.fire((ms) => ms === 30_000);
  await first;
  assert.deepEqual([entries.length, entries[0].entry.deployment.status, shown(entries[0].entry)], [1, "observed", [["dev-one", null, "unreachable"]]]);
  assert.deepEqual(reader.children(), []);
  await gone([pid]);
});

test("a kernel or a collector that cannot be started: a failed read, or rows that are unknown; never an exception", async (t) => {
  const world = makeWorld();
  world.plan(answering(world, [kernelRow("dev-one")], [{ running: true, runtimeState: "running" }]));
  const nowhere = path.join(ROOT, "no-such-node");
  const cases = [
    ["no kernel", (file, args, options) => nodeSpawn(nowhere, args, options), ["unavailable", "E_CLI_FAILED"]],
    ["spawn throws", () => { throw new Error("spawn EMFILE"); }, ["unavailable", "E_CLI_FAILED"]],
    ["no collector", (file, args, options) => nodeSpawn(args[0] === world.collector ? nowhere : file, args, options), ["observed", undefined]],
    ["spawn throws for the collector", (file, args, options) => { if (args[0] === world.collector) throw new Error("spawn EMFILE"); return nodeSpawn(file, args, options); }, ["observed", undefined]],
  ];
  for (const [name, spawn, expected] of cases) {
    const { reader, entries } = reading(t, world, { spawn });
    await reader.request();
    assert.deepEqual([entries.length, entries[0].entry.deployment.status, entries[0].entry.deployment.reason?.code], [1, ...expected], name);
    if (expected[0] === "observed") assert.deepEqual(shown(entries[0].entry), [["dev-one", null, "unreachable"]], name);
    assert.deepEqual(reader.children(), [], name);
  }
  assert.equal(world.calls("collector").length, 0);
});

// ── the children: their environment, their session, the way out ───────────────

test("after leaveInstance(env) neither the kernel nor the collector sees an instance variable", async (t) => {
  const world = makeWorld();
  world.plan(answering(world, [kernelRow("dev-one")], [{ running: true, runtimeState: "running" }]));
  const env = { ...CLEAN_ENV, OATS_UNRELATED: "kept", ...Object.fromEntries(EIGHT.map((name) => [name, `/an/instance/${name}`])) };
  const { reader, entries } = reading(t, world, { env });
  const carried = (action) => world.calls(action, "start").map((call) => EIGHT.filter((name) => name in call.env));

  // Before: the shared reader cleans a copy for the kernel, but the collector gets the environment as the TUI has it.
  await reader.request();
  assert.deepEqual([carried("status"), carried("workspace")], [[[]], [[]]]);
  assert.deepEqual(carried("collector"), [EIGHT], "which is why the copy is not enough");

  leaveInstance(env);
  await reader.request();
  assert.equal(entries.length, 2);
  for (const action of ["status", "workspace", "collector"]) {
    assert.deepEqual(carried(action).at(-1), [], action);
    assert.equal(world.calls(action, "start").at(-1).env.OATS_UNRELATED, "kept", `${action}: nothing else was taken`);
  }
});

test("every child runs in a session of its own: it leads its process group, which is not the TUI's", async (t) => {
  const world = makeWorld();
  world.plan(answering(world, [kernelRow("dev-one")], [{ running: true, runtimeState: "running" }]));
  const { reader } = reading(t, world);
  await reader.request();
  const started = ["status", "workspace", "collector"].map((action) => world.calls(action, "start")[0]);
  for (const call of started) {
    assert.equal(call.pgid, call.pid, `${call.action} leads its own process group`);
    if (call.sid !== null) assert.equal(call.sid, call.pid, `${call.action} leads its own session`);
    if (OWN_GROUP !== null) assert.notEqual(call.pgid, OWN_GROUP, `${call.action} is not in this process's group`);
    assert.notEqual(call.pid, process.pid);
  }
  assert.equal(new Set(started.map((call) => call.pgid)).size, 3);
});

/** stop() while `sleeper` (an action of the plan) sleeps: at once, everything gone, nothing emitted, nothing started after. */
async function leaves(t, world, sleeper, { grandchild = false } = {}) {
  const { reader, entries, spawned } = reading(t, world);
  const first = reader.start();
  const pid = await waitFor(`the ${sleeper} fake to start`, () => world.calls(sleeper, "start")[0]?.pid);
  const pids = [pid];
  if (grandchild) {
    const inner = await waitFor("the grandchild to start", () => world.calls("sleeper", "start")[0]);
    assert.equal(inner.pgid, pid, "the grandchild is in the kernel's process group");
    pids.push(inner.pid);
  }
  assert.equal(reader.children().includes(pid), true);
  assert.equal(pids.every(alive), true);

  const before = performance.now();
  assert.equal(reader.stop(), undefined, "synchronous: nothing to wait for");
  const took = performance.now() - before;
  assert.deepEqual(reader.children(), []);
  assert.equal(took < 5000, true, `stop() returned at once (${took} ms)`);
  await gone(pids);
  assert.equal(await settled(first), true, "the cycle in flight ends");
  await sleep(150);
  assert.deepEqual(entries, [], "no entry arrives after stop()");

  const count = spawned.length, logged = world.calls().length;
  await reader.request({ live: true });
  await reader.start();
  reader.touch();
  await sleep(150);
  assert.deepEqual([spawned.length, world.calls().length, entries.length], [count, logged, 0], "a later request starts no process");
  assert.doesNotThrow(() => { reader.stop(); reader.voidInFlight(); reader.stop(); });
}

test("leaving while the kernel sleeps: stop() returns at once, the kernel is gone within two seconds, and nothing is emitted or started afterwards", async (t) => {
  const world = makeWorld();
  world.plan({ ...answering(world, [kernelRow("dev-one")]), status: { sleep: true } });
  await leaves(t, world, "status");
});

test("leaving while the kernel and a grandchild of it sleep: the whole process group is ended", async (t) => {
  const world = makeWorld();
  world.plan({ ...answering(world, [kernelRow("dev-one")]), workspace: { sleep: true, grandchild: true } });
  await leaves(t, world, "workspace", { grandchild: true });
});

test("leaving while the collector sleeps: the same", async (t) => {
  const world = makeWorld();
  world.plan({ ...answering(world, [kernelRow("dev-one")]), collector: { sleep: true } });
  await leaves(t, world, "collector");
  assert.equal(world.calls("collector", "start")[0].stdin.includes("dev-one"), true);
});

test("a child seen to exit is never signalled again, by pid or by group: its pipes are destroyed and it is forgotten", async (t) => {
  // The kernel answers and exits; a grandchild it left behind holds its pipes, so the read has not ended.
  const world = makeWorld();
  world.plan({ ...answering(world, [kernelRow("dev-one")]), status: { stdout: JSON.stringify(statusDocument(world.deployment, [kernelRow("dev-one")])), grandchild: true } });
  const { reader, entries } = reading(t, world);
  const first = reader.request();
  const kernel = await waitFor("the kernel to start", () => world.calls("status", "start")[0]?.pid);
  const inner = await waitFor("the grandchild to start", () => world.calls("sleeper", "start")[0]);
  assert.equal(inner.pgid, kernel, "the grandchild is in the group the kernel led");
  // Reaped: node has seen the kernel exit. Its pid may name any process from now on.
  await waitFor("the kernel to exit and be reaped", () => !exists(kernel));
  await waitFor("the other read to end", () => reader.children().length === 1);
  assert.deepEqual(reader.children(), [kernel], "still remembered: the grandchild holds its pipes open");
  assert.equal(await settled(first, 300), false, "and the read is still waiting for them");

  reader.stop();
  assert.deepEqual(reader.children(), []);
  assert.equal(await settled(first), true, "the pipes were destroyed: nothing waits for the grandchild");
  await sleep(300);
  assert.equal(alive(inner.pid), true, "nothing was sent to the group of a pid that had exited");
  assert.deepEqual(entries, []);
  assert.equal(ours(inner.pid), true);
  process.kill(inner.pid, "SIGKILL"); // the fake wrote this pid down, and it is still that fake
  await gone([inner.pid], 5000);
});

test("a kernel that ignores SIGTERM keeps neither its cycle nor the reader: it is answered for at once, and the next request reads", async (t) => {
  const world = makeWorld();
  const good = answering(world);
  world.plan({ ...good, status: { sleep: true, stubborn: true } });
  const { reader, entries } = reading(t, world);
  const first = reader.request();
  const pid = await waitFor("the kernel to start", () => world.calls("status", "start")[0]?.pid);
  reader.voidInFlight();
  assert.deepEqual(reader.children(), []);
  assert.equal(await settled(first, 5000), true, "the cycle is over without the child");
  world.plan(good);
  await reader.request({ live: true });
  assert.deepEqual(entries.map((emitted) => [emitted.number, emitted.entry.deployment.status]), [[2, "observed"]]);
  assert.equal(alive(pid), true, "it was asked to end, once, and nobody waited for it");
  assert.equal(ours(pid), true);
  process.kill(pid, "SIGKILL"); // the fake wrote this pid down, and it is still that fake
  await gone([pid], 5000);
});

test("a whole process that stops its reader ends by itself: it waits for no pipe a grandchild holds, and for no child that ignores the signal", async () => {
  const cases = [
    ["a kernel that exited and left a grandchild holding its pipes", (world) => ({ status: { stdout: JSON.stringify(statusDocument(world.deployment)), grandchild: true } }), "sleeper", (world) => world.cli],
    ["a kernel that ignores SIGTERM", () => ({ status: { sleep: true, stubborn: true } }), "status", (world) => world.cli],
    ["a kernel reading the roster of other machines that ignores SIGTERM", () => ({ server: { sleep: true, stubborn: true } }), "server", (world) => world.remoteCli],
  ];
  for (const [name, steps, wait, cli] of cases) {
    const world = makeWorld();
    world.plan({ ...answering(world), ...steps(world) });
    // The process is given 60 s; it needs none of them when nothing holds it.
    const ran = await new Promise((resolve) => { nodeExecFile(process.execPath, [LEAVE, world.dir, JSON.stringify(cli(world)), wait], { env: CLEAN_ENV, timeout: 60_000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr })); });
    assert.equal(ran.error, null, `${name}: the process ended by itself, with status 0 (${ran.stderr})`);
    assert.equal(ran.stdout, "stopped\n", name);
    const left = world.calls(wait, "start")[0].pid;
    assert.equal(alive(left), true, `${name}: it still runs, so the process did not wait for it`);
    assert.equal(ours(left), true);
    process.kill(left, "SIGKILL"); // the fake wrote this pid down, and it is still that fake
    await gone([left], 5000);
  }
});

test("stop() before start(), stop() twice and voidInFlight() at any time do not throw; after stop() nothing is armed", async (t) => {
  const world = makeWorld();
  world.plan(answering(world));
  const timers = fakeTimers();
  const { reader, entries, spawned } = reading(t, world, { timers });
  assert.doesNotThrow(() => { reader.voidInFlight(); reader.voidInFlight(); reader.touch(); });
  assert.deepEqual(timers.delays(), [], "touch() before start() arms nothing");
  assert.doesNotThrow(() => { reader.stop(); reader.stop(); reader.voidInFlight(); });
  await reader.start();
  reader.touch();
  await reader.request({ live: true });
  assert.deepEqual([timers.delays(), spawned.length, entries.length, reader.children()], [[], 0, 0, []]);

  const again = reading(t, world, { timers });
  await again.reader.start();
  await again.reader.start();
  assert.deepEqual([again.entries.length, timers.delays()], [1, [5000, 600_000]], "start() twice is one loop, one idle timer");
  again.reader.stop();
  again.reader.stop();
  assert.deepEqual(timers.delays(), []);
});

// ── cadence ───────────────────────────────────────────────────────────────────

test("cadence: touch() re-arms the idle timer; when it fires the loop reads as a blurred window does; the next touch() focuses it again", async (t) => {
  const world = makeWorld();
  world.plan(answering(world));
  const timers = fakeTimers();
  const { reader, entries } = reading(t, world, { timers, idleMs: 777, focusedMs: 5000, blurredMs: 30_000 });

  await reader.start();
  assert.equal(entries.length, 1);
  assert.deepEqual(timers.delays(), [777, 5000], "the idle timer, and the loop's next read at the focused cadence");
  const idle = timers.idOf(777);
  reader.touch();
  assert.deepEqual(timers.delays(), [777, 5000], "one idle timer, not two; no read out of turn");
  assert.notEqual(timers.idOf(777), idle, "and it is a new one: the old was cleared");
  assert.equal(entries.length, 1);

  // Nobody for idleMs: the read that was due in 5 s moves out to the blurred cadence.
  timers.fire((ms) => ms === 777);
  assert.equal(timers.delays().length, 1, "no idle timer until the next key");
  assert.equal(timers.delays()[0] > 5000 && timers.delays()[0] <= 30_000, true, `${timers.delays()[0]} ms: 30 s after the last read, not 5`);
  timers.fire((ms) => ms > 5000);
  await waitFor("the blurred cycle to end", () => entries.length === 2 && timers.delays().length === 1);
  assert.deepEqual(timers.delays(), [30_000], "and the next one is 30 s away");

  // A key: one read at once, the focused cadence after it, the idle timer armed again.
  reader.touch();
  assert.deepEqual(timers.delays(), [777]);
  await waitFor("the cycle a key asks for to end", () => entries.length === 3 && timers.delays().length === 2);
  assert.deepEqual(timers.delays(), [777, 5000]);
  assert.deepEqual(entries.map((emitted) => emitted.number), [1, 2, 3]);

  reader.stop();
  assert.deepEqual(timers.delays(), [], "leaving clears both");
});

// ── voidInFlight ──────────────────────────────────────────────────────────────

test("voidInFlight() while the kernel runs: the kernel is ended, that cycle emits nothing, and the next request emits with the next number", async (t) => {
  const world = makeWorld();
  const good = answering(world, [kernelRow("dev-one")], [{ running: true, runtimeState: "running" }]);
  world.plan({ ...good, status: { sleep: true } });
  const timers = fakeTimers();
  const { reader, entries } = reading(t, world, { timers });
  const first = reader.start();
  const pid = await waitFor("the kernel to start", () => world.calls("status", "start")[0]?.pid);
  assert.equal(reader.children().includes(pid), true);

  assert.equal(reader.voidInFlight(), undefined);
  assert.deepEqual(reader.children(), []);
  assert.doesNotThrow(() => reader.voidInFlight(), "idempotent");
  await gone([pid]);
  assert.equal(await settled(first), true);
  assert.deepEqual(entries, [], "its failure is not an entry");
  assert.equal(world.calls("collector").length, 0);

  world.plan(good);
  await reader.request({ live: true });
  assert.deepEqual(entries.map((emitted) => [emitted.number, emitted.entry.deployment.status, shown(emitted.entry)]), [[2, "observed", [["dev-one", true, "running"]]]]);
  assert.deepEqual(timers.delays(), [5000, 600_000], "the reader stays usable: the loop goes on");
});

test("voidInFlight() with an answer larger than the pipe waiting in it: no entry for that cycle, unavailable or other, and the live request after it is observed", async (t) => {
  // What a stopped TUI leaves behind, without stopping anything: a kernel that has more to say than
  // the pipe holds, and a reader that has not read. Whatever such a cycle would answer is no evidence.
  const world = makeWorld();
  const souls = Array.from({ length: 160 }, (_, n) => ({ name: `soul-${n}`, description: `${n} `.padEnd(8000, "x") }));
  const big = JSON.stringify(statusDocument(world.deployment, [], souls));
  assert.equal(big.length > 1024 * 1024 && big.length < 4 * 1024 * 1024, true, "larger than a pipe, within the shared reader's limit");
  world.plan({ ...answering(world), status: { stdout: big } });
  const { reader, entries, begun } = reading(t, world);

  const first = reader.request();
  for (let i = 0; i < 100 && reader.children().length < 2; i++) await Promise.resolve();
  assert.deepEqual([begun(), reader.children().length], [1, 2], "the cycle began and both reads run");
  // From here to voidInFlight() this process reads nothing: no await, as a stopped process has none.
  const until = Date.now() + 30_000;
  while (world.calls("status", "writing").length === 0 && Date.now() < until) freeze(20);
  freeze(400);
  const [status] = world.calls("status", "start"), [workspace] = world.calls("workspace", "start");
  assert.equal(world.calls("status", "writing").length, 1, "the kernel is answering");
  assert.equal(world.calls("status", "written").length, 0, "and its answer does not fit in the pipe nobody reads");
  assert.equal(alive(status.pid), true);

  reader.voidInFlight();
  assert.deepEqual(reader.children(), []);
  await gone([status.pid, workspace.pid]);
  assert.equal(await settled(first), true);
  await sleep(150);
  assert.deepEqual(entries, [], "no entry at all for the cycle that was in flight");

  await reader.request({ live: true });
  assert.equal(entries.length, 1);
  assert.deepEqual([entries[0].number, entries[0].entry.deployment.status, entries[0].entry.deployment.souls.length], [2, "observed", 161]);
  assert.equal(world.calls("status", "written").length, 1, "read whole this time");
});

test("voidInFlight() during the collector: that cycle is void too, and the collector is ended", async (t) => {
  const world = makeWorld();
  const good = answering(world, [kernelRow("dev-one")], [{ running: false, runtimeState: "stopped", tmux: null }]);
  world.plan({ ...good, collector: { sleep: true } });
  const { reader, entries } = reading(t, world);
  const first = reader.request();
  const pid = await waitFor("the collector to start", () => world.calls("collector", "start")[0]?.pid);
  assert.deepEqual(reader.children(), [pid]);

  reader.voidInFlight();
  assert.deepEqual(reader.children(), []);
  await gone([pid]);
  assert.equal(await settled(first), true);
  assert.deepEqual(entries, [], "not even with every row unknown");

  world.plan(good);
  await reader.request({ live: true });
  assert.deepEqual(entries.map((emitted) => [emitted.number, shown(emitted.entry)]), [[2, [["dev-one", false, "stopped"]]]]);
});

test("voidInFlight() before a cycle's reads began starts none of them; a cycle requested but not begun is not in flight", async (t) => {
  const world = makeWorld();
  world.plan(answering(world));
  const { reader, entries, spawned, begun } = reading(t, world);
  const first = reader.request();
  for (let i = 0; i < 20 && begun() < 1; i++) await Promise.resolve();
  assert.deepEqual([begun(), spawned.length], [1, 0], "the cycle began; its reads have not");
  reader.voidInFlight();
  await first;
  assert.deepEqual([spawned.length, entries.length, world.calls().length], [0, 0, 0]);

  const second = reader.request({ live: true });
  reader.voidInFlight(); // nothing is in flight yet: the cycle begins after this call returns
  await second;
  assert.deepEqual(entries.map((emitted) => [emitted.number, emitted.entry.deployment.status]), [[2, "observed"]]);
  assert.equal(spawned.length, 2);
});

// ── several served deployments ────────────────────────────────────────────────

test("several served deployments: each answers once per cycle, all under the cycle's one number and one time, each over the entry held for it", async (t) => {
  const world = makeWorld();
  const served = [world.deployment, world.another("deployment-b"), world.another("deployment-c")], [a, b, c] = served;
  const rows = { [a]: [kernelRow("dev-a")], [b]: [kernelRow("dev-b")], [c]: [kernelRow("dev-c")] };
  const good = { deployments: Object.fromEntries(served.map((dir) => [dir, serving(dir, rows[dir])])), collector: { stdout: JSON.stringify([{ running: true, runtimeState: "running" }]) } };
  world.plan(good);
  const { reader, entries, begun } = reading(t, world, { served });
  const of = (cycle, dir) => cycle.find((emitted) => emitted.id === dir).entry;

  await reader.request();
  assert.deepEqual(entries.map((emitted) => emitted.id).sort(), [...served].sort(), "one entry per deployment, and no second");
  assert.deepEqual(entries.map((emitted) => [emitted.number, emitted.entry.generatedAt, emitted.entry.deployment.status]), served.map(() => [1, at(1), "observed"]));
  assert.equal(begun(), 1, "one time for the whole cycle");
  for (const dir of served) {
    assert.deepEqual([of(entries, dir).deployment.root, shown(of(entries, dir))], [path.join(dir, "agents"), [[rows[dir][0].instance, true, "running"]]], "its own roster, and nobody else's");
    for (const action of ["status", "workspace"]) assert.deepEqual(world.calls(action, "start").filter((call) => askedAbout(call) === dir).map((call) => call.cwd), [dir], `${action}: read once, in its own directory`);
  }
  // One collector per deployment, each over that deployment's rows.
  assert.deepEqual(world.calls("collector", "start").map((call) => call.stdin).sort(), served.map((dir) => JSON.stringify(livenessInput(rows[dir]))).sort());
  assert.deepEqual(reader.children(), []);

  // One of them fails: its entry is the shared failedEntry over the entry held for THAT deployment, and the others are observed.
  world.plan({ ...good, deployments: { ...good.deployments, [b]: { ...good.deployments[b], status: kernelError("E_REMOTE_UNREADABLE", "could not read the workspace remote") } } });
  const first = entries.splice(0);
  await reader.request({ live: true });
  assert.deepEqual(entries.map((emitted) => emitted.id).sort(), [...served].sort());
  assert.deepEqual(entries.map((emitted) => emitted.number), [2, 2, 2]);
  assert.deepEqual(of(entries, b), failedEntry(of(first, b), { code: "E_REMOTE_UNREADABLE", message: "could not read the workspace remote", origin: "kernel" }, at(2)));
  assert.deepEqual(shown(of(entries, b)), [["dev-b", true, "running"]], "the rows kept are its own");
  assert.deepEqual([a, c].map((dir) => [of(entries, dir).deployment.status, of(entries, dir).generatedAt, shown(of(entries, dir))]), [["observed", at(2), [["dev-a", true, "running"]]], ["observed", at(2), [["dev-c", true, "running"]]]]);
});

test("several served deployments are read at most MAX_DEPLOYMENT_OBSERVATIONS at a time: a slow one holds one place, and the others go through the rest", async (t) => {
  const world = makeWorld();
  const served = [world.deployment, ...Array.from({ length: MAX_DEPLOYMENT_OBSERVATIONS + 2 }, (_, n) => world.another(`deployment-${n + 2}`))];
  const release = (dir) => path.join(dir, "answer-now");
  // Every kernel is slow: each `status` answers when the test says so.
  world.plan({ deployments: Object.fromEntries(served.map((dir) => { const steps = serving(dir); return [dir, { ...steps, status: { ...steps.status, until: release(dir) } }]; })) });
  const { reader, entries } = reading(t, world, { served });
  /** The deployments a kernel was started for, and those of them that have not answered. Sorted: two
   *  kernels started in one turn write their lines in the order the machine ran them. */
  const begun = () => [...new Set(world.calls("status", "start").map(askedAbout))].sort();
  const first = (count) => served.slice(0, count).sort();
  const inFlight = () => begun().filter((dir) => !entries.some((emitted) => emitted.id === dir));

  const cycle = reader.request();
  await waitFor("the first reads to start", () => begun().length >= MAX_DEPLOYMENT_OBSERVATIONS);
  await sleep(300);
  assert.deepEqual(begun(), first(MAX_DEPLOYMENT_OBSERVATIONS), "no more than that many, though every one of them is waiting");
  assert.equal(reader.children().length, MAX_DEPLOYMENT_OBSERVATIONS, "one kernel still running for each");
  assert.deepEqual(entries, []);

  // The first stays slow. Each of the others is let go in turn: the next starts only then.
  for (let n = 1; n < served.length; n++) {
    writeFileSync(release(served[n]), "");
    await waitFor(`deployment ${n + 1} to answer`, () => entries.length === n);
    const next = Math.min(served.length, n + 2);
    await waitFor("the next read to start", () => begun().length === next);
    await sleep(100);
    assert.deepEqual(begun(), first(next), "the next of the served order and no other, through the free place");
    assert.equal(inFlight().length <= MAX_DEPLOYMENT_OBSERVATIONS, true);
    assert.equal(inFlight().includes(served[0]), true, "the slow one is still being read");
  }
  assert.equal(await settled(cycle, 300), false, "the cycle is over when its last deployment is");
  writeFileSync(release(served[0]), "");
  await cycle;
  assert.deepEqual(entries.map((emitted) => emitted.id), [...served.slice(1), served[0]]);
  assert.deepEqual(entries.map((emitted) => [emitted.number, emitted.entry.deployment.status]), served.map(() => [1, "observed"]), "every one read, none refused as busy");
  assert.deepEqual(reader.children(), []);
});

test("a deployment that is not in getServed() is never read, and the list is read once, at the start of each cycle", async (t) => {
  const world = makeWorld();
  const a = world.deployment, b = world.another("deployment-b");
  world.plan({ deployments: { [a]: serving(a), [b]: serving(b) } });
  let served = [a], asked = 0;
  const { reader, entries, spawned } = reading(t, world, { served: () => { asked++; return served; } });
  const readOf = () => world.calls(undefined, "start").map(askedAbout);

  await reader.request();
  await reader.request({ live: true });
  assert.deepEqual([asked, entries.map((emitted) => emitted.id), readOf()], [2, [a, a], [a, a, a, a]]);

  served = [b];
  await reader.request();
  assert.deepEqual([asked, entries.map((emitted) => [emitted.id, emitted.number]), readOf().slice(4)], [3, [[a, 1], [a, 2], [b, 3]], [b, b]], "the one that left is read no more");
  assert.equal(entries[2].entry.deployment.root, path.join(b, "agents"));

  // No served deployment: the cycle runs, and reads nothing.
  served = [];
  const count = spawned.length;
  await reader.request({ live: true });
  assert.deepEqual([asked, entries.length, spawned.length, world.calls().length > 0], [4, 3, count, true]);
  assert.deepEqual(reader.children(), []);
});

// ── the roster of other machines ──────────────────────────────────────────────

// The kernel's own forms: a group's id is `<server>:<targetKey>` with a lower-case server name and no
// path in it, and a remote row says whether it is addressable. A group in another form is never remembered.
const WORKSPACE = "git.example.com/acme-platform/agents";
const reportedWorkspace = () => ({ reachable: true, key: WORKSPACE, ref: `git:${WORKSPACE}`, keyFrom: "workspace", standalone: false, defaultTeam: { label: "default", team: "aweb:acme-platform" }, teams: { default: "aweb:acme-platform" }, teamsFrom: "observed" });
const remoteRow = (name, root, more = {}) => ({ instance: name, agent: "dev", agentsRoot: `${root}/agents`, home: `${root}/agents/dev/instances/${name}`, running: true, savedRoute: false, addressable: true, missingRemotely: false, createdAt: null, identity: { alias: name, team: "aweb:acme-platform" }, ...more });
function group(id, root, rows = []) {
  const server = id.slice(0, id.indexOf(":"));
  return { id, server, label: server, registrationPresent: true, target: { sshHost: `${server}.example`, workspace: root }, probe: { ok: true }, agentsRoot: `${root}/agents`, workspace: reportedWorkspace(), souls: [], instances: rows, retireFailures: [] };
}
const garnet = () => group("garnet:t1", "/srv/acme-platform", [remoteRow("dev-far", "/srv/acme-platform"), remoteRow("dev-held", "/srv/acme-platform", { running: false, addressable: false })]);
const onyx = () => group("onyx:t2", "/home/builder/acme-platform", [remoteRow("dev-east", "/home/builder/acme-platform")]);
/** What `oats server roster --json` prints for these groups. */
const rosterAnswer = (groups) => ({ schemaVersion: 1, ok: true, result: { groups } });
/** The three values a store keeps of a roster state. */
const kept = ({ remoteGroups, rosterAnswered, rosterFailure }) => ({ remoteGroups, rosterAnswered, rosterFailure });
/** The event of one outcome over what a store held, said with the shared functions and nothing else. */
function taken(held, outcome, time) {
  const state = remoteRosterState(held.remote, outcome, time);
  const identities = state.reported === null ? held : observeIdentities({ memory: held.memory, notes: held.notes }, state.reported, time);
  return { roster: { remote: kept(state), memory: identities.memory, notes: identities.notes, at: time } };
}
const outcomes = (rosters) => rosters.filter((event) => event.roster);
/** The roster reads a reader started: counted where the process is started, so with no delay. */
const rosterReads = (spawned) => spawned.filter((call) => call.args[1] === "server").length;

test("the roster: an answer, a refusal and a read that threw each reach onRoster as the shared functions make them, each after { collecting: true }", async (t) => {
  const world = makeWorld();
  assert.deepEqual([cliReadsRemotes(world.remoteCli), cliReadsRemotes(world.cli)], [true, false]);
  const local = answering(world), answered = rosterAnswer([garnet(), onyx()]);
  world.plan({ ...local, server: { stdout: JSON.stringify(answered) } });
  let throwing = false;
  const spawn = (file, args, options) => { if (throwing && args[1] === "server") throw new Error("spawn EMFILE"); return nodeSpawn(file, args, options); };
  const { reader, entries, rosters, store } = reading(t, world, { cli: world.remoteCli, spawn });
  /** One live cycle, and the roster outcome it began. */
  const read = async (n) => { await reader.request({ live: true }); await waitFor(`roster answer ${n}`, () => outcomes(rosters).length === n); };

  // An answer: the groups are held, and what they reported is remembered.
  let held = store.roster;
  await read(1);
  assert.deepEqual(rosters, [{ collecting: true }, taken(held, { envelope: answered }, at(1))]);
  assert.deepEqual([store.roster.remote.rosterAnswered, store.roster.remote.remoteGroups, [...store.roster.memory.keys()]], [true, answered.result.groups, ["garnet:t1", "onyx:t2"]], "the fixture has the kernel's forms: both machines are remembered");
  assert.deepEqual(Object.keys(rosters[1].roster).sort(), ["at", "memory", "notes", "remote"]);
  assert.deepEqual(Object.keys(rosters[1].roster.remote).sort(), ["remoteGroups", "rosterAnswered", "rosterFailure"], "the three values a store keeps, and not what was reported");

  // A refusal (the kernel's envelope, exit 1): nothing was reported, so the memory is the one held, untouched.
  const refusal = { schemaVersion: 1, ok: false, error: { code: "E_SERVERS_UNREADABLE", message: "the server registry is not valid JSON" } };
  world.plan({ ...local, server: { stdout: JSON.stringify(refusal), exit: 1 } });
  held = store.roster;
  await read(2);
  assert.deepEqual(rosters.slice(2), [{ collecting: true }, taken(held, { envelope: refusal }, at(2))]);
  assert.equal(rosters[3].roster.memory, held.memory);
  assert.equal(rosters[3].roster.notes, held.notes);
  assert.notDeepEqual(rosters[3].roster.remote, held.remote, "and the groups held are not what they were");

  // A read that threw (the process could not be started): the message goes to the shared rule as it is.
  throwing = true;
  held = store.roster;
  await read(3);
  assert.deepEqual(rosters.slice(4), [{ collecting: true }, taken(held, { thrown: "spawn EMFILE" }, at(3))]);
  assert.equal(JSON.stringify(rosters[5].roster.remote).includes("spawn EMFILE"), true);

  // And an answer again.
  throwing = false;
  world.plan({ ...local, server: { stdout: JSON.stringify(answered) } });
  held = store.roster;
  await read(4);
  assert.deepEqual(rosters.slice(6), [{ collecting: true }, taken(held, { envelope: answered }, at(4))]);
  assert.deepEqual(store.roster.remote, kept(remoteRosterState(noRoster().remote, { envelope: answered }, at(4))));
  assert.deepEqual(entries.map((emitted) => [emitted.number, emitted.entry.deployment.status]), [[1, "observed"], [2, "observed"], [3, "observed"], [4, "observed"]], "whatever the roster did, this machine was read");
  assert.deepEqual(reader.children(), []);
});

test("the roster: when the memory of identities cannot take what an answer reported, the state just made is taken again as a read that threw", async (t) => {
  const world = makeWorld();
  const answered = rosterAnswer([garnet()]);
  world.plan({ ...answering(world), server: { stdout: JSON.stringify(answered) } });
  // A store whose memory is not a Map: the shared function throws for it.
  const broken = { remote: noRoster().remote, memory: { not: "a Map" }, notes: new Map() };
  const { reader, rosters } = reading(t, world, { cli: world.remoteCli, getRoster: () => broken });
  await reader.request();
  await waitFor("the roster's answer", () => outcomes(rosters).length === 1);

  const first = remoteRosterState(broken.remote, { envelope: answered }, at(1));
  assert.deepEqual(first.reported, answered.result.groups);
  let message = null;
  try { observeIdentities({ memory: broken.memory, notes: broken.notes }, first.reported, at(1)); } catch (error) { message = error.message; }
  assert.equal(typeof message, "string", "the shared function did throw");
  const marked = remoteRosterState(first, { thrown: message }, at(1));
  assert.deepEqual(rosters, [{ collecting: true }, { roster: { remote: kept(marked), memory: broken.memory, notes: broken.notes, at: at(1) } }]);
  assert.equal(rosters[1].roster.memory, broken.memory, "the memory as it was held");
  assert.equal(rosters[1].roster.notes, broken.notes);
  assert.deepEqual(rosters[1].roster.remote.remoteGroups.map((held) => [held.id, held.probe.ok]), [["garnet:t1", false]], "the groups just taken are marked not reached");
  assert.notDeepEqual(kept(marked), kept(first));
});

test("the roster: a cycle begins the read and does not wait for it; while one is in flight no second starts, not for a live request either", async (t) => {
  const world = makeWorld();
  const go = path.join(world.dir, "answer-now"), answered = rosterAnswer([garnet()]);
  world.plan({ ...answering(world, [kernelRow("dev-one")], [{ running: true, runtimeState: "running" }]), server: { stdout: JSON.stringify(answered), until: go } });
  const { reader, entries, rosters, spawned } = reading(t, world, { cli: world.remoteCli });

  await reader.request();
  assert.deepEqual([entries.length, shown(entries[0].entry)], [1, [["dev-one", true, "running"]]], "this machine's rows did not wait for the other machines");
  assert.deepEqual(rosters, [{ collecting: true }]);
  const pid = await waitFor("the roster's kernel to start", () => world.calls("server", "start")[0]?.pid);
  assert.deepEqual(reader.children(), [pid], "the cycle is over; the roster read is not");

  await reader.request({ live: true });
  await reader.request();
  await reader.request({ live: true });
  assert.deepEqual([entries.length, rosterReads(spawned), world.calls("server", "start").length], [4, 1, 1]);
  assert.deepEqual(rosters, [{ collecting: true }], "and nothing more is said of a read already on its way");
  assert.equal(alive(pid), true);

  writeFileSync(go, "");
  await waitFor("the roster's answer", () => rosters.length === 2);
  assert.deepEqual(rosters[1], taken(noRoster(), { envelope: answered }, at(1)), "with the time of the cycle that began it");
  assert.deepEqual(reader.children(), []);
  await reader.request({ live: true });
  assert.equal(rosterReads(spawned), 2, "none in flight: a live request begins one at once");
  await waitFor("the second answer", () => outcomes(rosters).length === 2);
  assert.equal(rosters.at(-1).roster.at, at(5));
});

test("the roster: with nobody asking, the next read begins no sooner than 15 s after the END of the last one; a live request begins one at once", async (t) => {
  const world = makeWorld();
  const go = path.join(world.dir, "answer-now");
  world.plan({ ...answering(world), server: { stdout: JSON.stringify(rosterAnswer([])), until: go } });
  let ms = 5_000_000;
  const { reader, rosters, spawned } = reading(t, world, { cli: world.remoteCli, now: () => ms });
  const answer = (n) => waitFor(`roster answer ${n}`, () => outcomes(rosters).length === n);

  await reader.request();
  assert.equal(rosterReads(spawned), 1, "none has ended yet: the first cycle begins one");
  ms += 20_000; // the read takes 20 s
  await reader.request();
  assert.equal(rosterReads(spawned), 1, "in flight");
  writeFileSync(go, "");
  await answer(1);
  await reader.request();
  assert.equal(rosterReads(spawned), 1, "20 s after it began, and no time at all after it ended");
  ms += 14_999;
  await reader.request();
  assert.equal(rosterReads(spawned), 1, "one millisecond short of 15 s");
  ms += 1;
  await reader.request();
  assert.equal(rosterReads(spawned), 2, "15 s after the end");
  await answer(2);
  ms += 14_999;
  await reader.request();
  assert.equal(rosterReads(spawned), 2, "and the 15 s are counted again from that end");
  await reader.request({ live: true });
  assert.equal(rosterReads(spawned), 3, "somebody asked");
  await answer(3);
  await reader.request();
  assert.equal(rosterReads(spawned), 3);
  assert.deepEqual(rosters.map((event) => Object.keys(event)[0]), ["collecting", "roster", "collecting", "roster", "collecting", "roster"]);

  // The pause is the caller's to set.
  const other = reading(t, world, { cli: world.remoteCli, now: () => ms, rosterMs: 1000 });
  await other.reader.request();
  await waitFor("its first answer", () => outcomes(other.rosters).length === 1);
  ms += 999;
  await other.reader.request();
  assert.equal(rosterReads(other.spawned), 1);
  ms += 1;
  await other.reader.request();
  assert.equal(rosterReads(other.spawned), 2);
  await waitFor("its second answer", () => outcomes(other.rosters).length === 2);
});

test("the roster, with a kernel that reads no other machine: no child is ever started for it, and the gated outcome is answered once", async (t) => {
  const world = makeWorld();
  world.plan({ ...answering(world), server: { stdout: JSON.stringify(rosterAnswer([garnet()])) } });
  const { reader, entries, rosters, spawned, store } = reading(t, world);
  // The store holds groups from somewhere: what the gated outcome makes of them is the shared rule's.
  const held = store.roster = { ...noRoster(), remote: kept(remoteRosterState(noRoster().remote, { envelope: rosterAnswer([garnet()]) }, at(1))) };
  await reader.request();
  await reader.request({ live: true });
  await reader.request();
  await sleep(100);
  assert.deepEqual(rosters, [taken(held, { gated: true }, at(1))], "once in a run, and never { collecting }");
  assert.equal(rosters[0].roster.memory, held.memory);
  assert.notDeepEqual(rosters[0].roster.remote, held.remote);
  assert.deepEqual([entries.length, rosterReads(spawned), world.calls("server").length], [3, 0, 0]);
});

test("no served deployment: a cycle reads nothing local and still reads the roster", async (t) => {
  const world = makeWorld();
  const answered = rosterAnswer([garnet()]);
  world.plan({ ...answering(world), server: { stdout: JSON.stringify(answered) } });
  const { reader, entries, rosters, spawned } = reading(t, world, { cli: world.remoteCli, served: [] });
  await reader.request();
  await waitFor("the roster's answer", () => outcomes(rosters).length === 1);
  assert.deepEqual(rosters, [{ collecting: true }, taken(noRoster(), { envelope: answered }, at(1))]);
  assert.deepEqual(spawned.map((call) => call.args), [[world.bin, "server", "roster", "--json"]]);
  assert.deepEqual([entries, world.calls("status"), world.calls("workspace"), world.calls("collector")], [[], [], [], []]);
});

test("the roster's kernel runs `server roster --json` in a session of its own, in the reader's environment, under the shared read's own time limit", async (t) => {
  const world = makeWorld();
  world.plan({ ...answering(world), server: { sleep: true } });
  const env = { ...CLEAN_ENV, OATS_UNRELATED: "kept" }, timers = fakeTimers();
  const { reader, rosters, spawned } = reading(t, world, { cli: world.remoteCli, env, timers });
  await reader.request();
  const call = await waitFor("the roster's kernel to start", () => world.calls("server", "start")[0]);

  assert.deepEqual(call.argv, ["server", "roster", "--json"], "and no --max-age: it is not a flag of this read");
  assert.equal(call.pgid, call.pid, "it leads its own process group");
  if (call.sid !== null) assert.equal(call.sid, call.pid, "and its own session");
  if (OWN_GROUP !== null) {
    assert.equal(groupOf(call.pid), call.pid);
    assert.notEqual(call.pgid, OWN_GROUP, "which is not this process's");
  }
  assert.deepEqual(EIGHT.filter((name) => name in call.env), [], "no instance variable");
  assert.equal(call.env.OATS_UNRELATED, "kept");
  const [started] = spawned.filter((made) => made.args[1] === "server");
  assert.deepEqual([started.file, started.args], [process.execPath, [world.bin, "server", "roster", "--json"]]);
  assert.deepEqual({ ...started.options, env: null }, { cwd: process.cwd(), env: null, shell: false, detached: true }, "what the shared read asked for, and detached: no deployment's directory");
  assert.equal(started.options.env, env, "the reader's environment, where the shared read names none");

  // Its limit is the shared read's 60 s. Past it the child is ended, and the outcome is the envelope
  // the shared read makes of a child that was ended at its limit, taken by the shared rule.
  assert.deepEqual(timers.delays(), [60_000]);
  timers.fire((ms) => ms === 60_000);
  assert.deepEqual(reader.children(), []);
  await gone([call.pid]);
  await waitFor("the roster's outcome", () => outcomes(rosters).length === 1);
  const envelope = await cliRemoteRoster(world.bin, { exec: (bin, argv, options, callback) => { callback(Object.assign(new Error("ended"), { code: null, signal: "SIGTERM", killed: true }), "", ""); } });
  assert.equal(envelope.ok, false);
  assert.deepEqual(rosters, [{ collecting: true }, taken(noRoster(), { envelope }, at(1))]);
  assert.deepEqual(timers.delays(), []);
});

/** A reader whose roster read is in flight, its kernel asleep with a grandchild in its group: once both run. */
async function rosterInFlight(t, world, options = {}) {
  const made = reading(t, world, { cli: world.remoteCli, ...options });
  await made.reader.request({ live: true });
  const pid = await waitFor("the roster's kernel to start", () => world.calls("server", "start").at(-1)?.pid);
  const inner = await waitFor("its grandchild to start", () => world.calls("sleeper", "start")[0]);
  assert.equal(inner.pgid, pid, "the grandchild is in the group the roster's kernel leads");
  if (OWN_GROUP !== null) assert.deepEqual([groupOf(pid), groupOf(inner.pid)], [pid, pid]);
  assert.deepEqual(made.reader.children(), [pid]);
  assert.equal([pid, inner.pid].every(alive), true);
  return { ...made, pid, inner: inner.pid };
}

test("leaving while the roster is read: stop() ends its child and its process group, no outcome is emitted for it, and nothing is started afterwards", async (t) => {
  const world = makeWorld();
  world.plan({ ...answering(world), server: { sleep: true, grandchild: true } });
  const { reader, entries, rosters, spawned, pid, inner } = await rosterInFlight(t, world);
  assert.deepEqual(rosters, [{ collecting: true }]);

  assert.equal(reader.stop(), undefined);
  assert.deepEqual(reader.children(), []);
  await gone([pid, inner]);
  await sleep(200);
  assert.deepEqual(rosters, [{ collecting: true }], "the read that was given up answers nothing: neither an answer nor a failure");
  const count = spawned.length;
  await reader.request({ live: true });
  await sleep(100);
  assert.deepEqual([spawned.length, rosters.length, entries.length], [count, 1, 1], "a later request starts no process");
});

test("voidInFlight() while the roster is read: its child and its process group are ended, no outcome is emitted for it, and the next live request begins a new read at once", async (t) => {
  const world = makeWorld();
  const answered = rosterAnswer([garnet()]), local = answering(world);
  world.plan({ ...local, server: { stdout: JSON.stringify(answered) } });
  // The clock of the 15 s never moves: only a live request, or no read having ended, begins one.
  const { reader, entries, rosters, spawned, store } = reading(t, world, { cli: world.remoteCli, now: () => 7_000_000 });
  await reader.request();
  await waitFor("the first answer", () => outcomes(rosters).length === 1);
  const before = store.roster;

  world.plan({ ...local, server: { sleep: true, grandchild: true } });
  await reader.request({ live: true });
  const pid = await waitFor("the roster's kernel to start", () => world.calls("server", "start")[1]?.pid);
  const inner = await waitFor("its grandchild to start", () => world.calls("sleeper", "start")[0]);
  assert.equal(inner.pgid, pid);
  if (OWN_GROUP !== null) assert.deepEqual([groupOf(pid), groupOf(inner.pid)], [pid, pid]);
  assert.deepEqual(reader.children(), [pid]);

  assert.equal(reader.voidInFlight(), undefined);
  assert.deepEqual(reader.children(), []);
  await gone([pid, inner.pid]);
  await sleep(200);
  // The shared read answers for the ended child (a timeout's envelope): that answer arrives after the call, and is dropped.
  assert.deepEqual(rosters.slice(2), [{ collecting: true }], "no outcome for the read that was in flight");
  assert.equal(store.roster, before, "what the store holds of the other machines is as it was");

  world.plan({ ...local, server: { stdout: JSON.stringify(answered) } });
  await reader.request();
  assert.equal(rosterReads(spawned), 2, "it is not in flight any more, and it is not a read that ended: the 15 s of the last answer still hold");
  await reader.request({ live: true });
  assert.equal(rosterReads(spawned), 3, "the live request of the return begins one at once");
  await waitFor("the answer of the new read", () => outcomes(rosters).length === 2);
  assert.deepEqual(rosters.slice(3), [{ collecting: true }, taken(before, { envelope: answered }, at(4))]);
  assert.deepEqual(entries.map((emitted) => emitted.number), [1, 2, 3, 4], "the local cycles were over: none of them was void");
});

test("voidInFlight() with the roster's answer already waiting in the pipe: the answer is dropped, and the live request after it is taken", async (t) => {
  // What a stopped TUI leaves behind: the roster's kernel went on in its own session and answered,
  // and nobody read the pipe. On the return voidInFlight() comes before that pipe is read.
  const world = makeWorld();
  const answered = rosterAnswer([garnet(), onyx()]);
  world.plan({ ...answering(world), server: { stdout: JSON.stringify(answered) } });
  const { reader, entries, rosters, spawned, store } = reading(t, world, { cli: world.remoteCli });
  const before = store.roster;

  const first = reader.request();
  for (let i = 0; i < 100 && rosterReads(spawned) < 1; i++) await Promise.resolve();
  assert.deepEqual([rosterReads(spawned), rosters], [1, [{ collecting: true }]], "the read began");
  // From here to voidInFlight() this process reads nothing: no await, as a stopped process has none.
  const until = Date.now() + 30_000;
  while (world.calls("server", "written").length === 0 && Date.now() < until) freeze(20);
  freeze(300);
  assert.equal(world.calls("server", "written").length, 1, "the kernel answered, whole, into the pipe");

  reader.voidInFlight();
  assert.deepEqual(reader.children(), []);
  assert.equal(await settled(first), true);
  await sleep(200);
  assert.deepEqual([rosters, entries], [[{ collecting: true }], []], "neither the answer nor a failure in its place");
  assert.equal(store.roster, before);

  await reader.request({ live: true });
  await waitFor("the answer of the new read", () => outcomes(rosters).length === 1);
  assert.deepEqual(rosters.slice(1), [{ collecting: true }, taken(before, { envelope: answered }, at(2))]);
  assert.deepEqual(entries.map((emitted) => [emitted.number, emitted.entry.deployment.status]), [[2, "observed"]]);
});

test("a roster read that ignores SIGTERM keeps neither the reader nor the next read: voidInFlight() forgets it at once", async (t) => {
  const world = makeWorld();
  const answered = rosterAnswer([onyx()]), local = answering(world);
  world.plan({ ...local, server: { sleep: true, stubborn: true } });
  const { reader, rosters, spawned } = reading(t, world, { cli: world.remoteCli });
  await reader.request();
  const pid = await waitFor("the roster's kernel to start", () => world.calls("server", "start")[0]?.pid);
  reader.voidInFlight();
  assert.deepEqual(reader.children(), []);
  world.plan({ ...local, server: { stdout: JSON.stringify(answered) } });
  await reader.request({ live: true });
  assert.equal(rosterReads(spawned), 2);
  await waitFor("the answer of the new read", () => outcomes(rosters).length === 1);
  assert.deepEqual(rosters, [{ collecting: true }, { collecting: true }, taken(noRoster(), { envelope: answered }, at(2))]);
  assert.equal(alive(pid), true, "it was asked to end, once, and nobody waited for it");
  assert.equal(ours(pid), true);
  process.kill(pid, "SIGKILL"); // the fake wrote this pid down, and it is still that fake
  await gone([pid], 5000);
});

// ── the look at the file system, for the switcher ─────────────────────────────

/** A directory that is a deployment: it holds a regular oats-local.yaml. Its path. */
function deploymentAt(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "oats-local.yaml"), "");
  return dir;
}
test("admitDeployment: a folder is admitted by what it is now, as its canonical path, and nothing above it is asked", () => {
  const base = path.join(ROOT, "admit"), outer = deploymentAt(path.join(base, "outer")), inner = path.join(outer, "inner"), picked = deploymentAt(path.join(base, "picked"));
  mkdirSync(inner);
  symlinkSync(picked, path.join(base, "to-picked"));
  assert.deepEqual(admitDeployment(picked), { ok: true, deployment: picked });
  assert.deepEqual(admitDeployment(`${picked}${path.sep}`), { ok: true, deployment: picked }, "a trailing separator");
  assert.deepEqual(admitDeployment(path.join(base, "to-picked")), { ok: true, deployment: picked }, "through a link: the directory it leads to");
  assert.deepEqual(findDeployment(inner), { ok: true, deployment: outer });
  assert.deepEqual(admitDeployment(inner), { ok: false }, "no walking up: the deployment above is not the folder that was picked");

  // A row of this computer's deployments list when the list was read, no longer a deployment at the pick.
  const was = deploymentAt(path.join(base, "listed", "was"));
  assert.deepEqual(admitDeployment(was), { ok: true, deployment: was });
  rmSync(path.join(was, "oats-local.yaml"));
  assert.deepEqual(admitDeployment(was), { ok: false }, "a folder that stopped being a deployment is refused");
  symlinkSync(path.join(picked, "oats-local.yaml"), path.join(was, "oats-local.yaml"));
  assert.deepEqual(admitDeployment(was), { ok: false }, "oats-local.yaml as a link is not a deployment's file");
  rmSync(was, { recursive: true });
  assert.deepEqual(admitDeployment(was), { ok: false }, "and so is one that is gone");
  assert.deepEqual(admitDeployment(path.join(picked, "oats-local.yaml")), { ok: false }, "a file");
  for (const given of [undefined, null, 42, "", "relative/path"]) assert.deepEqual(admitDeployment(given), { ok: false }, String(given));

  // With its io replaced: the canonical directory is asked about, once, and no other.
  const asked = [];
  const io = (isDeployment, realpath = () => "/real/dir") => ({ realpath, isDeployment: (dir) => { asked.push(dir); return isDeployment(dir); } });
  assert.deepEqual(admitDeployment("/given/link", io(() => true)), { ok: true, deployment: "/real/dir" });
  assert.deepEqual(admitDeployment("/given/link", io(() => false)), { ok: false });
  assert.deepEqual(asked.splice(0), ["/real/dir", "/real/dir"]);
  assert.deepEqual(admitDeployment("/given", io(() => { throw new Error("EACCES"); })), { ok: false });
  assert.deepEqual(admitDeployment("/given", io(() => true, () => { throw new Error("ENOENT"); })), { ok: false });
  assert.deepEqual(admitDeployment("/given", io(() => true, () => "not/absolute")), { ok: false });
});

// ── Opening an agent: the reader runs the preflight of another machine's agent as a read, and never
// touches the viewer, which is not its child (it runs in the panel's private tmux server).

/** The kernel record of a CLI that opens agents on other machines with a detach key. */
const keyedCli = (world) => cliRecord({ version: VERSION, workspaceApi: 2, features: [...FEATURES, DETACH_KEY_FEATURE, "server-probe-features"], remote: ["roster", "session"] }, { bin: world.bin, source: "tui" });
const TARGET = Object.freeze({ serverId: "garnet", instance: "dev-far", home: "/srv/acme-platform/agents/dev/instances/dev-far" });

test("the preflight's exec: `node <bin> session inspect …` in a session of its own and in the reader's environment, answered as execFile answers; prepareRemoteTerm over it answers the viewer's arguments", async (t) => {
  const world = makeWorld();
  world.plan({ session: { stdout: JSON.stringify({ schemaVersion: 1, ok: true, result: { present: true, state: "unknown", backend: "tmux" } }) } });
  const { reader, spawned } = reading(t, world);
  const cli = keyedCli(world);
  const prepared = await prepareRemoteTerm(cli, TARGET, { exec: reader.exec, detachKey: "F12" });
  assert.deepEqual(prepared, { binary: world.bin, args: ["session", "attach", "--server", "garnet", "--home", TARGET.home, "--detach-key", "F12"] });
  const [call] = world.calls("session", "start");
  assert.deepEqual(call.argv, ["session", "inspect", "--server", "garnet", "--home", TARGET.home, "--json"], "the inspect never carries the key");
  assert.equal(call.pgid, call.pid, "it leads a process group of its own");
  if (call.sid !== null) assert.equal(call.sid, call.pid, "and the session it leads");
  // The fake records the OATS_ and PI_ variables it was started with (fixtures/fake.mjs): the reader's
  // own, which may hold some (the test runner gives each file an OATS_HOME_DIR), and no instance's.
  const given = Object.fromEntries(Object.entries(CLEAN_ENV).filter(([name]) => name.startsWith("OATS_") || name.startsWith("PI_")));
  assert.deepEqual(call.env, given, "in the environment the reader was given, which has left the instance");
  assert.deepEqual(EIGHT.filter((name) => name in call.env), [], "no instance variable");
  assert.deepEqual(spawned.map((s) => [s.file, s.args[0], s.options.detached]), [[process.execPath, world.bin, true]]);
  assert.deepEqual(reader.children(), [], "and forgotten once it has closed");
});

test("the preflight's exec: voidInFlight() does not end it; its signal ends its whole group and it is answered at once; an aborted signal or a stopped reader starts nothing", async (t) => {
  const world = makeWorld();
  world.plan({ session: { sleep: true, grandchild: true } });
  const { reader, spawned } = reading(t, world);
  const giveUp = new AbortController();
  const answered = new Promise((resolve) => reader.exec(world.bin, ["session", "inspect", "--json"], { signal: giveUp.signal, timeout: 20_000, encoding: "utf8" }, (error) => resolve(error)));
  const pid = await waitFor("the inspect to start", () => world.calls("session", "start")[0]?.pid);
  const inner = await waitFor("its grandchild to start", () => world.calls("sleeper", "start")[0]);
  reader.voidInFlight();
  await sleep(300);
  assert.equal(alive(pid) && alive(inner.pid), true, "a cycle's giving up is not the preflight's");
  assert.deepEqual(reader.children(), [pid]);
  giveUp.abort();
  const error = await answered;
  assert.equal(error.killed, true, "answered as a read the reader ended");
  await gone([pid, inner.pid], 5000);
  assert.deepEqual(reader.children(), []);

  const before = spawned.length;
  assert.throws(() => reader.exec(world.bin, ["session", "inspect"], { signal: giveUp.signal }, () => {}), /given up before it started/);
  reader.stop();
  assert.throws(() => reader.exec(world.bin, ["session", "inspect"], {}, () => {}), /stopped/);
  assert.equal(spawned.length, before);
});

test("a preflight under way when the reader stops is ended with its group, as every read is", async (t) => {
  const world = makeWorld();
  world.plan({ session: { sleep: true } });
  const { reader } = reading(t, world);
  const answered = new Promise((resolve) => reader.exec(world.bin, ["session", "inspect", "--json"], { timeout: 20_000 }, (error) => resolve(error)));
  const pid = await waitFor("the inspect to start", () => world.calls("session", "start")[0]?.pid);
  reader.stop();
  assert.equal((await answered).killed, true);
  await gone([pid], 5000);
});

test("only reads are ever ended: a process the reader did not start (the panel's) is no child of the reader, and neither voidInFlight() nor stop() signals it", async (t) => {
  const world = makeWorld();
  world.plan({ ...answering(world, [kernelRow("dev-one")]), status: { sleep: true } });
  const { reader } = reading(t, world);
  // The sleeper stands in for the panel's tmux server and its viewer: started outside the reader.
  const other = nodeSpawn(process.execPath, [path.join(world.dir, "sleeper.mjs")], { env: CLEAN_ENV, stdio: "ignore" });
  const closed = new Promise((resolve) => other.once("exit", (code, signal) => resolve({ code, signal })));
  t.after(() => { try { other.kill("SIGKILL"); } catch { /* gone */ } });
  const pid = await waitFor("the other process to start", () => world.calls("sleeper", "start")[0]?.pid);
  reader.start();
  const kernel = await waitFor("a read to start", () => world.calls("status", "start")[0]?.pid);
  assert.equal(reader.children().includes(pid), false, "the reader does not know it");
  reader.voidInFlight();
  reader.stop();
  await gone([kernel], 5000);
  await sleep(300);
  assert.equal(alive(pid), true, "the reader's clean-up never signalled it");
  other.kill("SIGTERM");
  assert.deepEqual(await closed, { code: null, signal: "SIGTERM" });
  await gone([pid], 5000);
});

// ── A change: a stop or retire apply, a start or a restart (awebai/oats#855, PR 5) ───────────────

/** A kernel call that changes something, faked: it prints `{ out }` on stdout and `{ err }` on stderr,
 *  says it is under way (`ready`), and with a `gate` waits for that file before it writes once more
 *  on both and then `done`. A signal it receives is written down (`<done>.signal`) and does not end it,
 *  unless it is given `--die`: then it keeps no handler, and a signal ends it as it ends any node. */
const CHANGE = `
import { existsSync, writeFileSync } from "node:fs";
const [ready, gate, done, size] = process.argv.slice(2);
if (!process.argv.includes("--die")) for (const name of ["SIGTERM", "SIGHUP", "SIGINT", "SIGPIPE"]) process.on(name, () => writeFileSync(done + ".signal", name));
process.stdout.write(size ? "x".repeat(Number(size)) : '{"schemaVersion":1,"ok":true,"result":{"stopped":true}}');
process.stderr.write("the kernel's stderr\\n");
writeFileSync(ready, String(process.pid));
const wait = () => {
  if (gate && !existsSync(gate)) return setTimeout(wait, 20);
  if (gate) { process.stdout.write("written after the TUI let it go"); process.stderr.write("and on stderr"); }
  writeFileSync(done, "done");
  if (process.argv.includes("--fail")) process.exitCode = 3;
};
wait();
`;
/** A world for a change: its script, its files, and a reader whose private directory the test can find.
 *  `options` go to the reader (`timers`, for one). */
function changing(t, options = {}) {
  const dir = mkdtempSync(path.join(ROOT, "change-")), script = path.join(dir, "change.mjs");
  writeFileSync(script, CHANGE);
  const made = [];
  const files = { ...CHANGE_FILES, dir: () => { const at = CHANGE_FILES.dir(); made.push(at); return at; } };
  const world = makeWorld();
  const r = reading(t, world, { files, ...options });
  const pids = [];
  t.after(() => { for (const pid of pids) if (alive(pid)) quietly(() => process.kill(pid, "SIGKILL")); });
  const paths = { ready: path.join(dir, "ready"), gate: path.join(dir, "gate"), done: path.join(dir, "done") };
  return { ...r, script, paths, made, pids, files };
}
/** Run one change through the reader: its child and the callback's answer, when it comes. */
function change(c, argv, options = {}) {
  let answer = null;
  const child = c.reader.changeExec(c.script, argv, { label: { verb: "stop", name: "dev-1" }, ...options }, (...given) => { answer = given; });
  c.pids.push(child.pid);
  return { child, answer: () => answer };
}

test("a change never holds the panel's FIFO: the write end the TUI keeps for its keeper (lib/panel.mjs, THE KEEPER) is in no change's descriptors, so a change that outlives the TUI cannot keep its private server alive", { skip: existsSync("/proc/self/fd") ? false : "no /proc: a child's descriptors cannot be listed here" }, async (t) => {
  const c = changing(t);
  const fifo = path.join(mkdtempSync(path.join(ROOT, "fifo-")), "alive");
  execFileSync("mkfifo", ["-m", "600", fifo]);
  const held = PANEL_FS.hold(fifo);
  t.after(() => quietly(() => PANEL_FS.release(held)));
  const holders = (pid) => readdirSync(`/proc/${pid}/fd`).filter((fd) => quietly(() => readlinkSync(`/proc/${pid}/fd/${fd}`)) === fifo);
  assert.deepEqual(holders("self"), [String(held)], "the TUI holds it");
  const run = change(c, [c.paths.ready, c.paths.gate, c.paths.done]);
  await waitFor("the change to be under way", () => existsSync(c.paths.ready));
  assert.deepEqual(holders(run.child.pid), [], "the change does not");
  writeFileSync(c.paths.gate, "");
  await waitFor("the callback", run.answer);
  c.reader.stop();
});

test("a change's output goes to two files of the run's private directory, never a pipe: stdin is ignore, the TUI's copies are closed, and at the close both are read back, deleted, and handed to the callback as execFile hands them", async (t) => {
  const c = changing(t);
  const run = change(c, [c.paths.ready, "", c.paths.done], { timeout: 0, maxBuffer: 1024 * 1024, cwd: ROOT, encoding: "utf8" });
  const [spawned] = c.spawned;
  assert.deepEqual([spawned.file, spawned.args[0], spawned.options.detached, spawned.options.stdio[0]], [process.execPath, c.script, true, "ignore"]);
  assert.equal(typeof spawned.options.stdio[1], "number", "a file, not a pipe");
  assert.equal(typeof spawned.options.stdio[2], "number");
  assert.equal(spawned.options.label, undefined, "the label is the TUI's, and not passed on");
  assert.equal(spawned.options.timeout, undefined, "a timeout is the reader's to arm, and not passed to spawn");
  assert.equal(spawned.options.env, CLEAN_ENV, "the reader's environment");
  // Our copies are closed after the spawn (where /proc lists this process's descriptors).
  if (existsSync("/proc/self/fd")) for (const fd of spawned.options.stdio.slice(1)) assert.equal(existsSync(`/proc/self/fd/${fd}`), false, `descriptor ${fd} is closed`);
  assert.equal(c.made.length, 1);
  assert.equal(statSync(c.made[0]).mode & 0o777, 0o700, "a private directory");
  assert.deepEqual(readdirSync(c.made[0]).sort(), ["1.err", "1.out"]);
  assert.deepEqual(c.reader.changes(), [{ pid: run.child.pid, label: { verb: "stop", name: "dev-1" } }]);
  const answer = await waitFor("the callback", run.answer);
  assert.deepEqual(answer, [null, '{"schemaVersion":1,"ok":true,"result":{"stopped":true}}', "the kernel's stderr\n"]);
  assert.deepEqual(readdirSync(c.made[0]), [], "both files deleted");
  assert.deepEqual(c.reader.changes(), [], "it left the list when it exited");
  c.reader.stop();
  assert.equal(existsSync(c.made[0]), false, "the empty directory is removed on the way out");
});

test("a change that exits nonzero answers as execFile does, its output still read; one that prints more than maxBuffer answers ERR_CHILD_PROCESS_STDIO_MAXBUFFER with maxBuffer bytes", async (t) => {
  const c = changing(t);
  const failed = await waitFor("the callback", change(c, [c.paths.ready, "", c.paths.done, "", "--fail"]).answer);
  assert.deepEqual([failed[0].code, failed[0].signal, failed[0].killed, failed[1].length > 0, failed[2]], [3, null, false, true, "the kernel's stderr\n"]);
  const over = await waitFor("the callback", change(c, [path.join(path.dirname(c.paths.ready), "ready-2"), "", `${c.paths.done}-2`, "5000"], { maxBuffer: 100 }).answer);
  assert.deepEqual([over[0].code, over[1], over[2]], ["ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "x".repeat(100), "the kernel's stderr\n"]);
  assert.deepEqual(readdirSync(c.made[0]), []);
});

test("stop() lets a running change go and never signals it: its files are unlinked, it goes on writing after the TUI has gone and finishes; voidInFlight() does not touch it, changes() still names it, and no change starts after stop()", async (t) => {
  const c = changing(t);
  const run = change(c, [c.paths.ready, c.paths.gate, c.paths.done]);
  await waitFor("the change to be under way", () => existsSync(c.paths.ready));
  c.reader.voidInFlight();
  await sleep(100);
  assert.equal(alive(run.child.pid), true, "a void cycle does not end a change");
  c.reader.stop();
  assert.equal(existsSync(c.made[0]), false, "its files unlinked and the directory removed: nothing is left behind");
  assert.deepEqual(c.reader.changes(), [{ pid: run.child.pid, label: { verb: "stop", name: "dev-1" } }], "still running: named for the line after leaving");
  assert.deepEqual(c.reader.children(), [], "no child of the reader any more");
  assert.throws(() => c.reader.changeExec(c.script, [], {}, () => {}), /stopped/);
  writeFileSync(c.paths.gate, "");
  await waitFor("the change to finish after the TUI let it go", () => existsSync(c.paths.done));
  await gone([run.child.pid]);
  assert.equal(existsSync(`${c.paths.done}.signal`), false, "no signal reached it");
  assert.equal(run.answer(), null, "nobody waits for its answer any more");
});

// ── A change's deadline: a positive `timeout` its caller gives (the shared spawn apply on a kernel without worktree-event) ──

test("a change given a positive timeout: when it passes the child is sent its killSignal (SIGTERM unless named), and the callback's error has killed: true; neither option reaches spawn", async (t) => {
  const c = changing(t);
  const began = Date.now();
  const run = change(c, [c.paths.ready, c.paths.gate, c.paths.done, "", "--die"], { timeout: 150 });
  const [error, , stderr] = await waitFor("the callback", run.answer);
  assert.ok(Date.now() - began >= 140, "not before the timeout");
  assert.deepEqual([error.code, error.signal, error.killed], [null, "SIGTERM", true]);
  assert.equal(existsSync(c.paths.done), false, "it was ended before it finished");
  assert.equal(typeof stderr, "string", "its output is still read");
  await gone([run.child.pid]);
  const dir = path.dirname(c.paths.ready);
  const named = change(c, [path.join(dir, "ready-2"), c.paths.gate, path.join(dir, "done-2"), "", "--die"], { timeout: 100, killSignal: "SIGINT" });
  const [other] = await waitFor("the callback", named.answer);
  assert.deepEqual([other.code, other.signal, other.killed], [null, "SIGINT", true]);
  for (const spawned of c.spawned) assert.deepEqual([spawned.options.timeout, spawned.options.killSignal], [undefined, undefined]);
  assert.deepEqual(readdirSync(c.made[0]), [], "both files of both deleted");
});

test("a change that exits 0 after its timeout fired still answers killed: true, never a clean answer, with its output read", async (t) => {
  const timers = fakeTimers();
  const c = changing(t, { timers });
  const run = change(c, [c.paths.ready, c.paths.gate, c.paths.done], { timeout: 250 });
  assert.deepEqual(timers.delays(), [250], "one timer, of the timeout");
  await waitFor("the change to be under way", () => existsSync(c.paths.ready));
  timers.fire((ms) => ms === 250);
  assert.equal(await waitFor("SIGTERM to reach it", () => existsSync(`${c.paths.done}.signal`) && readFileSync(`${c.paths.done}.signal`, "utf8")), "SIGTERM");
  writeFileSync(c.paths.gate, "");
  const [error, stdout, stderr] = await waitFor("the callback", run.answer);
  assert.deepEqual([error.code, error.signal, error.killed], [0, null, true], "it exited 0, and the answer is still a kill");
  assert.equal(stdout, '{"schemaVersion":1,"ok":true,"result":{"stopped":true}}written after the TUI let it go');
  assert.equal(stderr, "the kernel's stderr\nand on stderr");
});

test("a zero, negative, missing or non-finite timeout arms nothing: no timer, no signal, and each change ends on its own with a clean answer", async (t) => {
  const timers = fakeTimers();
  const c = changing(t, { timers });
  const dir = path.dirname(c.paths.ready);
  const runs = [{ timeout: 0 }, { timeout: -5 }, { timeout: Infinity }, { timeout: Number.NaN }, {}].map((options, i) => ({
    done: path.join(dir, `done-${i}`),
    run: change(c, [path.join(dir, `ready-${i}`), c.paths.gate, path.join(dir, `done-${i}`)], options),
  }));
  assert.deepEqual(timers.delays(), [], "nothing is armed");
  await waitFor("every change to be under way", () => runs.every((_, i) => existsSync(path.join(dir, `ready-${i}`))));
  writeFileSync(c.paths.gate, "");
  for (const { run, done } of runs) {
    const [error] = await waitFor("the callback", run.answer);
    assert.equal(error, null);
    assert.equal(existsSync(`${done}.signal`), false, "no signal reached it");
  }
});

test("a positive timeout arms one timer, and a change that ends before it passes clears it: its answer is clean", async (t) => {
  const timers = fakeTimers();
  const c = changing(t, { timers });
  const run = change(c, [c.paths.ready, "", c.paths.done], { timeout: 60_000 });
  assert.deepEqual(timers.delays(), [60_000]);
  const [error] = await waitFor("the callback", run.answer);
  assert.equal(error, null);
  assert.deepEqual(timers.delays(), [], "cleared when the child ended");
});

test("the let-go clears a change's timer: after stop() the timeout passes and the child is neither signalled nor ended", async (t) => {
  const c = changing(t);
  const run = change(c, [c.paths.ready, c.paths.gate, c.paths.done], { timeout: 200 });
  const pid = run.child.pid;
  t.after(() => { if (alive(pid)) quietly(() => process.kill(pid, "SIGKILL")); });
  c.reader.stop();
  await waitFor("the change to be under way", () => existsSync(c.paths.ready));
  await sleep(400);
  assert.equal(alive(pid), true, "the TUI has gone, and the change goes on");
  assert.equal(existsSync(`${c.paths.done}.signal`), false, "no signal reached it");
  assert.equal(run.answer(), null, "nobody waits for its answer any more");
  process.kill(pid, "SIGKILL");
  await gone([pid]);
});

test("changeExec returns the real child, an armed timeout or not: it has the pid changes() names, and its own kill() ends it and clears the timer", async (t) => {
  const timers = fakeTimers();
  const c = changing(t, { timers });
  const run = change(c, [c.paths.ready, c.paths.gate, c.paths.done], { timeout: 60_000 });
  assert.ok(run.child instanceof ChildProcess);
  assert.ok(Number.isInteger(run.child.pid) && run.child.pid > 1);
  assert.deepEqual(c.reader.changes().map((change) => change.pid), [run.child.pid]);
  await waitFor("the change to be under way", () => existsSync(c.paths.ready));
  assert.equal(Number(readFileSync(c.paths.ready, "utf8")), run.child.pid, "the process that runs is the one returned");
  assert.equal(run.child.kill("SIGKILL"), true);
  const [error] = await waitFor("the callback", run.answer);
  assert.deepEqual([error.code, error.signal], [null, "SIGKILL"]);
  assert.deepEqual(timers.delays(), [], "cleared when the child ended");
  await gone([run.child.pid]);
});

// --- The identity reads (docs/tui.md, "The switcher") -------------------------------------

/** A kernel record that reports workspace identities, and one that does not. */
const IDENTIFIES = Object.freeze({ ok: true, bin: "/opt/oats/bin/oats.mjs", version: "0.66.0", workspaceApi: 2, features: Object.freeze(["workspace-v2", "workspace-identity"]) });
/** Timers the test fires by hand: what is armed, and what was cleared. */
function handTimers() {
  const armed = new Map();
  let next = 1;
  return { armed, setTimeout(fn, ms) { const id = next++; armed.set(id, { fn, ms }); return id; }, clearTimeout(id) { armed.delete(id); }, fire() { const all = [...armed.values()]; armed.clear(); for (const t of all) t.fn(); } };
}
/** A read the test answers by hand: every call, with what it was handed. */
function handReads() {
  const calls = [];
  return { calls, read: (cli, path, options, io) => new Promise((answer) => { calls.push({ cli, path, options, io, answer }); }) };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));
const IDENTITY_ANSWER = (key) => ({ ok: true, workspace: { reachable: true, key } });

test("identity reads run one at a time, in order, each answer handed on as it comes; each through the reader's exec with the run's signal and a background --max-age; one timer, the budget, cleared at the end", async () => {
  const timers = handTimers(), reads = handReads(), heard = [], execs = [];
  const exec = (bin, argv, options, callback) => { execs.push(options); return { bin, argv, callback }; };
  const identities = createIdentityReads({ cli: IDENTIFIES, exec, env: { HOME: "/home/u" }, onRead: (event) => heard.push(event), timers, read: reads.read });
  identities.start(["/a", "/b", "/c"]);
  await turn();
  assert.deepEqual(reads.calls.map((c) => c.path), ["/a"], "one read at a time");
  assert.deepEqual([...timers.armed.values()].map((t) => t.ms), [IDENTITY_BUDGET_MS], "the one timer is the budget");
  assert.equal(IDENTITY_BUDGET_MS, 60_000);
  const [first] = reads.calls;
  assert.deepEqual([first.cli, first.options, first.io.env], [IDENTIFIES, { maxAge: 60 }, { HOME: "/home/u" }]);
  first.io.exec("/opt/oats/bin/oats.mjs", ["status"], { cwd: "/a", timeout: 30_000 }, () => {});
  assert.equal(execs[0].signal instanceof AbortSignal, true, "the run's signal rides on the reader's exec");
  assert.deepEqual([execs[0].cwd, execs[0].timeout, execs[0].signal.aborted], ["/a", 30_000, false]);
  first.answer(IDENTITY_ANSWER("k/a"));
  await turn();
  assert.deepEqual(heard, [{ path: "/a", read: IDENTITY_ANSWER("k/a") }], "handed on before the next read is answered");
  assert.deepEqual(reads.calls.map((c) => c.path), ["/a", "/b"]);
  reads.calls[1].answer({ ok: false, reason: { code: "E_CLI_FAILED", message: "no" } });
  await turn();
  reads.calls[2].answer(IDENTITY_ANSWER("k/c"));
  await turn();
  assert.deepEqual(heard.map((e) => [e.path, e.read.ok]), [["/a", true], ["/b", false], ["/c", true]]);
  assert.equal(timers.armed.size, 0, "nothing is left armed: nothing reads again on its own");
});

test("the budget: when it runs out the read in flight is ended through its signal and answers timed out, whatever it then says, and every read not begun answers timed out without being made", async () => {
  const timers = handTimers(), reads = handReads(), heard = [], signals = [];
  const exec = (bin, argv, options) => { signals.push(options.signal); };
  const identities = createIdentityReads({ cli: IDENTIFIES, exec, env: {}, onRead: (event) => heard.push(event), timers, read: reads.read });
  identities.start(["/a", "/b", "/c"]);
  await turn();
  reads.calls[0].answer(IDENTITY_ANSWER("k/a"));
  await turn();
  reads.calls[1].io.exec("bin", [], {}, () => {});
  timers.fire();
  assert.equal(signals[0].aborted, true, "the read in flight is ended");
  reads.calls[1].answer({ ok: false, reason: { code: "E_CLI_FAILED", message: "killed" } });
  await turn(); await turn();
  assert.equal(reads.calls.length, 2, "the read not begun is never made");
  assert.deepEqual(heard.map((e) => [e.path, e.read.ok, e.read.reason?.code ?? null]), [["/a", true, null], ["/b", false, "E_CLI_TIMEOUT"], ["/c", false, "E_CLI_TIMEOUT"]]);
});

test("a new start ends the run before it, whose answers are dropped; stop() does the same; with no exec, a kernel without workspace identities or no path, nothing is read", async () => {
  const timers = handTimers(), reads = handReads(), heard = [], signals = [];
  const exec = (bin, argv, options) => { signals.push(options.signal); };
  const identities = createIdentityReads({ cli: IDENTIFIES, exec, env: {}, onRead: (event) => heard.push(event), timers, read: reads.read });
  identities.start(["/a", "/b"]);
  await turn();
  reads.calls[0].io.exec("bin", [], {}, () => {});
  identities.start(["/c"]);
  await turn();
  assert.equal(signals[0].aborted, true, "the read of the run before is ended");
  reads.calls[0].answer(IDENTITY_ANSWER("k/a"));
  await turn();
  assert.deepEqual(reads.calls.map((c) => c.path), ["/a", "/c"], "the run before reads nothing more");
  reads.calls[1].answer(IDENTITY_ANSWER("k/c"));
  await turn();
  assert.deepEqual(heard.map((e) => e.path), ["/c"], "only the new run's answer");
  identities.start(["/d"]);
  await turn();
  identities.stop();
  reads.calls[2].answer(IDENTITY_ANSWER("k/d"));
  await turn();
  assert.deepEqual(heard.map((e) => e.path), ["/c"], "nothing after stop()");
  assert.equal(timers.armed.size, 0);
  for (const [what, options] of [["no exec", { exec: undefined }], ["no feature", { cli: { ...IDENTIFIES, features: ["workspace-v2"] } }], ["no paths", {}]]) {
    const none = handReads();
    const quiet = createIdentityReads({ cli: IDENTIFIES, exec, env: {}, onRead: () => assert.fail(what), timers, read: none.read, ...options });
    quiet.start(what === "no paths" ? [] : ["/a"]);
    await turn();
    assert.deepEqual([none.calls.length, timers.armed.size], [0, 0], what);
  }
});

test("an identity read through the real shared reader and the reader's own exec: `oats status --dir <path> --max-age 60 --json` in the deployment, the projected workspace object handed on", async () => {
  const dir = "/srv/listed", argvs = [];
  const document = { root: `${dir}/agents`, agents: [], workspace: { reachable: true, key: "github.com/acme/lab", ref: "main", keyFrom: "workspace", standalone: false, defaultTeam: { label: "eng", team: "t" }, teams: { eng: "t" }, teamsFrom: "observed" } };
  const exec = (bin, argv, options, callback) => { argvs.push([bin, argv, options.cwd, typeof options.timeout]); setImmediate(() => callback(null, JSON.stringify(document), "")); };
  const heard = [];
  const cli = { ...IDENTIFIES, features: [...IDENTIFIES.features, "observe-max-age", "instance-modules", "served-identity", "packages-no-approval"] };
  const identities = createIdentityReads({ cli, exec, env: {}, onRead: (event) => heard.push(event), timers: handTimers() });
  identities.start([dir]);
  for (let i = 0; i < 5 && !heard.length; i++) await turn();
  assert.deepEqual(argvs, [[cli.bin, ["status", "--dir", dir, "--max-age", "60", "--json"], dir, "number"]]);
  assert.equal(heard.length, 1);
  assert.deepEqual([heard[0].path, heard[0].read.ok, heard[0].read.workspace.key, heard[0].read.workspace.reachable], [dir, true, "github.com/acme/lab", true]);
});
