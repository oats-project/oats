// A stop whose claim cannot be written reads it instead (awebai/oats#946).
//
// `oats instance stop --apply` holds the home's claim (test/stop-claim.test.mjs), so it has to
// WRITE it: from 0.52.0 a stop whose claim could not be written was refused before it signalled
// anything. A full disk is the likely case, and one of the reasons a person presses Stop. Now a
// stop apply, and it alone, reads the claim where it cannot write it for a reason that stops every
// other writer of this user as well (lib/claim.mjs CLAIM_UNWRITABLE_CODES), and goes on when
// nobody holds it, holding nothing for that target and saying so on stderr.
//
// What the tests below hold, through the real CLI:
//   - with nobody holding the claim the session is stopped, the answer is the receipt of any stop,
//     and stderr has one warning per target that was only read, in text and in JSON mode;
//   - beside a holder, and beside a file that is no claim, the answer is the one the same apply
//     gets when it CAN write: the two are compared whole, so no sentence is repeated here;
//   - a holder that is verifiably gone is nobody, and its file is left as it was;
//   - the read is positive or it is nothing: when the claim cannot be read either, the answer is
//     the refusal of the write;
//   - the last look: the read is made again once the plan has been read under the claims, so a
//     holder that came in between is answered, before a stale plan and before any signal;
//   - of several targets it holds what it could write and reads the others;
//   - a retire, and a retire's stop of a recorded child, answer as they did;
//   - a file system that is full for every write of the stop: what the apply answers, and what
//     the same key answers afterwards.
// The claim's own units (each code at each write, what is read at the path) are in
// test/claim.test.mjs.
//
// Two ways to make a write fail, and each test says which:
//   - a file shape that fails the same way each time, with no injection: a directory this user
//     may not write (mode bits, EACCES). Skipped for root, whom a mode does not keep out;
//   - a fault at one named `node:fs` call of the kernel's own, in the one CLI child the test
//     starts (test/helpers/fs-gate-preload.mjs, `throws`): ENOSPC, which no file shape gives on
//     every host. Nothing is filled. The run on a file system that really was full is not a test
//     of this suite; it is named on the pull request.
// No outcome rests on a sleep: where a second writer must come at an exact moment, the stop is
// held at a call of its own (the same preload) until the test has written.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn as spawnChild, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import YAML from "yaml";
import { CLAIM_UNWRITABLE_CODES } from "../lib/claim.mjs";
import { retireClaimPath } from "../lib/core.mjs";
import { readStartExited } from "../lib/session-end.mjs";
import { processStartToken } from "../lib/worktree-hooks.mjs";
import { CLI, v2Deployment, writeFixtureExecutable } from "./helpers/v2-deployment.mjs";
import { waitUntil } from "./helpers/host-fixture.mjs";
import { runFaulted, startGated } from "./helpers/fs-gate-preload.mjs";

const hasTmux = !spawnSync("tmux", ["-V"], { stdio: "ignore" }).error;
/** Every test here stops a live session: a stand-in harness in a window of the fixture's own tmux server. */
const TMUX = { skip: !hasTmux && "tmux is not installed" };
/** A mode no longer keeps root out: the shapes that rest on one are skipped for root. */
const ROOT = process.getuid?.() === 0;
const SKIP_FOR_ROOT = "root writes whatever the mode says: this shape cannot fail";
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
/** A real pid whose process has exited and been reaped. */
const exitedPid = () => spawnSync(process.execPath, ["-e", ""]).pid;
/** A plan revision no plan has. */
const STALE = "0".repeat(24);
const NONCE = "c".repeat(32);
const AT = "2026-10-10T00:00:00.000Z";

// ---- what a test reads of the deployment --------------------------------------------------------

/** A tree as `{ <relative path>: what it is }`: mode and bytes (as a digest) of a file, target of a
 *  link, mode of a directory. Two snapshots that are deep-equal are the same tree. */
