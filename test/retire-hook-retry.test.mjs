// A deferred self-retire whose cleanup is left incomplete by retire hooks alone retries it before it
// gives up (awebai/oats#1747).
//
// The completion of `oats retire --self` (lib/core.mjs completeDeferredRetirement) runs with nobody at
// a terminal. When its retire ends in a quarantine that owes retire hooks and nothing else, it runs
// the same retire again after each delay of RETIRE_RETRY_DELAYS_MS (here a few milliseconds, the
// function's `retryDelaysMs`), each attempt a plain retire under the home's claim with its own
// `retired` row. This file pins:
//   - a retry whose hooks pass ends as a first-time success does: the home is gone and nothing is left
//     beside it (marker, outcome, log, retry state), in directory and worktree mode;
//   - after the last failed attempt the outcome is as before, with `attempts`; the marker stays, four
//     `retired` rows carry their hooks, and one `retire-refused` row follows them;
//   - a quarantine that owes a Git step is not retried, whether it owed it from the start (the
//     outcome is then byte for byte as before) or came to owe it between two attempts;
//   - an attempt that answers an error ends the retries, with that code;
//   - while it waits, `oats status` reads the retire as running, and another retire is refused with
//     E_LIFECYCLE_BUSY, a clause that names the next attempt, and the same `details` as without it.
//
// The completion is a child of the test that runs the function from an intent, as the detached
// script does, with no delay. The marker it reads is written by the test, as the scheduling writes it.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { RETIRE_RETRY_DELAYS_MS, deferredRetireResultPath, retireInstance, retirePendingMarkerPath } from "../lib/core.mjs";
import { startGated } from "./helpers/fs-gate-preload.mjs";
import { processStartToken } from "../lib/worktree-hooks.mjs";
import { v2Deployment } from "./helpers/v2-deployment.mjs";

const CORE = pathToFileURL(new URL("../lib/core.mjs", import.meta.url).pathname).href;
const ROOT = process.getuid?.() === 0;
/** How long a completion on a loaded host is waited for. */
const COMPLETION_MS = 180000;
/** The delays between attempts: three retries, as the kernel's, a few milliseconds each. */
const DELAYS = [10, 10, 10];
const CAP = "test.retry";
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** The completion as the detached script runs it, with no delay and the delays it is given. */
const COMPLETION = `import { completeDeferredRetirement } from ${JSON.stringify(CORE)};
process.exitCode = completeDeferredRetirement(JSON.parse(process.env.OATS_RETIRE_INTENT), { delaySec: 0, retryDelaysMs: JSON.parse(process.env.OATS_TEST_RETRY_DELAYS_MS) }) ? 0 : 1;`;

/** The retire hook. It counts its runs in `<agents root>/hook-runs` and fails (exit 1, cleanup
 *  incomplete) while that count is at most the number in `fail-runs` ("all": every run). On the run
 *  `unreadable-on` names it leaves in the home a file nobody may read, so that the inspection after
 *  the hooks fails and the retire answers an error. */
const HOOK = `import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = process.env.OATS_ROOT, home = process.env.OATS_INSTANCE_HOME;
appendFileSync(join(root, "hook-runs"), "run\\n");
const run = readFileSync(join(root, "hook-runs"), "utf8").split("\\n").filter(Boolean).length;
const read = (name) => existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8").trim() : null;
if (read("unreadable-on") === String(run)) { const left = join(home, "left-by-the-hook"); writeFileSync(left, "x\\n"); chmodSync(left, 0o000); }
const fails = read("fail-runs");
if (fails === "all" || (fails !== null && run <= Number(fails))) {
  console.log(JSON.stringify({ meta: { retired: false, reason: "the provider did not answer" } }));
  process.exit(1);
}
console.log(JSON.stringify({ meta: { retired: true } }));
`;

