// Sandbox allowances at a spawn on a session provider (spec K2, S1 to S6). The rule itself is
// pinned in test/sandbox-allowances.test.mjs; this file pins what a spawn does with it.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeSandboxSource } from "../lib/instance-resolution.mjs";
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
  // The preview a person reads says the same.
  const text = fx.cli(["spawn", "dev", "--backend", "fake", "--launch-config", "claude", "--preview"]).stdout;
  assert.match(text, /^sandbox allowances:\n {2}host app\.example\.org {2}asked by acme\.msg \(setting server\)\n {2}path .+\/\.agents\/events {2}asked by the kernel \(oats events\)$/m);
  assert.equal(/sandbox/.test(fx.cli(["spawn", "dev", "--launch-config", "claude", "--preview"]).stdout), false, "a tmux preview says nothing of it");
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
  assert.equal(readWorkspace(fx).json().error.code, "E_SOUL_UNKNOWN");
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
/** A command that reads the workspace from its remotes, as any `oats status` or preview does: it
 *  brings the workspace's current commits to this host, which is what a start then resolves. */
const readWorkspace = (fx) => fx.cli(["spawn", "dev", "--backend", "fake", "--launch-config", "claude", "--preview", "--json"]);

test("a start and a restart resolve the deployment's configuration again, as this host last read it and without reaching a remote", async (t) => {
  const fx = deployment(t);
  // Spawned as an operator spawns it, through the CLI: that read of the workspace is what this host has.
  const spawned = fx.cli(["spawn", "dev", "--name", "one", "--backend", "fake", "--launch-config", "claude", "--json"]).json();
  assert.equal(spawned.ok, true, JSON.stringify(spawned));
  const home = spawned.result.home;
  // The workspace's host moves, in its remote. No command of this host has read that yet: a
  // restart resolves what the host last read, and reaches no remote to learn more.
  fx.commit({ "souls/dev/soul.yaml": { yaml: { schemaVersion: 2, name: "dev", description: "dev fixture soul.", work: "directory", capabilities: { [FAKE_CAPABILITY]: { from: "here" }, [MSG]: { from: "here" } }, messaging: { server: "https://new.example.org" } } } });
  fx.clearCalls();
  assert.equal(startCli(fx, home, "restart").ok, true);
  assert.deepEqual(fx.verbs("launch")[0].request.input.sandbox.domains.map((d) => d.host), ["app.example.org"], "as this host last read it");
  // Any command that reads the workspace brings it here; the next launch has it. The home's own record still says the old one.
  assert.equal(readWorkspace(fx).json().ok, true);
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
  // The workspace moves the soul to another messaging provider (and this host reads that); the home still has the first.
  fx.commit({ "souls/dev/soul.yaml": { yaml: soul("acme.msg2") } });
  assert.equal(readWorkspace(fx).json().ok, true);
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

  // The workspace stops offering the soul (and this host reads that): nothing resolves for this home any more.
  fx.commit({ "souls/dev/soul.yaml": null });
  assert.equal(readWorkspace(fx).json().error.code, "E_SOUL_UNKNOWN");
  fx.clearCalls();
  // 1. A provider that takes it (it would not sandbox the session): the launch says why there are no allowances.
  const restarted = startCli(fx, home, "restart");
  assert.equal(restarted.ok, true, JSON.stringify(restarted));
  const sent = fx.verbs("launch")[0].request.input.sandbox;
  assert.deepEqual(Object.keys(sent), ["unavailable"]);
  assert.deepEqual(restarted.result.sandbox, sent, "and so does the start's answer");
  assert.match(sent.unavailable, /^E_SOUL_UNKNOWN: the workspace offers no soul whose agent directory is dev$/);
  assert.deepEqual(fx.verbs("check")[0].request.input.launch.sandbox, sent, "and its check was told the same, first");

  // 2. A provider that would sandbox it refuses in its check: nothing is stopped, nothing launched.
  fx.control({ check: { result: { status: "unavailable", problems: [{ code: "E_BACKEND_SANDBOX_UNAVAILABLE", message: "this session would be sandboxed, and its allowances could not be computed" }] } } });
  fx.clearCalls();
  const refused = startCli(fx, home, "restart");
  assert.deepEqual([refused.ok, refused.error.code], [false, "E_BACKEND_SANDBOX_UNAVAILABLE"], JSON.stringify(refused));
  assert.match(refused.error.message, /nothing was stopped or started/);
  assert.deepEqual(fx.verbs().map((c) => c.verb).filter((v) => v === "stop" || v === "launch"), []);
});

