// The machine sweep's lock (lib/session-resume.mjs acquireResumeLock): a claim file (lib/claim.mjs)
// at `<OATS_HOME_DIR>/session-resume/lock`, held by one sweep at a time, taken over at once from a
// holder that is verifiably gone or that took it in another boot, never from one that lives or that
// cannot be judged; a lock that needs a person (those two, and the lock directory of a kernel that
// locked with one) is refused with E_RESUME_LOCK_STUCK and left as it is, and `oats doctor`'s read
// of the lock (resumeLockProblem) reports the same states without taking anything. Every holder and contender that is not this process is a real separate process
// that imports the real module; every lock, record and directory is a real one.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acquireResumeLock, resumeLockProblem } from "../lib/session-resume.mjs";
import { isStartToken, processStartToken } from "../lib/worktree-hooks.mjs";

const resumeUrl = new URL("../lib/session-resume.mjs", import.meta.url).href;
const NONCE = "a".repeat(32);
const AT = "2026-10-10T00:00:00.000Z";
const BOOT = "boot-1";
/** A takeover is immediate. The bound is the host's, where every liveness read may be a `ps`. */
const AT_ONCE_MS = 30_000;

/** OATS_HOME_DIR on a scratch directory for one test, its `session-resume/` made. */
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "oats-resume-lock-")), state = mkdtempSync(join(tmpdir(), "oats-resume-lock-state-"));
  const saved = process.env.OATS_HOME_DIR;
  process.env.OATS_HOME_DIR = home;
  t.after(() => {
    if (saved === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = saved;
    for (const d of [home, state]) rmSync(d, { recursive: true, force: true });
  });
  const dir = join(home, "session-resume");
  mkdirSync(dir);
  return { home, state, dir, path: join(dir, "lock"), entries: () => readdirSync(dir).sort() };
}
/** A real pid whose process has exited and been reaped. */
function exitedPid() {
  const exited = spawnSync(process.execPath, ["-e", ""], { timeout: 30000 });
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
async function until(predicate, what, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= end) assert.fail(`timed out waiting for ${what}`);
    await delay(5);
  }
}
const busyOf = (path, why) => `another session resume on this machine holds ${path} (${why}); nothing was started`;
const REMOVE_FILE = (path) => `if no oats session resume is running on this machine, remove ${path} and run it again`;
const REMOVE_DIRECTORY = (path) => `once no earlier oats is running on this machine, remove the directory ${path} and run it again`;
const cannotBeTaken = (path, why) => `the session resume lock ${path} cannot be taken (${why})`;
const stuckOf = (path, why, remedy = REMOVE_FILE(path)) => `${cannotBeTaken(path, why)}; ${remedy}; nothing was started`;
/** What doctor's read answers for a lock that needs a person. */
const problemOf = (path, why, remedy = REMOVE_FILE(path)) => ({ code: "resume-lock-stuck", message: `${cannotBeTaken(path, why)}: oats session resume starts nothing on this machine while it is there`, remedy });
/** Every entry at and under `path` as path → kind, mode, mtime and, for a file, its bytes' hash. */
function snapshot(path, out = {}) {
  const st = lstatSync(path);
  out[path] = `${st.mode}:${st.mtimeMs}${st.isFile() ? `:${createHash("sha256").update(readFileSync(path)).digest("hex")}` : ""}`;
  if (st.isDirectory()) for (const name of readdirSync(path).sort()) snapshot(join(path, name), out);
  return out;
}
/** What is in the sweep's state directory: every entry there, with all that is under it. The
 *  directory's own times are not part of it: taking a claim writes and removes its private file there. */
const contents = (f) => Object.assign({}, ...f.entries().map((name) => snapshot(join(f.dir, name))));

/** A separate process that runs `script` (an ES module's text) on the fixture's OATS_HOME_DIR,
 *  bounded by a watchdog. */
function child(t, f, script, { watchdogMs = 90000 } = {}) {
  const proc = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, OATS_HOME_DIR: f.home } });
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

/** A sweep's process that takes the lock in `boot` and holds it, as a sweep does while its starts
 *  run, until `<state>/release-<n>` exists (or it is killed). Resolves once it holds the lock.
 *  → { proc, closed, release() }. */
