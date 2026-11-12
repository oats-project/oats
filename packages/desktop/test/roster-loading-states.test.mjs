// The sidebar roster's loading states (desktop/loading-states, Phase A #1):
// a workspace switch and the first read never show "No instances" / "0 running"
// — the count is a skeleton pill and, after 150ms, five roster-row skeletons
// wait in the list; a failure with data keeps the list, disables Start… and the
// row actions and paints "Couldn't refresh instances · observed <age>" + Retry;
// an unchanged 4s poll rebuilds nothing; the empty copy only follows a
// successful zero read. The shipped shell functions run in a vm context with
// the real primitive, instance tree and instance actions.
import test from 'node:test';
import { viewContext } from './helpers/view-context.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext, runInContext } from 'node:vm';
import { rosterPollDue, ROSTER_POLL_FOCUSED_MS } from '../renderer/roster-cadence.mjs';
import { withShellWindowGlobals } from './helpers/shell-window-globals.mjs';
import { JSDOM } from 'jsdom';
import * as treeShared from '../../client/instance-tree.mjs';
import * as sameWork from '../../client/same-work.mjs';
import * as treeView from '../renderer/instance-tree-view.mjs';
const tree = { ...treeShared, ...treeView, ...sameWork }; // the renderer's client imports, shipped
import { PENDING_DELAY_MS, REFRESHING_DELAY_MS, AGE_TICK_MS } from '../renderer/loading.mjs';
import { instanceActions, captureInstanceActionMenu } from '../renderer/instance-actions.mjs';
import { instanceActionTarget, sameInstanceActionTarget } from '../renderer/instance-action-target.mjs';
import { instanceSplitPlan } from '../renderer/instance-split.mjs';
import { runtimeState, unsupportedSession } from '../../client/instance-presentation.mjs';
import { canAddressRemote, rowReason } from '../../client/remote-address.mjs';
import { createRuntimeBadge } from '../renderer/identity-marks.mjs';
import { iconElement, mountShellIcons } from '../renderer/shell-icons.mjs';
import { rosterTipFacts } from '../renderer/roster-tip.mjs';
import { revealInScrollport } from '../renderer/reveal-in-scrollport.mjs';
import { prChip, prText } from '../renderer/roster-pr.mjs';
import { createPendingWatch, unservedError, NOT_SERVED_CODE, NO_ANSWER_CODE, PENDING_LIMIT_MS } from '../renderer/deployment-header.mjs';
import { deploymentUnavailableText } from '../../client/deployment-facts.mjs';
import { panelErrorCause } from '../../client/deployment-contract.mjs';
import { staleWorkspaceSelection } from '../renderer/views/common.mjs';
import { createWorkspaceTabMemory } from '../renderer/workspace-tab-memory.mjs';
import { createRetiresInFlight, retiringRows } from '../../client/retire-in-flight.mjs';

const read = name => readFileSync(new URL(`../renderer/${name}`, import.meta.url), 'utf8');
const source = read('shell.mjs');
const fn = name => {
  const found = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(found, `exercise shipped ${name}`); return found[0];
};
const tick = () => new Promise(resolve => setImmediate(resolve));

/** A fake clock: timers fire in order when advanced; `now()` follows. */
function clock() {
  let now = Date.parse('2026-09-29T14:05:00.000Z'), seq = 0; const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: id => { timers.delete(id); },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn();
      }
      now = until;
    },
  };
}
const row = (name, extra = {}) => ({ instance: name, home: `/synthetic/${name}`, agentsRoot: '/synthetic/agents', repoName: 'oats', branch: `b/${name}`, running: true, ...extra });
const roster = [row('alpha'), row('beta', { running: false }), row('gamma', { parentInstance: 'alpha' })];
const panelOf = (ws, instances, extra = {}) => ({ workspace: { id: ws, name: ws }, workspaces: [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }], deployment: { status: 'observed' }, instances, ...extra });

/* ── the helpers in instance-tree-view.mjs ─────────────────────────────────────── */
function rosterDom(t, html = read('index.html')) {
  const dom = new JSDOM(html, { pretendToBeVisual: true }); t.after(() => dom.window.close());
  return { dom, doc: dom.window.document, rosterEl: dom.window.document.getElementById('instance-roster') };
}

