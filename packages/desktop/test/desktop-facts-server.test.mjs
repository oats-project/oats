// Desktop facts (feature desktop-facts, kernel #217) reach the renderer: the server's
// projections keep them, bounded, when the kernel reports them, and add nothing when it
// does not. Kernel captures: test/fixtures/workspace-v2/desktop-facts (main a0dfe761,
// scratch Northwind; campaign-writer disabled in oats-local.yaml; release-manager spawned
// --model fixture-model --no-launch). Local repositories, so every url is null.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { dirname, resolve } from 'node:path';
import * as remote from '../../client/remote-roster.mjs';
import { soulRows } from '../../client/soul-rows.mjs';
import { soulsData, capabilitiesData, workspaceStatusData, deploymentStatusData, SESSION_ENDS } from '../../client/deployment-data.mjs';
import { rosterRows, kernelLiveness, livenessInput, livenessAnswers, panelInstance, panelInstances, pendingEntry, failedEntry, observedEntry } from '../../client/deployment-panel.mjs';
import { panelData } from '../../client/panel-views.mjs';
import { createRemoteIdentityStore } from '../server/remote-identity.mjs';
import { DESKTOP_TERMS } from '../renderer/desktop-terms.mjs';
import { lostLocalHomes, localDeploymentIds } from '../../client/session-resume-trigger.mjs';
import { loadViews, identity as viewIdentity, observed as viewObserved, row as viewRow, remoteRow as viewRemoteRow, group as viewGroup, A as VA, B as VB, V_OATS } from './helpers/workspace-views-fixture.mjs';

const fx = name => JSON.parse(readFileSync(new URL(`./fixtures/workspace-v2/desktop-facts/${name}.json`, import.meta.url), 'utf8'));
const old = name => JSON.parse(readFileSync(new URL(`./fixtures/workspace-v2/${name}.json`, import.meta.url), 'utf8'));
const DEPLOYMENT = '/fixture/base/northwind-workspace';
const source = readFileSync(new URL('../server/oats-web.mjs', import.meta.url), 'utf8');

test('the capture is a desktop-facts kernel', () => {
  assert.ok(fx('version').features.includes('desktop-facts'));
});

test('souls: spawnable + problem and the soul file; the kernel\'s harness default is not kept', () => {
  const souls = Object.fromEntries(soulsData(fx('souls')).souls.map(s => [s.name, s]));
  assert.deepEqual([souls['campaign-writer'].spawnable, souls['campaign-writer'].problem.code], [false, 'E_SOUL_DISABLED']);
  assert.match(souls['campaign-writer'].problem.message, /souls\.disabled/);
  const rm = souls['release-manager'];
  assert.deepEqual([rm.spawnable, rm.problem], [true, null]);
  for (const key of ['harness', 'model', 'harnessFrom']) assert.equal(Object.hasOwn(rm, key), false, `${key}: the kernel default is not the soul's choice`);
  assert.deepEqual(rm.file, { path: 'souls/release-manager/soul.yaml', url: null });
  const before = soulsData(fx('souls-before-disable')).souls.find(s => s.name === 'campaign-writer');
  assert.deepEqual([before.spawnable, before.problem], [true, null], 'the same soul, before this machine disabled it');
});

test('capabilities: description, what it provides, the manifest file and the member fingerprint', () => {
  const caps = Object.fromEntries(capabilitiesData(fx('capabilities')).capabilities.map(c => [c.name, c]));
  const member = caps['nw-release-tooling'], pkg = caps['nw-deploy'];
  assert.match(member.description, /release checklist/);
  assert.deepEqual([member.skills, member.commands, member.hooks], [['cut-release'], ['cut', 'verify'], []]);
  assert.deepEqual(member.file, { path: 'capabilities/nw-release-tooling/oats.json', url: null });
  assert.match(member.tree, /^[0-9a-f]{40}$/);
  assert.equal(pkg.kind, 'package'); assert.equal(pkg.tree, null, 'a package\'s fingerprint is its lock integrity');
  assert.deepEqual(pkg.commands, ['apply', 'plan']);
});

