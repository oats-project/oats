import { controlHeaders } from './helpers/control-auth.mjs';
// The shipped HTTP callback and real boundary, with inert injected executors.
// No listener, native CLI, OAuth, tmux, Electron or browser is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createForgeBoundary } from '../server/forge.mjs';
import { createReviewPaste } from '../server/review-paste.mjs';
import { forgeObservation } from '../server/forge-observation.mjs';
import { FORGE_EPOCH_HEADER, validForgeEpoch } from '../forge-proxy.mjs';
import { cli, oats, context, target, selector, state, envelope, output, status, pr, deferred, tick } from './helpers/forge-fixture.mjs';
import { deploymentDoubles } from './helpers/deployment-doubles.mjs';
function http({ remote = false, run, discover, raw = state(), transform = source => source } = {}) {
  const source = transform(readFileSync(new URL('../server/oats-web.mjs', import.meta.url), 'utf8'));
  const start = source.indexOf('const send = (res, code, body, type'), end = source.indexOf('\n// No upgrade transport');
  assert.ok(start > 0 && end > start);
  let executions = 0;
  const service = createForgeBoundary({
    discover: discover || (async () => { executions++; return cli; }),
    invokeGit: async () => { executions++; return envelope(raw); },
    run: async (bin, args, opts) => { executions++; return run ? run(bin, args, opts)
      : args[0] === 'auth' ? output(status(), 0, `ghp_${'X'.repeat(36)}`) : args[0] === 'api' ? output('operator') : output(pr()); },
  });
  const views = deploymentDoubles(() => [{ ...context.workspace, remote }]), snapshot = { byWs: new Map([['team', { instances: context.instances }]]) };
  // The forge roster reads the VIEW's context (#482); here every deployment is its own one-deployment view.
  const viewForgeContext = (held, id, terms) => {
    const ws = views.deploymentFor(held, id, terms), observed = ws && !ws.remote ? snapshot.byWs.get(ws.id) : null;
    return ws ? { workspace: { id: ws.id, name: ws.name, remote: !!ws.remote }, cli: oats, instances: observed?.instances || [], clones: observed?.deployment?.workspaceStatus?.clones || [] }
      : { workspace: undefined, cli: oats, instances: [], clones: [] };
  };
  const deps = { createServer: handler => handler, forgeBoundary: service, FORGE_EPOCH_HEADER, validForgeEpoch, createReviewPaste, tmuxTarget: () => { throw new Error('no pane in the harness'); },
    cliState: oats, ...views, viewForgeContext, snapshot,
    panelData: assert.fail, snapshotPanel: assert.fail, collectNow: assert.fail };
  const handler = new Function(...Object.keys(deps), `${source.slice(start, end)}\nreturn server;`)(...Object.values(deps));
  const requestBody = { selector, observationKey: forgeObservation(raw, target, oats).observationKey };
  return { count: () => executions, async request({ url = '/api/instance-forge?ws=team', method = 'POST', body = JSON.stringify(requestBody),
    headers = { host: '127.0.0.1:4820', origin: 'http://127.0.0.1:4820', [FORGE_EPOCH_HEADER]: 'client:0' } } = {}) {
    const req = new EventEmitter(); Object.assign(req, { url, method, headers: controlHeaders(headers) }); let result;
    const res = { writeHead(code, responseHeaders) { result = { code, headers: responseHeaders }; }, end(text) { result.body = JSON.parse(text); } };
    const waiting = handler(req, res); req.emit('data', Buffer.from(body)); req.emit('end'); await waiting;
    return result;
  } };
}
test('both forge POSTs are behind Host/Origin guards, including malformed body attacks', async () => {
  const h = http();
  for (const url of ['/api/instance-forge?ws=team', '/api/forge-connections', '/api/forge-roster?ws=team', '/api/instance-review-threads?ws=team']) for (const headers of [
    {}, { host: 'evil' }, { host: '127.0.0.1', origin: 'https://evil' }, { host: 'localhost', origin: 'null' }, { host: 'localhost', origin: 'invalid' },
  ]) assert.equal((await h.request({ url, headers, body: '{' })).code, 403);
  assert.equal(h.count(), 0);
});
test('GET/auth-mutation routes, duplicate/extra/missing ws, unknown machine query and malformed bodies never run a process', async () => {
  const h = http();
  for (const url of ['/api/instance-forge?ws=team', '/api/forge-connections', '/api/forge-roster?ws=team', '/api/instance-review-threads?ws=team']) assert.equal((await h.request({ url, method: 'GET' })).code, 404);
  for (const url of ['/api/instance-review-threads', '/api/instance-review-threads?ws=team&ws=team', '/api/instance-review-threads?ws=team&x=1']) assert.equal((await h.request({ url, body: '{}' })).code, 400, url);
  for (const url of ['/api/forge-roster', '/api/forge-roster?ws=', '/api/forge-roster?ws=team&ws=team', '/api/forge-roster?ws=team&cwd=/x']) assert.equal((await h.request({ url, body: '{}' })).code, 400, url);
  for (const url of ['/api/forge-login', '/api/forge-logout']) assert.equal((await h.request({ url })).code, 404);
  for (const url of ['/api/instance-forge', '/api/instance-forge?ws=', '/api/instance-forge?ws=team&ws=team', '/api/instance-forge?ws=team&cwd=/x', '/api/forge-connections?ws=team']) assert.equal((await h.request({ url })).code, 400);
  for (const body of ['{', 'null', '[]', '0', ' '.repeat(65537)]) for (const url of ['/api/instance-forge?ws=team', '/api/forge-connections', '/api/forge-roster?ws=team', '/api/instance-review-threads?ws=team']) assert.equal((await h.request({ url, body })).code, 400);
  assert.equal((await h.request({ headers: { host: 'localhost', [FORGE_EPOCH_HEADER]: 'bad/epoch' } })).code, 400);
  assert.equal(h.count(), 0);
});
test('remote workspace refusal precedes oats and gh; machine Connections is separate and works without workspace query', async () => {
  const h = http({ remote: true });
  const refused = await h.request(); assert.equal(refused.body.reason.code, 'unsupported-remote-operation'); assert.equal(h.count(), 0);
  const result = await h.request({ url: '/api/forge-connections', body: '{}' });
  assert.equal(result.body.status, 'connected'); assert.equal(result.body.login, 'operator'); assert.ok(h.count() > 0);
});
test('real callback qualifies its exact roster and returns bounded projections without stderr or raw URL', async () => {
  const h = http(); const result = await h.request();
  assert.equal(result.code, 200); assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.body.status, 'available'); assert.equal(result.body.data.number, 42);
  assert.doesNotMatch(JSON.stringify(result), /ghp_|userinfo|PRIVATE/);
  const before = h.count();
  assert.equal((await h.request({ url: '/api/instance-forge?ws=foreign' })).body.reason.code, 'E_WORKSPACE_UNKNOWN');
  assert.equal(h.count(), before);
});
test('HTTP burst coalesces in one epoch, auth generation starts a new flight, errors remain closed', async () => {
  const gate = deferred(); let discoveries = 0;
  const h = http({ discover: async () => { discoveries++; return gate.promise; } });
  const values = Array.from({ length: 5 }, () => h.request({ url: '/api/forge-connections', body: '{}' }));
  const next = h.request({ url: '/api/forge-connections', body: '{}', headers: { host: 'localhost', [FORGE_EPOCH_HEADER]: 'client:1' } });
  await tick(); assert.equal(discoveries, 2); gate.resolve({ ok: false, code: 'E_GH_TIMEOUT', message: 'PRIVATE' });
  const results = await Promise.all([...values, next]);
  assert.ok(results.every(r => r.body.reason.code === 'E_GH_TIMEOUT')); assert.doesNotMatch(JSON.stringify(results), /PRIVATE/);
});

