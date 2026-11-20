// The agent view (S2-D; contract D30 v4): the board around an agent's terminal, executed on the shipped
// renderer/agent-board.mjs and agent-board-tabs.mjs in jsdom. One test per behaviour of the spec: the facts strip,
// the question zone, answering (the id on the input line, unsent; nothing typed without the person's Enter; the
// numbers disabled while a dialog claim is live), the gate on the feature, and the reads' latest-intent tokens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createAgentBoard, createHiddenFacts, DIALOG_NOTE, DETAIL_NOTES, BOARD_MALFORMED, boardDropped } from '../renderer/agent-board.mjs';
import { createTabBoards } from '../renderer/agent-board-tabs.mjs';
import { boardData, boardDetailData, BOARD_FEATURE } from '../../client/instance-board.mjs';
import { defaultBinding, TERMINAL_ALLOWLIST, DEFAULT_KEYMAPS } from '../renderer/keybindings.mjs';
import { createFocusRegions, REGIONS } from '../renderer/focus-regions.mjs';
import { leaderDoes } from '../../client/keymap.mjs';
import { AT, NOW, fact, question, board, detail } from './helpers/board-fixture.mjs';

function memoryStorage() {
  const m = new Map();
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}
function fixture(t, { typeOk = true, checkClaims = null } = {}) {
  const dom = new JSDOM('<!doctype html><body><div class="tab-pane active"><div class="term-wrap"><textarea class="xterm-helper"></textarea></div></div></body>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document, pane = doc.querySelector('.tab-pane'), terminal = doc.querySelector('textarea');
  const typed = [], opened = [];
  const view = createAgentBoard({ pane, home: '/w/agents/dev/instances/dev-a', name: 'dev-a', now: () => NOW,
    type: text => { if (typeOk) typed.push(text); return typeOk; }, focusTerminal: () => terminal.focus(), openLink: url => opened.push(url),
    hidden: createHiddenFacts(memoryStorage()), checkClaims });
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
  f.view.detail({ state: 'ok', facts: new Map([['score', { history: [{ value: '0.40' }, { value: '0.42' }, { value: '0.4312' }] }]]), questions: new Map() });
  assert.ok(f.facts().querySelector('li[data-key="score"] .agent-fact-spark'));
  f.view.update(boardData({ ...board(), facts: [fact('score', { label: 'best nDCG@10', value: '0.4400', at: new Date(NOW - 5000).toISOString() })] }));
  const score = f.facts().querySelector('li[data-key="score"]');
  assert.match(score.textContent, /0\.4400/); assert.match(score.textContent, /updated just now/);
});

test('agent view facts: a link is attributed text; a press shows the whole address, and only Open opens it in the browser', t => {
  const f = fixture(t);
  f.view.update(boardData(board()));
  const link = f.facts().querySelector('li[data-key="pr"] .agent-fact-link');
  assert.equal(link.tagName, 'BUTTON'); assert.equal(f.facts().querySelector('a'), null, 'no anchor, no auto-link');
  assert.equal(link.textContent, 'dev-a says: github.com…');
  assert.equal(link.querySelector('.agent-fact-host').textContent, 'github.com');
  link.click();
  assert.deepEqual(f.opened, [], 'showing the address opens nothing');
  const box = f.facts().querySelector('.agent-fact-url');
  assert.equal(box.hidden, false); assert.equal(link.isConnected ? link.getAttribute('aria-expanded') : f.facts().querySelector('li[data-key="pr"] .agent-fact-link').getAttribute('aria-expanded'), 'true');
  assert.equal(box.querySelector('.agent-fact-url-text').textContent, 'https://github.com/oats-project/oats/pull/1990');
  assert.equal(box.querySelector('.agent-fact-host').textContent, 'github.com');
  assert.equal(f.doc.activeElement, box.querySelector('.agent-fact-url-open'), 'the keyboard lands on Open');
  box.querySelector('.agent-fact-url-open').click();
  assert.deepEqual(f.opened, ['https://github.com/oats-project/oats/pull/1990']);
  f.key(f.doc.activeElement, 'Escape');
  assert.equal(f.facts().querySelector('.agent-fact-url').hidden, true, 'Esc closes it');
  assert.equal(f.doc.activeElement, f.facts().querySelector('li[data-key="pr"] .agent-fact-link'));
});

