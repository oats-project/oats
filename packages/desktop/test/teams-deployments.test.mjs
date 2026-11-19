// #482 (decision Q5): the Teams board lists the members of the VIEW's deployments, grouped by deployment
// with machine labels; a member's action stays in the view on screen and addresses the member's deployment.
// "Where to run" reads every view's remote groups, and a group's relation rows are that group's only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createComputerTeams, computerTeamsCSS, memberGroups } from '../renderer/computer-teams.mjs';
import { teamMemberAction, serverRows, serverFacts } from '../renderer/views/spawn.mjs';
import { currentWorkspace, setWorkspace } from '../renderer/views/common.mjs';

const TEAM = 'aweb:web.aweb.ai';
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
const doc = { schemaVersion: 1, defaultTeam: 'web', teams: [{ label: 'web', team: TEAM, from: 'local', default: true }], souls: { teams: {}, default: {} }, problems: [] };
const dep = (id, machine, path) => ({ id, machine, path });
const OATS = dep('/Users/alex/Agents/oats', 'This Mac', '/Users/alex/Agents/oats'), V2 = dep('/Users/alex/example/oats-qa', 'This Mac', '/Users/alex/example/oats-qa');
const DEVBOX = dep('remote:devbox:k1', 'devbox', '/Users/alex/Agents/web');
const member = (instance, deployment, extra = {}) => ({ workspace: deployment.id, deployment: { ...deployment }, server: deployment.id.startsWith('remote:') ? 'devbox' : null,
  serverLabel: deployment.id.startsWith('remote:') ? 'devbox' : null, instance, agent: 'dev', agentsRoot: `${deployment.path}/agents`,
  home: `${deployment.path}/agents/dev/instances/${instance}`, team: TEAM, running: true, addressable: true, missingRemotely: false, reason: null, reasonLabel: null, createdAt: null, ...extra });

test('memberGroups: one group per deployment, headed by its machine label; this Mac\'s first, then other machines', () => {
  const groups = memberGroups([member('far', DEVBOX), member('b', V2), member('a', OATS), member('c', OATS)],
    [{ server: 'devbox', label: 'devbox', group: 'devbox:k1', deployment: DEVBOX.id, reached: true, error: null, registered: true }]);
  assert.deepEqual(groups.map(g => [g.label, g.members.map(m => m.instance)]),
    [['This Mac · ~/Agents/oats', ['a', 'c']], ['This Mac · ~/example/oats-qa', ['b']], ['devbox · ~/Agents/web', ['far']]],
    'two deployments on this Mac are two groups; the remote one is labelled by its machine');
  assert.deepEqual(groups.map(g => g.deployment), [OATS.id, V2.id, DEVBOX.id]);
  assert.deepEqual(groups.map(g => [g.machine, g.path]), [['This Mac', OATS.path], ['This Mac', V2.path], ['devbox', DEVBOX.path]], 'each names its machine and its full path');
});

test('memberGroups: a deployment whose roster group failed its last read is not reached (servers[] carry the deployment)', () => {
  const [group] = memberGroups([member('far', DEVBOX, { running: null })],
    [{ server: 'devbox', label: 'devbox', group: 'devbox:k1', deployment: DEVBOX.id, reached: false, error: 'ssh: timeout', registered: true }]);
  assert.equal(group.reached, false); assert.equal(group.error, 'ssh: timeout');
});

test('the team page: one card per deployment, headed by its machine and path, with counts; a member whose deployment does not match its workspace is dropped', async t => {
  const dom = new JSDOM('<!doctype html><body><main class="oats-view"><section class="workspace-page"></section></main></body>', { pretendToBeVisual: true }), d = dom.window.document;
  const style = d.createElement('style'); style.textContent = computerTeamsCSS; d.head.append(style);
  const calls = [];
  const answer = { members: [member('a', OATS), member('b', V2), member('far', DEVBOX), { ...member('odd', OATS), deployment: { ...V2 } }],
    servers: [{ server: 'devbox', label: 'devbox', group: 'devbox:k1', deployment: DEVBOX.id, reached: true, error: null, registered: true }], notReached: [] };
  const card = createComputerTeams(d, { request: async () => structuredClone(doc), readMembers: async () => structuredClone(answer), onMember: (action, m) => calls.push([action, m.workspace]) });
  d.querySelector('main').append(card.element);
  t.after(() => { card.dispose(); dom.window.close(); });
  await tick();
  const host = d.querySelector('.workspace-page'); assert.equal(card.showTeam(host, 'web', { onBack: () => {} }), true);
  const cards = [...host.querySelectorAll('.ct-mcard')];
  assert.deepEqual(cards.map(c => [c.querySelector('.ct-machine').textContent, c.querySelector('.ct-path').textContent, c.querySelector('.ct-path').title, c.querySelector('.ct-mcard-count').textContent]),
    [['This Mac', '~/Agents/oats', OATS.path, '1 instance, 1 running'], ['This Mac', '~/example/oats-qa', V2.path, '1 instance, 1 running'], ['devbox', '~/Agents/web', DEVBOX.path, '1 instance, 1 running']]);
  // Two cards on one machine are told apart by their path; a machine of its own is named alone.
  assert.deepEqual(cards.map(c => c.getAttribute('aria-label')), ['This Mac ~/Agents/oats', 'This Mac ~/example/oats-qa', 'devbox']);
  assert.deepEqual(cards.map(c => c.querySelector('.ct-ilist').getAttribute('aria-label')), ['Your instances on web on This Mac ~/Agents/oats', 'Your instances on web on This Mac ~/example/oats-qa', 'Your instances on web on devbox']);
  assert.equal(host.querySelector('.ct-yours-machines').textContent, 'on 2 machines', 'this Mac\'s two deployments are one machine');
  assert.equal(card.element.querySelector('[data-team="web"] .ct-sum').textContent, '3 of your instances, 1 on other machines');
  const far = [...host.querySelectorAll('.ct-irow:not(.ct-ihead)')].find(r => r.querySelector('.ct-member-name').textContent === 'far');
  assert.equal(far.querySelector('.ct-member-term').getAttribute('aria-label'), 'Open far terminal on devbox');
  far.querySelector('.ct-member-term').click();
  assert.deepEqual(calls, [['open', DEVBOX.id]], 'the member carries its deployment id');
});

