// Sandboxes, the readers of the new fields (docs/design/2026-11-19-sandboxes.md C5; S1 Acceptance 16): the
// kernel's real answers, from a scratch deployment with the fake provider, read the way each consumer
// reads them. Each must take the new fields without refusing the answer.
//
// The readers found (C5 names the first group; the rest were found by grepping for the answers' readers):
//   oats sync --json (`sandboxes`, sandbox rows in `problems`, and the exit 1 of a failed sandbox):
//     packages/client/workspace-cli.mjs:101 cliWorkspace       the exec owner: argv, envelope, the exit rule
//     packages/client/deployment-data.mjs:299 syncData         the sync projector
//     packages/desktop/server/workspace-sync.mjs:41            the Desktop's sync boundary
//     packages/desktop/renderer/workspace-sync-view.mjs:125    the sync sheet, one line per problem's message
//   oats status --json (`placement` on instance rows):
//     packages/client/deployment-read-cli.mjs:58 deploymentReadAnswer  the status exec reader (and the warm route's)
//     packages/client/deployment-data.mjs:182 deploymentStatusData     the roster projector (deployment-observer.mjs:76)
//     lib/servers.mjs:1087 rosterGroups                        the server roster, which relays placement (rowPlacement)
//     packages/client/remote-roster.mjs:94 remoteAgents        the client's remote roster
//     bin/oats.mjs `oats reader --stdio`                       the warm reader
// No reader refuses an unknown field, so the change is additive: no answer's API version moves.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { cliWorkspace } from "../packages/client/workspace-cli.mjs";
import { deploymentStatusData, syncData } from "../packages/client/deployment-data.mjs";
import { deploymentReadAnswer } from "../packages/client/deployment-read-cli.mjs";
import { createWorkspaceSync } from "../packages/desktop/renderer/workspace-sync-view.mjs";
import { sheetDocument, textOf, byClass } from "./helpers/sheet-document.mjs";
import { remoteAgents } from "../packages/client/remote-roster.mjs";
import { createWorkspaceSyncBoundary } from "../packages/desktop/server/workspace-sync.mjs";
import { DESKTOP_TERMS } from "../packages/desktop/renderer/desktop-terms.mjs";
import { rosterGroups } from "../lib/servers.mjs";
import { sandboxDeployment } from "./helpers/sandbox-fixture.mjs";
import { CLI } from "./helpers/v2-deployment.mjs";
import { FAKE_SEAT_CAPABILITY } from "./helpers/fake-sandbox-provider.mjs";

/** `oats sync` the Desktop's way, with the fake's environment → the client's result. */
function clientSync(fx) {
  const probe = fx.cli(["version", "--json"]);
  assert.equal(probe.status, 0, probe.stdout);
  const cli = { ...JSON.parse(probe.stdout), ok: true, bin: CLI };
  const env = { ...fx.env, ...fx.sandbox.env };
  const exec = (bin, argv, options, done) => execFile(process.execPath, [bin, ...argv], { ...options, env }, done);
  return cliWorkspace(cli, { action: "sync", context: fx.dep }, DESKTOP_TERMS, { env, exec });
}

test("readers of oats sync --json's sandboxes: the client's exec and projector, and the Desktop's boundary", async (t) => {
  const fx = sandboxDeployment({ t });
  // A sandbox problem that is no failure of the sync: the delisted sandbox's stop answered absent once
  // started, and an advisory status; the sync exits 0.
  fx.sandbox.set({ status: { state: "ready", server: "sandbox-ingest", seats: [], problem: { code: "E_SANDBOX_PROVIDER", reason: "ssh-include-missing", message: "the Include is missing", remedy: "add it, then rerun oats readiness" } } });
  const result = await clientSync(fx);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(Array.isArray(result.document.result.sandboxes), "the kernel sent sandboxes");
  const report = syncData(result.document, fx.dep);
  assert.equal(report.syncApi, 1);
  assert.ok(report.problems.every((p) => typeof p.message === "string" && p.message), "the sheet shows each problem's message");
  const boundary = createWorkspaceSyncBoundary({ invoke: async () => result });
  const probe = JSON.parse(fx.cli(["version", "--json"]).stdout);
  const answered = await boundary({ action: "sync" }, { workspace: { scope: fx.dep }, cli: { ...probe, ok: true, bin: CLI } });
  assert.equal(answered.status, "ok", JSON.stringify(answered));
  assert.equal(answered.report.syncApi, 1);
});

/** The Desktop's sync sheet (workspace-sync-view.mjs), mounted on a small document, run once against
 *  `answer` (what the boundary answered) → the text a person reads in it. */