test('renderRosterCount: pending is a skeleton pill kept in place, never "0 running"; stale is titled as the last observation', t => {
  const { doc, rosterEl } = rosterDom(t);
  const count = rosterEl.querySelector('.ctx-count');
  tree.renderRosterCount(count, [], { pending: true });
  const pill = count.querySelector('.skeleton-pill');
  assert.ok(pill); assert.equal(pill.getAttribute('aria-hidden'), 'true'); assert.equal(count.textContent, '');
  assert.equal(count.hasAttribute('title'), false, 'no breakdown to tell yet');
  tree.renderRosterCount(count, [], { pending: true });
  assert.equal(count.querySelector('.skeleton-pill'), pill, 'a repeated pending paint keeps the same pill');
  tree.renderRosterCount(count, roster);
  assert.equal(count.textContent, '2 running'); assert.equal(count.title, '2 running · 1 stopped'); assert.equal(count.dataset.stale, undefined);
  tree.renderRosterCount(count, roster, { stale: true });
  assert.equal(count.textContent, 'Last observation: 2 running', 'AT hears that it is the last observation'); assert.ok(count.querySelector('.ctx-count-stale.loading-sr'), 'visually hidden: the visible number is what was last observed');
  assert.equal(count.title, 'Last observation — 2 running · 1 stopped'); assert.equal(count.dataset.stale, '1');
  assert.match(readFileSync(new URL('../renderer/shell.css', import.meta.url), 'utf8'), /\.ctx-count\[data-stale\] \{ color: var\(--muted\)/, 'and it looks muted, not current');
  tree.renderRosterCount(count, roster);
  assert.equal(count.dataset.stale, undefined);
  assert.equal(doc.querySelectorAll('.skeleton-pill').length, 0);
  tree.renderRosterCount(count, [], { failed: true });
  assert.equal(count.textContent, ''); assert.equal(count.querySelector('.skeleton'), null, 'failed: nothing animates'); assert.equal(count.querySelector('.ctx-count-reserve').getAttribute('aria-hidden'), 'true');
  assert.equal(count.hasAttribute('title'), false);
});

test('createRosterLoading wires the shipped chrome: list region, head indicator, a .ctx-status host before the list, a hidden status line', t => {
  const { doc, rosterEl } = rosterDom(t);
  const c = clock();
  const state = tree.createRosterLoading(doc, rosterEl, { now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout });
  const list = rosterEl.querySelector('.ctx-list'), status = rosterEl.querySelector('.ctx-status');
  assert.ok(status, 'the stale-line host exists'); assert.equal(status.nextElementSibling, list, 'right before the list');
  assert.equal(status.previousElementSibling.className, 'ctx-head', 'right after the head (the roster has no filter field)');
  const live = rosterEl.querySelector('[role="status"]');
  assert.ok(live.classList.contains('loading-sr'), 'the sidebar has no visible status line: it only speaks');
  state.begin();
  assert.equal(list.getAttribute('aria-busy'), 'true'); assert.equal(live.textContent, 'Loading instances…');
  assert.equal(list.querySelector('[data-skeleton]'), null, 'nothing before the delay');
  c.advance(PENDING_DELAY_MS);
  const block = list.querySelector('.skeleton-roster-rows');
  assert.equal(block.querySelectorAll('.skeleton-roster-row').length, tree.ROSTER_SKELETON_ROWS);
  state.succeed({ observedAt: new Date(c.now()).toISOString() });
  assert.equal(list.getAttribute('aria-busy'), null); assert.equal(list.querySelector('[data-skeleton]'), null);
  state.begin(); c.advance(REFRESHING_DELAY_MS);
  const indicator = rosterEl.querySelector('.ctx-head .loading-refreshing');
  // After the count, closing the heading, which holds no control (2026-10-26: Spawn instance is the foot's), and shown
  // in words beside it (shell.css `.ctx-head > .loading-refreshing { flex: none; margin-left: 6px; }`: no clipping).
  assert.equal(indicator.textContent, 'Refreshing…'); assert.equal(indicator.nextElementSibling, null, 'appended last');
  assert.equal(indicator.previousElementSibling.className, 'ctx-count', 'after the count');
  assert.deepEqual([...rosterEl.querySelectorAll('.ctx-head button')], [], 'the heading holds no control');
  const css = readFileSync(new URL('../renderer/shell.css', import.meta.url), 'utf8');
  assert.match(css, /^\.ctx-head > \.loading-refreshing \{ flex: none; margin-left: 6px; \}$/m, 'its words shown in full after the count');
  assert.doesNotMatch(css, /\.ctx-head-add|\.loading-refreshing \{[^}]*(?:width|overflow)/, 'no + to order after, and no clipping to its dot');
  c.advance(30_000); state.fail(new Error('boom'));
  assert.equal(status.querySelector('.loading-notice-text').textContent, "Couldn't refresh instances · observed 30s ago");
  assert.equal(status.querySelector('.loading-retry').textContent, 'Retry');
  // A focused Retry that vanishes on success hands focus to the roster's current row (the rows as painted).
  list.innerHTML = '<div class="ctx-tree-row"><button class="ctx-inst" tabindex="-1">a</button></div><div class="ctx-tree-row"><button class="ctx-inst" tabindex="0">b</button></div>';
  status.querySelector('.loading-retry').focus(); state.begin(); state.succeed({ observedAt: new Date(c.now()).toISOString() });
  assert.equal(doc.activeElement, list.querySelector('.ctx-inst[tabindex="0"]'));
  assert.equal(status.children.length, 0);
  // With no rows (an empty roster): its one action, the foot's Spawn instance (the shell's rosterEntry rule),
  // else (no Spawn instance to take it) the list of workspaces' stop, else its Add local workspace…; never nothing.
  const retryAgain = () => { state.begin(); c.advance(1_000); state.fail(new Error('boom')); status.querySelector('.loading-retry').focus();
    state.begin(); state.succeed({ observedAt: new Date(c.now()).toISOString() }); };
  list.innerHTML = '<div class="ctx-empty">No instances.</div>';
  doc.getElementById('ws-options').innerHTML = '<ul class="ws-group"><li class="ws-option-row"><button type="button" class="ws-option" aria-current="true" tabindex="0">A</button></li></ul>';
  retryAgain(); assert.equal(doc.activeElement, doc.getElementById('sidebar-spawn'), 'an empty roster: the foot\'s Spawn instance');
  doc.getElementById('sidebar-spawn').hidden = true;
  retryAgain(); assert.equal(doc.activeElement, doc.querySelector('#ws-options .ws-option'));
  doc.getElementById('ws-options').innerHTML = '';
  retryAgain(); assert.equal(doc.activeElement, doc.getElementById('ws-add-open'));
});

test('createRosterLoading survives a test DOM without a head: the status host still precedes the list', t => {
  const { doc, rosterEl } = rosterDom(t, '<div id="instance-roster"><span class="ctx-count"></span><div class="ctx-list"></div></div>');
  const state = tree.createRosterLoading(doc, rosterEl);
  assert.equal(rosterEl.querySelector('.ctx-status').nextElementSibling, rosterEl.querySelector('.ctx-list'));
  state.begin(); state.succeed(); state.begin();
  assert.equal(rosterEl.querySelector('.loading-refreshing'), null, 'no head, no indicator host');
  state.dispose();
});

test('rosterSignature: identical instances and facts agree; any painted fact changes it', () => {
  const facts = { workspace: 'A', error: null, deploymentNote: null, activeKey: null, connection: 0 };
  assert.equal(tree.rosterSignature(roster, facts), tree.rosterSignature(roster.map(r => ({ ...r })), { ...facts }));
  assert.notEqual(tree.rosterSignature(roster, facts), tree.rosterSignature(roster.slice(1), facts));
  for (const change of [{ workspace: 'B' }, { error: 'Server is unreachable' }, { deploymentNote: 'x' }, { activeKey: 'A:alpha' }, { connection: 1 }]) {
    assert.notEqual(tree.rosterSignature(roster, facts), tree.rosterSignature(roster, { ...facts, ...change }));
  }
  assert.notEqual(tree.rosterSignature([row('a')], facts), tree.rosterSignature([row('a', { running: false })], facts), 'a state change repaints');
});

/* ── the shipped shell: initContextRoster + refreshContextRoster + renderContextRoster (+ restoreWorkspaceTabs) ── */
function shell(t, { addResult = { ok: true, workspace: { id: 'A' } }, workspace = 'A', inFlight = false } = {}) {
  const { dom, doc, rosterEl } = rosterDom(t);
  mountShellIcons(doc);
  // jsdom has no top-layer API: model only the popover's open/close events (as instance-actions.test.mjs does).
  for (const [method, newState] of [['showPopover', 'open'], ['hidePopover', 'closed']]) {
    dom.window.HTMLElement.prototype[method] = function () {
      const event = new dom.window.Event('beforetoggle');
      Object.defineProperty(event, 'newState', { value: newState });
      this.dispatchEvent(event);
    };
  }
  const c = clock(), requests = [], listeners = [], adds = [];
  const context = {
    ...tree, document: doc, console,
    // The controller is built by the shipped initContextRoster; the clock is the test's.
    createRosterLoading: (d, el, options) => tree.createRosterLoading(d, el, { ...options, now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout }),
    instanceActions, captureInstanceActionMenu, runtimeState, unsupportedSession, canAddressRemote, rowReason, createRuntimeBadge, instanceActionTarget, instanceSplitPlan, iconElement, prChip, prText, revealInScrollport,
    rosterTipFacts, deploymentUnavailableText, staleWorkspaceSelection, panelErrorCause,
    // #461: the bounded wait runs on the test's clock; Re-add goes to a recorded bridge.
    rosterPendingWatch: createPendingWatch({ now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, onOverdue: subject => context.rosterOverdue(subject) }), unservedError, NOT_SERVED_CODE, NO_ANSWER_CODE, rosterReAddLease: 0,
    desktopBridge: { workspaceAdd: async path => { adds.push(path); return typeof addResult === 'function' ? addResult(path) : addResult; } },
    noteUnlisted: result => result, // #1390: a committed add's listing failure is the notifications' (deployments-list tests)
    rosterTip: { bind() {}, hide() {}, sync() {} }, rosterPrs: { get: () => null, refresh() {} }, spawnJobs: { rows: () => [], announce: () => false, observe() {}, settling: () => false, check() {} }, ctx: {},
    connectionGeneration: 0, menuState() {}, runAction: assert.fail, said: [], sayInHint: line => context.said.push(line), getBinding: () => null, formatChord: x => x, isMac: true,
    contextRosterEl: null, contextRosterGen: 0, contextWorkspace: workspace, contextInstances: [], tabWorkspace: workspace,
    rosterState: null, rosterStale: false, contextDeploymentNote: null, ...viewContext(), rosterSignaturePainted: null,
    workspace, generation: 0, tabs: new Map(), activeTab: null, split: null, sidebarMode: 'instances', tabLayerVisible: false,
    stage: { name: 'hierarchy' }, collapsedInstances: new Set(),
    workspaceGeneration: () => context.generation, currentWorkspace: () => context.workspace,
    adoptWorkspace: ws => { context.workspace = ws; },
    workspaceLabel: { begin: () => () => false, reset() {} },
    tabOpenIntents: { applyFocus: f => f(), invalidate() {}, isApplyingFocus: () => false },
    brainIntents: { invalidate() {} }, workspaceTabMemory: createWorkspaceTabMemory(),
    showTabLayer() {}, renderSplit() {}, setSidebarMode() {}, activateTab() {}, stageSidebarMode: () => 'overview', setNavActive() {}, updateContextTabs() {},
    refreshPanelInstance() {}, openTerminalTab: assert.fail, openInstanceStart: assert.fail, onRosterRowKey: assert.fail,
    api(path) { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); requests.push({ path, resolve, reject }); return promise; },
    showStage: assert.fail, updateActiveContexts() {}, applyChordTitles() {},
  };
  context.splitOpenState = () => ({ split: null, activeId: context.activeTab, tabs: context.tabs, workspace: context.workspace, visible: false });
  context.ownsInstanceTarget = target => context.contextInstances.filter(r => sameInstanceActionTarget(target, r, context.workspace)).length === 1;
  // #1247: the shipped tracker wiring (shownRows, retiresChanged) with the shared home's tracker, marked by the
  // shipped read generation, when the suite is about this window's retires in flight.
  if (inFlight) Object.assign(context, { retiringRows, retireListeners: new Set(),
    retires: createRetiresInFlight({ mark: () => context.contextRosterGen, onChange: () => context.retiresChanged() }) });
  const s = runInNewContext(`${['initContextRoster', 'rosterOverdue', 'failRosterUnserved', 'reAddRosterWorkspace', 'refreshContextRoster', 'renderContextRoster', 'restoreWorkspaceTabs', 'rosterEntry', 'setRovingRow',
    ...(inFlight ? ['shownRows', 'retiresChanged'] : [])].map(fn).join('\n')}
    ({ initContextRoster, refreshContextRoster, renderContextRoster, restoreWorkspaceTabs });`, withShellWindowGlobals(context));
  // #sidebar is not in index.html's roster section alone; initContextRoster listens on it.
  if (!doc.getElementById('sidebar')) { const aside = doc.createElement('aside'); aside.id = 'sidebar'; aside.append(rosterEl); doc.body.append(aside); }
  s.initContextRoster();
  const list = () => rosterEl.querySelector('.ctx-list');
  return {
    ...s, c, context, doc, dom, rosterEl, requests, list, adds,
    count: () => rosterEl.querySelector('.ctx-count'), status: () => rosterEl.querySelector('.ctx-status'), live: () => rosterEl.querySelector('[role="status"].loading-sr'),
    rows: () => [...list().querySelectorAll('.ctx-tree-row:not(.skeleton-roster-row)')], /* the skeleton wears the row class too */ names: () => [...list().querySelectorAll('.ctx-name')].map(n => n.dataset.name),
    text: () => list().textContent,
    async reply(index, panel) { requests[index].resolve(panel); await tick(); },
    async fail(index, error) { requests[index].reject(error); await tick(); },
    switchTo(ws) { context.workspace = ws; context.generation++; s.restoreWorkspaceTabs(); },
  };
}

test('first read: no false empty; the count is a pill; the skeleton waits 150ms and never shows for a fast reply', async t => {
  const s = shell(t);
  assert.equal(s.requests.length, 1, 'initContextRoster starts the first read');
  assert.equal(s.list().getAttribute('aria-busy'), 'true'); assert.equal(s.live().textContent, 'Loading instances…');
  assert.ok(s.count().querySelector('.skeleton-pill')); assert.doesNotMatch(s.count().textContent, /running/);
  assert.doesNotMatch(s.text(), /No instances|Roster unavailable/);
  s.c.advance(PENDING_DELAY_MS - 1); assert.equal(s.list().querySelector('[data-skeleton]'), null, 'nothing before 150ms');
  await s.reply(0, panelOf('A', roster));
  assert.equal(s.list().querySelector('[data-skeleton]'), null, 'a fast reply never flashed a skeleton');
  s.c.advance(PENDING_DELAY_MS); assert.equal(s.list().querySelector('[data-skeleton]'), null, 'and the cancelled timer paints none later');
  assert.deepEqual(s.names(), ['alpha', 'gamma', 'beta']); assert.equal(s.count().textContent, '2 running');
  assert.equal(s.list().getAttribute('aria-busy'), null); assert.equal(s.live().textContent, '', 'a background read announces nothing on success');
  assert.equal(s.context.rosterState.state, 'ready');
});

test('a slow first read shows five roster-row skeletons in the list, then the rows replace them; a repaint while pending keeps them', async t => {
  const s = shell(t);
  s.c.advance(PENDING_DELAY_MS);
  const block = s.list().querySelector('.skeleton-roster-rows');
  assert.equal(block.querySelectorAll('.skeleton-roster-row').length, 5); assert.equal(block.getAttribute('aria-hidden'), 'true');
  assert.equal(s.rows().length, 0); assert.doesNotMatch(s.text(), /No instances/);
  // Another paint while pending (a collapse, a PR change): still no empty copy and the skeleton stays.
  s.renderContextRoster(s.context.contextInstances);
  assert.ok(s.list().querySelector('.skeleton-roster-rows')); assert.doesNotMatch(s.text(), /No instances/);
  await s.reply(0, panelOf('A', roster));
  assert.equal(s.list().querySelector('[data-skeleton]'), null); assert.equal(s.rows().length, 3);
});

test('a successful zero read paints the empty copy, "No instances.", the roster\'s only empty copy (it has no filter)', async t => {
  const s = shell(t);
  assert.equal(s.rosterEl.querySelector('.ctx-filter, input'), null, 'the shipped roster has no filter field');
  await s.reply(0, panelOf('A', []));
  assert.equal(s.text(), 'No instances.'); assert.equal(s.count().textContent, '0 running');
  assert.equal(s.context.rosterState.state, 'empty'); assert.equal(s.list().getAttribute('aria-busy'), null);
  s.refreshContextRoster(); await s.reply(1, panelOf('A', roster));
  assert.deepEqual(s.names(), ['alpha', 'gamma', 'beta']);
  s.refreshContextRoster(); await s.reply(2, panelOf('A', []));
  assert.equal(s.text(), 'No instances.', 'emptied again: the same copy');
});

