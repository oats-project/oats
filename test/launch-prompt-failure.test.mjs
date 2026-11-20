import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { v2Deployment, writeFixtureExecutable } from './helpers/v2-deployment.mjs';
import { startInstanceSession } from '../lib/core.mjs';
import { readEvents } from '../lib/instance-events.mjs';

// Only isolated fixture deployments and a long-lived inert stub are used.
// v2Deployment supplies a private TMUX_TMPDIR and cleans its sockets by path.
function setup(t, name, options = {}) {
  const fx = v2Deployment(options);
  t.after(() => fx.cleanup());
  const executable = join(fx.base, 'stub');
  writeFixtureExecutable(fx.base, executable, `#!${process.execPath}\nconsole.log('SYNTHETIC unexpected frame');\nsetInterval(() => {}, 1000);\n`);
  const home = join(fx.root, 'dev', 'instances', name);
  const configFile = join(fx.dep, 'oats-local.yaml');
  const config = YAML.parse(readFileSync(configFile, 'utf8'));
  // `stub` engages the confirmation through its argv; `plain` does not.
  config['launch-configs'] = { stub: { harness: 'claude', executable, args: ['--dangerously-load-development-channels', 'plugin:aweb-channel@awebai-marketplace'] }, plain: { harness: 'claude', executable } };
  writeFileSync(configFile, YAML.stringify(config));
  return { fx, home, config, configFile };
}
const metadata = home => JSON.parse(readFileSync(join(home, 'instance.json'), 'utf8'));
function observingIO(onCall) {
  const calls = [];
  return { calls, exec(binary, args, options) {
    calls.push({ binary, args });
    const result = onCall?.(binary, args, options);
    return result === undefined ? execFileSync(binary, args, options) : result;
  } };
}
function assertRetained(error, home, code) {
  assert.equal(error.code, code);
  assert.equal(error.details.retained, true);
  assert.equal(error.details.home, home);
  assert.match(error.details.target.paneId, /^%\d+$/);
  assert.equal(metadata(home).launched, false);
  assert.equal(existsSync(join(home, '.oats-start-pending.json')), true);
}

test('start capture failure retains actual endpoint and sends no keys, including on repeated start', async t => {
  const { fx, home } = setup(t, 'capture-failure');
  await fx.spawn('dev', { name: 'capture-failure', launchConfig: 'stub', launch: false });
  const io = observingIO((_binary, args) => {
    if (args.includes('capture-pane')) throw Object.assign(new Error('SYNTHETIC_SECRET_CAPTURE_FAILURE'), { code: 'ETIMEDOUT' });
  });
  let error;
  await assert.rejects(fx.inEnv(() => startInstanceSession(home, { io })), e => { error = e; return e.code === 'E_SPAWN_INCOMPLETE'; });
  assertRetained(error, home, 'E_SPAWN_INCOMPLETE');
  assert.equal(error.details.launchPrompts.status, 'blocked');
  assert.ok(io.calls.some(c => c.args.includes('capture-pane')));
  assert.ok(!io.calls.some(c => c.args.includes('send-keys')));
  assert.doesNotMatch(JSON.stringify(error.details), /SYNTHETIC_SECRET/);
  const allocations = io.calls.filter(c => c.args.includes('new-window')).length;
  await assert.rejects(fx.inEnv(() => startInstanceSession(home, { io })), e => ['E_SESSION_RUNNING', 'E_SESSION_START_BUSY'].includes(e.code));
  assert.equal(io.calls.filter(c => c.args.includes('new-window')).length, allocations);
});

test('both event log writes failing retains incomplete launch without claiming an answer', async t => {
  const name = 'audit-failure';
  const { fx, home } = setup(t, name);
  await fx.spawn('dev', { name, launchConfig: 'stub', launch: false });
  const logs = [join(home, '.oats-events.jsonl'), join(fx.dep, '.agents', 'events', `dev--${name}.jsonl`)];
  for (const path of logs) { rmSync(path, { force: true }); mkdirSync(path, { recursive: true }); }
  const io = observingIO();
  let error;
  await assert.rejects(fx.inEnv(() => startInstanceSession(home, { io })), e => { error = e; return e.code === 'E_SPAWN_INCOMPLETE'; });
  assertRetained(error, home, 'E_SPAWN_INCOMPLETE');
  assert.equal(error.details.launchPrompts.status, 'incomplete');
  assert.deepEqual(error.details.launchPrompts.answers, []);
  assert.ok(error.details.launchPrompts.receipt.length > 0);
  assert.ok(error.details.launchPrompts.receipt.every(receipt => !receipt.ok && receipt.results.every(row => !row.ok)));
  assert.ok(!io.calls.some(c => c.args.includes('send-keys')));
});

