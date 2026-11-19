// A spawn does not depend on its caller to finish. A caller that goes away while `oats spawn` runs
// (a non-interactive ssh session that ends) closes the spawn's stdout and stderr, and may send it
// SIGHUP. Whatever the moment, the home ends complete, with its full record, or is rolled back and
// gone: never a directory with no record, which no command but a forced retire removes.
//
//   - a closed stdout or stderr only means that nobody reads: the spawn goes on to its end, what it
//     can no longer print is dropped, and its exit status is the spawn's own (0), as for
//     `oats worktree add`. The answer that was not delivered is the home's record, and a spawn
//     that named its decision and a key answers it again when it is repeated;
//   - SIGINT, SIGTERM or SIGHUP while the capabilities are copied into the new home (the one wait
//     between the home's creation and its first hook) is held until the copy ends: the home is
//     then removed and the spawn answers E_INTERRUPTED, exit 128 + the signal, as it does while
//     its worktree hooks run;
//   - a signal while a spawn hook runs reaches the process once the spawn has returned: the home
//     is complete and the answer is written before the process ends with 128 + the signal.
//
// Each test runs the real CLI as a child whose stdout and stderr are pipes, and closes their read
// ends, or signals the child, at a moment a hook or a held call marks.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readHomeRecord } from "../lib/core.mjs";
import { CLI, v2Deployment } from "./helpers/v2-deployment.mjs";
import { waitUntil } from "./helpers/host-fixture.mjs";
import { startGated } from "./helpers/fs-gate-preload.mjs";

const WAIT_MS = 120000;
/** The hook of every event. It appends its event to `<agents root>/hook.log`. When
 *  `<agents root>/hold-<event>` exists it writes `<event>-running`, prints a line on each of its
 *  streams, waits for `<event>-release` and prints again: output on both sides of the wait. */
const HOOK = `import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = process.env.OATS_ROOT, event = process.env.OATS_EVENT;
appendFileSync(join(root, "hook.log"), event + "\\n");
if (existsSync(join(root, "hold-" + event))) {
  console.error("the " + event + " hook is held");
  writeFileSync(join(root, event + "-running"), String(process.pid));
  for (const end = Date.now() + ${WAIT_MS}; !existsSync(join(root, event + "-release")) && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 20));
  console.error("the " + event + " hook goes on");
  await new Promise((resolve) => setTimeout(resolve, 200));
  console.error("the " + event + " hook ends");
}
console.log(JSON.stringify({ meta: { [event]: true } }));
`;

