// #855: the context panel's lifecycle row and the roster row's context menu offer the same acts, enabled the same
// way, because both draw them from packages/client/instance-acts.mjs. The panel and the menu are built here for one
// row at a time and read as plain data. (The overview popover, the third, went with the Machines canvas: the Graph's
// Enter and Open terminal open a row through the roster's own activation, graph-slice6b.test.mjs.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createContextPanel, contextPanelCSS } from '../renderer/context-panel.mjs';
import { instanceActions } from '../renderer/instance-actions.mjs';
import { reasonLine } from '../renderer/speaker-line.mjs';
import { instanceActs, openAct } from '../../client/instance-acts.mjs';
import { ROWS as MENU_ROWS, RETIRE_INTERRUPTED } from './helpers/instance-menu-probe.mjs';

const HERDR = 'E_HERDR_REMOVED: Herdr is no longer supported by OATS (removed in 0.31.0); tmux is the only session backend.';
const local = (name, extra = {}) => ({ instance: name, agent: 'dev', agentsRoot: '/team/agents', home: `/team/agents/dev/instances/${name}`, harness: 'pi', ...extra });
const remote = (name, extra = {}) => ({ instance: name, agent: 'dev', agentsRoot: '/remote/agents', home: `/remote/agents/dev/instances/${name}`,
  server: 'host', repoName: 'Build box', harness: 'claude', ...extra });

/** The spec's rows (#855), each with what the panel offers: [verb, enabled] in the panel's order. */
const ROWS = {
  running: [local('running', { running: true }), [['restart', true], ['stop', true], ['retire', true]]],
  stopped: [local('stopped', { running: false }), [['start', true], ['stop', true], ['retire', true]]],
  'state unknown': [local('unknown', { running: null }), [['stop', true], ['retire', true]]],
  'held: spawning': [local('spawning', { running: false, spawnInProgress: true }), []],
  'held: spawn incomplete': [local('rollback', { running: false, rollbackIncomplete: true }), [['retire', true]]],
  'held: retire incomplete': [local('interrupted', { running: true, retire: RETIRE_INTERRUPTED }), [['retire', true]]],
  'unsupported session (Herdr)': [local('herdr', { running: null, runtimeState: 'unsupported', runtimeError: HERDR }), [['start', false], ['stop', true], ['retire', true]]],
  'server not reached': [remote('unreached', { serverUnreached: true, running: null, addressable: true, savedRoute: true, missingRemotely: false,
    runtimeError: 'ssh: connect to host timed out' }), [['stop', true], ['retire', true]]],
  'not addressable': [remote('unrouted', { addressable: false, running: true }), []],
  'not addressable (gone from the server)': [remote('gone', { addressable: false, savedRoute: true, missingRemotely: true, running: null }), []],
};
const VERBS = ['restart', 'start', 'stop', 'retire'];

function panelFixture(t) {
  const dom = new JSDOM('<!doctype html><body><div id="app"><aside id="context-panel"></aside></div></body>');
  const document = dom.window.document, style = document.createElement('style'); style.textContent = contextPanelCSS; document.head.append(style);
  const calls = [], lifecycle = Object.fromEntries(VERBS.map(op => [op, instance => calls.push(`${op} ${instance.instance}`)]));
  const panel = createContextPanel({ document, root: document.getElementById('context-panel'), lifecycle });
  t.after(() => { panel.dispose(); dom.window.close(); });
  const control = op => document.querySelector(`[data-lifecycle="${op}"]`);
  return {
    document, calls, control,
    /** What the panel's lifecycle row offers for `row`: [verb, enabled], in its order. */
    offer(row) {
      panel.setContext({ workspace: 'A', instance: row, key: row.home });
      return VERBS.filter(op => !control(op).hidden).map(op => [op, !control(op).disabled]);
    },
  };
}

/** What the roster row's context menu offers for `row` (no shell items in front): [verb, enabled], `inspect` left out;
 * and what it says, if anything, when its row asks for it (a key's contextmenu: Shift+F10, the Menu key). */
function menuOffer(row) {
  const dom = new JSDOM('<body></body>'), doc = dom.window.document, said = [];
  const button = doc.createElement('button'); button.className = 'ctx-inst';
  const menu = instanceActions(doc, row, { row: button, say: line => said.push(line), scope: 'ws', owner: () => true, invoke: async () => ({}), openLifecycle: () => {} });
  doc.body.append(button, menu);
  menu.showPopover = menu.hidePopover = () => {}; // jsdom has no top layer; only what the menu says is read here
  const items = [...menu.querySelectorAll('[role="menuitem"]')].filter(item => item.dataset.action !== 'inspect');
  button.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  const answer = { offer: items.map(item => [item.dataset.action, !item.disabled]), said };
  dom.window.close();
  return answer;
}

