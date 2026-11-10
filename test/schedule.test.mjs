import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deploymentsImported } from "./helpers/host-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, "..", "bin", "oats.mjs");
// short, and its OATS_HOME_DIR is <base>/h: that holds ssh's control socket (ssh/<40 hex>), which ssh needs
// within 86 bytes, under the root run's directory of the file (docs/implementation.md, fixtures)
const base = realpathSync(mkdtempSync(join(tmpdir(), "o-sc-")));
process.env.OATS_HOME_DIR = deploymentsImported(join(base, "h"));
delete process.env.OATS_INSTANCE; delete process.env.OATS_INSTANCE_HOME; delete process.env.PI_AGENTS_ROOT;
const S = await import("../lib/schedule.mjs");
const H = await import("../lib/schedule-host.mjs");
const A = await import("../lib/automations.mjs");
const { scheduleRemote } = await import("../lib/servers.mjs");
const { selfIdentity } = await import("../lib/worktree-hooks.mjs");
test.after(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
// Every scope is a deployment: the directory holding oats-local.yaml.
const LOCAL = "schemaVersion: 2\nworkspace: example.invalid/acme/workspace\n";
function workspace() {
  const ws = join(base, `ws-${++n}`);
  mkdirSync(join(ws, "agents", "dev", "soul"), { recursive: true });
  writeFileSync(join(ws, "agents", "dev", "soul", "soul.yaml"), "name: dev\nwork: worktree\nharness: claude\n");
  writeFileSync(join(ws, "agents", "dev", "soul", "AGENTS.md"), "# Developer\n");
  writeFileSync(join(ws, "oats-local.yaml"), LOCAL);
  return ws;
}
function home(ws, name) { const h = join(ws, "agents", "dev", "instances", name); mkdirSync(h, { recursive: true }); writeFileSync(join(h, "instance.json"), JSON.stringify({ instance: name, home: h, agent: "dev", createdAt: "2026-01-01T00:00:00.000Z" })); return h; }
const at = (iso) => new Date(iso);
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// A fake launcher: creates a home like spawn would and records the call.
function fakeSpawn(ws, calls = []) {
  return (root, agent, opts) => { calls.push(opts); const name = `${agent.name}-${opts.purpose}`; const h = home(ws, name); return { instance: name, home: h, launched: true }; };
}

// A fake oats binary: logs each argv (one JSON line) and answers `spawn … --preview` with `preview`
// (an object is printed as JSON, a string as is); a spawn without --preview creates the home it names.
function fakeOats(ws, preview) {
  const file = join(base, `fake-oats-${++n}.mjs`), log = `${file}.log`;
  writeFileSync(file, `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"; import { join } from "node:path";
const argv = process.argv.slice(2); appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + "\\n");
if (argv.includes("--preview")) process.stdout.write(${JSON.stringify(typeof preview === "string" ? preview : JSON.stringify(preview))});
else { const name = argv[1] + "-" + argv.find((a) => a.startsWith("--purpose=")).slice(10), h = join(${JSON.stringify(ws)}, "agents", "dev", "instances", name);
  mkdirSync(h, { recursive: true }); writeFileSync(join(h, "instance.json"), JSON.stringify({ instance: name, home: h, agent: argv[1], createdAt: "2026-01-01T00:00:00.000Z" }));
  process.stdout.write(JSON.stringify({ ok: true, result: { instance: name, home: h, launched: false } })); }\n`);
  return { bin: file, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []) };
}

