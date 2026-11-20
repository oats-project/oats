// Sandbox allowances (spec K2; docs/capabilities.md "Sandbox allowances"): the rule, as the pure
// function a launch calls (lib/sandbox-allowances.mjs). What a spawn does with it is in
// test/session-providers-sandbox.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SANDBOX_LINES, SETTING_FILE_MAX_BYTES, SETTING_FILE_MAX_HOSTS, readSettingFileHosts, sandboxAllowances, sandboxDomainsOf, sandboxHostOf, sandboxLaunchInput } from "../lib/sandbox-allowances.mjs";

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
    { host: "aweb.example.org", capability: "acme.msg", setting: "services", team: "default:acme.example" },
    { host: "ops.example.net", capability: "acme.msg", setting: "services", team: "ops:acme.example" },
    { host: "registry.example.org", capability: "acme.msg", setting: "registryHost" },
  ], "another team's entry is neither taken nor judged; a host from the map says which team's it is");
  // The provider is handed the host with who asked, never the team: that label is for people.
  assert.deepEqual(sandboxLaunchInput({ domains: of(["ops:acme.example"]), write: WRITE, missing: [], skipped: [], unread: [] }), {
    domains: [{ host: "ops.example.net", capability: "acme.msg", setting: "services" }, { host: "registry.example.org", capability: "acme.msg", setting: "registryHost" }], write: WRITE, missing: [],
  });
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

// ------------------------------------------------------------------ the `settingFile` form

/** A deployment directory with `agents/` (the homes) and `.agents/events` in it. */
function fileDeployment(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "oats-sandbox-file-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dep = join(base, "deployment");
  for (const dir of ["agents/dev/instances/one", ".agents/events", "config"]) mkdirSync(join(dep, dir), { recursive: true });
  const write = (rel, value) => { const path = join(dep, rel); writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value)); return path; };
  const read = (path, pointer = "/bases/*/repository") => readSettingFileHosts({ path, pointer, within: dep, outside: [join(dep, "agents"), join(dep, ".agents", "events")] });
  return { base, dep, write, read };
}
const BASES = { bases: {
  team: { repository: "https://github.com/acme/kb.git" }, ssh: { repository: "git@git.example.org:acme/kb.git" }, url: { repository: "ssh://git@Git.Example.org:2222/acme/kb.git" },
  again: { repository: "https://github.com/acme/other.git" }, local: { repository: "/srv/git/kb.git" }, odd: { repository: 7 }, none: {},
} };

test("a settingFile line gives the hosts of every string at its pointer: URLs and git remotes, deduplicated, the rest skipped", (t) => {
  const fx = fileDeployment(t);
  const path = fx.write("config/bindings.json", BASES);
  assert.deepEqual(fx.read(path), { hosts: ["github.com", "git.example.org", "git.example.org:2222"], skippedValues: 2 });
  assert.deepEqual(fx.read("config/bindings.json"), fx.read(path), "a relative path is the deployment's");
  assert.deepEqual(fx.read(path, "/bases/team/repository"), { hosts: ["github.com"], skippedValues: 0 });
  assert.deepEqual(fx.read(path, "/nothing/here"), { hosts: [], skippedValues: 0 });
  assert.deepEqual(fx.read(fx.write("config/list.json", { remotes: ["https://a.example.org/x", "b.example.org:8443", "https://user:pw@c.example.org"] }), "/remotes/*"), { hosts: ["a.example.org", "b.example.org:8443"], skippedValues: 1 });
  // In the allowances: named with the capability and the setting, and what was skipped is said.
  const allowed = sandboxAllowances({
    modules: [{ name: "acme.kb", manifest: { layer: "knowledge", sandboxDomains: [{ settingFile: "bindings-file", urls: "/bases/*/repository" }] } }],
    slots: { knowledge: "acme.kb" }, payloads: { "acme.kb": { "bindings-file": path } }, eventsDir: join(fx.dep, ".agents", "events"), deployment: fx.dep, outside: [join(fx.dep, "agents")],
  });
  assert.deepEqual(allowed.domains, ["github.com", "git.example.org", "git.example.org:2222"].map((host) => ({ host, capability: "acme.kb", setting: "bindings-file" })));
  assert.deepEqual(allowed.unread, [{ capability: "acme.kb", setting: "bindings-file", reason: "2 values at /bases/*/repository are no URL with a plain host, and were skipped" }]);
});

