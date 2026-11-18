// The captured/portable path was removed in 0.26 (lead decisions on (e), D1–D4). What is
// left of it is refusals, each typed, none falling back to the workspace path:
//   D2  captured selectors (--deployment/--resolution/--artifact-set) and an inherited
//       captured context (OATS_DEPLOYMENT/OATS_RESOLUTION) → E_UNSUPPORTED_MODE;
//   D3  `prepare` and `inspect --request` → E_UNKNOWN_COMMAND naming the replacements;
//   D1  a captured home (instance.json records executionBinding|incarnationId|captured):
//       status names it (legacy-captured-home); start, inspect|readiness|operation --home
//       and in-home commands refuse it; forced retire works, naming each capability whose
//       retire hook did NOT run;
//   D4  captured (versioned) schedules are refused on add, and a stored one never fires.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setProcessEnvironment, v2Deployment } from "./helpers/v2-deployment.mjs";

const fail = (r, what) => { const j = r.json(); assert.equal(j.ok, false, `${what}: ${r.stdout}${r.stderr}`); assert.notEqual(r.status, 0, what); return j.error; };

function fixture() {
  return v2Deployment({
    name: "acme",
    souls: { dev: { soul: { capabilities: { "acme.tool": { from: "here" } } } } },
    capabilities: { "acme.tool": { manifest: { command: "tool", commands: { show: "show.mjs" } }, files: { "show.mjs": "console.log(JSON.stringify({ ok: true, result: { shown: true } }));\n" } } },
  });
}
/** A captured home as 0.24–0.25 left one: a spawned home whose instance.json records its
 *  incarnation (the keys the captured path wrote) and the capabilities whose spawn hooks ran. */
function makeCaptured(home, extra = {}) {
  const file = join(home, "instance.json");
  const meta = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...meta, incarnationId: "inc-1", executionBinding: { schemaVersion: 1, deployment: "/nowhere", resolution: { id: "r1" } },
    captured: { lifecycle: "running", hookOrder: ["oats.aweb", "oats.okf"] }, capabilityMeta: { "oats.aweb": {}, "acme.extra": {} }, ...extra }, null, 2));
}

test("captured selectors and an inherited captured context are refused (E_UNSUPPORTED_MODE), never run against the current context; version still answers", (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  for (const args of [["status", "--deployment", "/x", "--json"], ["spawn", "dev", "--resolution=r1", "--json"], ["inspect", "--artifact-set", "a", "--json"]]) {
    const e = fail(fx.cli(args), args.join(" "));
    assert.equal(e.code, "E_UNSUPPORTED_MODE", args.join(" "));
    assert.match(e.message, /a captured selector is refused \(the captured\/portable path was removed in 0\.26\)/);
  }
  const e = fail(fx.cli(["status", "--json"], { env: { OATS_RESOLUTION: "r1" } }), "inherited");
  assert.equal(e.code, "E_UNSUPPORTED_MODE");
  assert.deepEqual(e.details.inherited, ["OATS_RESOLUTION"]);
  const v = fx.cli(["version", "--json"], { env: { OATS_RESOLUTION: "r1", OATS_DEPLOYMENT: "/x" } });
  assert.equal(v.status, 0, v.stderr);
  const doc = JSON.parse(v.stdout);
  assert.equal("capturedDispatchApi" in doc || "capturedDispatchActions" in doc, false, "the version document no longer advertises captured dispatch");
  // After `--`, a selector-looking word is an argument of the command, not a selector.
  const after = fx.cli(["status", "--json", "--", "--deployment"]);
  assert.equal(after.status, 0, `${after.stdout}${after.stderr}`);
});

test("prepare and inspect --request are removed verbs (E_UNKNOWN_COMMAND) naming their replacements", (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  let e = fail(fx.cli(["prepare", "--json"]), "prepare");
  assert.equal(e.code, "E_UNKNOWN_COMMAND");
  assert.equal(e.details.removed, "prepare");
  assert.match(e.details.replacement, /oats onboard.*oats spawn <soul> --preview/);
  e = fail(fx.cli(["inspect", "--request", "/x.json", "--json"]), "inspect --request");
  assert.equal(e.code, "E_UNKNOWN_COMMAND");
  assert.equal(e.details.removed, "inspect --request");
});