function snapshot(root) {
  const seen = {};
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), at = rel ? `${rel}/${name}` : name;
      const st = lstatSync(path), mode = (st.mode & 0o7777).toString(8);
      if (st.isSymbolicLink()) seen[at] = `link ${readlinkSync(path)}`;
      else if (st.isDirectory()) { seen[`${at}/`] = `directory ${mode}`; if (st.mode & 0o400) walk(path, at); }
      else seen[at] = `file ${mode} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
    }
  };
  walk(root, "");
  return seen;
}
/** What differs between two snapshots: `+` made, `-` removed, `~` changed. */
function changes(before, after) {
  const out = [];
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!(path in before)) out.push(`+ ${path}`);
    else if (!(path in after)) out.push(`- ${path}`);
    else if (before[path] !== after[path]) out.push(`~ ${path}`);
  }
  return out.sort();
}
/** What a stop writes into a home, by name: its record, its receipts, and the private file of an
 *  atomic write that did not end. */
const stopFiles = (home) => readdirSync(home).filter((name) => name.startsWith(".oats-stop") || name.endsWith(".tmp")).sort();
/** The claim's path, built here from the contract and not with the kernel's own function. */
const claimsDir = (home) => join(dirname(home), ".oats-retirement", "claims");
const claimOf = (home) => join(claimsDir(home), `${basename(home)}.lock`);
/** Every file in the claims directory of the home's agent, or null when there is no such directory. */
const claimFiles = (home) => (existsSync(claimsDir(home)) ? readdirSync(claimsDir(home)).sort() : null);
/** The warning a stop prints, once, for a target whose claim it only read: the system's code,
 *  never its message, and the claim's own path. */
const warning = (i, code) => `oats: warning: ${i.name}: stopping without its claim: ${i.lock} could not be written (${code}), and nobody holds it. A retire or a stop of ${i.name} that starts while this one runs will not see it.\n`;

// ---- the answers --------------------------------------------------------------------------------

/** The one JSON answer of a CLI run (`fx.cli`'s, a faulted child's or a gated child's). */
function oneAnswer(r, what) {
  const lines = r.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `${what}: exactly one JSON answer on stdout\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  return { exit: "status" in r ? r.status : r.code, doc: JSON.parse(lines[0]) };
}
/** The receipt of a stop apply that answered: exit 0, `ok: true`. */
function receiptOf(r, what) {
  const { exit, doc } = oneAnswer(r, what);
  assert.deepEqual([exit, doc.schemaVersion, doc.ok], [0, 1, true], `${what}: ${r.stdout}${r.stderr}`);
  return doc.result;
}
/** The `error` of a command that refused: exit 1, one envelope, nothing on stderr (so no warning). */
function refusal(r, what) {
  const { exit, doc } = oneAnswer(r, what);
  assert.deepEqual([exit, doc.schemaVersion, doc.ok], [1, 1, false], `${what}: ${r.stdout}${r.stderr}`);
  assert.equal(r.stderr, "", `${what}: a refusal prints nothing on stderr`);
  return doc.error;
}
/** A refusal without the instant its plan was read at: two applies read the plan at two instants,
 *  and everything else of two answers to one state of the home is equal. */
const timeless = (error) => ({ ...error, details: { ...error.details, plan: { ...error.details.plan, at: typeof error.details.plan.at } } });
/** A gated child's result once it has exited; no gate of it went on by itself. */
async function ended(run) {
  const r = await run.done;
  assert.deepEqual(r.timedOut, [], "every gate was released by the test: the kernel did not go on by itself");
  return r;
}
const stoppedRow = (i) => ({ instance: i.name, home: i.home, ok: true, stopped: true, alreadyIdle: false });
const row = (r) => ({ instance: r.instance, home: r.home, ok: r.ok, stopped: r.stopped, alreadyIdle: r.alreadyIdle });

// ---- the fixture --------------------------------------------------------------------------------

/** A retire hook that records each run in `<agents root>/retire-hook-ran-<instance>`, outside every home. */
const HOOK = `import { appendFileSync } from "node:fs";
import { join } from "node:path";
appendFileSync(join(process.env.OATS_ROOT, "retire-hook-ran-" + process.env.OATS_INSTANCE), "ran\\n");
console.log(JSON.stringify({ meta: { retired: true } }));
`;

/** A deployment whose soul `worker` works in a directory (the fixture of test/stop-claim.test.mjs).
 *  `add(name, { parent })` spawns an instance through the kernel's own spawn, launched: a stand-in
 *  harness runs for it in a window of the fixture's own tmux server, which the fixture's cleanup
 *  kills by socket. It says which process it is, then idles, and ends on SIGTERM. Modes a test
 *  takes away are given back before the fixture removes its base. */
function deployment(t) {
  const fx = v2Deployment({ t,
    souls: { worker: { soul: { work: "directory", capabilities: { "test.stop-unwritable": { from: "here" } } } } },
    capabilities: { "test.stop-unwritable": { manifest: { hooks: { retire: "hook.mjs" } }, files: { "hook.mjs": HOOK } } },
  });
  const pids = join(fx.base, "harness-pids"), executable = join(fx.base, "harness-stand-in"), localFile = join(fx.dep, "oats-local.yaml");
  mkdirSync(pids);
  writeFixtureExecutable(fx.base, executable, `#!/bin/sh\necho $$ > '${pids}'/"$OATS_INSTANCE"\nexec sleep 600\n`);
  writeFileSync(localFile, YAML.stringify({ ...YAML.parse(readFileSync(localFile, "utf8")), "launch-configs": { "stand-in": { harness: "pi", executable } } }, { lineWidth: 0 }));
  const taken = [];
  /** Give back every mode a test took away, the last one first. */
  const giveBack = () => { for (const [path, mode] of taken.splice(0).reverse()) { try { chmodSync(path, mode); } catch { /* removed since */ } } };
  fx.beforeCleanup(giveBack);
  let children = 0;
  const d = {
    fx,
    /** Set the mode of `path`; the mode it had is given back by `giveBack()`, and at cleanup
     *  whatever the test did: the fixture cannot remove what it may not write. */
    chmod(path, mode) { taken.push([path, lstatSync(path).mode & 0o7777]); chmodSync(path, mode); },
    giveBack,
    async add(name, { parent } = {}) {
      // An in-process spawn finds its harness on this process's PATH: the fixture's inert ones.
      const hostPath = process.env.PATH;
      process.env.PATH = fx.env.PATH;
      let home;
      try { ({ home } = await fx.spawn("worker", { name, launch: true, launchConfig: "stand-in", ...(parent ? { relativeTo: parent.name, relation: "child" } : {}) })); } finally { process.env.PATH = hostPath; }
      assert.equal(home, join(fx.root, "worker", "instances", name), "fixture premise: where the home is");
      const i = { name, home, lock: claimOf(home), receipt: (key) => join(home, `.oats-stop-receipt.${key}.json`),
        hookRuns: () => { try { return readFileSync(join(fx.root, `retire-hook-ran-${name}`), "utf8").split("\n").filter(Boolean).length; } catch (e) { if (e.code === "ENOENT") return 0; throw e; } } };
      assert.equal(i.lock, retireClaimPath(home), "the claim's path is contract: <instances>/.oats-retirement/claims/<instance>.lock");
      const read = () => { try { const text = readFileSync(join(pids, name), "utf8").trim(); return /^\d+$/.test(text) && Number(text) > 1 ? Number(text) : null; } catch { return null; } };
      await waitUntil(() => read() !== null && alive(read()), `the stand-in harness of ${name} to run`);
      i.pid = read();
      return i;
    },
    plan(name, what = `the stop plan of ${name}`) {
      const r = fx.cli(["instance", "stop", name, "--plan", "--json"]);
      const { exit, doc } = oneAnswer(r, what);
      assert.deepEqual([exit, doc.ok], [0, true], `${what}: ${r.stdout}${r.stderr}`);
      return doc.result;
    },
    /** The stop plan of `name`, read once every target's pane reads as a running harness (the
     *  session's state is part of the plan's revision). */
    async runningPlan(name) {
      let plan;
      await waitUntil(() => { plan = d.plan(name); return plan.targets.every((target) => target.session.present === true && target.session.state !== "shell"); }, `every session under ${name} to read as running`);
      return plan;
    },
    applyArgs: (name, revision, key, extra = []) => ["instance", "stop", name, "--apply", "--plan-revision", revision, "--idempotency-key", key, "--json", ...extra],
    apply: (name, revision, key) => fx.cli(d.applyArgs(name, revision, key)),
    /** A directory of one child's gates, outside the deployment. */
    gateDir: () => join(fx.base, "gates", String(++children)),
    /** `oats <args>` run to its end with `faults`, gates that throw: → what runFaulted gives. */
    faulted: (args, faults) => runFaulted([CLI, ...args], { cwd: fx.dep, env: fx.env, gateDir: d.gateDir(), gates: faults }),
    /** `oats <args>` as a child with `gates`, some of which hold it: → what startGated gives. */
    gated: (args, gates) => startGated([CLI, ...args], { cwd: fx.dep, env: fx.env, gateDir: d.gateDir(), gates }),
  };
  return d;
}

