// A stop takes the home's claim (awebai/oats#866, #890; feature `lifecycle-claim-stop`).
//
// `oats instance stop <name> --apply` holds the lifecycle claim of EVERY target
// (<instances>/.oats-retirement/claims/<instance>.lock, the file a retire holds, lib/core.mjs
// claimHomeFor) from before it stops the first one until it has written its receipt. The claim's
// record names the holder's verb (`action`: "stop" or "retire") from the instant the file exists.
//
// What that changes, and what the tests below hold:
//   - #866: a stop used to know nothing of a retire in flight. It wrote its marker, its record and
//     its receipt into a home the retire was copying or removing, and a retire stopped, copied and
//     removed a home a stop was still working in. Now each is refused beside the other, at once
//     and before any effect: E_INSTANCE_RETIRING for a stop beside a retire, E_LIFECYCLE_BUSY
//     (`holder: "running"`) for a retire beside a stop and for a stop beside a stop.
//   - #890: a stop said "in progress" with a file in the home, `.oats-stop-pending.json`, that named
//     no process. A stop apply that was killed left it there, and every later stop of that home
//     answered "already has a stop in progress" for ever. A claim names its holder by pid and start
//     time: one left by a process that died is taken over by the next command that wants it. The
//     stops that are killed are in test/stop-claim-killed.test.mjs.
//   - the plan is read again under the claims and compared once with the revision the caller sent;
//     a holder is answered before a stale plan; `--grace-ms` out of range refuses the whole apply
//     before the plan; a marker an older kernel left refuses nothing and is removed.
//
// No outcome rests on a sleep or on which process is faster. "A stop is in flight" and "a retire
// is at this phase" are made with test/helpers/fs-gate-preload.mjs: the real CLI, as a child, is
// held at one named `node:fs` call of the kernel's own until the test releases it. The two calls a
// stop is held at are named where they are defined (beforeFirstStop, claimTaken).
//
// Each test says, in a comment that starts with "Before:", what the kernel before 5642fd2f answered.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn as spawnChild, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import YAML from "yaml";
import { retireClaimPath, retirePendingMarkerPath } from "../lib/core.mjs";
import { processStartToken } from "../lib/worktree-hooks.mjs";
import { CLI, v2Deployment, writeFixtureExecutable } from "./helpers/v2-deployment.mjs";
import { waitUntil } from "./helpers/host-fixture.mjs";
import { startGated } from "./helpers/fs-gate-preload.mjs";

const hasTmux = !spawnSync("tmux", ["-V"], { stdio: "ignore" }).error;
/** For the tests that need a live session: a stand-in harness in a window of the fixture's own tmux server. */
const TMUX = { skip: !hasTmux && "tmux is not installed" };
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
/** A real pid whose process has exited and been reaped. */
const exitedPid = () => spawnSync(process.execPath, ["-e", ""]).pid;
/** A plan revision no plan has. */
const STALE = "0".repeat(24);
const NONCE = "c".repeat(32);
const AT = "2026-10-10T00:00:00.000Z";

// ---- what a test reads of a home, and of the claims beside it -----------------------------------

/** Every entry under `dir`, one row each: its path, its mode, and a file's bytes (as a digest) or a
 *  link's target. Two equal listings are a home in which nothing was written, changed or removed. */
function listing(dir, rel = "") {
  const rows = [];
  for (const name of readdirSync(join(dir, rel)).sort()) {
    const at = join(rel, name), abs = join(dir, at), st = lstatSync(abs);
    const mode = (st.mode & 0o7777).toString(8);
    if (st.isSymbolicLink()) rows.push(`${at} -> ${readlinkSync(abs)}`);
    else if (st.isDirectory()) rows.push(`${at}/ ${mode}`, ...listing(dir, at));
    else rows.push(`${at} ${mode} ${createHash("sha256").update(readFileSync(abs)).digest("hex")}`);
  }
  return rows;
}
/** What a stop writes into a home, by name: the marker of a kernel before `lifecycle-claim-stop`
 *  (`.oats-stop-pending.json`), its record (`.oats-stop.json`), its receipts
 *  (`.oats-stop-receipt.<key>.json`) and the private file of an atomic write (`*.tmp`). */
const stopFiles = (home) => readdirSync(home).filter((name) => name.startsWith(".oats-stop") || name.endsWith(".tmp")).sort();
/** The claim's path, built here from the contract and not with the kernel's own function. */
const claimsDir = (home) => join(dirname(home), ".oats-retirement", "claims");
const claimOf = (home) => join(claimsDir(home), `${basename(home)}.lock`);
/** Every file in the claims directory of the home's agent: the claims, and anything a takeover left. */
const claimFiles = (home) => (existsSync(claimsDir(home)) ? readdirSync(claimsDir(home)).sort() : []);
/** A claim as the protocol writes it, held by this test's own process unless `holder` says otherwise. */
function writeClaim(home, holder = {}) {
  mkdirSync(claimsDir(home), { recursive: true, mode: 0o700 });
  writeFileSync(claimOf(home), JSON.stringify({ pid: process.pid, processStart: processStartToken(process.pid), nonce: NONCE, at: AT, ...holder }) + "\n");
}
/** What a stop plan says of each target's claim. */
const flags = (plan) => plan.targets.map((target) => ({ instance: target.instance, retiring: target.retiring, stopPending: target.stopPending }));
const idle = (i) => ({ instance: i.name, retiring: false, stopPending: false });
/** The claim of `i` as it is held now: the file is there, and names `pid` with the verb `action`
 *  → { text, record }. */
function heldClaim(i, action, pid, what) {
  assert.equal(existsSync(i.lock), true, `${what}: the claim ${i.lock} is taken`);
  const text = readFileSync(i.lock, "utf8"), record = JSON.parse(text);
  assert.deepEqual([record.action, record.pid], [action, pid], what);
  return { text, record };
}

// ---- the two calls a stop apply is held at ------------------------------------------------------

/** Held AFTER every claim is taken, after the plan was read again and compared, and BEFORE the first
 *  target is stopped: the apply's removal of a marker an older kernel may have left in `home`, the
 *  first target of its plan (lib/instance-lifecycle.mjs applyStop: `rmSync(left, { force: true })`).
 *  The stop makes that call exactly once per target, with that path and no other `rmSync` of it, as
 *  its last step before `stopInstanceSession`: a child held there holds its claims and has had no
 *  effect. */
const beforeFirstStop = (home) => ({ fn: "rmSync", path: join(home, ".oats-stop-pending.json") });
/** Held right AFTER the claim `lock` is taken, before its holder does anything under it: the claim
 *  is made by writing a private file `<lock>.tmp-<pid>-<nonce>`, hard-linking it to `lock` and
 *  removing the private file (lib/claim.mjs takeClaim). Once that `unlinkSync` has returned, the
 *  link is made. For a stop of several targets, `lock` is the last one in the order they are taken
 *  (sorted by path): every claim is held, and the plan has not been read again. */
const claimTaken = (lock) => ({ fn: "unlinkSync", prefix: `${lock}.tmp-`, when: "after" });

// ---- the answers --------------------------------------------------------------------------------

