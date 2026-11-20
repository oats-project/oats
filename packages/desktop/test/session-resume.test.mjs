// The machine sweep's reader (packages/client/session-resume.mjs): `oats session resume --json` read into one of
// four readings, and the trigger's settlement helpers. The answers are hand-written from the agreed kernel
// contract; their warnings and messages are examples, not the kernel's sentences.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readResumeSweep, sweepSettlement, sweepCompleted, RESUME_ANSWER_ENTRIES, RESUME_OUTCOMES, SKIPPED_REASONS,
  SETTLING_SKIPPED_REASONS } from '../../client/session-resume.mjs';
import { SWEEP_DEPLOYMENT as A, REFUSAL_REASONS, sweepAnswer as answer, sweepRow as row, sweepRefusal as refusal, sweepHome,
  resumedRow, freshRow, blockedRow, refusedRow, runningRow, skippedRow } from './helpers/resume-sweep.mjs';

const B = '/home/ana/work/team';
const ANSWERED = Object.freeze({ kind: 'answered' });

test('reader: a refusal reads as unsupported, busy or failed with its code', () => {
  assert.deepEqual(readResumeSweep(refusal('E_CLI_UNAVAILABLE')), { kind: 'unsupported' });
  assert.deepEqual(readResumeSweep(refusal('E_RESUME_FEATURE')), { kind: 'unsupported' });
  assert.deepEqual(readResumeSweep(refusal('E_RESUME_BUSY')), { kind: 'busy' });
  // A lock that needs a person is not a sweep that runs: it is a failure, with its code.
  assert.deepEqual(readResumeSweep(refusal('E_RESUME_LOCK_STUCK')), { kind: 'failed', code: 'E_RESUME_LOCK_STUCK' });
  assert.deepEqual(readResumeSweep(refusal('E_CLI_OUTPUT_LIMIT')), { kind: 'failed', code: 'E_CLI_OUTPUT_LIMIT' });
  assert.deepEqual(readResumeSweep(refusal('E_CLI_FAILED')), { kind: 'failed', code: 'E_CLI_FAILED' });
  // A code not of the kernel's form is never relayed.
  for (const code of ['e_lower', 'E_', 'E_BAD-CODE', `E_${'X'.repeat(65)}`, 'token=abc', 7, null, undefined]) {
    assert.deepEqual(readResumeSweep(refusal(code)), { kind: 'failed', code: 'E_CLI_PROTOCOL' }, String(code));
  }
  assert.deepEqual(readResumeSweep({ schemaVersion: 1, ok: false }), { kind: 'failed', code: 'E_CLI_PROTOCOL' });
  assert.deepEqual(readResumeSweep({ schemaVersion: 1, ok: false, error: 'E_RESUME_BUSY' }), { kind: 'failed', code: 'E_CLI_PROTOCOL' });
});

test('reader: an answer that is not the document is a protocol failure, never read in part', () => {
  const failed = { kind: 'failed', code: 'E_CLI_PROTOCOL' };
  const result = { schemaVersion: 1, plan: false, deployments: [], rows: [] };
  for (const bad of [null, undefined, 'x', [], {}, { ok: true }, { ok: 'true', result }]) assert.deepEqual(readResumeSweep(bad), failed);
  for (const r of [null, [], { ...result, schemaVersion: 2 }, { ...result, schemaVersion: undefined }, { ...result, plan: 'false' },
    { ...result, plan: undefined }, { ...result, rows: {} }, { ...result, rows: undefined }, { ...result, deployments: null },
    { ...result, rows: new Array(RESUME_ANSWER_ENTRIES + 1).fill(null) },
    { ...result, deployments: new Array(RESUME_ANSWER_ENTRIES + 1).fill(null) }]) {
    assert.deepEqual(readResumeSweep({ schemaVersion: 1, ok: true, result: r }), failed);
  }
  // At the bound it is read; extra keys of the kernel's are tolerated.
  assert.equal(readResumeSweep({ schemaVersion: 1, ok: true, result: { ...result, rows: new Array(RESUME_ANSWER_ENTRIES).fill(null), more: 1 } }).kind, 'answered');
});

