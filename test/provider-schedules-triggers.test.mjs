// Schedules and triggers on a session provider (docs/schedules.md "Kinds" and "Triggers";
// docs/execution-targets.md "Session providers"): a scheduled wake is the input of a provider
// home's session (and starts one OATS stopped, as it starts a tmux home), and a scheduled or a
// triggered spawn launches through the provider it names.
// The ticks are the host's own, in process; every spawn is the real `oats spawn` the tick runs as
// its child; the provider is the fake one (test/helpers/session-provider-fixture.mjs), a real
// script the kernel runs. For the spawns it comes from a package and refuses at its `check` a
// launch that is not in full mode, as a provider that never sandboxes does.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectInstanceSession, retireClaimPath, stopInstanceSession } from "../lib/core.mjs";
import { processStartToken } from "../lib/worktree-hooks.mjs";
import { setWaiting } from "../lib/instance-events.mjs";
import { writeLock } from "../lib/packages.mjs";
import { contentDigest } from "../lib/remote.mjs";
import { git } from "./helpers/v2-deployment.mjs";
import { FAKE_CAPABILITY, FAKE_SERVER, FULL_ONLY, fakeFiles, fakeManifest, fakeProvider, providerDeployment, sessionsOf } from "./helpers/session-provider-fixture.mjs";
import { capabilityManifest, sourceScript } from "./helpers/trigger-source-fixture.mjs";

const S = await import("../lib/schedule.mjs");
const T = await import("../lib/triggers.mjs");
const answer = (r) => { const doc = r.json(); assert.equal(doc.ok, true, r.stdout + r.stderr); return doc.result; };
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
/** The host's tick of the deployment's schedules at `iso`, in process, with the fixture's PATH (its
 *  inert harnesses): each row it considered. */
const scheduleTick = (fx, iso, reg = {}, io = undefined) => fx.inEnv(() => {
  const path = process.env.PATH;
  process.env.PATH = fx.env.PATH;
  try { return S.withHostLock(() => S.tickWorkspace(fx.dep, { now: new Date(iso), reg: { ...S.readRegistry(), ...reg }, wsList: [fx.dep], ...(io ? { io } : {}) })); } finally { process.env.PATH = path; }
});
/** The host's tick of the deployment's triggers at `iso`, the same way. */
const triggerTick = (fx, iso) => fx.inEnv(() => {
  const path = process.env.PATH;
  process.env.PATH = fx.env.PATH;
  try { return T.tickTriggers(fx.dep, { now: new Date(iso) }); } finally { process.env.PATH = path; }
});
const lastRun = (fx, id) => answer(fx.cli(["schedule", "show", id, "--json"])).schedule.lastRun;
/** The homes of soul `dev` there are, by name. */
const homesOf = (fx) => { const dir = join(fx.root, "dev", "instances"); return existsSync(dir) ? readdirSync(dir).filter((name) => !name.startsWith(".")).sort() : []; };

