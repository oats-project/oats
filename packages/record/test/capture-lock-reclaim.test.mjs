// A capture lock whose owner died on this host is reclaimed by the next pass (awebai/oats#437): a capture
// killed mid-pass (a hook or caller timeout) runs no finally, and its lock used to make every later pass skip.
// Only a dead owner recorded on this host is reclaimed, under a guard; a live, unknown, owner-less or
// other-host lock is never touched, and a reclaimer that died holding the guard is named, never removed.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireCaptureLock, captureLockPath, RECLAIM_HOSTLESS_RECORDS } from "../lib/capture-lock.mjs";
import { processStartToken, thisBoot } from "../lib/process-identity.mjs";
import { fixtureEnv } from "./fixture-env.mjs";

const CAPTURE = resolve(new URL("../bin/capture.mjs", import.meta.url).pathname);
const LOCK_LIB = new URL("../lib/capture-lock.mjs", import.meta.url).href;
const DEAD = 999999999;

function root(t) { const r = mkdtempSync(join(tmpdir(), "capture-reclaim-")); t.after(() => rmSync(r, { recursive: true, force: true })); return r; }
const plant = (r, owner) => { mkdirSync(captureLockPath(r), { recursive: true }); if (owner) writeFileSync(join(captureLockPath(r), "owner.json"), JSON.stringify(owner)); };
const ownerOf = (r) => JSON.parse(readFileSync(join(captureLockPath(r), "owner.json"), "utf8"));

test("a dead owner's lock on this host is reclaimed, and the new lock records the host", (t) => {
  const r = root(t);
  plant(r, { pid: DEAD, nonce: "n1", startedAt: "2026-10-01T00:00:00.000Z", host: hostname() });
  const a = acquireCaptureLock(r);
  assert.ok(a.release, JSON.stringify(a.held));
  assert.deepEqual(a.reclaimed, { pid: DEAD, startedAt: "2026-10-01T00:00:00.000Z" });
  assert.equal(ownerOf(r).pid, process.pid);
  assert.equal(ownerOf(r).host, hostname());
  assert.equal(existsSync(`${captureLockPath(r)}.reclaim`), false, "the guard is released");
  assert.deepEqual(a.release(), { released: true });
});

test("a live owner, an owner-less lock and another host's dead owner are never touched", (t) => {
  const r = root(t);
  const child = spawn("sleep", ["30"]); t.after(() => child.kill());
  for (const [label, owner, liveness] of [
    ["live", { pid: child.pid, nonce: "n", startedAt: "x", host: hostname() }, "alive"],
    ["owner-less", null, "unknown"],
    ["another host", { pid: DEAD, nonce: "n", startedAt: "x", host: `not-${hostname()}` }, "dead"],
  ]) {
    rmSync(captureLockPath(r), { recursive: true, force: true });
    plant(r, owner);
    const before = owner ? JSON.stringify(ownerOf(r)) : null;
    const a = acquireCaptureLock(r);
    assert.equal(a.release, undefined, label);
    assert.equal(a.held.liveness, liveness, label);
    assert.equal(existsSync(captureLockPath(r)), true, label);
    if (owner) assert.equal(JSON.stringify(ownerOf(r)), before, `${label}: the record is unchanged`);
  }
});

test("a host-less record (written before owners named their host) counts as this host's: a dead owner's lock is reclaimed", (t) => {
  const r = root(t);
  assert.equal(RECLAIM_HOSTLESS_RECORDS, true);
  plant(r, { pid: DEAD, nonce: "n", startedAt: "x" });
  // With the switch off, it would be left to the operator.
  const kept = acquireCaptureLock(r, { reclaimHostless: false });
  assert.equal(kept.release, undefined);
  assert.match(kept.held.recovery, /ps -p 999999999/);
  const taken = acquireCaptureLock(r);
  assert.ok(taken.release, "by default it is reclaimed like any dead owner on this host");
  assert.deepEqual(taken.reclaimed, { pid: DEAD, startedAt: "x" });
  taken.release();
});

/** What a record names its holder by beside the pid: the boot it was taken in and the holder's start. */
const identityOf = (pid) => ({ bootId: thisBoot(), processStart: processStartToken(pid) });
const OTHER_BOOT = `another-boot-than-${thisBoot()}`;
const OTHER_HOST = `not-${hostname()}`;

test("a lock this pass takes names its holder by pid, boot and start, and so does the worker it registers", (t) => {
  const r = root(t);
  const child = spawn("sleep", ["30"]); t.after(() => child.kill());
  const a = acquireCaptureLock(r);
  assert.deepEqual(Object.keys(ownerOf(r)).sort(), ["bootId", "host", "nonce", "pid", "processStart", "startedAt"]);
  assert.deepEqual([ownerOf(r).pid, ownerOf(r).bootId, ownerOf(r).processStart], [process.pid, thisBoot(), processStartToken(process.pid)]);
  assert.equal(typeof ownerOf(r).processStart, "string", "this host reads a process's start");
  a.registerWorker({ pid: child.pid, nonce: "w", startedAt: "2026-10-01T00:00:00.000Z" });
  assert.deepEqual(ownerOf(r).worker, { pid: child.pid, nonce: "w", startedAt: "2026-10-01T00:00:00.000Z", host: hostname(), ...identityOf(child.pid) });
  child.kill();
  return new Promise((done) => child.once("exit", done)).then(() => assert.deepEqual(a.release(), { released: true }));
});

