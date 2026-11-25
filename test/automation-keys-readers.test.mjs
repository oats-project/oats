// The client readers of the answers KP-15 and KP-16 add keys to (oats-project/oats#2122; the readers are
// listed in its comment 7164756965): each reads by name and must decode the same result with the new keys
// present and absent (the remote roster's reader passes a row's unnamed fields on: the same row, plus the key). `automation` on `oats status --json` and `oats server roster --json` rows and in
// the `spawned` event's data (feature status-automation); `failures` and `failuresTotal` on `oats
// trigger status --json` rows (feature trigger-failure-history). The answers fed here are the kernel's
// own shapes; the two features' own tests pin what the kernel sends.
import test from "node:test";
import assert from "node:assert/strict";
import { deploymentStatusData } from "../packages/client/deployment-data.mjs";
import { remotePanel, remoteAgents } from "../packages/client/remote-roster.mjs";
import { eventsData } from "../packages/desktop/renderer/instance-events-data.mjs";
import { triggerStatus } from "../packages/desktop/renderer/automation-rows.mjs";
import { event, data, target } from "../packages/desktop/test/helpers/instance-events-fixture.mjs";
import { kernelRemoteGroup, kernelRemoteRow } from "../packages/desktop/test/helpers/kernel-remote-row.mjs";

const AUTOMATION = { kind: "schedule", id: "nightly", qualifiedId: "local/nightly" };
/** Every value the kernel can send under `automation`, and values it never sends. */
const AUTOMATIONS = [AUTOMATION, { kind: "trigger", id: "kb/review", qualifiedId: "kb/review" }, null, "schedule:local/nightly", { ...AUTOMATION, extra: true }];

test("packages/client deployment-data: a status row decodes the same with automation present and absent", () => {
  const status = (extra) => deploymentStatusData({ root: "/d/agents", features: ["status-automation"], agents: [{ name: "dev", dir: "/d/agents/dev",
    instances: [{ instance: "dev-1", home: "/d/agents/dev/instances/dev-1", spawnedBy: null, spawnOrigin: "operator", ...extra }] }] }, "/d");
  const absent = status({});
  assert.ok(absent && absent.agents[0].instances.length === 1, "the row is read");
  for (const automation of AUTOMATIONS) assert.deepEqual(status({ automation }), absent, JSON.stringify(automation));
});

test("packages/client remote-roster: a remote row is the same row with automation present and absent, and the key is passed on as relayed", () => {
  const AT = "2026-10-11T12:00:00.000Z";
  const panel = (extra) => remotePanel(kernelRemoteGroup([{ ...kernelRemoteRow(), ...extra }]), AT);
  const agents = (extra) => remoteAgents(kernelRemoteGroup([{ ...kernelRemoteRow(), ...extra }]));
  const absent = panel({}), absentAgents = agents({});
  assert.equal(absent.instances.length, 1, "the row is read");
  assert.ok(!Object.hasOwn(absent.instances[0], "automation"), "a row without the key gains none");
  // remotePanel keeps a row's fields it does not name (`...i`): the row is otherwise identical, and `automation`
  // reaches the panel row exactly as the relaying kernel sent it, which is its own strict read or null
  // (lib/servers.mjs rowAutomation). This reader does not read it again: a view that shows it reads it itself.
  for (const automation of [AUTOMATION, { kind: "trigger", id: "kb/review", qualifiedId: "kb/review" }, null]) {
    const present = panel({ automation });
    const { automation: relayed, ...row } = present.instances[0];
    assert.deepEqual(relayed, automation);
    assert.deepEqual({ ...present, instances: [row] }, absent, JSON.stringify(automation));
    assert.deepEqual(agents({ automation }), absentAgents, JSON.stringify(automation));
  }
});

test("packages/desktop instance-events-data: a spawned event decodes the same with automation present and absent", () => {
  const spawned = (extra) => eventsData(data([event({ data: { agent: "dev", work: "worktree", launched: false, spawnedBy: null, ...extra } })]), target);
  const absent = spawned({});
  assert.ok(absent && absent.events.length === 1 && absent.events[0].kind === "spawned", "the event is read");
  for (const automation of AUTOMATIONS) assert.deepEqual(spawned({ automation }), absent, JSON.stringify(automation));
});

test("packages/desktop automation-rows: a trigger's status decodes the same with failures present and absent", () => {
  const key = "local/kb-review:github.com/acme/knowledge#7:opened:2026-09-26T10:07:00Z";
  const row = (extra) => ({
    id: "local/kb-review", name: "kb-review", enabled: true, runsHere: true, reason: null, enabledHere: true, repo: "github.com/acme/knowledge", soul: "reviewer",
    concurrency: { max: 2, perKey: 1 }, lastPoll: { at: "2026-09-26T12:04:10.000Z", ok: true, prs: 1, matching: 1 }, nextPollAt: "2026-09-26T12:06:10.000Z", nextDue: "2026-09-26T12:06:10.000Z",
    pending: [], fired: [{ key, at: "2026-09-26T12:04:10.000Z", instance: "reviewer-review-pr-7", home: "/d/agents/reviewer/instances/reviewer-review-pr-7", event: "opened", number: 7, subject: "7" }], firedTotal: 1,
    live: [{ instance: "reviewer-review-pr-7", home: "/d/agents/reviewer/instances/reviewer-review-pr-7", repo: "github.com/acme/knowledge", number: 7, subject: "7", event: "opened" }], liveCount: 1,
    lastError: { at: "2026-09-26T12:02:10.000Z", code: "E_SOUL_DISABLED", message: "soul reviewer is disabled on this machine", key },
    ...extra,
  });
  const failure = (attempt, at, more = {}) => ({ attempt, at, key, event: "opened", subject: "7", number: 7, code: "E_SOUL_DISABLED", message: "soul reviewer is disabled on this machine", ...more });
  const resolved = { at: "2026-09-26T12:04:10.000Z", instance: "reviewer-review-pr-7" };
  const status = (extra) => triggerStatus({ triggerApi: 1, scope: "/d", triggers: [row(extra)] }, "local/kb-review", { source: "github.pull_request" });
  const absent = status({});
  assert.ok(absent && absent.fired.length === 1 && absent.lastError.code === "E_SOUL_DISABLED", "the row is read");
  for (const extra of [
    { failures: [], failuresTotal: 0 },
    { failures: [failure(2, "2026-09-26T12:02:10.000Z", { resolved }), failure(1, "2026-09-26T12:00:10.000Z", { resolved })], failuresTotal: 2 },
    { failures: [failure(1, "2026-09-26T12:02:10.000Z", { instance: "reviewer-review-pr-7", home: "/d/agents/reviewer/instances/reviewer-review-pr-7" })], failuresTotal: 120 },
    { failures: "many", failuresTotal: null },
  ]) assert.deepEqual(status(extra), absent, JSON.stringify(extra));
});
