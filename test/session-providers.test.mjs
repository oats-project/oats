// Session providers: the kernel's contract with a session backend a capability supplies
// (docs/capabilities.md "Session providers", docs/execution-targets.md "Session providers"). The
// tests named T1 to T12 are the change's pinned acceptance tests, by their numbers. Every home here
// is a real spawn through the kernel; the provider is a real script the kernel runs
// (test/helpers/session-provider-fixture.mjs: `acme.fake`, backend `fake`, no bb), told what to
// answer and recording each call. T10, the older-kernel guarantee, is its own file
// (session-provider-older-kernel.test.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { attachInstanceSession, inputInstanceSession, inspectInstanceSession, listInstances, restartInstanceSession, startInstanceSession, stopInstanceSession } from "../lib/core.mjs";
import { setWaiting } from "../lib/instance-events.mjs";
import { PROVIDER_RESUME_NOTICE, RESUME_LIMIT } from "../lib/provider-resume.mjs";
import { parseRemoteEnvelope, rosterGroups, writeServers } from "../lib/servers.mjs";
import { FAKE_CAPABILITY, FAKE_SERVER, LOST, fakeManifest, fakeProvider, providerDeployment } from "./helpers/session-provider-fixture.mjs";

const HOST_STOP_CHILD = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "host-stop-child.mjs");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const receiptOf = (home) => join(dirname(home), ".oats-retirement", "baselines", `${createHash("sha256").update(home).digest("hex")}.json`);
const runtimeOf = (home) => readJson(receiptOf(home)).runtime;
const recordOf = (home) => readJson(join(home, "instance.json"));
const rowsOf = (fx) => JSON.parse(fx.cli(["status", "--json"]).stdout).agents.flatMap((agent) => agent.instances);
const rowOf = (fx, name) => rowsOf(fx).find((row) => row.instance === name);
const endpointOf = (name, n) => ({ server: FAKE_SERVER, threadId: `thr_${name}_${n}` });
/** A kernel refusal's code: of an in-process call, awaited. */
const codeOf = async (call) => { try { await call(); } catch (e) { return e.code; } return null; };
/** `oats instance stop <name>`: the plan, then its apply, as an operator runs it. */
function operatorStop(fx, name) {
  const plan = fx.cli(["instance", "stop", name, "--plan", "--json"]).json();
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const applied = fx.cli(["instance", "stop", name, "--apply", "--plan-revision", plan.result.planRevision, "--idempotency-key", `stop-${name}`, "--json"]).json();
  assert.equal(applied.ok, true, JSON.stringify(applied));
  return applied.result.results.find((row) => row.instance === name);
}
/** The stop `oats host run` gives a home when the host stops: its own child, as the run starts it. */
function hostStop(fx, home) {
  const r = spawnSync(process.execPath, [HOST_STOP_CHILD, home, "20000"], { cwd: fx.dep, env: fx.env, encoding: "utf8" });
  return JSON.parse(r.stdout.trim().split("\n").pop());
}
const stopReceiptOf = (home) => (existsSync(join(home, ".oats-stop.json")) ? readJson(join(home, ".oats-stop.json")) : null);
/** A row's `session` on the host where the home lives: the capability and the thread id alone. */
const rowSessionOf = (name, n) => ({ provider: FAKE_CAPABILITY, threadId: `thr_${name}_${n}` });
const sweep = (fx, ...flags) => fx.cli(["session", "resume", "--deployment", fx.dep, ...flags, "--json"]).json();

test("T1: a spawn with --backend fake launches through the provider and records the endpoint it returned", async (t) => {
  const fx = providerDeployment(t);
  const spawned = fx.cli(["spawn", "dev", "--name", "one", "--backend", "fake", "--launch-config", "claude", "--task", "do the thing", "--json"]).json();
  assert.equal(spawned.ok, true, JSON.stringify(spawned));
  const { home } = spawned.result;
  const endpoint = endpointOf("one", 1);

  // The spawn hook saw the backend, and ran before the provider's launch.
  const calls = fx.calls();
  assert.deepEqual(calls.map((c) => c.hook ?? c.verb), ["spawn", "launch"]);
  assert.equal(calls[0].backend, "fake");
  // The call: the home's own module copy, run outside the home, with the hook environment and OATS_BACKEND.
  const [launch] = fx.verbs("launch");
  assert.equal(launch.cwd === home || launch.cwd.startsWith(`${home}/`), false, "a call never works in the home: the home is in the request");
  assert.deepEqual([parse(launch.cwd).root, launch.instance, launch.backend, launch.event, launch.capability, launch.argv], [launch.cwd, "one", "fake", "session", FAKE_CAPABILITY, ["launch"]]);
  assert.deepEqual({ ...launch.request, input: null }, { schemaVersion: 1, phase: "session", capability: FAKE_CAPABILITY, provider: "fake", verb: "launch", input: null });
  // The launch as data: every variable with its source, the arguments, the harness, the model, yolo, the prompt.
  assert.deepEqual(launch.request.input, {
    home, instance: "one", harness: "claude", model: null, yolo: null,
    env: [
      { name: "OATS_INSTANCE", value: "one", source: "kernel" },
      { name: "OATS_INSTANCE_HOME", value: home, source: "kernel" },
      { name: "ACME_FAKE_TOKEN_FILE", value: "/nowhere/token", source: "capability", capability: FAKE_CAPABILITY },
    ],
    unset: [], pathPrepend: [join(home, ".oats", "bin")], args: [], promptFile: join(home, "TASK.md"), previous: null,
  });

  // The records: instance.json and the independent receipt carry the endpoint; no tmux in either.
  const record = recordOf(home);
  assert.equal(record.launched, true);
  assert.equal(record.backend, "fake");
  assert.deepEqual(record.session, { provider: FAKE_CAPABILITY, endpoint });
  assert.equal(Object.hasOwn(record, "tmux"), false);
  assert.equal(Object.hasOwn(record, "command"), false);
  assert.equal(record.launch.executable, null, "a provider runs the harness itself: no executable is recorded");
  assert.deepEqual(runtimeOf(home), { launched: true, backend: "fake", provider: FAKE_CAPABILITY, endpoint, stoppedAt: null });

  // The spawn's answer (item 8b): `backend` and `session`, and no terminal to attach to.
  assert.deepEqual([spawned.result.launched, spawned.result.backend, spawned.result.session, spawned.result.tmux, spawned.result.attach], [true, "fake", { provider: FAKE_CAPABILITY, endpoint }, null, null]);

  // A start's launch hooks see the backend too, before the provider's launch.
  operatorStop(fx, "one");
  fx.clearCalls();
  const started = fx.cli(["session", "start", "--home", home, "--json"]).json();
  assert.equal(started.ok, true, JSON.stringify(started));
  // The launch hook, then the provider: its stop once more (a start never launches beside a session
  // a stop did not finish), then its launch.
  assert.deepEqual(fx.calls().map((c) => [c.hook ?? c.verb, c.backend]), [["launch", "fake"], ["stop", "fake"], ["launch", "fake"]]);
  assert.equal(fx.hooks("launch").length, 1);
  assert.deepEqual(fx.verbs("launch")[0].request.input.previous, endpoint, "the launch is handed the endpoint it replaces");
  assert.deepEqual([started.result.session, started.result.backend, started.result.target], [{ provider: FAKE_CAPABILITY, endpoint: endpointOf("one", 2) }, "fake", null], "a local start answers the endpoint, and `target: null`");
});

test("T1: a preview names the backend; a spawn that launches nothing records what a start will launch on", async (t) => {
  const fx = providerDeployment(t);
  const preview = fx.cli(["spawn", "dev", "--name", "later", "--backend", "fake", "--launch-config", "claude", "--preview", "--json"]).json();
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.deepEqual([preview.result.backend, preview.result.backendStatus, preview.result.decision.effective.backend], ["fake", { name: "fake", installed: true, started: false }, "fake"]);
  assert.equal(fx.calls().length, 0, "a preview runs no hook and calls no provider");

  const { home } = await fx.spawn("dev", { name: "later", backend: "fake", launchConfig: "claude" });
  assert.deepEqual(fx.calls().map((c) => [c.hook ?? c.verb, c.backend]), [["spawn", "fake"]], "the spawn hook sees the backend; nothing is launched");
  assert.deepEqual([recordOf(home).launched, recordOf(home).backend, recordOf(home).session], [false, "fake", { provider: FAKE_CAPABILITY, endpoint: null }]);
  assert.deepEqual(runtimeOf(home), { launched: false, backend: "fake", provider: FAKE_CAPABILITY });
  const inspected = await fx.inEnv(() => inspectInstanceSession(home));
  assert.deepEqual([inspected.backend, inspected.present, inspected.state, inspected.running, inspected.session, inspected.open], ["fake", false, "not-launched", false, { provider: FAKE_CAPABILITY, endpoint: null }, null]);
  assert.equal(await codeOf(() => fx.inEnv(() => inputInstanceSession(home, "hello"))), "E_SESSION_NOT_RUNNING");
  // Its first start launches on the provider.
  const started = await fx.inEnv(() => startInstanceSession(home, {}));
  assert.deepEqual([started.backend, started.session], ["fake", { provider: FAKE_CAPABILITY, endpoint: endpointOf("later", 1) }]);
  assert.equal(fx.verbs("launch")[0].request.input.previous, null);
  assert.deepEqual(runtimeOf(home), { launched: true, backend: "fake", provider: FAKE_CAPABILITY, endpoint: endpointOf("later", 1), stoppedAt: null });
});

test("T2: a tmux spawn's hooks see OATS_BACKEND=tmux, and a tmux home's records are as they were", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.spawn("dev", { name: "on-tmux" });
  assert.deepEqual(fx.hooks("spawn").map((h) => h.backend), ["tmux"]);
  const record = recordOf(home);
  assert.equal(Object.hasOwn(record, "backend"), false, "a tmux home's record gains no backend");
  assert.equal(Object.hasOwn(record, "session"), false);
  assert.deepEqual(Object.keys(record.tmux).sort(), ["session", "window"]);
  assert.equal(typeof record.launch.executable, "string");
  assert.deepEqual(Object.keys(runtimeOf(home)).sort(), ["launched", "tmux"]);
  // Its status row names the kernel's own backend, and carries none of a provider row's fields.
  const row = rowOf(fx, "on-tmux");
  assert.equal(row.backend, "tmux");
  for (const key of ["session", "open"]) assert.equal(Object.hasOwn(row, key), false, key);
  // Its inspect answer is the tmux one, unchanged.
  assert.deepEqual(await fx.inEnv(() => inspectInstanceSession(home)), { home, backend: null, present: false, state: "not-launched", running: false, waitingOnYou: null, wakeHold: "unknown" });
});

