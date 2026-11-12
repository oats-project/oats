// Spec 02, as redesigned (packages/desktop/docs/desktop-teams.md "A team's page"): a team's members wherever they run
// (/api/team-members), on the team's page by machine; the board card sums them up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createComputerTeams, computerTeamsCSS, memberGroups, memberSummary, memberState, openBlocked, stateKind } from '../renderer/computer-teams.mjs';

const TEAM = 'aweb:alex.aweb.ai';
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
const doc = { schemaVersion: 1, defaultTeam: 'alex', teams: [{ label: 'alex', team: TEAM, from: 'local', default: true }], souls: { teams: {}, default: {} }, problems: [] };
const m = (instance, extra = {}) => ({ workspace: '/w', server: null, serverLabel: null, instance, agent: 'dev', agentsRoot: '/w/agents',
  home: `/w/agents/dev/instances/${instance}`, team: TEAM, running: true, addressable: true, missingRemotely: false, reason: null, createdAt: null, ...extra });
const far = (instance, server, extra = {}) => m(instance, { workspace: `remote:${server}:1`, server, serverLabel: `${server[0].toUpperCase()}${server.slice(1)} box`,
  agentsRoot: '/srv/agents', home: `/srv/agents/dev/instances/${instance}`, ...extra });
const server = (name, extra = {}) => ({ server: name, label: `${name[0].toUpperCase()}${name.slice(1)} box`, group: `${name}:1`, reached: true, error: null, registered: true, souls: ['dev'], ...extra });

/** The board, and alex's page open in its own host (as views/spawn.mjs shows it): `q`/`all` read the board, `p`/`pall` the page. */
async function mount(t, answer, { onMember = () => {} } = {}) {
  const dom = new JSDOM('<!doctype html><body><main class="oats-view"><div class="board"></div><section class="workspace-page"></section></main></body>', { pretendToBeVisual: true }), d = dom.window.document;
  const style = d.createElement('style'); style.textContent = computerTeamsCSS; d.head.append(style);
  let current = answer;
  const card = createComputerTeams(d, { request: async () => structuredClone(doc), readMembers: async () => structuredClone(current), onMember, onOpenTeam: () => {} });
  d.querySelector('.board').append(card.element);
  t.after(() => { card.dispose(); dom.window.close(); });
  await tick();
  const host = d.querySelector('.workspace-page');
  assert.equal(card.showTeam(host, 'alex', { onBack: () => {} }), true);
  return { dom, doc: d, card, host, set: next => { current = next; }, q: s => card.element.querySelector(s), all: s => [...card.element.querySelectorAll(s)],
    p: s => host.querySelector(s), pall: s => [...host.querySelectorAll(s)] };
}

test('memberGroups: this computer first, then servers by label in code points (id breaks ties); members by name, then home', () => {
  const groups = memberGroups([
    far('b', 'zeta'), m('b'), far('a', 'alpha'), m('a', { home: '/w/agents/qa/instances/a' }), m('a'),
    far('c', 'beta', { serverLabel: 'Same' }), far('d', 'alpha2', { serverLabel: 'Same' }), far('e', 'Bravo', { serverLabel: 'Bravo box' }),
  ], []);
  assert.deepEqual(groups.map(g => g.label), ['This computer', 'Alpha box', 'Bravo box', 'Same', 'Same', 'Zeta box'], 'code points: uppercase before lowercase, no locale folding');
  assert.deepEqual(groups.filter(g => g.label === 'Same').map(g => g.server), ['alpha2', 'beta'], 'the server id breaks a label tie');
  assert.deepEqual(groups[0].members.map(x => x.home), ['/w/agents/dev/instances/a', '/w/agents/qa/instances/a', '/w/agents/dev/instances/b']);
  assert.deepEqual(groups.map(g => [g.machine, g.path]), [['This computer', null], ['Alpha box', null], ['Bravo box', null], ['Same', null], ['Same', null], ['Zeta box', null]],
    'an older route (no deployments): the machine is the label, and there is no path');
});

test('memberGroups: a group whose roster read failed is not reached, with the server\'s error', () => {
  const [group] = memberGroups([far('a', 'down', { running: null })], [server('down', { reached: false, error: 'ssh failed: timeout' })]);
  assert.equal(group.reached, false); assert.equal(group.error, 'ssh failed: timeout');
});

