// #482 (decision Q2, UI spec): the spawn dialog's Deployment field. With two or more deployments in the view
// the dialog asks which one, first, before Name: a segmented control with two or three, the Harness-style
// dropdown with more, never a native select; options named by machine, a non-live one marked in words.
// Availability is the chosen deployment's own catalog; the default is the last used in this view if it has
// the soul, else the first that has it (local before remote), else the last used (blocked). Why Spawn is
// blocked is said once, in the footer. Every spawn request addresses the chosen deployment; jobs are owned
// by the view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { mountSpawn, settle, catalogAgents, deferred, DEPLOYMENT, ROOT } from './helpers/spawn-dialog-host.mjs';
import { anchor } from './helpers/spawn-preview-fixture.mjs';
import { createSpawnDeploymentField, defaultSpawnDeployment, catalogSoul, lastSpawnDeployment, rememberSpawnDeployment, spawnDeployments,
  SPAWN_DEPLOYMENT_KEY, SPAWN_DEPLOYMENT_VIEWS_MAX } from '../renderer/spawn-deployment-field.mjs';
import { roveSegment } from '../renderer/spawn-dialog.mjs';
import { createSpawnJobs } from '../renderer/spawn-jobs.mjs';
import { currentWorkspace } from '../renderer/views/common.mjs';

