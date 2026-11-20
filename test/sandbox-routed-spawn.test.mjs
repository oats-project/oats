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
  fx.sandbox.set({ status: { state: "stopped", server: "sandbox-ingest", seats: [] } });
  await assert.rejects(fx.spawnInto(fakeHost(fx)), (e) => e.code === "E_SANDBOX_NOT_HERE" && e.details.reason === "not-running");
  fx.commitWorkspace(fx.workspace({ teams: { global: { description: "Fixture team" }, "ingest-team": {} } }));
  await assert.rejects(fx.spawnInto(fakeHost(fx)), (e) => e.code === "E_SANDBOX_TEAM" && e.details.reason === "team-not-created");
});

// D-S1-4: a spawn into a sandbox is bound and keyed by the kernel (steps 1–5); a caller's own
// `--expect-decision` or `--idempotency-key` is refused before any provider act, kept file or seat.
test("D-S1-4: a caller-bound apply, with a key, without one, or a key alone, is E_SANDBOX_PLACEMENT caller-bound; nothing is minted or kept; the unbound spawn goes through", async (t) => {
  const fx = await routed(t);
  const base = ["ingester", "--purpose", "a", "--no-launch"];
  for (const [what, extra] of [
    ["bound with a key", ["--expect-decision", D, "--idempotency-key", "caller-key"]],
    ["bound without a key", ["--expect-decision", D]],
    ["a key alone", ["--idempotency-key", "caller-key"]],
  ]) {
    const host = fakeHost(fx);
    await assert.rejects(fx.spawnInto(host, { args: [...base, ...extra] }), (e) => {
      assert.equal(e.code, "E_SANDBOX_PLACEMENT", `${what}: ${e.message}`);
      assert.equal(e.details.reason, "caller-bound", what);
      assert.equal(e.details.sandbox, "ingest", what);
      assert.equal(e.details.remedy, "Spawn it with `oats spawn ingester` (OATS binds it to the sandbox itself) or from a schedule; the Desktop can't spawn into a sandbox yet.", what);
      assert.ok(e.message.endsWith(e.details.remedy), `${what}: the message carries the remedy`);
      return true;
    });
    assert.deepEqual(acts(fx), [], `${what}: no provider act (no status, plan, seat)`);
    assert.deepEqual(host.calls, [], `${what}: nothing is sent to the sandbox`);
    assert.deepEqual(fx.kept(), [], `${what}: nothing is kept`);
  }
  // The same soul, unbound: the kernel binds and keys it, with one flag pair, its own.
  const host = fakeHost(fx);
  const out = await fx.spawnInto(host, { args: base });
  assert.equal(out.envelope.ok, true, JSON.stringify(out.envelope));
  assert.deepEqual(acts(fx), ["status", "plan:seat", "seat", "plan:bind", "bind"]);
  const apply = host.calls.find((c) => !c.preview);
  const spawnKey = fx.sandbox.calls()[1].request.instance.spawnKey;
  assert.equal(apply.command.split("--expect-decision").length, 2, apply.command);
  assert.equal(apply.command.split("--idempotency-key").length, 2, apply.command);
  assert.ok(apply.command.includes(`--expect-decision ${D} --idempotency-key ${spawnKey}`), apply.command);
});

/** A fake `ssh` on PATH that answers as a sandbox's kernel would (the probe, the roster, the preview, the
 *  apply), logging each remote command, for a test that runs the real CLI end to end. */
