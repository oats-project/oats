// Team model 3 at the Desktop's teams boundary (server/teams.mjs): the gate admits a CLI with feature
// team-model-3 (OATS 0.38) as it admits team-model-2 (0.30–0.37); under team-model-3 `oats soul teams`
// is read only, so an edit is refused before any CLI call (the removed flags are never sent); a kernel
// local-teams-closed refusal keeps its details. Real 0.38 captures (test/fixtures/team-model-3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTeamsBoundary } from '../server/teams.mjs';

const BASE = '/fixture/base', DEP = `${BASE}/northwind-workspace`;
const capture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/team-model-3/${name}.json`, import.meta.url), 'utf8').split('<base>').join(BASE));
const context = (features) => () => ({ workspace: { id: DEP, scope: DEP }, cli: { bin: '/usr/local/bin/oats', features } });

function boundary(replies) {
  const calls = [];
  const b = createTeamsBoundary({
    teams: async (_bin, args) => { calls.push(['teams', args]); return replies.teams; },
    soulTeams: async (_bin, args) => { calls.push(['soulTeams', args]); return replies.soulTeams; },
  });
  return { calls, ...b };
}

test('team-model-3 is admitted: the deployment\'s teams and a soul\'s teams read', async () => {
  const b = boundary({ teams: capture('teams-closed'), soulTeams: capture('soul-teams-show') });
  const teams = await b.teams({ action: 'list' }, context(['team-model-3']));
  assert.equal(teams.status, 'ok'); assert.equal(teams.teams.teamsApi, 2); assert.equal(teams.teams.localTeams, false);
  const soul = await b.soulTeams({ action: 'show', soul: 'agents/release-manager' }, context(['team-model-3']));
  assert.equal(soul.status, 'ok'); assert.equal(soul.soulTeams.match, 'agents/release-manager');
});

test('team-model-3: a soul\'s teams are read only; an edit is refused before any CLI call, with the kernel\'s own wording', async () => {
  const b = boundary({ soulTeams: capture('soul-teams-show') });
  for (const request of [{ action: 'add', soul: 'agents/release-manager', labels: ['global'] }, { action: 'remove', soul: 'agents/release-manager', labels: ['global'] },
    { action: 'default', soul: 'agents/release-manager', label: 'global' }, { action: 'clear-default', soul: 'agents/release-manager' }]) {
    const refused = await b.soulTeams(request, context(['team-model-3']));
    assert.equal(refused.status, 'refused', request.action);
    assert.equal(refused.reason.code, 'E_BAD_ARGS');
    assert.match(refused.reason.message, /souls: in oats-workspace\.yaml \(a PR to the workspace file\)/);
  }
  assert.deepEqual(b.calls, [], 'the removed --add/--remove/--default/--clear-default are never sent');
});

test('team-model-2 (0.30–0.37) keeps its soul-teams edits', async () => {
  const b = boundary({ soulTeams: { schemaVersion: 1, ok: false, error: { code: 'E_TEAM_UNKNOWN', message: 'no team nope', details: { label: 'nope' } } } });
  const r = await b.soulTeams({ action: 'add', soul: 'release-manager', labels: ['nope'] }, context(['team-model-2']));
  assert.equal(b.calls.length, 1, 'sent to the CLI'); assert.equal(r.reason.code, 'E_TEAM_UNKNOWN');
});

test('a CLI with neither team model is refused, as before', async () => {
  const b = boundary({});
  assert.equal((await b.teams({ action: 'list' }, context(['workspace-v2']))).reason.code, 'E_TEAMS_UNAVAILABLE');
});

test('the kernel\'s local-teams-closed refusal keeps its reason, path and keys', async () => {
  const b = boundary({ teams: capture('teams-add-closed') });
  const r = await b.teams({ action: 'add', label: 'mine', team: 'mine:alex.aweb.ai' }, context(['team-model-3']));
  assert.equal(r.reason.code, 'E_WORKSPACE_SCHEMA');
  assert.match(r.reason.message, /either \(a\) add `localTeams: true`/);
  assert.deepEqual(r.reason.details, { reason: 'local-teams-closed', path: 'oats-local.yaml', keys: ['teams'] });
});

test('the renderer\'s team gates: either team model shows the live views, never the 0.29 fallback', async () => {
  const { teamModelOf } = await import('../../client/team-rows.mjs');
  assert.equal(teamModelOf(['team-model-3']), 3); assert.equal(teamModelOf(['team-model-2']), 2);
  assert.equal(teamModelOf(['team-model-2', 'team-model-3']), 3); assert.equal(teamModelOf(['teams']), null); assert.equal(teamModelOf(undefined), null);
  const { readFileSync } = await import('node:fs');
  for (const file of ['../renderer/soul-inspector.mjs', '../renderer/workspace-discovery.mjs']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /includes\('team-model-2'\)/, `${file}: no gate on team-model-2 alone`);
    assert.match(source, /teamModelOf\(/, file);
  }
});
