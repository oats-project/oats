// The lock of lib/dir-lock.mjs: a claim file (lib/claim.mjs) at a path, held by one process at a
// time, taken over from a holder that is verifiably gone, never from one that lives or that cannot
// be judged. Every holder and contender that is not this process is a real separate process that
// imports the real module; every lock, record and directory is a real one. Nothing of the lock is
// replaced by a double.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { withDirLock } from "../lib/dir-lock.mjs";
import { isStartToken, processStartToken } from "../lib/worktree-hooks.mjs";

const lockUrl = new URL("../lib/dir-lock.mjs", import.meta.url).href;
const NONCE = "a".repeat(32);
const AT = "2026-10-10T00:00:00.000Z";
/** The caller's refusal, as each caller of the lock makes its own from `why`. */
const busy = (why) => Object.assign(new Error(why), { code: "E_TEST_BUSY" });
/** How long past its wait a refusal may take on a slow host: every liveness read may be a `ps`. */
const SLACK_MS = 2500;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "oats-dir-lock-"));
  t.after(() => { try { chmodSync(root, 0o700); } catch { /* gone */ } rmSync(root, { recursive: true, force: true }); });
  const state = mkdtempSync(join(tmpdir(), "oats-dir-lock-state-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  return { root, state, path: join(root, "registry.lock"), entries: () => readdirSync(root).sort() };
}
/** A real pid whose process has exited and been reaped. */
function exitedPid() {
  const exited = spawnSync(process.execPath, ["-e", ""], { timeout: 5000 });
  assert.equal(exited.status, 0);
  assert.throws(() => process.kill(exited.pid, 0), { code: "ESRCH" });
  return exited.pid;
}
/** This process's start token, and one that is a start token and is not this process's. */
function startTokens() {
  const own = processStartToken(process.pid);
  assert.ok(isStartToken(own), `fixture premise: this host reads a process's start (${own})`);
  const other = own.startsWith("proc:") ? (own === "proc:1" ? "proc:2" : "proc:1") : (own === "ps:Thu Jan  1 00:00:00 1970" ? "ps:Fri Jan  2 00:00:00 1970" : "ps:Thu Jan  1 00:00:00 1970");
  assert.ok(isStartToken(other) && other !== own);
  return { own, other };
}
async function until(predicate, what, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= end) assert.fail(`timed out waiting for ${what}`);
    await delay(5);
  }
}

/** A separate process that runs `script` (an ES module's text), bounded by a watchdog. */
function child(t, script, { watchdogMs = 15000 } = {}) {
  const proc = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", expired = false;
  proc.stdout.on("data", (data) => { stdout += data; });
  proc.stderr.on("data", (data) => { stderr += data; });
  const watchdog = setTimeout(() => { expired = true; proc.kill("SIGKILL"); }, watchdogMs);
  const closed = new Promise((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (code, signal) => { clearTimeout(watchdog); resolve({ code, signal }); });
  });
  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    await closed;
  });
  return {
    proc, closed,
    /** The one JSON line the script printed, once it has ended by itself. */
    async result() {
      const { code, signal } = await closed;
      assert.equal(expired, false, `the process ends within its bound, without a watchdog kill: ${stdout}${stderr}`);
      assert.equal(signal, null, stderr);
      assert.equal(code, 0, stderr);
      return JSON.parse(stdout);
    },
  };
}

/** A process that takes the lock and holds it until `<state>/release` exists (or it is killed).
 *  Resolves once it is inside `fn`. → { proc, closed, release() }. */
let holders = 0;
async function holder(t, f) {
  const holding = join(f.state, `holding-${++holders}`), release = join(f.state, `release-${holders}`);
  const h = child(t, `
import fs from 'node:fs';
const { withDirLock } = await import(${JSON.stringify(lockUrl)});
withDirLock(${JSON.stringify(f.path)}, 'a holder', () => {
  fs.writeFileSync(${JSON.stringify(holding)}, String(process.pid));
  const cell = new Int32Array(new SharedArrayBuffer(4)), end = Date.now() + 12000;
  while (!fs.existsSync(${JSON.stringify(release)}) && Date.now() < end) Atomics.wait(cell, 0, 0, 5);
}, { busy: (why) => Object.assign(new Error(why), { code: 'E_TEST_BUSY' }) });
`);
  await Promise.race([until(() => existsSync(holding), "the holder to hold the lock"), h.closed.then(() => { if (!existsSync(holding)) assert.fail("the holder ended before it held the lock"); })]);
  assert.equal(Number(readFileSync(holding, "utf8")), h.proc.pid);
  return { ...h, async release() { writeFileSync(release, ""); await h.closed; } };
}

