// One retire per instance at a time (awebai/oats#863). A retire holds its home's claim
// (<instances>/.oats-retirement/claims/<name>.lock, lib/claim.mjs) from the moment the home is
// resolved; any other retire of that home is refused as E_LIFECYCLE_BUSY before it stops, copies or
// runs anything. Every such refusal says who holds the home: `details.action` is the holder's verb
// (`oats instance stop` takes the same claim) and `details.holder` whether a command is known to
// run ("running"), cannot be read ("unknown") or does not ("none": the message names the step that
// ends it). No outcome here rests on a sleep or on which process is faster: the fixture's
// retire hook says when it has been entered and then waits for a gate file, so "the first retire is
// in flight" is established before the second one starts.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn as spawnChild, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import { deferredRetireResultPath, retireInstance, retirePendingMarkerPath } from "../lib/core.mjs";
import { readEvents } from "../lib/instance-events.mjs";
import { processStartToken } from "../lib/worktree-hooks.mjs";
import { CLI, v2Deployment, writeFixtureExecutable } from "./helpers/v2-deployment.mjs";
import { hostProcessState, killAndReap, waitUntil, zombieSync } from "./helpers/host-fixture.mjs";

const CORE = pathToFileURL(new URL("../lib/core.mjs", import.meta.url).pathname).href;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const kill = (pid) => { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } };
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const NONCE = "a".repeat(32);
/** A plan revision no plan has: a guarded apply with it is stale. */
const STALE = "0".repeat(24);
const hasTmux = !spawnSync("tmux", ["-V"], { stdio: "ignore" }).error;
/** A real pid whose process has exited and been reaped. */
const exitedPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

/** Every entry of `dir`, with what a change to it would change: its type, mode, size, mtime and
 *  (a file's) bytes or (a link's) target. */
function digest(dir) {
  const rows = [];
  const walk = (abs, rel) => {
    const st = lstatSync(abs);
    const kind = st.isDirectory() ? "dir" : st.isSymbolicLink() ? "link" : "file";
    rows.push([rel, kind, st.mode, kind === "dir" ? 0 : st.size, st.mtimeMs,
      kind === "file" ? createHash("sha256").update(readFileSync(abs)).digest("hex") : kind === "link" ? readlinkSync(abs) : ""].join(" "));
    if (kind === "dir") for (const name of readdirSync(abs).sort()) walk(join(abs, name), join(rel, name));
  };
  walk(dir, ".");
  return rows.join("\n");
}

/** A deployment whose soul `worker` works in a directory and has a capability whose retire hook
 *  appends `<pid> entered` to a log outside the home, then waits for the gate file (90 s at most,
 *  under the 120 s a hook gets). Its spawn hook leaves bytes in work/, so a retire has something to
 *  copy to recovery. Every process a test starts is ended before the fixture's leftover check. */
