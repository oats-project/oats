// Session resume (#1559) on real tmux: the fixture's own `oats` server in a private TMUX_TMPDIR,
// stand-in harnesses (one node script, named by absolute path in each deployment's launch
// configurations) that record the argv and environment they were started with, write a transcript
// where their harness would (Claude's projects, pi's sessions), and idle. Two deployments in one
// machine registry, A and C, differ in their launch configurations.
//
// The homes are started, one is stopped with OATS, one ends on its own (`exit 0`), and the tmux
// server is killed. `oats session resume --json` then brings back the lost ones in their own
// conversations (asserted on the argv the stand-ins received), under their own deployment's launch
// configuration; the stopped and the exited ones are not listed; a second sweep reports `already-running` and starts nothing; a refusal is reported again
// (`start-refused-retrying`) without a second start until its delay has run; a held lock answers E_RESUME_BUSY, and a lock that
// needs a person E_RESUME_LOCK_STUCK.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RESUME_NOTICE, restartInstanceSession, stopInstanceSession } from "../lib/core.mjs";
import { readStartExited } from "../lib/session-end.mjs";
import { bootId, readBootNote, resumeSessions } from "../lib/session-resume.mjs";
import { readSeen, seenFile } from "../lib/session-seen.mjs";
import { FRESH_REASON, OUTCOME, ROW_REASON, SESSION_END } from "../lib/session-resume-contract.mjs";
import { fixtureBase, isolateSessionEnvironment, oatsSocket, waitUntil } from "./helpers/host-fixture.mjs";
import { CLI, v2Deployment } from "./helpers/v2-deployment.mjs";
import { fakeBin } from "./helpers/fake-ssh.mjs";
import { agentScopeWarning, isAgentScopeWarning } from "../lib/tmux-server-scope.mjs";
import { readEvents } from "../lib/instance-events.mjs";
import { START_ENV_FILE, START_ENV_KEY_FILE, launchEnvUnverifiedWarning } from "../lib/start-env.mjs";
import { processStartToken } from "../lib/worktree-hooks.mjs";

const hasTmux = !spawnSync("tmux", ["-V"], { stdio: "ignore" }).error;
/** The PATH this file was started with: the isolated environment (test.before) keeps a small one. */
const HOST_PATH = process.env.PATH;
const TMUX = { skip: !hasTmux && "tmux is not installed" };
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// The fixture, made in test.before and removed in test.after (docs/implementation.md, "Tests and
// gates"): the directory, the isolated environment with its private tmux server, the stand-in, the
// deployments and the machine's registry.
let base, socket, oatsHome, records, standIn, machine;
let restoreEnvironment = () => {};
const deployments = {};
/** Deployments a test makes for itself: their homes run on the one server, so they are removed with
 *  the others, once it is gone. */
const later = [];
const config = (harness, mark, extra = {}) => ({ harness, executable: standIn, env: { RESUME_MARK: mark, STANDIN_HARNESS: harness,
  ...(harness === "claude" ? { CLAUDE_CONFIG_DIR: join(base, `claude-${mark}`) } : harness === "pi" ? { PI_CODING_AGENT_DIR: join(base, `pi-${mark}`) } : { CODEX_HOME: join(base, `codex-${mark}`) }), ...(extra.env ?? {}) }, args: extra.args ?? [] });

test.before(() => {
  if (!hasTmux) return;
  base = fixtureBase("oats-resume-");
  restoreEnvironment = isolateSessionEnvironment(base);
  socket = oatsSocket();
  oatsHome = join(base, "oats-home");
  records = join(base, "argv");
  mkdirSync(records, { recursive: true });

  // The stand-in harness. Its argv, RESUME_MARK and RESUME_SECRET go to <records>/<instance>.<n>.json.
  // A fresh launch (no --resume / --session) writes a transcript whose cwd is the home, unless
  // NO_TRANSCRIPT is set. `exit-now` in the home: it ends at once with status 0. `show-dialog` in the
  // home: a resumed launch paints Claude's resume-cost dialog; otherwise it paints Claude's banner.
  standIn = join(base, "stand-in");
  writeFileSync(standIn, `#!${process.execPath}
const { existsSync, mkdirSync, realpathSync, renameSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const args = process.argv.slice(2), env = process.env, home = env.OATS_INSTANCE_HOME;
const resumed = args.includes("--resume") || args.includes("--session");
const file = join(${JSON.stringify(records)}, env.OATS_INSTANCE + "." + Date.now() + "." + process.pid + ".json");
writeFileSync(file + ".tmp", JSON.stringify({ args, mark: env.RESUME_MARK ?? null, secret: env.RESUME_SECRET ?? null }));
renameSync(file + ".tmp", file);
if (!resumed && !env.NO_TRANSCRIPT && env.STANDIN_HARNESS !== "codex") {
  const id = randomUUID(), cwd = realpathSync(process.cwd()), now = new Date().toISOString();
  if (env.STANDIN_HARNESS === "pi") {
    const dir = join(env.PI_CODING_AGENT_DIR, "sessions", "--home--");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, now.replace(/[:.]/g, "-") + "_" + id + ".jsonl"), JSON.stringify({ type: "session", version: 3, id, timestamp: now, cwd }) + "\\n");
  } else {
    const dir = join(env.CLAUDE_CONFIG_DIR, "projects", "p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, id + ".jsonl"), JSON.stringify({ type: "user", cwd, sessionId: id }) + "\\n");
  }
}
if (existsSync(join(home, "exit-now")) || env.EXIT_NOW) process.exit(0);
process.stdout.write(resumed && existsSync(join(home, "show-dialog"))
  ? " This session is 3d old and 912k tokens.\\n\\n ❯ 1. Resume from summary (recommended)\\n   2. Resume full session as-is\\n   3. Don't ask me again\\n"
  : "Claude Code v2.1.308\\n");
setInterval(() => {}, 1 << 30);
`, { mode: 0o755 });

  deployments.A = v2Deployment({ name: "a", local: { "launch-configs": { "claude-a": config("claude", "dep-a", { args: ["--from-a"] }), "pi-a": config("pi", "dep-a"), "codex-a": config("codex", "dep-a"), "exit-a": config("claude", "dep-a", { env: { EXIT_NOW: "1", NO_TRANSCRIPT: "1" } }) } } });
  deployments.C = v2Deployment({ name: "c", local: { "launch-configs": {
    "claude-c": config("claude", "dep-c", { args: ["--from-c"], env: { NO_TRANSCRIPT: "1" } }),
    "needs-src": config("claude", "dep-c", { env: { RESUME_SECRET: { fromEnv: "RESUME_TEST_SRC" } } }) } } });
  // One machine: one OATS_HOME_DIR, whose registry lists the two deployments.
  machine = { OATS_HOME_DIR: oatsHome };
  mkdirSync(join(oatsHome, "config"), { recursive: true });
  writeFileSync(join(oatsHome, "config", "deployments.json"), JSON.stringify({ schemaVersion: 1, imports: {},
    deployments: Object.values(deployments).map((fx) => ({ path: fx.dep, addedAt: "2026-10-27T00:00:00.000Z", via: "cli" })) }, null, 2) + "\n");
});

// The private server is killed first, so each fixture's check that nothing still works in it holds;
// the directory is removed whatever failed before.
test.after(() => {
  if (!base) return;
  try { execFileSync("tmux", ["-u", "-S", socket, "kill-server"], { stdio: "ignore" }); } catch { /* gone */ }
  let failed;
  for (const fx of [...Object.values(deployments), ...later]) { try { fx.cleanup(); } catch (e) { failed ??= e; } }
  try { restoreEnvironment(); } finally { rmSync(base, { recursive: true, force: true }); }
  if (failed) throw failed;
});

/** The stand-in's records of `instance`, oldest first. */
const launches = (instance) => readdirSync(records).filter((f) => f.startsWith(`${instance}.`) && f.endsWith(".json"))
  .sort((a, b) => Number(a.split(".")[1]) - Number(b.split(".")[1]) || a.localeCompare(b)).map((f) => readJson(join(records, f)));
const cli = (fx, args, extra = {}) => fx.cli(args, { env: { ...machine, ...extra } });
const ok = (r, what) => { assert.equal(r.status, 0, `${what}: ${r.stdout}${r.stderr}`); const env = r.json(); assert.equal(env.ok, true, `${what}: ${r.stdout}`); return env.result; };
const statusRows = (fx) => {
  const r = cli(fx, ["status", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return Object.fromEntries(JSON.parse(r.stdout).agents.flatMap((a) => a.instances).map((i) => [i.instance, i]));
};
const transcripts = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".jsonl")).map(String) : []);

