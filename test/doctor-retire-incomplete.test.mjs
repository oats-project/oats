// `oats doctor` lists every retirement left open as one `retire-incomplete` problem (oats-project/oats#1747):
// the command that finishes it and the capability whose retire hook failed last. A retirement is
// open when the home reads quarantined, when its self-retire failed or was interrupted, or when a
// failed self-retire left its outcome beside a home that is still there. A retire that runs or
// cannot be read, a spawn in progress, and an outcome whose home is gone are not listed. Doctor
// reads this as `oats status` does, read-only and offline, and its exit status is as before (0).
//
// The states are the files the kernel leaves, written here in the shapes it writes them
// (buildQuarantineMarker, scheduleDeferredSelfRetirement, completeDeferredRetirement).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { killAndReap, waitUntil } from "./helpers/host-fixture.mjs";
import { v2Deployment } from "./helpers/v2-deployment.mjs";
import { processStartToken } from "../lib/worktree-hooks.mjs";
import { deferredRetireResultPath, retirePendingMarkerPath } from "../lib/instance-listing.mjs";

const REQUESTED = "2026-10-30T13:21:50.000Z", COMPLETED = "2026-10-30T13:22:04.000Z", QUARANTINED = "2026-10-29T08:00:00.000Z";

/** Every entry under `dir` as path → kind, size and mtime, links not followed; files' bytes hashed. */
function snapshot(dir, out = new Map()) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const st = lstatSync(path);
    out.set(path, `${st.mode}:${st.size}:${st.mtimeMs}${st.isFile() ? `:${createHash("sha256").update(readFileSync(path)).digest("hex")}` : ""}`);
    if (st.isDirectory()) snapshot(path, out);
  }
  return out;
}
const doctor = (fx, json) => {
  const r = fx.cli(json ? ["doctor", "--json"] : ["doctor"]);
  assert.equal(r.status, 0, `doctor exits 0 with problems, as before\n${r.stdout}\n${r.stderr}`);
  return json ? JSON.parse(r.stdout) : r.stdout;
};
const retireProblems = (doc) => (doc.problems ?? []).filter((p) => p.code === "retire-incomplete");

/** The quarantine marker an ordinary retire writes when a hook did not finish (buildQuarantineMarker). */
const quarantine = (name, { hooks = [], git = [], extra = {} } = {}) => ({
  instance: name, agent: "dev", reason: "retire hook reported incomplete cleanup", failed: hooks,
  incomplete: hooks.map((cap) => `retire hook ${cap}: exited 1`), retainedFor: "credentials/metadata needed to retry cleanup",
  cleanup: { version: 1, repo: "/r", work: "directory", launched: false, outstanding: { hooks, git }, capabilityRuntime: [], capabilityMeta: {} },
  createdAt: QUARANTINED, ...extra,
});
/** The pending marker a `--self` writes (scheduleDeferredSelfRetirement), naming its completion. */
const pending = (i, completion) => ({
  instance: i.name, agent: "dev", root: i.root, requestedAt: REQUESTED, requestedByPid: 1, delaySec: 8,
  options: { home: i.home, tmuxSession: "oats-agents" }, resultPath: deferredRetireResultPath(i.home), completionPid: completion.pid, completionStart: completion.start,
});
/** The outcome a completion that did not complete writes beside the home (completeDeferredRetirement). */
const outcome = (i, payload) => ({ instance: i.name, agent: "dev", requestedAt: REQUESTED, completedAt: COMPLETED, ok: false, ...payload, retry: `oats retire ${i.name} --home ${i.home}` });
const write = (path, value) => writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");

/** A process that has ended, as a marker names it: its pid and the start it had. */
async function endedProcess() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  let start = null;
  await waitUntil(() => (start = processStartToken(child.pid)) !== null, "the process to start");
  await killAndReap(child.pid);
  return { pid: child.pid, start };
}

test("doctor: with no retirement open there is no retire-incomplete problem, in JSON or text", async (t) => {
  const fx = v2Deployment({ t });
  const { home } = await fx.spawn("dev", { name: "fine" });
  // A self-retire that is running is not open either: its completion is this live process.
  write(retirePendingMarkerPath(home), pending({ name: "fine", home, root: fx.root }, { pid: process.pid, start: processStartToken(process.pid) }));
  const doc = doctor(fx, true);
  assert.equal(Object.hasOwn(doc, "problems"), false, "nothing open: no problems key at all");
  assert.equal(doctor(fx, false).includes("retire-incomplete"), false, "and no line in text");
});