test('memberGroups: one server\'s two groups (an edited registration): the machine stays reached while one answers; not reached only when all failed', () => {
  const old = far('legacy', 'build', { workspace: 'remote:build:old', running: null, reason: 'ssh failed' }), current = far('now', 'build');
  const partial = memberGroups([old, current], [server('build', { group: 'build:old', reached: false, error: 'ssh failed', registered: false }), server('build')]);
  assert.equal(partial.length, 1); assert.equal(partial[0].reached, true); assert.equal(partial[0].error, null);
  assert.deepEqual(partial[0].members.map(x => [x.instance, memberState(x)]), [['legacy', 'unknown'], ['now', 'running']]);
  const down = memberGroups([old, { ...current, running: null }], [server('build', { group: 'build:old', reached: false, error: 'ssh failed' }), server('build', { reached: false, error: 'timeout' })]);
  assert.equal(down[0].reached, false); assert.equal(down[0].error, 'ssh failed');
});

test('memberSummary: "N of your instances", ", M on other machines" when some run elsewhere, the machines not reached (each once), and "None of your instances"', () => {
  assert.equal(memberSummary([]), 'None of your instances');
  assert.equal(memberSummary([m('a')]), '1 of your instances');
  assert.equal(memberSummary([m('a'), m('b'), far('c', 'build')], [server('build')]), '3 of your instances, 1 on other machines');
  const down = [far('c', 'down', { running: null }), far('d', 'down', { workspace: 'remote:down:2', running: null }), far('e', 'build', { running: null })];
  assert.equal(memberSummary([m('a'), ...down], [server('down', { reached: false }), server('down', { group: 'down:2', reached: false }), server('build', { reached: false })]),
    '4 of your instances, 3 on other machines, Build box, Down box not reached', 'two groups on one machine name it once');
});

test('stateKind: run only when running and openable, stop when plainly stopped, warn for everything else', () => {
  assert.deepEqual([m('a'), m('a', { running: false }), m('a', { running: null }), far('a', 'b', { missingRemotely: true, running: null }),
    m('a', { addressable: false, reasonLabel: 'not reachable on X' }), m('a', { running: false, reasonLabel: 'gone from X' })].map(stateKind),
    ['run', 'stop', 'warn', 'warn', 'warn', 'warn']);
});

test('memberState and openBlocked: the state in words; Open only for a running, addressable member, else the roster\'s reason', () => {
  assert.deepEqual([m('a'), m('a', { running: false }), m('a', { running: null }), far('a', 'build', { missingRemotely: true, running: null })].map(memberState),
    ['running', 'stopped', 'unknown', 'gone']);
  assert.equal(openBlocked(m('a')), null);
  assert.equal(openBlocked(far('a', 'build')), null);
  assert.equal(openBlocked(far('a', 'build', { addressable: false, reason: 'Build box did not report this instance as reachable.' })), 'Build box did not report this instance as reachable.');
  assert.equal(openBlocked(m('a', { running: false })), 'a is not running.');
  assert.equal(openBlocked(m('a', { running: null, reason: 'a: status unknown' })), 'a: status unknown');
  assert.notEqual(openBlocked(far('a', 'build', { addressable: undefined, reason: 'x' })), null, 'only an explicit true opens (the route sends the roster\'s answer)');
});

