// Addressing (#482): every INSTANCE-addressed request resolves only by exact deployment id. A workspace
// view id (`ws:…`) there never reaches a row and runs nothing; the row's own deployment id resolves inside
// that deployment only (a home of another deployment of the same view is not admitted). The shipped HTTP
// handler runs over the real views (test/helpers/workspace-views-fixture.mjs) with Juan's view:
// two local deployments (A, B) and a remote (R) of one workspace.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadinessBoundary } from '../server/readiness.mjs';
import { readinessFailure } from '../../client/readiness-contract.mjs';
import { createLifecycleBoundary } from '../../client/instance-lifecycle.mjs';
import { DESKTOP_TERMS } from '../renderer/desktop-terms.mjs';
import { createInstanceEventsBoundary } from '../server/instance-events.mjs';
import { eventsFailure } from '../../client/instance-events-contract.mjs';
import { createInstanceGitBoundary } from '../server/instance-git.mjs';
import { capabilityRequest } from '../server/capabilities.mjs';
import { launchConfigRequest } from '../server/launch-configs.mjs';
import { scheduleRequest } from '../server/schedules.mjs';
import { FORGE_EPOCH_HEADER, validForgeEpoch } from '../forge-proxy.mjs';
import { canAddressRemote, unaddressableSentence } from '../../client/remote-address.mjs';
import { apiUrl, servedSelectors } from '../api-url.mjs';
import { startInstance } from '../../client/session-start.mjs';
import { loadServer, juanState, A, B, L, R, V, V_OATS, V_LAB } from './helpers/workspace-views-fixture.mjs';

const CLI = { ok: true, bin: '/oats', version: '0.36.0', features: ['workspace-identity', 'session-start', 'session-restart', 'launch-config', 'schedule',
  'readiness', 'instance-events-2', 'instance-git', 'lifecycle-plans'], remote: ['roster', 'operations', 'launch-config', 'schedule'],
  operationsApi: 2, scheduleApi: 1, readinessApi: 2, eventsApi: 2, instanceGitApi: 1, lifecycleApi: 1 };
const HOME = { A: `${A}/agents/dev/instances/dev-a`, B: `${B}/agents/dev/instances/dev-b`, R: '/home/juan/oats/agents/dev/instances/far-a' };
const enc = encodeURIComponent;

/** The handler with every effect recorded: `effects` (what ran: CLI invocations) and `contexts`
 * (the workspace and rows the handler built for each boundary). */
async function harness() {
  const effects = [], contexts = [];
  const record = (kind) => (...args) => { effects.push({ kind, args }); return { schemaVersion: 1, ok: true, result: {} }; };
  const seen = (route, ctx) => contexts.push({ route, workspace: ctx.workspace?.id ?? null, homes: (ctx.instances || []).map(i => i.home) });
  const readiness = createReadinessBoundary({ invoke: record('readiness') });
  const lifecycle = createLifecycleBoundary({ terms: DESKTOP_TERMS, invoke: record('lifecycle') });
  const events = createInstanceEventsBoundary({ invoke: record('events') });
  const git = createInstanceGitBoundary({ invoke: record('git') });
  const { state } = juanState({ cliState: CLI });
  // A start or restart decides by the row's state (session-start.mjs startGate): B's dev-b is a stopped row here.
  state.snapshot.byWs.get(B).instances[0].running = false;
  const extra = {
    cliState: CLI, cliProbeGeneration: 1, DEBUG: false, BACKGROUND_MAX_AGE: 60,
    adapter: { cliStart: async (bin, args) => { effects.push({ kind: 'start', args: [args] }); return { ok: true, result: { started: true } }; } },
    locator: { requireRemoteSupport: () => {} }, harnessFlag: () => 'harness', canAddressRemote, unaddressableSentence, startInstance,
    verifiedLocalHome: inst => inst.home, dirname: p => p.slice(0, p.lastIndexOf('/')),
    observeMutation: () => {}, refreshRemoteSnapshot: () => {}, remoteLoop: { request: () => {} },
    tmuxTarget: inst => `=${inst.tmux.session}:=${inst.tmux.window}`,
    agentsData: () => ({ agents: [] }), spawnPreview: { cache: { invalidate: () => {} } }, inspectCache: { invalidate: () => {} }, capabilityCatalogKey: () => null,
    readinessFailure, eventsFailure,
    readinessRequest: (req, getContext) => { seen('readiness', getContext()); return readiness(req, getContext); },
    lifecycleRequest: (req, getContext) => { seen('lifecycle', getContext()); return lifecycle(req, getContext); },
    instanceEventsRequest: (req, getContext) => { seen('events', getContext()); return events(req, getContext); },
    instanceGitRequest: (req, ctx) => { seen('git', ctx); return git(req, ctx); },
    FORGE_EPOCH_HEADER, validForgeEpoch,
    forgeBoundary: {
      pull: async (req, getContext) => { seen('forge', getContext()); return { forgeApi: 1, status: getContext().workspace ? 'available' : 'unavailable' }; },
      reviewThreads: async (req, getContext, epoch, paste) => { seen('review-threads', getContext());
        return { forgeApi: 1, found: paste.find({ home: req.home, instance: req.instance })?.home ?? null }; },
    },
    createReviewPaste: ({ find }) => ({ find }),
    capabilityRequest: (req, ctx) => { seen('capabilities', ctx); return capabilityRequest(req, { ...ctx, cache: undefined, invoke: record('capabilities') }); },
    launchConfigRequest: (req, ctx) => { seen('launch-configs', ctx); return launchConfigRequest(req, { ...ctx, invoke: record('launch-configs') }); },
    scheduleRequest: (req, ctx) => { seen('schedules', ctx); return scheduleRequest(req, { ...ctx, invoke: record('schedules') }); },
  };
  const server = await loadServer(state, extra);
  return { ...server, effects, contexts, reset() { effects.length = 0; contexts.length = 0; } };
}

