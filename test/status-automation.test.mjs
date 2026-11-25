// Feature status-automation (oats-project/oats#2122, KP-16): the schedule or trigger that made an instance.
// A tick's spawn passes the internal `--made-by-automation <schedule|trigger>:<qualifiedId>`; the kernel
// records `automation: { kind, id, qualifiedId }` in instance.json, on the `spawned` event and on the
// status row, only for an automation this deployment has and only when no instance ran the spawn
// (`spawnedBy` null): at most one of the two is set. It is a label, read by one strict rule. The remote
// roster relays it only from a host that lists the feature. Real spawns (--no-launch), a real tmux
// server on a private socket for the live spawner, and a fake `gh` for the trigger's poll.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v2Deployment } from "./helpers/v2-deployment.mjs";
import { fixtureBase } from "./helpers/host-fixture.mjs";
import { findRetirementBaseline } from "../lib/session-inspect.mjs";
import { KERNEL_FEATURES } from "../lib/kernel-features.mjs";
import { madeByAutomationFlag, parseMadeByAutomation, readAutomation } from "../lib/made-by-automation.mjs";
import { rosterGroups, writeServers } from "../lib/servers.mjs";

const S = await import("../lib/schedule.mjs");
const T = await import("../lib/triggers.mjs");

const base = realpathSync(mkdtempSync(join(tmpdir(), "oats-automation-")));
const sock = join(base, "agents.sock");
const tmux = (...args) => execFileSync("tmux", ["-f", "/dev/null", "-u", "-S", sock, ...args], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }).trim();
const fx = v2Deployment({ souls: { dev: { soul: {} } } });
// A fake `gh` that lists one open pull request, for the trigger's poll, and is logged in as kb-bot (the
// owner of the workspace trigger below).
const ghBin = join(base, "bin"); mkdirSync(ghBin);
writeFileSync(join(ghBin, "gh"), `#!/bin/sh
case "$*" in
  "auth status"*) printf '%s\\n' "github.com" "  ✓ Logged in to github.com account kb-bot (keyring)" "  - Active account: true"; exit 0 ;;
  "api user"*) echo kb-bot; exit 0 ;;
  *"/pulls"*) echo '[{"number":7,"html_url":"https://github.com/acme/knowledge/pull/7","title":"t","body":"","draft":false,"head":{"sha":"07aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ref":"h"},"base":{"ref":"main"},"labels":[],"state":"open","updated_at":"2026-09-26T11:59:00Z","created_at":"2026-09-26T11:58:00Z"}]'; exit 0 ;;
esac
echo "unexpected gh $*" >&2; exit 2
`);
chmodSync(join(ghBin, "gh"), 0o755);
fx.env.PATH = `${ghBin}:${fx.env.PATH}`;
test.after(() => {
  // The private server ends with its only session.
  try { tmux("kill-session", "-t", "=oats-agents"); } catch { /* gone */ }
  rmSync(base, { recursive: true, force: true }); fx.cleanup();
});

