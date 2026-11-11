// What a retire answers once something has happened, and the codes it keeps for "nothing happened"
// (awebai/oats#895; lib/errors.mjs BEFORE_EFFECT_CODES and afterFirstEffect).
//
// A client reads some codes of `oats retire` and `oats instance stop` as "refused, nothing
// happened": E_PLAN_STALE, E_LIFECYCLE_BUSY, E_BAD_ARGS, E_UNIDENTIFIED_INSTANCE_HOME and the rest
// of BEFORE_EFFECT_CODES. Two answers of a retire carried such a code after it had acted:
//
//   - a guarded retire whose extra worktrees changed between the plan it revalidated and the step
//     that deals with them answered E_PLAN_STALE, although its retire hooks had run by then. It is
//     now E_WORK_PRESERVATION_FAILED, with the same words;
//   - a retire that signalled the worktree-hook process group an interrupted spawn left, and saw it
//     survive SIGTERM and SIGKILL, answered E_LIFECYCLE_BUSY. It is now E_RUNTIME_QUIESCE_FAILED.
//
// And the rule now holds for the places nobody thought of: an error that leaves a retire with a
// listed code once `reached.phase` is past "before-effects" (or a stop apply once its first
// target's stop began) is answered E_LIFECYCLE_FAILED, `oats <verb> answered <code> after its first
// effect (<point>): <its message>`, `details.cause: { name: "LateRefusal" }`, and its stack is
// printed on stderr: it is a kernel defect, and no client is told that nothing happened.
//
// The last tests pin the other side of the list for one code: E_UNIDENTIFIED_INSTANCE_HOME is
// answered before any effect by every form of the two verbs, and the home is byte-identical after
// each refusal (test/unreadable-record.test.mjs pins the code and its words, shape by shape).
//
// Nothing here rests on a sleep. The retire whose tree changes is HELD at the first read its
// inspection after the hooks makes (test/helpers/fs-gate-preload.mjs), the test dirties the tree
// as a second writer, and lets it go on. The late refusal is raised by a preload this file writes,
// at one `node:fs` call the retire makes only once its own retire hook has run.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn as spawnChild, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as errors from "../lib/errors.mjs";
import { processStartToken } from "../lib/worktree-hooks.mjs";
import { hostProcessState, killAndReap, waitUntil, zombieSync } from "./helpers/host-fixture.mjs";
import { startGated } from "./helpers/fs-gate-preload.mjs";
import { CLI, v2Deployment } from "./helpers/v2-deployment.mjs";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
/** How long a held command waits for its release before it goes on by itself (the pause's own
 *  bound, which a test then reports): well above what the commands run meanwhile take on a slow host. */
const HOLD_MS = 120000;
/** The lifecycle claim of the home `home`: one file per home, beside the homes (lib/core.mjs retireClaimPath). */
const claimOf = (home) => join(dirname(home), ".oats-retirement", "claims", `${basename(home)}.lock`);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Whether the process group `pgid` has a member, asked as the kernel asks it (lib/worktree-hooks.mjs groupHasMembers). */
const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
/** Whether `stderr` holds a JavaScript stack trace. */
const hasStack = (stderr) => /^\s+at .*\(.*:\d+:\d+\)/m.test(stderr) || stderr.includes("node:internal");

/** A tree as `{ <relative path>: what it is }`: mode and bytes of a file, target of a link, mode of a
 *  directory. Two snapshots that are deep-equal are the same tree, byte for byte. */
function snapshot(root) {
  const seen = {};
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), at = rel ? `${rel}/${name}` : name;
      const st = lstatSync(path);
      const mode = (st.mode & 0o7777).toString(8);
      if (st.isSymbolicLink()) seen[at] = `link ${readlinkSync(path)}`;
      else if (st.isDirectory()) { seen[`${at}/`] = `directory ${mode}`; walk(path, at); }
      else seen[at] = `file ${mode} ${readFileSync(path).toString("base64")}`;
    }
  };
  walk(root, "");
  return seen;
}

/** A capability whose retire hook records its run, outside every home, in
 *  `<agents root>/retire-hook-ran-<instance>`: one file per instance, so a test can tell whose hook ran. */
const recordingHook = {
  manifest: { hooks: { retire: "hook.mjs" } },
  files: { "hook.mjs": `import { appendFileSync } from "node:fs";\nimport { join } from "node:path";\nappendFileSync(join(process.env.OATS_ROOT, "retire-hook-ran-" + process.env.OATS_INSTANCE), "ran\\n");\n` },
};
const RECORDING = { souls: { dev: { soul: { capabilities: { "test.recording": { from: "here" } } } } }, capabilities: { "test.recording": recordingHook } };

