// #517: "Add a machine to this workspace…" — the fields (Name's default; Folder empty and required, #1390), the CLI's steps as rows
// (every status), "Check again", the messaging phase only when it applies, success, failure and focus.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { openAddMachineDialog } from '../renderer/add-machine-dialog.mjs';

const WS = 'ws:0123456789abcdef0123', DEPLOYMENT = '/Users/alex/Agents/aweb';
const GIT = { step: 'git', status: 'needs-human', code: 'E_REMOTE_UNREADABLE', detail: 'devbox cannot read github.com/example/ac over https',
  remedy: 'On devbox run `gh auth login`, then `gh auth setup-git`, then Check again.', hint: 'keychain-non-interactive' };
const PENDING = [{ step: 'ssh', status: 'ok' }, { step: 'oats', status: 'done', detail: 'installed @awebai/oats 0.39.0 (was missing)' }, GIT,
  { step: 'deployment', status: 'skipped', detail: 'waits for git' }, { step: 'register', status: 'skipped' }, { step: 'readiness', status: 'skipped' }];
const READY = [{ step: 'ssh', status: 'ok' }, { step: 'oats', status: 'ok' }, { step: 'git', status: 'ok' }, { step: 'deployment', status: 'done' },
  { step: 'register', status: 'done' }, { step: 'readiness', status: 'ok' }];
const AWEB_READY = [{ step: 'aw', status: 'done', detail: 'installed aw 1.36.23' }, { step: 'invite', status: 'done' },
  { step: 'join', status: 'done', detail: 'root /Users/alex/Agents/aweb/.aweb-roots/aweb' }, { step: 'readiness', status: 'ok' }];
const connect = (steps, ready) => ({ schemaVersion: 1, ok: true, result: { id: 'devbox-aweb', ready, registration: { sshHost: 'devbox' }, steps, human: [] } });
const aweb = (steps, ready) => ({ schemaVersion: 1, ok: true, result: { server: 'devbox-aweb', team: { label: 'aweb', team: 'aweb:alex.aweb.ai' }, ready, steps } });

function setup(t, { answers = [], awebOn = true } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><button id="opener">Add</button></body></html>', { pretendToBeVisual: true });
  const doc = dom.window.document, calls = [], copied = [], added = [];
  Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async text => { copied.push(text); } } });
  const queue = [...answers];
  const ctx = { api: async (path, opts) => {
    calls.push({ path, body: JSON.parse(opts.body) });
    const next = queue.shift();
    if (typeof next === 'function') return next();
    return { ok: true, status: 200, json: async () => next };
  } };
  const opener = doc.getElementById('opener'); opener.focus();
  const ui = openAddMachineDialog(doc, { ctx, ws: WS, deployment: DEPLOYMENT, aweb: awebOn, onAdded: id => added.push(id) });
  t.after(() => { ui.close(); dom.window.close(); });
  const q = s => doc.querySelector(s), qa = s => [...doc.querySelectorAll(s)];
  const type = (input, value) => { input.value = value; input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  /** The two fields a run needs: the Machine, and the Folder (which starts empty). */
  const fill = (machine, folder = '~/aweb') => { type(doc.querySelector('.machine-host'), machine); type(doc.querySelector('.machine-folder'), folder); };
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
  return { dom, doc, ui, calls, copied, added, opener, q, qa, type, fill, settle, queue };
}
const rows = (u, phase) => u.qa(`[data-phase="${phase}"] .machine-step`).map(r => [r.dataset.step, r.dataset.status, r.querySelector('.machine-step-state').textContent]);

test('opens as a modal on the Machine field; Name follows the host until edited; Folder starts empty with its hint; Install OATS is on', t => {
  const u = setup(t);
  const dialog = u.q('.machine-dialog');
  assert.equal(dialog.getAttribute('role'), 'dialog'); assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.equal(dialog.getAttribute('aria-labelledby'), u.q('.machine-dialog h2').id);
  assert.equal(u.q('.machine-dialog h2').textContent, 'Add a machine to this workspace');
  assert.equal(u.doc.activeElement, u.q('.machine-host'));
  assert.equal(u.q('.machine-name').value, ''); assert.equal(u.q('.machine-folder').value, '', 'no folder is suggested');
  assert.equal(u.q('.machine-folder').placeholder, 'A path on that machine, starting with / or ~/');
  assert.equal(u.q('.machine-install').checked, true);
  u.type(u.q('.machine-host'), 'devbox');
  assert.equal(u.q('.machine-name').value, 'devbox-aweb');
  u.type(u.q('.machine-name'), 'devbox-ac');
  u.type(u.q('.machine-host'), 'laptop');
  assert.equal(u.q('.machine-name').value, 'devbox-ac', 'an edited Name is the operator\'s');
  assert.equal(u.q('.machine-primary').textContent, 'Add machine');
  assert.equal(u.qa('input[type=password]').length, 0, 'never asks for a secret');
});

