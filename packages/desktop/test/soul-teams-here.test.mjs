// Team model v2 (0.30, D2 screen 2): the soul page's "Teams here", on the REAL 0.30 kernel: K1
// (feat/030-team-model @bba0a9b8) captured by the engineer in test/fixtures/team-model-v2 (#269;
// provenance.json), decoded by soulTeamsData / teamsData exactly as /api/workspace-soul-teams and
// /api/workspace-teams answer them. A scenario the capture run did not reach is DERIVED from a
// capture, and says so. The run: release-manager shown (default mine, the deployment's), then
// --add mine,engineering, --default engineering (no provider id yet: its own), --clear-default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createSoulTeamsHere, soulTeamsHereCSS, viaText } from '../renderer/soul-teams-here.mjs';
import { soulTeamsData, teamsData } from '../../client/deployment-data.mjs';

const capture = name => JSON.parse(readFileSync(new URL(`./fixtures/team-model-v2/${name}.json`, import.meta.url), 'utf8'));
const soulTeams = name => soulTeamsData(capture(name));
const TEAMS = () => teamsData(capture('teams-after'), '/fixture/base/northwind-workspace');
const refused = name => { const e = capture(name).error; return Object.assign(new Error(e.message), { code: e.code }); };
const refusal = (code, message) => Object.assign(new Error(message), { code });
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

async function mount(t, answer = () => soulTeams('soul-teams-clear-default'), listTeams = async () => TEAMS()) {
  const dom = new JSDOM('<!doctype html><body><main class="oats-view"></main></body>', { pretendToBeVisual: true }), doc = dom.window.document;
  const style = doc.createElement('style'); style.textContent = soulTeamsHereCSS; doc.head.append(style);
  const calls = [];
  const card = createSoulTeamsHere(doc, { soul: 'release-manager', request: async body => { calls.push(body); return answer(body, calls.length); }, listTeams });
  doc.querySelector('main').append(card.element);
  t.after(() => { card.dispose(); dom.window.close(); });
  await tick();
  const q = s => card.element.querySelector(s), row = label => q(`[data-team="${label}"]`);
  const click = async el => { el.click(); await tick(); };
  const act = (label, name) => [...row(label).querySelectorAll('.sth-actions > .sth-act')].find(b => b.textContent === name) ?? null;
  return { dom, doc, card, calls, q, row, click, act };
}

test("real capture: the soul's teams here, its default (the workspace's), and why it has each team; one read", async t => {
  const u = await mount(t);
  assert.deepEqual(u.calls, [{ soul: 'release-manager', action: 'show' }]);
  assert.equal(u.card.element.dataset.card, 'Teams here'); assert.equal(u.q('.page-card-lead').textContent, 'on this computer');
  assert.equal(u.q('.sth-default').textContent, "Default: mine (the workspace's default on this computer)");
  const rows = [...u.card.element.querySelectorAll('.sth-row')].map(r => [r.dataset.team, !!r.querySelector('.page-tag'), ...[...r.querySelectorAll('.sth-meta')].map(m => m.textContent)]);
  assert.deepEqual(rows, [['mine', true, 'mine:alex.aweb.ai · local', "the workspace's default here · added for this soul"],
    ['engineering', false, 'no provider id yet · shared', 'added for this soul'], ['global', false, 'no provider id yet · shared', 'every soul may join it']]);
  assert.ok(u.row('engineering').querySelector('.sth-meta.warn'), 'no provider id yet is a warning');
  assert.equal(u.q('.sth-blocking'), null);
  assert.doesNotMatch(u.card.element.textContent, /primary|personal/i);
});

test("real capture: the soul's own default has no provider id yet (engineering): said as blocking; none configured says what to do", async t => {
  const own = await mount(t, () => soulTeams('soul-teams-default'));
  assert.equal(own.q('.sth-default').textContent, "Default: engineering (this soul's own)");
  const block = own.q('.sth-blocking');
  assert.equal(block.getAttribute('role'), 'alert');
  assert.deepEqual([...block.children].map(c => c.textContent), ["The default team engineering has no provider id yet, so release-manager can't be spawned here.",
    "Its owner runs oats aweb setup, then commits the id; or make another team this soul's default."]);
  assert.ok(own.act('mine', 'Make default'), 'the way out is on the page');
  assert.equal(own.row('engineering').querySelectorAll('.sth-meta')[1].textContent, 'its own default · added for this soul');
  const none = await mount(t, () => ({ ...soulTeams('soul-teams-show'), defaultTeam: null, teams: [] })); // DERIVED: no default configured
  assert.equal(none.q('.sth-default').textContent, 'No default team on this computer: run oats aweb setup.');
  assert.equal(viaText(['default', '*', 'soul'], 'soul'), 'its own default · every soul may join it · added for this soul');
  assert.equal(viaText(['future'], 'deployment'), 'future', 'an unknown reason is shown as written');
});

