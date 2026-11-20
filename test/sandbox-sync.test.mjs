// Sandboxes in `oats sync` (docs/design/2026-11-19-sandboxes.md "What sync does", C5; D-S1-1, D-S1-2,
// D-S1-3; S1 Acceptance 15, 16's sync answer, 17 and 18): each listed sandbox built, started or left,
// each delisted one stopped and never destroyed, a sandbox removed from both files stopped through the
// started record, a failure in `problems` with exit 1 and the lock still written, the provider's
// readiness facts as warnings, never failures; the readiness items; the reserved server prefix.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxDeployment, TEAM_ID } from "./helpers/sandbox-fixture.mjs";
import { CLI } from "./helpers/v2-deployment.mjs";
import { SSH_INCLUDE_REMEDY } from "./helpers/fake-sandbox-provider.mjs";

const envelope = (r) => r.json();
const ok = (r, what) => { assert.equal(r.status, 0, `${what}: ${r.stderr}${r.stdout}`); const d = envelope(r); assert.equal(d.ok, true, what); return d.result; };
const acts = (fx) => fx.sandbox.calls().map((c) => (c.act === "plan" ? `plan:${c.request.target}` : c.act));
const started = (fx) => { const p = join(fx.dep, ".oats", "sandboxes", "started.json"); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; };
const listed = (fx, names, extra = {}) => fx.writeLocal({ host: { name: "cloud-1" }, sandboxes: names, credentials: { "sources-read": { fromFile: fx.credential } }, ...extra });

test("sync --plan performs nothing: the actions are reported, no act runs, nothing is recorded", (t) => {
  const fx = sandboxDeployment({ t });
  fx.sandbox.set({ status: { state: "absent", seats: [] } });
  const r = ok(fx.cliS(["sync", "--plan", "--json"]), "sync --plan");
  assert.equal(r.sandboxes[0].action, "build");
  assert.deepEqual(acts(fx), ["status", "plan:start"]);
  assert.equal(started(fx), null);
  assert.equal(existsSync(join(fx.dep, "oats-lock.json")), false, "a plan writes no lock either");
});

test("sync's actions: build (absent, or a plan that renders), start (stopped), none (ready, nothing to do), stop (delisted, never destroyed)", (t) => {
  const fx = sandboxDeployment({ t });
  const action = (table) => { fx.sandbox.set(table); fx.sandbox.reset(); return ok(fx.cliS(["sync", "--json"]), JSON.stringify(table)).sandboxes; };
  assert.equal(action({ status: { state: "absent", seats: [] } })[0].action, "build");
  assert.ok(acts(fx).includes("start"), "a build starts");
  assert.equal(action({ "plan:start": { state: "ready", planRevision: "r", actions: [{ step: "render" }] } })[0].action, "build");
  assert.equal(action({ status: { state: "stopped", server: "sandbox-ingest", seats: [] }, "plan:start": { state: "ready", planRevision: "r", actions: [{ step: "start" }] } })[0].action, "start");
  const none = action({});
  assert.equal(none[0].action, "none");
  assert.deepEqual(acts(fx), ["status", "plan:start", "plan:reconcile", "reconcile"], "none starts nothing, and the seats are still reconciled");
  assert.deepEqual(started(fx), { sandboxesStartedApi: 1, sandboxes: ["ingest"] });
  // Delisted: stopped, through its stop plan, and never destroyed.
  listed(fx, []);
  const stopped = action({});
  assert.equal(stopped[0].action, "stop");
  assert.equal(stopped[0].state, "stopped");
  assert.deepEqual(acts(fx), ["plan:stop", "stop"]);
  assert.deepEqual(started(fx), { sandboxesStartedApi: 1, sandboxes: [] }, "a stop answered stopped drops the name");
});

test("D-S1-1: a sandbox removed from both files is stopped through the started record, with team null, egress [] and credentials []", (t) => {
  const fx = sandboxDeployment({ t });
  ok(fx.cliS(["sync", "--json"]), "sync");
  assert.deepEqual(started(fx).sandboxes, ["ingest"]);
  const doc = fx.workspace();
  delete doc.sandboxes;
  fx.commitWorkspace(doc);
  listed(fx, []);
  fx.sandbox.reset();
  const r = ok(fx.cliS(["sync", "--json"]), "sync after removal");
  assert.deepEqual(acts(fx), ["plan:stop", "stop"]);
  for (const c of fx.sandbox.calls()) {
    assert.equal(c.request.team, null);
    assert.deepEqual(c.request.egress, []);
    assert.deepEqual(c.request.credentials, []);
  }
  assert.equal(r.sandboxes[0].name, "ingest");
  assert.equal(r.sandboxes[0].team, null);
  assert.equal(r.sandboxes[0].action, "stop");
  assert.deepEqual(started(fx).sandboxes, []);
});