test("nothing in the home decides the deployment or the soul: a home that rewrites its own record gets its own soul's hosts, the real events directory, and the deployment's own file", async (t) => {
  // What a sandboxed agent can write: its home, and the events directory once that is allowed.
  const kb = { layer: "knowledge", settings: { "bindings-file": { default: "" } }, sandboxDomains: [{ settingFile: "bindings-file", urls: "/bases/*/repository" }] };
  const msg = { layer: "messaging", settings: { server: { default: "" } }, sandboxDomains: [{ setting: "server" }] };
  const soulOf = (server) => ({ soul: { capabilities: { [FAKE_CAPABILITY]: { from: "here" }, [MSG]: { from: "here" }, "acme.kb": { from: "here" } }, messaging: { server }, knowledge: { "bindings-file": "okf/bindings.json" } } });
  const fx = providerDeployment(t, {
    capabilities: { [MSG]: { manifest: msg, files: {} }, "acme.kb": { manifest: kb, files: {} } },
    souls: { dev: soulOf("https://app.example.org"), ops: soulOf("https://ops-only.example.net") },
  });
  mkdirSync(join(fx.dep, "okf"), { recursive: true });
  writeFileSync(join(fx.dep, "okf", "bindings.json"), JSON.stringify({ bases: { kb: { repository: "https://good.example.org/kb.git" } } }));
  const { home } = await fx.launch("one");
  const expected = {
    domains: [{ host: "good.example.org", capability: "acme.kb", setting: "bindings-file" }, { host: "app.example.org", capability: MSG, setting: "server" }],
    write: [{ path: eventsOf(fx), reason: "oats events" }], missing: [],
  };
  assert.deepEqual(fx.verbs("launch")[0].request.input.sandbox, expected);
  const rewrite = (change) => writeFileSync(join(home, "instance.json"), JSON.stringify(change(JSON.parse(readFileSync(join(home, "instance.json"), "utf8"))), null, 2) + "\n");
  const relaunched = () => { fx.clearCalls(); const answer = startCli(fx, home, "restart"); return { answer, sandbox: fx.verbs("launch")[0]?.request.input.sandbox ?? null }; };

  // 1. It names another soul as its own: the soul is the home's path's (agents/dev/...), not the record's.
  rewrite((m) => ({ ...m, agent: "ops", workspace: { ...m.workspace, soul: { ...m.workspace.soul, name: "ops" } } }));
  assert.deepEqual(fx.cli(["readiness", "--home", home, "--json"]).json().result.sandbox, expected);
  const asOps = relaunched();
  assert.equal(JSON.stringify(asOps).includes("ops-only.example.net"), false, JSON.stringify(asOps.answer));

  // 2. It names a deployment of its own making, inside the events directory it may write, holding a
  //    link back to the home and a file of its own: neither the file nor the events path follows.
  const fake = join(eventsOf(fx), "y");
  mkdirSync(join(fake, "agents", "dev", "instances"), { recursive: true });
  symlinkSync(home, join(fake, "agents", "dev", "instances", "one"));
  mkdirSync(join(fake, "okf"), { recursive: true });
  writeFileSync(join(fake, "okf", "bindings.json"), JSON.stringify({ bases: { kb: { repository: "https://evil.example.net/x" } } }));
  rewrite((m) => ({ ...m, workspace: { ...m.workspace, deployment: fake } }));
  assert.deepEqual(fx.cli(["readiness", "--home", home, "--json"]).json().result.sandbox, expected);
  { const r = relaunched(); assert.deepEqual(r.sandbox, expected, JSON.stringify(r.answer).slice(0, 600)); }

  // 3. The same from inside the home, with its own events directory linked to another place.
  const inside = join(home, "x");
  mkdirSync(join(inside, "agents", "dev", "instances"), { recursive: true });
  symlinkSync(home, join(inside, "agents", "dev", "instances", "one"));
  mkdirSync(join(fx.dep, "victim-dir"));
  mkdirSync(join(inside, ".agents"), { recursive: true });
  symlinkSync(join(fx.dep, "victim-dir"), join(inside, ".agents", "events"));
  rewrite((m) => ({ ...m, workspace: { ...m.workspace, deployment: inside } }));
  assert.deepEqual(relaunched().sandbox.write, expected.write);

  // 4. It lists a module it does not have, or drops one: the record can only leave a host out.
  //    (As readiness computes it: a start of a home whose record of its modules was edited may be refused for that alone.)
  const computed = () => fx.cli(["readiness", "--home", home, "--json"]).json().result.sandbox;
  rewrite((m) => ({ ...m, modules: { ...m.modules, "acme.unknown": m.modules[MSG] } }));
  assert.deepEqual(computed().domains, expected.domains);
  rewrite((m) => { const { [MSG]: _dropped, "acme.unknown": _added, ...modules } = m.modules; return { ...m, modules }; });
  assert.deepEqual([computed().domains.map((d) => d.host), computed().skipped.map((k) => k.capability)], [["good.example.org"], [MSG]]);
});

