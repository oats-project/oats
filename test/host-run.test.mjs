// `oats host run` (oats-project/oats#1789, lib/host-run.mjs): the foreground entry that runs the
// kernel's periodic work where no host timer can (a container, a VM without a user manager). This
// file holds what needs no tmux: its refusals before any effect, `--plan` and its lock. Every
// refusal is made by the real function over a scratch OATS_HOME_DIR, and every lock and record is
// a real one; the host timer's state is the one seam (`hostStatus`), since a test never touches a
// live timer.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  // Another boot (in a container, another run): the pid and its start can both come again.
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