function sshAsSandboxKernel(dir) {
  const bin = join(dir, "ssh-bin");
  mkdirSync(bin, { recursive: true });
  const log = join(dir, "ssh-commands.log");
  const probe = { schemaVersion: 1, name: "@awebai/oats", version: "0.70.0", desktopApi: 1, harnesses: ["pi"], sessionBackends: ["tmux"], launchOptions: [], remote: ["spawn", "status", "retire"], features: FEATURES };
  const status = { schemaVersion: 1, ok: true, result: { root: "/sbx/agents", agents: [{ name: "ingester", harness: "pi", instances: [] }] } };
  const preview = { schemaVersion: 1, ok: true, result: { spawnPreviewApi: 2, preview: true, agent: "ingester", instance: "ingester-a", home: "/sbx/agents/ingester/instances/ingester-a", decision: { instance: "ingester-a", revision: D } } };
  const applied = { schemaVersion: 1, ok: true, result: { instance: "ingester-a", agent: "ingester", home: "/sbx/agents/ingester/instances/ingester-a", launched: false, warnings: [], decision: { instance: "ingester-a", revision: D }, replayed: false, capabilityMeta: { "fixture.seat": { seat: "seat" } } } };
  writeFileSync(join(bin, "ssh"), `#!${process.execPath}
const fs = require("node:fs");
const command = String(process.argv.at(-1));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(command) + "\\n");
const answer = command.includes("version --json") ? ${JSON.stringify(probe)}
  : command.includes(" status ") ? ${JSON.stringify(status)}
  : command.includes(" spawn ") ? (command.includes("--preview") ? ${JSON.stringify(preview)} : ${JSON.stringify(applied)})
  : null;
if (!answer) { process.stderr.write("unexpected remote call\\n"); process.exit(255); }
process.stdin.resume(); process.stdin.on("end", () => { process.stdout.write(JSON.stringify(answer)); });
`, { mode: 0o755 });
  return { PATH: `${bin}:${process.env.PATH}`, commands: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []) };
}

test("D-S1-4: a schedule tick of a sandboxed soul takes the unbound path: the kernel binds and keys it, through the seven steps", async (t) => {
  // The schedule is added while ingester runs on the host (a deployment that lists no sandbox); then the
  // workspace places it in the sandbox, and this deployment lists it.
  const fx = sandboxDeployment({ t, workspace: { souls: { "ws/ingester": {} } } });
  fx.writeLocal({ host: { name: "cloud-1" } });
  assert.equal(fx.cliS(["sync", "--json"]).status, 0);
  const add = fx.cliS(["schedule", "add", "ingest-daily", "--spec-json", JSON.stringify({ kind: "spawn", cron: "0 6 * * *", tz: "UTC", agent: "ingester", task: `Ingest.\n${SENTINEL}` }), "--json"]);
  assert.equal(add.status, 0, add.stdout);
  fx.commitWorkspace(fx.workspace({ souls: { "ws/ingester": { default: "ingest-team" } } }));
  fx.writeLocal({ host: { name: "cloud-1" }, sandboxes: ["ingest"], credentials: { "sources-read": { fromFile: fx.credential } } });
  assert.equal(fx.cliS(["sync", "--json"]).status, 0);
  mkdirSync(fx.env.OATS_HOME_DIR, { recursive: true });
  writeFileSync(join(fx.env.OATS_HOME_DIR, "servers.json"), JSON.stringify({ schemaVersion: 1, servers: { "sandbox-ingest": { sshHost: "sandbox-ingest", workspace: "/sbx" } } }));
  const ssh = sshAsSandboxKernel(fx.base);
  fx.sandbox.reset();
  const run = fx.cliS(["schedule", "run", "ingest-daily", "--json"], { PATH: ssh.PATH });
  assert.equal(run.stdout.includes("caller-bound"), false, run.stdout);
  assert.equal(run.status, 0, run.stdout);
  assert.deepEqual(acts(fx), ["status", "plan:seat", "seat", "plan:bind", "bind"]);
  const spawns = ssh.commands().filter((c) => c.includes(" spawn "));
  assert.equal(spawns.length, 2, spawns.join("\n"));
  const spawnKey = fx.sandbox.calls()[1].request.instance.spawnKey;
  assert.ok(spawns[0].includes("--preview"), spawns[0]);
  assert.ok(spawns[1].includes(`--expect-decision ${D} --idempotency-key ${spawnKey}`), spawns[1]);
  assert.equal(spawns[1].split("--expect-decision").length, 2, "one decision, the kernel's own");
  for (const c of spawns) assert.equal(c.includes(SENTINEL), false, "the task is on no command line");
});

