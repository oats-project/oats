// #1879 acceptance 3 (allowlist enforcement): with the accepted CLI above the Desktop's tested bound, every
// held-back operation is refused where it enters the backend, before anything that runs the CLI is called, and
// its refusal carries the notice sentence; every allowlisted operation still reaches the CLI.
//
// Through the shipped HTTP handler (oats-web.mjs, as workspace-views-fixture.mjs loads it) with an injected exec:
// every boundary the handler would hand an operation to (the lifecycle, schedules, automations, sync, capabilities,
// machines, forget, teams and launch-configuration boundaries, the spawn apply and preview, the start, the record
// writes, the Git read) is a double that records its name in `ran` and is the only way a CLI process could start
// from that route. A held-back operation leaves `ran` empty. The launch resume sweep is held back the same way in
// main (session-resume-launch.mjs), over the real trigger with its run injected; an attach reaches its CLI through
// session-attach.mjs with an injected runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadServer, juanState, A } from './helpers/workspace-views-fixture.mjs';
import { createResumeWiring } from '../session-resume-launch.mjs';
import { createResumeTrigger } from '../../client/session-resume-trigger.mjs';
import { prepareRemoteTerm } from '../../client/session-attach.mjs';
import { aboveTestedNotice, desktopReleaseUrl } from '../../client/above-tested-notice.mjs';
import { ABOVE_TESTED_CODE, aboveTestedRefusal } from '../../client/above-tested.mjs';

const BASE = { ok: true, bin: '/oats', features: ['workspace-identity', 'session-start', 'session-restart', 'session-resume'], remote: ['roster', 'session'] };
const ABOVE = { ...BASE, version: '0.70.1', aboveTested: true, testedThrough: '0.69' };
const INSIDE = { ...BASE, version: '0.69.25' };
const NOTICE = aboveTestedNotice({ cliVersion: '0.70.1', testedThrough: '0.69' });
const WS = `?ws=${encodeURIComponent(A)}`;
const HOME = `${A}/agents/dev/instances/dev-a`;

/** The handler over `cli`, every boundary an exec double: `ran` lists each that was called, in order. */
async function serve(cli) {
  const ran = [];
  const exec = (name, answer = {}) => async () => { ran.push(name); return answer; };
  const { state } = juanState();
  const { request } = await loadServer({ ...state, cliState: cli }, {
    lifecycleRequest: exec('lifecycle', { lifecycleApi: 1, status: 'unavailable' }),
    scheduleRequest: exec('schedules'),
    automationsRequest: exec('automations', { status: 'ok' }),
    workspaceSyncRequest: exec('workspace-sync', { status: 'unavailable' }),
    capabilityRequest: exec('capabilities'),
    capabilityShowRequest: exec('capability-show'),
    machines: { connect: exec('server-connect'), check: exec('server-check'), remove: exec('server-remove') },
    serverForget: { forget: async () => { ran.push('server-forget'); return { http: 200, ran: false, answer: {} }; } },
    teamsRequest: exec('teams'), soulTeamsRequest: exec('soul-teams'),
    launchConfigRequest: exec('launch-configs'),
    spawnApplyRequest: exec('spawn-apply', { status: 'prepared' }),
    spawnPreview: { read: exec('spawn-preview'), suggest: exec('spawn-suggest'), suggestName: exec('spawn-suggest-name'), cache: { invalidate() {} } },
    startInstance: async (cliState, inst, choices, { restart }) => { ran.push(restart ? 'restart' : 'start'); return { ok: true, result: { instance: inst.instance } }; },
    instanceColorRequest: exec('instance-color', { status: 'not-run' }), instanceColorNotRun: () => ({}),
    instanceBackgroundRequest: exec('instance-background', { status: 'not-run' }), instanceBackgroundNotRun: () => ({}),
    instanceGitRequest: exec('instance-git'),
    // What the handler does around a boundary's answer: nothing here runs a command.
    rereadsRoster: () => false, observeMutation: () => {}, refreshRemoteSnapshot: async () => {}, remoteLoop: { request() {} },
    inspectCache: { invalidate() {} }, CREATED_STATUSES: [], awaitSpawned: async () => {}, agentsData: () => ({ agents: [] }),
    verifiedLocalHome: () => HOME, adapter: {}, START_UNCONFIRMED: { message: '', code: 'E_START_UNCONFIRMED' },
    automationsFailure: code => ({ code }), syncFailure: code => ({ code }), spawnApplyFailure: code => ({ reason: { code, message: code } }),
    forgetNotRun: code => ({ code }), BACKGROUND_MAX_AGE: 0, capabilityCatalogKey: () => null,
    capabilityCatalog: { read: async () => null, held: () => null }, capabilityShowCache: new Map(), ctxs: state.ctxs,
  });
  const post = (url, body) => request({ url, method: 'POST', body });
  return { post, ran };
}

