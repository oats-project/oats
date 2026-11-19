import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { cliCapability } from '../../client/cli-adapter.mjs';
import { capabilityRequest } from '../server/capabilities.mjs';
import { createSoulInspector } from '../renderer/soul-inspector.mjs';
import { setWorkspace } from '../renderer/views/common.mjs';
import { scheduleRequest } from '../server/schedules.mjs';
import { soulInspection, homeInspection, capturedRun } from './helpers/inspect-fixture.mjs';

const cli = { ok: true, bin: '/installed/oats', operationsApi: 2, scheduleApi: 1, features: ['operations', 'schedule'], remote: ['operations', 'schedule'] };
const workspace = { id: '/team', scope: '/team' };
const agents = ['one', 'two'].map(name => ({ name: 'dev', agentsRoot: `/team/${name}/agents`, workspace: `/team/${name}` }));
const home = '/team/two/agents/dev/instances/dev-seat';
const instances = [{ instance: 'dev-seat', home, agentsRoot: agents[1].agentsRoot, savedRoute: true }];
const envelope = result => ({ schemaVersion: 1, ok: true, result });

test('scope boundary keeps same-named souls distinct, rejects foreign homes and never falls back from an unregistered remote', async () => {
  const calls = [];
  const options = { workspace, cli, agents, instances, localCwd: '/local', invoke: async (bin, args) => { calls.push(args); return envelope({}); } };
  await capabilityRequest({ action: 'inspect', selector: { soul: 'dev', agentsRoot: agents[1].agentsRoot } }, options);
  assert.equal(calls[0].context, '/team/two'); assert.equal(calls[0].agentsRoot, agents[1].agentsRoot);
  await capabilityRequest({ action: 'inspect', selector: { home } }, options);
  assert.equal(calls.at(-1).context, undefined, 'exact home owns its context; agents root is not necessarily the work repo');
  assert.equal(calls.at(-1).localCwd, '/team');
  // Read-only boundary: no soul editing (edited in its repository) and no `oats use` (removed by v2).
  for (const action of ['set', 'use']) {
    await assert.rejects(capabilityRequest({ action, selector: { soul: 'dev', agentsRoot: agents[1].agentsRoot } }, options), { code: 'E_BAD_ARGS', message: 'Unknown capability action' });
  }
  await assert.rejects(capabilityRequest({ action: 'inspect', selector: { home: '/foreign' } }, options), /existing home/);
  // Inspection has no scope subject (operationsApi 2): a context selector is refused before any CLI call.
  await assert.rejects(capabilityRequest({ action: 'inspect', selector: { context: '/team' } }, options), /no scope subject/);
  await assert.rejects(capabilityRequest({ action: 'inspect' }, options), /no scope subject/);
  await assert.rejects(capabilityRequest({ action: 'inspect' }, { ...options, workspace: undefined }), /known workspace/);
  await assert.rejects(capabilityRequest({ action: 'inspect' }, { ...options, workspace: { ...workspace, remote: true } }), /registered server/);
  await assert.rejects(capabilityRequest({ action: 'inspect' }, { ...options, cli: { ...cli, operationsApi: undefined } }), /Update/);
  await capabilityRequest({ action: 'inspect', selector: { soul: 'dev', agentsRoot: agents[1].agentsRoot } }, { ...options, workspace: { ...workspace, remote: true, server: 'builder', registrationPresent: true } });
  assert.equal(calls.at(-1).server, 'builder'); assert.equal(calls.at(-1).context, '/team/two'); assert.equal(calls.at(-1).localCwd, '/local');
  assert.ok(calls.every(call => ['inspect', 'run'].includes(call.action)), 'only read and provider-operation calls reach the CLI');
  // observe-max-age contract: the probe's features travel so the adapter can decide on --max-age; without a
  // configured max-age the key is absent, and every inspect result reports when it was observed.
  assert.ok(calls.every(call => call.features === cli.features && !Object.hasOwn(call, 'maxAge')));
  const observed = await capabilityRequest({ action: 'inspect', selector: { home } }, options);
  assert.match(observed.observedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/); assert.equal(observed.refreshing, false);
  await assert.rejects(capabilityRequest({ action: 'run', selector: { home }, operation: 'knowledge:reindex', refresh: true }, options), { code: 'E_BAD_ARGS' });
});

