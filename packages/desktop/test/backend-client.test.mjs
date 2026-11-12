// backend-client.mjs (the lease and backendFetch), server-host.mjs (the lease of each server
// generation) and backend-socket.mjs (where the socket lives), through their exports. The HTTP
// transport is the one boundary replaced (an injected `request`), and child processes are fakes:
// the server itself is driven in backend-request-checks.test.mjs.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import { PassThrough } from 'node:stream';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createBackendClient, createSocketLossRecovery, watchReadyLine, READY_LINE } from '../backend-client.mjs';
import { createServerHost, launchServerChild } from '../server-host.mjs';
import { shippedMainApi } from './helpers/shipped-main-api.mjs';
import { makeSocketDir, socketBase, socketPathFits, sweepStaleSocketDirs, SOCKET_PATH_LIMIT, SocketPathTooLong } from '../backend-socket.mjs';

// A guard that goes missing lets a request reach the transport double, which waits to be answered:
// each test is bounded, so that fails as a timeout instead of hanging the run.
const test = (name, fn) => nodeTest(name, { timeout: 10_000 }, fn);
const SECRET = 'A'.repeat(43);
const tick = () => new Promise((ok) => setImmediate(ok));

/** A node:http `request` double: records every request; the test answers it. With `ignoreAbort`, it
 * goes on delivering after the request's signal aborts (a transport that ignores the signal). */
function transport({ ignoreAbort = false } = {}) {
  const made = [];
  const request = (options) => {
    const req = new EventEmitter();
    const entry = { options, req, body: '', ended: false, res: null };
    req.write = (chunk) => { entry.body += chunk; };
    req.end = () => { entry.ended = true; };
    req.destroy = (error) => { if (entry.res) entry.res.destroy(error); else req.emit('error', error ?? new Error('destroyed')); };
    if (!ignoreAbort) options.signal?.addEventListener('abort', () => {
      const error = Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (entry.res) entry.res.destroy(error); else req.emit('error', error);
    }, { once: true });
    entry.respond = (status = 200, headers = { 'content-type': 'application/json' }) => {
      const res = new PassThrough(); res.statusCode = status; res.headers = headers; entry.res = res;
      req.emit('response', res); return res;
    };
    entry.fail = (code) => req.emit('error', Object.assign(new Error(code), { code }));
    made.push(entry);
    return req;
  };
  return { request, made, last: () => made.at(-1) };
}
function readyClient(io = {}) {
  const t = transport();
  const client = createBackendClient({ request: t.request, ...io });
  const lease = client.begin({ child: {}, socketPath: '/run/oats-d-x/s', secret: SECRET });
  client.markReady(lease);
  return { t, client, lease };
}

