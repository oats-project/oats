// Team model v2 (0.30, D2 screen 1; layout: the v4.1 Teams board): the Workspace Teams page, on the REAL
// 0.30 kernel: K1 (feat/030-team-model @bba0a9b8) captured by the engineer in
// test/fixtures/team-model-v2 (#269; provenance.json), decoded by teamsData exactly as the
// /api/workspace-teams route does ({status: 'ok', teams}). A scenario the capture run did not reach
// is DERIVED from a capture, and says so. Northwind: shared engineering/global/marketing (no ids
// yet), a local team `mine` (the default); release-manager takes mine + engineering, every soul global.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createComputerTeams, computerTeamsCSS, teamInUse, teamsAnswer, whoMayJoin } from '../renderer/computer-teams.mjs';
import { renderSetup, setupCSS, teamsBox } from '../renderer/workspace-setup.mjs';
import { teamsData } from '../../client/deployment-data.mjs';

const capture = name => JSON.parse(readFileSync(new URL(`./fixtures/team-model-v2/${name}.json`, import.meta.url), 'utf8'));
const DEPLOYMENT = '/fixture/base/northwind-workspace';
/** A captured `oats teams` document, decoded as the route answers it. */
const teams = name => teamsData(capture(name), DEPLOYMENT);
/** A captured kernel refusal, as the route passes it on (code + the kernel's words). */
const refused = name => { const e = capture(name).error; return Object.assign(new Error(e.message), { code: e.code }); };
const refusal = (code, message) => Object.assign(new Error(message), { code });
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
/** DERIVED: the capture with engineering given an id (the run left every shared team unmapped). */
const mapped = (name = 'teams-after') => { const d = teams(name); d.teams.find(t => t.label === 'engineering').team = 'engineering:northwind.aweb.ai';
  d.problems = d.problems.filter(p => p.label !== 'engineering'); return d; };

async function mount(t, answer = () => teams('teams-after'), options = {}) {
  const dom = new JSDOM('<!doctype html><body><main class="oats-view"></main></body>', { pretendToBeVisual: true }), doc = dom.window.document;
  const style = doc.createElement('style'); style.textContent = setupCSS + computerTeamsCSS; doc.head.append(style);
  const calls = [];
  const card = createComputerTeams(doc, { ...options, request: async body => { calls.push(body); return answer(body, calls.length); } });
  doc.querySelector('main').append(card.element);
  t.after(() => { card.dispose(); dom.window.close(); });
  await tick();
  const q = s => card.element.querySelector(s), row = label => q(`[data-team="${label}"]`);
  const click = async el => { el.click(); await tick(); };
  const act = (label, name) => [...row(label).querySelectorAll('.ct-actions > .ct-act')].find(b => b.textContent === name) ?? null;
  return { dom, doc, card, calls, q, row, click, act };
}

