// Every write of a home's record replaces it whole and keeps its mode (#1660; a spawn's own writes,
// test/spawn-record-atomic.test.mjs). The one that wrote in place was a retire's lineage repair,
// which rewrites the records of the retiree's orphans. A retire stops its recorded children first,
// so an orphan with a running session is its sibling: the repair is held here at its own rename,
// where a second reader is. A rename and a write in place do not fail alike (a
// rename needs the directory, a write the file), so the repair's refusals are pinned to what a write
// in place answered. The mode is the record's own: the process that writes may not be the one that
// made the home.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readHomeRecord } from "../lib/core.mjs";
import { CLI, v2Deployment, writeFixtureExecutable } from "./helpers/v2-deployment.mjs";
import { waitUntil } from "./helpers/host-fixture.mjs";
import { runFaulted, startGated } from "./helpers/fs-gate-preload.mjs";

const HAS_TMUX = !spawnSync("tmux", ["-V"], { stdio: "ignore" }).error;
const TMUX = { skip: !HAS_TMUX && "tmux is not installed" };
const isRoot = process.getuid?.() === 0;
const NOT_ROOT = { skip: isRoot && "root writes through a mode" };
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const modeOf = (path) => (statSync(path).mode & 0o7777).toString(8);
const privateFiles = (home) => readdirSync(home).filter((entry) => entry.includes(".tmp-"));

/** One deployment, with a stand-in harness that records its start and sleeps. */
function fixture(t) {
  const fx = v2Deployment({ t });
  const records = join(fx.base, "launches");
  mkdirSync(records);
  const executable = join(fx.base, "harness-stand-in");
  writeFixtureExecutable(fx.base, executable, `#!/bin/sh\necho "$$" > '${records}'/"$OATS_INSTANCE.$(date +%s%N).$$"\nexec sleep 600\n`);
  const localFile = join(fx.dep, "oats-local.yaml");
  writeFileSync(localFile, `${readFileSync(localFile, "utf8")}\nlaunch-configs:\n  stand-in:\n    harness: pi\n    executable: ${JSON.stringify(executable)}\n`);
  const f = { fx };
  const answer = (r, argv) => { try { return JSON.parse(r.stdout); } catch { assert.fail(`no JSON answer from oats ${argv.join(" ")}: ${r.stdout}${r.stderr}`); } };
  f.cli = (argv) => answer(fx.cli(argv), argv);
  /** The CLI under `umask`, which is not the umask the home was made with. */
  f.under = (umask, argv) => answer(spawnSync("sh", ["-c", `umask ${umask}; exec ${[process.execPath, CLI, ...argv].map(shq).join(" ")}`], { encoding: "utf8", env: fx.env, cwd: fx.dep }), argv);
  f.homeOf = (name) => join(realpathSync(fx.dep), "agents", "dev", "instances", name);
  f.spawn = (name, ...extra) => {
    const made = f.cli(["spawn", "dev", "--name", name, ...extra, "--json"]);
    assert.equal(made.ok, true, JSON.stringify(made));
    return made.result.home;
  };
  /** A parent and its child, stopped: a retire of the parent repairs the child's record. */
  f.family = (...childArgs) => {
    f.spawn("pa", "--no-launch");
    return f.spawn("ch", "--parent", "pa", ...childArgs);
  };
  f.row = (name) => f.cli(["status", "--json"]).agents.flatMap((a) => a.instances).find((i) => i.instance === name);
  /** A retire of the parent, held at the rename of the child's record. */
  f.heldRetire = (home) => {
    const run = startGated([CLI, "retire", "pa", "--json"], { cwd: fx.dep, env: fx.env, gateDir: join(fx.base, "gates"), gates: [{ name: "repair", fn: "renameSync", prefix: join(home, "instance.json.tmp-"), waitMs: 60000 }] });
    fx.beforeCleanup(() => { run.child.kill("SIGKILL"); });
    return run;
  };
  return f;
}
const heldWrite = (home) => {
  const tmps = readdirSync(home).filter((entry) => /^instance\.json\.tmp-\d+$/.test(entry));
  assert.equal(tmps.length, 1, `one private file beside the record: ${tmps}`);
  return join(home, tmps[0]);
};