test("a scheduled wake to a running provider home is delivered once as the session's input; a waiting claim holds it with no input; an input the provider refuses stays pending and is delivered at the next tick", async (t) => {
  const fx = providerDeployment(t);
  fx.control({ stateful: true });
  const { home } = await fx.launch("listener");
  const thread = fx.events().find((e) => e.ev === "created").thread;
  const endpoint = { server: FAKE_SERVER, threadId: thread };
  const message = "Scheduled check: read your inbox, then go on.";
  answer(fx.cli(["schedule", "add", "--spec-json", JSON.stringify({ id: "nudge", kind: "wake", cron: "* * * * *", tz: "UTC", home, message }), "--json"]));
  const inputs = () => fx.verbs("input").map((c) => [c.instance, c.backend, c.request.input.endpoint, c.request.input.text]);
  const delivered = () => fx.events().filter((e) => e.ev === "input").map((e) => e.thread);
  const rowOf = (considered) => considered.find((row) => row.id === "nudge");
  fx.clearCalls();

  // Due and running: one input, the wake's message, to the session the launch answered.
  const first = rowOf(await scheduleTick(fx, "2026-11-23T10:00:05Z"));
  assert.deepEqual([first.action, first.pending, first.reason], ["delivered", false, undefined], JSON.stringify(first));
  assert.deepEqual(inputs(), [["listener", "fake", endpoint, message]]);
  assert.deepEqual(delivered(), [thread]);
  let run = lastRun(fx, "nudge");
  assert.deepEqual([run.outcome, run.kind, run.pending, run.home, run.scheduledFor], ["delivered", "wake", false, home, "2026-11-23T10:00:00.000Z"], JSON.stringify(run));
  // Once: a later tick of the same minute sends nothing.
  assert.equal(rowOf(await scheduleTick(fx, "2026-11-23T10:00:40Z")), undefined);
  assert.equal(inputs().length, 1);
  assert.deepEqual(fx.hooks(), [], "a wake launches nothing");

  // A waiting claim holds the wake: skipped, pending, and the provider is sent no input.
  setWaiting(home, { producer: "oats.core", waiting: true, reason: "permission", message: "Claude needs your permission to use Bash" });
  fx.clearCalls();
  const held = rowOf(await scheduleTick(fx, "2026-11-23T10:01:05Z"));
  assert.deepEqual([held.action, held.reason, held.pending, held.held.claimReason, held.held.producer], ["skipped", "waiting-on-you", true, "permission", "oats.core"], JSON.stringify(held));
  assert.deepEqual(inputs(), [], "no input while the claim holds");
  run = lastRun(fx, "nudge");
  assert.deepEqual([run.outcome, run.reason, run.pending], ["skipped", "waiting-on-you", true], JSON.stringify(run));
  // Still held at a later tick; released, the pending message is delivered once.
  assert.equal(rowOf(await scheduleTick(fx, "2026-11-23T10:01:40Z")).reason, "waiting-on-you");
  assert.deepEqual(inputs(), []);
  setWaiting(home, { producer: "oats.core", waiting: false });
  const released = rowOf(await scheduleTick(fx, "2026-11-23T10:02:05Z"));
  assert.deepEqual([released.action, released.pending], ["delivered", false], JSON.stringify(released));
  assert.deepEqual(inputs(), [["listener", "fake", endpoint, message]]);
  assert.equal(delivered().length, 2);

  // The provider refuses the input (its session shows a prompt): nothing was sent, the wake stays pending.
  fx.control({ stateful: true, input: { error: { code: "E_SESSION_PROMPT_OPEN", message: "the session has a prompt open" } } });
  fx.clearCalls();
  const refused = rowOf(await scheduleTick(fx, "2026-11-23T10:03:05Z"));
  assert.deepEqual([refused.action, refused.pending], ["skipped", true], JSON.stringify(refused));
  assert.match(refused.reason, /^input refused: .*the session has a prompt open/);
  run = lastRun(fx, "nudge");
  assert.deepEqual([run.outcome, run.errorCode, run.pending, run.scheduledFor], ["skipped", "E_SESSION_PROMPT_OPEN", true, "2026-11-23T10:03:00.000Z"], JSON.stringify(run));
  assert.equal(inputs().length, 1, "the provider was asked once");
  assert.equal(delivered().length, 2, "and took no input");
  // The next due minute: the provider takes it. One delivery for the two minutes, never two.
  fx.control({ stateful: true });
  fx.clearCalls();
  const next = rowOf(await scheduleTick(fx, "2026-11-23T10:04:05Z"));
  assert.deepEqual([next.action, next.pending], ["delivered", false], JSON.stringify(next));
  assert.deepEqual(inputs(), [["listener", "fake", endpoint, message]]);
  assert.equal(delivered().length, 3);
  run = lastRun(fx, "nudge");
  assert.deepEqual([run.outcome, run.pending, run.completedPending, run.pendingSince], ["delivered", false, true, "2026-11-23T10:03:00.000Z"], JSON.stringify(run));
  assert.equal(rowOf(await scheduleTick(fx, "2026-11-23T10:04:40Z")), undefined);
  assert.equal(inputs().length, 1);
  assert.equal(sessionsOf(fx.events()).get(thread).running, true);
  assert.equal((await fx.inEnv(() => inspectInstanceSession(home))).running, true);
});

// KP-1 (oats-project/oats#2122): a due wake starts a provider home OATS stopped, by the rule of a
// stopped tmux home. The start is the real `oats session start` the tick runs as its child.
const addWake = (fx, id, home, message, cron = "* * * * *") => answer(fx.cli(["schedule", "add", "--spec-json", JSON.stringify({ id, kind: "wake", cron, tz: "UTC", home, message }), "--json"]));
const rowIn = (considered, id) => considered.find((row) => row.id === id);
/** What the provider was asked for one instance, in order: the verbs, never an inspect. */
const askedOf = (fx, instance) => fx.verbs().filter((c) => c.instance === instance && !["inspect", "inspectMany"].includes(c.verb)).map((c) => c.verb);
const threadsOf = (fx, instance) => [...sessionsOf(fx.events())].filter(([, session]) => session.home === instance).map(([thread, session]) => [thread, session.running]);

test("KP-1: the kernel announces it: feature wake-starts-provider-home", async () => {
  const { KERNEL_FEATURES, WAKE_STARTS_PROVIDER_HOME_FEATURE } = await import("../lib/kernel-features.mjs");
  assert.equal(WAKE_STARTS_PROVIDER_HOME_FEATURE, "wake-starts-provider-home");
  assert.ok(KERNEL_FEATURES.includes("wake-starts-provider-home"));
});