test('real capture: the page head; the shared and local sections with their leads; each team\'s card with its id, who may join and the kernel\'s problems; one read', async t => {
  const u = await mount(t);
  assert.deepEqual(u.calls, [{ action: 'list' }]);
  assert.equal(u.card.element.dataset.box, 'Teams'); assert.equal(u.q('.ct-page-head .ct-title').textContent, 'Teams');
  assert.equal(u.q('.ct-lead').textContent, 'Who your agents can message. A team never adds capabilities or restricts what a soul can do.');
  assert.equal(u.q('.ct-page-head button.ct-add').textContent, 'Add a local team'); assert.ok(u.q('.ct-page-head button.ct-add svg.shell-icon'), 'the plus glyph');
  assert.equal(u.q('.setup-box-head'), null, 'no dashed "Teams on this computer" box: a page');
  assert.deepEqual([...u.card.element.querySelectorAll('.ct-section')].map(s => [s.dataset.section, s.querySelector('.ct-section-title').textContent, s.querySelector('.ct-section-lead').textContent]),
    [['shared', 'Shared teams', 'Declared in oats-workspace.yaml and shared through Git, so every computer that runs the workspace has them.'],
      ['local', 'Local teams', 'Only on this computer, in its oats-local.yaml. Not shared.']]);
  assert.equal(u.q('.ct-scope'), null, 'no scope chips: each section says it in its line');
  assert.deepEqual([...u.card.element.querySelectorAll('.ct-card')].map(c => [c.dataset.team, c.classList.contains('local')]),
    [['engineering', false], ['global', false], ['marketing', false], ['mine', true]], 'a local team\'s card is the dashed one');
  const cards = s => [...u.q(`[data-section=${s}]`).querySelectorAll('.ct-card')].map(c => [c.dataset.team, c.querySelector('[data-fact=address] dd').textContent, c.querySelector('[data-fact=who] .ct-join').textContent, !!c.querySelector('.ct-tag')]);
  assert.deepEqual(cards('shared'), [['engineering', 'no provider id yet', '1 soul', false], ['global', 'no provider id yet', 'every soul', false], ['marketing', 'no provider id yet', 'No soul yet', false]], "the kernel's order; who may join per card");
  assert.deepEqual(cards('local'), [['mine', 'mine:alex.aweb.ai', '1 soul', true]]);
  assert.ok(u.row('marketing').querySelector('.ct-join.none'), 'no soul yet: muted'); assert.equal(u.row('mine').querySelector('.ct-join.none'), null);
  assert.deepEqual([...u.row('mine').querySelectorAll('.ct-facts .ct-fact')].map(f => [f.querySelector('dt').textContent, f.querySelector('dd').textContent]), [['Address', 'mine:alex.aweb.ai'], ['Who may join', '1 soul']]);
  assert.equal(u.row('mine').querySelector('[data-fact=address] dd').title, 'Address: the team on the messaging provider');
  assert.ok(u.row('engineering').querySelector('[data-fact=address] dd.ct-address.none'), 'no provider id yet: the warn value');
  assert.deepEqual([...u.row('mine').querySelectorAll('.ct-id .ct-tag, .ct-id .ct-from')].map(e => e.textContent), ['Default team', 'on this computer'], 'the default: a tag and where it comes from');
  assert.equal(u.row('engineering').querySelector('.ct-tag'), null); assert.equal(u.q('.ct-tile, .ct-side, .ct-pill'), null, 'no tile, no right column, no pill');
  assert.equal(u.row('mine').querySelector('.ct-head .ct-desc').textContent, 'My own team');
  assert.equal(u.row('engineering').querySelector('.ct-warn').textContent, 'shared team engineering has no provider id yetits owner runs `oats aweb setup`, then commits the id', "the kernel's problem and fix, verbatim");
  assert.deepEqual([...u.row('engineering').querySelector('.ct-warn').children].map(c => [c.className, c.textContent]),
    [['ct-warn-msg', 'shared team engineering has no provider id yet'], ['ct-fix', 'its owner runs `oats aweb setup`, then commits the id']], 'the message, then its fix on its own line');
  assert.ok(u.row('engineering').querySelector('.ct-facts').compareDocumentPosition(u.row('engineering').querySelector('.ct-warn')) & 4, 'the warning follows the facts');
  assert.equal(u.row('engineering').querySelector('.ct-blocking'), null, 'not the default: a warning, not blocking');
  assert.equal(u.q('.ct-all'), null, 'the "Every soul may join" footer is gone: it is per card');
  assert.equal(u.q('.ct-foot, .ct-sum'), null, 'no roster given (and the cards do not open): no foot, nothing about instances');
  assert.equal(u.q('.ct-open, .ct-go'), null, 'no onOpenTeam: the cards do not open');
  assert.doesNotMatch(u.card.element.textContent, /primary|personal/i);
  assert.equal(whoMayJoin(teams('teams-after'), 'engineering'), '1 soul', 'a soul default and a soul team: the same soul, counted once');
  assert.equal(whoMayJoin(teams('teams-after'), 'global'), 'every soul'); assert.equal(whoMayJoin(teams('teams-after'), 'marketing'), null);
});

