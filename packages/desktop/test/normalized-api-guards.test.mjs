// Real API composition callback + real specialized guards, with inert fetch.
// The generic guard intentionally matches production's URL-only check, so a
// same-URL subframe proves that normalized aliases need the specialized guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { withWindowGlobals } from './helpers/main-window-globals.mjs';
import { apiUrl, apiInit, classifyApiRoute, servedSelectors } from '../api-url.mjs';
import { forgeProxyOptions, trustedForgeFrame, FORGE_EPOCH_HEADER } from '../forge-proxy.mjs';
import { forgeFailure } from '../renderer/forge-contract.mjs';
import { lifecycleFailure } from '../../client/lifecycle-contract.mjs';
import { lifecycleFrameRefusal } from '../renderer/lifecycle-frame.mjs';
import { DESKTOP_TERMS } from '../renderer/desktop-terms.mjs';
import { proxyReadiness } from '../readiness-proxy.mjs';
import { view as readinessView } from './helpers/readiness-fixture.mjs';
const source = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
const start = source.indexOf('ipcMain.handle("api",'), end = source.indexOf('// ---- IPC: workstation forge auth', start);
assert.ok(start >= 0 && end > start);
const callback = source.slice(start, end), base = 'http://127.0.0.1:4820', renderer = 'file:///fixture/index.html';
const routes = [
  ['/api/workspace-readiness', 'readiness'], ['/api/instance-lifecycle', 'lifecycle'],
  ['/api/forge-connections', 'forge'], ['/api/instance-forge', 'forge'], ['/api/forge-roster', 'forge'], ['/api/instance-review-threads', 'forge'],
  ['/api/capabilities', 'capabilities'], ['/api/panel', 'panel'], ['/api/automations', 'automations'], ['/api/instance-git', 'instance-git'], ['/api/instance-color', 'instance-color'],
  ['/api/instance-background', 'instance-background'],
];
const guarded = routes.slice(0, 4);
const slash = String.fromCharCode(92);
function aliases(path) {
  const leaf = path.slice('/api/'.length);
  return [path, `/api/./${leaf}`, `/api/unused/../${leaf}`, `/api/%2e/${leaf}`, `/api/unused/%2E%2E/${leaf}`,
    `/api${slash}${leaf}`, `/api${slash}unused${slash}..${slash}${leaf}`, `/a\tpi/${leaf}`, `/api/${leaf.slice(0, 2)}\r\n${leaf.slice(2)}`];
}
function fixture({ classify = classifyApiRoute, fetch } = {}) {
  let handler;
  const frame = { url: renderer }, sender = { mainFrame: frame, isDestroyed: () => false }, event = { sender, senderFrame: frame }, calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    if (fetch) return fetch(url, init);
    const body = url.pathname === '/api/workspace-readiness' ? readinessView() : { marker: 'fixture-result', workspaces: [{ id: 'team' }, { id: 'other' }] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const context = { ipcMain: { handle: (_channel, fn) => handler = fn }, apiUrl, apiInit, servedSelectors, classifyApiRoute: classify, forgeProxyOptions,
    trustedForgeFrame, FORGE_EPOCH_HEADER, forgeFailure, lifecycleFailure, lifecycleFrameRefusal, DESKTOP_TERMS,
    proxyReadiness: (event, path, opts, deps) => proxyReadiness(event, path, opts, { ...deps, fetch: fakeFetch }),
    RENDERER_URL: renderer, serverEpoch: 0, forgeEpoch: 'fixture:0', inTransition: false,
    unservedRefusal: () => null, serverHost: { inTransition: () => context.inTransition }, currentForgeEpoch: () => context.forgeEpoch,
    base: () => base, wsId: 'team', allowedWs: new Set(['team', 'other']), Set,
    fetch: fakeFetch, AbortSignal: { timeout: ms => ({ timeout: ms }) },
    guard: event => { const url = event.senderFrame?.url || ''; if (url !== renderer && !url.startsWith(`${renderer}#`)) throw Error('forbidden generic frame'); },
  };
  runInNewContext(callback, withWindowGlobals(context));
  return { context, event, calls, call: (path, opts = { method: 'POST', body: '{}' }, eventOverride = event) => handler(eventOverride, path, opts) };
}
for (const [path, kind] of routes) test(`${kind} ${path}: one classifier uses the exact normalized pathname`, () => {
  for (const alias of aliases(path)) for (const suffix of ['', '?ws=team#fragment']) assert.equal(classifyApiRoute(alias + suffix, base), kind, alias);
  for (const other of [path + '/', path + '-other', path.replace('/api/', '/api%2f/'), `/elsewhere?next=${path}`, `/elsewhere#${path}`]) {
    assert.equal(classifyApiRoute(other, base), null, 'no extra decoding or prefix match');
  }
});
test('classification is not authority: malformed input is harmless and off-origin aliases still fail apiUrl', () => {
  for (const bad of [null, undefined, {}, [], 1, 'http://[']) assert.equal(classifyApiRoute(bad, base), null);
  for (const [path, kind] of guarded) for (const input of [`//evil.invalid${path}`, `/${slash}evil.invalid${path}`, `https://evil.invalid${path}`]) {
    assert.equal(classifyApiRoute(input, base), kind);
    assert.throws(() => apiUrl(input, base, 'team'));
  }
});
async function assertDenied(path, classify = classifyApiRoute) {
  for (const alias of aliases(path)) {
    const f = fixture({ classify });
    const child = { ...f.event, senderFrame: { url: renderer } }; // generic URL guard would permit this
    const result = await f.call(alias, undefined, child);
    assert.equal(f.calls.length, 0, `${alias}: specialized main-frame guard must execute BEFORE fetch`);
    assert.equal(result.status, 403); assert.equal(result.body.reason.code, 'E_FORBIDDEN_FRAME');
  }
}
for (const [path] of guarded) test(`${path}: every alias denies a same-URL subframe with zero dispatch`, () => assertDenied(path));
for (const [path] of guarded) test(`${path}: normalized off-origin and malformed authority cannot reach upstream`, async () => {
  for (const alias of [`//evil.invalid${path}`, `/${slash}evil.invalid${path}`, `https://evil.invalid${path}`]) {
    const f = fixture(); const result = await f.call(alias);
    assert.equal(f.calls.length, 0); assert.equal(result.ok, false); assert.equal(result.body.status, 'unavailable');
  }
});
for (const [path, kind] of routes) test(`${path}: valid aliases preserve workspace/body/deadline/forge epoch and panel behavior`, async () => {
  for (const alias of aliases(path)) {
    const f = fixture(); const body = JSON.stringify({ action: 'plan' });
    const result = await f.call(`${alias}${kind === 'forge' && path.endsWith('connections') ? '' : '?ws=team'}`, { method: 'POST', body,
      headers: { 'X-Oats-Forge-Epoch': 'forged', 'x-oats-forge-epoch': 'forged-again' } });
    assert.equal(result.ok, true); assert.equal(f.calls.length, 1);
    const { url, init } = f.calls[0]; assert.equal(url.pathname, path); assert.equal(url.origin, base); assert.equal(init.body, body);
    if (kind === 'lifecycle' || kind === 'readiness' || path === '/api/instance-forge') assert.equal(url.searchParams.get('ws'), 'team');
    if (kind === 'forge') {
      assert.deepEqual([...new Headers(init.headers)].filter(([k]) => k.toLowerCase() === FORGE_EPOCH_HEADER), [[FORGE_EPOCH_HEADER, 'fixture:0']]);
      assert.equal(init.signal.timeout, ['/api/instance-forge', '/api/forge-roster', '/api/instance-review-threads'].includes(path) ? 50000 : 25000);
    } else if (kind !== 'readiness') assert.equal(init.signal.timeout, kind === 'lifecycle' || kind === 'instance-git' || kind === 'instance-color' || kind === 'instance-background' ? 50000 : kind === 'capabilities' ? 310000 : kind === 'automations' ? 90000 : 20000);
    if (kind === 'panel') assert.deepEqual([...f.context.allowedWs], ['team', 'other']);
  }
});
test('lifecycle apply aliases keep the mutation deadline and lost-result unknown semantics, including serialized bodies', async () => {
  for (const alias of aliases('/api/instance-lifecycle')) for (const serialized of [false, true]) {
    const f = fixture({ fetch: async () => { throw Error('PRIVATE transport'); } });
    const body = { action: 'apply', planRef: 'opaque' };
    const result = await f.call(alias, { method: 'POST', body: serialized ? JSON.stringify(body) : body });
    assert.equal(f.calls[0].init.signal.timeout, 610000); assert.deepEqual(JSON.parse(f.calls[0].init.body), body);
    assert.equal(result.body.status, 'unknown'); assert.equal(result.body.reason.code, 'E_OUTCOME_UNKNOWN');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
});
async function completed(path, mode, rejected, action = 'plan') {
  let resolve, reject; const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
  const f = fixture({ fetch: () => pending });
  const result = f.call(path, { method: 'POST', body: JSON.stringify({ action }) });
  if (mode === 'frame') f.event.sender.mainFrame = { url: renderer };
  else if (mode === 'navigation') f.event.senderFrame.url = 'https://evil.invalid';
  else if (mode === 'backend') f.context.serverEpoch++;
  else if (mode === 'transition') f.context.inTransition = true;
  else if (mode === 'account') f.context.forgeEpoch = 'fixture:1';
  if (rejected) reject(Error('PRIVATE transport'));
  else resolve({ ok: true, status: 200, text: async () => mode === 'protocol' ? 'PRIVATE invalid JSON' : JSON.stringify(readinessView()) });
  const response = await result;
  assert.doesNotMatch(JSON.stringify(response), /PRIVATE/);
  // Separate VM callback evaluations have different object prototypes. Compare
  // the serialized IPC payload, not VM prototype identity.
  return JSON.parse(JSON.stringify(response));
}
for (const [path, kind] of guarded) for (const rejected of [false, true]) test(`${path}: aliases preserve late ${rejected ? 'rejection' : 'success'} frame/epoch/typed-error decisions`, async () => {
  for (const mode of ['frame', 'navigation', 'backend', 'transition', 'protocol', ...(kind === 'forge' ? ['account'] : [])]) {
    const canonical = await completed(path, mode, rejected);
    assert.ok(canonical.body.reason?.code, `${mode}: expected a domain error, not raw data`);
    if (mode === 'frame' || mode === 'navigation') assert.equal(canonical.body.reason.code, 'E_FORBIDDEN_FRAME');
    for (const alias of aliases(path).slice(1)) assert.deepEqual(await completed(alias, mode, rejected), canonical, `${alias}: ${mode}`);
  }
});
test('lifecycle apply backend replacement remains unknown for every normalized alias', async () => {
  for (const alias of aliases('/api/instance-lifecycle')) for (const rejected of [false, true]) {
    const result = await completed(alias, 'backend', rejected, 'apply');
    assert.equal(result.body.status, 'unknown'); assert.equal(result.body.reason.code, 'E_OUTCOME_UNKNOWN');
  }
});
test('duplicate workspace query survives normalization for strict backend refusal', async () => {
  for (const path of ['/api/instance-lifecycle', '/api/instance-forge', '/api/workspace-readiness', '/api/automations', '/api/forge-roster']) {
    const f = fixture(); await f.call(aliases(path)[1] + '?ws=team&ws=other');
    assert.deepEqual(f.calls[0].url.searchParams.getAll('ws'), ['team', 'other']);
  }
});
for (const [path, kind] of guarded) test(`mutation: ${kind} ${path} denial fails when normalization is removed`, async () => {
  const original = classifyApiRoute.toString(), from = 'new URL(pathname, base).pathname';
  assert.equal(original.split(from).length, 2);
  const mutant = runInNewContext(`(${original.replace(from, "pathname.split(/[?#]/, 1)[0]")})`, { URL });
  await assert.rejects(assertDenied(path, mutant), /specialized main-frame guard must execute BEFORE fetch/);
});

test('automations: the verified workspace is pinned unless the server advertises the one asked; trigger test gets its deadline', async () => {
  for (const [suffix, ws] of [['', 'team'], ['?ws=other', 'other'], ['?ws=elsewhere', 'team']]) {
    const f = fixture(); await f.call('/api/automations' + suffix, { method: 'POST', body: JSON.stringify({ kind: 'trigger', action: 'test', key: 'agents/pr-review' }) });
    assert.deepEqual(f.calls[0].url.searchParams.getAll('ws'), [ws], suffix || 'no ws');
    assert.equal(f.calls[0].init.signal.timeout, 90_000);
  }
});
