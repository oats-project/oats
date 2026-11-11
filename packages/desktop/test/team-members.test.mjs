import test from 'node:test';
import assert from 'node:assert/strict';
import { teamMembers } from '../../client/team-members.mjs';
import { remotePanel } from '../../client/remote-roster.mjs';
import { apiUrl } from '../api-url.mjs';
import { loadServer, juanState, A, B, R, V, V_OATS, V_LAB, tag } from './helpers/workspace-views-fixture.mjs';
/** The time a remote panel is made at: remotePanel reads no clock, its caller gives the time. */
const AT = '2026-10-11T12:00:00.000Z';

const TEAM = 'aweb:juan.aweb.ai';
const LOCAL = { id: '/w', machine: 'This Mac', path: '/w' };
const localRow = (name, extra = {}) => ({ instance: name, agent: 'dev', agentsRoot: '/w/agents', home: `/w/agents/dev/instances/${name}`,
  running: true, createdAt: '2026-09-30T00:00:00.000Z', identity: { alias: name, team: TEAM }, ...extra });
const group = (server, extra = {}) => ({ id: `${server}:1a2b`, server, label: `${server} box`, registrationPresent: true,
  target: { sshHost: server, workspace: '/srv' }, probe: { ok: true }, agentsRoot: '/srv/agents',
  souls: [{ name: 'dev', agentsRoot: '/srv/agents' }, { name: 'qa', agentsRoot: '/srv/agents' }], instances: [], ...extra });
const remoteRow = (name, extra = {}) => ({ instance: name, agent: 'dev', agentsRoot: '/srv/agents', home: `/srv/agents/dev/instances/${name}`,
  running: true, savedRoute: false, addressable: true, missingRemotely: false, createdAt: null, identity: { alias: name, team: TEAM }, ...extra });
/** The deployment tag of a remote group, as the views give it (panel-views.mjs `deploymentTag`). */
const groupTag = g => ({ id: `remote:${g.id}`, machine: g.label || g.server, path: g.target.workspace });
const project = ({ rows = [localRow('dev-a')], groups = [], deployments = [{ deployment: LOCAL, instances: rows }] } = {}) =>
  teamMembers({ deployments, groups: groups.map(g => ({ group: g, deployment: groupTag(g), panel: remotePanel(g, AT) })) });

test('members: this workspace\'s rows and every remote panel\'s rows with a team; rows without one are not members', () => {
  const build = group('build', { instances: [remoteRow('far-a'), remoteRow('no-team', { identity: null }), remoteRow('blank', { identity: { team: '' } })] });
  const result = project({ rows: [localRow('dev-a'), localRow('solo', { identity: { alias: 'solo' } })], groups: [build] });
  assert.deepEqual(result.members.map(m => [m.server, m.instance]), [[null, 'dev-a'], ['build', 'far-a']]);
  assert.deepEqual(result.members[0], { workspace: '/w', deployment: LOCAL, server: null, serverLabel: null, instance: 'dev-a', agent: 'dev', agentsRoot: '/w/agents',
    home: '/w/agents/dev/instances/dev-a', team: TEAM, running: true, addressable: true, missingRemotely: false, reason: null, reasonLabel: null, createdAt: '2026-09-30T00:00:00.000Z' });
  assert.deepEqual(result.members[1], { workspace: 'remote:build:1a2b', deployment: { id: 'remote:build:1a2b', machine: 'build box', path: '/srv' }, server: 'build', serverLabel: 'build box', instance: 'far-a', agent: 'dev',
    agentsRoot: '/srv/agents', home: '/srv/agents/dev/instances/far-a', team: TEAM, running: true, addressable: true, missingRemotely: false, reason: null, reasonLabel: null, createdAt: null });
});

test('members: a row that cannot be opened carries the roster\'s own reason; missingRemotely is kept', () => {
  const build = group('build', { instances: [remoteRow('gone', { addressable: false, missingRemotely: true, running: null }), remoteRow('hidden', { addressable: false })] });
  const [gone, hidden] = project({ rows: [], groups: [build] }).members;
  assert.equal(gone.missingRemotely, true); assert.equal(gone.addressable, false);
  assert.equal(gone.reason, 'gone is no longer on build box. Remove it from this computer with: oats server forget build --instance gone');
  assert.equal(hidden.reason, 'build box did not report this instance as reachable.');
  assert.deepEqual([gone.reasonLabel, hidden.reasonLabel], ['gone from build box', 'not reachable on build box'], 'the roster\'s short label, for the state word');
});

