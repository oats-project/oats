// Sandboxes, the readers of the new fields (docs/design/2026-11-19-sandboxes.md C5; S1 Acceptance 16):
// the kernel's real answers, from a scratch deployment with the fake provider, read the way each consumer
// reads them — `oats sync --json`'s `sandboxes` and its sandbox problems by the client's workspace exec
// (packages/client/workspace-cli.mjs), its sync projector (deployment-data.mjs syncData), the Desktop's
// sync boundary (packages/desktop/server/workspace-sync.mjs) and the sheet's data (the renderer,
// workspace-sync-view.mjs, shows each report problem's message); `oats status --json`'s `placement` by
// the client's roster reader (deploymentStatusData), the server roster (lib/servers.mjs rosterGroups,
// which the client's remote roster reads) and the warm reader (`oats reader --stdio`). Each must take the
// new fields without refusing the answer. A sync that exits 1 with `ok: true` (a failed sandbox) is the
// client reader fix's, in its own change.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { cliWorkspace } from "../packages/client/workspace-cli.mjs";
import { deploymentStatusData, syncData } from "../packages/client/deployment-data.mjs";
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

test("readers of oats sync --json's sandboxes: the client's exec and projector, the Desktop's boundary and its sheet", async (t) => {
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

test("a sandbox problem in sync's problems (no repoKey, no path) is projected with its code and message", async (t) => {
  const fx = sandboxDeployment({ t });
  const first = await clientSync(fx);
  assert.equal(first.ok, true);
  // The kernel's own answer, with the problem row a failed sandbox adds (code, sandbox, message).
  const doc = { schemaVersion: 1, ok: true, result: { ...first.document.result, problems: [{ code: "E_SANDBOX_PROVIDER", sandbox: "ingest", message: "sandbox ingest: its start answered failed" }] } };
  const report = syncData(doc, fx.dep);
  assert.deepEqual(report.problems, [{ code: "E_SANDBOX_PROVIDER", message: "sandbox ingest: its start answered failed" }]);
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
