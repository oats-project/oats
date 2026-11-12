// A spawn on another machine named from its task (awebai/oats#1490 §2 and §3): this computer's CLI names it
// (`oats instance suggest-name`, feature instance-suggest-name), else the host names it on the apply
// (`--suggest-name`, feature spawn-apply-suggest-name, read from its roster row), else the host numbers it.
// The contract, the CLI reader, the boundary, the main proxy, the apply's argv and the dialog. The kernel and the
// host are fixtures shaped like PR B's answers; no harness is ever called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { cliInstanceSuggestName } from '../../client/spawn-preview-cli.mjs';
import { createInstanceSuggestBoundary } from '../../client/spawn-preview.mjs';
import { instanceSuggestion, instanceSuggestRequest, instanceSuggestSupported, NAMING_TIMEOUT_MS } from '../../client/spawn-preview-contract.mjs';
import { namingKey } from '../../client/spawn-naming.mjs';
import { spawnArgv, cliSpawn } from '../../client/cli-adapter.mjs';
import { proxySpawnPreview } from '../spawn-preview-proxy.mjs';
import { proxySpawnApply } from '../spawn-apply-proxy.mjs';
import { cli as CLI, deferred, DEPLOYMENT } from './helpers/spawn-preview-fixture.mjs';
import { mountSpawn, settle } from './helpers/spawn-dialog-host.mjs';

const NAMING_CLI = { ...structuredClone(CLI), features: [...CLI.features, 'server-probe-features', 'instance-suggest-name', 'spawn-apply-suggest-name'] };
const without = (...gone) => ({ ...NAMING_CLI, features: NAMING_CLI.features.filter(f => !gone.includes(f)) });
const TASK = 'Write the release notes for the next OATS release please';
const suggested = (name = 'release-notes-manager', harness = 'claude') => ({ schemaVersion: 1, ok: true, result: { name, naming: { source: 'suggested', ms: 900, harness, model: 'haiku' } } });
const numbered = reason => ({ schemaVersion: 1, ok: true, result: { naming: { source: 'numbered', reason, message: 'claude exited 1', ms: 4 } } });
const request = (extra = {}) => ({ action: 'suggest-name', soul: 'release-manager', task: TASK, ...extra });

// ── the contract
test('instanceSuggestion: a name exactly when suggested, a kernel slug within 64; naming as a preview\'s', () => {
  assert.deepEqual(instanceSuggestion(suggested().result), { name: 'release-notes-manager', naming: { source: 'suggested', ms: 900, harness: 'claude', model: 'haiku' } });
  assert.deepEqual(instanceSuggestion(numbered('timeout').result), { naming: { source: 'numbered', reason: 'timeout', ms: 4 } }, 'the kernel\'s message never travels');
  for (const bad of [null, {}, { naming: { source: 'suggested', ms: 1, harness: 'claude', model: null } }, { ...suggested().result, name: 'Bad-Name' },
    { ...suggested().result, name: 'a--b' }, { ...suggested().result, name: 'x'.repeat(65) }, { ...numbered('timeout').result, name: 'x' },
    { ...suggested().result, extra: 1 }, numbered('nope').result, { ...suggested().result, name: 123 }, { ...suggested().result, name: ['release-notes-manager'] }])
    assert.equal(instanceSuggestion(bad), null, JSON.stringify(bad));
});

test('instanceSuggestRequest: the soul as a name only, the task as at apply, codex allowed, a model only with pi', () => {
  assert.deepEqual(instanceSuggestRequest(request()), request());
  assert.deepEqual(instanceSuggestRequest(request({ soul: 'acme/release-manager', harness: 'codex' })), request({ soul: 'acme/release-manager', harness: 'codex' }));
  assert.deepEqual(instanceSuggestRequest(request({ harness: 'pi', model: 'anthropic/claude-haiku' })), request({ harness: 'pi', model: 'anthropic/claude-haiku' }));
  for (const bad of [request({ action: 'suggest' }), request({ soul: '-x' }), request({ soul: 'a/b/c' }), request({ task: '  ' }), request({ harness: 'gemini' }),
    request({ model: 'haiku' }), request({ harness: 'claude', model: 'haiku' }), request({ harness: 'pi', model: '--json' }), request({ dir: '/elsewhere' }), request({ server: 'build' })])
    assert.equal(instanceSuggestRequest(bad), null, JSON.stringify(bad));
});

