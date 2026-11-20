import { fixtureEnv } from "./fixture-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireCaptureLock, captureLockPath, shellQuote } from "../lib/capture-lock.mjs";
import { RecordStore } from "../lib/store.mjs";
import { captureCommandEntry } from "../lib/capture-command.mjs";
import { RecordIndex } from "../lib/index-db.mjs";

const CAPTURE = resolve(new URL("../bin/capture.mjs", import.meta.url).pathname);
const LOCK_LIB = resolve(new URL("../lib/capture-lock.mjs", import.meta.url).pathname);

test("capture lock: a lock it may not reclaim refuses (live, another host's dead owner, same pid, record-less); release removes only its own", () => {
  const made = mkdtempSync(join(tmpdir(), "capture-lock-"));
  const root = join(made, "o'dd $(echo x) `w` dir");
  try {
    const a = acquireCaptureLock(root);
    assert.ok(a.release);
    assert.equal(JSON.parse(readFileSync(join(captureLockPath(root), "owner.json"), "utf8")).pid, process.pid);
    const again = acquireCaptureLock(root);
    assert.equal(again.held?.pid, process.pid); assert.equal(again.held.liveness, "alive");
    a.release(); assert.equal(existsSync(captureLockPath(root)), false);
    // Live holder (a sleeping child): refused with "let it finish".
    const child = spawn("sleep", ["30"]);
    try {
      mkdirSync(captureLockPath(root)); writeFileSync(join(captureLockPath(root), "owner.json"), JSON.stringify({ pid: child.pid, startedAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString() }));
      const h = acquireCaptureLock(root);
      assert.equal(h.held?.pid, child.pid); assert.equal(h.held.liveness, "alive"); assert.match(h.held.recovery, /let it finish/);
    } finally { child.kill(); }
    // Another host's dead holder: refused, with the actionable recovery (its pid means nothing here).
    writeFileSync(join(captureLockPath(root), "owner.json"), JSON.stringify({ pid: 999999999, startedAt: new Date().toISOString(), host: "elsewhere" }));
    const d = acquireCaptureLock(root);
    assert.equal(d.release, undefined, "another host's lock is not reclaimed");
    assert.equal(d.held.liveness, "dead"); assert.match(d.held.recovery, /ps -p 999999999/);
    assert.ok(d.held.recovery.includes(`rm -r -- ${shellQuote(captureLockPath(root))}`), d.held.recovery);
    // The displayed removal is shell-safe for this hostile path: it removes exactly the lock and executes nothing.
    const cmd = d.held.recovery.slice(d.held.recovery.indexOf("rm -r -- "), d.held.recovery.indexOf("  and rerun"));
    const sh = spawnSync("sh", ["-c", cmd], { encoding: "utf8" });
    assert.equal(sh.status, 0, sh.stderr); assert.equal(existsSync(captureLockPath(root)), false, "the pasted command removed the lock");
    assert.equal(existsSync(root), true);
    mkdirSync(captureLockPath(root)); writeFileSync(join(captureLockPath(root), "owner.json"), JSON.stringify({ pid: 999999999, startedAt: new Date().toISOString(), host: "elsewhere" }));
    assert.equal(existsSync(captureLockPath(root)), true);
    // Record-less lock (initializing or killed before writing): refused, unknown liveness.
    rmSync(captureLockPath(root), { recursive: true, force: true }); mkdirSync(captureLockPath(root));
    const u = acquireCaptureLock(root); assert.equal(u.release, undefined); assert.equal(u.held.liveness, "unknown"); assert.match(u.held.recovery, /not written its owner record.*stop capture triggers.*pgrep -f capture\.mjs.*rm -r -- /);
    // release removes only a lock this pid owns.
    rmSync(captureLockPath(root), { recursive: true, force: true });
    const e = acquireCaptureLock(root);
    writeFileSync(join(captureLockPath(root), "owner.json"), JSON.stringify({ pid: 424242, startedAt: new Date().toISOString() }));
    e.release(); assert.equal(existsSync(captureLockPath(root)), true, "another holder's lock is left alone");
  } finally { rmSync(made, { recursive: true, force: true }); }
});

