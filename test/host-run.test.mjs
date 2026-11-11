// `oats host run` (oats-project/oats#1789, lib/host-run.mjs): the foreground entry that runs the
// kernel's periodic work where no host timer can (a container, a VM without a user manager). This
// file holds what needs no tmux: its refusals before any effect, `--plan`, its lock and its loop.
// Every refusal is made by the real function over a scratch OATS_HOME_DIR, and every lock and
// record is a real one. The seams are the ones the command has at its process boundary: the host
// timer's state (`hostStatus`: a test never touches a live timer), the clock and its one timer
// (`now`, `timer`), the `oats` child a step runs (`run`), the child that stops one home
// (`stopHome`) and the signal (`onSignal`). What a stop does to a home, on a real session, is
// test/host-stop.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { HOST_RUN_SCHEMA, acquireHostRunLock, hostRun, hostRunLockPath, hostRunPlan } from "../lib/host-run.mjs";
import { registerWorkspace } from "../lib/schedule.mjs";
import { isStartToken, processStartToken } from "../lib/worktree-hooks.mjs";

const CLI = fileURLToPath(new URL("../bin/oats.mjs", import.meta.url));
const NO_TIMER = () => ({ kind: "systemd", installed: false, active: false, problems: [] });
const UNIT = "/home/op/.config/systemd/user/oats-schedule-tick.timer";

