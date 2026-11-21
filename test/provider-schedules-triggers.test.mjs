// Schedules and triggers on a session provider (docs/schedules.md "Kinds" and "Triggers";
// docs/execution-targets.md "Session providers"): a scheduled wake is the input of a provider
// home's session, and a scheduled or a triggered spawn launches through the provider it names.
// The ticks are the host's own, in process; every spawn is the real `oats spawn` the tick runs as
// its child; the provider is the fake one (test/helpers/session-provider-fixture.mjs), a real
// script the kernel runs. For the spawns it comes from a package and refuses at its `check` a
// launch that is not in full mode, as a provider that never sandboxes does.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspectInstanceSession } from "../lib/core.mjs";
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
const scheduleTick = (fx, iso) => fx.inEnv(() => {
  const path = process.env.PATH;
  process.env.PATH = fx.env.PATH;
  try { return S.withHostLock(() => S.tickWorkspace(fx.dep, { now: new Date(iso), reg: S.readRegistry(), wsList: [fx.dep] })); } finally { process.env.PATH = path; }
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
  answer(addSchedule(fx, "full", { ...SPAWN, yolo: true }));
  answer(addSchedule(fx, "default", { ...SPAWN, launchConfig: "full" }));
  const unsaved = addSchedule(fx, "sandboxed", SPAWN).json();
  assert.deepEqual([unsaved.ok, unsaved.error.code, unsaved.error.details], [false, "E_SCHEDULE_INVALID", { code: FULL_ONLY.problems[0].code, field: "agent" }], JSON.stringify(unsaved));
  assert.match(unsaved.error.message, /this provider launches only in full mode/);
  assert.deepEqual(fx.verbs().map((c) => [c.verb, c.request.input.launch.yolo]), [["check", true], ["check", true], ["check", null]], "each save asked the provider once, and launched nothing");
  assert.deepEqual(homesOf(fx), []);
  fx.clearCalls();

  // Due: each job spawns one home, launched through the provider in full mode.
  const first = await scheduleTick(fx, "2026-11-23T10:00:05Z");
  assert.deepEqual(first.map((row) => [row.id, row.action, row.instance]), [["default", "launched", "dev-default-202611231000"], ["full", "launched", "dev-full-202611231000"]], JSON.stringify(first));
  assert.deepEqual(homesOf(fx), ["dev-default-202611231000", "dev-full-202611231000"]);
  const { home } = assertProviderHome(fx, "dev-full-202611231000");
  assertProviderHome(fx, "dev-default-202611231000", { launchConfig: "full" });
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
