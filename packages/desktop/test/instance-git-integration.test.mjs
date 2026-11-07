import { controlHeaders } from './helpers/control-auth.mjs';
// Real HTTP callback, proxy URL, host and shipped shell composition, with inert
// executors/DOM. No listener, CLI, terminal process, browser or Electron launch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { apiUrl } from '../api-url.mjs';
import { cliInstanceGit } from '../../client/cli-adapter.mjs';
import { createInstanceGitBoundary } from '../server/instance-git.mjs';
import { createContextPanel, contextPanelCSS } from '../renderer/context-panel.mjs';
import { createInstanceGitPanel, instanceGitCSS } from '../renderer/instance-git.mjs';
import { createInstanceTeamsSection } from '../renderer/instance-teams.mjs';
import { createInstanceSoulSection } from '../renderer/instance-soul.mjs';
import { createSelectionOwnership } from '../renderer/selection-ownership.mjs';
import { getBinding, formatChord } from '../renderer/keybindings.mjs';
import { deploymentDoubles } from './helpers/deployment-doubles.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const cli = { ok: true, bin: '/fixture/oats', version: '0.24.7' };
const instance = (name = 'dev-1', root = '/A/agents') => ({ instance: name, agent: 'dev', agentsRoot: root, home: `${root}/dev/instances/${name}`, running: true });
const selector = i => ({ instance: i.instance, agent: i.agent, agentsRoot: i.agentsRoot, server: i.server ?? null });
const observation = i => ({ revision: 'a'.repeat(40), indexRevision: 'b'.repeat(40), at: '2026-09-22T00:00:00.000Z', worktree: `${i.home}/work`, branch: 'main', detached: false, unborn: false });
const state = (i = instance()) => ({ instanceGitApi: 1, instance: i.instance, agent: i.agent, home: i.home, workMode: 'worktree', observation: observation(i),
  recorded: { branch: 'main', repo: '/repo', drift: false }, upstream: { ref: null, ahead: null, behind: null }, base: { ref: null, source: null, mergeBase: null, ahead: null, behind: null },
  summary: { changed: 1, renamed: 0, copied: 0, unmerged: 0, untracked: 0 }, files: [{ id: 'c'.repeat(24), kind: 'changed', xy: '.M', submodule: false, path: 'file.txt', origPath: null }], notes: [] });
const envelope = result => ({ schemaVersion: 1, ok: true, result });
const wrapped = (i = instance(), workspace = '/A') => ({ instanceGitApi: 1, minimumVersion: '0.24.7', status: 'available', reason: null,
  target: { ...selector(i), home: i.home, workspace }, data: state(i) });
function http({ exec = (_b, _a, _o, done) => done(null, JSON.stringify(envelope(state()))), snapshots, transform = s => s } = {}) {
  const source = transform(readFileSync(new URL('../server/oats-web.mjs', import.meta.url), 'utf8'));
  const start = source.indexOf('const send = (res, code, body, type'), end = source.indexOf('\n// No upgrade transport');
  assert.ok(start > 0 && end > start);
  let executions = 0, lookups = 0; const seen = [];
  const read = createInstanceGitBoundary({ invoke: (bin, opts) => cliInstanceGit(bin, opts, { exec(...args) { executions++; seen.push({ bin: args[0], argv: args[1], opts: args[2] }); return exec(...args); } }) });
  const deps = { createServer: fn => fn, instanceGitRequest: read, cliState: cli, ctxs: ['/Users/me/work'],
    ...deploymentDoubles(() => { lookups++; return [{ id: '/A', scope: '/server-scope' }, { id: '/B', scope: '/other-scope' }]; }),
    snapshot: { byWs: snapshots ?? new Map([['/A', { instances: [instance()] }], ['/B', { instances: [instance('dev-1', '/B/agents')] }]]) },
    panelData: assert.fail, snapshotPanel: assert.fail, collectNow: assert.fail,
  };
  const handler = new Function(...Object.keys(deps), `${source.slice(start, end)}\nreturn server;`)(...Object.values(deps));
  return { seen, counts: () => ({ executions, lookups }), async request({ url = '/api/instance-git?ws=%2FA', method = 'POST', body = JSON.stringify({ action: 'git', selector: selector(instance()) }), chunks,
    headers = { host: '127.0.0.1:4820', origin: 'http://127.0.0.1:4820' } } = {}) {
    const req = new EventEmitter(); Object.assign(req, { url, method, headers: controlHeaders(headers) }); let result;
    const res = { writeHead(status, headers) { result = { status, headers }; }, end(raw) { result.body = JSON.parse(raw); } };
    const waiting = handler(req, res); for (const chunk of chunks || [Buffer.from(body)]) req.emit('data', chunk); req.emit('end'); await waiting;
    assert.ok(result); return result;
  } };
}

