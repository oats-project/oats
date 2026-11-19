// Pinned instances (feature instance-pin), the Desktop's acts and marks: the row menu's Pin to top / Unpin
// (renderer/instance-pin-menu.mjs in instance-actions.mjs; its gate is instance-record-gate.mjs), the route's roster
// re-read through the shipped HTTP handler (oats-web.mjs, as workspace-views-fixture.mjs loads it), the palette's
// "Instance: Pin to top" / "Instance: Unpin" and its pinned order, and the sidebar's shipped paint (shell.mjs
// renderContextRoster): the order and the pin mark on the name line, only while this computer's CLI lists the feature.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { createInstancePinMenu, pinOffer, pinFailure, PIN_LABELS, PIN_UNAVAILABLE } from '../renderer/instance-pin-menu.mjs';
import { rereadsRoster } from '../server/instance-record.mjs';
import { instanceActions } from '../renderer/instance-actions.mjs';
import { paletteRows } from '../renderer/palette.mjs';
import { pinnedMark } from '../renderer/instance-tree-view.mjs';
import { loadServer, alexState, A } from './helpers/workspace-views-fixture.mjs';
import { viewContext } from './helpers/view-context.mjs';
import * as treeShared from '../../client/instance-tree.mjs';
import * as treeView from '../renderer/instance-tree-view.mjs';
import * as sameWork from '../../client/same-work.mjs';
import { captureInstanceActionMenu } from '../renderer/instance-actions.mjs';
import { instanceActionTarget } from '../renderer/instance-action-target.mjs';
import { instanceSplitPlan } from '../renderer/instance-split.mjs';
import { runtimeState, unsupportedSession } from '../../client/instance-presentation.mjs';
import { canAddressRemote, rowReason } from '../../client/remote-address.mjs';
import { createRuntimeBadge } from '../renderer/identity-marks.mjs';
import { iconElement } from '../renderer/shell-icons.mjs';
import { rosterTipFacts } from '../renderer/roster-tip.mjs';
import { setTabTitle } from '../renderer/tab-a11y.mjs';
import { NO_ANSWER_CODE, unservedError } from '../renderer/deployment-header.mjs';
import { rosterKeyAction, moveTarget } from '../renderer/roster-keys.mjs';
import { revealInScrollport } from '../renderer/reveal-in-scrollport.mjs';

const tick = () => new Promise(r => setImmediate(r));
const ROOT = '/fixture/team/agents';
const ROSTER = [
  { instance: 'dev-1', agent: 'dev', agentsRoot: ROOT, home: `${ROOT}/dev/instances/dev-1` },
  { instance: 'lead', agent: 'lead', agentsRoot: ROOT, home: `${ROOT}/lead/instances/lead`, pinned: true },
];
const byName = name => ROSTER.find(r => r.instance === name);

// ── the row menu ───────────────────────────────────────────────────────────────────────────────────────

test('which item a row offers: Unpin on its own pin, Pin to top on any other; acts with no dialog, so no ellipsis', () => {
  assert.equal(pinOffer(byName('dev-1')), 'pin-on');
  assert.equal(pinOffer(byName('lead')), 'pin-off');
  for (const stray of ['true', 1, false]) assert.equal(pinOffer({ ...byName('dev-1'), pinned: stray }), 'pin-on', String(stray));
  assert.deepEqual(PIN_LABELS, { 'pin-on': 'Pin to top', 'pin-off': 'Unpin' });
  for (const label of Object.values(PIN_LABELS)) assert.doesNotMatch(label, /…$/);
});

function menuHarness(answers = {}) {
  const requests = [];
  let gated = 0;
  const reply = (r, body) => {
    const a = answers[body.check ? 'check' : 'write'];
    return typeof a === 'function' ? a(r, body) : a ?? (body.check ? { status: 'ok', instance: r.instance, check: true } : { status: 'ok', instance: r.instance, pinned: body.pinned, changed: true });
  };
  const menu = createInstancePinMenu({ deploymentOf: r => r.server ? `remote:${r.server}` : 'team', onGate: () => { gated++; },
    request: async (r, body) => { requests.push({ instance: r.instance, ...body }); return reply(r, body); } });
  return { menu, requests, gated: () => gated };
}

