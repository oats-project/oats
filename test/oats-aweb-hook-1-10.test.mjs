// oats.aweb 1.10.0 hook behaviour, against a fake `aw` on PATH: session
// delivery output, the honest retire report, and the retired-alias remedy.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const HOOK = resolve(new URL("../mirrors/oats-aweb/bin/oats-aweb.mjs", import.meta.url).pathname);
const BINDING = resolve(new URL("../mirrors/oats-aweb/bin/oats-aweb-binding.mjs", import.meta.url).pathname);

// Native version/ops come from verbatim captures; see fixtures/aw-1.36.33/SOURCE.md.
// FAKE_* overrides are synthetic fault injection, not captured native errors.
const AW_VERSION = readFileSync(new URL("./fixtures/aw-1.36.33/aw-version.txt", import.meta.url), "utf8");
const CUSTODY_OPS = JSON.parse(readFileSync(new URL("./fixtures/aw-1.36.33/custody-status-running.stdout", import.meta.url), "utf8")).ops;

function write(p, c) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); }

/** A fake aw: team list/invite/join, init --join-from (the 1.17.4 mint) and
 *  workspace delete answer as the real one does, from a script the test
 *  controls (JOIN_MODE selects the mint answer). */
function fakeAw(base, joinMode = "ok") {
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  write(join(bin, "aw"), `#!/usr/bin/env node
const args = process.argv.slice(2);
const a = args.join(" ");
const fs = require("node:fs"); const p = require("node:path");
const log = ${JSON.stringify(join(base, "aw.log"))};
const { createGrantModel, serializeGrant } = require(${JSON.stringify(resolve(new URL("./helpers/fake-aw-grants.cjs", import.meta.url).pathname))});
const grants = createGrantModel(${JSON.stringify(base)});
const val = (flag) => { const eq = args.find((x) => x.startsWith(flag + "=")); if (eq) return eq.slice(flag.length + 1); const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
fs.appendFileSync(log, a + " @" + process.cwd() + "\\n");
if (a.startsWith("wake ")) { if (process.env.FAKE_WAKE_REGISTER_FAIL && a.startsWith("wake register")) { console.error("aw wake register: the broker refused the registration"); process.exit(5); } if (a.startsWith("wake status")) console.log(JSON.stringify({ daemon_running: true, daemon_version_state: "reported", daemon_version: "1.36.58", instances: [] })); process.exit(0); }
if (a.startsWith("team list")) { console.log(JSON.stringify({ active_team: "t:example.test", memberships: [{ team_id: "t:example.test" }] })); process.exit(0); }
if (a.startsWith("team invite")) { console.log(JSON.stringify({ token: "TOK-secret" })); process.exit(0); }
if (a.startsWith("team join")) {
  if (${JSON.stringify(joinMode)} === "conflict") { console.error("aweb: http 422: alias already holds an active certificate for this team"); process.exit(1); }
  if (process.env.FAKE_JOIN_LATE) {
    // The join completes server-side (and binds the home) but the CLI hangs past the hook's timeout.
    const aw = p.join(process.cwd(), ".aw");
    fs.mkdirSync(p.join(aw, "team-certs"), { recursive: true }); fs.writeFileSync(p.join(aw, "signing.key"), "k"); fs.writeFileSync(p.join(aw, "workspace.yaml"), "memberships:\\n    - team_id: t:example.test\\n      alias: probe\\n");
    require("node:child_process").execFileSync("sleep", ["3"]); process.exit(0);
  }
  console.log(JSON.stringify({ alias: "probe", team_id: "t:example.test" })); process.exit(0);
}
if (a.startsWith("init --join-from") || (a.startsWith("init ") && args.some((x) => x.startsWith("--join-from")))) {
  // aw >= 1.36.13 \`aw init --join-from=<root> --join-team=<team> --name=<alias> --json\`:
  // mints an invite from the root, accepts it into the cwd and connects it, in one process.
  const aw = p.join(process.cwd(), ".aw");
  for (const f of ["signing.key", "identity.yaml", "team-certs", "workspace.yaml"]) if (fs.existsSync(p.join(aw, f))) { console.error("Error: refusing to overwrite existing " + p.join(aw, f)); process.exit(2); }
  if (${JSON.stringify(joinMode)} === "conflict") { console.error("aweb: http 422: alias already holds an active certificate for this team (invite TOK-secret)"); process.exit(1); }
  const bind = () => { fs.mkdirSync(p.join(aw, "team-certs"), { recursive: true }); fs.writeFileSync(p.join(aw, "signing.key"), "k"); fs.writeFileSync(p.join(aw, "workspace.yaml"), "memberships:\\n    - team_id: t:example.test\\n      alias: " + (val("--name") || "probe") + "\\n      workspace_id: 00000000-0000-4000-8000-000000000001\\n"); };
  if (process.env.FAKE_JOIN_LATE) {
    // The mint completes server-side (and binds the home) but the CLI hangs past the hook's timeout.
    bind(); require("node:child_process").execFileSync("sleep", ["3"]); process.exit(0);
  }
  // Success answers without writing the home, as the team-join fake did: tests here reuse one home across spawns.
  console.log(JSON.stringify({ alias: val("--name") || "probe", team_id: "t:example.test", workspace_id: "00000000-0000-4000-8000-000000000001", status: "connected" })); process.exit(0);
}
if (a.startsWith("init")) process.exit(0);
if (a === "version") { process.stdout.write(process.env.FAKE_AW_VERSION || ${JSON.stringify(AW_VERSION)}); process.exit(0); }
if (a.startsWith("custody status")) {
  if (process.env.AWEB_IDENTITY_HOME) {
    let text = ""; try { text = fs.readFileSync(p.join(process.env.AWEB_IDENTITY_HOME, "grant.yaml"), "utf8"); } catch {}
    const line = text.split("\\n").find((l) => l.trim().startsWith("socket_path:"));
    if (!line) { console.error("grant home has no custody.socket_path locator"); process.exit(1); }
    const socket = line.split("socket_path:")[1].trim();
    console.log(JSON.stringify({ status: "running", socket_path: socket, service_id: "svc", resident: { alias: "merlin", address: "cjr.aweb.ai/merlin", did_aw: "did:aw:WJ5Q2fnu" }, teams: [{ team_id: "t:example.test", ready: true, certificate_present: true }], keys: { signing_ready: true, encryption_ready: true }, ops: ${JSON.stringify(CUSTODY_OPS)} })); process.exit(0);
  }
  console.log(JSON.stringify({ status: "running", socket_path: process.env.FAKE_SOCKET || p.join(process.env.FAKE_BASE || process.cwd(), "custody.sock"), teams: [{ team_id: "t:example.test", ready: true, certificate_present: true, grant_status_endpoint_ready: true }], keys: { signing_ready: true, encryption_ready: true }, ops: ${JSON.stringify(CUSTODY_OPS)} })); process.exit(0);
}
if (a.startsWith("id grant mint")) {
  if (process.env.AWEB_IDENTITY_HOME) { console.error("grant mint refuses AWEB_IDENTITY_HOME"); process.exit(2); }
  const out = val("--out"); const socket = val("--custody-socket");
  if (!socket) { console.error("missing --custody-socket"); process.exit(2); }
  fs.mkdirSync(out, { recursive: true });
  const written = process.env.FAKE_GRANT_SOCKET === "missing" ? null : (process.env.FAKE_GRANT_SOCKET || socket);
  const {reply, document} = grants.mint({ id: "grant-new", team: val("--team") || "t:example.test", ttl: val("--ttl"), scopes: val("--scope").split(","), label: val("--label"), out, socket, alias: "merlin", address: "cjr.aweb.ai/merlin", expiresAt: "2026-09-25T00:00:00Z" });
  if (written) document.custody.socket_path = written; else delete document.custody;
  fs.writeFileSync(p.join(out, "grant.yaml"), serializeGrant(document));
  console.log(JSON.stringify(reply)); process.exit(0);
}
if (a.startsWith("id grant list")) { console.log(JSON.stringify(grants.list(val("--team")))); process.exit(0); }
if (a.startsWith("id grant revoke")) { console.log(JSON.stringify(grants.revoke(args[3]))); process.exit(0); }
if (a.startsWith("id grant show")) { console.log(JSON.stringify({ grant_id: args[3], status: "revoked" })); process.exit(0); }
if (a.startsWith("workspace delete")) { if (a.endsWith("--json")) console.log(JSON.stringify({ alias: "probe", alias_released: process.env.FAKE_ALIAS_RELEASED !== "false", alias_released_reason: process.env.FAKE_ALIAS_RELEASED === "false" ? "no_workspace_credential" : "revoked" })); process.exit(0); }
if (a.startsWith("workspace connect")) process.exit(0);
if (a.startsWith("check --online")) process.exit(0);
if (a.startsWith("heartbeat")) process.exit(0);
if (a.startsWith("whoami")) { const m = process.env.FAKE_WHOAMI || "ok"; console.log(JSON.stringify(m === "ok" ? { did: "did:aw:WJ5Q2fnu", stable_id: "s", address: "cjr.aweb.ai/merlin" } : { did: "did:aw:OTHER", stable_id: "x", address: "cjr.aweb.ai/merlin" })); process.exit(0); }
if (a.startsWith("workspace status")) { const mode = process.env.FAKE_STATUS || "ok"; console.log(JSON.stringify({ selected_team: "t:example.test", workspace: mode === "ok" ? { alias: "merlin", workspace_path: process.cwd(), hostname: "Mac.lan" } : { alias: "merlin", workspace_path: "/somewhere/else", hostname: "other" } })); process.exit(0); }
console.error("fake aw: unexpected " + a); process.exit(2);
`);
  chmodSync(join(bin, "aw"), 0o755);
  return bin;
}