/** /api/team-members for these rows of this computer (plus any remote ones given), as the route answers. */
const member = (row, extra = {}) => ({ workspace: '/w', server: null, serverLabel: null, instance: row.instance, agent: row.agent, agentsRoot: row.agentsRoot,
  home: row.home ?? `${row.agentsRoot}/${row.agent}/instances/${row.instance}`, team: row.identity?.team ?? null, running: row.running ?? null,
  addressable: true, missingRemotely: false, reason: null, createdAt: null, ...extra });
const route = (rows, { remote = [], servers = [], notReached = [] } = {}) =>
  ({ members: [...rows.filter(r => r.identity?.team).map(r => member(r)), ...remote], servers, notReached });

test('the board card sums up your instances on the team, for the members whose identity.team is its id; no member rows on the board', async t => {
  const rows = [
    { instance: 'rm-1', agent: 'release-manager', agentsRoot: '/a', identity: { team: 'mine:alex.aweb.ai' }, running: true },
    { instance: 'rm-2', agent: 'release-manager', agentsRoot: '/a', identity: { team: 'mine:alex.aweb.ai' }, running: false },
    { instance: 'w-3', agent: 'writer', agentsRoot: '/a', identity: { team: 'mine:alex.aweb.ai' }, running: true },
    { instance: 'w-4', agent: 'writer', agentsRoot: '/a', identity: { team: 'mine:alex.aweb.ai' }, running: true },
    { instance: 'e-1', agent: 'engineer', agentsRoot: '/a', identity: { team: 'engineering:northwind.aweb.ai' }, running: true },
    { instance: 'x-1', agent: 'stray', agentsRoot: '/a', identity: { team: null }, running: true },
    { instance: 'x-2', agent: 'legacy', agentsRoot: '/a', running: true },
  ];
  const u = await mount(t, () => mapped(), { readMembers: async () => route(rows), onOpenTeam: () => {} });
  const sum = label => u.row(label).querySelector('.ct-foot .ct-sum');
  assert.equal(sum('mine').textContent, '4 of your instances');
  assert.deepEqual([...sum('mine').children].map(c => c.className), ['ct-sum-count'], 'all here: no "on other machines"');
  assert.equal(sum('engineering').textContent, '1 of your instances');
  for (const label of ['global', 'marketing']) assert.equal(sum(label).textContent, '', 'unmapped: nobody can be in it — nothing, never a zero');
  assert.equal(u.q('.ct-irow, .ct-member-name, .ct-member-term, .ct-members, .ct-default-note'), null, 'no member row, list or note on the board: they are on the team\'s page');
  assert.equal(u.q('.ct-inst, .ct-marks, .ct-count'), null);
  const none = await mount(t, () => mapped(), { readMembers: async () => route([{ instance: 'x', agent: 'x', agentsRoot: '/a', identity: { team: 'other:x.aweb.ai' }, running: true }]) });
  assert.equal(none.row('mine').querySelector('.ct-sum').textContent, 'None of your instances', 'known and none: said so');
  assert.deepEqual([...none.row('mine').querySelector('.ct-sum').children].map(c => c.className), ['ct-sum-more'], 'in the quiet step');
  assert.doesNotMatch(none.card.element.textContent, /0 of your|0 member|No members/);
});