/** What the tests read of a deployment, whatever its soul: a spawn (no launch, the fixture's inert
 *  harness), the hook's record, and what a retire leaves beside the homes. */
function reads(fx) {
  const r = {
    fx,
    /** A spawned instance of `dev` → its home. The harness a spawn finds is the fixture's inert one. */
    spawn: async (name, opts = {}) => {
      const saved = process.env.PATH;
      process.env.PATH = fx.env.PATH;
      try { return (await fx.spawn("dev", { name, ...opts })).home; } finally { process.env.PATH = saved; }
    },
    hookLog: (name) => join(fx.root, `retire-hook-ran-${name}`),
    hookRuns: (name) => (existsSync(r.hookLog(name)) ? readFileSync(r.hookLog(name), "utf8").split("\n").filter(Boolean).length : 0),
    claimFiles: (home) => { const dir = dirname(claimOf(home)); return existsSync(dir) ? readdirSync(dir) : []; },
    recoveries: (home) => { const dir = join(dirname(home), ".oats-retirement", "recovery"); return existsSync(dir) ? readdirSync(dir) : []; },
    receipts: (home) => readdirSync(dirname(home)).filter((entry) => entry.startsWith(".oats-retire-receipt.") || entry.startsWith(".oats-stop-receipt.")),
  };
  return r;
}
/** The one error envelope of a refused command (`{ status|code, stdout, stderr }`): exit 1, one line on stdout. */
function refusal(result, what) {
  const status = result.status ?? result.code;
  const said = `${what}\n  exit status: ${status}\n  stdout: ${result.stdout}\n  stderr: ${result.stderr}`;
  assert.equal(status, 1, said);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1, `exactly one envelope on stdout: ${said}`);
  const envelope = JSON.parse(lines[0]);
  assert.deepEqual({ schemaVersion: envelope.schemaVersion, ok: envelope.ok }, { schemaVersion: 1, ok: false }, said);
  return envelope.error;
}

// ---- 1. a guarded retire whose extra worktree changes after its hooks ran (awebai/oats#895) ----