const named = [
  ['start', 'POST', {}], ['restart', 'POST', {}],
];
const instanceSelector = (deployment, name) => ({ instance: name, agent: 'dev', agentsRoot: `${deployment}/agents`, server: null });
/** The body-addressed families: [path, body for B's dev-b]. */
const bodies = [
  ['/api/instance-lifecycle', { action: 'plan', operation: 'stop', selector: { ...instanceSelector(B, 'dev-b'), home: HOME.B } }],
  ['/api/workspace-readiness', { action: 'read', selector: { kind: 'instance', ...instanceSelector(B, 'dev-b') } }],
  ['/api/instance-events', { action: 'read', selector: { ...instanceSelector(B, 'dev-b'), home: HOME.B }, limit: 10 }],
  ['/api/instance-git', { action: 'git', selector: { ...instanceSelector(B, 'dev-b'), home: HOME.B } }],
  ['/api/instance-forge', { action: 'pull', home: HOME.B }],
  ['/api/instance-review-threads', { action: 'threads', home: HOME.B, instance: 'dev-b' }],
];
const homed = [
  ['/api/capabilities', home => ({ action: 'inspect', selector: { home } }), 'capabilities'],
  ['/api/launch-configs', home => ({ action: 'list', selector: { home } }), 'launch-configs'],
  ['/api/schedules', home => ({ operation: 'add', spec: { kind: 'wake', home, cron: '0 9 * * *', tz: 'UTC', enabled: true, message: 'wake up' } }), 'schedules'],
];

test('a view id never resolves a row on the named instance routes; nothing runs', async () => {
  const h = await harness();
  for (const [kind, method, body] of named) {
    for (const ws of [V_OATS, V_LAB]) {
      const r = await h.request({ url: `/api/${kind}/dev-b?ws=${enc(ws)}&home=${enc(HOME.B)}`, method, body });
      assert.equal(r.status, 404, `${kind} ${ws}`);
      assert.equal(r.body.error, 'unknown instance "dev-b"');
      const bare = await h.request({ url: `/api/${kind}/dev-b?ws=${enc(ws)}`, method, body });
      assert.equal(bare.status, 404, `${kind} by name under a view`);
    }
  }
  assert.deepEqual(h.effects, []);
  assert.deepEqual(h.contexts, []);
});