test("T3: inspect relays the provider's answer; a malformed, failing or slow one is unavailable, never stopped", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("probe");
  const inspect = (env) => fx.cli(["session", "inspect", "--home", home, "--json"], { env }).json();
  const session = { provider: FAKE_CAPABILITY, endpoint: endpointOf("probe", 1) };
  const open = { label: "Open in fake", url: `${FAKE_SERVER}/thread/thr_probe_1` };

  // The contract's four rows, relayed as given.
  for (const [said, answered] of [
    [{ present: true, state: "unknown", running: true, open }, { present: true, state: "unknown", running: true, open }],
    [{ present: true, state: "unknown", running: null }, { present: true, state: "unknown", running: null, open: null }],
    [{ present: true, state: "shell", running: false, open }, { present: true, state: "shell", running: false, open }],
    [{ present: false, state: "stopped", running: false }, { present: false, state: "stopped", running: false, open: null }],
  ]) {
    fx.control({ inspect: { result: said } });
    assert.deepEqual(inspect().result, { home, backend: "fake", present: answered.present, state: answered.state, running: answered.running, waitingOnYou: null, wakeHold: "unknown", session, open: answered.open });
  }
  assert.deepEqual(fx.verbs("inspect")[0].request.input, { home, endpoint: session.endpoint });

  // Every way a provider can fail to answer in the contract's words.
  // (status asks with inspectMany: the same behaviour is given to both verbs.)
  const both = (behaviour) => ({ inspect: behaviour, inspectMany: behaviour });
  for (const [what, control, env] of [
    ["malformed JSON", both({ raw: "not json" })],
    ["two documents", both({ raw: '{"a":1}{"b":2}' })],
    ["a wrong envelope", both({ echo: { verb: "input" } })],
    ["a failing command", both({ exit: 3 })],
    ["a refusal", { inspect: { error: { code: "E_BACKEND_NOT_READY", message: "the server is down" } } }],
    ["a word outside the contract", { inspect: { result: { present: true, state: "running", running: true } } }],
    ["an unknown key", { inspect: { result: { present: true, state: "unknown", running: true, pane: "%1" } } }],
    ["a row outside the table: a session that is gone and runs", { inspect: { result: { present: false, state: "unknown", running: true } } }],
    ["a row outside the table: a session that is gone and not stopped", { inspect: { result: { present: false, state: "shell", running: false } } }],
    ["an open link that is no http URL", { inspect: { result: { present: true, state: "unknown", running: true, open: { label: "x", url: "javascript:alert(1)" } } } }],
    ["a slow provider", both({ sleepMs: 5000 }), { OATS_TEST_SESSION_PROVIDER_TIMEOUT_MS: "400" }],
  ]) {
    fx.control(control);
    const answer = inspect(env);
    assert.equal(answer.ok, false, what);
    assert.equal(answer.error.code, "E_SESSION_UNAVAILABLE", what);
    const row = rowsOf({ cli: (args) => fx.cli(args, { env }) }).find((r) => r.instance === "probe");
    assert.deepEqual([row.running, row.runtimeState, typeof row.runtimeError], [null, "unreachable", "string"], what);
    assert.equal(Object.hasOwn(row, "sessionEnd"), false, `${what}: never read as stopped`);
  }
  fx.control({ inspect: { error: { code: "E_BACKEND_NOT_READY", message: "the server is down" } } });
  assert.match(inspect().error.message, /E_BACKEND_NOT_READY: the server is down/, "the provider's own words are in the message");
});

test("T3: waitingOnYou is the producers' claim, read while the session is there and not in error", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("asker");
  setWaiting(home, { producer: "oats.core", waiting: true, reason: "question", message: "Which branch?" });
  const waiting = (observed) => { fx.control({ inspect: { result: observed } }); return [fx.cli(["session", "inspect", "--home", home, "--json"]).json().result.waitingOnYou?.message ?? null, rowOf(fx, "asker").waitingOnYou?.message ?? null]; };
  assert.deepEqual(waiting({ present: true, state: "unknown", running: true }), ["Which branch?", "Which branch?"]);
  assert.deepEqual(waiting({ present: true, state: "unknown", running: null }), ["Which branch?", "Which branch?"], "an idle session can be the one waiting");
  assert.deepEqual(waiting({ present: true, state: "shell", running: false }), [null, null]);
  assert.deepEqual(waiting({ present: false, state: "stopped", running: false }), [null, null], "a session that is gone, a lost one included");
  // A home OATS stopped carries none, and its provider is not asked.
  fx.control({});
  await fx.inEnv(() => stopInstanceSession(home, {}));
  fx.clearCalls();
  assert.deepEqual([fx.cli(["session", "inspect", "--home", home, "--json"]).json().result.waitingOnYou, rowOf(fx, "asker").waitingOnYou], [null, null]);
  assert.deepEqual(fx.verbs(), []);
});

test("T4: after oats instance stop, inspect answers stopped and input is refused, both without calling the provider", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("halted");
  fx.clearCalls();
  const stopped = operatorStop(fx, "halted");
  assert.deepEqual([stopped.ok, stopped.stopped, stopped.alreadyIdle, stopped.state], [true, true, false, "stopped"]);
  // `stoppedAt` was recorded, then the provider's stop was called with the endpoint and the grace.
  const runtime = runtimeOf(home);
  assert.deepEqual([Object.keys(runtime).sort(), Number.isFinite(Date.parse(runtime.stoppedAt))], [["backend", "endpoint", "launched", "provider", "stoppedAt"], true]);
  assert.equal(stopReceiptOf(home).resume, undefined, "an operator's stop asks for no resume");
  assert.deepEqual(fx.verbs("stop").map((c) => c.request.input), [{ home, endpoint: endpointOf("halted", 1), graceSeconds: 20 }]);
  assert.deepEqual(fx.verbs().filter((c) => !["inspect", "inspectMany", "stop"].includes(c.verb)), [], "the plan and the apply read the session; nothing else is called");

  fx.clearCalls();
  const inspected = fx.cli(["session", "inspect", "--home", home, "--json"]).json();
  assert.deepEqual(inspected.result, { home, backend: "fake", present: false, state: "stopped", running: false, waitingOnYou: null, wakeHold: "unknown", session: { provider: FAKE_CAPABILITY, endpoint: endpointOf("halted", 1) }, open: null });
  const text = join(fx.base, "input.txt");
  writeFileSync(text, "are you there?\n");
  const input = fx.cli(["session", "input", "--home", home, "--text-file", text, "--json"]).json();
  assert.deepEqual([input.ok, input.error.code], [false, "E_SESSION_NOT_RUNNING"]);
  // The status row too, and it keeps the home's last endpoint.
  const row = rowOf(fx, "halted");
  assert.deepEqual([row.running, row.runtimeState, row.sessionEnd, row.session, row.open, row.tmux], [false, "stopped", "stopped", rowSessionOf("halted", 1), null, null]);
  // attach names no terminal either, without asking the provider for a link.
  assert.equal(await codeOf(() => fx.inEnv(() => attachInstanceSession(home))), "E_SESSION_NO_TERMINAL");
  assert.deepEqual(fx.verbs(), [], "the provider was not called for any of it");

  // A second stop is idle, and asks the provider once more (its stop is idempotent); the host's
  // shutdown changes nothing of a home that is stopped. A start clears the stop and launches anew.
  assert.deepEqual(await fx.inEnv(() => stopInstanceSession(home, {})), { home, backend: "fake", stopped: false, alreadyIdle: true, state: "stopped", receipt: null });
  assert.deepEqual(fx.verbs().map((c) => c.verb), ["stop"]);
  assert.equal(hostStop(fx, home).alreadyIdle, true);
  assert.deepEqual(fx.verbs().map((c) => c.verb), ["stop"], "no second call for the host's stop");
  assert.equal(stopReceiptOf(home).resume, undefined, "and it asks for no resume of a home an operator stopped");
  await fx.inEnv(() => startInstanceSession(home, {}));
  assert.deepEqual(runtimeOf(home), { launched: true, backend: "fake", provider: FAKE_CAPABILITY, endpoint: endpointOf("halted", 2), stoppedAt: null });
  assert.equal((await fx.inEnv(() => inputInstanceSession(home, "hello again"))).submitted, true);
});

test("T4: a stop the provider does not confirm leaves the home recorded as stopped; a scheduled wake to it is refused", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("stuck");
  fx.control({ stop: { exit: 1 } });
  await assert.rejects(fx.inEnv(() => stopInstanceSession(home, {})), (e) => e.code === "E_SESSION_STOP_FAILED" && /is recorded as stopped by OATS/.test(e.message));
  assert.equal(Number.isFinite(Date.parse(runtimeOf(home).stoppedAt)), true);
  // Another stop finishes it: the provider is asked again, and refused the same way until it confirms.
  await assert.rejects(fx.inEnv(() => stopInstanceSession(home, {})), (e) => e.code === "E_SESSION_STOP_FAILED");
  fx.control({});
  fx.clearCalls();
  assert.equal((await fx.inEnv(() => stopInstanceSession(home, {}))).alreadyIdle, true);
  assert.deepEqual(fx.verbs().map((c) => [c.verb, c.request.input.endpoint]), [["stop", endpointOf("stuck", 1)]]);
  fx.clearCalls();
  assert.equal(await codeOf(() => fx.inEnv(() => inputInstanceSession(home, "hello"))), "E_SESSION_NOT_RUNNING");
  // A wake is its session's input: refused for a home OATS stopped, which a wake never starts.
  const added = fx.cli(["schedule", "add", "--spec-json", JSON.stringify({ id: "nudge", kind: "wake", cron: "* * * * *", tz: "UTC", home, message: "wake up" }), "--json"]).json();
  assert.equal(added.ok, true, JSON.stringify(added));
  fx.clearCalls();
  const ran = fx.cli(["schedule", "run", "nudge", "--json"]).json();
  assert.equal(ran.ok, true, JSON.stringify(ran));
  assert.deepEqual([ran.result.run.action, ran.result.run.errorCode, ran.result.run.pending], ["skipped", "E_SESSION_NOT_RUNNING", true], JSON.stringify(ran.result));
  assert.deepEqual(fx.verbs(), [], "neither the wake nor the input reached the provider");
  assert.equal(fx.hooks().length, 0, "the wake did not start the home");
});

test("T5: input relays submitted:true, and the provider's E_SESSION_PROMPT_OPEN and E_SESSION_INPUT_QUEUED with ok:false", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("listener");
  const text = join(fx.base, "input.txt");
  writeFileSync(text, "line one\nline two\n");
  const input = () => fx.cli(["session", "input", "--home", home, "--text-file", text, "--json"]);
  fx.clearCalls();

  // The broker contract's shape: schemaVersion 1, ok, result.submitted.
  fx.control({ input: { result: { submitted: true, verified: false } } });
  const sent = input();
  assert.equal(sent.status, 0);
  assert.deepEqual(sent.json(), { schemaVersion: 1, ok: true, result: { home, backend: "fake", submitted: true, verified: false } }, "and no endpoint: that is inspect's, a spawn's and a start's");
  // The session is read first (a session that is gone makes the input a resume, counted), then the input.
  assert.deepEqual(fx.verbs().map((c) => [c.verb, c.request.input]), [["inspect", { home, endpoint: endpointOf("listener", 1) }], ["input", { home, endpoint: endpointOf("listener", 1), text: "line one\nline two\n" }]]);

  for (const code of ["E_SESSION_PROMPT_OPEN", "E_SESSION_INPUT_QUEUED"]) {
    fx.control({ input: { error: { code, message: `the fake says ${code}` } } });
    const refused = input();
    assert.equal(refused.status, 1, code);
    assert.deepEqual(refused.json(), { schemaVersion: 1, ok: false, error: { code, message: `the fake says ${code}` } }, code);
  }
  // Anything else is a failed input, never a submission: another refusal, a result that is not a submission, a failed call.
  for (const [what, control] of [
    ["another refusal", { input: { error: { code: "E_BACKEND_NOT_READY", message: "down" } } }],
    ["submitted: false", { input: { result: { submitted: false, verified: false } } }],
    ["no verified", { input: { result: { submitted: true } } }],
    ["a failing command", { input: { exit: 2 } }],
  ]) {
    fx.control(control);
    const failed = input().json();
    assert.deepEqual([failed.ok, failed.error.code], [false, "E_SESSION_INPUT_FAILED"], what);
  }
  // A session that cannot be read is never sent to: whether the input is a resume is not known.
  fx.control({ inspect: { exit: 1 } });
  fx.clearCalls();
  assert.equal(input().json().error.code, "E_SESSION_INPUT_FAILED");
  assert.deepEqual(fx.verbs("input"), []);
});