test('a field the kernel would refuse is said beside it, focused, and nothing runs', async t => {
  const u = setup(t);
  u.type(u.q('.machine-host'), 'alex@devbox');
  u.q('.machine-primary').click(); await u.settle();
  assert.equal(u.calls.length, 0);
  assert.equal(u.doc.activeElement, u.q('.machine-host'));
  assert.equal(u.q('.machine-host').getAttribute('aria-invalid'), 'true');
  const problem = u.q('.machine-problem');
  assert.match(problem.textContent, /ssh host alias/); assert.equal(u.q('.machine-host').getAttribute('aria-describedby'), problem.id);
});

test('Folder is required: Connect with it empty says so beside it, focuses it, and runs nothing', async t => {
  const u = setup(t);
  u.type(u.q('.machine-host'), 'devbox');
  u.q('.machine-primary').click(); await u.settle();
  assert.deepEqual(u.calls, []);
  const folder = u.q('.machine-folder'), problem = u.q('.machine-problem');
  assert.equal(u.doc.activeElement, folder);
  assert.equal(folder.getAttribute('aria-invalid'), 'true'); assert.equal(folder.getAttribute('aria-describedby'), problem.id);
  assert.equal(problem.textContent, 'The folder is a path on that machine, starting with / or ~/.');
  assert.equal(u.q('.machine-primary').textContent, 'Add machine', 'nothing ran');
  u.type(folder, '   ');
  u.q('.machine-primary').click(); await u.settle();
  assert.deepEqual(u.calls, [], 'blank is empty');
});

test('connect: each step a row with its status in words; detail and remedy as the CLI wrote them; a copy button per command; no messaging step before register', async t => {
  const u = setup(t, { answers: [connect(PENDING, false)] });
  u.fill('devbox');
  u.q('.machine-primary').click(); await u.settle();
  assert.deepEqual(u.calls, [{ path: `/api/server-connect?ws=${encodeURIComponent(WS)}`, body: { phase: 'connect', id: 'devbox-aweb', host: 'devbox', folder: '~/aweb', installOats: true } }]);
  assert.deepEqual(rows(u, 'connect'), [['ssh', 'ok', 'ok'], ['oats', 'done', 'done'], ['git', 'needs-human', 'needs you'],
    ['deployment', 'skipped', 'waiting'], ['register', 'skipped', 'waiting'], ['readiness', 'skipped', 'waiting']]);
  const git = u.q('[data-phase="connect"] [data-step="git"]');
  assert.equal(git.querySelector('.machine-step-detail').textContent, GIT.detail);
  assert.equal(git.querySelector('.machine-step-remedy').textContent, GIT.remedy);
  const copies = [...git.querySelectorAll('button.machine-copy')];
  assert.deepEqual(copies.map(b => b.getAttribute('aria-label')), ['Copy gh auth login', 'Copy gh auth setup-git']);
  copies[1].click(); await u.settle();
  assert.deepEqual(u.copied, ['gh auth setup-git']);
  assert.equal(u.q('[data-phase="aweb"]'), null, 'connect did not reach register: no messaging step');
  assert.equal(u.q('.machine-primary').textContent, 'Check again');
  assert.equal(u.q('.machine-dialog').isConnected, true, 'stays open while a step needs you');
  assert.match(u.q('.machine-status').textContent, /Some steps need you/);
  assert.deepEqual(u.added, []);
});

test('Check again re-runs connect, then the messaging step; both ready closes the dialog and hands back the new machine', async t => {
  const u = setup(t, { answers: [connect(PENDING, false), connect(READY, true), aweb(AWEB_READY, true)] });
  u.fill('devbox');
  u.q('.machine-primary').click(); await u.settle();
  u.q('.machine-primary').click(); await u.settle();
  assert.deepEqual(u.calls.map(c => c.body.phase), ['connect', 'connect', 'aweb']);
  assert.deepEqual(u.calls[1].body, u.calls[0].body, 'the same idempotent command');
  assert.deepEqual(u.calls[2], { path: `/api/server-connect?ws=${encodeURIComponent(WS)}`, body: { phase: 'aweb', id: 'devbox-aweb' } });
  assert.equal(u.q('.machine-dialog'), null, 'closed on success');
  assert.deepEqual(u.added, ['devbox-aweb']);
});

test('messaging not ready: the dialog stays with both phases\' rows; Check again runs both again', async t => {
  const notReady = [{ step: 'aw', status: 'ok' }, { step: 'invite', status: 'failed', code: 'E_INVITE', detail: 'the team refused the invite' }];
  const u = setup(t, { answers: [connect(READY, true), aweb(notReady, false), connect(READY, true), aweb(AWEB_READY, true)] });
  u.fill('devbox');
  u.q('.machine-primary').click(); await u.settle();
  assert.deepEqual(rows(u, 'aweb'), [['aw', 'ok', 'ok'], ['invite', 'failed', 'failed']]);
  assert.equal(u.q('[data-phase="aweb"] [data-step="invite"] .machine-step-code').textContent, 'E_INVITE');
  assert.equal(u.q('[data-phase="connect"] [data-step="register"]').dataset.status, 'done');
  assert.equal(u.q('.machine-dialog').isConnected, true);
  u.q('.machine-primary').click(); await u.settle();
  assert.deepEqual(u.calls.map(c => c.body.phase), ['connect', 'aweb', 'connect', 'aweb']);
  assert.deepEqual(u.added, ['devbox-aweb']);
});