/** The one JSON answer of a CLI run (`fx.cli`'s result, or a gated child's). */
function oneAnswer(r, what) {
  const lines = r.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `${what}: exactly one JSON answer on stdout\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  return { exit: "status" in r ? r.status : r.code, doc: JSON.parse(lines[0]) };
}
/** The `result` of a command that answered: exit 0, `ok: true`. */
function result(r, what) {
  const { exit, doc } = oneAnswer(r, what);
  assert.deepEqual([exit, doc.schemaVersion, doc.ok], [0, 1, true], `${what}: ${r.stdout}${r.stderr}`);
  return doc.result;
}
/** The `error` of a command that refused with `code`: exit 1, one envelope, nothing on stderr. */
function refusal(r, code, what) {
  const { exit, doc } = oneAnswer(r, what);
  assert.deepEqual([exit, doc.schemaVersion, doc.ok, doc.error?.code], [1, 1, false, code], `${what}: ${r.stdout}${r.stderr}`);
  assert.equal(r.stderr, "", `${what}: a refusal prints nothing on stderr`);
  return doc.error;
}
/** The receipt a retire prints when it has retired `i`: exit 0, the home removed. */
function retired(r, i, what) {
  assert.equal("status" in r ? r.status : r.code, 0, `${what}: ${r.stdout}${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).retired, i.name, what);
  assert.equal(existsSync(i.home), false, `${what}: the home is removed`);
}
/** A gated child's result once it has exited; no gate of it went on by itself. */
async function ended(run) {
  const r = await run.done;
  assert.deepEqual(r.timedOut, [], "every gate was released by the test: the kernel did not go on by itself");
  return r;
}
/** `r` is a stop apply refused because the claim of `target` is held by `pid` with the verb
 *  `action`: E_INSTANCE_RETIRING beside a retire, E_LIFECYCLE_BUSY (`holder: "running"`) beside a
 *  stop. `details` is exactly `{ instance, home, lock, pid, since, action, plan }` (+ `holder`):
 *  `instance` and `home` are the target's whose claim refused, `action` is the HOLDER's verb, and
 *  `plan` is the stop plan the apply read, of `planned`. */
function refusedByHolder(r, { target, action, pid, planned = target }, what) {
  const error = refusal(r, action === "retire" ? "E_INSTANCE_RETIRING" : "E_LIFECYCLE_BUSY", what);
  const held = readJson(target.lock), { plan, ...details } = error.details;
  // A record without a verb is a retire's: a kernel before `lifecycle-claim-stop` wrote none.
  assert.deepEqual([held.action ?? "retire", held.pid], [action, pid], `${what}: fixture premise, who holds the claim of ${target.name}`);
  assert.deepEqual(details, { instance: target.name, home: target.home, lock: target.lock, pid, since: held.at, action, ...(action === "stop" ? { holder: "running" } : {}) }, what);
  assert.equal(error.message, action === "retire" ? `${target.name} is being retired (pid ${pid}, since ${held.at}); nothing was stopped — if it does not end, check that pid by hand, and if it is not an oats retire, remove ${target.lock}, then retry`
    : `a stop of ${target.name} is already running (pid ${pid}, since ${held.at}); nothing was stopped — wait for it to finish; if it does not end, check that pid by hand, and if it is not an oats instance stop, remove ${target.lock}, then retry`, what);
  assert.deepEqual([plan.action, plan.instance, plan.home], ["stop", planned.name, planned.home], `${what}: details.plan is the stop plan the apply read`);
  // That plan was read before the claim was asked for: it shows the holder, as any plan does.
  assert.deepEqual(flags(plan).find((shown) => shown.instance === target.name), { instance: target.name, retiring: action === "retire", stopPending: action === "stop" }, `${what}: details.plan shows the holder`);
  return error;
}
/** What a receipt's row says of `i`, without the session's state word. */
const row = (r) => ({ instance: r.instance, home: r.home, ok: r.ok, stopped: r.stopped, alreadyIdle: r.alreadyIdle });
const stoppedRow = (i) => ({ instance: i.name, home: i.home, ok: true, stopped: true, alreadyIdle: false });
const idleRow = (i) => ({ instance: i.name, home: i.home, ok: true, stopped: false, alreadyIdle: true });

// ---- the fixture --------------------------------------------------------------------------------

/** A retire hook that records each run in `<agents root>/retire-hook-ran-<instance>`, outside every home. */
const HOOK = `import { appendFileSync } from "node:fs";
import { join } from "node:path";
appendFileSync(join(process.env.OATS_ROOT, "retire-hook-ran-" + process.env.OATS_INSTANCE), "ran\\n");
console.log(JSON.stringify({ meta: { retired: true } }));
`;

/** A deployment whose soul `worker` works in a directory and has a capability with that retire
 *  hook. `add(name, { launch, parent })` spawns an instance of it through the kernel's own spawn:
 *  not launched unless asked; launched, a stand-in harness runs for it in a window of the fixture's
 *  own tmux server (its private TMUX_TMPDIR, which the fixture's cleanup kills by socket). The
 *  stand-in is the fixture's own file, named by its absolute path in a launch configuration: it
 *  says which process it is, then idles, and ends on SIGTERM. */
function deployment(t) {
  const fx = v2Deployment({ t,
    souls: { worker: { soul: { work: "directory", capabilities: { "test.stop-claim": { from: "here" } } } } },
    capabilities: { "test.stop-claim": { manifest: { hooks: { retire: "hook.mjs" } }, files: { "hook.mjs": HOOK } } },
  });
  const pids = join(fx.base, "harness-pids"), executable = join(fx.base, "harness-stand-in"), localFile = join(fx.dep, "oats-local.yaml");
  mkdirSync(pids);
  writeFixtureExecutable(fx.base, executable, `#!/bin/sh\necho $$ > '${pids}'/"$OATS_INSTANCE"\nexec sleep 600\n`);
  writeFileSync(localFile, YAML.stringify({ ...YAML.parse(readFileSync(localFile, "utf8")), "launch-configs": { "stand-in": { harness: "pi", executable } } }, { lineWidth: 0 }));
  let gated = 0;
  const d = {
    fx,
    async add(name, { launch = false, parent } = {}) {
      // An in-process spawn finds its harness on this process's PATH: the fixture's inert ones.
      const hostPath = process.env.PATH;
      process.env.PATH = fx.env.PATH;
      let home;
      try { ({ home } = await fx.spawn("worker", { name, ...(launch ? { launch: true, launchConfig: "stand-in" } : {}), ...(parent ? { relativeTo: parent.name, relation: "child" } : {}) })); } finally { process.env.PATH = hostPath; }
      assert.equal(home, join(fx.root, "worker", "instances", name), "fixture premise: where the home is");
      const record = readJson(join(home, "instance.json"));
      assert.deepEqual([record.launched === true, record.parentInstance ?? null], [launch, parent?.name ?? null], `fixture premise: what ${name} records of its launch and of its parent`);
      const i = { name, home, lock: claimOf(home), record: join(home, "instance.json"), receipt: (key) => join(home, `.oats-stop-receipt.${key}.json`),
        /** Its rows in the workspace event log, as bytes. */
        events: () => { try { return readFileSync(join(fx.dep, ".agents", "events", `worker--${name}.jsonl`), "utf8"); } catch (e) { if (e.code === "ENOENT") return ""; throw e; } },
        hookRuns: () => { try { return readFileSync(join(fx.root, `retire-hook-ran-${name}`), "utf8").split("\n").filter(Boolean).length; } catch (e) { if (e.code === "ENOENT") return 0; throw e; } },
        recoveries: () => { const dir = join(dirname(home), ".oats-retirement", "recovery"); return existsSync(dir) ? readdirSync(dir).filter((entry) => entry.startsWith(`${name}-`) || entry.startsWith(`.${name}-`)) : []; } };
      assert.equal(i.lock, retireClaimPath(home), "the claim's path is contract: <instances>/.oats-retirement/claims/<instance>.lock");
      if (launch) {
        const read = () => { try { const text = readFileSync(join(pids, name), "utf8").trim(); return /^\d+$/.test(text) && Number(text) > 1 ? Number(text) : null; } catch { return null; } };
        await waitUntil(() => read() !== null && alive(read()), `the stand-in harness of ${name} to run`);
        i.pid = read();
      }
      return i;
    },
    plan: (name, what = `the stop plan of ${name}`) => result(fx.cli(["instance", "stop", name, "--plan", "--json"]), what),
    /** The stop plan of `name`, read once every launched target's pane reads as a running harness
     *  (the session's state is part of the plan's revision). */
    async runningPlan(name) {
      let plan;
      await waitUntil(() => { plan = d.plan(name); return plan.targets.every((target) => !target.launched || (target.session.present === true && target.session.state !== "shell")); }, `every launched session under ${name} to read as running`);
      return plan;
    },
    applyArgs: (name, revision, key, extra = []) => ["instance", "stop", name, "--apply", "--plan-revision", revision, "--idempotency-key", key, "--json", ...extra],
    apply: (name, revision, key, extra) => fx.cli(d.applyArgs(name, revision, key, extra)),
    /** `oats <args>` as a child held at `gate` (named "held"), each in a gate directory of its own, outside the deployment. */
    held: (args, gate) => startGated([CLI, ...args], { cwd: fx.dep, env: fx.env, gateDir: join(fx.base, "gates", String(++gated)), gates: [{ name: "held", ...gate }] }),
    heldApply: (name, revision, key, gate) => d.held(d.applyArgs(name, revision, key), gate),
    heldRetire: (name, gate) => d.held(["retire", name, "--json"], gate),
  };
  return d;
}

