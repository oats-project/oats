import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildNorthwind } from "./fixtures/northwind/build.mjs";
import { inertHarnessPath } from "./helpers/runtime-stub.mjs";

const CLI = resolve(new URL("../bin/oats.mjs", import.meta.url).pathname);
const base = realpathSync(mkdtempSync(join(tmpdir(), "oats-ops-route-")));
test.after(() => rmSync(base, { recursive: true, force: true }));
function write(p, c) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); }

test("inspect and operation run route to a registered server over its saved route: explicit --dir travels as is, --home is its own context, an old remote is refused before anything is sent", { timeout: 300_000 }, async () => {
  const env = { ...process.env, OATS_HOME_DIR: join(base, "oats-home"), HOME: join(base, "home"), OATS_REMOTE_CACHE: join(base, "cache"), OATS_PACKAGE_CATALOG: join(base, "catalog.json"),
    OATS_TMUX_SESSION: `none-${process.pid}`, PI_AGENTS_TMUX_SESSION: `none-${process.pid}` };
  for (const k of ["OATS_INSTANCE", "OATS_INSTANCE_HOME", "OATS_HOME", "OATS_ROOT", "PI_AGENT_INSTANCE", "PI_AGENT_HOME", "PI_AGENTS_ROOT"]) delete env[k];
  mkdirSync(env.HOME, { recursive: true });
  // The "remote" workspace: a Northwind deployment with one spawned release-manager home.
  const fx = await buildNorthwind(join(base, "fx"));
  writeFileSync(env.OATS_PACKAGE_CATALOG, JSON.stringify({ packages: fx.catalog }, null, 2));
  const team = join(base, "northwind-workspace");
  mkdirSync(join(team, "agents"), { recursive: true });
  writeFileSync(join(team, "oats-local.yaml"), `schemaVersion: 2\nworkspace: ${fx.refs.agents}\n`);
  const local = (args) => spawnSync(process.execPath, [CLI, ...args, "--json"], { encoding: "utf8", env: { ...env, PATH: inertHarnessPath(base) }, cwd: team });
  let r = local(["sync", "--dir", team]); assert.equal(r.status, 0, r.stdout + r.stderr);
  r = local(["spawn", "release-manager", "--dir", team, "--purpose", "r1", "--work", "directory", "--no-launch", "--provider", "oats.okf", "state-dir=/tmp/nw-state"]); assert.equal(r.status, 0, r.stdout + r.stderr);
  const { home, instance } = JSON.parse(r.stdout).result;
  // A fake ssh that logs its argv and runs the remote command locally through sh -c with THIS stdin.
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  const log = join(base, "ssh.log");
  write(join(bin, "ssh"), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(log)}\nprintf -- '--\\n' >> ${JSON.stringify(log)}\nwhile [ "$1" != "--" ]; do shift; done\nshift; shift\nexec sh -c "$1"\n`);
  chmodSync(join(bin, "ssh"), 0o755);
  env.PATH = `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`;
  const oldOats = join(base, "old-oats.sh");
  write(oldOats, `#!/bin/sh\necho '{"schemaVersion":1,"name":"@awebai/oats","version":"0.69.15","desktopApi":1,"harnesses":["pi"],"sessionBackends":["tmux"],"launchOptions":[],"remote":["session"],"features":["session-upload"]}'\n`); chmodSync(oldOats, 0o755);
  write(join(env.OATS_HOME_DIR, "servers.json"), JSON.stringify({ servers: { build: { sshHost: "build-host", workspace: team, oatsPath: CLI }, old: { sshHost: "old-host", workspace: team, oatsPath: oldOats } } }));
  write(join(env.OATS_HOME_DIR, "remote", "build", `${instance}.json`), JSON.stringify({ serverId: "build", instance, home, target: { sshHost: "build-host", workspace: team, oatsPath: CLI } }));
  const oats = (args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, cwd: base }); const json = () => { try { return JSON.parse(r.stdout.trim()); } catch { throw new Error(`no JSON: ${r.stdout}\n${r.stderr}`); } }; return { ...r, json }; };
  const sent = () => readFileSync(log, "utf8");
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // inspect with an explicit --dir: the exact scope travels; the answer carries the server.
  r = oats(["inspect", "--server", "build", "--dir", team, "--soul", "release-manager", "--agents-root", join(team, "agents"), "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  let res = r.json().result; assert.equal(res.server, "build"); assert.equal(res.subject.kind, "soul"); assert.equal(res.subject.soul, "release-manager");
  assert.match(sent(), new RegExp(`inspect --dir ${escape(team)} --soul release-manager`));
  // inspect --home without --dir: no workspace scope is added; the home is its own context.
  r = oats(["inspect", "--server", "build", "--home", home, "--json"]); assert.equal(r.status, 0, r.stdout + r.stderr);
  const homeLine = sent().split("\n").filter((l) => l.includes("inspect --home")).at(-1);
  assert.ok(homeLine && !homeLine.includes("--dir"), `no --dir added for a home: ${homeLine}`);
  assert.deepEqual(r.json().result.subject, { kind: "instance", instance, home, soul: "release-manager" });
  // A scope command without --dir gets the registered workspace.
  r = oats(["inspect", "--server", "build", "--soul", "release-manager", "--json"]); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(sent().split("\n").some((l) => l.includes(`inspect --soul release-manager --dir ${team} --json`)), "the registered workspace scopes an unscoped command");
  // (`oats use` and `oats soul set` routing were removed with the classic config surface — workspace model v2.)
  // operation run on the home: the provider's documents come back.
  r = oats(["operation", "run", "knowledge:status", "--server", "build", "--home", home, "--json"]); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json().result.result.documents.map((d) => d.label), ["Status"]); assert.match(r.json().result.result.documents[0].text, new RegExp(`Instance: ${instance}`)); assert.equal(r.json().result.server, "build");
  // An exact remote home or a saved instance name resolves its FROZEN route: the snapshot's target, even after the registration moved; a home/name disagreement is refused.
  write(join(env.OATS_HOME_DIR, "servers.json"), JSON.stringify({ servers: { build: { sshHost: "moved-host", workspace: team, oatsPath: CLI }, old: { sshHost: "old-host", workspace: team, oatsPath: oldOats } } }));
  r = oats(["inspect", "--server", "build", "--instance", instance, "--json"]); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json().result.subject.home, home, "--instance resolved to the saved route's home"); assert.deepEqual(r.json().result.route, { home, instance, frozen: true });
  const lastHost = sent().split("\n--\n").filter((b) => b.includes("inspect --home")).at(-1);
  assert.ok(lastHost.includes("build-host") && !lastHost.includes("moved-host"), `frozen route target used: ${lastHost}`);
  r = oats(["inspect", "--server", "build", "--soul", "release-manager", "--json"]); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(sent().split("\n--\n").filter((b) => b.includes("inspect --soul") && b.includes(`--dir ${team}`)).at(-1).includes("moved-host"), "a scope request uses the registration");
  assert.equal(oats(["inspect", "--server", "build", "--instance", instance, "--home", join(team, "elsewhere"), "--json"]).json().error.code, "E_HOME_MISMATCH");
  write(join(env.OATS_HOME_DIR, "servers.json"), JSON.stringify({ servers: { build: { sshHost: "build-host", workspace: team, oatsPath: CLI }, old: { sshHost: "old-host", workspace: team, oatsPath: oldOats } } }));
  // An old remote is refused before anything is sent.
  const before = sent();
  r = oats(["inspect", "--server", "old", "--json"]); assert.equal(r.json().error.code, "E_REMOTE_INCOMPATIBLE"); assert.match(r.json().error.message, /operations contract/);
  assert.equal(sent().split("inspect").length, before.split("inspect").length, "no inspect was sent to the old remote");
});
