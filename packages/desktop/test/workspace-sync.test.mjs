import { controlHeaders } from './helpers/control-auth.mjs';
// Workspace model v2 verbs (F2, without package approval): fixed argv, exit
// semantics, refusal projection, projectors and the server's sync boundary —
// against kernel-captured fixtures (test/fixtures/workspace-v2/f2,
// provenance.json), captured from main's kernel (packages-no-approval).
// No CLI, network, GUI or native process is launched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { cliWorkspace, workspaceArgv, validWorkspaceRef, WORKSPACE_READ_TIMEOUT, WORKSPACE_WRITE_TIMEOUT, WORKSPACE_MAX_BUFFER, WORKSPACE_ACTIONS } from '../../client/workspace-cli.mjs';
import { syncData, capabilitiesData, onboardData } from '../../client/deployment-data.mjs';
import { createWorkspaceSyncBoundary } from '../server/workspace-sync.mjs';
import { deploymentDoubles } from './helpers/deployment-doubles.mjs';
import { DESKTOP_TERMS } from '../renderer/desktop-terms.mjs';

const file = name => new URL(`./fixtures/workspace-v2/f2/${name}.json`, import.meta.url);
const raw = name => JSON.parse(readFileSync(file(name), 'utf8'));
const fixture = name => raw(name);
const provenance = raw('provenance');
const deployment = '/fixture/base/northwind-workspace';
const cli = () => ({ ...raw('version'), ok: true, bin: '/fixture/bin/oats' });
const exitError = code => Object.assign(new Error(`exit ${code}`), { code });
/** Replays a captured document with the exit the kernel produced (spec: never 2). */
const replay = name => (_bin, _argv, _options, done) => {
  const exit = provenance.files[name].exit;
  done(exit ? exitError(exit) : null, JSON.stringify(fixture(name)));
};
const APPROVAL_KEYS = /"(approved|approvalNeeded|approval)"/;

test('F2 fixtures are kernel documents with recorded argv, exit and hashes; no approval fixture remains', () => {
  assert.equal(provenance.kernel, raw('version').version);
  for (const [name, entry] of Object.entries(provenance.files)) {
    assert.equal(createHash('sha256').update(readFileSync(file(name))).digest('hex'), entry.fixtureSha256, name);
    assert.equal(entry.argv.at(-1), '--json'); assert.equal(entry.kernel, provenance.kernel);
    assert.ok(!entry.argv.includes('--approve'), name);
  }
  for (const gone of ['sync-pending', 'sync-approved', 'sync-approve-partial', 'sync-approve-wrong-version', 'workspace-status-pending', 'capabilities-pending'])
    assert.equal(Object.hasOwn(provenance.files, gone), false, gone);
  assert.equal(provenance.files['sync-integrity'].exit, 1);
});

test('argv is fixed per verb; there is no approve verb', () => {
  assert.deepEqual(WORKSPACE_ACTIONS, ['capabilities', 'souls', 'sync', 'onboard', 'capability-show']);
  assert.deepEqual(workspaceArgv({ action: 'capabilities', context: deployment }).argv, ['capabilities', '--dir', deployment, '--json']);
  assert.equal(workspaceArgv({ action: 'capabilities', context: deployment }).timeout, WORKSPACE_READ_TIMEOUT);
  assert.deepEqual(workspaceArgv({ action: 'sync', context: deployment }).argv, ['sync', '--dir', deployment, '--json']);
  assert.equal(workspaceArgv({ action: 'sync', context: deployment }).timeout, WORKSPACE_WRITE_TIMEOUT);
  assert.deepEqual(workspaceArgv({ action: 'onboard', dir: '/work/acme', workspace: 'github.com/acme/agents' }),
    { argv: ['onboard', '/work/acme', '--workspace', 'github.com/acme/agents', '--json'], cwd: '/work/acme', timeout: WORKSPACE_WRITE_TIMEOUT });
  // Nothing option-shaped, relative, duplicated or extra reaches argv.
  for (const bad of [
    { action: 'sync', context: 'relative' }, { action: 'sync', context: deployment, extra: 1 }, { action: 'list', context: deployment },
    { action: 'approve', context: deployment, approvals: [{ id: 'a', version: '1' }] }, { action: 'sync', context: deployment, approvals: [{ id: 'a', version: '1' }] },
    { action: 'onboard', dir: '/work/acme', workspace: '--help' }, { action: 'onboard', dir: 'rel', workspace: 'x' },
    { action: 'onboard', dir: '/work/acme', workspace: 'a\nb' }, { action: 'onboard', dir: '/work/acme', workspace: ' padded' },
  ]) assert.equal(workspaceArgv(bad), null, JSON.stringify(bad));
  assert.equal(validWorkspaceRef('github.com/acme/agents'), true);
  assert.equal(validWorkspaceRef(''), false);
});