const HELD = [
  ['Stop apply', `/api/instance-lifecycle${WS}`, { action: 'apply', planRef: 'stop:dev-a' }],
  ['Retire apply', `/api/instance-lifecycle${WS}`, { action: 'apply', planRef: 'retire:dev-a' }],
  ['the Stop and Remove plan', `/api/instance-lifecycle${WS}`, { action: 'plan', operation: 'stop', selector: { home: HOME } }],
  ['an unguarded retire', `/api/retire/dev-a${WS}`, {}],
  ['a schedule update', `/api/schedules${WS}`, { operation: 'update', id: 'nightly', spec: { cron: '0 3 * * *', tz: 'UTC', enabled: true } }],
  ['a schedule enable', `/api/automations${WS}`, { kind: 'schedule', action: 'enable', key: 'local/nightly' }],
  ['a trigger write', `/api/automations${WS}`, { kind: 'trigger', action: 'enable', key: 'pr-review' }],
  ['a trigger description', `/api/automations${WS}`, { kind: 'trigger', action: 'describe', key: 'pr-review', description: 'x' }],
  ['workspace sync', `/api/workspace-sync${WS}`, { action: 'sync' }],
  ['a capability run', `/api/capabilities${WS}`, { action: 'run', selector: { home: HOME }, operation: 'messaging:teams' }],
  ['server connect', `/api/server-connect${WS}`, { id: 'altair', host: 'altair', folder: '/home/juan/oats' }],
  ['server check', `/api/server-check${WS}`, { id: 'altair' }],
  ['server remove', `/api/server-remove${WS}`, { id: 'altair' }],
  ['server forget', '/api/server-forget', { server: 'build', instance: 'dev-a' }],
  ['a team write', `/api/workspace-teams${WS}`, { action: 'add', label: 'x', team: 'a:b' }],
  ['a launch-configuration write', `/api/launch-configs${WS}`, { action: 'set', name: 'x', selector: { context: A } }],
  ['an execution-server spawn', `/api/spawn${WS}`, { agent: 'dev', agentsRoot: `${A}/agents`, serverId: 'altair' }],
  ['an action no table names yet', `/api/instance-git${WS}`, { action: 'rewrite', selector: { home: HOME } }],
];

for (const [name, url, body] of HELD) {
  test(`acceptance (enforcement): above the tested bound, ${name} is refused before any CLI process, with the notice sentence`, async () => {
    const s = await serve(ABOVE);
    const answer = await s.post(url, body);
    assert.deepEqual(s.ran, [], `${name}: nothing that runs the CLI was called`);
    assert.equal(answer.status, 409);
    assert.deepEqual(answer.body, { status: 'refused', code: ABOVE_TESTED_CODE, error: NOTICE, reason: { code: ABOVE_TESTED_CODE, message: NOTICE },
      release: desktopReleaseUrl('0.70.1') });
  });
}

test('within the tested bound the same held-back operations reach their boundaries as before', async () => {
  for (const [name, url, body] of HELD.filter(([, url]) => !url.startsWith('/api/retire'))) {
    const s = await serve(INSIDE);
    const answer = await s.post(url, body);
    assert.notEqual(answer.body?.code, ABOVE_TESTED_CODE, name);
    if (!/no table names|execution-server/.test(name)) assert.equal(s.ran.length, 1, `${name} reached its boundary: ${JSON.stringify(answer)}`);
  }
});