function deployment(t) {
  const fx = v2Deployment({ t,
    souls: { dev: { soul: { work: "directory", capabilities: { "test.hook": { from: "here" } } } } },
    capabilities: { "test.hook": { manifest: { hooks: { spawn: "hook.mjs", retire: "hook.mjs", worktree: { command: "hook.mjs", required: true } } }, files: { "hook.mjs": HOOK } } } });
  const at = (name) => join(fx.root, name);
  const f = {
    fx,
    homeOf: (name) => join(realpathSync(fx.root), "dev", "instances", name),
    hold: (event) => writeFileSync(at(`hold-${event}`), ""),
    running: (event) => existsSync(at(`${event}-running`)),
    release: (event) => writeFileSync(at(`${event}-release`), ""),
    events: () => (existsSync(at("hook.log")) ? readFileSync(at("hook.log"), "utf8").split("\n").filter(Boolean) : []),
    /** `oats <argv>` as a child whose stdout and stderr are pipes → the child, what it wrote while
     *  it was read, and `ended`: `{ code, signal }` once it has exited and its pipes are closed. */
    start: (argv) => {
      const child = spawn(process.execPath, [CLI, ...argv], { cwd: fx.dep, env: fx.env, stdio: ["ignore", "pipe", "pipe"] });
      const run = { child, stdout: "", stderr: "", exited: false };
      child.stdout.on("data", (chunk) => { run.stdout += chunk; });
      child.stderr.on("data", (chunk) => { run.stderr += chunk; });
      child.on("exit", () => { run.exited = true; });
      run.ended = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
      /** The caller goes away: the read ends of both pipes are closed. */
      run.closeReader = () => { child.stdout.destroy(); child.stderr.destroy(); };
      /** Wait for `reached`, or fail with what the child wrote when it ended first. */
      run.until = (reached, what) => waitUntil(() => { assert.equal(run.exited, false, `the spawn ended before ${what}\n${run.stdout}${run.stderr}`); return reached(); }, what, WAIT_MS);
      return run;
    },
    /** The last line of `text`, parsed: the one envelope of a JSON-mode answer. */
    envelope: (text) => JSON.parse(text.trim().split("\n").pop()),
    /** The row of `name` in `oats status --json`, or undefined. */
    row: (name) => {
      const r = fx.cli(["status", "--json"]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      return JSON.parse(r.stdout).agents.flatMap((agent) => agent.instances).find((row) => row.instance === name);
    },
  };
  return f;
}
/** The home of `name` is complete: its record reads as one, nothing marks it as a spawn in progress
 *  or as quarantined, and its briefing, the last file a spawn writes before its record, is there. → the record. */
function complete(f, name) {
  const home = f.homeOf(name), read = readHomeRecord(home);
  assert.equal(read.state, "record", `the home has its record: ${JSON.stringify(read)}`);
  assert.deepEqual([existsSync(join(home, ".oats-rollback-incomplete.json")), existsSync(join(home, "TASK.md"))], [false, true], "no marker of a spawn in progress, and the briefing is written");
  const row = f.row(name);
  assert.deepEqual([row?.home, row?.spawnInProgress, row?.rollbackIncomplete], [home, undefined, undefined], "oats status lists it as an instance like any other");
  return read.meta;
}
/** Nothing of `name` is left: no home, and the name can be spawned again. */
function rolledBack(f, name) {
  assert.equal(existsSync(f.homeOf(name)), false, `the home is gone: ${existsSync(f.homeOf(name)) ? readdirSync(f.homeOf(name)) : ""}`);
  assert.equal(f.row(name), undefined, "oats status lists no such instance");
}

test("a caller that closes stdout and stderr while a spawn hook runs: the spawn completes with its full record and exits 0, and the same decision and key answer it again", async (t) => {
  const f = deployment(t);
  const base = ["spawn", "dev", "--name", "dropped", "--no-launch"];
  const preview = f.fx.cli([...base, "--preview", "--json"]);
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  const keyed = [...base, "--expect-decision", f.envelope(preview.stdout).result.decision.revision, "--idempotency-key", "key-dropped", "--json"];
  f.hold("spawn");
  const run = f.start(keyed);
  await run.until(() => f.running("spawn"), "its spawn hook ran");
  run.closeReader();
  f.release("spawn");
  assert.deepEqual(await run.ended, { code: 0, signal: null }, "the spawn ends as a spawn that was read to its end does");
  const meta = complete(f, "dropped");
  assert.equal(meta.spawnCompleted, true, "the record says that the spawn completed");
  assert.deepEqual(f.events(), ["spawn"], "its spawn hook ran once, and nothing was compensated");
  // The answer nobody read: the same decision and key give it again, and spawn nothing.
  const again = f.fx.cli(keyed);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  const answer = f.envelope(again.stdout);
  assert.deepEqual([answer.ok, answer.result.replayed, answer.result.instance, answer.result.home], [true, true, "dropped", f.homeOf("dropped")]);
  assert.deepEqual(f.events(), ["spawn"], "the replay ran no hook");
});

test("a caller that is gone before the spawn writes anything, in text mode: the spawn completes with its full record and exits 0", async (t) => {
  const f = deployment(t);
  f.hold("spawn");
  const run = f.start(["spawn", "dev", "--name", "unread", "--no-launch"]);
  run.closeReader();
  await run.until(() => f.running("spawn"), "its spawn hook ran");
  f.release("spawn");
  assert.deepEqual(await run.ended, { code: 0, signal: null });
  complete(f, "unread");
  assert.deepEqual(f.events(), ["spawn"]);
});

test("SIGHUP while the capabilities are copied into the new home: the copy ends, the home is removed, and the spawn answers E_INTERRUPTED and exits 129; the same spawn then succeeds", async (t) => {
  const f = deployment(t);
  const argv = ["spawn", "dev", "--name", "hung-up", "--no-launch", "--json"];
  const home = f.homeOf("hung-up");
  // Held at the first directory the copy makes in the home: the home exists, and holds nothing.
  const run = startGated([CLI, ...argv], { cwd: f.fx.dep, env: f.fx.env, gateDir: join(f.fx.base, "gates"), gates: [{ name: "copy", fn: "mkdirSync", prefix: `${home}/`, waitMs: WAIT_MS }] });
  try {
    await run.waitGate("copy", WAIT_MS);
    assert.deepEqual(readdirSync(home), [], "fixture premise: the spawn is held with its home made and nothing in it");
    run.child.kill("SIGHUP");
    run.release("copy");
    const done = await run.done;
    assert.deepEqual(done.timedOut, []);
    rolledBack(f, "hung-up");
    assert.deepEqual([done.code, done.signal], [129, null], done.stdout + done.stderr);
    const { ok, error } = f.envelope(done.stdout);
    assert.deepEqual([ok, error.code, error.details], [false, "E_INTERRUPTED", { signal: "SIGHUP", hooks: [] }], error.message);
    assert.deepEqual(f.events(), [], "no hook had run, so there is nothing to compensate");
  } finally { await run.finish(); }
  const again = f.fx.cli(argv);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  complete(f, "hung-up");
});

test("SIGHUP while a spawn hook runs: the spawn completes with its full record and writes its answer, then the process ends with 129", async (t) => {
  const f = deployment(t);
  f.hold("spawn");
  const run = f.start(["spawn", "dev", "--name", "hooked", "--no-launch", "--json"]);
  await run.until(() => f.running("spawn"), "its spawn hook ran");
  run.child.kill("SIGHUP");
  f.release("spawn");
  assert.deepEqual(await run.ended, { code: 129, signal: null }, run.stdout + run.stderr);
  complete(f, "hooked");
  const answer = f.envelope(run.stdout);
  assert.deepEqual([answer.ok, answer.result.instance, answer.result.home], [true, "hooked", f.homeOf("hooked")]);
  assert.deepEqual(f.events(), ["spawn"]);
});

test("SIGHUP while a worktree hook runs, its caller gone: the hook is ended, the spawn is compensated and its home removed, and the process ends with 129", async (t) => {
  const f = deployment(t);
  f.hold("worktree");
  const run = f.start(["spawn", "dev", "--name", "treed", "--work", "worktree", "--no-launch", "--json"]);
  await run.until(() => f.running("worktree"), "its worktree hook ran");
  run.closeReader();
  run.child.kill("SIGHUP");
  assert.deepEqual(await run.ended, { code: 129, signal: null });
  rolledBack(f, "treed");
  assert.deepEqual(f.events(), ["spawn", "worktree", "retire"], "the retire hook compensated what the spawn hook made");
});