test('actions: Make default needs an id; Use workspace default only for its own default; Remove only what was added for this soul', async t => {
  const u = await mount(t);
  assert.equal(u.act('mine', 'Make default'), null, 'already the default');
  assert.equal(u.act('mine', 'Use workspace default'), null, 'already the workspace default');
  assert.ok(u.act('mine', 'Remove'), 'added for this soul too');
  assert.equal(u.act('engineering', 'Make default'), null, 'no provider id yet: it cannot be the default here');
  assert.ok(u.act('engineering', 'Remove'));
  assert.equal(u.act('global', 'Remove'), null, 'every soul may join global: not removable per soul');
  const own = await mount(t, () => soulTeams('soul-teams-default'));
  assert.ok(own.act('engineering', 'Use workspace default'), 'its own default can go back to the workspace one');
  assert.equal(own.act('mine', 'Make default').getAttribute('aria-label'), 'Make mine the default team of release-manager');
});

test('each action sends its body and repaints from the answer (the captured sequence)', async t => {
  const u = await mount(t, body => body.action === 'clear-default' ? soulTeams('soul-teams-clear-default')
    : body.action === 'remove' ? { ...soulTeams('soul-teams-clear-default'), teams: soulTeams('soul-teams-clear-default').teams.filter(r => r.label !== 'engineering') } // DERIVED
    : soulTeams('soul-teams-default'));
  await u.click(u.act('engineering', 'Use workspace default'));
  assert.deepEqual(u.calls.at(-1), { soul: 'release-manager', action: 'clear-default' });
  assert.equal(u.q('.sth-default').textContent, "Default: mine (the workspace's default on this computer)");
  assert.equal(u.q('.sth-blocking'), null, 'unblocked');
  await u.click(u.act('engineering', 'Remove'));
  assert.deepEqual(u.calls.at(-1), { soul: 'release-manager', action: 'remove', labels: ['engineering'] });
  assert.equal(u.row('engineering'), null);
});

test('Add offers the teams on this computer the soul is not in yet, then focuses the choice (captured show → add)', async t => {
  let listed = 0;
  const u = await mount(t, body => body.action === 'add' ? soulTeams('soul-teams-add') : soulTeams('soul-teams-show'), async () => { listed++; return TEAMS(); });
  assert.equal(listed, 0, 'the list is read only when asked');
  await u.click([...u.q('.sth-add').querySelectorAll('.sth-act')].find(b => b.textContent === 'Add a team'));
  const select = u.q('.sth-add select');
  assert.deepEqual([...select.options].map(o => [o.value, o.textContent]), [['engineering', 'engineering (no provider id yet)'], ['global', 'global (no provider id yet)'], ['marketing', 'marketing (no provider id yet)']]);
  assert.equal(u.doc.activeElement, select);
  await u.click([...u.q('.sth-add').querySelectorAll('.sth-act')].find(b => b.textContent === 'Add'));
  assert.deepEqual(u.calls.at(-1), { soul: 'release-manager', action: 'add', labels: ['engineering'] });
  assert.ok(u.row('engineering'), 'repainted from the answer');
  assert.deepEqual([...u.q('.sth-add select').options].map(o => o.value), ['global', 'marketing']);
});

test("the kernel's captured refusals are shown verbatim with their code (a stale view)", async t => {
  const u = await mount(t, body => body.action === 'remove' ? Promise.reject(refused('soul-teams-unknown'))
    : body.action === 'add' ? Promise.reject(refused('soul-teams-star-default')) : soulTeams('soul-teams-clear-default'));
  await u.click(u.act('engineering', 'Remove'));
  assert.equal(u.row('engineering').querySelector('.sth-error p').textContent, 'team "nope" is not declared: `oats teams add` it first');
  assert.equal(u.row('engineering').querySelector('.sth-error pre').textContent, 'E_TEAM_UNKNOWN');
  assert.equal(u.row('engineering').querySelector('.sth-error').getAttribute('role'), 'alert');
  await u.click([...u.q('.sth-add').querySelectorAll('.sth-act')].find(b => b.textContent === 'Add a team'));
  await u.click([...u.q('.sth-add').querySelectorAll('.sth-act')].find(b => b.textContent === 'Add'));
  assert.equal(u.q('.sth-add .sth-error pre').textContent, 'E_BAD_ARGS');
  assert.equal(u.row('engineering').querySelector('.sth-error'), null, 'one error at a time');
});

