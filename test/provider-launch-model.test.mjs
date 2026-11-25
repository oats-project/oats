// Feature launch-model-and-check-warnings (KP-6, oats-project/oats#2122): a session provider's `check`
// is handed the model of the launch that is planned, so it can refuse a model its harness cannot
// resolve BEFORE a restart stops the session that runs; and what a READY check warned of is
// relayed in the `warnings` of a spawn's, a start's and a restart's answer (a spawn's preview:
// test/provider-preview-check.test.mjs). The provider is the fake one (helpers/session-provider-fixture.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CHECK_WARNINGS_RELAYED } from "../lib/session-providers.mjs";
import { KERNEL_FEATURES, LAUNCH_MODEL_CHECK_WARNINGS_FEATURE } from "../lib/kernel-features.mjs";
import { startInstance } from "../packages/client/session-start.mjs";
import { clientTerms } from "../packages/client/client-terms.mjs";
import { fakeManifest, fakeProvider, providerDeployment, sessionsOf } from "./helpers/session-provider-fixture.mjs";

const CLI = fileURLToPath(new URL("../bin/oats.mjs", import.meta.url));
const CHECKED = fakeManifest({ fake: fakeProvider({ check: true }) });
/** A deployment whose fake provider declares `check`, with a launch configuration that names a model. */
const deployment = (t) => providerDeployment(t, { manifest: CHECKED, local: { "launch-configs": { claude: { harness: "claude" }, codex: { harness: "codex" }, "claude-sonnet": { harness: "claude", model: "sonnet" } } } });
const spawnCli = (fx, name, extra = []) => fx.cli(["spawn", "dev", "--name", name, "--backend", "fake", "--launch-config", "claude", "--json", ...extra]).json();
const sessionCli = (fx, home, verb, extra = []) => fx.cli(["session", verb, "--home", home, "--json", ...extra]).json();
const stopCli = (fx, name) => {
  const plan = fx.cli(["instance", "stop", name, "--plan", "--json"]).json();
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const applied = fx.cli(["instance", "stop", name, "--apply", "--plan-revision", plan.result.planRevision, "--idempotency-key", `stop-${name}-${Date.now()}`, "--json"]).json();
  assert.equal(applied.ok, true, JSON.stringify(applied));
};
/** The planned launch each check was handed, oldest first. */
const planned = (fx) => fx.verbs("check").map((c) => c.request.input.launch);
/** The one planned launch of the calls so far, and the launch input that followed it. */
const pair = (fx) => {
  const checks = planned(fx), launches = fx.verbs("launch");
  assert.deepEqual([checks.length, launches.length], [1, 1], JSON.stringify(fx.verbs().map((c) => c.verb)));
  return { check: checks[0], launch: launches[0].request.input };
};
const WARNS = [{ code: "session-provider-pi-model-unchecked", message: "the model's provider is not one this check can resolve: it is checked at the launch" }, { code: "second", message: "a second thing, said as it is: {\"json\": true}" }];
/** A relayed warning as the kernel words it: who said it, through which verb, and the provider's own code and message. */
const relayed = (w) => `acme.fake's session provider fake (check) warns ${w.code}: ${w.message}`;
const relayedOf = (warnings) => (warnings ?? []).filter((w) => w.startsWith("acme.fake's session provider fake (check)"));

test("the feature is announced, in version --json", () => {
  assert.equal(LAUNCH_MODEL_CHECK_WARNINGS_FEATURE, "launch-model-and-check-warnings");
  assert.ok(KERNEL_FEATURES.includes(LAUNCH_MODEL_CHECK_WARNINGS_FEATURE));
  const r = spawnSync(process.execPath, [CLI, "version", "--json"], { encoding: "utf8" });
  assert.ok(JSON.parse(r.stdout).features.includes("launch-model-and-check-warnings"), r.stderr);
});

