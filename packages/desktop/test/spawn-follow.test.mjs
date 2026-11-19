// Spec E, item 5 (and its addenda, and the return on it): after a press the operator is taken to the new
// instance, unless they ACTED since the press (input, a focus move, a navigation) or an overlay is open — at
// arrival and all through the asynchronous open. Focus merely resting where the dialog returned it (often a
// terminal) is not acting. No toast for a success: arriving is the confirmation, otherwise the row says New;
// one polite announcement either way.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { createSpawnFollow, watchOperator, operatorInput } from '../renderer/spawn-follow.mjs';
import { createSelectionOwnership } from '../renderer/selection-ownership.mjs';
import { instanceActionTarget, sameInstanceActionTarget } from '../renderer/instance-action-target.mjs';
import { instanceId } from '../../client/instance-tree.mjs';
import { terminalKey } from '../renderer/instance-tree-view.mjs';
import { otherIncarnation, terminalOrigin } from '../renderer/retired-tabs.mjs';

const row = { instance: 'dev-x', home: '/d/agents/dev/instances/dev-x', agentsRoot: '/d/agents', agent: 'dev', running: true };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

// What the operator does, as the browser delivers it (jsdom's events are untrusted: the fixtures count them).
const key = (el, k) => el.dispatchEvent(new el.ownerDocument.defaultView.KeyboardEvent('keydown', { key: k, bubbles: true }));
const fire = (el, type) => el.dispatchEvent(new el.ownerDocument.defaultView.Event(type, { bubbles: true }));
const click = el => { fire(el, 'pointerdown'); fire(el, 'mousedown'); el.focus(); };

function fixture(t, overrides = {}) {
  const dom = new JSDOM(`<body><button id="card">card</button><button id="other">other</button><input id="search" type="search">
    <div class="term-wrap" id="term"><div class="xterm"><textarea class="xterm-helper-textarea" id="term-input"></textarea></div></div>
    <div class="term-wrap" id="own"><div class="xterm"><textarea class="xterm-helper-textarea" id="own-input"></textarea></div></div></body>`);
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const state = { workspace: 'A', generation: 0, connection: 0, overlay: false };
  const ownership = createSelectionOwnership({ currentWorkspace: () => state.workspace, workspaceGeneration: () => state.generation });
  const operator = watchOperator(doc, { trusted: () => true });
  t.after(() => operator.dispose());
  const opened = [], marked = [], said = [];
  const follow = createSpawnFollow({
    watch: () => ownership.watch(), operator, overlayOpen: () => state.overlay, activeElement: () => doc.activeElement,
    currentWorkspace: () => state.workspace, connection: () => state.connection,
    open: async (r, ws, valid) => { opened.push({ r, ws, valid }); return valid(); }, markNew: (r, ws) => marked.push({ r, ws }), announce: text => said.push(text),
    ...overrides,
  });
  const el = id => doc.getElementById(id);
  return { doc, el, state, ownership, operator, follow, opened, marked, said };
}

test('operator input: a keydown other than a lone modifier, input, paste, compositionstart', () => {
  for (const k of ['a', 'Enter', 'Tab', 'Escape', 'ArrowUp', ' ', 'F5']) assert.equal(operatorInput({ type: 'keydown', key: k }), true, k);
  for (const k of ['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock', 'Fn']) assert.equal(operatorInput({ type: 'keydown', key: k }), false, k);
  for (const type of ['input', 'paste', 'compositionstart']) assert.equal(operatorInput({ type }), true, type);
  for (const type of ['keyup', 'wheel', 'focus', 'compositionend', 'scroll']) assert.equal(operatorInput({ type, key: 'a' }), false, type);
  assert.equal(operatorInput(null), false);
});

test('watchOperator: captured at the document before the page sees it; operator-generated only; disposable', t => {
  const u = fixture(t);
  u.el('term-input').addEventListener('keydown', e => e.stopPropagation()); // xterm consumes its keys
  key(u.el('term-input'), 'a');
  assert.equal(u.operator.input(), 1, 'a consumed key still counts');
  fire(u.el('card'), 'pointerdown');
  assert.equal(u.operator.pointer(), 1);
  const real = watchOperator(u.doc); // the shipped default: trusted events only
  key(u.el('term-input'), 'b'); fire(u.el('card'), 'paste'); fire(u.el('card'), 'pointerdown');
  assert.equal(real.input(), 0, 'an event the page dispatched itself (untrusted) is not the operator'); assert.equal(real.pointer(), 0);
  assert.equal(u.operator.input(), 3, 'the counting fixture saw b and the paste'); assert.equal(u.operator.pointer(), 2);
  real.dispose(); u.operator.dispose();
  key(u.el('term-input'), 'c'); fire(u.el('card'), 'pointerdown');
  assert.equal(u.operator.input(), 3, 'no longer counting after dispose'); assert.equal(u.operator.pointer(), 2);
});

