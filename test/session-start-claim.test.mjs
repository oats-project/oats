// Every session start and restart holds the home's lifecycle claim (#1602, feature
// `lifecycle-claim-start`), as a `start` holder, the way a resume holds it as `resume` (#1559).
// Before, an ordinary start took no claim and could race a retire: it could begin while a retire
// removed the home, and leave a session running in a home that was gone. Now:
//   - a start beside a retire is refused E_INSTANCE_RETIRING, and a retire beside a start
//     E_LIFECYCLE_BUSY (`details.action: "start"`), each before any effect;
//   - a restart holds ONE claim across its stop and its launch: no retire comes between them;
//   - two starts still answer E_SESSION_START_BUSY, as they did at the start lock;
//   - the claim is released on every exit of a start, a failed launch included;
//   - a scheduled start refused at the claim is a skip that holds no slot, and the sweep skips a
//     home a start holds.
// The pair table itself (every arriving command against every holder) is walked by
// test/lifecycle-pair-table.test.mjs. On real tmux: each fixture's own `oats` server
// (v2Deployment), a stand-in harness that records each launch and sleeps. A command "already on
// the home" is the kernel's own CLI held by test/helpers/fs-gate-preload.mjs at the call named,
// never a race against the clock.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn as spawnChild, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { retireClaimPath, startInstanceSession } from "../lib/core.mjs";
import { resumeSessions } from "../lib/session-resume.mjs";
import { OUTCOME, ROW_REASON, SESSION_END } from "../lib/session-resume-contract.mjs";
import { addSchedule, jobLockInfo, tickWorkspace, withHostLock } from "../lib/schedule.mjs";
import { processStartToken } from "../lib/worktree-hooks.mjs";
import { CLI, v2Deployment } from "./helpers/v2-deployment.mjs";
import { waitUntil } from "./helpers/host-fixture.mjs";
import { startGated } from "./helpers/fs-gate-preload.mjs";

const HAS_TMUX = !spawnSync("tmux", ["-V"], { stdio: "ignore" }).error;
const TMUX = { skip: !HAS_TMUX && "tmux is not installed" };
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** One deployment per test: a launch configuration whose harness is the fixture's own file (it
 *  records its start, its pid as the file's content, then sleeps), and a process that lives as long
 *  as the test and is no oats command, whose pid a claim written by hand names. */
