// #517: a workspace's own machines — the shared contract (gates, defaults, validation, step rows).
import test from 'node:test';
import assert from 'node:assert/strict';
import { machinesGated, awebConnectGated, machineName, machineFieldProblem, connectOutcome,
  registerReached, stepCommands, STEP_LABELS, followBackfill } from '../../client/machine-contract.mjs';

const CLI = { ok: true, features: ['workspace-identity', 'servers-per-workspace', 'server-connect', 'capability-route'] };

test('gates: servers-per-workspace and server-connect from the probe; the aweb step also needs capability-route', () => {
  assert.equal(machinesGated(CLI), true);
  assert.equal(machinesGated({ ...CLI, features: ['servers-per-workspace'] }), false);
  assert.equal(machinesGated({ ...CLI, features: ['server-connect'] }), false);
  assert.equal(machinesGated({ ...CLI, ok: false }), false);
  assert.equal(machinesGated(null), false);
  assert.equal(awebConnectGated(CLI), true);
  assert.equal(awebConnectGated({ ...CLI, features: ['servers-per-workspace', 'server-connect'] }), false);
});

test('the Name default: <host>-<deployment dir basename> made a valid id (Folder has none, #1390)', () => {
  assert.equal(machineName('devbox', '/Users/alex/Agents/aweb'), 'devbox-aweb');
  assert.equal(machineName('Devbox.local', '/Users/alex/My Agents_v2'), 'devbox-local-my-agents-v2');
  assert.equal(machineName('', '/Users/alex/aweb'), '', 'no host yet: no name');
  assert.equal(machineName('a'.repeat(70), '/x/y'), 'a'.repeat(64), 'bounded to the id length');
});

test('field problems: the kernel\'s own rules (id, ssh host, a folder on the host)', () => {
  const ok = { id: 'devbox-aweb', host: 'devbox', folder: '~/aweb' };
  assert.equal(machineFieldProblem(ok), null);
  assert.equal(machineFieldProblem({ ...ok, folder: '/srv/aweb' }), null);
  assert.deepEqual(machineFieldProblem({ ...ok, host: '' }), { field: 'host', text: 'Type the machine\'s ssh host alias.' });
  assert.equal(machineFieldProblem({ ...ok, host: 'alex@devbox' }).field, 'host');
  assert.equal(machineFieldProblem({ ...ok, host: '-oProxyCommand=x' }).field, 'host');
  assert.equal(machineFieldProblem({ ...ok, id: 'Devbox' }).field, 'id');
  assert.equal(machineFieldProblem({ ...ok, id: '' }).field, 'id');
  assert.equal(machineFieldProblem({ ...ok, folder: 'aweb' }).field, 'folder');
  assert.deepEqual(machineFieldProblem({ ...ok, folder: '' }), { field: 'folder', text: 'The folder is a path on that machine, starting with / or ~/.' }, 'required: no default fills it');
  assert.equal(machineFieldProblem({ ...ok, folder: '~/a\nb' }).field, 'folder');
  assert.equal(machineFieldProblem({ ...ok, folder: '~/' + 'x'.repeat(1100) }).field, 'folder');
});

const STEPS = [
  { step: 'ssh', status: 'ok' },
  { step: 'oats', status: 'done', detail: 'installed @awebai/oats 0.39.0 (was missing)' },
  { step: 'git', status: 'needs-human', code: 'E_REMOTE_UNREADABLE', detail: 'devbox cannot read github.com/example/ac',
    remedy: 'On devbox run `gh auth login`, then `gh auth setup-git`.', hint: 'keychain-non-interactive' },
  { step: 'deployment', status: 'skipped', detail: 'waits for git' },
  { step: 'register', status: 'skipped' },
  { step: 'readiness', status: 'skipped' },
];

test('a connect result: its steps as the CLI sent them, ready and the registration', () => {
  const out = connectOutcome({ ok: true, result: { id: 'devbox-aweb', ready: false, registration: { sshHost: 'devbox' }, steps: STEPS, human: [] } });
  assert.equal(out.ok, true); assert.equal(out.ready, false); assert.equal(out.id, 'devbox-aweb');
  assert.deepEqual(out.steps, STEPS);
  assert.equal(out.error, null);
});

test('a failed connect: the steps so far (error.details.steps), then the failed step; ready is false', () => {
  const failed = { step: 'oats', status: 'failed', code: 'E_INSTALL', detail: 'npm exited 1' };
  const out = connectOutcome({ ok: false, error: { code: 'E_INSTALL', message: 'oats install failed', details: { steps: [STEPS[0], failed] } } });
  assert.equal(out.ok, false); assert.equal(out.ready, false);
  assert.deepEqual(out.steps, [STEPS[0], failed]);
  assert.deepEqual(out.error, { code: 'E_INSTALL', message: 'oats install failed' });
});

