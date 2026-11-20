// #1879 acceptance 5 (fail closed above the bound, Pepe's condition 1): for each surface that stays on while
// the accepted CLI is above the Desktop's tested bound, a CLI one minor above that answers in a shape the
// Desktop does not know is reported refused or unknown, never success, and no second command runs.
//
// Each surface through its own boundary, as the backend runs it, with the CLI's answer injected and every
// call counted: the Spawn preview and apply (packages/client/spawn-preview.mjs, spawn-apply.mjs), Start and
// Restart (packages/client/session-start.mjs), the colour, the background and the pin (server/instance-color.mjs,
// server/instance-background.mjs, server/instance-pin.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpawnPreviewBoundary, createSpawnPreviewFlights } from '../../client/spawn-preview.mjs';
import { createSpawnApplyBoundary } from '../../client/spawn-apply.mjs';
import { startInstance } from '../../client/session-start.mjs';
import { clientTerms } from '../../client/client-terms.mjs';
import { createInstanceColorBoundary, INSTANCE_COLOR_FEATURE } from '../server/instance-color.mjs';
import { createInstanceBackgroundBoundary, INSTANCE_BACKGROUND_FEATURE } from '../server/instance-background.mjs';
import { createInstancePinBoundary, INSTANCE_PIN_FEATURE } from '../server/instance-pin.mjs';
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
  target: { backend: 'tmux', session: 'oats-agents', window: 'dev-1', socket: '/tmp/oats-tmux' }, startedAt: '2026-11-11T22:00:00.000Z', restartCount: 0, reused: 'new', warnings: [] };
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
  ['a receipt whose target is empty', answered({ ...RECEIPT, target: {} })],
  ['a receipt whose target is of another format', answered({ ...RECEIPT, target: { jobId: 'queued-123' } })],
  ['a receipt on another backend', answered({ ...RECEIPT, backend: 'future', target: { ...RECEIPT.target, backend: 'future' } })],
  ['a receipt whose target is on another backend', answered({ ...RECEIPT, target: { ...RECEIPT.target, backend: 'future' } })],
  ['a receipt whose target has no socket', answered({ ...RECEIPT, target: { backend: 'tmux', session: 'oats-agents', window: 'dev-1' } })],
  ['a receipt that says how its session was found in a way it does not know', answered({ ...RECEIPT, reused: 'queued' })],
  ['a receipt whose reuse is a yes or a no', answered({ ...RECEIPT, reused: true })],
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
    // A new window, a retained pane, and an earlier start's adopted launch (lib/core.mjs reused), with a target
    // carrying more than the four keys.
    for (const result of [RECEIPT, { ...RECEIPT, restartCount: 3, reused: 'pane', warnings: ['a launch hook said so'], launchPrompts: { status: 'not-engaged' } },
      { ...RECEIPT, reused: 'adopted', target: { ...RECEIPT.target, windowId: '@3', paneId: '%7' } }]) {
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

// ── The colour, the background and the pin: an answer it does not know is not applied ────────────────────────────
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
  ['pin', createInstancePinBoundary, INSTANCE_PIN_FEATURE, { pinned: true },
    [{ instancePinApi: 2, instance: 'dev-1', home: recordRow.home, pinned: true, changed: true },
      { instancePinApi: 1, instance: 'dev-1', home: recordRow.home, pinned: 'yes', changed: true },
      { instancePinApi: 1, instance: 'dev-2', home: recordRow.home, pinned: true, changed: true }]],
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

// Session providers (spec C1): a row on one is started through its provider, and its receipt has no terminal target.
const BB_ROW = (running) => ({ ...row(running), backend: 'bb', tmux: null });
const BB_RECEIPT = { instance: 'dev-1', agent: 'dev', home: HOME, harness: 'claude', backend: 'bb', model: null, launchConfig: null, yolo: null,
  session: { provider: 'oats.bb', endpoint: { server: 'http://127.0.0.1:38886', projectId: 'proj_1', threadId: 'thr_x' } }, target: null,
  startedAt: '2026-11-11T22:00:00.000Z', restartCount: 0, reused: 'new', warnings: [] };
const { session: _session, ...NO_SESSION } = BB_RECEIPT;
// The same home on another machine: the row names its server, and the answer is relayed without the endpoint.
const FAR_HOME = '/srv/team/agents/dev/instances/dev-1';
const BB_FAR_ROW = (running) => ({ instance: 'dev-1', home: FAR_HOME, agentsRoot: '/srv/team/agents', server: 'build', addressable: true, running, backend: 'bb', tmux: null });
const BB_FAR_RECEIPT = { ...BB_RECEIPT, home: FAR_HOME, session: { provider: 'oats.bb' } };
const startOf = (of, restart, result, seen = []) => startInstance(above(START_CLI), of, {}, { restart, terms, verifyHome: () => HOME, localCwd: '/team',
  start: async (bin, args) => { seen.push(args); return answered(result); } });
for (const restart of [false, true]) {
  const verb = restart ? 'Restart' : 'Start';
  test(`above the bound, a ${verb} of a row on a session provider is reported started on the provider's receipt: on this machine with its endpoint, routed with the provider alone`, async () => {
    const { target: _none, ...noTarget } = BB_RECEIPT;
    for (const result of [BB_RECEIPT, noTarget, { ...BB_RECEIPT, restartCount: 2, warnings: ['a launch hook said so'] }]) {
      const seen = [];
      assert.deepEqual(await startOf(BB_ROW(restart), restart, result, seen), { ok: true, result });
      assert.equal(seen[0].server, undefined, 'a start on this machine');
    }
    const { target: _far, ...farNoTarget } = BB_FAR_RECEIPT;
    for (const result of [BB_FAR_RECEIPT, farNoTarget]) {
      const seen = [];
      assert.deepEqual(await startOf(BB_FAR_ROW(restart), restart, result, seen), { ok: true, result });
      assert.deepEqual([seen[0].server, seen[0].home, seen[0].workspaceDir], ['build', FAR_HOME, '/team'], 'the routed call: --server, from this machine\'s directory');
    }
  });
  test(`above the bound, a ${verb} whose home moved backend at the start is reported started on the receipt's own backend: a row read as tmux answered on a provider, a row read as a provider's answered on tmux or on another provider`, async () => {
    for (const [name, result, of] of [
      ['a provider receipt for a row read as tmux', BB_RECEIPT, row(restart)],
      ['a tmux receipt for a row read as a provider\'s', RECEIPT, BB_ROW(restart)],
      ['another provider\'s receipt', { ...BB_RECEIPT, backend: 'other', session: { provider: 'acme.other', endpoint: {} } }, BB_ROW(restart)],
      ['a routed provider receipt for a row read as tmux', BB_FAR_RECEIPT, { ...BB_FAR_ROW(restart), backend: 'tmux' }],
    ]) {
      assert.deepEqual(await startOf(of, restart, result), { ok: true, result }, name);
    }
  });
  test(`acceptance (fail closed): above the bound, a ${verb} answered with a provider receipt it does not know, or one that names no backend it knows, is not reported started`, async () => {
    for (const [name, result, of] of [
      ['a provider receipt with a terminal target', { ...BB_RECEIPT, target: RECEIPT.target }, BB_ROW(restart)],
      ['a tmux receipt with no target, for a provider row', { ...RECEIPT, target: null }, BB_ROW(restart)],
      ['a receipt that names no backend', (({ backend: _b, ...rest }) => rest)(BB_RECEIPT), BB_ROW(restart)],
      ['a receipt whose backend is no name', { ...BB_RECEIPT, backend: 'Not A Name' }, BB_ROW(restart)],
      ['a receipt whose backend is the reserved word', { ...BB_RECEIPT, backend: 'session-provider' }, BB_ROW(restart)],
      ['a receipt whose backend is empty', { ...BB_RECEIPT, backend: '' }, BB_ROW(restart)],
      ['a provider receipt with no session', NO_SESSION, BB_ROW(restart)],
      ['a provider receipt whose session names no provider', { ...BB_RECEIPT, session: { endpoint: {} } }, BB_ROW(restart)],
      ['a provider receipt whose endpoint is not an object', { ...BB_RECEIPT, session: { provider: 'oats.bb', endpoint: 'thr_x' } }, BB_ROW(restart)],
      ['a start on this machine answered without its endpoint (the routed shape)', { ...BB_RECEIPT, session: { provider: 'oats.bb' } }, BB_ROW(restart)],
      ['a provider receipt for another home', { ...BB_RECEIPT, home: '/another/agents/dev/instances/dev-1' }, BB_ROW(restart)],
      ['a routed start answered with an endpoint, which never leaves its host', { ...BB_FAR_RECEIPT, session: BB_RECEIPT.session }, BB_FAR_ROW(restart)],
      ['a routed start answered without the backend', (({ backend: _b, ...rest }) => rest)(BB_FAR_RECEIPT), BB_FAR_ROW(restart)],
      ['a routed start answered for another home', { ...BB_FAR_RECEIPT, home: HOME }, BB_FAR_ROW(restart)],
    ]) {
      const outcome = await startOf(of, restart, result);
      assert.deepEqual([outcome.ok, outcome.outcome], [false, 'uncertain'], name);
    }
  });
}
