// No cross-workspace fallback (#481, item 9): a request from a window bound to a workspace carries
// that window's workspace. An implicit ?ws= is pinned to the window's workspace, never main's single
// verified workspace; an advertised explicit ?ws= passes unchanged; an unadvertised one is refused with
// 404 E_WORKSPACE_NOT_SERVED on every workspace-scoped route; with no advertised set known, the
// request passes unrewritten. An unbound window keeps the rewrite to the verified workspace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiUrl, workspaceScoped, windowRefusal } from '../api-url.mjs';

const VERIFIED = '/d/first';
const WINDOW = 'ws:0123456789abcdef0123';
const ADVERTISED = new Set([VERIFIED, WINDOW, '/d/second', 'remote:altair:/srv/agents']);
const SCOPED = ['/api/panel', '/api/agents', '/api/spawn', '/api/automations', '/api/forge-roster', '/api/team-members',
  '/api/instance-lifecycle', '/api/instance-git', '/api/instance-events', '/api/workspace-readiness', '/api/workspace-spawn-preview',
  '/api/workspace-sync', '/api/brain/notes', '/api/start/dev', '/api/restart/dev'];
// The last four were instance routes until #609 and #627: they are no route now, so nothing pins or refuses them.
const UNSCOPED = ['/api/cli', '/api/version', '/api/forge-connections', '/api/capabilities', '/api/window-state',
  '/api/session/x', '/api/keys/x', '/api/interrupt/x', '/api/chat/x'];

test('workspaceScoped names exactly the routes main pins a workspace onto', () => {
  for (const path of SCOPED) assert.equal(workspaceScoped(path), true, path);
  for (const path of UNSCOPED) assert.equal(workspaceScoped(path), false, path);
});

test('bound window: an implicit ?ws= is the window\'s workspace, never the verified one', () => {
  for (const path of SCOPED) {
    assert.equal(windowRefusal(path, WINDOW, ADVERTISED), null, path);
    assert.equal(apiUrl(path, WINDOW, ADVERTISED, { bound: true }).searchParams.get('ws'), WINDOW, path);
  }
});

test('bound window: an advertised explicit ?ws= (a deployment its rows address) passes unchanged', () => {
  for (const path of SCOPED) {
    const asked = `${path}?ws=${encodeURIComponent('/d/second')}`;
    assert.equal(windowRefusal(asked, WINDOW, ADVERTISED), null, path);
    assert.equal(apiUrl(asked, WINDOW, ADVERTISED, { bound: true }).searchParams.get('ws'), '/d/second', path);
  }
});

test('bound window: an unadvertised workspace is refused on every workspace-scoped route', () => {
  for (const path of SCOPED) {
    // The window's own workspace, implicit, when the server stopped serving it.
    assert.equal(windowRefusal(path, '/d/gone', ADVERTISED), '/d/gone', path);
    // An explicit selector the server does not advertise: a path, a view id, a remote, any id.
    for (const id of ['/d/gone', 'ws:ffffffffffffffffffff', 'remote:rigel:/x', 'anything']) {
      assert.equal(windowRefusal(`${path}?ws=${encodeURIComponent(id)}`, WINDOW, ADVERTISED), id, `${path} ${id}`);
    }
    // A duplicate selector naming one unadvertised id is refused too.
    assert.equal(windowRefusal(`${path}?ws=${encodeURIComponent(VERIFIED)}&ws=%2Fd%2Fgone`, WINDOW, ADVERTISED), '/d/gone', path);
  }
});

test('bound window: routes outside the workspace scope are never refused by workspace', () => {
  for (const path of UNSCOPED) assert.equal(windowRefusal(`${path}?ws=%2Fd%2Fgone`, '/d/gone', ADVERTISED), null, path);
});

