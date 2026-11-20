// The instance panel's Needs input line and status note (slice 1 of the Desktop UI rework): the facts the roster's
// hover card held, now that it is gone. The claim's words and how long it has waited, computed at each paint (the
// roster's poll), the message as text, a withheld note never shown; the row's runtime error said with its speaker.
// The shipped panel (context-panel.mjs) in a DOM, no shell.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createContextPanel, contextPanelCSS } from '../renderer/context-panel.mjs';
import { waitingClaim, waitingClock } from '../../client/waiting-on-you.mjs';
import { SPEAKERS, MARKUP, CONTROL, DETAIL_WITHHELD, shown } from './helpers/speaker-cases.mjs';

const SINCE = '2026-10-03T09:00:00.000Z';
const claim = (extra = {}) => ({ since: SINCE, producer: 'claude-hooks', reason: 'permission', message: null, ...extra });
const row = (extra = {}) => ({ instance: 'dev-a', agent: 'dev', home: '/synthetic/dev-a', agentsRoot: '/synthetic/agents', harness: 'claude', running: true, ...extra });

function fixture(t) {
  const dom = new JSDOM('<!doctype html><body><aside id="context-panel"></aside></body>');
  const document = dom.window.document, root = document.getElementById('context-panel');
  const style = document.createElement('style'); style.textContent = contextPanelCSS; document.head.append(style);
  const panel = createContextPanel({ document, root });
  const select = (instance, { stale = false } = {}) => panel.setContext({ workspace: 'A', instance, key: instance.home, waiting: waitingClaim(instance, { stale }) });
  const section = () => root.querySelector('[data-context-section="waiting"]');
  const head = () => section().querySelector('.context-panel-waiting-head').textContent;
  const message = () => section().querySelector('.context-panel-waiting-message');
  const status = () => root.querySelector('[data-context-status-note]');
  t.after(() => { panel.dispose(); dom.window.close(); });
  return { document, root, select, section, head, message, status };
}

test('the panel says the reason, the message and the age, computed at each paint', t => {
  const u = fixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(SINCE) + 3 * 3600e3 + 59 * 60e3 });
  u.select(row({ waitingOnYou: claim({ message: 'Allow Bash(rm -rf build)?' }) }));
  assert.equal(u.section().hidden, false);
  assert.equal(u.section().querySelector('.context-panel-label').textContent, 'Needs input');
  assert.equal(u.head(), `Waiting for a tool approval · waiting 3 h (since ${waitingClock(SINCE)})`);
  assert.equal(u.message().textContent, 'Allow Bash(rm -rf build)?');
  assert.equal(u.section().querySelector('svg.attn-mark')?.getAttribute('aria-hidden'), 'true', 'the mark is decoration; the words say it');
  u.select(row({ waitingOnYou: claim({ reason: 'approval' }) }));
  assert.equal(u.head(), `Needs input · waiting 3 h (since ${waitingClock(SINCE)})`, 'an unknown reason is never shown raw');
  assert.equal(u.message().hidden, true, 'no message, no line');
  // The next paint (a poll) reads the clock again: never frozen at the first.
  t.mock.timers.setTime(Date.parse(SINCE) + 2 * 86400e3 + 5);
  u.select(row({ waitingOnYou: claim({ message: 'Allow Bash(rm -rf build)?' }) }));
  assert.match(u.head(), /· waiting 2 d \(since Oct \d{1,2}, \d\d:\d\d\)$/, 'two days later the start carries its date (#559)');
});

test('no claim, a stopped row or a stale one: no Needs input line', t => {
  const u = fixture(t);
  u.select(row());
  assert.equal(u.section().hidden, true);
  u.select(row({ running: false, waitingOnYou: claim() }));
  assert.equal(u.section().hidden, true, 'a claim on a row that is not running is no claim (waitingClaim)');
  u.select(row({ waitingOnYou: claim() }), { stale: true });
  assert.equal(u.section().hidden, true, 'a held-stale row carries none');
});

const WITHHELD = [['See https://github.com/awebai/oats/pull/552', 'attention', 'Asked for your attention'],
  ['Which token: A or B?', 'question', 'Asked you a question'], ['api key: rotate now?', 'approval', 'Needs input']];

test('a withheld note: the reason in words and no message line, never “[withheld]” (#584)', t => {
  const u = fixture(t);
  for (const [message, reason, label] of WITHHELD) {
    u.select(row({ waitingOnYou: claim({ message, reason }) }));
    assert.match(u.head(), new RegExp(`^${label} · waiting `), message);
    assert.equal(u.message().hidden, true);
    assert.doesNotMatch(u.section().textContent, /withheld/i);
  }
});

test('the message is text: markup is shown literally, never parsed', t => {
  const u = fixture(t);
  u.select(row({ waitingOnYou: claim({ message: MARKUP }) }));
  assert.equal(u.message().textContent, MARKUP);
  assert.equal(u.section().querySelector('b, script'), null, 'no element created from the message');
});

test("the row's runtime error: said with who made it, as text, in the Session card", t => {
  const u = fixture(t);
  const text = 'the session did not answer';
  for (const [origin, line] of shown(text)) {
    u.select(row({ running: false, runtimeError: text, ...(origin ? { runtimeErrorOrigin: origin } : {}) }));
    assert.equal(u.status().hidden, false, String(origin));
    assert.equal(u.status().textContent, line, String(origin));
    assert.ok(u.status().closest('.context-panel-session'));
  }
  u.select(row({ running: false, runtimeErrorOrigin: 'kernel' }));
  assert.equal(u.status().hidden, true, 'a mark beside no text shows nothing');
  u.select(row({ running: false, runtimeError: CONTROL, runtimeErrorOrigin: 'terminal-probe' }));
  assert.equal(u.status().textContent, DETAIL_WITHHELD, 'an unsafe text is withheld, under no speaker\'s name');
  u.select(row({ running: false, runtimeError: MARKUP, runtimeErrorOrigin: 'terminal-probe' }));
  assert.equal(u.status().textContent, `${SPEAKERS['terminal-probe']} ${MARKUP}`);
  assert.equal(u.status().querySelector('b, script'), null, 'no element created from the text');
  u.select(row());
  assert.equal(u.status().hidden, true);
});