test("the planned launch carries the model the launch names, at a spawn, a start and a restart, and has no model key when none is named", (t) => {
  const fx = deployment(t);
  // 1. A spawn that names none: the key is absent (never null, never ""), while the launch input says null.
  const bare = spawnCli(fx, "bare");
  assert.equal(bare.ok, true, JSON.stringify(bare));
  let asked = pair(fx);
  assert.equal(Object.hasOwn(asked.check, "model"), false, JSON.stringify(asked.check));
  assert.deepEqual(Object.keys(asked.check), ["harness", "yolo", "args", "sandbox", "trees", "protected"]);
  assert.equal(asked.launch.model, null);
  // A start and a restart of it: still none.
  for (const verb of ["restart", "start"]) {
    if (verb === "start") stopCli(fx, "bare");
    fx.clearCalls();
    const answer = sessionCli(fx, bare.result.home, verb);
    assert.equal(answer.ok, true, JSON.stringify(answer));
    asked = pair(fx);
    assert.equal(Object.hasOwn(asked.check, "model"), false, `${verb}: ${JSON.stringify(asked.check)}`);
    assert.equal(asked.launch.model, null, verb);
  }

  // 2. A spawn with --model: the check is told what the launch is then handed.
  fx.clearCalls();
  const named = spawnCli(fx, "named", ["--model", "opus"]);
  assert.equal(named.ok, true, JSON.stringify(named));
  asked = pair(fx);
  assert.equal(typeof asked.launch.model, "string");
  assert.ok(asked.launch.model.length > 0);
  assert.equal(asked.check.model, asked.launch.model);
  assert.deepEqual(Object.keys(asked.check), ["harness", "model", "yolo", "args", "sandbox", "trees", "protected"]);
  const spawnedModel = asked.launch.model;
  // A restart with no flag: the model the home records, which is what it launches with again.
  fx.clearCalls();
  assert.equal(sessionCli(fx, named.result.home, "restart").ok, true);
  asked = pair(fx);
  assert.deepEqual([asked.check.model, asked.launch.model], [spawnedModel, spawnedModel]);
  // A restart with --model: the new one, in the check first.
  fx.clearCalls();
  const moved = sessionCli(fx, named.result.home, "restart", ["--model", "haiku"]);
  assert.equal(moved.ok, true, JSON.stringify(moved));
  asked = pair(fx);
  assert.equal(asked.check.model, asked.launch.model);
  assert.notEqual(asked.check.model, spawnedModel);
  assert.equal(moved.result.model, asked.check.model, "the answer's model is the one the check was told");
  // A start (of the stopped home) with --model.
  stopCli(fx, "named");
  fx.clearCalls();
  const started = sessionCli(fx, named.result.home, "start", ["--model", "opus"]);
  assert.equal(started.ok, true, JSON.stringify(started));
  asked = pair(fx);
  assert.deepEqual([asked.check.model, asked.launch.model], [spawnedModel, spawnedModel]);

  // 3. A launch configuration's model: named by the launch, so carried.
  fx.clearCalls();
  const configured = fx.cli(["spawn", "dev", "--name", "configured", "--backend", "fake", "--launch-config", "claude-sonnet", "--json"]).json();
  assert.equal(configured.ok, true, JSON.stringify(configured));
  asked = pair(fx);
  assert.equal(asked.check.model, asked.launch.model);
  assert.equal(asked.check.model, configured.result.model);
  assert.ok(asked.check.model);
});

