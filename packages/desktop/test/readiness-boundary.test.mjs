import test from 'node:test';
import assert from 'node:assert/strict';
import { cliReadiness } from '../readiness-cli.mjs';
import { createReadinessBoundary } from '../server/readiness.mjs';
import { readinessData, readinessFailure } from '../../client/readiness-contract.mjs';
import { discover } from '../../client/cli-locator.mjs';
import { context, cli, selector, target, instanceTarget, data, item, envelope, deferred, tick } from './helpers/readiness-fixture.mjs';
const request = s => ({ action: 'read', selector: s || selector });
test('installed probe forwards only exact readiness API integer, never fabricates missing support', async () => {
  for (const readinessApi of [undefined, '2', 1, true, 3, 2]) {
    const found = await discover({ testedVersion: '0.69.17', persisted: () => cli.bin, env: {}, isExecutableFile: () => true }, async () => ({ stdout: JSON.stringify({
      schemaVersion: 1, name: '@awebai/oats', desktopApi: 1, version: '0.26.0', features: ['readiness'], readinessApi }) }));
    assert.equal(found.ok, true); assert.equal(found.readinessApi, readinessApi === 2 ? 2 : undefined);
  }
});
for (const [kind, s, expected] of [
  ['soul', { kind: 'soul', soul: 'dev', agentsRoot: '/team/agents' }, ['--dir', '/team', '--soul', 'dev', '--agents-root', '/team/agents']],
  ['instance', { kind: 'instance', instance: 'dev-1', agent: 'dev', agentsRoot: '/team/agents', server: null }, ['--home', '/team/agents/dev/instances/dev-1', '--soul', 'dev', '--agents-root', '/team/agents']],
]) test(`${kind}: real boundary to fixed argv, observedAs and ambient redirection stripped`, async () => {
  const c = context(); let invocation;
  const read = createReadinessBoundary({ invoke: (bin, options) => cliReadiness(bin, options, { env: { PATH: '/fixture/bin', HOME: '/fixture/home', PI_AGENTS_ROOT: '/evil', OATS_DEPLOYMENT: '/evil', OATS_RESOLUTION: 'foreign' },
    exec: (bin, argv, opts, cb) => { invocation = { bin, argv, opts }; cb(null, JSON.stringify(envelope(data(options.target)))); } }) });
  const result = await read(request(s), () => c);
  assert.equal(result.status, 'available'); assert.equal(result.target.observedAs, kind);
  assert.deepEqual(invocation.argv, ['readiness', ...expected, '--policy', '--json']);
  assert.equal(invocation.bin, cli.bin); assert.equal(invocation.opts.cwd, '/team'); assert.equal(invocation.opts.shell, false);
  assert.equal(invocation.opts.timeout, 15000); assert.equal(invocation.opts.maxBuffer, 4194304);
  assert.deepEqual(invocation.opts.env, { PATH: '/fixture/bin', HOME: '/fixture/home' });
});
for (const [name, alter] of [
  // The probe integer is the gate (no feature string): 0.25 kernels (API 1) are refused.
  ['API absent', c => delete c.cli.readinessApi], ['API string', c => c.cli.readinessApi = '2'], ['API 1 (0.25)', c => c.cli.readinessApi = 1],
  ['API future', c => c.cli.readinessApi = 3], ['CLI unavailable', c => c.cli.ok = false], ['remote workspace', c => c.workspace.remote = true],
  ['server-marked workspace', c => c.workspace.server = 'host'], ['missing workspace', c => c.workspace = null],
]) test(`${name} refuses BEFORE process, without optimistic probing`, async () => {
  const c = context(); alter(c); let calls = 0;
  const result = await createReadinessBoundary({ invoke: () => { calls++; return envelope(data()); } })(request(), () => c);
  assert.equal(result.status, 'unavailable'); assert.equal(result.data, null); assert.equal(calls, 0);
  // A local instance selector never resolves in a remote workspace (remote reads: remote-readiness.test.mjs).
  if (name.includes('workspace') && name !== 'missing workspace') {
    const local = await createReadinessBoundary({ invoke: () => { calls++; return envelope(data()); } })(request(instanceTarget.selector), () => c);
    assert.equal(local.reason.code, 'E_SESSION_UNKNOWN'); assert.equal(calls, 0);
  }
});
for (const bad of [null, {}, [], { action: 'verify', selector }, { action: 'read', selector, verifySignatures: true },
  request({ ...selector, home: '/arbitrary' }), request({ kind: 'scope', context: '/team' }), request({ kind: 'scope', context: '/foreign' }),
  request({ kind: 'soul', soul: '--verify-signatures', agentsRoot: '/team/agents' }), request({ kind: 'soul', soul: 'dev', agentsRoot: '/foreign/agents' }),
  request({ kind: 'instance', instance: 'dev-1', agent: 'dev', agentsRoot: '/team/agents', server: 'remote' }),
  request({ kind: 'instance', instance: 'dev-1', agent: 'dev', agentsRoot: '/foreign/agents' }),
]) test(`strict request rejects ${JSON.stringify(bad)} with zero commands`, async () => {
  const result = await createReadinessBoundary({ invoke: assert.fail })(bad, context);
  assert.equal(result.status, 'unavailable'); assert.equal(result.data, null);
});
test('duplicate soul or home never selects first; remote roster does not become local', async () => {
  for (const kind of ['soul', 'instance']) for (const mode of ['duplicate', 'remote', 'home-mismatch']) {
    const c = context(), rows = kind === 'soul' ? c.agents : c.instances;
    if (mode === 'duplicate') rows.push({ ...rows[0] }); else if (mode === 'remote') rows[0].remote = true;
    else if (kind === 'instance') rows[0].home = '/wrong/home'; else rows[0].agentsRoot = '/wrong/agents';
    const s = kind === 'soul' ? { kind, soul: 'dev', agentsRoot: '/team/agents' } : { kind, instance: 'dev-1', agent: 'dev', agentsRoot: '/team/agents' };
    assert.equal((await createReadinessBoundary({ invoke: assert.fail })(request(s), () => c)).status, 'unavailable');
  }
});
test('coalesces exact reads; global four-slot ceiling rejects fanout across workspaces/invokers; releases after both paths', async () => {
  const gates = [], calls = [];
  const invoke = (bin, args) => { const gate = deferred(); gates.push(gate); calls.push(args); return gate.promise; };
  const read = createReadinessBoundary({ invoke }), c = context();
  const one = read(request(), () => c), same = read(request(), () => c);
  const rest = [1, 2, 3].map(n => { const other = context(); other.workspace.id = `team-${n}`; return read(request(), () => other); });
  await tick(); assert.equal(calls.length, 4);
  const blocked = await createReadinessBoundary({ invoke: assert.fail })(request(), context); assert.equal(blocked.reason.code, 'E_BUSY');
  gates[0].resolve(envelope(data())); for (const gate of gates.slice(1)) gate.reject(new Error('PRIVATE'));
  assert.equal((await one).status, 'available'); assert.deepEqual(await same, await one); await Promise.all(rest);
  const fresh = await createReadinessBoundary({ invoke: async () => envelope(data()) })(request(), context); assert.equal(fresh.status, 'available');
  const again = read(request(), () => c); await tick(); assert.equal(calls.length, 5); gates.at(-1).resolve(envelope(data())); await again;
});
for (const reject of [false, true]) for (const change of ['CLI', 'scope', 'target']) test(`late ${reject ? 'rejection' : 'success'} loses ${change} ownership`, async () => {
  const c = context(), gate = deferred(); const read = createReadinessBoundary({ invoke: () => gate.promise });
  const s = { kind: 'soul', soul: 'dev', agentsRoot: '/team/agents' };
  const result = read(request(s), () => c); await tick();
  if (change === 'CLI') c.cli = { ...cli, bin: '/other/oats' }; else if (change === 'scope') c.workspace.scope = '/other'; else c.agents = [];
  if (reject) gate.reject(Error('PRIVATE')); else gate.resolve(envelope(data({ ...target, observedAs: 'soul', selector: s })));
  assert.equal((await result).reason?.code, 'E_TARGET_CHANGED');
});
test('same-name home replacement does not coalesce with or accept the former incarnation', async () => {
  const c = context(), gates = [], args = [];
  const read = createReadinessBoundary({ invoke: (_bin, options) => { const d = deferred(); gates.push(d); args.push(options); return d.promise; } });
  const s = { kind: 'instance', instance: 'dev-1', agent: 'dev', agentsRoot: '/team/agents', server: null };
  c.instances[0].createdAt = 'old'; const old = read(request(s), () => c); await tick();
  c.instances[0].createdAt = 'new'; const newer = read(request(s), () => c); await tick(); assert.equal(gates.length, 2);
  gates[1].resolve(envelope(data(args[1].target))); assert.equal((await newer).status, 'available');
  gates[0].resolve(envelope(data(args[0].target))); assert.equal((await old).reason?.code, 'E_TARGET_CHANGED');
});
for (const code of ['E_UNSUPPORTED_MODE', 'unsupported-action']) test(`${code} is a stable refusal without classic retry`, async () => {
  let calls = 0; const result = await createReadinessBoundary({ invoke: async () => { calls++; return { schemaVersion: 1, ok: false, error: { code, message: 'PRIVATE details' } }; } })(request(), context);
  assert.equal(result.reason.code, code); assert.equal(calls, 1); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});
