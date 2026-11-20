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
// Defaults: launch answers a new endpoint `{ server, threadId }`; inspect a running session with an
// `open` link; input `{ submitted: true, verified: true }`; stop `{ stopped: true }`; inspectMany
// each home's own inspect behaviour, in order; check (declared only by `fakeProvider({ check: true })`)
// `{ status: "ready", problems: [], warnings: [] }`.
// LOST is what a provider answers for a session that is gone (as bb's error reads): a lost session.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { v2Deployment } from "./v2-deployment.mjs";

export const FAKE_CAPABILITY = "acme.fake";
export const FAKE_SERVER = "http://127.0.0.1:9";

const SESSION_SCRIPT = `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
const dir = join(process.env.HOME, "fake-session");
mkdirSync(dir, { recursive: true });
const req = JSON.parse(readFileSync(0, "utf8"));
const instance = process.env.OATS_INSTANCE;
appendFileSync(join(dir, "calls.log"), JSON.stringify({ verb: req.verb, argv: process.argv.slice(2), cwd: process.cwd(), instance, backend: process.env.OATS_BACKEND, event: process.env.OATS_EVENT, capability: process.env.OATS_CAPABILITY, settings: process.env.OATS_SETTINGS, request: req }) + "\\n");
const control = existsSync(join(dir, "control.json")) ? JSON.parse(readFileSync(join(dir, "control.json"), "utf8")) : {};
const behaviourOf = (name, verb) => control[name]?.[verb] ?? control[verb] ?? {};
const echo = { schemaVersion: req.schemaVersion, phase: req.phase, capability: req.capability, provider: req.provider, verb: req.verb };
const open = (endpoint) => ({ label: "Open in fake", url: "${FAKE_SERVER}/thread/" + (endpoint?.threadId ?? "none") });
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
    return own.error ? { error: own.error } : own.result ?? defaults.inspect(h);
  }) };
}
if (result === undefined) result = defaults[req.verb](req.input);
process.stdout.write(JSON.stringify({ ...echo, ...(b.echo ?? {}), ok: true, result }) + "\\n");
`;

const HOOK_SCRIPT = `import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const dir = join(process.env.HOME, "fake-session");
mkdirSync(dir, { recursive: true });
appendFileSync(join(dir, "calls.log"), JSON.stringify({ hook: process.env.OATS_EVENT, instance: process.env.OATS_INSTANCE, backend: process.env.OATS_BACKEND ?? null, harness: process.env.OATS_HARNESS ?? null, preview: process.env.OATS_LAUNCH_PREVIEW ?? null }) + "\\n");
// hook-launch.json, when a test wrote it (fx.hookLaunch): the hook's launch arguments, by harness.
let launch;
try { launch = JSON.parse(readFileSync(join(dir, "hook-launch.json"), "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
process.stdout.write(JSON.stringify({ env: { ACME_FAKE_TOKEN_FILE: "/nowhere/token" }, ...(launch ? { launch } : {}) }) + "\\n");
`;

/** What a provider answers for a session that is gone. */
export const LOST = Object.freeze({ present: false, state: "stopped", running: false });
/** The provider declaration: `fake`, for claude (and whatever `harnesses` says), with inspectMany and,
 *  when asked, the optional readiness command `check`. */
export const fakeProvider = ({ harnesses = ["claude"], inspectMany = true, check = false, description = "A fake session backend for tests" } = {}) => ({
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
  /** A home of soul `dev` launched on the fake backend. */
  fx.launch = (name, spawnOpts = {}) => fx.spawn("dev", { name, backend: "fake", launchConfig: "claude", launch: true, ...spawnOpts });
  return fx;
}