test('the gates: instance-suggest-name with spawn-name on this CLI; a namingKey per machine', () => {
  assert.equal(instanceSuggestSupported(NAMING_CLI), true);
  assert.equal(instanceSuggestSupported(without('instance-suggest-name')), false);
  assert.equal(instanceSuggestSupported(without('spawn-name')), false);
  const selector = { soul: 'release-manager', agentsRoot: '/w/agents' };
  assert.notEqual(namingKey(selector, TASK, 'build'), namingKey(selector, TASK, 'devbox'));
  assert.notEqual(namingKey(selector, TASK, 'build'), namingKey(selector, TASK));
  assert.equal(namingKey(selector, TASK), namingKey(selector, TASK, null));
});

// ── the CLI reader
test('cliInstanceSuggestName: fixed argv, the task in a private file removed afterwards, the answer re-validated', async () => {
  let seen;
  const exec = (bin, argv, opts, done) => { seen = { bin, argv, opts, task: readFileSync(argv[argv.indexOf('--task-file') + 1], 'utf8') }; done(null, JSON.stringify(suggested())); };
  const answer = await cliInstanceSuggestName(NAMING_CLI, { request: request({ harness: 'pi', model: 'anthropic/claude-haiku' }), dir: DEPLOYMENT }, { exec });
  assert.deepEqual(answer, { schemaVersion: 1, ok: true, result: instanceSuggestion(suggested().result) });
  const file = seen.argv[seen.argv.indexOf('--task-file') + 1];
  assert.deepEqual(seen.argv, ['instance', 'suggest-name', '--soul', 'release-manager', '--task-file', file, '--harness', 'pi', '--model', 'anthropic/claude-haiku', '--dir', DEPLOYMENT, '--json']);
  assert.equal(seen.task, TASK); assert.equal(existsSync(file), false, 'removed');
  assert.equal(seen.opts.shell, false); assert.equal(seen.opts.cwd, DEPLOYMENT); assert.equal(seen.opts.timeout, 30000);
  assert.ok(!seen.argv.includes('--launch-config') && !seen.argv.includes('--server'));
  await cliInstanceSuggestName(NAMING_CLI, { request: request(), dir: DEPLOYMENT }, { exec });
  assert.deepEqual(seen.argv.slice(0, 4), ['instance', 'suggest-name', '--soul', 'release-manager']); assert.ok(!seen.argv.includes('--harness'), 'no harness: the kernel\'s default');
});

test('cliInstanceSuggestName: refusals and failures in the kernel\'s shape; never run without the feature or with a bad request', async () => {
  const never = () => assert.fail('never runs');
  assert.equal((await cliInstanceSuggestName(without('instance-suggest-name'), { request: request(), dir: DEPLOYMENT }, { exec: never })).error.code, 'E_UNSUPPORTED_OPTION');
  assert.equal((await cliInstanceSuggestName(NAMING_CLI, { request: request({ harness: 'gemini' }), dir: DEPLOYMENT }, { exec: never })).error.code, 'E_BAD_ARGS');
  assert.equal((await cliInstanceSuggestName(NAMING_CLI, { request: request(), dir: 'relative' }, { exec: never })).error.code, 'E_BAD_ARGS');
  const answer = out => cliInstanceSuggestName(NAMING_CLI, { request: request(), dir: DEPLOYMENT }, { exec: (b, a, o, done) => out(done) });
  assert.equal((await answer(done => done(null, JSON.stringify({ schemaVersion: 1, ok: true, result: { name: 'Bad' } })))).error.code, 'E_CLI_PROTOCOL');
  assert.equal((await answer(done => done(Object.assign(new Error('t'), { killed: true }), ''))).error.code, 'E_CLI_TIMEOUT');
  const refused = await answer(done => done(Object.assign(new Error('x'), { code: 1 }), JSON.stringify({ schemaVersion: 1, ok: false, error: { code: 'E_BAD_ARGS', message: 'instance suggest-name takes no --server' } })));
  assert.equal(refused.error.code, 'E_BAD_ARGS');
  assert.equal((await answer(done => done(null, JSON.stringify(numbered('harness-failed'))))).result.naming.reason, 'harness-failed', 'a numbered answer is ok');
});

