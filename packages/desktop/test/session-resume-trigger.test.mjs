// The shared resume trigger (packages/client/session-resume-trigger.mjs): when a client runs the machine sweep.
// A fake clock (`now`), a fake run whose answers are deferred promises the test settles, and a fake `cli`, sync or
// async. Answers and rows come from the shared builder (helpers/resume-sweep.mjs); what an answer settles is
// session-resume.mjs's (its own tests read every row). The reading is the real reader's unless a test gives `read`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createResumeTrigger, lostLocalHomes, localDeploymentIds, RESUME_MIN_INTERVAL_MS } from '../../client/session-resume-trigger.mjs';
import { readResumeSweep, SKIPPED_REASONS, SETTLING_SKIPPED_REASONS } from '../../client/session-resume.mjs';
import { SESSION_RESUME_FEATURE } from '../../client/session-resume-cli.mjs';
import { SESSION_ENDS } from '../../client/deployment-data.mjs';
import { RESUME_PROBE as PROBE, REFUSAL_REASONS, sweepHome as H, sweepAnswer as answer, sweepRefusal, sweepRow, lostInstance as lost, SWEEP_DEPLOYMENT,
  SWEEP_LOCAL, REMOTE_TAG, deploymentTag,
  resumedRow, freshRow, blockedRow, refusedRow, runningRow, skippedRow } from './helpers/resume-sweep.mjs';

const BUSY = sweepRefusal('E_RESUME_BUSY', 'another sweep runs');
const [START_REFUSED] = REFUSAL_REASONS;
const RELEASING = { resumed: resumedRow, fresh: freshRow, blocked: blockedRow, alreadyRunning: runningRow };
const deferred = () => { let resolve, reject; const promise = new Promise((y, n) => { resolve = y; reject = n; }); return { promise, resolve, reject }; };

/** A trigger over fakes. `h.runs` holds each run started (its probe and its deferred answer); `h.readings` each
 * reading given to onReading; `h.t` is the clock. `h.cli` is what cli() answers (a value or a function of none).
 * `h.trigger.observed(rows)` passes SWEEP_LOCAL as the read's local deployments unless options are given;
 * `h.raw` is the trigger itself. */
function harness(over = {}) {
  const h = { t: 0, runs: [], readings: [], cli: PROBE, cliCalls: 0 };
  const raw = h.raw = createResumeTrigger({
    cli: () => { h.cliCalls += 1; return typeof h.cli === 'function' ? h.cli() : h.cli; },
    run: (probe, ...rest) => { const d = deferred(); h.runs.push({ probe, rest, ...d }); return d.promise; },
    now: () => h.t,
    onReading: reading => h.readings.push(reading),
    ...over,
  });
  h.trigger = { ...raw, observed: (rows, options = { localDeploymentIds: SWEEP_LOCAL }) => raw.observed(rows, options) };
  /** Settle the latest run with `envelope` and wait for the sweep's promise. */
  h.answer = async (pending, envelope) => { h.runs.at(-1).resolve(envelope); await pending; };
  return h;
}
/** A lost home no read has shown yet: a sweep it starts settles it when the answer leaves it out, so a test
 * that starts several sweeps for other reasons starts each with a new one. */
let others = 0;
const another = () => lost(`other-${others++}`);
/** Launch and answer the launch sweep with `rows` (or an envelope). */
async function launched(h, rows = []) {
  const p = h.trigger.launch();
  await h.answer(p, Array.isArray(rows) ? answer(rows) : rows);
}
/** Whether a read showing `rows` at time `t` starts a sweep; one started is answered with `reply` rows. */
async function starts(h, t, rows, reply = []) {
  h.t = t;
  const before = h.runs.length, p = h.trigger.observed(rows);
  await new Promise(setImmediate);
  if (h.runs.length === before) { await p; return false; }
  await h.answer(p, answer(reply));
  return true;
}

