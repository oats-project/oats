// Feature provider-outside-oats (the bb contract's A15(2)): OATS sees a harness that runs in a
// provider home it recorded stopped. A message a person types in the provider's own product can
// start a stopped session's harness again, behind OATS's back; the home's status row then says so
// (`outsideOats: { code, backend, message }`), and that key is the only effect: the row's other
// fields, the home's records, and what OATS refuses or resumes stay what OATS recorded.
// Every home here is a real spawn through the kernel, on the fake provider
// (test/helpers/session-provider-fixture.mjs). The upgrade's refusal is in
// test/provider-home-integrity.test.mjs, beside the other upgrades of a provider home.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listInstances } from "../lib/core.mjs";
import { KERNEL_FEATURES } from "../lib/kernel-features.mjs";
import { rosterGroups, writeServers } from "../lib/servers.mjs";
import { SESSION_PROVIDER_WIRE, readOutsideOats } from "../lib/session-providers.mjs";
import { FAKE_CAPABILITY, LOST, fakeManifest, fakeProvider, providerDeployment, sessionsOf } from "./helpers/session-provider-fixture.mjs";

const FEATURE = "provider-outside-oats";
const HOST_STOP_CHILD = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "host-stop-child.mjs");
/** The stop `oats host run` gives a home when the host stops: its own child, as the run starts it. */
function hostStop(fx, home) {
  const r = spawnSync(process.execPath, [HOST_STOP_CHILD, home, "20000"], { cwd: fx.dep, env: fx.env, encoding: "utf8" });
  const answer = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.deepEqual([answer.ok, answer.stopped], [true, true], r.stdout);
}
const LIVE = Object.freeze({ present: true, state: "unknown", running: true });
const receiptOf = (home) => join(dirname(home), ".oats-retirement", "baselines", `${createHash("sha256").update(home).digest("hex")}.json`);
const runtimeOf = (home) => JSON.parse(readFileSync(receiptOf(home), "utf8")).runtime;
const statusOf = (fx, env) => JSON.parse(fx.cli(["status", "--json"], env ? { env } : undefined).stdout);
const rowsOf = (fx, env) => statusOf(fx, env).agents.flatMap((agent) => agent.instances);
const rowOf = (fx, name, env) => rowsOf(fx, env).find((row) => row.instance === name);
/** `oats instance stop <name>`: the plan, then its apply, as an operator runs it. */
function operatorStop(fx, name) {
  const plan = fx.cli(["instance", "stop", name, "--plan", "--json"]).json();
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const applied = fx.cli(["instance", "stop", name, "--apply", "--plan-revision", plan.result.planRevision, "--idempotency-key", `stop-${name}-${Date.now()}`, "--json"]).json();
  assert.equal(applied.ok, true, JSON.stringify(applied));
}
/** What the key says of `name`. */
const outsideOf = (name) => ({ code: "running-outside-oats", backend: "fake", message: `a harness runs in ${name} on fake, and OATS recorded this instance stopped: stop it with \`oats instance stop ${name}\`, or start it from OATS` });
/** What OATS recorded of a row, whatever its provider answers. */
const recordedOf = (row) => [row.running, row.runtimeState, row.sessionEnd, row.waitingOnYou, row.open, row.runtimeError ?? null];
const STOPPED = [false, "stopped", "stopped", null, null, null];
/** Every file the kernel keeps of a home's stop and of its resumes, by its bytes: the receipt, the
 *  home's record and its stop receipt, and the resume counts of the whole fixture. */
function recordsOf(fx, home) {
  const bytes = (path) => (existsSync(path) ? readFileSync(path).toString("base64") : null);
  const counts = join(fx.env.OATS_HOME_DIR || join(fx.env.HOME, ".oats"), "session-resume", "provider-resumes");
  return {
    receipt: bytes(receiptOf(home)), record: bytes(join(home, "instance.json")), stop: bytes(join(home, ".oats-stop.json")),
    resumes: existsSync(counts) ? readdirSync(counts).sort().map((name) => [name, bytes(join(counts, name))]) : [],
  };
}
/** A stateful fake with a home OATS stopped whose harness runs again (a message in the provider's
 *  own product restarted its thread), and one that stays stopped. */
