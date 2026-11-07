import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { checkControlRequest, controlTokenMatches, controlRequestHeaders, loopbackHost } from '../control-request.mjs';
import { takeControlToken, takeLaunchControlToken } from '../control-token.mjs';
import { createControlFetch } from '../control-fetch.mjs';
import { serverSpawnSpec } from '../server-host.mjs';
import { ensureServerOnPort, serverCompatible } from '../server-compat.mjs';

const token = 'control-unit-token-12345678901234567890';
const headers = { host: '127.0.0.1:4820', 'x-oats-desktop-token': token };
const request = overrides => ({ method: 'POST', path: '/api/start/fixture', headers, ...overrides });

test('control tokens refuse missing, repeated, wrong length and same length wrong values', () => {
  for (const value of [undefined, null, '', 'short', 'x'.repeat(token.length), [token], [token, token], 10]) {
    assert.equal(controlTokenMatches(value, token), false);
    assert.deepEqual(checkControlRequest(request({ headers: { ...headers, 'x-oats-desktop-token': value } }), token),
      { ok: false, status: 403, error: 'forbidden' });
  }
  assert.equal(controlTokenMatches(token, ''), false);
  assert.equal(controlTokenMatches(token, token), true);
  assert.deepEqual(checkControlRequest(request(), token), { ok: true });
});

test('every method and path requires control token except GET /api/version', () => {
  for (const method of ['POST', 'GET', 'OPTIONS', 'HEAD', 'PUT']) {
    for (const path of ['/api/file', '/api/brain/fixture', '/unknown', '/api/version']) {
      assert.equal(checkControlRequest(request({ method, path, headers: { host: headers.host } }), token).ok,
        method === 'GET' && path === '/api/version');
    }
  }
});

test('an Origin must exactly match the HTTP request Host, including on the version route', () => {
  for (const origin of ['http://127.0.0.1:4821', 'http://localhost:4820', 'null', 'invalid', 'https://127.0.0.1:4820',
    'http://127.0.0.1:4820/', ['http://127.0.0.1:4820'], 'http://127.0.0.1:4820/path']) {
    for (const path of ['/api/panel', '/api/version']) {
      assert.equal(checkControlRequest(request({ method: 'GET', path, headers: { ...headers, origin } }), token).ok, false);
    }
  }
  assert.equal(checkControlRequest(request({ headers: { ...headers, origin: 'http://127.0.0.1:4820' } }), token).ok, true);
});

test('duplicate headers remain distinguishable from single headers', () => {
  assert.deepEqual(controlRequestHeaders({ headersDistinct: { host: ['localhost:4820'], 'x-oats-desktop-token': [token, token] } }),
    { host: 'localhost:4820', 'x-oats-desktop-token': [token, token] });
});

test('main takes the override, or mints once, and deletes it even when invalid', () => {
  let minted = 0;
  const mint = () => { minted++; return token; };
  const env = { OATS_DESKTOP_TOKEN: token, PATH: '/bin' };
  assert.equal(takeControlToken(env, mint), token);
  assert.equal(minted, 0);
  assert.deepEqual(env, { PATH: '/bin' });
  assert.equal(takeControlToken({}, mint), token);
  assert.equal(minted, 1);
  for (const value of [undefined, '', 'short', 'a'.repeat(32) + '\n']) {
    const env = { OATS_DESKTOP_TOKEN: value };
    assert.throws(() => takeControlToken(env), /OATS_DESKTOP_TOKEN must/);
    assert.equal(Object.hasOwn(env, 'OATS_DESKTOP_TOKEN'), false);
  }
});

test('main adds its own private header to all requests and refuses redirects', async () => {
  const calls = [];
  const fetch = createControlFetch(token, async (...args) => { calls.push(args); return { ok: true }; });
  await fetch('http://127.0.0.1:4820/api/panel');
  await fetch('http://127.0.0.1:4820/api/start/fixture', { method: 'POST', body: '{}', headers: {
    'X-OATS-DESKTOP-TOKEN': 'page-supplied', 'content-type': 'application/json',
  } });
  assert.equal(calls.length, 2);
  for (const [, init] of calls) {
    assert.equal(init.headers.get('x-oats-desktop-token'), token);
    assert.equal(init.redirect, 'error');
  }
  assert.equal(calls[1][1].body, '{}');
  assert.equal(calls[1][1].headers.get('content-type'), 'application/json');
  const source = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bfetch\(/, 'all main fetches use its authenticated helper');
  for (const name of ['proxySpawnApply', 'proxySpawnPreview', 'proxyInstanceEvents', 'proxyReadiness']) {
    assert.ok(source.split('\n').some(line => line.includes(`return ${name}(`) && line.includes('fetch: controlFetch')), `${name} uses main credentials`);
  }
  assert.ok(source.includes('createTerminalIo({ base, context: terminalContext, fetch: controlFetch,'));
});