async function spawnHome(fx, name, launchConfig, { launch = false, env = {} } = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, { PATH: fx.env.PATH, ...env });
  try { return (await fx.spawn("dev", { name, launchConfig, ...(launch ? { launch: true } : {}) })).home; }
  finally { for (const k of ["PATH", ...Object.keys(env)]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
/** Kill the window of `home`'s session by hand: no marker, no stop; the home reads lost. */
function killWindow(home) {
  const { tmux } = readJson(join(home, "instance.json"));
  execFileSync("tmux", ["-u", tmux.socket.includes("/") ? "-S" : "-L", tmux.socket, "kill-window", "-t", `${tmux.session}:${tmux.window}`], { stdio: "ignore" });
}
async function startHome(fx, home, name, extra = {}) {
  ok(cli(fx, ["session", "start", "--home", home, "--json"], extra), `start ${name}`);
  await waitUntil(() => launches(name).length > 0, `${name}'s stand-in to run`);
}

test("after the tmux server dies, the sweep resumes the lost homes in their own conversations, under their own deployment's launch configuration; stopped and exited homes stay as they are", TMUX, async () => {
  const { A, C } = deployments;
  const homes = {};
  // A: lost ones of each harness, one stopped with OATS, one that ends on its own, one launched by
  // spawn itself (its window's marker and startId), one that will stop at the resume-cost dialog.
  for (const [name, cfg] of [["a1", "claude-a"], ["a2", "claude-a"], ["a3", "claude-a"], ["a4", "pi-a"], ["a5", "codex-a"], ["a7", "claude-a"]]) homes[name] = await spawnHome(A, name, cfg);
  writeFileSync(join(homes.a3, "exit-now"), "");
  writeFileSync(join(homes.a7, "show-dialog"), "");
  for (const name of ["a1", "a2", "a3", "a4", "a5", "a7"]) await startHome(A, homes[name], name);
  homes.a6 = await spawnHome(A, "a6", "claude-a", { launch: true });
  await waitUntil(() => launches("a6").length > 0, "a6's stand-in, launched by spawn, to run");
  const spawned = readJson(join(homes.a6, "instance.json"));
  assert.match(spawned.startId ?? "", /^[0-9a-f-]{36}$/, "spawn records the start id of its launch");
  // C: its own launch configurations.
  homes.c1 = await spawnHome(C, "c1", "claude-c");
  homes.c2 = await spawnHome(C, "c2", "needs-src", { env: { RESUME_TEST_SRC: "s3cret" } });
  await startHome(C, homes.c1, "c1");
  await startHome(C, homes.c2, "c2", { RESUME_TEST_SRC: "s3cret" });
  assert.equal(launches("c2")[0].secret, "s3cret");

  // a2 is stopped with OATS; a3 ended by itself with status 0 (its marker names its start).
  const stopped = await A.inEnv(() => stopInstanceSession(homes.a2, { graceMs: 5000 }));
  assert.equal(stopped.stopped, true);
  assert.equal(readJson(join(homes.a2, ".oats-stop.json")).startId, readJson(join(homes.a2, "instance.json")).startId, "the stop receipt names the start it ended");
  await waitUntil(() => readStartExited(homes.a3) !== null, "a3's exit marker");
  assert.deepEqual(readStartExited(homes.a3), { startId: readJson(join(homes.a3, "instance.json")).startId, status: 0 });

  const conversation = (name) => {
    const dir = name === "a4" ? join(base, "pi-dep-a", "sessions") : join(base, "claude-dep-a", "projects");
    const files = transcripts(dir).filter((f) => readFileSync(join(dir, f), "utf8").includes(JSON.stringify(homes[name])));
    assert.equal(files.length, 1, `${name} wrote one transcript: ${files}`);
    return name === "a4" ? JSON.parse(readFileSync(join(dir, files[0]), "utf8")).id : files[0].split("/").pop().replace(/\.jsonl$/, "");
  };
  const ids = { a1: conversation("a1"), a4: conversation("a4"), a6: conversation("a6"), a7: conversation("a7") };

  // A status while they run: what the kernel saw of them, read by the sweep (lib/session-seen.mjs).
  const runningNow = { ...statusRows(A), ...statusRows(C) };
  for (const name of ["a1", "a4", "a5", "a6", "a7", "c1", "c2"]) assert.equal(runningNow[name].running, true, `${name} runs`);

  // The shutdown: the server is killed under the live harnesses. No marker is written.
  execFileSync("tmux", ["-u", "-S", socket, "kill-server"], { stdio: "ignore" });
  await waitUntil(() => !existsSync(socket) || spawnSync("tmux", ["-u", "-S", socket, "has-session"]).status !== 0, "the server to be gone");
  const rowsA = statusRows(A);
  assert.deepEqual(Object.fromEntries(Object.entries(rowsA).map(([n, r]) => [n, [r.running, r.sessionEnd]])),
    { a1: [false, SESSION_END.LOST], a2: [false, SESSION_END.STOPPED], a3: [false, SESSION_END.EXITED], a4: [false, SESSION_END.LOST], a5: [false, SESSION_END.LOST], a6: [false, SESSION_END.LOST], a7: [false, SESSION_END.LOST] });

  // Exited and stopped homes are refused one by one, before anything starts.
  for (const name of ["a2", "a3"]) {
    const r = cli(A, ["session", "start", "--resume", "--home", homes[name], "--json"]);
    assert.equal(r.status, 1, r.stdout);
    assert.equal(r.json().error.code, "E_RESUME_NOT_LOST", r.stdout);
  }
  const before = (name) => launches(name).length;
  const counts = Object.fromEntries(Object.keys(homes).map((n) => [n, before(n)]));

  // --plan: the prediction, nothing started, no lock or note.
  const plan = ok(cli(A, ["session", "resume", "--plan", "--json"]), "plan");
  assert.equal(plan.plan, true);
  const planned = Object.fromEntries(plan.rows.map((r) => [r.instance, [r.outcome, r.reason ?? r.sessionId ?? null]]));
  assert.deepEqual(planned, { a1: [OUTCOME.RESUMED, ids.a1], a4: [OUTCOME.RESUMED, ids.a4], a5: [OUTCOME.FRESH, FRESH_REASON.RESUME_UNPROVEN], a6: [OUTCOME.RESUMED, ids.a6], a7: [OUTCOME.RESUMED, ids.a7], c1: [OUTCOME.FRESH, FRESH_REASON.NO_CONVERSATION], c2: [OUTCOME.REFUSED, ROW_REASON.START_REFUSED] });
  assert.equal(plan.rows.find((r) => r.instance === "c2").code, "E_LAUNCH_ENV_MISSING", "a plan predicts the start's refusal of an unset reference");
  assert.deepEqual([existsSync(join(oatsHome, "session-resume", "lock")), existsSync(join(oatsHome, "session-resume", "note.json"))], [false, false], "a plan takes no lock and writes no note");
  const judgements = (fx) => Object.fromEntries(Object.entries(readSeen(join(fx.dep, "agents")).homes).map(([home, r]) => [home.split("/").pop(), r.judgedBy?.outcome ?? null]));
  assert.deepEqual(Object.values(judgements(A)).filter(Boolean), [], "a plan judges no loss");
  assert.deepEqual(Object.fromEntries(Object.keys(homes).map((n) => [n, before(n)])), counts, "a plan starts nothing");
  const refusedSeen = readSeen(join(C.dep, "agents")).homes[homes.c2];

  // The sweep. The envelope is the standard one; exit 0 whatever the rows say.
  const swept = cli(A, ["session", "resume", "--json"]);
  assert.equal(swept.status, 0, swept.stdout + swept.stderr);
  const envelope = swept.json();
  assert.deepEqual(Object.keys(envelope).filter((k) => k !== "warnings"), ["schemaVersion", "ok", "result"]);
  assert.equal(envelope.schemaVersion, 1);
  const answer = envelope.result;
  assert.deepEqual([answer.schemaVersion, answer.plan], [1, false]);
  assert.deepEqual(answer.deployments, [
    { deployment: A.dep, state: "ok", swept: true }, { deployment: C.dep, state: "ok", swept: true },
  ].sort((x, y) => (x.deployment < y.deployment ? -1 : 1)));
  const rows = Object.fromEntries(answer.rows.map((r) => [r.instance, r]));
  assert.deepEqual(Object.keys(rows).sort(), ["a1", "a4", "a5", "a6", "a7", "c1", "c2"], "stopped and exited homes are not listed");
  for (const r of answer.rows) {
    assert.deepEqual(Object.keys(r).slice(0, 4), ["deployment", "instance", "home", "outcome"]);
    if (r.warnings !== undefined) assert.ok(Array.isArray(r.warnings) && r.warnings.length && r.warnings.every((w) => typeof w === "string"), JSON.stringify(r.warnings));
  }
  const outcome = (r) => [r.outcome, r.reason ?? null, r.sessionId ?? null, r.code ?? null];
  assert.deepEqual(outcome(rows.a1), [OUTCOME.RESUMED, null, ids.a1, null]);
  assert.deepEqual(outcome(rows.a4), [OUTCOME.RESUMED, null, ids.a4, null]);
  assert.deepEqual(outcome(rows.a5), [OUTCOME.FRESH, FRESH_REASON.RESUME_UNPROVEN, null, null]);
  assert.deepEqual(outcome(rows.a6), [OUTCOME.RESUMED, null, ids.a6, null]);
  assert.deepEqual(outcome(rows.a7), [OUTCOME.BLOCKED, ROW_REASON.RESUME_CONFIRMATION, ids.a7, null]);
  assert.deepEqual(outcome(rows.c1), [OUTCOME.FRESH, FRESH_REASON.NO_CONVERSATION, null, null]);
  assert.deepEqual(outcome(rows.c2), [OUTCOME.REFUSED, ROW_REASON.START_REFUSED, null, "E_LAUNCH_ENV_MISSING"]);
  assert.match(rows.c2.message, /RESUME_TEST_SRC/);

  // What each stand-in received: the selector and the notice; the fresh ones their task prompt.
  const last = (name) => launches(name).at(-1);
  await waitUntil(() => ["a1", "a4", "a5", "a6", "a7", "c1"].every((n) => before(n) === counts[n] + 1), "each started home's stand-in to run once more");
  assert.deepEqual(last("a1").args, ["--resume", ids.a1, "--from-a", "--", RESUME_NOTICE]);
  assert.equal(last("a1").mark, "dep-a", "A's home under A's launch configuration");
  assert.deepEqual(last("a6").args.slice(0, 2), ["--resume", ids.a6]);
  const pi = last("a4").args;
  assert.deepEqual(pi.slice(pi.indexOf("--session"), pi.indexOf("--session") + 3), ["--session", ids.a4, RESUME_NOTICE]);
  assert.ok(!pi.includes("@TASK.md"));
  assert.equal(last("a5").args.at(-1), "Read TASK.md in this directory first: it is your briefing and your task.", "Codex: the fresh start");
  assert.ok(!last("a5").args.includes("resume"));
  assert.deepEqual(last("c1").args, ["--from-c", "--", "@TASK.md"], "C's home under C's launch configuration, fresh (R2)");
  assert.equal(last("c1").mark, "dep-c");
  assert.equal(before("c2"), counts.c2, "a refused start launched nothing");

  // What is persisted stays the ordinary launch: instance.json, the pending receipt and the recipe.
  for (const name of ["a1", "a4"]) {
    const meta = readJson(join(homes[name], "instance.json")), pending = readJson(join(homes[name], ".oats-start-pending.json"));
    for (const [what, command] of [["instance.json", meta.command], ["the pending receipt", pending.command]]) {
      assert.doesNotMatch(command, /--resume|--session|OATS resumed/, `${name}: ${what}`);
      assert.match(command, /@TASK\.md/, `${name}: ${what}`);
    }
    assert.equal(JSON.stringify(meta.launch).includes(ids[name]), false, `${name}: the recipe`);
  }

  // Each home the sweep started is seen running for its new start, with no loss and no judgement.
  // c2's start was refused: its loss record is kept, unjudged.
  for (const [fx, names] of [[A, ["a1", "a4", "a5", "a6", "a7"]], [C, ["c1"]]]) {
    const seen = readSeen(join(fx.dep, "agents")).homes;
    for (const name of names) {
      const current = readJson(join(homes[name], "instance.json")).startId, record = seen[homes[name]];
      assert.notEqual(current, runningNow[name].startId, `${name} has a new start`);
      assert.equal(record.startId, current, `${name} is seen for its current start`);
      assert.ok(Number.isFinite(Date.parse(record.lastSeenRunningAt)), `${name} was seen running`);
      assert.equal(record.firstNotRunningAt, null, `${name}'s new start has no loss`);
      assert.equal(record.firstNotRunningBoot, null);
      assert.equal(record.judgedBy, null, `${name}'s new start is not judged`);
    }
  }
  assert.deepEqual(readSeen(join(C.dep, "agents")).homes[homes.c2], refusedSeen, "c2's refused start keeps its loss record");
  assert.equal(refusedSeen.judgedBy, null, "c2's loss is not judged");

  // A second sweep: the resumed homes run; nothing is started again. c2's refusal is not due again
  // within its first minute: it is reported with its code, not started (on a host that has a boot
  // id; without one nothing is noted, and the sweep tries c2 again).
  const again = ok(cli(A, ["session", "resume", "--json"]), "second sweep");
  const second = Object.fromEntries(again.rows.map((r) => [r.instance, [r.outcome, r.reason ?? null, r.code ?? null]]));
  for (const name of ["a1", "a4", "a5", "a6", "a7", "c1"]) assert.deepEqual(second[name], [OUTCOME.ALREADY_RUNNING, null, null], name);
  assert.deepEqual(second.c2, [OUTCOME.REFUSED, bootId() ? ROW_REASON.START_REFUSED_RETRYING : ROW_REASON.START_REFUSED, "E_LAUNCH_ENV_MISSING"]);
  const waiting = again.rows.find((r) => r.instance === "c2");
  if (bootId()) assert.ok(Date.parse(waiting.nextAttemptAt) > Date.now() - 60_000 && Date.parse(waiting.nextAttemptAt) <= Date.now() + 60_000, `c2 says when it is tried again: ${waiting.nextAttemptAt}`);
  assert.equal(before("c2"), counts.c2);
  for (const name of ["a1", "a4", "a5", "a6", "a7", "c1"]) assert.equal(before(name), counts[name] + 1, `${name} was not started again`);

  // A held lock: E_RESUME_BUSY through the standard failure envelope, nothing started.
  // The holder is this process, as a sweep's claim names it.
  const lock = join(oatsHome, "session-resume", "lock");
  writeFileSync(lock, JSON.stringify({ bootId: bootId(), pid: process.pid, processStart: processStartToken(process.pid), nonce: "a".repeat(32), at: new Date().toISOString() }) + "\n");
  const busy = cli(A, ["session", "resume", "--json"]);
  assert.equal(busy.status, 1, busy.stdout);
  const failure = busy.json();
  assert.deepEqual([failure.schemaVersion, failure.ok, failure.error.code], [1, false, "E_RESUME_BUSY"]);
  assert.equal(failure.error.message, `another session resume on this machine holds ${lock} (pid ${process.pid} holds it); nothing was started`);
  rmSync(lock);
  // A lock that needs a person: E_RESUME_LOCK_STUCK through the same envelope, with the lock's path
  // and what was found in its details, nothing started and the directory left.
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, bootId: bootId() }));
  const stuck = cli(A, ["session", "resume", "--json"]);
  assert.equal(stuck.status, 1, stuck.stdout);
  const refusal = stuck.json();
  assert.deepEqual([refusal.schemaVersion, refusal.ok, refusal.error.code, refusal.error.details], [1, false, "E_RESUME_LOCK_STUCK", { lock, found: "directory" }]);
  assert.match(refusal.error.message, /is a lock directory written by an earlier kernel\); once no earlier oats is running on this machine, remove the directory /);
  assert.deepEqual(readdirSync(lock), ["owner.json"]);
  rmSync(lock, { recursive: true });
});

