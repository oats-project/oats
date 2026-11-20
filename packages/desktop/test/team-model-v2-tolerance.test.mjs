// Team model v2 (0.30) tolerance, consumer-first (D1a): the Desktop's readers accept the 0.30
// shapes additively BEFORE the kernel/provider pins move, and keep reading 0.29 unchanged.
// Documents: the REAL 0.29 captures, with 0.29-only keys removed and the v2 keys added
// (docs/design/2026-09-27-team-model-v2.md, "The kernel ↔ provider contract"). The band stays
// <0.30.0 here; the real 0.30 pass-through (D1b) follows K1's shapes doc.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { teamsDocument, soulTeams, defaultTeamText } from '../renderer/teams-panel.mjs';
import { teamRow } from '../../client/team-rows.mjs';
import { previewData } from '../../client/spawn-preview-contract.mjs';
import { workspaceStatusData, deploymentStatusData, capabilitiesData, soulsData } from '../../client/deployment-data.mjs';
import { inspectData } from '../../client/inspect-contract.mjs';
import { readinessData } from '../../client/readiness-contract.mjs';
import { data as readinessCapture, target as readinessTarget } from './helpers/readiness-fixture.mjs';
import { target } from './helpers/spawn-preview-fixture.mjs';

const read = path => JSON.parse(readFileSync(new URL(`./fixtures/workspace-v2/${path}.json`, import.meta.url), 'utf8'));
const run = name => read(`teams/${name}`).result;
const DEPLOYMENT = '/fixture/base/northwind-workspace';