/** The fault "no space for the claim of `i`": every write of its private file fails with `code`,
 *  as on a file system that has an entry for the file and no block for its bytes. It is the first
 *  write of the claim wherever its directory is there already. */
const noSpaceForClaim = (i, code = "ENOSPC") => ({ name: `claim-${i.name}`, fn: "writeFileSync", prefix: `${i.lock}.tmp-`, throws: code, every: true });
/** A claim as the protocol writes it, at the claim path of `i`. */
function writeClaim(i, record) {
  mkdirSync(dirname(i.lock), { recursive: true, mode: 0o700 });
  const bytes = JSON.stringify({ nonce: NONCE, at: AT, ...record }) + "\n";
  writeFileSync(i.lock, bytes);
  return bytes;
}
/** A process of this test's own that lives until the test ends it, to be named in a claim. */
function bystander(t) {
  const child = spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { cwd: "/", stdio: "ignore" });
  t.after(() => { child.kill("SIGKILL"); }); // a pid this test started
  const start = processStartToken(child.pid);
  assert.ok(start, "fixture premise: the start of the process a claim will name can be read");
  return { pid: child.pid, start };
}

// ---- 1. nobody holds the claim: the stop goes on, and says so -----------------------------------

const UNWRITABLE_SHAPES = [
  { what: "its claims directory is read-only", make: (d, i) => { mkdirSync(claimsDir(i.home), { recursive: true, mode: 0o700 }); d.chmod(claimsDir(i.home), 0o500); }, claims: [] },
  { what: "its claims directory is not there and cannot be made, the directory above it being read-only", make: (d, i) => { assert.equal(existsSync(claimsDir(i.home)), false, "fixture premise: no claim was ever taken here"); d.chmod(dirname(claimsDir(i.home)), 0o500); }, claims: null },
];
for (const shape of UNWRITABLE_SHAPES) {
  test(`instance stop --apply when ${shape.what} (EACCES, no injection): the session is stopped, the receipt is that of any stop, and stderr says once, in JSON and in text mode, that it stopped without its claim; the same key replays the receipt, with no warning`, TMUX, async (t) => {
    // Before (0.52.0): E_LIFECYCLE_FAILED naming the claim, and nothing was signalled.
    if (ROOT) { t.skip(SKIP_FOR_ROOT); return; }
    const d = deployment(t);
    const a = await d.add("a1"), b = await d.add("b1"), c = await d.add("c1");
    const plans = { a: await d.runningPlan(a.name), b: await d.runningPlan(b.name) };
    shape.make(d, a);

    // JSON mode.
    const r = d.apply(a.name, plans.a.planRevision, "k1");
    const receipt = receiptOf(r, "the stop of a1");
    assert.equal(r.stderr, warning(a, "EACCES"), "stderr is the one warning, and nothing else");
    assert.deepEqual([receipt.ok, receipt.replayed, receipt.results.map(row)], [true, false, [stoppedRow(a)]]);
    await waitUntil(() => !alive(a.pid), "the harness of a1 to be gone: the stop stopped it");
    assert.deepEqual(claimFiles(a.home), shape.claims, "nothing was written where the claims are");
    assert.deepEqual({ ...readJson(a.receipt("k1")), replayed: false }, { ...receipt, lifecycleKernelCodes: true }, "the receipt is stored under its key, as any stop's");
    // The same key: the stored receipt, read before any claim is asked for.
    const again = d.apply(a.name, plans.a.planRevision, "k1");
    assert.deepEqual(receiptOf(again, "the same key again"), { ...receipt, replayed: true });
    assert.equal(again.stderr, "", "a replay takes no claim, so it has nothing to warn of");

    // Text mode: the same line on stderr, and the words of any stop on stdout.
    const text = d.fx.cli(["instance", "stop", b.name, "--apply", "--plan-revision", plans.b.planRevision, "--idempotency-key", "k1"]);
    assert.equal(text.status, 0, text.stdout + text.stderr);
    assert.equal(text.stderr, warning(b, "EACCES"));
    assert.match(text.stdout, /^ {2}b1: stopped\nstopped; home, work, transcript and launch configuration retained/);
    await waitUntil(() => !alive(b.pid), "the harness of b1 to be gone");

    // The way out, and the receipt's shape: once the claim can be written a stop takes it, warns
    // of nothing, and its receipt has the keys the two above have.
    d.giveBack();
    const plain = d.apply(c.name, (await d.runningPlan(c.name)).planRevision, "k1");
    const held = receiptOf(plain, "a stop that can write its claim");
    assert.equal(plain.stderr, "");
    assert.deepEqual([Object.keys(receipt).sort(), Object.keys(receipt.results[0]).sort()], [Object.keys(held).sort(), Object.keys(held.results[0]).sort()], "no key of the receipt, and none of its row, is new");
    assert.deepEqual(claimFiles(c.home), [], "it took its claim, and released it");
  });
}