async function strayed(t) {
  const fx = providerDeployment(t);
  fx.control({ stateful: true });
  const stray = await fx.launch("stray"), tame = await fx.launch("tame");
  operatorStop(fx, "stray");
  operatorStop(fx, "tame");
  const thread = runtimeOf(stray.home).endpoint.threadId;
  assert.equal(sessionsOf(fx.events()).get(thread).running, false, "OATS's stop stopped it");
  fx.emit({ ev: "input", thread });
  assert.equal(sessionsOf(fx.events()).get(thread).running, true, "and a message outside OATS started it again");
  return { fx, stray: stray.home, tame: tame.home, thread };
}

test("a stopped home whose provider answers a live harness carries outsideOats, and nothing else of it changes: its records are byte-unchanged, its input is refused and no resume is counted or made", async (t) => {
  const { fx, stray, tame } = await strayed(t);
  const before = recordsOf(fx, stray);
  fx.clearCalls();
  const status = statusOf(fx);
  assert.equal(status.features.includes(FEATURE), true);
  assert.equal(KERNEL_FEATURES.includes(FEATURE), true);
  assert.equal(JSON.parse(fx.cli(["version", "--json"]).stdout).features.includes(FEATURE), true);
  const rows = status.agents.flatMap((agent) => agent.instances);
  const row = rows.find((r) => r.instance === "stray");
  assert.deepEqual(row.outsideOats, outsideOf("stray"));
  // The rest of the row is what OATS recorded: stopped, by an operator, with no link and no claim.
  assert.deepEqual(recordedOf(row), STOPPED);
  // The home that stays stopped has no key (never null, never false), in the same single call.
  const other = rows.find((r) => r.instance === "tame");
  assert.deepEqual([recordedOf(other), Object.hasOwn(other, "outsideOats")], [STOPPED, false]);
  assert.deepEqual(fx.verbs().map((c) => [c.verb, c.request.input.homes.map((h) => h.instance)]), [["inspectMany", ["stray", "tame"]]]);
  assert.deepEqual(status.problems ?? [], [], "no problem is added for it");
  // Text status says it on a line under the row, and of that row only.
  assert.deepEqual(fx.cli(["status"]).stdout.split("\n").filter((line) => line.trim().startsWith("!")).map((line) => line.trim()), [`! ${outsideOf("stray").message}`]);
  // Nothing was written by the read: the receipt (its `stoppedAt`), the record, the stop receipt
  // and the resume counts are the bytes they were.
  assert.deepEqual(recordsOf(fx, stray), before);
  assert.equal(Number.isFinite(Date.parse(runtimeOf(stray).stoppedAt)), true);

  // OATS still refuses it an input, without calling the provider, and the sweep leaves it down.
  fx.clearCalls();
  const text = join(fx.base, "input.txt");
  writeFileSync(text, "are you there?\n");
  const input = fx.cli(["session", "input", "--home", stray, "--text-file", text, "--json"]).json();
  assert.deepEqual([input.ok, input.error.code], [false, "E_SESSION_NOT_RUNNING"]);
  const inspected = fx.cli(["session", "inspect", "--home", stray, "--json"]).json().result;
  assert.deepEqual([inspected.present, inspected.state, inspected.running, Object.hasOwn(inspected, "outsideOats")], [false, "stopped", false, false], "inspect answers what OATS recorded");
  for (const flags of [["--plan"], []]) {
    const swept = fx.cli(["session", "resume", "--deployment", fx.dep, ...flags, "--json"]).json();
    assert.deepEqual([swept.ok, swept.result.rows], [true, []], "an operator's stop has no row: it is never resumed");
  }
  assert.deepEqual(fx.verbs(), [], "no provider was called: the sweep and the input read the home's records alone");
  assert.deepEqual(recordsOf(fx, stray), before);
  // In process, a listing that is not the status read asks no provider about a stopped home.
  const listed = (await fx.inEnv(() => listInstances(fx.root))).flatMap((a) => a.instances);
  assert.deepEqual([listed.map((r) => Object.hasOwn(r, "outsideOats")), fx.verbs()], [[false, false], []]);
  const reported = (await fx.inEnv(() => listInstances(fx.root, undefined, undefined, { reportOutsideOats: true }))).flatMap((a) => a.instances);
  assert.deepEqual(reported.map((r) => r.outsideOats ?? null), [outsideOf("stray"), null]);

  // The remedy the message names: an operator's stop asks the provider again, and the key goes.
  operatorStop(fx, "stray");
  assert.equal(Object.hasOwn(rowOf(fx, "stray"), "outsideOats"), false);
  // The key is only ever what the listing read from the provider: one written into a home's own
  // record, which its agent can write, is not on the row.
  const record = join(tame, "instance.json");
  writeFileSync(record, JSON.stringify({ ...JSON.parse(readFileSync(record, "utf8")), outsideOats: outsideOf("tame") }, null, 2));
  assert.equal(Object.hasOwn(rowOf(fx, "tame"), "outsideOats"), false);
});