test("a home launched by spawn whose harness exits on its own retires without a recovery copy caused by its exit marker", TMUX, async () => {
  const { A } = deployments;
  // `exit-a`: the stand-in ends at once with status 0, writing nothing in the home. The home then
  // holds the spawn's bytes and what the kernel wrote, the exit marker of spawn's own window included.
  const spawned = cli(A, ["spawn", "dev", "--name", "r1", "--launch-config", "exit-a", "--json"]);
  const home = ok(spawned, "spawn r1").home;
  const startId = readJson(join(home, "instance.json")).startId;
  assert.match(startId ?? "", /^[0-9a-f-]{36}$/, "spawn records its launch's start id");
  await waitUntil(() => readStartExited(home) !== null, "the exit marker of spawn's window");
  assert.deepEqual(readStartExited(home), { startId, status: 0 });
  assert.equal(statusRows(A).r1.sessionEnd, SESSION_END.EXITED);
  // The spawn's launch recorded its launch environment (none to digest) after the baseline.
  assert.deepEqual(readJson(join(home, START_ENV_FILE)), { startId, digests: {} });
  assert.equal(statSync(join(home, START_ENV_KEY_FILE)).size, 32);
  const retired = cli(A, ["retire", "r1", "--json"]);
  assert.equal(retired.status, 0, retired.stdout + retired.stderr);
  assert.equal(existsSync(home), false, "the home is gone");
  const recovery = join(dirname(home), ".oats-retirement", "recovery");
  assert.deepEqual(existsSync(recovery) ? readdirSync(recovery).filter((e) => e.includes("r1-")) : [], [], "no recovery copy");
});

