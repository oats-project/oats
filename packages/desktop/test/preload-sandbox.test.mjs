// Pinned at 53743f55a87be69afb81cfdbfe4dac6e1be414a6, before bundling.
// The five existing preload suites and terminal-wire-io keep exercising source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import { probeSandbox } from '../scripts/sandbox-probe.mjs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const bundle = read('generated/preload.cjs');
const plain = value => JSON.parse(JSON.stringify(value));
// Every world, key, value type and function arity, including the agent view's termWrite.
const surface = { oatsDesktop: {
  isOmarchy: 'boolean', api: 2,
  termOpen: 1, termReady: 1, termClose: 1, termWrite: 2, termResize: 3,
  termAttachFiles: 2, onTermData: 2, onTermExit: 2,
  forgeConnect: 1, forgeDisconnect: 1, forgeAuthKey: 2, forgeAuthResize: 3,
  forgeAuthClose: 1, onForgeChanged: 1, onForgeAuthData: 2, onForgeAuthExit: 2,
  hostTheme: 0, onHostThemeChanged: 1, chordFamily: 0, setChordFamily: 1,
  onChordFamilyChanged: 1, workspaceSuggestions: 0, workspaceAdd: 1,
  workspacePick: 0, workspaceOnboard: 2, workspaceRemoveListed: 1,
  windowClaimWorkspace: 2, onWorkspaceRelease: 1, windowReleaseAnswer: 2,
  onLaunchFocus: 1, windowChoices: 0, windowOpenWorkspace: 1,
  cliPickBinary: 0, onAppFocus: 1,
} };

function load(source, argv = [], bundled = true) {
  const worlds = {}, calls = [], required = [];
  const ipc = new EventEmitter();
  let reply = null;
  ipc.invoke = async (...args) => { calls.push(['invoke', ...args]); return reply; };
  ipc.send = (...args) => calls.push(['send', ...args]);
  const electron = {
    contextBridge: { exposeInMainWorld(name, api) { assert.ok(!Object.hasOwn(worlds, name)); worlds[name] = api; } },
    ipcRenderer: ipc, webUtils: { getPathForFile: file => file.path ?? '' },
  };
  // Electron 43's sandbox has Buffer and these process fields; no Node process fallback.
  const process = new Proxy({ argv, platform: 'linux', env: {}, versions: {} }, {
    get(target, key) { assert.ok(Object.hasOwn(target, key), `unsupported process.${String(key)}`); return target[key]; },
  });
  const context = { process, Buffer, require(name) {
    required.push(name);
    if (name === 'electron') return electron;
    assert.equal(bundled, false, `sandbox cannot require ${name}`);
    assert.equal(name, './terminal-bridge.cjs');
    const module = { exports: {} };
    runInNewContext(read('terminal-bridge.cjs'), { module, Buffer });
    return module.exports;
  } };
  runInNewContext(source, context);
  return { worlds, ipc, calls, required, reply(value) { reply = value; } };
}

const describe = worlds => Object.fromEntries(Object.entries(worlds).map(([name, api]) => [name,
  Object.fromEntries(Object.entries(api).map(([key, value]) => [key, typeof value === 'function' ? value.length : typeof value])),
]));

test('source and electron-only bundled preload expose exactly the pinned worlds, keys and arities', () => {
  assert.deepEqual(describe(load(read('preload.cjs'), [], false).worlds), surface);
  const p = load(bundle);
  assert.deepEqual(p.required, ['electron']);
  assert.deepEqual(describe(p.worlds), surface);
  assert.deepEqual(p.calls, []);
});