test('a failed re-read over a document keeps the rows and says so with the observation\'s age; a focused action keeps focus through the lock', async t => {
  let fail = false, calls = 0;
  // The card's age reads Date.now: one fixed instant for the observation and the card, so the age is 45 s by construction.
  const now = Date.now(); t.mock.method(Date, 'now', () => now);
  const observedAt = new Date(now - 45_000).toISOString();
  const u = await mount(t, () => { calls++; if (fail) return Promise.reject(refusal('E_CLI_FAILED', 'bridge down')); return { ...soulTeams('soul-teams-clear-default'), observedAt }; });
  const rows = u.q('.sth-row') ? [...u.card.element.querySelectorAll('.sth-row')].length : 0; assert.ok(rows > 0);
  const action = u.card.element.querySelector('button.sth-act'); action.focus();
  fail = true; const p = u.card.refresh({ user: true });
  assert.equal(action.getAttribute('aria-disabled'), 'true'); assert.equal(action.disabled, false); assert.equal(u.doc.activeElement, action, 'locked, focus kept');
  await p; await tick();
  assert.equal(u.card.element.querySelectorAll('.sth-row').length, rows, 'the rows are kept');
  const box = u.q('.sth-add .sth-error'); assert.ok(box, 'the problem box beside the rows');
  assert.equal(box.querySelector('p').textContent, 'bridge down · observed 45s ago', 'the stale rule: the observation\'s age');
  assert.equal(box.querySelector('pre').textContent, 'E_CLI_FAILED');
  assert.equal(u.q('.loading-failed'), null, 'not the failed block: there is a document');
});

// desktop/loading-states: with no document yet, a failed read is the shared failed block (cause, the
// code behind Details, Retry); with a document, the problem box beside the rows as before.
test('a failed or malformed read says so', async t => {
  const failed = await mount(t, () => Promise.reject(refusal('E_SOUL_UNKNOWN', 'no soul release-manager here')));
  assert.equal(failed.q('.loading-failed-message').textContent, 'no soul release-manager here');
  assert.equal(failed.q('.loading-failed-code').textContent, 'E_SOUL_UNKNOWN'); assert.ok(failed.q('.loading-retry'));
  assert.equal(failed.q('.sth-error'), null);
  const malformed = await mount(t, () => ({ soulTeamsApi: 1 }));
  assert.equal(malformed.q('.loading-failed-message').textContent, 'The teams of release-manager on this computer could not be read.');
  assert.equal(malformed.q('.loading-failed-details').hidden, true, 'no code to disclose');
});

test('#1879: a reprobe above the tested bound holds every team write of the soul back with the notice; a reprobe into the bound gives each its own state back', async t => {
  const cs = await import('../renderer/views/cli-status.mjs');
  const cli = (extra = {}) => ({ ok: true, bin: '/oats', version: '0.70.1', source: 'path', required: { desktopApi: 1, range: '>=0.26.0, tested through 0.69' }, tried: [], features: [], ...extra });
  let probe = cli({ version: '0.69.25' });
  const cliCtx = { api: async () => probe };
  await cs.refreshCli(cliCtx);
  t.after(() => cs.resetCliStateForTests());
  const u = await mount(t);
  const controls = () => [u.act('mine', 'Remove'), u.act('engineering', 'Remove'), u.q('.sth-add .sth-act')].map(b => [b.textContent, b.disabled, b.title]);
  const within = controls();
  assert.deepEqual(within, [['Remove', false, ''], ['Remove', false, ''], ['Add a team', false, '']], 'within the bound: the writes are on');

  probe = cli({ aboveTested: true, testedThrough: '0.69' });
  await cs.refreshCli(cliCtx); await tick();
  const notice = cs.cliHeldBack('POST /api/workspace-soul-teams add');
  assert.match(notice, /^This Desktop was tested with oats CLIs up to 0\.69; the installed CLI is 0\.70\.1\. /);
  assert.deepEqual(controls(), [['Remove', true, notice], ['Remove', true, notice], ['Add a team', true, notice]], 'held back, with no repaint');
  const calls = u.calls.length;
  await u.click(u.act('engineering', 'Remove'));
  assert.equal(u.calls.length, calls, 'a held-back write runs nothing');

  probe = cli({ version: '0.69.25' });
  await cs.refreshCli(cliCtx); await tick();
  assert.deepEqual(controls(), within, 'each control has its own state back');
  u.card.dispose();
  probe = cli({ aboveTested: true, testedThrough: '0.69' });
  await cs.refreshCli(cliCtx); await tick();
  assert.deepEqual(controls(), within, 'unsubscribed on disposal');
});