function fixture(t) {
  const fx = v2Deployment({ t,
    souls: { worker: { soul: { work: "directory", capabilities: { "example.worker": { from: "here" } } }, agents: "# Worker\n" } },
    capabilities: { "example.worker": { manifest: { description: "fixture", hooks: { spawn: "spawn.mjs", retire: "retire.mjs" } }, files: { "spawn.mjs": "console.log('{}')\n", "retire.mjs": "console.log('{}')\n" } } },
  });
  const runs = join(fx.base, "hook-runs.log"), gate = join(fx.base, "release"), fails = join(fx.base, "hook-fails");
  fx.commit({
    "capabilities/example.worker/spawn.mjs": `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.OATS_INSTANCE_HOME + '/work/from-hook.txt', 'spawn bytes');
console.log(JSON.stringify({ meta: { made: true } }));\n`,
    "capabilities/example.worker/retire.mjs": `import { appendFileSync, existsSync } from 'node:fs';
appendFileSync(${JSON.stringify(runs)}, process.pid + ' entered\\n');
const end = Date.now() + 90000;
while (!existsSync(${JSON.stringify(gate)}) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
if (existsSync(${JSON.stringify(fails)})) { console.log(JSON.stringify({ meta: { retired: false, reason: 'the fixture refuses' } })); process.exit(1); }
console.log(JSON.stringify({ meta: { retired: true } }));\n`,
  });
  const hookPids = () => existsSync(runs) ? readFileSync(runs, "utf8").split("\n").filter((l) => l.endsWith(" entered")).map((l) => Number(l.split(" ")[0])) : [];
  const started = [];
  /** A child process → { pid, done: Promise<{ code, out, err }>, ended() }. */
  const start = (argv, env = {}) => {
    const c = spawnChild(process.execPath, argv, { cwd: fx.dep, env: { ...fx.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    started.push(c.pid);
    let out = "", err = "", ended = false;
    c.stdout.on("data", (d) => { out += d; }); c.stderr.on("data", (d) => { err += d; });
    const done = new Promise((res) => c.on("close", (code, signal) => { ended = true; res({ code, signal, out, err }); }));
    return { pid: c.pid, done, ended: () => ended };
  };
  const f = {
    fx, gate,
    hookPids, hookRuns: () => hookPids().length,
    open: () => writeFileSync(gate, ""),
    /** From now on the retire hook reports that its cleanup did not finish: the retire keeps the home. */
    failHook: () => writeFileSync(fails, ""),
    passHook: () => rmSync(fails, { force: true }),
    /** A `tmux` that records how it was called and answers nothing, first on the PATH of a retire
     *  given `env`: what that retire asked about any session. A retire lists instances, and reads
     *  a plan, by asking tmux; one that asked nothing read neither. */
    watchedTmux: () => {
      const dir = join(fx.base, `tmux-watched-${started.length}`), log = join(dir, "calls.log");
      mkdirSync(dir);
      writeFileSync(join(dir, "tmux"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nexit 1\n`, { mode: 0o755 });
      return { env: { PATH: `${dir}:${fx.env.PATH}` }, calls: () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [] };
    },
    /** How many `retire-planned` events the workspace log holds for the home. */
    plansRead: (home) => fx.inEnv(() => readEvents(home).events.filter((e) => e.kind === "retire-planned").length),
    /** The revision each of those events carries, in the log's order. */
    planEvents: (home) => fx.inEnv(() => readEvents(home).events.filter((e) => e.kind === "retire-planned").map((e) => e.data.planRevision)),
    /** `oats retire <instance> --json <extra>` as a child process. */
    retire: (instance, extra = [], env) => start([CLI, "retire", instance, "--json", ...extra], env),
    /** A deferred self-retire's completion, as the detached script runs it (delaySec 0). */
    completion: (inst, options) => start(["--input-type=module", "-e", `import { completeDeferredRetirement } from ${JSON.stringify(CORE)};
process.exitCode = completeDeferredRetirement(JSON.parse(process.env.OATS_RETIRE_INTENT), { delaySec: 0 }) ? 0 : 1;`],
    { OATS_RETIRE_INTENT: JSON.stringify(f.intent(inst, options)) }),
    intent: (inst, options = { home: inst.home }) => ({ instance: inst.instance, agent: "worker", root: fx.root, requestedAt: "2026-10-10T00:00:00.000Z", delaySec: 0, options, resultPath: deferredRetireResultPath(inst.home) }),
    planRevision: (instance) => fx.cli(["retire", instance, "--plan", "--json"]).json().result.planRevision,
    track: (pid) => { started.push(pid); return pid; },
    /** An instance launched on the fixture's own tmux server, a sleeping process standing in for
     *  its harness: a retire stops that session before its hooks run. The stand-in is the
     *  fixture's own file, named by its absolute path in a launch configuration, so the launch
     *  finds no harness of the host and needs none. The fixture's cleanup kills the server, and
     *  fails on a process left working in the base. */
    spawnLaunched: () => {
      const executable = join(fx.base, "harness-stand-in");
      writeFixtureExecutable(fx.base, executable, "#!/bin/sh\nexec sleep 600\n");
      const localFile = join(fx.dep, "oats-local.yaml");
      writeFileSync(localFile, YAML.stringify({ ...YAML.parse(readFileSync(localFile, "utf8")), "launch-configs": { "stand-in": { harness: "pi", executable } } }, { lineWidth: 0 }));
      return f.spawn({ launch: true, launchConfig: "stand-in" });
    },
    /** A new `worker` instance, not launched unless asked. The spawn runs in this process, so it
     *  is given the fixture's PATH for its duration: the harness it finds is the fixture's inert
     *  one, never one of the host's (there may be none). */
    spawn: async (opts) => {
      const path = process.env.PATH;
      process.env.PATH = fx.env.PATH;
      try { return await fx.spawn("worker", opts); } finally { process.env.PATH = path; }
    },
  };
  fx.beforeCleanup(() => { f.open(); for (const pid of [...started, ...hookPids()]) kill(pid); });
  return f;
}
const claimsDir = (home) => join(dirname(home), ".oats-retirement", "claims");
const claimOf = (home) => join(claimsDir(home), `${home.split("/").pop()}.lock`);
const claimFiles = (home) => existsSync(claimsDir(home)) ? readdirSync(claimsDir(home)) : [];
const recoveries = (inst) => { const d = join(dirname(inst.home), ".oats-retirement", "recovery"); return existsSync(d) ? readdirSync(d).filter((n) => n.startsWith(`${inst.instance}-`)) : []; };
/** What a retire printed with --json: a refusal's or a replay's envelope, or the receipt itself. */
const envelope = (r) => JSON.parse(r.out.trim());
/** A claim as the protocol writes it, held by `pid` (this process unless given). */
const writeClaim = (home, holder = {}) => {
  mkdirSync(claimsDir(home), { recursive: true });
  writeFileSync(claimOf(home), JSON.stringify({ pid: process.pid, processStart: processStartToken(process.pid), nonce: NONCE, at: "2026-10-10T00:00:00.000Z", ...holder }) + "\n");
};
const waitingForClaim = (home, pid) => claimFiles(home).some((n) => n.startsWith(`${home.split("/").pop()}.lock.tmp-${pid}-`));

/** Start `first` on a new instance and wait until it is inside its retire hook: it holds the claim,
 *  has stopped its session and copied its recovery, and stays there until the gate opens. */
async function inFlight(f, first, spawn = () => f.spawn()) {
  const inst = await spawn();
  const a = await first(inst);
  await waitUntil(() => f.hookRuns() === 1, "the first retire to be inside its retire hook", 60000);
  return { inst, a, lock: claimOf(inst.home), before: digest(inst.home) };
}
/** `r` (the answer of a retire started while `h` was in flight) is the busy refusal that names the
 *  holder, and nothing was done: one hook run, one recovery, the home as it was. */
function assertRefused(f, h, r, what) {
  assert.equal(h.a.ended(), false, `${what}: the first retire is still in flight`);
  assert.equal(r.code, 1, `${what}: exit 1 (${r.out}${r.err})`);
  const e = envelope(r);
  assert.deepEqual({ schemaVersion: e.schemaVersion, ok: e.ok, code: e.error.code }, { schemaVersion: 1, ok: false, code: "E_LIFECYCLE_BUSY" }, what);
  assert.deepEqual(e.error.details, { instance: h.inst.instance, home: h.inst.home, lock: h.lock, pid: h.a.pid, since: readJson(h.lock).at, action: "retire", holder: "running" }, what);
  assert.equal(e.error.message, `a retire of ${h.inst.instance} is already running (pid ${h.a.pid}, since ${e.error.details.since}); nothing was done — wait for it to finish; if it does not end, check that pid by hand, and if it is not an oats retire, remove ${h.lock}, then retry`, what);
  assertUntouched(f, h, what);
  return e;
}
function assertUntouched(f, h, what) {
  assert.equal(f.hookRuns(), 1, `${what}: no second hook run`);
  assert.equal(recoveries(h.inst).length, 1, `${what}: no second recovery`);
  assert.equal(digest(h.inst.home), h.before, `${what}: no file of the home changed`);
  assert.equal(readJson(h.lock).pid, h.a.pid, `${what}: the claim is still the first retire's`);
}
/** Open the gate: the first retire finishes, having done all the work once and left no claim. */
async function finish(f, h) {
  f.open();
  const r = await h.a.done;
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.equal(existsSync(h.inst.home), false, "the home is removed");
  assert.equal(f.hookRuns(), 1, "one hook run in total");
  assert.equal(recoveries(h.inst).length, 1, "one recovery in total");
  assert.deepEqual(claimFiles(h.inst.home), [], "no claim is left");
  return r;
}

test("plain x plain: the second retire is refused while the first is in its hook; afterwards a retire answers E_SESSION_UNKNOWN", async (t) => {
  const f = fixture(t);
  const h = await inFlight(f, (inst) => f.retire(inst.instance));
  assertRefused(f, h, await f.retire(h.inst.instance).done, "plain");
  // What a retire acts on is read under the claim: one that never held it listed no instance.
  const tmux = f.watchedTmux();
  assertRefused(f, h, await f.retire(h.inst.instance, [], tmux.env).done, "plain, its tmux watched");
  assert.deepEqual(tmux.calls(), [], "the refused retire asked tmux nothing: it did not read its children");
  const first = envelope(await finish(f, h));
  assert.equal(first.retired, h.inst.instance);
  const after = await f.retire(h.inst.instance).done;
  assert.equal(after.code, 1);
  assert.equal(envelope(after).error.code, "E_SESSION_UNKNOWN");
  assert.deepEqual(claimFiles(h.inst.home), [], "a retire of a retired instance leaves no claim either");
});

test("every other form of retire is refused while one is in flight: --force, text mode, --self, --self --keep-dir, recorded children", async (t) => {
  const f = fixture(t);
  const h = await inFlight(f, (inst) => f.retire(inst.instance));
  const name = h.inst.instance;
  assertRefused(f, h, await f.retire(name, ["--force"]).done, "--force");
  assertRefused(f, h, await f.retire(name, ["--plan-revision", STALE, "--idempotency-key", "key-stale"]).done, "guarded, a stale revision");
  assertRefused(f, h, await f.retire(name, ["--home", h.inst.home, "--discard-worktree", "--keep-dir"]).done, "--home --keep-dir");
  // Text mode prints the message and exits 1.
  const text = f.fx.cli(["retire", name]);
  assert.equal(text.status, 1);
  assert.match(text.stderr, new RegExp(`a retire of ${name} is already running \\(pid ${h.a.pid}, since .*nothing was done`));
  // The forms the CLI reaches only from inside the instance, as the kernel takes them.
  const other = await f.spawn();
  for (const [what, o] of [["--self (a scheduling)", { self: true, selfKillDelaySec: 600 }], ["--self --keep-dir", { self: true, keepDir: true, selfKillDelaySec: 600 }],
    ["recorded children", { children: [{ instance: other.instance, home: other.home }] }], ["a guarded apply's options", { plannedExtraWorktrees: [], children: [] }]]) {
    await assert.rejects(f.fx.inEnv(() => retireInstance(f.fx.root, name, o)), (e) => {
      assert.equal(e.code, "E_LIFECYCLE_BUSY", what);
      assert.deepEqual(e.details, { instance: name, home: h.inst.home, lock: h.lock, pid: h.a.pid, since: readJson(h.lock).at, action: "retire", holder: "running" }, what);
      return true;
    });
    assertUntouched(f, h, what);
  }
  assert.equal(existsSync(retirePendingMarkerPath(h.inst.home)), false, "the refused --self scheduled nothing");
  assert.equal(existsSync(join(other.home, "instance.json")), true, "the recorded child is as it was");
  await finish(f, h);
});

test("guarded x guarded, two idempotency keys: the second is refused, reads no plan and records no receipt", async (t) => {
  const f = fixture(t);
  let rev;
  const h = await inFlight(f, (inst) => { rev = f.planRevision(inst.instance); return f.retire(inst.instance, ["--plan-revision", rev, "--idempotency-key", "key-a"]); });
  // A guarded apply reads its plan once, under the claim: the --plan above and the first apply.
  assert.equal(await f.plansRead(h.inst.home), 2, "the apply that holds the claim read one plan");
  assertRefused(f, h, await f.retire(h.inst.instance, ["--plan-revision", rev, "--idempotency-key", "key-b"]).done, "guarded, another key");
  assert.equal(await f.plansRead(h.inst.home), 2, "the refused apply read no plan: it never held the claim");
  const tmux = f.watchedTmux();
  assertRefused(f, h, await f.retire(h.inst.instance, ["--plan-revision", rev, "--idempotency-key", "key-c"], tmux.env).done, "guarded, its tmux watched");
  assert.deepEqual(tmux.calls(), [], "and asked tmux nothing");
  const first = envelope(await finish(f, h));
  assert.equal(await f.plansRead(h.inst.home), 2, "one plan per guarded apply");
  assert.deepEqual({ retired: first.retired, replayed: first.replayed, key: first.idempotencyKey }, { retired: h.inst.instance, replayed: false, key: "key-a" });
  assert.equal(existsSync(join(dirname(h.inst.home), ".oats-retire-receipt.key-b.json")), false, "the refused apply recorded nothing");
});

test("guarded x guarded, the same idempotency key: the second is refused, and afterwards the key replays the first receipt", async (t) => {
  const f = fixture(t);
  let rev;
  const guarded = (inst) => f.retire(inst.instance, ["--plan-revision", rev, "--idempotency-key", "key-same"]);
  const h = await inFlight(f, (inst) => { rev = f.planRevision(inst.instance); return guarded(inst); });
  assertRefused(f, h, await guarded(h.inst).done, "guarded, the same key");
  const first = envelope(await finish(f, h));
  assert.equal(first.replayed, false);
  const again = await guarded(h.inst).done;
  assert.equal(again.code, 0, again.out + again.err);
  assert.deepEqual(envelope(again).result, { ...first, replayed: true }, "the key replays the first retire's receipt");
  assert.equal(f.hookRuns(), 1);
});

test("a launched instance: the first retire stopped its session, which changes the plan; a guarded apply with the plan it was shown, and a plain retire, are still refused as busy", { skip: !hasTmux && "tmux is not installed" }, async (t) => {
  const f = fixture(t);
  let rev;
  const guarded = (inst, key) => f.retire(inst.instance, ["--plan-revision", rev, "--idempotency-key", key]);
  const h = await inFlight(f, (inst) => { rev = f.planRevision(inst.instance); return guarded(inst, "key-a"); }, f.spawnLaunched);
  const plan = f.fx.cli(["retire", h.inst.instance, "--plan", "--json"]).json().result;
  assert.equal(plan.facts.session.present, false, "the first retire has stopped the session");
  assert.notEqual(plan.planRevision, rev, "so the plan no longer reads as it was shown");
  assertRefused(f, h, await guarded(h.inst, "key-b").done, "guarded, with the revision it was shown");
  assertRefused(f, h, await f.retire(h.inst.instance, ["--plan-revision", plan.planRevision, "--idempotency-key", "key-c"]).done, "guarded, with the revision the plan has now");
  assertRefused(f, h, await f.retire(h.inst.instance).done, "plain");
  const first = envelope(await finish(f, h));
  assert.deepEqual({ retired: first.retired, replayed: first.replayed, key: first.idempotencyKey }, { retired: h.inst.instance, replayed: false, key: "key-a" });
  for (const key of ["key-b", "key-c"]) assert.equal(existsSync(join(dirname(h.inst.home), `.oats-retire-receipt.${key}.json`)), false, `${key}: the refused apply recorded nothing`);
});

test("a retire that stopped the session and then failed: an apply with the plan shown before it answers E_PLAN_STALE with the fresh plan, and does nothing more", { skip: !hasTmux && "tmux is not installed" }, async (t) => {
  const f = fixture(t);
  f.open();
  const inst = await f.spawnLaunched();
  const name = inst.instance, readPlan = () => f.fx.cli(["retire", name, "--plan", "--json"]).json().result;
  const shown = readPlan();
  assert.equal(shown.facts.session.present, true, "the plan the caller was shown: the session runs");
  // A retire stops the session, its hook reports that cleanup did not finish, and it ends: the home is kept.
  f.failHook();
  const failed = await f.retire(name).done;
  assert.equal(failed.code, 1, failed.out + failed.err);
  assert.equal(envelope(failed).retainedHome, inst.home, "the failed retire kept the home");
  assert.deepEqual(claimFiles(inst.home), [], "and released its claim");
  const now = readPlan();
  assert.equal(now.facts.session.present, false);
  assert.notEqual(now.planRevision, shown.planRevision);
  const before = digest(inst.home), plans = await f.plansRead(inst.home);
  const r = await f.retire(name, ["--plan-revision", shown.planRevision, "--idempotency-key", "key-r"]).done;
  assert.equal(r.code, 1, r.out + r.err);
  const e = envelope(r).error;
  assert.equal(e.code, "E_PLAN_STALE");
  assert.equal(e.message, `the retire plan changed since it was shown (${shown.planRevision} → ${now.planRevision}); review the fresh plan`);
  assert.deepEqual({ ...e.details.plan, at: now.at }, now, "details.plan is the plan as it reads now");
  assert.equal(await f.plansRead(inst.home), plans + 1, "it read one plan");
  assert.equal(f.hookRuns(), 1, "no second hook run");
  assert.equal(digest(inst.home), before, "nothing of the home changed");
  assert.deepEqual(claimFiles(inst.home), [], "no claim is left");
  assert.equal(existsSync(join(dirname(inst.home), ".oats-retire-receipt.key-r.json")), false, "no receipt");
});

test("a stale guarded apply with nobody else retiring answers E_PLAN_STALE as it did, in both modes, and nothing was done", async (t) => {
  const f = fixture(t);
  const inst = await f.spawn();
  const name = inst.instance, before = digest(inst.home);
  const shown = f.fx.cli(["retire", name, "--plan", "--json"]).json().result;
  const untouched = (what) => {
    assert.equal(digest(inst.home), before, `${what}: nothing of the home changed`);
    assert.deepEqual([claimFiles(inst.home), recoveries(inst), f.hookRuns()], [[], [], 0], `${what}: no claim left, no recovery, no hook run`);
    assert.equal(existsSync(join(dirname(inst.home), ".oats-retire-receipt.key-s.json")), false, `${what}: no receipt`);
  };
  const args = ["retire", name, "--plan-revision", STALE, "--idempotency-key", "key-s"];
  const json = f.fx.cli([...args, "--json"]);
  assert.equal(json.status, 1);
  assert.equal(json.stderr, "");
  const plan = JSON.parse(json.stdout).error.details.plan;
  assert.deepEqual({ ...plan, at: shown.at }, shown, "details.plan is the fresh plan");
  assert.equal(json.stdout, JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_PLAN_STALE",
    message: `the retire plan changed since it was shown (${STALE} → ${shown.planRevision}); review the fresh plan`, details: { plan } } }) + "\n");
  untouched("--json");
  // The one thing that has happened: the apply read its plan under the claim, and a plan that is
  // answered appends its event to the workspace log. The comparison comes after it.
  assert.deepEqual(await f.planEvents(inst.home), [shown.planRevision, plan.planRevision], "--json: the workspace log holds the event of the plan that was shown and the event of this apply's plan");
  const text = f.fx.cli(args);
  assert.deepEqual([text.status, text.stdout, text.stderr], [1, "", `oats: the retire plan changed since it was shown; re-run oats retire ${name} --plan\n`]);
  untouched("text");
  assert.equal((await f.planEvents(inst.home)).length, 3, "text: one more event, of that apply's plan");
});

test("a retire reads its children when it holds the claim: after a retire that kept the home and repaired lineage, the next one acts on the children as they are then", async (t) => {
  const f = fixture(t);
  f.open();
  const parent = await f.spawn();
  const child = await f.spawn({ relativeTo: parent.instance, relation: "child" });
  const recordedParent = () => readJson(join(child.home, "instance.json")).parentInstance;
  assert.equal(recordedParent(), parent.instance);
  // The first retire stops the child, its hook reports that cleanup did not finish, and it ends with
  // the home kept. It has spliced the parent out of the lineage by then: the child records it no more.
  f.failHook();
  const failed = await f.retire(parent.instance).done;
  assert.equal(failed.code, 1, failed.out + failed.err);
  const kept = envelope(failed);
  assert.equal(kept.retainedHome, parent.home);
  assert.deepEqual(kept.childrenStopped.map((k) => k.instance), [child.instance], "the first retire acted on the child it had");
  assert.equal(recordedParent(), undefined, "and repaired lineage: the child is no longer this parent's");
  // The second retire has no children, and says so by naming none.
  f.passHook();
  const before = digest(child.home);
  const second = await f.retire(parent.instance).done;
  assert.equal(second.code, 0, second.out + second.err);
  const receipt = envelope(second);
  assert.equal(receipt.retired, parent.instance);
  assert.equal(receipt.childrenStopped, undefined, "it stopped no child: it has none now");
  assert.equal(existsSync(parent.home), false);
  assert.equal(digest(child.home), before, "the former child is as it was");
});

test("a deferred --self completion in flight: a plain retire and a second --self are refused, naming the completion's pid", async (t) => {
  const f = fixture(t);
  const h = await inFlight(f, (inst) => f.completion(inst));
  assertRefused(f, h, await f.retire(h.inst.instance).done, "plain against the completion");
  // A second --self answers that one is already scheduled only until the completion starts: once
  // the completion holds the claim it is refused like any other retire, and schedules nothing.
  await assert.rejects(f.fx.inEnv(() => retireInstance(f.fx.root, h.inst.instance, { self: true, selfKillDelaySec: 600 })), (e) => {
    assert.equal(e.code, "E_LIFECYCLE_BUSY");
    assert.deepEqual(e.details, { instance: h.inst.instance, home: h.inst.home, lock: h.lock, pid: h.a.pid, since: readJson(h.lock).at, action: "retire", holder: "running" });
    return true;
  });
  assert.equal(existsSync(retirePendingMarkerPath(h.inst.home)), false, "the refused --self scheduled nothing");
  assertUntouched(f, h, "--self against the completion");
  await finish(f, h);
  assert.equal(existsSync(deferredRetireResultPath(h.inst.home)), false, "the completion succeeded: it left no outcome");
});

test("a plain retire in flight: a deferred --self completion waits for the claim, is refused, and records its failure as any failed completion does", async (t) => {
  const f = fixture(t);
  const h = await inFlight(f, (inst) => f.retire(inst.instance));
  const c = await f.completion(h.inst).done;
  assert.equal(h.a.ended(), false, "the first retire is still in flight");
  assert.equal(c.code, 1, c.out + c.err);
  const outcome = readJson(deferredRetireResultPath(h.inst.home));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, "E_LIFECYCLE_BUSY");
  assert.match(outcome.error.message, new RegExp(`a retire of ${h.inst.instance} is already running \\(pid ${h.a.pid},`));
  assertUntouched(f, h, "the refused completion");
  await finish(f, h);
});

test("a retire killed while it holds the claim does not block the next one: the claim is taken over", async (t) => {
  const f = fixture(t);
  const h = await inFlight(f, (inst) => f.retire(inst.instance));
  kill(h.a.pid);
  assert.equal((await h.a.done).signal, "SIGKILL");
  // Its hook outlives it (awebai/oats#865): ended here, so the fixture leaves no process.
  const [hook] = f.hookPids();
  kill(hook);
  await waitUntil(() => !alive(hook), "the killed retire's hook to be gone");
  assert.equal(readJson(h.lock).pid, h.a.pid, "the killed retire left its claim");
  assert.equal(existsSync(h.inst.home), true);
  f.open();
  const next = await f.retire(h.inst.instance).done;
  assert.equal(next.code, 0, next.out + next.err);
  assert.equal(envelope(next).retired, h.inst.instance);
  assert.equal(existsSync(h.inst.home), false, "the next retire ran");
  assert.deepEqual(claimFiles(h.inst.home), [], "no claim and no reclaim file is left");
});

test("a retire that is a zombie (killed, and not reaped by its parent) does not block the next one either: its claim is taken over", async (t) => {
  const f = fixture(t);
  const h = await inFlight(f, (inst) => f.retire(inst.instance));
  const [hook] = f.hookPids();
  // The first retire is a child of this process, and Node reaps its children from its event loop:
  // killed, it stays a zombie until the next await (awebai/oats#870). So nothing is awaited from
  // here to the assertion on its state, and the second retire is the synchronous CLI.
  const state = zombieSync(h.a.pid);
  t.diagnostic(`the killed retire (pid ${h.a.pid}) is a zombie: the host reports its state as ${JSON.stringify(state)}`);
  kill(hook); // its hook outlives it (awebai/oats#865)
  assert.equal(readJson(h.lock).pid, h.a.pid, "the killed retire left its claim");
  assert.equal(existsSync(h.inst.home), true);
  f.open();
  const next = f.fx.cli(["retire", h.inst.instance, "--json"]);
  assert.match(String(hostProcessState(h.a.pid)), /^Z/, "the first retire was still a zombie when the second returned: a zombie is what it met");
  assert.equal(next.status, 0, next.stdout + next.stderr);
  assert.equal(JSON.parse(next.stdout).retired, h.inst.instance);
  assert.equal(existsSync(h.inst.home), false, "the next retire ran");
  assert.equal(f.hookRuns(), 2, "with its own hook run");
  assert.deepEqual(claimFiles(h.inst.home), [], "no claim and no reclaim file is left");
  // Reaped only now.
  assert.equal((await h.a.done).signal, "SIGKILL");
  await waitUntil(() => !alive(hook), "the killed retire's hook to be gone");
});

test("the --self window: between the scheduling and its completion every other retire is refused, naming the pending marker and the completion", async (t) => {
  const f = fixture(t);
  const inst = await f.spawn();
  const name = inst.instance, marker = retirePendingMarkerPath(inst.home);
  // A long delay: the completion sleeps for the whole test, and is ended before the cleanup.
  const scheduled = await f.fx.inEnv(() => retireInstance(f.fx.root, name, { self: true, selfKillDelaySec: 600 }));
  f.track(scheduled.completionPid);
  assert.equal(scheduled.deferred, true);
  const pending = readJson(marker);
  assert.equal(pending.completionPid, scheduled.completionPid, "the marker names its completion");
  assert.equal(pending.completionStart, processStartToken(scheduled.completionPid), "and when it started");
  assert.deepEqual(claimFiles(inst.home), [], "the scheduling released its claim");
  const before = digest(inst.home), markerBytes = readFileSync(marker, "utf8");
  const details = { instance: name, home: inst.home, lock: marker, pid: scheduled.completionPid, since: pending.requestedAt, action: "retire", holder: "running" };
  const untouched = (what) => {
    assert.equal(digest(inst.home), before, `${what}: nothing of the home changed`);
    assert.equal(readFileSync(marker, "utf8"), markerBytes, `${what}: the marker is as it was`);
    assert.deepEqual(recoveries(inst), [], `${what}: no recovery`);
    assert.equal(f.hookRuns(), 0, `${what}: no hook run`);
    assert.deepEqual(claimFiles(inst.home), [], `${what}: no claim is left`);
  };
  const rev = f.planRevision(name);
  for (const [what, extra] of [["plain", []], ["guarded", ["--plan-revision", rev, "--idempotency-key", "key-w"]],
    ["guarded, a stale revision", ["--plan-revision", STALE, "--idempotency-key", "key-s"]], ["--force", ["--force"]]]) {
    const r = await f.retire(name, extra).done;
    assert.equal(r.code, 1, `${what}: ${r.out}${r.err}`);
    const e = envelope(r).error;
    assert.equal(e.code, "E_LIFECYCLE_BUSY", what);
    assert.deepEqual(e.details, details, what);
    assert.equal(e.message, `a retire of ${name} is already scheduled (its completion, pid ${scheduled.completionPid}, requested at ${pending.requestedAt}); nothing was done — wait for it to finish`, what);
    untouched(what);
  }
  // --self --keep-dir runs in this process, not in a completion: refused as well.
  await assert.rejects(f.fx.inEnv(() => retireInstance(f.fx.root, name, { self: true, keepDir: true, selfKillDelaySec: 600 })), (e) => {
    assert.equal(e.code, "E_LIFECYCLE_BUSY");
    assert.deepEqual(e.details, details);
    return true;
  });
  untouched("--self --keep-dir");
  // A second --self only schedules, and one is scheduled already: its present answer.
  const second = await f.fx.inEnv(() => retireInstance(f.fx.root, name, { self: true, selfKillDelaySec: 600 }));
  assert.equal(second.alreadyScheduled, true);
  assert.equal(second.completionPid, undefined, "no second completion was started");
  untouched("a second --self");

  // The completion died: the marker no longer refuses, and the retire does what it owed.
  await killAndReap(scheduled.completionPid);
  f.open();
  const r = await f.retire(name).done;
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(existsSync(inst.home), false);
  assert.equal(existsSync(marker), false, "the owed retirement is paid: the marker is gone");
  assert.equal(f.hookRuns(), 1);
});

test("a pending marker whose completion is a zombie refuses no longer: the retire does what the completion owed", async (t) => {
  const f = fixture(t);
  const inst = await f.spawn();
  const name = inst.instance, marker = retirePendingMarkerPath(inst.home);
  // The completion is a detached child of this process, asleep for the whole test.
  const scheduled = await f.fx.inEnv(() => retireInstance(f.fx.root, name, { self: true, selfKillDelaySec: 600 }));
  const pid = f.track(scheduled.completionPid);
  const pending = readJson(marker), markerBytes = readFileSync(marker, "utf8"), before = digest(inst.home);
  assert.deepEqual([pending.completionPid, pending.completionStart], [pid, processStartToken(pid)], "the marker names its completion, and when it started");
  // Nothing is awaited from here to the assertion on the zombie's state: this process reaps its
  // children from its event loop, so the completion stays a zombie only while the test is synchronous.
  // The control: the completion lives, and the retire is refused.
  const busy = f.fx.cli(["retire", name, "--json"]);
  assert.equal(busy.status, 1, busy.stdout + busy.stderr);
  assert.deepEqual(busy.json().error, { code: "E_LIFECYCLE_BUSY",
    message: `a retire of ${name} is already scheduled (its completion, pid ${pid}, requested at ${pending.requestedAt}); nothing was done — wait for it to finish`,
    details: { instance: name, home: inst.home, lock: marker, pid, since: pending.requestedAt, action: "retire", holder: "running" } });
  assert.doesNotMatch(String(hostProcessState(pid)), /^Z/, "the completion that refused it was running");
  assert.equal(digest(inst.home), before, "the refused retire changed nothing of the home");
  assert.deepEqual([recoveries(inst), f.hookRuns(), claimFiles(inst.home)], [[], 0, []], "no recovery, no hook run, no claim left");
  // The completion is killed and nobody reaps it: the same marker, naming the same pid and start.
  const state = zombieSync(pid);
  t.diagnostic(`the killed completion (pid ${pid}) is a zombie: the host reports its state as ${JSON.stringify(state)}`);
  assert.equal(readFileSync(marker, "utf8"), markerBytes, "the marker is as it was");
  f.open();
  const r = f.fx.cli(["retire", name, "--json"]);
  assert.match(String(hostProcessState(pid)), /^Z/, "the completion was still a zombie when the retire returned: a zombie is what it met");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).retired, name);
  assert.equal(existsSync(inst.home), false, "the home is retired");
  assert.equal(existsSync(marker), false, "the owed retirement is paid: the marker is gone");
  assert.equal(f.hookRuns(), 1);
  assert.deepEqual(claimFiles(inst.home), [], "no claim is left");
  await killAndReap(pid);
});

test("a pending marker refuses only for a completion that lives: its outcome, an older kernel's marker and a start that cannot be compared", async (t) => {
  const f = fixture(t);
  f.open();
  // A live process that is not a completion stands in for one: this test's own.
  const live = { completionPid: process.pid, completionStart: processStartToken(process.pid) };
  const withMarker = async (extra) => {
    const inst = await f.spawn();
    writeFileSync(retirePendingMarkerPath(inst.home), JSON.stringify({ ...f.intent(inst), ...extra }, null, 2) + "\n");
    return inst;
  };
  // The control: this marker, with no outcome beside it, refuses.
  const refused = await withMarker(live);
  const busy = await f.retire(refused.instance).done;
  assert.equal(envelope(busy).error.code, "E_LIFECYCLE_BUSY", busy.out);
  assert.equal(envelope(busy).error.details.pid, process.pid);
  // The same marker with its completion's outcome (it failed): the retire retries it.
  writeFileSync(deferredRetireResultPath(refused.home), JSON.stringify({ ok: false }) + "\n");
  const retried = await f.retire(refused.instance).done;
  assert.equal(retried.code, 0, retried.out + retried.err);
  assert.equal(existsSync(refused.home), false);
  assert.equal(existsSync(deferredRetireResultPath(refused.home)), false, "the failed outcome is cleared with the home");
  // A marker an older kernel wrote names no completion: as today.
  const older = await withMarker({});
  const went = await f.retire(older.instance).done;
  assert.equal(went.code, 0, went.out + went.err);
  assert.equal(existsSync(older.home), false);
  // A completion whose pid runs and whose start was not recorded: never taken for gone.
  const unknown = await withMarker({ completionPid: process.pid, completionStart: null });
  const marker = retirePendingMarkerPath(unknown.home), before = digest(unknown.home), runs = f.hookRuns();
  const r = await f.retire(unknown.instance, ["--force"]).done;
  assert.equal(r.code, 1, r.out + r.err);
  const e = envelope(r).error;
  assert.equal(e.code, "E_LIFECYCLE_BUSY");
  assert.deepEqual(e.details, { instance: unknown.instance, home: unknown.home, lock: marker, pid: process.pid, since: "2026-10-10T00:00:00.000Z", action: "retire", unknown: e.details.unknown, holder: "unknown" });
  assert.match(e.details.unknown, /names no start time/);
  assert.ok(e.message.includes(`pid ${process.pid}, recorded start none`) && e.message.includes(e.details.unknown) && e.message.includes("nothing was done") && e.message.includes(`remove ${marker}, then retry`), e.message);
  assert.equal(digest(unknown.home), before, "nothing of the home changed");
  assert.equal(f.hookRuns(), runs, "no hook ran");
  assert.equal(existsSync(marker), true, "the marker is kept");
});

test("a completion waits for the claim of the retire that scheduled it, and is not refused by its own marker", async (t) => {
  const f = fixture(t);
  f.open();
  const inst = await f.spawn();
  const marker = retirePendingMarkerPath(inst.home);
  // The scheduler, standing still between starting its completion and writing the marker: this
  // process holds the claim, and there is no marker yet.
  writeClaim(inst.home);
  const before = digest(inst.home);
  const c = f.completion(inst);
  await waitUntil(() => waitingForClaim(inst.home, c.pid), "the completion to be waiting for the claim", 60000);
  assert.equal(c.ended(), false, "a live holder is waited for, not refused at once");
  assert.equal(digest(inst.home), before, "it read and changed nothing of the home meanwhile");
  assert.equal(f.hookRuns(), 0);
  // The scheduler writes the marker under its claim, then releases.
  writeFileSync(marker, JSON.stringify({ ...f.intent(inst), completionPid: c.pid, completionStart: processStartToken(c.pid) }, null, 2) + "\n");
  rmSync(claimOf(inst.home));
  const r = await c.done;
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(existsSync(inst.home), false, "the completion retired the home");
  assert.equal(f.hookRuns(), 1);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(deferredRetireResultPath(inst.home)), false, "no failure was recorded");
  assert.deepEqual(claimFiles(inst.home), []);
});