test("D-S1-1: an act other than stop for a sandbox no file declares is refused before the hook", (t) => {
  const fx = sandboxDeployment({ t });
  ok(fx.cliS(["sync", "--json"]), "sync");
  fx.sandbox.reset();
  for (const args of [["start", "gone", "--plan"], ["reconcile", "gone", "--plan"]]) {
    const r = fx.cliS(["sandbox", ...args, "--json"]);
    assert.equal(r.status, 1);
    assert.equal(envelope(r).error.code, "E_WORKSPACE_SCHEMA");
    assert.equal(envelope(r).error.details.reason, "sandbox-unknown");
  }
  assert.deepEqual(acts(fx), [], "nothing reached the provider");
});

test("D-S1-1: the name is recorded before the start runs (a start killed in its hook leaves it recorded)", async (t) => {
  const fx = sandboxDeployment({ t });
  fx.sandbox.set({ start: { $sleepMs: 20000 } });
  fx.writeLocal({ host: { name: "cloud-1" }, credentials: { "sources-read": { fromFile: fx.credential } } });
  ok(fx.cliS(["sync", "--json"]), "the lock, with nothing listed");
  listed(fx, ["ingest"]);
  const child = spawn(process.execPath, [CLI, "sandbox", "start", "ingest", "--plan-revision", "rev-start", "--idempotency-key", "k", "--json"], { cwd: fx.dep, env: { ...fx.env, ...fx.sandbox.env }, detached: true });
  const exited = new Promise((done) => child.on("close", done));
  const deadline = Date.now() + 15_000;
  while (!fx.sandbox.calls().some((c) => c.act === "start") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  process.kill(-child.pid, "SIGKILL");
  await exited;
  assert.deepEqual(started(fx), { sandboxesStartedApi: 1, sandboxes: ["ingest"] });
});

test("D-S1-1: a stop answered absent drops the name, which is no failure; a failed stop keeps it, in problems on every sync", (t) => {
  const fx = sandboxDeployment({ t });
  ok(fx.cliS(["sync", "--json"]), "sync");
  listed(fx, []);
  fx.sandbox.set({ stop: { state: "failed", problem: { code: "E_SANDBOX_PROVIDER", reason: "docker", message: "docker is not running" } } });
  for (const round of [1, 2]) {
    const r = fx.cliS(["sync", "--json"]);
    assert.equal(r.status, 1, `round ${round}: a failed sandbox exits 1`);
    const d = envelope(r);
    assert.equal(d.ok, true, "the answer is still the sync's report");
    assert.equal(d.result.problems.filter((p) => p.sandbox === "ingest").length, 1, `round ${round}`);
    assert.deepEqual(started(fx).sandboxes, ["ingest"], `round ${round}: kept`);
  }
  fx.sandbox.set({ stop: { state: "absent" } });
  const r = ok(fx.cliS(["sync", "--json"]), "absent");
  assert.deepEqual(r.problems, []);
  assert.deepEqual(started(fx).sandboxes, []);
});

test("D-S1-1: two concurrent starts of two sandboxes lose no name", async (t) => {
  const fx = sandboxDeployment({ t, workspace: { teams: { "other-team": { team: "other:example.org" } }, sandboxes: { ingest: { team: "ingest-team" }, other: { team: "other-team" } } } });
  fx.writeLocal({ host: { name: "cloud-1" } });
  ok(fx.cliS(["sync", "--json"]), "the lock");
  listed(fx, ["ingest", "other"]);
  fx.sandbox.set({ start: { $sleepMs: 1500 } });
  const run = (name) => new Promise((done) => {
    const child = spawn(process.execPath, [CLI, "sandbox", "start", name, "--plan-revision", "rev-start", "--idempotency-key", name, "--json"], { cwd: fx.dep, env: { ...fx.env, ...fx.sandbox.env } });
    let out = ""; child.stdout.on("data", (b) => { out += b; });
    child.on("close", (status) => done({ status, out }));
  });
  const results = await Promise.all([run("ingest"), run("other")]);
  for (const r of results) assert.equal(r.status, 0, r.out);
  assert.deepEqual(started(fx).sandboxes, ["ingest", "other"]);
});

test("a failed sandbox: in problems, exit 1, the answer ok and the lock written", (t) => {
  const fx = sandboxDeployment({ t });
  fx.sandbox.set({ status: { state: "stopped", seats: [] }, "plan:start": { state: "ready", planRevision: "r", actions: [{ step: "start" }] }, start: { state: "failed", problem: { code: "E_SANDBOX_PROVIDER", reason: "docker", message: "docker is not running" } } });
  const r = fx.cliS(["sync", "--json"]);
  assert.equal(r.status, 1);
  const d = envelope(r);
  assert.equal(d.ok, true);
  assert.equal(d.result.sandboxes[0].state, "failed");
  assert.equal(d.result.problems.length, 1);
  assert.equal(d.result.problems[0].sandbox, "ingest");
  assert.ok(existsSync(join(fx.dep, "oats-lock.json")), "the lock is written");
});

test("C5: sync's sandboxes entries are the status entries plus action; a deployment with none answers as before", (t) => {
  const fx = sandboxDeployment({ t });
  const r = ok(fx.cliS(["sync", "--json"]), "sync");
  assert.deepEqual(r.sandboxes, [{ name: "ingest", team: { label: "ingest-team", id: TEAM_ID }, listedHere: true, state: "ready", server: "sandbox-ingest", egress: ["model"], credentials: [{ name: "sources-read", source: "present" }], problems: [], seats: [], action: "none" }]);
  const status = ok(fx.cliS(["sandbox", "status", "--json"]), "status");
  assert.deepEqual(status, { sandboxApi: 1, host: "cloud-1", sandboxes: [{ name: "ingest", team: { label: "ingest-team", id: TEAM_ID }, listedHere: true, state: "ready", server: "sandbox-ingest", egress: ["model"], credentials: [{ name: "sources-read", source: "present" }], problems: [], seats: [] }] });
  fx.writeLocal({ host: { name: "cloud-1" } });
  const doc = fx.workspace();
  delete doc.sandboxes;
  fx.commitWorkspace(doc);
  listed(fx, []);
  fx.sandbox.set({ stop: { state: "absent" } });
  ok(fx.cliS(["sync", "--json"]), "the recorded one stopped");
  const plain = ok(fx.cliS(["sync", "--json"]), "nothing listed, nothing recorded");
  assert.equal(Object.hasOwn(plain, "sandboxes"), false, "no sandboxes key");
});

for (const [reason, remedy] of [["ssh-include-missing", SSH_INCLUDE_REMEDY], ["state-orphaned", "move the provider's state of ingest from ~/.oats/sandboxes/0123456789abcdef back, or remove it"]]) {
  test(`D-S1-3: status ready with ${reason} is a readiness fact: sync exits 0, no problems, a warning, and the readiness item with the provider's remedy`, (t) => {
    const fx = sandboxDeployment({ t });
    fx.sandbox.set({ status: { state: "ready", server: "sandbox-ingest", seats: [], problem: { code: "E_SANDBOX_PROVIDER", reason, message: `the provider's ${reason}`, remedy } } });
    const r = fx.cliS(["sync", "--json"]);
    assert.equal(r.status, 0, r.stdout);
    const d = envelope(r);
    assert.deepEqual(d.result.problems, []);
    assert.deepEqual(d.result.sandboxes[0].problems, []);
    assert.equal(d.result.sandboxes[0].state, "ready");
    const w = (d.warnings || []).find((x) => x.code === `sandbox-${reason}`);
    assert.ok(w, JSON.stringify(d.warnings));
    assert.equal(w.sandbox, "ingest");
    const status = envelope(fx.cliS(["sandbox", "status", "--json"]));
    assert.deepEqual(status.result.sandboxes[0].problems, []);
    assert.ok(status.warnings.some((x) => x.code === `sandbox-${reason}`));
    const rd = fx.cliS(["readiness", "--soul", "dev", "--json"]);
    assert.equal(rd.status, 0);
    const item = envelope(rd).result.checks.configured.items.find((i) => i.code === `sandbox-${reason}`);
    assert.ok(item, `readiness item sandbox-${reason}`);
    assert.equal(item.remedy, remedy, "the provider's remedy, unchanged");
    assert.equal(item.required, false);
  });
  test(`D-S1-3: status stopped with ${reason}, then a successful start: the advisory is still sync's warning`, (t) => {
    const fx = sandboxDeployment({ t });
    fx.sandbox.set({ status: { state: "stopped", server: "sandbox-ingest", seats: [], problem: { code: "E_SANDBOX_PROVIDER", reason, message: `the provider's ${reason}`, remedy } } });
    const r = fx.cliS(["sync", "--json"]);
    assert.equal(r.status, 0, r.stdout);
    const d = envelope(r);
    assert.equal(d.result.sandboxes[0].action, "start");
    assert.equal(d.result.sandboxes[0].state, "ready");
    assert.deepEqual(d.result.problems, []);
    const w = (d.warnings || []).find((x) => x.code === `sandbox-${reason}`);
    assert.ok(w, JSON.stringify(d.warnings));
    assert.ok(w.message.endsWith(remedy), w.message);
  });
}

test("C10: readiness reports the kernel's items and the provider's, and exits 0", (t) => {
  const fx = sandboxDeployment({ t, workspace: { sandboxes: { ingest: { team: "ingest-team", credentials: ["sources-read", "gh-token"] } } } });
  fx.writeLocal({ host: { name: "cloud-1" } });
  ok(fx.cliS(["sync", "--json"]), "the lock, nothing listed");
  const home = fx.cli(["spawn", "dev", "--no-launch", "--json"]);
  assert.equal(home.status, 0, home.stdout);
  listed(fx, ["ingest"]);
  fx.sandbox.set({ status: { state: "stopped", server: "sandbox-ingest", seats: [{ seatId: "seat-a", instance: "ingester-1", alias: "ingester-1", certificateId: null, state: "mint-uncertain" }, { seatId: "seat-b", instance: "ingester-2", alias: "ingester-2", certificateId: "c", state: "delivered" }, { seatId: "seat-c", instance: "ingester-3", alias: "ingester-3", certificateId: "c3", state: "active" }] } });
  const codes = (r) => { assert.equal(r.status, 0, r.stdout); return envelope(r).result.checks.configured.items.filter((i) => i.code?.startsWith("sandbox-")); };
  const items = codes(fx.cliS(["readiness", "--soul", "dev", "--json"]));
  const by = (code) => items.filter((i) => i.code === code);
  assert.equal(by("sandbox-listed-not-running").length, 1);
  assert.equal(by("sandbox-credential-missing").length, 1, "gh-token has no source");
  assert.match(by("sandbox-credential-missing")[0].subject, /gh-token/);
  assert.equal(by("sandbox-host-agents").length, 1);
  assert.match(by("sandbox-host-agents")[0].reason, /dev-/);
  assert.deepEqual(by("sandbox-seat-unsettled").map((i) => i.subject), ["sandbox ingest seat seat-a", "sandbox ingest seat seat-b"], "mint-uncertain, and delivered with no kept request; active is settled");
  for (const i of items) { assert.equal(i.required, false); assert.equal(i.status, "fail"); }
  // No provider composed.
  fx.commitWorkspace(fx.workspace({ sandboxes: { ingest: { team: "ingest-team" } }, defaults: { knowledge: "none", messaging: "none", tasks: "none", capabilities: { "fixture.sandbox": "off" } } }));
  const none = codes(fx.cliS(["readiness", "--soul", "dev", "--json"]));
  assert.equal(none.filter((i) => i.code === "sandbox-provider-missing").length, 1);
});

test("C7: oats server add|connect refuse a sandbox- id (reserved-prefix); an existing sandbox- entry is read as before", (t) => {
  const fx = sandboxDeployment({ t });
  for (const args of [["server", "add", "sandbox-x", "--ssh", "h", "--workspace", "/w"], ["server", "connect", "sandbox-x", "--ssh", "h", "--dir", "/w"]]) {
    const r = fx.cli([...args, "--json"]);
    assert.equal(r.status, 1, args.join(" "));
    assert.equal(envelope(r).error.code, "E_SERVER_INVALID");
    assert.equal(envelope(r).error.details.reason, "reserved-prefix");
  }
  const servers = join(fx.env.OATS_HOME_DIR, "servers.json");
  mkdirSync(fx.env.OATS_HOME_DIR, { recursive: true });
  writeFileSync(servers, JSON.stringify({ schemaVersion: 1, servers: { "sandbox-x": { sshHost: "h", workspace: "/w" } } }));
  const list = fx.cli(["server", "list", "--json"]);
  assert.equal(list.status, 0, list.stdout);
  assert.ok(JSON.stringify(envelope(list).result).includes("sandbox-x"));
});
