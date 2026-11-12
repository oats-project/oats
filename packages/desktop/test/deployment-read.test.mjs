import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { cliDeploymentRead, DEPLOYMENT_READ_MAX_BUFFER, DEPLOYMENT_READ_TIMEOUT } from '../../client/deployment-read-cli.mjs';
import { deploymentReadGate, deploymentFailure, deploymentErrorCode, DEPLOYMENT_FEATURES, remoteFailureCause, panelErrorCause } from '../../client/deployment-contract.mjs';
import { deploymentStatusData, workspaceStatusData } from '../../client/deployment-data.mjs';
import builder from '../electron-builder.config.cjs';

const file = name => new URL(`./fixtures/workspace-v2/${name}.json`, import.meta.url);
const fixture = name => JSON.parse(readFileSync(file(name), 'utf8'));
const status = fixture('status'), header = fixture('workspace-status'), probe = fixture('version');
const context = dirname(status.root);
// An already accepted locator result. The producer's source version is retained
// in the fixture and provenance; version-band tests belong to the locator.
const cli = () => ({ ...probe, ok: true, bin: '/fixture/bin/oats' });
const input = action => ({ action, context });
const reply = (document, error = null) => (_bin, _args, _options, callback) => callback(error, JSON.stringify(document));

test('Northwind producer fixtures are exit-0 kernel documents with recorded hashes, argv and kernel', () => {
  const provenance = fixture('provenance');
  for (const [name, entry] of Object.entries(provenance.files)) {
    assert.equal(createHash('sha256').update(readFileSync(file(name))).digest('hex'), entry.fixtureSha256);
  }
  // Every fixture is an exit-0 document of the released kernel, with its argv.
  assert.deepEqual(Object.keys(provenance.files).sort(), ['status', 'status-identities', 'version', 'workspace-status']);
  for (const entry of Object.values(provenance.files)) {
    assert.equal(entry.exit, 0); assert.equal(entry.kernel, provenance.kernel); assert.equal(entry.argv.at(-1), '--json');
  }
  assert.equal(probe.version, provenance.kernel);
  assert.equal(probe.workspaceApi, 2);
  for (const feature of DEPLOYMENT_FEATURES.filter(f => f !== 'packages-no-approval')) assert.ok(probe.features.includes(feature), feature);
});

for (const action of ['status', 'workspace-status']) test(`${action}: fixed argv, selected cwd, bounded I/O and ambient selector removal`, async () => {
  const environment = { KEEP: 'fixture', PI_AGENTS_ROOT: '/foreign', OATS_DEPLOYMENT: '/foreign', OATS_RESOLUTION: 'foreign', OATS_INSTANCE_HOME: '/foreign', PI_AGENT_HOME: '/foreign', OATS_HOME: '/foreign', OATS_INSTANCE: 'foreign', PI_AGENT_INSTANCE: 'foreign' };
  let calls = 0;
  const document = action === 'status' ? status : header;
  const result = await cliDeploymentRead(cli(), input(action), { env: environment, exec(bin, args, options, callback) {
    calls++; assert.equal(bin, '/fixture/bin/oats');
    assert.deepEqual(args, [...(action === 'status' ? ['status'] : ['workspace', 'status']), '--dir', context, '--json']);
    assert.equal(options.cwd, context); assert.equal(options.shell, false); assert.equal(options.encoding, 'utf8');
    assert.equal(options.timeout, DEPLOYMENT_READ_TIMEOUT); assert.equal(options.maxBuffer, DEPLOYMENT_READ_MAX_BUFFER);
    assert.deepEqual(options.env, { KEEP: 'fixture' }); callback(null, JSON.stringify(document));
  } });
  assert.equal(calls, 1); assert.deepEqual(result, { ok: true, document });
  assert.equal(environment.OATS_INSTANCE_HOME, '/foreign', 'caller environment is not mutated');
});

