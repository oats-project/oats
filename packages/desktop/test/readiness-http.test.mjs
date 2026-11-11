import test from 'node:test';
import * as LOCATOR from '../../client/cli-locator.mjs'; // cliStatus reads the locator's range text and tested bound
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { withWindowGlobals } from './helpers/main-window-globals.mjs';
import { apiUrl, classifyApiRoute } from '../api-url.mjs';
import { proxyReadiness } from '../readiness-proxy.mjs';
import { readinessFailure } from '../../client/readiness-contract.mjs';
import { createReadinessBoundary } from '../server/readiness.mjs';
import { context, selector, target, data, view, envelope, deferred, tick } from './helpers/readiness-fixture.mjs';
import { deploymentDoubles } from './helpers/deployment-doubles.mjs';
import { handlerAuth, authorized } from './helpers/handler-auth.mjs';
function http() {
  const source = readFileSync(new URL('../server/oats-web.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const send = (res, code, body, type'), end = source.indexOf('\nserver.on("error",');
  const c = context(), calls = [];
  const deps = { createServer: fn => fn, readinessFailure, readinessRequest: createReadinessBoundary({ invoke: async (bin, args) => { calls.push({ bin, args }); return envelope(data(args.target)); } }),
    cliState: c.cli, ...deploymentDoubles(() => [c.workspace]), ctxs: ['/Users/me/work'], agentsData: () => ({ agents: c.agents }), snapshot: { byWs: new Map([['team', { instances: c.instances }]]) },
    panelData: assert.fail, collectNow: assert.fail, ...handlerAuth };
  const handler = new Function(...Object.keys(deps), `${source.slice(start, end)}\nreturn server;`)(...Object.values(deps));
  return { calls, c, async request({ url = '/api/workspace-readiness?ws=team', method = 'POST', body = JSON.stringify({ action: 'read', selector }), headers = { host: '127.0.0.1:4820', origin: 'http://localhost:4820' } } = {}) {
    const req = new EventEmitter(); Object.assign(req, { url, method, headers: authorized(headers) }); let result;
    const res = { writeHead(status, headers) { result = { status, headers }; }, end(text) { result.body = JSON.parse(text); } };
    const done = handler(req, res); req.emit('data', Buffer.from(body)); req.emit('end'); await done; return result;
  } };
}
test('shipped HTTP Host/Origin/method/query/body guards refuse before readiness process', async () => {
  const h = http();
  for (const headers of [{}, { host: 'evil' }, { host: 'localhost', origin: 'https://evil' }, { host: 'localhost', origin: 'null' }]) assert.equal((await h.request({ headers })).status, 403);
  assert.equal((await h.request({ method: 'GET' })).status, 404);
  for (const url of ['/api/workspace-readiness', '/api/workspace-readiness?ws=', '/api/workspace-readiness?ws=team&ws=team', '/api/workspace-readiness?ws=team&verify=true']) assert.equal((await h.request({ url })).status, 400);
  for (const body of ['{', 'null', '[]', ' '.repeat(65537)]) assert.equal((await h.request({ body })).status, 400);
  assert.equal(h.calls.length, 0);
  const r = await h.request(); assert.equal(r.status, 200); assert.equal(r.body.status, 'available'); assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].args.target.observedAs, 'soul');
});
test('shipped HTTP denies verification, remote and missing API without dispatch', async () => {
  const h = http();
  assert.equal((await h.request({ body: JSON.stringify({ action: 'verify-signatures', selector }) })).body.reason.code, 'E_BAD_ARGS');
  h.c.workspace.remote = true; assert.equal((await h.request()).body.reason.code, 'unsupported-remote-operation');
  h.c.workspace.remote = false; delete h.c.cli.readinessApi; assert.equal((await h.request()).body.reason.code, 'cli-no-readiness'); assert.equal(h.calls.length, 0);
});
test('workspace family is pinned; duplicate selectors survive for refusal; off-origin never resolves', () => {
  for (const path of ['/api/workspace-readiness', '/api/workspace-future']) {
    assert.equal(apiUrl(path, 'team', new Set(['team', 'other'])).searchParams.get('ws'), 'team');
    assert.equal(apiUrl(`${path}?ws=other`, 'team', new Set(['team', 'other'])).searchParams.get('ws'), 'other');
    assert.equal(apiUrl(`${path}?ws=team&ws=team`, 'team').searchParams.getAll('ws').length, 2);
  }
  for (const path of ['//evil/api/workspace-readiness', '/\\evil/api/workspace-readiness']) assert.throws(() => apiUrl(path, 'team'));
});
function proxyFixture(fetch) {
  const rendererURL = 'file:///fixture/index.html', frame = { url: rendererURL }, sender = { mainFrame: frame, isDestroyed: () => false };
  const event = { senderFrame: frame, sender }; let epoch = 0, transition = false;
  return { frame, sender, event, bump() { epoch++; }, transition() { transition = true; },
    deps: { rendererURL, connection: () => ({ epoch, transition, wsId: 'team', allowedWs: new Set(['team']) }), fetch },
    opts: { method: 'POST', body: { action: 'read', selector } } };
}
test('shipped main binding actually delegates readiness to guarded proxy with current server ownership', async () => {
  const source = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8'), start = source.indexOf('ipcMain.handle("api",'), end = source.indexOf('// ---- IPC: workstation forge auth', start);
  let handler, seen; const f = proxyFixture(async () => assert.fail()), backendFetch = async () => assert.fail();
  const deps = { classifyApiRoute, ipcMain: { handle: (_key, fn) => handler = fn }, RENDERER_URL: f.deps.rendererURL,
    forgeFailure: () => ({}), lifecycleFailure: () => ({}), guard: () => assert.fail('readiness must not fall through the generic proxy'),
    proxyReadiness: (e, path, opts, deps) => { seen = { e, path, opts, c: deps.connection(), fetch: deps.fetch }; return 'guarded'; },
    backendFetch, wsId: 'team', allowedWs: new Set(['team']), serverEpoch: 7, unservedRefusal: () => null, serverHost: { inTransition: () => false } };
  runInNewContext(source.slice(start, end), withWindowGlobals(deps));
  for (const path of ['/api/workspace-readiness', '/api/x/../workspace-readiness', '/api' + String.fromCharCode(92) + 'workspace-readiness', '/api/%2e/workspace-readiness', '/api/workspace-\treadiness']) {
    assert.equal(await handler(f.event, path, f.opts), 'guarded', `normalized ${path} uses the dedicated frame boundary`);
    assert.equal(seen.c.epoch, 7); assert.equal(seen.c.wsId, 'team'); assert.equal(seen.fetch, backendFetch, 'the proxy is handed main\'s backendFetch');
  }
});
test('proxy refuses foreign frame/GET/transitions without fetch, returns only projected results', async () => {
  let calls = 0; const f = proxyFixture(async (_url, init) => { calls++; assert.equal(init.method, 'POST'); assert.deepEqual(JSON.parse(init.body), f.opts.body); return { ok: true, status: 200, text: async () => JSON.stringify(view()) }; });
  const path = '/api/workspace-readiness?ws=team';
  const foreign = await proxyReadiness({ ...f.event, senderFrame: { url: f.frame.url } }, path, f.opts, f.deps); assert.equal(foreign.body.reason.code, 'E_FORBIDDEN_FRAME');
  assert.equal((await proxyReadiness(f.event, path, { method: 'GET' }, f.deps)).body.reason.code, 'E_BAD_ARGS'); assert.equal(calls, 0);
  const result = await proxyReadiness(f.event, path, f.opts, f.deps); assert.equal(result.body.status, 'available'); assert.equal(result.body.target.observedAs, 'soul');
  f.transition(); assert.equal((await proxyReadiness(f.event, path, f.opts, f.deps)).body.reason.code, 'E_TARGET_CHANGED'); assert.equal(calls, 1);
});
for (const reject of [false, true]) for (const changed of ['frame', 'epoch']) test(`proxy guards late ${reject ? 'rejection' : 'success'} after ${changed} change`, async () => {
  const gate = deferred(), f = proxyFixture(() => gate.promise); const pending = proxyReadiness(f.event, '/api/workspace-readiness', f.opts, f.deps); await tick();
  if (changed === 'frame') f.frame.url = 'https://evil'; else f.bump();
  if (reject) gate.reject(Error('PRIVATE')); else gate.resolve({ ok: true, status: 200, text: async () => JSON.stringify(view()) });
  const result = await pending; assert.equal(result.body.reason.code, changed === 'frame' ? 'E_FORBIDDEN_FRAME' : 'E_TARGET_CHANGED'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});
for (const body of ['PRIVATE raw', JSON.stringify({ raw: 'PRIVATE' }), JSON.stringify(view({ ...target, workspace: 'other' })), 'x'.repeat(4194305)]) test(`proxy rejects malformed/unbounded/foreign response (${body.length} bytes)`, async () => {
  const f = proxyFixture(async () => ({ ok: true, status: 200, text: async () => body })); const r = await proxyReadiness(f.event, '/api/workspace-readiness', f.opts, f.deps);
  assert.equal(r.body.status, 'unavailable'); assert.doesNotMatch(JSON.stringify(r), /PRIVATE/);
});
test('public CLI status forwards exact readiness API, including explicit unavailable null', () => {
  const source = readFileSync(new URL('../server/oats-web.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('function cliStatus() {'), source.indexOf('\n}', source.indexOf('function cliStatus() {')) + 2);
  for (const readinessApi of [1, 2, '2', 3, undefined]) {
    const status = new Function('cliState', 'locator', 'MANIFEST', `${body}; return cliStatus();`)({ readinessApi }, { ...LOCATOR, supportsRelations: () => false, RELATIONS_MIN: [0, 0, 0] }, { version: '0.69.17' });
    assert.equal(status.readinessApi, readinessApi === 2 ? 2 : null);
  }
});
test('public CLI status forwards the exact inspection gate (operationsApi 2) that the Workspace inspector reads', () => {
  const source = readFileSync(new URL('../server/oats-web.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('function cliStatus() {'), source.indexOf('\n}', source.indexOf('function cliStatus() {')) + 2);
  for (const operationsApi of [1, 2, '2', 3, undefined]) {
    const status = new Function('cliState', 'locator', 'MANIFEST', `${body}; return cliStatus();`)({ operationsApi }, { ...LOCATOR, supportsRelations: () => false, RELATIONS_MIN: [0, 0, 0] }, { version: '0.69.17' });
    assert.equal(status.operationsApi, operationsApi === 2 ? 2 : null, String(operationsApi));
  }
});