test("capture lock: concurrent child processes never hold the lock at the same time", () => {
  const root = mkdtempSync(join(tmpdir(), "capture-lock-conc-"));
  const script = `
    import { acquireCaptureLock } from ${JSON.stringify(LOCK_LIB)};
    import { appendFileSync } from "node:fs";
    const root = process.argv[2], log = process.argv[3];
    let got;
    for (let i = 0; i < 4000 && !got; i++) { const l = acquireCaptureLock(root); if (l.release) got = l; else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); }
    if (!got) { console.error("never acquired"); process.exit(2); }
    const start = Date.now(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); const end = Date.now();
    appendFileSync(log, JSON.stringify({ pid: process.pid, start, end }) + "\\n");
    got.release();
  `;
  const scriptPath = join(root, "contender.mjs"); writeFileSync(scriptPath, script);
  const log = join(root, "holds.log");
  const kids = Array.from({ length: 6 }, () => spawn(process.execPath, [scriptPath, root, log], { stdio: ["ignore", "ignore", "pipe"] }));
  return Promise.all(kids.map((k) => new Promise((res) => k.on("exit", (code) => res(code))))).then((codes) => {
    assert.deepEqual(codes, [0, 0, 0, 0, 0, 0]);
    const holds = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).sort((x, y) => x.start - y.start);
    assert.equal(holds.length, 6);
    for (let i = 1; i < holds.length; i++) assert.ok(holds[i].start >= holds[i - 1].end, `hold ${i} overlapped hold ${i - 1}`);
    assert.equal(existsSync(captureLockPath(root)), false);
  }).finally(() => rmSync(root, { recursive: true, force: true }));
});

test("capture CLI: a locked root (live holder) skips quietly; another host's interrupted owner's lock skips with the recovery on stderr; neither touches the index", () => {
  const root = mkdtempSync(join(tmpdir(), "capture-lock-cli-"));
  const child = spawn("sleep", ["30"]);
  try {
    const home = join(root, "home"); mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    const env = { ...fixtureEnv(), HOME: home, TURN_RECORD_ROOT: root, TURN_RECORD_OWNER: "tester" };
    mkdirSync(captureLockPath(root)); writeFileSync(join(captureLockPath(root), "owner.json"), JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }));
    let r = spawnSync(process.execPath, [CAPTURE, "--sessions-only"], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr + r.stdout); assert.match(r.stdout, /another pass holds .*let it finish/);
    // Another host's interrupted owner (dead pid there): the pass skips, and the operator gets the exact
    // recovery on stderr. (On this host the next pass reclaims it: capture-lock-reclaim.test.mjs.)
    writeFileSync(join(captureLockPath(root), "owner.json"), JSON.stringify({ pid: 999999999, startedAt: new Date().toISOString(), host: "elsewhere" }));
    r = spawnSync(process.execPath, [CAPTURE, "--sessions-only"], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stderr, /now dead.*ps -p 999999999.*rm -r -- '.*\.capture\.lock'.*rerun/);
    assert.equal(existsSync(join(root, "index")), false, "no index was created by a skipped pass");
    assert.equal(existsSync(captureLockPath(root)), true, "the lock was not removed by the tool");
    // Operator recovery, then a pass runs.
    rmSync(captureLockPath(root), { recursive: true, force: true });
    r = spawnSync(process.execPath, [CAPTURE, "--sessions-only"], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr + r.stdout); assert.doesNotMatch(r.stdout + r.stderr, /another pass holds/);
    assert.equal(existsSync(captureLockPath(root)), false, "a finished pass released its lock");
  } finally { child.kill(); rmSync(root, { recursive: true, force: true }); }
});

