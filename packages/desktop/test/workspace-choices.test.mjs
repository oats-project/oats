// The words a workspace switcher shows for a view (packages/client/workspace-choices.mjs, #855 3a): the rule
// of the Desktop's workspace list as pure functions, called here as a second client calls them, and then held
// against the list the Desktop draws from them. The list itself (its DOM, focus and keys) is
// test/workspace-views-ui.test.mjs, test/workspace-switcher.test.mjs and test/workspace-list.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import * as choices from '../../client/workspace-choices.mjs';
import { workspaceChoiceRows, choiceMatches, workspaceChoiceLabels, workspaceChoicePlace, isLocalPath, UNMATCHED_SECTION } from '../../client/workspace-choices.mjs';
import { workspaceChoices } from '../../client/panel-views.mjs';
import { clientTerms } from '../../client/client-terms.mjs';
import { createWorkspaceSwitcher } from '../renderer/workspace-switcher.mjs';
import { onDeploymentTabRequest } from '../renderer/deployment-tabs.mjs';
import { mountShellIcons } from '../renderer/shell-icons.mjs';
import { CLI, alexState, A, B, L, R, V, V_OATS, V_LAB } from './helpers/workspace-views-fixture.mjs';

const SHORT = 'OATS too old to report its workspace';
const OATS = { id: 'ws:aaaaaaaaaaaaaaaaaaaa', name: 'oats', team: null, key: 'github.com/org/oats', deployments: ['/Users/op/Agents/oats', 'remote:devbox:web'],
  deploymentLabels: ['This Mac · ~/Agents/oats', 'devbox · ~/Agents/web'], machines: ['This Mac', 'devbox'], notLive: 1 };
const LOOSE = { id: '/Users/op/Agents/loose', name: 'loose', team: null, deployments: ['/Users/op/Agents/loose'], unattached: true, ref: 'github.com/org/loose@main',
  reason: "This deployment's workspace reference names a member whose workspace isn't known yet; run oats sync there.", short: SHORT,
  deploymentLabels: ['This Mac · ~/Agents/loose'], machines: ['This Mac'], notLive: 0 };
const WEB = { id: 'ws:bbbbbbbbbbbbbbbbbbbb', name: 'web', team: null, key: 'github.com/org/web', deployments: ['remote:laptop:t1'], server: 'laptop', remote: true,
  deploymentLabels: ['laptop · /srv/web'], machines: ['laptop'], notLive: 0 };
const BUILD = { id: 'remote:build:cccccccccccc', name: 'build', team: null, deployments: ['remote:build:cccccccccccc'], machines: ['build'], notLive: 1,
  unattached: true, short: SHORT, server: 'build', remote: true };
const frozen = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(frozen); }
  return value;
};
const row = (choice, others = []) => workspaceChoiceRows([choice, ...others])[0];

test('a row per choice, in the same order: the name, one line, the not-live count and its words, the tooltip, the deployment', () => {
  assert.deepEqual(workspaceChoiceRows([OATS, LOOSE, WEB]), [
    { id: OATS.id, label: 'oats', place: 'This Mac · devbox', notLive: 1, notLiveText: '1 deployment not live', unattached: false,
      tooltip: 'This Mac · ~/Agents/oats, devbox · ~/Agents/web', deployment: null },
    { id: LOOSE.id, label: 'loose', place: `This Mac · ${SHORT}`, notLive: 0, notLiveText: '', unattached: true, tooltip: 'This Mac · ~/Agents/loose', deployment: '/Users/op/Agents/loose' },
    { id: WEB.id, label: 'web', place: 'laptop', notLive: 0, notLiveText: '', unattached: false, tooltip: 'laptop · /srv/web', deployment: null },
  ]);
  assert.deepEqual(workspaceChoiceRows([]), []);
  assert.deepEqual(workspaceChoiceRows([WEB, OATS]).map(r => r.id), [WEB.id, OATS.id], 'the order given, not the menu\'s sections');
  assert.equal(UNMATCHED_SECTION, 'Not matched to a workspace');
});