const A = DEPLOYMENT, B = '/fixture/other/northwind', R = 'remote:devbox:k1';
const local = (id, label, extra = {}) => ({ id, machine: 'This Mac', path: id, label, local: true, reachable: true, identityFrom: 'reported', primary: false, ...extra });
const DA = local(A, '…/base/northwind-workspace', { primary: true }), DB = local(B, '…/other/northwind');
const DR = { id: R, machine: 'devbox', path: '/Users/alex/Agents/web', label: '~/Agents/web', local: false, reachable: true, identityFrom: 'reported', primary: false };
// Not reached: one the server remembers (its last report), one it never reached.
const DV = { id: 'remote:laptop:k2', machine: 'laptop', path: '/home/ops/agents', label: '~/agents', local: false, reachable: false, identityFrom: 'remembered', primary: false, reason: 'ssh timed out' };
const DW = { id: 'remote:build:k3', machine: 'build', path: '/srv/oats', label: '/srv/oats', local: false, reachable: false, identityFrom: null, primary: false };
const remoteSoul = { name: 'release-manager', description: '', kind: 'persistent', work: 'worktree', agentsRoot: '/srv/agents', server: 'devbox', remote: true, repoName: 'devbox' };
const memory = () => { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m }; };
const wsOf = path => decodeURIComponent(/[?&]ws=([^&]*)/.exec(path)?.[1] ?? '');
const previewWs = u => u.calls.filter(c => c.path.startsWith('/api/workspace-spawn-preview')).map(c => wsOf(c.path));
const spawnWs = u => u.calls.filter(c => c.path.startsWith('/api/spawn?')).map(c => [wsOf(c.path), c.body.action]);
// The segmented control's options, by what a screen reader reads (the machine, then a non-live state).
const options = u => [...u.q('.fdeployment').querySelectorAll('input')].map(i => i.getAttribute('aria-label'));
const chosen = u => u.q('.fdeployment input:checked')?.value;
async function choose(u, id) { [...u.q('.fdeployment').querySelectorAll('input')].find(i => i.value === id).click(); await settle(); }
const key = (target, k) => target.dispatchEvent(new target.ownerDocument.defaultView.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
/** What the "What will be created" column says, as dt → dd. */
const facts = u => Object.fromEntries([...u.doc.querySelectorAll('.spawn-preview-created dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent.trim()]));
/** Every message the dialog shows outside its footer: the field, the form's hints, the preview column. */
const elsewhere = u => [...u.dialog().querySelectorAll('.spawn-deployment, .spawn-preview-body, .spawn-hint')].map(n => n.textContent).join('\n');

// ── the rules, alone ──────────────────────────────────────────────────────────────────────────────

test('default rule: last used if it has the soul, else the first that has it (local before remote), else the last used', () => {
  const list = [DR, DA, DB];
  const has = map => id => map[id] ?? null;
  assert.equal(defaultSpawnDeployment(list, { has: has({ [A]: true, [B]: true, [R]: true }), lastUsed: B }), B, 'the last used has it');
  assert.equal(defaultSpawnDeployment(list, { has: has({ [A]: true, [B]: false, [R]: true }), lastUsed: B }), A, 'else the first local that has it, before a remote listed first');
  assert.equal(defaultSpawnDeployment(list, { has: has({ [A]: false, [B]: false, [R]: true }), lastUsed: B }), R, 'a remote one when no local one has it');
  assert.equal(defaultSpawnDeployment(list, { has: has({ [A]: false, [B]: false, [R]: false }), lastUsed: B }), B, 'none has it: the last used (blocked)');
  assert.equal(defaultSpawnDeployment(list, { has: () => null }), A, 'nothing known, nothing used: the first local one');
  assert.equal(defaultSpawnDeployment([DR, { ...DR, id: 'remote:b:2' }], { has: () => null }), R, 'no local one: the first');
  assert.equal(defaultSpawnDeployment(list, { has: () => null, lastUsed: '/gone' }), A, 'a last used no longer in the view is ignored');
});

test('catalogSoul: the same root, else the one row of that name, else the one from the same repository; never a guess', () => {
  const soul = { name: 'dev', agentsRoot: '/a/agents', repoName: 'oats', soulKind: 'member' };
  assert.equal(catalogSoul([{ name: 'dev', agentsRoot: '/a/agents' }, { name: 'dev', agentsRoot: '/x' }], soul).agentsRoot, '/a/agents');
  assert.equal(catalogSoul([{ name: 'dev', agentsRoot: '/b/agents' }], soul).agentsRoot, '/b/agents');
  assert.equal(catalogSoul([{ name: 'dev', agentsRoot: '/b', repoName: 'oats', soulKind: 'member' }, { name: 'dev', agentsRoot: '/c', repoName: 'other', soulKind: 'member' }], soul).agentsRoot, '/b');
  assert.equal(catalogSoul([{ name: 'dev', agentsRoot: '/b' }, { name: 'dev', agentsRoot: '/c' }], soul), null, 'ambiguous: none');
  assert.equal(catalogSoul([{ name: 'qa', agentsRoot: '/a/agents' }], soul), null);
  assert.equal(catalogSoul('junk', soul), null);
});

test('last used: per view, deployment ids only, bounded to the most recent views', () => {
  const storage = memory();
  rememberSpawnDeployment('ws:one', B, storage);
  assert.equal(lastSpawnDeployment('ws:one', storage), B); assert.equal(lastSpawnDeployment('ws:two', storage), null);
  for (let i = 0; i < SPAWN_DEPLOYMENT_VIEWS_MAX + 5; i++) rememberSpawnDeployment(`ws:v${i}`, `/d/${i}`, storage);
  rememberSpawnDeployment('ws:v3', '/d/again', storage); // used again: the most recent
  const kept = JSON.parse(storage.getItem(SPAWN_DEPLOYMENT_KEY));
  assert.equal(Object.keys(kept).length, SPAWN_DEPLOYMENT_VIEWS_MAX);
  assert.equal(lastSpawnDeployment('ws:one', storage), null, 'the oldest view left');
  assert.equal(lastSpawnDeployment('ws:v3', storage), '/d/again');
  assert.ok(Object.values(kept).every(v => typeof v === 'string'), 'only ids');
  rememberSpawnDeployment('ws:bad', 'a\nb', storage); assert.equal(lastSpawnDeployment('ws:bad', storage), null, 'never a control character');
  storage.setItem(SPAWN_DEPLOYMENT_KEY, '{not json'); assert.equal(lastSpawnDeployment('ws:v3', storage), null, 'junk reads as nothing');
  assert.doesNotThrow(() => rememberSpawnDeployment('ws:x', B, { getItem: () => { throw Error('no'); }, setItem: () => { throw Error('no'); } }));
  assert.deepEqual(spawnDeployments([DA, DA, null, { id: '' }, DB]).map(d => d.id), [A, B], 'duplicates and junk are dropped');
});

test('the field: none with one deployment; a segmented control by machine with a state mark in words; catalog replies follow the latest intent', async () => {
  const dom = new JSDOM('<!doctype html><body></body>'), doc = dom.window.document;
  const soul = { name: 'release-manager', agentsRoot: ROOT };
  assert.equal(createSpawnDeploymentField(doc, { soul, viewId: 'v', deployments: [DA], read: async () => [] }), null, 'one deployment: no field');
  assert.equal(createSpawnDeploymentField(doc, { soul, viewId: 'v', deployments: [], read: async () => [] }), null);
  const gates = new Map(), changes = [];
  const read = id => { const d = deferred(); gates.set(id, [...(gates.get(id) || []), d]); return d.promise; };
  const field = createSpawnDeploymentField(doc, { soul, viewId: 'v', deployments: [DR, DA, DV], read, storage: memory(), rove: roveSegment, onChange: c => changes.push(c) });
  doc.body.append(field.element);
  // Relationship's control: a fieldset named by its legend, a radiogroup of labelled radios; never a select.
  assert.equal(field.element.tagName, 'FIELDSET'); assert.equal(field.element.querySelector('legend').textContent, 'Deployment');
  const seg = field.element.querySelector('.spawn-seg.fdeployment'), radios = [...seg.querySelectorAll('input[type=radio]')];
  assert.equal(seg.getAttribute('role'), 'radiogroup'); assert.equal(seg.getAttribute('aria-label'), 'Deployment');
  assert.equal(field.element.querySelector('select'), null, 'never a native select');
  assert.equal(new Set(radios.map(r => r.name)).size, 1, 'one group');
  // Each option: its machine; a deployment that is not live says so in a tag, in words, and in its name.
  assert.deepEqual(radios.map(r => r.getAttribute('aria-label')), ['devbox', 'This Mac', 'laptop, remembered']);
  assert.deepEqual(radios.map(r => r.nextElementSibling.firstChild.textContent), ['devbox', 'This Mac', 'laptop']);
  assert.deepEqual(radios.map(r => r.nextElementSibling.querySelector('.spawn-trigger-tag')?.textContent ?? null), [null, null, 'remembered']);
  assert.deepEqual(radios.map(r => r.closest('label').title), ['devbox · ~/Agents/web', 'This Mac · …/base/northwind-workspace', 'laptop · ~/agents'], 'the full label on hover');
  assert.doesNotMatch(field.element.textContent + radios.map(r => r.getAttribute('aria-label')).join(), /remote:/, 'never an id');
  assert.equal(field.value(), A, 'provisional: the first local one'); assert.equal(seg.querySelector(':checked').value, A);
  assert.equal(field.pending(), true);
  field.start(); await settle();
  gates.get(R)[0].resolve([remoteSoul]); gates.get(A)[0].resolve([]); gates.get(DV.id)[0].resolve([]);
  await settle();
  assert.equal(field.value(), R, 'only the remote deployment has it'); assert.equal(seg.querySelector(':checked').value, R);
  assert.deepEqual(changes, [{ moved: true, programmatic: true }]);
  assert.equal(field.server(), 'devbox'); assert.deepEqual(field.selector(), { soul: 'release-manager', agentsRoot: '/srv/agents' });
  assert.equal(field.runsOn(), 'devbox · ~/Agents/web');
  radios[1].click();
  assert.deepEqual(changes.at(-1), { moved: true, programmatic: false }, 'the operator chose');
  assert.equal(field.blocked(), true); assert.equal(field.blockText(), "release-manager isn't available on This Mac");
  radios[2].click();
  assert.equal(field.blocked(), true); assert.equal(field.blockText(), "laptop isn't reachable right now", 'not reached: the machine, not the soul');
  assert.equal(field.element.querySelector('.spawn-hint, [role=status], [aria-live]'), null, 'the field itself says nothing: the footer does');
  radios[1].click();
  // A newer read supersedes an older one; after dispose nothing lands.
  field.start(); field.start(); await settle();
  for (const id of [A, DV.id, R]) gates.get(id)[2].resolve(id === R ? [remoteSoul] : []);
  await settle();
  assert.equal(field.blocked(), true, 'the latest read: A has no release-manager');
  gates.get(A)[1].resolve([{ name: 'release-manager', agentsRoot: ROOT }]); await settle();
  assert.equal(field.blocked(), true, 'a superseded catalog reply never applies');
  const heard = changes.length;
  field.start(); await settle(); field.dispose();
  for (const id of [A, DV.id, R]) gates.get(id)[3].resolve([{ name: 'release-manager', agentsRoot: '/elsewhere' }]); await settle();
  assert.equal(changes.length, heard, 'nothing is heard after dispose');
  assert.equal(field.selector().agentsRoot, ROOT, 'nor applied');
  radios[0].click(); assert.equal(changes.length, heard, 'nor a click after dispose');
  dom.window.close();
});

test('the segmented control from the keyboard: one tab stop, arrows move and choose, Home/End go to the ends (Relationship\'s rules)', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true }), doc = dom.window.document;
  const changes = [], heard = [];
  const field = createSpawnDeploymentField(doc, { soul: { name: 'release-manager', agentsRoot: ROOT }, viewId: 'v', deployments: [DA, DB, DR],
    read: async () => [{ name: 'release-manager', agentsRoot: ROOT }], storage: memory(), rove: roveSegment, onChange: c => changes.push(c) });
  doc.body.append(field.element);
  doc.body.addEventListener('change', e => heard.push(e.target.value)); // the form hears an operator's choice as it hears its other fields
  const radios = [...field.element.querySelectorAll('input')];
  assert.deepEqual(radios.map(r => r.getAttribute('aria-label')), ['This Mac · northwind-workspace', 'This Mac · northwind', 'devbox'], 'one machine with two: its path tail');
  assert.deepEqual(radios.map(r => r.tabIndex), [0, -1, -1], 'the chosen one is the tab stop');
  radios[0].focus(); key(radios[0], 'ArrowRight');
  assert.equal(doc.activeElement, radios[1]); assert.equal(field.value(), B); assert.deepEqual(radios.map(r => r.tabIndex), [-1, 0, -1]);
  assert.deepEqual(changes.at(-1), { moved: true, programmatic: false }); assert.deepEqual(heard, [B]);
  key(radios[1], 'End'); assert.equal(field.value(), R); assert.equal(doc.activeElement, radios[2]);
  key(radios[2], 'ArrowRight'); assert.equal(field.value(), A, 'wraps');
  key(radios[0], 'ArrowLeft'); assert.equal(field.value(), R);
  key(radios[2], 'Home'); assert.equal(field.value(), A);
  assert.deepEqual(heard, [B, R, A, R, A]);
  field.dispose(); dom.window.close();
});

test('four or more deployments: the Harness-style dropdown (a listbox popup), by machine with states, from the keyboard; never a select', async () => {
  const dom = new JSDOM('<!doctype html><body><form></form></body>', { pretendToBeVisual: true }), doc = dom.window.document;
  const changes = [], heard = [];
  const field = createSpawnDeploymentField(doc, { soul: { name: 'release-manager', agentsRoot: ROOT }, viewId: 'v', deployments: [DA, DR, DV, DW],
    read: async () => [{ name: 'release-manager', agentsRoot: ROOT }], storage: memory(), rove: roveSegment, onChange: c => changes.push(c) });
  doc.body.append(field.element);
  doc.body.addEventListener('change', e => heard.push(e.target.className));
  assert.equal(field.element.querySelector('select'), null, 'never a native select');
  assert.equal(field.element.querySelector('.spawn-seg'), null);
  assert.equal(field.element.querySelector('.spawn-label-text').textContent, 'Deployment');
  const trigger = field.element.querySelector('.spawn-choice-trigger.fdeployment');
  assert.equal(trigger.getAttribute('aria-haspopup'), 'listbox'); assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(trigger.getAttribute('aria-label'), 'Deployment: This Mac'); assert.equal(trigger.textContent, 'This Mac'); assert.equal(trigger.title, 'This Mac · …/base/northwind-workspace');
  // Open from the keyboard: the listbox, the chosen option focused.
  trigger.focus(); key(trigger, 'ArrowDown');
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  const listbox = doc.getElementById(trigger.getAttribute('aria-controls'));
  assert.equal(listbox.getAttribute('role'), 'listbox'); assert.equal(listbox.getAttribute('aria-label'), 'Deployment choices');
  const items = [...listbox.querySelectorAll('[role=option]')];
  assert.deepEqual(items.map(b => b.firstChild.textContent), ['This Mac', 'devbox', 'laptop', 'build'], 'by machine');
  assert.deepEqual(items.map(b => b.querySelector('small')?.textContent ?? null), [null, null, 'remembered', 'not reached'], 'a non-live state in words, part of the option');
  assert.deepEqual(items.map(b => b.getAttribute('aria-selected')), ['true', 'false', 'false', 'false']);
  assert.equal(doc.activeElement, items[0]);
  key(items[0], 'ArrowDown'); key(doc.activeElement, 'ArrowDown');
  assert.equal(doc.activeElement.firstChild.textContent, 'laptop');
  key(doc.activeElement, 'Enter');
  assert.equal(field.value(), DV.id, 'an unreachable deployment is selectable'); assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(doc.activeElement, trigger, 'focus returns to the trigger');
  assert.deepEqual(changes.at(-1), { moved: true, programmatic: false }); assert.equal(heard.length, 1, 'the form hears the choice');
  // The trigger: the machine and its state tag (the Harness trigger's tag), named in words.
  assert.equal(trigger.firstChild.textContent, 'laptop'); assert.equal(trigger.querySelector('.spawn-trigger-tag').textContent, 'remembered');
  assert.equal(trigger.getAttribute('aria-label'), 'Deployment: laptop, remembered');
  assert.equal(field.blockText(), "laptop isn't reachable right now");
  // Escape closes without choosing; picking the chosen one again is no change.
  key(trigger, 'Enter'); assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  key(doc.activeElement, 'Escape'); assert.equal(trigger.getAttribute('aria-expanded'), 'false'); assert.equal(doc.activeElement, trigger);
  const count = changes.length;
  key(trigger, 'Enter'); key(doc.activeElement, 'Enter');
  assert.equal(changes.length, count, 'the same deployment again: nothing re-read'); assert.equal(heard.length, 1);
  field.dispose(); dom.window.close();
});

// ── the dialog ────────────────────────────────────────────────────────────────────────────────────

test('one deployment: no Deployment field, nothing new on screen, and the spawn routes address that deployment (pin)', async t => {
  const u = await mountSpawn(t, { deployments: [DA] });
  await u.open(); await settle();
  assert.equal(u.q('.fdeployment'), null, 'no field'); assert.equal(u.q('.spawn-deployment'), null);
  assert.ok(u.q('.spawn-place'), 'Where to run stays where it was');
  const fields = [...u.q('.spawn-form-body').children].filter(n => n.classList.contains('spawn-field'));
  assert.ok(fields[0].querySelector('.ftask') && fields[1].querySelector('.spawn-run'), 'the Opening instruction, then Harness, as before');
  assert.equal(facts(u)['Runs on'], undefined, 'no Runs on row'); assert.equal(facts(u).Name, 'release-manager-1', 'the summary as before');
  assert.ok(previewWs(u).length > 0); assert.ok(previewWs(u).every(ws => ws === A), 'the deployment, never the view id');
  assert.equal(u.calls.filter(c => c.path.startsWith('/api/agents?ws=')).filter(c => wsOf(c.path) === A).length, 0, 'no catalog read per deployment');
});

test('two deployments: the field comes first after the Opening instruction, before Harness, replaces Where to run, defaults to the first that has the soul; Runs on names it', async t => {
  const u = await mountSpawn(t, { deployments: [DA, DB], catalogs: { [A]: catalogAgents(), [B]: catalogAgents() } });
  await u.open(); await settle();
  assert.ok(u.q('.fdeployment')); assert.equal(u.q('.spawn-place'), null, 'Where to run is replaced');
  const fields = [...u.q('.spawn-form-body').children].filter(n => n.classList.contains('spawn-field'));
  assert.ok(fields[0].querySelector('.ftask'), 'the Opening instruction is the first field');
  assert.ok(fields[1].classList.contains('spawn-deployment'), 'then Deployment'); assert.ok(fields[2].querySelector('.spawn-run'), 'then Harness');
  assert.equal(u.doc.activeElement, u.q('.ftask'), 'focus on open: the first field, the Opening instruction');
  assert.equal(u.dialog().querySelector('select.fdeployment, .spawn-deployment select'), null, 'never a native select');
  assert.equal(u.q('.spawn-deployment .spawn-seg').getAttribute('role'), 'radiogroup', 'two: the segmented control');
  assert.deepEqual(options(u), ['This Mac · northwind-workspace', 'This Mac · northwind'], 'by machine; one machine with two: the path tail');
  assert.equal(chosen(u), A);
  // The summary's first row: where it runs, by its full label.
  // The instance leads the column; where it runs closes its facts.
  assert.deepEqual(Object.keys(facts(u)).slice(0, 2), ['Name', 'Home']); assert.equal(Object.keys(facts(u)).at(-1), 'Runs on');
  assert.equal(facts(u)['Runs on'], 'This Mac · …/base/northwind-workspace');
  await choose(u, B);
  assert.equal(facts(u)['Runs on'], 'This Mac · …/other/northwind');
  assert.equal(previewWs(u).at(-1), B);
});

test('the chosen deployment lacks the soul: one message, in the footer only; Spawn blocked; nothing read there', async t => {
  const u = await mountSpawn(t, { deployments: [DA, DB], catalogs: { [A]: catalogAgents(), [B]: [] } });
  await u.open(); await settle();
  assert.deepEqual(options(u), ['This Mac · northwind-workspace', 'This Mac · northwind'], 'no availability mark: the footer says it for the chosen one');
  assert.equal(chosen(u), A);
  assert.equal(u.q('.fspawn').disabled, false);
  const before = previewWs(u).length;
  await choose(u, B);
  assert.equal(u.q('.fspawn').disabled, true, 'blocked');
  assert.equal(u.text('.fstatus'), "release-manager isn't available on This Mac · northwind.");
  assert.ok(u.q('.fstatus').classList.contains('err'));
  assert.doesNotMatch(elsewhere(u), /isn't available/, 'not under the field, not in the summary');
  assert.equal(u.dialog().textContent.split("isn't available").length - 1, 1, 'said exactly once');
  assert.equal(facts(u)['Runs on'], 'This Mac · …/other/northwind', 'the summary still says where');
  assert.equal(previewWs(u).length, before, 'nothing is read for a deployment without the soul');
  await choose(u, A);
  assert.equal(previewWs(u).at(-1), A, 'back: re-read for that deployment');
  assert.equal(u.q('.fspawn').disabled, false); assert.doesNotMatch(u.text('.fstatus'), /isn't available/);
});

test('the chosen deployment is not reachable: "<machine> isn\'t reachable right now." in the footer only; selectable, marked, Spawn blocked', async t => {
  const u = await mountSpawn(t, { deployments: [DA, DW], catalogs: { [A]: catalogAgents(), [DW.id]: [] } });
  await u.open(); await settle();
  assert.deepEqual(options(u), ['This Mac', 'build, not reached']);
  const mark = [...u.q('.fdeployment').querySelectorAll('input')].find(i => i.value === DW.id).nextElementSibling.querySelector('.spawn-trigger-tag');
  assert.equal(mark.textContent, 'not reached', 'the state in words, not colour');
  assert.equal(chosen(u), A, 'the default is one that has the soul');
  await choose(u, DW.id);
  assert.equal(chosen(u), DW.id, 'selectable');
  assert.equal(u.q('.fspawn').disabled, true);
  assert.equal(u.text('.fstatus'), "build isn't reachable right now."); assert.ok(u.q('.fstatus').classList.contains('err'));
  assert.doesNotMatch(elsewhere(u), /reachable right now|isn't available/, 'nothing under the field or in the summary');
  assert.equal(u.dialog().textContent.split('reachable right now').length - 1, 1, 'said exactly once');
  assert.deepEqual(facts(u), { 'Runs on': 'build · /srv/oats' });
  assert.doesNotMatch(u.dialog().textContent, /remote:/, 'never an id');
});

test('four deployments: the dropdown, first; a pick re-reads there and Runs on follows', async t => {
  const DC = local('/fixture/third/northwind', '…/third/northwind');
  const u = await mountSpawn(t, { deployments: [DA, DB, DC, DV], catalogs: { [A]: catalogAgents(), [B]: catalogAgents(), [DC.id]: catalogAgents(), [DV.id]: [] } });
  await u.open(); await settle();
  assert.equal(u.q('.spawn-deployment .spawn-seg'), null); assert.equal(u.dialog().querySelector('.spawn-deployment select'), null);
  const trigger = u.q('.spawn-deployment .spawn-choice-trigger');
  assert.ok(u.q('.spawn-form-body > .spawn-field + .spawn-field').classList.contains('spawn-deployment'), 'first after the Opening instruction');
  assert.equal(trigger.getAttribute('aria-label'), 'Deployment: This Mac · northwind-workspace');
  trigger.click(); await settle();
  const items = [...u.dialog().querySelectorAll('#spawn-deployment-choices [role=option]')];
  assert.deepEqual(items.map(b => b.textContent), ['This Mac · northwind-workspace', 'This Mac · other/northwind', 'This Mac · third/northwind', 'laptopremembered'], 'tails that collide: two segments');
  items[1].click(); await settle();
  assert.equal(previewWs(u).at(-1), B); assert.equal(facts(u)['Runs on'], 'This Mac · …/other/northwind');
  trigger.click(); await settle();
  [...u.dialog().querySelectorAll('#spawn-deployment-choices [role=option]')][3].click(); await settle();
  assert.equal(u.text('.fstatus'), "laptop isn't reachable right now."); assert.equal(u.q('.fspawn').disabled, true);
  assert.doesNotMatch(elsewhere(u), /reachable right now/);
});

test('a deployment change re-reads the preview there, and a reply for the previous deployment is discarded', async t => {
  const held = deferred(); let holdA = false;
  const u = await mountSpawn(t, { deployments: [DA, DB], catalogs: { [A]: catalogAgents(), [B]: catalogAgents() },
    previewGate: async (_body, ws) => { if (holdA && ws === A) await held.promise; } });
  await u.open(); await settle();
  holdA = true; await u.type('.fpurpose', 'docs'); // A's read for these choices is now held in the air
  const reads = previewWs(u).length;
  await choose(u, B);
  assert.equal(previewWs(u).at(-1), B); assert.ok(previewWs(u).length > reads);
  assert.equal(u.text('.fstatus'), 'Preview ready');
  held.resolve(); await settle();
  // The late reply of A changes nothing: Spawn prepares and applies at B.
  await u.spawn();
  assert.deepEqual(spawnWs(u), [[B, 'prepare'], [B, 'apply']]);
  assert.equal(u.applied.length, 1); assert.equal(u.applied[0].target.workspace, B);
});

test('local apply goes to ?ws=<deployment>; the last used is recorded per view and becomes the default', async t => {
  const u = await mountSpawn(t, { deployments: [DA, DB], catalogs: { [A]: catalogAgents(), [B]: catalogAgents() } });
  await u.open(); await settle();
  assert.equal(chosen(u), A, 'nothing used yet: the first local one');
  await choose(u, B); await u.spawn();
  assert.deepEqual(spawnWs(u), [[B, 'prepare'], [B, 'apply']]);
  assert.deepEqual(JSON.parse(u.dom.window.localStorage.getItem(SPAWN_DEPLOYMENT_KEY)), { northwind: B }, 'per view: the view id keys the deployment id');
});

test('the default: last used when it has the soul, else the first with it; with none, the last used and a blocking message', async t => {
  const prime = (u, id) => u.dom.window.localStorage.setItem(SPAWN_DEPLOYMENT_KEY, JSON.stringify({ northwind: id }));
  const u = await mountSpawn(t, { deployments: [DA, DB], catalogs: { [A]: catalogAgents(), [B]: catalogAgents() } });
  prime(u, B); await u.open(); await settle();
  assert.equal(chosen(u), B);
  assert.ok(previewWs(u).length > 0); assert.ok(previewWs(u).every(ws => ws === B), 'no read for the provisional choice before the catalogs answered');
});

test('the default when the last used lacks the soul: the first that has it; when none has it, the last used, blocked', async t => {
  const u = await mountSpawn(t, { deployments: [DA, DB], catalogs: { [A]: catalogAgents(), [B]: [] } });
  u.dom.window.localStorage.setItem(SPAWN_DEPLOYMENT_KEY, JSON.stringify({ northwind: B }));
  await u.open(); await settle();
  assert.equal(chosen(u), A);
  assert.ok(previewWs(u).length > 0);
  assert.ok(previewWs(u).every(ws => ws === A), 'the provisional choice (the last used, B) is never read before the catalogs answered');
  const v = await mountSpawn(t, { deployments: [DA, DB], catalogs: { [A]: [], [B]: [] } });
  v.dom.window.localStorage.setItem(SPAWN_DEPLOYMENT_KEY, JSON.stringify({ northwind: B }));
  await v.open(); await settle();
  assert.equal(chosen(v), B);
  assert.equal(v.q('.fspawn').disabled, true); assert.equal(v.text('.fstatus'), "release-manager isn't available on This Mac · northwind.");
  assert.equal(v.q('.spawn-preview-empty'), null, 'the footer says it, the summary does not');
});

test('relation anchors: the chosen deployment\'s rows only', async t => {
  const row = (instance, deployment, root = ROOT) => ({ ...anchor, instance, agentsRoot: root, home: `${root}/release-manager/instances/${instance}`, running: true,
    createdAt: 'first', tmux: { session: 's', window: 'w' }, deployment: { id: deployment, machine: 'This Mac', path: deployment } });
  const u = await mountSpawn(t, { deployments: [DA, DB], catalogs: { [A]: catalogAgents(), [B]: catalogAgents() },
    instances: [row('on-a', A), row('on-b', B), { ...row('far', R, '/srv/agents'), server: 'devbox' }] });
  await u.open(); await settle();
  const names = () => [...u.q('.frelto').options].map(o => o.value).filter(Boolean);
  assert.deepEqual(names(), ['on-a']);
  await choose(u, B); assert.deepEqual(names(), ['on-b']);
});

test('a remote deployment spawns through its server with its own catalog\'s root; the reply\'s view is this one, so no switch', async t => {
  const bodies = [];
  const u = await mountSpawn(t, { deployments: [DA, DR], catalogs: { [A]: catalogAgents(), [R]: [remoteSoul] },
    remote: body => { bodies.push(body); return { spawned: true, instance: 'release-manager-x', agent: 'release-manager', home: '/srv/agents/release-manager/instances/release-manager-x', server: 'devbox', launched: true, workspaceId: 'northwind' }; } });
  await u.open(); await settle();
  assert.deepEqual(options(u), ['This Mac', 'devbox'], 'named by their machine');
  const reads = previewWs(u).length;
  await choose(u, R);
  assert.equal(previewWs(u).length, reads, 'the host decides a remote spawn: no local preview');
  assert.equal(u.text('.spawn-preview-empty'), 'Decided on devbox when it spawns.');
  await u.spawn();
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].serverId, 'devbox'); assert.equal(bodies[0].agentsRoot, '/srv/agents'); assert.equal(bodies[0].agent, 'release-manager');
  assert.equal(currentWorkspace(), 'northwind', 'the reply names this view: no switch');
  assert.equal(spawnWs(u).length, 0, 'never the local transaction');
});

test('background spawn: the job is owned by the view and addressed to the chosen deployment', async t => {
  const remembered = [];
  const u = await mountSpawn(t, { deployments: [DA, DB], catalogs: { [A]: catalogAgents(), [B]: catalogAgents() },
    jobs: { rememberDeployment: (view, deployment) => remembered.push([view, deployment]) } });
  await u.open(); await settle();
  await choose(u, B); await u.spawn();
  assert.equal(u.dialog(), null, 'handed off');
  const [row] = u.jobs.rows('northwind');
  assert.ok(row, 'the pending row belongs to the view'); assert.deepEqual(row.deployment, { id: B });
  assert.equal(u.jobs.get(row.id).workspace, 'northwind'); assert.equal(u.jobs.get(row.id).deployment, B);
  assert.equal(u.jobs.get(row.id).draft.restore.deployment, B, 'Reopen spawn chooses the same deployment again');
  assert.deepEqual(spawnWs(u), [[B, 'prepare'], [B, 'apply']]);
  assert.deepEqual(remembered, [['northwind', B]], 'created: the view\'s last used');
  // Created: the pending row stays until ITS deployment's row reports it (both deployments share these strings here).
  const real = deployment => ({ instance: row.instance, home: row.home, agentsRoot: ROOT, agent: 'release-manager', running: true, tmux: { session: 's' }, deployment: { id: deployment } });
  u.jobs.observe('northwind', [real(A)]);
  assert.equal(u.jobs.rows('northwind').length, 1, 'another deployment\'s identical row is not this spawn');
  u.jobs.observe('northwind', [real(A), real(B)]);
  assert.equal(u.jobs.rows('northwind').length, 0, 'its own deployment reports it');
});

// Every text the field, its footer message and the Runs on row put on screen, on the computed tokens like
// test/theme-contrast.test.mjs: AA in every theme, no opacity; the state tag is the Harness trigger's (muted on chip-bg).
function luminance(hex) {
  assert.match(hex, /^#[0-9a-f]{6}$/i);
  const c = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
}
for (const theme of ['light', 'solarized', 'dark']) for (const [kind, deployments] of [['segmented', [DA, DV]], ['dropdown', [DA, DB, DR, DV]]]) {
  test(`${theme}, ${kind}: the Deployment field, its state tag, the footer message and Runs on meet computed-token AA with no opacity`, async t => {
    const u = await mountSpawn(t, { deployments, catalogs: Object.fromEntries(deployments.map(d => [d.id, d === DV ? [] : catalogAgents()])) });
    const style = u.doc.createElement('style'); style.textContent = readFileSync(new URL('../renderer/theme.css', import.meta.url), 'utf8'); u.doc.head.append(style);
    u.doc.documentElement.dataset.theme = theme;
    await u.open(); await settle();
    // The footer's message for a chosen deployment that is not reachable (shown, then the default chosen back for Runs on's data row).
    u.q('.fstatus').textContent = "laptop isn't reachable right now."; u.q('.fstatus').classList.add('err');
    const pairs = [
      ['.fstatus.err', '.spawn-footer', 'danger', 'surface'],
      ['.spawn-preview-facts dt', '.spawn-preview', 'muted', 'surface-2'], ['.spawn-preview-facts', '.spawn-preview', 'fg', 'surface-2'],
    ];
    if (kind === 'segmented') pairs.push(
      ['.spawn-deployment > legend', '.spawn-dialog', 'muted', 'surface'],
      ['.spawn-deployment .spawn-seg input:checked + span', '.spawn-deployment .spawn-seg input:checked + span', 'accent', 'sel'],
      ['.spawn-deployment .spawn-seg input:not(:checked) + span', '.spawn-deployment .spawn-seg', 'muted', 'surface'],
      ['.spawn-deployment .spawn-seg .spawn-trigger-tag', '.spawn-deployment .spawn-seg .spawn-trigger-tag', 'muted', 'chip-bg'],
    );
    else {
      // The trigger shows the tag of the chosen deployment: choose laptop, then open the list.
      u.q('.spawn-deployment .spawn-choice-trigger').click(); await settle();
      [...u.dialog().querySelectorAll('#spawn-deployment-choices [role=option]')].at(-1).click(); await settle();
      u.q('.spawn-deployment .spawn-choice-trigger').click(); await settle();
      [...u.dialog().querySelectorAll('#spawn-deployment-choices [role=option]')][0].focus();
      pairs.push(
        ['.spawn-deployment .spawn-label-text', '.spawn-dialog', 'muted', 'surface'],
        ['.spawn-deployment .spawn-choice-trigger', '.spawn-deployment .spawn-choice-trigger', 'fg', 'surface'],
        ['.spawn-deployment .spawn-choice-trigger .spawn-trigger-tag', '.spawn-deployment .spawn-choice-trigger .spawn-trigger-tag', 'muted', 'chip-bg'],
        ['#spawn-deployment-choices [aria-selected=true]', '#spawn-deployment-choices [aria-selected=true]', 'fg', 'sel'],
        ['#spawn-deployment-choices [aria-selected=true] small', '#spawn-deployment-choices [aria-selected=true]', 'muted', 'sel'],
        ['#spawn-deployment-choices [aria-selected=false]', '#spawn-deployment-choices [aria-selected=false]', 'fg', 'surface'],
      );
    }
    assert.ok(u.q('.spawn-preview-facts dt'), 'the Runs on row is on screen');
    const view = u.dom.window, root = view.getComputedStyle(u.doc.documentElement);
    for (const [selector, surfaceSelector, fg, bg] of pairs) {
      const element = u.q(selector), surface = u.dialog().matches(surfaceSelector) ? u.dialog() : u.q(surfaceSelector);
      assert.ok(element && surface, selector);
      assert.equal(view.getComputedStyle(element).color, `var(--${fg})`, selector);
      assert.match(view.getComputedStyle(surface).background || view.getComputedStyle(surface).backgroundColor, new RegExp(`var\\(--${bg}\\)`), surfaceSelector);
      const f = luminance(root.getPropertyValue(`--${fg}`).trim()), b = luminance(root.getPropertyValue(`--${bg}`).trim());
      assert.ok((Math.max(f, b) + .05) / (Math.min(f, b) + .05) >= 4.5, `${theme} ${selector}: ${fg} on ${bg}`);
      for (let parent = element; parent; parent = parent.parentElement) assert.equal(view.getComputedStyle(parent).opacity, '1', selector);
    }
  });
}

// ── the store, alone ──────────────────────────────────────────────────────────────────────────────

test('spawn jobs: post addresses the deployment, ownership and storage keep the view, observe matches the deployment\'s row', async () => {
  const posts = [], storage = memory();
  const s = createSpawnJobs({ post: async (ws, body) => { posts.push([ws, body.action]); return new Promise(() => {}); }, notify: () => ({}), currentWorkspace: () => 'ws:v', storage });
  const decision = { instance: 'dev-a', home: '/b/agents/dev/instances/dev-a' };
  const id = s.submit({ token: {}, workspace: 'ws:v', deployment: '/b', soul: { name: 'dev', agentsRoot: '/a/agents' }, selector: { soul: 'dev', agentsRoot: '/b/agents' }, input: { action: 'prepare' }, decision });
  await settle();
  assert.deepEqual(posts, [['/b', 'prepare']]);
  assert.equal(s.inFlight('ws:v', { name: 'dev', agentsRoot: '/a/agents' })?.id, id, 'in flight in the view');
  assert.equal(s.rows('/b').length, 0); assert.equal(s.rows('ws:v').length, 1);
  // Without a deployment, the view addresses it (as before).
  const t = createSpawnJobs({ post: async (ws) => { posts.push([ws]); return new Promise(() => {}); }, notify: () => ({}) });
  t.submit({ token: {}, workspace: '/w', soul: { name: 'dev', agentsRoot: '/w/agents' }, selector: { soul: 'dev', agentsRoot: '/w/agents' }, input: {}, decision });
  await settle(); assert.deepEqual(posts.at(-1), ['/w']);
  // Recovery keeps the deployment.
  storage.setItem('oats.spawnJobs.v1', JSON.stringify([{ workspace: 'ws:v', deployment: '/b', spawnRef: 'r1', soul: { name: 'dev', agentsRoot: '/a/agents' },
    selector: { soul: 'dev', agentsRoot: '/b/agents' }, instance: 'dev-b', home: '/b/agents/dev/instances/dev-b', placement: {}, startedAt: 1 }]));
  const recovered = [];
  const r = createSpawnJobs({ post: async (ws, body) => { recovered.push([ws, body.action]); return new Promise(() => {}); }, notify: () => ({}), storage });
  assert.equal(r.recover(), 1); await settle();
  assert.deepEqual(recovered, [['/b', 'result']]);
  assert.equal(r.rows('ws:v')[0].deployment.id, '/b');
});

test('spawn jobs (#1579): a decision that binds background places the pending row in the Background section, and recovery keeps it', async () => {
  const storage = memory();
  const s = createSpawnJobs({ post: async () => new Promise(() => {}), notify: () => ({}), currentWorkspace: () => '/w', storage });
  const spec = (instance, effective) => ({ token: {}, workspace: '/w', soul: { name: instance, agentsRoot: '/w/agents' }, selector: { soul: instance, agentsRoot: '/w/agents' },
    input: { action: 'prepare' }, decision: { instance, home: `/w/agents/${instance}/instances/${instance}`, ...(effective ? { effective } : {}) } });
  s.submit(spec('bg', { background: true })); s.submit(spec('fg', {})); s.submit(spec('plain'));
  await settle();
  assert.deepEqual(s.rows('/w').map(r => [r.instance, r.background ?? null]), [['bg', true], ['fg', null], ['plain', null]]);
  // Recovery after a reload keeps the placement as it was stored, `background: true` exactly.
  const stored = (instance, placement) => ({ workspace: '/w', spawnRef: `r-${instance}`, soul: { name: 'dev', agentsRoot: '/w/agents' }, selector: { soul: 'dev', agentsRoot: '/w/agents' },
    instance, home: `/w/agents/dev/instances/${instance}`, placement, startedAt: 1 });
  storage.setItem('oats.spawnJobs.v1', JSON.stringify([stored('kept', { background: true }), stored('odd', { background: 'yes' })]));
  const r = createSpawnJobs({ post: async () => new Promise(() => {}), notify: () => ({}), storage });
  assert.equal(r.recover(), 2);
  assert.deepEqual(r.rows('/w').map(row => [row.instance, row.background ?? null]), [['kept', true], ['odd', null]]);
});

test('a local deployment not read yet blocks Spawn with "hasn\'t been read yet", never "isn\'t reachable" (expert, #482)', async () => {
  const doc = new JSDOM('<body></body>').window.document;
  const unread = local(B, '…/other/northwind', { reachable: false, identityFrom: null });
  const field = createSpawnDeploymentField(doc, { soul: { name: 'release-manager', agentsRoot: ROOT }, viewId: 'v', deployments: [DA, unread],
    read: async () => [], storage: memory(), rove: roveSegment });
  doc.body.append(field.element);
  [...field.element.querySelectorAll('input[type=radio]')].find(r => r.value === B).click();
  assert.equal(field.blocked(), true);
  assert.equal(field.blockText(), "This Mac's deployment hasn't been read yet. Try again in a moment");
  field.dispose?.();
});