// ── the boundary
test('the suggest-name boundary: a local deployment only, one read per deployment (the newer ends the older), the answer re-validated', async () => {
  const held = [];
  const boundary = createInstanceSuggestBoundary({ invoke: (_cli, args) => { const d = deferred(); held.push({ args, d }); return d.promise; } });
  const local = () => ({ workspace: { id: 'northwind', scope: DEPLOYMENT }, cli: NAMING_CLI });
  const first = boundary(request(), local), second = boundary(request({ task: `${TASK} now` }), local);
  await settle();
  assert.equal(held.length, 2); assert.equal(held[0].args.signal.aborted, true, 'the older is ended'); assert.equal(held[1].args.dir, DEPLOYMENT);
  held[0].d.resolve(suggested()); held[1].d.resolve(suggested('release-notes-now-manager'));
  assert.equal((await first).reason.code, 'E_SUPERSEDED');
  assert.deepEqual(await second, { spawnPreviewViewApi: 1, status: 'available', workspace: 'northwind', data: { name: 'release-notes-now-manager', naming: suggested().result.naming }, reason: null });
  assert.equal((await boundary(request(), () => ({ workspace: { id: 'remote:build:k', scope: DEPLOYMENT, remote: true }, cli: NAMING_CLI }))).reason.code, 'unsupported-remote-operation');
  assert.equal((await boundary(request(), () => ({ workspace: null, cli: NAMING_CLI }))).reason.code, 'E_WORKSPACE_UNKNOWN');
  assert.equal((await boundary(request(), () => ({ ...local(), cli: without('instance-suggest-name') }))).reason.code, 'E_UNSUPPORTED_OPTION');
  assert.equal((await boundary({ ...request(), selector: {} }, local)).reason.code, 'E_BAD_ARGS');
  const malformed = createInstanceSuggestBoundary({ invoke: async () => ({ schemaVersion: 1, ok: true, result: { name: 'x' } }) });
  assert.equal((await malformed(request(), local)).reason.code, 'E_CLI_PROTOCOL');
});

test('the main proxy passes a suggest-name answer for the deployment it asked, with the task\'s 64 KiB', async () => {
  const renderer = 'file:///fixture/index.html', frame = { url: renderer }, event = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false } };
  const connection = { base: 'http://localhost:4820', wsId: 'northwind', allowedWs: new Set(['northwind']), epoch: 0, transition: false };
  let reply = { spawnPreviewViewApi: 1, status: 'available', workspace: 'northwind', data: suggested().result, reason: null };
  const deps = { rendererURL: renderer, connection: () => connection, fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(reply) }) };
  const ask = body => proxySpawnPreview(event, '/api/workspace-spawn-preview?ws=northwind', { method: 'POST', body: JSON.stringify(body) }, deps);
  const ok = await ask(request({ task: 'x'.repeat(30000) }));
  assert.deepEqual(ok.body, { spawnPreviewViewApi: 1, status: 'available', workspace: 'northwind', data: instanceSuggestion(suggested().result), reason: null });
  reply = { ...reply, workspace: 'elsewhere' }; assert.equal((await ask(request())).body.reason.code, 'E_CLI_PROTOCOL');
  reply = { ...reply, workspace: 'northwind', data: { name: 'Bad' } }; assert.equal((await ask(request())).body.reason.code, 'E_CLI_PROTOCOL');
  const server = readFileSync(new URL('../server/oats-web.mjs', import.meta.url), 'utf8');
  assert.match(server, /if \(request\.action === 'suggest-name'\) return send\(res, 200, await spawnPreview\.suggestName\(request, getContext\)\);/);
});

