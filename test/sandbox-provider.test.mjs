// Sandboxes, the provider's hook through the CLI (docs/design/2026-11-19-sandboxes.md C4, C5; S1
// Acceptance 4, 5 and 16's answers): which capability provides it, the request each act sends and the
// environment it runs in, how a hook that fails is read, a stale plan, and the per-sandbox lock. The
// provider is the fake (test/helpers/fake-sandbox-provider.mjs); the kernel and the CLI are real.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sandboxDeployment, TEAM_ID } from "./helpers/sandbox-fixture.mjs";
import { CLI } from "./helpers/v2-deployment.mjs";
import { fakeSandboxCapabilities } from "./helpers/fake-sandbox-provider.mjs";

const ok = (r, what) => { assert.equal(r.status, 0, `${what}: ${r.stderr}${r.stdout}`); const d = r.json(); assert.equal(d.ok, true, what); return d.result; };
const refused = (r, code, what) => { assert.notEqual(r.status, 0, `${what}: exit`); const d = r.json(); assert.equal(d.ok, false, `${what}: ${r.stdout}`); assert.equal(d.error.code, code, `${what}: ${d.error.message}`); return d.error; };
const acts = (fx) => fx.sandbox.calls().map((c) => (c.act === "plan" ? `plan:${c.request.target}` : c.act));

test("the provider's settings merge manifest → workspace → host, when it fills a slot (the workspace's payload is a slot's)", (t) => {
  const name = "fixture.tasks-sandbox";
  const fx = sandboxDeployment({ t, capabilities: fakeSandboxCapabilities({ name, layer: "tasks" }) });
  fx.commitWorkspace(fx.workspace({
    defaults: { knowledge: "none", messaging: "none", tasks: { [name]: { from: fx.key } }, capabilities: { "fixture.sandbox": "off" } },
    tasks: { tier: "workspace", zone: "workspace" },
  }));
  fx.writeLocal({ host: { name: "cloud-1" }, sandboxes: ["ingest"], credentials: { "sources-read": { fromFile: fx.credential } }, settings: { [name]: { zone: "host" } } });
  ok(fx.cliS(["sync", "--json"]), "sync");
  fx.sandbox.reset();
  ok(fx.cliS(["sandbox", "status", "--json"]), "status");
  const [call] = fx.sandbox.calls();
  assert.equal(call.env.OATS_CAPABILITY, name);
  assert.equal(call.env.OATS_LAYER, "tasks");
  assert.deepEqual(JSON.parse(call.env.OATS_SETTINGS), { region: "manifest", tier: "workspace", zone: "host" });
  const origins = JSON.parse(call.env.OATS_SETTINGS_ORIGINS);
  assert.deepEqual([origins["/region"].kind, origins["/tier"].kind, origins["/zone"].kind], ["manifest-default", "workspace", "host"]);
  assert.equal(origins["/tier"].at, "oats-workspace.yaml#/tasks");
});

test("provider selection: none composed is E_SANDBOX_PROVIDER none; two are ambiguous, naming both; settings merge manifest → host", (t) => {
  const fx = sandboxDeployment({ t, capabilities: fakeSandboxCapabilities({ name: "fixture.other" }) });
  ok(fx.cliS(["sync", "--json"]), "sync");
  // Host settings win over the manifest's defaults; the rest stay the manifest's.
  fx.writeLocal({ host: { name: "cloud-1" }, sandboxes: ["ingest"], credentials: { "sources-read": { fromFile: fx.credential } }, settings: { "fixture.sandbox": { region: "host" } } });
  fx.sandbox.reset();
  ok(fx.cliS(["sandbox", "status", "--json"]), "status");
  const [call] = fx.sandbox.calls();
  assert.deepEqual(JSON.parse(call.env.OATS_SETTINGS), { region: "host", tier: "manifest", zone: "manifest" });
  const origins = JSON.parse(call.env.OATS_SETTINGS_ORIGINS);
  assert.equal(origins["/region"].kind, "host");
  assert.equal(origins["/tier"].kind, "manifest-default");

  // Two composed providers.
  fx.commitWorkspace(fx.workspace({ defaults: { knowledge: "none", messaging: "none", tasks: "none", capabilities: { "fixture.sandbox": { from: fx.key }, "fixture.other": { from: fx.key } } } }));
  const two = refused(fx.cliS(["sandbox", "start", "ingest", "--plan", "--json"]), "E_SANDBOX_PROVIDER", "two providers");
  assert.equal(two.details.reason, "ambiguous");
  assert.deepEqual(two.details.capabilities, ["fixture.other", "fixture.sandbox"]);
  // None composed: the status says so per sandbox, and an act refuses.
  fx.commitWorkspace(fx.workspace({ defaults: { knowledge: "none", messaging: "none", tasks: "none", capabilities: { "fixture.sandbox": "off" } } }));
  const status = ok(fx.cliS(["sandbox", "status", "--json"]), "status without provider");
  assert.equal(status.sandboxes[0].state, "unknown");
  assert.equal(status.sandboxes[0].problems[0].reason, "none");
  assert.equal(refused(fx.cliS(["sandbox", "start", "ingest", "--plan", "--json"]), "E_SANDBOX_PROVIDER", "no provider").details.reason, "none");
});