test("a guarded retire whose extra worktree is dirtied after its retire hooks ran answers E_WORK_PRESERVATION_FAILED, not E_PLAN_STALE: reached.phase is after-hooks, no plan rides the answer, the home and the tree are kept, and the fresh plan then applies", async (t) => {
  const fx = v2Deployment({ t, souls: { dev: { soul: { work: "worktree", capabilities: { "test.recording": { from: "here" } } } } }, capabilities: RECORDING.capabilities });
  const w = reads(fx);
  const name = "late-tree";
  const home = await w.spawn(name, { work: "worktree" });
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env: fx.env, stdio: ["ignore", "pipe", "pipe"] }).trim();
  // An extra tree made the way the work-mode briefing says: detached, fetched inside it, switched to its branch.
  const tree = join(home, ".work-extra");
  git(fx.member, "worktree", "add", "-q", "--detach", tree);
  git(tree, "fetch", "-q", "--refmap=", "origin", "main");
  git(tree, "switch", "-q", "-c", "agents/late-tree-extra", "FETCH_HEAD");
  const registered = (path) => git(fx.member, "worktree", "list", "--porcelain").split("\n").includes(`worktree ${path}`);
  // A file of the home that each inspection of the retire reads once: where the retire is held.
  const held = join(home, "notes", "held.md");
  mkdirSync(dirname(held));
  writeFileSync(held, "each inspection reads this entry\n");

  const planOf = () => { const r = fx.cli(["retire", name, "--plan", "--json"]); assert.equal(r.status, 0, r.stdout + r.stderr); return r.json().result; };
  const shown = planOf();
  assert.deepEqual(shown.facts.extraWorktrees.map((row) => [row.path, row.disposition]), [[tree, "remove"]], "fixture premise: the plan that is applied lists the tree as clean, to be removed");

  // Held at the first read of that entry once the retire hook has left its record: the inspection
  // after the hooks, before the step that deals with the extra trees.
  const run = startGated([CLI, "retire", name, "--plan-revision", shown.planRevision, "--idempotency-key", "k1", "--json"],
    { cwd: fx.dep, env: fx.env, gateDir: join(fx.base, "gates"), gates: [{ name: "after-hooks", fn: "lstatSync", path: held, armed: w.hookLog(name), waitMs: HOLD_MS }] });
  let result;
  try {
    await run.waitGate("after-hooks");
    assert.equal(run.child.exitCode, null, "the retire is held, not finished");
    assert.equal(w.hookRuns(name), 1, "the retire is held after its retire hook ran");
    assert.equal(git(tree, "status", "--porcelain", "--ignored"), "", "fixture premise: the tree is still clean, as the plan the retire revalidated said");
    writeFileSync(join(tree, "late.txt"), "written after the retire hooks ran\n"); // the second writer
    run.release("after-hooks");
    result = await run.done;
    assert.deepEqual(result.timedOut, [], "the gate was released in time: the retire did not go on by itself");
  } finally { await run.finish(); }

  const error = refusal(result, "the guarded retire whose extra tree changed after its hooks");
  assert.equal(error.code, "E_WORK_PRESERVATION_FAILED", `never E_PLAN_STALE, which says that nothing happened: ${JSON.stringify(error)}`);
  assert.equal(error.message, `${name}: the home's extra worktrees changed since the retire plan was shown, so none of them was moved or removed. The retire hooks have run; the home and its work are kept. Review the fresh plan (\`oats retire ${name} --plan\`) and apply it again.`);
  // No `details.plan`: that is what an E_PLAN_STALE carries, and a client that finds one applies it.
  assert.deepEqual(Object.keys(error.details), ["reached"], JSON.stringify(error.details));
  const [recovery] = w.recoveries(home);
  assert.deepEqual(w.recoveries(home).length, 1, "the home had changed since its spawn (notes/held.md): one recovery was written before the hooks");
  const recoveryPath = join(dirname(home), ".oats-retirement", "recovery", recovery);
  // The recovery was concluded by the inspection after the hooks, before the step that refused.
  assert.deepEqual(error.details.reached, { phase: "after-hooks", sessionStopAttempted: false, hooksStarted: true, home: "kept", recovery: { path: recoveryPath, phase: "complete" } });
  assert.equal(readJson(join(recoveryPath, "recovery.json")).phase, "complete", "its manifest on disk holds the phase the answer names");
  assert.equal(result.stderr, "", "a refusal with a code of its own is no defect: nothing on stderr, and no stack");

  // What the answer says is true on disk.
  assert.equal(existsSync(join(home, "instance.json")), true, "the home is kept");
  assert.ok(existsSync(tree) && registered(tree), "the tree is kept, and is still a worktree of the clone");
  assert.equal(readFileSync(join(tree, "late.txt"), "utf8"), "written after the retire hooks ran\n", "with what was written into it");
  assert.ok(lstatSync(join(home, "work")).isDirectory(), "work/ is untouched");
  assert.equal(w.hookRuns(name), 1, "the retire hook ran, once");
  assert.deepEqual(w.receipts(home), [], "no receipt was recorded under the key");
  assert.deepEqual(w.claimFiles(home), [], "no claim is left");

  // The way out the answer names: the fresh plan re-homes the tree, and applies.
  const fresh = planOf();
  assert.notEqual(fresh.planRevision, shown.planRevision);
  const [row] = fresh.facts.extraWorktrees;
  assert.equal(row.disposition, "retain", JSON.stringify(row));
  const again = fx.cli(["retire", name, "--plan-revision", fresh.planRevision, "--idempotency-key", "k2", "--json"]);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  const receipt = JSON.parse(again.stdout);
  assert.equal(receipt.retired, name);
  assert.deepEqual(receipt.extraWorktrees.map((r) => [r.path, r.outcome, r.movedTo]), [[tree, "retained", row.movedTo]]);
  assert.equal(readFileSync(join(row.movedTo, "late.txt"), "utf8"), "written after the retire hooks ran\n", "the tree was re-homed with its bytes");
  assert.equal(existsSync(home), false, "the home is removed");
});

// ---- 2. the hook group of an interrupted spawn that survives SIGKILL ----
//
// No test of this repository reached "survived" through a retire, and the kernel has no seam for
// it (lib/worktree-hooks.mjs terminateRecordedGroup signals with process.kill and asks with
// kill(-pgid, 0)). No process survives SIGKILL. What the kernel's question can still answer "yes"
// to afterwards is a group whose leader has exited and has not been reaped by its parent: on Linux
// that zombie is still a member of its group (test/process-zombie.test.mjs reports the same). So
// the group the marker names is led by a child of THIS process, which reaps its children from its
// event loop only: the test stays synchronous from the retire to its assertions, and the leader,
// ended by the retire's SIGTERM, stays in its group until the test awaits again. The retire is the
// real CLI. On a host where such a group reads as empty, nothing can stand in for a survivor, and
// the test is skipped saying so.

