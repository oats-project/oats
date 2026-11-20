// Sandbox allowances (spec K2; docs/capabilities.md "Sandbox allowances"): the rule, as the pure
// function a launch calls (lib/sandbox-allowances.mjs). What a spawn does with it is in
// test/session-providers-sandbox.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_SANDBOX_LINES, sandboxAllowances, sandboxDomainsOf, sandboxHostOf } from "../lib/sandbox-allowances.mjs";

const EVENTS = "/srv/acme/.agents/events";
const WRITE = [{ path: EVENTS, reason: "oats events" }];
const messaging = (sandboxDomains, extra = {}) => ({ name: "acme.msg", manifest: { layer: "messaging", sandboxDomains, ...extra } });
const allow = (modules, payloads, slots = { messaging: "acme.msg", knowledge: null, tasks: null }) => sandboxAllowances({ modules, slots, payloads, eventsDir: EVENTS });
const refusal = (fn) => { try { fn(); } catch (e) { return { code: e.code, message: e.message, details: e.details }; } return null; };

test("S1: the messaging provider's line names a setting, and the setting's URL gives the host", () => {
  assert.deepEqual(allow([messaging([{ setting: "server" }])], { "acme.msg": { server: "https://app.example.org/x" } }), {
    domains: [{ host: "app.example.org", capability: "acme.msg", setting: "server" }], write: WRITE, missing: [],
  });
});

test("no capability declares the line: no host, and the kernel's own path", () => {
  assert.deepEqual(allow([{ name: "acme.msg", manifest: { layer: "messaging" } }, { name: "acme.other", manifest: {} }], { "acme.msg": { server: "https://app.example.org" } }), { domains: [], write: WRITE, missing: [] });
});

test("each slot's provider may ask; hosts are deduplicated, the first to ask is named; a setting with no value gives nothing", () => {
  const modules = [
    messaging([{ setting: "server" }, { setting: "registry" }, { setting: "unset" }]),
    { name: "acme.kb", manifest: { layer: "knowledge", sandboxDomains: [{ setting: "remote" }] } },
    { name: "acme.tasks", manifest: { layer: "tasks", sandboxDomains: [{ setting: "api" }] } },
    { name: "acme.plain", manifest: {} },
  ];
  const payloads = {
    "acme.msg": { server: "https://app.example.org/x", registry: "https://registry.example.org:8443", unset: "" },
    "acme.kb": { remote: "https://APP.example.org/kb" },
    "acme.tasks": { api: "http://10.0.0.7/v1" },
  };
  const allowed = allow(modules, payloads, { messaging: "acme.msg", knowledge: "acme.kb", tasks: "acme.tasks" });
  assert.deepEqual(allowed.domains, [
    { host: "app.example.org", capability: "acme.msg", setting: "server" },
    { host: "registry.example.org:8443", capability: "acme.msg", setting: "registry" },
    { host: "10.0.0.7", capability: "acme.tasks", setting: "api" },
  ]);
  assert.deepEqual(allowed.missing, [{ capability: "acme.msg", setting: "unset", team: null }], "named, for the provider to judge: the kernel refuses nothing on it");
});