test('bound window: with no advertised set known, the request passes unrewritten', () => {
  for (const advertised of [new Set(), undefined, null]) {
    assert.equal(windowRefusal('/api/panel?ws=%2Fd%2Fgone', WINDOW, advertised), null);
    assert.equal(apiUrl('/api/panel?ws=%2Fd%2Fgone', WINDOW, advertised, { bound: true }).searchParams.get('ws'), '/d/gone');
    assert.equal(apiUrl('/api/panel', WINDOW, advertised, { bound: true }).searchParams.get('ws'), WINDOW);
  }
});

test('unbound window: today\'s rewrite to the verified workspace is kept', () => {
  assert.equal(windowRefusal('/api/panel?ws=%2Fd%2Fgone', null, ADVERTISED), null, 'an unbound window is not refused here');
  assert.equal(apiUrl('/api/panel?ws=%2Fd%2Fgone', VERIFIED, ADVERTISED).searchParams.get('ws'), VERIFIED);
  assert.equal(apiUrl('/api/panel', VERIFIED, ADVERTISED).searchParams.get('ws'), VERIFIED);
});

test('bound window: off-origin and malformed paths are still refused by apiUrl', () => {
  assert.throws(() => apiUrl('//attacker/x', WINDOW, ADVERTISED, { bound: true }), /off-origin/);
  assert.throws(() => apiUrl('api/panel', WINDOW, ADVERTISED, { bound: true }), /must start with/);
  assert.equal(windowRefusal('//attacker/api/panel', '/d/gone', ADVERTISED), null, 'left to apiUrl, which throws');
});

test('every specialized proxy pins a bound window\'s workspace and never rewrites its explicit selector', async () => {
  const { proxyReadiness } = await import('../readiness-proxy.mjs');
  const { proxySpawnPreview } = await import('../spawn-preview-proxy.mjs');
  const { proxyInstanceEvents } = await import('../instance-events-proxy.mjs');
  const { proxySpawnApply } = await import('../spawn-apply-proxy.mjs');
  const { request: eventsRequestBody } = await import('./helpers/instance-events-fixture.mjs');
  const { workspaceHash } = await import('../renderer/window-binding.mjs');
  const renderer = 'file:///app/renderer/index.html';
  const frame = { url: `${renderer}${workspaceHash(WINDOW)}` };
  const event = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false } };
  const routes = [
    [proxyReadiness, '/api/workspace-readiness', { method: 'POST', body: '{}' }],
    [proxySpawnPreview, '/api/workspace-spawn-preview', { method: 'POST', body: '{}' }],
    [proxyInstanceEvents, '/api/instance-events', { method: 'POST', body: JSON.stringify(eventsRequestBody()) }],
    [proxySpawnApply, '/api/spawn', { method: 'POST', body: JSON.stringify({ name: 'x' }) }],
  ];
  for (const [proxy, path, opts] of routes) {
    // The last case tells bound from unbound: with nothing advertised yet, an unbound window's selector
    // would be rewritten to the verified workspace; a bound window's passes unrewritten.
    for (const [asked, expected, allowedWs] of [['', WINDOW, ADVERTISED], [`?ws=${encodeURIComponent('/d/second')}`, '/d/second', ADVERTISED],
      [`?ws=${encodeURIComponent('/d/later')}`, '/d/later', new Set()]]) {
      const fetched = [];
      await proxy(event, `${path}${asked}`, opts, { rendererURL: renderer,
        connection: () => ({ wsId: WINDOW, allowedWs, bound: true, epoch: 1, transition: false }),
        fetch: async (path) => { assert.ok(typeof path === 'string' && path.startsWith('/api/'), `a proxy fetches a path: ${path}`); fetched.push(new URL(path, 'http://oats-backend.invalid').searchParams.getAll('ws')); return { ok: false, status: 500, text: async () => '{}' }; } });
      assert.deepEqual(fetched, [[expected]], `${path}${asked}`);
    }
  }
});

/* ── the shipped api handler ───────────────────────────────────────────────── */
import { shippedMainApi } from './helpers/shipped-main-api.mjs';
import { classifyApiRoute } from '../api-url.mjs';
import { NOT_SERVED_CODE } from '../renderer/deployment-header.mjs';