test('workspace status: the workspace file, member links, latest, defaults, clones, disabled souls and the lock', () => {
  const w = workspaceStatusData(fx('workspace-status'), DEPLOYMENT);
  assert.deepEqual(w.workspace.file, { path: 'oats-workspace.yaml', url: null });
  assert.deepEqual([w.members[0].url, w.members[0].membershipFile], [null, { path: 'oats-membership.yaml', url: null }]);
  assert.equal(w.packages[0].latest, null, 'a git: package has no catalog latest');
  assert.deepEqual(w.defaults.slots, { knowledge: { name: 'oats.okf', from: 'package' }, messaging: 'none', tasks: 'none' });
  assert.ok(w.defaults.capabilities.some(c => c.name === 'nw-house-style' && c.off === false));
  assert.ok(Array.isArray(w.defaults.byTeam.engineering.capabilities));
  assert.deepEqual(w.clones[0], { key: w.clones[0].key, name: 'agents', path: `${DEPLOYMENT}/agents-repo`, rule: 'convention' });
  assert.deepEqual(w.disabledSouls, ['campaign-writer']);
  assert.deepEqual(w.lock, { path: `${DEPLOYMENT}/oats-lock.json`, lockfileVersion: 3 });
  // An older kernel's status carries none of them: nothing is invented.
  const before = workspaceStatusData(old('f2/workspace-status'), '/fixture/base/northwind-workspace');
  for (const key of ['defaults', 'clones', 'disabledSouls', 'lock']) assert.equal(Object.hasOwn(before, key), false, key);
  assert.equal(Object.hasOwn(before.workspace, 'file'), false);
});

test('a malformed fact fails the read like any other protocol breach (bounded, never passed raw)', () => {
  const doc = fx('workspace-status');
  for (const change of [d => d.result.clones[0].rule = 'guess', d => d.result.clones[0].path = 'relative', d => d.result.lock.lockfileVersion = '3',
    d => d.result.defaults.slots.knowledge = { name: 1 }, d => d.result.workspace.file = 'oats-workspace.yaml']) {
    const bad = structuredClone(doc); change(bad);
    assert.throws(() => workspaceStatusData(bad, DEPLOYMENT), { code: 'E_CLI_PROTOCOL' });
  }
  const souls = structuredClone(fx('souls')); souls.result.souls[0].spawnable = 'no';
  assert.throws(() => soulsData(souls), { code: 'E_CLI_PROTOCOL' });
});

test('status → /api/panel: startedAt, modelFrom and identityAddress travel with the instance', () => {
  const roster = deploymentStatusData(fx('status'), DEPLOYMENT);
  const row = roster.agents.flatMap(a => a.instances)[0];
  assert.deepEqual([row.startedAt, row.modelFrom, row.identityAddress, row.model], [null, 'spawn', null, 'fixture-model']);
  const project = panelInstance;
  const panel = project({ ...row, agentsRoot: roster.root });
  assert.deepEqual([panel.startedAt, panel.modelFrom, panel.identityAddress], [null, 'spawn', null]);
  const legacy = project({ ...row, agentsRoot: roster.root, startedAt: undefined, modelFrom: undefined, identityAddress: undefined });
  for (const key of ['startedAt', 'modelFrom', 'identityAddress']) assert.equal(Object.hasOwn(legacy, key), false, `${key}: absent, not invented`);
});

