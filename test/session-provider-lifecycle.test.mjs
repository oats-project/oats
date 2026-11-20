// The launch state machine of a provider home (docs/design/2026-11-20-provider-home-lifecycle.md),
// as tables. One test per cell of "The verbs, by state"; one per row of "An input in flight across
// a state change"; one per row of "The holder died". Each row says what the verb answers, which
// provider calls it made, in order, and the state the records are left in.
//
// A home's state is what its receipt says. The unsettled states (`sent`, `resent`) are built here
// by writing the receipt as the kernel's mark does, which is exact and fast; the kill points at the
// end build them the real way, by killing the command that was launching.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inputInstanceSession, inspectInstanceSession, restartInstanceSession, startInstanceSession, stopInstanceSession } from "../lib/core.mjs";
import { FAKE_CAPABILITY, FAKE_SERVER, LOST, fakeFiles, fakeManifest, fakeProvider, providerDeployment } from "./helpers/session-provider-fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "bin", "oats.mjs");
const HOST_STOP_CHILD = join(HERE, "..", "lib", "host-stop-child.mjs");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const receiptPath = (home) => join(dirname(home), ".oats-retirement", "baselines", `${createHash("sha256").update(home).digest("hex")}.json`);
const runtimeOf = (home) => readJson(receiptPath(home)).runtime;
const recordOf = (home) => readJson(join(home, "instance.json"));
const stopReceiptOf = (home) => (existsSync(join(home, ".oats-stop.json")) ? readJson(join(home, ".oats-stop.json")) : null);
const SENT_AT = "2026-11-20T10:00:00.000Z";
const E = (name, n) => ({ server: FAKE_SERVER, threadId: `thr_${name}_${n}` });

/** The state a home's records spell, by the page's names; `gone` once the home is removed. */
function stateOf(home) {
  if (!existsSync(home)) return "gone";
  const r = runtimeOf(home);
  if (r.launchSent !== undefined) return r.endpoint === undefined ? "sent" : "resent";
  if (r.launched !== true) return "planned";
  return r.stoppedAt === null ? "running" : "stopped";
}
/** Write the receipt's runtime (and, where given, the record) as a kernel step would have left them. */
function writeRuntime(home, runtime, record) {
  const receipt = readJson(receiptPath(home));
  writeFileSync(receiptPath(home), JSON.stringify({ ...receipt, runtime }, null, 2) + "\n", { mode: 0o600 });
  if (record) writeFileSync(join(home, "instance.json"), JSON.stringify({ ...recordOf(home), ...record }, null, 2) + "\n");
}
/** The provider's calls so far that matter to the machine, in order: `inspect`, `input`, `launch`,
 *  `stop:E` (the recorded endpoint), `stop:null` (whatever is rooted at the home, with launchSent). */
function callsOf(fx, home) {
  // Of this home only: a status reads every home of the deployment, the earlier rows' too.
  const about = (c) => home === undefined || (c.verb === "inspectMany" ? c.request.input.homes.some((h) => h.home === home) : c.request.input.home === home);
  return fx.verbs().filter(about).map((c) => {
    if (c.verb === "inspectMany") return "inspect";
    if (c.verb !== "stop") return c.verb;
    return c.request.input.endpoint === null ? `stop:null${c.request.input.launchSent ? "" : "(no launchSent)"}` : "stop:E";
  }).filter((verb) => verb !== "check");
}

/** Build a home of soul `dev` in `state`, on a fresh name → its path. The states of the page, with
 *  `lost` (running, and the provider says gone) and the two kinds of each of stopped and resent. */