test("the events directory handed as writable is a real directory at its own path: one reached through a link refuses the launch", async (t) => {
  const fx = deployment(t);
  rmSync(eventsOf(fx), { recursive: true, force: true });
  mkdirSync(join(fx.dep, "elsewhere"));
  mkdirSync(join(fx.dep, ".agents"), { recursive: true });
  symlinkSync(join(fx.dep, "elsewhere"), eventsOf(fx));
  const refused = fx.cli(["spawn", "dev", "--name", "nope", "--backend", "fake", "--launch-config", "claude", "--json"]).json();
  assert.deepEqual([refused.ok, refused.error.code], [false, "E_BACKEND_SANDBOX_HOST"], JSON.stringify(refused));
  assert.match(refused.error.message, /the session's sandbox may not be allowed to write .+\/\.agents\/events: it is reached through a symbolic link, or is no directory/);
  assert.deepEqual(fx.verbs("launch"), [], "the provider was never asked to launch");
  assert.equal(existsSync(join(fx.root, "dev", "instances", "nope")), false, "and the spawn was rolled back");
});

test("the deployment's own oats-local.yaml is read as it is now, and a repository this host's cache does not hold is named", async (t) => {
  const fx = deployment(t, { settings: {} });
  const { home } = await fx.launch("one");
  assert.deepEqual(fx.verbs("launch")[0].request.input.sandbox.missing, [{ capability: MSG, setting: "server", team: null }]);
  assert.equal(readWorkspace(fx).json().ok, true, "this host has read the workspace, as any CLI command does");
  // What a setup command writes to the deployment's own file reaches the home at its next launch,
  // with no read of any remote in between.
  const localPath = join(fx.dep, "oats-local.yaml");
  writeFileSync(localPath, `${readFileSync(localPath, "utf8").trimEnd()}\nsettings:\n  ${MSG}:\n    server: https://set-up.example.org\n`);
  fx.clearCalls();
  assert.equal(startCli(fx, home, "restart").ok, true);
  assert.deepEqual(fx.verbs("launch")[0].request.input.sandbox, { domains: [{ host: "set-up.example.org", capability: MSG, setting: "server" }], write: [{ path: eventsOf(fx), reason: "oats events" }], missing: [] });

  // This host's cache is gone: the read fetches nothing to make up for it, and says which repository it lacks.
  // (Asked of the read itself: the start around it reads the workspace's teams live, as every start does.)
  rmSync(fx.env.OATS_REMOTE_CACHE, { recursive: true, force: true });
  const source = await fx.inEnv(() => homeSandboxSource(home, { remoteOptions: fx.remoteOptions }));
  assert.deepEqual(Object.keys(source), ["unavailable"]);
  assert.match(source.unavailable, /^E_REMOTE_UNREADABLE: cannot read .+ws\.git without reaching it: this host has not observed it yet\. Any oats command that reads the workspace/);
  const left = existsSync(fx.env.OATS_REMOTE_CACHE) ? readdirSync(fx.env.OATS_REMOTE_CACHE) : [];
  assert.deepEqual(left.filter((entry) => !entry.startsWith(".")), [], "no repository was fetched into the cache");
  // And a start says so in its launch input.
  fx.clearCalls();
  assert.equal(startCli(fx, home, "restart").ok, true);
  assert.match(fx.verbs("launch")[0].request.input.sandbox.unavailable, /^E_REMOTE_UNREADABLE: cannot read .+ws\.git without reaching it/);
});