test('/api/agents: spawnable + problem and file; no harness/model default', () => {
  const start = source.indexOf('function agentsData('), end = source.indexOf('/* ── Model catalog', start);
  const agentsData = new Function('deploymentFor', 'deployments', 'snapshot', 'remote', 'dirname', 'resolve', 'soulRows',
    `const held = () => null, DESKTOP_TERMS = null; ${source.slice(start, end)}; return agentsData;`);
  const roster = deploymentStatusData(fx('status'), DEPLOYMENT), catalog = soulsData(fx('souls'));
  const snapshot = { byWs: new Map([[DEPLOYMENT, { deployment: { status: 'observed', root: roster.root, souls: roster.agents.map(({ instances: _i, ...s }) => s),
    catalog: { souls: catalog.souls, ambiguous: [], reason: null } } }]]) };
  const ws = { id: DEPLOYMENT, name: 'northwind', roots: [roster.root] };
  const rows = Object.fromEntries(agentsData(() => ws, () => [ws], snapshot, remote, dirname, resolve, soulRows)().agents.map(a => [a.name, a]));
  const rm = rows['release-manager'], cw = rows['campaign-writer'];
  for (const key of ['spawnDefault', 'harness', 'model', 'harnessFrom']) assert.equal(Object.hasOwn(rm, key), false, key);
  assert.deepEqual([rm.spawnable, rm.problem, cw.spawnable, cw.problem.code], [true, null, false, 'E_SOUL_DISABLED']);
  assert.deepEqual(rm.file, { path: 'souls/release-manager/soul.yaml', url: null });
  // An older kernel's catalog rows: no facts, no keys.
  const older = soulsData(old('f3/souls')).souls;
  const snap2 = { byWs: new Map([[DEPLOYMENT, { deployment: { ...snapshot.byWs.get(DEPLOYMENT).deployment, catalog: { souls: older, ambiguous: [], reason: null } } }]]) };
  const legacy = agentsData(() => ws, () => [ws], snap2, remote, dirname, resolve, soulRows)().agents[0];
  for (const key of ['spawnable', 'problem', 'file']) assert.equal(Object.hasOwn(legacy, key), false, key);
});

/* Needs input (Spec D, PR K): `waitingOnYou` on a status row is validated, never fatal, and reaches /api/panel
   only when the local CLI advertises waiting-on-you. */
const claim = { since: '2026-10-03T10:00:00.000Z', producer: 'claude-hook', reason: 'permission', message: 'Allow Bash?' };
const withClaim = value => { const doc = structuredClone(fx('status')); doc.agents.find(a => a.instances.length).instances[0].waitingOnYou = value; return doc; };
const firstRow = doc => deploymentStatusData(doc, DEPLOYMENT).agents.flatMap(a => a.instances)[0];

test('status: a valid waitingOnYou passes validated, an invalid one becomes null without failing the roster, absence stays absent', () => {
  assert.deepEqual(firstRow(withClaim({ ...claim, extra: 'ignored' })).waitingOnYou, claim);
  for (const bad of [{ ...claim, since: 'yesterday' }, { ...claim, producer: 'https://evil.example/x' }, { ...claim, producer: '' }, 'waiting', 7, [claim]]) {
    assert.equal(firstRow(withClaim(bad)).waitingOnYou, null, JSON.stringify(bad));
  }
  assert.equal(firstRow(withClaim(null)).waitingOnYou, null, 'null stays null (unknown)');
  assert.equal(firstRow(withClaim({ ...claim, message: 'two\nlines' })).waitingOnYou.message, null, 'a malformed note keeps the claim');
  assert.equal(Object.hasOwn(firstRow(fx('status')), 'waitingOnYou'), false, 'a status without the field adds nothing');
});

/** The server's own observeDeployment over a roster of `instances` (one row, or several), read under a CLI with
 * `features`; resolves the first projected row, or every row when `instance` is an array. `collected` gets each
 * input the collector double was given. */