test("the key is for a live harness only: a session the provider reads gone, stopped at its shell, or refuses, has none; one it cannot tell idle from settled has it", async (t) => {
  const fx = providerDeployment(t);
  for (const name of ["gone", "shell", "idle", "turn", "refused", "malformed"]) { await fx.launch(name); operatorStop(fx, name); }
  fx.control({
    gone: { inspect: { result: LOST } }, shell: { inspect: { result: { present: true, state: "shell", running: false } } },
    idle: { inspect: { result: { present: true, state: "unknown", running: null } } }, turn: { inspect: { result: LIVE } },
    refused: { inspect: { error: { code: "E_BACKEND_NOT_READY", message: "two live threads" } } }, malformed: { inspect: { result: { present: "yes" } } },
  });
  fx.clearCalls();
  const rows = rowsOf(fx);
  assert.deepEqual(rows.map((r) => [r.instance, r.outsideOats?.code ?? null]), [["gone", null], ["idle", "running-outside-oats"], ["malformed", null], ["refused", null], ["shell", null], ["turn", "running-outside-oats"]]);
  for (const row of rows) assert.deepEqual(recordedOf(row), STOPPED, row.instance);
  // One call for all six: an entry that is refused or is no answer is not asked again on its own.
  assert.deepEqual(fx.verbs().map((c) => c.verb), ["inspectMany"]);
  // The link the provider offers for a live harness is not put on the row either: `open` stays null.
  fx.control({ turn: { inspect: { result: { ...LIVE, open: { label: "Open in fake", url: "http://127.0.0.1:9/thread/x" } } } } });
  const turn = rowOf(fx, "turn");
  assert.deepEqual([turn.outsideOats, turn.open], [outsideOf("turn"), null]);
});

test("a provider that times out, fails or answers a bad batch leaves its stopped homes plain stopped: no key, never unreachable, and no call beyond the one batch", async (t) => {
  const fx = providerDeployment(t);
  for (const name of ["down-a", "down-b"]) { await fx.launch(name); operatorStop(fx, name); }
  const live = { "down-a": { inspect: { result: LIVE } }, "down-b": { inspect: { result: LIVE } } };
  fx.control(live);
  assert.deepEqual(rowsOf(fx).map((r) => r.outsideOats?.code ?? null), ["running-outside-oats", "running-outside-oats"], "the harnesses run, as the provider answers when it does");
  const plain = (rows) => rows.map((r) => [r.instance, ...recordedOf(r), Object.hasOwn(r, "outsideOats")]);
  const expected = ["down-a", "down-b"].map((name) => [name, ...STOPPED, false]);
  // No home of the provider runs: exactly one batch call, for its stopped homes, under the verb's own timeout.
  fx.control({ ...live, inspectMany: { sleepMs: 60_000 }, inspect: { sleepMs: 60_000 } });
  fx.clearCalls();
  const began = Date.now();
  assert.deepEqual(plain(rowsOf(fx, { OATS_TEST_SESSION_PROVIDER_TIMEOUT_MS: "400" })), expected, "a timeout");
  assert.ok(Date.now() - began < 20_000, "it waited the one call's timeout, not one per home");
  assert.deepEqual(fx.verbs().map((c) => c.verb), ["inspectMany"]);
  for (const bad of [{ exit: 1 }, { raw: "not json" }, { result: { results: [] } }, { error: { code: "E_BACKEND_NOT_READY", message: "down" } }, { result: { results: [{ error: { code: "E_BACKEND_NOT_READY", message: "down" } }, { present: "yes" }] } }]) {
    fx.control({ ...live, inspectMany: bad });
    fx.clearCalls();
    assert.deepEqual(plain(rowsOf(fx)), expected, JSON.stringify(bad));
    assert.deepEqual(fx.verbs().map((c) => c.verb), ["inspectMany"], `${JSON.stringify(bad)}: a stopped home is never asked on its own`);
  }

  // Beside a home that runs: the stopped homes ride in ITS call. A batch that times out leaves the
  // running home unknown, as before, and the stopped ones stopped; a bad batch asks the running
  // home alone on its own.
  await fx.launch("up");
  fx.control(live);
  fx.clearCalls();
  assert.deepEqual(rowsOf(fx).map((r) => [r.instance, r.running, r.outsideOats?.code ?? null]), [["down-a", false, "running-outside-oats"], ["down-b", false, "running-outside-oats"], ["up", true, null]]);
  assert.deepEqual(fx.verbs().map((c) => [c.verb, c.request.input.homes.map((h) => h.instance)]), [["inspectMany", ["up", "down-a", "down-b"]]], "one call: the running home first, then the stopped ones");
  fx.control({ ...live, inspectMany: { sleepMs: 60_000 }, inspect: { sleepMs: 60_000 } });
  fx.clearCalls();
  const slow = rowsOf(fx, { OATS_TEST_SESSION_PROVIDER_TIMEOUT_MS: "400" });
  assert.deepEqual(plain(slow.slice(0, 2)), expected);
  assert.deepEqual([slow[2].instance, slow[2].running, slow[2].runtimeState], ["up", null, "unreachable"]);
  assert.deepEqual(fx.verbs().map((c) => c.verb), ["inspectMany"]);
  fx.control({ ...live, inspectMany: { exit: 1 } });
  fx.clearCalls();
  const failed = rowsOf(fx);
  assert.deepEqual(plain(failed.slice(0, 2)), expected);
  assert.deepEqual([failed[2].running, failed[2].runtimeState], [true, "unknown"]);
  assert.deepEqual(fx.verbs().map((c) => [c.verb, c.instance]), [["inspectMany", "up"], ["inspect", "up"]]);
});