async function sheetShows(answer) {
  const doc = sheetDocument();
  const host = doc.createElement("div");
  doc.body.append(host);
  const view = createWorkspaceSync(host, { ctx: { api: async () => answer }, onSynced: () => {} });
  view.update({ status: null, canSync: true });
  byClass(host, "ws-sync-run")[0].click();
  for (let i = 0; i < 50 && !byClass(doc.body, "ws-sync-sheet").some((s) => !s.hidden); i++) await new Promise((r) => setTimeout(r, 10));
  return textOf(doc.body);
}

test("a failed sandbox's sync, the kernel's real answer: ok: true, exit 1, the failure in a sandboxes entry's problems; the client reads it as the report, the boundary and the sheet show it", async (t) => {
  const fx = sandboxDeployment({ t });
  fx.sandbox.set({ status: { state: "stopped", server: "sandbox-ingest", seats: [] }, "plan:start": { state: "ready", planRevision: "r", actions: [{ step: "start" }] },
    start: { state: "failed", problem: { code: "E_SANDBOX_PROVIDER", reason: "docker", message: "docker is not running" } } });
  // The kernel side, as the client's exit rule reads it (packages/client/workspace-cli.mjs sandboxFailureReport).
  const raw = fx.cliS(["sync", "--json"]);
  assert.equal(raw.status, 1, raw.stdout);
  const kernel = raw.json();
  assert.equal(kernel.ok, true);
  assert.ok(kernel.result.sandboxes.some((e) => Array.isArray(e.problems) && e.problems.length > 0), JSON.stringify(kernel.result.sandboxes));
  assert.ok(existsSync(join(fx.dep, "oats-lock.json")), "the lock is written");
  // The same answer through the client: the report, not E_CLI_FAILED.
  fx.sandbox.reset();
  const result = await clientSync(fx);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.document.result.sandboxes[0].problems.length > 0);
  const sandboxProblem = result.document.result.problems.find((p) => p.sandbox === "ingest");
  assert.ok(sandboxProblem, JSON.stringify(result.document.result.problems));
  const report = syncData(result.document, fx.dep);
  assert.ok(report.problems.some((p) => p.code === sandboxProblem.code && p.message === sandboxProblem.message), JSON.stringify(report.problems));
  const answered = await createWorkspaceSyncBoundary({ invoke: async () => result })({ action: "sync" }, { workspace: { scope: fx.dep }, cli: { ...JSON.parse(fx.cli(["version", "--json"]).stdout), ok: true, bin: CLI } });
  assert.equal(answered.status, "ok", JSON.stringify(answered));
  const shown = await sheetShows(answered);
  assert.match(shown, /Synced, with problems/);
  assert.ok(shown.includes(sandboxProblem.message), shown);
});

test("a failed reconcile in sync's seat pass, the kernel's real answer: exit 1, ok: true, the failure in the sandbox's own entry too; the client reads it as the report", async (t) => {
  const fx = sandboxDeployment({ t });
  fx.sandbox.set({ reconcile: { state: "failed", server: "sandbox-ingest", problem: { code: "E_SANDBOX_PROVIDER", reason: "reconcile-failed", message: "cannot reconcile seats", remedy: "check the provider" } } });
  const raw = fx.cliS(["sync", "--json"]);
  assert.equal(raw.status, 1, raw.stdout);
  const kernel = raw.json();
  assert.equal(kernel.ok, true);
  const entry = kernel.result.sandboxes.find((e) => e.name === "ingest");
  assert.ok(entry.problems.some((p) => p.code === "E_SANDBOX_PROVIDER" && p.message.includes("cannot reconcile seats")), JSON.stringify(entry));
  const global = kernel.result.problems.find((p) => p.sandbox === "ingest");
  assert.equal(global.reason, "reconcile-failed");
  assert.match(global.message, /cannot reconcile seats — check the provider/);
  fx.sandbox.reset();
  const result = await clientSync(fx);
  assert.equal(result.ok, true, JSON.stringify(result));
  const answered = await createWorkspaceSyncBoundary({ invoke: async () => result })({ action: "sync" }, { workspace: { scope: fx.dep }, cli: { ...JSON.parse(fx.cli(["version", "--json"]).stdout), ok: true, bin: CLI } });
  assert.equal(answered.status, "ok", JSON.stringify(answered));
  assert.ok((await sheetShows(answered)).includes("cannot reconcile seats"));
});