function observeWith(features, instance, collected = []) {
  const fn = name => { const found = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`)); assert.ok(found, name); return found[0]; };
  const instances = Array.isArray(instance) ? instance : [instance];
  const roster = { root: '/d/agents', agents: [{ name: 'dev', description: '', team: null, instances }], withheld: [] };
  const context = {
    snapshot: { byWs: new Map() }, cliState: { probedAt: 1, features }, admitted: new Set(['/d']), BACKGROUND_MAX_AGE: 60, observing: new Set(), beginObserving() {}, endObserving() {},
    soulCatalog: { prefetch() {}, settle: () => ({ entry: null, pending: null }) }, capabilityCatalog: { prefetch() {}, ensure() {} },
    deploymentObserver: { observe: async () => ({ ok: true, roster, workspaceStatus: { workspace: {} }, observedAt: '2026-10-03T10:00:00.000Z' }) },
    soulCatalogKey: () => null, catalogProjection: () => null, attachCatalog() {},
    // The shared home's functions, as the server imports them; the collector is a double that prints its answers.
    rosterRows, kernelLiveness, livenessInput, livenessAnswers, panelInstances, pendingEntry, failedEntry, observedEntry,
    runLivenessCollector: async input => { collected.push(input); return JSON.stringify(input.map(() => ({ running: true, runtimeState: 'running', tmux: null }))); }, Date, String,
  };
  const run = runInNewContext(`${fn('observeDeployment')}\nobserveDeployment`, context);
  return run('/d').then(entry => { const rows = JSON.parse(JSON.stringify(entry)).instances; return Array.isArray(instance) ? rows : rows[0]; });
}

test('observeDeployment keeps waitingOnYou only when the CLI advertises waiting-on-you (feature, never version)', async () => {
  const instance = { instance: 'dev-a', agent: 'dev', home: '/d/agents/dev/instances/dev-a', waitingOnYou: claim };
  assert.deepEqual((await observeWith(['desktop-facts', 'waiting-on-you'], instance)).waitingOnYou, claim);
  assert.equal(Object.hasOwn(await observeWith(['desktop-facts'], instance), 'waitingOnYou'), false, 'pre-feature kernel: dropped');
  assert.equal(Object.hasOwn(await observeWith(undefined, instance), 'waitingOnYou'), false, 'no feature list: dropped');
  const { waitingOnYou: _w, ...bare } = instance;
  assert.equal(Object.hasOwn(await observeWith(['waiting-on-you'], bare), 'waitingOnYou'), false, 'absent is never synthesized');
});

/* D10, kernel feature status-liveness: the kernel's status rows are the complete local liveness reading. The server's
   own observeDeployment then runs no collector child and keeps each row's running, runtimeState, runtimeError and tmux
   as the kernel reported them; without the feature the collector runs as before. Feature, never version. */
test('observeDeployment under status-liveness runs no collector and keeps the kernel\'s liveness; without it the collector runs', async () => {
  const home = name => `/d/agents/dev/instances/${name}`;
  const kernelRows = [
    { instance: 'up', agent: 'dev', home: home('up'), running: true, runtimeState: 'running', tmux: { session: 'oats', window: 'up', socket: '/x/tmux.sock' } },
    { instance: 'down', agent: 'dev', home: home('down'), running: false, runtimeState: 'stopped', tmux: { session: 'oats', window: 'down' } },
    { instance: 'unknown', agent: 'dev', home: home('unknown'), running: null, runtimeState: 'unreachable', runtimeError: 'error connecting to /x/tmux.sock', tmux: { session: 'oats', window: 'unknown', socket: '/x/tmux.sock' } },
    // A home with no tmux record: nothing fills one in.
    { instance: 'bare', agent: 'dev', home: home('bare'), running: false, runtimeState: 'stopped' },
  ];
  const liveness = rows => Object.fromEntries(rows.map(r => [r.instance, [r.running, r.runtimeState, r.runtimeError, r.runtimeErrorOrigin, r.tmux]]));
  for (const features of [['status-liveness'], ['desktop-facts', 'waiting-on-you', 'status-liveness']]) {
    const collected = [], rows = await observeWith(features, kernelRows, collected);
    assert.deepEqual(collected, [], `${features}: no collector child`);
    assert.deepEqual(liveness(rows), {
      up: [true, 'running', undefined, undefined, { session: 'oats', window: 'up', socket: '/x/tmux.sock' }],
      down: [false, 'stopped', undefined, undefined, { session: 'oats', window: 'down' }],
      unknown: [null, 'unreachable', 'error connecting to /x/tmux.sock', 'kernel', { session: 'oats', window: 'unknown', socket: '/x/tmux.sock' }],
      bare: [false, 'stopped', undefined, undefined, undefined],
    }, `${features}: the kernel's rows, as reported`);
    assert.equal(Object.hasOwn(rows.find(r => r.instance === 'bare'), 'tmux'), false, `${features}: no tmux record stays without one`);
    assert.ok(rows.every(r => r.runtimeErrorOrigin !== 'terminal-probe'), `${features}: no terminal-probe origin`);
  }
  // Without the feature (a pre-feature list, an older kernel's, none at all) the collector runs over every row, as today.
  for (const features of [['desktop-facts', 'waiting-on-you'], [], undefined]) {
    const collected = [], rows = await observeWith(features, kernelRows, collected);
    assert.deepEqual(collected.map(input => input.map(i => i.instance)), [['up', 'down', 'unknown', 'bare']], `${features}: one collector run`);
    assert.deepEqual(rows.map(r => [r.instance, r.running]).sort(), [['bare', true], ['down', true], ['unknown', true], ['up', true]], `${features}: the double's answers merged`);
  }
  // The gate reads the feature list only: a version, or the name somewhere else, is not the feature.
  for (const cli of [{ version: '99.0.0' }, { features: 'status-liveness' }, { features: ['status-liveness-v2'] }, null, undefined]) assert.equal(kernelLiveness(cli), false, JSON.stringify(cli));
  assert.equal(kernelLiveness({ features: ['status-liveness'] }), true);
});