test("the home is resolved again under the claim: removed meanwhile it is E_SESSION_UNKNOWN, another agent's same-named home is retired under its own claim", async (t) => {
  const f = fixture(t);
  f.open();
  // A retire that waits for the claim is past its first resolution: the completion is the one that waits.
  const waiting = async (inst, options) => {
    writeClaim(inst.home);
    const c = f.completion(inst, options);
    await waitUntil(() => waitingForClaim(inst.home, c.pid), "the completion to be waiting for the claim", 60000);
    return c;
  };
  // Removed while it waited: what a retire of a retired instance answers, and no claim is left.
  const gone = await f.spawn();
  const c1 = await waiting(gone);
  rmSync(gone.home, { recursive: true });
  rmSync(claimOf(gone.home));
  assert.equal((await c1.done).code, 1);
  assert.equal(readJson(deferredRetireResultPath(gone.home)).error.code, "E_SESSION_UNKNOWN");
  assert.deepEqual(claimFiles(gone.home), [], "the claim it took for a home that was gone is released");
  assert.equal(f.hookRuns(), 0);
  rmSync(deferredRetireResultPath(gone.home));

  // Removed, and the name is now a home of another agent (no --home was given): the retire starts
  // over on that home, under that home's claim. It is no instance OATS made, so it is refused as
  // unidentified, by name: the retire reached it.
  const moved = await f.spawn();
  const twin = join(f.fx.root, "zz-other", "instances", moved.instance);
  const c2 = await waiting(moved, {});
  rmSync(moved.home, { recursive: true });
  mkdirSync(twin, { recursive: true });
  rmSync(claimOf(moved.home));
  assert.equal((await c2.done).code, 1);
  const outcome = readJson(deferredRetireResultPath(moved.home));
  assert.equal(outcome.error.code, "E_UNIDENTIFIED_INSTANCE_HOME", JSON.stringify(outcome));
  assert.ok(outcome.error.message.startsWith(`${twin} has no instance.json`), outcome.error.message);
  assert.deepEqual([claimFiles(moved.home), claimFiles(twin)], [[], []], "no claim is left, of the first home or of the second");
});