// ── the apply
test('spawnArgv: --suggest-name on an apply, never beside a name or a purpose; the deadline allows for the naming call', async () => {
  assert.deepEqual(spawnArgv('dev', '/ws', '/t', { server: 'build', suggestName: true }), ['spawn', 'dev', '--task-file', '/t', '--server', 'build', '--suggest-name', '--json']);
  assert.ok(!spawnArgv('dev', '/ws', '/t', { server: 'build', suggestName: false }).includes('--suggest-name'));
  for (const opts of [{ suggestName: true, name: 'x-dev' }, { suggestName: true, purpose: 'x' }, { suggestName: 'yes' }])
    assert.throws(() => spawnArgv('dev', '/ws', '/t', opts), e => e.code === 'E_BAD_ARGS', JSON.stringify(opts));
  const timeouts = [];
  const exec = (bin, argv, opts, done) => { timeouts.push(opts.timeout); done(null, JSON.stringify({ schemaVersion: 1, ok: true, result: { instance: 'x', agent: 'dev', home: '/h' } })); };
  await cliSpawn('/oats', { agent: 'dev', workspaceDir: '/ws', task: 'go', server: 'build', suggestName: true }, { exec });
  await cliSpawn('/oats', { agent: 'dev', workspaceDir: '/ws', task: 'go', server: 'build' }, { exec });
  assert.equal(NAMING_TIMEOUT_MS, 20000);
  assert.deepEqual(timeouts, [60000 + NAMING_TIMEOUT_MS, 60000]);
});

// ── the dialog
const HOST = { id: 'build', label: 'Build host', sshHost: 'build.lan' };
const hostFacts = features => ({ members: [], notReached: [], servers: [{ server: 'build', label: 'Build host', group: 'build:k1', deployment: 'remote:build:k1', reached: true, error: null, registered: true, features }] });
async function onBuild(t, options) {
  const remote = [];
  const u = await mountSpawn(t, { spawnName: true, servers: [HOST], remote: body => { remote.push(body); return { instance: body.name ?? 'release-manager-4', server: 'build', ...(options.answer?.(body) ?? {}) }; }, ...options });
  await u.open(); u.q('.spawn-advanced').open = true; await u.change('.fserver', 'build');
  return { u, remote };
}

test('a spawn on a server is named here from its task as a local one is: asked after seven words, shown, and sent as its name', async t => {
  const { u, remote } = await onBuild(t, { cli: NAMING_CLI, teamMembers: hostFacts(['spawn-name']), nameHere: () => suggested() });
  assert.equal(u.text('.spawn-name-result'), 'Left empty, the instance is named from its task.');
  await u.type('.ftask', 'Write the release notes'); await settle(20);
  assert.equal(u.names.length, 0, 'fewer than seven words: not asked');
  await u.type('.ftask', TASK); await settle(20);
  assert.deepEqual(u.names, [{ action: 'suggest-name', soul: 'release-manager', task: TASK, dir: DEPLOYMENT }], 'no harness chosen or known: the kernel\'s default');
  assert.equal(u.q('.fpurpose').placeholder, 'release-notes-manager');
  assert.equal(u.text('.spawn-name-result'), 'Instance name: release-notes-manager (from the task)');
  await u.spawn();
  assert.equal(remote.length, 1); assert.equal(remote[0].name, 'release-notes-manager');
  assert.equal(Object.hasOwn(remote[0], 'suggestName') || Object.hasOwn(remote[0], 'purpose'), false);
  assert.equal(u.names.length, 1, 'Spawn used the answer it had');
});

