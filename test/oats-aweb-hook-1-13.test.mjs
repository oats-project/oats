// oats.aweb 1.13.1 hook behaviour, against a fake `aw` on PATH:
// custody preflight, concrete grant scopes, team selector gating, launch renewal,
// and retirement cleanup for resident grants.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const HOOK = resolve(new URL("../mirrors/oats-aweb/bin/oats-aweb.mjs", import.meta.url).pathname);
const BINDING = resolve(new URL("../mirrors/oats-aweb/bin/oats-aweb-binding.mjs", import.meta.url).pathname);
const NORMAL_SCOPES = ["mail.read", "mail.send", "chat.read", "chat.send", "events.read", "coord.read", "coord.write", "presence.write", "contacts.read", "contacts.write"];
const REVIEWER_SCOPES = ["mail.read", "chat.read", "events.read", "coord.read", "presence.write"];

// Native version/ops come from verbatim captures; see fixtures/aw-1.36.33/SOURCE.md.
// FAKE_* overrides are synthetic fault injection, not captured native errors.
const AW_VERSION = readFileSync(new URL("./fixtures/aw-1.36.33/aw-version.txt", import.meta.url), "utf8");
const CUSTODY_OPS = JSON.parse(readFileSync(new URL("./fixtures/aw-1.36.33/custody-status-running.stdout", import.meta.url), "utf8")).ops;

function write(p, c) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); }

