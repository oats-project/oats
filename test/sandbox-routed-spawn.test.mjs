// Sandboxes, the routed spawn (docs/design/2026-11-19-sandboxes.md, "The exact order of a routed spawn",
// steps 1–7; S1 Acceptance 6–9): plan(seat), the remote preview with the seat's provider options, the
// kept request, seat, the apply bound to the preview's decision and keyed by the spawn key, its answer
// unchanged to bind, and the replay fence. The kernel side runs in process (lib/sandboxes.mjs) against
// the fake provider and a fake host behind the server route's injected ssh (io.execFileSync): the host
// answers the probe, the roster, the preview and the apply as a sandbox's kernel would.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxDeployment } from "./helpers/sandbox-fixture.mjs";

const SENTINEL = "TASK-SENTINEL-6d1f0c3e";
const D = "decision-0123456789abcdef";
const FEATURES = ["sandboxes", "spawn-task-stdin", "spawn-preview-2", "spawn-apply-2", "spawn-idempotency-2", "spawn-name"];

/** A sandbox's kernel behind the server route: `apply` is the apply's answer (an envelope, or "no-answer"
 *  for a link that failed after ssh started). `calls` records each spawn with the provider's call count
 *  at that moment, so the two sides' order can be read together. */
function fakeHost(fx, { apply = "ok", features = FEATURES } = {}) {
  const probe = { schemaVersion: 1, name: "@awebai/oats", version: "0.70.0", desktopApi: 1, harnesses: ["pi"], sessionBackends: ["tmux"], launchOptions: [], remote: ["spawn", "status", "retire"], features };
  const status = { schemaVersion: 1, ok: true, result: { root: "/sbx/agents", agents: [{ name: "ingester", harness: "pi", instances: [] }] } };
  const preview = { schemaVersion: 1, ok: true, result: { spawnPreviewApi: 2, preview: true, agent: "ingester", instance: "ingester-a", home: "/sbx/agents/ingester/instances/ingester-a", decision: { instance: "ingester-a", revision: D } } };
  const calls = [];
  const execFileSync = (bin, argv, options) => {
    const command = String(argv.at(-1));
    if (command.includes("version --json")) return JSON.stringify(probe);
    if (command.includes(" status ")) return JSON.stringify(status);
    if (command.includes(" spawn ")) {
      calls.push({ command, input: options.input === undefined ? undefined : Buffer.from(options.input).toString("utf8"), provider: fx.sandbox.calls().length, preview: command.includes("--preview") });
      if (command.includes("--preview")) return JSON.stringify(preview);
      const answer = typeof apply === "function" ? apply(command) : apply;
      if (answer === "no-answer") throw Object.assign(new Error("Connection reset"), { status: 255, stdout: "", stderr: "client_loop: send disconnect: Broken pipe\n" });
      if (answer === "ok") return JSON.stringify({ schemaVersion: 1, ok: true, result: { instance: "ingester-a", agent: "ingester", home: "/sbx/agents/ingester/instances/ingester-a", launched: false, warnings: [], decision: { instance: "ingester-a", revision: D }, replayed: false, capabilityMeta: { "fixture.seat": { seat: "seat" } } } });
      return JSON.stringify(answer);
    }
    throw new Error(`unexpected remote call: ${command}`);
  };
  return { calls, io: { execFileSync } };
}