test('the row\'s deployment id resolves the named instance routes inside that deployment only', async () => {
  const h = await harness();
  for (const [kind, method, body] of named) {
    h.reset();
    const r = await h.request({ url: `/api/${kind}/dev-b?ws=${enc(B)}&home=${enc(HOME.B)}`, method, body });
    assert.equal(r.status, 200, `${kind}: ${JSON.stringify(r.body)}`);
    assert.ok(h.effects.length > 0, kind);
    for (const e of h.effects) assert.ok(JSON.stringify(e.args).includes(HOME.B), `${kind} acted on B's dev-b: ${JSON.stringify(e)}`);
    if (kind === 'start' || kind === 'restart') assert.equal(h.effects[0].args[0].workspaceDir, B);
    // Another deployment of the same view does not hold it.
    h.reset();
    const other = await h.request({ url: `/api/${kind}/dev-b?ws=${enc(A)}&home=${enc(HOME.B)}`, method, body });
    assert.equal(other.status, 404, `${kind} under A`);
    assert.deepEqual(h.effects, [], kind);
  }
});

test('a view id never resolves a row on the body-addressed families: no workspace, no rows, nothing runs', async () => {
  const h = await harness();
  for (const [path, body] of bodies) {
    for (const ws of [V_OATS, V_LAB]) {
      h.reset();
      const r = await h.request({ url: `${path}?ws=${enc(ws)}`, method: 'POST', body });
      assert.deepEqual(h.contexts.map(c => [c.workspace, c.homes]), [[null, []]], `${path} ${ws}`);
      assert.deepEqual(h.effects, [], path);
      assert.notEqual(r.body.status, 'available', path);
      assert.equal(r.body.found ?? null, null, `${path}: the paste finds nothing`);
    }
  }
  for (const [path, body, route] of homed) {
    h.reset();
    const r = await h.request({ url: `${path}?ws=${enc(V_OATS)}`, method: 'POST', body: body(HOME.B) });
    assert.equal(r.status, 409, path);
    assert.equal(r.body.code, 'E_WORKSPACE_UNKNOWN', path);
    assert.deepEqual(h.contexts, [{ route, workspace: null, homes: [] }], path);
    assert.deepEqual(h.effects, [], path);
  }
});

test('the row\'s deployment id resolves the body-addressed families inside that deployment only', async () => {
  const h = await harness();
  for (const [path, body] of bodies) {
    h.reset();
    await h.request({ url: `${path}?ws=${enc(B)}`, method: 'POST', body });
    assert.deepEqual(h.contexts.map(c => [c.workspace, c.homes]), [[B, [HOME.B]]], `${path}: B's own rows, never the view's union`);
    for (const e of h.effects) assert.ok(JSON.stringify(e.args).includes(HOME.B), `${path}: ${JSON.stringify(e)}`);
  }
  h.reset();
  assert.equal((await h.request({ url: `/api/instance-review-threads?ws=${enc(B)}`, method: 'POST', body: bodies[5][1] })).body.found, HOME.B);
  assert.equal((await h.request({ url: `/api/instance-review-threads?ws=${enc(A)}`, method: 'POST', body: bodies[5][1] })).body.found, null,
    'A does not hold B\'s instance');
  // Readiness dispatches for the row in its deployment, and refuses it under another deployment of the view.
  h.reset();
  const ok = await h.request({ url: `/api/workspace-readiness?ws=${enc(B)}`, method: 'POST', body: bodies[1][1] });
  assert.deepEqual(h.effects.map(e => e.kind), ['readiness'], JSON.stringify(ok.body));
  h.reset();
  const elsewhere = await h.request({ url: `/api/workspace-readiness?ws=${enc(A)}`, method: 'POST', body: bodies[1][1] });
  assert.deepEqual(h.effects, []);
  assert.notEqual(elsewhere.body.status, 'available');
  // A remote deployment's rows are its own.
  h.reset();
  await h.request({ url: `/api/instance-lifecycle?ws=${enc(R)}`, method: 'POST', body: bodies[0][1] });
  assert.deepEqual(h.contexts.map(c => [c.workspace, c.homes]), [[R, [HOME.R]]]);
});

