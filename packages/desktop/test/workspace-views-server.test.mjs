// The server's workspace views (#482): packages/client/panel-views.mjs, called as server/oats-web.mjs calls it
// (its own `held`, the Desktop's terms) over held observations (no CLI). Views, the union panel, addressing helpers, remembered identities,
// team members and the forge roster's context.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteIdentityStore } from '../server/remote-identity.mjs';
import { CLI, loadViews, alex, alexState, identity, row, observed, unavailable, tag, OATS, LAB, WEB, A, B, L, R, V, V_OATS, V_LAB, V_WEB } from './helpers/workspace-views-fixture.mjs';

test('one workspace on three deployments: one view, the union of rows each tagged with its deployment, primary the first local', () => {
  const { views } = alex({ observing: new Set([B]) });
  const p = views.panelData(V_OATS);
  assert.deepEqual(p.workspace, { id: V_OATS, name: 'oats', team: null, primary: A, key: OATS, teamId: 'aweb:oats' });
  assert.deepEqual(p.instances.map(i => [i.instance, i.deployment]), [
    ['dev-a', tag(A, 'This Mac', A)], ['idle', tag(A, 'This Mac', A)], ['dev-b', tag(B, 'This Mac', B)], ['far-a', tag(R, 'devbox', '/home/alex/oats')]]);
  assert.equal(p.instances[3].server, 'devbox', 'a remote row keeps its remote fields');
  assert.equal(p.instances[3].home, '/home/alex/oats/agents/dev/instances/far-a');
  assert.deepEqual(p.deployments, [
    { ...tag(A, 'This Mac', A), label: '~/Agents/oats', local: true, reachable: true, identityFrom: 'reported', primary: true },
    { ...tag(B, 'This Mac', B), label: '~/example/oats-qa', local: true, reachable: true, identityFrom: 'reported', primary: false },
    { ...tag(R, 'devbox', '/home/alex/oats'), label: '~/oats', local: false, reachable: true, identityFrom: 'reported', primary: false },
  ]);
  // Header, stamps and error are the PRIMARY deployment's; running counts the union; refreshing is any.
  const a = observed(A);
  assert.equal(p.generatedAt, a.generatedAt);
  assert.equal(p.observedAt, a.observedAt);
  assert.equal(p.deployment.root, `${A}/agents`);
  assert.equal(Object.hasOwn(p.deployment, 'souls') || Object.hasOwn(p.deployment, 'catalogKey'), false, 'the private soul rows stay server-side');
  assert.equal(p.running, 3);
  assert.equal(p.refreshing, true);
  assert.equal(alex().views.panelData(V_OATS).refreshing, false);
});

test('a deployment id answers its view (a saved selection migrates); an unattached deployment is its own view; unknown answers nothing', () => {
  const { views } = alex();
  for (const id of [A, B, R]) assert.equal(views.panelData(id).workspace.id, V_OATS, id);
  assert.equal(views.panelData().workspace.id, V_OATS, 'no selector: the first view');
  const loose = views.panelData(L);
  assert.deepEqual(loose.workspace, { id: L, name: 'loose', team: null, primary: L });
  assert.deepEqual(loose.deployments, [{ ...tag(L, 'This Mac', L), label: '~/loose', local: true, reachable: false, identityFrom: null, primary: true,
    reason: 'E_CLI_FAILED: boom', short: 'Not observed' }]);
  assert.deepEqual(loose.deployment, unavailable().deployment);
  const lab = views.panelData(V_LAB);
  assert.deepEqual(lab.workspace, { id: V_LAB, name: 'lab', scope: '/srv/lab', team: null, server: 'laptop', remote: true, registrationPresent: true,
    primary: V, key: LAB, teamId: 'aweb:lab' }, 'a remote-only view keeps the remote fields');
  assert.deepEqual(lab.instances.map(i => [i.instance, i.deployment]), [['lab-a', tag(V, 'laptop', '/srv/lab')]]);
  for (const id of ['ws:0000000000000000000a', '/nope', 'remote:nope:1']) {
    assert.equal(views.isServed(id), false, id);
    const none = views.panelData(id);
    assert.equal(none.workspace, null);
    assert.deepEqual(none.deployments, []);
    assert.deepEqual(none.instances, []);
  }
  for (const id of [V_OATS, V_LAB, A, B, L, R, V]) assert.equal(views.isServed(id), true, id);
});

