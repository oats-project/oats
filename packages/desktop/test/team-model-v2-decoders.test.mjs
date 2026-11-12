// Team model v2 (feature team-model-2, OATS 0.30) decoders (D1b): `oats teams`, `oats soul teams`,
// the souls/preview/status teams + defaultTeam, readiness team items, and the argv adapters.
// Fixtures: team-model-v2/ are REAL captures from the K1 kernel (provenance.json: oats
// feat/030-team-model, capture-teams-v2.mjs, the Desktop's exact argv), replacing the doc
// stand-ins teams.json / soul-teams.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { teamsData, soulTeamsData, soulsData, deploymentStatusData } from '../../client/deployment-data.mjs';
import { previewData } from '../../client/spawn-preview-contract.mjs';
import { defaultTeamOf } from '../../client/team-rows.mjs';
import { cliTeams, cliSoulTeams } from '../../client/cli-adapter.mjs';
import * as remote from '../../client/remote-roster.mjs';
import { soulRows } from '../../client/soul-rows.mjs';
import { target } from './helpers/spawn-preview-fixture.mjs';

const read = path => JSON.parse(readFileSync(new URL(`./fixtures/${path}.json`, import.meta.url), 'utf8'));
const v2 = name => read(`team-model-v2/${name}`);
const DEPLOYMENT = '/fixture/base/northwind-workspace';

