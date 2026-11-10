// `oats doctor` reports the machine sweep's lock when it needs a person, as one `resume-lock-stuck`
// problem: a record that cannot be read, a holder that cannot be judged, a gone holder's record
// that cannot be taken over, and the lock directory of an earlier kernel. A free lock, a sweep that
// runs and a lock a gone sweep left (the next sweep takes it over) are not reported. Doctor reads
// the lock where the sweep would take it (lib/session-resume.mjs resumeLockProblem), takes nothing
// and changes nothing, and its exit status is as before (0).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootId } from "../lib/session-resume.mjs";
import { processStartToken } from "../lib/worktree-hooks.mjs";
import { v2Deployment } from "./helpers/v2-deployment.mjs";

const NONCE = "a".repeat(32), AT = "2026-10-10T00:00:00.000Z";

/** A deployment, and a machine state directory of its own for doctor to read the lock in. */
function fixture(t) {
  const fx = v2Deployment({ t });
  const oatsHome = join(fx.base, "oats-home"), dir = join(oatsHome, "session-resume"), lock = join(dir, "lock");
  mkdirSync(dir, { recursive: true });
  const doctor = (json) => {
    const r = fx.cli(json ? ["doctor", "--json"] : ["doctor"], { env: { OATS_HOME_DIR: oatsHome } });
    assert.equal(r.status, 0, `doctor exits 0 with problems, as before\n${r.stdout}\n${r.stderr}`);
    return json ? JSON.parse(r.stdout) : r.stdout;
  };
  return { lock, dir, doctor, problems: () => (doctor(true).problems ?? []).filter((p) => p.code === "resume-lock-stuck") };
}
/** A real pid whose process has exited and been reaped. */
const exitedPid = () => spawnSync(process.execPath, ["-e", ""], { timeout: 30000 }).pid;
const removeFile = (lock) => `if no oats session resume is running on this machine, remove ${lock} and run it again`;
const problem = (lock, why, remedy = removeFile(lock)) => ({ code: "resume-lock-stuck", message: `the session resume lock ${lock} cannot be taken (${why}): oats session resume starts nothing on this machine while it is there`, remedy });

test("doctor: a free lock, a sweep that runs and a lock a gone sweep left are no resume-lock-stuck problem, in JSON or text", (t) => {
  const f = fixture(t);
  const own = processStartToken(process.pid), boot = bootId();
  for (const [what, record] of [
    ["no lock", undefined],
    ["a sweep that runs", { bootId: boot, pid: process.pid, processStart: own, nonce: NONCE, at: AT }],
    ["a sweep that is gone", { bootId: boot, pid: exitedPid(), processStart: own, nonce: NONCE, at: AT }],
  ]) {
    const bytes = record === undefined ? null : JSON.stringify(record) + "\n";
    if (bytes !== null) writeFileSync(f.lock, bytes);
    assert.deepEqual(f.problems(), [], what);
    assert.equal(f.doctor(false).includes("resume-lock-stuck"), false, `${what}: no line in text`);
    if (bytes !== null) assert.equal(readFileSync(f.lock, "utf8"), bytes, `${what}: the lock is as it was`);
    assert.deepEqual(readdirSync(f.dir), bytes === null ? [] : ["lock"], what);
    rmSync(f.lock, { force: true });
  }
});

test("doctor reports a lock that needs a person as one resume-lock-stuck problem, naming the path, what was found and what to do; it is read-only", (t) => {
  const f = fixture(t);
  const gone = exitedPid();
  for (const [what, bytes, why] of [
    ["a record that does not parse", "{incomplete owner JSON\n", `the record at ${f.lock} is unreadable`],
    ["a live pid with no start to compare", JSON.stringify({ bootId: bootId(), pid: process.pid, nonce: NONCE, at: AT }) + "\n",
      `whether pid ${process.pid}, which holds it, still runs cannot be established: pid ${process.pid} runs, and the record names no start time to compare it with`],
    ["a gone holder with no nonce", JSON.stringify({ pid: gone }) + "\n",
      `the holder of ${f.lock}, pid ${gone}, is gone, and that file cannot be taken over (its nonce is not the 32 hexadecimal digits a claim carries); it must be removed`],
  ]) {
    writeFileSync(f.lock, bytes);
    const want = problem(f.lock, why);
    assert.deepEqual(f.problems(), [want], what);
    assert.ok(f.doctor(false).includes(`\n! resume-lock-stuck: ${want.message}\n  ${want.remedy}\n`), what);
    assert.equal(readFileSync(f.lock, "utf8"), bytes, `${what}: the lock is as it was`);
    assert.deepEqual(readdirSync(f.dir), ["lock"], what);
    rmSync(f.lock);
  }
  // The lock directory of an earlier kernel, whoever its owner is.
  mkdirSync(f.lock);
  const owner = JSON.stringify({ pid: process.pid, bootId: bootId(), at: AT }) + "\n";
  writeFileSync(join(f.lock, "owner.json"), owner);
  const want = problem(f.lock, `${f.lock} is a lock directory written by an earlier kernel`, `once no earlier oats is running on this machine, remove the directory ${f.lock} and run it again`);
  assert.deepEqual(f.problems(), [want]);
  assert.ok(f.doctor(false).includes(`\n! resume-lock-stuck: ${want.message}\n  ${want.remedy}\n`));
  assert.equal(readFileSync(join(f.lock, "owner.json"), "utf8"), owner);
  assert.deepEqual(readdirSync(f.dir), ["lock"]);
});
