// #1879 acceptance 5 (fail closed above the bound, Pepe's condition 1): for each surface that stays on while
// the accepted CLI is above the Desktop's tested bound, a CLI one minor above that answers in a shape the
// Desktop does not know is reported refused or unknown, never success, and no second command runs.
//
// Each surface through its own boundary, as the backend runs it, with the CLI's answer injected and every
// call counted: the Spawn preview and apply (packages/client/spawn-preview.mjs, spawn-apply.mjs), Start and
// Restart (packages/client/session-start.mjs), the colour and the background (server/instance-color.mjs,
// server/instance-background.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpawnPreviewBoundary, createSpawnPreviewFlights } from '../../client/spawn-preview.mjs';
import { createSpawnApplyBoundary } from '../../client/spawn-apply.mjs';
import { startInstance } from '../../client/session-start.mjs';
import { clientTerms } from '../../client/client-terms.mjs';
import { createInstanceColorBoundary, INSTANCE_COLOR_FEATURE } from '../server/instance-color.mjs';
import { createInstanceBackgroundBoundary, INSTANCE_BACKGROUND_FEATURE } from '../server/instance-background.mjs';
import { context, request, data, envelope, selector, target } from './helpers/spawn-preview-fixture.mjs';
import { applyContext, applyPreview, creation } from './helpers/spawn-apply-fixture.mjs';

// One minor above a Desktop of 0.69.x: accepted, and marked so (cli-locator.mjs).
const above = (cli) => ({ ...cli, version: '0.70.1', aboveTested: true, testedThrough: '0.69' });

// ── Spawn preview: an answer it does not know offers no apply ─────────────────────────────────────────────
const UNKNOWN_PREVIEWS = [
  ['an unknown spawnPreviewApi', (v) => { v.spawnPreviewApi = 3; }],
  ['a decision with no revision', (v) => { delete v.decision.revision; }],
  ['a decision with no effective choices', (v) => { delete v.decision.effective; }],
  ['a decision for another home', (v) => { v.decision.home = '/other'; }],
];
for (const [name, alter] of UNKNOWN_PREVIEWS) {
  test(`acceptance (fail closed): above the bound, a Spawn preview with ${name} is not available, and offers no apply`, async () => {
    const answer = structuredClone(data()); alter(answer);
    let previews = 0;
    const ctx = context(); ctx.cli = above(ctx.cli);
    const preview = await createSpawnPreviewBoundary({ flights: createSpawnPreviewFlights(), invoke: async () => { previews++; return envelope(answer); } })(request(), () => ctx);
    assert.notEqual(preview.status, 'available');
    assert.equal(preview.data ?? null, null, 'no decision is offered');
    assert.equal(previews, 1, 'read once, never retried');
    // The apply's prepare reads that same preview: nothing to prepare, so no apply can be sent.
    const spawned = [];
    const broker = createSpawnApplyBoundary({ now: () => 0, mint: () => '1'.padStart(64, '0'), read: async () => preview,
      invoke: async (cli, args) => { spawned.push(args); return { started: true, envelope: envelope(creation(applyPreview(args.target))) }; } });
    const c = applyContext(); c.cli = above(c.cli);
    const prepared = await broker({ action: 'prepare', selector, choices: {}, task: 'x' }, () => c);
    assert.notEqual(prepared.status, 'prepared');
    assert.equal(prepared.spawnRef ?? null, null);
    assert.deepEqual(spawned, []);
  });
}

// ── Spawn apply: a stale decision is refused; an answer it does not know is an unknown outcome ───────────
function applyBroker(answer) {
  const calls = [];
  let ids = 0;
  const broker = createSpawnApplyBoundary({ now: () => 0, mint: () => (++ids).toString(16).padStart(64, '0'),
    read: async () => ({ status: 'available', data: applyPreview(target) }),
    invoke: async (cli, args) => { calls.push(args); return answer(args); } });
  const c = applyContext(); c.cli = above(c.cli);
  return { calls, send: (body) => broker(body, () => c) };
}

