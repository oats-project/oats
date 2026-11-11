import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { superviseCapturePass } from "../lib/capture-pass.mjs";
import { acquireCaptureLock, captureLockPath, readCaptureLockOwner } from "../lib/capture-lock.mjs";
import { holderLiveness } from "../lib/lock-holder.mjs";
import { CAPTURE_POLICY } from "../lib/capture-budget.mjs";
import { captureCommandPass } from "../lib/capture-command-output.mjs";
const workerUrl = new URL("../lib/capture-worker.mjs", import.meta.url).href;
const lockUrl = new URL("../lib/capture-lock.mjs", import.meta.url).href;
const scratchUrl = new URL("../lib/capture-scratch.mjs", import.meta.url).href;
function fixture(t, body) {
  const root = fs.mkdtempSync(join(tmpdir(), "capture-pass-")), workerPath = join(root, "worker.mjs");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(workerPath, `import fs from 'node:fs';import {join} from 'node:path';
    import {runCaptureWorker} from ${JSON.stringify(workerUrl)};
    import {readCaptureLockOwner} from ${JSON.stringify(lockUrl)};
    ${body}`);
  return { root, workerPath };
}
const allowances = { workMs: 1000, finalizeMs: 1500, hardMs: 2000, finalReserveMs: 1000, finalDrainMs: 750, maxStarts: 8 };
const seams = { policy: { ...CAPTURE_POLICY, deadlineSeconds: 30 }, allowances, drainSeconds: 0.1 };