const sharedOffer = row => instanceActs(row).acts.filter(act => act.verb !== 'inspect').map(act => [act.verb, act.enabled]);

test('#855: for each row the context panel offers the acts the roster menu offers, enabled the same way, and the ones the spec names', t => {
  const u = panelFixture(t);
  for (const [name, [row, expected]] of Object.entries(ROWS)) {
    const panel = u.offer(row);
    assert.deepEqual(panel, expected, `${name}: the panel`);
    assert.deepEqual(menuOffer(row).offer, panel, `${name}: the roster menu offers what the panel does`);
    assert.deepEqual(sharedOffer(row), panel, `${name}: and both are instanceActs' answer`);
  }
});

test("#855: the panel agrees with the roster menu on every row of the menu's own probe table", t => {
  const u = panelFixture(t);
  for (const [name, row] of Object.entries(MENU_ROWS)) {
    const panel = u.offer(row);
    assert.deepEqual(menuOffer(row).offer, panel, name);
    assert.deepEqual(sharedOffer(row), panel, `${name}: instanceActs`);
  }
});

test('#855: Stop on a stopped row and on one whose state is unknown opens the plan-backed Stop, as the menu does', t => {
  const u = panelFixture(t);
  for (const row of [ROWS.stopped[0], ROWS['state unknown'][0], ROWS['server not reached'][0]]) {
    u.offer(row); u.control('stop').click();
  }
  assert.deepEqual(u.calls, ['stop stopped', 'stop unknown', 'stop unreached']);
});

test('#855: a row whose server was not reached lists Stop and Retire enabled, and its terminal does not open: its state is unknown', () => {
  const [row] = ROWS['server not reached'];
  const { blocked, limited, acts } = instanceActs(row);
  assert.equal(blocked, null); assert.equal(limited, null);
  assert.deepEqual(acts.filter(act => ['stop', 'retire'].includes(act.verb)).map(({ verb, enabled }) => [verb, enabled]), [['stop', true], ['retire', true]]);
  const open = openAct(row);
  assert.equal(open.enabled, false); assert.equal(open.reason.code, 'state-unknown');
});

test('#855: a herdr row keeps Start visible, disabled, with the kernel reason as its title; the other controls carry no title', t => {
  const u = panelFixture(t);
  u.offer(ROWS['unsupported session (Herdr)'][0]);
  assert.equal(u.control('start').title, HERDR);
  for (const op of ['stop', 'retire']) assert.equal(u.control(op).title, '', op);
});

test('#855: a blocked row (not addressable) offers no lifecycle control in the panel, as the menu offers none, and says why when asked', t => {
  const u = panelFixture(t);
  for (const name of ['not addressable', 'not addressable (gone from the server)']) {
    const [row] = ROWS[name], { blocked } = instanceActs(row);
    assert.equal(blocked?.code, 'unaddressable', name);
    assert.deepEqual(u.offer(row), [], `${name}: no control, not disabled ones`);
    for (const op of VERBS) assert.equal(u.control(op).hidden, true, `${name}: ${op}`);
    const menu = menuOffer(row);
    assert.deepEqual(menu.offer, [], `${name}: the menu has no item`);
    assert.deepEqual(menu.said, [reasonLine(blocked)], `${name}: the roster says why`);
  }
});

test('#855: a blocked row says why in the action row, once: a remote row not reported addressable, a home still spawning; a row gone from its server says it in its Work note alone', t => {
  const u = panelFixture(t), line = () => u.document.querySelector('[data-context-actions-note]'), work = () => u.document.querySelector('[data-context-work-note]');
  for (const name of ['not addressable', 'held: spawning']) {
    const [row] = ROWS[name], { blocked } = instanceActs(row);
    assert.ok(blocked, name);
    assert.deepEqual(u.offer(row), [], name);
    assert.equal(line().hidden, false, name); assert.equal(line().textContent, reasonLine(blocked), name);
    assert.ok(line().textContent, `${name}: a sentence, not an empty line`);
    assert.ok(line().classList.contains('context-panel-note'), `${name}: the panel's muted note`);
  }
  assert.equal(line().textContent, 'spawning is setting up its worktree. It can\'t be used until the spawn finishes.');
  // A row gone from its server: the Work note says it, and the action row says nothing more.
  const [gone] = ROWS['not addressable (gone from the server)'];
  u.offer(gone);
  assert.equal(work().hidden, false); assert.equal(work().textContent, reasonLine(instanceActs(gone).blocked));
  assert.equal(line().hidden, true); assert.equal(line().textContent, '');
  // No row that offers acts carries the line.
  for (const [name, [row]] of Object.entries(ROWS)) {
    if (instanceActs(row).blocked) continue;
    u.offer(row);
    assert.equal(line().hidden, true, name); assert.equal(line().textContent, '', name);
  }
});