test('A7: backendFetch sends over the lease\'s socket with host and the bearer credential', async () => {
  const { t, client } = readyClient();
  const pending = client.fetch('/api/cli', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await tick();
  const sent = t.last();
  assert.equal(sent.options.socketPath, '/run/oats-d-x/s');
  assert.equal(sent.options.path, '/api/cli');
  assert.equal(sent.options.method, 'POST');
  assert.deepEqual(sent.options.headers, { 'content-type': 'application/json', host: 'localhost', authorization: `Bearer ${SECRET}` });
  assert.equal(sent.body, '{}');
  sent.respond(200).end('{"ok":true}');
  const response = await pending;
  assert.equal(response.status, 200); assert.equal(response.ok, true);
  assert.deepEqual(await response.json(), { ok: true });
});

test('A7: a caller\'s Authorization, in any spelling or in a Headers, never reaches the server', async () => {
  const { t, client } = readyClient();
  for (const headers of [{ Authorization: 'Bearer theirs' }, { AUTHORIZATION: 'Bearer theirs', Host: 'evil' }, new Headers({ authorization: 'Bearer theirs' }),
    [['authorization', 'Bearer theirs']]]) {
    const pending = client.fetch('/api/panel', { headers });
    await tick();
    const sent = t.last().options.headers;
    assert.deepEqual(Object.keys(sent).filter((k) => k.toLowerCase() === 'authorization'), ['authorization']);
    assert.equal(sent.authorization, `Bearer ${SECRET}`);
    assert.equal(sent.host, 'localhost');
    assert.equal(Object.keys(sent).filter((k) => k.toLowerCase() === 'host').length, 1);
    t.last().respond(200).end('{}'); await pending;
  }
});

test('A7: an absolute URL or a path not starting with / is refused, nothing sent', async () => {
  const { t, client } = readyClient();
  for (const path of ['http://127.0.0.1:4820/api/cli', 'api/cli', '//evil/api/cli', '/\\evil/api', new URL('http://localhost/api/cli'), '']) {
    await assert.rejects(client.fetch(path), { code: 'E_BAD_PATH' }, String(path));
  }
  assert.equal(t.made.length, 0);
});

test('A7: with no lease, an unready lease or a revoked lease, nothing is sent', async () => {
  const t = transport();
  const client = createBackendClient({ request: t.request });
  await assert.rejects(client.fetch('/api/cli'), { code: 'E_BACKEND_UNAVAILABLE' }, 'no lease');
  const lease = client.begin({ child: {}, socketPath: '/s', secret: SECRET });
  await assert.rejects(client.fetch('/api/cli'), { code: 'E_BACKEND_UNAVAILABLE' }, 'not ready');
  client.markReady(lease); client.revoke(lease);
  await assert.rejects(client.fetch('/api/cli'), { code: 'E_BACKEND_UNAVAILABLE' }, 'revoked');
  assert.equal(client.markReady(lease), false, 'a revoked lease never becomes ready again');
  assert.equal(t.made.length, 0);
});

test('A7: a reply arriving after its lease was revoked is discarded', async () => {
  const { t, client, lease } = readyClient();
  const pending = client.fetch('/api/panel');
  await tick();
  client.revoke(lease);
  t.last().respond?.(200)?.end?.('{"workspaces":[]}');
  await assert.rejects(pending, { code: 'E_BACKEND_REVOKED' });
});

test('A7: a revocation after the headers, during the body, rejects the reply', async () => {
  const { t, client, lease } = readyClient();
  const pending = client.fetch('/api/panel');
  await tick();
  const res = t.last().respond(200);
  res.write('{"workspaces":');
  await tick();
  client.revoke(lease);
  res.end('[]}');
  await assert.rejects(pending, { code: 'E_BACKEND_REVOKED' });
});

test('A7: even through a transport that ignores the abort, a reply finished after its lease was revoked is discarded', async () => {
  const t = transport({ ignoreAbort: true });
  const client = createBackendClient({ request: t.request });
  const lease = client.begin({ child: {}, socketPath: '/run/oats-d-x/s', secret: SECRET });
  client.markReady(lease);
  const pending = client.fetch('/api/panel');
  await tick();
  const res = t.last().respond(200);
  res.write('{"workspaces":');
  await tick();
  client.revoke(lease);
  res.end('[]}');
  await assert.rejects(pending, { code: 'E_BACKEND_REVOKED' }, 'checked after the last byte, not only through the signal');
});

test('A7: a reply resolves only once its last byte is in, and over budget it fails', async () => {
  const { t, client } = createBackendClientWithBudget(16);
  const pending = client.fetch('/api/panel');
  await tick();
  t.last().respond(200).end('x'.repeat(17));
  await assert.rejects(pending, { code: 'E_BACKEND_REPLY_LIMIT' });
});
function createBackendClientWithBudget(maxBytes) {
  const t = transport();
  const client = createBackendClient({ request: t.request, maxBytes });
  client.markReady(client.begin({ child: {}, socketPath: '/s', secret: SECRET }));
  return { t, client };
}

test('A7: the caller\'s signal aborts the request', async () => {
  const { t, client } = readyClient();
  const abort = new AbortController();
  const pending = client.fetch('/api/panel', { signal: abort.signal });
  await tick();
  abort.abort();
  await assert.rejects(pending, (e) => e?.name === 'AbortError');
  assert.equal(t.made.length, 1);
});

test('A7: panelWorkspaces commits nothing when the lease is revoked between its read and noteServed', async () => {
  // main.mjs's own panelWorkspaces, over the real client and a revocation once the reply is in.
  const source = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function panelWorkspaces() {'), end = source.indexOf('\n}\n', start) + 3;
  assert.ok(start > 0 && end > start);
  const { t, client, lease } = readyClient();
  const noted = [];
  let revokeOnJson = false;
  const backendFetch = async (path, init) => {
    const r = await client.fetch(path, init);
    if (!revokeOnJson) return r;
    return { ok: r.ok, status: r.status, json: async () => { const v = await r.json(); client.revoke(lease); return v; } };
  };
  const context = { backendFetch, serverHost: { lease: () => client.current() ?? lease }, serverEpoch: 0, servedSelectors: (l) => new Set(l.map((w) => w.id)),
    noteServed: (list) => noted.push(list), allowedWs: new Set(), AbortSignal };
  runInNewContext(`${source.slice(start, end)}\nthis.panelWorkspaces = panelWorkspaces;`, context);
  const answer = async () => { await tick(); t.last().respond(200).end(JSON.stringify({ workspaces: [{ id: '/w' }] })); };
  const [first] = await Promise.all([context.panelWorkspaces(), answer()]);
  assert.deepEqual(first, [{ id: '/w' }], 'a current reply commits');
  assert.equal(noted.length, 1);
  revokeOnJson = true;
  const [second] = await Promise.all([context.panelWorkspaces(), answer()]);
  assert.equal(second, null, 'a reply whose lease was revoked meanwhile commits nothing');
  assert.equal(noted.length, 1, 'noteServed not called again');
});

/* ── The lease of a server generation (server-host.mjs) ── */
function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new PassThrough(); c.killed = [];
  c.kill = (sig) => { c.killed.push(sig || 'SIGTERM'); };
  return c;
}
function host() {
  const t = transport();
  const client = createBackendClient({ request: t.request });
  const spawned = [], removed = [];
  let n = 0;
  const h = createServerHost({ client, forceKillMs: 50, onInvalidate: () => {},
    spawnChild: () => { const child = fakeChild(), id = ++n, entry = { child, socketPath: `/run/oats-d-${id}/s`, secret: String(id).repeat(43).slice(0, 43), remove: () => removed.push(id) }; spawned.push(entry); return entry; } });
  return { t, client, h, spawned, removed };
}

