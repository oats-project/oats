// #517: Where to run lists this window's machines only, ends with "Add a machine to this workspace…",
// and selects the machine the dialog added. Gates off: today's list, no Add entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountSpawn, settle } from './helpers/spawn-dialog-host.mjs';
import { setWorkspace } from '../renderer/views/common.mjs';

const KEY = 'github.com/acme/northwind';
const answer = (servers, extra = {}) => ({ servers, filtered: true, key: KEY, deployment: '/Users/alex/Agents/northwind', aweb: false, ...extra });
const DEVBOX = { id: 'devbox-northwind', label: 'devbox', sshHost: 'devbox', workspace: '/home/alex/northwind', workspaceKey: KEY, check: null };
const READY = { schemaVersion: 1, ok: true, result: { id: 'laptop-northwind', ready: true, steps: [{ step: 'register', status: 'done' }] } };
const options = u => [...u.q('.fserver').options].map(o => [o.value, o.textContent]);
const machineDialog = u => u.doc.querySelector('.machine-dialog');

test('gated: This computer, this workspace\'s machines, then "Add a machine to this workspace…" last; the route is asked for this window', async t => {
  const u = await mountSpawn(t, { servers: answer([DEVBOX]) });
  await u.open();
  assert.deepEqual(options(u), [['', 'This computer'], ['devbox-northwind', 'devbox (devbox-northwind)'], ['+add-machine', 'Add a machine to this workspace…']]);
  assert.ok(u.calls.some(c => c.path === '/api/servers?ws=northwind'));
  assert.equal(u.q('.spawn-place').hidden, false);
});

test('gated with no machine yet: Where to run still shows, to offer Add a machine', async t => {
  const u = await mountSpawn(t, { servers: answer([]) });
  await u.open();
  assert.deepEqual(options(u), [['', 'This computer'], ['+add-machine', 'Add a machine to this workspace…']]);
  assert.equal(u.q('.spawn-place').hidden, false);
});

test('gates off: today\'s list, unchanged, and no Add entry', async t => {
  const u = await mountSpawn(t, { servers: [{ id: 'devbox-web', label: 'devbox', sshHost: 'devbox' }] });
  await u.open();
  assert.deepEqual(options(u), [['', 'This computer'], ['devbox-web', 'devbox (devbox-web)']]);
});

test('no workspace key: no remote machine, no Add, and one line saying why', async t => {
  const reason = 'This deployment reports no workspace key, so no other machine can be matched to it.';
  const u = await mountSpawn(t, { servers: { servers: [], filtered: true, key: null, deployment: null, aweb: false, reason } });
  await u.open();
  assert.deepEqual(options(u), [['', 'This computer']]);
  assert.equal(u.text('.spawn-server-hint'), reason);
  assert.equal(u.q('.spawn-place').hidden, false);
});

test('choosing Add opens the dialog and Where to run keeps its choice; Cancel returns focus to Where to run', async t => {
  const u = await mountSpawn(t, { servers: answer([DEVBOX]) });
  await u.open();
  const previews = u.previews().length;
  u.q('.fserver').focus();
  await u.change('.fserver', '+add-machine');
  assert.ok(machineDialog(u), 'the Add a machine dialog');
  assert.equal(u.q('.fserver').value, '', 'still This computer');
  assert.equal(u.previews().length, previews, 'choosing the entry is not an edit');
  u.doc.querySelector('.machine-cancel').click();
  assert.equal(machineDialog(u), null);
  assert.equal(u.doc.activeElement, u.q('.fserver'));
  assert.ok(u.dialog(), 'the spawn dialog is still open');
});

test('a machine added: Where to run lists it, selects it and the form reads for it', async t => {
  const sent = [];
  const u = await mountSpawn(t, { servers: answer([DEVBOX]), machineApi: (body, path) => { sent.push({ body, path }); return READY; } });
  await u.open();
  await u.change('.fserver', '+add-machine');
  const host = u.doc.querySelector('.machine-host'); host.value = 'laptop'; host.dispatchEvent(new u.dom.window.Event('input', { bubbles: true }));
  const folder = u.doc.querySelector('.machine-folder'); folder.value = '~/northwind'; folder.dispatchEvent(new u.dom.window.Event('input', { bubbles: true }));
  u.doc.querySelector('.machine-primary').click(); await settle();
  assert.deepEqual(sent, [{ path: '/api/server-connect?ws=northwind', body: { phase: 'connect', id: 'laptop-northwind', host: 'laptop', folder: '~/northwind', installOats: true } }]);
  assert.equal(machineDialog(u), null, 'closed on success');
  assert.equal(u.q('.fserver').value, 'laptop-northwind');
  assert.deepEqual(options(u).at(-1), ['+add-machine', 'Add a machine to this workspace…'], 'Add stays last');
  assert.equal(u.text('.spawn-server-hint'), "Runs on laptop-northwind. Its teams and defaults come from that machine's workspace.");
  assert.equal(u.doc.activeElement, u.q('.fserver'));
});

