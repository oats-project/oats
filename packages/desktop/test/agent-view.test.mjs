// The agent view (S2-D; contract D30 v4): the board around an agent's terminal, executed on the shipped
// renderer/agent-board.mjs and agent-board-tabs.mjs in jsdom. One test per behaviour of the spec: the facts strip,
// the question zone, answering (the id on the input line, unsent; nothing typed without the person's Enter; the
// numbers disabled while a dialog claim is live), the gate on the feature, and the reads' latest-intent tokens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createAgentBoard, createHiddenFacts, DIALOG_NOTE } from '../renderer/agent-board.mjs';
import { createTabBoards } from '../renderer/agent-board-tabs.mjs';
import { boardData, BOARD_FEATURE } from '../../client/instance-board.mjs';
import { defaultBinding, TERMINAL_ALLOWLIST, DEFAULT_KEYMAPS } from '../renderer/keybindings.mjs';
import { NOW, fact, question, board, detail } from './helpers/board-fixture.mjs';

function memoryStorage() {
  const m = new Map();
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}
function fixture(t, { typeOk = true } = {}) {
  const dom = new JSDOM('<!doctype html><body><div class="tab-pane active"><div class="term-wrap"><textarea class="xterm-helper"></textarea></div></div></body>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document, pane = doc.querySelector('.tab-pane'), terminal = doc.querySelector('textarea');
  const typed = [], opened = [];
  const view = createAgentBoard({ pane, home: '/w/agents/dev/instances/dev-a', name: 'dev-a', now: () => NOW,
    type: text => { if (typeOk) typed.push(text); return typeOk; }, focusTerminal: () => terminal.focus(), openLink: url => opened.push(url),
    hidden: createHiddenFacts(memoryStorage()) });
  const key = (el, k, extra = {}) => el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
  return { dom, doc, pane, terminal, typed, opened, view, key, zone: () => pane.querySelector('.agent-questions'), facts: () => pane.querySelector('.agent-facts') };
}

test('agent view: top to bottom, the facts, the terminal, the question zone; the terminal is left as it was', t => {
  const f = fixture(t);
  f.view.update(boardData(board()));
  assert.deepEqual([...f.pane.children].map(c => c.className), ['agent-facts', 'term-wrap', 'agent-questions']);
  assert.ok(f.pane.classList.contains('agent-view'));
  assert.equal(f.pane.querySelector('.term-wrap').getAttribute('style'), null, 'no geometry set on the terminal');
});

test('agent view: the terminal appended after the first sync still sits between the facts and the zone', t => {
  const f = fixture(t);
  const wrap = f.pane.querySelector('.term-wrap'); wrap.remove();
  f.view.update(boardData(board()));
  f.pane.append(wrap); f.view.place();
  assert.deepEqual([...f.pane.children].map(c => c.className), ['agent-facts', 'term-wrap', 'agent-questions']);
});

test('agent view facts: label · value · unit, updated <time>, at most three shown and the rest folded', t => {
  const f = fixture(t);
  f.view.update(boardData({ facts: [fact('a', { unit: 'ms' }), fact('b'), fact('c'), fact('d'), fact('e')], questions: [] }));
  const items = [...f.facts().querySelectorAll('.agent-fact')];
  assert.deepEqual(items.map(li => li.dataset.key), ['a', 'b', 'c']);
  assert.match(items[0].textContent, /a label 0\.4312 ms updated 4 min ago/);
  const fold = f.facts().querySelector('.agent-facts-fold');
  assert.equal(fold.hidden, false); assert.equal(fold.textContent, '2 more'); assert.equal(fold.getAttribute('aria-expanded'), 'false');
  fold.click();
  assert.equal(f.facts().querySelectorAll('.agent-fact').length, 5);
  assert.equal(fold.getAttribute('aria-expanded'), 'true');
  assert.equal(f.zone(), null, 'no question: no zone');
});

test('agent view facts: a fact updates in place, and the sparkline comes from inspect --board history', t => {
  const f = fixture(t);
  f.view.update(boardData(board()));
  assert.equal(f.facts().querySelector('.agent-fact-spark'), null);
  f.view.detail({ facts: new Map([['score', { history: [{ value: '0.40' }, { value: '0.42' }, { value: '0.4312' }] }]]), questions: new Map() });
  assert.ok(f.facts().querySelector('li[data-key="score"] .agent-fact-spark'));
  f.view.update(boardData({ ...board(), facts: [fact('score', { label: 'best nDCG@10', value: '0.4400', at: new Date(NOW - 5000).toISOString() })] }));
  const score = f.facts().querySelector('li[data-key="score"]');
  assert.match(score.textContent, /0\.4400/); assert.match(score.textContent, /updated just now/);
});

test('agent view facts: a link is attributed text that opens in the system browser only on a press', t => {
  const f = fixture(t);
  f.view.update(boardData(board()));
  const link = f.facts().querySelector('li[data-key="pr"] .agent-fact-link');
  assert.equal(link.tagName, 'BUTTON'); assert.equal(f.facts().querySelector('a'), null, 'no anchor, no auto-link');
  assert.match(link.textContent, /^dev-a says: https:\/\/github\.com\/oats-project\/oats\/pull\/1990$/);
  assert.equal(link.querySelector('.agent-fact-host').textContent, 'github.com');
  assert.deepEqual(f.opened, []);
  link.click();
  assert.deepEqual(f.opened, ['https://github.com/oats-project/oats/pull/1990']);
});

test('agent view facts: × or u hides a fact on this computer only; it shows again when its value changes', t => {
  const f = fixture(t);
  f.view.update(boardData(board()));
  f.facts().querySelector('li[data-key="score"] .agent-fact-hide').click();
  assert.deepEqual([...f.facts().querySelectorAll('.agent-fact')].map(li => li.dataset.key), ['pr']);
  assert.equal(f.facts().querySelector('.agent-facts-unhide').textContent, '1 hidden · show');
  assert.deepEqual(f.typed, [], 'nothing is typed: the kernel\'s unset is the agent\'s');
  f.facts().querySelector('li[data-key="pr"] .agent-fact-focus').focus();
  f.key(f.doc.activeElement, 'u');
  assert.equal(f.facts().querySelectorAll('.agent-fact').length, 0);
  f.view.update(boardData({ ...board(), facts: [fact('score', { label: 'best nDCG@10', value: '0.5000' }), board().facts[1]] }));
  assert.deepEqual([...f.facts().querySelectorAll('.agent-fact')].map(li => li.dataset.key), ['score'], 'a new value shows again');
});

test('agent view questions: one at a time, full width, "question n of N", ‹ › and the dots, Tab / Shift+Tab and ←/→ turn it', t => {
  const f = fixture(t);
  f.view.update(boardData(board()));
  const zone = f.zone();
  assert.equal(zone.querySelector('.agent-q-tag').textContent, 'question 1 of 2');
  assert.equal(zone.querySelector('.agent-q-text').textContent, 'Squash q1?');
  assert.equal(zone.querySelectorAll('.agent-q-option').length, 2);
  assert.equal(zone.querySelectorAll('.agent-q-dot').length, 2);
  zone.focus(); f.key(zone, 'Tab');
  assert.equal(zone.querySelector('.agent-q-tag').textContent, 'question 2 of 2');
  assert.equal(zone.querySelectorAll('.agent-q-option').length, 3);
  f.key(zone, 'Tab', { shiftKey: true });
  assert.equal(f.view.question, 'q1');
  f.key(zone, 'ArrowRight'); assert.equal(f.view.question, 'q2');
  f.key(zone, 'ArrowLeft'); assert.equal(f.view.question, 'q1');
  zone.querySelector('.agent-q-turn[aria-label="Next question"]').click(); assert.equal(f.view.question, 'q2');
  zone.querySelectorAll('.agent-q-dot')[0].click(); assert.equal(f.view.question, 'q1');
  f.view.update(boardData({ ...board(), questions: [question('q2')] }));
  assert.equal(f.zone().querySelector('.agent-q-tag').textContent, 'needs you', 'a single question');
  f.view.update(boardData({ ...board(), questions: [] }));
  assert.equal(f.zone(), null, 'empty when none are open');
});

test('agent view questions: the context fold is attributed plain text, read with the detail', t => {
  const f = fixture(t);
  f.view.update(boardData({ ...board(), questions: [question('q1', { hasContext: true })] }));
  const fold = f.zone().querySelector('.agent-q-context');
  assert.equal(fold.hidden, false); assert.match(fold.textContent, /Reading the context/);
  f.view.detail({ facts: new Map(), questions: new Map([['q1', { context: 'Three commits:\nfix, <b>test</b>, docs.' }]]) });
  assert.equal(fold.querySelector('.agent-q-says').textContent, 'dev-a says:');
  assert.equal(fold.querySelector('.agent-q-context-text').textContent, 'Three commits:\nfix, <b>test</b>, docs.');
  assert.equal(fold.querySelector('b'), null, 'never markup');
});

test('agent view answering: a number puts "<id>: <option>" on the input line, unsent, and the terminal takes the focus', t => {
  const f = fixture(t);
  f.view.update(boardData(board()));
  f.zone().focus(); f.key(f.zone(), '1');
  assert.deepEqual(f.typed, ['q1: Yes, one clean commit']);
  assert.equal(f.doc.activeElement, f.terminal);
  f.zone().focus(); f.key(f.zone(), 'Tab'); f.key(f.zone(), '3');
  assert.deepEqual(f.typed, ['q1: Yes, one clean commit', 'q2: Close']);
  f.zone().querySelectorAll('.agent-q-option')[0].click();
  assert.equal(f.typed.at(-1), 'q2: Merge', 'a press of the option types the same');
});

test('agent view answering: no digit is ever typed without its id, and nothing is sent without the person\'s Enter', t => {
  const f = fixture(t);
  f.view.update(boardData(board()));
  f.zone().focus();
  for (const k of ['1', '2', '9', '5']) f.key(f.zone(), k);
  assert.ok(f.typed.length >= 1);
  for (const text of f.typed) { assert.match(text, /^q\d: \S/); assert.doesNotMatch(text, /[\r\n]/); }
  assert.ok(!f.typed.some(text => /^\d+$/.test(text)), 'no bare digit');
  assert.equal(f.typed.length, 2, '9 and 5 name no option: nothing typed');
  assert.equal(f.view.question, 'q1', 'the card stays until the person sends');
  f.view.input('x'); assert.equal(f.view.question, 'q1');
  f.view.input('\n'); assert.equal(f.view.question, 'q1', 'Shift+Enter is a new line, not a send');
  f.view.input('\r');
  assert.equal(f.view.question, 'q2', 'after Enter the card hides optimistically');
  f.view.update(boardData(board()));
  assert.equal(f.view.question, 'q2', 'until the agent clears it');
  f.view.update(boardData({ ...board(), questions: [question('q2')] }));
  f.view.update(boardData(board()));
  assert.equal(f.zone().querySelectorAll('.agent-q-dot').length, 2, 'a cleared id asked again is a new question');
});

test('agent view answering: the numbers are disabled while a permission or question claim is live, and say why', t => {
  const f = fixture(t);
  f.view.update(boardData(board()), { claims: [{ producer: 'oats.board', reason: 'attention' }, { producer: 'pi.harness', waiting: true, reason: 'permission' }] });
  const options = [...f.zone().querySelectorAll('.agent-q-option')];
  assert.ok(options.every(b => b.disabled));
  assert.equal(f.zone().querySelector('.agent-q-note').hidden, false);
  assert.equal(f.zone().querySelector('.agent-q-note').textContent, DIALOG_NOTE);
  f.zone().focus(); f.key(f.zone(), '1'); options[0].click();
  assert.deepEqual(f.typed, [], 'nothing typed');
  f.view.update(boardData(board()), { claims: [{ producer: 'pi.harness', waiting: false, reason: 'permission' }] });
  assert.ok([...f.zone().querySelectorAll('.agent-q-option')].every(b => !b.disabled));
  assert.equal(f.zone().querySelector('.agent-q-note').hidden, true);
});

test('agent view answering: no lease, nothing typed, the card stays and the focus does not move', t => {
  const f = fixture(t, { typeOk: false });
  f.view.update(boardData(board()));
  f.zone().focus(); f.key(f.zone(), '1');
  assert.equal(f.doc.activeElement, f.zone()); f.view.input('\r');
  assert.equal(f.view.question, 'q1');
});

test('agent view keys: Alt+T cycles terminal → questions → facts → terminal; Esc goes back; the default is Alt+T, allowed in a terminal', t => {
  const f = fixture(t);
  f.view.update(boardData(board()));
  f.terminal.focus();
  assert.equal(f.view.cycleFocus(), true); assert.ok(f.zone().contains(f.doc.activeElement));
  f.view.cycleFocus(); assert.ok(f.facts().contains(f.doc.activeElement));
  f.view.cycleFocus(); assert.equal(f.doc.activeElement, f.terminal);
  f.view.cycleFocus(); f.key(f.doc.activeElement, 'Escape'); assert.equal(f.doc.activeElement, f.terminal);
  assert.equal(defaultBinding('agent.viewFocus', false, 'alt'), 'Alt+T');
  assert.equal(defaultBinding('agent.viewFocus', false, 'ctrl+alt'), 'Ctrl+Alt+T');
  assert.equal(defaultBinding('agent.viewFocus', true), 'Mod+Alt+T');
  assert.ok(TERMINAL_ALLOWLIST.includes('agent.viewFocus'));
  assert.ok(Object.values(DEFAULT_KEYMAPS).every(k => Object.hasOwn(k, 'agent.viewFocus')));
});

// ── the shell's link (agent-board-tabs.mjs) ──
function tabsFixture(t, { features = [BOARD_FEATURE], events = true } = {}) {
  const dom = new JSDOM('<!doctype html><body><div class="tab-pane active"><div class="term-wrap"></div></div></body>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const pane = dom.window.document.querySelector('.tab-pane');
  const calls = [], pending = [];
  const post = (path, body) => new Promise((resolve, reject) => { calls.push({ path, body }); pending.push({ path, resolve, reject }); });
  const boards = createTabBoards({ features: () => features, eventsReadable: () => events, post, openLink: () => {}, hidden: createHiddenFacts(memoryStorage()), now: () => NOW });
  const tab = { paneEl: pane, typeText: () => true, focusTerminal: () => {} };
  const row = (extra = {}) => ({ instance: 'dev-a', agent: 'dev', agentsRoot: '/w/agents', home: '/w/agents/dev/instances/dev-a', running: true, board: boardData(board()), ...extra });
  const flush = () => new Promise(r => setTimeout(r, 0));
  return { pane, calls, pending, boards, tab, row, flush };
}

test('agent view gate: without the feature (an older kernel) the tab is today\'s terminal and its waiting row', t => {
  const f = tabsFixture(t, { features: [] });
  const claim = { producer: 'oats.board', reason: 'attention', since: '2026-11-19T10:00:00.000Z', message: 'Squash q1?' };
  assert.equal(f.boards.sync(f.tab, f.row(), claim, 'w'), false, 'the waiting row keeps the claim');
  assert.equal(f.pane.querySelector('.agent-facts, .agent-questions'), null);
  assert.deepEqual(f.calls, [], 'no read');
  const older = tabsFixture(t);
  const { board: _none, ...row } = older.row();
  assert.equal(older.boards.sync(older.tab, row, claim, 'w'), false, 'a row with no board field');
  assert.equal(older.pane.querySelector('.agent-facts, .agent-questions'), null);
});

test('agent view gate: the board\'s own claim gives way to the zone; another producer\'s keeps the waiting row', t => {
  const f = tabsFixture(t);
  const since = '2026-11-19T10:00:00.000Z';
  assert.equal(f.boards.sync(f.tab, f.row(), { producer: 'oats.board', reason: 'attention', since, message: 'Squash q1?' }, 'w'), true);
  assert.equal(f.boards.sync(f.tab, f.row(), { producer: 'agent', reason: 'attention', since, message: 'Look at the PR' }, 'w'), false);
  assert.equal(f.boards.sync(f.tab, f.row({ board: boardData({ facts: [], questions: [] }) }), { producer: 'oats.board', reason: 'attention', since }, 'w'), false, 'no question open');
  assert.ok(f.pane.querySelector('.term-wrap'));
});

test('agent view reads: inspect --board and the claims when the view opens, through the existing endpoints', async t => {
  const f = tabsFixture(t);
  f.boards.sync(f.tab, f.row(), null, 'w');
  assert.deepEqual(f.calls.map(c => c.path), ['/api/capabilities?ws=w', '/api/instance-events?ws=w']);
  assert.deepEqual(f.calls[0].body, { action: 'inspect', selector: { home: '/w/agents/dev/instances/dev-a' }, board: true });
  assert.deepEqual(f.calls[1].body, { action: 'read', selector: { instance: 'dev-a', agent: 'dev', agentsRoot: '/w/agents', server: null }, limit: 50 });
  f.pending[1].resolve({ status: 'available', data: { waitingClaims: [{ producer: 'pi.harness', waiting: true, reason: 'permission', since: '2026-11-19T10:00:00.000Z' }] } });
  f.pending[0].resolve(detail());
  await f.flush();
  assert.ok(f.pane.querySelector('.agent-q-option').disabled, 'the events read saw a dialog the row did not');
  assert.ok(f.pane.querySelector('.agent-fact-spark'));
  f.boards.sync(f.tab, f.row(), null, 'w');
  assert.equal(f.calls.length, 2, 'an unchanged poll reads nothing');
});

test('agent view reads: a stale answer, or one after the tab closed, changes nothing, on success and on rejection', async t => {
  const f = tabsFixture(t);
  f.boards.sync(f.tab, f.row(), null, 'w');
  const changed = boardData({ ...board(), facts: [fact('score', { value: '0.99' })] });
  f.boards.sync(f.tab, f.row({ board: changed }), null, 'w');
  assert.equal(f.calls.filter(c => c.path.startsWith('/api/capabilities')).length, 2, 'a changed board reads again');
  const [first, , second] = f.pending;
  second.resolve({ board: { facts: [{ key: 'score', history: [{ value: '1', at: '2026-11-19T10:00:00.000Z' }, { value: '2', at: '2026-11-19T10:01:00.000Z' }] }], questions: [] } });
  await f.flush();
  first.resolve(detail()); // the older read answers last
  await f.flush();
  const note = f.pane.querySelector('li[data-key="score"] .agent-fact-sparknote');
  assert.equal(note.textContent.trim(), 'last 2', 'the newer read stands');
  // A rejection after a newer read began changes nothing either.
  f.boards.sync(f.tab, f.row({ board: boardData(board()) }), null, 'w');
  const third = f.pending.at(-1);
  f.boards.sync(f.tab, f.row({ board: changed }), null, 'w');
  third.reject(new Error('refused'));
  await f.flush();
  assert.ok(f.pane.querySelector('.agent-fact-spark'), 'the stale rejection did not wipe the newer history');
  // Closed: a late answer paints nothing.
  const last = f.pending.at(-1);
  f.boards.close(f.tab);
  last.resolve(detail()); await f.flush();
  assert.equal(f.pane.querySelector('.agent-facts, .agent-questions'), null);
  assert.equal(f.pane.classList.contains('agent-view'), false);
});

test('agent view reads: without the events read the numbers stay enabled (unknown is not a dialog)', async t => {
  const f = tabsFixture(t, { events: false });
  f.boards.sync(f.tab, f.row(), null, 'w');
  assert.deepEqual(f.calls.map(c => c.path), ['/api/capabilities?ws=w']);
  assert.ok([...f.pane.querySelectorAll('.agent-q-option')].every(b => !b.disabled));
});