test("a lock whose pid runs with another start (a reused pid) is reclaimed", (t) => {
  const r = root(t);
  const child = spawn("sleep", ["30"]); t.after(() => child.kill());
  plant(r, { pid: child.pid, nonce: "n", startedAt: "2026-10-01T00:00:00.000Z", host: hostname(), bootId: thisBoot(), processStart: "proc:1" });
  const a = acquireCaptureLock(r);
  assert.ok(a.release, JSON.stringify(a.held));
  assert.deepEqual(a.reclaimed, { pid: child.pid, startedAt: "2026-10-01T00:00:00.000Z" });
  assert.equal(ownerOf(r).pid, process.pid);
  assert.deepEqual(a.release(), { released: true });
});

test("a lock taken in another boot is reclaimed, though its pid is alive with the recorded start", (t) => {
  const r = root(t);
  const child = spawn("sleep", ["30"]); t.after(() => child.kill());
  plant(r, { pid: child.pid, nonce: "n", startedAt: "2026-10-01T00:00:00.000Z", host: OTHER_HOST, ...identityOf(child.pid), bootId: OTHER_BOOT });
  const a = acquireCaptureLock(r);
  assert.ok(a.release, JSON.stringify(a.held));
  assert.deepEqual(a.reclaimed, { pid: child.pid, startedAt: "2026-10-01T00:00:00.000Z" });
  assert.deepEqual(a.release(), { released: true });
});

test("a record that names its holder's boot and start is judged by them, whatever host it names", (t) => {
  const r = root(t);
  const child = spawn("sleep", ["30"]); t.after(() => child.kill());
  // A holder that is gone: another host's name does not keep its lock.
  plant(r, { pid: DEAD, nonce: "n", startedAt: "2026-10-01T00:00:00.000Z", host: OTHER_HOST, bootId: thisBoot(), processStart: "proc:1" });
  const taken = acquireCaptureLock(r);
  assert.ok(taken.release, JSON.stringify(taken.held));
  assert.deepEqual(taken.reclaimed, { pid: DEAD, startedAt: "2026-10-01T00:00:00.000Z" });
  assert.deepEqual(taken.release(), { released: true });
  // A holder that runs: another host's name does not give its lock away.
  plant(r, { pid: child.pid, nonce: "n", startedAt: "2026-10-01T00:00:00.000Z", host: OTHER_HOST, ...identityOf(child.pid) });
  const before = JSON.stringify(ownerOf(r));
  const refused = acquireCaptureLock(r);
  assert.equal(refused.release, undefined);
  assert.equal(refused.held.liveness, "alive");
  assert.equal(JSON.stringify(ownerOf(r)), before, "the record is unchanged");
});

test("a live holder of this boot with the recorded start is never taken over, and the pass says that it skipped", (t) => {
  const r = root(t);
  const child = spawn("sleep", ["30"]); t.after(() => child.kill());
  plant(r, { pid: child.pid, nonce: "n", startedAt: "2026-10-01T00:00:00.000Z", host: hostname(), ...identityOf(child.pid) });
  const before = JSON.stringify(ownerOf(r));
  const a = acquireCaptureLock(r);
  assert.equal(a.release, undefined);
  assert.deepEqual([a.held.pid, a.held.liveness], [child.pid, "alive"]);
  assert.match(a.held.recovery, /let it finish, the next pass catches up$/);
  const home = join(r, "home"); mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  const p = spawnSync(process.execPath, [CAPTURE, "--sessions-only"], { encoding: "utf8", env: { ...fixtureEnv(), HOME: home, TURN_RECORD_ROOT: r, TURN_RECORD_OWNER: "tester" } });
  assert.equal(p.status, 0, p.stderr + p.stdout);
  assert.match(p.stdout, new RegExp(`another pass holds .* is held by pid ${child.pid} .*let it finish, the next pass catches up; skipping this pass`));
  assert.equal(JSON.stringify(ownerOf(r)), before, "the record is unchanged");
});

