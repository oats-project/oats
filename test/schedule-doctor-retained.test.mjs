import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as S from "../lib/schedule.mjs";
import { snapshotPath } from "../lib/automations.mjs";
import { v2Deployment } from "./helpers/v2-deployment.mjs";

const scheduledFor = "2026-10-03T10:00:00.000Z", startedAt = "2026-10-03T10:00:01.000Z";
const entry = { kind: "oats-schedule", schemaVersion: 1, id: "retained", runsOn: "this-host", owner: "github.com/operator", run: "command", cron: "0 * * * *", tz: "UTC", argv: ["oats", "status"] };
const problemKeys = ["code", "severity", "scope", "id", "kind", "scheduledFor", "startedAt", "ageSeconds", "holdsSlot", "exited", "error", "remedy", "message"].sort();
function fixture(t) {
  const fx = v2Deployment({ local: { host: { name: "this-host" }, automations: { trust: "*" } }, files: { "oats-schedules/retained.yaml": { yaml: entry } } });
  t.after(() => fx.cleanup());
  const bin = join(fx.base, "gh-bin");
  mkdirSync(bin);
  const calls = join(fx.base, "gh-calls");
  writeFileSync(calls, "");
  // No credentials or network: even an accidental identity probe is recorded.
  const gh = join(bin, "gh");
  writeFileSync(gh, `#!${process.execPath}\nimport('node:fs').then(({appendFileSync}) => { appendFileSync(${JSON.stringify(calls)}, 'called\\n'); console.log('operator'); });\n`);
  chmodSync(gh, 0o755);
  fx.env.PATH = `${bin}:${fx.env.PATH}`;
  const cli = (...args) => {
    const result = fx.cli([...args, "--json"]);
    assert.equal(result.error, undefined);
    return { ...result, doc: args[0] === "doctor" ? JSON.parse(result.stdout) : result.json() };
  };
  assert.equal(cli("sync").doc.ok, true, "fixture uses actual discovery and snapshot persistence");
  return { fx, cli, calls };
}
async function retainedState(fx) {
  await fx.inEnv(() => {
    S.writeState(fx.dep, { jobs: { "ws~retained": { attempt: { scheduledFor, startedAt } } } });
    assert.equal(S.acquireJobLock(fx.dep, "ws~retained", { scheduledFor }), true);
  });
}
function diskEvidence(fx) {
  const optional = (path) => existsSync(path) ? readFileSync(path, "utf8") : null;
  return {
    state: optional(join(S.stateDir(fx.dep), "state.json")),
    owner: optional(join(S.stateDir(fx.dep), "locks", "ws~retained", "owner.json")),
    snapshot: optional(snapshotPath(fx.dep)),
    refresh: optional(join(fx.dep, ".agents", "automations", "last-refresh-attempt")),
  };
}
function problemShape(problem, fx) {
  assert.deepEqual(Object.keys(problem).sort(), problemKeys, "diagnostic change must not extend the public problem shape");
  assert.equal(problem.code, "schedule-unresolved");
  assert.equal(problem.severity, "warning");
  assert.equal(problem.scope, fx.dep);
  assert.equal(problem.id, "ws/retained");
  assert.ok(problem.kind === "command" || problem.kind === null);
  assert.equal(problem.scheduledFor, scheduledFor);
  assert.equal(problem.startedAt, startedAt);
  assert.equal(Number.isInteger(problem.ageSeconds), true);
  assert.equal(problem.holdsSlot, true);
  assert.equal(problem.exited, false);
  assert.equal(problem.error, null);
  assert.equal(typeof problem.remedy, "string");
  assert.equal(typeof problem.message, "string");
}
function noExecutableReconcile(problem) {
  assert.doesNotMatch(problem.remedy, /\boats\s+schedule\s+reconcile\b/, "an ineligible or unverifiable workspace row must not advertise an executable reconcile command");
  assert.doesNotMatch(problem.message, /\boats\s+schedule\s+reconcile\b/);
}

