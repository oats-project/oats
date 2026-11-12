import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { withWindowGlobals } from './helpers/main-window-globals.mjs';
import { forgeProxyOptions, installForgeAuthHandlers, trustedForgeFrame, FORGE_EPOCH_HEADER } from '../forge-proxy.mjs';
import { apiUrl, apiInit, classifyApiRoute, requestPath } from '../api-url.mjs';
import { forgeFailure } from '../renderer/forge-contract.mjs';
import { deferred } from './helpers/forge-fixture.mjs';
const url = 'file:///app/renderer/index.html';
function sender() { const mainFrame = { url }; const owner = { mainFrame, isDestroyed: () => false }; return { sender: owner, senderFrame: mainFrame }; }
test('privileged forge proxy pins workspace and overwrites ALL renderer epoch header spellings', () => {
  const body = JSON.stringify({ selector: {}, observationKey: 'e'.repeat(64) });
  const opts = forgeProxyOptions('/api/instance-forge', { method: 'POST', body,
    headers: { 'X-Oats-Forge-Epoch': 'forged', 'x-oats-forge-epoch': 'also-forged' } }, 'main:1');
  assert.equal(opts.init.body, body); assert.equal(opts.timeout, 50000);
  assert.deepEqual(Object.entries(opts.init.headers).filter(([key]) => key.toLowerCase() === FORGE_EPOCH_HEADER), [[FORGE_EPOCH_HEADER, 'main:1']]);
  assert.equal(forgeProxyOptions('/api/forge-connections', {}, 'main:1').timeout, 25000);
  for (const path of ['/api/instance-forge', '/api/instance-forge?ws=foreign']) assert.equal(apiUrl(path, 'allowed', new Set(['allowed'])).searchParams.get('ws'), 'allowed');
  assert.equal(apiUrl('/api/forge-connections', 'allowed').search, '');
  assert.equal(apiUrl('/api/instance-future', 'allowed').searchParams.get('ws'), 'allowed');
  assert.deepEqual(apiUrl('/api/instance-forge?ws=foreign&ws=allowed', 'allowed').searchParams.getAll('ws'), ['foreign', 'allowed']);
});
test('every auth IPC requires exact trusted top-level frame and resolves stable domain refusals', async () => {
  const handlers = new Map(), calls = [], methods = ['connect', 'disconnect', 'key', 'resize', 'close'];
  installForgeAuthHandlers({ ipc: { handle: (name, fn) => handlers.set(name, fn) }, rendererUrl: url,
    broker: Object.fromEntries(methods.map(name => [name, async (...args) => { calls.push({ name, args }); return { ok: true }; }])) });
  for (const [channel, handler] of handlers) {
    const args = channel.includes('resize') ? ['lease', 80, 24] : channel.includes('key') ? ['lease', 'enter'] : ['reference'];
    const event = sender(); assert.equal((await handler(event, ...args)).ok, true);
    const child = { ...event, senderFrame: { url } };
    const evil = sender(); evil.senderFrame.url = 'https://evil.example';
    for (const denied of [child, evil, { sender: event.sender }]) assert.equal((await handler(denied, ...args)).reason.code, 'E_FORBIDDEN_FRAME');
    assert.equal((await handler(event, ...args, 'extra')).reason.code, 'E_BAD_ARGS');
  }
  assert.equal(calls.length, 5); assert.equal(trustedForgeFrame(sender(), url), true);
});
function realApi(fetch) {
  const source = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8'); let handler;
  const start = source.indexOf('ipcMain.handle("api",'), end = source.indexOf('// ---- IPC: workstation forge auth', start);
  const context = { ipcMain: { handle: (_name, fn) => { handler = fn; } }, apiUrl, apiInit, classifyApiRoute, forgeProxyOptions, trustedForgeFrame,
    FORGE_EPOCH_HEADER, forgeFailure, RENDERER_URL: url, serverEpoch: 0, forgeEpoch: 'main:0',
    currentForgeEpoch: () => context.forgeEpoch, unservedRefusal: () => null, serverHost: { inTransition: () => false, held: () => () => true },
    wsId: 'team', allowedWs: new Set(['team']), requestPath, AbortSignal,
    backendFetch: (path, init) => { assert.equal(path, '/api/forge-connections', 'backendFetch takes a path'); return fetch(path, init); },
    guard: event => { assert.ok(trustedForgeFrame(event, url)); } };
  runInNewContext(source.slice(start, end), withWindowGlobals(context));
  return { handler, context };
}
test('shipped forge API IPC resolves transport/protocol failures and guards late backend/auth/frame completions', async () => {
  for (const mode of ['transport', 'protocol', 'backend', 'account', 'frame']) {
    const pending = deferred(), h = realApi(() => pending.promise), event = sender();
    const read = h.handler(event, '/api/forge-connections', { method: 'POST', body: '{}' });
    if (mode === 'backend') h.context.serverEpoch++;
    if (mode === 'account') h.context.forgeEpoch = 'main:1';
    if (mode === 'frame') event.sender.mainFrame = { url };
    if (mode === 'transport') pending.reject(new Error('PRIVATE ghp_RAW'));
    else pending.resolve({ ok: true, status: 200, text: async () => mode === 'protocol' ? 'PRIVATE ghp_RAW' : '{"forgeApi":1,"status":"connected"}' });
    const result = await read;
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|ghp_/);
    assert.equal(result.body.reason.code, mode === 'frame' ? 'E_FORBIDDEN_FRAME' : mode === 'transport' ? 'E_GH_FAILED'
      : mode === 'protocol' ? 'E_GH_PROTOCOL' : 'E_CONNECTION_CHANGED');
  }
  const h = realApi(assert.fail), event = sender();
  event.senderFrame = { url };
  assert.equal((await h.handler(event, '/api/forge-connections', {})).body.reason.code, 'E_FORBIDDEN_FRAME');
});

test('navigation during success AND rejection resolves forbidden, never leaking an exception or granting the new frame a lease', async () => {
  for (const reject of [false, true]) {
    const pending = deferred(), handlers = new Map();
    installForgeAuthHandlers({ ipc: { handle: (name, fn) => handlers.set(name, fn) }, rendererUrl: url, broker: { connect: () => pending.promise } });
    const event = sender(), result = handlers.get('forge:connect')(event, 'reference');
    event.sender.mainFrame = { url };
    if (reject) pending.reject(new Error('PRIVATE token')); else pending.resolve({ ok: true, lease: 'private old-frame lease' });
    assert.equal((await result).reason.code, 'E_FORBIDDEN_FRAME'); assert.doesNotMatch(JSON.stringify(await result), /PRIVATE|private/);
  }
});
