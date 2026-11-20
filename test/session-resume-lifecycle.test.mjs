// A resume never brings back a home OATS is stopping, upgrading or retiring, or whose retire is owed
// (#1559, the 0.69.2 fix). On 0.69.1 a sweep resumed homes in the middle of their retire: the
// retire's own window kill wrote no stop record, so the home read `lost`, and nothing made the
// sweep's start exclusive with the retire. Now:
//   - `session start --resume` holds the home's lifecycle claim (verb `resume`) for the whole start,
//     and reads under it the retire the home owes and whether its session is still lost;
//   - the sweep skips such a home (`skipped`/`lifecycle-busy`), from the status row first and from
//     the start's own refusal when the row read missed it, and judges nothing there;
//   - a retire records the stop before it ends the window, so the home reads `stopped`, never `lost`.
// On real tmux: each fixture's own `oats` server (v2Deployment), a stand-in harness that records each
// launch and sleeps, homes made lost by killing their window by hand (no marker, no stop record). A
// command "already on the home" is the kernel's own CLI held by test/helpers/fs-gate-preload.mjs at
// the call named, never a race against the clock.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn as spawnChild, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { deferredRetireResultPath, retireClaimPath, retirePendingMarkerPath } from "../lib/core.mjs";
import { bootId, readBootNote, resumeSessions } from "../lib/session-resume.mjs";
import { OUTCOME, ROW_REASON, SESSION_END } from "../lib/session-resume-contract.mjs";
import { processStartToken } from "../lib/worktree-hooks.mjs";
import { CLI, v2Deployment, writeFixtureExecutable } from "./helpers/v2-deployment.mjs";
import { waitUntil } from "./helpers/host-fixture.mjs";
import { runFaulted, startGated } from "./helpers/fs-gate-preload.mjs";

const HAS_TMUX = !spawnSync("tmux", ["-V"], { stdio: "ignore" }).error;
const TMUX = { skip: !HAS_TMUX && "tmux is not installed" };
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const NONCE = "b".repeat(32);

/** One deployment per test: a launch configuration whose harness is the fixture's own file (it
 *  records its start, then sleeps), and a process that lives as long as the test and is no oats
 *  command, whose pid a claim written by hand names. */
