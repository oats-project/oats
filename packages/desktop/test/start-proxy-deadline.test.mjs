// Main's api proxy lets a start or restart report itself: the kernel may watch a launch prompt for 30 s
// (lib/launch-prompts.mjs `LIMIT`, in 0.51.0 and at head 7dc5a20c of awebai/oats#917) and then answers what it kept, and
// the CLI adapter gives the call its own limit. A proxy that gave up at its ordinary 20 s would leave the
// dialog with a timeout where the kernel had an outcome to say (OATS 0.52.0, awebai/oats#917). The proxy's
// deadline is held to that limit here, read from the call itself, so the two cannot drift apart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shippedMainApi } from './helpers/shipped-main-api.mjs';
import { classifyApiRoute } from '../api-url.mjs';
import { cliStart } from '../../client/cli-adapter.mjs';
import { START_UNCONFIRMED } from '../renderer/start-unconfirmed.mjs';
import { httpError } from '../renderer/views/common.mjs';
import { retainedSpawnDetails } from '../../client/launch-prompt-outcome.mjs';
import { retained, differed, DIFFERED, observationTimeout, observationTimeoutMessage } from './helpers/launch-prompt-fixture.mjs';

const WS = '?ws=%2Fd%2Ffirst';
const KERNEL_WATCH_MS = 30_000;

/** How long the start's CLI call is waited for: the wait `cliStart` arms, called as the server's route calls it
 * (no wait of its own). The child itself has no deadline (#889): it is given none. Read from the call, never
 * copied here. */
async function cliLimit(restart) {
  let limit, deadline;
  await cliStart('/installed/oats', { home: '/d/first/agents/dev/instances/dev', workspaceDir: '/d/first', restart },
    { exec: (_bin, _argv, opts, done) => { deadline = opts.timeout; done(null, '{"schemaVersion":1,"ok":true,"result":{}}'); },
      after: (ms) => { limit = ms; return () => {}; } });
  assert.equal(deadline, 0, 'the start child is given no deadline: the wait ends, never the child');
  assert.ok(Number.isSafeInteger(limit) && limit > 0, `the wait for the CLI call: ${limit}`);
  return limit;
}
/** The deadline main's shipped handler gives one request. */
async function proxyDeadline(path, opts) {
  const backend = slowBackend({ status: 200, body: {} }, 0);
  await backend.call(path, opts);
  assert.equal(backend.seen.length, 1, path);
  return backend.seen[0];
}

/** Main's shipped handler over a backend that answers `reply` after `afterMs`: the proxy's own deadline
 * decides whether the answer arrives, as AbortSignal.timeout does. */
function slowBackend(reply, afterMs) {
  const api = shippedMainApi({ window: '/d/first', advertised: new Set(['/d/first']), served: [{ id: '/d/first' }] });
  const seen = [];
  api.context.AbortSignal = { timeout: ms => { seen.push(ms); return { ms }; } };
  api.context.backendFetch = async (path, init) => {
    assert.ok(typeof path === 'string' && path.startsWith('/api/'), `backendFetch takes a path: ${path}`);
    if (init.signal.ms <= afterMs) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    return { ok: reply.status < 400, status: reply.status, text: async () => JSON.stringify(reply.body) };
  };
  // The reply is made in the handler's own realm: it crosses to the renderer as structured data.
  return { call: (path, opts = { method: 'POST', body: '{}' }) => api.call(path, opts).then(r => JSON.parse(JSON.stringify(r))), seen };
}

test('a start and a restart are classified (aliases normalize like every other route)', () => {
  for (const p of ['/api/start/dev', '/api/restart/dev', '/api/start/dev?ws=x&home=%2Fh', '/api/./restart/accountant-minerva', '/api/x/../start/dev.1_a', '/api/start/Dev-2#x'])
    assert.equal(classifyApiRoute(p), 'instance-start', p);
});

/** Not a start: no instance, more than one segment, or a segment the server's route does not take. */
const NOT_A_START = [
  '/api/start', '/api/start/', '/api/restart', '/api/restart/',                       // no instance
  '/api/start/dev/', '/api/restart/dev/',                                              // a trailing slash
  '/api/start/dev/extra', '/api/restart/dev/x/y', '/api/start//dev', '/api/start/dev//', // a longer path, an empty segment
  '/api/start/a%2Fb', '/api/restart/dev%2F', '/api/start/%2Fdev', '/api/start/a%2fb',   // an encoded slash
  '/api/start/dev%20x', '/api/start/dev%00', '/api/start/dev;x', '/api/start/dev x', '/api/start/dév', '/api/start/dev\\x', // an odd segment
  '/api/start/.', '/api/start/..', '/api/start/%2e', '/api/start/%2e%2e/dev',          // dot segments
  '/api/START/dev', '/api/starts/dev', '/api/start-now/dev', '/api/retire/dev',        // another route
  '/api/session/start/dev', '/x/api/start/dev', '/api/start/dev/../..', 'api/start/dev/..',
];
test('the match is exact: no other path gets the class', () => {
  for (const p of NOT_A_START) assert.equal(classifyApiRoute(p), null, p);
});