test("a retire that keeps a recovery copy of a launched home leaves its launch environment's key and record out of it: work is kept, no key material leaves the home", TMUX, async () => {
  const { A } = deployments;
  const home = ok(cli(A, ["spawn", "dev", "--name", "r2", "--launch-config", "exit-a", "--json"]), "spawn r2").home;
  await waitUntil(() => readStartExited(home) !== null, "r2's harness to end");
  assert.ok(existsSync(join(home, START_ENV_FILE)) && existsSync(join(home, START_ENV_KEY_FILE)), "premise: the spawn recorded");
  const key = readFileSync(join(home, START_ENV_KEY_FILE));
  // Work the retire must keep, and a temporary file a cut-short write left.
  writeFileSync(join(home, "NOTES.md"), "kept\n");
  writeFileSync(join(home, `${START_ENV_FILE}.tmp-1-abc`), "partial");
  const retired = cli(A, ["retire", "r2", "--json"]);
  assert.equal(retired.status, 0, retired.stdout + retired.stderr);
  assert.equal(existsSync(home), false, "the home is gone");
  const recovery = join(dirname(home), ".oats-retirement", "recovery");
  const copies = readdirSync(recovery).filter((e) => e.includes("r2-"));
  assert.equal(copies.length, 1, `one recovery copy: ${copies}`);
  const copied = join(recovery, copies[0], "home");
  assert.equal(readFileSync(join(copied, "NOTES.md"), "utf8"), "kept\n", "the work is kept");
  assert.deepEqual(readdirSync(copied).filter((n) => n.startsWith(".oats-start-env")), [], "no key, record or temporary file of them");
  assert.deepEqual(filesHolding(recovery, key), [], "the key's bytes are in no recovered file");
});

test("`session resume --deployment <dir>` sweeps that deployment alone, registered or not; a deployment removed from the registry is not swept; a stop of a lost home, and of an exited home from before 0.69, records the stop and keeps it stopped", TMUX, async () => {
  const D = v2Deployment({ name: "d", local: { "launch-configs": { "claude-d": config("claude", "dep-d"), "exit-d": config("claude", "dep-d", { env: { EXIT_NOW: "1", NO_TRANSCRIPT: "1" } }) } } });
  later.push(D);
  const homes = {};
  for (const name of ["d1", "d2"]) { homes[name] = await spawnHome(D, name, "claude-d"); await startHome(D, homes[name], name); }
  const seenRunning = statusRows(D);
  assert.deepEqual([seenRunning.d1.running, seenRunning.d2.running], [true, true], "a status sees them run");
  // d1 and d2 lose their windows (killed by hand: no marker, no stop).
  for (const name of ["d1", "d2"]) killWindow(homes[name]);
  // d3: launched by spawn, its harness ended by itself; then made a home from before 0.69, which
  // records no start id and whose window wrote no marker.
  homes.d3 = ok(cli(D, ["spawn", "dev", "--name", "d3", "--launch-config", "exit-d", "--json"]), "spawn d3").home;
  await waitUntil(() => readStartExited(homes.d3) !== null, "d3's exit marker");
  rmSync(join(homes.d3, ".oats-start-exited"));
  const legacy = readJson(join(homes.d3, "instance.json"));
  delete legacy.startId;
  writeFileSync(join(homes.d3, "instance.json"), JSON.stringify(legacy, null, 2) + "\n");
  await waitUntil(() => { const r = statusRows(D); return ["d1", "d2", "d3"].every((n) => r[n].sessionEnd === SESSION_END.LOST); }, "d1, d2 and d3 to read lost");

  // The explicit form, on a deployment the registry does not list; its refusals.
  const plan = ok(cli(D, ["session", "resume", "--deployment", D.dep, "--plan", "--json"]), "plan --deployment");
  assert.deepEqual(plan.deployments, [{ deployment: D.dep, state: "ok", swept: true }]);
  assert.deepEqual(plan.rows.map((r) => [r.instance, r.outcome, r.reason ?? null]), [["d1", OUTCOME.RESUMED, null], ["d2", OUTCOME.RESUMED, null], ["d3", OUTCOME.SKIPPED, ROW_REASON.NOT_SEEN_RECENTLY]], "d3 was never seen running");
  for (const [args, code] of [[["--deployment"], "E_BAD_ARGS"], [["--deployment", join(D.base, "nowhere")], "E_BAD_ARGS"]]) {
    const r = cli(D, ["session", "resume", ...args, "--plan", "--json"]);
    assert.equal(r.status, 1, r.stdout);
    assert.equal(r.json().error.code, code, `${args.join(" ")}: ${r.stdout}`);
  }
  const captured = cli(D, ["status", "--deployment", D.dep, "--json"]);
  assert.equal(captured.json().error.code, "E_UNSUPPORTED_MODE", "--deployment stays a refused captured selector for other commands");

  // Registered, then removed: its tombstone is not swept, and nothing of it starts.
  ok(cli(D, ["deployments", "add", D.dep, "--json"]), "deployments add");
  assert.ok(ok(cli(D, ["session", "resume", "--plan", "--json"]), "registered plan").deployments.some((d) => d.deployment === D.dep), "fixture premise: a registered deployment is swept");
  ok(cli(D, ["deployments", "remove", D.dep, "--json"]), "deployments remove");
  const counts = Object.fromEntries(["d1", "d2", "d3"].map((n) => [n, launches(n).length]));
  const sweep = ok(cli(D, ["session", "resume", "--json"]), "registry sweep");
  assert.equal(sweep.deployments.some((d) => d.deployment === D.dep), false, "the removed deployment is not listed");
  assert.equal(sweep.rows.some((r) => r.deployment === D.dep), false, "nor are its homes");
  assert.deepEqual(Object.fromEntries(["d1", "d2", "d3"].map((n) => [n, launches(n).length])), counts, "nothing of it was started");

  // Stopped with OATS while lost: nothing to signal, the stop recorded; both stay stopped.
  for (const name of ["d1", "d3"]) {
    const s = await D.inEnv(() => stopInstanceSession(homes[name], { graceMs: 5000 }));
    assert.deepEqual([s.stopped, s.alreadyIdle], [false, true], name);
    const receipt = readJson(join(homes[name], ".oats-stop.json"));
    assert.deepEqual([receipt.stop, receipt.startId], [null, readJson(join(homes[name], "instance.json")).startId ?? null], name);
  }
  const rows = statusRows(D);
  assert.deepEqual(["d1", "d2", "d3"].map((n) => rows[n].sessionEnd), [SESSION_END.STOPPED, SESSION_END.LOST, SESSION_END.STOPPED]);
  const swept = ok(cli(D, ["session", "resume", "--deployment", D.dep, "--json"]), "sweep --deployment");
  assert.deepEqual(swept.rows.map((r) => [r.instance, r.outcome]), [["d2", OUTCOME.RESUMED]]);
  await waitUntil(() => launches("d2").length === counts.d2 + 1, "d2's stand-in to run again");
  assert.deepEqual([launches("d1").length, launches("d3").length], [counts.d1, counts.d3], "the stopped homes were not started");
});