test("the hook call: each act's request is the record's, in an environment without kernel names and with the deployment's real path", (t) => {
  const fx = sandboxDeployment({ t });
  ok(fx.cliS(["sync", "--json"]), "sync");
  fx.sandbox.reset();
  const plan = ok(fx.cliS(["sandbox", "start", "ingest", "--plan", "--json"]), "start --plan");
  assert.deepEqual(plan, { sandboxApi: 1, sandbox: "ingest", act: "start", planRevision: "rev-start", actions: [] });
  const applied = ok(fx.cliS(["sandbox", "start", "ingest", "--plan-revision", "rev-start", "--idempotency-key", "k-1", "--json"]), "start");
  assert.deepEqual(applied, { sandboxApi: 1, sandbox: "ingest", act: "start", state: "ready", server: "sandbox-ingest", receipts: [{ step: "start", ok: true }], problems: [] });
  const splan = ok(fx.cliS(["sandbox", "stop", "ingest", "--plan", "--json"]), "stop --plan");
  assert.deepEqual(splan, { sandboxApi: 1, sandbox: "ingest", act: "stop", planRevision: "rev-stop", actions: [{ step: "stop", detail: "stop the containers" }] });
  const stopped = ok(fx.cliS(["sandbox", "stop", "ingest", "--plan-revision", "rev-stop", "--idempotency-key", "k-2", "--json"]), "stop");
  assert.equal(stopped.state, "stopped");
  assert.deepEqual(stopped, { sandboxApi: 1, sandbox: "ingest", act: "stop", state: "stopped", server: "sandbox-ingest", receipts: [{ step: "stop", ok: true }], problems: [] });
  const rplan = ok(fx.cliS(["sandbox", "reconcile", "ingest", "--plan", "--json"]), "reconcile --plan");
  assert.equal(rplan.act, "reconcile");
  assert.deepEqual(rplan, { sandboxApi: 1, sandbox: "ingest", act: "reconcile", planRevision: "rev-reconcile", actions: [] });
  const reconciled = ok(fx.cliS(["sandbox", "reconcile", "ingest", "--plan-revision", "rev-reconcile", "--idempotency-key", "k-3", "--json"]), "reconcile");
  assert.deepEqual(Object.keys(reconciled).sort(), ["act", "problems", "receipts", "replays", "sandbox", "sandboxApi", "seats", "server", "state"]);
  assert.deepEqual(reconciled, { sandboxApi: 1, sandbox: "ingest", act: "reconcile", state: "ready", server: "sandbox-ingest", receipts: [], problems: [], seats: [], replays: [] });
  const calls = fx.sandbox.calls();
  assert.deepEqual(calls.map((c) => (c.act === "plan" ? `plan:${c.request.target}` : c.act)), ["plan:start", "start", "plan:stop", "stop", "plan:reconcile", "reconcile"]);
  const dep = realpathSync(fx.dep);
  for (const c of calls) {
    const { request, env } = c;
    assert.equal(request.sandboxApi, 1);
    assert.equal(request.act, c.act);
    assert.equal(request.sandbox, "ingest");
    assert.equal(request.host, "cloud-1");
    assert.deepEqual(request.team, { label: "ingest-team", id: TEAM_ID });
    assert.deepEqual(request.egress, ["model"]);
    assert.deepEqual(request.credentials, [{ name: "sources-read", path: fx.credential }]);
    assert.match(request.workspace.lock, /^[0-9a-f]{64}$/);
    assert.equal(typeof request.workspace.commit, "string");
    assert.equal(env.OATS_EVENT, "sandbox");
    assert.equal(env.OATS_SANDBOX_ACT, c.act);
    assert.equal(env.OATS_CAPABILITY, "fixture.sandbox");
    assert.equal(env.OATS_LEVEL, "deployment");
    assert.equal(env.OATS_WORKSPACE, dep, "OATS_WORKSPACE is the deployment's real path");
    assert.equal(Object.hasOwn(env, "OATS_DEPLOYMENT"), false, "OATS_DEPLOYMENT is never set");
    for (const name of ["OATS_INSTANCE", "OATS_INSTANCE_HOME", "OATS_TEAMS", "OATS_SPAWN_IDEMPOTENCY_KEY"]) assert.equal(Object.hasOwn(env, name), false, name);
    assert.ok(env.OATS_CLI_BIN && env.OATS_NODE_BIN && env.OATS_ROOT);
  }
  assert.deepEqual(calls[1].request.planRevision, "rev-start");
  assert.deepEqual(calls[1].request.idempotencyKey, "k-1");
  assert.deepEqual(calls[0].request.target, "start");
});