test('built text requires only electron, with no dynamic require, path, builtin or unsupported process member', () => {
  const requires = [...bundle.matchAll(/\brequire\s*\(([^)]*)\)/g)].map(match => match[1].trim());
  assert.deepEqual(requires, ['"electron"']);
  for (const [, member] of bundle.matchAll(/\bprocess\s*\.\s*([\w$]+)/g))
    assert.ok(['argv', 'platform', 'env', 'versions'].includes(member), `process.${member}`);
  assert.doesNotMatch(bundle, /\bprocess\s*\[/, 'no computed process access');
  const main = read('main.mjs');
  assert.match(main, /preload: join\(HERE, "generated", "preload\.cjs"\)/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.doesNotMatch(read('scripts/dist-smoke.mjs'), /["']--no-sandbox["']/);
});

for (const sandboxed of [true, false]) test(`CDP sandbox probe reads the preload call frame and resumes execution when sandboxed=${sandboxed}`, async () => {
  const listeners = new Set(), calls = [];
  let resumed;
  const reload = new Promise(resolve => { resumed = resolve; });
  const emit = event => { for (const listener of [...listeners]) listener(event); };
  const cdp = { listeners, async command(method, params) {
    calls.push(method);
    if (method === 'Debugger.enable') emit({ method: 'Debugger.scriptParsed', params: { scriptId: 'preload', url: 'file:///app/generated/preload.cjs' } });
    if (method === 'Debugger.getScriptSource') return { scriptSource: bundle };
    if (method === 'Page.reload') { emit({ method: 'Debugger.paused', params: { callFrames: [{ callFrameId: 'preload-frame' }] } }); return reload; }
    if (method === 'Debugger.evaluateOnCallFrame') {
      assert.equal(params.callFrameId, 'preload-frame');
      assert.equal(params.expression, '({ sandboxed: process.sandboxed, isolated: process.contextIsolated })');
      return { result: { value: { sandboxed, isolated: true } } };
    }
    if (method === 'Debugger.resume') resumed({});
    return {};
  } };
  if (sandboxed) assert.deepEqual(await probeSandbox(cdp), { sandboxed: true, isolated: true });
  else await assert.rejects(probeSandbox(cdp), /preload is not sandboxed/);
  assert.ok(calls.indexOf('Debugger.evaluateOnCallFrame') < calls.indexOf('Debugger.resume'));
  assert.equal(calls.at(-1), 'Debugger.disable');
  assert.equal(listeners.size, 0);
});

test('bundled Omarchy flag still uses the exact argv value without sending IPC', () => {
  for (const [argv, expected] of [[[], false], [['--oats-host-omarchy'], true], [['--oats-host-omarchy=1'], false]]) {
    const p = load(bundle, argv);
    assert.equal(p.worlds.oatsDesktop.isOmarchy, expected);
    assert.deepEqual(p.calls, []);
  }
});

test('bundled invocation methods preserve every IPC channel, argument order and result', async () => {
  const p = load(bundle), api = p.worlds.oatsDesktop;
  const methods = {
    api: 'api', forgeConnect: 'forge:connect', forgeDisconnect: 'forge:disconnect',
    forgeAuthKey: 'forge:auth-key', forgeAuthResize: 'forge:auth-resize', forgeAuthClose: 'forge:auth-close',
    hostTheme: 'host-theme:get', chordFamily: 'chord-family:get', setChordFamily: 'chord-family:set',
    workspaceSuggestions: 'workspace:suggestions', workspaceAdd: 'workspace:add', workspacePick: 'workspace:pick',
    workspaceOnboard: 'workspace:onboard', workspaceRemoveListed: 'workspace:remove-listed',
    windowClaimWorkspace: 'window:claim-workspace', windowReleaseAnswer: 'window:release-answer',
    windowChoices: 'window:choices', windowOpenWorkspace: 'window:open-workspace', cliPickBinary: 'cli:pick',
  };
  p.reply({ ok: true, marker: 'unchanged' });
  for (const [method, channel] of Object.entries(methods)) {
    const args = Array.from({ length: api[method].length }, (_, i) => `argument-${i}`);
    assert.deepEqual(await api[method](...args), { ok: true, marker: 'unchanged' });
    assert.deepEqual(p.calls.at(-1), ['invoke', channel, ...args]);
  }
});

test('bundled subscriptions strip IPC events, unsubscribe, and retain early focus and release requests', () => {
  const p = load(bundle), api = p.worlds.oatsDesktop;
  const focus = { deployment: '/fixture', name: 'probe' }, release = { request: 1, workspace: '/fixture' };
  p.ipc.emit('window:focus-instance', {}, focus);
  p.ipc.emit('window:release-workspace', {}, release);
  for (const [method, channel, args, value] of [
    ['onLaunchFocus', 'window:focus-instance', [], focus], ['onWorkspaceRelease', 'window:release-workspace', [], release],
    ['onHostThemeChanged', 'host-theme:changed', [], { mode: 'dark' }],
    ['onChordFamilyChanged', 'chord-family:changed', [], { family: 'alt' }],
    ['onForgeChanged', 'forge:changed', [], 7], ['onForgeAuthData', 'forge:auth-data:lease', ['lease'], 'data'],
    ['onForgeAuthExit', 'forge:auth-exit:lease', ['lease'], { exitCode: 0 }], ['onAppFocus', 'app:focus', [], undefined],
  ]) {
    const heard = [], off = api[method](...args, (...values) => heard.push(values));
    if (['onLaunchFocus', 'onWorkspaceRelease'].includes(method)) assert.deepEqual(heard.shift(), [value]);
    p.ipc.emit(channel, { privateEvent: true }, value);
    assert.deepEqual(heard, method === 'onAppFocus' ? [[]] : [[value]]);
    off(); p.ipc.emit(channel, {}, value);
    assert.equal(heard.length, 1);
  }
});

test('bundled terminal opens, subscribes, writes UTF8, resizes, attaches native files and closes with its original lease', async () => {
  const p = load(bundle), api = p.worlds.oatsDesktop;
  const h = { id: 1, lease: 'a'.repeat(64) }, spec = { session: 'fixture', window: 'probe', socket: '/fixture/socket' };
  p.reply({ terminalApi: 2, ok: true, status: 'opened', handle: h });
  assert.equal((await api.termOpen(spec)).status, 'opened');
  assert.deepEqual(p.calls.at(-1), ['invoke', 'term:open', spec]);
  const data = [], exits = [], off = api.onTermData(h, value => data.push(value)), offExit = api.onTermExit(h, value => exits.push(value));
  p.reply({ terminalApi: 2, ok: true, status: 'ready', handle: h });
  assert.equal((await api.termReady(h)).status, 'ready');
  assert.deepEqual(plain(p.calls.at(-1)), ['invoke', 'term:ready', h]);
  p.ipc.emit(`term:data:${h.lease}`, { privateEvent: true }, 'output');
  assert.deepEqual(data, ['output']);
  const text = '\x03' + 'x'.repeat(65532) + '😀λ'.repeat(22000) + '\n';
  assert.equal(api.termWrite(h, text).ok, true);
  const chunks = p.calls.filter(call => call[0] === 'send' && call[1] === 'term:write');
  assert.ok(chunks.length > 1); assert.equal(chunks.map(call => call[3]).join(''), text);
  for (const [, , copy, chunk] of chunks) { assert.deepEqual(plain(copy), h); assert.notEqual(copy, h); assert.ok(Buffer.byteLength(chunk) <= 65536); assert.ok(chunk.isWellFormed()); }
  const before = p.calls.length;
  assert.equal(api.termWrite(h, '😀'.repeat(300000)).code, 'E_TERM_INPUT_LIMIT');
  assert.equal(api.termWrite(h, '\ud800').code, 'E_TERM_BAD_ARGS');
  assert.equal(p.calls.length, before);
  assert.equal(api.termResize(h, 80, 24).ok, true);
  assert.deepEqual(plain(p.calls.at(-1)), ['send', 'term:resize', h, 80, 24]);
  p.reply({ terminalApi: 2, ok: true, paths: ['/fixture/drop.txt'] });
  assert.deepEqual(plain(await api.termAttachFiles(h, [{ size: 1, path: '/fixture/drop.txt' }])),
    { terminalApi: 2, ok: true, status: 'attached', paths: ['/fixture/drop.txt'] });
  assert.deepEqual(plain(p.calls.at(-1)), ['invoke', 'term:attachments', h, [{ path: '/fixture/drop.txt' }]]);
  const exit = { terminalApi: 2, handle: h, status: 'closed', cleanupPending: false };
  p.ipc.emit(`term:exit:${h.lease}`, {}, exit); assert.deepEqual(exits, [exit]);
  off(); offExit(); assert.equal(p.ipc.listenerCount(`term:data:${h.lease}`), 0); assert.equal(p.ipc.listenerCount(`term:exit:${h.lease}`), 0);
  p.reply({ terminalApi: 2, ok: true, status: 'closed', handle: h });
  assert.equal((await api.termClose(h)).status, 'closed');
  assert.deepEqual(plain(p.calls.at(-1)), ['invoke', 'term:close', h]);
});