test('syncRoster: a roster poll that changes who is in a team redraws the cards; an unchanged one, an open form or keyboard focus does not', async t => {
  let rows = [{ instance: 'rm-1', agent: 'release-manager', agentsRoot: '/a', identity: { team: 'mine:alex.aweb.ai' }, running: true }];
  const u = await mount(t, () => mapped(), { readMembers: async () => route(rows) });
  const before = u.row('mine');
  assert.equal(before.querySelector('.ct-sum').textContent, '1 of your instances');
  u.card.syncRoster(); await tick(); assert.equal(u.row('mine'), before, 'the same roster: nothing redrawn');
  rows = [...rows, { instance: 'w-2', agent: 'writer', agentsRoot: '/a', identity: { team: 'mine:alex.aweb.ai' }, running: true }];
  u.card.syncRoster(); await tick();
  assert.notEqual(u.row('mine'), before); assert.equal(u.row('mine').querySelector('.ct-sum').textContent, '2 of your instances');
  // A state change redraws too (the team's page follows it; the board's barrier is the same).
  const running = u.row('mine');
  rows = rows.map(r => r.instance === 'w-2' ? { ...r, running: false } : r); u.card.syncRoster(); await tick();
  assert.notEqual(u.row('mine'), running);
  // An open add form keeps what is typed: the roster waits for the form to close.
  u.card.element.querySelector('.ct-add').click(); await tick();
  const label = u.card.element.querySelector('.ct-form input[name=label]'); label.value = 'half'; label.dispatchEvent(new u.dom.window.Event('input', { bubbles: true }));
  rows = rows.slice(0, 1); u.card.syncRoster(); await tick();
  assert.equal(u.card.element.querySelector('.ct-form input[name=label]'), label, 'the form is not rebuilt');
  assert.equal(u.row('mine').querySelector('.ct-sum').textContent, '2 of your instances');
});

test('no local teams: the dashed card with its link opens the add form (Only on this computer); Cancel returns the focus to the link; the head button opens it too', async t => {
  const u = await mount(t, () => { const d = teams('teams-initial'); d.defaultTeam = null; d.teams = d.teams.filter(t => t.from === 'shared'); d.souls.default = {}; return d; });
  assert.deepEqual([...u.q('[data-section=local]').querySelectorAll('.ct-card')], []);
  const empty = u.q('[data-section=local] .ct-empty');
  assert.equal(empty.firstChild.textContent, "No local teams. A local team lives in this computer's oats-local.yaml and is visible only here.");
  const link = empty.querySelector('button.ct-link'); assert.equal(link.textContent, 'Add a local team'); assert.equal(link.type, 'button');
  await u.click(link);
  assert.ok(u.q('[data-section=local] .ct-form'), 'the form, in the local section'); assert.equal(u.q('.ct-empty'), null, 'the form replaces the empty card');
  assert.equal(u.doc.activeElement, u.q('.ct-form input[name=label]'));
  assert.equal(u.q('.ct-add').getAttribute('aria-expanded'), 'true');
  await u.click([...u.q('.ct-form').querySelectorAll('.ct-act')].find(b => b.textContent === 'Cancel'));
  assert.equal(u.q('.ct-form'), null); assert.equal(u.doc.activeElement, u.q('.ct-empty .ct-link'), 'the focus returns to the opener');
  await u.click(u.q('.ct-add'));
  assert.ok(u.q('[data-section=local] .ct-form'));
  await u.click([...u.q('.ct-form').querySelectorAll('.ct-act')].find(b => b.textContent === 'Cancel'));
  assert.equal(u.doc.activeElement, u.q('.ct-add'));
  assert.deepEqual([...u.q('.ct-form, .ct-empty').querySelectorAll('.ct-form input')], [], 'closed');
  assert.equal(u.q('[data-section=shared] .ct-empty'), null, 'shared teams exist');
});

test('real capture: shared teams are read-only; the default local team cannot be removed, and says why', async t => {
  const u = await mount(t);
  for (const shared of ['engineering', 'global', 'marketing']) assert.equal(u.act(shared, 'Remove'), null, 'shared: edited by a PR to the workspace, never here');
  const mine = u.act('mine', 'Remove');
  assert.equal(mine.disabled, true); assert.equal(mine.title, "Can't remove: it is the default team; 1 soul uses it. Change that first.");
  assert.equal(u.row('mine').querySelector('.ct-why').textContent, mine.title, 'the reason is on the page too, not only in a tooltip');
  assert.equal(teamInUse(teams('teams-after'), 'global'), "Can't remove: every soul may join it. Change that first.");
  assert.equal(teamInUse(teams('teams-after'), 'engineering'), "Can't remove: 1 soul uses it. Change that first.", 'a soul default and a soul team: the same soul, counted once');
  assert.equal(teamInUse(teams('teams-add'), 'mine'), "Can't remove: it is the default team. Change that first.");
  assert.equal(teamInUse(teams('teams-after'), 'nobody'), null);
});

