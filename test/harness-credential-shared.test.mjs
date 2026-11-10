import test from "node:test";
import Ajv from "ajv";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertLaunchRecipe, launchEffectiveEnv, launchEnvironment, launchEnvRefs, missingLaunchEnvRefs, planLaunch, inspectInstanceSession, startInstanceSession, renderLaunchRecipe, validateLaunchConfig } from "../lib/core.mjs";
import { checkStartEnv, recordStartEnv, START_ENV_FILE } from "../lib/start-env.mjs";

import { launchConfigFolder } from "../lib/harness-trust.mjs";
import { resumeSessions } from "../lib/session-resume.mjs";
import { recordSeen } from "../lib/session-seen.mjs";
import { launchEnvHandoff } from "../lib/launch-env.mjs";
import { v2Deployment } from "./helpers/v2-deployment.mjs";
import { isolateSessionEnvironment, oatsSocket, systemExecutable, waitUntil } from "./helpers/host-fixture.mjs";

const CLI = resolve("bin/oats.mjs");
const base = mkdtempSync(join(tmpdir(), "oats-credentials-"));
const restoreEnv = isolateSessionEnvironment(base);
test.after(() => { restoreEnv(); rmSync(base, { recursive: true, force: true }); });
const recipe = (env) => ({ version: 2, harness: "claude", executable: "/usr/bin/true", args: [], env, model: null, hooks: { launch: {}, env: {}, contributions: [] } });
import { connectServer, readServers, readServerOperatorRoutes, targetOf, validateOperatorSshHost, validateServer } from "../lib/servers.mjs";

const cli = (args, extra = {}) => spawnSync(process.execPath, [CLI, ...args, "--json"], { encoding: "utf8", env: { ...process.env, OATS_HOME_DIR: join(base, "registry"), ...extra } });