function deployment(base) {
  const root = join(base, "root"); mkdirSync(join(root, ".aw"), { recursive: true });
  write(join(root, ".aw", "workspace.yaml"), "aweb_url: https://example.test\n");
  const home = join(root, "agents", "dev", "instances", "probe"); mkdirSync(home, { recursive: true });
  return { root, home };
}

// oats.aweb 1.17 (team model v2): the primary team is the kernel's default-team env (OATS_DEFAULT_TEAM*,
// OATS_TEAMS rows { label, team, default, from }), never a provider `team` setting or OATS_TEAM_ID.
function defaultTeamEnv(team = "t:example.test") {
  return { OATS_DEFAULT_TEAM: "default", OATS_DEFAULT_TEAM_ID: team, OATS_DEFAULT_TEAM_FROM: "deployment", OATS_TEAMS: JSON.stringify([{ label: "default", team, default: true, from: "local" }]) };
}

function runHook(base, bin, event, env) {
  const r = spawnSync(process.execPath, [HOOK, event], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_BASE: base, OATS_EVENT: event, ...defaultTeamEnv(), ...env } });
  let doc; try { doc = JSON.parse(r.stdout.trim()); } catch { doc = undefined; }
  return { ...r, doc };
}

function resident(base) {
  const custody = join(base, "resident");
  write(join(custody, ".aw", "identity.yaml"), "did: did:aw:WJ5Q2fnu\n");
  return custody;
}

