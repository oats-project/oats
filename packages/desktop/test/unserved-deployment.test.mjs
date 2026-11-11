// #461: no silent pending, and a non-deployment folder never drops the open set.
//  - the open set: a non-deployment is never persisted, never written over the saved set, and a
//    restart after an add carries the whole validated set;
//  - a picked folder that is not a deployment is refused before anything changes, with the
//    deployments one level down or around it (bounded, lstat-only) or, with none, onboarding;
//  - a known deployment the server does not advertise is refused by the proxy (404
//    E_WORKSPACE_NOT_SERVED), never answered with another workspace's data;
//  - the bounded wait and its copy; the observation pool that reads every deployment each cycle;
//  - the failed block's second action (Re-add workspace).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { withWindowGlobals } from './helpers/main-window-globals.mjs';
import { JSDOM } from 'jsdom';
import { persistableDirs, stageDirs, savedWorkspacePaths, restoreWorkspaceDirs, createAddExecutor, decideAdd, createGenerations, pickedFolderChoices, createPerformAdd, NOT_A_DEPLOYMENT_REASON, PICK_CHOICE_LIMIT, PICK_ANCESTOR_LIMIT } from '../workspace-registry.mjs';
import { PICK_SCAN_LIMIT } from '../../client/workspace-admission.mjs';
import { apiUrl, apiInit, classifyApiRoute, requestPath, unservedWorkspace, createUnservedRefusal, servedSelectors } from '../api-url.mjs';
import { forgeProxyOptions, trustedForgeFrame, FORGE_EPOCH_HEADER } from '../forge-proxy.mjs';
import { forgeFailure } from '../renderer/forge-contract.mjs';
import { lifecycleFailure } from '../../client/lifecycle-contract.mjs';
import { lifecycleFrameRefusal } from '../renderer/lifecycle-frame.mjs';
import { DESKTOP_TERMS } from '../renderer/desktop-terms.mjs';
import {
  workspaceNotServed, unservedText, unservedError, createPendingWatch, PENDING_LIMIT_MS, NOT_SERVED_CODE, NO_ANSWER_CODE,
} from '../renderer/deployment-header.mjs';
import { DEPLOYMENT_READ_TIMEOUT } from '../../client/deployment-read-cli.mjs';
import { mapBounded, MAX_DEPLOYMENT_OBSERVATIONS } from '../../client/deployment-observer.mjs';
import { createDataState, failedElement } from '../renderer/loading.mjs';

const DEPLOYMENTS = new Set(['/d/oats-v2', '/d/Agents/aweb', '/d/third']);
const isDeployment = path => DEPLOYMENTS.has(path);
const validate = path => (isDeployment(path) ? { id: path, path } : null);

/* ── the open set ─────────────────────────────────────────────────────────── */
test('persistableDirs: deployments only, each once; a parent folder is never written', () => {
  assert.deepEqual(persistableDirs(['/d/Agents', '/d/oats-v2', '/d/oats-v2', '/d/Agents/aweb'], validate), ['/d/oats-v2', '/d/Agents/aweb']);
  assert.deepEqual(persistableDirs(['/d/Agents'], validate), [], 'nothing to write: the saved set is left as it is');
  assert.deepEqual(persistableDirs(['/d/oats-v2'], () => { throw Error('EACCES'); }), [], 'a failing check is not a deployment');
});

test('the restore after a launch from a parent folder opens the saved set and nothing else', () => {
  const saved = JSON.stringify(['/d/oats-v2', '/d/Agents/aweb']);
  assert.deepEqual(restoreWorkspaceDirs('/d/Agents', saved, validate), ['/d/oats-v2', '/d/Agents/aweb']);
  // Nothing saved validates: nothing is served, never the startup folder; the window chooses (#518).
  assert.deepEqual(restoreWorkspaceDirs('/d/Agents', 'not json', validate), []);
  assert.deepEqual(savedWorkspacePaths(saved), ['/d/oats-v2', '/d/Agents/aweb']);
  assert.deepEqual(savedWorkspacePaths('{"x":1}'), []); assert.deepEqual(savedWorkspacePaths('["relative", 3, "/abs"]'), ['/abs']);
});

