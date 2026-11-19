// The roster projection the Machines canvas read (active-observation.mjs, kept for the deployments' rows it validates,
// view-deployments.mjs): who made a row's text, a kept failure, and the address rule. The canvas itself became the Graph
// (views/graph.mjs, slice 6b), which reads the sidebar's roster: its tests are graph-slice6b.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectActivePanel, canAddressInstance } from '../renderer/active-observation.mjs';

const instance = (name = 'dev', fields = {}) => ({ instance: name, agent: 'soul', agentsRoot: '/team/agents', home: `/team/agents/soul/instances/${name}`, running: true, repoName: 'reported-repo', runtime: 'pi', branch: 'reported-branch', ...fields });
const panel = (instances = [instance()], id = '/team') => ({ instances, workspace: { id }, workspaces: [{ id: '/team', name: 'Team' }, { id: '/other', name: 'Other' }], generatedAt: 'observation-time' });

test('unnegotiated fields never become observations; a malformed address never falls back', () => {
  assert.equal(projectActivePanel(panel([instance('unknown', { running: 'true' })], '/team')).instances[0].running, null);
  const projected = projectActivePanel(panel([instance('dev', { task: 'secret-task-decoy', activity: 'waiting', git: { pr: 'secret-pr-decoy' } })])).instances[0];
  for (const key of ['task', 'activity', 'git']) assert.equal(Object.hasOwn(projected, key), false, key);
  assert.equal(canAddressInstance(instance('missing-route', { server: 'host' })), false);
  assert.equal(canAddressInstance(instance('bad-home', { home: 'relative-home' })), false, 'malformed primary home must not fall back to another root/name target');
});

test("the overview's projection keeps who made a row's text (#982): one of the three speakers, beside a text, and nothing else", () => {
  const row = fields => projectActivePanel(panel([instance('dev', { running: null, ...fields })], '/team')).instances[0];
  for (const origin of ['kernel', 'terminal-probe', 'roster-read']) {
    assert.equal(row({ runtimeError: 'the session did not answer', runtimeErrorOrigin: origin }).runtimeErrorOrigin, origin);
  }
  for (const origin of [undefined, null, '', 'server-probe', 'Kernel', true, 1, {}, ['kernel'], '__proto__', 'constructor']) {
    assert.equal(Object.hasOwn(row({ runtimeError: 'the session did not answer', runtimeErrorOrigin: origin }), 'runtimeErrorOrigin'), false, JSON.stringify(origin) ?? String(origin));
  }
  // A mark with no text beside it names nobody.
  for (const runtimeError of [undefined, null, '', 7, {}]) {
    assert.equal(Object.hasOwn(row({ runtimeError, runtimeErrorOrigin: 'kernel' }), 'runtimeErrorOrigin'), false, JSON.stringify(runtimeError) ?? String(runtimeError));
  }
});

test("the overview's projection keeps a kept failure as the shared home's rule reads it (#982): a string is a failure whatever it holds, and its speaker only the kernel", () => {
  const project = extra => projectActivePanel({ ...panel([instance('dev', { running: true })], '/team'), ...extra });
  for (const error of ['the cache is locked', '', '   ']) {
    const kept = project({ error, errorOrigin: 'kernel' });
    assert.deepEqual([kept.error, kept.errorOrigin, kept.instances[0].running], [error, 'kernel', null], JSON.stringify(error));
    const bare = project({ error });
    assert.deepEqual([bare.error, Object.hasOwn(bare, 'errorOrigin'), bare.instances[0].running], [error, false, null], JSON.stringify(error));
  }
  for (const errorOrigin of ['roster-read', 'terminal-probe', 'Kernel', true, 1, {}, ['kernel']]) assert.equal(Object.hasOwn(project({ error: 'm', errorOrigin }), 'errorOrigin'), false, JSON.stringify(errorOrigin));
  // No failure: null, no speaker, and the rows keep their reported state.
  for (const extra of [{}, { error: null }, { error: undefined, errorOrigin: 'kernel' }, { errorOrigin: 'kernel' }]) {
    const live = project(extra);
    assert.deepEqual([live.error, Object.hasOwn(live, 'errorOrigin'), live.instances[0].running], [null, false, true], JSON.stringify(extra));
  }
  assert.throws(() => project({ error: 7 }), /unreadable roster error/);
});
