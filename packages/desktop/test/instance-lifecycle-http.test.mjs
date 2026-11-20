// Shipped HTTP callback with inert K3 executors: no listener or live lifecycle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { withWindowGlobals } from './helpers/main-window-globals.mjs';
import { apiUrl, apiInit, classifyApiRoute, requestPath } from '../api-url.mjs';
import { forgeProxyOptions, trustedForgeFrame, FORGE_EPOCH_HEADER } from '../forge-proxy.mjs';
import { forgeFailure } from '../renderer/forge-contract.mjs';
import { lifecycleFailure } from '../../client/lifecycle-contract.mjs';
import { lifecycleFrameRefusal } from '../renderer/lifecycle-frame.mjs';
import { DESKTOP_TERMS } from '../renderer/desktop-terms.mjs';
import { createLifecycleBoundary } from '../../client/instance-lifecycle.mjs';
import { context, request, stopPlan, retirePlan, stopReceipt, retireReceipt, envelope } from './helpers/lifecycle-fixture.mjs';
import { deploymentDoubles } from './helpers/deployment-doubles.mjs';
import { handlerAuth, authorized } from './helpers/handler-auth.mjs';
function http({ remote = false, missing = false, routed = false, entries = ['lifecycle-plans'], apply = null } = {}) {
  const source = readFileSync(new URL('../server/oats-web.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const send = (res, code, body, type'), end = source.indexOf('\nserver.on("error",');
  const ctx = context(); ctx.workspace.remote = remote; if (missing) delete ctx.cli.lifecycleApi;
  // `routed`: a remote workspace whose addressable row is reached by --server and --home.
  if (routed) {
    Object.assign(ctx.workspace, { remote: true, server: 'build', name: 'Build box' }); ctx.cli.remote = entries;
    Object.assign(ctx.instances[0], { server: 'build', addressable: true });
  }
  const calls = [], refreshed = { local: 0, remote: 0 }, service = createLifecycleBoundary({ terms: DESKTOP_TERMS, invoke: async (bin, args) => {
    calls.push({ bin, args }); if (args.phase === 'apply' && apply) return apply(args);
    return envelope(args.phase === 'plan' ? args.operation === 'stop' ? stopPlan() : retirePlan()
      : args.operation === 'stop' ? stopReceipt(args) : retireReceipt(args));
  } });
  const deps = { createServer: fn => fn, lifecycleRequest: service, cliState: ctx.cli, ...deploymentDoubles(() => [ctx.workspace]), ctxs: ['/Users/me/work'],
    snapshot: { byWs: new Map([['team', { instances: ctx.instances }]]) }, observeMutation() { refreshed.local++; },
    remoteLoop: { request() { refreshed.remote++; } },
    resolveInstanceOr: assert.fail, panelData: assert.fail, snapshotPanel: assert.fail, collectNow: assert.fail, ...handlerAuth };
  const handler = new Function(...Object.keys(deps), `${source.slice(start, end)}\nreturn server;`)(...Object.values(deps));
  return { calls, refreshed, async request({ url = '/api/instance-lifecycle?ws=team', method = 'POST', body = JSON.stringify(request()),
    headers = { host: '127.0.0.1:4820', origin: 'http://localhost:4820' } } = {}) {
    const req = new EventEmitter(); Object.assign(req, { url, method, headers: authorized(headers) }); let result;
    const res = { writeHead(status, headers) { result = { status, headers }; }, end(text) { result.body = JSON.parse(text); } };
    const done = handler(req, res); req.emit('data', Buffer.from(body)); req.emit('end'); await done; return result;
  } };
}
test('shipped IPC bounds plan/apply separately and classifies lost mutation transport as unknown, never no effect', async () => {
  const source = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('ipcMain.handle("api",'), end = source.indexOf('// ---- IPC: workstation forge auth', start);
  for (const phase of ['plan', 'apply']) for (const fail of [false, true]) {
    let handler, seen;
    const renderer = 'file:///fixture/index.html', frame = { url: renderer }, owner = { mainFrame: frame, isDestroyed: () => false };
    const c = { ipcMain: { handle: (_name, fn) => { handler = fn; } }, apiUrl, apiInit, classifyApiRoute, requestPath, forgeProxyOptions,
      trustedForgeFrame, FORGE_EPOCH_HEADER, forgeFailure, lifecycleFailure, lifecycleFrameRefusal, DESKTOP_TERMS, RENDERER_URL: renderer, serverEpoch: 0,
      currentForgeEpoch: () => 'main:0', unservedRefusal: () => null, serverHost: { inTransition: () => false, held: () => () => true },
      wsId: 'team', allowedWs: new Set(['team']), guard: () => {}, AbortSignal: { timeout: ms => ({ ms }) },
      backendFetch: async (url, opts) => { seen = { url, opts }; if (fail) throw new Error('PRIVATE transport'); return { ok: true, status: 200, text: async () => '{"lifecycleApi":1}' }; } };
    runInNewContext(source.slice(start, end), withWindowGlobals(c));
    const response = await handler({ sender: owner, senderFrame: frame }, '/api/instance-lifecycle?ws=team', { method: 'POST', body: JSON.stringify({ action: phase }) });
    assert.equal(seen.opts.signal.ms, phase === 'apply' ? 610000 : 50000);
    if (fail) { assert.equal(response.body.status, phase === 'apply' ? 'unknown' : 'unavailable'); assert.doesNotMatch(JSON.stringify(response), /PRIVATE/); }
    seen = null;
    const denied = await handler({ sender: owner, senderFrame: { url: renderer } }, '/api/instance-lifecycle?ws=team', { method: 'POST', body: '{}' });
    assert.equal(denied.body.reason.code, 'E_FORBIDDEN_FRAME'); assert.equal(seen, null);
    // The refused frame's answer, whole: what main sent while the sentence was in the shared table, byte for byte.
    assert.equal(JSON.stringify(denied), '{"ok":false,"status":403,"body":{"lifecycleApi":1,"status":"unavailable","target":null,"planRef":null,"plan":null,"receipt":null,'
      + '"reason":{"code":"E_FORBIDDEN_FRAME","message":"This window cannot request a lifecycle operation."}}}');
  }
});

test('Host/Origin guards precede lifecycle body parsing, lookup and every process', async () => {
  const h = http();
  for (const headers of [{}, { host: 'evil' }, { host: 'localhost', origin: 'https://evil' }, { host: 'localhost', origin: 'null' }, { host: 'localhost', origin: 'bad' }]) assert.equal((await h.request({ headers, body: '{' })).status, 403);
  assert.equal(h.calls.length, 0);
});
test('GET, malformed JSON, byte overflow and duplicate/missing/extra ws cannot invoke K3', async () => {
  const h = http(); assert.equal((await h.request({ method: 'GET' })).status, 404);
  for (const url of ['/api/instance-lifecycle', '/api/instance-lifecycle?ws=', '/api/instance-lifecycle?ws=team&ws=team', '/api/instance-lifecycle?ws=team&home=/x']) assert.equal((await h.request({ url })).status, 400);
  for (const body of ['{', 'null', '[]', ' '.repeat(65537)]) assert.equal((await h.request({ body })).status, 400);
  assert.equal(h.calls.length, 0);
});
test('old retirement route refuses E_PLAN_REQUIRED before identity lookup, local and remote alike', async () => {
  const h = http();
  for (const url of ['/api/retire/dev-1', '/api/retire/dev-1?ws=team', '/api/retire/dev-1?server=host&home=/remote/dev-1']) {
    const result = await h.request({ url }); assert.equal(result.status, 409); assert.equal(result.body.code, 'E_PLAN_REQUIRED');
  }
  assert.equal(h.calls.length, 0);
});
test('remote and missing feature/API refusal executes nothing; real callback separates plan from confirmed apply', async () => {
  for (const opts of [{ remote: true }, { missing: true }]) {
    const h = http(opts); assert.equal((await h.request()).body.status, 'unavailable'); assert.equal(h.calls.length, 0);
  }
  const h = http(); const plan = await h.request(); assert.equal(plan.body.status, 'plan'); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].args.phase, 'plan'); assert.equal(h.calls[0].args.key, undefined);
  const body = JSON.stringify({ action: 'apply', planRef: plan.body.planRef });
  const result = await h.request({ body }); assert.equal(result.body.status, 'complete'); assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].args.phase, 'apply'); assert.match(h.calls[1].args.key, /^[a-f0-9]{64}$/);
  const again = await h.request({ body }); assert.equal(again.body.repeated, true); assert.equal(h.calls.length, 2);
  assert.equal(result.headers['cache-control'], 'no-store');
});