for (const [change, reason] of [
  ["disabled", /disabled/i], ["untrusted", /untrusted|not trusted/i],
  ["moved", /elsewhere|another host|different host|runsOn/i],
  ["missing-snapshot", /absent|missing|snapshot.*unavailable|no.*snapshot/i],
]) {
  test(`offline doctor retains ${change} workspace attempts without advertising a refused reconcile`, async (t) => {
    const { fx, cli, calls } = fixture(t);
    if (change === "disabled") assert.equal(cli("schedule", "disable", "ws/retained").doc.ok, true);
    if (change === "untrusted") writeFileSync(join(fx.dep, "oats-local.yaml"), `schemaVersion: 2\nworkspace: ${fx.ref}\nhost:\n  name: this-host\n`);
    if (change === "moved") {
      fx.commit({ "oats-schedules/retained.yaml": { yaml: { ...entry, runsOn: "elsewhere" } } }, change);
      assert.equal(cli("sync").doc.ok, true);
    }
    if (change === "missing-snapshot") rmSync(snapshotPath(fx.dep));
    const baseline = cli("doctor", fx.dep);
    await retainedState(fx);
    const before = diskEvidence(fx);
    writeFileSync(calls, "");
    const doctor = cli("doctor", fx.dep);
    assert.equal(doctor.status, baseline.status, "retained schedule warning does not alter doctor exit status");
    const problem = doctor.doc.problems?.find((p) => p.code === "schedule-unresolved" && p.id === "ws/retained");
    assert.ok(problem, JSON.stringify(doctor.doc));
    problemShape(problem, fx);
    assert.equal(readFileSync(calls, "utf8"), "", "doctor never probes gh authorization");
    assert.deepEqual(diskEvidence(fx), before, "doctor cannot refresh discovery, rewrite state or release the slot");
    noExecutableReconcile(problem);
    assert.match(`${problem.remedy} ${problem.message}`, reason);
    assert.match(problem.remedy, /preserv|inspect|owner/i);
    // Pin the real boundary behind the diagnostic. Reconcile may probe gh;
    // only the doctor phase above promises zero authorization calls.
    const refused = cli("schedule", "reconcile", "ws/retained", "--clear");
    assert.equal(refused.doc.ok, false);
    assert.equal(refused.doc.error.code, change === "missing-snapshot" ? "E_SCHEDULE_UNKNOWN" : "E_AUTOMATION_NOT_HERE");
    assert.deepEqual(diskEvidence(fx), before, "refused reconcile cannot rewrite retained state, custody, or discovery");
  });
}

