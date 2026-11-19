// The agent's mail sheet (S2-M3; renderer/mail-sheet.mjs, packages/client/mail-contract.mjs): the contract's answer
// decoded strictly, what the sheet shows of it, and what it never does: no call but `messaging:mail`, no read but on
// open, Refresh and Older mail (never a poll), nothing painted by an answer it no longer owns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { mailAnswer, mailArgs, mailBodyLines, MAIL_OPERATION } from '../../client/mail-contract.mjs';
import { createMailSheet, MAIL_WORDS, mailSheetCSS } from '../renderer/mail-sheet.mjs';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/mail-read/mail-v2.json', import.meta.url), 'utf8'));
const fixture = (edit = () => {}) => { const run = structuredClone(FIXTURE); edit(run.result.mail, run); return run; };
const row = { instance: 'dev-1', home: '/w/agents/dev/instances/dev-1' };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const refusal = (code, message = 'refused') => Object.assign(new Error(message), { code, answered: message });

function rig(t, { answer = () => fixture(), cli = () => ({ remote: ['operations'] }), heldBack = () => null } = {}) {
  const dom = new JSDOM('<!doctype html><body><main id="main"><button id="opener" type="button">Open</button></main></body>', { pretendToBeVisual: true });
  const doc = dom.window.document;
  const style = doc.createElement('style'); style.textContent = mailSheetCSS; doc.head.append(style);
  const calls = [];
  let gen = 0; const listeners = new Set();
  const sheet = createMailSheet({ doc, generation: () => gen, cli, heldBack, now: () => Date.parse('2026-11-19T21:00:00Z'),
    subscribeWorkspace: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    request: (workspace, body) => { calls.push({ workspace, body: structuredClone(body) }); return answer(body, calls.length); } });
  t.after(() => { sheet.dispose(); dom.window.close(); });
  doc.getElementById('opener').focus();
  const key = (k, fields = {}, target = doc.activeElement) => { const e = new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...fields }); target.dispatchEvent(e); return e; };
  return { dom, doc, sheet, calls, key, one: s => doc.querySelector(s), all: s => [...doc.querySelectorAll(s)],
    changeWorkspace() { gen++; for (const fn of listeners) fn(); } };
}

test('the contract answer decodes; a closed shape refuses anything else, an acknowledging answer above all', () => {
  const decoded = mailAnswer(FIXTURE);
  assert.ok(decoded);
  assert.deepEqual(decoded.messages.map(m => m.id), ['m-3', 'm-2', 'm-1'], 'newest first, as the provider merged them');
  assert.deepEqual([...decoded.partial], ['c-2']);
  assert.equal(decoded.nextCursor, 'cursor-after-m-1');
  for (const [why, edit] of [
    ['acknowledges', d => { d.acknowledges = true; }],
    ['another mailApi', d => { d.mailApi = 2; }],
    ['an unknown key', d => { d.unread = 3; }],
    ['an unknown message key', d => { d.messages[0].labels = []; }],
    ['a verification outside the set', d => { d.messages[0].verification = 'trusted'; }],
    ['a direction outside the set', d => { d.messages[0].direction = 'forwarded'; }],
    ['a body past 16 KiB', d => { d.messages[0].body = 'é'.repeat(8193); }],
    ['more past 200 messages', d => { d.messages = Array.from({ length: 201 }, (_, i) => ({ ...d.messages[0], id: `x-${i}` })); }],
    ['more without a cursor', d => { d.nextCursor = null; }],
    ['a message twice', d => { d.messages[1] = { ...d.messages[1], id: 'm-3', team: 'default' }; }],
    ['an identity error not a string', d => { d.identities[1].error = 3; }], ['an empty message id', d => { d.messages[0].id = ''; }],
    ['a partial outside the set', d => { d.conversations[1].partial = 'newest-only'; }],
  ]) assert.equal(mailAnswer(fixture(edit)), null, why);
  assert.equal(mailAnswer(fixture((d, run) => { run.operation = 'messaging:teams'; })), null, 'another operation');
  assert.equal(mailAnswer(fixture((d, run) => { run.result.extra = 1; })), null, 'a result with another field');
  // A body at the bound exactly is the contract's: 16 KiB of UTF-8, a two-byte character at a time.
  assert.ok(mailAnswer(fixture(d => { d.messages[0].body = 'é'.repeat(8192); d.messages[0].truncated = true; })));
});

