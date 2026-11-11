// A retire that takes over from one that was killed does not run again the retire hooks that one
// had finished. A retire records each hook that ended, with the `meta` it answered, in the claim
// it holds (lib/claim.mjs recordInClaim: `retireHooks`, and `retireHooksFor`, the incarnation of
// the home they ran for). The claim is beside the home and outlives a kill; the retire that takes
// it over reads the list, skips those hooks, and judges the cleanup and writes its `retired` row
// with their `meta` as if it had run them. A hook that had not ended is run again.
//
// Only a take-over reads the list. A retire that returns releases its claim, so the retry of a
// quarantined home runs every hook again, as it always did; and a claim without the list, or with
// one that is not this home's, skips nothing.
//
// The retire that is killed is the real one: `oats retire` as a child, or the completion of a
// self-retire run from its intent, held at a call it makes after its hooks
// (test/helpers/fs-gate-preload.mjs) or killed while a hook of the fixture waits.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { deferredRetireResultPath, retireClaimPath, retirePendingMarkerPath } from "../lib/core.mjs";
import { processStartToken } from "../lib/worktree-hooks.mjs";
import { CLI, v2Deployment } from "./helpers/v2-deployment.mjs";
import { killAndReap, waitUntil } from "./helpers/host-fixture.mjs";
import { startGated } from "./helpers/fs-gate-preload.mjs";

const CORE = pathToFileURL(new URL("../lib/core.mjs", import.meta.url).pathname).href;
const WAIT_MS = 120000;
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const gone = (pid) => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === "ESRCH"; } };
/** The two capabilities with a retire hook. A retire runs them in this order. */
const FIRST = "test.b", SECOND = "test.a";
/** What the detached script of a self-retire runs, with no delay and no retry. */
const COMPLETION = `import { completeDeferredRetirement } from ${JSON.stringify(CORE)};
process.exitCode = completeDeferredRetirement(JSON.parse(process.env.OATS_RETIRE_INTENT), { delaySec: 0, retryDelaysMs: [] }) ? 0 : 1;`;
/** The retire hook of the capability `id`. It appends `id` to `<agents root>/retire-hooks.log`.
 *  While `hold-<id>` is beside that log it writes its pid to `<id>-running` and waits for
 *  `<id>-release`. With `incomplete-<id>` there it reports that its cleanup did not finish. */
const hook = (id) => `import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = process.env.OATS_ROOT;
appendFileSync(join(root, "retire-hooks.log"), "${id}\\n");
if (existsSync(join(root, "hold-${id}"))) {
  writeFileSync(join(root, "${id}-running"), String(process.pid));
  for (const end = Date.now() + ${WAIT_MS}; !existsSync(join(root, "${id}-release")) && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 20));
}
console.log(JSON.stringify({ meta: existsSync(join(root, "incomplete-${id}")) ? { retired: false, reason: "asked to" } : { retired: true, by: "${id}" } }));
`;

