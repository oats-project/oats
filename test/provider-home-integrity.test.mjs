// The kernel's part of a provider home's integrity (docs/capabilities.md "Session providers", "What
// the kernel trusts in a provider home"): the kernel runs only its own copy of the home's modules,
// kept outside the home, and reads their settings from the home's receipt; nothing the home's
// agent can write is run, or read as configuration, by the kernel. Every home here is a real spawn through the kernel on the fake
// provider (test/helpers/session-provider-fixture.mjs); a tmux home's side is in the tmux tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn as spawnChild, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { inputInstanceSession, restartInstanceSession, startInstanceSession, stopInstanceSession } from "../lib/core.mjs";
import { applyUpgrade, planUpgrade } from "../lib/instance-upgrade.mjs";
import { writeLock } from "../lib/packages.mjs";
import { contentDigest } from "../lib/remote.mjs";
import { CLI, git } from "./helpers/v2-deployment.mjs";
import { homeModulesProblem, kernelModuleDir, moduleCopyProblem, providerHomeTrust, pruneModulesStores, readModuleCopy, upgradedComposition } from "../lib/home-integrity.mjs";
import { FAKE_CAPABILITY, fakeFiles, fakeManifest, fakeProvider, providerDeployment } from "./helpers/session-provider-fixture.mjs";
import { deploymentStatusData } from "../packages/client/deployment-data.mjs";

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

test("the kernel runs its own copy of a provider home's modules, never the home's: whatever the agent does to its copy, at rest or while the kernel runs, the spawn's code is what runs, and the home goes on", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("edited");
  const script = join(copyOf(home), "bin", "session.mjs"), original = readFileSync(script, "utf8");
  const marker = join(fx.fake, "edited-ran");
  const inspect = () => fx.cli(["session", "inspect", "--home", home, "--json"]).json();
  // The kernel's copy: outside the home, the spawn's bytes.
  const kept = kernelModuleDir(home, FAKE_CAPABILITY);
  assert.equal(kept.startsWith(join(dirname(home), ".oats-retirement", "modules")), true, kept);
  assert.equal(readFileSync(join(kept, "bin", "session.mjs"), "utf8"), original);
  const goesOn = async (what) => {
    fx.clearCalls();
    const inspected = inspect();
    assert.deepEqual([inspected.ok, inspected.result?.running], [true, true], `${what}: ${JSON.stringify(inspected)}`);
    assert.equal(rowOf(fx, "edited").running, true, what);
    await fx.inEnv(() => inputInstanceSession(home, "x"));
    await fx.inEnv(() => restartInstanceSession(home));
    assert.deepEqual(fx.verbs().map((c) => c.verb).filter((verb, i, all) => all.indexOf(verb) === i).sort(), ["input", "inspect", "inspectMany", "launch", "stop"], what);
    assert.equal(fx.verbs().every((c) => c.cwd !== undefined), true);
    assert.equal(existsSync(marker), false, `${what}: nothing of the home's copy ran`);
  };
  // 1. A command of the provider rewritten in the home: it would leave a mark.
  writeFileSync(script, marking(marker, original));
  await goesOn("an edited command");
  // 2. A file added, 3. the copy emptied, 4. the whole copy exchanged for a link elsewhere.
  writeFileSync(join(copyOf(home), "bin", "extra.mjs"), marking(marker));
  await goesOn("an added file");
  rmSync(join(copyOf(home), "bin"), { recursive: true });
  await goesOn("an emptied copy");
  rmSync(copyOf(home), { recursive: true });
  mkdirSync(join(fx.fake, "copy-elsewhere", "bin"), { recursive: true });
  writeFileSync(join(fx.fake, "copy-elsewhere", "bin", "session.mjs"), marking(marker, original));
  writeFileSync(join(fx.fake, "copy-elsewhere", "oats.json"), "{}");
  symlinkSync(join(fx.fake, "copy-elsewhere"), copyOf(home));
  await goesOn("a link in place of the copy");
});

test("a session that rewrites its copy WHILE the kernel runs changes nothing the kernel runs (the race a check of the home's copy would lose)", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("racy");
  const script = join(copyOf(home), "bin", "session.mjs"), original = readFileSync(script, "utf8");
  const marker = join(fx.fake, "raced");
  // The agent's loop: its script is the spawn's bytes for a moment, then edited ones, for ever.
  const flipper = join(fx.fake, "flip.mjs");
  writeFileSync(flipper, `import { writeFileSync, renameSync } from "node:fs";
const script = ${JSON.stringify(script)}, original = ${JSON.stringify(original)}, edited = ${JSON.stringify(marking(marker, original))};
const put = (text) => { writeFileSync(script + ".tmp", text); renameSync(script + ".tmp", script); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (;;) { put(original); await wait(6); put(edited); await wait(30); }
`);
  const child = spawnChild(process.execPath, [flipper], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  await new Promise((r) => setTimeout(r, 300));
  for (let i = 0; i < 20; i++) {
    const inspected = fx.cli(["session", "inspect", "--home", home, "--json"]).json();
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
  }
  assert.equal(existsSync(marker), false, "the edited script never ran");
});

test("a provider home whose kernel copy of a module is gone runs nothing of that module, reads unavailable and never stopped, and names it", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.launch("unkept");
  rmSync(kernelModuleDir(home, FAKE_CAPABILITY), { recursive: true });
  fx.clearCalls();
  const inspected = fx.cli(["session", "inspect", "--home", home, "--json"]).json();
  assert.deepEqual([inspected.ok, inspected.error.code], [false, "E_SESSION_UNAVAILABLE"]);
  assert.match(inspected.error.message, /the kernel's copy of capability acme\.fake for unkept is not at .*Retire the instance and spawn it again/);
  assert.deepEqual([rowOf(fx, "unkept").running, rowOf(fx, "unkept").runtimeState], [null, "unreachable"]);
  assert.equal(await codeOf(() => fx.inEnv(() => inputInstanceSession(home, "x"))), "E_SESSION_INPUT_FAILED");
  assert.deepEqual([fx.calls(), runtimeOf(home).stoppedAt], [[], null], "the home's own copy was not run in its place");
});