/** The worktree hook of the fixture: it says which process it is, then sleeps for a minute. */
const SLEEPING_HOOK = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync(join(process.env.OATS_ROOT, "hook-sleeping"), String(process.pid));
await new Promise((resolve) => setTimeout(resolve, 60000));
`;
const QUARANTINE_HOOKS = {
  "hook.mjs": SLEEPING_HOOK,
  "spawn.mjs": `console.log(JSON.stringify({ meta: { made: true } }));\n`,
  "retire.mjs": `import { appendFileSync } from "node:fs"; import { join } from "node:path"; appendFileSync(join(process.env.OATS_ROOT, "retire-ran"), process.env.OATS_INSTANCE + "\\n"); console.log(JSON.stringify({ meta: { retired: true } }));\n`,
};

test("a retire that signals the worktree hook group an interrupted spawn left, and sees it survive SIGTERM and SIGKILL, answers E_RUNTIME_QUIESCE_FAILED, not E_LIFECYCLE_BUSY: reached.phase is before-hooks, the home and its marker are kept; once the group is gone the same retire completes", async (t) => {
  // The host's premise, asked before anything is built: an exited leader nobody reaped is still in its group.
  const probe = spawnChild("sleep", ["600"], { detached: true, stdio: "ignore" });
  const probeState = zombieSync(probe.pid);
  const zombieIsAMember = groupAlive(probe.pid);
  await killAndReap(probe.pid);
  t.diagnostic(`a group whose leader was killed and not reaped (state ${JSON.stringify(probeState)}): kill(-pgid, 0) ${zombieIsAMember ? "still succeeds" : "finds no group"}`);
  if (!zombieIsAMember) { t.skip("on this host a group whose only member is an unreaped leader reads as empty: nothing can stand in for a group that survives SIGKILL, and the kernel has no seam for it"); return; }

  const fx = v2Deployment({ t, souls: { dev: { soul: { work: "worktree", capabilities: { "test.setup": { from: "here" } } } } },
    capabilities: { "test.setup": { manifest: { hooks: { worktree: { command: "hook.mjs", required: true }, spawn: "spawn.mjs", retire: "retire.mjs" } }, files: QUARANTINE_HOOKS } } });
  const w = reads(fx);
  const name = "survivor", home = join(fx.root, "dev", "instances", name);
  const markerPath = join(home, ".oats-rollback-incomplete.json");

  // A spawn killed while its worktree hook runs: the home is left with the marker of a spawn in progress.
  const spawning = spawnChild(process.execPath, [CLI, "spawn", "dev", "--name", name, "--work", "worktree", "--no-launch", "--json"], { cwd: fx.dep, env: fx.env, stdio: "ignore" });
  const exited = new Promise((resolve) => spawning.on("close", resolve));
  const sleeping = join(fx.root, "hook-sleeping");
  await waitUntil(() => existsSync(sleeping) && existsSync(markerPath), "the spawn to be inside its worktree hook", 60000);
  const hook = Number(readFileSync(sleeping, "utf8"));
  spawning.kill("SIGKILL");
  await exited;
  const marker = readJson(markerPath);
  const orphans = marker.inProgress.hookPgid;
  // The groups this test started and has not yet seen gone: ended before the fixture's leftover
  // check, whatever a failed assertion leaves. One that was seen gone is never signalled again
  // (its id may be another group's by then).
  const groups = new Set([orphans]);
  fx.beforeCleanup(() => { for (const group of groups) { try { process.kill(-group, "SIGKILL"); } catch { /* gone */ } } });
  assert.equal(marker.inProgress.pid, spawning.pid, "fixture premise: the marker names the spawn that was killed");
  assert.equal(alive(hook), true, "fixture premise: the hook outlived its parent");
  // That group is ended here, by hand: it is not this process's child, so it could not be left unreaped.
  process.kill(-orphans, "SIGKILL");
  await waitUntil(() => !groupAlive(orphans), "the spawn's own hook group to be gone");
  groups.delete(orphans);

  // The group the marker now names: led by a child of this process, alive, with its start recorded.
  const leader = spawnChild("sleep", ["600"], { detached: true, stdio: "ignore" });
  const pgid = leader.pid;
  groups.add(pgid);
  const hookStart = processStartToken(pgid);
  assert.equal(typeof hookStart, "string", "fixture premise: the start of the group's leader can be read");
  writeFileSync(markerPath, JSON.stringify({ ...marker, inProgress: { ...marker.inProgress, hookPgid: pgid, hookStart } }, null, 2) + "\n");
  const before = snapshot(home);

  // Nothing is awaited from here to the assertion on the leader's state: this process reaps its
  // children from its event loop, so the leader the retire ends stays in its group meanwhile.
  const r = fx.cli(["retire", name, "--json"]);
  const state = hostProcessState(pgid);
  const stillAGroup = groupAlive(pgid);
  t.diagnostic(`after the retire: the leader's state is ${JSON.stringify(state)}, and kill(-pgid, 0) ${stillAGroup ? "still succeeds" : "finds no group"}`);
  assert.match(String(state), /^Z/, "the retire signalled the group: its leader has exited, and nobody reaped it");
  assert.equal(stillAGroup, true, "the group still has a member when the retire has returned: what the retire met is a group that outlived both signals");

  const error = refusal(r, "the retire of a home whose interrupted spawn left a hook group that survives SIGKILL");
  assert.equal(error.code, "E_RUNTIME_QUIESCE_FAILED", `never E_LIFECYCLE_BUSY, which says that nothing happened: ${JSON.stringify(error)}`);
  assert.equal(error.message, `${name}: the worktree hook process group ${pgid} that an interrupted spawn left could not be ended (it survived SIGTERM and SIGKILL, and still runs); no session was stopped, no retire hook was run and nothing was removed. End that group by hand (kill -KILL -- -${pgid}), then retire again.`);
  // Signals were sent, so the phase is no longer "before-effects"; nothing else was reached.
  assert.deepEqual(error.details, { reached: { phase: "before-hooks", sessionStopAttempted: false, hooksStarted: false, home: "kept", recovery: null } });
  assert.equal(hasStack(r.stderr), false, `a refusal with a code of its own is no defect: no stack\n${r.stderr}`);
  assert.deepEqual(snapshot(home), before, "the home is byte for byte what it was, its marker included");
  assert.equal(existsSync(join(fx.root, "retire-ran")), false, "no retire hook ran");
  assert.deepEqual(w.recoveries(home), [], "no recovery was written");
  assert.deepEqual(w.claimFiles(home), [], "no claim is left");

  // The way out the answer names: once the group is gone, the same retire completes the rollback.
  await killAndReap(pgid);
  groups.delete(pgid);
  assert.equal(groupAlive(pgid), false, "the group is gone once its leader is reaped");
  const again = fx.cli(["retire", name, "--json"]);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(JSON.parse(again.stdout).retired, name);
  assert.equal(existsSync(home), false, "the home is removed");
  assert.match(readFileSync(join(fx.root, "retire-ran"), "utf8"), new RegExp(`^${name}$`, "m"), "the retire hook compensated");
});