test("a hook that exits nonzero, times out, prints two JSON lines or invalid JSON is unknown with hook-failed", (t) => {
  const fx = sandboxDeployment({ t });
  ok(fx.cliS(["sync", "--json"]), "sync");
  const cases = [
    ["exit", { $exit: 3 }, /exited 3/],
    ["timeout", { $sleepMs: 3000 }, /did not answer within/],
    ["two lines", { $raw: '{"sandboxApi":1,"act":"status","state":"ready","receipts":[]}\n{"sandboxApi":1,"act":"status","state":"ready","receipts":[]}\n' }, /exactly one JSON document/],
    ["invalid", { $raw: "not json" }, /exactly one JSON document/],
  ];
  for (const [what, entry, message] of cases) {
    fx.sandbox.set({ status: entry });
    const s = ok(fx.cliS(["sandbox", "status", "--json"], { OATS_TEST_SANDBOX_HOOK_TIMEOUT_MS: "500" }), what);
    assert.equal(s.sandboxes[0].state, "unknown", what);
    assert.equal(s.sandboxes[0].problems[0].code, "E_SANDBOX_PROVIDER", what);
    assert.equal(s.sandboxes[0].problems[0].reason, "hook-failed", what);
    assert.match(s.sandboxes[0].problems[0].message, message, what);
  }
});

test("a stale plan is E_PLAN_STALE with the provider's fresh plan", (t) => {
  const fx = sandboxDeployment({ t });
  ok(fx.cliS(["sync", "--json"]), "sync");
  const fresh = { planRevision: "rev-2", actions: [{ step: "start" }] };
  fx.sandbox.set({ start: { state: "stale", plan: fresh } });
  const e = refused(fx.cliS(["sandbox", "start", "ingest", "--plan-revision", "rev-1", "--idempotency-key", "k", "--json"]), "E_PLAN_STALE", "stale");
  assert.deepEqual(e.details.plan, fresh);
});

test("a hook killed at its time limit takes what it started with it: its process group ends before the act answers and the lock goes", async (t) => {
  const fx = sandboxDeployment({ t });
  ok(fx.cliS(["sync", "--json"]), "sync");
  const late = join(fx.dep, "late-effect");
  const pause = (ms) => new Promise((done) => setTimeout(done, ms));
  // The control: a hook that answers in time; its child writes, so the fake's child is real.
  fx.sandbox.set({ start: { $child: { write: late, afterMs: 100 }, $sleepMs: 600 } });
  ok(fx.cliS(["sandbox", "start", "ingest", "--plan-revision", "rev-start", "--idempotency-key", "k-control", "--json"]), "the control start");
  await pause(300);
  assert.equal(existsSync(late), true, "the control's child wrote");
  rmSync(late);
  // The hook's child would write after 1.5 s; the hook is killed at 0.5 s, and its group with it.
  fx.sandbox.set({ start: { $child: { write: late, afterMs: 1500 }, $sleepMs: 5000 } });
  const r = fx.cliS(["sandbox", "start", "ingest", "--plan-revision", "rev-start", "--idempotency-key", "k-late", "--json"], { OATS_TEST_SANDBOX_HOOK_TIMEOUT_MS: "500" });
  const d = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(d.result?.state ?? d.error?.details?.state, "unknown", r.stdout);
  // The next mutating act takes the lock, and nothing of the killed start writes after it.
  fx.sandbox.set({ start: { state: "ready", server: "sandbox-ingest" } });
  ok(fx.cliS(["sandbox", "stop", "ingest", "--plan-revision", "rev-stop", "--idempotency-key", "k-stop", "--json"]), "stop");
  await pause(2000);
  assert.equal(existsSync(late), false, "the killed hook's child never wrote");
});