test('acceptance (fail closed): above the bound, a Spawn apply the kernel refuses as E_DECISION_STALE is refused, and sends nothing more', async () => {
  const f = applyBroker(() => ({ started: true, envelope: { schemaVersion: 1, ok: false, error: { code: 'E_DECISION_STALE', details: { decision: applyPreview(target).decision } } } }));
  const prepared = await f.send({ action: 'prepare', selector, choices: {}, task: 'x' });
  const applied = await f.send({ action: 'apply', spawnRef: prepared.spawnRef });
  assert.equal(applied.status, 'stale', 'refused: nothing was created, and the confirmation must be read again');
  assert.equal(applied.reason.code, 'E_DECISION_STALE');
  assert.equal(applied.receipt, null);
  await f.send({ action: 'apply', spawnRef: prepared.spawnRef });
  assert.equal(f.calls.length, 1, 'no second spawn');
});

for (const [name, answer] of [
  ['an envelope of another schema', () => ({ schemaVersion: 2, ok: true, result: {} })],
  // A receipt is read by the fields it names (spawn-apply-contract.mjs spawnCreationReceipt); one whose fields
  // are not those is not a creation.
  ['a receipt whose launch is not a yes or a no', (args) => ({ started: true, envelope: envelope(creation(applyPreview(args.target), { launched: 'unknown' })) })],
  ['a receipt with no decision', (args) => ({ started: true, envelope: envelope(creation(applyPreview(args.target), { decision: undefined })) })],
  ['a receipt for another home', (args) => ({ started: true, envelope: envelope(creation(applyPreview(args.target), { home: '/other' })) })],
  ['a success with no receipt', () => ({ started: true, envelope: { schemaVersion: 1, ok: true } })],
]) {
  test(`acceptance (fail closed): above the bound, a Spawn apply answered with ${name} is an unknown outcome, and sends nothing more`, async () => {
    const f = applyBroker((args) => { const a = answer(args); return a.started === undefined ? { started: true, envelope: a } : a; });
    const prepared = await f.send({ action: 'prepare', selector, choices: {}, task: 'x' });
    const applied = await f.send({ action: 'apply', spawnRef: prepared.spawnRef });
    assert.equal(applied.status, 'unknown');
    assert.equal(applied.receipt, null);
    await f.send({ action: 'result', spawnRef: prepared.spawnRef });
    assert.equal(f.calls.length, 1, 'no second spawn');
  });
}

// ── Start and Restart: an answer it does not know is not a start ──────────────────────────────────────────
const terms = clientTerms({ name: 'the test client', self: 'this test client', selfInitial: 'This test client', update: 'Update the test client.', thisMachine: 'This machine' });
const START_CLI = { ok: true, bin: '/installed/oats', features: ['session-start', 'session-restart', 'launch-config'], remote: ['session-start', 'session-restart'] };
const row = (running) => ({ instance: 'dev-1', home: '/team/agents/dev/instances/dev-1', agentsRoot: '/team/agents', running });
// A start's receipt as the kernel answers one (docs/desktop-cli-api.md, `oats session start`).
const HOME = '/team/agents/dev/instances/dev-1';
const RECEIPT = { instance: 'dev-1', agent: 'dev', home: HOME, harness: 'claude', backend: 'tmux', model: null, launchConfig: null, yolo: null,
  target: { socket: '/tmp/oats-tmux', session: 'oats-agents', window: 'dev-1' }, startedAt: '2026-11-11T22:00:00.000Z', restartCount: 0, reused: false, warnings: [] };