const ALLOWED = [
  ['Spawn prepare', `/api/spawn${WS}`, { action: 'prepare', selector: { soul: 'dev' } }, 'spawn-apply'],
  ['Spawn apply', `/api/spawn${WS}`, { action: 'apply', spawnRef: 'x', expectDecision: 'y' }, 'spawn-apply'],
  ['the Spawn preview', `/api/workspace-spawn-preview${WS}`, { action: 'preview', selector: { soul: 'dev' } }, 'spawn-preview'],
  ['Start', `/api/start/dev-a${WS}&home=${encodeURIComponent(HOME)}`, {}, 'start'],
  ['Restart', `/api/restart/dev-a${WS}&home=${encodeURIComponent(HOME)}`, {}, 'restart'],
  ['the colour', `/api/instance-color${WS}`, { selector: { home: HOME }, color: 'teal' }, 'instance-color'],
  ['the background', `/api/instance-background${WS}`, { selector: { home: HOME }, background: true }, 'instance-background'],
  ['a read (Git)', `/api/instance-git${WS}`, { action: 'git', selector: { home: HOME } }, 'instance-git'],
  ['a read (a trigger list)', `/api/automations${WS}`, { kind: 'trigger', action: 'list' }, 'automations'],
];

for (const [name, url, body, boundary] of ALLOWED) {
  test(`acceptance (enforcement): above the tested bound, ${name} is allowed and reaches the CLI`, async () => {
    const s = await serve(ABOVE);
    const answer = await s.post(url, body);
    assert.notEqual(answer.body?.code, ABOVE_TESTED_CODE, `${name}: ${JSON.stringify(answer.body)}`);
    assert.deepEqual(s.ran, [boundary]);
  });
}

test('acceptance (enforcement): above the tested bound, an attach is allowed and reaches the CLI', async () => {
  assert.equal(aboveTestedRefusal(ABOVE, 'main terminal attach'), null);
  const calls = [];
  const got = await prepareRemoteTerm({ ...ABOVE, bin: '/selected/oats' }, { serverId: 'build', instance: 'dev-a', home: HOME },
    { run: async (bin, args) => { calls.push(args); return { stdout: JSON.stringify({ schemaVersion: 1, ok: true, result: { present: true } }) }; } });
  assert.deepEqual(calls, [['session', 'inspect', '--server', 'build', '--home', HOME, '--json']]);
  assert.deepEqual(got.args, ['session', 'attach', '--server', 'build', '--home', HOME]);
});

/** The launch sweep as main wires it (session-resume-launch.mjs), over the real trigger, its run injected. */
function sweep(cli) {
  const ran = [], logged = [];
  const trigger = createResumeWiring({
    createTrigger: options => createResumeTrigger({ ...options, run: async probe => { ran.push(probe); return { schemaVersion: 1, ok: true, result: { resumed: [] } }; },
      read: () => ({ kind: 'answered' }) }),
    cli: () => cli, error: line => logged.push(line),
  });
  return { trigger, ran, logged };
}

test('acceptance (enforcement): above the tested bound, the launch resume sweep runs nothing and logs one line naming the refusal code', async () => {
  const s = sweep(ABOVE);
  await s.trigger.launch();
  await s.trigger.observed([], { localDeploymentIds: [] });
  assert.deepEqual(s.ran, [], 'the sweep never ran');
  assert.deepEqual(s.logged, [`oats-desktop: the session resume sweep was skipped: ${ABOVE_TESTED_CODE}`]);
  const inside = sweep(INSIDE);
  await inside.trigger.launch();
  assert.equal(inside.ran.length, 1, 'within the bound the launch sweep runs as before');
  assert.deepEqual(inside.logged, []);
});

test('acceptance (enforcement): above the tested bound, a POST to a route no table names is refused before the handler dispatches it', async () => {
  for (const url of ['/api/inventory-probe', `/api/inventory-probe/dev-a${WS}`, '/api/start/dev-a/extra', '/api/version']) {
    const s = await serve(ABOVE);
    const answer = await s.post(url, { action: 'list' });
    assert.deepEqual(s.ran, [], url);
    assert.equal(answer.status, 409, url);
    assert.equal(answer.body.code, ABOVE_TESTED_CODE, url);
    assert.equal(answer.body.error, NOTICE, url);
    // Within the bound the same request is the handler's, as before: no such route.
    const inside = await serve(INSIDE);
    assert.equal((await inside.post(url, { action: 'list' })).status, 404, url);
  }
});