/** The fixture, synced, with server sandbox-ingest registered, and a runner of the kernel's routed spawn. */
async function routed(t) {
  const fx = sandboxDeployment({ t });
  const r = fx.cliS(["sync", "--json"]);
  assert.equal(r.status, 0, r.stdout);
  mkdirSync(fx.env.OATS_HOME_DIR, { recursive: true });
  writeFileSync(join(fx.env.OATS_HOME_DIR, "servers.json"), JSON.stringify({ schemaVersion: 1, servers: { "sandbox-ingest": { sshHost: "sandbox-ingest", workspace: "/sbx" } } }));
  fx.pendingDir = join(fx.env.OATS_HOME_DIR, "remote", "sandbox-ingest", "pending");
  fx.sandboxEnv = { ...fx.sandbox.env, FAKE_SANDBOX_PENDING: fx.pendingDir };
  /** `fn(sb, ctx)` in the fixture's environment with the fake's, the kernel's sandbox context built as the CLI builds it. */
  fx.withKernel = (fn) => fx.inEnv(async () => {
    Object.assign(process.env, fx.sandboxEnv);
    const sb = await import("../lib/sandboxes.mjs");
    const { discoverOrStandalone } = await import("../lib/member-clone.mjs");
    const { loadLocal } = await import("../lib/workspace.mjs");
    const { readLock } = await import("../lib/packages.mjs");
    const { local } = loadLocal(fx.dep);
    const discovery = await discoverOrStandalone(local, { deployment: fx.dep, remoteOptions: fx.remoteOptions });
    const ctx = sb.sandboxContext({ deploymentDir: fx.dep, local, discovery, lock: readLock(fx.dep), catalog: null, remoteOptions: fx.remoteOptions });
    return fn(sb, ctx);
  });
  fx.spawnInto = (host, { task = `Ingest the feed.\n${SENTINEL}\n`, args = ["ingester", "--purpose", "a", "--no-launch"] } = {}) =>
    fx.withKernel((sb, ctx) => sb.routedSandboxSpawn(ctx, "ingest", { soul: "ingester", args, task, io: host.io }));
  fx.kept = () => (existsSync(fx.pendingDir) ? readdirSync(fx.pendingDir) : []);
  fx.sandbox.reset();
  return fx;
}
const acts = (fx) => fx.sandbox.calls().map((c) => (c.act === "plan" ? `plan:${c.request.target}` : c.act));

test("steps 1–6: plan(seat), the preview with the seat's options, the kept request, seat, the bound and keyed apply, bind; the request goes once the seat is active", async (t) => {
  const fx = await routed(t);
  const host = fakeHost(fx);
  const out = await fx.spawnInto(host);
  assert.equal(out.envelope.ok, true, JSON.stringify(out.envelope));
  assert.deepEqual(acts(fx), ["status", "plan:seat", "seat", "plan:bind", "bind"]);
  const [preview, apply] = host.calls.filter((c) => c.command.includes(" spawn "));
  assert.equal(preview.preview, true);
  assert.equal(preview.provider, 2, "the preview runs after plan(seat), before seat");
  assert.equal(apply.preview, false);
  assert.equal(apply.provider, 3, "the apply runs after seat, before bind");
  const calls = fx.sandbox.calls();
  const spawnKey = calls[1].request.instance.spawnKey;
  assert.match(spawnKey, /^[0-9a-f-]{36}$/);
  const seatPath = `/srv/seats/seat-${spawnKey.slice(0, 8)}`;
  for (const c of [preview, apply]) assert.ok(c.command.includes(`--provider fixture.seat identity.seat=${seatPath}`), `the seat's options as --provider flags: ${c.command}`);
  assert.ok(apply.command.includes(`--expect-decision ${D} --idempotency-key ${spawnKey}`), apply.command);
  assert.deepEqual(calls[2].request.instance, { name: "ingester-a", soul: "ingester", spawnKey, decision: D });
  assert.equal(calls[2].request.idempotencyKey, spawnKey, "the seat is keyed by the spawn key");
  assert.deepEqual(calls[2].pending, [`${spawnKey}.json`], "the kept request exists before seat");
  assert.deepEqual(calls[1].pending, [], "and not before the preview decided");
  assert.deepEqual(fx.kept(), [], "gone once bind answered active");
  assert.equal(out.envelope.result.server, "sandbox-ingest");
});

test("the kept request's custody: 0600, the task in no receipt, log, event or readiness line, and stale after 24 hours by its spawn key", async (t) => {
  const fx = await routed(t);
  const host = fakeHost(fx, { apply: "no-answer" });
  fx.sandbox.set({ bind: { state: "ready", seat: { id: "s", certificateId: "c", state: "delivered" } } });
  await assert.rejects(fx.spawnInto(host), (e) => e.code === "E_SSH");
  const [file] = fx.kept();
  assert.ok(file, "the request is kept: no answer came back");
  const path = join(fx.pendingDir, file);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(fx.pendingDir).mode & 0o777, 0o700);
  assert.ok(readFileSync(path, "utf8").includes(SENTINEL), "the kept request holds the task, to replay it");
  for (const c of host.calls.filter((x) => x.command.includes(" spawn "))) assert.equal(c.command.includes(SENTINEL), false, "the task is on no command line");
  // Everywhere else the kernel writes: the deployment, the provider's record, OATS's home except the kept file.
  const leaks = [];
  const walk = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) { if (!p.endsWith("/.git") && !p.includes("/remotes/") && !p.includes("/cache")) walk(p); } else if (p !== path && e.isFile() && statSync(p).size < 4 * 1024 * 1024 && readFileSync(p, "utf8").includes(SENTINEL)) leaks.push(p); } };
  walk(fx.base);
  assert.deepEqual(leaks, [], "the task is nowhere else");
  const spawnKey = file.slice(0, -5);
  const later = fx.cliS(["readiness", "--soul", "dev", "--json"], { OATS_TEST_NOW_MS: String(Date.now() + 25 * 60 * 60 * 1000), FAKE_SANDBOX_PENDING: fx.pendingDir });
  assert.equal(later.status, 0);
  assert.equal(later.stdout.includes(SENTINEL), false, "readiness never shows the task");
  const item = later.json().result.checks.configured.items.find((i) => i.code === "sandbox-pending-stale");
  assert.ok(item, later.stdout);
  assert.ok(item.subject.includes(spawnKey) && item.reason.includes(spawnKey), "named by its spawn key");
  const now = fx.cliS(["readiness", "--soul", "dev", "--json"]).json().result.checks.configured.items;
  assert.equal(now.some((i) => i.code === "sandbox-pending-stale"), false, "not before 24 hours");
});