/** A kept request left by a spawn whose apply came back with no answer; → its spawn key and seat ID. */
async function keptByLostAnswer(fx) {
  fx.sandbox.set({ bind: { state: "ready", seat: { id: "s", certificateId: "c", state: "delivered" } } });
  await assert.rejects(fx.spawnInto(fakeHost(fx, { apply: "no-answer" })), (e) => e.code === "E_SSH");
  const spawnKey = fx.sandbox.calls().find((x) => x.act === "plan" && x.request.target === "seat").request.instance.spawnKey;
  assert.deepEqual(fx.kept(), [`${spawnKey}.json`]);
  fx.sandbox.reset();
  return { spawnKey, seatId: `seat-${spawnKey.slice(0, 8)}` };
}
const readinessItems = (fx) => {
  const r = fx.cliS(["readiness", "--soul", "dev", "--json"], { FAKE_SANDBOX_PENDING: fx.pendingDir });
  assert.equal(r.status, 0, r.stdout);
  return r.json().result.checks.configured.items.filter((i) => i.producer === "sandboxes");
};

test("an explicit reconcile of a sandbox this host no longer lists replays nothing, even for a delivered seat: held-unlisted", async (t) => {
  const fx = await routed(t);
  const { spawnKey, seatId } = await keptByLostAnswer(fx);
  fx.sandbox.set({ reconcile: { state: "ready", server: "sandbox-ingest", seats: [{ seatId, state: "delivered" }] } });
  // Delisted here; the workspace still declares it.
  fx.writeLocal({ host: { name: "cloud-1" } });
  const host = fakeHost(fx);
  const answer = await fx.withKernel((sb, ctx) => sb.reconcileSandbox(ctx, "ingest", { planRevision: "r", idempotencyKey: "k", io: host.io }));
  assert.deepEqual(answer.replays, [{ spawnKey, instance: "ingester-a", seat: seatId, outcome: "held-unlisted" }]);
  assert.deepEqual(host.calls, [], "no apply is sent");
  assert.deepEqual(acts(fx), ["reconcile"], "the provider settles first; no bind");
  assert.deepEqual(fx.kept(), [`${spawnKey}.json`], "kept, and reported");
  const items = readinessItems(fx);
  assert.ok(items.some((i) => i.code === "sandbox-seat-unsettled" && i.evidence.spawnKey === spawnKey && i.reason.includes("no longer lists")), JSON.stringify(items));
});

test("readiness reports a kept request whose seat the ledger does not hold, and one whose sandbox is declared and listed nowhere; never its task", async (t) => {
  const fx = await routed(t);
  const { spawnKey } = await keptByLostAnswer(fx);
  // Listed, ready, and a ledger with no entry for the kept seat.
  fx.sandbox.set({ status: { state: "ready", server: "sandbox-ingest", seats: [] } });
  let items = readinessItems(fx);
  const orphan = items.find((i) => i.code === "sandbox-seat-unsettled" && i.evidence.spawnKey === spawnKey);
  assert.ok(orphan && orphan.reason.includes("no entry"), JSON.stringify(items));
  // The sandbox removed from the workspace and from this deployment's local file: still reported.
  fx.commitWorkspace(fx.workspace({ sandboxes: undefined }));
  fx.writeLocal({ host: { name: "cloud-1" } });
  const r = fx.cliS(["readiness", "--soul", "dev", "--json"], { FAKE_SANDBOX_PENDING: fx.pendingDir });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.stdout.includes(SENTINEL), false, "readiness never shows the task");
  items = r.json().result.checks.configured.items.filter((i) => i.producer === "sandboxes");
  assert.ok(items.some((i) => i.code === "sandbox-seat-unsettled" && i.evidence.spawnKey === spawnKey), JSON.stringify(items));
  // Older than 24 hours: stale too.
  const later = fx.cliS(["readiness", "--soul", "dev", "--json"], { OATS_TEST_NOW_MS: String(Date.now() + 25 * 60 * 60 * 1000), FAKE_SANDBOX_PENDING: fx.pendingDir });
  assert.ok(later.json().result.checks.configured.items.some((i) => i.code === "sandbox-pending-stale" && i.evidence.spawnKey === spawnKey), later.stdout);
  assert.deepEqual(fx.kept(), [`${spawnKey}.json`], "never discarded");
});