test('lostLocalHomes: a lost, not running row of a local deployment, with an absolute home; each once, in order', () => {
  const L = SWEEP_LOCAL;
  assert.deepEqual(lostLocalHomes([lost('a'), lost('b', { running: null }), lost('c', { running: undefined }), lost('a')], L), [H('a'), H('b'), H('c')]);
  assert.deepEqual(lostLocalHomes([
    lost('remote', { deployment: REMOTE_TAG }), lost('untagged', { deployment: undefined }), lost('null-tag', { deployment: null }),
    lost('other-local', { deployment: deploymentTag('/elsewhere') }), lost('id-less', { deployment: { machine: 'x', path: SWEEP_DEPLOYMENT } }),
    lost('running', { running: true }),
    lost('stopped', { sessionEnd: SESSION_ENDS.stopped }), lost('exited', { sessionEnd: SESSION_ENDS.exited }), lost('LOST', { sessionEnd: 'LOST' }),
    lost('none', { sessionEnd: undefined }), lost('null', { sessionEnd: null }),
    lost('relative', { home: 'agents/dev/instances/x' }), lost('empty', { home: '' }), lost('number', { home: 7 }),
    lost('nul', { home: '/home/a\0b' }), lost('missing', { home: undefined }),
    null, 'row', [lost('array')], 7,
  ], L), []);
  // Locality is the deployment id alone: a row's own `server` or `remote` keys say nothing (the panel never sets them).
  assert.deepEqual(lostLocalHomes([lost('keyed', { server: 'devbox', remote: true })], L), [H('keyed')]);
  // The ids: any iterable of strings; missing, empty or not an iterable: no row is local.
  assert.deepEqual(lostLocalHomes([lost('a')], new Set(L)), [H('a')]);
  assert.deepEqual(lostLocalHomes([lost('a')], ['/x', 7, SWEEP_DEPLOYMENT]), [H('a')]);
  for (const ids of [undefined, null, [], new Set(), SWEEP_DEPLOYMENT, { [SWEEP_DEPLOYMENT]: true }, 7]) {
    assert.deepEqual(lostLocalHomes([lost('a')], ids), [], JSON.stringify(ids));
  }
  for (const notRows of [undefined, null, {}, 'rows', lost('a')]) assert.deepEqual(lostLocalHomes(notRows, L), []);
});

test('localDeploymentIds: a panel reply\'s deployments with local: true, in order; anything else, none', () => {
  const entry = (id, local) => ({ ...deploymentTag(id), label: id, local, reachable: true });
  assert.deepEqual(localDeploymentIds({ deployments: [entry('/a', true), entry('remote:devbox:a1', false), entry('/b', true), entry('/c', 'true'), null, { local: true }, { id: 7, local: true }] }), ['/a', '/b']);
  for (const panel of [undefined, null, {}, { deployments: 'x' }, { deployments: null }, []]) assert.deepEqual(localDeploymentIds(panel), []);
});