test('servers: every remote group, reached or not; an unreached group keeps its last-known rows, their state unknown', () => {
  const down = group('down', { probe: { ok: false, error: { code: 'E_SSH', message: 'ssh failed: timeout' } }, instances: [remoteRow('kept')] });
  const result = project({ rows: [], groups: [group('build'), down] });
  assert.deepEqual(result.servers, [
    { server: 'build', label: 'build box', group: 'build:1a2b', deployment: 'remote:build:1a2b', reached: true, error: null, registered: true, features: null },
    { server: 'down', label: 'down box', group: 'down:1a2b', deployment: 'remote:down:1a2b', reached: false, error: 'ssh failed: timeout', registered: true, features: null },
  ]);
  assert.equal(result.members[0].running, null, 'last-known, state unknown');
  assert.equal(result.members[0].reason, 'ssh failed: timeout');
});

test('servers: a reached group carries the host\'s own features as relayed (server-probe-features); unknown is null', () => {
  const listed = group('build', { probe: { ok: true, features: ['spawn-name', 'spawn-preview-2'] } });
  const failed = group('down', { probe: { ok: false, features: ['spawn-name'], error: { message: 'ssh failed' } } });
  const notList = group('odd', { probe: { ok: true, features: 'spawn-name' } });
  const [build, down, odd] = project({ rows: [], groups: [listed, failed, notList] }).servers;
  assert.deepEqual(build.features, ['spawn-name', 'spawn-preview-2']);
  assert.notEqual(build.features, listed.probe.features, 'a copy, never the held list');
  assert.equal(down.features, null, 'a failed read says nothing of its host');
  assert.equal(odd.features, null, 'only a list counts');
});

test('not reached: every failed group holding no rows is named; one with last-known rows is a group on the cards instead; nothing before the first answer', () => {
  const empty = group('empty', { probe: { ok: false, error: { message: 'ssh failed' } } });
  const kept = group('kept', { probe: { ok: false, error: { message: 'ssh failed' } }, instances: [remoteRow('k')] });
  assert.deepEqual(project({ rows: [], groups: [group('build'), empty, kept] }).notReached, [{ server: 'empty', label: 'empty box', deployment: 'remote:empty:1a2b' }]);
  assert.deepEqual(project({ rows: [], groups: [] }).notReached, [], 'before the first roster answer there is nothing to name');
});

test('a server with two groups (an edited registration keeps its old group): each is listed, and only the registered one is marked so', () => {
  const old = group('build', { id: 'build:old', registrationPresent: false, target: { sshHost: 'old-host', workspace: '/old' }, instances: [remoteRow('legacy')] });
  const result = project({ rows: [], groups: [old, group('build')] });
  assert.deepEqual(result.servers.map(s => [s.group, s.registered]), [['build:old', false], ['build:1a2b', true]]);
  assert.equal(result.members[0].workspace, 'remote:build:old', 'a member navigates to its own group');
  assert.deepEqual(result.members[0].deployment, { id: 'remote:build:old', machine: 'build box', path: '/old' });
  assert.deepEqual(result.servers.map(s => s.deployment), ['remote:build:old', 'remote:build:1a2b']);
});

test('the same instance seen from two machines is two members, each labelled (never merged)', () => {
  const loop = group('loop', { instances: [remoteRow('dev-a', { home: '/w/agents/dev/instances/dev-a', agentsRoot: '/w/agents' })] });
  const members = project({ rows: [localRow('dev-a')], groups: [loop] }).members;
  assert.deepEqual(members.map(m => [m.server, m.home]), [[null, '/w/agents/dev/instances/dev-a'], ['loop', '/w/agents/dev/instances/dev-a']]);
});

test('a remote-only view lists its members (members are read for any view)', () => {
  const build = group('build', { instances: [remoteRow('far-a'), remoteRow('far-b', { identity: { alias: 'far-b', team: 'aweb:other' } })] });
  const result = project({ deployments: [], groups: [build] });
  assert.deepEqual(result.members.map(m => [m.instance, m.team, m.workspace, m.deployment]), [
    ['far-a', TEAM, 'remote:build:1a2b', groupTag(build)], ['far-b', 'aweb:other', 'remote:build:1a2b', groupTag(build)]]);
  assert.deepEqual(result.servers.map(s => [s.server, s.deployment, s.reached]), [['build', 'remote:build:1a2b', true]]);
  assert.equal(Object.hasOwn(result, 'error'), false, 'no refusal');
});

