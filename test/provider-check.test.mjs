// lib/instance-inspect.mjs — the readiness `providers` relay (lead decisions on #162 and its review):
// the provider's check answer is relayed verbatim as {status, problems, warnings};
// optional warnings never change the status and are validated as strictly as
// problems; the check executable must stay inside its module (realpath containment).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readinessDocument, runProviderCheck } from "../lib/instance-inspect.mjs";
import { kernelNode } from "../lib/stable-node.mjs";

/** A home target with one bound provider module whose check prints `answer`. */
function target(base, answer, { script = "bin/check.mjs", body = null } = {}) {
  const home = join(base, "home"), dir = join(home, ".oats", "modules", "fx.provider");
  mkdirSync(join(dir, "bin"), { recursive: true });
  const manifest = { capability: "fx.provider", version: "1.0.0", layer: "messaging", commands: { "binding-check": script }, binding: { version: 1, check: "binding-check" } };
  writeFileSync(join(dir, "oats.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "bin", "check.mjs"), body ?? `process.stdout.write(${JSON.stringify(JSON.stringify(answer))} + "\\n");\n`);
  const mod = { name: "fx.provider", from: null, manifest, dir };
  const t = { kind: "instance", home, meta: { instance: "fx-1", agent: "fx" }, deployment: base, agentsRoot: join(base, "agents"),
    subject: { kind: "instance", instance: "fx-1", home, soul: "fx" },
    soul: { name: "fx", repoKey: null, commit: null, external: true, path: null, soulDir: null, definition: null, problems: [] },
    workspace: { key: null, name: null, deployment: base, commit: null, standalone: false },
    modules: [mod], payloads: {}, slots: { knowledge: null, messaging: "fx.provider", tasks: null }, discovery: null, discoveryError: null, resolutionError: null, lock: null, prepared: null };
  return { t, mod, dir };
}
const envelope = (result) => ({ schemaVersion: 1, phase: "check", slot: "messaging", capability: "fx.provider", ok: true, result });

test("a ready check with a warning passes, and the warning is relayed verbatim", async () => {
  const base = mkdtempSync(join(tmpdir(), "oats-provider-check-"));
  try {
    const warning = { code: "e2ee-disabled", message: "end-to-end encryption is disabled for this team" };
    const { t } = target(base, envelope({ status: "ready", problems: [], warnings: [warning] }));
    const rd = await readinessDocument(t);
    const item = rd.checks.providers.items[0];
    assert.equal(item.status, "pass");
    assert.deepEqual(item.result, { status: "ready", problems: [], warnings: [warning] });
    assert.equal(item.reason, null, "a warning is not a failure reason");
    assert.equal(rd.summary.ready, true, "warnings never change readiness");
    assert.equal(rd.summary.fail + rd.summary.unknown, 0);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("a claude or codex home on a session provider has no pane: its harness-trust item is not-applicable, not unknown", async () => {
  const base = mkdtempSync(join(tmpdir(), "oats-provider-check-"));
  try {
    const { t } = target(base, envelope({ status: "ready", problems: [] }));
    const trustItem = async (meta) => (await readinessDocument({ ...t, meta: { ...t.meta, ...meta } })).checks.configured.items.find((i) => i.code === "harness-trust");
    for (const harness of ["claude", "codex"]) {
      const onProvider = await trustItem({ harness, backend: "fx", session: { provider: "fx.provider" } });
      assert.equal(onProvider.status, "not-applicable", harness);
      assert.equal(onProvider.required, false);
      assert.equal(onProvider.file, null);
      assert.equal(onProvider.harness, harness);
      assert.match(onProvider.reason, /session provider runs this launch \(backend fx\), with no OATS pane/);
      const onTmux = await trustItem({ harness });
      assert.notEqual(onTmux.status, "not-applicable", `a tmux ${harness} home still reads its pane's file`);
      assert.match(onTmux.reason ?? `${onTmux.file}`, /folder trust|\//, "and says what it read");
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("absent warnings read as []; malformed warnings make the whole answer unknown", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-provider-check-"));
  try {
    let { t, mod, dir } = target(join(base, "a"), envelope({ status: "needs-configuration", problems: [{ code: "needs-configuration", message: "x" }] }));
    assert.deepEqual(runProviderCheck(t, mod, dir), { outcome: "result", result: { status: "needs-configuration", problems: [{ code: "needs-configuration", message: "x" }], warnings: [] } });
    for (const [i, warnings] of [[{ code: "w" }], "e2ee off", [{ code: 1, message: "m" }]].entries()) {
      ({ t, mod, dir } = target(join(base, `bad${i}`), envelope({ status: "ready", problems: [], warnings })));
      const out = runProviderCheck(t, mod, dir);
      assert.equal(out.outcome, "unknown", JSON.stringify(warnings));
      assert.equal(out.problems[0].code, "provider-unavailable");
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("a check executable that symlinks out of its module is not run", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-provider-check-"));
  try {
    const outside = join(base, "outside.mjs");
    writeFileSync(outside, `process.stdout.write(${JSON.stringify(JSON.stringify(envelope({ status: "ready", problems: [] })))} + "\\n");\n`);
    const { t, mod, dir } = target(base, envelope({ status: "ready", problems: [] }), { script: "bin/escape.mjs" });
    symlinkSync(outside, join(dir, "bin", "escape.mjs"));
    const out = runProviderCheck(t, mod, dir);
    assert.equal(out.outcome, "unknown");
    assert.equal(out.problems[0].code, "resource-not-found");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("the answer is decoded by the binding wire's rules: exit 0, one strict document, the exact envelope echo, no problems on ready", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-provider-check-"));
  try {
    const ready = envelope({ status: "ready", problems: [] });
    const line = JSON.stringify(ready);
    const cases = {
      "nonzero exit": { body: `process.stdout.write(${JSON.stringify(line)} + "\\n"); process.exit(3);\n` },
      "two documents": { body: `process.stdout.write(${JSON.stringify(line)} + "\\n" + ${JSON.stringify(line)} + "\\n");\n` },
      "prose before the document": { body: `process.stdout.write("checking…\\n" + ${JSON.stringify(line)} + "\\n");\n` },
      "another capability echoed": { answer: { ...ready, capability: "someone-else" } },
      "another phase echoed": { answer: { ...ready, phase: "bind" } },
      "another schemaVersion": { answer: { ...ready, schemaVersion: 9 } },
      "an unknown envelope field": { answer: { ...ready, seen: true } },
      "an unknown result field": { answer: envelope({ status: "ready", problems: [], detail: "x" }) },
      "ready with problems": { answer: envelope({ status: "ready", problems: [{ code: "needs-configuration", message: "x" }] }) },
      "an unknown status": { answer: envelope({ status: "fine", problems: [] }) },
    };
    for (const [i, [what, c]] of Object.entries(cases).entries()) {
      const { t, mod, dir } = target(join(base, String(i)), c.answer ?? ready, { body: c.body ?? null });
      const out = runProviderCheck(t, mod, dir);
      assert.equal(out.outcome, "unknown", what);
      assert.equal(out.problems[0].code, "provider-unavailable", what);
    }
    // A refusal is relayed with the provider's own code.
    const { t, mod, dir } = target(join(base, "refused"), { schemaVersion: 1, phase: "check", slot: "messaging", capability: "fx.provider", ok: false, error: { code: "invalid-binding", message: "no captured binding" } });
    assert.deepEqual(runProviderCheck(t, mod, dir), { outcome: "unknown", problems: [{ code: "invalid-binding", message: "no captured binding" }] });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("all four check statuses are relayed verbatim: authorization-required fails, unavailable is unknown", async () => {
  const base = mkdtempSync(join(tmpdir(), "oats-provider-check-"));
  try {
    const expected = { ready: "pass", "needs-configuration": "fail", "authorization-required": "fail", unavailable: "unknown" };
    for (const [status, itemStatus] of Object.entries(expected)) {
      const problems = status === "ready" ? [] : [{ code: status === "unavailable" ? "provider-unavailable" : status, message: `${status} (fixture)` }];
      const { t } = target(join(base, status), envelope({ status, problems }));
      const item = (await readinessDocument(t)).checks.providers.items[0];
      assert.equal(item.status, itemStatus, status);
      assert.deepEqual(item.result, { status, problems, warnings: [] }, `${status}: verbatim`);
      assert.equal(item.reason, status === "ready" ? null : `${status} (fixture)`);
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("the providers check has one total time budget; checks past it are unknown, not run", async () => {
  const base = mkdtempSync(join(tmpdir(), "oats-provider-check-"));
  try {
    const marker = join(base, "ran");
    const { t } = target(base, null, { body: `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");\n` });
    const item = (await readinessDocument(t, { budgetMs: 0 })).checks.providers.items[0];
    assert.equal(item.status, "unknown");
    assert.equal(item.problems[0].code, "time-budget-exhausted");
    assert.match(item.reason, /^time budget exhausted/);
    assert.equal(existsSync(marker), false, "the check was not run");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// ---- the wire, pinned: providers build against it, so it must not move silently ----
/** A provider module whose check records exactly what it received (stdin, env, cwd,
 *  argv) into `record`, then answers a valid envelope echoing the request. */
function recordingProvider(base, record, { sleepMs = 0 } = {}) {
  const dir = join(base, "module"); mkdirSync(join(dir, "bin"), { recursive: true });
  const manifest = { capability: "fx.provider", version: "1.0.0", layer: "messaging", commands: { "binding-check": "bin/check.mjs check --wire 1" }, binding: { version: 1, check: "binding-check" } };
  writeFileSync(join(dir, "oats.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "bin", "check.mjs"), `import { readFileSync, writeFileSync } from "node:fs";
const stdin = readFileSync(0, "utf8");
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ stdin, env: process.env, cwd: process.cwd(), argv: process.argv.slice(2) }));
${sleepMs ? `await new Promise((r) => setTimeout(r, ${sleepMs}));` : ""}
const req = JSON.parse(stdin);
process.stdout.write(JSON.stringify({ schemaVersion: req.schemaVersion, phase: req.phase, slot: req.slot, capability: req.capability, ok: true, result: { status: "ready", problems: [] } }) + "\\n");
`);
  return { dir, mod: { name: "fx.provider", from: null, manifest, dir } };
}
/** The teams a target carries (team model v2): the default (mapped) and one unmapped shared team. */
const WIRE_DEFAULT = { label: "engineering", team: "acme:eng", from: "deployment" };
const WIRE_TEAMS = [{ label: "engineering", team: "acme:eng", default: true, from: "local" }, { label: "night", team: null, default: false, from: "shared" }];
function wireTarget(base, { home = null, soulDir = null, teams = WIRE_TEAMS, defaultTeam = WIRE_DEFAULT } = {}) {
  return { kind: home ? "instance" : "soul", home, meta: home ? { instance: "rm-1", agent: "release-manager" } : null, deployment: base, agentsRoot: join(base, "agents"),
    soul: { name: "release-manager", repoKey: "github.com/acme/agents", commit: "c".repeat(40), external: false, path: null, soulDir, definition: null, problems: [] },
    soulIdentity: { agent: "release-manager", id: "github.com/acme/agents#release-manager" },
    workspace: { key: "github.com/acme/agents", name: "acme", deployment: base, commit: "c".repeat(40), standalone: false },
    payloads: { "fx.provider": { root: "/srv/aw" } }, slots: { knowledge: null, messaging: "fx.provider", tasks: null }, teams, defaultTeam, teamsSource: "live" };
}
const AMBIENT = { OATS_INSTANCE: "ambient-instance", OATS_SOUL: "/ambient/soul", OATS_AGENT: "ambient-agent", OATS_SOUL_ID: "ambient#agent", OATS_ROOT: "/ambient/agents", OAS_HOME: "/ambient/oas", PI_AGENTS_ROOT: "/ambient/pi", PI_AGENT_HOME: "/ambient/home", OATS_PROVIDER_WIRE_KEEP: "no", PROVIDER_WIRE_AMBIENT: "kept" };
function withAmbient(fn) {
  const saved = Object.fromEntries(Object.keys(AMBIENT).map((k) => [k, process.env[k]]));
  Object.assign(process.env, AMBIENT);
  try { return fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test("provider-check wire (pinned): the request on stdin, the environment, the cwd and the argv a provider receives", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "oats-provider-wire-")));
  try {
    const record = join(base, "record.json");
    const { dir, mod } = recordingProvider(base, record);
    const settings = { root: "/srv/aw" };

    // ---- an instance home subject ----
    const home = join(base, "agents", "release-manager", "instances", "rm-1"), soulDir = join(base, "agents", "release-manager", "souls", "cccccccccccc");
    const out = withAmbient(() => runProviderCheck(wireTarget(base, { home, soulDir }), mod, dir));
    assert.deepEqual(out, { outcome: "result", result: { status: "ready", problems: [], warnings: [] } });
    let seen = JSON.parse(readFileSync(record, "utf8"));
    assert.deepEqual(JSON.parse(seen.stdin), {
      schemaVersion: 1, phase: "check", slot: "messaging", capability: "fx.provider", settings,
      input: { context: { kind: "workspace", workspace: "github.com/acme/agents", deployment: base, soul: "release-manager", instance: "rm-1", home },
        action: { kind: "readiness" } },
    }, "the stdin request, exactly: the released binding wire (the teams travel in the env only; a strict decoder refuses any other key)");
    assert.equal(seen.cwd, dir, "cwd is the module directory");
    assert.deepEqual(seen.argv, ["check", "--wire", "1"], "the manifest command's arguments, no shell");
    const oats = Object.fromEntries(Object.entries(seen.env).filter(([k]) => /^(OATS_|OAS_|PI_)/.test(k)));
    assert.deepEqual(oats, {
      OATS_CAPABILITY: "fx.provider", OATS_SETTINGS: JSON.stringify(settings), OATS_SETTINGS_ORIGINS: "{}", OATS_CLI_BIN: join(fileURLToPath(new URL("..", import.meta.url)), "bin", "oats.mjs"), OATS_NODE_BIN: kernelNode().node, OATS_WORKSPACE: base,
      OATS_TEAM_NAME: "", OATS_TEAM_SCOPE: base, OATS_DEFAULT_TEAM: "engineering", OATS_DEFAULT_TEAM_ID: "acme:eng", OATS_DEFAULT_TEAM_FROM: "deployment",
      OATS_TEAMS: JSON.stringify([WIRE_TEAMS[0]]), OATS_TEAMS_SOURCE: "live", OATS_WORKSPACE_NAME: "acme", OATS_WORKSPACE_KEY: "github.com/acme/agents",
      OATS_INSTANCE: "rm-1", OATS_INSTANCE_HOME: home, OATS_AGENT: "release-manager", OATS_SOUL_ID: "github.com/acme/agents#release-manager", OATS_SOUL: soulDir,
    }, "exactly these OATS_* variables; every ambient OATS_/OAS_/PI_ variable is stripped");
    assert.equal(seen.env.PROVIDER_WIRE_AMBIENT, "kept", "an ambient non-OATS variable passes through (as for the broker)");

    // ---- a soul subject: no instance/home, no soul directory known, no teams configured ----
    rmSync(record);
    withAmbient(() => runProviderCheck(wireTarget(base, { teams: [], defaultTeam: null }), mod, dir));
    seen = JSON.parse(readFileSync(record, "utf8"));
    assert.equal("teams" in JSON.parse(seen.stdin), false, "never on stdin");
    assert.equal(seen.env.OATS_TEAMS, "[]", "no teams configured here");
    assert.equal(seen.env.OATS_DEFAULT_TEAM, undefined, "no default: none of the default names is set");
    assert.deepEqual(JSON.parse(seen.stdin).input.context, { kind: "workspace", workspace: "github.com/acme/agents", deployment: base, soul: "release-manager", instance: null, home: null });
    for (const k of ["OATS_INSTANCE", "OATS_INSTANCE_HOME", "OATS_SOUL", "OATS_ROOT", "OAS_HOME", "PI_AGENTS_ROOT", "PI_AGENT_HOME", "OATS_PROVIDER_WIRE_KEEP"]) assert.equal(seen.env[k], undefined, `${k} is not passed for a soul subject`);
    assert.equal(seen.env.OATS_AGENT, "release-manager"); assert.equal(seen.env.OATS_SOUL_ID, "github.com/acme/agents#release-manager"); assert.equal(seen.env.OATS_TEAM_LABEL, undefined);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("provider-check wire (pinned): a check past its timeout is killed and reads unknown", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "oats-provider-wire-")));
  try {
    const { dir, mod } = recordingProvider(base, join(base, "record.json"), { sleepMs: 20_000 });
    const t0 = Date.now();
    const out = runProviderCheck(wireTarget(base), mod, dir, { timeoutMs: 400 });
    assert.ok(Date.now() - t0 < 10_000, "the stub was killed, not waited for");
    assert.deepEqual(out, { outcome: "unknown", problems: [{ code: "provider-unavailable", message: "fx.provider check did not complete in time" }] });
  } finally { rmSync(base, { recursive: true, force: true }); }
});