function fixture(t) {
  const fx = v2Deployment({ t });
  const records = join(fx.base, "launches");
  mkdirSync(records);
  const executable = join(fx.base, "harness-stand-in");
  writeFixtureExecutable(fx.base, executable, `#!/bin/sh\necho "$$" > '${records}'/"$OATS_INSTANCE.$(date +%s%N).$$"\nexec sleep 600\n`);
  const localFile = join(fx.dep, "oats-local.yaml");
  writeFileSync(localFile, `${readFileSync(localFile, "utf8")}\nlaunch-configs:\n  stand-in:\n    harness: pi\n    executable: ${JSON.stringify(executable)}\n`);
  const bystander = spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { cwd: "/", stdio: "ignore" });
  fx.beforeCleanup(() => { bystander.kill("SIGKILL"); });
  const f = { fx, bystander: bystander.pid };
  f.launches = (name) => readdirSync(records).filter((entry) => entry.startsWith(`${name}.`)).length;
  /** The CLI's JSON envelope for `argv`. */
  f.cli = (argv) => { const r = fx.cli(argv); try { return JSON.parse(r.stdout); } catch { assert.fail(`no JSON answer from oats ${argv.join(" ")}: ${r.stdout}${r.stderr}`); } };
  /** `oats status --json` (a document of its own, not an envelope): its instance rows by name. */
  f.status = () => Object.fromEntries(f.cli(["status", "--json"]).agents.flatMap((a) => a.instances).map((i) => [i.instance, i]));
  f.sweep = (...extra) => {
    const a = f.cli(["session", "resume", "--deployment", fx.dep, ...extra, "--json"]);
    assert.equal(a.ok, true, JSON.stringify(a));
    return a.result;
  };
  f.resume = (home) => f.cli(["session", "start", "--resume", "--home", home, "--json"]);
  /** A launched home whose session is lost: spawned with the stand-in, seen running by a status (the
   *  sweep resumes only a home it saw recently), then its window killed by hand. */
  f.lostHome = async (name) => {
    const hostPath = process.env.PATH;
    process.env.PATH = fx.env.PATH;
    let made;
    try { made = await fx.spawn("dev", { name, launch: true, launchConfig: "stand-in" }); } finally { process.env.PATH = hostPath; }
    await waitUntil(() => f.launches(name) === 1, `${name}'s harness to start`, 30000);
    await waitUntil(() => f.status()[name]?.running === true, `${name} to read as running`, 30000);
    const { tmux } = readJson(join(made.home, "instance.json"));
    execFileSync("tmux", ["-u", "-S", tmux.socket, "kill-window", "-t", `=${tmux.session}:=${tmux.window}`], { stdio: "ignore" });
    await waitUntil(() => f.status()[name]?.sessionEnd === SESSION_END.LOST, `${name} to read as lost`, 30000);
    return { name, home: made.home, lock: retireClaimPath(made.home) };
  };
  /** A claim of `action` written by hand at the home's claim path, as lib/claim.mjs writes one: its
   *  holder the bystander, alive (its start token recorded) or of a liveness that cannot be read. */
  f.claim = async (i, action, { readable = true } = {}) => {
    const processStart = readable ? await fx.inEnv(() => processStartToken(f.bystander)) : undefined;
    mkdirSync(dirname(i.lock), { recursive: true });
    const bytes = JSON.stringify({ action, pid: f.bystander, ...(processStart ? { processStart } : {}), nonce: NONCE, at: new Date().toISOString() }) + "\n";
    writeFileSync(i.lock, bytes);
    return bytes;
  };
  f.claimFiles = (i) => existsSync(dirname(i.lock)) ? readdirSync(dirname(i.lock)).filter((entry) => entry.startsWith(`${i.name}.lock`)) : [];
  f.row = (answer, i) => answer.rows.find((r) => r.home === i.home);
  /** The refusals this boot's note holds for `i` (the note names a home by its real path). */
  f.noted = async (i) => (await fx.inEnv(() => readBootNote(bootId()))).refused.filter((r) => r.home?.endsWith(`/instances/${i.name}`));
  return f;
}
let gated = 0;
/** The kernel's CLI on `i`, held once it holds the home's claim (the `linkSync` that takes it). */
async function heldOnClaim(f, i, argv, verb) {
  const run = startGated([CLI, ...argv], { cwd: f.fx.dep, env: f.fx.env, gateDir: join(f.fx.base, "gates", `${i.name}-${verb}-${++gated}`),
    gates: [{ name: "claimed", fn: "linkSync", arg: 1, path: i.lock, when: "after", waitMs: 120000 }] });
  try {
    await run.waitGate("claimed");
    assert.deepEqual({ pid: readJson(i.lock).pid, action: readJson(i.lock).action }, { pid: run.child.pid, action: verb }, "fixture premise: the claim is the held command's");
  } catch (e) { await run.finish(); throw e; }
  return run;
}
/** A sweep row, as these tests compare it. */
const shape = (row) => row && { instance: row.instance, home: row.home, outcome: row.outcome, reason: row.reason };
const skippedBusy = (i) => ({ instance: i.name, home: i.home, outcome: OUTCOME.SKIPPED, reason: ROW_REASON.LIFECYCLE_BUSY });