test('the harness that names it: the dialog\'s choice, else the soul\'s default where it runs; a model only with pi', async t => {
  const agents = [{ name: 'builder', description: 'Builds', kind: 'persistent', work: 'worktree', agentsRoot: '/srv/team/agents', server: 'build', repoName: 'team', harness: 'pi' }];
  const remote = [];
  const u = await mountSpawn(t, { agents, spawnName: true, cli: NAMING_CLI, teamMembers: hostFacts(['spawn-name']), nameHere: () => suggested('release-notes-builder', 'pi'),
    remote: body => { remote.push(body); return { instance: body.name, server: 'build' }; } });
  await u.open('builder'); await settle(20);
  await u.type('.ftask', TASK); await settle(20);
  assert.deepEqual(u.names.at(-1), { action: 'suggest-name', soul: 'builder', task: TASK, harness: 'pi', dir: DEPLOYMENT }, 'the host\'s default harness for the soul');
  u.q('.spawn-advanced').open = true; await u.type('.fmodel', 'anthropic/claude-haiku');
  await u.type('.ftask', `${TASK} today`); await settle(20);
  assert.deepEqual(u.names.at(-1), { action: 'suggest-name', soul: 'builder', task: `${TASK} today`, harness: 'pi', model: 'anthropic/claude-haiku', dir: DEPLOYMENT });
  await u.spawn(); assert.equal(remote[0].name, 'release-notes-builder');
});

test('Spawn with no suggestion in hand names it first ("Naming…"); unnamed here, the host names it where it can, else numbers it and the spawn says why', async t => {
  // Named here at the press.
  let gate = deferred();
  let { u, remote } = await onBuild(t, { cli: NAMING_CLI, teamMembers: hostFacts(['spawn-name', 'spawn-apply-suggest-name']), nameHere: () => gate.promise });
  await u.type('.ftask', 'Fix the login'); const pressed = u.spawn();
  assert.equal(u.text('.fstatus'), 'Naming…'); gate.resolve(suggested('fix-login-manager')); await pressed; await settle(20);
  assert.equal(remote[0].name, 'fix-login-manager');
  // Numbered here: the host advertises spawn-apply-suggest-name, so it names it there.
  ({ u, remote } = await onBuild(t, { cli: NAMING_CLI, teamMembers: hostFacts(['spawn-name', 'spawn-apply-suggest-name']), nameHere: () => numbered('timeout'),
    answer: () => ({ naming: { source: 'suggested', ms: 800, harness: 'claude', model: 'haiku' } }) }));
  await u.type('.ftask', 'Fix the login'); await u.spawn(); await settle(20);
  assert.equal(remote[0].suggestName, true); assert.equal(Object.hasOwn(remote[0], 'name'), false);
  assert.deepEqual(u.toasts.filter(m => /^Named /.test(m)), [], 'named on the host: nothing to explain');
  // Numbered here, and the host doesn't name: neither is sent, the host numbers it, and the spawn says why.
  ({ u, remote } = await onBuild(t, { cli: NAMING_CLI, teamMembers: hostFacts(['spawn-name']), nameHere: () => numbered('timeout') }));
  await u.type('.ftask', 'Fix the login'); await u.spawn(); await settle(20);
  assert.equal(Object.hasOwn(remote[0], 'suggestName') || Object.hasOwn(remote[0], 'name') || Object.hasOwn(remote[0], 'numbered'), false, 'the server is sent neither');
  assert.ok(u.toasts.includes('Named release-manager-4: naming took longer than 20 seconds.'), JSON.stringify(u.toasts));
});