test('adapter: inspect and provider operations only — soul set and use are refused before any CLI call', async () => {
  for (const action of ['set', 'use']) {
    await assert.rejects(cliCapability(cli.bin, { action, soul: 'dev', agentsRoot: '/team/two/agents' }, { exec: assert.fail }), { code: 'E_BAD_ARGS', message: 'Unknown capability action' });
  }
  let argv;
  await cliCapability(cli.bin, { action: 'inspect', context: '/remote/member', server: 'builder', soul: 'dev', agentsRoot: '/remote/member/agents', localCwd: '/local' },
    { exec(bin, args, opts, done) { argv = args; assert.equal(opts.cwd, '/local'); done(null, JSON.stringify({ schemaVersion: 1, ok: true, result: {} })); } });
  assert.deepEqual(argv, ['inspect', '--dir', '/remote/member', '--server', 'builder', '--soul', 'dev', '--agents-root', '/remote/member/agents', '--json']);
});

test('scheduled actions require an available declaration on the selected home', async () => {
  const options = { workspace, cli, instances, invoke: async (_, args) => envelope(args.spec), inspect: async () => ({ capabilities: [{ layer: 'knowledge', activation: { enabled: true }, operations: [{ name: 'digest', kind: 'action', available: true }] }] }) };
  const spec = { kind: 'operation', home, operation: 'knowledge:digest', cron: '0 * * * *', tz: 'UTC', enabled: true };
  assert.deepEqual(await scheduleRequest({ operation: 'add', id: 'digest', spec }, options), spec);
  await assert.rejects(scheduleRequest({ operation: 'add', id: 'digest', spec: { ...spec, operation: 'knowledge:invented' } }, options), /available provider/);
});

const tick = () => new Promise(resolve => setImmediate(resolve));
// operationsApi 2 inspections from the kernel capture (soul subject, or the seat's home):
// oats.okf's status/reindex are unavailable on a soul and available on a home.
function inspection(name = 'dev', source = 'config') {
  return source === 'snapshot' ? homeInspection(home, { instance: 'dev-seat', soul: 'dev' }) : soulInspection(name);
}
function ui(api) {
  setWorkspace('/team'); const dom = new JSDOM('<body><main><aside hidden></aside></main></body>'); const el = dom.window.document.querySelector('aside');
  const calls = [];
  const controller = createSoulInspector(el, { ctx: { api: async (url, opts) => { const body = JSON.parse(opts.body); calls.push({ url, ...body }); return api(body); } } });
  const click = text => { const b = [...el.querySelectorAll('button')].find(b => b.textContent === text); assert.ok(b, `button ${text}`); b.click(); };
  return { dom, el, controller, click, calls, close() { controller.dispose(); dom.window.close(); } };
}
const selection = { agent: { name: 'dev', agentsRoot: agents[1].agentsRoot }, selector: { soul: 'dev', agentsRoot: agents[1].agentsRoot } };

test('inspector ignores old responses and offers no in-place editing', async () => {
  let resolveOld;
  const view = ui(body => body.selector.soul === 'old' ? new Promise(resolve => { resolveOld = resolve; }) : inspection());
  try {
    void view.controller.show({ agent: { name: 'old' }, selector: { soul: 'old' } });
    await view.controller.show(selection); resolveOld(inspection('old')); await tick();
    assert.equal(view.el.querySelector('h2').textContent, 'dev');
    for (const label of ['Edit defaults', 'Edit instructions', 'Disable layer', 'Inherit', 'Disable here']) {
      assert.equal([...view.el.querySelectorAll('button')].some(b => b.textContent === label), false, label);
    }
    assert.equal(view.el.querySelector('form, textarea, input'), null, 'no editor');
    assert.ok(view.calls.every(c => c.action === 'inspect'));
  } finally { view.close(); }
});

