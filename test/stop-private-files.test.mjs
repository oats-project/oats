// A stop leaves no private file when its write fails, and its text closes with a true sentence
// (awebai/oats#963).
//
// `oats instance stop --apply` writes two files into the home, each through a private file that
// is renamed over its name: the stop's record (`.oats-stop.json`, core.mjs writeJsonAtomic) and
// the receipt of its key (`.oats-stop-receipt.<key>.json`, instance-lifecycle.mjs
// writeFileSyncAtomic). On a file system with no space the private file is made, empty, and its
// write fails: nothing removed it, and each later apply left one more. And the text of such a
// stop closed with "some targets are still running" under a row that says the harness has exited.
//
// What the tests below hold, through the real CLI but for the sentence's own unit:
//   - each writer, alone, with its write made to fail once the file exists, and with its rename
//     made to fail: nothing is left at the private path, the file it would have written is not
//     there, and the stop answers what it answered;
//   - the error is that failure's own, also when the removal of the private file fails in its
//     turn: in the row, for the record's writer; for the receipt's writer, whose one caller keeps
//     the error to itself, in a call of the writer in a process of its own;
//   - every write under the home failing: the home holds no file of the stop afterwards, the JSON
//     receipt is the one #946 pinned, and the text closes with the sentence for a stop that could
//     not complete its record;
//   - the closing sentence is chosen from the rows' `stillRunning` as the docs tell a client to
//     read a row: a process named, or nothing established, is "still running"; `[]` is not.
//
// A write fails here by a fault at one named `node:fs` call of the kernel's own, in the one CLI
// child the test starts (test/helpers/fs-gate-preload.mjs, `throws`). `when: "after"` makes the
// call and then fails it: a file that was created, and whose write then found no space. Nothing
// is filled, and no outcome rests on a sleep.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { stopClosingLine } from "../lib/instance-lifecycle.mjs";
import { CLI, v2Deployment, writeFixtureExecutable } from "./helpers/v2-deployment.mjs";
import { waitUntil } from "./helpers/host-fixture.mjs";
import { runFaulted } from "./helpers/fs-gate-preload.mjs";

const hasTmux = !spawnSync("tmux", ["-V"], { stdio: "ignore" }).error;
/** These tests stop a live session: a stand-in harness in a window of the fixture's own tmux server. */
const TMUX = { skip: !hasTmux && "tmux is not installed" };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

/** The two sentences a stop that is not `ok` closes its text with. */
const STILL_RUNNING = "some targets are still running; nothing was escalated";
const RECORD_INCOMPLETE = "the stop did not complete its record; nothing is still running";

/** What a stop writes into a home, by name: its record, its receipts, and the private file of an
 *  atomic write (`<name>.tmp-<pid>`, `<name>.<pid>.tmp`). */
const stopFiles = (home) => readdirSync(home).filter((name) => name.startsWith(".oats-stop") || name.includes(".tmp")).sort();