test('opened from a terminal, focus returned there, no input since the press: followed', async t => {
  const u = fixture(t);
  u.el('term-input').focus(); // the dialog's focus return: the terminal it was opened from
  u.follow.follow('spawn-1');
  assert.equal(await u.follow.arrived(row, 'A', 0, { id: 'spawn-1' }), 'opened');
  assert.equal(u.opened.length, 1); assert.equal(u.opened[0].ws, 'A'); assert.equal(u.marked.length, 0);
  assert.deepEqual(u.said, ['dev-x spawned']);
  assert.equal(u.follow.size(), 0, 'followed once');
});

for (const [why, before, after] of [
  ['focus resting in a text field', u => u.el('search').focus(), () => {}],
  ['a lone modifier pressed', () => {}, u => { for (const k of ['Shift', 'Meta', 'Control', 'Alt', 'CapsLock']) key(u.el('term-input'), k); }],
  ['a pointer press that leaves focus where it was (a click in that terminal)', () => {}, u => click(u.el('term-input'))],
  ['focus the app moved itself (the return landing on another stage), no pointer press', () => {}, u => u.el('other').focus()],
]) test(`still followed: ${why}`, async t => {
  const u = fixture(t);
  u.el('term-input').focus();
  before(u);
  u.follow.follow('spawn-1');
  after(u);
  assert.equal(await u.follow.arrived(row, 'A', 0, { id: 'spawn-1' }), 'opened');
  assert.equal(u.marked.length, 0);
});

test('the press ticket cancels nothing pending, and any explicit action after it ends the follow', async t => {
  const u = fixture(t);
  const pending = u.ownership.begin(); // an open in flight before the press (a Quick Open return, say)
  u.follow.follow('spawn-1');
  assert.equal(pending(), true, 'watch() never supersedes what is pending');
  u.ownership.begin(); // the operator opened or activated another tab or view
  assert.equal(u.follow.following('spawn-1'), false);
  assert.equal(await u.follow.arrived(row, 'A', 0, { id: 'spawn-1' }), 'marked');
  assert.equal(u.opened.length, 0); assert.deepEqual(u.marked, [{ r: row, ws: 'A' }]); assert.deepEqual(u.said, ['dev-x spawned']);
});

const acted = [
  ['one keystroke in that terminal', u => key(u.el('term-input'), 'a')],
  ['Enter in that terminal', u => key(u.el('term-input'), 'Enter')],
  ['a paste', u => fire(u.el('term-input'), 'paste')],
  ['an IME composition', u => fire(u.el('term-input'), 'compositionstart')],
  ['an input event', u => fire(u.el('search'), 'input')],
  ['a focus move by a click', u => click(u.el('other'))],
  ['a focus move by Tab', u => { key(u.el('term-input'), 'Tab'); u.el('other').focus(); }],
  ['a modal or overlay open', u => { u.state.overlay = true; }],
];
for (const [why, act] of [
  ...acted,
  ['an invalidating navigation (the sidebar, a stage)', u => u.ownership.invalidate()],
  ['a workspace switch', u => { u.state.generation++; }],
  ['another workspace on screen', u => { u.state.workspace = 'B'; }],
  ['a connection change since the press (delivered with the current epoch, as the store does)', u => { u.state.connection++; }],
]) test(`never a yank: ${why} after the press keeps the operator where they are and marks the row New`, async t => {
  const u = fixture(t);
  u.el('term-input').focus();
  u.follow.follow('spawn-1');
  act(u);
  assert.equal(await u.follow.arrived(row, 'A', u.state.connection, { id: 'spawn-1' }), 'marked');
  assert.equal(u.opened.length, 0, 'nothing opened');
  assert.equal(u.marked.length, 1); assert.deepEqual(u.said, ['dev-x spawned']);
});