test('forge-roster: the shipped route binds its one workspace, refuses a remote one, and answers bounded rows', async () => {
  const h = http();
  const ok = await h.request({ url: '/api/forge-roster?ws=team', body: '{}' });
  assert.equal(ok.code, 200); assert.equal(ok.body.status, 'ok'); assert.deepEqual(ok.body.rows, [], 'no instance with a branch in a github clone: nothing read');
  assert.equal(h.count(), 0);
  const remote = http({ remote: true });
  assert.equal((await remote.request({ url: '/api/forge-roster?ws=team', body: '{}' })).body.reason.code, 'unsupported-remote-operation');
  assert.equal(remote.count(), 0);
});

test('send review threads: the shipped route refuses a remote workspace before any process, and renderer text', async () => {
  const remote = http({ remote: true });
  const r = await remote.request({ url: '/api/instance-review-threads?ws=team', body: JSON.stringify({ action: 'preview', selector, observationKey: 'a'.repeat(64) }) });
  assert.equal(r.code, 200); assert.equal(r.body.reason.code, 'E_REMOTE_TERMINAL'); assert.equal(remote.count(), 0);
  const h = http();
  const t = await h.request({ url: '/api/instance-review-threads?ws=team', body: JSON.stringify({ action: 'send', selector, observationKey: 'a'.repeat(64), digest: 'b'.repeat(64), text: 'rm -rf ~' }) });
  assert.equal(t.body.reason.code, 'E_BAD_ARGS'); assert.equal(h.count(), 0);
});