test("a retire holds the claim of a lost home: the sweep and its plan skip it lifecycle-busy and start nothing, a hand resume is refused E_INSTANCE_RETIRING, and the retire completes", TMUX, async (t) => {
  const f = fixture(t);
  const i = await f.lostHome("r1");
  const run = await heldOnClaim(f, i, ["retire", i.name, "--json"], "retire");
  try {
    const claim = readFileSync(i.lock, "utf8");
    assert.equal(f.status()[i.name].retire?.state, "running", "fixture premise: the row shows the retire");
    assert.deepEqual(shape(f.row(f.sweep("--plan"), i)), skippedBusy(i), "the plan predicts the skip");
    assert.equal(readFileSync(i.lock, "utf8"), claim, "and takes no claim");
    const swept = f.row(f.sweep(), i);
    assert.deepEqual(shape(swept), skippedBusy(i), JSON.stringify(swept));
    assert.match(swept.message, /r1 is owed a retire \(its retire is running\); a home OATS is retiring is never resumed/);
    const hand = f.resume(i.home);
    assert.deepEqual([hand.ok, hand.error?.code, hand.error?.details?.action], [false, "E_INSTANCE_RETIRING", "retire"], JSON.stringify(hand));
    assert.match(hand.error.message, /nothing was started/);
    assert.equal(f.launches(i.name), 1, "nothing was started");
    assert.deepEqual(await f.noted(i), [], "no refusal is noted");
    run.release("claimed");
    const r = await run.done;
    assert.deepEqual([r.code, r.timedOut], [0, []], r.stdout + r.stderr);
    assert.equal(existsSync(i.home), false, "the retire completed");
    assert.deepEqual(f.claimFiles(i), []);
  } finally { await run.finish(); }
});

test("a sweep between a retire's stop and the home's removal resumes nothing: the home reads stopped, its stop record names its start", TMUX, async (t) => {
  const f = fixture(t);
  const i = await f.lostHome("r2");
  const startId = readJson(join(i.home, "instance.json")).startId;
  // Held at the removal of the home: the retire has stopped the session (here: recorded the stop of
  // a window already gone) and done everything else.
  const run = startGated([CLI, "retire", i.name, "--json"], { cwd: f.fx.dep, env: f.fx.env, gateDir: join(f.fx.base, "gates", "r2"),
    gates: [{ name: "removal", fn: "rmSync", path: i.home, waitMs: 120000 }] });
  try {
    await run.waitGate("removal");
    assert.deepEqual([f.status()[i.name].sessionEnd, readJson(join(i.home, ".oats-stop.json")).startId], [SESSION_END.STOPPED, startId]);
    const swept = f.row(f.sweep(), i);
    assert.ok(swept === undefined || (swept.outcome === OUTCOME.SKIPPED && swept.reason === ROW_REASON.NOT_LOST), JSON.stringify(swept));
    assert.equal(f.launches(i.name), 1, "nothing was started");
    run.release("removal");
    const r = await run.done;
    assert.deepEqual([r.code, r.timedOut], [0, []], r.stdout + r.stderr);
  } finally { await run.finish(); }
});

test("a retire that fails after its stop leaves a home that reads stopped, its stop record naming that start; the sweep does not resume it", TMUX, async (t) => {
  const f = fixture(t);
  const i = await f.lostHome("r3");
  const startId = readJson(join(i.home, "instance.json")).startId;
  const r = runFaulted([CLI, "retire", i.name, "--json"], { cwd: f.fx.dep, env: f.fx.env, gateDir: join(f.fx.base, "faults", "r3"),
    gates: [{ name: "removal", fn: "rmSync", path: i.home, throws: "EIO" }] });
  assert.deepEqual([r.status, r.fired], [1, ["removal"]], r.stdout + r.stderr);
  assert.equal(existsSync(join(i.home, "instance.json")), true, "fixture premise: the home is kept");
  assert.deepEqual([f.status()[i.name].sessionEnd, readJson(join(i.home, ".oats-stop.json")).startId], [SESSION_END.STOPPED, startId]);
  assert.equal(f.row(f.sweep(), i), undefined, "a stopped home is not the sweep's");
  assert.equal(f.resume(i.home).error?.code, "E_RESUME_NOT_LOST");
  assert.equal(f.launches(i.name), 1);
});

