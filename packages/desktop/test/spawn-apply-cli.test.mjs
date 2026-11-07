import test from 'node:test';
import assert from 'node:assert/strict';
import { cliSpawnApply } from '../../client/spawn-apply-cli.mjs';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnDecision } from '../../client/spawn-decision.mjs';
import { cli, target, anchor, data, tick, DEPLOYMENT, ROOT } from './helpers/spawn-preview-fixture.mjs';
const capable = () => ({ ...structuredClone(cli), spawnApplyApi: 1, features: [...cli.features, 'spawn-apply-2', 'spawn-idempotency-2', 'schedule'] });
function options(changes = {}) {
  const decision = data().decision; // the kernel's v2 decision, as the broker holds it
  return { target: structuredClone(target), choices: {}, decision, key: 'a'.repeat(64), task: 'PRIVATE task\n--force', ...changes };
}
const wake = { cron: '0 * * * *', tz: 'UTC', message: 'PRIVATE wake', enabled: false };
// Transport-only success: deliberately NOT a qualified creation receipt. The
// broker must perform that projection separately; these tests never launch.
const ok = { schemaVersion: 1, ok: true, result: { transportFixture: true } };
function fixture({ fail = null, exec, onWrite } = {}) {
  const dirs = [], files = [], removed = [], calls = [], byFd = new Map();
  const failAt = (stage, n) => { if (fail === `${stage}:${n}`) throw Error('PRIVATE I/O failure'); };
  const io = { env: { OATS_DESKTOP_TOKEN: 'fixture-control-token-not-for-apply', PATH: '/inert/bin', HOME: '/inert/home', PI_AGENTS_ROOT: '/other', OATS_DEPLOYMENT: '/D', OATS_RESOLUTION: '/R', OATS_PREVIEW_PREFLIGHT_BUDGET_MS: '1' },
    tmpdir: () => '/inert/tmp',
    mkdtempSync: prefix => { failAt('mkdir', dirs.length + 1); const dir = `${prefix}${dirs.length + 1}`; dirs.push(dir); return dir; },
    openSync: (file, flags, mode) => { failAt('open', dirs.length); const f = { file, flags, mode, index: dirs.length, fd: files.length + 10, closed: false }; files.push(f); byFd.set(f.fd, f); return f.fd; },
    writeSync: (fd, text) => { const f = byFd.get(fd); failAt('write', f.index); f.text = text; onWrite?.(); return fail === `short-write:${f.index}` ? Buffer.byteLength(text) - 1 : Buffer.byteLength(text); },
    closeSync: fd => { const f = byFd.get(fd); f.closed = true; failAt('close', f.index); },
    rmSync: (dir, opts) => { removed.push(dir); assert.deepEqual(opts, { recursive: true, force: true }); failAt('remove', removed.length); },
    exec: (bin, argv, opts, done) => { calls.push({ bin, argv, opts }); if (exec) return exec(bin, argv, opts, done); done(null, JSON.stringify(ok)); },
  };
  return { io, dirs, files, removed, calls };
}
for (const alter of [c => delete c.spawnApplyApi, c => c.spawnApplyApi = '1', c => c.spawnApplyApi = 2, c => c.spawnPreviewApi = 1,
  ...['spawn-preview-2', 'spawn-apply-2', 'spawn-idempotency-2'].map(feature => c => c.features = c.features.filter(f => f !== feature)),
  c => c.features = c.features.map(f => f === 'spawn-idempotency-2' ? 'spawn-idempotency' : f), c => c.bin = 'oats', c => c.ok = false]) test(`exec owner positive fence before private files (${alter})`, async () => {
  const c = capable(), f = fixture(); alter(c);
  const result = await cliSpawnApply(c, options(), f.io);
  assert.equal(result.started, false); assert.equal(result.envelope.error.code, 'E_APPLY_UNAVAILABLE');
  assert.equal(f.calls.length, 0); assert.equal(f.dirs.length, 0);
});
test('apply fixed argv, exact roots, tagged choices and original key/revision; private bytes never argv', async () => {
  const f = fixture(), input = options({ choices: { purpose: 'review', branch: 'feat/review', base: 'release', harness: 'codex', launchConfig: 'personal', backend: 'tmux',
    model: { kind: 'native-default' }, yolo: false, relation: { kind: 'child', anchor } }, wake });
  const result = await cliSpawnApply(capable(), input, f.io);
  assert.equal(result.started, true); assert.deepEqual(result.envelope, ok);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].argv, ['spawn', 'release-manager', '--dir', DEPLOYMENT, '--agents-root', ROOT, '--purpose', 'review', '--branch', 'feat/review', '--base', 'release',
    '--runtime', 'codex', '--launch-config', 'personal', '--backend', 'tmux', '--model', '@native-default', '--no-yolo', '--relation', 'child',
    '--relative-to', 'release-manager-race', '--relative-root', ROOT, '--expect-decision', input.decision.revision, '--idempotency-key', input.key,
    '--task-file', f.files[0].file, '--wake-file', f.files[1].file, '--json']);
  assert.deepEqual(f.calls[0].opts, { cwd: DEPLOYMENT, env: { PATH: '/inert/bin', HOME: '/inert/home' }, shell: false, encoding: 'utf8', detached: true, timeout: 60000, maxBuffer: 4194304 });
  assert.equal(f.files[0].text, input.task); assert.deepEqual(JSON.parse(f.files[1].text), wake);
  assert.ok(f.files.every(f => f.flags === 'wx' && f.mode === 0o600 && f.closed));
  assert.deepEqual([...f.removed].sort(), [...f.dirs].sort());
  assert.doesNotMatch(JSON.stringify({ result, calls: f.calls }), /PRIVATE/);
  for (const flag of ['--preview', '--no-launch', '--def-file', '--instructions-file', '--force', '--work', '--repo']) assert.equal(f.calls[0].argv.includes(flag), false);
});
test('a worktree for a checkout soul crosses as --work worktree, next to the purpose', async () => {
  const f = fixture(); await cliSpawnApply(capable(), options({ choices: { purpose: 'review', work: 'worktree' } }), f.io);
  const argv = f.calls[0].argv; assert.deepEqual(argv.slice(6, 10), ['--purpose', 'review', '--work', 'worktree']);
  for (const flag of ['--allow-child-spawns', '--no-child-spawns']) assert.equal(argv.includes(flag), false);
});
test('replay transport keeps bytes/key/revision and regenerates only owned temp paths', async () => {
  const f = fixture(), input = options({ wake });
  await cliSpawnApply(capable(), input, f.io); await cliSpawnApply(capable(), input, f.io);
  assert.equal(f.calls.length, 2, 'only the broker decides when an explicit retry is allowed');
  assert.equal(f.files[0].text, f.files[2].text); assert.equal(f.files[1].text, f.files[3].text);
  assert.notEqual(f.files[0].file, f.files[2].file); assert.notEqual(f.files[1].file, f.files[3].file);
  for (const flag of ['--expect-decision', '--idempotency-key']) assert.equal(f.calls[0].argv[f.calls[0].argv.indexOf(flag) + 1], f.calls[1].argv[f.calls[1].argv.indexOf(flag) + 1]);
  assert.equal(f.removed.length, 4);
});
test('inherit omits model; custom model is a single value; booleans stay explicit', async () => {
  for (const [model, expected] of [[{ kind: 'inherit' }, null], [{ kind: 'custom', value: 'provider/model-*' }, 'provider/model-*']]) {
    const f = fixture(); await cliSpawnApply(capable(), options({ choices: { model, yolo: true } }), f.io);
    const argv = f.calls[0].argv; assert.equal(argv.includes('--model'), expected !== null);
    if (expected) assert.equal(argv[argv.indexOf('--model') + 1], expected);
    assert.ok(argv.includes('--yolo'));
  }
});
const withoutEffective = () => { const d = structuredClone(data().decision); delete d.effective; return d; };
for (const changes of [{ key: 'caller key' }, { key: 'b'.repeat(63) }, { decision: withoutEffective() }, { env: { KEY: 'PRIVATE' } }, { workDir: '/caller' },
  { choices: { model: { kind: 'custom', value: '@native-default' } } }, { choices: { branch: '--no-launch' } }, { choices: { base: 'x\n--force' } }, { wake: null },
  // The fixture CLI is an older kernel whose sessionBackends still lists herdr: Herdr is refused anyway.
  { choices: { backend: 'herdr' } }]) test(`invalid apply input is zero-effect: ${JSON.stringify(changes)}`, async () => {
  const f = fixture(), result = await cliSpawnApply(capable(), options(changes), f.io);
  assert.equal(result.started, false); assert.equal(result.envelope.error.code, 'E_BAD_ARGS'); assert.equal(f.dirs.length, 0); assert.equal(f.calls.length, 0);
});
for (const [label, change, overrides] of [
  ['wake', c => c.features = c.features.filter(f => f !== 'schedule'), { wake }],
  ['harness', c => c.harnesses = [], { choices: { harness: 'codex' } }],
  ['backend', c => c.sessionBackends = [], { choices: { backend: 'tmux' } }],
  ['permission', c => c.launchOptions = [], { choices: { yolo: false } }],
  ['configuration', c => c.features = c.features.filter(f => f !== 'launch-config'), { choices: { launchConfig: 'personal' } }],
]) test(`optional ${label} support is positive before input files and exec`, async () => {
  const c = capable(), f = fixture(); change(c);
  const r = await cliSpawnApply(c, options(overrides), f.io);
  assert.equal(r.envelope.error?.code, 'E_UNSUPPORTED_OPTION'); assert.equal(r.started, false); assert.equal(f.calls.length, 0); assert.equal(f.dirs.length, 0);
});
test('wake capability loss during input preparation prevents execution and cleans both files', async () => {
  const c = capable(), f = fixture({ onWrite: () => c.features = c.features.filter(f => f !== 'schedule') });
  const r = await cliSpawnApply(c, options({ wake }), f.io);
  assert.equal(f.calls.length, 0); assert.equal(r.started, false); assert.equal(r.envelope.error?.code, 'E_UNSUPPORTED_OPTION'); assert.equal(f.removed.length, 2);
});
test('mode is gated again after synchronous file preparation at actual dispatch', async () => {
  const c = capable(), f = fixture({ onWrite: () => c.features = c.features.filter(v => v !== 'spawn-idempotency-2') });
  const result = await cliSpawnApply(c, options(), f.io);
  assert.equal(f.calls.length, 0, 'exec owner must recheck the mode immediately before dispatch');
  assert.equal(result.envelope.error?.code, 'E_APPLY_UNAVAILABLE'); assert.equal(result.started, false);
  assert.deepEqual(f.removed, f.dirs);
});
for (const fail of ['mkdir:1', 'open:1', 'write:1', 'short-write:1', 'close:1', 'mkdir:2', 'open:2', 'write:2', 'short-write:2', 'close:2']) test(`private-file construction failure cleans owned paths and never invokes: ${fail}`, async () => {
  const f = fixture({ fail }), result = await cliSpawnApply(capable(), options({ wake }), f.io);
  assert.equal(result.started, false); assert.equal(result.envelope.error.code, 'E_INPUT_PREPARATION'); assert.equal(f.calls.length, 0);
  assert.deepEqual([...f.removed].sort(), [...f.dirs].sort()); assert.ok(f.files.every(f => f.closed)); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});