test("instance stop --apply when its claim can be neither written nor read (the claims directory may not be entered; no injection): the refusal of the write, E_LIFECYCLE_FAILED with the system's error as its cause, and nothing was signalled", TMUX, async (t) => {
  if (ROOT) { t.skip(SKIP_FOR_ROOT); return; }
  const d = deployment(t);
  const i = await d.add("n1");
  const plan = await d.runningPlan(i.name);
  mkdirSync(claimsDir(i.home), { recursive: true, mode: 0o700 });
  d.chmod(claimsDir(i.home), 0o000);
  const before = snapshot(d.fx.dep);
  for (const [what, revision] of [["with the plan's revision", plan.planRevision], ["with a revision no plan has", STALE]]) {
    const error = refusal(d.apply(i.name, revision, "k1"), what);
    assert.equal(error.code, "E_LIFECYCLE_FAILED", what);
    assert.match(error.message, new RegExp(`^the claim ${i.lock.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} could not be taken \\(EACCES: .*\\); nothing was done$`), what);
    const { plan: shown, ...details } = error.details;
    assert.deepEqual(details, { cause: { code: "EACCES", syscall: "open" } }, `${what}: the cause is the error of the write`);
    assert.deepEqual([shown.action, shown.instance], ["stop", i.name], `${what}: details.plan is the plan the apply read`);
    assert.equal(alive(i.pid), true, `${what}: the harness was not signalled`);
    assert.deepEqual(changes(before, snapshot(d.fx.dep)), [], `${what}: nothing was written`);
  }
});

// ---- 2. somebody holds it, or what is there is no claim -----------------------------------------

test("a stop whose claim cannot be written (no space for it) beside a holder, and beside a file that is no claim: the answer of the same apply when it can write, whole, and nothing was signalled or written", TMUX, async (t) => {
  const d = deployment(t);
  const i = await d.add("h1");
  const plan = await d.runningPlan(i.name);
  const live = bystander(t), gone = exitedPid();
  const AT_THE_PATH = [
    ["a retire that lives", "E_INSTANCE_RETIRING", () => writeClaim(i, { action: "retire", pid: live.pid, processStart: live.start })],
    ["a stop that lives", "E_LIFECYCLE_BUSY", () => writeClaim(i, { action: "stop", pid: live.pid, processStart: live.start }), "running"],
    ["a retire whose liveness cannot be read", "E_LIFECYCLE_BUSY", () => writeClaim(i, { action: "retire", pid: live.pid }), "unknown"],
    ["a stop whose liveness cannot be read", "E_LIFECYCLE_BUSY", () => writeClaim(i, { action: "stop", pid: live.pid }), "unknown"],
    ["bytes that are no claim", "E_LIFECYCLE_BUSY", () => writeFileSync(i.lock, "{not json"), "unknown"],
    ["a link to nowhere", "E_LIFECYCLE_BUSY", () => symlinkSync(join(claimsDir(i.home), "nowhere"), i.lock), "unknown"],
    ["a directory", "E_LIFECYCLE_BUSY", () => mkdirSync(i.lock), "unknown"],
    // A holder that reads as gone, and whose file no kernel can take over.
    ["a gone holder whose record has no nonce", "E_LIFECYCLE_BUSY", () => writeFileSync(i.lock, JSON.stringify({ action: "stop", pid: gone, processStart: "proc:1", at: AT }) + "\n"), "none"],
    ["an empty record", "E_LIFECYCLE_BUSY", () => writeFileSync(i.lock, "{}\n"), "none"],
  ];
  mkdirSync(claimsDir(i.home), { recursive: true, mode: 0o700 });
  let n = 0;
  for (const [what, code, make, holder] of AT_THE_PATH) {
    rmSync(i.lock, { recursive: true, force: true });
    make();
    for (const [which, revision] of [["the plan's revision", d.plan(i.name).planRevision], ["a revision no plan has", STALE]]) {
      const where = `${what}, ${which}`;
      const before = snapshot(d.fx.dep);
      // The apply that can write its claim: today's answer.
      const plain = refusal(d.apply(i.name, revision, `plain-${++n}`), `${where}: the apply that can write`);
      assert.deepEqual([plain.code, plain.details.holder], [code, holder], `${where}: fixture premise, what a stop answers there`);
      // The one that cannot.
      const r = d.faulted(d.applyArgs(i.name, revision, `full-${n}`), [noSpaceForClaim(i)]);
      assert.deepEqual(r.fired, [`claim-${i.name}`], `${where}: the write of the claim was reached, and failed`);
      assert.deepEqual(timeless(refusal(r, where)), timeless(plain), `${where}: the same answer, whole`);
      assert.deepEqual(changes(before, snapshot(d.fx.dep)), [], `${where}: nothing was written, and what is at the claim's path is as it was`);
      assert.equal(alive(i.pid), true, `${where}: the harness was not signalled`);
    }
  }
  assert.deepEqual([plan.targets.map((target) => target.instance), stopFiles(i.home)], [[i.name], []], "no record of a stop, and no receipt");
});