/** A process that tries the lock once, waiting `retryMs` → what it answered:
 *  { value, entered, elapsedMs } or { code, message, entered, elapsedMs }. `<state>/started-<n>`
 *  exists once it is about to call the lock. */
let contenders = 0;
function contender(t, f, retryMs) {
  const started = join(f.state, `started-${++contenders}`);
  const c = child(t, `
import fs from 'node:fs';
const { withDirLock } = await import(${JSON.stringify(lockUrl)});
let entered = false;
fs.writeFileSync(${JSON.stringify(started)}, '');
const start = Date.now();
try {
  const value = withDirLock(${JSON.stringify(f.path)}, 'a contender', () => { entered = true; return 'acquired'; },
    { retryMs: ${retryMs}, busy: (why) => Object.assign(new Error(why), { code: 'E_TEST_BUSY' }) });
  console.log(JSON.stringify({ value, entered, elapsedMs: Date.now() - start }));
} catch (error) {
  console.log(JSON.stringify({ code: error.code, message: error.message, entered, elapsedMs: Date.now() - start }));
}
`);
  return { ...c, started: () => until(() => existsSync(started), "the contender to start") };
}

/** `fn` is refused with the caller's `busy`, without entering → the refusal's `why`. */
function refusedHere(path, retryMs = 0) {
  let entered = false;
  try { withDirLock(path, "this test", () => { entered = true; }, { retryMs, busy }); }
  catch (e) {
    assert.equal(e.code, "E_TEST_BUSY", `${e.code}: ${e.message}`);
    assert.equal(entered, false);
    return e.message;
  }
  assert.fail("the lock was taken");
}

test("an acquirer runs fn holding a record that names it, returns what fn returns, and leaves nothing at the path or beside it", (t) => {
  const f = fixture(t);
  const value = withDirLock(f.path, "a test", () => {
    assert.ok(lstatSync(f.path).isFile(), "the lock is one file");
    const record = JSON.parse(readFileSync(f.path, "utf8"));
    assert.deepEqual([record.pid, record.processStart, record.what], [process.pid, processStartToken(process.pid), "a test"]);
    assert.match(record.nonce, /^[0-9a-f]{32}$/);
    assert.deepEqual(f.entries(), ["registry.lock"], "nothing else is beside it while it is held");
    return { answer: 42 };
  }, { busy });
  assert.deepEqual(value, { answer: 42 });
  assert.deepEqual(f.entries(), []);
  // It can be taken again at once, and its parent directories are made.
  const deep = join(f.root, "a", "b", "deep.lock");
  assert.equal(withDirLock(deep, "a test", () => existsSync(deep), { busy }), true);
  assert.equal(existsSync(deep), false);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`${signal} inside a locked section waits for it: fn completes, the lock is released, and then the signal ends the process as it would have`, async (t) => {
    const f = fixture(t);
    const inside = join(f.state, "inside"), signalled = join(f.state, "signalled"), finished = join(f.state, "finished"), after = join(f.state, "after"), late = join(f.state, "late");
    const c = child(t, `
import fs from 'node:fs';
const { withDirLock } = await import(${JSON.stringify(lockUrl)});
withDirLock(${JSON.stringify(f.path)}, 'a section', () => {
  fs.writeFileSync(${JSON.stringify(inside)}, '');
  const cell = new Int32Array(new SharedArrayBuffer(4)), end = Date.now() + 12000;
  while (!fs.existsSync(${JSON.stringify(signalled)}) && Date.now() < end) Atomics.wait(cell, 0, 0, 5);
  // The signal has been sent: the rest of the section still runs.
  Atomics.wait(cell, 0, 0, 200);
  fs.writeFileSync(${JSON.stringify(finished)}, fs.readFileSync(${JSON.stringify(f.path)}, 'utf8'));
}, { busy: (why) => Object.assign(new Error(why), { code: 'E_TEST_BUSY' }) });
fs.writeFileSync(${JSON.stringify(after)}, String(fs.existsSync(${JSON.stringify(f.path)})));
// What only a process the signal did not end would do.
setTimeout(() => fs.writeFileSync(${JSON.stringify(late)}, ''), 3000);
`);
    await until(() => existsSync(inside), "the process to be inside fn");
    c.proc.kill(signal);
    writeFileSync(signalled, "");
    const ended = await c.closed;
    assert.equal(JSON.parse(readFileSync(finished, "utf8")).pid, c.proc.pid, "fn ran to its end, holding the lock");
    assert.equal(readFileSync(after, "utf8"), "false", "the lock was released before anything else ran");
    assert.deepEqual(ended, { code: null, signal }, "the process ended by the signal, with its default action");
    assert.equal(existsSync(late), false);
    assert.deepEqual(f.entries(), [], "nothing is left at the path or beside it");
    assert.equal(withDirLock(f.path, "a test", () => "free", { busy }), "free");
  });
}