test("a map from team id to URL gives the hosts of the instance's own teams only", () => {
  const services = { "default:acme.example": "https://aweb.example.org/api", "ops:acme.example": "https://ops.example.net", "other:else.example": "https://*.not-read.example" };
  const of = (teams) => sandboxAllowances({ modules: [messaging([{ setting: "services" }, { setting: "registryHost" }])], slots: { messaging: "acme.msg" }, payloads: { "acme.msg": { services, registryHost: "registry.example.org" } }, teams, eventsDir: EVENTS }).domains;
  assert.deepEqual(of(["default:acme.example", "ops:acme.example", "default:acme.example"]), [
    { host: "aweb.example.org", capability: "acme.msg", setting: "services" },
    { host: "ops.example.net", capability: "acme.msg", setting: "services" },
    { host: "registry.example.org", capability: "acme.msg", setting: "registryHost" },
  ], "another team's entry is neither taken nor judged");
  assert.deepEqual(of(["default:acme.example"]).map((d) => d.host), ["aweb.example.org", "registry.example.org"]);
  assert.deepEqual(of(["unlisted:acme.example"]).map((d) => d.host), ["registry.example.org"], "a team without an entry contributes no host");
  assert.deepEqual(of([]).map((d) => d.host), ["registry.example.org"]);
  // A team of the instance that the map does not hold is `missing`, with its id.
  const partly = sandboxAllowances({ modules: [messaging([{ setting: "services" }])], slots: { messaging: "acme.msg" }, payloads: { "acme.msg": { services } }, teams: ["default:acme.example", "unlisted:acme.example"], eventsDir: EVENTS });
  assert.deepEqual([partly.domains.map((d) => d.host), partly.missing], [["aweb.example.org"], [{ capability: "acme.msg", setting: "services", team: "unlisted:acme.example" }]]);
  // A line declared optional marks its missing rows: no reason for a provider to refuse.
  const optional = sandboxAllowances({ modules: [messaging([{ setting: "services" }, { setting: "registryHost", optional: true }])], slots: { messaging: "acme.msg" }, payloads: { "acme.msg": { services } }, teams: ["default:acme.example"], eventsDir: EVENTS });
  assert.deepEqual([optional.domains.map((d) => d.host), optional.missing], [["aweb.example.org"], [{ capability: "acme.msg", setting: "registryHost", team: null, optional: true }]]);
  // An entry of the instance's team that gives no host is refused, naming the team.
  const refused = refusal(() => of(["other:else.example"]));
  assert.deepEqual([refused.code, refused.details], ["E_BACKEND_SANDBOX_HOST", { capability: "acme.msg", setting: "services", host: null, team: "other:else.example" }]);
  assert.match(refused.message, /its setting services for team other:else\.example, whose value names a wildcard host/);
});