function fakeAw(base) {
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  write(join(bin, "aw"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { createGrantModel, serializeGrant } = require(${JSON.stringify(resolve(new URL("./helpers/fake-aw-grants.cjs", import.meta.url).pathname))});
const grants = createGrantModel(${JSON.stringify(base)});
const a = process.argv.slice(2);
const s = a.join(" ");
const log = ${JSON.stringify(join(base, "aw.log"))};
const j = (obj) => JSON.stringify(obj, null, 2);
function versionTuple(v) { return String(v || "0.0.0").replace(/^aw\\s+v?/, "").replace(/^v/, "").split(".").slice(0, 3).map(n => Number(n) || 0); }
function atLeast(v, f) { const A = versionTuple(v), B = versionTuple(f); for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return A[i] > B[i]; return true; }
function val(flag) { const eq = a.find((x) => x.startsWith(flag + "=")); if (eq) return eq.slice(flag.length + 1); const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : undefined; }
function csv(name, fallback) { return String(process.env[name] || fallback).split(",").map(s => s.trim()).filter(Boolean); }
fs.appendFileSync(log, JSON.stringify({ argv: a, cwd: process.cwd(), identityHome: process.env.AWEB_IDENTITY_HOME || null }) + "\\n");
if (a[0] === "id" && a[1] === "grant" && process.env.AWEB_IDENTITY_HOME) { console.error("grant command refuses external identity home"); process.exit(2); }
if (s === "version") { process.stdout.write(process.env.FAKE_AW_VERSION ? "aw " + process.env.FAKE_AW_VERSION : ${JSON.stringify(AW_VERSION)}); process.exit(0); }
// A host whose wake broker runs: a start the broker delivers to is refused without one.
if (s.startsWith("wake status")) { console.log(j({ daemon_running: true, daemon_version_state: "reported", daemon_version: "1.36.58", instances: [] })); process.exit(0); }
if (s.startsWith("wake ")) process.exit(0);
if (a[0] === "custody" && a[1] === "status" && a.includes("--json")) {
  const team = process.env.FAKE_CUSTODY_TEAM || "t:example.test";
  if (process.env.AWEB_IDENTITY_HOME) {
    if (process.env.FAKE_VERIFY_ERROR) { console.error(process.env.FAKE_VERIFY_ERROR); process.exit(1); }
    let text = ""; try { text = fs.readFileSync(path.join(process.env.AWEB_IDENTITY_HOME, "grant.yaml"), "utf8"); } catch {}
    const line = text.split("\\n").find((l) => l.trim().startsWith("socket_path:"));
    if (!line) { console.error("grant home has no custody.socket_path locator"); process.exit(1); }
    const socket = line.split("socket_path:")[1].trim();
    console.log(j({ status: process.env.FAKE_VERIFY_STATUS || "running", service_id: "custody-fake-4c353d6d", socket_path: process.env.FAKE_VERIFY_SOCKET || socket, resident: { did_aw: "did:aw:resident", did_key: "did:key:resident", address: "oats.aweb.ai/resident-alias", alias: process.env.FAKE_VERIFY_ALIAS || "resident-alias" }, teams: [{ team_id: team, ready: process.env.FAKE_VERIFY_TEAM_READY !== "0", certificate_present: true }], keys: { signing_ready: true, encryption_ready: true }, ops: ${JSON.stringify(CUSTODY_OPS)} }));
    process.exit(0);
  }
  const doc = {
    status: process.env.FAKE_CUSTODY_STATUS || "running",
    service_id: "custody-fake-4c353d6d",
    ...(process.env.FAKE_NO_PREFLIGHT_SOCKET ? {} : { socket_path: process.env.FAKE_CUSTODY_SOCKET || path.join(process.cwd(), "custody.sock") }),
    resident: { did_aw: "did:aw:resident", did_key: "did:key:resident", address: "oats.aweb.ai/resident-alias", alias: "resident-alias" },
    teams: process.env.FAKE_CUSTODY_TEAMS ? JSON.parse(process.env.FAKE_CUSTODY_TEAMS) : [{ team_id: team, ready: process.env.FAKE_TEAM_READY !== "0", certificate_present: process.env.FAKE_CERTIFICATE_PRESENT !== "0", grant_status_endpoint_ready: process.env.FAKE_GRANT_STATUS_ENDPOINT_READY !== "0" }],
    keys: { signing_ready: process.env.FAKE_SIGNING_READY !== "0", encryption_ready: process.env.FAKE_ENCRYPTION_READY !== "0", encryption_key_id: "enc-1" },
    ops: csv("FAKE_CUSTODY_OPS", ${JSON.stringify(CUSTODY_OPS.join(","))}),
    freshness: { source: "fake", last_checked_at: "2026-09-24T00:00:00Z", max_cache_age_seconds: 30 },
    errors: process.env.FAKE_CUSTODY_ERRORS ? JSON.parse(process.env.FAKE_CUSTODY_ERRORS) : []
  };
  console.log(j(doc)); process.exit(0);
}
if (a[0] === "id" && a[1] === "grant" && a[2] === "mint") {
  if (process.env.FAKE_MINT_FAIL) { console.error("mint unavailable"); process.exit(1); }
  const out = val("--out");
  const socket = val("--custody-socket");
  if (!out) { console.error("missing --out"); process.exit(2); }
  if (!socket) { console.error("missing --custody-socket"); process.exit(2); }
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const suffix = path.basename(out).replace(/^\\.aweb-identity-?/, "") || "spawn";
  const team = process.env.FAKE_GRANT_TEAM || val("--team") || "t:example.test";
  const { reply, document } = grants.mint({
    id: "grant-" + suffix, team, ttl: val("--ttl"), scopes: (val("--scope") || "").split(",").filter(Boolean),
    label: val("--label"), out, socket, alias: "resident-alias", address: "oats.aweb.ai/resident-alias",
    expiresAt: "2026-09-24T07:00:00Z"
  });
  // Deliberately incomplete or conflicting fields exercise the provider's failure paths.
  if (process.env.FAKE_GRANT_SOCKET === "missing") delete document.custody;
  else if (process.env.FAKE_GRANT_SOCKET) document.custody.socket_path = process.env.FAKE_GRANT_SOCKET;
  if (process.env.FAKE_GRANT_SUBJECT_ALIAS === "missing") delete document.subject.alias;
  else if (process.env.FAKE_GRANT_SUBJECT_ALIAS) document.subject.alias = process.env.FAKE_GRANT_SUBJECT_ALIAS;
  if (process.env.FAKE_MINT_ALIAS === "missing") delete reply.alias;
  else if (process.env.FAKE_MINT_ALIAS) reply.alias = process.env.FAKE_MINT_ALIAS;
  fs.writeFileSync(path.join(out, "grant.yaml"), serializeGrant(document));
  console.log(j(reply));
  process.exit(0);
}
if (a[0] === "id" && a[1] === "grant" && a[2] === "revoke") {
  if (process.env.FAKE_REVOKE_FAIL) { console.error("revoke unavailable"); process.exit(1); }
  console.log(j(grants.revoke(a[3]))); process.exit(0);
}
if (a[0] === "id" && a[1] === "grant" && a[2] === "list") { console.log(j(grants.list(val("--team")))); process.exit(0); }
if (a[0] === "id" && a[1] === "grant" && a[2] === "show") { console.log(j({ grant_id: a[3], status: "revoked" })); process.exit(0); }
console.error("fake aw: unexpected " + s); process.exit(2);
`);
  chmodSync(join(bin, "aw"), 0o755);
  return bin;
}

function deployment(base) {
  const root = join(base, "root"); mkdirSync(join(root, ".aw"), { recursive: true });
  const home = join(root, "agents", "dev", "instances", "probe"); mkdirSync(home, { recursive: true });
  return { root, home };
}

function resident(base, name = "merlin") {
  const custody = join(base, "custody", name);
  write(join(custody, ".aw", "identity.yaml"), "alias: resident-alias\n");
  return custody;
}

function settings(custody, identity = {}) {
  return { identity: { mode: "global", resident: "merlin", ...identity }, residents: { merlin: custody } };
}

// oats.aweb 1.17 (team model v2): the primary team is the kernel's default-team env, never a
// provider setting; OATS_TEAMS rows are { label, team, default, from }.
function defaultTeamEnv(team = "t:example.test") {
  return { OATS_DEFAULT_TEAM: "default", OATS_DEFAULT_TEAM_ID: team, OATS_DEFAULT_TEAM_FROM: "deployment", OATS_TEAMS: JSON.stringify([{ label: "default", team, default: true, from: "local" }]) };
}

function runHook(bin, event, env) {
  const r = spawnSync(process.execPath, [HOOK, event], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OATS_EVENT: event, ...defaultTeamEnv(), ...env } });
  let doc; try { doc = JSON.parse(r.stdout.trim().split(/\n/).at(-1)); } catch { doc = undefined; }
  return { ...r, doc };
}

function logLines(base) {
  return readFileSync(join(base, "aw.log"), "utf8").trim().split(/\n/).filter(Boolean).map((l) => JSON.parse(l));
}
// oats.aweb 1.17 passes aw value flags as one `--flag=value` argument.
function argvValue(argv, flag) {
  return argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? argv[argv.indexOf(flag) + 1];
}

function runBindingCheck(bin, settings, context, env = {}) {
  const input = { schemaVersion: 1, phase: "check", slot: "messaging", capability: "oats.aweb", settings, input: { action: { kind: "readiness" }, context } };
  const r = spawnSync(process.execPath, [BINDING, "check"], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...defaultTeamEnv(), ...env } });
  let doc; try { doc = JSON.parse(r.stdout); } catch { doc = undefined; }
  return { ...r, doc };
}

function awAtLeast(text, floor) {
  const parsed = /aw\s+v?(\d+)\.(\d+)\.(\d+)/.exec(text || "");
  if (!parsed) return false;
  const a = parsed.slice(1, 4).map(Number), b = floor.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

function spawnGrant(base, extraSettings = {}, extraEnv = {}) {
  const bin = fakeAw(base); const { root, home } = deployment(base); const custody = resident(base);
  const payload = { ...settings(custody), ...extraSettings, identity: { ...settings(custody).identity, ...(extraSettings.identity || {}) } };
  const r = runHook(bin, "spawn", { OATS_INSTANCE: "probe", OATS_HOME: home, OATS_WORKSPACE: root, OATS_CONTEXT: root, OATS_SETTINGS: JSON.stringify(payload), ...extraEnv });
  return { bin, root, home, custody, r };
}

test("normal global grants use the 1.13 concrete default scopes and preflight custody before mint", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-113-"));
  try {
    const { home, custody, r } = spawnGrant(base);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.doc.meta.identity.grant.scopes, NORMAL_SCOPES);
    assert.equal(r.doc.meta.identity.grant.home, join(home, ".aweb-identity"));
    const lines = logLines(base);
    const statusIdx = lines.findIndex((l) => l.argv.join(" ") === "custody status --json");
    const mintIdx = lines.findIndex((l) => l.argv.slice(0, 3).join(" ") === "id grant mint");
    assert.ok(statusIdx >= 0 && mintIdx > statusIdx, "custody status runs before mint");
    const mint = lines[mintIdx];
    assert.equal(mint.cwd, realpathSync(custody));
    assert.equal(mint.identityHome, null);
    assert.equal(argvValue(mint.argv, "--scope"), NORMAL_SCOPES.join(","));
    assert.equal(argvValue(mint.argv, "--custody-socket"), join(realpathSync(custody), "custody.sock"));
    assert.equal(argvValue(mint.argv, "--team"), "t:example.test");
    assert.equal(existsSync(join(home, ".aweb-identity", "grant.yaml")), true);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("reviewer profile narrows defaults, explicit scopes win, and unknown profiles are fatal", () => {
  let base = mkdtempSync(join(tmpdir(), "oats-aweb-113-"));
  try {
    let { r } = spawnGrant(base, { identity: { profile: "reviewer" } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.doc.meta.identity.grant.scopes, REVIEWER_SCOPES);
  } finally { rmSync(base, { recursive: true, force: true }); }
  base = mkdtempSync(join(tmpdir(), "oats-aweb-113-"));
  try {
    const explicit = ["mail.read", "contacts.read"];
    const { r } = spawnGrant(base, { identity: { profile: "reviewer", scopes: explicit } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.doc.meta.identity.grant.scopes, explicit);
  } finally { rmSync(base, { recursive: true, force: true }); }
  base = mkdtempSync(join(tmpdir(), "oats-aweb-113-"));
  try {
    const { r } = spawnGrant(base, { identity: { profile: "owner" } });
    assert.notEqual(r.status, 0);
    assert.match(r.doc.warning, /identity\.profile.*normal.*reviewer/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("custody preflight fails closed with typed status/error and serve remedy before mint", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-113-"));
  try {
    const { r } = spawnGrant(base, {}, { FAKE_CUSTODY_STATUS: "not_running", FAKE_CUSTODY_ERRORS: JSON.stringify(["daemon_down"]) });
    assert.notEqual(r.status, 0);
    assert.match(r.doc.warning, /custody.*not_running/);
    assert.match(r.doc.warning, /daemon_down/);
    assert.match(r.doc.warning, /start aw custody serve for merlin/);
    assert.equal(logLines(base).some((l) => l.argv.slice(0, 3).join(" ") === "id grant mint"), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("custody preflight requires team grant-status endpoint when reported, allows absent readiness, and requires certificate", () => {
  let base = mkdtempSync(join(tmpdir(), "oats-aweb-113-"));
  try {
    const { r } = spawnGrant(base, {}, { FAKE_GRANT_STATUS_ENDPOINT_READY: "0" });
    assert.notEqual(r.status, 0);
    assert.match(r.doc.warning, /the aweb server serving team t:example\.test does not provide grant status yet; hosted grants wait for that deployment/);
    assert.equal(logLines(base).some((l) => l.argv.slice(0, 3).join(" ") === "id grant mint"), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
  base = mkdtempSync(join(tmpdir(), "oats-aweb-113-"));
  try {
    const row = { team_id: "t:example.test", ready: true };
    const { r } = spawnGrant(base, {}, { FAKE_CUSTODY_TEAMS: JSON.stringify([row]) });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally { rmSync(base, { recursive: true, force: true }); }
  base = mkdtempSync(join(tmpdir(), "oats-aweb-113-"));
  try {
    const { r } = spawnGrant(base, {}, { FAKE_CERTIFICATE_PRESENT: "0" });
    assert.notEqual(r.status, 0);
    assert.match(r.doc.warning, /team t:example\.test certificate is not present in custody status/);
    assert.equal(logLines(base).some((l) => l.argv.slice(0, 3).join(" ") === "id grant mint"), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("real aw 1.36.33 custody preflight reports needs-configuration instead of faking a pass", (t) => {
  const realAw = process.env.AW_REAL_CLI_BIN;
  if (!realAw) { t.skip("set AW_REAL_CLI_BIN to a real aw 1.36.33+ binary to exercise native custody status"); return; }
  const version = spawnSync(realAw, ["version"], { encoding: "utf8", timeout: 10000 });
  if (version.status !== 0 || !awAtLeast(version.stdout + version.stderr, "1.36.33")) { t.skip(`real aw is not 1.36.33+: ${version.stdout || version.stderr}`); return; }
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-113-real-"));
  try {
    const { root, home } = deployment(base); const custody = resident(base);
    const r = runHook(dirname(realAw), "spawn", { OATS_INSTANCE: "probe", OATS_HOME: home, OATS_WORKSPACE: root, OATS_CONTEXT: root, OATS_SETTINGS: JSON.stringify(settings(custody)) });
    assert.notEqual(r.status, 0);
    assert.match(r.doc.warning, /custody preflight failed for merlin/);
    assert.match(r.doc.warning, /status=not_running/);
    assert.match(r.doc.warning, /custody_unavailable/);
    assert.match(r.doc.warning, /start aw custody serve for merlin/);
    assert.equal(existsSync(join(home, ".aweb-identity")), false, "no grant home is minted on failed real custody preflight");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("real aw fixture: unattached grant home reports the released custody locator error", (t) => {
  const fixture = process.env.AW_REAL_GRANT_FIXTURE;
  const realAw = process.env.AW_REAL_CLI_BIN || "aw";
  if (!fixture) { t.skip("set AW_REAL_GRANT_FIXTURE to an unattached real grant home"); return; }
  const version = spawnSync(realAw, ["version"], { encoding: "utf8", timeout: 10000 });
  if (version.status !== 0 || !awAtLeast(version.stdout + version.stderr, "1.36.33")) { t.skip(`real aw is not 1.36.33+: ${version.stdout || version.stderr}`); return; }
  const r = spawnSync(realAw, ["custody", "status", "--json"], { cwd: fixture, encoding: "utf8", env: { ...process.env, AWEB_IDENTITY_HOME: fixture }, timeout: 10000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /grant home has no custody\.socket_path locator/);
});

test("custody preflight requires e2ee operations by default; identity.e2ee false needs signing only and briefs a warning", () => {
  let base = mkdtempSync(join(tmpdir(), "oats-aweb-113-"));
  try {
    const { r } = spawnGrant(base, {}, { FAKE_CUSTODY_OPS: CUSTODY_OPS.filter(op => !["create_e2ee_envelope.v1", "unwrap_e2ee_message.v1", "mail_reply_continuation.v1"].includes(op)).join(","), FAKE_ENCRYPTION_READY: "0" });
    assert.notEqual(r.status, 0);
    assert.match(r.doc.warning, /create_e2ee_envelope\.v1/);
    assert.match(r.doc.warning, /start aw custody serve for merlin/);
  } finally { rmSync(base, { recursive: true, force: true }); }
  base = mkdtempSync(join(tmpdir(), "oats-aweb-113-"));
  try {
    const { r } = spawnGrant(base, { identity: { e2ee: false } }, { FAKE_CUSTODY_OPS: CUSTODY_OPS.filter(op => !["create_e2ee_envelope.v1", "unwrap_e2ee_message.v1", "mail_reply_continuation.v1"].includes(op)).join(","), FAKE_ENCRYPTION_READY: "0" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.doc.brief, /E2E encryption is disabled/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("single aw floor refuses older aw before grant mint and always passes --team", () => {
  let base = mkdtempSync(join(tmpdir(), "oats-aweb-113-"));
  try {
    const { home, r } = spawnGrant(base, {}, { FAKE_AW_VERSION: "1.36.12" });
    assert.notEqual(r.status, 0);
    assert.match(r.doc.warning, /aw 1\.36\.12 is older than required 1\.36\.33/);
    assert.equal(existsSync(join(base, "aw.log")) && logLines(base).some((l) => l.argv.slice(0, 3).join(" ") === "id grant mint"), false);
    assert.equal(existsSync(join(home, ".aweb-identity")), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
  base = mkdtempSync(join(tmpdir(), "oats-aweb-113-"));
  try {
    const { r } = spawnGrant(base);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const mint = logLines(base).find((l) => l.argv.slice(0, 3).join(" ") === "id grant mint").argv;
    assert.equal(argvValue(mint, "--team"), "t:example.test");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("grant attachment verification failures revoke the grant, remove the home, and fail spawn", () => {
  const cases = [
    [{ FAKE_VERIFY_STATUS: "not_running" }, /not running/],
    [{ FAKE_VERIFY_SOCKET: "/tmp/other.sock" }, /socket_path .* differs/],
    [{ FAKE_VERIFY_ALIAS: "other-alias" }, /resident alias other-alias differs/],
    [{ FAKE_VERIFY_TEAM_READY: "0" }, /team t:example\.test is not ready/],
    [{ FAKE_VERIFY_ERROR: "custody broke" }, /custody attachment failed/],
    [{ FAKE_GRANT_SOCKET: "missing" }, /grant\.yaml custody\.socket_path is missing/],
  ];
  for (const [env, pattern] of cases) {
    const base = mkdtempSync(join(tmpdir(), "oats-aweb-113-"));
    try {
      const { home, r } = spawnGrant(base, {}, env);
      assert.notEqual(r.status, 0, JSON.stringify(env));
      assert.match(r.doc.warning, pattern);
      assert.equal(existsSync(join(home, ".aweb-identity")), false, "failed grant home removed");
      assert.ok(logLines(base).some((l) => l.argv.join(" ") === "id grant revoke grant-spawn --json"), "minted grant revoked");
    } finally { rmSync(base, { recursive: true, force: true }); }
  }
});

test("global grant spawn refuses a preflight without socket_path before mint", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-113-"));
  try {
    const { home, r } = spawnGrant(base, {}, { FAKE_NO_PREFLIGHT_SOCKET: "1" });
    assert.notEqual(r.status, 0);
    assert.match(r.doc.warning, /custody preflight reported no socket_path/);
    assert.equal(logLines(base).some((l) => l.argv.slice(0, 3).join(" ") === "id grant mint"), false);
    assert.equal(existsSync(join(home, ".aweb-identity")), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("grant subject alias from grant.yaml wins over mint output, with resident fallback only when both are absent", () => {
  let base = mkdtempSync(join(tmpdir(), "oats-aweb-113-"));
  try {
    const { r } = spawnGrant(base, {}, { FAKE_GRANT_SUBJECT_ALIAS: "subject-alias", FAKE_MINT_ALIAS: "wire-alias", FAKE_VERIFY_ALIAS: "subject-alias" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.doc.meta.identity.alias, "subject-alias");
  } finally { rmSync(base, { recursive: true, force: true }); }
  base = mkdtempSync(join(tmpdir(), "oats-aweb-113-"));
  try {
    const { r } = spawnGrant(base, {}, { FAKE_GRANT_SUBJECT_ALIAS: "missing", FAKE_MINT_ALIAS: "missing", FAKE_VERIFY_ALIAS: "merlin" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.doc.meta.identity.alias, "merlin");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("readiness checks the recorded grant home for custody attachment", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-113-"));
  try {
    const bin = fakeAw(base); const { root, home } = deployment(base); const custody = resident(base);
    const oldHome = join(home, ".aweb-identity");
    const newHome = join(home, ".aweb-identity-200");
    write(join(oldHome, "grant.yaml"), "grant_id: old\nteam_id: t:example.test\nexpires_at: old\ncustody:\n  socket_path: old.sock\n");
    write(join(newHome, "grant.yaml"), "grant_id: newer\nteam_id: t:example.test\nexpires_at: newer\n");
    const later = new Date(Date.now() + 5000);
    statSync(oldHome); // A newer unselected directory must not override the recorded locator.
    utimesSync(oldHome, later, later);
    const ctx = { kind: "workspace", workspace: root, deployment: root, soul: "dev", home };
    write(join(home, "instance.json"), JSON.stringify({ capabilityMeta: { "oats.aweb": { identity: { mode: "global", grant: { id: "newer", home: newHome } } } } }));
    const checked = runBindingCheck(bin, settings(custody), ctx);
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(checked.doc.result.status, "needs-configuration");
    assert.deepEqual(checked.doc.result.problems.find((p) => p.code === "custody")?.message, "grant newer is not attached to custody; retire and respawn on aw >= 1.36.33");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("launch with renewal off preserves the existing grant locator and session delivery env", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-113-"));
  try {
    const bin = fakeAw(base); const { root, home } = deployment(base); const custody = resident(base);
    const oldHome = join(home, ".aweb-identity"); mkdirSync(oldHome, { recursive: true });
    const old = { delivery: "session", identity: { mode: "global", alias: "resident-alias", team: "t:example.test", resident: "merlin", grant: { id: "grant-old", expiresAt: "old", scopes: ["mail.read"] } } };
    const r = runHook(bin, "launch", { OATS_INSTANCE: "probe", OATS_HOME: home, OATS_WORKSPACE: root, OATS_CONTEXT: root, OATS_META: JSON.stringify(old), OATS_SETTINGS: JSON.stringify({ ...settings(custody, { renew: "off" }), delivery: "session" }), AWEB_IDENTITY_HOME: join(base, "foreign-parent-grant") });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.doc.env, { AWEB_DELIVERY: "session", AWEB_IDENTITY_HOME: oldHome });
    assert.deepEqual(r.doc.meta, { ...old, delivery: "session", runtime: "" }, "the start records the delivery and runtime it ran under and keeps the grant");
    assert.deepEqual(logLines(base).map((l) => l.argv.join(" ")), ["wake status --json", `wake register --home ${home} --identity-home ${oldHome} --delivery session`], "renewal off calls aw only to confirm the broker runs and keep its registration on the existing grant home");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("local-mode launch with renew=launch still preserves delivery launch contributions", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-113-"));
  try {
    const bin = fakeAw(base); const { root, home } = deployment(base); const custody = resident(base);
    const old = { delivery: "session", identity: { mode: "local", alias: "probe", team: "t:example.test", address: null, resident: null } };
    const r = runHook(bin, "launch", { OATS_INSTANCE: "probe", OATS_HOME: home, OATS_WORKSPACE: root, OATS_CONTEXT: root, OATS_META: JSON.stringify(old), OATS_SETTINGS: JSON.stringify({ delivery: "session", identity: { mode: "local", renew: "launch" }, residents: { merlin: custody } }) });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.doc.env, { AWEB_DELIVERY: "session", AWEB_IDENTITY_HOME: join(home, ".aw") });
    assert.equal(logLines(base).some((l) => l.argv[0] !== "wake"), false, "local renew=launch does not try grant renewal");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("launch renewal mints into a fresh grant home, emits the new locator, and revokes the old grant", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-113-"));
  try {
    const bin = fakeAw(base); const { root, home } = deployment(base); const custody = resident(base);
    mkdirSync(join(home, ".aweb-identity"), { recursive: true });
    const old = { delivery: "channel", identity: { mode: "global", alias: "resident-alias", team: "t:example.test", resident: "merlin", grant: { id: "grant-old", expiresAt: "old", scopes: ["mail.read"] } } };
    const r = runHook(bin, "launch", { OATS_INSTANCE: "probe", OATS_HOME: home, OATS_WORKSPACE: root, OATS_CONTEXT: root, OATS_META: JSON.stringify(old), OATS_SETTINGS: JSON.stringify(settings(custody, { renew: "launch" })), AWEB_IDENTITY_HOME: join(base, "foreign-parent-grant") });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.doc.env.AWEB_IDENTITY_HOME, /\.aweb-identity-\d+$/);
    assert.notEqual(r.doc.env.AWEB_IDENTITY_HOME, join(home, ".aweb-identity"));
    assert.equal(existsSync(join(r.doc.env.AWEB_IDENTITY_HOME, "grant.yaml")), true);
    assert.equal(r.doc.meta.identity.grant.id.startsWith("grant-"), true);
    assert.equal(r.doc.meta.identity.grant.home, r.doc.env.AWEB_IDENTITY_HOME);
    assert.ok(logLines(base).some((l) => l.argv.join(" ") === "id grant revoke grant-old --json"));
    assert.equal(logLines(base).some((l) => l.argv.join(" ").includes("foreign-parent-grant")), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("launch renewal keeps the old grant and locator when mint fails", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-113-"));
  try {
    const bin = fakeAw(base); const { root, home } = deployment(base); const custody = resident(base);
    const oldHome = join(home, ".aweb-identity"); mkdirSync(oldHome, { recursive: true });
    const old = { identity: { mode: "global", alias: "resident-alias", team: "t:example.test", resident: "merlin", grant: { id: "grant-old", expiresAt: "old", scopes: ["mail.read"] } } };
    const r = runHook(bin, "launch", { OATS_INSTANCE: "probe", OATS_HOME: home, OATS_WORKSPACE: root, OATS_CONTEXT: root, OATS_META: JSON.stringify(old), OATS_SETTINGS: JSON.stringify(settings(custody, { renew: "launch" })), OATS_RUNTIME: "claude", FAKE_MINT_FAIL: "1" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.doc.env, { AWEB_IDENTITY_HOME: oldHome });
    assert.equal(r.doc.meta.identity.grant.id, "grant-old");
    assert.equal(existsSync(oldHome), true);
    assert.match(r.doc.warning, /renewal mint failed/);
    assert.equal(logLines(base).some((l) => l.argv.join(" ") === "id grant revoke grant-old --json"), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("launch renewal keeps the old grant when attachment verification or preflight socket fails", () => {
  const cases = [
    [{ FAKE_VERIFY_STATUS: "not_running" }, /renewal grant .* custody attachment failed/],
    [{ FAKE_NO_PREFLIGHT_SOCKET: "1" }, /renewal custody preflight reported no socket_path/],
  ];
  for (const [env, pattern] of cases) {
    const base = mkdtempSync(join(tmpdir(), "oats-aweb-113-"));
    try {
      const bin = fakeAw(base); const { root, home } = deployment(base); const custody = resident(base);
      const oldHome = join(home, ".aweb-identity");
      write(join(oldHome, "grant.yaml"), "grant_id: grant-old\nteam_id: t:example.test\nexpires_at: old\ncustody:\n  socket_path: old.sock\n");
      const old = { identity: { mode: "global", alias: "resident-alias", team: "t:example.test", resident: "merlin", grant: { id: "grant-old", expiresAt: "old", scopes: ["mail.read"], home: oldHome } } };
      const r = runHook(bin, "launch", { OATS_INSTANCE: "probe", OATS_HOME: home, OATS_WORKSPACE: root, OATS_CONTEXT: root, OATS_META: JSON.stringify(old), OATS_SETTINGS: JSON.stringify(settings(custody, { renew: "launch" })), OATS_RUNTIME: "claude", ...env });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.equal(r.doc.meta.identity.grant.id, "grant-old");
      assert.deepEqual(r.doc.env, { AWEB_IDENTITY_HOME: oldHome });
      assert.equal(existsSync(oldHome), true);
      assert.match(r.doc.warning, pattern);
      const minted = logLines(base).filter((l) => l.argv.slice(0, 3).join(" ") === "id grant mint");
      if (minted.length) {
        const newHome = argvValue(minted[0].argv, "--out");
        assert.equal(existsSync(newHome), false, "failed renewal grant home removed");
        assert.ok(logLines(base).some((l) => l.argv.join(" ") === "id grant revoke grant-" + newHome.split(".aweb-identity-").at(-1) + " --json"));
      }
      assert.equal(logLines(base).some((l) => l.argv.join(" ") === "id grant revoke grant-old --json"), false);
    } finally { rmSync(base, { recursive: true, force: true }); }
  }
});

test("launch renewal reports old revoke failure truthfully but keeps the new grant", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-113-"));
  try {
    const bin = fakeAw(base); const { root, home } = deployment(base); const custody = resident(base);
    const old = { identity: { mode: "global", alias: "resident-alias", team: "t:example.test", resident: "merlin", grant: { id: "grant-old", expiresAt: "old", scopes: ["mail.read"] } } };
    const r = runHook(bin, "launch", { OATS_INSTANCE: "probe", OATS_HOME: home, OATS_WORKSPACE: root, OATS_CONTEXT: root, OATS_META: JSON.stringify(old), OATS_SETTINGS: JSON.stringify(settings(custody, { renew: "launch" })), FAKE_REVOKE_FAIL: "1" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.doc.warning, /previous grant grant-old was not revoked/);
    assert.equal(existsSync(r.doc.env.AWEB_IDENTITY_HOME), true, "new grant home kept");
    assert.notEqual(r.doc.meta.identity.grant.id, "grant-old");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("retire revokes the current grant id and removes every .aweb-identity directory", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-aweb-113-"));
  try {
    const bin = fakeAw(base); const { root, home } = deployment(base); const custody = resident(base);
    mkdirSync(join(home, ".aweb-identity"), { recursive: true });
    mkdirSync(join(home, ".aweb-identity-1"), { recursive: true });
    mkdirSync(join(home, ".aweb-identity-2"), { recursive: true });
    const meta = { identity: { mode: "global", resident: "merlin", grant: { id: "grant-current", expiresAt: "ttl", scopes: ["mail.read"] } } };
    const r = runHook(bin, "retire", { OATS_INSTANCE: "probe", OATS_HOME: home, OATS_WORKSPACE: root, OATS_CONTEXT: root, OATS_META: JSON.stringify(meta), OATS_SETTINGS: JSON.stringify({ residents: { merlin: custody } }) });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(logLines(base).some((l) => l.argv.join(" ") === "id grant revoke grant-current --json"));
    assert.equal(existsSync(join(home, ".aweb-identity")), false);
    assert.equal(existsSync(join(home, ".aweb-identity-1")), false);
    assert.equal(existsSync(join(home, ".aweb-identity-2")), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