// A workspace schedule removed upstream: the saved snapshot read its member at a commit, found no
// problem there that could hide a schedule, and has no schedule ws/retained. Its slot and its
// retained attempt are listed with the snapshot's time, and reconcile --clear releases the slot,
// resolves the attempt as cleared and removes the job's state. Nothing refreshes the snapshot.
const slotOf = (fx) => join(S.stateDir(fx.dep), "locks", "ws~retained");
const goneRemedy = "once no run of schedule ws/retained is running (oats status lists the instances it started), run oats schedule reconcile ws/retained --clear to release the slot";
test("a workspace schedule removed upstream: doctor names it gone as of the snapshot, and reconcile --clear releases its slot, attempt and state", async (t) => {
  const { fx, cli } = fixture(t);
  fx.commit({ "oats-schedules/retained.yaml": null }, "removed");
  assert.equal(cli("sync").doc.ok, true);
  await retainedState(fx);
  const takenAt = JSON.parse(readFileSync(snapshotPath(fx.dep), "utf8")).takenAt;
  const absent = `which as of ${takenAt} is not in the workspace (run oats automations refresh if that is stale)`;
  const found = `holds the run due ${scheduledFor} of an instance its record does not name`;
  const before = diskEvidence(fx);
  const problems = cli("doctor", fx.dep).doc.problems ?? [];
  assert.deepEqual(problems.filter((p) => p.code === "schedule-slot-orphaned"), [{
    code: "schedule-slot-orphaned", severity: "warning", scope: fx.dep, id: "ws/retained",
    message: `schedule ws/retained, ${absent}: its slot ${slotOf(fx)} ${found}, and the slot counts against maxConcurrent`,
    remedy: goneRemedy,
  }]);
  const row = problems.find((p) => p.code === "schedule-unresolved" && p.id === "ws/retained");
  problemShape(row, fx);
  assert.equal(row.remedy, goneRemedy, "the attempt's row names the command that works");
  assert.ok(row.message.endsWith(`the slot ${slotOf(fx)} of schedule ws/retained, ${absent}, ${found}; ${goneRemedy}`), row.message);
  const asked = cli("schedule", "reconcile", "ws/retained");
  assert.deepEqual([asked.doc.ok, asked.doc.result], [true, { schedule: null, reconciled: "unknown", remedy: `the slot ${slotOf(fx)} of schedule ws/retained, ${absent}, ${found}; ${goneRemedy}` }], JSON.stringify(asked.doc));
  assert.deepEqual(diskEvidence(fx), before, "reconcile without --clear changes nothing");
  const cleared = cli("schedule", "reconcile", "ws/retained", "--clear");
  assert.deepEqual([cleared.doc.ok, cleared.doc.result], [true, { schedule: null, reconciled: "cleared", cleared: ["slot", "attempt", "state"] }], JSON.stringify(cleared.doc));
  assert.equal(existsSync(slotOf(fx)), false, "the slot is released");
  assert.equal("ws~retained" in JSON.parse(readFileSync(join(S.stateDir(fx.dep), "state.json"), "utf8")).jobs, false, "the job's state is removed");
  const after = diskEvidence(fx);
  assert.deepEqual([after.snapshot, after.refresh], [before.snapshot, before.refresh], "the snapshot is not refreshed");
  assert.deepEqual((cli("doctor", fx.dep).doc.problems ?? []).filter((p) => p.id === "ws/retained"), [], "nothing is left to report");
});

test("a workspace schedule absent because its member is not in the workspace is not taken for gone: refused, and doctor names the slot to remove by hand", async (t) => {
  const { fx, cli } = fixture(t);
  await retainedState(fx);
  // The snapshot of a workspace that no longer lists the member: no member entry, none of its schedules.
  const snap = JSON.parse(readFileSync(snapshotPath(fx.dep), "utf8"));
  writeFileSync(snapshotPath(fx.dep), JSON.stringify({ ...snap, members: {}, schedules: [] }));
  const before = diskEvidence(fx);
  const problems = cli("doctor", fx.dep).doc.problems ?? [];
  assert.deepEqual(problems.filter((p) => p.code === "schedule-slot-orphaned"), [{
    code: "schedule-slot-orphaned", severity: "warning", scope: fx.dep, id: "ws/retained",
    message: `schedule ws/retained, which is not in the workspace's snapshot of ${snap.takenAt}: its member ws is not in the workspace, or was not read, so whether the schedule is gone cannot be told; its slot ${slotOf(fx)} holds the run due ${scheduledFor} of an instance its record does not name, and the slot counts against maxConcurrent`,
    remedy: `check oats status for a run of schedule ws/retained; once none is running, remove the slot by hand: rm -r -- '${slotOf(fx)}'`,
  }]);
  const refused = cli("schedule", "reconcile", "ws/retained", "--clear");
  assert.deepEqual([refused.doc.ok, refused.doc.error?.code], [false, "E_SCHEDULE_UNKNOWN"], JSON.stringify(refused.doc));
  assert.deepEqual(diskEvidence(fx), before, "the slot, the state and the snapshot are left as they are");
});