test('the gate is the route\'s check, asked once per deployment and held; until it answers, and without the feature, no item', async () => {
  const { menu, requests, gated } = menuHarness({ check: r => r.server ? { status: 'not-run', reason: { code: PIN_UNAVAILABLE, details: { where: 'server' } } } : { status: 'ok', instance: r.instance, check: true } });
  assert.deepEqual(menu.items(byName('dev-1')), [], 'not known yet');
  assert.deepEqual(menu.items(byName('lead')), [], 'one check in flight for the deployment');
  await tick(); await tick();
  assert.deepEqual(requests, [{ instance: 'dev-1', home: byName('dev-1').home, check: true }]);
  assert.equal(gated(), 1, 'a held answer that changes asks for a repaint');
  assert.deepEqual(menu.items(byName('dev-1')), [{ action: 'pin-on', label: 'Pin to top' }]);
  assert.deepEqual(menu.items(byName('lead')), [{ action: 'pin-off', label: 'Unpin' }]);
  // A remote row's host without the feature: its deployment never offers them.
  const far = { ...byName('dev-1'), server: 'box', addressable: true };
  menu.items(far); await tick(); await tick();
  assert.deepEqual(menu.items(far), []);
  assert.equal(requests.length, 2);
  // An unaddressable remote row never asks (the route could not admit it).
  menu.items({ ...far, server: 'other', addressable: false }); await tick();
  assert.equal(requests.length, 2);
});

test('without the feature on this computer\'s CLI, the check says so and no item is ever offered', async () => {
  const { menu, requests } = menuHarness({ check: { status: 'not-run', reason: { code: PIN_UNAVAILABLE, details: { where: 'local' } } } });
  menu.items(byName('dev-1')); await tick(); await tick();
  assert.deepEqual(menu.items(byName('dev-1')), []);
  assert.deepEqual(menu.items(byName('lead')), []);
  assert.equal(requests.length, 1);
});

test('running an item posts { instance, home, pinned }; a success or an unknown outcome resolves, a refusal or nothing run throws why', async () => {
  const dev = byName('dev-1');
  let write = (r, body) => ({ status: 'ok', instance: r.instance, pinned: body.pinned, changed: true });
  const { menu, requests } = menuHarness({ write: (r, body) => write(r, body) });
  assert.deepEqual(await menu.run('pin-on', dev), { status: 'ok', instance: 'dev-1', pinned: true, changed: true });
  assert.deepEqual(requests.at(-1), { instance: 'dev-1', home: dev.home, pinned: true });
  await menu.run('pin-off', byName('lead'));
  assert.deepEqual(requests.at(-1), { instance: 'lead', home: byName('lead').home, pinned: false });
  write = () => ({ status: 'unknown', reason: { code: 'E_CLI_TIMEOUT' } });
  assert.equal((await menu.run('pin-on', dev)).status, 'unknown');
  write = () => ({ status: 'refused', reason: { code: 'E_INSTANCE_RETIRING', message: 'dev-1 is being retired' } });
  await assert.rejects(menu.run('pin-on', dev), error => /dev-1 is being retired/.test(error.message));
  write = () => ({ status: 'not-run', reason: { code: 'E_BUSY', message: 'Another window is pinning this instance. Try again.' } });
  await assert.rejects(menu.run('pin-on', dev), { message: 'Another window is pinning this instance. Try again.' });
  write = () => ({ status: 'ok', instance: 'dev-1', pinned: false, changed: true });
  await assert.rejects(menu.run('pin-on', dev), /not one this Desktop reads/, 'a success for the other value is no success');
  await assert.rejects(menu.run('background-on', dev), /Unknown instance action/);
  assert.equal(menu.handles('pin-on'), true); assert.equal(menu.handles('pin-off'), true); assert.equal(menu.handles('background-on'), false);
});

test('the reasons a write did not run: the feature missing here or on the host, said apart; the kernel\'s refusal under its name', () => {
  const unavailable = where => ({ status: 'not-run', reason: { code: PIN_UNAVAILABLE, message: 'x', details: { where } } });
  assert.equal(pinFailure(unavailable('local'), byName('dev-1'), true), 'Pinning an instance needs a newer OATS on this computer.');
  assert.match(pinFailure(unavailable('server'), { ...byName('dev-1'), server: 'box', repoName: 'box' }, true), /^box's OATS can't pin instances yet\.$/);
  assert.equal(pinFailure({ status: 'refused', reason: { code: 'E_SESSION_UNKNOWN', message: '' } }, byName('dev-1'), true), 'E_SESSION_UNKNOWN');
  assert.notEqual(pinFailure({ status: 'ok', instance: 'dev-1', check: true }, byName('dev-1'), true), null, 'a check is not a write');
});