test("KP-1: a wake due for a provider home OATS stopped starts it, a plain start in a new session, and its text is delivered once the session runs; a later tick sends nothing more", async (t) => {
  const fx = providerDeployment(t);
  fx.control({ stateful: true });
  const { home } = await fx.launch("sleeper");
  const [[first]] = threadsOf(fx, "sleeper");
  const message = "Scheduled check: read your inbox, then go on.";
  addWake(fx, "nudge", home, message);
  await fx.inEnv(() => stopInstanceSession(home, {}));
  assert.deepEqual(threadsOf(fx, "sleeper"), [[first, false]], "stopped by OATS");
  // (A command that reads the workspace brings it to this host: what a start then resolves the
  // deployment's configuration from, without reaching a remote.)
  assert.equal(fx.cli(["spawn", "dev", "--backend", "fake", "--launch-config", "claude", "--preview", "--json"]).status, 0);
  fx.clearCalls();

  // Due: started. No input yet, and no resume: a launch, of a new session.
  const started = rowIn(await scheduleTick(fx, "2026-11-23T10:00:05Z"), "nudge");
  assert.deepEqual([started.action, started.pending, started.reason], ["started", true, "session was stopped; the message is pending until the session is active"], JSON.stringify(started));
  assert.deepEqual(askedOf(fx, "sleeper"), ["stop", "launch"], "the stop a start of a stopped home asks once more, then the launch: no input");
  assert.deepEqual(fx.hooks("launch").map((h) => h.instance), ["sleeper"], "the launch hooks ran, as at any start");
  const launch = fx.verbs("launch")[0].request.input;
  assert.deepEqual([launch.previous, launch.promptFile], [{ server: FAKE_SERVER, threadId: first }, join(home, "TASK.md")], "a plain start on TASK.md: the earlier session is only named as the previous one");
  // The start is `oats session start`, the tick's child: the one way the launch is handed the
  // deployment's configuration as it is now (the sandbox allowances). A start made in the tick's
  // own process could not resolve it, and its launch would say `sandbox: { unavailable }`, which
  // a provider that sandboxes refuses.
  assert.deepEqual(launch.sandbox, { domains: [], write: [{ path: join(realpathSync(fx.dep), ".agents", "events"), reason: "oats events" }], missing: [] }, "the allowances are resolved, as a person's start resolves them");
  const threads = threadsOf(fx, "sleeper");
  assert.equal(threads.length, 2);
  const second = threads.find(([thread]) => thread !== first)[0];
  assert.deepEqual(Object.fromEntries(threads), { [first]: false, [second]: true }, "a new session runs; the stopped one stays stopped");
  let run = lastRun(fx, "nudge");
  assert.deepEqual([run.outcome, run.kind, run.pending, run.home, run.instance, run.target, run.startedHarness, run.session.delivery], ["started", "wake", true, home, "sleeper", null, true, "launched"], JSON.stringify(run));
  // The job holds its launch slot across the child's start, for the harness it started, as a tmux wake's does.
  const slot = await fx.inEnv(() => S.jobLockInfo(fx.dep, "nudge"));
  assert.deepEqual([slot?.home, slot?.wake], [home, true], JSON.stringify(slot));
  // And the start's own claim and lock are released: nothing is left held on the home.
  assert.equal(existsSync(retireClaimPath(home)), false, "the child's lifecycle claim is gone");
  assert.equal(existsSync(join(home, ".oats-start.lock")), false, "and so is its start lock");

  // The next tick: the session runs, and the text is delivered to it, once.
  fx.clearCalls();
  const delivered = rowIn(await scheduleTick(fx, "2026-11-23T10:00:40Z"), "nudge");
  assert.deepEqual([delivered.action, delivered.pending], ["delivered", false], JSON.stringify(delivered));
  assert.deepEqual(fx.verbs("input").map((c) => [c.request.input.endpoint.threadId, c.request.input.text]), [[second, message]], "to the new session");
  assert.deepEqual(askedOf(fx, "sleeper"), ["input"]);
  run = lastRun(fx, "nudge");
  assert.deepEqual([run.outcome, run.pending], ["delivered", false], JSON.stringify(run));
  assert.equal((await fx.inEnv(() => inspectInstanceSession(home))).running, true);
  assert.equal((await fx.inEnv(() => S.jobLockInfo(fx.dep, "nudge")))?.home, home, "the started harness keeps the slot while it runs");
  // The next due minute, running: a delivery, and nothing is started.
  fx.clearCalls();
  assert.equal(rowIn(await scheduleTick(fx, "2026-11-23T10:01:05Z"), "nudge").action, "delivered");
  assert.deepEqual(askedOf(fx, "sleeper"), ["input"]);
});

