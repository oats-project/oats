import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeLiveness, livenessOrigin } from '../../client/liveness.mjs';
import { HERDR_REMOVED } from '../../client/terminal-contract.mjs';

const sessionTarget = { backend: 'herdr', protocol: 20, socket: '/memory/herdr.sock', paneId: 'w1:pA', terminalId: 'term_ABC' };
const kernelText = `E_HERDR_REMOVED: ${HERDR_REMOVED}`;
function reader() {
  const seen = [];
  return { seen, tmuxReader: (row) => { seen.push(row.instance); return { tmux: row.tmux, running: true, runtimeState: 'running' }; } };
}

test('a Herdr row is unsupported with the kernel runtimeError, and nothing probes it', () => {
  const r = reader();
  const [row] = observeLiveness([{ instance: 'h1', sessionTarget, runtimeState: 'unsupported', runtimeError: `${kernelText} (h1)` }], r);
  assert.deepEqual(row, { running: null, runtimeState: 'unsupported', runtimeError: `${kernelText} (h1)`, tmux: null });
  assert.deepEqual(r.seen, []);
});

test('an older kernel Herdr row (sessionTarget, no unsupported state) gets the interface stem, never its probe error', () => {
  const r = reader();
  const rows = observeLiveness([
    { instance: 'h1', sessionTarget },
    { instance: 'h2', sessionTarget, runtimeState: 'unreachable', runtimeError: 'spawn herdr ENOENT' },
    { instance: 'h3', runtimeState: 'unsupported' },
  ], r);
  for (const row of rows) assert.deepEqual(row, { running: null, runtimeState: 'unsupported', runtimeError: kernelText, tmux: null });
  assert.deepEqual(r.seen, []);
});

test('tmux rows are still observed through the tmux reader, next to a Herdr row', () => {
  const r = reader(), tmux = { session: 'oats-agents', window: 't1', socket: '/memory/tmux.sock' };
  const rows = observeLiveness([{ instance: 't1', tmux }, { instance: 'h1', sessionTarget }], r);
  assert.deepEqual(rows[0], { tmux, running: true, runtimeState: 'running' });
  assert.equal(rows[1].runtimeState, 'unsupported');
  assert.deepEqual(r.seen, ['t1']);
});

// A row the kernel answered as unknown stays unknown (#855, 1d): the probe refines only `running` true or false.
const unknownRow = (instance, extra = {}) => ({ instance, running: null, ...extra });

test('one row per kernel answer: true and false are probed, null is not and keeps the kernel\'s state and reason', () => {
  const r = reader(), tmux = { session: 'oats-agents', window: 'x', socket: '/memory/tmux.sock' };
  const rows = [
    { instance: 'yes', running: true, runtimeState: 'running', tmux },
    { instance: 'no', running: false, runtimeState: 'stopped', tmux },
    unknownRow('unreachable', { runtimeState: 'unreachable', runtimeError: 'error connecting to /memory/tmux.sock', tmux }),
    unknownRow('unsupported', { runtimeState: 'unsupported', runtimeError: `${kernelText} (unsupported)`, tmux }),
    unknownRow('a-later-state', { runtimeState: 'unidentified', runtimeError: 'E_UNIDENTIFIED_INSTANCE_HOME: instance.json cannot be read' }),
    unknownRow('no-state'),
  ];
  const answers = observeLiveness(rows, r);
  assert.deepEqual(r.seen, ['yes', 'no'], 'the reader was asked for the two rows the kernel answered, once each');
  assert.deepEqual(answers[0], { tmux, running: true, runtimeState: 'running' });
  assert.deepEqual(answers[1], { tmux, running: true, runtimeState: 'running' }, 'the probe\'s answer replaces the kernel\'s false');
  assert.deepEqual(answers[2], { running: null, runtimeState: 'unreachable', runtimeError: 'error connecting to /memory/tmux.sock' });
  assert.deepEqual(answers[3], { running: null, runtimeState: 'unsupported', runtimeError: `${kernelText} (unsupported)`, tmux: null }, 'unsupported is decided first, as before');
  assert.deepEqual(answers[4], { running: null, runtimeState: 'unidentified', runtimeError: 'E_UNIDENTIFIED_INSTANCE_HOME: instance.json cannot be read' }, 'a state name this client does not know is kept as it is');
  assert.deepEqual(answers[5], { running: null, runtimeState: 'unreachable' }, 'no state name reads unreachable, and no reason is invented');
  // No `tmux` key in a kept answer: the merged row keeps the kernel's own.
  for (const n of [2, 4, 5]) assert.equal(Object.hasOwn(answers[n], 'tmux'), false, rows[n].instance);
});

test('an unknown row\'s reason is cut at 300 characters as the other answers are, and left out when the row has none', () => {
  const r = reader(), long = 'x'.repeat(1000);
  const [cut, empty, absent, number] = observeLiveness([unknownRow('a', { runtimeState: 'unreachable', runtimeError: long }), unknownRow('b', { runtimeError: '' }),
    unknownRow('c', { runtimeError: null }), unknownRow('d', { runtimeError: 404 })], r);
  assert.equal(cut.runtimeError.length, 300);
  for (const answer of [empty, absent]) assert.deepEqual(answer, { running: null, runtimeState: 'unreachable' });
  assert.deepEqual(number, { running: null, runtimeState: 'unreachable', runtimeError: '404' });
  assert.deepEqual(r.seen, []);
});

