import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleDraft } from '../renderer/schedule-read-data.mjs';

// The local schedule editor's draft (moved from schedule-read-data.test.mjs when the old
// Schedules read path left, §3b): exact stored inputs, never an invented default or a
// stripped execution policy.
const entry = (extra = {}) => ({ id: 'nightly', scope: '/inert/ws', scheduleApi: 2, scheduleHistoryApi: 3, kind: 'spawn', agent: 'dev', agentsRoot: '/inert/ws/agents', repo: '/inert/ws',
  task: '  Full draft\r\nbytes  ', purpose: 'review', runtime: 'pi', model: 'model', backend: 'tmux', yolo: false, wake: { cron: '0 9 * * *', tz: 'UTC', message: '  Wake\r\nbytes  ' },
  cron: '0 9 * * *', tz: 'UTC', enabled: true, running: false, executionStatus: { kind: 'legacy' }, nextRun: '2026-02-02T09:00:00.000Z', lastRun: null,
  history: { status: 'ok', stored: 0, truncated: false }, recentRuns: [], ...extra });

test('a stored spawn definition drafts byte for byte', () => {
  assert.deepEqual(scheduleDraft(entry()), { id: 'nightly', kind: 'spawn', cron: '0 9 * * *', tz: 'UTC', enabled: true, agent: 'dev', agentsRoot: '/inert/ws/agents',
    task: '  Full draft\r\nbytes  ', repo: '/inert/ws', model: 'model', backend: 'tmux', purpose: 'review', harness: 'pi', yolo: false,
    wake: { cron: '0 9 * * *', tz: 'UTC', message: '  Wake\r\nbytes  ' } });
});

test('a description is retained exactly, including Unicode and boundary whitespace', () => {
  for (const description of ['  Harvest — dev  ', '🙂'.repeat(200)]) {
    assert.equal(scheduleDraft(entry({ description })).description, description);
  }
  for (const description of [null, 3, '', 'x'.repeat(201), 'line\nbreak', 'a\tb', 'a\u0085b', 'a\u2028b', 'a\u2029b']) {
    assert.equal(scheduleDraft(entry({ description })), null, JSON.stringify(description));
  }
});

for (const key of ['definitionVersion', 'recurrencePolicy', 'execution', 'preparation', 'executionBinding', 'responsibleHuman']) test(`${key} blocks an editable draft even when null`, () => {
  assert.equal(scheduleDraft(entry({ [key]: null })), null);
});

test('unpreservable inputs and the command kind get no invented default or stripped policy', () => {
  for (const v of [entry({ tz: undefined }), entry({ kind: 'command', argv: ['oats', 'status'] }), entry({ backend: 'future' }), entry({ backend: 'herdr' }), entry({ runtime: 'future' }),
    entry({ wake: { cron: '* * * * *', tz: 'UTC', message: 'wake', enabled: false } }), entry({ name: 'nightly', origin: { kind: 'local' } })]) assert.equal(scheduleDraft(v), null);
});

// Session providers (spec C1): a schedule's backend is kept when the kernel lists it.
test('a schedule whose backend is a provider the kernel lists is a draft, with its backend; an unlisted value is refused as before', () => {
  assert.equal(scheduleDraft(entry({ backend: 'bb' }), { backends: ['tmux', 'bb'] }).backend, 'bb');
  assert.equal(scheduleDraft(entry({ backend: 'tmux' }), { backends: ['tmux', 'bb'] }).backend, 'tmux');
  for (const backends of [undefined, ['tmux'], [], null, 'bb', ['tmux', 'other']]) assert.equal(scheduleDraft(entry({ backend: 'bb' }), backends === undefined ? undefined : { backends }), null, JSON.stringify(backends));
  assert.equal(scheduleDraft(entry({ backend: 'herdr' })), null);
  assert.equal(scheduleDraft(entry({ backend: 'tmux' }), { backends: ['bb'] }), null, 'a kernel that does not list tmux');
  // A schedule that names no backend is a draft whatever the list.
  const { backend: _none, ...plain } = entry();
  for (const backends of [['tmux'], [], ['bb']]) assert.equal(Object.hasOwn(scheduleDraft(plain, { backends }), 'backend'), false);
});