const shippedApi = ({ window, advertised = ADVERTISED, reread = null, served = [], chooser = false, holds }) =>
  shippedMainApi({ window, chooser, wsId: VERIFIED, advertised, reread, served, ...(holds ? { holds } : {}) });

test('shipped api: a bound window\'s read for an unserved workspace is 404 E_WORKSPACE_NOT_SERVED on every route, never fetched', async () => {
  for (const path of SCOPED) {
    const api = shippedApi({ window: '/d/gone' });
    const reply = await api.call(path);
    assert.equal(reply.status, 404, path); assert.equal(reply.body.code, NOT_SERVED_CODE, path); assert.equal(reply.body.workspace, '/d/gone');
    assert.deepEqual(api.fetched, [], `${path}: no other workspace's data`);
    const explicit = await shippedApi({ window: WINDOW }).call(`${path}?ws=${encodeURIComponent('/d/gone')}`);
    assert.equal(explicit.status, 404, `${path} explicit`);
  }
});

test('shipped api: a bound window\'s implicit read is its own workspace; an unbound window\'s is the verified one', async () => {
  // The four specialized proxies pin through their connection (tested above); here, every other route.
  const proxied = ['readiness', 'spawn-preview', 'instance-events', 'spawn-apply'];
  for (const path of SCOPED.filter((p) => !proxied.includes(classifyApiRoute(p)))) {
    const bound = shippedApi({ window: WINDOW });
    await bound.call(path);
    assert.deepEqual(bound.fetched.map((u) => u.searchParams.get('ws')), [WINDOW], path);
    const unbound = shippedApi({ window: null });
    await unbound.call(path);
    assert.equal(unbound.fetched.length, 1, path);
  }
  const unbound = shippedApi({ window: null });
  await unbound.call('/api/panel');
  assert.equal(unbound.fetched[0].searchParams.get('ws'), VERIFIED);
});

test('shipped api: a start or restart is pinned to its window, refused for an unserved workspace before the backend, and passes a served one unchanged (#818)', async () => {
  const REMOTE = 'remote:altair:/srv/agents';
  for (const ep of ['start', 'restart']) {
    // No ws: the window's own workspace, the row's qualifiers untouched.
    const implicit = shippedApi({ window: WINDOW });
    assert.equal((await implicit.call(`/api/${ep}/dev?home=%2Fh`)).status, 200, ep);
    assert.deepEqual(implicit.fetched.map((u) => [u.pathname, u.searchParams.get('ws'), u.searchParams.get('home')]), [[`/api/${ep}/dev`, WINDOW, '/h']], ep);
    // An unserved ws, explicit (a path, a view id, a remote) or the window's own: refused, nothing fetched.
    for (const id of ['/d/gone', 'ws:ffffffffffffffffffff', 'remote:rigel:/x']) {
      const api = shippedApi({ window: WINDOW });
      const reply = await api.call(`/api/${ep}/dev?ws=${encodeURIComponent(id)}&home=%2Fh`);
      assert.equal(reply.status, 404, `${ep} ${id}`); assert.equal(reply.body.code, NOT_SERVED_CODE, `${ep} ${id}`); assert.equal(reply.body.workspace, id);
      assert.deepEqual(api.fetched, [], `${ep} ${id}: never reaches the backend`);
    }
    const gone = shippedApi({ window: '/d/gone' });
    assert.equal((await gone.call(`/api/${ep}/dev`)).body.code, NOT_SERVED_CODE, `${ep}: the window's own, no longer served`);
    assert.deepEqual(gone.fetched, []);
    // A served ws (a local deployment, a remote one): passed unchanged.
    for (const [id, query] of [['/d/second', 'home=%2Fh'], [REMOTE, 'home=%2Fsrv%2Fh&server=altair']]) {
      const api = shippedApi({ window: WINDOW });
      assert.equal((await api.call(`/api/${ep}/dev?${query}&ws=${encodeURIComponent(id)}`)).status, 200, `${ep} ${id}`);
      assert.equal(api.fetched.length, 1, `${ep} ${id}`);
      assert.equal(api.fetched[0].search, `?${query}&ws=${encodeURIComponent(id)}`, `${ep} ${id}: unchanged`);
    }
  }
});