test("a hook script edited in the home never runs edited: a launch and a retire run the spawn's hook, from the kernel's copy", async (t) => {
  const fx = providerDeployment(t, withHooked());
  const { home } = await fx.launch("hooked");
  assert.deepEqual(fx.hooks("spawn").map((h) => h.capability).sort(), [FAKE_CAPABILITY, HOOKED]);
  const hook = join(copyOf(home, HOOKED), "bin", "hook.mjs"), marker = join(fx.fake, "hook-ran-edited");
  writeFileSync(hook, marking(marker, readFileSync(hook, "utf8")));
  // The receipt's rows name the kernel's copy of each capability, never the home's.
  const rows = readJson(receiptOf(home)).composition.capabilityRuntime;
  for (const row of rows) for (const command of Object.values(row.hooks ?? {})) {
    assert.equal(command.includes(kernelModuleDir(home, row.id)), true, command);
    assert.equal(command.includes(join(home, ".oats")), false, command);
  }
  fx.clearCalls();
  await fx.inEnv(() => restartInstanceSession(home));
  assert.deepEqual(fx.hooks("launch").map((h) => h.capability).sort(), [FAKE_CAPABILITY, HOOKED], "the launch hooks ran");
  assert.equal(existsSync(marker), false, "and not the edited one");
  fx.clearCalls();
  assert.equal(JSON.parse(fx.cli(["retire", "hooked", "--json"]).stdout).retired, "hooked");
  assert.deepEqual([fx.hooks("retire").map((h) => h.capability), existsSync(marker), existsSync(home)], [[HOOKED], false, false]);
  assert.equal(existsSync(kernelModuleDir(home, HOOKED)), false, "the kernel's copies go with the home");
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
  assert.deepEqual(Object.keys(receipt.composition).sort(), ["capabilityRuntime", "modules", "store", "version"]);
  assert.deepEqual([Object.keys(receipt.composition.modules), receipt.composition.capabilityRuntime.map((row) => [row.id, row.settings])], [Object.keys(recordOf(home).modules), recordOf(home).capabilityRuntime.map((row) => [row.id, row.settings])], "the spawn recorded every module and the rows of the record");
  const { composition: _removed, ...older } = receipt;
  writeFileSync(receiptOf(home), JSON.stringify(older, null, 2));
  fx.clearCalls();
  const inspected = fx.cli(["session", "inspect", "--home", home, "--json"]).json();
  assert.deepEqual([inspected.ok, inspected.error.code], [false, "E_SESSION_UNAVAILABLE"]);
  assert.match(inspected.error.message, /its receipt records nothing of what it was spawned with.*Retire it and spawn it again/);
  assert.deepEqual([rowOf(fx, "before").running, rowOf(fx, "before").runtimeState], [null, "unreachable"]);
  // Inspect and readiness of it list no module, and say why.
  const inspectedHome = fx.cli(["inspect", "--home", home, "--json"]).json().result;
  assert.deepEqual(inspectedHome.capabilities, []);
  assert.match(JSON.stringify(inspectedHome), /module-copy-untrusted.*its receipt records nothing of what it was spawned with.*Retire it and spawn it again/);
  assert.equal(await codeOf(() => fx.inEnv(() => restartInstanceSession(home))), "E_SESSION_UNKNOWN");
  assert.deepEqual(fx.calls(), []);
  // It can still be taken away: not without --force (its hooks cannot be identified), and with it.
  const refused = fx.cli(["retire", "before", "--json"]);
  assert.equal(existsSync(home), true, refused.stdout + refused.stderr);
  const forced = fx.cli(["retire", "before", "--force", "--json"]);
  assert.equal(JSON.parse(forced.stdout).retired, "before", forced.stdout + forced.stderr);
  assert.equal(existsSync(home), false);
  assert.deepEqual(fx.calls(), [], "and nothing of the home was run for it");
});

// (A tmux spawn needs a harness on this machine: this one runs where the tmux tests run.)
test("a tmux home is unchanged: its receipt records no composition, and nothing of it is checked", async (t) => {
  const fx = providerDeployment(t);
  const { home } = await fx.spawn("dev", { name: "on-tmux" });
  assert.equal(Object.hasOwn(readJson(receiptOf(home)), "composition"), false);
  assert.equal(providerHomeTrust(home), null);
  assert.equal(Object.hasOwn(rowOf(fx, "on-tmux"), "moduleCopy"), false, "and its status row gains no key");
  // A copy its agent edited is its own business, and is what runs, as before: the kernel keeps no copy of it.
  writeFileSync(join(copyOf(home), "bin", "hook.mjs"), "// edited\n");
  assert.equal(moduleCopyProblem(home, FAKE_CAPABILITY), null);
  assert.equal(homeModulesProblem(home), null);
});

// A package capability beside the fake (a member, which an upgrade never moves): `acme.one`, whose
// launch hook tells which version of it ran.
const PACKAGED = "acme.one";
const packageFiles = (version) => {
  const base = `oats-package/capabilities/${PACKAGED}`;
  return {
    "oats-package/oats-package.json": { json: { package: "acme.pkg", version, capabilities: [`capabilities/${PACKAGED}`] } },
    [`${base}/oats.json`]: { json: { capability: PACKAGED, version, description: "Fixture capability", hooks: { launch: "launch.mjs", retire: "retire.mjs", upgrade: "upgrade.mjs" } } },
    [`${base}/launch.mjs`]: `import { appendFileSync } from "node:fs"; import { join } from "node:path";\nappendFileSync(join(process.env.HOME, "fake-session", "packaged.log"), ${JSON.stringify(version)} + "\\n");\nconsole.log("{}");\n`,
    [`${base}/retire.mjs`]: 'console.log("{}");\n',
    [`${base}/upgrade.mjs`]: `import { appendFileSync } from "node:fs"; import { join } from "node:path";\nappendFileSync(join(process.env.HOME, "fake-session", "upgrade-hook.log"), JSON.stringify({ phase: process.env.OATS_UPGRADE_PHASE, settings: process.env.OATS_SETTINGS }) + "\\n");\nconsole.log(JSON.stringify(process.env.OATS_UPGRADE_PHASE === "plan" ? { adopt: true } : { meta: {} }));\n`,
  };
};
const lockPackage = (fx, version) => writeLock(fx.dep, { lockfileVersion: 3, packages: { "acme.pkg": { source: `git:${fx.key}@main`, url: fx.ref, path: "oats-package", version, commit: git(fx.member, "rev-parse", "HEAD"), integrity: contentDigest(join(fx.member, "oats-package")), capabilities: [PACKAGED] } } });
async function upgradable(t, name) {
  const fx = providerDeployment(t, { files: packageFiles("1.0.0"), souls: { dev: { soul: { capabilities: { "oats.core": "off", [FAKE_CAPABILITY]: { from: "here" }, [PACKAGED]: { from: "package" } } } } } });
  fx.commit({ "oats-workspace.yaml": { yaml: { schemaVersion: 2, name: "acme", members: [fx.ref], defaults: { knowledge: "none", messaging: "none", tasks: "none" }, packages: { "acme.pkg": `git:${fx.key}@main` } } } });
  lockPackage(fx, "1.0.0");
  const { home } = await fx.launch(name);
  await fx.inEnv(() => stopInstanceSession(home, {}));
  fx.commit(packageFiles("2.0.0"));
  lockPackage(fx, "2.0.0");
  const upgrade = (verb, opts = {}) => fx.inEnv(() => verb(fx.dep, fx.root, name, { remoteOptions: fx.remoteOptions, ...opts }));
  return { fx, home, plan: (opts) => upgrade(planUpgrade, opts), apply: (opts) => upgrade(applyUpgrade, opts), ran: () => (existsSync(join(fx.fake, "packaged.log")) ? readFileSync(join(fx.fake, "packaged.log"), "utf8").trim().split("\n") : []) };
}

test("an upgrade of a provider home exchanges the kernel's copy of each moved module, and rewrites the receipt's record, in the step that moves the home's copies: the home's calls and hooks go on, on the new module", async (t) => {
  const { fx, home, plan, apply, ran } = await upgradable(t, "moved");
  const before = readJson(receiptOf(home)).composition;
  const keptLaunch = () => readFileSync(join(kernelModuleDir(home, PACKAGED), "launch.mjs"), "utf8");
  assert.match(keptLaunch(), /1\.0\.0/);
  const planned = await plan();
  assert.deepEqual(planned.modules.map((m) => m.capability), [PACKAGED]);
  const done = await apply({ planRevision: planned.planRevision, idempotencyKey: "move-1" });
  assert.equal(done.status, "complete");
  const after = readJson(receiptOf(home)).composition;
  assert.deepEqual(after.modules[FAKE_CAPABILITY], before.modules[FAKE_CAPABILITY], "a module that did not move is as it was recorded");
  assert.deepEqual([after.modules[PACKAGED].from.version, before.modules[PACKAGED].from.version], ["2.0.0", "1.0.0"]);
  assert.match(keptLaunch(), /2\.0\.0/, "the kernel's copy is the moved module's");
  assert.equal(keptLaunch(), readFileSync(join(copyOf(home, PACKAGED), "launch.mjs"), "utf8"));
  const row = after.capabilityRuntime.find((r) => r.id === PACKAGED);
  assert.equal(row.hooks.launch.includes(join(kernelModuleDir(home, PACKAGED), "launch.mjs")), true, row.hooks.launch);
  assert.equal(homeModulesProblem(home), null);
  // The home starts: the provider is called, and the moved capability's NEW hook runs.
  fx.clearCalls();
  await fx.inEnv(() => startInstanceSession(home));
  assert.deepEqual([fx.verbs("launch").length, ran().at(-1)], [1, "2.0.0"]);
  assert.equal(fx.cli(["session", "inspect", "--home", home, "--json"]).json().result.running, true);
});