// ---- #866: a stop beside a retire ----------------------------------------------------------------

/** The phases a plain `oats retire <name> --json` is held at, each at one call of its own.
 *  `premise` holds what the phase means, on disk, before the stop is tried. */
const RETIRE_PHASES = [
  // The claim is taken and nothing of the home was read under it (`reached.phase` "before-effects").
  { key: "a", id: "before any effect, right after it took the claim", launch: true, gate: (i) => claimTaken(i.lock),
    premise: (i) => assert.deepEqual([alive(i.pid), i.hookRuns(), i.recoveries()], [true, 0, []], "the retire has stopped nothing, run no hook and copied nothing") },
  // Each of a retire's three inspections reads the file's entry once (test/lifecycle-paused-errors.test.mjs):
  // the second read is the inspection after the session stop ("before-hooks").
  { key: "b", id: "before its hooks, once it has stopped the session", launch: true, gate: (i) => ({ fn: "lstatSync", path: i.note, nth: 2 }),
    premise: async (i) => { await waitUntil(() => !alive(i.pid), "the harness the retire stopped to be gone"); assert.deepEqual([i.hookRuns(), i.recoveries()], [0, []], "no hook has run and no recovery is written"); } },
  // The first read of the file's entry once the hook has left its record: the inspection after the hooks ("after-hooks").
  { key: "c", id: "after its hooks", launch: false, gate: (i, d) => ({ fn: "lstatSync", path: i.note, armed: join(d.fx.root, `retire-hook-ran-${i.name}`) }),
    premise: (i) => assert.deepEqual([i.hookRuns(), i.recoveries().length], [1, 1], "the retire hook ran, after the pre-hook recovery was written") },
  // The removal itself ("removal"): the home is whole, and is the next thing to go.
  { key: "d", id: "at the removal of the home", launch: false, gate: (i) => ({ fn: "rmSync", path: i.home }),
    premise: (i) => assert.deepEqual([i.hookRuns(), existsSync(i.record)], [1, true], "the hooks ran and the home is still whole") },
];

test("a stop beside a retire held at each of its phases is refused E_INSTANCE_RETIRING, naming the retire, whatever revision it carries; it writes nothing into the home, and the retire completes (awebai/oats#866)", TMUX, async (t) => {
  // Before: the stop plan read `retiring` from the pending marker of a self-retire only, so beside a
  // plain retire it said `retiring: false`. The apply took no claim: it wrote `.oats-stop-pending.json`
  // into the home the retire was inspecting, copying or removing, stopped the session if one ran
  // (writing `.oats-stop.json` and an event), wrote its receipt there, and answered `ok: true`.
  const d = deployment(t);
  for (const phase of RETIRE_PHASES) {
    await t.test(phase.id, async () => {
      const i = await d.add(`r-${phase.key}`, { launch: phase.launch });
      // The home's own bytes: what makes the retire write a recovery, and the entry its walk is held at.
      i.note = join(i.home, "notes", "held.md");
      mkdirSync(dirname(i.note));
      writeFileSync(i.note, "the retire's walk is held at this entry\n");
      const early = phase.launch ? await d.runningPlan(i.name) : d.plan(i.name);
      assert.deepEqual(flags(early), [idle(i)], "the plan made before the retire began");
      const run = d.heldRetire(i.name, phase.gate(i, d));
      try {
        await run.waitGate("held");
        assert.equal(run.child.exitCode, null, "the retire is held, not finished");
        await phase.premise(i);
        const shown = d.plan(i.name, "the stop plan read while the retire is held");
        assert.deepEqual(flags(shown), [{ instance: i.name, retiring: true, stopPending: false }], "the plan shows the retire that holds the claim");
        assert.ok(shown.notes.includes("a target is being retired; apply will refuse it"), JSON.stringify(shown.notes));
        assert.notEqual(early.planRevision, shown.planRevision, "the plan made before the retire is stale by now");
        // The retire is held at one call: nothing but the stop could change the home meanwhile, so
        // the whole home is compared, byte for byte, at every phase.
        const before = { home: listing(i.home), events: i.events(), claim: readFileSync(i.lock, "utf8"), recoveries: i.recoveries(), stopFiles: stopFiles(i.home) };
        // A retire records the stop of the session it ends before it ends it (#1559): once it has
        // stopped the session, that record is the retire's, there before the stop arrives.
        assert.deepEqual(before.stopFiles, phase.key === "b" ? [".oats-stop.json"] : [], "fixture premise: the stop files in the home are the retire's own");
        // The holder is answered before the revision is compared: never E_PLAN_STALE.
        for (const [what, revision, key] of [["with the revision of the plan read while the retire is held", shown.planRevision, "s1"], ["with the revision of a plan made before the retire began", early.planRevision, "s2"]]) {
          refusedByHolder(d.apply(i.name, revision, key), { target: i, action: "retire", pid: run.child.pid }, what);
          assert.deepEqual(listing(i.home), before.home, `${what}: the stop wrote nothing into the home, and changed nothing of it`);
          assert.deepEqual(stopFiles(i.home), before.stopFiles, `${what}: no stop marker, no stop record, no receipt and no private file of a write`);
          assert.equal(i.events(), before.events, `${what}: the stop appended no event`);
          assert.deepEqual([readFileSync(i.lock, "utf8"), i.recoveries()], [before.claim, before.recoveries], `${what}: the claim is the retire's, as it was, and its recovery is untouched`);
          if (phase.key === "a") assert.equal(alive(i.pid), true, `${what}: nothing was stopped`);
        }
        run.release("held");
        retired(await ended(run), i, "the retire, released");
        assert.deepEqual([i.hookRuns(), claimFiles(i.home)], [1, []], "the stop did not disturb it: one hook run, and no claim is left");
      } finally { await run.finish(); }
    });
  }
});

test("a retire that arrives while a stop holds the claim (plain, guarded, guarded and stale, --force) is refused E_LIFECYCLE_BUSY at once, naming the stop; the home and the session are as they were, and the stop completes", TMUX, async (t) => {
  // Before: a stop took no claim, so a retire knew nothing of it: the retire stopped the session
  // itself, ran its hooks and removed the home while the stop was still working in it.
  const d = deployment(t);
  const i = await d.add("s1", { launch: true });
  const shown = await d.runningPlan(i.name);
  const retireRevision = result(d.fx.cli(["retire", i.name, "--plan", "--json"]), "the retire plan").planRevision;
  const before = { home: listing(i.home), events: i.events() };
  const run = d.heldApply(i.name, shown.planRevision, "k1", beforeFirstStop(i.home));
  try {
    await run.waitGate("held");
    const { text: claim, record: held } = heldClaim(i, "stop", run.child.pid, "the stop is held with the home's claim taken");
    const beside = d.plan(i.name, "another plan, read while the stop is held");
    assert.deepEqual(flags(beside), [{ instance: i.name, retiring: false, stopPending: true }], "a plan shows the stop that holds the claim");
    assert.ok(beside.notes.includes("a stop holds a target's claim; apply will refuse it until that stop has ended") && !shown.notes.some((note) => note.includes("a stop holds")), `and says so in a note, which the plan read before had not: ${JSON.stringify(beside.notes)}`);
    assert.equal(beside.planRevision, shown.planRevision, "stopPending is no input of the plan's revision");
    for (const [what, extra] of [["plain", []], ["guarded", ["--plan-revision", retireRevision, "--idempotency-key", "r-shown"]],
      ["guarded, a stale revision", ["--plan-revision", STALE, "--idempotency-key", "r-stale"]], ["--force", ["--force"]]]) {
      const error = refusal(d.fx.cli(["retire", i.name, "--json", ...extra]), "E_LIFECYCLE_BUSY", what);
      // Exactly these keys: no `reached`, which a retire answers once it holds the claim.
      assert.deepEqual(error, { code: "E_LIFECYCLE_BUSY", message: `a stop of ${i.name} is already running (pid ${held.pid}, since ${held.at}); nothing was done — wait for it to finish; if it does not end, check that pid by hand, and if it is not an oats instance stop, remove ${i.lock}, then retry`,
        details: { instance: i.name, home: i.home, lock: i.lock, pid: held.pid, since: held.at, action: "stop", holder: "running" } }, what);
      assert.deepEqual(listing(i.home), before.home, `${what}: the home is byte-identical`);
      assert.deepEqual([alive(i.pid), i.hookRuns(), i.recoveries(), readFileSync(i.lock, "utf8"), i.events()], [true, 0, [], claim, before.events], `${what}: the session runs, no hook ran, nothing was copied, the claim is the stop's, and no plan was read`);
    }
    for (const key of ["r-shown", "r-stale"]) assert.equal(existsSync(join(dirname(i.home), `.oats-retire-receipt.${key}.json`)), false, `${key}: the refused apply recorded nothing`);
    run.release("held");
    const receipt = result(await ended(run), "the stop, released");
    assert.deepEqual([receipt.ok, receipt.replayed, receipt.results.map(row)], [true, false, [stoppedRow(i)]], "the stop completed");
    assert.deepEqual([alive(i.pid), claimFiles(i.home)], [false, []], "the harness is gone and the claim is released");
  } finally { await run.finish(); }
  // Nothing is owed: the same retire, with nobody holding the claim, retires the instance.
  retired(d.fx.cli(["retire", i.name, "--json"]), i, "a retire once the stop has ended");
});