let holders = 0;
async function holder(t, f, boot = BOOT) {
  const holding = join(f.state, `holding-${++holders}`), release = join(f.state, `release-${holders}`);
  const h = child(t, f, `
import fs from 'node:fs';
const { acquireResumeLock } = await import(${JSON.stringify(resumeUrl)});
const release = acquireResumeLock({ boot: ${JSON.stringify(boot)} });
fs.writeFileSync(${JSON.stringify(holding)}, String(process.pid));
const end = Date.now() + 80000;
while (!fs.existsSync(${JSON.stringify(release)}) && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
release();
`);
  await Promise.race([until(() => existsSync(holding), "the holder to hold the lock"), h.closed.then(() => { if (!existsSync(holding)) assert.fail("the holder ended before it held the lock"); })]);
  assert.equal(Number(readFileSync(holding, "utf8")), h.proc.pid);
  return { ...h, async release() { writeFileSync(release, ""); await h.closed; } };
}

/** A sweep's process that tries the lock once in `boot` and releases it → what it answered:
 *  { acquired: true, elapsedMs } or { code, message, elapsedMs }. */
function contender(t, f, boot = BOOT) {
  return child(t, f, `
const { acquireResumeLock } = await import(${JSON.stringify(resumeUrl)});
const start = Date.now();
try {
  const release = acquireResumeLock({ boot: ${JSON.stringify(boot)} });
  const elapsedMs = Date.now() - start;
  release();
  console.log(JSON.stringify({ acquired: true, elapsedMs }));
} catch (error) {
  console.log(JSON.stringify({ code: error.code, message: error.message, elapsedMs: Date.now() - start }));
}
`);
}

/** This process is refused the lock with `code` → the refusal. */
function refusal(boot, code) {
  let release;
  try { release = acquireResumeLock({ boot }); }
  catch (e) {
    assert.equal(e.code, code, `${e.code}: ${e.message}`);
    return e;
  }
  release();
  assert.fail("the lock was taken");
}
/** This process is refused the lock by a sweep that runs, E_RESUME_BUSY → the refusal's message. */
const refusedHere = (boot = BOOT) => refusal(boot, "E_RESUME_BUSY").message;
/** This process is refused a lock that needs a person, E_RESUME_LOCK_STUCK with the lock's path and
 *  `found` in its details → the refusal's message. */
function stuckHere(f, found, boot = BOOT) {
  const e = refusal(boot, "E_RESUME_LOCK_STUCK");
  assert.deepEqual(e.details, { lock: f.path, found }, e.message);
  return e.message;
}
/** This process takes the lock and releases it → how long taking it took. */
function takenHere(boot = BOOT) {
  const start = Date.now();
  const release = acquireResumeLock({ boot });
  const elapsedMs = Date.now() - start;
  release();
  return elapsedMs;
}

test("the lock is one claim file that names its holder by pid, process start and boot; released, nothing is left at its path or beside it", (t) => {
  const f = fixture(t);
  const release = acquireResumeLock({ boot: BOOT });
  assert.ok(lstatSync(f.path).isFile(), "the lock is one file");
  const record = JSON.parse(readFileSync(f.path, "utf8"));
  assert.deepEqual([record.pid, record.processStart, record.bootId], [process.pid, processStartToken(process.pid), BOOT]);
  assert.match(record.nonce, /^[0-9a-f]{32}$/);
  assert.deepEqual(f.entries(), ["lock"], "nothing else is beside it while it is held");
  assert.equal(refusedHere(), busyOf(f.path, `pid ${process.pid} holds it`));
  release();
  assert.deepEqual(f.entries(), []);
  assert.ok(takenHere() < AT_ONCE_MS);
});

test("a sweep that runs is busy for another: E_RESUME_BUSY naming its pid, at once, and its record is unchanged; released, the lock is taken", async (t) => {
  const f = fixture(t);
  const h = await holder(t, f);
  const record = readFileSync(f.path, "utf8");
  assert.equal(JSON.parse(record).pid, h.proc.pid);
  const refused = await contender(t, f).result();
  assert.deepEqual([refused.code, refused.message], ["E_RESUME_BUSY", busyOf(f.path, `pid ${h.proc.pid} holds it`)], JSON.stringify(refused));
  assert.ok(refused.elapsedMs < AT_ONCE_MS, JSON.stringify(refused));
  assert.equal(refusedHere(), busyOf(f.path, `pid ${h.proc.pid} holds it`));
  assert.equal(resumeLockProblem({ boot: BOOT }), null, "a sweep that runs is no problem to report");
  assert.equal(readFileSync(f.path, "utf8"), record, "the holder's record is byte for byte what it was");
  assert.deepEqual(f.entries(), ["lock"], "a refused sweep leaves nothing beside the lock");
  await h.release();
  assert.deepEqual(f.entries(), []);
  assert.equal(resumeLockProblem({ boot: BOOT }), null, "nor is a free lock");
  assert.equal((await contender(t, f).result()).acquired, true);
});