test('the switcher lists views with their deployments; unattached ones last, marked, with their reason', () => {
  const { views } = alex();
  const choices = views.panelData(V_OATS).workspaces;
  assert.deepEqual(choices, [
    { id: V_OATS, name: 'oats', team: null, deployments: [A, B, R], key: OATS,
      deploymentLabels: ['This Mac · ~/Agents/oats', 'This Mac · ~/example/oats-qa', 'devbox · ~/oats'], machines: ['This Mac', 'devbox'], notLive: 0, waiting: false },
    { id: V_LAB, name: 'lab', team: null, deployments: [V], key: LAB, server: 'laptop', remote: true, deploymentLabels: ['laptop · /srv/lab'], machines: ['laptop'], notLive: 0, waiting: false },
    { id: L, name: 'loose', team: null, deployments: [L], unattached: true, reason: 'E_CLI_FAILED: boom', short: 'Not observed', deploymentLabels: ['This Mac · ~/loose'],
      machines: ['This Mac'], notLive: 1, waiting: false },
  ]);
  assert.deepEqual(views.workspaceChoices(), choices);
});

test('deployment-level surfaces read the view\'s primary; an instance-addressed body never resolves through a view id', () => {
  const { views } = alex();
  assert.deepEqual(views.deploymentFor(V_OATS), { id: A, name: 'oats', scope: A, team: null, roots: [`${A}/agents`] });
  assert.equal(views.deploymentFor(B).id, B, 'a deployment id is itself');
  assert.equal(views.deploymentFor(R).id, R);
  assert.equal(views.deploymentFor(R).remote, true);
  assert.equal(views.deploymentFor(V_LAB).id, V, 'a remote-only view\'s primary is its remote');
  assert.equal(views.deploymentFor(L).id, L);
  assert.equal(views.deploymentFor(undefined).id, A, 'no selector: the first view\'s primary');
  assert.equal(views.deploymentFor('ws:0000000000000000000a'), null);
  const home = `${A}/agents/dev/instances/dev-a`;
  assert.equal(views.surfaceDeployment(V_OATS, { selector: { home } }), undefined, 'a view id never addresses an instance');
  assert.equal(views.surfaceDeployment(V_OATS, { spec: { home } }), undefined);
  assert.equal(views.surfaceDeployment(V_OATS, { selector: { home: undefined } }).id, A, 'an absent home is deployment-level');
  assert.equal(views.surfaceDeployment(A, { selector: { home } }).id, A);
  assert.equal(views.surfaceDeployment(R, { spec: { home: '/home/alex/oats/agents/dev/instances/far-a' } }).id, R);
  assert.equal(views.surfaceDeployment(V_OATS, { action: 'list' }).id, A);
  assert.deepEqual(views.deployments().map(d => d.id), [A, B, L, R, V], 'deployments() lists deployment ids only');
});

test('remembered identity: an unreached remote keeps its view, marked remembered and not reached, with its reason', () => {
  const store = createRemoteIdentityStore({ file: null });
  const { devbox } = alex();
  store.observe([devbox]);
  const down = { ...devbox, workspace: null, probe: { ok: false, error: { code: 'E_SSH', message: 'ssh to devbox.lan failed: Permission denied' } } };
  const { views } = alex({ remoteGroups: [down], remoteIdentities: store });
  const p = views.panelData(V_OATS);
  assert.deepEqual(p.deployments.map(d => d.id), [A, B, R], 'still in its view');
  assert.deepEqual(p.deployments[2], { ...tag(R, 'devbox', '/home/alex/oats'), label: '~/oats', local: false, reachable: false, identityFrom: 'remembered',
    primary: false, reason: 'devbox needs ssh to connect without a prompt; run `ssh devbox.lan` once in a terminal.', short: 'ssh needs a prompt',
    fix: ['Run `ssh devbox.lan` once in a terminal and answer its prompt (a host key or a password).', 'Desktop tries again on its next read.'] });
  assert.equal(p.instances.find(i => i.instance === 'far-a').running, null, 'its last-known rows, state unknown');
  // Without memory, the same failure is unattached.
  const forgetful = alex({ remoteGroups: [down] }).views;
  assert.deepEqual(forgetful.panelData(R).workspace.id, R);
  assert.equal(forgetful.panelData(R).deployments[0].identityFrom, null);
});