test("a stop whose claim cannot be written and whose holder is verifiably gone: the stop goes on with the warning, and the dead claim's file is as it was, whether the first write found no space or the takeover's", TMUX, async (t) => {
  const d = deployment(t);
  const dead = { action: "retire", pid: exitedPid(), processStart: "proc:1" };
  const CASES = [
    ["the claim's own private file", "g1", (i) => noSpaceForClaim(i)],
    // The first write fitted and the takeover's did not: `<lock>.reclaim-<the dead holder's nonce>`.
    ["the private file of the takeover's claim", "g2", (i) => ({ name: `claim-${i.name}`, fn: "writeFileSync", prefix: `${i.lock}.reclaim-${NONCE}.tmp-`, throws: "ENOSPC", every: true })],
  ];
  for (const [what, name, fault] of CASES) {
    const i = await d.add(name);
    const plan = await d.runningPlan(i.name);
    const bytes = writeClaim(i, dead);
    const r = d.faulted(d.applyArgs(i.name, plan.planRevision, "k1"), [fault(i)]);
    assert.deepEqual(r.fired, [`claim-${i.name}`], `${what}: the write was reached, and failed`);
    const receipt = receiptOf(r, what);
    // The claim's own path in the warning, also when the write that failed was the takeover's.
    assert.equal(r.stderr, warning(i, "ENOSPC"), what);
    assert.deepEqual([receipt.ok, receipt.results.map(row)], [true, [stoppedRow(i)]], what);
    await waitUntil(() => !alive(i.pid), `the harness of ${name} to be gone`);
    assert.deepEqual([readFileSync(i.lock, "utf8"), claimFiles(i.home).filter((entry) => entry.startsWith(`${name}.`))], [bytes, [`${name}.lock`]], `${what}: the dead claim is left byte for byte, and nothing is beside it`);
  }
});

// ---- 3. the last look ---------------------------------------------------------------------------

/** Held where a stop that could not write its claim has read it and found nobody: `lstatSync` of
 *  the claim's path, which only that read makes, and only for a path that read as absent
 *  (lib/claim.mjs claimUnheld). The first one is the read in place of the taking; the second is the
 *  last look, made once the plan has been read again. */
const afterTheRead = (i) => ({ name: "held", fn: "lstatSync", path: i.lock, nth: 1, when: "after" });
const atTheLastLook = (i) => ({ name: "held", fn: "lstatSync", path: i.lock, nth: 2 });

