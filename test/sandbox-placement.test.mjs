// Sandboxes, where a soul runs (docs/design/2026-11-19-sandboxes.md: Placement, C3b, C6, C10; S1
// Acceptance 10–14 and 16's `placement`): a spawn's key in its hooks' environment, a placed soul never
// spawned on a host that does not list its sandbox, no agent on a host that lists one, the in-sandbox
// deployment's spawns admitted only with a host-delivered seat, and the seat's release after a retire
// from the host. Every refusal is before any side effect: no home, no hook.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxDeployment } from "./helpers/sandbox-fixture.mjs";
import { FAKE_SEAT_CAPABILITY } from "./helpers/fake-sandbox-provider.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { OUTCOME, SESSION_END } from "../lib/session-resume-contract.mjs";
import { waitUntil } from "./helpers/host-fixture.mjs";

const doc = (r) => r.json();
const ok = (r, what) => { assert.equal(r.status, 0, `${what}: ${r.stderr}${r.stdout}`); const d = doc(r); assert.equal(d.ok, true, what); return d.result; };
const refused = (r, code, reason, what) => { assert.notEqual(r.status, 0, `${what}: exit`); const d = doc(r); assert.equal(d.ok, false, `${what}: ${r.stdout}`); assert.equal(d.error.code, code, `${what}: ${d.error.message}`); if (reason) assert.equal(d.error.details?.reason, reason, what); return d.error; };
const instances = (fx, soul) => { const d = join(fx.root, soul, "instances"); return existsSync(d) ? readdirSync(d).filter((n) => !n.startsWith(".")) : []; };
const hostLocal = (fx, extra = {}) => fx.writeLocal({ host: { name: "cloud-1" }, ...extra });
const listing = (fx) => hostLocal(fx, { sandboxes: ["ingest"], credentials: { "sources-read": { fromFile: fx.credential } } });

// A spawn hook that records the key it was handed.
const PROBE = `import { writeFileSync } from "node:fs";
writeFileSync(process.env.OATS_INSTANCE_HOME + "/spawn-key-seen.json", JSON.stringify({ present: Object.hasOwn(process.env, "OATS_SPAWN_IDEMPOTENCY_KEY"), key: process.env.OATS_SPAWN_IDEMPOTENCY_KEY ?? null }));
console.log("{}");`;

test("OATS_SPAWN_IDEMPOTENCY_KEY: a keyed apply's spawn hooks get its key; an unkeyed spawn's get none", (t) => {
  const fx = sandboxDeployment({ t, souls: { dev: { soul: { capabilities: { "fixture.probe": { from: "here" } } } }, ingester: {} }, capabilities: { "fixture.probe": { manifest: { hooks: { spawn: "hook.mjs" } }, files: { "hook.mjs": PROBE } } } });
  hostLocal(fx);
  const preview = ok(fx.cli(["spawn", "dev", "--purpose", "keyed", "--preview", "--json"]), "preview");
  const keyed = ok(fx.cli(["spawn", "dev", "--purpose", "keyed", "--expect-decision", preview.decision.revision, "--idempotency-key", "key-0123", "--no-launch", "--json"]), "keyed apply");
  assert.deepEqual(JSON.parse(readFileSync(join(keyed.home, "spawn-key-seen.json"), "utf8")), { present: true, key: "key-0123" });
  const plain = ok(fx.cli(["spawn", "dev", "--purpose", "plain", "--no-launch", "--json"], { env: { OATS_SPAWN_IDEMPOTENCY_KEY: "inherited" } }), "unkeyed");
  assert.deepEqual(JSON.parse(readFileSync(join(plain.home, "spawn-key-seen.json"), "utf8")), { present: false, key: null }, "an inherited one is dropped too");
});