test('one durable event log is sufficient and partial availability is explicit', async t => {
  const name = 'partial-audit';
  const { fx, home } = setup(t, name);
  await fx.spawn('dev', { name, launchConfig: 'stub', launch: false });
  const path = join(home, '.oats-events.jsonl');
  rmSync(path, { force: true }); mkdirSync(path);
  let error;
  await assert.rejects(fx.inEnv(() => startInstanceSession(home)), e => { error = e; return e.code === 'E_SPAWN_INCOMPLETE'; });
  assertRetained(error, home, 'E_SPAWN_INCOMPLETE');
  assert.ok(error.details.launchPrompts.receipt.some(receipt => receipt.ok && receipt.results.some(row => row.ok) && receipt.results.some(row => !row.ok)));
});

test('no-launch creates no prompt event or terminal window despite an eligible argv', async t => {
  const { fx, home } = setup(t, 'quiet');
  const result = await fx.spawn('dev', { name: 'quiet', launchConfig: 'stub', launch: false });
  assert.equal(result.launched, false);
  assert.equal(metadata(home).launchPromptTarget, undefined);
  assert.equal(metadata(home).launchPrompts, undefined);
  assert.equal(existsSync(join(home, '.oats-start-pending.json')), false);
  assert.deepEqual(readEvents(home).events.filter(event => event.kind === 'launch-prompt'), []);
});