test('instance knowledge comes from provider text, with no local path read or HTML interpretation', async () => {
  const view = ui(body => body.action === 'inspect' ? inspection('dev', 'snapshot') : capturedRun({ result: { summary: 'fixture knowledge status', documents: [{ label: 'Memory', kind: 'markdown', path: '/remote/MEMORY.md', text: '<img src=x onerror=evil()>\nProvider memory' }] } }));
  try {
    await view.controller.show({ instance: instances[0], selector: { home } }); view.click('View'); await tick();
    assert.match(view.el.textContent, /Provider memory/); assert.equal(view.el.querySelector('img'), null);
    assert.equal([...view.el.querySelectorAll('button')].some(b => b.textContent === 'Edit defaults' || b.textContent === 'Inherit'), false);
    assert.deepEqual(view.calls[1].selector, { home }); assert.equal(view.calls[1].operation, 'knowledge:status');
  } finally { view.close(); }
});

test('inspector preserves current provider, availability, kind and required-argument operation contracts', async () => {
  const value = inspection('dev', 'snapshot');
  const provider = value.capabilities.find(cap => cap.layer === 'knowledge');
  provider.operations.push(
    { name: 'search', kind: 'view', available: true, args: [{ name: 'query', flag: '--query', required: true }] },
    { name: 'unavailable', kind: 'action', available: false, reason: 'Provider is unavailable' },
  );
  value.capabilities.push(
    // A module that fills no layer is not a provider: its operations are not offered.
    { id: 'unbound.notes', version: '1.0.0', layer: null, from: null, settings: {}, missingRequires: [], operations: [{ name: 'unbound', kind: 'view', available: true }] },
  );
  const view = ui(body => body.action === 'inspect' ? value : capturedRun({ operation: 'knowledge:reindex', result: { digested: true } }));
  try {
    await view.controller.show({ instance: instances[0], selector: { home } });
    assert.deepEqual([...view.el.querySelectorAll('[data-operation]')].map(b => [b.dataset.operation, b.textContent]), [['knowledge:status', 'View'], ['knowledge:reindex', 'Run']]);
    assert.match(view.el.textContent, /requires arguments/);
    assert.match(view.el.textContent, /Provider is unavailable/);
    view.controller.syncAvailability();
    assert.equal(view.calls.length, 1, 'projecting operation controls never runs them');
    view.click('Run'); await tick();
    assert.deepEqual(view.calls[1], { url: '/api/capabilities?ws=%2Fteam', action: 'run', selector: { home }, operation: 'knowledge:reindex' });
    assert.deepEqual(JSON.parse(view.el.querySelector('.operation-output pre').textContent), { digested: true });
    assert.equal(view.calls.length, 2, 'optional args are not synthesized and completion does not rerun');
  } finally { view.close(); }
});

test('a remote home is inspected when the kernel reports it addressable, never on savedRoute alone', async () => {
  const calls = [], remoteWs = { ...workspace, name: 'Build box', remote: true, server: 'builder', registrationPresent: true };
  const row = { instance: 'dev-seat', home, agentsRoot: agents[1].agentsRoot, server: 'builder', savedRoute: false, addressable: true };
  const options = { workspace: remoteWs, cli, agents, localCwd: '/local', invoke: async (bin, args) => { calls.push(args); return envelope({}); } };
  await capabilityRequest({ action: 'inspect', selector: { home } }, { ...options, instances: [row] });
  assert.equal(calls.at(-1).server, 'builder'); assert.equal(calls.at(-1).home, home);
  await assert.rejects(capabilityRequest({ action: 'inspect', selector: { home } }, { ...options, instances: [{ ...row, addressable: false, missingRemotely: true }] }),
    { code: 'E_SNAPSHOT_UNKNOWN', message: 'dev-seat is no longer on Build box. Remove it from this computer with: oats server forget builder --instance dev-seat' });
  assert.equal(calls.length, 1);
});