test("THE ORDER: a restart whose provider check refuses the model is refused with nothing stopped: the session that runs still runs, and the provider's stop is never called", (t) => {
  const fx = deployment(t);
  fx.control({ stateful: true });
  const spawned = spawnCli(fx, "runs", ["--model", "opus"]);
  assert.equal(spawned.ok, true, JSON.stringify(spawned));
  const home = spawned.result.home, endpoint = spawned.result.session.endpoint;
  const running = () => [...sessionsOf(fx.events()).entries()].filter(([, s]) => s.running).map(([thread]) => thread);
  assert.deepEqual(running(), [endpoint.threadId]);

  // The provider refuses one model, in its check, as it would refuse it at the launch.
  const refusedModel = "haiku", before = running();
  fx.control({ stateful: true, check: { refuseModel: refusedModel } });
  fx.clearCalls();
  const eventsBefore = fx.events().length;

  const refused = sessionCli(fx, home, "restart", ["--model", refusedModel]);
  assert.deepEqual([refused.ok, refused.error.code], [false, "E_BACKEND_LAUNCH_ARG"], JSON.stringify(refused));
  assert.match(refused.error.message, /^runs was not started: acme\.fake's session provider fake is not ready \(unavailable\): E_BACKEND_LAUNCH_ARG: this provider's harness cannot resolve the model .*; nothing was stopped or started$/);
  // The check was asked, with that model; then nothing: no stop, no launch, no hook.
  assert.deepEqual(fx.verbs().map((c) => c.verb).filter((v) => v !== "inspect" && v !== "inspectMany"), ["check"]);
  assert.equal(planned(fx)[0].model, refusedModel);
  assert.deepEqual(fx.hooks(), [], "no launch hook ran for a refused restart");
  assert.equal(fx.events().length, eventsBefore, "the provider was asked to do nothing");
  assert.deepEqual(running(), before, "the session that ran still runs");
  // And OATS still reads it running, at the endpoint it recorded: its record did not move.
  const inspected = JSON.parse(fx.cli(["session", "inspect", "--home", home, "--json"]).stdout);
  assert.deepEqual([inspected.ok, inspected.result.running, inspected.result.session.endpoint.threadId], [true, true, before[0]], JSON.stringify(inspected));
  const row = JSON.parse(fx.cli(["status", "--json"]).stdout).agents.flatMap((a) => a.instances).find((i) => i.instance === "runs");
  assert.deepEqual([row.running, row.model], [true, spawned.result.model], "running, on the model it was spawned with");

  // The same restart with a model the provider takes goes through: a stop, then a launch.
  fx.clearCalls();
  const taken = sessionCli(fx, home, "restart", ["--model", "opus"]);
  assert.equal(taken.ok, true, JSON.stringify(taken));
  assert.deepEqual(fx.verbs().map((c) => c.verb).filter((v) => v !== "inspect" && v !== "inspectMany"), ["check", "stop", "launch"], "the check first, then the stop");
  // A start of a stopped home with the refused model is refused the same way, and nothing launches.
  stopCli(fx, "runs");
  fx.clearCalls();
  const start = sessionCli(fx, home, "start", ["--model", refusedModel]);
  assert.deepEqual([start.ok, start.error.code], [false, "E_BACKEND_LAUNCH_ARG"], JSON.stringify(start));
  assert.deepEqual(fx.verbs().map((c) => c.verb).filter((v) => v === "launch"), []);
  // And a spawn with it: refused before any hook, the home undone.
  fx.clearCalls();
  const spawn = spawnCli(fx, "never", ["--model", refusedModel]);
  assert.deepEqual([spawn.ok, spawn.error.code], [false, "E_BACKEND_LAUNCH_ARG"], JSON.stringify(spawn));
  assert.deepEqual([fx.verbs().map((c) => c.verb), fx.hooks()], [["check"], []]);
});