test("a self-retire inside the sandbox, then an otherwise no-op sync: the sync still calls reconcile, which reports the seat released; nothing starts, stops or is replayed", async (t) => {
  // The record's pinned test, kernel side: a home that retires itself inside the sandbox tells the host
  // nothing; the host's next sync, with nothing else to do, still asks the provider to reconcile.
  const fx = await routed(t);
  const out = await fx.spawnInto(fakeHost(fx));
  assert.equal(out.envelope.ok, true);
  const spawnKey = fx.sandbox.calls().find((x) => x.act === "plan" && x.request.target === "seat").request.instance.spawnKey;
  const seatId = `seat-${spawnKey.slice(0, 8)}`;
  assert.deepEqual(fx.kept(), [], "the seat went active: nothing kept");
  // Inside the sandbox, ingester-a retires itself: the provider's ledger shows its seat released.
  fx.sandbox.set({ reconcile: { state: "ready", server: "sandbox-ingest", seats: [{ seatId, instance: "ingester-a", state: "released" }] } });
  fx.sandbox.reset();
  const host = fakeHost(fx);
  const pass = await fx.withKernel((sb, ctx) => sb.syncSandboxes(ctx, { io: host.io }));
  assert.deepEqual(pass.problems, []);
  assert.equal(pass.sandboxes[0].action, "none", "nothing else to do");
  assert.deepEqual(acts(fx), ["status", "plan:start", "plan:reconcile", "reconcile"], "no start or stop; reconcile is still called");
  assert.deepEqual(host.calls, [], "no replay is sent");
  assert.deepEqual(pass.sandboxes[0].seats.map((s) => [s.seatId, s.state]), [[seatId, "released"]]);
});

test("a replay re-checks the sandbox's routed floor on the probe that sends it: a kernel rebuilt without spawn-task-stdin gets nothing, the task never on a command line; the request stays kept", async (t) => {
  const fx = await routed(t);
  const { spawnKey, seatId } = await keptByLostAnswer(fx);
  fx.sandbox.set({ reconcile: { state: "ready", server: "sandbox-ingest", seats: [{ seatId, state: "delivered" }] } });
  const host = fakeHost(fx, { features: FEATURES.filter((f) => f !== "spawn-task-stdin") });
  const commands = [];
  const io = { execFileSync: (bin, argv, options) => { commands.push(String(argv.at(-1))); return host.io.execFileSync(bin, argv, options); } };
  const answer = await fx.withKernel((sb, ctx) => sb.reconcileSandbox(ctx, "ingest", { planRevision: "r", idempotencyKey: "k", io }));
  assert.deepEqual(answer.replays.map((r) => [r.spawnKey, r.outcome, r.apply]), [[spawnKey, "held-unsent", "E_REMOTE_INCOMPATIBLE"]]);
  assert.ok(answer.problems.some((p) => p.code === "E_REMOTE_INCOMPATIBLE" && p.sandbox === "ingest"), JSON.stringify(answer.problems));
  assert.deepEqual(host.calls, [], "no spawn was sent");
  assert.equal(commands.some((c) => c.includes(SENTINEL)), false, "the task is on no command line");
  assert.deepEqual(acts(fx), ["reconcile"], "nothing reaches bind: nothing happened there");
  assert.deepEqual(fx.kept(), [`${spawnKey}.json`]);
  const kept = JSON.parse(readFileSync(join(fx.pendingDir, `${spawnKey}.json`), "utf8"));
  assert.deepEqual([kept.lastApply.code, kept.lastApply.sent], ["E_REMOTE_INCOMPATIBLE", false]);
});

