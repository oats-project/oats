// Needs input, where the kernel's answers meet the Desktop's readers. These tests live in the
// root suite because they need the kernel: the Desktop's own tests run without it (#577).
//
// awebai/oats#582: the remote roster relays `waitingOnYou`, and the Desktop shows it.
// `rosterGroups` relays the key only when the host's status row has it, through the kernel's
// own read rule; the end-to-end half feeds that REAL `rosterGroups` output into the Desktop's
// `remotePanel` and then its `waitingClaim`.
//
// awebai/oats#583: the kernel's events read for a home addressed through a symlink goes
// through the Desktop's strict `eventsData`, which requires every row's `home` to be the home
// it asked about.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent, readEvents, recordStartBoundary, setWaiting } from "../lib/instance-events.mjs";
import { REMOTE_ROW_FACTS, rosterGroups, writeServers } from "../lib/servers.mjs";
import { eventsData } from "../packages/desktop/renderer/instance-events-data.mjs";
import { remotePanel } from "../packages/client/remote-roster.mjs";
import { waitingClaim } from "../packages/client/waiting-on-you.mjs";
/** The time a remote panel is made at: remotePanel reads no clock, its caller gives the time. */
const AT = "2026-10-11T12:00:00.000Z";

const base = mkdtempSync("/tmp/oats-rw-");
const prevHomeDir = process.env.OATS_HOME_DIR;
process.env.OATS_HOME_DIR = join(base, "oh");
test.after(() => {
  if (prevHomeDir === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = prevHomeDir;
  rmSync(base, { recursive: true, force: true });
});

const PROBE = { schemaVersion: 1, name: "@awebai/oats", version: "0.69.15", desktopApi: 1, harnesses: ["claude"], sessionBackends: ["tmux"], launchOptions: [], remote: ["session"], features: ["harness", "waiting-on-you"] };
const HOME = (name) => `/srv/ws/agents/dev/instances/${name}`;
const CLAIM = { since: "2026-10-03T12:00:00.000Z", producer: "oats.core", reason: "permission", message: "Which branch?" };
/** A running row as a host's `oats status --json` reports it; `extra` adds or omits `waitingOnYou`. */
const hostRow = (name, extra = {}) => ({ instance: name, home: HOME(name), harness: "claude", running: true, tmux: { session: "oats-agents", window: name }, ...extra });

/** The one group `rosterGroups` builds from a fake host answering `status --json` with `rows`,
 *  plus a saved route (`dev-gone`) the host does not list. */
async function roster(rows, { server = "build" } = {}) {
  writeServers({ [server]: { sshHost: `${server}-host`, workspace: "/srv/ws" } });
  const snapDir = join(process.env.OATS_HOME_DIR, "remote", server);
  mkdirSync(snapDir, { recursive: true });
  writeFileSync(join(snapDir, "dev-gone.json"), JSON.stringify({ serverId: server, instance: "dev-gone", agent: "dev", home: HOME("dev-gone"), agentsRoot: "/srv/ws/agents", target: { sshHost: `${server}-host`, workspace: "/srv/ws", oatsPath: "oats" } }));
  const status = { root: "/srv/ws/agents", agents: [{ name: "dev", harness: "claude", instances: rows }] };
  const exec = async (_bin, argv) => (String(argv.at(-1)).endsWith("version --json") ? JSON.stringify(PROBE) : JSON.stringify(status));
  try {
    const out = await rosterGroups({ server, io: { execFileAsync: exec, serverId: `${server}-${Math.random()}` } });
    assert.equal(out.groups.length, 1); assert.deepEqual(out.groups[0].probe, { ok: true, features: null, sessionViewer: null }, "a status without features: unknown");
    return out.groups[0];
  } finally { rmSync(snapDir, { recursive: true, force: true }); }
}
const rowOf = (group, name) => group.instances.find((r) => r.instance === name);

test("rosterGroups relays a host row's waitingOnYou: the claim as the host read it, null when it has none", async () => {
  const g = await roster([hostRow("dev-a", { waitingOnYou: CLAIM }), hostRow("dev-b", { waitingOnYou: null })]);
  assert.deepEqual(rowOf(g, "dev-a").waitingOnYou, CLAIM);
  assert.ok(Object.hasOwn(rowOf(g, "dev-b"), "waitingOnYou")); assert.equal(rowOf(g, "dev-b").waitingOnYou, null);
  // The rest of the row is what it was.
  const { waitingOnYou: _relayed, ...rest } = rowOf(g, "dev-a");
  assert.deepEqual(Object.keys(rest).sort(), Object.keys(rowOf(await roster([hostRow("dev-a")]), "dev-a")).sort());
});

test("rosterGroups: a host whose kernel does not report waitingOnYou gives a row with NO key, and a saved route the host does not list never has one", async () => {
  const g = await roster([hostRow("dev-old"), hostRow("dev-a", { waitingOnYou: CLAIM })]);
  assert.equal(Object.hasOwn(rowOf(g, "dev-old"), "waitingOnYou"), false, "absent stays absent: not reported is not null");
  const gone = rowOf(g, "dev-gone");
  assert.equal(gone.missingRemotely, true);
  assert.equal(Object.hasOwn(gone, "waitingOnYou"), false);
  assert.equal(REMOTE_ROW_FACTS.includes("waitingOnYou"), false, "it is not a fact that reads null when missing");
});

test("rosterGroups relays a validated shape, by the kernel's own read rule: a value that is not a claim is null; a bad reason or message is null inside a claim that still counts", async () => {
  const notClaims = {
    "a string": "yes", "true": true, "a number": 1, "an array": [CLAIM], "an empty object": {},
    "no since": { producer: "oats.core", reason: "permission" },
    "a since that is not a date": { ...CLAIM, since: "soon" },
    "a since that is not a string": { ...CLAIM, since: 1759492800000 },
    "no producer": { since: CLAIM.since, reason: "permission" },
    "a producer the writer refuses": { ...CLAIM, producer: "Bad Producer!" },
    "a producer with an escape": { ...CLAIM, producer: "evil\u001b[2J" },
    "a producer that is not a string": { ...CLAIM, producer: ["agent"] },
  };
  const names = Object.keys(notClaims);
  const g = await roster(names.map((why, i) => hostRow(`bad-${i}`, { waitingOnYou: notClaims[why] })));
  names.forEach((why, i) => {
    const row = rowOf(g, `bad-${i}`);
    assert.ok(Object.hasOwn(row, "waitingOnYou"), why); assert.equal(row.waitingOnYou, null, why);
  });

  const kept = await roster([
    hostRow("odd-reason", { waitingOnYou: { ...CLAIM, reason: "because" } }),
    hostRow("odd-message", { waitingOnYou: { ...CLAIM, message: "two\nlines" } }),
    hostRow("long-message", { waitingOnYou: { ...CLAIM, message: "x".repeat(201) } }),
    hostRow("no-message", { waitingOnYou: { since: CLAIM.since, producer: "agent", reason: "attention" } }),
    hostRow("extra-keys", { waitingOnYou: { ...CLAIM, token: "s3cret", waiting: true } }),
    hostRow("kernel", { waitingOnYou: { ...CLAIM, producer: "kernel" } }),
  ]);
  assert.deepEqual(rowOf(kept, "odd-reason").waitingOnYou, { ...CLAIM, reason: null });
  assert.deepEqual(rowOf(kept, "odd-message").waitingOnYou, { ...CLAIM, message: null });
  assert.deepEqual(rowOf(kept, "long-message").waitingOnYou, { ...CLAIM, message: `${"x".repeat(199)}…` }, "cut to 200 code points by the same read rule");
  assert.deepEqual(rowOf(kept, "no-message").waitingOnYou, { since: CLAIM.since, producer: "agent", reason: "attention", message: null });
  assert.deepEqual(rowOf(kept, "extra-keys").waitingOnYou, CLAIM, "exactly since, producer, reason, message");
  assert.deepEqual(rowOf(kept, "kernel").waitingOnYou, { ...CLAIM, producer: "kernel" }, "the local read admits kernel, so the relay does");
});

// ---- end to end: the kernel's roster, the Desktop's panel, the Desktop's gate ----
const panelRows = async (rows) => Object.fromEntries(remotePanel(await roster(rows), AT).instances.map((r) => [r.instance, r]));

test("end to end: the Desktop's remote panel carries the claim rosterGroups relayed, and leaves it out when the host did not report one", async () => {
  const rows = await panelRows([hostRow("dev-a", { waitingOnYou: CLAIM }), hostRow("dev-b", { waitingOnYou: null }), hostRow("dev-old"), hostRow("dev-bad", { waitingOnYou: "yes" })]);
  assert.deepEqual(rows["dev-a"].waitingOnYou, CLAIM);
  assert.equal(rows["dev-a"].running, true); assert.equal(rows["dev-a"].serverUnreached, false); assert.equal(rows["dev-a"].runtimeState, null);
  assert.equal(rows["dev-b"].waitingOnYou, null);
  assert.equal(Object.hasOwn(rows["dev-old"], "waitingOnYou"), false);
  assert.equal(rows["dev-bad"].waitingOnYou, null);
  assert.equal(Object.hasOwn(rows["dev-gone"], "waitingOnYou"), false);
  // No claim shows where none was relayed.
  for (const name of ["dev-b", "dev-old", "dev-bad", "dev-gone"]) assert.equal(waitingClaim(rows[name]), null, name);
});

// The gate's half is the Desktop's (awebai/oats#582, #587): a remote row's `runtimeState` is null
// unless the host said "unreachable" or "unsupported", and the gate reads null as "not reported".
test("end to end: the Desktop shows the relayed claim on a running remote row (waitingClaim)", async () => {
  const rows = await panelRows([hostRow("dev-a", { waitingOnYou: CLAIM }), hostRow("dev-stopped", { running: false, waitingOnYou: CLAIM })]);
  assert.equal(rows["dev-a"].runtimeState, null, "the kernel's remote row reports no runtime state");
  assert.deepEqual(waitingClaim(rows["dev-a"]), CLAIM);
  assert.equal(waitingClaim(rows["dev-stopped"]), null, "a row that is not running shows none");
  // A host that says the session is unreachable: the claim is relayed, and the gate hides it.
  const unreachable = (await panelRows([hostRow("dev-u", { running: null, runtimeState: "unreachable", runtimeError: "tmux", waitingOnYou: CLAIM })]))["dev-u"];
  assert.deepEqual(unreachable.waitingOnYou, CLAIM); assert.equal(waitingClaim(unreachable), null);
});

// ---- #583: the events read, addressed through a symlink, through the Desktop's reader ----
test("end to end: the kernel's events read for a symlink-spelled home is accepted by the Desktop's eventsData, the session's real-path rows included", () => {
  const dir = realpathSync(mkdtempSync(join(base, "ev-")));
  const real = join(dir, "real", "agents", "dev", "instances", "dev-1"), lexical = join(dir, "sym", "agents", "dev", "instances", "dev-1");
  mkdirSync(real, { recursive: true }); symlinkSync(join(dir, "real"), join(dir, "sym"));
  const createdAt = "2026-10-01T00:00:00.000Z";
  writeFileSync(join(real, "instance.json"), JSON.stringify({ agent: "dev", instance: "dev-1", home: lexical, createdAt, modules: {}, workspace: { deployment: join(dir, "sym") } }));
  // The spawn addressed the home through the symlink; the session carries the real path.
  assert.equal(appendEvent(lexical, { kind: "spawned", data: { agent: "dev", work: "directory", branch: null, harness: "claude", model: null, parentInstance: null, relation: null, launched: true } }).ok, true);
  assert.equal(recordStartBoundary(real, { startId: "start-1", startedAt: new Date().toISOString(), harness: "claude", backend: "tmux", launchConfig: null, phase: "start" }).ok, true);
  setWaiting(real, { producer: "oats.core", waiting: true, reason: "permission" });
  setWaiting(real, { producer: "agent", waiting: true, reason: "attention", message: "Which branch?" });
  assert.ok(readFileSync(join(real, ".oats-events.jsonl"), "utf8").trim().split("\n").every((l) => JSON.parse(l).home === real), "stored under the real path");

  // The Desktop's target: the home of the STATUS row, which is the lexical one.
  const target = (home) => ({ workspace: "fixture", context: join(dir, "sym"), selector: { instance: "dev-1", agent: "dev", agentsRoot: join(dir, "sym", "agents"), server: null }, home, incarnation: createdAt });
  const data = eventsData(readEvents(lexical, { limit: 100 }), target(lexical), 100);
  assert.notEqual(data, null, "the Desktop accepts the answer");
  assert.equal(data.home, lexical);
  assert.deepEqual(data.events.map((e) => [e.kind, e.producer, e.home]), [["spawned", "kernel", lexical], ["launched", "kernel", lexical], ["waiting", "oats.core", lexical], ["waiting", "agent", lexical]]);
  assert.equal(data.integrity.foreignRows, 0, "the session's rows are this home's history, not foreign");
  assert.deepEqual({ producer: data.waitingOnYou.producer, reason: data.waitingOnYou.reason, message: data.waitingOnYou.message }, { producer: "agent", reason: "attention", message: "Which branch?" });
  // The reader IS strict about it: the same history answered in another spelling than the target's is refused.
  assert.equal(eventsData(readEvents(real, { limit: 100 }), target(lexical), 100), null);
  assert.notEqual(eventsData(readEvents(real, { limit: 100 }), target(real), 100), null);
});