test("an undo of a provider home's upgrade names the kernel's previous copies and rows again, in one write, and runs the previous module's hook from the kernel's copy; a second undo has nothing to go back to", async (t) => {
  const { fx, home, plan, apply, ran } = await upgradable(t, "undone-move");
  const storesOf = () => readdirSync(dirname(dirname(kernelModuleDir(home, PACKAGED)))).sort();
  const keptVersion = () => readFileSync(join(kernelModuleDir(home, PACKAGED), "launch.mjs"), "utf8").match(/\d+\.\d+\.\d+/)[0];
  const first = readJson(receiptOf(home)).composition;
  // No move yet: nothing to undo.
  await assert.rejects(plan({ undo: true }), (e) => e.code === "E_UPGRADE_UNDO" && /no previous move to undo/.test(e.message));
  const planned = await plan();
  await apply({ planRevision: planned.planRevision, idempotencyKey: "undo-1" });
  const moved = readJson(receiptOf(home)).composition;
  // The move kept the pair it replaced: its store is still there, and the receipt names it as previous.
  assert.deepEqual([keptVersion(), moved.previous.store, moved.previous.capabilityRuntime, storesOf()], ["2.0.0", first.store, first.capabilityRuntime, [first.store, moved.store].sort()]);
  // The hook an undo runs is the kernel's previous copy's: marked here, in the kernel's store, it leaves its mark.
  const marker = join(fx.fake, "kernel-previous-hook-ran");
  const keptHook = join(dirname(dirname(kernelModuleDir(home, PACKAGED))), first.store, PACKAGED, "upgrade.mjs");
  writeFileSync(keptHook, marking(marker, readFileSync(keptHook, "utf8")));
  const back = await plan({ undo: true });
  assert.deepEqual(back.modules.map((m) => m.capability), [PACKAGED]);
  const done = await apply({ undo: true, planRevision: back.planRevision, idempotencyKey: "undo-2" });
  assert.equal(done.status, "complete");
  assert.equal(existsSync(marker), true, "the undo's hook ran from the kernel's previous copy");
  const after = readJson(receiptOf(home)).composition;
  assert.deepEqual([after.store, after.modules, after.capabilityRuntime, Object.hasOwn(after, "previous")], [first.store, first.modules, first.capabilityRuntime, false], "the receipt names the first pair again, whole");
  assert.deepEqual([keptVersion(), storesOf()], ["1.0.0", [first.store]], "the kernel runs the earlier copy, and the newer store is gone, after the write");
  // The home starts on it: the earlier module's hook runs.
  await fx.inEnv(() => startInstanceSession(home));
  assert.equal(ran().at(-1), "1.0.0");
  assert.deepEqual(rowOf(fx, "undone-move").moduleCopy, { runs: "kernel-copy", homeCopy: "same", differs: [] });
  await fx.inEnv(() => stopInstanceSession(home, {}));
  await assert.rejects(plan({ undo: true }), (e) => e.code === "E_UPGRADE_UNDO");
});

test("an upgrade of a provider home is not resumed from the journal in its home", async (t) => {
  const { home, plan, apply } = await upgradable(t, "guarded");
  const planned = await plan();
  await apply({ planRevision: planned.planRevision, idempotencyKey: "guard-2" });
  const journal = join(home, ".oats", "upgrade-receipt.guard-2.json");
  writeFileSync(journal, JSON.stringify({ ...readJson(journal), status: "partial", step: "swap" }));
  await assert.rejects(apply({ planRevision: planned.planRevision, idempotencyKey: "guard-2" }), (e) => e.code === "E_UPGRADE_PARTIAL" && /is not resumed from the journal in its home/.test(e.message));
  assert.match(readFileSync(join(kernelModuleDir(home, PACKAGED), "launch.mjs"), "utf8"), /2\.0\.0/);
});

// The kill rows: an upgrade whose process ends at a seam (as the lifecycle's rows are killed), at
// the two instants around the receipt's one write.
for (const [point, version, pair] of [["upgrade:copies-made", "1.0.0", "the old pair"], ["upgrade:receipt-written", "2.0.0", "the new pair"]]) {
  test(`an upgrade killed at ${point} leaves ${pair}: the receipt's rows name the store the kernel runs from, and the kernel runs that module`, async (t) => {
    const { fx, home, plan } = await upgradable(t, "killed");
    const first = readJson(receiptOf(home)).composition;
    const planned = await plan();
    const killed = spawnSync(process.execPath, [CLI, "instance", "upgrade", "killed", "--plan-revision", planned.planRevision, "--idempotency-key", "kill-1", "--json"], { cwd: fx.dep, env: { ...fx.env, OATS_TEST_PROVIDER_DIE_AT: point }, encoding: "utf8" });
    assert.equal(killed.signal, "SIGKILL", killed.stdout + killed.stderr);
    const composition = readJson(receiptOf(home)).composition;
    const moved = point === "upgrade:receipt-written";
    assert.equal(composition.store !== first.store, moved, "the receipt names the new store only once its write was made");
    // One pair: every hook command of the rows names the store the receipt names, and no other.
    const stores = readdirSync(dirname(dirname(kernelModuleDir(home, PACKAGED))));
    for (const row of composition.capabilityRuntime) for (const command of Object.values(row.hooks ?? {})) {
      assert.equal(command.includes(`/${composition.store}/`), true, command);
      for (const other of stores.filter((name) => name !== composition.store)) assert.equal(command.includes(`/${other}/`), false, command);
    }
    assert.match(readFileSync(join(kernelModuleDir(home, PACKAGED), "launch.mjs"), "utf8"), new RegExp(version.replaceAll(".", "\\.")));
    assert.equal(homeModulesProblem(home), null, "the kernel holds every copy the receipt names");
    // The kernel's side is whole: the home is read, and the interrupted upgrade is not resumed.
    assert.equal(fx.cli(["session", "inspect", "--home", home, "--json"]).json().ok, true);
    const again = fx.cli(["instance", "upgrade", "killed", "--plan-revision", planned.planRevision, "--idempotency-key", "kill-1", "--json"]).json();
    assert.deepEqual([again.ok, again.error?.code], [false, "E_UPGRADE_PARTIAL"]);
    assert.equal(readJson(receiptOf(home)).composition.store, composition.store);
  });
}