test("a retire's repair of a running sibling's record replaces it whole: a status at that moment reads the home, and a reader meets the old edge, then the new record", TMUX, async (t) => {
  const f = fixture(t);
  f.spawn("pa", "--no-launch");
  const home = f.spawn("ch", "--relation", "sibling", "--relative-to", "pa", "--launch-config", "stand-in");
  await waitUntil(() => f.row("ch")?.running === true, "the sibling's session to run", 30000);
  const run = f.heldRetire(home);
  await run.waitGate("repair", 60000);
  const seen = readHomeRecord(home);
  assert.equal(seen.state, "record", `a reader meets a whole record: ${JSON.stringify(seen)}`);
  assert.equal(seen.meta.siblingInstance, "pa", "the reader meets the record before the repair");
  const before = readFileSync(join(home, "instance.json"), "utf8");
  const next = readFileSync(heldWrite(home), "utf8");
  assert.equal(JSON.parse(next).siblingInstance, undefined, "the private file holds the repaired record");
  const { siblingInstance, ...kept } = JSON.parse(before);
  assert.equal(next, JSON.stringify(kept, null, 2) + "\n", "the bytes are the record's own, less the edge");
  const row = f.row("ch");
  assert.equal(row.running, true);
  assert.equal(row.unreadable, undefined, `a status at that moment reads the home: ${JSON.stringify(row)}`);
  run.release("repair");
  const r = await run.done;
  assert.deepEqual(r.timedOut, []);
  assert.deepEqual(JSON.parse(r.stdout).relinked.map((e) => e.instance), ["ch"], r.stdout);
  assert.equal(readFileSync(join(home, "instance.json"), "utf8"), next);
  assert.deepEqual(privateFiles(home), []);
  assert.equal(f.row("ch").running, true, "the sibling's session runs on");
});

test("a retire killed at the repair leaves the orphan a whole record and a private file that nothing counts: its status reads, and its own retire finds nothing changed", async (t) => {
  const f = fixture(t);
  const home = f.family("--no-launch");
  const run = f.heldRetire(home);
  await run.waitGate("repair");
  const tmp = heldWrite(home);
  run.child.kill("SIGKILL");
  await run.done;
  assert.equal(existsSync(tmp), true, "fixture premise: the kill left the private file");
  assert.equal(readHomeRecord(home).meta.parentInstance, "pa");
  assert.equal(f.row("ch").unreadable, undefined);
  const retired = f.cli(["retire", "ch", "--json"]);
  assert.equal(retired.retired, "ch", JSON.stringify(retired));
  assert.equal(retired.workRecovery, undefined, `nothing in the home changed: ${JSON.stringify(retired.workRecovery)}`);
});

test("a record this process may not write refuses the repair as a write in place does: the retire stops after its hooks with the same answer, and the record is as it was", NOT_ROOT, (t) => {
  const f = fixture(t);
  const home = f.family("--no-launch");
  const record = join(home, "instance.json");
  chmodSync(record, 0o444);
  const before = readFileSync(record, "utf8");
  const answer = f.cli(["retire", "pa", "--json"]);
  assert.equal(answer.error?.code, "E_LIFECYCLE_FAILED", JSON.stringify(answer));
  assert.ok(answer.error.message.startsWith(`EACCES: permission denied, open '${record}'. The retire hooks have run;`), answer.error.message);
  assert.equal(answer.error.details.reached.phase, "after-hooks");
  assert.equal(answer.error.details.reached.home, "kept");
  assert.equal(readFileSync(record, "utf8"), before);
  assert.equal(modeOf(record), "444");
  assert.deepEqual(privateFiles(home), []);
});