test("the lock listens for a signal only around a section: with none arrived, its listeners are gone once the event loop turns, and a later signal is the process's own", async (t) => {
  const f = fixture(t);
  const c = child(t, `
const { withDirLock } = await import(${JSON.stringify(lockUrl)});
const count = () => ['SIGINT', 'SIGTERM'].map((s) => process.listenerCount(s));
const before = count();
const busy = (why) => Object.assign(new Error(why), { code: 'E_TEST_BUSY' });
let during;
for (let n = 0; n < 3; n++) withDirLock(${JSON.stringify(f.path)}, 'a section', () => { during = count(); }, { busy });
await new Promise((resolve) => setTimeout(resolve, 50));
console.log(JSON.stringify({ before, during, after: count() }));
`);
  assert.deepEqual(await c.result(), { before: [0, 0], during: [1, 1], after: [0, 0] });
});

test("an error fn throws propagates as it is, and the lock is released", (t) => {
  const f = fixture(t);
  const boom = new Error("from fn");
  assert.throws(() => withDirLock(f.path, "a test", () => { throw boom; }, { busy }), (e) => e === boom);
  assert.deepEqual(f.entries(), []);
  assert.equal(withDirLock(f.path, "a test", () => "again", { busy }), "again");
});

test("a failure of the system's to write the lock is thrown as the system's own error, not as the caller's busy", { skip: process.getuid?.() === 0 && "root writes anywhere" }, (t) => {
  const f = fixture(t);
  chmodSync(f.root, 0o500);
  let entered = false;
  assert.throws(() => withDirLock(f.path, "a test", () => { entered = true; }, { busy }), (e) => e.code === "EACCES" && typeof e.syscall === "string");
  assert.equal(entered, false);
});

test("a live holder makes a contender wait for retryMs and then refuse with the caller's busy, without entering; the holder's record is unchanged", async (t) => {
  const f = fixture(t);
  const h = await holder(t, f);
  const record = readFileSync(f.path, "utf8");
  assert.equal(JSON.parse(record).pid, h.proc.pid);
  const waited = await contender(t, f, 400).result();
  assert.equal(waited.code, "E_TEST_BUSY", JSON.stringify(waited));
  assert.equal(waited.message, `pid ${h.proc.pid} holds it`);
  assert.equal(waited.entered, false);
  assert.ok(waited.elapsedMs >= 390 && waited.elapsedMs < 400 + SLACK_MS, JSON.stringify(waited));
  assert.equal(readFileSync(f.path, "utf8"), record, "the holder's record is byte for byte what it was");
  // With no wait the refusal is immediate.
  const immediate = await contender(t, f, 0).result();
  assert.equal(immediate.code, "E_TEST_BUSY", JSON.stringify(immediate));
  assert.equal(immediate.message, `pid ${h.proc.pid} holds it`);
  assert.equal(immediate.entered, false);
  assert.ok(immediate.elapsedMs < SLACK_MS, JSON.stringify(immediate));
  assert.equal(readFileSync(f.path, "utf8"), record);
  assert.deepEqual(f.entries(), ["registry.lock"], "a refused contender leaves nothing beside the lock");
  // Released by its holder, it is taken.
  await h.release();
  assert.deepEqual(f.entries(), []);
  assert.equal((await contender(t, f, 0).result()).value, "acquired");
});

test("a holder killed with SIGKILL while it holds the lock: the next acquirer takes the lock over, runs fn and releases it, with no cleanup by hand", async (t) => {
  const f = fixture(t);
  const h = await holder(t, f);
  h.proc.kill("SIGKILL");
  assert.deepEqual(await h.closed, { code: null, signal: "SIGKILL" });
  assert.equal(JSON.parse(readFileSync(f.path, "utf8")).pid, h.proc.pid, "the killed holder left its lock");
  const next = await contender(t, f, 0).result();
  assert.deepEqual([next.value, next.entered], ["acquired", true], JSON.stringify(next));
  assert.deepEqual(f.entries(), [], "the lock is released, and nothing of the takeover is left");
  // And so does this process, the same way, every time a holder is killed.
  const again = await holder(t, f);
  again.proc.kill("SIGKILL");
  await again.closed;
  assert.equal(withDirLock(f.path, "a test", () => "entered", { busy }), "entered");
  assert.deepEqual(f.entries(), []);
});