test("a workspace schedule absent beside a schedule file of its member that cannot be read is not taken for gone: refused, and doctor names the file to fix", async (t) => {
  const { fx, cli } = fixture(t);
  fx.commit({ "oats-schedules/retained.yaml": null, "oats-schedules/broken.yaml": "kind: oats-schedule\nschemaVersion: [\n" }, "broken");
  assert.equal(cli("sync").doc.ok, true);
  await retainedState(fx);
  const takenAt = JSON.parse(readFileSync(snapshotPath(fx.dep), "utf8")).takenAt;
  const before = diskEvidence(fx);
  const problems = cli("doctor", fx.dep).doc.problems ?? [];
  assert.deepEqual(problems.filter((p) => p.code === "schedule-slot-orphaned"), [{
    code: "schedule-slot-orphaned", severity: "warning", scope: fx.dep, id: "ws/retained",
    message: `schedule ws/retained, which is not in the workspace's snapshot of ${takenAt}: member ws has a schedule file that could not be read (oats-schedules/broken.yaml), which could be this schedule, so whether it is gone cannot be told; its slot ${slotOf(fx)} holds the run due ${scheduledFor} of an instance its record does not name, and the slot counts against maxConcurrent`,
    remedy: "fix oats-schedules/broken.yaml in member ws and run oats automations refresh; doctor then says whether schedule ws/retained is gone",
  }]);
  const refused = cli("schedule", "reconcile", "ws/retained", "--clear");
  assert.deepEqual([refused.doc.ok, refused.doc.error?.code], [false, "E_SCHEDULE_UNKNOWN"], JSON.stringify(refused.doc));
  assert.deepEqual(diskEvidence(fx), before, "the slot, the state and the snapshot are left as they are");
});

test("offline doctor does not claim current authorization from a statically eligible workspace snapshot", async (t) => {
  const { fx, cli, calls } = fixture(t);
  await retainedState(fx);
  const before = diskEvidence(fx);
  writeFileSync(calls, "");
  const doctor = cli("doctor", fx.dep);
  const problem = doctor.doc.problems.find((p) => p.code === "schedule-unresolved");
  problemShape(problem, fx);
  assert.equal(doctor.status, 0);
  assert.equal(readFileSync(calls, "utf8"), "");
  assert.deepEqual(diskEvidence(fx), before);
  assert.match(`${problem.remedy} ${problem.message}`, /authori[sz]ation.*(?:unverified|not verified|cannot be verified).*offline|offline.*authori[sz]ation.*(?:unverified|not verified)/i);
  assert.doesNotMatch(problem.remedy, /^oats schedule reconcile /, "static placement alone is not verified execution authorization");
});

for (const corruption of ["invalid", "unreadable"]) {
  test(`offline retained-state helper distinguishes ${corruption} local configuration from known exclusion`, async (t) => {
    const { fx, calls } = fixture(t);
    await retainedState(fx);
    const local = join(fx.dep, "oats-local.yaml");
    if (corruption === "invalid") writeFileSync(local, "schemaVersion: 2\nhost: [unterminated\n");
    else { rmSync(local); mkdirSync(local); }
    const before = diskEvidence(fx);
    writeFileSync(calls, "");
    const result = await fx.inEnv(() => {
      process.env.PATH = fx.env.PATH;
      return S.unresolvedScheduleAttempts(fx.dep);
    });
    const problem = result.problems.find((p) => p.code === "schedule-unresolved");
    assert.ok(problem, "configuration errors must not hide retained state");
    problemShape(problem, fx);
    assert.equal(readFileSync(calls, "utf8"), "");
    assert.deepEqual(diskEvidence(fx), before);
    noExecutableReconcile(problem);
    assert.match(`${problem.remedy} ${problem.message}`, /authori[sz]ation.*(?:cannot|could not|unverified|not verified).*offline|offline.*(?:cannot|could not|unverified|not verified).*authori[sz]ation/i);
    assert.match(`${problem.remedy} ${problem.message}`, /config|oats-local|unreadable|invalid/i);
    assert.doesNotMatch(problem.remedy, /currently unavailable under (?:disabled|untrusted|another host)/i, "unreadable inputs are not proof of exclusion");
    const primary = v2Deployment();
    t.after(() => primary.cleanup());
    primary.env.OATS_HOME_DIR = fx.env.OATS_HOME_DIR;
    primary.env.PATH = fx.env.PATH;
    await primary.inEnv(() => S.registerWorkspace(fx.dep));
    const doctor = primary.cli(["doctor", primary.dep, "--json"]);
    assert.equal(doctor.error, undefined);
    assert.equal(doctor.status, 0, "an unreadable other scope is a warning, not a primary doctor failure");
    const reported = JSON.parse(doctor.stdout).problems.find((p) => p.scope === fx.dep && p.id === "ws/retained");
    problemShape(reported, fx);
    noExecutableReconcile(reported);
    assert.match(`${reported.remedy} ${reported.message}`, /authori[sz]ation.*(?:cannot|could not|unverified|not verified).*offline/i);
    assert.equal(readFileSync(calls, "utf8"), "");
    assert.deepEqual(diskEvidence(fx), before);
    const direct = fx.cli(["doctor", fx.dep, "--json"]);
    assert.notEqual(direct.status, 0, "the primary deployment's invalid configuration still fails doctor");
    if (corruption === "invalid") assert.equal(direct.json().ok, false);
    else assert.match(direct.stderr, /EISDIR|is a directory/i);
  });
}