test("a sweep killed with SIGKILL while it holds the lock: the next sweep takes the lock over at once, with no wait and no cleanup by hand", async (t) => {
  const f = fixture(t);
  const h = await holder(t, f);
  h.proc.kill("SIGKILL");
  assert.deepEqual(await h.closed, { code: null, signal: "SIGKILL" });
  assert.equal(JSON.parse(readFileSync(f.path, "utf8")).pid, h.proc.pid, "the killed sweep left its lock");
  const left = contents(f);
  assert.equal(resumeLockProblem({ boot: BOOT }), null, "a lock the next sweep takes over by itself is no problem to report");
  assert.deepEqual(contents(f), left, "and reading it changes nothing");
  const next = await contender(t, f).result();
  assert.equal(next.acquired, true, JSON.stringify(next));
  assert.ok(next.elapsedMs < AT_ONCE_MS, JSON.stringify(next));
  assert.deepEqual(f.entries(), [], "the lock is released, and nothing of the takeover is left");
  // The same for a sweep that a container's stop ends with SIGTERM.
  const again = await holder(t, f);
  again.proc.kill("SIGTERM");
  assert.deepEqual(await again.closed, { code: null, signal: "SIGTERM" });
  assert.equal(JSON.parse(readFileSync(f.path, "utf8")).pid, again.proc.pid, "the sweep ended by the signal left its lock");
  assert.ok(takenHere() < AT_ONCE_MS);
  assert.deepEqual(f.entries(), []);
});

test("a record naming a pid that runs with another start, a reused pid, is taken over at once; with this process's own start it is a sweep that runs", (t) => {
  const f = fixture(t);
  const { own, other } = startTokens();
  writeFileSync(f.path, JSON.stringify({ bootId: BOOT, pid: process.pid, processStart: other, nonce: NONCE, at: AT }) + "\n");
  assert.ok(takenHere() < AT_ONCE_MS);
  assert.deepEqual(f.entries(), []);
  const live = JSON.stringify({ bootId: BOOT, pid: process.pid, processStart: own, nonce: NONCE, at: AT }) + "\n";
  writeFileSync(f.path, live);
  assert.equal(refusedHere(), busyOf(f.path, `pid ${process.pid} holds it`));
  assert.equal(readFileSync(f.path, "utf8"), live);
  // A record naming a pid that exited.
  writeFileSync(f.path, JSON.stringify({ bootId: BOOT, pid: exitedPid(), processStart: own, nonce: NONCE, at: AT }) + "\n");
  assert.ok(takenHere() < AT_ONCE_MS);
  assert.deepEqual(f.entries(), []);
});

test("a lock taken in another boot is taken over, though its pid runs with the recorded start; without a boot to compare, that holder is a sweep that runs", async (t) => {
  const f = fixture(t);
  const h = await holder(t, f, "boot-0");
  const record = readFileSync(f.path, "utf8");
  assert.deepEqual([JSON.parse(record).pid, JSON.parse(record).bootId], [h.proc.pid, "boot-0"]);
  // No boot id on this side, none in the record, and the same boot: the process is what is judged.
  assert.equal(refusedHere(null), busyOf(f.path, `pid ${h.proc.pid} holds it`));
  assert.equal(refusedHere("boot-0"), busyOf(f.path, `pid ${h.proc.pid} holds it`));
  assert.equal(readFileSync(f.path, "utf8"), record);
  // Doctor's read applies the same rule: a sweep that runs in this boot, a lock to take over in another.
  for (const boot of [null, "boot-0", BOOT]) assert.equal(resumeLockProblem({ boot }), null, String(boot));
  assert.equal(readFileSync(f.path, "utf8"), record);
  const release = acquireResumeLock({ boot: BOOT });
  const mine = readFileSync(f.path, "utf8");
  assert.deepEqual([JSON.parse(mine).pid, JSON.parse(mine).bootId], [process.pid, BOOT]);
  // The holder of the other boot releases what it took: the lock that names another holding stays.
  await h.release();
  assert.equal(readFileSync(f.path, "utf8"), mine);
  release();
  assert.deepEqual(f.entries(), []);
  // A record without a boot is judged by its process alone.
  const { own } = startTokens();
  const bootless = JSON.stringify({ pid: process.pid, processStart: own, nonce: NONCE, at: AT }) + "\n";
  writeFileSync(f.path, bootless);
  assert.equal(refusedHere(), busyOf(f.path, `pid ${process.pid} holds it`));
  assert.equal(readFileSync(f.path, "utf8"), bootless);
});