test('label: two choices of one name are told apart by a suffix, and a row\'s label is workspaceChoiceLabels\' answer', () => {
  const twins = [{ id: 'ws:1', name: 'web', key: 'github.com/a/web', deployments: [] }, { id: 'ws:2', name: 'web', key: 'github.com/b/web', deployments: [] }];
  assert.deepEqual(workspaceChoiceRows(twins).map(r => r.label), ['web — github.com/a/web', 'web — github.com/b/web']);
  // A folder's last two segments, the machines, a team's name before either; never an id, never a full path.
  const mixed = [{ id: '/a/x/oats', name: 'oats', team: { name: 'alpha' } }, { id: 'remote:laptop:oats', name: 'oats', machines: ['laptop'] }, { id: 'remote:laptop:o2', name: 'oats' }, { id: '/docs', name: 'docs' }];
  assert.deepEqual(workspaceChoiceRows(mixed).map(r => r.label), ['oats — alpha · x/oats', 'oats — laptop', 'oats', 'docs']);
  for (const list of [twins, mixed, [OATS, LOOSE, WEB, BUILD], [{ id: 'remote:laptop:t1' }, { id: '/Users/op/Agents/unnamed' }]]) {
    assert.deepEqual(workspaceChoiceRows(list).map(r => r.label), workspaceChoiceLabels(list));
  }
  assert.deepEqual(workspaceChoiceRows([{ id: 'remote:laptop:t1' }, { id: '/Users/op/Agents/unnamed' }]).map(r => r.label), ['Workspace', 'unnamed'], 'a remote id is never a name');
});