test('stageDirs: the restart after an add carries the whole validated set plus the new deployment', () => {
  assert.deepEqual(stageDirs(['/d/oats-v2', '/d/Agents/aweb'], '/d/third', validate), ['/d/oats-v2', '/d/Agents/aweb', '/d/third']);
  assert.deepEqual(stageDirs(['/d/Agents'], '/d/third', validate), ['/d/third'], 'a served non-deployment placeholder does not ride along');
  assert.deepEqual(stageDirs(['/d/third'], '/d/third', validate), ['/d/third']);
});

function executor({ ready = true, previous = ['/d/oats-v2', '/d/Agents/aweb'] } = {}) {
  const log = { servers: [], commits: [] };
  let dirs = [...previous];
  const execute = createAddExecutor({
    getDirs: () => [...dirs], stage: (d, path) => stageDirs(d, path, validate),
    commitDirs: next => { log.commits.push(next); dirs = next; },
    replaceServer: async next => { log.servers.push(next); },
    refreshAdvertised: async () => true, probeVersion: async () => ({ ok: true }), isCompatible: () => true,
    advertises: async () => ready, delay: async () => {}, attempts: 2,
  });
  return { execute, log, dirs: () => dirs };
}

test('a restart after an add keeps the full set: the replacement server argv is the complete validated set', async () => {
  const x = executor();
  const result = await x.execute({ id: '/d/third', path: '/d/third' }, () => true);
  assert.equal(result.ok, true);
  assert.deepEqual(x.log.servers, [['/d/oats-v2', '/d/Agents/aweb', '/d/third']]);
  assert.deepEqual(x.log.commits, [['/d/oats-v2', '/d/Agents/aweb', '/d/third']]);
});

test('a failed add restores the previous server and commits nothing', async () => {
  const x = executor({ ready: false });
  const result = await x.execute({ id: '/d/third', path: '/d/third' }, () => true);
  assert.equal(result.code, 'server-timeout');
  assert.deepEqual(x.log.servers, [['/d/oats-v2', '/d/Agents/aweb', '/d/third'], ['/d/oats-v2', '/d/Agents/aweb']]);
  assert.deepEqual(x.log.commits, []); assert.deepEqual(x.dirs(), ['/d/oats-v2', '/d/Agents/aweb']);
});

/* ── a picked folder that is not a deployment ─────────────────────────────── */
const entries = (...names) => names.map(name => ({ name, isDirectory: true }));
function listing(tree) { return (dir, limit) => { const all = tree[dir] || []; return { entries: all.slice(0, limit), limited: all.length > limit }; }; }

test('pickedFolderChoices: deployments one level down, sorted by name, lstat-typed, never more than the scan bound', () => {
  let asked = null;
  const tree = { '/d/Agents': [...entries('zeta', 'aweb', 'notes'), { name: 'link', isDirectory: false }, { name: 'file.txt', isDirectory: false }] };
  const deployments = new Set(['/d/Agents/zeta', '/d/Agents/aweb', '/d/Agents/link']);
  const found = pickedFolderChoices('/d/Agents', { list: (dir, limit) => { asked = limit; return listing(tree)(dir, limit); }, isDeployment: p => deployments.has(p) });
  assert.equal(asked, PICK_SCAN_LIMIT, 'the listing is bounded');
  assert.deepEqual(found.choices, [{ path: '/d/Agents/aweb', name: 'aweb', kind: 'inside' }, { path: '/d/Agents/zeta', name: 'zeta', kind: 'inside' }],
    'sorted; a link is not a directory, so it is never followed');
  assert.equal(found.more, 0); assert.equal(found.limited, false); assert.equal(found.scanLimit, undefined);
});