test('only the server child receives the in-memory token, including replacements', () => {
  const options = { execPath: '/node', bin: '/backend', dirs: [], port: 4820,
    pathSource: 'inherited', remoteIdentityFile: '/fixture/identity', home: '/fixture',
    env: { OATS_DESKTOP_TOKEN: 'discarded-inherited', PATH: '/bin' }, controlToken: token };
  const first = serverSpawnSpec(options), replacement = serverSpawnSpec({ ...options, dirs: ['/fixture'] });
  for (const spec of [first, replacement]) {
    assert.equal(spec.options.env.OATS_DESKTOP_TOKEN, token);
    assert.equal(spec.args.includes(token), false);
  }
  assert.throws(() => serverSpawnSpec({ ...options, controlToken: '' }), /OATS_DESKTOP_TOKEN/);
});

test('a rejected token selects the next free port without inspecting workspace data', async () => {
  const spawned = [], logs = [], order = [];
  const result = await ensureServerOnPort({ port: 4820,
    probeVersion: async () => { order.push('version'); return { ok: true, body: { capability: 'desktop', version: '1' } }; },
    panelWorkspaces: async () => { order.push('panel'); return { forbidden: true }; },
    local: { capability: 'desktop', version: '1' }, matchWorkspace: () => assert.fail('refused'),
    freePort: async from => { assert.equal(from, 4821); return 4822; },
    spawnServer: port => spawned.push(port), log: line => logs.push(line),
  });
  assert.deepEqual(result, { spawned: true, port: 4822, wsId: null });
  assert.deepEqual(order, ['version', 'panel']);
  assert.deepEqual(spawned, [4822]);
  assert.match(logs[0], /another token/);
});

test('the exposed preload API has no control credential or header getter', () => {
  const require = createRequire(import.meta.url);
  let api;
  const electron = { contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
    ipcRenderer: { on() {}, removeListener() {}, invoke() {}, send() {} }, webUtils: {} };
  runInNewContext(readFileSync(new URL('../preload.cjs', import.meta.url), 'utf8'), {
    process: { argv: [] }, require: name => name === 'electron' ? electron : require(name === './terminal-bridge.cjs' ? '../terminal-bridge.cjs' : name),
  });
  for (const [key, value] of Object.entries(api)) {
    assert.doesNotMatch(key, /control.?token|desktop.?token|headers?/i);
    assert.notEqual(value, token);
    if (typeof value === 'function') assert.doesNotMatch(value.toString(), /OATS_DESKTOP_TOKEN|x-oats-desktop-token/);
  }
});


test('the shared Host policy preserves loopback addresses and refuses other hosts', () => {
  for (const host of ['127.0.0.1:4820', 'localhost', '[::1]:4820', '[::1]']) assert.equal(loopbackHost({ host }), true);
  for (const host of ['', 'foreign.invalid', '127.0.0.1.invalid', 'localhost.invalid:4820', '::1', undefined]) assert.equal(loopbackHost({ host }), false);
});

test('only an operator token permits a reuse probe', async () => {
  assert.deepEqual(takeLaunchControlToken({ OATS_DESKTOP_TOKEN: token }, () => assert.fail('already configured')),
    { token, reuseAllowed: true });
  assert.deepEqual(takeLaunchControlToken({}, () => token), { token, reuseAllowed: false });
  const calls = [];
  const result = await ensureServerOnPort({ port: 4820, reuseAllowed: false,
    probeVersion: () => assert.fail('minted launches do not probe'), panelWorkspaces: () => assert.fail('minted launches do not authenticate an existing listener'),
    freePort: async from => { calls.push(['freePort', from]); return 4823; }, spawnServer: port => calls.push(['spawn', port]),
  });
  assert.deepEqual(result, { spawned: true, port: 4823, wsId: null });
  assert.deepEqual(calls, [['freePort', 4820], ['spawn', 4823]]);
});

test('public version reads carry no token and control reads require an authorized binding', async () => {
  const calls = [];
  let live = false;
  const fetch = createControlFetch(token, async (...args) => { calls.push(args); return { ok: true }; }, { authorize: () => live });
  await fetch('http://127.0.0.1:4820/api/version', { headers: { 'x-oats-desktop-token': token } });
  assert.equal(calls[0][1].headers.has('x-oats-desktop-token'), false);
  await assert.rejects(fetch('http://127.0.0.1:4820/api/panel'), /live binding/);
  assert.equal(calls.length, 1);
  live = true;
  await fetch('http://127.0.0.1:4820/api/panel');
  assert.equal(calls[1][1].headers.get('x-oats-desktop-token'), token);
});