test('a fresh report with another identity moves the remote to that view, with the move noted', () => {
  const store = createRemoteIdentityStore({ file: null });
  const { devbox } = alex();
  store.observe([devbox]);
  const moved = { ...devbox, workspace: { reachable: true, ...identity(WEB, 'nw:web') } };
  store.observe([moved]);
  const { views } = alex({ remoteGroups: [moved], remoteIdentities: store });
  assert.deepEqual(views.panelData(V_OATS).deployments.map(d => d.id), [A, B]);
  const web = views.panelData(V_WEB);
  assert.equal(web.workspace.name, 'web');
  assert.deepEqual(web.deployments, [{ ...tag(R, 'devbox', '/home/alex/oats'), label: '~/oats', local: false, reachable: true, identityFrom: 'reported',
    primary: true, note: 'devbox now reports workspace web.' }]);
  assert.equal(views.panelData(R).workspace.id, V_WEB, 'its deployment id now answers the new view');
});

test('a secondary local deployment whose re-read failed keeps its view and rows: stale, not live, with the kernel\'s message', () => {
  const { state } = alexState();
  // observeDeployment kept the last observation, marked with the failure (Spec D).
  state.snapshot.byWs.set(B, { ...state.snapshot.byWs.get(B), error: 'the cache is locked', errorCause: { code: 'E_REMOTE_UNREADABLE', reason: 'cache' } });
  const views = loadViews(state), p = views.panelData(V_OATS);
  assert.deepEqual(p.deployments[1], { ...tag(B, 'This Mac', B), label: '~/example/oats-qa', local: true, reachable: true, identityFrom: 'reported', primary: false,
    stale: true, reason: 'This deployment\'s last read failed: the cache is locked. It shows what was last observed.', short: 'Last read failed' });
  assert.deepEqual(p.instances.filter(i => i.deployment.id === B).map(i => i.instance), ['dev-b'], 'its rows are held, tagged with it');
  assert.equal(Object.hasOwn(p, 'error'), false, 'the panel\'s error stays the primary\'s');
  assert.equal(p.deployments[0].stale, undefined);
  assert.equal(views.workspaceChoices()[0].notLive, 1, 'the switcher counts it not live');
  // The same failure on the primary: stale too, and the panel's error as before.
  state.snapshot.byWs.set(A, { ...state.snapshot.byWs.get(A), error: 'the cache is locked' });
  const q = loadViews(state).panelData(V_OATS);
  assert.equal(q.deployments[0].stale, true); assert.equal(q.error, 'the cache is locked');
});

test('memory never attaches a local deployment, even if its path were remembered', () => {
  const remembered = { server: 'devbox', label: 'devbox', targetKey: 'a1', path: L, workspace: identity(), reportedAt: '2026-10-02T09:00:00.000Z' };
  const leaky = { get: () => remembered, all: () => [{ id: L, ...remembered }], note: () => null };
  const { views } = alex({ remoteGroups: [], remoteIdentities: leaky });
  const p = views.panelData(L);
  assert.equal(p.workspace.id, L, 'unattached');
  assert.deepEqual(p.deployments.map(d => [d.id, d.identityFrom, d.reachable]), [[L, null, false]]);
  assert.deepEqual(views.panelData(V_OATS).deployments.map(d => d.id), [A, B]);
});

test('before any roster answer, remembered groups are not-reached deployments with no rows', () => {
  const store = createRemoteIdentityStore({ file: null });
  store.observe([alex().devbox]);
  // This computer's OATS cannot read other machines at all.
  const old = alex({ remoteGroups: [], remoteIdentities: store, rosterAnswered: false, cliState: { ...CLI, remote: [] } }).views;
  const p = old.panelData(V_OATS);
  assert.deepEqual(p.deployments.map(d => d.id), [A, B, R]);
  assert.deepEqual(p.deployments[2], { ...tag(R, 'devbox', '/home/alex/oats'), label: '~/oats', local: false, reachable: false, identityFrom: 'remembered',
    primary: false, reason: 'This computer\'s OATS can\'t read other machines; update OATS here.', short: 'OATS here can\'t read other machines',
    fix: ['Update OATS on this computer.'] });
  assert.deepEqual(p.instances.filter(i => i.deployment.id === R), [], 'no rows');
  assert.equal(old.isServed(R), true);
  // The roster read failed before answering: its failure is the reason.
  const failing = alex({ remoteGroups: [], remoteIdentities: store, rosterAnswered: false, rosterFailure: 'Remote roster unavailable: timeout' }).views;
  assert.equal(failing.panelData(V_OATS).deployments[2].reason, 'devbox was not reached: Remote roster unavailable: timeout');
  // Once a roster answer arrived, a group it no longer lists is gone.
  const answered = alex({ remoteGroups: [], remoteIdentities: store, rosterAnswered: true }).views;
  assert.deepEqual(answered.panelData(V_OATS).deployments.map(d => d.id), [A, B]);
  assert.equal(answered.isServed(R), false);
});

