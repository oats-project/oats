// The kernel's part of a provider home's integrity (docs/capabilities.md "Session providers", "What
// the kernel trusts in a provider home"): nothing the home's agent can write is run, or read as
// configuration, by the kernel. Every home here is a real spawn through the kernel on the fake
// provider (test/helpers/session-provider-fixture.mjs); a tmux home's side is in the tmux tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inputInstanceSession, restartInstanceSession, startInstanceSession, stopInstanceSession } from "../lib/core.mjs";
import { applyUpgrade, planUpgrade } from "../lib/instance-upgrade.mjs";
import { writeLock } from "../lib/packages.mjs";
import { contentDigest } from "../lib/remote.mjs";
import { git } from "./helpers/v2-deployment.mjs";
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
    [`${base}/upgrade.mjs`]: 'console.log(JSON.stringify(process.env.OATS_UPGRADE_PHASE === "plan" ? { adopt: true } : { meta: {} }));\n',
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

test("an upgrade of a provider home rewrites the receipt's record in the step that moves the copies: the moved module and its row are the new ones, the others as recorded, and the home's calls and hooks go on", async (t) => {
  const { fx, home, plan, apply, ran } = await upgradable(t, "moved");
  const before = readJson(receiptOf(home)).composition;
  const planned = await plan();
  assert.deepEqual(planned.modules.map((m) => m.capability), [PACKAGED]);
  const done = await apply({ planRevision: planned.planRevision, idempotencyKey: "move-1" });
  assert.equal(done.status, "complete");
  const after = readJson(receiptOf(home)).composition;
  assert.deepEqual(after.modules[FAKE_CAPABILITY], before.modules[FAKE_CAPABILITY], "a module that did not move is as it was recorded");
  assert.notEqual(after.modules[PACKAGED].digest, before.modules[PACKAGED].digest);
  assert.deepEqual(after.modules[PACKAGED], moduleCopyDigest(copyOf(home, PACKAGED)), "the moved module is recorded as its copy is");
  assert.deepEqual(after.capabilityRuntime, recordOf(home).capabilityRuntime, "the rows are the ones the upgrade derived");
  assert.match(after.capabilityRuntime.find((row) => row.id === PACKAGED).hooks.launch, /launch\.mjs/);
  assert.equal(homeModulesProblem(home), null);
  // The home starts: the provider is called, and the moved capability's NEW hook runs.
  fx.clearCalls();
  await fx.inEnv(() => startInstanceSession(home));
  assert.deepEqual([fx.verbs("launch").length, ran().at(-1)], [1, "2.0.0"]);
  assert.equal(fx.cli(["session", "inspect", "--home", home, "--json"]).json().result.running, true);
});

test("an upgrade of a provider home starts only from copies the receipt records, is not undone from the home's kept copies, and is not resumed from the home's journal", async (t) => {
  const { fx, home, plan, apply } = await upgradable(t, "guarded");
  const before = readFileSync(receiptOf(home), "utf8");
  // A copy that is not the spawn's: refused at the plan and at the apply, and nothing is moved or kept.
  const hook = join(copyOf(home, PACKAGED), "launch.mjs"), original = readFileSync(hook, "utf8");
  writeFileSync(hook, marking(join(fx.fake, "kept-edited"), original));
  await assert.rejects(plan(), (e) => e.code === "E_UPGRADE_INTEGRITY" && e.message.match(NOT_THE_SPAWNS)?.[1] === "acme.one" && /no modules were upgraded/.test(e.message));
  await assert.rejects(apply({ planRevision: "x".repeat(24), idempotencyKey: "guard-1" }), (e) => e.code === "E_UPGRADE_INTEGRITY");
  assert.equal(existsSync(join(home, ".oats", "previous")), false, "no copy of the edited module was kept");
  writeFileSync(hook, original);
  // Undo: refused for a provider home, before and after a move.
  await assert.rejects(plan({ undo: true }), (e) => e.code === "E_UPGRADE_UNDO" && /is on a session provider/.test(e.message));
  const planned = await plan();
  await apply({ planRevision: planned.planRevision, idempotencyKey: "guard-2" });
  await assert.rejects(plan({ undo: true }), (e) => e.code === "E_UPGRADE_UNDO");
  assert.notEqual(readFileSync(receiptOf(home), "utf8"), before);
  // A journal in the home that says an upgrade is partial: not resumed.
  const journal = join(home, ".oats", "upgrade-receipt.guard-2.json");
  writeFileSync(journal, JSON.stringify({ ...readJson(journal), status: "partial", step: "swap" }));
  await assert.rejects(apply({ planRevision: planned.planRevision, idempotencyKey: "guard-2" }), (e) => e.code === "E_UPGRADE_PARTIAL" && /is not resumed from the journal in its home/.test(e.message));
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