test("D-S1-3's readiness reasons are no failure: the kernel answers exit 0 with empty problems and a warning, the client reads the report, and the sheet opens on nothing", async (t) => {
  for (const reason of ["ssh-include-missing", "state-orphaned"]) {
    const fx = sandboxDeployment({ t });
    fx.sandbox.set({ status: { state: "ready", server: "sandbox-ingest", seats: [], problem: { code: "E_SANDBOX_PROVIDER", reason, message: `the provider says ${reason}`, remedy: "fix it, then rerun oats readiness" } } });
    const raw = fx.cliS(["sync", "--json"]);
    assert.equal(raw.status, 0, `${reason}: ${raw.stdout}`);
    const kernel = raw.json();
    assert.deepEqual(kernel.result.problems, [], reason);
    assert.deepEqual(kernel.result.sandboxes.flatMap((e) => e.problems), [], reason);
    assert.ok((kernel.warnings || []).some((w) => w.code === `sandbox-${reason}` && w.sandbox === "ingest"), `${reason}: ${JSON.stringify(kernel.warnings)}`);
    fx.sandbox.reset();
    const result = await clientSync(fx);
    assert.equal(result.ok, true, reason);
    assert.deepEqual(syncData(result.document, fx.dep).problems, [], reason);
    assert.equal((await sheetShows({ status: "ok", report: syncData(result.document, fx.dep) })).includes("with problems"), false, reason);
  }
});

test("readers of oats status --json's placement: the client's roster reader, the server roster and the warm reader", async (t) => {
  const fx = sandboxDeployment({ t, souls: { dev: {}, ingester: { soul: { capabilities: { [FAKE_SEAT_CAPABILITY]: { from: "here" } } } } } });
  fx.writeLocal({ host: { name: "cloud-1" } });
  assert.equal(fx.cli(["sync", "--json"]).status, 0);
  fx.writeLocal({ host: { name: "sbx" }, sandbox: { self: "ingest" } });
  const seat = ["--provider", FAKE_SEAT_CAPABILITY, "identity.seat=/srv/seats/seat-77"];
  const preview = fx.cli(["spawn", "ingester", "--purpose", "a", ...seat, "--preview", "--json"]).json().result;
  const applied = fx.cli(["spawn", "ingester", "--purpose", "a", ...seat, "--expect-decision", preview.decision.revision, "--idempotency-key", "k-77", "--no-launch", "--json"]);
  assert.equal(applied.status, 0, applied.stdout);
  const r = fx.cli(["status", "--json"]);
  assert.equal(r.status, 0);
  const status = JSON.parse(r.stdout);
  const kernelRow = status.agents.flatMap((a) => a.instances || [])[0];
  assert.deepEqual(kernelRow.placement, { sandbox: "ingest", seatId: "seat-77" });
  // The client's status exec reader (and the warm route's) admits the answer unchanged.
  assert.deepEqual(deploymentReadAnswer("status", { failed: false, document: status }), { ok: true, document: status });
  // The client's roster reader takes the answer; the row reads as before.
  const roster = deploymentStatusData(status, fx.dep);
  assert.equal(roster.agents.flatMap((a) => a.instances).length, 1);
  // The server roster relays placement as the host answered it; the client's remote roster reads the group.
  const host = { schemaVersion: 1, ok: true, result: status };
  const probe = { schemaVersion: 1, name: "@awebai/oats", version: "0.70.0", desktopApi: 1, harnesses: ["pi"], sessionBackends: ["tmux"], launchOptions: [], remote: ["spawn", "status"], features: ["sandboxes"] };
  const execFileSync = (_bin, argv) => JSON.stringify(String(argv.at(-1)).includes("version --json") ? probe : host);
  const groups = await fx.inEnv(async () => {
    const { writeServers } = await import("../lib/servers.mjs");
    writeServers({ "sandbox-ingest": { sshHost: "sandbox-ingest", workspace: fx.dep } });
    return rosterGroups({ io: { execFileSync, execFileAsync: async (bin, argv) => execFileSync(bin, argv) } });
  });
  const group = (Array.isArray(groups) ? groups : groups.groups).find((g) => g.server === "sandbox-ingest");
  assert.ok(group, JSON.stringify(groups).slice(0, 2000));
  const remoteRow = group.instances.find((i) => i.instance === kernelRow.instance);
  assert.deepEqual(remoteRow?.placement, { sandbox: "ingest", seatId: "seat-77" }, JSON.stringify(group).slice(0, 2000));
  assert.ok(Array.isArray(remoteAgents(group)));
  // The warm reader answers `status` as the CLI does, placement included.
  const reader = spawn(process.execPath, [CLI, "reader", "--stdio"], { cwd: fx.dep, env: fx.env, stdio: ["pipe", "pipe", "ignore"] });
  t.after(() => reader.kill());
  reader.stdin.write(`${JSON.stringify({ id: 1, argv: ["status", "--dir", fx.dep, "--json"] })}\n`);
  // The reader's first frame is its hello (readerApi); the answer is the one with the request's id.
  const frame = await new Promise((done) => createInterface({ input: reader.stdout }).on("line", (l) => { const f = JSON.parse(l); if (f.id === 1) done(f); }));
  reader.stdin.end();
  assert.equal(frame.exit, 0, JSON.stringify(frame).slice(0, 1000));
  const answer = frame.answer;
  const warmRow = answer.agents.flatMap((a) => a.instances || [])[0];
  assert.deepEqual(warmRow.placement, { sandbox: "ingest", seatId: "seat-77" });
});