// ---- several targets -----------------------------------------------------------------------------

/** A parent `p` and its recorded children `c1` and `c2`, each launched. Their claims sort `c1`, `c2`, `p`. */
async function family(d) {
  const p = await d.add("p", { launch: true });
  const c1 = await d.add("c1", { launch: true, parent: p }), c2 = await d.add("c2", { launch: true, parent: p });
  const plan = await d.runningPlan(p.name);
  assert.deepEqual(plan.targets.map((target) => target.instance), ["c1", "c2", "p"], "fixture premise: the plan's targets, deepest first");
  return { p, c1, c2, all: [c1, c2, p], plan };
}

test("a recursive stop whose second child's claim is held (by a live process whose claim says stop, by a stop of that child, by a retire of that child) is refused whole: the answer names the child, nothing is stopped, and every claim it took is released", TMUX, async (t) => {
  // Before: the apply took no claim. With a retire of the child in flight it stopped the parent and
  // the first child, and wrote its marker and its record into the child the retire was working in.
  const d = deployment(t);
  const { p, c1, c2, all, plan } = await family(d);
  const untouched = (what, live = all) => {
    assert.deepEqual(live.map((i) => alive(i.pid)), live.map(() => true), `${what}: nothing was stopped`);
    assert.deepEqual(claimFiles(p.home), ["c2.lock"], `${what}: the claim of c1, which the apply took first, is released; that of p was never taken`);
    assert.deepEqual([p, c1].map((i) => stopFiles(i.home)), [[], []], `${what}: no record of a stop, and no receipt`);
  };

  // A claim written by hand, naming a live process this test started.
  const holder = spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    const start = processStartToken(holder.pid);
    assert.ok(start, "fixture premise: the start of the process that holds the claim can be read");
    writeClaim(c2.home, { action: "stop", pid: holder.pid, processStart: start });
    const claim = readFileSync(c2.lock, "utf8");
    refusedByHolder(d.apply(p.name, plan.planRevision, "by-hand"), { target: c2, action: "stop", pid: holder.pid, planned: p }, "a claim written by hand");
    untouched("a claim written by hand");
    assert.equal(readFileSync(c2.lock, "utf8"), claim, "the claim of c2 still names its holder");
    rmSync(c2.lock);
  } finally {
    holder.kill("SIGKILL"); // a pid this test started
    await new Promise((resolve) => (holder.exitCode !== null || holder.signalCode !== null ? resolve() : holder.once("exit", resolve)));
  }

  // A stop of the child alone, held with its claim taken.
  const stop = d.heldApply(c2.name, (await d.runningPlan(c2.name)).planRevision, "child", beforeFirstStop(c2.home));
  try {
    await stop.waitGate("held");
    assert.deepEqual(flags(d.plan(p.name)), [idle(c1), { instance: "c2", retiring: false, stopPending: true }, idle(p)], "the parent's plan shows the child's stop");
    refusedByHolder(d.apply(p.name, plan.planRevision, "beside-stop"), { target: c2, action: "stop", pid: stop.child.pid, planned: p }, "beside a stop of the child");
    untouched("beside a stop of the child");
    stop.release("held");
    assert.deepEqual(result(await ended(stop), "the child's stop, released").results.map(row), [stoppedRow(c2)]);
  } finally { await stop.finish(); }

  // A retire of the child, held right after it took the claim. The child's session is stopped by
  // now, so the parent's plan no longer reads as it was shown: the holder is still answered first.
  const retire = d.heldRetire(c2.name, claimTaken(c2.lock));
  try {
    await retire.waitGate("held");
    const now = d.plan(p.name, "the parent's plan while the child's retire is held");
    assert.deepEqual(flags(now), [idle(c1), { instance: "c2", retiring: true, stopPending: false }, idle(p)], "the parent's plan shows the child's retire");
    assert.notEqual(now.planRevision, plan.planRevision);
    for (const [what, revision, key] of [["beside a retire of the child", now.planRevision, "beside-retire"], ["beside a retire of the child, with a stale revision", plan.planRevision, "beside-retire-stale"]]) {
      refusedByHolder(d.apply(p.name, revision, key), { target: c2, action: "retire", pid: retire.child.pid, planned: p }, what);
      untouched(what, [c1, p]);
    }
    retire.release("held");
    retired(await ended(retire), c2, "the child's retire, released");
  } finally { await retire.finish(); }

  // Nothing is owed: the parent's stop, with nobody holding a claim, stops what is left.
  const receipt = result(d.apply(p.name, (await d.runningPlan(p.name)).planRevision, "after"), "the parent's stop once nobody holds a claim");
  assert.deepEqual([receipt.ok, receipt.results.map(row)], [true, [stoppedRow(c1), stoppedRow(p)]]);
  assert.deepEqual([alive(c1.pid), alive(p.pid), claimFiles(p.home)], [false, false, []]);
  for (const key of ["by-hand", "beside-stop", "beside-retire", "beside-retire-stale"]) assert.equal(existsSync(p.receipt(key)), false, `${key}: the refused apply recorded no receipt`);
});

test("two overlapping recursive stops of one parent: the second is refused whole, naming the target whose claim sorts first, and stops nothing; the first stops every target, once", TMUX, async (t) => {
  // Before: a second apply was refused only once the first had written its markers (E_LIFECYCLE_BUSY,
  // "c1, c2, p already have a stop in progress", with no holder); before that instant both went on,
  // and each signalled the same harnesses.
  const d = deployment(t);
  const { p, c1, all, plan } = await family(d);
  const stops = () => all.map((i) => i.events().split("\n").filter(Boolean).filter((line) => JSON.parse(line).kind === "stopped").length);
  const a = d.heldApply(p.name, plan.planRevision, "a", beforeFirstStop(plan.targets[0].home));
  try {
    await a.waitGate("held");
    assert.deepEqual(claimFiles(p.home), ["c1.lock", "c2.lock", "p.lock"], "the first stop holds the claim of every target");
    for (const i of all) heldClaim(i, "stop", a.child.pid, `the claim of ${i.name} is the first stop's`);
    refusedByHolder(d.apply(p.name, plan.planRevision, "b"), { target: c1, action: "stop", pid: a.child.pid, planned: p }, "the second stop");
    assert.deepEqual([all.map((i) => alive(i.pid)), stops(), all.map((i) => stopFiles(i.home))], [[true, true, true], [0, 0, 0], [[], [], []]], "the second stop stopped nothing and wrote nothing");
    assert.deepEqual(all.map((i) => readJson(i.lock).pid), all.map(() => a.child.pid), "every claim is still the first stop's");
    a.release("held");
    const receipt = result(await ended(a), "the first stop, released");
    assert.deepEqual([receipt.ok, receipt.idempotencyKey, receipt.results.map(row)], [true, "a", all.map(stoppedRow)], "the first stop stopped all three");
  } finally { await a.finish(); }
  assert.deepEqual([all.map((i) => alive(i.pid)), stops(), claimFiles(p.home)], [[false, false, false], [1, 1, 1], []], "each harness is gone, each was stopped exactly once, and no claim is left");
  assert.deepEqual([existsSync(p.receipt("a")), existsSync(p.receipt("b"))], [true, false], "one receipt: the refused apply recorded none");
  // The second, sent again: there is nothing left to stop twice.
  const again = refusal(d.apply(p.name, plan.planRevision, "b"), "E_PLAN_STALE", "the second stop, sent again");
  assert.deepEqual(stops(), [1, 1, 1]);
  assert.deepEqual(Object.keys(again.details), ["plan"]);
});

