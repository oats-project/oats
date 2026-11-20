import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { join } from 'node:path';
import { createTerminalOwnerBroker, installTerminalHandlers } from '../terminal-owner.mjs';
import { createTerminalIo, readTerminalCli } from '../terminal-io.mjs';
import { runTerminalCommand } from '../../client/terminal-exec.mjs';
import { prepareTerminalAttachments } from '../terminal-attachments.mjs';
import { handle, opened, confirmed, ready } from './helpers/terminal-wire.mjs';
import { workspaceHash, trustedRendererUrl, frameWorkspace } from '../renderer/window-binding.mjs';
import { windowTitle, clampBounds } from '../window-records.mjs';
const { createTerminalBridge } = createRequire(import.meta.url)('../terminal-bridge.cjs');
const flush = () => new Promise(setImmediate);
const cli = { ok: true, bin: '/memory/oats', version: '0.24.13', remote: ['session', 'session-upload'], features: [] };
const spec = { remote: { serverId: 'peer', instance: 'one', home: '/memory/home' }, cols: 80, rows: 24 };
const response = value => new Response(JSON.stringify(value));
/** Main's backendFetch for the CLI read: it takes the path of the server's accepted CLI, never a URL. */
const cliRead = reply => async path => { assert.equal(path, '/api/cli', 'the CLI is read by its path'); return reply(); };

test('preload chunks UTF8 at codepoint boundaries, keeps Ctrl bytes; caller overflow refused BEFORE any send', () => {
  const calls = [], ipc = { send: (...args) => calls.push(args) }, bridge = createTerminalBridge(ipc, {});
  const h = handle(1), text = '\x03' + 'x'.repeat(65532) + '😀λ'.repeat(22000) + '\n';
  assert.equal(bridge.termWrite(h, text).ok, true);
  assert.ok(calls.length > 1); assert.equal(calls.map(c => c[2]).join(''), text);
  for (const [name, copied, chunk] of calls) { assert.equal(name, 'term:write'); assert.deepEqual(copied, h); assert.notEqual(copied, h); assert.ok(Buffer.byteLength(chunk) <= 65536); assert.ok(chunk.isWellFormed()); }
  calls.length = 0;
  assert.equal(bridge.termWrite(h, '😀'.repeat(300000)).code, 'E_TERM_INPUT_LIMIT'); assert.equal(calls.length, 0);
  assert.equal(bridge.termWrite(1, 'bad').ok, false); assert.equal(calls.length, 0);
});

test('preload forwards a term:open E_HERDR_REMOVED refusal with its code and message; any other non-terminal code stays a transport failure', async () => {
  const message = 'Herdr is no longer supported by OATS (removed in 0.31.0); tmux is the only session backend.';
  for (const [code, expected] of [['E_HERDR_REMOVED', 'E_HERDR_REMOVED'], ['E_HERDR_OTHER', 'E_TERM_TRANSPORT'], ['E_SECRET', 'E_TERM_TRANSPORT']]) {
    const ipc = { send() {}, invoke: async () => ({ terminalApi: 2, ok: false, code, message }) };
    const result = await createTerminalBridge(ipc, {}).termOpen({ sessionTarget: { backend: 'herdr' } });
    assert.equal(result.code, expected, code);
    if (expected === code) assert.equal(result.message, message);
  }
});

test('preload resolving results, copied handles and lease channels do not implement a mutable id->lease alias', async () => {
  const ipc = new EventEmitter(), calls = [];
  ipc.send = (...args) => calls.push(args);
  ipc.invoke = async (name, h) => { calls.push([name, h]); return name === 'term:open' ? opened(7) : name === 'term:ready' ? ready(h) : confirmed(h); };
  const b = createTerminalBridge(ipc, {}), result = await b.termOpen({}), h = { ...result.handle }, old = { ...h }, seen = [];
  const off = b.onTermData(h, data => seen.push(data)); h.lease = 'b'.repeat(64);
  ipc.emit(`term:data:${h.lease}`, {}, 'wrong'); ipc.emit(`term:data:${old.lease}`, {}, 'original');
  assert.deepEqual(seen, ['original']); off(); assert.equal(ipc.listenerCount(`term:data:${old.lease}`), 0);
  assert.equal((await b.termClose(old)).status, 'closed'); assert.equal(calls.at(-1)[0], 'term:close');
  assert.equal((await b.termClose(7)).code, 'E_TERM_LEASE');
  ipc.invoke = async () => { throw new Error('private native path'); };
  assert.equal((await b.termReady(old)).code, 'E_TERM_TRANSPORT');
  ipc.invoke = async () => ({ id: 7 }); assert.equal((await b.termOpen({})).code, 'E_TERM_TRANSPORT');
});