const STATES = {
  planned: async (fx, name) => (await fx.spawn("dev", { name, backend: "fake", launchConfig: "claude" })).home,
  sent: async (fx, name) => {
    const home = await STATES.planned(fx, name);
    writeRuntime(home, { launched: true, backend: "fake", provider: FAKE_CAPABILITY, launchSent: SENT_AT }, { launched: true });
    return home;
  },
  running: async (fx, name) => (await fx.launch(name)).home,
  lost: async (fx, name) => { const home = await STATES.running(fx, name); fx.controls = { ...fx.controls, [name]: { inspect: { result: LOST } } }; fx.control(fx.controls); return home; },
  "stopped (operator)": async (fx, name) => { const home = await STATES.running(fx, name); await fx.inEnv(() => stopInstanceSession(home, {})); return home; },
  "stopped (host)": async (fx, name) => {
    const home = await STATES.running(fx, name);
    const r = spawnSync(process.execPath, [HOST_STOP_CHILD, home, "20000"], { cwd: fx.dep, env: fx.env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return home;
  },
  "resent (stopped)": async (fx, name) => { const home = await STATES["stopped (operator)"](fx, name); writeRuntime(home, { ...runtimeOf(home), launchSent: SENT_AT }); return home; },
  "resent (not stopped)": async (fx, name) => { const home = await STATES.running(fx, name); writeRuntime(home, { ...runtimeOf(home), launchSent: SENT_AT }); return home; },
};

/** Each verb, run on `home` → what it answered, in one word: a kernel code, or a word for its answer. */
const VERBS = {
  inspect: async (fx, home) => { const r = await fx.inEnv(() => inspectInstanceSession(home)); return r.state === "not-launched" ? "not-launched" : r.present ? "present" : "stopped"; },
  status: async (fx, home) => {
    const row = JSON.parse(fx.cli(["status", "--json"]).stdout).agents.flatMap((a) => a.instances).find((r) => r.home === home);
    return row.runtimeState === "unreachable" ? "unknown" : row.running === true ? "running" : row.sessionEnd === "lost" ? "lost" : "stopped";
  },
  input: async (fx, home) => { const r = await fx.inEnv(() => inputInstanceSession(home, "a mail")); return r.submitted ? "submitted" : "not-submitted"; },
  stop: async (fx, home) => { const r = await fx.inEnv(() => stopInstanceSession(home, {})); return r.stopped ? "stopped" : r.state === "not-launched" ? "nothing-to-stop" : "already-stopped"; },
  start: async (fx, home) => { await fx.inEnv(() => startInstanceSession(home, {})); return "launched"; },
  restart: async (fx, home) => { await fx.inEnv(() => restartInstanceSession(home, {})); return "launched"; },
  resume: async (fx, home) => { const r = await fx.inEnv(() => startInstanceSession(home, { resume: true })); return r.reused === "session" ? "resumed" : "launched"; },
  retire: async (fx, home) => { const r = fx.cli(["retire", home.split("/").pop(), "--json"]); const j = JSON.parse(r.stdout); if (j.ok === false) throw Object.assign(new Error(j.error.message), { code: j.error.code }); return "retired"; },
};
const answerOf = async (fx, verb, home) => { try { return await VERBS[verb](fx, home); } catch (e) { if (typeof e?.code !== "string") throw e; return e.code; } };

// ------------------------------------------------------------------------ the verbs, by state
// [answer, provider calls in order, state after]. A cell the page gives one word, three here.
const CELLS = {
  inspect: {
    planned: ["not-launched", [], "planned"], sent: ["E_SESSION_UNAVAILABLE", [], "sent"],
    running: ["present", ["inspect"], "running"], lost: ["stopped", ["inspect"], "running"],
    "stopped (operator)": ["stopped", [], "stopped"], "stopped (host)": ["stopped", [], "stopped"],
    "resent (stopped)": ["E_SESSION_UNAVAILABLE", [], "resent"], "resent (not stopped)": ["E_SESSION_UNAVAILABLE", [], "resent"],
  },
  status: {
    planned: ["stopped", [], "planned"], sent: ["unknown", [], "sent"],
    running: ["running", ["inspect"], "running"], lost: ["lost", ["inspect"], "running"],
    "stopped (operator)": ["stopped", [], "stopped"], "stopped (host)": ["lost", [], "stopped"],
    "resent (stopped)": ["unknown", [], "resent"], "resent (not stopped)": ["unknown", [], "resent"],
  },
  input: {
    planned: ["E_SESSION_NOT_RUNNING", [], "planned"], sent: ["E_SESSION_NOT_RUNNING", [], "sent"],
    running: ["submitted", ["inspect", "input"], "running"], lost: ["submitted", ["inspect", "input"], "running"],
    "stopped (operator)": ["E_SESSION_NOT_RUNNING", [], "stopped"], "stopped (host)": ["E_SESSION_NOT_RUNNING", [], "stopped"],
    "resent (stopped)": ["E_SESSION_NOT_RUNNING", [], "resent"], "resent (not stopped)": ["E_SESSION_INPUT_FAILED", [], "resent"],
  },
  stop: {
    planned: ["nothing-to-stop", [], "planned"], sent: ["stopped", ["stop:null"], "planned"],
    running: ["stopped", ["stop:E"], "stopped"], lost: ["stopped", ["stop:E"], "stopped"],
    "stopped (operator)": ["already-stopped", ["stop:E"], "stopped"], "stopped (host)": ["already-stopped", ["stop:E"], "stopped"],
    "resent (stopped)": ["stopped", ["stop:E", "stop:null"], "stopped"], "resent (not stopped)": ["stopped", ["stop:E", "stop:null"], "stopped"],
  },
  start: {
    planned: ["launched", ["launch"], "running"], sent: ["launched", ["stop:null", "launch"], "running"],
    running: ["E_SESSION_RUNNING", ["inspect"], "running"], lost: ["launched", ["inspect", "stop:E", "launch"], "running"],
    "stopped (operator)": ["launched", ["stop:E", "launch"], "running"], "stopped (host)": ["launched", ["stop:E", "launch"], "running"],
    "resent (stopped)": ["launched", ["stop:E", "stop:null", "launch"], "running"], "resent (not stopped)": ["launched", ["stop:E", "stop:null", "launch"], "running"],
  },
  restart: {
    planned: ["launched", ["launch"], "running"], sent: ["launched", ["stop:null", "launch"], "running"],
    running: ["launched", ["inspect", "stop:E", "launch"], "running"], lost: ["launched", ["inspect", "stop:E", "launch"], "running"],
    "stopped (operator)": ["launched", ["stop:E", "launch"], "running"], "stopped (host)": ["launched", ["stop:E", "launch"], "running"],
    "resent (stopped)": ["launched", ["stop:E", "stop:null", "launch"], "running"], "resent (not stopped)": ["launched", ["stop:E", "stop:null", "launch"], "running"],
  },
  resume: {
    planned: ["E_RESUME_NOT_LOST", [], "planned"], sent: ["E_SESSION_UNKNOWN", [], "sent"],
    running: ["E_SESSION_RUNNING", ["inspect"], "running"], lost: ["resumed", ["inspect", "input"], "running"],
    "stopped (operator)": ["E_RESUME_NOT_LOST", [], "stopped"], "stopped (host)": ["resumed", ["input"], "running"],
    "resent (stopped)": ["E_SESSION_UNKNOWN", [], "resent"], "resent (not stopped)": ["E_SESSION_UNKNOWN", [], "resent"],
  },
  retire: {
    planned: ["retired", [], "gone"], sent: ["retired", ["stop:null"], "gone"],
    running: ["retired", ["stop:E"], "gone"], lost: ["retired", ["stop:E"], "gone"],
    "stopped (operator)": ["retired", ["stop:E"], "gone"], "stopped (host)": ["retired", ["stop:E"], "gone"],
    "resent (stopped)": ["retired", ["stop:E", "stop:null"], "gone"], "resent (not stopped)": ["retired", ["stop:E", "stop:null"], "gone"],
  },
};

for (const [verb, row] of Object.entries(CELLS)) {
  test(`${verb}, by state`, async (t) => {
    const fx = providerDeployment(t);
    fx.controls = {};
    let n = 0;
    for (const [state, [answer, calls, after]] of Object.entries(row)) {
      await t.test(`${verb} of a ${state} home: ${answer}; the provider: ${calls.join(", ") || "not called"}; then ${after}`, async () => {
        const home = await STATES[state](fx, `h${++n}`);
        fx.clearCalls();
        assert.equal(await answerOf(fx, verb, home), answer);
        assert.deepEqual(callsOf(fx, home), calls);
        assert.equal(stateOf(home), after);
        // Whatever the verb did, a settled home's record agrees with its receipt again.
        if (after !== "gone" && after !== "sent" && after !== "resent") await assert.doesNotReject(fx.inEnv(() => inspectInstanceSession(home)), `${after}: the record and the receipt agree`);
      });
    }
  });
}

test("settling leaves a planned home planned and a launched one stopped, the record rewritten to agree and the stop an operator's unless the host's was recorded", async (t) => {
  const fx = providerDeployment(t);
  fx.controls = {};
  // sent → planned.
  const sent = await STATES.sent(fx, "s1");
  await fx.inEnv(() => stopInstanceSession(sent, {}));
  assert.deepEqual([runtimeOf(sent), recordOf(sent).launched, recordOf(sent).session.endpoint], [{ launched: false, backend: "fake", provider: FAKE_CAPABILITY }, false, null]);
  // resent, never stopped → stopped, as an operator's stop: no sweep brings it back.
  const resent = await STATES["resent (not stopped)"](fx, "s2");
  await fx.inEnv(() => stopInstanceSession(resent, {}));
  assert.deepEqual([Number.isFinite(Date.parse(runtimeOf(resent).stoppedAt)), Object.hasOwn(runtimeOf(resent), "launchSent"), stopReceiptOf(resent).resume ?? false], [true, false, false]);
  // resent on a home the host had stopped, settled by a start that then fails to launch: stopped, and still the host's stop.
  const hosted = await STATES["stopped (host)"](fx, "s3");
  writeRuntime(hosted, { ...runtimeOf(hosted), launchSent: SENT_AT });
  fx.control({ s3: { launch: { error: { code: "E_BACKEND_NOT_READY", message: "down" } } } });
  assert.equal(await answerOf(fx, "start", hosted), "E_BACKEND_NOT_READY");
  assert.deepEqual([stateOf(hosted), stopReceiptOf(hosted).reason], ["stopped", "host-stop"]);
  // A settle the provider does not confirm changes nothing, and the next verb asks again.
  const stuck = await STATES.sent(fx, "s4");
  fx.control({ s4: { stop: { exit: 1 } } });
  assert.equal(await answerOf(fx, "stop", stuck), "E_SESSION_STOP_FAILED");
  assert.equal(stateOf(stuck), "sent");
  fx.control({});
  fx.clearCalls();
  assert.equal(await answerOf(fx, "stop", stuck), "stopped");
  assert.deepEqual([callsOf(fx), stateOf(stuck), fx.verbs("stop")[0].request.input.launchSent], [["stop:null"], "planned", SENT_AT]);
});

// ----------------------------------------------------- an input in flight across a state change
/** An input sent as its own process, whose provider call takes a while; `act` runs meanwhile. */
async function inputWhile(fx, home, act) {
  const text = join(fx.base, "mail.txt");
  writeFileSync(text, "aweb mail event received.\n");
  const child = spawn(process.execPath, [CLI, "session", "input", "--home", home, "--text-file", text, "--json"], { cwd: fx.dep, env: fx.env, stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  const done = new Promise((resolve) => child.on("close", resolve));
  for (let i = 0; i < 100 && !fx.verbs("input").length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(fx.verbs("input").length, 1, "the provider's input is in flight");
  await act();
  await done;
  return JSON.parse(out.trim().split("\n").pop());
}
const STABLE = { server: FAKE_SERVER, threadId: "thr_home_stable" };
// [what lands while the input is sent, the provider's answer to the input, the input's answer, the stops after the input was sent]
const CROSSINGS = [
  ["nothing", {}, async () => {}, "submitted", []],
  ["a stop", {}, (fx, home) => fx.inEnv(() => stopInstanceSession(home, {})), "E_SESSION_NOT_RUNNING", ["stop:E", "stop:E"]],
  ["a stop, and the provider refuses the input", { error: { code: "E_SESSION_PROMPT_OPEN", message: "a prompt is open" } }, (fx, home) => fx.inEnv(() => stopInstanceSession(home, {})), "E_SESSION_NOT_RUNNING", ["stop:E", "stop:E"]],
  ["a restart, to another endpoint", {}, (fx, home) => fx.inEnv(() => restartInstanceSession(home, {})), "E_SESSION_NOT_RUNNING", ["stop:E", "stop:E"]],
  ["a restart, and the provider reuses the locator (which a provider must not)", { stable: true }, (fx, home) => fx.inEnv(() => restartInstanceSession(home, {})), "E_SESSION_NOT_RUNNING", ["stop:E"]],
  // A retire waits for the input before its last stop: its own stop, the input's (the home is still
  // there, stopped), and the retire's once more, after which nothing can restart the session.
  ["a retire", {}, (fx, home) => { const r = JSON.parse(fx.cli(["retire", home.split("/").pop(), "--json"]).stdout); assert.equal(r.retired, home.split("/").pop(), JSON.stringify(r).slice(0, 300)); }, "E_SESSION_NOT_RUNNING", ["stop:E", "stop:E", "stop:E"]],
];
for (const [what, behaviour, act, answer, stops] of CROSSINGS) {
  test(`an input in flight while ${what} lands: ${answer}; stops: ${stops.join(", ") || "none"}`, async (t) => {
    const fx = providerDeployment(t);
    const { stable, ...input } = behaviour;
    if (stable) fx.control({ x: { launch: { result: { endpoint: STABLE } } } });
    const { home } = await fx.launch("x");
    fx.control({ x: { ...(stable ? { launch: { result: { endpoint: STABLE } } } : {}), input: { sleepMs: 2500, ...input } } });
    fx.clearCalls();
    const answered = await inputWhile(fx, home, () => act(fx, home));
    assert.equal(answered.ok ? "submitted" : answered.error.code, answer, JSON.stringify(answered).slice(0, 300));
    assert.deepEqual(callsOf(fx).filter((c) => c.startsWith("stop")), stops);
    if (what === "a retire") {
      // The retire's last stop came after the input's provider call had ended, and the home is gone.
      const order = fx.calls().filter((c) => c.verb === "input" || c.verb === "stop").map((c) => c.verb);
      assert.deepEqual([order.at(-1), existsSync(home), existsSync(join(dirname(home), ".oats-retirement", "inputs", "x")) ? readdirSync(join(dirname(home), ".oats-retirement", "inputs", "x")) : []], ["stop", false, []]);
    }
  });
}
test("an input in flight to a lost session while a start marks its launch: not delivered, and the session it restarted at the old endpoint is stopped again", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("x");
  fx.control({ x: { inspect: { result: LOST }, input: { sleepMs: 2500 }, launch: { sleepMs: 4000 } } });
  fx.clearCalls();
  let start;
  const answered = await inputWhile(fx, home, async () => {
    // A start, as its own process: it marks its launch while the input is still being sent.
    const child = spawn(process.execPath, [CLI, "session", "start", "--home", home, "--json"], { cwd: fx.dep, env: fx.env, stdio: "ignore" });
    start = new Promise((resolve) => child.on("close", resolve));
    for (let i = 0; i < 100 && !fx.verbs("launch").length; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(stateOf(home), "resent", "the start's launch is marked as sent");
  });
  await start;
  assert.equal(answered.ok ? "submitted" : answered.error.code, "E_SESSION_NOT_RUNNING");
  // The start stopped the old endpoint before its mark; the input, which crossed it, stops it again.
  assert.deepEqual(fx.verbs("stop").map((c) => c.request.input.endpoint), [E("x", 1), E("x", 1)]);
  assert.deepEqual([stateOf(home), runtimeOf(home).endpoint], ["running", E("x", 2)]);
});

// -------------------------------------------------------------------------- the holder died
/** Run `args` as its own process and SIGKILL it once the provider logs `verb` for `name`; the
 *  provider goes on and finishes what it was asked. */
async function killedDuring(fx, args, name, verb) {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: fx.dep, env: fx.env, stdio: "ignore" });
  const done = new Promise((resolve) => child.on("close", resolve));
  for (let i = 0; i < 200 && !fx.verbs(verb).some((c) => c.instance === name); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(fx.verbs(verb).filter((c) => c.instance === name).length, 1, `the provider's ${verb} is in flight`);
  child.kill("SIGKILL");
  await done;
  await new Promise((r) => setTimeout(r, 1800));
}
const SPAWN = (name) => ["spawn", "dev", "--name", name, "--backend", "fake", "--launch-config", "claude", "--json"];
const homeOf = (fx, name) => join(fx.root, "dev", "instances", name);

test("a spawn killed before the mark (in the provider's check) leaves a planned home: the next start launches it", async (t) => {
  const fx = providerDeployment(t, { manifest: fakeManifest({ fake: fakeProvider({ check: true }) }) });
  fx.control({ k: { check: { sleepMs: 1500 } } });
  await killedDuring(fx, SPAWN("k"), "k", "check");
  fx.control({});
  fx.clearCalls();
  const home = homeOf(fx, "k");
  assert.equal(stateOf(home), "planned");
  assert.equal(await answerOf(fx, "start", home), "launched");
  assert.deepEqual([callsOf(fx), stateOf(home)], [["launch"], "running"]);
});

test("a spawn killed while the provider launches leaves a sent home: unknown to reads, and the next stop settles it with the instant of the launch", async (t) => {
  const fx = providerDeployment(t);
  fx.control({ k: { launch: { sleepMs: 1500 } } });
  await killedDuring(fx, SPAWN("k"), "k", "launch");
  fx.control({});
  fx.clearCalls();
  const home = homeOf(fx, "k");
  const sent = runtimeOf(home);
  assert.deepEqual([stateOf(home), Object.keys(sent).sort(), recordOf(home).launched], ["sent", ["backend", "launchSent", "launched", "provider"], true]);
  assert.equal(await answerOf(fx, "inspect", home), "E_SESSION_UNAVAILABLE");
  assert.equal(await answerOf(fx, "stop", home), "stopped");
  assert.deepEqual([callsOf(fx), fx.verbs("stop")[0].request.input.launchSent, stateOf(home)], [["stop:null"], sent.launchSent, "planned"]);
});

for (const verb of ["start", "restart"]) {
  test(`a ${verb} killed while the provider launches leaves a resent home: the next start settles it, stops the recorded session, and launches one session`, async (t) => {
    const fx = providerDeployment(t);
    const { home } = await fx.launch("k");
    if (verb === "start") await fx.inEnv(() => stopInstanceSession(home, {}));
    fx.control({ k: { launch: { sleepMs: 1500 } } });
    fx.clearCalls();
    await killedDuring(fx, ["session", verb, "--home", home, "--json"], "k", "launch");
    fx.control({});
    fx.clearCalls();
    assert.deepEqual([stateOf(home), runtimeOf(home).endpoint], ["resent", E("k", 1)]);
    assert.equal(await answerOf(fx, "status", home), "unknown");
    assert.equal(await answerOf(fx, "start", home), "launched");
    assert.deepEqual([callsOf(fx), stateOf(home), runtimeOf(home).endpoint], [["stop:E", "stop:null", "launch"], "running", E("k", 3)]);
  });
}

// The write orders, by the writers: the kernel dies (SIGKILL) at a named point between two writes
// (lib/core.mjs dieAt), and the records it leaves are a state of the page, which the next verb acts
// on. A row: [the point, the state the home is built in, the verb that dies, what the provider had
// been asked to do by then (its reads aside), the state left, the next verb, what the provider is asked then, the state after].
const DEATHS = [
  // The mark: the receipt, then the record.
  ["mark:receipt-written", "planned", "start", [], "sent", "stop", ["stop:null"], "planned"],
  ["mark:receipt-written", "stopped (operator)", "start", ["stop:E"], "resent", "start", ["stop:E", "stop:null", "launch"], "running"],
  // A launch that answered: the receipt's endpoint with the mark kept, the record, the mark removed.
  ["outcome:receipt-written", "planned", "start", ["launch"], "resent", "start", ["stop:E", "stop:null", "launch"], "running"],
  ["outcome:receipt-written", "stopped (operator)", "start", ["stop:E", "launch"], "resent", "stop", ["stop:E", "stop:null"], "stopped"],
  ["outcome:record-written", "planned", "start", ["launch"], "resent", "retire", ["stop:E", "stop:null"], "gone"],
  ["outcome:record-written", "running", "restart", ["stop:E", "launch"], "resent", "start", ["stop:E", "stop:null", "launch"], "running"],
  // A launch the provider refused: unmarked, the record, then the receipt.
  ["unmark:record-written", "planned", "start (refused)", ["launch"], "sent", "start", ["stop:null", "launch"], "running"],
  // A settle: the provider's stop, the record, then the receipt.
  ["settle:record-written", "sent", "stop", ["stop:null"], "sent", "stop", ["stop:null"], "planned"],
  ["settle:record-written", "resent (not stopped)", "stop", ["stop:E", "stop:null"], "resent", "start", ["stop:E", "stop:null", "launch"], "running"],
  // The stop rule: stoppedAt, the stop receipt, then the provider's stop.
  ["stop:stoppedAt-written", "running", "stop", [], "stopped", "stop", ["stop:E"], "stopped"],
  ["stop:receipt-written", "running", "stop", [], "stopped", "start", ["stop:E", "launch"], "running"],
  ["stop:stoppedAt-written", "running", "restart", [], "stopped", "start", ["stop:E", "launch"], "running"],
  // A retire stops by the same rule: stopped, the provider not asked yet, and a new input refused.
  ["stop:stoppedAt-written", "running", "retire", [], "stopped", "retire", ["stop:E"], "gone"],
  ["stop:receipt-written", "lost", "retire", [], "stopped", "stop", ["stop:E"], "stopped"],
  // The resume of a home stopped with the host: the notice, stoppedAt cleared, the stop receipt removed.
  ["resume:notice-sent", "stopped (host)", "resume", ["input"], "stopped", "resume", ["input"], "running"],
  ["resume:stop-cleared", "stopped (host)", "resume", ["input"], "running", "stop", ["stop:E"], "stopped"],
];
/** The verb as its own process, which dies at `point` → the signal that ended it. */
function dies(fx, verb, home, point) {
  const name = home.split("/").pop();
  const env = { ...fx.env, OATS_TEST_PROVIDER_DIE_AT: point };
  const run = (args, e = env) => spawnSync(process.execPath, [CLI, ...args], { cwd: fx.dep, env: e, encoding: "utf8" });
  if (verb === "stop") {
    const plan = JSON.parse(run(["instance", "stop", name, "--plan", "--json"], fx.env).stdout.trim().split("\n").pop());
    return run(["instance", "stop", name, "--apply", "--plan-revision", plan.result.planRevision, "--idempotency-key", `die-${name}`, "--json"]).signal;
  }
  if (verb === "resume") return run(["session", "start", "--resume", "--home", home, "--json"]).signal;
  if (verb === "retire") return run(["retire", name, "--json"]).signal;
  return run(["session", verb.startsWith("start") ? "start" : verb, "--home", home, "--json"]).signal;
}
test("the kernel dying between two writes leaves a state of the page, and the next verb acts on it", async (t) => {
  const fx = providerDeployment(t);
  fx.controls = {};
  let n = 0;
  for (const [point, state, verb, asked, left, next, then, after] of DEATHS) {
    await t.test(`${verb} of a ${state} home dies at ${point}: ${left}; then ${next}: ${then.join(", ") || "not called"}; ${after}`, async () => {
      const name = `d${++n}`;
      const home = await STATES[state](fx, name);
      if (verb.endsWith("(refused)")) { fx.controls = { ...fx.controls, [name]: { launch: { error: { code: "E_BACKEND_NOT_READY", message: "down" } } } }; fx.control(fx.controls); }
      fx.clearCalls();
      assert.equal(dies(fx, verb, home, point), "SIGKILL", "the kernel died at the point");
      // (What the provider was told to do: its reads, which a plan makes too, are not what a write order is about.)
      assert.deepEqual([callsOf(fx, home).filter((call) => call !== "inspect"), stateOf(home)], [asked, left]);
      // An unsettled home is unknown to a read; a settled one's record agrees with its receipt.
      if (left === "sent" || left === "resent") assert.equal(await answerOf(fx, "inspect", home), "E_SESSION_UNAVAILABLE");
      else await assert.doesNotReject(fx.inEnv(() => inspectInstanceSession(home)));
      if (verb.endsWith("(refused)")) { const { [name]: _gone, ...rest } = fx.controls; fx.controls = rest; fx.control(fx.controls); }
      fx.clearCalls();
      const answered = await answerOf(fx, next, home);
      assert.equal(/^E_/.test(answered), false, `${next} answered ${answered}`);
      assert.deepEqual([callsOf(fx, home), stateOf(home)], [then, after]);
      if (after !== "gone") await assert.doesNotReject(fx.inEnv(() => inspectInstanceSession(home)), "the record and the receipt agree");
    });
  }
});

test("a stop killed while the provider stops leaves the home stopped, with the stop's receipt: the host's stop is still one a resume brings back", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("k");
  fx.control({ k: { stop: { sleepMs: 1500 } } });
  fx.clearCalls();
  // The host's stop, as `oats host run` gives it, killed during the provider's stop.
  const child = spawn(process.execPath, [HOST_STOP_CHILD, home, "20000"], { cwd: fx.dep, env: fx.env, stdio: "ignore" });
  const done = new Promise((resolve) => child.on("close", resolve));
  for (let i = 0; i < 200 && !fx.verbs("stop").length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(fx.verbs("stop").length, 1, "the provider's stop is in flight");
  child.kill("SIGKILL");
  await done;
  assert.deepEqual([stateOf(home), stopReceiptOf(home).reason], ["stopped", "host-stop"], "stoppedAt and the stop receipt were written before the provider was asked");
  fx.control({});
  fx.clearCalls();
  assert.equal(await answerOf(fx, "resume", home), "resumed");
  assert.deepEqual([callsOf(fx, home), stateOf(home), stopReceiptOf(home)], [["input"], "running", null]);
});

test("a resume that died after it cleared the host's stop left that stop's receipt: a later loss of the same start is counted as a loss, in the sweep's plan too", async (t) => {
  const fx = providerDeployment(t);
  fx.controls = {};
  const home = await STATES["stopped (host)"](fx, "r");
  assert.equal(dies(fx, "resume", home, "resume:stop-cleared"), "SIGKILL");
  assert.deepEqual([stateOf(home), stopReceiptOf(home).reason], ["running", "host-stop"]);
  // The session is then lost: its resume is one of the home's cap, whatever that receipt says.
  fx.control({ r: { inspect: { result: LOST } } });
  const { providerResumes, RESUME_LIMIT } = await import("../lib/provider-resume.mjs");
  for (let i = 0; i < RESUME_LIMIT; i++) assert.equal(await answerOf(fx, "input", home), "submitted");
  assert.equal((await fx.inEnv(() => providerResumes(home))).count, RESUME_LIMIT);
  const planned = fx.cli(["session", "resume", "--deployment", fx.dep, "--plan", "--json"]).json().result.rows.find((row) => row.instance === "r");
  assert.deepEqual([planned.outcome, planned.reason], ["refused", "keeps-getting-lost"]);
});


// A spawn writes the same orders as a start (the mark, the outcome), and one of its own before
// them: the planned record, then the receipt.
const SPAWN_DEATHS = [
  // [point, spawn arguments, the provider's calls by then, state left, the next verb, its calls, state after]
  ["mark:receipt-written", [], [], "sent", "stop", ["stop:null"], "planned"],
  ["outcome:receipt-written", [], ["launch"], "resent", "start", ["stop:E", "stop:null", "launch"], "running"],
  ["outcome:record-written", [], ["launch"], "resent", "retire", ["stop:E", "stop:null"], "gone"],
  // Between the planned record and the receipt nothing was sent. A directory home has its early
  // receipt, which names the provider: planned. A worktree home has none: a retire takes it.
  ["spawn:record-written", ["--work", "directory"], [], "planned", "start", ["launch"], "running"],
  ["spawn:record-written", ["--work", "directory", "--no-launch"], [], "planned", "retire", [], "gone"],
  ["spawn:record-written", ["--work", "worktree"], [], "no receipt", "retire", [], "gone"],
  ["spawn:record-written", ["--work", "worktree", "--no-launch"], [], "no receipt", "retire --force", [], "gone"],
];
test("a spawn dying between two of its writes leaves a state of the page, or a planned home without its receipt that a retire takes", async (t) => {
  const fx = providerDeployment(t);
  let n = 0;
  for (const [point, args, asked, left, next, then, after] of SPAWN_DEATHS) {
    await t.test(`spawn ${args.join(" ")} dies at ${point}: ${left}; then ${next}: ${then.join(", ") || "not called"}; ${after}`, async () => {
      const name = `s${++n}`;
      fx.clearCalls();
      const died = spawnSync(process.execPath, [CLI, "spawn", "dev", "--name", name, "--backend", "fake", "--launch-config", "claude", ...args, "--json"], { cwd: fx.dep, env: { ...fx.env, OATS_TEST_PROVIDER_DIE_AT: point }, encoding: "utf8" });
      assert.equal(died.signal, "SIGKILL", `the spawn died at the point: ${died.stdout}${died.stderr}`);
      const home = JSON.parse(fx.cli(["status", "--json"]).stdout).agents.flatMap((a) => a.instances).find((r) => r.instance === name).home;
      assert.deepEqual([callsOf(fx, home).filter((call) => call !== "inspect"), existsSync(receiptPath(home)) ? stateOf(home) : "no receipt"], [asked, left]);
      if (left === "no receipt") {
        // Not a home a verb can run: its session's receipt is missing. A retire removes it.
        assert.deepEqual([recordOf(home).launched, recordOf(home).session], [false, { provider: FAKE_CAPABILITY, endpoint: null }]);
        assert.equal(await answerOf(fx, "start", home), "E_RUNTIME_ENDPOINT_UNKNOWN");
      }
      fx.clearCalls();
      if (next.startsWith("retire")) {
        const retired = JSON.parse(fx.cli(["retire", name, ...next.split(" ").slice(1), "--json"]).stdout);
        assert.equal(retired.retired, name, JSON.stringify(retired).slice(0, 400));
      } else assert.equal(/^E_/.test(await answerOf(fx, next, home)), false);
      assert.deepEqual([callsOf(fx, home), stateOf(home)], [then, after]);
    });
  }
});

test("a resume's notice that fails without a refusal leaves a home stopped with the host stopped, still to resume, and has the provider asked to stop that session again", async (t) => {
  const fx = providerDeployment(t);
  fx.controls = {};
  const home = await STATES["stopped (host)"](fx, "n");
  const stoppedAt = runtimeOf(home).stoppedAt;
  fx.control({ n: { input: { exit: 1 } } });
  fx.clearCalls();
  assert.equal(await answerOf(fx, "resume", home), "E_SESSION_INPUT_FAILED");
  assert.deepEqual([callsOf(fx, home), runtimeOf(home).stoppedAt, stopReceiptOf(home)?.resume], [["input", "stop:E"], stoppedAt, true]);
  fx.control({});
  assert.equal(await answerOf(fx, "resume", home), "resumed");
});

test("a stop's plan reports a provider session's activity as the provider says it: mid-task when it runs a turn, unknown when it reports none", async (t) => {
  const fx = providerDeployment(t);
  await fx.launch("idle");
  const planOf = () => JSON.parse(fx.cli(["instance", "stop", "idle", "--plan", "--json"]).stdout.trim().split("\n").pop()).result.targets.at(-1);
  // The same home, the same clean work, the same `state`: only the provider's `running` differs.
  const facts = (plan) => [plan.session, plan.midTask];
  const session = { state: "unknown", present: true, backend: "fake", established: true };
  assert.deepEqual(facts(planOf()), [session, true], "running: true");
  fx.control({ idle: { inspect: { result: { present: true, state: "unknown", running: null } } } });
  assert.deepEqual(facts(planOf()), [session, "unknown"], "running: null");
});

test("an operator's stop that dies before its own receipt does not inherit the receipt of an earlier stop with the host: it is not resumed", async (t) => {
  const fx = providerDeployment(t);
  fx.controls = {};
  const home = await STATES["stopped (host)"](fx, "two");
  // A resume that died after it cleared the stop: running, the host's stop receipt left.
  assert.equal(dies(fx, "resume", home, "resume:stop-cleared"), "SIGKILL");
  assert.deepEqual([stateOf(home), stopReceiptOf(home)?.resume], ["running", true]);
  // Then an operator's stop that died right after `stoppedAt`.
  assert.equal(dies(fx, "stop", home, "stop:stoppedAt-written"), "SIGKILL");
  assert.deepEqual([stateOf(home), stopReceiptOf(home)], ["stopped", null]);
  fx.clearCalls();
  assert.equal(await answerOf(fx, "resume", home), "E_RESUME_NOT_LOST");
  const row = JSON.parse(fx.cli(["status", "--json"]).stdout).agents.flatMap((a) => a.instances).find((r) => r.home === home);
  assert.deepEqual([callsOf(fx, home).filter((c) => c === "input"), row.sessionEnd === "lost"], [[], false]);
});

test("a start of a lost home that died right after its mark, where an input had restarted the old session: the next start stops that session before it settles", async (t) => {
  const fx = providerDeployment(t);
  fx.controls = {};
  const home = await STATES.lost(fx, "old");
  fx.clearCalls();
  // (The input that restarted the session at E returned before the mark: the start's own stop of E comes after it.)
  assert.equal(dies(fx, "start", home, "mark:receipt-written"), "SIGKILL");
  assert.deepEqual([callsOf(fx, home).filter((c) => c !== "inspect"), stateOf(home), runtimeOf(home).stoppedAt], [[], "resent", null]);
  // The settle of the next start, killed after it recorded the home stopped: E was stopped by then.
  fx.clearCalls();
  assert.equal(dies(fx, "start", home, "settle:record-written"), "SIGKILL");
  assert.deepEqual(callsOf(fx, home).filter((c) => c !== "inspect"), ["stop:E", "stop:null"]);
});

test("a spawn whose launch answer was lost, whose stop the provider confirmed and whose home is kept for a hook's cleanup leaves it planned, record and receipt alike: a retire takes it", async (t) => {
  const files = fakeFiles();
  // The spawn hook reports state it made, and the capability has no retire hook: the rollback owes a cleanup.
  const hook = files["bin/hook.mjs"].replace("process.stdout.write(JSON.stringify({ env:", "process.stdout.write(JSON.stringify({ meta: { made: true }, env:");
  assert.notEqual(hook, files["bin/hook.mjs"]);
  files["bin/hook.mjs"] = hook;
  const fx = providerDeployment(t, { capabilities: { [FAKE_CAPABILITY]: { manifest: fakeManifest(), files } } });
  fx.control({ q: { launch: { exit: 1 } } });
  const failed = JSON.parse(fx.cli(["spawn", "dev", "--name", "q", "--backend", "fake", "--launch-config", "claude", "--json"]).stdout);
  const home = join(fx.root, "dev", "instances", "q");
  assert.deepEqual([failed.ok, existsSync(home), existsSync(join(home, ".oats-rollback-incomplete.json")), callsOf(fx, home)], [false, true, true, ["launch", "stop:null"]]);
  assert.deepEqual([runtimeOf(home), recordOf(home).launched, recordOf(home).session], [{ launched: false, backend: "fake", provider: FAKE_CAPABILITY }, false, { provider: FAKE_CAPABILITY, endpoint: null }]);
  fx.control({});
  const retired = JSON.parse(fx.cli(["retire", "q", "--force", "--json"]).stdout);
  assert.deepEqual([retired.retired, existsSync(home)], ["q", false], JSON.stringify(retired).slice(0, 400));
});

test("a pending start receipt in a provider home is not read: a start launches on the provider, and the receipt keeps its backend", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("p");
  const plain = await fx.spawn("plain", { name: "t" });
  // A file the home's agent can write, shaped as a tmux home's pending start.
  writeFileSync(join(home, ".oats-start-pending.json"), JSON.stringify({ id: "planted-1", target: { backend: "tmux", session: "nosuch", window: "p", socket: join(fx.base, "no-such-socket") }, command: recordOf(plain.home).command, model: null, startedAt: new Date().toISOString() }));
  fx.control({ p: { inspect: { result: LOST } } });
  fx.clearCalls();
  assert.equal(await answerOf(fx, "start", home), "launched");
  const runtime = runtimeOf(home);
  assert.deepEqual([callsOf(fx, home), runtime.backend, runtime.provider, runtime.tmux, recordOf(home).tmux, stateOf(home)], [["inspect", "stop:E", "launch"], "fake", FAKE_CAPABILITY, undefined, undefined, "running"]);
});

test("the host's stop leaves a stopped home as it is: the provider is not called, and an operator's stop stays the operator's", async (t) => {
  const fx = providerDeployment(t);
  fx.controls = {};
  for (const [state, resume] of [["stopped (operator)", undefined], ["stopped (host)", true]]) {
    const home = await STATES[state](fx, state.includes("host") ? "h" : "o");
    const before = [runtimeOf(home), stopReceiptOf(home)];
    assert.equal(before[1]?.resume, resume);
    fx.clearCalls();
    const r = spawnSync(process.execPath, [HOST_STOP_CHILD, home, "20000"], { cwd: fx.dep, env: fx.env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual([callsOf(fx, home), runtimeOf(home), stopReceiptOf(home)], [[], ...before], state);
  }
});

test("a resume of a home whose session is there and reports no activity is refused: it did not lose its session", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("there");
  fx.control({ there: { inspect: { result: { present: true, state: "unknown", running: null } } } });
  fx.clearCalls();
  assert.equal(await answerOf(fx, "resume", home), "E_RESUME_NOT_LOST");
  assert.deepEqual([callsOf(fx, home), stateOf(home)], [["inspect"], "running"]);
});

test("a spawn holds its home's claim to its last write of the record: one killed there still names the claim", async (t) => {
  const fx = providerDeployment(t);
  const died = spawnSync(process.execPath, [CLI, "spawn", "dev", "--name", "held", "--backend", "fake", "--launch-config", "claude", "--idempotency-key", "held-1", "--json"], { cwd: fx.dep, env: { ...fx.env, OATS_TEST_PROVIDER_DIE_AT: "spawn:published" }, encoding: "utf8" });
  assert.equal(died.signal, "SIGKILL", `${died.stdout}${died.stderr}`);
  const home = join(fx.root, "dev", "instances", "held");
  // Everything of the spawn is written (the record says it completed), and the claim was still its own.
  const claim = readJson(join(dirname(home), ".oats-retirement", "claims", "held.lock"));
  assert.deepEqual([stateOf(home), recordOf(home).spawnCompleted, claim.action], ["running", true, "start"]);
  // Its holder is gone: the next verb takes the claim over.
  assert.equal(await answerOf(fx, "stop", home), "stopped");
});