function deployment(t) {
  const fx = v2Deployment({ t,
    souls: { dev: { soul: { work: "directory", capabilities: { [CAP]: { from: "here" } } } }, wt: { soul: { work: "worktree", capabilities: { [CAP]: { from: "here" } } } } },
    capabilities: { [CAP]: { manifest: { hooks: { retire: "hook.mjs" } }, files: { "hook.mjs": HOOK } } },
  });
  const started = [];
  fx.beforeCleanup(() => {
    for (const pid of started) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    // What an unreadable-file run left, so that the fixture can be removed.
    for (const soul of ["dev", "wt"]) {
      const dir = join(fx.root, soul, "instances");
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) { const left = join(dir, name, "left-by-the-hook"); try { rmSync(left, { force: true }); } catch { /* none */ } }
    }
  });
  const onFixturePath = async (fn) => {
    const hostPath = process.env.PATH;
    process.env.PATH = fx.env.PATH;
    try { return await fx.inEnv(fn); } finally { process.env.PATH = hostPath; }
  };
  const rowsOf = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  const f = {
    fx,
    /** A spawned instance of `soul`, not launched, with what a self-retire keeps beside its home. */
    spawn: async (soul, name) => {
      const { home } = await onFixturePath(() => fx.spawn(soul, { name }));
      assert.equal(home, join(fx.root, soul, "instances", name));
      const result = deferredRetireResultPath(home);
      return { soul, name, home, marker: retirePendingMarkerPath(home), result, log: result.replace(/\.json$/, ".log"),
        retryState: join(dirname(home), `.oats-retire-retry-${name}.json`), workspaceLog: join(fx.dep, ".agents", "events", `${soul}--${name}.jsonl`) };
    },
    /** Fail the hook's first `n` runs ("all": every run). */
    failRuns: (n) => writeFileSync(join(fx.root, "fail-runs"), String(n)),
    unreadableOn: (n) => writeFileSync(join(fx.root, "unreadable-on"), String(n)),
    hookRuns: () => (existsSync(join(fx.root, "hook-runs")) ? readFileSync(join(fx.root, "hook-runs"), "utf8").split("\n").filter(Boolean).length : 0),
    /** The intent of a scheduling of `i`, and its pending marker as an older kernel wrote it (no
     *  completion named). The log is there as the scheduling opens it. */
    schedule: (i) => {
      const intent = { instance: i.name, agent: i.soul, root: fx.root, requestedAt: "2026-11-05T00:00:00.000Z", requestedByPid: 1, delaySec: 0,
        options: { home: i.home, tmuxSession: "oats-agents" }, resultPath: i.result };
      writeFileSync(i.marker, JSON.stringify(intent, null, 2) + "\n");
      writeFileSync(i.log, "");
      return intent;
    },
    /** A completion run to its end → { status, stdout, stderr }. */
    complete: (intent, delays = DELAYS) => {
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", COMPLETION], { cwd: fx.dep, encoding: "utf8", timeout: COMPLETION_MS,
        env: { ...fx.env, OATS_RETIRE_INTENT: JSON.stringify(intent), OATS_TEST_RETRY_DELAYS_MS: JSON.stringify(delays) } });
      assert.equal(r.signal, null, `the completion ended by itself\n${r.stdout}\n${r.stderr}`);
      return r;
    },
    /** The same completion, held at `gates` (test/helpers/fs-gate-preload.mjs). */
    completeGated: (intent, gates, delays = DELAYS) => {
      const run = startGated(["--input-type=module", "-e", COMPLETION], { cwd: fx.dep, env: { ...fx.env, OATS_RETIRE_INTENT: JSON.stringify(intent), OATS_TEST_RETRY_DELAYS_MS: JSON.stringify(delays) },
        gateDir: join(fx.base, `gates-${started.length}`), gates });
      started.push(run.child.pid);
      return run;
    },
    /** A plain retire, as a person runs it in process. */
    retire: (i) => onFixturePath(() => retireInstance(fx.root, i.name, { tmuxSession: "oats-agents" })),
    /** What is left beside the homes of `i`'s soul by a self-retire. */
    beside: (i) => readdirSync(dirname(i.home)).filter((name) => [".oats-retire-pending-", ".oats-retired-", ".oats-retire-retry-"].some((p) => name.startsWith(p))),
    rows: (i) => rowsOf(i.workspaceLog),
    /** The kinds of `i`'s workspace rows from the first `retired` on, with each `retired` row's hooks. */
    trace: (i) => rowsOf(i.workspaceLog).filter((row) => row.kind === "retired" || row.kind === "retire-refused")
      .map((row) => row.kind === "retired" ? ["retired", row.data.hooks.map((h) => [h.capability, h.ok])] : ["retire-refused", row.data.code, row.data.homeChanged]),
    status: (i) => {
      const r = fx.cli(["status", "--json"]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      return JSON.parse(r.stdout).agents.find((a) => a.name === i.soul).instances.find((row) => row.instance === i.name);
    },
  };
  return f;
}