test("the last look: a holder that takes the claim after the stop read it (the directory made writable again in between) is answered with the taking's own refusal and the fresh plan, before a stale plan and before any signal; nobody there is the comparison of the plan, and then the stop", TMUX, async (t) => {
  if (ROOT) { t.skip(SKIP_FOR_ROOT); return; }
  const d = deployment(t);
  const live = bystander(t);
  const ARRIVES = [
    { key: "retire", what: "a retire that lives", code: "E_INSTANCE_RETIRING", make: (i) => writeClaim(i, { action: "retire", pid: live.pid, processStart: live.start }) },
    { key: "stop", what: "a stop that lives", code: "E_LIFECYCLE_BUSY", holder: "running", make: (i) => writeClaim(i, { action: "stop", pid: live.pid, processStart: live.start }) },
    { key: "unread", what: "a stop whose liveness cannot be read", code: "E_LIFECYCLE_BUSY", holder: "unknown", make: (i) => writeClaim(i, { action: "stop", pid: live.pid }) },
    { key: "bytes", what: "bytes that are no claim", code: "E_LIFECYCLE_BUSY", holder: "unknown", make: (i) => writeFileSync(i.lock, "{not json") },
  ];
  // `when` is where the stop is held while the holder comes: before the plan is read again (the
  // fresh plan then shows the holder, and no longer has the revision that was sent), or at the
  // look itself (the fresh plan is the one that was shown: only the look can refuse).
  const WHEN = [
    { key: "p", what: "before the plan is read again", gate: afterTheRead },
    { key: "l", what: "after the plan was read again", gate: atTheLastLook },
  ];
  for (const arrives of ARRIVES) {
    for (const when of WHEN) {
      const what = `${arrives.what} comes ${when.what}`;
      const i = await d.add(`${arrives.key}-${when.key}`);
      const plan = await d.runningPlan(i.name);
      mkdirSync(claimsDir(i.home), { recursive: true, mode: 0o700 });
      d.chmod(claimsDir(i.home), 0o500);
      const run = d.gated(d.applyArgs(i.name, plan.planRevision, "k1"), [when.gate(i)]);
      try {
        await run.waitGate("held");
        assert.equal(alive(i.pid), true, `${what}: fixture premise, the stop has signalled nothing yet`);
        d.giveBack();
        arrives.make(i);
        const before = snapshot(d.fx.dep);
        // What an apply that can write its claim answers there, with the plan as it reads now.
        const fresh = d.plan(i.name);
        const plain = refusal(d.apply(i.name, fresh.planRevision, "plain"), `${what}: the apply that can write`);
        assert.deepEqual([plain.code, plain.details.holder], [arrives.code, arrives.holder], `${what}: fixture premise, what a stop answers there`);
        // A retire in the plan changes its revision: without the look, the plan read again would
        // be answered as stale, and the holder not at all.
        if (arrives.key === "retire") assert.notEqual(fresh.planRevision, plan.planRevision, `${what}: fixture premise, the plan that shows a retire is another plan`);
        run.release("held");
        const error = refusal(await ended(run), what);
        assert.deepEqual({ code: error.code, message: error.message, details: { ...error.details, plan: undefined } }, { code: plain.code, message: plain.message, details: { ...plain.details, plan: undefined } }, `${what}: the refusal of the taking, word for word`);
        // The plan it carries is the one it read under its claims: with the holder in it when the
        // holder came before that read, and the plan that was shown when it came after.
        assert.equal(error.details.plan.planRevision, when.key === "p" ? fresh.planRevision : plan.planRevision, `${what}: details.plan is the plan read again`);
        assert.equal(alive(i.pid), true, `${what}: the harness was not signalled`);
        assert.deepEqual(changes(before, snapshot(d.fx.dep)), [], `${what}: nothing was written, and the holder's claim is as it was`);
      } finally { await run.finish(); }
      rmSync(i.lock, { force: true });
    }
  }

  // The claim can be read no more at the look: the refusal of the write that failed at first.
  {
    const i = await d.add("noread");
    const plan = await d.runningPlan(i.name);
    mkdirSync(claimsDir(i.home), { recursive: true, mode: 0o700 });
    d.chmod(claimsDir(i.home), 0o500);
    const run = d.gated(d.applyArgs(i.name, plan.planRevision, "k1"), [afterTheRead(i)]);
    try {
      await run.waitGate("held");
      d.chmod(claimsDir(i.home), 0o000);
      run.release("held");
      const error = refusal(await ended(run), "the claim cannot be read at the last look");
      assert.equal(error.code, "E_LIFECYCLE_FAILED");
      assert.match(error.message, /could not be taken \(EACCES: .*\); nothing was done$/);
      assert.deepEqual([error.details.cause, error.details.plan.planRevision], [{ code: "EACCES", syscall: "open" }, plan.planRevision]);
      assert.equal(alive(i.pid), true, "the harness was not signalled");
    } finally { await run.finish(); }
    d.giveBack();
  }

  // Nobody at the look. With a revision no plan has: the comparison, E_PLAN_STALE with the fresh
  // plan. With the plan's own: the stop, and its warning, though the claim could be written by now.
  for (const [key, stale] of [["stale", true], ["goes", false]]) {
    const i = await d.add(`nobody-${key}`);
    const plan = await d.runningPlan(i.name);
    d.chmod(claimsDir(i.home), 0o500);
    const run = d.gated(d.applyArgs(i.name, stale ? STALE : plan.planRevision, "k1"), [afterTheRead(i)]);
    try {
      await run.waitGate("held");
      d.giveBack();
      run.release("held");
      const r = await ended(run);
      if (stale) {
        const error = refusal(r, "nobody, and a revision no plan has");
        assert.deepEqual([error.code, error.details.plan.planRevision], ["E_PLAN_STALE", plan.planRevision]);
        assert.equal(alive(i.pid), true, "the harness was not signalled");
      } else {
        assert.deepEqual(receiptOf(r, "nobody, and the plan's revision").results.map(row), [stoppedRow(i)]);
        assert.equal(r.stderr, warning(i, "EACCES"));
        await waitUntil(() => !alive(i.pid), "the harness to be gone");
      }
    } finally { await run.finish(); }
  }
});

// ---- 4. several targets -------------------------------------------------------------------------