test("fromFile validates an absolute path and survives launch-config set/list", () => {
  const file = join(base, "token ' #.txt");
  const config = { harness: "claude", env: { TOKEN: { fromFile: file } } };
  assert.equal(validateLaunchConfig("file", config), config);
  assert.doesNotThrow(() => assertLaunchRecipe(recipe(config.env), "fixture"));
  for (const ref of [{ fromFile: "relative" }, { fromFile: "" }, { fromFile: 42 }, { fromFile: "/a", fromEnv: "B" }, { fromFile: "/a", extra: true }, { fromFile: "/a\0b" }]) {
    assert.throws(() => validateLaunchConfig("bad", { harness: "claude", env: { TOKEN: ref } }), (e) => e.code === "E_LAUNCH_CONFIG_INVALID");
    assert.throws(() => assertLaunchRecipe(recipe({ TOKEN: ref }), "fixture"), (e) => e.code === "E_LAUNCH_RECIPE_UNSUPPORTED");
  }
  const scope = join(base, "config"); mkdirSync(scope);
  writeFileSync(join(scope, "oats-local.yaml"), "schemaVersion: 2\nworkspace: example.invalid/team/workspace\n");
  const definition = join(base, "definition.json"); writeFileSync(definition, JSON.stringify(config));
  let r = cli(["launch-config", "set", "file", "--file", definition, "--dir", scope]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  r = cli(["launch-config", "list", "--dir", scope]);
  assert.deepEqual(JSON.parse(r.stdout).result.configurations[0].env.TOKEN, { fromFile: file });
  assert.match(readFileSync(join(scope, "oats-local.yaml"), "utf8"), /fromFile:/);
  const listed = spawnSync(process.execPath, [CLI, "launch-config", "list", "--dir", scope], { encoding: "utf8", env: { ...process.env, OATS_HOME_DIR: join(base, "registry") } });
  assert.equal(listed.status, 0, listed.stderr);
  assert.ok(listed.stdout.includes(`TOKEN=<file:${file}>`), listed.stdout);
});

test("fromFile resolves again, strips one line ending, redacts and records only keyed digests", () => {
  const file = join(base, "resolve-token");
  const secret = "fixture-'$`credential";
  writeFileSync(file, secret + "\r\n");
  const r = recipe({ KEY: { fromFile: file }, OTHER: { fromEnv: "SRC" } });
  const refs = launchEnvRefs(r, { SRC: "environment-fixture" });
  assert.deepEqual(refs.map(({ target, value }) => [target, value]), [["KEY", secret], ["OTHER", "environment-fixture"]]);
  const launch = launchEnvironment({ configEnv: r.env, env: { ...process.env, SRC: "environment-fixture" } });
  assert.equal(launch.of("KEY").value, secret);
  assert.deepEqual(launchConfigFolder("CLAUDE_CONFIG_DIR", { CLAUDE_CONFIG_DIR: { fromEnv: "BAD_DIR" } }, { BAD_DIR: secret }), { problem: `CLAUDE_CONFIG_DIR ${JSON.stringify(secret)} is not an absolute path` });
  assert.equal(launchEffectiveEnv({ configEnv: r.env, base: { SRC: "environment-fixture" }, launch, harness: "claude" }).KEY, secret);
  const command = renderLaunchRecipe(r, { home: base, instance: "fixture", redact: true });
  assert.match(command, /KEY="\$OATS_LAUNCH_REF_KEY"/);
  assert.equal(command.includes(secret), false);
  const home = join(base, "digest"); mkdirSync(home);
  const names = refs.map((r) => r.source), values = Object.fromEntries(refs.map((r) => [r.source, r.value]));
  assert.equal(recordStartEnv(home, "start-one", names, values), true);
  assert.deepEqual(checkStartEnv(home, "start-one", names, values), { ok: true });
  assert.equal(readFileSync(join(home, START_ENV_FILE), "utf8").includes(secret), false);
  writeFileSync(file, "rotated\n\n");
  const next = launchEnvRefs(r, { SRC: "environment-fixture" });
  assert.equal(next[0].value, "rotated\n", "strip exactly one trailing line ending");
  assert.deepEqual(checkStartEnv(home, "start-one", next.map((r) => r.source), Object.fromEntries(next.map((r) => [r.source, r.value]))), { changed: [refs[0].source] });
  writeFileSync(file, ""); assert.equal(launchEnvRefs(r, { SRC: "environment-fixture" })[0].value, "");
  writeFileSync(file, "\uFEFFfixture-token\n");
  assert.equal(launchEnvRefs(r, { SRC: "environment-fixture" })[0].value, "\uFEFFfixture-token", "a UTF-8 BOM is preserved as part of the verbatim value");
});

test("missing, unreadable, NUL and nonregular file references refuse with a provisioning remedy", () => {
  const file = join(base, "invalid-token");
  for (const kind of ["missing", "directory", "nul", "invalid-utf8", "unreadable", "fifo", "oversize"]) {
    rmSync(file, { recursive: true, force: true });
    if (kind === "directory") mkdirSync(file);
    if (kind === "nul") writeFileSync(file, "fixture\0hidden");
    if (kind === "oversize") writeFileSync(file, "x".repeat(64 * 1024 + 1));
    if (kind === "invalid-utf8") writeFileSync(file, Buffer.from([0x61, 0x62, 0xff, 0xfe, 0x63, 0x64, 0x0a]));
    if (kind === "unreadable") { writeFileSync(file, "fixture"); chmodSync(file, 0); }
    if (kind === "fifo") assert.equal(spawnSync("/usr/bin/mkfifo", [file]).status, 0);
    const r = recipe({ KEY: { fromFile: file } });
    assert.deepEqual(missingLaunchEnvRefs(r.env, {}), [`file:${file}`], kind);
    const reasons = { missing: "is missing", directory: "is not a regular file", nul: "contains NUL", "invalid-utf8": "is not UTF-8", unreadable: "cannot be read", fifo: "is not a regular file", oversize: "is larger than 64 KiB" };
    assert.throws(() => launchEnvRefs(r, {}), (e) => e.code === "E_LAUNCH_ENV_MISSING" && /oats harness token set claude --server <id>/.test(e.message) && e.message.includes(reasons[kind]), kind);
    const plan = planLaunch({ home: base, instance: "fixture", meta: { launch: r }, env: {}, preview: true });
    assert.equal(plan.preflight.find((p) => p.code === "E_LAUNCH_ENV_MISSING")?.ok, false, kind);
  }
});

test("spawn and start deliver both reference types without values in any tmux argv", async (t) => {
  const realTmux = systemExecutable("tmux"), bin = join(base, "bin"), calls = join(base, "tmux-argv");
  mkdirSync(bin);
  const quote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
  writeFileSync(join(bin, "tmux"), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${quote(calls)}\nexec ${quote(realTmux)} "$@"\n`);
  writeFileSync(join(bin, "claude"), `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(process.env.OATS_INSTANCE_HOME+'/fixture.pid',String(process.pid));\nwriteFileSync(process.env.OATS_INSTANCE_HOME+'/received.json',JSON.stringify([process.env.KEY,process.env.OTHER]));\nsetInterval(()=>{},1000);\n`);
  for (const name of ["tmux", "claude"]) chmodSync(join(bin, name), 0o755);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  const file = join(base, "live-token"); writeFileSync(file, "file-fixture-secret\n");
  process.env.CREDENTIAL_FIXTURE_SOURCE = "env-fixture-secret";
  t.after(() => { delete process.env.CREDENTIAL_FIXTURE_SOURCE; });
  const auth = join(base, "live-auth"); mkdirSync(auth); writeFileSync(join(auth, ".credentials.json"), "fixture");
  const fx = v2Deployment({ souls: { dev: { soul: { capabilities: { "claude.fixture": { from: "here" } } } } }, capabilities: { "claude.fixture": { manifest: { environment: ["CLAUDE_CONFIG_DIR"] } } }, local: { "launch-configs": { warned: { harness: "claude", executable: join(bin, "claude"), env: { CLAUDE_CONFIG_DIR: auth } }, removed: { harness: "claude", executable: join(bin, "claude"), env: { CLAUDE_CODE_OAUTH_TOKEN: { fromFile: file } } }, files: { harness: "claude", executable: join(bin, "claude"), env: { KEY: { fromFile: file }, OTHER: { fromEnv: "CREDENTIAL_FIXTURE_SOURCE" } } }, blocked: { harness: "claude", executable: join(bin, "claude"), env: { CLAUDE_CONFIG_DIR: auth, CLAUDE_CODE_OAUTH_TOKEN: { fromFile: file } } } } } });
  t.after(() => { try { execFileSync(realTmux, ["-S", oatsSocket(), "kill-server"]); } catch { /* private fixture already exited */ } fx.cleanup(); });
  await assert.rejects(fx.spawn("dev", { name: "login-preview-refused", preview: true, work: "checkout", launch: true, launchConfig: "blocked" }), (e) => e.code === "E_CLAUDE_LOGIN_CREDENTIAL");
  assert.equal(existsSync(join(fx.root, "dev", "instances", "login-preview-refused")), false);
  const loginPreview = await fx.spawn("dev", { name: "login-preview-warned", preview: true, work: "checkout", launch: true, launchConfig: "warned" });
  assert.match(loginPreview.warnings.join("\n"), /oats harness token set claude/);
  await assert.rejects(fx.spawn("dev", { name: "login-refused", work: "checkout", launch: true, launchConfig: "blocked" }), (e) => e.code === "E_CLAUDE_LOGIN_CREDENTIAL");
  const { home } = await fx.spawn("dev", { name: "credentials-live", work: "checkout", launch: true, launchConfig: "files" });
  const preview = cli(["launch-config", "preview", "--home", home]);
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.deepEqual(JSON.parse(preview.stdout).result.environment.find((entry) => entry.name === "KEY"), { name: "KEY", fromFile: file });
  const received = join(home, "received.json");
  await waitUntil(() => existsSync(received), { message: "fixture harness received references" });
  assert.deepEqual(JSON.parse(readFileSync(received)), ["file-fixture-secret", "env-fixture-secret"]);
  assert.equal(readdirSync(home).some((name) => name.startsWith(".oats-launch-env-")), false);
  for (const value of ["file-fixture-secret", "env-fixture-secret"]) {
    assert.equal(readFileSync(calls, "utf8").includes(value), false, "no secret in spawned tmux argv");
    assert.equal(readFileSync(join(home, "instance.json"), "utf8").includes(value), false);
    assert.equal(readFileSync(join(home, START_ENV_FILE), "utf8").includes(value), false);
  }
  const meta = JSON.parse(readFileSync(join(home, "instance.json")));
  const digest = JSON.parse(readFileSync(join(home, START_ENV_FILE)));
  assert.equal(Object.keys(digest.digests).length, 2, "both sources recorded");
  recordSeen(join(fx.dep, "agents"), [{ home, startId: meta.startId, running: true, launched: true }]);
  execFileSync(realTmux, ["-S", meta.tmux.socket, "kill-window", "-t", `=${meta.tmux.session}:${meta.tmux.window}`]);
  const same = await resumeSessions({ deployment: fx.dep, plan: true });
  assert.equal(same.rows.find((r) => r.home === home)?.outcome, "fresh", JSON.stringify(same.rows));
  rmSync(received); writeFileSync(file, "rotated-fixture-secret\n");
  const changed = await resumeSessions({ deployment: fx.dep, plan: true });
  assert.equal(changed.rows.find((r) => r.home === home)?.code, "E_LAUNCH_ENV_CHANGED");
  startInstanceSession(home, { env: { ...process.env } });
  await waitUntil(() => existsSync(received), { message: "second start reads rotated file" });
  assert.deepEqual(JSON.parse(readFileSync(received)), ["rotated-fixture-secret", "env-fixture-secret"]);
  assert.equal(readFileSync(calls, "utf8").includes("rotated-fixture-secret"), false);
  assert.equal(readdirSync(home).some((name) => name.startsWith(".oats-launch-env-")), false);
  process.kill(Number(readFileSync(join(home, "fixture.pid"))), "SIGTERM");
  await waitUntil(() => inspectInstanceSession(home).state === "shell", { message: "fixture harness left its fallback shell" });
  assert.throws(() => startInstanceSession(home, { launchConfig: "blocked", env: process.env }), (e) => e.code === "E_CLAUDE_LOGIN_CREDENTIAL");
  rmSync(received);
  const restarted = startInstanceSession(home, { env: process.env });
  await waitUntil(() => existsSync(received), { message: "in-place pane restart receives references" });
  assert.equal(restarted.reused, "pane");
  assert.deepEqual(JSON.parse(readFileSync(received)), ["rotated-fixture-secret", "env-fixture-secret"]);
  assert.equal(readFileSync(calls, "utf8").includes("rotated-fixture-secret"), false);
  process.kill(Number(readFileSync(join(home, "fixture.pid"))), "SIGTERM");
  await waitUntil(() => inspectInstanceSession(home).state === "shell", { message: "fixture stopped before removed-selector start" });
  execFileSync(realTmux, ["-S", meta.tmux.socket, "set-environment", "-t", `=${meta.tmux.session}`, "CLAUDE_CONFIG_DIR", auth]);
  assert.doesNotThrow(() => startInstanceSession(home, { launchConfig: "removed", env: process.env }), "a selector the launch removes must not select the pane's login credential");
});

test("Claude refuses a login credential alongside any OATS-set token reference", () => {
  const dir = join(base, "claude-login"); mkdirSync(dir);
  writeFileSync(join(dir, ".credentials.json"), "fixture login credential, never read");
  const token = join(base, "claude-token"); writeFileSync(token, "fixture-token\n");
  for (const value of ["", "literal-fixture", { fromEnv: "SRC" }, { fromFile: token }]) {
    const r = recipe({ CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_OAUTH_TOKEN: value });
    const args = { home: base, instance: "fixture", meta: { launch: r }, env: { ...process.env, SRC: "referenced-fixture" } };
    assert.throws(() => planLaunch(args), (e) => e.code === "E_CLAUDE_LOGIN_CREDENTIAL" && /oats harness token set claude/.test(e.message) && e.message.includes(join(dir, ".credentials.json")));
    assert.equal(planLaunch({ ...args, preview: true }).preflight.some((p) => p.code === "E_CLAUDE_LOGIN_CREDENTIAL" && p.detail.includes(join(dir, ".credentials.json"))), true);
  }
  const hooked = recipe({ CLAUDE_CONFIG_DIR: dir }); hooked.hooks.env.CLAUDE_CODE_OAUTH_TOKEN = "";
  assert.throws(() => planLaunch({ home: base, instance: "fixture", meta: { launch: hooked }, env: process.env }), (e) => e.code === "E_CLAUDE_LOGIN_CREDENTIAL");
});

test("Claude warns without an OATS-set token and checks the effective config directory or HOME", () => {
  const ownHome = join(base, "claude-home"), defaultDir = join(ownHome, ".claude"), selected = join(base, "claude-selected");
  mkdirSync(defaultDir, { recursive: true }); mkdirSync(selected);
  writeFileSync(join(defaultDir, ".credentials.json"), "fixture");
  const plan = (env, inherited = {}) => planLaunch({ home: base, instance: "fixture", meta: { launch: recipe(env) }, env: { ...process.env, ...inherited } });
  for (const env of [{ HOME: ownHome }, { HOME: { fromEnv: "OWN_HOME" } }]) {
    assert.match(plan(env, { OWN_HOME: ownHome, CLAUDE_CODE_OAUTH_TOKEN: "inherited-fixture" }).warnings.join("\n"), /oats harness token set claude/);
  }
  assert.equal(plan({ HOME: ownHome, CLAUDE_CONFIG_DIR: selected }).warnings.some((w) => w.includes("oats harness token set claude")), false, "explicit config directory takes precedence");
  writeFileSync(join(selected, ".credentials.json"), "fixture");
  const selector = join(base, "claude-selector"); writeFileSync(selector, selected + "\n");
  assert.throws(() => plan({ CLAUDE_CONFIG_DIR: { fromFile: selector } }), (e) => e.code === "E_LAUNCH_RECIPE_UNSUPPORTED");
  const codex = recipe({ HOME: ownHome, CLAUDE_CODE_OAUTH_TOKEN: "fixture" }); codex.harness = "codex";
  assert.doesNotThrow(() => planLaunch({ home: base, instance: "fixture", meta: { launch: codex }, env: process.env }));
});

test("server add stores and lists the optional operator alias without changing the agent target", () => {
  const bin = join(base, "server-bin"); mkdirSync(bin);
  writeFileSync(join(bin, "ssh"), "#!/bin/sh\nexit 1\n"); chmodSync(join(bin, "ssh"), 0o755);
  const extra = { PATH: `${bin}:${process.env.PATH}` };
  let r = cli(["server", "add", "box", "--ssh", "agent-host", "--operator-ssh", "operator-host", "--workspace", "/srv/ws"], extra);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).result.operatorSshHost, "operator-host");
  r = cli(["server", "list"], extra);
  const row = JSON.parse(r.stdout).result.servers[0];
  assert.equal(row.operatorSshHost, "operator-host");
  assert.equal(Object.hasOwn(row.target, "operatorSshHost"), false);
  const text = spawnSync(process.execPath, [CLI, "server", "list"], { env: { ...process.env, ...extra, OATS_HOME_DIR: join(base, "registry") }, encoding: "utf8" });
  assert.match(text.stdout, /operator ssh operator-host/);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(join(base, "registry", "servers.json"))).servers.box, "operatorSshHost"), false);
  assert.deepEqual(JSON.parse(readFileSync(join(base, "registry", "server-operator-routes.json"))), { box: { operatorSshHost: "operator-host" } });
  for (const alias of ["", "-option", "user@host", "host alias", "host;id", null, 42]) assert.throws(() => validateOperatorSshHost(alias), (e) => e.code === "E_SERVER_INVALID");
  assert.throws(() => validateServer("box", { sshHost: "agent-host", workspace: "/srv/ws", operatorSshHost: "operator-host" }), (e) => e.code === "E_SERVER_INVALID", "the agent registry keeps its older field set");
  assert.doesNotThrow(() => validateServer("old", { sshHost: "old-host", workspace: "/srv/ws" }));
});

test("server connect records the operator alias while every remote call uses the agent route", () => {
  const old = process.env.OATS_HOME_DIR;
  const registry = mkdtempSync("/tmp/oats-cr-"); // short even under CI's per-file TMPDIR: the SSH control socket must fit
  process.env.OATS_HOME_DIR = registry;
  try {
    const options = { id: "connected", sshHost: "agent-host", operatorSshHost: "operator-host", workspaceRef: "git:github.com/acme/ws", dir: "/srv/ws", path: "/usr/bin", localVersion: "0.39.0" };
    const envelope = (result) => JSON.stringify({ schemaVersion: 1, ok: true, result });
    const remote = (bin, argv) => {
      assert.equal(argv.includes("operator-host"), false);
      const cmd = argv.at(-1);
      if (/(^| )true$/.test(cmd)) return "";
      if (/ version --json$/.test(cmd)) return JSON.stringify({ schemaVersion: 1, desktopApi: 1, name: "@awebai/oats", version: "99.0.0", features: ["server-connect"] });
      if (/ onboard .* --check --json$/.test(cmd)) return envelope({ check: true, dir: "/srv/ws", state: "deployment", workspace: { ref: options.workspaceRef, key: "github.com/acme/ws" }, remote: { readable: true, commit: "a".repeat(40) } });
      if (/ status --json --dir \/srv\/ws$/.test(cmd)) return envelope({ root: "/srv/ws/agents", agents: [], workspace: { key: "github.com/acme/ws" } });
      if (/ souls --json --dir \/srv\/ws$/.test(cmd)) return envelope({ souls: [] });
      throw new Error(`unexpected fake SSH call: ${cmd}`);
    };
    const result = connectServer(options, { execFileSync: remote });
    assert.equal(result.registration.operatorSshHost, "operator-host");
    assert.equal(Object.hasOwn(readServers().connected, "operatorSshHost"), false);
    assert.deepEqual(JSON.parse(readFileSync(join(process.env.OATS_HOME_DIR, "server-operator-routes.json"))), { connected: { operatorSshHost: "operator-host" } });
    assert.equal(targetOf(result.registration).sshHost, "agent-host");
    assert.equal(connectServer(options, { execFileSync: remote }).registration.operatorSshHost, "operator-host");
    const bytes = readFileSync(join(process.env.OATS_HOME_DIR, "servers.json"), "utf8");
    const { operatorSshHost, ...withoutOperator } = options;
    for (const request of [{ ...options, operatorSshHost: "ignored-operator" }, { ...withoutOperator, noOperatorSsh: true }]) {
      const kept = connectServer(request, { execFileSync: remote });
      assert.equal(kept.registration.operatorSshHost, "operator-host");
      assert.match(kept.steps.find((s) => s.step === "register").detail, /operator route.*not changed.*--replace/);
    }
    assert.equal(connectServer({ ...withoutOperator, replace: true }, { execFileSync: remote }).registration.operatorSshHost, operatorSshHost);
    assert.equal(connectServer({ ...options, operatorSshHost: "other-operator", replace: true }, { execFileSync: remote }).registration.operatorSshHost, "other-operator");
    assert.equal(connectServer({ ...withoutOperator, noOperatorSsh: true, replace: true }, { execFileSync: remote }).registration.operatorSshHost, undefined);
    assert.equal(readFileSync(join(process.env.OATS_HOME_DIR, "servers.json"), "utf8"), bytes);
    assert.deepEqual(readServerOperatorRoutes(), {});
    assert.throws(() => connectServer({ ...options, noOperatorSsh: true }, { execFileSync: () => assert.fail("conflicting flags never reach SSH") }), (e) => e.code === "E_BAD_ARGS");
    assert.throws(() => connectServer({ ...options, operatorSshHost: "user@host" }, { execFileSync: () => assert.fail("invalid alias never reaches SSH") }), (e) => e.code === "E_SERVER_INVALID");
    // An older kernel removes only the legacy registration, leaving an orphan route.
    writeFileSync(join(process.env.OATS_HOME_DIR, "servers.json"), '{"servers":{}}\n');
    writeFileSync(join(process.env.OATS_HOME_DIR, "server-operator-routes.json"), JSON.stringify({ connected: { operatorSshHost: "orphan-operator" } }));
    assert.equal(connectServer({ ...withoutOperator, sshHost: "different-agent" }, { execFileSync: remote }).registration.operatorSshHost, undefined);
    assert.deepEqual(readServerOperatorRoutes(), {});
  } finally { process.env.OATS_HOME_DIR = old; rmSync(registry, { recursive: true, force: true }); }
});

test("operator route changes preserve older registry bytes and remove cleans the sidecar", () => {
  const dir = join(base, "sidecar-registry"), bin = join(base, "sidecar-bin"); mkdirSync(dir); mkdirSync(bin);
  writeFileSync(join(bin, "ssh"), "#!/bin/sh\nexit 1\n"); chmodSync(join(bin, "ssh"), 0o755);
  const file = join(dir, "servers.json"), routes = join(dir, "server-operator-routes.json");
  const bytes = '{"servers": {"box": {"workspaceKey":"github.com/acme/ws", "workspace":"/srv/ws", "sshHost":"agent-host"}}}\n';
  writeFileSync(file, bytes);
  const extra = { OATS_HOME_DIR: dir, PATH: `${bin}:${process.env.PATH}` };
  const add = (...flags) => cli(["server", "add", "box", "--ssh", "agent-host", "--workspace", "/srv/ws", "--replace", ...flags], extra);
  let r = add("--operator-ssh", "operator-host");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(file, "utf8"), bytes, "only the operator route changed, so the legacy registry stays byte-identical");
  assert.deepEqual(JSON.parse(readFileSync(routes)), { box: { operatorSshHost: "operator-host" } });
  assert.equal(statSync(routes).mode & 0o777, 0o600);
  r = add("--operator-ssh", "other-host", "--no-operator-ssh");
  assert.equal(JSON.parse(r.stdout).error.code, "E_BAD_ARGS");
  assert.deepEqual(JSON.parse(readFileSync(routes)), { box: { operatorSshHost: "operator-host" } });
  r = add();
  assert.equal(JSON.parse(r.stdout).result.operatorSshHost, "operator-host", "replace without an operator flag keeps the route");
  r = add("--no-operator-ssh");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(Object.hasOwn(JSON.parse(r.stdout).result, "operatorSshHost"), false);
  assert.deepEqual(JSON.parse(readFileSync(routes)), {});
  r = add("--operator-ssh", "new-operator"); assert.equal(r.status, 0, r.stderr);
  r = cli(["server", "remove", "box"], extra); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(routes)), {});
  assert.deepEqual(JSON.parse(readFileSync(file)), { servers: {} });
});

test("server add replace learns an answering host's key without a false concurrency warning", () => {
  const dir = join(base, "answered-registry"), bin = join(base, "answered-bin"); mkdirSync(dir); mkdirSync(bin);
  writeFileSync(join(bin, "ssh"), `#!${process.execPath}\nconsole.log(JSON.stringify({schemaVersion:1,ok:true,result:{agents:[],workspace:{key:process.env.FIXTURE_KEY}}}));\n`);
  chmodSync(join(bin, "ssh"), 0o755);
  const file = join(dir, "servers.json");
  const bytes = '{"servers":{"box":{"workspaceKey":"github.com/acme/old","workspace":"/srv/ws","sshHost":"agent-host"}}}\n';
  for (const reported of ["github.com/acme/old", "github.com/acme/new"]) {
    writeFileSync(file, bytes);
    const r = cli(["server", "add", "box", "--ssh", "agent-host", "--workspace", "/srv/ws", "--replace", "--operator-ssh", "operator-host"], { OATS_HOME_DIR: dir, PATH: `${bin}:${process.env.PATH}`, FIXTURE_KEY: reported });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const result = JSON.parse(r.stdout).result;
    assert.equal(result.workspaceKey, reported);
    assert.deepEqual(result.warnings ?? [], []);
    assert.equal(JSON.parse(readFileSync(file)).servers.box.workspaceKey, reported);
    if (reported === "github.com/acme/old") assert.equal(readFileSync(file, "utf8"), bytes, "an answered operator-only update also preserves registry bytes");
  }
});

test("a fresh server add cannot inherit an orphan operator route", () => {
  const dir = join(base, "orphan-registry"), bin = join(base, "orphan-bin"); mkdirSync(dir); mkdirSync(bin);
  writeFileSync(join(bin, "ssh"), "#!/bin/sh\nexit 1\n"); chmodSync(join(bin, "ssh"), 0o755);
  writeFileSync(join(dir, "servers.json"), '{"servers":{}}\n');
  const routes = join(dir, "server-operator-routes.json");
  writeFileSync(routes, JSON.stringify({ box: { operatorSshHost: "old-operator" }, other: { operatorSshHost: "other-operator" } }));
  const extra = { OATS_HOME_DIR: dir, PATH: `${bin}:${process.env.PATH}` };
  const r = cli(["server", "add", "box", "--ssh", "different-host", "--workspace", "/srv/other"], extra);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).result.operatorSshHost, undefined);
  assert.deepEqual(JSON.parse(readFileSync(routes)), { other: { operatorSshHost: "other-operator" } });
  const listed = cli(["server", "list"], extra);
  assert.equal(JSON.parse(listed.stdout).result.servers[0].operatorSshHost, undefined);
});