for (const feature of ['workspace-v2', 'instance-modules', 'served-identity', 'packages-no-approval']) test(`actual exec owner refuses missing ${feature}, names it, and never invokes`, async () => {
  const state = cli(); state.features = state.features.filter(f => f !== feature);
  const result = await cliDeploymentRead(state, input('status'), { exec() { assert.fail('unadvertised dispatch'); } });
  assert.equal(result.ok, false); assert.equal(result.reason.feature, feature); assert.match(result.reason.message, new RegExp(feature));
});
for (const value of [undefined, 1, '2', 3]) test(`workspaceApi ${String(value)} is not API2`, async () => {
  const result = await cliDeploymentRead({ ...cli(), workspaceApi: value }, input('workspace-status'), { exec() { assert.fail('unsupported dispatch'); } });
  assert.equal(result.reason.code, 'E_DEPLOYMENT_FEATURE');
});
test('workspace header does not require roster-only features, but does require packages-no-approval', () => {
  assert.equal(deploymentReadGate({ ...cli(), features: ['workspace-v2', 'packages-no-approval'] }, 'workspace-status'), null);
  assert.equal(deploymentReadGate({ ...cli(), features: ['workspace-v2'] }, 'workspace-status').reason.feature, 'packages-no-approval',
    'an older kernel gets the update state, never a half-working header');
  assert.equal(deploymentReadGate({ ...cli(), features: 'workspace-v2' }, 'workspace-status').ok, false);
});
for (const options of [{ action: 'sync', context }, { action: 'status', context: 'relative' }, { action: 'status', context: context + '/..' }, { action: 'status', context, argv: ['--force'] }, { action: 'status', context: context + '\0' }]) test(`invalid input is refused: ${JSON.stringify(options)}`, async () => {
  assert.equal((await cliDeploymentRead(cli(), options, { exec() { assert.fail('bad input dispatched'); } })).reason.code, 'E_BAD_ARGS');
});
test('unavailable CLI cannot observe through a filesystem fallback', async () => {
  assert.equal((await cliDeploymentRead({ ...cli(), ok: false }, input('status'), { exec() { assert.fail(); } })).reason.code, 'E_CLI_UNAVAILABLE');
});
for (const error of [{ code: 86 }, { code: 1 }, { signal: 'SIGTERM' }]) test(`plausible status on failed exit is never success: ${JSON.stringify(error)}`, async () => {
  assert.equal((await cliDeploymentRead(cli(), input('status'), { exec: reply(status, error) })).reason?.code, 'E_CLI_FAILED');
});
for (const [error, code] of [[{ killed: true }, 'E_CLI_TIMEOUT'], [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'E_CLI_OUTPUT_LIMIT']]) test(`transport failure ${code} wins over plausible output`, async () => {
  assert.equal((await cliDeploymentRead(cli(), input('status'), { exec: reply(status, error) })).reason?.code, code);
});
for (const output of ['not json', '{}\n{}', 'null', '[]', JSON.stringify(header)]) test(`status refuses a contaminated or wrong-family document: ${output.slice(0, 25)}`, async () => {
  const result = await cliDeploymentRead(cli(), input('status'), { exec(_b, _a, _o, cb) { cb(null, output); } });
  assert.equal(result.reason.code, 'E_CLI_PROTOCOL');
});
test('workspace status does not accept the raw status family', async () => {
  assert.equal((await cliDeploymentRead(cli(), input('workspace-status'), { exec: reply(status) })).reason.code, 'E_CLI_PROTOCOL');
});
test('independent UTF8 byte fence works when a custom invoker ignores maxBuffer', async () => {
  const result = await cliDeploymentRead(cli(), input('status'), { exec(_b, _a, _o, cb) { cb(null, 'é'.repeat(DEPLOYMENT_READ_MAX_BUFFER / 2 + 1)); } });
  assert.equal(result.reason?.code, 'E_CLI_OUTPUT_LIMIT');
});
test('kernel domain refusal retains bounded code/message, not process diagnostics/details', async () => {
  const message = 'package integrity refused';
  const result = await cliDeploymentRead(cli(), input('workspace-status'), { exec: reply({ schemaVersion: 1, ok: false, error: { code: 'E_PACKAGE_INTEGRITY', message, details: { secret: 'withheld' } } }, { code: 1, message: 'private argv' }) });
  assert.deepEqual(result, { ok: false, reason: { code: 'E_PACKAGE_INTEGRITY', message, origin: 'kernel' } });
});