const answered = (result) => ({ schemaVersion: 1, ok: true, result });
const without = (key) => { const { [key]: _, ...rest } = RECEIPT; return rest; };
const UNKNOWN_STARTS = [
  ['a result of another shape', { schemaVersion: 1, ok: true, result: { launched: true } }],
  ['a result of another format that keeps the instance name', answered({ instance: 'dev-1', status: 'queued', jobId: 'future-format' })],
  ['a receipt for another home', answered({ ...RECEIPT, home: '/another/agents/dev/instances/dev-1' })],
  ['a receipt naming only the instance and its home', answered({ instance: 'dev-1', home: HOME })],
  ['a receipt with no start time', answered(without('startedAt'))],
  ['a receipt with no target', answered(without('target'))],
  ['a receipt whose warnings are not a list of strings', answered({ ...RECEIPT, warnings: [{ text: 'x' }] })],
  ['a result naming another instance', { schemaVersion: 1, ok: true, result: { instance: 'dev-2', home: '/team/agents/dev/instances/dev-2' } }],
  ['a result that is a list', { schemaVersion: 1, ok: true, result: [] }],
  ['no result', { schemaVersion: 1, ok: true }],
];
for (const restart of [false, true]) {
  const verb = restart ? 'Restart' : 'Start';
  for (const [name, answer] of UNKNOWN_STARTS) {
    test(`acceptance (fail closed): above the bound, a ${verb} answered with ${name} is not reported started, and runs nothing more`, async () => {
      const runs = [];
      const outcome = await startInstance(above(START_CLI), row(restart), {}, { restart, terms, verifyHome: () => true,
        start: async (bin, args) => { runs.push(args); return answer; } });
      assert.equal(outcome.ok, false);
      assert.equal(outcome.outcome, 'uncertain');
      assert.equal(runs.length, 1);
    });
  }
  test(`within the bound, a ${verb}'s answer is read as before`, async () => {
    const outcome = await startInstance(START_CLI, row(restart), {}, { restart, terms, verifyHome: () => true, start: async () => UNKNOWN_STARTS[0][1] });
    assert.deepEqual(outcome, { ok: true, result: { launched: true } });
  });
  test(`acceptance (fail closed): above the bound, a ${verb} answered with the receipt it knows is reported started`, async () => {
    for (const result of [RECEIPT, { ...RECEIPT, restartCount: 3, reused: true, warnings: ['a launch hook said so'], launchPrompts: { status: 'not-engaged' } }]) {
      const outcome = await startInstance(above(START_CLI), row(restart), {}, { restart, terms, verifyHome: () => HOME, start: async () => answered(result) });
      assert.deepEqual(outcome, { ok: true, result });
    }
  });
  test(`acceptance (fail closed): above the bound, a ${verb}'s receipt may name the verified home's real path`, async () => {
    const real = '/private/team/agents/dev/instances/dev-1';
    const outcome = await startInstance(above(START_CLI), row(restart), {}, { restart, terms, verifyHome: () => real, start: async () => answered({ ...RECEIPT, home: real }) });
    assert.equal(outcome.ok, true);
  });
}

// ── The colour and the background: an answer it does not know is not applied ────────────────────────────
const LOCAL = { id: 'team', scope: '/fixture/team' };
const recordRow = { instance: 'dev-1', home: '/fixture/team/agents/dev/instances/dev-1' };
const RECORDS = [
  ['colour', createInstanceColorBoundary, INSTANCE_COLOR_FEATURE, { color: 'sage' },
    [{ instanceColorApi: 2, instance: 'dev-1', home: recordRow.home, color: 'sage', changed: true },
      { instanceColorApi: 1, instance: 'dev-1', home: recordRow.home, color: 'sage' },
      { instanceColorApi: 1, instance: 'dev-2', home: recordRow.home, color: 'sage', changed: true }]],
  ['background', createInstanceBackgroundBoundary, INSTANCE_BACKGROUND_FEATURE, { background: true },
    [{ instanceBackgroundApi: 2, instance: 'dev-1', home: recordRow.home, background: true, changed: true },
      { instanceBackgroundApi: 1, instance: 'dev-1', home: recordRow.home, background: 'yes', changed: true },
      { instanceBackgroundApi: 1, instance: 'dev-2', home: recordRow.home, background: true, changed: true }]],
];
for (const [name, create, feature, write, unknowns] of RECORDS) {
  for (const result of [...unknowns, undefined]) {
    test(`acceptance (fail closed): above the bound, the ${name} answered with ${JSON.stringify(result ?? 'no result')} is not reported applied, and runs nothing more`, async () => {
      const calls = [];
      const request = create({ invoke: async (bin, args) => { calls.push(args); return { schemaVersion: 1, ok: true, ...(result ? { result } : {}) }; } });
      const cli = above({ ok: true, bin: '/fixture/oats', features: [feature] });
      const outcome = await request({ ...recordRow, ...write }, () => ({ workspace: LOCAL, cli, instances: [recordRow], localCwd: '/fixture/cwd' }));
      assert.equal(outcome.status, 'unknown', JSON.stringify(outcome));
      assert.equal(calls.length, 1);
    });
  }
}