test('all cleanup attempts run even when one removal fails', async () => {
  const f = fixture({ fail: 'remove:1' }); const result = await cliSpawnApply(capable(), options({ wake }), f.io);
  assert.equal(result.started, true); assert.equal(f.removed.length, 2);
});
test('private files live through the pending command and are cleaned after it settles', async () => {
  let finish; const f = fixture({ exec: (_b, _a, _o, done) => finish = done });
  const pending = cliSpawnApply(capable(), options({ wake }), f.io); await tick(); assert.equal(f.removed.length, 0);
  finish(null, JSON.stringify(ok)); await pending; assert.equal(f.removed.length, 2);
});
for (const [err, stdout, code] of [[{ killed: true }, JSON.stringify(ok), 'E_CLI_TIMEOUT'], [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, '', 'E_CLI_OUTPUT_LIMIT'],
  [null, 'x'.repeat(4194305), 'E_CLI_OUTPUT_LIMIT'], [{ code: 1 }, JSON.stringify(ok), 'E_CLI_FAILED'], [null, 'PRIVATE contaminated stdout', 'E_CLI_PROTOCOL'],
  [null, null, 'E_CLI_PROTOCOL']]) test(`post-dispatch failure is conservatively started, not rollback: ${code}`, async () => {
  const f = fixture({ exec: (_b, _a, _o, done) => done(err, stdout) }); const result = await cliSpawnApply(capable(), options({ wake }), f.io);
  assert.equal(result.started, true); assert.equal(result.envelope.error.code, code); assert.equal(f.removed.length, 2); assert.equal(f.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});
test('synchronous exec error resolves conservatively and cleans both files', async () => {
  const f = fixture({ exec: () => { throw Error('PRIVATE could have started'); } }), result = await cliSpawnApply(capable(), options({ wake }), f.io);
  assert.equal(result.started, true); assert.equal(result.envelope.error.code, 'E_CLI_FAILED'); assert.equal(f.removed.length, 2); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});
test('typed refusal projection keeps only bounded decision/identity, no raw error or recipe', async () => {
  const input = options();
  for (const [code, details] of [
    ['E_DECISION_STALE', { decision: input.decision }], ['E_IDEMPOTENCY_CONFLICT', { instance: 'dev-1', home: input.decision.home }],
    ['E_PLACEMENT_TAKEN', { instance: 'dev-1', home: input.decision.home }],
    ...[false, 'unknown'].map(launched => ['E_SPAWN_INCOMPLETE', { instance: 'dev-1', home: input.decision.home, launched }]),
  ]) {
    const f = fixture({ exec: (_b, _a, _o, done) => done({ code: 1 }, JSON.stringify({ schemaVersion: 1, ok: false, error: { code, message: 'PRIVATE', details: { ...details, task: 'PRIVATE', env: { TOKEN: 'PRIVATE' } } } })) });
    const result = await cliSpawnApply(capable(), input, f.io);
    // A stale decision crosses as its bounded projection (provider payloads stay kernel-side).
    const expected = code === 'E_DECISION_STALE' ? { decision: spawnDecision(input.decision, { effectiveRequired: true }) } : details;
    assert.equal(result.started, true); assert.equal(result.envelope.error.code, code); assert.deepEqual(result.envelope.error.details, expected); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
});
test('malformed typed refusals and non-string error codes resolve without a callback throw', async () => {
  const partial = structuredClone(data().decision); delete partial.effective; // a stale decision without its effective plan
  for (const error of [{ code: 'E_DECISION_STALE', details: { decision: partial } }, { code: 'E_IDEMPOTENCY_CONFLICT', details: {} },
    { code: 'E_SPAWN_INCOMPLETE', details: { instance: 'dev-1', home: '/team/home', launched: true } }, { code: { toString: null } }]) {
    const f = fixture({ exec: (_b, _a, _o, done) => done({ code: 1 }, JSON.stringify({ schemaVersion: 1, ok: false, error })) });
    const result = await cliSpawnApply(capable(), options(), f.io);
    assert.equal(result.started, true); assert.equal(result.envelope.error.code, typeof error.code === 'string' ? 'E_CLI_PROTOCOL' : 'E_CLI_FAILED'); assert.equal(f.removed.length, 1);
  }
});

test('retained launch-prompt details cross CLI projection without raw audit or OS text', async () => {
  const { retained } = await import('./helpers/launch-prompt-fixture.mjs');
  for (const status of ['blocked', 'incomplete']) {
    const d = retained(data().decision, status);
    const f = fixture({ exec: (_bin, _argv, _opts, done) => done(Error('incomplete'), JSON.stringify({ schemaVersion: 1, ok: false, error: { code: 'E_SPAWN_INCOMPLETE', details: d } })) });
    const r = await cliSpawnApply(capable(), options(), f.io);
    assert.equal(r.envelope.error.code, 'E_SPAWN_INCOMPLETE');
    const out = r.envelope.error.details;
    assert.equal(out.launchPrompts.status, status); assert.equal(out.launchPrompts.reason, d.launchPrompts.reason);
    assert.deepEqual(out.launchPrompts.answers, d.launchPrompts.answers);
    assert.deepEqual(out.target, d.target); assert.equal(out.parentLineageCommitted, true);
    assert.deepEqual(out.launchPrompts.receipt[0].results.map(r => r.ok), [true, false]);
    assert.doesNotMatch(JSON.stringify(out), /PRIVATE/);
  }
});
test('malformed additive diagnostics do not erase retained CLI failure', async () => {
  const d = { instance: data().instance, home: data().home, launched: false, launchPrompts: { status: 'completed', reason: 'PRIVATE' } };
  const f = fixture({ exec: (_b, _a, _o, done) => done(null, JSON.stringify({ schemaVersion: 1, ok: false, error: { code: 'E_SPAWN_INCOMPLETE', details: d } })) });
  const r = await cliSpawnApply(capable(), options(), f.io);
  assert.equal(r.envelope.error.code, 'E_SPAWN_INCOMPLETE'); assert.equal(r.envelope.error.details.launchPrompts.status, 'unknown');
});
test('#802: the broker passes the CLI deadline in; only a deadline spawnApplyDeadlineMs can produce crosses', async () => {
  for (const deadlineMs of [60000, 1920000, 3720000, 120000 + 65 * 1800000, 120000 + 256 * 1800000]) {
    const f = fixture(); await cliSpawnApply(capable(), options({ deadlineMs }), f.io);
    assert.equal(f.calls[0].opts.timeout, deadlineMs);
  }
  for (const deadlineMs of [0, 59999, 61000, 1920001, '1920000', Infinity, 120000 + 257 * 1800000]) {
    const f = fixture(), result = await cliSpawnApply(capable(), options({ deadlineMs }), f.io);
    assert.equal(result.started, false); assert.equal(result.envelope.error.code, 'E_BAD_ARGS'); assert.equal(f.calls.length, 0);
  }
});
const killed = () => Object.assign(Error('killed'), { killed: true, signal: 'SIGTERM', code: null });
const interrupted = (details = { signal: 'SIGTERM', hooks: [] }) => ({ schemaVersion: 1, ok: false,
  error: { code: 'E_INTERRUPTED', message: 'the spawn was interrupted by SIGTERM while its worktree hooks ran; the running hook\'s process group was ended — spawn rolled back', details } });
test('#802: killed by our deadline, a worktree-event CLI\'s envelope on stdout is the outcome; without one it is E_CLI_TIMEOUT', async () => {
  const c = { ...capable(), features: [...capable().features, 'worktree-event'] };
  let f = fixture({ exec: (_b, _a, _o, done) => done(killed(), JSON.stringify(interrupted())) });
  let result = await cliSpawnApply(c, options({ deadlineMs: 1920000 }), f.io);
  assert.equal(result.started, true); assert.equal(result.envelope.error.code, 'E_INTERRUPTED');
  assert.match(result.envelope.error.message, /interrupted by SIGTERM/, 'the kernel\'s own message travels for a rolled-back code');
  assert.equal(result.envelope.error.details, undefined, 'signal and hooks stay with the kernel; only the unconfirmed marker crosses');
  f = fixture({ exec: (_b, _a, _o, done) => done(killed(), JSON.stringify(interrupted({ signal: 'SIGTERM', unconfirmed: true }))) });
  result = await cliSpawnApply(c, options(), f.io);
  assert.deepEqual(result.envelope.error.details, { unconfirmed: true });
  for (const stdout of ['', '{"schemaVersion":1,"ok":fal', 'progress\n']) {
    f = fixture({ exec: (_b, _a, _o, done) => done(killed(), stdout) });
    result = await cliSpawnApply(c, options(), f.io);
    assert.equal(result.started, true); assert.equal(result.envelope.error.code, 'E_CLI_TIMEOUT');
  }
  // Without the feature: today's rule, a kill is unknown whatever stdout holds.
  f = fixture({ exec: (_b, _a, _o, done) => done(killed(), JSON.stringify(interrupted())) });
  result = await cliSpawnApply(capable(), options(), f.io);
  assert.equal(result.envelope.error.code, 'E_CLI_TIMEOUT');
});
test('#802: a rolled-back code keeps the kernel message only with worktree-event; without it the code is not known here', async () => {
  for (const code of ['E_INTERRUPTED', 'E_REQUIRED_HOOK_FAILED', 'E_HOOK_ENVIRONMENT_CONTRACT']) {
    const doc = { schemaVersion: 1, ok: false, error: { code, message: `${code} kernel words`, details: { hooks: [{ capability: 'x' }] } } };
    let f = fixture({ exec: (_b, _a, _o, done) => done(Object.assign(Error('exit 1'), { code: 1 }), JSON.stringify(doc)) });
    let result = await cliSpawnApply({ ...capable(), features: [...capable().features, 'worktree-event'] }, options(), f.io);
    assert.deepEqual(result.envelope.error, { code, message: `${code} kernel words` });
    f = fixture({ exec: (_b, _a, _o, done) => done(Object.assign(Error('exit 1'), { code: 1 }), JSON.stringify(doc)) });
    result = await cliSpawnApply(capable(), options(), f.io);
    assert.notEqual(result.envelope.error.message, `${code} kernel words`);
  }
});
// #802 review: execFile's own timeout destroys the child's output before it signals it, so the deadline of a
// worktree-event CLI is ours. These run REAL short-lived subprocesses through node:child_process.execFile.
const realChild = (body, t) => {
  const dir = mkdtempSync(join(tmpdir(), 'spawn-apply-cli-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, 'cli.mjs'), ready = join(dir, 'ready'); writeFileSync(script, body);
  const exec = (_bin, _argv, opts, done) => execFile(process.execPath, [script, ready], { ...opts, cwd: dir }, done);
  // The deadline fires only once the child has its SIGTERM handler (it writes `ready`): never a race with its start.
  const timer = (fn, ms) => { let stop = false; const tick = () => { if (stop) return; if (existsSync(ready)) setTimeout(() => { if (!stop) fn(); }, ms); else setTimeout(tick, 10); }; tick(); return () => { stop = true; }; };
  return { exec, timer };
};
const onTerm = out => `import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => { ${out ? `process.stdout.write(${JSON.stringify(JSON.stringify(out))} + '\\n', () => process.exit(143));` : ''} });
writeFileSync(process.argv[2], 'ready'); setInterval(() => {}, 1000);`;
const hooked = () => ({ ...capable(), features: [...capable().features, 'worktree-event'] });
test('#802 (real subprocess): at our deadline a worktree-event CLI gets SIGTERM with its output still read; its E_INTERRUPTED envelope is the outcome', async t => {
  const child = realChild(onTerm(interrupted()), t), f = fixture({ exec: child.exec });
  const result = await cliSpawnApply(hooked(), options({ deadlineMs: 1920000 }), { ...f.io, timer: child.timer, timeoutMs: 50, graceMs: 5000 });
  assert.equal(result.started, true); assert.equal(result.envelope.error.code, 'E_INTERRUPTED');
  assert.match(result.envelope.error.message, /interrupted by SIGTERM/);
  assert.equal(f.calls[0].opts.timeout, undefined, 'not execFile\'s timeout, which destroys the output first');
  assert.equal(f.calls[0].opts.detached, true, 'in a session of its own, whatever exec is given');
});
test('#802 (real subprocess): a complete success envelope printed after our SIGTERM is forwarded for the broker to qualify', async t => {
  const child = realChild(onTerm(ok), t), f = fixture({ exec: child.exec });
  const result = await cliSpawnApply(hooked(), options(), { ...f.io, timer: child.timer, timeoutMs: 50, graceMs: 5000 });
  assert.equal(result.started, true); assert.deepEqual(result.envelope, ok);
});
test('#802 (real subprocess): a CLI that outlives SIGTERM by the grace period is killed, and with no envelope the outcome is E_CLI_TIMEOUT', async t => {
  const child = realChild(onTerm(null), t), f = fixture({ exec: child.exec });
  const result = await cliSpawnApply(hooked(), options(), { ...f.io, timer: child.timer, timeoutMs: 50, graceMs: 300 });
  assert.equal(result.started, true); assert.equal(result.envelope.error.code, 'E_CLI_TIMEOUT');
});
test('#802 (real subprocess): an older CLI keeps execFile\'s timeout: a kill is E_CLI_TIMEOUT whatever it prints', async t => {
  const f = fixture({ exec: realChild(onTerm(interrupted()), t).exec });
  const result = await cliSpawnApply(capable(), options(), { ...f.io, timeoutMs: 200 });
  assert.equal(f.calls[0].opts.timeout, 200);
  assert.equal(result.envelope.error.code, 'E_CLI_TIMEOUT');
});
test('#802: a CLI that finishes before the deadline arms no signal', async () => {
  let armed = 0; const f = fixture();
  await cliSpawnApply(hooked(), options(), { ...f.io, timer: () => { armed++; return () => {}; } });
  assert.equal(armed, 0);
});

// #1246 K1: --max-age rides right after --expect-decision, only where the CLI lists spawn-apply-max-age.
test('#1246 K1: maxAge becomes --max-age right after --expect-decision with the feature, and nothing without it', async () => {
  const c = { ...capable(), features: [...capable().features, 'spawn-apply-max-age'] };
  const f = fixture(), input = options({ maxAge: 60 });
  assert.equal((await cliSpawnApply(c, input, f.io)).started, true);
  const argv = f.calls[0].argv, at = argv.indexOf('--expect-decision');
  assert.deepEqual(argv.slice(at, at + 6), ['--expect-decision', input.decision.revision, '--max-age', '60', '--idempotency-key', input.key]);
  assert.equal(argv.filter(a => a === '--max-age').length, 1);
  const plain = fixture(); await cliSpawnApply(c, options(), plain.io);
  assert.deepEqual(plain.calls[0].argv.filter(a => a !== '--max-age' && a !== '60'), plain.calls[0].argv, 'no maxAge: no flag');
  assert.deepEqual(argv.filter((a, i) => !(i === at + 2 || i === at + 3)).map(a => a.replace(/\/inert\/tmp\/[^/]+/, '')), plain.calls[0].argv.map(a => a.replace(/\/inert\/tmp\/[^/]+/, '')), 'nothing else in the argv changes');
  const older = fixture(); await cliSpawnApply(capable(), options({ maxAge: 60 }), older.io);
  assert.equal(older.calls[0].argv.includes('--max-age'), false, 'an older kernel never sees the flag');
});
test('#1246 K1: an invalid maxAge is refused before any effect', async () => {
  const c = { ...capable(), features: [...capable().features, 'spawn-apply-max-age'] };
  for (const maxAge of [0, -1, 1.5, '60', 3601, null, NaN]) {
    const f = fixture(), r = await cliSpawnApply(c, options({ maxAge }), f.io);
    assert.equal(r.started, false, String(maxAge)); assert.equal(r.envelope.error.code, 'E_BAD_ARGS');
    assert.equal(f.calls.length + f.files.length, 0);
  }
});