/* Whose words a reason carries (#855, 3a): the error the installed CLI printed is marked `origin: 'kernel'`; a reason the
   reader made itself carries no origin. Who shows a reason decides by the mark, never by the shape of a code. */
const refusal = (error, exit = { code: 1 }) => reply({ schemaVersion: 1, ok: false, error }, exit);
test('the mark: an envelope\'s error is the kernel\'s, from either read, with or without a failed exit', async () => {
  for (const action of ['status', 'workspace-status']) for (const exit of [{ code: 1 }, null]) {
    const result = await cliDeploymentRead(cli(), input(action), { exec: refusal({ code: 'E_WORKSPACE_SCHEMA', message: 'the workspace file is not valid', details: { path: '/private' } }, exit) });
    assert.deepEqual(result, { ok: false, reason: { code: 'E_WORKSPACE_SCHEMA', message: 'the workspace file is not valid', origin: 'kernel' } }, `${action} ${JSON.stringify(exit)}`);
  }
  // The envelope cannot set the mark, or another one: it is given here, to what was admitted.
  for (const origin of ['desktop', 'client', null, 7]) {
    const result = await cliDeploymentRead(cli(), input('status'), { exec: refusal({ code: 'E_X', message: 'm', origin }) });
    assert.equal(result.reason.origin, 'kernel', String(origin));
  }
  // A code with no `E_` is admitted as before, and marked: the one test of the shape is deployment-contract.mjs `deploymentErrorCode`.
  const bare = await cliDeploymentRead(cli(), input('status'), { exec: refusal({ code: 'BAD_STATE', message: 'the kernel said this' }) });
  assert.deepEqual(bare, { ok: false, reason: { code: 'BAD_STATE', message: 'the kernel said this', origin: 'kernel' } });
  for (const code of ['BAD_STATE', 'E_X', 'E', 'A'.repeat(64)]) assert.equal(deploymentErrorCode(code), true, code);
  for (const code of ['', 'e_x', '_X', '1X', 'E-X', 'E X', 'A'.repeat(65), undefined, null, 7, ['E_X']]) assert.equal(deploymentErrorCode(code), false, String(code));
});
test('the mark is absent from every reason the reader makes itself: the gate, bad arguments, a timeout, the limit, a protocol failure, a failed run', async () => {
  const made = {
    E_CLI_UNAVAILABLE: await cliDeploymentRead({ ...cli(), ok: false }, input('status'), { exec() { assert.fail(); } }),
    E_DEPLOYMENT_FEATURE: await cliDeploymentRead({ ...cli(), features: ['workspace-v2'] }, input('status'), { exec() { assert.fail(); } }),
    E_BAD_ARGS: await cliDeploymentRead(cli(), { action: 'status', context: 'relative' }, { exec() { assert.fail(); } }),
    E_CLI_TIMEOUT: await cliDeploymentRead(cli(), input('status'), { exec: reply(status, { killed: true }) }),
    E_CLI_OUTPUT_LIMIT: await cliDeploymentRead(cli(), input('status'), { exec: reply(status, { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }) }),
    E_CLI_PROTOCOL: await cliDeploymentRead(cli(), input('status'), { exec(_b, _a, _o, cb) { cb(null, 'not json'); } }),
    E_CLI_FAILED: await cliDeploymentRead(cli(), input('status'), { exec: reply(status, { code: 1 }) }),
  };
  for (const [code, result] of Object.entries(made)) {
    assert.equal(result.reason.code, code);
    assert.equal(Object.hasOwn(result.reason, 'origin'), false, code);
    assert.deepEqual(result, deploymentFailure(code, result.reason.feature ?? null), `${code}: the reader's own sentence`);
  }
  // An envelope the reader does not admit is the reader's protocol failure, unmarked: nothing of it is kept.
  for (const error of [{ code: 'e_lower', message: 'm' }, { code: 'E_X' }, { code: 'E_X', message: 'x'.repeat(8193) }, 'text', null, 7, ['E_X', 'm']]) {
    const result = await cliDeploymentRead(cli(), input('status'), { exec: refusal(error) });
    assert.deepEqual(result, deploymentFailure('E_CLI_PROTOCOL'), JSON.stringify(error)?.slice(0, 40));
  }
  // And no code the reader can make for itself, with or without a feature, carries one.
  for (const code of ['E_CLI_UNAVAILABLE', 'E_DEPLOYMENT_FEATURE', 'E_BAD_ARGS', 'E_CLI_FAILED', 'E_CLI_PROTOCOL', 'E_CLI_TIMEOUT', 'E_CLI_OUTPUT_LIMIT', 'E_DEPLOYMENT_SCOPE', 'E_DEPLOYMENT_STALE', 'E_DEPLOYMENT_BUSY', 'E_NOT_A_CODE']) {
    for (const feature of [null, 'served-identity']) assert.equal(Object.hasOwn(deploymentFailure(code, feature).reason, 'origin'), false, code);
  }
});

