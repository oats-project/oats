// A job's slot whose record cannot be read (lib/schedule.mjs jobLockInfo answers `{ unreadable:
// true }`): an earlier kernel's slot directory without owner.json, a hand edit, a disk fault. The
// tick reports that job invalid and runs the rest of the deployment; `oats schedule reconcile
// <id> --clear` releases the slot once a person has checked; `oats doctor` lists it. Real
// deployment, real files, the real CLI; the tick's launches go through its `io` as the other
// schedule tests' do.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as S from "../lib/schedule.mjs";
import { v2Deployment } from "./helpers/v2-deployment.mjs";

const SLOT_STATES = {
  "a slot directory without its record (an earlier kernel)": (dir) => mkdirSync(dir),
  "a record that does not parse": (dir) => { mkdirSync(dir); writeFileSync(join(dir, "owner.json"), "{not json"); },
};
const remedyOf = (id) => `check oats schedule show ${id}; once its last run is not running, run oats schedule reconcile ${id} --clear to release the slot`;

async function deployment(t, makeSlot) {
  const fx = v2Deployment();
  t.after(() => fx.cleanup());
  const slot = await fx.inEnv(() => {
    for (const id of ["broken", "other"]) S.addSchedule(fx.dep, { id, kind: "command", cwd: fx.dep, argv: ["oats", "status", "--json"], cron: "* * * * *", tz: "UTC" });
    S.registerWorkspace(fx.dep);
    const dir = join(S.stateDir(fx.dep), "locks", "broken");
    mkdirSync(join(S.stateDir(fx.dep), "locks"), { recursive: true });
    makeSlot?.(dir);
    return dir;
  });
  const cli = (...args) => {
    const r = fx.cli([...args, "--json"]);
    assert.equal(r.error, undefined);
    return r;
  };
  return { fx, slot, cli };
}
const entries = (dir) => readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name), "utf8")]);

for (const [state, makeSlot] of Object.entries(SLOT_STATES)) {
  test(`the tick reports only the job whose slot is unreadable (${state}) invalid, and runs the rest of the deployment`, async (t) => {
    const { fx, slot } = await deployment(t, makeSlot);
    const before = entries(slot);
    const ran = [];
    const io = { command: (c) => { ran.push(c); return { ok: true, result: {} }; }, inspect: () => ({ present: false, state: "shell" }) };
    const considered = await fx.inEnv(() => S.tickHost({ now: new Date("2026-10-03T10:00:00Z"), io }).considered);
    const mine = considered.filter((c) => c.workspace === fx.dep);
    const broken = mine.find((c) => c.id === "broken"), other = mine.find((c) => c.id === "other");
    assert.equal(broken?.action, "invalid", JSON.stringify(considered));
    assert.equal(broken.errorCode, "E_SCHEDULE_INVALID");
    assert.equal(broken.error, `the slot ${slot} has no readable record; ${remedyOf("broken")}`);
    assert.equal(other?.action, "launched", JSON.stringify(considered));
    assert.deepEqual(mine.filter((c) => c.action === "error"), [], "no error for the deployment");
    assert.deepEqual(ran, [{ cwd: fx.dep, argv: ["status", "--json"] }], "only the other job ran");
    assert.deepEqual(entries(slot), before, "the unreadable slot is left as it is");
  });

  test(`reconcile answers the remedy for an unreadable slot (${state}) and leaves it; with --clear it releases it`, async (t) => {
    const { fx, slot, cli } = await deployment(t, makeSlot);
    const before = entries(slot);
    const asked = cli("schedule", "reconcile", "broken").json();
    assert.equal(asked.ok, true, JSON.stringify(asked));
    assert.equal(asked.result.reconciled, "unknown");
    assert.equal(asked.result.remedy, `the slot ${slot} has no readable record; ${remedyOf("broken")}`);
    assert.deepEqual(entries(slot), before, "reconcile without --clear leaves the slot as it is");
    const cleared = cli("schedule", "reconcile", "broken", "--clear").json();
    assert.equal(cleared.ok, true, JSON.stringify(cleared));
    assert.equal(cleared.result.reconciled, "cleared");
    assert.equal(await fx.inEnv(() => S.jobLockInfo(fx.dep, "broken")), null, "the slot is released");
    assert.deepEqual(readdirSync(join(S.stateDir(fx.dep), "locks")), []);
  });

  test(`oats doctor lists an unreadable slot (${state}) as its own problem, naming the deployment, the job and the remedy`, async (t) => {
    const { fx, slot, cli } = await deployment(t, makeSlot);
    const before = entries(slot);
    const problems = JSON.parse(cli("doctor").stdout).problems ?? [];
    const found = problems.filter((p) => p.code === "schedule-slot-unreadable");
    assert.deepEqual(found, [{
      code: "schedule-slot-unreadable", severity: "warning", scope: fx.dep, id: "broken",
      message: `schedule broken: its slot ${slot} has no readable record; the tick reports this job invalid and starts nothing of it, and the slot counts against maxConcurrent`,
      remedy: remedyOf("broken"),
    }]);
    assert.deepEqual(entries(slot), before, "doctor leaves the slot as it is");
    const text = fx.cli(["doctor"]).stdout;
    assert.ok(text.includes(`! schedule-slot-unreadable: ${found[0].message}\n  ${found[0].remedy}`), text);
  });
}