test('a body is plain text: its line breaks kept, tabs as spaces, controls and bidi overrides replaced, never dropped', () => {
  assert.deepEqual(mailBodyLines('one\r\ntwo\rthree\tx\u202Eevil\u0007\n\n'), ['one', 'two', 'three    x\uFFFDevil\uFFFD']);
  assert.deepEqual(mailArgs(), { limit: '50' });
  assert.deepEqual(mailArgs({ cursor: 'c', limit: 900 }), { limit: '200', cursor: 'c' });
});

test('opening reads messaging:mail once, and only it: received and sent, the team, the attributed quote and every note', async t => {
  const u = rig(t);
  assert.equal(u.sheet.open(row, 'ws-1'), true);
  assert.equal(u.one('.mail-sheet-status').textContent, MAIL_WORDS.reading);
  await settle();
  assert.deepEqual(u.calls, [{ workspace: 'ws-1', body: { action: 'run', selector: { home: row.home }, operation: MAIL_OPERATION, args: { limit: '50' } } }]);
  const dialog = u.one('.mail-sheet');
  assert.equal(dialog.getAttribute('role'), 'dialog'); assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.equal(u.doc.getElementById(dialog.getAttribute('aria-labelledby')).textContent, 'dev-1 · mail');
  assert.equal(u.doc.getElementById(dialog.getAttribute('aria-describedby')).textContent, MAIL_WORDS.lead);
  const items = u.all('.mail-item');
  assert.deepEqual(items.map(li => li.querySelector('.mail-item-who').textContent),
    ['From sheet-reviewer · default', 'To view-dev · product', 'From view-dev · product'], 'two identities: each labelled by its team');
  assert.deepEqual(items.map(li => li.querySelector('.mail-item-subject').textContent), ['Round 1: two findings', 'Where the sheet mounts', 'Mount'],
    'an empty subject reads as its thread');
  assert.deepEqual(items.map(li => li.querySelector('.mail-item-lead').textContent), ['sheet-reviewer wrote:', 'dev-1 wrote:', 'view-dev wrote:'],
    'every body attributed to its sender');
  assert.equal(items[0].querySelector('.mail-item-text').textContent, 'Line one of the review.\nLine two, with a tab    here.');
  assert.deepEqual([...items[0].querySelectorAll('.mail-item-marks li')].map(li => li.textContent), [MAIL_WORDS.encrypted, MAIL_WORDS.unread, MAIL_WORDS.high]);
  assert.deepEqual([...items[2].querySelectorAll('.mail-item-marks li')].map(li => li.textContent), [MAIL_WORDS.unverified]);
  assert.equal(items[1].querySelector('.mail-item-marks'), null, 'a read, verified, normal message carries no mark');
  // The bounds' notes: the shortened body, and the partial conversation said once, on its newest message shown.
  assert.deepEqual(items.map(li => [...li.querySelectorAll('.mail-item-note')].map(n => n.textContent)),
    [[], [MAIL_WORDS.partial], [MAIL_WORDS.truncated]]);
  assert.equal(MAIL_WORDS.partial, "Older part of a long conversation shown; the newest messages can't be read yet.");
  assert.equal(items[0].querySelector('.mail-item-time').textContent, '2 min ago');
  assert.equal(items[0].querySelector('.mail-item-time').title, '2026-11-19T20:58:00Z');
  // Provider text is text, never markup.
  assert.equal(u.all('.mail-sheet a, .mail-sheet img, .mail-sheet script').length, 0);
  assert.equal(u.one('.mail-sheet-more').hidden, false, 'hasMore: Older mail');
});

