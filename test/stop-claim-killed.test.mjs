// A stop that was killed does not block the next one (awebai/oats#890; feature `lifecycle-claim-stop`).
//
// Before 5642fd2f a stop apply said "a stop is in progress" with a file in the home,
// `.oats-stop-pending.json`, which named no process, and removed it in a `finally`. A stop that was
// killed (a client that ends its call, a caller's timeout, a closed terminal) never reached that
// `finally`: the file stayed, the next plan said `stopPending: true`, and every later apply of that
// home answered E_LIFECYCLE_BUSY, "<name> already has a stop in progress", until somebody removed
// the file by hand.
//
// A stop now holds the home's lifecycle claim (<instances>/.oats-retirement/claims/<instance>.lock,
// lib/core.mjs claimHomeFor), whose record names its holder by pid and start time, with its verb
// (`action: "stop"`). A claim whose holder died, by any signal, reaped or still a zombie, is taken
// over by the next command that wants it (lib/claim.mjs); a plan reads it as no stop in progress.
//
// Two places a stop is killed at, each for SIGKILL, SIGTERM, SIGINT and SIGHUP, and neither found
// by timing:
//   - with its claims taken and before it stopped anything: the real CLI, as a child, is held at
//     one `node:fs` call of the kernel's own (test/helpers/fs-gate-preload.mjs; beforeFirstStop);
//   - while it waits for the harness it has signalled: the stand-in harness says when SIGTERM
//     reached it, and stays until the test lets it go.
// The other tests of the stop's claim are in test/stop-claim.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn as spawnChild, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import YAML from "yaml";
import { CLI, v2Deployment, writeFixtureExecutable } from "./helpers/v2-deployment.mjs";
import { hostProcessState, waitUntil, zombieSync } from "./helpers/host-fixture.mjs";
import { startGated } from "./helpers/fs-gate-preload.mjs";

const hasTmux = !spawnSync("tmux", ["-V"], { stdio: "ignore" }).error;
const TMUX = { skip: !hasTmux && "tmux is not installed" };
const SIGNALS = ["SIGKILL", "SIGTERM", "SIGINT", "SIGHUP"];
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
/** What a stop writes into a home, by name: the marker of a kernel before `lifecycle-claim-stop`,
 *  its record (`.oats-stop.json`), its receipts, and the private file of an atomic write. */
const stopFiles = (home) => readdirSync(home).filter((name) => name.startsWith(".oats-stop") || name.endsWith(".tmp")).sort();
const claimsDir = (home) => join(dirname(home), ".oats-retirement", "claims");
/** Every file in the claims directory of the home's agent: the claims, and anything a takeover left. */
const claimFiles = (home) => (existsSync(claimsDir(home)) ? readdirSync(claimsDir(home)).sort() : []);
const flags = (plan) => plan.targets.map((target) => ({ instance: target.instance, retiring: target.retiring, stopPending: target.stopPending }));
const idle = (i) => ({ instance: i.name, retiring: false, stopPending: false });
/** What a receipt's row says of `i`, without the session's state word. */
const row = (r) => ({ instance: r.instance, home: r.home, ok: r.ok, stopped: r.stopped, alreadyIdle: r.alreadyIdle });

/** Held AFTER every claim is taken, after the plan was read again and compared, and BEFORE the first
 *  target is stopped: the apply's removal of a marker an older kernel may have left in `home`
 *  (lib/instance-lifecycle.mjs applyStop: `rmSync(left, { force: true })`). The stop makes that call
 *  once per target, with that path and no other `rmSync` of it, as its last step before
 *  `stopInstanceSession`: a child held there holds its claims and has had no effect. */
const beforeFirstStop = (home) => ({ name: "held", fn: "rmSync", path: join(home, ".oats-stop-pending.json") });

