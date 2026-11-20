// Main's api proxy lets a Retry's roster read report itself (#1117): POST /api/remote-roster/refresh answers once
// the server's `oats server roster --json` has landed, and the CLI adapter gives that call its own limit. A
// proxy that gave up at its ordinary 20 s would fail the Retry while a probe still had time to answer. The
// proxy's deadline is held to that limit here, read from the call itself, so the two cannot drift apart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shippedMainApi } from './helpers/shipped-main-api.mjs';
import { classifyApiRoute } from '../api-url.mjs';
import { cliRemoteRoster } from '../../client/cli-adapter.mjs';

const REFRESH = '/api/remote-roster/refresh';

/** The limit the roster's CLI call really runs under: what `cliRemoteRoster` hands its exec, called as the
 * server calls it (no deadline of its own). Read from the call, never copied here. */
async function cliLimit() {
  let limit;
  await cliRemoteRoster('/installed/oats', { exec: (_bin, _argv, opts, done) => { limit = opts.timeout; done(null, '{"schemaVersion":1,"ok":true,"result":{"groups":[]}}'); } });
  assert.ok(Number.isSafeInteger(limit) && limit > 0, `the CLI call's limit: ${limit}`);
  return limit;
}

/** Main's shipped handler over a backend that answers `reply` after `afterMs`: the proxy's own deadline
 * decides whether the answer arrives, as AbortSignal.timeout does. `seen` holds each request's deadline. */
function slowBackend(reply, afterMs) {
  const api = shippedMainApi({ window: '/d/first', advertised: new Set(['/d/first']), served: [{ id: '/d/first' }] });
  const seen = [];
  api.context.AbortSignal = { timeout: ms => { seen.push(ms); return { ms }; } };
  api.context.backendFetch = async (path, init) => {
    assert.ok(typeof path === 'string' && path.startsWith('/api/'), `backendFetch takes a path: ${path}`);
    if (init.signal.ms <= afterMs) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    return { ok: reply.status < 400, status: reply.status, text: async () => JSON.stringify(reply.body) };
  };
  return { call: (path, opts = { method: 'POST', body: '{}' }) => api.call(path, opts).then(r => JSON.parse(JSON.stringify(r))), seen };
}

test('the refresh is classified, by its exact path (aliases normalize like every other route)', () => {
  for (const p of [REFRESH, `${REFRESH}?ws=x`, '/api/./remote-roster/refresh', '/api/x/../remote-roster/refresh']) assert.equal(classifyApiRoute(p), 'remote-roster', p);
  for (const p of ['/api/remote-roster', '/api/remote-roster/refresh/', '/api/remote-roster/refreshx', '/api/remote-roster/refresh/x']) assert.notEqual(classifyApiRoute(p), 'remote-roster', p);
});

test('the proxy waits longer than the limit of the roster\'s CLI call, read from that call; an ordinary read keeps the ordinary deadline', async () => {
  const limit = await cliLimit();
  const backend = slowBackend({ status: 200, body: { refreshed: true } }, 0);
  await backend.call(REFRESH); await backend.call('/api/agents?ws=%2Fd%2Ffirst', { method: 'GET' });
  assert.ok(backend.seen[0] > limit, `the proxy's ${backend.seen[0]} ms must outlast the CLI call's ${limit} ms`);
  assert.equal(backend.seen[1], 20_000);
});

test('a refresh answered at the CLI call\'s limit reaches the renderer, not the proxy\'s abort', async () => {
  const limit = await cliLimit();
  assert.deepEqual(await slowBackend({ status: 200, body: { refreshed: true } }, limit).call(REFRESH), { ok: true, status: 200, body: { refreshed: true } });
});