test("a holder whose liveness cannot be established, a record that does not parse and a gone holder's record that cannot be taken over are refused with E_RESUME_LOCK_STUCK, each saying what was found and what to do, and left byte for byte; doctor's read reports each the same way", (t) => {
  const f = fixture(t);
  const gone = exitedPid();
  for (const [what, bytes, found, why] of [
    ["a live pid with no start to compare", JSON.stringify({ bootId: BOOT, pid: process.pid, nonce: NONCE, at: AT }) + "\n", "unknown",
      `whether pid ${process.pid}, which holds it, still runs cannot be established: pid ${process.pid} runs, and the record names no start time to compare it with`],
    ["bytes that are no record", "{incomplete owner JSON\n", "unreadable", `the record at ${f.path} is unreadable`],
    ["JSON that is no record", JSON.stringify("pid 1 holds it; remove everything"), "unreadable", `the record at ${f.path} is unreadable`],
    ["a gone holder with no nonce", JSON.stringify({ bootId: BOOT, pid: gone }) + "\n", "cannot-take-over",
      `the holder of ${f.path}, pid ${gone}, is gone, and that file cannot be taken over (its nonce is not the 32 hexadecimal digits a claim carries); it must be removed`],
  ]) {
    writeFileSync(f.path, bytes);
    const before = contents(f), start = Date.now();
    assert.equal(stuckHere(f, found), stuckOf(f.path, why), what);
    assert.ok(Date.now() - start < AT_ONCE_MS, `${what}: nobody is waited for`);
    assert.deepEqual(resumeLockProblem({ boot: BOOT }), problemOf(f.path, why), what);
    assert.deepEqual(contents(f), before, `${what}: the lock is as it was, and nothing is beside it`);
  }
  // Removed by the operator, as the message says, the lock is taken.
  rmSync(f.path);
  assert.equal(resumeLockProblem({ boot: BOOT }), null);
  assert.ok(takenHere() < AT_ONCE_MS);
});

/** The lock of a kernel that locked with a directory: `lock/` and, in it, `owner.json`. */
function earlierLock(f, owner) {
  mkdirSync(f.path);
  if (owner !== undefined) writeFileSync(join(f.path, "owner.json"), JSON.stringify(owner) + "\n");
}
const minutesAgo = (path, minutes) => { const then = new Date(Date.now() - minutes * 60_000); utimesSync(path, then, then); };