test("oats doctor lists no unreadable slot for a readable slot or none", async (t) => {
  const { fx, cli } = await deployment(t);
  assert.equal((JSON.parse(cli("doctor").stdout).problems ?? []).some((p) => p.code === "schedule-slot-unreadable"), false, "no slot");
  await fx.inEnv(() => assert.equal(S.acquireJobLock(fx.dep, "broken", { scheduledFor: "2026-10-03T10:00:00.000Z" }), true));
  assert.equal((JSON.parse(cli("doctor").stdout).problems ?? []).some((p) => p.code === "schedule-slot-unreadable"), false, "a readable slot");
});

for (const [state, makeSlot] of Object.entries(SLOT_STATES)) {
  test(`an unreadable slot of a schedule that is not defined (${state}): reconcile answers what it found and leaves it, --clear releases it, and doctor names that command`, async (t) => {
    const { fx, cli } = await deployment(t);
    const slot = join(S.stateDir(fx.dep), "locks", "gone");
    makeSlot(slot);
    const before = entries(slot);
    const said = `the slot ${slot} of schedule gone, which is not defined, has no readable record`;
    const remedy = "once no run of schedule gone is running (oats status lists the instances it started), run oats schedule reconcile gone --clear to release the slot";
    const problems = JSON.parse(cli("doctor").stdout).problems ?? [];
    assert.deepEqual(problems.filter((p) => p.code === "schedule-slot-unreadable"), [{
      code: "schedule-slot-unreadable", severity: "warning", scope: fx.dep, id: "gone",
      message: `schedule gone, which is not defined: its slot ${slot} has no readable record, and the slot counts against maxConcurrent`,
      remedy,
    }]);
    const asked = cli("schedule", "reconcile", "gone").json();
    assert.equal(asked.ok, true, JSON.stringify(asked));
    assert.deepEqual(asked.result, { schedule: null, reconciled: "unknown", remedy: `${said}; ${remedy}` });
    assert.deepEqual(entries(slot), before, "reconcile without --clear leaves the slot as it is");
    const cleared = cli("schedule", "reconcile", "gone", "--clear").json();
    assert.equal(cleared.ok, true, JSON.stringify(cleared));
    assert.deepEqual(cleared.result, { schedule: null, reconciled: "cleared" });
    assert.deepEqual(readdirSync(join(S.stateDir(fx.dep), "locks")), [], "the slot is released");
    const again = cli("schedule", "reconcile", "gone").json();
    assert.equal(again.error?.code, "E_SCHEDULE_UNKNOWN", "with no slot, a schedule that is not defined is unknown, as before");
  });
}