const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const record = (home) => read(join(home, "instance.json"));
function cli(args, env = {}) {
  const r = fx.cli([...args, "--json"], { env: { TMUX: undefined, OATS_INSTANCE: undefined, OATS_INSTANCE_HOME: undefined, OATS_HOME: undefined, OATS_SPAWNER_HOME: undefined, ...env } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const doc = JSON.parse(r.stdout);
  return doc.ok === true ? doc.result : doc;
}
const spawn = (name, flags = [], env = {}) => cli(["spawn", "dev", "--name", name, "--no-launch", ...flags], env);
const rows = () => Object.fromEntries(cli(["status"]).agents.flatMap((a) => a.instances).map((i) => [i.instance, i]));
const spawnedEvent = (home) => readFileSync(join(home, ".oats-events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.kind === "spawned");
/** What one spawn recorded as its automation: the record, the event and the status row agree. */
function automationOf(child) {
  const meta = record(child.home);
  assert.ok(Object.hasOwn(meta, "automation"), "instance.json always records automation");
  assert.deepEqual(spawnedEvent(child.home).data.automation, meta.automation, "the spawned event carries the record's automation");
  assert.deepEqual(rows()[child.instance].automation, meta.automation, "the status row carries the record's automation");
  assert.ok(meta.automation === null || meta.spawnedBy === null, "at most one of spawnedBy and automation is set");
  return meta.automation;
}
/** Run `fn` in the fixture's environment as if from inside `caller`'s session (its instance environment set). */
const asInstance = (caller, fn) => fx.inEnv(() => {
  const saved = { OATS_INSTANCE: process.env.OATS_INSTANCE, OATS_INSTANCE_HOME: process.env.OATS_INSTANCE_HOME, PATH: process.env.PATH };
  Object.assign(process.env, { OATS_INSTANCE: caller.instance, OATS_INSTANCE_HOME: caller.home, PATH: fx.env.PATH });
  try { return fn(); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});

const NIGHTLY = { kind: "schedule", id: "nightly", qualifiedId: "local/nightly" };
const KB_REVIEW = { kind: "trigger", id: "local/kb-review", qualifiedId: "local/kb-review" };
let live;
test.before(async () => {
  await fx.inEnv(() => S.addSchedule(fx.dep, { id: "nightly", kind: "spawn", agent: "dev", task: "Nightly work.", cron: "0 3 * * *", tz: "UTC" }));
  const file = join(base, "trigger.json");
  writeFileSync(file, JSON.stringify({ id: "kb-review", enabled: true, kind: "trigger", on: { source: "github.pull_request", repo: "github.com/acme/knowledge", events: ["opened"], poll: "2m" }, spawn: { soul: "dev", purpose: "review-pr-{number}", task: "Review {repo}#{number}." }, concurrency: { max: 5, perKey: 1 } }));
  cli(["trigger", "add", "--file", file]);
  // A live instance: launched in a window of the deployment's tmux server, so a spawn it runs has a spawner.
  tmux("new-session", "-d", "-s", "oats-agents", "-n", "live", "sleep 600");
  live = spawn("live");
  const tmuxRec = { session: "oats-agents", window: "live", socket: sock };
  writeFileSync(join(live.home, "instance.json"), JSON.stringify({ ...record(live.home), launched: true, tmux: tmuxRec }, null, 2) + "\n");
  const baseline = findRetirementBaseline(live.home);
  writeFileSync(baseline, JSON.stringify({ ...read(baseline), runtime: { launched: true, tmux: tmuxRec } }, null, 2) + "\n", { mode: 0o600 });
});

test("the kernel lists the feature, and the lists give the ids a record holds", () => {
  assert.ok(KERNEL_FEATURES.includes("status-automation"));
  const schedule = cli(["schedule", "list"]).schedules.find((s) => s.qualifiedId === "local/nightly");
  assert.deepEqual([schedule.id, schedule.qualifiedId], [NIGHTLY.id, NIGHTLY.qualifiedId], "a local schedule's id is bare");
  const trigger = cli(["trigger", "list"]).triggers.find((s) => s.qualifiedId === "local/kb-review");
  assert.deepEqual([trigger.id, trigger.qualifiedId], [KB_REVIEW.id, KB_REVIEW.qualifiedId], "a trigger's id is qualified");
});

test("the read is strict: exactly { kind, id, qualifiedId } of the automations' ids, anything else null", () => {
  assert.deepEqual(readAutomation({ ...NIGHTLY }), NIGHTLY);
  assert.deepEqual(readAutomation({ ...KB_REVIEW }), KB_REVIEW);
  assert.deepEqual(readAutomation({ kind: "schedule", id: "kb/nightly", qualifiedId: "kb/nightly" }), { kind: "schedule", id: "kb/nightly", qualifiedId: "kb/nightly" }, "a workspace automation's id is qualified");
  for (const bad of [null, undefined, "schedule:local/nightly", [], {}, { ...NIGHTLY, extra: 1 }, { kind: "schedule", id: "nightly" }, { ...NIGHTLY, kind: "wake" }, { ...NIGHTLY, kind: "Schedule" },
    { ...NIGHTLY, id: 7 }, { ...NIGHTLY, id: "other" }, { ...NIGHTLY, qualifiedId: "nightly" }, { ...NIGHTLY, qualifiedId: "a/b/c" }, { kind: "schedule", id: "kb/nightly", qualifiedId: "local/nightly" },
    { kind: "schedule", id: "night\nly", qualifiedId: "local/night\nly" }, { kind: "schedule", id: "n".repeat(129), qualifiedId: `local/${"n".repeat(129)}` }, { kind: "schedule", id: "a b", qualifiedId: "local/a b" }]) {
    assert.equal(readAutomation(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(parseMadeByAutomation("trigger:local/kb-review"), { kind: "trigger", qualifiedId: "local/kb-review" });
  assert.equal(madeByAutomationFlag("schedule", "local/nightly"), "--made-by-automation=schedule:local/nightly");
  for (const bad of [undefined, true, "", "nightly", "schedule:nightly", "wake:local/nightly", "schedule:local/a b", "schedule:local/nightly\n", "schedule:a/b/c"]) assert.equal(parseMadeByAutomation(bad), null, JSON.stringify(bad));
});

test("a spawn that names a schedule or a trigger of this deployment records it; a person's spawn records null", () => {
  assert.deepEqual(automationOf(spawn("by-schedule", ["--made-by-automation", "schedule:local/nightly"])), NIGHTLY);
  assert.deepEqual(automationOf(spawn("by-trigger", ["--made-by-automation=trigger:local/kb-review"])), KB_REVIEW);
  const person = spawn("by-person");
  assert.equal(automationOf(person), null);
  assert.equal(record(person.home).spawnedBy, null, "a person's spawn: both null");
});

test("an automation this deployment does not have, one of the other kind and a malformed value are not recorded, and refuse nothing", () => {
  for (const [name, value] of [["unknown-id", "schedule:local/gone"], ["wrong-kind-a", "trigger:local/nightly"], ["wrong-kind-b", "schedule:local/kb-review"], ["other-member", "schedule:kb/nightly"], ["malformed", "nightly"], ["bad-kind", "wake:local/nightly"]]) {
    assert.equal(automationOf(spawn(name, ["--made-by-automation", value])), null, value);
  }
  const r = fx.cli(["spawn", "dev", "--name", "no-value", "--no-launch", "--made-by-automation", "--json"]);
  assert.equal(r.json().error.code, "E_BAD_ARGS", "the flag with no value is a usage error, as every value flag");
});

test("a spawn an instance runs records its spawner and no automation, whatever flag it is given", () => {
  const child = spawn("from-live", ["--made-by-automation", "schedule:local/nightly"], { OATS_INSTANCE: live.instance, OATS_INSTANCE_HOME: live.home });
  assert.equal(automationOf(child), null);
  assert.deepEqual(record(child.home).spawnedBy, { instance: "live", home: realpathSync(live.home) });
});

test("a schedule's run records the schedule, also when the run itself is started from inside an instance", async () => {
  const { run: plain } = await fx.inEnv(() => S.runNow(fx.dep, "nightly", { now: new Date("2026-09-26T03:00:00Z"), io: { noLaunch: true } }));
  assert.deepEqual(automationOf(plain), NIGHTLY);
  // An agent runs the schedule: the run's child drops the caller's instance environment
  // (lib/automation-scope.mjs childEnv), so no instance is its spawner and the schedule is recorded.
  // (A second schedule: the first one's slot is held by the run above.)
  await fx.inEnv(() => S.addSchedule(fx.dep, { id: "hourly", kind: "spawn", agent: "dev", task: "Hourly work.", cron: "0 * * * *", tz: "UTC" }));
  const { run: inside } = await asInstance(live, () => S.runNow(fx.dep, "hourly", { now: new Date("2026-09-26T03:00:00Z"), io: { noLaunch: true } }));
  assert.ok(inside.home && inside.home !== plain.home, JSON.stringify(inside));
  assert.deepEqual(automationOf(inside), { kind: "schedule", id: "hourly", qualifiedId: "local/hourly" });
  assert.deepEqual([record(inside.home).spawnedBy, record(inside.home).spawnOrigin], [null, "operator"]);
});

test("a trigger's tick records the trigger, also when the tick itself runs inside an instance", async () => {
  const fired = await asInstance(live, () => T.tickTriggers(fx.dep, { now: new Date("2026-09-26T12:00:10Z"), io: { noLaunch: true } }));
  assert.deepEqual(fired.map((r) => r.action), ["fired"], JSON.stringify(fired));
  assert.deepEqual(automationOf(fired[0]), KB_REVIEW);
  assert.deepEqual([record(fired[0].home).spawnedBy, record(fired[0].home).spawnOrigin], [null, "operator"]);
});

test("a workspace trigger's tick records its qualified id", async (t) => {
  const trigger = { kind: "oats-trigger", schemaVersion: 1, description: "Review PRs", runsOn: "kb-host", owner: "github.com/kb-bot",
    on: { source: "github.pull_request", repo: "github.com/acme/knowledge", events: ["opened"], poll: "2m" }, spawn: { soul: "dev", purpose: "review-pr-{number}", task: "Review {repo}#{number}." } };
  const ws = v2Deployment({ t, souls: { dev: { soul: {} } }, local: { host: { name: "kb-host" }, automations: { trust: ["ws/kb-review"] } }, files: { "oats-triggers/kb-review.yaml": { yaml: trigger } } });
  ws.env.PATH = `${ghBin}:${ws.env.PATH}`;
  assert.equal(ws.cli(["sync", "--json"]).json().ok, true);
  const fired = await ws.inEnv(() => {
    const path = process.env.PATH;
    process.env.PATH = ws.env.PATH;
    try { return T.tickTriggers(ws.dep, { now: new Date("2026-09-26T12:00:10Z"), io: { noLaunch: true }, ctx: S.scopeAutomations(ws.dep, {}) }); } finally { process.env.PATH = path; }
  });
  assert.deepEqual(fired.map((r) => r.action), ["fired"], JSON.stringify(fired));
  const made = { kind: "trigger", id: "ws/kb-review", qualifiedId: "ws/kb-review" };
  assert.deepEqual(record(fired[0].home).automation, made);
  const row = JSON.parse(ws.cli(["status", "--json"]).stdout).agents.flatMap((a) => a.instances).find((i) => i.instance === fired[0].instance);
  assert.deepEqual(row.automation, made);
  const listed = ws.cli(["trigger", "list", "--json"]).json().result.triggers.find((x) => x.qualifiedId === "ws/kb-review");
  assert.deepEqual([listed.id, listed.qualifiedId], [made.id, made.qualifiedId], "the ids the list gives");
});

test("a workspace schedule's run records its qualified id, as the list gives it", async (t) => {
  const schedule = { kind: "oats-schedule", schemaVersion: 1, description: "Nightly work", runsOn: "kb-host", owner: "github.com/kb-bot", cron: "0 3 * * *", tz: "UTC", run: "spawn", agent: "dev", task: "Nightly work." };
  const ws = v2Deployment({ t, souls: { dev: { soul: {} } }, local: { host: { name: "kb-host" }, automations: { trust: ["ws/nightly"] } }, files: { "oats-schedules/nightly.yaml": { yaml: schedule } } });
  ws.env.PATH = `${ghBin}:${ws.env.PATH}`;
  assert.equal(ws.cli(["sync", "--json"]).json().ok, true);
  const { run } = await ws.inEnv(() => {
    const path = process.env.PATH;
    process.env.PATH = ws.env.PATH;
    try { return S.runNow(ws.dep, "ws/nightly", { now: new Date("2026-09-26T03:00:00Z"), io: { noLaunch: true }, ctx: S.scopeAutomations(ws.dep, {}) }); } finally { process.env.PATH = path; }
  });
  assert.ok(run?.home, JSON.stringify(run));
  const made = { kind: "schedule", id: "ws/nightly", qualifiedId: "ws/nightly" };
  assert.deepEqual(record(run.home).automation, made);
  const listed = ws.cli(["schedule", "list", "--json"]).json().result.schedules.find((x) => x.qualifiedId === "ws/nightly");
  assert.deepEqual([listed.id, listed.qualifiedId], [made.id, made.qualifiedId], "a workspace schedule's id is qualified");
});

test("a deleted automation's row keeps the ids it was made with", async () => {
  await fx.inEnv(() => S.addSchedule(fx.dep, { id: "weekly", kind: "spawn", agent: "dev", task: "Weekly work.", cron: "0 3 * * 1", tz: "UTC" }));
  const child = spawn("by-weekly", ["--made-by-automation", "schedule:local/weekly"]);
  cli(["schedule", "remove", "weekly"]);
  assert.deepEqual(automationOf(child), { kind: "schedule", id: "weekly", qualifiedId: "local/weekly" });
});

test("automation on a row is the record's only in its shape; a home spawned before the feature reads null", () => {
  const handEdited = (name, change) => {
    const { home, instance } = spawn(name, ["--made-by-automation", "schedule:local/nightly"]);
    const meta = record(home);
    change(meta);
    writeFileSync(join(home, "instance.json"), JSON.stringify(meta, null, 2) + "\n");
    return instance;
  };
  const extra = handEdited("edited-extra", (m) => { m.automation = { ...NIGHTLY, proof: true }; });
  const text = handEdited("edited-text", (m) => { m.automation = "schedule:local/nightly"; });
  const older = handEdited("older-home", (m) => { delete m.automation; });
  const now = rows();
  assert.deepEqual([now[extra].automation, now[text].automation, now[older].automation], [null, null, null]);
  assert.ok(Object.hasOwn(now[older], "automation"), "every row of a kernel with the feature has the key");
});

test("the remote roster relays automation only from a host that lists the feature, by the local row's reader", async (t) => {
  const d = v2Deployment({ t });
  const remoteHome = fixtureBase("o-");
  t.after(() => rmSync(remoteHome, { recursive: true, force: true }));
  d.env.OATS_HOME_DIR = remoteHome;
  const instances = [
    { instance: "made", automation: { ...NIGHTLY } },
    { instance: "made-malformed", automation: { ...NIGHTLY, extra: 1 } },
    { instance: "person", automation: null },
    { instance: "no-key" },
  ];
  let n = 0;
  const roster = async (features) => {
    const result = await rosterGroups({ io: { execFileAsync: async () => JSON.stringify({ root: "/remote/agents", features, agents: [{ name: "dev", instances }] }), serverId: `fixture-${n++}` } });
    return Object.fromEntries(result.groups[0].instances.map((i) => [i.instance, i]));
  };
  await d.inEnv(async () => {
    writeServers({ fixture: { sshHost: "fixture.invalid", workspace: "/remote" } });
    const relayed = await roster(["status-automation"]);
    assert.deepEqual(relayed.made.automation, NIGHTLY);
    assert.equal(relayed["made-malformed"].automation, null, "the local row's reader, again on this side");
    assert.equal(relayed.person.automation, null);
    assert.ok(!Object.hasOwn(relayed["no-key"], "automation"), "a row without the key gains none");
    const older = await roster(["status-activity"]);
    for (const name of ["made", "made-malformed", "person", "no-key"]) assert.ok(!Object.hasOwn(older[name], "automation"), `${name}: nothing is relayed from a host without the feature`);
  });
});