// ---- 3. the net: a listed code after the first effect ----

/** A refusal on demand: a preload that makes ONE call of one `node:fs` sync function, on one path,
 *  throw an error with a kernel code. The call is named by OATS_TEST_THROW (JSON: `{ fn, path,
 *  armed?, code, message }`; `armed`: only once this file exists), which the preload removes from
 *  the environment: what the kernel hands its hooks is what it would hand them without it. Every
 *  other call is the original. An error with a kernel code keeps its code through the retire's own
 *  catch, so this stands for a refusal raised at a place nobody thought of. */
function throwingPreload(fx) {
  const preload = join(fx.base, "throwing-refusal.mjs");
  writeFileSync(preload, `// Written by test/retire-late-answers.test.mjs: a refusal with a kernel code, raised where the test says.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const spec = JSON.parse(process.env.OATS_TEST_THROW);
delete process.env.OATS_TEST_THROW;
const exists = fs.existsSync.bind(fs), original = fs[spec.fn];
let thrown = false;
fs[spec.fn] = function (path, ...rest) {
  if (!thrown && (Buffer.isBuffer(path) ? path.toString() : String(path)) === spec.path && (spec.armed === undefined || exists(spec.armed))) {
    thrown = true;
    throw Object.assign(new Error(spec.message), { code: spec.code });
  }
  return original.call(this, path, ...rest);
};
syncBuiltinESMExports();
`);
  // As fx.cli runs the CLI (test/helpers/v2-deployment.mjs), with the preload before it.
  return (args, spec) => spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, CLI, ...args], { cwd: fx.dep, env: { ...fx.env, OATS_TEST_THROW: JSON.stringify(spec) }, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}