test("the read is the batch's alone: a provider without inspectMany is not asked about a stopped home, and a listing that asks no provider asks none", async (t) => {
  const fx = providerDeployment(t, { manifest: fakeManifest({ fake: fakeProvider({ inspectMany: false }) }) });
  await fx.launch("solo-up");
  await fx.launch("solo-down");
  operatorStop(fx, "solo-down");
  fx.control({ "solo-down": { inspect: { result: LIVE } } });
  fx.clearCalls();
  const rows = rowsOf(fx);
  assert.deepEqual(rows.map((r) => [r.instance, r.running, Object.hasOwn(r, "outsideOats")]), [["solo-down", false, false], ["solo-up", true, false]]);
  assert.deepEqual(fx.verbs().map((c) => [c.verb, c.instance]), [["inspect", "solo-up"]], "one inspect, for the home that runs");

  const batched = providerDeployment(t);
  await batched.launch("batch-down");
  operatorStop(batched, "batch-down");
  batched.control({ "batch-down": { inspect: { result: LIVE } } });
  batched.clearCalls();
  const plan = batched.cli(["session", "resume", "--deployment", batched.dep, "--plan", "--without-provider-inspect", "--json"]).json();
  assert.deepEqual([plan.ok, batched.verbs()], [true, []]);
});

