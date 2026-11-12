// Team model 3 (feature team-model-3, OATS 0.38.0): the Desktop's decoders for `oats teams --json`
// (teamsApi 2) and `oats soul teams --json` (soulTeamsApi 2), against REAL captures of this repository's
// kernel (test/fixtures/team-model-3, provenance.json). teamsApi 1 / soulTeamsApi 1 (team-model-2,
// OATS 0.30–0.37) keep their own shapes: test/team-model-v2-decoders.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { teamsData, soulTeamsData } from '../../client/deployment-data.mjs';
import { defaultTeamOf, teamRowsOf } from '../../client/team-rows.mjs';

const BASE = '/fixture/base';
const DEP = `${BASE}/northwind-workspace`;
const capture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/team-model-3/${name}.json`, import.meta.url), 'utf8').split('<base>').join(BASE));
const rejects = (fn, code = 'E_CLI_PROTOCOL') => assert.throws(fn, (e) => e.code === code);

test('teamsApi 2, local teams closed: localTeams, the workspace default, the shared teams, the souls: patterns, the problems', () => {
  const t = teamsData(capture('teams-closed'), DEP);
  assert.equal(t.teamsApi, 2); assert.equal(t.deployment, DEP); assert.equal(t.localTeams, false);
  assert.deepEqual(t.defaultTeam, { label: 'global', team: 'global:northwind.aweb.ai', from: 'workspace' });
  assert.deepEqual(t.teams.map((r) => [r.label, r.team, r.from, r.default]), [
    ['engineering', 'engineering:northwind.aweb.ai', 'shared', false], ['global', 'global:northwind.aweb.ai', 'shared', true], ['marketing', null, 'shared', false]]);
  assert.ok(t.teams.every((r) => r.at.includes('oats-workspace.yaml#/teams/')));
  assert.deepEqual(t.souls, { '*': { teams: [] }, 'agents/*': { teams: ['engineering'] },
    'agents/release-manager': { default: 'engineering', teams: ['marketing'] }, 'agents/no-such-soul': { teams: ['global'] } });
  const [unmapped, unknown] = t.problems;
  assert.deepEqual([unmapped.code, unmapped.severity, unmapped.label, unmapped.default], ['team-unmapped', 'warning', 'marketing', false]);
  assert.deepEqual([unknown.code, unknown.severity, unknown.key], ['team-soul-unknown', 'warning', 'agents/no-such-soul']);
  assert.ok(unknown.at && unknown.message && unknown.fix, 'the kernel\'s own message and fix, kept');
});

test('teamsApi 2, local teams present while closed: the local-teams-closed failure with its condition, path and keys', () => {
  const t = teamsData(capture('teams-closed-local'), DEP);
  assert.equal(t.localTeams, false);
  assert.deepEqual(t.teams.filter((r) => r.from === 'local').map((r) => r.label), ['mine', 'spare']);
  const closed = t.problems.find((p) => p.condition === 'local-teams-closed');
  assert.deepEqual([closed.code, closed.severity, closed.path, closed.keys], ['E_WORKSPACE_SCHEMA', 'failure', 'oats-local.yaml', ['teams']]);
  assert.match(closed.fix, /localTeams: true/);
});

test('teamsApi 2, local teams allowed: the deployment\'s own default and teams; a verb\'s answer says whether it changed', () => {
  const open = teamsData(capture('teams-open'), DEP);
  assert.equal(open.localTeams, true);
  const added = teamsData(capture('teams-add'), DEP);
  assert.equal(added.changed, true); assert.ok(added.teams.some((r) => r.label === 'mine' && r.from === 'local'));
  const after = teamsData(capture('teams-after'), DEP);
  assert.deepEqual(after.defaultTeam, { label: 'mine', team: 'mine:alex.aweb.ai', from: 'deployment' });
});

test('teamsApi 2 refuses what is not its shape', () => {
  const doc = capture('teams-closed');
  const variant = (mutate) => { const d = structuredClone(doc); mutate(d.result); return d; };
  rejects(() => teamsData(variant((r) => { r.localTeams = 'yes'; }), DEP));
  rejects(() => teamsData(variant((r) => { r.defaultTeam = 'global'; }), DEP), 'E_CLI_PROTOCOL');
  rejects(() => teamsData(variant((r) => { r.souls = { '*': { teams: 'some' } }; }), DEP));
  rejects(() => teamsData(variant((r) => { r.souls = { '*': { default: 'Bad Label!' } }; }), DEP));
  rejects(() => teamsData(variant((r) => { r.souls = []; }), DEP));
  rejects(() => teamsData(variant((r) => { r.problems = [{ code: 'x', keys: [7] }]; }), DEP));
  rejects(() => teamsData(variant((r) => { r.teamsApi = 3; }), DEP));
  rejects(() => teamsData(doc, '/somewhere/else'), 'E_DEPLOYMENT_SCOPE');
  const any = teamsData(variant((r) => { r.souls = { 'agents/*': { teams: 'any' } }; }), DEP);
  assert.deepEqual(any.souls, { 'agents/*': { teams: 'any' } }, '"any" is every shared team');
  assert.equal(teamsData(variant((r) => { r.localTeams = null; }), DEP).localTeams, null, 'the standalone view');
});

test('soulTeamsApi 2: the soul\'s key, the souls: keys its teams and default come from, and why it may join each team', () => {
  const s = soulTeamsData(capture('soul-teams-show'));
  assert.deepEqual([s.soulTeamsApi, s.soul, s.key, s.match, s.defaultMatch], [2, 'release-manager', 'agents/release-manager', 'agents/release-manager', 'agents/release-manager']);
  assert.deepEqual(s.defaultTeam, { label: 'engineering', team: 'engineering:northwind.aweb.ai', from: 'soul' });
  assert.deepEqual(s.teams.map((r) => [r.label, r.default, r.via]), [['engineering', true, ['default']], ['marketing', false, ['workspace']]]);
  const local = soulTeamsData(capture('soul-teams-show-local'));
  assert.deepEqual(local.teams.map((r) => [r.label, r.from, r.via]), [['engineering', 'shared', ['default']], ['marketing', 'shared', ['workspace']], ['mine', 'local', ['local']]]);
  const star = soulTeamsData(capture('soul-teams-star-show'));
  assert.deepEqual([star.soul, star.key, star.match], ['*', '*', '*']);
  assert.equal(Object.hasOwn(s, 'local') || Object.hasOwn(s, 'all'), false, 'no v1 local/all lists');
});

test('soulTeamsApi 2 refuses v1 via values and out-of-order via', () => {
  const doc = capture('soul-teams-show');
  const variant = (mutate) => { const d = structuredClone(doc); mutate(d.result); return d; };
  rejects(() => soulTeamsData(variant((r) => { r.teams[0].via = ['soul']; })));
  rejects(() => soulTeamsData(variant((r) => { r.teams[0].via = ['local', 'default']; })));
  rejects(() => soulTeamsData(variant((r) => { r.match = 7; })));
});

test('a DefaultTeam may come from the workspace (0.38); rows with via still read as rows elsewhere', () => {
  assert.deepEqual(defaultTeamOf({ label: 'global', team: 'global:northwind.aweb.ai', from: 'workspace' }), { label: 'global', team: 'global:northwind.aweb.ai', from: 'workspace' });
  assert.equal(defaultTeamOf({ label: 'global', team: null, from: 'elsewhere' }), undefined);
  const preview = capture('preview').result;
  assert.deepEqual(teamRowsOf(preview.teams).map((r) => [r.label, r.default]), [['engineering', true], ['marketing', false]]);
  assert.deepEqual(defaultTeamOf(preview.defaultTeam).from, 'soul');
});

test('readiness (real 0.38): team-unmapped and team-soul-unknown items read, the kernel\'s reason and remedy kept', async () => {
  const { readinessData } = await import('../../client/readiness-contract.mjs');
  // The Desktop asks readiness by soul name; the kernel's subject names the soul so.
  const t = { workspace: 'northwind', context: DEP, observedAs: 'soul', selector: { kind: 'soul', soul: 'release-manager', agentsRoot: `${DEP}/agents` } };
  const r = readinessData(structuredClone(capture('readiness-soul').result), t);
  assert.ok(r, 'the real 0.38 readiness reads');
  const items = r.checks.configured.items;
  assert.deepEqual(items.map((i) => [i.subject, i.code, i.required]), [['team marketing', 'team-unmapped', false], ['teams', 'team-soul-unknown', false]]);
  assert.match(items[1].reason, /souls: agents\/no-such-soul names no soul of this workspace/);
  assert.match(items[1].remedy, /correct the key to a soul's qualified name/);
});

test('the provider\'s teams document: a default from the workspace\'s defaultTeam (oats.aweb 1.19) reads and says so', async () => {
  const { defaultTeamText } = await import('../renderer/teams-panel.mjs');
  assert.equal(defaultTeamText({ label: 'global', team: 'global:northwind.aweb.ai', from: 'workspace' }), "global:northwind.aweb.ai · the workspace's default");
  assert.equal(defaultTeamText({ label: 'engineering', team: null, from: 'soul' }), "engineering (no provider id yet) · this soul's own default");
});