const success = (extra = {}) => ({ schemaVersion: 1, ok: true, result: { instance: "ingester-a", agent: "ingester", home: "/sbx/agents/ingester/instances/ingester-a", launched: false, warnings: [], decision: { instance: "ingester-a", revision: D }, replayed: false, capabilityMeta: { "fixture.seat": { seat: "seat-1" } }, ...extra } });
const refusal = (code, details) => ({ schemaVersion: 1, ok: false, error: { code, message: `${code} on the host`, ...(details ? { details } : {}) } });
const CASES = [
  { what: "success with capabilityMeta", apply: success(), bind: "active", kept: false },
  { what: "the keyed replay's answer with capabilityMeta", apply: success({ replayed: true }), bind: "active", kept: false },
  { what: "E_DECISION_STALE", apply: refusal("E_DECISION_STALE"), bind: "delivered", kept: false },
  { what: "E_IDEMPOTENCY_CONFLICT", apply: refusal("E_IDEMPOTENCY_CONFLICT"), bind: "delivered", kept: true },
  { what: "E_REQUIRED_HOOK_FAILED, rollback confirmed", apply: refusal("E_REQUIRED_HOOK_FAILED", { capability: "fixture.seat" }), bind: "delivered", kept: false },
  { what: "E_REQUIRED_HOOK_FAILED with details.unconfirmed", apply: refusal("E_REQUIRED_HOOK_FAILED", { capability: "fixture.seat", unconfirmed: true }), bind: "delivered", kept: true },
  { what: "E_SPAWN_INCOMPLETE", apply: refusal("E_SPAWN_INCOMPLETE", { launchPrompts: { status: "blocked" } }), bind: "delivered", kept: true },
  { what: "no answer", apply: "no-answer", bind: "delivered", kept: true },
];
for (const c of CASES) {
  test(`step 6: bind receives the routed answer unchanged — ${c.what}; the kept request ${c.kept ? "stays" : "goes"}`, async (t) => {
    const fx = await routed(t);
    fx.sandbox.set({ bind: { state: "ready", seat: { id: "s", certificateId: "c", state: c.bind } } });
    const host = fakeHost(fx, { apply: c.apply });
    try { await fx.spawnInto(host); } catch (e) { assert.equal(c.apply, "no-answer", `only a missing answer throws: ${e.message}`); }
    const bind = fx.sandbox.calls().find((x) => x.act === "bind");
    assert.ok(bind, "bind ran");
    assert.deepEqual(bind.request.apply, c.apply === "no-answer" ? null : c.apply, "the answer as the host gave it");
    assert.equal(fx.kept().length, c.kept ? 1 : 0);
  });
}