test("the kernel's delays: three retries, at about 1, 5 and 15 minutes", () => {
  assert.deepEqual(RETIRE_RETRY_DELAYS_MS, [60000, 300000, 900000]);
});

for (const soul of ["dev", "wt"]) {
  test(`${soul === "dev" ? "directory" : "worktree"} mode: a hook that fails once and passes on the retry: the home is removed and nothing is left beside it`, async (t) => {
    const f = deployment(t);
    const i = await f.spawn(soul, `once-${soul}`);
    f.failRuns(1);
    const r = f.complete(f.schedule(i));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(existsSync(i.home), false, "the home is removed");
    assert.deepEqual(f.beside(i), [], "no marker, outcome, log or retry state is left");
    assert.equal(f.hookRuns(), 2);
    assert.deepEqual(f.trace(i), [["retired", [[CAP, false]]], ["retired", [[CAP, true]]]], "each attempt's retired row, and no retire-refused");
    assert.ok(r.stderr.includes(`deferred retirement of ${i.name}: attempt 1 of 4 is incomplete (retire hook ${CAP}:`), r.stderr);
    if (soul === "wt") assert.ok(r.stderr.includes("kept for the retry"), `fixture premise: the worktree was kept for the retry: ${r.stderr}`);
  });
}

test("a hook that keeps failing: three retries, then the outcome as before with attempts 4; the marker stays; four retired rows with their hooks, then one retire-refused", async (t) => {
  const f = deployment(t);
  const i = await f.spawn("dev", "always");
  f.failRuns("all");
  const intent = f.schedule(i);
  const markerBytes = readFileSync(i.marker, "utf8");
  const r = f.complete(intent);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const outcome = readJson(i.result);
  assert.deepEqual(Object.keys(outcome), ["instance", "agent", "requestedAt", "completedAt", "ok", "result", "retry", "attempts"]);
  assert.deepEqual([outcome.ok, outcome.attempts, outcome.retry], [false, 4, `oats retire always --home ${i.home}`]);
  assert.ok(outcome.result.rollbackIncomplete.some((item) => item.startsWith(`retire hook ${CAP}:`)), JSON.stringify(outcome.result));
  assert.equal(readFileSync(i.marker, "utf8"), markerBytes, "the marker stays, as it was");
  assert.equal(existsSync(join(i.home, ".oats-rollback-incomplete.json")), true, "the home is quarantined");
  assert.equal(existsSync(i.retryState), false, "the retry state is gone");
  assert.equal(f.hookRuns(), 4);
  const failed = ["retired", [[CAP, false]]];
  assert.deepEqual(f.trace(i), [failed, failed, failed, failed, ["retire-refused", null, true]]);
  const refused = f.rows(i).filter((row) => row.kind === "retire-refused");
  assert.deepEqual(refused[0].data, { code: null, homeChanged: true, reason: "the retirement of always is incomplete: its cleanup did not finish, and the home is retained" }, "the event as before");
  for (const n of [1, 2, 3]) assert.ok(r.stderr.includes(`attempt ${n} of 4 is incomplete (retire hook ${CAP}:`) && r.stderr.includes(`attempt ${n + 1} runs at `), r.stderr);
  assert.ok(r.stderr.includes("attempt 4 of 4 is incomplete") && r.stderr.includes("it is not tried again: it was the last attempt"), r.stderr);
  // `oats instance events` shows the four attempts and the refusal.
  const read = f.fx.cli(["instance", "events", i.name, "--json"]);
  assert.equal(read.status, 0, read.stdout + read.stderr);
  const kinds = read.json().result.events.map((e) => e.kind).filter((k) => k === "retired" || k === "retire-refused");
  assert.deepEqual(kinds, ["retired", "retired", "retired", "retired", "retire-refused"]);
  // Status reads the failure as before.
  assert.equal(f.status(i).retire.state, "failed");
});

