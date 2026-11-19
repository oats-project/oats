// The known Claude dialog-reporting gap (known-dialog-reporting-gaps-use-home-provenance): the instance panel's Session
// note says it, beside a live claim's Needs input facts, each clearing for its own reason. Slice 1 of the Desktop UI
// rework removed the roster's hover card, which said it too; the panel is where it stays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createContextPanel, contextPanelCSS } from '../renderer/context-panel.mjs';
import { waitingClaim } from '../../client/waiting-on-you.mjs';

const row = (version = '1.5.9', extra = {}) => ({
  instance: 'test-agent', agent: 'dev', home: '/synthetic/agent', harness: 'claude', running: true,
  modules: [{ name: 'oats.core', from: { kind: 'package', package: 'oats.framework', version } }], ...extra,
});
const note = version => `This agent's Claude questions and permission requests don't show as needs input: its oats.core (oats.framework ${version}) is older than 2.4.0. Upgrade or respawn it to report them.`;

function fixture(t) {
  const dom = new JSDOM('<!doctype html><body><button id="row">test-agent</button><aside id="context-panel"></aside></body>');
  const document = dom.window.document, root = document.getElementById('context-panel');
  const style = document.createElement('style'); style.textContent = contextPanelCSS; document.head.append(style);
  const panel = createContextPanel({ document, root }), trigger = document.getElementById('row');
  // As the shell selects it (syncContextPanel): the row, and its claim through the sidebar's gate.
  const select = instance => panel.setContext({ workspace: 'test', instance, key: instance.home, waiting: waitingClaim(instance) });
  const waiting = () => root.querySelector('[data-context-section="waiting"]');
  t.after(() => { panel.dispose(); dom.window.close(); });
  return { document, root, trigger, select, waiting };
}

test('the Session note says the exact words, in DOM text associated with its card; the row is unchanged', t => {
  const u = fixture(t);
  for (const version of ['1.5.9', '1.6.0-rc.1', '1.5.9+build.01']) {
    u.select(row(version));
    const message = u.root.querySelector('.context-panel-session-note');
    assert.equal(message.hidden, false);
    assert.equal(message.textContent, note(version));
    assert.equal(message.childElementCount, 0, 'the recorded version is inserted as text');
    assert.equal(message.previousElementSibling.className, 'context-panel-session-lines', 'under the session lines');
    assert.ok(message.closest('.context-panel-session'));
    assert.ok(message.classList.contains('context-panel-note'), 'uses the existing muted note token');
    assert.equal(u.trigger.textContent, 'test-agent', 'row label is unchanged');
    assert.equal(u.document.querySelector('.ctx-attn, .needs-input-mark, .ctx-tip'), null, 'no claim pill, and no hover card');
  }
});

test('the explanation clears on upgrade or selection and stays absent without the exact evidence', t => {
  const u = fixture(t);
  for (const next of [row('1.6.0'), row('1.6.0+build'), row('1.5.9', { harness: 'pi' }),
    row('1.5.9', { modules: null }), row('1.5.9', { modules: undefined }), row('<img src=x>'),
    row('1.5.9', { modules: { 'oats.core': { from: { kind: 'member', version: '1.5.9' } } } }),
  ]) {
    u.select(row());
    assert.equal(u.root.querySelector('.context-panel-session-note').hidden, false);
    u.select(next);
    const message = u.root.querySelector('.context-panel-session-note');
    assert.equal(message.hidden, true);
    assert.equal(message.textContent, '', 'no stale or malformed version remains in the DOM');
  }
});

test('a live attention claim and the Claude dialog reporting explanation coexist independently', t => {
  const u = fixture(t);
  const waitingOnYou = { since: '2026-10-01T12:00:00.000Z', producer: 'agent', reason: 'attention', message: 'Please choose the next step.' };
  u.select(row('1.5.9', { waitingOnYou }));
  assert.equal(u.waiting().hidden, false);
  assert.match(u.waiting().querySelector('.context-panel-waiting-head').textContent, /^Asked for your attention · waiting /);
  assert.equal(u.waiting().querySelector('.context-panel-waiting-message').textContent, waitingOnYou.message);
  assert.equal(u.root.querySelector('.context-panel-session-note').hidden, false);
  assert.equal(u.root.querySelector('.context-panel-session-note').textContent, note('1.5.9'));

  u.select(row('1.6.0', { waitingOnYou }));
  assert.equal(u.root.querySelector('.context-panel-session-note').hidden, true, 'upgrading clears only the dialog explanation');
  assert.equal(u.waiting().hidden, false, 'the live claim stays visible');

  u.select(row('1.5.9', { waitingOnYou: null }));
  assert.equal(u.waiting().hidden, true, 'clearing a claim does not suppress the standing explanation');
  assert.equal(u.root.querySelector('.context-panel-session-note').hidden, false);
});
