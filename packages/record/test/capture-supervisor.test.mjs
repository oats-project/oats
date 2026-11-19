import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { superviseCapture, captureWorkerEnvironment, captureWorkerMessage, validWorkerResult } from '../lib/capture-supervisor.mjs';
import { acquireCaptureLock, captureLockPath, readCaptureLockOwner } from '../lib/capture-lock.mjs';
import { holderLiveness } from '../lib/lock-holder.mjs';
import { CAPTURE_POLICY } from '../lib/capture-budget.mjs';
const workerURL = new URL('../lib/capture-worker.mjs', import.meta.url).href;
const lockURL = new URL('../lib/capture-lock.mjs', import.meta.url).href;
const supervisorURL = new URL('../lib/capture-supervisor.mjs', import.meta.url).href;
function fixture(t, body = '') {
  const root = mkdtempSync(join(tmpdir(), 'capture-supervisor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workerPath = join(root, 'worker.mjs');
  writeFileSync(workerPath, `import {runCaptureWorker} from ${JSON.stringify(workerURL)};
import {readCaptureLockOwner} from ${JSON.stringify(lockURL)};
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
${body}
`);
  return { root, workerPath };
}
const shortPolicy = { ...CAPTURE_POLICY, deadlineSeconds: 1 };

// All descendants receive the outer fixture's clean environment through the
// production whitelist, never the live host's homes, hooks or manager paths.
test('worker starts after durable identity publication, with fixed heap and no inherited Node injection', async t => {
  const f = fixture(t, `await runCaptureWorker(({root, budget}) => {
    budget.check();
    writeFileSync(join(root,'observed.json'),JSON.stringify({ owner:readCaptureLockOwner(root),
      args:process.execArgv, injected:process.env.NODE_OPTIONS ?? null, custom:process.env.CAPTURE_EVIL ?? null }));
    return {outcome:'complete',reason:null};
  });`);
  const result = await superviseCapture(f.root, {}, { workerPath: f.workerPath,
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=1024 --require=/absent', CAPTURE_EVIL: '1' } });
  assert.deepEqual(result, { outcome: 'complete', reason: null, exitCode: 0 });
  const seen = JSON.parse(readFileSync(join(f.root,'observed.json')));
  assert.equal(seen.owner.pid, process.pid); assert.ok(seen.owner.worker.pid > 0);
  assert.ok(seen.args.includes('--max-old-space-size=256')); assert.equal(seen.injected,null); assert.equal(seen.custom,null);
  assert.equal(holderLiveness({pid:seen.owner.worker.pid}),'dead');
  assert.equal(existsSync(captureLockPath(f.root)),false);
  assert.equal(existsSync(join(f.root,'capture-status.json')),false,'supervisor never manufactures run evidence');
  assert.deepEqual(captureWorkerEnvironment({HOME:'fixture',NODE_OPTIONS:'evil'}),{HOME:'fixture'});
});

test('overlap promptly skips without a child or status changes', async t => {
  const f = fixture(t), lock = acquireCaptureLock(f.root); let spawns = 0;
  try {
    const result = await superviseCapture(f.root,{}, {workerPath:f.workerPath,spawnChild:()=>{spawns++;throw Error('must not spawn');}});
    assert.equal(result.outcome,'overlap');assert.equal(result.exitCode,0);assert.equal(spawns,0);
    assert.equal(readCaptureLockOwner(f.root).nonce,lock.nonce);
  } finally { assert.equal(lock.release().released,true); }
});

test('deadline accounts for startup; cooperative drain is partial and an unresponsive child is killed and reaped', async t => {
  const f = fixture(t, `await new Promise(resolve=>setTimeout(resolve,250));
await runCaptureWorker(({root,budget})=>{
  writeFileSync(join(root,'pid'),String(process.pid));
  writeFileSync(join(root,'remaining'),String(budget.drainAt-budget.started));
  while(!budget.sample()){}
  return {outcome:'partial',reason:budget.reason};
});`);
  let result = await superviseCapture(f.root,{}, {workerPath:f.workerPath,policy:shortPolicy,drainSeconds:0.3});
  assert.equal(result.outcome,'partial');assert.equal(result.reason,'deadline');assert.equal(result.exitCode,0);
  assert.ok(Number(readFileSync(join(f.root,'remaining'))) < 500,'250ms startup is deducted from the 700ms drain budget');
  const pid = Number(readFileSync(join(f.root,'pid')));assert.equal(holderLiveness({pid}),'dead');
  writeFileSync(f.workerPath,`import {runCaptureWorker} from ${JSON.stringify(workerURL)};import {writeFileSync} from 'node:fs';
await runCaptureWorker(({root})=>{writeFileSync(root+'/pid',String(process.pid));while(true){} });`);
  result = await superviseCapture(f.root,{}, {workerPath:f.workerPath,policy:shortPolicy,drainSeconds:0.3});
  assert.deepEqual(result,{outcome:'failed',reason:'deadline',exitCode:1});
  assert.equal(holderLiveness({pid:Number(readFileSync(join(f.root,'pid')))}),'dead');
  assert.equal(existsSync(captureLockPath(f.root)),false);
});

test('RSS stop is cooperative, while signals, missing results and output overflow fail', async t => {
  const f = fixture(t, `await runCaptureWorker(({budget})=>{const reason=budget.sample();return {outcome:'partial',reason};});`);
  let result = await superviseCapture(f.root,{}, {workerPath:f.workerPath,policy:{...shortPolicy,rssBytes:1},drainSeconds:0});
  assert.deepEqual(result,{outcome:'partial',reason:'rss',exitCode:0});
  writeFileSync(f.workerPath,`import {runCaptureWorker} from ${JSON.stringify(workerURL)};
await runCaptureWorker(({budget})=>{budget.check();return {outcome:'complete',reason:null};});`);
  result = await superviseCapture(f.root,{}, {workerPath:f.workerPath,policy:{...shortPolicy,rssBytes:1},drainSeconds:0});
  assert.deepEqual(result,{outcome:'failed',reason:'rss',exitCode:1},'unhandled resource stop preserves its observed reason without claiming committed progress');
  for (const body of [
    `process.kill(process.pid,'SIGTERM');`,
    `process.exit(0);`,
    `process.stderr.write('x'.repeat(100000));setInterval(()=>{},1000);`,
  ]) {
    writeFileSync(f.workerPath,body);
    result=await superviseCapture(f.root,{}, {workerPath:f.workerPath,policy:shortPolicy,drainSeconds:0});
    assert.equal(result.outcome,'failed');assert.equal(result.exitCode,1);
    assert.equal(existsSync(captureLockPath(f.root)),false);
  }
});

test('spawn and registration failures cannot start work and reap the paused child', async t => {
  const f=fixture(t,`await runCaptureWorker(({root})=>{writeFileSync(join(root,'started'),'yes');return {outcome:'complete',reason:null};});`);
  let result=await superviseCapture(f.root,{}, {workerPath:f.workerPath,executable:join(f.root,'missing-node')});
  assert.equal(result.outcome,'failed');assert.equal(result.reason,'io');
  let childPid;
  result=await superviseCapture(f.root,{}, {workerPath:f.workerPath,acquire:root=>{
    const lock=acquireCaptureLock(root);return {...lock,registerWorker:worker=>{
      childPid=worker.pid;lock.registerWorker(worker);throw Error('failed after publication');
    }};
  }});
  assert.equal(result.outcome,'failed');assert.equal(result.reason,'io');
  assert.equal(existsSync(join(f.root,'started')),false);assert.equal(holderLiveness({pid:childPid}),'dead');
  assert.equal(existsSync(captureLockPath(f.root)),false);
});

test('worker observes supervisor death between units; its lock is retained until the orphan exits', async t => {
  const f=fixture(t,`await runCaptureWorker(async ({root,budget})=>{
    writeFileSync(join(root,'started'),String(process.pid));
    // Hold a bounded unit so the parent can prove the dead-parent/live-child window.
    await new Promise(resolve=>setTimeout(resolve,500));
    const reason=budget.sample();writeFileSync(join(root,'orphan'),String(reason));
    return {outcome:'failed',reason};
  });`);
  const parentPath=join(f.root,'parent.mjs');
  writeFileSync(parentPath,`import {superviseCapture} from ${JSON.stringify(supervisorURL)};
await superviseCapture(${JSON.stringify(f.root)}, {}, {workerPath:${JSON.stringify(f.workerPath)}});`);
  const parent=spawn(process.execPath,[parentPath],{env:captureWorkerEnvironment(),stdio:['ignore','ignore','pipe']});
  const ended=once(parent,'exit');let workerPid;
  const until=async predicate=>{
    const stop=Date.now()+5000;
    while(!predicate()){if(Date.now()>stop)throw Error('fixture deadline');await new Promise(resolve=>setTimeout(resolve,10));}
  };
  try {
    await until(()=>existsSync(join(f.root,'started')));
    workerPid=Number(readFileSync(join(f.root,'started')));
    parent.kill('SIGKILL');await ended;
    assert.equal(holderLiveness({pid:workerPid}),'alive');
    const held=acquireCaptureLock(f.root);assert.equal(held.release,undefined);
    await until(()=>existsSync(join(f.root,'orphan')));
    assert.equal(readFileSync(join(f.root,'orphan'),'utf8'),'interrupted');
    await until(()=>holderLiveness({pid:workerPid})==='dead');
    const recovered=acquireCaptureLock(f.root);assert.equal(recovered.reclaimed.pid,parent.pid);
    assert.equal(recovered.release().released,true);
  } finally {
    if(parent.exitCode===null&&parent.signalCode===null){parent.kill('SIGKILL');await ended;}
    // The worker has its own bounded unit and exits on orphan detection; never
    // signal a persisted/reused PID to clean up this fixture.
    if(workerPid)await until(()=>holderLiveness({pid:workerPid})==='dead');
  }
});

test('worker diagnostics are one bounded line, never parser input, and only accompany failure', () => {
  assert.equal(captureWorkerMessage(new Error('ENOSPC: no space left on device, write\r\n\u001b[0m\u2028next')), 'ENOSPC: no space left on device, write [0m next');
  assert.equal(captureWorkerMessage(new SyntaxError('Unexpected token \'s\', "secret record" is not valid JSON')), 'SyntaxError');
  assert.equal(captureWorkerMessage(new Error('x'.repeat(600))).length, 512);
  assert.equal(captureWorkerMessage(new Error('\n\t')), 'unexplained operational failure');
  assert.equal(captureWorkerMessage('thrown string'), 'non-Error exception');
  assert.ok(validWorkerResult({ outcome: 'failed', reason: 'io', message: 'status write failed' }));
  for (const value of [{ outcome: 'partial', reason: 'deadline', message: 'x' }, { outcome: 'failed', reason: 'io', message: '' },
    { outcome: 'failed', reason: 'io', message: 'a\nb' }, { outcome: 'failed', reason: 'io', message: 'x'.repeat(513) },
    { outcome: 'failed', reason: 'io', message: 7 }]) assert.equal(Boolean(validWorkerResult(value)), false, JSON.stringify(value));
});