test('a home names an instance: only its own deployment admits it (never a view, never a sibling deployment)', async () => {
  const h = await harness();
  for (const [path, body, route] of homed) {
    h.reset();
    const r = await h.request({ url: `${path}?ws=${enc(B)}`, method: 'POST', body: body(HOME.B) });
    assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`);
    assert.deepEqual(h.contexts, [{ route, workspace: B, homes: [HOME.B] }], `${path}: B's own rows`);
    assert.equal(h.effects.length, 1, path);
    assert.ok(JSON.stringify(h.effects[0].args).includes(HOME.B), path);
    // B's home under A (local sibling) or under R (remote sibling) of the same view: not admitted, nothing runs.
    for (const ws of [A, R]) {
      h.reset();
      const refused = await h.request({ url: `${path}?ws=${enc(ws)}`, method: 'POST', body: body(HOME.B) });
      assert.equal(refused.status, 409, `${path} under ${ws}`);
      assert.deepEqual(h.effects, [], `${path} under ${ws}`);
    }
    // A remote row's home under a local deployment of its view: not admitted (it would run on the wrong machine).
    h.reset();
    assert.equal((await h.request({ url: `${path}?ws=${enc(A)}`, method: 'POST', body: body(HOME.R) })).status, 409, path);
    assert.deepEqual(h.effects, [], path);
  }
});

test('served selectors are view ids and deployment ids; a deployment id survives the proxy, a view id is still refused by the server', async () => {
  const h = await harness();
  const panel = h.views.panelData();
  const served = servedSelectors(panel.workspaces);
  assert.deepEqual([...served].sort(), [V_OATS, V_LAB, L, A, B, R, V].sort());
  for (const id of [A, B, R, V]) {
    for (const path of ['/api/brain/dev', '/api/instance-lifecycle', '/api/workspace-readiness', '/api/instance-git', '/api/instance-events']) {
      assert.equal(apiUrl(`${path}?ws=${enc(id)}`, V_OATS, served).searchParams.get('ws'), id, `${path} ${id}`);
    }
  }
  assert.equal(apiUrl(`/api/instance-lifecycle?ws=${enc('/elsewhere')}`, V_OATS, served).searchParams.get('ws'), V_OATS, 'an unlisted id is rewritten');
  // The view id is in the set, so the proxy keeps it — and the server still refuses it on every instance route.
  const kept = apiUrl(`/api/instance-lifecycle?ws=${enc(V_OATS)}`, B, served);
  assert.equal(kept.searchParams.get('ws'), V_OATS);
  h.reset();
  await h.request({ url: `${kept.pathname}${kept.search}`, method: 'POST', body: bodies[0][1] });
  assert.deepEqual(h.contexts.map(c => c.workspace), [null]);
  // Through the proxy, a view id addressed by path to the agent's brain is kept as it is on the body-addressed families.
  assert.equal(apiUrl(`/api/brain/dev?ws=${enc(V_OATS)}`, B, served).searchParams.get('ws'), V_OATS);
  // A path-addressed instance route: the server refuses the view id at instance resolution and runs nothing.
  const start = apiUrl(`/api/start/dev-b?ws=${enc(V_OATS)}&home=${enc(HOME.B)}`, B, served);
  assert.equal(start.searchParams.get('ws'), V_OATS);
  const refused = await h.request({ url: `${start.pathname}${start.search}`, method: 'POST', body: {} });
  assert.equal(refused.status, 404);
  assert.equal(refused.body.error, 'unknown instance "dev-b"', 'refused at instance resolution, not as an unknown route');
  assert.deepEqual(h.effects, []);
  assert.equal(servedSelectors(undefined).size, 0);
  assert.deepEqual([...servedSelectors([{ id: 'ws:x', deployments: ['/a', '', 3, null] }, { id: '' }, null])], ['ws:x', '/a']);
});

test('no ?ws= never defaults to a deployment on capabilities, launch configurations or schedules (a mutation names its workspace)', async () => {
  const h = await harness();
  const deploymentLevel = [
    ['/api/capabilities', { action: 'inspect', selector: { soul: 'dev', agentsRoot: `${A}/agents` } }, 'capabilities'],
    ['/api/launch-configs', { action: 'list' }, 'launch-configs'],
    ['/api/schedules', { operation: 'remove', id: 'daily' }, 'schedules'],
  ];
  for (const [path, body, route] of [...deploymentLevel, ...homed.map(([p, b, r]) => [p, b(HOME.A), r])]) {
    h.reset();
    const r = await h.request({ url: path, method: 'POST', body });
    assert.equal(r.status, 409, `${path} ${JSON.stringify(body)}`);
    assert.equal(r.body.code, 'E_WORKSPACE_UNKNOWN', path);
    assert.deepEqual(h.contexts, [{ route, workspace: null, homes: [] }], path);
    assert.deepEqual(h.effects, [], path);
  }
});