test('an older kernel\'s Herdr row answered unknown and unreachable still reads unsupported, never its probe error', () => {
  const r = reader();
  const [row] = observeLiveness([unknownRow('h2', { sessionTarget, runtimeState: 'unreachable', runtimeError: 'spawn herdr ENOENT' })], r);
  assert.deepEqual(row, { running: null, runtimeState: 'unsupported', runtimeError: kernelText, tmux: null });
  assert.deepEqual(r.seen, []);
});

test('a row without a `running` key is probed, and so is one whose `running` is not null', () => {
  const r = reader();
  const rows = observeLiveness([{ instance: 'bare' }, { instance: 'undefined', running: undefined }, { instance: 'zero', running: 0 }, { instance: 'text', running: 'unknown' }], r);
  assert.deepEqual(r.seen, ['bare', 'undefined', 'zero', 'text']);
  for (const row of rows) assert.equal(row.running, true);
});

test('the rule that keeps a row unprobed: it is left only when the kernel answered `running: null`, and it leaves as null', () => {
  // Every kernel answer against every reader verdict: a row the reader was not asked about has `running: null`
  // in and out, and a row the kernel answered null never leaves as true or false, whatever the reader would say.
  const kernel = [true, false, null, undefined], states = [undefined, 'running', 'stopped', 'unreachable', 'unsupported', 'unidentified'];
  const targets = [{}, { tmux: { session: 's', window: 'w' } }, { tmux: null }, { sessionTarget }];
  const rows = kernel.flatMap(running => states.flatMap(runtimeState => targets.map((target, n) => ({
    instance: `${running}-${runtimeState}-${n}`, ...(running === undefined ? {} : { running }), ...(runtimeState ? { runtimeState } : {}), ...target }))));
  for (const verdict of [{ running: true, runtimeState: 'running' }, { running: false, runtimeState: 'stopped' }, { running: null, runtimeState: 'unreachable', runtimeError: 'no server' }]) {
    const seen = [], answers = observeLiveness(rows, { tmuxReader: row => { seen.push(row.instance); return { tmux: row.tmux, ...verdict }; } });
    assert.equal(answers.length, rows.length);
    rows.forEach((row, n) => {
      const herdr = row.sessionTarget !== undefined || row.runtimeState === 'unsupported';
      assert.equal(seen.includes(row.instance), !herdr && row.running !== null, `${row.instance}: probed exactly when the kernel answered and the session is one OATS has`);
      if (!seen.includes(row.instance)) assert.equal(answers[n].running, null, `${row.instance}: a row left unprobed is unknown`);
      if (!seen.includes(row.instance) && !herdr) assert.equal(row.running, null, `${row.instance}: left unprobed only because the kernel answered null`);
      if (row.running === null) assert.equal(answers[n].running, null, `${row.instance}: the kernel's unknown stays unknown`);
    });
  }
});

// Who makes the text of a row's answer (#982). The collector's answer crosses a process as JSON, so the
// speaker is decided by the reader of the answers from the row it sent (deployment-panel.mjs
// `livenessAnswers` asks `livenessOrigin`). That holds only while the two take the same order.
test('livenessOrigin and observeLiveness agree on every branch: the speaker named for a row is the place its text came from', () => {
  const PROBE = 'the terminal check\'s own words', KERNEL = 'the kernel\'s own words';
  const tmuxReader = () => ({ tmux: undefined, running: null, runtimeState: 'unreachable', runtimeError: PROBE });
  const each = (key, values) => values.map(value => (value === undefined ? {} : { [key]: value }));
  const rows = [null, 7, 'row', [], { running: null, runtimeError: KERNEL }, { instance: 7, running: null, runtimeError: KERNEL }];
  for (const running of each('running', [undefined, true, false, null])) for (const state of each('runtimeState', [undefined, 'unreachable', 'unsupported', 'stopped']))
    for (const text of each('runtimeError', [undefined, '', KERNEL, 5, null])) for (const target of each('sessionTarget', [undefined, null, sessionTarget]))
      for (const backend of each('backend', [undefined, 'tmux', 'herdr'])) rows.push({ instance: 'row', ...running, ...state, ...text, ...target, ...backend });
  const seen = { 'terminal-probe': 0, kernel: 0, none: 0 }, texts = new Set();
  for (const row of rows) {
    // As the collector is given it: through JSON.
    const [answer] = observeLiveness(JSON.parse(JSON.stringify([row])), { tmuxReader }), at = JSON.stringify(row);
    const said = answer.runtimeError;
    if (said === undefined) { assert.equal(Object.hasOwn(answer, 'runtimeError'), false, at); continue; }
    // Where the text came from, read from the text itself: each place writes one this test can tell apart.
    const from = said === PROBE || said === 'Invalid terminal target' ? 'terminal-probe' : said === kernelText ? null
      : said === String(row.runtimeError) && row.runtimeError ? 'kernel' : 'no place this test knows';
    assert.equal(livenessOrigin(row), from, at);
    seen[from ?? 'none']++; texts.add(said);
  }
  // Every branch was taken, and each place's text was met.
  assert.ok(seen['terminal-probe'] > 0 && seen.kernel > 0 && seen.none > 0, JSON.stringify(seen));
  assert.deepEqual([...texts].sort(), ['5', 'Invalid terminal target', KERNEL, PROBE, kernelText].sort());
});

