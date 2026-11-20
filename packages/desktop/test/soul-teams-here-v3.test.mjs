// Team model 3 (feature team-model-3, OATS 0.38): the soul page's "Teams here" is read only, on the REAL 0.38
// kernel's `oats soul teams --json` (soulTeamsApi 2; test/fixtures/team-model-3, provenance.json), decoded by
// soulTeamsData as /api/workspace-soul-teams answers it. Which teams a soul may join, and its default, are the
// workspace's souls: (a PR to the workspace file): the card says where each comes from and where to change it,
// in the kernel's words, and offers no edit. Northwind: agents/release-manager has the default engineering and
// marketing from its own souls: entry; with local teams allowed, the local team mine too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createSoulTeamsHere, soulTeamsHereCSS, UNMAPPED_FIX, UNCONFIGURED } from '../renderer/soul-teams-here.mjs';
import { soulTeamsData } from '../../client/deployment-data.mjs';

const BASE = '/fixture/base';
const capture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/team-model-3/${name}.json`, import.meta.url), 'utf8').split('<base>').join(BASE));
const soulTeams = (name) => soulTeamsData(capture(name));
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)); };

async function mount(t, answer, { soul = 'agents/release-manager' } = {}) {
  const dom = new JSDOM('<!doctype html><body><main class="oats-view"></main></body>', { pretendToBeVisual: true }), doc = dom.window.document;
  const style = doc.createElement('style'); style.textContent = soulTeamsHereCSS; doc.head.append(style);
  const calls = [], listed = [];
  const card = createSoulTeamsHere(doc, { soul, request: async (body) => { calls.push(body); return answer(body); }, listTeams: async () => { listed.push(1); return { teams: [] }; } });
  doc.querySelector('main').append(card.element);
  t.after(() => { card.dispose(); dom.window.close(); });
  await tick();
  const q = (s) => card.element.querySelector(s);
  return { card, calls, listed, q, rows: () => [...card.element.querySelectorAll('.sth-row')].map((r) => [r.dataset.team, ...[...r.querySelectorAll('.sth-meta')].map((m) => m.textContent)]) };
}

test('read only: the default and the souls: key it comes from; each team and why; no action of any kind', async (t) => {
  const u = await mount(t, () => soulTeams('soul-teams-show'));
  assert.deepEqual(u.calls, [{ soul: 'agents/release-manager', action: 'show' }], 'one read; nothing else is ever sent');
  assert.equal(u.q('.page-card-lead').textContent, 'in this workspace');
  assert.equal(u.q('.sth-default').textContent, 'Default: engineering (souls: agents/release-manager)');
  assert.deepEqual(u.rows(), [['engineering', 'engineering:northwind.aweb.ai · shared', 'its default'],
    ['marketing', 'no provider id yet · shared', 'its souls: entry agents/release-manager']]);
  assert.equal(u.card.element.querySelector('button'), null, 'no Make default, Remove, Use workspace default or Add');
  assert.equal(u.card.element.querySelector('select'), null);
  assert.deepEqual(u.listed, [], 'the teams list is never read for an Add picker');
});

test('where to change it: one line, the kernel\'s words, naming the soul\'s key; no YAML snippet', async (t) => {
  const u = await mount(t, () => soulTeams('soul-teams-show'));
  const where = u.q('.sth-where');
  assert.equal(where.textContent, 'Which teams agents/release-manager may join, and its default: souls: in oats-workspace.yaml (a PR to the workspace file).');
  assert.equal(u.card.element.querySelector('pre, code'), null);
});

test('a local team where local teams are allowed says so', async (t) => {
  const u = await mount(t, () => soulTeams('soul-teams-show-local'));
  assert.deepEqual(u.rows().at(-1), ['mine', 'mine:alex.aweb.ai · local', 'a local team']);
});

test('a default from the workspace or this deployment says so; an unmapped default blocks with the kernel\'s fix', async (t) => {
  const workspace = soulTeams('soul-teams-show-local');
  workspace.defaultTeam = { label: 'global', team: null, from: 'workspace' }; // DERIVED: the workspace's default, unmapped
  const u = await mount(t, () => workspace);
  assert.equal(u.q('.sth-default').textContent, "Default: global (the workspace's default)");
  const block = u.q('.sth-blocking');
  assert.equal(block.getAttribute('role'), 'alert');
  assert.match(block.textContent, /The default team global has no provider id yet, so agents\/release-manager can't be spawned here\./);
  assert.ok(block.textContent.includes(UNMAPPED_FIX), 'the kernel\'s fix');
  assert.doesNotMatch(block.textContent, /make another team/, 'nothing here can change it');
  const deployment = soulTeams('soul-teams-show-local'); deployment.defaultTeam = { label: 'mine', team: 'mine:alex.aweb.ai', from: 'deployment' };
  const v = await mount(t, () => deployment);
  assert.equal(v.q('.sth-default').textContent, "Default: mine (this deployment's default)");
  const none = soulTeams('soul-teams-show'); none.defaultTeam = null; none.teams = [];
  const w = await mount(t, () => none);
  assert.equal(w.q('.sth-default').textContent, `No default team: ${UNCONFIGURED}.`);
});

test('every soul ("*"): the pattern, never a key to edit', async (t) => {
  const u = await mount(t, () => soulTeams('soul-teams-star-show'), { soul: '*' });
  assert.equal(u.card.element.querySelector('button'), null);
  assert.match(u.q('.sth-where').textContent, /^Which teams every soul may join, and its default: souls: in oats-workspace\.yaml/);
});

test('local teams closed but present: the kernel\'s refusal, verbatim, where the teams would be', async (t) => {
  const e = capture('soul-teams-show-closed-local').error;
  const u = await mount(t, () => { throw Object.assign(new Error(e.message), { code: e.code }); });
  assert.match(u.card.element.textContent, /oats-local\.yaml declares teams, but oats-workspace\.yaml does not allow local teams/);
});

test('the wording is the kernel\'s own', () => {
  const kernel = readFileSync(new URL('../../../lib/teams.mjs', import.meta.url), 'utf8');
  assert.ok(kernel.includes(UNMAPPED_FIX)); assert.ok(kernel.includes(UNCONFIGURED));
});
