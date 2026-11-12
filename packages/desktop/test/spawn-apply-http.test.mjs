import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { withWindowGlobals } from './helpers/main-window-globals.mjs';
import { apiUrl, classifyApiRoute } from '../api-url.mjs';
import { proxySpawnApply } from '../spawn-apply-proxy.mjs';
import { createSpawnApplyBoundary } from '../../client/spawn-apply.mjs';
import { spawnApplyFailure, spawnApplyView } from '../../client/spawn-apply-contract.mjs';
import { selector, target, deferred } from './helpers/spawn-preview-fixture.mjs';
import { applyContext, applyPreview, creation, envelope } from './helpers/spawn-apply-fixture.mjs';
import { deploymentDoubles } from './helpers/deployment-doubles.mjs';
import { handlerAuth, authorized } from './helpers/handler-auth.mjs';
const ref = 'a'.repeat(64);
const prepared = () => ({ spawnApplyViewApi: 1, status: 'prepared', target, spawnRef: ref, preview: applyPreview(target), wakeRequested: false, receipt: null, reason: null });
const draft = () => ({ action: 'prepare', selector, choices: {}, task: 'PRIVATE task' });
function http({ invoke, timer, awaitSpawned, ctxs = ['northwind'] } = {}) {
  const source = readFileSync(new URL('../server/oats-web.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const send = (res, code, body, type'), end = source.indexOf('\nserver.on("error",');
  const c = applyContext(), reads = [], calls = [], serverSpawns = [], order = []; let nonce = 0;
  const broker = createSpawnApplyBoundary({ mint: () => (++nonce).toString(16).padStart(64, '0'),
    read: request => { reads.push(request); return { status: 'available', data: applyPreview(target) }; },
    ...(timer ? { timer } : {}),
    invoke: (_cli, args) => { calls.push(args); order.push('invoke'); return invoke ? invoke(args) : { started: true, envelope: envelope(creation(applyPreview(args.target))) }; } });
  const deps = { createServer: fn => fn, spawnApplyFailure, spawnApplyRequest: broker, spawnPreview: { cache: { invalidate: ws => order.push(`invalidate:${ws}`) } },
    // #1246 D2: the created answer waits for its deployment's targeted read (oats-web.mjs, the OATSWEB_SPAWNREAD block).
    CREATED_STATUSES: ['complete', 'partial', 'incomplete'], ctxs,
    awaitSpawned: awaitSpawned ?? (async id => { order.push(`spawned:${id}`); }),
    observeMutation: ws => order.push(`observe:${ws}`),
    spawnAgent: async body => { serverSpawns.push(body); return { instance: 'dev-1', home: '/fixture/dev-1', agent: 'dev', launched: true }; },
    spawnErrorPayload: () => assert.fail('unexpected execution-server error'), ...deploymentDoubles(() => [c.workspace]), cliState: c.cli,
    agentsData: () => ({ agents: c.agents }), snapshot: { byWs: new Map([['northwind', { instances: c.instances }]]) }, ...handlerAuth };
  const handler = new Function(...Object.keys(deps), `${source.slice(start, end)}\nreturn server;`)(...Object.values(deps));
  return { c, reads, calls, serverSpawns, order, async request({ url = '/api/spawn?ws=northwind', method = 'POST', body = draft(), headers = { host: 'localhost:4820', origin: 'http://localhost:4820' } } = {}) {
    const req = new EventEmitter(); Object.assign(req, { url, method, headers: authorized(headers) }); let result;
    const res = { writeHead(status, headers) { result = { status, headers }; }, end(text) { result.body = JSON.parse(text); } };
    const done = handler(req, res); req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))); req.emit('end'); await done; return result;
  } };
}
test('shipped HTTP enforces host/origin, method, query and bounded strict JSON before effect', async () => {
  const h = http();
  for (const headers of [{}, { host: 'evil' }, { host: 'localhost', origin: 'https://evil' }, { host: 'localhost', origin: 'null' }]) assert.equal((await h.request({ headers })).status, 403);
  assert.equal((await h.request({ method: 'GET' })).status, 404);
  for (const url of ['/api/spawn', '/api/spawn?ws=', '/api/spawn?ws=northwind&ws=northwind', '/api/spawn?ws=northwind&other=1']) assert.equal((await h.request({ url })).status, 400);
  for (const body of ['{', 'null', '[]', ' '.repeat(65537)]) assert.equal((await h.request({ body })).status, 400);
  assert.equal(h.calls.length + h.reads.length + h.serverSpawns.length, 0);
  const p = await h.request(); assert.equal(p.body.status, 'prepared'); assert.equal(p.headers['cache-control'], 'no-store'); assert.equal(h.reads.length, 1); assert.equal(h.calls.length, 0);
});
test('HTTP prepare/ref-only apply/result is the real broker, not the execution-server spawn route', async () => {
  const h = http(), p = (await h.request()).body;
  assert.equal((await h.request({ body: { action: 'result', spawnRef: p.spawnRef } })).body.status, 'prepared'); assert.equal(h.calls.length, 0);
  assert.equal((await h.request({ body: { action: 'apply', spawnRef: p.spawnRef, task: 'replace' } })).body.reason.code, 'E_BAD_ARGS');
  const r = (await h.request({ body: { action: 'apply', spawnRef: p.spawnRef } })).body;
  assert.equal(r.status, 'complete'); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].task, 'PRIVATE task'); assert.doesNotMatch(JSON.stringify(r), /PRIVATE/);
  await h.request({ body: { action: 'apply', spawnRef: p.spawnRef } }); await h.request({ body: { action: 'result', spawnRef: p.spawnRef } });
  assert.equal(h.calls.length, 1); assert.equal(h.serverSpawns.length, 0);
});
test('every local raw request requires the plan, whatever the CLI; only a real execution-server id reaches the unguarded route', async () => {
  const h = http(), body = { agent: 'release-manager', agentsRoot: '/fixture/base/northwind-workspace/agents', task: 'ordinary' };
  for (const serverId of [undefined, '', null, [], {}, '--json', 1]) {
    const r = await h.request({ body: { ...body, serverId } }); assert.equal(r.status, 409); assert.equal(r.body.code, 'E_PLAN_REQUIRED');
  }
  delete h.c.cli.spawnApplyApi;
  assert.equal((await h.request({ body })).body.code, 'E_PLAN_REQUIRED', 'no unguarded local spawn for an older CLI either');
  assert.equal(h.serverSpawns.length, 0);
  assert.equal((await h.request({ body: { ...body, serverId: 'remote-host' } })).body.spawned, true); assert.equal(h.serverSpawns.length, 1);
  for (const extra of [{ branch: 'x' }, { base: 'HEAD' }, { work: 'worktree' }, { idempotencyKey: ref }, { spawnRef: ref }, { decision: {} }, { model: '@native-default' }])
    assert.equal((await h.request({ body: { ...body, serverId: 'remote-host', ...extra } })).body.code, 'E_UNSUPPORTED_OPTION');
  assert.equal(h.serverSpawns.length, 1); assert.equal((await h.request()).body.reason.code, 'E_APPLY_UNAVAILABLE');
});
function proxy(fetch) {
  const renderer = 'file:///fixture/index.html', frame = { url: renderer }, event = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false } };
  const connection = { wsId: 'northwind', allowedWs: new Set(['northwind']), epoch: 0, transition: false };
  return { event, connection, deps: { rendererURL: renderer, connection: () => connection, fetch }, opts: { method: 'POST', body: draft() } };
}
const aliases = ['/api/spawn', '/api/./spawn', '/api/x/../spawn', '/api/%2e/spawn', '/api' + String.fromCharCode(92) + 'spawn', '/a\tpi/spawn'];
test('main composition normalizes all spawn aliases to specialized guard, including the execution-server body', async () => {
  const source = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8'), start = source.indexOf('ipcMain.handle("api",'), end = source.indexOf('// ---- IPC: workstation forge auth', start);
  let handler, calls = 0;
  const f = proxy(async () => { calls++; return { ok: true, status: 200, text: async () => JSON.stringify(prepared()) }; });
  const deps = { ipcMain: { handle: (_n, fn) => handler = fn }, classifyApiRoute, RENDERER_URL: f.deps.rendererURL,
    backendFetch: f.deps.fetch,
    proxySpawnApply: (e, path, opts, d) => { assert.equal(d.fetch, f.deps.fetch, 'main hands the proxy backendFetch'); return proxySpawnApply(e, path, opts, d); },
    wsId: 'northwind', allowedWs: f.connection.allowedWs, serverEpoch: 0, unservedRefusal: () => null, serverHost: { inTransition: () => false, held: () => () => true },
    forgeFailure: () => ({}), lifecycleFailure: () => ({}), guard: () => assert.fail('spawn must use specialized guard') };
  runInNewContext(source.slice(start, end), withWindowGlobals(deps));
  for (const pathname of aliases) {
    assert.equal(classifyApiRoute(pathname), 'spawn-apply');
    for (const body of [draft(), { agent: 'dev', agentsRoot: '/team/agents' }]) assert.equal((await handler({ ...f.event, senderFrame: { url: f.deps.rendererURL } }, pathname, { method: 'POST', body })).body.reason.code, 'E_FORBIDDEN_FRAME');
  }
  assert.equal(calls, 0); assert.equal((await handler(f.event, '/api/./spawn', f.opts)).body.status, 'prepared'); assert.equal(calls, 1);
});
for (const action of ['prepare', 'apply', 'result', 'server']) for (const reject of [false, true]) for (const change of ['frame', 'navigation', 'epoch']) test(`${action} guards late ${reject ? 'rejection' : 'success'} after ${change}`, async () => {
  const d = deferred(), f = proxy(() => d.promise);
  const body = action === 'prepare' ? draft() : action === 'server' ? { agent: 'dev', agentsRoot: '/team/agents' } : { action, spawnRef: ref };
  const pending = proxySpawnApply(f.event, '/api/spawn', { method: 'POST', body }, f.deps);
  if (change === 'frame') f.event.sender.mainFrame = { url: f.deps.rendererURL };
  if (change === 'navigation') f.event.senderFrame.url = 'https://evil';
  if (change === 'epoch') f.connection.epoch++;
  if (reject) d.reject(Error('PRIVATE')); else d.resolve({ ok: true, status: 200, text: async () => JSON.stringify(prepared()) });
  const r = await pending, mutation = action === 'apply' || action === 'server';
  assert.equal(r.body.status, mutation ? 'unknown' : 'unavailable'); assert.equal(r.body.reason.code, mutation ? 'E_OUTCOME_UNKNOWN' : ['frame', 'navigation'].includes(change) ? 'E_FORBIDDEN_FRAME' : 'E_PLAN_CHANGED');
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE/);
});
test('workspace duplicates survive pinning and are refused before fetch; output targets/refs are bound', async () => {
  assert.deepEqual(apiUrl('/api/spawn?ws=northwind&ws=other', 'northwind').searchParams.getAll('ws'), ['northwind', 'other']);
  const f = proxy(assert.fail);
  for (const path of ['/api/spawn?ws=northwind&ws=other', '/api/spawn?ws=northwind&extra=1', '//evil/api/spawn']) assert.equal((await proxySpawnApply(f.event, path, f.opts, f.deps)).ok, false);
  for (const alter of [p => p.target.workspace = 'other', p => p.target.selector.soul = 'other', p => p.preview.decision.effective.model = 'other']) {
    const p = prepared(); p.target = structuredClone(target); alter(p); const f = proxy(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(p) }));
    assert.equal((await proxySpawnApply(f.event, '/api/spawn', f.opts, f.deps)).body.reason.code, 'E_CLI_PROTOCOL');
  }
  const p = prepared(); p.spawnRef = 'b'.repeat(64); const mismatch = proxy(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(p) }));
  assert.equal((await proxySpawnApply(mismatch.event, '/api/spawn', { method: 'POST', body: { action: 'apply', spawnRef: ref } }, mismatch.deps)).body.status, 'unknown');
});
test('an execution-server response survives, new typed output cannot leak recipes/private extras', async () => {
  const served = { spawned: true, instance: 'dev-1', home: '/fixture/dev-1', launched: true };
  const f = proxy(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(served) }));
  assert.deepEqual((await proxySpawnApply(f.event, '/api/spawn', { method: 'POST', body: { agent: 'dev', agentsRoot: '/team/agents' } }, f.deps)).body, served);
  const p = prepared(); p.task = 'PRIVATE'; p.preview.env = 'PRIVATE'; p.preview.decision.effective.recipe = 'PRIVATE';
  assert.doesNotMatch(JSON.stringify(spawnApplyView(p, { workspace: 'northwind', selector })), /PRIVATE/);
});
test('malformed/oversize outputs after possible apply are unknown; wrong method/oversize input is zero-fetch', async () => {
  const f = proxy(assert.fail);
  for (const opts of [{ method: 'GET' }, { method: 'POST', body: 'x'.repeat(65537) }, { method: 'POST', body: { action: 'apply', spawnRef: ref, key: ref } }]) assert.equal((await proxySpawnApply(f.event, '/api/spawn', opts, f.deps)).body.reason.code, 'E_BAD_ARGS');
  for (const raw of ['PRIVATE', 'x'.repeat(4194305), JSON.stringify({ spawnApplyViewApi: 1 })]) {
    const f = proxy(async () => ({ ok: true, status: 200, text: async () => raw }));
    assert.equal((await proxySpawnApply(f.event, '/api/spawn', { method: 'POST', body: { action: 'apply', spawnRef: ref } }, f.deps)).body.status, 'unknown');
  }
});