// These exercise the process/lock boundary. The fixture callback stands in for
// the future scheduler; it does not prove native recovery or status integration.
test("eight-start ceiling includes finalization, all children share the original deadline and retained root lock", async t => {
  const f = fixture(t, `await runCaptureWorker(({root,pass,drainAt,finalizeAt,hardAt})=>{
    fs.appendFileSync(join(root,'attempts'),JSON.stringify({pass,drainAt,finalizeAt,hardAt,pid:process.pid,owner:readCaptureLockOwner(root)})+'\\n');
    return {outcome:'partial',reason:'deadline',continuation:!pass.finalize};
  });`);
  const result = await superviseCapturePass(f.root, {}, { ...seams, workerPath: f.workerPath });
  assert.equal(result.outcome, "partial"); assert.equal(result.exitCode, 0); assert.equal(result.starts, 8);
  const rows = fs.readFileSync(join(f.root, "attempts"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 8); assert.deepEqual(rows.map(row => row.pass.attempt), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(rows.map(row => row.pass.finalize), [false, false, false, false, false, false, false, true]);
  assert.equal(new Set(rows.map(row => row.pass.deadline)).size, 1);
  assert.equal(new Set(rows.map(row => row.pass.started)).size, 1);
  assert.equal(new Set(rows.map(row => row.pass.runId)).size, 1);
  assert.equal(new Set(rows.map(row => row.owner.nonce)).size, 1);
  for (const row of rows) {
    assert.equal(row.owner.worker.pid, row.pid); assert.equal(holderLiveness({ pid: row.pid }), "dead");
    assert.ok(row.drainAt <= row.finalizeAt && row.finalizeAt <= row.hardAt && row.hardAt <= row.pass.deadline);
  }
  for (const row of rows.slice(0, 7)) assert.equal(row.hardAt - row.drainAt, 1000);
  assert.equal(fs.existsSync(captureLockPath(f.root)), false);
  assert.equal(fs.existsSync(join(f.root, "capture-status.json")), false, "parent must not invent run facts");
});

test("an unresponsive first child is reaped and independent work progresses in the same pass", async t => {
  const f = fixture(t, `await runCaptureWorker(({root,pass,budget})=>{
    fs.appendFileSync(join(root,'pids'),String(process.pid)+'\\n');
    if(pass.attempt===1)while(true){}
    budget.check();
    if(pass.attempt===2){
      fs.writeFileSync(join(root,'independent-progress'),JSON.stringify(pass.previous));
      return {outcome:'partial',reason:'deadline',continuation:true};
    }
    fs.writeFileSync(join(root,'earlier-failure'),String(pass.failure));
    return {outcome:'complete',reason:null};
  });`);
  const small = { ...allowances, workMs: 200, finalizeMs: 300, hardMs: 400 };
  const result = await superviseCapturePass(f.root, {}, { ...seams, allowances: small, workerPath: f.workerPath });
  assert.deepEqual(result, { outcome: "failed", reason: "deadline", exitCode: 1, starts: 3 });
  assert.deepEqual(JSON.parse(fs.readFileSync(join(f.root, "independent-progress"))), { outcome: "failed", reason: "deadline" });
  assert.equal(fs.readFileSync(join(f.root, "earlier-failure"), "utf8"), "deadline", "a healthy intermediate child cannot erase earlier failure evidence");
  for (const pid of fs.readFileSync(join(f.root, "pids"), "utf8").trim().split("\n").map(Number)) assert.equal(holderLiveness({ pid }), "dead");
  assert.equal(fs.existsSync(captureLockPath(f.root)), false);
});

test("insufficient remaining time admits only finalization, never a shortened normal/reset allowance", async t => {
  const f = fixture(t, `await runCaptureWorker(({root,pass})=>{
    fs.writeFileSync(join(root,'observed'),JSON.stringify(pass));return {outcome:'partial',reason:'deadline'};
  });`);
  const result = await superviseCapturePass(f.root, {}, { ...seams, policy: { ...CAPTURE_POLICY, deadlineSeconds: 1 }, workerPath: f.workerPath });
  assert.equal(result.starts, 1); assert.equal(result.outcome, "partial");
  assert.equal(JSON.parse(fs.readFileSync(join(f.root, "observed"))).finalize, true);
});

test("reset requests hand off a full normal allowance to a fresh worker and never to finalization", async t => {
  const f = fixture(t, `await runCaptureWorker(({root,pass,drainAt,hardAt})=>{
    fs.appendFileSync(join(root,'reset-attempts'),JSON.stringify({pass,pid:process.pid,drainAt,hardAt})+'\\n');
    if(pass.finalize)return {outcome:'partial',reason:'deadline',continuation:false};
    return {outcome:'partial',reason:'deadline',continuation:true,resetRequired:true};
  });`);
  const result = await superviseCapturePass(f.root, {}, { ...seams, allowances: { ...allowances, maxStarts: 3 }, workerPath: f.workerPath });
  assert.equal(result.starts, 3); assert.equal(result.outcome, 'partial');
  const rows = fs.readFileSync(join(f.root, 'reset-attempts'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.pass.reset), [false, true, false]);
  assert.deepEqual(rows.map(row => row.pass.finalize), [false, false, true]);
  assert.notEqual(rows[0].pid, rows[1].pid);
  assert.equal(rows[1].hardAt - rows[1].drainAt, allowances.hardMs - allowances.workMs);
  assert.equal(new Set(rows.map(row => row.pass.deadline)).size, 1);
});

test("continued startup and failed finalization cannot renew the absolute deadline or fabricate success", async t => {
  const f = fixture(t, `await new Promise(resolve=>setTimeout(resolve,150));
    await runCaptureWorker(({root,pass})=>{
      fs.appendFileSync(join(root,'attempts'),JSON.stringify(pass)+'\\n');while(true){}
    });`);
  const started = performance.now();
  const result = await superviseCapturePass(f.root, {}, { workerPath: f.workerPath, policy: { ...CAPTURE_POLICY, deadlineSeconds: 1.5 }, drainSeconds: 0.1,
    allowances: { workMs: 200, finalizeMs: 300, hardMs: 400, finalReserveMs: 300, finalDrainMs: 200, maxStarts: 8 } });
  assert.equal(result.outcome, "failed"); assert.ok(result.starts <= 4);
  assert.ok(performance.now() - started < 2500, "supporting elapsed bound; child windows also assert the shared absolute deadline");
  const rows = fs.readFileSync(join(f.root, "attempts"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(new Set(rows.map(row => row.deadline)).size, 1);
  assert.equal(fs.existsSync(join(f.root, "capture-status.json")), false);
  assert.equal(fs.existsSync(captureLockPath(f.root)), false);
});

test("overlap starts no worker and never releases another owner; spawn failures consume the start budget", async t => {
  const f = fixture(t, ""), lock = acquireCaptureLock(f.root); let starts = 0;
  try {
    const result = await superviseCapturePass(f.root, {}, { workerPath: f.workerPath, spawnChild: () => { starts++; throw Error("unexpected"); } });
    assert.equal(result.outcome, "overlap"); assert.equal(result.starts, 0); assert.equal(starts, 0);
    assert.equal(readCaptureLockOwner(f.root).nonce, lock.nonce);
  } finally { assert.equal(lock.release().released, true); }
  const result = await superviseCapturePass(f.root, {}, { ...seams, workerPath: f.workerPath, spawnChild: () => { starts++; throw Error("spawn failed"); } });
  assert.equal(result.outcome, "failed"); assert.equal(result.starts, 8); assert.equal(starts, 8);
  assert.equal(fs.existsSync(captureLockPath(f.root)), false);
});

test("TERM asks the started worker to stop through its owner record; it stops at its next check, no continuation starts, the lock is released", async t => {
  const f = fixture(t, `await runCaptureWorker(({root,budget})=>{
    fs.appendFileSync(join(root,'pids'),String(process.pid)+'\\n');
    process.kill(process.ppid,'SIGTERM');
    const nap=()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
    try{for(;;){budget.check();nap();}}
    catch(error){fs.writeFileSync(join(root,'stopped'),JSON.stringify({reason:error.reason,stop:readCaptureLockOwner(root).stop}));throw error;}
  });`);
  const result = await superviseCapturePass(f.root, {}, { ...seams, workerPath: f.workerPath, graceMs: 20000 });
  assert.deepEqual(result, { outcome: "failed", reason: "interrupted", exitCode: 1, starts: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(join(f.root, "stopped"), "utf8")), { reason: "interrupted", stop: true });
  const pids = fs.readFileSync(join(f.root, "pids"), "utf8").trim().split("\n");
  assert.equal(pids.length, 1); assert.equal(holderLiveness({ pid: Number(pids[0]) }), "dead");
  assert.equal(fs.existsSync(captureLockPath(f.root)), false);
});

test("a worker that cannot cooperate is killed and reaped after the grace; a second signal neither bypasses cleanup nor restarts the grace", async t => {
  const f = fixture(t, `await runCaptureWorker(({root})=>{
    fs.writeFileSync(join(root,'pid'),String(process.pid));
    process.kill(process.ppid,'SIGTERM');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300);
    process.kill(process.ppid,'SIGINT');
    while(true){}
  });`);
  const started = Date.now();
  const result = await superviseCapturePass(f.root, {}, { ...seams, workerPath: f.workerPath, graceMs: 500 });
  assert.deepEqual(result, { outcome: "failed", reason: "interrupted", exitCode: 1, starts: 1 });
  assert.ok(Date.now() - started < 10000, "bounded by the first signal's grace, well inside the deadline");
  assert.equal(holderLiveness({ pid: Number(fs.readFileSync(join(f.root, "pid"))) }), "dead");
  assert.equal(fs.existsSync(captureLockPath(f.root)), false);
});

test("TERM before the child is started kills it at once; no operation runs", async t => {
  // process.kill does not order the parent's dispatch of the signal before its
  // read of the child's readiness: the child announces readiness only once the
  // parent has observed the signal, witnessed by a file this test's own TERM
  // listener writes. Every listener runs in that one emit, so the supervisor
  // has handled the signal before it can read the readiness that follows. The
  // supervisor's deadline bounds the wait; a child whose parent died exits.
  const f = fixture(t, `fs.writeFileSync(join(process.argv[1],'..','pid'),String(process.pid));
    const parent=process.ppid;
    process.kill(parent,'SIGTERM');
    const observed=join(process.argv[1],'..','observed');
    while(!fs.existsSync(observed)&&process.ppid===parent)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
    if(process.ppid!==parent)process.exit(1);
    await runCaptureWorker(({root})=>{fs.writeFileSync(join(root,'ran'),'');return {outcome:'complete',reason:null};});`);
  const observe = () => fs.writeFileSync(join(f.root, "observed"), "");
  process.once("SIGTERM", observe);
  t.after(() => process.off("SIGTERM", observe));
  const result = await superviseCapturePass(f.root, {}, { ...seams, workerPath: f.workerPath, graceMs: 20000 });
  assert.deepEqual(result, { outcome: "failed", reason: "interrupted", exitCode: 1, starts: 1 });
  assert.equal(fs.existsSync(join(f.root, "ran")), false);
  assert.equal(holderLiveness({ pid: Number(fs.readFileSync(join(f.root, "pid"))) }), "dead");
  assert.equal(fs.existsSync(captureLockPath(f.root)), false);
});

test("TERM after the worker sent its result still bounds the child's lifetime by the grace", async t => {
  const f = fixture(t, `await runCaptureWorker(({root})=>{fs.writeFileSync(join(root,'pid'),String(process.pid));return {outcome:'complete',reason:null};});
    process.kill(process.ppid,'SIGTERM');
    while(true){}`);
  const result = await superviseCapturePass(f.root, {}, { ...seams, workerPath: f.workerPath, graceMs: 500 });
  assert.deepEqual(result, { outcome: "failed", reason: "interrupted", exitCode: 1, starts: 1 });
  assert.equal(holderLiveness({ pid: Number(fs.readFileSync(join(f.root, "pid"))) }), "dead");
  assert.equal(fs.existsSync(captureLockPath(f.root)), false);
});

test("production policy and drain offset are the fixed published values", async t => {
  assert.deepEqual(CAPTURE_POLICY, { intervalSeconds: 900, heapMiB: 256, rssBytes: 2147483648, deadlineSeconds: 300, maxRecordBytes: 8388608 });
  const f = fixture(t, `await runCaptureWorker(({root,pass})=>{
    fs.writeFileSync(join(root,'observed'),JSON.stringify(pass));return {outcome:'complete',reason:null};
  });`);
  const result = await superviseCapturePass(f.root, {}, { workerPath: f.workerPath });
  assert.equal(result.outcome, "complete"); assert.equal(result.starts, 1);
  const pass = JSON.parse(fs.readFileSync(join(f.root, "observed")));
  assert.equal(pass.deadline - pass.started, 300000); assert.equal(pass.drainAt - pass.started, 295000);
});

test("scratch left by a killed worker is reclaimed by the next ordinary pass before its first child", async t => {
  const f = fixture(t, `import {createCaptureScratch} from ${JSON.stringify(scratchUrl)};
    await runCaptureWorker(({root,pass})=>{
      const tmp=join(root,'.capture-tmp'),seen=fs.existsSync(tmp)?fs.readdirSync(tmp).filter(name=>name.startsWith('snapshot-')):[];
      fs.appendFileSync(join(root,'seen'),JSON.stringify({attempt:pass.attempt,seen})+'\\n');
      if(!fs.existsSync(join(root,'killed'))){fs.writeFileSync(join(root,'killed'),'');createCaptureScratch(root,'snapshot');process.kill(process.pid,'SIGKILL');}
      return {outcome:'complete',reason:null};
    });`);
  const seen = () => fs.readFileSync(join(f.root, "seen"), "utf8").trim().split("\n").map(JSON.parse);
  const killed = await superviseCapturePass(f.root, {}, { ...seams, workerPath: f.workerPath });
  assert.equal(killed.outcome, "failed"); assert.equal(killed.starts, 2);
  const leftover = fs.readdirSync(join(f.root, ".capture-tmp"));
  assert.equal(leftover.length, 1); assert.match(leftover[0], /^snapshot-/);
  assert.deepEqual(seen().map(row => row.seen), [[], leftover], "no scavenging while the pass may have a live child");
  const next = await superviseCapturePass(f.root, {}, { ...seams, workerPath: f.workerPath });
  assert.equal(next.outcome, "complete"); assert.equal(next.starts, 1);
  assert.deepEqual(seen().at(-1), { attempt: 1, seen: [] });
  assert.deepEqual(fs.readdirSync(join(f.root, ".capture-tmp")), []);
  assert.equal(fs.existsSync(join(f.root, "capture-status.json")), false, "the supervisor still writes no status");
  assert.equal(fs.existsSync(captureLockPath(f.root)), false);
});

test("a worker's operational failure carries one bounded private line to the command output", async t => {
  const f = fixture(t, `await runCaptureWorker(({pass})=>{
    if(pass.attempt===1)throw new Error('refusing invalid capture status publication\\n\\u001b[2Jspoof'+'x'.repeat(1000));
    return {outcome:'complete',reason:null};
  });`);
  const result = await superviseCapturePass(f.root, {}, { ...seams, workerPath: f.workerPath });
  const message = ("refusing invalid capture status publication [2Jspoof" + "x".repeat(1000)).slice(0, 512);
  assert.deepEqual(result, { outcome: "failed", reason: "io", exitCode: 1, starts: 2, message });
  assert.equal(fs.existsSync(join(f.root, "capture-status.json")), false, "the message is never published status");
  await assert.rejects(captureCommandPass(f.root, {}, { run: async () => result, log() {}, error() {} }),
    { message: `capture worker failed (io): ${message}; matching worker receipt unavailable; appended count is unknown` });
});