test('HTTP Host/Origin rejection precedes body, workspace lookup and command execution', async () => {
  const h = http({ exec: assert.fail });
  for (const headers of [{}, { host: 'evil.invalid' }, { host: '127.0.0.1.evil.invalid' }, { host: 'localhost', origin: 'https://evil.invalid' },
    { host: 'localhost', origin: 'null' }, { host: 'localhost', origin: 'not a url' }]) {
    const response = await h.request({ headers, body: '{malformed' }); assert.equal(response.status, 403);
  }
  assert.deepEqual(h.counts(), { executions: 0, lookups: 0 });
});

test('HTTP GET, malformed JSON, byte overflow, duplicate/extra/missing workspace selectors never execute', async () => {
  const h = http({ exec: assert.fail });
  assert.equal((await h.request({ method: 'GET' })).status, 404);
  for (const body of ['{', 'null', '[]', '0', '"x"', ' '.repeat(65537), JSON.stringify({ unused: 'é'.repeat(33000) })]) {
    const r = await h.request({ body }); assert.equal(r.status, 400); assert.equal(r.body.code, 'E_BAD_ARGS');
  }
  for (const url of ['/api/instance-git', '/api/instance-git?ws=', '/api/instance-git?ws=/A&ws=/A', '/api/instance-git?ws=/A&home=/x', '/api/instance-git?ws=/A&server=x']) {
    const r = await h.request({ url }); assert.equal(r.status, 400); assert.equal(r.body.code, 'E_BAD_ARGS');
  }
  assert.equal(h.counts().executions, 0);
});

test('HTTP dispatch uses the exact snapshot and server-resolved home/scope; no synchronous collector or fallback', async () => {
  const h = http(); const result = await h.request();
  assert.equal(result.status, 200); assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.body.status, 'available');
  assert.deepEqual(h.seen[0].argv, ['instance', 'git', 'dev-1', '--dir', '/server-scope', '--home', instance().home, '--json']);
  assert.equal(h.seen[0].opts.cwd, '/server-scope');
  const stale = http({ snapshots: new Map([['/B', { instances: [instance()] }]]), exec: assert.fail });
  assert.equal((await stale.request()).body.reason.code, 'E_SESSION_UNKNOWN', 'missing A snapshot cannot use B even when its tuple matches');
  assert.equal((await stale.request({ url: '/api/instance-git?ws=/foreign' })).body.reason.code, 'E_WORKSPACE_UNKNOWN');
  for (const forged of [{ home: '/foreign' }, { path: '/secret' }, { argv: ['spawn'] }, { env: {} }]) {
    const r = await stale.request({ body: JSON.stringify({ action: 'git', selector: selector(instance()), ...forged }) }); assert.equal(r.body.reason.code, 'E_BAD_ARGS');
  }
});

test('UTF8 split chunks preserve literal root identity; only a server roster match can authorize it', async () => {
  const i = instance('dev-1', '/A/agents-é'), body = Buffer.from(JSON.stringify({ action: 'git', selector: selector(i) }));
  const at = body.indexOf(Buffer.from('é')) + 1;
  const h = http({ snapshots: new Map([['/A', { instances: [i] }]]), exec: (_b, _a, _o, done) => done(null, JSON.stringify(envelope(state(i)))) });
  const response = await h.request({ chunks: [body.subarray(0, at), body.subarray(at)] });
  assert.equal(response.body.status, 'available'); assert.equal(h.seen[0].argv[6], i.home);
});

test('HTTP concurrent reads share only their in-flight request; stale diagnostics remain sanitized', async () => {
  let done; const h = http({ exec: (_b, _a, _o, callback) => { done = callback; } });
  const body = JSON.stringify({ action: 'diff', selector: selector(instance()), fileId: 'c'.repeat(24), revision: 'a'.repeat(40), indexRevision: 'b'.repeat(40) });
  const reads = Array.from({ length: 5 }, () => h.request({ body })); await tick(); assert.equal(h.counts().executions, 1);
  done(new Error('SECRET'), JSON.stringify({ schemaVersion: 1, ok: false, error: { code: 'E_STALE_OBSERVATION', message: 'SECRET', details: { observation: { ...observation(instance()), private: 'SECRET' } } } }));
  const results = await Promise.all(reads);
  assert.ok(results.every(r => r.body.status === 'stale')); assert.doesNotMatch(JSON.stringify(results), /SECRET/);
  const next = h.request({ body }); await tick(); assert.equal(h.counts().executions, 2);
  done(new Error('SECRET'), 'unknown command instance', 'SECRET stderr');
  assert.equal((await next).body.status, 'unavailable');
});

test('privileged proxy pins the new instance-addressed route and never admits foreign origin/workspace', () => {
  const base = 'http://127.0.0.1:4820', allowed = new Set(['/A', '/B']);
  for (const query of ['', '?ws=/foreign']) assert.equal(apiUrl(`/api/instance-git${query}`, base, '/A', allowed).searchParams.get('ws'), '/A');
  assert.equal(apiUrl('/api/instance-git?ws=/B', base, '/A', allowed).searchParams.get('ws'), '/B');
  for (const path of ['//evil.invalid/api/instance-git', '/\\evil.invalid/api/instance-git']) assert.throws(() => apiUrl(path, base, '/A', allowed), /off-origin/);
});