test("a remote roster relays outsideOats only in its exact shape, on a stopped provider row of its backend, from a host that lists the feature", async (t) => {
  const { fx } = await strayed(t);
  const local = fx.cli(["status", "--json"]).stdout;
  const saved = process.env.OATS_HOME_DIR;
  // Short (`<base>/h`): it holds ssh's control socket, whose path ssh needs within 86 bytes.
  process.env.OATS_HOME_DIR = join(fx.base, "h");
  t.after(() => { if (saved === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = saved; });
  writeServers({ build: { sshHost: "build-host", workspace: fx.dep } });
  let n = 0;
  const relayed = async (stdout) => (await rosterGroups({ server: "build", io: { execFileAsync: async () => stdout, serverId: `build-${Date.now()}-${n++}` } })).groups[0].instances;
  // The host's own answer: the key as the host gave it; the home that stays stopped has none.
  const rows = await relayed(local);
  assert.deepEqual(rows.map((r) => [r.instance, r.outsideOats ?? null, r.running, r.runtimeState, r.sessionEnd]), [["stray", outsideOf("stray"), false, "stopped", "stopped"], ["tame", null, false, "stopped", "stopped"]]);
  assert.equal(Object.hasOwn(rows[1], "outsideOats"), false);

  const host = (outsideOats, { features = [FEATURE], row = {} } = {}) => JSON.stringify({
    root: join(fx.dep, "agents"), features,
    agents: [{ name: "dev", instances: [{ instance: "far", home: "/srv/far", backend: "fake", running: false, runtimeState: "stopped", sessionEnd: "stopped", session: { provider: FAKE_CAPABILITY }, tmux: null, open: null, outsideOats, ...row }] }],
  });
  const far = async (...args) => (await relayed(host(...args))).find((r) => r.instance === "far");
  const good = outsideOf("far");
  assert.deepEqual((await far(good)).outsideOats, good);
  // Anything but the exact shape drops the key, and the row is otherwise relayed as it was.
  const refused = [
    { ...good, extra: 1 }, { code: good.code, backend: good.backend }, { ...good, code: "running" }, { ...good, backend: "tmux" }, { ...good, backend: "Fake" },
    { ...good, message: "" }, { ...good, message: "two\nlines" }, { ...good, message: "x".repeat(501) }, { ...good, message: 7 }, null, true, "running-outside-oats", [good],
  ];
  for (const value of refused) {
    const row = await far(value);
    assert.deepEqual([Object.hasOwn(row, "outsideOats"), row.running, row.runtimeState, row.backend], [false, false, "stopped", "fake"], JSON.stringify(value));
    assert.equal(readOutsideOats(value), undefined, JSON.stringify(value));
  }
  // The key is for a stopped provider row of the backend it names: never a running or an unknown
  // row, another backend's, or a tmux home's.
  for (const row of [{ running: true, runtimeState: "unknown" }, { running: null, runtimeState: "unreachable" }, { backend: "other" }, { backend: "tmux", session: undefined, tmux: { session: "oats", window: "far" } }]) {
    assert.equal(Object.hasOwn(await far(good, { row }), "outsideOats"), false, JSON.stringify(row));
  }
  // A host that does not list the feature says nothing by it: nothing is added to its row.
  for (const features of [[], ["session-providers"], null, "provider-outside-oats"]) assert.equal(Object.hasOwn(await far(good, { features }), "outsideOats"), false, JSON.stringify(features));
});

test("oats retire of a stopped home whose harness runs stops it first, by its endpoint, then removes the home", async (t) => {
  const { fx, stray, thread } = await strayed(t);
  fx.clearCalls();
  const retired = JSON.parse(fx.cli(["retire", "stray", "--json"]).stdout);
  assert.deepEqual([retired.retired, retired.removedDir], ["stray", true], JSON.stringify(retired).slice(0, 400));
  assert.deepEqual(fx.verbs("stop").map((c) => c.request.input.endpoint.threadId), [thread]);
  assert.equal(sessionsOf(fx.events()).get(thread).running, false, "the harness that ran outside OATS was stopped");
  assert.equal(existsSync(stray), false);
});

// ------------------------------------------------------------ a home stopped with the host (A16)
// `oats host run`'s shutdown stops a home that OATS means to run again: the sweep resumes it through
// an input to that same session. So the provider is told which stop it is, and a harness that runs
// in such a home again is no harness outside OATS.

test("the host shutdown's stop tells the provider reason: host; an operator's stop, a retire's and a second stop carry no reason", async (t) => {
  const fx = providerDeployment(t);
  const hosted = await fx.launch("hosted"), operated = await fx.launch("operated"), leaving = await fx.launch("leaving");
  fx.clearCalls();
  hostStop(fx, hosted.home);
  operatorStop(fx, "operated");
  // An operator's stop of the home the host stopped takes it as its own: it asks again, with no reason.
  operatorStop(fx, "hosted");
  JSON.parse(fx.cli(["retire", "leaving", "--json"]).stdout);
  const endpoint = (name) => ({ server: "http://127.0.0.1:9", threadId: `thr_${name}_${{ hosted: 1, operated: 2, leaving: 3 }[name]}` });
  assert.deepEqual(fx.verbs("stop").map((c) => c.request.input), [
    { home: hosted.home, endpoint: endpoint("hosted"), graceSeconds: 20, reason: "host" },
    { home: operated.home, endpoint: endpoint("operated"), graceSeconds: 20 },
    { home: hosted.home, endpoint: endpoint("hosted"), graceSeconds: 20 },
    { home: leaving.home, endpoint: endpoint("leaving"), graceSeconds: 20 },
  ]);
  // The wire is the one it was (an optional key a provider only reads).
  assert.equal(SESSION_PROVIDER_WIRE, "1.3");
});

test("a home stopped with the host whose harness runs again is not outside OATS: it reads running with no key, the read writes nothing, and the sweep adopts it with no resume input and nothing counted", async (t) => {
  const fx = providerDeployment(t);
  fx.control({ stateful: true });
  const back = await fx.launch("back"), down = await fx.launch("down");
  hostStop(fx, back.home);
  hostStop(fx, down.home);
  const thread = runtimeOf(back.home).endpoint.threadId;
  // Both read lost, which the sweep resumes; then a person's message restarts one's harness.
  assert.deepEqual(rowsOf(fx).map((r) => [r.instance, r.running, r.runtimeState, r.sessionEnd]), [["back", false, "stopped", "lost"], ["down", false, "stopped", "lost"]]);
  fx.emit({ ev: "input", thread });
  const before = recordsOf(fx, back.home);
  assert.equal(JSON.parse(Buffer.from(before.stop, "base64").toString()).reason, "host-stop");

  fx.clearCalls();
  const [row, other] = rowsOf(fx);
  assert.deepEqual([row.instance, row.running, row.runtimeState, row.sessionEnd ?? null, Object.hasOwn(row, "outsideOats"), row.open?.label ?? null], ["back", true, "unknown", null, false, "Open in fake"]);
  assert.deepEqual([other.instance, other.running, other.runtimeState, other.sessionEnd, Object.hasOwn(other, "outsideOats")], ["down", false, "stopped", "lost", false]);
  assert.deepEqual(fx.verbs().map((c) => [c.verb, c.request.input.homes.map((h) => h.instance)]), [["inspectMany", ["back", "down"]]]);
  assert.deepEqual(recordsOf(fx, back.home), before, "the status read wrote nothing: the home is still recorded stopped with the host");
  // Every listing that asks providers reads it so, the sweep's own included.
  assert.deepEqual((await fx.inEnv(() => listInstances(fx.root))).flatMap((a) => a.instances).map((r) => [r.instance, r.running]), [["back", true], ["down", false]]);

  // A plan says what the sweep will answer, and changes nothing.
  const sweep = (...flags) => fx.cli(["session", "resume", "--deployment", fx.dep, ...flags, "--json"]).json();
  const planned = sweep("--plan");
  assert.deepEqual(planned.result.rows.map((r) => [r.instance, r.outcome, r.backend]), [["back", "already-running", "fake"], ["down", "resumed", "fake"]]);
  assert.deepEqual(recordsOf(fx, back.home), before);
  // The sweep adopts the one that runs: its stop is cleared and its stop receipt removed, with no
  // input sent into the running harness; the other is resumed by the notice, as before.
  fx.clearCalls();
  const swept = sweep();
  assert.deepEqual(swept.result.rows.map((r) => [r.instance, r.outcome, r.backend]), [["back", "already-running", "fake"], ["down", "resumed", "fake"]]);
  assert.deepEqual(fx.verbs("input").map((c) => c.instance), ["down"], "no resume notice went to the harness that already ran");
  assert.deepEqual([runtimeOf(back.home).stoppedAt, existsSync(join(back.home, ".oats-stop.json"))], [null, false]);
  assert.deepEqual(recordsOf(fx, back.home).resumes, before.resumes, "nothing was counted against a resume cap");
  assert.equal(fx.events().filter((e) => e.ev === "input" && e.thread === thread).length, 1, "the one input its session got is the person's");
  // It is an ordinary running home from here: its input is taken, and the next sweep finds it there.
  fx.clearCalls();
  assert.deepEqual(sweep().result.rows.map((r) => [r.instance, r.outcome]), [["back", "already-running"], ["down", "already-running"]]);
  assert.deepEqual(fx.verbs("input"), []);
  const text = join(fx.base, "input.txt");
  writeFileSync(text, "hello again\n");
  assert.equal(fx.cli(["session", "input", "--home", back.home, "--text-file", text, "--json"]).json().ok, true);
});

test("a resume by hand of a home stopped with the host whose harness runs adopts it too: E_SESSION_RUNNING, the stop cleared, nothing sent", async (t) => {
  const fx = providerDeployment(t);
  fx.control({ stateful: true });
  const { home } = await fx.launch("byhand");
  hostStop(fx, home);
  fx.emit({ ev: "input", thread: runtimeOf(home).endpoint.threadId });
  fx.clearCalls();
  const answer = fx.cli(["session", "start", "--resume", "--home", home, "--json"]).json();
  assert.deepEqual([answer.ok, answer.error.code], [false, "E_SESSION_RUNNING"]);
  assert.match(answer.error.message, /its harness runs again on fake after its stop with the host, so that stop was cleared and no resume notice was sent/);
  assert.deepEqual([fx.verbs().map((c) => c.verb), runtimeOf(home).stoppedAt, existsSync(join(home, ".oats-stop.json"))], [["inspect"], null, false]);
});
