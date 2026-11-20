import test from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../../client/cli-locator.mjs';
import { cliSpawnPreview } from '../../client/spawn-preview-cli.mjs';
import { createSpawnPreviewBoundary, createSpawnPreviewFlights } from '../../client/spawn-preview.mjs';
import { previewChoices, previewData } from '../../client/spawn-preview-contract.mjs';
import { cli, target, selector, anchor, context, request, data, envelope, deferred, tick, kernel, DEPLOYMENT, ROOT } from './helpers/spawn-preview-fixture.mjs';
test('locator forwards exactly API2; old advertised API1 stays unavailable', async () => {
  for (const spawnPreviewApi of [undefined, 1, '2', true, 3, 2]) {
    const found = await discover({ testedVersion: '0.69.17', persisted: () => cli.bin, env: {}, isExecutableFile: () => true }, async () => ({ stdout: JSON.stringify({ schemaVersion: 1, name: '@awebai/oats', version: '0.26.0', desktopApi: 1, features: ['spawn-preview-2'], spawnPreviewApi }) }));
    assert.equal(found.spawnPreviewApi, spawnPreviewApi === 2 ? 2 : undefined);
  }
});
for (const c of [null, { ...cli, spawnPreviewApi: 1, features: ['spawn-preview'] }, { ...cli, spawnPreviewApi: '2' }, { ...cli, spawnPreviewApi: 3 }, { ...cli, features: ['spawn-preview'] }, { ...cli, features: 'spawn-preview-2' }]) test(`API2 fence BEFORE any exec (${JSON.stringify(c?.spawnPreviewApi)}/${JSON.stringify(c?.features)})`, async () => {
  let calls = 0;
  const exec = () => { calls++; throw Error('old CLI would SPAWN'); };
  assert.equal((await cliSpawnPreview(c, { target, choices: {} }, { exec })).error.code, 'E_PREVIEW_UNAVAILABLE');
  const ctx = context(); ctx.cli = c;
  const result = await createSpawnPreviewBoundary({ flights: createSpawnPreviewFlights(), invoke: () => { calls++; return envelope(data()); } })(request(), () => ctx);
  assert.equal(result.reason.code, 'E_PREVIEW_UNAVAILABLE'); assert.equal(calls, 0);
});
test('qualified boundary uses fixed exact-root argv, tagged model and anchor; no task, apply or files', async () => {
  const c = context(); let seen;
  const choices = { purpose: 'review', branch: 'feat/review', base: 'release', model: { kind: 'native-default' }, harness: 'codex', backend: 'tmux', launchConfig: 'personal', yolo: false,
    relation: { kind: 'child', anchor } };
  const read = createSpawnPreviewBoundary({ flights: createSpawnPreviewFlights(), invoke: (cli, args) => cliSpawnPreview(cli, args, { env: { PATH: '/fixture/bin', HOME: '/fixture/home', PI_AGENTS_ROOT: '/other', OATS_DEPLOYMENT: '/D', OATS_RESOLUTION: '/R', OATS_PREVIEW_PREFLIGHT_BUDGET_MS: '999999' }, exec: (bin, argv, opts, callback) => {
    seen = { bin, argv, opts }; callback(null, JSON.stringify(envelope(data(args.target))));
  } }) });
  const result = await read(request(choices), () => c); assert.equal(result.status, 'available');
  assert.deepEqual(seen.argv, ['spawn', 'release-manager', '--dir', DEPLOYMENT, '--agents-root', ROOT, '--preview', '--purpose', 'review', '--branch', 'feat/review', '--base', 'release', '--runtime', 'codex', '--launch-config', 'personal', '--backend', 'tmux', '--model', '@native-default', '--no-yolo', '--relation', 'child', '--relative-to', 'release-manager-race', '--relative-root', ROOT, '--json']);
  assert.deepEqual(seen.opts.env, { PATH: '/fixture/bin', HOME: '/fixture/home' }); assert.equal(seen.opts.cwd, DEPLOYMENT); assert.equal(seen.opts.shell, false);
  assert.equal(seen.opts.timeout, 30000); assert.equal(seen.opts.maxBuffer, 4194304);
});
for (const choices of [{ task: 'SECRET' }, { repo: '/other' }, { workDir: '/other' }, { env: { TOKEN: 'secret' } }, { expectDecision: 'x' }, { branch: '--no-launch' }, { base: 'x\n--force' }, { purpose: '../elsewhere' },
  { model: null }, { relation: null }, { model: { kind: 'custom', value: '@native-default' } }, { model: { kind: 'custom', value: '--preview' } },
  { allowChildSpawns: false }, { work: 'checkout' }, { work: 'directory' }, { work: true },
  { relation: { kind: 'child', anchor: { ...anchor, server: 'remote' } } },
  // The fixture CLI is an older kernel whose sessionBackends still lists herdr: Herdr is refused anyway.
  { backend: 'herdr' }]) test(`strict read choices refuse ${JSON.stringify(choices)}`, async () => {
  assert.equal(previewChoices(choices), null);
  const result = await createSpawnPreviewBoundary({ flights: createSpawnPreviewFlights(), invoke: assert.fail })(request(choices), context); assert.equal(result.reason.code, 'E_BAD_ARGS');
});
for (const [name, alter, choices = {}] of [
  ['remote workspace', c => c.workspace.remote = true], ['server workspace', c => c.workspace.server = 'remote'], ['remote soul', c => c.agents[0].remote = true],
  ['duplicate soul', c => c.agents.push({ ...c.agents[0] })], ['vanished soul', c => c.agents = []], ['attached', c => c.agents[0].work = 'attached'],
  ['non-worktree branch', c => c.agents[0].work = 'checkout', { branch: 'feat/a' }], ['harness unavailable', c => c.cli.harnesses = [], { harness: 'codex' }],
  ['worktree override for a worktree soul', () => {}, { work: 'worktree' }], ['worktree override for a directory soul', c => c.agents[0].work = 'directory', { work: 'worktree' }],
  ['branch for a directory soul', c => c.agents[0].work = 'directory', { branch: 'feat/a' }],
  ['ambiguous anchor pair', c => c.instances.push({ ...c.instances[0], agent: 'other', home: '/team/agents/other/instances/boss-1' }), { relation: { kind: 'child', anchor } }],
]) test(`${name} refuses without command/fallback`, async () => {
  const c = context(); alter(c); const result = await createSpawnPreviewBoundary({ flights: createSpawnPreviewFlights(), invoke: assert.fail })(request(choices), () => c); assert.equal(result.status, 'unavailable');
});
test('a checkout soul may be asked for a worktree — then branch/base are its to choose', async () => {
  const c = context(); c.agents[0].work = 'checkout'; let argv;
  const read = createSpawnPreviewBoundary({ flights: createSpawnPreviewFlights(), invoke: (cli, args) => cliSpawnPreview(cli, args, { env: {}, exec: (_b, a, _o, done) => { argv = a; done(null, JSON.stringify(envelope(data()))); } }) });
  assert.equal((await read(request({ work: 'worktree', branch: 'feat/a' }), () => c)).status, 'available');
  assert.deepEqual(argv.slice(argv.indexOf('--preview') + 1), ['--work', 'worktree', '--branch', 'feat/a', '--json']);
});
test('two slots per preview, shared by its reads; exact duplicates coalesce; all outcomes release and no result cache', async () => {
  const gates = [], c = context(), flights = createSpawnPreviewFlights();
  const invoke = () => { const d = deferred(); gates.push(d); return d.promise; }, read = createSpawnPreviewBoundary({ flights, invoke });
  const a = read(request(), () => c), duplicate = read(request(), () => c), b = read(request({ purpose: 'other' }), () => c);
  await tick(); assert.equal(gates.length, 2);
  assert.equal((await createSpawnPreviewBoundary({ flights, invoke: assert.fail })(request(), context)).reason.code, 'E_BUSY', 'another read of the same preview has no slot');
  gates[0].resolve(envelope(data())); gates[1].reject(Error('PRIVATE')); assert.equal((await a).status, 'available'); assert.deepEqual(await duplicate, await a); assert.equal((await b).status, 'unavailable');
  const again = read(request(), () => c); await tick(); assert.equal(gates.length, 3); gates[2].resolve(envelope(data())); await again;
});
for (const reject of [false, true]) for (const kind of ['CLI', 'workspace', 'soul', 'anchor']) test(`late ${reject ? 'rejection' : 'success'} revalidates ${kind}`, async () => {
  const c = context(), gate = deferred(), read = createSpawnPreviewBoundary({ flights: createSpawnPreviewFlights(), invoke: () => gate.promise });
  const r = read(request({ relation: { kind: 'child', anchor } }), () => c); await tick();
  if (kind === 'CLI') c.cli.bin = '/other/oats'; if (kind === 'workspace') c.workspace.scope = '/other'; if (kind === 'soul') c.agents = []; if (kind === 'anchor') c.instances[0].createdAt = 'recreated';
  if (reject) gate.reject(Error('PRIVATE')); else gate.resolve(envelope(data()));
  assert.equal((await r).reason?.code, 'E_TARGET_CHANGED');
});
for (const [error, code] of [[{ killed: true }, 'E_CLI_TIMEOUT'], [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'E_CLI_OUTPUT_LIMIT'], [{ code: 1 }, 'E_CLI_FAILED']]) test(`adapter clean-exit rule ${code}`, async () => {
  assert.equal((await cliSpawnPreview(cli, { target, choices: {} }, { exec: (_b, _a, _o, done) => done(error, JSON.stringify(envelope(data()))) })).error.code, code);
});
test('malformed stdout, synchronous failure and producer refusal resolve safely, never retry', async () => {
  assert.equal((await cliSpawnPreview(cli, { target, choices: {} }, { exec: (_b, _a, _o, cb) => cb(null, 'PRIVATE') })).error.code, 'E_CLI_PROTOCOL');
  assert.equal((await cliSpawnPreview(cli, { target, choices: {} }, { exec: () => { throw Error('PRIVATE'); } })).error.code, 'E_CLI_FAILED');
  let calls = 0; const result = await createSpawnPreviewBoundary({ flights: createSpawnPreviewFlights(), invoke: async () => { calls++; return { schemaVersion: 1, ok: false, error: { code: 'E_CHILD_SPAWNS_DISABLED', message: 'parent does not allow children' } }; } })(request(), context);
  assert.equal(calls, 1); assert.equal(result.reason.code, 'E_CHILD_SPAWNS_DISABLED'); assert.equal(result.reason.message, 'parent does not allow children');
});
test('a kernel refusal keeps its code and message (the remedy); an unprintable or oversized message falls back to the fixed text', async () => {
  const missing = kernel('preview-clone-missing');
  const through = await cliSpawnPreview(cli, { target, choices: {} }, { exec: (_b, _a, _o, done) => done({ code: 1 }, JSON.stringify(missing)) });
  assert.equal(through.error.code, 'E_CLONE_MISSING'); assert.equal(through.error.message, missing.error.message); assert.match(through.error.message, /git clone /);
  const read = createSpawnPreviewBoundary({ flights: createSpawnPreviewFlights(), invoke: () => through });
  const result = await read(request(), context);
  assert.deepEqual(result.reason, { code: 'E_CLONE_MISSING', message: missing.error.message });
  for (const message of ['bad\u0000byte', 'x'.repeat(2049), '', 42]) {
    const reason = (await createSpawnPreviewBoundary({ flights: createSpawnPreviewFlights(), invoke: async () => ({ schemaVersion: 1, ok: false, error: { code: 'E_CLONE_MISSING', message } }) })(request(), context)).reason;
    assert.equal(reason.code, 'E_CLONE_MISSING'); assert.equal(reason.message, 'This soul works in a member repository that is not cloned on this machine.');
  }
  const unknown = (await createSpawnPreviewBoundary({ flights: createSpawnPreviewFlights(), invoke: async () => ({ schemaVersion: 1, ok: false, error: { code: 'not-a-kernel-code', message: 'x' } }) })(request(), context)).reason;
  assert.equal(unknown.code, 'E_CLI_FAILED');
});
test('a kernel refusal\'s fix travels from the CLI\'s printed envelope: beside the kernel\'s own message, within the bound, and no other key of details', async () => {
  const MESSAGE = 'the launch this soul would get is not one this machine can run', FIX = 'name a launch for this spawn, or correct the preference';
  const printed = (error) => ({ schemaVersion: 1, ok: false, error });
  const through = (error) => cliSpawnPreview(cli, { target, choices: {} }, { exec: (_b, _a, _o, done) => done({ code: 1 }, JSON.stringify(printed(error))) });
  const answer = await through({ code: 'E_LAUNCH_REFUSED', message: MESSAGE, details: { fix: FIX, harness: 'codex', at: 'a-file#/a/key', keys: ['one', 'two'] } });
  assert.deepEqual(answer, printed({ code: 'E_LAUNCH_REFUSED', message: MESSAGE, details: { fix: FIX } }), 'the kernel\'s shape, and of details the fix alone');
  assert.deepEqual((await createSpawnPreviewBoundary({ flights: createSpawnPreviewFlights(), invoke: () => answer })(request(), context)).reason, { code: 'E_LAUNCH_REFUSED', message: MESSAGE, fix: FIX }, 'the boundary reads it where the kernel puts it');
  // A fix of exactly the bound travels; nothing that is not a printable string within it does.
  assert.deepEqual((await through({ code: 'E_LAUNCH_REFUSED', message: MESSAGE, details: { fix: 'f'.repeat(1024) } })).error.details, { fix: 'f'.repeat(1024) });
  for (const fix of ['f'.repeat(1025), 'bad\u0007bell', 'two\nlines', '', '   ', 42, null, { fix: FIX }, [FIX]])
    assert.deepEqual((await through({ code: 'E_LAUNCH_REFUSED', message: MESSAGE, details: { fix } })).error, { code: 'E_LAUNCH_REFUSED', message: MESSAGE }, JSON.stringify(fix));
  for (const details of [undefined, null, 'fix', [], {}]) assert.deepEqual((await through({ code: 'E_LAUNCH_REFUSED', message: MESSAGE, details })).error, { code: 'E_LAUNCH_REFUSED', message: MESSAGE }, JSON.stringify(details));
  // Never beside a sentence of the Desktop's table: a message that does not travel takes its fix with it.
  for (const message of ['bad\u0000byte', 'x'.repeat(2049), '', 42]) {
    const { error } = await through({ code: 'E_CLONE_MISSING', message, details: { fix: FIX } });
    assert.deepEqual(error, { code: 'E_CLONE_MISSING', message: 'This soul works in a member repository that is not cloned on this machine.' }, JSON.stringify(message));
  }
  const unknown = (await through({ code: 'not-a-kernel-code', message: MESSAGE, details: { fix: FIX } })).error;
  assert.equal(unknown.code, 'E_CLI_FAILED'); assert.deepEqual(Object.keys(unknown), ['code', 'message']); assert.notEqual(unknown.message, MESSAGE);
  // The exec owner's own failures carry no details.
  const timedOut = await cliSpawnPreview(cli, { target, choices: {} }, { exec: (_b, _a, _o, done) => done({ killed: true }, JSON.stringify(printed({ code: 'E_LAUNCH_REFUSED', message: MESSAGE, details: { fix: FIX } }))) });
  assert.deepEqual(Object.keys(timedOut.error), ['code', 'message']); assert.equal(timedOut.error.code, 'E_CLI_TIMEOUT');
});
test('projection rejects API1, wrong echoes and inconsistent decisions; drops task/env/executable', () => {
  const v = data(); v.task = 'PRIVATE'; v.env = { SECRET: 'PRIVATE' }; v.executable = 'PRIVATE'; assert.doesNotMatch(JSON.stringify(previewData(v, target)), /PRIVATE/);
  for (const alter of [v => v.spawnPreviewApi = 1, v => v.preview = false, v => v.subject.agentsRoot = '/other', v => v.subject.dir = '/other',
    v => v.decision.home = '/other', v => v.decision.revision = '', v => v.decision.revision = 'a'.repeat(64), v => v.decision.base.oid = 'invalid', v => v.preflight.status = 'future',
    v => v.preflight.status = 'skipped', v => v.preflight.elapsedMs = -1, v => v.backendStatus.name = 'herdr', v => v.backendStatus.installed = 'true',
    v => v.backendStatus.started = true, v => v.runtime = 'claude', v => v.work = 'checkout', v => v.model = 'opus', v => v.yolo = true, v => v.instance = 'other',
    v => v.resolution = 'c'.repeat(24), v => v.decision.resolution = 'bad', v => delete v.decision.effective, v => v.worktree = null, v => v.team = 7]) { const bad = data(); alter(bad); assert.equal(previewData(bad, target), null); }
  // v2 capabilities/skills are kernel objects; they are not projected, whatever their shape.
  const withObjects = data(); assert.equal(typeof withObjects.capabilities[0], 'object'); assert.ok(previewData(withObjects, target));
  assert.equal(Object.hasOwn(previewData(withObjects, target), 'capabilities'), false);
  for (const status of ['complete', 'timeout']) { const v = data(); v.preflight.status = status; assert.equal(previewData(v, target).preflight.status, status); }
  assert.equal(previewData(data(), target).yolo, null, 'omitted permission setting is not invented false');
  for (const yolo of [true, false]) { const value = data(); value.yolo = value.decision.effective.yolo = yolo; assert.equal(previewData(value, target).yolo, yolo); }
  assert.equal(previewData(kernel('preview-yolo').result, target).yolo, true);
  for (const name of ['preview-worktree-default', 'preview-runtime-claude', 'preview-native-default', 'preview-branch-base', 'preview-after-apply'])
    assert.ok(previewData(kernel(name).result, target), `${name} projects`);
});
test('an older kernel preview that resolves the Herdr backend does not project', () => {
  const v = data(); v.backend = v.backendStatus.name = v.decision.effective.backend = 'herdr';
  assert.equal(previewData(v, target), null);
});