test("a home lost again after each resume is started by sweeps at most 3 times in an hour, then answered keeps-getting-lost with the time a sweep starts it again, predicted by --plan; a start by hand is not counted; the count is one boot's, and in another boot the loss is started again and counted afresh", { skip: TMUX.skip || (!bootId() && "this host has no boot id: nothing is counted") }, async () => {
  const E = v2Deployment({ name: "e", local: { "launch-configs": { "claude-e": config("claude", "dep-e") } } });
  later.push(E);
  const home = await spawnHome(E, "e1", "claude-e");
  await startHome(E, home, "e1");
  const notePath = join(oatsHome, "session-resume", "note.json");
  const count = () => (existsSync(notePath) ? readJson(notePath).starts?.[home]?.length : undefined);
  // Seen running by a status for its current start, then lost: a loss the sweep vouches for.
  const lose = async () => {
    await waitUntil(() => statusRows(E).e1.running === true, "a status to see e1 run");
    killWindow(home);
    await waitUntil(() => statusRows(E).e1.sessionEnd === SESSION_END.LOST, "e1 to read lost");
  };
  const sweep = (...flags) => ok(cli(E, ["session", "resume", "--deployment", E.dep, ...flags, "--json"]), `sweep ${flags.join(" ")}`).rows;
  assert.equal(count(), undefined, "a start by hand is not counted");

  for (let n = 1; n <= 3; n++) {
    await lose();
    const runs = launches("e1").length;
    assert.deepEqual(sweep().map((r) => [r.instance, r.outcome]), [["e1", OUTCOME.RESUMED]], `sweep ${n}`);
    await waitUntil(() => launches("e1").length === runs + 1, `e1's stand-in to run after sweep ${n}`);
    assert.equal(count(), n, `sweep ${n} is counted`);
  }

  // A resume by hand is neither bounded nor counted.
  await lose();
  let runs = launches("e1").length;
  assert.equal(ok(cli(E, ["session", "start", "--resume", "--home", home, "--json"]), "start --resume by hand").resume.resumed, true);
  await waitUntil(() => launches("e1").length === runs + 1, "e1's stand-in to run after the start by hand");
  assert.equal(count(), 3);

  // The fourth sweep: predicted, then answered, and nothing started.
  await lose();
  runs = launches("e1").length;
  const keeps = (r) => { assert.deepEqual([r.instance, r.outcome, r.reason, r.code], ["e1", OUTCOME.REFUSED, ROW_REASON.KEEPS_GETTING_LOST, undefined]); assert.match(r.message, /resumed 3 times in the last hour/); assert.ok(Date.parse(r.nextAttemptAt) > Date.now(), `it says when a sweep starts it again: ${r.nextAttemptAt}`); };
  const [predicted] = sweep("--plan");
  keeps(predicted);
  const [answered] = sweep();
  keeps(answered);
  assert.equal(launches("e1").length, runs, "nothing was started");
  assert.equal(count(), 3);
  assert.equal(statusRows(E).e1.sessionEnd, SESSION_END.LOST);

  // The count is one boot's: in another boot this loss, which the guard did not answer, is started
  // again, and that start is the first of the new boot's count.
  writeFileSync(notePath, JSON.stringify({ ...readJson(notePath), bootId: "another-boot" }));
  assert.deepEqual(sweep().map((r) => [r.instance, r.outcome]), [["e1", OUTCOME.RESUMED]]);
  await waitUntil(() => launches("e1").length === runs + 1, "e1's stand-in to run in the new boot");
  assert.deepEqual(Object.entries(readJson(notePath).starts).map(([at, times]) => [at, times.length]), [[home, 1]], "the note of this boot, the count started again");
});

/** Two homes of `fx` started, seen running by a status, then lost (their windows killed by hand). */
async function twoLost(fx, names, launchConfig) {
  const homes = {};
  for (const name of names) { homes[name] = await spawnHome(fx, name, launchConfig); await startHome(fx, homes[name], name); }
  await waitUntil(() => { const r = statusRows(fx); return names.every((n) => r[n].running === true); }, `a status to see ${names.join(" and ")} run`);
  for (const name of names) killWindow(homes[name]);
  await waitUntil(() => { const r = statusRows(fx); return names.every((n) => r[n].sessionEnd === SESSION_END.LOST); }, `${names.join(" and ")} to read lost`);
  return homes;
}
/** A start answer as `session start --resume --json` gives one. */
const RESUMED_ANSWER = { ok: true, result: { warnings: [], resume: { resumed: true, harness: "claude", sessionId: "seam" } } };

test("the sweep notes each start's count as soon as that start has answered: a home whose start answered is counted while another start of the sweep still runs (a sweep killed then has counted it), once each; the loss is then judged, and the next sweep starts neither", TMUX, async () => {
  const F = v2Deployment({ name: "f", local: { "launch-configs": { "claude-f": config("claude", "dep-f") } } });
  later.push(F);
  const homes = await twoLost(F, ["f1", "f2"], "claude-f");
  // The starts are the test's (resumeSessions' `start`): f1's answers at once, f2's when the test
  // releases it. Nothing is launched. The sweep runs in this file's machine environment
  // (OATS_HOME_DIR is oatsHome), where the note is read.
  const boot = "interrupted-sweep-boot";
  const counted = (name) => readBootNote(boot).resumes[homes[name]] ?? 0;
  let release;
  const f2Answer = new Promise((r) => { release = r; });
  const sweep = resumeSessions({ deployment: F.dep, boot, start: (row) => (row.instance === "f1" ? Promise.resolve(RESUMED_ANSWER) : f2Answer) });
  await waitUntil(() => counted("f1") === 1, "f1's answer to be noted while f2's start runs");
  assert.equal(counted("f2"), 0, "f2's start has not answered");
  release(RESUMED_ANSWER);
  assert.deepEqual((await sweep).rows.map((r) => [r.instance, r.outcome]), [["f1", OUTCOME.RESUMED], ["f2", OUTCOME.RESUMED]]);
  assert.deepEqual([counted("f1"), counted("f2")], [1, 1], "each answer counted once");
  const next = await resumeSessions({ deployment: F.dep, boot, start: () => assert.fail("a judged loss is not started again") });
  assert.deepEqual(next.rows.map((r) => [r.instance, r.outcome, r.reason]), [["f1", OUTCOME.SKIPPED, ROW_REASON.NOT_SEEN_RECENTLY], ["f2", OUTCOME.SKIPPED, ROW_REASON.NOT_SEEN_RECENTLY]]);
});

test("a note that cannot be written ends the sweep only once the starts already running have answered: it holds the machine's lock until then (another sweep is E_RESUME_BUSY), and then fails", TMUX, async () => {
  const G = v2Deployment({ name: "g", local: { "launch-configs": { "claude-g": config("claude", "dep-g") } } });
  later.push(G);
  const homes = await twoLost(G, ["g1", "g2"], "claude-g");
  // A directory where the note goes: noting g1's answer fails (EISDIR).
  const notePath = join(oatsHome, "session-resume", "note.json"), saved = existsSync(notePath) ? readFileSync(notePath) : null;
  rmSync(notePath, { force: true });
  mkdirSync(notePath);
  try {
    let release;
    const g2Answer = new Promise((r) => { release = r; });
    const asked = [];
    const sweep = resumeSessions({ deployment: G.dep, boot: "note-failure-boot", start: (row) => { asked.push(row.instance); return row.instance === "g1" ? Promise.resolve(RESUMED_ANSWER) : g2Answer; } });
    const failed = sweep.then(() => null, (e) => e);
    await waitUntil(() => asked.length === 2, "both starts to be running");
    await new Promise((r) => setTimeout(r, 200));
    await assert.rejects(resumeSessions({ deployment: G.dep, boot: "note-failure-boot", start: () => assert.fail("nothing starts beside the sweep") }), (e) => e.code === "E_RESUME_BUSY", "the lock is held while g2's start runs");
    release(RESUMED_ANSWER);
    assert.equal((await failed)?.code, "EISDIR", "the sweep fails once g2 has answered");
    assert.deepEqual(asked, ["g1", "g2"]);
    assert.equal(existsSync(join(oatsHome, "session-resume", "lock")), false, "and then releases the lock");
    assert.deepEqual(readdirSync(join(oatsHome, "session-resume")).filter((f) => f.endsWith(".tmp")), [], "no private file of the note is left");
  } finally {
    rmSync(notePath, { recursive: true, force: true });
    if (saved) writeFileSync(notePath, saved);
  }
});