for (const [name, error, output, code] of [
  ['dirty exit', { code: 1 }, envelope(data()), 'E_CLI_FAILED'], ['timeout', { killed: true }, envelope(data()), 'E_CLI_TIMEOUT'],
  ['overflow', { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, envelope(data()), 'E_CLI_OUTPUT_LIMIT'], ['contamination', null, 'noise', 'E_CLI_PROTOCOL'],
]) test(`adapter ${name} cannot report success`, async () => {
  const result = await cliReadiness(cli.bin, { target }, { exec: (_b, _a, _o, cb) => cb(error, JSON.stringify(output)) }); assert.equal(result.error.code, code);
});
test('adapter synchronous launch failure resolves sanitized error; bad bin never dispatches', async () => {
  assert.equal((await cliReadiness(cli.bin, { target }, { exec: () => { throw Error('PRIVATE'); } })).error.code, 'E_CLI_FAILED');
  assert.equal((await cliReadiness('oats', { target }, { exec: assert.fail })).error.code, 'E_BAD_ARGS');
});
test('the four kernel checks are bounded and requiredness-checked; the subject is exactly the target; no synthetic revision or secrets', () => {
  const d = data(); d.settings = { secret: 'PRIVATE' }; d.selector.secret = 'PRIVATE';
  const projected = readinessData(d, target); assert.ok(projected); assert.equal(projected.summary.ready, false); assert.equal(projected.revision, undefined);
  assert.deepEqual(Object.keys(projected.checks), ['installed', 'configured', 'member', 'providers']);
  assert.deepEqual(projected.subject, { kind: 'soul', soul: 'dev', repoKey: d.subject.repoKey, commit: d.subject.commit, team: d.subject.team });
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE/);
  for (const mutate of [v => v.summary.ready = true, v => v.summary.required = 0, v => v.checks.member.items[0].required = 'true',
    v => v.subject.soul = 'other', v => v.subject.kind = 'scope', v => v.checks.installed.items = Array.from({ length: 1001 }, () => item()), v => v.policy.childSpawns.enforced = 'true',
    v => v.readinessApi = 1, v => delete v.checks.providers, v => v.checks.configured.status = 'future', v => v.checks.installed.items[0].reason = 'x'.repeat(1025),
    v => v.checks.providers.items[0].result = { status: 'ready', problems: [] },
    v => v.checks.providers.items[0].result = { status: 'ready', problems: [], warnings: [{ code: 'x' }] },
    v => v.checks.providers.items[0].result = { status: 'ready', problems: [], warnings: 'e2ee-disabled' }]) {
    const value = data(); mutate(value); assert.equal(readinessData(value, target), null);
  }
});
test('Ready is never inferred from zero items or optional success; only consistent producer true passes', () => {
  const d = data(); for (const c of Object.values(d.checks)) { c.status = 'not-applicable'; c.items = []; }
  d.summary = { ready: false, required: 0, pass: 0, fail: 0, unknown: 0 }; assert.equal(readinessData(d, target).summary.ready, false);
  d.summary.ready = true; assert.equal(readinessData(d, target), null);
  // The provider's own "ready" makes the last required item pass (relayed verbatim).
  const ready = data(), provider = ready.checks.providers.items[0];
  Object.assign(provider, { status: 'pass', reason: null, result: { status: 'ready', problems: [], warnings: [] }, problems: [] }); ready.checks.providers.status = 'pass';
  ready.summary = { ...ready.summary, ready: true, pass: ready.summary.required, fail: 0, unknown: 0 };
  const projected = readinessData(ready, target);
  assert.equal(projected.summary.ready, true); assert.deepEqual(projected.checks.providers.items[0].result, { status: 'ready', problems: [], warnings: [] });
});
test('provider warnings are relayed verbatim and never change the item status or the summary', () => {
  const ready = data(), provider = ready.checks.providers.items[0];
  const warnings = [{ code: 'e2ee-disabled', message: 'end-to-end encryption is disabled for this binding' }];
  Object.assign(provider, { status: 'pass', reason: null, result: { status: 'ready', problems: [], warnings }, problems: [] }); ready.checks.providers.status = 'pass';
  ready.summary = { ...ready.summary, ready: true, pass: ready.summary.required, fail: 0, unknown: 0 };
  const projected = readinessData(ready, target);
  assert.equal(projected.summary.ready, true); assert.equal(projected.checks.providers.items[0].status, 'pass');
  assert.deepEqual(projected.checks.providers.items[0].result.warnings, warnings);
});
test("the provider's own answer is relayed verbatim (captured: needs-configuration, then ready once state-dir is set); no trusted check or signature", () => {
  const failing = readinessData(data(), target), provider = failing.checks.providers.items[0];
  const needs = { code: 'needs-configuration', message: 'setting state-dir is required (absolute host path)' };
  assert.equal(provider.status, 'fail'); assert.equal(provider.reason, needs.message); assert.equal(failing.summary.ready, false);
  assert.deepEqual(provider.result, { status: 'needs-configuration', problems: [needs], warnings: [] });
  const passing = readinessData(data(instanceTarget, 'readiness-instance-provider-pass'), instanceTarget), ok = passing.checks.providers.items[0];
  assert.equal(ok.status, 'pass'); assert.equal(ok.reason, null); assert.deepEqual(ok.result, { status: 'ready', problems: [], warnings: [] });
  assert.equal(passing.summary.ready, true, 'the capture is Ready once the provider is');
  assert.equal(Object.hasOwn(failing.checks, 'trusted'), false); assert.equal(Object.hasOwn(failing.checks, 'enrolled'), false);
  assert.doesNotMatch(JSON.stringify(failing), /signature/);
});
test('a provider that cannot answer stays unknown with result null and its problems verbatim (documented shape)', () => {
  const d = data(), p = d.checks.providers.items[0], problem = { code: 'provider-unavailable', message: 'oats.okf check answered an unrecognised result' };
  Object.assign(p, { status: 'unknown', result: null, problems: [problem], reason: problem.message }); d.checks.providers.status = 'unknown'; d.summary.fail--; d.summary.unknown++;
  const provider = readinessData(d, target).checks.providers.items[0];
  assert.equal(provider.status, 'unknown'); assert.equal(provider.result, null); assert.deepEqual(provider.problems, [problem]);
});