test("server add replace preserves a workspace key changed while the host is answering", () => {
  const dir = join(base, "raced-registry"), bin = join(base, "raced-bin"); mkdirSync(dir); mkdirSync(bin);
  writeFileSync(join(bin, "ssh"), `#!${process.execPath}
import {readFileSync,writeFileSync} from 'node:fs';
const file=process.env.OATS_HOME_DIR+'/servers.json';
const doc=JSON.parse(readFileSync(file));doc.servers.box.workspaceKey='github.com/acme/concurrent';
writeFileSync(file,JSON.stringify(doc));
console.log(JSON.stringify({schemaVersion:1,ok:true,result:{agents:[],workspace:{key:'github.com/acme/reported'}}}));
`); chmodSync(join(bin, "ssh"), 0o755);
  const file = join(dir, "servers.json");
  writeFileSync(file, JSON.stringify({ servers: { box: { sshHost: "agent-host", workspace: "/srv/ws", workspaceKey: "github.com/acme/before" } } }));
  const r = cli(["server", "add", "box", "--ssh", "agent-host", "--workspace", "/srv/ws", "--replace"], { OATS_HOME_DIR: dir, PATH: `${bin}:${process.env.PATH}` });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(readFileSync(file)).servers.box.workspaceKey, "github.com/acme/concurrent");
  assert.equal(JSON.parse(r.stdout).result.workspaceKey, null, "a lost race cannot report the preserved key as established");
  assert.match(JSON.parse(r.stdout).result.warnings.join("\n"), /changed while the host was asked/);
});