test("a resume holds the claim: a retire that arrives is refused E_LIFECYCLE_BUSY naming the resume, and the home is left as the resume made it", TMUX, async (t) => {
  const f = fixture(t);
  const i = await f.lostHome("r4");
  const run = await heldOnClaim(f, i, ["session", "start", "--resume", "--home", i.home, "--json"], "resume");
  try {
    const retire = f.cli(["retire", i.name, "--json"]);
    assert.deepEqual([retire.ok, retire.error?.code, retire.error?.details?.action, retire.error?.details?.holder], [false, "E_LIFECYCLE_BUSY", "resume", "running"], JSON.stringify(retire));
    assert.equal(retire.error.message, `a resume of r4 is already running (pid ${run.child.pid}, since ${readJson(i.lock).at}); nothing was done — wait for it to finish; if it does not end, check that pid by hand, and if it is not an oats session start --resume, remove ${i.lock}, then retry`);
    const stop = f.cli(["instance", "stop", i.name, "--apply", "--plan-revision", f.cli(["instance", "stop", i.name, "--plan", "--json"]).result.planRevision, "--idempotency-key", "k", "--json"]);
    assert.deepEqual([stop.error?.code, stop.error?.details?.action], ["E_LIFECYCLE_BUSY", "resume"], JSON.stringify(stop));
    run.release("claimed");
    const r = await run.done;
    assert.deepEqual([r.code, r.timedOut], [0, []], r.stdout + r.stderr);
    assert.equal(JSON.parse(r.stdout).ok, true, r.stdout);
    await waitUntil(() => f.launches(i.name) === 2, "the resumed harness to start", 30000);
    assert.equal(existsSync(i.home), true, "the home is there");
    await waitUntil(() => f.status()[i.name]?.running === true, "the resumed home to run", 30000);
    assert.deepEqual(f.claimFiles(i), [], "the resume released its claim");
  } finally { await run.finish(); }
});

for (const action of ["stop", "upgrade"]) {
  test(`a held ${action} claim: the plan and the sweep skip the home lifecycle-busy and start nothing, a hand resume is refused E_LIFECYCLE_BUSY; the skip is not judged, so once the claim is gone the next sweep resumes it`, TMUX, async (t) => {
    const f = fixture(t);
    const i = await f.lostHome(`h-${action}`);
    const claim = await f.claim(i, action);
    assert.deepEqual(shape(f.row(f.sweep("--plan"), i)), skippedBusy(i));
    assert.equal(readFileSync(i.lock, "utf8"), claim, "the plan takes no claim");
    const swept = f.row(f.sweep(), i);
    assert.deepEqual(shape(swept), skippedBusy(i), JSON.stringify(swept));
    assert.ok(swept.message.includes(`is held by a ${action} (${i.lock})`), swept.message);
    const hand = f.resume(i.home);
    assert.deepEqual([hand.error?.code, hand.error?.details?.action, hand.error?.details?.holder], ["E_LIFECYCLE_BUSY", action, "running"], JSON.stringify(hand));
    assert.equal(readFileSync(i.lock, "utf8"), claim, "the claim is the holder's still");
    assert.equal(f.launches(i.name), 1, "nothing was started");
    assert.deepEqual(await f.noted(i), [], "no refusal is noted");
    rmSync(i.lock);
    assert.ok([OUTCOME.RESUMED, OUTCOME.FRESH].includes(f.row(f.sweep(), i)?.outcome), "the next sweep resumes it");
    await waitUntil(() => f.launches(i.name) === 2, "the resumed harness to start", 30000);
  });
}

test("a claim taken after the sweep read the row: the start answers E_LIFECYCLE_BUSY, the row is skipped lifecycle-busy with that code and message, nothing is noted or judged", TMUX, async (t) => {
  const f = fixture(t);
  const i = await f.lostHome("late");
  // The sweep's start, as the kernel runs it, with a stop's claim taken just before it.
  const answer = await f.fx.inEnv(() => resumeSessions({ deployment: f.fx.dep, start: async (row) => {
    await f.claim(i, "stop");
    return f.cli(["session", "start", "--resume", "--home", row.home, "--json"]);
  } }));
  const row = f.row(answer, i);
  assert.deepEqual({ ...shape(row), code: row.code }, { ...skippedBusy(i), code: "E_LIFECYCLE_BUSY" }, JSON.stringify(row));
  assert.match(row.message, /^a stop of late is already running \(pid \d+, since [^)]+\); nothing was started — /);
  assert.equal(f.launches(i.name), 1, "nothing was started");
  assert.deepEqual(await f.noted(i), [], "no refusal is noted");
  rmSync(i.lock);
  assert.ok([OUTCOME.RESUMED, OUTCOME.FRESH].includes(f.row(f.sweep(), i)?.outcome), "not judged: the next sweep resumes it");
});