test('a refusal with no steps keeps its code and message; a shape the contract does not allow is dropped, never guessed', () => {
  assert.deepEqual(connectOutcome({ ok: false, error: { code: 'E_SERVER_WORKSPACE_MISMATCH', message: 'devbox reports another workspace' } }),
    { ok: false, ready: false, id: null, steps: [], error: { code: 'E_SERVER_WORKSPACE_MISMATCH', message: 'devbox reports another workspace' } });
  const odd = connectOutcome({ ok: true, result: { ready: true, steps: [{ step: 'ssh', status: 'weird' }, { step: 'oats' }, 'x', { step: 'git', status: 'ok', detail: 7 }] } });
  assert.deepEqual(odd.steps, [{ step: 'git', status: 'ok' }]);
  assert.equal(connectOutcome(null).ok, false);
});

test('register reached: its step ok or done', () => {
  assert.equal(registerReached(STEPS), false);
  assert.equal(registerReached([{ step: 'register', status: 'done' }]), true);
  assert.equal(registerReached([{ step: 'register', status: 'ok' }]), true);
  assert.equal(registerReached([{ step: 'register', status: 'needs-human' }]), false);
  assert.equal(registerReached([]), false);
});

test('step labels for every status, and the commands a remedy names (its backticked spans)', () => {
  assert.deepEqual(STEP_LABELS, { ok: 'ok', done: 'done', 'needs-human': 'needs you', skipped: 'waiting', failed: 'failed' });
  assert.deepEqual(stepCommands(STEPS[2].remedy), ['gh auth login', 'gh auth setup-git']);
  assert.deepEqual(stepCommands('Nothing to run.'), []);
  assert.deepEqual(stepCommands(undefined), []);
});

const manualTimers = () => { const q = []; return { q, setTimeout: fn => { q.push(fn); return q.length; }, clearTimeout: id => { q[id - 1] = null; }, run: async () => { const fn = q.shift(); await fn?.(); } }; };

test('followBackfill: reads again while backfilling, uses each answer, stops at the first settled one', async () => {
  const timers = manualTimers(), answers = [{ backfilling: true, n: 1 }, { n: 2 }], used = [];
  followBackfill({ read: async () => answers.shift(), use: a => used.push(a.n), timers });
  await timers.run(); await timers.run();
  assert.deepEqual(used, [1, 2]); assert.equal(timers.q.length, 0, 'no further read');
});

test('followBackfill: an owner that moved on uses nothing and stops; stop() cancels the pending read', async () => {
  let owned = true; const timers = manualTimers(), used = [];
  followBackfill({ read: async () => ({ backfilling: true }), use: () => used.push(1), owns: () => owned, timers });
  owned = false; await timers.run();
  assert.deepEqual(used, []); assert.equal(timers.q.length, 0);
  const t2 = manualTimers(); let reads = 0;
  const stop = followBackfill({ read: async () => { reads++; return { backfilling: true }; }, use: () => {}, timers: t2 });
  stop(); await t2.run(); assert.equal(reads, 0);
});

test('followBackfill: a backfill longer than any fixed budget is followed to its end, with the reads backing off to at most 15 s apart', async () => {
  const delays = [], q = [];
  const timers = { setTimeout: (fn, ms) => { delays.push(ms); q.push(fn); return q.length; }, clearTimeout: () => {} };
  let reads = 0; const used = [];
  // Eight unreachable hosts two at a time, then a reachable one: about five minutes of 60 s checks.
  followBackfill({ read: async () => (++reads < 200 ? { backfilling: true, n: reads } : { n: reads }), use: a => used.push(a.n), timers });
  while (q.length) await q.shift()();
  assert.equal(reads, 200); assert.equal(used.at(-1), 200, 'the settled answer is used');
  assert.equal(delays[0], 2000); assert.ok(delays[1] > delays[0]);
  assert.equal(Math.max(...delays), 15_000);
  assert.ok(delays.reduce((a, b) => a + b, 0) > 10 * 60_000, 'past any three-minute budget');
});

test('followBackfill: a failed read is retried; five in a row stop it', async () => {
  const timers = manualTimers(); let reads = 0; const used = [];
  followBackfill({ read: async () => { reads++; if (reads <= 2) throw new Error('down'); return reads === 3 ? { backfilling: true } : { n: 4 }; }, use: a => used.push(a.n ?? 'more'), timers });
  for (let i = 0; i < 6; i++) await timers.run();
  assert.equal(reads, 4); assert.deepEqual(used, ['more', 4]);
  const t2 = manualTimers(); let n = 0;
  followBackfill({ read: async () => { n++; throw new Error('gone'); }, use: () => {}, timers: t2 });
  for (let i = 0; i < 10; i++) await t2.run();
  assert.equal(n, 5);
});