/* Session resume: `sessionEnd` on a status row is one of SESSION_ENDS exactly, dropped otherwise without failing
   the roster, and reaches /api/panel's instance rows, where the shared resume trigger reads it. */
const ENDS = Object.values(SESSION_ENDS);
const withEnd = value => { const doc = structuredClone(fx('status')); doc.agents.find(a => a.instances.length).instances[0].sessionEnd = value; return doc; };

test('status: sessionEnd is kept when one of SESSION_ENDS; any other value is dropped, never fatal; absence stays absent', () => {
  assert.deepEqual(SESSION_ENDS, { lost: 'lost', stopped: 'stopped', exited: 'exited' });
  assert.ok(Object.isFrozen(SESSION_ENDS));
  for (const end of ENDS) assert.equal(firstRow(withEnd(end)).sessionEnd, end, end);
  for (const bad of ['LOST', 'lost ', 'crashed', '', null, true, 1, ['lost'], { lost: true }]) {
    const row = firstRow(withEnd(bad));
    assert.equal(Object.hasOwn(row, 'sessionEnd'), false, JSON.stringify(bad));
    assert.equal(row.instance, firstRow(fx('status')).instance, 'the row is kept');
  }
  assert.equal(Object.hasOwn(firstRow(fx('status')), 'sessionEnd'), false, 'a status without the field adds nothing');
});

test('status → /api/panel: sessionEnd travels with the instance; absent stays absent', async () => {
  const roster = deploymentStatusData(withEnd(SESSION_ENDS.lost), DEPLOYMENT);
  const row = roster.agents.flatMap(a => a.instances)[0];
  assert.equal(panelInstance({ ...row, agentsRoot: roster.root }).sessionEnd, SESSION_ENDS.lost);
  // Through the server's own observeDeployment, as /api/panel serves its entry.
  const instance = { instance: 'dev-a', agent: 'dev', home: '/d/agents/dev/instances/dev-a' };
  for (const end of ENDS) assert.equal((await observeWith(['desktop-facts'], { ...instance, sessionEnd: end })).sessionEnd, end, end);
  const bare = await observeWith(['desktop-facts'], instance);
  assert.equal(Object.hasOwn(bare, 'sessionEnd'), false, 'absent is never synthesized');
  // And /api/panel's answer (panel-views.mjs panelData, the route's call) over that entry keeps it on the row.
  const lost = await observeWith(['desktop-facts'], { ...instance, sessionEnd: SESSION_ENDS.lost });
  const store = createRemoteIdentityStore({ file: null });
  const held = { ctxs: ['/d'], snapshot: { byWs: new Map([['/d', { deployment: { status: 'observed', root: '/d/agents', withheld: [] }, instances: [lost, { ...bare, instance: 'dev-b' }],
    generatedAt: '2026-10-03T10:00:00.000Z', observedAt: '2026-10-03T10:00:00.000Z' }]]) }, remoteGroups: [],
    remembered: { get: id => store.get(id), note: id => store.note(id), all: () => store.all(), observe() {} },
    rosterAnswered: true, rosterFailure: null, cli: { ok: true, bin: '/oats', features: [] }, observing: new Set(), remoteCollecting: false, home: '/h', at: '2026-10-03T10:00:00.000Z' };
  assert.match(source, /path === "\/api\/panel"\) return send\(res, 200, panelData\(held\(\), asked, DESKTOP_TERMS\)\)/, 'the route serves panelData');
  const rows = panelData(held, '/d', DESKTOP_TERMS).instances;
  assert.deepEqual(rows.map(r => [r.instance, r.sessionEnd]), [['dev-a', SESSION_ENDS.lost], ['dev-b', undefined]]);
  assert.equal(Object.hasOwn(rows[1], 'sessionEnd'), false);
});