test('team members: the view\'s deployments only, each tagged; any view, a remote-only one included', () => {
  const { views } = alex();
  const oats = views.teamMembersFor(V_OATS);
  assert.deepEqual(oats.members.map(m => [m.instance, m.workspace, m.deployment]), [
    ['dev-a', A, tag(A, 'This Mac', A)], ['idle', A, tag(A, 'This Mac', A)], ['dev-b', B, tag(B, 'This Mac', B)], ['far-a', R, tag(R, 'devbox', '/home/alex/oats')]]);
  assert.deepEqual(oats.servers, [{ server: 'devbox', label: 'devbox', group: 'devbox:a1', deployment: R, reached: true, error: null, registered: true, features: null }]);
  assert.deepEqual(oats.notReached, []);
  assert.deepEqual(views.teamMembersFor(A), oats, 'a deployment id reads its view');
  const lab = views.teamMembersFor(V_LAB);
  assert.deepEqual(lab.members.map(m => [m.instance, m.workspace, m.server, m.team]), [['lab-a', V, 'laptop', 'aweb:lab']]);
  assert.deepEqual(views.teamMembersFor(L), { members: [], servers: [], notReached: [] });
  assert.equal(views.teamMembersFor('ws:0000000000000000000a'), null);
});

test('the forge roster\'s context: the view\'s local rows and clones, under the view id', () => {
  const { views } = alex();
  const ctx = views.viewForgeContext(V_OATS);
  assert.deepEqual(ctx.workspace, { id: V_OATS, name: 'oats', remote: false });
  assert.equal(ctx.cli, CLI);
  assert.deepEqual(ctx.instances.map(i => i.home), [`${A}/agents/dev/instances/dev-a`, `${A}/agents/dev/instances/idle`, `${B}/agents/dev/instances/dev-b`]);
  assert.deepEqual(ctx.clones.map(c => c.key), ['clone:oats', 'clone:oats-qa']);
  assert.deepEqual(views.viewForgeContext(B).workspace.id, V_OATS);
  assert.deepEqual(views.viewForgeContext(V_LAB), { workspace: { id: V_LAB, name: 'lab', remote: true }, cli: CLI, instances: [], clones: [] });
  assert.deepEqual(views.viewForgeContext('ws:0000000000000000000a'), { workspace: undefined, cli: CLI, instances: [], clones: [] });
});

