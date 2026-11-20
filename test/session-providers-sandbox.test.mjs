// Sandbox allowances at a spawn on a session provider (spec K2, S1 to S6). The rule itself is
// pinned in test/sandbox-allowances.test.mjs; this file pins what a spawn does with it.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAKE_CAPABILITY, fakeManifest, fakeProvider, providerDeployment } from "./helpers/session-provider-fixture.mjs";

const MSG = "acme.msg";
/** A deployment whose soul `dev` runs on the fake provider and whose messaging provider is acme.msg. */
const deployment = (t, { settings = { server: "https://app.example.org/x" } } = {}) => providerDeployment(t, {
  capabilities: { [MSG]: { manifest: { layer: "messaging", settings: { server: { default: "" } }, sandboxDomains: [{ setting: "server" }] }, files: {} } },
  souls: { dev: { soul: { capabilities: { [FAKE_CAPABILITY]: { from: "here" }, [MSG]: { from: "here" } }, messaging: settings } } },
});
const eventsOf = (fx) => join(realpathSync(fx.dep), ".agents", "events");

test("S1, S5: a provider launch is handed the messaging provider's host and the deployment's events directory, which exists by then", async (t) => {
  const fx = deployment(t);
  rmSync(eventsOf(fx), { recursive: true, force: true });
  await fx.launch("one");
  const [launch] = fx.verbs("launch");
  assert.deepEqual(launch.request.input.sandbox, {
    domains: [{ host: "app.example.org", capability: MSG, setting: "server" }],
    write: [{ path: eventsOf(fx), reason: "oats events" }], missing: [],
  });
  assert.equal(statSync(eventsOf(fx)).isDirectory(), true, "created before the provider's launch");
});

test("S5: a provider launch with no line is handed no host and the events directory; a tmux spawn has no sandbox at all", async (t) => {
  const fx = providerDeployment(t);
  await fx.launch("bare");
  assert.deepEqual(fx.verbs("launch")[0].request.input.sandbox, { domains: [], write: [{ path: eventsOf(fx), reason: "oats events" }], missing: [] });
  const tmux = fx.cli(["spawn", "dev", "--launch-config", "claude", "--preview", "--json"]).json();
  assert.equal(tmux.ok, true);
  assert.equal(Object.hasOwn(tmux.result, "sandbox"), false, "a tmux launch: no key");
});

test("S6: the preview lists each host with who asked for it, and each path with its reason", (t) => {
  const fx = deployment(t);
  const preview = fx.cli(["spawn", "dev", "--backend", "fake", "--launch-config", "claude", "--preview", "--json"]).json();
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.deepEqual(preview.result.sandbox, {
    domains: [{ host: "app.example.org", capability: MSG, setting: "server" }],
    write: [{ path: eventsOf(fx), reason: "oats events" }], missing: [],
  });
});

test("S6: readiness of a provider home lists the same entries, what is missing, and nothing for a tmux home", async (t) => {
  const fx = deployment(t);
  const { home } = await fx.launch("one");
  const ready = fx.cli(["readiness", "--home", home, "--json"]).json();
  assert.equal(ready.ok, true, JSON.stringify(ready));
  assert.deepEqual(ready.result.sandbox, {
    domains: [{ host: "app.example.org", capability: MSG, setting: "server" }],
    write: [{ path: eventsOf(fx), reason: "oats events" }], missing: [],
  });
  const text = fx.cli(["readiness", "--home", home]).stdout;
  assert.match(text, /^ {2}sandbox allowances:\n {4}host app\.example\.org {2}asked by acme\.msg \(setting server\)\n {4}path .+\/\.agents\/events {2}asked by the kernel \(oats events\)$/m);
  // A tmux home has no allowances: the key is absent.
  const tmux = await fx.spawn("dev", { name: "on-tmux" });
  assert.equal(Object.hasOwn(fx.cli(["readiness", "--home", tmux.home, "--json"]).json().result, "sandbox"), false);
  // The deployment no longer offers the soul: readiness says that none could be computed, and why.
  fx.commit({ "souls/dev/soul.yaml": null });
  const lost = fx.cli(["readiness", "--home", home, "--json"]).json().result.sandbox;
  assert.deepEqual(Object.keys(lost), ["unavailable"]);
  assert.match(lost.unavailable, /^E_SOUL_UNKNOWN: /);
});