test('a write refused for the feature withdraws the item at once', async () => {
  const { menu, gated } = menuHarness({ write: () => ({ status: 'not-run', reason: { code: PIN_UNAVAILABLE, message: 'x', details: { where: 'local' } } }) });
  menu.items(byName('dev-1')); await tick(); await tick();
  assert.equal(menu.gate(byName('dev-1')), true);
  await assert.rejects(menu.run('pin-on', byName('dev-1')));
  assert.equal(menu.gate(byName('dev-1')), false); assert.equal(gated(), 2);
});

function menuDom() {
  const dom = new JSDOM('<body></body>', { pretendToBeVisual: true });
  for (const [method, newState] of [['showPopover', 'open'], ['hidePopover', 'closed']]) {
    dom.window.HTMLElement.prototype[method] = function () {
      const event = new dom.window.Event('beforetoggle'); Object.defineProperty(event, 'newState', { value: newState });
      this.dispatchEvent(event);
      if (newState === 'open') this.querySelector('[autofocus]')?.focus();
    };
  }
  return dom;
}

test('the row menu draws the item among the caller\'s own, with the pin icon, runs it, and says a refusal through report', async () => {
  const dom = menuDom(), doc = dom.window.document;
  const { menu } = menuHarness({ write: () => ({ status: 'refused', reason: { code: 'E_INSTANCE_RETIRING', message: 'dev-1 is being retired' } }) });
  menu.items(byName('dev-1')); await tick(); await tick();
  const instance = { ...byName('dev-1'), running: true };
  const reports = [], invoked = [];
  const rowButton = doc.createElement('button'); rowButton.className = 'ctx-inst';
  const element = instanceActions(doc, instance, { row: rowButton, scope: 'team', extra: menu.items(instance),
    invoke: async (action, i) => { invoked.push(action); return menu.handles(action) ? menu.run(action, i) : null; },
    report: (headline, { detail }) => reports.push({ headline, detail }), say: m => assert.fail(m) });
  doc.body.append(rowButton, element);
  const item = element.querySelector('[data-action="pin-on"]');
  assert.ok(item, 'drawn'); assert.equal(item.getAttribute('role'), 'menuitem'); assert.equal(item.textContent, 'Pin to top');
  assert.ok(item.querySelector('.ctx-menu-icon svg'), 'its icon');
  assert.equal(element.querySelector('[data-action="pin-off"]'), null);
  rowButton.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 0));
  item.click(); await tick(); await tick();
  assert.deepEqual(invoked, ['pin-on']);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].headline, "Pin to top didn't finish for dev-1.");
  assert.match(reports[0].detail, /dev-1 is being retired/);
  dom.window.close();
});

test('a held or retiring row offers no pin item; a stale roster opens no menu at all', async () => {
  const dom = menuDom(), doc = dom.window.document;
  const { menu } = menuHarness();
  menu.items(byName('dev-1')); await tick(); await tick();
  for (const held of [{ retirePending: true }, { spawnInProgress: true }, { rollbackIncomplete: true }, { retireInFlight: true }]) {
    const row = { ...byName('dev-1'), running: false, ...held };
    const element = instanceActions(doc, row, { row: doc.createElement('button'), scope: 'team', extra: menu.items(row), invoke: async () => assert.fail('nothing runs') });
    assert.equal(element.querySelector('[data-action^="pin-"]'), null, JSON.stringify(held));
  }
  const said = [];
  const rowButton = doc.createElement('button');
  const element = instanceActions(doc, byName('dev-1'), { row: rowButton, scope: 'team', stale: 'The roster is stale.', extra: menu.items(byName('dev-1')),
    invoke: async () => assert.fail('nothing runs'), say: m => said.push(m) });
  doc.body.append(rowButton, element);
  rowButton.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(said, ['The roster is stale.']);
  dom.window.close();
});

// ── the route, through the shipped handler ─────────────────────────────────────────────────────────────

