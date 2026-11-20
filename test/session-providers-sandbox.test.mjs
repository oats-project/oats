// Sandbox allowances at a spawn on a session provider (spec K2, S1 to S6). The rule itself is
// pinned in test/sandbox-allowances.test.mjs; this file pins what a spawn does with it.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { FAKE_CAPABILITY, providerDeployment } from "./helpers/session-provider-fixture.mjs";

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