function fixture(t) {
  const fx = v2Deployment({ t });
  const records = join(fx.base, "launches");
  mkdirSync(records);
  const executable = join(fx.base, "harness-stand-in");
  writeFileSync(executable, `#!/bin/sh\necho "$$" > '${records}'/"$OATS_INSTANCE.$(date +%s%N).$$"\nexec sleep 600\n`, { mode: 0o755 });
  const localFile = join(fx.dep, "oats-local.yaml");
  writeFileSync(localFile, `${readFileSync(localFile, "utf8")}\nlaunch-configs:\n  stand-in:\n    harness: pi\n    executable: ${JSON.stringify(executable)}\n`);
  const bystander = spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { cwd: "/", stdio: "ignore" });
  fx.beforeCleanup(() => { bystander.kill("SIGKILL"); });
  const f = { fx, bystander: bystander.pid };
  /** The launches of `name`, oldest first: each the pid of the stand-in that recorded it. */
  f.launches = (name) => readdirSync(records).filter((entry) => entry.startsWith(`${name}.`)).sort().map((entry) => Number(readFileSync(join(records, entry), "utf8")));
  /** The CLI's JSON envelope for `argv`. */
  f.cli = (argv) => { const r = fx.cli(argv); try { return JSON.parse(r.stdout); } catch { assert.fail(`no JSON answer from oats ${argv.join(" ")}: ${r.stdout}${r.stderr}`); } };
  f.status = () => Object.fromEntries(f.cli(["status", "--json"]).agents.flatMap((a) => a.instances).map((i) => [i.instance, i]));
  f.sweep = (...extra) => {
    const a = f.cli(["session", "resume", "--deployment", fx.dep, ...extra, "--json"]);
    assert.equal(a.ok, true, JSON.stringify(a));
    return a.result;
  };
  f.start = (home) => f.cli(["session", "start", "--home", home, "--json"]);
  f.resume = (home) => f.cli(["session", "start", "--resume", "--home", home, "--json"]);
  /** A launched home whose session runs: spawned with the stand-in by the CLI (a child, which says
   *  on its own stderr what its start of the fixture's tmux server warns), seen running by a status. */
  f.runningHome = async (name) => {
    const spawned = f.cli(["spawn", "dev", "--name", name, "--launch-config", "stand-in", "--json"]);
    assert.equal(spawned.ok, true, JSON.stringify(spawned));
    const made = spawned.result;
    await waitUntil(() => f.launches(name).length === 1, `${name}'s harness to start`, 30000);
    await waitUntil(() => f.status()[name]?.running === true, `${name} to read as running`, 30000);
    return { name, home: made.home, lock: retireClaimPath(made.home) };
  };
  /** A launched home whose session is lost: running, then its window killed by hand. */
  f.lostHome = async (name) => {
    const i = await f.runningHome(name);
    const { tmux } = readJson(join(i.home, "instance.json"));
    execFileSync("tmux", ["-u", "-S", tmux.socket, "kill-window", "-t", `=${tmux.session}:=${tmux.window}`], { stdio: "ignore" });
    await waitUntil(() => f.status()[name]?.sessionEnd === SESSION_END.LOST, `${name} to read as lost`, 30000);
    return i;
  };
  /** A claim of `action` written by hand at the home's claim path, as lib/claim.mjs writes one: its
   *  holder the bystander, alive (its start token recorded). */
  f.claim = async (i, action) => {
    const processStart = await fx.inEnv(() => processStartToken(f.bystander));
    mkdirSync(dirname(i.lock), { recursive: true });
    writeFileSync(i.lock, JSON.stringify({ action, pid: f.bystander, processStart, nonce: "c".repeat(32), at: new Date().toISOString() }) + "\n");
  };
  f.claimFiles = (i) => existsSync(dirname(i.lock)) ? readdirSync(dirname(i.lock)).filter((entry) => entry.startsWith(`${i.name}.lock`)) : [];
  f.row = (answer, i) => answer.rows.find((r) => r.home === i.home);
  return f;
}
let gated = 0;
/** The kernel's CLI on `i`, held at `gate` (default: once it holds the home's claim, at the
 *  `linkSync` that takes it), its claim checked to be that command's, of `verb`. */
async function held(f, i, argv, verb, gate = { name: "claimed", fn: "linkSync", arg: 1, path: i.lock, when: "after" }) {
  const run = startGated([CLI, ...argv], { cwd: f.fx.dep, env: f.fx.env, gateDir: join(f.fx.base, "gates", `${i.name}-${verb}-${++gated}`), gates: [{ waitMs: 120000, ...gate }] });
  try {
    await run.waitGate(gate.name);
    assert.deepEqual({ pid: readJson(i.lock).pid, action: readJson(i.lock).action }, { pid: run.child.pid, action: verb }, "fixture premise: the claim is the held command's");
  } catch (e) { await run.finish(); throw e; }
  return run;
}
/** Let `run` go and → its JSON envelope, once it has exited on its own. */
async function finished(run, gate = "claimed") {
  run.release(gate);
  const r = await run.done;
  assert.deepEqual(r.timedOut, [], r.stdout + r.stderr);
  return JSON.parse(r.stdout);
}