test('the route hands the body to its boundary and re-reads the roster after a change or an unknown outcome, not otherwise', async () => {
  const HOME = `${A}/agents/dev/instances/dev-a`;
  let answer = { status: 'ok', instance: 'dev-a', pinned: true, changed: true };
  const asked = [], reread = [];
  const { state } = alexState();
  const { request } = await loadServer({ ...state, cliState: { ok: true, bin: '/oats', features: ['instance-pin'] } }, {
    instancePinRequest: async (body) => { asked.push(body); return answer; }, instancePinNotRun: code => ({ status: 'not-run', reason: { code } }),
    rereadsRoster, observeMutation: ws => reread.push(ws), remoteLoop: { request: () => reread.push('remote') },
  });
  const post = body => request({ url: `/api/instance-pin?ws=${encodeURIComponent(A)}`, method: 'POST', body });
  const first = await post({ instance: 'dev-a', home: HOME, pinned: true });
  assert.equal(first.status, 200); assert.deepEqual(first.body, answer);
  assert.deepEqual(asked, [{ instance: 'dev-a', home: HOME, pinned: true }]);
  assert.deepEqual(reread, [A], 'a change re-reads the roster at once, so the row moves');
  answer = { status: 'unknown', reason: { code: 'E_CLI_TIMEOUT' } };
  await post({ instance: 'dev-a', home: HOME, pinned: false });
  assert.deepEqual(reread, [A, A], 'an unknown outcome too');
  for (const quiet of [{ status: 'ok', instance: 'dev-a', pinned: true, changed: false }, { status: 'refused', reason: { code: 'E_SESSION_UNKNOWN', message: '' } },
    { status: 'ok', instance: 'dev-a', check: true }]) {
    answer = quiet;
    await post({ instance: 'dev-a', home: HOME, pinned: true });
  }
  assert.deepEqual(reread, [A, A], 'no change, a refusal and a check leave the roster as it is');
  const bad = await request({ url: `/api/instance-pin?ws=${encodeURIComponent(A)}&x=1`, method: 'POST', body: { instance: 'dev-a', home: HOME, pinned: true } });
  assert.equal(bad.status, 400); assert.deepEqual(bad.body, { status: 'not-run', reason: { code: 'E_BAD_ARGS' } });
});

// ── the palette ────────────────────────────────────────────────────────────────────────────────────────

const shell = readFileSync(new URL('../renderer/shell.mjs', import.meta.url), 'utf8');

test('the palette lists the pin command only where the leader\'s target offers it, and its rows in the pinned order', () => {
  const offers = { current: null };
  // The shipped entries, as shell.mjs builds them, over a target offer the test sets.
  const entries = shell.match(/^( {4}\.\.\.Object\.entries\(PIN_LABELS\)[^]*?\} \}\)\),)$/m)?.[1];
  assert.ok(entries, 'the shipped palette entries');
  const ran = [];
  const commands = runInNewContext(`[${entries}]`, { PIN_LABELS, paletteTargetId: 'T', pinTargetOffer: () => offers.current,
    takePickerFocusReturn: () => null, document: {}, runPinCommand: (id, action) => ran.push([id, action]) });
  const listed = raw => paletteRows([], commands, raw).map(r => r.label);
  assert.deepEqual(listed('>'), []);
  offers.current = 'pin-on';
  assert.deepEqual(listed('>'), ['Instance: Pin to top']);
  assert.deepEqual(listed('>unpin'), []);
  offers.current = 'pin-off';
  assert.deepEqual(listed('>'), ['Instance: Unpin']);
  paletteRows([], commands, '>').find(r => r.label === 'Instance: Unpin').run();
  assert.deepEqual(ran, [['T', 'pin-off']]);
  // Its instance rows: pinned first while this computer's CLI lists the feature, the roster's order without.
  const rows = [{ instance: 'new', home: '/w/new', agentsRoot: '/w', createdAt: '2026-11-19T10:00:00.000Z' },
    { instance: 'old-pin', home: '/w/old-pin', agentsRoot: '/w', createdAt: '2026-11-01T10:00:00.000Z', pinned: true }];
  const order = pins => paletteRows({ instances: rows, deployments: [], pins }, [], '').map(r => r.label);
  assert.deepEqual(order(true), ['old-pin', 'new']);
  assert.deepEqual(order(false), ['new', 'old-pin']);
});