test("a settingFile's path is the deployment's own, never a home's or an allowed path's, and reaches its file through no link: else refused", (t) => {
  const fx = fileDeployment(t);
  const good = fx.write("config/bindings.json", BASES);
  const refusedWith = (path, why) => { const r = fx.read(path); assert.match(r.refused ?? `(not refused: ${JSON.stringify(r)})`, why, path); };
  // Outside the deployment.
  const outside = join(fx.base, "elsewhere.json");
  writeFileSync(outside, JSON.stringify(BASES));
  refusedWith(outside, /is not inside the deployment/);
  refusedWith("../elsewhere.json", /is not inside the deployment/);
  // Inside an instance home, or inside the events directory the allowances make writable.
  refusedWith(fx.write("agents/dev/instances/one/bindings.json", BASES), /is inside .+\/agents, which a session's agent can write/);
  refusedWith(fx.write(".agents/events/bindings.json", BASES), /is inside .+\/\.agents\/events, which a session's agent can write/);
  // A link as the file, and a link in a parent directory that moves the read into a home.
  symlinkSync(join(fx.dep, "agents", "dev", "instances", "one", "bindings.json"), join(fx.dep, "config", "linked.json"));
  refusedWith(join(fx.dep, "config", "linked.json"), /reaches its file through a symbolic link/);
  symlinkSync(join(fx.dep, "agents", "dev", "instances", "one"), join(fx.dep, "config", "dir"));
  refusedWith(join(fx.dep, "config", "dir", "bindings.json"), /reaches its file through a symbolic link/);
  // In the allowances a refused path refuses the launch, naming the capability and the setting.
  const refused = refusal(() => sandboxAllowances({
    modules: [{ name: "acme.kb", manifest: { layer: "knowledge", sandboxDomains: [{ settingFile: "bindings-file", urls: "/bases/*/repository" }] } }],
    slots: { knowledge: "acme.kb" }, payloads: { "acme.kb": { "bindings-file": outside } }, eventsDir: join(fx.dep, ".agents", "events"), deployment: fx.dep, outside: [join(fx.dep, "agents")],
  }));
  assert.deepEqual([refused.code, refused.details], ["E_BACKEND_SANDBOX_HOST", { capability: "acme.kb", setting: "bindings-file", host: null }]);
  assert.match(refused.message, /capability acme\.kb asks to allow the hosts in the file its setting bindings-file names, and .+ is not inside the deployment/);
  assert.deepEqual(fx.read(good).hosts.length, 3, "and the deployment's own file is read");
});

test("a deployment's file that is missing, no regular file, too large, no strict JSON or names too many hosts gives no host and is named", (t) => {
  const fx = fileDeployment(t);
  const unreadWith = (path, why) => { const r = fx.read(path); assert.match(r.unread ?? `(read: ${JSON.stringify(r)})`, why, path); };
  unreadWith(join(fx.dep, "config", "absent.json"), /does not exist/);
  unreadWith(undefined, /the setting names no file/);
  unreadWith(join(fx.dep, "config"), /is not a regular file/);
  unreadWith(fx.write("config/big.json", JSON.stringify({ bases: {}, pad: "x".repeat(SETTING_FILE_MAX_BYTES) })), /is larger than 64 KiB/);
  unreadWith(fx.write("config/loose.json", '{"bases": {"a": {"repository": "https://a.example.org"},}}'), /is not strict JSON/);
  unreadWith(fx.write("config/twice.json", '{"bases": {}, "bases": {"a": {"repository": "https://evil.example.net"}}}'), /is not strict JSON/);
  const many = { bases: Object.fromEntries(Array.from({ length: SETTING_FILE_MAX_HOSTS + 1 }, (_, i) => [`b${i}`, { repository: `https://h${i}.example.org/x` }])) };
  unreadWith(fx.write("config/many.json", many), /names 17 hosts, more than the 16 one file may give/);
  delete many.bases.b16;
  assert.equal(fx.read(fx.write("config/sixteen.json", many)).hosts.length, SETTING_FILE_MAX_HOSTS);
  // In the allowances: no host, named in `unread`, and the launch goes on.
  const allowed = sandboxAllowances({
    modules: [{ name: "acme.kb", manifest: { layer: "knowledge", sandboxDomains: [{ settingFile: "bindings-file", urls: "/bases/*/repository" }] } }],
    slots: { knowledge: "acme.kb" }, payloads: { "acme.kb": { "bindings-file": join(fx.dep, "config", "absent.json") } }, eventsDir: join(fx.dep, ".agents", "events"), deployment: fx.dep, outside: [join(fx.dep, "agents")],
  });
  assert.deepEqual([allowed.domains, allowed.unread.map((u) => [u.capability, u.setting])], [[], [["acme.kb", "bindings-file"]]]);
});

test("a settingFile line is validated with the manifest: its key, its pointer, at most one * segment", () => {
  const problemsOf = (line) => sandboxDomainsOf({ layer: "knowledge", sandboxDomains: [line] }).problems;
  const bad = ['sandboxDomains[0] must be { "settingFile": "<one of the capability\'s setting keys>", "urls": "<a JSON pointer, at most one * segment>" }'];
  assert.deepEqual(sandboxDomainsOf({ layer: "knowledge", sandboxDomains: [{ settingFile: "bindings-file", urls: "/bases/*/repository" }] }), { lines: [{ settingFile: "bindings-file", urls: "/bases/*/repository" }], problems: [] });
  for (const line of [{ settingFile: "bindings-file" }, { settingFile: "bindings-file", urls: "bases/*" }, { settingFile: "bindings-file", urls: "/a/*/b/*" }, { settingFile: "bindings-file", urls: "/a//b" }, { settingFile: "bindings-file", urls: "/a/~2" }, { settingFile: 7, urls: "/a" }, { settingFile: "bindings-file", urls: "/a", optional: true }, { settingFile: "f", setting: "f", urls: "/a" }]) assert.deepEqual(problemsOf(line), bad, JSON.stringify(line));
  assert.deepEqual(sandboxDomainsOf({ layer: "knowledge", sandboxDomains: [{ setting: "f" }, { settingFile: "f", urls: "/a" }] }).problems, ["sandboxDomains[1] names the setting f a second time"]);
  // The published schema says the same of a pointer as the kernel does: a package that passes its
  // schema check is not refused at every launch for its pointer.
  const urls = JSON.parse(readFileSync(new URL("../docs/capability-manifest.schema.json", import.meta.url), "utf8")).properties.sandboxDomains.items.oneOf[1].properties.urls;
  const schemaTakes = (pointer) => pointer.length <= urls.maxLength && new RegExp(urls.pattern).test(pointer) && !new RegExp(urls.not.pattern).test(pointer);
  for (const pointer of ["/bases/*/repository", "/*", "/a/~1b/~0c", "/a/*/b/*", "/*/*", "/a/~2", "/a/~", "/a//b", "a/b", "/", "", `/${"x".repeat(400)}`, `/${Array.from({ length: 16 }, () => "s").join("/")}`, `/${Array.from({ length: 17 }, () => "s").join("/")}`]) {
    assert.equal(schemaTakes(pointer), problemsOf({ settingFile: "bindings-file", urls: pointer }).length === 0, JSON.stringify(pointer));
  }
});
