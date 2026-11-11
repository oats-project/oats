// oats.okf 5.0 and later: checkpoints are explicit proposals, not native-record
// capture; from 6.0 the instance proposes itself (`oats okf propose`) and no
// harvester starts. These cross the real public kernel CLI with the verified
// package mirror, always --no-launch. Native record transport is still covered independently
// by packages/record/test/home-capture-cli.test.mjs, including its >21 MB / 60
// turn piped-stdout regression; no record implementation/coverage is removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { fixture, write, readJSON } from './helpers/okf-v2.mjs';

const noCustody = f => {
  assert.equal(fs.existsSync(join(f.base, 'state/sources')), false, 'no registered-source state');
  assert.equal(fs.existsSync(join(f.home, '.okf-source.json')), false, 'no source marker');
};

test('a checkpoint starts no worker: the removed harvester\'s stub refuses through its required spawn hook, keeps no home, and the source\'s retire captures nothing', t => {
  const f = fixture(t);
  f.env.TURN_RECORD_ROOT = join(f.base, 'record'); f.env.TURN_RECORD_OWNER = 'fixture';
  const transcript = join(f.user, '.claude/projects/-fixture/session.jsonl');
  write(transcript, JSON.stringify({ type: 'assistant', cwd: f.home, sessionId: 'fixture', timestamp: '2026-09-13T12:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'DO_NOT_IMPORT_TRANSCRIPT' }] } }) + '\n');
  write(join(f.home, 'notes/lesson.md'), 'DO_NOT_AUTOCOPY_NOTE_BYTES\n');
  const file = f.proposal({ text: 'Preserve complete evidence when reviewing a bounded preview.' });
  const sourceBefore = fs.readFileSync(join(f.home, 'instance.json'));
  const harvesters = join(f.context, 'agents/oats-okf--knowledge-harvester/instances');
  for (const [name, relation] of [['okf-harvester-unrelated', ['--relation', 'unrelated']], ['okf-harvester-child', ['--parent', f.source.instance]]]) {
    const r = f.spawnHarvester({ file, relation, extra: ['--name', name] });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false); assert.equal(out.error.code, 'E_REQUIRED_HOOK_FAILED', 'a required spawn hook keeps its typed code');
    assert.deepEqual(out.error.details, { hooks: [{ capability: 'oats.okf-harvest', ok: false, required: true, log: null }] });
    assert.match(out.error.message, /oats\.okf-harvest spawn hook \(declared required\): oats-okf-harvest E_REMOVED: oats\.okf 6\.0 removed the knowledge harvester/);
    assert.match(out.error.message, /oats okf propose --plan/, 'the refusal names the fix');
    assert.doesNotMatch(r.stdout + r.stderr, /DO_NOT_IMPORT_TRANSCRIPT|DO_NOT_AUTOCOPY_NOTE_BYTES/);
    assert.equal(fs.existsSync(join(harvesters, name)), false, `${name}: no home kept`);
  }
  assert.deepEqual(fs.readFileSync(join(f.home, 'instance.json')), sourceBefore, 'the source record is untouched');
  assert.equal(fs.readFileSync(join(f.home, 'notes/lesson.md'), 'utf8'), 'DO_NOT_AUTOCOPY_NOTE_BYTES\n', 'notes stay the source\'s');
  noCustody(f);
  const retired = f.retire(f.source.instance);
  assert.equal(retired.removedDir, true);
  assert.equal(retired.capabilityMeta?.['oats.okf'], undefined, 'no retire capture hook or receipt');
  assert.equal(fs.existsSync(f.env.TURN_RECORD_ROOT), false, 'no record capture was invoked');
  // The kernel's own dot-directories there (rollback baselines) are not homes.
  assert.deepEqual(fs.existsSync(harvesters) ? fs.readdirSync(harvesters).filter(n => !n.startsWith('.')) : [], [], 'no harvester home exists');
});

test('each explicit checkpoint is a distinct proposal in the source\'s own home, not a shared worker or cursor; notes remain the source responsibility', t => {
  const f = fixture(t, { git: true }), note = join(f.home, 'notes/lesson.md');
  write(note, 'First observation.\n');
  const plan = slug => {
    const r = f.okfPropose(['--plan', '--slug', slug]);
    assert.equal(r.status, 0, JSON.stringify(r.out) + r.stderr); assert.equal(r.out.ok, true); return r.out.result;
  };
  const first = plan('first-checkpoint');
  const firstProposal = join(first.proposal, 'proposal.md');
  fs.writeFileSync(firstProposal, '# OKF proposal: first proposal and its rationale\n');
  write(note, 'Revised observation while another proposal is pending.\n');
  const second = plan('second-checkpoint');
  assert.notEqual(first.proposal, second.proposal);
  for (const p of [first.proposal, second.proposal]) assert.ok(p.startsWith(join(f.home, 'proposals') + '/'), 'each proposal is in the source home');
  assert.notEqual(first.bases[0].clone, second.bases[0].clone, 'each proposal has its own clone');
  assert.equal(fs.readFileSync(firstProposal, 'utf8'), '# OKF proposal: first proposal and its rationale\n', 'a later checkpoint cannot rewrite the first proposal');
  const again = f.okfPropose(['--plan', '--slug', 'first-checkpoint']);
  assert.equal(again.status, 1); assert.equal(again.out.error.code, 'E_PROPOSAL_EXISTS', 'a slug names one proposal');
  assert.equal(fs.readFileSync(note, 'utf8'), 'Revised observation while another proposal is pending.\n');
  const homes = fs.readdirSync(join(f.context, 'agents')).flatMap(agent => fs.existsSync(join(f.context, 'agents', agent, 'instances')) ? fs.readdirSync(join(f.context, 'agents', agent, 'instances')).filter(n => !n.startsWith('.')) : []);
  assert.deepEqual(homes, [f.source.instance], 'no worker instance was started');
  noCustody(f);
  f.retire(f.source.instance);
});

test('removed capture, completion and retry commands refuse without consuming notes or private legacy bytes', t => {
  const f = fixture(t), legacy = join(f.base, 'legacy-private.json'), note = join(f.home, 'notes/lesson.md');
  write(legacy, 'PRIVATE_LEGACY_BYTES'); write(note, 'Still the source observation.\n');
  for (const command of ['harvest', 'run-source', 'complete', 'retry', 'harvest-status']) {
    const r = f.raw(['okf', command, '--source', legacy, '--soul', 'source', '--json']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false); assert.equal(out.error.code, 'E_REMOVED');
    assert.equal(out.result, undefined); assert.doesNotMatch(r.stdout, /PRIVATE_LEGACY_BYTES/);
    assert.match(out.error.message, /proposal|propose/);
  }
  assert.equal(fs.readFileSync(legacy, 'utf8'), 'PRIVATE_LEGACY_BYTES');
  assert.equal(fs.readFileSync(note, 'utf8'), 'Still the source observation.\n');
  noCustody(f);
});

test('kernel forwards all explicit legacy host settings and their origins to the 5.0 guard; no worker runtime/model choice remains', t => {
  const f = fixture(t), original = fs.readFileSync(f.localFile, 'utf8');
  try {
    for (const key of ['harvest', 'harvest-runtime', 'harvest-model']) {
      const doc = YAML.parse(original); doc.settings['oats.okf'][key] = 'not-a-new-setting';
      write(f.localFile, YAML.stringify(doc));
      const r = f.raw(['okf', 'inspect', '--soul', 'source', '--json']), out = JSON.parse(r.stdout);
      assert.equal(r.status, 1); assert.equal(out.error.code, 'E_REMOVED');
      assert.ok(out.error.message.includes(`settings.oats.okf.${key} from host`));
      assert.match(out.error.message, /setup --remove-legacy-settings/);
      assert.doesNotMatch(out.error.message, /not-a-new-setting/, 'diagnostic names the key, not the private value');
    }
  } finally { write(f.localFile, original); }
  assert.deepEqual(f.inspect().owns, ['project/expert']);
  noCustody(f);
});

test('5.0 spawn rejects relative bindings and a missing owner declaration without bootstrapping soul knowledge', t => {
  const f = fixture(t, { spawnSource: false });
  const config = f.localFile, before = fs.readFileSync(config, 'utf8');
  assert.ok(before.includes(f.bindings)); write(config, before.replace(f.bindings, 'bindings.json'));
  let r = f.raw(['spawn', 'source', '--purpose', 'relative', '--no-launch', '--json']);
  assert.equal(r.status, 1); assert.equal(JSON.parse(r.stdout).error.code, 'E_REQUIRED_HOOK_FAILED', 'a required spawn hook keeps its typed code (0.49.0)');
  assert.deepEqual(JSON.parse(r.stdout).error.details, { hooks: [{ capability: 'oats.okf', ok: false, required: true, log: null }] });
  assert.match(JSON.parse(r.stdout).error.message, /absolute bindings-file/);
  write(config, before); f.fx.commit({ 'souls/source/okf.json': null }, 'drop owner declaration');
  r = f.raw(['spawn', 'source', '--purpose', 'ownerless', '--no-launch', '--json']);
  assert.equal(r.status, 1); assert.match(JSON.parse(r.stdout).error.message, /okf.json/);
  assert.equal(fs.existsSync(join(f.soul, 'knowledge')), false);
  for (const name of ['source-relative', 'source-ownerless']) assert.equal(fs.existsSync(join(f.context, 'agents/source/instances', name)), false);
});
