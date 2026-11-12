// #517: the kernel's own JSON (test/fixtures/machines-517, relayed from spec A's fake-host runs) through
// the Desktop's contract, server module and dialog.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { connectOutcome, registerReached, stepCommands, AWEB_STEPS } from '../../client/machine-contract.mjs';
import { createMachines } from '../server/machines.mjs';
import { openAddMachineDialog } from '../renderer/add-machine-dialog.mjs';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/machines-517/${name}.json`, import.meta.url), 'utf8'));
const KEY = fixture('connect-ready').result.registration.workspaceKey;
const CLI = { ok: true, bin: '/oats', features: ['workspace-identity', 'servers-per-workspace', 'server-connect', 'capability-route'] };

test('connect needs-human at git: every row as sent; the remedy has no backticked command, so no copy button; register not reached', () => {
  const out = connectOutcome(fixture('connect-needs-human-git'));
  assert.equal(out.ok, true); assert.equal(out.ready, false); assert.equal(out.id, 'devbox-deployment');
  assert.deepEqual(out.steps, fixture('connect-needs-human-git').result.steps);
  assert.deepEqual(stepCommands(out.steps[2].remedy), []);
  assert.equal(registerReached(out.steps), false);
});

test('connect ready: register done, ready', () => {
  const out = connectOutcome(fixture('connect-ready'));
  assert.equal(out.ready, true); assert.equal(registerReached(out.steps), true);
  assert.deepEqual(out.steps.map(s => s.status), ['ok', 'ok', 'ok', 'done', 'done', 'ok']);
});

test('connect failed: the steps so far from error.details.steps (the step\'s own details object is not a row field), the code and message', () => {
  const raw = fixture('connect-failed-dir-not-empty'), out = connectOutcome(raw);
  assert.equal(out.ok, false);
  assert.deepEqual(out.error, { code: 'E_DIR_NOT_EMPTY', message: raw.error.message });
  assert.deepEqual(out.steps.at(-1), { step: 'deployment', status: 'failed', code: 'E_DIR_NOT_EMPTY', detail: raw.error.details.steps.at(-1).detail });
  assert.equal(out.steps.length, 4);
});

test('server list and check as the kernel answers them: the keyed row is offered, legacy (null) is not and is backfilled', async () => {
  let rows = fixture('server-list').result.servers;
  const checked = [];
  const adapter = {
    cliServers: async () => ({ ...fixture('server-list'), result: { ...fixture('server-list').result, servers: rows } }),
    cliServerCheck: async (bin, id) => { checked.push(id); rows = rows.map(r => r.id === id ? { ...r, workspaceKey: KEY } : r); return fixture('server-check-backfill'); },
  };
  const machines = createMachines({ adapter, cli: () => CLI });
  const scope = { key: KEY, deployment: '/Users/alex/Agents/deployment', messaging: null };
  assert.deepEqual((await machines.forScope(scope)).servers.map(s => s.id), ['devbox-deployment']);
  await machines.backfilled();
  assert.deepEqual(checked, ['legacy']);
  const after = await machines.forScope(scope);
  assert.deepEqual(after.servers.map(s => [s.id, s.label, s.check]), [['devbox-deployment', 'devbox', null], ['legacy', 'legacy', { reachable: true, version: '0.38.0', error: null }]]);
});

test('a check whose workspace cannot be read is not reachable, with the kernel\'s reason', async () => {
  const unreadable = fixture('server-check-backfill');
  unreadable.result.workspaceReadable = false;
  unreadable.result.workspaceReadError = { code: 'E_REMOTE_UNREADABLE', message: 'devbox cannot read the workspace repository', reason: 'not-found' };
  const adapter = { cliServers: async () => fixture('server-list'), cliServerCheck: async () => unreadable };
  const machines = createMachines({ adapter, cli: () => CLI, backfill: false });
  const { check } = await machines.check({ key: KEY, deployment: '/d' }, 'devbox-deployment');
  assert.deepEqual(check, { reachable: false, version: '0.38.0', error: 'devbox cannot read the workspace repository' });
});

test('the dialog over the real answers: the needs-human remedy verbatim, then Check again to ready', async t => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const doc = dom.window.document, added = [];
  const answers = [fixture('connect-needs-human-git'), fixture('connect-ready')];
  const ctx = { api: async () => ({ ok: true, status: 200, json: async () => answers.shift() }) };
  const ui = openAddMachineDialog(doc, { ctx, ws: 'ws:x', deployment: '/Users/alex/Agents/deployment', onAdded: id => added.push(id) });
  t.after(() => { ui.close(); dom.window.close(); });
  const host = doc.querySelector('.machine-host'); host.value = 'devbox'; host.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const folder = doc.querySelector('.machine-folder'); folder.value = '~/deployment'; folder.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
  doc.querySelector('.machine-primary').click(); await settle();
  const git = doc.querySelector('[data-step="git"]');
  assert.equal(git.querySelector('.machine-step-remedy').textContent, fixture('connect-needs-human-git').result.steps[2].remedy);
  assert.equal(git.querySelector('.machine-copy'), null);
  assert.equal(git.querySelector('.machine-step-state').textContent, 'needs you');
  doc.querySelector('.machine-primary').click(); await settle();
  assert.deepEqual(added, ['devbox-deployment']);
});

// oats.aweb's own `aweb connect --json` (spec B's fake-host tests).
test('aweb connect as oats.aweb answers it: ready, needs-human at aw (a backticked command to copy), failed with the step\'s remedy', () => {
  const ready = connectOutcome(fixture('aweb-connect-ready'), AWEB_STEPS);
  assert.equal(ready.ok, true); assert.equal(ready.ready, true); assert.equal(ready.id, 'devbox-aweb');
  assert.deepEqual(ready.steps, fixture('aweb-connect-ready').result.steps);
  const needs = connectOutcome(fixture('aweb-connect-needs-human-aw'), AWEB_STEPS);
  assert.equal(needs.ok, true); assert.equal(needs.ready, false);
  assert.deepEqual(needs.steps.map(s => s.status), ['needs-human', 'skipped', 'skipped', 'skipped']);
  assert.deepEqual(stepCommands(needs.steps[0].remedy), ['oats aweb connect devbox-aweb --install-aw --soul dev']);
  const raw = fixture('aweb-connect-failed-not-member'), failed = connectOutcome(raw, AWEB_STEPS);
  assert.deepEqual(failed.error, { code: 'E_TEAM_NOT_MEMBER', message: raw.error.message });
  assert.deepEqual(failed.steps.map(s => [s.step, s.status]), [['aw', 'ok'], ['invite', 'failed']]);
  assert.deepEqual(stepCommands(failed.steps[1].remedy), ['oats aweb setup --join joined --invite-stdin --soul dev']);
});

test('the dialog over both real answers: connect ready, then messaging needing a human, with its command to copy; then both ready', async t => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const doc = dom.window.document, added = [], sent = [];
  Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async text => { sent.push(text); } } });
  const answers = [fixture('connect-ready'), fixture('aweb-connect-needs-human-aw'), fixture('connect-ready'), fixture('aweb-connect-ready')];
  const ctx = { api: async () => ({ ok: true, status: 200, json: async () => answers.shift() }) };
  const ui = openAddMachineDialog(doc, { ctx, ws: 'ws:x', deployment: '/Users/alex/Agents/deployment', aweb: true, onAdded: id => added.push(id) });
  t.after(() => { ui.close(); dom.window.close(); });
  const host = doc.querySelector('.machine-host'); host.value = 'devbox'; host.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const folder = doc.querySelector('.machine-folder'); folder.value = '~/deployment'; folder.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
  doc.querySelector('.machine-primary').click(); await settle();
  const aw = doc.querySelector('[data-phase="aweb"] [data-step="aw"]');
  assert.equal(aw.querySelector('.machine-step-state').textContent, 'needs you');
  aw.querySelector('.machine-copy').click(); await settle();
  assert.deepEqual(sent, ['oats aweb connect devbox-aweb --install-aw --soul dev']);
  assert.deepEqual(added, []);
  doc.querySelector('.machine-primary').click(); await settle();
  assert.deepEqual(added, ['devbox-deployment']);
});
