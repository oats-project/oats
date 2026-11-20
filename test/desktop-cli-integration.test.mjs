// Desktop server ↔ CLI integration: discovery status endpoint, re-probe,
// and the two v1 mutations routed through a FAKE compatible `oats` binary — a
// fixture that speaks the exact contract, so acceptance, the band edges and
// the liar/timeout paths are exercised deterministically at any repo version.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { closeGroup, startGroup } from "./helpers/process-group.mjs";
import { privateSocketDir, startBackend } from "../packages/desktop/test/helpers/backend-server.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A fake `oats` that speaks Desktop CLI API v1 exactly. It logs its argv/cwd
 * so assertions can verify the adapter's invocation shape. */
const V2_FIXTURES = join(ROOT, "packages", "desktop", "test", "fixtures", "workspace-v2");
// packages-no-approval: the Desktop drives the kernel line without package approval (F2b).
const V2_FEATURES = ["workspace-v2", "instance-modules", "served-identity", "packages-no-approval"];
/** The workspace-model v2 reads replay JSON captured from a real CLI run on the
 * hand-built Northwind deployment, rebased onto the --dir under test.
 * `status` may be replaced by a test-supplied document (written to a file). */
function fakeCli(dir, { version = "0.26.0", desktopApi = 1, probeExit = 0, probeHangMs = 0, remote, features, operationsApi, groups = [], v2 = true, status } = {}) {
  const log = join(dir, "cli-calls.jsonl");
  const statusFile = status ? join(dir, "status-override.json") : null;
  if (statusFile) writeFileSync(statusFile, JSON.stringify(status));
  const probeFeatures = v2 ? [...(features || []), ...V2_FEATURES] : features;
  const js = join(dir, "oats.cjs");
  const bin = join(dir, "oats");
  writeFileSync(js, `const { appendFileSync, readFileSync } = require("node:fs");
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");
if (argv[0] === "version" && argv.includes("--json")) {
  process.stdout.write(JSON.stringify({ schemaVersion: 1, name: "@awebai/oats", version: ${JSON.stringify(version)}, desktopApi: ${JSON.stringify(desktopApi)}, remote: ${JSON.stringify(remote)}, features: ${JSON.stringify(probeFeatures)}, operationsApi: ${JSON.stringify(operationsApi)}, workspaceApi: ${JSON.stringify(v2 ? 2 : undefined)} }));
  // Liar modes (review 0b83988): print a VALID probe, then exit nonzero or
  // REALLY hang past the probe timeout — either must be rejected by
  // discovery. if/else if throughout: fallthrough to the trailing exit(2)
  // previously made the "hanger" exit in 0.058s (review 6b90702).
  if (${JSON.stringify(probeHangMs)} > 0) { setTimeout(() => process.exit(0), ${JSON.stringify(probeHangMs)}); }
  else process.exit(${JSON.stringify(probeExit)});
} else if ((argv[0] === "status" || (argv[0] === "workspace" && argv[1] === "status")) && argv.includes("--json")) {
  const fixture = ${JSON.stringify(V2_FIXTURES)};
  const captured = require("node:path").dirname(JSON.parse(readFileSync(fixture + "/status.json", "utf8")).root);
  const target = argv[argv.indexOf("--dir") + 1];
  const file = argv[0] === "status" ? (${JSON.stringify(statusFile)} || fixture + "/status.json") : fixture + "/workspace-status.json";
  process.stdout.write(readFileSync(file, "utf8").split(captured).join(target));
  process.exit(0);
} else if (argv[0] === "server" && argv[1] === "roster") {
  process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: true, result: { groups: ${JSON.stringify(groups)} } }));
  process.exit(0);
} else if (argv[0] === "session" && argv[1] === "inspect" && argv.includes("--json")) {
  process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: true, result: { present: true } }));
  process.exit(0);
} else if (argv[0] === "spawn" && argv.includes("--json")) {
  const agent = argv[1];
  // Like the kernel, --task-file is optional: a remote spawn with no opening instruction sends none.
  const task = argv.includes("--task-file") ? readFileSync(argv[argv.indexOf("--task-file") + 1], "utf8") : "";
  if (agent === "boom") { process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_SPAWN_FAILED", message: "boom" } })); process.exit(1); }
  // purpose "ambig": a LONG case-(d) E_RELATIVE_AMBIGUOUS envelope (two
  // deeply nested absolute homes, >2500 chars) — the endpoint must pass it
  // through UNSLICED (review 835a05f); purpose "noisy": an oversized
  // NON-ambiguity error that must stay capped at 300.
  if (argv[argv.indexOf("--purpose") + 1] === "ambig") {
    const home = (p) => "/Users/someone/" + Array.from({ length: 40 }, (_, k) => p + "-deeply-nested-workspace-segment-" + k).join("/") + "/agents/dev-coordinator/instances/dev-coordinator-parallel";
    const msg = 'relation "sibling": inherited lineage edge "dev-coordinator-parallel" is ambiguous \u2014 it matches ' + home("aa") + " and " + home("bb") + "; qualify with --relative-root or rename one instance";
    process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_RELATIVE_AMBIGUOUS", message: msg } }));
    process.exit(1);
  }
  if (argv[argv.indexOf("--purpose") + 1] === "noisy") {
    process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_SPAWN_FAILED", message: "x".repeat(1000) } }));
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: true, result: {
    instance: agent + "-t1", agent, home: "/tmp/h", work: "worktree", branch: "b",
    launched: true, warnings: [], tmux: { session: "pi-agents", window: agent + "-t1" },
    taskEcho: task,
    ...(argv[argv.indexOf("--purpose") + 1] === "route-conflict" ? { routeConflict: { instance: agent + "-t1", existingHome: "/remote/existing" }, snapshot: null } : {}),
    ...(argv.includes("--server") ? { server: argv[argv.indexOf("--server") + 1], target: ${JSON.stringify(groups.find(g=>g.registrationPresent)?.target)} } : {}) } }));
  process.exit(0);
} else if (argv[0] === "retire" && argv.includes("--json")) {
  process.stdout.write(JSON.stringify({ retired: argv[1], removedDir: true }));
  process.exit(0);
} else if (argv[0] === "operation" && argv[1] === "run" && argv.includes("--json")) {
  // The provider-operation contract: the kernel envelope carries the
  // provider's own view/action result under result.result.
  process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: true, result: { operation: argv[2], capability: "oats.okf", result: { status: "empty", processed: true } } }));
  process.exit(0);
} else {
  process.stderr.write("unexpected argv: " + argv.join(" "));
  process.exit(2);
}
`);
  // PATH is intentionally hostile in these tests (/nonexistent), so the
  // launcher must not rely on env lookup: absolute node, absolute script.
  writeFileSync(bin, `#!/bin/sh
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(js)} "$@"
`);
  chmodSync(bin, 0o755);
  // The locator canonicalizes candidates (realpath) — on macOS /var →
  // /private/var — so assertions compare against the canonical path.
  return { bin, real: realpathSync(bin), calls: () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) };
}

