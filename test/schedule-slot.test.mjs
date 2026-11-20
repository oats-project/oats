// A schedule's job slot (lib/schedule.mjs acquireJobLock, jobLockInfo, releaseJobLock): the
// directory `<deployment>/.agents/schedules/locks/<id>/` and its record `owner.json`, which
// stands for a run until that run's instance ends. It is no process mutex: the host lock
// serializes every taker and releaser. What is pinned here is that the slot is never there
// without its record, whatever step of taking or releasing it fails. Every directory, file and
// permission is a real one.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireJobLock, jobLockInfo, releaseJobLock, stateDir } from "../lib/schedule.mjs";

const ROOT = process.getuid?.() === 0 && "root writes anywhere";

function fixture(t) {
  const ws = mkdtempSync(join(tmpdir(), "oats-schedule-slot-"));
  t.after(() => {
    try { chmodSync(join(stateDir(ws), "locks"), 0o700); } catch { /* not made */ }
    rmSync(ws, { recursive: true, force: true });
  });
  const locks = join(stateDir(ws), "locks");
  mkdirSync(locks, { recursive: true });
  return { ws, locks, slot: (id) => join(locks, id) };
}
const absent = (path) => { try { lstatSync(path); return false; } catch (e) { if (e.code === "ENOENT") return true; throw e; } };

test("a slot is taken with its whole record, once; a second taker is answered false and changes nothing; a release removes it", (t) => {
  const f = fixture(t);
  assert.equal(acquireJobLock(f.ws, "job", { scheduledFor: "2026-09-25T10:00:00.000Z" }), true);
  const record = jobLockInfo(f.ws, "job");
  assert.equal(record.scheduledFor, "2026-09-25T10:00:00.000Z");
  assert.equal(record.pid, process.pid);
  assert.deepEqual(readdirSync(f.slot("job")), ["owner.json"]);
  const bytes = readFileSync(join(f.slot("job"), "owner.json"));
  assert.equal(acquireJobLock(f.ws, "job", { scheduledFor: "2026-09-25T10:01:00.000Z" }), false);
  assert.deepEqual(readFileSync(join(f.slot("job"), "owner.json")), bytes, "the holder's record is left byte for byte");
  releaseJobLock(f.ws, "job");
  assert.equal(jobLockInfo(f.ws, "job"), null);
  assert.deepEqual(readdirSync(f.locks), [], "nothing is left among the slots");
  assert.equal(acquireJobLock(f.ws, "job", { scheduledFor: "2026-09-25T10:02:00.000Z" }), true, "a released slot is taken again");
});

test("a slot whose record cannot be written is never left without it: the taker fails and no slot is there", { skip: ROOT }, (t) => {
  const f = fixture(t);
  // Under this mask a directory the taker makes can be entered and not written: the record's
  // write fails after the directory it belongs in was made.
  const mask = process.umask(0o277);
  let failure;
  try { acquireJobLock(f.ws, "job", { scheduledFor: "2026-09-25T10:00:00.000Z" }); }
  catch (e) { failure = e; }
  finally { process.umask(mask); }
  assert.equal(failure?.code, "EACCES", `the system's own error is thrown (${failure?.code}: ${failure?.message})`);
  assert.equal(absent(f.slot("job")), true, "no slot is there without its record");
  assert.equal(jobLockInfo(f.ws, "job"), null);
  assert.deepEqual(readdirSync(f.locks), []);
  assert.equal(acquireJobLock(f.ws, "job", { scheduledFor: "2026-09-25T10:01:00.000Z" }), true, "the next taker takes the slot");
});

test("a slot that cannot be released keeps its record: it is held, as it was, never left without it", { skip: ROOT }, (t) => {
  const f = fixture(t);
  assert.equal(acquireJobLock(f.ws, "job", { scheduledFor: "2026-09-25T10:00:00.000Z" }), true);
  const before = jobLockInfo(f.ws, "job");
  // The slot's own entry cannot be removed from the slots while their directory is not writable.
  chmodSync(f.locks, 0o500);
  let failure;
  try { releaseJobLock(f.ws, "job"); }
  catch (e) { failure = e; }
  finally { chmodSync(f.locks, 0o700); }
  assert.equal(failure?.code, "EACCES", `the system's own error is thrown (${failure?.code}: ${failure?.message})`);
  assert.deepEqual(jobLockInfo(f.ws, "job"), before, "the slot is still there with its record");
  releaseJobLock(f.ws, "job");
  assert.equal(jobLockInfo(f.ws, "job"), null);
});

test("a slot directory without its record, as an earlier kernel could leave one, is held and left as it is", (t) => {
  const f = fixture(t);
  mkdirSync(f.slot("job"));
  assert.equal(acquireJobLock(f.ws, "job", { scheduledFor: "2026-09-25T10:00:00.000Z" }), false);
  assert.deepEqual(readdirSync(f.slot("job")), [], "nothing is written into it");
  assert.deepEqual(jobLockInfo(f.ws, "job"), { unreadable: true });
});