test("a stale bind is E_PLAN_STALE with its fresh plan, saying the apply already ran; the request stays kept, and a replay's stale bind is reported the same way", async (t) => {
  const fx = await routed(t);
  const fresh = { planRevision: "fresh-bind", actions: [] };
  fx.sandbox.set({ bind: { state: "stale", plan: fresh } });
  await assert.rejects(fx.spawnInto(fakeHost(fx)), (e) => {
    assert.equal(e.code, "E_PLAN_STALE", e.message);
    assert.equal(e.details.act, "bind");
    assert.deepEqual(e.details.plan, fresh);
    assert.equal(e.details.applied, true);
    assert.match(e.message, /was applied in the sandbox/);
    return true;
  });
  const spawnKey = fx.sandbox.calls().find((x) => x.act === "plan" && x.request.target === "seat").request.instance.spawnKey;
  assert.deepEqual(fx.kept(), [`${spawnKey}.json`], "kept: the next reconcile binds it");
  // The replay meets a stale bind too.
  fx.sandbox.set({ bind: { state: "stale", plan: fresh }, reconcile: { state: "ready", server: "sandbox-ingest", seats: [{ seatId: `seat-${spawnKey.slice(0, 8)}`, state: "delivered" }] } });
  fx.sandbox.reset();
  const answer = await fx.withKernel((sb, ctx) => sb.reconcileSandbox(ctx, "ingest", { planRevision: "r", idempotencyKey: "k", io: fakeHost(fx).io }));
  assert.deepEqual([answer.replays[0].outcome, answer.replays[0].bound], ["replayed", "stale"]);
  assert.deepEqual(answer.replays[0].plan, fresh);
  assert.ok(answer.problems.some((p) => p.code === "E_PLAN_STALE" && p.sandbox === "ingest"), JSON.stringify(answer.problems));
  assert.deepEqual(fx.kept(), [`${spawnKey}.json`]);
});