test('the class is answered for exactly the paths the server routes as a start or a restart', () => {
  // The server's own route pattern, read from its source: the classifier must not drift from it.
  const source = readFileSync(new URL('../server/oats-web.mjs', import.meta.url), 'utf8');
  const literal = source.match(/const hm = path\.match\(\/(.+?)\/\);/)?.[1];
  assert.ok(literal, 'the server\'s instance route pattern');
  const routed = pathname => { const m = new URL(pathname, 'http://oats-backend.invalid').pathname.match(new RegExp(literal)); return !!m && (m[1] === 'start' || m[1] === 'restart'); };
  const table = [...NOT_A_START, '/api/start/dev', '/api/restart/dev', '/api/start/a.b_c-D9', '/api/restart/x', '/api/retire/dev', '/api/start/...', '/api/start/-'];
  for (const p of table) assert.equal(classifyApiRoute(p) === 'instance-start', routed(p), p);
  assert.ok(table.some(routed) && !table.every(routed));
});

test('the proxy waits longer than the limit of the start\'s CLI call, read from that call; an ordinary read keeps the ordinary deadline', async () => {
  for (const [kind, restart] of [['start', false], ['restart', true]]) {
    const limit = await cliLimit(restart), deadline = await proxyDeadline(`/api/${kind}/dev${WS}`);
    assert.ok(deadline > limit, `${kind}: the proxy's ${deadline} ms must outlast the CLI call's ${limit} ms`);
    // And the kernel's watch is inside the CLI call's limit, or there would be no outcome to wait for.
    assert.ok(limit > KERNEL_WATCH_MS, `${kind}: ${limit}`);
  }
  assert.equal(await proxyDeadline(`/api/agents${WS}`, { method: 'GET' }), 20_000);
});

test('a kept outcome the kernel answers after its 30 s reaches the renderer whole, for a start and a restart', async () => {
  const details = retained({ instance: 'dev', home: '/d/first/agents/dev/instances/dev' });
  details.launchPrompts = { ...details.launchPrompts, differed: differed() };
  const incomplete = retainedSpawnDetails(details);
  const body = { error: 'blocked: unexpected prompt; home and pane retained', code: 'E_SPAWN_INCOMPLETE', incomplete };
  for (const kind of ['start', 'restart']) {
    const path = `/api/${kind}/dev${WS}`;
    const reply = await slowBackend({ status: 409, body }, KERNEL_WATCH_MS).call(path);
    assert.deepEqual(reply, { ok: false, status: 409, body }, kind);
    // The bridge's hop (preload returns main's reply; the shell throws httpError for a non-2xx answer).
    const error = httpError(reply, path);
    assert.equal(error.code, 'E_SPAWN_INCOMPLETE');
    assert.deepEqual(error.incomplete, incomplete);
    assert.deepEqual(error.incomplete.launchPrompts.differed, DIFFERED);
  }
});

test('an Enter whose completion was not seen, answered at the kernel\'s bound, arrives with its reason and its submitted answer', async () => {
  const home = '/d/first/agents/dev/instances/dev';
  const details = { ...retained({ instance: 'dev', home }), launchPrompts: observationTimeout() };
  const body = { error: observationTimeoutMessage(home), code: 'E_SPAWN_INCOMPLETE', incomplete: retainedSpawnDetails(details) };
  const reply = await slowBackend({ status: 409, body }, KERNEL_WATCH_MS).call(`/api/start/dev${WS}`);
  const error = httpError(reply, '/api/start/dev');
  assert.equal(error.incomplete.launchPrompts.status, 'blocked');
  assert.equal(error.incomplete.launchPrompts.reason, 'blocked: observation timeout');
  assert.equal(error.incomplete.launchPrompts.answers.length, 1);
});

test('the end of the wait for the CLI call, answered at its limit, arrives as the server\'s answer and not as the proxy\'s abort', async () => {
  const limit = await cliLimit(true);
  const body = { error: START_UNCONFIRMED.message, code: START_UNCONFIRMED.code };
  const reply = await slowBackend({ status: 409, body }, limit).call(`/api/restart/dev${WS}`);
  assert.deepEqual(reply, { ok: false, status: 409, body });
  assert.equal(Object.hasOwn(httpError(reply, '/api/restart/dev'), 'incomplete'), false);
});

test('a backend that never answers still ends: the proxy rejects at its deadline, as before', async () => {
  await assert.rejects(slowBackend({ status: 200, body: {} }, Infinity).call(`/api/start/dev${WS}`), { name: 'TimeoutError' });
});