test('Make default: a team with no provider id cannot be the default; a mapped one asks first and sends its label (DERIVED: engineering mapped)', async t => {
  const plain = await mount(t);
  assert.equal(plain.act('mine', 'Make default'), null, 'the default has no Make default');
  assert.equal(plain.act('engineering', 'Make default').disabled, true, 'real capture: no provider id yet');
  const u = await mount(t, body => { const d = mapped(); if (body.action === 'default') { d.defaultTeam = body.label; for (const r of d.teams) r.default = r.label === body.label; } return d; });
  await u.click(u.act('engineering', 'Make default'));
  assert.equal(u.row('engineering').querySelector('.ct-confirm p').textContent, 'Make engineering the default team on this computer? Running instances keep their current default team until they are respawned.');
  assert.equal(u.doc.activeElement, u.row('engineering').querySelector('.ct-confirm .primary'));
  await u.click(u.row('engineering').querySelector('.ct-confirm .primary'));
  assert.deepEqual(u.calls.at(-1), { action: 'default', label: 'engineering' });
  assert.equal(u.row('engineering').querySelector('.ct-tag').textContent, 'Default team', 'repainted from the answer'); assert.equal(u.row('engineering').querySelector('.ct-confirm'), null);
  assert.equal(u.row('engineering').dataset.default, 'true'); assert.equal(u.row('mine').querySelector('.ct-tag'), null); assert.equal(u.row('mine').dataset.default, undefined);
  await u.click(u.act('mine', 'Make default')); await u.click([...u.row('mine').querySelectorAll('.ct-confirm .ct-act')].find(b => b.textContent === 'Cancel'));
  assert.equal(u.row('mine').querySelector('.ct-confirm'), null); assert.equal(u.calls.length, 2, 'Cancel sends nothing');
  assert.equal(u.doc.activeElement, u.act('mine', 'Make default'), 'Cancel returns the focus to Make default');
});

test("Add a local team: label + an existing id; the kernel's refusals (captured) verbatim; a label is lowercase; the form keeps what was typed", async t => {
  const u = await mount(t, body => body.action !== 'add' ? teams('teams-initial')
    : body.label === 'mine' ? Promise.reject(refused('teams-add-exists')) : body.label === 'engineering' ? Promise.reject(refused('teams-add-shared')) : teams('teams-add'));
  await u.click(u.q('.ct-page-head .ct-add'));
  const form = u.q('[data-section=local] .ct-form');
  assert.deepEqual([...form.querySelectorAll('.ct-field > input')].map(i => i.name), ['label', 'team', 'description'], 'each input framed by its one wrapper');
  assert.deepEqual([...form.querySelectorAll('label')].map(l => l.firstChild.textContent), ['Label', 'Team id', 'Description (optional)']);
  assert.equal(form.querySelector('.ct-hint').textContent, 'To create a new team, run oats aweb setup.');
  assert.equal(u.doc.activeElement, form.querySelector('input[name=label]'));
  const submit = async () => { u.q('.ct-form button[type=submit]').click(); await tick(); };
  const type = (name, value) => { const input = u.q(`.ct-form input[name=${name}]`); input.value = value; input.dispatchEvent(new u.dom.window.Event('input', { bubbles: true })); };
  await submit();
  assert.equal(u.q('.ct-error p').textContent, 'A local team needs a label and its provider team id.'); assert.equal(u.calls.length, 1, 'nothing sent');
  type('label', 'Mine'); type('team', 'mine:alex.aweb.ai'); await submit();
  assert.equal(u.q('.ct-error p').textContent, 'A label is lowercase letters and digits, with . _ or - after the first character.'); assert.equal(u.calls.length, 1, "the kernel's grammar, said before sending");
  type('label', 'engineering'); await submit();
  assert.deepEqual(u.calls.at(-1), { action: 'add', label: 'engineering', team: 'mine:alex.aweb.ai' });
  assert.equal(u.q('.ct-error p').textContent, 'team engineering is already declared (shared, in oats-workspace.yaml)', 'real: a shared label is E_TEAM_EXISTS');
  assert.equal(u.q('.ct-error pre').textContent, 'E_TEAM_EXISTS');
  type('label', 'mine'); await submit();
  assert.equal(u.q('.ct-error p').textContent, 'team mine is already declared (local, in oats-local.yaml): remove it first (`oats teams remove`) to redefine it');
  assert.equal(u.q('.ct-form input[name=label]').value, 'mine', 'kept for a fix');
  type('label', 'scratch'); type('description', '  Try-outs  '); await submit();
  assert.deepEqual(u.calls.at(-1), { action: 'add', label: 'scratch', team: 'mine:alex.aweb.ai', description: 'Try-outs' });
  assert.equal(u.q('.ct-form'), null, 'added: the form closes');
});

