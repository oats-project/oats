import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { RecordStore } from "../lib/store.mjs";
import { DerivedState } from "../lib/derived-state.mjs";
import { withCaptureGroup } from "../lib/capture-context.mjs";
import { captureAwUnit } from "../lib/capture-aw-unit.mjs";
import * as awaitCapture from '../lib/capture-aw.mjs';
import { resetSourceCursors, retrySetAside } from "../lib/capture-state.mjs";
const stamp="2026-01-01T00:00:00Z",stream="fixture~aw";
const entry=(n,ts=stamp)=>JSON.stringify({...(ts?{ts}:{}),dir:'recv',ch:'mail',msg_id:String(n),from:'alice',to:'fixture',body:String(n)})+'\n';
const url=name=>new URL(`../lib/${name}.mjs`,import.meta.url).href;
function fixture(t,text){
  const base=fs.mkdtempSync(join(tmpdir(),'aw-unit-')),root=join(base,'record'),path=join(base,'account.jsonl');
  fs.writeFileSync(path,text);t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const store=new RecordStore(root,{owner:'fixture'}),key=`${stream}:${path}`,worker=join(base,'unit.mjs');
  fs.writeFileSync(worker,`
    import {RecordStore} from ${JSON.stringify(url('store'))};
    import {DerivedState} from ${JSON.stringify(url('derived-state'))};
    import {withCaptureGroup} from ${JSON.stringify(url('capture-context'))};
    import {captureAwUnit} from ${JSON.stringify(url('capture-aw-unit'))};
    const [root,path,options]=process.argv.slice(2),store=new RecordStore(root,{owner:'fixture'}),state=new DerivedState(root),work={journal:{}};
    const o=JSON.parse(options);let calls=0;
    try{
      const append=store.appendUniqueBatch.bind(store);
      store.appendUniqueBatch=(stream,turns)=>{if(o.failAppend)throw Error('injected append failure');const n=append(stream,turns);if(o.crashAppend)process.kill(process.pid,'SIGKILL');return n;};
      const result=withCaptureGroup(store,['fixture~aw'],()=>captureAwUnit(store,{owner:'fixture',path,work,maxRecords:3,...o,stopped:()=>o.stopAfter!==undefined&&++calls>o.stopAfter}),{state});
      process.stdout.write(JSON.stringify({result,work,cursor:state.get('aw',${JSON.stringify(key)}),job:state.get('aw-unit',${JSON.stringify(key)})}));
    }finally{state.close();}
  `);
  const f={root,path,key,store,
    state(fn){const state=new DerivedState(root);try{return fn(state);}finally{state.close();}},
    step(options={}){
      const result=spawnSync(process.execPath,['--max-old-space-size=256',worker,root,path,JSON.stringify(options)],
        {env:process.env,encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
      if(options.crashAppend){assert.equal(result.signal,'SIGKILL');return;}
      if(options.failAppend){assert.notEqual(result.status,0);return;}
      assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
    },
    finish(options={}){const rows=[];for(let n=0;n<200;n++){const row=f.step(options);rows.push(row);if(row.result.complete||row.result.pending||row.result.setAside)return rows;}assert.fail('finite AW input did not finish');},
    bodies(){return store.readStream(stream).map(t=>t.body.text);},
  };return f;
}

test('bounded fresh processes consume refused, malformed and whitespace lines; no-op reads zero, growth and reset retry remain distinct',t=>{
  const text=entry(0)+entry('refused',null)+'{bad}\n'+' '.repeat(100)+'\n'+entry(1),f=fixture(t,text);
  const rows=f.finish({maxRecords:2});assert.equal(rows.reduce((n,r)=>n+r.result.entries,0),3);
  assert.equal(rows.reduce((n,r)=>n+r.result.skipped,0),1);assert.equal(rows.reduce((n,r)=>n+r.result.failed,0),1);
  assert.equal(rows.reduce((n,r)=>n+r.result.appended,0),2);assert.ok(rows.every(r=>(r.work.sourceRecords??0)<=2));
  const noop=f.step();assert.equal(noop.result.unchanged,true);assert.equal(noop.work.sourceBytes??0,0);
  fs.appendFileSync(f.path,entry(2));const growth=f.finish();assert.equal(growth.reduce((n,r)=>n+r.result.appended,0),1);
  assert.equal(growth.reduce((n,r)=>n+r.result.failed,0),0);assert.equal(growth.reduce((n,r)=>n+(r.work.journal.bytes??0),0),0);
  resetSourceCursors(f.root,'fixture','aw');const replay=f.finish();
  assert.equal(replay.reduce((n,r)=>n+r.result.failed,0),1);assert.equal(replay.reduce((n,r)=>n+r.result.appended,0),0);
  assert.deepEqual(f.bodies(),['0','1','2']);
});

test('a long whitespace inventory consumes bounded units and its later growth does not rescan consumed lines',t=>{
  const whitespace=(' '.repeat(300)+'\n').repeat(1000),f=fixture(t,entry(0)+whitespace);
  const rows=f.finish({maxRecords:128,maxBytes:65536});assert.ok(rows.length>7);
  assert.equal(rows.reduce((n,r)=>n+(r.work.sourceRecords??0),0),1001);
  assert.equal(f.step().work.sourceBytes??0,0);
  fs.appendFileSync(f.path,entry(1));const growth=f.finish();
  assert.equal(growth.reduce((n,r)=>n+(r.work.sourceBytes??0),0),Buffer.byteLength(entry(1)));
  assert.deepEqual(f.bodies(),['0','1']);
});

test('fixed-end units finish their admitted snapshot before consuming later growth',t=>{
  const f=fixture(t,Array.from({length:8},(_,n)=>entry(n)).join(''));
  f.step({maxRecords:2});fs.appendFileSync(f.path,entry(8));
  f.finish({maxRecords:2});assert.equal(f.bodies().length,8);
  f.finish();assert.equal(f.bodies().length,9);
});

test('unfinished final objects and malformed fragments remain pending and retain their starting boundary',t=>{
  const final=entry(1).trimEnd(),f=fixture(t,entry(0)+final);
  const first=f.finish().at(-1);assert.equal(first.result.pending,true);assert.equal(first.result.complete,false);
  assert.equal(first.cursor.bytes,Buffer.byteLength(entry(0)));assert.deepEqual(f.bodies(),['0','1']);
  const noop=f.step();assert.equal(noop.result.pending,true);assert.equal(noop.work.sourceBytes??0,0);
  fs.appendFileSync(f.path,'\n'+entry(2));f.finish();assert.deepEqual(f.bodies(),['0','1','2']);
  fs.appendFileSync(f.path,'{"');assert.equal(f.finish().at(-1).result.pending,true);
});

test('append failure and killed checkpoint never commit consumed whitespace or lose/duplicate turns',t=>{
  const text=entry(0)+'   \n'+entry(1),f=fixture(t,text);
  f.step({maxRecords:3,failAppend:true});assert.equal(f.state(s=>s.get('aw',f.key)),null);assert.equal(f.bodies().length,0);
  f.step({maxRecords:3,crashAppend:true});assert.equal(f.state(s=>s.get('aw',f.key)),null);assert.deepEqual(f.bodies(),['0','1']);
  f.finish();assert.deepEqual(f.bodies(),['0','1']);
  const turns=f.store.readStream(stream);assert.equal(new Set(turns.map(t=>t.id)).size,2);
});

test('reset/replacement reprojects changed old entries; raw oversize is set aside after its prefix, retry rechecks, and ignore wins before open',t=>{
  const f=fixture(t,entry(0)+entry(1));f.finish();fs.unlinkSync(f.path);fs.writeFileSync(f.path,entry('changed')+entry(1));
  f.finish();assert.deepEqual(f.bodies(),['0','1','changed']);
  // The complete record before the oversized one shares its unit: it is
  // appended and checkpointed once, and the input is set aside at the record.
  const start=Buffer.byteLength(entry('changed')+entry(1)+entry(2));
  fs.appendFileSync(f.path,entry(2)+'x'.repeat(5000)+'\n'+entry(3));const blocked=f.finish({maxRecordBytes:300}).at(-1);
  assert.equal(blocked.result.appended,1);assert.equal(blocked.cursor.bytes,start);
  assert.equal(blocked.result.setAside.offset,start);assert.equal(blocked.result.setAside.reason,'record-too-large');
  assert.deepEqual(f.bodies(),['0','1','changed','2']);
  resetSourceCursors(f.root,'fixture','aw');assert.ok(f.step().result.setAside,'reset is not retry');
  retrySetAside(f.root);const retried=f.finish({maxRecordBytes:300});
  assert.equal(retried.at(-1).result.setAside.offset,start);assert.equal(retried.reduce((n,r)=>n+r.result.appended,0),0);
  assert.equal(f.state(s=>s.get('set-aside',f.key)).offset,start);
  assert.deepEqual(f.bodies(),['0','1','changed','2'],'retry neither duplicates the prefix nor passes the oversized record');
  fs.writeFileSync(f.path,entry('changed')+entry(1)+entry(2));retrySetAside(f.root);f.finish();
  assert.equal(f.state(s=>s.get('set-aside',f.key)),null);assert.deepEqual(f.bodies(),['0','1','changed','2']);
  fs.writeFileSync(join(f.root,'ignore'),f.path+'\n');fs.unlinkSync(f.path);assert.equal(f.step().result.ignored,true);
});

test('a rescan after the cursor stops qualifying does not refuse records already captured, and captures what follows',t=>{
  // Captured with no record limit, as a release without one would.
  const big=JSON.stringify({ts:stamp,dir:'recv',ch:'mail',msg_id:'big',from:'alice',to:'fixture',body:'x'.repeat(5000)})+'\n';
  const f=fixture(t,entry(0)+big);f.finish();assert.equal(f.bodies().length,2);
  fs.appendFileSync(f.path,entry(2)+entry(3));
  // A reset invalidates the cursor: the rescan starts at 0 under a 300-byte limit.
  resetSourceCursors(f.root,'fixture','aw');const rows=f.finish({maxRecordBytes:300});
  assert.equal(rows.some(r=>r.result.setAside),false,JSON.stringify(rows.at(-1).result));
  assert.equal(f.state(s=>s.get('set-aside',f.key)),null);
  assert.deepEqual(f.bodies(),['0','x'.repeat(5000),'2','3'],'nothing refused, nothing duplicated');
  // The limit still applies at and beyond the captured frontier.
  fs.appendFileSync(f.path,big.replace('"big"','"later"'));
  assert.equal(f.finish({maxRecordBytes:300}).at(-1).result.setAside.reason,'record-too-large');
});

test('the captured frontier survives a second invalidation between the units of a rescan',t=>{
  const big=JSON.stringify({ts:stamp,dir:'recv',ch:'mail',msg_id:'big',from:'alice',to:'fixture',body:'z'.repeat(5000)})+'\n';
  const f=fixture(t,entry(0)+entry(1)+big+entry(3));f.finish();assert.equal(f.bodies().length,4);
  // The rescan runs one record per unit, so the cursor it writes stops short
  // of the oversized record; a second reset then lands between its units.
  resetSourceCursors(f.root,'fixture','aw');
  const first=f.step({maxRecords:1,maxRecordBytes:300});assert.equal(first.result.complete,false);
  assert.ok(first.cursor.bytes<Buffer.byteLength(entry(0)+entry(1)),'the cursor stops before the oversized record');
  resetSourceCursors(f.root,'fixture','aw');
  const rows=f.finish({maxRecords:1,maxRecordBytes:300});
  assert.equal(rows.some(r=>r.result.setAside),false,JSON.stringify(rows.at(-1).result));
  assert.equal(f.state(s=>s.get('set-aside',f.key)),null);
  assert.deepEqual(f.bodies(),['0','1','z'.repeat(5000),'3'],'nothing refused, nothing duplicated');
});

test('a 0.61.0-shaped cursor that no longer qualifies keeps its captured frontier',t=>{
  const big=JSON.stringify({ts:stamp,dir:'recv',ch:'mail',msg_id:'big',from:'alice',to:'fixture',body:'y'.repeat(5000)})+'\n';
  const f=fixture(t,entry(0)+big);f.finish();
  // The row exactly as 0.61.0 writes it (no projection or retry generation),
  // from an older journal epoch: it no longer qualifies.
  f.state(s=>{const c=s.get('aw',f.key);s.transaction(()=>s.set('aw',f.key,
    {bytes:c.bytes,version:c.version,witness:c.witness,epoch:'epoch-from-0.61.0',generation:'',complete:true}));});
  fs.appendFileSync(f.path,entry(2));const rows=f.finish({maxRecordBytes:300});
  assert.equal(rows.some(r=>r.result.setAside),false,JSON.stringify(rows.at(-1).result));
  assert.deepEqual(f.bodies(),['0','y'.repeat(5000),'2']);
});

test('shared group uses the owning projection and keeps source progress with its durable append',t=>{
  const f=fixture(t,entry(0)+entry(1)),state=new DerivedState(f.root);
  try{
    const r=withCaptureGroup(f.store,[stream],()=>captureAwUnit(f.store,{owner:'fixture',path:f.path,maxRecords:1}),{state});
    assert.equal(r.appended,1);assert.equal(state.get('aw',f.key).bytes,Buffer.byteLength(entry(0)));
    assert.equal(state.get('aw-unit',f.key).end,fs.statSync(f.path).size);
  }finally{state.close();}
  f.finish();assert.deepEqual(f.bodies(),['0','1']);
});

test('interaction units use their explicit projection context and reproject when that context changes',t=>{
  const text=JSON.stringify({ts:stamp,kind:'mail_out',message_id:'m1',to:'kate',subject:'handoff',text:'the epic'})+'\n',f=fixture(t,text);
  assert.equal(f.finish({kind:'interaction',selfName:'jack',workspace:'team'}).at(-1).result.appended,1);
  let turns=f.store.readStream(stream);assert.equal(turns[0].from,'jack');assert.equal(turns[0].to,'kate');
  const noop=f.step({kind:'interaction',selfName:'jack',workspace:'team'});assert.equal(noop.work.sourceBytes??0,0);
  f.finish({kind:'interaction',selfName:'jane',workspace:'team'});turns=f.store.readStream(stream);
  assert.deepEqual(turns.map(t=>t.from),['jack','jane']);
});

test('sealed AW records keep the cursor before ciphertext in public capture and command units', t => {
  const sealed = JSON.stringify({ v: 1, key_id: 'key', tag: 'mail', enc: 'aes256gcm', ct: 'ciphertext' }) + '\n';
  const readable = (n, ts = stamp) => JSON.stringify({ ...JSON.parse(entry(n, ts)), kind: 'mail_in', text: String(n) }) + '\n';
  const prefix = readable(0) + readable('refused', null) + ' \n';
  for (const kind of ['comm', 'interaction']) {
    const f = fixture(t, prefix + sealed + readable(1));
    for (let retry = 0; retry < 2; retry++) {
      const { result, cursor } = f.step({ kind, selfName: 'fixture', maxRecords: 10 });
      assert.equal(result.sealed, 1);
      assert.equal(result.failed, retry ? 0 : 1, 'readable projection errors still consume the line');
      assert.equal(result.complete, false);
      assert.equal(result.setAside.reason, 'sealed, not readable by this recorder');
      assert.equal(cursor.bytes, Buffer.byteLength(prefix));
    }
  }
  const { captureAwLogs, captureCommLog, captureInteractionLog } = awaitCapture;
  for (const capture of [captureAwLogs, captureCommLog, captureInteractionLog]) {
    const f = fixture(t, prefix + sealed + readable(1));
    const options = { owner: 'fixture', selfName: 'fixture', path: f.path, commLogDir: join(f.path, '..') };
    for (let retry = 0; retry < 2; retry++) {
      const answer = capture(f.store, options), result = Array.isArray(answer) ? answer[0] : answer;
      assert.equal(result.sealed, 1);
      assert.equal(result.failed, capture === captureAwLogs && retry ? 0 : 1);
      if (capture === captureAwLogs) assert.equal(f.state(s => s.get('aw', f.key)).bytes, Buffer.byteLength(prefix));
    }
  }
});