/** The one JSON answer of a CLI run. */
function oneAnswer(r, what) {
  const lines = r.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `${what}: exactly one JSON answer on stdout\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  return JSON.parse(lines[0]);
}
/** The receipt of a stop apply that answered: exit 0, an envelope that is `ok`. */
function receiptOf(r, what) {
  const doc = oneAnswer(r, what);
  assert.deepEqual([r.status, doc.schemaVersion, doc.ok], [0, 1, true], `${what}: ${r.stdout}${r.stderr}`);
  return doc.result;
}

/** A deployment whose soul `worker` works in a directory. `add(name)` spawns an instance through
 *  the kernel's own spawn, launched: a stand-in harness runs for it in a window of the fixture's
 *  own tmux server, which the fixture's cleanup kills by socket. It says which process it is,
 *  then idles, and ends on SIGTERM; `{ stubborn: true }` gives one that SIGTERM does not end,
 *  which the fixture kills before it removes its base. */
function deployment(t) {
  const fx = v2Deployment({ t, souls: { worker: { soul: { work: "directory" } } } });
  const pids = join(fx.base, "harness-pids"), executable = join(fx.base, "harness-stand-in"), stubborn = join(fx.base, "harness-stubborn"), localFile = join(fx.dep, "oats-local.yaml");
  mkdirSync(pids);
  writeFixtureExecutable(fx.base, executable, `#!/bin/sh\necho $$ > '${pids}'/"$OATS_INSTANCE"\nexec sleep 600\n`);
  writeFixtureExecutable(fx.base, stubborn, `#!${process.execPath}\nprocess.on("SIGTERM", () => {});\nrequire("node:fs").writeFileSync(${JSON.stringify(pids)} + "/" + process.env.OATS_INSTANCE, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
  writeFileSync(localFile, YAML.stringify({ ...YAML.parse(readFileSync(localFile, "utf8")), "launch-configs": { "stand-in": { harness: "pi", executable }, stubborn: { harness: "pi", executable: stubborn } } }, { lineWidth: 0 }));
  const unending = [];
  fx.beforeCleanup(() => { for (const pid of unending) if (alive(pid)) process.kill(pid, "SIGKILL"); });
  let children = 0;
  const d = {
    fx,
    async add(name, { stubborn: unended = false } = {}) {
      // An in-process spawn finds its harness on this process's PATH: the fixture's inert ones.
      const hostPath = process.env.PATH;
      process.env.PATH = fx.env.PATH;
      let home;
      try { ({ home } = await fx.spawn("worker", { name, launch: true, launchConfig: unended ? "stubborn" : "stand-in" })); } finally { process.env.PATH = hostPath; }
      const read = () => { try { const text = readFileSync(join(pids, name), "utf8").trim(); return /^\d+$/.test(text) && Number(text) > 1 ? Number(text) : null; } catch { return null; } };
      await waitUntil(() => read() !== null && alive(read()), `the stand-in harness of ${name} to run`);
      const i = { name, home, pid: read(), receipt: (key) => join(home, `.oats-stop-receipt.${key}.json`), record: join(home, ".oats-stop.json") };
      if (unended) unending.push(i.pid);
      return i;
    },
    /** The stop plan of `name`, read once its pane reads as a running harness (the session's
     *  state is part of the plan's revision). */
    async runningPlan(name) {
      let plan;
      await waitUntil(() => {
        const r = fx.cli(["instance", "stop", name, "--plan", "--json"]);
        plan = oneAnswer(r, `the stop plan of ${name}`).result;
        return plan.targets.every((target) => target.session.present === true && target.session.state !== "shell");
      }, `the session of ${name} to read as running`);
      return plan;
    },
    applyArgs: (name, revision, key, extra = []) => ["instance", "stop", name, "--apply", "--plan-revision", revision, "--idempotency-key", key, ...extra],
    /** `oats <args>` run to its end with `faults`, gates that throw; or, with `script`, `node
     *  <script…>` so. → what runFaulted gives. */
    faulted: (args, faults, script = [CLI, ...args]) => runFaulted(script, { cwd: fx.dep, env: fx.env, gateDir: join(fx.base, "gates", String(++children)), gates: faults }),
  };
  return d;
}

/** One call of the receipt's writer in a process of its own: `node <this> <path>` writes
 *  `{ written: true }` at the path and prints what the call threw, or that it threw nothing. */
const WRITER_CALL = `import { writeFileSyncAtomic } from ${JSON.stringify(new URL("../lib/instance-lifecycle.mjs", import.meta.url).href)};
let threw = null;
try { writeFileSyncAtomic(process.argv[2], { written: true }); } catch (e) { threw = { code: e.code, syscall: e.syscall, path: e.path }; }
console.log(JSON.stringify({ threw }));
`;
/** The removal of the private file whose path starts with `prefix`, refused. */
const removalRefused = (prefix) => ({ name: "removal", fn: "rmSync", prefix, throws: "EACCES" });

/** The private file of each writer for `i`, as a path prefix: the name ends with the pid of the
 *  kernel process that writes it. */
const privateOfRecord = (i) => `${i.record}.tmp-`;
const privateOfReceipt = (i, key) => `${i.receipt(key)}.`;
/** The two ways a writer's private file fails, for the file whose path starts with `prefix`: its
 *  write once the file is made (no space for its bytes), and its rename. */
const WAYS = [
  ["the write, once the file is made", (prefix) => ({ name: "fault", fn: "writeFileSync", prefix, when: "after", throws: "ENOSPC" }), "ENOSPC", "write"],
  ["the rename", (prefix) => ({ name: "fault", fn: "renameSync", prefix, throws: "EIO" }), "EIO", "rename"],
];

test("the closing sentence of a stop's text is chosen from the rows' stillRunning: a failed row that names a process, or that establishes nothing (null, or no such key), is still running; a receipt whose failed rows all say [] did not complete its record, and nothing is still running (#963)", () => {
  const stopped = { instance: "a", home: "/h/a", ok: true, stopped: true, alreadyIdle: false, state: "shell" };
  const failed = (stillRunning) => ({ instance: "b", home: "/h/b", ok: false, code: "E_SESSION_STOP_FAILED", message: "b: a message", ...(stillRunning === undefined ? {} : { stillRunning }) });
  const receipt = (results, extra = {}) => ({ lifecycleApi: 1, action: "stop", ok: results.every((r) => r.ok), results, replayed: false, ...extra });
  const OK = "stopped; home, work, transcript and launch configuration retained — restart with `oats session restart`";
  for (const [what, results, line] of [
    ["every target stopped", [stopped], OK],
    ["a row with a process still running", [failed([4242])], STILL_RUNNING],
    ["a row that cannot say: null", [failed(null)], STILL_RUNNING],
    ["a row that cannot say: no such key", [failed(undefined)], STILL_RUNNING],
    ["a row whose harness exited, the stop's record not written", [failed([])], RECORD_INCOMPLETE],
    ["two such rows", [failed([]), failed([])], RECORD_INCOMPLETE],
    ["such a row beside a target that stopped", [stopped, failed([])], RECORD_INCOMPLETE],
    ["a mix: one row exited, one still runs", [failed([]), failed([4242])], STILL_RUNNING],
    ["a mix: one row exited, one cannot say", [failed([]), failed(null)], STILL_RUNNING],
    ["a mix, the other way round, beside a target that stopped", [failed(null), stopped, failed([])], STILL_RUNNING],
  ]) assert.equal(stopClosingLine(receipt(results)), line, what);
  assert.equal(stopClosingLine(receipt([stopped], { replayed: true })), "stopped (replayed receipt); home, work, transcript and launch configuration retained — restart with `oats session restart`", "a replayed receipt that is ok says so, as before");
  assert.equal(stopClosingLine(receipt([failed([])], { replayed: true })), RECORD_INCOMPLETE, "a replayed receipt that is not ok is read by its rows too");
});

test("the stop's record (writeJsonAtomic): when its private file's write fails once the file is made, or its rename fails, nothing is left at the private path, the record is not there, and the row holds that failure's own error (#963)", TMUX, async (t) => {
  const d = deployment(t);
  for (const [way, fault, code, syscall] of WAYS) await t.test(way, async () => {
    const i = await d.add(`record-${syscall}`);
    const plan = await d.runningPlan(i.name);
    const r = d.faulted(d.applyArgs(i.name, plan.planRevision, "k1", ["--json"]), [fault(privateOfRecord(i))]);
    assert.deepEqual(r.fired, ["fault"], `${way}: the fault was met`);
    const receipt = receiptOf(r, way);
    const [row] = receipt.results;
    assert.deepEqual([receipt.ok, receipt.results.length, row.ok, row.code, row.stillRunning], [false, 1, false, "E_SESSION_STOP_FAILED", []], `${way}: ${r.stdout}`);
    assert.match(row.message, new RegExp(`^${i.name}: ${code}: .*, ${syscall} '.*\\.oats-stop\\.json\\.tmp-\\d+'; its harness was signalled \\(SIGTERM\\) and has exited$`), `${way}: the error is that call's own`);
    await waitUntil(() => !alive(i.pid), `the harness of ${i.name} to be gone`);
    assert.deepEqual(stopFiles(i.home), [".oats-stop-receipt.k1.json"], `${way}: no private file and no record; the receipt of the key is stored as for any stop`);
  });
  for (const [way, fault, code, syscall] of WAYS) await t.test(`${way}, and the removal of the private file is refused: the row holds the first error, not the removal's`, async () => {
    const i = await d.add(`record-kept-${syscall}`);
    const plan = await d.runningPlan(i.name);
    const r = d.faulted(d.applyArgs(i.name, plan.planRevision, "k1", ["--json"]), [fault(privateOfRecord(i)), removalRefused(privateOfRecord(i))]);
    assert.deepEqual(r.fired, ["fault", "removal"], `${way}: both faults were met`);
    const [row] = receiptOf(r, way).results;
    assert.deepEqual([row.ok, row.code, row.stillRunning], [false, "E_SESSION_STOP_FAILED", []], `${way}: ${r.stdout}`);
    assert.match(row.message, new RegExp(`^${i.name}: ${code}: .*, ${syscall} '.*\\.oats-stop\\.json\\.tmp-\\d+'; its harness was signalled \\(SIGTERM\\) and has exited$`), `${way}: the error is that call's own`);
    assert.doesNotMatch(row.message, /EACCES/, `${way}: the removal's failure is not answered`);
    assert.equal(r.stderr, "", `${way}: and is not printed`);
    await waitUntil(() => !alive(i.pid), `the harness of ${i.name} to be gone`);
    const left = stopFiles(i.home);
    assert.deepEqual([left.length, left[0], /^\.oats-stop\.json\.tmp-\d+$/.test(left[1])], [2, ".oats-stop-receipt.k1.json", true], `${way}: the private file is there, since its removal was refused, and nothing else: ${left}`);
  });
});

