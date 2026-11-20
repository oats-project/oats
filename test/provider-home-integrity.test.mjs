// The kernel's part of a provider home's integrity (docs/capabilities.md "Session providers", "What
// the kernel trusts in a provider home"): nothing the home's agent can write is run, or read as
// configuration, by the kernel. Every home here is a real spawn through the kernel on the fake
// provider (test/helpers/session-provider-fixture.mjs); a tmux home's side is in the tmux tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inputInstanceSession, restartInstanceSession, startInstanceSession } from "../lib/core.mjs";
import { compositionOf, homeModulesProblem, moduleCopyDigest, moduleCopyProblem, providerHomeTrust } from "../lib/home-integrity.mjs";
import { FAKE_CAPABILITY, fakeFiles, fakeManifest, providerDeployment } from "./helpers/session-provider-fixture.mjs";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const receiptOf = (home) => join(dirname(home), ".oats-retirement", "baselines", `${createHash("sha256").update(home).digest("hex")}.json`);
const recordOf = (home) => readJson(join(home, "instance.json"));
const codeOf = async (call) => { try { await call(); } catch (e) { return e.code; } return null; };
const runtimeOf = (home) => readJson(receiptOf(home)).runtime;
const rowOf = (fx, name) => JSON.parse(fx.cli(["status", "--json"]).stdout).agents.flatMap((agent) => agent.instances).find((row) => row.instance === name);
const copyOf = (home, capability = FAKE_CAPABILITY) => join(home, ".oats", "modules", capability);
/** A script that leaves a mark when it runs, put before `source`: what an agent that can write its
 *  home would make of one of its capabilities' files. */
const marking = (marker, source = "") => `import { writeFileSync as leaveMark } from "node:fs"; leaveMark(${JSON.stringify(marker)}, "ran");\n${source}`;
const NOT_THE_SPAWNS = /the copy of capability (acme\.[a-z]+) in [a-z-]+ \(.*\) is not the one the home was spawned with/;
/** A second capability with hooks of its own and no session provider, composed into soul `dev`
 *  beside the fake: what a hook's check is told apart from the provider's by. */
const HOOKED = "acme.hooked";
const withHooked = () => ({
  capabilities: { [HOOKED]: { manifest: { hooks: { spawn: "bin/hook.mjs", launch: "bin/hook.mjs", retire: "bin/hook.mjs" } }, files: { "bin/hook.mjs": fakeFiles()["bin/hook.mjs"].replace('{ env: { ACME_FAKE_TOKEN_FILE: "/nowhere/token" }, ', "{ ") } } },
  souls: { dev: { soul: { capabilities: { [FAKE_CAPABILITY]: { from: "here" }, [HOOKED]: { from: "here" } } } } },
});

test("a launch hook is told the backend the home was last launched on, from the receipt: none at a first launch, the provider's after it, and never what the home's own record says", async (t) => {
  const fx = providerDeployment(t);
  // A home that launches nothing at its spawn: its first launch is a start.
  const { home } = await fx.spawn("dev", { name: "mover", backend: "fake", launchConfig: "claude" });
  const told = () => fx.hooks("launch").map((h) => [h.backend, h.previousBackend]);
  // An ambient value (a kernel started from inside a hook) is never passed on.
  const ambient = (run) => fx.inEnv(async () => { process.env.OATS_PREVIOUS_BACKEND = "ambient"; try { return await run(); } finally { delete process.env.OATS_PREVIOUS_BACKEND; } });
  await ambient(() => startInstanceSession(home));
  assert.deepEqual(told(), [["fake", null]], "a first launch: no previous backend");
  // Launched before: the receipt names the backend.
  fx.clearCalls();
  await ambient(() => restartInstanceSession(home));
  assert.deepEqual(told(), [["fake", "fake"]]);
  assert.equal(readJson(receiptOf(home)).runtime.backend, "fake");
  // The home's own record is not where it is read: a record that names another backend gives
  // that name to no hook (the launch is refused, since the record contradicts the receipt).
  fx.clearCalls();
  writeFileSync(join(home, "instance.json"), JSON.stringify({ ...recordOf(home), backend: "forged" }));
  assert.equal(await codeOf(() => ambient(() => restartInstanceSession(home))), "E_RUNTIME_AUTHORITY_MISMATCH");
  assert.deepEqual(told(), []);
});