test('reader: every answer that is the document reads answered, whatever its rows, deployments and warnings, a plan too', () => {
  const rows = [
    resumedRow('r1', { sessionId: 's', warnings: ['w'] }), freshRow('f1', { reason: 'no-conversation' }), freshRow('f2', { reason: 'later-reason' }),
    blockedRow('b1', { reason: 'resume-confirmation' }), blockedRow('b2', { reason: 'launch-prompt', code: 'E_SPAWN_INCOMPLETE' }),
    ...REFUSAL_REASONS.map((reason, i) => refusedRow(`x${i}`, { reason, code: 'E_RESUME_REFUSED', message: 'refused earlier' })),
    refusedRow('xb', { reason: 'nope', code: 'bad code' }), runningRow('a1'),
    ...Object.values(SKIPPED_REASONS).map((reason, i) => skippedRow(`s${i}`, { reason, code: 'E_X', message: 'm' })),
    row('u1', 'vanished'), row('u2', undefined), resumedRow('token=abc123secret'), resumedRow(''), null, 'x',
  ];
  const deployments = [{ deployment: A, state: 'ok', swept: true }, { deployment: B, state: 'ok', swept: false, reason: 'opted-out' },
    { deployment: '/srv/c', state: 'not-ok', swept: false, reason: 'not-ok' }, null, { deployment: 7, swept: false }];
  const answers = [
    answer(), answer(rows), answer([], deployments), answer(rows, deployments, { warnings: ['about this computer'] }),
    answer([runningRow('a')]), answer([skippedRow('c', { reason: SKIPPED_REASONS.notSeenRecently })]),
    answer([], [], { warnings: 'not a list' }),
    // A plan started nothing, and is answered all the same (sweepCompleted: it completes nothing).
    answer(rows, deployments, { plan: true }), answer([], [], { plan: true, warnings: ['w'] }),
  ];
  for (const envelope of answers) {
    const reading = readResumeSweep(envelope);
    assert.deepEqual(reading, ANSWERED, JSON.stringify(envelope).slice(0, 80));
    assert.deepEqual(Object.keys(reading), ['kind'], 'an answered reading has exactly the key kind');
  }
  for (const outcome of Object.values(RESUME_OUTCOMES)) assert.deepEqual(readResumeSweep(answer([row('r', outcome)])), ANSWERED, outcome);
});

test('the answer\'s outcome and skipped-reason names, pinned', () => {
  assert.deepEqual(RESUME_OUTCOMES, { resumed: 'resumed', fresh: 'fresh', blocked: 'blocked', refused: 'refused', alreadyRunning: 'already-running', skipped: 'skipped' });
  assert.deepEqual(SKIPPED_REASONS, { notLost: 'not-lost', notSeenRecently: 'not-seen-recently', startBusy: 'start-busy', unknown: 'unknown' });
  assert.deepEqual(SETTLING_SKIPPED_REASONS, ['not-lost', 'not-seen-recently']);
  for (const list of [RESUME_OUTCOMES, SKIPPED_REASONS, SETTLING_SKIPPED_REASONS]) assert.ok(Object.isFrozen(list));
});