// ---- the idempotency key, the plan and the claim ---------------------------------------------------

test("the same idempotency key while the first apply still holds the claims is refused E_LIFECYCLE_BUSY, since its receipt is not written yet; once the first has ended, the key replays its receipt", async (t) => {
  // Before: the same code, from the marker in the home: "<name> already has a stop in progress", with
  // no holder, no pid and no `details.holder`, and only once the first apply had written its marker.
  const d = deployment(t);
  const i = await d.add("n1");
  const shown = d.plan(i.name);
  const first = d.heldApply(i.name, shown.planRevision, "same", beforeFirstStop(i.home));
  let receipt;
  try {
    await first.waitGate("held");
    heldClaim(i, "stop", first.child.pid, "the first apply is held with the home's claim taken");
    refusedByHolder(d.apply(i.name, shown.planRevision, "same"), { target: i, action: "stop", pid: first.child.pid }, "the same key and revision, while the first holds the claim");
    assert.equal(existsSync(i.receipt("same")), false, "there is no receipt to replay yet");
    first.release("held");
    receipt = result(await ended(first), "the first apply, released");
  } finally { await first.finish(); }
  assert.deepEqual([receipt.replayed, receipt.results.map(row)], [false, [idleRow(i)]]);
  assert.deepEqual(result(d.apply(i.name, shown.planRevision, "same"), "the same key, once the first has ended"), { ...receipt, replayed: true }, "the key replays the first receipt");
  assert.deepEqual(claimFiles(i.home), [], "a replay leaves no claim");
  // A replay comes before any claim: it reads a receipt, and is answered beside a live holder too.
  writeClaim(i.home, { action: "retire" });
  assert.deepEqual(result(d.apply(i.name, STALE, "same"), "the same key, beside a live holder"), { ...receipt, replayed: true }, "the key replays, whoever holds the claim and whatever revision it carries");
  refusedByHolder(d.apply(i.name, shown.planRevision, "another"), { target: i, action: "retire", pid: process.pid }, "the control: another key, beside that holder");
});

test("E_PLAN_STALE comes from the one comparison made under the claims: a self-retire scheduled after the plan was shown is answered with the fresh plan, in which the apply's own claim is no stop in progress; with that plan's revision the answer is E_INSTANCE_RETIRING", TMUX, async (t) => {
  // Before: one plan, read before anything was taken and compared then; nothing was read again, so
  // the first half below had no place to happen (the old apply reaches no claim, and stops the
  // instance). The second half, a retire scheduled before the apply began, answered the same two codes.
  const d = deployment(t);
  const i = await d.add("p1", { launch: true });
  const marker = join(dirname(i.home), `.oats-retire-pending-${i.name}.json`);
  assert.equal(marker, retirePendingMarkerPath(i.home), "the pending marker of a self-retire, beside the homes");
  const shown = await d.runningPlan(i.name);
  const before = listing(i.home);
  const stale = (r, what) => {
    const error = refusal(r, "E_PLAN_STALE", what);
    const plan = error.details.plan;
    assert.deepEqual(Object.keys(error.details), ["plan"], what);
    assert.equal(error.message, `the stop plan changed since it was shown (${shown.planRevision} → ${plan.planRevision}); review the fresh plan`, what);
    assert.deepEqual(flags(plan), [{ instance: i.name, retiring: true, stopPending: false }], `${what}: the fresh plan shows the scheduled retire, and not this apply's own claim`);
    assert.deepEqual([alive(i.pid), listing(i.home), claimFiles(i.home)], [true, before, []], `${what}: nothing was stopped or written, and the claim is released`);
    return plan;
  };
  // The self-retire is scheduled while the apply holds its claim, between its two reads of the plan.
  const run = d.heldApply(i.name, shown.planRevision, "held", claimTaken(i.lock));
  try {
    await run.waitGate("held");
    assert.deepEqual(flags(d.plan(i.name, "a plan read by another command")), [{ instance: i.name, retiring: false, stopPending: true }], "to any other command, the apply's claim is a stop in progress");
    writeFileSync(marker, JSON.stringify({ instance: i.name, requestedAt: AT }) + "\n");
    run.release("held");
    stale(await ended(run), "scheduled while the apply held its claim");
  } finally { await run.finish(); }
  // The same answer when it was scheduled before the apply began.
  const fresh = stale(d.apply(i.name, shown.planRevision, "old"), "scheduled before the apply began");
  const retiring = refusal(d.apply(i.name, fresh.planRevision, "fresh"), "E_INSTANCE_RETIRING", "with the revision of the fresh plan");
  assert.equal(retiring.message, `${i.name} is being retired; nothing was stopped`);
  assert.deepEqual([Object.keys(retiring.details), retiring.details.plan.planRevision, flags(retiring.details.plan)], [["plan"], fresh.planRevision, [{ instance: i.name, retiring: true, stopPending: false }]]);
  assert.deepEqual([alive(i.pid), listing(i.home), claimFiles(i.home)], [true, before, []], "nothing was stopped or written, and the claim is released");
  // No key was used: once the marker is gone, the plan as it was shown applies.
  rmSync(marker);
  assert.deepEqual(result(d.apply(i.name, shown.planRevision, "old"), "the plan as it was shown, once nothing is scheduled").results.map(row), [stoppedRow(i)]);
});

test("a marker an older kernel left in the home (.oats-stop-pending.json) is no stop in progress: a plan does not show it, an apply removes it and stops the instance; one that cannot be removed is a warning on stderr, and the stop goes on", TMUX, async (t) => {
  // Before: the file WAS the stop in progress. The plan said `stopPending: true` and every apply
  // answered E_LIFECYCLE_BUSY, "<name> already has a stop in progress".
  const d = deployment(t);
  const left = { action: "stop", idempotencyKey: "an-older-kernel", planRevision: STALE, at: AT };
  const RECEIPT_KEYS = ["action", "at", "home", "idempotencyKey", "instance", "lifecycleApi", "ok", "planRevision", "replayed", "results", "retained"];

  const i = await d.add("m1", { launch: true });
  const marker = join(i.home, ".oats-stop-pending.json");
  writeFileSync(marker, JSON.stringify(left, null, 2));
  const shown = await d.runningPlan(i.name);
  assert.deepEqual(flags(shown), [idle(i)], "the plan shows no stop in progress");
  const went = d.apply(i.name, shown.planRevision, "k1");
  const receipt = result(went, "an apply over the marker");
  assert.deepEqual([receipt.ok, receipt.results.map(row), went.stderr], [true, [stoppedRow(i)], ""]);
  assert.deepEqual([existsSync(marker), alive(i.pid), claimFiles(i.home)], [false, false, []], "the marker is gone, the harness is stopped, the claim is released");

  // A directory of that name, with something in it: `rmSync(path, { force: true })` does not remove it.
  const j = await d.add("m2", { launch: true });
  const stuck = join(j.home, ".oats-stop-pending.json");
  mkdirSync(stuck);
  writeFileSync(join(stuck, "kept"), "not a marker\n");
  const plan = await d.runningPlan(j.name);
  assert.deepEqual(flags(plan), [idle(j)]);
  const r = d.apply(j.name, plan.planRevision, "k1");
  const answered = result(r, "an apply over a marker that cannot be removed");
  assert.deepEqual(Object.keys(answered).sort(), RECEIPT_KEYS, "the answer is the ordinary receipt: the warning is no key of it");
  assert.deepEqual([answered.ok, answered.replayed, answered.results.map(row)], [true, false, [stoppedRow(j)]], "the stop went on");
  assert.deepEqual(readJson(j.receipt("k1")), { ...answered, lifecycleKernelCodes: true }, "and the stored receipt is the one it printed, with the one field that is the file's alone");
  const lines = r.stderr.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `one line on stderr: ${r.stderr}`);
  assert.ok(lines[0].startsWith(`oats: warning: ${stuck}, a stop marker an older OATS left, could not be removed (`) && lines[0].endsWith("); it refuses nothing, and the stop went on"), lines[0]);
  assert.deepEqual([existsSync(join(stuck, "kept")), alive(j.pid), claimFiles(j.home)], [true, false, []], "the directory is as it was, the harness is stopped, the claim is released");
});