test("a quarantine that owes a Git step is not retried: one attempt, and the outcome is as before, with no attempts", async (t) => {
  const f = deployment(t);
  const i = await f.spawn("wt", "git-debt");
  f.failRuns("all");
  // A plain retire quarantines the home; its marker then owes the branch as well, as a failed
  // spawn's does.
  const first = await f.retire(i);
  assert.ok(first.rollbackIncomplete?.length, "fixture premise: the plain retire quarantined the home");
  const quarantine = join(i.home, ".oats-rollback-incomplete.json");
  const marker = readJson(quarantine);
  writeFileSync(quarantine, JSON.stringify({ ...marker, cleanup: { ...marker.cleanup, outstanding: { ...marker.cleanup.outstanding, git: ["branch"] } } }, null, 2) + "\n");
  const r = f.complete(f.schedule(i));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(f.hookRuns(), 2, "the plain retire's run and the completion's one attempt");
  const outcome = readJson(i.result);
  assert.deepEqual(Object.keys(outcome), ["instance", "agent", "requestedAt", "completedAt", "ok", "result", "retry"], "the outcome as before: no attempts");
  assert.equal(r.stderr.includes("attempt 1 of 4"), false, `no attempt is announced: ${r.stderr}`);
  assert.ok(r.stderr.includes("deferred retirement of git-debt is INCOMPLETE; the home is retained"), r.stderr);
  assert.deepEqual(f.trace(i), [["retired", [[CAP, false]]], ["retired", [[CAP, false]]], ["retire-refused", null, true]]);
  assert.equal(existsSync(i.retryState), false);
});

test("a quarantine that comes to owe a Git step between two attempts: the retries stop there", async (t) => {
  const f = deployment(t);
  const i = await f.spawn("wt", "turns-git");
  f.failRuns("all");
  const intent = f.schedule(i);
  const run = f.completeGated(intent, [{ name: "waits", fn: "writeFileSync", path: i.retryState, when: "after", waitMs: COMPLETION_MS }]);
  try {
    await run.waitGate("waits", COMPLETION_MS);
    const quarantine = join(i.home, ".oats-rollback-incomplete.json");
    const marker = readJson(quarantine);
    writeFileSync(quarantine, JSON.stringify({ ...marker, cleanup: { ...marker.cleanup, outstanding: { ...marker.cleanup.outstanding, git: ["branch"] } } }, null, 2) + "\n");
    run.release("waits");
    const done = await run.done;
    assert.deepEqual(done.timedOut, []);
    assert.equal(done.code, 1, done.stdout + done.stderr);
    assert.ok(done.stderr.includes("attempt 2 of 4 is incomplete") && done.stderr.includes("it is not tried again: its cleanup owes more than retire hooks"), done.stderr);
  } finally { await run.finish(); }
  assert.equal(f.hookRuns(), 2);
  assert.equal(readJson(i.result).attempts, 2);
  assert.equal(existsSync(i.retryState), false);
  assert.equal(existsSync(i.marker), true);
});