test("E_DECISION_STALE is answered only when no home holds the key, before any placement or hook", (t) => {
  const fx = sandboxDeployment({ t, souls: { dev: { soul: { capabilities: { "fixture.probe": { from: "here" } } } }, ingester: {} }, capabilities: { "fixture.probe": { manifest: { hooks: { spawn: "hook.mjs" } }, files: { "hook.mjs": PROBE } } } });
  hostLocal(fx);
  refused(fx.cli(["spawn", "dev", "--purpose", "s", "--expect-decision", "not-the-decision", "--idempotency-key", "k-stale", "--no-launch", "--json"]), "E_DECISION_STALE", null, "no home holds the key");
  assert.deepEqual(instances(fx, "dev"), [], "nothing placed");
  const preview = ok(fx.cli(["spawn", "dev", "--purpose", "s", "--preview", "--json"]), "preview");
  const first = ok(fx.cli(["spawn", "dev", "--purpose", "s", "--expect-decision", preview.decision.revision, "--idempotency-key", "k-held", "--no-launch", "--json"]), "apply");
  const again = ok(fx.cli(["spawn", "dev", "--purpose", "s", "--expect-decision", preview.decision.revision, "--idempotency-key", "k-held", "--no-launch", "--json"]), "a home holds the key");
  assert.equal(again.replayed, true);
  assert.equal(again.home, first.home);
  const other = refused(fx.cli(["spawn", "dev", "--purpose", "s", "--expect-decision", "not-the-decision", "--idempotency-key", "k-held", "--no-launch", "--json"]), "E_IDEMPOTENCY_CONFLICT", null, "a home holds the key under another decision");
  assert.notEqual(other.code, "E_DECISION_STALE");
});

test("E_SANDBOX_NOT_HERE: a placed soul on a host that does not list its sandbox, by hand and by a schedule; nothing is created, nothing falls back to the host", (t) => {
  const fx = sandboxDeployment({ t, workspace: { souls: { "ws/ingester": {} } } });
  hostLocal(fx);
  ok(fx.cliS(["sync", "--json"]), "sync");
  // The schedule is added while ingester runs on the host; then the workspace places it in the sandbox.
  ok(fx.cliS(["schedule", "add", "ingest-daily", "--spec-json", JSON.stringify({ kind: "spawn", cron: "0 6 * * *", tz: "UTC", agent: "ingester", task: "Ingest." }), "--json"]), "schedule add");
  fx.commitWorkspace(fx.workspace({ souls: { "ws/ingester": { default: "ingest-team" } } }));
  ok(fx.cliS(["sync", "--json"]), "sync");
  refused(fx.cliS(["spawn", "ingester", "--no-launch", "--json"]), "E_SANDBOX_NOT_HERE", "not-listed", "hand spawn");
  refused(fx.cliS(["spawn", "ingester", "--preview", "--json"]), "E_SANDBOX_NOT_HERE", "not-listed", "preview");
  const run = fx.cliS(["schedule", "run", "ingest-daily", "--json"]);
  assert.ok(run.stdout.includes("E_SANDBOX_NOT_HERE"), `the schedule's spawn is refused: ${run.stdout}`);
  assert.deepEqual(instances(fx, "ingester"), []);
});

test("E_SANDBOX_HOST_AGENT: a host spawn, and a session start, restart or resume of a host home, in a deployment that lists a sandbox", (t) => {
  const fx = sandboxDeployment({ t });
  hostLocal(fx);
  ok(fx.cliS(["sync", "--json"]), "sync");
  const home = ok(fx.cliS(["spawn", "dev", "--purpose", "before", "--no-launch", "--json"]), "a host home, before the sandbox was listed").home;
  listing(fx);
  refused(fx.cliS(["spawn", "dev", "--purpose", "after", "--no-launch", "--json"]), "E_SANDBOX_HOST_AGENT", "host-spawn", "host spawn");
  assert.deepEqual(instances(fx, "dev"), ["dev-before"], "nothing created");
  for (const args of [["session", "start", "--home", home], ["session", "start", "--resume", "--home", home]]) {
    const e = refused(fx.cliS([...args, "--json"]), "E_SANDBOX_HOST_AGENT", "host-session", args.join(" "));
    assert.match(e.message, /remove sandboxes:/);
  }
  assert.equal(existsSync(join(home, ".oats-start.lock")), false, "the start took nothing");
});