test("a start beside a held retire is refused E_INSTANCE_RETIRING before any effect, and the retire completes; a retire beside a held start is refused E_LIFECYCLE_BUSY naming the start, and the start completes and releases its claim", TMUX, async (t) => {
  const f = fixture(t);
  const a = await f.lostHome("a1");
  const retire = await held(f, a, ["retire", a.name, "--json"], "retire");
  try {
    const start = f.start(a.home);
    assert.deepEqual([start.ok, start.error?.code, start.error?.details?.action], [false, "E_INSTANCE_RETIRING", "retire"], JSON.stringify(start));
    assert.match(start.error.message, /nothing was started/);
    assert.equal(f.launches(a.name).length, 1, "nothing was started");
    const restart = f.cli(["session", "restart", "--home", a.home, "--json"]);
    assert.equal(restart.error?.code, "E_INSTANCE_RETIRING", JSON.stringify(restart));
    assert.equal(f.launches(a.name).length, 1, "nothing was started");
    retire.release("claimed");
    const r = await retire.done;
    assert.deepEqual([r.code, r.timedOut], [0, []], r.stdout + r.stderr);
  } finally { await retire.finish(); }
  assert.equal(existsSync(a.home), false, "the retire completed");
  assert.deepEqual(f.claimFiles(a), []);

  const b = await f.lostHome("b1");
  const start = await held(f, b, ["session", "start", "--home", b.home, "--json"], "start");
  try {
    const refused = f.cli(["retire", b.name, "--json"]);
    assert.deepEqual([refused.ok, refused.error?.code, refused.error?.details?.action, refused.error?.details?.holder], [false, "E_LIFECYCLE_BUSY", "start", "running"], JSON.stringify(refused));
    assert.equal(refused.error.message, `a start of b1 is already running (pid ${start.child.pid}, since ${readJson(b.lock).at}); nothing was done — wait for it to finish; if it does not end, check that pid by hand, and if it is not an oats session start or restart, remove ${b.lock}, then retry`);
    const plan = f.cli(["instance", "stop", b.name, "--plan", "--json"]);
    const stop = f.cli(["instance", "stop", b.name, "--apply", "--plan-revision", plan.result.planRevision, "--idempotency-key", "k", "--json"]);
    assert.deepEqual([stop.error?.code, stop.error?.details?.action], ["E_LIFECYCLE_BUSY", "start"], JSON.stringify(stop));
    assert.equal(existsSync(b.home), true, "the home is there");
    const answer = await finished(start);
    assert.equal(answer.ok, true, JSON.stringify(answer));
  } finally { await start.finish(); }
  await waitUntil(() => f.launches(b.name).length === 2, "the started harness to run", 30000);
  assert.deepEqual(f.claimFiles(b), [], "the start released its claim");
});

test("a restart holds one claim across its stop and its launch: a retire that arrives after the old harness is stopped and before the new one is launched is refused E_LIFECYCLE_BUSY naming the start, and the restart completes", TMUX, async (t) => {
  const f = fixture(t);
  const i = await f.runningHome("r1");
  const [old] = f.launches(i.name);
  // Held at the restart's own receipt, written once the stop has ended the old harness and before
  // anything is launched.
  const gate = { name: "stopped", fn: "renameSync", arg: 1, path: join(i.home, ".oats-restart.json"), when: "after" };
  const restart = await held(f, i, ["session", "restart", "--home", i.home, "--stop-grace", "10", "--json"], "start", gate);
  try {
    assert.equal(alive(old), false, "fixture premise: the old harness was stopped");
    assert.equal(f.launches(i.name).length, 1, "fixture premise: nothing was launched yet");
    const refused = f.cli(["retire", i.name, "--json"]);
    assert.deepEqual([refused.ok, refused.error?.code, refused.error?.details?.action], [false, "E_LIFECYCLE_BUSY", "start"], JSON.stringify(refused));
    assert.equal(existsSync(join(i.home, "instance.json")), true, "the home is there");
    const answer = await finished(restart, "stopped");
    assert.equal(answer.ok, true, JSON.stringify(answer));
  } finally { await restart.finish(); }
  await waitUntil(() => f.launches(i.name).length === 2 && alive(f.launches(i.name)[1]), "the restarted harness to run", 30000);
  assert.deepEqual(f.claimFiles(i), [], "the restart released its claim");
});

