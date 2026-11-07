// The shipped server starts the real CLI on a private deployment and tmux server.
// The stand-in harness records only whether the control variable was present.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { v2Deployment, CLI } from './helpers/v2-deployment.mjs';
import { startGroup, closeGroup } from './helpers/process-group.mjs';
import { TEST_CONTROL_TOKEN, controlFetch } from '../packages/desktop/test/helpers/control-auth.mjs';

async function until(read, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(message);
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('server start and spawn keep the control token out of CLI descendants, harnesses and tmux environments', { timeout: 180000 }, async t => {
  const fx = v2Deployment();
  let server, failure;
  try {
    try { execFileSync('tmux', ['-V'], { env: fx.env, stdio: 'ignore', timeout: 3000 }); }
    catch { t.skip('tmux is required for the private session probe'); return; }
    const bin = join(fx.base, 'probe-bin'), receipt = join(fx.base, 'harness-environments.jsonl');
    mkdirSync(bin);
    writeFileSync(join(bin, 'codex'), `#!${process.execPath}
const { appendFileSync } = require('node:fs');
appendFileSync(${JSON.stringify(receipt)}, JSON.stringify({ tokenPresent: Object.hasOwn(process.env, 'OATS_DESKTOP_TOKEN'), pid: process.pid }) + '\\n');
process.stdin.resume();
setInterval(() => {}, 1000);
process.stdout.write('CONTROL_ENVIRONMENT_READY\\n');
`);
    chmodSync(join(bin, 'codex'), 0o755);
    fx.env.PATH = `${bin}:${fx.env.PATH}`;
    const seeded = fx.cli(['spawn', 'dev', '--name', 'control-start', '--harness', 'codex', '--launch-config', 'none', '--model', '@native-default', '--no-launch', '--task', 'Environment probe.', '--json']).json();
    assert.equal(seeded.ok, true, JSON.stringify(seeded.error));
    const port = await freePort(), base = `http://127.0.0.1:${port}`;
    server = startGroup(process.execPath, [new URL('../packages/desktop/server/oats-web.mjs', import.meta.url).pathname,
      'start', '--port', String(port), '--dir', fx.dep], {
      env: { ...fx.env, OATS_DESKTOP_TOKEN: TEST_CONTROL_TOKEN, OATS_DESKTOP_OATS_BIN: CLI }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    for (const stream of [server.stdout, server.stderr]) stream.on('data', bytes => { output = (output + bytes.toString()).slice(-65536); });
    const request = async (path, body) => {
      const response = await controlFetch(`${base}${path}`, body === undefined ? {} : {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const value = await response.json();
      assert.equal(response.ok, true, JSON.stringify(value));
      return value;
    };
    const panel = () => request('/api/panel');
    const initial = await until(async () => {
      try { const p = await panel(); return p.deployment?.status === 'observed' && p.instances?.some(i => i.instance === 'control-start') ? p : null; }
      catch { return null; }
    }, 'server did not observe the fixture');
    const first = initial.instances.find(i => i.instance === 'control-start');
    assert.equal(first.running, false);
    const ws = `?ws=${encodeURIComponent(fx.dep)}`;
    await request(`/api/start/control-start${ws}&home=${encodeURIComponent(first.home)}`, { harness: 'codex', launchConfig: 'none', model: '@native-default' });
    const receipts = () => existsSync(receipt) ? readFileSync(receipt, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    await until(() => receipts().length === 1, 'started harness did not record its environment');
    const running = await until(async () => {
      const p = await panel(); const row = p.instances.find(i => i.instance === 'control-start');
      return row?.running === true && row.tmux?.socket ? row : null;
    }, 'started harness was not observed running');
    assert.ok(running.tmux.socket.startsWith(fx.env.TMUX_TMPDIR + '/'), 'fixture owns the tmux socket');
    const tmux = args => execFileSync('tmux', ['-u', '-S', running.tmux.socket, ...args], { env: fx.env, encoding: 'utf8', timeout: 5000 });
    for (const args of [['show-environment', '-g'], ['show-environment', '-t', `=${running.tmux.session}`]]) {
      const environment = tmux(args);
      assert.equal(environment.split('\n').some(line => /^-?OATS_DESKTOP_TOKEN(?:=|$)/.test(line)), false);
    }
    await until(async () => {
      const agents = await request(`/api/agents${ws}`);
      return agents.agents?.some(a => a.name === 'dev');
    }, 'server did not publish its spawn catalog');
    const prepared = await request(`/api/spawn${ws}`, {
      action: 'prepare', selector: { soul: 'dev', agentsRoot: fx.root },
      choices: { name: 'control-spawn', harness: 'codex', launchConfig: 'none', model: { kind: 'native-default' } }, task: 'Environment probe.',
    });
    assert.equal(prepared.status, 'prepared', JSON.stringify(prepared.reason));
    let spawned = await request(`/api/spawn${ws}`, { action: 'apply', spawnRef: prepared.spawnRef });
    if (spawned.status === 'pending') spawned = await until(async () => {
      const result = await request(`/api/spawn${ws}`, { action: 'result', spawnRef: prepared.spawnRef });
      return result.status === 'pending' ? null : result;
    }, 'spawn did not complete', 60000);
    assert.equal(spawned.status, 'complete', JSON.stringify(spawned.reason));
    assert.equal(spawned.receipt.launched, true);
    await until(() => receipts().length >= 2, 'spawned harness did not record its environment');
    assert.ok(receipts().every(value => value.tokenPresent === false));
    assert.equal(output.includes(TEST_CONTROL_TOKEN), false, 'server output carries no token');
    const globalEnvironment = tmux(['show-environment', '-g']);
    assert.equal(globalEnvironment.split('\n').some(line => /^-?OATS_DESKTOP_TOKEN(?:=|$)/.test(line)), false);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    try { if (server) await closeGroup(server); } catch (error) { cleanupErrors.push(error); }
    for (const name of ['control-start', 'control-spawn']) {
      const home = join(fx.root, 'dev', 'instances', name);
      if (!existsSync(home)) continue;
      try {
        const target = ['instance', 'stop', name, '--home', home, '--dir', fx.dep];
        const plan = fx.cli([...target, '--plan', '--json']).json();
        if (!plan.ok || !plan.result?.planRevision) throw new Error(`fixture stop plan failed: ${name}`);
        const stopped = fx.cli([...target, '--apply', '--plan-revision', plan.result.planRevision,
          '--idempotency-key', `control-cleanup-${name}`, '--json']);
        if (stopped.status !== 0 || stopped.json().result?.ok !== true) cleanupErrors.push(new Error(`fixture instance stop failed: ${name}`));
      } catch (error) { cleanupErrors.push(error); }
    }
    try { fx.cleanup(); } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) {
      if (!failure) throw new AggregateError(cleanupErrors, `control environment fixture cleanup failed: ${cleanupErrors.map(error => error.message).join('; ')}`);
      t.diagnostic(`control environment fixture cleanup also failed (${cleanupErrors.length} operations)`);
    }
  }
});