test("a stop apply of an instance that was never launched answers alreadyIdle as before, and takes and releases the home's claim", async (t) => {
  // Before: the same receipt, with no claim taken: a retire could remove the home under it.
  const d = deployment(t);
  const i = await d.add("n1");
  const shown = d.plan(i.name);
  assert.equal(shown.targets[0].session.state, "not-launched");
  const run = d.heldApply(i.name, shown.planRevision, "k1", beforeFirstStop(i.home));
  try {
    await run.waitGate("held");
    const held = heldClaim(i, "stop", run.child.pid, "the apply is held with the home's claim taken").record;
    assert.deepEqual(Object.keys(held).sort(), ["action", "at", "nonce", "pid", "processStart"], "the claim's record");
    assert.deepEqual([held.action, held.pid, held.processStart, /^[0-9a-f]{32}$/.test(held.nonce)], ["stop", run.child.pid, processStartToken(run.child.pid), true], "names the stop, by pid and start");
    run.release("held");
    const receipt = result(await ended(run), "the apply, released");
    assert.deepEqual([receipt.ok, receipt.replayed, receipt.results], [true, false, [{ instance: i.name, home: i.home, ok: true, stopped: false, alreadyIdle: true, state: "not-launched" }]]);
  } finally { await run.finish(); }
  assert.deepEqual([claimFiles(i.home), stopFiles(i.home)], [[], [".oats-stop-receipt.k1.json"]], "the claim is released; the receipt is all the stop wrote");
});

test("--grace-ms out of range (0, 300001, abc) refuses the whole apply as E_BAD_ARGS before the plan: no receipt, nothing written, nothing stopped, and the key is not used", TMUX, async (t) => {
  // Before: each target's stop refused it, after the key was used: the apply answered exit 0 with a
  // receipt of one E_BAD_ARGS row per target, stored under the key, which a corrected apply with
  // that key then replayed instead of stopping anything.
  const d = deployment(t);
  const i = await d.add("g1", { launch: true });
  const shown = await d.runningPlan(i.name);
  const before = listing(i.home);
  for (const grace of ["0", "300001", "abc"]) {
    const error = refusal(d.apply(i.name, shown.planRevision, "k1", ["--grace-ms", grace]), "E_BAD_ARGS", `--grace-ms ${grace}`);
    assert.deepEqual(error, { code: "E_BAD_ARGS", message: "stop grace must be 1-300000 ms" }, `--grace-ms ${grace}`);
    assert.deepEqual([existsSync(i.receipt("k1")), listing(i.home), alive(i.pid), claimFiles(i.home)], [false, before, true, []], `--grace-ms ${grace}: no receipt, the home byte-identical, the harness running, no claim taken`);
  }
  // Before the plan: an instance that does not exist is not looked for.
  assert.deepEqual(refusal(d.apply("no-such-instance", shown.planRevision, "k1", ["--grace-ms", "0"]), "E_BAD_ARGS", "an unknown instance"), { code: "E_BAD_ARGS", message: "stop grace must be 1-300000 ms" });
  const receipt = result(d.apply(i.name, shown.planRevision, "k1", ["--grace-ms", "5000"]), "the same key with a valid grace");
  assert.deepEqual([receipt.ok, receipt.replayed, receipt.results.map(row)], [true, false, [stoppedRow(i)]], "the key was not used: this apply acts");
  assert.equal(alive(i.pid), false);
});

test("the plan read again under the claims meets a home that changed: the target's own record unreadable is E_UNIDENTIFIED_INSTANCE_HOME, a child's drops the child out of the plan and is E_PLAN_STALE, the instance itself removed is E_SESSION_UNKNOWN; nothing is stopped and every claim is released", TMUX, async (t) => {
  // Before: there was no second read. An apply acted on the one plan it had read, whatever became
  // of the records between that read and the stop.
  const d = deployment(t);
  /** Cut the record of `i` in half while `run` is held, then let it go on → what it answered. The file is given back. */
  const truncatedUnder = async (run, i) => {
    const bytes = readFileSync(i.record);
    try {
      await run.waitGate("held");
      writeFileSync(i.record, bytes.subarray(0, bytes.length >> 1));
      run.release("held");
      return await ended(run);
    } finally { await run.finish(); writeFileSync(i.record, bytes); }
  };

  const i = await d.add("u1", { launch: true });
  const shown = await d.runningPlan(i.name);
  const own = refusal(await truncatedUnder(d.heldApply(i.name, shown.planRevision, "k1", claimTaken(i.lock)), i), "E_UNIDENTIFIED_INSTANCE_HOME", "the target's own record");
  assert.ok(own.message.startsWith(`${i.record} cannot be read (`) && own.message.includes("; nothing was done. "), own.message);
  assert.deepEqual([alive(i.pid), stopFiles(i.home), claimFiles(i.home)], [true, [], []], "nothing was stopped, no record or receipt of a stop was written, and the claim is released");

  const p = await d.add("u2", { launch: true }), kid = await d.add("u2-kid", { launch: true, parent: p });
  const plan = await d.runningPlan(p.name);
  assert.deepEqual(plan.targets.map((target) => target.instance), [kid.name, p.name]);
  // The claims are taken in the order of their paths: the apply is held once it has the last one.
  const last = [p.lock, kid.lock].sort().pop();
  const stale = refusal(await truncatedUnder(d.heldApply(p.name, plan.planRevision, "k1", claimTaken(last)), kid), "E_PLAN_STALE", "a child's record");
  assert.deepEqual(Object.keys(stale.details), ["plan"]);
  assert.deepEqual(flags(stale.details.plan), [idle(p)], "the fresh plan has the parent alone: the child is nobody's child while its record cannot be read");
  assert.equal(stale.message, `the stop plan changed since it was shown (${plan.planRevision} → ${stale.details.plan.planRevision}); review the fresh plan`);
  assert.deepEqual([alive(p.pid), alive(kid.pid), stopFiles(p.home), stopFiles(kid.home), claimFiles(p.home)], [true, true, [], [], []], "nothing was stopped or written, and both claims are released, the child's too");

  // The home removed by hand under the claim (no retire can: it would need the claim).
  const gone = await d.add("u3");
  const run = d.heldApply(gone.name, d.plan(gone.name).planRevision, "k1", claimTaken(gone.lock));
  try {
    await run.waitGate("held");
    rmSync(gone.home, { recursive: true });
    run.release("held");
    assert.deepEqual(refusal(await ended(run), "E_SESSION_UNKNOWN", "the instance itself removed"), { code: "E_SESSION_UNKNOWN", message: `no instance "${gone.name}" under ${d.fx.root}` });
  } finally { await run.finish(); }
  assert.deepEqual(claimFiles(gone.home), [], "the claim of a home that is gone is released");
});