test('the palette\'s target offer follows the row menu: no row, a stale or held one, or the gate closed offers nothing', () => {
  const source = shell.match(/^function pinTargetOffer\([^]*?\n\}/m)?.[0];
  assert.ok(source);
  const row = { instance: 'dev-1', home: '/w/dev-1', running: true };
  const context = { rosterInstance: id => (id === 'dev-1' ? context.row : null), row, rosterStale: false, contextDeployments: [],
    rowStale: () => false, desktopActs: r => (r.retirePending ? { blocked: null, limited: { code: 'held' }, acts: [] } : { blocked: null, limited: null, acts: [] }),
    pinMenu: { items: r => [{ action: r.pinned ? 'pin-off' : 'pin-on' }] } };
  const offer = runInNewContext(`${source}\npinTargetOffer`, context);
  assert.equal(offer('dev-1'), 'pin-on');
  context.row = { ...row, pinned: true }; assert.equal(offer('dev-1'), 'pin-off');
  assert.equal(offer(null), null); assert.equal(offer('other'), null);
  context.row = { ...row, retirePending: true }; assert.equal(offer('dev-1'), null, 'a retiring row');
  context.row = row; context.rosterStale = true; assert.equal(offer('dev-1'), null, 'a stale roster');
  context.rosterStale = false; context.pinMenu = { items: () => [] }; assert.equal(offer('dev-1'), null, 'the gate closed');
});

// ── the sidebar's paint ────────────────────────────────────────────────────────────────────────────────

const tree = { ...treeShared, ...treeView, ...sameWork };
const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
const fn = name => shell.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
const source = ['renderContextRoster', 'needsInputMark', 'setBackgroundOpen', 'onRosterRowKey', 'setRovingRow']
  .map(name => { const s = fn(name); assert.ok(s, name); return shell.includes(`async ${s}`) ? `async ${s}` : s; }).join('\n');
const at = (name, created, extra = {}) => ({ instance: name, agent: 'dev', home: `/synthetic/${name}`, agentsRoot: '/synthetic/agents',
  repoName: 'desktop-repo', running: true, runtimeState: 'running', createdAt: `2026-11-${String(created).padStart(2, '0')}T10:00:00.000Z`, ...extra });

function sidebar(t, { feature = true } = {}) {
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const context = {
    ...tree, ...viewContext(), document: doc, instanceActions, captureInstanceActionMenu, runtimeState, unsupportedSession, canAddressRemote, rowReason,
    createRuntimeBadge, iconElement, setTabTitle, NO_ANSWER_CODE, unservedError, instanceActionTarget, instanceSplitPlan,
    connectionGeneration: 0, menuState() {}, sayInHint() {}, runAction: assert.fail,
    applyChordTitles() {}, updateActiveContexts() {}, getBinding: () => null, formatChord: c => c, isMac: true,
    contextRosterEl: doc.querySelector('#instance-roster'), contextWorkspace: 'A', contextInstances: [], contextDeployments: [],
    rosterState: { hasData: true, state: 'ready' }, rosterStale: false, contextDeploymentNote: null,
    currentWorkspace: () => 'A', workspaceGeneration: () => 0, collapsedInstances: new Set(),
    rosterTip: { bind() {}, hide() {}, sync() {} }, rosterTipFacts, rosterPrs: { get: () => null, refresh() {} },
    spawnJobs: { rows: () => [], announce: () => false, check() {}, isNew: () => false, seen() {} },
    tabs: new Map(), activeTab: null, tabOpenIntents: { applyFocus: f => f(), invalidate() {} },
    openTerminalTab() {}, openInstanceStart() {}, openLifecycleDialog: assert.fail,
    api: assert.fail, showStage: assert.fail, refreshContextRoster: assert.fail,
    rosterKeyAction, moveTarget, revealInScrollport,
    // This computer's CLI lists the kernel's feature (shell.mjs pinsShown); the row menu's item is the menu suite's.
    pinsShown: () => feature,
  };
  context.splitOpenState = () => ({ split: null, activeId: null, tabs: context.tabs, workspace: 'A', visible: false });
  context.ownsInstanceTarget = () => true;
  Object.defineProperty(context, 'Date', { get: () => Date, enumerable: true });
  const s = runInNewContext(`${source}\n({ renderContextRoster })`, context);
  const list = doc.querySelector('.ctx-list');
  const render = rows => { context.contextInstances = rows; s.renderContextRoster(rows); };
  const rowEl = name => [...list.querySelectorAll('.ctx-inst')].find(b => b.querySelector('.ctx-name')?.dataset.name === name) ?? null;
  const drawn = () => [...list.querySelectorAll('.ctx-inst')].map(el => `${el.querySelector('.ctx-name').dataset.name}@${el.closest('.ctx-tree-row').style.getPropertyValue('--depth')}`);
  return { doc, render, rowEl, drawn };
}