test("one claim for every spelling of a home: a resume of H/., of H through a link to its deployment or of a link to H itself meets a stop's or an upgrade's claim at H, and a retire meets the claim a resume of such a spelling holds", TMUX, async (t) => {
  const f = fixture(t);
  const i = await f.lostHome("spelled");
  const deploymentLink = join(f.fx.base, "deployment-link"), homeLink = join(f.fx.base, "home-link");
  symlinkSync(f.fx.dep, deploymentLink);
  symlinkSync(i.home, homeLink);
  const spellings = [`${i.home}/.`, join(deploymentLink, relative(f.fx.dep, i.home)), homeLink];
  for (const action of ["stop", "upgrade"]) {
    const claim = await f.claim(i, action);
    for (const home of spellings) {
      const hand = f.resume(home);
      assert.deepEqual([hand.error?.code, hand.error?.details?.action, hand.error?.details?.lock], ["E_LIFECYCLE_BUSY", action, i.lock], `${home}: ${JSON.stringify(hand)}`);
    }
    assert.equal(readFileSync(i.lock, "utf8"), claim, `the ${action}'s claim is as it was`);
    rmSync(i.lock);
  }
  assert.equal(f.launches(i.name), 1, "nothing was started");
  // The other way round: a resume of a spelling holds H's claim, and a retire of H meets it.
  for (const [n, home] of spellings.entries()) {
    const run = await heldOnClaim(f, i, ["session", "start", "--resume", "--home", home, "--json"], "resume");
    try {
      const retire = f.cli(["retire", i.name, "--json"]);
      assert.deepEqual([retire.error?.code, retire.error?.details?.action], ["E_LIFECYCLE_BUSY", "resume"], `${home}: ${JSON.stringify(retire)}`);
      run.release("claimed");
      const r = await run.done;
      assert.equal(r.timedOut.length, 0, r.stdout + r.stderr);
      // The first resumes the home; the later ones find it running, and start nothing.
      assert.equal(JSON.parse(r.stdout).ok ? "ok" : JSON.parse(r.stdout).error.code, n === 0 ? "ok" : "E_SESSION_RUNNING", `${home}: ${r.stdout}${r.stderr}`);
      await waitUntil(() => f.launches(i.name) === 2, "the resumed harness to start", 30000);
      assert.deepEqual(f.claimFiles(i), [], "the resume released its claim");
    } finally { await run.finish(); }
  }
});

for (const action of ["stop", "upgrade"]) {
  test(`a link changed after the resume took its claim does not move the start: a resume of L -> A, L then pointed at B whose ${action} holds its claim, resumes A and starts nothing at B`, TMUX, async (t) => {
    const f = fixture(t);
    const a = await f.lostHome(`a-${action}`), b = await f.lostHome(`b-${action}`);
    const link = join(f.fx.base, "home-link");
    symlinkSync(a.home, link);
    const claim = await f.claim(b, action);
    const run = await heldOnClaim(f, a, ["session", "start", "--resume", "--home", link, "--json"], "resume");
    try {
      rmSync(link);
      symlinkSync(b.home, link);
      run.release("claimed");
      const r = await run.done;
      assert.equal(r.timedOut.length, 0, r.stdout + r.stderr);
      const answer = JSON.parse(r.stdout);
      assert.deepEqual([answer.ok, answer.result?.home], [true, a.home], r.stdout + r.stderr);
      await waitUntil(() => f.launches(a.name) === 2, "A's resumed harness to start", 30000);
      assert.equal(f.launches(b.name), 1, "nothing was started at B");
      assert.equal(readFileSync(b.lock, "utf8"), claim, `B's ${action} claim is as it was`);
      assert.deepEqual(f.claimFiles(a), [], "the resume released A's claim");
    } finally { await run.finish(); }
  });
}