test('the host numbers what it was asked to name: the spawn says why, from its re-validated naming', async t => {
  const { u } = await onBuild(t, { cli: without('instance-suggest-name'), teamMembers: hostFacts(['spawn-name', 'spawn-apply-suggest-name']),
    answer: () => ({ naming: { source: 'numbered', reason: 'harness-failed', message: 'PRIVATE', ms: 3 } }) });
  assert.equal(u.text('.spawn-name-result'), 'Left empty, the instance is named from its task on build.');
  await u.type('.ftask', TASK); await settle(20);
  assert.equal(u.names.length, 0, 'this CLI can\'t name it: nothing asked here');
  await u.spawn(); await settle(20);
  assert.ok(u.toasts.includes('Named release-manager-4: the harness couldn\'t be asked for a name.'), JSON.stringify(u.toasts));
  assert.ok(!u.toasts.some(m => m.includes('PRIVATE')));
});

test('naming never blocks a spawn on another machine: a failed read here falls back to the host', async t => {
  const { u, remote } = await onBuild(t, { cli: NAMING_CLI, teamMembers: hostFacts(['spawn-name', 'spawn-apply-suggest-name']),
    nameHere: () => ({ schemaVersion: 1, ok: false, error: { code: 'E_LAUNCH_CONFIG_UNKNOWN', message: 'no such configuration' } }) });
  await u.type('.ftask', 'Fix the login'); await u.spawn(); await settle(20);
  assert.equal(remote.length, 1, 'spawned'); assert.equal(remote[0].suggestName, true);
});

test('the help line says who names an empty name before the press; a typed or touched name is never named from the task', async t => {
  for (const [why, cli, features, line] of [
    ['named here', NAMING_CLI, ['spawn-name', 'spawn-apply-suggest-name'], 'Left empty, the instance is named from its task.'],
    ['named on the host', without('instance-suggest-name'), ['spawn-name', 'spawn-apply-suggest-name'], 'Left empty, the instance is named from its task on build.'],
    ['this CLI can\'t ask the host', without('instance-suggest-name', 'spawn-apply-suggest-name'), ['spawn-name', 'spawn-apply-suggest-name'], 'Named by build when it spawns.'],
    ['the host can\'t', without('instance-suggest-name'), ['spawn-name'], 'Named by build when it spawns.'],
  ]) {
    const { u, remote } = await onBuild(t, { cli, teamMembers: hostFacts(features) });
    assert.equal(u.text('.spawn-name-result'), line, why);
    await u.type('.fpurpose', 'x'); await u.type('.fpurpose', ''); await u.type('.ftask', 'Fix the login'); await u.spawn(); await settle(20);
    assert.equal(Object.hasOwn(remote[0], 'suggestName') || Object.hasOwn(remote[0], 'name'), false, `${why}: a touched name is numbered`);
  }
});

test('an answer names a spawn on its own machine only: another server asks again', async t => {
  const servers = [HOST, { id: 'devbox', label: 'devbox', sshHost: 'devbox.lan' }];
  const facts = { members: [], notReached: [], servers: [hostFacts(['spawn-name']).servers[0],
    { server: 'devbox', label: 'devbox', group: 'devbox:k2', deployment: 'remote:devbox:k2', reached: true, error: null, registered: true, features: ['spawn-name'] }] };
  const { u } = await onBuild(t, { cli: NAMING_CLI, servers, teamMembers: facts, nameHere: () => suggested() });
  await u.type('.ftask', TASK); await settle(20);
  assert.equal(u.names.length, 1);
  await u.change('.fserver', 'devbox'); await settle(20);
  assert.equal(u.names.length, 2, 'asked again for devbox');
  await u.change('.fserver', 'build'); await settle(20);
  assert.equal(u.names.length, 2, 'build\'s answer is kept');
});