test('A8: a lease is ready only after its child\'s ready line', async () => {
  const { t, client, h, spawned } = host();
  h.start([]);
  await assert.rejects(client.fetch('/api/version'), { code: 'E_BACKEND_UNAVAILABLE' });
  spawned[0].child.stdout.write('oats-desktop server — API on a private socket\noats-desktop-server rea');
  await tick();
  await assert.rejects(client.fetch('/api/version'), { code: 'E_BACKEND_UNAVAILABLE' }, 'half a line is not the line');
  spawned[0].child.stdout.write('dy\n');
  await h.whenReady();
  assert.equal(t.made.length, 0);
  const pending = client.fetch('/api/version'); await tick();
  assert.equal(t.last().options.headers.authorization, `Bearer ${spawned[0].secret}`);
  t.last().respond(200).end('{}'); await pending;
});

test('A8: a child that exits before its ready line fails the start, and nothing is sent', async () => {
  const { t, client, h, spawned, removed } = host();
  h.start([]);
  const ready = h.whenReady();
  spawned[0].child.emit('exit', 1, null);
  await assert.rejects(ready);
  await assert.rejects(client.fetch('/api/version'));
  assert.equal(t.made.length, 0, 'zero requests');
  assert.deepEqual(removed, [1], 'its socket directory went with it');
});