test("an upgrade that took the claim and wrote its partial receipt after the sweep read the row: the start is busy, not a partial upgrade; the row is skipped lifecycle-busy, nothing is noted or judged", TMUX, async (t) => {
  const f = fixture(t);
  const i = await f.lostHome("late-upgrade");
  const receipt = join(i.home, ".oats", "upgrade-receipt.k1.json");
  const answer = await f.fx.inEnv(() => resumeSessions({ deployment: f.fx.dep, start: async (row) => {
    await f.claim(i, "upgrade");
    writeFileSync(receipt, JSON.stringify({ action: "upgrade", status: "partial", idempotencyKey: "k1", planRevision: "r1", instance: i.name }));
    return f.cli(["session", "start", "--resume", "--home", row.home, "--json"]);
  } }));
  const row = f.row(answer, i);
  assert.deepEqual({ ...shape(row), code: row.code }, { ...skippedBusy(i), code: "E_LIFECYCLE_BUSY" }, JSON.stringify(row));
  assert.match(row.message, /^an? upgrade of late-upgrade is already running/);
  assert.equal(f.launches(i.name), 1, "nothing was started");
  assert.deepEqual(await f.noted(i), [], "no refusal is noted");
  // The upgrade finishes: its claim and its partial receipt go. The loss was not judged.
  rmSync(i.lock);
  rmSync(receipt);
  assert.ok([OUTCOME.RESUMED, OUTCOME.FRESH].includes(f.row(f.sweep(), i)?.outcome), "the next sweep resumes it");
});

test("an owed retire (a self-retire whose completion failed or was interrupted, no claim held): the sweep skips the home lifecycle-busy, a hand resume is refused E_INSTANCE_RETIRING", TMUX, async (t) => {
  const f = fixture(t);
  const gone = spawnSync(process.execPath, ["-e", ""]).pid;
  for (const [name, state] of [["owed-failed", "failed"], ["owed-interrupted", "interrupted"]]) {
    const i = await f.lostHome(name);
    writeFileSync(retirePendingMarkerPath(i.home), JSON.stringify({ instance: name, requestedAt: new Date().toISOString(), completionPid: gone, completionStart: "proc:1" }));
    if (state === "failed") writeFileSync(deferredRetireResultPath(i.home), JSON.stringify({ ok: false, completedAt: new Date().toISOString(), error: { code: "E_REQUIRED_HOOK_FAILED", message: "a hook failed" } }));
    assert.equal(f.status()[name].retire?.state, state, "fixture premise: the row shows the owed retire");
    for (const answer of [f.sweep("--plan"), f.sweep()]) assert.deepEqual(shape(f.row(answer, i)), skippedBusy(i), `${name}: ${JSON.stringify(f.row(answer, i))}`);
    assert.equal(f.resume(i.home).error?.code, "E_INSTANCE_RETIRING");
    assert.equal(f.launches(name), 1, `${name}: nothing was started`);
    assert.deepEqual(f.claimFiles(i), [], "no claim is left");
  }
});

test("a home removed between the sweep's read and its start is skipped not-lost; the sweep's other rows are unaffected, and no claim file is left", TMUX, async (t) => {
  const f = fixture(t);
  const gone = await f.lostHome("gone");
  const other = await f.lostHome("other");
  const answer = await f.fx.inEnv(() => resumeSessions({ deployment: f.fx.dep, start: async (row) => {
    if (row.home === gone.home) rmSync(gone.home, { recursive: true, force: true });
    return f.cli(["session", "start", "--resume", "--home", row.home, "--json"]);
  } }));
  assert.deepEqual(shape(f.row(answer, gone)), { ...skippedBusy(gone), reason: ROW_REASON.NOT_LOST }, JSON.stringify(answer.rows));
  assert.ok([OUTCOME.RESUMED, OUTCOME.FRESH].includes(f.row(answer, other).outcome), JSON.stringify(answer.rows));
  await waitUntil(() => f.launches("other") === 2, "the other home's harness to start", 30000);
  assert.deepEqual(f.claimFiles(gone), [], "no claim file is left");
  assert.equal(existsSync(gone.lock), false);
});