test('workspace header consumes exact producer members and packages (commit + integrity), no approval state and no inspect scope', () => {
  const result = workspaceStatusData(header, context);
  assert.deepEqual(result.workspace, header.result.workspace);
  assert.deepEqual(result.members, header.result.members);
  assert.deepEqual(result.packages, header.result.packages.map(({ approved: _gone, ...row }) => row));
  assert.ok(result.packages.every(p => p.commit && p.integrity), 'the lock still pins commit and integrity');
  for (const key of ['approval', 'approvalNeeded']) assert.equal(Object.hasOwn(result, key), false, key);
  const { approval: _none, ...withoutApproval } = structuredClone(header.result);
  assert.deepEqual(workspaceStatusData({ ...header, result: withoutApproval }, context).members, result.members, 'the 0.26 shape (no approval object) reads the same');
  assert.equal(Object.hasOwn(result, 'scope'), false);
});
test('native roster retains module drift, recorded soul/workspace and absent identity', () => {
  const result = deploymentStatusData(status, context);
  assert.equal(result.agents.length, status.agents.length);
  const soul = result.agents.find(a => a.name === 'release-manager'), original = status.agents.find(a => a.name === soul.name);
  assert.deepEqual(soul.soulSource, original.soulSource);
  const instance = soul.instances[0], raw = original.instances[0];
  assert.deepEqual(instance.modules, raw.modules); assert.deepEqual(instance.soul, raw.soul);
  assert.deepEqual(instance.workspace, raw.workspace); assert.equal(Object.hasOwn(instance, 'identity'), false);
  assert.equal(instance.running, false); assert.deepEqual(instance.tmux, raw.tmux);
  for (const key of ['command', 'launch', 'capabilityRuntime', 'composition', 'instructions', 'capabilities', 'providers', 'layers']) assert.equal(Object.hasOwn(instance, key), false, key);
  assert.equal(Object.hasOwn(instance, 'task'), false); assert.equal(Object.hasOwn(instance, 'knowledgeCount'), false);
  assert.equal(Object.hasOwn(instance, 'team'), false, 'ambient inspect/config team is not header authority');
  instance.modules[0].name = 'mutated caller copy'; assert.notEqual(raw.modules[0].name, instance.modules[0].name);
});
for (const [name, project, data] of [['status', deploymentStatusData, status], ['workspace-status', workspaceStatusData, header]]) test(`${name} refuses a mismatched deployment`, () => {
  assert.throws(() => project(data, '/another/deployment'), { code: 'E_DEPLOYMENT_SCOPE' });
});
test('a roster root other than <deployment>/agents rejects the whole observation', () => {
  for (const root of ['/outside/agents', join(context, 'other'), context]) {
    assert.throws(() => deploymentStatusData({ ...structuredClone(status), root }, context), { code: 'E_DEPLOYMENT_SCOPE' }, root);
  }
  assert.throws(() => deploymentStatusData(status, '/another/deployment'), { code: 'E_DEPLOYMENT_SCOPE' }, 'observation of another deployment');
});
test('a soul directory outside the deployment rejects the whole observation', () => {
  const raw = structuredClone(status); raw.agents[0].dir = '/outside/soul';
  assert.throws(() => deploymentStatusData(raw, context), { code: 'E_DEPLOYMENT_SCOPE' });
});
for (const [reason, mutate] of [
  ['home-outside-soul', r => { r.agents[0].instances[0].home = '/outside/home'; }],
  ['home-outside-soul', r => { r.agents[0].instances[0].instance = 'renamed'; }],
  ['duplicate-home', r => { r.agents[0].instances.push(structuredClone(r.agents[0].instances[0])); }],
]) test(`an instance row with a ${reason} is withheld and counted, never acted on or silently dropped`, () => {
  const raw = structuredClone(status); mutate(raw);
  const result = deploymentStatusData(raw, context);
  assert.equal(result.withheld.length, 1); assert.equal(result.withheld[0].reason, reason);
  assert.equal(result.withheld[0].agent, 'release-manager');
  const homes = result.agents.flatMap(a => a.instances.map(i => i.home));
  assert.ok(!homes.includes('/outside/home')); assert.equal(new Set(homes).size, homes.length);
});
test('a clean capture withholds nothing', () => assert.deepEqual(deploymentStatusData(status, context).withheld, []));
// The roster contract: an agent row's `key` is the soul key, or null when no instance records a
// workspace soul — an instance-less soul dir (a preview's soul copy, or after its last retire).
// Such a row (shape as the 0.30.0 kernel emits it) must not reject the whole observation.
const instanceLess = (name, key) => ({ schemaVersion: 2, name, description: 'no instances yet', work: 'directory', knowledge: 'none',
  capabilities: {}, kind: 'persistent', dir: join(status.root, name), instances: [], key,
  soulSource: { repoKey: 'github.com/nw/agents', commit: '66566512aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', path: `souls/${name}` } });