test("C4: a settled status or reconcile that leaves out its seats is unknown, hook-failed, never an empty ledger", (t) => {
  const fx = sandboxDeployment({ t });
  ok(fx.cliS(["sync", "--json"]), "sync");
  fx.sandbox.set({ status: { state: "ready", server: "sandbox-ingest" } });
  const s = ok(fx.cliS(["sandbox", "status", "--json"]), "status");
  assert.equal(s.sandboxes[0].state, "unknown");
  assert.equal(s.sandboxes[0].problems[0].reason, "hook-failed");
  assert.match(s.sandboxes[0].problems[0].message, /status without its seats/);
  fx.sandbox.set({ reconcile: { state: "ready", server: "sandbox-ingest" } });
  const rec = fx.cliS(["sandbox", "reconcile", "ingest", "--plan-revision", "rev-reconcile", "--idempotency-key", "k-r", "--json"]);
  const answer = JSON.parse(rec.stdout.trim().split("\n").pop());
  const got = answer.result ?? answer.error?.details;
  assert.equal(got.state, "unknown", rec.stdout);
  assert.ok(JSON.stringify(got).includes("reconcile without its seats"), rec.stdout);
});

test("a hook that answers in time: the act waits for a child that holds its stderr, and kills one that holds none of its pipes before the lock goes", async (t) => {
  const fx = sandboxDeployment({ t });
  ok(fx.cliS(["sync", "--json"]), "sync");
  const late = join(fx.dep, "late-effect");
  const lock = join(fx.dep, ".agents", "locks", "sandbox-ingest.lock");
  const pause = (ms) => new Promise((done) => setTimeout(done, ms));
  // A child holding the hook's stderr, which writes after the hook has answered: the act waits for it.
  fx.sandbox.set({ start: { $child: { write: late, afterMs: 800, holds: "stderr" } } });
  ok(fx.cliS(["sandbox", "start", "ingest", "--plan-revision", "rev-start", "--idempotency-key", "k-stderr", "--json"]), "start");
  assert.equal(existsSync(late), true, "its write came before the act answered");
  assert.equal(existsSync(lock), false, "and the lock went after it");
  rmSync(late);
  // A child holding none of the hook's pipes, which would write after the hook has answered: killed.
  fx.sandbox.set({ start: { $child: { write: late, afterMs: 800 } } });
  ok(fx.cliS(["sandbox", "start", "ingest", "--plan-revision", "rev-start", "--idempotency-key", "k-none", "--json"]), "start");
  assert.equal(existsSync(lock), false, "the lock went after the kill");
  await pause(1500);
  assert.equal(existsSync(late), false, "nothing the hook started acts after its act");
});

test("a stale plan answer is E_PLAN_STALE with its fresh plan, as a stale apply's", (t) => {
  const fx = sandboxDeployment({ t });
  ok(fx.cliS(["sync", "--json"]), "sync");
  const fresh = { planRevision: "fresh", actions: [] };
  fx.sandbox.set({ "plan:start": { state: "stale", plan: fresh } });
  const e = refused(fx.cliS(["sandbox", "start", "ingest", "--plan", "--json"]), "E_PLAN_STALE", "a stale plan answer");
  assert.deepEqual(e.details.plan, fresh);
  assert.equal(e.details.sandbox, "ingest");
});

/** Start `args` on the CLI in the background → a promise of { status, stdout }. */
function background(fx, args, env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: fx.dep, env: { ...fx.env, ...fx.sandbox.env, ...env } });
    let stdout = "";
    child.stdout.on("data", (b) => { stdout += b; });
    child.on("close", (status) => done({ status, stdout }));
  });
}

test("the lock: a second mutating act on a sandbox is E_LIFECYCLE_BUSY; plan and status take none; another deployment's sandbox of the same name never waits", async (t) => {
  const fx = sandboxDeployment({ t });
  const other = sandboxDeployment({ t });
  ok(fx.cliS(["sync", "--json"]), "sync");
  ok(other.cliS(["sync", "--json"]), "sync other");
  fx.sandbox.set({ start: { $sleepMs: 4000 } });
  other.sandbox.set({});
  const slow = background(fx, ["sandbox", "start", "ingest", "--plan-revision", "rev-start", "--idempotency-key", "slow", "--json"]);
  // The slow start holds the lock once its hook runs.
  const deadline = Date.now() + 10_000;
  while (!fx.sandbox.calls().some((c) => c.act === "start") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.ok(fx.sandbox.calls().some((c) => c.act === "start"), "the slow start's hook runs");
  const busy = refused(fx.cliS(["sandbox", "stop", "ingest", "--plan-revision", "rev-stop", "--idempotency-key", "k", "--json"]), "E_LIFECYCLE_BUSY", "second act");
  assert.equal(busy.details.sandbox, "ingest");
  ok(fx.cliS(["sandbox", "status", "--json"]), "status takes no lock");
  ok(fx.cliS(["sandbox", "stop", "ingest", "--plan", "--json"]), "plan takes no lock");
  ok(other.cliS(["sandbox", "start", "ingest", "--plan-revision", "rev-start", "--idempotency-key", "o", "--json"]), "the other deployment's sandbox of the same name");
  const done = await slow;
  assert.equal(done.status, 0, done.stdout);
});