test("the receipt of a key (writeFileSyncAtomic): when its private file's write fails once the file is made, or its rename fails, nothing is left at the private path and no receipt is stored; the stop answers as it did, its record written (#963)", TMUX, async (t) => {
  const d = deployment(t);
  for (const [way, fault, , syscall] of WAYS) await t.test(way, async () => {
    const i = await d.add(`receipt-${syscall}`);
    const plan = await d.runningPlan(i.name);
    const r = d.faulted(d.applyArgs(i.name, plan.planRevision, "k1", ["--json"]), [fault(privateOfReceipt(i, "k1"))]);
    assert.deepEqual(r.fired, ["fault"], `${way}: the fault was met`);
    // The caller keeps a receipt that cannot be stored to itself (evidence, not authority): the
    // answer is the one of a stop that stored it. What the writer throws is in its own test, below.
    const receipt = receiptOf(r, way);
    assert.deepEqual([receipt.ok, receipt.replayed, receipt.results.map((row) => [row.ok, row.stopped, row.alreadyIdle])], [true, false, [[true, true, false]]], `${way}: ${r.stdout}`);
    assert.equal(r.stderr, "", way);
    await waitUntil(() => !alive(i.pid), `the harness of ${i.name} to be gone`);
    assert.deepEqual(stopFiles(i.home), [".oats-stop.json"], `${way}: no private file and no receipt of the key; the stop's record is there`);
  });
});