test("reference handoff is private, literal and deleted before the command runs", () => {
  const dir = join(base, "handoff"); mkdirSync(dir);
  const value = "fixture ' \" $(touch NEVER) `false`\nsecond line";
  const abandoned = join(dir, ".oats-launch-env-abandoned.sh"), unrelated = join(dir, "keep-me.sh");
  writeFileSync(abandoned, "fixture-old-secret"); writeFileSync(unrelated, "keep me");
  const h = launchEnvHandoff(dir, "test-start", [{ name: "OATS_LAUNCH_REF_SECRET", value }]);
  const file = join(dir, ".oats-launch-env-test-start.sh");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(existsSync(abandoned), false, "a new start removes abandoned secret handoffs");
  assert.equal(readFileSync(unrelated, "utf8"), "keep me");
  const command = `${JSON.stringify(process.execPath)} -e 'process.stdout.write(JSON.stringify([process.env.OATS_LAUNCH_REF_SECRET,require("node:fs").existsSync(process.argv[1])]))' ${JSON.stringify(file)}`;
  const wrapped = h.wrap(command);
  assert.equal(wrapped.includes(value), false);
  const child = spawnSync("/bin/sh", ["-c", wrapped], { encoding: "utf8", env: process.env, cwd: dir });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), [value, false]);
  assert.equal(existsSync(join(dir, "NEVER")), false, "contents are not shell instructions");
  h.remove();
  writeFileSync(abandoned, "fixture-old-secret");
  launchEnvHandoff(dir, "without-references", []);
  assert.equal(existsSync(abandoned), false, "a start without references also removes abandoned handoffs");
});