test("what status records never changes what it answers: a record that is corrupt, or cannot be written, leaves its output, exit status and stderr as they were; a corrupt record resumes nothing and is rewritten whole; status writes only under OATS_HOME_DIR, and a status routed to another machine records nothing here", TMUX, async () => {
  const H = v2Deployment({ name: "h", local: { "launch-configs": { "claude-h": config("claude", "dep-h") } } });
  later.push(H);
  const homes = await twoLost(H, ["h1", "h2"], "claude-h");
  const root = join(H.dep, "agents"), file = seenFile(root);
  const status = (env = {}) => { const r = cli(H, ["status", "--json"], env); return { status: r.status, stdout: r.stdout, stderr: r.stderr }; };
  const baseline = status();
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  assert.deepEqual(status(), baseline, "fixture premise: two status reads answer the same");
  const plan = () => ok(cli(H, ["session", "resume", "--deployment", H.dep, "--plan", "--json"]), "plan").rows.map((r) => [r.instance, r.outcome, r.reason ?? null]);
  assert.deepEqual(plan(), [["h1", OUTCOME.RESUMED, null], ["h2", OUTCOME.RESUMED, null]], "seen running, then lost: both would be resumed");

  // Corrupt: the same answer; the record is read as empty and rewritten whole; nothing is resumed.
  writeFileSync(file, "{ not json");
  assert.deepEqual(status(), baseline, "a corrupt record");
  const rewritten = readJson(file);
  assert.deepEqual([rewritten.deployment, Object.keys(rewritten.homes)], [H.dep, []], "rewritten whole: a lost home with no record of its running is not in it");
  assert.deepEqual(plan(), [["h1", OUTCOME.SKIPPED, ROW_REASON.NOT_SEEN_RECENTLY], ["h2", OUTCOME.SKIPPED, ROW_REASON.NOT_SEEN_RECENTLY]], "a corrupt record resumes nothing");

  // Cannot be written: the same answer, and the file as it was.
  if (process.getuid?.() !== 0) {
    writeFileSync(file, "{ not json");
    chmodSync(dirname(file), 0o500);
    try { assert.deepEqual(status(), baseline, "a record that cannot be written"); }
    finally { chmodSync(dirname(file), 0o700); }
    assert.equal(readFileSync(file, "utf8"), "{ not json");
  }

  // Only under OATS_HOME_DIR: another one, and a HOME of its own, for one status read.
  const own = join(base, "status-own"), ownHome = join(own, "home"), ownOats = join(own, "oats-home");
  mkdirSync(ownHome, { recursive: true });
  const seenBefore = readdirSync(dirname(file)).sort();
  // A corrupt record there, so that the read has something to write.
  const ownFile = join(ownOats, "session-resume", "seen", file.split("/").pop());
  mkdirSync(dirname(ownFile), { recursive: true });
  writeFileSync(ownFile, "{ not json");
  assert.deepEqual(status({ HOME: ownHome, OATS_HOME_DIR: ownOats }), baseline);
  assert.deepEqual(Object.keys(readJson(ownFile)), ["deployment", "root", "homes"], "the record was written in that OATS_HOME_DIR");
  assert.deepEqual(readdirSync(ownHome), [], "nothing under HOME");
  assert.deepEqual(readdirSync(dirname(file)).sort(), seenBefore, "nothing under the other OATS_HOME_DIR");

  // Routed with --server (a fake ssh that runs the host's kernel here, with an OATS_HOME_DIR of the
  // host's own): this machine's record of the deployment is not touched; the same read here is.
  const client = join(base, "routed-client"), isolatedPath = process.env.PATH;
  process.env.PATH = HOST_PATH;
  let bin, tools;
  try { ({ bin, tools } = fakeBin(client)); } finally { process.env.PATH = isolatedPath; }
  const remoteShell = join(client, "remote-shell");
  writeFileSync(remoteShell, `#!/bin/sh\nOATS_HOME_DIR='${join(client, "remote-oats")}'; export OATS_HOME_DIR\nexec /bin/sh "$@"\n`, { mode: 0o755 });
  const env = { ...H.env, PATH: bin, HOME: join(client, "home"), OATS_HOME_DIR: join(client, "oats-home"), FAKE_REMOTE_SHELL: remoteShell };
  mkdirSync(env.HOME, { recursive: true });
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: env.HOME, env, encoding: "utf8" });
  const added = run(["server", "add", "build", "--ssh", "build-host", "--workspace", H.dep, "--oats", CLI, "--path", tools, "--json"]);
  assert.equal(added.status, 0, added.stdout + added.stderr);
  const clientFile = join(env.OATS_HOME_DIR, "session-resume", "seen", file.split("/").pop());
  mkdirSync(dirname(clientFile), { recursive: true });
  writeFileSync(clientFile, "{ not json");
  const routed = run(["status", "--server", "build", "--json"]);
  assert.equal(routed.status, 0, routed.stdout + routed.stderr);
  assert.ok(routed.stdout.includes(homes.h1), "the host answered with its instances");
  assert.equal(readFileSync(clientFile, "utf8"), "{ not json", "a routed status records nothing on this machine");
  const local = spawnSync(process.execPath, [CLI, "status", "--json"], { cwd: H.dep, env, encoding: "utf8" });
  assert.equal(local.status, 0, local.stdout + local.stderr);
  assert.notEqual(readFileSync(clientFile, "utf8"), "{ not json", "control: the same read made here records");
});

test("a deployment named through a symlink reads and writes the same record as its real path: a plan through it neither loses nor duplicates what was seen, and a sweep through it judges the loss for both spellings", TMUX, async () => {
  const I = v2Deployment({ name: "i", local: { "launch-configs": { "claude-i": config("claude", "dep-i") } } });
  later.push(I);
  const homes = await twoLost(I, ["i1", "i2"], "claude-i");
  const link = join(base, "i-link");
  symlinkSync(I.dep, link);
  const plan = (dir) => ok(cli(I, ["session", "resume", "--deployment", dir, "--plan", "--json"]), `plan ${dir}`).rows.map((r) => [r.instance, r.outcome]);
  const recorded = () => Object.keys(readSeen(join(I.dep, "agents")).homes).sort();
  const both = [["i1", OUTCOME.RESUMED], ["i2", OUTCOME.RESUMED]];
  assert.deepEqual(recorded(), [homes.i1, homes.i2].sort(), "one entry per home, by its real path");
  assert.deepEqual(plan(I.dep), both);
  assert.deepEqual(plan(link), both, "through the symlink: the same record");
  assert.deepEqual(recorded(), [homes.i1, homes.i2].sort(), "neither lost nor duplicated");
  assert.deepEqual(plan(I.dep), both);
  const swept = await resumeSessions({ deployment: link, boot: "symlink-boot", start: () => Promise.resolve(RESUMED_ANSWER) });
  assert.deepEqual(swept.rows.map((r) => [r.instance, r.outcome]), both);
  assert.deepEqual(plan(I.dep), [["i1", OUTCOME.SKIPPED], ["i2", OUTCOME.SKIPPED]], "judged through the symlink, judged for the real path");
});

test("the per-boot note names a home by its real path: a budget used up through one spelling of the deployment refuses the home through the other, and a start through a symlink is counted under the real path", TMUX, async () => {
  const J = v2Deployment({ name: "j", local: { "launch-configs": { "claude-j": config("claude", "dep-j") } } });
  later.push(J);
  const homes = await twoLost(J, ["j1", "j2"], "claude-j");
  const link = join(base, "j-link");
  symlinkSync(J.dep, link);
  const boot = "alias-boot", notePath = join(oatsHome, "session-resume", "note.json");
  const saved = existsSync(notePath) ? readFileSync(notePath) : null;
  try {
    // j1 was started 3 times this boot (under its real path): through the symlink it is refused.
    const justNow = new Date().toISOString();
    writeFileSync(notePath, JSON.stringify({ bootId: boot, refused: [], starts: { [homes.j1]: [justNow, justNow, justNow] } }));
    const answers = [];
    const sweep = await resumeSessions({ deployment: link, boot, start: (row) => { answers.push(row.instance); return Promise.resolve(RESUMED_ANSWER); } });
    assert.deepEqual(sweep.rows.map((r) => [r.instance, r.outcome, r.reason ?? null]), [["j1", OUTCOME.REFUSED, ROW_REASON.KEEPS_GETTING_LOST], ["j2", OUTCOME.RESUMED, null]]);
    assert.deepEqual(answers, ["j2"], "only j2 was started");
    assert.equal(sweep.rows[0].home, join(link, "agents", "dev", "instances", "j1"), "the row shows the path it listed");
    // j2's start through the symlink is counted under its real path, where a real-path sweep reads it.
    assert.deepEqual(readBootNote(boot).resumes, { [homes.j1]: 3, [homes.j2]: 1 });
  } finally {
    rmSync(notePath, { force: true });
    if (saved) writeFileSync(notePath, saved);
  }
});

