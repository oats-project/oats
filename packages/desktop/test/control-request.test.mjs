import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { checkControlRequest, controlTokenMatches, controlRequestHeaders } from '../control-request.mjs';
import { takeControlToken } from '../control-token.mjs';
import { createControlFetch } from '../control-fetch.mjs';
import { serverSpawnSpec } from '../server-host.mjs';
import { ensureServerOnPort } from '../server-compat.mjs';

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