// The open is asynchronous: the guards hold all through it, not only at arrival.
for (const [why, act] of [
  ...acted,
  ['the connection changes', u => { u.state.connection++; }],
  ['the workspace changes', u => { u.state.workspace = 'B'; }],
]) test(`never a yank, during the open: ${why} → the open is refused and the row says New`, async t => {
  const gate = deferred(), checks = [];
  const u = fixture(t, { open: async (r, ws, valid) => { checks.push(valid()); await gate.promise; checks.push(valid()); return valid(); } });
  u.el('term-input').focus();
  u.follow.follow('spawn-1');
  const arrival = u.follow.arrived(row, 'A', 0, { id: 'spawn-1' });
  await Promise.resolve();
  act(u); gate.resolve();
  assert.equal(await arrival, 'marked');
  assert.deepEqual(checks, [true, false], 'the open saw it at its next step');
  assert.equal(u.marked.length, 1); assert.deepEqual(u.said, ['dev-x spawned']);
});

test('during the open, the opening terminal taking focus as it becomes ready is not the operator acting', async t => {
  const gate = deferred();
  const u = fixture(t, { open: async (r, ws, valid) => { await gate.promise; u.el('own-input').focus(); return valid(); } });
  u.el('term-input').focus();
  u.follow.follow('spawn-1');
  const arrival = u.follow.arrived(row, 'A', 0, { id: 'spawn-1' });
  gate.resolve();
  assert.equal(await arrival, 'opened'); assert.equal(u.marked.length, 0);
});

test('an open that does not land (refused, superseded, failed) leaves the row New', async t => {
  for (const open of [async () => false, async () => { throw new Error('transport'); }, () => undefined]) {
    const u = fixture(t, { open });
    u.follow.follow('spawn-1');
    assert.equal(await u.follow.arrived(row, 'A', 0, { id: 'spawn-1' }), 'marked');
    assert.equal(u.marked.length, 1); assert.deepEqual(u.said, ['dev-x spawned']);
  }
});

test('a spawn not pressed in this window (recovered after a reload) is only marked', async t => {
  const u = fixture(t);
  assert.equal(await u.follow.arrived(row, 'A', 0, { id: 'spawn-9' }), 'marked');
  assert.equal(await u.follow.arrived(row, 'A', 0), 'marked');
  assert.equal(u.opened.length, 0);
});

test('a partial spawn is followed the same way, but says nothing here (its own notification already spoke)', async t => {
  const u = fixture(t);
  u.follow.follow('spawn-1');
  assert.equal(await u.follow.arrived(row, 'A', 0, { id: 'spawn-1', complete: false }), 'opened');
  assert.equal(u.said.length, 0);
  u.follow.follow('spawn-2'); key(u.el('term-input'), 'a');
  assert.equal(await u.follow.arrived(row, 'A', 0, { id: 'spawn-2', complete: false }), 'quiet');
  assert.equal(u.marked.length, 0); assert.equal(u.said.length, 0);
});

test('a guard that throws is a busy operator; prune drops follows of jobs the store no longer holds', async t => {
  const u = fixture(t, { overlayOpen: () => { throw new Error('boom'); } });
  u.follow.follow('spawn-1');
  assert.equal(await u.follow.arrived(row, 'A', 0, { id: 'spawn-1' }), 'marked');
  u.follow.follow('spawn-2'); u.follow.follow('spawn-3');
  u.follow.prune(id => id === 'spawn-3');
  assert.equal(u.follow.size(), 1); assert.equal(u.follow.following('spawn-3'), true);
});

// ── the shipped shell wiring: shell.mjs's spawnFollow composition over the real openTerminalTabFlow ──────────
// Only the roster read, the key wait and the terminal's mount are stubbed; the operator watch (on the
// document), the selection ownership, the instance-target checks and the open's own ownership are the shipped ones.
const shellSource = readFileSync(new URL('../renderer/shell.mjs', import.meta.url), 'utf8');
const composition = shellSource.slice(shellSource.indexOf('const spawnFollow = createSpawnFollow('), shellSource.indexOf('// A created instance is awaited'));
const flowSource = shellSource.match(/async function openTerminalTabFlow\(ref, notify, options = \{\}\) \{[\s\S]*?\n\}/)?.[0];