test("capture lock: an owner record that cannot be written removes only this call's initializing directory and rethrows; a failed removal is reported, never claimed", () => {
  const root = mkdtempSync(join(tmpdir(), "capture-lock-init-"));
  try {
    const enospc = () => { throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }); };
    // Injected write failure after the atomic mkdir: the caller never receives a lock, so nothing outside could release it.
    let err;
    try { acquireCaptureLock(root, { io: { writeFileSync: enospc } }); } catch (e) { err = e; }
    assert.equal(err?.code, "ENOSPC", "the original failure is rethrown");
    assert.deepEqual(err.lockCleanup, { path: captureLockPath(root), removed: true });
    assert.equal(existsSync(captureLockPath(root)), false, "the initializing lock did not outlive the failed acquisition");
    const next = acquireCaptureLock(root); assert.ok(next.release, "the next pass acquires normally"); assert.deepEqual(next.release(), { released: true });
    // Removal itself failing: reported with the recovery, and the directory is really still there.
    const ebusy = () => { throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" }); };
    err = undefined;
    try { acquireCaptureLock(root, { io: { writeFileSync: enospc, rmSync: ebusy } }); } catch (e) { err = e; }
    assert.equal(err?.code, "ENOSPC");
    assert.equal(err.lockCleanup.removed, false); assert.equal(err.lockCleanup.error, "EBUSY: resource busy");
    assert.match(err.lockCleanup.recovery, /not written its owner record.*rm -r -- /);
    assert.equal(existsSync(captureLockPath(root)), true, "removed:false is not claimed when the directory remains");
    const refused = acquireCaptureLock(root); assert.equal(refused.release, undefined); assert.equal(refused.held.liveness, "unknown");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("capture lock: release checks the acquisition nonce, so an earlier release cannot erase a later same-pid lock; a removal that did not happen is reported", () => {
  const root = mkdtempSync(join(tmpdir(), "capture-lock-nonce-"));
  try {
    const first = acquireCaptureLock(root);
    const owner1 = JSON.parse(readFileSync(join(captureLockPath(root), "owner.json"), "utf8"));
    assert.equal(owner1.pid, process.pid); assert.match(owner1.nonce, /^[0-9a-f]{16}$/);
    // Operator recovery of a pass believed dead, then a new pass in the same process.
    rmSync(captureLockPath(root), { recursive: true, force: true });
    const second = acquireCaptureLock(root); assert.ok(second.release);
    const owner2 = JSON.parse(readFileSync(join(captureLockPath(root), "owner.json"), "utf8"));
    assert.notEqual(owner2.nonce, owner1.nonce);
    const stale = first.release();
    assert.equal(stale.released, false); assert.equal(stale.reason, "not-owner"); assert.equal(stale.owner.nonce, owner2.nonce);
    assert.equal(existsSync(captureLockPath(root)), true, "the newer same-pid lock survives the stale release");
    // Removal failure at release: no throw from a finally, and no claim of success.
    const held = acquireCaptureLock(root); assert.equal(held.release, undefined, "the second lock is still held");
    const failing = { rmSync: () => { throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }); } };
    rmSync(captureLockPath(root), { recursive: true, force: true });
    const third = acquireCaptureLock(root, { io: failing });
    const r = third.release();
    assert.equal(r.released, false); assert.equal(r.reason, "remove-failed"); assert.equal(r.error, "EPERM: operation not permitted");
    assert.match(r.recovery, new RegExp(`held by pid ${process.pid} \\(this pass, alive .*ps -p ${process.pid}.*rm -r -- `), r.recovery);
    assert.equal(r.liveness, "alive"); assert.doesNotMatch(r.recovery, /dead/, "the holder is this live process; nothing asserts its death");
    assert.equal(existsSync(captureLockPath(root)), true);
    // The record vanishes from under a live lock (an operator recovery in progress): unknown, with the recovery, not "released".
    rmSync(join(captureLockPath(root), "owner.json"));
    const unknown = third.release();
    assert.equal(unknown.released, false); assert.equal(unknown.reason, "unknown-owner"); assert.match(unknown.recovery, /not written its owner record.*rm -r -- /);
    rmSync(captureLockPath(root), { recursive: true, force: true });
    assert.deepEqual(second.release(), { released: false, reason: "gone" }, "a lock already gone is reported as gone, not released by this holder");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("capture lock: the initialization directory descriptor closes on success and write failure", () => {
  const root = mkdtempSync(join(tmpdir(), "capture-lock-fd-"));
  let fd;
  const io = { openSync: (...args) => (fd = openSync(...args)) };
  try {
    const lock = acquireCaptureLock(root, { io });
    assert.throws(() => fstatSync(fd), { code: "EBADF" });
    assert.deepEqual(lock.release(), { released: true });
    assert.throws(() => acquireCaptureLock(root, { io: { ...io, writeFileSync: () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); } } }), { code: "EIO" });
    assert.throws(() => fstatSync(fd), { code: "EBADF" });
    assert.equal(existsSync(captureLockPath(root)), false);
    // No descriptor means ownership was never pinned: leave the directory,
    // report that uncertainty and retain the operator's recovery guidance.
    let error;
    try { acquireCaptureLock(root, { io: { openSync: () => { throw Object.assign(new Error("EMFILE"), { code: "EMFILE" }); } } }); } catch (e) { error = e; }
    assert.equal(error?.code, "EMFILE");
    assert.equal(error.lockCleanup.removed, false);
    assert.equal(error.lockCleanup.reason, "unverified");
    assert.match(error.lockCleanup.recovery, /stop capture triggers.*pgrep -f capture\.mjs.*rm -r -- /);
    assert.equal(existsSync(captureLockPath(root)), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("capture lock: a failed initialization never removes a replacement that appeared meanwhile (BeadHub's interleaving); a directory that is no longer ours is reported, not deleted", () => {
  const root = mkdtempSync(join(tmpdir(), "capture-lock-replace-"));
  try {
    const dir = captureLockPath(root);
    let replacement;
    // Between this call's mkdir and its owner write: an operator removes the
    // directory and a newer pass (same pid, new nonce) takes the lock; then
    // this call's write fails with the original error.
    const interleave = () => {
      rmSync(dir, { recursive: true, force: true });
      replacement = acquireCaptureLock(root); assert.ok(replacement.release, "the newer pass acquired");
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    };
    let err;
    try { acquireCaptureLock(root, { io: { writeFileSync: interleave } }); } catch (e) { err = e; }
    assert.equal(err?.code, "ENOSPC", "the original failure is rethrown");
    assert.equal(err.lockCleanup.removed, false); assert.equal(err.lockCleanup.reason, "replaced");
    assert.equal(err.lockCleanup.owner.nonce, JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")).nonce, "the replacement's record is what was reported");
    assert.equal(existsSync(dir), true, "the replacement survives the failed initialization's cleanup");
    assert.deepEqual(replacement.release(), { released: true }, "and its own holder still releases it");
    // The directory swapped for another with no readable record: identity changed, no owner observed, left alone.
    err = undefined;
    try { acquireCaptureLock(root, { io: { writeFileSync: () => { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir); throw Object.assign(new Error("EIO"), { code: "EIO" }); } } }); } catch (e) { err = e; }
    assert.equal(err?.code, "EIO"); assert.deepEqual(err.lockCleanup, { path: dir, removed: false, reason: "replaced" }, "replaced without an owner: nothing claims a newer pass");
    assert.equal(existsSync(dir), true, "the changed directory is left alone");
    rmSync(dir, { recursive: true, force: true });
    // The directory removed (and not replaced) before the failed write: gone, nothing removed, no recovery needed.
    err = undefined;
    try { acquireCaptureLock(root, { io: { writeFileSync: () => { rmSync(dir, { recursive: true, force: true }); throw Object.assign(new Error("EIO"), { code: "EIO" }); } } }); } catch (e) { err = e; }
    assert.equal(err?.code, "EIO"); assert.deepEqual(err.lockCleanup, { path: dir, removed: false, reason: "gone" });
    assert.equal(existsSync(dir), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("capture CLI: an unreadable ignore file stops the pass with one line and exit 1, and leaves no lock behind", () => {
  const root = mkdtempSync(join(tmpdir(), "capture-lock-ignore-"));
  try {
    const home = join(root, "home"); mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    mkdirSync(join(root, "ignore")); // a directory where the ignore FILE is expected: EISDIR, fail closed
    const env = { ...fixtureEnv(), HOME: home, TURN_RECORD_ROOT: root, TURN_RECORD_OWNER: "tester" };
    const r = spawnSync(process.execPath, [CAPTURE, "--sessions-only", "--no-index"], { encoding: "utf8", env });
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /ignore/); assert.doesNotMatch(r.stderr, /\n\s+at /, "one line, not a stack trace");
    assert.equal(existsSync(captureLockPath(root)), false, "the refused pass left no lock for the next pass to trip over");
    const again = spawnSync(process.execPath, [CAPTURE, "--sessions-only", "--no-index"], { encoding: "utf8", env });
    assert.doesNotMatch(again.stderr, /another pass holds/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("capture --install-hint recommends append-only hook passes", () => {
  const r = spawnSync(process.execPath, [CAPTURE, "--install-hint"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /capture-hook\.mjs --sessions-only --no-index --quiet"/);
  const hint = JSON.parse(r.stdout.slice(r.stdout.indexOf("{\n"), r.stdout.lastIndexOf("\n}") + 2));
  for (const event of ["Stop", "SessionEnd"]) {
    const hook = hint.hooks[event][0].hooks[0];
    assert.equal(hook.async, false); assert.equal(hook.timeout, 10);
    assert.match(hook.command, /\/capture-hook\.mjs --sessions-only --no-index --quiet$/);
  }
  assert.match(r.stdout, /capture launched, not capture completed/);
  assert.match(r.stdout, /One pass runs per record root at a time/);
});

test("an append-only hook pass (--no-index) is indexed by the next plain pass even though that pass appends nothing", () => {
  const base = mkdtempSync(join(tmpdir(), "capture-append-only-"));
  try {
    const root = join(base, "record"), home = join(base, "home");
    const project = join(home, ".claude", "projects", "-tmp-proj"); mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "s1.jsonl"), JSON.stringify({ type: "user", timestamp: "2026-08-25T10:00:00.000Z", message: { content: [{ type: "text", text: "the rare word zebrafish" }] }, sessionId: "s1" }) + "\n");
    const env = { ...fixtureEnv(), HOME: home, TURN_RECORD_ROOT: root, TURN_RECORD_OWNER: "tester" };
    let r = spawnSync(process.execPath, [CAPTURE, "--sessions-only", "--no-index", "--quiet"], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const searchable = () => { const i = new RecordIndex(new RecordStore(root, { owner: "tester" })); try { return i.search("zebrafish").length; } finally { i.close(); } };
    assert.equal(searchable(), 0, "the append-only pass indexed nothing");
    r = spawnSync(process.execPath, [CAPTURE, "--sessions-only"], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /0 new turns/); assert.match(r.stdout, /index: updated/);
    assert.equal(searchable(), 1, "the earlier appended turn is searchable after the plain pass");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("capture --home lock collision returns one JSON document with stale boundaries explicitly incomplete; background skips stay nonfatal", (t) => {
  const base = mkdtempSync(join(tmpdir(), "capture-home-lock-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "record"), user = join(base, "user"), home = join(base, "instance");
  const project = join(user, ".claude", "projects", "-instance");
  mkdirSync(project, { recursive: true }); mkdirSync(home);
  const file = join(project, "s1.jsonl");
  const line = (text) => JSON.stringify({ type: "user", cwd: home, sessionId: "s1", timestamp: "2026-09-13T10:00:00Z", message: { content: text } }) + "\n";
  writeFileSync(file, line("first"));
  const env = { ...fixtureEnv(), HOME: user, TURN_RECORD_ROOT: root, TURN_RECORD_OWNER: "tester" };
  const run = (...args) => spawnSync(process.execPath, [CAPTURE, "--no-index", ...args], { env, encoding: "utf8" });
  const first = run("--current-roots", "--home", home); assert.equal(first.status, 0, first.stderr);
  const boundary = JSON.parse(first.stdout).sessions[0].lastTurnId;
  writeFileSync(file, line("first") + line("second"));
  const lock = acquireCaptureLock(root); assert.ok(lock.release);
  try {
    for (const extra of [[], ["--quiet"]]) {
      const r = run("--current-roots", "--home", home, ...extra); assert.equal(r.status, 0, r.stderr + r.stdout);
      const out = JSON.parse(r.stdout);
      assert.equal(out.status, "skipped"); assert.equal(out.complete, false); assert.equal(out.skipped, true);
      assert.equal(out.held, 0, "a lock skip is distinct from unstamped held sessions");
      assert.equal(out.failed, 0); assert.equal(out.appended, 0);
      assert.equal(out.lock.pid, process.pid); assert.equal(out.lock.liveness, "alive");
      assert.equal(out.sessions[0].lastTurnId, boundary, "old boundaries are visible but not a performed capture receipt");
      assert.equal(out.sessions[0].turns, 1);
    }
    const background = run("--sessions-only", "--quiet");
    assert.equal(background.status, 0, background.stderr); assert.equal(background.stdout, "");
  } finally { assert.deepEqual(lock.release(), { released: true }); }
  const complete = run("--current-roots", "--home", home); assert.equal(complete.status, 0, complete.stderr);
  const out = JSON.parse(complete.stdout);
  assert.equal(out.complete, true); assert.equal(out.skipped, false); assert.equal(out.appended, 1);
  assert.equal(out.sessions[0].turns, 2); assert.notEqual(out.sessions[0].lastTurnId, boundary);
  // A dead owner the pass may not reclaim (another host's) is also native JSON, with actionable diagnostics.
  mkdirSync(captureLockPath(root));
  writeFileSync(join(captureLockPath(root), "owner.json"), JSON.stringify({ pid: 999999999, startedAt: "2026-09-13T10:00:00Z", host: "elsewhere" }));
  const stale = run("--current-roots", "--home", home, "--quiet"); assert.equal(stale.status, 0);
  assert.equal(JSON.parse(stale.stdout).complete, false); assert.match(stale.stderr, /now dead.*rm -r/);
});

test("capture --home reports lock release failure as failed JSON and nonzero even when capture appended", (t) => {
  const base = mkdtempSync(join(tmpdir(), "capture-home-release-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "record"), home = join(base, "home"); mkdirSync(home);
  const project = join(home, ".claude", "projects", "-home"); mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "s1.jsonl"), JSON.stringify({ cwd: home, sessionId: "s1", timestamp: "2026-09-13T10:00:00Z", type: "user", message: { content: "captured before release failure" } }) + "\n");
  const preload = join(base, "release-failure.mjs");
  writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const rm = fs.rmSync;
fs.rmSync = (path, ...args) => {
  if (String(path) === ${JSON.stringify(captureLockPath(root))}) throw new Error('simulated lock removal failure');
  return rm(path, ...args);
};
syncBuiltinESMExports();`);
  const r = spawnSync(process.execPath, ["--import", preload, CAPTURE, "--current-roots", "--home", home, "--no-index"], {
    env: { ...fixtureEnv(), HOME: home, TURN_RECORD_ROOT: root, TURN_RECORD_OWNER: "tester" }, encoding: "utf8",
  });
  assert.equal(r.status, 1, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, "failed"); assert.equal(out.complete, false); assert.equal(out.failed, 1);
  assert.equal(out.skipped, false); assert.equal(out.appended, 1); assert.equal(out.sessions[0].turns, 1);
  assert.match(out.error, /release failed/); assert.match(r.stderr, /did not release/);
  assert.equal(existsSync(captureLockPath(root)), true, "failed cleanup is never claimed as released");
});

test("capture lock: a removal error is still a failure when the lock was removed before throwing", (t) => {
  const root = mkdtempSync(join(tmpdir(), "capture-lock-partial-remove-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lock = acquireCaptureLock(root, { io: { rmSync: (path, options) => {
    rmSync(path, options);
    throw Object.assign(new Error("simulated I/O failure after removal"), { code: "EIO" });
  } } });
  const outcome = lock.release();
  assert.equal(outcome.released, false); assert.equal(outcome.reason, "remove-failed");
  assert.match(outcome.error, /I\/O failure/); assert.match(outcome.recovery, /now absent/);
  assert.equal(existsSync(captureLockPath(root)), false);
});

test("capture lock: failure to verify removal cannot be reported as released", (t) => {
  const root = mkdtempSync(join(tmpdir(), "capture-lock-verify-remove-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let removed = false;
  const lock = acquireCaptureLock(root, { io: { rmSync: (path, options) => {
    rmSync(path, options); removed = true;
  }, lstatSync: (...args) => {
    if (removed) throw Object.assign(new Error("simulated removal verification failure"), { code: "EACCES" });
    return lstatSync(...args);
  } } });
  const outcome = lock.release();
  assert.equal(removed, true, "failure is injected after actual removal");
  assert.equal(outcome.released, false); assert.equal(outcome.reason, "remove-failed");
  assert.match(outcome.error, /verification failure/); assert.match(outcome.recovery, /could not verify/);
});

test("capture lock: a fresh owner record carries bounded command and caller attribution, kept by worker registration and stop requests", () => {
  const root = mkdtempSync(join(tmpdir(), "capture-lock-attribution-"));
  try {
    assert.throws(() => acquireCaptureLock(root, { command: "home", caller: { entry: "oats", trigger: "cron" } }), /invalid capture lock attribution/);
    assert.throws(() => acquireCaptureLock(root, { command: "rm -rf", caller: { entry: "oats", trigger: "manual" } }), /invalid capture lock attribution/);
    assert.throws(() => acquireCaptureLock(root, { command: "home", caller: { entry: "oats", trigger: "manual", argv: "x" } }), /invalid capture lock attribution/);
    assert.equal(existsSync(captureLockPath(root)), false, "invalid attribution takes no lock");
    const lock = acquireCaptureLock(root, { command: "pass", caller: { entry: "turn-record", trigger: "service" } });
    const path = join(captureLockPath(root), "owner.json"), read = () => JSON.parse(readFileSync(path, "utf8"));
    const fresh = read();
    assert.deepEqual(Object.keys(fresh).sort(), ["bootId", "caller", "command", "host", "nonce", "pid", "ppid", "processStart", "startedAt"]);
    assert.equal(fresh.command, "pass"); assert.deepEqual(fresh.caller, { entry: "turn-record", trigger: "service" });
    assert.equal(fresh.ppid, process.ppid);
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
    lock.registerWorker({ pid: dead, nonce: "w", startedAt: new Date().toISOString() });
    lock.requestStop(); lock.requestStop();
    const stopped = read();
    assert.deepEqual({ ...stopped, worker: undefined, stop: undefined }, { ...fresh, worker: undefined, stop: undefined });
    assert.equal(stopped.stop, true); assert.equal(stopped.worker.pid, dead);
    assert.ok(readFileSync(path).length < 4096);
    assert.deepEqual(lock.release(), { released: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("capture lock: records without attribution, and stop requests, change nothing about liveness or reclaim", () => {
  const root = mkdtempSync(join(tmpdir(), "capture-lock-legacy-"));
  try {
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid, startedAt = "2026-01-01T00:00:00.000Z";
    for (const record of [{ pid: dead, nonce: "legacy", startedAt }, { pid: dead, nonce: "new", startedAt, command: "home", caller: { entry: "oats", trigger: "manual" }, ppid: 1, stop: true }]) {
      mkdirSync(captureLockPath(root), { recursive: true });
      writeFileSync(join(captureLockPath(root), "owner.json"), JSON.stringify({ ...record, host: hostname() }));
      const lock = acquireCaptureLock(root);
      assert.deepEqual(lock.reclaimed, { pid: dead, startedAt }, JSON.stringify(record)); assert.ok(lock.release);
      assert.deepEqual(lock.release(), { released: true });
    }
    for (const record of [{ pid: process.pid, nonce: "live" }, { pid: dead, nonce: "live-worker", worker: { pid: process.pid, nonce: "w", startedAt, host: hostname() } }]) {
      mkdirSync(captureLockPath(root), { recursive: true });
      writeFileSync(join(captureLockPath(root), "owner.json"), JSON.stringify({ ...record, startedAt, host: hostname(), command: "pass", caller: { entry: "oats", trigger: "hook" }, stop: true }));
      const held = acquireCaptureLock(root, { pid: 1 });
      assert.ok(held.held, JSON.stringify(record)); assert.equal(held.reclaimed, undefined);
      rmSync(captureLockPath(root), { recursive: true, force: true });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("capture lock: the caller entry is a fixed label only for known entry files, and is left out otherwise", () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-lock-entry-"));
  try {
    const record = resolve(new URL("../bin", import.meta.url).pathname);
    assert.equal(captureCommandEntry(resolve(record, "../../../bin/oats.mjs")), "oats");
    for (const name of ["turn-record.mjs", "capture.mjs", "setup.mjs"]) assert.equal(captureCommandEntry(join(record, name)), "turn-record", name);
    // An npm bin is a symlink named after the command; its target decides.
    symlinkSync(join(record, "turn-record.mjs"), join(dir, "turn-record"));
    assert.equal(captureCommandEntry(join(dir, "turn-record")), "turn-record");
    for (const other of [join(dir, "runner.mjs"), join(dir, "desktop-host.js"), "", join(dir, "oats")]) assert.equal(captureCommandEntry(other), undefined, other);
    const lock = acquireCaptureLock(dir, { command: "home", caller: { entry: captureCommandEntry(join(dir, "embedder.mjs")), trigger: "manual" } });
    const owner = JSON.parse(readFileSync(join(captureLockPath(dir), "owner.json"), "utf8"));
    assert.equal(owner.command, "home"); assert.deepEqual(owner.caller, { trigger: "manual" });
    assert.deepEqual(lock.release(), { released: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