test('end to end: a lost row of a local deployment, through the real readers and panelData, is named by lostLocalHomes with the reply\'s local ids; a remote deployment\'s lost row, a running or a not-lost row is not', () => {
  /** The oats view as /api/panel serves it (panelData over the server's held, helpers/workspace-views-fixture.mjs): local A,
   * whose rows are the status fixture read by the real readers (deploymentStatusData → rosterRows) with its instance's
   * sessionEnd and running set, local B, and the remote devbox whose row also reads lost. */
  const FAR = '/home/alex/oats';
  const panelOf = (sessionEnd, running) => {
    const raw = JSON.stringify(fx('status')), captured = dirname(fx('status').root);
    const doc = JSON.parse(raw.split(captured).join(VA)), instance = doc.agents.find(a => a.instances.length).instances[0];
    Object.assign(instance, { sessionEnd, running });
    const rows = rosterRows(deploymentStatusData(doc, VA), { features: [] });
    const far = viewGroup('devbox:a1', 'devbox', FAR, viewIdentity(), [viewRemoteRow('far-a', FAR, { sessionEnd: SESSION_ENDS.lost, running: false })]);
    const byWs = new Map([[VA, viewObserved(VA, { reachable: true, ...viewIdentity() }, rows)], [VB, viewObserved(VB, { reachable: true, ...viewIdentity() }, [viewRow(VB, 'dev-b')])]]);
    return loadViews({ ctxs: [VA, VB], snapshot: { byWs }, remoteGroups: [far] }).panelData(V_OATS);
  };
  const panel = panelOf(SESSION_ENDS.lost, false), ids = localDeploymentIds(panel);
  assert.deepEqual(panel.deployments.map(d => [d.id, d.local]), [[VA, true], [VB, true], ['remote:devbox:a1', false]]);
  assert.deepEqual(ids, [VA, VB]);
  const local = panel.instances.find(i => i.deployment.id === VA), far = panel.instances.find(i => i.deployment.id === 'remote:devbox:a1');
  assert.equal(local.sessionEnd, SESSION_ENDS.lost);
  assert.equal(far.sessionEnd, SESSION_ENDS.lost, 'the remote row reads lost too');
  assert.deepEqual(lostLocalHomes(panel.instances, ids), [local.home], 'only the local deployment\'s home');
  assert.deepEqual(lostLocalHomes(panel.instances), [], 'no local ids: nothing is local');
  assert.deepEqual(lostLocalHomes(panel.instances, [VA, VB, 'remote:devbox:a1']), [local.home, far.home], 'the id is the one rule');
  // A running or not-lost local row is not named; nor is an out-of-contract value, which the reader drops.
  assert.deepEqual(lostLocalHomes(panelOf(SESSION_ENDS.lost, true).instances, ids), [], 'lost but running');
  for (const end of [SESSION_ENDS.stopped, SESSION_ENDS.exited, undefined, 'crashed']) {
    const p = panelOf(end, false);
    assert.deepEqual(lostLocalHomes(p.instances, localDeploymentIds(p)), [], String(end));
  }
});