test('r2: the address shown is exactly the one opened, whatever the host\'s case or spelling', t => {
  for (const href of ['https://EXAMPLE.COM/pr/1', 'https://Example.com:8443/a?b=1', 'https://%65xample.com/x']) {
    const f = fixture(t);
    f.view.update(boardData({ facts: [fact('pr', { link: href })], questions: [] }));
    f.facts().querySelector('.agent-fact-link').click();
    assert.equal(f.facts().querySelector('.agent-fact-url-text').textContent, href, href);
    f.facts().querySelector('.agent-fact-url-open').click();
    assert.deepEqual(f.opened, [href]);
  }
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
  f.view.detail({ state: 'ok', facts: new Map(), questions: new Map([['q1', { context: 'Three commits:\nfix, <b>test</b>, docs.', since: AT }]]) });
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

test('agent view answering: the claims are read again at the press, so a dialog that opened since types nothing', async t => {
  // The view's owner paints the latest read's claims through update, then answers { latest }.
  let view = null, fresh = [];
  const f = fixture(t, { checkClaims: async () => { view.update(boardData(board()), { claims: fresh }); return { latest: true }; } });
  view = f.view;
  f.view.update(boardData(board()), { claims: [{ producer: 'oats.board', reason: 'attention' }] });
  assert.ok([...f.zone().querySelectorAll('.agent-q-option')].every(b => !b.disabled), 'the row alone shows no dialog');
  fresh = [{ producer: 'oats.board', reason: 'attention' }, { producer: 'pi.harness', waiting: true, reason: 'permission' }];
  f.zone().querySelector('.agent-q-option').click();
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(f.typed, [], 'nothing typed');
  assert.equal(f.zone().querySelector('.agent-q-note').textContent, DIALOG_NOTE);
  fresh = [{ producer: 'pi.harness', waiting: false, reason: 'permission' }];
  f.view.update(boardData(board()), { claims: [] });
  f.zone().querySelector('.agent-q-option').click();
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(f.typed, ['q1: Yes, one clean commit'], 'the dialog is gone: the press types');
});

test('agent view answering: a failed latest read still types; a newer press wins over an older one', async t => {
  let release;
  const f = fixture(t, { checkClaims: () => new Promise(r => { release = r; }) });
  f.view.update(boardData(board()));
  const [one, two] = f.zone().querySelectorAll('.agent-q-option');
  one.click(); const first = release;
  two.click(); const second = release;
  first({ latest: true }); await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(f.typed, [], 'the older press types nothing');
  second({ latest: true }); await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(f.typed, ['q1: No, keep them'], 'a latest read that saw no dialog (or failed: unknown) types');
});

test('agent view answering: a superseded claims read cancels the press, even when it answers last', async t => {
  let release;
  const f = fixture(t, { checkClaims: () => new Promise(r => { release = r; }) });
  f.view.update(boardData(board()));
  f.zone().querySelector('.agent-q-option').click();
  release({ latest: false }); await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(f.typed, [], 'an answer older than the latest read never types');
});

test('agent view answering: no lease, nothing typed, the card stays and the focus does not move', t => {
  const f = fixture(t, { typeOk: false });
  f.view.update(boardData(board()));
  f.zone().focus(); f.key(f.zone(), '1');
  assert.equal(f.doc.activeElement, f.zone()); f.view.input('\r');
  assert.equal(f.view.question, 'q1');
});

test('agent view keys: the palette command cycles terminal → questions → facts → terminal; Esc goes back; no chord takes Alt+T', t => {
  const f = fixture(t);
  f.view.update(boardData(board()));
  f.terminal.focus();
  assert.equal(f.view.cycleFocus(), true); assert.ok(f.zone().contains(f.doc.activeElement));
  f.view.cycleFocus(); assert.ok(f.facts().contains(f.doc.activeElement));
  f.view.cycleFocus(); assert.equal(f.doc.activeElement, f.terminal);
  f.view.cycleFocus(); f.key(f.doc.activeElement, 'Escape'); assert.equal(f.doc.activeElement, f.terminal);
  assert.equal(leaderDoes('t'), null, 'no leader row (the shared table is the TUI\'s)');
  for (const family of ['alt', 'ctrl+alt', 'ctrl+shift']) for (const isMac of [true, false]) {
    assert.equal(defaultBinding('agent.viewFocus', isMac, family), undefined, 'no chord');
    for (const id of Object.keys(DEFAULT_KEYMAPS[family])) assert.notEqual(defaultBinding(id, false, family), 'Alt+T', `${id} takes no Alt+T`);
  }
  assert.equal(TERMINAL_ALLOWLIST.includes('agent.viewFocus'), false);
});

test('agent view keys: F6 reaches the facts and the questions as regions around the terminal, in the order they show', t => {
  const dom = new JSDOM(`<!doctype html><body><div id="app"><main id="main"><div class="tab-pane active"><div class="term-wrap"><textarea></textarea></div></div></main>
    <aside id="context-panel" hidden></aside></div></body>`, { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document, pane = doc.querySelector('.tab-pane'), terminal = doc.querySelector('textarea');
  const view = createAgentBoard({ pane, home: '/h', name: 'dev-a', now: () => NOW, type: () => true, focusTerminal: () => terminal.focus(), openLink: () => {},
    hidden: createHiddenFacts(memoryStorage()), observe: () => () => {} });
  view.update(boardData(board()));
  const regions = createFocusRegions({ doc, tabLayerVisible: () => true, focusMainContent: () => { terminal.focus(); return true; },
    agentView: { part: name => view.part(name), focus: name => view.focusPart(name) } });
  assert.deepEqual(REGIONS.slice(3, 6), ['facts', 'main', 'questions']);
  terminal.focus();
  assert.equal(regions.regionOfFocus(), 'main');
  assert.equal(regions.cycle(1), true); assert.equal(regions.regionOfFocus(), 'questions', 'from the terminal (Ctrl+Shift+F6): the questions');
  assert.ok(doc.activeElement.classList.contains('agent-q-option'));
  regions.cycle(-1); assert.equal(regions.regionOfFocus(), 'main');
  regions.cycle(-1); assert.equal(regions.regionOfFocus(), 'facts', 'Shift+F6 from the terminal: the facts');
  view.update(boardData({ facts: [], questions: [] }));
  terminal.focus(); regions.cycle(1);
  assert.notEqual(regions.regionOfFocus(), 'questions', 'no zone: not in the cycle');
});

// ── the shell's link (agent-board-tabs.mjs) ──
function tabsFixture(t, { features = [BOARD_FEATURE], events = true } = {}) {
  const dom = new JSDOM('<!doctype html><body><div class="tab-pane active"><div class="term-wrap"></div></div></body>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const pane = dom.window.document.querySelector('.tab-pane');
  const calls = [], pending = [];
  const post = (path, body) => new Promise((resolve, reject) => { calls.push({ path, body }); pending.push({ path, resolve, reject }); });
  const boards = createTabBoards({ features: () => features, eventsReadable: () => events, post, openLink: () => {}, hidden: createHiddenFacts(memoryStorage()), now: () => NOW });
  let inView = true;
  const tab = { paneEl: pane, typeText: () => true, focusTerminal: () => {}, inView: () => inView };
  const row = (extra = {}) => ({ instance: 'dev-a', agent: 'dev', agentsRoot: '/w/agents', home: '/w/agents/dev/instances/dev-a', running: true, board: boardData(board()), ...extra });
  const flush = () => new Promise(r => setTimeout(r, 0));
  return { pane, calls, pending, boards, tab, row, flush, setInView: v => { inView = v; } };
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
  const other = tabsFixture(t);
  other.boards.sync(other.tab, other.row({ deployment: { id: 'ws:d1' } }), null, 'view');
  assert.deepEqual(other.calls.map(c => c.path), ['/api/capabilities?ws=ws%3Ad1', '/api/instance-events?ws=ws%3Ad1'], 'the row\'s own deployment, never the window\'s view');
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

test('agent view reads: a press reads the claims again through the events read before it types', async t => {
  const f = tabsFixture(t);
  const typed = []; f.tab.typeText = text => { typed.push(text); return true; };
  f.boards.sync(f.tab, f.row(), null, 'w');
  f.pending[1].resolve({ status: 'available', data: { waitingClaims: [] } }); f.pending[0].resolve(detail());
  await f.flush();
  f.pane.querySelector('.agent-q-option').click();
  assert.equal(f.calls.at(-1).path, '/api/instance-events?ws=w', 'a fresh read at the press');
  assert.deepEqual(typed, [], 'nothing typed before it answers');
  f.pending.at(-1).resolve({ status: 'available', data: { waitingClaims: [{ producer: 'pi.harness', waiting: true, reason: 'permission', since: '2026-11-19T10:05:00.000Z' }] } });
  await f.flush();
  assert.deepEqual(typed, [], 'a dialog opened since: nothing typed');
  assert.ok(f.pane.querySelector('.agent-q-option').disabled);
});

test('agent view focus: an option disabled under the focus (a dialog opened) leaves the focus on the zone', t => {
  const f = fixture(t);
  f.view.update(boardData(board()));
  f.zone().querySelector('.agent-q-option').focus();
  f.view.update(boardData(board()), { claims: [{ producer: 'pi.harness', waiting: true, reason: 'question' }] });
  assert.equal(f.doc.activeElement, f.zone());
});

// The maintainer's conditions for the board read (2026-11-19), as the view shows them.
test('board read condition 2: the view says which outcome it has; none of them hides the questions', t => {
  const withContext = () => boardData({ ...board(), questions: [question('q1', { hasContext: true })] });
  for (const [state, text] of [['failed', DETAIL_NOTES.failed], ['malformed', DETAIL_NOTES.malformed], ['unsupported', DETAIL_NOTES.unsupported], ['none', DETAIL_NOTES.none]]) {
    const f = fixture(t);
    f.view.update(withContext());
    f.view.detail({ state });
    assert.equal(f.facts().querySelector('.agent-facts-note').textContent, text.history, `${state}: the strip says so`);
    assert.equal(f.zone().querySelector('.agent-q-context-none').textContent, text.context, `${state}: the fold says so`);
    assert.equal(f.view.question, 'q1', `${state}: the question stays`);
  }
  const ok = fixture(t);
  ok.view.update(withContext()); ok.view.detail({ state: 'ok', facts: new Map(), questions: new Map() });
  assert.equal(ok.facts().querySelector('.agent-facts-note').hidden, true, 'a read board: no note');
  assert.match(ok.zone().querySelector('.agent-q-context-none').textContent, /sent no context/);
  const bad = fixture(t);
  bad.view.update(boardData('not a board'));
  assert.equal(bad.facts().querySelector('.agent-facts-note').textContent, BOARD_MALFORMED, 'a malformed row board is said, not shown as empty');
  const part = fixture(t);
  part.view.update(boardData({ facts: [fact('a'), fact('BAD')], questions: [] }));
  assert.equal(part.facts().querySelector('.agent-facts-note').textContent, boardDropped(1));
  const empty = fixture(t);
  empty.view.update(boardData({ facts: [], questions: [] }));
  assert.equal(empty.view.shown, false, 'an empty board: nothing to show, and nothing claimed');
});

test('board read condition 3: the context is the agent\'s plain text, attributed, never markup', t => {
  const f = fixture(t);
  f.view.update(boardData({ ...board(), questions: [question('q1', { hasContext: true })] }));
  f.view.detail({ state: 'ok', facts: new Map(), questions: new Map([['q1', { context: '<img src=x onerror=alert(1)> and\nmore', since: AT }]]) });
  const fold = f.zone().querySelector('.agent-q-context');
  assert.equal(fold.querySelector('img'), null);
  assert.equal(fold.querySelector('.agent-q-says').textContent, 'dev-a says:');
  assert.equal(fold.querySelector('.agent-q-context-text').textContent, '<img src=x onerror=alert(1)> and\nmore');
});

test('board read condition 4: read on open and on a changed fact `at`, never on the poll; a home no longer shown changes nothing', async t => {
  const f = tabsFixture(t, { events: false });
  const detailCalls = () => f.calls.filter(c => c.path.startsWith('/api/capabilities')).length;
  f.boards.sync(f.tab, f.row(), null, 'w');
  assert.equal(detailCalls(), 1, 'on open');
  f.boards.sync(f.tab, f.row(), null, 'w'); f.boards.sync(f.tab, f.row(), null, 'w');
  assert.equal(detailCalls(), 1, 'not on an unchanged poll');
  const sameAt = boardData({ ...board(), questions: [question('q9')] });
  f.boards.sync(f.tab, f.row({ board: sameAt }), null, 'w');
  assert.equal(detailCalls(), 1, 'a question without context is not a reason');
  const moved = boardData({ ...board(), facts: [fact('score', { value: '0.5', at: '2026-11-19T10:03:00.000Z' })] });
  f.boards.sync(f.tab, f.row({ board: moved }), null, 'w');
  assert.equal(detailCalls(), 2, 'a changed fact at');
  // The tab now shows another home: the answer for the first changes nothing.
  const late = f.pending.find(p => p.path.startsWith('/api/capabilities'));
  f.boards.sync(f.tab, f.row({ home: '/w/agents/dev/instances/dev-z', instance: 'dev-z' }), null, 'w');
  late.resolve(detail()); await f.flush();
  assert.equal(f.pane.querySelector('.agent-fact-spark'), null, 'the old home\'s history is not painted');
});

// Round 1's findings, each pinned.
const permission = { producer: 'pi.harness', waiting: true, reason: 'permission', since: '2026-11-19T10:05:00.000Z' };
const settle = async f => { await f.flush(); await f.flush(); };
const eventsCalls = f => f.pending.filter(p => p.path.startsWith('/api/instance-events'));
async function opened(t) {
  const f = tabsFixture(t);
  const typed = []; f.tab.typeText = text => { typed.push(text); return true; };
  f.boards.sync(f.tab, f.row(), null, 'w');
  eventsCalls(f)[0].resolve({ status: 'available', data: { waitingClaims: [] } });
  f.pending[0].resolve(detail());
  await settle(f);
  return { f, typed };
}

test('r1: an older claims answer, out of order, never undoes a newer permission claim nor types', async t => {
  const { f, typed } = await opened(t);
  f.pane.querySelector('.agent-q-option').click(); // read A, for the press
  const zone = f.pane.querySelector('.agent-questions');
  zone.dispatchEvent(new f.pane.ownerDocument.defaultView.FocusEvent('focusin', { bubbles: true })); // read B, entering the zone
  await f.flush();
  const [, a, b] = eventsCalls(f);
  b.resolve({ status: 'available', data: { waitingClaims: [permission] } }); await settle(f);
  assert.ok(f.pane.querySelector('.agent-q-option').disabled, 'B, the newer read, painted the dialog');
  a.resolve({ status: 'available', data: { waitingClaims: [] } }); await settle(f);
  assert.ok(f.pane.querySelector('.agent-q-option').disabled, 'A, older, changes nothing');
  assert.deepEqual(typed, [], 'and types nothing');
});

test('r1: never typed into a terminal off screen, on success and on rejection of the claims read', async t => {
  for (const outcome of ['resolve', 'reject']) {
    const { f, typed } = await opened(t);
    f.pane.querySelector('.agent-q-option').click();
    f.setInView(false); // another tab, stage or workspace shown while the read runs
    const read = eventsCalls(f).at(-1);
    if (outcome === 'resolve') read.resolve({ status: 'available', data: { waitingClaims: [] } }); else read.reject(new Error('refused'));
    await settle(f);
    assert.deepEqual(typed, [], `${outcome}: nothing typed off screen`);
    f.setInView(true);
    assert.deepEqual(typed, [], `${outcome}: nor later`);
    f.pane.querySelector('.agent-q-option').click(); f.setInView(false);
    assert.deepEqual(typed, []);
  }
});

test('r1: a press while the view is off screen types nothing, even with no claims read', t => {
  const dom = new JSDOM('<!doctype html><body><div class="tab-pane"><div class="term-wrap"></div></div></body>');
  t.after(() => dom.window.close());
  const typed = [];
  const view = createAgentBoard({ pane: dom.window.document.querySelector('.tab-pane'), home: '/h', name: 'dev-a', now: () => NOW,
    type: text => { typed.push(text); return true; }, focusTerminal: () => {}, openLink: () => {}, shown: () => false, hidden: createHiddenFacts(memoryStorage()) });
  view.update(boardData(board()));
  dom.window.document.querySelector('.agent-q-option').click();
  assert.deepEqual(typed, []);
});

test('r1: with several questions, the keyboard reaches the Context fold (c), and Tab moves within it', t => {
  const f = fixture(t);
  f.view.update(boardData({ ...board(), questions: [question('q1', { hasContext: true }), question('q2')] }));
  f.view.detail({ state: 'ok', facts: new Map(), questions: new Map([['q1', { context: 'Why: three commits.', since: AT }]]) });
  f.terminal.focus();
  f.view.cycleFocus(); // the leader's t: an option of the zone
  assert.ok(f.zone().contains(f.doc.activeElement));
  f.key(f.doc.activeElement, 'c');
  const fold = f.zone().querySelector('.agent-q-context');
  assert.equal(fold.open, true, 'c opens the fold');
  assert.equal(f.doc.activeElement, fold.querySelector('summary'), 'and focuses its summary');
  const tab = f.key(f.doc.activeElement, 'Tab');
  assert.equal(tab, true, 'Tab inside the fold is not taken by the carousel');
  assert.equal(f.view.question, 'q1');
  assert.equal(fold.querySelector('.agent-q-context-text').textContent, 'Why: three commits.');
  assert.equal(fold.querySelector('.agent-q-context-text').tabIndex, 0, 'its text takes the focus, to scroll a long one');
  assert.match(f.zone().querySelector('.agent-q-hint').textContent, /c the context/);
});

test('r1: an id cleared and asked again between two polls is a new question', t => {
  const f = fixture(t);
  f.view.update(boardData(board()));
  f.zone().focus(); f.key(f.zone(), '1'); f.view.input('\r');
  assert.equal(f.view.question, 'q2', 'q1 answered and hidden');
  f.view.update(boardData({ ...board(), questions: [question('q1', { question: 'A new decision?', since: '2026-11-19T10:03:00.000Z' }), question('q2')] }));
  assert.equal(f.zone().querySelectorAll('.agent-q-dot').length, 2, 'the new q1 shows, without an empty board seen in between');
});

test('r1: a withheld fact text is withheld in its accessible names too', t => {
  const f = fixture(t);
  f.view.update(boardData({ facts: [fact('s', { label: 'token=abcdefgh1234', value: 'secret=hidden-value' })], questions: [] }));
  const li = f.facts().querySelector('.agent-fact');
  const names = [...li.querySelectorAll('[aria-label]')].map(el => el.getAttribute('aria-label')).join(' | ');
  assert.doesNotMatch(names, /hidden-value|abcdefgh1234/);
  assert.doesNotMatch(li.textContent, /hidden-value|abcdefgh1234/);
});

// Round 2's findings, each pinned.
test('r2: entering the zone reads the claims once; the repaints that answer it start no further read', async t => {
  const f = tabsFixture(t);
  f.boards.sync(f.tab, f.row(), null, 'w');
  const answerAll = async () => {
    for (let round = 0; round < 20; round++) {
      const open = f.pending.splice(0);
      if (!open.length) return;
      for (const p of open) p.resolve(p.path.startsWith('/api/instance-events') ? { status: 'available', data: { waitingClaims: [] } } : detail());
      await f.flush(); await f.flush();
    }
  };
  await answerAll();
  const before = f.calls.length;
  const terminal = f.pane.ownerDocument.createElement('textarea'); f.pane.querySelector('.term-wrap').append(terminal); terminal.focus();
  assert.equal(f.boards.cycleFocus(f.tab), true); // the leader's t: an option takes the focus
  await answerAll();
  assert.equal(f.calls.length - before, 1, 'one read for one entry, every answer resolved');
  assert.ok(f.pane.querySelector('.agent-questions').contains(f.pane.ownerDocument.activeElement), 'the focus stays in the zone');
  f.boards.sync(f.tab, f.row(), null, 'w'); await answerAll();
  assert.equal(f.calls.length - before, 1, 'an unchanged poll adds none');
});

test('r2: the same question\'s options keep their nodes and focus across repaints', t => {
  const f = fixture(t);
  f.view.update(boardData(board()));
  const first = f.zone().querySelector('.agent-q-option'); first.focus();
  f.view.update(boardData(board()), { claims: [] }); f.view.detail({ state: 'ok', facts: new Map(), questions: new Map() });
  assert.equal(f.zone().querySelector('.agent-q-option'), first, 'the same node');
  assert.equal(f.doc.activeElement, first);
});

test('r2: the budget keeps the terminal its room: the facts give way to one, then the zone drops its hint', t => {
  const dom = new JSDOM('<!doctype html><body><div class="tab-pane active"><div class="term-wrap"></div></div></body>');
  t.after(() => dom.window.close());
  const pane = dom.window.document.querySelector('.tab-pane');
  let room = 1000, perFact = 20, zoneHeight = 100;
  const measure = { room: () => room,
    used: () => pane.querySelectorAll('.agent-fact').length * perFact + (pane.classList.contains('agent-tight') ? zoneHeight - 20 : zoneHeight) };
  let resized = null;
  const view = createAgentBoard({ pane, home: '/h', name: 'dev-a', now: () => NOW, type: () => true, focusTerminal: () => {}, openLink: () => {},
    hidden: createHiddenFacts(memoryStorage()), measure, observe: (_, fn) => { resized = fn; return () => {}; } });
  view.update(boardData({ facts: ['a', 'b', 'c', 'd'].map(k => fact(k)), questions: [question('q1')] }));
  assert.equal(pane.querySelectorAll('.agent-fact').length, 3, 'room enough: three facts');
  room = 130; resized();
  assert.equal(pane.querySelectorAll('.agent-fact').length, 1, 'a short pane: one fact');
  assert.equal(pane.querySelector('.agent-facts-fold').textContent, '3 more', 'the rest stay one press away');
  assert.equal(pane.classList.contains('agent-tight'), false);
  room = 95; resized();
  assert.equal(pane.classList.contains('agent-tight'), true, 'shorter still: the zone drops its hint');
  room = 1000; resized();
  assert.equal(pane.querySelectorAll('.agent-fact').length, 3, 'room again: back to three');
  assert.equal(pane.classList.contains('agent-tight'), false);
  room = 130; resized();
  pane.querySelector('.agent-facts-fold').click();
  assert.equal(pane.querySelectorAll('.agent-fact').length, 4, 'the person may still unfold them all');
});

// Round 3's findings, each pinned.
test('r3: an open context gives up the rest of the room, so what the board takes ends within it', t => {
  const dom = new JSDOM('<!doctype html><body><div class="tab-pane active"><div class="term-wrap"></div></div></body>');
  t.after(() => dom.window.close());
  const pane = dom.window.document.querySelector('.tab-pane');
  const contextPx = () => { const el = pane.querySelector('.agent-q-context[open] .agent-q-context-text'); if (!el) return 0; const cap = Number.parseFloat(el.style.maxHeight); return Number.isFinite(cap) ? Math.min(cap, 400) : 400; };
  const used = () => 60 + (pane.classList.contains('agent-tight') ? 120 : 140) + contextPx();
  const room = 300;
  const view = createAgentBoard({ pane, home: '/h', name: 'dev-a', now: () => NOW, type: () => true, focusTerminal: () => {}, openLink: () => {},
    hidden: createHiddenFacts(memoryStorage()), measure: { room: () => room, used, height: () => contextPx() }, observe: () => () => {} });
  view.update(boardData({ facts: [fact('a')], questions: [question('q1', { hasContext: true })] }));
  view.detail({ state: 'ok', facts: new Map(), questions: new Map([['q1', { context: 'line\n'.repeat(300), since: AT }]]) });
  const fold = pane.querySelector('.agent-q-context');
  fold.open = true; fold.dispatchEvent(new dom.window.Event('toggle'));
  assert.ok(used() <= room, `used ${used()} within ${room}`);
  assert.equal(contextPx(), room - 60 - 120);
});

test('r3: a terminal the board squeezed off screen takes no answer', t => {
  const dom = new JSDOM('<!doctype html><body><div class="tab-pane active"><div class="term-wrap"></div></div></body>');
  t.after(() => dom.window.close());
  const typed = []; let terminalPx = 0;
  const view = createAgentBoard({ pane: dom.window.document.querySelector('.tab-pane'), home: '/h', name: 'dev-a', now: () => NOW,
    type: text => { typed.push(text); return true; }, focusTerminal: () => {}, openLink: () => {}, hidden: createHiddenFacts(memoryStorage()),
    measure: { room: () => null, terminal: () => terminalPx }, observe: () => () => {} });
  view.update(boardData(board()));
  dom.window.document.querySelector('.agent-q-option').click();
  assert.deepEqual(typed, [], '0 px of terminal: nothing typed');
  terminalPx = 200;
  dom.window.document.querySelector('.agent-q-option').click();
  assert.deepEqual(typed, ['q1: Yes, one clean commit']);
});

test('r3: an id cleared and asked again shows its own context, read afresh, never the earlier question\'s', async t => {
  const f = tabsFixture(t, { events: false });
  const asked = (text, since) => boardData({ facts: [], questions: [question('q1', { question: text, since, hasContext: true })] });
  f.boards.sync(f.tab, f.row({ board: asked('Deploy version one?', '2026-11-19T10:00:00.000Z') }), null, 'w');
  f.pending[0].resolve({ instance: { board: { facts: [], questions: [{ id: 'q1', since: '2026-11-19T10:00:00.000Z', context: 'Version one passed all tests.' }] } } });
  await f.flush(); await f.flush();
  const fold = () => f.pane.querySelector('.agent-q-context-body').textContent;
  assert.match(fold(), /Version one passed/);
  f.boards.sync(f.tab, f.row({ board: asked('Delete production data?', '2026-11-19T11:00:00.000Z') }), null, 'w');
  assert.equal(f.calls.filter(c => c.path.startsWith('/api/capabilities')).length, 2, 'a new occurrence reads the detail again');
  assert.doesNotMatch(fold(), /Version one passed/, 'the earlier context is not shown');
  assert.match(fold(), /Reading the context/);
  f.pending[1].resolve({ instance: { board: { facts: [], questions: [{ id: 'q1', since: '2026-11-19T11:00:00.000Z', context: 'This deletes everything.' }] } } });
  await f.flush(); await f.flush();
  assert.match(fold(), /This deletes everything/);
});

// Round 4's findings, each pinned.
test('r4: overlapping board reads, through the real boundary and cache, never answer for an earlier occurrence', async t => {
  const { createInspectBoundary } = await import('../../client/inspect-boundary.mjs');
  const { createInspectCache } = await import('../../client/inspect-cache.mjs');
  const home = '/w/agents/dev/instances/dev-a';
  const flights = [];
  const invoke = () => new Promise(resolve => flights.push(resolve));
  const cache = createInspectCache();
  const context = { workspace: { id: 'w', scope: '/w' }, cli: { ok: true, operationsApi: 2, bin: '/bin/oats', features: [BOARD_FEATURE] },
    instances: [{ instance: 'dev-a', home, createdAt: '2026-11-19T09:00:00.000Z' }], localCwd: '/w' };
  const post = (path, body) => path.startsWith('/api/capabilities') ? createInspectBoundary({ invoke, cache }).inspect(body, context) : new Promise(() => {});
  const dom = new JSDOM('<!doctype html><body><div class="tab-pane active"><div class="term-wrap"></div></div></body>');
  t.after(() => dom.window.close());
  const pane = dom.window.document.querySelector('.tab-pane');
  const boards = createTabBoards({ features: () => [BOARD_FEATURE], post, openLink: () => {}, hidden: createHiddenFacts(memoryStorage()), now: () => NOW });
  const tab = { paneEl: pane, typeText: () => true, focusTerminal: () => {}, inView: () => true };
  const asked = (text, since) => ({ instance: 'dev-a', agent: 'dev', agentsRoot: '/w/agents', home, running: true,
    board: boardData({ facts: [], questions: [question('q1', { question: text, since, hasContext: true })] }) });
  const answer = (since, ctx) => ({ schemaVersion: 1, ok: true, result: { operationsApi: 2, instance: { board: { facts: [], questions: [{ ...question('q1', { since, hasContext: true }), context: ctx }] } } } });
  boards.sync(tab, asked('Deploy version one?', '2026-11-19T10:00:00.000Z'), null, 'w');
  await new Promise(r => setTimeout(r, 0));
  boards.sync(tab, asked('Delete production data?', '2026-11-19T11:00:00.000Z'), null, 'w');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(flights.length, 2, 'the second read is a CLI read of its own, never the first flight joined');
  flights[0](answer('2026-11-19T10:00:00.000Z', 'Version one passed all tests.'));
  await new Promise(r => setTimeout(r, 0));
  const fold = () => pane.querySelector('.agent-q-context-body').textContent;
  assert.doesNotMatch(fold(), /Version one/);
  flights[1](answer('2026-11-19T11:00:00.000Z', 'This deletes everything.'));
  await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
  assert.match(fold(), /This deletes everything/);
});

test('r4: an answer whose question is another occurrence of the id is not shown as this one\'s context', t => {
  const f = fixture(t);
  f.view.update(boardData({ facts: [], questions: [question('q1', { since: '2026-11-19T11:00:00.000Z', hasContext: true })] }));
  f.view.detail({ state: 'ok', facts: new Map(), questions: new Map([['q1', { context: 'Old context.', since: '2026-11-19T10:00:00.000Z' }]]) });
  assert.doesNotMatch(f.zone().querySelector('.agent-q-context-body').textContent, /Old context/);
  assert.match(f.zone().querySelector('.agent-q-context-body').textContent, /Reading the context/);
});

test('r4: an unchanged repaint keeps the focus on the control that had it', t => {
  const f = fixture(t);
  f.view.update(boardData(board()));
  f.facts().querySelector('li[data-key="pr"] .agent-fact-link').click();
  assert.equal(f.doc.activeElement.className, 'agent-fact-url-open');
  f.view.update(boardData(board()));
  assert.equal(f.doc.activeElement.className, 'agent-fact-url-open', 'Open keeps it');
  for (const part of ['agent-fact-link', 'agent-fact-hide']) {
    f.facts().querySelector(`li[data-key="pr"] .${part}`).focus();
    f.view.update(boardData(board())); f.view.detail({ state: 'ok', facts: new Map(), questions: new Map() });
    assert.equal(f.doc.activeElement.className, part, `${part} keeps it`);
    assert.equal(f.doc.activeElement.closest('li').dataset.key, 'pr');
  }
});

// The live check's finding (S2-D finish): a focus in the pane selects its tab, which reads the roster and syncs the
// board again; a repaint that replaced the focused fact control and focused its new copy made that a loop.
test('agent view facts: an unchanged repaint keeps the nodes, so a focus that repaints is no loop and a press lands', t => {
  const f = fixture(t);
  f.view.update(boardData(board()));
  // The shell's part, as selection-ownership and activateTab do it: a focus in the pane syncs the board again.
  let focuses = 0, shell = true;
  f.pane.addEventListener('focusin', () => { if (shell && ++focuses < 20) f.view.update(boardData(board()), { claims: [] }); });
  for (const part of ['agent-fact-focus', 'agent-fact-link', 'agent-fact-hide']) {
    focuses = 0;
    const el = f.facts().querySelector(`li[data-key="pr"] .${part}`);
    el.focus();
    assert.equal(focuses, 1, `${part}: one focus, no loop`);
    assert.equal(f.facts().querySelector(`li[data-key="pr"] .${part}`), el, `${part}: the same node`);
    assert.equal(f.doc.activeElement, el);
  }
  // The address's Open: the same address keeps its button and the focus on it.
  f.facts().querySelector('li[data-key="pr"] .agent-fact-link').click();
  const open = f.facts().querySelector('.agent-fact-url-open');
  f.terminal.focus(); focuses = 0; open.focus();
  assert.equal(focuses, 1, 'Open: one focus, no loop');
  assert.equal(f.facts().querySelector('.agent-fact-url-open'), open);
  // A press: a poll's repaint between the press and its release leaves the button in place, so the click lands.
  const hide = f.facts().querySelector('li[data-key="score"] .agent-fact-hide');
  f.view.update(boardData(board()));
  assert.ok(hide.isConnected);
  hide.click();
  assert.deepEqual([...f.facts().querySelectorAll('.agent-fact')].map(li => li.dataset.key), ['pr']);
  // What a fact shows changed: the list is rebuilt, and the focus goes back to the same fact's same control.
  shell = false;
  const body = f.facts().querySelector('li[data-key="pr"] .agent-fact-focus'); body.focus();
  f.view.update(boardData({ ...board(), facts: [board().facts[0], fact('pr', { label: 'PR', value: '#1991', link: 'https://github.com/oats-project/oats/pull/1990' })] }));
  const now = f.facts().querySelector('li[data-key="pr"] .agent-fact-focus');
  assert.notEqual(now, body, 'a new node');
  assert.match(now.textContent, /#1991/);
  assert.equal(f.doc.activeElement, now);
});

// The fix's delta reader: the budget lays the strip out full and then compact on every repaint, so a compact strip
// must keep its rows too, under refreshes that answer later (as the roster read does) and under a resize.
test('agent view facts: a compact strip keeps its row through the budget\'s repaints: no loop, and a press lands', async t => {
  const dom = new JSDOM('<!doctype html><body><div class="tab-pane active"><div class="term-wrap"></div></div></body>');
  t.after(() => dom.window.close());
  const doc = dom.window.document, pane = doc.querySelector('.tab-pane');
  const measure = { room: () => 130, used: () => pane.querySelectorAll('.agent-fact').length * 20 + 100 };
  let resized = null;
  const view = createAgentBoard({ pane, home: '/h', name: 'dev-a', now: () => NOW, type: () => true, focusTerminal: () => {}, openLink: () => {},
    hidden: createHiddenFacts(memoryStorage()), measure, observe: (_, fn) => { resized = fn; return () => {}; } });
  const data = boardData({ facts: ['a', 'b', 'c'].map(k => fact(k)), questions: [] });
  view.update(data);
  assert.equal(pane.querySelectorAll('.agent-fact').length, 1, 'compact: one fact');
  let focuses = 0;
  pane.addEventListener('focusin', () => { if (++focuses < 20) queueMicrotask(() => view.update(data, { claims: [] })); });
  const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  const body = pane.querySelector('li[data-key="a"] .agent-fact-focus');
  body.focus(); await settle();
  assert.equal(focuses, 1, 'one focus, no loop');
  assert.ok(body.isConnected, 'the same row');
  assert.equal(doc.activeElement, body);
  resized(); await settle();
  assert.equal(focuses, 1, 'a resize\'s fit keeps it too');
  assert.equal(doc.activeElement, body);
  const hide = pane.querySelector('li[data-key="a"] .agent-fact-hide');
  view.update(data); resized();
  assert.ok(hide.isConnected, 'a repaint and a resize between press and release leave the button in place');
  hide.click(); await settle();
  assert.deepEqual([...pane.querySelectorAll('.agent-fact')].map(li => li.dataset.key), ['b'], 'the press hid it');
});

// The round-4 delta's finding: the occurrence check fails closed.
test('r4 delta: an answer that does not prove its question\'s since (absent, null, not a time) shows no context', t => {
  for (const since of [undefined, null, 'invalid']) {
    const f = fixture(t);
    f.view.update(boardData({ facts: [], questions: [question('q1', { question: 'Delete production data?', since: '2026-11-19T11:00:00.000Z', hasContext: true })] }));
    const asked = { id: 'q1', context: 'Version one passed all tests.', ...(since === undefined ? {} : { since }) };
    f.view.detail({ ...boardDetailData({ instance: { board: { facts: [], questions: [asked] } } }), occurrences: new Set(['q1@2026-11-19T11:00:00.000Z']) });
    const body = f.zone().querySelector('.agent-q-context-body').textContent;
    assert.doesNotMatch(body, /Version one/, `since ${String(since)}`);
    assert.match(body, /Reading the context/, `since ${String(since)}`);
  }
});

test('r4 delta 2: on one view, the fold\'s words follow each answer: no context, then unproven, then proven', t => {
  const f = fixture(t);
  f.view.update(boardData({ facts: [], questions: [question('q1', { hasContext: true })] }));
  const read = q1 => f.view.detail(boardDetailData({ instance: { board: { facts: [], questions: [{ id: 'q1', ...q1 }] } } }));
  const fold = () => f.zone().querySelector('.agent-q-context-body').textContent;
  read({ since: AT, context: null });
  assert.match(fold(), /sent no context/);
  read({ context: 'Unproven context' });
  assert.match(fold(), /Reading the context/); assert.doesNotMatch(fold(), /Unproven/);
  read({ since: AT, context: 'Proven.' });
  assert.match(fold(), /Proven\./);
  read({ since: AT, context: null });
  assert.match(fold(), /sent no context/);
});