function shell(t) {
  assert.ok(composition.includes('createSpawnFollow') && composition.includes('watchOperator(document)') && flowSource, 'the shipped composition and open flow');
  const dom = new JSDOM(`<body><button id="card">card</button><input id="search" type="search"><div id="dialog" aria-modal="true"></div>
    <div class="term-wrap" id="origin"><textarea class="xterm-helper-textarea" id="origin-input"></textarea></div><div id="tabhost"></div>
    <button id="roster-row" class="ctx-inst">dev-x</button></body>`);
  t.after(() => dom.window.close());
  const document = dom.window.document;
  document.getElementById('dialog').hidden = true;
  const live = { ...row, createdAt: '2026-10-01T10:00:00.000Z', tmux: { session: 'dev-x' } };
  const panels = [], marked = [], said = [], watches = [], shownRows = [];
  const c = {
    createSpawnFollow, instanceActionTarget, sameInstanceActionTarget, instanceId, terminalKey, document,
    // jsdom's events are untrusted; the browser's are the operator's.
    watchOperator: target => { const w = watchOperator(target, { trusted: () => true }); watches.push(w); return w; },
    currentWorkspace: () => 'A', workspaceGeneration: () => 0, connectionGeneration: 0,
    modalOpen: () => [...document.querySelectorAll('[aria-modal="true"]')].some(d => !d.hidden),
    tabs: new Map(), activeTab: null, pendingTerms: new Set(), panelReads: 0, otherIncarnation, terminalOrigin,
    spawnJobs: { markNew: (ws, r) => marked.push(r.instance) }, contextRosterEl: {}, announceSpawn: text => said.push(text),
    // The open's own repaint starts a roster read, which bumps the roster generation, as shell.mjs's does.
    setSidebarMode() {}, setNavActive() {}, refreshContextRoster() { c.contextRosterGen++; }, contextRosterGen: 0, shownRoster: null,
    api: () => { const gate = deferred(); panels.push(gate); return gate.promise; },
    resolveTerminalOpen: (instances, ref, ws) => { const inst = instances.find(i => i.home === ref.home); return inst ? { inst, key: terminalKey(ws, inst) } : { error: 'unknown', name: ref.instance }; },
    whenKeyFree: async () => {},
    // The roster selects the new row and gives it the keyboard focus (shell.mjs showInRoster, read: false).
    showInRoster: async (r, options) => { shownRows.push([r.instance, options]); document.getElementById('roster-row').focus(); return true; },
    // The terminal's mount: addTab makes and selects its tab at once, only while the open still owns it; its
    // input takes focus when it is ready (`ready`), only if the open still owns it and it is still selected.
    ready: undefined, newInput: null,
    // Its input takes focus only when the open asks for it (`focusContent`, the shipped openTerminalTabInner's 8th).
    openTerminalTabInner: async (inst, ws, key, owns, _notify, _commit, _read, focusContent = true) => {
      if (!owns()) return;
      const paneEl = document.createElement('div'); const input = document.createElement('textarea'); input.className = 'xterm-helper-textarea';
      paneEl.append(input); document.getElementById('tabhost').append(paneEl); c.newInput = input;
      c.tabs.set(7, { kind: 'terminal', key, instanceRef: inst, paneEl }); c.activeTab = 7;
      await c.ready;
      if (focusContent && owns() && c.activeTab === 7) input.focus();
    },
  };
  t.after(() => watches.forEach(w => w.dispose()));
  c.tabOpenIntents = createSelectionOwnership(c);
  const flow = runInNewContext(`(${flowSource})`, c);
  c.openTerminalTab = (ref, options) => flow(ref, () => {}, options);
  const follow = runInNewContext(`${composition}\nspawnFollow`, c);
  const panel = () => ({ instances: [live] });
  const el = id => document.getElementById(id);
  // The press: the dialog was opened from a terminal and its close returned focus there.
  const press = () => { el('origin-input').focus(); follow.follow('spawn-1'); };
  return { document, el, c, follow, live, panels, marked, said, shownRows, panel, press, settle: () => new Promise(r => setImmediate(r)) };
}

async function arrive(u) {
  const arrival = u.follow.arrived(u.live, 'A', 0, { id: 'spawn-1' });
  await u.settle(); u.panels[0]?.resolve(u.panel());
  return arrival;
}