test("T6: a stop with the host is resumed by the sweep; an operator's stop is not", async (t) => {
  const fx = providerDeployment(t);
  const hosted = await fx.launch("hosted"), operated = await fx.launch("operated");
  // The host stops: `stoppedAt` in the receipt, and on the stop receipt that host run's shutdown wrote it.
  const stopped = hostStop(fx, hosted.home);
  assert.deepEqual([stopped.ok, stopped.stopped, stopped.state], [true, true, "stopped"]);
  assert.equal(Number.isFinite(Date.parse(runtimeOf(hosted.home).stoppedAt)), true);
  assert.deepEqual([stopReceiptOf(hosted.home).resume, stopReceiptOf(hosted.home).reason], [true, "host-stop"]);
  assert.equal(Object.hasOwn(recordOf(hosted.home), "stoppedAt"), false, "instance.json gains no second intent field");
  assert.deepEqual([rowOf(fx, "hosted").running, rowOf(fx, "hosted").sessionEnd], [false, "lost"]);
  // While the host is down its input is refused.
  assert.equal(await codeOf(() => fx.inEnv(() => inputInstanceSession(hosted.home, "mail"))), "E_SESSION_NOT_RUNNING");
  operatorStop(fx, "operated");
  assert.equal(rowOf(fx, "operated").sessionEnd, "stopped");

  fx.clearCalls();
  const plan = sweep(fx, "--plan");
  assert.deepEqual(plan.result.rows.map((r) => [r.instance, r.outcome, r.backend]), [["hosted", "resumed", "fake"]]);
  assert.deepEqual(fx.verbs(), [], "a plan calls no provider for a stopped home");
  const swept = sweep(fx);
  assert.deepEqual(swept.result.rows.map((r) => [r.instance, r.outcome, r.backend]), [["hosted", "resumed", "fake"]], "the operator's stop has no row: it stays stopped");
  // Resumed: the stop is cleared, the endpoint kept, and one resume notice went through the provider's input.
  assert.deepEqual(runtimeOf(hosted.home), { launched: true, backend: "fake", provider: FAKE_CAPABILITY, endpoint: endpointOf("hosted", 1), stoppedAt: null });
  assert.equal(stopReceiptOf(hosted.home), null, "the stop is over: its receipt is gone");
  assert.deepEqual(fx.verbs().map((c) => [c.verb, c.instance, c.request.input.text ?? null]), [["input", "hosted", PROVIDER_RESUME_NOTICE]]);
  assert.equal(PROVIDER_RESUME_NOTICE.includes("\n"), false, "one line");
  assert.equal(fx.hooks().length, 0, "nothing is launched: no launch hook runs");
  assert.deepEqual([runtimeOf(operated.home).stoppedAt !== null, rowOf(fx, "operated").sessionEnd], [true, "stopped"]);
  // The next sweep finds it there and sends nothing.
  fx.clearCalls();
  assert.deepEqual(sweep(fx).result.rows.map((r) => [r.instance, r.outcome]), [["hosted", "already-running"]]);
  assert.deepEqual(fx.verbs("input"), []);
  // Every session that is there has a row, whatever its state word: it is the row `oats host run`
  // stops at shutdown, so that its input is refused while the host goes down.
  for (const observed of [{ present: true, state: "unknown", running: null }, { present: true, state: "shell", running: false }, { present: true, state: "shell", running: null }, { present: true, state: "unknown", running: false }]) {
    fx.control({ hosted: { inspect: { result: observed } } });
    assert.deepEqual(sweep(fx, "--plan").result.rows.map((r) => [r.instance, r.outcome, r.backend]), [["hosted", "already-running", "fake"]], JSON.stringify(observed));
  }
});

test("T6: an operator's stop after the host's withdraws the resume; a notice that is not sent leaves the home to resume", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("both"), other = await fx.launch("retry");
  hostStop(fx, home);
  operatorStop(fx, "both");
  assert.deepEqual([stopReceiptOf(home).resume, rowOf(fx, "both").sessionEnd], [undefined, "stopped"], "an operator's stop rewrites the stop receipt");
  await assert.rejects(fx.inEnv(() => startInstanceSession(home, { resume: true })), (e) => e.code === "E_RESUME_NOT_LOST");
  assert.deepEqual(sweep(fx).result.rows.map((r) => r.instance), ["retry"], "no row for the home an operator stopped");

  hostStop(fx, other.home);
  const stoppedAt = runtimeOf(other.home).stoppedAt;
  const stillToResume = () => assert.deepEqual([runtimeOf(other.home).stoppedAt, stopReceiptOf(other.home)?.resume, rowOf(fx, "retry").sessionEnd], [stoppedAt, true, "lost"]);
  // The notice is input: the provider's refusals are its refusals, and the stop is put back.
  for (const code of ["E_SESSION_INPUT_QUEUED", "E_SESSION_PROMPT_OPEN"]) {
    fx.control({ input: { error: { code, message: "the fake refuses" } } });
    await assert.rejects(fx.inEnv(() => startInstanceSession(other.home, { resume: true })), (e) => e.code === code, code);
    stillToResume();
  }
  // It holds on claims, as a scheduled wake does: a permission prompt is never answered by it.
  fx.control({});
  setWaiting(other.home, { producer: "oats.core", waiting: true, reason: "permission", message: "Claude needs your permission to use Bash" });
  fx.clearCalls();
  await assert.rejects(fx.inEnv(() => startInstanceSession(other.home, { resume: true })), (e) => e.code === "E_SESSION_PROMPT_OPEN" && /has a permission claim open/.test(e.message));
  assert.deepEqual(fx.verbs(), [], "nothing was sent");
  stillToResume();
  // The sweep reports the refusal, and tries again later.
  const refused = sweep(fx).result.rows.find((r) => r.instance === "retry");
  assert.deepEqual([refused.outcome, refused.reason, refused.code, refused.backend], ["refused", "start-refused", "E_SESSION_PROMPT_OPEN", "fake"]);
  setWaiting(other.home, { producer: "oats.core", waiting: false });
  const resumed = await fx.inEnv(() => startInstanceSession(other.home, { resume: true }));
  assert.deepEqual([resumed.resume, resumed.reused, resumed.target, resumed.session, runtimeOf(other.home).stoppedAt], [{ resumed: true, harness: "claude" }, "session", null, { provider: FAKE_CAPABILITY, endpoint: endpointOf("retry", 2) }, null]);
});

test("T7: a session in error, reported lost, is resumed by the sweep with one input, counted against the home's cap; at the cap a mail's input is refused", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("errored");
  // The fake's thread is in error and OATS did not stop it: the provider reads it lost.
  fx.control({ errored: { inspect: { result: LOST } } });
  const row = rowOf(fx, "errored");
  assert.deepEqual([row.running, row.runtimeState, row.sessionEnd, row.session], [false, "stopped", "lost", rowSessionOf("errored", 1)]);
  assert.equal(runtimeOf(home).stoppedAt, null, "OATS did not stop it");

  fx.clearCalls();
  const first = sweep(fx);
  assert.deepEqual(first.result.rows.map((r) => [r.instance, r.outcome, r.backend]), [["errored", "resumed", "fake"]]);
  assert.deepEqual(fx.verbs("input").map((c) => c.request.input.text), [PROVIDER_RESUME_NOTICE], "one input: the resume notice");
  assert.equal(runtimeOf(home).stoppedAt, null);
  // It is lost again each time: every resume is counted, a mail's input too (the provider restarts
  // the session on any input), until the cap.
  const mail = join(fx.base, "mail.txt");
  writeFileSync(mail, "aweb mail event received.\n");
  const input = () => fx.cli(["session", "input", "--home", home, "--text-file", mail, "--json"]).json();
  assert.equal(input().ok, true, "the second resume: a mail");
  for (let counted = 2; counted < RESUME_LIMIT; counted++) assert.deepEqual(sweep(fx).result.rows.map((r) => r.outcome), ["resumed"]);
  // At the cap: the kernel refuses before the provider's input is called, and the mail stays unread.
  fx.clearCalls();
  const capped = input();
  assert.deepEqual([capped.ok, capped.error.code], [false, "E_SESSION_NOT_RUNNING"]);
  assert.match(capped.error.message, /was resumed 3 times in the last hour, and was lost again each time/);
  assert.deepEqual(fx.verbs().map((c) => c.verb), ["inspect"], "the session was read; no input reached the provider");
  // The sweep is refused the same way, by the same count.
  fx.clearCalls();
  const refused = sweep(fx).result.rows[0];
  assert.deepEqual([refused.instance, refused.outcome, refused.reason, refused.code, refused.backend], ["errored", "refused", "keeps-getting-lost", "E_SESSION_NOT_RUNNING", "fake"]);
  assert.deepEqual(fx.verbs("input"), []);
  await assert.rejects(fx.inEnv(() => startInstanceSession(home, { resume: true })), (e) => e.code === "E_SESSION_NOT_RUNNING" && e.details.resumeCap.limit === RESUME_LIMIT);
  // A session that is there needs no resume: its input is not counted, cap or not.
  fx.control({});
  assert.equal(input().ok, true);
});

test("T7: an input to a lost session whose call fails stays counted: a failing provider lets no input past the cap", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("flaky");
  const { providerResumes } = await import("../lib/provider-resume.mjs");
  // The provider may have restarted the session on an input whose answer was lost (a non-zero
  // exit, a timeout, a malformed answer): whether it was sent is not known, so it is a resume.
  for (const [what, failing] of [["a failing command", { exit: 1 }], ["a malformed answer", { raw: "not json" }], ["a result outside the rules", { result: { submitted: false, verified: false } }]]) {
    fx.control({ flaky: { inspect: { result: LOST }, input: failing } });
    fx.clearCalls();
    const codes = [];
    for (let i = 0; i < RESUME_LIMIT + 2; i++) codes.push(await codeOf(() => fx.inEnv(() => inputInstanceSession(home, "mail"))));
    assert.deepEqual(codes, [...Array(RESUME_LIMIT).fill("E_SESSION_INPUT_FAILED"), "E_SESSION_NOT_RUNNING", "E_SESSION_NOT_RUNNING"], what);
    assert.equal(fx.verbs("input").length, RESUME_LIMIT, `${what}: the provider's input is called up to the cap, never past it`);
    assert.equal((await fx.inEnv(() => providerResumes(home))).count, RESUME_LIMIT);
    // (a new home's worth of count for the next case)
    rmSync(join(fx.env.OATS_HOME_DIR, "session-resume", "provider-resumes"), { recursive: true, force: true });
  }
  // The provider's own refusal says nothing was sent: not counted, however often.
  fx.control({ flaky: { inspect: { result: LOST }, input: { error: { code: "E_BACKEND_NOT_READY", message: "down" } } } });
  for (let i = 0; i < RESUME_LIMIT + 2; i++) assert.equal(await codeOf(() => fx.inEnv(() => inputInstanceSession(home, "mail"))), "E_SESSION_INPUT_FAILED");
  assert.equal((await fx.inEnv(() => providerResumes(home))).count, 0);
  // The resume notice follows the same rule.
  fx.control({ flaky: { inspect: { result: LOST }, input: { exit: 1 } } });
  for (let i = 0; i < RESUME_LIMIT; i++) await assert.rejects(fx.inEnv(() => startInstanceSession(home, { resume: true })), (e) => e.code === "E_SESSION_INPUT_FAILED");
  await assert.rejects(fx.inEnv(() => startInstanceSession(home, { resume: true })), (e) => e.code === "E_SESSION_NOT_RUNNING");
});