function shell(t) {
  const dom = new JSDOM('<div id="app"><input id="terminal"><aside id="context-panel"></aside></div>');
  const document = dom.window.document; const style = document.createElement('style'); style.textContent = contextPanelCSS + instanceGitCSS; document.head.append(style);
  const calls = [], pending = [];
  const c = { document, window: dom.window, createContextPanel, createInstanceGitPanel, createInstanceTeamsSection, createInstanceSoulSection, workspace: '/A', gen: 0, currentWorkspace: () => c.workspace,
    connectionGeneration: 0, subscribeConnections: () => () => {}, ctx: { openExternal: assert.fail }, openConnections: assert.fail,
    getBinding, formatChord, stableFocusTarget: () => null,
    // The user has opened the instance panel (Spec B: a per-machine preference, closed until then).
    localStorage: { getItem: key => key === 'oats-desktop-instance-panel-open' ? '1' : null, setItem() {}, removeItem() {} },
    workspaceGeneration: () => c.gen, updateSidebarControls() {}, api(path, opts) {
      const d = deferred(); calls.push({ path, ...opts, body: JSON.parse(opts.body) }); pending.push(d); return d.promise;
    } };
  c.tabOpenIntents = createSelectionOwnership(c);
  const source = readFileSync(new URL('../renderer/shell.mjs', import.meta.url), 'utf8');
  const setup = source.slice(source.indexOf('const contextPanel = createContextPanel'), source.indexOf('/** Projection only:'));
  const panel = runInNewContext(`${setup}\ncontextPanel`, c), root = document.getElementById('context-panel');
  t.after(() => { panel.dispose(); dom.window.close(); });
  const select = (i = instance(), ws = '/A') => { if (ws !== c.workspace) c.gen++; c.workspace = ws; panel.setContext({ workspace: ws, instance: i, key: `${ws}:${i.home}` }); };
  return { dom, document, panel, root, c, calls, pending, select, tab: name => root.querySelector(`[data-context-tab="${name}"]`).click() };
}

test('shipped shell factory reads only visible selected Git, captures workspace and never serializes home', async t => {
  const u = shell(t); u.select(); assert.equal(u.calls.length, 0);
  const input = u.document.getElementById('terminal'); input.focus(); u.tab('git'); assert.equal(u.calls.length, 1);
  assert.equal(u.calls[0].path, '/api/instance-git?ws=%2FA'); assert.equal(u.calls[0].method, 'POST');
  assert.deepEqual(u.calls[0].body, { action: 'git', selector: selector(instance()) });
  assert.equal(u.calls[0].headers['content-type'], 'application/json');
  u.pending[0].resolve(wrapped()); await tick(); assert.equal(u.document.activeElement, input);
  const row = u.root.querySelector('.git-file');
  for (let n = 0; n < 3; n++) u.select();
  assert.equal(u.root.querySelector('.git-file'), row); assert.equal(u.calls.length, 1, 'metadata polling is not command polling');
});

for (const boundary of ['collapse', 'focus mode', 'stage cover', 'workspace', 'dispose']) for (const outcome of ['success', 'reject']) {
  test(`real host ${boundary} revokes pending Git ${outcome}`, async t => {
    const u = shell(t); u.select(); u.tab('git');
    if (boundary === 'collapse') u.panel.setCollapsed(true);
    else if (boundary === 'focus mode') u.panel.setFocusMode(true);
    else if (boundary === 'stage cover') { const owner = {}, element = u.document.createElement('div'); element.textContent = 'Stage'; u.panel.attach(owner, element); u.panel.setContext({ workspace: '/A', owner }); }
    else if (boundary === 'workspace') { u.select(instance('dev-1', '/B/agents'), '/B'); u.select(); }
    else u.panel.dispose();
    const before = u.root.innerHTML;
    if (outcome === 'success') u.pending[0].resolve(wrapped()); else u.pending[0].reject(new Error('OLD'));
    await tick(); assert.equal(u.root.innerHTML, before); assert.doesNotMatch(u.root.textContent, /OLD/);
    if (boundary === 'collapse') { u.panel.setCollapsed(false); assert.equal(u.calls.length, 2); }
    if (boundary === 'focus mode') { u.panel.setFocusMode(false); assert.equal(u.calls.length, 2); }
  });
}

test('stale-recovery focus stays projection-owned; native panel entry still supersedes pending terminal opens', async t => {
  const u = shell(t); u.select(); u.tab('git'); u.pending[0].resolve(wrapped()); await tick();
  const b = u.root.querySelector('.git-file'); b.focus();
  const owns = u.c.tabOpenIntents.begin(); b.click();
  u.pending[1].resolve({ ...wrapped(), data: null, status: 'stale', reason: { code: 'E_STALE_OBSERVATION', message: 'Moved', observation: observation(instance()) } }); await tick();
  assert.equal(u.document.activeElement.textContent, 'Refresh'); assert.equal(owns(), true, 'controller fallback focus is not new user intent');
  u.pending[2].resolve(wrapped()); await tick(); assert.equal(owns(), true);
  u.root.querySelector('.git-file').focus(); assert.equal(owns(), false, 'real user entry remains an intent');
});