test("a stale view: the kernel's captured E_TEAM_IN_USE on Remove is shown under its row with the code (DERIVED: mine shown unused)", async t => {
  const stale = () => { const d = teams('teams-add'); d.defaultTeam = null; for (const r of d.teams) r.default = false; return d; };
  const u = await mount(t, body => body.action === 'remove' ? Promise.reject(refused('teams-remove-in-use')) : stale());
  await u.click(u.act('mine', 'Remove'));
  assert.deepEqual(u.calls.at(-1), { action: 'remove', label: 'mine' });
  assert.equal(u.row('mine').querySelector('.ct-error p').textContent, 'team mine is still referenced (defaultTeam, souls.teams:release-manager): remove the references first (`oats teams default`, `oats soul teams … --remove mine`)');
  assert.equal(u.row('mine').querySelector('.ct-error pre').textContent, 'E_TEAM_IN_USE');
});

test('no teams yet: both sections say so; a failed read says so', async t => {
  const empty = await mount(t, () => ({ ...teams('teams-initial'), defaultTeam: null, teams: [], souls: { teams: {}, default: {} }, problems: [] }));
  assert.equal(empty.q('[data-section=shared] .ct-empty').textContent, "No shared teams. A shared team is declared in the workspace's oats-workspace.yaml and committed, so every computer running the workspace has it.");
  assert.match(empty.q('[data-section=local] .ct-empty').textContent, /^No local teams\./);
  const failed = await mount(t, () => Promise.reject(refusal('E_CLI_PROTOCOL', 'oats teams answered something this Desktop cannot read')));
  assert.equal(failed.q('.ct-error p').textContent, 'oats teams answered something this Desktop cannot read');
});

test('Setup has no Teams box: teams live on the Workspace Teams tab (workspace-v2-view.test.mjs); the 0.29 box is teamsBox', async t => {
  const dom = new JSDOM('<!doctype html><body><div></div></body>'), doc = dom.window.document; t.after(() => dom.window.close());
  const status = { workspace: { name: 'oats', key: 'k', teams: ['global'] }, members: [], packages: [] };
  const host = doc.querySelector('div');
  renderSetup(host, { status });
  assert.deepEqual([...host.querySelectorAll('[data-box]')].map(b => b.dataset.box).filter(b => /Teams/.test(b)), []);
  const box = teamsBox(doc, { status });
  assert.equal(box.dataset.box, 'Teams'); assert.deepEqual([...box.querySelectorAll('[data-team]')].map(r => r.dataset.team), ['global']);
  assert.equal(box.querySelector('.setup-scope'), null, 'box() draws no scope chip for any caller');
});

