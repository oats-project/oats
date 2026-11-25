// A spawn writes the home's record through a private file renamed over it (#1659), the last time
// after the session has started: a status, a Desktop listing or a start that reads the record meets
// it before or after a write, never part of one. Each write is held by test/helpers/fs-gate-preload.mjs
// at its own rename, where a second reader is, so a write that goes back to writing the record in
// place reaches no gate. The record's bytes and mode are what they were (the retirement baseline
// digests both), and a spawn killed at a rename leaves a file that no retire counts as a change.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { disposableHomeRootProblem } from "../lib/capability-contract.mjs";
import { readHomeRecord } from "../lib/core.mjs";
import { CLI, v2Deployment, writeFixtureExecutable } from "./helpers/v2-deployment.mjs";
import { waitUntil } from "./helpers/host-fixture.mjs";
import { startGated } from "./helpers/fs-gate-preload.mjs";

const HAS_TMUX = !spawnSync("tmux", ["-V"], { stdio: "ignore" }).error;
const TMUX = { skip: !HAS_TMUX && "tmux is not installed" };
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const recordBytes = (meta) => JSON.stringify(meta, null, 2) + "\n";

/** One deployment, with a launch configuration whose harness is a stand-in that records its start and sleeps. */
function fixture(t) {
  const fx = v2Deployment({ t });
  const records = join(fx.base, "launches");
  mkdirSync(records);
  const executable = join(fx.base, "harness-stand-in");
  writeFixtureExecutable(fx.base, executable, `#!/bin/sh\necho "$$" > '${records}'/"$OATS_INSTANCE.$(date +%s%N).$$"\nexec sleep 600\n`);
  const localFile = join(fx.dep, "oats-local.yaml");
  writeFileSync(localFile, `${readFileSync(localFile, "utf8")}\nlaunch-configs:\n  stand-in:\n    harness: pi\n    executable: ${JSON.stringify(executable)}\n`);
  const f = { fx };
  f.cli = (argv) => { const r = fx.cli(argv); try { return JSON.parse(r.stdout); } catch { assert.fail(`no JSON answer from oats ${argv.join(" ")}: ${r.stdout}${r.stderr}`); } };
  f.homeOf = (name) => join(realpathSync(fx.dep), "agents", "dev", "instances", name);
  /** The argv of a spawn that names its decision and a key: only such a spawn records its completion. */
  f.keyed = (name, ...extra) => {
    const base = ["spawn", "dev", "--name", name, ...extra];
    const preview = f.cli([...base, "--preview", "--json"]);
    assert.equal(preview.ok, true, JSON.stringify(preview));
    return [...base, "--expect-decision", preview.result.decision.revision, "--idempotency-key", `key-${name}`, "--json"];
  };
  /** Held at the Nth write of the record of `name`, for each N in `writes`. */
  f.held = (name, argv, writes) => startGated([CLI, ...argv], { cwd: fx.dep, env: fx.env, gateDir: join(fx.base, "gates", name), gates: writes.map((nth) => ({ name: `write-${nth}`, fn: "renameSync", prefix: join(f.homeOf(name), "instance.json.tmp-"), nth, waitMs: 60000 })) });
  return f;
}
/** The private file of the write held in `home`. */
function heldWrite(home) {
  const tmps = readdirSync(home).filter((entry) => /^instance\.json\.tmp-\d+$/.test(entry));
  assert.equal(tmps.length, 1, `one private file beside the record: ${tmps}`);
  return join(home, tmps[0]);
}
/** The record a reader meets while a write is held, and the record the write will leave. */
function atTheRename(home) {
  const seen = readHomeRecord(home);
  assert.equal(seen.state, "record", `a reader meets a whole record: ${JSON.stringify(seen)}`);
  const next = readJson(heldWrite(home));
  return { seen: seen.meta, next };
}

test("every write of a spawn's record replaces it whole: a reader at each write meets the record before it, and the spawn's answer and its record are complete", async (t) => {
  const f = fixture(t);
  const home = f.homeOf("w1");
  const run = f.held("w1", f.keyed("w1", "--no-launch"), [1, 2, 3]);
  f.fx.beforeCleanup(() => { run.child.kill("SIGKILL"); });
  await run.waitGate("write-1");
  const first = atTheRename(home);
  assert.equal(first.next.launched, false, "the first write records that nothing was launched");
  assert.equal(first.next.spawnCompleted, false);
  run.release("write-1");
  await run.waitGate("write-2");
  const second = atTheRename(home);
  assert.equal(second.seen.spawnCompleted, false, "the reader meets the record before the completion");
  assert.equal(second.next.spawnCompleted, true);
  run.release("write-2");
  await run.waitGate("write-3");
  const third = atTheRename(home);
  assert.equal(third.seen.spawnCompleted, true);
  assert.equal(third.seen.wake, undefined, "the reader meets the record before the wake's outcome");
  assert.deepEqual(third.next.wake, { requested: false, saved: null, error: null });
  run.release("write-3");
  const r = await run.done;
  assert.deepEqual(r.timedOut, []);
  const answer = JSON.parse(r.stdout);
  assert.equal(answer.ok, true, r.stdout);
  assert.deepEqual(answer.result.wake, { requested: false, saved: null, error: null });
  const record = readFileSync(join(home, "instance.json"), "utf8");
  assert.equal(record, recordBytes(JSON.parse(record)), "the record's bytes are the ones the spawn wrote in place");
  assert.deepEqual(readdirSync(home).filter((entry) => entry.includes(".tmp-")), [], "no private file is left");
});