test("a ready check's warnings are relayed, verbatim and tagged with the capability and the verb, in the spawn's, the start's and the restart's answers; a check with none adds none", async (t) => {
  const fx = deployment(t);
  // None: no line of the provider's in any answer.
  const quiet = spawnCli(fx, "quiet");
  assert.equal(quiet.ok, true, JSON.stringify(quiet));
  assert.deepEqual(relayedOf(quiet.result.warnings), []);
  assert.deepEqual(relayedOf(sessionCli(fx, quiet.result.home, "restart").result.warnings), []);

  fx.control({ check: { result: { status: "ready", problems: [], warnings: WARNS } } });
  const spawned = spawnCli(fx, "warned");
  assert.equal(spawned.ok, true, JSON.stringify(spawned));
  assert.deepEqual(relayedOf(spawned.result.warnings), WARNS.map(relayed), "the spawn's answer");
  const home = spawned.result.home;
  const restarted = sessionCli(fx, home, "restart");
  assert.equal(restarted.ok, true, JSON.stringify(restarted));
  assert.deepEqual(relayedOf(restarted.result.warnings), WARNS.map(relayed), "the restart's answer");
  stopCli(fx, "warned");
  const started = sessionCli(fx, home, "start");
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.deepEqual(relayedOf(started.result.warnings), WARNS.map(relayed), "the start's answer");
  // Each is on the home's record of that start too, as every warning of a start is.
  const events = fx.cli(["instance", "events", "warned", "--json"]).json();
  assert.equal(events.ok, true, JSON.stringify(events).slice(0, 400));
  const said = events.result.events.filter((e) => e.kind === "launch-warning").map((e) => e.data.message);
  for (const w of WARNS) assert.ok(said.includes(relayed(w)), JSON.stringify(said));

  // Every entry of `warnings` is a string, within what today's clients take (512 entries of at
  // most 4096 characters): a kernel never puts an object there.
  for (const answer of [spawned, restarted, started]) {
    assert.ok(answer.result.warnings.length <= 512);
    for (const w of answer.result.warnings) assert.ok(typeof w === "string" && w.length <= 4096, JSON.stringify(w));
  }

  // AN OLDER READER: the shared client's reader of a start's receipt (packages/client/session-start.mjs
  // startReceipt, which refuses a receipt whose warnings are not strings), on a CLI above what it
  // was tested with, takes the restart's real answer and keeps the warning's text.
  const terms = clientTerms({ name: "the test client", self: "this test client", selfInitial: "This test client", update: "Update the test client.", thisMachine: "This machine" });
  const cli = { ok: true, bin: "/installed/oats", features: ["session-start", "session-restart", "launch-config"], remote: [], version: "99.0.0", aboveTested: true, testedThrough: "0.69" };
  const row = { instance: "warned", home, agentsRoot: fx.root, running: true };
  const read = await startInstance(cli, row, {}, { restart: true, terms, verifyHome: () => home, start: async () => ({ schemaVersion: 1, ok: true, result: restarted.result }) });
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.deepEqual(relayedOf(read.result.warnings), WARNS.map(relayed));

  // A refusal is unchanged: its problems are in the message, and no warning is relayed beside it.
  fx.control({ check: { result: { status: "needs-configuration", problems: [{ code: "no-key", message: "no key is set" }], warnings: WARNS } } });
  const refused = sessionCli(fx, home, "restart");
  assert.deepEqual([refused.ok, refused.error.code], [false, "E_BACKEND_NOT_READY"], JSON.stringify(refused));
  assert.equal(refused.error.message, "warned was not started: acme.fake's session provider fake is not ready (needs-configuration): no-key: no key is set; nothing was stopped or started");
});

test("a check that warns of more than a client shows relays the first ones and counts the rest; a message is made safe to print", (t) => {
  const fx = deployment(t);
  const many = Array.from({ length: CHECK_WARNINGS_RELAYED + 3 }, (_, i) => ({ code: `w-${i}`, message: i === 0 ? "a line\nand \u001b[31mmore" : `warning ${i}` }));
  fx.control({ check: { result: { status: "ready", problems: [], warnings: many } } });
  const spawned = spawnCli(fx, "loud");
  assert.equal(spawned.ok, true, JSON.stringify(spawned));
  const lines = relayedOf(spawned.result.warnings);
  assert.equal(lines.length, CHECK_WARNINGS_RELAYED + 1);
  assert.equal(lines[0], "acme.fake's session provider fake (check) warns w-0: a line\uFFFDand \uFFFD[31mmore");
  assert.deepEqual(lines.slice(1, CHECK_WARNINGS_RELAYED), many.slice(1, CHECK_WARNINGS_RELAYED).map(relayed));
  assert.equal(lines.at(-1), "acme.fake's session provider fake (check) gave 3 more warnings, not shown here");
});