test('an instance-less member or package soul (key null) decodes; the rest of the roster is intact', () => {
  const doc = structuredClone(status);
  doc.agents.push(instanceLess('reviewer', null), instanceLess('nw-tools--reviewer', null));
  const result = deploymentStatusData(doc, context), baseline = deploymentStatusData(status, context);
  assert.equal(result.agents.length, status.agents.length + 2);
  for (const name of ['reviewer', 'nw-tools--reviewer']) {
    const row = result.agents.find(a => a.name === name);
    assert.equal(row.key, null, name); assert.deepEqual(row.instances, [], name);
  }
  assert.deepEqual(result.agents.slice(0, status.agents.length), baseline.agents);
  assert.deepEqual(result.withheld, []);
});
test('an agent key is a soul key or null: a string still decodes, any other type rejects the observation', () => {
  const withKey = key => { const doc = structuredClone(status); doc.agents.push(instanceLess('reviewer', key)); return doc; };
  assert.equal(deploymentStatusData(withKey('reviewer'), context).agents.at(-1).key, 'reviewer');
  for (const bad of [0, 42, {}, [], true, '', '*']) assert.throws(() => deploymentStatusData(withKey(bad), context), undefined, JSON.stringify(bad));
});

test('the locator carries only an integer workspaceApi 2 from the probe into the accepted CLI state', async () => {
  const { discover } = await import('../../client/cli-locator.mjs');
  // The capture's kernel printed 0.25.9, below the band's floor; served as 0.26.0 so the locator accepts it.
  const run = async payload => discover({ testedVersion: '0.69.17', persisted: () => '/fixture/bin/oats', env: {}, isExecutableFile: () => true },
    async () => ({ stdout: JSON.stringify({ ...payload, version: '0.26.0' }) }));
  assert.equal((await run(probe)).workspaceApi, 2, 'the captured probe advertises workspaceApi 2');
  for (const value of [1, '2', 3, undefined]) {
    const state = await run({ ...probe, workspaceApi: value });
    assert.equal(state.ok, true); assert.equal(Object.hasOwn(state, 'workspaceApi'), false, String(value));
    assert.equal(deploymentReadGate(state, 'workspace-status').reason.feature, 'workspace-v2');
  }
});