const AFTER_HOOKS = { phase: "after-hooks", sessionStopAttempted: false, hooksStarted: true, home: "kept", recovery: null };
const BEFORE_EFFECTS = { phase: "before-effects", sessionStopAttempted: false, hooksStarted: false, home: "kept", recovery: null };

test("a code that says nothing happened, raised after a retire's hooks ran, is answered E_LIFECYCLE_FAILED in JSON mode and in text mode: the message names the code it had and the phase, details.cause is { name: LateRefusal }, and the stack is on stderr; the same error before any effect keeps its code", async (t) => {
  const fx = v2Deployment({ t, ...RECORDING });
  const w = reads(fx);
  const oats = throwingPreload(fx);
  // The retire's scan of the agent's instances for lineage to repair (lib/core.mjs retireSteps): a
  // read of this directory that no step wraps, and the first one once the retire hook has run.
  const instances = join(fx.root, "dev", "instances");
  const late = (name, code) => ({ fn: "readdirSync", path: instances, armed: w.hookLog(name), code, message: `a refusal raised where nobody thought of (${code}); nothing was done` });
  const lateMessage = (spec) => `oats retire answered ${spec.code} after its first effect (phase after-hooks): ${spec.message}`;
  const stackOf = (spec) => new RegExp(`^LateRefusal: oats retire answered ${spec.code} after its first effect \\(phase after-hooks\\): .*\\n(?: {4}at .+\\n)+`, "m");

  // JSON mode: one envelope, and the stack of the defect on stderr.
  const jsonHome = await w.spawn("late-json");
  assert.equal(dirname(jsonHome), instances, "fixture premise: where the homes of the agent are");
  const jsonSpec = late("late-json", "E_PLAN_STALE");
  const json = oats(["retire", "late-json", "--json"], jsonSpec);
  const said = `\`oats retire late-json --json\` with a refusal raised after its hooks\n  exit status: ${json.status}\n  stdout: ${json.stdout}\n  stderr: ${json.stderr}`;
  assert.equal(json.signal, null, said);
  const error = refusal(json, said);
  assert.equal(w.hookRuns("late-json"), 1, `fixture premise: the refusal was raised after the retire hook ran: ${said}`);
  assert.equal(error.code, "E_LIFECYCLE_FAILED", `never the code that says nothing happened: ${said}`);
  assert.equal(error.message, lateMessage(jsonSpec), said);
  assert.deepEqual(error.details.cause, { name: "LateRefusal" }, said);
  assert.deepEqual(error.details.reached, AFTER_HOOKS, said);
  assert.deepEqual(Object.keys(error.details).sort(), ["cause", "reached"], said);
  assert.match(json.stderr, stackOf(jsonSpec), `the stack of the defect is on stderr, with the code it had: ${said}`);
  // The envelope carries no stack text: no frame, no file of the kernel or of the preload, no `stack` key.
  assert.doesNotMatch(json.stdout, /\bat .*:\d+:\d+|throwing-refusal|core\.mjs|errors\.mjs|"stack"/, `the envelope carries no stack: ${said}`);
  assert.equal(existsSync(join(jsonHome, "instance.json")), true, "the home is kept, as `reached` says");
  assert.deepEqual(w.claimFiles(jsonHome), [], "no claim is left");
  // The preload is the whole defect: without it the same retire retires the same home.
  const plain = fx.cli(["retire", "late-json", "--json"]);
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);
  assert.equal(JSON.parse(plain.stdout).retired, "late-json");

  // Text mode, and another code of the list: nothing on stdout; the stack and the same message on stderr.
  const textHome = await w.spawn("late-text");
  const textSpec = late("late-text", "E_BAD_ARGS");
  const text = oats(["retire", "late-text"], textSpec);
  const saidText = `\`oats retire late-text\` with a refusal raised after its hooks\n  exit status: ${text.status}\n  stdout: ${text.stdout}\n  stderr: ${text.stderr}`;
  assert.equal(text.signal, null, saidText);
  assert.equal(text.status, 1, saidText);
  assert.equal(text.stdout, "", `nothing on stdout: ${saidText}`);
  assert.equal(w.hookRuns("late-text"), 1, `fixture premise: the refusal was raised after the retire hook ran: ${saidText}`);
  assert.match(text.stderr, stackOf(textSpec), `the stack of the defect is on stderr: ${saidText}`);
  assert.ok(text.stderr.split("\n").includes(`oats: ${lateMessage(textSpec)}`), `the message is a line of stderr, as \`oats: oats retire answered …\`: ${saidText}`);
  assert.equal(existsSync(join(textHome, "instance.json")), true, "the home is kept");

  // The control: the same error raised BEFORE any effect (the first inspection's read of an entry
  // of the home) is an ordinary refusal. It keeps its code, and nothing is reported as a defect.
  const earlyHome = await w.spawn("early");
  const entry = join(earlyHome, "notes", "read.md");
  mkdirSync(dirname(entry));
  writeFileSync(entry, "the first inspection reads this entry\n");
  const before = snapshot(earlyHome);
  const earlySpec = { fn: "lstatSync", path: entry, code: "E_PLAN_STALE", message: "a refusal raised where nobody thought of (E_PLAN_STALE); nothing was done" };
  const early = oats(["retire", "early", "--json"], earlySpec);
  const saidEarly = `\`oats retire early --json\` with the same refusal raised before any effect\n  exit status: ${early.status}\n  stdout: ${early.stdout}\n  stderr: ${early.stderr}`;
  const kept = refusal(early, saidEarly);
  assert.equal(kept.code, "E_PLAN_STALE", `before any effect the code is the error's own: ${saidEarly}`);
  assert.ok(kept.message.startsWith(earlySpec.message), saidEarly);
  assert.doesNotMatch(kept.message, /after its first effect/, saidEarly);
  assert.deepEqual(kept.details, { reached: BEFORE_EFFECTS }, saidEarly);
  assert.equal(hasStack(early.stderr), false, `an ordinary refusal prints no stack: ${saidEarly}`);
  assert.equal(w.hookRuns("early"), 0, "no retire hook ran");
  assert.deepEqual(snapshot(earlyHome), before, "the home is byte for byte what it was");
});