test("an attempt that answers an error: no further attempt, and the outcome has that code and the attempts", async (t) => {
  if (ROOT) { t.skip("root reads whatever the mode says: this shape cannot fail"); return; }
  const f = deployment(t);
  const i = await f.spawn("dev", "throws");
  f.failRuns(1);
  f.unreadableOn(2);
  const r = f.complete(f.schedule(i));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(f.hookRuns(), 2, "no third attempt");
  const outcome = readJson(i.result);
  assert.deepEqual([outcome.ok, outcome.error.code, outcome.attempts], [false, "E_WORK_INSPECTION_FAILED", 2]);
  assert.ok(r.stderr.includes("deferred retirement of throws failed on attempt 2 of 4: "), r.stderr);
  assert.equal(existsSync(i.marker), true, "the marker stays: the home is owed a retire");
  assert.equal(existsSync(i.retryState), false);
  const refused = f.rows(i).filter((row) => row.kind === "retire-refused");
  assert.equal(refused.length, 1);
  assert.deepEqual([refused[0].data.code, refused[0].data.homeChanged], ["E_WORK_INSPECTION_FAILED", true]);
});

test("while it waits: status reads the retire as running, and another retire is refused with E_LIFECYCLE_BUSY, the retry clause and the same details", async (t) => {
  const f = deployment(t);
  const i = await f.spawn("dev", "waiting");
  f.failRuns(1);
  const intent = f.schedule(i);
  const run = f.completeGated(intent, [{ name: "waits", fn: "writeFileSync", path: i.retryState, when: "after", waitMs: COMPLETION_MS }]);
  try {
    await run.waitGate("waits", COMPLETION_MS);
    // The marker names this completion, as the scheduling writes it.
    const pid = run.child.pid;
    const marker = { ...intent, completionPid: pid, completionStart: processStartToken(pid) };
    writeFileSync(i.marker, JSON.stringify(marker, null, 2) + "\n");
    const state = readJson(i.retryState);
    assert.deepEqual(Object.keys(state), ["requestedAt", "completionPid", "completionStart", "attempt", "attempts", "nextAt", "lastAt"]);
    assert.deepEqual([state.requestedAt, state.completionPid, state.completionStart, state.attempt, state.attempts], [intent.requestedAt, pid, marker.completionStart, 2, 4]);

    const row = f.status(i);
    assert.equal(row.retire.state, "running");
    assert.equal(row.retire.self, true);
    assert.deepEqual(row.retirePending, marker, "retirePending is the marker, whole");

    const refusal = () => { const r = f.fx.cli(["retire", i.name, "--json"]); assert.equal(r.status, 1, r.stdout + r.stderr); return r.json().error; };
    const busy = refusal();
    assert.equal(busy.code, "E_LIFECYCLE_BUSY");
    assert.ok(busy.message.includes(`; it is retrying cleanup that did not finish: attempt 2 of 4 runs at ${state.nextAt}, the last no earlier than ${state.lastAt}; nothing was done`), busy.message);
    // Without the retry state the refusal is as before: the same code and details, and no clause.
    rmSync(i.retryState);
    const plain = refusal();
    assert.equal(plain.code, "E_LIFECYCLE_BUSY");
    assert.equal(plain.message.includes("retrying"), false, plain.message);
    assert.deepEqual(busy.details, plain.details, "the clause adds nothing to details");
    assert.equal(f.hookRuns(), 1, "neither refused retire ran a hook");
    run.release("waits");
    const done = await run.done;
    assert.deepEqual(done.timedOut, []);
    assert.equal(done.code, 0, done.stdout + done.stderr);
  } finally { await run.finish(); }
  assert.equal(existsSync(i.home), false, "the retry passed and removed the home");
  assert.deepEqual(f.beside(i), []);
});