const HAS_TMUX = !spawnSync("tmux", ["-V"], { stdio: "ignore" }).error;
test("E_SANDBOX_HOST_AGENT: the resume sweep starts no lost host home in a deployment that lists a sandbox; it reports the refusal as a refused row", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  // On real tmux (the fixture's own server): a host home launched with a stand-in harness that records
  // each start, seen running, then lost (its window killed by hand); then this deployment lists a sandbox.
  const fx = sandboxDeployment({ t });
  const records = join(fx.base, "launches");
  mkdirSync(records);
  const executable = join(fx.base, "harness-stand-in");
  writeFileSync(executable, `#!/bin/sh\necho "$$" > '${records}'/"$OATS_INSTANCE.$(date +%s%N).$$"\nexec sleep 600\n`, { mode: 0o755 });
  const launchConfigs = { "launch-configs": { "stand-in": { harness: "pi", executable } } };
  hostLocal(fx, launchConfigs);
  ok(fx.cliS(["sync", "--json"]), "sync");
  const launches = () => readdirSync(records).length;
  const row = () => JSON.parse(fx.cli(["status", "--json"]).stdout).agents.flatMap((a) => a.instances).find((i) => i.instance === "dev-lost");
  // The spawn is the kernel's CLI, a child with the fixture's environment.
  const made = ok(fx.cliS(["spawn", "dev", "--name", "dev-lost", "--launch-config", "stand-in", "--json"]), "a launched host home");
  await waitUntil(() => launches() === 1, "the harness to start", 30000);
  await waitUntil(() => row()?.running === true, "dev-lost to read as running", 30000);
  const { tmux } = JSON.parse(readFileSync(join(made.home, "instance.json"), "utf8"));
  execFileSync("tmux", ["-u", "-S", tmux.socket, "kill-window", "-t", `=${tmux.session}:=${tmux.window}`], { stdio: "ignore" });
  await waitUntil(() => row()?.sessionEnd === SESSION_END.LOST, "dev-lost to read as lost", 30000);
  hostLocal(fx, { ...launchConfigs, sandboxes: ["ingest"], credentials: { "sources-read": { fromFile: fx.credential } } });
  const sweep = fx.cliS(["session", "resume", "--deployment", fx.dep, "--json"]).json();
  assert.equal(sweep.ok, true, JSON.stringify(sweep));
  const refusedRow = sweep.result.rows.find((r) => r.home === made.home);
  assert.ok(refusedRow, JSON.stringify(sweep.result.rows));
  assert.equal(refusedRow.outcome, OUTCOME.REFUSED, JSON.stringify(refusedRow));
  assert.equal(refusedRow.code, "E_SANDBOX_HOST_AGENT", JSON.stringify(refusedRow));
  assert.equal(launches(), 1, "the sweep started nothing on the host");
  assert.equal(row()?.sessionEnd, SESSION_END.LOST, "the home is still lost");
});

test("E_SANDBOX_HOST_AGENT: a sandbox start while a host home runs, or while one cannot be read", async (t) => {
  const fx = sandboxDeployment({ t });
  ok(fx.cliS(["sync", "--json"]), "sync");
  fx.sandbox.reset();
  await fx.inEnv(async () => {
    Object.assign(process.env, fx.sandbox.env);
    const sb = await import("../lib/sandboxes.mjs");
    const { discoverOrStandalone } = await import("../lib/member-clone.mjs");
    const { loadLocal } = await import("../lib/workspace.mjs");
    const { readLock } = await import("../lib/packages.mjs");
    const { local } = loadLocal(fx.dep);
    const ctx = sb.sandboxContext({ deploymentDir: fx.dep, local, discovery: await discoverOrStandalone(local, { deployment: fx.dep, remoteOptions: fx.remoteOptions }), lock: readLock(fx.dep), remoteOptions: fx.remoteOptions });
    mkdirSync(ctx.root, { recursive: true });
    const row = (extra) => [{ name: "dev", instances: [{ instance: "dev-1", home: join(ctx.root, "dev", "instances", "dev-1"), ...extra }] }];
    for (const [reason, list] of [["host-home-running", row({ running: true })], ["host-home-unreadable", row({ running: null, runtimeState: "unreachable" })]]) {
      await assert.rejects(sb.sandboxLifecycle(ctx, "ingest", "start", { planRevision: "rev-start", idempotencyKey: reason, list }), (e) => e.code === "E_SANDBOX_HOST_AGENT" && e.details.reason === reason, reason);
    }
  });
  assert.deepEqual(fx.sandbox.calls().filter((c) => c.act === "start"), [], "no start reached the provider");
});