test("S2, S3: a capability that declares the line and fills none of the three slots is refused, naming it and its host", () => {
  // S2: no layer at all (an installed module: manifest validation refuses it earlier).
  const plain = refusal(() => allow([{ name: "acme.plain", manifest: { sandboxDomains: [{ setting: "server" }] } }], { "acme.plain": { server: "https://evil.example.net/x" } }));
  assert.equal(plain.code, "E_BACKEND_SANDBOX_HOST");
  assert.deepEqual(plain.details, { capability: "acme.plain", setting: "server", host: "evil.example.net" });
  assert.match(plain.message, /capability acme\.plain declares sandboxDomains \(the host evil\.example\.net, from its setting server\), and it is not this instance's messaging, knowledge, tasks provider/);
  // S3: it declares the messaging layer, and the instance's messaging provider is another.
  const unbound = refusal(() => allow([messaging([{ setting: "server" }])], { "acme.msg": { server: "https://app.example.org" } }, { messaging: "acme.other", knowledge: null, tasks: null }));
  assert.deepEqual([unbound.code, unbound.details], ["E_BACKEND_SANDBOX_HOST", { capability: "acme.msg", setting: "server", host: "app.example.org" }]);
  // Never dropped: also when its setting gives no host, and when the slot is empty.
  const hostless = refusal(() => allow([messaging([{ setting: "server" }])], {}, { messaging: null, knowledge: null, tasks: null }));
  assert.deepEqual([hostless.code, hostless.details], ["E_BACKEND_SANDBOX_HOST", { capability: "acme.msg", setting: "server", host: null }]);
});

test("S4: a setting whose value is no URL with a plain host is refused, naming the capability and the setting", () => {
  for (const [value, why] of [
    ["app.example.org/x", /is neither a URL with a scheme and a host nor a bare host/],
    ["app example.org", /is neither a URL with a scheme and a host nor a bare host/],
    ["https://*.example.org/x", /names a wildcard host \(\*\.example\.org\)/],
    ["https:///path", /is a URL without a host/],
    ["https://user:secret@app.example.org", /is a URL that carries credentials/],
    ["https://[::1]:8443/", /names a host that is no plain DNS name or IPv4 address/],
    ["https://app_one.example.org", /names a host that is no plain DNS name or IPv4 address/],
    ["https://app.example.org:https", /names a port that is no port number/],
    ["https://app.example.org:0", /names a port that is no port number/],
    [42, /is not a URL or a host/],
    [["https://app.example.org"], /is not a URL or a host/],
  ]) {
    const refused = refusal(() => allow([messaging([{ setting: "server" }])], { "acme.msg": { server: value } }));
    assert.equal(refused?.code, "E_BACKEND_SANDBOX_HOST", JSON.stringify(value));
    assert.deepEqual(refused.details, { capability: "acme.msg", setting: "server", host: null });
    assert.match(refused.message, /capability acme\.msg asks to allow the host of its setting server, whose value /);
    assert.match(refused.message, why, JSON.stringify(value));
  }
  // The value itself is never quoted when it carries credentials.
  assert.equal(refusal(() => allow([messaging([{ setting: "server" }])], { "acme.msg": { server: "https://user:secret@app.example.org" } })).message.includes("secret"), false);
});

test("a host is the URL's, lower case; its port only when the URL names one, the scheme's default included", () => {
  assert.deepEqual(sandboxHostOf("HTTPS://App.Example.ORG/a/b?c#d"), { host: "app.example.org" });
  assert.deepEqual(sandboxHostOf("https://app.example.org:443"), { host: "app.example.org:443" });
  assert.deepEqual(sandboxHostOf("http://localhost:08080/x"), { host: "localhost:8080" });
  assert.deepEqual(sandboxHostOf("ssh://git.example.org/repo.git"), { host: "git.example.org" });
  assert.deepEqual(sandboxHostOf("  https://app.example.org  "), { host: "app.example.org" });
  // A bare host is taken as it is, under the same rule.
  assert.deepEqual(sandboxHostOf("Registry.example.org"), { host: "registry.example.org" });
  assert.deepEqual(sandboxHostOf("registry.example.org:8443"), { host: "registry.example.org:8443" });
  assert.deepEqual(sandboxHostOf("*.example.org").host, undefined);
  assert.deepEqual(sandboxHostOf("user@registry.example.org").host, undefined);
});

test("a malformed declaration is a problem, and a refusal where it is used: a line is never dropped", () => {
  const problemsOf = (sandboxDomains, layer = "messaging") => sandboxDomainsOf({ layer, sandboxDomains }).problems;
  assert.deepEqual(sandboxDomainsOf({ layer: "messaging" }), { lines: [], problems: [] });
  assert.deepEqual(sandboxDomainsOf({ layer: "tasks", sandboxDomains: [{ setting: "api" }, { setting: "extra", optional: true }, { setting: "plain", optional: false }] }), { lines: [{ setting: "api", optional: false }, { setting: "extra", optional: true }, { setting: "plain", optional: false }], problems: [] });
  assert.deepEqual(problemsOf([{ setting: "server", optional: "yes" }]), ['sandboxDomains[0] must be { "setting": "<one of the capability\'s setting keys>", "optional"?: true }']);
  assert.deepEqual(problemsOf([]), [`sandboxDomains must list 1 to ${MAX_SANDBOX_LINES} entries`]);
  assert.deepEqual(problemsOf("server"), [`sandboxDomains must list 1 to ${MAX_SANDBOX_LINES} entries`]);
  assert.deepEqual(problemsOf(Array.from({ length: MAX_SANDBOX_LINES + 1 }, (_, i) => ({ setting: `s${i}` }))), [`sandboxDomains must list 1 to ${MAX_SANDBOX_LINES} entries`]);
  assert.deepEqual(problemsOf([{ setting: "server", host: "x" }]), ['sandboxDomains[0] must be { "setting": "<one of the capability\'s setting keys>", "optional"?: true }']);
  assert.deepEqual(problemsOf([{ host: "app.example.org" }]), ['sandboxDomains[0] must be { "setting": "<one of the capability\'s setting keys>", "optional"?: true }']);
  assert.deepEqual(problemsOf(["server"]), ['sandboxDomains[0] must be { "setting": "<one of the capability\'s setting keys>", "optional"?: true }']);
  assert.deepEqual(problemsOf([{ setting: "server" }, { setting: "server" }]), ["sandboxDomains[1] names the setting server a second time"]);
  assert.deepEqual(sandboxDomainsOf({ sandboxDomains: [{ setting: "server" }] }).problems, ["sandboxDomains is for a capability whose layer is messaging, knowledge, tasks: this one declares none"]);
  // Used: the launch is refused with the problems, whatever the good lines would have given.
  const refused = refusal(() => allow([messaging([{ setting: "server" }, { host: "evil.example.net" }])], { "acme.msg": { server: "https://app.example.org" } }));
  assert.deepEqual([refused.code, refused.details], ["E_BACKEND_SANDBOX_HOST", { capability: "acme.msg", setting: null, host: null }]);
  assert.match(refused.message, /capability acme\.msg declares a sandboxDomains this kernel cannot use: sandboxDomains\[1\] must be/);
});