test('shell: opened from a terminal, focus returned there, no input since the press → its terminal opens and is selected, without input focus', async t => {
  const u = shell(t);
  u.press();
  assert.equal(await arrive(u), 'opened');
  assert.equal(u.c.activeTab, 7);
  // launch-instance-opens-view-without-input-focus: its row is selected and holds the keyboard; the terminal takes no keys.
  assert.equal(JSON.stringify(u.shownRows), JSON.stringify([['dev-x', { read: false }]]));
  assert.equal(u.document.activeElement, u.el('roster-row')); assert.notEqual(u.document.activeElement, u.c.newInput);
  assert.deepEqual(u.marked, []); assert.deepEqual(u.said, ['dev-x spawned']);
});

test('shell: a modifier-only keypress after the press is still followed', async t => {
  const u = shell(t);
  u.press();
  for (const k of ['Meta', 'Shift', 'Control', 'Alt']) key(u.el('origin-input'), k);
  assert.equal(await arrive(u), 'opened');
  assert.deepEqual(u.marked, []);
});

for (const [why, act] of [
  ['one keystroke in that terminal', u => key(u.el('origin-input'), 'l')],
  ['a paste', u => fire(u.el('origin-input'), 'paste')],
  ['an IME composition', u => fire(u.el('origin-input'), 'compositionstart')],
  ['a focus move (a click elsewhere)', u => click(u.el('card'))],
]) test(`shell: ${why} after the press → not followed, the row says New`, async t => {
  const u = shell(t);
  u.press();
  act(u);
  assert.equal(await arrive(u), 'marked');
  assert.equal(u.panels.length, 0, 'no open was even started'); assert.equal(u.c.activeTab, null);
  assert.deepEqual(u.marked, ['dev-x']); assert.deepEqual(u.said, ['dev-x spawned']);
});

for (const [why, act] of [
  ['typing in that terminal', u => key(u.el('origin-input'), 'l')],
  ['typing in the stage\'s search', u => { click(u.el('search')); key(u.el('search'), 'q'); }],
  ['a paste', u => fire(u.el('origin-input'), 'paste')],
  ['a dialog opening', u => { u.el('dialog').hidden = false; }],
  ['a navigation (another tab, view or the sidebar)', u => u.c.tabOpenIntents.begin()],
  ['a connection change', u => { u.c.connectionGeneration++; }],
]) test(`shell: ${why} during the open → it stops, no terminal is selected, the row says New`, async t => {
  const u = shell(t);
  u.press();
  const arrival = u.follow.arrived(u.live, 'A', 0, { id: 'spawn-1' });
  await u.settle();
  act(u);
  u.panels[0].resolve(u.panel());
  assert.equal(await arrival, 'marked');
  assert.equal(u.c.activeTab, null, 'no terminal selected'); assert.equal(u.c.newInput, null, 'no terminal made');
  assert.deepEqual(u.marked, ['dev-x']); assert.deepEqual(u.said, ['dev-x spawned']);
});

test('shell: a connection change between the press and the arrival (the store delivers the current epoch) is not followed', async t => {
  const u = shell(t);
  u.press();
  u.c.connectionGeneration++;
  assert.equal(await u.follow.arrived(u.live, 'A', u.c.connectionGeneration, { id: 'spawn-1' }), 'marked');
  assert.equal(u.panels.length, 0, 'no open was even started'); assert.deepEqual(u.marked, ['dev-x']);
});

test('shell: a terminal the operator was taken to and left while it attached is not New', async t => {
  const u = shell(t);
  const ready = deferred(); u.c.ready = ready.promise;
  u.press();
  const arrival = u.follow.arrived(u.live, 'A', 0, { id: 'spawn-1' });
  await u.settle(); u.panels[0].resolve(u.panel());
  await u.settle();
  assert.equal(u.c.activeTab, 7, 'its tab is made and selected before the terminal is ready');
  u.c.tabOpenIntents.begin(); u.c.tabs.set(8, { kind: 'view', key: 'view:x' }); u.c.activeTab = 8; // they moved on
  click(u.el('card'));
  ready.resolve();
  assert.equal(await arrival, 'opened');
  assert.deepEqual(u.marked, [], 'no New on a terminal already opened');
  assert.equal(u.c.activeTab, 8); assert.equal(u.document.activeElement, u.el('card'), 'readiness took no focus');
  assert.deepEqual(u.said, ['dev-x spawned']);
});