test("KP-1: the guards are a tmux wake's: not before the due minute; no launch slot; a claim that refuses the start; a start its provider refuses", async (t) => {
  const fx = providerDeployment(t, { manifest: fakeManifest({ fake: fakeProvider({ check: true }) }) });
  fx.control({ stateful: true });
  const hourly = await fx.launch("hourly"), other = await fx.launch("other");
  addWake(fx, "hourly", hourly.home, "hourly check", "0 * * * *");

  // 1. Not before the due minute. A wake that became pending while the home ran (held by a claim)
  // does not start the home once it is stopped: it waits for its next due minute.
  setWaiting(hourly.home, { producer: "oats.core", waiting: true, reason: "question", message: "Which one?" });
  assert.equal(rowIn(await scheduleTick(fx, "2026-11-23T10:00:05Z"), "hourly").reason, "waiting-on-you");
  await fx.inEnv(() => stopInstanceSession(hourly.home, {}));
  fx.clearCalls();
  const early = rowIn(await scheduleTick(fx, "2026-11-23T10:01:05Z"), "hourly");
  assert.deepEqual([early.action, early.pending, early.reason], ["skipped", true, "session stopped; it is started again only at the next due minute; delivery pending"], JSON.stringify(early));
  assert.deepEqual(askedOf(fx, "hourly"), [], "nothing was started");

  // 2. No launch slot: with one slot and another job's started harness holding it, the wake waits.
  addWake(fx, "other", other.home, "other check");
  await fx.inEnv(() => stopInstanceSession(other.home, {}));
  fx.clearCalls();
  const one = await scheduleTick(fx, "2026-11-23T11:00:05Z", { maxConcurrent: 1 });
  const byId = Object.fromEntries(one.map((row) => [row.id, row]));
  const [took, waited] = byId.hourly.action === "started" ? ["hourly", "other"] : ["other", "hourly"];
  assert.deepEqual([byId[took].action, byId[waited].action, byId[waited].pending], ["started", "skipped", true], JSON.stringify(one));
  assert.match(byId[waited].reason, /^host busy: starting this session needs a launch slot; delivery pending$/);
  assert.deepEqual([askedOf(fx, took), askedOf(fx, waited)], [["check", "stop", "launch"], []], "one start, with its check first; the other was not touched");

  // 3. A claim on the home refuses the start before any effect: a skip, pending, no slot kept.
  const [late, lateHome] = waited === "hourly" ? ["hourly", hourly.home] : ["other", other.home];
  const claim = retireClaimPath(lateHome);
  mkdirSync(dirname(claim), { recursive: true });
  writeFileSync(claim, `${JSON.stringify({ action: "upgrade", pid: process.pid, processStart: await fx.inEnv(() => processStartToken(process.pid)), nonce: "c".repeat(32), at: new Date().toISOString() })}\n`);
  fx.clearCalls();
  const claimed = rowIn(await scheduleTick(fx, "2026-11-23T12:00:05Z"), late);
  assert.deepEqual([claimed.action, claimed.pending], ["skipped", true], JSON.stringify(claimed));
  assert.equal(claimed.reason, "start refused before any effect: an upgrade of the home is running (E_LIFECYCLE_BUSY); the session is started again at the next due minute; delivery pending");
  assert.deepEqual([lastRun(fx, late).errorCode, lastRun(fx, late).startedHarness], ["E_LIFECYCLE_BUSY", undefined]);
  assert.deepEqual(askedOf(fx, late), [], "the provider was asked nothing");
  assert.equal(await fx.inEnv(() => S.jobLockInfo(fx.dep, late)), null, "no slot is held for a start that had no effect");
  // A retire of the home refuses it the same way, by its own code.
  writeFileSync(claim, `${JSON.stringify({ action: "retire", pid: process.pid, processStart: await fx.inEnv(() => processStartToken(process.pid)), nonce: "d".repeat(32), at: new Date().toISOString() })}\n`);
  fx.clearCalls();
  const retiring = rowIn(await scheduleTick(fx, "2026-11-23T13:00:05Z"), late);
  assert.deepEqual([retiring.action, retiring.pending, lastRun(fx, late).errorCode], ["skipped", true, "E_INSTANCE_RETIRING"], JSON.stringify(retiring));
  assert.equal(retiring.reason, "start refused before any effect: the home is being retired (E_INSTANCE_RETIRING); the session is started again at the next due minute; delivery pending");
  assert.deepEqual(askedOf(fx, late), []);
  assert.equal(await fx.inEnv(() => S.jobLockInfo(fx.dep, late)), null);
  rmSync(claim);

  // 4. A start its provider refuses at its check: recorded with the provider's code, pending,
  // nothing launched; the slot is kept until the home is seen stopped, as for a tmux start that failed.
  fx.control({ stateful: true, check: { result: { status: "unavailable", problems: [{ code: "E_BACKEND_SANDBOXED_MODE", message: "this provider launches only in full mode" }] } } });
  fx.clearCalls();
  const refused = rowIn(await scheduleTick(fx, "2026-11-23T14:00:05Z"), late);
  assert.deepEqual([refused.action, refused.pending], ["skipped", true], JSON.stringify(refused));
  assert.deepEqual([lastRun(fx, late).errorCode, lastRun(fx, late).startedHarness], ["E_BACKEND_SANDBOXED_MODE", "unconfirmed"]);
  assert.match(refused.reason, /^start did not complete \(E_BACKEND_SANDBOXED_MODE\): .*this provider launches only in full mode.*nothing was stopped or started; the slot is kept until the session is observed stopped or absent$/);
  assert.deepEqual(askedOf(fx, late), ["check"], "its check, and no launch");
  // The provider takes it again: the next due minute starts it.
  fx.control({ stateful: true });
  fx.clearCalls();
  const then = rowIn(await scheduleTick(fx, "2026-11-23T15:00:05Z"), late);
  assert.equal(then.action, "started", JSON.stringify(then));
  assert.deepEqual(askedOf(fx, late), ["check", "stop", "launch"]);
});