test("T7: a resume is not counted when its notice is not sent, and waits for the last run's processes to leave the home", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("waited");
  fx.control({ waited: { inspect: { result: LOST }, input: { error: { code: "E_SESSION_INPUT_QUEUED", message: "queued" } } } });
  // A queued notice is no resume: refused, and nothing is counted, however often.
  for (let i = 0; i < RESUME_LIMIT + 1; i++) await assert.rejects(fx.inEnv(() => startInstanceSession(home, { resume: true })), (e) => e.code === "E_SESSION_INPUT_QUEUED");
  // A process of the last run still works in the home (a harness can outlive its server's crash):
  // the resume waits, then refuses naming it, never kills it, and counts nothing.
  fx.control({ waited: { inspect: { result: LOST } } });
  const worker = spawnSync(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: ${JSON.stringify(home)}, detached: true, stdio: "ignore" });
    child.unref(); process.stdout.write(String(child.pid));`], { encoding: "utf8" });
  const pid = Number(worker.stdout);
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } });
  fx.clearCalls();
  const waited = fx.cli(["session", "start", "--resume", "--home", home, "--json"], { env: { OATS_TEST_PROVIDER_RESUME_WAIT_MS: "300" } }).json();
  assert.deepEqual([waited.ok, waited.error.code], [false, "E_SESSION_UNKNOWN"]);
  assert.match(waited.error.message, new RegExp(`a process of its last run still works in its home \\(.*${pid}.*nothing was killed`));
  // The sweep answers it as not readable, and tries again at the next one.
  const row = fx.cli(["session", "resume", "--deployment", fx.dep, "--json"], { env: { OATS_TEST_PROVIDER_RESUME_WAIT_MS: "300" } }).json().result.rows[0];
  assert.deepEqual([row.outcome, row.reason, row.backend], ["skipped", "unknown", "fake"]);
  // An input does not wait: refused at once, the mail left unread.
  assert.equal(await codeOf(() => fx.inEnv(() => inputInstanceSession(home, "mail"))), "E_SESSION_NOT_RUNNING");
  assert.deepEqual(fx.verbs("input"), [], "nothing was sent while the process was there");
  assert.doesNotThrow(() => process.kill(pid, 0), "the process was not killed");
  process.kill(pid, "SIGKILL");
  // Once it is gone the resume goes through, as the first counted one.
  for (let i = 0; i < 50; i++) { try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 20)); } catch { break; } }
  for (let i = 0; i < RESUME_LIMIT; i++) assert.equal((await fx.inEnv(() => startInstanceSession(home, { resume: true }))).resume.resumed, true);
  await assert.rejects(fx.inEnv(() => startInstanceSession(home, { resume: true })), (e) => e.code === "E_SESSION_NOT_RUNNING");
});

test("T8: attach refuses E_SESSION_NO_TERMINAL with the open link in its message", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("viewed");
  const attach = fx.cli(["session", "attach", "--home", home]);
  assert.equal(attach.status, 1);
  assert.equal(attach.stderr.trim(), `oats: viewed runs on session backend fake, which has no terminal to attach to; open it there: Open in fake (${FAKE_SERVER}/thread/thr_viewed_1)`);
  await assert.rejects(fx.inEnv(() => attachInstanceSession(home)), (e) => e.code === "E_SESSION_NO_TERMINAL" && JSON.stringify(e.details) === JSON.stringify({ backend: "fake", open: { label: "Open in fake", url: `${FAKE_SERVER}/thread/thr_viewed_1` } }));
  // Without a link (the provider offers none, or cannot be asked) the refusal stands.
  fx.control({ inspect: { result: { present: true, state: "unknown", running: null } } });
  await assert.rejects(fx.inEnv(() => attachInstanceSession(home)), (e) => e.code === "E_SESSION_NO_TERMINAL" && e.message === "viewed runs on session backend fake, which has no terminal to attach to" && e.details.open === null);
  fx.control({ inspect: { exit: 1 } });
  await assert.rejects(fx.inEnv(() => attachInstanceSession(home)), (e) => e.code === "E_SESSION_NO_TERMINAL" && e.details.open === null);
});

test("T9: --backend fake --harness codex, where the fake lists claude only, is E_BACKEND_HARNESS and creates nothing", async (t) => {
  const fx = providerDeployment(t);
  const refused = fx.cli(["spawn", "dev", "--name", "wrong-harness", "--backend", "fake", "--harness", "codex", "--json"]);
  assert.equal(refused.status, 1);
  assert.deepEqual(refused.json(), { schemaVersion: 1, ok: false, error: { code: "E_BACKEND_HARNESS", message: "session backend fake (acme.fake) does not run the codex harness; it runs claude; nothing was created", details: { backend: "fake", capability: FAKE_CAPABILITY, harness: "codex", harnesses: ["claude"] } } });
  assert.equal(existsSync(join(fx.root, "dev", "instances", "wrong-harness")), false);
  assert.deepEqual(fx.calls(), [], "no hook ran and no provider was called");
  // A preview refuses the same way; so does the soul's default harness when the provider does not list it.
  assert.equal(fx.cli(["spawn", "dev", "--backend", "fake", "--harness", "codex", "--preview", "--json"]).json().error.code, "E_BACKEND_HARNESS");
  assert.equal(fx.cli(["spawn", "dev", "--backend", "fake", "--json"]).json().error.code, "E_BACKEND_HARNESS", "the host default harness is pi");
  // A start that selects a harness the provider does not run is refused before anything is stopped.
  const { home } = await fx.launch("selected");
  fx.clearCalls();
  await assert.rejects(fx.inEnv(() => restartInstanceSession(home, { harness: "codex" })), (e) => e.code === "E_BACKEND_HARNESS" && /nothing was stopped or started/.test(e.message));
  assert.deepEqual(fx.verbs().map((c) => c.verb), ["inspect"], "the session was read, and neither stopped nor launched");
});

test("T9: E_BACKEND_UNKNOWN names the backends available; a schedule and a trigger take a provider's name", async (t) => {
  const fx = providerDeployment(t);
  const unknown = fx.cli(["spawn", "dev", "--name", "nowhere", "--backend", "nope", "--json"]).json();
  assert.deepEqual([unknown.error.code, unknown.error.details], ["E_BACKEND_UNKNOWN", { backend: "nope", available: ["tmux", "fake"] }]);
  assert.match(unknown.error.message, /the backends available here: tmux, fake; nothing was created/);
  // A soul that does not compose the provider cannot use it.
  const plain = fx.cli(["spawn", "plain", "--name", "nowhere", "--backend", "fake", "--json"]).json();
  assert.deepEqual([plain.error.code, plain.error.details.available], ["E_BACKEND_UNKNOWN", ["tmux"]]);
  assert.equal(fx.cli(["spawn", "dev", "--backend", "Not A Name", "--json"]).json().error.code, "E_BAD_ARGS");
  assert.equal(fx.cli(["spawn", "dev", "--backend", "herdr", "--json"]).json().error.code, "E_HERDR_REMOVED");
  assert.equal(existsSync(join(fx.root, "dev", "instances")), false, "nothing was created");

  const { validateDefinition } = await import("../lib/schedule.mjs");
  const { validateTrigger } = await import("../lib/triggers.mjs");
  const job = { id: "nightly", kind: "spawn", cron: "0 3 * * *", tz: "UTC", agent: "dev", task: "run", launchConfig: "claude" };
  assert.equal(await fx.inEnv(() => validateDefinition(fx.dep, { ...job, backend: "fake" }, { checkAgent: false })).then((d) => d.backend), "fake");
  await assert.rejects(fx.inEnv(() => validateDefinition(fx.dep, { ...job, backend: "Not A Name" }, { checkAgent: false })), (e) => e.code === "E_SCHEDULE_INVALID" && e.field === "backend");
  await assert.rejects(fx.inEnv(() => validateDefinition(fx.dep, { ...job, backend: "herdr" }, { checkAgent: false })), (e) => e.code === "E_HERDR_REMOVED");
  const trigger = { id: "reviews", kind: "trigger", on: { source: "github.pull_request", repo: "github.com/acme/app", events: ["opened"], poll: "2m" }, spawn: { soul: "dev", purpose: "review-{number}", task: "review {url}" } };
  assert.equal(validateTrigger({ ...trigger, spawn: { ...trigger.spawn, backend: "fake" } }).spawn.backend, "fake");
  assert.throws(() => validateTrigger({ ...trigger, spawn: { ...trigger.spawn, backend: "Not A Name" } }), (e) => e.code === "E_TRIGGER_INVALID" && e.field === "spawn.backend");
});

test("T11: status with three homes of one fake provider calls inspectMany once", async (t) => {
  const fx = providerDeployment(t);
  for (const name of ["many-a", "many-b", "many-c"]) await fx.launch(name);
  const stopped = await fx.launch("many-stopped");
  operatorStop(fx, "many-stopped");
  fx.control({ "many-b": { inspect: { result: { present: true, state: "shell", running: false } } }, "many-c": { inspect: { error: { code: "E_BACKEND_NOT_READY", message: "two live threads: thr_1, thr_2" } } } });
  fx.clearCalls();
  const rows = rowsOf(fx);
  const calls = fx.verbs();
  assert.equal(calls.length, 1, calls.map((c) => c.verb).join(", "));
  assert.equal(calls[0].verb, "inspectMany");
  // One request for the three, in the listing's order; the home OATS stopped is not asked about.
  assert.deepEqual(calls[0].request.input, { homes: ["many-a", "many-b", "many-c"].map((name, i) => ({ home: join(fx.root, "dev", "instances", name), instance: name, endpoint: endpointOf(name, i + 1) })) });
  const facts = (name) => { const r = rows.find((row) => row.instance === name); return [r.backend, r.running, r.runtimeState, r.runtimeError ?? null, r.open?.url ?? null, r.tmux]; };
  assert.deepEqual(facts("many-a"), ["fake", true, "unknown", null, `${FAKE_SERVER}/thread/thr_many-a_1`, null]);
  assert.deepEqual(facts("many-b"), ["fake", false, "shell", null, null, null]);
  assert.deepEqual(facts("many-c"), ["fake", null, "unreachable", "E_BACKEND_NOT_READY: two live threads: thr_1, thr_2", null, null]);
  assert.deepEqual(facts("many-stopped"), ["fake", false, "stopped", null, null, null]);
  // A row's session is the capability and the thread id alone: never the endpoint.
  assert.deepEqual(rows.filter((row) => row.session).map((row) => row.session), ["many-a", "many-b", "many-c", "many-stopped"].map((name, i) => rowSessionOf(name, i + 1)));
  assert.equal(stopped.home, join(fx.root, "dev", "instances", "many-stopped"));

  // A bad batch (a failed call, results that are not one per home) falls back to each home's own
  // inspect, never to "stopped"; so does one entry that is no inspect answer.
  for (const bad of [{ result: { results: [] } }, { exit: 1 }, { raw: "not json" }]) {
    fx.control({ inspectMany: bad, "many-b": { inspect: { result: { present: true, state: "shell", running: false } } } });
    fx.clearCalls();
    assert.deepEqual(rowsOf(fx).filter((r) => r.instance !== "many-stopped").map((r) => [r.running, r.runtimeState]), [[true, "unknown"], [false, "shell"], [true, "unknown"]], JSON.stringify(bad));
    assert.deepEqual(fx.verbs().map((c) => [c.verb, c.instance]), [["inspectMany", "many-a"], ["inspect", "many-a"], ["inspect", "many-b"], ["inspect", "many-c"]]);
  }
  fx.control({ inspectMany: { result: { results: [{ present: true, state: "unknown", running: true }, { present: "yes" }, { error: { code: "E_BACKEND_NOT_READY", message: "down" } }] } } });
  fx.clearCalls();
  assert.deepEqual(rowsOf(fx).filter((r) => r.instance !== "many-stopped").map((r) => [r.running, r.runtimeState]), [[true, "unknown"], [true, "unknown"], [null, "unreachable"]]);
  assert.deepEqual(fx.verbs().map((c) => [c.verb, c.instance]), [["inspectMany", "many-a"], ["inspect", "many-b"]], "the bad entry's home is asked on its own; a refusal stands");
  // In process, with the listing's own reader: the same single call.
  fx.control({});
  fx.clearCalls();
  await fx.inEnv(() => listInstances(fx.root));
  assert.deepEqual(fx.verbs().map((c) => c.verb), ["inspectMany"]);
});

test("T11: a provider without inspectMany is asked per home; homes with different settings are asked apart", async (t) => {
  const fx = providerDeployment(t, { manifest: fakeManifest({ fake: fakeProvider({ inspectMany: false }) }) });
  for (const name of ["solo-a", "solo-b"]) await fx.launch(name);
  fx.clearCalls();
  assert.deepEqual(rowsOf(fx).map((r) => [r.instance, r.running]), [["solo-a", true], ["solo-b", true]]);
  assert.deepEqual(fx.verbs().map((c) => [c.verb, c.instance]), [["inspect", "solo-a"], ["inspect", "solo-b"]]);

  const grouped = providerDeployment(t);
  await grouped.launch("default-a");
  await grouped.launch("default-b");
  await grouped.launch("other-server", { providers: { [FAKE_CAPABILITY]: { server: "http://127.0.0.1:10" } } });
  grouped.clearCalls();
  rowsOf(grouped);
  assert.deepEqual(grouped.verbs().map((c) => [c.verb, c.request.input.homes.map((h) => h.instance), JSON.parse(c.settings)]), [
    ["inspectMany", ["default-a", "default-b"], {}],
    ["inspectMany", ["other-server"], { server: "http://127.0.0.1:10" }],
  ]);
});

test("T4: a stop that lands while an input runs still wins: the input is not delivered, and the session is stopped again", async (t) => {
  // An input holds no claim, and a provider restarts a session on it. A stop that lands between
  // the input's read of the receipt and its send, or during the send, must leave the home stopped.
  const fx = providerDeployment(t);
  const text = join(fx.base, "mail.txt");
  writeFileSync(text, "aweb mail event received.\n");
  const inputWhile = async (home, act) => {
    const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "oats.mjs"), "session", "input", "--home", home, "--text-file", text, "--json"], { cwd: fx.dep, env: fx.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    const done = new Promise((resolve) => child.on("close", resolve));
    await new Promise((r) => setTimeout(r, 900));
    await act();
    await done;
    return JSON.parse(out.trim().split("\n").pop());
  };
  // 1. The stop lands while the input still reads the session (a slow inspect): nothing is sent.
  const early = await fx.launch("early");
  fx.control({ early: { inspect: { sleepMs: 2500 } } });
  fx.clearCalls();
  const refused = await inputWhile(early.home, () => fx.inEnv(() => stopInstanceSession(early.home, {})));
  assert.deepEqual([refused.ok, refused.error.code], [false, "E_SESSION_NOT_RUNNING"]);
  assert.deepEqual(fx.verbs().map((c) => c.verb), ["inspect", "stop"], "the stop was called; the input never was");
  // 2. The stop lands while the provider is sending: the session it may have restarted is stopped again.
  const late = await fx.launch("late");
  fx.control({ late: { input: { sleepMs: 2500 } } });
  fx.clearCalls();
  const undelivered = await inputWhile(late.home, () => fx.inEnv(() => stopInstanceSession(late.home, {})));
  assert.deepEqual([undelivered.ok, undelivered.error.code], [false, "E_SESSION_NOT_RUNNING"]);
  assert.match(undelivered.error.message, /was stopped or restarted by OATS while this input was being sent; its fake session was asked to stop again, and the input is not delivered/);
  assert.deepEqual(fx.verbs().map((c) => c.verb), ["inspect", "input", "stop", "stop"], "a second stop follows the input that crossed the first");
  assert.equal(Number.isFinite(Date.parse(runtimeOf(late.home).stoppedAt)), true);
  // 3. A restart lands while the input is sent: it went to the endpoint the restart replaced.
  const moved = await fx.launch("moved");
  fx.control({ moved: { input: { sleepMs: 2500 } } });
  fx.clearCalls();
  const stale = await inputWhile(moved.home, () => fx.inEnv(() => restartInstanceSession(moved.home, {})));
  assert.deepEqual([stale.ok, stale.error.code], [false, "E_SESSION_NOT_RUNNING"]);
  assert.deepEqual(fx.verbs("stop").map((c) => c.request.input.endpoint), [endpointOf("moved", 3), endpointOf("moved", 3)], "the replaced session is stopped by the restart, and again after the input that reached it");
  assert.deepEqual(runtimeOf(moved.home).endpoint, endpointOf("moved", 4));
});

test("a start of a home whose last stop was not confirmed asks the provider to stop again before it launches", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("half");
  fx.control({ stop: { exit: 1 } });
  assert.equal(hostStop(fx, home).code, "E_SESSION_STOP_FAILED");
  fx.clearCalls();
  await assert.rejects(fx.inEnv(() => startInstanceSession(home, {})), (e) => e.code === "E_SESSION_STOP_FAILED" && /did not confirm that its last session stopped .*nothing was started/.test(e.message));
  assert.deepEqual(fx.verbs().map((c) => c.verb), ["stop"], "no launch beside a session that may still run");
  assert.deepEqual(runtimeOf(home).endpoint, endpointOf("half", 1), "the endpoint OATS can still address is kept");
  fx.control({});
  fx.clearCalls();
  const started = await fx.inEnv(() => startInstanceSession(home, {}));
  assert.deepEqual(fx.verbs().map((c) => [c.verb, c.request.input.endpoint ?? c.request.input.previous]), [["stop", endpointOf("half", 1)], ["launch", endpointOf("half", 1)]]);
  assert.deepEqual(started.session.endpoint, endpointOf("half", 2));
});

test("a listing bounds what it waits for a provider: the shutdown's plan asks none, and a batch that timed out is not asked again per home", async (t) => {
  const fx = providerDeployment(t);
  for (const name of ["slow-a", "slow-b"]) await fx.launch(name);
  await fx.spawn("plain", { name: "on-tmux" });
  // What `oats host run` lists with when the host stops: no provider is asked, so a provider that
  // hangs (its server goes down with the host) cannot fail the listing, and every provider home
  // OATS has not stopped still has its row, the one the run stops.
  fx.control({ inspectMany: { sleepMs: 60_000 }, inspect: { sleepMs: 60_000 } });
  fx.clearCalls();
  const began = Date.now();
  const plan = sweep(fx, "--plan", "--without-provider-inspect");
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.ok(Date.now() - began < 5000, "it does not wait for a provider");
  assert.deepEqual(plan.result.rows.map((r) => [r.instance, r.outcome, r.reason, r.backend]), [["slow-a", "skipped", "unknown", "fake"], ["slow-b", "skipped", "unknown", "fake"]]);
  assert.deepEqual(fx.verbs(), [], "no provider was called");
  const noPlan = sweep(fx, "--without-provider-inspect");
  assert.deepEqual([noPlan.ok, noPlan.error.code], [false, "E_BAD_ARGS"], "only a plan: a sweep that asks no provider cannot tell a lost session");
  // A status that asks: a batch that timed out is every row's answer; the homes are not asked again
  // one by one, each for the same timeout.
  fx.clearCalls();
  const rows = JSON.parse(fx.cli(["status", "--json"], { env: { OATS_TEST_SESSION_PROVIDER_TIMEOUT_MS: "400" } }).stdout).agents.flatMap((a) => a.instances);
  assert.deepEqual(rows.map((r) => [r.instance, r.running, r.runtimeState ?? null]), [["slow-a", null, "unreachable"], ["slow-b", null, "unreachable"], ["on-tmux", false, null]]);
  assert.match(rows[0].runtimeError, /did not answer inspectMany within/);
  assert.deepEqual(fx.verbs().map((c) => c.verb), ["inspectMany"]);
});

test("oats launch-config preview of a provider home answers no command line", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("previewed");
  const preview = fx.cli(["launch-config", "preview", "--home", home, "--json"]).json();
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.deepEqual([preview.result.command, preview.result.argv, preview.result.executable.path, preview.result.harness, preview.result.ok], [null, null, null, "claude", true]);
  assert.deepEqual(preview.result.environment, [{ name: "ACME_FAKE_TOKEN_FILE", redacted: true }]);
  assert.equal(preview.result.preflight.find((c) => c.check === "backend").ok, true);
  assert.equal(JSON.stringify(preview).includes("'null'"), false);
});

// --------------------------------------------------------------------------------- the other verbs

test("restart stops, then launches, under the kernel's stop rule; a start never launches over a session that is there", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("cycled");
  fx.clearCalls();
  // A session that is there and that OATS did not stop: running, or not tellable.
  await assert.rejects(fx.inEnv(() => startInstanceSession(home, {})), (e) => e.code === "E_SESSION_RUNNING");
  fx.control({ inspect: { result: { present: true, state: "unknown", running: null } } });
  await assert.rejects(fx.inEnv(() => startInstanceSession(home, {})), (e) => e.code === "E_SESSION_UNKNOWN");
  fx.control({ inspect: { result: { present: true, state: "shell", running: false } } });
  await assert.rejects(fx.inEnv(() => startInstanceSession(home, {})), (e) => e.code === "E_SESSION_UNKNOWN");
  fx.control({ inspect: { exit: 1 } });
  await assert.rejects(fx.inEnv(() => startInstanceSession(home, {})), (e) => e.code === "E_SESSION_UNKNOWN");
  assert.deepEqual(fx.verbs().map((c) => c.verb), ["inspect", "inspect", "inspect", "inspect"], "nothing was stopped or launched");
  assert.equal(fx.hooks().length, 0, "no launch hook ran for a refused start");

  // A session that is gone is replaced by a start.
  fx.control({ inspect: { result: { present: false, state: "stopped", running: false } } });
  const replaced = await fx.inEnv(() => startInstanceSession(home, {}));
  assert.deepEqual(replaced.session.endpoint, endpointOf("cycled", 2));

  fx.control({});
  fx.clearCalls();
  const restarted = await fx.inEnv(() => restartInstanceSession(home, { stopGraceMs: 5000 }));
  assert.deepEqual(fx.calls().map((c) => c.hook ?? c.verb), ["inspect", "launch", "stop", "launch"], "the launch hook runs before the stop and the provider's launch");
  assert.deepEqual(fx.verbs("stop")[0].request.input, { home, endpoint: endpointOf("cycled", 2), graceSeconds: 5 });
  assert.deepEqual([restarted.session.endpoint, restarted.restartCount, restarted.stop.stopped], [endpointOf("cycled", 3), 2, true]);
  assert.deepEqual([recordOf(home).session.endpoint, recordOf(home).restartCount, runtimeOf(home).stoppedAt], [endpointOf("cycled", 3), 2, null]);

  // A restart whose stop is not confirmed launches nothing, and the home stays stopped.
  fx.control({ stop: { error: { code: "E_BACKEND_NOT_READY", message: "down" } } });
  fx.clearCalls();
  await assert.rejects(fx.inEnv(() => restartInstanceSession(home, {})), (e) => e.code === "E_SESSION_STOP_FAILED");
  assert.equal(fx.verbs("launch").length, 0);
  assert.equal(Number.isFinite(Date.parse(runtimeOf(home).stoppedAt)), true);
});

test("a launch the provider refuses or fails leaves the home as it was; its own E_BACKEND_* refusal is relayed", async (t) => {
  const fx = providerDeployment(t);
  // At spawn: nothing is left behind.
  fx.control({ launch: { error: { code: "E_BACKEND_LAUNCH_ENV", message: "ANTHROPIC_API_KEY comes from a secret source" } } });
  const refused = fx.cli(["spawn", "dev", "--name", "refused", "--backend", "fake", "--launch-config", "claude", "--json"]).json();
  assert.deepEqual([refused.ok, refused.error.code], [false, "E_BACKEND_LAUNCH_ENV"]);
  assert.match(refused.error.message, /session backend fake refused to launch refused: ANTHROPIC_API_KEY comes from a secret source/);
  assert.equal(existsSync(join(fx.root, "dev", "instances", "refused")), false, "the spawn was rolled back");
  assert.deepEqual(fx.verbs().map((c) => c.verb), ["launch"], "a refusal started nothing: no stop is needed");

  // A launch whose answer is lost may have started a session: the provider stops what is rooted at the home.
  fx.clearCalls();
  fx.control({ launch: { raw: "garbage" } });
  const lost = fx.cli(["spawn", "dev", "--name", "lost-answer", "--backend", "fake", "--launch-config", "claude", "--json"]).json();
  assert.deepEqual([lost.ok, lost.error.code], [false, "E_SESSION_START_FAILED"]);
  assert.deepEqual(fx.verbs().map((c) => [c.verb, c.request.input.endpoint ?? null]), [["launch", null], ["stop", null]]);
  assert.equal(existsSync(join(fx.root, "dev", "instances", "lost-answer")), false);
  // An endpoint over 4 KiB, or one that is no object, is no endpoint.
  for (const endpoint of [{ blob: "x".repeat(4100) }, "thr_1", ["thr_1"], null]) {
    fx.control({ launch: { result: { endpoint } } });
    assert.equal(fx.cli(["spawn", "dev", "--name", "bad-endpoint", "--backend", "fake", "--launch-config", "claude", "--json"]).json().error.code, "E_SESSION_START_FAILED", JSON.stringify(endpoint).slice(0, 40));
    assert.equal(existsSync(join(fx.root, "dev", "instances", "bad-endpoint")), false);
  }
  // Just inside the bound is recorded as given.
  const big = { blob: "x".repeat(4000) };
  fx.control({ launch: { result: { endpoint: big } } });
  const { home } = await fx.launch("big-endpoint");
  assert.deepEqual([recordOf(home).session.endpoint, runtimeOf(home).endpoint], [big, big]);

  // At a start: the home stays stopped, with the endpoint it had.
  fx.control({});
  const { home: kept } = await fx.launch("kept");
  await fx.inEnv(() => stopInstanceSession(kept, {}));
  const { stoppedAt, endpoint: keptEndpoint } = runtimeOf(kept);
  fx.control({ launch: { error: { code: "E_BACKEND_VERSION", message: "bb 0.49 is not the pinned 0.50.1" } } });
  await assert.rejects(fx.inEnv(() => startInstanceSession(kept, {})), (e) => e.code === "E_BACKEND_VERSION");
  fx.control({ launch: { exit: 9 } });
  await assert.rejects(fx.inEnv(() => startInstanceSession(kept, {})), (e) => e.code === "E_SESSION_START_FAILED");
  assert.deepEqual(runtimeOf(kept), { launched: true, backend: "fake", provider: FAKE_CAPABILITY, endpoint: keptEndpoint, stoppedAt });
});

test("the launch input marks a launch configuration's secret, so a provider can refuse it; a configuration's executable is refused by the kernel", async (t) => {
  const fx = providerDeployment(t, { local: { "launch-configs": {
    claude: { harness: "claude" },
    keyed: { harness: "claude", args: ["--verbose", "two words"], env: { REGION: "eu", API_KEY: { fromEnv: "FIXTURE_SECRET" } }, yolo: true },
    wrapped: { harness: "claude", executable: "/usr/bin/true" },
  } } });
  process.env.FIXTURE_SECRET = "s3cret";
  t.after(() => { delete process.env.FIXTURE_SECRET; });
  await fx.launch("keyed", { launchConfig: "keyed", model: "claude-opus" });
  const input = fx.verbs("launch")[0].request.input;
  assert.deepEqual(input.env.slice(2), [
    { name: "ACME_FAKE_TOKEN_FILE", value: "/nowhere/token", source: "capability", capability: FAKE_CAPABILITY },
    { name: "API_KEY", value: "s3cret", source: "launch-config-reference", secret: true },
    { name: "REGION", value: "eu", source: "launch-config" },
  ]);
  assert.deepEqual([input.args, input.model, input.yolo, input.harness], [["--verbose", "two words"], "claude-opus", true, "claude"]);
  // The record keeps the reference, never the value.
  assert.equal(JSON.stringify(recordOf(join(fx.root, "dev", "instances", "keyed"))).includes("s3cret"), false);

  const wrapped = fx.cli(["spawn", "dev", "--name", "wrapped", "--backend", "fake", "--launch-config", "wrapped", "--json"]).json();
  assert.deepEqual([wrapped.error.code, wrapped.error.details], ["E_BACKEND_LAUNCH_ARG", { backend: "fake", launchConfig: "wrapped", field: "executable" }]);
  assert.equal(existsSync(join(fx.root, "dev", "instances", "wrapped")), false);
});

test("a capability's launch arguments arrive in the launch input's args, after the configuration's; ones that are no words are refused", async (t) => {
  const fx = providerDeployment(t, { local: { "launch-configs": { claude: { harness: "claude" }, keyed: { harness: "claude", args: ["--verbose"] } } } });
  fx.hookLaunch({ claude: "--channels plugin:aweb@awebai '--settings' '/a b/settings.json'", codex: "--never" });
  const { home } = await fx.launch("withargs", { launchConfig: "keyed" });
  assert.deepEqual(fx.verbs("launch")[0].request.input.args, ["--verbose", "--channels", "plugin:aweb@awebai", "--settings", "/a b/settings.json"], "the harness's own, as the words a window's shell would hand it");
  // A restart hands them over again.
  fx.clearCalls();
  await fx.inEnv(() => startInstanceSession(home, { restart: true }));
  assert.deepEqual(fx.verbs("launch")[0].request.input.args, ["--verbose", "--channels", "plugin:aweb@awebai", "--settings", "/a b/settings.json"]);

  // Arguments the kernel cannot read as words: refused, naming the capability; nothing is created.
  fx.hookLaunch({ claude: "--settings 'unclosed" });
  fx.clearCalls();
  const refused = fx.cli(["spawn", "dev", "--name", "nowords", "--backend", "fake", "--launch-config", "claude", "--json"]).json();
  assert.equal(refused.error.code, "E_BACKEND_LAUNCH_ARG");
  assert.match(refused.error.message, new RegExp(`the claude launch arguments of ${FAKE_CAPABILITY.replace(".", "\\.")} \\("--settings 'unclosed"\\) cannot be read as words`));
  assert.deepEqual(refused.error.details, { field: "args", capabilities: [FAKE_CAPABILITY] });
  assert.equal(existsSync(join(fx.root, "dev", "instances", "nowords")), false);
  assert.deepEqual(fx.verbs(), [], "the provider was never called");
});

test("spawn --suggest-name on a session provider asks the harness on this host's PATH for the name", (t) => {
  const fx = providerDeployment(t);
  const naming = fx.cli(["spawn", "dev", "--suggest-name", "--backend", "fake", "--launch-config", "claude", "--task", "fix the login bug", "--preview", "--json"]).json().result.naming;
  // The fixture's claude was run, and answers no name: never "no executable for it here".
  assert.deepEqual([naming.source, naming.reason, naming.message], ["numbered", "invalid-reply", "claude's reply holds no name"]);
});

test("the authority check: a record that disagrees with the receipt is refused, with the provider's field labels", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("drifted");
  fx.clearCalls();
  const mismatch = async (change) => {
    const original = readFileSync(join(home, "instance.json"), "utf8");
    writeFileSync(join(home, "instance.json"), JSON.stringify(change(JSON.parse(original)), null, 2) + "\n");
    try { await fx.inEnv(() => inspectInstanceSession(home)); return null; }
    catch (e) { return [e.code, e.details?.fields ?? null]; }
    finally { writeFileSync(join(home, "instance.json"), original); }
  };
  assert.deepEqual(await mismatch((m) => ({ ...m, backend: "other" })), ["E_RUNTIME_AUTHORITY_MISMATCH", ["backend"]]);
  assert.deepEqual(await mismatch((m) => ({ ...m, session: { ...m.session, provider: "acme.other" } })), ["E_RUNTIME_AUTHORITY_MISMATCH", ["session.provider"]]);
  assert.deepEqual(await mismatch((m) => ({ ...m, session: { ...m.session, endpoint: { ...m.session.endpoint, threadId: "thr_someone_else" } } })), ["E_RUNTIME_AUTHORITY_MISMATCH", ["session.endpoint"]]);
  assert.deepEqual(await mismatch((m) => ({ ...m, launched: false, backend: "other", session: { provider: "acme.other", endpoint: null } })), ["E_RUNTIME_AUTHORITY_MISMATCH", ["launched", "backend", "session.provider", "session.endpoint"]]);
  assert.deepEqual(await mismatch(({ session: _gone, ...m }) => m), ["E_RUNTIME_AUTHORITY_MISMATCH", ["session.provider", "session.endpoint"]]);
  // Key order is not a difference.
  assert.equal(await mismatch((m) => ({ ...m, session: { endpoint: { threadId: m.session.endpoint.threadId, server: m.session.endpoint.server }, provider: m.session.provider } })), null);
  // Input, stop and start refuse on the same check, before any provider call.
  writeFileSync(join(home, "instance.json"), JSON.stringify({ ...recordOf(home), session: { provider: FAKE_CAPABILITY, endpoint: { threadId: "thr_someone_else" } } }, null, 2) + "\n");
  fx.clearCalls();
  for (const verb of [() => inputInstanceSession(home, "x"), () => stopInstanceSession(home, {}), () => startInstanceSession(home, {}), () => attachInstanceSession(home)]) assert.equal(await codeOf(() => fx.inEnv(verb)), "E_RUNTIME_AUTHORITY_MISMATCH");
  assert.deepEqual([rowOf(fx, "drifted").running, rowOf(fx, "drifted").runtimeState], [null, "unreachable"]);
  assert.deepEqual(fx.verbs(), [], "the provider is never called with an endpoint the receipt does not authorise");
  // A receipt whose endpoint is over the bound authorises nothing.
  const receipt = readJson(receiptOf(home));
  writeFileSync(receiptOf(home), JSON.stringify({ ...receipt, runtime: { ...receipt.runtime, endpoint: { blob: "x".repeat(5000) } } }));
  assert.equal(await codeOf(() => fx.inEnv(() => inspectInstanceSession(home))), "E_RUNTIME_ENDPOINT_UNKNOWN");
});

// ----------------------------------------------------------------------------------- the retire

test("retire of a provider home: stoppedAt, the provider's stop, then the home is removed with nothing to recover", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("leaving");
  fx.clearCalls();
  const plan = fx.cli(["retire", "leaving", "--plan", "--json"]).json();
  assert.deepEqual(plan.result.facts.session, { state: "unknown", present: true, backend: "fake", established: true });
  const retired = JSON.parse(fx.cli(["retire", "leaving", "--json"]).stdout);
  assert.deepEqual([retired.retired, retired.removedDir, retired.workRecovery ?? null, retired.warnings ?? null], ["leaving", true, null, null], "the launch's own writes of the record are no change to recover");
  assert.deepEqual(fx.verbs("stop").map((c) => c.request.input), [{ home, endpoint: endpointOf("leaving", 1), graceSeconds: 20 }]);
  assert.deepEqual(fx.verbs().filter((c) => !["inspect", "inspectMany", "stop"].includes(c.verb)), []);
  assert.equal(existsSync(home), false);
});

test("retire when the provider cannot stop the session: it goes on only when no process works in the home", async (t) => {
  const fx = providerDeployment(t);
  // The provider's capability was removed by an upgrade: inspect is unavailable, the retire still works.
  const { home } = await fx.launch("orphaned");
  rmSync(join(home, ".oats", "modules", FAKE_CAPABILITY), { recursive: true });
  const inspected = fx.cli(["session", "inspect", "--home", home, "--json"]).json();
  assert.equal(inspected.error.code, "E_SESSION_UNAVAILABLE");
  assert.match(inspected.error.message, /capability acme\.fake, which supplies this home's session backend fake, is not among the home's modules/);
  assert.deepEqual([rowOf(fx, "orphaned").running, rowOf(fx, "orphaned").runtimeState], [null, "unreachable"]);
  assert.equal(await codeOf(() => fx.inEnv(() => inputInstanceSession(home, "x"))), "E_SESSION_INPUT_FAILED");
  const retired = JSON.parse(fx.cli(["retire", "orphaned", "--force", "--json"]).stdout);
  assert.equal(retired.retired, "orphaned", JSON.stringify(retired));
  assert.match(retired.warnings.join("\n"), /the fake session of orphaned was not stopped through its session backend .*no process works in its home, so the retire went on/);
  assert.equal(existsSync(home), false);

  // The provider fails its stop while a process works in the home: refused, the home kept.
  const busy = await fx.launch("busy");
  fx.control({ stop: { exit: 1 } });
  const worker = spawnSync(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: ${JSON.stringify(busy.home)}, detached: true, stdio: "ignore" });
    child.unref(); process.stdout.write(String(child.pid));`], { encoding: "utf8" });
  const pid = Number(worker.stdout);
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } });
  const refused = fx.cli(["retire", "busy", "--json"]).json();
  assert.deepEqual([refused.ok, refused.error.code], [false, "E_RUNTIME_QUIESCE_FAILED"]);
  assert.match(refused.error.message, new RegExp(`a process works in its home \\(.*${pid}`));
  assert.equal(existsSync(busy.home), true);
  assert.equal(Number.isFinite(Date.parse(runtimeOf(busy.home).stoppedAt)), true, "stoppedAt was recorded first: its input is refused from then on");
  // A stop the provider CONFIRMS is no word on the home's processes: the same scan, the same refusal.
  fx.control({});
  const still = fx.cli(["retire", "busy", "--json"]).json();
  assert.deepEqual([still.ok, still.error.code], [false, "E_RUNTIME_QUIESCE_FAILED"]);
  assert.match(still.error.message, new RegExp(`the fake session of busy stopped, and a process works in its home \\(.*${pid}`));
  assert.equal(existsSync(busy.home), true);
  process.kill(pid, "SIGKILL");
});