test('pickedFolderChoices: more than the choice limit says how many more; a full scan says it stopped', () => {
  const names = Array.from({ length: PICK_SCAN_LIMIT + 5 }, (_, i) => `d${String(i).padStart(3, '0')}`);
  const found = pickedFolderChoices('/p', { list: listing({ '/p': entries(...names) }), isDeployment: p => p.startsWith('/p/d') });
  assert.equal(found.choices.length, PICK_CHOICE_LIMIT);
  assert.equal(found.more, PICK_SCAN_LIMIT - PICK_CHOICE_LIMIT, 'only what was scanned is counted');
  assert.equal(found.limited, true); assert.equal(found.scanLimit, PICK_SCAN_LIMIT);
});

test('pickedFolderChoices: the deployment a folder is inside, within the ancestor bound', () => {
  const inside = pickedFolderChoices('/d/oats-v2/agents/dev', { list: listing({}), isDeployment: p => p === '/d/oats-v2' });
  assert.deepEqual(inside.choices, [{ path: '/d/oats-v2', name: 'oats-v2', kind: 'ancestor' }]);
  const deep = `/root/${Array.from({ length: PICK_ANCESTOR_LIMIT + 1 }, (_, i) => `l${i}`).join('/')}`;
  assert.deepEqual(pickedFolderChoices(deep, { list: listing({}), isDeployment: p => p === '/root' }).choices, [], 'past the bound nothing is offered');
  assert.deepEqual(pickedFolderChoices('/empty', { list: () => { throw Error('EACCES'); }, isDeployment: () => false }).choices, [], 'unreadable: no choices');
});

function performAdd({ choices = { choices: [], more: 0, limited: false }, decision }) {
  const calls = { execute: 0, offers: [] };
  const run = createPerformAdd({
    generations: createGenerations(),
    decide: (path, fromPicker) => decision ?? decideAdd(path, { realpath: p => p, validate, suggestedPaths: new Set(), fromPicker, serverOwned: true, advertised: new Set() }),
    realpath: p => p, choices: () => choices,
    offer: path => { calls.offers.push(path); return 'token'; },
    execute: async workspace => { calls.execute++; return { ok: true, workspace }; },
  });
  return { run, calls };
}

test('a picked parent folder is refused with the message and its choices; the executor (server, open set) is never reached', async () => {
  const p = performAdd({ choices: { choices: [{ path: '/d/Agents/aweb', name: 'aweb', kind: 'inside' }], more: 0, limited: false } });
  const answer = await p.run('/d/Agents', true);
  assert.deepEqual(answer, { ok: false, code: 'not-a-workspace', reason: NOT_A_DEPLOYMENT_REASON, path: '/d/Agents',
    choices: [{ path: '/d/Agents/aweb', name: 'aweb', kind: 'inside' }], more: 0, limited: false });
  assert.equal(NOT_A_DEPLOYMENT_REASON, "This folder isn't an OATS deployment: it has no oats-local.yaml. Choose the deployment folder itself, the one that contains oats-local.yaml.");
  assert.equal(p.calls.execute, 0); assert.deepEqual(p.calls.offers, [], 'no onboarding beside deployments');
});

test('a picked empty folder is refused, with the onboarding offer as the only way on', async () => {
  const p = performAdd({});
  const answer = await p.run('/d/empty', true);
  assert.equal(answer.reason, NOT_A_DEPLOYMENT_REASON); assert.deepEqual(answer.onboard, { token: 'token', path: '/d/empty' });
  assert.equal(p.calls.execute, 0);
});

test('a non-picker add of a non-deployment carries the message and no offer; other refusals pass through; a deployment runs the executor', async () => {
  const p = performAdd({ decision: { ok: false, code: 'not-a-workspace', reason: 'x' } });
  const answer = await p.run('/d/Agents', false);
  assert.equal(answer.reason, NOT_A_DEPLOYMENT_REASON); assert.equal(answer.onboard, undefined); assert.equal(p.calls.execute, 0);
  assert.deepEqual(await performAdd({ decision: { ok: false, code: 'foreign-server', reason: 'r' } }).run('/x', true), { ok: false, code: 'foreign-server', reason: 'r' });
  const ok = performAdd({ decision: { ok: true, action: 'replace-server', workspace: { id: '/d/third', path: '/d/third' } } });
  assert.equal((await ok.run('/d/third', true)).ok, true); assert.equal(ok.calls.execute, 1);
});