test('every package-root module the bundled server imports (transitively) is in the packaged file list, and what it reaches outside the package is a module of the shared home', () => {
  const pkg = new URL('../', import.meta.url);
  const home = new URL('../client/', pkg);
  const config = readFileSync(new URL('electron-builder.config.cjs', pkg), 'utf8');
  const seen = new Set(), rootModules = new Set(), shared = new Set();
  const visit = url => {
    if (seen.has(url.href)) return; seen.add(url.href);
    const source = readFileSync(url, 'utf8');
    for (const [, spec] of source.matchAll(/^import[^'"]*['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      const next = new URL(spec, url);
      if (next.href.startsWith(home.href)) shared.add(next.href.slice(home.href.length));
      else {
        assert.ok(next.href.startsWith(pkg.href), `${spec} (from ${url.pathname}) is in the package or in the shared home`);
        const rel = next.href.slice(pkg.href.length);
        if (!rel.includes('/')) rootModules.add(rel);
      }
      if (next.pathname.endsWith('.mjs')) visit(next);
    }
  };
  const backend = readFileSync(new URL('server/oats-web.mjs', pkg), 'utf8');
  visit(new URL('server/oats-web.mjs', pkg));
  // What the backend loads by a path, not by an import statement, the walk above cannot reach: the
  // collector's entry module, which it starts, and three modules of the shared home.
  assert.ok(/^const LIVENESS = join\(HERE, "\.\.", "\.\.", "client", "liveness-main\.mjs"\);$/m.test(backend), 'the backend starts ../client/liveness-main.mjs');
  for (const file of ['liveness-main.mjs', 'cli-locator.mjs', 'cli-adapter.mjs', 'remote-roster.mjs']) {
    assert.ok(backend.includes(`join(HERE, "..", "..", "client", "${file}")`), `the backend names ../client/${file} by a path`);
    shared.add(file);
    visit(new URL(file, home));
  }
  assert.ok(rootModules.has('forge-cli.mjs') && rootModules.has('readiness-cli.mjs') && rootModules.has('instance-events-cli.mjs'));
  for (const file of rootModules) assert.ok(config.includes(`"${file}"`), `${file} is packaged`);
  // The shared home ships whole, flat, beside the asar (test/inventory.test.mjs pins where and how): what
  // the server reaches there, the modules that were package-root ones among it, is a module directly in it.
  assert.ok(shared.has('deployment-read-cli.mjs') && shared.has('deployment-data.mjs') && shared.has('cli-environment.mjs'));
  for (const file of shared) assert.ok(!file.includes('/') && file.endsWith('.mjs'), `${file} is a module directly in the shared home`);
  assert.deepEqual(builder.extraResources, [{ from: '../client', to: 'client', filter: ['**/*.mjs'] }]);
  // The collector's entry and the module that cleans a Node-mode process's environment are there, and are loaded.
  for (const file of ['liveness-main.mjs', 'own-environment.mjs']) assert.ok(seen.has(new URL(file, home).href), `../client/${file} exists and is loaded`);
  // server/ ships by its pattern, and no exclusion names a file of it.
  assert.ok(builder.files.includes('server/**/*'));
  assert.deepEqual(builder.files.filter(pattern => pattern.startsWith('!') && pattern.includes('server/')), []);
});

/* Spec D: an unreadable remote's bounded cause crosses (reason, and the host of details.url); nothing else. */
const CACHE_DETAILS = { url: 'https://github.com/awebai/oats.git', key: 'github.com/awebai/oats', reason: 'cache', stage: 'fetch',
  cacheDir: '/Users/op/.cache/oats/remotes', lock: '/Users/op/.cache/oats/remotes/x/index.lock', holderPid: 4242, guard: '/Users/op/.cache/oats/remotes/x/.reclaim' };
test('Spec D: E_REMOTE_UNREADABLE keeps its message and only a bounded cause { reason, host } of its details', async () => {
  const message = 'the remote cache is locked by /Users/op/.cache/oats/remotes/x/index.lock; remove it and retry';
  const result = await cliDeploymentRead(cli(), input('workspace-status'), { exec: reply({ schemaVersion: 1, ok: false, error: { code: 'E_REMOTE_UNREADABLE', message, details: CACHE_DETAILS } }, { code: 1 }) });
  assert.deepEqual(result, { ok: false, reason: { code: 'E_REMOTE_UNREADABLE', message, origin: 'kernel', cause: { reason: 'cache', host: 'github.com' } } });
  assert.doesNotMatch(JSON.stringify(result.reason.cause), /Users|4242|lock|reclaim|stage|key/, 'no path, pid or other field crosses');
  const plain = await cliDeploymentRead(cli(), input('status'), { exec: reply({ schemaVersion: 1, ok: false, error: { code: 'E_REMOTE_UNREADABLE', message } }, { code: 1 }) });
  assert.deepEqual(plain, { ok: false, reason: { code: 'E_REMOTE_UNREADABLE', message, origin: 'kernel' } }, 'no details: no cause');
  const other = await cliDeploymentRead(cli(), input('status'), { exec: reply({ schemaVersion: 1, ok: false, error: { code: 'E_WORKSPACE_SCHEMA', message, details: CACHE_DETAILS } }, { code: 1 }) });
  assert.deepEqual(other, { ok: false, reason: { code: 'E_WORKSPACE_SCHEMA', message, origin: 'kernel' } }, 'only an unreadable remote carries a cause');
});

test('Spec D: remoteFailureCause bounds the reason and derives only a host', () => {
  assert.deepEqual(remoteFailureCause({ reason: 'network', url: 'git@github.com:awebai/oats.git' }), { reason: 'network', host: 'github.com' });
  assert.deepEqual(remoteFailureCause({ reason: 'timeout', url: 'https://user:secret@Git.Example.com:8443/x.git' }), { reason: 'timeout', host: 'git.example.com' }, 'never credentials or a port');
  assert.deepEqual(remoteFailureCause({ reason: 'cache', url: '/local/path/repo' }), { reason: 'cache' }, 'a path has no host');
  assert.deepEqual(remoteFailureCause({ reason: 'cache' }), { reason: 'cache' });
  for (const details of [null, [], {}, { reason: 'Cache' }, { reason: 'x'.repeat(33) }, { reason: 'cache; rm -rf' }, { reason: 7 }]) assert.equal(remoteFailureCause(details), null, JSON.stringify(details));
});

test('Spec D: panelErrorCause re-validates the panel field with its keys exact', () => {
  assert.deepEqual(panelErrorCause({ code: 'E_REMOTE_UNREADABLE', reason: 'cache' }), { code: 'E_REMOTE_UNREADABLE', reason: 'cache' });
  assert.deepEqual(panelErrorCause({ code: 'E_REMOTE_UNREADABLE', reason: 'network', host: 'github.com' }), { code: 'E_REMOTE_UNREADABLE', reason: 'network', host: 'github.com' });
  for (const v of [null, {}, { code: 'E_X', reason: 'cache', lock: '/x' }, { code: 'x', reason: 'cache' }, { code: 'E_X', reason: 'CACHE' }, { code: 'E_X', reason: 'network', host: 'a b' }]) assert.equal(panelErrorCause(v), null, JSON.stringify(v));
});

// Workspace identity (feature workspace-identity, #482): the status `workspace` object's identity is kept
// for matching this deployment to its workspace across machines; it never costs the roster.
const IDENTITY = { key: 'github.com/nw/agents', ref: 'git:github.com/nw/agents', keyFrom: 'workspace', standalone: false,
  defaultTeam: { label: 'default', team: 'nw:agents' }, teams: { default: 'nw:agents', ops: null }, teamsFrom: 'observed' };
const withWorkspace = workspace => ({ ...structuredClone(status), workspace });
test('workspace identity: every identity field is kept verbatim beside reachable/code/reason/message', () => {
  const raw = { reachable: false, code: 'E_REMOTE_UNREADABLE', reason: 'network', message: 'host unreachable', ...structuredClone(IDENTITY) };
  const result = deploymentStatusData(withWorkspace(raw), context);
  assert.deepEqual(result.workspace, { code: 'E_REMOTE_UNREADABLE', reason: 'network', message: 'host unreachable', reachable: false, ...IDENTITY });
  assert.equal(Object.hasOwn(result.workspace, 'identityInvalid'), false);
  result.workspace.teams.default = 'mutated'; result.workspace.defaultTeam.team = 'mutated';
  assert.deepEqual([raw.teams.default, raw.defaultTeam.team], ['nw:agents', 'nw:agents'], 'a copy, never the caller\'s object');
  // The unusable-reference and unmapped shapes the contract allows are identities too.
  const nullKey = { reachable: true, key: null, ref: 'not a ref', keyFrom: null, standalone: false, defaultTeam: null, teams: {}, teamsFrom: 'local' };
  assert.deepEqual(deploymentStatusData(withWorkspace(nullKey), context).workspace, nullKey);
  const unmapped = { reachable: true, ...IDENTITY, standalone: true, teamsFrom: 'local', defaultTeam: { label: 'default', team: null }, teams: { default: null } };
  assert.deepEqual(deploymentStatusData(withWorkspace(unmapped), context).workspace, unmapped);
});
test('workspace identity: a shape the contract does not allow is marked identityInvalid and never fails the roster', () => {
  const baseline = deploymentStatusData(status, context);
  for (const bad of [{ keyFrom: 'bogus' }, { teamsFrom: undefined }, { teamsFrom: 'remote' }, { standalone: 'no' }, { key: 42 }, { key: '' },
    { ref: 7 }, { defaultTeam: { team: 'x' } }, { defaultTeam: 'default' }, { teams: [] }, { teams: { default: 3 } }]) {
    const raw = { reachable: true, ...structuredClone(IDENTITY), ...bad };
    if (Object.hasOwn(bad, 'teamsFrom') && bad.teamsFrom === undefined) delete raw.teamsFrom;
    let result;
    assert.doesNotThrow(() => { result = deploymentStatusData(withWorkspace(raw), context); }, JSON.stringify(bad));
    assert.deepEqual(result.workspace, { reachable: true, identityInvalid: true }, JSON.stringify(bad));
    assert.deepEqual(result.agents, baseline.agents, 'the roster rows still come back');
  }
});
test('workspace identity: a host before 0.36.0 (no key field) keeps only reachable/code/reason/message', () => {
  const old = { reachable: false, code: 'E_X', reason: 'r', message: 'm', ref: 'git:github.com/nw/agents', teamsFrom: 'observed', standalone: false };
  const result = deploymentStatusData(withWorkspace(old), context);
  assert.deepEqual(result.workspace, { code: 'E_X', reason: 'r', message: 'm', reachable: false });
  assert.deepEqual(deploymentStatusData(status, context).workspace, { reachable: true }, 'the real 0.35 capture: reachability only');
});
