// A team's page (packages/desktop/docs/desktop-teams.md "A team's page"): the board card opens it; the Teams
// controller paints it into the host views/spawn.mjs gives it (showTeam) and keeps it current by the pages' rule
// (a repaint only when what it shows changed, focus put back by key, else Back), and says when its team is gone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createComputerTeams, computerTeamsCSS, soulShort } from '../renderer/computer-teams.mjs';
import { ageText } from '../renderer/age-text.mjs';

const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
const team = (label, extra = {}) => ({ label, team: `${label}:acme.aweb.ai`, description: null, from: 'shared', default: false, at: 'x', ...extra });
/** Team model 3 with local teams allowed: home (local, this deployment's default), eng (shared), spare (local, no id). */
const document = () => ({ teamsApi: 2, deployment: '/d', localTeams: true, problems: [], souls: {},
  defaultTeam: { label: 'home', team: 'home:acme.aweb.ai', from: 'deployment' },
  teams: [team('home', { from: 'local', default: true }), team('eng', { description: 'Engineering' }), team('spare', { from: 'local', team: null })] });
const HERE = { id: '/d', machine: 'This Mac', path: '/Users/ana/Agents/acme' }, FAR = { id: 'remote:build:1', machine: 'build', path: '/srv/acme' };
const member = (instance, extra = {}) => ({ workspace: '/d', deployment: { ...HERE }, server: null, serverLabel: null, instance, agent: 'acme-agents/release-manager',
  agentsRoot: '/d/agents', home: `/d/agents/release-manager/instances/${instance}`, team: 'eng:acme.aweb.ai', running: true, addressable: true,
  missingRemotely: false, reason: null, reasonLabel: null, createdAt: '2026-10-14T10:00:00.000Z', ...extra });
const far = (instance, extra = {}) => member(instance, { workspace: FAR.id, deployment: { ...FAR }, server: 'build', serverLabel: 'build', ...extra });

async function mount(t, { members = [member('release-manager-1'), member('release-manager-2', { running: false }), far('w-3', { agent: 'acme/writer' })],
  answer = () => document(), opened = [] } = {}) {
  const dom = new JSDOM('<!doctype html><body><main class="oats-view"><div class="board"></div><section class="workspace-page"></section></main></body>', { pretendToBeVisual: true });
  const doc = dom.window.document;
  const style = doc.createElement('style'); style.textContent = computerTeamsCSS; doc.head.append(style);
  let roster = { members, servers: [{ server: 'build', label: 'build', group: 'build:1', deployment: FAR.id, reached: true, error: null, registered: true }], notReached: [] };
  const calls = [];
  const teams = createComputerTeams(doc, { request: async body => { calls.push(body); return answer(body); }, readMembers: async () => structuredClone(roster), onOpenTeam: label => opened.push(label) });
  doc.querySelector('.board').append(teams.element);
  t.after(() => { teams.dispose(); dom.window.close(); });
  await tick();
  const host = doc.querySelector('.workspace-page'), events = [];
  const show = label => teams.showTeam(host, label, { onBack: () => events.push('back'), onGone: () => events.push('gone') });
  return { dom, doc, teams, host, calls, events, opened, show, board: s => teams.element.querySelector(s), p: s => host.querySelector(s), pall: s => [...host.querySelectorAll(s)],
    roster: async next => { roster = next; teams.syncRoster(); await tick(); } };
}