test("C3b: inside a sandbox, spawn-from-host without a host-delivered seat; not-placed-here for another soul; a preview with the seat admitted unread; a keyed apply records its placement", (t) => {
  const fx = sandboxDeployment({ t, souls: { dev: {}, ingester: { soul: { capabilities: { [FAKE_SEAT_CAPABILITY]: { from: "here" } } } } } });
  hostLocal(fx);
  ok(fx.cli(["sync", "--json"]), "sync");
  fx.writeLocal({ host: { name: "sbx" }, sandbox: { self: "ingest" } });
  const seat = ["--provider", FAKE_SEAT_CAPABILITY, "identity.seat=/srv/seats/seat-9f2c"];
  refused(fx.cli(["spawn", "ingester", "--no-launch", "--json"]), "E_SANDBOX_PLACEMENT", "spawn-from-host", "no seat");
  refused(fx.cli(["spawn", "ingester", ...seat, "--no-launch", "--json"]), "E_SANDBOX_PLACEMENT", "spawn-from-host", "an unkeyed apply with one");
  refused(fx.cli(["spawn", "dev", "--no-launch", "--json"]), "E_SANDBOX_PLACEMENT", "not-placed-here", "a host soul");
  assert.deepEqual([...instances(fx, "ingester"), ...instances(fx, "dev")], []);
  const preview = ok(fx.cli(["spawn", "ingester", "--purpose", "a", ...seat, "--preview", "--json"]), "a preview with the seat (its path does not exist)");
  const applied = ok(fx.cli(["spawn", "ingester", "--purpose", "a", ...seat, "--expect-decision", preview.decision.revision, "--idempotency-key", "spawn-key-1", "--no-launch", "--json"]), "keyed apply");
  assert.deepEqual(applied.placement, { sandbox: "ingest", seatId: "seat-9f2c" });
  assert.deepEqual(JSON.parse(readFileSync(join(applied.home, "instance.json"), "utf8")).placement, { sandbox: "ingest", seatId: "seat-9f2c" });
  const r = fx.cli(["status", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const status = JSON.parse(r.stdout); // `oats status --json` is its own document, not an envelope
  const row = status.agents.flatMap((a) => a.instances || []).find((i) => i.instance === applied.instance);
  assert.deepEqual(row.placement, { sandbox: "ingest", seatId: "seat-9f2c" }, "oats status --json carries placement");
});

/** A fake ssh on PATH answering a host's probe, roster and retire from FAKE_SSH_TABLE. */
function fakeSsh(fx) {
  const bin = join(fx.base, "ssh-bin");
  mkdirSync(bin, { recursive: true });
  const table = join(fx.base, "ssh-table.json"), log = join(fx.base, "ssh.log");
  writeFileSync(join(bin, "ssh"), `#!${process.execPath}
const { appendFileSync, readFileSync } = require("node:fs");
const command = process.argv.at(-1);
appendFileSync(${JSON.stringify(log)}, command + "\\n");
const t = JSON.parse(readFileSync(${JSON.stringify(table)}, "utf8"));
const key = command.includes("version --json") ? "probe" : command.includes(" retire ") ? "retire" : command.includes(" status ") ? "status" : null;
if (!key) { process.stderr.write("unexpected: " + command + "\\n"); process.exit(97); }
process.stdout.write(JSON.stringify(t[key]) + "\\n");
process.exit(t[key].ok === false ? 1 : 0);
`);
  chmodSync(join(bin, "ssh"), 0o755);
  return { env: { PATH: `${bin}:${fx.env.PATH}` }, set: (t2) => writeFileSync(table, JSON.stringify(t2)), log: () => (existsSync(log) ? readFileSync(log, "utf8") : "") };
}

test("retire from the host: the remote retire, then release (reason retired) with the seat ID from status; no release when the remote retire fails", (t) => {
  const fx = sandboxDeployment({ t });
  ok(fx.cliS(["sync", "--json"]), "sync");
  mkdirSync(fx.env.OATS_HOME_DIR, { recursive: true });
  writeFileSync(join(fx.env.OATS_HOME_DIR, "servers.json"), JSON.stringify({ schemaVersion: 1, servers: { "sandbox-ingest": { sshHost: "sandbox-ingest", workspace: "/sbx" } } }));
  const ssh = fakeSsh(fx);
  const probe = { schemaVersion: 1, name: "@awebai/oats", version: "0.70.0", desktopApi: 1, harnesses: ["pi"], sessionBackends: ["tmux"], launchOptions: [], remote: ["spawn", "status", "retire"], features: ["sandboxes"] };
  const status = { schemaVersion: 1, ok: true, result: { root: "/sbx/agents", agents: [{ name: "ingester", harness: "pi", instances: [{ instance: "ingester-a", home: "/sbx/agents/ingester/instances/ingester-a", running: false }] }] } };
  fx.sandbox.set({ status: { state: "ready", server: "sandbox-ingest", seats: [{ seatId: "seat-r1", instance: "ingester-a", alias: "ingester-a", certificateId: "c", state: "active" }] } });
  ssh.set({ probe, status, retire: { schemaVersion: 1, ok: false, error: { code: "E_LIFECYCLE_FAILED", message: "the host could not retire it" } } });
  fx.sandbox.reset();
  const failed = fx.cliS(["retire", "ingester-a", "--server", "sandbox-ingest", "--json"], ssh.env);
  assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
  assert.equal(fx.sandbox.calls().some((c) => c.act === "release"), false, "no release after a failed retire");
  // A retire that answered ok but whose home may still be live: deferred (a self-retire's saved receipt
  // too), quarantined, kept, or not removed. Nothing is released; the next reconcile settles the seat.
  const home = "/sbx/agents/ingester/instances/ingester-a";
  for (const extra of [{ deferred: true, pendingMarker: `${home}/.retire-pending` }, { rollbackIncomplete: true }, { retainedHome: true }, { removedDir: false }]) {
    ssh.set({ probe, status, retire: { schemaVersion: 1, ok: true, result: { retired: "ingester-a", home, warnings: [], ...extra } } });
    fx.sandbox.reset();
    fx.cliS(["retire", "ingester-a", "--server", "sandbox-ingest", "--json"], ssh.env);
    assert.equal(fx.sandbox.calls().some((c) => c.act === "release" || (c.act === "plan" && c.request.target === "release")), false, `no release: ${JSON.stringify(extra)}`);
  }
  ssh.set({ probe, status, retire: { schemaVersion: 1, ok: true, result: { retired: "ingester-a", home: "/sbx/agents/ingester/instances/ingester-a", warnings: [] } } });
  fx.sandbox.reset();
  const done = fx.cliS(["retire", "ingester-a", "--server", "sandbox-ingest", "--json"], ssh.env);
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.ok(ssh.log().includes(" retire "), "the remote retire ran");
  const release = fx.sandbox.calls().find((c) => c.act === "release");
  assert.ok(release, fx.sandbox.calls().map((c) => c.act).join(" "));
  assert.equal(release.request.reason, "retired");
  assert.deepEqual(release.request.instance, { name: "ingester-a", seatId: "seat-r1" });
  assert.deepEqual(fx.sandbox.calls().map((c) => (c.act === "plan" ? `plan:${c.request.target}` : c.act)), ["status", "plan:release", "release"]);
});