/** Wait until the kernel observation of the deployment has landed. */
async function observed(srv) {
  for (let i = 0; i < 100; i++) {
    const pd = await (await srv.request("/api/panel")).json();
    if (pd.deployment?.status === "observed") return pd;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail("the deployment was never observed");
}
/** The servers the test that runs has started, and their socket directories. */
const servers = [], sockets = [];
/** A new temporary directory of the test, removed when the test has ended. Its servers are closed
 *  first, and the removal waits until everything they started has ended (closeGroup): a server
 *  that is killed leaves the fake CLI it had just started to finish by itself, and that one writes
 *  its log in the directory after the server has gone. So a server is started with startGroup. */
function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(async () => {
    for (const proc of servers.splice(0)) await closeGroup(proc);
    for (const socket of sockets.splice(0)) socket.remove();
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
/** Start the real backend (a private socket, a fresh credential on fd 3: helpers/backend-server.mjs) serving
 *  `dirs`, as the leader of a process group of its own; `srv.request(path, init)` is an authorized request. */
async function startServer(env, dirs = [ROOT]) {
  const socket = privateSocketDir(); sockets.push(socket);
  const srv = await startBackend({ dirs, socket, env: { ...process.env, ...env }, timeout: 15000,
    spawn: (command, argv, options) => { const proc = startGroup(command, argv, options); servers.push(proc); return proc; } });
  return { proc: srv.child, srv };
}

test("desktop server: /api/cli reports discovery status; compatible fake CLI accepted via OATS_DESKTOP_OATS_BIN", async (t) => {
  const dir = tempDir(t, "oats-clifake-");
  const { bin, real } = fakeCli(dir);
  const { proc, srv } = await startServer({ OATS_DESKTOP_OATS_BIN: bin, PATH: "/nonexistent", SHELL: "/bin/false" });
  try {
    // startup probe may still be running — reprobe deterministically
    const s = await (await srv.request(`/api/cli/reprobe`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.equal(s.version, "0.26.0");
    assert.equal(s.source, "env");
    // The recovery command is DERIVED from this app's own version, so it names
    // the lockstep-published kernel and always lands inside the tested bound —
    // never a hand-pinned version that rots below a feature floor.
    const desktopVersion = JSON.parse(readFileSync(new URL("../packages/desktop/package.json", import.meta.url), "utf8")).version;
    const [major, minor] = desktopVersion.split(".");
    assert.deepEqual(s.required, { desktopApi: 1, range: `>=0.26.0, tested through ${major}.${minor}` });
    assert.equal(s.aboveTested, false, "a 0.26 CLI is inside the tested bound");
    assert.equal(s.testedThrough, `${major}.${minor}`, "the tested bound is this Desktop's own minor (#1879)");
    assert.equal(s.install, `npm install -g @awebai/oats@${desktopVersion}`);
    const { acceptProbe } = await import("../packages/client/cli-locator.mjs");
    assert.deepEqual(acceptProbe({ schemaVersion: 1, name: "@awebai/oats", version: desktopVersion, desktopApi: 1 }, desktopVersion), { ok: true },
      `the served install command pins ${desktopVersion}, which this Desktop would reject`);
    const g = await (await srv.request(`/api/cli`)).json();
    assert.equal(g.ok, true);
    assert.equal(g.bin, real);
  } finally { proc.kill(); }
});

test("desktop server: incompatible CLI → status carries per-candidate diagnostics; no roster and no spawn target", async (t) => {
  const dir = tempDir(t, "oats-cliold-");
  const { bin, real, calls } = fakeCli(dir, { version: "0.21.6" });
  const { proc, srv } = await startServer({ OATS_DESKTOP_OATS_BIN: bin, PATH: "/nonexistent", SHELL: "/bin/false" });
  try {
    const s = await (await srv.request(`/api/cli/reprobe`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    assert.equal(s.ok, false);
    const envTried = s.tried.find((t) => t.path === real);
    assert.ok(envTried, "the rejected candidate is in diagnostics");
    assert.match(envTried.reason, /outside/);
    assert.equal(envTried.version, "0.21.6", "detected version surfaces for the card");
    // Workspace model v2: the deployment IS the kernel's JSON, so without a
    // compatible CLI there is no roster — never a filesystem fallback reader.
    let pd;
    for (let i = 0; i < 50; i++) { pd = await (await srv.request(`/api/panel`)).json(); if (pd.deployment.status !== "pending") break; await new Promise((r) => setTimeout(r, 100)); }
    assert.equal(pd.deployment.status, "unavailable"); assert.equal(pd.deployment.reason.code, "E_CLI_UNAVAILABLE");
    assert.deepEqual(pd.instances, []);
    const ad = await (await srv.request(`/api/agents`)).json();
    assert.deepEqual(ad.agents, [], "no souls without the kernel's observation");
    const r = await srv.request(`/api/spawn`, { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "release-manager", agentsRoot: join(ROOT, "agents") }) });
    assert.equal(r.status, 409, "an unobserved root is never a spawn target");
    assert.equal(calls().some((c) => c.argv[0] === "spawn" || c.argv[0] === "status"), false);
  } finally { proc.kill(); }
});

// The edges through the REAL discovery path, not just acceptProbe: the
// v0.19.0 readiness blocker was an app that refused the kernel its own
// release published, so it degraded to observation-only in the field while
// every unit test passed. Accept from the floor to the Desktop's own minor with
// no notice; accept the next minor and the next major flagged above the tested
// bound (#1879); refuse a 0.25 kernel at the floor.
test("desktop server: 0.26.0 through the Desktop's own minor are ACCEPTED as before; a later minor or major is ACCEPTED above the tested bound; 0.25.9 is REJECTED at the floor", async (t) => {
  const desktopVersion = JSON.parse(readFileSync(new URL("../packages/desktop/package.json", import.meta.url), "utf8")).version;
  const [major, minor] = desktopVersion.split(".").map(Number);
  const inside = ["0.26.0", "0.26.4", "0.40.0", "0.49.0", "0.52.0", "0.53.0", `${major}.${minor}.0`, `${major}.${minor}.99`];
  for (const [version, above] of [...inside.map((v) => [v, false]), [`${major}.${minor + 1}.0`, true], [`${major + 1}.0.0`, true]]) {
    const okDir = tempDir(t, "oats-cli-compatible-");
    const compatible = fakeCli(okDir, { version });
    const a = await startServer({ OATS_DESKTOP_OATS_BIN: compatible.bin, PATH: "/nonexistent", SHELL: "/bin/false" });
    try {
      const s = await (await a.srv.request(`/api/cli/reprobe`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
      assert.equal(s.ok, true, `${version} rejected by discovery: ${JSON.stringify(s.tried)}`);
      assert.equal(s.version, version);
      assert.equal(s.bin, compatible.real);
      assert.equal(s.relations, true, `${version} is above the spawn-relations floor`);
      assert.equal(s.aboveTested, above, `${version}: above the ${major}.${minor} tested bound?`);
      assert.equal(s.testedThrough, `${major}.${minor}`);
    } finally { a.proc.kill(); }
  }

  const badDir = tempDir(t, "oats-cli-outside-");
  const outside = fakeCli(badDir, { version: "0.25.9" });
  const b = await startServer({ OATS_DESKTOP_OATS_BIN: outside.bin, PATH: "/nonexistent", SHELL: "/bin/false" });
  try {
    const s = await (await b.srv.request(`/api/cli/reprobe`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    assert.equal(s.ok, false, "0.25.9 is below the floor and must not become the mutation binary");
    const tried = s.tried.find((t) => t.path === outside.real);
    assert.ok(tried, "the rejected candidate is in diagnostics");
    assert.match(tried.reason, /outside >=0\.26\.0, tested through /);
    assert.equal(tried.version, "0.25.9");
    assert.equal(Object.hasOwn(tried, "newerApi"), false, "below the floor is not a newer API");
  } finally { b.proc.kill(); }
});

test("desktop server: a CLI that prints a valid probe but exits nonzero (or hangs) is REJECTED (review 0b83988)", async (t) => {
  // exercises the PRODUCTION probeBin callback: err && stdout must reject.
  const dir1 = tempDir(t, "oats-cliliar-");
  const liar = fakeCli(dir1, { probeExit: 1 });     // valid probe on stdout, exit 1
  const { proc, srv } = await startServer({ OATS_DESKTOP_OATS_BIN: liar.bin, PATH: "/nonexistent", SHELL: "/bin/false" });
  try {
    const s = await (await srv.request(`/api/cli/reprobe`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    assert.equal(s.ok, false, `nonzero-exit liar accepted: ${JSON.stringify(s)}`);
    const tried = s.tried.find((t) => t.path === liar.real);
    assert.ok(tried, "liar recorded in diagnostics");
    assert.match(tried.reason, /probe failed/, "rejected as a probe failure, not by payload");
  } finally { proc.kill(); }
  // timeout case: valid probe printed, process REALLY hangs past the 8s
  // probe timeout. The server kills it (killSignal SIGKILL) and the
  // candidate must reject. Assert independently that (a) the fixture
  // actually hangs and (b) the reprobe crossed the production timeout —
  // review 6b90702 caught the previous "hanger" exiting in 0.058s via
  // fallthrough, leaving the timeout path untested.
  const dir2 = tempDir(t, "oats-clihang-");
  const hanger = fakeCli(dir2, { probeHangMs: 20000 });
  // (a) the fixture hangs: run it directly and confirm it is still alive
  // after 1s (then kill it).
  {
    const direct = spawn(hanger.bin, ["version", "--json"], { stdio: "ignore" });
    let exited = false;
    direct.on("exit", () => { exited = true; });
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(exited, false, "hanger fixture really hangs (no fallthrough exit)");
    direct.kill("SIGKILL");
  }
  const r2 = await startServer({ OATS_DESKTOP_OATS_BIN: hanger.bin, PATH: "/nonexistent", SHELL: "/bin/false" });
  try {
    const t0 = Date.now();
    const s2 = await (await r2.srv.request(`/api/cli/reprobe`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    const elapsed = Date.now() - t0;
    assert.equal(s2.ok, false, `hanging liar accepted: ${JSON.stringify(s2)}`);
    const tried2 = s2.tried.find((t) => t.path === hanger.real);
    assert.ok(tried2 && /probe failed/.test(tried2.reason), "timeout rejected as probe failure");
    // (b) the production 8s probe timeout actually elapsed for this candidate
    assert.ok(elapsed >= 7500, `reprobe crossed the probe timeout (took ${elapsed}ms)`);
  } finally { r2.proc.kill(); }
});

test("desktop server: an unguarded local spawn is refused before the CLI; a provider's harvest addresses the exact instance home", async (t) => {
  const dir = tempDir(t, "oats-climut-");
  const { bin, calls } = fakeCli(dir, { features: ["operations"], operationsApi: 2 });
  const { proc, srv } = await startServer({ OATS_DESKTOP_OATS_BIN: bin, PATH: "/nonexistent", SHELL: "/bin/false" });
  try {
    await srv.request(`/api/cli/reprobe`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    await observed(srv);
    // ---- spawn: every local spawn is the confirmed prepare → apply transaction
    // (/api/spawn?ws=…); the ordinary body is execution-server only. The old
    // unguarded local route this test drove (argv --dir/--task-file) was
    // deleted with the v2 spawn dialog (§3b: deleted, not ported — the
    // confirmed apply's argv is covered by packages/desktop/test/spawn-apply-cli).
    const r = await srv.request(`/api/spawn`, { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "dev", agentsRoot: "/any/agents", task: "secret task text", purpose: "t1" }) });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).code, "E_PLAN_REQUIRED");
    assert.equal(calls().some((c) => c.argv[0] === "spawn"), false, "the CLI is never asked to spawn from an unguarded local body");
    // ---- harvest is a provider operation run through the generic capabilities route (#818): pick a
    // real instance from the panel; the bridge names its home explicitly and lets the CLI derive its
    // recorded context
    const pd = await (await srv.request(`/api/panel`)).json();
    const inst = pd.instances.find((i) => i.home);
    assert.ok(inst, "the fixture roster has an instance with a home");
    const run = (home) => srv.request(`/api/capabilities?ws=${encodeURIComponent(pd.workspace.id)}`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "run", selector: { home }, operation: "knowledge:harvest" }) });
    const hr = await run(inst.home);
    assert.equal(hr.status, 200, JSON.stringify(await hr.clone().json()));
    const hb = await hr.json();
    assert.equal(hb.result.status, "empty");
    assert.equal(hb.result.processed, true);
    const harvestCall = calls().find((c) => c.argv[0] === "operation");
    assert.deepEqual(harvestCall.argv, ["operation", "run", "knowledge:harvest", "--home", inst.home, "--json"]);
    // a home the roster does not report is refused, and the CLI is never invoked for it
    const before = calls().length;
    const unknown = await run(join(dirname(inst.home), "no-such-instance"));
    assert.equal(unknown.status, 409);
    assert.equal((await unknown.json()).code, "E_BAD_ARGS");
    assert.equal(calls().length, before);
  } finally { proc.kill(); }
});

test("desktop server: a kernel-reported home outside the soul's instances directory cannot steer a start or a provider operation (review 53a20c7 blocker)", async (t) => {
  // The kernel's status copies instance.json through; a hostile file can make
  // it REPORT a steered home. The Desktop withholds that row (counted in the
  // header), so no privileged route can address it and the CLI never runs there.
  const scope = realpathSync(tempDir(t, "oats-hostile-ws-"));
  const steerTarget = realpathSync(tempDir(t, "oats-steer-target-"));
  const fixture = JSON.parse(readFileSync(join(V2_FIXTURES, "status.json"), "utf8"));
  const captured = dirname(fixture.root);
  const hostile = JSON.parse(JSON.stringify(fixture).split(captured).join(scope));
  hostile.agents[0].instances[0].home = steerTarget;
  const cliDir = tempDir(t, "oats-clihostile-");
  const { bin, calls } = fakeCli(cliDir, { features: ["operations"], operationsApi: 2, status: hostile });
  const { proc, srv } = await startServer({ OATS_DESKTOP_OATS_BIN: bin, PATH: "/nonexistent", SHELL: "/bin/false" }, [scope]);
  try {
    let pd;
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { pd = await (await srv.request(`/api/panel`)).json(); } catch { continue; }
      if (pd.deployment?.status === "observed") break;
    }
    assert.equal(pd?.deployment?.status, "observed", JSON.stringify(pd?.deployment));
    const name = fixture.agents[0].instances[0].instance;
    assert.equal(pd.instances.some((i) => i.home === steerTarget), false, "the steered home is never published");
    assert.deepEqual(pd.deployment.withheld, [{ agent: fixture.agents[0].name, instance: name, reason: "home-outside-soul" }]);
    const hr = await srv.request(`/api/start/${name}?ws=${encodeURIComponent(pd.workspace.id)}`, { method: "POST" });
    assert.equal(hr.status, 404, "a withheld row is not addressable");
    const run = await srv.request(`/api/capabilities?ws=${encodeURIComponent(pd.workspace.id)}`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "run", selector: { home: steerTarget }, operation: "knowledge:harvest" }) });
    assert.equal(run.status, 409, "nor is its steered home");
    assert.equal((await run.json()).code, "E_BAD_ARGS");
    assert.equal(calls().some((c) => c.argv[0] === "operation" || c.argv[0] === "session" || c.argv.includes(steerTarget) || c.cwd === steerTarget), false,
      "the steered home never reaches the CLI");
  } finally { proc.kill(); }
});

test("desktop server HTTP boundary: long E_RELATIVE_AMBIGUOUS envelope reaches the client UNSLICED; other codes stay capped (review 835a05f)", async (t) => {
  // The ordinary spawn body is execution-server only now (local spawns are the
  // confirmed prepare → apply transaction), so the error-envelope boundary is
  // exercised through an execution-server spawn.
  const dir = tempDir(t, "oats-cliambig-");
  const { bin } = fakeCli(dir, { remote: ["spawn"] });
  const { proc, srv } = await startServer({ OATS_DESKTOP_OATS_BIN: bin, PATH: "/nonexistent", SHELL: "/bin/false" });
  try {
    await srv.request(`/api/cli/reprobe`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    await observed(srv);
    const pd = await (await srv.request(`/api/panel`)).json();
    const agentsRoot = pd.instances[0].agentsRoot;
    const post = (purpose) => srv.request(`/api/spawn`, { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "dev", agentsRoot, purpose, serverId: "host" }) });
    // case-(d) ambiguity: the fake CLI's envelope carries two deeply nested
    // homes (>2500 chars); the ACTUAL response body must be complete —
    // reverting the endpoint to an inline slice would fail here
    const ra = await post("ambig");
    assert.equal(ra.status, 409);
    const ba = await ra.json();
    assert.equal(ba.code, "E_RELATIVE_AMBIGUOUS");
    assert.ok(ba.error.length > 2500, `full diagnostics reach the client (${ba.error.length} chars)`);
    assert.match(ba.error, /qualify with --relative-root or rename one instance$/,
      "the actionable tail (second home + remedy) survives the HTTP boundary");
    assert.ok(ba.error.includes("/aa-deeply") && ba.error.includes("/bb-deeply"), "BOTH homes present");
    // a different code with oversized text remains capped at the boundary
    const rn = await post("noisy");
    assert.equal(rn.status, 409);
    const bn = await rn.json();
    assert.equal(bn.code, "E_SPAWN_FAILED");
    assert.equal(bn.error.length, 300, "non-ambiguity errors stay capped at 300 over HTTP");
  } finally { proc.kill(); }
});


test("desktop server: remote capability survives discovery and HTTP projection into terminal preparation", async (t) => {
  const { prepareRemoteTerm } = await import("../packages/client/session-attach.mjs");
  const dir = tempDir(t, "oats-cliremote-");
  const fake = fakeCli(dir, { remote: ["spawn", "retire", "status", "session"] });
  const { proc, srv } = await startServer({ OATS_DESKTOP_OATS_BIN: fake.bin, PATH: "/nonexistent", SHELL: "/bin/false" });
  try {
    await srv.request(`/api/cli/reprobe`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const cli = await (await srv.request(`/api/cli`)).json();
    // A remote terminal is addressed by server and home, never a bare name.
    const home = "/srv/agents/dev/instances/dev-task";
    const prepared = await prepareRemoteTerm(cli, { serverId: "test", instance: "dev-task", home });
    assert.deepEqual(prepared, { binary: fake.real, args: ["session", "attach", "--server", "test", "--home", home] });
    assert.ok(fake.calls().some(c => c.argv.join(" ") === `session inspect --server test --home ${home} --json`));
    await assert.rejects(prepareRemoteTerm(cli, { serverId: "test", instance: "dev-task" }), /invalid remote terminal home/);
  } finally { proc.kill(); }
});

test("desktop server: remote roster, souls and a provider's harvest stay on the saved host route", async (t) => {
  const dir = tempDir(t, "oats-remote-roster-");
  const home = "/remote/project/agents/dev/instances/dev-one";
  const groups = [{ id: "host-abc", server: "host", label: "Remote host", registrationPresent: true,
    target: { sshHost: "host", workspace: "/remote/project", oatsPath: "oats" }, probe: { ok: true },
    agentsRoot: "/remote/project/agents", souls: [{ name: "dev", runtime: "codex", work: "worktree" }],
    instances: [
      { instance: "dev-one", agent: "another", home: "/remote/project/agents/another/instances/dev-one", agentsRoot: "/remote/project/agents", running: true, savedRoute: true, runtime: "codex" },
      { instance: "dev-one", agent: "dev", home, agentsRoot: "/remote/project/agents", running: true, savedRoute: true, runtime: "codex" },
    ],
  }];
  const fake = fakeCli(dir, { remote: ["spawn", "retire", "session", "roster", "operations"], features: ["retire-home", "operations"], operationsApi: 2, groups });
  const { proc, srv } = await startServer({ OATS_DESKTOP_OATS_BIN: fake.bin, PATH: "/nonexistent", SHELL: "/bin/false" });
  try {
    await srv.request(`/api/cli/reprobe`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    let panel;
    for (let n = 0; n < 30; n++) {
      panel = await (await srv.request(`/api/panel?ws=remote%3Ahost-abc`)).json();
      if (panel.workspace?.remote) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(panel.workspace.id, "remote:host-abc");
    assert.equal(panel.instances[0].server, "host");
    assert.ok(panel.workspaces.some((w) => w.remote && w.server === "host"));
    const agents = await (await srv.request(`/api/agents?ws=remote%3Ahost-abc`)).json();
    assert.equal(agents.agents[0].agentsRoot, "/remote/project/agents");
    assert.equal(agents.agents[0].server, "host");
    const qualifier = `?ws=remote%3Ahost-abc&home=${encodeURIComponent(home)}&server=host`;
    const harvested = await srv.request(`/api/capabilities?ws=remote%3Ahost-abc`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "run", selector: { home }, operation: "knowledge:harvest" }) });
    assert.equal(harvested.status, 200, JSON.stringify(await harvested.clone().json()));
    const call = fake.calls().find((c) => c.argv[0] === "operation");
    assert.deepEqual(call.argv, ["operation", "run", "knowledge:harvest", "--server", "host", "--home", home, "--json"], "saved --server route and the exact remote --home");
    assert.notEqual(call.cwd, home, "remote home must never become a local process cwd");
    const retired = await srv.request(`/api/retire/dev-one${qualifier}`, { method: "POST" });
    assert.equal(retired.status, 409);
    assert.equal((await retired.json()).code, 'E_PLAN_REQUIRED');
    assert.equal(fake.calls().some(c => c.argv[0] === 'retire'), false, 'legacy remote retirement cannot bypass plan confirmation');
    const spawned = await srv.request(`/api/spawn`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "dev", agentsRoot: "/remote/project/agents", serverId: "host", harness: "codex" }) });
    assert.equal(spawned.status, 200);
    assert.equal((await spawned.json()).workspaceId, "remote:host-abc");
    const spawnCall = fake.calls().find((c) => c.argv[0] === "spawn");
    assert.equal(spawnCall.argv.includes("--dir"), false, "remote scope remains the registry's authority");
    assert.equal(spawnCall.argv[spawnCall.argv.indexOf("codex") - 1], "--runtime", "the local kernel's flag (no feature harness): its --server route translates");
    assert.notEqual(spawnCall.cwd, "/remote/project", "spawn's local process does not enter the remote workspace");
    const collision = await srv.request(`/api/spawn`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "dev", agentsRoot: "/remote/project/agents", serverId: "host", purpose: "route-conflict" }) });
    assert.equal(collision.status, 200, "the remote launch succeeded even though its route could not be saved");
    assert.deepEqual((await collision.json()).routeConflict, { instance: "dev-t1", existingHome: "/remote/existing" }, "the real HTTP boundary retains the CLI conflict for renderer feedback");
    const remoteFiles = await srv.request(`/api/brain/dev?ws=remote%3Ahost-abc`);
    assert.equal(remoteFiles.status, 409, "a remote agent's files are never read from a local lookalike path");
    assert.equal((await remoteFiles.json()).code, "E_REMOTE_FILES");
    assert.equal((await srv.request(`/api/start/dev-one?ws=remote%3Ahost-abc&home=${encodeURIComponent(home)}`, { method: "POST" })).status, 404, "missing server cannot select a remote instance");
    const retireCalls = fake.calls().filter((c) => c.argv[0] === "retire").length;
    fakeCli(dir, { remote: ["roster", "retire"], groups }); // downgrade: no exact-home feature
    await srv.request(`/api/cli/reprobe`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const refused = await srv.request(`/api/retire/dev-one${qualifier}`, { method: "POST" });
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).code, 'E_PLAN_REQUIRED');
    assert.equal(fake.calls().filter((c) => c.argv[0] === "retire").length, retireCalls, "old CLI cannot silently ignore --home and retire a twin");
  } finally { proc.kill(); }
});