test("two starts answer E_SESSION_START_BUSY as they did at the start lock: a start beside a start or a resume, and a resume beside a start; the sweep skips a lost home a start holds (lifecycle-busy), and reports a resume refused beside a start start-busy", TMUX, async (t) => {
  const f = fixture(t);
  const i = await f.lostHome("s1");
  const start = await held(f, i, ["session", "start", "--home", i.home, "--json"], "start");
  try {
    for (const [what, answer] of [["a start", f.start(i.home)], ["a restart", f.cli(["session", "restart", "--home", i.home, "--json"])], ["a resume", f.resume(i.home)]]) {
      assert.deepEqual([answer.ok, answer.error?.code, answer.error?.details], [false, "E_SESSION_START_BUSY", undefined], `${what} beside a start: ${JSON.stringify(answer)}`);
      assert.match(answer.error.message, new RegExp(`^another start of s1 is in progress \\(pid ${start.child.pid}, since [^)]+\\); nothing was started — `), what);
    }
    const swept = f.row(f.sweep(), i);
    assert.deepEqual([swept?.outcome, swept?.reason], [OUTCOME.SKIPPED, ROW_REASON.LIFECYCLE_BUSY], JSON.stringify(swept));
    assert.ok(swept.message.includes(`is held by a start (${i.lock})`), swept.message);
    assert.equal(f.launches(i.name).length, 1, "nothing was started beside the held start");
    assert.equal((await finished(start)).ok, true);
  } finally { await start.finish(); }
  await waitUntil(() => f.launches(i.name).length === 2, "the held start's harness to run", 30000);

  // A resume holds the claim; a start that arrives is busy.
  const j = await f.lostHome("s2");
  const resume = await held(f, j, ["session", "start", "--resume", "--home", j.home, "--json"], "resume");
  try {
    const answer = f.start(j.home);
    assert.deepEqual([answer.error?.code, answer.error?.details], ["E_SESSION_START_BUSY", undefined], JSON.stringify(answer));
    assert.equal((await finished(resume)).ok, true);
  } finally { await resume.finish(); }

  // The sweep's own start meets a start that took the claim after the sweep read the row.
  const k = await f.lostHome("s3");
  let late;
  try {
    const answer = await f.fx.inEnv(() => resumeSessions({ deployment: f.fx.dep, start: async (row) => {
      if (row.home === k.home) late = await held(f, k, ["session", "start", "--home", k.home, "--json"], "start");
      return f.resume(row.home);
    } }));
    const row = f.row(answer, k);
    assert.deepEqual([row?.outcome, row?.reason, row?.code], [OUTCOME.SKIPPED, ROW_REASON.START_BUSY, "E_SESSION_START_BUSY"], JSON.stringify(row));
    assert.equal((await finished(late)).ok, true);
  } finally { await late?.finish(); }
});

test("a start excludes another through the home's claim alone: held past the point where it begins its work, it has made nothing at .oats-start.lock, and a second start is refused at the claim", TMUX, async (t) => {
  const f = fixture(t);
  const i = await f.lostHome("n1");
  const startLock = join(i.home, ".oats-start.lock");
  // Held where the start reads the home's quarantine marker: after every check it makes before
  // it observes or launches anything.
  const gate = { name: "working", fn: "existsSync", path: join(i.home, ".oats-rollback-incomplete.json") };
  const start = await held(f, i, ["session", "start", "--home", i.home, "--json"], "start", gate);
  try {
    assert.equal(existsSync(startLock), false, "a start makes nothing at .oats-start.lock");
    const answer = f.start(i.home);
    assert.deepEqual([answer.ok, answer.error?.code], [false, "E_SESSION_START_BUSY"], JSON.stringify(answer));
    assert.match(answer.error.message, new RegExp(`^another start of n1 is in progress \\(pid ${start.child.pid}, since [^)]+\\); nothing was started — `));
    assert.equal(f.launches(i.name).length, 1, "nothing was started beside the held start");
    assert.equal((await finished(start, "working")).ok, true);
  } finally { await start.finish(); }
  await waitUntil(() => f.launches(i.name).length === 2, "the held start's harness to run", 30000);
  assert.equal(existsSync(startLock), false, "nothing is left at .oats-start.lock");
});

