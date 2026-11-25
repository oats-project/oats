// Session providers: the manifest's `sessionProviders` (its validator, the published schema, what
// `oats capabilities show` and `oats inspect` answer), the feature and the routed gate, the same
// name declared twice, and what a kernel from before the contract does with a provider home that
// was never launched. The verbs are in session-providers.test.mjs; a launched provider home under
// the older kernel is T10 (session-provider-older-kernel.test.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KERNEL_FEATURES } from "../lib/kernel-features.mjs";
import { checkRemoteSupport } from "../lib/servers.mjs";
import { ENDPOINT_MAX_BYTES, judgeInspect, offeredSessionProviders, providerRuntimeOf, relayedProviderRow, rowSession, selectSessionBackend, sessionProviderTimeout, sessionProvidersOf, validEndpoint, withoutRelayedEndpoint } from "../lib/session-providers.mjs";
import { FAKE_CAPABILITY, fakeFiles, fakeManifest, fakeProvider, providerDeployment } from "./helpers/session-provider-fixture.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMMANDS = { "session-launch": "bin/session.mjs launch", "session-inspect": "bin/session.mjs inspect", "session-input": "bin/session.mjs input", "session-stop": "bin/session.mjs stop", "session-inspect-many": "bin/session.mjs inspectMany" };
const manifest = (sessionProviders, commands = COMMANDS) => ({ capability: "acme.fake", version: "1.0.0", compatibility: { oats: ">=0.6.2" }, description: "x", commands, sessionProviders });
const sound = fakeProvider();
/** The kernel at main before the session-provider contract, from Git (as T10 takes it,
 *  session-provider-older-kernel.test.mjs) → its CLI. */