test('livenessOrigin: the stand-in for a Herdr row of an older kernel has no speaker; the kernel\'s own reason is the kernel\'s', () => {
  assert.equal(livenessOrigin({ instance: 'h', sessionTarget }), null);
  assert.equal(livenessOrigin({ instance: 'h', sessionTarget, runtimeState: 'unreachable', runtimeError: 'spawn herdr ENOENT' }), null);
  assert.equal(livenessOrigin({ instance: 'h', runtimeState: 'unsupported' }), null);
  assert.equal(livenessOrigin({ instance: 'h', runtimeState: 'unsupported', runtimeError: '' }), null);
  assert.equal(livenessOrigin({ instance: 'h', runtimeState: 'unsupported', runtimeError: `${kernelText} (h)` }), 'kernel');
  // After the Herdr rule: a row the kernel answered unknown, then a probed one; a row that is no row is the check's.
  assert.equal(livenessOrigin({ instance: 't', running: null, runtimeError: 'no server' }), 'kernel');
  assert.equal(livenessOrigin({ instance: 't', running: true }), 'terminal-probe');
  assert.equal(livenessOrigin({ instance: 't' }), 'terminal-probe');
  assert.equal(livenessOrigin(undefined), 'terminal-probe');
});

// Session providers (spec C1): a row whose `backend` is a provider's name has no tmux target. It is never
// passed to the tmux reader, and its fields stay the kernel's.
test('A1: rows on a session provider are never passed to the tmux reader and keep the kernel\'s running and runtimeState', () => {
  const r = reader(), tmux = { session: 'oats-agents', window: 'c', socket: '/memory/tmux.sock' };
  const rows = observeLiveness([
    { instance: 'a', backend: 'bb', running: true, runtimeState: 'unknown' },
    { instance: 'b', backend: 'bb', running: false, runtimeState: 'stopped' },
    { instance: 'c', running: true, tmux },
  ], r);
  assert.deepEqual(r.seen, ['c']);
  assert.deepEqual(rows[0], { running: true, runtimeState: 'unknown' });
  assert.deepEqual(rows[1], { running: false, runtimeState: 'stopped' });
  assert.deepEqual(rows[2], { tmux, running: true, runtimeState: 'running' });
});

test('a provider row: unknown and unreachable stay the kernel\'s, with its text; no answer carries a tmux key; its text is the kernel\'s', () => {
  const r = reader();
  const sent = [
    { instance: 'a', backend: 'bb', running: null, runtimeState: 'unreachable', runtimeError: 'E_SESSION_UNAVAILABLE: bb did not answer' },
    { instance: 'b', backend: 'bb', running: null, runtimeState: 'unknown', tmux: null },
    { instance: 'c', backend: 'bb', running: null },
    { instance: 'd', backend: 'bb', running: 'yes', runtimeState: 'unknown' },
    { instance: 'e', backend: 'bb', running: true },
  ];
  assert.deepEqual(observeLiveness(sent, r), [
    { running: null, runtimeState: 'unreachable', runtimeError: 'E_SESSION_UNAVAILABLE: bb did not answer' },
    { running: null, runtimeState: 'unknown' },
    { running: null, runtimeState: 'unreachable' },
    { running: null, runtimeState: 'unknown' },
    { running: true },
  ]);
  assert.deepEqual(r.seen, []);
  for (const row of sent) assert.equal(livenessOrigin(row), 'kernel', row.instance);
});

test('which rows are a provider\'s: no backend, "tmux" and a value that is no provider name are probed as before; Herdr comes first', () => {
  const r = reader();
  const rows = observeLiveness([
    { instance: 't1', running: true },
    { instance: 't2', backend: 'tmux', running: false },
    { instance: 't3', backend: 'Not A Name', running: true },
    { instance: 't4', backend: '', running: true },
    { instance: 't5', backend: 7, running: true },
    { instance: 'h1', backend: 'herdr', running: true },
    { instance: 'h2', backend: 'bb', sessionTarget, running: true },
  ], r);
  assert.deepEqual(r.seen, ['t1', 't2', 't3', 't4', 't5']);
  for (const row of rows.slice(0, 5)) assert.deepEqual(row, { tmux: undefined, running: true, runtimeState: 'running' });
  for (const row of rows.slice(5)) assert.deepEqual(row, { running: null, runtimeState: 'unsupported', runtimeError: kernelText, tmux: null });
  assert.equal(livenessOrigin({ instance: 't2', backend: 'tmux', running: false }), 'terminal-probe');
});