test('two or more deployments: Add a machine is a button under the Deployment field; an added machine is not selected there', async t => {
  const deployments = [{ id: '/Users/alex/Agents/northwind', machine: 'This Mac', path: '/Users/alex/Agents/northwind', label: 'This Mac · ~/Agents/northwind', local: true, reachable: true, primary: true },
    { id: 'remote:devbox:a1', machine: 'devbox', path: '/home/alex/northwind', label: 'devbox · ~/northwind', local: false, reachable: true, primary: false }];
  const u = await mountSpawn(t, { deployments, servers: answer([DEVBOX]), machineApi: () => READY,
    catalogs: { '/Users/alex/Agents/northwind': () => import('./helpers/spawn-dialog-host.mjs').then(m => m.catalogAgents()), 'remote:devbox:a1': [] } });
  await u.open();
  assert.equal(u.q('.spawn-place'), null, 'no Where to run');
  const button = u.q('.spawn-add-machine-button');
  assert.equal(button.textContent, 'Add a machine to this workspace…');
  assert.equal(u.q('.fdeployment').closest('.spawn-field').nextElementSibling, button.closest('.spawn-add-machine'));
  button.click();
  const host = u.doc.querySelector('.machine-host'); host.value = 'laptop'; host.dispatchEvent(new u.dom.window.Event('input', { bubbles: true }));
  const folder = u.doc.querySelector('.machine-folder'); folder.value = '~/northwind'; folder.dispatchEvent(new u.dom.window.Event('input', { bubbles: true }));
  u.doc.querySelector('.machine-primary').click(); await settle();
  assert.equal(machineDialog(u), null);
  assert.equal(u.text('.spawn-add-machine-note'), 'laptop-northwind is added. It is listed here once this computer has read it.');
  assert.equal(u.doc.activeElement, button);
});

// Review round 1: ownership and the backfill.
const NEEDS = { schemaVersion: 1, ok: true, result: { id: 'laptop-northwind', ready: false, steps: [{ step: 'register', status: 'done' }, { step: 'readiness', status: 'needs-human', remedy: 'x' }] } };

test('leaving the workspace while connect runs: the Add dialog goes with the spawn dialog, and the messaging step never starts', async t => {
  let release; const held = new Promise(r => { release = r; });
  const sent = [];
  const u = await mountSpawn(t, { servers: answer([DEVBOX], { aweb: true }), machineApi: async body => { sent.push(body.phase); if (body.phase === 'connect') await held; return body.phase === 'connect' ? NEEDS : READY; } });
  await u.open();
  await u.change('.fserver', '+add-machine');
  const host = u.doc.querySelector('.machine-host'); host.value = 'laptop'; host.dispatchEvent(new u.dom.window.Event('input', { bubbles: true }));
  const folder = u.doc.querySelector('.machine-folder'); folder.value = '~/northwind'; folder.dispatchEvent(new u.dom.window.Event('input', { bubbles: true }));
  u.doc.querySelector('.machine-primary').click(); await settle();
  setWorkspace('another-workspace'); await settle();
  assert.equal(u.dialog(), null, 'the spawn dialog closed');
  assert.equal(machineDialog(u), null, 'the Add dialog with it');
  release(); await settle();
  assert.deepEqual(sent, ['connect'], 'nothing after connect');
  assert.equal(machineDialog(u), null);
  setWorkspace('northwind'); await settle();
  assert.equal(machineDialog(u), null, 'coming back does not revive it');
});

test('while the server learns unknown keys, Where to run reads again and adds the machines it found, keeping the choice', async t => {
  const answers = [answer([DEVBOX], { backfilling: true }), answer([DEVBOX], { backfilling: true }),
    answer([DEVBOX, { ...DEVBOX, id: 'build-northwind', label: 'build' }])];
  const u = await mountSpawn(t, { servers: () => answers.length > 1 ? answers.shift() : answers[0] });
  await u.open(); await settle(30);
  assert.deepEqual(options(u).map(o => o[0]), ['', 'devbox-northwind', 'build-northwind', '+add-machine']);
  assert.equal(u.calls.filter(c => c.path.startsWith('/api/servers')).length, 3, 'no read after the settled answer');
});