const PRE_CONTRACT = "e5b6c5ac4f3eabbb73990d9c2a4c0c3ca14ca422";
function preContractKernel(t) {
  const dir = mkdtempSync(join(tmpdir(), "oats-pre-contract-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tar = join(dir, "kernel.tar");
  try { execFileSync("git", ["-C", REPO, "archive", "--format=tar", "-o", tar, PRE_CONTRACT, "--", "bin", "lib", "share", "skills", "injects", "docs", "package.json", "package-catalog.json", "packages/record", "packages/client", "packages/tui"], { stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { assert.fail(`this test runs the kernel at ${PRE_CONTRACT}, which this clone's history must hold (a shallow clone does not: git fetch --unshallow): ${String(e.stderr ?? e.message).trim()}`); }
  execFileSync("tar", ["-xf", tar, "-C", dir]);
  symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
  return join(dir, "bin", "oats.mjs");
}

test("sessionProviders: a sound provider is normalized; each rule's breach is one problem with its pointer", async () => {
  const { default: Ajv2020 } = await import("ajv/dist/2020.js");
  const validate = new Ajv2020({ strict: false, allowUnionTypes: true }).compile(JSON.parse(readFileSync(join(REPO, "docs", "capability-manifest.schema.json"), "utf8")));
  const ok = sessionProvidersOf(manifest({ fake: sound }));
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.providers.fake, {
    name: "fake", description: "A fake session backend for tests", harnesses: ["claude"], wire: "1.3",
    commands: {
      launch: { command: "session-launch", script: "bin/session.mjs", args: ["launch"] }, inspect: { command: "session-inspect", script: "bin/session.mjs", args: ["inspect"] },
      input: { command: "session-input", script: "bin/session.mjs", args: ["input"] }, stop: { command: "session-stop", script: "bin/session.mjs", args: ["stop"] },
      inspectMany: { command: "session-inspect-many", script: "bin/session.mjs", args: ["inspectMany"] },
    },
  });
  assert.deepEqual(Object.keys(sessionProvidersOf(manifest({ fake: fakeProvider({ inspectMany: false }) })).providers.fake.commands), ["launch", "inspect", "input", "stop"], "inspectMany is optional");
  const withCheck = sessionProvidersOf(manifest({ fake: fakeProvider({ check: true }) }, { ...COMMANDS, "session-check": "bin/session.mjs check" }));
  assert.deepEqual([withCheck.problems, withCheck.providers.fake.commands.check], [[], { command: "session-check", script: "bin/session.mjs", args: ["check"] }], "so is check, the provider's readiness");
  assert.equal(validate(JSON.parse(JSON.stringify(manifest({ fake: fakeProvider({ check: true }) }, { ...COMMANDS, "session-check": "bin/session.mjs check" })))), true);
  assert.equal(sessionProvidersOf(manifest({ fake: { harnesses: ["claude"], commands: sound.commands } })).providers.fake.description, null, "so is the description");
  // `wire`: any version is a sound declaration (one that is not this kernel's is refused where the provider is used); none is null.
  assert.deepEqual([sessionProvidersOf(manifest({ fake: { ...sound, wire: "2.0" } })).providers.fake.wire, sessionProvidersOf(manifest({ fake: { harnesses: ["claude"], commands: sound.commands } })).providers.fake.wire], ["2.0", null]);
  for (const wire of ["1", "v1.3", 1.3, "1.3.0", ""]) {
    const bad = { ...manifest({ fake: { ...sound, wire } }) };
    assert.deepEqual(sessionProvidersOf(bad).problems.map((p) => p.pointer), ["/sessionProviders/fake/wire"], JSON.stringify(wire));
    assert.equal(validate(JSON.parse(JSON.stringify(bad))), false, `the schema refuses wire ${JSON.stringify(wire)} too`);
  }
  for (const nothing of [undefined, null, 7, "x", [], {}, { capability: "acme.x" }]) assert.deepEqual(sessionProvidersOf(nothing), { providers: {}, problems: [] });

  assert.equal(validate(manifest({ fake: sound })), true, JSON.stringify(validate.errors));

  // [what, the declaration, the pointer of its problem, whether the published schema can say it]
  const breaches = [
    ["the built-in backend's name", { tmux: sound }, "/sessionProviders/tmux", true],
    ["the removed backend's name", { herdr: sound }, "/sessionProviders/herdr", true],
    ["the word for any session provider", { "session-provider": sound }, "/sessionProviders/session-provider", true],
    ["a name with a capital", { Fake: sound }, "/sessionProviders/Fake", true],
    ["a name of 41 characters", { ["a".repeat(41)]: sound }, `/sessionProviders/${"a".repeat(41)}`, true],
    ["a provider that is no object", { fake: "bin/session.mjs" }, "/sessionProviders/fake", true],
    ["an unknown key", { fake: { ...sound, server: "http://x" } }, "/sessionProviders/fake/server", true],
    ["no harnesses", { fake: { commands: sound.commands } }, "/sessionProviders/fake/harnesses", true],
    ["an empty harness list", { fake: { ...sound, harnesses: [] } }, "/sessionProviders/fake/harnesses", true],
    ["a harness listed twice", { fake: { ...sound, harnesses: ["claude", "claude"] } }, "/sessionProviders/fake/harnesses/1", true],
    ["a harness that is no name", { fake: { ...sound, harnesses: ["Claude Code"] } }, "/sessionProviders/fake/harnesses/0", true],
    ["no commands", { fake: { harnesses: ["claude"] } }, "/sessionProviders/fake/commands", true],
    ["a missing verb", { fake: { ...sound, commands: { ...sound.commands, stop: undefined } } }, "/sessionProviders/fake/commands/stop", true],
    ["an unknown verb", { fake: { ...sound, commands: { ...sound.commands, archive: "session-stop" } } }, "/sessionProviders/fake/commands/archive", true],
    ["a verb that names no manifest command", { fake: { ...sound, commands: { ...sound.commands, input: "session-tell" } } }, "/sessionProviders/fake/commands/input", false],
    ["a verb that is a script path", { fake: { ...sound, commands: { ...sound.commands, launch: "bin/session.mjs" } } }, "/sessionProviders/fake/commands/launch", false],
    ["a description of two lines", { fake: { ...sound, description: "one\ntwo" } }, "/sessionProviders/fake/description", true],
    ["a description over 200 characters", { fake: { ...sound, description: "x".repeat(201) } }, "/sessionProviders/fake/description", true],
  ];
  for (const [what, declared, pointer, inSchema] of breaches) {
    const found = sessionProvidersOf(manifest(declared));
    assert.deepEqual(found.providers, {}, what);
    assert.deepEqual(found.problems.map((p) => p.pointer), [pointer], what);
    assert.equal(found.problems[0].provider, Object.keys(declared)[0], what);
    if (inSchema) assert.equal(validate(JSON.parse(JSON.stringify(manifest(declared)))), false, `the schema refuses ${what}`);
  }
  // A problem inside one provider disables that provider only; a malformed top level every one.
  const mixed = sessionProvidersOf(manifest({ fake: sound, broken: { harnesses: [] } }));
  assert.deepEqual([Object.keys(mixed.providers), mixed.problems.map((p) => p.provider)], [["fake"], ["broken", "broken"]]);
  for (const top of [[], "fake", 7, null]) assert.deepEqual(sessionProvidersOf(manifest(top)), { providers: {}, problems: [{ provider: null, pointer: "/sessionProviders", message: "sessionProviders must be an object of named session providers" }] });
  const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`p${i}`, sound]));
  assert.deepEqual(sessionProvidersOf(manifest(many)).problems.map((p) => p.message), ["sessionProviders declares 17 providers; at most 16"]);
});

test("selectSessionBackend: tmux is the kernel's; a provider is resolved among the instance's capabilities, for its harness", () => {
  const caps = [{ id: "acme.fake", manifest: manifest({ fake: sound, both: fakeProvider({ harnesses: ["claude", "pi"] }) }) }, { id: "acme.plain", manifest: { capability: "acme.plain" } }];
  for (const name of [undefined, null, "tmux"]) assert.deepEqual(selectSessionBackend(name, caps, "pi"), { backend: "tmux" });
  const selected = selectSessionBackend("fake", caps, "claude");
  assert.deepEqual([selected.backend, selected.capability, selected.provider.harnesses], ["fake", "acme.fake", ["claude"]]);
  assert.equal(selectSessionBackend("both", caps, "pi").capability, "acme.fake");
  assert.throws(() => selectSessionBackend("fake", caps, "pi"), (e) => e.code === "E_BACKEND_HARNESS" && /does not run the pi harness; it runs claude; nothing was created/.test(e.message));
  assert.throws(() => selectSessionBackend("nope", caps, "claude"), (e) => e.code === "E_BACKEND_UNKNOWN" && JSON.stringify(e.details) === JSON.stringify({ backend: "nope", available: ["tmux", "both", "fake"] }));
  assert.throws(() => selectSessionBackend("fake", [], "claude"), (e) => e.code === "E_BACKEND_UNKNOWN" && JSON.stringify(e.details.available) === JSON.stringify(["tmux"]));
  // A malformed declaration cannot be selected, and the refusal says what is wrong with it.
  const broken = [{ id: "acme.fake", manifest: manifest({ fake: { ...sound, harnesses: [] } }) }];
  assert.throws(() => selectSessionBackend("fake", broken, "claude"), (e) => e.code === "E_BACKEND_UNKNOWN" && /capability acme\.fake declares it malformed: session provider "fake": harnesses must list 1 to 16 harness names \(at \/sessionProviders\/fake\/harnesses\)/.test(e.message));
  assert.deepEqual(offeredSessionProviders(caps).providers.map((p) => [p.name, p.capability, p.harnesses]), [["both", "acme.fake", ["claude", "pi"]], ["fake", "acme.fake", ["claude"]]]);
});

test("the records' and the answers' rules: an endpoint, a receipt's runtime, an inspect answer, a relayed row", () => {
  assert.equal(ENDPOINT_MAX_BYTES, 4096);
  assert.equal(validEndpoint({ server: "http://127.0.0.1:38886", projectId: "proj_1", threadId: "thr_1" }), true);
  assert.equal(validEndpoint({}), true);
  // The bound is on the canonical JSON: {"blob":"…"} is 11 bytes around its value.
  assert.equal(validEndpoint({ blob: "x".repeat(4096 - 11) }), true);
  assert.equal(validEndpoint({ blob: "x".repeat(4096 - 10) }), false);
  assert.equal(validEndpoint({ b: 1, a: { d: [1, 2], c: null } }), true, "any JSON below the object");
  for (const no of [null, undefined, "thr_1", 7, ["thr_1"], true]) assert.equal(validEndpoint(no), false, JSON.stringify(no));

  const runtime = { launched: true, backend: "fake", provider: "acme.fake", endpoint: { threadId: "thr_1" }, stoppedAt: null };
  assert.deepEqual(providerRuntimeOf(runtime), { ...runtime, launchSent: null });
  // `launchSent`: a launch that was sent and has no recorded outcome; an instant, or the receipt is no authority.
  assert.equal(providerRuntimeOf({ ...runtime, launchSent: "2026-11-20T10:00:00.000Z" }).launchSent, "2026-11-20T10:00:00.000Z");
  assert.equal(providerRuntimeOf({ ...runtime, launchSent: "soon" }), undefined);
  assert.equal(providerRuntimeOf({ ...runtime, stoppedAt: "2026-11-19T10:00:00.000Z" }).stoppedAt, "2026-11-19T10:00:00.000Z");
  const { stoppedAt: _a, ...bare } = runtime;
  assert.deepEqual(providerRuntimeOf(bare), { ...runtime, launchSent: null }, "a receipt without stoppedAt was never stopped");
  for (const [what, broken] of [
    ["not launched", { ...runtime, launched: false }], ["a tmux endpoint beside it", { ...runtime, tmux: { session: "s", window: "w", socket: "/x" } }],
    ["a Herdr target", { ...runtime, sessionTarget: {} }], ["the built-in backend's name", { ...runtime, backend: "tmux" }], ["the word for any provider as a backend", { ...runtime, backend: "session-provider" }], ["no backend", { ...runtime, backend: undefined }],
    ["a capability id with a path", { ...runtime, provider: "../../etc" }], ["no endpoint", { ...runtime, endpoint: null }],
    ["an endpoint over the bound", { ...runtime, endpoint: { blob: "x".repeat(5000) } }], ["a stoppedAt that is no instant", { ...runtime, stoppedAt: "yesterday" }],
  ]) assert.equal(providerRuntimeOf(broken), undefined, what);

  const open = { label: "Open in bb", url: "http://127.0.0.1:38886/t/thr_1" };
  assert.deepEqual(judgeInspect({ present: true, state: "unknown", running: null, open }), { present: true, state: "unknown", running: null, open });
  assert.deepEqual(judgeInspect({ present: false, state: "stopped", running: false }), { present: false, state: "stopped", running: false, open: null });
  for (const [what, answer] of [
    ["a missing key", { present: true, state: "unknown" }], ["present that is no boolean", { present: "yes", state: "unknown", running: true }],
    ["a state outside the words", { present: true, state: "idle", running: null }], ["running that is a string", { present: true, state: "unknown", running: "true" }],
    ["an unknown key", { present: true, state: "unknown", running: true, size: { cols: 80, rows: 24 } }], ["an open that is a string", { present: true, state: "unknown", running: true, open: "http://x" }],
    ["an open with credentials", { present: true, state: "unknown", running: true, open: { label: "x", url: "https://user:pw@example.org/" } }],
    ["an open with a control character in its label", { present: true, state: "unknown", running: true, open: { label: "x\u001b[2J", url: "https://example.org/" } }],
    ["an open with a file URL", { present: true, state: "unknown", running: true, open: { label: "x", url: "file:///etc/passwd" } }],
    ["an open with an extra key", { present: true, state: "unknown", running: true, open: { ...open, icon: "x" } }],
    ["no object", null],
  ]) assert.equal(judgeInspect(answer), null, what);

  // A remote roster's row: relayed in the kernel's own shapes only, and never its locator.
  const row = { instance: "dev-a", backend: "bb", session: { provider: "oats.bb", threadId: "thr_1", endpoint: { threadId: "thr_1" } }, tmux: null, open, running: null, runtimeState: "unknown" };
  assert.deepEqual(relayedProviderRow(row), { backend: "bb", session: { provider: "oats.bb" }, open, runtimeState: "unknown" });
  assert.deepEqual(relayedProviderRow({ ...row, open: { label: "x", url: "javascript:1" }, runtimeState: "exploded", session: { provider: "oats.bb" } }), { backend: "bb", session: { provider: "oats.bb" }, open: null });
  for (const [what, other] of [["a tmux row", { ...row, backend: "tmux", tmux: { session: "s", window: "w" } }], ["a row that says tmux and a session", { ...row, tmux: { session: "s", window: "w" } }], ["no session", { ...row, session: undefined }], ["a backend that is no name", { ...row, backend: "BB!" }], ["a provider that is a path", { ...row, session: { provider: "../x" } }]]) assert.equal(relayedProviderRow(other), null, what);
  // A local row's session: the capability and, when the endpoint names one, the thread id alone.
  assert.deepEqual(rowSession("oats.bb", { server: "http://127.0.0.1:38886", projectId: "proj_1", threadId: "thr_1" }), { provider: "oats.bb", threadId: "thr_1" });
  for (const endpoint of [null, {}, { threadId: 7 }, { threadId: "" }, { threadId: "x".repeat(201) }, { threadId: "thr\u001b[2J" }, { thread: "thr_1" }]) assert.deepEqual(rowSession("oats.bb", endpoint), { provider: "oats.bb" }, JSON.stringify(endpoint));
  assert.deepEqual(withoutRelayedEndpoint({ instance: "a", session: { provider: "oats.bb", endpoint: { threadId: "thr_1" } } }), { instance: "a", session: { provider: "oats.bb" } });
  for (const other of [{ instance: "a" }, { session: null }, { session: "tmux" }, null, "x"]) assert.deepEqual(withoutRelayedEndpoint(other), other);

  assert.deepEqual([sessionProviderTimeout("launch"), sessionProviderTimeout("inspect"), sessionProviderTimeout("input"), sessionProviderTimeout("inspectMany"), sessionProviderTimeout("check"), sessionProviderTimeout("stop", { graceSeconds: 30 })], [120_000, 20_000, 20_000, 20_000, 20_000, 50_000]);
});

test("the feature: session-providers is listed, sessionBackends stays the kernel's own, and a routed --backend needs the host's feature", (t) => {
  const fx = providerDeployment(t);
  const version = fx.cli(["version", "--json"]).json();
  assert.deepEqual(version.sessionBackends, ["tmux"]);
  assert.equal(version.features.includes("session-providers"), true);
  assert.equal(KERNEL_FEATURES.includes("session-providers"), true);

  const target = { sshHost: "builder" }, roster = { agents: [{ name: "dev", harness: "claude" }] };
  const host = (features) => ({ version: "0.70.0", features, harnesses: ["pi", "claude", "codex"], sessionBackends: ["tmux"], launchOptions: ["yolo"], advertised: true });
  assert.equal(checkRemoteSupport(host(["session-providers"]), target, ["dev", "--backend", "bb"], roster).backend, "bb");
  assert.equal(checkRemoteSupport(host([]), target, ["dev", "--backend", "tmux"], roster).backend, "tmux");
  assert.throws(() => checkRemoteSupport(host([]), target, ["dev", "--backend", "bb"], roster), (e) => e.code === "E_REMOTE_INCOMPATIBLE" && /session backend bb \(a session provider: the host must advertise session-providers\) was not established as supported there/.test(e.message));
});

test("capabilities show and inspect list a capability's session providers, a malformed one with its problem", (t) => {
  const fx = providerDeployment(t, {
    capabilities: { "acme.broken": { manifest: { ...fakeManifest({ odd: { ...fakeProvider(), harnesses: [] } }), hooks: undefined, environment: undefined }, files: fakeFiles() } },
    souls: { both: { soul: { capabilities: { [FAKE_CAPABILITY]: { from: "here" }, "acme.broken": { from: "here" } } } } },
  });
  const shown = fx.cli(["capabilities", "show", FAKE_CAPABILITY, "--json"]).json();
  assert.deepEqual(shown.result.sessionProviders, { fake: fakeProvider() });
  assert.equal(Object.hasOwn(shown.result, "sessionProviderProblems"), false);
  assert.match(fx.cli(["capabilities", "show", FAKE_CAPABILITY]).stdout, /  session providers:\n    fake  harnesses claude  — A fake session backend for tests\n/);
  const broken = fx.cli(["capabilities", "show", "acme.broken", "--json"]).json();
  assert.deepEqual(broken.result.sessionProviderProblems, [{ provider: "odd", pointer: "/sessionProviders/odd/harnesses", message: 'session provider "odd": harnesses must list 1 to 16 harness names' }]);
  assert.match(fx.cli(["capabilities", "show", "acme.broken"]).stdout, /  session provider problem: \/sessionProviders\/odd\/harnesses — session provider "odd": harnesses must list 1 to 16 harness names\n/);

  const soul = fx.cli(["inspect", "--soul", "both", "--json"]).json();
  // inspect: the names a spawn can select here, each with its capability; a malformed one is none.
  assert.deepEqual(soul.result.sessionProviders, [{ name: "fake", capability: FAKE_CAPABILITY }]);
  assert.match(fx.cli(["inspect", "--soul", "both"]).stdout, /  session backends: tmux, fake \(acme\.fake\)\n/);
  assert.deepEqual(fx.cli(["inspect", "--soul", "plain", "--json"]).json().result.sessionProviders, []);
  // The malformed one cannot be selected; the sound one still can.
  assert.equal(fx.cli(["spawn", "both", "--backend", "odd", "--launch-config", "claude", "--preview", "--json"]).json().error.code, "E_BACKEND_UNKNOWN");
  assert.equal(fx.cli(["spawn", "both", "--backend", "fake", "--launch-config", "claude", "--preview", "--json"]).json().ok, true);
});

test("two capabilities of one instance that declare the same provider name: E_BACKEND_AMBIGUOUS, nothing created", (t) => {
  const fx = providerDeployment(t, {
    capabilities: { "acme.twin": { manifest: { ...fakeManifest(), hooks: undefined, environment: undefined }, files: fakeFiles() } },
    souls: { twins: { soul: { capabilities: { [FAKE_CAPABILITY]: { from: "here" }, "acme.twin": { from: "here" } } } } },
  });
  const refused = fx.cli(["spawn", "twins", "--name", "which", "--backend", "fake", "--launch-config", "claude", "--json"]).json();
  assert.deepEqual([refused.ok, refused.error.code, refused.error.details], [false, "E_BACKEND_AMBIGUOUS", { backend: "fake", capabilities: [FAKE_CAPABILITY, "acme.twin"] }]);
  assert.equal(existsSync(join(fx.root, "twins", "instances", "which")), false);
  assert.deepEqual(fx.calls(), []);
  // A spawn preview shows it too, before anything is applied.
  const previewed = fx.cli(["spawn", "twins", "--backend", "fake", "--launch-config", "claude", "--preview", "--json"]).json();
  assert.deepEqual([previewed.ok, previewed.error.code, previewed.error.details.capabilities], [false, "E_BACKEND_AMBIGUOUS", [FAKE_CAPABILITY, "acme.twin"]]);
  // On tmux the same soul spawns as before, and inspect lists the name under both.
  assert.equal(fx.cli(["spawn", "twins", "--name", "which", "--no-launch", "--json"]).json().ok, true);
  assert.deepEqual(fx.cli(["inspect", "--soul", "twins", "--json"]).json().result.sessionProviders.map((p) => [p.name, p.capability]), [["fake", FAKE_CAPABILITY], ["fake", "acme.twin"]]);
});

test("a kernel from before the contract refuses to start a provider home that was never launched", async (t) => {
  // The kernel at main before the contract (preContractKernel): it reads `launched: false` as a home
  // it may start, and would open a tmux window in a home that is to run on a provider. The recipe a
  // provider home records has no executable, which that kernel cannot start from.
  const cli = preContractKernel(t);
  const fx = providerDeployment(t);
  const { home } = await fx.spawn("dev", { name: "never", backend: "fake", launchConfig: "claude" });
  const before = readFileSync(join(home, "instance.json"), "utf8");
  for (const verb of [["session", "start"], ["session", "restart"], ["session", "start", "--harness", "claude"]]) {
    const r = spawnSync(process.execPath, [cli, ...verb, "--home", home, "--json"], { cwd: fx.dep, env: fx.env, encoding: "utf8" });
    const answer = JSON.parse(r.stdout.trim().split("\n").pop());
    assert.deepEqual([answer.ok, answer.error.code], [false, "E_LAUNCH_RECIPE_UNSUPPORTED"], verb.join(" "));
    assert.match(answer.error.message, /records a launch recipe this kernel cannot start from \(no executable\)/);
  }
  assert.equal(readFileSync(join(home, "instance.json"), "utf8"), before, "the record is unchanged");
  assert.deepEqual(fx.verbs(), [], "nothing was launched, on tmux or on the provider");
});

test("a kernel from before the contract applies a requires row that carries `backends` to every launch: it never drops it", async (t) => {
  // The row is for provider launches only. A kernel that knows `backends` leaves it out of a tmux
  // launch; the kernel at main before the contract knows no such key and applies the row, so a
  // package that uses `backends` raises its OATS floor to a kernel listing session-providers.
  const cli = preContractKernel(t);
  const fx = providerDeployment(t, {
    capabilities: { "acme.provided": { manifest: { requires: [{ harness: "claude", package: "needed@acme-market", why: "the fixture's package", backends: ["session-provider"] }] }, files: {} } },
    souls: { needs: { soul: { capabilities: { "acme.provided": { from: "here" } } } } },
  });
  const args = ["spawn", "needs", "--launch-config", "claude", "--preview", "--json"];
  assert.equal(fx.cli(args).json().ok, true, "this kernel: not a requirement of a tmux launch");
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: fx.dep, env: fx.env, encoding: "utf8" });
  const older = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.deepEqual([older.ok, older.error.code], [false, "E_HARNESS_RESOURCE_MISSING"], JSON.stringify(older));
  assert.match(older.error.message, /acme\.provided requires the claude package needed@acme-market/);
});