test("the record of a spawn's wake is the same write: a reader meets the record before the wake's outcome", async (t) => {
  const f = fixture(t);
  const home = f.homeOf("w6");
  const run = f.held("w6", f.keyed("w6", "--no-launch", "--wake-every", "10", "--wake-message", "hello"), [3]);
  f.fx.beforeCleanup(() => { run.child.kill("SIGKILL"); });
  await run.waitGate("write-3");
  const { seen, next } = atTheRename(home);
  assert.equal(seen.spawnCompleted, true);
  assert.equal(seen.wake, undefined);
  assert.equal(next.wake.requested, true);
  run.release("write-3");
  const r = await run.done;
  assert.deepEqual(r.timedOut, []);
  assert.equal(JSON.parse(r.stdout).result.wake.requested, true, r.stdout);
});

test("the write after the launch, while the session runs: a status at that moment reads the home, and the record it reads is whole", TMUX, async (t) => {
  const f = fixture(t);
  const home = f.homeOf("w2");
  const run = f.held("w2", f.keyed("w2", "--launch-config", "stand-in"), [2]);
  f.fx.beforeCleanup(() => { run.child.kill("SIGKILL"); });
  await run.waitGate("write-2", 60000);
  const { seen, next } = atTheRename(home);
  assert.equal(seen.launched, true, "the first write has landed and the session was launched");
  assert.equal(seen.spawnCompleted, false);
  assert.equal(next.spawnCompleted, true);
  const row = () => f.cli(["status", "--json"]).agents.flatMap((a) => a.instances).find((i) => i.instance === "w2");
  await waitUntil(() => row()?.running === true, "the session to read as running", 30000);
  assert.equal(row().unreadable, undefined, `a status at that moment reads the home: ${JSON.stringify(row())}`);
  run.release("write-2");
  const r = await run.done;
  assert.deepEqual(r.timedOut, []);
  assert.equal(JSON.parse(r.stdout).ok, true, r.stdout);
  assert.equal(readJson(join(home, "instance.json")).spawnCompleted, true);
});

test("the record keeps the mode the home was made with, whatever the process's umask lets a new file have: under a umask of 002 a keyed spawn leaves 0644 and a retire finds nothing changed", (t) => {
  const f = fixture(t);
  const argv = f.keyed("w3", "--no-launch");
  const spawned = spawnSync("sh", ["-c", `umask 002; exec ${[process.execPath, CLI, ...argv].map(shq).join(" ")}`], { encoding: "utf8", env: f.fx.env, cwd: f.fx.dep });
  assert.equal(JSON.parse(spawned.stdout).ok, true, spawned.stdout + spawned.stderr);
  const home = f.homeOf("w3");
  assert.equal((statSync(join(home, "instance.json")).mode & 0o7777).toString(8), "644");
  const retired = f.cli(["retire", "w3", "--json"]);
  assert.equal(retired.retired, "w3", JSON.stringify(retired));
  assert.equal(retired.workRecovery, undefined, `nothing in the home changed: ${JSON.stringify(retired.workRecovery)}`);
});

test("a spawn killed at a write leaves the private file and a whole record, and a retire does not count it as a change to the home; a file that only resembles it is still the home's", async (t) => {
  const f = fixture(t);
  const home = f.homeOf("w4");
  const run = f.held("w4", f.keyed("w4", "--no-launch"), [2]);
  f.fx.beforeCleanup(() => { run.child.kill("SIGKILL"); });
  await run.waitGate("write-2");
  const tmp = heldWrite(home);
  run.child.kill("SIGKILL");
  await run.done;
  assert.equal(existsSync(tmp), true, "fixture premise: the kill left the private file");
  assert.equal(readHomeRecord(home).state, "record");
  const retired = f.cli(["retire", "w4", "--json"]);
  assert.equal(retired.retired, "w4", JSON.stringify(retired));
  assert.equal(retired.workRecovery, undefined, `nothing in the home changed: ${JSON.stringify(retired.workRecovery)}`);
  assert.equal(existsSync(home), false);

  const spawned = f.cli(["spawn", "dev", "--name", "w5", "--no-launch", "--json"]);
  assert.equal(spawned.ok, true, JSON.stringify(spawned));
  writeFileSync(join(spawned.result.home, "instance.json.tmp-notes"), "the agent's");
  const kept = f.cli(["retire", "w5", "--json"]);
  assert.deepEqual(kept.workRecovery?.classes, ["changed instance-home bytes"], "only the private file's own name is passed over");
});

test("a capability cannot declare the record's private file as its own: it is no hidden name", () => {
  assert.equal(disposableHomeRootProblem("instance.json.tmp-12345"), "shape");
});
