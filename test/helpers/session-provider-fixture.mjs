// A deployment whose member capability `acme.fake` is a session provider (lib/session-providers.mjs):
// a real provider script on disk (bin/session.mjs) that the kernel runs as it runs any session
// provider, and no bb. Soul `dev` composes it; soul `plain` composes nothing. The capability also
// has a spawn and a launch hook, which record the environment they were given.
//
// The script is told what to answer through $HOME/fake-session/control.json (HOME is the fixture's,
// and reaches the provider through its environment) and leaves a trace there: calls.log, one line
// per call (the verb, the request, the instance, OATS_BACKEND and OATS_EVENT) and per hook run.
//   control: { "<verb>": <behaviour>, "<instance>": { "<verb>": <behaviour> } }   (the instance's wins)
//   behaviour: { result } | { error: { code, message } } | { raw: "<stdout>" } | { exit: <status> }
//              | { sleepMs } (then the default answer) | { echo: { <header overrides> } }
//   control.stateful: true: the fake has sessions (sessionsOf): launch creates one, stop stops it, an
//   input restarts a stopped one, inspect answers what is there; each effect is a line of events.log.
// Defaults: launch answers a new endpoint `{ server, threadId }`; inspect a running session with an
// `open` link; input `{ submitted: true, verified: true }`; stop `{ stopped: true }`; inspectMany
// each home's own inspect behaviour, in order; check (declared only by `fakeProvider({ check: true })`)
// `{ status: "ready", problems: [], warnings: [] }`.
// LOST is what a provider answers for a session that is gone (as bb's error reads): a lost session.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { v2Deployment } from "./v2-deployment.mjs";
import { SESSION_PROVIDER_WIRE } from "../../lib/session-providers.mjs";
import { compositionOf } from "../../lib/home-integrity.mjs";
import { findRetirementBaseline } from "../../lib/session-receipt.mjs";

export const FAKE_CAPABILITY = "acme.fake";
export const FAKE_SERVER = "http://127.0.0.1:9";

/** The sessions a stateful fake has (control `stateful: true`), from its events (fx.events()),
 *  oldest first → Map of thread id → `{ home, createdAt, running }` (`home`: the instance's name). A session runs once created;
 *  a stop of its thread stops it, as a stop of its home does when it was created at or after that
 *  stop's `launchSent`; an input RESTARTS a stopped one, as a provider's does; `gone` is a session
 *  that ended by itself (a test's own event). The fake's inspect and a test's invariants read
 *  sessions through this one function. */
export function sessionsOf(events) {
  const sessions = new Map();
  for (const e of events) {
    const one = sessions.get(e.thread);
    if (e.ev === "created") sessions.set(e.thread, { home: e.home, createdAt: e.at, running: true });
    else if (e.ev === "input" && one) one.running = true;
    else if ((e.ev === "stop" || e.ev === "gone") && one) one.running = false;
    else if (e.ev === "stopHome") for (const s of sessions.values()) if (s.home === e.home && (!e.launchSent || s.createdAt >= Date.parse(e.launchSent))) s.running = false;
  }
  return sessions;
}

/** The events of a stateful fake's log, from its text: one JSON object per line, and only the
 *  lines that are WHOLE. Several commands append to the log while others read it (the explorer runs
 *  schedules side by side), so a read can end inside the line that is being written: what follows
 *  the last newline is not a line yet, and is left for the next read. A whole line that is no JSON
 *  is still an error. */