test("a module copy edited after the spawn is never run: the next provider call is refused naming the module, the home reads unavailable and never stopped, and each kind of change is seen", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("edited");
  const script = join(copyOf(home), "bin", "session.mjs"), original = readFileSync(script, "utf8");
  const marker = join(fx.fake, "edited-ran");
  const inspect = () => fx.cli(["session", "inspect", "--home", home, "--json"]).json();
  const refusedEverywhere = async (what) => {
    fx.clearCalls();
    const inspected = inspect();
    assert.deepEqual([inspected.ok, inspected.error?.code], [false, "E_SESSION_UNAVAILABLE"], what);
    assert.match(inspected.error.message, NOT_THE_SPAWNS, what);
    assert.equal(inspected.error.message.match(NOT_THE_SPAWNS)[1], FAKE_CAPABILITY, "the module is named");
    assert.deepEqual([rowOf(fx, "edited").running, rowOf(fx, "edited").runtimeState], [null, "unreachable"], `${what}: unavailable in status, never stopped`);
    assert.equal(await codeOf(() => fx.inEnv(() => inputInstanceSession(home, "x"))), "E_SESSION_INPUT_FAILED", what);
    // (A restart first reads whether the session runs, which the copy's state already refuses.)
    await assert.rejects(fx.inEnv(() => restartInstanceSession(home)), (e) => e.code === "E_SESSION_UNKNOWN" && NOT_THE_SPAWNS.test(e.message) && /nothing was started/.test(e.message), what);
    assert.deepEqual(fx.calls(), [], `${what}: no command of the provider ran, and no hook`);
    assert.equal(runtimeOf(home).stoppedAt, null, `${what}: the home is not recorded as stopped`);
  };
  // 1. A command of the provider rewritten: it would leave a mark.
  writeFileSync(script, marking(marker, original));
  await refusedEverywhere("an edited command");
  assert.equal(existsSync(marker), false, "the edited command never ran");
  // The same bytes back: the copy is the spawn's again, and it is run. (Nothing is remembered
  // between two calls: the copy is hashed at each.)
  writeFileSync(script, original);
  assert.deepEqual([inspect().ok, inspect().result.running], [true, true]);
  // 2. A file added beside the spawn's (what a command could import).
  writeFileSync(join(copyOf(home), "bin", "extra.mjs"), "export const x = 1;\n");
  await refusedEverywhere("an added file");
  rmSync(join(copyOf(home), "bin", "extra.mjs"));
  // 3. A file exchanged for a link to the same bytes elsewhere (which could change later).
  renameSync(script, join(fx.fake, "session-elsewhere.mjs"));
  symlinkSync(join(fx.fake, "session-elsewhere.mjs"), script);
  await refusedEverywhere("a link in place of a file");
  rmSync(script); renameSync(join(fx.fake, "session-elsewhere.mjs"), script);
  // 4. A file removed.
  renameSync(join(copyOf(home), "bin", "hook.mjs"), join(fx.fake, "hook-elsewhere.mjs"));
  await refusedEverywhere("a removed file");
  renameSync(join(fx.fake, "hook-elsewhere.mjs"), join(copyOf(home), "bin", "hook.mjs"));
  // 5. The whole copy exchanged for a link to a tree with the same bytes.
  renameSync(copyOf(home), join(fx.fake, "copy-elsewhere"));
  symlinkSync(join(fx.fake, "copy-elsewhere"), copyOf(home));
  await refusedEverywhere("a link in place of the copy");
  rmSync(copyOf(home)); renameSync(join(fx.fake, "copy-elsewhere"), copyOf(home));
  assert.equal(inspect().ok, true, "the spawn's copy, back in place, is run");
});

