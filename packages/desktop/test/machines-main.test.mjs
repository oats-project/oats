// #517: main's api proxy lets the machine commands report themselves: `server connect` may install OATS
// and clone on the host (the CLI allows 15 minutes, `aweb connect` 5), a check 60 s, each after a list read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shippedMainApi } from './helpers/shipped-main-api.mjs';
import { classifyApiRoute } from '../api-url.mjs';

function deadlines(path, opts) {
  const api = shippedMainApi({ window: '/d/first', advertised: new Set(['/d/first']), served: [{ id: '/d/first' }] });
  const seen = []; api.context.AbortSignal = { timeout: ms => { seen.push(ms); return null; } };
  return api.call(path, opts).then(() => seen);
}

test('the machine routes are classified (aliases normalize like every other route)', () => {
  assert.equal(classifyApiRoute('/api/server-connect?ws=x'), 'machine-connect');
  assert.equal(classifyApiRoute('/api/./server-connect'), 'machine-connect');
  for (const p of ['/api/server-check', '/api/server-remove', '/api/servers?ws=x']) assert.equal(classifyApiRoute(p), 'machines', p);
});

test('connect waits past the CLI\'s 15 minutes (plus its list read); check, remove and the list past a check and a list read', async () => {
  const [connect] = await deadlines('/api/server-connect?ws=%2Fd%2Ffirst', { method: 'POST', body: '{"phase":"connect"}' });
  assert.ok(connect > 15 * 60_000 + 60_000, `connect ${connect}`);
  for (const path of ['/api/server-check?ws=%2Fd%2Ffirst', '/api/server-remove?ws=%2Fd%2Ffirst']) {
    const [ms] = await deadlines(path, { method: 'POST', body: '{}' });
    assert.ok(ms > 60_000 + 60_000, `${path} ${ms}`);
  }
  const [list] = await deadlines('/api/servers?ws=%2Fd%2Ffirst', { method: 'GET' });
  assert.ok(list > 60_000, `list ${list}`);
});