function deployment(t) {
  const fx = v2Deployment({ t,
    souls: { dev: { soul: { work: "directory", capabilities: { "test.a": { from: "here" }, "test.b": { from: "here" } } } } },
    capabilities: Object.fromEntries(["test.a", "test.b"].map((id) => [id, { manifest: { hooks: { retire: "hook.mjs" } }, files: { "hook.mjs": hook(id) } }])) });
  const at = (name) => join(fx.root, name);
  const f = {
    fx,
    /** A home that was never launched → its name, home, claim, incarnation and workspace log. */
    home: (name) => {
      const r = fx.cli(["spawn", "dev", "--name", name, "--no-launch", "--json"]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const { home } = r.json().result;
      return { name, home, claim: retireClaimPath(home), created: readJson(join(home, "instance.json")).createdAt, log: join(fx.dep, ".agents", "events", `dev--${name}.jsonl`) };
    },
    ask: (what) => writeFileSync(at(what), ""),
    drop: (what) => rmSync(at(what)),
    /** The hooks that ran, in order, by capability. */
    ran: () => (existsSync(at("retire-hooks.log")) ? readFileSync(at("retire-hooks.log"), "utf8").split("\n").filter(Boolean) : []),
    hookPid: (id) => Number(readFileSync(at(`${id}-running`), "utf8")),
    holds: (id) => existsSync(at(`${id}-running`)),
    /** The `retired` rows of the workspace's log of `i`. */
    retired: (i) => readFileSync(i.log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.kind === "retired"),
    /** `oats retire <i> --json` read to its end → its exit status, and its answer's text. */
    retire: (i) => { const r = fx.cli(["retire", i.name, "--json"]); return { status: r.status, said: r.stdout + r.stderr }; },
    /** The argv of a retire of `i` as a child of the test: `oats retire`, or the completion of a
     *  self-retire of it, its marker written as its scheduling writes it. → what follows `node`, and its environment. */
    retirer: (i, kind) => {
      if (kind === "oats retire") return { argv: [CLI, "retire", i.name, "--json"], env: fx.env };
      const intent = { instance: i.name, agent: "dev", root: fx.root, requestedAt: "2026-10-10T00:00:00.000Z", requestedByPid: 1, delaySec: 0, options: { home: i.home, tmuxSession: "oats-agents" }, resultPath: deferredRetireResultPath(i.home) };
      writeFileSync(retirePendingMarkerPath(i.home), JSON.stringify(intent, null, 2) + "\n");
      return { argv: ["--input-type=module", "-e", COMPLETION], env: { ...fx.env, OATS_RETIRE_INTENT: JSON.stringify(intent) } };
    },
  };
  return f;
}
/** What a take-over leaves: the home, its claim and what a self-retire keeps beside it are gone. */
function retiredAway(i) {
  assert.deepEqual([existsSync(i.home), existsSync(i.claim), existsSync(retirePendingMarkerPath(i.home)), existsSync(deferredRetireResultPath(i.home))], [false, false, false, false], "the home, its claim, and a self-retire's marker and outcome are gone");
}
const BOTH_ROWS = [{ capability: FIRST, ok: true, meta: true }, { capability: SECOND, ok: true, meta: true }];

for (const kind of ["oats retire", "the completion of a self-retire"]) {
  test(`${kind} killed after its retire hooks returned: its claim names the hooks that ended, and the retire that takes over runs neither again and writes the one retired row, with both`, async (t) => {
    const f = deployment(t);
    const i = f.home("after-hooks");
    const { argv, env } = f.retirer(i, kind);
    // Held where the retire writes its `retired` row: its hooks have returned, and no row is written.
    const run = startGated(argv, { cwd: f.fx.dep, env, gateDir: join(f.fx.base, "gates"), gates: [{ name: "row", fn: "appendFileSync", path: i.log, when: "before", waitMs: WAIT_MS }] });
    try {
      await run.waitGate("row", WAIT_MS);
      assert.deepEqual(f.ran(), [FIRST, SECOND], "fixture premise: both hooks ran, in this order");
      const claim = readJson(i.claim);
      assert.deepEqual([claim.action, claim.pid], ["retire", run.child.pid], "fixture premise: the retire holds the home's claim");
      assert.deepEqual([claim.retireHooks, claim.retireHooksFor], [[{ capability: FIRST, meta: { retired: true, by: FIRST } }, { capability: SECOND, meta: { retired: true, by: SECOND } }], i.created], "the claim names each hook that ended, with its meta, and the incarnation they ran for");
      run.child.kill("SIGKILL");
      assert.equal((await run.done).signal, "SIGKILL");
    } finally { await run.finish(); }
    assert.deepEqual([existsSync(i.home), f.retired(i)], [true, []], "fixture premise: the killed retire removed nothing and wrote no retired row");

    const over = f.retire(i);
    assert.equal(over.status, 0, over.said);
    assert.deepEqual(f.ran(), [FIRST, SECOND], "each hook ran once in all");
    assert.deepEqual(f.retired(i).map((row) => row.data.hooks), [BOTH_ROWS], "one retired row, which names both hooks with their meta");
    retiredAway(i);
  });
}

test("a retire killed while its second hook runs, the first ended: the retire that takes over skips the first and runs the second again", async (t) => {
  const f = deployment(t);
  const i = f.home("mid-hook");
  f.ask(`hold-${SECOND}`);
  const child = spawn(process.execPath, [CLI, "retire", i.name, "--json"], { cwd: f.fx.dep, env: f.fx.env, stdio: "ignore" });
  const ended = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  await waitUntil(() => f.holds(SECOND) || child.exitCode !== null, "the second hook to run", WAIT_MS);
  assert.deepEqual(f.ran(), [FIRST, SECOND], "fixture premise: the first hook ended and the second runs");
  const claim = readJson(i.claim);
  assert.deepEqual([claim.retireHooks, claim.retireHooksFor], [[{ capability: FIRST, meta: { retired: true, by: FIRST } }], i.created], "the claim names the hook that ended, and not the one that runs");
  child.kill("SIGKILL");
  assert.equal((await ended).signal, "SIGKILL");
  // The hook the killed retire left running is ended by the test: what a take-over does beside
  // one that still runs is not this test's.
  await killAndReap(f.hookPid(SECOND));
  f.drop(`hold-${SECOND}`);

  const over = f.retire(i);
  assert.equal(over.status, 0, over.said);
  assert.deepEqual(f.ran(), [FIRST, SECOND, SECOND], "the first hook ran once in all; the second, which had not ended, ran again");
  assert.deepEqual(f.retired(i).map((row) => row.data.hooks), [BOTH_ROWS], "one retired row, which names both hooks with their meta");
  retiredAway(i);
});

test("a hook that ended reporting that its cleanup did not finish is in the claim with that answer: the retire that takes over does not run it again, and quarantines the home for it", async (t) => {
  const f = deployment(t);
  const i = f.home("owes");
  f.ask(`incomplete-${FIRST}`);
  const run = startGated([CLI, "retire", i.name, "--json"], { cwd: f.fx.dep, env: f.fx.env, gateDir: join(f.fx.base, "gates"), gates: [{ name: "row", fn: "appendFileSync", path: i.log, when: "before", waitMs: WAIT_MS }] });
  try {
    await run.waitGate("row", WAIT_MS);
    run.child.kill("SIGKILL");
    await run.done;
  } finally { await run.finish(); }
  const over = f.retire(i);
  assert.equal(over.status, 1, over.said);
  assert.deepEqual(f.ran(), [FIRST, SECOND], "neither hook ran again");
  assert.deepEqual(readJson(join(i.home, ".oats-rollback-incomplete.json")).cleanup.outstanding.hooks, [FIRST], "the home is quarantined for the hook whose answer the claim held");
  // The retire returned, and released its claim: the retry of the quarantine runs every hook, as it always did.
  assert.equal(existsSync(i.claim), false);
  f.drop(`incomplete-${FIRST}`);
  const retry = f.retire(i);
  assert.equal(retry.status, 0, retry.said);
  assert.deepEqual(f.ran(), [FIRST, SECOND, FIRST, SECOND], "the retry of a quarantined home runs every retire hook again");
  retiredAway(i);
});

test("a retire that returned with the home quarantined left no claim: its retry runs every retire hook again", async (t) => {
  const f = deployment(t);
  const i = f.home("returned");
  f.ask(`incomplete-${SECOND}`);
  const first = f.retire(i);
  assert.equal(first.status, 1, first.said);
  assert.deepEqual([f.ran(), existsSync(i.claim), existsSync(join(i.home, ".oats-rollback-incomplete.json"))], [[FIRST, SECOND], false, true], "fixture premise: both hooks ran, the home is quarantined and the claim is released");
  f.drop(`incomplete-${SECOND}`);
  const retry = f.retire(i);
  assert.equal(retry.status, 0, retry.said);
  assert.deepEqual(f.ran(), [FIRST, SECOND, FIRST, SECOND]);
  retiredAway(i);
});

// The claim of a retire that is gone, written by hand: its holder is a process that has exited.
for (const [what, fields] of [
  ["without the list, as an earlier OATS writes it", () => ({})],
  ["whose list is another incarnation's", () => ({ retireHooks: [{ capability: FIRST, meta: { retired: true } }, { capability: SECOND, meta: { retired: true } }], retireHooksFor: "2020-01-01T00:00:00.000Z" })],
  ["whose list names no incarnation", () => ({ retireHooks: [{ capability: FIRST, meta: { retired: true } }] })],
  ["whose list is not a list of hooks", (created) => ({ retireHooks: { capability: FIRST }, retireHooksFor: created })],
  ["whose list names hooks this home does not have, or gives a meta that is no object", (created) => ({ retireHooks: [{ capability: "test.other" }, { capability: FIRST, meta: "retired" }, "test.a", null], retireHooksFor: created })],
]) {
  test(`a dead retire's claim ${what}: the retire that takes over runs every retire hook`, async (t) => {
    const f = deployment(t);
    const i = f.home("earlier");
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    assert.equal(gone(dead), true, "fixture premise: the holder has exited");
    mkdirSync(dirname(i.claim), { recursive: true });
    writeFileSync(i.claim, JSON.stringify({ action: "retire", pid: dead, processStart: processStartToken(process.pid), nonce: "c".repeat(32), at: "2026-10-10T00:00:00.000Z", ...fields(i.created) }) + "\n");
    const over = f.retire(i);
    assert.equal(over.status, 0, over.said);
    assert.deepEqual(f.ran(), [FIRST, SECOND]);
    assert.deepEqual(f.retired(i).map((row) => row.data.hooks), [BOTH_ROWS]);
    retiredAway(i);
  });
}