test('the Electron proxy waits for a remote spawn the host names longer than the CLI may run, as it does for one it doesn\'t', async t => {
  // The CLI's deadline (cliSpawn) and the proxy's, read where they are set, with no real wait.
  const cliMs = async suggestName => {
    let ms; await cliSpawn('/oats', { agent: 'dev', workspaceDir: '/ws', task: 'go', server: 'build', ...(suggestName ? { suggestName } : {}) },
      { exec: (b, a, opts, done) => { ms = opts.timeout; done(null, JSON.stringify({ schemaVersion: 1, ok: true, result: { instance: 'x', agent: 'dev', home: '/h' } })); } });
    return ms;
  };
  const renderer = 'file:///fixture/index.html', frame = { url: renderer }, event = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false } };
  const connection = { base: 'http://localhost:4820', wsId: 'northwind', allowedWs: new Set(['northwind']), epoch: 0, transition: false };
  const timeouts = [], real = AbortSignal.timeout;
  AbortSignal.timeout = ms => { timeouts.push(ms); return real.call(AbortSignal, ms); };
  t.after(() => { AbortSignal.timeout = real; });
  const deps = { rendererURL: renderer, connection: () => connection, fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ spawned: true, instance: 'x', home: '/h' }) }) };
  const proxyMs = async suggestName => {
    await proxySpawnApply(event, '/api/spawn', { method: 'POST', body: JSON.stringify({ agent: 'dev', agentsRoot: '/srv/agents', serverId: 'build', task: 'go', ...(suggestName ? { suggestName } : {}) }) }, deps);
    return timeouts.at(-1);
  };
  for (const named of [false, true]) {
    const [c, p] = [await cliMs(named), await proxyMs(named)];
    assert.ok(p - c >= 5000, `suggestName ${named}: the proxy (${p} ms) outlasts the CLI (${c} ms) by its margin`);
  }
  assert.equal(await proxyMs(true) - await proxyMs(false), NAMING_TIMEOUT_MS);
});

test('the Deployment field: the harness that names it is the chosen deployment\'s default for the soul, not the first one\'s', async t => {
  const local = { id: DEPLOYMENT, machine: 'This Mac', path: DEPLOYMENT, label: 'northwind', local: true, reachable: true, identityFrom: 'reported', primary: true };
  const remoteDeployment = (server, key) => ({ id: `remote:${server}:${key}`, machine: server, path: `/srv/${server}`, label: server, local: false, reachable: true, identityFrom: 'reported', primary: false });
  const BUILD = remoteDeployment('build', 'k1'), DEVBOX = remoteDeployment('devbox', 'k2');
  const row = (server, harness) => ({ name: 'builder', description: '', kind: 'persistent', work: 'worktree', agentsRoot: `/srv/${server}/agents`, server, remote: true, repoName: server, harness });
  const fact = (server, key) => ({ server, label: server, group: `${server}:${key}`, deployment: `remote:${server}:${key}`, reached: true, error: null, registered: true, features: ['spawn-name'] });
  const u = await mountSpawn(t, { spawnName: true, cli: NAMING_CLI, deployments: [local, BUILD, DEVBOX], agents: [row('build', 'codex')],
    catalogs: { [DEPLOYMENT]: [], [BUILD.id]: [row('build', 'codex')], [DEVBOX.id]: [row('devbox', 'pi')] },
    teamMembers: { members: [], notReached: [], servers: [fact('build', 'k1'), fact('devbox', 'k2')] }, nameHere: r => suggested('release-notes-builder', r.harness) });
  await u.open('builder'); await settle(20);
  [...u.q('.fdeployment').querySelectorAll('input')].find(i => i.value === DEVBOX.id).click(); await settle(20);
  await u.type('.ftask', TASK); await settle(20);
  assert.equal(u.names.at(-1).harness, 'pi', 'devbox\'s default for builder');
  [...u.q('.fdeployment').querySelectorAll('input')].find(i => i.value === BUILD.id).click(); await settle(20);
  assert.equal(u.names.at(-1).harness, 'codex', 'asked again for build, with build\'s');
  assert.ok(u.names.every(n => n.dir === DEPLOYMENT), 'always through this computer\'s deployment');
});