test('owned command promise does not settle on AbortError until the child close is confirmed', async () => {
  const child = new EventEmitter(); let callback, settled = false;
  const work = runTerminalCommand('/memory/oats', ['session', 'inspect'], { timeout: 20 }, (_bin, _args, opts, cb) => {
    assert.equal(opts.shell, false); callback = cb; return child;
  }).then(() => { settled = true; }, () => { settled = true; });
  callback(Object.assign(new Error('aborted'), { name: 'AbortError' }), '', ''); await flush();
  assert.equal(settled, false); child.emit('close', 1); await work; assert.equal(settled, true);
});

test('a remote Herdr session never reaches a PTY: an older kernel inspection and a 0.31 refusal are E_HERDR_REMOVED', async () => {
  for (const stdout of ['{"schemaVersion":1,"ok":true,"result":{"backend":"herdr","present":true,"state":"shell","terminalId":"term_abc"}}',
    '{"schemaVersion":1,"ok":false,"error":{"code":"E_HERDR_REMOVED","message":"E_HERDR_REMOVED: removed"}}']) {
    const commands = [], ptys = [];
    const io = createTerminalIo({ context: () => 'epoch', attachmentDirectory: () => '/memory/files',
      spawnPty: (...args) => { ptys.push(args); return {}; }, execFileSync: () => assert.fail('not local'),
      fetch: cliRead(() => response(cli)), run: async (bin, args) => { commands.push(args); return { stdout }; },
    });
    await assert.rejects(io.prepare(io.admit(structuredClone(spec)).spec, { current: () => true }), error => error.code === 'E_HERDR_REMOVED');
    assert.deepEqual(commands.map(args => args[1]), ['inspect'], 'inspected, never attached');
    assert.deepEqual(ptys, []);
  }
});

test('a failed command keeps its bounded stdout on the rejection, still only after the child close', async () => {
  const child = new EventEmitter(); let callback, settled = false;
  const work = runTerminalCommand('/memory/oats', ['session', 'inspect'], { timeout: 20 }, (_bin, _args, _opts, cb) => { callback = cb; return child; });
  work.catch(() => {}).finally(() => { settled = true; });
  callback(Object.assign(new Error('Command failed'), { code: 1 }), '{"ok":false}', 'private stderr'); await flush();
  assert.equal(settled, false); child.emit('close', 1);
  await assert.rejects(work, error => error.code === 1 && error.stdout === '{"ok":false}' && error.stderr === undefined);
});

test('remote preparation uses fixed CLI arguments, rechecks identity, and never creates from stale metadata', async () => {
  let reads = 0; const commands = [];
  const io = createTerminalIo({ context: () => 'epoch', attachmentDirectory: () => '/memory/files',
    spawnPty: () => assert.fail('prepare must not create'), execFileSync: () => assert.fail('not local'),
    fetch: cliRead(() => response(++reads === 2 ? { ...cli, bin: '/memory/other' } : cli)),
    run: async (bin, args, options) => { commands.push({ bin, args, options }); return { stdout: '{"schemaVersion":1,"ok":true,"result":{"present":true}}' }; },
  });
  await assert.rejects(io.prepare(spec, { current: () => true }), error => error.code === 'E_TERM_CONTEXT_CHANGED');
  assert.equal(commands.length, 1); assert.equal(commands[0].bin, cli.bin);
  assert.deepEqual(commands[0].args, ['session', 'inspect', '--server', 'peer', '--home', '/memory/home', '--json']);
  assert.equal(commands[0].options.shell, false); assert.equal(commands[0].options.timeout, 20000);
});