test('sidebar: pinned rows lead the list, a pinned child lifts its group, each with the pin mark on its name line', t => {
  const u = sidebar(t);
  u.render([at('newest', 19), at('parent', 2), at('child', 3, { parentInstance: 'parent', pinned: true }), at('sib', 4, { parentInstance: 'parent' }), at('solo-pin', 1, { pinned: true })]);
  // Two pinned groups by their heads' spawn time (parent, then solo-pin); under parent, the pinned child first.
  assert.deepEqual(u.drawn(), ['parent@0', 'child@1', 'sib@1', 'solo-pin@0', 'newest@0']);
  for (const name of ['child', 'solo-pin']) {
    const line = u.rowEl(name).querySelector('.ctx-name-line');
    assert.ok(line, `${name}: a name line`);
    const mark = line.querySelector('.ctx-pin');
    assert.ok(mark, `${name}: the mark`);
    assert.equal(mark.getAttribute('role'), 'img'); assert.equal(mark.getAttribute('aria-label'), 'Pinned');
    assert.ok(mark.querySelector('svg[aria-hidden="true"]'), 'the icon itself is decorative; the mark carries the name');
    assert.equal(line.firstElementChild.className, 'ctx-name', 'the name first, then the mark');
  }
  for (const name of ['parent', 'sib', 'newest']) assert.equal(u.rowEl(name).querySelector('.ctx-pin'), null, `${name}: no mark (the parent is lifted, not pinned)`);
  assert.equal(u.rowEl('newest').querySelector('.ctx-name-line'), null, 'a row without marks keeps its plain name');
});

test('sidebar: without the feature on this computer\'s CLI, a row\'s pinned is ignored: the roster\'s order and no mark', t => {
  const u = sidebar(t, { feature: false });
  u.render([at('newest', 19), at('solo-pin', 1, { pinned: true })]);
  assert.deepEqual(u.drawn().map(d => d.split('@')[0]), ['newest', 'solo-pin']);
  assert.equal(u.rowEl('solo-pin').querySelector('.ctx-pin'), null);
});

test('sidebar: a stray value is no pin', t => {
  const u = sidebar(t);
  u.render([at('newest', 19), at('stray', 1, { pinned: 'true' })]);
  assert.deepEqual(u.drawn().map(d => d.split('@')[0]), ['newest', 'stray']);
  assert.equal(u.rowEl('stray').querySelector('.ctx-pin'), null);
});

test('pinnedMark: an image named Pinned around the pin icon', () => {
  const dom = new JSDOM('<body></body>');
  const mark = pinnedMark(dom.window.document);
  assert.equal(mark.className, 'ctx-pin'); assert.equal(mark.getAttribute('role'), 'img'); assert.equal(mark.getAttribute('aria-label'), 'Pinned');
  assert.equal(mark.textContent, '', 'no text that reads twice');
  dom.window.close();
});

test("a change of this computer's CLI that turns instance-pin on or off repaints the held roster, as Background's does; a probe that changes neither paints nothing", () => {
  // The shipped block (shell.mjs: the two features and the CLI subscriber), run as it is over a held roster.
  const source = readFileSync(new URL('../renderer/shell.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const backgroundShown = '), end = source.indexOf('\n});\n', source.indexOf('onCliChange(() => {', start)) + 4;
  assert.ok(start > 0 && end > start, 'the features and their subscriber are found in shell.mjs');
  let status = { ok: true, features: [] }, listener = null, paints = 0;
  runInNewContext(source.slice(start, end), {
    cliStatus: () => status, BACKGROUND_FEATURE: 'instance-background', PIN_FEATURE: 'instance-pin',
    onCliChange: fn => { listener = fn; }, contextRosterEl: {}, rosterState: { hasData: true }, contextInstances: [],
    renderContextRoster: () => { paints += 1; },
  });
  const probe = features => { status = { ok: true, features }; listener(status); return paints; };
  assert.equal(probe(['instance-pin']), 1, 'pin on: the same rows painted pinned first, with their marks');
  assert.equal(probe(['instance-pin', 'workspace-v2']), 1, 'another feature: nothing');
  assert.equal(probe([]), 2, 'pin off: painted in the roster order, no marks');
  assert.equal(probe(['instance-background']), 3, "Background's own change still repaints");
  assert.equal(probe(['instance-background']), 3);
});
