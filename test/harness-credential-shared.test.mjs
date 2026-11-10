import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertLaunchRecipe, launchEffectiveEnv, launchEnvironment, launchEnvRefs, missingLaunchEnvRefs, planLaunch, startInstanceSession, renderLaunchRecipe, validateLaunchConfig } from "../lib/core.mjs";
import { checkStartEnv, recordStartEnv, START_ENV_FILE } from "../lib/start-env.mjs";

import { v2Deployment } from "./helpers/v2-deployment.mjs";
import { isolateSessionEnvironment, oatsSocket, systemExecutable, waitUntil } from "./helpers/host-fixture.mjs";

const CLI = resolve("bin/oats.mjs");
const base = mkdtempSync(join(tmpdir(), "oats-credentials-"));
const restoreEnv = isolateSessionEnvironment(base);
test.after(() => { restoreEnv(); rmSync(base, { recursive: true, force: true }); });
const recipe = (env) => ({ version: 2, harness: "claude", executable: "/usr/bin/true", args: [], env, model: null, hooks: { launch: {}, env: {}, contributions: [] } });
const cli = (args) => spawnSync(process.execPath, [CLI, ...args, "--json"], { encoding: "utf8", env: { ...process.env, OATS_HOME_DIR: join(base, "registry") } });

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
});

test("missing, unreadable, NUL and nonregular file references refuse with a provisioning remedy", () => {
  const file = join(base, "invalid-token");
  for (const kind of ["missing", "directory", "nul", "unreadable", "fifo"]) {
    rmSync(file, { recursive: true, force: true });
    if (kind === "directory") mkdirSync(file);
    if (kind === "nul") writeFileSync(file, "fixture\0hidden");
    if (kind === "unreadable") { writeFileSync(file, "fixture"); chmodSync(file, 0); }
    if (kind === "fifo") assert.equal(spawnSync("/usr/bin/mkfifo", [file]).status, 0);
    const r = recipe({ KEY: { fromFile: file } });
    assert.deepEqual(missingLaunchEnvRefs(r.env, {}), [`file:${file}`], kind);
    assert.throws(() => launchEnvRefs(r, {}), (e) => e.code === "E_LAUNCH_ENV_MISSING" && /oats harness token set claude --server <id>/.test(e.message), kind);
    const plan = planLaunch({ home: base, instance: "fixture", meta: { launch: r }, env: {}, preview: true });
    assert.equal(plan.preflight.find((p) => p.code === "E_LAUNCH_ENV_MISSING")?.ok, false, kind);
  }
});

test("spawn and start deliver both reference types without values in any tmux argv", async (t) => {
  const realTmux = systemExecutable("tmux"), bin = join(base, "bin"), calls = join(base, "tmux-argv");
  mkdirSync(bin);
  const quote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
  writeFileSync(join(bin, "tmux"), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${quote(calls)}\nexec ${quote(realTmux)} "$@"\n`);
  writeFileSync(join(bin, "claude"), `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(process.env.OATS_INSTANCE_HOME+'/received.json',JSON.stringify([process.env.KEY,process.env.OTHER]));\nsetInterval(()=>{},1000);\n`);
  for (const name of ["tmux", "claude"]) chmodSync(join(bin, name), 0o755);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  const file = join(base, "live-token"); writeFileSync(file, "file-fixture-secret\n");
  process.env.CREDENTIAL_FIXTURE_SOURCE = "env-fixture-secret";
  t.after(() => { delete process.env.CREDENTIAL_FIXTURE_SOURCE; });
  const fx = v2Deployment({ local: { "launch-configs": { files: { harness: "claude", executable: join(bin, "claude"), env: { KEY: { fromFile: file }, OTHER: { fromEnv: "CREDENTIAL_FIXTURE_SOURCE" } } } } } });
  t.after(() => { try { execFileSync(realTmux, ["-S", oatsSocket(), "kill-server"]); } catch { /* private fixture already exited */ } fx.cleanup(); });
  const { home } = await fx.spawn("dev", { name: "credentials-live", work: "checkout", launch: true, launchConfig: "files" });
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
  execFileSync(realTmux, ["-S", meta.tmux.socket, "kill-window", "-t", `=${meta.tmux.session}:${meta.tmux.window}`]);
  rmSync(received); writeFileSync(file, "rotated-fixture-secret\n");
  startInstanceSession(home, { env: { ...process.env } });
  await waitUntil(() => existsSync(received), { message: "second start reads rotated file" });
  assert.deepEqual(JSON.parse(readFileSync(received)), ["rotated-fixture-secret", "env-fixture-secret"]);
  assert.equal(readFileSync(calls, "utf8").includes("rotated-fixture-secret"), false);
  assert.equal(readdirSync(home).some((name) => name.startsWith(".oats-launch-env-")), false);
});