/* ── the proxy refusal ────────────────────────────────────────────────────── */
const known = path => path === '/d/oats-v2';
test('unservedWorkspace: only a known local deployment the server does not advertise, on the roster and agents reads', () => {
  const state = { allowedWs: new Set(['/d/Agents/aweb']), known };
  const ws = path => `?ws=${encodeURIComponent(path)}`;
  assert.equal(unservedWorkspace(`/api/panel${ws('/d/oats-v2')}`, state), '/d/oats-v2');
  assert.equal(unservedWorkspace(`/api/agents${ws('/d/oats-v2')}`, state), '/d/oats-v2');
  assert.equal(unservedWorkspace(`/api/panel${ws('/d/unknown')}`, state), null, 'unknown: today\'s adoption');
  assert.equal(unservedWorkspace(`/api/panel${ws('/d/Agents/aweb')}`, state), null, 'served');
  assert.equal(unservedWorkspace(`/api/panel${ws('remote:host')}`, state), null, 'remote ids are not local paths');
  assert.equal(unservedWorkspace('/api/panel', state), null, 'no ws: the verified workspace');
  assert.equal(unservedWorkspace(`/api/spawn${ws('/d/oats-v2')}`, state), null, 'mutations keep their own guards');
  assert.equal(unservedWorkspace(`/api/panel${ws('/d/oats-v2')}&ws=x`, state), null, 'duplicates are the server boundary\'s to refuse');
  assert.equal(unservedWorkspace(`/api/panel${ws('/d/oats-v2')}`, { ...state, allowedWs: new Set() }), null, 'not before the first answer');
  assert.equal(unservedWorkspace(`//evil.invalid/api/panel${ws('/d/oats-v2')}`, state), null);
  assert.equal(unservedWorkspace(`/api/panel${ws('/d/oats-v2')}`, { ...state, known: () => { throw Error('x'); } }), null);
  const refusal = createUnservedRefusal({ state: () => state, body: workspaceNotServed });
  assert.deepEqual(refusal(`/api/panel${ws('/d/oats-v2')}`), { ok: false, status: 404,
    body: { error: "This Desktop's server isn't serving this deployment.", code: NOT_SERVED_CODE, workspace: '/d/oats-v2' } });
  assert.equal(refusal('/api/panel'), null);
});

test('the shipped api handler answers a known unserved deployment with 404 E_WORKSPACE_NOT_SERVED and never fetches it', async () => {
  const source = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('ipcMain.handle("api",'), end = source.indexOf('// ---- IPC: workstation forge auth', start);
  const renderer = 'file:///fixture/index.html', frame = { url: renderer }, event = { sender: { mainFrame: frame, isDestroyed: () => false }, senderFrame: frame };
  const fetched = []; let handler;
  const allowedWs = new Set(['/d/Agents/aweb']);
  const context = { ipcMain: { handle: (_name, fn) => { handler = fn; } }, apiUrl, apiInit, servedSelectors, classifyApiRoute, forgeProxyOptions, trustedForgeFrame,
    FORGE_EPOCH_HEADER, forgeFailure, lifecycleFailure, lifecycleFrameRefusal, DESKTOP_TERMS, RENDERER_URL: renderer, serverEpoch: 0, currentForgeEpoch: () => 'main:0',
    unservedRefusal: createUnservedRefusal({ state: () => ({ allowedWs, known }), body: workspaceNotServed }),
    serverHost: { inTransition: () => false }, wsId: '/d/Agents/aweb', allowedWs, guard: () => {}, AbortSignal: { timeout: ms => ({ ms }) },
    requestPath, backendFetch: async path => { assert.equal(typeof path, 'string', 'backendFetch takes a path'); fetched.push(path); return { ok: true, status: 200, text: async () => JSON.stringify({ workspace: { id: '/d/Agents/aweb' }, workspaces: [{ id: '/d/Agents/aweb' }] }) }; } };
  runInNewContext(source.slice(start, end), withWindowGlobals(context));
  const refused = await handler(event, `/api/panel?ws=${encodeURIComponent('/d/oats-v2')}`, {});
  assert.deepEqual(refused, { ok: false, status: 404, body: workspaceNotServed('/d/oats-v2') });
  assert.deepEqual(fetched, [], 'never fetched: no other workspace\'s data answers for it');
  const adopted = await handler(event, `/api/panel?ws=${encodeURIComponent('/d/unknown')}`, {});
  assert.equal(adopted.ok, true); assert.match(fetched[0], /ws=%2Fd%2FAgents%2Faweb/, 'an unknown id is still pinned to the verified workspace');
});