test("a record naming a pid that exited is taken over", async (t) => {
  const f = fixture(t);
  writeFileSync(f.path, JSON.stringify({ what: "an exited holder", pid: exitedPid(), processStart: "proc:1", nonce: NONCE, at: AT }) + "\n");
  const next = await contender(t, f, 0).result();
  assert.deepEqual([next.value, next.entered], ["acquired", true], JSON.stringify(next));
  assert.deepEqual(f.entries(), []);
});

test("a record naming a pid that runs with another start, a reused pid, is taken over", async (t) => {
  const f = fixture(t);
  writeFileSync(f.path, JSON.stringify({ what: "a holder whose pid was reused", pid: process.pid, processStart: startTokens().other, nonce: NONCE, at: AT }) + "\n");
  const next = await contender(t, f, 0).result();
  assert.deepEqual([next.value, next.entered], ["acquired", true], JSON.stringify(next));
  assert.deepEqual(f.entries(), []);
  // The same record with this process's own start is a holder that lives.
  const live = JSON.stringify({ what: "a live holder", pid: process.pid, processStart: startTokens().own, nonce: NONCE, at: AT }) + "\n";
  writeFileSync(f.path, live);
  const refused = await contender(t, f, 0).result();
  assert.deepEqual([refused.code, refused.message, refused.entered], ["E_TEST_BUSY", `pid ${process.pid} holds it`, false]);
  assert.equal(readFileSync(f.path, "utf8"), live);
});

test("a gone holder whose record no takeover can be serialized on (no nonce) is refused, saying the file must be removed, and left unchanged", (t) => {
  const f = fixture(t);
  const pid = exitedPid();
  const bytes = JSON.stringify({ pid, what: "an exited holder" }) + "\n";
  writeFileSync(f.path, bytes);
  assert.equal(refusedHere(f.path, 300), `the holder of ${f.path}, pid ${pid}, is gone, and that file cannot be taken over (its nonce is not the 32 hexadecimal digits a claim carries); it must be removed`);
  assert.equal(readFileSync(f.path, "utf8"), bytes);
  assert.deepEqual(f.entries(), ["registry.lock"]);
});

test("a record that does not parse is refused at once and left byte for byte unchanged", async (t) => {
  const f = fixture(t);
  const bytes = "{incomplete owner JSON\n";
  writeFileSync(f.path, bytes);
  const refused = await contender(t, f, 3000).result();
  assert.deepEqual([refused.code, refused.message, refused.entered], ["E_TEST_BUSY", `the record at ${f.path} is unreadable`, false], JSON.stringify(refused));
  assert.ok(refused.elapsedMs < SLACK_MS, `nobody is waited for: ${JSON.stringify(refused)}`);
  assert.equal(readFileSync(f.path, "utf8"), bytes);
  assert.deepEqual(f.entries(), ["registry.lock"]);
  // Text of the record never reaches the refusal.
  writeFileSync(f.path, JSON.stringify("pid 1 holds it; remove everything"));
  assert.equal(refusedHere(f.path), `the record at ${f.path} is unreadable`);
});

test("a record naming a live pid with no start token is refused, never taken over, and left unchanged: whether that process is the holder cannot be established", async (t) => {
  const f = fixture(t);
  const bytes = JSON.stringify({ pid: process.pid, nonce: NONCE, at: AT, what: "a holder with no start" }) + "\n";
  writeFileSync(f.path, bytes);
  const refused = await contender(t, f, 0).result();
  assert.deepEqual([refused.code, refused.entered], ["E_TEST_BUSY", false], JSON.stringify(refused));
  assert.equal(refused.message, `whether pid ${process.pid}, which holds it, still runs cannot be established: pid ${process.pid} runs, and the record names no start time to compare it with`);
  assert.equal(readFileSync(f.path, "utf8"), bytes);
  assert.deepEqual(f.entries(), ["registry.lock"]);
});