test("a claim nobody comes back for: with no home of that name, a gone holder's claim is removed, and a live, unknown or unreadable one, or one that cannot be taken over, is left", async (t) => {
  const f = fixture(t);
  const inst = await f.spawn(); // the agent, and so its instances directory, exists
  const ghost = join(dirname(inst.home), "worker-gone"), lock = claimOf(ghost);
  const unknownSession = () => {
    const r = f.fx.cli(["retire", "worker-gone", "--json"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.deepEqual(r.json().error, { code: "E_SESSION_UNKNOWN", message: 'no instance named "worker-gone"' });
  };
  writeClaim(ghost, { pid: exitedPid(), processStart: "proc:1" });
  unknownSession();
  assert.deepEqual(claimFiles(ghost), [], "the gone holder's claim is removed, and no reclaim file is left");
  // A gone holder whose nonce is not a claim's: no takeover can be serialized on it (lib/claim.mjs).
  for (const [what, bytes] of [["a live holder", null], ["a holder with no recorded start", { processStart: undefined }], ["a file that is not a claim", "{not json"],
    ["a gone holder whose claim cannot be taken over", { pid: exitedPid(), processStart: "proc:1", nonce: "short" }]]) {
    if (typeof bytes === "string") writeFileSync(lock, bytes); else writeClaim(ghost, bytes ?? {});
    const held = readFileSync(lock, "utf8");
    unknownSession();
    assert.equal(readFileSync(lock, "utf8"), held, `${what}: left as it is`);
    assert.deepEqual(claimFiles(ghost), ["worker-gone.lock"], what);
  }
  // A name that is no instance name builds no path.
  const r = f.fx.cli(["retire", "../worker-gone", "--json"]);
  assert.equal(r.json().error.code, "E_SESSION_UNKNOWN");
  assert.equal(existsSync(inst.home), true);
});

test("a process whose own start cannot be read: retire is refused, saying what could not be read, and nothing of the home changed", async (t) => {
  const f = fixture(t);
  const inst = await f.spawn();
  const before = digest(inst.home);
  const dir = join(f.fx.base, "ps-fails"); mkdirSync(dir);
  writeFileSync(join(dir, "ps"), '#!/bin/sh\necho "ps: simulated failure" >&2\nexit 2\n', { mode: 0o755 });
  const r = await f.retire(inst.instance, ["--force"], { OATS_TEST_PROCESS_START_PS: join(dir, "ps") }).done;
  assert.equal(r.code, 1, r.out + r.err);
  const e = envelope(r).error, lock = claimOf(inst.home);
  assert.equal(e.code, "E_LIFECYCLE_BUSY");
  assert.match(e.message, /^this process's start time cannot be read \(ps -o lstart= -o stat= -p \d+ answered exit 2: ps: simulated failure\), so oats retire cannot hold /);
  assert.ok(e.message.endsWith(`cannot hold ${lock} verifiably; nothing was done — check by hand, in a shell on this host, the read that the reason names (\`cat /proc/$$/stat\` where there is a /proc; elsewhere \`PATH=/usr/bin:/bin ps -o lstart= -o stat= -p $$\`, which must print a start time and a state), then run the command again`), e.message);
  assert.doesNotMatch(e.message, /already running|wait for it to finish/, "nobody is said to be running");
  assert.deepEqual(e.details, { instance: inst.instance, home: inst.home, lock, holder: "none" });
  assert.equal(digest(inst.home), before, "nothing of the home changed");
  assert.deepEqual([claimFiles(inst.home), recoveries(inst), f.hookRuns()], [[], [], 0], "no claim, no recovery, no hook run");
});

test("a retire whose PATH holds no ps still reads its own start on the ps path, and retires (#878)", async (t) => {
  const f = fixture(t);
  const inst = await f.spawn();
  // The fixture's PATH, every program of it but `ps`, in one directory.
  const dir = join(f.fx.base, "path-without-ps"), linked = new Set(["ps"]); mkdirSync(dir);
  for (const from of f.fx.env.PATH.split(":").filter((d) => d && existsSync(d))) {
    for (const name of readdirSync(from)) if (!linked.has(name)) { linked.add(name); symlinkSync(join(from, name), join(dir, name)); }
  }
  const lookup = spawnSync("sh", ["-c", "command -v ps"], { env: { PATH: dir }, encoding: "utf8" });
  assert.ok(lookup.status !== 0 && lookup.stdout === "", `no ps on that PATH: ${JSON.stringify(lookup)}`);
  f.open();
  const r = await f.retire(inst.instance, [], { OATS_TEST_PROCESS_START_PS: "1", PATH: dir }).done;
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(envelope(r).retired, inst.instance);
  assert.equal(existsSync(inst.home), false, "the home is retired");
  assert.deepEqual(claimFiles(inst.home), [], "no claim left");
});

test("a holder that cannot be established alive or gone is never taken over; a claim file that is not a claim is never removed", async (t) => {
  const f = fixture(t);
  const inst = await f.spawn();
  const name = inst.instance, lock = claimOf(inst.home), before = digest(inst.home);
  const refused = async (o, check) => {
    const held = readFileSync(lock, "utf8");
    await assert.rejects(f.fx.inEnv(() => retireInstance(f.fx.root, name, o)), (e) => {
      assert.equal(e.code, "E_LIFECYCLE_BUSY");
      assert.ok(!e.message.includes("\n") && e.message.includes("nothing was done"), e.message);
      check(e);
      return true;
    });
    assert.equal(readFileSync(lock, "utf8"), held, "the claim file is still there, as it was");
    assert.equal(digest(inst.home), before, "nothing of the home changed");
    assert.deepEqual([claimFiles(inst.home), recoveries(inst), f.hookRuns()], [[`${name}.lock`], [], 0]);
  };
  // A live pid with no recorded start: whether it is that retire cannot be compared.
  writeClaim(inst.home, { processStart: undefined });
  for (const o of [{}, { force: true }]) await refused(o, (e) => {
    assert.deepEqual(e.details, { instance: name, home: inst.home, lock, pid: process.pid, since: "2026-10-10T00:00:00.000Z", action: "retire", unknown: e.details.unknown, holder: "unknown" });
    assert.match(e.details.unknown, /names no start time/);
    assert.ok(e.message.includes(`pid ${process.pid}, recorded start none`) && e.message.includes(e.details.unknown) && e.message.includes(`if it is not an oats retire, remove ${lock}, then retry`), e.message);
  });
  writeFileSync(lock, "{not json");
  await refused({}, (e) => {
    assert.deepEqual(e.details, { instance: name, home: inst.home, lock, holder: "unknown" });
    assert.equal(e.message, `${lock} is not a readable claim; nothing was done — inspect it and remove it if no oats retire, oats instance stop, oats instance upgrade, oats session start or oats session restart holds it, then retry`);
  });
  // The way out the refusals name: once the file is removed, the retire runs.
  rmSync(lock);
  f.open();
  const r = await f.fx.inEnv(() => retireInstance(f.fx.root, name, {}));
  assert.equal(r.retired, name);
  assert.deepEqual(claimFiles(inst.home), []);
});

test("a dangling symbolic link where the claim belongs: the retire is refused in a bounded time, naming the path, and nothing was done", async (t) => {
  const f = fixture(t);
  const inst = await f.spawn();
  const name = inst.instance, lock = claimOf(inst.home), before = digest(inst.home);
  // A path that exists (a claim cannot be linked there) and reads as absent, for as long as it is there.
  const nowhere = join(f.fx.base, "no-such-file");
  mkdirSync(claimsDir(inst.home), { recursive: true });
  symlinkSync(nowhere, lock);
  // Before awebai/oats#874 this retire never returned: the time it is given makes that a failure.
  // That time is the one bound, and it only ends a retire that hangs: how long a retire that
  // answers took is the host's (shown, not asserted). That the claim pauses a fixed number of
  // times is pinned where it can be counted, in test/claim.test.mjs.
  const started = Date.now();
  const r = spawnSync(process.execPath, [CLI, "retire", name, "--json"], { cwd: f.fx.dep, env: f.fx.env, encoding: "utf8", timeout: 30000 });
  t.diagnostic(`refused after ${Date.now() - started} ms`);
  assert.equal(r.error, undefined, `the retire returned by itself (${r.error?.code}, signal ${r.signal})`);
  assert.deepEqual([r.status, r.stderr], [1, ""], r.stdout + r.stderr);
  const e = JSON.parse(r.stdout);
  assert.deepEqual({ schemaVersion: e.schemaVersion, ok: e.ok }, { schemaVersion: 1, ok: false });
  assert.deepEqual(e.error, { code: "E_LIFECYCLE_BUSY", message: `${lock} is not a readable claim; nothing was done — inspect it and remove it if no oats retire, oats instance stop, oats instance upgrade, oats session start or oats session restart holds it, then retry`,
    details: { instance: name, home: inst.home, lock, holder: "unknown" } });
  assert.doesNotMatch(e.error.message, /already running|wait for it to finish/, "nobody is said to be running");
  assert.equal(lstatSync(lock).isSymbolicLink(), true, "the link is still there");
  assert.deepEqual([readlinkSync(lock), existsSync(nowhere)], [nowhere, false], "as it was, and nothing was written through it");
  assert.equal(digest(inst.home), before, "nothing of the home changed");
  assert.deepEqual([claimFiles(inst.home), recoveries(inst), f.hookRuns()], [[`${name}.lock`], [], 0], "no private file left beside it, no recovery, no hook run");
  // The way out the refusal names: once the link is removed, the retire runs.
  rmSync(lock);
  f.open();
  const went = f.fx.cli(["retire", name, "--json"]);
  assert.equal(went.status, 0, went.stdout + went.stderr);
  assert.equal(JSON.parse(went.stdout).retired, name);
  assert.equal(existsSync(inst.home), false);
  assert.deepEqual(claimFiles(inst.home), []);
});

test("a claim whose holder is gone and that cannot be taken over (its nonce is not 32 hexadecimal digits) has its own refusal, never the one that says a retire is running", async (t) => {
  const f = fixture(t);
  const inst = await f.spawn();
  const name = inst.instance, lock = claimOf(inst.home), before = digest(inst.home);
  for (const [which, nonce] of [["a short nonce", "short"], ["no nonce", undefined]]) {
    const pid = exitedPid();
    writeClaim(inst.home, { pid, processStart: "proc:1", nonce });
    const held = readFileSync(lock, "utf8");
    // --force does not take it over either.
    for (const extra of [[], ["--force"]]) {
      const what = `${which}${extra.length ? `, ${extra}` : ""}`;
      const r = f.fx.cli(["retire", name, "--json", ...extra]);
      assert.equal(r.status, 1, `${what}: ${r.stdout}${r.stderr}`);
      const e = r.json().error;
      assert.deepEqual(e, { code: "E_LIFECYCLE_BUSY",
        message: `the process that held ${lock} (pid ${pid}) is gone, and this file is not a claim this kernel can take over (its nonce is not the 32 hexadecimal digits a claim carries); nothing was done — inspect ${lock} and remove it if no oats retire, oats instance stop, oats instance upgrade, oats session start or oats session restart holds it, then retry`,
        details: { instance: name, home: inst.home, lock, pid, since: "2026-10-10T00:00:00.000Z", action: "retire", holder: "none" } }, what);
      assert.doesNotMatch(e.message, /already running|wait for it to finish/, `${what}: nobody is said to be running`);
      assert.equal(readFileSync(lock, "utf8"), held, `${what}: the file is byte for byte as it was`);
      assert.equal(digest(inst.home), before, `${what}: nothing of the home changed`);
      assert.deepEqual([claimFiles(inst.home), recoveries(inst), f.hookRuns()], [[`${name}.lock`], [], 0], `${what}: no reclaim file, no recovery, no hook run`);
    }
  }
  // The way out the refusal names: once the file is removed, the retire runs.
  rmSync(lock);
  f.open();
  const went = f.fx.cli(["retire", name, "--json"]);
  assert.equal(went.status, 0, went.stdout + went.stderr);
  assert.equal(JSON.parse(went.stdout).retired, name);
  assert.equal(existsSync(inst.home), false);
  assert.deepEqual(claimFiles(inst.home), []);
});
