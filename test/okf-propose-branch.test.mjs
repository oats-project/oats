// oats.okf 6.0: no harvester. The instance proposes its own knowledge with
// `oats okf propose`, which the kernel dispatches from the instance home to the
// locked package. Plan, check and apply run against local repositories (gh is a
// narrow argv-checking fake). This proves the kernel's dispatch, Git isolation
// and the create-only publication, NOT model judgment, real GitHub or review.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { fixture, write, json, readJSON } from './helpers/okf-v2.mjs';

const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';

function github(f) {
  const prs = join(f.base, 'prs.json'), calls = join(f.base, 'gh.jsonl');
  json(prs, []);
  // The released 6.0 helper's exact gh surface: the okf-proposal label, the
  // fixed title, the body on stdin and its readback; plan's duplicate listing.
  write(join(f.bin, 'gh'), `#!${process.execPath}
import * as fs from 'node:fs';import {execFileSync} from 'node:child_process';import assert from 'node:assert/strict';
const a=process.argv.slice(2),v=k=>a[a.indexOf(k)+1],p=${JSON.stringify(prs)};
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');
const remoteHead=branch=>{
  const rows=execFileSync('git',['ls-remote','--refs',${JSON.stringify(f.accepted)},'refs/heads/'+branch],{encoding:'utf8'}).trim().split('\\n');
  assert.equal(rows.length,1);
  const [oid,ref]=rows[0].split('\\t');assert.match(oid,/^[0-9a-f]{40}$/);assert.equal(ref,'refs/heads/'+branch);return oid;
};
if(a[0]==='pr' && a[1]==='list') {
  assert.deepEqual(a,['pr','list','--repo','fixture/knowledge','--label',v('--label'),'--state','open','--limit','100','--json','number,title,url']);
  assert.ok(['okf-proposal','okf-harvest'].includes(v('--label')));console.log('[]');
} else if(a[0]==='label') {
  assert.deepEqual(a,['label','create','okf-proposal','--repo','fixture/knowledge','--force','--color','0E8A16','--description','OKF knowledge proposal PR (oats.okf)']);
} else if(a[0]==='pr' && a[1]==='create') {
  const head=v('--head');assert.match(head,/^okf-proposal\\//);
  assert.deepEqual(a,['pr','create','--repo','fixture/knowledge','--base','main','--head',head,'--label','okf-proposal','--title','OKF knowledge proposal','--body-file','-']);
  const body=fs.readFileSync(0,'utf8');assert.ok(body.trim());
  const old=JSON.parse(fs.readFileSync(p)),number=old.length+1,url='https://github.com/fixture/knowledge/pull/'+number;
  old.push({number,url,state:'OPEN',headRefName:head,headRefOid:remoteHead(head),baseRefName:'main',isCrossRepository:false,title:'OKF knowledge proposal',body});
  fs.writeFileSync(p,JSON.stringify(old));console.log(url);
} else if(a[0]==='pr' && a[1]==='view') {
  assert.deepEqual(a,['pr','view',a[2],'--repo','fixture/knowledge','--json','state,headRefOid,headRefName,baseRefName,isCrossRepository,title,body']);
  assert.match(a[2],/^[1-9][0-9]*$/);
  const pr=JSON.parse(fs.readFileSync(p)).find(x=>String(x.number)===a[2]);assert.ok(pr);
  console.log(JSON.stringify({...pr,headRefOid:remoteHead(pr.headRefName)}));
} else { process.exit(91); }
`);
  fs.chmodSync(join(f.bin, 'gh'), 0o755);
  const read = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  return { prs, calls, read, writes: () => read().filter(c => c[0] === 'label' || (c[0] === 'pr' && c[1] !== 'list' && c[1] !== 'view')) };
}

const ok = r => { assert.equal(r.status, 0, JSON.stringify(r.out) + r.stderr); assert.equal(r.out.ok, true, JSON.stringify(r.out)); return r.out.result; };
const refused = (r, code) => {
  assert.equal(r.status, 1, JSON.stringify(r.out)); assert.equal(r.out.ok, false);
  assert.equal(r.out.error.code, code, JSON.stringify(r.out.error)); return r.out.error;
};

/** Plan from the source's home, then write one owned-node concept in the clone and fill proposal.md. */
function stage(f, slug) {
  write(join(f.home, 'notes/lesson.md'), 'A bounded review decision.\n');
  const plan = ok(f.okfPropose(['--plan', '--slug', slug]));
  assert.equal(plan.form, 'live');
  assert.ok(plan.proposal.startsWith(join(f.home, 'proposals') + '/'), 'the proposal lives in the source home');
  assert.deepEqual(plan.bases.map(b => b.alias), ['project']);
  const clone = plan.bases[0].clone, base = join(clone, 'knowledge');
  write(join(base, 'expert/decision.md'), '---\ntype: Decision\ntitle: File based claims\ndescription: Why claim text is written as data.\n---\n\nClaims are data, never shell commands.\n');
  fs.appendFileSync(join(base, 'expert/index.md'), '* [File based claims](decision.md) - Why claim text is data.\n');
  write(join(plan.proposal, 'proposal.md'), '# OKF proposal: claims are data, never shell commands\n\n## What\nA decision in project/expert: claim text is written as data.\n\n## Why\nA future instance would otherwise interpolate claims into shell text.\n\n## Evidence\nObserved while publishing a fixture proposal.\n\n## Backing notes\n- notes/lesson.md\n');
  return { plan, clone, base };
}

