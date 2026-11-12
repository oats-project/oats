// The backend's request checks, driven at the real boundary: the real server started exactly as
// main starts it (launchServerChild over serverSpawnSpec: a private socket, a fresh credential on
// fd 3), and raw requests over its socket with node:http (`socketPath`), never fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync, existsSync, renameSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backendRequest, startBackendThroughSpec, READY_LINE } from './helpers/backend-server.mjs';
import { serverSpawnSpec } from '../server-host.mjs';
import { NO_CLI_ENV } from '../scripts/smoke-probes.mjs';

const VERSION = readFileSync(new URL('./fixtures/workspace-v2/desktop-facts/version.json', import.meta.url), 'utf8');
const HERMETIC = { ...process.env, ...NO_CLI_ENV };

/** A fake `oats` (a shell script: it holds no descriptor of its own at 3) that answers `version --json`
 * as a compatible CLI and records each run: its argv, its environment and whether its fd 3 is open. */
function fakeCli(dir, name = 'oats', { gate = false, lateStart = false } = {}) {
  const log = join(dir, `${name}.log`), startedLog = join(dir, `${name}.started`);
  const bin = join(dir, name);
  const gateFile = join(dir, `${name}.gate`);
  // With a gate, a `server roster` run writes its first lines and then waits (bounded) for the gate file before
  // it writes its environment: a run held mid-record.
  const hold = gate ? `case "$1 $2" in "server roster") i=0; while [ ! -e '${gateFile}' ] && [ $i -lt 400 ]; do /bin/sleep 0.05; i=$((i+1)); done;; esac; ` : '';
  // With lateStart, a `server roster` run waits half a second before it notes its start: a run already launched
  // that has not yet said so.
  const late = lateStart ? `case "$1 $2" in "server roster") /bin/sleep 0.5;; esac\n` : '';
  writeFileSync(join(dir, `${name}.version.json`), VERSION);
  // Each run notes its start, writes its record to a file of its own and only then appends it to the log, in one
  // write: the log holds whole records only, never one half-written or two interleaved.
  writeFileSync(bin, `#!/bin/sh
${late}echo "run $*" >> '${startedLog}'
record='${log}.'$$
{ echo "run $*"; if [ -e /proc/$$/fd/3 ]; then echo "fd3 open"; else echo "fd3 closed"; fi; ${hold}/usr/bin/env; echo "end"; } > "$record"
/bin/cat "$record" >> '${log}'; /bin/rm -f "$record"
/bin/cat '${join(dir, `${name}.version.json`)}'
`, { mode: 0o700 });
  /** The runs recorded so far: whole records, each a finished run. */
  const runs = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\nend\n').filter((r) => r.startsWith('run ')) : []);
  /** Every run that has started, finished or not: its `run …` line. */
  const started = () => (existsSync(startedLog) ? readFileSync(startedLog, 'utf8').split('\n').filter((l) => l.startsWith('run ')) : []);
  /** The recorded runs once every run that has started is recorded (none in flight), bounded. */
  const settled = async () => {
    for (let n = 0; n < 400; n++) {
      const done = runs();
      if (done.length >= started().length) return done;
      await new Promise((ok) => setTimeout(ok, 25));
    }
    throw new Error(`a CLI run never finished: ${started().length} started, ${runs().length} recorded`);
  };
  /** Waits (bounded) until a run whose argv starts with `args` has started. */
  const startedRun = async (args) => {
    for (let n = 0; n < 400; n++) {
      if (started().some((l) => l.startsWith(`run ${args}`))) return;
      await new Promise((ok) => setTimeout(ok, 25));
    }
    throw new Error(`no \`${args}\` run started`);
  };
  return { bin, log, gate: gateFile, runs, started, settled, startedRun, probes: () => started().filter((l) => l === 'run version --json').length };
}

/** Every run a server started at start-up makes of the fake CLI, each once it has finished. Its first acceptance of
 * a CLI starts both the start-up probe and a remote-roster read (server/oats-web.mjs, probeCli), and a launched run
 * notes its start only once its shell runs: so the roster read is waited for by name, not inferred from the count. */
async function serverRuns(fake) {
  await fake.startedRun('server roster ');
  return fake.settled();
}

