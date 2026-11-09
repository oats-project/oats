import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startLoadPathServer } from './helpers/load-path-server.mjs';
import { TEST_CONTROL_TOKEN } from './helpers/control-auth.mjs';

import { createHarnessServer } from '../renderer/harness-server.mjs';

const HEADER = 'x-oats-desktop-token';
const MAIN_TOKEN = fileURLToPath(new URL('../main-control-token.mjs', import.meta.url));
const SERVER = fileURLToPath(new URL('../server/oats-web.mjs', import.meta.url));

function raw(base, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const framed = body === undefined ? headers : { ...headers, 'content-length': Buffer.byteLength(body) };
    const req = request(new URL(path, base), { method, headers: framed }, res => {
      let text = '';
      res.setEncoding('utf8'); res.on('data', value => { text += value; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', error => reject(new Error(`${method} ${path}: ${error.code}`, { cause: error }))); req.end(body);
  });
}

test('real server requires the launch token before control routing and body parsing', async t => {
  const s = await startLoadPathServer(); t.after(() => s.stop());
  const valid = { [HEADER]: TEST_CONTROL_TOKEN };
  const bad = [{}, { [HEADER]: 'w'.repeat(TEST_CONTROL_TOKEN.length) }, { [HEADER]: 'short' },
    { [HEADER]: [TEST_CONTROL_TOKEN, TEST_CONTROL_TOKEN] }];
  for (const [path, method] of [['/api/file?path=/missing', 'GET'], ['/api/start/missing', 'POST'],
    ['/unknown-route', 'GET'], ['/api/version', 'POST'], ['/api/panel', 'OPTIONS']]) {
    for (const headers of bad) {
      const result = await raw(s.base, path, { method, headers, body: method === 'POST' ? '{' : undefined });
      assert.equal(result.status, 403, `${method} ${path}`);
      assert.equal(result.text.includes(TEST_CONTROL_TOKEN), false);
    }
  }
  const plain = await raw(s.base, '/api/start/missing', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(plain.status, 403);
  assert.equal(s.calls().some(call => call.verb === 'session'), false, 'no start command was dispatched');
  for (const origin of ['http://localhost:1', 'null', 'malformed', s.base.replace('http:', 'https:'), `${s.base}/`]) {
    for (const [path, method] of [['/api/file', 'GET'], ['/api/start/missing', 'POST']]) {
      assert.equal((await raw(s.base, path, { method, headers: { ...valid, origin }, body: '{}' })).status, 403, `${method} ${path}: ${origin}`);
    }
  }
  const version = await raw(s.base, '/api/version');
  assert.equal(version.status, 200);
  const identity = JSON.parse(version.text);
  assert.deepEqual(Object.keys(identity).sort(), ['capability', 'version']);
  assert.equal(typeof identity.capability, 'string'); assert.equal(typeof identity.version, 'string');
  assert.equal((await raw(s.base, '/api/panel', { headers: { ...valid, origin: s.base } })).status, 200);
  assert.equal((await raw(s.base, '/api/panel', { headers: valid })).status, 200);
  assert.equal(s.output().includes(TEST_CONTROL_TOKEN), false, 'server output contains no launch token');
});

test('real server refuses upgrade requests before accepting a transport', async t => {
  const s = await startLoadPathServer(); t.after(() => s.stop());
  for (const headers of [{}, { [HEADER]: 'wrong' }, { [HEADER]: TEST_CONTROL_TOKEN }]) {
    const result = await raw(s.base, '/api/panel', { headers: { ...headers, connection: 'Upgrade', upgrade: 'websocket' } });
    assert.equal(result.status, headers[HEADER] === TEST_CONTROL_TOKEN ? 404 : 403);
    assert.equal(result.text.includes(TEST_CONTROL_TOKEN), false);
  }
  assert.equal((await s.getStatus('/api/panel')).status, 200);
});

test('real server refuses missing, empty and short launch tokens without printing a value', () => {
  for (const token of [undefined, '', 'short-private-value']) {
    const env = { ...process.env, OATS_DESKTOP_TOKEN: token, OATS_DESKTOP_OATS_BIN: '', PATH: '/nonexistent', SHELL: '/bin/false' };
    for (const [entry, args] of [[SERVER, ['start', '--port', '0']], ...(token === undefined ? [] : [[MAIN_TOKEN, []]])]) {
      const result = spawnSync(process.execPath, [entry, ...args], { env, encoding: 'utf8', timeout: 5000 });
      assert.notEqual(result.status, 0);
      const output = result.stdout + result.stderr;
      assert.match(output, /OATS_DESKTOP_TOKEN/);
      assert.match(output, /32/);
      if (entry === MAIN_TOKEN) assert.match(output, /^oats-desktop: OATS_DESKTOP_TOKEN must be set to at least 32 characters\n$/);
      if (token) assert.equal(output.includes(token), false);
      assert.equal(output.includes(TEST_CONTROL_TOKEN), false);
    }
  }
});


test('an unparsable request target is refused and the server remains available', async t => {
  const s = await startLoadPathServer(); t.after(() => s.stop());
  const base = new URL(s.base);
  const status = await new Promise((resolve, reject) => {
    const req = request({ hostname: base.hostname, port: base.port, path: 'http://',
      headers: { host: 'unserved.invalid' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 400);
  assert.equal((await s.getStatus('/api/panel')).status, 200);
  assert.equal(s.output().includes(TEST_CONTROL_TOKEN), false);
});


async function listenForTest(t, server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('the development harness checks its own Host and Origin before proxying', async t => {
  const forwarded = [];
  const api = await listenForTest(t, createServer((req, res) => {
    let body = '';
    req.on('data', bytes => { body += bytes; });
    req.on('end', () => {
      forwarded.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
    });
  }));
  const harness = await listenForTest(t, createHarnessServer(new URL(api), TEST_CONTROL_TOKEN));
  for (const origin of ['http://localhost:1', 'null', 'invalid', harness.replace('http:', 'https:'), harness + '/', [harness, harness]]) {
    const result = await raw(harness, '/api/panel', { headers: { origin } });
    assert.equal(result.status, 403);
    assert.equal(result.text.includes(TEST_CONTROL_TOKEN), false);
  }
  for (const host of ['other.invalid', '127.0.0.1:1', 'localhost:1']) {
    assert.equal((await raw(harness, '/api/panel', { headers: { host, origin: `http://${host}` } })).status, 403);
  }
  assert.equal(forwarded.length, 0);
  const payload = '{"draft":"fixture"}';
  const response = await raw(harness, '/api/start/fixture?ws=test', { method: 'POST', body: payload,
    headers: { origin: harness, [HEADER]: ['page-supplied', 'repeated'], 'content-type': 'application/json' } });
  assert.equal(response.status, 200);
  assert.equal(response.text.includes(TEST_CONTROL_TOKEN), false);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].headers.origin, undefined);
  assert.equal(forwarded[0].headers[HEADER], TEST_CONTROL_TOKEN);
  assert.equal(forwarded[0].headers.host, new URL(api).host);
  assert.equal(forwarded[0].method, 'POST');
  assert.equal(forwarded[0].url, '/api/start/fixture?ws=test');
  assert.equal(forwarded[0].body, payload);
  assert.equal((await raw(harness, '/api/panel')).status, 200, 'same-host reads without Origin are proxied');
  const alias = new URL(harness); alias.hostname = 'localhost';
  assert.equal((await raw(harness, '/api/panel', { headers: { host: alias.host, origin: alias.origin } })).status, 200);
  const page = await raw(harness, '/');
  assert.equal(page.status, 200);
  assert.equal(page.text.includes(TEST_CONTROL_TOKEN), false);
});

test('the development harness forwards into the real guarded backend', async t => {
  const api = await startLoadPathServer(); t.after(() => api.stop());
  const harness = await listenForTest(t, createHarnessServer(new URL(api.base), TEST_CONTROL_TOKEN));
  assert.equal((await globalThis.fetch(api.base + '/api/panel')).status, 403);
  assert.equal((await raw(harness, '/api/panel', { headers: { origin: harness } })).status, 200);
  assert.equal((await raw(harness, '/api/panel', { headers: { origin: 'http://localhost:1' } })).status, 403);
  assert.equal(api.output().includes(TEST_CONTROL_TOKEN), false);
});

test('the development harness refuses invalid startup tokens without printing them', () => {
  const entry = fileURLToPath(new URL('../renderer/harness-server.mjs', import.meta.url));
  for (const value of [undefined, '', 'short-private-value']) {
    const env = { ...process.env, OATS_DESKTOP_TOKEN: value };
    const result = spawnSync(process.execPath, [entry, '--port', '0'], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /OATS_DESKTOP_TOKEN must be set to at least 32 characters/);
    if (value) assert.equal((result.stdout + result.stderr).includes(value), false);
  }
  for (const api of ['https://127.0.0.1:4820', 'http://other.invalid:4820', 'http://127.0.0.1:4820/path'])
    assert.throws(() => createHarnessServer(new URL(api), TEST_CONTROL_TOKEN), /loopback HTTP origin/);
});