test('the board card opens its page: its name is the one control that does, named by the label; Make default and Remove do not', async t => {
  const u = await mount(t);
  const card = u.board('[data-team="eng"]'), open = card.querySelector('h4.ct-name-h > button.ct-open');
  assert.equal(open.textContent, 'eng'); assert.equal(open.type, 'button');
  assert.equal(open.getAttribute('aria-description'), "Opens the team's page with your agents on it");
  assert.ok(card.classList.contains('ct-openable'));
  open.click(); assert.deepEqual(u.opened, ['eng']);
  card.querySelector('.ct-head .ct-actions button').click(); await tick();
  assert.deepEqual(u.opened, ['eng'], 'Make default opens its confirmation, not the page');
  assert.ok(u.board('[data-team="eng"] .ct-confirm'));
  // One tab stop per card when it has nothing else to do: the name.
  assert.deepEqual([...u.board('[data-team="spare"]').querySelectorAll('button:not(:disabled)')].map(b => b.className), ['ct-open', 'ct-act'], 'spare: its name and Remove');
  const go = u.board('[data-team="eng"] .ct-foot .ct-go');
  assert.equal(go.getAttribute('aria-hidden'), 'true'); assert.equal(go.textContent, 'Open team');
  // The whole card is the click target: the name's ::after covers it, the card's own controls sit above it.
  const rule = selector => { const m = computerTeamsCSS.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`, 'm')); assert.ok(m, selector); return m[1]; };
  assert.match(rule('.computer-teams .ct-card.ct-openable'), /position:relative; cursor:pointer/);
  assert.match(rule('.oats-view .computer-teams button.ct-open::after'), /content:''; position:absolute; inset:0/);
  assert.match(rule('.computer-teams .ct-card.ct-openable :is(.ct-actions, .ct-confirm, .ct-error, a[href])'), /position:relative; z-index:1/);
  assert.match(rule('.computer-teams .ct-card.ct-openable:hover'), /border-color:var\(--tree-line\)/);
  assert.match(rule('.computer-teams .ct-card.ct-openable:hover .ct-open'), /text-decoration:underline/);
  assert.doesNotMatch(computerTeamsCSS, /ct-open[^{]*:focus|ct-card[^{]*outline/, 'the ring is the shell\'s own, on the name');
});

test('the page: one grid for every machine\'s card, cards, tables and rows as its subgrids; the soul\'s prefix steps back from the name', async t => {
  const u = await mount(t);
  assert.equal(u.show('eng'), true);
  const lists = u.pall('.ct-mcards > .ct-mcard > .ct-ilist');
  assert.equal(lists.length, 2, 'This Mac and build, in one grid');
  assert.equal(u.pall('.ct-mcards').length, 1);
  for (const list of lists) { assert.equal(list.getAttribute('style'), null, 'no columns of its own'); assert.equal(list.className, 'ct-ilist'); }
  const rule = selector => computerTeamsCSS.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`, 'm'))?.[1];
  assert.match(rule('.computer-teams .ct-mcards'), /display:grid; grid-template-columns:1fr minmax\(0,.4fr\) 200px 84px 104px/, 'one source for the columns');
  for (const selector of ['.computer-teams .ct-mcard', '.computer-teams .ct-ilist']) assert.match(rule(selector), /grid-column:1 \/ -1; display:grid; grid-template-columns:subgrid;/, selector);
  assert.match(rule('.computer-teams .ct-mcard-head'), /grid-column:1 \/ -1;/);
  assert.equal(computerTeamsCSS.match(/grid-template-columns:1fr minmax\(0,\.4fr\)|grid-template-columns:1fr minmax\(0,200px\)|grid-template-columns:minmax\(0,1fr\) minmax\(0,max-content\)/g).length, 4, 'and its narrower templates, nowhere else');
  assert.match(rule('.computer-teams .ct-irow'), /grid-column:1 \/ -1; display:grid; grid-template-columns:subgrid;.*min-height:46px/);
  assert.doesNotMatch(computerTeamsCSS.split('\n').filter(line => /ct-(ilist|irow|iname|mcard)/.test(line)).join('\n'), /display:contents/, 'the rows keep their semantics');
  // Names first: from a 760px container the name's cell is as wide as the name, cut only past the row's room
  // (--ct-name-room); Created hides under 1000px and Soul under 900px to make room; under 760px a name may be cut,
  // whole in its title.
  assert.match(rule('.computer-teams .ct-irow > .ct-iname'), /min-width:max-content/);
  assert.match(rule('.oats-view .computer-teams button.ct-member-name'), /max-width:var\(--ct-name-room\); white-space:nowrap; overflow:hidden; text-overflow:ellipsis/);
  // The room is the page's width less everything else on the row, read from the rules that set each part, so a
  // padding or a column that changes without it fails here: the column's padding, the card's borders, the row's
  // padding, the mark and its gap, the name cell's padding, 4px to spare; then the other columns at their least.
  const px = (selector, re) => Number(rule(selector).match(re)[1]);
  const fixed = px('.computer-teams.ct-team-page', /padding:\d+px (\d+)px/) * 2 + px('.computer-teams .ct-mcard', /border:(\d+)px/) * 2
    + px('.computer-teams .ct-irow', /padding:0 (\d+)px/) * 2 + px('.computer-teams .ct-iname .identity-mark', /width:(\d+)px/)
    + px('.computer-teams .ct-irow > .ct-iname', /gap:(\d+)px/) + px('.computer-teams .ct-irow > .ct-iname', /padding-right:(\d+)px/) + 4;
  assert.equal(fixed, 136);
  assert.match(rule('.computer-teams.ct-team-page'), /max-width:1120px/);
  assert.match(rule('.computer-teams .ct-mcards'), /--ct-name-room:calc\(min\(100cqi, 1120px\) - 136px - 388px\)/, 'Soul 0, State 200, Created 84, Terminal 104');
  const block = width => computerTeamsCSS.match(new RegExp(`@container \\(max-width: ${width}px\\) \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
  assert.match(block('999\\.98'), /\.ct-mcards \{ grid-template-columns:1fr minmax\(0,.4fr\) 200px 104px; --ct-name-room:calc\(min\(100cqi, 1120px\) - 136px - 304px\); \}\n \.computer-teams \.ct-ilist \.ct-age, \.computer-teams \.ct-ihead > :nth-child\(4\) \{ display:none; \}/);
  assert.match(block('899\\.98'), /\.ct-mcards \{ grid-template-columns:1fr minmax\(0,200px\) 104px; --ct-name-room:calc\(min\(100cqi, 1120px\) - 136px - 200px\); \}\n \.computer-teams \.ct-ilist \.ct-isoul, \.computer-teams \.ct-ihead > :nth-child\(2\) \{ display:none; \}/);
  assert.match(block('759\\.98'), /\.ct-mcards \{ grid-template-columns:minmax\(0,1fr\) minmax\(0,max-content\) 104px; column-gap:12px; --ct-name-room:none; \}\n \.computer-teams \.ct-irow > \.ct-iname \{ min-width:0; \}/);
  assert.ok(computerTeamsCSS.indexOf('max-width: 999.98px') < computerTeamsCSS.indexOf('max-width: 899.98px') && computerTeamsCSS.indexOf('max-width: 899.98px') < computerTeamsCSS.indexOf('max-width: 759.98px'), 'the narrowest wins');
  const rows = u.pall('.ct-irow:not(.ct-ihead)');
  const name = r => r.querySelector('.ct-member-name');
  assert.deepEqual(rows.map(r => [...name(r).children].map(c => [c.className, c.textContent])),
    [[['ct-name-pre', 'release-manager-'], ['ct-name-tail', '1']], [['ct-name-pre', 'release-manager-'], ['ct-name-tail', '2']], [['ct-name-tail', 'w-3']]]);
  assert.deepEqual(rows.map(r => name(r).getAttribute('aria-label')), ['Show release-manager-1 in the roster', 'Show release-manager-2 in the roster', 'Show w-3 in the roster'], 'the full name');
  assert.equal(rows[0].querySelector('.ct-iname .identity-mark').title, 'acme-agents/release-manager', 'the full soul on the mark');
  assert.equal(soulShort('acme-agents/release-manager'), 'release-manager'); assert.equal(soulShort('pkg--writer'), 'writer'); assert.equal(soulShort(''), '');
  assert.equal(rows[0].querySelector('.ct-age').textContent, ageText('2026-10-14T10:00:00.000Z'));
  assert.equal(rows[2].querySelector('.ct-member-term').getAttribute('aria-label'), 'Open w-3 terminal on build');
  assert.equal(u.p('.ct-default-note'), null, 'eng is not the default: no note');
});

test('the page repaints only when what it shows changed, and puts focus back on the same instance\'s control', async t => {
  const u = await mount(t);
  u.show('eng');
  const content = u.p('.ct-team-page'), card = content.querySelector('.ct-page-card'), back = u.p('.page-back');
  await u.roster({ members: [member('release-manager-1'), member('release-manager-2', { running: false }), far('w-3', { agent: 'acme/writer' })], servers: [{ server: 'build', label: 'build', group: 'build:1', deployment: FAR.id, reached: true, error: null, registered: true }], notReached: [] });
  assert.equal(content.querySelector('.ct-page-card'), card, 'the same answer: nothing repainted');
  const term = [...content.querySelectorAll('.ct-member-term')].find(b => b.getAttribute('aria-label').startsWith('Open w-3')); term.focus();
  await u.roster({ members: [member('release-manager-1', { running: false }), far('w-3', { agent: 'acme/writer' })], servers: [], notReached: [] });
  assert.notEqual(content.querySelector('.ct-page-card'), card, 'repainted');
  assert.equal(u.pall('.ct-irow:not(.ct-ihead)').length, 2);
  assert.equal(u.doc.activeElement.getAttribute('aria-label'), 'Open w-3 terminal on build', 'the same instance\'s Terminal, found by its key');
  assert.notEqual(u.doc.activeElement, term);
  await u.roster({ members: [member('release-manager-1')], servers: [], notReached: [] });
  assert.equal(u.doc.activeElement, back, 'its instance left: Back');
});

test('the page\'s card keeps its actions: Make default asks first, Cancel returns to it; Remove closes the page once the document answers', async t => {
  const u = await mount(t, { answer: body => { const d = document(); if (body.action === 'remove') d.teams = d.teams.filter(x => x.label !== body.label); return d; } });
  u.show('eng');
  const make = u.p('.ct-page-card .ct-head .ct-actions button');
  assert.equal(make.textContent, 'Make default'); make.click(); await tick();
  assert.equal(u.p('.ct-page-card .ct-confirm p').textContent, 'Make eng the default team on this computer? Running instances keep their current default team until they are respawned.');
  assert.equal(u.doc.activeElement, u.p('.ct-confirm .primary'));
  [...u.pall('.ct-confirm .ct-act')].find(b => b.textContent === 'Cancel').click(); await tick();
  assert.equal(u.p('.ct-confirm'), null); assert.equal(u.doc.activeElement, u.p('.ct-page-card .ct-head .ct-actions button'), 'back on Make default');
  assert.deepEqual(u.calls, [{ action: 'list' }], 'nothing sent');
  // Remove spare from its page: the page waits for the answer, then says its team is gone.
  u.teams.hideTeam(); u.show('spare');
  assert.equal(u.p('.ct-team-page [data-section=yours] .ct-dashed').textContent, 'This team has no provider id yet, so no agent can be on it.');
  [...u.pall('.ct-page-card .ct-head .ct-actions button')].find(b => b.textContent === 'Remove').click();
  assert.deepEqual(u.events, [], 'not before the answer');
  await tick();
  assert.deepEqual(u.calls.at(-1), { action: 'remove', label: 'spare' });
  assert.deepEqual(u.events, ['gone']);
});

test('the page\'s empty states, and a team that leaves the document or a disposed controller close it', async t => {
  const u = await mount(t, { members: [] });
  assert.equal(u.show('nope'), false, 'no such team: nothing shown');
  assert.equal(u.show('home'), true);
  assert.equal(u.p('[data-section=yours] .ct-dashed').textContent, 'None of your agents is on home.');
  assert.equal(u.p('[data-section=yours] .ct-dashed').tagName, 'P', 'a sentence, not a card');
  assert.equal(u.board('[data-team="home"] .ct-sum').textContent, 'None of your agents');
  u.p('.page-back').click(); assert.deepEqual(u.events, ['back']);
  u.teams.dispose();
  assert.deepEqual(u.events, ['back', 'gone'], 'the page\'s owner went away');
});

test('a failed read shows on the open page, in its card, as the board says it; the add form\'s errors stay on the board', async t => {
  let fail = false;
  const u = await mount(t, { answer: () => { if (fail) throw Object.assign(new Error('oats teams timed out.'), { code: 'E_CLI_TIMEOUT' }); return document(); } });
  u.show('eng');
  assert.equal(u.p('.ct-error'), null);
  fail = true; await u.teams.refresh();
  const error = u.p('.ct-page-card > .ct-error'), onBoard = u.board('[data-section=local] .ct-error');
  assert.ok(error, 'in the page\'s card'); assert.equal(error.getAttribute('role'), 'alert');
  assert.equal(error.querySelector('p').textContent, 'oats teams timed out.'); assert.equal(error.querySelector('pre').textContent, 'E_CLI_TIMEOUT');
  assert.equal(error.textContent, onBoard.textContent, 'the board\'s words');
  assert.equal(u.p('.ct-page-card').lastElementChild, error, 'after the card\'s confirmation and row error');
  fail = false; await u.teams.refresh();
  assert.equal(u.p('.ct-error'), null, 'a read that answers clears it');
  // An answer with no teams: the document could not be read.
  let empty = false;
  const unreadable = await mount(t, { answer: () => empty ? {} : document() });
  unreadable.show('eng'); empty = true; await unreadable.teams.refresh();
  assert.equal(unreadable.p('.ct-page-card > .ct-error p').textContent, 'The teams on this computer could not be read.');
  // The add form's own error is the board's alone.
  u.teams.hideTeam(); u.board('.ct-add').click(); await tick();
  u.board('.ct-form').dispatchEvent(new u.dom.window.Event('submit', { cancelable: true })); await tick();
  assert.equal(u.board('[data-section=local] .ct-error p').textContent, 'A team of this computer needs a label and its provider team id.');
  u.show('eng');
  assert.equal(u.p('.ct-error'), null);
});

test('closing the page ends a Make default confirmation opened on it, and the board redraws again', async t => {
  const u = await mount(t);
  u.show('eng');
  u.p('.ct-page-card .ct-head .ct-actions button').click(); await tick();
  assert.ok(u.p('.ct-confirm')); assert.ok(u.board('[data-team="eng"] .ct-confirm'), 'the board\'s card holds it too, under the barrier');
  u.teams.hideTeam();
  assert.equal(u.board('.ct-confirm'), null, 'off the board\'s card');
  await u.roster({ members: [member('release-manager-1')], servers: [], notReached: [] });
  assert.equal(u.board('[data-team="eng"] .ct-sum').textContent, '1 of your agents', 'the barrier is released: the roster change redraws the board');
  // Its team leaving the document closes the page the same way.
  let gone = false;
  const v = await mount(t, { answer: () => { const d = document(); if (gone) d.teams = d.teams.filter(x => x.label !== 'eng'); return d; } });
  v.show('eng');
  v.p('.ct-page-card .ct-head .ct-actions button').click(); await tick();
  gone = true; await v.teams.refresh();
  assert.deepEqual(v.events, ['gone']); assert.equal(v.board('.ct-confirm'), null);
  await v.roster({ members: [member('release-manager-1', { team: 'home:acme.aweb.ai' })], servers: [], notReached: [] });
  assert.equal(v.board('[data-team="home"] .ct-sum').textContent, '1 of your agents', 'the board redraws');
});

test('a board card\'s problem boxes sit above its stretched name: their text is selected, not a click that opens', async t => {
  const u = await mount(t, { answer: () => { const d = document(); d.problems = [{ label: 'eng', severity: 'warning', code: 'team-unused', message: 'No soul may join eng.', fix: 'Add eng to a soul\'s teams in oats-workspace.yaml.' }]; return d; } });
  const card = u.board('[data-team="eng"]'), warn = card.querySelector(':scope > .ct-warn');
  assert.equal(warn.querySelector('.ct-fix').textContent, 'Add eng to a soul\'s teams in oats-workspace.yaml.');
  warn.click(); warn.querySelector('.ct-fix').click();
  assert.deepEqual(u.opened, [], 'a click on the box opens nothing');
  card.querySelector('.ct-open').click(); assert.deepEqual(u.opened, ['eng'], 'the name still does');
  const rule = computerTeamsCSS.match(/^\.computer-teams \.ct-card\.ct-openable > :is\(\.ct-blocking, \.ct-warn\) \{([^}]*)\}/m);
  assert.ok(rule, 'the boxes are raised'); assert.match(rule[1], /position:relative; z-index:1; cursor:auto/);
  assert.deepEqual([...card.querySelectorAll('button:not(:disabled), a[href], [tabindex]')].map(b => b.className), ['ct-open', 'ct-act'], 'still the name, then Make default: no new Tab stop');
});