test('place: a matched view\'s machines; an unattached one\'s machine and short reason, without the machine when the label already is it', () => {
  assert.equal(row(OATS).place, 'This Mac · devbox');
  assert.equal(row(OATS).place, workspaceChoicePlace(OATS));
  assert.equal(row(LOOSE).place, `This Mac · ${SHORT}`);
  // An unattached remote is named by its server: its line does not repeat the name.
  assert.deepEqual([row(BUILD).label, row(BUILD).place], ['build', SHORT]);
  // Two unattached remotes of one name carry a suffix, so the label is no longer the machine and the line says it.
  const [first] = workspaceChoiceRows([BUILD, { ...BUILD, id: 'remote:build:dddddddddddd', deployments: ['remote:build:dddddddddddd'] }]);
  assert.deepEqual([first.label, first.place], ['build — build', `build · ${SHORT}`]);
  // Only the first machine of an unattached view, and only a short reason that is a short string.
  assert.equal(row({ ...LOOSE, machines: ['This Mac', 'devbox'] }).place, `This Mac · ${SHORT}`);
  for (const short of [undefined, '', 7, null, 'x'.repeat(257)]) assert.equal(row({ ...LOOSE, short }).place, 'This Mac', String(short).slice(0, 9));
  assert.equal(row({ ...LOOSE, machines: [], short: undefined }).place, '');
  // The full reason is never the line.
  for (const r of workspaceChoiceRows([OATS, LOOSE, WEB, BUILD])) assert.doesNotMatch(r.place, /run oats sync|ws:|remote:|\/Users\//);
});

test('place: no `machines` (an older answer), or machines that are not short strings, say nothing in their place', () => {
  const old = { id: 'ws:cccccccccccccccccccc', name: 'old', team: null, deployments: ['remote:laptop:t1', '/Users/op/x'] };
  assert.deepEqual([row(old).place, row(old).tooltip], ['', '']);
  assert.equal(row({ ...old, id: 'remote:laptop:t2', unattached: true }).place, '');
  assert.equal(row({ ...OATS, machines: ['This Mac', '', 7, null, 'x'.repeat(257), 'devbox'] }).place, 'This Mac · devbox');
  for (const machines of [undefined, null, 'devbox', { 0: 'devbox' }, []]) assert.equal(row({ ...OATS, machines }).place, '', JSON.stringify(machines));
});

test('notLive: the count of a matched view when it is a positive integer, else 0, with its words', () => {
  const said = (notLive, over = {}) => { const r = row({ ...OATS, notLive, ...over }); return [r.notLive, r.notLiveText]; };
  assert.deepEqual(said(0), [0, '']);
  assert.deepEqual(said(1), [1, '1 deployment not live']);
  assert.deepEqual(said(2), [2, '2 deployments not live']);
  assert.deepEqual(said(17), [17, '17 deployments not live']);
  for (const notLive of ['2', 1.5, -1, NaN, Infinity, null, undefined, true, [2], {}]) assert.deepEqual(said(notLive), [0, ''], String(notLive));
  assert.deepEqual((({ notLive: _absent, ...rest }) => { const r = row(rest); return [r.notLive, r.notLiveText]; })(OATS), [0, ''], 'no count at all (an older answer)');
  // An unattached view carries no count, whatever it reports.
  assert.deepEqual(said(1, { unattached: true }), [0, '']);
  assert.deepEqual([row(BUILD).notLive, row(BUILD).notLiveText], [0, '']);
});

test('tooltip: the deployments\' labels when there is one per deployment, else a local folder\'s path, else nothing', () => {
  assert.equal(row(OATS).tooltip, 'This Mac · ~/Agents/oats, devbox · ~/Agents/web');
  // A label list of the wrong length, or with an entry that is not a short string, is not shown.
  for (const deploymentLabels of [['This Mac · ~/Agents/oats'], ['a', 'b', 'c'], ['a', ''], ['a', 7], ['a', 'x'.repeat(513)], 'a, b', undefined, null]) {
    assert.equal(row({ ...OATS, deploymentLabels }).tooltip, '', JSON.stringify(deploymentLabels)?.slice(0, 40));
    assert.equal(row({ ...LOOSE, deploymentLabels }).tooltip, deploymentLabels?.length === 1 && deploymentLabels[0] === 'This Mac · ~/Agents/oats' ? 'This Mac · ~/Agents/oats' : '/Users/op/Agents/loose', 'a local folder falls back to its path');
  }
  // No deployments and no labels: nothing for a view, the path for a local folder; never an id.
  assert.equal(row({ id: 'ws:1', name: 'x', deployments: [], deploymentLabels: [] }).tooltip, '');
  assert.equal(row({ id: 'remote:laptop:t1', name: 'x' }).tooltip, '');
  assert.equal(row({ id: '/a/b', name: 'b' }).tooltip, '/a/b');
  for (const r of workspaceChoiceRows([OATS, WEB, BUILD])) assert.doesNotMatch(r.tooltip, /ws:|remote:/);
  assert.deepEqual([isLocalPath('/a/b'), isLocalPath('ws:1'), isLocalPath('remote:laptop:t1'), isLocalPath(undefined), isLocalPath(7)], [true, false, false, false, false]);
});

test('deployment: an unattached view\'s first deployment id, else null', () => {
  assert.equal(row(LOOSE).deployment, '/Users/op/Agents/loose');
  assert.equal(row({ ...LOOSE, deployments: ['remote:build:r1', '/Users/op/Agents/loose'] }).deployment, 'remote:build:r1');
  assert.equal(row(OATS).deployment, null, 'a matched view opens no deployment');
  for (const deployments of [[], undefined, null, 'remote:build:r1', [''], [undefined, '/x']]) assert.equal(row({ ...LOOSE, deployments }).deployment, null, JSON.stringify(deployments));
  // `unattached` is read as the menu reads it: any truthy value.
  assert.deepEqual([row({ ...LOOSE, unattached: 'yes' }).unattached, row({ ...LOOSE, unattached: 0 }).unattached, row(OATS).unattached], [true, false, false]);
  assert.equal(row({ ...LOOSE, unattached: 0 }).deployment, null);
});

test('choiceMatches: the label and the place, lower-cased, against what was typed, trimmed and lower-cased', () => {
  const rows = workspaceChoiceRows([OATS, LOOSE, WEB]);
  const kept = (query) => rows.filter(r => choiceMatches(r, query)).map(r => r.id);
  for (const none of ['', '   ', undefined, null]) assert.deepEqual(kept(none), [OATS.id, LOOSE.id, WEB.id], JSON.stringify(none));
  assert.deepEqual(kept('devbox'), [OATS.id], 'a machine finds its view');
  assert.deepEqual(kept('  DEVBOX '), [OATS.id]);
  assert.deepEqual(kept('too old'), [LOOSE.id], 'the short reason is searchable');
  assert.deepEqual(kept('this mac'), [OATS.id, LOOSE.id]);
  assert.deepEqual(kept('oats this'), [OATS.id], 'a query may span the name and the line: they are joined by one space');
  assert.deepEqual(kept('mac · dev'), [OATS.id]);
  // What is not shown is not matched: the full reason, the tooltip's paths, an id, the not-live words.
  for (const hidden of ['run oats sync', '~/agents', 'ws:', '/srv', 'not live', 'github.com']) assert.deepEqual(kept(hidden), [], hidden);
  // Lower-cased as the menu lower-cases: by the locale's rule, on both sides.
  const [named] = workspaceChoiceRows([{ id: 'ws:1', name: 'ÀB Çd', machines: ['Ünïx'] }]);
  for (const typed of ['àb', 'ÀB ÇD', 'ünïx', 'çd ü']) assert.equal(choiceMatches(named, typed), true, typed);
  assert.equal(choiceMatches(named, 'ab'), false, 'no folding of accents');
  // A row is all it reads: any object with a label and a place.
  assert.equal(choiceMatches({ label: 'oats', place: '' }, 'oats '), true);
});

test('nothing given is changed, and the same call answers the same', () => {
  const given = frozen(structuredClone([OATS, LOOSE, WEB, BUILD, { id: 'ws:1', name: 'oats', team: { name: 'alpha' }, machines: ['laptop'], deployments: [] }]));
  const before = JSON.stringify(given);
  const rows = workspaceChoiceRows(given);
  assert.deepEqual(workspaceChoiceRows(given), rows);
  assert.equal(JSON.stringify(given), before);
  for (const r of frozen(rows)) for (const query of ['', 'oats', ' Laptop']) choiceMatches(r, query);
  // A row shares nothing with its choice that a caller could change through it.
  for (const r of rows) for (const value of Object.values(r)) assert.ok(value === null || typeof value !== 'object');
});

test('the rows of what panel-views.mjs `workspaceChoices` answers: the switcher of a second client, in its own terms', () => {
  const TUI = clientTerms({ name: 'oats tui', self: 'oats tui', selfInitial: 'oats tui', update: 'OATS', thisMachine: 'This machine' });
  const { state } = alexState();
  const held = { ctxs: state.ctxs, snapshot: state.snapshot, remoteGroups: state.remoteGroups, remembered: { get: () => null, note: () => null, all: () => [] }, rosterAnswered: true, rosterFailure: null,
    cli: CLI, observing: new Set(), remoteCollecting: false, home: '/Users/alex', at: '2026-10-11T12:00:00.000Z' };
  const rows = workspaceChoiceRows(workspaceChoices(held, TUI));
  assert.deepEqual(rows.map(r => [r.id, r.label, r.place, r.notLiveText, r.unattached]), [
    [V_OATS, 'oats', 'This machine · devbox', '', false],
    [V_LAB, 'lab', 'laptop', '', false],
    [L, 'loose', 'This machine · Not observed', '', true],
  ]);
  assert.equal(rows[0].tooltip, 'This machine · ~/Agents/oats, This machine · ~/example/oats-qa, devbox · ~/oats');
  assert.deepEqual(rows.map(r => r.deployment), [null, null, L]);
  assert.ok([A, B, R, V].every(id => !rows.some(r => r.id === id)), 'views, not deployments');
});

/* ── The Desktop's list is drawn from the rows: every string it shows is a row's ── */
const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
function menu(t, list, { active = list[0] } = {}) {
  const dom = new JSDOM(html, { url: 'https://fixture.invalid' }); t.after(() => dom.window.close());
  const document = dom.window.document; mountShellIcons(document);
  const selected = [], tabRequests = [];
  t.after(onDeploymentTabRequest((request) => tabRequests.push(request)));
  const sw = createWorkspaceSwitcher({ document, selectWorkspace: (id) => selected.push(id), discoverSuggestions: async () => [], addWorkspace: async () => ({}), pickWorkspace: async () => ({}),
    openInNewWindow: () => {} });
  t.after(() => sw.dispose());
  sw.begin()(active, list);
  const options = () => [...document.querySelectorAll('#ws-options .ws-option')];
  return { document, sw, selected, tabRequests, options,
    shown: () => options().map(o => ({ id: o.dataset.workspaceId, parts: [...o.children].map(c => c.className), label: o.querySelector('.ws-option-name').textContent, tooltip: o.title })) };
}
// A row is one line, its label (pr3-simplify): of the row's words, only the label is drawn, and it is the tooltip too.
// A row: the roster's circle (filled on the current workspace, list[0] by default) and the label.
const drawnFrom = (rows, current = rows[0]?.id) => [...rows.filter(r => !r.unattached), ...rows.filter(r => r.unattached)]
  .map(r => ({ id: r.id, parts: [r.id === current ? 'ctx-dot on' : 'ctx-dot off', 'ws-option-name'], label: r.label, tooltip: r.label }));

test('the Desktop\'s list shows each row\'s label and nothing else of the choice', (t) => {
  const twin = { ...WEB, id: 'ws:dddddddddddddddddddd', key: 'github.com/other/web', machines: ['devbox'], notLive: 2, deploymentLabels: ['devbox · /srv/web'] };
  const list = [OATS, LOOSE, WEB, BUILD, twin, { id: 'ws:eeeeeeeeeeeeeeeeeeee', name: 'old', team: null, deployments: ['remote:laptop:t9', '/Users/op/x'] }];
  const rows = workspaceChoiceRows(list);
  assert.deepEqual(menu(t, list).shown(), drawnFrom(rows));
  // The list has no filter: every row is drawn, always (the TUI's switcher still filters with choiceMatches).
  const m = menu(t, list);
  assert.equal(m.document.getElementById('ws-menu-search'), null);
  // The unattached rows close the same flat list: no section, no heading.
  const groups = [...m.document.querySelectorAll('#ws-options ul')];
  assert.equal(groups.length, 1); assert.equal(groups[0].hasAttribute('aria-labelledby'), false);
  assert.equal(m.document.querySelector('#ws-options').textContent.includes(UNMATCHED_SECTION), false);
  assert.deepEqual(m.options().slice(-rows.filter(r => r.unattached).length).map(o => o.dataset.workspaceId), rows.filter(r => r.unattached).map(r => r.id));
  // A click opens the row's deployment, when it has one.
  for (const r of rows) {
    const one = menu(t, list, { active: OATS });
    one.options().find(o => o.dataset.workspaceId === r.id).click();
    assert.deepEqual(one.tabRequests, r.deployment ? [{ view: r.id, tab: r.deployment }] : [], r.id);
  }
});

test('the renderer holds none of the rule: it declares no name the shared module exports, and builds no row\'s words', () => {
  const source = readFileSync(new URL('../renderer/workspace-switcher.mjs', import.meta.url), 'utf8');
  const declared = name => new RegExp(`(?:function\\*?|const|let|var|class)\\s+${name}\\b`).test(source);
  const moved = [...Object.keys(choices), 'choiceTooltip', 'machinesOf'];
  assert.deepEqual(Object.keys(choices).sort(), ['UNMATCHED_SECTION', 'choiceMatches', 'isLocalPath', 'workspaceChoiceLabels', 'workspaceChoicePlace', 'workspaceChoiceRows']);
  assert.deepEqual(moved.filter(declared), []);
  // The row's name is the Desktop's own (rowNames: never a folder or a machine); the shared labels are the TUI's.
  assert.match(source, /import \{ isLocalPath, workspaceChoiceRows \} from "\.\.\/\.\.\/client\/workspace-choices\.mjs";/);
  // It reads a row (`said`), never the choice's own fields for words, and spells none of the words itself.
  assert.doesNotMatch(source, /"deployments?"|Not matched to a workspace|deploymentLabels|workspace\.(?:notLive|short|machines|unattached|key)\b/);
  assert.match(source, /const said = workspaceChoiceRows\(workspaces\), names = rowNames\(workspaces\);/); assert.match(source, /row = said\[index\], label = names\[index\];/);
  assert.doesNotMatch(source, /choiceMatches/, 'the list filters nothing');
  // What stays the renderer's.
  for (const name of ['OPEN_IN_NEW_WINDOW', 'WAITING_NAME', 'openInNewWindowHint', 'rowNames', 'createWorkspaceSwitcher']) assert.equal(declared(name), true, name);
  // The check finds a declaration when there is one, and the module the page loads imports no Node builtin.
  assert.doesNotMatch(readFileSync(new URL('../../client/workspace-choices.mjs', import.meta.url), 'utf8'), /from\s*["']node:|import\(\s*["']node:/);
});