test("a stop of a parent and its children in which one child's claim cannot be written: it holds the claims it could write and reads that one, stops every target, warns once and of that child only, and releases what it held; beside a holder of that child it is refused whole", TMUX, async (t) => {
  const d = deployment(t);
  const p = await d.add("p");
  const c1 = await d.add("c1", { parent: p }), c2 = await d.add("c2", { parent: p });
  const all = [c1, c2, p];
  const plan = await d.runningPlan(p.name);
  assert.deepEqual(plan.targets.map((target) => target.instance), ["c1", "c2", "p"], "fixture premise: the plan's targets, deepest first");

  // Beside a live holder of c1's claim: the answer of an apply that can write, and every claim it
  // had taken by then (none sorts before c1's) or would take is released.
  const live = bystander(t);
  writeClaim(c1, { action: "stop", pid: live.pid, processStart: live.start });
  const plain = refusal(d.apply(p.name, plan.planRevision, "plain"), "beside a holder of c1, able to write");
  const refused = d.faulted(d.applyArgs(p.name, plan.planRevision, "full"), [noSpaceForClaim(c1)]);
  assert.deepEqual(refused.fired, ["claim-c1"]);
  assert.deepEqual(timeless(refusal(refused, "beside a holder of c1, with no space for its claim")), timeless(plain));
  assert.deepEqual([claimFiles(p.home), all.map((i) => alive(i.pid))], [["c1.lock"], [true, true, true]], "nothing was stopped, and no claim of the apply's is left");
  rmSync(c1.lock);

  // Nobody holds c1: held before the first target is stopped (the apply's removal of a marker an
  // older kernel may have left in the first target's home, its last step before the first stop).
  const run = d.gated(d.applyArgs(p.name, (await d.runningPlan(p.name)).planRevision, "k1"),
    [noSpaceForClaim(c1), { name: "held", fn: "rmSync", path: join(c1.home, ".oats-stop-pending.json") }]);
  try {
    await run.waitGate("held");
    assert.deepEqual(claimFiles(p.home), ["c2.lock", "p.lock"], "it holds the two claims it could write, and nothing of c1's");
    for (const i of [c2, p]) assert.deepEqual([readJson(i.lock).action, readJson(i.lock).pid], ["stop", run.child.pid], `the claim of ${i.name} is the apply's`);
    assert.deepEqual(all.map((i) => alive(i.pid)), [true, true, true], "fixture premise: nothing is stopped yet");
    run.release("held");
    const r = await ended(run);
    const receipt = receiptOf(r, "the stop of p and its children");
    assert.deepEqual([receipt.ok, receipt.results.map(row)], [true, all.map(stoppedRow)]);
    assert.equal(r.stderr, warning(c1, "ENOSPC"), "one warning, for the one target whose claim was only read");
    assert.equal(run.entered("claim-c1"), true, "the write of c1's claim was reached, and failed");
  } finally { await run.finish(); }
  for (const i of all) await waitUntil(() => !alive(i.pid), `the harness of ${i.name} to be gone`);
  assert.deepEqual(claimFiles(p.home), [], "the claims it held are released, and nothing is left of the one it only read");
});

// ---- 5. the callers that still need the claim ---------------------------------------------------

test("a retire whose claim cannot be written, and a retire whose stop of a recorded child cannot write the child's claim, answer as they did: the retire E_LIFECYCLE_FAILED, the child's row E_LIFECYCLE_FAILED under E_CHILDREN_RUNNING; nothing was stopped or retired, and no warning is printed", TMUX, async (t) => {
  const d = deployment(t);
  const p = await d.add("p");
  const kid = await d.add("kid", { parent: p });
  await d.runningPlan(p.name);
  const before = snapshot(d.fx.dep);
  const untouched = (what) => {
    assert.deepEqual([alive(p.pid), alive(kid.pid), p.hookRuns(), kid.hookRuns()], [true, true, 0, 0], `${what}: nothing was stopped and no retire hook ran`);
    assert.deepEqual(changes(before, snapshot(d.fx.dep)), ["+ agents/worker/instances/.oats-retirement/claims/"], `${what}: nothing was retired or written, in a home or beside it, but the claims directory, which could be made`);
    assert.deepEqual(claimFiles(p.home), [], `${what}: no claim is left`);
  };
  for (const code of CLAIM_UNWRITABLE_CODES) {
    // The retire's own claim.
    const own = d.faulted(["retire", p.name, "--json"], [noSpaceForClaim(p, code)]);
    assert.deepEqual(own.fired, ["claim-p"], code);
    const error = refusal(own, `${code} at the retire's own claim`);
    assert.equal(error.code, "E_LIFECYCLE_FAILED", code);
    assert.match(error.message, new RegExp(`^the claim ${p.lock.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} could not be taken \\(${code}: .*\\); nothing was done$`), code);
    assert.deepEqual(error.details, { cause: { code, syscall: "write" } }, code);
    untouched(`${code} at the retire's own claim`);

    // The claim of its recorded child, which the retire's stop of that child takes.
    const child = d.faulted(["retire", p.name, "--json"], [noSpaceForClaim(kid, code)]);
    assert.deepEqual(child.fired, ["claim-kid"], code);
    const refused = refusal(child, `${code} at the child's claim`);
    assert.equal(refused.code, "E_CHILDREN_RUNNING", `${code}: ${JSON.stringify(refused)}`);
    assert.equal(refused.message, "kid could not be stopped (E_LIFECYCLE_FAILED); nothing was retired and nothing was escalated", code);
    const [kidRow] = refused.details.childrenStopped;
    assert.deepEqual({ ...kidRow, message: undefined }, { instance: "kid", home: kid.home, ok: false, code: "E_LIFECYCLE_FAILED", message: undefined, stillRunning: null }, code);
    assert.match(kidRow.message, new RegExp(`^the claim ${kid.lock.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} could not be taken \\(${code}: .*\\); nothing was done$`), code);
    untouched(`${code} at the child's claim`);
  }
});

// ---- 6. a file system that is full --------------------------------------------------------------