test("inputs that run at the same time to a lost session pass the cap together never: the count is taken under a lock", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("crowd");
  const text = join(fx.base, "mail.txt");
  writeFileSync(text, "aweb mail event received.\n");
  // Each input's provider call takes a while, so the ten overlap; none of them is "a process of
  // the home's last run" to another (a provider call never works in the home).
  fx.control({ inspect: { result: LOST }, input: { sleepMs: 300 } });
  fx.clearCalls();
  const input = () => new Promise((done) => {
    const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "oats.mjs"), "session", "input", "--home", home, "--text-file", text, "--json"], { cwd: fx.dep, env: fx.env, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => done(JSON.parse(out.trim().split("\n").pop())));
  });
  const answers = await Promise.all(Array.from({ length: 10 }, input));
  assert.equal(answers.filter((a) => a.ok).length, RESUME_LIMIT, JSON.stringify(answers.filter((a) => !a.ok).map((a) => a.error.message.slice(0, 160))));
  assert.deepEqual([...new Set(answers.filter((a) => !a.ok).map((a) => [a.error.code, a.error.details?.resumeCap?.limit ?? null].join(" ")))], [`E_SESSION_NOT_RUNNING ${RESUME_LIMIT}`], "every other one is refused by the cap, and by nothing else");
  assert.equal(fx.verbs("input").length, RESUME_LIMIT, "the provider's input is called up to the cap");
  assert.equal((await input()).error.code, "E_SESSION_NOT_RUNNING", "and the next one too");

  // A count whose lock the system will not make is a count that cannot be written: the same refusal.
  const counts = join(fx.env.OATS_HOME_DIR, "session-resume", "provider-resumes");
  rmSync(counts, { recursive: true, force: true });
  writeFileSync(counts, "not a directory\n");
  fx.clearCalls();
  const uncounted = await input();
  assert.equal(uncounted.error.code, "E_SESSION_NOT_RUNNING");
  assert.match(uncounted.error.message, /crowd lost its session, and its resume could not be counted \(.+\); nothing was sent/);
  assert.deepEqual(fx.verbs("input"), []);
});