test("the default team's problem (default: true) is blocking: said as such, with the kernel's words and fix, and another default offered (DERIVED: engineering the default)", async t => {
  const d = teams('teams-after'); d.defaultTeam = 'engineering'; for (const r of d.teams) r.default = r.label === 'engineering';
  for (const p of d.problems) if (p.label === 'engineering') p.default = true;
  const u = await mount(t, () => structuredClone(d));
  const block = u.row('engineering').querySelector('.ct-blocking');
  assert.equal(block.getAttribute('role'), 'alert');
  assert.deepEqual([...u.row('engineering').children].slice(0, 3).map(c => c.className), ['ct-head', 'ct-blocking', 'ct-facts'], 'between the header and the facts');
  assert.deepEqual([...block.children].map(c => c.textContent), ['The default team engineering has no provider id yet: nothing can be spawned until it has one.',
    'shared team engineering has no provider id yet', 'its owner runs `oats aweb setup`, then commits the id', 'Or make another team the default.']);
  assert.equal(u.row('global').querySelector('.ct-blocking'), null, 'a non-default unmapped team only warns');
  assert.ok(u.row('global').querySelector('.ct-warn'));
});

test("the routes' answer (#269 df06befe, docs/desktop-teams.md): ok → the decoded document under its key; refused → the reason, verbatim", () => {
  const doc = teams('teams-initial');
  assert.equal(teamsAnswer({ status: 'ok', teams: doc }, 'teams', 'x'), doc);
  assert.throws(() => teamsAnswer({ status: 'ok', soulTeams: doc }, 'teams', 'The teams on this computer could not be read.'), /could not be read/, 'the wrong key is not read');
  const refused = reason => { try { teamsAnswer({ status: 'refused', reason }, 'teams', 'The teams on this computer could not be read.'); } catch (e) { return [e.code, e.message]; } return null; };
  const inUse = capture('teams-remove-in-use').error;
  assert.deepEqual(refused(inUse), ['E_TEAM_IN_USE', inUse.message], "the kernel's words (captured)");
  assert.deepEqual(refused({ code: 'E_BUSY', message: 'Another change is in progress. Try again.' }), ['E_BUSY', 'Another change is in progress. Try again.'], "the Desktop's own words");
  assert.deepEqual(refused({ code: 'E_CLI_PROTOCOL' }), ['E_CLI_PROTOCOL', 'The teams on this computer could not be read.'], 'no message: the fallback, with the code');
});

test('#1879: a reprobe above the tested bound holds every team write back with the notice, an open form kept; a reprobe into the bound gives each its own state back', async t => {
  const cs = await import('../renderer/views/cli-status.mjs');
  const cli = (extra = {}) => ({ ok: true, bin: '/oats', version: '0.70.1', source: 'path', required: { desktopApi: 1, range: '>=0.26.0, tested through 0.69' }, tried: [], features: [], ...extra });
  let probe = cli({ version: '0.69.25' });
  const cliCtx = { api: async () => probe };
  await cs.refreshCli(cliCtx);
  t.after(() => cs.resetCliStateForTests());
  const u = await mount(t);
  await u.click(u.q('.ct-add'));
  const form = u.q('.ct-form'), label = form.querySelector('input[name=label]');
  label.value = 'half'; label.dispatchEvent(new u.dom.window.Event('input', { bubbles: true }));
  const controls = () => [u.q('.ct-add'), u.act('mine', 'Remove'), u.q('.ct-form button[type=submit]')].map(b => [b.disabled, b.title]);
  const within = controls();
  assert.deepEqual([within[0], within[2]], [[false, ''], [false, '']], 'within the bound: Add and its submit are on');
  assert.equal(within[1][0], true, "mine's Remove is off for its own reason"); assert.match(within[1][1], /\S/, 'which its title says');
  const calls = u.calls.length;

  probe = cli({ aboveTested: true, testedThrough: '0.69' });
  await cs.refreshCli(cliCtx); await tick();
  const notice = cs.cliHeldBack('POST /api/workspace-teams add');
  assert.match(notice, /^This Desktop was tested with oats CLIs up to 0\.69; the installed CLI is 0\.70\.1\. /);
  assert.deepEqual(controls(), [[true, notice], [true, notice], [true, notice]], 'held back, with no repaint');
  assert.equal(u.q('.ct-form'), form, 'the open form is kept'); assert.equal(label.value, 'half', 'with what was typed');
  form.dispatchEvent(new u.dom.window.Event('submit', { cancelable: true })); await tick();
  assert.equal(u.calls.length, calls, 'a held-back submit runs nothing');

  probe = cli({ version: '0.69.25' });
  await cs.refreshCli(cliCtx); await tick();
  assert.deepEqual(controls(), within, 'each control has its own state back');
  assert.equal(u.q('.ct-form'), form);
});