test("a bind that fails, or whose plan fails, in sync's seat pass is a failure of that sandbox: in its entry and in problems; the request stays kept; a first spawn whose bind fails says so", async (t) => {
  const fx = await routed(t);
  const { spawnKey, seatId } = await keptByLostAnswer(fx);
  for (const [what, table] of [
    ["the bind hook exits 3", { bind: { $exit: 3 } }],
    ["the bind plan answers failed", { "plan:bind": { state: "failed", problem: { code: "E_SANDBOX_PROVIDER", reason: "ledger-locked", message: "the ledger is locked" } } }],
  ]) {
    fx.sandbox.set({ ...table, reconcile: { state: "ready", server: "sandbox-ingest", seats: [{ seatId, state: "delivered" }] } });
    fx.sandbox.reset();
    const pass = await fx.withKernel((sb, ctx) => sb.syncSandboxes(ctx, { io: fakeHost(fx).io }));
    assert.equal(pass.failed, true, what);
    const p = pass.problems.find((x) => x.sandbox === "ingest" && /the bind of ingester-a's seat answered (failed|unknown)/.test(x.message));
    assert.ok(p, `${what}: ${JSON.stringify(pass.problems)}`);
    assert.ok(pass.sandboxes[0].problems.some((x) => x.code === p.code), `${what}: in the entry too`);
    assert.deepEqual(fx.kept(), [`${spawnKey}.json`], `${what}: kept`);
  }
  // A first spawn whose apply succeeds and whose bind fails: the apply's answer, with a warning that says so.
  const second = await routed(t);
  second.sandbox.set({ bind: { $exit: 3 } });
  const out = await second.spawnInto(fakeHost(second));
  assert.equal(out.envelope.ok, true);
  assert.ok(out.envelope.result.warnings.some((w) => /the bind of ingester-a's seat answered unknown/.test(w)), JSON.stringify(out.envelope.result.warnings));
  assert.equal(second.kept().length, 1, "kept for the next reconcile");
});

test("the CLI's answer to a caller-bound spawn into a sandbox carries its reason and its remedy (the client's reader passes them on)", async (t) => {
  const fx = await routed(t);
  const r = fx.cliS(["spawn", "ingester", "--purpose", "a", "--expect-decision", D, "--idempotency-key", "caller-key", "--no-launch", "--json"]);
  assert.notEqual(r.status, 0);
  const error = r.json().error;
  assert.equal(error.code, "E_SANDBOX_PLACEMENT", JSON.stringify(error));
  assert.equal(error.details.reason, "caller-bound");
  assert.equal(error.details.remedy, "Spawn it with `oats spawn ingester` (OATS binds it to the sandbox itself) or from a schedule; the Desktop can't spawn into a sandbox yet.");
  assert.ok(error.message.endsWith(error.details.remedy));
  assert.deepEqual(acts(fx), [], "no provider act");
  assert.deepEqual(fx.kept(), []);
  // The client's confirmed-spawn reader (packages/client/spawn-apply-cli.mjs, #2021), given this kernel's
  // answer as it printed it: the code, the message, the reason and the remedy cross, nothing else.
  const { cliSpawnApply } = await import("../packages/client/spawn-apply-cli.mjs");
  const { cli, target, data } = await import("../packages/desktop/test/helpers/spawn-preview-fixture.mjs");
  const capable = { ...structuredClone(cli), spawnApplyApi: 1, features: [...cli.features, "spawn-apply-2", "spawn-idempotency-2"] };
  const read = await cliSpawnApply(capable, { target: structuredClone(target), choices: {}, decision: data().decision, key: "a".repeat(64), task: "Ingest the feed." },
    { env: { PATH: "/inert/bin", HOME: "/inert/home" }, exec: (_bin, _argv, _options, done) => done({ code: r.status }, r.stdout) });
  assert.deepEqual(read.envelope.error, { code: "E_SANDBOX_PLACEMENT", message: error.message, details: { reason: "caller-bound", remedy: error.details.remedy } });
});

test("C4: a settled answer without one of its act's seat fields is unknown, hook-failed; a seat plan without seat.path too", async (t) => {
  const fx = await routed(t);
  const seat = { id: "s", path: "/srv/seats/s", alias: "ingester-a", certificateId: "c", team: "ingest:example.org" };
  const bound = { id: "s", certificateId: "c", state: "active" };
  const instance = { name: "ingester-a", soul: "ingester", spawnKey: "k", decision: D };
  const without = (o, f) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== f));
  const cases = [
    ...Object.keys(seat).map((f) => ["seat", { state: "ready", seat: without(seat, f) }, { planRevision: "r", idempotencyKey: "k", instance }, f]),
    ...Object.keys(bound).map((f) => ["bind", { state: "ready", seat: without(bound, f) }, { planRevision: "r", idempotencyKey: "k", instance: { name: "ingester-a", spawnKey: "k" }, apply: null }, f]),
    ...Object.keys(bound).map((f) => ["release", { state: "ready", seat: without({ ...bound, state: "released" }, f) }, { planRevision: "r", idempotencyKey: "k", instance: { name: "ingester-a", seatId: "s" }, reason: "retired" }, f]),
    ["plan", { state: "ready", planRevision: "r", actions: [], seat: { id: "s" }, spawnProvider: { capability: "fixture.seat", options: {} } }, { target: "seat", instance: { soul: "ingester", spawnKey: "k" } }, "path"],
  ];
  for (const [act, answer, extra, missing] of cases) {
    fx.sandbox.set({ [act === "plan" ? "plan:seat" : act]: answer });
    const got = await fx.withKernel(async (sb, ctx) => sb.sandboxAct(ctx, await sb.sandboxProvider(ctx), "ingest", act, extra));
    assert.equal(got.state, "unknown", `${act} without ${missing}: ${JSON.stringify(got)}`);
    assert.equal(got.problem?.reason, "hook-failed", `${act} without ${missing}`);
    assert.match(got.problem.message, /without seat/, `${act} without ${missing}`);
  }
  // Every field present: the answer stands.
  fx.sandbox.set({ seat: { state: "ready", seat } });
  const whole = await fx.withKernel(async (sb, ctx) => sb.sandboxAct(ctx, await sb.sandboxProvider(ctx), "ingest", "seat", { planRevision: "r", idempotencyKey: "k", instance }));
  assert.equal(whole.state, "ready", JSON.stringify(whole));
});

test("a caller's own identity.seat never reaches the sandbox: its spawn, the seat acts and the kept request name only the host's seat", async (t) => {
  const fx = await routed(t);
  const host = fakeHost(fx);
  fx.sandbox.set({ bind: { state: "ready", seat: { id: "s", certificateId: "c", state: "delivered" } } });
  const out = await fx.spawnInto(host, { args: ["ingester", "--purpose", "a", "--provider", "fixture.seat", "identity.seat=/caller/seat/", "--no-launch"] });
  assert.equal(out.envelope.ok, true, JSON.stringify(out.envelope));
  const spawnKey = fx.sandbox.calls()[1].request.instance.spawnKey;
  const seatPath = `/srv/seats/seat-${spawnKey.slice(0, 8)}`;
  const spawns = host.calls.filter((c) => c.command.includes(" spawn "));
  assert.equal(spawns.length, 2);
  for (const c of spawns) {
    assert.ok(c.command.includes(`--provider fixture.seat identity.seat=${seatPath}`), c.command);
    assert.doesNotMatch(c.command, /\/caller\/seat/, c.command);
  }
  assert.doesNotMatch(JSON.stringify(fx.sandbox.calls()), /\/caller\/seat/, "no seat act sees it");
  const [kept] = fx.kept();
  assert.ok(kept, "the bind answered delivered: the request is kept");
  const record = JSON.parse(readFileSync(join(fx.pendingDir, kept), "utf8"));
  assert.doesNotMatch(JSON.stringify(record.argv), /\/caller\/seat/);
  assert.ok(record.argv.includes(`identity.seat=${seatPath}`), JSON.stringify(record.argv));
});

test("C4: with a request kept, a reconcile that leaves out its seats is no empty ledger: sync reports the sandbox failed, keeps the request and replays nothing", async (t) => {
  const fx = await routed(t);
  const { spawnKey } = await keptByLostAnswer(fx);
  fx.sandbox.set({ reconcile: { state: "ready", server: "sandbox-ingest" } });
  fx.sandbox.reset();
  const host = fakeHost(fx);
  const pass = await fx.withKernel((sb, ctx) => sb.syncSandboxes(ctx, { io: host.io }));
  assert.equal(pass.failed, true, JSON.stringify(pass));
  const p = pass.problems.find((x) => x.sandbox === "ingest");
  assert.ok(p && /reconcile without its seats/.test(p.message), JSON.stringify(pass.problems));
  assert.deepEqual(fx.kept(), [`${spawnKey}.json`], "kept");
  assert.equal(host.calls.filter((c) => c.command.includes(" spawn ")).length, 0, "no replay");
});

/** A process that holds kept request `spawnKey`'s in-flight lock, as a routed spawn between its seat and
 *  its bind does → { kill() → a promise of its exit }. */
async function inFlightHolder(fx, spawnKey) {
  const { spawn } = await import("node:child_process");
  const { dirname } = await import("node:path");
  const lock = join(dirname(fx.pendingDir), "pending.locks", `${spawnKey}.lock`);
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const lib = new URL("../lib/dir-lock.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import { acquireDirLock } from ${JSON.stringify(lib)}; acquireDirLock(${JSON.stringify(lock)}, { what: "a spawn in flight" }); console.log("held"); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((done, failed) => { child.stdout.on("data", (b) => { if (String(b).includes("held")) done(); }); child.on("exit", () => failed(new Error("the holder exited"))); });
  return { kill: () => new Promise((done) => { child.once("exit", done); child.kill("SIGKILL"); }) };
}
const delivered = (seatId) => ({ reconcile: { state: "ready", server: "sandbox-ingest", seats: [{ seatId, state: "delivered" }] } });

test("a reconcile while a routed spawn sits between seat and bind: the request is held-in-flight, never replayed, and nothing binds it but its spawn; the apply names the previewed instance", async (t) => {
  const fx = await routed(t);
  let concurrent = null;
  const host = fakeHost(fx, { apply: () => {
    // The spawn's apply is running: its seat delivered, its bind not yet made. Another oats reconciles.
    const spawnKey = fx.sandbox.calls().find((x) => x.act === "plan" && x.request.target === "seat").request.instance.spawnKey;
    fx.sandbox.set(delivered(`seat-${spawnKey.slice(0, 8)}`));
    concurrent = fx.cliS(["sandbox", "reconcile", "ingest", "--plan-revision", "rev-reconcile", "--idempotency-key", "rk-concurrent", "--json"], fx.sandboxEnv);
    return "ok";
  } });
  const out = await fx.spawnInto(host);
  assert.equal(out.envelope.ok, true, JSON.stringify(out.envelope));
  assert.equal(concurrent.status, 0, concurrent.stdout);
  const answer = JSON.parse(concurrent.stdout.trim().split("\n").pop()).result;
  assert.deepEqual(answer.replays.map((r) => r.outcome), ["held-in-flight"], JSON.stringify(answer.replays));
  assert.deepEqual(acts(fx).filter((a) => a === "bind" || a === "plan:bind"), ["plan:bind", "bind"], "only the spawn's own bind");
  assert.equal(host.calls.filter((c) => c.command.includes(" spawn ") && !c.preview).length, 1, "one apply: the spawn's");
  const apply = host.calls.find((c) => c.command.includes(" spawn ") && !c.preview);
  assert.ok(apply.command.includes("--name ingester-a"), apply.command);
  assert.doesNotMatch(apply.command, /--purpose/, "the previewed name, not the next number");
  assert.deepEqual(fx.kept(), [], "settled by its own bind");
});

test("the E_DECISION_STALE interleaving: while the original holds its request, a reconcile never replays or binds it, so its seat is never released; once its holder is killed, the next reconcile replays it", async (t) => {
  const fx = await routed(t);
  const { spawnKey, seatId } = await keptByLostAnswer(fx);
  const holder = await inFlightHolder(fx, spawnKey);
  try {
    // A concurrent replay would pick another name and meet E_DECISION_STALE, which bind reads as "release".
    fx.sandbox.set(delivered(seatId));
    const stale = fakeHost(fx, { apply: { schemaVersion: 1, ok: false, error: { code: "E_DECISION_STALE", message: "the previewed decision changed" } } });
    const held = await fx.withKernel((sb, ctx) => sb.reconcileSandbox(ctx, "ingest", { planRevision: "rev-reconcile", idempotencyKey: "rk-1", io: stale.io }));
    assert.deepEqual(held.replays, [{ spawnKey, instance: "ingester-a", seat: seatId, outcome: "held-in-flight" }]);
    assert.equal(stale.calls.filter((c) => c.command.includes(" spawn ")).length, 0, "no replay sent");
    assert.deepEqual(acts(fx), ["reconcile"], "no bind, so no release");
    assert.deepEqual(fx.kept(), [`${spawnKey}.json`]);
  } finally { await holder.kill(); }
  // Its holder is gone: the request is replayable again, and its replay is the keyed one.
  fx.sandbox.set({ ...delivered(seatId), bind: { state: "ready", seat: { id: seatId, certificateId: "c", state: "active" } } });
  fx.sandbox.reset();
  const host = fakeHost(fx);
  const replayed = await fx.withKernel((sb, ctx) => sb.reconcileSandbox(ctx, "ingest", { planRevision: "rev-reconcile", idempotencyKey: "rk-2", io: host.io }));
  assert.deepEqual(replayed.replays.map((r) => r.outcome), ["replayed"], JSON.stringify(replayed.replays));
  assert.ok(host.calls.find((c) => c.command.includes(" spawn ")).command.includes(`--idempotency-key ${spawnKey}`));
  assert.deepEqual(fx.kept(), [], "bound active, settled");
});