test("a child that is in the plan read under the claims and was not in the one read before them (its record unreadable then, whole again since) is claimed before anything is done: beside a stop that holds it the apply is refused whole and writes nothing into the child; with nobody on it the apply holds the child's claim while it stops it", async (t) => {
  // Before 5642fd2f: an apply took no claim. With claims taken for the first plan's targets alone,
  // the apply stopped the child under the parent's claim only: it removed the child's marker and
  // answered an ok row for it beside another stop of that child, whose claim it never asked for.
  const d = deployment(t);
  const p = await d.add("p"), kid = await d.add("kid", { parent: p });
  const shown = d.plan(p.name);
  assert.deepEqual(shown.targets.map((target) => target.instance), ["kid", "p"], "fixture premise: the plan the caller was shown");
  const record = readFileSync(kid.record);
  const cutOff = () => writeFileSync(kid.record, record.subarray(0, record.length >> 1));
  // A marker an older kernel left: its removal is the first thing an apply does to a target.
  const marker = join(kid.home, ".oats-stop-pending.json");
  writeFileSync(marker, "{}\n");

  // Beside a stop of the child. The apply reads its first plan while the child's record is cut
  // off (the parent alone), and is held once it has the parent's claim.
  cutOff();
  const refused = d.heldApply(p.name, shown.planRevision, "k1", claimTaken(p.lock));
  try {
    await refused.waitGate("held");
    assert.deepEqual(claimFiles(p.home), ["p.lock"], "the apply holds the parent's claim, the one target of the plan it read");
    writeFileSync(kid.record, record);
    writeClaim(kid.home, { action: "stop" }); // a live holder: this test's own process
    const before = { home: listing(kid.home), claim: readFileSync(kid.lock, "utf8") };
    refused.release("held");
    refusedByHolder(await ended(refused), { target: kid, action: "stop", pid: process.pid, planned: p }, "the child is back, and a stop holds it");
    assert.deepEqual([listing(kid.home), readFileSync(kid.lock, "utf8")], [before.home, before.claim], "nothing was written into the child (its marker is still there), and its claim is its holder's, as it was");
    assert.deepEqual([claimFiles(p.home), stopFiles(p.home)], [["kid.lock"], []], "the parent's claim is released, and no receipt was written");
  } finally { await refused.finish(); }
  rmSync(kid.lock);

  // With nobody on the child: the apply takes its claim too, and holds both when it reaches its first target.
  cutOff();
  const run = startGated([CLI, ...d.applyArgs(p.name, shown.planRevision, "k2")], { cwd: d.fx.dep, env: d.fx.env, gateDir: join(d.fx.base, "gates", "back"),
    gates: [{ name: "held", ...claimTaken(p.lock) }, { name: "stopping", ...beforeFirstStop(kid.home) }] });
  try {
    await run.waitGate("held");
    writeFileSync(kid.record, record);
    run.release("held");
    await run.waitGate("stopping");
    for (const i of [kid, p]) heldClaim(i, "stop", run.child.pid, `before its first target is stopped, the apply holds the claim of ${i.name}`);
    assert.equal(existsSync(marker), true, "and has not touched the child yet");
    run.release("stopping");
    const receipt = result(await ended(run), "the apply, released");
    assert.deepEqual([receipt.ok, receipt.replayed, receipt.results.map(row)], [true, false, [idleRow(kid), idleRow(p)]], "it stopped both, the child first");
    assert.deepEqual([existsSync(marker), claimFiles(p.home)], [false, []], "the marker is gone and every claim is released");
  } finally { await run.finish(); }
});

test("a stop whose targets are others under each read of its plan gives up after three passes, before any effect: E_LIFECYCLE_BUSY with holder none, which says to run it again; nothing was stopped and no claim is left", async (t) => {
  // Before 5642fd2f: an apply read its plan once and acted on it.
  const d = deployment(t);
  const p = await d.add("p");
  const kids = [await d.add("k1", { parent: p }), await d.add("k2", { parent: p }), await d.add("k3", { parent: p })];
  const shown = d.plan(p.name);
  // Each child's record is cut off, and made whole again right after the apply has taken the
  // parent's claim for the Nth time: every plan it reads under its claims names one more target.
  const records = kids.map((kid) => readFileSync(kid.record));
  kids.forEach((kid, n) => writeFileSync(kid.record, records[n].subarray(0, records[n].length >> 1)));
  const before = listing(p.home);
  const run = startGated([CLI, ...d.applyArgs(p.name, shown.planRevision, "k1")], { cwd: d.fx.dep, env: d.fx.env, gateDir: join(d.fx.base, "gates", "moving"),
    gates: kids.map((kid, n) => ({ name: `pass-${n + 1}`, ...claimTaken(p.lock), nth: n + 1 })) });
  let answer;
  try {
    for (const [n, kid] of kids.entries()) {
      await run.waitGate(`pass-${n + 1}`);
      assert.deepEqual(claimFiles(p.home), [...kids.slice(0, n).map((held) => `${held.name}.lock`), "p.lock"], `pass ${n + 1}: the apply holds the claims of the targets it read`);
      writeFileSync(kid.record, records[n]);
      run.release(`pass-${n + 1}`);
    }
    answer = await ended(run);
  } finally { await run.finish(); }
  const error = refusal(answer, "E_LIFECYCLE_BUSY", "the apply whose targets changed under each read");
  const { plan, ...details } = error.details;
  assert.equal(error.message, `the instances a stop of ${p.name} would stop changed each of the 3 times their claims were taken; nothing was stopped — run the command again`);
  assert.deepEqual(details, { instance: p.name, home: p.home, holder: "none" });
  assert.deepEqual(plan.targets.map((target) => target.instance), ["k1", "k2", "k3", "p"], "details.plan is the last plan it read");
  assert.deepEqual([claimFiles(p.home), listing(p.home), kids.map((kid) => stopFiles(kid.home))], [[], before, [[], [], []]], "no claim is left, and nothing was written into any home");
  // Nothing is owed and no key was used: the same apply, on homes that hold still, stops all four.
  const receipt = result(d.apply(p.name, d.plan(p.name).planRevision, "k1"), "the same key, once the homes hold still");
  assert.deepEqual([receipt.replayed, receipt.results.map(row)], [false, [...kids, p].map(idleRow)]);
});

test("a claim that cannot be taken for a reason of the system's refuses the stop as E_LIFECYCLE_FAILED, naming the claim and the system's error: nothing was stopped", TMUX, async (t) => {
  // Before: a stop took no claim, and went on.
  const d = deployment(t);
  const asFile = (path) => { rmSync(path, { recursive: true, force: true }); writeFileSync(path, "a regular file where a kernel directory belongs\n"); };
  /** `r` is the stop refused because the kernel's `mkdir` of `dir`, on the way to the claim, met a
   *  regular file. What the system says of that is read here, with the same call, not assumed: on
   *  Linux it is EEXIST from mkdir (never ENOTDIR: the recursive mkdir meets the file itself). */
  const failed = (r, i, dir, mode, what) => {
    let system;
    try { mkdirSync(dir, { recursive: true, ...mode }); } catch (e) { system = e; }
    assert.ok(system?.code && system.syscall, `fixture premise: the system refuses to make ${dir}`);
    const { exit, doc } = oneAnswer(r, what);
    assert.deepEqual([exit, doc.ok, doc.error?.code], [1, false, "E_LIFECYCLE_FAILED"], `${what}: ${r.stdout}${r.stderr}`);
    assert.equal(doc.error.message, `the claim ${i.lock} could not be taken (${system.message}); nothing was done`, what);
    const { plan, ...details } = doc.error.details;
    assert.deepEqual(details, { cause: { code: system.code, syscall: system.syscall } }, `${what}: the system's error is details.cause, never the answer's code`);
    assert.deepEqual([plan.action, plan.instance], ["stop", i.name], `${what}: details.plan is the plan the apply read`);
    assert.doesNotMatch(r.stderr, /^\s+at /m, `${what}: a system error is no defect, and no stack is printed`);
    assert.deepEqual(stopFiles(i.home), [], `${what}: no record of a stop and no receipt`);
  };
  // The claims directory is a regular file: the session's own authority (the baselines beside it) is whole.
  const i = await d.add("f1", { launch: true });
  const shown = await d.runningPlan(i.name);
  asFile(claimsDir(i.home));
  failed(d.apply(i.name, shown.planRevision, "k1"), i, claimsDir(i.home), { mode: 0o700 }, "the claims directory is a regular file");
  assert.equal(alive(i.pid), true, "nothing was stopped");
  // The retirement directory itself is a regular file (test/lifecycle-door-walk.test.mjs, shape "retfile").
  asFile(dirname(claimsDir(i.home)));
  const plan = d.plan(i.name, "the plan over a retirement directory that is a regular file");
  failed(d.apply(i.name, plan.planRevision, "k2"), i, dirname(claimsDir(i.home)), {}, "the retirement directory is a regular file");
  assert.equal(alive(i.pid), true, "nothing was stopped");
});