test('oats okf propose from an instance home: plan, check and apply push a create-only okf-proposal branch without changing accepted HEAD or reclaiming old branches', t => {
  const f = fixture(t, { git: true }), gh = github(f), git = (...a) => f.git('-C', f.accepted, ...a);
  const head = git('rev-parse', 'HEAD'); git('branch', 'okf-proposal/old-probe');
  const staged = stage(f, 'file-claims');
  const checked = ok(f.okfPropose(['--check', '--slug', 'file-claims']));
  assert.match(checked.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(checked.bases.map(b => b.alias), ['project']);
  assert.ok(checked.bases[0].changed.length > 0);
  assert.ok(checked.bases[0].changed.every(p => /(^|\/)expert\//.test(p)), JSON.stringify(checked.bases[0].changed));
  assert.deepEqual(gh.writes(), [], 'check publishes nothing');
  assert.equal(git('rev-parse', 'HEAD'), head);
  const applied = ok(f.okfPropose(['--apply', '--slug', 'file-claims', '--digest', checked.digest]));
  assert.equal(applied.prs.length, 1);
  const [pr] = applied.prs;
  assert.match(pr.branch, new RegExp(`^okf-proposal/\\d{8}-${UUID}$`));
  f.git('check-ref-format', `refs/heads/${pr.branch}`);
  const commit = git('rev-parse', pr.branch);
  assert.equal(pr.head, commit, 'the published head is the remote branch');
  assert.equal(pr.base, head, 'parented on the accepted commit');
  assert.equal(git('rev-parse', 'HEAD'), head, 'a proposed branch is not acceptance');
  assert.equal(git('rev-parse', 'okf-proposal/old-probe'), head, 'old branch never reclaimed');
  assert.equal(git('show', `${commit}:code.txt`), 'untouched code');
  assert.ok(git('diff', '--name-only', head, commit).split('\n').every(p => p.startsWith('knowledge/expert/')));
  assert.equal(fs.existsSync(join(f.accepted, 'knowledge/expert/decision.md')), false);
  assert.equal(f.consult(f.home, 'expert/decision.md'), null, 'proposal is not accepted knowledge');
  const prs = readJSON(gh.prs);
  assert.equal(prs.length, 1); assert.equal(prs[0].headRefOid, commit); assert.equal(prs[0].url, pr.url);
  assert.match(prs[0].body, /```okf-proposal\n/, 'the PR carries the 6.0 provenance block');
  assert.equal(readJSON(join(staged.plan.proposal, 'published.json')).prs[0].url, pr.url, 'the publication record stays in the proposal');
  // One attempt per proposal, and the removed completion cannot replay a PR.
  const before = gh.read().length;
  refused(f.okfPropose(['--apply', '--slug', 'file-claims', '--digest', checked.digest]), 'E_PROPOSAL_EXISTS');
  const removed = f.raw(['okf', 'complete', '--soul', 'source', '--json']);
  assert.equal(removed.status, 1); assert.equal(JSON.parse(removed.stdout).error.code, 'E_REMOVED');
  assert.equal(gh.read().length, before, 'neither a second apply nor a removed command reaches gh');
  assert.equal(git('rev-parse', pr.branch), commit);
  // Explicit fixture-operator acceptance, NOT a kernel or proposer merge.
  git('merge', '--ff-only', pr.branch);
  const fresh = f.spawn('after-merge');
  assert.match(f.consult(fresh.home, 'expert/decision.md', { fresh: true }), /Claims are data/);
  f.retire(fresh.instance); f.retire(f.source.instance);
});

test('propose --check refuses a peer-node edit before anything leaves the host; ownership is enforced, not left uncommitted', t => {
  const f = fixture(t, { git: true }), gh = github(f), git = (...a) => f.git('-C', f.accepted, ...a);
  const head = git('rev-parse', 'HEAD'), refs = git('for-each-ref', '--format=%(refname)');
  const staged = stage(f, 'peer-edit');
  fs.appendFileSync(join(staged.base, 'peer/log.md'), 'Unowned fixture edit.\n');
  const error = refused(f.okfPropose(['--check', '--slug', 'peer-edit']), 'E_OWNER');
  assert.match(error.message, /peer/);
  assert.deepEqual(gh.writes(), [], 'nothing published');
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(git('for-each-ref', '--format=%(refname)'), refs, 'no branch pushed');
  assert.equal(fs.existsSync(join(staged.plan.proposal, 'publish')), false, 'no publication attempt');
  f.retire(f.source.instance);
});

test('a directory base takes no proposal: propose refuses E_UNSUPPORTED with the remedy, and removed completion/retry commands touch nothing', t => {
  const f = fixture(t), peer = join(f.accepted, 'peer/log.md');
  fs.appendFileSync(peer, 'Cooperative accepted update.\n');
  const before = fs.readFileSync(peer, 'utf8');
  const error = refused(f.okfPropose(['--plan', '--slug', 'directory']), 'E_UNSUPPORTED');
  assert.match(error.message, /Git base|reviewed change/);
  assert.equal(fs.existsSync(join(f.home, 'proposals')) && fs.readdirSync(join(f.home, 'proposals')).some(n => !n.startsWith('.')), false, 'no proposal kept');
  for (const command of ['complete', 'retry', 'run-source']) {
    const r = f.raw(['okf', command, '--soul', 'source', '--json']);
    assert.equal(r.status, 1); assert.equal(JSON.parse(r.stdout).error.code, 'E_REMOVED');
  }
  assert.equal(fs.readFileSync(peer, 'utf8'), before);
  assert.equal(fs.existsSync(join(f.accepted, 'expert/decision.md')), false);
  f.retire(f.source.instance);
});