test('a failed first read paints the failed block (cause, Details, Retry) where the skeleton stood, never "Roster unavailable"; Retry re-reads as a user read', async t => {
  const s = shell(t);
  s.c.advance(PENDING_DELAY_MS);
  const error = new Error('bridge down'); error.code = 'E_BRIDGE';
  await s.fail(0, error);
  assert.equal(s.list().querySelector('[data-skeleton]'), null);
  const failed = s.list().querySelector('.loading-failed');
  assert.equal(failed.querySelector('.loading-failed-message').textContent, 'bridge down');
  assert.equal(failed.querySelector('.loading-failed-code').textContent, 'E_BRIDGE');
  assert.doesNotMatch(s.text(), /Roster unavailable|No instances/);
  assert.equal(s.list().getAttribute('aria-busy'), null, 'failed is not busy');
  assert.equal(s.live().textContent, "Couldn't refresh instances. bridge down");
  assert.equal(s.count().querySelector('.skeleton-pill'), null, 'failed: the pill would say "still loading"'); assert.ok(s.count().querySelector('.ctx-count-reserve'), 'the count box stays reserved, empty and still');
  const retry = failed.querySelector('.loading-retry'); retry.focus(); retry.click();
  assert.equal(s.requests.length, 2, 'Retry re-reads'); assert.equal(retry.getAttribute('aria-disabled'), 'true'); assert.equal(s.doc.activeElement, retry, 'never `disabled`: focus survives');
  retry.click(); assert.equal(s.requests.length, 2, 'a repeat activation while busy is ignored');
  assert.equal(s.list().getAttribute('aria-busy'), 'true'); assert.equal(s.live().textContent, 'Loading instances…');
  await s.reply(1, panelOf('A', roster));
  assert.equal(s.list().querySelector('.loading-failed'), null); assert.equal(s.rows().length, 3);
  assert.equal(s.live().textContent, 'Instances updated', 'a user-invoked read is announced');
  // The focused Retry went. The controller learns of the data before the rows are painted (refreshContextRoster),
  // so focusFallback holds focus outside the roster for a moment; once the rows exist, the roster's first row (no
  // current one yet) takes it, the one roving stop.
  const first = s.list().querySelector('.ctx-inst');
  assert.equal(s.doc.activeElement, first, 'the Retry hands focus to the rows it brought');
  assert.equal(s.list().querySelectorAll('.ctx-inst[tabindex="0"]').length, 1);
});

test('refreshing keeps rows and focus; "Refreshing…" appears in the head only after 400ms; an unchanged poll rebuilds nothing', async t => {
  const s = shell(t);
  await s.reply(0, panelOf('A', roster));
  const before = s.rows();
  const focused = before[1].querySelector('.ctx-inst'); focused.focus(); assert.equal(s.doc.activeElement, focused);
  s.refreshContextRoster();
  assert.equal(s.list().getAttribute('aria-busy'), null, 'refreshing is not busy'); assert.equal(s.context.rosterState.state, 'refreshing');
  assert.deepEqual(s.rows(), before, 'content stays'); assert.equal(s.doc.activeElement, focused);
  s.c.advance(REFRESHING_DELAY_MS - 1); assert.equal(s.rosterEl.querySelector('.loading-refreshing'), null);
  s.c.advance(1);
  const indicator = s.rosterEl.querySelector('.ctx-head > .loading-refreshing');
  assert.equal(indicator.textContent, 'Refreshing…'); assert.equal(indicator.nextElementSibling, null, 'appended last');
  assert.equal(indicator.previousElementSibling, s.count(), 'right after the count (the heading holds no control)');
  await s.reply(1, panelOf('A', roster.map(r => ({ ...r }))));
  assert.equal(s.rosterEl.querySelector('.loading-refreshing'), null);
  assert.deepEqual(s.rows(), before, 'identical data: the very same nodes'); assert.equal(s.doc.activeElement, focused);
  // Changed data repaints and restores the logical focus.
  s.refreshContextRoster(); await s.reply(2, panelOf('A', [...roster, row('delta')]));
  assert.notEqual(s.rows()[1], before[1]); assert.deepEqual(s.names(), ['alpha', 'gamma', 'beta', 'delta'], 'by name: the cluster, then its run of independent rows (#1262)');
  assert.equal(s.doc.activeElement.dataset.treeInstance, focused.dataset.treeInstance);
});

test('a fast refresh never shows "Refreshing…"; the active terminal changing repaints even with the same instances', async t => {
  const s = shell(t);
  await s.reply(0, panelOf('A', roster));
  s.refreshContextRoster(); await s.reply(1, panelOf('A', roster));
  s.c.advance(REFRESHING_DELAY_MS * 2);
  assert.equal(s.rosterEl.querySelector('.loading-refreshing'), null);
  const before = s.rows();
  s.context.tabs.set(1, { kind: 'terminal', key: tree.terminalKey('A', roster[0]) }); s.context.activeTab = 1;
  s.refreshContextRoster(); await s.reply(2, panelOf('A', roster));
  assert.notEqual(s.rows()[0], before[0], 'the active highlight is part of the paint');
  assert.ok(s.rows()[0].classList.contains('active'));
});

test('failure with data: rows kept, stale line with the observed age and Retry, Start… disabled and the row context menu held, the terminal row enabled', async t => {
  const s = shell(t);
  await s.reply(0, panelOf('A', roster, { observedAt: new Date(s.c.now()).toISOString() }));
  const alpha = s.rows()[0].querySelector('.ctx-inst'); alpha.focus();
  s.c.advance(45_000);
  s.refreshContextRoster(); await s.fail(1, new Error('bridge down'));
  assert.equal(s.context.rosterState.state, 'stale'); assert.equal(s.rows().length, 3, 'the list is kept');
  assert.equal(s.list().getAttribute('aria-busy'), null); assert.equal(s.list().querySelector('[data-skeleton], .loading-failed'), null);
  const notice = s.status().querySelector('.loading-notice[data-kind="stale"]');
  assert.equal(notice.querySelector('.loading-notice-text').textContent, "Couldn't refresh instances · observed 45s ago");
  assert.equal(notice.title, 'bridge down');
  const retry = notice.querySelector('.loading-retry'); assert.equal(retry.textContent, 'Retry'); assert.equal(retry.getAttribute('aria-disabled'), null);
  assert.equal(s.live().textContent, "Couldn't refresh instances.");
  assert.equal(s.count().title, 'Last observation — 2 running · 1 stopped'); assert.equal(s.count().textContent, 'Last observation: 2 running');
  assert.equal(s.doc.activeElement.dataset.treeInstance, alpha.dataset.treeInstance, 'the focused row survives the stale repaint');
  // Stale marks are aria-disabled (Chromium blurs a focused control that becomes `disabled`), with the reason; their activation does nothing.
  const start = s.list().querySelector('.ctx-start'); start.focus();
  assert.equal(start.disabled, false); assert.equal(start.getAttribute('aria-disabled'), 'true'); assert.equal(start.title, tree.ROSTER_STALE_TITLE); assert.equal(start.getAttribute('aria-description'), 'Unavailable: roster is not current', 'an accessible reason, not just a greyed look');
  start.click(); assert.equal(s.doc.activeElement, start, 'a stale Start… starts nothing (openInstanceStart is assert.fail here) and keeps focus');
  // #1559: no ⋯ trigger on any row. A stale roster holds every row's context menu: a right-click (at the pointer) or a
  // key (Shift+F10, the Menu key: no pointer) opens nothing, says why in the hint's line, and leaves focus on the row.
  assert.equal(s.list().querySelector('.ctx-instance-actions'), null, 'no ⋯ trigger on a stale roster');
  for (const r of s.rows()) {
    const button = r.querySelector('.ctx-inst'), menu = r.querySelector('.ctx-instance-menu');
    for (const at of [{ clientX: 12, clientY: 8 }, { clientX: 0, clientY: 0 }]) {
      button.focus(); s.context.said.length = 0;
      button.dispatchEvent(new s.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, ...at }));
      assert.deepEqual(s.context.said, [tree.ROSTER_STALE_TITLE], `${button.dataset.treeInstance}: says why (${at.clientX ? 'pointer' : 'key'})`);
      assert.notEqual(menu.dataset.instanceMenuOpen, 'true', 'opens nothing');
      assert.equal(s.doc.activeElement, button, 'focus stays on the row');
    }
  }
  // The row itself: a running row still opens its terminal; a stopped row's activation (click, Enter) starts nothing and says why — the
  // roster may be wrong about running:false by now (the maintainer's return on #322).
  const alphaRow = s.rows()[0].querySelector('.ctx-inst'), betaRow = s.rows().find(r => r.querySelector('.ctx-name').dataset.name === 'beta').querySelector('.ctx-inst');
  assert.equal(alphaRow.disabled, false); assert.equal(alphaRow.getAttribute('aria-description'), null, 'opening the existing terminal stays possible');
  assert.equal(betaRow.getAttribute('aria-description'), tree.ROSTER_STALE_TITLE); assert.equal(betaRow.title, tree.ROSTER_STALE_TITLE);
  betaRow.click(); // openInstanceStart is assert.fail in this shell: reaching it would fail the test
  alphaRow.focus();
  // The age line keeps itself current.
  s.c.advance(AGE_TICK_MS);
  assert.equal(notice.querySelector('.loading-notice-text').textContent, "Couldn't refresh instances · observed 1 min ago");
  // A repeat failure keeps the rows (already stale) and updates the line in place.
  const staleRows = s.rows();
  s.refreshContextRoster(); await s.fail(2, new Error('still down'));
  assert.deepEqual(s.rows(), staleRows); assert.equal(s.status().querySelector('.loading-notice'), notice); assert.equal(notice.title, 'still down');
  // Retry: a user read; while it is in flight the Retry is aria-disabled and keeps focus; success clears the line and re-enables actions.
  retry.focus(); retry.click();
  assert.equal(s.requests.length, 4); assert.equal(retry.getAttribute('aria-disabled'), 'true'); assert.equal(s.doc.activeElement, retry);
  assert.equal(s.rows().length, 3, 'still kept while retrying');
  await s.reply(3, panelOf('A', roster, { observedAt: new Date(s.c.now()).toISOString() }));
  assert.equal(s.status().children.length, 0); assert.equal(s.context.rosterState.state, 'ready');
  assert.equal(s.list().querySelector('.ctx-start').getAttribute('aria-disabled'), null); assert.equal(s.list().querySelector('.ctx-start').title, '');
  assert.equal(s.rows().find(r => r.querySelector('.ctx-name').dataset.name === 'beta').querySelector('.ctx-inst').getAttribute('aria-description'), null, 'the stopped row is a Start again');
  assert.equal(s.count().dataset.stale, undefined);
  assert.equal(s.live().textContent, 'Instances updated');
  assert.equal(s.doc.activeElement, s.list().querySelector('.ctx-inst[tabindex="0"]'), 'the vanished Retry hands focus to the roster\'s current row, not to nothing');
  // Current again: the row's context menu opens, and says nothing.
  const current = s.rows()[0].querySelector('.ctx-inst'), menu = s.rows()[0].querySelector('.ctx-instance-menu');
  current.focus(); s.context.said.length = 0;
  current.dispatchEvent(new s.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  assert.equal(menu.dataset.instanceMenuOpen, 'true'); assert.deepEqual(s.context.said, []); assert.ok(menu.contains(s.doc.activeElement));
});