test("a sweep of 3 homes on a host whose harnesses get no scope of their own says why once, in the sweep's warnings, and in none of its rows; each start's own event stays with its home", TMUX, async () => {
  const K = v2Deployment({ name: "k", local: { "launch-configs": { "claude-k": config("claude", "dep-k") } } });
  later.push(K);
  const names = ["k1", "k2", "k3"];
  await twoLost(K, names, "claude-k");
  // A systemd host (the unified hierarchy's root) whose system directories hold no systemd-run: every
  // start launches unscoped and says so.
  const tools = join(base, "k-no-systemd-run");
  mkdirSync(tools, { recursive: true });
  const host = { OATS_TEST_CGROUP: "0::/\n", OATS_TEST_SYSTEMD_BOOTED: "1", OATS_TEST_SYSTEM_TOOL_DIRS: tools };
  const warning = agentScopeWarning(`no executable systemd-run in ${tools}`);
  const sweep = ok(cli(K, ["session", "resume", "--deployment", K.dep, "--json"], host), "the sweep");
  assert.deepEqual(sweep.rows.map((r) => [r.instance, r.outcome]), names.map((n) => [n, OUTCOME.RESUMED]));
  assert.deepEqual(sweep.warnings, [warning], "said once, verbatim");
  assert.equal(sweep.rows.some((r) => (r.warnings ?? []).some(isAgentScopeWarning)), false, "and in no row");
  for (const r of sweep.rows) assert.equal(readEvents(r.home).events.filter((e) => e.kind === "launch-warning" && e.data.message === warning).length, 1, `${r.instance}'s start recorded its own`);
  // A plan starts nothing and says nothing of the host.
  const plan = ok(cli(K, ["session", "resume", "--deployment", K.dep, "--plan", "--json"], host), "the plan");
  assert.equal(Object.hasOwn(plan, "warnings"), false);
});

/** Every file under `dir`, links not followed, that holds `needle` (a string's UTF-8 bytes, or bytes). */
function filesHolding(dir, needle) {
  const found = [], want = Buffer.isBuffer(needle) ? needle : Buffer.from(needle);
  const walk = (d) => { for (const e of readdirSync(d)) { const p = join(d, e), st = lstatSync(p); if (st.isDirectory()) walk(p); else if (st.isFile() && readFileSync(p).includes(want)) found.push(p); } };
  walk(dir);
  return found;
}

test("a resume starts only under the launch environment its last start recorded: a changed fromEnv value is refused by name (start, sweep and plan); the same value resumes; a home with no record, or a corrupt one, resumes with one warning and is recorded; an ordinary start records the new value; no value is ever written", TMUX, async () => {
  const L = v2Deployment({ name: "l", local: { "launch-configs": { "secret-l": config("claude", "dep-l", { env: { RESUME_SECRET: { fromEnv: "RESUME_TEST_L" } } }) } } });
  later.push(L);
  const SENTINEL = "sentinel-7f3a9c-launch-value", CHANGED = "sentinel-changed-41b2";
  const same = { RESUME_TEST_L: SENTINEL }, changed = { RESUME_TEST_L: CHANGED };
  const answers = [];
  const run = (args, extra) => { const r = cli(L, args, extra); answers.push(r.stdout, r.stderr); return r; };
  const homes = {};
  // l1 and l2 started by `session start`; l3 launched by its spawn.
  for (const name of ["l1", "l2"]) {
    homes[name] = await spawnHome(L, name, "secret-l", { env: same });
    ok(run(["session", "start", "--home", homes[name], "--json"], same), `start ${name}`);
  }
  homes.l3 = await spawnHome(L, "l3", "secret-l", { launch: true, env: same });
  await waitUntil(() => ["l1", "l2", "l3"].every((n) => launches(n).length === 1), "the stand-ins to run");
  assert.equal(launches("l1")[0].secret, SENTINEL, "premise: the pane got the value");
  const record = (name) => readJson(join(homes[name], START_ENV_FILE));
  for (const name of ["l1", "l2", "l3"]) {
    const r = record(name);
    assert.equal(r.startId, readJson(join(homes[name], "instance.json")).startId, `${name}'s record is its start's`);
    assert.deepEqual(Object.keys(r.digests), ["RESUME_TEST_L"]);
    assert.match(r.digests.RESUME_TEST_L, /^[0-9a-f]{64}$/);
    const key = statSync(join(homes[name], START_ENV_KEY_FILE));
    assert.deepEqual([key.size, key.mode & 0o777], [32, 0o600]);
  }
  const l1Digest = record("l1").digests.RESUME_TEST_L;
  const running = statusRows(L);
  for (const name of ["l1", "l2", "l3"]) assert.equal(running[name].running, true);
  for (const name of ["l1", "l2", "l3"]) killWindow(homes[name]);
  await waitUntil(() => { const r = statusRows(L); return ["l1", "l2", "l3"].every((n) => r[n].sessionEnd === SESSION_END.LOST); }, "the three to read lost");

  // l2 has no record (a home last started by an earlier kernel); l3's does not read.
  rmSync(join(homes.l2, START_ENV_FILE));
  writeFileSync(join(homes.l3, START_ENV_FILE), "{ not json");

  // The plan, under the changed value: l1 refused by name, l2 and l3 resumed with the warning.
  const plan = ok(run(["session", "resume", "--deployment", L.dep, "--plan", "--json"], changed), "plan");
  const planned = Object.fromEntries(plan.rows.map((r) => [r.instance, r]));
  assert.deepEqual([planned.l1.outcome, planned.l1.reason, planned.l1.code], [OUTCOME.REFUSED, ROW_REASON.START_REFUSED, "E_LAUNCH_ENV_CHANGED"]);
  assert.match(planned.l1.message, /\(RESUME_TEST_L\)/);
  for (const name of ["l2", "l3"]) assert.deepEqual(planned[name].warnings, [launchEnvUnverifiedWarning(name)], `${name}: predicted with its warning`);
  assert.equal(existsSync(join(homes.l2, START_ENV_FILE)), false, "a plan writes no record");
  assert.equal(readFileSync(join(homes.l3, START_ENV_FILE), "utf8"), "{ not json", "nor rewrites one");

  // The sweep, under the changed value: l1 refused, nothing launched for it; l2 and l3 resume, once
  // warned, and are recorded for their new start.
  const sweep = ok(run(["session", "resume", "--deployment", L.dep, "--json"], changed), "sweep");
  const rows = Object.fromEntries(sweep.rows.map((r) => [r.instance, r]));
  assert.deepEqual([rows.l1.outcome, rows.l1.reason, rows.l1.code], [OUTCOME.REFUSED, ROW_REASON.START_REFUSED, "E_LAUNCH_ENV_CHANGED"]);
  assert.equal(rows.l1.message, "this home's launch environment changed since its last start (RESUME_TEST_L); nothing was started: start it yourself to use the new values");
  for (const name of ["l2", "l3"]) {
    assert.equal(rows[name].outcome, OUTCOME.RESUMED, JSON.stringify(rows[name]));
    assert.deepEqual(rows[name].warnings, [launchEnvUnverifiedWarning(name)]);
    assert.equal(readEvents(homes[name]).events.filter((e) => e.kind === "launch-warning" && e.data.message === launchEnvUnverifiedWarning(name)).length, 1, `${name}: one event`);
    assert.equal(record(name).startId, readJson(join(homes[name], "instance.json")).startId, `${name} is recorded for its new start`);
  }
  await waitUntil(() => launches("l2").length === 2 && launches("l3").length === 2, "l2 and l3 to run again");
  assert.equal(launches("l1").length, 1, "l1 was not launched");
  assert.equal(record("l1").digests.RESUME_TEST_L, l1Digest, "a refusal records nothing");

  // By hand, under the value l1 was started with: it resumes.
  const resumed = ok(run(["session", "start", "--resume", "--home", homes.l1, "--json"], same), "resume l1");
  assert.equal(resumed.resume.resumed, true);
  assert.equal((resumed.warnings ?? []).includes(launchEnvUnverifiedWarning("l1")), false);
  await waitUntil(() => launches("l1").length === 2, "l1 to run again");
  assert.equal(launches("l1")[1].secret, SENTINEL);

  // Once recorded, l2's next resume is verified: no warning.
  killWindow(homes.l2);
  await waitUntil(() => statusRows(L).l2.sessionEnd === SESSION_END.LOST, "l2 lost again");
  const again = ok(run(["session", "start", "--resume", "--home", homes.l2, "--json"], changed), "resume l2 again");
  assert.equal((again.warnings ?? []).includes(launchEnvUnverifiedWarning("l2")), false, "said once");

  // An ordinary start never compares: under a new value it starts, and records that value.
  killWindow(homes.l1);
  await waitUntil(() => statusRows(L).l1.sessionEnd === SESSION_END.LOST, "l1 lost again");
  ok(run(["session", "start", "--home", homes.l1, "--json"], changed), "ordinary start of l1");
  await waitUntil(() => launches("l1").length === 3, "l1 to run a third time");
  assert.equal(launches("l1")[2].secret, CHANGED);
  assert.equal(record("l1").startId, readJson(join(homes.l1, "instance.json")).startId);
  assert.notEqual(record("l1").digests.RESUME_TEST_L, l1Digest, "the new value's digest");

  // No value anywhere: not in a home (events, instance.json, receipts, the record), not in an answer.
  for (const name of ["l1", "l2", "l3"]) for (const value of [SENTINEL, CHANGED]) assert.deepEqual(filesHolding(homes[name], value), [], `${name} holds no value`);
  for (const value of [SENTINEL, CHANGED]) assert.equal(answers.some((text) => text.includes(value)), false, "no answer holds a value");
});