test('one identity: no team label; nothing at all: the empty line; one identity unreadable: said, the rest shown', async t => {
  const one = rig(t, { answer: () => fixture(d => { d.identities = [d.identities[0]]; d.messages = [d.messages[0]]; d.conversations = []; d.hasMore = false; d.nextCursor = null; }) });
  one.sheet.open(row, 'ws-1'); await settle();
  assert.equal(one.one('.mail-item-who').textContent, 'From sheet-reviewer');
  assert.equal(one.one('.mail-sheet-more').hidden, true);
  const none = rig(t, { answer: () => fixture(d => { d.messages = []; d.conversations = []; d.hasMore = false; d.nextCursor = null; }) });
  none.sheet.open(row, 'ws-1'); await settle();
  assert.equal(none.one('.mail-sheet-empty').hidden, false); assert.equal(none.one('.mail-sheet-empty').textContent, MAIL_WORDS.empty);
  assert.equal(none.one('.mail-list').hidden, true);
  const part = rig(t, { answer: () => fixture(d => { d.identities[1].error = 'no-mail-read'; d.messages = [d.messages[0]]; }) });
  part.sheet.open(row, 'ws-1'); await settle();
  const problem = part.one('[data-mail-identity="product"]');
  assert.equal(problem.textContent, "Mail from product can't be read: no-mail-read — it may not read mail (no mail.read grant, or the server refused)");
  const other = rig(t, { answer: () => fixture(d => { d.identities[1].error = 'some-new-slug'; }) });
  other.sheet.open(row, 'ws-1'); await settle();
  assert.equal(other.one('[data-mail-identity="product"]').textContent, "Mail from product can't be read: some-new-slug", 'an unknown error as given');
  assert.equal(part.all('.mail-item').length, 1);
});

test('too old, no messaging, an old aw, an unreadable answer: each says so, and nothing else is asked', async t => {
  const tooOld = rig(t, { answer: () => Promise.reject(refusal('E_OPERATION_UNKNOWN', 'unknown operation messaging:mail')) });
  tooOld.sheet.open(row, 'ws-1'); await settle();
  const said = tooOld.one('.mail-sheet-problem > p');
  assert.equal(said.textContent, "This agent's messaging is too old to show mail; stop it and upgrade it (oats instance upgrade), or start a new agent of its soul.");
  assert.equal(said.querySelector('code').textContent, 'oats instance upgrade');
  assert.equal(tooOld.all('.mail-item').length, 0); assert.equal(tooOld.calls.length, 1);
  // Hidden by its attribute against the sheet's own display rules (the live check found Older mail drawn here).
  for (const sel of ['.mail-sheet-more', '.mail-list', '.mail-sheet-empty']) {
    assert.equal(tooOld.dom.window.getComputedStyle(tooOld.one(sel)).display, 'none', `${sel} is not drawn`);
  }
  const none = rig(t, { answer: () => Promise.reject(refusal('E_OPERATION_UNAVAILABLE')) });
  none.sheet.open(row, 'ws-1'); await settle();
  assert.equal(none.one('.mail-sheet-problem > p').textContent, MAIL_WORDS.noMessaging);
  const aw = rig(t, { answer: () => Promise.reject(refusal('E_AW_TOO_OLD', 'aw 1.36.53 or later is needed; found 1.36.40')) });
  aw.sheet.open(row, 'ws-1'); await settle();
  assert.equal(aw.one('.mail-sheet-problem > p').textContent, "This computer's aw is too old to read mail: aw 1.36.53 or later is needed; found 1.36.40");
  assert.equal(aw.one('.mail-sheet-problem pre').textContent, 'E_AW_TOO_OLD');
  const none2 = rig(t, { answer: () => Promise.reject(refusal('E_MAIL_UNREADABLE', 'no identity could be read')) });
  none2.sheet.open(row, 'ws-1'); await settle();
  assert.equal(none2.one('.mail-sheet-problem > p').textContent, MAIL_WORDS.noIdentity);
  const odd = rig(t, { answer: () => fixture(d => { d.acknowledges = true; }) });
  odd.sheet.open(row, 'ws-1'); await settle();
  assert.equal(odd.one('.mail-sheet-problem > p').textContent, MAIL_WORDS.unreadable);
  assert.equal(odd.all('.mail-item').length, 0, 'an acknowledging answer shows no mail');
  const held = rig(t, { heldBack: () => 'This OATS is newer than this Desktop has been tested with.' });
  held.sheet.open(row, 'ws-1'); await settle();
  assert.equal(held.calls.length, 0, 'held back: nothing sent');
  assert.equal(held.one('.mail-sheet-problem > p').textContent, 'This OATS is newer than this Desktop has been tested with.');
  const remote = rig(t, { cli: () => ({ remote: [] }) });
  remote.sheet.open({ ...row, server: 'devbox', addressable: true }, 'ws-1'); await settle();
  assert.equal(remote.calls.length, 0, "a remote row this computer can't route: nothing sent");
  const old = rig(t, { answer: () => Promise.reject(Object.assign(refusal('E_REMOTE_INCOMPATIBLE'), { reason: { code: 'E_REMOTE_INCOMPATIBLE', message: 'devbox runs an OATS that can\'t do this yet.' } })) });
  old.sheet.open({ ...row, server: 'devbox', addressable: true }, 'ws-1'); await settle();
  assert.equal(old.calls.length, 1, 'a routable remote row is read through its server');
  assert.equal(old.one('.mail-sheet-problem > p').textContent, "The OATS on devbox is too old to read this agent's mail.");
});

