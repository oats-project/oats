import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackServerBinding, serverSpawnSpec } from '../server-host.mjs';
import { createControlFetch } from '../control-fetch.mjs';
import { TEST_CONTROL_TOKEN } from './helpers/control-auth.mjs';

const SERVER = fileURLToPath(new URL('../server/oats-web.mjs', import.meta.url));
const ready = port => `oats-desktop server — API at http://127.0.0.1:${port}  (workspaces: none)\n`;
function childDouble() {
  return Object.assign(new EventEmitter(), { stdout: new EventEmitter(), killed: false, exitCode: null, signalCode: null });
}

test('binding requires the owned child complete ready line, including across chunks', async () => {
  const child = childDouble(), binding = trackServerBinding(child);
  assert.equal(binding.boundPort(), null);
  let resolved = false;
  const waiting = binding.wait().then(port => { resolved = true; return port; });
  const line = ready(4827);
  child.stdout.emit('data', Buffer.from('a different startup line\n' + line.slice(0, 23)));
  await Promise.resolve(); assert.equal(resolved, false); assert.equal(binding.boundPort(), null);
  child.stdout.emit('data', Buffer.from(line.slice(23, -1)));
  await Promise.resolve(); assert.equal(resolved, false, 'an unterminated line is not readiness');
  child.stdout.emit('data', Buffer.from('\n'));
  assert.equal(await waiting, 4827);
  assert.equal(binding.boundPort(), 4827);
});


test('binding decodes a ready line when a UTF-8 character spans stdout chunks', async () => {
  const child = childDouble(), binding = trackServerBinding(child);
  const bytes = Buffer.from(ready(4829));
  const split = bytes.indexOf(Buffer.from('—')) + 1;
  child.stdout.emit('data', bytes.subarray(0, split));
  child.stdout.emit('data', bytes.subarray(split));
  assert.equal(await binding.wait({ timeout: 50 }), 4829);
});

test('binding ignores other output, malformed addresses and out of range ports', async () => {
  const child = childDouble(), binding = trackServerBinding(child);
  for (const line of [ready(0), ready(65536), ready('unknown'), ready(4820).replace('127.0.0.1', 'localhost'),
    'prefix ' + ready(4820), 'API at http://127.0.0.1:4820\n']) child.stdout.emit('data', Buffer.from(line));
  assert.equal(binding.boundPort(), null);
  await assert.rejects(binding.wait({ timeout: 5 }), /binding/);
  child.stdout.emit('data', Buffer.from(ready(4931)));
  assert.equal(await binding.wait(), 4931, 'a later valid complete line can establish the binding');
});

for (const end of ['exit', 'error', 'killed', 'already-exited']) test(`binding is unavailable for a child that ${end}`, async () => {
  const child = childDouble();
  if (end === 'already-exited') child.exitCode = 1;
  const binding = trackServerBinding(child);
  child.stdout.emit('data', Buffer.from(ready(4820)));
  if (end === 'exit') { child.exitCode = 1; child.emit('exit', 1, null); }
  else if (end === 'error') child.emit('error', new Error('fixture child unavailable'));
  else if (end === 'killed') child.killed = true;
  assert.equal(binding.boundPort(), null);
  await assert.rejects(binding.wait(), /binding/);
  child.stdout.emit('data', Buffer.from(ready(4821)));
  assert.equal(binding.boundPort(), null, 'late stdout cannot revive the child');
});

test('authenticated fetch follows the actual reported port and revokes it on child exit', async () => {
  const child = childDouble(), binding = trackServerBinding(child), sent = [];
  const fetch = createControlFetch(TEST_CONTROL_TOKEN, async (url, init) => { sent.push({ url: String(url), init }); return { ok: true }; }, {
    authorize: url => url.origin === `http://127.0.0.1:${binding.boundPort()}`,
  });
  await assert.rejects(fetch('http://127.0.0.1:4820/api/panel'), /binding/);
  assert.equal(sent.length, 0);
  child.stdout.emit('data', Buffer.from(ready(4931)));
  assert.equal(await binding.wait(), 4931);
  await assert.rejects(fetch('http://127.0.0.1:4820/api/panel'), /binding/);
  await fetch('http://127.0.0.1:4931/api/panel');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].init.headers.get('x-oats-desktop-token'), TEST_CONTROL_TOKEN);
  child.exitCode = 1; child.emit('exit', 1, null);
  await assert.rejects(fetch('http://127.0.0.1:4931/api/panel'), /binding/);
  assert.equal(sent.length, 1, 'no authenticated fetch is sent after the child ends');
});

function startOwnedServer(t, port) {
  const home = mkdtempSync(join(tmpdir(), 'oats-server-binding-'));
  const tmux = join(home, 'tmux'); mkdirSync(tmux);
  const spec = serverSpawnSpec({ execPath: process.execPath, bin: SERVER, dirs: [], port,
    oatsBin: null, pathSource: 'inherited', remoteIdentityFile: join(home, 'remote-identity.json'), home,
    controlToken: TEST_CONTROL_TOKEN, env: { ...process.env, HOME: home, OATS_HOME_DIR: join(home, '.oats'), TMUX_TMPDIR: tmux,
      OATS_DESKTOP_OATS_BIN: '', PATH: '/nonexistent', SHELL: '/bin/false' } });
  const child = spawn(spec.command, spec.args, spec.options);
  const binding = trackServerBinding(child);
  const exited = once(child, 'exit');
  let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  child.stdin.on('error', () => {});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    rmSync(home, { recursive: true, force: true });
  });
  return { child, binding, exited, output: () => output };
}

test('real child reports its actual ephemeral port before an authenticated request', async t => {
  const owned = startOwnedServer(t, 0);
  const port = await owned.binding.wait();
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  const fetch = createControlFetch(TEST_CONTROL_TOKEN, globalThis.fetch, {
    authorize: url => url.origin === `http://127.0.0.1:${owned.binding.boundPort()}`,
  });
  const response = await fetch(`http://127.0.0.1:${port}/api/panel`);
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  owned.child.kill(); await owned.exited;
  assert.equal(owned.binding.boundPort(), null);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/panel`), /binding/);
  assert.equal(owned.output().includes(TEST_CONTROL_TOKEN), false);
});

test('a requested port held by another listener never receives a token when the owned child fails to bind', async t => {
  const seen = [];
  const foreign = createServer((req, res) => { seen.push({ path: req.url, token: req.headers['x-oats-desktop-token'] }); res.end('{}'); });
  await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve));
  t.after(async () => { foreign.closeAllConnections(); await new Promise(resolve => foreign.close(resolve)); });
  const port = foreign.address().port;
  const owned = startOwnedServer(t, port);
  const fetch = createControlFetch(TEST_CONTROL_TOKEN, globalThis.fetch, {
    authorize: url => url.origin === `http://127.0.0.1:${owned.binding.boundPort()}`,
  });
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/panel`), /binding/);
  await assert.rejects(owned.binding.wait(), /binding/);
  const [code] = await owned.exited;
  assert.notEqual(code, 0);
  assert.equal(owned.binding.boundPort(), null);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/panel`), /binding/);
  assert.deepEqual(seen, [], 'the other listener receives no authenticated readiness request');
  assert.equal(owned.output().includes(TEST_CONTROL_TOKEN), false);
});