test("remote homes cannot grant local file access, and unguarded retirement refuses even with missing home", async (t) => {
  const dir = tempDir(t, "oats-remote-file-guard-");
  const secret = join(dir, "local-only.txt");
  writeFileSync(secret, "local fixture outside every workspace");
  const groups = [{ id: "guard", server: "host", registrationPresent: true,
    target: { sshHost: "host", workspace: "/remote" }, probe: { ok: true }, souls: [],
    instances: [
      { instance: "remote-root", home: "/", running: true, savedRoute: true },
      { instance: "remote-collision", home: dir, repo: dir, running: true, savedRoute: true },
      { instance: "missing-home", running: true, savedRoute: true },
    ],
  }];
  const fake = fakeCli(dir, { remote: ["roster", "retire"], features: ["retire-home"], groups });
  const { proc, srv } = await startServer({ OATS_DESKTOP_OATS_BIN: fake.bin, PATH: "/nonexistent", SHELL: "/bin/false" });
  try {
    await srv.request(`/api/cli/reprobe`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    let panel;
    for (let n = 0; n < 30; n++) {
      panel = await (await srv.request(`/api/panel?ws=remote%3Aguard`)).json();
      if (panel.workspace?.remote) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(panel.instances.length, 3, "the remote rows were actually admitted to the roster");
    await observed(srv); // the local deployment's kernel-observed roots
    assert.equal((await srv.request(`/api/file?path=${encodeURIComponent(secret)}`)).status, 403);
    assert.equal((await srv.request(`/api/file?path=${encodeURIComponent(join(ROOT, 'souls/oats-engineering-expert/AGENTS.md'))}`)).status, 200, "a local deployment file remains readable");
    const retired = await srv.request(`/api/retire/missing-home?ws=remote%3Aguard&server=host`, { method: "POST" });
    assert.equal(retired.status, 409);
    assert.equal((await retired.json()).code, 'E_PLAN_REQUIRED');
    assert.equal(fake.calls().filter((c) => c.argv[0] === "retire").length, 0);
  } finally { proc.kill(); }
});