test('CLI metadata stream is bounded before retaining oversize chunk; it is read by its path alone; a stale read refuses', async () => {
  let cancelled = 0, reads = 0;
  const body = { getReader: () => ({
    read: async () => ++reads === 1 ? { done: false, value: new Uint8Array(1024 * 1024 + 1) } : { done: true },
    cancel: async () => { cancelled++; }, releaseLock() {},
  }) };
  await assert.rejects(readTerminalCli({ current: () => true, fetch: cliRead(async () => ({ ok: true, body })) }), /budget/);
  assert.equal(cancelled, 1); assert.equal(reads, 1);
  // Where the read goes is not the caller's to name: it hands backendFetch (main's own server, path-only
  // input: backend-client.test.mjs) the fixed path, and nothing else.
  const asked = [];
  assert.deepEqual(await readTerminalCli({ current: () => true, fetch: async (...args) => { asked.push(args[0]); return response(cli); } }), cli);
  assert.deepEqual(asked, ['/api/cli']);
  let current = true;
  await assert.rejects(readTerminalCli({ current: () => current, fetch: cliRead(async () => { current = false; return response(cli); }) }), error => error.code === 'E_TERM_CONTEXT_CHANGED');
});

for (const stop of ['stat', 'mkdir', 'write', 'upload']) test(`attachment revocation after ${stop} stops later effects; no rollback/delete claim`, async () => {
  let current = true; const effects = [];
  const checkpoint = name => { effects.push(name); if (stop === name) current = false; };
  const fs = {
    stat: async () => { checkpoint('stat'); return { isFile: () => true, size: 1 }; },
    mkdir: async () => { checkpoint('mkdir'); }, writeFile: async () => { checkpoint('write'); },
  };
  const items = stop === 'stat' ? [{ path: '/memory/file' }] : [{ type: 'image/png', bytes: new Uint8Array([1]) }, { type: 'image/png', bytes: new Uint8Array([2]) }];
  await assert.rejects(prepareTerminalAttachments(items, { directory: '/memory/images', remote: spec.remote, cli, fs, current: () => current,
    run: async () => { checkpoint('upload'); return { stdout: '{"schemaVersion":1,"ok":true,"result":{"path":"/memory/remote"}}' }; },
  }), error => error.code === 'E_TERM_ATTACHMENT_INTERRUPTED');
  assert.equal(effects.at(-1), stop); assert.equal(effects.filter(x => x === stop).length, 1);
});

test('actual quit wiring waits for bounded cleanup once; existing signals reenter it without a new signal policy', async () => {
  const source = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
  const shutdown = source.match(/async function shutdown\(\)[^]*?\n\}/)[0];
  const tail = source.slice(source.indexOf('let quitStarted ='));
  const app = new EventEmitter(), signals = new Map(), log = []; let finish, prevented = 0;
  const gate = new Promise(resolve => { finish = resolve; });
  app.quit = () => { log.push('quit'); app.emit('before-quit', { preventDefault() { prevented++; } }); };
  runInNewContext(`${shutdown}\n${tail}`, { app, primaryInstance: true, process: { on: (name, fn) => signals.set(name, fn) },
    forgeAuth: { dispose: () => log.push('forge') }, terminalBroker: { dispose: () => { log.push('terminal'); return gate; } },
    sweepOrphanViewers: () => log.push('sweep'), serverHost: { stop: () => log.push('server') },
  });
  app.quit(); signals.get('SIGTERM')();
  assert.equal(log.filter(v => v === 'terminal').length, 1); assert.ok(!log.includes('server')); assert.equal(prevented, 2);
  finish(); await flush();
  assert.deepEqual(log.slice(-3), ['sweep', 'server', 'quit']); assert.equal(prevented, 2);
  assert.deepEqual([...signals.keys()], ['SIGTERM', 'SIGINT', 'SIGHUP']);
});