test("a stop plan's retiring and stopPending are read from the claim: the holder's verb while its holder is not gone, both false for a holder that is gone and for a file that is no claim, which an apply then refuses", async (t) => {
  // Before: `retiring` was the pending marker of a self-retire and `stopPending` the marker in the
  // home; neither read the claim, and an apply met no claim at all.
  const d = deployment(t);
  const i = await d.add("b1");
  const revision = d.plan(i.name).planRevision;
  /** The plan shows these two booleans; `retiring` is an input of its revision, `stopPending` is not. */
  const shows = (what, retiring, stopPending) => {
    const plan = d.plan(i.name, what);
    assert.deepEqual(flags(plan), [{ instance: i.name, retiring, stopPending }], what);
    assert.equal(plan.planRevision === revision, !retiring, `${what}: the revision ${retiring ? "changed with retiring" : "is the one of the plan with no claim"}`);
  };
  // A live holder, this test's own process: the two verbs, and a record without one (a retire of a kernel before `lifecycle-claim-stop`).
  for (const [what, recorded, action] of [["a live retire", { action: "retire" }, "retire"], ["a live stop", { action: "stop" }, "stop"], ["a live holder that records no verb", {}, "retire"]]) {
    writeClaim(i.home, recorded);
    shows(what, action === "retire", action === "stop");
    refusedByHolder(d.apply(i.name, revision, "k-live"), { target: i, action, pid: process.pid }, what);
    assert.deepEqual([readJson(i.lock).action, stopFiles(i.home)], [recorded.action, []], `${what}: the claim is as it was, and nothing was written`);
  }
  // A holder whose liveness cannot be read (a live pid with no recorded start) is not gone: it counts, and refuses.
  for (const action of ["retire", "stop"]) {
    const what = `a ${action} whose liveness cannot be read`;
    writeClaim(i.home, { action, processStart: undefined });
    shows(what, action === "retire", action === "stop");
    const error = refusal(d.apply(i.name, revision, "k-unknown"), "E_LIFECYCLE_BUSY", what);
    const { plan, ...details } = error.details;
    assert.deepEqual(details, { instance: i.name, home: i.home, lock: i.lock, pid: process.pid, since: AT, action, unknown: details.unknown, holder: "unknown" }, what);
    assert.match(details.unknown, /names no start time/);
    assert.equal(error.message, `whether the ${action} of ${i.name} that holds ${i.lock} (pid ${process.pid}, recorded start none) still runs cannot be read (${details.unknown}); nothing was stopped — check that pid by hand, and if it is not an ${action === "stop" ? "oats instance stop" : "oats retire"}, remove ${i.lock}, then retry`, what);
    assert.equal(plan.instance, i.name);
  }
  // A file that does not read as a claim: nobody is shown, and nobody takes it over.
  writeFileSync(i.lock, "{not json");
  shows("a file that is no claim", false, false);
  const garbage = refusal(d.apply(i.name, revision, "k-garbage"), "E_LIFECYCLE_BUSY", "a file that is no claim");
  const { plan: garbagePlan, ...garbageDetails } = garbage.details;
  assert.deepEqual(garbageDetails, { instance: i.name, home: i.home, lock: i.lock, holder: "unknown" });
  assert.equal(garbage.message, `${i.lock} is not a readable claim; nothing was stopped — inspect it and remove it if no oats retire, oats instance stop, oats instance upgrade, oats session start or oats session restart holds it, then retry`);
  assert.deepEqual([garbagePlan.instance, readFileSync(i.lock, "utf8"), claimFiles(i.home), stopFiles(i.home)], [i.name, "{not json", [`${i.name}.lock`], []], "the file is as it was, and nothing was written");
  // A holder that is gone (a file a killed command left), of either verb: nobody is shown, and the apply takes it over.
  for (const action of ["retire", "stop"]) {
    writeClaim(i.home, { action, pid: exitedPid(), processStart: "proc:1" });
    shows(`a ${action} that is gone`, false, false);
    const receipt = result(d.apply(i.name, revision, `k-gone-${action}`), `an apply over the claim of a ${action} that is gone`);
    assert.deepEqual([receipt.replayed, receipt.results.map(row), claimFiles(i.home)], [false, [idleRow(i)], []], "the claim was taken over, and released");
  }
});

test("the two refusals of a stop in which nobody is running say so (holder: \"none\"), and name what to do: a holder that is gone and whose claim cannot be taken over, and an apply that cannot read its own start", async (t) => {
  // Before: an apply met no claim at all.
  const d = deployment(t);
  const i = await d.add("b2");
  const shown = d.plan(i.name);
  /** `r` is E_LIFECYCLE_BUSY with exactly these details beside `holder: "none"` and the plan → its message. */
  const nobody = (r, expected, what) => {
    const error = refusal(r, "E_LIFECYCLE_BUSY", what), { plan, ...details } = error.details;
    assert.deepEqual([details, plan.instance], [{ instance: i.name, home: i.home, lock: i.lock, ...expected, holder: "none" }, i.name], what);
    assert.doesNotMatch(error.message, /already running|wait for it to finish/, `${what}: nobody is said to be running`);
    assert.deepEqual(stopFiles(i.home), [], `${what}: nothing was written`);
    return error.message;
  };
  // A file a dead command left whose nonce is not a claim's: no takeover can be serialized on it.
  const pid = exitedPid();
  writeClaim(i.home, { action: "stop", pid, processStart: "proc:1", nonce: "short" });
  const left = readFileSync(i.lock, "utf8");
  assert.deepEqual(flags(d.plan(i.name)), [idle(i)], "its holder is gone: the plan shows nobody");
  assert.equal(nobody(d.apply(i.name, shown.planRevision, "k1"), { pid, since: AT, action: "stop" }, "a claim that cannot be taken over"),
    `the process that held ${i.lock} (pid ${pid}) is gone, and this file is not a claim this kernel can take over (its nonce is not the 32 hexadecimal digits a claim carries); nothing was stopped — inspect ${i.lock} and remove it if no oats retire, oats instance stop, oats instance upgrade, oats session start or oats session restart holds it, then retry`);
  assert.equal(readFileSync(i.lock, "utf8"), left, "the file is as it was");
  rmSync(i.lock);
  // A host that does not say when this process started: the stop could not hold its claim verifiably.
  const dir = join(d.fx.base, "ps-fails");
  mkdirSync(dir);
  writeFileSync(join(dir, "ps"), '#!/bin/sh\necho "ps: simulated failure" >&2\nexit 2\n', { mode: 0o755 });
  const said = nobody(d.fx.cli(d.applyArgs(i.name, shown.planRevision, "k2"), { env: { OATS_TEST_PROCESS_START_PS: join(dir, "ps") } }), {}, "its own start cannot be read");
  assert.match(said, /^this process's start time cannot be read \(ps -o lstart= -o stat= -p \d+ answered exit 2: ps: simulated failure\), so oats instance stop cannot hold /);
  assert.ok(said.includes(`cannot hold ${i.lock} verifiably; nothing was stopped — `), said);
  assert.deepEqual(claimFiles(i.home), [], "no claim, and no private file of one, is left");
  // Nothing is owed: no key was used.
  assert.deepEqual(result(d.apply(i.name, shown.planRevision, "k1"), "the first key, once the file is removed").results.map(row), [idleRow(i)]);
});