test('teams document: 0.29 unchanged; v2 drops primary/unmapped, adds left[] and source deployment|soul', () => {
  const r29 = run('teams-initial');
  assert.deepEqual(teamsDocument(r29, 'messaging:teams'), r29.result, '0.29 as captured');
  const v2 = structuredClone(r29); delete v2.result.primary; delete v2.result.unmapped;
  v2.result.defaultTeam = { label: 'builder-oats', team: v2.result.defaultTeam.team, from: 'deployment' }; // the kernel's DefaultTeam (K1 @8dd82158)
  v2.result.left = [{ label: 'reviewers', team: 'northwind:reviewers', at: '2026-09-27T10:00:00Z', reason: 'no-longer-eligible' }];
  const d = teamsDocument(v2, 'messaging:teams');
  assert.ok(d, 'the v2 document is read, not blanked');
  assert.deepEqual([d.primary, d.unmapped, d.left.length, d.defaultTeam.from], [null, [], 1, 'deployment']);
  assert.match(defaultTeamText(d.defaultTeam), /this workspace's default on this computer$/);
  const soul = structuredClone(v2); soul.result.defaultTeam.from = 'soul'; assert.ok(teamsDocument(soul, 'messaging:teams'));
  const unmapped = structuredClone(v2); unmapped.result.defaultTeam.team = null;
  // K1 addendum 4 (final): an UNMAPPED default is {label, team: null, from}, never null; null only when none is configured.
  assert.deepEqual(teamsDocument(unmapped, 'messaging:teams').defaultTeam, { label: 'builder-oats', team: null, from: 'deployment' });
  assert.match(defaultTeamText(teamsDocument(unmapped, 'messaging:teams').defaultTeam), /^builder-oats \(no provider id yet\)/, 'an unmapped default names its label');
  const none = structuredClone(v2); none.result.defaultTeam = null; assert.equal(teamsDocument(none, 'messaging:teams').defaultTeam, null, 'none configured');
  assert.match(defaultTeamText(teamsDocument(r29, 'messaging:teams').defaultTeam), / · /, '0.29 words unchanged');
  // Still strict: bounded, well-formed, and an unknown key or source is refused.
  for (const change of [x => { x.result.left = Array.from({ length: 21 }, () => x.result.left[0]); }, x => { x.result.left[0].reason = ''; },
    x => { x.result.left[0].extra = 1; }, x => { x.result.surprise = true; }, x => { x.result.defaultTeam.from = 'guess'; }, x => { delete x.result.joined; },
    x => { x.result.defaultTeam = { team: 't', source: 'deployment' }; }, x => { x.result.defaultTeam.extra = 1; }, x => { x.result.defaultTeam.label = '-bad'; }]) {
    const bad = structuredClone(v2); change(bad); assert.equal(teamsDocument(bad, 'messaging:teams'), null);
  }
});

test('soul team rows: 0.29 {label, team, mapped} and v2 {label, team, default, from}, one reader', () => {
  assert.deepEqual(teamRow({ label: 'eng', team: 'n:eng', mapped: true, payload: {} }), { label: 'eng', team: 'n:eng', mapped: true });
  const v2 = teamRow({ label: 'oats', team: 'oats:oats.aweb.ai', default: false, from: 'shared' });
  assert.deepEqual(v2, { label: 'oats', team: 'oats:oats.aweb.ai', mapped: true, default: false, from: 'shared' });
  assert.deepEqual(teamRow(v2), v2, 'idempotent over its own projection');
  for (const bad of [{ label: 'x', team: 't', default: 'yes', from: 'local' }, { label: 'x', team: 't', default: true, from: '' }, { label: 'x', team: 't', default: true, from: 'local', mapped: false },
    { label: '-x', team: 't', mapped: true }, { label: 'x', team: null, mapped: true }]) assert.equal(teamRow(bad), null, JSON.stringify(bad));
  const inspect = read('teams/inspect-soul').result.teams;
  assert.deepEqual(soulTeams(inspect), inspect.map(t => ({ label: t.label, team: t.team, mapped: t.mapped })), '0.29 inspect rows as before');
  assert.deepEqual(soulTeams([{ label: 'builder-oats', team: 'a:alex.aweb.ai', default: true, from: 'local' }])[0].default, true);
});

test('spawn preview teams: the v2 rows keep the spawn Teams choice (not "unreadable")', () => {
  const v29 = read('f7/preview-teams-default').result;
  const before = previewData(structuredClone(v29), target);
  assert.ok(before && Array.isArray(before.teams));
  const v2 = structuredClone(v29);
  delete v2.team; // v2 removes the primary label (K1: "removes team")
  v2.teams = [{ label: 'builder-oats', team: 'a:alex.aweb.ai', default: true, from: 'local' }, { label: 'oats', team: 'oats:oats.aweb.ai', default: false, from: 'shared' }];
  const after = previewData(v2, target);
  assert.ok(after, 'the preview is read, with team removed'); assert.equal(after.team, null);
  assert.deepEqual(after.teams.map(t => [t.label, t.default, t.mapped]), [['builder-oats', true, true], ['oats', false, true]]);
});

test('workspace status: defaults.byTeam optional; workspace.teams as strings (0.29) or v2 shared-team rows', () => {
  const doc = read('desktop-facts/workspace-status');
  const w29 = workspaceStatusData(structuredClone(doc), DEPLOYMENT);
  assert.ok(Object.hasOwn(w29.defaults, 'byTeam'), '0.29 keeps byTeam');
  const noByTeam = structuredClone(doc); delete noByTeam.result.defaults.byTeam;
  const w = workspaceStatusData(noByTeam, DEPLOYMENT);
  assert.equal(Object.hasOwn(w.defaults, 'byTeam'), false, 'absent stays absent'); assert.ok(w.members.length > 0, 'the rest of the read survives');
  const rows = structuredClone(doc); rows.result.workspace.teams = [{ label: 'oats', team: 'oats:oats.aweb.ai', description: 'Everyone on OATS' }, { label: 'reviewers', team: null, description: null }];
  const r = workspaceStatusData(rows, DEPLOYMENT);
  assert.deepEqual(r.workspace.teams, ['oats', 'reviewers'], 'Setup keeps listing the labels');
  assert.deepEqual(r.workspace.sharedTeams, rows.result.workspace.teams);
  for (const change of [x => { x.result.workspace.teams = ['oats', { label: 'mixed', team: null, description: null }]; },
    x => { x.result.workspace.teams = [{ label: 'dup', team: null, description: null }, { label: 'dup', team: null, description: null }]; },
    x => { x.result.workspace.teams = [{ label: '-bad', team: null, description: null }]; }, x => { x.result.defaults.byTeam = []; }]) {
    const bad = structuredClone(doc); change(bad); assert.throws(() => workspaceStatusData(bad, DEPLOYMENT), { code: 'E_CLI_PROTOCOL' });
  }
});

/** Delete `path` (a.b[].c) everywhere in `doc`; returns how many keys it removed. */
function strip(doc, path) {
  const parts = path.split('.'); let n = 0;
  const walk = (v, i) => {
    if (v === null || typeof v !== 'object') return;
    const part = parts[i], each = part.endsWith('[]'), key = each ? part.slice(0, -2) : part;
    if (i === parts.length - 1) { if (Object.hasOwn(v, key)) { delete v[key]; n++; } return; }
    const next = v[key];
    if (each) { if (Array.isArray(next)) for (const x of next) walk(x, i + 1); } else walk(next, i + 1);
  };
  walk(doc, 0); return n;
}
const dropped = (doc, paths) => { for (const p of paths) assert.ok(strip(doc, p) > 0, `the 0.29 capture carries ${p}`); return doc; };

// The DROP lesson (0.30 D1a/D1b): a dropped field breaks a reader harder than an added one. Every key
// team model v2 REMOVES is deleted from the real 0.29 captures, and every reader still reads.
test('the DROP lesson: every key team model v2 removes is deleted from the real 0.29 captures, and every reader still reads', () => {
  // oats spawn --preview: the primary label.
  const preview = dropped(read('f7/preview-teams-default').result, ['team']);
  assert.ok(previewData(preview, target), 'preview without team');
  // oats souls: each soul's primary team and its labels.
  const souls = dropped(read('desktop-facts/souls'), ['result.souls[].team', 'result.souls[].labels']);
  assert.deepEqual(soulsData(souls).souls.map(s => s.name), soulsData(read('desktop-facts/souls')).souls.map(s => s.name));
  // oats status: the soul's team, and the instance's workspace.soul team/labels.
  const status = dropped(read('desktop-facts/status'), ['agents[].team', 'agents[].instances[].workspace.soul.team', 'agents[].instances[].workspace.soul.labels']);
  assert.deepEqual(deploymentStatusData(status, DEPLOYMENT).agents.map(a => [a.name, a.instances.length]),
    deploymentStatusData(read('desktop-facts/status'), DEPLOYMENT).agents.map(a => [a.name, a.instances.length]));
  // oats workspace status: members[]/external[] team, defaults.byTeam.
  const ws = dropped(read('desktop-facts/workspace-status'), ['result.members[].team', 'result.external[].team', 'result.defaults.byTeam']);
  assert.ok(workspaceStatusData(ws, DEPLOYMENT));
  // oats capabilities: the providing team.
  const caps = dropped(read('desktop-facts/capabilities'), ['result.capabilities[].team']);
  assert.deepEqual(capabilitiesData(caps).capabilities.map(c => c.name), capabilitiesData(read('desktop-facts/capabilities')).capabilities.map(c => c.name));
  // oats inspect (soul): subject.team, souls[].team/labels.
  const inspect = dropped(read('desktop-facts/inspect-soul').result, ['subject.team', 'souls[].team']);
  strip(inspect, 'souls[].labels');
  assert.ok(inspectData(inspect, { agent: { name: inspect.subject.soul } }), 'inspect without the soul team');
  // oats readiness: subject.team.
  const readiness = dropped(readinessCapture(), ['subject.team']);
  assert.ok(readinessData(readiness, readinessTarget), 'readiness without subject.team');
});

test('the real 0.30 documents (K1 kernel, fixtures/team-model-v2) read in every reader: the removed keys are really gone', () => {
  const real = name => read(`../team-model-v2/${name}`);
  const gone = (doc, paths) => { for (const p of paths) assert.equal(strip(structuredClone(doc), p), 0, `0.30 no longer carries ${p}`); return doc; };
  assert.ok(previewData(gone(real('preview').result, ['team']), target));
  assert.ok(soulsData(gone(real('souls'), ['result.souls[].team', 'result.souls[].labels'])).souls.length > 0);
  const status = deploymentStatusData(gone(real('status'), ['agents[].team', 'agents[].instances[].workspace.soul.team', 'agents[].instances[].workspace.soul.labels']), DEPLOYMENT);
  assert.ok(status.agents.some(a => a.instances.length === 1));
  assert.ok(workspaceStatusData(gone(real('workspace-status'), ['result.members[].team', 'result.external[].team', 'result.defaults.byTeam']), DEPLOYMENT));
  assert.ok(capabilitiesData(gone(real('capabilities'), ['result.capabilities[].team'])).capabilities.length > 0);
  const soul = gone(real('inspect-soul').result, ['subject.team', 'souls[].team', 'souls[].labels']);
  assert.ok(inspectData(soul, { agent: { name: 'release-manager' } }));
  const home = real('inspect-home').result;
  assert.ok(inspectData(home, { instance: {}, selector: { home: home.subject.home } }));
  const t = { workspace: 'northwind', context: DEPLOYMENT, observedAs: 'soul', selector: { kind: 'soul', soul: 'release-manager', agentsRoot: `${DEPLOYMENT}/agents` } };
  assert.ok(readinessData(gone(real('readiness-soul').result, ['subject.team']), t));
});

// oats.aweb 1.17's exact teams-document surface (the provider developer's, relayed by the owner),
// consumer-first: a STAND-IN on the real 1.16 capture until the 1.17 head exists (provenance `awaiting`).
test('oats.aweb 1.17 teams document: eligible rows\' from, top-level warnings[], actions\' warning; 0.29 unchanged', () => {
  const r29 = run('teams-initial');
  assert.deepEqual(teamsDocument(r29, 'messaging:teams'), r29.result, '0.29 as captured');
  const v117 = structuredClone(r29); delete v117.result.primary; delete v117.result.unmapped;
  v117.result.defaultTeam = { label: v117.result.defaultTeam.team.split(':')[0], team: null, from: 'deployment' };
  v117.result.eligible = v117.result.eligible.map((e, i) => ({ ...e, from: i === 0 ? 'local' : 'shared' }));
  v117.result.left = [];
  v117.result.warnings = ['oats-aweb: team reviewers has no provider id yet'];
  const d = teamsDocument(v117, 'messaging:teams');
  assert.ok(d, 'the 1.17 surface reads');
  assert.deepEqual(d.eligible.map(e => e.from), v117.result.eligible.map(e => e.from), 'eligible rows keep from');
  assert.deepEqual(d.warnings, ['oats-aweb: team reviewers has no provider id yet'], 'top-level warnings kept as worded');
  assert.equal(Object.hasOwn(teamsDocument(r29, 'messaging:teams'), 'warnings'), false, 'not invented');
  for (const [what, change] of [['from outside shared|local', x => { x.result.eligible[0].from = 'global'; }], ['eligible extra key', x => { x.result.eligible[0].extra = 1; }],
    ['warnings not a list', x => { x.result.warnings = 'w'; }], ['warning not text', x => { x.result.warnings = [7]; }],
    ['warning oversized', x => { x.result.warnings = ['w'.repeat(513)]; }], ['too many warnings', x => { x.result.warnings = Array.from({ length: 65 }, () => 'w'); }],
    ['warning control char', x => { x.result.warnings = ['a\nb']; }]]) {
    const bad = structuredClone(v117); change(bad); assert.equal(teamsDocument(bad, 'messaging:teams'), null, what);
  }
});