test("fromFile is refused for directory locations with a literal or fromEnv remedy", () => {
  const schema = JSON.parse(readFileSync(new URL("../docs/oats-local.schema.json", import.meta.url), "utf8"));
  const schemaEnv = new Ajv().compile(schema.properties["launch-configs"].additionalProperties.properties.env);
  assert.equal(schemaEnv({ TOKEN: { fromFile: "/fixture/token" } }), true);
  for (const name of ["HOME", "PATH", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"]) {
    const env = { [name]: { fromFile: "/fixture/location" } };
    assert.equal(schemaEnv(env), false, `${name}: schema refuses file-backed locations`);
    assert.throws(() => validateLaunchConfig("locations", { harness: "claude", env }), (e) => e.code === "E_LAUNCH_CONFIG_INVALID" && e.message.includes(`${name} is a directory location; give it as a literal or {fromEnv}. fromFile is for credential values.`));
    assert.throws(() => assertLaunchRecipe(recipe(env), "fixture"), (e) => e.code === "E_LAUNCH_RECIPE_UNSUPPORTED" && e.message.includes("fromFile is for credential values"));
    for (const value of ["/fixture/directory", { fromEnv: "FIXTURE_DIRECTORY" }]) {
      assert.doesNotThrow(() => validateLaunchConfig("locations", { harness: "claude", env: { [name]: value } }));
      assert.equal(schemaEnv({ [name]: value }), true);
    }
  }
});


test("fromFile accepts at most 64 KiB of source bytes including the line ending", () => {
  const file = join(base, "size-limit"), r = recipe({ TOKEN: { fromFile: file } });
  writeFileSync(file, "x".repeat(64 * 1024 - 1) + "\n");
  assert.equal(launchEnvRefs(r, {})[0].value.length, 64 * 1024 - 1);
  writeFileSync(file, "x".repeat(64 * 1024) + "\n");
  assert.throws(() => launchEnvRefs(r, {}), (e) => e.code === "E_LAUNCH_ENV_MISSING" && /is larger than 64 KiB/.test(e.message));
});

function hookedCredentials(t) {
  const dir = mkdtempSync(join(base, "hook-selector-"));
  const ambient = join(dir, "ambient"), clean = join(dir, "clean"), dirty = join(dir, "dirty"), token = join(dir, "token"), events = join(dir, "hook-events");
  for (const path of [join(ambient, ".claude"), clean, dirty]) mkdirSync(path, { recursive: true });
  for (const path of [join(ambient, ".claude"), dirty]) writeFileSync(join(path, ".credentials.json"), "fixture");
  writeFileSync(token, "fixture-hook-token\n");
  const executable = join(dir, "harness");
  writeFileSync(executable, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(process.env.OATS_INSTANCE_HOME+'/fixture.pid',String(process.pid));\nsetInterval(()=>{},1000);\n`);
  chmodSync(executable, 0o755);
  const hook = `import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs';\nimport {join} from 'node:path';\nconst home=process.env.OATS_HOME, instance=process.env.OATS_INSTANCE;\nconst selector=join(home,'selector');\nconst dir=existsSync(selector)?readFileSync(selector,'utf8'):instance.includes('dirty')?${JSON.stringify(dirty)}:${JSON.stringify(clean)};\nappendFileSync(${JSON.stringify(events)},instance+'\\n');\nif(process.env.OATS_LAUNCH_PREVIEW!=='1' && process.env.OATS_HARNESS==='claude' && existsSync(join(home,'create-credential')))writeFileSync(join(dir,'.credentials.json'),'fixture');\nprocess.stdout.write(JSON.stringify({env:{CLAUDE_CONFIG_DIR:dir}})+'\\n');\n`;
  const fx = v2Deployment({ souls: { hooked: { soul: { capabilities: { "claude.selector": { from: "here" } } } }, plain: {} }, capabilities: { "claude.selector": { manifest: { environment: ["CLAUDE_CONFIG_DIR"], launchPreview: true, hooks: { spawn: "hook.mjs", launch: "hook.mjs" } }, files: { "hook.mjs": hook } } }, local: { "launch-configs": {
    token: { harness: "claude", executable, env: { CLAUDE_CODE_OAUTH_TOKEN: { fromFile: token } } },
    claude: { harness: "claude", executable, env: { CLAUDE_CONFIG_DIR: clean, CLAUDE_CODE_OAUTH_TOKEN: { fromFile: token } } },
    codex: { harness: "codex", executable, env: { CLAUDE_CONFIG_DIR: dirty, CLAUDE_CODE_OAUTH_TOKEN: { fromFile: token } } },
    codexHook: { harness: "codex", executable, env: { CLAUDE_CODE_OAUTH_TOKEN: { fromFile: token } } },
  } } });
  fx.env.HOME = ambient;
  const tmux = systemExecutable("tmux");
  t.after(() => { try { execFileSync(tmux, ["-S", oatsSocket(), "kill-server"]); } catch { /* private server already gone */ } fx.cleanup(); });
  const stopped = async (home) => {
    await waitUntil(() => existsSync(join(home, "fixture.pid")), { message: "fixture harness started" });
    process.kill(Number(readFileSync(join(home, "fixture.pid"))), "SIGTERM");
    await waitUntil(() => inspectInstanceSession(home).state === "shell", { message: "fixture left a fallback shell" });
  };
  return { fx, clean, dirty, events, stopped };
}

test("hook selectors defer preview and check the environment supplied by spawn and launch hooks", async (t) => {
  const { fx, clean, dirty, events, stopped } = hookedCredentials(t);
  const preview = await fx.spawn("hooked", { name: "hook-dirty-preview", work: "checkout", preview: true, launch: true, launchConfig: "token" });
  assert.equal(preview.warnings?.some((line) => line.includes("/login credential")) ?? false, false);
  assert.equal(existsSync(events), false, "preview does not execute hooks");
  await assert.rejects(fx.spawn("hooked", { name: "hook-dirty-apply", work: "checkout", launch: true, launchConfig: "token" }), (e) => e.code === "E_CLAUDE_LOGIN_CREDENTIAL");
  assert.match(readFileSync(events, "utf8"), /hook-dirty-apply/, "the refusal followed the hook");
  const { home, warnings = [] } = await fx.spawn("hooked", { name: "hook-clean-apply", work: "checkout", launch: true, launchConfig: "token" });
  assert.equal(warnings.some((line) => line.includes("/login credential")), false, "clean hook selector wins over dirty pane HOME");
  await stopped(home);
  writeFileSync(join(home, "selector"), dirty);
  assert.throws(() => startInstanceSession(home, { env: process.env }), (e) => e.code === "E_CLAUDE_LOGIN_CREDENTIAL");
  writeFileSync(join(home, "selector"), clean);
  assert.doesNotThrow(() => startInstanceSession(home, { env: process.env }));
});

test("leaving Claude for Codex does not run the Claude credential check", async (t) => {
  const { fx, stopped } = hookedCredentials(t);
  const { home } = await fx.spawn("plain", { name: "switch-from-claude", work: "checkout", launch: true, launchConfig: "claude" });
  await stopped(home);
  const codex = startInstanceSession(home, { launchConfig: "codex", env: process.env });
  assert.equal(codex.harness, "codex");
  assert.equal(codex.warnings?.some((line) => line.includes("/login credential")) ?? false, false);
});

test("entering Claude checks credentials created by the real launch hook", async (t) => {
  const { fx, stopped } = hookedCredentials(t);
  const reverse = await fx.spawn("hooked", { name: "switch-from-codex", work: "checkout", launch: true, launchConfig: "codexHook" });
  await stopped(reverse.home);
  writeFileSync(join(reverse.home, "create-credential"), "fixture");
  assert.throws(() => startInstanceSession(reverse.home, { launchConfig: "token", env: process.env }), (e) => e.code === "E_CLAUDE_LOGIN_CREDENTIAL", "the real launch hook creates credentials after the planner's preview check");
});
