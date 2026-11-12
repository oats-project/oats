import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentStatusData } from '../../client/deployment-data.mjs';
import { EVENT_TITLES, eventsData } from '../renderer/instance-events-data.mjs';
import { target, event, data } from './helpers/instance-events-fixture.mjs';

test('lane:lab Desktop reader tolerates modules.<cap>.previous in recorded maps and drift rows', () => {
  const module = { from: { kind: 'package', package: 'acme.tools', version: '2.0.0', commit: 'b'.repeat(40) },
    commit: 'b'.repeat(40), digest: 'sha256-new', materializedAt: '2026-10-22T10:00:00.000Z' };
  const previous = { from: { kind: 'package', package: 'acme.tools', version: '1.0.0', commit: 'a'.repeat(40) },
    commit: 'a'.repeat(40), digest: 'sha256-old', materializedAt: '2026-10-21T10:00:00.000Z', receipt: 'move-1' };
  const document = modules => ({ root: '/deployment/agents', agents: [{ name: 'dev', dir: '/deployment/agents/dev',
    instances: [{ instance: 'dev-1', home: '/deployment/agents/dev/instances/dev-1', modules }] }] });
  for (const modules of [{ 'acme.tools': module }, [{ name: 'acme.tools', ...module, status: 'current', current: { version: '2.0.0', commit: module.commit } }]]) {
    const upgraded = structuredClone(modules);
    (Array.isArray(upgraded) ? upgraded[0] : upgraded['acme.tools']).previous = previous;
    assert.deepEqual(deploymentStatusData(document(upgraded), '/deployment'), deploymentStatusData(document(modules), '/deployment'));
  }
});

test('modules-upgraded has its Desktop label and remains a readable event row', () => {
  const upgraded = event({ kind: 'modules-upgraded', data: { receipt: 'move-1', modules: [{ capability: 'acme.tools', from: {}, to: {} }] } });
  assert.equal(EVENT_TITLES['modules-upgraded'], 'Modules upgraded');
  assert.equal(eventsData(data([upgraded]), target).events[0].kind, 'modules-upgraded');
});

test('upgrade-refused has its Desktop label and keeps its failed step and reported reason', () => {
  const refused = event({ kind: 'upgrade-refused', data: { step: 'hook acme.tools', reason: 'upgrade hook exited 1' } });
  assert.equal(EVENT_TITLES['upgrade-refused'], 'Module upgrade refused');
  const [row] = eventsData(data([refused]), target).events;
  assert.equal(row.kind, 'upgrade-refused');
  assert.deepEqual(row.data, { step: 'hook acme.tools', reason: 'upgrade hook exited 1' });
  // A malformed step drops only that fact, never the read.
  for (const step of [7, '', 'x'.repeat(4097)])
    assert.deepEqual(eventsData(data([event({ kind: 'upgrade-refused', data: { step, reason: 'r' } })]), target).events[0].data, { reason: 'r' });
});