test('exec: bounded, no shell, scrubbed instance selectors, caller env untouched', async () => {
  const env = { KEEP: '1', OATS_INSTANCE_HOME: '/foreign', PI_AGENTS_ROOT: '/foreign', OATS_DEPLOYMENT: '/foreign' };
  const result = await cliWorkspace(cli(), { action: 'capabilities', context: deployment }, DESKTOP_TERMS, { env, exec(bin, argv, options, done) {
    assert.equal(bin, '/fixture/bin/oats'); assert.equal(options.shell, false); assert.equal(options.cwd, deployment);
    assert.equal(options.maxBuffer, WORKSPACE_MAX_BUFFER); assert.deepEqual(options.env, { KEEP: '1' });
    replay('capabilities')(bin, argv, options, done);
  } });
  assert.deepEqual(Object.keys(result), ['ok', 'document']); assert.equal(result.ok, true);
  assert.equal(env.OATS_INSTANCE_HOME, '/foreign');
});

test('exit semantics: success is exit 0 only (no "pending"); refusals keep only code/message', async () => {
  const run = (options, name) => cliWorkspace(cli(), options, DESKTOP_TERMS, { exec: replay(name) });
  assert.deepEqual(await run({ action: 'sync', context: deployment }, 'sync-current'), { ok: true, document: fixture('sync-current') });
  for (const action of ['sync', 'capabilities']) {
    const name = action === 'sync' ? 'sync-current' : 'capabilities';
    const two = await cliWorkspace(cli(), { action, context: deployment }, DESKTOP_TERMS, { exec: (_b, _a, _o, done) => done(exitError(2), JSON.stringify(fixture(name))) });
    assert.equal(two.reason.code, 'E_CLI_FAILED', `${action}: exit 2 is not a success any more`);
  }
  const integrity = await run({ action: 'sync', context: deployment }, 'sync-integrity');
  assert.deepEqual(Object.keys(integrity.reason), ['code', 'message']);
  assert.equal(integrity.reason.code, 'E_PACKAGE_INTEGRITY');
  assert.match(integrity.reason.message, /the tag moved; a version string must change when its content does/, 'the kernel message, verbatim');
  const rolled = await run({ action: 'onboard', dir: '/fixture/base/other-workspace', workspace: '/fixture/base/fx/remotes/missing.git' }, 'onboard-unreadable');
  assert.deepEqual(rolled.reason, { code: 'E_REMOTE_UNREADABLE', message: fixture('onboard-unreadable').error.message, rolledBack: true });
  // A refusal on a success exit, garbage, timeouts and huge output fail closed.
  assert.equal((await cliWorkspace(cli(), { action: 'sync', context: deployment }, DESKTOP_TERMS, { exec: (_b, _a, _o, done) => done(null, JSON.stringify(fixture('sync-integrity'))) })).reason.code, 'E_CLI_PROTOCOL');
  assert.equal((await cliWorkspace(cli(), { action: 'sync', context: deployment }, DESKTOP_TERMS, { exec: (_b, _a, _o, done) => done(null, 'SECRET') })).reason.code, 'E_CLI_PROTOCOL');
  assert.equal((await cliWorkspace(cli(), { action: 'sync', context: deployment }, DESKTOP_TERMS, { exec: (_b, _a, _o, done) => done({ killed: true }, '') })).reason.code, 'E_CLI_TIMEOUT');
  assert.equal((await cliWorkspace(cli(), { action: 'sync', context: deployment }, DESKTOP_TERMS, { exec: (_b, _a, _o, done) => done({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, '') })).reason.code, 'E_CLI_OUTPUT_LIMIT');
  assert.doesNotMatch(JSON.stringify(await cliWorkspace(cli(), { action: 'sync', context: deployment }, DESKTOP_TERMS, { exec: (_b, _a, _o, done) => done(exitError(1), 'SECRET stderr') })), /SECRET/);
});

test('gate: API 2, workspace-v2 and packages-no-approval are all required; nothing dispatches otherwise', async () => {
  const older = { ...cli(), features: cli().features.filter(f => f !== 'packages-no-approval') };
  for (const state of [{ ...cli(), ok: false }, { ...cli(), workspaceApi: 1 }, { ...cli(), features: [] }, { ...cli(), bin: 'oats' }, older]) {
    const result = await cliWorkspace(state, { action: 'sync', context: deployment }, DESKTOP_TERMS, { exec: assert.fail });
    assert.equal(result.ok, false);
  }
  const refused = await cliWorkspace(older, { action: 'sync', context: deployment }, DESKTOP_TERMS, { exec: assert.fail });
  assert.equal(refused.reason.code, 'E_WORKSPACE_FEATURE'); assert.match(refused.reason.message, /Update OATS/);
});

test('projectors keep command shapes and carry no approval state, whatever the document says', () => {
  const moved = syncData(fixture('sync-moved'), deployment);
  assert.equal(moved.members.find(m => m.name === 'marketing').status, 'no-backlink');
  assert.throws(() => syncData(fixture('sync-current'), '/elsewhere'), { code: 'E_DEPLOYMENT_SCOPE' });
  const current = syncData(fixture('sync-current'), deployment);
  assert.ok(current.packages.length > 0 && current.packages.every(p => p.commit && p.integrity));
  // Even an old-kernel document's approval fields are not projected.
  for (const projected of [syncData(raw('sync-current'), deployment), capabilitiesData(raw('capabilities')), onboardData(raw('onboard'), deployment)])
    assert.doesNotMatch(JSON.stringify(projected), APPROVAL_KEYS);
  const catalog = capabilitiesData(fixture('capabilities'));
  assert.deepEqual([...new Set(catalog.capabilities.map(c => c.kind))].sort(), ['member', 'package']);
  const onboard = onboardData(fixture('onboard'), deployment);
  assert.deepEqual(onboard.next.clone.map(c => c.name), ['agents', 'platform', 'data', 'marketing', 'nw-tools']);
  assert.equal(onboard.hosting.hostIsMember, true);
  assert.throws(() => onboardData(fixture('onboard'), '/fixture/base/other'), { code: 'E_DEPLOYMENT_SCOPE' });
});

/* ── the server boundary ─────────────────────────────────────────────── */
const workspace = { id: deployment, scope: deployment };
function boundary(script) {
  const calls = [];
  const invoke = async (state, options) => {
    calls.push(options);
    const step = script.shift();
    if (!step) assert.fail(`unexpected ${options.action}`);
    return typeof step === 'function' ? step(state, options) : cliWorkspace(state, options, DESKTOP_TERMS, { exec: replay(step) });
  };
  return { request: createWorkspaceSyncBoundary({ invoke }), calls };
}

test('read returns the projected catalog; sync returns the lock it wrote', async () => {
  const b = boundary(['capabilities', 'sync-current']);
  const read = await b.request({ action: 'read' }, { workspace, cli: cli() });
  assert.equal(read.status, 'ok'); assert.equal(read.capabilities.capabilities.length, 10);
  assert.equal(read.refreshing, false); assert.equal(typeof read.observedAt, 'string', 'a direct read stamps its completion time');
  const sync = await b.request({ action: 'sync' }, { workspace, cli: cli() });
  assert.equal(sync.status, 'ok'); assert.deepEqual(sync.report, syncData(fixture('sync-current'), deployment));
  assert.deepEqual(b.calls, [{ action: 'capabilities', context: deployment }, { action: 'sync', context: deployment }]);
});

test('there is no approve action: it is refused before anything dispatches', async () => {
  const b = boundary([]);
  for (const bad of [{ action: 'approve', approvals: [{ id: 'nw.tools', version: '0.4.0', executables: `sha256-${'0'.repeat(64)}` }] }, { action: 'sync', approvals: [] }])
    assert.equal((await b.request(bad, { workspace, cli: cli() })).reason.code, 'E_BAD_ARGS');
  assert.equal(b.calls.length, 0);
});

test('a refused sync is the kernel refusal, verbatim', async () => {
  const b = boundary(['sync-integrity']);
  const refused = await b.request({ action: 'sync' }, { workspace, cli: cli() });
  assert.equal(refused.status, 'refused'); assert.equal(refused.reason.code, 'E_PACKAGE_INTEGRITY');
  assert.equal(refused.reason.message, fixture('sync-integrity').error.message);
});

test('one sync per deployment; a malformed report is a protocol failure', async () => {
  let release;
  const b = boundary([() => new Promise(done => { release = () => done(cliWorkspace(cli(), { action: 'sync', context: deployment }, DESKTOP_TERMS, { exec: replay('sync-current') })); })]);
  const first = b.request({ action: 'sync' }, { workspace, cli: cli() });
  await new Promise(r => setImmediate(r));
  assert.equal((await b.request({ action: 'sync' }, { workspace, cli: cli() })).reason.code, 'E_SYNC_BUSY');
  release(); assert.equal((await first).status, 'ok');
  const broken = fixture('sync-current'); broken.result.syncApi = 2;
  const liar = boundary([async () => ({ ok: true, document: broken })]);
  assert.equal((await liar.request({ action: 'sync' }, { workspace, cli: cli() })).reason.code, 'E_CLI_PROTOCOL');
});

test('remote, unknown, pre-v2 or pre-no-approval contexts never dispatch', async () => {
  const b = boundary([]);
  const older = { ...cli(), features: cli().features.filter(f => f !== 'packages-no-approval') };
  for (const [ws, state] of [[null, cli()], [{ ...workspace, remote: true }, cli()], [{ ...workspace, server: 'h' }, cli()], [workspace, { ...cli(), features: [] }], [workspace, older]]) {
    const result = await b.request({ action: 'sync' }, { workspace: ws, cli: state });
    assert.notEqual(result.status, 'ok');
  }
  for (const bad of [null, { action: 'list' }, { action: 'sync', extra: 1 }, { action: 'read', approvals: [] }, { action: 'sync', refresh: true }, { action: 'read', refresh: 'now' }])
    assert.equal((await b.request(bad, { workspace, cli: cli() })).reason.code, 'E_BAD_ARGS');
  assert.equal(b.calls.length, 0);
});

/* ── the real HTTP route, extracted from the shipped server ─────────── */
function httpHarness(workspaceSyncRequest) {
  const source = readFileSync(new URL('../server/oats-web.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const send = (res, code, body, type');
  const end = source.indexOf('\n// No upgrade transport');
  const errorStart = source.indexOf('function spawnErrorPayload(e)');
  const errorEnd = source.indexOf('/* OATSWEB_SPAWNERR_END */', errorStart);
  const { syncFailure } = { syncFailure: code => ({ workspaceSyncApi: 1, status: 'unavailable', reason: { code } }) };
  let refreshes = 0;
  const dependencies = {
    createServer: callback => callback, workspaceSyncRequest, syncFailure, observeMutation: () => { refreshes++; },
    cliState: cli(), ctxs: [deployment], ...deploymentDoubles(() => [workspace]),
  };
  const handler = new Function(...Object.keys(dependencies), `${source.slice(errorStart, errorEnd)}\n${source.slice(start, end)}\nreturn server;`)(...Object.values(dependencies));
  return {
    refreshes: () => refreshes,
    async request({ url = `/api/workspace-sync?ws=${encodeURIComponent(deployment)}`, body = '{}', headers = { host: '127.0.0.1:4820', origin: 'http://127.0.0.1:4820' } } = {}) {
      const req = new EventEmitter(); req.url = url; req.method = 'POST'; req.headers = controlHeaders(headers);
      let result;
      const res = { writeHead(status) { result = { status }; }, end(raw) { result.body = JSON.parse(raw); } };
      const completion = handler(req, res);
      req.emit('data', Buffer.from(body)); req.emit('end'); await completion;
      return result;
    },
  };
}

test('HTTP: loopback Host/Origin guards first, one ws selector, snapshot refresh only after a sync', async () => {
  const b = boundary(['capabilities', 'sync-current', 'sync-integrity']);
  const http = httpHarness(b.request);
  for (const headers of [{ host: 'evil.invalid' }, { host: 'localhost', origin: 'https://evil.invalid' }, { host: 'localhost', origin: 'null' }])
    assert.equal((await http.request({ headers, body: '{"action":"sync"}' })).status, 403);
  for (const url of ['/api/workspace-sync', `/api/workspace-sync?ws=a&ws=b`, `/api/workspace-sync?ws=${encodeURIComponent(deployment)}&x=1`])
    assert.equal((await http.request({ url, body: '{"action":"sync"}' })).status, 400);
  assert.equal((await http.request({ body: 'not JSON' })).status, 400);
  assert.equal(b.calls.length, 0);
  assert.equal((await http.request({ body: '{"action":"read"}' })).body.status, 'ok');
  assert.equal(http.refreshes(), 0, 'a catalog read is not a mutation');
  assert.equal((await http.request({ body: '{"action":"sync"}' })).body.status, 'ok');
  assert.equal(http.refreshes(), 1);
  assert.equal((await http.request({ body: '{"action":"sync"}' })).body.status, 'refused');
  assert.equal(http.refreshes(), 1, 'a refused sync wrote nothing to refresh');
  assert.equal((await http.request({ body: '{"action":"approve","approvals":[]}' })).body.reason.code, 'E_BAD_ARGS');
});

/* ── capability-show: `oats capabilities show` (feature capability-show, capabilityShowApi 1) ── */
const showCli = (extra = {}) => ({ ...cli(), features: [...cli().features, 'capability-show'], capabilityShowApi: 1, ...extra });
const MEMBER = 'local//fixture/base/fx/remotes/agents.git';

test('capability-show: fixed argv per selector, --file only with a path, --max-age before --json, read timeout', () => {
  const base = { action: 'capability-show', context: deployment, name: 'nw-house-style' };
  assert.deepEqual(workspaceArgv({ ...base, member: MEMBER }),
    { argv: ['capabilities', 'show', 'nw-house-style', '--member', MEMBER, '--dir', deployment, '--json'], cwd: deployment, timeout: WORKSPACE_READ_TIMEOUT });
  assert.deepEqual(workspaceArgv({ ...base, name: 'oats.core', package: 'oats.framework', path: 'skills/oats-operate/SKILL.md', maxAge: 60 }).argv,
    ['capabilities', 'show', 'oats.core', '--package', 'oats.framework', '--file', 'skills/oats-operate/SKILL.md', '--dir', deployment, '--max-age', '60', '--json']);
  assert.deepEqual(workspaceArgv({ ...base, member: MEMBER, maxAge: 0 }).argv.slice(-3), ['--max-age', '0', '--json']);
});

test('capability-show: refuses anything that is not one selector, a valid name and a plain relative path', () => {
  const base = { action: 'capability-show', context: deployment, name: 'nw-house-style', member: MEMBER };
  for (const bad of [
    { ...base, path: '../x' }, { ...base, path: 'a/../b' }, { ...base, path: '/abs' }, { ...base, path: '-x' }, { ...base, path: 'a\\b' },
    { ...base, path: 'a//b' }, { ...base, path: './a' }, { ...base, path: '' }, { ...base, path: 'a\nb' }, { ...base, path: undefined }, { ...base, path: 7 },
    { ...base, package: 'oats.framework' }, { action: 'capability-show', context: deployment, name: 'x' },
    { ...base, member: '--help' }, { ...base, member: '' }, { ...base, member: undefined },
    { action: 'capability-show', context: deployment, name: 'oats.core', package: 'Bad Id' },
    { ...base, name: '-x' }, { ...base, name: '' }, { ...base, name: 'a b' }, { ...base, name: undefined },
    { ...base, context: 'relative' }, { ...base, context: '/a/../b' }, { ...base, file: 'SKILL.md' }, { ...base, extra: 1 }, { ...base, maxAge: -1 }, { ...base, maxAge: '60' },
  ]) assert.equal(workspaceArgv(bad), null, JSON.stringify(bad));
});

test('capability-show: gated on the feature AND capabilityShowApi 1; nothing dispatches otherwise', async () => {
  const request = { action: 'capability-show', context: deployment, name: 'nw-house-style', member: MEMBER };
  for (const state of [cli(), showCli({ capabilityShowApi: undefined }), showCli({ capabilityShowApi: 2 }), showCli({ capabilityShowApi: '1' }),
    { ...cli(), capabilityShowApi: 1 }]) {
    const result = await cliWorkspace(state, request, DESKTOP_TERMS, { exec: assert.fail });
    assert.deepEqual(result, { ok: false, reason: { code: 'E_CAPABILITY_SHOW_FEATURE', message: "The installed OATS CLI can't show what a capability ships. Update OATS and retry." } });
  }
  // The workspace line itself still gates first; a bad request is still a bad request.
  assert.equal((await cliWorkspace({ ...showCli(), workspaceApi: 1 }, request, DESKTOP_TERMS, { exec: assert.fail })).reason.code, 'E_WORKSPACE_FEATURE');
  assert.equal((await cliWorkspace(showCli(), { ...request, path: '../x' }, DESKTOP_TERMS, { exec: assert.fail })).reason.code, 'E_BAD_ARGS');
  // The other verbs never needed the feature.
  assert.equal((await cliWorkspace(cli(), { action: 'capabilities', context: deployment }, DESKTOP_TERMS, { exec: replay('capabilities') })).ok, true);
});

test('capability-show: --max-age reaches argv only when the probe declares observe-max-age (it is a read)', async () => {
  const request = Object.freeze({ action: 'capability-show', context: deployment, name: 'nw-house-style', member: MEMBER, maxAge: 60 });
  for (const declared of [true, false]) {
    const state = showCli(declared ? { features: [...showCli().features, 'observe-max-age'] } : {});
    let argv;
    const result = await cliWorkspace(state, request, DESKTOP_TERMS, { exec: (_b, a, _o, done) => { argv = a; done(null, JSON.stringify({ schemaVersion: 1, ok: true, result: {} })); } });
    assert.equal(result.ok, true);
    assert.equal(argv.includes('--max-age'), declared, `declared ${declared}`);
    assert.equal(argv.at(-1), '--json');
  }
  assert.equal((await cliWorkspace(showCli(), { ...request, maxAge: -1 }, DESKTOP_TERMS, { exec: assert.fail })).reason.code, 'E_BAD_ARGS');
});

test('capability-show: a refusal is the kernel code/message only; never a shell', async () => {
  let seen;
  const result = await cliWorkspace(showCli(), { action: 'capability-show', context: deployment, name: 'nw-house-style', member: MEMBER, path: 'skills/x/SKILL.md' }, DESKTOP_TERMS, {
    exec(bin, argv, options, done) {
      seen = { bin, argv, options };
      done(exitError(1), JSON.stringify({ schemaVersion: 1, ok: false, error: { code: 'E_CAPABILITY_FILE_NOT_FOUND', message: 'no such file: skills/x/SKILL.md', details: { secret: 1 } } }));
    } });
  assert.deepEqual(result, { ok: false, reason: { code: 'E_CAPABILITY_FILE_NOT_FOUND', message: 'no such file: skills/x/SKILL.md' } });
  assert.equal(seen.options.shell, false); assert.equal(seen.options.cwd, deployment); assert.equal(seen.options.timeout, WORKSPACE_READ_TIMEOUT);
  assert.deepEqual(seen.argv, ['capabilities', 'show', 'nw-house-style', '--member', MEMBER, '--file', 'skills/x/SKILL.md', '--dir', deployment, '--json']);
});
