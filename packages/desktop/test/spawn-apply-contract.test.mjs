import test from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../../client/cli-locator.mjs';
import { cliSpawnPreview } from '../../client/spawn-preview-cli.mjs';
import { createSpawnPreview, createSpawnPreviewBoundary, createSpawnPreviewFlights } from '../../client/spawn-preview.mjs';
import { createSpawnApplyBoundary } from '../../client/spawn-apply.mjs';
import { previewData } from '../../client/spawn-preview-contract.mjs';
import { spawnDecision, spawnEffective, sameSpawnDecision } from '../../client/spawn-decision.mjs';
import { spawnApplySupported, spawnPrepareInput, spawnRefInput, spawnPreparedData, spawnWake, spawnApplyFailure } from '../../client/spawn-apply-contract.mjs';
import { cli, selector, target, anchor, data, kernel } from './helpers/spawn-preview-fixture.mjs';
const capable = () => structuredClone(cli); // the captured CLI advertises the whole apply fence
const strong = () => data(); // a v2 preview always carries its effective plan
const prepare = (changes = {}) => ({ action: 'prepare', selector, choices: {}, task: '', ...changes });
const ref = 'a'.repeat(64);
for (const spawnApplyApi of [undefined, null, false, true, 0, '1', 2, 1]) test(`locator passes only exact apply API 1 (${JSON.stringify(spawnApplyApi)})`, async () => {
  const found = await discover({ testedVersion: '0.69.17', persisted: () => cli.bin, env: {}, isExecutableFile: () => true }, async () => ({ stdout: JSON.stringify({ schemaVersion: 1, name: '@awebai/oats', version: '0.26.0', desktopApi: 1, spawnApplyApi, spawnPreviewApi: 2, features: capable().features }) }));
  assert.equal(found.spawnApplyApi, spawnApplyApi === 1 ? 1 : undefined);
  assert.equal(spawnApplySupported(found), spawnApplyApi === 1);
});
for (const [label, alter] of [
  ['preview API string', c => c.spawnPreviewApi = '2'], ['preview API old', c => c.spawnPreviewApi = 1], ['preview API future', c => c.spawnPreviewApi = 3],
  ['apply API absent', c => delete c.spawnApplyApi], ['apply API string', c => c.spawnApplyApi = '1'], ['apply API future', c => c.spawnApplyApi = 2],
  ...['spawn-preview-2', 'spawn-apply-2', 'spawn-idempotency-2'].map(feature => [feature, c => c.features = c.features.filter(f => f !== feature)]),
  ['invalid binary', c => c.bin = 'oats'], ['not compatible', c => c.ok = false], ['string features', c => c.features = 'spawn-preview-2,spawn-apply-2,spawn-idempotency'],
  ['old replay marker alone', c => c.features = c.features.map(f => f === 'spawn-idempotency-2' ? 'spawn-idempotency' : f)],
  ['mixed features', c => c.features.push({ feature: 'x' })], ['unbounded features', c => c.features.push(...Array(129).fill('x'))],
]) test(`confirmed apply refuses ${label} even with future version`, () => {
  const c = capable(); c.version = '9999.0.0'; alter(c); assert.equal(spawnApplySupported(c), false);
});
test('a preview without its effective plan is refused; a preview-only CLI cannot confirm', () => {
  const partial = data(); delete partial.decision.effective;
  assert.equal(previewData(partial, target), null); assert.equal(spawnPreparedData(partial, target), null);
  assert.equal(sameSpawnDecision(partial.decision, partial.decision), false);
  const readOnly = { ...capable(), features: capable().features.filter(f => f !== 'spawn-apply-2') };
  assert.equal(spawnApplySupported(readOnly), false); assert.ok(previewData(data(), target));
});
test('an effective Herdr backend (an older kernel decision) is not a spawn decision', () => {
  const v = strong(); v.decision.effective.backend = 'herdr';
  assert.equal(spawnEffective(v.decision.effective), null); assert.equal(previewData(v, target), null);
});
test('K6d projection preserves opaque full decision and refuses contradictory effective facts', () => {
  // The projected decision is the kernel's minus provider payloads (they stay kernel-side; the revision binds them).
  const v = strong(), projected = spawnDecision(v.decision, { effectiveRequired: true });
  assert.deepEqual(previewData(v, target).decision, projected); assert.equal(projected.revision, v.decision.revision); assert.equal(projected.resolution, v.decision.resolution);
  assert.equal(Object.hasOwn(projected.effective, 'providers'), false);
  assert.deepEqual(spawnPreparedData(v, target).decision, projected);
  const fields = { repo: '/elsewhere', work: 'checkout', runtime: 'codex', model: 'other', launchConfig: 'other', yolo: true, backend: 'herdr', childSpawns: false,
    relation: { kind: 'child', anchor: { instance: 'boss-1', agentsRoot: '/team/agents' } } };
  for (const [k, value] of Object.entries(fields)) {
    const bad = strong(); bad.decision.effective[k] = value;
    assert.equal(previewData(bad, target), null, k);
    assert.equal(sameSpawnDecision(v.decision, bad.decision), false, 'a copied revision cannot hide changed effective facts');
  }
  for (const effective of [null, {}, [], { ...v.decision.effective, childSpawns: 'true' }, { ...v.decision.effective, yolo: undefined },
    { ...v.decision.effective, relation: { kind: 'unrelated', anchor: null } }, { ...v.decision.effective, relation: { kind: 'child', anchor } }]) {
    // The last valid anchor has extra admitted selector fields, which projection drops.
    if (effective?.relation?.anchor === anchor) { assert.deepEqual(spawnEffective(effective).relation.anchor, { instance: anchor.instance, agentsRoot: anchor.agentsRoot }); continue; }
    const bad = strong(); bad.decision.effective = effective; assert.equal(previewData(bad, target), null);
  }
});
test('full decision is copied, optional producer extras dropped, every anchor kind stays qualified', () => {
  for (const kind of ['child', 'sibling', 'parent']) {
    const v = strong(); v.relation = kind; v.decision.effective.relation = { kind, anchor: { instance: 'boss-1', agentsRoot: '/team/agents', private: 'PRIVATE' } };
    v.decision.env = { SECRET: 'PRIVATE' }; v.decision.effective.recipe = 'PRIVATE'; v.task = 'PRIVATE';
    const projected = spawnPreparedData(v, target); assert.ok(projected); assert.doesNotMatch(JSON.stringify(projected), /PRIVATE/);
    v.decision.effective.relation.anchor.instance = 'different'; assert.equal(projected.decision.effective.relation.anchor.instance, 'boss-1');
    assert.equal(sameSpawnDecision(projected.decision, v.decision), false);
  }
  for (const bad of ['', '--bad', '../other', null]) { const v = strong(); v.decision.effective.relation = { kind: 'child', anchor: { instance: bad, agentsRoot: '/team/agents' } }; assert.equal(spawnDecision(v.decision), null); }
});
test('incomplete preflight remains a READ but not an executable confirmation', () => {
  const v = strong(); v.preflight.status = 'timeout'; assert.ok(previewData(v, target)); assert.equal(spawnPreparedData(v, target), null);
});
test('bounded prepare copies the whole draft including blank task and qualified options', () => {
  const input = prepare({ choices: { model: { kind: 'native-default' }, work: 'worktree', relation: { kind: 'child', anchor: { ...anchor } } },
    task: 'private\nopening instruction', wake: { cron: '0 * * * *', tz: 'UTC', message: 'private wake\nmessage', enabled: false } });
  const parsed = spawnPrepareInput(input); assert.ok(parsed);
  input.choices.relation.anchor.instance = 'different'; input.wake.message = 'changed'; input.task = 'changed';
  assert.equal(parsed.choices.relation.anchor.instance, anchor.instance); assert.equal(parsed.choices.work, 'worktree'); assert.equal(parsed.task, 'private\nopening instruction'); assert.equal(parsed.wake.message, 'private wake\nmessage');
  assert.equal(spawnPrepareInput(prepare({ task: undefined })).task, '');
  assert.equal(spawnPrepareInput(prepare()).task, '');
  assert.ok(spawnPrepareInput(prepare({ task: 'a'.repeat(32768) })));
  assert.equal(spawnPrepareInput(prepare({ task: '😀'.repeat(8193) })), null, 'UTF-8 bytes, not character count');
});
for (const changes of [
  { task: null }, { task: 7 }, { task: 'bad\0text' }, { task: 'a'.repeat(32769) }, { choices: { branch: '--no-launch' } },
  { choices: { model: { kind: 'custom', value: '@native-default' } } }, { choices: { env: {} } }, { expectDecision: 'a'.repeat(24) },
  { idempotencyKey: 'caller-key' }, { home: '/caller' }, { repo: '/caller' }, { wake: null }, { wake: { cron: '* * * * *', tz: 'UTC', message: 'x', file: '/caller' } },
]) test(`prepare refuses unapproved/malformed input: ${Object.keys(changes).join(',')}/${JSON.stringify(changes).slice(0, 75)}`, () => {
  assert.equal(spawnPrepareInput(prepare(changes)), null);
});
test('metadata and total request byte budgets are independently bounded', () => {
  const long = '/' + '界'.repeat(4095), input = prepare({ selector: { soul: 'dev', agentsRoot: long }, choices: { relation: { kind: 'child', anchor: { ...anchor, agentsRoot: long } } } });
  assert.equal(spawnPrepareInput(input), null, 'two individually bounded paths still exceed the 16KiB metadata budget');
  assert.equal(spawnPrepareInput(prepare({ task: '\n'.repeat(32768) })), null, 'JSON-escaped payload exceeds the 64KiB body budget');
});
test('wake is private structured input with byte bounds, never arbitrary file/argv authority', () => {
  const wake = { cron: '* * * * *', tz: 'UTC', message: 'x' };
  assert.deepEqual(spawnWake(wake), { ...wake, enabled: true });
  for (const changes of [{ cron: '' }, { tz: '\nUTC' }, { message: '' }, { message: '界'.repeat(2731) }, { enabled: 'yes' }, { args: [] }]) assert.equal(spawnWake({ ...wake, ...changes }), null);
});
test('apply/result accept only opaque ref, never a replacement key, decision or task', () => {
  for (const action of ['apply', 'result']) {
    assert.deepEqual(spawnRefInput({ action, spawnRef: ref }), { action, spawnRef: ref });
    for (const extra of ['task', 'wake', 'selector', 'choices', 'idempotencyKey', 'expectDecision', 'home']) assert.equal(spawnRefInput({ action, spawnRef: ref, [extra]: 'caller' }), null);
    for (const spawnRef of ['', '../home', 'a'.repeat(63), 'A'.repeat(64), null, { value: ref }]) assert.equal(spawnRefInput({ action, spawnRef }), null);
  }
  assert.equal(spawnRefInput({ action: 'retry', spawnRef: ref }), null, 'only the approved HTTP actions');
});
test('safe failures cannot leak producer text, instructions or caller paths', () => {
  const denied = spawnApplyFailure('PRIVATE', { status: 'unknown', spawnRef: ref, target });
  assert.equal(denied.reason.code, 'E_CLI_FAILED'); assert.equal(denied.status, 'unknown'); assert.equal(denied.spawnRef, ref);
  assert.equal(denied.preview, null); assert.equal(denied.receipt, null); assert.doesNotMatch(JSON.stringify(denied), /PRIVATE/);
  for (const code of ['E_DECISION_STALE', 'E_IDEMPOTENCY_CONFLICT', 'E_PLACEMENT_TAKEN', 'E_OUTCOME_UNKNOWN', 'E_APPLY_UNAVAILABLE', 'E_SPAWN_INCOMPLETE']) assert.equal(spawnApplyFailure(code).reason.code, code);
  const incomplete = spawnApplyFailure('E_SPAWN_INCOMPLETE', { status: 'incomplete', spawnRef: ref, target });
  assert.equal(incomplete.status, 'incomplete'); assert.equal(incomplete.receipt, null, 'incomplete is not a completed launch receipt');
});
test('kernel preview bytes cross the injected argv/boundary with the decision the apply binds', async () => {
  const stored = kernel('preview-worktree-purpose'), raw = stored.result, selected = { soul: raw.subject.soul, agentsRoot: raw.subject.agentsRoot };
  const c = { workspace: { id: 'northwind', scope: raw.subject.dir }, cli: capable(), agents: [{ name: selected.soul, agentsRoot: selected.agentsRoot, work: raw.work }] };
  let calls = 0;
  const read = createSpawnPreviewBoundary({ flights: createSpawnPreviewFlights(), invoke: (cli, args) => cliSpawnPreview(cli, args, { env: {}, exec: (_bin, argv, _options, callback) => {
    calls++; assert.ok(argv.includes('--preview')); assert.equal(argv.includes('--idempotency-key'), false); assert.equal(argv.includes('--expect-decision'), false);
    callback(null, JSON.stringify(stored));
  } }) });
  const response = await read({ action: 'preview', selector: selected, choices: { purpose: 'api-v2' } }, () => c);
  assert.equal(calls, 1); assert.equal(response.status, 'available');
  assert.equal(response.data.decision.revision, raw.decision.revision);
  assert.deepEqual(spawnPreparedData(response.data, response.target).decision, response.data.decision);
  assert.equal(kernel('apply-bound').result.decision.revision, raw.decision.revision, 'the captured apply bound this very decision');
});
test('a client\'s exec runs every read and apply, through the CLI callers: one call each; the apply carries detached, a read does not and keeps its 30 s deadline', async () => {
  const stored = kernel('preview-worktree-purpose'), raw = stored.result, selected = { soul: raw.subject.soul, agentsRoot: raw.subject.agentsRoot };
  const c = { workspace: { id: 'northwind', scope: raw.subject.dir }, cli: capable(), agents: [{ name: selected.soul, agentsRoot: selected.agentsRoot, work: raw.work }], instances: [] };
  const seen = [];
  const exec = (_bin, argv, options, callback) => {
    seen.push({ argv, options });
    callback(null, JSON.stringify(argv.includes('--preview') ? stored : kernel('apply-bound')));
    return { kill() {} }; // the child: what the apply's deadline signals
  };
  const preview = createSpawnPreview({ exec }), broker = createSpawnApplyBoundary({ read: preview.prepareRead, exec });
  const choices = { purpose: 'api-v2' };
  assert.equal((await preview.read({ action: 'preview', selector: selected, choices }, () => c)).status, 'available');
  assert.equal(seen.length, 1, 'the dialog\'s read');
  preview.cache.invalidate(); // prepare reads fresh: no held answer
  const prepared = await broker({ action: 'prepare', selector: selected, choices, task: '' }, () => c);
  assert.equal(prepared.status, 'prepared'); assert.equal(seen.length, 2, 'prepare\'s read');
  await broker({ action: 'apply', spawnRef: prepared.spawnRef }, () => c);
  assert.equal(seen.length, 3, 'the apply');
  assert.ok(seen[2].argv.includes('--idempotency-key') && !seen[2].argv.includes('--preview'));
  assert.equal(seen[2].options.detached, true, 'the apply is a change: a session of its own, whatever exec is given');
  for (const { argv, options } of seen.slice(0, 2)) {
    assert.ok(argv.includes('--preview'));
    assert.equal(Object.hasOwn(options, 'detached'), false, 'a read is a read: it ends with its caller');
    assert.equal(options.timeout, 30000);
  }
});
test('without an exec the callers are given no third argument; with one, exactly { exec }', async () => {
  const stored = kernel('preview-worktree-purpose'), raw = stored.result, selected = { soul: raw.subject.soul, agentsRoot: raw.subject.agentsRoot };
  const c = { workspace: { id: 'northwind', scope: raw.subject.dir }, cli: capable(), agents: [{ name: selected.soul, agentsRoot: selected.agentsRoot, work: raw.work }], instances: [] };
  const exec = () => assert.fail('the callers are doubles here');
  for (const given of [undefined, exec]) {
    const reads = [], applies = [];
    const preview = createSpawnPreview({ ...(given ? { exec: given } : {}), invoke: (...args) => { reads.push(args); return stored; } });
    const broker = createSpawnApplyBoundary({ read: preview.prepareRead, ...(given ? { exec: given } : {}), invoke: (...args) => { applies.push(args); return { started: false, envelope: { schemaVersion: 1, ok: false, error: { code: 'E_DECISION_STALE' } } }; } });
    await preview.read({ action: 'preview', selector: selected, choices: { purpose: 'api-v2' } }, () => c);
    preview.cache.invalidate();
    const prepared = await broker({ action: 'prepare', selector: selected, choices: { purpose: 'api-v2' }, task: '' }, () => c);
    assert.equal(prepared.status, 'prepared');
    await broker({ action: 'apply', spawnRef: prepared.spawnRef }, () => c);
    assert.equal(reads.length, 2); assert.equal(applies.length, 1);
    for (const args of [...reads, ...applies]) {
      if (given) { assert.equal(args.length, 3); assert.deepEqual(Object.keys(args[2]), ['exec']); assert.equal(args[2].exec, exec); }
      else assert.equal(args.length, 2, 'no exec: the caller\'s own default runs');
    }
  }
});
