import assert from 'node:assert/strict';
import fs from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { acquireCaptureLock, captureLockPath, readCaptureLockOwner } from '../lib/capture-lock.mjs';
import { holderIdentity, holderLiveness } from '../lib/lock-holder.mjs';
const host=hostname(),start='2026-01-01T00:00:00.000Z';
function fixture(t){const root=fs.mkdtempSync(join(tmpdir(),'capture-worker-lock-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function plant(root,worker){const dir=captureLockPath(root);fs.mkdirSync(dir,{recursive:true});const owner={pid:100,nonce:'parent',host,startedAt:start,worker};fs.writeFileSync(join(dir,'owner.json'),JSON.stringify(owner));return owner;}

test('dead supervisor cannot release its registered live, reused, unknown, foreign or malformed worker lock',t=>{
 const root=fixture(t),worker={pid:101,nonce:'child',host,startedAt:start};
 for(const [description,value,status]of [
  ['live',worker,'alive'],['reused PID',worker,'alive'],['uncertain',worker,'unknown'],
  ['foreign',{...worker,host:'elsewhere'},'dead'],['missing',null,'dead'],['partial',{pid:101},'dead'],
  ['zero',{...worker,pid:0},'dead'],['group',{...worker,pid:-101},'dead'],['same parent',{...worker,pid:100},'dead'],
  ['missing time',{...worker,startedAt:null},'dead'],
 ]){
  fs.rmSync(captureLockPath(root),{recursive:true,force:true});const owner=plant(root,value);
  const lock=acquireCaptureLock(root,{pid:102,liveness:({pid})=>pid===100?'dead':status});
  assert.equal(lock.release,undefined,description);assert.deepEqual(readCaptureLockOwner(root),owner,description);
 }
 fs.rmSync(captureLockPath(root),{recursive:true,force:true});plant(root,worker);
 const reclaimed=acquireCaptureLock(root,{pid:102,liveness:()=> 'dead'});
 assert.equal(reclaimed.reclaimed.pid,100);assert.deepEqual(reclaimed.release(),{released:true});
});

test('worker publication is private, fsynced before return and blocks release until the child is proven dead',t=>{
 const root=fixture(t);let state='alive';const events=[];
 const lock=acquireCaptureLock(root,{liveness:()=>state,io:{fsyncSync:fd=>{events.push(fs.fstatSync(fd).isDirectory()?'directory':'file');fs.fsyncSync(fd);}}});
 const worker={pid:99999999,nonce:'worker-nonce',startedAt:start};lock.registerWorker(worker);
 assert.deepEqual(events,['file','directory','directory']);
 assert.deepEqual(readCaptureLockOwner(root).worker,{...worker,host,...holderIdentity(worker.pid)});
 assert.equal(fs.statSync(captureLockPath(root)).mode&0o777,0o700);
 assert.equal(fs.statSync(join(captureLockPath(root),'owner.json')).mode&0o777,0o600);
 assert.equal(lock.release().reason,'worker-active');state='unknown';assert.equal(lock.release().reason,'worker-active');
 state='dead';assert.deepEqual(lock.release(),{released:true});
});

test('registration refuses stale ownership, invalid identities and failure to durably publish',t=>{
 const root=fixture(t),worker={pid:99999999,nonce:'child',startedAt:start};
 let lock=acquireCaptureLock(root);
 for(const invalid of [{...worker,pid:0},{...worker,pid:-1},{...worker,pid:process.pid},{...worker,nonce:''},{...worker,startedAt:'invalid'}])assert.throws(()=>lock.registerWorker(invalid),/invalid capture worker/);
 fs.writeFileSync(join(captureLockPath(root),'owner.json'),JSON.stringify({pid:process.pid,nonce:'replacement',host,startedAt:start}));
 assert.throws(()=>lock.registerWorker(worker),/changed before/);assert.equal(readCaptureLockOwner(root).nonce,'replacement');
 fs.rmSync(captureLockPath(root),{recursive:true});
 let syncs=0;
 lock=acquireCaptureLock(root,{liveness:()=> 'dead',io:{fsyncSync:fd=>{if(++syncs===2)throw Error('directory sync failed');fs.fsyncSync(fd);}}});
 assert.throws(()=>lock.registerWorker(worker),/directory sync failed/);
 assert.equal(readCaptureLockOwner(root).worker.pid,worker.pid,'published identity is retained on late durability failure; caller must not send GO');
 assert.deepEqual(lock.release(),{released:true});
});

test('registration failure preserves replaced temporary files and owner directories',t=>{
 const root=fixture(t),worker={pid:99999999,nonce:'child',startedAt:start};let renamed,lock;
 lock=acquireCaptureLock(root,{io:{fsyncSync:fd=>{
  fs.fsyncSync(fd);
  if(fs.fstatSync(fd).isFile()){
   const path=join(captureLockPath(root),`worker-${lock.nonce}.tmp`);
   renamed=path+'.original';fs.renameSync(path,renamed);fs.writeFileSync(path,'replacement');
  }
 }}});
 assert.throws(()=>lock.registerWorker(worker),/changed during/);
 assert.equal(fs.readFileSync(join(captureLockPath(root),`worker-${lock.nonce}.tmp`),'utf8'),'replacement');
 assert.ok(fs.existsSync(renamed));assert.equal(readCaptureLockOwner(root).worker,undefined);
 assert.deepEqual(lock.release(),{released:true});
 let replacement;
 lock=acquireCaptureLock(root,{io:{fsyncSync:fd=>{
  fs.fsyncSync(fd);
  if(fs.fstatSync(fd).isFile()){
   fs.renameSync(captureLockPath(root),join(root,'old-lock'));
   replacement=acquireCaptureLock(root);
  }
 }}});
 assert.throws(()=>lock.registerWorker(worker),/changed during/);
 assert.equal(readCaptureLockOwner(root).nonce,replacement.nonce);
 assert.equal(lock.release().reason,'not-owner');assert.deepEqual(replacement.release(),{released:true});
});

test('owner readers reject links, special files and oversized markers without blocking; liveness probes never signal groups',t=>{
 const root=fixture(t),dir=captureLockPath(root);fs.mkdirSync(dir);const marker=join(dir,'owner.json'),outside=join(root,'outside');
 fs.writeFileSync(outside,JSON.stringify({pid:process.pid}));fs.symlinkSync(outside,marker);
 assert.equal(readCaptureLockOwner(root),undefined);assert.equal(acquireCaptureLock(root).release,undefined);fs.unlinkSync(marker);
 const mkfifo=spawnSync('/usr/bin/mkfifo',[marker],{env:{HOME:root,PATH:process.env.PATH},encoding:'utf8'});assert.equal(mkfifo.status,0,mkfifo.stderr);
 assert.equal(readCaptureLockOwner(root),undefined);assert.equal(acquireCaptureLock(root).release,undefined);fs.unlinkSync(marker);
 fs.writeFileSync(marker,'x'.repeat(4097));assert.equal(readCaptureLockOwner(root),undefined);
 const kill=process.kill;let calls=0;
 process.kill=()=>{calls++;throw Object.assign(Error('probe'),{code:'EIO'});};
 try{for(const pid of [0,-1,NaN,Infinity,2147483648])assert.equal(holderLiveness({pid}),'unknown');assert.equal(calls,0);assert.equal(holderLiveness({pid:123}),'unknown');}
 finally{process.kill=kill;}
});

test('an actual owned idle child keeps its supervisor lock until it is reaped',async t=>{
 const root=fixture(t),lock=acquireCaptureLock(root);
 const child=spawn(process.execPath,['-e','process.stdout.write("ready");setInterval(()=>{},1000)'],{env:{HOME:root,TMPDIR:root,PATH:process.env.PATH},stdio:['ignore','pipe','pipe'],timeout:5000,killSignal:'SIGKILL'});
 const ended=once(child,'exit');
 try{
  await once(child.stdout,'data');lock.registerWorker({pid:child.pid,nonce:'owned-child',startedAt:start});
  assert.equal(lock.release().reason,'worker-active');
  const deadParent=acquireCaptureLock(root,{pid:99999998,liveness:holder=>holder.pid===process.pid?'dead':holderLiveness(holder)});
  assert.equal(deadParent.release,undefined,'even a proven dead supervisor cannot expose the still-live worker');
  child.kill('SIGTERM');await ended;assert.deepEqual(lock.release(),{released:true});
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await ended;}}
});

test('release reports an identity-read failure without deleting the lock',t=>{
 const root=fixture(t);let removals=0;
 const lock=acquireCaptureLock(root,{io:{
  lstatSync:()=>{throw Object.assign(Error('identity read denied'),{code:'EACCES'});},
  rmSync:()=>{removals++;},
 }});
 const result=lock.release();assert.equal(result.released,false);assert.equal(result.reason,'remove-failed');
 assert.match(result.error,/identity read denied/);assert.match(result.recovery,/before removal/);
 assert.equal(removals,0);assert.equal(readCaptureLockOwner(root).nonce,lock.nonce);
});

test('continuation replaces only the exact positively dead worker without dropping the root lock',t=>{
 const root=fixture(t),prior={pid:99999998,nonce:'prior',startedAt:start},next={pid:99999999,nonce:'next',startedAt:start};
 let status='alive';const lock=acquireCaptureLock(root,{liveness:()=>status});
 lock.registerWorker(prior);const original=readCaptureLockOwner(root);
 for(const live of ['alive','unknown']){
  status=live;assert.throws(()=>lock.registerWorker(next,{previous:prior}),/not proven dead/);
  assert.deepEqual(readCaptureLockOwner(root),original);
 }
 status='dead';
 assert.throws(()=>lock.registerWorker(next),/not proven dead/);
 assert.throws(()=>lock.registerWorker(next,{previous:{...prior,nonce:'different'}}),/not proven dead/);
 lock.registerWorker(next,{previous:prior});
 assert.equal(readCaptureLockOwner(root).nonce,original.nonce);
 assert.deepEqual(readCaptureLockOwner(root).worker,{...next,host,...holderIdentity(next.pid)});
 assert.deepEqual(lock.release(),{released:true});
});
