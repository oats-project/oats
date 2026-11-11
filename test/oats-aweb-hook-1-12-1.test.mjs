// oats.aweb 1.12.1 default-readiness behaviour, against fake `aw` on PATH:
// explicit messaging roots, v2 remedies, work-dir aw env, and binding-check.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const HOOK = resolve(new URL("../mirrors/oats-aweb/bin/oats-aweb.mjs", import.meta.url).pathname);
const BINDING = resolve(new URL("../mirrors/oats-aweb/bin/oats-aweb-binding.mjs", import.meta.url).pathname);
// Captured aw output and its provenance live together in this fixture directory.
const AW_VERSION_OUTPUT = readFileSync(new URL("./fixtures/aw-1.36.33/aw-version.txt", import.meta.url), "utf8");

function write(p, c) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); }
function awRoot(dir) { mkdirSync(join(dir, ".aw"), { recursive: true }); }

function fakeAw(base) {
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  write(join(bin, "aw"), `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
const s = a.join(" ");
const log = ${JSON.stringify(join(base, "aw.log"))};
fs.appendFileSync(log, JSON.stringify({ argv: a, cwd: process.cwd(), identityHome: process.env.AWEB_IDENTITY_HOME || null }) + "\\n");
const j = (obj) => JSON.stringify(obj, null, 2);
if (s === "version") { process.stdout.write(${JSON.stringify(AW_VERSION_OUTPUT)}); process.exit(0); }
// A host whose wake broker runs: a start the broker delivers to is refused without one.
if (s.startsWith("wake status")) { console.log(j({ daemon_running: true, daemon_version_state: "reported", daemon_version: "1.36.58", instances: [] })); process.exit(0); }
if (s.startsWith("wake ")) process.exit(0);
if (s.startsWith("team list")) { console.log(j({ active_team: "t:example.test", memberships: [{ team_id: "t:example.test" }] })); process.exit(0); }
if (s.startsWith("team invite")) { console.log(j({ token: "TOK-secret" })); process.exit(0); }
if (s.startsWith("team join")) { console.log(j({ alias: "probe", team_id: "t:example.test" })); process.exit(0); }
if (s.startsWith("init") && a.some((x) => x.startsWith("--join-from"))) {
  // aw >= 1.36.13 \`aw init --join-from=<root> --join-team=<team> --name=<alias> --json\`: one process mints
  // from the root, accepts into the cwd and connects. It refuses an external identity home and an existing identity.
  if (process.env.AWEB_IDENTITY_HOME) { console.error("aw init --join-from refuses an external identity home"); process.exit(2); }
  for (const f of ["signing.key", "identity.yaml", "team-certs", "workspace.yaml"]) if (fs.existsSync(require("node:path").join(process.cwd(), ".aw", f))) { console.error("Error: refusing to overwrite existing .aw/" + f); process.exit(2); }
  const name = (a.find((x) => x.startsWith("--name=")) || "--name=probe").slice("--name=".length);
  console.log(j({ alias: name, team_id: (a.find((x) => x.startsWith("--join-team=")) || "--join-team=t:example.test").slice("--join-team=".length), workspace_id: "00000000-0000-4000-8000-000000000001", status: "connected" })); process.exit(0);
}
if (s.startsWith("init")) process.exit(0);
if (s.startsWith("workspace delete")) { console.log(j({ alias_released: true, alias_released_reason: "revoked" })); process.exit(0); }
console.error("fake aw: unexpected " + s); process.exit(2);
`);
  chmodSync(join(bin, "aw"), 0o755);
  return bin;
}

// oats.aweb 1.17 (team model v2): the primary team is the kernel's default-team env (OATS_DEFAULT_TEAM*,
// OATS_TEAMS rows { label, team, default, from }), never a provider `team` setting (a stale one is refused).
function defaultTeamEnv(team = "t:example.test") {
  return { OATS_DEFAULT_TEAM: "default", OATS_DEFAULT_TEAM_ID: team, OATS_DEFAULT_TEAM_FROM: "deployment", OATS_TEAMS: JSON.stringify([{ label: "default", team, default: true, from: "local" }]) };
}

function runHook(bin, event, env) {
  const r = spawnSync(process.execPath, [HOOK, event], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OATS_EVENT: event, ...env } });
  let doc; try { doc = JSON.parse(r.stdout.trim().split(/\n/).at(-1)); } catch { doc = undefined; }
  return { ...r, doc };
}

function logLines(base) {
  const text = readFileSync(join(base, "aw.log"), "utf8").trim();
  return text ? text.split(/\n/).map((l) => JSON.parse(l)) : [];
}