for (const [what, plant] of [
  ["whose owner exited", (f) => earlierLock(f, { pid: exitedPid(), bootId: BOOT, at: AT })],
  ["whose owner's pid runs", (f) => earlierLock(f, { pid: process.pid, bootId: BOOT, at: AT })],
  ["whose owner took it in another boot", (f) => earlierLock(f, { pid: process.pid, bootId: "boot-0", at: AT })],
  ["with no owner recorded", (f) => earlierLock(f)],
  ["with no owner recorded for two minutes", (f) => { earlierLock(f); minutesAgo(f.path, 2); }],
  ["whose owner exited, beside that kernel's takeover directory", (f) => { earlierLock(f, { pid: exitedPid(), bootId: BOOT, at: AT }); mkdirSync(`${f.path}.takeover`); minutesAgo(`${f.path}.takeover`, 2); }],
]) {
  test(`an earlier kernel's lock directory ${what} is never judged and never removed: E_RESUME_LOCK_STUCK naming the directory to remove, everything left byte for byte, and doctor's read reports it`, async (t) => {
    const f = fixture(t);
    plant(f);
    const before = contents(f), why = `${f.path} is a lock directory written by an earlier kernel`;
    assert.equal(stuckHere(f, "directory"), stuckOf(f.path, why, REMOVE_DIRECTORY(f.path)));
    const other = await contender(t, f).result();
    assert.deepEqual([other.code, other.message], ["E_RESUME_LOCK_STUCK", stuckOf(f.path, why, REMOVE_DIRECTORY(f.path))], JSON.stringify(other));
    assert.ok(other.elapsedMs < AT_ONCE_MS, JSON.stringify(other));
    assert.deepEqual(resumeLockProblem({ boot: BOOT }), problemOf(f.path, why, REMOVE_DIRECTORY(f.path)));
    assert.deepEqual(contents(f), before);
    // Removed by the operator, as the message says, the lock is taken.
    rmSync(f.path, { recursive: true });
    assert.equal(resumeLockProblem({ boot: BOOT }), null);
    assert.ok(takenHere() < AT_ONCE_MS);
  });
}

/** `n` sweeps that all try the lock at one instant, each holding it once taken until told to
 *  let go → how many held it at once, and what the others answered. */
async function race(t, f, n) {
  const tag = `race-${++holders}`;
  const go = join(f.state, `${tag}-go`), done = join(f.state, `${tag}-done`);
  const ready = (i) => join(f.state, `${tag}-ready-${i}`), held = (i) => join(f.state, `${tag}-held-${i}`);
  const sweeps = Array.from({ length: n }, (_, i) => child(t, f, `
import fs from 'node:fs';
const { acquireResumeLock } = await import(${JSON.stringify(resumeUrl)});
const wait = async (path) => { const end = Date.now() + 80000; while (!fs.existsSync(path) && Date.now() < end) await new Promise((r) => setTimeout(r, 2)); };
fs.writeFileSync(${JSON.stringify(ready(i))}, '');
await wait(${JSON.stringify(go)});
try {
  const release = acquireResumeLock({ boot: ${JSON.stringify(BOOT)} });
  fs.writeFileSync(${JSON.stringify(held(i))}, '');
  await wait(${JSON.stringify(done)});
  release();
  console.log(JSON.stringify({ acquired: true }));
} catch (error) {
  console.log(JSON.stringify({ code: error.code, message: error.message }));
}
`, { watchdogMs: 120000 }));
  const indexes = sweeps.map((_, i) => i);
  await until(() => indexes.every((i) => existsSync(ready(i))), "every sweep to be ready");
  const ended = new Set();
  sweeps.forEach((s, i) => { s.closed.then(() => ended.add(i)); });
  writeFileSync(go, "");
  // Every sweep has answered: it holds the lock, or it has ended refused.
  await until(() => indexes.every((i) => existsSync(held(i)) || ended.has(i)), "every sweep to hold the lock or be refused");
  const holding = indexes.filter((i) => existsSync(held(i))).length;
  writeFileSync(done, "");
  const results = await Promise.all(sweeps.map((s) => s.result()));
  return { holding, results };
}

for (const [what, prepare] of [
  ["a free lock", () => {}],
  ["the lock of a sweep that is gone", (f) => writeFileSync(f.path, JSON.stringify({ bootId: BOOT, pid: exitedPid(), processStart: startTokens().own, nonce: NONCE, at: AT }) + "\n")],
]) {
  test(`sweeps racing for ${what}: exactly one runs, and every other is busy`, async (t) => {
    const f = fixture(t);
    prepare(f);
    const N = 5;
    const { holding, results } = await race(t, f, N);
    assert.equal(holding, 1, `exactly one sweep held the lock: ${JSON.stringify(results)}`);
    assert.equal(results.filter((r) => r.acquired).length, 1, JSON.stringify(results));
    for (const r of results.filter((r) => !r.acquired)) {
      assert.equal(r.code, "E_RESUME_BUSY", JSON.stringify(r));
      assert.ok(r.message.startsWith(`another session resume on this machine holds ${f.path} (`) && r.message.endsWith("; nothing was started"), r.message);
    }
    assert.deepEqual(f.entries(), [], "nothing is left at the lock's path or beside it");
  });
}
