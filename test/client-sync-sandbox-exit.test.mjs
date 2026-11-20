// The client's workspace exec (packages/client/workspace-cli.mjs) and a sync whose sandbox failed (feature
// sandboxes; docs/design/2026-11-19-sandboxes.md C5): the kernel writes the lock and answers its report with
// `ok: true` and exit 1, the failure in a `sandboxes` entry's `problems` (docs/desktop-cli-api.md, `oats
// sync`). That one answer is read as the report; every other exit 1 with `ok: true` stays E_CLI_FAILED, and
// a refusal is unchanged. The Desktop's sync boundary (packages/desktop/server/workspace-sync.mjs) then
// shows the report. The kernel is a scripted `execFile`: this is the reader's rule, not the kernel's.
import test from "node:test";
import assert from "node:assert/strict";
import { cliWorkspace } from "../packages/client/workspace-cli.mjs";
import { createWorkspaceSyncBoundary } from "../packages/desktop/server/workspace-sync.mjs";
import { DESKTOP_TERMS } from "../packages/desktop/renderer/desktop-terms.mjs";

const DEPLOYMENT = "/fixture/deployment";
const CLI = { ok: true, bin: "/fixture/bin/oats", version: "0.70.0", workspaceApi: 2, features: ["workspace-v2", "packages-no-approval", "sandboxes"] };

/** A sync report as the kernel answers it, its sandboxes' entries `entries`. */
const report = (entries, problems = []) => ({ schemaVersion: 1, ok: true, result: {
  syncApi: 1, automations: { triggers: 0, schedules: 0, problems: 0, takenAt: "2026-11-20T09:00:00.000Z" },
  workspace: { name: "acme", key: "github.com/acme/agents", url: "https://github.com/acme/agents.git", commit: "45b86f64", observedAt: "2026-11-20T09:00:00.000Z", local: `${DEPLOYMENT}/oats-local.yaml`, lock: `${DEPLOYMENT}/oats-lock.json` },
  members: [], packages: [], changes: [], problems, warnings: [], ...(entries ? { sandboxes: entries } : {}),
} });
const entry = (problems) => ({ name: "ingest", team: { label: "ingest-team", id: "ingest:example.org" }, listedHere: true, state: problems.length ? "failed" : "ready",
  server: "sandbox-ingest", egress: [], credentials: [], problems, seats: [], action: "start" });
const FAILED = [{ code: "E_SANDBOX_PROVIDER", reason: "docker", message: "docker is not running" }];
const failedSync = () => report([entry(FAILED)], [{ code: "E_SANDBOX_PROVIDER", sandbox: "ingest", message: "sandbox ingest: its start answered failed" }]);

/** An execFile that answers `document` with exit `status`. */
const kernel = (document, status) => (_bin, _argv, _options, done) => done(status ? Object.assign(new Error(`exit ${status}`), { code: status }) : null, JSON.stringify(document));
const run = (action, document, status) => cliWorkspace(CLI, { action, context: DEPLOYMENT }, DESKTOP_TERMS, { exec: kernel(document, status), env: {} });

test("sync with ok: true, exit 1 and a failed sandbox is the report", async () => {
  const doc = failedSync();
  const result = await run("sync", doc, 1);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.document, doc);
});

test("sync with ok: true and exit 1 but no sandbox problem is still E_CLI_FAILED", async () => {
  for (const doc of [report(null), report([]), report([entry([])]), report([{ name: "x", problems: "failed" }])]) {
    const result = await run("sync", doc, 1);
    assert.equal(result.ok, false, JSON.stringify(doc.result.sandboxes));
    assert.equal(result.reason.code, "E_CLI_FAILED");
  }
  // Exit 1 only: any other status, a kill, or a signal is a failure whatever the answer.
  for (const status of [2, 255]) assert.equal((await run("sync", failedSync(), status)).reason?.code, "E_CLI_FAILED", `exit ${status}`);
  const killed = await cliWorkspace(CLI, { action: "sync", context: DEPLOYMENT }, DESKTOP_TERMS, { env: {}, exec: (_b, _a, _o, done) => done(Object.assign(new Error("killed"), { code: 1, killed: true }), JSON.stringify(failedSync())) });
  assert.equal(killed.reason?.code, "E_CLI_TIMEOUT");
});

test("another action with ok: true and exit 1 is still E_CLI_FAILED; a refusal is unchanged", async () => {
  const doc = { schemaVersion: 1, ok: true, result: { capabilitiesApi: 1, capabilities: [], sandboxes: [entry(FAILED)] } };
  for (const action of ["capabilities", "souls"]) {
    const result = await run(action, doc, 1);
    assert.equal(result.ok, false, action);
    assert.equal(result.reason.code, "E_CLI_FAILED", action);
  }
  const refusal = await run("sync", { schemaVersion: 1, ok: false, error: { code: "E_WORKSPACE_SCHEMA", message: "invalid" } }, 1);
  assert.deepEqual(refusal, { ok: false, reason: { code: "E_WORKSPACE_SCHEMA", message: "invalid" } });
  // A success exit with a failed sandbox is a report as before.
  assert.equal((await run("sync", failedSync(), 0)).ok, true);
});

test("the Desktop's sync boundary shows the report of a sync whose sandbox failed", async () => {
  const boundary = createWorkspaceSyncBoundary({ invoke: (cli, options) => cliWorkspace(cli, options, DESKTOP_TERMS, { exec: kernel(failedSync(), 1), env: {} }) });
  const answered = await boundary({ action: "sync" }, { workspace: { scope: DEPLOYMENT }, cli: CLI });
  assert.equal(answered.status, "ok", JSON.stringify(answered));
  assert.equal(answered.report.syncApi, 1);
  assert.deepEqual(answered.report.problems, [{ code: "E_SANDBOX_PROVIDER", message: "sandbox ingest: its start answered failed" }], "the sheet lists the sandbox's failure");
});