// ----------------------------------------------------------------------- T12: nothing relayed

test("T12: relayed rows and routed answers for a provider home carry no session.threadId and no session.endpoint", async (t) => {
  const fx = providerDeployment(t);
  const spawned = fx.cli(["spawn", "dev", "--name", "far", "--backend", "fake", "--launch-config", "claude", "--json"]);
  const { home } = spawned.json().result;
  // On the host where the home lives: the status row carries the thread id alone; inspect, the
  // spawn's answer and a start's carry the endpoint.
  const local = { status: fx.cli(["status", "--json"]), inspect: fx.cli(["session", "inspect", "--home", home, "--json"]) };
  assert.deepEqual(JSON.parse(local.status.stdout).agents.flatMap((a) => a.instances).find((r) => r.instance === "far").session, rowSessionOf("far", 1));
  assert.deepEqual(local.inspect.json().result.session, { provider: FAKE_CAPABILITY, endpoint: endpointOf("far", 1) });
  assert.deepEqual(spawned.json().result.session, { provider: FAKE_CAPABILITY, endpoint: endpointOf("far", 1) });
  operatorStop(fx, "far");
  local.start = fx.cli(["session", "start", "--home", home, "--json"]);
  assert.deepEqual(local.start.json().result.session, { provider: FAKE_CAPABILITY, endpoint: endpointOf("far", 2) });
  local.status = fx.cli(["status", "--json"]);

  // Every answer a host gives is decoded by the one reader a routed command uses (--server): what it
  // hands on has the capability and nothing of the locator.
  for (const [what, answer] of [["spawn", spawned], ["session inspect", local.inspect], ["session start", local.start]]) {
    const relayed = parseRemoteEnvelope(answer.stdout);
    assert.deepEqual(relayed.result.session, { provider: FAKE_CAPABILITY }, what);
    // (`open` is the provider's own link, relayed as it gives it: here the fake's names its thread.)
    assert.equal(JSON.stringify({ ...relayed.result, open: null }).includes("thr_far"), false, `${what}: no thread id anywhere else in the relayed answer`);
    assert.equal(relayed.result.backend, "fake", what);
  }
  const relayedStatus = parseRemoteEnvelope(local.status.stdout);
  assert.deepEqual(relayedStatus.result.agents.flatMap((a) => a.instances).find((r) => r.instance === "far").session, { provider: FAKE_CAPABILITY });
  const relayedRows = relayedStatus.result.agents.flatMap((a) => a.instances);
  assert.equal(JSON.stringify(relayedRows.map((r) => ({ ...r, open: null }))).includes("thr_far"), false, "status --server: no thread id in any row");
  assert.deepEqual(relayedRows.find((r) => r.instance === "far").open, { label: "Open in fake", url: `${FAKE_SERVER}/thread/thr_far_2` }, "`open` is relayed: a link a viewer may open");

  // `oats server roster`: the host's own rows, relayed in the kernel's shapes only.
  const saved = process.env.OATS_HOME_DIR;
  // Short (`<base>/h`): it holds ssh's control socket, whose path ssh needs within 86 bytes, also
  // under CI's per-file TMPDIR; a longer one makes the route warn that it runs without reuse.
  process.env.OATS_HOME_DIR = join(fx.base, "h");
  t.after(() => { if (saved === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = saved; });
  writeServers({ build: { sshHost: "build-host", workspace: fx.dep } });
  const roster = await rosterGroups({ server: "build", io: { execFileAsync: async () => local.status.stdout, serverId: `build-${Date.now()}` } });
  const row = roster.groups[0].instances.find((r) => r.instance === "far");
  assert.deepEqual([row.backend, row.session, row.open, row.runtimeState, row.running, Object.hasOwn(row, "tmux")], ["fake", { provider: FAKE_CAPABILITY }, { label: "Open in fake", url: `${FAKE_SERVER}/thread/thr_far_2` }, "unknown", true, false]);
  assert.equal(JSON.stringify({ ...row, open: null }).includes("thr_far"), false, "no thread id outside the open link the provider offers");
  // A host that sends an endpoint or a thread id on a row anyway is not relayed either.
  const leaky = JSON.stringify({ root: join(fx.dep, "agents"), agents: [{ name: "dev", instances: [{ instance: "leak", home: "/srv/leak", backend: "fake", running: null, runtimeState: "unknown", session: { provider: FAKE_CAPABILITY, threadId: "thr_secret", endpoint: { threadId: "thr_secret", token: "t0ken" } } }] }] });
  const leaked = await rosterGroups({ server: "build", io: { execFileAsync: async () => leaky, serverId: `build-leak-${Date.now()}` } });
  assert.deepEqual(leaked.groups[0].instances.find((r) => r.instance === "leak").session, { provider: FAKE_CAPABILITY });
  assert.equal(/thr_secret|t0ken/.test(JSON.stringify(leaked)), false);
});

// ------------------------------------------------------------------- readiness, before a launch

test("a provider's check is asked right before every launch: a provider that is not ready is E_BACKEND_NOT_READY, and nothing is launched or stopped", async (t) => {
  const fx = providerDeployment(t, { manifest: fakeManifest({ fake: fakeProvider({ check: true }) }) });
  // Ready: the check, then the launch.
  const { home } = await fx.launch("checked");
  assert.deepEqual(fx.calls().map((c) => c.hook ?? c.verb), ["spawn", "check", "launch"]);
  assert.deepEqual(fx.verbs("check")[0].request.input, { home, soul: null, settings: {} });

  // Not ready at a spawn: refused with the provider's words, rolled back, no launch.
  fx.clearCalls();
  fx.control({ check: { result: { status: "unavailable", problems: [{ code: "claude-code-unauthenticated", message: "bb's claude-code provider is unauthenticated" }], warnings: [] } } });
  const refused = fx.cli(["spawn", "dev", "--name", "unready", "--backend", "fake", "--launch-config", "claude", "--json"]).json();
  assert.deepEqual([refused.ok, refused.error.code, refused.error.details], [false, "E_BACKEND_NOT_READY", { backend: "fake", capability: FAKE_CAPABILITY }]);
  assert.match(refused.error.message, /acme\.fake's session provider fake is not ready \(unavailable\): claude-code-unauthenticated: bb's claude-code provider is unauthenticated/);
  assert.deepEqual(fx.verbs().map((c) => c.verb), ["check"], "no launch was sent");
  assert.equal(existsSync(join(fx.root, "dev", "instances", "unready")), false);
  // The provider's own E_BACKEND_* problem code is the refusal's.
  fx.control({ check: { result: { status: "needs-configuration", problems: [{ code: "E_BACKEND_VERSION", message: "bb 0.49.0 is not the pinned 0.50.1" }] } } });
  assert.equal(fx.cli(["spawn", "dev", "--name", "unready", "--backend", "fake", "--launch-config", "claude", "--json"]).json().error.code, "E_BACKEND_VERSION");
  // A check that fails or answers outside its words is not "ready".
  for (const control of [{ check: { exit: 1 } }, { check: { result: { status: "fine", problems: [] } } }, { check: { result: { status: "ready", problems: [{ code: "x", message: "y" }] } } }]) {
    fx.control(control);
    assert.equal(fx.cli(["spawn", "dev", "--name", "unready", "--backend", "fake", "--launch-config", "claude", "--json"]).json().error.code, "E_BACKEND_NOT_READY", JSON.stringify(control));
  }
  // At a restart: before anything is stopped.
  fx.control({ check: { result: { status: "unavailable", problems: [{ code: "server-down", message: "the bb server does not answer" }] } } });
  fx.clearCalls();
  await assert.rejects(fx.inEnv(() => restartInstanceSession(home, {})), (e) => e.code === "E_BACKEND_NOT_READY" && /nothing was stopped or started/.test(e.message));
  assert.deepEqual(fx.verbs().map((c) => c.verb), ["inspect", "check"], "the session still runs: no stop, no launch");
  assert.equal(runtimeOf(home).stoppedAt, null);

  // `oats readiness` relays the same answer as a providers item: for the home, required.
  const readiness = fx.cli(["readiness", "--home", home, "--json"]).json();
  const item = readiness.result.checks.providers.items.find((i) => i.subject === "acme.fake session backend fake");
  assert.deepEqual([item.status, item.required, item.producer, item.result, item.reason], ["unknown", true, "session provider check", { status: "unavailable", problems: [{ code: "server-down", message: "the bb server does not answer" }], warnings: [] }, "the bb server does not answer"]);
  assert.equal(readiness.result.summary.ready, false);
  fx.control({ check: { result: { status: "ready", problems: [], warnings: [{ code: "sandbox", message: "added: aweb.ai" }] } } });
  const ready = fx.cli(["readiness", "--home", home, "--json"]).json().result.checks.providers.items.find((i) => i.subject === "acme.fake session backend fake");
  assert.deepEqual([ready.status, ready.result.warnings], ["pass", [{ code: "sandbox", message: "added: aweb.ai" }]]);
  // A tmux home of the same soul is not asked about a backend it does not run on.
  const tmuxHome = (await fx.spawn("dev", { name: "on-tmux" })).home;
  fx.clearCalls();
  assert.equal(fx.cli(["readiness", "--home", tmuxHome, "--json"]).json().result.checks.providers.items.some((i) => i.producer === "session provider check"), false);
  assert.deepEqual(fx.verbs("check"), []);
});

// --------------------------------------------------------------------- requires rows, by backend

test("a requires row applies to the backends it names: without `backends`, to every backend, a provider's launch included", (t) => {
  const row = (backends) => ({ harness: "claude", package: "needed@acme-market", why: "the fixture's package", ...(backends ? { backends } : {}) });
  const pkg = (backends) => ({ manifest: { requires: [row(backends)] }, files: {} });
  const fx = providerDeployment(t, {
    capabilities: { "acme.any": pkg(), "acme.tmux": pkg(["tmux"]), "acme.provided": pkg(["session-provider"]), "acme.both": pkg(["tmux", "session-provider"]), "acme.bad": pkg(["bb"]) },
    souls: Object.fromEntries(["any", "tmux", "provided", "both", "bad"].map((name) => [`needs-${name}`, { soul: { capabilities: { [FAKE_CAPABILITY]: { from: "here" }, [`acme.${name}`]: { from: "here" } } } }])),
  });
  // The fixture's claude lists no package, so a row that is probed refuses the launch.
  const preview = (soul, ...backend) => fx.cli(["spawn", soul, ...backend, "--launch-config", "claude", "--preview", "--json"]).json();
  const probed = (answer) => (answer.ok ? false : answer.error.code === "E_HARNESS_RESOURCE_MISSING" ? true : assert.fail(JSON.stringify(answer.error)));
  const onProvider = ["--backend", "fake"];
  assert.deepEqual([probed(preview("needs-any")), probed(preview("needs-any", ...onProvider))], [true, true], "an unconditioned row: every backend");
  assert.deepEqual([probed(preview("needs-tmux")), probed(preview("needs-tmux", ...onProvider))], [true, false], '["tmux"]: never a provider launch');
  assert.deepEqual([probed(preview("needs-provided")), probed(preview("needs-provided", ...onProvider))], [false, true], '["session-provider"]: any provider, never tmux');
  assert.deepEqual([probed(preview("needs-both")), probed(preview("needs-both", ...onProvider))], [true, true]);
  // A provider's name is no backends word: the row is refused where it is used, never skipped.
  for (const backend of [[], onProvider]) {
    const bad = preview("needs-bad", ...backend);
    assert.equal(bad.ok, false);
    assert.match(bad.error.message, /acme\.bad: a requirement's `backends` must be a list of tmux and session-provider/);
  }
  assert.deepEqual(fx.verbs(), [], "nothing was launched");
});

test("a requires row with `backends` and `when` applies only where both hold, also for the gate on a configuration's arguments", async (t) => {
  // The probe cannot carry a launch configuration's arguments, so a launch with arguments is
  // refused (E_LAUNCH_PROBE_UNSUPPORTED) when a requirement applies to it, and only then.
  const { applicableRequirements } = await import("../lib/core.mjs");
  const row = (backends) => ({ harness: "claude", package: "needed@acme-market", why: "the fixture's package", backends, when: { delivery: "channel" } });
  const pkg = (backends) => ({ manifest: { settings: { delivery: { description: "how mail arrives", default: "channel", values: ["channel", "session"] } }, requires: [row(backends)] }, files: {} });
  const fx = providerDeployment(t, {
    capabilities: { "acme.tmux": pkg(["tmux"]), "acme.provided": pkg(["session-provider"]) },
    souls: Object.fromEntries(["tmux", "provided"].map((name) => [`needs-${name}`, { soul: { capabilities: { [FAKE_CAPABILITY]: { from: "here" }, [`acme.${name}`]: { from: "here" } } } }])),
    local: { "launch-configs": { claude: { harness: "claude" }, "with-args": { harness: "claude", args: ["--permission-mode", "auto"] } } },
  });
  const cap = (backends, delivery) => ({ id: "x", settings: { delivery }, manifest: { requires: [row(backends)] } });
  assert.deepEqual(applicableRequirements("claude", [cap(["tmux"], "channel")], "tmux"), [{ capability: "x", package: "needed@acme-market" }]);
  assert.deepEqual(applicableRequirements("claude", [cap(["tmux"], "channel")], "fake"), [], "its `when` holds, and it is still not a provider launch's");
  assert.deepEqual(applicableRequirements("claude", [cap(["session-provider"], "channel")], "tmux"), [], "nor is a provider's row a tmux launch's");
  assert.deepEqual(applicableRequirements("claude", [cap(["session-provider"], "channel")], "fake"), [{ capability: "x", package: "needed@acme-market" }]);
  assert.deepEqual(applicableRequirements("claude", [cap(["tmux"], "session")], "tmux"), [], "a `when` that does not hold");
  // A `when` that is no object applies, as before the contract: the probe is what refuses it.
  for (const when of [null, false, "", 0, "channel", ["channel"]]) {
    const malformed = [{ id: "x", manifest: { requires: [{ harness: "claude", package: "needed@acme-market", when }] }, settings: {} }];
    assert.deepEqual(applicableRequirements("claude", malformed, "tmux"), [{ capability: "x", package: "needed@acme-market" }], JSON.stringify(when));
  }
  const preview = (soul, config, ...backend) => { const a = fx.cli(["spawn", soul, ...backend, "--launch-config", config, "--preview", "--json"]).json(); return a.ok ? "ok" : a.error.code; };
  const onProvider = ["--backend", "fake"];
  // With arguments: refused only where the row is a requirement of that backend.
  assert.deepEqual([preview("needs-tmux", "with-args"), preview("needs-tmux", "with-args", ...onProvider)], ["E_LAUNCH_PROBE_UNSUPPORTED", "ok"]);
  assert.deepEqual([preview("needs-provided", "with-args"), preview("needs-provided", "with-args", ...onProvider)], ["ok", "E_LAUNCH_PROBE_UNSUPPORTED"]);
  // Without: probed there, and nowhere else.
  assert.deepEqual([preview("needs-tmux", "claude"), preview("needs-tmux", "claude", ...onProvider)], ["E_HARNESS_RESOURCE_MISSING", "ok"]);
  assert.deepEqual([preview("needs-provided", "claude"), preview("needs-provided", "claude", ...onProvider)], ["ok", "E_HARNESS_RESOURCE_MISSING"]);
  // A provider launch with a configuration's arguments carries them to the provider.
  await fx.launch("argued", { launchConfig: "with-args" });
  assert.deepEqual(fx.verbs("launch")[0].request.input.args, ["--permission-mode", "auto"]);
});

test("E_BACKEND_AMBIGUOUS at a start: a home whose modules now hold two capabilities declaring its backend's name", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("doubled");
  await fx.inEnv(() => stopInstanceSession(home, {}));
  // A second module that declares `fake`, as an upgrade could bring.
  cpSync(join(home, ".oats", "modules", FAKE_CAPABILITY), join(home, ".oats", "modules", "acme.twin"), { recursive: true });
  const twin = readJson(join(home, ".oats", "modules", "acme.twin", "oats.json"));
  writeFileSync(join(home, ".oats", "modules", "acme.twin", "oats.json"), JSON.stringify({ ...twin, capability: "acme.twin", hooks: undefined, environment: undefined }));
  const record = recordOf(home);
  writeFileSync(join(home, "instance.json"), JSON.stringify({ ...record, modules: { ...record.modules, "acme.twin": record.modules[FAKE_CAPABILITY] } }, null, 2) + "\n");
  fx.clearCalls();
  for (const start of [() => startInstanceSession(home, {}), () => restartInstanceSession(home, {})]) {
    await assert.rejects(fx.inEnv(start), (e) => e.code === "E_BACKEND_AMBIGUOUS" && JSON.stringify(e.details) === JSON.stringify({ backend: "fake", capabilities: [FAKE_CAPABILITY, "acme.twin"] }) && /nothing was stopped or started/.test(e.message));
  }
  assert.deepEqual(fx.verbs(), [], "nothing was launched");
});