async function started(t, { cli, gate = false, lateStart = false } = {}) {
  // Canonical, as the CLI locator reports a candidate (macOS's temporary directory is under a /var link).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'oats-t-cli-')));
  const fake = cli ? fakeCli(dir, 'oats', { gate, lateStart }) : null;
  const choice = join(dir, 'oats-cli-choice.json');
  if (fake) writeFileSync(choice, JSON.stringify({ bin: fake.bin }));
  const s = await startBackendThroughSpec({ env: HERMETIC, cliChoiceFile: choice, home: dir, remoteIdentityFile: join(dir, 'remote-identity.json') });
  t.after(async () => { await s.stop(); rmSync(dir, { recursive: true, force: true }); });
  // The start-up probe has landed (its verdict is published) before any test counts probes.
  for (let n = 0; !(await (await s.request('/api/cli')).json()).probedAt; n++) {
    if (n > 400) throw new Error('the start-up probe never landed');
    await new Promise((ok) => setTimeout(ok, 25));
  }
  return { s, dir, fake, choice };
}

const WRONG_SAME_LENGTH = (secret) => `${secret[0] === 'A' ? 'B' : 'A'}${secret.slice(1)}`;
const TARGETS = [
  ['GET', '/api/version'], ['GET', '/api/cli'], ['GET', '/api/panel'], ['GET', '/api/file?path=%2Fetc%2Fhostname'],
  ['POST', '/api/cli/reprobe'], ['POST', '/api/spawn'], ['GET', '/no-such-route'], ['GET', '//'],
];

test('A1: every request without exactly the bearer credential is 401 E_UNAUTHORIZED; with it, none is', async (t) => {
  const { s } = await started(t);
  const wrongs = {
    'no header': {},
    'wrong secret, same length': { authorization: `Bearer ${WRONG_SAME_LENGTH(s.secret)}` },
    'wrong length': { authorization: `Bearer ${s.secret}x` },
    'Basic': { authorization: `Basic ${Buffer.from(`oats:${s.secret}`).toString('base64')}` },
  };
  for (const [method, path] of TARGETS) {
    const body = method === 'POST' ? '{}' : undefined;
    for (const [label, extra] of Object.entries(wrongs)) {
      const r = await backendRequest(s.socketPath, { path, method, body, headers: { host: 'localhost', 'content-type': 'application/json', ...extra } });
      assert.equal(r.status, 401, `${method} ${path}: ${label}`);
      assert.deepEqual(await r.json(), { error: 'unauthorized', code: 'E_UNAUTHORIZED' }, `${method} ${path}: ${label}`);
    }
    const ok = await backendRequest(s.socketPath, { path, method, body, headers: { host: 'localhost', 'content-type': 'application/json', authorization: `Bearer ${s.secret}` } });
    assert.notEqual(ok.status, 401, `${method} ${path}: the credential is accepted`);
    if (path === '//') assert.equal(ok.status, 400, 'an authorized malformed target is a 400');
  }
  // Still serving after all of that.
  assert.equal((await s.request('/api/version')).status, 200);
});

test('A2: an unauthenticated reprobe runs no probe', async (t) => {
  const { s, fake } = await started(t, { cli: true });
  const before = fake.probes();
  assert.ok(before >= 1, 'the start-up probe ran the chosen fake');
  for (const body of ['{}', '', '{"bin":"/x"}']) {
    const r = await backendRequest(s.socketPath, { path: '/api/cli/reprobe', method: 'POST', body, headers: { host: 'localhost', 'content-type': 'application/json' } });
    assert.equal(r.status, 401);
  }
  // An authorized one does probe, so the count is a real observation.
  assert.equal((await s.request('/api/cli/reprobe', { method: 'POST', body: '{}' })).status, 200);
  assert.equal(fake.probes(), before + 1, 'only the authorized reprobe probed');
});

test('A4: the credential is on no argv and in no environment; the CLI the server runs sees neither it nor fd 3', async (t) => {
  const spec = serverSpawnSpec({ execPath: process.execPath, bin: '/x/server/oats-web.mjs', dirs: ['/w'], socketPath: '/tmp/oats-d-x/s',
    cliChoiceFile: '/u/oats-cli-choice.json', pathSource: 'inherited', pathError: null, remoteIdentityFile: '/u/r.json', home: '/h', env: HERMETIC });
  assert.deepEqual(spec.options.stdio, ['pipe', 'pipe', 'pipe', 'pipe'], 'fd 3 is a pipe of its own');
  assert.deepEqual(spec.args.slice(spec.args.indexOf('--token-fd'), spec.args.indexOf('--token-fd') + 2), ['--token-fd', '3']);
  assert.equal(spec.args.includes('--port'), false);
  assert.equal(spec.args.includes('--oats-bin'), false);
  const { s, fake } = await started(t, { cli: true });
  // The spec main used for this very server holds no secret.
  assert.equal(JSON.stringify(s.spec.args).includes(s.secret), false, 'not on argv');
  assert.equal(JSON.stringify(s.spec.options.env).includes(s.secret), false, 'not in the environment');
  // Every run the server made, each once it has finished (a run still in flight is waited for, never judged half-written).
  const runs = await serverRuns(fake);
  assert.ok(runs.some((r) => r.startsWith('run version --json\n')), 'the start-up probe is judged');
  assert.ok(runs.some((r) => r.startsWith('run server roster ')), 'the start-up roster read is judged');
  for (const run of runs) {
    assert.match(run, /\nPATH=\/nonexistent\n/, 'the run recorded its environment');
    assert.equal(run.includes(s.secret), false, 'the CLI child sees no secret in its argv or environment');
    if (process.platform === 'linux') assert.match(run, /\nfd3 closed\n/, 'fd 3 is not open in the CLI child');
  }
  if (process.platform !== 'linux') t.diagnostic('fd 3 of the CLI child not inspected: no /proc on this platform');
});