test('Spec C: an apply drops the workspace\'s held previews before the kernel runs (a preview read meanwhile must not be the pre-spawn answer)', async () => {
  const h = http();
  const prepared = await h.request(); assert.equal(prepared.body.status, 'prepared');
  assert.deepEqual(h.order, [], 'prepare invalidates nothing');
  await h.request({ body: { action: 'apply', spawnRef: prepared.body.spawnRef } });
  assert.deepEqual(h.order.slice(0, 2), ['invalidate:northwind', 'invoke']);
});
test('#802: an apply that answered pending refreshes again (held previews, the roster) when its CLI settles', async () => {
  const gate = deferred(); let fire;
  const h = http({ invoke: () => gate.promise, timer: fn => { fire = fn; return () => {}; } });
  const p = (await h.request()).body;
  const answer = h.request({ body: { action: 'apply', spawnRef: p.spawnRef } });
  await new Promise(resolve => setImmediate(resolve)); fire();
  assert.equal((await answer).body.status, 'pending');
  assert.deepEqual(h.order, ['invalidate:northwind', 'invoke', 'observe:northwind']);
  gate.resolve({ started: true, envelope: envelope(creation(applyPreview(target))) });
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.order.slice(3), ['invalidate:northwind', 'observe:northwind'], 'the late outcome refreshes once more');
  assert.equal((await h.request({ body: { action: 'result', spawnRef: p.spawnRef } })).body.status, 'complete');
});
test('#1246 D2: a created answer goes once its deployment\'s post-spawn read has landed; prepare, pending and unregistered deployments never wait', async () => {
  const gate = deferred(), waits = [];
  const h = http({ awaitSpawned: (id, arrivedAt) => { waits.push([id, typeof arrivedAt]); h.order.push(`spawned:${id}`); return gate.promise; } });
  const p = (await h.request()).body;
  assert.deepEqual(waits, [], 'prepare waits for nothing');
  let answered = false;
  const answer = h.request({ body: { action: 'apply', spawnRef: p.spawnRef } }).then(r => { answered = true; return r; });
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(waits, [['northwind', 'number']], 'started at once, with when the request arrived');
  assert.deepEqual(h.order, ['invalidate:northwind', 'invoke', 'spawned:northwind', 'observe:northwind'], 'the live refresh still runs');
  assert.equal(answered, false, 'the answer waits for the read');
  gate.resolve(); assert.equal((await answer).body.status, 'complete');
  assert.equal((await h.request({ body: { action: 'result', spawnRef: p.spawnRef } })).body.status, 'complete');
  assert.equal(waits.length, 2, 'a result that answers created reads the deployment too');
  const elsewhere = http({ ctxs: [], awaitSpawned: () => assert.fail('no post-spawn read for a deployment this backend does not observe') });
  const q = (await elsewhere.request()).body;
  assert.equal((await elsewhere.request({ body: { action: 'apply', spawnRef: q.spawnRef } })).body.status, 'complete');
});