test('no poll: it reads on open, on Refresh (r or the button) and on Older mail, with the cursor, and at no other time', async t => {
  const u = rig(t);
  u.sheet.open(row, 'ws-1'); await settle();
  for (let i = 0; i < 5; i++) await settle();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(u.calls.length, 1, 'no read without a press');
  u.key('r', {}, u.one('.mail-item-toggle')); await settle();
  assert.equal(u.calls.length, 2); assert.deepEqual(u.calls[1].body.args, { limit: '50' }, 'Refresh reads the first page again');
  u.one('[data-mail-action="refresh"]').click(); await settle();
  assert.equal(u.calls.length, 3);
  u.one('.mail-sheet-more').click(); await settle();
  assert.equal(u.calls.length, 4); assert.deepEqual(u.calls[3].body.args, { limit: '50', cursor: 'cursor-after-m-1' });
  assert.ok(u.calls.every(c => c.body.action === 'run' && c.body.operation === MAIL_OPERATION), 'never any operation but messaging:mail');
  // The sheet holds no timer and the shell opens it from a press only: a source check, since a poll would be a timer or a call from the refresh loop.
  const source = readFileSync(new URL('../renderer/mail-sheet.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /setTimeout|setInterval|requestAnimationFrame/);
  assert.deepEqual([...source.matchAll(/operation: ([A-Z_a-z'":]+)/g)].map(m => m[1]), ['MAIL_OPERATION']);
  const shell = readFileSync(new URL('../renderer/shell.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...shell.matchAll(/mailSheet\.open\(/g)].length, 1);
  assert.match(shell.match(/^function openInstanceMail\([^]*?\n\}/m)[0], /mailSheet\.open\(instance, rowDeployment\(instance\)\)/);
});

test('Older mail appends the next page, without the same message twice; partial conversations accumulate', async t => {
  const u = rig(t, { answer: (body) => body.args.cursor ? fixture(d => {
    d.messages = [d.messages[2], { ...d.messages[2], id: 'm-0', conversationId: 'c-3', createdAt: '2026-11-19T17:00:00Z' }];
    d.conversations = [{ id: 'c-3', partial: 'oldest-first-only' }]; d.hasMore = false; d.nextCursor = null;
  }) : fixture() });
  u.sheet.open(row, 'ws-1'); await settle();
  u.one('.mail-sheet-more').click();
  assert.equal(u.one('.mail-sheet-more').textContent, MAIL_WORDS.readingOlder);
  await settle();
  assert.deepEqual(u.all('.mail-item').map(li => JSON.parse(li.dataset.mailKey)[1]), ['m-3', 'm-2', 'm-1', 'm-0']);
  assert.equal(u.all('[data-mail-partial]').length, 2);
  assert.equal(u.one('.mail-sheet-more').hidden, true);
});

test('latest intent: an answer for a closed sheet, a superseded read or another workspace paints nothing, resolved or rejected', async t => {
  const pending = [];
  const u = rig(t, { answer: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
  u.sheet.open(row, 'ws-1');
  u.sheet.close(); pending[0].resolve(fixture()); await settle();
  assert.equal(u.one('.mail-sheet'), null);
  u.sheet.open(row, 'ws-1');
  u.key('r', {}, u.one('.mail-sheet [data-mail-action="close"]')); // refresh refused while reading: one read in flight
  assert.equal(pending.length, 2);
  u.sheet.open({ ...row, instance: 'dev-2', home: '/w/agents/dev/instances/dev-2' }, 'ws-1');
  pending[1].reject(refusal('E_OPERATION_UNKNOWN')); await settle();
  assert.equal(u.one('.mail-sheet-problem'), null, "the first agent's refusal is not the second's");
  pending[2].resolve(fixture()); await settle();
  assert.equal(u.all('.mail-item').length, 3);
  u.one('[data-mail-action="refresh"]').click();
  u.changeWorkspace();
  assert.equal(u.one('.mail-sheet'), null, 'a workspace change closes it');
  pending[3].resolve(fixture()); await settle();
  assert.equal(u.one('.mail-sheet'), null);
});

test('keys: ↑/↓ move between messages, a press on its head expands one, Tab stays inside, Esc closes and focus goes back', async t => {
  const u = rig(t);
  const opener = u.doc.getElementById('opener');
  u.sheet.open(row, 'ws-1'); await settle();
  assert.equal(u.doc.activeElement, u.one('[data-mail-action="close"]'));
  const toggles = () => u.all('.mail-item-toggle');
  assert.deepEqual(toggles().map(b => b.tabIndex), [0, -1, -1], 'one tab stop in the list');
  toggles()[0].focus();
  u.key('ArrowDown'); assert.equal(u.doc.activeElement, toggles()[1]);
  u.key('End'); assert.equal(u.doc.activeElement, toggles()[2]);
  u.key('ArrowDown'); assert.equal(u.doc.activeElement, toggles()[2], 'no wrap past the last');
  u.key('Home'); assert.equal(u.doc.activeElement, toggles()[0]);
  assert.deepEqual(toggles().map(b => b.tabIndex), [0, -1, -1]);
  toggles()[0].click();
  assert.equal(toggles()[0].getAttribute('aria-expanded'), 'true'); assert.ok(u.one('.mail-item').classList.contains('is-open'));
  assert.equal(u.doc.getElementById(toggles()[0].getAttribute('aria-controls')).classList.contains('mail-item-quote'), true);
  // A refresh keeps what was open and where focus was.
  u.key('r'); await settle();
  assert.equal(toggles()[0].getAttribute('aria-expanded'), 'true'); assert.equal(u.doc.activeElement, toggles()[0]);
  // Tab cycles: Refresh, Close, the list's stop, Details, Older mail, then Refresh again.
  const order = [];
  for (let i = 0; i < 6; i++) { u.key('Tab'); order.push(u.doc.activeElement.dataset.mailAction ?? u.doc.activeElement.className); }
  assert.deepEqual(order, ['older', 'refresh', 'close', 'mail-item-toggle', 'older', 'refresh']);
  u.key('Escape');
  assert.equal(u.one('.mail-sheet'), null); assert.equal(u.doc.activeElement, opener);
  assert.equal(u.sheet.isOpen(), false);
});

test('the scrim closes it; a press on the sheet does not', async t => {
  const u = rig(t);
  u.sheet.open(row, 'ws-1'); await settle();
  u.one('.mail-sheet').dispatchEvent(new u.dom.window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(u.sheet.isOpen(), true);
  u.one('.mail-sheet-overlay').dispatchEvent(new u.dom.window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(u.sheet.isOpen(), false);
});

test("Details: Messaging & Teams carries Mail, which hands the panel's agent to the host; no host, no button", async t => {
  const { createContextPanel } = await import('../renderer/context-panel.mjs');
  const make = openMail => {
    const dom = new JSDOM('<!doctype html><body><aside id="context-panel"></aside></body>');
    const document = dom.window.document, hosts = [];
    const panel = createContextPanel({ document, root: document.getElementById('context-panel'), openMail,
      createTeamsSection: (host, { onPresence, tools }) => { hosts.push({ host, onPresence, tools }); return { update() {}, dispose() {} }; } });
    t.after(() => { panel.dispose(); dom.window.close(); });
    return { document, panel, hosts };
  };
  const asked = [];
  const u = make(ref => asked.push(ref));
  const agent = { instance: 'dev-1', agent: 'dev', agentsRoot: '/w/agents', home: row.home, running: true };
  u.panel.setContext({ workspace: 'ws-1', instance: agent, key: agent.home });
  u.hosts[0].onPresence(true);
  const mail = u.hosts[0].tools.querySelector('button.context-panel-mail');
  assert.equal(mail.textContent, 'Mail'); assert.equal(mail.dataset.action, 'instance.mail');
  assert.equal(mail.closest('[data-context-section="teams"]').hidden, false);
  mail.click();
  assert.deepEqual(asked.map(a => [a.workspace, a.instance.home]), [['ws-1', row.home]]);
  u.hosts[0].onPresence(false);
  assert.equal(mail.closest('[data-context-section="teams"]').hidden, true, 'no messaging provider: no section, no Mail');
  const none = make(undefined);
  assert.equal(none.hosts[0].tools.querySelector('button.context-panel-mail'), null);
});

test("a captured provider answer (oats.aweb's branch, a real read; texts replaced) decodes as the kernel relays it", () => {
  const provider = JSON.parse(readFileSync(new URL('./fixtures/mail-read/provider-real-redacted.json', import.meta.url), 'utf8'));
  assert.equal(provider.ok, true);
  const decoded = mailAnswer({ operationsApi: 2, operation: MAIL_OPERATION, capability: 'oats.aweb', result: provider.result });
  assert.ok(decoded, 'the real shape is the contract');
  assert.ok(decoded.messages.some(m => m.direction === 'sent') && decoded.messages.some(m => m.direction === 'received'));
});

test('a captured kernel run (oats 0.69.20 running the provider branch; texts replaced) decodes whole', () => {
  const envelope = JSON.parse(readFileSync(new URL('./fixtures/mail-read/kernel-real-redacted.json', import.meta.url), 'utf8'));
  assert.equal(envelope.ok, true);
  const decoded = mailAnswer(envelope.result);
  assert.ok(decoded); assert.equal(decoded.messages.length, 1); assert.equal(decoded.identities[0].error, null);
});

test('the contract bounds bodies and pages, not metadata: a long subject, alias, title, id or cursor is shown cut, never refused', async t => {
  const long = 'x'.repeat(5000);
  const edit = d => { Object.assign(d.messages[0], { subject: long, threadTitle: long, id: long, conversationId: long }); d.messages[0].from.alias = `a${long}`;
    d.identities[1].team = 'product'; d.identities.push({ team: `t${long}`, alias: 'dev-1', identity: long, primary: false, error: `e${long}` }); d.nextCursor = `c${long}`; };
  assert.ok(mailAnswer(fixture(edit)), 'decodes');
  const u = rig(t, { answer: () => fixture(edit) });
  u.sheet.open(row, 'ws-1'); await settle();
  const subject = u.one('.mail-item-subject').textContent;
  assert.equal(subject.length, 513); assert.ok(subject.endsWith('…'));
  assert.equal(u.one('.mail-item-lead').textContent.length, 513 + ' wrote:'.length);
  assert.equal(u.all('.mail-item').length, 3, 'every other message still shown');
  assert.equal(u.one('.mail-sheet-more').hidden, true, "a cursor that can't travel as an argument offers no Older mail");
  assert.ok(u.one(`[data-mail-identity^="t"]`).textContent.length < 1200, "an identity's unknown error is shown cut");
});

test('verification: only verified carries no mark; unverified and unknown say Unverified sender; failed says Signature failed', async () => {
  const { mailMarks } = await import('../renderer/mail-sheet.mjs');
  const base = { ...FIXTURE.result.mail.messages[1] };
  assert.deepEqual(['verified', 'unverified', 'unknown', 'failed'].map(verification => mailMarks({ ...base, verification }).map(m => m.text)),
    [[], [MAIL_WORDS.unverified], [MAIL_WORDS.unverified], [MAIL_WORDS.signatureFailed]]);
});

test("refreshing from an error's Details keeps focus in the sheet, pending, failed again and read; Esc closes it from there", async t => {
  const pending = [];
  const u = rig(t, { answer: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
  u.sheet.open(row, 'ws-1');
  pending[0].reject(refusal('E_NETWORK', 'network down')); await settle();
  const summary = u.one('.mail-sheet-problem summary'); summary.focus();
  u.key('Tab', { shiftKey: true }); u.key('Tab');
  assert.equal(u.doc.activeElement, summary, 'Details is a tab stop');
  u.key('r');
  assert.ok(u.one('.mail-sheet').contains(u.doc.activeElement), 'pending: in the sheet');
  assert.equal(u.doc.activeElement.dataset.mailAction, 'close', 'Refresh is disabled while reading: Close holds focus');
  pending[1].reject(refusal('E_NETWORK', 'network down')); await settle();
  assert.ok(u.one('.mail-sheet').contains(u.doc.activeElement), 'failed again: in the sheet');
  u.one('.mail-sheet-problem summary').focus(); u.key('r');
  pending[2].resolve(fixture()); await settle();
  assert.ok(u.one('.mail-sheet').contains(u.doc.activeElement), 'read: in the sheet');
  u.key('Escape'); assert.equal(u.sheet.isOpen(), false);
});

test('focus that left the sheet anyway: Esc still closes it, Tab brings focus back, other keys pass', async t => {
  const u = rig(t);
  u.sheet.open(row, 'ws-1'); await settle();
  u.doc.activeElement.blur(); assert.equal(u.doc.activeElement, u.doc.body);
  assert.equal(u.key('x', {}, u.doc.body).defaultPrevented, false);
  u.key('Tab', {}, u.doc.body); assert.ok(u.one('.mail-sheet').contains(u.doc.activeElement));
  u.doc.activeElement.blur();
  assert.equal(u.key('Escape', {}, u.doc.body).defaultPrevented, true); assert.equal(u.sheet.isOpen(), false);
  assert.equal(u.key('Escape', {}, u.doc.body).defaultPrevented, false, 'closed: the listener is gone');
});

test('modal: a real shortcut that focuses the roster behind the scrim (Alt+F) leaves focus in the sheet; a dialog over it closes it', async t => {
  const { registerAction, handleKeydown, setActiveContexts } = await import('../renderer/keybindings.mjs');
  const u = rig(t);
  const roster = u.doc.createElement('button'); roster.className = 'ctx-inst'; roster.textContent = 'dev-1'; u.doc.getElementById('main').append(roster);
  const off = registerAction({ id: 'sidebar.focusFilter', label: 'Focus the roster', context: 'global', run: () => roster.focus() });
  t.after(off); setActiveContexts(['global']);
  u.sheet.open(row, 'ws-1'); await settle();
  const toggles = () => u.all('.mail-item-toggle');
  toggles()[1].focus();
  const altF = new u.dom.window.KeyboardEvent('keydown', { key: 'f', code: 'KeyF', altKey: true, bubbles: true, cancelable: true });
  assert.equal(handleKeydown(altF, { isMac: false }), true, 'the shortcut ran');
  assert.equal(u.doc.activeElement, toggles()[1], 'focus came back to where it was in the sheet');
  u.key('ArrowDown'); assert.equal(u.doc.activeElement, toggles()[2], 'the next key acts in the sheet');
  // Another modal taking focus: the sheet yields.
  const dialog = u.doc.createElement('section'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
  const ok = u.doc.createElement('button'); dialog.append(ok); u.doc.body.append(dialog);
  ok.focus();
  assert.equal(u.sheet.isOpen(), false); assert.equal(u.doc.activeElement, ok);
});