test("A4's record of the CLI runs: a run still in flight is waited for, never judged half-written", async (t) => {
  // The server's remote-roster read starts as the start-up probe lands, so a check right after start-up can meet
  // it mid-run. Here that run is held halfway (its first lines written, its environment not yet) until the gate opens.
  const { s, fake } = await started(t, { cli: true, gate: true });
  await fake.startedRun('server roster ');
  assert.equal(fake.runs().some((r) => r.startsWith('run server roster ')), false, 'a run in flight is not a recorded run');
  const settled = serverRuns(fake);
  setTimeout(() => writeFileSync(fake.gate, ''), 100);
  const runs = await settled;
  const roster = runs.find((r) => r.startsWith('run server roster '));
  assert.ok(roster, 'once it has finished, it is recorded and judged with the others');
  assert.match(roster, /\nPATH=\/nonexistent\n/, 'its environment is the server\'s');
  assert.equal(roster.includes(s.secret), false);
  if (process.platform === 'linux') assert.match(roster, /\nfd3 closed\n/);
});

test("A4's record of the CLI runs: a roster read launched but not yet noted is still waited for", async (t) => {
  // The roster run is launched with the start-up probe's verdict but notes its start half a second later: a count of
  // started runs alone would see every one finished and miss it.
  const { s, fake } = await started(t, { cli: true, lateStart: true });
  const roster = (await serverRuns(fake)).find((r) => r.startsWith('run server roster '));
  assert.ok(roster, 'the roster read is judged, though it noted its start late');
  assert.match(roster, /\nPATH=\/nonexistent\n/, 'its environment is the server\'s');
  assert.equal(roster.includes(s.secret), false);
  if (process.platform === 'linux') assert.match(roster, /\nfd3 closed\n/);
});

test('A5: the server prints its ready line and never the secret', async (t) => {
  const { s } = await started(t);
  assert.equal((await s.raw({ path: '/api/cli', headers: { host: 'localhost' } })).status, 401);
  assert.equal((await s.request('//')).status, 400);
  assert.equal((await s.request('/api/version')).status, 200);
  const output = `${s.stdout()}\n${s.stderr()}`;
  assert.ok(output.split('\n').includes(READY_LINE), 'the ready line');
  assert.equal(output.includes(s.secret), false, 'no secret in stdout or stderr');
});

test('A6: reprobe takes no binary; the chosen binary is the choice file main writes', async (t) => {
  const { s, dir, fake, choice } = await started(t, { cli: true });
  const probes = () => fake.probes();
  for (const body of ['{"bin":"/x"}', '{"a":1}', '[]', '{']) {
    const before = probes();
    const r = await s.request('/api/cli/reprobe', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(r.status, 400, body);
    assert.equal((await r.json()).code, 'E_BAD_ARGS', body);
    assert.equal(probes(), before, `${body}: no probe`);
  }
  for (const body of ['{}', undefined]) assert.equal((await s.request('/api/cli/reprobe', { method: 'POST', body })).status, 200, String(body));
  assert.equal((await (await s.request('/api/cli')).json()).bin, fake.bin, 'the choice file\'s binary after start');
  const other = fakeCli(dir, 'oats-other');
  writeFileSync(`${choice}.tmp`, JSON.stringify({ bin: other.bin })); chmodSync(`${choice}.tmp`, 0o600); renameSync(`${choice}.tmp`, choice);
  assert.equal((await s.request('/api/cli/reprobe', { method: 'POST', body: '{}' })).status, 200);
  assert.equal((await (await s.request('/api/cli')).json()).bin, other.bin, 'the rewritten choice after a reprobe');
});