test("afterFirstEffect, the stop's side: every code `oats instance stop` answers only before any effect becomes E_LIFECYCLE_FAILED with its details and cause { name: LateRefusal }; a code that is not listed, and an unknown verb, give the error back as it is", () => {
  const { afterFirstEffect, BEFORE_EFFECT_CODES, oatsError } = errors;
  const point = "a target's stop had begun";
  const listed = BEFORE_EFFECT_CODES["instance stop"];
  assert.deepEqual(listed, ["E_BAD_ARGS", "E_USAGE", "E_PLAN_STALE", "E_INSTANCE_RETIRING", "E_LIFECYCLE_BUSY", "E_HOME_MISMATCH", "E_HOME_NOT_OWNED", "E_SESSION_UNKNOWN",
    "E_AMBIGUOUS_INSTANCE", "E_UNIDENTIFIED_INSTANCE_HOME", "E_REMOTE_INCOMPATIBLE", "E_AMBIGUOUS", "E_SNAPSHOT_UNKNOWN"], "the codes a stop answers only before any effect");
  for (const code of listed) {
    const details = { plan: { planRevision: "r1" }, lock: "/claims/x.lock" };
    const e = Object.assign(oatsError(code, `${code} said here; nothing was stopped`), { details });
    const answered = afterFirstEffect(e, "instance stop", point);
    assert.notEqual(answered, e, code);
    assert.equal(answered.code, "E_LIFECYCLE_FAILED", code);
    assert.equal(answered.message, `oats instance stop answered ${code} after its first effect (${point}): ${code} said here; nothing was stopped`, code);
    assert.deepEqual(answered.details, { ...details, cause: { name: "LateRefusal" } }, `${code}: the error's own details are kept, beside the cause`);
    assert.equal(answered.cause?.name, "LateRefusal", `${code}: the defect is the answer's cause, for whoever prints its stack`);
    assert.equal(answered.cause.message, answered.message, code);
    assert.deepEqual(details, { plan: { planRevision: "r1" }, lock: "/claims/x.lock" }, `${code}: the error's details were not written to`);
    // An error without details gets the cause alone.
    assert.deepEqual(afterFirstEffect(oatsError(code, "said"), "instance stop", point).details, { cause: { name: "LateRefusal" } }, code);
  }
  // The codes a stop answers once something happened are not the net's: the same object comes back.
  for (const code of ["E_SESSION_STOP_FAILED", "E_CHILDREN_RUNNING", "E_WORK_PRESERVATION_FAILED", "E_RUNTIME_QUIESCE_FAILED", "E_LIFECYCLE_FAILED"]) {
    assert.equal(listed.includes(code), false, `${code} is not a code that says nothing happened`);
    const e = Object.assign(oatsError(code, "said"), { details: { a: 1 } });
    assert.equal(afterFirstEffect(e, "instance stop", point), e, code);
    assert.deepEqual({ code: e.code, message: e.message, details: e.details }, { code, message: "said", details: { a: 1 } }, `${code}: untouched`);
  }
  // An error that is not the kernel's has no listed code either.
  const system = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
  assert.equal(afterFirstEffect(system, "instance stop", point), system);
  // A verb without a list has no net: its errors are its own.
  for (const verb of ["worktree add", "session start", undefined]) {
    const e = oatsError("E_PLAN_STALE", "said");
    assert.equal(afterFirstEffect(e, verb, point), e, String(verb));
    assert.deepEqual({ code: e.code, message: e.message, details: e.details }, { code: "E_PLAN_STALE", message: "said", details: undefined }, String(verb));
  }
});

