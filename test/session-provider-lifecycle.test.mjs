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
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
  // A restart's stop waits for the input too (the drain), so the input reads the home STOPPED: the
  // row "stopped" again, whatever endpoint the restart's launch then answers.
  ["a restart (its stop waits for the input: stopped)", {}, (fx, home) => fx.inEnv(() => restartInstanceSession(home, {})), "E_SESSION_NOT_RUNNING", ["stop:E", "stop:E"]],
  ["a restart whose provider reuses the locator, which a provider must not (the same: stopped)", { stable: true }, (fx, home) => fx.inEnv(() => restartInstanceSession(home, {})), "E_SESSION_NOT_RUNNING", ["stop:E", "stop:E"]],
  // The rows "running, another startId": a restart that was RECORDED while the input was still
  // being sent, which the drain allows only for an input that outlasted its wait (its provider
  // call is ended there, and its kernel reads the home after the restart recorded its launch).
  // Built by writing the records as that restart leaves them.
  ["a restart recorded meanwhile, at another endpoint", {}, (fx, home) => restartedUnder(home, E("x", 2)), "E_SESSION_NOT_RUNNING", ["stop:E"]],
  ["a restart recorded meanwhile, at the same endpoint (nothing is stopped: that locator is the new session's)", {}, (fx, home) => restartedUnder(home, runtimeOf(home).endpoint), "E_SESSION_NOT_RUNNING", []],
  // Every stop waits for the input before it asks the provider: the input's own stop (the home is
  // still there, stopped), then the verb's, after which nothing can restart the session.
  ["a retire", {}, (fx, home) => { const r = JSON.parse(fx.cli(["retire", home.split("/").pop(), "--json"]).stdout); assert.equal(r.retired, home.split("/").pop(), JSON.stringify(r).slice(0, 300)); }, "E_SESSION_NOT_RUNNING", ["stop:E", "stop:E"]],
];
/** The records of `home` as a restart that launched at `endpoint` leaves them: another start. */
function restartedUnder(home, endpoint) {
  writeRuntime(home, { ...runtimeOf(home), endpoint }, { startId: "another-start", session: { provider: FAKE_CAPABILITY, endpoint } });
}
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
    if (what.startsWith("a restart recorded meanwhile")) {
      // The row is the one reached (the home reads restarted, not stopped), and the stop, where
      // there is one, is of the endpoint the input used: never the new session's.
      assert.match(answered.error.message, /was restarted by OATS/);
      assert.deepEqual(fx.verbs("stop").map((c) => c.request.input.endpoint), stops.length ? [E("x", 1)] : []);
    }
    if (what === "a retire") {
      // The retire's last stop came after the input's provider call had ended, and the home is gone.
      const order = fx.calls().filter((c) => c.verb === "input" || c.verb === "stop").map((c) => c.verb);
      assert.deepEqual([order.at(-1), existsSync(home), existsSync(join(dirname(home), ".oats-retirement", "provider-calls", "x"))], ["stop", false, false]);
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
  // No wait for the provider's command, which outlives the kernel that ran it: the next verb ends it.
}
const SPAWN = (name) => ["spawn", "dev", "--name", name, "--backend", "fake", "--launch-config", "claude", "--json"];
const homeOf = (fx, name) => join(fx.root, "dev", "instances", name);