test('during a server replacement the outgoing server\'s set still refuses: a Re-add target is never rewritten to another workspace', () => {
  const source = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
  // main keeps what the outgoing server advertised when it invalidates, and refuses against it until
  // the new server answers (the add's readiness check repopulates allowedWs before it commits).
  assert.match(source, /onInvalidate: \(\) => \{ if \(allowedWs\.size\) advertisedBefore = allowedWs; allowedWs = new Set\(\);/);
  assert.match(source, /state: \(\) => \(\{ allowedWs: allowedWs\.size \? allowedWs : advertisedBefore, known:/);
  let allowedWs = new Set(['/d/Agents/aweb']), advertisedBefore = new Set();
  const refusal = createUnservedRefusal({ body: workspaceNotServed,
    state: () => ({ allowedWs: allowedWs.size ? allowedWs : advertisedBefore, known }) });
  const read = `/api/panel?ws=${encodeURIComponent('/d/oats-v2')}`;
  advertisedBefore = allowedWs; allowedWs = new Set(); // the Re-add's restart is in flight
  assert.equal(refusal(read)?.status, 404, 'still not served while the new server starts');
  allowedWs = new Set(['/d/Agents/aweb', '/d/oats-v2']); // the new server advertises it
  assert.equal(refusal(read), null, 'served: proxied');
});

/* ── the bounded wait and its copy ────────────────────────────────────────── */
test('the bounded wait is the deployment read timeout plus 15 s', () => {
  assert.equal(PENDING_LIMIT_MS, DEPLOYMENT_READ_TIMEOUT + 15_000);
  assert.equal(PENDING_LIMIT_MS, 45_000);
});

test('createPendingWatch: one subject pending for the bound; any other answer or subject starts over', () => {
  let now = 0; const watch = createPendingWatch({ now: () => now });
  assert.equal(watch.observe('A', true), false);
  now = PENDING_LIMIT_MS - 1; assert.equal(watch.observe('A', true), false);
  now = PENDING_LIMIT_MS; assert.equal(watch.observe('A', true), true);
  assert.equal(watch.observe('B', true), false, 'another deployment or connection starts over');
  now += PENDING_LIMIT_MS; assert.equal(watch.observe('B', true), true);
  assert.equal(watch.observe(null, false), false); assert.equal(watch.observe('B', true), false, 'an observation in between starts over');
  now += PENDING_LIMIT_MS; watch.reset(); assert.equal(watch.observe('B', true), false, 'Retry starts over');
});

test('createPendingWatch with onOverdue: a timer of the subject\'s own fires once at the bound; an answer, another subject, reset or dispose cancels it', () => {
  const timers = new Map(); let seq = 0, now = 0;
  const fire = () => { for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); } };
  const fired = [];
  const watch = createPendingWatch({ now: () => now, onOverdue: subject => fired.push(subject),
    setTimeout: (fn, ms) => { timers.set(++seq, { fn, at: now + ms }); return seq; }, clearTimeout: id => timers.delete(id) });
  watch.observe('A', true); watch.observe('A', true); assert.equal(timers.size, 1, 'one timer per subject');
  now = PENDING_LIMIT_MS - 1; fire(); assert.deepEqual(fired, []);
  now = PENDING_LIMIT_MS; fire(); assert.deepEqual(fired, ['A'], 'fired at the bound without any observe()');
  watch.observe('B', true); watch.observe(null, false); now += PENDING_LIMIT_MS; fire(); assert.deepEqual(fired, ['A'], 'an answer cancels');
  watch.observe('C', true); watch.observe('D', true); assert.equal(timers.size, 1, 'another subject replaces it');
  now += PENDING_LIMIT_MS; fire(); assert.deepEqual(fired, ['A', 'D']);
  watch.observe('E', true); watch.reset(); watch.observe('F', true); watch.dispose(); assert.equal(timers.size, 0);
});

test('the copy names the deployment and what happened', () => {
  assert.equal(unservedText(NOT_SERVED_CODE, '/d/oats-v2'), "This Desktop's server isn't serving this deployment: /d/oats-v2. Re-add the workspace, or retry.");
  assert.equal(unservedText(NO_ANSWER_CODE, '/d/oats-v2'), "No answer from the Desktop's server for this deployment: /d/oats-v2. Retry, or check the OATS CLI.");
  const error = unservedError(NOT_SERVED_CODE, '/d/x'); assert.equal(error.code, NOT_SERVED_CODE); assert.equal(error.workspace, '/d/x');
});

/* ── the observation pool ─────────────────────────────────────────────────── */
test('mapBounded: every item runs, never more than the limit at once, a slow one does not starve the rest, order kept', async () => {
  const gates = new Map(), started = []; let inFlight = 0, peak = 0;
  const run = mapBounded(['d1', 'd2', 'd3', 'd4'], MAX_DEPLOYMENT_OBSERVATIONS, item => new Promise(resolve => {
    started.push(item); inFlight++; peak = Math.max(peak, inFlight);
    gates.set(item, () => { inFlight--; resolve(`${item}:read`); });
  }));
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush(); assert.deepEqual(started, ['d1', 'd2']);
  gates.get('d2')(); await flush(); assert.deepEqual(started, ['d1', 'd2', 'd3'], 'd1 is slow: d3 takes the free slot');
  gates.get('d3')(); await flush(); assert.deepEqual(started, ['d1', 'd2', 'd3', 'd4']);
  gates.get('d4')(); gates.get('d1')();
  assert.deepEqual(await run, ['d1:read', 'd2:read', 'd3:read', 'd4:read']);
  assert.equal(peak, MAX_DEPLOYMENT_OBSERVATIONS);
  assert.deepEqual(await mapBounded([], 2, () => assert.fail()), []);
});

/* ── the failed block's second action ─────────────────────────────────────── */
test('the failed block carries Re-add beside Retry, updated in place, inert while busy, gone when not asked for', t => {
  const dom = new JSDOM('<div id="r"></div><p id="s"></p>'); t.after(() => dom.window.close());
  const doc = dom.window.document, region = doc.getElementById('r');
  let activated = 0, retried = 0;
  const state = createDataState({ doc, noun: 'instances', region, status: doc.getElementById('s'), onRetry: () => { retried++; }, setTimeout: () => 0, clearTimeout: () => {} });
  const action = { label: 'Re-add workspace', onActivate: () => { activated++; } };
  state.begin(); state.fail(unservedError(NOT_SERVED_CODE, '/d/x'), { action });
  const button = region.querySelector('.loading-failed .loading-action');
  assert.equal(button.textContent, 'Re-add workspace'); assert.equal(button.type, 'button');
  button.click(); assert.equal(activated, 1);
  state.begin(); assert.equal(button.getAttribute('aria-disabled'), 'true'); button.click(); assert.equal(activated, 1, 'inert while a read runs');
  state.fail(unservedError(NOT_SERVED_CODE, '/d/x'), { action });
  assert.equal(region.querySelector('.loading-action'), button, 'the same element: focus survives a repeat');
  button.click(); assert.equal(activated, 2);
  state.begin(); state.fail(unservedError(NO_ANSWER_CODE, '/d/x'));
  assert.equal(region.querySelector('.loading-action'), null, 'no Re-add for a deployment that is served');
  assert.equal(retried, 0);
  const plain = failedElement(doc, { message: 'm' }); assert.equal(plain.querySelector('.loading-action'), null);
});