test("a kernel from before the contract refuses a home whose spawn was killed while its provider launched: it never retires it as one never launched", async (t) => {
  // Such a home has no endpoint, and its provider may run a session for it. Its receipt says a
  // launch was sent (`launched: true`, no tmux endpoint): the older kernel reads that as a launch
  // it cannot address, and refuses, where a `launched: false` receipt would read as a home it may retire.
  const cli = preContractKernel(t);
  const fx = providerDeployment(t);
  fx.control({ launch: { sleepMs: 1500 } });
  const child = spawn(process.execPath, [join(REPO, "bin", "oats.mjs"), "spawn", "dev", "--name", "cut", "--backend", "fake", "--launch-config", "claude", "--json"], { cwd: fx.dep, env: fx.env, stdio: "ignore" });
  const done = new Promise((resolve) => child.on("close", resolve));
  for (let i = 0; i < 100 && fx.verbs("launch").length === 0; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(fx.verbs("launch").length, 1, "the provider's launch is in flight");
  child.kill("SIGKILL");
  await done;
  await new Promise((r) => setTimeout(r, 2000));
  fx.clearCalls();
  const home = join(fx.root, "dev", "instances", "cut");
  const older = (args) => { const r = spawnSync(process.execPath, [cli, ...args], { cwd: fx.dep, env: fx.env, encoding: "utf8" }); return JSON.parse(r.stdout); };
  for (const args of [["session", "inspect", "--home", home, "--json"], ["session", "start", "--home", home, "--json"], ["retire", "cut", "--json"]]) {
    const answer = older(args);
    assert.equal(answer.ok, false, `${args.join(" ")}: ${JSON.stringify(answer).slice(0, 300)}`);
  }
  assert.equal(existsSync(home), true, "the home is kept");
  assert.deepEqual(fx.verbs(), [], "and that kernel called no provider");
});