test('shipped api: main re-reads what the server advertises before refusing, so a workspace served since is answered', async () => {
  // Main learns the advertised set from panel replies; a window bound to a view the server observed since
  // (its identity read after startup) must not be refused on that stale set, or nothing would ever update it.
  const stale = new Set([VERIFIED]);
  const api = shippedApi({ window: WINDOW, advertised: stale, reread: new Set([VERIFIED, WINDOW]) });
  const reply = await api.call('/api/panel');
  assert.equal(reply.status, 200); assert.equal(api.calls.rereads, 1);
  assert.deepEqual(api.fetched.map((u) => u.searchParams.get('ws')), [WINDOW]);
  const still = shippedApi({ window: '/d/gone', advertised: stale, reread: new Set([VERIFIED]) });
  assert.equal((await still.call('/api/panel')).status, 404, 'still not served after the re-read: refused');
  assert.deepEqual(still.fetched, []);
  const served = shippedApi({ window: WINDOW });
  await served.call('/api/panel');
  assert.equal(served.calls.rereads, 0, 'an advertised workspace costs no re-read');
});

test('shipped api: the refusal carries the served choices, so a window can find the view that holds its deployments now', async () => {
  const served = [{ id: WINDOW, name: 'oats', deployments: ['/d/second'] }];
  const reply = await shippedApi({ window: 'ws:goneeeeeeeeeeeeeeeee', served }).call('/api/panel');
  assert.equal(reply.status, 404); assert.equal(reply.body.code, NOT_SERVED_CODE);
  assert.deepEqual(JSON.parse(JSON.stringify(reply.body.workspaces)), served);
});

// #1488: a take-over can move a window's binding while its page loads or reloads (the ask to release never
// reached it); until the page follows (views/common.mjs startWindow), its hash still names the workspace.
test('shipped api: a window whose hash names a workspace main no longer binds it to reads nothing of it, on any scoped route', async () => {
  for (const path of SCOPED) {
    const api = shippedApi({ window: WINDOW, holds: () => false });
    const reply = await api.call(path);
    assert.equal(reply.status, 409, path); assert.equal(reply.body.code, 'E_WINDOW_NOT_BOUND', path);
    assert.deepEqual(api.fetched, [], `${path}: never fetched`);
    assert.deepEqual(api.calls.holds, [WINDOW], `${path}: asked of the hash's workspace`);
  }
  const outside = shippedApi({ window: WINDOW, holds: () => false });
  assert.equal((await outside.call('/api/cli')).status, 200, 'routes outside the workspace scope still answer');
  const held = shippedApi({ window: WINDOW });
  assert.equal((await held.call('/api/panel')).status, 200, 'a window main binds to its hash reads as before');
  assert.equal(held.fetched[0].searchParams.get('ws'), WINDOW);
  const unbound = shippedApi({ window: null, holds: () => false });
  await unbound.call('/api/agents');
  assert.equal(unbound.fetched[0].searchParams.get('ws'), VERIFIED, 'a window with no hash is not asked: it still adopts');
});

test('shipped api: a window with no workspace to read (choosing) gets no default workspace on any scoped route', async () => {
  for (const path of SCOPED) {
    const api = shippedApi({ window: null, chooser: true });
    const reply = await api.call(path);
    assert.equal(reply.status, 409, path); assert.equal(reply.body.code, 'E_NO_WORKSPACE', path);
    assert.deepEqual(api.fetched, [], `${path}: never main's verified default`);
  }
  const outside = shippedApi({ window: null, chooser: true });
  assert.equal((await outside.call('/api/cli')).status, 200, 'routes outside the workspace scope still answer');
  const adopting = shippedApi({ window: null });
  await adopting.call('/api/agents');
  assert.equal(adopting.fetched[0].searchParams.get('ws'), VERIFIED, 'a window still adopting its first workspace keeps the verified one');
});