test("KP-1: a wake's start whose child times out, or answers nothing, is unconfirmed whatever it printed: skipped, pending, and the job keeps its slot until the home is seen stopped", async (t) => {
  const fx = providerDeployment(t);
  fx.control({ stateful: true });
  const { home } = await fx.launch("slow");
  addWake(fx, "slow", home, "wake up", "0 * * * *");
  await fx.inEnv(() => stopInstanceSession(home, {}));
  // A stand-in for `oats`: it answers a start's success and does not end (a child that hangs
  // after its work), or it ends with no answer at all.
  const hangs = join(fx.base, "oats-that-hangs.mjs"), silent = join(fx.base, "oats-that-says-nothing.mjs");
  writeFileSync(hangs, `process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: true, result: { instance: "slow", target: null, warnings: [] } }) + "\\n");\nsetInterval(() => {}, 1000);\n`);
  writeFileSync(silent, "process.exit(1);\n");
  fx.clearCalls();
  const timedOut = rowIn(await scheduleTick(fx, "2026-11-23T10:00:05Z", {}, { oatsBin: hangs, commandTimeoutMs: 400, commandGraceMs: 100 }), "slow");
  assert.deepEqual([timedOut.action, timedOut.pending], ["skipped", true], JSON.stringify(timedOut));
  assert.equal(timedOut.reason, "start did not complete (error): oats session start timed out; whether the session was started is not known; the slot is kept until the session is observed stopped or absent");
  let run = lastRun(fx, "slow");
  assert.deepEqual([run.outcome, run.startedHarness, run.errorCode, run.pending], ["skipped", "unconfirmed", undefined, true], JSON.stringify(run));
  assert.equal((await fx.inEnv(() => S.jobLockInfo(fx.dep, "slow")))?.home, home, "the slot is kept: the start may have happened");
  assert.deepEqual(askedOf(fx, "slow"), [], "(the stand-in started nothing)");
  // The next tick sees the home still stopped: the slot is released, and the delivery is still pending.
  await scheduleTick(fx, "2026-11-23T10:01:05Z");
  assert.equal(await fx.inEnv(() => S.jobLockInfo(fx.dep, "slow")), null);
  // A child that answers nothing: the same, by its own words.
  const nothing = rowIn(await scheduleTick(fx, "2026-11-23T11:00:05Z", {}, { oatsBin: silent }), "slow");
  assert.deepEqual([nothing.action, nothing.pending], ["skipped", true], JSON.stringify(nothing));
  assert.equal(nothing.reason, "start did not complete (error): oats session start answered no valid envelope (exit 1); whether the session was started is not known; the slot is kept until the session is observed stopped or absent");
  assert.equal(lastRun(fx, "slow").startedHarness, "unconfirmed");
  // With the real command the next due minute starts it, and the message follows.
  await scheduleTick(fx, "2026-11-23T11:01:05Z");
  fx.clearCalls();
  assert.equal(rowIn(await scheduleTick(fx, "2026-11-23T12:00:05Z"), "slow").action, "started");
  assert.deepEqual(askedOf(fx, "slow"), ["stop", "launch"]);
});