test("a start whose launch fails releases its claim: the claim names the start while it launches and nothing afterwards, and a later start and a retire both proceed", TMUX, async (t) => {
  const f = fixture(t);
  const i = await f.lostHome("f1");
  let seen;
  // tmux runs as ever, but the window is never made; the claim is read when the launch is tried.
  const io = { exec: (file, argv, options) => {
    if (argv.includes("new-window") || argv.includes("respawn-pane")) {
      seen = existsSync(i.lock) ? readJson(i.lock) : null;
      throw Object.assign(new Error("injected launch failure"), { status: 1 });
    }
    return execFileSync(file, argv, options);
  } };
  const failed = await f.fx.inEnv(() => { try { return startInstanceSession(i.home, { io }); } catch (e) { return e; } });
  assert.equal(failed.code, "E_SESSION_START_FAILED", failed.stack);
  assert.deepEqual({ action: seen?.action, pid: seen?.pid }, { action: "start", pid: process.pid }, "the start held the claim while it launched");
  assert.deepEqual(f.claimFiles(i), [], "and released it");
  assert.equal(f.launches(i.name).length, 1, "nothing was launched");
  // The receipt of the failed launch is kept for the next start, which reconciles it and launches.
  const again = f.start(i.home);
  assert.equal(again.ok, true, JSON.stringify(again));
  await waitUntil(() => f.launches(i.name).length === 2, "the later start's harness to run", 30000);
  assert.deepEqual(f.claimFiles(i), []);
  const retired = f.fx.cli(["retire", i.name, "--json"]);
  assert.equal(retired.status, 0, retired.stdout + retired.stderr);
  assert.equal(existsSync(i.home), false, "the retire proceeded");
});