test("a resume runs the launch its last start chose: the launch configuration, its executable and args, the model and yolo of `session start --launch-config <c> --model <m> --yolo`", TMUX, async () => {
  const O = v2Deployment({ name: "o", local: { "launch-configs": { "plain-o": config("claude", "dep-o-plain"), "chosen-o": config("claude", "dep-o", { args: ["--from-o"] }) } } });
  later.push(O);
  const home = await spawnHome(O, "o1", "plain-o");
  ok(cli(O, ["session", "start", "--home", home, "--launch-config", "chosen-o", "--model", "claude-opus-5-5", "--yolo", "--json"]), "start o1 under its choice");
  await waitUntil(() => launches("o1").length === 1, "o1 to run");
  const chosen = launches("o1")[0];
  assert.equal(chosen.mark, "dep-o");
  await waitUntil(() => statusRows(O).o1.running === true, "a status to see o1 run");
  killWindow(home);
  await waitUntil(() => statusRows(O).o1.sessionEnd === SESSION_END.LOST, "o1 lost");
  const sweep = ok(cli(O, ["session", "resume", "--deployment", O.dep, "--json"]), "sweep");
  assert.equal(sweep.rows[0].outcome, OUTCOME.RESUMED, JSON.stringify(sweep.rows));
  await waitUntil(() => launches("o1").length === 2, "o1 to run again");
  const back = launches("o1")[1];
  assert.equal(back.mark, "dep-o", "the chosen configuration's environment");
  for (const word of ["--dangerously-skip-permissions", "--from-o"]) assert.ok(back.args.includes(word), `${word}: ${back.args}`);
  assert.equal(back.args[back.args.indexOf("--model") + 1], chosen.args[chosen.args.indexOf("--model") + 1], "the model");
  assert.ok(chosen.args.includes("--model"), `premise: ${chosen.args}`);
  const { tmux } = readJson(join(home, "instance.json"));
  const paneCommand = execFileSync("tmux", ["-u", "-S", tmux.socket, "display-message", "-p", "-t", `${tmux.session}:${tmux.window}`, "#{pane_start_command}"], { encoding: "utf8" });
  assert.ok(paneCommand.includes(standIn), "the configuration's executable");
});

/** An io for a kernel call whose launch fails: tmux runs as ever, but a pane is never made (the
 *  respawn of the retained pane, or a new window, fails as tmux would). */
const failingLaunch = { exec: (file, argv, options) => {
  if (argv.includes("respawn-pane") || argv.includes("new-window")) throw Object.assign(new Error("injected launch failure"), { status: 1 });
  return execFileSync(file, argv, options);
} };
test("a restart records its stop before it ends the old harness (#1601): a failed relaunch reads stopped and is not resumed; a relaunch records a new start, which reads lost when lost; a record that cannot be written blocks nothing; a home that does not run records nothing", TMUX, async () => {
  const R = v2Deployment({ name: "r", local: { "launch-configs": { "claude-r": config("claude", "dep-r", { env: { NO_TRANSCRIPT: "1" } }) } } });
  later.push(R);
  const homes = {};
  for (const name of ["r1", "r2", "r3", "r4", "r5"]) { homes[name] = await spawnHome(R, name, "claude-r"); await startHome(R, homes[name], name); }
  await waitUntil(() => { const r = statusRows(R); return ["r1", "r2", "r3", "r4", "r5"].every((n) => r[n].running === true); }, "a status to see them run");
  const startIdOf = (name) => readJson(join(homes[name], "instance.json")).startId;
  const stopRecord = (name) => join(homes[name], ".oats-stop.json");
  const restart = (name, io) => R.inEnv(() => { try { return restartInstanceSession(homes[name], { stopGraceMs: 5000, ...(io ? { io } : {}) }); } catch (e) { return e; } });

  // r1: the old harness ends, then the relaunch fails. The record names the start it ended.
  const r1Start = startIdOf("r1");
  const failed = await restart("r1", failingLaunch);
  assert.equal(failed.code, "E_SESSION_START_FAILED", failed.stack);
  assert.equal(startIdOf("r1"), r1Start, "no new start was recorded");
  await waitUntil(() => statusRows(R).r1.running === false, "r1 to read not running");
  assert.equal(statusRows(R).r1.sessionEnd, SESSION_END.STOPPED, "a failed restart reads stopped, not lost");
  const plan = ok(cli(R, ["session", "resume", "--deployment", R.dep, "--plan", "--json"]), "plan");
  assert.equal(plan.rows.some((row) => row.instance === "r1"), false, `the failed restart is no candidate: ${JSON.stringify(plan.rows)}`);
  assert.deepEqual([readJson(stopRecord("r1")).startId, readJson(stopRecord("r1")).stop], [r1Start, null], "the record names the start the restart ended");

  // r2: a restart that relaunches records a new start, which the record does not name; lost, it reads lost.
  const r2Start = startIdOf("r2");
  const relaunched = await restart("r2");
  assert.equal(relaunched.stop?.exited, true, relaunched.stack);
  await waitUntil(() => launches("r2").length === 2, "r2's stand-in to run again");
  assert.notEqual(startIdOf("r2"), r2Start, "a new start");
  assert.equal(readJson(stopRecord("r2")).startId, r2Start, "the record names the old start");
  await waitUntil(() => statusRows(R).r2.running === true, "a status to see r2 run again");
  killWindow(homes.r2);
  await waitUntil(() => statusRows(R).r2.sessionEnd === SESSION_END.LOST, "r2, lost after its restart, to read lost");

  // r3: a record that cannot be written (its path a directory) does not block the restart.
  mkdirSync(stopRecord("r3"));
  const unrecorded = await restart("r3");
  assert.equal(unrecorded.stop?.exited, true, unrecorded.stack);
  await waitUntil(() => launches("r3").length === 2, "r3's stand-in to run again");
  assert.equal(statSync(stopRecord("r3")).isDirectory(), true, "no record was written");
  rmSync(stopRecord("r3"), { recursive: true });

  // r4 (lost) and r5 (stopped with OATS): nothing runs, nothing is stopped, nothing is recorded; a
  // failed relaunch keeps the reading.
  killWindow(homes.r4);
  assert.equal((await R.inEnv(() => stopInstanceSession(homes.r5, { graceMs: 5000 }))).stopped, true, "stop r5");
  await waitUntil(() => { const r = statusRows(R); return r.r4.sessionEnd === SESSION_END.LOST && r.r5.sessionEnd === SESSION_END.STOPPED; }, "r4 lost and r5 stopped");
  const r5Record = readFileSync(stopRecord("r5"), "utf8");
  for (const name of ["r4", "r5"]) assert.equal((await restart(name, failingLaunch)).code, "E_SESSION_START_FAILED", name);
  assert.equal(existsSync(stopRecord("r4")), false, "the lost home records no stop");
  assert.equal(readFileSync(stopRecord("r5"), "utf8"), r5Record, "the stopped home's record is as it was");
  const rows = statusRows(R);
  assert.deepEqual([rows.r4.sessionEnd, rows.r5.sessionEnd], [SESSION_END.LOST, SESSION_END.STOPPED]);
});