test("a registered worker is judged as the owner is: one whose pid runs with another start, or of another boot, is gone; one that runs keeps the lock", (t) => {
  const r = root(t);
  const child = spawn("sleep", ["30"]); t.after(() => child.kill());
  const owner = { pid: DEAD, nonce: "n", startedAt: "2026-10-01T00:00:00.000Z", host: OTHER_HOST, bootId: thisBoot(), processStart: "proc:1" };
  const worker = { pid: child.pid, nonce: "w", startedAt: "2026-10-01T00:00:01.000Z", host: OTHER_HOST };
  for (const [label, identity] of [["another start", { bootId: thisBoot(), processStart: "proc:1" }], ["another boot", { ...identityOf(child.pid), bootId: OTHER_BOOT }]]) {
    plant(r, { ...owner, worker: { ...worker, ...identity } });
    const a = acquireCaptureLock(r);
    assert.ok(a.release, `${label}: ${JSON.stringify(a.held)}`);
    assert.deepEqual(a.reclaimed, { pid: DEAD, startedAt: owner.startedAt }, label);
    assert.deepEqual(a.release(), { released: true }, label);
  }
  plant(r, { ...owner, worker: { ...worker, ...identityOf(child.pid) } });
  const before = JSON.stringify(ownerOf(r));
  const kept = acquireCaptureLock(r);
  assert.equal(kept.release, undefined, "a gone supervisor's lock stays while its worker runs");
  assert.match(kept.held.recovery, new RegExp(`worker pid ${child.pid}; wait for both to finish`));
  assert.equal(JSON.stringify(ownerOf(r)), before, "the record is unchanged");
});

test("a reclaim guard taken in another boot is named as left behind, though its pid is alive", (t) => {
  const r = root(t);
  const child = spawn("sleep", ["30"]); t.after(() => child.kill());
  const guard = `${captureLockPath(r)}.reclaim`;
  plant(r, { pid: DEAD, nonce: "n", startedAt: "x", host: hostname() });
  writeFileSync(guard, JSON.stringify({ pid: child.pid, nonce: "g", host: OTHER_HOST, ...identityOf(child.pid), bootId: OTHER_BOOT }));
  const a = acquireCaptureLock(r);
  assert.equal(a.release, undefined);
  assert.equal(a.held.guard, guard);
  assert.match(a.held.recovery, new RegExp(`left by pid ${child.pid}, which died while reclaiming`));
  assert.equal(existsSync(guard), true, "the guard is never removed by the tool");
});

test("the reclaim guard: a live reclaimer means skip; a reclaimer that died holding it is named, never removed", (t) => {
  const r = root(t);
  const child = spawn("sleep", ["30"]); t.after(() => child.kill());
  const guard = `${captureLockPath(r)}.reclaim`;
  plant(r, { pid: DEAD, nonce: "n", startedAt: "x", host: hostname() });
  writeFileSync(guard, JSON.stringify({ pid: child.pid, nonce: "g", host: hostname() }));
  let a = acquireCaptureLock(r);
  assert.equal(a.release, undefined, "another process is reclaiming: this pass skips");
  assert.equal(existsSync(captureLockPath(r)), true);
  writeFileSync(guard, JSON.stringify({ pid: DEAD - 1, nonce: "g", host: hostname() }));
  a = acquireCaptureLock(r);
  assert.equal(a.release, undefined);
  assert.equal(a.held.guard, guard);
  assert.match(a.held.recovery, new RegExp(`left by pid ${DEAD - 1}, which died while reclaiming.*rm -- '.*\\.capture\\.lock\\.reclaim'`));
  assert.equal(existsSync(guard), true, "the abandoned guard is never removed by the tool");
  assert.equal(existsSync(captureLockPath(r)), true);
});

test("a capture process killed while holding the lock does not block the next pass", (t) => {
  const r = root(t);
  // A process takes the lock and is SIGKILLed: no finally, no release.
  const holder = spawn(process.execPath, ["--input-type=module", "-e", `import { acquireCaptureLock } from ${JSON.stringify(LOCK_LIB)}; const l = acquireCaptureLock(${JSON.stringify(r)}); if (!l.release) process.exit(3); console.log("held"); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => holder.kill("SIGKILL"));
  return new Promise((done, fail) => {
    holder.stdout.once("data", () => {
      holder.kill("SIGKILL");
      holder.once("exit", () => {
        try {
          assert.equal(existsSync(captureLockPath(r)), true, "the killed holder left its lock");
          const home = join(r, "home"); mkdirSync(join(home, ".claude", "projects"), { recursive: true });
          const p = spawnSync(process.execPath, [CAPTURE, "--sessions-only"], { encoding: "utf8", env: { ...fixtureEnv(), HOME: home, TURN_RECORD_ROOT: r, TURN_RECORD_OWNER: "tester" } });
          assert.equal(p.status, 0, p.stderr + p.stdout);
          assert.doesNotMatch(p.stdout + p.stderr, /another pass holds/);
          assert.match(p.stderr, new RegExp(`reclaimed ${captureLockPath(r).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} from pid ${holder.pid}, which died`));
          assert.equal(existsSync(captureLockPath(r)), false, "the pass ran and released");
          done();
        } catch (e) { fail(e); }
      });
    });
  });
});