test('a view with two local deployments: each member is addressed to its own deployment', () => {
  const other = { id: '/v2', machine: 'This Mac', path: '/v2' };
  const result = teamMembers({ deployments: [
    { deployment: LOCAL, instances: [localRow('dev-a')] },
    { deployment: other, instances: [localRow('dev-a', { home: '/v2/agents/dev/instances/dev-a', agentsRoot: '/v2/agents' }), localRow('solo', { identity: null })] },
  ] });
  assert.deepEqual(result.members.map(m => [m.instance, m.workspace, m.deployment, m.home]), [
    ['dev-a', '/w', LOCAL, '/w/agents/dev/instances/dev-a'], ['dev-a', '/v2', other, '/v2/agents/dev/instances/dev-a']], 'same name, two members, never merged');
  assert.notEqual(result.members[1].deployment, other, 'a copy of the tag');
  assert.deepEqual(teamMembers({}), { members: [], servers: [], notReached: [] });
});

test('/api/team-members is workspace-scoped at the proxy: an unadvertised ws is replaced, duplicates are kept for the server to refuse', () => {
  assert.equal(apiUrl('/api/team-members?ws=evil', '/w', new Set(['/w'])).searchParams.get('ws'), '/w');
  assert.equal(apiUrl('/api/team-members', '/w', new Set(['/w'])).searchParams.get('ws'), '/w');
  assert.deepEqual(apiUrl('/api/team-members?ws=/w&ws=/x', '/w', new Set(['/w'])).searchParams.getAll('ws'), ['/w', '/x']);
});

test('GET /api/team-members over the shipped handler: Host guard, one ws, the VIEW\'s members (any view), served from the held snapshot', async () => {
  const { state } = juanState();
  const { request } = await loadServer(state, { adapter: new Proxy({}, { get: () => assert.fail }), cliState: { ok: true, bin: '/oats', features: ['workspace-identity'], remote: ['roster'] } });
  const ask = (url, headers = { host: '127.0.0.1:4820' }) => request({ url, headers });
  const ok = await ask(`/api/team-members?ws=${encodeURIComponent(V_OATS)}`);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.members.map(m => [m.server, m.instance, m.workspace, m.deployment]), [
    [null, 'dev-a', A, tag(A, 'This Mac', A)], [null, 'idle', A, tag(A, 'This Mac', A)], [null, 'dev-b', B, tag(B, 'This Mac', B)],
    ['altair', 'far-a', R, tag(R, 'altair', '/home/juan/oats')]], 'the view\'s deployments only: vega\'s lab-a is another workspace');
  assert.deepEqual(ok.body.servers.map(s => [s.server, s.deployment]), [['altair', R]]);
  assert.deepEqual(ok.body.notReached, []);
  assert.deepEqual((await ask(`/api/team-members?ws=${encodeURIComponent(A)}`)).body, ok.body, 'a deployment id reads its view');
  const lab = await ask(`/api/team-members?ws=${encodeURIComponent(V_LAB)}`);
  assert.equal(lab.status, 200, 'a remote-only view has a team roster');
  assert.deepEqual(lab.body.members.map(m => [m.server, m.instance, m.workspace]), [['vega', 'lab-a', V]]);
  for (const url of ['/api/team-members', `/api/team-members?ws=${encodeURIComponent(A)}&ws=${encodeURIComponent(A)}`, `/api/team-members?ws=${encodeURIComponent(A)}&x=1`]) assert.equal((await ask(url)).status, 400, url);
  assert.equal((await ask('/api/team-members?ws=%2Fnope')).body.code, 'E_WORKSPACE_UNKNOWN');
  assert.equal((await ask('/api/team-members?ws=%2Fnope')).status, 400);
  assert.equal((await ask(`/api/team-members?ws=${encodeURIComponent(V_OATS)}`, { host: 'evil.example' })).status, 403);
});

test('a member is addressable exactly when the roster can open it: a saved-route row from a local OATS before 0.31 is, an explicit false is not', () => {
  const build = group('build', { instances: [remoteRow('older', { addressable: undefined, savedRoute: true }), remoteRow('refused', { addressable: false, savedRoute: true })] });
  const [older, refused] = project({ rows: [], groups: [build] }).members;
  assert.deepEqual([older.addressable, older.reason], [true, null]);
  assert.equal(refused.addressable, false); assert.equal(refused.reason, 'build box did not report this instance as reachable.');
});