test("unknown last-run without an attempt is not described as blocked until reconciliation and missing-home observation settles it", async (t) => {
  const fx = v2Deployment();
  t.after(() => fx.cleanup());
  await fx.inEnv(() => {
    S.addSchedule(fx.dep, { id: "observed", kind: "command", cwd: fx.dep, argv: ["oats", "status"], cron: "0 * * * *", tz: "UTC" });
    S.writeState(fx.dep, { jobs: { observed: { lastRun: { scheduledFor, startedAt, kind: "command", outcome: "unknown", home: join(fx.dep, "absent-home") } } } });
    S.acquireJobLock(fx.dep, "observed", {});
    const before = readFileSync(join(S.stateDir(fx.dep), "state.json"), "utf8");
    const problem = S.unresolvedScheduleAttempts(fx.dep).problems[0];
    assert.equal(problem.severity, "warning");
    assert.equal(problem.holdsSlot, true);
    assert.equal(readFileSync(join(S.stateDir(fx.dep), "state.json"), "utf8"), before);
    // Check the independent behavior before the diagnostic assertion, so the
    // red baseline also proves that observation can settle this exact state.
    S.tickWorkspace(fx.dep, { observeOnly: true, reg: { maxConcurrent: 5, workspaces: [fx.dep] }, io: { spawn: () => assert.fail("observation cannot launch"), command: () => assert.fail("observation cannot run commands") } });
    const after = S.readState(fx.dep).jobs.observed;
    assert.equal(after.attempt, undefined);
    assert.equal(after.lastRun.outcome, "ended");
    assert.equal(S.jobLockInfo(fx.dep, "observed"), null);
    assert.doesNotMatch(problem.message, /does not run again until.*reconcil|blocked.*(?:until|pending).*reconcil/i);
    assert.match(problem.message, /unknown|unconfirmed/i, "describe the actual last-run state, not an invented attempt");
  });
});

