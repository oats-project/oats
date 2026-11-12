import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { deploymentsImported } from "./helpers/host-fixture.mjs";

// Actual sending/receiving CLI joined by a loopback SSH substitute. The
// substitute executes ONLY commands generated for these temporary scopes.
// No network, model, terminal, GUI or real-home mutation is involved.
const kernel = resolve(new URL('..', import.meta.url).pathname);
const cli = join(kernel, 'bin/oats.mjs');
const { writeServers, writeSnapshot } = await import(pathToFileURL(join(kernel, 'lib/servers.mjs')));
const { parseConfigData } = await import(pathToFileURL(join(kernel, 'lib/config-data.mjs')));
test('remote launch configuration CLI: stdin transport, receiving scope, frozen routes and old-kernel refusal', async () => {
const base = realpathSync(mkdtempSync(join(tmpdir(), 'oats-remote-cli-seam-')));
const localScope = join(base, 'local'), remoteScope = join(base, 'remote team'), bin = join(base, 'bin');
const log = join(base, 'calls.jsonl');
const write = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const originalEnv = { ...process.env };
const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
try {
  for (const p of [localScope, remoteScope, bin]) mkdirSync(p, { recursive: true });
  process.env.OATS_HOME_DIR = deploymentsImported(join(base, 'local-oats'));
  process.env.OATS_REMOTE_SEAM_HOME = deploymentsImported(join(base, 'remote-oats'));
  process.env.OATS_REMOTE_SEAM_LOG = log;
  process.env.PATH = `${bin}:${process.env.PATH}`;
  for (const k of ['OATS_INSTANCE', 'OATS_INSTANCE_HOME', 'OATS_HOME', 'PI_AGENT_INSTANCE', 'PI_AGENT_HOME', 'PI_AGENTS_ROOT']) delete process.env[k];
  const shim = `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs'), cp = require('node:child_process');
const args = process.argv.slice(2), command = args.at(-1), host = args.at(-2);
if (host !== 'loopback-test') throw Error('unexpected SSH target');
const input = fs.readFileSync(0);
fs.appendFileSync(process.env.OATS_REMOTE_SEAM_LOG, JSON.stringify({ command, bytes: input.length, input: input.toString() }) + '\n');
if (process.env.OATS_REMOTE_SEAM_OLD && command.includes('version --json')) {
  console.log(JSON.stringify({ schemaVersion: 1, ok: true, result: { version: '0.69.15', desktopApi: 1, remote: ['session'], features: ['session-start'] } }));
} else {
  const env = { ...process.env, OATS_HOME_DIR: process.env.OATS_REMOTE_SEAM_HOME };
  const r = cp.spawnSync('/bin/sh', ['-c', command], { env, input, encoding: 'utf8', timeout: 20000 });
  if (r.stdout) process.stdout.write(r.stdout); if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.status ?? 1);
}
`;
  write(join(bin, 'ssh'), shim); chmodSync(join(bin, 'ssh'), 0o755);
  const untouched = 'name: local\n'; write(join(localScope, 'oats-config.yaml'), untouched);
  // The receiving host's deployment: launch configurations live in its oats-local.yaml.
  write(join(remoteScope, 'oats-local.yaml'), 'schemaVersion: 2\nworkspace: example.invalid/acme/workspace\n');
  const target = { sshHost: 'loopback-test', workspace: remoteScope, oatsPath: cli };
  writeServers({ test: target });
  const run = (args, extra = {}) => {
    const r = spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: localScope, encoding: 'utf8', env: { ...process.env, ...extra }, timeout: 25000 });
    assert.ok(r.stdout, r.stderr || String(r.error));
    return JSON.parse(r.stdout);
  };
  const probeRaw = run(['version']); const probe = probeRaw.result || probeRaw;
  for (const f of ['launch-config', 'session-restart']) {
    assert.ok(probe.features.includes(f), `feature ${f}`);
    assert.ok(probe.remote.includes(f), `remote ${f}`);
  }
  const definition = { harness: 'codex', executable: '/usr/bin/true', args: ['--profile', "a,b # 'x'", '', '$(never-executed)'], env: { API_KEY: { fromEnv: 'REMOTE_KEY' }, DIR: 'synthetic-private-path' }, yolo: true };
  const definitionFile = join(base, 'definition.json'); write(definitionFile, JSON.stringify(definition));
  const r = run(['launch-config', 'set', 'personal', '--server', 'test', '--dir', remoteScope, '--file', definitionFile]);
  assert.equal(r.ok, true, JSON.stringify(r));
  // parseConfigData answers null-prototype objects; compare plain data.
  const stored = JSON.parse(JSON.stringify(parseConfigData(readFileSync(join(remoteScope, 'oats-local.yaml'), 'utf8')).value['launch-configs'].personal));
  assert.deepEqual(stored, definition);
  assert.equal(JSON.stringify(r).includes('synthetic-private-path'), false);
  assert.equal(readFileSync(join(localScope, 'oats-config.yaml'), 'utf8'), untouched);
  const traffic = calls();
  assert.equal(traffic.find(c => c.command.includes('version --json')).bytes, 0);
  const mutation = traffic.find(c => c.command.includes('launch-config set'));
  assert.deepEqual(JSON.parse(mutation.input), definition);
  assert.ok(mutation.command.includes('--file -'));
  assert.ok(!mutation.command.includes('synthetic-private-path'));
  const callsBeforeBadFile = calls().length;
  write(definitionFile, '{"env":{"TOKEN":"synthetic-parse-secret"}, broken');
  const badFile = run(['launch-config', 'set', 'x', '--server', 'test', '--file', definitionFile]);
  assert.equal(badFile.error.code, 'E_BAD_ARGS');
  assert.equal(JSON.stringify(badFile).includes('synthetic-parse-secret'), false);
  assert.equal(calls().length, callsBeforeBadFile, 'invalid local definition never reaches the host');
  const badChoice = run(['session', 'restart', '--server', 'test', '--home', '/fake/home', '--harness']);
  assert.equal(badChoice.error.code, 'E_BAD_ARGS');
  assert.equal(calls().length, callsBeforeBadFile, 'a missing flag value never probes a host');
  const home = join(remoteScope, 'agents/dev/instances/dev-one');
  write(join(home, 'instance.json'), JSON.stringify({ agent: 'dev', instance: 'dev-one', home, repo: remoteScope, harness: 'codex', launched: false, launch: { version: 2, harness: 'codex', launchConfig: null, executable: '/usr/bin/true', args: [], env: {}, model: null, yolo: false, hooks: { launch: {}, env: {}, contributions: [] }, prompt: { kind: 'task-file', file: 'TASK.md' } } }));
  writeSnapshot('test', target, { version: probe.version, schemaVersion: 1 }, { instance: 'dev-one', home, agent: 'dev' });
  writeServers({ test: { ...target, sshHost: 'must-not-connect', workspace: '/must-not-write' } });
  const before = readFileSync(join(home, 'instance.json'), 'utf8');
  const preview = run(['launch-config', 'preview', '--server', 'test', '--home', home]);
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(preview.result.executable.path, '/usr/bin/true');
  assert.equal(readFileSync(join(home, 'instance.json'), 'utf8'), before);
  const n = calls().length;
  const old = run(['session', 'restart', '--server', 'test', '--home', home], { OATS_REMOTE_SEAM_OLD: '1' });
  assert.equal(old.ok, false); assert.equal(old.error.code, 'E_REMOTE_INCOMPATIBLE');
  assert.equal(calls().length, n + 1); assert.ok(calls().at(-1).command.includes('version --json'));
} finally {
  for (const k of Object.keys(process.env)) if (!(k in originalEnv)) delete process.env[k];
  Object.assign(process.env, originalEnv);
  rmSync(base, { recursive: true, force: true });
}
});