// #1247: the rows a retire holds, kept out of ROWS: a retiring row's Retire is secondary (listed in the menu, no
// control here) and its action row says why; a failed retire's reason may carry the kernel's words.
const SINCE = '2026-10-15T00:00:00Z';
const RETIRING = {
  'an older kernel\'s retirePending': local('retiring', { running: true, retirePending: true }),
  'the kernel\'s retire, running': local('retiring', { running: true, retire: { state: 'running', since: SINCE, self: false } }),
  'the kernel\'s retire, unknown': local('retiring', { running: null, retire: { state: 'unknown', since: SINCE, self: true } }),
  'this window\'s retire in flight': local('retiring', { running: true, retireInFlight: true }),
};
const failed = (extra = {}) => local('failed', { running: false, retire: { state: 'failed', since: SINCE, self: true, ...extra } });

test('#1247: a retiring row: no Retire control in the panel (the menu lists it, enabled), and the action row says why', t => {
  const u = panelFixture(t), line = () => u.document.querySelector('[data-context-actions-note]');
  for (const [name, row] of Object.entries(RETIRING)) {
    const { limited, acts } = instanceActs(row);
    assert.deepEqual(acts, [{ verb: 'retire', enabled: true, reason: null, secondary: true }], name);
    assert.deepEqual(u.offer(row), [], `${name}: no control, not a disabled one`);
    for (const op of VERBS) assert.equal(u.control(op).hidden, true, `${name}: ${op}`);
    assert.deepEqual(menuOffer(row).offer, [['retire', true]], `${name}: the menu keeps Retire`);
    assert.equal(line().hidden, false, name); assert.equal(line().textContent, 'retiring is being retired.', name);
    assert.equal(line().textContent, reasonLine(limited), name);
  }
});

test('#1247: a failed retire keeps its Retire in the panel; the kernel\'s message is said in the action row after its words, filtered', t => {
  const u = panelFixture(t), line = () => u.document.querySelector('[data-context-actions-note]');
  for (const row of [failed({ code: 'E_RETIRE_HOOK', message: 'the pre-retire hook exited 1' }), failed({ code: 'E_RETIRE_HOOK' }), failed()]) {
    assert.deepEqual(u.offer(row), [['retire', true]], JSON.stringify(row.retire));
    assert.deepEqual(menuOffer(row).offer, [['retire', true]]);
    assert.equal(u.control('retire').classList.contains('danger'), true, 'the inline Retire, as for a retire that didn\'t finish');
  }
  u.offer(failed({ code: 'E_RETIRE_HOOK', message: 'the pre-retire hook exited 1' }));
  assert.equal(line().hidden, false); assert.equal(line().textContent, 'OATS says: the pre-retire hook exited 1 (E_RETIRE_HOOK)');
  // A control character: withheld whole, alone. Over-long: one display line, cut.
  u.offer(failed({ message: 'wipe \x1b[2J the screen' }));
  assert.equal(line().textContent, '[withheld]');
  u.offer(failed({ message: `${'x'.repeat(5000)} end` }));
  assert.ok(line().textContent.startsWith('OATS says: xxx')); assert.ok(line().textContent.length < 2100, 'bounded');
  assert.doesNotMatch(line().textContent, / end$/);
  // A code alone is the kernel's word too: said after its words.
  u.offer(failed({ code: 'E_RETIRE_HOOK' })); assert.equal(line().hidden, false); assert.equal(line().textContent, 'OATS says: E_RETIRE_HOOK');
  // The shared home's own sentence (nothing recorded): nothing more is said beside the control.
  for (const row of [failed(), local('interrupted', { running: true, retire: RETIRE_INTERRUPTED })]) {
    u.offer(row); assert.equal(line().hidden, true, JSON.stringify(row.retire)); assert.equal(line().textContent, '');
  }
});