/** What a held completion of `i` leaves when its pending marker is removed or replaced while it waits
 *  (`change`), and checked where `at` says: "wait" once its wait has ended, before the retry; "claim"
 *  only by the retry itself, under the home's claim (the marker changes after the check that follows
 *  the wait has read it). */
async function markerChanged(t, change, at) {
  const f = deployment(t);
  const i = await f.spawn("dev", `${change}-${at}`);
  f.failRuns(1);
  const intent = f.schedule(i);
  const armed = join(f.fx.base, "armed");
  const gates = [{ name: "waits", fn: "writeFileSync", path: i.retryState, when: "after", waitMs: COMPLETION_MS },
    ...(at === "claim" ? [{ name: "checked", fn: "readFileSync", path: i.marker, when: "after", armed, waitMs: COMPLETION_MS }] : [])];
  const run = f.completeGated(intent, gates);
  // A later scheduling's marker: another requestedAt, naming no completion.
  const replacement = JSON.stringify({ ...intent, requestedAt: "2026-11-05T01:00:00.000Z" }, null, 2) + "\n";
  const doChange = () => { if (change === "replaced") writeFileSync(i.marker, replacement); else rmSync(i.marker); };
  let done;
  try {
    await run.waitGate("waits", COMPLETION_MS);
    if (at === "wait") doChange();
    else writeFileSync(armed, "");
    run.release("waits");
    if (at === "claim") {
      await run.waitGate("checked", COMPLETION_MS);
      doChange();
      run.release("checked");
    }
    done = await run.done;
    assert.deepEqual(done.timedOut, []);
  } finally { await run.finish(); }
  assert.equal(done.code, 1, done.stdout + done.stderr);
  assert.equal(f.hookRuns(), 1, "no second attempt ran");
  assert.equal(existsSync(i.home), true, "the home is kept");
  assert.ok(done.stderr.includes("attempt 2 of 4 is not started") && done.stderr.includes("its pending marker is no longer this completion's"), done.stderr);
  if (change === "replaced") assert.equal(readFileSync(i.marker, "utf8"), replacement, "the later scheduling's marker is left as it is");
  else assert.equal(existsSync(i.marker), false, "no marker is written back");
  const outcome = readJson(i.result);
  assert.deepEqual([outcome.ok, Object.hasOwn(outcome, "attempts")], [false, false], "the first attempt's outcome: no retry ran");
  assert.deepEqual(f.trace(i), [["retired", [[CAP, false]]], ["retire-refused", null, true]]);
  assert.equal(existsSync(i.retryState), false);
}
for (const change of ["removed", "replaced"]) {
  for (const at of ["wait", "claim"]) {
    test(`a pending marker ${change} while the completion waits (seen ${at === "wait" ? "after the wait" : "under the retry's claim"}): no retry runs, and the outcome is the first attempt's`, (t) => markerChanged(t, change, at));
  }
}

test("a quarantine whose descriptor could not be stored in the home is not retried: its restoration is debt of its own", async (t) => {
  if (ROOT) { t.skip("root writes whatever the mode says: this shape cannot fail"); return; }
  const f = deployment(t);
  const i = await f.spawn("dev", "unwritable");
  f.failRuns("all");
  const intent = f.schedule(i);
  // The quarantine marker cannot be written into the home: it is kept beside it, and the items say so.
  chmodSync(i.home, 0o500);
  f.fx.beforeCleanup(() => chmodSync(i.home, 0o700));
  const r = f.complete(intent);
  chmodSync(i.home, 0o700);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const outcome = readJson(i.result);
  assert.ok(outcome.result.rollbackIncomplete.some((item) => item.startsWith("cleanup descriptor ")), `fixture premise: the writer reported its own item: ${JSON.stringify(outcome.result.rollbackIncomplete)}`);
  assert.equal(f.hookRuns(), 1, "one attempt");
  assert.equal(Object.hasOwn(outcome, "attempts"), false, "the outcome as before");
});