test('the team page lists its members by machine: one card per machine, a table each; the name shows the row, Terminal only when it can open', async t => {
  const calls = [];
  const u = await mount(t, { members: [m('dev-a', { createdAt: '2026-10-14T10:00:00.000Z' }), far('far-b', 'build', { running: false }),
    far('far-c', 'down', { running: null, reason: 'ssh failed: timeout', reasonLabel: 'Down box not reached' }),
    far('far-d', 'build', { addressable: false, reason: 'Build box did not report this instance as reachable.', reasonLabel: 'not reachable on Build box' })],
    servers: [server('build'), server('down', { reached: false, error: 'ssh failed: timeout' })], notReached: [] }, { onMember: (action, x) => calls.push([action, x.instance, x.server]) });
  assert.equal(u.q('.ct-irow, .ct-member-name'), null, 'the board lists nobody');
  assert.equal(u.q('[data-team="alex"] .ct-sum').textContent, '4 of your instances, 3 on other machines, Down box not reached');
  const cards = u.pall('.ct-mcard');
  assert.deepEqual(cards.map(c => [c.getAttribute('role'), c.getAttribute('aria-label'), c.querySelector('.ct-mcard-head').textContent]),
    [['group', 'This computer', 'This computer1 instance, 1 running'], ['group', 'Build box', 'Build box2 instances, 0 running'], ['group', 'Down box', 'Down boxnot reached']]);
  assert.equal(cards[2].querySelector('.ct-mcard-head').title, 'ssh failed: timeout'); assert.ok(cards[2].classList.contains('unreached'));
  assert.equal(cards[0].querySelector('.ct-mcard-head').title, '');
  for (const c of cards) {
    const table = c.querySelector('.ct-ilist');
    assert.equal(table.getAttribute('role'), 'table'); assert.equal(table.getAttribute('aria-label'), `Your instances on alex on ${c.getAttribute('aria-label')}`);
    assert.deepEqual([...table.querySelectorAll('.ct-ihead [role=columnheader]')].map(h => h.textContent), ['Instance', 'Soul', 'State', 'Created', 'Terminal']);
    assert.ok(table.querySelector('.ct-ihead .ct-vh'), 'the Terminal header is for assistive tech only');
  }
  const rows = u.pall('.ct-irow:not(.ct-ihead)');
  const row = name => rows.find(r => r.querySelector('.ct-member-name').textContent === name);
  assert.deepEqual(rows.map(r => [r.querySelector('.ct-member-name').textContent, r.querySelector('.ct-member-state').textContent, r.querySelector('.ct-member-state').dataset.state]),
    [['dev-a', 'Running', 'running'], ['far-b', 'Stopped', 'stopped'], ['far-d', 'not reachable on Build box', 'running'], ['far-c', 'Down box not reached', 'unknown']],
    'the state in words: the Desktop\'s own Running and Stopped, else the roster\'s short label, verbatim');
  for (const [name, kind] of [['dev-a', 'run'], ['far-b', 'stop'], ['far-d', 'warn'], ['far-c', 'warn']]) assert.ok(row(name).querySelector(`.ct-member-state.${kind}`), name);
  for (const r of rows) assert.equal(r.querySelector('.ct-state-dot').getAttribute('aria-hidden'), 'true');
  // The name is the Show-in-roster control; Terminal is there only when the member can be opened.
  const name = row('dev-a').querySelector('.ct-member-name');
  assert.equal(name.tagName, 'BUTTON'); assert.equal(name.getAttribute('aria-label'), 'Show dev-a in the roster'); assert.equal(name.title, 'Show dev-a in the roster');
  const term = row('dev-a').querySelector('.ct-member-term');
  assert.equal(term.getAttribute('aria-label'), 'Open dev-a terminal on this computer'); assert.equal(term.textContent, 'Terminal');
  assert.deepEqual([...row('dev-a').querySelectorAll('button')], [name, term], 'the keyboard order: name, then Terminal');
  assert.equal(row('far-b').querySelector('.ct-isoul').textContent, 'dev'); assert.equal(row('far-b').querySelector('.ct-isoul').title, 'dev');
  assert.ok(row('far-b').querySelector('.ct-iname .identity-mark'), 'the soul\'s mark');
  assert.equal(row('dev-a').querySelector('.ct-age').title, '2026-10-14T10:00:00.000Z', 'Created: the exact time as its title');
  assert.equal(row('far-b').querySelector('.ct-age').textContent, '', 'no createdAt: an empty cell');
  for (const blocked of ['far-b', 'far-c', 'far-d']) {
    assert.equal(row(blocked).querySelector('.ct-member-term'), null, `${blocked}: no disabled button in the list`);
    assert.equal(row(blocked).querySelectorAll('button:disabled').length, 0);
    assert.equal(row(blocked).children.length, 5, 'an empty Terminal cell holds the column');
  }
  const word = row('far-d').querySelector('.ct-member-state');
  assert.equal(word.title, 'Build box did not report this instance as reachable.'); assert.equal(word.getAttribute('aria-description'), word.title);
  assert.equal(row('far-b').querySelector('.ct-member-state').title, 'far-b is not running.');
  assert.equal(row('dev-a').querySelector('.ct-member-state').hasAttribute('title'), false);
  term.click(); row('far-b').querySelector('.ct-member-name').click();
  assert.deepEqual(calls, [['open', 'dev-a', null], ['show', 'far-b', 'build']]);
});

test('the team page\'s counts: instances, running, stopped, those needing attention and the machines, from the rows shown', async t => {
  const u = await mount(t, { members: [m('dev-a'), m('dev-b', { running: false }), far('far-c', 'build', { running: null, reasonLabel: 'Build box not reached', reason: 'x' })],
    servers: [server('build')], notReached: [] });
  const sum = u.p('.ct-yours-sum');
  assert.deepEqual([...sum.children].map(c => c.textContent), ['3instances', '1running', '1stopped', '1needs attention', 'on 2 machines']);
  assert.ok(sum.querySelector('.warn b'), 'attention in the warn colour'); assert.equal(sum.lastElementChild.className, 'ct-yours-machines');
  assert.equal(u.p('.ct-default-note').textContent, 'Every instance joins its default team, so all of your instances are here.', 'alex is the default');
  u.set({ members: [m('dev-a')], servers: [], notReached: [] }); u.card.syncRoster(); await tick();
  assert.deepEqual([...u.p('.ct-yours-sum').children].map(c => c.textContent), ['1instance', '1running', 'on 1 machine'], 'no stopped, no attention: not said');
});