test('A8: replace() revokes at its start; no request reaches either child with the other\'s secret', async () => {
  const { t, client, h, spawned } = host();
  h.start([]);
  spawned[0].child.stdout.write(`${READY_LINE}\n`); await h.whenReady();
  const inFlight = client.fetch('/api/panel'); await tick();
  const replacing = h.replace(['/w']);
  await assert.rejects(inFlight, { code: 'E_BACKEND_REVOKED' }, 'the old generation\'s reply is discarded');
  await assert.rejects(client.fetch('/api/panel'), { code: 'E_BACKEND_UNAVAILABLE' }, 'refused during the replacement');
  spawned[0].child.emit('exit', 0, null);
  await replacing;
  await assert.rejects(client.fetch('/api/panel'), { code: 'E_BACKEND_UNAVAILABLE' }, 'refused until the new lease is ready');
  spawned[0].child.stdout.write(`${READY_LINE}\n`); await tick(); // the OLD child's line does not make the new lease ready
  await assert.rejects(client.fetch('/api/panel'), { code: 'E_BACKEND_UNAVAILABLE' });
  spawned[1].child.stdout.write(`${READY_LINE}\n`); await h.whenReady();
  const next = client.fetch('/api/panel'); await tick();
  t.last().respond(200).end('{}'); await next;
  for (const sent of t.made) {
    const secret = sent.options.headers.authorization.slice('Bearer '.length);
    const owner = spawned.find((s) => s.socketPath === sent.options.socketPath);
    assert.equal(secret, owner.secret, `${sent.options.socketPath} got its own child's secret only`);
  }
  assert.notEqual(spawned[0].secret, spawned[1].secret);
});

test('A8: a child crash mid-request discards the reply; later requests wait for a new lease', async () => {
  const { t, client, h, spawned } = host();
  h.start([]);
  spawned[0].child.stdout.write(`${READY_LINE}\n`); await h.whenReady();
  const pending = client.fetch('/api/panel'); await tick();
  spawned[0].child.emit('exit', null, 'SIGKILL');
  await assert.rejects(pending, { code: 'E_BACKEND_REVOKED' });
  await assert.rejects(client.fetch('/api/panel'), { code: 'E_BACKEND_UNAVAILABLE' });
  assert.equal(h.current(), null);
  assert.equal(t.made.length, 1);
});

