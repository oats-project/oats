import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { selfIdentity } from "../lib/worktree-hooks.mjs";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const base = realpathSync(mkdtempSync(join(tmpdir(), "oats-schedule-caps-")));
const bin = fileURLToPath(new URL("../bin/oats.mjs", import.meta.url));
const scheduleModule = new URL("../lib/schedule.mjs", import.meta.url).href;
const S = await import("../lib/schedule.mjs");
for (const key of ["OATS_INSTANCE", "OATS_INSTANCE_HOME", "PI_AGENTS_ROOT"]) delete process.env[key];
let serial = 0;
test.beforeEach(() => { process.env.OATS_HOME_DIR = join(base, `host-${++serial}`); });
test.after(() => rmSync(base, { recursive: true, force: true }));
const registryPath = () => join(S.hostScheduleDir(), "registry.json");
const diskRegistry = () => JSON.parse(readFileSync(registryPath(), "utf8"));
function seedRegistry(extra = {}) {
  mkdirSync(S.hostScheduleDir(), { recursive: true });
  writeFileSync(registryPath(), JSON.stringify({ version: 1, tickIntervalSec: 120, workspaces: [], ...extra }) + "\n");
}
/** The line the write that persists the migration of a legacy `maxConcurrent: 1` puts on stderr. */
const MIGRATED = "oats: warning: migrated legacy maxConcurrent: 1 to the default of 5; an old explicit 1 cannot be distinguished from the old implicit default. To restore one slot, run oats schedule host install --max-concurrent 1 --dir <deployment>. Stop older oats binaries from writing this shared registry.\n";
/** What `fn` writes on this process's stderr. */
function stderrOf(fn) {
  const write = process.stderr.write;
  let written = "";
  process.stderr.write = (chunk) => { written += String(chunk); return true; };
  try { fn(); } finally { process.stderr.write = write; }
  return written;
}
function workspace() {
  const ws = join(base, `ws-${++serial}`);
  mkdirSync(join(ws, "agents", "dev", "soul"), { recursive: true });
  writeFileSync(join(ws, "oats-local.yaml"), "schemaVersion: 2\nworkspace: example.invalid/acme/workspace\n");
  writeFileSync(join(ws, "agents", "dev", "soul", "soul.yaml"), "name: dev\nwork: worktree\nharness: claude\n");
  writeFileSync(join(ws, "agents", "dev", "soul", "AGENTS.md"), "# Developer\n");
  return ws;
}
function child(source, args = []) {
  const proc = spawn(process.execPath, ["--input-type=module", "-e", `import * as S from ${JSON.stringify(scheduleModule)}; ${source}`, ...args], {
    env: { ...process.env }, stdio: ["ignore", "pipe", "pipe", "ipc"], timeout: 6000, killSignal: "SIGKILL",
  });
  let stderr = "";
  proc.stderr.on("data", (data) => { stderr += data; });
  const ready = new Promise((resolve, reject) => {
    proc.once("message", resolve);
    proc.once("error", reject);
    proc.once("exit", () => reject(new Error(`child exited before ready: ${stderr}`)));
  });
  const done = new Promise((resolve, reject) => {
    proc.once("error", reject);
    proc.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exit ${code}: ${stderr}`)));
  });
  // Attach a rejection handler immediately; callers await completion after coordinating readiness.
  done.catch(() => {});
  return { proc, ready, done };
}

test("fresh registry leaves the default absent while status reports five and no trigger cap", () => {
  assert.equal(Object.hasOwn(S.readRegistry(), "maxConcurrent"), false);
  assert.equal(existsSync(registryPath()), false, "reading fresh defaults does not persist a registry");
  const ws = workspace();
  S.registerWorkspace(ws);
  assert.equal(Object.hasOwn(diskRegistry(), "maxConcurrent"), false);
  assert.equal(Object.hasOwn(diskRegistry(), "triggersMaxConcurrent"), false);
  assert.equal(diskRegistry().capsVersion, 2);
  const status = S.schedulerStatus(ws);
  assert.equal(status.maxConcurrent, 5);
  assert.equal(status.triggersMaxConcurrent, null);
  assert.equal(status.registered, true);
});

test("legacy one migrates once, preserving registry data and a later deliberate one", () => {
  const ws = workspace();
  seedRegistry({ maxConcurrent: 1, triggersMaxConcurrent: 3, workspaces: [ws], extension: { keep: true } });
  const before = readFileSync(registryPath(), "utf8");
  const migrated = S.readRegistry();
  assert.equal(readFileSync(registryPath(), "utf8"), before, "reads only project migration");
  // Even unchanged membership must persist migration, and the write that does says so.
  assert.equal(stderrOf(() => S.registerWorkspace(ws)), MIGRATED);
  assert.equal(Object.hasOwn(migrated, "maxConcurrent"), false);
  assert.deepEqual(diskRegistry(), { version: 1, capsVersion: 2, tickIntervalSec: 120, triggersMaxConcurrent: 3, workspaces: [ws], extension: { keep: true } });
  assert.equal(S.schedulerStatus(ws).maxConcurrent, 5);
  const later = stderrOf(() => {
    S.registerWorkspace(ws, { maxConcurrent: 1 });
    assert.equal(S.readRegistry().maxConcurrent, 1);
    S.registerWorkspace(ws);
  });
  assert.equal(later, "", "said once: a deliberate one is not a legacy one");
  assert.equal(diskRegistry().maxConcurrent, 1);
  assert.equal(S.schedulerStatus(ws).maxConcurrent, 1);
});

test("migration keeps other explicit caps and does not materialize an absent default", () => {
  for (const extra of [{}, { maxConcurrent: 5 }, { maxConcurrent: 9 }]) {
    seedRegistry({ ...extra, triggersMaxConcurrent: 2 });
    S.registerWorkspace(workspace());
    const reg = diskRegistry();
    assert.equal(reg.maxConcurrent, extra.maxConcurrent);
    assert.equal(Object.hasOwn(reg, "maxConcurrent"), Object.hasOwn(extra, "maxConcurrent"));
    assert.equal(reg.triggersMaxConcurrent, 2);
    assert.equal(reg.capsVersion, 2);
  }
});

test("registration preserves omitted choices, updates existing workspaces, and resets caps independently", () => {
  const a = workspace(), b = workspace();
  S.registerWorkspace(a, { maxConcurrent: 8, triggersMaxConcurrent: 4 });
  S.registerWorkspace(a, { maxConcurrent: 1 });
  S.registerWorkspace(b);
  assert.deepEqual(diskRegistry().workspaces, [a, b]);
  assert.equal(diskRegistry().maxConcurrent, 1);
  assert.equal(diskRegistry().triggersMaxConcurrent, 4);
  S.registerWorkspace(a, { maxConcurrent: "default" });
  assert.equal(Object.hasOwn(diskRegistry(), "maxConcurrent"), false);
  assert.equal(diskRegistry().triggersMaxConcurrent, 4);
  S.registerWorkspace(a, { maxConcurrent: 2, triggersMaxConcurrent: "none" });
  assert.equal(diskRegistry().maxConcurrent, 2);
  assert.equal(Object.hasOwn(diskRegistry(), "triggersMaxConcurrent"), false);
  S.registerWorkspace(a, { maxConcurrent: "default", triggersMaxConcurrent: "none" });
  S.registerWorkspace(a);
  const status = S.schedulerStatus(a);
  assert.equal(status.maxConcurrent, 5);
  assert.equal(status.triggersMaxConcurrent, null);
  assert.deepEqual(diskRegistry().workspaces, [a, b]);
});

test("invalid cap options fail before migration, registration, or either cap changes", () => {
  const ws = workspace();
  for (const options of [
    { maxConcurrent: 0 }, { maxConcurrent: -1 }, { maxConcurrent: 1.5 }, { maxConcurrent: NaN },
    { maxConcurrent: Infinity }, { maxConcurrent: Number.MAX_SAFE_INTEGER + 1 }, { maxConcurrent: null },
    { maxConcurrent: "none" }, { triggersMaxConcurrent: "default" }, { triggersMaxConcurrent: 0 },
    { triggersMaxConcurrent: 1.5 }, { triggersMaxConcurrent: Number.MAX_SAFE_INTEGER + 1 },
    { maxConcurrent: 7, triggersMaxConcurrent: -1 }, { maxConcurrent: false, triggersMaxConcurrent: 3 },
  ]) {
    seedRegistry({ maxConcurrent: 1, triggersMaxConcurrent: 2 });
    const before = readFileSync(registryPath(), "utf8");
    assert.throws(() => S.registerWorkspace(ws, options), (e) => e.code === "E_BAD_ARGS", JSON.stringify(options));
    assert.equal(readFileSync(registryPath(), "utf8"), before, "bad options must not even migrate the registry");
  }
  rmSync(S.hostScheduleDir(), { recursive: true, force: true });
  assert.throws(() => S.registerWorkspace(ws, { triggersMaxConcurrent: 0 }), (e) => e.code === "E_BAD_ARGS");
  assert.equal(existsSync(S.hostScheduleDir()), false, "invalid options do not create scheduler storage");
});

test("migration waits for the registry lock and reads the winner's current values", async (t) => {
  seedRegistry({ maxConcurrent: 1 });
  const lock = join(S.hostScheduleDir(), "registry.lock");
  writeFileSync(lock, JSON.stringify({ ...selfIdentity(), nonce: "a".repeat(32), at: new Date().toISOString(), what: "a test" }) + "\n");
  const reader = child('process.send("ready"); const reg = S.registerWorkspace(process.argv[1]); if (reg.maxConcurrent !== 7 || reg.triggersMaxConcurrent !== 2) process.exitCode = 1; process.disconnect();', [workspace()]);
  t.after(() => { reader.proc.kill(); rmSync(lock, { recursive: true, force: true }); });
  await reader.ready;
  await delay(100);
  assert.equal(reader.proc.exitCode, null, "migration must wait while another process owns registry.lock");
  assert.equal(diskRegistry().maxConcurrent, 1);
  seedRegistry({ capsVersion: 2, maxConcurrent: 7, triggersMaxConcurrent: 2 });
  rmSync(lock, { recursive: true, force: true });
  await reader.done;
  assert.equal(diskRegistry().maxConcurrent, 7);
  assert.equal(diskRegistry().triggersMaxConcurrent, 2);
});

test("concurrent process registrations retain every workspace and an explicit cap update", async (t) => {
  seedRegistry({ maxConcurrent: 1 });
  const scopes = Array.from({ length: 6 }, workspace);
  const children = scopes.map((ws, i) => child(`
    process.once("message", async () => {
      S.registerWorkspace(process.argv[1], ${i === 0 ? '{ maxConcurrent: 1, triggersMaxConcurrent: 3 }' : '{}'});
      process.disconnect();
    });
    process.send("ready");`, [ws]));
  t.after(() => children.forEach(({ proc }) => proc.kill()));
  await Promise.all(children.map(({ ready }) => ready));
  children.forEach(({ proc }) => proc.send("go"));
  await Promise.all(children.map(({ done }) => done));
  const reg = diskRegistry();
  assert.deepEqual([...reg.workspaces].sort(), [...scopes].sort());
  assert.equal(reg.maxConcurrent, 1, "subsequent registration must not migrate the deliberate one again");
  assert.equal(reg.triggersMaxConcurrent, 3);
  assert.equal(reg.capsVersion, 2);
});

function addSpawnJobs(ws, count) {
  for (let i = 0; i < count; i++) S.addSchedule(ws, { id: `job-${i}`, cron: "* * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "Check the queue." });
}
function spawnIO() {
  return {
    inspect: () => ({ present: true, state: "unknown" }),
    spawn: (root, agent, opts) => {
      const instance = `${agent.name}-${opts.purpose}`, home = join(root, agent.name, "instances", instance);
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "instance.json"), JSON.stringify({ instance, home, agent: agent.name }));
      return { instance, home, launched: true };
    },
  };
}

test("a real default tick admits five live scheduled jobs across workspaces and run-now shares that cap", () => {
  const a = workspace(), b = workspace(), io = spawnIO();
  addSpawnJobs(a, 3); addSpawnJobs(b, 3);
  S.registerWorkspace(a); S.registerWorkspace(b);
  const now = new Date("2026-09-07T10:00:00Z");
  const result = S.tickHost({ now, io });
  assert.equal(result.considered.filter((row) => row.action === "launched").length, 5);
  assert.equal(result.considered.filter((row) => row.reason === "host busy").length, 1);
  assert.equal(result.scheduler.maxConcurrent, 5);
  assert.equal(S.schedulerStatus(a).live, 5);
  assert.throws(() => S.runNow(b, "job-2", { io, now }), (e) => e.code === "E_SCHEDULER_BUSY");
  assert.equal(Object.hasOwn(diskRegistry(), "maxConcurrent"), false);
});

function isolatedCLI() {
  const root = join(base, `cli-${++serial}`), stubDir = join(root, "bin"), home = join(root, "home"), serviceLog = join(root, "service-calls");
  mkdirSync(stubDir, { recursive: true }); mkdirSync(home, { recursive: true });
  for (const name of ["launchctl", "systemctl"]) {
    const stub = join(stubDir, name);
    writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "$0 $*" >> "$OATS_TEST_SERVICE_LOG"\ncase "$*" in\n  print*|*is-active*) exit 1;;\nesac\nexit 0\n');
    chmodSync(stub, 0o755);
  }
  const env = { ...process.env, HOME: home, OATS_HOME_DIR: join(root, "oats-home"), XDG_CONFIG_HOME: join(root, "config"), PATH: `${stubDir}:${dirname(process.execPath)}`, OATS_TEST_SERVICE_LOG: serviceLog };
  const path = join(env.OATS_HOME_DIR, "schedules", "registry.json");
  return {
    env, serviceLog, path,
    run: (ws, ...args) => {
      const result = spawnSync(process.execPath, [bin, "schedule", "host", "install", ...args, "--dir", ws, "--json"], { env, encoding: "utf8" });
      assert.equal(result.error, undefined);
      const output = JSON.parse(result.stdout.trim());
      return { ...result, output };
    },
  };
}

test("CLI host install updates and resets both caps with inert host services", { skip: !["darwin", "linux"].includes(process.platform) }, () => {
  const cli = isolatedCLI(), ws = workspace();
  let result = cli.run(ws, "--max-concurrent", "1", "--triggers-max-concurrent", "3");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output.result.scheduler.maxConcurrent, 1);
  assert.equal(result.output.result.scheduler.triggersMaxConcurrent, 3);
  assert.ok(existsSync(cli.serviceLog), "the inert service manager handled the install");
  const reg = () => JSON.parse(readFileSync(cli.path, "utf8"));
  assert.equal(reg().maxConcurrent, 1); assert.equal(reg().triggersMaxConcurrent, 3);
  result = cli.run(ws);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output.result.scheduler.maxConcurrent, 1);
  assert.equal(result.output.result.scheduler.triggersMaxConcurrent, 3);
  result = cli.run(ws, "--max-concurrent=2", "--triggers-max-concurrent=4");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output.result.scheduler.maxConcurrent, 2);
  assert.equal(result.output.result.scheduler.triggersMaxConcurrent, 4);
  result = cli.run(ws, "--max-concurrent", "default", "--triggers-max-concurrent", "none");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output.result.scheduler.maxConcurrent, 5);
  assert.equal(result.output.result.scheduler.triggersMaxConcurrent, null);
  assert.equal(Object.hasOwn(reg(), "maxConcurrent"), false);
  assert.equal(Object.hasOwn(reg(), "triggersMaxConcurrent"), false);
  assert.deepEqual(reg().workspaces, [ws]);
});

test("CLI rejects invalid and missing cap values before migration or host service actions", () => {
  const cli = isolatedCLI(), ws = workspace();
  mkdirSync(dirname(cli.path), { recursive: true });
  const before = JSON.stringify({ version: 1, maxConcurrent: 1, triggersMaxConcurrent: 2, workspaces: [] });
  writeFileSync(cli.path, before);
  for (const args of [
    ["--max-concurrent", "0"], ["--max-concurrent", "-1"], ["--max-concurrent", "1.5"],
    ["--max-concurrent", "Infinity"], ["--max-concurrent", "9007199254740992"],
    ["--max-concurrent", "none"], ["--max-concurrent"],
    ["--max-concurrent=0"], ["--triggers-max-concurrent=invalid"],
    ["--max-concurrent", "2", "--max-concurrent", "3"],
    ["--triggers-max-concurrent", "default"], ["--triggers-max-concurrent", "0"],
    ["--triggers-max-concurrent"], ["--max-concurrent", "8", "--triggers-max-concurrent", "nope"],
  ]) {
    const result = cli.run(ws, ...args);
    assert.notEqual(result.status, 0, args.join(" "));
    assert.equal(result.output.error.code, "E_BAD_ARGS", args.join(" "));
    assert.equal(readFileSync(cli.path, "utf8"), before);
    assert.equal(existsSync(cli.serviceLog), false, "bad arguments must not contact the service manager");
  }
});


test("unregister persists legacy migration even when membership is unchanged", () => {
  const ws = workspace();
  seedRegistry({ maxConcurrent: 1, triggersMaxConcurrent: 2 });
  assert.equal(stderrOf(() => S.unregisterWorkspace(ws)), MIGRATED);
  assert.equal(diskRegistry().capsVersion, 2);
  assert.equal(Object.hasOwn(diskRegistry(), "maxConcurrent"), false);
  assert.equal(diskRegistry().triggersMaxConcurrent, 2);
});

test("persisted legacy-one migration warns once on stderr and preserves JSON stdout", () => {
  const cli = isolatedCLI(), ws = workspace();
  mkdirSync(dirname(cli.path), { recursive: true });
  writeFileSync(cli.path, JSON.stringify({ version: 1, maxConcurrent: 1, workspaces: [ws] }));
  let result = cli.run(ws);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output.result.scheduler.maxConcurrent, 5);
  assert.match(result.stderr, /legacy.*maxConcurrent.*1/i);
  assert.match(result.stderr, /oats schedule host install --max-concurrent 1/);
  result = cli.run(ws);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /legacy.*maxConcurrent/i);
  result = cli.run(ws, "--max-concurrent", "1");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output.result.scheduler.maxConcurrent, 1);
});

test("invalid stored schedule caps refuse unchanged and explicit CLI correction repairs under lock", () => {
  const cli = isolatedCLI(), ws = workspace();
  mkdirSync(dirname(cli.path), { recursive: true });
  for (const repair of ["3", "default"]) {
    const before = JSON.stringify({ version: 1, capsVersion: 2, maxConcurrent: "broken", triggersMaxConcurrent: 2, workspaces: [ws] });
    writeFileSync(cli.path, before);
    let result = cli.run(ws);
    assert.notEqual(result.status, 0);
    assert.equal(result.output.error.code, "E_SCHEDULE_INVALID");
    assert.match(result.output.error.message, /maxConcurrent/);
    assert.match(result.output.error.message, /--max-concurrent/);
    assert.equal(readFileSync(cli.path, "utf8"), before);
    result = cli.run(ws, "--max-concurrent", repair);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output.result.scheduler.maxConcurrent, repair === "default" ? 5 : 3);
    assert.equal(result.output.result.scheduler.triggersMaxConcurrent, 2);
  }
});