test("the digest of a module copy is bounded by what the spawn recorded: a copy that grew is told so without reading more than the copy's own size", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("grown");
  const recorded = readJson(receiptOf(home)).composition.modules[FAKE_CAPABILITY];
  assert.deepEqual(moduleCopyDigest(copyOf(home)), recorded, "the receipt records the copy's digest, bytes and entries");
  assert.deepEqual(moduleCopyDigest(copyOf(home), recorded), recorded);
  // More bytes than the spawn copied: stopped at the bound, whatever the file's size.
  writeFileSync(join(copyOf(home), "bin", "big.bin"), Buffer.alloc(4 * 1024 * 1024));
  assert.match(moduleCopyDigest(copyOf(home), recorded).over, /more than the \d+ (bytes|entries) the spawn copied/);
  rmSync(join(copyOf(home), "bin", "big.bin"));
  // More entries.
  for (let i = 0; i < 3; i++) writeFileSync(join(copyOf(home), `empty-${i}`), "");
  assert.match(moduleCopyDigest(copyOf(home), recorded).over, /more than the \d+ entries the spawn copied/);
  const inspected = fx.cli(["session", "inspect", "--home", home, "--json"]).json();
  assert.match(inspected.error.message, /it holds more than the \d+ entries the spawn copied/);
});

test("a hook script edited in the home never runs edited: a launch is refused naming the module with nothing stopped, and a retire reports the hook as not run", async (t) => {
  const fx = providerDeployment(t, withHooked());
  const { home } = await fx.launch("hooked");
  assert.deepEqual(fx.hooks("spawn").map((h) => h.capability).sort(), [FAKE_CAPABILITY, HOOKED]);
  const hook = join(copyOf(home, HOOKED), "bin", "hook.mjs"), marker = join(fx.fake, "hook-ran-edited");
  writeFileSync(hook, marking(marker, readFileSync(hook, "utf8")));
  // The provider's own copy is untouched: its session is read as before.
  fx.clearCalls();
  assert.equal(fx.cli(["session", "inspect", "--home", home, "--json"]).json().result.running, true);
  // A launch is made of every module of the home: refused before the check, any hook and any stop.
  fx.clearCalls();
  await assert.rejects(fx.inEnv(() => restartInstanceSession(home)), (e) => e.code === "E_SESSION_START_FAILED" && e.message.match(NOT_THE_SPAWNS)?.[1] === HOOKED && /nothing was stopped or started/.test(e.message));
  assert.deepEqual([fx.calls().filter((c) => c.verb !== "inspect"), runtimeOf(home).stoppedAt, existsSync(marker)], [[], null, false]);
  // A retire: the session is stopped through the provider (its copy is the spawn's), the edited
  // hook is not run and is named, and nothing is removed without --force.
  const refused = fx.cli(["retire", "hooked", "--json"]);
  const said = `${refused.stdout}${refused.stderr}`;
  assert.match(said, NOT_THE_SPAWNS);
  assert.equal(said.match(NOT_THE_SPAWNS)[1], HOOKED);
  assert.equal(existsSync(marker), false, "the edited retire hook never ran");
  assert.equal(existsSync(home), true, "the home is kept: its capability's cleanup did not run");
  assert.deepEqual(fx.hooks("retire").map((h) => h.capability), [], "nor did the fake's (it declares none)");
});