// #675: a remote refusal travels as a structured reason (hostReason) through the route's error body and both
// renderer error paths, which keep it only once re-validated (remoteReason).
import { apiJson, httpError } from '../renderer/views/common.mjs';
import { MESSY, MESSY_LINE } from './helpers/detail-line.mjs';
import { DETAIL_WITHHELD } from '../../client/display-text.mjs';
const spawnErrorPayload = (() => {
  const source = readFileSync(new URL('../server/oats-web.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function spawnErrorPayload(e)'), end = source.indexOf('/* OATSWEB_SPAWNERR_END */', start);
  return new Function(`${source.slice(start, end)}\nreturn spawnErrorPayload;`)();
})();
const remoteWs = { id: 'remote:g1', name: 'Build box', scope: '/srv/w', remote: true, server: 'build', registrationPresent: true };
const remoteHome = '/srv/w/agents/dev/instances/dev-a';
const remoteRows = [{ instance: 'dev-a', home: remoteHome, agentsRoot: '/srv/w/agents', server: 'build', addressable: true }];
const remoteRefusal = async (error, { workspace: ws = remoteWs, cli: c = cli, rows = remoteRows } = {}) => {
  const calls = [];
  try {
    await capabilityRequest({ action: 'inspect', selector: { home: rows[0].home } }, { workspace: ws, cli: c, instances: rows, localCwd: '/local',
      invoke: async (_, args) => { calls.push(args); return { schemaVersion: 1, ok: false, error }; } });
  } catch (e) { return { e, calls }; }
  assert.fail('expected a refusal');
};

test('#675: a remote refusal carries its reason: the code verbatim, the headline, the display-filtered detail', async () => {
  const { e, calls } = await remoteRefusal({ code: 'E_REMOTE_INCOMPATIBLE', message: 'remote oats 0.30.0 lacks operations' });
  assert.equal(calls[0].server, 'build'); assert.equal(calls[0].home, remoteHome);
  assert.equal(e.code, 'E_REMOTE_INCOMPATIBLE'); assert.equal(e.message, 'remote oats 0.30.0 lacks operations', 'the existing error stays');
  assert.deepEqual(e.reason, { code: 'E_REMOTE_INCOMPATIBLE', message: "Build box runs an OATS that can't do this yet.",
    detail: 'remote oats 0.30.0 lacks operations', remote: true });
  const ssh = (await remoteRefusal({ code: 'E_SSH', message: 'ssh: connect to host build port 22: Connection refused' })).e;
  assert.equal(ssh.reason.message, "Couldn't reach Build box.");
  // A code outside the shared table: the route's own sentence, naming the server.
  const other = (await remoteRefusal({ code: 'E_INSPECT_FAILED', message: 'no such home' })).e;
  assert.deepEqual(other.reason, { code: 'E_INSPECT_FAILED', message: 'Build box refused this request.', detail: 'no such home', remote: true });
  // The detail is the display filter's: a multi-line message as one line, a control character or a secret
  // withheld whole. The code stays verbatim.
  for (const [message, detail] of [[MESSY, MESSY_LINE], ['bell\u0007here', DETAIL_WITHHELD], ['token: abc123', DETAIL_WITHHELD], ['', null]]) {
    const { e: messy } = await remoteRefusal({ code: 'E_SSH', message });
    assert.equal(messy.reason.code, 'E_SSH'); assert.equal(messy.reason.detail, detail, JSON.stringify(message));
  }
  // A code not in the kernel's shape gets no reason.
  assert.equal(Object.hasOwn((await remoteRefusal({ code: 'not-a-kernel-code', message: 'x' })).e, 'reason'), false);
  // The label falls back to the server id, and a label with nothing to show reads "The server".
  assert.equal((await remoteRefusal({ code: 'E_SSH', message: 'x' }, { workspace: { ...remoteWs, name: undefined } })).e.reason.message, "Couldn't reach build.");
  for (const name of ['   ', 'bell\u0007']) assert.equal((await remoteRefusal({ code: 'E_INSPECT_FAILED', message: 'x' }, { workspace: { ...remoteWs, name } })).e.reason.message,
    'The server refused this request.', JSON.stringify(name));
});

test('#675: a remote workspace whose CLI cannot route operations: nothing sent, the unroutable reason, the code and error kept', async () => {
  const calls = [];
  const options = { workspace: remoteWs, cli: { ...cli, remote: ['roster'] }, instances: remoteRows, localCwd: '/local', invoke: async (_, args) => { calls.push(args); return envelope({}); } };
  const e = await capabilityRequest({ action: 'inspect', selector: { home: remoteHome } }, options).catch(x => x);
  assert.equal(calls.length, 0, 'nothing was sent');
  assert.equal(e.code, 'cli-no-operations'); assert.equal(e.message, 'This workspace needs a registered server and remote operations support');
  assert.deepEqual(e.reason, { code: 'unsupported-remote-operation', message: "This computer's OATS can't route this to Build box. Update OATS here.", detail: null, remote: true });
  // An unregistered server is not a routing gap: the refusal stays as it was, with no reason.
  const unregistered = await capabilityRequest({ action: 'inspect', selector: { home: remoteHome } }, { ...options, workspace: { ...remoteWs, registrationPresent: false } }).catch(x => x);
  assert.equal(unregistered.code, 'cli-no-operations'); assert.equal(Object.hasOwn(unregistered, 'reason'), false);
});

test('#675: a local refusal has no reason', async () => {
  const e = await capabilityRequest({ action: 'inspect', selector: { home } }, { workspace, cli, instances, localCwd: '/local',
    invoke: async () => ({ schemaVersion: 1, ok: false, error: { code: 'E_REMOTE_INCOMPATIBLE', message: 'x' } }) }).catch(x => x);
  assert.equal(e.code, 'E_REMOTE_INCOMPATIBLE'); assert.equal(Object.hasOwn(e, 'reason'), false);
  assert.equal(Object.hasOwn(spawnErrorPayload(e).body, 'reason'), false, 'and the route body has none');
});

test('#675: the route body carries the reason; apiJson and httpError keep a valid one and drop an invalid one', async () => {
  const { e } = await remoteRefusal({ code: 'E_REMOTE_INCOMPATIBLE', message: 'remote oats 0.30.0 lacks operations' });
  const { status, body } = spawnErrorPayload(e);
  assert.equal(status, 409);
  assert.deepEqual(body, { error: 'remote oats 0.30.0 lacks operations', code: 'E_REMOTE_INCOMPATIBLE', reason: e.reason });
  const viaFetch = b => apiJson({ api: async () => ({ ok: false, status: 409, json: async () => b }) }, '/api/capabilities', {}).catch(x => x);
  for (const error of [await viaFetch(body), httpError({ status: 409, body }, '/api/capabilities')]) {
    assert.equal(error.code, 'E_REMOTE_INCOMPATIBLE'); assert.deepEqual(error.reason, e.reason);
  }
  const unroutable = { error: 'x', code: 'cli-no-operations', reason: { code: 'unsupported-remote-operation', message: "This computer's OATS can't route this to Build box. Update OATS here.", detail: null, remote: true } };
  assert.deepEqual((await viaFetch(unroutable)).reason, unroutable.reason);
  assert.deepEqual(httpError({ status: 409, body: unroutable }, '/p').reason, unroutable.reason);
  const invalid = [
    { ...e.reason, extra: 1 }, // an extra key
    { ...e.reason, code: 'e_lower' }, { ...e.reason, code: 'cli-no-operations' }, // a bad code
    { ...e.reason, message: 'one\ntwo' }, // a multi-line message
    { ...e.reason, detail: 'a\nb' }, { ...e.reason, remote: false }, 'E_SSH', null,
  ];
  for (const reason of invalid) {
    const b = { ...body, reason };
    assert.equal(Object.hasOwn(await viaFetch(b), 'reason'), false, JSON.stringify(reason));
    assert.equal(Object.hasOwn(httpError({ status: 409, body: b }, '/p'), 'reason'), false, JSON.stringify(reason));
  }
});