test('sweepSettlement: refused (any reason) and skipped not-lost or not-seen-recently settle; started or running release; the rest neither', () => {
  const h = sweepHome;
  assert.deepEqual(sweepSettlement(answer([
    ...REFUSAL_REASONS.map((reason, i) => refusedRow(`x${i}`, { reason, code: 'E_X' })), refusedRow('xn'),
    ...SETTLING_SKIPPED_REASONS.map((reason, i) => skippedRow(`n${i}`, { reason })),
    resumedRow('r'), freshRow('f'), blockedRow('b'), runningRow('a'),
    skippedRow('sb', { reason: SKIPPED_REASONS.startBusy }), skippedRow('su', { reason: SKIPPED_REASONS.unknown }), skippedRow('s0'),
    row('v', 'vanished'), row('v2', undefined),
  ])), { settle: [h('x0'), h('x1'), h('x2'), h('xn'), h('n0'), h('n1')], release: [h('r'), h('f'), h('b'), h('a')] });
  // A home's last row decides; it is listed once, where its last row puts it.
  assert.deepEqual(sweepSettlement(answer([refusedRow('a'), resumedRow('b'), resumedRow('a'), refusedRow('b'), skippedRow('a', { reason: SKIPPED_REASONS.startBusy })])),
    { settle: [h('b')], release: [h('a')] });
  // Rows without a home to name, or not records, are ignored.
  assert.deepEqual(sweepSettlement(answer([null, 'row', [refusedRow('arr')], refusedRow('n7', { home: 7 }), refusedRow('ne', { home: '' }), refusedRow('nu', { home: undefined })])),
    { settle: [], release: [] });
  // Anything but an ok:true answer with a rows array: nothing.
  for (const envelope of [refusal('E_RESUME_BUSY'), { schemaVersion: 1, ok: true, result: { rows: 'x' } }, { ok: true }, { ok: true, result: [] }, null, 'text', undefined,
    { ok: 'true', result: { rows: [refusedRow('x')] } }, answer(new Array(RESUME_ANSWER_ENTRIES + 1).fill(refusedRow('x')))]) {
    assert.deepEqual(sweepSettlement(envelope), { settle: [], release: [] }, JSON.stringify(envelope)?.slice(0, 80));
  }
});

test('sweepSettlement reads only what readResumeSweep reads: a result that is not the document, or a plan, settles nothing', () => {
  const rows = [refusedRow('x', { reason: REFUSAL_REASONS[0], code: 'E_X' }), resumedRow('r')];
  assert.deepEqual(sweepSettlement(answer(rows)), { settle: [sweepHome('x')], release: [sweepHome('r')] });
  const not = [
    answer(rows, [], { schemaVersion: 2 }), answer(rows, null), answer(rows, [], { plan: 'no' }), answer(rows, [], { plan: undefined }),
    answer(rows, new Array(RESUME_ANSWER_ENTRIES + 1).fill({ deployment: A, swept: true })),
  ];
  for (const envelope of not) {
    assert.equal(readResumeSweep(envelope).kind, 'failed', 'the reader fails it');
    assert.deepEqual(sweepSettlement(envelope), { settle: [], release: [] });
  }
  const plan = answer(rows, [], { plan: true });
  assert.equal(readResumeSweep(plan).kind, 'answered', 'a plan started nothing');
  assert.deepEqual(sweepSettlement(plan), { settle: [], release: [] });
});

test('sweepCompleted: a sweep that ran (its answer the document, not a plan) read as answered; nothing else', () => {
  const done = (envelope) => sweepCompleted(envelope, readResumeSweep(envelope));
  assert.equal(done(answer([])), true);
  assert.equal(done(answer([resumedRow('a')])), true);
  assert.equal(done(answer([runningRow('a'), skippedRow('b', { reason: SKIPPED_REASONS.notLost })])), true);
  assert.equal(done(answer([resumedRow('a')], [], { plan: true })), false, 'a plan is read answered, but nothing ran');
  for (const envelope of [refusal('E_RESUME_BUSY'), refusal('E_SESSION_FAILED'), refusal('E_RESUME_FEATURE'), { ok: true },
    answer([], [], { schemaVersion: 2 }), answer([], null), null]) assert.equal(done(envelope), false, JSON.stringify(envelope)?.slice(0, 60));
  // The reading must say so too: a document with a reading that is not answered is not completed.
  for (const reading of [null, undefined, {}, 'answered', { kind: 'later' }, { kind: 'failed' }, { kind: 'busy' }, { kind: 'unsupported' }])
    assert.equal(sweepCompleted(answer([]), reading), false, JSON.stringify(reading));
});