// #1246 D2: the post-spawn open resolves against the roster read that showed the row ready (shell.mjs `shownRoster`,
// set where that read hands its rows to the store) while no later read has started, in the same workspace.
test('shell: the post-spawn open uses the roster answer that showed the row ready, with no second /api/panel read', async t => {
  const u = shell(t);
  u.c.shownRoster = { gen: 0, ws: 'A', instances: [u.live] };
  u.press();
  assert.equal(await u.follow.arrived(u.live, 'A', 0, { id: 'spawn-1' }), 'opened');
  assert.equal(u.panels.length, 0, 'no /api/panel read');
  assert.equal(u.c.activeTab, 7); assert.equal(u.c.contextRosterGen, 1, 'the fire-and-forget repaint still runs');
});
for (const [why, shown] of [
  ['a later roster read has started since', u => ({ gen: u.c.contextRosterGen - 1, ws: 'A', instances: [u.live] })],
  ['it was another workspace\'s', u => ({ gen: u.c.contextRosterGen, ws: 'B', instances: [u.live] })],
  ['there is none', () => null],
]) test(`shell: the post-spawn open reads /api/panel as before when ${why}`, async t => {
  const u = shell(t);
  u.c.contextRosterGen = 3; u.c.shownRoster = shown(u);
  u.press();
  assert.equal(await arrive(u), 'opened');
  assert.equal(u.panels.length, 1);
});
test('shell: any other open reads /api/panel, even with the shown roster current', async t => {
  const u = shell(t);
  u.c.shownRoster = { gen: 0, ws: 'A', instances: [u.live] };
  const open = u.c.openTerminalTab(u.live, { quiet: true });
  await u.settle(); assert.equal(u.panels.length, 1, 'a roster row, the palette, Quick Open: read as today');
  u.panels[0].resolve(u.panel()); await open;
  assert.equal(u.c.activeTab, 7);
});

// #1246 D2: shell.mjs `followSpawns`, over a fake store and fake timers. A created spawn is read at once; while it is
// awaited, the 700 ms poll stays as the fallback; a read in flight is never doubled.
const followSource = shellSource.slice(shellSource.indexOf('// A created instance is awaited'), shellSource.indexOf('ctx.spawnJobs = spawnJobs;'));
function follower() {
  const jobs = new Map(), timers = [], reads = [];
  const c = {
    currentWorkspace: () => 'A',
    spawnJobs: { rows: ws => [...jobs.values()].filter(j => j.workspace === ws).map(j => ({ id: j.id })), get: id => jobs.get(id) ?? null },
    refreshContextRoster: () => { const gate = deferred(); reads.push(gate); return gate.promise; },
    setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.cleared = true; },
    Set, Promise,
  };
  assert.ok(followSource.includes('function followSpawns()'), 'the shipped follow');
  const followSpawns = runInNewContext(`${followSource}\nfollowSpawns`, c);
  const armed = () => timers.filter(x => !x.cleared && !x.fired);
  const fire = () => { const [timer] = armed(); timer.fired = true; timer.fn(); };
  return { jobs, timers, reads, followSpawns, armed, fire, settle: () => new Promise(r => setImmediate(r)) };
}

test('follow: a created spawn reads the roster at once, then every 700 ms while it is awaited', async () => {
  const f = follower();
  f.jobs.set('spawn-1', { id: 'spawn-1', workspace: 'A', state: 'spawning' });
  f.followSpawns();
  assert.equal(f.reads.length + f.timers.length, 0, 'nothing is awaited before the outcome');
  f.jobs.get('spawn-1').state = 'created';
  f.followSpawns();
  assert.equal(f.reads.length, 1, 'read at once, with no initial 700 ms wait');
  assert.equal(f.timers.length, 0);
  f.followSpawns(); assert.equal(f.reads.length, 1, 'a change meanwhile does not read twice');
  f.reads[0].resolve(); await f.settle();
  assert.deepEqual(f.armed().map(x => x.ms), [700], 'still awaited: the 700 ms poll is the fallback');
  f.fire(); assert.equal(f.reads.length, 2);
  f.jobs.get('spawn-1').state = 'done';
  f.reads[1].resolve(); await f.settle();
  assert.equal(f.armed().length, 0, 'no longer awaited: no more reads');
});