test("a home that refuses a private file beside a record this process may write is repaired in place, as it always was: the retire answers as it did", NOT_ROOT, (t) => {
  const f = fixture(t);
  const home = f.family("--no-launch");
  chmodSync(home, 0o555);
  let answer;
  try { answer = f.cli(["retire", "pa", "--json"]); } finally { chmodSync(home, 0o755); }
  assert.equal(answer.retired, "pa", JSON.stringify(answer));
  assert.deepEqual(answer.relinked.map((e) => e.instance), ["ch"]);
  assert.equal(readJson(join(home, "instance.json")).parentInstance, undefined);
  assert.deepEqual(privateFiles(home), []);
});

for (const [way, gate] of [
  ["a full disk at the private file's write", (prefix) => ({ name: "fault", fn: "writeFileSync", prefix, when: "after", throws: "ENOSPC" })],
  ["a private file that cannot be made", (prefix) => ({ name: "fault", fn: "writeFileSync", prefix, throws: "EIO" })],
  ["a rename refused with EACCES", (prefix) => ({ name: "fault", fn: "renameSync", prefix, throws: "EACCES" })],
  ["a rename refused with EPERM", (prefix) => ({ name: "fault", fn: "renameSync", prefix, throws: "EPERM" })],
  ["a rename failing EIO", (prefix) => ({ name: "fault", fn: "renameSync", prefix, throws: "EIO" })],
]) {
  test(`any failure of the atomic write leaves the repair to a write in place, so the retire answers as it did: ${way}`, (t) => {
    const f = fixture(t);
    const home = f.family("--no-launch");
    const record = join(home, "instance.json");
    const r = runFaulted([CLI, "retire", "pa", "--json"], { cwd: f.fx.dep, env: f.fx.env, gateDir: join(f.fx.base, "gates"), gates: [gate(`${record}.tmp-`)] });
    assert.deepEqual(r.fired, ["fault"], `fixture premise: the fault was met: ${r.stdout}${r.stderr}`);
    const answer = JSON.parse(r.stdout);
    assert.equal(answer.retired, "pa", r.stdout);
    assert.deepEqual(answer.relinked.map((e) => e.instance), ["ch"]);
    assert.equal(readJson(record).parentInstance, undefined, "the repair was written");
    assert.deepEqual(privateFiles(home), [], "no private file is left");
  });
}

test("the write in place's own failure is the answer, as it always was: the atomic write failed too, and no private file is left", (t) => {
  const f = fixture(t);
  const home = f.family("--no-launch");
  const record = join(home, "instance.json");
  const before = readFileSync(record, "utf8");
  const r = runFaulted([CLI, "retire", "pa", "--json"], { cwd: f.fx.dep, env: f.fx.env, gateDir: join(f.fx.base, "gates"), gates: [
    { name: "rename", fn: "renameSync", prefix: `${record}.tmp-`, throws: "EIO" },
    { name: "in-place", fn: "writeFileSync", path: record, throws: "ENOSPC" },
  ] });
  assert.deepEqual(r.fired, ["rename", "in-place"], `fixture premise: both faults were met: ${r.stdout}${r.stderr}`);
  const answer = JSON.parse(r.stdout);
  assert.equal(answer.error?.code, "E_LIFECYCLE_FAILED", r.stdout);
  assert.ok(answer.error.message.startsWith("ENOSPC:"), answer.error.message);
  assert.equal(answer.error.details.reached.home, "kept");
  assert.equal(readFileSync(record, "utf8"), before);
  assert.deepEqual(privateFiles(home), []);
});