test('without oats.aweb messaging: connect ready closes it; the messaging step never runs', async t => {
  const u = setup(t, { awebOn: false, answers: [connect(READY, true)] });
  u.fill('devbox');
  u.q('.machine-primary').click(); await u.settle();
  assert.deepEqual(u.calls.map(c => c.body.phase), ['connect']);
  assert.deepEqual(u.added, ['devbox-aweb']);
});

test('a failed connect: the steps so far, the failed step with its code, the CLI\'s message', async t => {
  const failed = { schemaVersion: 1, ok: false, error: { code: 'E_INSTALL', message: 'oats could not be installed on devbox',
    details: { steps: [{ step: 'ssh', status: 'ok' }, { step: 'oats', status: 'failed', code: 'E_INSTALL', detail: 'npm exited 1' }] } } };
  const u = setup(t, { answers: [failed] });
  u.fill('devbox');
  u.q('.machine-primary').click(); await u.settle();
  assert.deepEqual(rows(u, 'connect'), [['ssh', 'ok', 'ok'], ['oats', 'failed', 'failed']]);
  assert.equal(u.q('[data-step="oats"] .machine-step-detail').textContent, 'npm exited 1');
  assert.match(u.q('.machine-status').textContent, /oats could not be installed on devbox/);
  assert.equal(u.q('.machine-primary').textContent, 'Check again');
});

test('a refusal from the Desktop (busy, another workspace…) is said, and the form is usable again', async t => {
  const busy = () => ({ ok: false, status: 409, json: async () => ({ error: 'devbox-aweb is already being connected', code: 'E_BUSY' }) });
  const u = setup(t, { answers: [busy] });
  u.fill('devbox');
  u.q('.machine-primary').click(); await u.settle();
  assert.match(u.q('.machine-status').textContent, /already being connected/);
  assert.equal(u.q('.machine-primary').disabled, false); assert.equal(u.q('.machine-host').disabled, false);
});

test('while it runs: the fields and the action are locked, focus waits on the status, and a spinner says which phase', async t => {
  let release;
  const held = () => new Promise(r => { release = () => r({ ok: true, status: 200, json: async () => connect(READY, true) }); });
  const u = setup(t, { awebOn: false, answers: [held] });
  u.fill('devbox');
  u.q('.machine-primary').click(); await u.settle();
  assert.equal(u.q('.machine-primary').disabled, true);
  for (const f of ['.machine-host', '.machine-name', '.machine-folder', '.machine-install']) assert.equal(u.q(f).disabled, true, f);
  assert.equal(u.doc.activeElement, u.q('.machine-status'));
  assert.equal(u.q('.machine-status').getAttribute('aria-busy'), 'true');
  assert.ok(u.q('[data-phase="connect"] .spinner'), 'a spinner on the running phase');
  assert.match(u.q('.machine-status').textContent, /Connecting devbox-aweb/);
  u.q('.machine-primary').click(); await u.settle();
  assert.equal(u.calls.length, 1, 'a second press while it runs does nothing');
  release(); await u.settle();
  assert.deepEqual(u.added, ['devbox-aweb']);
});

test('closed while it runs: the late answer changes nothing', async t => {
  let release;
  const held = () => new Promise(r => { release = () => r({ ok: true, status: 200, json: async () => connect(READY, true) }); });
  const u = setup(t, { awebOn: false, answers: [held] });
  u.fill('devbox');
  u.q('.machine-primary').click(); await u.settle();
  u.q('.machine-cancel').click();
  assert.equal(u.q('.machine-dialog'), null);
  release(); await u.settle();
  assert.deepEqual(u.added, [], 'no success handed back after close');
});

test('Escape closes and focus returns to the opener; Tab stays inside the dialog', async t => {
  const u = setup(t);
  const dialog = u.q('.machine-dialog');
  const focusables = [...dialog.querySelectorAll('input,button')].filter(e => !e.disabled);
  focusables.at(-1).focus();
  focusables.at(-1).dispatchEvent(new u.dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  assert.equal(u.doc.activeElement, focusables[0]);
  focusables[0].dispatchEvent(new u.dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
  assert.equal(u.doc.activeElement, focusables.at(-1));
  const escape = new u.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  u.q('.machine-host').dispatchEvent(escape);
  assert.equal(u.q('.machine-dialog'), null);
  assert.equal(u.doc.activeElement, u.opener);
});