test("a spawn killed while its provider's readiness is asked ran no hook and sent nothing: its home reads as being spawned", async (t) => {
  const fx = providerDeployment(t, { manifest: fakeManifest({ fake: fakeProvider({ check: true }) }) });
  fx.control({ k: { check: { sleepMs: 1500 } } });
  await killedDuring(fx, SPAWN("k"), "k", "check");
  fx.control({});
  // The check comes before the spawn's hooks: nothing ran but it, and no record was written.
  assert.deepEqual(fx.calls().map((c) => c.hook ?? c.verb), ["check"]);
  const home = homeOf(fx, "k");
  const inspected = JSON.parse(fx.cli(["session", "inspect", "--home", home, "--json"]).stdout);
  assert.deepEqual([inspected.ok, inspected.error.code], [false, "E_SESSION_UNAVAILABLE"], JSON.stringify(inspected).slice(0, 300));
  assert.match(inspected.error.message, /k is being spawned/);
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
    assert.deepEqual([callsOf(fx), stateOf(home), runtimeOf(home).endpoint], [["stop:E", "stop:null", "launch"], "running", E("k", 2)], "the killed launch never made its session: the next is the second");
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
  // A spawn keeps the mark to its last write of the record: until then no input is admitted.
  ["spawn:recorded", ["--idempotency-key", "kept-1"], ["launch"], "resent", "stop", ["stop:E", "stop:null"], "stopped"],
  // Between the planned record and the spawn's last receipt nothing was sent, and the home is
  // planned: its receipt was written before its record, in every work mode.
  ["spawn:record-written", ["--work", "directory"], [], "planned", "start", ["launch"], "running"],
  ["spawn:record-written", ["--work", "directory", "--no-launch"], [], "planned", "retire", [], "gone"],
  ["spawn:record-written", ["--work", "worktree"], [], "planned", "start", ["launch"], "running"],
  ["spawn:record-written", ["--work", "worktree", "--no-launch"], [], "planned", "retire", [], "gone"],
];
test("a spawn dying between two of its writes leaves a state of the page", async (t) => {
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
  // A file the home's agent can write, shaped as a tmux home's pending start.
  writeFileSync(join(home, ".oats-start-pending.json"), JSON.stringify({ id: "planted-1", target: { backend: "tmux", session: "nosuch", window: "p", socket: join(fx.base, "no-such-socket") }, command: "claude", model: null, startedAt: new Date().toISOString() }));
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

// A provider's command outlives the kernel that ran it. The next verb ends it, with its process
// group, before it relies on the provider's stop: what that command would still have done never happens.
test("a launch whose kernel was killed is ended with its process group before the home is settled: settled at once, no session appears afterwards", async (t) => {
  const fx = providerDeployment(t);
  const late = join(fx.fake, "late-launch");
  fx.control({ k: { launch: { sleepMs: 2500, late } } });
  await killedDuring(fx, SPAWN("k"), "k", "launch");
  const home = homeOf(fx, "k");
  const calls = join(dirname(home), ".oats-retirement", "provider-calls", "k");
  // The call is recorded outside the home: the kernel that made it, and the group its command runs in.
  const records = readdirSync(calls);
  assert.deepEqual(records.map((name) => name.replace(/^launch-\d+-[0-9a-f-]+/, "launch")).sort(), ["launch.json", "launch.json.group"]);
  const group = readJson(join(calls, records.find((name) => name.endsWith(".group"))));
  assert.doesNotThrow(() => process.kill(group.pid, 0), "the provider's command is still running");
  fx.clearCalls();
  assert.equal(await answerOf(fx, "stop", home), "stopped");
  assert.throws(() => process.kill(-group.pid, 0), { code: "ESRCH" }, "no process of its group is left");
  assert.deepEqual([callsOf(fx), stateOf(home), existsSync(calls)], [["stop:null"], "planned", false]);
  await new Promise((r) => setTimeout(r, 3000));
  assert.deepEqual([existsSync(late), existsSync(join(fx.fake, "threads"))], [false, false], "the launch never completed");
});

test("an input whose kernel was killed is ended with its process group before a retire's stop: it restarts nothing after the home is gone", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("i");
  const late = join(fx.fake, "late-input");
  fx.control({ i: { input: { sleepMs: 2500, late } } });
  fx.clearCalls();
  const core = join(HERE, "..", "lib", "core.mjs");
  const child = spawn(process.execPath, ["--input-type=module", "-e", `const { inputInstanceSession } = await import(${JSON.stringify(core)}); inputInstanceSession(${JSON.stringify(home)}, "a mail");`], { cwd: fx.dep, env: fx.env, stdio: "ignore" });
  const done = new Promise((resolve) => child.on("close", resolve));
  for (let i = 0; i < 200 && !fx.verbs("input").length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(fx.verbs("input").length, 1, "the provider's input is in flight");
  child.kill("SIGKILL");
  await done;
  const started = Date.now();
  const retired = JSON.parse(fx.cli(["retire", "i", "--json"]).stdout);
  assert.deepEqual([retired.retired, existsSync(home)], ["i", false], JSON.stringify(retired).slice(0, 400));
  assert.ok(Date.now() - started < 20_000, "a dead kernel's input is not waited for");
  assert.deepEqual(callsOf(fx).filter((c) => c.startsWith("stop")), ["stop:E"]);
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(existsSync(late), false, "the input never completed");
});

test("a provider's command that outlasts its timeout is ended with its whole process group", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("slow");
  const late = join(fx.fake, "late-stop");
  fx.control({ slow: { inspect: { sleepMs: 4000, late } } });
  const answered = JSON.parse(fx.cli(["session", "inspect", "--home", home, "--json"], { env: { OATS_TEST_SESSION_PROVIDER_TIMEOUT_MS: "500" } }).stdout);
  assert.equal(answered.error?.code, "E_SESSION_UNAVAILABLE", JSON.stringify(answered).slice(0, 300));
  await new Promise((r) => setTimeout(r, 4500));
  assert.equal(existsSync(late), false, "the command did not go on after its timeout");
});

// ---------------------------------------------------------------- what a settle requires
// A settle records the home stopped: never over a session at the recorded endpoint that the
// provider did not confirm stopped, whichever verb settles.
test("a resent home is not settled while the stop of its recorded session is not confirmed, whichever verb asks", async (t) => {
  const fx = providerDeployment(t);
  fx.controls = {};
  const failing = (name) => { fx.controls = { ...fx.controls, [name]: { "stop:E": { exit: 1 } } }; fx.control(fx.controls); };
  for (const [state, verb] of [["resent (not stopped)", "stop"], ["resent (stopped)", "stop"], ["resent (not stopped)", "start"]]) {
    const name = `r${state.includes("not") ? "n" : "s"}${verb}`;
    const home = await STATES[state](fx, name);
    failing(name);
    fx.clearCalls();
    assert.equal(await answerOf(fx, verb, home), "E_SESSION_STOP_FAILED", `${verb} of ${state}`);
    assert.deepEqual([callsOf(fx, home).filter((c) => c !== "inspect"), stateOf(home)], [["stop:E"], "resent"], `${verb} of ${state}: the launch stays marked`);
  }
  // The host's stop of a home that is stopped already asks nothing of its own: the settle asks.
  const home = await STATES["resent (stopped)"](fx, "host");
  const hostStop = () => spawnSync(process.execPath, [HOST_STOP_CHILD, home, "20000"], { cwd: fx.dep, env: fx.env, encoding: "utf8" });
  failing("host");
  fx.clearCalls();
  assert.equal(JSON.parse(hostStop().stdout.trim().split("\n").pop()).code, "E_SESSION_STOP_FAILED");
  assert.deepEqual([callsOf(fx, home), stateOf(home)], [["stop:E"], "resent"]);
  const { host: _fixed, ...rest } = fx.controls; fx.controls = rest; fx.control(fx.controls);
  fx.clearCalls();
  assert.equal(JSON.parse(hostStop().stdout.trim().split("\n").pop()).ok, true);
  assert.deepEqual([callsOf(fx, home), stateOf(home)], [["stop:E", "stop:null"], "stopped"]);
});

test("a retire of a resent home whose recorded session is not confirmed stopped asks for both stops, records nothing, and goes on with a warning", async (t) => {
  const fx = providerDeployment(t);
  fx.controls = {};
  const home = await STATES["resent (not stopped)"](fx, "gone");
  fx.control({ gone: { "stop:E": { exit: 1 } } });
  fx.clearCalls();
  const retired = JSON.parse(fx.cli(["retire", "gone", "--json"]).stdout);
  assert.deepEqual([retired.retired, existsSync(home), callsOf(fx, home)], ["gone", false, ["stop:E", "stop:null"]], JSON.stringify(retired).slice(0, 400));
  assert.match(JSON.stringify(retired.warnings), /was not stopped through its session backend/);
});

// ---------------------------------------------------------------- calls a kernel left behind
test("an input admitted before a stop, whose kernel is killed while the stop waits for it, is ended before the provider is asked: it restarts nothing afterwards", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("w");
  const late = join(fx.fake, "late-input");
  fx.control({ w: { input: { sleepMs: 3000, late } } });
  fx.clearCalls();
  const core = join(HERE, "..", "lib", "core.mjs");
  const input = spawn(process.execPath, ["--input-type=module", "-e", `const { inputInstanceSession } = await import(${JSON.stringify(core)}); inputInstanceSession(${JSON.stringify(home)}, "a mail");`], { cwd: fx.dep, env: fx.env, stdio: "ignore" });
  const inputDone = new Promise((resolve) => input.on("close", resolve));
  for (let i = 0; i < 200 && !fx.verbs("input").length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(fx.verbs("input").length, 1, "the provider's input is in flight");
  // The stop records `stoppedAt` and waits for the input, whose kernel is alive.
  const stop = spawn(process.execPath, [HOST_STOP_CHILD, home, "20000"], { cwd: fx.dep, env: fx.env, stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  stop.stdout.on("data", (chunk) => { out += chunk; });
  const stopDone = new Promise((resolve) => stop.on("close", resolve));
  for (let i = 0; i < 200 && stateOf(home) !== "stopped"; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual([stateOf(home), fx.verbs("stop").length], ["stopped", 0], "stopped is recorded, and the provider is not asked while the input is in flight");
  input.kill("SIGKILL");
  await inputDone;
  await stopDone;
  assert.equal(JSON.parse(out.trim().split("\n").pop()).ok, true, out);
  assert.deepEqual(callsOf(fx, home).filter((c) => c.startsWith("stop")), ["stop:E"]);
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(existsSync(late), false, "the input's command was ended: it did nothing after the stop");
});

test("a launch whose kernel died before its command's group recorded itself is made void: the leader that comes late runs nothing", async (t) => {
  const fx = providerDeployment(t);
  const calls = join(fx.root, "dev", "instances", ".oats-retirement", "provider-calls", "v");
  const child = spawn(process.execPath, [CLI, ...SPAWN("v")], { cwd: fx.dep, env: { ...fx.env, OATS_TEST_PROVIDER_LEADER_DELAY_MS: "3000" }, stdio: "ignore" });
  const done = new Promise((resolve) => child.on("close", resolve));
  const records = () => (existsSync(calls) ? readdirSync(calls) : []);
  for (let i = 0; i < 400 && !records().some((name) => name.startsWith("launch-")); i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(records().map((name) => name.replace(/^launch-\d+-[0-9a-f-]+/, "launch")), ["launch.json"], "the call is recorded, its group not yet");
  child.kill("SIGKILL");
  await done;
  const home = homeOf(fx, "v");
  fx.clearCalls();
  assert.equal(await answerOf(fx, "stop", home), "stopped");
  assert.deepEqual([callsOf(fx), stateOf(home), existsSync(calls)], [["stop:null"], "planned", false]);
  // The leader wakes after the settle took its records away, and finds no call to run.
  await new Promise((r) => setTimeout(r, 4000));
  assert.deepEqual([fx.verbs("launch").length, existsSync(join(fx.fake, "threads")), existsSync(calls)], [0, false, false]);
});

test("a stop whose kernel was killed while the provider stopped is ended before a resume sends its notice: it does not stop the resumed session", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("hs");
  const late = join(fx.fake, "late-stop");
  fx.control({ hs: { stop: { sleepMs: 3000, late } } });
  fx.clearCalls();
  const child = spawn(process.execPath, [HOST_STOP_CHILD, home, "20000"], { cwd: fx.dep, env: fx.env, stdio: "ignore" });
  const done = new Promise((resolve) => child.on("close", resolve));
  for (let i = 0; i < 200 && !fx.verbs("stop").length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(fx.verbs("stop").length, 1, "the provider's stop is in flight");
  child.kill("SIGKILL");
  await done;
  fx.clearCalls();
  assert.equal(await answerOf(fx, "resume", home), "resumed");
  assert.deepEqual([callsOf(fx, home), stateOf(home)], [["input"], "running"]);
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(existsSync(late), false, "the stop's command was ended: it did nothing after the resume");
});

test("a spawn's rollback killed between its two writes leaves the launch marked: unsettled, and a retire takes the home", async (t) => {
  const fx = providerDeployment(t);
  fx.control({ rb: { launch: { exit: 1 } } });
  const died = spawnSync(process.execPath, [CLI, ...SPAWN("rb")], { cwd: fx.dep, env: { ...fx.env, OATS_TEST_PROVIDER_DIE_AT: "rollback:record-written" }, encoding: "utf8" });
  assert.equal(died.signal, "SIGKILL", `${died.stdout}${died.stderr}`);
  const home = homeOf(fx, "rb");
  assert.deepEqual([callsOf(fx, home), stateOf(home), recordOf(home).launched], [["launch", "stop:null"], "sent", false]);
  fx.control({});
  fx.clearCalls();
  assert.equal(await answerOf(fx, "retire", home), "retired");
  assert.deepEqual([callsOf(fx, home), stateOf(home)], [["stop:null"], "gone"]);
});

test("a provider home's spawn holds the home's claim from before its record, launched or not", async (t) => {
  const fx = providerDeployment(t);
  const died = spawnSync(process.execPath, [CLI, "spawn", "dev", "--name", "scaffold", "--backend", "fake", "--launch-config", "claude", "--no-launch", "--work", "directory", "--json"], { cwd: fx.dep, env: { ...fx.env, OATS_TEST_PROVIDER_DIE_AT: "spawn:record-written" }, encoding: "utf8" });
  assert.equal(died.signal, "SIGKILL", `${died.stdout}${died.stderr}`);
  const home = homeOf(fx, "scaffold");
  // The record is published, and the claim was the spawn's: no start could run beside it.
  assert.deepEqual([recordOf(home).launched, readJson(join(dirname(home), ".oats-retirement", "claims", "scaffold.lock")).action], [false, "start"]);
});

test("a spawn that reuses the name of a retired home is never paired with that home's receipt: ended right after its record, it is a planned home", async (t) => {
  const fx = providerDeployment(t);
  const first = await fx.launch("twice", { work: "worktree" });
  assert.equal(JSON.parse(fx.cli(["retire", "twice", "--json"]).stdout).retired, "twice");
  assert.equal(existsSync(receiptPath(first.home)), true, "the retire keeps the receipt of the home it removed");
  const died = spawnSync(process.execPath, [CLI, ...SPAWN("twice").slice(0, -1), "--work", "worktree", "--branch", "agents/twice-again", "--json"], { cwd: fx.dep, env: { ...fx.env, OATS_TEST_PROVIDER_DIE_AT: "spawn:record-written" }, encoding: "utf8" });
  assert.equal(died.signal, "SIGKILL", `${died.stdout}${died.stderr}`);
  // The receipt is the new spawn's own, written before its record: planned, not the launched one of the home before.
  assert.deepEqual([stateOf(first.home), runtimeOf(first.home), recordOf(first.home).launched], ["planned", { launched: false, backend: "fake", provider: FAKE_CAPABILITY }, false]);
  fx.clearCalls();
  assert.equal(await answerOf(fx, "start", first.home), "launched");
  assert.deepEqual([callsOf(fx, first.home), stateOf(first.home)], [["launch"], "running"]);
});

test("a call's records are published whole: a writer that ended before its record's name was made leaves nothing a verb waits on", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("whole");
  const calls = join(dirname(home), ".oats-retirement", "provider-calls", "whole");
  // A call of a kernel that is gone, and the file of a leader that ended before it published its group.
  mkdirSync(calls, { recursive: true });
  writeFileSync(join(calls, "launch-999999-00000000-0000-4000-8000-000000000000.json"), JSON.stringify({ verb: "launch", pid: 999999, processStart: "never", startedAt: SENT_AT }));
  writeFileSync(join(calls, "launch-999999-00000000-0000-4000-8000-000000000000.json.group.999998.tmp"), "");
  fx.clearCalls();
  assert.equal(await answerOf(fx, "stop", home), "stopped");
  assert.deepEqual([callsOf(fx, home), readdirSync(calls).filter((name) => !name.endsWith(".tmp"))], [["stop:E"], []]);
});

test("a retire that cannot record its stop does not ask the provider, and retires nothing", { skip: typeof process.getuid === "function" && process.getuid() === 0 ? "root writes where a mode forbids it" : false }, async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("unfenced");
  const receipts = dirname(receiptPath(home));
  chmodSync(receipts, 0o500);
  t.after(() => { if (existsSync(receipts)) chmodSync(receipts, 0o700); }); // (the fixture may have removed it by then)
  fx.clearCalls();
  const refused = JSON.parse(fx.cli(["retire", "unfenced", "--json"]).stdout);
  chmodSync(receipts, 0o700);
  assert.deepEqual([refused.error?.code, existsSync(home), callsOf(fx, home).filter((c) => c.startsWith("stop")), stateOf(home)], ["E_RUNTIME_QUIESCE_FAILED", true, [], "running"], JSON.stringify(refused).slice(0, 400));
});

test("a spawn's record says it completed only after its launch's mark is gone: ended one write earlier, it is not a spawn a same-key retry replays", async (t) => {
  const fx = providerDeployment(t);
  const died = spawnSync(process.execPath, [CLI, ...SPAWN("keyed").slice(0, -1), "--idempotency-key", "keyed-1", "--json"], { cwd: fx.dep, env: { ...fx.env, OATS_TEST_PROVIDER_DIE_AT: "spawn:recorded" }, encoding: "utf8" });
  assert.equal(died.signal, "SIGKILL", `${died.stdout}${died.stderr}`);
  const home = homeOf(fx, "keyed");
  assert.deepEqual([stateOf(home), recordOf(home).spawnCompleted], ["resent", false]);
});

test("a read of a home while it is being spawned answers that its session is not recorded yet, never that its records disagree", async (t) => {
  const fx = providerDeployment(t);
  // A directory home has its receipt (planned on the provider) before its spawn's hooks run, and
  // its record after them: a read from a hook, or beside it, falls in between.
  const died = spawnSync(process.execPath, [CLI, ...SPAWN("early").slice(0, -1), "--work", "directory", "--json"], { cwd: fx.dep, env: { ...fx.env, OATS_TEST_PROVIDER_DIE_AT: "spawn:hooks" }, encoding: "utf8" });
  assert.equal(died.signal, "SIGKILL", `${died.stdout}${died.stderr}`);
  const home = homeOf(fx, "early");
  assert.deepEqual([runtimeOf(home), recordOf(home).backend, recordOf(home).session], [{ launched: false, backend: "fake", provider: FAKE_CAPABILITY }, undefined, undefined]);
  const inspected = JSON.parse(fx.cli(["session", "inspect", "--home", home, "--json"]).stdout);
  assert.deepEqual([inspected.ok, inspected.error.code], [false, "E_SESSION_UNAVAILABLE"], JSON.stringify(inspected).slice(0, 300));
  assert.match(inspected.error.message, /early is being spawned: its session is planned on fake, and its record is not written yet/);
  const row = JSON.parse(fx.cli(["status", "--json"]).stdout).agents.flatMap((a) => a.instances).find((r) => r.instance === "early");
  assert.notEqual(row?.runtimeErrorCode ?? row?.runtimeError, "E_RUNTIME_AUTHORITY_MISMATCH");
  assert.equal(JSON.stringify(row ?? {}).includes("E_RUNTIME_AUTHORITY_MISMATCH"), false, JSON.stringify(row).slice(0, 400));
  assert.deepEqual(fx.calls(), [], "no hook ran and the provider was never called");
});