test("S2: an installed capability that declares the line and fills no slot refuses the spawn, naming it and the host; nothing is created", (t) => {
  const fx = providerDeployment(t, {
    capabilities: { "acme.extra": { manifest: { settings: { server: { default: "https://evil.example.net/x" } }, sandboxDomains: [{ setting: "server" }] }, files: {} } },
    souls: { dev: { soul: { capabilities: { [FAKE_CAPABILITY]: { from: "here" }, "acme.extra": { from: "here" } } } } },
  });
  for (const preview of [["--preview"], []]) {
    const refused = fx.cli(["spawn", "dev", "--name", "nope", "--backend", "fake", "--launch-config", "claude", ...preview, "--json"]).json();
    assert.deepEqual([refused.ok, refused.error.code, refused.error.details], [false, "E_BACKEND_SANDBOX_HOST", { capability: "acme.extra", setting: "server", host: "evil.example.net" }]);
    assert.match(refused.error.message, /capability acme\.extra declares sandboxDomains \(the host evil\.example\.net, from its setting server\)/);
  }
  assert.equal(existsSync(join(fx.root, "dev", "instances", "nope")), false);
  assert.deepEqual(fx.calls(), [], "no hook ran and the provider was never called");
  // The same capability on a tmux launch: its line concerns no tmux launch, and nothing is refused.
  assert.equal(fx.cli(["spawn", "dev", "--launch-config", "claude", "--preview", "--json"]).json().ok, true);
});

test("S4: a setting whose value is no URL with a plain host refuses the spawn, naming the capability and the setting", (t) => {
  for (const [server, why] of [["app.example.org/x", /is neither a URL with a scheme and a host nor a bare host/], ["https://*.example.org", /names a wildcard host/]]) {
    const fx = deployment(t, { settings: { server } });
    const refused = fx.cli(["spawn", "dev", "--name", "nope", "--backend", "fake", "--launch-config", "claude", "--json"]).json();
    assert.deepEqual([refused.ok, refused.error.code, refused.error.details], [false, "E_BACKEND_SANDBOX_HOST", { capability: MSG, setting: "server", host: null }], server);
    assert.match(refused.error.message, why);
    assert.equal(existsSync(join(fx.root, "dev", "instances", "nope")), false);
    assert.deepEqual(fx.verbs(), []);
  }
});

test("a setting with no value asks for nothing: the launch goes on without that host", async (t) => {
  const fx = deployment(t, { settings: {} });
  await fx.launch("quiet");
  const { sandbox } = fx.verbs("launch")[0].request.input;
  assert.deepEqual([sandbox.domains, sandbox.missing], [[], [{ capability: MSG, setting: "server", team: null }]], "named as missing: the provider's to judge");
});

test("oats capabilities show lists the line as declared, and what is wrong with it", (t) => {
  const fx = providerDeployment(t, { capabilities: {
    [MSG]: { manifest: { layer: "messaging", sandboxDomains: [{ setting: "server" }] }, files: {} },
    "acme.bad": { manifest: { sandboxDomains: [{ setting: "server" }, { host: "evil.example.net" }] }, files: {} },
  } });
  const good = fx.cli(["capabilities", "show", MSG, "--json"]).json().result;
  assert.deepEqual([good.sandboxDomains, Object.hasOwn(good, "sandboxDomainProblems")], [[{ setting: "server" }], false]);
  const bad = fx.cli(["capabilities", "show", "acme.bad", "--json"]).json().result;
  assert.deepEqual(bad.sandboxDomains, [{ setting: "server" }, { host: "evil.example.net" }], "as declared");
  assert.deepEqual(bad.sandboxDomainProblems, [
    'sandboxDomains[1] must be { "setting": "<one of the capability\'s setting keys>", "optional"?: true }',
    "sandboxDomains is for a capability whose layer is messaging, knowledge, tasks: this one declares none",
  ]);
  assert.equal(Object.hasOwn(fx.cli(["capabilities", "show", FAKE_CAPABILITY, "--json"]).json().result, "sandboxDomains"), false, "absent where nothing is declared");
  const text = fx.cli(["capabilities", "show", "acme.bad"]).stdout;
  assert.match(text, /^ {2}sandbox domains: the host of settings server, \?$/m);
  assert.match(text, /^ {2}sandbox domain problem: sandboxDomains\[1\] must be /m);
});

// ------------------------------------------------------------ start and restart of an existing home

const startCli = (fx, home, verb = "start") => fx.cli(["session", verb, "--home", home, "--json"]).json();

test("a start and a restart resolve the deployment's configuration again: a setting changed there reaches the home", async (t) => {
  const fx = deployment(t);
  const { home } = await fx.launch("one");
  // The deployment's host moves; the home's own record still says the old one.
  fx.commit({ "souls/dev/soul.yaml": { yaml: { schemaVersion: 2, name: "dev", description: "dev fixture soul.", work: "directory", capabilities: { [FAKE_CAPABILITY]: { from: "here" }, [MSG]: { from: "here" } }, messaging: { server: "https://new.example.org" } } } });
  fx.clearCalls();
  const restarted = startCli(fx, home, "restart");
  assert.equal(restarted.ok, true, JSON.stringify(restarted));
  assert.deepEqual(fx.verbs("launch")[0].request.input.sandbox, {
    domains: [{ host: "new.example.org", capability: MSG, setting: "server" }],
    write: [{ path: eventsOf(fx), reason: "oats events" }], missing: [],
  });
  // Nothing of the home is a source: its record edited to another host changes nothing.
  const record = JSON.parse(readFileSync(join(home, "instance.json"), "utf8"));
  writeFileSync(join(home, "instance.json"), JSON.stringify(record).replaceAll("app.example.org", "evil.example.net").replaceAll("new.example.org", "evil.example.net"));
  fx.clearCalls();
  const again = startCli(fx, home, "restart");
  assert.equal(JSON.stringify(fx.verbs("launch").map((c) => c.request.input.sandbox ?? null)).includes("evil.example.net"), false, JSON.stringify(again));
});