test("step 7, the replay fence: reconcile first; minting and mint-uncertain get no apply; released is deleted; delivered is replayed unchanged, with its key", async (t) => {
  const fx = await routed(t);
  fx.sandbox.set({ bind: { state: "ready", seat: { id: "s", certificateId: "c", state: "delivered" } } });
  const keys = [];
  for (const purpose of ["m", "u", "r", "d"]) {
    const host = fakeHost(fx, { apply: "no-answer" });
    await assert.rejects(fx.spawnInto(host, { args: ["ingester", "--purpose", purpose, "--no-launch"] }));
    keys.push(fx.sandbox.calls().filter((x) => x.act === "plan" && x.request.target === "seat").at(-1).request.instance.spawnKey);
  }
  assert.equal(fx.kept().length, 4);
  const seat = (k) => `seat-${k.slice(0, 8)}`;
  const [minting, uncertain, released, delivered] = keys;
  fx.sandbox.set({ reconcile: { state: "ready", server: "sandbox-ingest", seats: [
    { seatId: seat(minting), state: "minting" }, { seatId: seat(uncertain), state: "mint-uncertain" },
    { seatId: seat(released), state: "released" }, { seatId: seat(delivered), state: "delivered" },
  ] } });
  const firstApply = (await import("node:fs")).readFileSync(join(fx.pendingDir, `${delivered}.json`), "utf8");
  fx.sandbox.reset();
  const host = fakeHost(fx);
  const answer = await fx.withKernel((sb, ctx) => sb.reconcileSandbox(ctx, "ingest", { planRevision: "rev-reconcile", idempotencyKey: "rk", io: host.io }));
  const order = acts(fx);
  assert.equal(order[0], "reconcile", "reconcile runs before any replay");
  const applies = host.calls.filter((x) => x.command.includes(" spawn "));
  assert.equal(applies.length, 1, "only the delivered seat is replayed");
  assert.ok(applies[0].command.includes(`--idempotency-key ${delivered}`), applies[0].command);
  assert.ok(applies[0].command.includes(`--expect-decision ${D}`));
  assert.equal(applies[0].input, JSON.parse(firstApply).task, "the same task, on stdin");
  assert.ok(applies[0].provider >= 1, "after the reconcile act");
  assert.deepEqual(answer.replays.map((r) => r.outcome).sort(), ["deleted-released", "held-mint-uncertain", "held-minting", "replayed"]);
  assert.deepEqual(fx.kept().sort(), [`${minting}.json`, `${uncertain}.json`].sort(), "released and the replayed active one are gone");
});

test("step 7 in sync: the seat pass reconciles before it replays", async (t) => {
  const fx = await routed(t);
  fx.sandbox.set({ bind: { state: "ready", seat: { id: "s", certificateId: "c", state: "delivered" } } });
  await assert.rejects(fx.spawnInto(fakeHost(fx, { apply: "no-answer" })));
  const key = fx.sandbox.calls().find((x) => x.act === "plan" && x.request.target === "seat").request.instance.spawnKey;
  fx.sandbox.set({ reconcile: { state: "ready", server: "sandbox-ingest", seats: [{ seatId: `seat-${key.slice(0, 8)}`, state: "delivered" }] } });
  fx.sandbox.reset();
  const host = fakeHost(fx);
  const pass = await fx.withKernel((sb, ctx) => sb.syncSandboxes(ctx, { io: host.io }));
  assert.deepEqual(pass.problems, []);
  const order = acts(fx);
  assert.ok(order.indexOf("reconcile") >= 0 && order.indexOf("reconcile") < order.indexOf("bind"), order.join(" "));
  const [apply] = host.calls.filter((x) => x.command.includes(" spawn "));
  assert.ok(apply.provider > order.indexOf("reconcile"), "the replay is sent after reconcile answered");
  assert.deepEqual(fx.kept(), []);
});

test("a sandbox whose kernel does not advertise the routed floor is refused before anything is sent", async (t) => {
  const fx = await routed(t);
  const host = fakeHost(fx, { features: FEATURES.filter((f) => f !== "spawn-idempotency-2") });
  await assert.rejects(fx.spawnInto(host), (e) => e.code === "E_REMOTE_INCOMPATIBLE" && e.details.missing.includes("spawn-idempotency-2"));
  assert.deepEqual(acts(fx), ["status"]);
  assert.deepEqual(fx.kept(), []);
});

test("a listed sandbox its provider does not answer ready is E_SANDBOX_NOT_HERE not-running; a team with no id is E_SANDBOX_TEAM", async (t) => {
  const fx = await routed(t);
  fx.sandbox.set({ status: { state: "stopped", server: "sandbox-ingest" } });
  await assert.rejects(fx.spawnInto(fakeHost(fx)), (e) => e.code === "E_SANDBOX_NOT_HERE" && e.details.reason === "not-running");
  fx.commitWorkspace(fx.workspace({ teams: { global: { description: "Fixture team" }, "ingest-team": {} } }));
  await assert.rejects(fx.spawnInto(fakeHost(fx)), (e) => e.code === "E_SANDBOX_TEAM" && e.details.reason === "team-not-created");
});