test('a one-deployment view\'s panel is the pre-view panel plus `deployments` and row tags, nothing else', () => {
  const rows = [row(A, 'dev-a')];
  const views = loadViews({ ctxs: [A], snapshot: { byWs: new Map([[A, observed(A, { reachable: true, ...identity() }, rows)]]) } });
  const p = views.panelData(V_OATS);
  assert.deepEqual(Object.keys(p).sort(), ['deployment', 'deployments', 'generatedAt', 'instances', 'observedAt', 'refreshing', 'running', 'team', 'workspace', 'workspaces']);
  assert.deepEqual(Object.keys(p.workspace), ['id', 'name', 'team', 'primary', 'key', 'teamId']);
  assert.deepEqual(p.instances, rows.map(r => ({ ...r, deployment: tag(A, 'This Mac', A) })));
  assert.equal(p.deployments.length, 1);
  assert.equal(p.deployments[0].primary, true);
  assert.deepEqual(p.workspaces, [{ id: V_OATS, name: 'oats', team: null, deployments: [A], key: OATS, deploymentLabels: ['This Mac · ~/Agents/oats'], machines: ['This Mac'], notLive: 0, waiting: false }]);
  assert.equal(p.team, null);
  // An unattached one (an OATS here before workspace-identity) keeps today's id and workspace shape exactly.
  const older = loadViews({ ctxs: [A], cliState: { ...CLI, features: [] },
    snapshot: { byWs: new Map([[A, observed(A, { reachable: true }, rows)]]) } });
  const q = older.panelData(A);
  assert.deepEqual(q.workspace, { id: A, name: 'oats', team: null, primary: A });
  assert.deepEqual(Object.keys(q).sort(), Object.keys(p).sort());
  assert.deepEqual(q.deployments[0].reason, 'This computer\'s OATS is too old to report its workspace; update OATS here.');
  // Without the feature nothing can match: the entry is listed as before views, never as "not matched"
  // (the deployment's own reason above still says why).
  assert.deepEqual(q.workspaces, [{ id: A, name: 'oats', team: null, deployments: [A], deploymentLabels: ['This Mac · ~/Agents/oats'], machines: ['This Mac'], notLive: 0, waiting: false }]);
  // A kept error from a failed re-read travels on the primary's panel, as before.
  const kept = loadViews({ ctxs: [A], snapshot: { byWs: new Map([[A, { ...observed(A, { reachable: true, ...identity() }, rows), error: 'remote unreadable' }]]) } });
  assert.equal(kept.panelData(V_OATS).error, 'remote unreadable');
});

test('a local identity that deploymentStatusData marked invalid is unattached with its reason', () => {
  const views = loadViews({ ctxs: [A], snapshot: { byWs: new Map([[A, observed(A, { reachable: true, identityInvalid: true }, [])]]) } });
  const p = views.panelData(A);
  assert.equal(p.workspace.id, A);
  assert.equal(p.deployments[0].reason, 'This Mac reported a workspace this Desktop can\'t read.');
});

test('an unattached view carries the reported ref (view and switcher); a local deployment not observed says why', () => {
  const bad = { ...identity(), key: null, keyFrom: null, ref: 'git:not a repo' };
  const views = loadViews({ ctxs: [A, B], snapshot: { byWs: new Map([[A, observed(A, { reachable: true, ...bad }, [])]]) } });
  const [choice, pending] = views.workspaceChoices();
  assert.deepEqual(choice, { id: A, name: 'oats', team: null, deployments: [A], deploymentLabels: ['This Mac · ~/Agents/oats'], machines: ['This Mac'], notLive: 0, waiting: false, unattached: true, ref: 'git:not a repo',
    reason: 'This deployment\'s workspace reference (git:not a repo) isn\'t valid; fix oats-local.yaml.', short: 'Invalid workspace reference' });
  assert.equal(views.viewModel().views[0].ref, 'git:not a repo');
  assert.deepEqual(pending, { id: B, name: 'oats-qa', team: null, deployments: [B], deploymentLabels: ['This Mac · ~/example/oats-qa'], machines: ['This Mac'], notLive: 1, waiting: false, unattached: true,
    reason: 'Reading the deployment through the installed OATS CLI…', short: 'Not observed' }, 'pending: the reading sentence, no ref');
  // An observed local deployment that reports no identity (no workspace object) says so.
  const silent = loadViews({ ctxs: [A], snapshot: { byWs: new Map([[A, observed(A, undefined, [])]]) } });
  assert.equal(silent.panelData(A).deployments[0].reason, 'This deployment reports no workspace identity.');
});

test('deploymentRows: one deployment\'s own rows, never its view\'s union', () => {
  const { views } = alex();
  assert.deepEqual(views.deploymentRows(views.deploymentFor(A)).map(i => i.home), [`${A}/agents/dev/instances/dev-a`, `${A}/agents/dev/instances/idle`]);
  assert.deepEqual(views.deploymentRows(views.deploymentFor(B)).map(i => i.home), [`${B}/agents/dev/instances/dev-b`]);
  assert.deepEqual(views.deploymentRows(views.deploymentFor(R)).map(i => [i.server, i.home]), [['devbox', '/home/alex/oats/agents/dev/instances/far-a']]);
  assert.equal(views.deploymentRows(views.deploymentFor(A)).some(i => i.deployment), false, 'untagged, as the deployment served them');
  assert.deepEqual(views.deploymentRows(views.deploymentFor(L)), []);
});