test('not reached: a status line under the head names every server we hold no rows for, and follows each answer even with focus inside', async t => {
  const u = await mount(t, { members: [m('dev-a')], servers: [server('far', { reached: false, error: 'ssh failed' })], notReached: [{ server: 'far', label: 'Far box' }, { server: 'nohost', label: 'nohost' }] });
  const reach = u.q('.ct-reach');
  assert.equal(reach.getAttribute('role'), 'status');
  assert.equal(reach.textContent, "Not reached: Far box, nohost. Their members aren't shown until they answer.");
  assert.equal(reach.previousElementSibling, u.q('.ct-page-head'), 'under the page head');
  u.q('.ct-add').focus();
  u.set({ members: [m('dev-a')], servers: [server('far')], notReached: [{ server: 'nohost', label: 'nohost' }] }); u.card.syncRoster(); await tick();
  assert.equal(reach.textContent, "Not reached: nohost. Their members aren't shown until they answer.");
  u.set({ members: [m('dev-a')], servers: [], notReached: [] }); u.card.syncRoster(); await tick();
  assert.equal(reach.textContent, '');
});

test('the board\'s repaint barrier holds with focus inside it: a changed roster waits until focus leaves; the team page follows at once', async t => {
  const u = await mount(t, { members: [m('dev-a')], servers: [], notReached: [] });
  const button = u.q('[data-team="alex"] .ct-open'), card = u.q('[data-team="alex"]'); button.focus();
  u.set({ members: [m('dev-a', { running: false }), m('dev-b')], servers: [], notReached: [] }); u.card.syncRoster(); await tick();
  assert.equal(u.q('[data-team="alex"]'), card, 'not rebuilt under the keyboard'); assert.equal(u.doc.activeElement, button);
  assert.equal(u.q('[data-team="alex"] .ct-sum').textContent, '1 of your instances');
  assert.equal(u.pall('.ct-irow:not(.ct-ihead)').length, 2, 'the page has its own rule');
  button.blur(); u.card.syncRoster(); await tick();
  assert.equal(u.q('[data-team="alex"] .ct-sum').textContent, '2 of your instances', 'redrawn once focus left');
});

test('hostile instance, home and server label strings are text, never markup', async t => {
  const hostile = '"><img src=x onerror=alert(1)><b>';
  const u = await mount(t, { members: [far(`x${hostile}`, 'build', { serverLabel: hostile, home: `/srv/${hostile}`, reason: hostile, running: false })],
    servers: [server('build', { label: hostile })], notReached: [{ server: 'n', label: hostile }] });
  assert.equal(u.card.element.querySelector('img, [onerror]'), null); assert.equal(u.host.querySelector('img, [onerror]'), null);
  assert.ok(u.p('.ct-mcard-head').textContent.includes(hostile)); assert.ok(u.q('.ct-reach').textContent.includes(hostile));
  assert.equal(u.p('.ct-mcard').getAttribute('aria-label'), hostile);
  assert.equal(u.p('.ct-member-state').title, hostile);
  assert.equal(u.p('.ct-member-name').getAttribute('aria-label'), `Show x${hostile} in the roster`);
});

test('a route answer that does not validate leaves the board and the page saying nothing about members', async t => {
  const u = await mount(t, { members: 'nope' });
  assert.equal(u.q('[data-team="alex"] .ct-sum').textContent, ''); assert.equal(u.q('.ct-reach').textContent, '');
  assert.deepEqual(u.pall('[data-section=yours] > *').map(e => e.className), ['ct-section-head'], 'unknown is not none: no list and no empty sentence');
});

test('the team page: its card first (the label as the page\'s h2, no foot, not a link), then your instances on it', async t => {
  const u = await mount(t, { members: [m('dev-a')], servers: [], notReached: [] });
  const page = u.p('.computer-teams.ct-team-page');
  assert.deepEqual([...page.children].map(c => c.className), ['ct-card local ct-page-card', 'ct-section']);
  const card = page.querySelector('.ct-page-card');
  assert.equal(card.querySelector('h2.ct-page-label').textContent, 'alex');
  assert.equal(card.querySelector('.ct-open, .ct-foot, .ct-go'), null);
  assert.ok(card.querySelector('[data-fact=address]')); assert.ok(card.querySelector('.ct-why'), 'why Remove is off: on the page too');
  const yours = page.querySelector('[data-section=yours]');
  assert.equal(yours.querySelector('h3.ct-section-title').textContent, 'Your instances on this team');
  assert.equal(yours.querySelector('.ct-section-lead').textContent, 'On this computer and the machines you added to this workspace. Instances other people run on alex are not listed here.');
  assert.deepEqual([...u.host.querySelectorAll('.page-bar .page-crumbs span')].map(s => s.textContent), ['Workspace', '/', 'Teams', '/', 'alex']);
  assert.equal(u.p('.page-back').getAttribute('aria-label'), 'Back to Teams'); assert.equal(u.p('.page-back').title, 'Back to Teams (Esc)');
});