test("doctor lists one retire-incomplete problem per open retirement, with the command that finishes it and the capability whose hook failed last; it is read-only", async (t) => {
  const fx = v2Deployment({ t });
  const spawnAs = async (name) => { const { home } = await fx.spawn("dev", { name }); return { name, home, root: fx.root }; };
  const names = ["quarantined", "moved", "selfhooks", "selferror", "interrupted", "refused", "broken", "running", "unknown", "spawning"];
  const i = {};
  for (const name of names) i[name] = await spawnAs(name);
  const ended = await endedProcess();
  const me = { pid: process.pid, start: processStartToken(process.pid) };
  const marker = (h) => join(h.home, ".oats-rollback-incomplete.json");

  // An ordinary retire whose hook failed: the quarantine owes oats.aweb's hook.
  write(marker(i.quarantined), quarantine("quarantined", { hooks: ["oats.aweb"], extra: { lastRetryAt: "2026-11-01T10:00:00.000Z" } }));
  // A quarantine whose first hook (test.first) failed, and whose retry then failed on another
  // (test.latest): `outstanding` is what it first owed, `incomplete` what the retry left. The
  // capability to check is the one that failed last; the outcome's items say the same.
  write(marker(i.moved), quarantine("moved", { hooks: ["test.first"], extra: { incomplete: ["retire hook test.latest: exited 1"], lastRetryAt: "2026-11-02T10:00:00.000Z" } }));
  // A self-retire whose cleanup did not finish (#1747): its marker and outcome stay; the outcome's items
  // name the hook. The quarantine marker was removed by hand, so the outcome is what names it.
  write(retirePendingMarkerPath(i.selfhooks.home), pending(i.selfhooks, ended));
  write(deferredRetireResultPath(i.selfhooks.home), outcome(i.selfhooks, { result: { rollbackIncomplete: ["retire hook oats.aweb: the service answered 503"] } }));
  // A self-retire that failed after its hooks ran, with a code and no hook named.
  write(retirePendingMarkerPath(i.selferror.home), pending(i.selferror, ended));
  write(deferredRetireResultPath(i.selferror.home), outcome(i.selferror, { error: { code: "E_WORK_INSPECTION_FAILED", message: "the work could not be inspected" } }));
  // A self-retire whose completion was killed: its marker names a process that is gone, and no outcome.
  write(retirePendingMarkerPath(i.interrupted.home), pending(i.interrupted, ended));
  // A self-retire refused before anything ran: its marker was removed, its outcome stays.
  write(deferredRetireResultPath(i.refused.home), outcome(i.refused, { error: { code: "E_CHILDREN_RUNNING", message: "kid could not be stopped" } }));
  // A quarantined home whose record cannot be read: said, not skipped.
  write(marker(i.broken), quarantine("broken", { hooks: ["acme.chan", "oats.aweb"], git: ["worktree"] }));
  write(join(i.broken.home, "instance.json"), "{ not json");
  // Not open: a retire under way (its completion alive, waiting between attempts on its quarantine), a
  // marker that cannot be read, a spawn still running its hooks.
  write(marker(i.running), quarantine("running", { hooks: ["oats.aweb"] }));
  write(retirePendingMarkerPath(i.running.home), pending(i.running, me));
  write(retirePendingMarkerPath(i.unknown.home), "{ not json");
  write(marker(i.spawning), quarantine("spawning", { hooks: ["oats.aweb"], extra: { inProgress: { pid: me.pid, processStart: me.start, startedAt: QUARANTINED } } }));
  // Not open: an outcome, readable or not, whose home is gone. `oats status` still lists it.
  const instances = join(fx.root, "dev", "instances");
  write(join(instances, ".oats-retired-gone.json"), outcome({ name: "gone", home: join(instances, "gone") }, { error: { code: "E_LIFECYCLE_FAILED", message: "x" } }));
  write(join(instances, ".oats-retired-lost.json"), "{ not json");

  const before = snapshot(fx.root);
  const doc = doctor(fx, true);
  const text = doctor(fx, false);
  assert.deepEqual(snapshot(fx.root), before, "doctor changed no file of the deployment's homes");

  const found = retireProblems(doc);
  const of = (h) => found.filter((p) => p.message.includes(`(${h.home})`));
  const command = (h) => `oats retire ${h.name} --home ${h.home}`;
  for (const name of ["quarantined", "moved", "selfhooks", "selferror", "interrupted", "refused", "broken"]) assert.equal(of(i[name]).length, 1, `${name}: one problem`);
  for (const name of ["running", "unknown", "spawning"]) assert.equal(of(i[name]).length, 0, `${name}: not listed`);
  assert.equal(found.length, 7, `exactly the open ones: ${JSON.stringify(found, null, 2)}`);
  for (const p of found) assert.deepEqual(Object.keys(p).sort(), ["code", "message", "remedy"], "the existing problem form");

  const [q] = of(i.quarantined);
  assert.equal(q.message, `the retirement of quarantined (${i.quarantined.home}) is not finished: it is quarantined, owing retire hooks of oats.aweb (since 2026-11-01T10:00:00.000Z)`);
  assert.equal(q.remedy, `check the service of oats.aweb, whose retire hook failed last, then run: ${command(i.quarantined)}`);

  const [mv] = of(i.moved);
  assert.equal(mv.message, `the retirement of moved (${i.moved.home}) is not finished: it is quarantined, owing retire hooks of test.first (since 2026-11-02T10:00:00.000Z)`);
  assert.equal(mv.remedy, `check the service of test.latest, whose retire hook failed last, then run: ${command(i.moved)}`, "the hook that failed last, not the one first owed");

  const [sh] = of(i.selfhooks);
  assert.equal(sh.message, `the retirement of selfhooks (${i.selfhooks.home}) is not finished: its self-retire failed at ${COMPLETED}: its cleanup did not finish`);
  assert.equal(sh.remedy, `check the service of oats.aweb, whose retire hook failed last, then run: ${command(i.selfhooks)}`, "named from the outcome's items");

  const [se] = of(i.selferror);
  assert.equal(se.message, `the retirement of selferror (${i.selferror.home}) is not finished: its self-retire failed at ${COMPLETED} (E_WORK_INSPECTION_FAILED): the work could not be inspected`);
  assert.equal(se.remedy, `no failed retire hook is recorded; run: ${command(i.selferror)}`);

  const [it] = of(i.interrupted);
  assert.equal(it.message, `the retirement of interrupted (${i.interrupted.home}) is not finished: its self-retire, requested at ${REQUESTED}, was interrupted: its completion ended without an outcome`);
  assert.equal(it.remedy, `no failed retire hook is recorded; run: ${command(i.interrupted)}`);

  const [rf] = of(i.refused);
  assert.equal(rf.message, `the retirement of refused (${i.refused.home}) is not finished: its self-retire failed at ${COMPLETED}: kid could not be stopped`);
  assert.equal(rf.remedy, `no failed retire hook is recorded; run: ${command(i.refused)}`);

  const [br] = of(i.broken);
  assert.equal(br.message, `the retirement of broken (${i.broken.home}) is not finished: it is quarantined, owing retire hooks of acme.chan, oats.aweb and Git steps (worktree) (since ${QUARANTINED}); its record ${join(i.broken.home, "instance.json")} cannot be read (${(() => { try { JSON.parse("{ not json"); } catch (e) { return e.message; } })()})`);
  assert.equal(br.remedy, `check the service of acme.chan, oats.aweb, whose retire hook failed last, then run: ${command(i.broken)}`);

  // Text: each as `! retire-incomplete: <message>` and the remedy on its own line.
  for (const p of found) assert.ok(text.includes(`\n! retire-incomplete: ${p.message}\n  ${p.remedy}\n`), `text holds ${p.message}`);
  assert.equal(text.split("! retire-incomplete:").length - 1, 7, "one line per problem");

  // oats status still lists the outcomes whose home is gone.
  const status = fx.cli(["status", "--json"]);
  assert.equal(status.status, 0, status.stderr);
  const failures = JSON.parse(status.stdout).agents.find((a) => a.name === "dev").retireFailures.map((f) => f.instance).sort();
  assert.deepEqual(failures, ["gone", "lost", "refused", "selferror", "selfhooks"]);
});