function bindingRequest(settings = {}) {
  return {
    schemaVersion: 1,
    phase: "check",
    slot: "messaging",
    capability: "oats.aweb",
    settings,
    input: {
      context: { kind: "standalone", key: "fixture" },
      action: { kind: "inspect" },
      binding: {
        schemaVersion: 1,
        capability: "oats.aweb",
        payloadContract: "oats.aweb.messaging",
        payloadVersion: 1,
        payload: {
          responsibleHuman: { provider: "oats.aweb", id: "pepe" },
          context: { kind: "standalone", key: "fixture" },
          privateTeam: { provider: "oats.aweb", id: "private:example.test" },
          wider: [],
        },
        credentialRefs: {},
        provenance: [],
      },
    },
  };
}

/** Readiness checks the provider's aw floor too. The binding check gets
 *  an aw that answers only `version` (and logs every call), so the check never reads the host's
 *  own aw and otherwise runs exactly as before the floor. */
function versionOnlyAw() {
  const bin = mkdtempSync(join(tmpdir(), "oats-aweb-1121-aw-"));
  write(join(bin, "aw"), `#!/usr/bin/env node
const s = process.argv.slice(2).join(" ");
require("node:fs").appendFileSync(${JSON.stringify(join(bin, "calls.log"))}, s + "\\n");
if (s === "version") { process.stdout.write(${JSON.stringify(AW_VERSION_OUTPUT)}); process.exit(0); }
console.error("version-only aw: unexpected " + s); process.exit(2);
`);
  chmodSync(join(bin, "aw"), 0o755);
  return bin;
}
function runBinding(input, env = {}) {
  const bin = versionOnlyAw();
  const r = spawnSync(process.execPath, [BINDING, "check"], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, ...env, PATH: `${bin}:${process.env.PATH}` } });
  const calls = existsSync(join(bin, "calls.log")) ? readFileSync(join(bin, "calls.log"), "utf8").split("\n").filter(Boolean) : [];
  rmSync(bin, { recursive: true, force: true });
  assert.deepEqual(calls.filter((c) => c !== "version"), [], "the binding check calls aw only for its version");
  let doc; try { doc = JSON.parse(r.stdout); } catch { doc = undefined; }
  return { ...r, doc };
}