test('observed does nothing before launch; launch runs at once, with no floor, and a second launch is the same promise', async () => {
  const h = harness();
  const early = h.trigger.observed([lost('a')]);
  assert.equal(h.cliCalls, 0, 'not armed: the probe is not even asked');
  await early;
  assert.equal(h.runs.length, 0);
  const first = h.trigger.launch();
  assert.equal(h.trigger.launch(), first);
  assert.equal(h.runs.length, 1, 'one launch sweep, at time 0, with no lost row to see');
  assert.equal(h.runs[0].probe, PROBE);
  assert.deepEqual(h.runs[0].rest, [], 'nothing beside the probe: no signal, nothing to cancel it with');
  let settled = false; first.then(() => { settled = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false, 'launch settles only once its sweep is read');
  await h.answer(first, answer([resumedRow('a')]));
  assert.equal(h.readings.length, 1);
  assert.equal(h.readings[0].kind, 'answered');
  assert.equal(h.trigger.launch(), first);
  assert.equal(h.runs.length, 1);
});

test('single flight: a read while a sweep runs starts nothing; after it, the next read past the floor does', async () => {
  const h = harness();
  const p = h.trigger.launch();
  h.t = RESUME_MIN_INTERVAL_MS * 3;
  await h.trigger.observed([lost('a')]);
  assert.equal(h.runs.length, 1, 'the launch sweep is in flight');
  await h.answer(p, answer([]));
  assert.equal(await starts(h, h.t, [lost('a')]), true);
});

test('the floor counts from the start of the last sweep, not its end', async () => {
  const h = harness();
  const p = h.trigger.launch();
  h.t = 25_000;
  await h.answer(p, answer([]));
  assert.equal(await starts(h, RESUME_MIN_INTERVAL_MS - 1, [lost('a')]), false);
  assert.equal(await starts(h, RESUME_MIN_INTERVAL_MS, [lost('a')]), true, 'from the start at 0, not the end at 25 s');
  assert.equal(await starts(h, RESUME_MIN_INTERVAL_MS + 1, [lost('a')]), false, 'that sweep started at 30 s');
  assert.equal(await starts(h, 2 * RESUME_MIN_INTERVAL_MS, [lost('a')]), false, 'a: left unanswered by that sweep, settled');
  assert.equal(await starts(h, 2 * RESUME_MIN_INTERVAL_MS, [lost('b')]), true);
});

test('no lost local home, or only settled ones: nothing starts, whatever the time', async () => {
  const h = harness();
  await launched(h);
  for (const rows of [[], undefined, null, 'rows', [lost('a', { running: true })], [lost('r', { deployment: REMOTE_TAG })], [lost('u', { deployment: undefined })], [lost('s', { sessionEnd: SESSION_ENDS.stopped })]]) {
    assert.equal(await starts(h, 10 * RESUME_MIN_INTERVAL_MS, rows), false, JSON.stringify(rows));
  }
});

test('settled: refused and skipped not-lost settle; start-busy and unknown do not; the other outcomes release', async () => {
  const h = harness();
  let t = 0;
  const later = () => (t += RESUME_MIN_INTERVAL_MS);
  await launched(h, [
    refusedRow('x', { reason: START_REFUSED, code: 'E_START_REFUSED' }), skippedRow('n', { reason: SKIPPED_REASONS.notLost }),
    skippedRow('b', { reason: SKIPPED_REASONS.startBusy }), skippedRow('u', { reason: SKIPPED_REASONS.unknown }), skippedRow('o'),
  ]);
  assert.equal(await starts(h, later(), [lost('x'), lost('n')]), false, 'refused and not-lost are settled');
  for (const name of ['b', 'u', 'o']) assert.equal(await starts(h, later(), [lost('x'), lost(name)]), true, name);
  // Each releasing outcome, in a later answer, lets its home start a sweep again.
  for (const [outcome, rowOf] of Object.entries(RELEASING)) {
    const name = `s-${outcome}`;
    assert.equal(await starts(h, later(), [another()], [refusedRow(name, { code: 'E_X' })]), true);
    assert.equal(await starts(h, later(), [lost(name)]), false, `${name} settled`);
    assert.equal(await starts(h, later(), [another()], [rowOf(name)]), true);
    assert.equal(await starts(h, later(), [lost(name)]), true, `${outcome} released it`);
  }
  // A settled home with an unknown outcome or a start-busy row stays settled.
  assert.equal(await starts(h, later(), [another()], [skippedRow('x', { reason: SKIPPED_REASONS.startBusy }), sweepRow('x', 'vanished')]), true);
  assert.equal(await starts(h, later(), [lost('x')]), false);
  // A row that does not decode settles nothing and breaks nothing.
  assert.equal(await starts(h, later(), [another()], [null, 'row', refusedRow('y', { home: 7 }), refusedRow('y', { home: undefined })]), true);
  assert.equal(await starts(h, later(), [lost('x')]), false);
});

test('locality: without local deployment ids nothing is local, so nothing starts and nothing is released', async () => {
  const h = harness();
  await launched(h, [refusedRow('x', { code: 'E_X' })]);
  for (const options of [undefined, null, {}, { localDeploymentIds: [] }, { localDeploymentIds: null }, { localDeploymentIds: ['/elsewhere'] }]) {
    h.t += RESUME_MIN_INTERVAL_MS;
    const before = h.runs.length;
    void h.raw.observed([lost('a'), lost('x', { running: true })], options);
    await new Promise(setImmediate);
    assert.equal(h.runs.length, before, JSON.stringify(options));
  }
  // x was not released by those reads: still settled.
  assert.equal(await starts(h, h.t + RESUME_MIN_INTERVAL_MS, [lost('x')]), false);
});

test('locality: a remote deployment\'s lost row never starts a sweep, at any read past the floor', async () => {
  const h = harness();
  await launched(h);
  for (let i = 1; i <= 5; i++) {
    assert.equal(await starts(h, i * RESUME_MIN_INTERVAL_MS, [lost('far', { deployment: REMOTE_TAG }), lost('bare', { deployment: undefined })]), false);
  }
  assert.equal(h.runs.length, 1, 'the launch sweep only');
});

test('unanswered: a lost local home a completed sweep did not name settles; a running read releases it; lost again, it sweeps', async () => {
  const h = harness();
  await launched(h);
  // Its deployment is not ready, say: the answer names other homes, or none.
  assert.equal(await starts(h, RESUME_MIN_INTERVAL_MS, [lost('a')], [resumedRow('elsewhere')]), true);
  for (const t of [2, 3, 10]) assert.equal(await starts(h, t * RESUME_MIN_INTERVAL_MS, [lost('a')]), false, `settled at ${t}`);
  assert.equal(await starts(h, 11 * RESUME_MIN_INTERVAL_MS, [lost('a', { running: true })]), false);
  assert.equal(await starts(h, 11 * RESUME_MIN_INTERVAL_MS, [lost('a')], []), true, 'released, lost again: a sweep');
  assert.equal(await starts(h, 12 * RESUME_MIN_INTERVAL_MS, [lost('a')]), false, 'unanswered again: settled again');
  // An answer with no rows settles it too; the launch sweep has no snapshot.
  const q = harness();
  await launched(q, []);
  assert.equal(await starts(q, RESUME_MIN_INTERVAL_MS, [lost('b')], []), true, 'the launch sweep settled nothing extra');
  assert.equal(q.readings.at(-1).kind, 'answered');
  assert.equal(await starts(q, 2 * RESUME_MIN_INTERVAL_MS, [lost('b')]), false);
});

test('snapshot: every home an observed sweep was started for settles when it completes, busy or unknown included', async () => {
  const h = harness();
  await launched(h);
  assert.equal(await starts(h, RESUME_MIN_INTERVAL_MS, [lost('a'), lost('b')],
    [skippedRow('a', { reason: SKIPPED_REASONS.startBusy }), skippedRow('b', { reason: SKIPPED_REASONS.unknown })]), true);
  for (const t of [2, 3, 10]) assert.equal(await starts(h, t * RESUME_MIN_INTERVAL_MS, [lost('a'), lost('b')]), false, `settled at ${t}`);
  // A start-busy home loses nothing: the start under way shows it running, which releases it.
  assert.equal(await starts(h, 11 * RESUME_MIN_INTERVAL_MS, [lost('a', { running: true })]), false);
  assert.equal(await starts(h, 11 * RESUME_MIN_INTERVAL_MS, [lost('a')], [resumedRow('a')]), true, 'lost again after running: a sweep');
  // The answer still releases what it resumed: a, lost again at once, sweeps again.
  assert.equal(await starts(h, 12 * RESUME_MIN_INTERVAL_MS, [lost('a')]), true);
});

test('snapshot: the retry is bounded; a home the launch sweep answers unknown gets exactly one observed sweep, then none', async () => {
  const h = harness();
  await launched(h, [skippedRow('u', { reason: SKIPPED_REASONS.unknown })]);
  assert.equal(await starts(h, RESUME_MIN_INTERVAL_MS, [lost('u')], [skippedRow('u', { reason: SKIPPED_REASONS.unknown })]), true,
    'the launch sweep has no snapshot: one observed sweep follows');
  for (let i = 2; i <= 20; i++) assert.equal(await starts(h, i * RESUME_MIN_INTERVAL_MS, [lost('u')], [skippedRow('u', { reason: SKIPPED_REASONS.unknown })]), false, `none at ${i}`);
  assert.equal(h.runs.length, 2, 'the launch sweep and one observed sweep');
});

test('snapshot: a read that releases a snapshot home while its sweep runs is newer than the answer; the home is not settled', async () => {
  const h = harness();
  await launched(h);
  // x lost: a sweep starts (snapshot [x]); while it runs, a read shows x running (a human started it).
  h.t = RESUME_MIN_INTERVAL_MS;
  const p = h.trigger.observed([lost('x')]);
  await new Promise(setImmediate);
  assert.equal(h.runs.length, 2);
  h.t = 40_000;
  await h.trigger.observed([lost('x', { running: true })]);
  await h.answer(p, answer([]));
  assert.equal(h.readings.at(-1).kind, 'answered');
  // x is lost again: news, so the next read past the floor sweeps.
  assert.equal(await starts(h, 2 * RESUME_MIN_INTERVAL_MS, [lost('x')], [resumedRow('x')]), true);
  // The same when the answer itself refuses x, or a not-lost read released it: the newer read wins.
  for (const [i, release, reply] of [[3, lost('x', { sessionEnd: SESSION_ENDS.stopped }), [refusedRow('x', { code: 'E_X' })]],
    [5, lost('x', { running: true }), [skippedRow('x', { reason: SKIPPED_REASONS.notLost })]]]) {
    h.t = i * RESUME_MIN_INTERVAL_MS;
    const q = h.trigger.observed([lost('x')]);
    await new Promise(setImmediate);
    await h.trigger.observed([release]);
    await h.answer(q, answer(reply));
    assert.equal(await starts(h, (i + 1) * RESUME_MIN_INTERVAL_MS, [lost('x')], [resumedRow('x')]), true, JSON.stringify(reply));
  }
});

test('snapshot: a remote, untagged or other home\'s row while the sweep runs does not keep a snapshot home from settling', async () => {
  const h = harness();
  await launched(h);
  h.t = RESUME_MIN_INTERVAL_MS;
  const p = h.trigger.observed([lost('x')]);
  await new Promise(setImmediate);
  const running = { running: true };
  await h.trigger.observed([lost('x', { ...running, deployment: REMOTE_TAG }), lost('x', { ...running, deployment: undefined }), lost('y', running)]);
  await h.raw.observed([lost('x', running)]); // no local ids: nothing is local
  await h.answer(p, answer([]));
  assert.equal(await starts(h, 2 * RESUME_MIN_INTERVAL_MS, [lost('x')]), false, 'settled');
});

test('snapshot: a plan answer to an observed sweep is read answered, but nothing ran, so the snapshot does not settle', async () => {
  const h = harness();
  await launched(h);
  assert.equal(await starts(h, RESUME_MIN_INTERVAL_MS, [lost('x')]), true);
  // That sweep (answer []) settled x; use a new home for the plan.
  h.t = 2 * RESUME_MIN_INTERVAL_MS;
  const p = h.trigger.observed([lost('p')]);
  await new Promise(setImmediate);
  await h.answer(p, answer([refusedRow('p', { code: 'E_X' })], [], { plan: true }));
  assert.equal(h.readings.at(-1).kind, 'answered');
  assert.equal(await starts(h, 3 * RESUME_MIN_INTERVAL_MS, [lost('p')], [resumedRow('p')]), true, 'p stays news');
  assert.equal(h.runs.length, 4);
});

test('unanswered: a busy, failed or unsupported reading settles nothing of its snapshot', async () => {
  for (const envelope of [BUSY, sweepRefusal('E_SESSION_FAILED'), sweepRefusal('E_RESUME_FEATURE'), { ok: true }, null]) {
    const h = harness();
    await launched(h);
    assert.equal(await starts(h, RESUME_MIN_INTERVAL_MS, [lost('a')], []), true);
    // Answer the next one with `envelope`: it is not a completed sweep.
    h.t = 2 * RESUME_MIN_INTERVAL_MS;
    const before = h.runs.length;
    const p = h.trigger.observed([lost('c')]);
    await new Promise(setImmediate);
    assert.equal(h.runs.length, before + 1);
    await h.answer(p, envelope);
    assert.notEqual(h.readings.at(-1).kind, 'answered', JSON.stringify(envelope));
    assert.equal(await starts(h, 3 * RESUME_MIN_INTERVAL_MS, [lost('c')]), true, `c stays news after ${JSON.stringify(envelope)}`);
  }
  // A run that rejects (failed, E_CLI_FAILED) and no CLI (nothing ran) settle nothing either.
  const h = harness();
  await launched(h);
  h.t = RESUME_MIN_INTERVAL_MS;
  const p = h.trigger.observed([lost('d')]);
  await new Promise(setImmediate);
  h.runs.at(-1).reject(new Error('no'));
  await p;
  assert.equal(h.readings.at(-1).code, 'E_CLI_FAILED');
  h.cli = null;
  await h.trigger.observed([lost('d')]);
  h.cli = PROBE;
  assert.equal(await starts(h, 2 * RESUME_MIN_INTERVAL_MS, [lost('d')]), true, 'd stays news');
});

test('settled: a home skipped as not seen recently stays settled while its row reads lost; running releases it', async () => {
  const h = harness();
  const unseen = skippedRow('u', { reason: SKIPPED_REASONS.notSeenRecently });
  await launched(h, [unseen]);
  assert.ok(SETTLING_SKIPPED_REASONS.includes(SKIPPED_REASONS.notSeenRecently));
  assert.equal(await starts(h, RESUME_MIN_INTERVAL_MS - 1, [lost('u')]), false, 'within the floor');
  assert.equal(await starts(h, RESUME_MIN_INTERVAL_MS, [lost('u')]), false, 'after the floor: settled');
  assert.equal(await starts(h, 5 * RESUME_MIN_INTERVAL_MS, [lost('u')]), false, 'and later still');
  assert.equal(h.runs.length, 1);
  // The human starts it: the read shows it running, which releases it; the next lost read after the floor sweeps.
  assert.equal(await starts(h, 6 * RESUME_MIN_INTERVAL_MS, [lost('u', { running: true })]), false);
  assert.equal(await starts(h, 6 * RESUME_MIN_INTERVAL_MS, [lost('u')], [unseen]), true);
  assert.equal(await starts(h, 8 * RESUME_MIN_INTERVAL_MS, [lost('u')]), false, 'skipped again: settled again');
});

test('settled: a later read releases a local home that is no longer lost, or runs', async () => {
  const h = harness();
  let t = 0;
  const later = () => (t += RESUME_MIN_INTERVAL_MS);
  await launched(h, [refusedRow('a', { code: 'E_X' }), refusedRow('b', { code: 'E_X' }), skippedRow('c', { reason: SKIPPED_REASONS.notLost })]);
  assert.equal(await starts(h, later(), [lost('a'), lost('b'), lost('c')]), false);
  // The human started a: running. Its row is not lost now, so it starts nothing, but it is released.
  assert.equal(await starts(h, later(), [lost('a', { running: true })]), false);
  assert.equal(await starts(h, later(), [lost('a')], [refusedRow('a', { code: 'E_X' })]), true, 'a lost again: a sweep');
  // b's session ended another way, then was lost again.
  for (const end of [SESSION_ENDS.stopped, SESSION_ENDS.exited, undefined, null]) {
    assert.equal(await starts(h, later(), [lost('b', { sessionEnd: end })]), false);
    assert.equal(await starts(h, later(), [lost('b')], [refusedRow('b', { code: 'E_X' })]), true, String(end));
  }
  // A remote or untagged row, or one without an absolute home, releases nothing: it cannot speak for this machine's home.
  const stopped = { sessionEnd: SESSION_ENDS.stopped };
  assert.equal(await starts(h, later(), [lost('c', { ...stopped, deployment: REMOTE_TAG }), lost('c', { ...stopped, deployment: undefined }),
    lost('c', { ...stopped, home: 'relative' }), lost('c', { ...stopped, home: 7 })]), false);
  assert.equal(await starts(h, later(), [lost('c')]), false, 'still settled');
  // A release seen while a sweep runs still counts.
  const p = h.trigger.observed([lost('zz')]);
  h.trigger.observed([lost('c', { sessionEnd: SESSION_ENDS.stopped })]);
  await h.answer(p, answer([]));
  assert.equal(await starts(h, later(), [lost('c')]), true, 'released during the sweep');
});

test('an answer the reader fails, or a plan, settles nothing', async () => {
  const x = () => refusedRow('x', { reason: START_REFUSED, code: 'E_START_REFUSED' });
  for (const [bad, kind] of [[answer([x()], [], { schemaVersion: 2 }), 'failed'], [answer([x()], null), 'failed'],
    [answer([x()], [], { plan: true }), 'answered']]) {
    const h = harness();
    await launched(h, bad);
    assert.equal(h.readings[0].kind, kind);
    // x was not settled: its lost read at the floor sweeps.
    assert.equal(await starts(h, RESUME_MIN_INTERVAL_MS, [lost('x')], [x()]), true);
  }
});

const SCOPE = "the agent's harness runs in the OATS tmux server's cgroup, not a scope of its own: no user session";

test('read is given the run\'s envelope itself: the launch sweep\'s, a later one that repeats its refusal and host warning, and every other answer', async () => {
  const seen = [];
  const h = harness({ read: envelope => { seen.push(envelope); return readResumeSweep(envelope); } });
  const first = answer([refusedRow('x', { code: 'E_X' })], [], { warnings: [SCOPE] });
  await launched(h, first);
  assert.equal(seen[0], first, 'the same object');
  const second = answer([refusedRow('x', { code: 'E_X' }), resumedRow('r')], [], { warnings: [SCOPE] });
  const before = structuredClone(second), rows = second.result.rows;
  const p = (h.t = RESUME_MIN_INTERVAL_MS, h.trigger.observed([another()]));
  await h.answer(p, second);
  assert.equal(seen.at(-1), second, 'the same object, its repeated refusal and host warning in it');
  assert.deepEqual(second, before, 'the run\'s object is not mutated');
  assert.equal(second.result.rows, rows);
  assert.deepEqual(h.readings, [{ kind: 'answered' }, { kind: 'answered' }]);
  // An answer that is not ok:true, or has no rows array, reaches read as it came, and settles nothing.
  for (const envelope of [BUSY, { schemaVersion: 1, ok: true, result: { rows: 'x' } }, { ok: true }, null, 'text']) {
    h.t += RESUME_MIN_INTERVAL_MS;
    const q = h.trigger.observed([another()]);
    await h.answer(q, envelope);
    assert.equal(seen.at(-1), envelope);
  }
});

test('a refusal repeated in later sweeps settles its home each time; released and refused again, it is settled again', async () => {
  const h = harness();
  let t = 0;
  const later = () => (t += RESUME_MIN_INTERVAL_MS);
  const x = () => refusedRow('x', { reason: START_REFUSED, code: 'E_START_REFUSED' });
  await launched(h, [x()]);
  assert.equal(await starts(h, later(), [lost('x')]), false, 'settled by the launch sweep\'s refusal');
  // The same refusal in a sweep another home started: x is in no snapshot, and its repeat keeps it settled.
  assert.equal(await starts(h, later(), [another()], [x()]), true);
  assert.equal(await starts(h, later(), [lost('x')]), false, 'still settled');
  // A read shows x running: released, so its lost read sweeps; that sweep repeats the refusal: settled again.
  await h.trigger.observed([lost('x', { running: true })]);
  assert.equal(await starts(h, later(), [lost('x')], [x()]), true, 'released: a sweep');
  assert.equal(await starts(h, later(), [lost('x')]), false, 'refused again: settled');
  // Released by an answer that resumed it, then refused again in a sweep another home started: settled again.
  assert.equal(await starts(h, later(), [another()], [resumedRow('x')]), true);
  assert.equal(await starts(h, later(), [another()], [x()]), true);
  assert.equal(await starts(h, later(), [lost('x')]), false, 'the repeat after its release settles it');
  // And released by a read, refused again by a sweep another home started: settled again, by the refusal alone.
  await h.trigger.observed([lost('x', { sessionEnd: SESSION_ENDS.stopped })]);
  assert.equal(await starts(h, later(), [another()], [x()]), true);
  assert.equal(await starts(h, later(), [lost('x')]), false);
});

test('a sweep whose only rows are an earlier sweep\'s repeated refusal still completes: its snapshot settles', async () => {
  const h = harness();
  let t = 0;
  const later = () => (t += RESUME_MIN_INTERVAL_MS);
  const repeat = () => answer([refusedRow('x', { reason: START_REFUSED, code: 'E_START_REFUSED' })], [], { warnings: [SCOPE] });
  await launched(h, repeat());
  h.t = later();
  const p = h.trigger.observed([lost('a'), lost('b')]);
  await new Promise(setImmediate);
  assert.equal(h.runs.length, 2, 'a sweep started for a and b');
  await h.answer(p, repeat());
  assert.deepEqual(h.readings.at(-1), { kind: 'answered' });
  for (let i = 0; i < 3; i++) assert.equal(await starts(h, later(), [lost('a'), lost('b'), lost('x')]), false, `settled, ${i}`);
  assert.equal(h.runs.length, 2);
});

test('busy: read and handed on, it changes nothing, and the floor counts from its start', async () => {
  const h = harness();
  await launched(h, [refusedRow('x', { code: 'E_X' })]);
  const p = (h.t = RESUME_MIN_INTERVAL_MS, h.trigger.observed([lost('a')]));
  await h.answer(p, BUSY);
  assert.deepEqual(h.readings.at(-1), { kind: 'busy' });
  assert.equal(await starts(h, 2 * RESUME_MIN_INTERVAL_MS - 1, [lost('a')]), false);
  assert.equal(await starts(h, 2 * RESUME_MIN_INTERVAL_MS, [lost('x')]), false, 'x is still settled');
  assert.equal(await starts(h, 2 * RESUME_MIN_INTERVAL_MS, [lost('a')]), true);
});

test('every finished sweep is read: failed with its code, and a run that rejects reads as failed E_CLI_FAILED', async () => {
  const h = harness();
  const p = h.trigger.launch();
  h.runs[0].reject(new Error('boom'));
  await p;
  assert.deepEqual(h.readings, [{ kind: 'failed', code: 'E_CLI_FAILED' }]);
  assert.equal(await starts(h, RESUME_MIN_INTERVAL_MS - 1, [lost('a')]), false, 'it ran: the floor moved');
  const q = (h.t = RESUME_MIN_INTERVAL_MS, h.trigger.observed([lost('a')]));
  await h.answer(q, { schemaVersion: 1, ok: false, error: { code: 'E_CLI_OUTPUT_LIMIT' } });
  assert.deepEqual(h.readings.at(-1), { kind: 'failed', code: 'E_CLI_OUTPUT_LIMIT' });
  const r = (h.t = 2 * RESUME_MIN_INTERVAL_MS, h.trigger.observed([lost('a')]));
  await h.answer(r, { schemaVersion: 1, ok: false, error: { code: 'E_RESUME_FEATURE' } });
  assert.deepEqual(h.readings.at(-1), { kind: 'unsupported' });
});

test('dispose stops the trigger without cancelling: the sweep in flight runs on, and its reading is dropped', async () => {
  const h = harness();
  const p = h.trigger.launch();
  h.trigger.dispose();
  h.trigger.dispose();
  let settled = false; p.then(() => { settled = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false, 'the sweep still runs');
  await h.answer(p, answer([resumedRow('a')]));
  assert.deepEqual(h.readings, [], 'never onReading after dispose');
  h.t = 10 * RESUME_MIN_INTERVAL_MS;
  await h.trigger.observed([lost('b')]);
  assert.equal(h.trigger.launch(), p);
  assert.equal(h.runs.length, 1);
  // Disposed before launch: launch does nothing.
  const d = harness();
  d.trigger.dispose();
  await d.trigger.launch();
  await d.trigger.observed([lost('a')]);
  assert.deepEqual([d.runs.length, d.cliCalls, d.readings.length], [0, 0, 0]);
  // Disposed while the probe is asked: nothing is read.
  const c = harness(), gate = deferred();
  c.cli = () => gate.promise;
  const q = c.trigger.launch();
  c.trigger.dispose();
  gate.resolve(PROBE);
  await Promise.resolve(); await Promise.resolve();
  await c.answer(q, answer([resumedRow('a')]));
  assert.deepEqual(c.readings, []);
});

test('no CLI, or one without the feature: nothing runs, nothing is read, the floor stays and the slot is let go', async () => {
  for (const cli of [null, undefined, { ok: false, bin: '/oats', features: [SESSION_RESUME_FEATURE] }, { ok: true, bin: 'oats', features: [SESSION_RESUME_FEATURE] },
    { ok: true, bin: '/oats', features: [] }, { ok: true, bin: '/oats' }]) {
    const h = harness();
    h.cli = cli;
    await h.trigger.launch();
    assert.deepEqual([h.runs.length, h.readings.length, h.cliCalls], [0, 0, 1], JSON.stringify(cli));
    await h.trigger.observed([lost('a')]);
    assert.equal(h.cliCalls, 2, 'armed: the next read asks again, at once (no floor, the slot free)');
    // The CLI changes: followed at the next would-be start.
    h.cli = PROBE;
    assert.equal(await starts(h, 1, [lost('a')]), true);
  }
  // After a sweep that ran at 0, an unsupported answer at 30 s does not move the floor.
  const h = harness();
  await launched(h);
  h.cli = null;
  assert.equal(await starts(h, RESUME_MIN_INTERVAL_MS, [lost('a')]), false);
  h.cli = async () => PROBE;
  assert.equal(await starts(h, RESUME_MIN_INTERVAL_MS + 1, [lost('a')]), true, 'the floor still counts from 0');
});

test('cli() sync or async; the slot is held while it is asked', async () => {
  const sync = harness();
  sync.trigger.launch();
  assert.equal(sync.runs.length, 1);
  const gate = deferred(), h = harness();
  h.cli = () => gate.promise;
  const p = h.trigger.launch();
  h.t = 10 * RESUME_MIN_INTERVAL_MS;
  const other = h.trigger.observed([lost('a')]);
  await other;
  assert.equal(h.cliCalls, 1, 'a second read starts nothing while the probe is pending');
  gate.resolve(PROBE);
  await new Promise(setImmediate);
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].probe, PROBE);
  await h.answer(p, answer([]));
  assert.deepEqual(h.readings, [{ kind: 'answered' }]);
  // The floor counts from when the slot was taken (0), not from when the probe answered.
  assert.equal(await starts(h, RESUME_MIN_INTERVAL_MS, [lost('a')]), true);
});

test('never rejects: a cli() that throws or rejects reads as no CLI; a throwing onReading or read stays inside', async () => {
  const h = harness();
  h.cli = () => { throw new Error('probe'); };
  await h.trigger.launch();
  h.cli = () => Promise.reject(new Error('probe'));
  await h.trigger.observed([lost('a')]);
  assert.deepEqual([h.runs.length, h.readings.length], [0, 0]);
  const loud = harness({ onReading: () => { throw new Error('caller'); } });
  const p = loud.trigger.launch();
  await loud.answer(p, answer([]));
  const odd = harness({ read: () => { throw new Error('reader'); } });
  const q = odd.trigger.launch();
  await odd.answer(q, answer([]));
  assert.deepEqual(odd.readings, [{ kind: 'failed', code: 'E_CLI_PROTOCOL' }]);
  // No onReading at all is allowed.
  const quiet = harness({ onReading: undefined });
  const r = quiet.trigger.launch();
  await quiet.answer(r, answer([]));
});