test("the receipt's writer, called alone (its caller keeps the error to itself): it writes the bytes it wrote and leaves nothing beside them; when its private file's write fails once the file is made, or its rename fails, it throws that failure's own error, the file at the path is as it was and nothing is left; and when the removal is refused too, the error is still the first (#963)", async (t) => {
  const d = deployment(t);
  const script = join(d.fx.base, "writer-call.mjs");
  writeFileSync(script, WRITER_CALL);
  let n = 0;
  /** One call in a directory of its own, with `faults`; `before`: what the path holds first, if anything. → { r, threw, dir, path } */
  const call = (faults, before) => {
    const dir = join(d.fx.base, `unit-${++n}`), path = join(dir, "receipt.json");
    mkdirSync(dir);
    if (before !== undefined) writeFileSync(path, before);
    const gates = faults.map((make) => make(`${path}.`));
    const r = gates.length ? d.faulted([], gates, [script, path]) : spawnSync(process.execPath, [script, path], { cwd: d.fx.dep, env: d.fx.env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return { r, threw: JSON.parse(r.stdout.trim()).threw, dir, path };
  };
  const BYTES = JSON.stringify({ written: true }, null, 2);

  await t.test("nothing fails: the bytes, at the path, over what was there, and nothing beside them", () => {
    for (const before of [undefined, "what was there\n"]) {
      const { threw, dir, path } = call([], before);
      assert.equal(threw, null);
      assert.deepEqual(readdirSync(dir), ["receipt.json"]);
      assert.equal(readFileSync(path, "utf8"), BYTES);
    }
  });
  for (const [way, fault, code, syscall] of WAYS) {
    await t.test(way, () => {
      for (const before of [undefined, "what was there\n"]) {
        const { r, threw, dir, path } = call([fault], before);
        assert.deepEqual(r.fired, ["fault"], "the fault was met");
        assert.deepEqual([threw.code, threw.syscall, threw.path.startsWith(`${path}.`), /\.\d+\.tmp$/.test(threw.path)], [code, syscall, true, true], `the error is that call's own, at the private path: ${JSON.stringify(threw)}`);
        assert.deepEqual(readdirSync(dir), before === undefined ? [] : ["receipt.json"], "nothing is left at the private path");
        if (before !== undefined) assert.equal(readFileSync(path, "utf8"), before, "what the path held is as it was");
      }
    });
    await t.test(`${way}, and the removal of the private file is refused: the error thrown is the first, not the removal's`, () => {
      const { r, threw, dir } = call([fault, removalRefused]);
      assert.deepEqual(r.fired, ["fault", "removal"], "both faults were met");
      assert.deepEqual([threw.code, threw.syscall], [code, syscall], JSON.stringify(threw));
      const left = readdirSync(dir);
      assert.deepEqual([left.length, /^receipt\.json\.\d+\.tmp$/.test(left[0])], [1, true], `the private file is there, since its removal was refused, and nothing else: ${left}`);
    });
  }
});

test("with no space for any write under the home (each file is made, then its write fails): the home holds no file of the stop afterwards, the JSON receipt is the one of a stop on a full file system, and the text prints the row and closes with the sentence for a record that was not completed, exit 1 (#963)", TMUX, async (t) => {
  const d = deployment(t);
  const i = await d.add("full1"), j = await d.add("full2");
  const plans = { i: await d.runningPlan(i.name), j: await d.runningPlan(j.name) };
  /** Every write of bytes under that home finds no space, once its file is made. */
  const full = (home) => ["writeFileSync", "appendFileSync"].map((fn) => ({ name: fn, fn, prefix: `${home}/`, when: "after", throws: "ENOSPC", every: true }));

  // JSON mode: the receipt as it was (test/stop-unwritable-claim.test.mjs pins it for a file
  // system that is full everywhere; here the claim, outside the home, is written, so no warning).
  const first = d.faulted(d.applyArgs(i.name, plans.i.planRevision, "k1", ["--json"]), full(i.home));
  assert.ok(first.fired.includes("writeFileSync"), `the writes were reached, and failed: ${first.fired}`);
  const receipt = receiptOf(first, "the stop with no space in its home");
  assert.equal(first.stderr, "");
  assert.deepEqual([receipt.ok, receipt.replayed, receipt.results.length], [false, false, 1]);
  const [row] = receipt.results;
  assert.deepEqual(Object.keys(row).sort(), ["code", "home", "instance", "message", "ok", "stillRunning"], "the row of a target that failed, with no new key");
  assert.deepEqual({ ...row, message: undefined }, { instance: i.name, home: i.home, ok: false, code: "E_SESSION_STOP_FAILED", message: undefined, stillRunning: [] });
  assert.match(row.message, /^full1: ENOSPC: .*; its harness was signalled \(SIGTERM\) and has exited$/);
  await waitUntil(() => !alive(i.pid), "the harness of full1 to be gone: the stop stopped it");
  assert.deepEqual(stopFiles(i.home), [], "no record, no receipt, and no private file of either");

  // Text mode, on the other instance: the row, then the sentence that is true of it.
  const text = d.faulted(d.applyArgs(j.name, plans.j.planRevision, "k1"), full(j.home));
  assert.ok(text.fired.includes("writeFileSync"), `the writes were reached, and failed: ${text.fired}`);
  assert.equal(text.status, 1, text.stdout + text.stderr);
  assert.equal(text.stderr, "");
  assert.match(text.stdout, new RegExp(`^ {2}full2: E_SESSION_STOP_FAILED — full2: ENOSPC: .*; its harness was signalled \\(SIGTERM\\) and has exited\\n${RECORD_INCOMPLETE}\\n$`));
  assert.doesNotMatch(text.stdout, /still running; nothing was escalated/);
  await waitUntil(() => !alive(j.pid), "the harness of full2 to be gone");
  assert.deepEqual(stopFiles(j.home), [], "no record, no receipt, and no private file of either");
});

test("a harness that SIGTERM does not end: the text closes with the sentence it closed with, some targets are still running, exit 1 (#963)", TMUX, async (t) => {
  const d = deployment(t);
  const i = await d.add("unended", { stubborn: true });
  const plan = await d.runningPlan(i.name);
  const r = d.fx.cli(d.applyArgs(i.name, plan.planRevision, "k1", ["--grace-ms", "400"]));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`^ {2}unended: E_SESSION_STOP_FAILED — unended was asked to stop \\(SIGTERM to .*\\) and is still running after \\d+ ms; nothing was escalated\\n${STILL_RUNNING}\\n$`));
  assert.equal(alive(i.pid), true, "nothing was escalated: the harness runs");
  assert.equal(existsSync(i.record), true, "the stop's record is written for a stop that was refused too");
});