test("a mode that cannot be read refuses the write: the record keeps its bytes and its mode, and no default takes its place", (t) => {
  const f = fixture(t);
  const home = f.spawn("w1", "--no-launch");
  const record = join(home, "instance.json");
  chmodSync(record, 0o600);
  const before = readFileSync(record, "utf8");
  const call = `import { writeHomeRecord } from ${JSON.stringify(new URL("../lib/core.mjs", import.meta.url).href)};
try { writeHomeRecord(${JSON.stringify(home)}, { rewritten: true }); console.log(JSON.stringify({ threw: null })); }
catch (e) { console.log(JSON.stringify({ threw: { code: e.code, syscall: e.syscall } })); }`;
  const r = runFaulted(["--input-type=module", "-e", call], { cwd: f.fx.dep, env: f.fx.env, gateDir: join(f.fx.base, "gates"), gates: [{ name: "fault", fn: "statSync", path: record, throws: "EIO" }] });
  assert.deepEqual(r.fired, ["fault"], `fixture premise: the fault was met: ${r.stdout}${r.stderr}`);
  assert.deepEqual(r.json().threw, { code: "EIO", syscall: "stat" });
  assert.equal(readFileSync(record, "utf8"), before);
  assert.equal(modeOf(record), "600");
  assert.deepEqual(privateFiles(home), []);
});

for (const [made, umask, kept] of [[0o600, "022", "600"], [0o664, "022", "664"], [0o644, "077", "644"], [0o644, "002", "644"]]) {
  test(`the repair keeps the record's own mode: ${made.toString(8)} stays ${kept} under a retire's umask of ${umask}`, (t) => {
    const f = fixture(t);
    const home = f.family("--no-launch");
    const record = join(home, "instance.json");
    chmodSync(record, made);
    const answer = f.under(umask, ["retire", "pa", "--json"]);
    assert.equal(answer.retired, "pa", JSON.stringify(answer));
    assert.equal(readJson(record).parentInstance, undefined);
    assert.equal(modeOf(record), kept);
  });
}

test("a start and a restart keep the record's mode under a umask of 002, where a new file would be 0664", TMUX, async (t) => {
  const f = fixture(t);
  const home = f.spawn("w1", "--launch-config", "stand-in");
  const record = join(home, "instance.json");
  await waitUntil(() => f.row("w1")?.running === true, "the session to run", 30000);
  const restarted = f.under("002", ["session", "restart", "--home", home, "--stop-grace", "10", "--json"]);
  assert.equal(restarted.ok, true, JSON.stringify(restarted));
  assert.equal(modeOf(record), "644");
  await waitUntil(() => f.row("w1")?.running === true, "the session to run again", 30000);
  const plan = f.cli(["instance", "stop", "w1", "--plan", "--json"]);
  const stopped = f.cli(["instance", "stop", "w1", "--apply", "--plan-revision", (plan.result ?? plan).planRevision, "--idempotency-key", "stop-w1", "--json"]);
  assert.equal(stopped.ok ?? true, true, JSON.stringify(stopped));
  await waitUntil(() => f.row("w1")?.running === false, "the session to stop", 30000);
  const started = f.under("002", ["session", "start", "--home", home, "--json"]);
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(modeOf(record), "644");
});

test("a spawn that re-points its anchor (--relation parent) keeps the anchor's record's mode under a umask of 002", (t) => {
  const f = fixture(t);
  const anchor = f.spawn("an", "--no-launch");
  const record = join(anchor, "instance.json");
  assert.equal(modeOf(record), "644", "fixture premise");
  const made = f.under("002", ["spawn", "dev", "--name", "up", "--relation", "parent", "--relative-to", "an", "--no-launch", "--json"]);
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal(readJson(record).parentInstance, "up");
  assert.equal(modeOf(record), "644");
});

test("the kernel writes a home's record through one writer: no path to the record reaches writeJsonAtomic", () => {
  for (const file of [...readdirSync("lib").filter((name) => name.endsWith(".mjs")).map((name) => join("lib", name)), join("bin", "oats.mjs")]) {
    const found = readFileSync(file, "utf8").split("\n").map((line, i) => [line, i + 1]).filter(([line]) => /writeJsonAtomic\(\s*(?:join\([^)]*"instance\.json"|metaPath|anchorMetaPath|recordPath|metaFile)/.test(line));
    assert.deepEqual(found.map(([line, at]) => `${file}:${at}: ${line.trim()}`), [], "the record goes through writeHomeRecord (lib/core.mjs)");
  }
});