test("KP-1: a provider home whose session is lost is not started by a wake: one gone without an OATS stop takes the wake as its input (its resume), and one stopped with the host stays pending for the resume", async (t) => {
  const fx = providerDeployment(t);
  fx.control({ stateful: true });
  // 1. The session ended by itself: OATS did not stop it.
  const gone = await fx.launch("gone");
  const [[thread]] = threadsOf(fx, "gone");
  addWake(fx, "gone", gone.home, "are you there?");
  fx.emit({ ev: "gone", thread });
  fx.clearCalls();
  const resumed = rowIn(await scheduleTick(fx, "2026-11-23T10:00:05Z"), "gone");
  assert.deepEqual([resumed.action, resumed.pending], ["delivered", false], JSON.stringify(resumed));
  assert.deepEqual(askedOf(fx, "gone"), ["input"], "the wake is the session's input: no launch");
  assert.deepEqual(threadsOf(fx, "gone"), [[thread, true]], "the same session, running again");

  // 2. Stopped with the host: OATS means it to run, in its own conversation. No start, no input.
  const hosted = await fx.launch("hosted");
  addWake(fx, "hosted", hosted.home, "back yet?");
  const child = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "host-stop-child.mjs");
  const stopped = spawnSync(process.execPath, [child, hosted.home, "20000"], { cwd: fx.dep, env: fx.env, encoding: "utf8" });
  assert.equal(JSON.parse(stopped.stdout.trim().split("\n").pop()).stopped, true, stopped.stdout + stopped.stderr);
  fx.clearCalls();
  const waiting = rowIn(await scheduleTick(fx, "2026-11-23T10:01:05Z"), "hosted");
  assert.deepEqual([waiting.action, waiting.pending], ["skipped", true], JSON.stringify(waiting));
  assert.match(waiting.reason, /^input refused: hosted was stopped by OATS; nothing was sent\./);
  assert.equal(lastRun(fx, "hosted").errorCode, "E_SESSION_NOT_RUNNING");
  assert.deepEqual(askedOf(fx, "hosted"), [], "neither started nor sent to");
});

const CHECKED = fakeManifest({ fake: fakeProvider({ check: true }) });
const SOURCE = "acme.graph:harvest-branches";
/** A deployment whose `dev` soul takes the fake provider FROM A PACKAGE, as a deployment takes a
 *  real one (a spawn's preview can ask a package's `check`; a member module's runs only from a
 *  home), and a member capability's trigger source (test/helpers/trigger-source-fixture.mjs). The
 *  provider launches only in full mode. */
function fullOnlyProvider(t) {
  const base = `oats-package/capabilities/${FAKE_CAPABILITY}`;
  const files = { "oats-package/oats-package.json": { json: { package: "acme.pkg", version: "1.0.0", capabilities: [`capabilities/${FAKE_CAPABILITY}`] } },
    [`${base}/oats.json`]: { json: { capability: FAKE_CAPABILITY, version: "1.0.0", description: "A fake session backend, packaged", ...CHECKED } },
    ...Object.fromEntries(Object.entries(fakeFiles()).map(([name, text]) => [`${base}/${name}`, text])) };
  const fx = providerDeployment(t, { files,
    // `full`: a launch configuration of the deployment that turns yolo on.
    local: { "launch-configs": { claude: { harness: "claude" }, full: { harness: "claude", yolo: true } } },
    capabilities: { "acme.graph": { manifest: capabilityManifest(), files: { "bin/source.mjs": sourceScript() } } },
    souls: { dev: { soul: { capabilities: { "oats.core": "off", [FAKE_CAPABILITY]: { from: "package" }, "acme.graph": { from: "here" } } } } } });
  fx.commit({ "oats-workspace.yaml": { yaml: { schemaVersion: 2, name: "acme", members: [fx.ref], defaults: { knowledge: "none", messaging: "none", tasks: "none" }, packages: { "acme.pkg": `git:${fx.key}@main` } } } });
  writeLock(fx.dep, { lockfileVersion: 3, packages: { "acme.pkg": { source: `git:${fx.key}@main`, url: fx.ref, path: "oats-package", version: "1.0.0", commit: git(fx.member, "rev-parse", "HEAD"), integrity: contentDigest(join(fx.member, "oats-package")), capabilities: [FAKE_CAPABILITY] } } });
  fx.control({ stateful: true, check: { fullOnly: true } });
  /** The events the trigger source answers from now on. */
  fx.source = (events) => { mkdirSync(join(fx.env.HOME, "tsf"), { recursive: true }); writeFileSync(join(fx.env.HOME, "tsf", "control.json"), JSON.stringify({ result: { events } })); };
  return fx;
}

const SPAWN = { kind: "spawn", cron: "* * * * *", tz: "UTC", agent: "dev", backend: "fake", launchConfig: "claude", task: "Do the nightly thing." };
const addSchedule = (fx, id, spec) => fx.cli(["schedule", "add", id, `--spec-json=${JSON.stringify(spec)}`, "--json"]);
/** What the provider was asked for one instance: each verb, and for a check the planned launch's `yolo`. */
const askedFor = (fx, instance) => fx.verbs().filter((c) => c.instance === instance).map((c) => (c.verb === "check" ? ["check", c.request.input.launch.yolo] : [c.verb]));
/** A home launched on the fake provider in full mode: its record, and the one session the provider has for it. */
function assertProviderHome(fx, instance, { launchConfig = "claude" } = {}) {
  const home = join(fx.root, "dev", "instances", instance);
  const meta = readJson(join(home, "instance.json"));
  const sessions = [...sessionsOf(fx.events())].filter(([, s]) => s.home === instance);
  assert.equal(sessions.length, 1, `one session for ${instance}`);
  assert.deepEqual([meta.backend, meta.launch.yolo, meta.launch.launchConfig, meta.session, sessions[0][1].running], ["fake", true, launchConfig, { provider: FAKE_CAPABILITY, endpoint: { server: FAKE_SERVER, threadId: sessions[0][0] } }, true], JSON.stringify(meta));
  assert.deepEqual(askedFor(fx, instance), [["check", true], ["launch"]], "its check, with the launch that was planned, then its launch");
  return { home, meta };
}