test("local retained captured execution state is reported without inventing a supported reconcile command", async (t) => {
  const fx = v2Deployment();
  t.after(() => fx.cleanup());
  await fx.inEnv(() => {
    S.addSchedule(fx.dep, { id: "captured", kind: "command", cwd: fx.dep, argv: ["oats", "status"], cron: "0 * * * *", tz: "UTC" });
    for (const [attempt, owner] of [
      [{ scheduledFor, startedAt, execution: { id: "old-execution" } }, {}],
      [{ scheduledFor, startedAt, schemaVersion: 1 }, {}],
      [{ scheduledFor, startedAt }, { executionId: "old-execution" }],
    ]) {
      S.writeState(fx.dep, { jobs: { captured: { attempt } } });
      S.acquireJobLock(fx.dep, "captured", owner);
      const statePath = join(S.stateDir(fx.dep), "state.json");
      const ownerPath = join(S.stateDir(fx.dep), "locks", "captured", "owner.json");
      const state = readFileSync(statePath, "utf8"), lock = readFileSync(ownerPath, "utf8");
      const problem = S.unresolvedScheduleAttempts(fx.dep).problems.find((p) => p.id === "captured");
      assert.ok(problem);
      assert.deepEqual(Object.keys(problem).sort(), problemKeys);
      assert.equal(problem.severity, "warning");
      assert.equal(problem.holdsSlot, true);
      assert.equal(typeof problem.remedy, "string");
      noExecutableReconcile(problem);
      assert.match(problem.remedy, /unsupported|captured/i);
      assert.match(problem.remedy, /preserv|inspect|owner/i);
      assert.equal(readFileSync(statePath, "utf8"), state);
      assert.equal(readFileSync(ownerPath, "utf8"), lock);
      // Fixture reset, not a proposed recovery operation.
      S.releaseJobLock(fx.dep, "captured");
    }
  });
});

for (const corruption of [{ runsOn: "not a host name" }, { enabled: "false" }]) {
  test(`invalid saved placement header ${Object.keys(corruption)[0]} is unverifiable, not a known exclusion`, async (t) => {
    const { fx, cli, calls } = fixture(t);
    await retainedState(fx);
    const file = snapshotPath(fx.dep), snapshot = JSON.parse(readFileSync(file, "utf8"));
    Object.assign(snapshot.schedules[0], corruption);
    writeFileSync(file, JSON.stringify(snapshot));
    const before = diskEvidence(fx);
    writeFileSync(calls, "");
    const problem = cli("doctor", fx.dep).doc.problems.find((p) => p.code === "schedule-unresolved");
    assert.match(problem.remedy, /cannot be verified offline.*invalid or incomplete/);
    noExecutableReconcile(problem);
    assert.equal(readFileSync(calls, "utf8"), "");
    assert.deepEqual(diskEvidence(fx), before);
  });
}

test("local retained state whose slot cannot be read names the slot and the remedy that releases it once a person has checked", async (t) => {
  const fx = v2Deployment();
  t.after(() => fx.cleanup());
  await fx.inEnv(() => {
    S.addSchedule(fx.dep, { id: "custody", kind: "command", cwd: fx.dep, argv: ["oats", "status"], cron: "0 * * * *", tz: "UTC" });
    S.writeState(fx.dep, { jobs: { custody: { attempt: { scheduledFor, startedAt } } } });
    S.acquireJobLock(fx.dep, "custody", {});
    const ownerPath = join(S.stateDir(fx.dep), "locks", "custody", "owner.json");
    writeFileSync(ownerPath, "{not json");
    const statePath = join(S.stateDir(fx.dep), "state.json");
    const state = readFileSync(statePath, "utf8");
    const problems = S.unresolvedScheduleAttempts(fx.dep).problems.filter((p) => p.id === "custody");
    assert.deepEqual(problems.map((p) => p.code), ["schedule-slot-unreadable", "schedule-unresolved"], "the slot is listed on its own too");
    const problem = problems[1];
    assert.deepEqual(Object.keys(problem).sort(), problemKeys);
    const remedy = "check oats schedule show custody; once its last run is not running, run oats schedule reconcile custody --clear to release the slot";
    assert.equal(problem.remedy, remedy);
    assert.ok(problem.message.endsWith(`the slot ${join(S.stateDir(fx.dep), "locks", "custody")} has no readable record: ${remedy}`), problem.message);
    assert.equal(readFileSync(statePath, "utf8"), state, "doctor wrote nothing");
    assert.equal(readFileSync(ownerPath, "utf8"), "{not json", "the lock custody is untouched");
  });
});