test('a reported panel error beside instances is the last observation: stale line, actions disabled, no ctx-empty error; repeats update in place', async t => {
  const s = shell(t);
  await s.reply(0, panelOf('A', roster, { error: 'Server is unreachable' }));
  assert.equal(s.rows().length, 3); assert.equal(s.list().querySelector('.ctx-empty'), null, 'the error is no longer a list row');
  assert.equal(s.context.rosterState.state, 'stale');
  const notice = s.status().querySelector('.loading-notice[data-kind="stale"]');
  assert.equal(notice.title, 'Server is unreachable'); assert.match(notice.textContent, /^Couldn't refresh instances/);
  assert.equal(s.list().querySelector('.ctx-start').getAttribute('aria-disabled'), 'true');
  assert.equal(s.live().textContent, "Couldn't refresh instances.");
  const rows = s.rows();
  s.refreshContextRoster(); await s.reply(1, panelOf('A', roster, { error: 'Server is unreachable' }));
  assert.deepEqual(s.rows(), rows, 'the same failing observation repaints nothing');
  assert.equal(s.status().querySelector('.loading-notice'), notice, 'the stale line is updated in place');
  assert.equal(s.live().textContent, "Couldn't refresh instances.", 'and not announced anew');
  s.refreshContextRoster(); await s.reply(2, panelOf('A', roster));
  assert.equal(s.status().children.length, 0); assert.equal(s.list().querySelector('.ctx-start').getAttribute('aria-disabled'), null);
  assert.equal(s.context.rosterState.state, 'ready');
});

test('a deployment the kernel could not observe keeps its own note above the rows (no skeleton), and the note is part of the signature', async t => {
  const s = shell(t);
  await s.reply(0, panelOf('A', roster, { deployment: { status: 'unavailable', reason: { code: 'E_X', message: 'refused' } } }));
  const note = s.list().querySelector('.ctx-empty');
  assert.equal(note.textContent, 'E_X: refused'); assert.equal(note.getAttribute('role'), 'status'); assert.equal(note, s.list().firstElementChild);
  assert.equal(s.rows().length, 3);
  s.refreshContextRoster(); await s.reply(1, panelOf('A', roster, { deployment: { status: 'unavailable', reason: { code: 'E_X', message: 'refused' } } }));
  assert.equal(s.list().querySelector('.ctx-empty'), note, 'unchanged: kept');
  s.refreshContextRoster(); await s.reply(2, panelOf('A', roster));
  assert.equal(s.list().querySelector('.ctx-empty'), null, 'observed: the note goes');
});

test('a workspace switch clears the rows into pending (pill, then skeletons), never "No instances" / "0 running"; a late reply for the old workspace is dropped', async t => {
  const s = shell(t);
  await s.reply(0, panelOf('A', roster));
  assert.equal(s.rows().length, 3);
  s.refreshContextRoster(); // a poll for A in flight
  s.switchTo('B');
  assert.equal(s.rows().length, 0, 'the old rows go at once'); assert.doesNotMatch(s.text(), /No instances/);
  assert.ok(s.count().querySelector('.skeleton-pill')); assert.doesNotMatch(s.count().textContent, /running/);
  assert.equal(s.list().getAttribute('aria-busy'), 'true'); assert.equal(s.context.rosterState.state, 'pending');
  assert.equal(s.requests.length, 3); assert.equal(s.requests[2].path, '/api/panel?ws=B');
  await s.reply(1, panelOf('A', [row('late')]));
  assert.equal(s.rows().length, 0, 'the superseded read paints nothing'); assert.equal(s.context.rosterState.state, 'pending', 'and does not settle the new subject');
  s.c.advance(PENDING_DELAY_MS);
  assert.equal(s.list().querySelectorAll('.skeleton-roster-row').length, 5);
  await s.reply(2, panelOf('B', [row('b-one')]));
  assert.deepEqual(s.names(), ['b-one']); assert.equal(s.count().textContent, '1 running'); assert.equal(s.list().querySelector('[data-skeleton]'), null);
});

// A switch's roster focus place (shell.mjs focusArrival) waits for the arriving workspace's first paint of rows (or of
// the empty copy, or of a failed read's Retry): every such paint calls applyRosterPlace; a pending one does not.
test('the roster paints that apply a waiting focus place: rows, the empty copy, a failed read; never a pending paint', async t => {
  const s = shell(t);
  const painted = [];
  s.context.applyRosterPlace = () => painted.push(s.context.rosterState.state);
  await s.reply(0, panelOf('A', roster));
  assert.deepEqual(painted, ['ready'], 'the rows');
  s.switchTo('B');
  assert.deepEqual(painted, ['ready'], "the switch's own paint: pending, no rows yet");
  await s.reply(1, panelOf('B', []));
  assert.deepEqual(painted, ['ready', 'empty'], 'the empty copy');
  s.switchTo('A');
  await s.fail(2, new Error('boom'));
  assert.deepEqual(painted, ['ready', 'empty', 'failed'], "a failed first read: its Retry");
  s.switchTo('B');
  await s.reply(3, panelOf('B', [], { deployment: { status: 'pending' } }));
  assert.deepEqual(painted, ['ready', 'empty', 'failed'], 'a deployment not observed yet: its note, no rows');
  s.switchTo('A');
  await s.reply(4, panelOf('A', [], { error: 'Server is unreachable' }));
  assert.deepEqual(painted, ['ready', 'empty', 'failed', 'failed'], 'a panel that reports an error with no instances: its Retry');
});

test('a switch away from a stale roster forgets the stale mark and the stale line; a superseded failure paints nothing', async t => {
  const s = shell(t);
  await s.reply(0, panelOf('A', roster));
  s.refreshContextRoster(); await s.fail(1, new Error('down'));
  assert.ok(s.status().querySelector('.loading-notice')); assert.equal(s.context.rosterStale, true);
  s.refreshContextRoster(); // in flight
  s.switchTo('B');
  assert.equal(s.status().children.length, 0); assert.equal(s.context.rosterStale, false); assert.equal(s.context.rosterSignaturePainted, null);
  await s.fail(2, new Error('late'));
  assert.equal(s.list().querySelector('.loading-failed'), null, 'a superseded failure is not this subject\'s failure');
  assert.equal(s.context.rosterState.state, 'pending');
  await s.reply(3, panelOf('B', [row('b-one', { running: false })]));
  assert.equal(s.list().querySelector('.ctx-start').disabled, false, 'B starts unmarked');
});

test('the retired wording is gone from the roster and the fixed wording is the primitive\'s', () => {
  const roster = source.slice(source.indexOf('function initContextRoster'), source.indexOf('function onRosterRowKey'));
  assert.doesNotMatch(roster, /Roster unavailable|Loading agents|Loading reported roster|Reading /);
  assert.match(source, /rosterState\?\.reset\(\);[\s\S]*renderContextRoster\(\[\]\);/, 'a switch resets the subject before the list is cleared');
  // One read at a time, every 4 s while focused, at the blurred cadence otherwise (roster-cadence.mjs, #481).
  assert.match(source, /setInterval\(\(\) => \{\n  if \(!rosterPoll && rosterPollDue\(/, 'the poll stays single-flight');
});

test('a deployment the server has not observed yet (status pending, no instances) keeps its own note: no "No instances", the count stays a pill, no skeleton; the observation then paints the rows', async t => {
  const u = shell(t);
  await u.reply(0, panelOf('A', [], { deployment: { status: 'pending' } }));
  assert.equal(u.text(), 'Reading the deployment through the installed OATS CLI…', 'the existing copy, alone');
  assert.doesNotMatch(u.text(), /No instances/); assert.ok(u.count().querySelector('.skeleton-pill'), 'never "0 running"');
  assert.equal(u.list().getAttribute('aria-busy'), 'true', 'still loading, truthfully'); u.c.advance(PENDING_DELAY_MS + 10); assert.equal(u.list().querySelector('.skeleton'), null, 'a deployment state is not a skeleton');
  assert.equal(u.live().textContent, 'Loading instances…', 'announced once');
  // The next polls repeat the same panel: no repaint (the note stays the same node).
  const note = u.list().querySelector('.ctx-empty');
  void u.refreshContextRoster(); await u.reply(1, panelOf('A', [], { deployment: { status: 'pending' } }));
  assert.equal(u.list().querySelector('.ctx-empty'), note);
  void u.refreshContextRoster(); await u.reply(2, panelOf('A', roster));
  assert.deepEqual(u.names(), ['alpha', 'gamma', 'beta']); assert.equal(u.count().textContent, '2 running'); assert.equal(u.list().querySelector('.ctx-empty'), null);
});

test('a panel that reports an error with no instances is a failed read, never "No instances.": failed block without data, stale rows kept with data', async t => {
  const u = shell(t);
  await u.reply(0, panelOf('A', [], { error: 'Server is unreachable' }));
  assert.doesNotMatch(u.text(), /No instances/); assert.equal(u.context.rosterState.state, 'failed');
  assert.equal(u.list().querySelector('.loading-failed-message').textContent, 'Server is unreachable'); assert.ok(u.list().querySelector('.loading-retry'));
  assert.equal(u.count().querySelector('.skeleton-pill'), null, 'failed: no shimmering pill says "still loading"'); assert.ok(u.count().querySelector('.ctx-count-reserve'), 'the box stays reserved, empty and still');
  assert.doesNotMatch(u.count().textContent, /running/); assert.equal(u.live().textContent, "Couldn't refresh instances. Server is unreachable");
  // Data lands, then the same failed reply: rows kept and stale, the error on the stale line.
  void u.refreshContextRoster(); await u.reply(1, panelOf('A', roster));
  assert.deepEqual(u.names(), ['alpha', 'gamma', 'beta']); assert.equal(u.context.rosterState.state, 'ready');
  void u.refreshContextRoster(); await u.reply(2, panelOf('A', [], { error: 'Server is unreachable' }));
  assert.deepEqual(u.names(), ['alpha', 'gamma', 'beta'], 'the last observation stays'); assert.equal(u.context.rosterState.state, 'stale');
  assert.match(u.status().textContent, /Couldn't refresh instances/); assert.equal(u.status().querySelector('.loading-notice').title, 'Server is unreachable');
  assert.ok(u.rows().every(r => !r.querySelector('.ctx-start') || r.querySelector('.ctx-start').getAttribute('aria-disabled') === 'true'), 'stale: Start… held (aria-disabled)');
  assert.equal(u.count().dataset.stale, '1'); assert.equal(u.list().querySelector('.loading-failed'), null, 'no failed block over data');
});

test('the deployment note survives every other roster paint (collapse, PR change) and an unchanged poll, while pending and with rows', async t => {
  const u = shell(t);
  const alpha = tree.collapseKey('A', '/synthetic/alpha');
  // pending deployment: the note is the whole content; a repaint keeps it.
  await u.reply(0, panelOf('A', [], { deployment: { status: 'pending' } }));
  u.renderContextRoster(u.context.contextInstances);
  assert.equal(u.text(), 'Reading the deployment through the installed OATS CLI…'); assert.equal(u.list().getAttribute('aria-busy'), 'true');
  void u.refreshContextRoster(); await u.reply(1, panelOf('A', [], { deployment: { status: 'pending' } }));
  assert.equal(u.text(), 'Reading the deployment through the installed OATS CLI…', 'an unchanged poll keeps it');
  // unavailable deployment with rows: the note stays above the rows through a collapse, an expand, a repaint and an unchanged poll.
  const unavailable = { status: 'unavailable', reason: { code: 'E_X', message: 'no kernel' } };
  void u.refreshContextRoster(); await u.reply(2, panelOf('A', roster, { deployment: unavailable }));
  const noteText = () => u.list().querySelector('.ctx-deployment-note')?.textContent;
  assert.equal(noteText(), 'E_X: no kernel'); assert.equal(u.list().firstElementChild.className, 'ctx-empty ctx-deployment-note');
  u.context.collapsedInstances.add(alpha); u.renderContextRoster(u.context.contextInstances);
  assert.equal(noteText(), 'E_X: no kernel'); assert.deepEqual(u.names(), ['alpha', 'beta'], 'alpha collapsed: gamma hidden');
  u.context.collapsedInstances.delete(alpha); u.renderContextRoster(u.context.contextInstances);
  assert.equal(noteText(), 'E_X: no kernel'); assert.deepEqual(u.names(), ['alpha', 'gamma', 'beta']);
  u.renderContextRoster(u.context.contextInstances); assert.equal(noteText(), 'E_X: no kernel', 'the PR-change path repaints it too');
  void u.refreshContextRoster(); await u.reply(3, panelOf('A', roster, { deployment: unavailable }));
  assert.equal(noteText(), 'E_X: no kernel'); assert.equal(u.list().querySelectorAll('.ctx-deployment-note').length, 1, 'never doubled');
  // an observed deployment drops it.
  void u.refreshContextRoster(); await u.reply(4, panelOf('A', roster)); assert.equal(u.list().querySelector('.ctx-deployment-note'), null);
});

test('a Herdr-recorded row cannot open or start: the row and its Open in split and Start say the kernel reason; Remove stays', async t => {
  const s = shell(t), reason = 'E_HERDR_REMOVED: Herdr is no longer supported by OATS (removed in 0.31.0); tmux is the only session backend.';
  await s.reply(0, panelOf('A', [row('alpha'), row('herdr-one', { agent: 'soul', running: null, runtimeState: 'unsupported', runtimeError: reason })]));
  const target = s.rows().find(r => r.textContent.includes('herdr-one')), open = target.querySelector('button[data-tree-control="terminal"]');
  assert.equal(open.getAttribute('aria-disabled'), 'true'); assert.equal(open.title, reason);
  assert.equal(target.querySelector('.ctx-start'), null, 'no enabled Start in the row tools');
  const item = action => target.querySelector(`[data-action="${action}"]`);
  for (const action of ['open-split', 'start']) { assert.equal(item(action).disabled, true, action); assert.equal(item(action).title, reason, action); }
  assert.equal(item('restart'), null); assert.equal(item('retire').disabled, false);
});

/* ── Spec D: a remote the kernel could not read, worded by its cause (E_REMOTE_UNREADABLE details.reason) ──
   Fixture of the kernel's documented shape (#386): details { url, key, reason: "cache", stage, cacheDir, lock? };
   the server forwards only { reason, host } (deployment-read-cli) and keeps the last observation. */
const CACHE_MESSAGE = 'cannot read github.com/awebai/oats: the remote cache is locked by /Users/op/.cache/oats/remotes/x/index.lock (no oats process holds it). Remove that file and retry.';
const cachePanel = (instances, extra = {}) => panelOf('A', instances, { observedAt: '2026-09-29T14:00:00.000Z', error: CACHE_MESSAGE, errorCause: { code: 'E_REMOTE_UNREADABLE', reason: 'cache' }, ...extra });

test('Spec D: a cache problem with data keeps the rows and says so: "Couldn\'t refresh instances · OATS cache problem · observed <age>", the kernel\'s message in full on the line, Retry; Details holds only the code', async t => {
  const s = shell(t);
  await s.reply(0, cachePanel(roster));
  assert.equal(s.rows().length, 3, 'the last observation stays');
  assert.equal(s.context.rosterState.state, 'stale');
  const notice = s.status().querySelector('.loading-notice[data-kind="stale"]');
  assert.equal(notice.dataset.variant, 'cache');
  assert.match(notice.querySelector('.loading-notice-text').textContent, /^Couldn't refresh instances · OATS cache problem · observed 5 min ago$/);
  const said = notice.querySelector('.loading-notice-message');
  assert.equal(said.hidden, false); assert.equal(said.textContent, CACHE_MESSAGE, 'the remedy, as given, not behind Details');
  assert.equal(notice.querySelector('.loading-notice-cause').textContent, 'E_REMOTE_UNREADABLE');
  assert.ok(notice.querySelector('.loading-retry'));
  assert.equal(s.live().textContent, "Couldn't refresh instances.", 'the existing announcement');
  const retry = notice.querySelector('.loading-retry'); retry.focus();
  s.refreshContextRoster(); await s.reply(1, cachePanel(roster));
  assert.equal(s.status().querySelector('.loading-notice'), notice, 'a repeat updates in place'); assert.equal(s.doc.activeElement, retry, 'focus kept');
  s.refreshContextRoster(); await s.reply(2, panelOf('A', roster));
  assert.equal(s.status().children.length, 0, 'a good read clears it');
});

test('Spec D: a cache problem with nothing observed is a failed read showing the kernel\'s message, never "No instances."', async t => {
  const s = shell(t);
  await s.reply(0, panelOf('A', [], { deployment: { status: 'unavailable', reason: { code: 'E_REMOTE_UNREADABLE', message: CACHE_MESSAGE, cause: { reason: 'cache' } } } }));
  assert.equal(s.context.rosterState.state, 'failed');
  const failed = s.list().querySelector('.loading-failed');
  assert.equal(failed.querySelector('.loading-failed-message').textContent, CACHE_MESSAGE);
  assert.equal(failed.querySelector('.loading-failed-code').textContent, 'E_REMOTE_UNREADABLE');
  assert.ok(failed.querySelector('.loading-retry'));
  assert.doesNotMatch(s.text(), /No instances/); assert.equal(s.list().querySelector('.ctx-deployment-note'), null, 'not also a note');
});

test('Spec D: a network failure with data keeps the rows with the calm wording "Couldn\'t reach <host> · showing what was read <age>"; the raw code is behind Details', async t => {
  const s = shell(t);
  await s.reply(0, panelOf('A', roster, { observedAt: '2026-09-29T14:00:00.000Z', error: 'cannot read https://github.com/awebai/oats.git (network)', errorCause: { code: 'E_REMOTE_UNREADABLE', reason: 'network', host: 'github.com' } }));
  assert.equal(s.rows().length, 3);
  const notice = s.status().querySelector('.loading-notice[data-kind="stale"]');
  assert.equal(notice.querySelector('.loading-notice-text').textContent, "Couldn't reach github.com · showing what was read 5 min ago");
  assert.equal(notice.querySelector('.loading-notice-message').hidden, true, 'no message line for the network');
  assert.match(notice.querySelector('.loading-notice-cause').textContent, /\(E_REMOTE_UNREADABLE\)$/);
  assert.ok(notice.querySelector('.loading-retry'));
});

test('Spec D: an unknown reason, a malformed cause or none keeps the generic stale line', async t => {
  for (const errorCause of [{ code: 'E_REMOTE_UNREADABLE', reason: 'quota' }, { code: 'E_REMOTE_UNREADABLE', reason: 'cache', lock: '/x' }, { code: 'bad', reason: 'cache' }, undefined]) {
    const s = shell(t);
    await s.reply(0, panelOf('A', roster, { observedAt: '2026-09-29T14:00:00.000Z', error: 'cannot read it', ...(errorCause ? { errorCause } : {}) }));
    const notice = s.status().querySelector('.loading-notice[data-kind="stale"]');
    assert.equal(notice.querySelector('.loading-notice-text').textContent, "Couldn't refresh instances · observed 5 min ago", JSON.stringify(errorCause));
    assert.equal(notice.dataset.variant, undefined); assert.equal(notice.querySelector('.loading-notice-message').hidden, true);
  }
});

test('Spec D: a remote (server) panel without the cause renders exactly as before', async t => {
  const s = shell(t);
  await s.reply(0, panelOf('A', roster, { workspace: { id: 'A', name: 'A', remote: true }, error: 'Server is unreachable' }));
  const notice = s.status().querySelector('.loading-notice[data-kind="stale"]');
  assert.equal(notice.title, 'Server is unreachable'); assert.match(notice.textContent, /^Couldn't refresh instances/);
});

/* ── #982: the kept failure's message is shown with who made it; a failure with no words is still one ── */
test("the roster's failure notice says who made the kept message, in each spot it shows it: the stale line's title and Details, the cache problem's own line, the failed block, the spoken status", async t => {
  const stale = async (extra) => { const s = shell(t); await s.reply(0, panelOf('A', roster, { observedAt: '2026-09-29T14:00:00.000Z', ...extra })); return { s, notice: s.status().querySelector('.loading-notice[data-kind="stale"]') }; };
  // The kernel's message beside the last observation: the title and the Details line.
  let { s, notice } = await stale({ error: 'cannot read it', errorOrigin: 'kernel' });
  assert.equal(notice.title, 'OATS says: cannot read it'); assert.equal(notice.querySelector('.loading-notice-cause').textContent, 'OATS says: cannot read it');
  assert.equal(s.rows().length, 3); assert.equal(s.live().textContent, "Couldn't refresh instances.");
  ({ notice } = await stale({ error: 'cannot read it', errorOrigin: 'kernel', errorCause: { code: 'E_REMOTE_UNREADABLE', reason: 'network', host: 'github.com' } }));
  assert.equal(notice.title, 'OATS says: cannot read it (E_REMOTE_UNREADABLE)'); assert.equal(notice.querySelector('.loading-notice-cause').textContent, 'OATS says: cannot read it (E_REMOTE_UNREADABLE)');
  // A cache problem's remedy is on the line itself.
  ({ notice } = await stale({ error: CACHE_MESSAGE, errorOrigin: 'kernel', errorCause: { code: 'E_REMOTE_UNREADABLE', reason: 'cache' } }));
  assert.equal(notice.querySelector('.loading-notice-message').textContent, `OATS says: ${CACHE_MESSAGE}`);
  assert.equal(notice.querySelector('.loading-notice-cause').textContent, 'E_REMOTE_UNREADABLE', 'Details keeps only the code');
  // A message with no speaker, or with a value that is not the kernel's: as before, with no lead.
  for (const errorOrigin of [undefined, 'roster-read', 'terminal-probe', 'Kernel', true]) {
    ({ notice } = await stale({ error: 'cannot read it', ...(errorOrigin === undefined ? {} : { errorOrigin }) }));
    assert.equal(notice.title, 'cannot read it', String(errorOrigin)); assert.equal(notice.querySelector('.loading-notice-cause').textContent, 'cannot read it', String(errorOrigin));
  }
  // Another machine's panel carries no mark: its message reads as before.
  ({ notice } = await stale({ workspace: { id: 'A', name: 'A', remote: true }, error: 'Server is unreachable' }));
  assert.equal(notice.title, 'Server is unreachable');
  // The message is one display line: markup stays text, an unsafe one is withheld under no speaker's name, several lines are one.
  ({ notice } = await stale({ error: '<b>bold</b>', errorOrigin: 'kernel' }));
  assert.equal(notice.title, 'OATS says: <b>bold</b>'); assert.equal(notice.querySelector('b'), null);
  for (const errorOrigin of ['kernel', undefined]) {
    ({ notice } = await stale({ error: 'wipe \x1b[2J the screen', ...(errorOrigin ? { errorOrigin } : {}) }));
    assert.equal(notice.title, '[withheld]', String(errorOrigin)); assert.equal(notice.querySelector('.loading-notice-cause').textContent, '[withheld]');
  }
  ({ notice } = await stale({ error: 'first\nsecond', errorOrigin: 'kernel' }));
  assert.equal(notice.title, 'OATS says: first second');
  // With nothing observed before: the failed block and the spoken status.
  const failed = async (extra) => { const f = shell(t); await f.reply(0, panelOf('A', [], extra)); return f; };
  let f = await failed({ error: 'cannot read it', errorOrigin: 'kernel' });
  assert.equal(f.context.rosterState.state, 'failed');
  assert.equal(f.list().querySelector('.loading-failed-message').textContent, 'OATS says: cannot read it'); assert.equal(f.live().textContent, "Couldn't refresh instances. OATS says: cannot read it");
  f = await failed({ error: 'cannot read it' });
  assert.equal(f.list().querySelector('.loading-failed-message').textContent, 'cannot read it'); assert.equal(f.live().textContent, "Couldn't refresh instances. cannot read it");
});

test('a kept failure with no words is still a failure: the rows go stale and their actions are disabled; with nothing observed it is a failed read, never "No instances."', async t => {
  for (const extra of [{ error: '' }, { error: '', errorOrigin: 'kernel' }, { error: ' \n ', errorOrigin: 'kernel' }]) {
    const s = shell(t);
    await s.reply(0, panelOf('A', roster));
    assert.equal(s.context.rosterState.state, 'ready'); assert.equal(s.list().querySelector('.ctx-start').getAttribute('aria-disabled'), null);
    s.refreshContextRoster(); await s.reply(1, panelOf('A', roster, extra));
    assert.equal(s.context.rosterState.state, 'stale', JSON.stringify(extra)); assert.equal(s.rows().length, 3, 'the last observation stays');
    const notice = s.status().querySelector('.loading-notice[data-kind="stale"]');
    assert.match(notice.querySelector('.loading-notice-text').textContent, /^Couldn't refresh instances/); assert.equal(notice.hasAttribute('title') && notice.title !== '', false, 'no words, no title');
    assert.equal(notice.querySelector('.loading-notice-details, details').hidden, true, 'and no Details');
    assert.equal(s.list().querySelector('.ctx-start').getAttribute('aria-disabled'), 'true'); assert.equal(s.live().textContent, "Couldn't refresh instances.");
    // The same failure with no rows over rows already shown keeps them, stale; a good read clears it.
    s.refreshContextRoster(); await s.reply(2, panelOf('A', [], extra));
    assert.equal(s.context.rosterState.state, 'stale'); assert.equal(s.rows().length, 3); assert.doesNotMatch(s.text(), /No instances/);
    s.refreshContextRoster(); await s.reply(3, panelOf('A', roster));
    assert.equal(s.context.rosterState.state, 'ready'); assert.equal(s.status().children.length, 0);
    // With nothing observed: the failed block, with the roster's own words.
    const f = shell(t);
    await f.reply(0, panelOf('A', [], extra));
    assert.equal(f.context.rosterState.state, 'failed', JSON.stringify(extra));
    assert.equal(f.list().querySelector('.loading-failed-message').textContent, "Couldn't refresh instances."); assert.doesNotMatch(f.text(), /No instances/);
    assert.equal(f.live().textContent, "Couldn't refresh instances.");
  }
});

test("a cache problem with nothing observed says who made its message, from the reason's own mark on this computer's deployment", async t => {
  const failed = async (reason, extra = {}) => { const s = shell(t); await s.reply(0, panelOf('A', [], { deployment: { status: 'unavailable', reason: { code: 'E_REMOTE_UNREADABLE', cause: { reason: 'cache' }, ...reason } }, ...extra })); return s; };
  let s = await failed({ message: CACHE_MESSAGE, origin: 'kernel' });
  assert.equal(s.context.rosterState.state, 'failed');
  assert.equal(s.list().querySelector('.loading-failed-message').textContent, `OATS says: ${CACHE_MESSAGE}`);
  assert.equal(s.list().querySelector('.loading-failed-code').textContent, 'E_REMOTE_UNREADABLE'); assert.equal(s.live().textContent, `Couldn't refresh instances. OATS says: ${CACHE_MESSAGE}`);
  // A reason with no mark, or with a value that is not the kernel's: the message as before.
  for (const origin of [undefined, 'roster-read', 'terminal-probe', 'Kernel', true]) {
    s = await failed({ message: CACHE_MESSAGE, ...(origin === undefined ? {} : { origin }) });
    assert.equal(s.list().querySelector('.loading-failed-message').textContent, CACHE_MESSAGE, String(origin));
  }
  s = await failed({ message: 'wipe \x1b[2J the screen', origin: 'kernel' });
  assert.equal(s.list().querySelector('.loading-failed-message').textContent, '[withheld]');
  s = await failed({ message: '<b>bold</b>', origin: 'kernel' });
  assert.equal(s.list().querySelector('.loading-failed-message').textContent, 'OATS says: <b>bold</b>'); assert.equal(s.list().querySelector('.loading-failed b'), null);
  // Another machine's panel is never read for this reason: its deployment, whatever it carried, is not this computer's.
  s = await failed({ message: CACHE_MESSAGE, origin: 'kernel' }, { workspace: { id: 'A', name: 'A', remote: true } });
  assert.equal(s.list().querySelector('.loading-failed'), null, 'no failed read is made from a remote panel\'s deployment');
  assert.doesNotMatch(s.rosterEl.textContent, /OATS says/);
});

/* ── #461: a deployment the server does not serve, or does not answer for ── */
const notServedError = () => { const e = new Error("This Desktop's server isn't serving this deployment."); e.code = NOT_SERVED_CODE; e.status = 404; return e; };
// A local deployment is selected by its path; only a path can be re-added.
const P = '/d/A', pathPanel = (instances, extra = {}) => ({ ...panelOf(P, instances, extra), workspaces: [{ id: P, name: 'A' }, { id: 'B', name: 'B' }] });
const pendingPanel = (ws = 'A') => (ws === P ? pathPanel : panelOf.bind(null, 'A'))([], { deployment: { status: 'pending' } });
/** Every text the polite live region took, in order (jsdom's MutationObserver). */
function liveHistory(s) {
  const seen = []; const record = () => { const text = s.live().textContent; if (seen.at(-1) !== text) seen.push(text); };
  new s.dom.window.MutationObserver(record).observe(s.live(), { childList: true, characterData: true, subtree: true });
  return { seen, flush: async () => { await tick(); record(); } };
}

test('a deployment the server does not serve reaches the failed state by name, with Retry and Re-add, announced once', async t => {
  const s = shell(t, { workspace: P });
  await s.fail(0, notServedError());
  const failed = s.list().querySelector('.loading-failed');
  assert.match(failed.querySelector('.loading-failed-message').textContent, /^This Desktop's server isn't serving this deployment: \/d\/A\./);
  assert.equal(failed.querySelector('.loading-failed-code').textContent, NOT_SERVED_CODE);
  assert.deepEqual([...failed.querySelectorAll('button')].map(b => b.textContent), ['Retry', 'Re-add workspace']);
  assert.match(s.live().textContent, /^Couldn't refresh instances\. This Desktop's server isn't serving this deployment: \/d\/A\./);
  assert.doesNotMatch(s.text(), /Reading the deployment|No instances/);
  // The switcher still gets the served choices: one plain read without ?ws=.
  assert.equal(s.requests[1].path, '/api/panel'); await s.reply(1, panelOf('B', []));
  // Background polls say the same thing: the polite region is not cycled through "Loading…" again.
  const said = s.live().textContent, live = liveHistory(s);
  for (const n of [2, 4]) { s.refreshContextRoster(); await s.fail(n, notServedError()); await s.reply(n + 1, panelOf('B', [])); }
  await live.flush();
  assert.deepEqual(live.seen.filter(text => text !== said), [], `no re-announcement between background failures: ${JSON.stringify(live.seen)}`);
  assert.equal(s.list().querySelectorAll('.loading-failed').length, 1, 'updated in place');
  // Retry re-reads as a user read.
  failed.querySelector('.loading-retry').click(); assert.equal(s.requests.length, 7); assert.equal(s.requests[6].path, `/api/panel?ws=${encodeURIComponent(P)}`);
});

test('a non-path workspace the server does not serve is named, with Retry and no Re-add (only a local deployment can be re-added)', async t => {
  const s = shell(t, { workspace: 'remote:gone' });
  await s.fail(0, notServedError());
  const failed = s.list().querySelector('.loading-failed');
  assert.match(failed.querySelector('.loading-failed-message').textContent, /: remote:gone\./);
  assert.deepEqual([...failed.querySelectorAll('button')].map(b => b.textContent), ['Retry']);
});

test('Re-add goes through the normal add for that exact path, then reads the roster again', async t => {
  const s = shell(t, { workspace: P });
  await s.fail(0, notServedError()); await s.reply(1, panelOf('B', []));
  s.list().querySelector('.loading-action').click(); await tick();
  assert.deepEqual(s.adds, [P], 'the workspace path, through workspace:add');
  assert.equal(s.requests.at(-1).path, `/api/panel?ws=${encodeURIComponent(P)}`, 'served now: read again');
  await s.reply(s.requests.length - 1, pathPanel(roster));
  assert.equal(s.list().querySelector('.loading-failed'), null); assert.deepEqual(s.names(), ['alpha', 'gamma', 'beta']);
});

test('a refused Re-add keeps the failed state with its reason and Re-add', async t => {
  const s = shell(t, { workspace: P, addResult: { ok: false, code: 'not-a-workspace', reason: 'no oats-local.yaml' } });
  await s.fail(0, notServedError()); await s.reply(1, panelOf('B', []));
  s.list().querySelector('.loading-action').click(); await tick();
  const failed = s.list().querySelector('.loading-failed');
  assert.equal(failed.querySelector('.loading-failed-message').textContent, `Couldn't re-add ${P}: no oats-local.yaml`);
  assert.ok(failed.querySelector('.loading-action'), 'Re-add stays offered');
});

test('a Re-add outcome belongs to its own selection: after A→B→A it does nothing, and a refusal never replaces a newer observation', async t => {
  let settle; const s = shell(t, { workspace: P, addResult: () => new Promise(resolve => { settle = resolve; }) });
  await s.fail(0, notServedError()); await s.reply(1, panelOf('B', []));
  // Away and back while the add is in flight: a new selection of the same path.
  s.list().querySelector('.loading-action').click(); await tick();
  s.switchTo('B'); s.switchTo(P);
  const before = s.requests.length; settle({ ok: true, workspace: { id: P } }); await tick();
  assert.equal(s.requests.length, before, 'the superseded Re-add reads nothing');
  await s.fail(s.requests.length - 1, notServedError()); await s.reply(s.requests.length - 1, panelOf('B', []));
  // A Re-add refused after a poll observed the deployment: the observation stands.
  s.list().querySelector('.loading-action').click(); await tick();
  s.refreshContextRoster(); await s.reply(s.requests.length - 1, pathPanel(roster));
  assert.deepEqual(s.names(), ['alpha', 'gamma', 'beta']);
  settle({ ok: false, reason: 'the add failed' }); await tick();
  assert.deepEqual(s.names(), ['alpha', 'gamma', 'beta'], 'rows kept'); assert.equal(s.list().querySelector('.loading-failed'), null);
  assert.equal(s.context.rosterState.state, 'ready'); assert.equal(s.context.rosterStale, false);
});

test('rows of an earlier read do not stay under a not-served answer', async t => {
  const s = shell(t, { workspace: P });
  await s.reply(0, pathPanel(roster)); assert.equal(s.rows().length, 3);
  s.refreshContextRoster(); await s.fail(1, notServedError());
  assert.equal(s.rows().length, 0); assert.ok(s.list().querySelector('.loading-failed .loading-action'));
});

test('pending past the bound is "No answer" with Retry (no Re-add); Retry restarts the wait; an observation still lands', async t => {
  const s = shell(t);
  await s.reply(0, pendingPanel());
  assert.match(s.text(), /Reading the deployment/); assert.equal(s.list().querySelector('.loading-failed'), null);
  s.c.advance(PENDING_LIMIT_MS - 1); s.refreshContextRoster(); await s.reply(1, pendingPanel());
  assert.equal(s.list().querySelector('.loading-failed'), null, 'still inside the bound');
  s.c.advance(1); s.refreshContextRoster(); await s.reply(2, pendingPanel());
  const failed = s.list().querySelector('.loading-failed');
  assert.match(failed.querySelector('.loading-failed-message').textContent, /^No answer from the Desktop's server for this deployment: A\./);
  assert.equal(failed.querySelector('.loading-failed-code').textContent, NO_ANSWER_CODE);
  assert.equal(failed.querySelector('.loading-action'), null, 'served, only slow: no Re-add');
  assert.doesNotMatch(s.text(), /Reading the deployment/);
  failed.querySelector('.loading-retry').click(); await s.reply(3, pendingPanel());
  assert.equal(s.list().querySelector('.loading-failed'), null, 'Retry restarts the bounded wait');
  s.c.advance(PENDING_LIMIT_MS); s.refreshContextRoster(); await s.reply(4, pendingPanel());
  assert.ok(s.list().querySelector('.loading-failed'));
  s.refreshContextRoster(); await s.reply(5, panelOf('A', roster));
  assert.equal(s.list().querySelector('.loading-failed'), null); assert.equal(s.rows().length, 3);
});

test('a read that never answers reaches "No answer" at the bound, on the next dispatch, without any reply', async t => {
  const s = shell(t);
  s.c.advance(PENDING_LIMIT_MS - 1); s.refreshContextRoster();
  assert.equal(s.list().querySelector('.loading-failed'), null, 'inside the bound: still loading');
  s.c.advance(1); s.refreshContextRoster();
  assert.equal(s.requests.length, 3, 'the read is still tried');
  const failed = s.list().querySelector('.loading-failed');
  assert.ok(failed, 'no reply came, the state is said anyway');
  assert.equal(failed.querySelector('.loading-failed-code').textContent, NO_ANSWER_CODE);
  assert.match(failed.querySelector('.loading-failed-message').textContent, /: A\./);
  // An answer still lands.
  await s.reply(2, panelOf('A', roster)); assert.equal(s.list().querySelector('.loading-failed'), null); assert.equal(s.rows().length, 3);
});

test('a transport failure past the bound is "No answer" by name; inside it, the generic failure', async t => {
  const s = shell(t);
  await s.fail(0, new Error('timed out'));
  assert.equal(s.list().querySelector('.loading-failed-message').textContent, 'timed out', 'inside the bound');
  s.c.advance(PENDING_LIMIT_MS); const pending = s.requests.length; s.refreshContextRoster();
  await s.fail(pending, new Error('timed out'));
  assert.equal(s.list().querySelector('.loading-failed-code').textContent, NO_ANSWER_CODE);
});

test('pending after an observation keeps the rows, never "empty"; past the bound they go stale with "No answer"', async t => {
  const s = shell(t);
  await s.reply(0, panelOf('A', roster)); assert.equal(s.context.rosterState.state, 'ready');
  s.context.connectionGeneration = 1; // a new server: its first answers are "pending"
  s.refreshContextRoster(); await s.reply(1, pendingPanel());
  assert.deepEqual(s.names(), ['alpha', 'gamma', 'beta'], 'the rows stay'); assert.equal(s.context.rosterState.state, 'ready');
  assert.doesNotMatch(s.text(), /No instances|Reading the deployment/);
  s.c.advance(PENDING_LIMIT_MS); s.refreshContextRoster(); await s.reply(2, pendingPanel());
  assert.deepEqual(s.names(), ['alpha', 'gamma', 'beta'], 'still the last observation'); assert.equal(s.context.rosterState.state, 'stale');
  assert.equal(s.context.rosterStale, true);
  assert.match(s.status().querySelector('.loading-notice').title, /^No answer from the Desktop's server for this deployment: A\./);
  s.refreshContextRoster(); await s.reply(3, panelOf('A', roster));
  assert.equal(s.context.rosterState.state, 'ready');
});

test('the 4 s roster poll is single-flight: an unanswered read is never superseded by the next poll', () => {
  assert.match(source, /const poll = rosterPoll = refreshContextRoster\(\)\.finally\(\(\) => \{ if \(rosterPoll === poll\) rosterPoll = null; \}\);/);
  // Every 4 s tick (ROSTER_POLL_FOCUSED_MS), only with no read in flight; an unfocused window's ticks are spaced (#481).
  assert.match(source, /setInterval\(\(\) => \{\n  if \(!rosterPoll && rosterPollDue\([^\n]*\)\) pollContextRoster\(\);\n\}, ROSTER_POLL_FOCUSED_MS\);/);
  assert.doesNotMatch(source, /setInterval\(\(\) => refreshContextRoster\(\), 4000\)/);
});

/** The shipped 4 s poll, run on the test's clock: no refresh is called by hand. Time moves a second at a
 * time and settles promises in between, as a real event loop would. */
function shippedPoll(s) {
  const last = 'subscribeConnections(() => { if (contextRosterEl) pollContextRoster(); });';
  const start = source.indexOf('let rosterPoll = null'), end = source.indexOf(last, start) + last.length;
  assert.ok(start > 0 && end > start, 'the shipped poll and its connection subscription');
  s.context.setInterval = (fn, ms) => { const run = () => { s.c.setTimeout(run, ms); fn(); }; s.c.setTimeout(run, ms); };
  // A focused window (#481): its poll runs every 4 s; the blurred cadence is roster-cadence.mjs's own test.
  Object.assign(s.context, { rosterPollDue, ROSTER_POLL_FOCUSED_MS, Date: { now: () => 0 }, window: { addEventListener() {} } });
  s.context.document.hasFocus = () => true;
  const listeners = new Set(); s.context.subscribeConnections = fn => { listeners.add(fn); return () => listeners.delete(fn); };
  // A backend replacement or forge change, as shell.mjs's onForgeChanged does it.
  s.changeConnection = () => { s.context.connectionGeneration++; for (const fn of [...listeners]) fn(); };
  runInContext(source.slice(start, end), s.context);
  return async seconds => { for (let n = 0; n < seconds; n++) { s.c.advance(1000); await tick(); await tick(); } };
}

test('the shipped poll with a read that never answers: "No answer" at exactly the bound, no extra read, and the late answer still lands', async t => {
  const s = shell(t), run = shippedPoll(s);
  await run(44);
  assert.equal(s.requests.length, 2, 'the first read and one poll; the stuck poll holds every later tick');
  assert.equal(s.list().querySelector('.loading-failed'), null, 'still inside the bound');
  await run(1);
  const failed = s.list().querySelector('.loading-failed');
  assert.ok(failed, 'said at 45 s, without a reply and without another read'); assert.equal(s.requests.length, 2);
  assert.equal(failed.querySelector('.loading-failed-code').textContent, NO_ANSWER_CODE);
  assert.match(s.live().textContent, /No answer from the Desktop's server for this deployment: A\./);
  await run(15); assert.equal(s.requests.length, 2, 'still one read in flight');
  await s.reply(1, panelOf('A', roster));
  assert.equal(s.list().querySelector('.loading-failed'), null); assert.equal(s.rows().length, 3);
});

test('the shipped poll with the proxy\'s 20 s timeouts: the generic failure inside the bound, "No answer" at 45 s', async t => {
  const s = shell(t);
  s.context.api = path => new Promise((_, reject) => { s.requests.push({ path }); s.c.setTimeout(() => reject(new Error('timed out')), 20_000); });
  s.requests.length = 0; s.context.rosterState.reset(); s.refreshContextRoster(); // the first read, now timing out
  const run = shippedPoll(s);
  await run(44);
  assert.equal(s.list().querySelector('.loading-failed-message').textContent, 'timed out', 'inside the bound: the read\'s own failure');
  await run(1);
  assert.equal(s.list().querySelector('.loading-failed-code').textContent, NO_ANSWER_CODE, 'at the bound, by name');
  assert.ok(s.requests.length <= 3, `no extra full read cycle was needed: ${s.requests.length}`);
});

test('the deadline belongs to its subject: an answer, a switch or a Retry cancels it', async t => {
  const s = shell(t);
  await s.reply(0, panelOf('A', [], { deployment: { status: 'pending' } }));
  s.c.advance(30_000); // A has 15 s left
  s.switchTo('B'); // a new subject; its own read is in flight
  s.c.advance(PENDING_LIMIT_MS - 1); await tick();
  assert.equal(s.list().querySelector('.loading-failed'), null, 'A\'s deadline does not fire for B');
  await s.reply(s.requests.length - 1, panelOf('B', [row('b-one')], { workspaces: [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }] }));
  s.c.advance(PENDING_LIMIT_MS * 2); await tick();
  assert.equal(s.list().querySelector('.loading-failed'), null, 'an observation cancels it'); assert.deepEqual(s.names(), ['b-one']);
});

test('the shipped poll across a connection change with a read unresolved: the new connection reads at once and gets its own 45 s; the old read can neither paint nor cancel it', async t => {
  const s = shell(t), run = shippedPoll(s);
  await run(10);
  assert.equal(s.requests.length, 2, 'the first read and the 4 s poll, both unanswered');
  s.changeConnection();
  assert.equal(s.requests.length, 3, 'the new connection reads at once, not held by the old read');
  await run(10);
  await s.reply(1, panelOf('A', roster)); // the old connection's read settles late
  assert.equal(s.rows().length, 0, 'revoked: it paints nothing');
  await run(24); // t = 44 s: past the old connection's deadline, inside the new one's
  assert.equal(s.list().querySelector('.loading-failed'), null, 'the old deadline was cancelled with its subject');
  assert.equal(s.requests.length, 3, 'the new read holds the poll');
  await run(11); // t = 55 s: 45 s after the change
  const failed = s.list().querySelector('.loading-failed');
  assert.ok(failed, 'no answer on the new connection, without any reply'); assert.equal(failed.querySelector('.loading-failed-code').textContent, NO_ANSWER_CODE);
  await s.reply(2, panelOf('A', roster));
  assert.equal(s.list().querySelector('.loading-failed'), null, 'its late answer still lands'); assert.equal(s.rows().length, 3);
  await run(4); assert.equal(s.requests.length, 4, 'and the poll runs again');
});

test('an empty deployment\'s observed answer, as the server sends it, settles to the empty roster (never "Reading the deployment…")', async t => {
  const s = shell(t);
  // /api/panel for an observed deployment with no souls and no instances (unserved-deployment-server.test.mjs).
  await s.reply(0, panelOf('A', [], { deployment: { status: 'observed', root: '/d/A/agents', workspace: { name: 'web', key: 'k' }, reachable: { reachable: true }, withheld: [],
    catalog: { souls: [], ambiguous: [], reason: null, observedAt: null, refreshing: false }, catalogKey: undefined }, observedAt: '2026-10-02T00:00:00.000Z', refreshing: false, running: 0 }));
  assert.equal(s.text(), 'No instances.'); assert.equal(s.context.rosterState.state, 'empty');
  assert.equal(s.list().getAttribute('aria-busy'), null); assert.doesNotMatch(s.text(), /Reading the deployment/);
  s.refreshContextRoster(); await s.reply(1, panelOf('A', roster));
  assert.equal(s.rows().length, 3, 'refresh still works');
});

/* ── #1247: this window's own retire reads Retiring… until the roster was read after its answer ── */
test('this window\'s retire reads Retiring… from its send, before any read; a refusal lets it go at once; only an observed read begun after the answer releases it', async t => {
  const s = shell(t, { inFlight: true }), c = s.context;
  await s.reply(0, panelOf('A', roster));
  const button = name => [...s.list().querySelectorAll('.ctx-inst')].find(b => b.querySelector('.ctx-name')?.dataset.name === name);
  const reads = name => button(name).querySelector('.ctx-meta').textContent;
  const menu = name => [...button(name).closest('.ctx-tree-row').querySelectorAll('[role=menuitem]')].map(item => item.dataset.action);
  const target = { workspace: 'A', instance: 'alpha', agent: 'dev', agentsRoot: '/synthetic/agents', home: '/synthetic/alpha', server: null };
  const ordinary = reads('alpha');
  assert.notEqual(ordinary, 'Retiring…');
  // The apply starts: Retiring… at once, with no read; Retire stays the menu's only act, secondary.
  let own = c.retires.begin(target);
  assert.equal(reads('alpha'), 'Retiring…'); assert.equal(s.requests.length, 1, 'no read was needed');
  assert.equal(button('alpha').getAttribute('aria-disabled'), 'true'); assert.deepEqual(menu('alpha'), ['retire']);
  for (const other of ['beta', 'gamma']) assert.notEqual(reads(other), 'Retiring…', `${other}: as the roster says`);
  // Refused (or stale): it ran nothing, so the row reads again as the roster says, at once.
  own.settle('refused');
  assert.equal(reads('alpha'), ordinary); assert.equal(s.requests.length, 1);
  // Again; a poll begins before the answer and lands after it: it cannot say what the retire left.
  own = c.retires.begin(target);
  s.refreshContextRoster();
  own.settle('complete');
  assert.equal(reads('alpha'), 'Retiring…', 'answered, not yet read after');
  await s.reply(1, panelOf('A', roster));
  assert.equal(reads('alpha'), 'Retiring…', 'a read begun before the answer releases nothing');
  // Begun after the answer: a failed read, and one served while a newer observation runs, release nothing either.
  s.refreshContextRoster(); await s.fail(2, Object.assign(new Error('bridge down'), { code: 'E_BRIDGE' }));
  assert.equal(reads('alpha'), 'Retiring…', 'a failed read releases nothing');
  s.refreshContextRoster(); await s.reply(3, panelOf('A', roster, { refreshing: true }));
  assert.equal(reads('alpha'), 'Retiring…', 'nor one whose rows may predate the answer');
  assert.equal(c.retires.ids().size, 1);
  // An observed read begun after the answer: the roster says what the retire left (here: the home is gone).
  s.refreshContextRoster(); await s.reply(4, panelOf('A', roster.filter(r => r.instance !== 'alpha')));
  assert.equal(c.retires.ids().size, 0); assert.equal(button('alpha'), undefined);
  // Once let go, a row the roster still reports reads as it says.
  s.refreshContextRoster(); await s.reply(5, panelOf('A', roster));
  assert.equal(reads('alpha'), ordinary);
});

test('a read releases this window\'s retire only when it observed the row\'s deployment live: never another workspace\'s, nor a stale or unreached deployment\'s', async t => {
  const s = shell(t, { inFlight: true }), c = s.context;
  const target = (name, workspace = 'A') => ({ workspace, instance: name, agent: 'dev', agentsRoot: '/synthetic/agents', home: `/synthetic/${name}`, server: null });
  await s.reply(0, panelOf('A', roster));
  c.retires.begin(target('alpha')).settle('complete');
  // To B: B's observed read (its rows hold no alpha) says nothing of A's row.
  c.workspace = 'B'; s.refreshContextRoster(); await s.reply(1, panelOf('B', [row('delta')]));
  assert.equal(c.retires.ids().size, 1, 'another workspace\'s read releases nothing');
  // Back to A: its observed read, begun after the answer, says what the retire left.
  c.workspace = 'A'; s.refreshContextRoster(); await s.reply(2, panelOf('A', roster));
  assert.equal(c.retires.ids().size, 0);
  // A view of two deployments: each row's retire waits for a read that observed its own deployment live.
  const dep = (id, extra = {}) => ({ id, machine: id, path: `/d/${id}`, label: id, local: id === 'dA', reachable: true, identityFrom: null, primary: id === 'dA', ...extra });
  const tagged = [row('alpha', { deployment: { id: 'dA' } }), row('beta', { running: false, deployment: { id: 'dB' } })];
  const view = (dB, instances = tagged) => panelOf('A', instances, { deployments: [dep('dA'), dB] });
  s.refreshContextRoster(); await s.reply(3, view(dep('dB')));
  c.retires.begin(target('alpha', 'dA')).settle('complete'); c.retires.begin(target('beta', 'dB')).settle('complete');
  s.refreshContextRoster(); await s.reply(4, view(dep('dB', { stale: true, reason: 'The re-read failed.' })));
  assert.deepEqual([...c.retires.ids()].map(id => id.split('/').at(-1)), ['beta'], 'the live deployment\'s row is let go; the stale one\'s waits');
  s.refreshContextRoster(); await s.reply(5, view(dep('dB', { local: false, reachable: false, reason: 'Not reached.' }), [tagged[0]]));
  assert.equal(c.retires.ids().size, 1, 'an unreached deployment, its row absent, says nothing of it');
  s.refreshContextRoster(); await s.reply(6, view(dep('dB'), [tagged[0]]));
  assert.equal(c.retires.ids().size, 0, 'observed live: its row gone, the retire is let go');
  // A read that lists no deployments and did not observe the one it answered for releases nothing.
  c.retires.begin(target('alpha')).settle('complete');
  s.refreshContextRoster(); await s.reply(7, panelOf('A', roster, { deployment: { status: 'unavailable', reason: { code: 'E_X', message: 'no' } } }));
  assert.equal(c.retires.ids().size, 1);
});

// The stale line's Retry hands focus to the last answer's row (focusFallback) as it goes, before this answer is
// painted; that row may not survive the paint. Focus then goes to rosterEntry(): this answer's row, else, the
// roster now empty, its one action, the foot's Spawn instance; never <body>.
for (const [rows, expected] of [[[row('new-row')], 'the new row'], [[], "the foot's Spawn instance"]]) test(`a stale Retry whose row the answer removes lands on ${expected}`, async t => {
  const s = shell(t);
  await s.reply(0, panelOf('A', [row('old-row')]));
  s.refreshContextRoster(); await s.fail(1, new Error('bridge down'));
  const retry = s.status().querySelector('.loading-notice .loading-retry');
  retry.focus(); retry.click(); assert.equal(s.doc.activeElement, retry);
  await s.reply(2, panelOf('A', rows));
  assert.equal(s.status().querySelector('.loading-notice'), null, 'the stale line went');
  const want = rows.length ? s.list().querySelector('.ctx-inst') : s.doc.getElementById('sidebar-spawn');
  assert.ok(want, expected);
  assert.equal(s.doc.activeElement, want);
  if (rows.length) assert.equal(s.list().querySelectorAll('.ctx-inst[tabindex="0"]').length, 1, 'one roving stop');
});