test('follow: a second spawn created while the poll waits is read at once too; a spawn of another workspace is not', async () => {
  const f = follower();
  f.jobs.set('spawn-1', { id: 'spawn-1', workspace: 'A', state: 'created' });
  f.followSpawns(); f.reads[0].resolve(); await f.settle();
  assert.equal(f.armed().length, 1);
  f.jobs.set('spawn-9', { id: 'spawn-9', workspace: 'B', state: 'created' });
  f.followSpawns(); assert.equal(f.reads.length, 1, 'another workspace\'s spawn changes nothing here');
  f.jobs.set('spawn-2', { id: 'spawn-2', workspace: 'A', state: 'created' });
  f.followSpawns();
  assert.equal(f.reads.length, 2, 'read at once'); assert.equal(f.armed().length, 0, 'the pending poll was cleared');
  f.reads[1].resolve(); await f.settle();
  assert.deepEqual(f.armed().map(x => x.ms), [700]);
});

test('follow: a spawn created while a read is in flight is read at once when that read ends', async () => {
  const f = follower();
  f.jobs.set('spawn-1', { id: 'spawn-1', workspace: 'A', state: 'created' });
  f.followSpawns();
  f.jobs.set('spawn-2', { id: 'spawn-2', workspace: 'A', state: 'created' });
  f.followSpawns(); assert.equal(f.reads.length, 1, 'never two follow reads at once');
  f.reads[0].resolve(); await f.settle();
  assert.equal(f.reads.length, 2, 'the new spawn reads at once after it'); assert.equal(f.armed().length, 0);
});

// #1246 × #1237: the post-spawn open reuses the shown answer with the stamp of the read that brought it, so a newer
// roster answer (its own fire-and-forget repaint, landing while the terminal key is held) still vetoes a retired row.
// The shipped flow and the inner open's admission checks; tab creation is replaced by a marker.
const innerChecks = shellSource.match(/async function openTerminalTabInner\([^]*?\n\}/)[0].split('  const wrap = document.createElement("div");')[0] + '  opened.push({ name, read });\n}';
async function followedOpen({ retiredByRepaint }) {
  const { retiredTabs } = await import('../renderer/retired-tabs.mjs');
  const { resolveTerminalOpen } = await import('../renderer/instance-tree-view.mjs');
  const live = { ...row, createdAt: '2026-10-15T00:00:00Z', deployment: { id: '/d' }, tmux: { session: 's', window: 'w' } };
  const panel = instances => ({ workspace: { id: 'A' }, instances, deployments: [{ id: '/d', local: true, reachable: true, primary: true }] });
  const key = deferred();
  const c = {
    contextRosterGen: 7, panelReads: 10, shownRoster: { gen: 7, read: 10, ws: 'A', instances: [live] },
    judgedAnswer: { read: 10, workspace: 'A', panel: panel([live]) },
    currentWorkspace: () => 'A', setSidebarMode() {}, setNavActive() {},
    refreshContextRoster() { c.contextRosterGen++; c.repaintRead = ++c.panelReads; },
    tabOpenIntents: { begin: () => () => true }, connectionGeneration: 0,
    api: () => assert.fail('the followed open reads no /api/panel'),
    resolveTerminalOpen, terminalKey, whenKeyFree: () => key.promise, sameInstanceActionTarget,
    tabs: new Map(), pendingTerms: new Set(), terminalOrigin, otherIncarnation, retiredTabs,
    canAddressRemote: () => true, opened: [], notices: [],
  };
  const flow = runInNewContext(`${flowSource}\n${innerChecks}\nopenTerminalTabFlow`, c);
  const open = flow(live, message => c.notices.push(message), { followed: true });
  c.judgedAnswer = { read: c.repaintRead, workspace: 'A', panel: panel(retiredByRepaint ? [] : [live]) }; // the repaint lands
  key.resolve(); await open;
  return c;
}
test('shell: a followed open whose own repaint shows the instance retired while the key was held makes no terminal (#1237)', async () => {
  const c = await followedOpen({ retiredByRepaint: true });
  assert.equal(c.repaintRead, 11, 'the repaint is the newer read');
  assert.equal(c.panelReads, 11, 'the open itself took no read stamp');
  assert.deepEqual(c.opened, []); assert.deepEqual(c.notices, ['unknown instance "dev-x"']);
});
test('shell: a followed open whose repaint still shows the instance opens it, with the shown read\'s stamp', async () => {
  const c = await followedOpen({ retiredByRepaint: false });
  assert.deepEqual(JSON.parse(JSON.stringify(c.opened)), [{ name: 'dev-x', read: 10 }]); assert.deepEqual(c.notices, []);
});