/** OATS_HOME_DIR on a scratch directory for the length of one test, and no instance identity. */
function oatsHome(t) {
  const dir = mkdtempSync(join(tmpdir(), "oats-host-run-")), saved = { ...process.env };
  process.env.OATS_HOME_DIR = dir;
  for (const k of ["OATS_INSTANCE", "OATS_INSTANCE_HOME"]) delete process.env[k];
  t.after(() => {
    for (const k of ["OATS_HOME_DIR", "OATS_INSTANCE", "OATS_INSTANCE_HOME"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
/** A deployment directory as the schedule registry takes one. */
function deployment(base, name) {
  const dir = join(base, name);
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "oats-local.yaml"), "schemaVersion: 2\nworkspace: example.invalid/acme/workspace\n");
  return dir;
}
/** A run that must be refused before it starts anything: every seam that would act fails the test. */
const refused = (options) => hostRun({
  run: () => assert.fail("a refused host run starts no child"),
  stopHome: () => assert.fail("a refused host run stops no home"),
  onSignal: () => assert.fail("a refused host run listens for no signal"),
  timer: () => assert.fail("a refused host run arms no timer"),
  say: () => {},
  ...options,
});

test("host run refuses inside an instance session, before the host timer is asked and before anything is written", async (t) => {
  const home = oatsHome(t);
  await assert.rejects(refused({ env: { ...process.env, OATS_INSTANCE_HOME: "/srv/agents/dev/instances/one" }, hostStatus: () => assert.fail("the instance refusal comes first") }),
    (e) => e.code === "E_USAGE" && e.message === "oats host run runs as the host, never inside an instance session: OATS_INSTANCE_HOME is set (/srv/agents/dev/instances/one); nothing was started");
  assert.deepEqual(readdirSync(home), [], "nothing was written under OATS_HOME_DIR");
});

test("host run refuses while a host timer is active: two tickers would run", async (t) => {
  const home = oatsHome(t);
  await assert.rejects(refused({ hostStatus: () => ({ kind: "systemd", unit: UNIT, installed: true, active: true, problems: [] }) }),
    (e) => e.code === "E_HOST_RUN_TIMER_ACTIVE" && e.message === `the host timer is active (${UNIT}) and already runs oats schedule tick --host every minute; remove it (oats schedule host uninstall) before oats host run; nothing was started`
      && JSON.stringify(e.details) === JSON.stringify({ unit: UNIT }));
  assert.deepEqual(readdirSync(home), [], "nothing was written under OATS_HOME_DIR: the lock is not taken");
});

test("--plan says what a run would refuse, which scopes it would tick and which homes the sweep would consider, and changes nothing", async (t) => {
  const home = oatsHome(t);
  const answer = await hostRunPlan({ hostStatus: NO_TIMER });
  assert.deepEqual(answer, { schemaVersion: HOST_RUN_SCHEMA, plan: true, refusals: [], warnings: [], scopes: [], sweep: { schemaVersion: 1, plan: true, deployments: [], rows: [] } });
  assert.deepEqual(readdirSync(home), [], "a plan writes nothing: no lock, no registry, no note");

  // Two registered scopes, an installed timer that is not active, and an instance session.
  const base = mkdtempSync(join(tmpdir(), "oats-host-run-scopes-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const a = deployment(base, "a"), b = deployment(base, "b");
  registerWorkspace(a); registerWorkspace(b);
  const before = readdirSync(join(home, "schedules")).sort();
  const inactive = await hostRunPlan({ hostStatus: () => ({ kind: "systemd", unit: UNIT, installed: true, active: false, problems: [] }) });
  assert.deepEqual(inactive.refusals, []);
  assert.deepEqual(inactive.warnings, [`the host timer's unit files are installed but not active (${UNIT}): oats host run ticks in its place; remove them (oats schedule host uninstall) so that the timer cannot start beside it`]);
  assert.deepEqual(inactive.scopes, [a, b]);
  const both = await hostRunPlan({ env: { ...process.env, OATS_INSTANCE_HOME: "/srv/h" }, hostStatus: () => ({ kind: "launchd", unit: UNIT, installed: true, active: true, problems: [] }) });
  assert.deepEqual(both.refusals.map((r) => r.code), ["E_USAGE", "E_HOST_RUN_TIMER_ACTIVE"], "every refusal a run would meet, in the order it would meet them");
  for (const r of both.refusals) assert.equal(typeof r.message, "string");
  assert.deepEqual(both.warnings, [], "an active timer is a refusal, not also a warning");
  assert.deepEqual(readdirSync(join(home, "schedules")).sort(), before, "the plans wrote nothing beside the registry");
  assert.equal(existsSync(join(home, "host-run")), false, "no lock directory");
});

test("the CLI: oats host run --plan --json answers the envelope; an unknown flag, an argument and an unknown verb are refused before anything runs", (t) => {
  const home = oatsHome(t);
  const cli = (...argv) => spawnSync(process.execPath, [CLI, ...argv], { env: { ...process.env, OATS_HOME_DIR: home, PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 60000 });
  const plan = cli("host", "run", "--plan", "--json");
  assert.equal(plan.status, 0, plan.stderr);
  const envelope = JSON.parse(plan.stdout);
  assert.deepEqual([envelope.schemaVersion, envelope.ok, envelope.result.plan, envelope.result.schemaVersion], [1, true, true, HOST_RUN_SCHEMA]);
  assert.deepEqual(Object.keys(envelope.result), ["schemaVersion", "plan", "refusals", "warnings", "scopes", "sweep"]);
  const error = (r) => { assert.equal(r.status, 1, r.stdout + r.stderr); return JSON.parse(r.stdout).error; };
  const typo = error(cli("host", "run", "--stop-grce", "30", "--json"));
  assert.equal(typo.code, "E_BAD_ARGS");
  assert.equal(typo.message, "oats host run: unknown flag --stop-grce\nusage: oats host run [--stop-grace <seconds>] [--plan] [--json]");
  assert.equal(error(cli("host", "run", "now", "--json")).code, "E_BAD_ARGS");
  for (const grace of ["0", "301", "soon"]) assert.equal(error(cli("host", "run", "--stop-grace", grace, "--plan", "--json")).message, "--stop-grace needs a number of seconds (1..300) to wait for each harness after SIGTERM", grace);
  const verb = error(cli("host", "walk", "--json"));
  assert.deepEqual([verb.code, verb.message], ["E_BAD_ARGS", "usage: oats host run [--stop-grace <seconds>] [--plan] [--json]"]);
  assert.deepEqual(readdirSync(home).filter((n) => n !== "compile-cache"), [], "nothing was written under OATS_HOME_DIR");
  const help = cli("host", "--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage:\n  oats host run \[--stop-grace <s>\]/);
});

// ------------------------------------------------------------------ the lock

const BOOT = "boot-1", NONCE = "a".repeat(32), AT = "2026-11-10T00:00:00.000Z";
/** A real pid whose process has exited and been reaped. */
function exitedPid() {
  const exited = spawnSync(process.execPath, ["-e", ""], { timeout: 30000 });
  assert.equal(exited.status, 0);
  assert.throws(() => process.kill(exited.pid, 0), { code: "ESRCH" });
  return exited.pid;
}
/** Write the lock as a holder left it. */
function leaveLock(record) {
  mkdirSync(join(process.env.OATS_HOME_DIR, "host-run"), { recursive: true });
  const text = typeof record === "string" ? record : JSON.stringify({ nonce: NONCE, at: AT, ...record }) + "\n";
  writeFileSync(hostRunLockPath(), text);
  return text;
}
const busy = (found) => (e) => e.code === "E_HOST_RUN_BUSY" && JSON.stringify(e.details) === JSON.stringify({ lock: hostRunLockPath(), found });

test("the lock is one claim file under OATS_HOME_DIR that names its holder by pid, process start and boot; a second host run is E_HOST_RUN_BUSY, at once, and starts nothing", async (t) => {
  const home = oatsHome(t);
  assert.equal(hostRunLockPath(), join(home, "host-run", "lock"));
  const release = acquireHostRunLock({ boot: BOOT });
  assert.ok(lstatSync(hostRunLockPath()).isFile(), "the lock is one file");
  const record = JSON.parse(readFileSync(hostRunLockPath(), "utf8"));
  assert.deepEqual([record.pid, record.processStart, record.bootId], [process.pid, processStartToken(process.pid), BOOT]);
  const held = readFileSync(hostRunLockPath(), "utf8");
  await assert.rejects(refused({ boot: BOOT, hostStatus: NO_TIMER }), (e) => busy("running")(e)
    && e.message === `another oats host run on this machine holds ${hostRunLockPath()} (pid ${process.pid} holds it); nothing was started`);
  assert.equal(readFileSync(hostRunLockPath(), "utf8"), held, "the holder's record is unchanged");
  // A plan names the refusal and takes nothing.
  const plan = await hostRunPlan({ boot: BOOT, hostStatus: NO_TIMER });
  assert.deepEqual(plan.refusals.map((r) => [r.code, r.details]), [["E_HOST_RUN_BUSY", { lock: hostRunLockPath(), found: "running" }]]);
  assert.equal(readFileSync(hostRunLockPath(), "utf8"), held);
  release();
  assert.deepEqual(readdirSync(join(home, "host-run")), [], "released: nothing is left at the lock's path or beside it");
  assert.deepEqual((await hostRunPlan({ boot: BOOT, hostStatus: NO_TIMER })).refusals, []);
});

test("a lock left by a host run of another boot, or by a process that is gone, is taken over; one that lives in this boot is not", (t) => {
  oatsHome(t);
  const own = processStartToken(process.pid);
  assert.ok(isStartToken(own), `fixture premise: this host reads a process's start (${own})`);
  // Another kernel boot: the pid and its start can both come again.
  leaveLock({ bootId: "boot-0", pid: process.pid, processStart: own });
  acquireHostRunLock({ boot: BOOT })();
  assert.equal(existsSync(hostRunLockPath()), false, "taken over, and released");
  // A holder that exited, in this boot.
  leaveLock({ bootId: BOOT, pid: exitedPid(), processStart: own });
  acquireHostRunLock({ boot: BOOT })();
  assert.equal(existsSync(hostRunLockPath()), false);
  // The same record in the boot that wrote it is a host run that runs.
  const live = leaveLock({ bootId: BOOT, pid: process.pid, processStart: own });
  assert.throws(() => acquireHostRunLock({ boot: BOOT }), busy("running"));
  assert.equal(readFileSync(hostRunLockPath(), "utf8"), live);
});

test("a lock that cannot be judged is E_HOST_RUN_BUSY too, says what was found and what to do, and is left as it is", (t) => {
  oatsHome(t);
  const junk = leaveLock("{ not json");
  assert.throws(() => acquireHostRunLock({ boot: BOOT }), (e) => busy("unreadable")(e)
    && e.message === `the host run lock ${hostRunLockPath()} cannot be taken (the record at ${hostRunLockPath()} is unreadable); if no oats host run is running on this machine, remove ${hostRunLockPath()} and run it again; nothing was started`);
  assert.equal(readFileSync(hostRunLockPath(), "utf8"), junk);
});

// ------------------------------------------------------- registering a scope

test("oats schedule host install --register-only records the scope in the host registry and installs no unit, where neither launchd nor a systemd user manager exists", (t) => {
  const home = oatsHome(t);
  const base = mkdtempSync(join(tmpdir(), "oats-host-run-register-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dep = deployment(base, "dep"), userHome = join(base, "home"), config = join(base, "config");
  mkdirSync(userHome);
  // A PATH with node alone: no launchctl, no systemctl.
  const env = { ...process.env, OATS_HOME_DIR: home, HOME: userHome, XDG_CONFIG_HOME: config, PATH: dirname(process.execPath) };
  const cli = (...argv) => spawnSync(process.execPath, [CLI, ...argv], { env, encoding: "utf8", timeout: 60000 });
  const r = cli("schedule", "host", "install", "--register-only", "--dir", dep, "--json");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const { scheduler, warnings } = JSON.parse(r.stdout).result;
  assert.deepEqual([scheduler.registered, scheduler.installed, scheduler.active, scheduler.workspaces, warnings], [true, false, false, [dep], []]);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "schedules", "registry.json"), "utf8")).workspaces, [dep]);
  assert.equal(existsSync(config), false, "no systemd unit directory was made");
  assert.deepEqual(readdirSync(userHome), [], "no LaunchAgents directory was made");
  assert.equal(existsSync(join(home, "schedules", "log")), false, "nor the timer's log directory");
  // The caps travel with it, and a second registration changes nothing.
  const again = cli("schedule", "host", "install", "--register-only", "--max-concurrent", "2", "--dir", dep, "--json");
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.deepEqual([JSON.parse(again.stdout).result.scheduler.maxConcurrent, JSON.parse(again.stdout).result.scheduler.workspaces], [2, [dep]]);
  // It installs nothing, so it does not go with --print, which writes nothing.
  const both = cli("schedule", "host", "install", "--register-only", "--print", "--dir", dep, "--json");
  assert.equal(both.status, 1);
  assert.deepEqual([JSON.parse(both.stdout).error.code, JSON.parse(both.stdout).error.message], ["E_BAD_ARGS", "--register-only records the scope and --print writes nothing: give one"]);
  // What host run would tick is what the registry lists.
  const plan = cli("host", "run", "--plan", "--json");
  assert.equal(plan.status, 0, plan.stdout + plan.stderr);
  assert.deepEqual(JSON.parse(plan.stdout).result.scopes, [dep]);
});

// ------------------------------------------------------------------ the loop

const SWEEP = "session resume --json", TICK = "schedule tick --host --json", LIST = "session resume --plan --json";
const settle = () => new Promise((done) => setImmediate(done));
const ok = (result) => ({ schemaVersion: 1, ok: true, result });
/** A host run on a clock the test moves: `calls` every `oats` child it started (its argv, the time,
 *  and `answer(envelope)` to end it), `stops` every home it asked to stop, `said` its lines.
 *  `fire(iso)` moves the clock to `iso` and fires the one timer that is armed. */
function world(t, { at, scopes = [] }) {
  oatsHome(t);
  const w = { time: Date.parse(at), scopes, calls: [], stops: [], said: [], timers: [], signal: null, listening: 0 };
  const hhmmss = () => new Date(w.time).toISOString().slice(11, 23);
  w.options = {
    boot: BOOT, hostStatus: NO_TIMER, stopGraceMs: 7000, scopes: () => w.scopes, now: () => w.time,
    timer: (fn, ms) => { const armed = { fn, at: w.time + ms, live: true }; w.timers.push(armed); return () => { armed.live = false; }; },
    run: (argv) => new Promise((answer) => w.calls.push({ argv: argv.join(" "), at: hhmmss(), answer })),
    stopHome: (home, graceMs) => new Promise((answer) => w.stops.push({ home, graceMs, at: hhmmss(), answer })),
    onSignal: (handler) => { w.signal = handler; w.listening += 1; return () => { w.signal = null; w.listening -= 1; }; },
    say: (line) => w.said.push(line),
  };
  w.armed = () => w.timers.filter((timer) => timer.live);
  w.fire = async (iso) => {
    const [armed, ...more] = w.armed();
    assert.ok(armed && !more.length, `exactly one timer is armed (${w.armed().length})`);
    w.time = Date.parse(iso);
    armed.live = false;
    armed.fn();
    await settle();
  };
  /** The calls since the last look, as `<time> <argv>`. */
  let seen = 0;
  w.next = () => { const calls = w.calls.slice(seen); seen = w.calls.length; return calls.map((c) => `${c.at} ${c.argv}`); };
  w.pending = (argv) => w.calls.filter((c) => c.argv === argv && !c.answered);
  w.answer = async (argv, envelope) => { const [call] = w.pending(argv); assert.ok(call, `a ${argv} is running`); call.answered = true; call.answer(envelope); await settle(); };
  return w;
}
const D = "2026-11-10T";

test("the loop: the sweep once, then at second 0 of each minute the listing and, when a scope is registered, the tick; a minute whose tick still runs is skipped, and a missed minute is never replayed", async (t) => {
  const w = world(t, { at: `${D}10:00:20.500Z` });
  const running = hostRun(w.options);
  await settle();
  assert.equal(existsSync(hostRunLockPath()), true, "the lock is held while it runs");
  assert.deepEqual(w.next(), [`10:00:20.500 ${SWEEP}`], "the sweep first, as a child");
  assert.deepEqual(w.armed(), [], "no minute is armed while the sweep runs");
  w.time = Date.parse(`${D}10:00:50.000Z`);
  await w.answer(SWEEP, ok({ schemaVersion: 1, plan: false, deployments: [], rows: [{ outcome: "resumed" }, { outcome: "resumed" }, { outcome: "skipped" }] }));
  assert.deepEqual(w.armed().map((timer) => new Date(timer.at).toISOString()), [`${D}10:01:00.000Z`], "armed for second 0 of the next minute");
  assert.ok(w.said.includes("resume sweep: 2 resumed, 1 skipped"), w.said.join("\n"));

  // No scope is registered: the listing alone, and it says so, once.
  await w.fire(`${D}10:01:00.004Z`);
  assert.deepEqual(w.next(), [`10:01:00.004 ${LIST}`]);
  await w.answer(LIST, ok({ rows: [] }));
  await w.fire(`${D}10:02:00.001Z`);
  assert.deepEqual(w.next(), [`10:02:00.001 ${LIST}`]);
  await w.answer(LIST, ok({ rows: [] }));
  assert.equal(w.said.filter((line) => line.startsWith("no scope is registered, so nothing is ticked")).length, 1);

  // A scope is registered while it runs: the next minute ticks.
  w.scopes = ["/srv/deploy"];
  await w.fire(`${D}10:03:00.000Z`);
  assert.deepEqual(w.next(), [`10:03:00.000 ${TICK}`, `10:03:00.000 ${LIST}`]);
  assert.ok(w.said.includes("ticking 1 scope each minute: /srv/deploy"), w.said.join("\n"));
  await w.answer(LIST, ok({ rows: [] }));
  // That tick still runs at the next minute: the minute is skipped, the listing is not.
  await w.fire(`${D}10:04:00.002Z`);
  assert.deepEqual(w.next(), [`10:04:00.002 ${LIST}`]);
  await w.answer(LIST, ok({ rows: [] }));
  w.time = Date.parse(`${D}10:04:30.000Z`);
  await w.answer(TICK, ok({ considered: [] }));
  await w.fire(`${D}10:05:00.000Z`);
  assert.deepEqual(w.next(), [`10:05:00.000 ${TICK}`, `10:05:00.000 ${LIST}`]);
  await w.answer(TICK, ok({ considered: [] }));
  await w.answer(LIST, ok({ rows: [] }));

  // The process did not run for four minutes: one tick when it wakes, then the next minute's.
  await w.fire(`${D}10:09:17.000Z`);
  assert.deepEqual(w.next(), [`10:09:17.000 ${TICK}`, `10:09:17.000 ${LIST}`]);
  assert.deepEqual(w.armed().map((timer) => new Date(timer.at).toISOString()), [`${D}10:10:00.000Z`], "the missed minutes are not armed again");
  await w.answer(TICK, ok({ considered: [] }));
  await w.answer(LIST, ok({ rows: [] }));
  // A timer that fires just before the minute runs nothing: a tick started then would evaluate the minute before.
  await w.fire(`${D}10:09:59.998Z`);
  assert.deepEqual(w.next(), []);
  assert.deepEqual(w.armed().map((timer) => new Date(timer.at).toISOString()), [`${D}10:10:00.000Z`]);
  await w.fire(`${D}10:10:00.000Z`);
  assert.deepEqual(w.next(), [`10:10:00.000 ${TICK}`, `10:10:00.000 ${LIST}`]);
  // A tick that fails is said and counted, and the next minute ticks again.
  await w.answer(TICK, { schemaVersion: 1, ok: false, error: { code: "E_SCHEDULER_BUSY", message: "the host scheduler is locked" } });
  assert.ok(w.said.includes("tick failed (E_SCHEDULER_BUSY): the host scheduler is locked"), w.said.join("\n"));
  await w.answer(LIST, ok({ rows: [] }));

  // The host stops it: nothing runs, so it ends at once, with what it did.
  w.time = Date.parse(`${D}10:10:40.000Z`);
  w.signal("SIGTERM");
  await settle();
  assert.deepEqual(w.next(), [`10:10:40.000 ${LIST}`], "it lists once to find what runs");
  await w.answer(LIST, ok({ rows: [] }));
  const answer = await running;
  assert.deepEqual(answer, { schemaVersion: HOST_RUN_SCHEMA, plan: false, signal: "SIGTERM", warnings: [],
    sweep: { schemaVersion: 1, plan: false, deployments: [], rows: [{ outcome: "resumed" }, { outcome: "resumed" }, { outcome: "skipped" }] },
    ticks: { run: 4, skipped: 1, failed: 1, noScope: 2 }, stopped: [] });
  assert.deepEqual([w.armed().length, w.listening, existsSync(hostRunLockPath())], [0, 0, false], "no timer is armed, no signal is listened for, and the lock is released");
});

test("a sweep that fails does not end the run: it is said, and the minutes go on; installed unit files are a warning of the run", async (t) => {
  const w = world(t, { at: `${D}10:00:00.000Z`, scopes: ["/srv/deploy"] });
  const running = hostRun({ ...w.options, hostStatus: () => ({ kind: "systemd", unit: UNIT, installed: true, active: false, problems: [] }) });
  await settle();
  await w.answer(SWEEP, { schemaVersion: 1, ok: false, error: { code: "E_RESUME_BUSY", message: "another session resume holds the lock" } });
  assert.ok(w.said.includes("resume sweep failed (E_RESUME_BUSY): another session resume holds the lock"), w.said.join("\n"));
  assert.ok(w.said.some((line) => line.startsWith("warning: the host timer's unit files are installed but not active")), w.said.join("\n"));
  await w.fire(`${D}10:01:00.000Z`);
  assert.deepEqual(w.next(), [`10:00:00.000 ${SWEEP}`, `10:01:00.000 ${TICK}`, `10:01:00.000 ${LIST}`]);
  await w.answer(TICK, ok({ considered: [] }));
  await w.answer(LIST, ok({ rows: [] }));
  w.signal("SIGINT");
  await settle();
  await w.answer(LIST, ok({ rows: [] }));
  const answer = await running;
  assert.deepEqual([answer.signal, answer.sweep, answer.ticks, answer.warnings.length], ["SIGINT", { error: { code: "E_RESUME_BUSY", message: "another session resume holds the lock" } }, { run: 1, skipped: 0, failed: 0, noScope: 0 }, 1]);
});

// ------------------------------------------------------------------ the stop

test("SIGTERM: ticking ends first, a tick that runs is waited for, then one listing, then every running home is stopped side by side; it answers what it stopped", async (t) => {
  const w = world(t, { at: `${D}10:00:00.000Z`, scopes: ["/srv/deploy"] });
  const running = hostRun(w.options);
  await settle();
  await w.answer(SWEEP, ok({ rows: [] }));
  await w.fire(`${D}10:01:00.000Z`);
  await w.answer(LIST, ok({ rows: [] }));
  assert.deepEqual(w.next(), [`10:00:00.000 ${SWEEP}`, `10:01:00.000 ${TICK}`, `10:01:00.000 ${LIST}`]);
  assert.equal(w.pending(TICK).length, 1, "a tick runs");

  w.time = Date.parse(`${D}10:01:20.000Z`);
  w.signal("SIGTERM");
  await settle();
  assert.deepEqual(w.armed(), [], "no minute is armed after the signal");
  assert.ok(w.said.includes("SIGTERM: ticking ended"), w.said.join("\n"));
  assert.deepEqual([w.next(), w.stops], [[], []], "while the tick runs nothing is listed and no home is stopped: its wake job may still start one");
  // A second signal changes nothing.
  w.signal("SIGTERM"); w.signal("SIGINT");
  await settle();
  assert.deepEqual([w.next(), w.stops], [[], []]);

  w.time = Date.parse(`${D}10:01:25.000Z`);
  await w.answer(TICK, ok({ considered: [] }));
  assert.deepEqual(w.next(), [`10:01:25.000 ${LIST}`], "the tick has ended: one listing");
  assert.deepEqual(w.stops, [], "no home is stopped before the listing answers");
  const A = "/srv/deploy/agents/dev/instances/a", B = "/srv/deploy/agents/dev/instances/b", C = "/srv/deploy/agents/dev/instances/c";
  await w.answer(LIST, ok({ rows: [
    { deployment: "/srv/deploy", instance: "a", home: A, outcome: "already-running" },
    { deployment: "/srv/deploy", instance: "lost", home: "/srv/deploy/agents/dev/instances/lost", outcome: "resumed" },
    { deployment: "/srv/deploy", instance: "b", home: B, outcome: "already-running" },
    { deployment: "/srv/deploy", instance: "unknown", home: "/srv/deploy/agents/dev/instances/unknown", outcome: "skipped", reason: "unknown" },
    { deployment: "/srv/deploy", instance: "c", home: C, outcome: "already-running" },
  ] }));
  assert.deepEqual(w.stops.map((s) => [s.home, s.graceMs, s.at]), [[A, 7000, "10:01:25.000"], [B, 7000, "10:01:25.000"], [C, 7000, "10:01:25.000"]], "every running home, and only those, each with the stop grace, all before any has answered");
  assert.ok(w.said.includes("stopping 3 running instances, each given 7 s"), w.said.join("\n"));
  assert.deepEqual(w.next(), [], "nothing else is started");

  // They answer in another order than they were asked; the answer keeps the listing's.
  w.stops[2].answer({ ok: false, home: C, code: "E_SESSION_STOP_FAILED", message: "c was asked to stop and is still running after 7000 ms; nothing was escalated", stillRunning: [4242] });
  w.stops[1].answer({ ok: true, home: B, stopped: false, alreadyIdle: true, state: "stopped" });
  await settle();
  let ended = false;
  running.then(() => { ended = true; });
  await settle();
  assert.equal(ended, false, "it waits for every stop");
  w.stops[0].answer({ ok: true, home: A, stopped: true, alreadyIdle: false, state: "shell" });
  const answer = await running;
  assert.deepEqual(answer.stopped, [
    { ok: true, home: A, stopped: true, alreadyIdle: false, state: "shell" },
    { ok: true, home: B, stopped: false, alreadyIdle: true, state: "stopped" },
    { ok: false, home: C, code: "E_SESSION_STOP_FAILED", message: "c was asked to stop and is still running after 7000 ms; nothing was escalated", stillRunning: [4242] },
  ]);
  assert.deepEqual([answer.signal, answer.ticks], ["SIGTERM", { run: 1, skipped: 0, failed: 0, noScope: 0 }]);
  assert.ok(w.said.includes(`could not stop ${C} (E_SESSION_STOP_FAILED): c was asked to stop and is still running after 7000 ms; nothing was escalated`), w.said.join("\n"));
  assert.deepEqual([w.listening, existsSync(hostRunLockPath())], [0, false], "the lock is released once the homes have answered");
});

test("SIGTERM while the sweep runs: the sweep is waited for, no minute is ever armed, and what runs is stopped; a listing that fails stops nothing and is said", async (t) => {
  const w = world(t, { at: `${D}10:00:00.000Z`, scopes: ["/srv/deploy"] });
  const running = hostRun(w.options);
  await settle();
  w.signal("SIGTERM");
  await settle();
  assert.deepEqual([w.next(), w.stops, w.armed()], [[`10:00:00.000 ${SWEEP}`], [], []], "the sweep's starts are not cut: nothing else happens while it runs");
  await w.answer(SWEEP, ok({ rows: [{ outcome: "resumed" }] }));
  assert.deepEqual([w.next(), w.armed()], [[`10:00:00.000 ${LIST}`], []]);
  await w.answer(LIST, { schemaVersion: 1, ok: false, error: { code: "E_DEPLOYMENTS_INVALID", message: "the deployments list cannot be read" } });
  const answer = await running;
  assert.deepEqual([answer.stopped, w.stops], [[], []]);
  assert.ok(w.said.includes("listing failed (E_DEPLOYMENTS_INVALID): the deployments list cannot be read: no instance is stopped"), w.said.join("\n"));
});


test("a private host-stop fence prevents a second scheduled command after cancellation", async (t) => {
  const base = oatsHome(t), ws = deployment(base, "scope"), log = join(base, "commands");
  const workModule = new URL("../lib/host-run-work.mjs", import.meta.url);
  assert.ok(existsSync(workModule), "host run needs owned children carrying the admission fence");
  const { hostRunWork } = await import(workModule);
  const { addSchedule } = await import("../lib/schedule.mjs");
  const script = join(base, "command.mjs");
  writeFileSync(script, `import { appendFileSync } from "node:fs";
    if (!['first','second'].includes(process.argv[2])) { console.log('{"ok":true,"result":{}}'); process.exit(0); }
    appendFileSync(${JSON.stringify(log)}, process.argv[2] + "\\n");
    if(process.argv[2] === "first") { process.on("SIGTERM",()=>process.exit(0)); setInterval(()=>{},1000); }
    else console.log('{"ok":true,"result":{}}');`);
  for (const [id, name] of [["a", "first"], ["b", "second"]]) {
    addSchedule(ws, {id, enabled:true, kind:"command", cron:"* * * * *", tz:"UTC", cwd:ws, argv:["oats", name]});
  }
  registerWorkspace(ws, { maxConcurrent: 2 });
  const tick = join(base, "tick.mjs");
  writeFileSync(tick, `import { tickHost } from ${JSON.stringify(new URL("../lib/schedule.mjs", import.meta.url).href)}; console.log(JSON.stringify(tickHost({io:{oatsBin:${JSON.stringify(script)}}})));`);
  const work = hostRunWork({kernel:{execPath:process.execPath,bin:tick},env:{...process.env,PATH:"/usr/bin:/bin"},naturalMs:100,cancelMs:3500});
  const answered = work.run([]);
  t.after(() => work.close());
  for (let tries = 0; !existsSync(log) && tries < 300; tries += 1) await delay(10);
  assert.equal(readFileSync(log,"utf8"), "first\n");
  await work.drain();
  await answered;
  assert.equal(readFileSync(log,"utf8"), "first\n", "the tick must not admit the second command after its interrupted first command");
  const state = JSON.parse(readFileSync(join(ws, ".agents/schedules/state.json"), "utf8"));
  assert.equal(state.jobs.a.lastRun.outcome, "unknown", "interruption is not converted to success by exit0");
  assert.ok(state.jobs.a.attempt, "unconfirmed launch still requires reconcile");
  assert.equal(state.jobs.b?.attempt, undefined, "an unadmitted job has no launch attempt");
});


test("owned host-run work gives a launch natural grace then cancels its group before drain completes", {skip:process.platform === "win32"}, async (t) => {
  const base = oatsHome(t), workModule = new URL("../lib/host-run-work.mjs", import.meta.url);
  assert.ok(existsSync(workModule), "host run must own cancellation rather than race an unbounded child");
  const { hostRunWork } = await import(workModule);
  const bin = join(base, "work.mjs"), ready = join(base, "ready"), ended = join(base, "ended");
  writeFileSync(bin, `import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(ready)}, String(process.pid));
    process.on('SIGTERM',()=> {writeFileSync(${JSON.stringify(ended)},'TERM'); process.exit(0);});
    setInterval(()=>{},1000);`);
  const work = hostRunWork({kernel:{execPath:process.execPath,bin},env:process.env, naturalMs:150, cancelMs:200});
  t.after(() => work.close());
  const answer = work.run([]);
  for(let i=0;!existsSync(ready)&&i<200;i+=1) await delay(10);
  const pid = Number(readFileSync(ready,"utf8"));
  const drain = work.drain();
  await delay(30);
  assert.equal(existsSync(ended),false,"a launch first gets time to complete naturally");
  assert.doesNotThrow(()=>process.kill(pid,0));
  await drain;
  assert.equal(readFileSync(ended,"utf8"),"TERM");
  assert.throws(()=>process.kill(pid,0),{code:"ESRCH"});
  assert.equal((await answer).ok,false,"an interrupted child with no envelope is not confirmed");
});


test("TERM during a real startup sweep reaches the final read within the stop window", async (t) => {
  const base = oatsHome(t), bin = join(base,"kernel.mjs"), ready = join(base,"sweep-pid");
  writeFileSync(bin, `import {writeFileSync} from 'node:fs';
    if(process.argv.includes('--plan')) console.log(JSON.stringify({ok:true,result:{rows:[]}}));
    else { writeFileSync(${JSON.stringify(ready)}, String(process.pid)); process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000); }`);
  let signal, ownedPid;
  const said=[];
  const running = hostRun({kernel:{execPath:process.execPath,bin},hostStatus:NO_TIMER,onSignal:fn=>{signal=fn;return()=>{};},say:line=>said.push(line)});
  t.after(async()=>{
    signal?.('SIGTERM');
    if(ownedPid) {try{process.kill(ownedPid,'SIGKILL');}catch{/* owned fixture already gone */}}
    await running;
  });
  for(let i=0;!existsSync(ready)&&i<200;i+=1) await delay(10);
  assert.ok(existsSync(ready),'the startup sweep actually runs');
  ownedPid=Number(readFileSync(ready,'utf8'));
  const at=Date.now();
  signal('SIGTERM');
  let timeout;
  const answer=await Promise.race([running,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('startup sweep exceeded its bounded cancellation window')),12000);})]).finally(()=>clearTimeout(timeout));
  assert.ok(Date.now()-at >= 9000,'a live launch gets the accepted natural grace');
  assert.equal(answer.signal,'SIGTERM');
  assert.equal(answer.sweep.error.code,'E_HOST_RUN_FAILED');
  assert.match(said.join('\n'),/admissions fenced/);
  assert.equal(existsSync(hostRunLockPath()),false,'the claim is released only after the owned work ends');
});


test("owned cancellation waits for a TERM-ignoring descendant after its leader exits", {skip:process.platform === "win32"}, async (t) => {
  const base=oatsHome(t), bin=join(base,'group.mjs'), ready=join(base,'child-pid');
  const {hostRunWork}=await import('../lib/host-run-work.mjs');
  writeFileSync(bin, `import {spawn} from 'node:child_process';
    const program="require('node:fs').writeFileSync("+${JSON.stringify(JSON.stringify(ready))}+", String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
    spawn(process.execPath,['-e',program],{stdio:'ignore'});
    process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`);
  const work=hostRunWork({kernel:{execPath:process.execPath,bin},env:process.env,naturalMs:50,cancelMs:200});
  let pid;
  t.after(async()=>{if(pid){try{process.kill(pid,'SIGKILL');}catch{/* own fixture gone */}} await work.close();});
  const answer=work.run([]);
  for(let i=0;!existsSync(ready)&&i<200;i+=1) await delay(10);
  pid=Number(readFileSync(ready,'utf8'));
  const at=Date.now();
  await work.drain();
  await answer;
  assert.ok(Date.now()-at>=200,'leader close cannot stand in for descendant cleanup');
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});


test("owned cancellation ends a detached kernel child even if its launcher cannot handle TERM", {skip:process.platform === "win32"}, async (t) => {
  const base=oatsHome(t), bin=join(base,'launcher.mjs'), inner=join(base,'inner.mjs'), ready=join(base,'inner-pid'), stopped=join(base,'launcher-stopped');
  const {hostRunWork}=await import('../lib/host-run-work.mjs');
  writeFileSync(inner, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(ready)},String(process.pid));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`);
  writeFileSync(bin, `import {spawn} from 'node:child_process';import {existsSync,writeFileSync} from 'node:fs';
    import {hostRunChildArgs} from ${JSON.stringify(new URL('../lib/host-run-admission.mjs',import.meta.url).href)};
    spawn(process.execPath,hostRunChildArgs(${JSON.stringify(inner)},[],true),{detached:true,stdio:'ignore'});
    const wait=setInterval(()=>{if(existsSync(${JSON.stringify(ready)})){clearInterval(wait);writeFileSync(${JSON.stringify(stopped)},'yes');process.kill(process.pid,'SIGSTOP');}},10);`);
  const work=hostRunWork({kernel:{execPath:process.execPath,bin},env:process.env,naturalMs:50,cancelMs:200});
  let pid;
  t.after(async()=>{if(pid){try{process.kill(pid,'SIGKILL');}catch{/* own fixture gone */}} await work.close();});
  const answer=work.run([]);
  for(let i=0;!existsSync(stopped)&&i<300;i+=1) await delay(10);
  assert.ok(existsSync(stopped),'the real launcher is stopped after its detached child starts');
  pid=Number(readFileSync(ready,'utf8'));
  await work.drain(); await answer;
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'},'a killed launcher cannot stand in for its detached kernel child');
});


test("a closed private fence keeps trigger events pending and blocks wake or direct starts", (t) => {
  const base=oatsHome(t), ws=deployment(base,'admission'), fence=join(base,'fence'), bin=join(base,'boundaries.mjs'), fake=join(base,'fake.mjs'), calls=join(base,'launches');
  const home=join(ws,'agents/dev/instances/one');mkdirSync(home,{recursive:true});
  writeFileSync(join(home,'instance.json'),JSON.stringify({instance:'one',agent:'dev',createdAt:'2026-01-01T00:00:00Z'}));
  writeFileSync(fence,'stop');
  writeFileSync(fake,`import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(calls)},'kernel child');console.log(JSON.stringify({ok:true,result:{instance:'one',home:${JSON.stringify(home)},stem:'dev'}}));`);
  writeFileSync(join(ws,'oats-schedules.json'),JSON.stringify({version:1,jobs:{
    wake:{id:'wake',kind:'wake',enabled:true,cron:'* * * * *',tz:'UTC',home,message:'fixture'},
    trigger:{id:'trigger',kind:'trigger',enabled:true,on:{source:'github.pull_request',repo:'github.com/acme/repo',events:['opened'],labels:[],base:'main',poll:'1m'},spawn:{soul:'dev',purpose:'pr-{number}',task:'fixture',teams:[]},concurrency:{max:2,perKey:1}}
  }}));
  writeFileSync(bin,`import assert from 'node:assert/strict';
    import {tickWorkspace} from ${JSON.stringify(new URL('../lib/schedule.mjs',import.meta.url).href)};
    import {tickTriggers} from ${JSON.stringify(new URL('../lib/triggers.mjs',import.meta.url).href)};
    import {spawnInstanceAsync,startInstanceSession} from ${JSON.stringify(new URL('../lib/core.mjs',import.meta.url).href)};
    let starts=0,polls=0;
    const ws=${JSON.stringify(ws)}, home=${JSON.stringify(home)}, now=new Date('2026-11-11T00:00:00Z');
    const io={oatsBin:${JSON.stringify(fake)},inspect:()=>({present:false}),start:()=>{starts++;return{home,instance:'one'};},gh:()=>{polls++;return{status:0,stdout:JSON.stringify([{number:1,html_url:'https://example.invalid/pr/1',draft:false,head:{sha:'a'.repeat(40)},base:{ref:'main'},labels:[],created_at:'2026-11-10T00:00:00Z',updated_at:'2026-11-10T00:00:00Z'}])};}};
    tickWorkspace(ws,{now,io,reg:{},wsList:[ws]});
    const rows=tickTriggers(ws,{now,io,reg:{},wsList:[ws]});
    assert.equal(starts,0,'wake start refused at admission');
    assert.equal(polls,1,JSON.stringify(rows));
    await assert.rejects(spawnInstanceAsync(ws,{}),e=>e.code==='E_HOST_RUN_FAILED');
    assert.throws(()=>startInstanceSession(home,{resume:true}),e=>e.code==='E_HOST_RUN_FAILED');
    console.log('PASS closed admissions');`);
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../lib/host-run-child.mjs',import.meta.url)),bin,fence,'member'],{env:process.env,encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr+result.stdout);
  assert.match(result.stdout,/PASS closed admissions/);
  assert.equal(existsSync(calls),false,'pending trigger never previews or spawns a child');
  const state=JSON.parse(readFileSync(join(ws,'.agents/schedules/triggers.json'),'utf8'));
  assert.equal(Object.keys(state.triggers['local/trigger'].pending).length,1,'the event is retained for the next live tick');
});