test('#1879: an open Make default confirmation follows a reprobe: held back above the tested bound, its click sends nothing, Cancel stays usable; given back within it', async t => {
  const cs = await import('../renderer/views/cli-status.mjs');
  const cli = (extra = {}) => ({ ok: true, bin: '/oats', version: '0.70.1', source: 'path', required: { desktopApi: 1, range: '>=0.26.0, tested through 0.69' }, tried: [], features: [], ...extra });
  let probe = cli({ version: '0.69.25' });
  const cliCtx = { api: async () => probe };
  await cs.refreshCli(cliCtx);
  t.after(() => cs.resetCliStateForTests());
  const u = await mount(t, () => mapped());
  await u.click(u.act('engineering', 'Make default'));
  const confirm = u.row('engineering').querySelector('.ct-confirm');
  const primary = () => confirm.querySelector('.primary'), cancel = () => [...confirm.querySelectorAll('.ct-act')].find(b => b.textContent === 'Cancel');
  assert.deepEqual([primary().disabled, primary().title], [false, ''], 'within the bound: the confirmation is on');

  probe = cli({ aboveTested: true, testedThrough: '0.69' });
  await cs.refreshCli(cliCtx); await tick();
  const notice = cs.cliHeldBack('POST /api/workspace-teams add');
  assert.match(notice, /^This Desktop was tested with oats CLIs up to 0\.69; the installed CLI is 0\.70\.1\. /);
  assert.equal(u.row('engineering').querySelector('.ct-confirm'), confirm, 'the open confirmation is kept');
  assert.deepEqual([primary().disabled, primary().title], [true, notice], 'held back, with no repaint');
  const calls = u.calls.length;
  await u.click(primary());
  assert.equal(u.calls.length, calls, 'a held-back confirmation sends nothing');
  assert.equal(cancel().disabled, false, 'Cancel stays usable');

  probe = cli({ version: '0.69.25' });
  await cs.refreshCli(cliCtx); await tick();
  assert.deepEqual([primary().disabled, primary().title], [false, ''], 'given back within the bound');
  await u.click(cancel());
  assert.equal(u.row('engineering').querySelector('.ct-confirm'), null, 'and Cancel closes it');
});

test('#1879: after disposal a CLI change touches the team page no more', async t => {
  const cs = await import('../renderer/views/cli-status.mjs');
  const cli = (extra = {}) => ({ ok: true, bin: '/oats', version: '0.70.1', source: 'path', required: { desktopApi: 1, range: '>=0.26.0, tested through 0.69' }, tried: [], features: [], ...extra });
  let probe = cli({ version: '0.69.25' });
  const cliCtx = { api: async () => probe };
  await cs.refreshCli(cliCtx);
  t.after(() => cs.resetCliStateForTests());
  const u = await mount(t);
  const add = u.q('.ct-add');
  u.card.dispose();
  probe = cli({ aboveTested: true, testedThrough: '0.69' });
  await cs.refreshCli(cliCtx); await tick();
  assert.deepEqual([add.disabled, add.title], [false, ''], 'unsubscribed on disposal');
});