test('A8: launchServerChild writes the secret to fd 3 and ends it at once', () => {
  const written = [];
  const pipe = new EventEmitter(); pipe.end = (data) => written.push(['end', data]);
  const child = { stdio: [null, null, null, pipe] };
  const base = mkdtempSync(join(tmpdir(), 'oats-t-base-'));
  try {
    const launched = launchServerChild({ spawn: () => child, socketBase: base, spec: (socketPath) => ({ command: 'x', args: [socketPath], options: {} }) });
    assert.match(launched.secret, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(written, [['end', launched.secret]]);
    assert.equal(launched.child, child);
    launched.remove();
  } finally { rmSync(base, { recursive: true, force: true }); }
});

/* ── The socket directory (backend-socket.mjs) ── */
test('A12: the socket directory is 0700 and this uid\'s, and goes when its generation ends', async () => {
  const base = mkdtempSync(join(tmpdir(), 'oats-t-base-'));
  try {
    const t = transport();
    const client = createBackendClient({ request: t.request });
    let child;
    const h = createServerHost({ client, onInvalidate: () => {},
      spawnChild: () => launchServerChild({ spawn: () => (child = Object.assign(fakeChild(), { stdio: [] })), socketBase: base,
        spec: (socketPath) => ({ command: 'x', args: [socketPath], options: {} }) }) });
    h.start([]);
    const dir = dirname(h.lease().socketPath);
    const st = lstatSync(dir);
    assert.equal(st.isDirectory(), true);
    assert.equal(st.mode & 0o777, 0o700);
    if (process.getuid) assert.equal(st.uid, process.getuid());
    assert.match(dir, /\/oats-d-[^/]+$/);
    child.emit('exit', 0, null);
    assert.equal(existsSync(dir), false, 'removed when its generation ended');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('A12: a socket directory that is not private once made is removed and refused', () => {
  const base = mkdtempSync(join(tmpdir(), 'oats-t-base-'));
  try {
    for (const st of [{ mode: 0o40755, uid: 1000 }, { mode: 0o40700, uid: 1001 }, { mode: 0o120777, uid: 1000 }]) {
      const fake = { mkdtempSync, rmSync, lstatSync: () => ({ ...st, isDirectory: () => (st.mode & 0o170000) === 0o040000 }) };
      assert.throws(() => makeSocketDir(base, { uid: 1000, fs: fake }), /not private to this user/, JSON.stringify(st));
    }
    assert.deepEqual(readdirSync(base), [], 'each directory made is removed');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('A14: the socket base does not depend on the home or the user name', () => {
  const long = 'u'.repeat(200);
  const tmp = () => '/tmp';
  const short = socketBase({ platform: 'darwin', env: { HOME: '/h', USER: 'u' }, tmpdir: tmp, home: '/h', user: 'u' });
  const longer = socketBase({ platform: 'darwin', env: { HOME: `/home/${long}`, USER: long }, tmpdir: tmp, home: `/home/${long}`, user: long });
  assert.equal(longer.length, short.length);
  const xdg = (path, st) => socketBase({ platform: 'linux', env: { XDG_RUNTIME_DIR: path, HOME: `/home/${long}` }, uid: 1000, tmpdir: tmp,
    fs: { lstatSync: () => st } });
  const dir = (mode, uid = 1000) => ({ isDirectory: () => true, mode: 0o40000 | mode, uid });
  assert.equal(xdg('/run/user/1000', dir(0o700)), '/run/user/1000', 'a private XDG_RUNTIME_DIR');
  assert.equal(xdg('/run/user/1000', dir(0o755)), '/tmp', 'not a private one');
  assert.equal(xdg('/run/user/1000', dir(0o700, 0)), '/tmp', 'not this uid\'s');
  assert.equal(xdg('/run/user/1000', { isDirectory: () => false, mode: 0o700, uid: 1000 }), '/tmp', 'not a directory (a link)');
});

test('A14: a base that makes the socket path 104 bytes or more refuses the start, naming path, length and limit', () => {
  const base = mkdtempSync(join(tmpdir(), 'oats-t-long-'));
  try {
    // `<base>/oats-d-XXXXXX/s` is base + 16 bytes: pad the base to make it exactly 104.
    const pad = 104 - Buffer.byteLength(base) - 16 - 1;
    assert.ok(pad > 0);
    const deep = join(base, 'x'.repeat(pad));
    mkdirSync(deep);
    assert.equal(socketPathFits(join(deep, 'oats-d-XXXXXX', 's')).bytes, 104);
    let spawned = 0;
    assert.throws(() => launchServerChild({ spawn: () => { spawned++; return { stdio: [] }; }, socketBase: deep, spec: () => ({ command: 'x', args: [], options: {} }) }),
      (e) => e instanceof SocketPathTooLong && e.message.includes(join(deep, 'oats-d-XXXXXX', 's')) && e.message.includes('104') && e.message.includes(String(SOCKET_PATH_LIMIT)));
    assert.equal(spawned, 0, 'nothing started: no listener of any kind');
    const one = join(base, 'x'.repeat(pad - 1)); mkdirSync(one);
    const fits = makeSocketDir(one);
    assert.equal(Buffer.byteLength(fits.socketPath), 103);
    fits.remove();
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('a socket path over the limit says which directory to shorten, XDG_RUNTIME_DIR included', () => {
  const message = new SocketPathTooLong(`/run/${'x'.repeat(100)}/oats-d-XXXXXX/s`, 121).message;
  assert.match(message, /XDG_RUNTIME_DIR/, 'on Linux the private XDG_RUNTIME_DIR is used first, so shortening TMPDIR alone cannot help');
  assert.match(message, /TMPDIR/);
});

test('A14: ENOENT on the current lease revokes it and replaces once; again within the minute is a failed start', async () => {
  let now = 1_000_000;
  const replaced = [], failed = [];
  const lost = createSocketLossRecovery({ replace: async () => { replaced.push(now); }, fail: (m) => failed.push(m), now: () => now });
  const { t, client, lease } = readyClient({ onSocketLost: () => lost() });
  const first = client.fetch('/api/panel'); await tick();
  t.last().fail('ENOENT');
  await assert.rejects(first);
  assert.equal(lease.revoked, true, 'the lease is revoked');
  await tick();
  assert.equal(replaced.length, 1, 'exactly one replace');
  assert.deepEqual(failed, []);
  // The replacement's lease loses its socket too, 30 s later.
  const second = client.begin({ child: {}, socketPath: '/s2', secret: SECRET }); client.markReady(second);
  now += 30_000;
  const again = client.fetch('/api/panel'); await tick();
  t.last().fail('ENOENT');
  await assert.rejects(again);
  await tick();
  assert.equal(replaced.length, 1, 'no second replace inside the minute');
  assert.equal(failed.length, 1, 'a failed start');
  // Other failures, and ENOENT on a lease no longer current, replace nothing.
  const third = client.begin({ child: {}, socketPath: '/s3', secret: SECRET }); client.markReady(third);
  now += 120_000;
  const refused = client.fetch('/api/panel'); await tick();
  t.last().fail('ECONNREFUSED');
  await assert.rejects(refused);
  assert.equal(third.revoked, false);
  assert.equal(replaced.length, 1);
});

/** Set a directory's modification time `seconds` ago (a directory a Desktop made that long ago). */
const age = (dir, seconds) => { const t = new Date(Date.now() - seconds * 1000); utimesSync(dir, t, t); return dir; };

test('the stale-directory sweep removes only our own dead socket directories', async () => {
  const base = mkdtempSync(join(tmpdir(), 'oats-t-sweep-'));
  try {
    const mk = (name, mode = 0o700) => { const d = join(base, name); mkdirSync(d); chmodSync(d, mode); return age(d, 120); };
    const empty = mk('oats-d-empty');
    const other = mk('oats-d-other'); writeFileSync(join(other, 'note'), 'x'); age(other, 120);
    const open = mk('oats-d-open', 0o755);
    const notOurs = mk('something-else');
    const removed = await sweepStaleSocketDirs(base, { answers: async () => false });
    assert.deepEqual(removed, [empty]);
    for (const d of [other, open, notOurs]) assert.equal(existsSync(d), true, d);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('the sweep keeps a directory another Desktop may still be setting up: one modified in the last 60 s', async () => {
  const base = mkdtempSync(join(tmpdir(), 'oats-t-sweep-'));
  try {
    const mk = (name) => { const d = join(base, name); mkdirSync(d); chmodSync(d, 0o700); return d; };
    // Between another Desktop's mkdtemp and its server's listen: empty, or its socket bound but not yet answering.
    const fresh = mk('oats-d-fresh');
    const binding = mk('oats-d-binding');
    const bound = createNetServer(); await new Promise((ok) => bound.listen(join(binding, 's'), ok));
    const old = age(mk('oats-d-old'), 61);
    let removed;
    try { removed = await sweepStaleSocketDirs(base, { answers: async () => false }); } finally { bound.close(); }
    assert.deepEqual(removed, [old], 'only the directory older than 60 s');
    assert.equal(existsSync(fresh), true, 'a fresh empty directory survives');
    assert.equal(existsSync(binding), true, 'a fresh directory with a socket that does not answer yet survives');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('watchReadyLine fires once, on the exact line only', () => {
  const stream = new PassThrough(); let n = 0;
  watchReadyLine(stream, () => n++);
  stream.emit('data', 'x oats-desktop-server ready\n');
  stream.emit('data', 'oats-desktop-server ready please\n');
  assert.equal(n, 0);
  stream.emit('data', 'oats-desktop-server ready\r\n');
  stream.emit('data', 'oats-desktop-server ready\n');
  assert.equal(n, 1);
});

/* ── A caller that commits after a later await checks its generation right before the commit ── */
test('held(): true while its generation is the current, ready one; false once it ends, is replaced or stopped', async () => {
  const { client, h, spawned } = host();
  assert.equal(h.held()(), false, 'no generation: nothing is held');
  h.start([]);
  const unready = h.held();
  assert.equal(unready(), false, 'not ready yet');
  spawned[0].child.stdout.write(`${READY_LINE}\n`); await h.whenReady();
  const first = h.held();
  assert.equal(first(), true);
  assert.equal(unready(), true, 'the same generation, ready now');
  const replacing = h.replace([]);
  assert.equal(first(), false, 'revoked at the start of a replacement');
  spawned[0].child.emit('exit', 0, null); await replacing;
  spawned[1].child.stdout.write(`${READY_LINE}\n`); await h.whenReady();
  assert.equal(first(), false, 'a successor never counts for the generation it replaced');
  const second = h.held();
  assert.equal(second(), true);
  client.revoke(h.lease());
  assert.equal(second(), false, 'a lost socket revokes the lease while the generation is still current');
  assert.equal(h.held()(), false);
  const { h: other, spawned: others } = host();
  other.start([]); others[0].child.stdout.write(`${READY_LINE}\n`); await other.whenReady();
  const exiting = other.held();
  others[0].child.emit('exit', 1, null);
  assert.equal(exiting(), false, 'an exit ends it');
  const { h: last, spawned: lasts } = host();
  last.start([]); lasts[0].child.stdout.write(`${READY_LINE}\n`); await last.whenReady();
  const third = last.held();
  last.stop();
  assert.equal(third(), false, 'stopped');
});

/** Main's api IPC handler over the real client and host: the backend answers `body` for /api/panel, and
 * `exitDuringText` ends the child after the client has read the whole reply, before the handler resumes. */
async function panelThroughIpc({ exitDuringText }) {
  const { t, client, h, spawned } = host();
  h.start([]); spawned[0].child.stdout.write(`${READY_LINE}\n`); await h.whenReady();
  const api = shippedMainApi({ window: '/d/first', advertised: new Set(['/d/first']) });
  const commits = [], observed = [];
  Object.assign(api.context, { serverHost: h, noteServed: (list) => commits.push(list),
    resumeTrigger: { observed: (rows) => observed.push(rows) }, localDeploymentIds: () => [] });
  api.context.backendFetch = async (path, init) => {
    const r = await client.fetch(path, init);
    return { ok: r.ok, status: r.status, text: async () => { const text = await r.text(); if (exitDuringText) spawned[0].child.emit('exit', 0, null); return text; } };
  };
  const pending = api.call('/api/panel', { method: 'GET' });
  await tick();
  t.last().respond(200).end(JSON.stringify({ workspaces: [{ id: '/d/served' }], instances: [] }));
  const result = await pending;
  return { result, commits, observed, allowedWs: [...api.context.allowedWs] };
}

test('the api IPC handler commits a panel reply of the current generation', async () => {
  const { result, commits, observed, allowedWs } = await panelThroughIpc({ exitDuringText: false });
  assert.equal(result.ok, true);
  assert.deepEqual(commits, [[{ id: '/d/served' }]]);
  assert.equal(observed.length, 1);
  assert.deepEqual(allowedWs, ['/d/served']);
});

test('the api IPC handler commits nothing from a panel reply whose child exited before the handler resumed', async () => {
  const { commits, observed, allowedWs } = await panelThroughIpc({ exitDuringText: true });
  assert.deepEqual(commits, [], 'noteServed is not called');
  assert.deepEqual(observed, [], 'the resume trigger does not see its rows');
  assert.deepEqual(allowedWs, ['/d/first'], 'the advertised set is left as it was');
});

/** Main's forge readConnection over the real client and host; `exitDuringJson` ends the child after the
 * client has read the whole reply, before readConnection resumes. */
async function readConnectionThrough({ exitDuringJson }) {
  const source = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  readConnection: async connectionRef => {'), end = source.indexOf('\n  },\n', start) + 5;
  assert.ok(start > 0 && end > start);
  const { t, client, h, spawned } = host();
  h.start([]); spawned[0].child.stdout.write(`${READY_LINE}\n`); await h.whenReady();
  const backendFetch = async (path, init) => {
    const r = await client.fetch(path, init);
    return { ok: r.ok, status: r.status, json: async () => { const v = await r.json(); if (exitDuringJson) spawned[0].child.emit('exit', 0, null); return v; } };
  };
  const context = { backendFetch, serverHost: h, serverEpoch: 0, currentForgeEpoch: () => 'fixture:0', FORGE_EPOCH_HEADER: 'x-forge-epoch',
    forgeFailure: (code) => ({ failed: code }), AbortSignal, JSON };
  runInNewContext(`this.readConnection = {\n${source.slice(start, end)}}.readConnection;`, context);
  const pending = context.readConnection('ref');
  await tick();
  t.last().respond(200).end(JSON.stringify({ readEpoch: 'fixture:0', state: 'connected' }));
  return pending;
}

test("main's forge readConnection hands on a reply of the current generation", async () => {
  assert.deepEqual(await readConnectionThrough({ exitDuringJson: false }), { readEpoch: 'fixture:0', state: 'connected' });
});

test("main's forge readConnection refuses a reply whose child exited before it resumed", async () => {
  assert.deepEqual(await readConnectionThrough({ exitDuringJson: true }), { failed: 'E_CONNECTION_CHANGED' });
});