test("a captured home: status names it, start/inspect/readiness/operation --home and in-home commands refuse it, forced retire works and names each capability whose retire hook did NOT run", async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  const { home, instance } = await fx.spawn("dev", { instance: "dev-old" });
  const { home: clean } = await fx.spawn("dev", { instance: "dev-new" });
  makeCaptured(home);

  const status = fx.cli(["status", "--json"]);
  assert.equal(status.status, 0, status.stderr);
  const problem = JSON.parse(status.stdout).problems?.find((p) => p.code === "legacy-captured-home");
  assert.match(problem.message, /inspect.*clean up.*--force/);
  assert.doesNotMatch(problem.message, /oats retire` still works/);
  assert.deepEqual([problem?.instances, problem?.homes?.map((h) => realpathSync(h))], [[instance], [realpathSync(home)]], status.stdout);
  assert.match(fx.cli(["status"]).stdout, /! legacy-captured-home: 1 captured home .* \(dev-old\)/);

  for (const args of [["inspect", "--home", home, "--json"], ["readiness", "--home", home, "--json"], ["operation", "run", "knowledge:x", "--home", home, "--json"]]) {
    const e = fail(fx.cli(args), args.slice(0, 2).join(" "));
    assert.equal(e.code, "E_UNSUPPORTED_MODE", args.join(" "));
    assert.match(e.message, /is a captured home .*removed in 0\.26.*without proof that no spawn hook ran/, args.join(" "));
    assert.ok(e.message.includes(`oats retire ${instance} --force`), e.message);
    assert.equal(e.details?.captured, true, args.join(" "));
  }
  const inHome = fail(fx.cli(["tool", "show", "--json"], { cwd: home, env: { OATS_INSTANCE_HOME: home } }), "in-home");
  assert.equal(inHome.code, "E_UNSUPPORTED_MODE");
  assert.match(inHome.message, /is a captured home/);
  assert.equal(fx.cli(["tool", "show", "--json"], { cwd: clean, env: { OATS_INSTANCE_HOME: clean } }).json().ok, true, "a workspace home still dispatches");

  const { startInstanceSession } = await import("../lib/core.mjs");
  await fx.inEnv(() => assert.throws(() => startInstanceSession(home, { launch: false }), (e) => e.code === "E_UNSUPPORTED_MODE" && /is a captured home/.test(e.message) && /nothing was started/.test(e.message)));

  for (const flags of [["--plan"], []]) {
    const refused = fx.cli(["retire", instance, "--json", ...flags]);
    assert.equal(refused.json().error.code, "E_UNIDENTIFIED_INSTANCE_HOME");
    assert.match(refused.json().error.message, /--force/);
  }
  const r = fx.cli(["retire", instance, "--force", "--json"]);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const out = JSON.parse(r.stdout);
  const named = (out.warnings || []).filter((w) => /its retire hook did NOT run \(captured home/.test(w)).map((w) => w.split(":")[0]);
  assert.deepEqual(named, ["acme.extra", "oats.aweb", "oats.okf"], JSON.stringify(out.warnings));
  assert.ok(out.warnings.every((w) => !/an earlier kernel spawned it/.test(w)), "the captured warning replaces the generic one");
  assert.match(out.warnings[0], /identities\/memberships it created are not revoked; remove them with the provider's own tooling/);
  assert.equal(JSON.parse(fx.cli(["status", "--json"]).stdout).problems?.some((p) => p.code === "legacy-captured-home") ?? false, false, "retired: no longer named");
});

test("captured (versioned) schedules are refused on add and update; a stored one never fires and is marked invalid on its own job", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "oats-captured-sched-")));
  const saved = { ...process.env };
  process.env.OATS_HOME_DIR = join(base, "oats-home");
  try {
    const S = await import("../lib/schedule.mjs");
    const ws = join(base, "ws");
    mkdirSync(join(ws, "agents", "dev", "soul"), { recursive: true });
    writeFileSync(join(ws, "agents", "dev", "soul", "soul.yaml"), "name: dev\nwork: worktree\nharness: claude\n");
    writeFileSync(join(ws, "oats-local.yaml"), "schemaVersion: 2\nworkspace: example.invalid/acme/workspace\n");
    const job = { id: "j", cron: "* * * * *", tz: "UTC", kind: "command", cwd: ws, argv: ["oats", "status", "--json"] };
    for (const key of S.CAPTURED_SCHEDULE_KEYS) {
      assert.throws(() => S.addSchedule(ws, { ...job, id: `v-${key.toLowerCase()}`, [key]: key === "definitionVersion" ? 2 : {} }), (e) => e.code === "E_SCHEDULE_INVALID" && /captured schedules are refused \(the captured\/portable path was removed in 0\.26\)/.test(e.message), key);
    }
    assert.throws(() => S.addSchedule(ws, { ...job, id: "sel", argv: ["oats", "status", "--resolution", "r1"] }), (e) => e.code === "E_SCHEDULE_INVALID" && /--resolution/.test(e.message));
    S.addSchedule(ws, job);
    assert.throws(() => S.updateSchedule(ws, "j", { definitionVersion: 2 }), (e) => e.code === "E_SCHEDULE_INVALID");
    const defs = S.readDefinitions(ws);
    defs.jobs.old = { ...job, id: "old", definitionVersion: 2, recurrencePolicy: "capture" };
    S.writeDefinitions(ws, defs);
    const ran = [];
    const io = { exec: (...a) => { ran.push(a); return JSON.stringify({ ok: true, result: {} }); }, inspect: () => ({ present: false, state: "shell" }) };
    const acts = S.tickWorkspace(ws, { now: new Date("2026-09-25T10:00:00Z"), io, reg: S.readRegistry() });
    const old = acts.find((a) => a.id === "old");
    assert.equal(old?.action, "invalid", JSON.stringify(acts));
    assert.match(old.error, /captured schedules are refused \(the captured\/portable path was removed in 0\.26\)/);
    assert.equal(acts.find((a) => a.id === "j")?.action === "invalid", false, "the other job is untouched");

    // What 0.25 left mid-run: an admitted captured attempt in state and a job lock naming its
    // execution. Reported on that job only (describe, reconcile), never run or adopted, and
    // the rest of the scope still ticks.
    const st = S.readState(ws);
    st.jobs.old = { ...(st.jobs.old || {}), attempt: { schemaVersion: 1, scheduledFor: "2026-09-25T09:00:00.000Z", startedAt: "2026-09-25T09:00:00.000Z", execution: { executionId: "x1" } } };
    S.writeState(ws, st);
    assert.match(S.describe(ws, "old").executionStatus.intent?.reason ?? "", /^this job holds a captured schedule attempt/, "the attempt alone is reported");
    S.acquireJobLock(ws, "old", { scheduledFor: "2026-09-25T09:00:00.000Z", executionId: "x1" });
    const acts2 = S.tickWorkspace(ws, { now: new Date("2026-09-25T10:01:00Z"), io, reg: S.readRegistry() });
    assert.equal(acts2.find((a) => a.id === "old")?.action, "invalid", JSON.stringify(acts2));
    assert.ok(acts2.some((a) => a.id === "j"), "the scope's other job is still evaluated");
    const described = S.describe(ws, "old");
    assert.equal(described.executionStatus.kind, "invalid");
    assert.equal(described.executionStatus.intent.kind, "invalid");
    assert.match(described.executionStatus.intent.reason, /captured schedule attempt .*removed in 0\.26.*oats schedule remove --force/);
    assert.throws(() => S.reconcile(ws, "old", { io }), (e) => e.code === "E_SCHEDULE_INVALID" && /removed in 0\.26/.test(e.message));
    assert.equal(S.readState(ws).jobs.old.attempt?.execution?.executionId, "x1", "reconcile never adopts or clears a captured attempt");
    const st2 = S.readState(ws); delete st2.jobs.old.attempt; S.writeState(ws, st2);
    const lockOnly = S.describe(ws, "old").executionStatus.intent;
    assert.equal(lockOnly?.kind, "invalid", "a captured job lock alone is reported too");
    assert.match(lockOnly.reason, /^captured job lock: /);
    // The documented way out: remove --force forgets the job and frees its slot.
    assert.throws(() => S.removeSchedule(ws, "old"), { code: "E_SCHEDULE_RUNNING" });
    S.removeSchedule(ws, "old", { force: true });
    assert.equal(S.jobLockInfo(ws, "old"), null);
    assert.equal("old" in S.readDefinitions(ws).jobs, false);
  } finally { setProcessEnvironment(saved); rmSync(base, { recursive: true, force: true }); }
});