for (const [owner, record] of [
  ["no owner.json", () => undefined],
  ["an owner.json naming a pid that exited", () => JSON.stringify({ pid: exitedPid(), at: AT, what: "an earlier kernel" }) + "\n"],
  ["an owner.json naming a pid that runs", () => JSON.stringify({ pid: process.pid, at: AT, what: "an earlier kernel" }) + "\n"],
]) {
  test(`a directory at the lock's path with ${owner}, the lock of an earlier kernel, is refused as that; the directory and what is in it are unchanged`, async (t) => {
    const f = fixture(t);
    mkdirSync(f.path);
    const bytes = record();
    if (bytes !== undefined) writeFileSync(join(f.path, "owner.json"), bytes);
    const refused = await contender(t, f, 300).result();
    assert.deepEqual([refused.code, refused.entered], ["E_TEST_BUSY", false], JSON.stringify(refused));
    assert.equal(refused.message, `${f.path} is a lock directory written by an earlier kernel`);
    assert.ok(lstatSync(f.path).isDirectory());
    assert.deepEqual(readdirSync(f.path), bytes === undefined ? [] : ["owner.json"]);
    if (bytes !== undefined) assert.equal(readFileSync(join(f.path, "owner.json"), "utf8"), bytes);
    assert.deepEqual(f.entries(), ["registry.lock"]);
    // Removed by the operator, as the callers' messages say, the lock is taken.
    rmSync(f.path, { recursive: true });
    assert.equal(withDirLock(f.path, "a test", () => "entered", { busy }), "entered");
  });
}

test("a contender whose holder is killed while it waits takes the lock within its wait", async (t) => {
  const f = fixture(t);
  const h = await holder(t, f);
  const c = contender(t, f, 6000);
  await c.started();
  await delay(250); // the contender is waiting on the live holder by now, or about to
  assert.equal(c.proc.exitCode, null, "the contender waits while the holder lives");
  h.proc.kill("SIGKILL");
  await h.closed;
  const result = await c.result();
  assert.deepEqual([result.value, result.entered], ["acquired", true], JSON.stringify(result));
  assert.ok(result.elapsedMs < 6000, JSON.stringify(result));
  assert.deepEqual(f.entries(), []);
});

test("mutual exclusion under contention: no two processes are ever inside fn at once, and no increment of a counter read and written under the lock is lost", async (t) => {
  const f = fixture(t);
  const N = 8, M = 10;
  const counter = join(f.state, "counter"), inside = join(f.state, "inside"), go = join(f.state, "go");
  writeFileSync(counter, "0");
  const workers = Array.from({ length: N }, () => child(t, `
import fs from 'node:fs';
const { withDirLock } = await import(${JSON.stringify(lockUrl)});
const cell = new Int32Array(new SharedArrayBuffer(4));
const pause = (ms) => Atomics.wait(cell, 0, 0, ms);
const counter = ${JSON.stringify(counter)}, inside = ${JSON.stringify(inside)};
while (!fs.existsSync(${JSON.stringify(go)})) pause(2);
let done = 0, refused = 0, overlaps = 0, other = [];
for (let i = 0; i < ${M}; i++) {
  try {
    withDirLock(${JSON.stringify(f.path)}, 'a worker', () => {
      // 'wx' fails when the marker exists: another process is inside.
      try { fs.writeFileSync(inside, String(process.pid), { flag: 'wx' }); } catch { overlaps++; return; }
      const n = Number(fs.readFileSync(counter, 'utf8'));
      pause(3);
      fs.writeFileSync(counter, String(n + 1));
      fs.rmSync(inside);
      done++;
    }, { retryMs: 1500, busy: (why) => Object.assign(new Error(why), { code: 'E_TEST_BUSY' }) });
  } catch (error) {
    if (error.code === 'E_TEST_BUSY') refused++; else other.push(String(error.code) + ': ' + error.message);
  }
}
console.log(JSON.stringify({ done, refused, overlaps, other }));
`, { watchdogMs: 90000 }));
  writeFileSync(go, "");
  const results = await Promise.all(workers.map((w) => w.result()));
  assert.deepEqual(results.flatMap((r) => r.other), [], "every refusal is the caller's busy");
  assert.equal(results.reduce((n, r) => n + r.overlaps, 0), 0, "no process entered fn while another was inside");
  const done = results.reduce((n, r) => n + r.done, 0), refused = results.reduce((n, r) => n + r.refused, 0);
  assert.equal(done + refused, N * M, JSON.stringify(results));
  assert.equal(Number(readFileSync(counter, "utf8")), N * M - refused, `no increment is lost: ${JSON.stringify(results)}`);
  assert.ok(results.filter((r) => r.done > 0).length >= 2, `more than one process took the lock: ${JSON.stringify(results)}`);
  assert.equal(existsSync(inside), false);
  assert.deepEqual(f.entries(), [], "nothing is left at the lock's path or beside it");
});