test("a scheduled start refused at the home's claim is a skip: its reason names the act, it holds no slot, its message stays pending, and it starts at the next due minute once the claim is gone", TMUX, async (t) => {
  const f = fixture(t);
  const i = await f.lostHome("w1");
  await f.claim(i, "stop");
  const ws = f.fx.dep;
  await f.fx.inEnv(() => addSchedule(ws, { id: "wake-w1", cron: "* * * * *", tz: "UTC", kind: "wake", home: i.home, message: "hello" }));
  const tick = (time) => f.fx.inEnv(() => withHostLock(() => tickWorkspace(ws, { now: new Date(time), reg: { maxConcurrent: 2 }, wsList: [ws] })));
  const first = (await tick("2026-10-28T12:00:00Z")).find((r) => r.id === "wake-w1");
  assert.equal(first.action, "skipped", JSON.stringify(first));
  assert.match(first.reason, /^start refused before any effect: a stop of the home is running \(E_LIFECYCLE_BUSY\); /);
  assert.equal(first.pending, true, "the message is still to be delivered");
  assert.equal(await f.fx.inEnv(() => jobLockInfo(ws, "wake-w1")), null, "no slot is held for a harness that was never allocated");
  assert.equal(f.launches(i.name).length, 1, "nothing was started");
  rmSync(i.lock);
  const sameMinute = (await tick("2026-10-28T12:00:30Z")).find((r) => r.id === "wake-w1");
  assert.equal(sameMinute.action, "skipped", "not retried before the next due minute");
  // A claim file that is no claim: the reason says what was established, never that an act runs.
  writeFileSync(i.lock, "{not json");
  const unreadable = (await tick("2026-10-28T12:01:00Z")).find((r) => r.id === "wake-w1");
  assert.match(unreadable.reason, /^start refused before any effect: the home's lifecycle claim cannot be read \(E_LIFECYCLE_BUSY\); /, JSON.stringify(unreadable));
  assert.equal(await f.fx.inEnv(() => jobLockInfo(ws, "wake-w1")), null);
  rmSync(i.lock);
  const next = (await tick("2026-10-28T12:02:00Z")).find((r) => r.id === "wake-w1");
  assert.equal(next.action, "started", JSON.stringify(next));
  await waitUntil(() => f.launches(i.name).length === 2, "the scheduled start's harness to run", 30000);
});

test("a start of a home given through a link answers what a start of the home answers beside a partial upgrade: E_UPGRADE_PARTIAL while no upgrade holds the claim, and E_LIFECYCLE_BUSY naming the upgrade while one does, from the CLI and the kernel, before any effect", TMUX, async (t) => {
  const f = fixture(t);
  const i = await f.lostHome("w1");
  mkdirSync(join(i.home, ".oats"), { recursive: true });
  writeFileSync(join(i.home, ".oats", "upgrade-receipt.retry-upgrade.json"), JSON.stringify({ action: "upgrade", status: "partial", instance: i.name, idempotencyKey: "retry-upgrade", planRevision: "revision-partial" }));
  // Outside the instances directory: the link's own spelling names no claim and no receipt of H.
  const link = join(f.fx.base, "link-to-w1");
  symlinkSync(i.home, link);
  const kernel = (home) => f.fx.inEnv(() => { try { startInstanceSession(home); return null; } catch (e) { return e; } });
  for (const home of [i.home, link]) {
    assert.equal(f.start(home).error.code, "E_UPGRADE_PARTIAL", `the CLI, through ${home}`);
    assert.equal((await kernel(home))?.code, "E_UPGRADE_PARTIAL", `the kernel, through ${home}`);
  }
  await f.claim(i, "upgrade");
  const claimed = readFileSync(i.lock, "utf8");
  for (const home of [i.home, link]) {
    const cli = f.start(home);
    assert.deepEqual([cli.error.code, cli.error.details?.action], ["E_LIFECYCLE_BUSY", "upgrade"], `the CLI, through ${home}: ${JSON.stringify(cli)}`);
    const e = await kernel(home);
    assert.deepEqual([e?.code, e?.details?.action], ["E_LIFECYCLE_BUSY", "upgrade"], `the kernel, through ${home}: ${e?.message}`);
  }
  assert.equal(readFileSync(i.lock, "utf8"), claimed, "the upgrade's claim is untouched");
  assert.equal(f.launches(i.name).length, 1, "nothing was started");
});

const isRoot = process.getuid?.() === 0;
for (const [name, make, code] of [
  ["a directory with no record", () => {}, "E_RUNTIME_ENDPOINT_UNKNOWN"],
  ["a home whose record does not parse", (dir) => writeFileSync(join(dir, "instance.json"), "{not json"), "E_UNIDENTIFIED_INSTANCE_HOME"],
  ["a home whose record is a directory", (dir) => mkdirSync(join(dir, "instance.json")), "E_UNIDENTIFIED_INSTANCE_HOME"],
]) {
  test(`${name} is no home to hold: a start and a resume take no claim and write nothing beside it, and answer ${code} whether or not its parent can be written`, { skip: isRoot && "root writes through a mode" }, (t) => {
    const f = fixture(t);
    const parentOf = (label) => join(f.fx.base, `not-instances-${label}`);
    for (const [label, mode] of [["writable", 0o755], ["unwritable", 0o555]]) {
      const parent = parentOf(label);
      mkdirSync(parent);
      const dir = join(parent, "typed-by-mistake");
      mkdirSync(dir);
      make(dir);
      chmodSync(parent, mode);
      try {
        for (const answer of [f.start(dir), f.resume(dir)]) assert.equal(answer.error?.code, code, `${label} parent: ${JSON.stringify(answer)}`);
        assert.deepEqual(readdirSync(parent), ["typed-by-mistake"], `${label} parent: nothing is left beside it`);
      } finally { chmodSync(parent, 0o755); }
    }
  });
}

test("a record that cannot be read refuses a start and a resume before the claim: a holder of the home's claim is not disturbed and does not change the answer", TMUX, async (t) => {
  const f = fixture(t);
  const i = await f.lostHome("w1");
  const record = readFileSync(join(i.home, "instance.json"), "utf8");
  await f.claim(i, "stop");
  const claimed = readFileSync(i.lock, "utf8");
  writeFileSync(join(i.home, "instance.json"), "{not json");
  for (const answer of [f.start(i.home), f.resume(i.home)]) assert.equal(answer.error?.code, "E_UNIDENTIFIED_INSTANCE_HOME", JSON.stringify(answer));
  assert.equal(readFileSync(i.lock, "utf8"), claimed, "the holder's claim is untouched");
  writeFileSync(join(i.home, "instance.json"), record);
  assert.equal(f.launches(i.name).length, 1, "nothing was started");
});