test("what a provider's command and a hook are handed is the receipt's: the settings, hook commands and launch contributions in the home's own record, edited, change nothing", async (t) => {
  const fx = providerDeployment(t, withHooked());
  const settings = { server: "http://127.0.0.1:10" };
  const { home } = await fx.launch("set", { providers: { [FAKE_CAPABILITY]: settings } });
  const marker = join(fx.fake, "forged-command-ran"), evil = join(fx.fake, "evil.mjs");
  writeFileSync(evil, marking(marker, 'process.stdout.write("{}\\n");\n'));
  // The agent rewrites its home's record: other settings, other hook commands, a capability more.
  const record = recordOf(home), forged = JSON.parse(JSON.stringify(record));
  const forgedSettings = { server: "http://forged.example" };
  for (const row of forged.capabilityRuntime) { row.settings = forgedSettings; row.hooks = { spawn: `node ${evil}`, launch: `node ${evil}`, retire: `node ${evil}` }; row.requiredHooks = []; }
  forged.capabilityRuntime.push({ id: "acme.forged", settings: forgedSettings, hooks: { launch: `node ${evil}`, retire: `node ${evil}` } });
  forged.providers = { [FAKE_CAPABILITY]: forgedSettings };
  for (const contribution of forged.launch?.hooks?.contributions ?? []) contribution.settings = forgedSettings;
  writeFileSync(join(home, "instance.json"), JSON.stringify(forged, null, 2));
  const settingsOf = (calls) => [...new Set(calls.filter((c) => c.capability === FAKE_CAPABILITY).map((c) => c.settings))].map((text) => JSON.parse(text));
  // A read, an input, and a restart with its check, its hooks, its stop and its launch.
  fx.clearCalls();
  assert.equal(fx.cli(["session", "inspect", "--home", home, "--json"]).json().result.running, true);
  rowOf(fx, "set");
  await fx.inEnv(() => inputInstanceSession(home, "hello"));
  await fx.inEnv(() => restartInstanceSession(home));
  assert.deepEqual(fx.verbs().map((c) => c.verb).filter((verb, i, all) => all.indexOf(verb) === i).sort(), ["input", "inspect", "inspectMany", "launch", "stop"]);
  assert.deepEqual(settingsOf(fx.verbs()), [settings], "every command of the provider got the spawn's settings");
  assert.deepEqual(settingsOf(fx.hooks()), [settings], "and so did its hooks");
  assert.deepEqual(fx.hooks("launch").map((h) => h.capability).sort(), [FAKE_CAPABILITY, HOOKED], "the hooks that ran are the spawn's, of the spawn's capabilities");
  assert.equal(existsSync(marker), false, "no command the record named was run");
  assert.deepEqual(fx.verbs("launch")[0].request.input.settings ?? settings, settings);
  // The record the start wrote holds the receipt's rows again.
  assert.deepEqual(recordOf(home).capabilityRuntime, readJson(receiptOf(home)).composition.capabilityRuntime);
  assert.deepEqual(readJson(receiptOf(home)).composition.capabilityRuntime.find((row) => row.id === FAKE_CAPABILITY).settings, settings);
});

test("a provider home whose receipt records no composition runs none of its capabilities, and says what to do", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("before");
  const receipt = readJson(receiptOf(home));
  assert.deepEqual(Object.keys(receipt.composition).sort(), ["capabilityRuntime", "modules", "version"]);
  assert.deepEqual(receipt.composition, compositionOf(home, recordOf(home).capabilityRuntime), "the spawn recorded every module copy and the rows of the record");
  const { composition: _removed, ...older } = receipt;
  writeFileSync(receiptOf(home), JSON.stringify(older, null, 2));
  fx.clearCalls();
  const inspected = fx.cli(["session", "inspect", "--home", home, "--json"]).json();
  assert.deepEqual([inspected.ok, inspected.error.code], [false, "E_SESSION_UNAVAILABLE"]);
  assert.match(inspected.error.message, /its receipt records nothing of what it was spawned with.*Retire it and spawn it again/);
  assert.deepEqual([rowOf(fx, "before").running, rowOf(fx, "before").runtimeState], [null, "unreachable"]);
  assert.equal(await codeOf(() => fx.inEnv(() => restartInstanceSession(home))), "E_SESSION_UNKNOWN");
  assert.deepEqual(fx.calls(), []);
});

// (A tmux spawn needs a harness on this machine: this one runs where the tmux tests run.)
test("a tmux home is unchanged: its receipt records no composition, and nothing of it is checked", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.spawn("dev", { name: "on-tmux" });
  assert.equal(Object.hasOwn(readJson(receiptOf(home)), "composition"), false);
  assert.equal(providerHomeTrust(home), null);
  // A copy its agent edited is its own business, as before: no problem is found, no digest taken.
  writeFileSync(join(copyOf(home), "bin", "hook.mjs"), "// edited\n");
  assert.equal(moduleCopyProblem(home, FAKE_CAPABILITY), null);
  assert.equal(homeModulesProblem(home), null);
});