test('oats teams (real): shared + local teams, the default, souls as written, problems; mutations carry changed; bound to the deployment', () => {
  const t = teamsData(v2('teams-after'), DEPLOYMENT);
  assert.equal(t.defaultTeam, 'mine');
  assert.deepEqual(t.teams.map(r => [r.label, r.team, r.from, r.default]), [['engineering', null, 'shared', false], ['global', null, 'shared', false],
    ['marketing', null, 'shared', false], ['mine', 'mine:alex.aweb.ai', 'local', true]]);
  assert.deepEqual([t.teams[3].description, t.teams[3].at], ['My own team', 'oats-local.yaml#/teams/mine']);
  assert.match(t.teams[0].at, /oats-workspace\.yaml#\/teams\/engineering$/);
  assert.deepEqual(t.souls, { teams: { 'release-manager': ['mine', 'engineering'], '*': ['global'] }, default: { 'release-manager': 'engineering' } });
  assert.deepEqual(t.problems.map(p => [p.code, p.label, p.default]), [['team-unmapped', 'engineering', false], ['team-unmapped', 'global', false], ['team-unmapped', 'marketing', false]]);
  assert.equal(teamsData(v2('teams-add'), DEPLOYMENT).changed, true, 'a mutation');
  assert.equal(teamsData(v2('teams-initial'), DEPLOYMENT).defaultTeam, null, 'no default yet');
  assert.throws(() => teamsData(v2('teams-after'), '/other'), { code: 'E_DEPLOYMENT_SCOPE' });
  for (const change of [d => { d.result.teams[0].from = 'global'; }, d => { d.result.teams[0].default = true; }, d => { d.result.teams[0].label = '-x'; },
    d => { d.result.souls.teams['*'] = ['global', 'global']; }, d => { d.result.teamsApi = 2; }, d => { d.result.changed = 'yes'; }, d => { d.result.problems[0].severity = 'meh'; }]) {
    const bad = v2('teams-after'); change(bad); assert.throws(() => teamsData(bad, DEPLOYMENT), { code: 'E_CLI_PROTOCOL' });
  }
});

test('oats soul teams (real): rows with via in the kernel\'s order, the default, local and all; the * key', () => {
  const s = soulTeamsData(v2('soul-teams-default'));
  assert.deepEqual([s.soul, s.key, s.defaultTeam, s.changed], ['release-manager', 'release-manager', { label: 'engineering', team: null, from: 'soul' }, true]);
  assert.deepEqual(s.teams.map(r => [r.label, r.default, r.mapped, r.via]), [['engineering', true, false, ['default', 'soul']], ['mine', false, true, ['soul']]]);
  assert.deepEqual([s.local, s.all], [{ teams: ['mine', 'engineering'], default: 'engineering' }, []]);
  const star = soulTeamsData(v2('soul-teams-star-show'));
  assert.deepEqual([star.key, star.defaultTeam.from, star.teams.map(r => r.via)], ['*', 'deployment', [['default'], ['*']]]);
  assert.equal(soulTeamsData(v2('soul-teams-clear-default')).changed, true);
  for (const change of [d => { d.result.teams[0].via = ['soul', 'default']; }, d => { d.result.teams[0].via = []; }, d => { d.result.teams[0].via = ['team']; },
    d => { d.result.defaultTeam.from = 'setting'; }, d => { delete d.result.teams[0].default; }, d => { d.result.local.default = 7; }]) {
    const bad = v2('soul-teams-default'); change(bad); assert.throws(() => soulTeamsData(bad), { code: 'E_CLI_PROTOCOL' });
  }
});

test('souls rows and /api/agents (real): teams and defaultTeam pass through; 0.29 rows gain no keys', () => {
  const souls = soulsData(v2('souls')).souls, rm = souls.find(s => s.name === 'release-manager');
  assert.deepEqual(rm.teams.map(t => [t.label, t.team, t.default, t.from, t.mapped]), [['engineering', null, true, 'shared', false], ['global', null, false, 'shared', false],
    ['mine', 'mine:alex.aweb.ai', false, 'local', true]]);
  assert.deepEqual(rm.defaultTeam, { label: 'engineering', team: null, from: 'soul' }, 'an unmapped default names its label');
  for (const s of soulsData(read('workspace-v2/desktop-facts/souls')).souls) assert.equal(Object.hasOwn(s, 'teams') || Object.hasOwn(s, 'defaultTeam'), false, '0.29: no v2 keys invented');
  const bad = v2('souls'); bad.result.souls.find(s => s.name === 'release-manager').teams[0] = { label: 'x', team: 't', mapped: true }; // a 0.29 row in a v2 list
  assert.throws(() => soulsData(bad), { code: 'E_CLI_PROTOCOL' });
  const badDefault = v2('souls'); badDefault.result.souls.find(s => s.name === 'release-manager').defaultTeam = { team: 't', source: 'root' };
  assert.throws(() => soulsData(badDefault), { code: 'E_CLI_PROTOCOL' });
  // /api/agents carries them (the real v2 status + souls).
  const source = readFileSync(new URL('../server/oats-web.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function agentsData('), end = source.indexOf('/* ── Model catalog', start);
  const agentsData = new Function('deploymentFor', 'deployments', 'snapshot', 'remote', 'dirname', 'resolve', 'soulRows', `const held = () => null, DESKTOP_TERMS = null; ${source.slice(start, end)}; return agentsData;`);
  const roster = deploymentStatusData(v2('status'), DEPLOYMENT);
  const snapshot = { byWs: new Map([[DEPLOYMENT, { deployment: { status: 'observed', root: roster.root, souls: roster.agents.map(({ instances: _i, ...s }) => s), catalog: { souls, ambiguous: [], reason: null } } }]]) };
  const ws = { id: DEPLOYMENT, name: 'northwind', roots: [roster.root] };
  const agent = agentsData(() => ws, () => [ws], snapshot, remote, dirname, resolve, soulRows)().agents.find(a => a.name === 'release-manager');
  assert.deepEqual([agent.teams.length, agent.teams[0].default, agent.defaultTeam.label], [3, true, 'engineering']);
});

test('spawn preview (real): no team, teams + defaultTeam (an unmapped soul default); absent on 0.29; malformed refuses the preview', () => {
  const real = v2('preview').result;
  assert.equal(Object.hasOwn(real, 'team'), false, 'the real 0.30 preview has no team');
  const p = previewData(structuredClone(real), target);
  assert.ok(p, 'the real 0.30 preview reads');
  assert.deepEqual(p.defaultTeam, { label: 'engineering', team: null, from: 'soul' });
  assert.equal(Object.hasOwn(previewData(read('workspace-v2/f7/preview-teams-default').result, target), 'defaultTeam'), false, '0.29: none');
  const none = structuredClone(real); none.defaultTeam = null; assert.equal(previewData(none, target).defaultTeam, null);
  const bad = structuredClone(real); bad.defaultTeam = { label: 'x', team: 't', from: 'root' }; assert.equal(previewData(bad, target), null);
  assert.equal(defaultTeamOf({ label: 'x', team: 't' }), undefined);
});

test('argv: oats teams and oats soul teams, validated before any exec, never option-shaped', async () => {
  const calls = [], exec = (bin, argv, opts, done) => { calls.push(argv); done(null, JSON.stringify({ schemaVersion: 1, ok: true, result: {} })); };
  const ws = '/w';
  await cliTeams('/oats', { workspaceDir: ws }, { exec });
  await cliTeams('/oats', { action: 'add', label: 'builder-oats', team: 'builder-oats:alex.aweb.ai', description: 'Mine', workspaceDir: ws }, { exec });
  await cliTeams('/oats', { action: 'remove', label: 'old', workspaceDir: ws }, { exec });
  await cliTeams('/oats', { action: 'default', label: 'oats', workspaceDir: ws }, { exec });
  await cliSoulTeams('/oats', { soul: 'oats-expert', add: ['oats', 'reviewers'], remove: ['old'], defaultLabel: 'oats', workspaceDir: ws }, { exec });
  await cliSoulTeams('/oats', { soul: 'oats.okf/harvester', clearDefault: true, workspaceDir: ws }, { exec });
  await cliSoulTeams('/oats', { soul: '*', add: ['oats'], workspaceDir: ws }, { exec });
  assert.deepEqual(calls, [
    ['teams', '--dir', ws, '--json'],
    ['teams', 'add', 'builder-oats', '--team=builder-oats:alex.aweb.ai', '--description=Mine', '--dir', ws, '--json'],
    ['teams', 'remove', 'old', '--dir', ws, '--json'], ['teams', 'default', 'oats', '--dir', ws, '--json'],
    ['soul', 'teams', 'oats-expert', '--add=oats,reviewers', '--remove=old', '--default=oats', '--dir', ws, '--json'],
    ['soul', 'teams', 'oats.okf/harvester', '--clear-default', '--dir', ws, '--json'],
    ['soul', 'teams', '*', '--add=oats', '--dir', ws, '--json']]);
  const never = { exec: () => assert.fail('must not execute') };
  for (const bad of [{ action: 'add', label: 'x', team: '-rf', workspaceDir: ws }, { action: 'add', label: 'x', team: '--json', workspaceDir: ws },
    { action: 'default', label: '--default', workspaceDir: ws }, { action: 'add', label: 'x', team: 'no-namespace', workspaceDir: ws },
    { action: 'add', label: 'x', team: 'a b:c.d', workspaceDir: ws }, { action: 'add', label: 'x', team: 't:ns', description: '--json', workspaceDir: ws }, { action: 'add', label: '-x', team: 't:ns', workspaceDir: ws },
    { action: 'add', label: 'x', team: 't:ns', description: 'two\nlines', workspaceDir: ws }, { action: 'join', label: 'x', workspaceDir: ws },
    { action: 'remove', label: 'x', team: 't:ns', workspaceDir: ws }, { workspaceDir: 'relative' }, { label: 'x', workspaceDir: ws }]) {
    assert.equal((await cliTeams('/oats', bad, never)).error.code, 'E_BAD_ARGS', JSON.stringify(bad));
  }
  for (const bad of [{ soul: '*', defaultLabel: 'x', workspaceDir: ws }, { soul: '*', clearDefault: true, workspaceDir: ws }, { soul: 'a', defaultLabel: 'x', clearDefault: true, workspaceDir: ws },
    { soul: '--all', workspaceDir: ws }, { soul: 'a', add: [], workspaceDir: ws }, { soul: 'a', add: ['x', 'x'], workspaceDir: ws }, { soul: 'a/b/c', workspaceDir: ws }, { soul: 'a', add: ['-x'], workspaceDir: ws },
    { soul: 'a', defaultLabel: '--default', workspaceDir: ws }, { soul: 'a', add: Array.from({ length: 65 }, (_, i) => `t${i}`), workspaceDir: ws }]) {
    assert.equal((await cliSoulTeams('/oats', bad, never)).error.code, 'E_BAD_ARGS', JSON.stringify(bad));
  }
});

test('readiness (real): team items in checks.configured (no fifth check) keep code, label, default and at', async () => {
  const { readinessData } = await import('../../client/readiness-contract.mjs');
  const { data } = await import('./helpers/readiness-fixture.mjs');
  const t = { workspace: 'northwind', context: DEPLOYMENT, observedAs: 'soul', selector: { kind: 'soul', soul: 'release-manager', agentsRoot: `${DEPLOYMENT}/agents` } };
  const real = v2('readiness-soul').result, r = readinessData(structuredClone(real), t);
  assert.ok(r, 'the real 0.30 readiness reads');
  assert.deepEqual(Object.keys(r.checks), ['installed', 'configured', 'member', 'providers']);
  const items = r.checks.configured.items.filter(i => i.label !== undefined);
  assert.deepEqual(items.map(i => [i.subject, i.code, i.label, i.default, i.required]), [['team engineering', 'team-unmapped', 'engineering', true, true], ['team global', 'team-unmapped', 'global', false, false]]);
  assert.equal(items[0].reason, 'the default team engineering has no provider id yet', 'the blocking copy names the label');
  assert.match(items[0].at, /oats-workspace\.yaml#\/teams\/engineering$/);
  for (const change of [i => { i.label = '-x'; }, i => { i.default = 'yes'; }, i => { i.at = 7; }]) {
    const bad = structuredClone(real); change(bad.checks.configured.items.find(i => i.label === 'engineering')); assert.equal(readinessData(bad, t), null);
  }
  const plain = readinessData(data(), (await import('./helpers/readiness-fixture.mjs')).target);
  assert.ok(plain.checks.configured.items.every(i => !Object.hasOwn(i, 'label') && !Object.hasOwn(i, 'default') && !Object.hasOwn(i, 'at')), '0.29 items gain no keys');
});

test('team ids follow the kernel\'s provider-neutral rule in every generic reader (the aweb form stays the route\'s)', async () => {
  const { teamRow, defaultTeamOf, TEAM_ID } = await import('../../client/team-rows.mjs');
  for (const id of ['mine:alex.aweb.ai', 'team@example.org', 'org/team+eng', 'a', 'A'.repeat(256)]) {
    assert.ok(TEAM_ID.test(id), id);
    assert.ok(teamRow({ label: 'x', team: id, default: false, from: 'local' }), id);
    assert.ok(defaultTeamOf({ label: 'x', team: id, from: 'soul' }), id);
  }
  for (const id of ['-x', 'a b', 'a;b', '<script>', 'a\nb', '', 'A'.repeat(257), 7]) {
    assert.equal(teamRow({ label: 'x', team: id, default: false, from: 'local' }), null, String(id));
    assert.equal(defaultTeamOf({ label: 'x', team: id, from: 'soul' }), undefined, String(id));
    const doc = v2('teams-after'); doc.result.teams[3].team = id; assert.throws(() => teamsData(doc, DEPLOYMENT), { code: 'E_CLI_PROTOCOL' }, String(id));
  }
});