const globalSettings = (custody, extra = {}) => JSON.stringify({ identity: { mode: "global", resident: "merlin", ...extra.identity }, residents: { merlin: custody }, ...extra });

function runBindingCheck(bin, settings, context, env = {}) {
  const input = { schemaVersion: 1, phase: "check", slot: "messaging", capability: "oats.aweb", settings: JSON.parse(settings), input: { action: { kind: "readiness" }, context } };
  const r = spawnSync(process.execPath, [BINDING, "check"], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...defaultTeamEnv(), ...env } });
  let doc; try { doc = JSON.parse(r.stdout); } catch { doc = undefined; }
  return { ...r, doc };
}

test("global grant spawn attaches the preflight custody socket, verifies grant.yaml and verifies custody status through the grant home", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-grant-"));
  try {
    const bin = fakeAw(base); const { root, home } = deployment(base); const custody = resident(base); const socket = join(base, "custody.sock");
    const r = runHook(base, bin, "spawn", { OATS_INSTANCE: "probe", OATS_HOME: home, OATS_WORKSPACE: root, OATS_CONTEXT: root, OATS_RUNTIME: "pi", OATS_SETTINGS: globalSettings(custody), FAKE_SOCKET: socket });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.doc.env.AWEB_IDENTITY_HOME, join(home, ".aweb-identity"));
    const grantYaml = readFileSync(join(home, ".aweb-identity", "grant.yaml"), "utf8");
    assert.match(grantYaml, new RegExp(`socket_path: ${socket.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}`));
    const log = readFileSync(join(base, "aw.log"), "utf8");
    assert.match(log, new RegExp(`id grant mint --team=t:example.test .* --custody-socket=${socket.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}`));
    assert.match(log, /^custody status --json @.*\.aweb-identity$/m, "post-mint custody status runs from the grant home");
    assert.match(r.doc.brief, /grant home is attached to the resident's custody service/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// RETIRED (oats.aweb 1.16.1): "global grant spawn refuses below the custody attach floor before minting".
// 1.16.1 has one aw floor (>= 1.36.13) and no per-feature floors; the floor refusal before any mint is
// covered once, in oats-aweb-hook-1-13.test.mjs ("single aw floor refuses older aw before grant mint").

test("global grant spawn revokes and removes the home when grant.yaml custody socket mismatches", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-grant-"));
  try {
    const bin = fakeAw(base); const { root, home } = deployment(base); const custody = resident(base);
    const r = runHook(base, bin, "spawn", { OATS_INSTANCE: "probe", OATS_HOME: home, OATS_WORKSPACE: root, OATS_CONTEXT: root, OATS_RUNTIME: "pi", OATS_SETTINGS: globalSettings(custody), FAKE_SOCKET: join(base, "custody.sock"), FAKE_GRANT_SOCKET: join(base, "other.sock") });
    assert.notEqual(r.status, 0);
    assert.match(r.doc.warning, /grant.yaml custody.socket_path .* differs/);
    assert.match(readFileSync(join(base, "aw.log"), "utf8"), /id grant revoke grant-new --json/);
    assert.equal(existsSync(join(home, ".aweb-identity")), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("global grant renewal attaches and verifies custody before replacing launch meta", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-grant-"));
  try {
    const bin = fakeAw(base); const { root, home } = deployment(base); const custody = resident(base); const old = join(home, ".aweb-identity");
    write(join(old, "grant.yaml"), "grant_id: old\nteam_id: t:example.test\nexpires_at: old\ncustody:\n  socket_path: old.sock\n");
    const meta = { delivery: "channel", identity: { mode: "global", alias: "merlin", team: "t:example.test", address: "cjr.aweb.ai/merlin", resident: "merlin", grant: { id: "old", expiresAt: "old", scopes: ["mail.read"], home: old } } };
    const r = runHook(base, bin, "launch", { OATS_INSTANCE: "probe", OATS_HOME: home, OATS_WORKSPACE: root, OATS_CONTEXT: root, OATS_RUNTIME: "pi", OATS_META: JSON.stringify(meta), OATS_SETTINGS: globalSettings(custody, { identity: { renew: "launch" } }), FAKE_SOCKET: join(base, "custody.sock") });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.doc.meta.identity.grant.id, "grant-new");
    assert.notEqual(r.doc.meta.identity.grant.home, old);
    assert.match(readFileSync(join(r.doc.meta.identity.grant.home, "grant.yaml"), "utf8"), /custody:\n    socket_path: /);
    assert.match(readFileSync(join(base, "aw.log"), "utf8"), /id grant revoke old --json/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("readiness reports existing grant homes without custody.socket_path as not ready", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-grant-"));
  try {
    const bin = fakeAw(base); const { root, home } = deployment(base); const custody = resident(base);
    write(join(home, ".aweb-identity", "grant.yaml"), "grant_id: old\nteam_id: t:example.test\nexpires_at: old\n");
    write(join(home, "instance.json"), JSON.stringify({ capabilityMeta: { "oats.aweb": { identity: { mode: "global", grant: { id: "old", home: join(home, ".aweb-identity") } } } } }));
    const ctx = { kind: "workspace", workspace: root, deployment: root, soul: "dev", home };
    const missing = runBindingCheck(bin, globalSettings(custody), ctx);
    assert.equal(missing.status, 0, missing.stderr);
    assert.equal(missing.doc.result.status, "needs-configuration");
    assert.deepEqual(missing.doc.result.problems.find((p) => p.code === "custody")?.message, "grant old is not attached to custody; retire and respawn on aw >= 1.36.33");
    write(join(home, ".aweb-identity", "grant.yaml"), "grant_id: old\nteam_id: t:example.test\nexpires_at: old\ncustody:\n  socket_path: attached.sock\n");
    const attached = runBindingCheck(bin, globalSettings(custody), ctx);
    assert.equal(attached.doc.result.status, "ready");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("real aw fixture: unattached grant home reports the released custody locator error", (t) => {
  const fixture = process.env.AW_REAL_GRANT_FIXTURE;
  const realAw = process.env.AW_REAL_CLI_BIN || "aw";
  if (!fixture) return t.skip("AW_REAL_GRANT_FIXTURE not set; skipping real aw grant-home regression");
  const version = spawnSync(realAw, ["version"], { encoding: "utf8", timeout: 10000 });
  const parsed = /aw\s+v?(\d+)\.(\d+)\.(\d+)/.exec(version.stdout + version.stderr);
  const atLeast = parsed && parsed.slice(1, 4).map(Number).reduce((ok, part, i, arr) => ok || (arr.slice(0, i).every((n, j) => n === [1, 36, 33][j]) && part > [1, 36, 33][i]), parsed.slice(1, 4).map(Number).every((n, i) => n === [1, 36, 33][i]));
  if (version.status !== 0 || !atLeast) return t.skip(`real aw is not 1.36.33+: ${version.stdout || version.stderr}`);
  const r = spawnSync(realAw, ["custody", "status", "--json"], { cwd: fixture, encoding: "utf8", env: { ...process.env, AWEB_IDENTITY_HOME: fixture } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /grant home has no custody\.socket_path locator/);
});

test("spawn with delivery=session: AWEB_DELIVERY in the launch env, no Claude channel flag, and a brief that says nothing wakes the instance", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-110-"));
  try {
    const bin = fakeAw(base); const { root, home } = deployment(base);
    const env = { OATS_INSTANCE: "probe", OATS_HOME: home, OATS_WORKSPACE: root, OATS_CONTEXT: root, OATS_RUNTIME: "claude" };
    const channel = runHook(base, bin, "spawn", { ...env, OATS_SETTINGS: JSON.stringify({}) });
    assert.equal(channel.status, 0, channel.stdout + channel.stderr);
    assert.equal(channel.doc.meta.delivery, "channel");
    assert.match(channel.doc.launch?.claude || "", /aweb-channel@awebai-marketplace/);
    assert.deepEqual(channel.doc.env, { AWEB_IDENTITY_HOME: join(home, ".aw") });
    const session = runHook(base, bin, "spawn", { ...env, OATS_SETTINGS: JSON.stringify({ delivery: "session" }) });
    assert.equal(session.status, 0, session.stdout + session.stderr);
    assert.equal(session.doc.meta.delivery, "session");
    assert.deepEqual(session.doc.env, { AWEB_DELIVERY: "session", AWEB_IDENTITY_HOME: join(home, ".aw") });
    assert.equal(session.doc.launch, undefined, "no channel flag in session mode");
    assert.match(session.doc.brief, /Notification delivery: external \(AWEB_DELIVERY=session\)/);
    assert.match(readFileSync(join(base, "aw.log"), "utf8"), new RegExp(`^wake register --home ${home.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")} --identity-home .*/.aw --delivery session`, "m"), "registered with the broker");
    // When the registration with the broker fails, session mode refuses instead of going silently poll-only.
    mkdirSync(join(root, "agents", "dev", "instances", "probe-nw"), { recursive: true });
    const registerFails = runHook(base, bin, "spawn", { ...env, OATS_INSTANCE: "probe-nw", OATS_HOME: join(root, "agents", "dev", "instances", "probe-nw"), OATS_SETTINGS: JSON.stringify({ delivery: "session" }), FAKE_WAKE_REGISTER_FAIL: "1" });
    assert.notEqual(registerFails.status, 0);
    assert.match(registerFails.stdout, /needs an aw with the wake broker CLI/);
    // Retire in session mode deregisters.
    mkdirSync(join(home, ".aw"), { recursive: true });
    const ret = runHook(base, bin, "retire", { OATS_INSTANCE: "probe", OATS_HOME: home, OATS_META: JSON.stringify(session.doc.meta) });
    assert.equal(ret.status, 0, ret.stdout);
    assert.match(readFileSync(join(base, "aw.log"), "utf8"), /^wake deregister --home /m);
    // An unknown value behaves as channel, never as session.
    const odd = runHook(base, bin, "spawn", { ...env, OATS_SETTINGS: JSON.stringify({ delivery: "broker" }) });
    assert.equal(odd.doc.meta.delivery, "channel");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("oats.aweb 1.18: under delivery=channel each start takes the path of its runtime (Codex the broker, Claude its channel) and records it", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-110-"));
  try {
    const bin = fakeAw(base); const { root, home } = deployment(base);
    mkdirSync(join(home, ".aw"), { recursive: true });
    const meta = { alias: "probe", team: "t:example.test", delivery: "channel" };
    const env = { OATS_INSTANCE: "probe", OATS_HOME: home, OATS_WORKSPACE: root, OATS_CONTEXT: root, OATS_SETTINGS: JSON.stringify({}), OATS_META: JSON.stringify(meta), ...defaultTeamEnv() };
    const codex = runHook(base, bin, "launch", { ...env, OATS_RUNTIME: "codex" });
    assert.equal(codex.status, 0, codex.stdout + codex.stderr);
    assert.equal(codex.doc.env.AWEB_DELIVERY, "session");
    assert.deepEqual({ delivery: codex.doc.meta.delivery, runtime: codex.doc.meta.runtime }, { delivery: "channel", runtime: "codex" });
    assert.match(readFileSync(join(base, "aw.log"), "utf8"), /^wake register --home .* --delivery session/m, "a Codex start registers the home with the broker");
    rmSync(join(base, "aw.log"));
    const claude = runHook(base, bin, "launch", { ...env, OATS_RUNTIME: "claude", OATS_META: JSON.stringify(codex.doc.meta) });
    assert.equal(claude.status, 0, claude.stdout + claude.stderr);
    assert.equal(claude.doc.env?.AWEB_DELIVERY, undefined);
    assert.deepEqual({ delivery: claude.doc.meta.delivery, runtime: claude.doc.meta.runtime }, { delivery: "channel", runtime: "claude" });
    const log = readFileSync(join(base, "aw.log"), "utf8");
    assert.match(log, /^wake deregister --home /m, "a Claude start takes the home off the broker");
    assert.match(log, /^wake status --json/m, "and proves the broker no longer lists it");
    assert.doesNotMatch(log, /^wake register /m);
    // 1.18.1: under the kernel's preview flag a start changes nothing: no aw call and no meta, the real run's env.
    rmSync(join(base, "aw.log"));
    for (const [runtime, real] of [["codex", codex], ["claude", claude]]) {
      const preview = runHook(base, bin, "launch", { ...env, OATS_RUNTIME: runtime, OATS_LAUNCH_PREVIEW: "1" });
      assert.equal(preview.status, 0, preview.stdout + preview.stderr);
      assert.deepEqual(preview.doc.env, real.doc.env, `${runtime}: the preview answers the real run's env`);
      assert.equal(preview.doc.meta, undefined, `${runtime}: a preview records nothing`);
    }
    assert.equal(existsSync(join(base, "aw.log")), false, "a preview makes no aw call");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// RETIRED (oats.aweb 1.16.1): "retire: workspace deleted is reported as retired with aliasReusable false and a
// warning naming aweb-abim". That was the pre-abim retire (aw below 1.36.1, no --json), a branch 1.16.1 removed;
// retire on a supported aw is covered by "retire: aliasReusable follows aw workspace delete --json" below.

test("spawn: a join killed on timeout that completed server-side is reported as minted, so compensation retires it", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-110-"));
  try {
    const bin = fakeAw(base); const { root, home } = deployment(base);
    const r = runHook(base, bin, "spawn", { OATS_INSTANCE: "probe", OATS_HOME: home, OATS_WORKSPACE: root, OATS_CONTEXT: root, OATS_RUNTIME: "pi", OATS_SETTINGS: "{}", FAKE_JOIN_LATE: "1", OATS_AWEB_JOIN_TIMEOUT_MS: "500" });
    assert.notEqual(r.status, 0, "the spawn hook fails (no briefing without a confirmed join)");
    assert.deepEqual(r.doc.meta, { team: "t:example.test", alias: "probe" }, "the late-bound identity is reported for compensation");
    assert.match(r.doc.warning, /reported failed .*bound identity "probe".*retired, not orphaned/);
    assert.equal(r.stdout.includes("TOK-secret"), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("retire: with no alias in its meta the hook reads the home's workspace binding instead of leaving the workspace orphaned", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-110-"));
  try {
    const bin = fakeAw(base); const { home } = deployment(base);
    mkdirSync(join(home, ".aw"), { recursive: true });
    writeFileSync(join(home, ".aw", "workspace.yaml"), "memberships:\n    - team_id: t:example.test\n      alias: probe\n");
    const r = runHook(base, bin, "retire", { OATS_INSTANCE: "probe", OATS_HOME: home, OATS_META: JSON.stringify({ team: "t:example.test" }) });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.doc.meta.retired, true);
    assert.match(readFileSync(join(base, "aw.log"), "utf8"), /workspace delete probe/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("retire: aliasReusable follows aw workspace delete --json (released, or not with the reason)", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-110-"));
  try {
    const bin = fakeAw(base); const { home } = deployment(base);
    mkdirSync(join(home, ".aw"), { recursive: true });
    const meta = { alias: "probe", team: "t:example.test" };
    let r = runHook(base, bin, "retire", { OATS_INSTANCE: "probe", OATS_HOME: home, OATS_META: JSON.stringify(meta), FAKE_AW_VERSION: AW_VERSION });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.doc.meta, { retired: true, aliasReusable: true, aliasReason: "revoked", joinedTeams: [] });
    assert.equal(r.doc.warning, undefined, "a released alias needs no warning");
    assert.match(readFileSync(join(base, "aw.log"), "utf8"), /workspace delete probe --json/);
    // oats.aweb 1.17.7: a completed retire is recorded and a repeat answers from the record without calling aw.
    r = runHook(base, bin, "retire", { OATS_INSTANCE: "probe", OATS_HOME: home, OATS_META: JSON.stringify(meta), FAKE_AW_VERSION: AW_VERSION, FAKE_ALIAS_RELEASED: "false" });
    assert.deepEqual(r.doc.meta, { retired: true, aliasReusable: true, aliasReason: "revoked", joinedTeams: [] });
    assert.equal(readFileSync(join(base, "aw.log"), "utf8").split("workspace delete probe --json").length - 1, 1);
    rmSync(join(home, ".oats-aweb", "default-retire.json"));
    r = runHook(base, bin, "retire", { OATS_INSTANCE: "probe", OATS_HOME: home, OATS_META: JSON.stringify(meta), FAKE_AW_VERSION: AW_VERSION, FAKE_ALIAS_RELEASED: "false" });
    assert.deepEqual(r.doc.meta, { retired: true, aliasReusable: false, aliasReason: "no_workspace_credential", joinedTeams: [] });
    assert.match(r.doc.warning, /not released \(no_workspace_credential\); spawn successors with a different --name or --purpose until it is released$/);
    // RETIRED (oats.aweb 1.16.1): the aw 1.36.0 pre-abim retire without --json (a removed older-aw branch).
    assert.equal(readFileSync(join(base, "aw.log"), "utf8").split("workspace delete probe --json").length - 1, 2);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("spawn: a join refused because the alias still holds a certificate is fatal with the retired-alias explanation and the --name remedy", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-110-"));
  try {
    const bin = fakeAw(base, "conflict"); const { root, home } = deployment(base);
    const r = runHook(base, bin, "spawn", { OATS_INSTANCE: "probe", OATS_HOME: home, OATS_WORKSPACE: root, OATS_CONTEXT: root, OATS_RUNTIME: "pi", OATS_SETTINGS: "{}" });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /alias \\"probe\\" already holds a certificate on this team, so no identity could be minted: another machine's instance has that name, or a retired one still holds it; spawn with a different --name\. Team: t:example\.test/);
    assert.equal(r.stdout.includes("TOK-secret"), false, "the invite token never reaches the log");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("spawn: local aliases accept 64 characters and reject 65 before aw is called", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-110-"));
  try {
    const bin = fakeAw(base); const { root, home } = deployment(base);
    const alias64 = `a${"b".repeat(63)}`;
    const ok = runHook(base, bin, "spawn", { OATS_INSTANCE: alias64, OATS_HOME: home, OATS_WORKSPACE: root, OATS_CONTEXT: root, OATS_RUNTIME: "pi", OATS_SETTINGS: "{}" });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(readFileSync(join(base, "aw.log"), "utf8"), new RegExp(`^init --join-from=\\S+ --join-team=t:example\\.test --name=${alias64} --json --do-not-touch-agents-md `, "m"));
    assert.doesNotMatch(readFileSync(join(base, "aw.log"), "utf8"), /team invite|team join|TOK-secret/, "one mint; no invite token in any argv");
    const before = readFileSync(join(base, "aw.log"), "utf8");
    const alias65 = `a${"b".repeat(64)}`;
    const badHome = join(root, "agents", "dev", "instances", "too-long"); mkdirSync(badHome, { recursive: true });
    const bad = runHook(base, bin, "spawn", { OATS_INSTANCE: alias65, OATS_HOME: badHome, OATS_WORKSPACE: root, OATS_CONTEXT: root, OATS_RUNTIME: "pi", OATS_SETTINGS: "{}" });
    assert.notEqual(bad.status, 0);
    assert.match(bad.doc.warning, /invalid alias/i);
    assert.equal(readFileSync(join(base, "aw.log"), "utf8"), before, "invalid alias is rejected before any aw call");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

function legacySeat(base) {
  const legacy = join(base, "legacy-home"); const src = join(legacy, ".aw");
  write(join(src, "signing.key"), "PRIVATE-KEY-BYTES\n");
  write(join(src, "identity.yaml"), "did: did:aw:WJ5Q2fnu\naddress: cjr.aweb.ai/merlin\ncustody: self\n");
  write(join(src, "teams.yaml"), "active_team: t:example.test\nmemberships:\n  - team_id: t:example.test\n");
  write(join(src, "team-certs", "t-example.test.pem"), "CERT\n");
  write(join(src, "encryption.yaml"), "assertion: x\n");
  write(join(src, "encryption-keys", "x25519.key"), "ENC-KEY\n");
  write(join(src, "workspace.yaml"), "aweb_url: https://app.example.test\napi_key: SECRET-API-KEY\nrole_name: coordinator\nworkspace_path: /legacy\n");
  write(join(src, "context"), "cache\n");
  write(join(src, "interaction-log.jsonl"), "{}\n");
  return { legacy, src };
}

test("retained identity: authority files copied exactly, coordination reconnected, lock beside the source, brief names the seat; never workspace.yaml or caches", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-110-"));
  try {
    const bin = fakeAw(base); const { root, home } = deployment(base); const { src } = legacySeat(base);
    const env = { OATS_INSTANCE: "merlin-seat", OATS_HOME: home, OATS_WORKSPACE: root, OATS_CONTEXT: root, OATS_RUNTIME: "claude", OATS_SETTINGS: JSON.stringify({ identity: { source: src } }) };
    const r = runHook(base, bin, "spawn", env);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.doc.meta.retained, true); assert.equal(r.doc.meta.alias, "merlin"); assert.equal(r.doc.meta.team, "t:example.test");
    assert.deepEqual(r.doc.meta.identity, { mode: "global", alias: "merlin", team: "t:example.test", address: "cjr.aweb.ai/merlin", resident: null });
    assert.match(r.doc.brief, /retained seat of the existing aweb identity "merlin" on team t:example.test/);
    const dest = join(home, ".aw");
    for (const f of ["signing.key", "identity.yaml", "teams.yaml", "team-certs/t-example.test.pem", "encryption.yaml", "encryption-keys/x25519.key"]) assert.equal(existsSync(join(dest, f)), true, `${f} copied`);
    assert.equal((statSync(join(dest, "signing.key")).mode & 0o777), 0o600, "key material is 0600");
    assert.equal((statSync(dest).mode & 0o777), 0o700, ".aw is 0700");
    for (const f of ["workspace.yaml", "context", "interaction-log.jsonl"]) assert.equal(existsSync(join(dest, f)), false, `${f} never copied`);
    const log = readFileSync(join(base, "aw.log"), "utf8");
    assert.match(log, /^workspace connect --service=https:\/\/app\.example\.test --team=t:example\.test --role=coordinator @/m, "connect with the source's service, the team, and the source's role, nothing else");
    assert.equal(/team join|--join-from/.test(log), false, "a retained seat is never minted");
    assert.equal(log.includes("SECRET-API-KEY"), false);
    assert.match(log, /workspace connect[\s\S]*check --online[\s\S]*heartbeat[\s\S]*workspace status[\s\S]*whoami --json/, "connect, check, heartbeat, status, then whoami, in that order");
    const lock = JSON.parse(readFileSync(join(base, "legacy-home", ".aw-retained-seat.json"), "utf8"));
    assert.equal(lock.home, home); assert.equal(lock.alias, "merlin"); assert.equal(lock.team, "t:example.test");
    // A second seat cannot take a holder's identity while the holder's home
    // exists, whatever any process is doing (the spawner is long gone by then).
    assert.equal(lock.pid, undefined, "no spawner pid is recorded: it is not a liveness signal");
    const home2 = join(root, "agents", "dev", "instances", "merlin-seat-2"); mkdirSync(home2, { recursive: true });
    const second = runHook(base, bin, "spawn", { ...env, OATS_INSTANCE: "merlin-seat-2", OATS_HOME: home2 });
    assert.notEqual(second.status, 0);
    assert.match(second.stdout, /already held by /);
    assert.equal(existsSync(join(home2, ".aw")), false, "nothing copied for the refused seat");
    // The explicit take-over is the only escape, and it warns.
    const taken = runHook(base, bin, "spawn", { ...env, OATS_INSTANCE: "merlin-seat-2", OATS_HOME: home2, OATS_SETTINGS: JSON.stringify({ identity: { source: src, takeOver: true } }) });
    assert.equal(taken.status, 0, taken.stdout + taken.stderr);
    assert.equal(taken.doc.meta.tookOverFrom, home);
    assert.match(taken.doc.warning, /took over the retained identity from .*two seats with one key/);
    assert.match(taken.doc.warning, /workspace row hostname Mac\.lan/, "a differing row hostname is reported, not judged");
    assert.equal((statSync(join(home2, ".aw", "encryption-keys", "x25519.key")).mode & 0o777), 0o600, "keys inside copied directories are 0600");
    rmSync(join(home2, ".aw"), { recursive: true, force: true });
    writeFileSync(join(base, "legacy-home", ".aw-retained-seat.json"), JSON.stringify(lock));
    // Retire releases the lock and touches nothing else: no workspace delete.
    const before = readFileSync(join(base, "aw.log"), "utf8");
    const ret = runHook(base, bin, "retire", { OATS_INSTANCE: "merlin-seat", OATS_HOME: home, OATS_META: JSON.stringify(r.doc.meta) });
    assert.equal(ret.status, 0, ret.stdout + ret.stderr);
    assert.deepEqual(ret.doc.meta, { retired: true, retained: true, identityReleased: true, joinedTeams: [] });
    assert.equal(existsSync(join(base, "legacy-home", ".aw-retained-seat.json")), false, "lock released");
    assert.equal(readFileSync(join(base, "aw.log"), "utf8"), before, "retire ran no aw command at all");
    assert.equal(existsSync(join(src, "signing.key")), true, "the source identity is untouched");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("retained identity: a status that does not show the new path fails the spawn and rolls back the copied material and the lock", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-110-"));
  try {
    const bin = fakeAw(base); const { root, home } = deployment(base); const { src } = legacySeat(base);
    const r = runHook(base, bin, "spawn", { OATS_INSTANCE: "merlin-seat", OATS_HOME: home, OATS_WORKSPACE: root, OATS_CONTEXT: root, OATS_RUNTIME: "pi", OATS_TEAM_ID: "t:example.test", OATS_SETTINGS: JSON.stringify({ identity: { source: src } }), FAKE_STATUS: "elsewhere" });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /retained identity could not be seated from /);
    // The failure came after connect: the prior binding is restored FROM THE LEGACY HOME, then the copy and lock go.
    const log = readFileSync(join(base, "aw.log"), "utf8");
    const connects = log.split("\n").filter((l) => l.startsWith("workspace connect"));
    assert.equal(connects.length, 2, "connect from the new home, then the restoring connect");
    assert.equal(connects[1].split(" @")[1], realpathSync(join(base, "legacy-home")), "the restore runs in the legacy home");
    assert.equal(existsSync(join(home, ".aw")), false, "copied material removed after the restore");
    assert.equal(existsSync(join(base, "legacy-home", ".aw-retained-seat.json")), false, "lock released");
    assert.equal(existsSync(join(src, "signing.key")), true, "source untouched");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("retained identity: a whoami that reports another did fails the seat and restores the binding", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-110-"));
  try {
    const bin = fakeAw(base); const { root, home } = deployment(base); const { src } = legacySeat(base);
    const r = runHook(base, bin, "spawn", { OATS_INSTANCE: "merlin-seat", OATS_HOME: home, OATS_WORKSPACE: root, OATS_CONTEXT: root, OATS_RUNTIME: "pi", OATS_TEAM_ID: "t:example.test", OATS_SETTINGS: JSON.stringify({ identity: { source: src } }), FAKE_WHOAMI: "other" });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /could not be seated/);
    assert.equal(existsSync(join(home, ".aw")), false, "copied material removed after the restore");
    assert.equal(existsSync(join(base, "legacy-home", ".aw-retained-seat.json")), false, "lock released");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("retained identity retire releases the lock before global identity dispatch can treat no grant as nothing-to-revoke", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-110-"));
  try {
    const bin = fakeAw(base); const { root, home } = deployment(base); const { src } = legacySeat(base);
    const spawn = runHook(base, bin, "spawn", { OATS_INSTANCE: "merlin-seat", OATS_HOME: home, OATS_WORKSPACE: root, OATS_CONTEXT: root, OATS_RUNTIME: "pi", OATS_TEAM_ID: "t:example.test", OATS_SETTINGS: JSON.stringify({ identity: { source: src } }) });
    assert.equal(spawn.status, 0, spawn.stdout + spawn.stderr);
    assert.equal(spawn.doc.meta.identity.mode, "global");
    assert.equal(spawn.doc.meta.identity.grant, undefined);
    const ret = runHook(base, bin, "retire", { OATS_INSTANCE: "merlin-seat", OATS_HOME: home, OATS_META: JSON.stringify(spawn.doc.meta) });
    assert.equal(ret.status, 0, ret.stdout + ret.stderr);
    assert.deepEqual(ret.doc.meta, { retired: true, retained: true, identityReleased: true, joinedTeams: [] });
    assert.equal(existsSync(join(base, "legacy-home", ".aw-retained-seat.json")), false, "retained-seat lock released instead of global no-grant exit");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("retained identity in session mode: an aw without the wake CLI fails the seat AFTER restoring the binding and removing the copy and the lock", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-110-"));
  try {
    const bin = fakeAw(base); const { root, home } = deployment(base); const { src } = legacySeat(base);
    const r = runHook(base, bin, "spawn", { OATS_INSTANCE: "merlin-seat", OATS_HOME: home, OATS_WORKSPACE: root, OATS_CONTEXT: root, OATS_RUNTIME: "pi", OATS_TEAM_ID: "t:example.test", OATS_SETTINGS: JSON.stringify({ identity: { source: src }, delivery: "session" }), FAKE_WAKE_REGISTER_FAIL: "1" });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /could not be seated .*wake broker CLI/);
    const connects = readFileSync(join(base, "aw.log"), "utf8").split("\n").filter((l) => l.startsWith("workspace connect"));
    assert.equal(connects.length, 2, "the binding was restored from the legacy home");
    assert.equal(existsSync(join(home, ".aw")), false, "copied key removed");
    assert.equal(existsSync(join(base, "legacy-home", ".aw-retained-seat.json")), false, "lock released");
  } finally { rmSync(base, { recursive: true, force: true }); }
});