test("a scheduled spawn with backend fake and yolo: true launches a provider home, as one whose launch configuration sets yolo does; with no yolo a provider that launches only in full mode refuses it at its check, when the job is saved and at each run, and the run leaves no home", async (t) => {
  const fx = fullOnlyProvider(t);
  // Saved: the save's preview asks the provider's check with the job's own yolo, so the job the
  // provider will launch is accepted, and the one it will refuse is refused with the provider's code.
  // (`full` also names a model: the planned launch its check is handed carries it, at the save and at the run.)
  answer(addSchedule(fx, "full", { ...SPAWN, yolo: true, model: "opus" }));
  answer(addSchedule(fx, "default", { ...SPAWN, launchConfig: "full" }));
  const unsaved = addSchedule(fx, "sandboxed", SPAWN).json();
  assert.deepEqual([unsaved.ok, unsaved.error.code, unsaved.error.details], [false, "E_SCHEDULE_INVALID", { code: FULL_ONLY.problems[0].code, field: "agent" }], JSON.stringify(unsaved));
  assert.match(unsaved.error.message, /this provider launches only in full mode/);
  assert.deepEqual(fx.verbs().map((c) => [c.verb, c.request.input.launch.yolo]), [["check", true], ["check", true], ["check", null]], "each save asked the provider once, and launched nothing");
  assert.deepEqual(fx.verbs().map((c) => [c.request.input.launch.model ?? null, Object.hasOwn(c.request.input.launch, "model")]), [["opus", true], [null, false], [null, false]], "the job's own model, and no model key for a job that names none");
  assert.deepEqual(homesOf(fx), []);
  fx.clearCalls();

  // Due: each job spawns one home, launched through the provider in full mode.
  const first = await scheduleTick(fx, "2026-11-23T10:00:05Z");
  assert.deepEqual(first.map((row) => [row.id, row.action, row.instance]), [["default", "launched", "dev-default-202611231000"], ["full", "launched", "dev-full-202611231000"]], JSON.stringify(first));
  assert.deepEqual(homesOf(fx), ["dev-default-202611231000", "dev-full-202611231000"]);
  const { home } = assertProviderHome(fx, "dev-full-202611231000");
  assertProviderHome(fx, "dev-default-202611231000", { launchConfig: "full" });
  const modelsAsked = (instance) => fx.verbs().filter((c) => c.instance === instance).map((c) => (c.verb === "check" ? c.request.input.launch.model : c.request.input.model) ?? null);
  assert.deepEqual([modelsAsked("dev-full-202611231000"), modelsAsked("dev-default-202611231000")], [["opus", "opus"], [null, null]], "the scheduled spawn's check is told the model its launch is then handed");
  const launched = lastRun(fx, "full");
  assert.deepEqual([launched.outcome, launched.kind, launched.launched, launched.instance, launched.home, launched.session.delivery], ["launched", "spawn", true, "dev-full-202611231000", home, "launched"], JSON.stringify(launched));
  assert.match(readFileSync(join(home, "TASK.md"), "utf8"), /Do the nightly thing\./);
  assert.equal((await fx.inEnv(() => inspectInstanceSession(home))).running, true);

  // A job with no yolo that was saved all the same (its soul is spawned here now, so the save asks
  // no preview): the run's spawn asks the provider's check, which refuses it; the run records the
  // refusal and the spawn is undone.
  answer(addSchedule(fx, "sandboxed", SPAWN));
  fx.clearCalls();
  const second = await scheduleTick(fx, "2026-11-23T10:01:05Z");
  const failed = second.find((row) => row.id === "sandboxed");
  assert.equal(failed.action, "launch-failed", JSON.stringify(second));
  assert.match(failed.error, /dev-sandboxed-202611231001 was not launched: acme\.fake's session provider fake is not ready \(unavailable\): E_BACKEND_SANDBOXED_MODE: this provider launches only in full mode/);
  const run = lastRun(fx, "sandboxed");
  assert.deepEqual([run.outcome, run.errorCode, run.launched, run.unconfirmed, run.session], ["launch-failed", "E_BACKEND_SANDBOXED_MODE", false, false, { instance: null, home: null, incarnation: null, server: null, delivery: "none" }], JSON.stringify(run));
  assert.equal(run.error, failed.error);
  assert.deepEqual(askedFor(fx, "dev-sandboxed-202611231001"), [["check", null]], "the provider was asked its check, and no launch");
  assert.deepEqual(fx.hooks().filter((h) => h.instance === "dev-sandboxed-202611231001"), [], "no hook ran for it");
  assert.deepEqual(homesOf(fx), ["dev-default-202611231000", "dev-full-202611231000"], "no home is left");
  assert.equal([...sessionsOf(fx.events()).values()].length, 2, "and the provider has no session for it");
  // `oats schedule test` reads each job as its run will go.
  const tested = (id) => answer(fx.cli(["schedule", "test", id, "--json"])).test;
  assert.deepEqual([tested("full").soul.resolves, tested("full").soul.error], [true, null]);
  assert.deepEqual([tested("sandboxed").soul.resolves, tested("sandboxed").soul.error.code], [false, "E_BACKEND_SANDBOXED_MODE"]);
});

test("a trigger whose spawn names backend fake and yolo: true spawns a provider home for its event; with no yolo a provider that launches only in full mode refuses it, and the event stays pending with no home", async (t) => {
  const fx = fullOnlyProvider(t);
  const definition = (id, spawn) => ({ id, kind: "trigger", on: { source: SOURCE, events: ["opened", "updated"], poll: "1m" }, spawn: { soul: "dev", purpose: `${id}-{subject}`, task: "Review {subject} on {fields.graph}.", backend: "fake", launchConfig: "claude", ...spawn }, concurrency: { max: 5, perKey: 1 } });
  for (const def of [definition("full", { yolo: true }), definition("sandboxed", {})]) {
    const file = join(fx.base, `trigger-${def.id}.json`);
    writeFileSync(file, JSON.stringify(def));
    answer(fx.cli(["trigger", "add", "--file", file, "--json"]));
  }
  const statusOf = (id) => answer(fx.cli(["trigger", "status", "--json"])).triggers.find((row) => row.id === `local/${id}`);
  fx.source([{ key: "a:h1", subject: "a", event: "opened", fields: { graph: "g1" } }]);

  const first = await triggerTick(fx, "2026-11-23T10:00:30Z");
  const fired = first.find((row) => row.trigger === "local/full"), refused = first.find((row) => row.trigger === "local/sandboxed");
  // Fired: the event's home, launched through the provider in full mode.
  const { home, meta } = assertProviderHome(fx, "dev-full-a");
  assert.deepEqual([fired.action, fired.key, fired.instance, fired.home], ["fired", "local/full:a:h1", "dev-full-a", home], JSON.stringify(first));
  assert.deepEqual([meta.trigger.id, meta.trigger.subject, meta.trigger.event], ["local/full", "a", "opened"]);
  assert.match(readFileSync(join(home, "TASK.md"), "utf8"), /Review a on g1\./);
  assert.equal((await fx.inEnv(() => inspectInstanceSession(home))).running, true);
  let status = statusOf("full");
  assert.deepEqual([status.firedTotal, status.pending, status.live.map((row) => row.instance), status.lastError], [1, [], ["dev-full-a"], null], JSON.stringify(status));
  // Refused: the trigger's preview asks the provider's check with no yolo; nothing is spawned.
  assert.deepEqual([refused.action, refused.code, refused.key], ["spawn-failed", "E_BACKEND_SANDBOXED_MODE", "local/sandboxed:a:h1"], JSON.stringify(first));
  assert.match(refused.error, /this provider launches only in full mode/);
  status = statusOf("sandboxed");
  assert.deepEqual([status.firedTotal, status.pending.map((row) => row.key), status.live, status.lastError.code], [0, ["local/sandboxed:a:h1"], [], "E_BACKEND_SANDBOXED_MODE"], JSON.stringify(status));
  assert.deepEqual(homesOf(fx), ["dev-full-a"], "the refused spawn left no home");
  assert.deepEqual(fx.verbs().filter((c) => c.instance !== "dev-full-a").map((c) => [c.verb, c.request.input.launch.yolo]).sort(), [["check", null], ["check", true]], "beside the home's own calls: each trigger's preview asked the check once, with its own yolo");

  // The next poll: the fired event fires no second home; the refused one is tried again, and refused.
  fx.clearCalls();
  const second = await triggerTick(fx, "2026-11-23T10:01:30Z");
  assert.deepEqual(second.map((row) => [row.trigger, row.action, row.code]).sort(), [["local/full", "polled", undefined], ["local/sandboxed", "spawn-failed", "E_BACKEND_SANDBOXED_MODE"]], JSON.stringify(second));
  assert.deepEqual(fx.verbs().map((c) => [c.verb, c.request.input.launch.yolo]), [["check", null]]);
  assert.deepEqual(homesOf(fx), ["dev-full-a"]);
  assert.equal([...sessionsOf(fx.events()).values()].length, 1);
});