test("a retire removes the kernel's copies with the home, and one that does not finish leaves the home and the copies; the recovery it keeps holds none of them", async (t) => {
  const fx = providerDeployment(t, withHooked());
  const kept = await fx.launch("kept");
  const store = dirname(dirname(kernelModuleDir(kept.home, HOOKED)));
  // A retire that cannot finish (a capability's retire hook cannot be run: the kernel's copy of
  // it is gone): the home stays, and so do the kernel's copies of the others.
  rmSync(kernelModuleDir(kept.home, HOOKED), { recursive: true });
  writeFileSync(join(kept.home, "notes-of-mine.md"), "work\n");
  const refused = fx.cli(["retire", "kept", "--json"]);
  assert.match(`${refused.stdout}${refused.stderr}`, /the kernel's copy of capability acme\.hooked for kept is not at/);
  assert.deepEqual([existsSync(kept.home), existsSync(kernelModuleDir(kept.home, FAKE_CAPABILITY))], [true, true]);
  // One that finishes (forced), with work to recover: the copies go with the home, and the
  // recovery has none of the kernel's state.
  const retired = JSON.parse(fx.cli(["retire", "kept", "--force", "--json"]).stdout);
  assert.equal(retired.retired, "kept", JSON.stringify(retired));
  assert.deepEqual([existsSync(kept.home), existsSync(store)], [false, false]);
  const recovery = join(dirname(kept.home), ".oats-retirement", "recovery");
  const names = existsSync(recovery) ? execFileSync("find", [recovery], { encoding: "utf8" }) : "";
  assert.equal(names.includes(`${join(".oats-retirement", "modules")}`) || names.includes(basename(store)), false, "the recovery holds no kernel copy");
  assert.equal(existsSync(receiptOf(kept.home)), true, "the receipt outlives the retire, as before");
});

test("Git over a provider home's trees runs no hook and no file monitor the repository names: at the spawn, in status, at `oats worktree add` and `remove`, and at the retire", async (t) => {
  const fx = providerDeployment(t);
  // What an agent that can write its tree's repository could plant: hooks, and a file monitor
  // command. Each leaves a file named after itself when Git runs it.
  const marks = join(fx.fake, "git-ran");
  mkdirSync(marks, { recursive: true });
  const planted = (name) => `#!/bin/sh\n: > ${JSON.stringify(join(marks, name))}\n`;
  mkdirSync(join(fx.member, ".git", "hooks"), { recursive: true });
  for (const hook of ["post-checkout", "reference-transaction", "post-index-change", "pre-auto-gc", "post-merge"]) {
    writeFileSync(join(fx.member, ".git", "hooks", hook), planted(hook));
    chmodSync(join(fx.member, ".git", "hooks", hook), 0o755);
  }
  const monitor = join(fx.fake, "file-monitor");
  writeFileSync(monitor, planted("fsmonitor"));
  chmodSync(monitor, 0o755);
  git(fx.member, "config", "core.fsmonitor", monitor);
  const ran = () => readdirSync(marks).sort();
  const forget = () => { for (const name of readdirSync(marks)) rmSync(join(marks, name)); };
  // The plants are live: a plain Git in the clone runs them.
  execFileSync("git", ["-C", fx.member, "status", "--porcelain"], { env: fx.env, stdio: "ignore" });
  execFileSync("git", ["-C", fx.member, "update-ref", "refs/heads/planted-probe", "HEAD"], { env: fx.env, stdio: "ignore" });
  for (const plant of ["fsmonitor", "reference-transaction"]) assert.ok(ran().includes(plant), `a plain git runs the planted ${plant}`);
  forget();
  // The spawn makes the home's tree (a checkout: post-checkout, reference-transaction).
  const { home } = await fx.launch("planted", { work: "worktree" });
  assert.equal(existsSync(join(home, "work", ".git")), true);
  assert.deepEqual(ran(), [], "the spawn");
  // Reads: status, and the instance's git read.
  assert.equal(rowOf(fx, "planted").running, true);
  fx.cli(["instance", "git", "planted", "--json"]);
  assert.deepEqual(ran(), [], "status and the git read");
  // An extra tree, made and removed from the home.
  const inHome = { cwd: home, env: { OATS_INSTANCE_HOME: home } };
  const added = fx.cli(["worktree", "add", "--purpose", "extra", "--branch", "agents/planted-extra", "--base", "main", "--json"], inHome).json();
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(existsSync(join(home, ".work-extra", ".git")), true);
  assert.deepEqual(ran(), [], "oats worktree add");
  const removed = fx.cli(["worktree", "remove", "--purpose", "extra", "--json"], inHome).json();
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.deepEqual(ran(), [], "oats worktree remove");
  // The retire: the session is stopped, and the tree is read, then moved or removed.
  const retired = JSON.parse(fx.cli(["retire", "planted", "--json"]).stdout);
  assert.equal(retired.retired, "planted", JSON.stringify(retired));
  assert.equal(existsSync(home), false);
  assert.deepEqual(ran(), [], "the retire");
});

test("the launch input and the check's planned launch carry the home's trees: work/ alone for a home with no extra tree, work/ and each extra tree Git knows for one with some, and never what the home's record or a plain directory says", async (t) => {
  const fx = providerDeployment(t, { manifest: fakeManifest({ fake: fakeProvider({ check: true }) }) });
  const treesOf = (verb) => fx.verbs(verb).map((c) => (verb === "check" ? c.request.input.launch.trees : c.request.input.trees));
  // A directory home: work/ alone, at the spawn's check and at its launch.
  const plain = await fx.launch("no-trees");
  assert.deepEqual([treesOf("check"), treesOf("launch")], [[[join(plain.home, "work")]], [[join(plain.home, "work")]]]);
  // A home with a tree of its own and one extra tree.
  const { home } = await fx.launch("two-trees", { work: "worktree" });
  const inHome = { cwd: home, env: { OATS_INSTANCE_HOME: home } };
  const added = fx.cli(["worktree", "add", "--purpose", "docs", "--branch", "agents/two-trees-docs", "--base", "main", "--json"], inHome).json();
  assert.equal(added.ok, true, JSON.stringify(added));
  // What is NOT a tree: a plain directory with a tree's name, and a tree the home's record names.
  mkdirSync(join(home, ".work-plain"));
  writeFileSync(join(home, "instance.json"), JSON.stringify({ ...recordOf(home), trees: ["/etc"], extraTrees: ["/etc"] }));
  fx.clearCalls();
  await fx.inEnv(() => restartInstanceSession(home));
  const both = [join(home, "work"), join(home, ".work-docs")];
  assert.deepEqual([treesOf("check"), treesOf("launch")], [[both], [both]], "the check is told what the launch will be");
  // The extra tree removed: work/ alone again.
  assert.equal(fx.cli(["worktree", "remove", "--purpose", "docs", "--json"], inHome).json().ok, true);
  fx.clearCalls();
  await fx.inEnv(() => restartInstanceSession(home));
  assert.deepEqual([treesOf("check"), treesOf("launch")], [[[join(home, "work")]], [[join(home, "work")]]]);
});

for (const second of ["a provider home", "a tmux home"]) {
  test(`a spawn that reuses the name of a retired provider home is run by its own resolution, never by the receipt the retired home left: ${second}`, async (t) => {
    const fx = providerDeployment(t);
    const first = { server: "http://127.0.0.1:11" }, next = { server: "http://127.0.0.1:22" };
    const retired = await fx.launch("reuse", { work: "worktree", providers: { [FAKE_CAPABILITY]: first } });
    assert.equal(JSON.parse(fx.cli(["retire", "reuse", "--json"]).stdout).retired, "reuse");
    // A retire keeps the receipt, by the home's path: the next home of that name is at the same path.
    assert.deepEqual([existsSync(retired.home), existsSync(receiptOf(retired.home))], [false, true]);
    assert.deepEqual(readJson(receiptOf(retired.home)).composition.capabilityRuntime.find((row) => row.id === FAKE_CAPABILITY).settings, first);
    fx.clearCalls();
    const again = { work: "worktree", branch: "agents/reuse-again", providers: { [FAKE_CAPABILITY]: next } };
    const { home } = second === "a provider home" ? await fx.launch("reuse", again) : await fx.spawn("dev", { name: "reuse", ...again });
    assert.equal(home, retired.home);
    // Its spawn hooks ran with THIS spawn's settings (they run before this spawn's receipt is written).
    assert.deepEqual(fx.hooks("spawn").map((h) => [h.capability, JSON.parse(h.settings)]), [[FAKE_CAPABILITY, next]]);
    const receipt = readJson(receiptOf(home));
    if (second === "a provider home") {
      assert.deepEqual([...new Set(fx.verbs().map((c) => c.settings))].map((text) => JSON.parse(text)), [next], "and so did its provider's commands");
      assert.deepEqual(receipt.composition.capabilityRuntime.find((row) => row.id === FAKE_CAPABILITY).settings, next, "its receipt is its own");
    } else {
      assert.equal(Object.hasOwn(receipt, "composition"), false, "a tmux home's receipt records no composition, whatever was at its path");
      assert.equal(providerHomeTrust(home), null);
    }
  });
}

test("the kernel's copies are made once per spawn: a spawn undone after its provider launched keeps them as the spawn made them, not as the launch left the home's", async (t) => {
  const fx = providerDeployment(t, withHooked());
  const probe = await fx.launch("probe");
  const home = join(dirname(probe.home), "undone");
  const hook = join(copyOf(home, HOOKED), "bin", "hook.mjs");
  // What a session can do while it runs: write into a capability's copy. Here the provider's
  // launch does it (the fake appends to the file), and then fails, so the spawn is undone.
  fx.control({ undone: { launch: { touch: hook, exit: 1 } } });
  await assert.rejects(fx.launch("undone"));
  // The undo ran the capabilities' retire hooks from the kernel's copies, and took the home away.
  assert.equal(existsSync(home), false);
  assert.deepEqual(fx.hooks("retire").map((h) => [h.instance, h.capability]), [["undone", HOOKED]]);
  assert.equal(existsSync(kernelModuleDir(home, HOOKED)), false, "the kernel's copies went with it");
  assert.equal(readFileSync(join(kernelModuleDir(probe.home, HOOKED), "bin", "hook.mjs"), "utf8"), fakeFiles()["bin/hook.mjs"].replace('{ env: { ACME_FAKE_TOKEN_FILE: "/nowhere/token" }, ', "{ "));
});

test("an upgrade of a provider home takes its module set from the receipt: a module only the home's own record names refuses it, and is never written into the receipt or run", async (t) => {
  const { fx, home, plan, apply } = await upgradable(t, "adds");
  const before = readFileSync(receiptOf(home), "utf8");
  // The agent: a module of its own in its home, named in its own record with its own digest.
  const mine = copyOf(home, "acme.mine"), marker = join(fx.fake, "mine-ran");
  mkdirSync(join(mine, "bin"), { recursive: true });
  writeFileSync(join(mine, "oats.json"), JSON.stringify({ capability: "acme.mine", version: "1.0.0", description: "x", hooks: { launch: "bin/hook.mjs", retire: "bin/hook.mjs" } }));
  writeFileSync(join(mine, "bin", "hook.mjs"), marking(marker, 'console.log("{}");\n'));
  const record = recordOf(home);
  writeFileSync(join(home, "instance.json"), JSON.stringify({ ...record, modules: { ...record.modules, "acme.mine": { ...record.modules[FAKE_CAPABILITY], digest: contentDigest(mine) } } }, null, 2));
  const refused = (e) => e.code === "E_UPGRADE_INTEGRITY" && /the record adds acme\.mine/.test(e.message) && /no modules were upgraded/.test(e.message);
  await assert.rejects(plan(), refused);
  await assert.rejects(apply({ planRevision: "x".repeat(24), idempotencyKey: "adds-1" }), refused);
  assert.equal(readFileSync(receiptOf(home), "utf8"), before, "the receipt is as it was");
  // A module the record leaves out refuses it too.
  const { [PACKAGED]: _left, ...fewer } = record.modules;
  writeFileSync(join(home, "instance.json"), JSON.stringify({ ...record, modules: fewer }, null, 2));
  await assert.rejects(plan(), (e) => e.code === "E_UPGRADE_INTEGRITY" && /the record leaves out acme\.one/.test(e.message));
  // Where a module came from is the receipt's: a record that names another source changes nothing.
  writeFileSync(join(home, "instance.json"), JSON.stringify({ ...record, modules: { ...record.modules, [PACKAGED]: { ...record.modules[PACKAGED], from: { ...record.modules[PACKAGED].from, package: "acme.other" } } } }, null, 2));
  const planned = await plan();
  assert.deepEqual(planned.modules.map((m) => m.capability), [PACKAGED]);
  assert.equal((await apply({ planRevision: planned.planRevision, idempotencyKey: "adds-2" })).status, "complete");
  const after = readJson(receiptOf(home)).composition;
  assert.deepEqual([Object.keys(after.modules).sort(), after.capabilityRuntime.map((row) => row.id).sort(), after.modules[PACKAGED].from.package], [[FAKE_CAPABILITY, PACKAGED], [FAKE_CAPABILITY, PACKAGED], "acme.pkg"]);
  await fx.inEnv(() => startInstanceSession(home));
  assert.equal(existsSync(marker), false, "nothing of the agent's module ran");
});

test("an upgrade's copies are made beside the ones the receipt names: one that fails before the receipt is written leaves the old copies and the old rows, together, and nothing of its own", async (t) => {
  const { home } = await upgradable(t, "half");
  const storesOf = () => readdirSync(dirname(dirname(kernelModuleDir(home, PACKAGED)))).sort();
  const before = readFileSync(receiptOf(home), "utf8"), trust = providerHomeTrust(home), old = trust.composition.store;
  assert.deepEqual(storesOf(), [old]);
  const moved = new Set([PACKAGED]), rows = trust.composition.capabilityRuntime;
  // A copy that cannot be made (a module the home does not hold): nothing is left of the attempt.
  assert.throws(() => upgradedComposition(home, trust, { moved: new Set(["acme.absent"]), modules: { ...trust.composition.modules, "acme.absent": {} }, rows }));
  assert.deepEqual([storesOf(), readFileSync(receiptOf(home), "utf8")], [[old], before]);
  // The copies made, the receipt not yet written: the receipt names the old store, whose rows
  // name the old copies, and that is what the kernel runs.
  const next = upgradedComposition(home, trust, { moved, modules: trust.composition.modules, rows });
  assert.deepEqual([storesOf().length, next.store !== old, readFileSync(receiptOf(home), "utf8")], [2, true, before]);
  assert.equal(kernelModuleDir(home, PACKAGED), join(dirname(kernelModuleDir(home, PACKAGED)), PACKAGED));
  assert.equal(kernelModuleDir(home, PACKAGED).includes(old), true);
  for (const row of next.capabilityRuntime) for (const command of Object.values(row.hooks ?? {})) assert.equal(command.includes(next.store) && !command.includes(old), true, command);
  // What an interrupted upgrade left goes at the next prune; the store the receipt names stays.
  pruneModulesStores(home);
  assert.deepEqual(storesOf(), [old]);
});

test("readiness of a provider home says which of the home's copies differ from the ones the kernel runs: an added, optional key, and nothing on a status row", async (t) => {
  const fx = providerDeployment(t, withHooked());
  const { home } = await fx.launch("compared");
  const readiness = () => fx.cli(["readiness", "--home", home, "--json"]).json().result;
  const store = readJson(receiptOf(home)).composition.store;
  assert.deepEqual(readiness().kernelCopies, { store, differing: [] });
  writeFileSync(join(copyOf(home, HOOKED), "bin", "hook.mjs"), "// the agent's own\n");
  writeFileSync(join(copyOf(home), "bin", "added.mjs"), "");
  assert.deepEqual(readiness().kernelCopies, { store, differing: [{ capability: FAKE_CAPABILITY, differs: true }, { capability: HOOKED, differs: true }] });
  assert.equal(Object.hasOwn(rowOf(fx, "compared"), "kernelCopies"), false);
});

test("the launch input and the check's planned launch carry `protected`, the kernel's own state for the home, and the kernel has made that directory by the time it asks: on a deployment's first home, in every work mode", async (t) => {
  // The provider's command says, in its log, whether each path it was handed is a directory then.
  const files = fakeFiles();
  files["bin/session.mjs"] = `import { appendFileSync as noteSeen, statSync as seen } from "node:fs";
const asked = JSON.parse(await new Promise((done) => { let text = ""; process.stdin.on("data", (d) => { text += d; }); process.stdin.on("end", () => done(text)); }));
const handed = asked.verb === "check" ? asked.input.launch?.protected : asked.verb === "launch" ? asked.input.protected : null;
if (handed) noteSeen(process.env.HOME + "/fake-session/protected.log", JSON.stringify({ verb: asked.verb, protected: handed, directories: handed.map((path) => { try { return seen(path).isDirectory(); } catch { return false; } }) }) + "\\n");
process.stdout.write(JSON.stringify({ schemaVersion: 1, phase: "session", capability: asked.capability, provider: asked.provider, verb: asked.verb, ok: true, result: asked.verb === "check" ? { status: "ready", problems: [] } : asked.verb === "launch" ? { endpoint: { server: "http://127.0.0.1:1", threadId: "thr_first_1" } } : asked.verb === "stop" ? { stopped: true } : {} }) + "\\n");
`;
  for (const work of ["directory", "worktree"]) {
    const fx = providerDeployment(t, { capabilities: { [FAKE_CAPABILITY]: { manifest: fakeManifest({ fake: fakeProvider({ check: true, inspectMany: false }) }), files } } });
    const kept = join(fx.root, "dev", "instances", ".oats-retirement");
    assert.equal(existsSync(join(fx.root, "dev")) && existsSync(kept), false, "a fresh deployment: no home was ever spawned or retired here");
    const { home } = await fx.launch("first", { work });
    const seen = readFileSync(join(fx.fake, "protected.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(seen, [{ verb: "check", protected: [kept], directories: [true] }, { verb: "launch", protected: [kept], directories: [true] }], work);
    assert.equal(join(dirname(home), ".oats-retirement"), kept);
    assert.equal(kernelModuleDir(home, FAKE_CAPABILITY).startsWith(`${kept}/`), true, "the kernel's copies are under it");
  }
});

test("a provider home's status row, and a start's answer, say which copy of its modules the kernel runs and whether the home's own record of them is the receipt's: a top-level key, records only, and `modules` stays an array", async (t) => {
  const { fx, home, plan, apply } = await upgradable(t, "reported");
  const row = () => rowOf(fx, "reported");
  const same = { runs: "kernel-copy", homeCopy: "same", differs: [] };
  assert.deepEqual(row().moduleCopy, same);
  // `modules` is the array of drift rows it always was, with no key added to a row.
  assert.equal(Array.isArray(row().modules), true);
  assert.deepEqual(row().modules.map((m) => Object.keys(m).sort().join()), row().modules.map(() => "commit,current,from,name,status"));
  assert.deepEqual(row().modules.map((m) => m.name).sort(), [FAKE_CAPABILITY, PACKAGED]);
  // The files of a home copy are no part of it (readiness compares those): an edited copy reads the same.
  writeFileSync(join(copyOf(home, PACKAGED), "added.mjs"), "");
  assert.deepEqual(row().moduleCopy, same);
  rmSync(join(copyOf(home, PACKAGED), "added.mjs"));
  // The home's own record of a module is another: named.
  const record = recordOf(home);
  writeFileSync(join(home, "instance.json"), JSON.stringify({ ...record, modules: { ...record.modules, [PACKAGED]: { ...record.modules[PACKAGED], commit: "0".repeat(40) }, "acme.added": record.modules[FAKE_CAPABILITY] } }));
  assert.deepEqual(row().moduleCopy, { runs: "kernel-copy", homeCopy: "differs", differs: ["acme.added", PACKAGED] });
  assert.match(fx.cli(["status"]).stdout, /modules: the kernel runs its own copy; the home's own record differs for acme\.added, acme\.one/);
  // The names are the home's own to choose: only capability ids are named, and no more than a row may carry.
  const wild = Object.fromEntries([["\u001b[31mnot an id", {}], ["x".repeat(300), {}], ...Array.from({ length: 250 }, (_, n) => [`acme.n${String(n).padStart(3, "0")}`, {}])]);
  writeFileSync(join(home, "instance.json"), JSON.stringify({ ...record, modules: { ...record.modules, ...wild } }));
  const many = row().moduleCopy;
  assert.deepEqual([many.homeCopy, many.differs.length, many.differs.every((id) => /^[a-z0-9][a-z0-9._-]*$/.test(id) && id.length <= 200)], ["differs", 200, true]);
  const said = fx.cli(["status"]).stdout.split("\n").find((line) => line.includes("modules: the kernel runs its own copy"));
  assert.equal(/acme\.n000/.test(said) && !said.includes("\u001b") && !said.includes("x".repeat(250)), true, "the line names capability ids only: nothing else the home chose reaches the terminal by it");
  writeFileSync(join(home, "instance.json"), JSON.stringify(record));
  // After an upgrade, and at the start that follows it: the same again, on the row and in the answer.
  const planned = await plan();
  await apply({ planRevision: planned.planRevision, idempotencyKey: "reported-1" });
  assert.deepEqual(row().moduleCopy, same);
  const started = fx.cli(["session", "start", "--home", home, "--json"]).json();
  assert.deepEqual([started.ok, started.result.moduleCopy], [true, same]);
  // The clients' status reader takes the row as it took it before the key (packages/client).
  const document = JSON.parse(fx.cli(["status", "--json"]).stdout);
  const without = JSON.parse(JSON.stringify(document));
  for (const agent of without.agents) for (const instance of agent.instances) delete instance.moduleCopy;
  assert.deepEqual(deploymentStatusData(document, fx.dep), deploymentStatusData(without, fx.dep));
});

test("a remote row's moduleCopy is relayed only as this kernel reads it: the three keys, the two words, and a list that agrees with them", () => {
  const same = { runs: "kernel-copy", homeCopy: "same", differs: [] }, differs = { runs: "kernel-copy", homeCopy: "differs", differs: ["acme.one"] };
  assert.deepEqual([readModuleCopy(same), readModuleCopy(differs)], [same, differs]);
  assert.deepEqual(readModuleCopy({ ...same, homeCopy: "differs" }), { ...same, homeCopy: "differs" }, "differs with nothing named: the names were none a row may carry");
  for (const refused of [null, "same", [], {}, { ...same, extra: 1 }, { ...same, runs: "home-copy" }, { ...same, homeCopy: "other" }, { ...differs, homeCopy: "same" }, { ...differs, differs: [1] }, { ...differs, differs: [""] }, { ...differs, differs: ["\u001b[31mred"] }, { ...differs, differs: ["Has Space"] }, { ...differs, differs: "acme.one" }, { ...differs, differs: Array(201).fill("x") }]) {
    assert.equal(readModuleCopy(refused), undefined, JSON.stringify(refused)?.slice(0, 80));
  }
});

test("an upgrade of a provider home takes nothing of a row from the home: settings its own record names, and a manifest edited in its own copy of a module that does not move, change neither the upgrade hook's settings nor the receipt's rows nor the next launch", async (t) => {
  const settings = { server: "http://127.0.0.1:10" };
  const fx = providerDeployment(t, { files: packageFiles("1.0.0"), souls: { dev: { soul: { capabilities: { "oats.core": "off", [FAKE_CAPABILITY]: { from: "here" }, [PACKAGED]: { from: "package" } } } } } });
  fx.commit({ "oats-workspace.yaml": { yaml: { schemaVersion: 2, name: "acme", members: [fx.ref], defaults: { knowledge: "none", messaging: "none", tasks: "none" }, packages: { "acme.pkg": `git:${fx.key}@main` } } } });
  lockPackage(fx, "1.0.0");
  const { home } = await fx.launch("rows", { providers: { [FAKE_CAPABILITY]: settings } });
  const before = readJson(receiptOf(home)).composition;
  const rowOfReceipt = (composition, id) => composition.capabilityRuntime.find((row) => row.id === id);
  // The agent, while it runs: other settings in its record, and another manifest for the provider's
  // capability in its own copy (with its record's digest of that copy, so that the home's own
  // check of its copies passes).
  const manifestPath = join(copyOf(home), "oats.json"), manifest = readJson(manifestPath);
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, hooks: { launch: "bin/session.mjs AGENT-CHOSEN-ARGUMENT" }, environment: ["LD_PRELOAD", "ACME_FAKE_TOKEN_FILE"] }, null, 2));
  const record = recordOf(home);
  record.providers = { [FAKE_CAPABILITY]: { server: "http://forged.example" }, [PACKAGED]: { forged: true } };
  record.modules[FAKE_CAPABILITY].digest = contentDigest(copyOf(home));
  writeFileSync(join(home, "instance.json"), JSON.stringify(record, null, 2));
  await fx.inEnv(() => stopInstanceSession(home, {}));
  fx.commit(packageFiles("2.0.0"));
  lockPackage(fx, "2.0.0");
  const upgrade = (verb, opts = {}) => fx.inEnv(() => verb(fx.dep, fx.root, "rows", { remoteOptions: fx.remoteOptions, ...opts }));
  const planned = await upgrade(planUpgrade);
  assert.equal((await upgrade(applyUpgrade, { planRevision: planned.planRevision, idempotencyKey: "rows-1" })).status, "complete");
  const after = readJson(receiptOf(home)).composition;
  // The module that did not move: its row is the receipt's, as it was, naming the new store.
  const repointed = JSON.parse(JSON.stringify(rowOfReceipt(before, FAKE_CAPABILITY)).replaceAll(`/${before.store}/`, `/${after.store}/`));
  assert.deepEqual(rowOfReceipt(after, FAKE_CAPABILITY), repointed);
  assert.deepEqual(rowOfReceipt(after, FAKE_CAPABILITY).settings, settings);
  // The moved one: its hooks are its new manifest's, its settings the receipt's.
  assert.deepEqual([rowOfReceipt(after, PACKAGED).settings, rowOfReceipt(before, PACKAGED).settings], [{}, {}]);
  assert.match(rowOfReceipt(after, PACKAGED).hooks.launch, new RegExp(`/${after.store}/acme\\.one/launch\\.mjs`));
  // The upgrade hook was handed the receipt's settings, at the plan and at the apply.
  const hookSaw = readFileSync(join(fx.fake, "upgrade-hook.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual([...new Set(hookSaw.map((h) => h.phase))].sort(), ["apply", "plan"]);
  assert.deepEqual([...new Set(hookSaw.map((h) => h.settings))], ["{}"]);
  // And the next launch runs the spawn's hooks with the spawn's settings.
  fx.clearCalls();
  await fx.inEnv(() => startInstanceSession(home));
  assert.deepEqual(fx.hooks("launch").map((h) => [h.capability, JSON.parse(h.settings)]), [[FAKE_CAPABILITY, settings]]);
  assert.deepEqual([...new Set(fx.verbs().map((c) => c.settings))].map((text) => JSON.parse(text)), [settings]);
  assert.equal(fx.calls().some((c) => (c.argv ?? []).includes("AGENT-CHOSEN-ARGUMENT")), false);
});

test("a store is removed only once a move is complete: a second upgrade killed right after its receipt's write leaves every store a receipt has named, and the first move's undo target is still there", async (t) => {
  const { fx, home, plan, apply } = await upgradable(t, "thrice");
  const storesOf = () => readdirSync(dirname(dirname(kernelModuleDir(home, PACKAGED)))).sort();
  const first = readJson(receiptOf(home)).composition.store;
  const planned = await plan();
  await apply({ planRevision: planned.planRevision, idempotencyKey: "thrice-1" });
  const second = readJson(receiptOf(home)).composition.store;
  assert.deepEqual(storesOf(), [first, second].sort(), "after a complete move: the store it runs from, and the previous one");
  fx.commit(packageFiles("3.0.0"));
  lockPackage(fx, "3.0.0");
  const again = await plan();
  const killed = spawnSync(process.execPath, [CLI, "instance", "upgrade", "thrice", "--plan-revision", again.planRevision, "--idempotency-key", "thrice-2", "--json"], { cwd: fx.dep, env: { ...fx.env, OATS_TEST_PROVIDER_DIE_AT: "upgrade:receipt-written" }, encoding: "utf8" });
  assert.equal(killed.signal, "SIGKILL", killed.stdout + killed.stderr);
  const composition = readJson(receiptOf(home)).composition;
  assert.deepEqual([composition.previous.store, storesOf().length, storesOf().includes(first), storesOf().includes(second)], [second, 3, true, true], "nothing was removed before the move was complete");
  for (const store of [composition.store, composition.previous.store]) assert.equal(existsSync(join(dirname(dirname(kernelModuleDir(home, PACKAGED))), store, PACKAGED, "oats.json")), true);
  // A refused start says what to do with such a home, and it can be done.
  const start = fx.cli(["session", "start", "--home", home, "--json"]).json();
  assert.deepEqual([start.ok, start.error.code], [false, "E_UPGRADE_PARTIAL"]);
  assert.match(start.error.message, /is on a session provider, whose interrupted upgrade is not resumed: retire the instance \(oats retire thrice\) and spawn it again/);
  assert.equal(JSON.parse(fx.cli(["retire", "thrice", "--json"]).stdout).retired, "thrice");
  assert.equal(existsSync(dirname(dirname(kernelModuleDir(home, PACKAGED)))), false);
});

test("a failed upgrade of a provider home puts its receipt back whole from the kernel's own memory of it: a copy of the receipt rewritten in the home's staging while the upgrade ran changes nothing", async (t) => {
  const { fx, home, plan, apply } = await upgradable(t, "rolled-back");
  // The version to move to: its apply hook does what a process left in the home could do while
  // the upgrade runs (it rewrites the copy of the receipt the upgrade keeps in the home's
  // staging, to one that names no session provider), and then refuses.
  const files = packageFiles("4.0.0");
  files[`oats-package/capabilities/${PACKAGED}/upgrade.mjs`] = `import { readdirSync, writeFileSync } from "node:fs"; import { join } from "node:path";
if (process.env.OATS_UPGRADE_PHASE === "plan") { console.log(JSON.stringify({ adopt: true })); process.exit(0); }
const oats = join(process.env.OATS_INSTANCE_HOME, ".oats");
for (const name of readdirSync(oats).filter((n) => n.startsWith(".staging-upgrade-"))) writeFileSync(join(oats, name, "retirement-baseline.json"), JSON.stringify({ version: 2, home: process.env.OATS_INSTANCE_HOME, runtime: { launched: false } }));
process.exit(1);
`;
  fx.commit(files);
  lockPackage(fx, "4.0.0");
  const before = readFileSync(receiptOf(home), "utf8");
  const planned = await plan();
  await assert.rejects(apply({ planRevision: planned.planRevision, idempotencyKey: "rolled-1" }), (e) => e.code === "E_UPGRADE_REFUSED");
  assert.equal(readFileSync(receiptOf(home), "utf8"), before, "the receipt is byte for byte what it was");
  assert.notEqual(providerHomeTrust(home), null, "the home is still a provider home");
  assert.equal(readdirSync(dirname(dirname(kernelModuleDir(home, PACKAGED)))).length, 1, "the store the failed move made is gone, and no other");
  assert.match(readFileSync(join(kernelModuleDir(home, PACKAGED), "launch.mjs"), "utf8"), /1\.0\.0/);
  // The home starts on what it had.
  await fx.inEnv(() => startInstanceSession(home));
  assert.equal(fx.cli(["session", "inspect", "--home", home, "--json"]).json().result.running, true);
});

test("an undo of a provider home goes back to what the receipt says the last move was: a home whose own record names another set of modules undoes nothing", async (t) => {
  const { home, plan, apply } = await upgradable(t, "undo-set");
  const planned = await plan();
  await apply({ planRevision: planned.planRevision, idempotencyKey: "set-1" });
  const receipt = readFileSync(receiptOf(home), "utf8");
  // The home's record no longer says its packaged module was moved.
  const record = recordOf(home), { previous: _dropped, ...withoutPrevious } = record.modules[PACKAGED];
  writeFileSync(join(home, "instance.json"), JSON.stringify({ ...record, modules: { ...record.modules, [PACKAGED]: withoutPrevious } }, null, 2));
  await assert.rejects(plan({ undo: true }), (e) => e.code === "E_UPGRADE_UNDO");
  assert.equal(readFileSync(receiptOf(home), "utf8"), receipt);
  // With the record as the move left it, the undo's hook is told the receipt's record of where it goes back to.
  writeFileSync(join(home, "instance.json"), JSON.stringify(record, null, 2));
  const back = await plan({ undo: true });
  assert.deepEqual(back.modules.map((m) => m.capability), [PACKAGED]);
});

// A hook that says where its own file is: the kernel's copy, or the home's.
const WHERE_HOOK = `import { appendFileSync } from "node:fs"; import { fileURLToPath } from "node:url";
appendFileSync(process.env.HOME + "/fake-session/where.log", JSON.stringify({ event: process.env.OATS_EVENT, instance: process.env.OATS_INSTANCE, at: fileURLToPath(import.meta.url) }) + "\\n");
process.stdout.write("{}\\n");
`;
const withWhere = (hooks = { spawn: "bin/hook.mjs", launch: "bin/hook.mjs", retire: "bin/hook.mjs", worktree: "bin/hook.mjs" }) => ({
  capabilities: { [HOOKED]: { manifest: { hooks }, files: { "bin/hook.mjs": WHERE_HOOK } } },
  souls: { dev: { soul: { capabilities: { [FAKE_CAPABILITY]: { from: "here" }, [HOOKED]: { from: "here" } } } } },
});
const whereOf = (fx) => (existsSync(join(fx.fake, "where.log")) ? readFileSync(join(fx.fake, "where.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);

for (const work of ["directory", "worktree"]) {
  test(`every hook of a provider home runs from the kernel's copy from the spawn on, so a path a hook hands the harness is the kernel's: the spawn's hooks, its worktree hooks, a launch's and a retire's (${work})`, async (t) => {
    const fx = providerDeployment(t, withWhere());
    const { home } = await fx.launch("located", { work });
    const kept = kernelModuleDir(home, HOOKED);
    await fx.inEnv(() => restartInstanceSession(home));
    assert.equal(JSON.parse(fx.cli(["retire", "located", "--json"]).stdout).retired, "located");
    const ran = whereOf(fx).filter((h) => h.instance === "located");
    assert.deepEqual([...new Set(ran.map((h) => h.event))].sort(), work === "worktree" ? ["launch", "retire", "spawn", "worktree"] : ["launch", "retire", "spawn"]);
    for (const hook of ran) assert.equal(hook.at, join(kept, "bin", "hook.mjs"), `the ${hook.event} hook ran from ${hook.at}`);
  });
}

test("a provider spawn that fails after its launch and whose work cannot be preserved keeps a provider receipt: the home is still run by the kernel's copies, and an edited hook of the home's own copy does not run at its retire", async (t) => {
  // The spawn hook leaves in work/ what a recovery copy cannot take (a FIFO); the launch answers
  // nothing usable, so the spawn is undone, cannot preserve work/, and retains the home.
  const hook = `import { execFileSync } from "node:child_process"; import { appendFileSync } from "node:fs";
if (process.env.OATS_EVENT === "spawn") execFileSync("mkfifo", [process.env.OATS_INSTANCE_HOME + "/work/pipe"]);
appendFileSync(process.env.HOME + "/fake-session/retained.log", process.env.OATS_EVENT + "\\n");
process.stdout.write("{}\\n");
`;
  const fx = providerDeployment(t, { capabilities: { [HOOKED]: { manifest: { hooks: { spawn: "bin/hook.mjs", retire: "bin/hook.mjs" } }, files: { "bin/hook.mjs": hook } } },
    souls: { dev: { soul: { capabilities: { [FAKE_CAPABILITY]: { from: "here" }, [HOOKED]: { from: "here" } } } } } });
  fx.control({ launch: { raw: "garbage" } });
  await assert.rejects(fx.launch("kept"));
  const home = join(fx.root, "dev", "instances", "kept");
  assert.equal(existsSync(home), true, "the home is retained");
  const receipt = readJson(receiptOf(home));
  assert.deepEqual([receipt.runtime.provider, receipt.runtime.backend, typeof receipt.composition?.store], [FAKE_CAPABILITY, "fake", "string"], "its receipt still names its provider, and its composition");
  assert.notEqual(providerHomeTrust(home), null);
  assert.equal(homeModulesProblem(home), null, "and the kernel still holds its copies");
  // The agent's copy of the hook, edited: it would leave a mark.
  const marker = join(fx.fake, "retained-edited-ran");
  writeFileSync(join(copyOf(home, HOOKED), "bin", "hook.mjs"), marking(marker, hook));
  rmSync(join(home, "work", "pipe"));
  fx.control({});
  fx.cli(["retire", "kept", "--force", "--json"]);
  assert.equal(existsSync(marker), false, "the home's own copy was not run");
});

test("a provider home whose own modules directory is gone is run as before: the kernel reads its copies, not the home's", async (t) => {
  const fx = providerDeployment(t, withHooked());
  const { home } = await fx.launch("emptied");
  rmSync(join(home, ".oats", "modules"), { recursive: true });
  fx.clearCalls();
  assert.equal(fx.cli(["session", "inspect", "--home", home, "--json"]).json().result.running, true);
  await fx.inEnv(() => restartInstanceSession(home));
  assert.deepEqual([fx.verbs("launch").length, fx.hooks("launch").map((h) => h.capability).sort()], [1, [FAKE_CAPABILITY, HOOKED]]);
  // (Its files are compared by readiness, which says so; its record of them is still the kernel's.)
  const compared = fx.cli(["readiness", "--home", home, "--json"]).json().result.kernelCopies.differing;
  assert.deepEqual(compared.map((d) => d.capability).sort(), [FAKE_CAPABILITY, HOOKED]);
});

test("readiness and inspect of a provider home take its modules from the receipt: a home whose own modules directory and record of them are gone answers as before", async (t) => {
  const fx = providerDeployment(t, { manifest: fakeManifest({ fake: fakeProvider({ check: true }) }) });
  const { home } = await fx.launch("unlisted");
  const before = fx.cli(["readiness", "--home", home, "--json"]).json().result;
  rmSync(join(home, ".oats", "modules"), { recursive: true });
  writeFileSync(join(home, "instance.json"), JSON.stringify({ ...recordOf(home), modules: {} }));
  fx.clearCalls();
  const after = fx.cli(["readiness", "--home", home, "--json"]).json().result;
  assert.deepEqual(after.checks.providers, before.checks.providers, "the provider's readiness is asked and answered as before");
  assert.deepEqual(fx.verbs("check").length, 1);
  assert.deepEqual(after.kernelCopies.differing, [{ capability: FAKE_CAPABILITY, differs: null }], "its own copy is not there to compare");
});