test("spawn uses roots[team] before root/workspace and local mode exports AWEB_IDENTITY_HOME", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-1121-"));
  try {
    const bin = fakeAw(base);
    const workspace = join(base, "workspace"); awRoot(workspace);
    const declaredRoot = join(base, "declared-root"); awRoot(declaredRoot);
    const teamRoot = join(base, "team-root"); awRoot(teamRoot);
    const home = join(workspace, "agents", "dev", "instances", "probe"); mkdirSync(home, { recursive: true });
    const r = runHook(bin, "spawn", {
      OATS_INSTANCE: "probe",
      OATS_HOME: home,
      OATS_WORKSPACE: workspace,
      OATS_CONTEXT: workspace,
      OATS_SETTINGS: JSON.stringify({ root: declaredRoot, roots: { "t:example.test": teamRoot } }),
      // A Claude spawn takes the channel path (oats.aweb 1.18), so the env carries no AWEB_DELIVERY.
      OATS_RUNTIME: "claude",
      ...defaultTeamEnv(),
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.doc.env, { AWEB_IDENTITY_HOME: join(home, ".aw") });
    // 1.17.4 mints in one process from the home, naming the minting root with --join-from.
    const mint = logLines(base).find((l) => l.argv[0] === "init" && l.argv.some((x) => x.startsWith("--join-from=")));
    assert.ok(mint, "one aw init --join-from mint");
    assert.equal(realpathSync(mint.argv.find((x) => x.startsWith("--join-from=")).slice("--join-from=".length)), realpathSync(teamRoot), "roots[team] is the minting root");
    assert.equal(mint.cwd, realpathSync(home), "the mint runs in the home");
    assert.equal(logLines(base).some((l) => /^team (invite|join)/.test(l.argv.join(" "))), false, "no separate invite or join");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("declared root without .aw is fatal and names the v2 root remedy without bounded search prose", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-1121-"));
  try {
    const bin = fakeAw(base);
    const workspace = join(base, "workspace"); awRoot(workspace);
    const declaredRoot = join(base, "declared-root"); mkdirSync(declaredRoot, { recursive: true });
    const home = join(workspace, "agents", "dev", "instances", "probe"); mkdirSync(home, { recursive: true });
    const r = runHook(bin, "spawn", {
      OATS_INSTANCE: "probe",
      OATS_HOME: home,
      OATS_WORKSPACE: workspace,
      OATS_CONTEXT: workspace,
      OATS_SETTINGS: JSON.stringify({ root: declaredRoot }),
      ...defaultTeamEnv(),
    });
    assert.notEqual(r.status, 0);
    assert.match(r.doc.warning, new RegExp(`no messaging root at ${declaredRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(r.doc.warning, /settings\.oats\.aweb\.root/);
    assert.match(r.doc.warning, /oats aweb setup/);
    assert.doesNotMatch(r.doc.warning, /bounded candidates|oats-config\.yaml|team:/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("v2 spawn does not search above OATS_WORKSPACE when no root is declared", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-1121-"));
  try {
    const bin = fakeAw(base);
    awRoot(base);
    const workspace = join(base, "workspace"); mkdirSync(workspace, { recursive: true });
    const home = join(workspace, "agents", "dev", "instances", "probe"); mkdirSync(home, { recursive: true });
    const r = runHook(bin, "spawn", {
      OATS_INSTANCE: "probe",
      OATS_HOME: home,
      OATS_WORKSPACE: workspace,
      OATS_CONTEXT: workspace,
      OATS_SETTINGS: JSON.stringify({}),
      ...defaultTeamEnv(),
    });
    assert.notEqual(r.status, 0);
    assert.match(r.doc.warning, new RegExp(`no messaging root at ${workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.equal(existsSync(join(base, "aw.log")) && /team invite|--join-from/.test(readFileSync(join(base, "aw.log"), "utf8")), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// RETIRED (oats.aweb 1.14.1): "classic spawn keeps 1.12.0 bounded root precedence before OATS_WORKSPACE".
// 1.14 refuses the classic environment outright (no kernel produces it since 0.26); what stays is that the
// refusal is fatal before anything is minted.
test("a classic environment (OATS_TEAM_SCOPE without workspace facts) is refused before any aw call", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-1121-"));
  try {
    const bin = fakeAw(base);
    const teamScope = join(base, "team-scope"); awRoot(teamScope);
    const workspace = join(base, "workspace"); awRoot(workspace);
    const home = join(workspace, "agents", "dev", "instances", "probe"); mkdirSync(home, { recursive: true });
    const r = runHook(bin, "spawn", { OATS_INSTANCE: "probe", OATS_HOME: home, OATS_WORKSPACE: workspace, OATS_CONTEXT: workspace, OATS_TEAM_SCOPE: teamScope, OATS_TEAM_ID: "t:example.test", OATS_SETTINGS: JSON.stringify({}) });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.doc.warning, "oats-aweb: oats.aweb 1.14 needs OATS 0.26.0 or newer (workspace model); on an older kernel pin oats.aweb v1.13.x");
    assert.equal(existsSync(join(base, "aw.log")), false, "nothing was asked of aw, so nothing was minted");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("setup in v2 reads the settings root and the default team, and prints v2 remedies", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-1121-"));
  try {
    const bin = fakeAw(base);
    const workspace = join(base, "workspace"); mkdirSync(workspace, { recursive: true });
    let r = runHook(bin, "setup", { OATS_WORKSPACE: workspace, OATS_SETTINGS: JSON.stringify({}) });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /no teams configured: run `oats aweb setup`/);
    assert.doesNotMatch(r.stdout, /oats-config\.yaml|messaging\.byTeam|team:/);
    const root = join(base, "declared-root"); mkdirSync(root, { recursive: true });
    r = runHook(bin, "setup", { OATS_WORKSPACE: workspace, OATS_SETTINGS: JSON.stringify({ root }), ...defaultTeamEnv() });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /oats aweb setup --username <u>/);
    assert.match(r.stdout, /AWEB_API_KEY=<key> oats aweb setup/);
    assert.match(r.stdout, /oats aweb setup --join <label> --invite <token>/);
    assert.match(r.stdout, /settings\.oats\.aweb\.root/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("binding-check reports one v2 problem per missing root/team and ready once both exist", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-1121-"));
  try {
    const workspace = join(base, "workspace"); mkdirSync(workspace, { recursive: true });
    let r = runBinding(bindingRequest({ delivery: "session" }), { OATS_WORKSPACE: workspace });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.doc.ok, true);
    assert.equal(r.doc.result.status, "needs-configuration");
    assert.deepEqual(r.doc.result.problems.map((p) => p.message), [
      "no teams configured: run `oats aweb setup`",
      `no messaging root at ${workspace}: run oats aweb setup there or set settings.oats.aweb.root`,
    ]);
    awRoot(workspace);
    r = runBinding(bindingRequest({ delivery: "session" }), { OATS_WORKSPACE: workspace, ...defaultTeamEnv() });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.doc.result, { status: "ready", problems: [] });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// RETIRED (oats.aweb 1.14.1): "binding-check accepts classic team from environment without settings.team".
// 1.14 reads no team from OATS_TEAM_ID (lead decision K): the team is settings.oats.aweb.team or the root's
// active team, covered above and below.

// RETIRED (oats.aweb 1.17): "an unmapped v2 team label uses the workspace's default team (the root's active team)
// with a team-unmapped warning; with none, the check reports no team". 1.17 takes the primary team only from the
// kernel's OATS_DEFAULT_TEAM_ID: an unmapped default is refused, never replaced by the root's active team. Floor below.
test("an unmapped default team is refused by binding-check and spawn, never replaced by the root's active team", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-1121-"));
  try {
    const bin = fakeAw(base);
    const workspace = join(base, "workspace"); awRoot(workspace);
    // The root keeps an active team: 1.16 fell back to it; 1.17 must not.
    write(join(workspace, ".aw", "teams.yaml"), "active_team: t:example.test\n");
    const home = join(workspace, "agents", "dev", "instances", "probe"); mkdirSync(home, { recursive: true });
    // What the kernel's teamsEnv exports when the default label has no provider id: the label, no id, mapped rows only.
    const env = { OATS_WORKSPACE: workspace, OATS_WORKSPACE_KEY: "fixture-workspace", OATS_WORKSPACE_NAME: "Fixture Workspace", OATS_DEFAULT_TEAM: "engineering", OATS_DEFAULT_TEAM_FROM: "deployment", OATS_TEAMS: "[]", OATS_TEAMS_SOURCE: "live" };
    // oats.aweb 1.19.0 (team model 3) also names the workspace's defaultTeam, for workspaces that don't allow local teams.
    const unmapped = "the default team engineering has no provider id yet: its owner runs oats aweb setup, then commits the id, or choose another default: `oats teams default <label>`, or `defaultTeam:` in oats-workspace.yaml when the workspace doesn't allow local teams";
    const check = runBinding(bindingRequest({ delivery: "session" }), env);
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.deepEqual(check.doc.result, { status: "needs-configuration", problems: [{ code: "needs-configuration", message: unmapped }] });
    const spawn = runHook(bin, "spawn", { ...env, OATS_INSTANCE: "probe", OATS_HOME: home, OATS_CONTEXT: workspace, OATS_SETTINGS: JSON.stringify({}) });
    assert.notEqual(spawn.status, 0, spawn.stdout + spawn.stderr);
    assert.equal(spawn.doc.warning, `oats-aweb: ${unmapped}`);
    assert.equal(logLines(base).some((l) => /^team (list|invite|join)\b/.test(l.argv.join(" "))), false, "nothing was minted and the root's active team was never consulted");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// oats.aweb 1.17 removed the provider `team` setting (settings.oats.aweb.team, the pre-0.30 team selector).
test("a stale settings.oats.aweb.team is refused by spawn (before any aw call) and by binding-check", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-1121-"));
  try {
    const bin = fakeAw(base);
    const workspace = join(base, "workspace"); awRoot(workspace);
    const home = join(workspace, "agents", "dev", "instances", "probe"); mkdirSync(home, { recursive: true });
    const refusal = "teams are not a setting since oats.aweb 1.17 / OATS 0.30: use oats teams / oats soul teams";
    const spawn = runHook(bin, "spawn", { OATS_INSTANCE: "probe", OATS_HOME: home, OATS_WORKSPACE: workspace, OATS_CONTEXT: workspace, OATS_SETTINGS: JSON.stringify({ team: "t:example.test" }), ...defaultTeamEnv() });
    assert.notEqual(spawn.status, 0, spawn.stdout + spawn.stderr);
    assert.equal(spawn.doc.warning, `oats-aweb: ${refusal}`);
    assert.equal(existsSync(join(base, "aw.log")), false, "refused before any aw call, so nothing was minted");
    const check = runBinding(bindingRequest({ delivery: "session", team: "t:example.test" }), { OATS_WORKSPACE: workspace, ...defaultTeamEnv() });
    assert.equal(check.doc.ok, false, check.stdout + check.stderr);
    assert.equal(check.doc.error.code, "needs-configuration");
    assert.equal(check.doc.error.message, refusal);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// oats.aweb 1.17 removed `oats aweb setup --invite <token>` joining at the single messaging root. From oats.aweb
// 1.36.0 (#56) an invite without --join is setup from the invite alone, into a per-team root of a deployment: with
// no deployment here (no oats-local.yaml) it is refused before any aw call, and still spends no invite.
test("setup --invite without --join and without a deployment is refused and spends no invite", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-1121-"));
  try {
    const bin = fakeAw(base);
    const workspace = join(base, "workspace"); awRoot(workspace);
    const refused = spawnSync(process.execPath, [HOOK, "setup", "--invite", "TOK-secret"], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OATS_EVENT: "setup", OATS_WORKSPACE: workspace, OATS_SETTINGS: "{}", ...defaultTeamEnv() } });
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /E_SETUP_DEPLOYMENT: selected deployment is missing, unreadable or inconsistent/);
    assert.equal(existsSync(join(base, "aw.log")) && logLines(base).some((l) => /^(team join|id team accept-invite)/.test(l.argv.join(" "))), false, "no invite was spent");
    assert.equal((refused.stdout + refused.stderr).includes("TOK-secret"), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
