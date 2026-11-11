import test from 'node:test';
import * as LOCATOR from '../../client/cli-locator.mjs'; // cliStatus reads the locator's range text and tested bound
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { withWindowGlobals } from './helpers/main-window-globals.mjs';
import { classifyApiRoute } from '../api-url.mjs';
import { discover } from '../../client/cli-locator.mjs';
import { createInstanceEventsBoundary } from '../server/instance-events.mjs';
import { proxyInstanceEvents, EVENTS_PROXY_TIMEOUT } from '../instance-events-proxy.mjs';
import { eventsFailure } from '../../client/instance-events-contract.mjs';
import { eventsData } from '../renderer/instance-events-data.mjs';
import { cli, context, target, request, data, envelope, deferred } from './helpers/instance-events-fixture.mjs';
import { deploymentDoubles } from './helpers/deployment-doubles.mjs';
import { handlerAuth, authorized } from './helpers/handler-auth.mjs';
const view = (t = target, value = data()) => ({ instanceEventsViewApi: 1, status: 'available', target: t, data: eventsData(value, t), reason: null });
function http() {
  const source = readFileSync(new URL('../server/oats-web.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const send = (res, code, body, type'), end = source.indexOf('\nserver.on("error",');
  const c = context(), calls = [];
  const deps = { createServer: fn => fn, eventsFailure, instanceEventsRequest: createInstanceEventsBoundary({ invoke: async (_cli, opts) => { calls.push(opts); return envelope(); } }),
    ...deploymentDoubles(() => [c.workspace]), ctxs: ['/Users/me/work'], cliState: c.cli, cliProbeGeneration: 1, snapshot: { byWs: new Map([['ws', { instances: c.instances }]]) }, ...handlerAuth };
  const handler = new Function(...Object.keys(deps), `${source.slice(start, end)}\nreturn server;`)(...Object.values(deps));
  return { c, calls, async request({ url = '/api/instance-events?ws=ws', method = 'POST', body = JSON.stringify(request()), headers = { host: 'localhost:4820', origin: 'http://localhost:4820' } } = {}) {
    const req = new EventEmitter(); Object.assign(req, { url, method, headers: authorized(headers) }); let result;
    const res = { writeHead(status, headers) { result = { status, headers }; }, end(text) { result.body = JSON.parse(text); } };
    const done = handler(req, res); req.emit('data', Buffer.from(body)); req.emit('end'); await done; return result;
  } };
}
test('shipped POST handler: Host/Origin/method/query/16KiB gates precede any process dispatch', async () => {
  const h = http();
  for (const headers of [{}, { host: 'evil' }, { host: 'localhost', origin: 'https://evil' }, { host: 'localhost', origin: 'null' }]) assert.equal((await h.request({ headers })).status, 403);
  for (const method of ['GET', 'PUT', 'DELETE']) assert.equal((await h.request({ method })).status, 404);
  for (const url of ['/api/instance-events', '/api/instance-events?ws=', '/api/instance-events?ws=ws&ws=ws', '/api/instance-events?ws=ws&since=now']) assert.equal((await h.request({ url })).status, 400);
  for (const body of ['{', 'null', '[]', ' '.repeat(16385), JSON.stringify(request()) + ' '.repeat(16384)]) assert.equal((await h.request({ body })).status, 400);
  assert.equal((await h.request({ url: '/api/instance-events?ws=unknown' })).body.reason.code, 'E_WORKSPACE_UNKNOWN');
  assert.equal(h.calls.length, 0);
  const out = await h.request(); assert.equal(out.body.status, 'available'); assert.equal(out.headers['cache-control'], 'no-store'); assert.equal(h.calls.length, 1);
});
test('shipped handler refuses old CLI/remote/extra paths/flags/write actions without fallback', async () => {
  const h = http(); h.c.cli.eventsApi = 1;
  assert.equal((await h.request()).body.reason.code, 'E_EVENTS_UNAVAILABLE'); h.c.cli.eventsApi = 2;
  // A local selector never resolves in a remote workspace; a remote row without this machine's remote entry is refused.
  Object.assign(h.c.workspace, { remote: true, server: 'build', name: 'Build box' }); assert.equal((await h.request()).body.reason.code, 'E_SESSION_UNKNOWN');
  h.c.instances[0].server = 'build'; h.c.instances[0].addressable = true;
  const unroutable = (await h.request({ body: JSON.stringify(request({ selector: { ...request().selector, server: 'build' } })) })).body.reason;
  assert.equal(unroutable.code, 'unsupported-remote-operation'); assert.equal(unroutable.message, "This computer's OATS can't route this to Build box. Update OATS here.");
  h.c.workspace.remote = false; delete h.c.workspace.server; delete h.c.instances[0].server;
  for (const bad of [{ ...request(), action: 'clear' }, { ...request(), action: 'watch' }, { ...request(), home: '/log' }, { ...request(), since: 'today' }, { ...request(), limit: 500 }]) {
    assert.equal((await h.request({ body: JSON.stringify(bad) })).body.reason.code, 'E_BAD_ARGS');
  }
  assert.equal(h.calls.length, 0);
});
function proxy(fetch = async () => new Response(JSON.stringify(view()))) {
  const renderer = 'file:///fixture/index.html', frame = { url: renderer }, event = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false } };
  const connection = { wsId: 'ws', allowedWs: new Set(['ws']), epoch: 0, transition: false };
  return { event, connection, deps: { rendererURL: renderer, connection: () => connection, fetch }, opts: { method: 'POST', body: request() } };
}
test('real main classifier routes every normalized alias through the specialized same-frame guard', async () => {
  const source = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8'), start = source.indexOf('ipcMain.handle("api",'), end = source.indexOf('// ---- IPC: workstation forge auth', start);
  let handler, calls = 0;
  const f = proxy(async () => { calls++; return new Response(JSON.stringify(view())); });
  const deps = { ipcMain: { handle: (_name, fn) => handler = fn }, classifyApiRoute, RENDERER_URL: f.deps.rendererURL,
    backendFetch: f.deps.fetch,
    proxyInstanceEvents: (event, path, opts, deps) => { assert.equal(deps.fetch, f.deps.fetch, 'main hands the proxy its backendFetch'); return proxyInstanceEvents(event, path, opts, deps); },
    wsId: 'ws', allowedWs: f.connection.allowedWs, serverEpoch: 0, unservedRefusal: () => null, serverHost: { inTransition: () => false },
    guard: () => assert.fail('events must never use generic proxy') };
  runInNewContext(source.slice(start, end), withWindowGlobals(deps));
  for (const path of ['/api/instance-events', '/api/./instance-events', '/api/x/../instance-events', '/api/%2e/instance-events', '/api' + String.fromCharCode(92) + 'instance-events', '/a\tpi/instance-events']) {
    assert.equal((await handler({ ...f.event, senderFrame: { url: f.deps.rendererURL } }, path, f.opts)).body.reason.code, 'E_FORBIDDEN_FRAME');
    assert.equal(calls, 0);
  }
  const out = await handler(f.event, '/api/x/../instance-events', f.opts);
  assert.equal(out.body.status, 'available'); assert.equal(calls, 1);
});
for (const reject of [false, true]) for (const change of ['frame', 'navigation', 'epoch', 'workspace', 'transition']) test(`proxy revokes late ${reject ? 'rejection' : 'success'} on ${change}`, async () => {
  const gate = deferred(), f = proxy(() => gate.promise);
  const pending = proxyInstanceEvents(f.event, '/api/instance-events', f.opts, f.deps);
  if (change === 'frame') f.event.sender.mainFrame = { url: f.deps.rendererURL };
  if (change === 'navigation') f.event.senderFrame.url = 'https://evil';
  if (change === 'epoch') f.connection.epoch++;
  if (change === 'workspace') f.connection.wsId = 'other';
  if (change === 'transition') f.connection.transition = true;
  if (reject) gate.reject(Error('PRIVATE')); else gate.resolve(new Response(JSON.stringify(view())));
  const out = await pending;
  assert.equal(out.body.reason?.code, ['frame', 'navigation'].includes(change) ? 'E_FORBIDDEN_FRAME' : 'E_TARGET_CHANGED');
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE/);
});
test('proxy checks ownership after stream consumption, not only response headers', async () => {
  let controller;
  const f = proxy(async () => new Response(new ReadableStream({ start(c) { controller = c; } })));
  const pending = proxyInstanceEvents(f.event, '/api/instance-events', f.opts, f.deps);
  await new Promise(resolve => setImmediate(resolve)); f.connection.epoch++;
  controller.enqueue(new TextEncoder().encode(JSON.stringify(view()))); controller.close();
  assert.equal((await pending).body.reason?.code, 'E_TARGET_CHANGED');
});
test('proxy rejects wrong origin/path/method/query/body before fetch and pins known workspace', async () => {
  let calls = 0;
  const f = proxy(async (path, opts) => { calls++; assert.equal(typeof path, 'string'); assert.equal(new URL(path, 'http://oats-backend.invalid').searchParams.get('ws'), 'ws'); assert.equal(opts.method, 'POST'); assert.ok(opts.signal instanceof AbortSignal); return new Response(JSON.stringify(view())); });
  for (const path of ['//evil/api/instance-events', 'http://evil/api/instance-events', '/api/other', '/api/instance-events?ws=ws&ws=ws', '/api/instance-events?since=now']) assert.equal((await proxyInstanceEvents(f.event, path, f.opts, f.deps)).body.reason.code, 'E_BAD_ARGS');
  for (const body of ['x'.repeat(16385), JSON.stringify(request()) + ' '.repeat(16384), '{', 'null', JSON.stringify({ ...request(), since: 'now' })]) assert.equal((await proxyInstanceEvents(f.event, '/api/instance-events', { method: 'POST', body }, f.deps)).body.reason.code, 'E_BAD_ARGS');
  assert.equal((await proxyInstanceEvents(f.event, '/api/instance-events', { method: 'GET' }, f.deps)).body.reason.code, 'E_BAD_ARGS');
  assert.equal(calls, 0); assert.equal(EVENTS_PROXY_TIMEOUT, 50000);
  assert.equal((await proxyInstanceEvents(f.event, '/api/instance-events?ws=unadvertised', f.opts, f.deps)).body.status, 'available'); assert.equal(calls, 1);
});
test('proxy streaming limit cancels before copying or decoding an over-budget chunk', async () => {
  let cancelled = false;
  const f = proxy(async () => ({ ok: true, status: 200, text: assert.fail, body: new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(4194305)); c.enqueue(new Uint8Array([123])); c.close(); }, cancel() { cancelled = true; },
  }) }));
  assert.equal((await proxyInstanceEvents(f.event, '/api/instance-events', f.opts, f.deps)).body.reason?.code, 'E_CLI_OUTPUT_LIMIT');
  assert.equal(cancelled, true);
});
test('proxy reprojection rejects foreign identities/protocol and never forwards raw error details', async () => {
  for (const raw of ['PRIVATE', JSON.stringify({ ...view(), instanceEventsViewApi: 2 }), JSON.stringify({ ...view(), target: { ...target, workspace: 'foreign' } }),
    JSON.stringify({ ...view(), target: { ...target, selector: { ...target.selector, agentsRoot: '/foreign' } } }),
    JSON.stringify({ ...view(), data: { ...view().data, incarnation: null } })]) {
    const f = proxy(async () => new Response(raw));
    const out = await proxyInstanceEvents(f.event, '/api/instance-events', f.opts, f.deps);
    assert.equal(out.body.reason?.code, 'E_CLI_PROTOCOL'); assert.doesNotMatch(JSON.stringify(out), /PRIVATE/);
  }
  const f = proxy(async () => new Response(JSON.stringify({ ...eventsFailure('E_HOME_MISMATCH'), stack: 'PRIVATE', reason: { code: 'E_HOME_MISMATCH', message: 'PRIVATE', details: 'PRIVATE' } }), { status: 400 }));
  const out = await proxyInstanceEvents(f.event, '/api/instance-events', f.opts, f.deps);
  assert.equal(out.body.reason.code, 'E_HOME_MISMATCH'); assert.equal(out.status, 400); assert.doesNotMatch(JSON.stringify(out), /PRIVATE/);
});
test('locator and public status expose exactly integer API2', async () => {
  const source = readFileSync(new URL('../server/oats-web.mjs', import.meta.url), 'utf8').match(/function cliStatus\(\) \{[^]*?\n\}/)[0];
  for (const eventsApi of [undefined, 1, '2', true, 3, 2]) {
    const found = await discover({ testedVersion: '0.69.17', persisted: () => cli.bin, env: {}, isExecutableFile: () => true }, async () => ({ stdout: JSON.stringify({ schemaVersion: 1, name: '@awebai/oats', version: '0.26.0', desktopApi: 1, features: ['instance-events-2'], eventsApi }) }));
    assert.equal(found.eventsApi, eventsApi === 2 ? 2 : undefined);
    const status = new Function('cliState', 'locator', 'MANIFEST', `return (${source})();`)({ eventsApi }, { ...LOCATOR, supportsRelations: () => false, RELATIONS_MIN: [] }, { version: '0.69.17' });
    assert.equal(status.eventsApi, eventsApi === 2 ? 2 : null);
  }
});