// `--name <slug>` (kernel 0.25.9, feature spawn-name): the exact instance
// name without the soul prefix. Admitted only when the CLI advertises it;
// the boundary checks shape only — naming rules are the kernel's (E_INSTANCE_NAME_INVALID).
// The captured kernel advertises spawn-name; `older` withholds it.
const named = () => { const c = context(); assert.ok(c.cli.features.includes('spawn-name')); return c; };
const older = () => { const c = context(); c.cli = { ...c.cli, features: c.cli.features.filter(f => f !== 'spawn-name') }; return c; };
test('name is sent as --name, exactly, only when the CLI advertises spawn-name', async () => {
  let argv;
  const read = createSpawnPreviewBoundary({ flights: createSpawnPreviewFlights(), invoke: (cli, args) => cliSpawnPreview(cli, args, { exec: (bin, a, opts, callback) => {
    argv = a; callback(null, JSON.stringify(envelope(data(args.target))));
  } }) });
  const c = named(); assert.equal((await read(request({ name: 'api-v2' }), () => c)).status, 'available');
  assert.deepEqual(argv.slice(argv.indexOf('--preview') + 1, argv.indexOf('--preview') + 3), ['--name', 'api-v2']);
  assert.equal(argv.includes('--purpose'), false);
  let calls = 0;
  const old = await createSpawnPreviewBoundary({ flights: createSpawnPreviewFlights(), invoke: () => { calls++; return envelope(data()); } })(request({ name: 'api-v2' }), older);
  assert.equal(old.reason.code, 'E_UNSUPPORTED_OPTION'); assert.equal(calls, 0, 'an older kernel would treat it as an unknown flag');
});
for (const choices of [{ name: 'api-v2', purpose: 'api-v2' }, { name: '../x' }, { name: '--preview' }, { name: '' }, { name: 7 }])
  test(`name choices refuse ${JSON.stringify(choices)}`, async () => {
    assert.equal(previewChoices(choices), null);
    const result = await createSpawnPreviewBoundary({ flights: createSpawnPreviewFlights(), invoke: assert.fail })(request(choices), named); assert.equal(result.reason.code, 'E_BAD_ARGS');
  });