test("definitions are validated field by field, with croner and IANA zones", () => {
  const ws = workspace();
  const bad = (spec, field) => assert.throws(() => S.validateDefinition(ws, spec), (e) => e.code === "E_SCHEDULE_INVALID" && e.field === field, `${field}`);
  bad({ id: "Bad Id", cron: "* * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "t" }, "id");
  bad({ id: "a", cron: "* * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "t" }, "cron");
  bad({ id: "a", cron: "* * * * *", tz: "Mars/Olympus", kind: "spawn", agent: "dev", task: "t" }, "tz");
  bad({ id: "a", cron: "* * * * *", kind: "spawn", agent: "dev", task: "t" }, "tz");
  { const unknown = fakeOats(ws, { ok: false, error: { code: "E_SOUL_UNKNOWN", message: "no soul nobody" } }).bin;
    assert.throws(() => S.validateDefinition(ws, { id: "a", cron: "* * * * *", tz: "UTC", kind: "spawn", agent: "nobody", task: "t" }, { io: { oatsBin: unknown } }), (e) => e.code === "E_SCHEDULE_INVALID" && e.field === "agent", "agent"); }
  bad({ id: "a", cron: "* * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "" }, "task");
  bad({ id: "a", cron: "* * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "t", harness: "bash" }, "harness");
  bad({ id: "a", cron: "* * * * *", tz: "UTC", kind: "command", cwd: "/etc", argv: ["oats", "status"] }, "cwd");
  bad({ id: "a", cron: "* * * * *", tz: "UTC", kind: "command", cwd: ws, argv: ["sh", "-c", "x"] }, "argv");
  bad({ id: "a", cron: "* * * * *", tz: "UTC", kind: "wake", home: join(base, "elsewhere"), message: "hi" }, "home");
  bad({ id: "a", cron: "* * * * *", tz: "UTC", kind: "wake", home: home(ws, "dev-x"), message: "" }, "message");
  bad({ id: "a", cron: "* * * * *", tz: "UTC", kind: "other" }, "kind");
  // Runs are named <agent>-<purpose|id>-<YYYYMMDDHHMM>, and instance names are at most 64 characters.
  const long = (spec, field) => assert.throws(() => S.validateDefinition(ws, spec, { checkAgent: false }), (e) => e.code === "E_SCHEDULE_INVALID" && e.field === field && /at most 64 characters/.test(e.message), `${field} (64-char cap)`);
  long({ id: "a", cron: "* * * * *", tz: "UTC", kind: "spawn", agent: "a".repeat(20), purpose: "p".repeat(40), task: "t" }, "purpose");
  long({ id: "i".repeat(40), cron: "* * * * *", tz: "UTC", kind: "spawn", agent: "a".repeat(20), task: "t" }, "id");
  assert.equal(S.validateDefinition(ws, { id: "a", cron: "* * * * *", tz: "UTC", kind: "spawn", agent: "a".repeat(10), purpose: "p".repeat(40), task: "t" }, { checkAgent: false }).purpose, "p".repeat(40), "10 + 1 + 40 + 1 + 12 = 64 fits");
  const ok = S.validateDefinition(ws, { id: "nightly", cron: " 0 3 * * * ", tz: "Europe/Madrid", kind: "spawn", agent: "dev", task: "do it", yolo: true, backend: "tmux" });
  assert.deepEqual(ok, { id: "nightly", enabled: true, cron: "0 3 * * *", tz: "Europe/Madrid", kind: "spawn", agent: "dev", task: "do it", yolo: true, backend: "tmux" });
});

test("schedule IDs accept 100 characters through storage and execution, while spawn names stay bounded", () => {
  const ws = workspace(), id = "a".repeat(100);
  const command = { id, cron: "* * * * *", tz: "UTC", kind: "command", cwd: ws, argv: ["oats", "status"] };
  assert.equal(S.addSchedule(ws, command).id, id);
  assert.equal(S.describe(ws, id).id, id);
  assert.equal(S.describe(ws, `local/${id}`).id, id);
  S.updateSchedule(ws, id, { ...command, cron: "0 * * * *" });
  assert.equal(S.describe(ws, id).cron, "0 * * * *");
  const result = S.runNow(ws, id, { now: at("2026-09-07T10:00:00Z"), io: { command: () => ({ ok: true, result: {} }) } });
  assert.equal(result.schedule.id, id);
  S.removeSchedule(ws, id);
  assert.throws(() => S.validateDefinition(ws, { ...command, id: "a".repeat(101) }), (e) => e.code === "E_SCHEDULE_INVALID" && e.field === "id");
  const spawn = { id, kind: "spawn", agent: "dev", task: "t", cron: "* * * * *", tz: "UTC" };
  assert.throws(() => S.validateDefinition(ws, spawn), (e) => e.field === "id" && /at most 64/.test(e.message));
  assert.equal(S.validateDefinition(ws, { ...spawn, purpose: "short" }).id, id);
});

test("automatic wake IDs retain distinct long instance names", () => {
  const ws = workspace(), prefix = "dev-" + "x".repeat(50);
  const wake = { cron: "* * * * *", tz: "UTC", message: "check" };
  for (const suffix of ["a", "b"]) {
    const instance = prefix + suffix, h = home(ws, instance);
    const saved = S.saveWakeForHome(ws, { instance, home: h, wake });
    assert.equal(saved.id, `wake-${instance}`);
    assert.deepEqual(S.removeWakeForHome(ws, h), [`wake-${instance}`]);
  }
});

test("a description is optional, one line of 1 to 200 characters without control characters, and stored as given", () => {
  const ws = workspace();
  const job = { id: "a", cron: "* * * * *", tz: "UTC", kind: "command", cwd: ws, argv: ["oats", "status"] };
  for (const description of [7, null, "", "x".repeat(201), "a\nb", "a\rb", "a\tb", "a\0b", "a\x1bb", "a\x7fb", "a\u0085b", "a b", "a b"]) {
    assert.throws(() => S.validateDefinition(ws, { ...job, description }), (e) => e.code === "E_SCHEDULE_INVALID" && e.field === "description" && /description/.test(e.message), JSON.stringify(description));
  }
  assert.equal(S.validateDefinition(ws, { ...job, description: "x".repeat(200) }).description, "x".repeat(200));
  assert.equal(S.validateDefinition(ws, { ...job, description: "🙂".repeat(200) }).description, "🙂".repeat(200), "characters, not UTF-16 units");
  assert.equal(S.validateDefinition(ws, { ...job, description: "  Harvest — soul dev  " }).description, "  Harvest — soul dev  ", "stored as given");
  assert.equal("description" in S.validateDefinition(ws, job), false, "absent stays absent");
  S.addSchedule(ws, { ...job, id: "labelled", description: "Knowledge harvest for dev-1 (soul dev)" });
  S.addSchedule(ws, { ...job, id: "plain" });
  const rows = Object.fromEntries(S.listSchedules(ws).schedules.map((r) => [r.id, r]));
  assert.equal(rows.labelled.description, "Knowledge harvest for dev-1 (soul dev)");
  assert.equal(rows.plain.description, null);
  assert.equal(S.describe(ws, "labelled").description, "Knowledge harvest for dev-1 (soul dev)");
  assert.equal(S.updateSchedule(ws, "labelled", { ...job, description: "Renamed" }).description, "Renamed");
  assert.equal(S.updateSchedule(ws, "labelled", job).description, null, "an update without one drops it");
});

test("a description is informational: it never reaches argv, the spawn options, the launch or the run record", () => {
  const runOf = (description) => {
    const ws = workspace();
    const src = home(ws, "dev-src");
    const cmds = [], spawns = [];
    const io = { command: (c) => { cmds.push(c); return { ok: true, result: {} }; }, spawn: (root, agent, opts) => { spawns.push({ agent: agent.name, opts }); return fakeSpawn(ws)(root, agent, opts); }, inspect: () => ({ present: true, state: "unknown" }) };
    const extra = description === undefined ? {} : { description };
    S.addSchedule(ws, { id: "cmd", cron: "0 * * * *", tz: "UTC", kind: "command", cwd: src, argv: ["oats", "okf", "harvest"], ...extra });
    S.addSchedule(ws, { id: "nightly", cron: "0 * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "t", ...extra });
    const considered = S.tickWorkspace(ws, { now: at("2026-09-07T10:00:00Z"), io, reg: { ...S.readRegistry(), maxConcurrent: 5 } });
    const st = S.readState(ws);
    const strip = (v) => JSON.parse(JSON.stringify(v).replaceAll(ws, "<ws>").replace(/"(startedAt|wallClock|lastLaunchedAt|at|runId|recordedAt)":"[^"]*"/g, `"$1":"<t>"`));
    return strip({ cmds, spawns, considered, state: st });
  };
  assert.deepEqual(runOf("Knowledge harvest for dev-1 (soul dev)"), runOf(undefined));
});

test("cron evaluation follows the zone through DST and is due exactly on the minute", () => {
  const def = { cron: "0 3 * * *", tz: "Europe/Madrid" };
  // 2026-03-29: Madrid springs forward at 02:00 -> 03:00 local; 03:00 local is 01:00Z.
  assert.equal(S.nextRunAfter(def, at("2026-03-28T12:00:00Z")), "2026-03-29T01:00:00.000Z");
  assert.equal(S.nextRunAfter(def, at("2026-03-29T12:00:00Z")), "2026-03-30T01:00:00.000Z");
  // 2026-10-25: falls back at 03:00 -> 02:00; 03:00 local is 02:00Z.
  assert.equal(S.nextRunAfter(def, at("2026-10-24T12:00:00Z")), "2026-10-25T02:00:00.000Z");
  assert.equal(S.dueAt(def, at("2026-03-29T01:00:00Z")), true);
  assert.equal(S.dueAt(def, at("2026-03-29T01:01:00Z")), false);
  assert.equal(S.dueAt({ cron: "*/5 * * * *", tz: "UTC" }, at("2026-09-07T10:05:00Z")), true);
  assert.equal(S.dueAt({ cron: "*/5 * * * *", tz: "UTC" }, at("2026-09-07T10:06:00Z")), false);
  assert.equal(S.minuteKey(S.minuteStart(at("2026-09-07T10:05:42Z"))), "2026-09-07T10:05");
});

test("a local spawn job names its soul as oats spawn does: add and update ask spawn's preview, and runs launch it through spawn", () => {
  const ws = workspace(), root = join(ws, "agents"), clone = join(ws, "elsewhere", "clone");
  const job = { id: "rev", cron: "*/5 * * * *", tz: "UTC", kind: "spawn", agent: "reviewer", task: "Review.", harness: "pi", model: "m1", launchConfig: "fast", backend: "tmux", repo: clone };
  // The selectors the run passes, so the preview checks what the run's spawn will.
  const selectors = ["--launch-config=fast", "--harness=pi", "--model=m1", "--backend=tmux", `--repo=${clone}`];
  const invalid = (agent, message) => (e) => e.code === "E_SCHEDULE_INVALID" && e.field === "agent" && (typeof message === "string" ? e.message === message : message.test(e.message));
  // A soul the workspace offers, never spawned here (no agents/reviewer/soul): spawn's preview resolves it.
  const offered = fakeOats(ws, { ok: true, result: { agent: "reviewer" } });
  assert.equal(existsSync(join(root, "reviewer")), false);
  assert.equal(S.addSchedule(ws, job, { oatsBin: offered.bin }).soul.name, "reviewer");
  assert.deepEqual(offered.calls(), [["spawn", "reviewer", `--dir=${ws}`, `--agents-root=${root}`, "--preview", "--json", ...selectors]]);
  // A name spawn refuses is refused with spawn's own message, its code in details.
  const unknown = fakeOats(ws, { ok: false, error: { code: "E_SOUL_UNKNOWN", message: "soul \"ghost\" is not offered by this workspace" } });
  assert.throws(() => S.addSchedule(ws, { ...job, id: "ghost", agent: "ghost" }, { oatsBin: unknown.bin }), (e) => invalid("ghost", "agent: soul \"ghost\" is not offered by this workspace")(e) && e.details?.code === "E_SOUL_UNKNOWN");
  // An answer that is no envelope confirms nothing: refused, saying why.
  const silent = fakeOats(ws, "resolving…\n");
  assert.throws(() => S.addSchedule(ws, { ...job, id: "mute", agent: "mute" }, { oatsBin: silent.bin }), invalid("mute", /^agent: soul "mute" could not be confirmed: the spawn preview answered no valid envelope/));
  // An option-shaped name is refused before any child runs.
  assert.throws(() => S.addSchedule(ws, { ...job, id: "opt", agent: "--yolo" }, { oatsBin: unknown.bin }), (e) => e.code === "E_SCHEDULE_INVALID" && e.field === "agent");
  assert.equal(unknown.calls().length, 1, "only the ghost add ran the preview");
  // The fast path: a soul under agents/<soul>/soul is accepted as before, without the child.
  assert.equal(S.addSchedule(ws, { ...job, id: "local", agent: "dev" }, { oatsBin: unknown.bin }).soul.name, "dev");
  assert.equal(unknown.calls().length, 1, "the fast path runs no preview");
  // update keeps the same check.
  assert.throws(() => S.updateSchedule(ws, "local", { ...job, agent: "ghost" }, { oatsBin: unknown.bin }), invalid("ghost", "agent: soul \"ghost\" is not offered by this workspace"));
  assert.equal(S.describe(ws, "local").agent, "dev", "a refused update changes nothing");
  assert.equal(S.updateSchedule(ws, "local", { ...job, agent: "reviewer" }, { oatsBin: offered.bin }).agent, "reviewer");
  assert.equal(offered.calls().length, 2);
  // schedule test reports the soul as resolving, through the same preview.
  const t = S.testSchedule(ws, "rev", { oatsBin: offered.bin }, { now: at("2026-09-07T10:01:00Z") });
  assert.equal(t.soul.resolves, true); assert.equal(t.soul.error, null);
  assert.deepEqual(offered.calls()[2], ["spawn", "reviewer", `--dir=${ws}`, `--agents-root=${root}`, "--preview", "--json", ...selectors]);
  assert.equal(S.testSchedule(ws, "rev", { oatsBin: unknown.bin }).soul.error.code, "E_SOUL_UNKNOWN");
  S.removeSchedule(ws, "local");
  // A due minute launches it: the tick runs no preview, it hands the soul to spawn.
  const tick = fakeOats(ws, { ok: false, error: { code: "E_SOUL_UNKNOWN", message: "a tick must not run a preview" } });
  const calls = [];
  const io = { oatsBin: tick.bin, spawn: fakeSpawn(ws, calls), inspect: () => ({ present: true, state: "unknown" }) };
  const c = S.tickWorkspace(ws, { now: at("2026-09-07T10:05:00Z"), io, reg: { maxConcurrent: 4 } });
  assert.equal(c.find((x) => x.id === "rev").action, "launched");
  assert.equal(calls.length, 1); assert.equal(tick.calls().length, 0);
  // run-now launches it through the kernel's own `oats spawn`, still under the deployment's agents root.
  rmSync(S.describe(ws, "rev", io).lastRun.home, { recursive: true, force: true });
  const r = S.runNow(ws, "rev", { now: at("2026-09-07T10:07:00Z"), io: { oatsBin: tick.bin, noLaunch: true, inspect: io.inspect } });
  assert.equal(r.schedule.lastRun.outcome, "launched");
  const [spawned] = tick.calls();
  assert.deepEqual(spawned.slice(0, 11), ["spawn", "reviewer", `--dir=${ws}`, `--agents-root=${root}`, "--purpose=rev-202609071007", "--json", ...selectors]);
  assert.equal(spawned.includes("--preview"), false);
  assert.equal(existsSync(join(root, "reviewer")), false, "nothing needed agents/reviewer/soul");
});

test("reconcile proves a lost spawn receipt launched nothing only where spawn names the run <agent>-<purpose>", () => {
  const ws = workspace();
  const io = { inspect: () => ({ present: true, state: "unknown" }) };
  // A spawn whose receipt is lost: it may have made the home (named after the soul's stem, as spawn names it).
  const lost = (stem) => ({ ...io, spawn: (root, agent, opts) => { if (stem) home(ws, `${stem}-${opts.purpose}`); throw Object.assign(new Error("workspace spawn timed out; its effects could not be confirmed (a home may have been created)"), { code: "E_SPAWN_UNCONFIRMED" }); } });
  const offered = fakeOats(ws, { ok: true, result: { agent: "dev" } }).bin;
  const unknownAfterTick = (id, agent, stem, minute) => {
    S.addSchedule(ws, { id, cron: "0 * * * *", tz: "UTC", kind: "spawn", agent, task: "t" }, { oatsBin: offered });
    const c = S.tickWorkspace(ws, { now: at(minute), io: lost(stem), reg: { maxConcurrent: 8 } });
    assert.equal(c.find((x) => x.id === id).action, "unknown", id);
    assert.ok(S.describe(ws, id, io).attempt, `${id}: the attempt is retained`);
  };
  // A qualified name: spawn names the run dev-…, not ws/dev-…; the receipt's absence proves nothing.
  unknownAfterTick("qual", "ws/dev", "dev", "2026-09-07T10:00:00Z");
  let r = S.reconcile(ws, "qual", { io });
  assert.equal(r.reconciled, "unknown"); assert.match(r.remedy, /cannot be proven[\s\S]*reconcile qual --clear/);
  let d = S.describe(ws, "qual", io);
  assert.ok(d.attempt, "the attempt is kept"); assert.equal(d.running, true, "and the slot"); assert.equal(d.lastRun.outcome, "unknown");
  r = S.reconcile(ws, "qual", { io, clear: true });
  assert.equal(r.reconciled, "cleared"); assert.equal(r.schedule.lastRun.outcome, "launch-failed"); assert.equal(r.schedule.running, false);
  // A package soul homes at <package>--<soul> and its runs are <package>-<soul>-…: unproven as well, even spawned here.
  mkdirSync(join(ws, "agents", "acme--keeper", "soul"), { recursive: true });
  writeFileSync(join(ws, "agents", "acme--keeper", "soul", "soul.yaml"), "name: keeper\nwork: worktree\nharness: claude\n");
  unknownAfterTick("pkg", "acme--keeper", null, "2026-09-07T11:00:00Z");
  assert.equal(S.reconcile(ws, "pkg", { io }).reconciled, "unknown");
  // A bare name of a member soul under agents/: its runs are named dev-<purpose>, so no such home proves nothing launched.
  unknownAfterTick("plain", "dev", null, "2026-09-07T12:00:00Z");
  r = S.reconcile(ws, "plain", { io });
  assert.equal(r.reconciled, "cleared"); assert.equal(r.schedule.lastRun.outcome, "launch-failed"); assert.equal(r.schedule.running, false);
  // And its home, when there is one, is adopted by that name.
  unknownAfterTick("found", "dev", "dev", "2026-09-07T13:00:00Z");
  r = S.reconcile(ws, "found", { io });
  assert.equal(r.reconciled, "adopted"); assert.equal(r.schedule.lastRun.instance, "dev-found-202609071300");
});

test("a local spawn job's soul is refused at add when the deployment's oats-local.yaml cannot be read", () => {
  const ws = workspace();
  writeFileSync(join(ws, "oats-local.yaml"), "schemaVersion: [\n");
  const offered = fakeOats(ws, { ok: true, result: { agent: "reviewer" } });
  assert.throws(() => S.addSchedule(ws, { id: "rev", cron: "* * * * *", tz: "UTC", kind: "spawn", agent: "reviewer", task: "t" }, { oatsBin: offered.bin }), (e) => e.code !== "E_SCHEDULE_INVALID" && /oats-local\.yaml|schema/i.test(e.message));
  assert.equal(offered.calls().length, 0);
});

test("a due spawn job launches once, holds its lock while the instance lives, and skips missed minutes", () => {
  const ws = workspace();
  const calls = [];
  const io = { spawn: fakeSpawn(ws, calls), inspect: () => ({ present: true, state: "unknown" }) };
  S.addSchedule(ws, { id: "five", cron: "*/5 * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "Check the queue." });
  const reg = S.readRegistry();
  let c = S.tickWorkspace(ws, { now: at("2026-09-07T10:05:10Z"), io, reg });
  assert.equal(c[0].action, "launched");
  assert.equal(calls.length, 1);
  assert.match(calls[0].purpose, /^five-202609071005$/);
  assert.match(calls[0].task, /Scheduled run[\s\S]*oats retire --self/);
  const d = S.describe(ws, "five", io);
  assert.equal(d.running, true);
  assert.equal(d.lastRun.outcome, "launched");
  assert.equal(readJson(join(ws, ".agents", "schedules", "state.json")).jobs.five.lastAttemptedMinute, "2026-09-07T10:05");
  // Same minute again: nothing (already attempted). Next due minute: still running.
  assert.deepEqual(S.tickWorkspace(ws, { now: at("2026-09-07T10:05:50Z"), io, reg }), []);
  c = S.tickWorkspace(ws, { now: at("2026-09-07T10:10:00Z"), io, reg });
  assert.equal(c[0].action, "skipped"); assert.equal(c[0].reason, "still running");
  assert.equal(S.describe(ws, "five", io).lastRun.outcome, "active");
  // The instance retires (home gone): ended, lock released; a jump of three hours launches ONCE.
  rmSync(d.lastRun.home, { recursive: true, force: true });
  c = S.tickWorkspace(ws, { now: at("2026-09-07T13:15:00Z"), io, reg });
  assert.equal(c[0].action, "launched");
  assert.equal(calls.length, 2);
  assert.equal(readJson(join(ws, ".agents", "schedules", "state.json")).jobs.five.lastAttemptedMinute, "2026-09-07T13:15");
  const runs = S.describe(ws, "five", io);
  assert.equal(runs.lastRun.scheduledFor, "2026-09-07T13:15:00.000Z");
});

test("a spawn job whose instance stopped keeps its slot and is skipped with what to do, in a tick and a dry run (#921)", () => {
  const ws = workspace();
  let seen = { present: true, state: "unknown" };
  const io = { spawn: fakeSpawn(ws), inspect: () => seen };
  S.addSchedule(ws, { id: "five", cron: "*/5 * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "t" });
  const reg = S.readRegistry();
  assert.equal(S.tickWorkspace(ws, { now: at("2026-09-07T10:05:00Z"), io, reg })[0].action, "launched");
  const { instance, home: h } = S.readState(ws).jobs.five.lastRun;
  seen = { present: false, state: "stopped" };
  const reason = `previous instance stopped: retire it (oats retire ${instance}) or start it again (oats session start --home ${h})`;
  const dry = S.tickWorkspace(ws, { now: at("2026-09-07T10:10:00Z"), io, reg, dryRun: true });
  assert.deepEqual([dry[0].action, dry[0].reason], ["skipped", reason]);
  const c = S.tickWorkspace(ws, { now: at("2026-09-07T10:10:00Z"), io, reg });
  assert.deepEqual([c[0].action, c[0].reason], ["skipped", reason]);
  assert.equal(S.readState(ws).jobs.five.lastRun.outcome, "stopped");
  assert.ok(S.jobLockInfo(ws, "five"), "a stopped instance keeps the job's slot");
  assert.throws(() => S.runNow(ws, "five", { io, now: at("2026-09-07T10:11:00Z") }), (e) => e.code === "E_SCHEDULE_RUNNING" && e.message === `schedule five: ${reason}`);
  // Started again: active, and skipped as still running.
  seen = { present: true, state: "unknown" };
  const again = S.tickWorkspace(ws, { now: at("2026-09-07T10:15:00Z"), io, reg });
  assert.deepEqual([again[0].action, again[0].reason], ["skipped", "still running"]);
  assert.equal(S.readState(ws).jobs.five.lastRun.outcome, "active");
  assert.throws(() => S.runNow(ws, "five", { io, now: at("2026-09-07T10:16:00Z") }), (e) => e.code === "E_SCHEDULE_RUNNING" && e.message === "schedule five is still running");
});

test("a home whose session cannot be inspected for a reason other than a lost tmux server stays unknown and still running (#921)", () => {
  const ws = workspace();
  let inspect = () => ({ present: true, state: "unknown" });
  const io = { spawn: fakeSpawn(ws), inspect: (h) => inspect(h) };
  S.addSchedule(ws, { id: "five", cron: "*/5 * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "t" });
  const reg = S.readRegistry();
  S.tickWorkspace(ws, { now: at("2026-09-07T10:05:00Z"), io, reg });
  inspect = () => { throw Object.assign(new Error("cannot read session receipt: unreadable"), { code: "E_RUNTIME_ENDPOINT_UNKNOWN" }); };
  const c = S.tickWorkspace(ws, { now: at("2026-09-07T10:10:00Z"), io, reg });
  assert.deepEqual([c[0].action, c[0].reason], ["skipped", "still running"]);
  const lr = S.readState(ws).jobs.five.lastRun;
  assert.equal(lr.outcome, "unknown");
  assert.match(lr.error, /cannot read session receipt/);
});

test("host concurrency bounds launches across jobs and run-now shares the same lock", (t) => {
  const ws = workspace();
  const before = S.readRegistry();
  t.after(() => S.writeRegistry(before));
  S.registerWorkspace(ws, { maxConcurrent: 1 });
  const io = { spawn: fakeSpawn(ws), inspect: () => ({ present: true, state: "unknown" }) };
  S.addSchedule(ws, { id: "a", cron: "* * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "a" });
  S.addSchedule(ws, { id: "b", cron: "* * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "b" });
  const c = S.tickWorkspace(ws, { now: at("2026-09-07T11:00:00Z"), io, reg: S.readRegistry() });
  assert.deepEqual(c.map((x) => [x.id, x.action, x.reason]), [["a", "launched", undefined], ["b", "skipped", "host busy"]]);
  assert.equal(readJson(join(ws, ".agents", "schedules", "state.json")).jobs.b.lastAttemptedMinute, "2026-09-07T11:00", "busy skips still persist the attempted minute");
  assert.throws(() => S.runNow(ws, "b", { io, now: at("2026-09-07T11:00:30Z") }), (e) => e.code === "E_SCHEDULER_BUSY");
  assert.throws(() => S.runNow(ws, "a", { io }), (e) => e.code === "E_SCHEDULE_RUNNING");
  S.setEnabled(ws, "b", false);
  assert.throws(() => S.runNow(ws, "b", { io }), (e) => e.code === "E_SCHEDULE_DISABLED");
  assert.throws(() => S.removeSchedule(ws, "a"), (e) => e.code === "E_SCHEDULE_RUNNING");
  assert.deepEqual(S.removeSchedule(ws, "a", { force: true }), { removed: "a" });
  assert.equal(S.jobLockInfo(ws, "a"), null);
  const r = S.runNow(ws, "b", { io, force: true, now: at("2026-09-07T11:07:00Z") });
  assert.equal(r.run.outcome, "launched");
});

test("an attempt without a recorded result is exposed as unknown and resolved by reconcile", () => {
  const ws = workspace();
  const io = { spawn: fakeSpawn(ws), inspect: () => ({ present: false, state: "shell" }) };
  S.addSchedule(ws, { id: "crashy", cron: "* * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "t" });
  // Simulate a crash between the attempt record and the run record.
  const st = S.readState(ws); st.jobs.crashy = { attempt: { scheduledFor: "2026-09-07T12:00:00.000Z", startedAt: "2026-09-07T12:00:01.000Z" } }; S.writeState(ws, st);
  const c = S.tickWorkspace(ws, { now: at("2026-09-07T12:01:00Z"), io, reg: S.readRegistry() });
  assert.equal(c[0].action, "skipped"); assert.match(c[0].reason, /reconcile/);
  assert.equal(S.describe(ws, "crashy", io).lastRun.outcome, "unknown");
  assert.throws(() => S.runNow(ws, "crashy", { io }), (e) => e.code === "E_SCHEDULE_UNRESOLVED");
  // No instance exists for it: cleared as launch-failed.
  let r = S.reconcile(ws, "crashy", { io });
  assert.equal(r.reconciled, "cleared"); assert.equal(r.schedule.lastRun.outcome, "launch-failed");
  // An instance DOES exist for the attempt: adopted, observed stopped, lock held.
  const st2 = S.readState(ws); st2.jobs.crashy = { attempt: { scheduledFor: "2026-09-07T12:30:00.000Z" } }; S.writeState(ws, st2);
  home(ws, "dev-crashy-202609071230");
  r = S.reconcile(ws, "crashy", { io });
  assert.equal(r.reconciled, "adopted"); assert.equal(r.schedule.lastRun.outcome, "stopped"); assert.equal(r.schedule.running, true);
});

test("a wake job starts a stopped home, delivers once when active, and skips what it cannot observe", () => {
  const ws = workspace();
  const h = home(ws, "dev-standing");
  const started = [], inputs = [];
  let state = { present: false, state: "shell" };
  const io = { inspect: () => { if (state instanceof Error) throw state; return state; }, start: (hh) => { started.push(hh); return { instance: "dev-standing", target: { backend: "tmux" } }; }, input: (hh, text) => { inputs.push([hh, text]); return { submitted: true }; } };
  S.addSchedule(ws, { id: "nudge", cron: "*/15 * * * *", tz: "UTC", kind: "wake", home: h, message: "Check your inbox and pending chats." });
  const reg = S.readRegistry();
  let c = S.tickWorkspace(ws, { now: at("2026-09-07T09:15:00Z"), io, reg });
  assert.equal(c[0].action, "started"); assert.deepEqual(started, [h]); assert.equal(inputs.length, 0);
  assert.ok(S.jobLockInfo(ws, "nudge"), "a wake that started a harness holds the job lock (a launch slot) until that home ends");
  assert.deepEqual(S.describe(ws, "nudge", io).pendingWake, { scheduledFor: "2026-09-07T09:15:00.000Z" }, "the started wake keeps ONE pending delivery");
  // Still stopped on the next (non-due) tick: no restart between due minutes, still pending.
  c = S.tickWorkspace(ws, { now: at("2026-09-07T09:16:00Z"), io, reg });
  assert.equal(c[0].action, "skipped"); assert.equal(c[0].pending, true); assert.equal(inputs.length, 0); assert.equal(started.length, 1);
  // Active on a later non-due tick: the pending message is delivered once, independent of the cron.
  state = { present: true, state: "unknown" };
  c = S.tickWorkspace(ws, { now: at("2026-09-07T09:17:00Z"), io, reg });
  assert.equal(c[0].action, "delivered"); assert.deepEqual(inputs, [[h, "Check your inbox and pending chats."]]);
  assert.equal(S.describe(ws, "nudge", io).pendingWake, undefined);
  assert.deepEqual(S.tickWorkspace(ws, { now: at("2026-09-07T09:18:00Z"), io, reg }), [], "nothing pending, nothing due");
  c = S.tickWorkspace(ws, { now: at("2026-09-07T09:30:00Z"), io, reg });
  assert.equal(c[0].action, "delivered"); assert.equal(inputs.length, 2);
  assert.deepEqual(S.tickWorkspace(ws, { now: at("2026-09-07T09:30:40Z"), io, reg }), [], "never twice in one minute");
  // A due minute while a delivery is pending adds nothing: one pending, one delivery.
  state = { present: false, state: "shell" };
  c = S.tickWorkspace(ws, { now: at("2026-09-07T09:45:00Z"), io, reg }); assert.equal(c[0].action, "started"); assert.equal(started.length, 2);
  c = S.tickWorkspace(ws, { now: at("2026-09-07T09:50:00Z"), io, reg }); assert.equal(c[0].action, "skipped"); assert.equal(started.length, 2, "no restart between due minutes");
  c = S.tickWorkspace(ws, { now: at("2026-09-07T10:00:00Z"), io, reg }); assert.equal(c[0].action, "started"); assert.equal(started.length, 3, "started again only at the due minute");
  state = { present: true, state: "unknown" };
  c = S.tickWorkspace(ws, { now: at("2026-09-07T10:01:00Z"), io, reg }); assert.equal(c[0].action, "delivered"); assert.equal(inputs.length, 3);
  assert.deepEqual(S.tickWorkspace(ws, { now: at("2026-09-07T10:02:00Z"), io, reg }), []);
  state = new Error("socket unavailable");
  c = S.tickWorkspace(ws, { now: at("2026-09-07T10:15:00Z"), io, reg });
  assert.equal(c[0].action, "skipped"); assert.match(c[0].reason, /cannot observe/); assert.equal(c[0].pending, true);
  rmSync(h, { recursive: true, force: true });
  c = S.tickWorkspace(ws, { now: at("2026-09-07T10:16:00Z"), io, reg });
  assert.deepEqual(c, [], "the observation pass handles a gone home: nothing pending, nothing due");
  assert.equal(S.describe(ws, "nudge", io).pendingWake, undefined, "a gone home drops the pending delivery");
  assert.equal(S.jobLockInfo(ws, "nudge"), null, "the slot is released when the started home is gone");
  c = S.tickWorkspace(ws, { now: at("2026-09-07T10:30:00Z"), io, reg });
  assert.equal(c[0].action, "skipped"); assert.match(c[0].reason, /gone/);
  assert.equal(inputs.length, 3);
});

test("agentsRoot, when given, must be the deployment's one agents root; repo stays the work repository", () => {
  const ws = workspace();
  const root = join(ws, "agents");
  assert.equal(S.resolveScheduledAgent(ws, { agent: "dev" }).root, root);
  const other = join(ws, "member", "agents");
  mkdirSync(join(other, "dev", "soul"), { recursive: true });
  assert.throws(() => S.resolveScheduledAgent(ws, { agent: "dev", agentsRoot: other }), (e) => e.code === "E_SCHEDULE_INVALID" && e.field === "agentsRoot");
  assert.throws(() => S.validateDefinition(ws, { id: "x", cron: "* * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "t", agentsRoot: other }), (e) => e.code === "E_SCHEDULE_INVALID" && e.field === "agentsRoot");
  assert.throws(() => S.validateDefinition(ws, { id: "x", cron: "* * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "t", agentsRoot: join(base, "outside") }), (e) => e.code === "E_SCHEDULE_INVALID" && e.field === "agentsRoot");
  const calls = [];
  const io = { spawn: (r, agent, opts) => { calls.push({ root: r, agent: agent.name, repo: opts.repo }); return { instance: `dev-${opts.purpose}`, home: home(ws, `dev-${opts.purpose}`), launched: true }; }, inspect: () => ({ present: true, state: "unknown" }) };
  S.addSchedule(ws, { id: "rooted", cron: "* * * * *", tz: "UTC", kind: "spawn", agent: "dev", agentsRoot: root, repo: "/some/work/repo", task: "t" });
  S.tickWorkspace(ws, { now: at("2026-09-07T14:00:00Z"), io, reg: S.readRegistry() });
  assert.deepEqual(calls, [{ root, agent: "dev", repo: "/some/work/repo" }], "launched from the deployment root with repo passed as the work repository");
});

test("a command job runs an oats-only argv in its cwd and tracks the instance the envelope names", () => {
  const ws = workspace();
  const src = home(ws, "dev-source");
  const harvester = home(ws, "dev-harvester-1");
  const cmds = [];
  const io = { command: (c) => { cmds.push(c); return { ok: true, result: { harvest: "spawned", instance: "dev-harvester-1" } }; }, inspect: () => ({ present: true, state: "unknown" }) };
  S.addSchedule(ws, { id: "harvest", cron: "0 * * * *", tz: "UTC", kind: "command", cwd: src, argv: ["oats", "okf", "harvest"] });
  const c = S.tickWorkspace(ws, { now: at("2026-09-07T10:00:00Z"), io, reg: S.readRegistry() });
  assert.equal(c[0].action, "launched"); assert.equal(c[0].instance, "dev-harvester-1");
  assert.deepEqual(cmds[0], { cwd: src, argv: ["okf", "harvest", "--json"] });
  const d = S.describe(ws, "harvest", io);
  assert.equal(d.lastRun.home, harvester, "home resolved from the workspace roster");
  assert.equal(d.running, true, "command return is not completion: the harvester is tracked");
  const io2 = { command: () => ({ ok: false, error: { code: "E_X", message: "nope" } }) };
  S.addSchedule(ws, { id: "broken", cron: "0 * * * *", tz: "UTC", kind: "command", cwd: src, argv: ["oats", "status"] });
  rmSync(harvester, { recursive: true, force: true });
  const c2 = S.tickWorkspace(ws, { now: at("2026-09-07T11:00:00Z"), io: { ...io2, inspect: io.inspect }, reg: S.readRegistry() });
  const broken = c2.find((x) => x.id === "broken");
  assert.equal(broken.action, "launch-failed"); assert.equal(broken.error, "nope");
  assert.equal(S.jobLockInfo(ws, "broken"), null);
});

test("a wake that starts its session records the start's warnings; the delivery after it keeps none (schedule-run-warnings)", () => {
  const ws = workspace();
  const h = home(ws, "dev-warned");
  const warning = "the OATS tmux server was started inside oats-schedule-tick.service: it ends when that unit stops; start the OATS tmux server from your own shell, or enable the user systemd bus (no executable systemd-run in /usr/bin, /bin)";
  let state = { present: false, state: "shell" };
  const io = { inspect: () => state, start: () => ({ instance: "dev-warned", target: { backend: "tmux" }, warnings: [warning] }), input: () => ({ submitted: true }) };
  S.addSchedule(ws, { id: "warned", cron: "*/15 * * * *", tz: "UTC", kind: "wake", home: h, message: "hello" });
  const reg = S.readRegistry();
  assert.equal(S.tickWorkspace(ws, { now: at("2026-09-07T09:15:00Z"), io, reg })[0].action, "started");
  assert.deepEqual(S.describe(ws, "warned", io).lastRun.warnings, [warning]);
  state = { present: true, state: "unknown" };
  assert.equal(S.tickWorkspace(ws, { now: at("2026-09-07T09:16:00Z"), io, reg })[0].action, "delivered");
  assert.equal("warnings" in S.describe(ws, "warned", io).lastRun, false, "the delivery is a later run: the start's warnings are not its own");
  // A start with nothing to say records no warnings at all.
  const quiet = { ...io, start: () => ({ instance: "dev-warned", target: { backend: "tmux" }, warnings: [] }) };
  state = { present: false, state: "shell" };
  assert.equal(S.tickWorkspace(ws, { now: at("2026-09-07T09:30:00Z"), io: quiet, reg })[0].action, "started");
  assert.equal("warnings" in S.describe(ws, "warned", quiet).lastRun, false);
  rmSync(h, { recursive: true, force: true });
});

test("wake-at-spawn helpers: flags translate to one object, save binds to the home, retirement forgets it", () => {
  const ws = workspace();
  const h = home(ws, "dev-worker");
  const w = S.wakeFromFlags({ every: "15", message: "Anything new?" });
  assert.equal(w.cron, "*/15 * * * *"); assert.ok(w.tz); assert.equal(w.enabled, true);
  assert.throws(() => S.wakeFromFlags({ every: "0", message: "x" }), (e) => e.code === "E_SCHEDULE_INVALID");
  assert.throws(() => S.wakeFromFlags({ every: "5", cron: "* * * * *", message: "x" }), (e) => e.code === "E_SCHEDULE_INVALID");
  assert.throws(() => S.wakeFromFlags({ every: "5" }), (e) => e.code === "E_SCHEDULE_INVALID");
  const saved = S.saveWakeForHome(ws, { instance: "dev-worker", home: h, wake: { cron: "*/10 * * * *", tz: "UTC", message: "ping" } });
  assert.equal(saved.id, "wake-dev-worker"); assert.equal(saved.kind, "wake"); assert.equal(saved.home, h);
  assert.throws(() => S.saveWakeForHome(ws, { instance: "dev-worker", home: h, wake: { cron: "*/10 * * * *", tz: "UTC", message: "ping" } }), (e) => e.code === "E_SCHEDULE_EXISTS");
  assert.deepEqual(S.removeWakeForHome(ws, h), ["wake-dev-worker"]);
  assert.equal(S.readDefinitions(ws).jobs["wake-dev-worker"], undefined);
});

test("the CLI answers the envelope for add, list, show, update, enable, disable, tick --dry-run, remove and host status", () => {
  const ws = workspace();
  // The host unit is looked for under HOME (~/Library/LaunchAgents, $XDG_CONFIG_HOME/systemd/user):
  // the fixture's own, where none is installed, never the operator's. Whether it is active is still
  // asked of the host's service manager (launchctl print, systemctl --user): a read, which can answer
  // true on a host with the unit loaded, so only its type is asserted.
  const hostHome = join(base, "host-home");
  mkdirSync(hostHome, { recursive: true });
  const env = { ...process.env, OATS_HOME_DIR: process.env.OATS_HOME_DIR, HOME: hostHome, XDG_CONFIG_HOME: join(hostHome, ".config") };
  const run = (...a) => { const r = execFileSync(process.execPath, [bin, "schedule", ...a, "--dir", ws, "--json"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }); return JSON.parse(r.trim().split("\n").pop()); };
  const spec = join(base, "spec.json");
  writeFileSync(spec, JSON.stringify({ id: "nightly", cron: "0 3 * * *", tz: "Europe/Madrid", kind: "spawn", agent: "dev", task: "Nightly sweep.", harness: "claude", yolo: true, description: "Sweeps the release branch every night" }));
  let out = run("add", "nightly", "--file", spec);
  assert.equal(out.ok, true); assert.equal(out.result.schedule.id, "nightly"); assert.ok(out.result.schedule.nextRun);
  assert.equal(out.result.schedule.description, "Sweeps the release branch every night");
  assert.match(execFileSync(process.execPath, [bin, "schedule", "show", "nightly", "--dir", ws], { encoding: "utf8", env }), /"description": "Sweeps the release branch every night"/, "human show prints it");
  out = run("list");
  assert.equal(out.result.schedules[0].description, "Sweeps the release branch every night");
  assert.deepEqual(Object.keys(out.result), ["scope", "scheduleApi", "scheduleHistoryApi", "integrity", "host", "schedules", "triggers", "snapshot", "scheduler"]); // K8b: scope echo + integrity; 0.28: the triggers pointer; 0.29: host + the workspace snapshot
  assert.equal(out.result.schedules[0].id, "nightly");
  for (const k of ["installed", "active", "lastTick", "maxConcurrent"]) assert.ok(k in out.result.scheduler, k);
  assert.equal(out.result.scheduler.installed, false);
  out = run("show", "nightly"); assert.equal(out.result.schedule.task, "Nightly sweep.");
  writeFileSync(spec, JSON.stringify({ cron: "30 3 * * *", tz: "Europe/Madrid", kind: "spawn", agent: "dev", task: "Nightly sweep, later." }));
  out = run("update", "nightly", "--file", spec); assert.equal(out.result.schedule.cron, "30 3 * * *");
  out = run("disable", "nightly"); assert.equal(out.result.schedule.enabled, false); assert.equal(out.result.schedule.nextRun, null);
  out = run("enable", "nightly"); assert.equal(out.result.schedule.enabled, true);
  writeFileSync(spec, JSON.stringify({ id: "every", cron: "* * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "t" }));
  run("add", "every", "--file", spec);
  out = run("tick", "--dry-run");
  assert.deepEqual(out.result.considered.map((c) => [c.id, c.action]), [["every", "due"]], "dry run launches nothing");
  assert.equal(existsSync(join(ws, "agents", "dev", "instances")), false);
  out = run("remove", "every"); assert.deepEqual(out.result, { removed: "every" });
  out = run("host", "status"); assert.equal(typeof out.result.scheduler.active, "boolean");
  let failed;
  try { execFileSync(process.execPath, [bin, "schedule", "show", "nope", "--dir", ws, "--json"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { failed = e; }
  assert.ok(failed, "an unknown id exits non-zero");
  assert.equal(JSON.parse(String(failed.stdout).trim()).error.code, "E_SCHEDULE_UNKNOWN");
  const probe = JSON.parse(execFileSync(process.execPath, [bin, "version", "--json"], { encoding: "utf8" }));
  assert.equal(probe.scheduleApi, 2); assert.ok(probe.features.includes("schedule")); assert.ok(probe.features.includes("schedule-host-caps")); assert.ok(probe.remote.includes("schedule"));
});

test("host units render the single tick and status reports what the OS says", () => {
  const plist = H.renderLaunchdPlist({ node: "/usr/local/bin/node", oatsBin: "/opt/oats/bin/oats.mjs", oatsHomeDir: "/home/x/.oats" });
  assert.match(plist, /<string>ai\.oats\.schedule-tick<\/string>/);
  assert.match(plist, /<string>schedule<\/string>\s*<string>tick<\/string>\s*<string>--host<\/string>\s*<string>--json<\/string>/);
  assert.match(plist, /<key>StartCalendarInterval<\/key><dict\/>/); assert.match(plist, /OATS_HOME_DIR/);
  assert.match(plist, /<key>PATH<\/key><string>\/usr\/local\/bin:/, "the unit carries an explicit PATH starting with the node's dir");
  const units = H.renderSystemdUnits({ node: "/usr/bin/node", oatsBin: "/opt/oats/bin/oats.mjs" });
  assert.match(units.service, /ExecStart="\/usr\/bin\/node" "\/opt\/oats\/bin\/oats\.mjs" schedule tick --host --json/);
  assert.match(units.service, /Environment="PATH=/);
  assert.equal(H.systemdQuote("/opt/my apps/100%/oats"), '"/opt/my apps/100%%/oats"');
  assert.match(units.timer, /^OnCalendar=\*-\*-\* \*:\*:00$/m);
  const exec = (b, argv) => { if (argv[0] === "print" || argv[1] === "is-active") throw Object.assign(new Error("not loaded"), { status: 113 }); return ""; };
  const st = H.hostUnitStatus({ exec, os: "darwin" });
  assert.equal(st.active, false, "a unit file alone is never active");
  const lin = H.hostUnitStatus({ exec, os: "linux" });
  assert.equal(lin.installed, false); assert.equal(lin.active, false);
  assert.equal(H.hostUnitStatus({ os: "win32" }).kind, "unsupported");
  // Idempotent install: an active identical unit is left untouched (no
  // bootout). Unit paths are injected: the real LaunchAgents dir is never touched.
  const unitDir = join(base, "launch-agents");
  const plistPath = H.hostUnitPaths("darwin", { unitDir }).plist;
  assert.equal(dirname(plistPath), unitDir);
  const calls = [];
  const activeExec = (b, argv) => { calls.push(argv.join(" ")); return ""; };
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(plistPath, H.renderLaunchdPlist());
  const st2 = H.installHostUnit({ exec: activeExec, os: "darwin", unitDir });
  assert.equal(st2.active, true);
  assert.equal(calls.some((c) => c.startsWith("bootout") || c.startsWith("bootstrap")), false, "identical active unit: no bootout, no bootstrap");
  // A changed unit (here one that fires on an interval) is replaced through bootout + bootstrap, in the fixture dir.
  writeFileSync(plistPath, H.renderLaunchdPlist().replace("<key>StartCalendarInterval</key><dict/>", "<key>StartInterval</key><integer>60</integer>"));
  H.installHostUnit({ exec: activeExec, os: "darwin", unitDir });
  assert.ok(calls.some((c) => c.startsWith("bootout")) && calls.some((c) => c.startsWith("bootstrap")));
  assert.equal(readFileSync(plistPath, "utf8"), H.renderLaunchdPlist());
});

test("remote schedules route to the server workspace only when the host advertises the feature", () => {
  const oatsHome = process.env.OATS_HOME_DIR; mkdirSync(oatsHome, { recursive: true });
  writeFileSync(join(oatsHome, "servers.json"), JSON.stringify({ servers: { s: { sshHost: "h", workspace: "/w" } } }));
  const calls = [];
  const io = (features, scheduleApi) => ({ execFileSync: (b, argv) => { const a = argv.join(" "); calls.push(a); if (a.includes("version --json")) return JSON.stringify({ schemaVersion: 1, ok: true, result: { desktopApi: 1, version: "0.22.10", remote: ["session"], features, scheduleApi } }); return JSON.stringify({ schemaVersion: 1, ok: true, result: { schedules: [], scheduler: { installed: false, active: false, lastTick: null, maxConcurrent: 1 } } }); } });
  assert.throws(() => scheduleRemote("s", ["list"], io(["retire-home"])), (e) => e.code === "E_REMOTE_INCOMPATIBLE" && /schedules/.test(e.message));
  assert.equal(calls.filter((c) => c.includes("schedule list")).length, 0, "refused before any remote schedule command");
  const out = scheduleRemote("s", ["add", "x", "--spec-json", "{}"], io(["retire-home", "schedule"]));
  assert.equal(out.envelope.ok, true); assert.equal(out.envelope.result.server, "s");
  assert.match(calls.find((c) => c.includes("schedule add")), /schedule add x --spec-json .*\{\}.* --dir \/w --json/);
  const captured = ["add", "pinned", "--spec-json", JSON.stringify({ definitionVersion: 2, recurrencePolicy: "capture" })];
  const before = calls.filter(c => c.includes("schedule add pinned")).length;
  // Captured (versioned) schedules were removed in 0.26: refused whatever the host advertises, never forwarded.
  for (const api of [1, 2]) assert.throws(() => scheduleRemote("s", captured, io(["schedule"], api)), (e) => e.code === "E_SCHEDULE_INVALID" && /definitionVersion, recurrencePolicy: captured schedules are refused \(the captured\/portable path was removed in 0\.26\)/.test(e.message));
  assert.equal(calls.filter(c => c.includes("schedule add pinned")).length, before, "no host receives a captured mutation");
});

test("remote host cap options require explicit support before forwarding, including resets and equals forms", () => {
  const server = { sshHost: "caps-host", workspace: "/remote/workspace" };
  const result = { scheduler: { maxConcurrent: 7, triggersMaxConcurrent: null } };
  const peer = (features) => {
    const mutations = [];
    return { mutations, server, execFileSync: (_bin, argv) => {
      const command = argv.at(-1);
      if (command.includes("version --json")) return JSON.stringify({ schemaVersion: 1, desktopApi: 1, version: "0.39.4", features });
      mutations.push(command);
      return JSON.stringify({ schemaVersion: 1, ok: true, result });
    } };
  };
  const options = [
    ["--max-concurrent", "2"], ["--max-concurrent", "default"],
    ["--triggers-max-concurrent", "3"], ["--triggers-max-concurrent", "none"],
    ["--max-concurrent=2"], ["--max-concurrent=default"],
    ["--triggers-max-concurrent=3"], ["--triggers-max-concurrent=none"],
    ["--max-concurrent", "1", "--triggers-max-concurrent", "none"],
  ];
  for (const flags of options) {
    for (const features of [undefined, [], ["schedule"], ["schedule", "future-feature"]]) {
      const io = peer(features);
      assert.throws(() => scheduleRemote("caps", ["host", "install", ...flags], io), (e) =>
        e.code === "E_REMOTE_INCOMPATIBLE" && /caps-host/.test(e.message) && /upgrade/i.test(e.message)
        && (!features?.includes("schedule") || /schedule-host-caps/.test(e.message)), flags.join(" "));
      assert.deepEqual(io.mutations, [], "no install reaches an unsupported peer");
    }
    const io = peer(["schedule", "schedule-host-caps"]);
    const out = scheduleRemote("caps", ["host", "install", ...flags], io);
    assert.deepEqual(out.envelope.result, { ...result, server: "caps" });
    assert.deepEqual(io.mutations, [`oats schedule host install ${flags.join(" ")} --dir /remote/workspace --json`]);
  }
  const old = peer(["schedule"]);
  assert.equal(scheduleRemote("caps", ["host", "install"], old).envelope.ok, true);
  assert.equal(old.mutations.length, 1, "old peer still installs when no cap change is requested");
  const capsOnly = peer(["schedule-host-caps"]);
  assert.throws(() => scheduleRemote("caps", ["host", "install", "--max-concurrent", "default"], capsOnly), (e) => e.code === "E_REMOTE_INCOMPATIBLE");
  assert.deepEqual(capsOnly.mutations, [], "the schedule feature remains required too");
});

test("remote cap installs give actionable compatibility errors for unknown probes without masking transport errors", () => {
  const server = { sshHost: "caps-host", workspace: "/remote/workspace" };
  const unknown = { schemaVersion: 1, desktopApi: 2, version: "0.40.0", features: ["schedule"] };
  for (const [payload, originalCode] of [
    [JSON.stringify(unknown), "E_REMOTE_ENVELOPE"],
    [JSON.stringify({ schemaVersion: 1, ok: true, result: unknown }), "E_REMOTE_INCOMPATIBLE"],
    ["not JSON", "E_REMOTE_ENVELOPE"],
  ]) {
    for (const options of [["--max-concurrent", "default"], ["--triggers-max-concurrent=none"]]) {
      const calls = [];
      const io = { server, execFileSync: (_bin, argv) => { calls.push(argv.at(-1)); return payload; } };
      assert.throws(() => scheduleRemote("caps", ["host", "install", ...options], io), (e) =>
        e.code === "E_REMOTE_INCOMPATIBLE" && /caps-host/.test(e.message) && /schedule-host-caps/.test(e.message) && /upgrade/i.test(e.message));
      assert.deepEqual(calls, ["oats version --json"]);
      calls.length = 0;
      assert.throws(() => scheduleRemote("caps", ["host", "install"], io), (e) => e.code === originalCode, "no-cap probe refusals retain their original contract");
      assert.deepEqual(calls, ["oats version --json"]);
    }
  }
  const calls = [];
  const io = { server, execFileSync: (_bin, argv) => {
    calls.push(argv.at(-1));
    throw Object.assign(new Error("offline"), { status: 255, stderr: "connection refused" });
  } };
  assert.throws(() => scheduleRemote("caps", ["host", "install", "--max-concurrent=1"], io), (e) => e.code === "E_SSH" && /connection refused/.test(e.message));
  assert.deepEqual(calls, ["oats version --json"]);
});

test("a cold wake needs a launch slot; a delivery to a running home does not; a started harness keeps its slot until the home ends", () => {
  const ws = workspace();
  const h1 = home(ws, "dev-one"), h2 = home(ws, "dev-two"), h3 = home(ws, "dev-running");
  const states = { [h1]: { present: false, state: "shell" }, [h2]: { present: false, state: "shell" }, [h3]: { present: true, state: "unknown" } };
  const started = [], inputs = [];
  const io = { inspect: (h) => states[h], start: (h) => { started.push(h); return { instance: "x" }; }, input: (h, t) => { inputs.push([h, t]); return { submitted: true }; }, spawn: fakeSpawn(ws) };
  S.addSchedule(ws, { id: "one", cron: "* * * * *", tz: "UTC", kind: "wake", home: h1, message: "m1" });
  S.addSchedule(ws, { id: "two", cron: "* * * * *", tz: "UTC", kind: "wake", home: h2, message: "m2" });
  S.addSchedule(ws, { id: "run", cron: "* * * * *", tz: "UTC", kind: "wake", home: h3, message: "m3" });
  const reg = { ...S.readRegistry(), maxConcurrent: 1 };
  let c = S.tickWorkspace(ws, { now: at("2026-09-07T15:00:00Z"), io, reg });
  const by = Object.fromEntries(c.map((x) => [x.id, x]));
  assert.equal(by.one.action, "started"); assert.equal(by.two.action, "skipped"); assert.match(by.two.reason, /host busy/); assert.equal(by.two.pending, true);
  assert.equal(by.run.action, "delivered", "a running home receives its message without a slot");
  assert.equal(started.length, 1); assert.deepEqual(S.describe(ws, "two", io).pendingWake, { scheduledFor: "2026-09-07T15:00:00.000Z" });
  // one becomes active: its pending message is delivered on the next tick and it still holds the slot.
  states[h1] = { present: true, state: "unknown" };
  c = S.tickWorkspace(ws, { now: at("2026-09-07T15:01:00Z"), io, reg });
  const by2 = Object.fromEntries(c.map((x) => [x.id, x]));
  assert.equal(by2.one.action, "delivered"); assert.equal(by2.two.action, "skipped"); assert.match(by2.two.reason, /host busy/);
  assert.ok(S.jobLockInfo(ws, "one")); assert.equal(started.length, 1);
  // one's home ends: the slot frees; two starts at the next due minute.
  rmSync(h1, { recursive: true, force: true });
  c = S.tickWorkspace(ws, { now: at("2026-09-07T15:02:00Z"), io, reg });
  const by3 = Object.fromEntries(c.map((x) => [x.id, x]));
  assert.equal(by3.two.action, "started"); assert.equal(started.length, 2); assert.equal(S.jobLockInfo(ws, "one"), null);
});

test("a running wake delivers beside a long scheduled spawn that holds the only slot", () => {
  const ws = workspace();
  const h = home(ws, "dev-live");
  const inputs = [];
  const io = { spawn: fakeSpawn(ws), inspect: () => ({ present: true, state: "unknown" }), input: (hh, t) => { inputs.push(t); return { submitted: true }; } };
  S.addSchedule(ws, { id: "long", cron: "* * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "long" });
  S.addSchedule(ws, { id: "ping", cron: "* * * * *", tz: "UTC", kind: "wake", home: h, message: "ping" });
  const reg = { ...S.readRegistry(), maxConcurrent: 1 };
  let c = S.tickWorkspace(ws, { now: at("2026-09-07T16:00:00Z"), io, reg });
  assert.deepEqual(c.map((x) => [x.id, x.action]), [["long", "launched"], ["ping", "delivered"]]);
  c = S.tickWorkspace(ws, { now: at("2026-09-07T16:01:00Z"), io, reg });
  assert.deepEqual(c.map((x) => [x.id, x.action]).sort(), [["long", "skipped"], ["ping", "delivered"]]);
  assert.equal(inputs.length, 2);
});

test("an unknown command whose process exited frees the host slot for other jobs, but its own job waits for reconcile and keeps its first error", () => {
  const ws = workspace();
  const src = home(ws, "dev-src");
  const reg = { ...S.readRegistry(), maxConcurrent: 1 };
  const commands = [], spawns = [];
  const io = { command: (c) => { commands.push(c); return "not an envelope"; }, spawn: fakeSpawn(ws, spawns), inspect: () => ({ present: true, state: "unknown" }) };
  S.addSchedule(ws, { id: "wedge", cron: "0 * * * *", tz: "UTC", kind: "command", cwd: src, argv: ["oats", "okf", "run-source"] });
  S.addSchedule(ws, { id: "other", cron: "1 * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "t" });
  let c = S.tickWorkspace(ws, { now: at("2026-09-07T10:00:00Z"), io, reg });
  assert.equal(c[0].action, "unknown"); assert.match(c[0].error, /no valid envelope/);
  let d = S.describe(ws, "wedge", io);
  assert.equal(d.lastRun.outcome, "unknown");
  assert.equal(d.running, false, "nothing runs: the command's process has exited");
  assert.equal(S.jobLockInfo(ws, "wedge"), null, "no slot is held");
  assert.equal(d.attempt.exited, true, "the exit was observed (the io.command seam counts as exited)");
  assert.match(d.attempt.error, /no valid envelope/, "the first error is kept on the attempt");
  // The starvation case: with maxConcurrent 1, another due job runs.
  c = S.tickWorkspace(ws, { now: at("2026-09-07T10:01:00Z"), io, reg });
  assert.equal(c.find((x) => x.id === "other").action, "launched", "the unknown command does not hold the only slot");
  // The unknown job itself is never run again until reconcile, and its cause survives later ticks.
  c = S.tickWorkspace(ws, { now: at("2026-09-07T11:00:00Z"), io, reg });
  const w = c.find((x) => x.id === "wedge");
  assert.equal(w.action, "skipped"); assert.match(w.reason, /reconcile/);
  assert.equal(commands.length, 1, "the command ran once");
  d = S.describe(ws, "wedge", io);
  assert.match(d.lastRun.error, /no valid envelope/, "a later tick does not overwrite the cause");
  assert.match(d.recentRuns[0].error, /no valid envelope/);
  assert.match(d.attempt.error, /no valid envelope/);
  assert.throws(() => S.runNow(ws, "wedge", { io }), (e) => e.code === "E_SCHEDULE_UNRESOLVED");
  assert.throws(() => S.removeSchedule(ws, "wedge"), (e) => e.code === "E_SCHEDULE_RUNNING");
  let r = S.reconcile(ws, "wedge", { io });
  assert.equal(r.reconciled, "unknown"); assert.match(r.remedy, /--clear/);
  r = S.reconcile(ws, "wedge", { io, clear: true });
  assert.equal(r.reconciled, "cleared"); assert.equal(r.schedule.attempt, undefined); assert.equal(S.jobLockInfo(ws, "wedge"), null);
});

test("an unknown operation run frees its slot like a command; a command that threw, a spawn and an attempt recorded without an exit keep theirs", () => {
  const reg = { ...S.readRegistry(), maxConcurrent: 1 };
  const inspect = () => ({ present: true, state: "unknown" });
  // An operation: the same command path, so the same release.
  let ws = workspace();
  const target = home(ws, "dev-target");
  S.addSchedule(ws, { id: "op", cron: "0 * * * *", tz: "UTC", kind: "operation", operation: "knowledge:harvest", home: target });
  let c = S.tickWorkspace(ws, { now: at("2026-09-07T10:00:00Z"), io: { command: () => ({ ok: false, error: { code: "E_OPERATION_TIMEOUT", message: "the provider timed out" } }), inspect }, reg });
  assert.equal(c[0].action, "unknown");
  assert.equal(S.jobLockInfo(ws, "op"), null); assert.equal(S.describe(ws, "op").attempt.exited, true);
  assert.match(S.describe(ws, "op").attempt.error, /the provider timed out/);
  // A command that threw: no exit was observed, so the slot is kept.
  ws = workspace();
  const src = home(ws, "dev-src");
  S.addSchedule(ws, { id: "threw", cron: "0 * * * *", tz: "UTC", kind: "command", cwd: src, argv: ["oats", "okf", "harvest"] });
  S.addSchedule(ws, { id: "next", cron: "1 * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "t" });
  const io = { command: () => { throw new Error("boom"); }, spawn: fakeSpawn(ws), inspect };
  c = S.tickWorkspace(ws, { now: at("2026-09-07T10:00:00Z"), io, reg });
  assert.equal(c[0].action, "unknown");
  assert.ok(S.jobLockInfo(ws, "threw"), "the slot is held"); assert.equal(S.describe(ws, "threw").attempt.exited, undefined);
  assert.match(S.describe(ws, "threw").attempt.error, /boom/);
  c = S.tickWorkspace(ws, { now: at("2026-09-07T10:01:00Z"), io, reg });
  assert.equal(c.find((x) => x.id === "next").reason, "host busy");
  // An attempt written before the exit was recorded (an earlier kernel, or a crashed tick) keeps its slot.
  ws = workspace();
  S.addSchedule(ws, { id: "old", cron: "0 * * * *", tz: "UTC", kind: "command", cwd: home(ws, "dev-src"), argv: ["oats", "okf", "harvest"] });
  S.addSchedule(ws, { id: "next", cron: "1 * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "t" });
  const st = S.readState(ws);
  st.jobs.old = { attempt: { scheduledFor: "2026-09-07T09:00:00.000Z", startedAt: "2026-09-07T09:00:00.000Z" }, lastRun: { scheduledFor: "2026-09-07T09:00:00.000Z", startedAt: "2026-09-07T09:00:00.000Z", kind: "command", launched: false, outcome: "unknown", error: "command timed out; its side effects are unconfirmed" } };
  S.writeState(ws, st); S.acquireJobLock(ws, "old", { scheduledFor: "2026-09-07T09:00:00.000Z" });
  c = S.tickWorkspace(ws, { now: at("2026-09-07T10:01:00Z"), io: { spawn: fakeSpawn(ws), inspect }, reg });
  assert.equal(c.find((x) => x.id === "next").reason, "host busy");
  assert.ok(S.jobLockInfo(ws, "old"));
});

test("later ticks retain a legacy unresolved error only when it belongs to the attempt", () => {
  for (const matching of [true, false]) {
    const ws = workspace();
    const cause = "command timed out; its side effects are unconfirmed";
    const scheduledFor = "2026-09-07T09:00:00.000Z", startedAt = "2026-09-07T09:00:01.000Z";
    S.addSchedule(ws, { id: "legacy", cron: "0 * * * *", tz: "UTC", kind: "command", cwd: ws, argv: ["oats", "status"] });
    S.writeState(ws, { jobs: { legacy: {
      attempt: { scheduledFor, startedAt },
      lastRun: { kind: "command", outcome: "unknown", error: cause, scheduledFor: matching ? scheduledFor : "2026-09-07T08:00:00.000Z", startedAt },
    } } });
    S.acquireJobLock(ws, "legacy", { scheduledFor });
    const io = { command: () => assert.fail("unresolved attempt must not run") };
    for (const hour of [10, 11]) S.tickWorkspace(ws, { now: at(`2026-09-07T${hour}:00:00Z`), io });
    const d = S.describe(ws, "legacy", io);
    const expected = matching ? cause : "launch attempt without a recorded result";
    assert.equal(d.attempt.error, expected);
    assert.equal(d.lastRun.error, expected);
    assert.equal(d.lastRun.startedAt, startedAt);
    assert.equal(d.recentRuns[0].error, expected);
    assert.equal(S.unresolvedScheduleAttempts(ws).problems[0].error, expected);
    assert.ok(S.jobLockInfo(ws, "legacy"), "legacy attempts retain their slot");
  }
});

test("doctor reads workspace command kinds offline for attempt-only and orphaned state", () => {
  const ws = workspace();
  const scheduledFor = "2026-09-07T09:00:00.000Z", startedAt = "2026-09-07T09:00:01.000Z";
  const entry = { id: "repo/job", name: "job", member: "repo", kind: "schedule", runsOn: "offline-host", owner: "github.com/offline", definition: { kind: "command", cron: "* * * * *", tz: "UTC", cwd: ws, argv: ["oats", "status"] } };
  A.writeSnapshot(ws, { schedules: [entry], triggers: [], takenAt: "2020-01-01T00:00:00Z" });
  S.writeState(ws, { jobs: { "repo~job": { attempt: { scheduledFor, startedAt } }, "gone~job": { attempt: { scheduledFor, startedAt } } } });
  S.acquireJobLock(ws, "repo~job", { scheduledFor });
  const before = readFileSync(A.snapshotPath(ws), "utf8");
  const items = S.unresolvedScheduleAttempts(ws, { now: at("2026-09-07T10:00:01Z") }).problems;
  const job = items.find((p) => p.id === "repo/job");
  assert.equal(job.kind, "command");
  assert.equal(job.ageSeconds, 3600);
  assert.equal(job.holdsSlot, true);
  assert.doesNotMatch(job.remedy, /oats schedule reconcile/);
  assert.match(job.remedy, /[Pp]reserve.*state/);
  assert.ok(items.some((p) => p.id === "gone/job"), "missing definitions do not hide unresolved workspace state");
  assert.equal(readFileSync(A.snapshotPath(ws), "utf8"), before, "doctor never refreshes the snapshot");
  assert.equal(existsSync(join(ws, ".agents", "automations", "last-refresh-attempt")), false);
  const result = S.reconcile(ws, "repo/job", { ctx: { schedules: [{ ...entry, placement: { runsHere: true } }] } });
  assert.equal(result.reconciled, "unknown");
  assert.match(result.remedy, /--clear/);
});

test("oats doctor warns about every unresolved attempt in the deployment and the host's other scopes, with its age, its slot and the reconcile remedy", () => {
  const env = { ...process.env, OATS_HOME_DIR: process.env.OATS_HOME_DIR };
  const doctor = (ws, ...a) => execFileSync(process.execPath, [bin, "doctor", ws, ...a], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  const clean = workspace();
  // Operator coverage (#671) warnings are their own; no schedule problem is reported.
  assert.deepEqual((JSON.parse(doctor(clean, "--json")).problems ?? []).filter((p) => !p.code.startsWith("operator-")), [], "nothing unresolved, nothing reported");
  const ws = workspace();
  const src = home(ws, "dev-src");
  const reg = { ...S.readRegistry(), maxConcurrent: 4 };
  S.addSchedule(ws, { id: "wedge", cron: "0 * * * *", tz: "UTC", kind: "command", cwd: src, argv: ["oats", "okf", "run-source"] });
  S.addSchedule(ws, { id: "stuck", cron: "0 * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "t" });
  S.tickWorkspace(ws, { now: at("2026-09-07T10:00:00Z"), reg, io: { command: () => "no envelope", spawn: () => { throw new Error("spawn failed; rollback INCOMPLETE, home quarantined"); }, inspect: () => ({ present: true, state: "unknown" }) } });
  // Another scope this host ticks, with an attempt recorded before exits were (it holds its slot).
  const other = workspace();
  S.addSchedule(other, { id: "old", cron: "0 * * * *", tz: "UTC", kind: "command", cwd: home(other, "dev-src"), argv: ["oats", "okf", "harvest"] });
  const st = S.readState(other);
  st.jobs.old = { attempt: { scheduledFor: "2026-09-07T09:00:00.000Z", startedAt: "2026-09-07T09:00:01.000Z" }, lastRun: { scheduledFor: "2026-09-07T09:00:00.000Z", startedAt: "2026-09-07T09:00:01.000Z", kind: "command", launched: false, outcome: "unknown", error: "launch attempt without a recorded result" } };
  S.writeState(other, st); S.acquireJobLock(other, "old", { scheduledFor: "2026-09-07T09:00:00.000Z" });
  S.registerWorkspace(other);
  try {
    const out = JSON.parse(doctor(ws, "--json"));
    const items = Object.fromEntries(out.problems.filter((p) => p.code === "schedule-unresolved").map((p) => [p.id, p]));
    assert.deepEqual(Object.keys(items).sort(), ["old", "stuck", "wedge"]);
    const wedge = items.wedge;
    assert.equal(wedge.severity, "warning"); assert.equal(wedge.scope, ws); assert.equal(wedge.kind, "command");
    assert.equal(wedge.scheduledFor, "2026-09-07T10:00:00.000Z"); assert.equal(wedge.startedAt, "2026-09-07T10:00:00.000Z");
    assert.ok(Number.isInteger(wedge.ageSeconds) && wedge.ageSeconds > 0);
    assert.equal(wedge.holdsSlot, false); assert.equal(wedge.exited, true); assert.match(wedge.error, /no valid envelope/);
    assert.equal(wedge.remedy, "oats schedule reconcile wedge --clear", "a command whose effects can't be proven needs --clear after a check by hand");
    assert.match(wedge.message, /wedge/); assert.match(wedge.message, /oats schedule reconcile wedge --clear/);
    assert.equal(items.stuck.holdsSlot, true); assert.equal(items.stuck.exited, false); assert.equal(items.stuck.remedy, "oats schedule reconcile stuck");
    assert.equal(items.old.scope, other); assert.equal(items.old.holdsSlot, true); assert.equal(items.old.startedAt, "2026-09-07T09:00:01.000Z");
    assert.equal(items.old.remedy, `oats schedule reconcile old --clear --dir ${other}`, "another scope's remedy names it");
    const text = doctor(ws);
    assert.match(text, /! schedule-unresolved: .*wedge.*oats schedule reconcile wedge --clear/);
    assert.match(text, /! schedule-unresolved: .*stuck.*holds a host slot/);
  } finally { S.unregisterWorkspace(other); S.releaseJobLock(other, "old"); }
});

test("a command that creates a home and then times out stays unknown, frees its slot once its process exited, and waits for reconcile", () => {
  const ws = workspace();
  const src = home(ws, "dev-src");
  // A dummy oats binary: creates an instance home like a harvester spawn would, prints nothing, then sleeps past the timeout.
  const dummy = join(base, "dummy-oats.mjs");
  writeFileSync(dummy, `import { mkdirSync, writeFileSync } from "node:fs"; import { join } from "node:path";
const h = join(${JSON.stringify(ws)}, "agents", "dev", "instances", "dev-harvest-late"); mkdirSync(h, { recursive: true }); writeFileSync(join(h, "instance.json"), JSON.stringify({ instance: "dev-harvest-late", home: h }));
await new Promise((r) => setTimeout(r, 5000));\n`);
  const io = { oatsBin: dummy, commandTimeoutMs: 800, inspect: () => ({ present: true, state: "unknown" }) };
  S.addSchedule(ws, { id: "late", cron: "* * * * *", tz: "UTC", kind: "command", cwd: src, argv: ["oats", "okf", "harvest"] });
  const reg = S.readRegistry();
  const c = S.tickWorkspace(ws, { now: at("2026-09-07T17:00:00Z"), io, reg });
  assert.equal(c[0].action, "unknown"); assert.match(c[0].error, /timed out/);
  let d = S.describe(ws, "late", io);
  assert.equal(d.lastRun.outcome, "unknown"); assert.ok(d.attempt, "the attempt is retained"); assert.equal(d.running, false, "the killed process holds no slot");
  assert.equal(d.attempt.exited, true); assert.equal(d.attempt.exitStatus, null); assert.equal(d.attempt.exitSignal, "SIGTERM", "killed at the timeout, its exit observed");
  assert.match(d.attempt.error, /timed out/);
  // The next minute must not launch again.
  const c2 = S.tickWorkspace(ws, { now: at("2026-09-07T17:01:00Z"), io, reg });
  assert.equal(c2[0].action, "skipped"); assert.match(c2[0].reason, /reconcile/);
  assert.throws(() => S.runNow(ws, "late", { io }), (e) => e.code === "E_SCHEDULE_UNRESOLVED");
  // The answer named no instance: nothing is inferred from the roster (the
  // home that appeared is not attributable); unknown stays until the
  // operator has checked by hand and clears it explicitly.
  let r = S.reconcile(ws, "late", { io });
  assert.equal(r.reconciled, "unknown"); assert.match(r.remedy, /--clear/);
  assert.ok(S.describe(ws, "late", io).attempt, "the attempt is still retained"); assert.match(S.describe(ws, "late", io).lastRun.error, /timed out/, "the cause survives the skipped tick");
  r = S.reconcile(ws, "late", { io, clear: true });
  assert.equal(r.reconciled, "cleared"); assert.equal(r.schedule.lastRun.outcome, "launch-failed"); assert.equal(r.schedule.running, false);
  assert.equal(S.describe(ws, "late", io).attempt, undefined);
});

test("a command that answers no valid envelope stays unknown; an incomplete spawn rollback stays unknown; a named answer is the only adoptable receipt", () => {
  const ws = workspace();
  const src = home(ws, "dev-src2");
  // A dummy oats: creates a home, prints text that is not JSON, exits 0.
  const dummy = join(base, "dummy-oats-text.mjs");
  writeFileSync(dummy, `import { mkdirSync, writeFileSync } from "node:fs"; import { join } from "node:path";
const h = join(${JSON.stringify(ws)}, "agents", "dev", "instances", "dev-harvest-text"); mkdirSync(h, { recursive: true }); writeFileSync(join(h, "instance.json"), JSON.stringify({ instance: "dev-harvest-text", home: h }));
process.stdout.write("spawned dev-harvest-text\\n");\n`);
  const io = { oatsBin: dummy, inspect: () => ({ present: true, state: "unknown" }) };
  S.addSchedule(ws, { id: "text", cron: "* * * * *", tz: "UTC", kind: "command", cwd: src, argv: ["oats", "okf", "harvest"] });
  const reg = S.readRegistry();
  const c = S.tickWorkspace(ws, { now: at("2026-09-07T18:00:00Z"), io, reg });
  assert.equal(c[0].action, "unknown"); assert.match(c[0].error, /no valid envelope/);
  assert.equal(S.describe(ws, "text", io).running, false, "the exited process holds no slot; the home it may have made has its own lifecycle");
  assert.equal(S.describe(ws, "text", io).attempt.exitStatus, 0, "the attempt is kept until reconcile");
  // An envelope that is JSON but not an envelope is no receipt either.
  const io2 = { command: () => ({ spawned: true }), inspect: io.inspect };
  S.addSchedule(ws, { id: "shape", cron: "* * * * *", tz: "UTC", kind: "command", cwd: src, argv: ["oats", "status"] });
  const c2 = S.tickWorkspace(ws, { now: at("2026-09-07T18:01:00Z"), io: io2, reg: { maxConcurrent: 4 } });
  assert.equal(c2.find((x) => x.id === "shape").action, "unknown");
  // A valid ok:false envelope that reports an INCOMPLETE rollback stays unknown; its process has exited.
  const io2b = { command: () => ({ ok: false, error: { code: "E_SPAWN_FAILED", message: "harvest spawn failed; rollback INCOMPLETE: pane could not be stopped, home quarantined" } }), inspect: io.inspect };
  S.addSchedule(ws, { id: "rollback", cron: "* * * * *", tz: "UTC", kind: "command", cwd: src, argv: ["oats", "okf", "harvest"] });
  const c2b = S.tickWorkspace(ws, { now: at("2026-09-07T18:01:30Z"), io: io2b, reg: { maxConcurrent: 4 } });
  assert.equal(c2b.find((x) => x.id === "rollback").action, "unknown"); assert.equal(S.describe(ws, "rollback", io).running, false); assert.ok(S.describe(ws, "rollback", io).attempt);
  // A spawn whose compensation reports an INCOMPLETE rollback keeps its slot as unknown.
  const io3 = { spawn: () => { throw Object.assign(new Error("spawn failed: pane could not be stopped; rollback INCOMPLETE, home quarantined"), { code: "E_SPAWN_FAILED" }); }, inspect: io.inspect };
  S.addSchedule(ws, { id: "incomplete", cron: "* * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "t" });
  const c3 = S.tickWorkspace(ws, { now: at("2026-09-07T18:02:00Z"), io: io3, reg: { maxConcurrent: 4 } });
  assert.equal(c3.find((x) => x.id === "incomplete").action, "unknown"); assert.equal(S.describe(ws, "incomplete", io).running, true);
  // A spawn that failed with a complete compensation is a confirmed failure.
  const io4 = { spawn: () => { throw Object.assign(new Error("no soul named x"), { code: "E_AGENT_UNKNOWN" }); }, inspect: io.inspect };
  S.addSchedule(ws, { id: "clean", cron: "* * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "t" });
  const c4 = S.tickWorkspace(ws, { now: at("2026-09-07T18:03:00Z"), io: io4, reg: { maxConcurrent: 5 } });
  assert.equal(c4.find((x) => x.id === "clean").action, "launch-failed"); assert.equal(S.describe(ws, "clean", io).running, false);
});

test("a wake slot is released when its started harness is proven stopped, and kept while it is starting (the start receipt), even though the home remains", () => {
  const ws = workspace();
  const h1 = home(ws, "dev-persistent"), h2 = home(ws, "dev-waiting");
  const states = { [h1]: { present: false, state: "stopped" }, [h2]: { present: false, state: "stopped" } };
  const started = [], inputs = [];
  const io = { inspect: (h) => states[h], start: (h) => { started.push(h); return { instance: basename(h) }; }, input: (h, t) => { inputs.push([h, t]); return { submitted: true }; } };
  S.addSchedule(ws, { id: "one", cron: "* * * * *", tz: "UTC", kind: "wake", home: h1, message: "m1" });
  S.addSchedule(ws, { id: "two", cron: "* * * * *", tz: "UTC", kind: "wake", home: h2, message: "m2" });
  const reg = { maxConcurrent: 1 };
  let by = Object.fromEntries(S.tickWorkspace(ws, { now: at("2026-09-07T12:00:00Z"), io, reg }).map((x) => [x.id, x]));
  assert.equal(by.one.action, "started"); assert.equal(by.two.action, "skipped");
  // Startup phase: a shell with the start receipt and no matching exit marker keeps the slot.
  writeFileSync(join(h1, ".oats-start-pending.json"), JSON.stringify({ id: "start-1" }));
  states[h1] = { present: true, state: "shell" };
  by = Object.fromEntries(S.tickWorkspace(ws, { now: at("2026-09-07T12:00:20Z"), io, reg }).map((x) => [x.id, x]));
  assert.equal(by.one.action, "skipped"); assert.match(by.one.reason, /starting/); assert.ok(S.jobLockInfo(ws, "one"));
  assert.equal(by.two.action, "skipped"); assert.equal(by.two.pending, true, "not a due minute: two waits");
  // Active: the pending message is delivered.
  states[h1] = { present: true, state: "unknown" };
  by = Object.fromEntries(S.tickWorkspace(ws, { now: at("2026-09-07T12:00:40Z"), io, reg }).map((x) => [x.id, x]));
  assert.equal(by.one.action, "delivered"); assert.equal(inputs.length, 1);
  // The harness exits: the wrapper wrote the exit marker for that launch and a shell remains; the home stays.
  writeFileSync(join(h1, ".oats-start-exited"), "start-1\n");
  states[h1] = { present: true, state: "shell" };
  by = Object.fromEntries(S.tickWorkspace(ws, { now: at("2026-09-07T12:01:00Z"), io, reg }).map((x) => [x.id, x]));
  assert.equal(by.two.action, "started", "the never-launched job goes first once the slot is free");
  assert.equal(by.one.action, "skipped"); assert.match(by.one.reason, /host busy/);
  assert.ok(existsSync(h1), "the persistent home is untouched"); assert.equal(S.jobLockInfo(ws, "one"), null); assert.ok(S.jobLockInfo(ws, "two"));
  assert.deepEqual(started, [h1, h2]);
  assert.match(S.describe(ws, "one", io).lastRun.reason, /host busy/, "one is not restarted while two holds the only slot");
});

test("a tick evaluates the minute it was fired for; its timestamps stay real", () => {
  const ws = workspace();
  const reg = { maxConcurrent: 5 };
  S.addSchedule(ws, { id: "at1359", cron: "59 13 * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "a" });
  S.addSchedule(ws, { id: "at1400", cron: "0 14 * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "b" });
  const realStart = Date.now();
  let wallClock;
  const spawn = fakeSpawn(ws);
  const io = { spawn: (root, agent, opts) => { wallClock ??= readJson(join(ws, ".agents", "schedules", "state.json")).jobs.at1359?.attempt?.wallClock; return spawn(root, agent, opts); } };
  // launchd fired the tick at 13:59:59.4; the process got to its first clock read at 14:00:11.
  const now = at("2026-10-10T14:00:11Z"), firedAt = at("2026-10-10T13:59:59.400Z");
  const c = S.tickWorkspace(ws, { now, firedAt, io, reg });
  const by = Object.fromEntries(c.map((x) => [x.id, x]));
  assert.equal(by.at1359.action, "launched"); assert.equal(by.at1359.minute, "2026-10-10T13:59");
  assert.equal(by.at1400, undefined, "14:00 is the next tick's minute");
  const run = S.describe(ws, "at1359", io).lastRun;
  assert.equal(run.scheduledFor, "2026-10-10T13:59:00.000Z");
  assert.equal(run.startedAt, now.toISOString(), "startedAt is the tick's clock, not the fired minute");
  assert.ok(Date.parse(wallClock) >= realStart, `wallClock is the real time (got ${wallClock})`);
  assert.match(run.instance, /-202610101359$/, "the run is named for the minute it was due");
  // Without firedAt the minute is now's, as before.
  assert.equal(S.tickWorkspace(ws, { now: at("2026-10-10T14:00:30Z"), io, reg }).find((x) => x.id === "at1400").action, "launched");
});

test("oats schedule tick takes its minute from the process start, not from the clock it reads later", () => {
  const ws = workspace();
  S.addSchedule(ws, { id: "every", cron: "* * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "a" });
  // Every Date the CLI makes is two hours ahead; performance.timeOrigin is not.
  const preload = join(base, "date-ahead.mjs");
  writeFileSync(preload, "const Real = Date, ahead = 2 * 3600 * 1000;\nglobalThis.Date = class extends Real { constructor(...a) { super(...(a.length ? a : [Real.now() + ahead])); } static now() { return Real.now() + ahead; } };\n");
  const before = S.readRegistry();
  S.writeRegistry({ ...before, workspaces: [ws] });
  try {
    for (const host of [false, true]) {
      const from = S.minuteStart(new Date()).getTime();
      const out = execFileSync(process.execPath, ["--import", preload, bin, "schedule", "tick", ...(host ? ["--host"] : []), "--dry-run", "--dir", ws, "--json"], { encoding: "utf8", env: { ...process.env } });
      const to = S.minuteStart(new Date()).getTime();
      const row = JSON.parse(out.trim()).result.considered.find((x) => x.id === "every");
      assert.equal(row.action, "due");
      const minute = Date.parse(`${row.minute}:00Z`);
      assert.ok(minute >= from && minute <= to, `${host ? "--host" : "scope"}: evaluated ${row.minute}, the real minute, not two hours ahead`);
    }
  } finally { S.writeRegistry(before); }
});

test("the host tick evaluates its fired minute, and the host's minute never goes backwards", () => {
  const ws = workspace();
  const before = S.readRegistry(), hostBefore = S.readHostState();
  S.writeRegistry({ ...before, workspaces: [ws] });
  try {
    S.addSchedule(ws, { id: "at1359", cron: "59 13 * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "a" });
    const io = { spawn: fakeSpawn(ws) };
    let r = S.tickHost({ now: at("2026-10-10T14:00:11Z"), firedAt: at("2026-10-10T13:59:59.400Z"), io });
    assert.equal(r.minute, "2026-10-10T13:59"); assert.equal(r.tickedAt, "2026-10-10T14:00:11.000Z");
    assert.equal(r.considered.find((x) => x.id === "at1359").action, "launched");
    assert.deepEqual([S.readHostState().minute, S.readHostState().lastTick], ["2026-10-10T13:59", "2026-10-10T14:00:11.000Z"]);
    // The 14:00 tick finishes, then a slow 13:59 tick: the host's minute stays 14:00; lastTick is the last write's real time.
    S.tickHost({ now: at("2026-10-10T14:00:20Z"), firedAt: at("2026-10-10T14:00:00.100Z"), io });
    r = S.tickHost({ now: at("2026-10-10T14:00:40Z"), firedAt: at("2026-10-10T13:59:59.900Z"), io });
    assert.equal(r.minute, "2026-10-10T13:59", "the tick still reports the minute it evaluated");
    assert.deepEqual([S.readHostState().minute, S.readHostState().lastTick], ["2026-10-10T14:00", "2026-10-10T14:00:40.000Z"]);
    // An unreadable stored minute counts as absent.
    S.writeHostState({ ...S.readHostState(), minute: "not a minute" });
    S.tickHost({ now: at("2026-10-10T14:01:05Z"), firedAt: at("2026-10-10T13:59:59Z"), io });
    assert.equal(S.readHostState().minute, "2026-10-10T13:59");
  } finally { S.writeRegistry(before); S.writeHostState(hostBefore); }
});

test("the host tick observes every registered scope before admitting, in one host-wide least-recently-launched order", () => {
  const ws1 = workspace(), ws2 = workspace();
  const io = { spawn: (root, agent, opts) => { const ws = root.startsWith(ws1) ? ws1 : ws2; const name = `${agent.name}-${opts.purpose}`; return { instance: name, home: home(ws, name), launched: true }; }, inspect: () => ({ present: true, state: "unknown" }) };
  const before = S.readRegistry();
  S.writeRegistry({ ...before, maxConcurrent: 1, workspaces: [ws1, ws2] });
  try {
    S.addSchedule(ws1, { id: "first", cron: "* * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "a" });
    S.addSchedule(ws2, { id: "second", cron: "* * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "b" });
    let r = S.tickHost({ now: at("2026-09-07T21:00:00Z"), io });
    const launched = (res) => res.considered.filter((x) => x.action === "launched").map((x) => `${basename(x.workspace)}/${x.id}`);
    assert.deepEqual(launched(r), [`${basename(ws1)}/first`]);
    // first's instance retires between ticks: the slot frees and the never-launched second scope goes first.
    rmSync(S.describe(ws1, "first", io).lastRun.home, { recursive: true, force: true });
    r = S.tickHost({ now: at("2026-09-07T21:01:00Z"), io });
    assert.deepEqual(launched(r), [`${basename(ws2)}/second`]);
    assert.equal(r.considered.find((x) => x.id === "first").reason, "host busy");
    // A malformed definition in one scope neither aborts that scope's healthy jobs nor the other scope.
    const defs = S.readDefinitions(ws1); defs.jobs.nul = null; defs.jobs.odd = { id: "odd", enabled: true, kind: 42, cron: "* * * * *", tz: "UTC" }; S.writeDefinitions(ws1, defs);
    rmSync(S.describe(ws2, "second", io).lastRun.home, { recursive: true, force: true });
    r = S.tickHost({ now: at("2026-09-07T21:02:00Z"), io });
    const by = Object.fromEntries(r.considered.map((x) => [x.id, x]));
    assert.equal(by.nul.action, "invalid"); assert.equal(by.odd.action, "invalid"); assert.match(by.odd.error, /kind 42/);
    assert.equal(launched(r).length, 1);
  } finally { S.writeRegistry(before); }
});

test("an execution target cannot be edited under a running or unresolved job; timing and text can; the tracked home is the launched one", () => {
  const ws = workspace();
  const io = { spawn: fakeSpawn(ws), inspect: () => ({ present: true, state: "unknown" }) };
  S.addSchedule(ws, { id: "job", cron: "* * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "t" });
  S.tickWorkspace(ws, { now: at("2026-09-07T22:00:00Z"), io, reg: { maxConcurrent: 1 } });
  assert.equal(S.describe(ws, "job", io).running, true);
  assert.throws(() => S.updateSchedule(ws, "job", { cron: "* * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "t", agentsRoot: join(ws, "agents") }, io), (e) => e.code === "E_SCHEDULE_RUNNING");
  const h = home(ws, "dev-elsewhere");
  assert.throws(() => S.updateSchedule(ws, "job", { cron: "* * * * *", tz: "UTC", kind: "wake", home: h, message: "m" }, io), (e) => e.code === "E_SCHEDULE_RUNNING");
  assert.throws(() => S.updateSchedule(ws, "job", { cron: "* * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "t", purpose: "other" }, io), (e) => e.code === "E_SCHEDULE_RUNNING", "purpose names the instance reconcile looks for");
  const d = S.updateSchedule(ws, "job", { cron: "5 * * * *", tz: "Europe/Madrid", kind: "spawn", agent: "dev", task: "new text" }, io);
  assert.equal(d.cron, "5 * * * *"); assert.equal(d.running, true);
  // A cold wake reserves its slot BEFORE the start call and keeps it on
  // ANY start exception (an error code does not prove nothing was
  // allocated); the next observation releases it once stopped is proven.
  const hc = home(ws, "dev-cold");
  const states = { [hc]: { present: false, state: "stopped" } };
  let seenLockDuringStart = null;
  const wio = { inspect: (x) => states[x], start: () => { seenLockDuringStart = !!S.jobLockInfo(ws, "cold"); throw Object.assign(new Error("tmux start could not be confirmed"), { code: "E_SESSION_START_FAILED" }); } };
  S.addSchedule(ws, { id: "cold", cron: "* * * * *", tz: "UTC", kind: "wake", home: hc, message: "m" });
  rmSync(S.describe(ws, "job", io).lastRun.home, { recursive: true, force: true });
  let by = Object.fromEntries(S.tickWorkspace(ws, { now: at("2026-09-07T22:01:00Z"), io: wio, reg: { maxConcurrent: 1 } }).map((x) => [x.id, x]));
  assert.equal(seenLockDuringStart, true, "the slot is persisted before start runs");
  assert.equal(by.cold.action, "skipped"); assert.match(by.cold.reason, /did not complete/); assert.ok(S.jobLockInfo(ws, "cold"), "an uncertain start keeps the slot");
  // A refusal whose code looks clean is treated the same (core can refuse while recording, after allocation).
  const rio = { inspect: (x) => states[x], start: () => { throw Object.assign(new Error("independent receipt is invalid"), { code: "E_RUNTIME_ENDPOINT_UNKNOWN" }); } };
  by = Object.fromEntries(S.tickWorkspace(ws, { now: at("2026-09-07T22:02:00Z"), io: rio, reg: { maxConcurrent: 1 } }).map((x) => [x.id, x]));
  assert.equal(by.cold.action, "skipped"); assert.equal(by.cold.reason.includes("E_RUNTIME_ENDPOINT_UNKNOWN"), true); assert.ok(S.jobLockInfo(ws, "cold"));
  // The next observation (a non-due tick) proves the harness stopped and releases the slot; nothing is started off the minute.
  by = Object.fromEntries(S.tickWorkspace(ws, { now: at("2026-09-07T22:02:30Z"), io: rio, reg: { maxConcurrent: 1 } }).map((x) => [x.id, x]));
  assert.equal(by.cold.action, "skipped"); assert.equal(S.jobLockInfo(ws, "cold"), null, "observation released the slot");
  // Registry register/unregister are serialized and idempotent.
  const before = S.readRegistry();
  try { S.registerWorkspace(ws); S.registerWorkspace(ws); assert.equal(S.readRegistry().workspaces.filter((w) => w === ws).length, 1); S.unregisterWorkspace(ws); assert.ok(!S.readRegistry().workspaces.includes(ws)); }
  finally { S.writeRegistry(before); }
});

test("a command whose envelope names a capability agent's home is tracked through the deployment's roster; an unplaceable instance stays unknown", () => {
  const ws = workspace();
  const src = home(ws, "dev-src2");
  const memberHome = join(ws, "agents", "memory-harvest", "instances", "memory-harvest-one"); mkdirSync(memberHome, { recursive: true }); writeFileSync(join(memberHome, "instance.json"), "{}");
  const io = { command: () => ({ ok: true, result: { harvest: "spawned", instance: "memory-harvest-one" } }), inspect: () => ({ present: true, state: "unknown" }) };
  S.addSchedule(ws, { id: "member-harvest", cron: "* * * * *", tz: "UTC", kind: "command", cwd: src, argv: ["oats", "okf", "harvest"] });
  const c = S.tickWorkspace(ws, { now: at("2026-09-07T18:00:00Z"), io, reg: S.readRegistry() });
  assert.equal(c[0].action, "launched");
  const d = S.describe(ws, "member-harvest", io);
  assert.equal(d.lastRun.home, memberHome); assert.equal(d.running, true);
  const io2 = { command: () => ({ ok: true, result: { harvest: "spawned", instance: "memory-harvest-nowhere" } }), inspect: io.inspect };
  S.addSchedule(ws, { id: "lost", cron: "* * * * *", tz: "UTC", kind: "command", cwd: src, argv: ["oats", "okf", "harvest"] });
  rmSync(memberHome, { recursive: true, force: true });
  const c2 = S.tickWorkspace(ws, { now: at("2026-09-07T18:01:00Z"), io: io2, reg: S.readRegistry() });
  const lost = c2.find((x) => x.id === "lost");
  assert.equal(lost.action, "unknown"); assert.match(lost.error, /no home for it/);
  assert.ok(S.describe(ws, "lost", io2).attempt, "the attempt is retained, the slot held");
  assert.equal(S.parseEnvelopeText('note\n{"ok":true,"result":{"a":1}}').result.a, 1);
  assert.equal(S.parseEnvelopeText('{\n "ok": true,\n "result": {"b": 2}\n}').result.b, 2);
  assert.equal(S.parseEnvelopeText("garbage"), null);
});

test("the host lock is taken over from a holder that is gone; a holder that runs, a record that cannot be judged and an earlier kernel's lock directory are E_SCHEDULER_BUSY with the path to remove, and are left as they are", () => {
  const lock = join(process.env.OATS_HOME_DIR, "schedules", "host.lock");
  mkdirSync(join(process.env.OATS_HOME_DIR, "schedules"), { recursive: true });
  const refused = (why) => (e) => e.code === "E_SCHEDULER_BUSY" && e.message === `the host scheduler is locked (${why}). If no oats schedule process is running, remove ${lock} and retry; nothing was changed.`;
  // A tick that was killed while it held the lock: the next one takes the lock over.
  const exited = spawnSync(process.execPath, ["-e", ""]).pid;
  writeFileSync(lock, JSON.stringify({ pid: exited, processStart: "proc:1", nonce: "a".repeat(32), at: "2026-10-10T00:00:00.000Z", what: "the host scheduler" }) + "\n");
  assert.equal(S.withHostLock(() => "entered"), "entered");
  assert.equal(existsSync(lock), false, "its own lock is removed in finally");
  // A holder that runs.
  const live = JSON.stringify({ ...selfIdentity(), nonce: "a".repeat(32), at: "2026-10-10T00:00:00.000Z", what: "the host scheduler" }) + "\n";
  writeFileSync(lock, live);
  assert.throws(() => S.withHostLock(() => "entered"), refused(`pid ${process.pid} holds it`));
  assert.equal(readFileSync(lock, "utf8"), live, "the holder's lock is not touched");
  // A record that does not parse.
  writeFileSync(lock, "{half a record");
  assert.throws(() => S.withHostLock(() => "entered"), refused(`the record at ${lock} is unreadable`));
  assert.equal(readFileSync(lock, "utf8"), "{half a record");
  rmSync(lock);
  // The lock directory of an earlier kernel, whoever its owner.json names.
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 999999, at: "x" }));
  assert.throws(() => S.withHostLock(() => "entered"), refused(`${lock} is a lock directory written by an earlier kernel`));
  assert.equal(readFileSync(join(lock, "owner.json"), "utf8"), JSON.stringify({ pid: 999999, at: "x" }), "the directory is reported, never removed");
  rmSync(lock, { recursive: true, force: true });
  assert.equal(S.withHostLock(() => "entered"), "entered");
  assert.equal(existsSync(lock), false);
});

test("dry-run touches no lock, state or definition; a retiring home keeps its slot; run-now observes before judging a lock", () => {
  const ws = workspace();
  const io = { spawn: fakeSpawn(ws), inspect: () => ({ present: true, state: "unknown" }) };
  S.addSchedule(ws, { id: "d", cron: "* * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "t" });
  const reg = S.readRegistry();
  const statePath = join(ws, ".agents", "schedules", "state.json");
  const before = existsSync(statePath) ? readFileSync(statePath, "utf8") : null;
  const dry = S.tickWorkspace(ws, { now: at("2026-09-07T19:00:00Z"), io, reg, dryRun: true });
  assert.deepEqual(dry.map((x) => [x.id, x.action]), [["d", "due"]]);
  assert.equal(existsSync(statePath) ? readFileSync(statePath, "utf8") : null, before, "dry-run wrote no state");
  assert.equal(S.jobLockInfo(ws, "d"), null);
  S.tickWorkspace(ws, { now: at("2026-09-07T19:00:00Z"), io, reg });
  const h = S.describe(ws, "d", io).lastRun.home;
  // A pending retirement marker beside the home is not "ended": the harness may still be alive.
  writeFileSync(join(dirname(h), `.oats-retire-pending-${basename(h)}.json`), "{}");
  const seen = S.observeHome(h, io);
  assert.equal(seen.outcome, "active"); assert.match(seen.note, /retiring/);
  const dry2 = S.tickWorkspace(ws, { now: at("2026-09-07T19:01:00Z"), io, reg, dryRun: true });
  assert.equal(dry2[0].reason, "still running"); assert.ok(S.jobLockInfo(ws, "d"), "dry-run released nothing");
  // The home is gone: run-now observes that under the host lock and runs instead of refusing on a stale lock.
  rmSync(join(dirname(h), `.oats-retire-pending-${basename(h)}.json`), { force: true }); rmSync(h, { recursive: true, force: true });
  const r = S.runNow(ws, "d", { io, now: at("2026-09-07T19:05:30Z") });
  assert.equal(r.run.outcome, "launched");
  assert.equal(readJson(statePath).jobs.d.lastAttemptedMinute, "2026-09-07T19:05", "run-now records the attempted minute so the timer cannot double-fire");
});

test("the schedule scope is the deployment (oats-local.yaml walking up), never an ambient agents root; no deployment is E_LOCAL_MISSING; invalid definitions do not stop the tick; due jobs rotate", () => {
  const dep = workspace(); mkdirSync(join(dep, "agents", "dev", "soul", "nested"), { recursive: true });
  const saved = { OATS_ROOT: process.env.OATS_ROOT, PI_AGENTS_ROOT: process.env.PI_AGENTS_ROOT };
  const elsewhere = workspace();
  process.env.OATS_ROOT = join(elsewhere, "agents"); process.env.PI_AGENTS_ROOT = join(elsewhere, "agents");
  try {
    assert.equal(S.scheduleScopeOf(join(dep, "agents", "dev", "soul", "nested")), dep);
    const cli = JSON.parse(execFileSync(process.execPath, [bin, "schedule", "list", "--dir", dep, "--json"], { encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n").pop());
    assert.equal(cli.ok, true, JSON.stringify(cli)); assert.equal(cli.result.scope, dep, "--dir <deployment> wins over an ambient root");
  } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const bare = join(base, "bare-scope"); mkdirSync(join(bare, "agents"), { recursive: true });
  assert.throws(() => S.scheduleScopeOf(join(bare, "agents")), (e) => e.code === "E_LOCAL_MISSING" && /oats onboard/.test(e.message));
  const ws = workspace();
  const io = { spawn: fakeSpawn(ws), inspect: () => ({ present: true, state: "unknown" }) };
  S.addSchedule(ws, { id: "a", cron: "* * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "a" });
  S.addSchedule(ws, { id: "b", cron: "* * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "b" });
  const defs = S.readDefinitions(ws); defs.jobs.broken = { ...defs.jobs.a, id: "broken", cron: "99 99 * * *" }; S.writeDefinitions(ws, defs);
  const reg = { ...S.readRegistry(), maxConcurrent: 1 };
  let c = S.tickWorkspace(ws, { now: at("2026-09-07T20:00:00Z"), io, reg });
  const by = Object.fromEntries(c.map((x) => [x.id, x.action]));
  assert.equal(by.broken, "invalid"); assert.equal(by.a, "launched"); assert.equal(by.b, "skipped");
  rmSync(S.describe(ws, "a", io).lastRun.home, { recursive: true, force: true });
  c = S.tickWorkspace(ws, { now: at("2026-09-07T20:01:00Z"), io, reg });
  const by2 = Object.fromEntries(c.map((x) => [x.id, x.action]));
  assert.equal(by2.b, "launched", "the job that never ran goes first"); assert.equal(by2.a, "skipped");
});

test("the launchd unit runs the CLI under a minimal environment with only its own PATH", () => {
  const plist = H.renderLaunchdPlist();
  const path = /<key>PATH<\/key><string>([^<]+)<\/string>/.exec(plist)[1];
  const out = execFileSync("/usr/bin/env", ["-i", `PATH=${path}`, "HOME=" + process.env.HOME, "node", bin, "version", "--json"], { encoding: "utf8" });
  assert.equal(JSON.parse(out.trim()).name, "@awebai/oats");
  const which = execFileSync("/usr/bin/env", ["-i", `PATH=${path}`, "sh", "-c", "command -v tmux || true"], { encoding: "utf8" }).trim();
  assert.ok(which.includes("tmux"), `tmux resolvable under the unit PATH (got ${JSON.stringify(which)})`);
});

test("a routed spawn refuses a wake schedule when the host lacks the feature and forwards it inline otherwise", async () => {
  const { routeCommand } = await import("../lib/servers.mjs");
  const oatsHome = process.env.OATS_HOME_DIR; mkdirSync(oatsHome, { recursive: true });
  writeFileSync(join(oatsHome, "servers.json"), JSON.stringify({ servers: { s: { sshHost: "h", workspace: "/w" } } }));
  const calls = [];
  const io = (features) => ({ execFileSync: (b, argv) => { const a = argv.join(" "); calls.push(a);
    if (a.includes("version --json")) return JSON.stringify({ schemaVersion: 1, ok: true, result: { desktopApi: 1, version: "0.22.10", harnesses: ["pi", "claude", "codex"], sessionBackends: ["tmux"], launchOptions: ["yolo"], remote: ["spawn", "session"], features } });
    if (a.includes(" status ")) return JSON.stringify({ schemaVersion: 1, ok: true, result: { root: "/w/agents", agents: [{ name: "dev", harness: "claude" }] } });
    return JSON.stringify({ schemaVersion: 1, ok: true, result: { instance: "dev-x", home: "/w/agents/dev/instances/dev-x", launched: true } }); } });
  assert.throws(() => routeCommand("s", "spawn", ["dev", "--wake-json", "{\"cron\":\"*/5 * * * *\",\"tz\":\"UTC\",\"message\":\"hi\"}"], io(["retire-home"])), (e) => e.code === "E_REMOTE_INCOMPATIBLE" && /wake schedule/.test(e.message));
  assert.equal(calls.filter((c) => c.includes(" spawn ")).length, 0, "refused before spawning");
  const out = routeCommand("s", "spawn", ["dev", "--wake-json", "{\"cron\":\"*/5 * * * *\",\"tz\":\"UTC\",\"message\":\"hi\"}"], io(["retire-home", "schedule"]));
  assert.equal(out.envelope.ok, true);
  assert.match(calls.find((c) => c.includes(" spawn ")), /--wake-json/);
});

test("K8 recentRuns: every settled lastRun is recorded once (newest first, bounded 50), active/starting are not; describe exposes recentRuns + transcript pointer; scheduleApi 2", () => {
  const ws = mkdtempSync(join(tmpdir(), "oats-sched-k8-")); mkdirSync(join(ws, "agents"), { recursive: true });
  S.writeDefinitions(ws, { version: 1, jobs: { j: { kind: "command", enabled: true, cron: "*/5 * * * *", tz: "UTC", argv: ["oats", "status"], cwd: ws } } });
  const st = S.readState(ws);
  st.jobs.j = { lastRun: { scheduledFor: "2026-09-22T10:00:00.000Z", startedAt: "2026-09-22T10:00:01.000Z", outcome: "active", instance: "x-1", home: join(ws, "agents", "x", "instances", "x-1") } };
  S.writeState(ws, st);
  assert.equal(S.describe(ws, "j").recentRuns.length, 0, "an active run is not history yet");
  st.jobs.j.lastRun = { ...st.jobs.j.lastRun, outcome: "ended", endedAt: "2026-09-22T10:03:00.000Z" }; S.writeState(ws, st);
  st.jobs.j.lastRun = { ...st.jobs.j.lastRun, note: "late field" }; S.writeState(ws, st);
  let d = S.describe(ws, "j"); assert.equal(d.scheduleApi, 2);
  assert.equal(d.recentRuns.length, 1, "re-saving the same run updates, never duplicates"); assert.equal(d.recentRuns[0].note, "late field");
  assert.equal(d.recentRuns[0].transcript, undefined, "K8b: no transcript key — a name that promised a reader");
  assert.deepEqual(d.recentRuns[0].session, { instance: "x-1", home: join(ws, "agents", "x", "instances", "x-1"), incarnation: null, server: null, delivery: "launched" }, "K8b: session PROVENANCE");
  assert.equal(d.recentRuns[0].key, undefined, "the dedupe key stays internal");
  for (let i = 1; i <= 60; i++) { st.jobs.j.lastRun = { scheduledFor: `2026-09-22T1${String(i).padStart(2, "0").slice(0, 1)}:${String(i % 60).padStart(2, "0")}:00.000Z`, startedAt: `s${i}`, outcome: i % 7 === 0 ? "blocked" : "ended" }; S.writeState(ws, st); }
  d = S.describe(ws, "j"); assert.equal(d.recentRuns.length, 50, "bounded"); assert.equal(d.recentRuns[0].startedAt, "s60", "newest first");
  assert.ok(d.recentRuns.some((r) => r.outcome === "blocked"), "outcomes are kept as the producer wrote them");
  rmSync(ws, { recursive: true, force: true });
});

test("wake records terminal-operation success without re-pasting an unverified adapter observation", async () => {
  const { inputSessionTarget } = await import("../lib/session-input.mjs");
  const ws = workspace(), h = home(ws, "dev-observation"), calls = [];
  let clock = 0;
  const target = { backend: "tmux", socket: "/inert/fixture.sock", session: "fixture", window: "agent" };
  const terminal = { now: () => clock, sleep: (ms) => { clock += ms; }, exec: (bin, args) => {
    assert.equal(bin, "tmux");
    calls.push(args.slice(3));
    if (args[3] === "list-panes") return "%12\t0\tcodex\t123\n";
    if (args.includes("capture-pane")) return "80x24\nsame display\n80x24\n";
    return "";
  } };
  const io = { inspect: () => ({ present: true, state: "unknown" }), input: (_home, text) => {
    const receipt = inputSessionTarget(target, text, terminal);
    assert.equal(receipt.submitted, true);
    assert.equal(receipt.verified, false);
    assert.equal("reason" in receipt, false);
    return receipt;
  } };
  S.addSchedule(ws, { id: "observed-wake", cron: "* * * * *", tz: "UTC", kind: "wake", home: h, message: "literal wake" });
  const reg = { maxConcurrent: 5, workspaces: [ws] }, now = at("2026-09-07T12:00:00Z");
  assert.equal(S.tickWorkspace(ws, { now, io, reg })[0].action, "delivered");
  assert.equal(S.describe(ws, "observed-wake", io).pendingWake, undefined);
  assert.deepEqual(S.tickWorkspace(ws, { now: at("2026-09-07T12:00:30Z"), io, reg }), []);
  assert.equal(calls.filter(a => a[0] === "paste-buffer").length, 1);
  assert.equal(calls.filter(a => a[0] === "send-keys").length, 1);
});