test("a file system with no space for any write of the stop, the claim's and the home's alike (ENOSPC at every write under the deployment): the session is stopped and the apply answers its receipt, whose row is E_SESSION_STOP_FAILED and says the harness has exited, with the warning; the receipt cannot be stored, so the same key is E_PLAN_STALE, and with the fresh revision alreadyIdle, with the warning again", TMUX, async (t) => {
  const d = deployment(t);
  const i = await d.add("full1"), j = await d.add("full2");
  const plans = { i: await d.runningPlan(i.name), j: await d.runningPlan(j.name) };
  // Every write of bytes under the deployment finds no space: the claim's private file, the
  // stop's record in the home, its receipt, a row of the event log. A directory is made and a
  // file is removed, as on the file system this was first run on, full to its last block (the
  // write of the claim's directory is test/claim.test.mjs's). One thing the fault does not
  // show: it fails a write before its file is made, where a full file system makes the file,
  // empty, and then has no block for its bytes. Of the claim's private file nothing is left
  // either way (test/claim.test.mjs stages that); what a write into the home leaves behind is
  // not this suite's.
  const full = () => ["writeFileSync", "appendFileSync"].map((fn) => ({ name: fn, fn, prefix: `${d.fx.dep}/`, throws: "ENOSPC", every: true }));
  const before = snapshot(d.fx.dep);
  const written = () => changes(before, snapshot(d.fx.dep));
  const NOTHING_BUT_THE_DIRECTORY = ["+ agents/worker/instances/.oats-retirement/claims/"];
  // And the exit marker of the stopped harness's window: written by the window's shell when the
  // harness ends, not by the stop (a write outside the kernel's process, so the fault does not reach
  // it; on a full disk its redirect fails too, and there is none). It names the start with the
  // signal's status: with no record of the stop, the home reads `sessionEnd: lost`.
  const marked = async (x) => {
    await waitUntil(() => readStartExited(x.home) !== null, `the exit marker of ${x.name}'s window`);
    const { startId } = JSON.parse(readFileSync(join(x.home, "instance.json"), "utf8"));
    assert.deepEqual(readStartExited(x.home), { startId, status: 143 }, `${x.name}: the marker of its start, SIGTERM's status`);
    return `+ agents/worker/instances/${x.name}/.oats-start-exited`;
  };

  // 1. The apply, in JSON mode.
  const first = d.faulted(d.applyArgs(i.name, plans.i.planRevision, "k1"), full());
  assert.ok(first.fired.includes("writeFileSync"), `the writes were reached, and failed: ${first.fired}`);
  const receipt = receiptOf(first, "the stop on a full file system");
  assert.equal(first.stderr, warning(i, "ENOSPC"), "stderr is the one warning");
  assert.deepEqual([receipt.ok, receipt.replayed, receipt.results.length], [false, false, 1]);
  const [result] = receipt.results;
  assert.deepEqual(Object.keys(result).sort(), ["code", "home", "instance", "message", "ok", "stillRunning"], "the row of a target that failed, with no new key");
  assert.deepEqual({ ...result, message: undefined }, { instance: i.name, home: i.home, ok: false, code: "E_SESSION_STOP_FAILED", message: undefined, stillRunning: [] }, "never the system's code; and none of its processes is still running");
  assert.match(result.message, /^full1: ENOSPC: .*; its harness was signalled \(SIGTERM\) and has exited$/);
  await waitUntil(() => !alive(i.pid), "the harness of full1 to be gone: the stop stopped it");
  const markerI = await marked(i);
  assert.deepEqual(written(), [...NOTHING_BUT_THE_DIRECTORY, markerI].sort(), "nothing was written: no claim, no record of the stop, no receipt, and no private file of any of them");

  // 2. The same key again. The receipt was not stored, so nothing is replayed: the apply runs,
  // and the plan is no longer the one that was shown (the session is stopped).
  const second = d.faulted(d.applyArgs(i.name, plans.i.planRevision, "k1"), full());
  const stale = refusal(second, "the same key again");
  assert.equal(stale.code, "E_PLAN_STALE");
  const now = d.plan(i.name);
  assert.deepEqual([stale.details.plan.planRevision, now.targets[0].session.state], [now.planRevision, "shell"], "with the fresh plan, in which the session is stopped");

  // 3. With that plan's revision, and the same key: the stop finds the session idle. The warning
  // is printed again: this apply too went on without the claim.
  const third = d.faulted(d.applyArgs(i.name, now.planRevision, "k1"), full());
  const idle = receiptOf(third, "the apply with the fresh revision");
  assert.deepEqual([idle.ok, idle.replayed, idle.results.map(row)], [true, false, [{ instance: i.name, home: i.home, ok: true, stopped: false, alreadyIdle: true }]]);
  assert.equal(third.stderr, warning(i, "ENOSPC"));
  assert.deepEqual(written(), [...NOTHING_BUT_THE_DIRECTORY, markerI].sort(), "and still nothing was written");

  // Text mode, on the other instance: the warning, the row's words, and the exit status of a
  // stop one of whose targets failed.
  const text = d.faulted(["instance", "stop", j.name, "--apply", "--plan-revision", plans.j.planRevision, "--idempotency-key", "k1"], full());
  assert.equal(text.stderr, warning(j, "ENOSPC"));
  assert.equal(text.status, 1, text.stdout);
  assert.match(text.stdout, /^ {2}full2: E_SESSION_STOP_FAILED — full2: ENOSPC: .*; its harness was signalled \(SIGTERM\) and has exited\n/);
  await waitUntil(() => !alive(j.pid), "the harness of full2 to be gone");
  assert.deepEqual(written(), [...NOTHING_BUT_THE_DIRECTORY, markerI, await marked(j)].sort());
});