test('a launch failure that does not engage the confirmation preserves a concurrent anchor edit and compensates window and scaffold', async t => {
  const name = 'changed-anchor';
  const { fx, home } = setup(t, name);
  const anchor = await fx.spawn('dev', { name: 'anchor', launchConfig: 'stub', launch: false });
  const anchorFile = join(anchor.home, 'instance.json');
  const wrapperDir = join(fx.base, 'tmux-wrapper'); mkdirSync(wrapperDir);
  const actualTmux = execFileSync('/usr/bin/which', ['tmux'], { encoding: 'utf8' }).trim();
  const marker = join(fx.base, 'allocated-target');
  writeFileSync(join(wrapperDir, 'tmux'), `#!${process.execPath}
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('set-option') && existsSync(${JSON.stringify(marker)})) process.exit(1);
try {
  const out = execFileSync(${JSON.stringify(actualTmux)}, args, {encoding:'utf8', timeout:3000, stdio:['ignore','pipe','pipe']});
  if (args.includes('new-window')) {
    const anchor = JSON.parse(readFileSync(${JSON.stringify(anchorFile)}, 'utf8'));
    anchor.concurrentNote = 'preserve this edit';
    writeFileSync(${JSON.stringify(anchorFile)}, JSON.stringify(anchor));
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({socket:args[args.indexOf('-S')+1],windowId:out.trim()}));
  }
  process.stdout.write(out);
} catch(e) { process.stderr.write(String(e.stderr ?? '')); process.exit(e.status ?? 1); }
`);
  chmodSync(join(wrapperDir, 'tmux'), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${wrapperDir}:${previousPath}`;
  let failure;
  try {
    await assert.rejects(fx.spawn('dev', { name, launchConfig: 'plain', launch: true, relativeTo: anchor.instance, relation: 'parent' }), e => { failure = e; return e.code === 'E_SPAWN_LAUNCH_FAILED'; });
  } finally { process.env.PATH = previousPath; }
  assert.equal(failure.details?.unconfirmed, undefined, 'a launch that does not engage never committed parent lineage before dispatch');
  assert.doesNotMatch(failure.message, /parent lineage could not be restored/);
  assert.equal(metadata(anchor.home).concurrentNote, 'preserve this edit');
  assert.equal(existsSync(home), false, 'scaffold compensation still runs');
  const allocated = JSON.parse(readFileSync(marker, 'utf8'));
  const remaining = execFileSync(actualTmux, ['-u', '-S', allocated.socket, 'list-windows', '-a', '-F', '#{window_id}'], {encoding:'utf8'}).trim().split('\n');
  assert.ok(!remaining.includes(allocated.windowId), 'allocated window was removed');
});


for (const concurrentEdit of [false, true]) test(`engaged predispatch failure ${concurrentEdit ? 'reports refused anchor restoration' : 'restores parent lineage'} and still compensates scaffold`, async t => {
  const name = 'predispatch-concurrent';
  const { fx, home } = setup(t, name);
  const anchor = await fx.spawn('dev', { name: 'anchor', launchConfig: 'stub', launch: false });
  const anchorFile = join(anchor.home, 'instance.json');
  const before = readFileSync(anchorFile, 'utf8');
  const original = fs.lstatSync;
  let injected = false;
  // Fail the controller's home-identity read AFTER the engaged launch's parent write,
  // before any new-window dispatch. Model a concurrent anchor writer at that
  // boundary; cleanup must report that its restore cannot overwrite the edit.
  const mock = t.mock.method(fs, 'lstatSync', (path, ...rest) => {
    if (!injected && path === home && metadata(anchor.home).parentInstance === name) {
      injected = true;
      if (concurrentEdit) {
        const concurrent = metadata(anchor.home);
        concurrent.concurrentNote = 'preserve this edit';
        writeFileSync(anchorFile, JSON.stringify(concurrent));
      }
      throw new Error('forced controller home-identity failure');
    }
    return original(path, ...rest);
  });
  syncBuiltinESMExports();
  let failure;
  try {
    await assert.rejects(fx.spawn('dev', { name, launchConfig: 'stub', launch: true, relativeTo: anchor.instance, relation: 'parent' }), e => {
      failure = e;
      return /forced controller home-identity failure/.test(e.message);
    });
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(injected, true);
  if (concurrentEdit) {
    assert.equal(failure.details.unconfirmed, true);
    assert.match(failure.message, /parent lineage could not be restored/);
    assert.equal(metadata(anchor.home).concurrentNote, 'preserve this edit');
  } else {
    assert.equal(failure.details?.unconfirmed, undefined);
    assert.equal(readFileSync(anchorFile, 'utf8'), before);
  }
  assert.equal(existsSync(home), false, 'independent scaffold compensation still runs');
});


for (const enabled of [false, true]) for (const mutation of ['edit', 'remove']) test(`spawn hook ${mutation} of the anchor is preserved and compensated (confirmation engaged ${enabled})`, async t => {
  const name = 'hook-anchor';
  const hook = `
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
if (process.env.OATS_INSTANCE === '${name}') {
  const root = process.env.OATS_ROOT;
  if (process.env.OATS_EVENT === 'spawn') {
    const file = join(root, 'dev', 'instances', 'anchor', 'instance.json');
    if ('${mutation}' === 'remove') unlinkSync(file);
    else { const data = JSON.parse(readFileSync(file, 'utf8')); data.concurrentNote = 'hook edit'; writeFileSync(file, JSON.stringify(data)); }
  } else if (process.env.OATS_EVENT === 'retire') writeFileSync(join(root, 'compensated'), 'yes');
}
`;
  const { fx, home } = setup(t, name, {
    souls: { dev: { soul: { capabilities: { 'test.anchor': { from: 'here' } } } } },
    capabilities: { 'test.anchor': { manifest: { hooks: { spawn: 'hook.mjs', retire: 'hook.mjs' } }, files: { 'hook.mjs': hook } } },
  });
  const anchor = await fx.spawn('dev', { name: 'anchor', launchConfig: 'stub', launch: false });
  await assert.rejects(fx.spawn('dev', { name, launchConfig: enabled ? 'stub' : 'plain', launch: true, relativeTo: anchor.instance, relation: 'parent' }), /failed to re-point anchor.*rolled back/s);
  assert.equal(existsSync(home), false);
  assert.equal(readFileSync(join(fx.root, 'compensated'), 'utf8'), 'yes', 'hook effects are compensated');
  if (mutation === 'edit') {
    assert.equal(metadata(anchor.home).concurrentNote, 'hook edit');
    assert.equal(metadata(anchor.home).parentInstance, undefined);
  } else assert.equal(existsSync(join(anchor.home, 'instance.json')), false, 'removed anchor metadata is never resurrected');
});


for (const phase of ['spawn-metadata', 'start-pending', 'start-metadata']) for (const auditFails of [false, true]) test(`${phase} escalation has a checked incomplete receipt (audit failure ${auditFails})`, async t => {
  const name = 'recording-escalation';
  const { fx, home } = setup(t, name);
  const spawning = phase.startsWith('spawn');
  if (!spawning) await fx.spawn('dev', { name, launchConfig: 'stub', launch: false });
  const originalWrite = fs.writeFileSync, originalAppend = fs.appendFileSync;
  const suffix = phase === 'start-pending' ? '.oats-start-pending.json' : 'instance.json';
  const failedPath = join(home, `${suffix}.tmp-${process.pid}`);
  let failures = 0;
  const writes = t.mock.method(fs, 'writeFileSync', (path, value, ...rest) => {
    if (path === failedPath && typeof value === 'string' && JSON.parse(value).launchPrompts) {
      failures++;
      throw new Error('injected prompt receipt write failure');
    }
    return originalWrite(path, value, ...rest);
  });
  const appends = t.mock.method(fs, 'appendFileSync', (path, value, ...rest) => {
    if (auditFails && typeof value === 'string') {
      let row; try { row = JSON.parse(value); } catch { /* other append */ }
      if (row?.kind === 'launch-prompt' && row.data?.status === 'incomplete') throw new Error('injected incomplete audit failure');
    }
    return originalAppend(path, value, ...rest);
  });
  syncBuiltinESMExports();
  let error;
  try {
    await assert.rejects(spawning
      ? fx.spawn('dev', { name, launchConfig: 'stub', launch: true })
      : fx.inEnv(() => startInstanceSession(home)), e => { error = e; return e.code === 'E_SPAWN_INCOMPLETE'; });
  } finally { writes.mock.restore(); appends.mock.restore(); syncBuiltinESMExports(); }
  assert.ok(failures > 0);
  assert.equal(error.details.retained, true);
  assert.equal(existsSync(home), true);
  const outcome = error.details.launchPrompts;
  assert.equal(outcome.status, 'incomplete');
  assert.deepEqual(outcome.answers, []);
  assert.equal(outcome.reason, auditFails ? 'launch prompt audit failed' : phase === 'start-pending' ? 'launch prompt pending receipt incomplete' : 'launch prompt metadata recording incomplete');
  assert.ok(outcome.receipt.slice(0, -1).some(receipt => receipt.row?.data?.status === 'blocked'), 'prior controller evidence is retained');
  const receipt = outcome.receipt.at(-1);
  assert.equal(receipt.ok, !auditFails);
  assert.equal(receipt.row.data.status, 'incomplete');
  assert.ok(receipt.results.length > 0);
  assert.ok(receipt.results.every(result => result.ok === !auditFails));
  const events = readEvents(home).events.filter(row => row.kind === 'launch-prompt');
  assert.equal(events.at(-1).data.status, auditFails ? 'blocked' : 'incomplete');
});

for (const spawning of [false, true]) test(`${spawning ? 'spawn' : 'start'} refuses to audit or write into a replaced home after controller completion`, async t => {
  const name = 'replaced-after-controller';
  const { fx, home } = setup(t, name);
  if (!spawning) await fx.spawn('dev', { name, launchConfig: 'stub', launch: false });
  const workspaceLog = join(fx.dep, '.agents', 'events', `dev--${name}.jsonl`);
  const originalAppend = fs.appendFileSync;
  const originalHome = join(fx.base, 'original-home');
  const replacement = JSON.stringify({ instance: name, createdAt: 'replacement', workspace: { deployment: join(fx.base, 'untrusted-deployment') } });
  let swapped = false, workspaceBytes;
  const mock = t.mock.method(fs, 'appendFileSync', (path, value, ...rest) => {
    const result = originalAppend(path, value, ...rest);
    let row; try { row = JSON.parse(value); } catch { /* other append */ }
    if (!swapped && path === workspaceLog && row?.kind === 'launch-prompt' && row.data?.status === 'blocked') {
      swapped = true;
      fs.renameSync(home, originalHome);
      mkdirSync(home);
      writeFileSync(join(home, 'instance.json'), replacement);
      workspaceBytes = readFileSync(workspaceLog, 'utf8');
    }
    return result;
  });
  syncBuiltinESMExports();
  let error;
  try {
    await assert.rejects(spawning
      ? fx.spawn('dev', { name, launchConfig: 'stub', launch: true })
      : fx.inEnv(() => startInstanceSession(home)), e => { error = e; return e.code === 'E_SPAWN_INCOMPLETE'; });
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(swapped, true);
  assert.equal(error.details.launchPrompts.status, 'incomplete');
  assert.equal(error.details.launchPrompts.reason, 'launch home identity changed; metadata retained at original home');
  assert.deepEqual(error.details.launchPrompts.receipt.at(-1), { ok: false, results: [] }, 'zero audit destinations attempted, no fabricated row');
  assert.ok(error.details.launchPrompts.receipt.slice(0, -1).some(receipt => receipt.row?.data?.status === 'blocked'));
  assert.deepEqual(fs.readdirSync(home), ['instance.json']);
  assert.equal(readFileSync(join(home, 'instance.json'), 'utf8'), replacement);
  assert.equal(readFileSync(workspaceLog, 'utf8'), workspaceBytes, 'no repointed workspace audit');
  assert.equal(existsSync(join(fx.base, 'untrusted-deployment')), false);
});