test("the deployment's slot provider that is not one of the home's modules adds no host, and the start names it", async (t) => {
  const line = { layer: "messaging", settings: { server: { default: "" } }, sandboxDomains: [{ setting: "server" }] };
  const soul = (messaging) => ({ schemaVersion: 2, name: "dev", description: "dev fixture soul.", work: "directory", capabilities: { [FAKE_CAPABILITY]: { from: "here" }, [messaging]: { from: "here" } }, messaging: { server: "https://app.example.org" } });
  const fx = providerDeployment(t, {
    capabilities: { [MSG]: { manifest: line, files: {} }, "acme.msg2": { manifest: line, files: {} } },
    souls: { dev: { soul: { capabilities: soul(MSG).capabilities, messaging: soul(MSG).messaging } } },
  });
  const { home } = await fx.launch("one");
  // The workspace moves the soul to another messaging provider; the home still has the first.
  fx.commit({ "souls/dev/soul.yaml": { yaml: soul("acme.msg2") } });
  fx.clearCalls();
  const restarted = startCli(fx, home, "restart");
  assert.equal(restarted.ok, true, JSON.stringify(restarted));
  assert.deepEqual(fx.verbs("launch")[0].request.input.sandbox, { domains: [], write: [{ path: eventsOf(fx), reason: "oats events" }], missing: [] }, "neither the home's old provider nor the deployment's new one");
  assert.deepEqual(restarted.result.sandbox, {
    domains: [], write: [{ path: eventsOf(fx), reason: "oats events" }], missing: [],
    skipped: [{ capability: "acme.msg2", reason: "the deployment's messaging provider is acme.msg2, which is not one of this home's modules: its hosts are not allowed here (respawn the instance to take the deployment's composition)" }],
  }, "the start's answer: what the session was allowed, and what was left out");
  assert.deepEqual(restarted.result.warnings.filter((w) => w.startsWith("sandbox allowances:")), [
    "sandbox allowances: acme.msg2 adds no host: the deployment's messaging provider is acme.msg2, which is not one of this home's modules: its hosts are not allowed here (respawn the instance to take the deployment's composition)",
  ]);
});

test("a start that cannot resolve the deployment's configuration says so in the launch input; the provider's check refuses it before anything is stopped", async (t) => {
  const fx = providerDeployment(t, {
    manifest: fakeManifest({ fake: fakeProvider({ check: true }) }),
    capabilities: { [MSG]: { manifest: { layer: "messaging", settings: { server: { default: "" } }, sandboxDomains: [{ setting: "server" }] }, files: {} } },
    souls: { dev: { soul: { capabilities: { [FAKE_CAPABILITY]: { from: "here" }, [MSG]: { from: "here" } }, messaging: { server: "https://app.example.org" } } } },
  });
  const { home } = await fx.launch("one");
  // The planned launch reaches the provider's check: what it would be launched with.
  const planned = fx.verbs("check")[0].request.input.launch;
  assert.deepEqual(planned, { harness: "claude", yolo: null, args: [], sandbox: fx.verbs("launch")[0].request.input.sandbox });
  assert.deepEqual(planned.sandbox.domains, [{ host: "app.example.org", capability: MSG, setting: "server" }]);

  // The workspace stops offering the soul: nothing resolves for this home any more.
  fx.commit({ "souls/dev/soul.yaml": null });
  fx.clearCalls();
  // 1. A provider that takes it (it would not sandbox the session): the launch says why there are no allowances.
  const restarted = startCli(fx, home, "restart");
  assert.equal(restarted.ok, true, JSON.stringify(restarted));
  const sent = fx.verbs("launch")[0].request.input.sandbox;
  assert.deepEqual(Object.keys(sent), ["unavailable"]);
  assert.deepEqual(restarted.result.sandbox, sent, "and so does the start's answer");
  assert.match(sent.unavailable, /^E_SOUL_UNKNOWN: no soul /);
  assert.deepEqual(fx.verbs("check")[0].request.input.launch.sandbox, sent, "and its check was told the same, first");

  // 2. A provider that would sandbox it refuses in its check: nothing is stopped, nothing launched.
  fx.control({ check: { result: { status: "unavailable", problems: [{ code: "E_BACKEND_SANDBOX_UNAVAILABLE", message: "this session would be sandboxed, and its allowances could not be computed" }] } } });
  fx.clearCalls();
  const refused = startCli(fx, home, "restart");
  assert.deepEqual([refused.ok, refused.error.code], [false, "E_BACKEND_SANDBOX_UNAVAILABLE"], JSON.stringify(refused));
  assert.match(refused.error.message, /nothing was stopped or started/);
  assert.deepEqual(fx.verbs().map((c) => c.verb).filter((v) => v === "stop" || v === "launch"), []);
});