function host(panels) {
  const asked = [], opened = [], shown = [];
  const s = { waitOpts: { tries: 3, delayMs: 0, sleep: async () => {} }, ctx: { connectionGeneration: () => 0,
    api: path => { asked.push(path); const p = panels[Math.min(asked.length - 1, panels.length - 1)]; return Promise.resolve({ ok: true, status: 200, json: async () => p }); },
    openTerminal: (row, o) => opened.push({ row, o }), showInRoster: row => shown.push(row), notify: () => {} } };
  return { s, asked, opened, shown };
}

test('teamMemberAction: stays in the view on screen and opens the row of the member\'s deployment, owned by the view', async () => {
  const previous = currentWorkspace(); setWorkspace('ws:web');
  try {
    // The view's panel holds both deployments' rows; the same instance and home strings exist on another deployment.
    const twin = { ...member('dev-a', OATS), deployment: { ...V2 } }, own = { ...member('dev-a', OATS) };
    const row = r => ({ instance: r.instance, agent: r.agent, agentsRoot: r.agentsRoot, home: r.home, running: true, tmux: { session: 's' }, deployment: r.deployment, createdAt: '2026-10-02T10:00:00.000Z' });
    const h = host([{ instances: [row(twin)] }, { instances: [row(twin), row(own)] }]);
    await teamMemberAction(h.s, 'open', member('dev-a', OATS));
    assert.equal(currentWorkspace(), 'ws:web', 'never a switch to the member\'s deployment id');
    assert.ok(h.asked.every(p => p === '/api/panel?ws=ws%3Aweb'), 'the view\'s panel');
    assert.equal(h.opened.length, 1);
    assert.equal(h.opened[0].row.deployment.id, OATS.id, 'the member\'s own deployment row, not the twin');
    assert.equal(h.opened[0].o.expected.workspace, 'ws:web', 'ownership stays with the view on screen');
    const show = host([{ instances: [{ ...row(own), running: false }] }]);
    await teamMemberAction(show.s, 'show', member('dev-a', OATS));
    assert.equal(show.shown.length, 1); assert.equal(currentWorkspace(), 'ws:web');
  } finally { setWorkspace(previous); }
});

test('serverRows: a remote group\'s relation rows are that group\'s deployment only (the panel answers its whole view)', async () => {
  const h = host([{ instances: [{ instance: 'here', deployment: { id: '/Users/alex/Agents/oats' } }, { instance: 'far', server: 'devbox', deployment: { id: 'remote:devbox:k1' } },
    { instance: 'other', server: 'build', deployment: { id: 'remote:build:k2' } }] }]);
  assert.deepEqual((await serverRows(h.s, 'devbox:k1')).map(r => r.instance), ['far']);
  assert.deepEqual(h.asked, ['/api/panel?ws=remote%3Adevbox%3Ak1']);
});

test('serverFacts: every view holding a remote deployment is read, so a registered group in another view is still known', async () => {
  const asked = [];
  const answers = { 'ws:web': { servers: [{ server: 'devbox', group: 'devbox:k1', reached: true, registered: true }] },
    'remote:build:k2': { servers: [{ server: 'build', group: 'build:k2', reached: false, registered: true }, { server: 'devbox', group: 'devbox:k1', reached: true, registered: true }] } };
  const s = { spawnViews: [{ id: '/local/only', deployments: ['/local/only'] }, { id: 'ws:web', deployments: ['/a', 'remote:devbox:k1'] }, { id: 'remote:build:k2', deployments: ['remote:build:k2'] }],
    ctx: { api: path => { asked.push(path); const ws = decodeURIComponent(path.split('ws=')[1]); return Promise.resolve({ ok: true, status: 200, json: async () => answers[ws] }); } } };
  const facts = await serverFacts(s);
  assert.deepEqual(asked, ['/api/team-members?ws=ws%3Aweb', '/api/team-members?ws=remote%3Abuild%3Ak2'], 'only views with a remote deployment');
  assert.deepEqual(facts.map(f => f.group), ['devbox:k1', 'build:k2'], 'each group once');
  // Before the panel lists views: the current view, as before.
  const previous = currentWorkspace(); setWorkspace('/w');
  try {
    const before = []; await serverFacts({ spawnViews: [], ctx: { api: path => { before.push(path); return Promise.resolve({ ok: true, status: 200, json: async () => ({ servers: [] }) }); } } });
    assert.deepEqual(before, ['/api/team-members?ws=%2Fw']);
  } finally { setWorkspace(previous); }
});