/** The `result` of a CLI run that answered: one envelope, exit 0, `ok: true`. */
function result(r, what) {
  const lines = r.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `${what}: exactly one JSON answer on stdout\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  const doc = JSON.parse(lines[0]);
  assert.deepEqual([r.status, doc.schemaVersion, doc.ok], [0, 1, true], `${what}: ${r.stdout}${r.stderr}`);
  return doc.result;
}
/** The claim of `i` as it is held now: the file is there, and names `pid` as a stop → its bytes. */
function stopClaim(i, pid, what) {
  assert.equal(existsSync(i.lock), true, `${what}: the claim ${i.lock} is taken`);
  const text = readFileSync(i.lock, "utf8"), record = JSON.parse(text);
  assert.deepEqual([record.action, record.pid], ["stop", pid], what);
  return text;
}

/** A deployment whose soul `worker` works in a directory. `add(name, { lingers, parent })` spawns and
 *  launches an instance of it through the kernel's own spawn: a stand-in harness runs for it in a
 *  window of the fixture's own tmux server (its private TMUX_TMPDIR, which the fixture's cleanup
 *  kills by socket). The stand-in is the fixture's own file, named by its absolute path in a launch
 *  configuration. It says which process it is (`<name>.pid`) and idles; on SIGTERM it says that it
 *  was asked (`<name>.asked`) and exits once `<name>.go` exists: at once, unless it `lingers`, in
 *  which case the test writes that file when the harness is to go. */
function deployment(t) {
  const fx = v2Deployment({ t, souls: { worker: { soul: { work: "directory" } } } });
  const said = join(fx.base, "harness"), executable = join(fx.base, "harness-stand-in"), localFile = join(fx.dep, "oats-local.yaml");
  mkdirSync(said);
  writeFixtureExecutable(fx.base, executable, `#!${process.execPath}
const fs = require("node:fs");
const at = (kind) => ${JSON.stringify(said)} + "/" + process.env.OATS_INSTANCE + "." + kind;
process.on("SIGTERM", () => { fs.writeFileSync(at("asked"), ""); setInterval(() => { if (fs.existsSync(at("go"))) process.exit(0); }, 10); });
fs.writeFileSync(at("pid"), String(process.pid)); // last: the handler is installed
setInterval(() => {}, 1000);
`);
  writeFileSync(localFile, YAML.stringify({ ...YAML.parse(readFileSync(localFile, "utf8")), "launch-configs": { "stand-in": { harness: "pi", executable } } }, { lineWidth: 0 }));
  const applyArgs = (name, revision, key) => [CLI, "instance", "stop", name, "--apply", "--plan-revision", revision, "--idempotency-key", key, "--json"];
  const d = {
    fx,
    async add(name, { lingers = false, parent } = {}) {
      const i = { name, asked: join(said, `${name}.asked`), go: join(said, `${name}.go`) };
      if (!lingers) writeFileSync(i.go, "");
      // An in-process spawn finds its harness on this process's PATH: the fixture's inert ones.
      const hostPath = process.env.PATH;
      process.env.PATH = fx.env.PATH;
      try { i.home = (await fx.spawn("worker", { name, launch: true, launchConfig: "stand-in", ...(parent ? { relativeTo: parent.name, relation: "child" } : {}) })).home; } finally { process.env.PATH = hostPath; }
      assert.equal(i.home, join(fx.root, "worker", "instances", name), "fixture premise: where the home is");
      i.lock = join(claimsDir(i.home), `${basename(i.home)}.lock`);
      i.receipt = (key) => join(i.home, `.oats-stop-receipt.${key}.json`);
      const read = () => { try { const text = readFileSync(join(said, `${name}.pid`), "utf8"); return /^\d+$/.test(text) && Number(text) > 1 ? Number(text) : null; } catch { return null; } };
      await waitUntil(() => read() !== null && alive(read()), `the stand-in harness of ${name} to run`);
      i.pid = read();
      return i;
    },
    plan: (name, what = `the stop plan of ${name}`) => result(fx.cli(["instance", "stop", name, "--plan", "--json"]), what),
    /** The stop plan of `name`, read once every target's pane reads as `state` says (the session's state is part of the plan's revision). */
    async planOnce(name, state, what) {
      let plan;
      await waitUntil(() => { plan = d.plan(name); return plan.targets.every((target) => state(target.session)); }, what);
      return plan;
    },
    runningPlan: (name) => d.planOnce(name, (session) => session.present === true && session.state !== "shell", `every session under ${name} to read as running`),
    apply: (name, revision, key) => fx.cli(applyArgs(name, revision, key).slice(1)),
    /** A stop apply as a child held at `gate`, in a gate directory of its own, outside the deployment. */
    heldApply: (name, revision, key, gate) => startGated(applyArgs(name, revision, key), { cwd: fx.dep, env: fx.env, gateDir: join(fx.base, "gates", name), gates: [gate] }),
    /** A stop apply as a child that nothing holds → { child, done: Promise<{ code, signal, stdout, stderr }>, finish() }. */
    startApply(name, revision, key) {
      const child = spawnChild(process.execPath, applyArgs(name, revision, key), { cwd: fx.dep, env: fx.env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      const done = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
      // For a `finally`: a failed assertion leaves no kernel process behind.
      return { child, done, finish: () => { child.kill("SIGKILL"); return done; } };
    },
  };
  return d;
}

/** What a stop that was ended by `signal` left, and what the next plan says of it: its claim, as it
 *  was, and nothing in the home; no stop in progress, and the plan as it was shown. */
function assertLeftByTheKilledStop(d, i, { claim, shown }, what) {
  assert.equal(existsSync(i.lock) && readFileSync(i.lock, "utf8"), claim, `${what}: the killed apply left its claim: action "stop", naming the dead pid`);
  assert.deepEqual([alive(i.pid), stopFiles(i.home)], [true, []], `${what}: the harness still runs, and the stop wrote nothing into the home`);
  const next = d.plan(i.name, `${what}: the plan after the kill`);
  assert.deepEqual(flags(next), [idle(i)], `${what}: the holder is gone, so no stop is in progress`);
  assert.equal(next.planRevision, shown.planRevision, `${what}: the plan reads as it was shown`);
  return next;
}

test("a stop apply killed with its claims taken and before it stopped anything (SIGKILL, SIGTERM, SIGINT, SIGHUP; reaped, or left a zombie) leaves a claim that names a dead process: the next plan shows no stop in progress, and the next apply takes the claim over and stops the instance (awebai/oats#890)", TMUX, async (t) => {
  // Before: the apply left `<home>/.oats-stop-pending.json`; the next plan said `stopPending: true`,
  // and every later apply answered E_LIFECYCLE_BUSY, "<name> already has a stop in progress".
  const d = deployment(t);
  // The last row: the killed apply is a child of this process, which reaps its children from its
  // event loop. Nothing is awaited between the kill and the next apply's answer, so what the plan
  // and the apply meet is a zombie (awebai/oats#870).
  for (const { signal, zombie } of [...SIGNALS.map((signal) => ({ signal })), { signal: "SIGKILL", zombie: true }]) {
    await t.test(zombie ? `${signal}, and nobody has reaped it` : signal, async (st) => {
      const i = await d.add(`k-${signal.slice(3).toLowerCase()}${zombie ? "-z" : ""}`);
      const shown = await d.runningPlan(i.name);
      const run = d.heldApply(i.name, shown.planRevision, "k1", beforeFirstStop(i.home));
      try {
        await run.waitGate("held");
        const claim = stopClaim(i, run.child.pid, "the apply is held with the home's claim taken, as a stop");
        assert.deepEqual([alive(i.pid), existsSync(i.asked)], [true, false], "and before it stopped anything: the harness runs, and was not signalled");
        // A pid this test started.
        if (zombie) st.diagnostic(`the killed apply (pid ${run.child.pid}) is a zombie: the host reports its state as ${JSON.stringify(zombieSync(run.child.pid))}`);
        else { run.child.kill(signal); await run.done; }

        const next = assertLeftByTheKilledStop(d, i, { claim, shown }, signal);
        const receipt = result(d.apply(i.name, next.planRevision, "k2"), "the next apply");
        if (zombie) assert.match(String(hostProcessState(run.child.pid)), /^Z/, "the killed apply was still a zombie when the next one answered: a zombie is what it met");
        assert.deepEqual([receipt.ok, receipt.replayed, receipt.idempotencyKey, receipt.results.map(row)], [true, false, "k2", [{ instance: i.name, home: i.home, ok: true, stopped: true, alreadyIdle: false }]], "it took the claim over and stopped the instance");
        assert.deepEqual([alive(i.pid), existsSync(i.asked)], [false, true], "the harness was signalled, and is gone");
        assert.deepEqual(claimFiles(i.home), [], "no claim is left, and no file of the takeover");
        assert.deepEqual([existsSync(i.receipt("k1")), existsSync(i.receipt("k2"))], [false, true], "the killed apply recorded no receipt; the one that stopped did");
        const killed = await run.done; // reaped here, at the latest
        assert.deepEqual([killed.code, killed.signal, killed.stdout], [null, signal, ""], `the first apply was ended by ${signal} and answered nothing: ${killed.stderr}`);
      } finally { await run.finish(); }
    });
  }
});

test("a stop apply killed while it waits for the harness it has signalled (SIGKILL, SIGTERM, SIGINT, SIGHUP) leaves its claim and no record: once the harness has ended by itself, the next apply takes the claim over and answers that the instance is already idle (awebai/oats#890)", TMUX, async (t) => {
  // Before: the same marker was left. With the harness gone the instance was idle, and still no stop
  // of it could be applied: E_LIFECYCLE_BUSY, "<name> already has a stop in progress".
  const d = deployment(t);
  for (const signal of SIGNALS) {
    await t.test(signal, async () => {
      const i = await d.add(`w-${signal.slice(3).toLowerCase()}`, { lingers: true });
      const shown = await d.runningPlan(i.name);
      const stop = d.startApply(i.name, shown.planRevision, "k1");
      try {
        // The harness says that SIGTERM reached it, and stays: the stop is inside its bounded wait.
        await waitUntil(() => existsSync(i.asked), "the stop to have signalled the harness");
        const claim = stopClaim(i, stop.child.pid, "the stop holds the home's claim while it waits");
        assert.equal(stop.child.exitCode, null, "the stop is waiting, not finished");
        stop.child.kill(signal); // a pid this test started
        const killed = await stop.done;
        assert.deepEqual([killed.code, killed.signal, killed.stdout], [null, signal, ""], `the apply was ended by ${signal} and answered nothing: ${killed.stderr}`);

        // It was killed before it could write its record (`.oats-stop.json`) or its receipt.
        assertLeftByTheKilledStop(d, i, { claim, shown }, signal);
        // The harness ends by itself, as the stop had asked it to.
        writeFileSync(i.go, "");
        await waitUntil(() => !alive(i.pid), "the harness to end");
        const now = await d.planOnce(i.name, (session) => session.state === "shell", "the pane to read as idle");
        assert.deepEqual(flags(now), [idle(i)], "an idle instance, and no stop in progress");
        const receipt = result(d.apply(i.name, now.planRevision, "k2"), "the next apply");
        assert.deepEqual([receipt.ok, receipt.replayed, receipt.results.map(row)], [true, false, [{ instance: i.name, home: i.home, ok: true, stopped: false, alreadyIdle: true }]], "it took the claim over; there was nothing left to stop");
        assert.deepEqual([claimFiles(i.home), existsSync(i.receipt("k1")), existsSync(i.receipt("k2"))], [[], false, true], "no claim is left, and the receipt is the second apply's");
      } finally { await stop.finish(); }
    });
  }
});

test("a recursive stop killed with the claim of the parent and of each child taken leaves them all: the next recursive stop takes every one over and stops all three (awebai/oats#890)", TMUX, async (t) => {
  // Before: the marker was left in each of the three homes, and none of them could be stopped again,
  // alone or with its parent: "c1, c2, p already have a stop in progress".
  const d = deployment(t);
  const p = await d.add("p");
  const all = [await d.add("c1", { parent: p }), await d.add("c2", { parent: p }), p];
  const shown = await d.runningPlan(p.name);
  assert.deepEqual(shown.targets.map((target) => target.instance), ["c1", "c2", "p"], "fixture premise: the plan's targets, deepest first");
  const run = d.heldApply(p.name, shown.planRevision, "k1", beforeFirstStop(shown.targets[0].home));
  try {
    await run.waitGate("held");
    const claims = all.map((i) => stopClaim(i, run.child.pid, `the apply is held with the claim of ${i.name} taken`));
    run.child.kill("SIGTERM"); // a pid this test started
    assert.equal((await run.done).signal, "SIGTERM");
    assert.deepEqual([claimFiles(p.home), all.map((i) => readFileSync(i.lock, "utf8")), all.map((i) => alive(i.pid))], [["c1.lock", "c2.lock", "p.lock"], claims, [true, true, true]], "the three claims are left as they were, and nothing was stopped");
    const next = d.plan(p.name, "the plan after the kill");
    assert.deepEqual([flags(next), next.planRevision], [all.map(idle), shown.planRevision], "no stop is in progress, of any target");
    const receipt = result(d.apply(p.name, next.planRevision, "k2"), "the next apply");
    assert.deepEqual([receipt.ok, receipt.results.map(row)], [true, all.map((i) => ({ instance: i.name, home: i.home, ok: true, stopped: true, alreadyIdle: false }))], "it took the three claims over and stopped all three");
    assert.deepEqual([all.map((i) => alive(i.pid)), claimFiles(p.home)], [[false, false, false], []], "the harnesses are gone, and no claim or file of a takeover is left");
  } finally { await run.finish(); }
});