export function eventsOf(text) {
  const whole = text.slice(0, text.lastIndexOf("\n") + 1);
  return whole.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const SESSION_SCRIPT = `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
const dir = join(process.env.HOME, "fake-session");
mkdirSync(dir, { recursive: true });
const req = JSON.parse(readFileSync(0, "utf8"));
const instance = process.env.OATS_INSTANCE;
appendFileSync(join(dir, "calls.log"), JSON.stringify({ verb: req.verb, argv: process.argv.slice(2), cwd: process.cwd(), instance, backend: process.env.OATS_BACKEND, event: process.env.OATS_EVENT, capability: process.env.OATS_CAPABILITY, settings: process.env.OATS_SETTINGS, soul: process.env.OATS_SOUL ?? null, soulId: process.env.OATS_SOUL_ID ?? null, level: process.env.OATS_LEVEL ?? null, request: req }) + "\\n");
const control = existsSync(join(dir, "control.json")) ? JSON.parse(readFileSync(join(dir, "control.json"), "utf8")) : {};
// A stop's behaviour can be set by what it is asked to stop: "stop:E" (an endpoint), "stop:null" (whatever is rooted at the home).
const stopKind = req.verb === "stop" ? (req.input.endpoint === null ? "stop:null" : "stop:E") : null;
const behaviourOf = (name, verb) => (verb === "stop" && stopKind ? control[name]?.[stopKind] ?? control[stopKind] : undefined) ?? control[name]?.[verb] ?? control[verb] ?? {};
const echo = { schemaVersion: req.schemaVersion, phase: req.phase, capability: req.capability, provider: req.provider, verb: req.verb };
const open = (endpoint) => ({ label: "Open in fake", url: "${FAKE_SERVER}/thread/" + (endpoint?.threadId ?? "none") });
// Stateful (control.stateful): each effect is an event, written when it happens (after a sleep),
// and inspect answers from them.
const stateful = control.stateful === true;
${eventsOf.toString()}
const events = () => (existsSync(join(dir, "events.log")) ? eventsOf(readFileSync(join(dir, "events.log"), "utf8")) : []);
const emit = (event) => appendFileSync(join(dir, "events.log"), JSON.stringify({ ...event, at: Date.now() }) + "\\n");
${sessionsOf.toString()}
const statefulDefaults = {
  launch: () => {
    const thread = "thr_" + req.input.instance + "_" + randomUUID();
    emit({ ev: "created", thread, home: instance });
    return { endpoint: { server: "${FAKE_SERVER}", threadId: thread } };
  },
  inspect: (input) => (sessionsOf(events()).get(input.endpoint?.threadId)?.running === true ? { present: true, state: "unknown", running: true, open: open(input.endpoint) } : { present: false, state: "stopped", running: false }),
  input: () => { emit({ ev: "input", thread: req.input.endpoint?.threadId }); return { submitted: true, verified: true }; },
  stop: () => { emit(req.input.endpoint === null ? { ev: "stopHome", home: instance, launchSent: req.input.launchSent ?? null } : { ev: "stop", thread: req.input.endpoint.threadId }); return { stopped: true }; },
};
const defaults = {
  launch: () => {
    const counter = join(dir, "threads");
    const n = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;
    writeFileSync(counter, String(n));
    return { endpoint: { server: "${FAKE_SERVER}", threadId: "thr_" + req.input.instance + "_" + n } };
  },
  inspect: (input) => ({ present: true, state: "unknown", running: true, open: open(input.endpoint) }),
  input: () => ({ submitted: true, verified: true }),
  stop: () => ({ stopped: true }),
  check: () => ({ status: "ready", problems: [], warnings: [] }),
};
const b = behaviourOf(instance, req.verb);
// touch: a file this call appends one space to before it answers (a record another verb changes meanwhile).
if (b.touch) appendFileSync(b.touch, " ");
if (b.sleepMs) await new Promise((r) => setTimeout(r, b.sleepMs));
// late: a file this call appends to AFTER its sleep (what a command that outlived its kernel would still do).
if (b.late) appendFileSync(b.late, "late");
if (b.exit !== undefined) process.exit(b.exit);
if (b.raw !== undefined) { process.stdout.write(b.raw); process.exit(0); }
if (b.error) { process.stdout.write(JSON.stringify({ ...echo, ...(b.echo ?? {}), ok: false, error: b.error }) + "\\n"); process.exit(0); }
let result = b.result;
if (result === undefined && req.verb === "inspectMany") {
  result = { results: req.input.homes.map((h) => {
    const own = behaviourOf(h.instance ?? basename(h.home), "inspect");
    return own.error ? { error: own.error } : own.result ?? (stateful ? statefulDefaults : defaults).inspect(h);
  }) };
}
if (result === undefined) result = (stateful && statefulDefaults[req.verb] ? statefulDefaults : defaults)[req.verb](req.input);
process.stdout.write(JSON.stringify({ ...echo, ...(b.echo ?? {}), ok: true, result }) + "\\n");
`;

const HOOK_SCRIPT = `import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const dir = join(process.env.HOME, "fake-session");
mkdirSync(dir, { recursive: true });
appendFileSync(join(dir, "calls.log"), JSON.stringify({ hook: process.env.OATS_EVENT, instance: process.env.OATS_INSTANCE, backend: process.env.OATS_BACKEND ?? null, harness: process.env.OATS_HARNESS ?? null, preview: process.env.OATS_LAUNCH_PREVIEW ?? null, previousBackend: process.env.OATS_PREVIOUS_BACKEND ?? null, capability: process.env.OATS_CAPABILITY ?? null, settings: process.env.OATS_SETTINGS ?? null }) + "\\n");
// hook-launch.json, when a test wrote it (fx.hookLaunch): the hook's launch arguments, by harness.
let launch;
try { launch = JSON.parse(readFileSync(join(dir, "hook-launch.json"), "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
process.stdout.write(JSON.stringify({ env: { ACME_FAKE_TOKEN_FILE: "/nowhere/token" }, ...(launch ? { launch } : {}) }) + "\\n");
`;

/** What a provider answers for a session that is gone. */
export const LOST = Object.freeze({ present: false, state: "stopped", running: false });
/** The provider declaration: `fake`, for claude (and whatever `harnesses` says), with inspectMany and,
 *  when asked, the optional readiness command `check`. */
export const fakeProvider = ({ harnesses = ["claude"], inspectMany = true, check = false, description = "A fake session backend for tests", wire = SESSION_PROVIDER_WIRE } = {}) => ({
  ...(wire === null ? {} : { wire }),
  description, harnesses,
  commands: { launch: "session-launch", inspect: "session-inspect", input: "session-input", stop: "session-stop", ...(inspectMany ? { inspectMany: "session-inspect-many" } : {}), ...(check ? { check: "session-check" } : {}) },
});
/** The capability's manifest: its commands, its hooks, and `sessionProviders` (default: `fake`). */
export const fakeManifest = (sessionProviders = { fake: fakeProvider() }) => ({
  environment: ["ACME_FAKE_TOKEN_FILE"],
  commands: { "session-launch": "bin/session.mjs launch", "session-inspect": "bin/session.mjs inspect", "session-input": "bin/session.mjs input", "session-stop": "bin/session.mjs stop", "session-inspect-many": "bin/session.mjs inspectMany", "session-check": "bin/session.mjs check" },
  hooks: { spawn: "bin/hook.mjs", launch: "bin/hook.mjs" },
  sessionProviders,
});
export const fakeFiles = () => ({ "bin/session.mjs": SESSION_SCRIPT, "bin/hook.mjs": HOOK_SCRIPT });

/** The deployment. Options pass through to v2Deployment; `manifest` replaces the capability's,
 *  `capabilities` and `souls` add to or replace the defaults. A `claude` launch configuration is
 *  declared, so `launchConfig: "claude"` spawns on the harness the fake runs. */
export function providerDeployment(t, { manifest = fakeManifest(), capabilities = {}, souls = {}, local = {}, ...opts } = {}) {
  const fx = v2Deployment({
    t, name: "acme",
    souls: { dev: { soul: { capabilities: { [FAKE_CAPABILITY]: { from: "here" } } } }, plain: {}, ...souls },
    capabilities: { [FAKE_CAPABILITY]: { manifest, files: fakeFiles() }, ...capabilities },
    local: { "launch-configs": { claude: { harness: "claude" }, codex: { harness: "codex" } }, ...local },
    ...opts,
  });
  fx.fake = join(fx.env.HOME, "fake-session");
  mkdirSync(fx.fake, { recursive: true });
  /** What the provider answers from now on (see the top of this file). */
  fx.control = (control) => writeFileSync(join(fx.fake, "control.json"), JSON.stringify(control));
  /** The launch arguments the capability's hooks answer from now on: `{ <harness>: "<arguments>" }`. */
  fx.hookLaunch = (launch) => writeFileSync(join(fx.fake, "hook-launch.json"), JSON.stringify(launch));
  /** Every call and hook run so far, oldest first. */
  fx.calls = () => (existsSync(join(fx.fake, "calls.log")) ? readFileSync(join(fx.fake, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  /** The provider's calls (never the hooks'), optionally of one verb. */
  fx.verbs = (verb) => fx.calls().filter((c) => c.verb !== undefined && (verb === undefined || c.verb === verb));
  fx.hooks = (event) => fx.calls().filter((c) => c.hook !== undefined && (event === undefined || c.hook === event));
  fx.clearCalls = () => rmSync(join(fx.fake, "calls.log"), { force: true });
  /** The kernel takes the home's module copies as they are now, which is what `oats instance
   *  upgrade` does of the ones it moves: for a test that edits a copy by hand to stand for what an
   *  upgrade brings: the kernel's own copies are made again from the home's, and the receipt
   *  names them. Without it, the kernel goes on running the copies its spawn made. */
  fx.recordComposition = (home) => {
    const path = findRetirementBaseline(home), receipt = JSON.parse(readFileSync(path, "utf8"));
    // (The rows name the store that goes: re-pointed here at the one that is made.)
    const earlier = receipt.composition.store, made = compositionOf(home, receipt.composition.capabilityRuntime);
    writeFileSync(path, JSON.stringify({ ...receipt, composition: JSON.parse(JSON.stringify(made).replaceAll(`/${earlier}/`, `/${made.store}/`)) }, null, 2));
  };
  /** A stateful fake's events so far, oldest first (sessionsOf reads them), and a test's own event. */
  fx.events = () => (existsSync(join(fx.fake, "events.log")) ? eventsOf(readFileSync(join(fx.fake, "events.log"), "utf8")) : []);
  fx.emit = (event) => appendFileSync(join(fx.fake, "events.log"), `${JSON.stringify({ ...event, at: Date.now() })}\n`);
  /** A home of soul `dev` launched on the fake backend. */
  fx.launch = (name, spawnOpts = {}) => fx.spawn("dev", { name, backend: "fake", launchConfig: "claude", launch: true, ...spawnOpts });
  return fx;
}