test('remote lifecycle over HTTP: a routed plan and apply, and the remote roster re-read at once after any apply', async () => {
  const selector = { ...request().selector, server: 'build' };
  const h = http({ routed: true });
  const plan = await h.request({ body: JSON.stringify({ ...request(), selector }) });
  assert.equal(plan.body.status, 'plan');
  assert.equal(h.calls[0].args.server, 'build'); assert.equal(h.calls[0].args.context, '/Users/me/work');
  const done = await h.request({ body: JSON.stringify({ action: 'apply', planRef: plan.body.planRef }) });
  assert.equal(done.body.status, 'complete'); assert.deepEqual(h.refreshed, { local: 0, remote: 1 });
  // An unknown outcome (the link was lost) is not a failure, and the roster is re-read all the same.
  const lost = http({ routed: true, apply: () => ({ schemaVersion: 1, ok: false, error: { code: 'E_SSH', message: 'ssh failed' } }) });
  const next = await lost.request({ body: JSON.stringify({ ...request(), selector }) });
  const unknown = await lost.request({ body: JSON.stringify({ action: 'apply', planRef: next.body.planRef }) });
  assert.equal(unknown.body.status, 'unknown'); assert.equal(unknown.body.cause.message, "Couldn't reach Build box.");
  assert.deepEqual(lost.refreshed, { local: 0, remote: 1 });
  // A local apply observes the local deployment, as before.
  const local = http(); const localPlan = await local.request();
  await local.request({ body: JSON.stringify({ action: 'apply', planRef: localPlan.body.planRef }) });
  assert.deepEqual(local.refreshed, { local: 1, remote: 0 });
});
test('remote lifecycle over HTTP: no remote entry on this machine refuses and spawns nothing', async () => {
  const selector = { ...request().selector, server: 'build' };
  for (const entries of [[], ['session', 'retire'], null]) {
    const h = http({ routed: true, entries });
    const refused = await h.request({ body: JSON.stringify({ ...request('retire'), selector }) });
    assert.equal(refused.body.reason.code, 'unsupported-remote-operation');
    assert.equal(refused.body.reason.message, "This computer's OATS can't route this to Build box. Update OATS here.");
    assert.equal(h.calls.length, 0);
  }
});
test('remote lifecycle over HTTP: a row of another group of the same server is never admitted, and nothing is sent', async () => {
  const source = readFileSync(new URL('../server/oats-web.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const send = (res, code, body, type'), end = source.indexOf('\nserver.on("error",');
  const ctx = context(), calls = [];
  const groupA = { id: 'remote:build:aaaa', name: 'Build box', scope: '/srv/a', remote: true, server: 'build' };
  const groupB = { id: 'remote:build:bbbb', name: 'Build box', scope: '/srv/b', remote: true, server: 'build' };
  const row = { ...ctx.instances[0], server: 'build', addressable: true };
  const deps = { createServer: fn => fn, lifecycleRequest: createLifecycleBoundary({ terms: DESKTOP_TERMS, invoke: async (...args) => { calls.push(args); return envelope(stopPlan()); } }),
    cliState: { ...ctx.cli, remote: ['lifecycle-plans'] }, ...deploymentDoubles(() => [groupA, groupB]), ctxs: ['/Users/me/work'],
    snapshot: { byWs: new Map([[groupA.id, { instances: [] }], [groupB.id, { instances: [row] }]]) }, observeMutation: assert.fail, remoteLoop: { request: assert.fail },
    resolveInstanceOr: assert.fail, panelData: assert.fail, snapshotPanel: assert.fail, collectNow: assert.fail, ...handlerAuth };
  const handler = new Function(...Object.keys(deps), `${source.slice(start, end)}\nreturn server;`)(...Object.values(deps));
  const ask = async ws => {
    const req = new EventEmitter(); let result;
    Object.assign(req, { url: `/api/instance-lifecycle?ws=${encodeURIComponent(ws)}`, method: 'POST', headers: authorized({ host: '127.0.0.1:4820', origin: 'http://localhost:4820' }) });
    const res = { writeHead(status) { result = { status }; }, end(text) { result.body = JSON.parse(text); } };
    const done = handler(req, res); req.emit('data', Buffer.from(JSON.stringify({ ...request(), selector: { ...request().selector, server: 'build' } }))); req.emit('end'); await done; return result;
  };
  assert.equal((await ask(groupA.id)).body.reason.code, 'E_SESSION_UNKNOWN');
  assert.equal(calls.length, 0);
  assert.equal((await ask(groupB.id)).body.status, 'plan', 'its own group admits it');
  assert.equal(calls.length, 1);
});