test('actual main composition registers owner BEFORE load and uses shared broker handlers, fixed local IO and lease bridge', async () => {
  const source = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
  const mainBlock = source.slice(source.indexOf('const terminalContext ='), source.indexOf('const tmuxRun ='));
  const windowBlock = source.match(/function createWindow\(workspaceId, record = null\)[^]*?\n\}/)[0];
  const ipc = new EventEmitter(), invokes = new Map(), inputs = [], commands = [], native = {};
  ipc.handle = (name, fn) => invokes.set(name, fn);
  const url = 'file:///memory/renderer/index.html'; let window;
  const loads = [];
  class FakeWindow extends EventEmitter {
    constructor() {
      super(); window = this; this.webContents = new EventEmitter(); const wc = this.webContents; wc.id = 7;
      wc.isDestroyed = () => false; wc.mainFrame = { url: 'about:blank', send: (channel, value) => renderer.emit(channel, {}, value) };
      wc.setWindowOpenHandler = () => {};
    }
    async loadFile(_file, options) {
      assert.equal(this.webContents.listenerCount('did-start-navigation'), 1, 'hooks precede initial document load');
      loads.push(options);
      this.webContents.mainFrame.url = `${url}#${options.hash}`; this.webContents.emit('did-finish-load');
    }
  }
  const renderer = new EventEmitter();
  const event = () => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  renderer.invoke = (name, ...args) => invokes.get(name)(event(), ...args);
  renderer.send = (name, ...args) => ipc.emit(name, event(), ...args);
  const backendFetch = cliRead(() => response(cli));
  const vm = runInNewContext(`${mainBlock}\n${windowBlock}\n({createWindow, terminalBroker})`, {
    createTerminalOwnerBroker, createTerminalIo: options => { assert.equal(options.fetch, backendFetch, 'the terminal IO reads through main\'s backendFetch'); return createTerminalIo({ ...options,
      run: async (bin, args) => { commands.push([bin, args]); return { stdout: '' }; },
    }); }, installTerminalHandlers,
    RENDERER_URL: url, ipcMain: ipc, backendFetch, serverEpoch: 1, serverHost: { inTransition: () => false, lease: () => ({ generation: 1 }) },
    app: { getPath: () => '/memory/app' }, HERE: '/memory', join, BrowserWindow: Object.assign(FakeWindow, { fromWebContents: () => window }),
    // The terminal frame gate (#1488): the window opens terminals of the workspace main binds it to.
    frameWorkspace, choosers: new Set(), holdsHash: (win, id) => win === window && id === '/memory/ws',
    sweepOrphanViewers() {}, shell: {}, Menu: {}, invalidateTerminalPreparations: null,
    // One window per workspace (#481): the window's workspace, title, records and registry.
    workspaceHash, trustedRendererUrl, windowTitle, clampBounds, servedList: [], screen: { getAllDisplays: () => [] }, omarchyArguments: [],
    windows: { focused() {}, remove() {}, keyOf: () => '/memory/ws' }, windowRecords: null, quitStarted: false, served: () => true,
    windowState: () => null, suggestionCalls: { forget() {} }, lastPickChoices: new Map(), console,
    execFileSync: (bin, args) => { commands.push([bin, args]); return args.includes('new-session') ? '@81' : ''; },
    pty: { spawn: (bin, args) => { commands.push([bin, args]); return {
      onExit: cb => { native.exit = cb; }, onData: cb => { native.data = cb; },
      write: data => inputs.push(data), resize() {}, kill: () => native.exit({ exitCode: 0 }),
    }; } },
  });
  await vm.createWindow('/memory/ws');
  assert.deepEqual(JSON.parse(JSON.stringify(loads)), [{ hash: workspaceHash('/memory/ws').slice(1) }], 'the window loads bound to its workspace');
  const bridge = createTerminalBridge(renderer, {}), result = await bridge.termOpen({ session: 'agents', window: 'one', socket: '/memory/socket' });
  assert.equal(result.status, 'opened'); assert.ok(invokes.has('term:close')); assert.equal(ipc.listenerCount('term:close'), 0);
  const data = []; native.data('before listeners'); bridge.onTermData(result.handle, value => data.push(value));
  assert.deepEqual(data, []); assert.equal((await bridge.termReady(result.handle)).ok, true); assert.deepEqual(data, ['before listeners']);
  bridge.termWrite(result.handle, '\x03'); assert.deepEqual(inputs, ['\x03']);
  assert.equal((await bridge.termClose(result.handle)).status, 'closed'); assert.equal(vm.terminalBroker.counts().slots, 0);
  assert.ok(commands.some(([, args]) => args.includes('=agents:=one')));
  for (const [bin, args] of commands) { assert.equal(bin, 'tmux'); assert.ok(args.includes('/memory/socket')); }
});