test('a provider answer is one of four, and the item status follows from it; a contradiction fails closed', () => {
  const answer = (status, itemStatus) => {
    const d = data(), provider = d.checks.providers.items[0], was = provider.status;
    Object.assign(provider, { status: itemStatus, reason: null, problems: [], result: { status, problems: [], warnings: [] } });
    d.checks.providers.status = itemStatus === 'pass' ? 'pass' : itemStatus;
    d.summary[was]--; d.summary[itemStatus]++; d.summary.ready = d.summary.fail === 0 && d.summary.unknown === 0;
    return readinessData(d, target);
  };
  for (const [status, itemStatus] of [['ready', 'pass'], ['needs-configuration', 'fail'], ['authorization-required', 'fail'], ['unavailable', 'unknown']]) {
    const projected = answer(status, itemStatus); assert.ok(projected, status);
    assert.deepEqual(projected.checks.providers.items[0].result, { status, problems: [], warnings: [] });
    for (const other of ['pass', 'fail', 'unknown'].filter(s => s !== itemStatus)) assert.equal(answer(status, other), null, `${status} with item ${other}`);
  }
  // Additive statuses: an unrecognised answer is relayed as sent and the kernel's item status stands.
  for (const itemStatus of ['fail', 'unknown']) assert.deepEqual(answer('signed-out', itemStatus).checks.providers.items[0].result, { status: 'signed-out', problems: [], warnings: [] });
  assert.equal(answer('x'.repeat(65), 'unknown'), null, 'bounded'); assert.equal(answer('', 'unknown'), null);
});
test("dispatch on the payload's own integer: a classic scope's readinessApi 1 answer is named, never read", async () => {
  const c = context();
  for (const [api, code] of [[1, 'classic-workspace'], [3, 'E_CLI_PROTOCOL']]) {
    const classic = data(); classic.readinessApi = api;
    const result = await createReadinessBoundary({ invoke: () => envelope(classic) })(request(), () => c);
    assert.equal(result.status, 'unavailable'); assert.equal(result.data, null); assert.equal(result.reason.code, code, String(api));
  }
  assert.match(readinessFailure('classic-workspace').reason.message, /classic layout/);
});