for (const completion of ['success', 'rejection']) test(`an older version probe ${completion} cannot replace a newer authorization`, async () => {
  const source = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
  const code = source.match(/async function probeVersion\(\) \{[^]*?\n\}/)[0];
  const pending = [];
  const identity = { capability: 'desktop', version: '1' };
  const context = { versionProbeIntent: 0, port: 4820, acceptedOperatorPort: null, ownServerStarted: false,
    reuseAllowed: true, base: () => 'http://127.0.0.1:4820', AbortSignal,
    serverCompatible, localServerIdentity: () => identity,
    controlFetch: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  };
  const probe = runInNewContext(`(${code})`, context);
  const first = probe(), second = probe();
  pending[1].resolve({ ok: true, status: 200, json: async () => identity });
  await second;
  assert.equal(context.acceptedOperatorPort, 4820);
  if (completion === 'success') pending[0].resolve({ ok: true, status: 200, json: async () => ({ ...identity, version: 'old' }) });
  else pending[0].reject(new Error('probe ended'));
  await first;
  assert.equal(context.acceptedOperatorPort, 4820);
});

test('a version probe cannot authorize a port changed while it was waiting', async () => {
  const source = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
  const code = source.match(/async function probeVersion\(\) \{[^]*?\n\}/)[0];
  const identity = { capability: 'desktop', version: '1' };
  let complete;
  const context = { versionProbeIntent: 0, port: 4820, acceptedOperatorPort: null, ownServerStarted: false,
    reuseAllowed: true, base: () => 'http://127.0.0.1:4820', AbortSignal, serverCompatible,
    localServerIdentity: () => identity, controlFetch: () => new Promise(resolve => { complete = resolve; }),
  };
  const read = runInNewContext(`(${code})`, context)();
  context.port = 4821;
  complete({ ok: true, status: 200, json: async () => identity });
  assert.equal(await read, null);
  assert.equal(context.acceptedOperatorPort, null);
});


for (const completion of ['success', 'rejection']) test(`an owned binding ${completion} belongs only to its captured child`, async () => {
  const source = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
  const code = source.match(/async function ensureServer\(\) \{[^]*?\n\}/)[0];
  let current = {}, complete, fail, reads = 0, waiting;
  const started = new Promise(resolve => { waiting = resolve; });
  const bindings = new WeakMap([[current, { wait: () => new Promise((resolve, reject) => { complete = resolve; fail = reject; waiting(); }), boundPort: () => 4820 }]]);
  const context = { ensureServerOnPort: async () => ({ spawned: true, port: 4820 }), reuseAllowed: false,
    port: 4820, workspaceDirs: [], panelWorkspaces: async () => { reads++; return []; }, probeVersion() {}, matchWorkspace() {},
    localServerIdentity: () => ({}), freePort() {}, spawnServer() {}, console: { log() {} },
    serverHost: { current: () => current }, serverBindings: bindings,
  };
  const read = runInNewContext(`(${code})`, context)();
  await started;
  current = {};
  if (completion === 'success') complete(4820); else fail(new Error('child ended'));
  await assert.rejects(read, /changed while waiting/);
  assert.equal(reads, 0);
});


test('main authorizes the owned binding origin or an explicitly accepted operator port', () => {
  const source = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const controlFetch = createControlFetch('), end = source.indexOf('\n});', start) + 4;
  let current = null, reported = null;
  const bindings = new WeakMap();
  const context = { controlToken: token, globalThis: { fetch() {} }, serverHost: { current: () => current }, serverBindings: bindings,
    reuseAllowed: false, acceptedOperatorPort: 80, ownServerStarted: false,
    createControlFetch: (_token, _fetch, options) => options.authorize,
  };
  const authorize = runInNewContext(`${source.slice(start, end)}; controlFetch`, context);
  assert.equal(authorize(new URL('http://127.0.0.1:80/api/panel')), false);
  context.reuseAllowed = true;
  assert.equal(authorize(new URL('http://127.0.0.1:80/api/panel')), true);
  for (const url of ['http://localhost:80/api/panel', 'https://127.0.0.1:80/api/panel', 'http://other.invalid:80/api/panel'])
    assert.equal(authorize(new URL(url)), false);
  current = {}; context.ownServerStarted = true;
  bindings.set(current, { boundPort: () => reported });
  assert.equal(authorize(new URL('http://127.0.0.1:80/api/panel')), false);
  reported = 80;
  assert.equal(authorize(new URL('http://127.0.0.1:80/api/panel')), true);
  reported = null;
  assert.equal(authorize(new URL('http://127.0.0.1:80/api/panel')), false);
  current = null;
  assert.equal(authorize(new URL('http://127.0.0.1:80/api/panel')), false, 'an owned server loss does not restore operator authorization');
});

test('fetch method normalization keeps public version requests free of the token', async () => {
  let sent;
  const fetch = createControlFetch(token, async (_url, init) => { sent = init; return {}; }, { authorize: () => assert.fail('public') });
  await fetch('http://127.0.0.1:4820/api/version', { method: 'get', headers: { 'x-oats-desktop-token': token } });
  assert.equal(sent.headers.has('x-oats-desktop-token'), false);
});