// ---- 4. E_UNIDENTIFIED_INSTANCE_HOME is before any effect, verb by verb ----

/** A deployment with one instance whose stop plan and retire plan were made, and whose record was
 *  then cut off: it is there, and it is no JSON object. `refused(argv, what)` runs one command and
 *  holds it to the refusal and to a home that is byte for byte what it was. */
async function instanceWithACutOffRecord(t, name) {
  const fx = v2Deployment({ t, ...RECORDING });
  const w = reads(fx);
  const home = await w.spawn(name);
  const planned = (argv) => { const r = fx.cli(argv); assert.equal(r.status, 0, `fixture premise: a plan of ${name} while its record is whole\n${r.stdout}\n${r.stderr}`); return r.json().result.planRevision; };
  const stopRevision = planned(["instance", "stop", name, "--plan", "--json"]);
  const retireRevision = planned(["retire", name, "--plan", "--json"]);
  const record = join(home, "instance.json");
  writeFileSync(record, readFileSync(record, "utf8").slice(0, 40));
  assert.throws(() => JSON.parse(readFileSync(record, "utf8")), SyntaxError, "fixture premise: the record is cut off");
  const before = snapshot(home);
  const refused = (argv, what) => {
    const r = fx.cli(argv);
    const said = `\`oats ${argv.join(" ")}\` (${what}) over a record that is cut off`;
    const error = refusal(r, said);
    assert.equal(error.code, "E_UNIDENTIFIED_INSTANCE_HOME", `${said}: ${JSON.stringify(error)}`);
    assert.ok(error.message.startsWith(`${record} cannot be read (`) && error.message.includes("; nothing was done. "), `${said}: ${error.message}`);
    assert.equal(hasStack(r.stderr), false, `${said}: no stack\n${r.stderr}`);
    // "Nothing was done", on disk: every file's mode and bytes, every link's target, every directory's mode.
    assert.deepEqual(snapshot(home), before, `${said}: the home is byte for byte what it was`);
    assert.deepEqual(w.claimFiles(home), [], `${said}: no claim file is left`);
    assert.deepEqual(w.recoveries(home), [], `${said}: no recovery copy, and no staging of one, was left`);
    assert.deepEqual(w.receipts(home), [], `${said}: no receipt was recorded`);
    assert.equal(w.hookRuns(name), 0, `${said}: no retire hook ran`);
    return error;
  };
  return { fx, home, stopRevision, retireRevision, refused };
}

test("oats instance stop over a home whose record is cut off answers E_UNIDENTIFIED_INSTANCE_HOME before any effect, as a plan and as an apply of a plan made before: the home is byte-identical after each, and no claim is left", async (t) => {
  const name = "cut-stop";
  const i = await instanceWithACutOffRecord(t, name);
  i.refused(["instance", "stop", name, "--plan", "--json"], "the plan");
  i.refused(["instance", "stop", name, "--apply", "--plan-revision", i.stopRevision, "--idempotency-key", "k1", "--json"], "an apply of the plan made before the record was cut off");
  i.refused(["instance", "stop", name, "--apply", "--plan-revision", i.stopRevision, "--idempotency-key", "k1", "--json"], "the same apply again: the key was not used");
});

test("oats retire over a home whose record is cut off answers E_UNIDENTIFIED_INSTANCE_HOME before any effect, plain, with --force and guarded by a plan made before: the home is byte-identical after each, and no claim is left", async (t) => {
  const name = "cut-retire";
  const i = await instanceWithACutOffRecord(t, name);
  i.refused(["retire", name, "--json"], "plain");
  i.refused(["retire", name, "--force", "--json"], "--force");
  i.refused(["retire", name, "--plan-revision", i.retireRevision, "--idempotency-key", "k1", "--json"], "guarded, the revision of the plan made before the record was cut off");
  i.refused(["retire", name, "--plan", "--json"], "the plan");
});
