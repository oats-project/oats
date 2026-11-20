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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inputInstanceSession, inspectInstanceSession, restartInstanceSession, startInstanceSession, stopInstanceSession } from "../lib/core.mjs";
import { FAKE_CAPABILITY, FAKE_SERVER, LOST, fakeManifest, fakeProvider, providerDeployment } from "./helpers/session-provider-fixture.mjs";

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
    "resent (stopped)": ["launched", ["stop:null", "stop:E", "launch"], "running"], "resent (not stopped)": ["launched", ["stop:null", "stop:E", "launch"], "running"],
  },
  restart: {
    planned: ["launched", ["launch"], "running"], sent: ["launched", ["stop:null", "launch"], "running"],
    running: ["launched", ["inspect", "stop:E", "launch"], "running"], lost: ["launched", ["inspect", "stop:E", "launch"], "running"],
    "stopped (operator)": ["launched", ["stop:E", "launch"], "running"], "stopped (host)": ["launched", ["stop:E", "launch"], "running"],
    "resent (stopped)": ["launched", ["stop:null", "stop:E", "launch"], "running"], "resent (not stopped)": ["launched", ["stop:null", "stop:E", "launch"], "running"],
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
        if (after !== "gone" && after !== "sent" && after !== "resent") assert.doesNotThrow(() => inspectInstanceSession(home), `${after}: the record and the receipt agree`);
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
  ["a restart, and the provider reuses the locator", { stable: true }, (fx, home) => fx.inEnv(() => restartInstanceSession(home, {})), "E_SESSION_NOT_RUNNING", ["stop:E"]],
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
    assert.deepEqual([callsOf(fx), stateOf(home), runtimeOf(home).endpoint], [["stop:null", "stop:E", "launch"], "running", E("k", 3)]);
  });
}

test("a launch that died between two of its writes leaves an unsettled home, never a record that contradicts its receipt", async (t) => {
  const fx = providerDeployment(t);
  fx.controls = {};
  // Between the mark's two writes: the receipt says sent, the record still says not launched.
  const marked = await STATES.planned(fx, "w1");
  writeRuntime(marked, { launched: true, backend: "fake", provider: FAKE_CAPABILITY, launchSent: SENT_AT });
  assert.deepEqual([recordOf(marked).launched, await answerOf(fx, "inspect", marked)], [false, "E_SESSION_UNAVAILABLE"]);
  assert.deepEqual([await answerOf(fx, "stop", marked), stateOf(marked)], ["stopped", "planned"]);

  // After the answer: the receipt has the new endpoint, still marked as sent; the record has none yet.
  const answered = await STATES.planned(fx, "w2");
  writeRuntime(answered, { launched: true, backend: "fake", provider: FAKE_CAPABILITY, endpoint: E("w2", 1), stoppedAt: null, launchSent: SENT_AT }, { launched: true });
  assert.deepEqual([recordOf(answered).session.endpoint, await answerOf(fx, "inspect", answered), await answerOf(fx, "input", answered)], [null, "E_SESSION_UNAVAILABLE", "E_SESSION_INPUT_FAILED"]);
  fx.clearCalls();
  assert.equal(await answerOf(fx, "stop", answered), "stopped");
  assert.deepEqual([callsOf(fx), stateOf(answered), recordOf(answered).session.endpoint], [["stop:E", "stop:null"], "stopped", E("w2", 1)], "stopped, and the record rewritten to agree");

  // The same on a home launched before: the receipt has the new endpoint, the record the old one.
  const again = await STATES.running(fx, "w3");
  writeRuntime(again, { ...runtimeOf(again), endpoint: E("w3", 9), launchSent: SENT_AT });
  assert.deepEqual([recordOf(again).session.endpoint, await answerOf(fx, "status", again)], [E("w3", 1), "unknown"]);
  assert.equal(await answerOf(fx, "start", again), "launched");
  assert.deepEqual([stateOf(again), recordOf(again).session.endpoint], ["running", runtimeOf(again).endpoint]);

  // The record written too, and only the mark's removal missing: settled the same way.
  const last = await STATES.running(fx, "w4");
  writeRuntime(last, { ...runtimeOf(last), launchSent: SENT_AT });
  assert.deepEqual([await answerOf(fx, "retire", last), stateOf(last)], ["retired", "gone"]);
});
