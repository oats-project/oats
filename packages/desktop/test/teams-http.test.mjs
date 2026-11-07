import { controlHeaders } from './helpers/control-auth.mjs';
// Team model v2 routes (0.30 D1b): /api/workspace-teams and /api/workspace-soul-teams, through the
// SHIPPED server handler (sliced from server/oats-web.mjs), the real boundary and the real argv
// adapters, with only the kernel process faked: it answers with the REAL K1 kernel documents
// (fixtures/team-model-v2/, provenance.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { cliTeams, cliSoulTeams } from '../../client/cli-adapter.mjs';
import { apiUrl, classifyApiRoute } from '../api-url.mjs';
import { createTeamsBoundary, teamsFailure } from '../server/teams.mjs';
import { deploymentDoubles } from './helpers/deployment-doubles.mjs';

const read = path => JSON.parse(readFileSync(new URL(`./fixtures/${path}.json`, import.meta.url), 'utf8'));
const DEPLOYMENT = '/fixture/base/northwind-workspace';
const HEADERS = { host: '127.0.0.1:4820', origin: 'http://127.0.0.1:4820' };
function http({ reply } = {}) {
  const source = readFileSync(new URL('../server/oats-web.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const send = (res, code, body, type'), end = source.indexOf('\n// No upgrade transport');
  const calls = [], workspace = { id: 'team', name: 'team', scope: DEPLOYMENT, roots: [DEPLOYMENT] };
  const cliState = { bin: '/oats', version: '0.30.0', features: ['team-model-2'] };
  // The kernel process: records argv, answers with the stand-in document (or `reply(argv)`).
  const exec = (bin, argv, opts, done) => {
    calls.push(argv);
    const out = reply ? reply(argv) : argv[0] === 'teams' ? read('team-model-v2/teams-after') : read('team-model-v2/soul-teams-default');
    Promise.resolve(out).then(v => done(null, JSON.stringify(v)));
  };
  const boundary = createTeamsBoundary({ teams: (bin, a) => cliTeams(bin, a, { exec }), soulTeams: (bin, a) => cliSoulTeams(bin, a, { exec }) });
  // A writing action drops the deployment's held inspections (inspect reports a soul's teams).
  const invalidated = [], previewsInvalidated = [];
  const deps = { createServer: fn => fn, teamsRequest: boundary.teams, soulTeamsRequest: boundary.soulTeams, teamsFailure, cliState, ...deploymentDoubles(() => [workspace]),
    inspectCache: { invalidate: ws => invalidated.push(ws) }, spawnPreview: { cache: { invalidate: ws => previewsInvalidated.push(ws) } },
    panelData: assert.fail, collectNow: assert.fail };
  const handler = new Function(...Object.keys(deps), `${source.slice(start, end)}\nreturn server;`)(...Object.values(deps));
  return { calls, workspace, cliState, invalidated, previewsInvalidated, async request({ url = '/api/workspace-teams?ws=team', method = 'POST', body = { action: 'list' }, headers = HEADERS } = {}) {
    const req = new EventEmitter(); Object.assign(req, { url, method, headers: controlHeaders(headers) }); let result;
    const res = { writeHead(status, h) { result = { status, headers: h }; }, end(text) { result.body = JSON.parse(text); } };
    const done = handler(req, res); req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))); req.emit('end'); await done; return result;
  } };
}

test('Host/Origin/method/query/body guards refuse before any kernel process (CSRF: a foreign Origin never rewrites oats-local.yaml)', async () => {
  const h = http();
  for (const url of ['/api/workspace-teams?ws=team', '/api/workspace-soul-teams?ws=team']) {
    for (const headers of [{}, { host: 'evil' }, { host: 'localhost', origin: 'https://evil.example' }, { host: 'localhost', origin: 'null' }, { host: 'localhost', origin: 'http://127.0.0.1.evil:4820' }]) {
      assert.equal((await h.request({ url, headers, body: { action: 'add', label: 'x', team: 't:ns', soul: 'a', labels: ['x'] } })).status, 403, JSON.stringify(headers));
    }
    assert.equal((await h.request({ url, method: 'GET' })).status, 404);
  }
  for (const url of ['/api/workspace-teams', '/api/workspace-teams?ws=', '/api/workspace-teams?ws=team&ws=team', '/api/workspace-teams?ws=team&dir=/etc']) assert.equal((await h.request({ url })).status, 400);
  for (const body of ['{', 'null', '[]', JSON.stringify({ action: 'add', label: 'x', team: 't:ns', description: 'd'.repeat(5000) })]) assert.equal((await h.request({ body })).status, 400);
  assert.equal(h.calls.length, 0);
});

test('oats teams: list/add/remove/default as one argv each (option values as single --flag=value tokens); the document decoded', async () => {
  const h = http();
  const listed = await h.request();
  assert.deepEqual([listed.status, listed.body.status, listed.body.teams.teamsApi, listed.body.teams.deployment, listed.body.teams.defaultTeam, listed.headers['cache-control']], [200, 'ok', 1, DEPLOYMENT, 'mine', 'no-store']);
  assert.deepEqual(Object.keys(listed.body), ['status', 'teams']);
  await h.request({ body: { action: 'add', label: 'antares-oats', team: 'antares-oats:juan.aweb.ai', description: 'Mine' } });
  await h.request({ body: { action: 'remove', label: 'old' } });
  await h.request({ body: { action: 'default', label: 'oats' } });
  assert.deepEqual(h.calls, [['teams', '--dir', DEPLOYMENT, '--json'], ['teams', 'add', 'antares-oats', '--team=antares-oats:juan.aweb.ai', '--description=Mine', '--dir', DEPLOYMENT, '--json'],
    ['teams', 'remove', 'old', '--dir', DEPLOYMENT, '--json'], ['teams', 'default', 'oats', '--dir', DEPLOYMENT, '--json']]);
  assert.deepEqual(h.invalidated, [DEPLOYMENT, DEPLOYMENT, DEPLOYMENT], 'each write drops the inspections held under the workspace SCOPE (not its id); the list did not');
  assert.deepEqual(h.previewsInvalidated, ['team', 'team', 'team'], 'and the spawn previews held under the workspace ID (a preview reports the soul\'s teams)');
});

test('no flag injection: option-shaped or out-of-grammar values are refused before any process', async () => {
  const h = http();
  for (const body of [{ action: 'default', label: '--default' }, { action: 'add', label: 'x', team: '--json' }, { action: 'add', label: 'x', team: 't:ns', description: '--json' },
    { action: 'add', label: 'x', team: 'no-namespace' }, { action: 'add', label: 'x', team: 'a b:ns' }, { action: 'add', label: 'x y', team: 't:ns' }, { action: 'add', label: 'Oats', team: 't:ns' }, { action: 'default', label: 'x'.repeat(65) }, { action: 'list', label: 'x' },
    { action: 'add', label: 'x', team: 't:ns', dir: '/etc' }, { action: 'join', label: 'x' }]) {
    assert.equal((await h.request({ body })).body.reason.code, 'E_BAD_ARGS', JSON.stringify(body));
  }
  const url = '/api/workspace-soul-teams?ws=team';
  for (const body of [{ action: 'default', soul: 'a', label: '--default' }, { action: 'add', soul: '--all', labels: ['x'] }, { action: 'add', soul: 'a', labels: ['--json'] },
    { action: 'add', soul: 'a' }, { action: 'add', soul: 'a', labels: [] }, { action: 'add', soul: 'a', labels: Array.from({ length: 65 }, (_, i) => `t${i}`) },
    { action: 'default', soul: '*', label: 'oats' }, { action: 'clear-default', soul: '*' }, { action: 'show', soul: 'a', labels: ['x'] }, { action: 'show', soul: 'a/b/c' }, { action: 'show' },
    { action: 'show', soul: 'Dev' }, { action: 'show', soul: 'pkg/Soul' }, { action: 'show', soul: 'a_b' }, { action: 'show', soul: 'a--b' }, { action: 'show', soul: `${'a'.repeat(257)}` },
    { action: 'add', soul: 'a', labels: ['Oats'] }]) {
    assert.equal((await h.request({ url, body })).body.reason.code, 'E_BAD_ARGS', JSON.stringify(body));
  }
  assert.equal(h.calls.length, 0);
});

test('oats soul teams: show/add/remove/default/clear-default argv; the document decoded', async () => {
  const h = http(), url = '/api/workspace-soul-teams?ws=team';
  const shown = await h.request({ url, body: { action: 'show', soul: 'oats-expert' } });
  assert.deepEqual([shown.body.status, shown.body.soulTeams.soulTeamsApi, shown.body.soulTeams.soul, shown.body.soulTeams.teams.map(t => t.via)], ['ok', 1, 'release-manager', [['default', 'soul'], ['soul']]]);
  assert.deepEqual(Object.keys(shown.body), ['status', 'soulTeams']);
  await h.request({ url, body: { action: 'add', soul: '*', labels: ['oats', 'reviewers'] } });
  await h.request({ url, body: { action: 'remove', soul: 'oats.okf/harvester', labels: ['old'] } });
  await h.request({ url, body: { action: 'default', soul: 'oats-expert', label: 'oats' } });
  await h.request({ url, body: { action: 'clear-default', soul: 'oats-expert' } });
  assert.deepEqual(h.calls, [['soul', 'teams', 'oats-expert', '--dir', DEPLOYMENT, '--json'], ['soul', 'teams', '*', '--add=oats,reviewers', '--dir', DEPLOYMENT, '--json'],
    ['soul', 'teams', 'oats.okf/harvester', '--remove=old', '--dir', DEPLOYMENT, '--json'], ['soul', 'teams', 'oats-expert', '--default=oats', '--dir', DEPLOYMENT, '--json'],
    ['soul', 'teams', 'oats-expert', '--clear-default', '--dir', DEPLOYMENT, '--json']]);
});

test('the REAL kernel refusals pass through verbatim (E_TEAM_IN_USE usedBy, E_TEAM_SHARED at, E_TEAM_EXISTS, E_TEAM_UNKNOWN)', async () => {
  let doc; const h = http({ reply: () => doc }), url = '/api/workspace-soul-teams?ws=team';
  for (const [name, request, route] of [['teams-remove-in-use', { action: 'remove', label: 'mine' }], ['teams-remove-shared', { action: 'remove', label: 'engineering' }],
    ['teams-add-exists', { action: 'add', label: 'mine', team: 'mine:juan.aweb.ai' }], ['teams-add-shared', { action: 'add', label: 'engineering', team: 'eng:northwind.aweb.ai' }],
    ['soul-teams-unknown', { action: 'add', soul: 'release-manager', labels: ['nope'] }, url]]) {
    doc = read(`team-model-v2/${name}`);
    const r = await h.request({ ...(route ? { url: route } : {}), body: request });
    assert.deepEqual(r.body, { status: 'refused', reason: { code: doc.error.code, message: doc.error.message, details: doc.error.details } }, name);
  }
  assert.deepEqual(read('team-model-v2/teams-remove-in-use').error.details.usedBy, ['defaultTeam', 'souls.teams:release-manager']);
});

test('kernel refusals pass through verbatim with their bounded details; unknown detail keys dropped', async () => {
  const refusal = { schemaVersion: 1, ok: false, error: { code: 'E_TEAM_IN_USE', message: 'team oats is in use: defaultTeam, souls.teams:*', details: { label: 'oats', usedBy: ['defaultTeam', 'souls.teams:*', 'souls.default:oats.okf/harvester'], secret: 'x' } } };
  const h = http({ reply: () => refusal });
  const r = await h.request({ body: { action: 'remove', label: 'oats' } });
  assert.deepEqual([r.status, r.body.status, Object.keys(r.body)], [200, 'refused', ['status', 'reason']]);
  assert.deepEqual(r.body.reason, { code: 'E_TEAM_IN_USE', message: 'team oats is in use: defaultTeam, souls.teams:*', details: { label: 'oats', usedBy: ['defaultTeam', 'souls.teams:*', 'souls.default:oats.okf/harvester'] } });
  refusal.error = { code: 'E_TEAM_SHARED', message: 'team oats is shared; edit oats-workspace.yaml', details: { label: 'oats', at: 'oats-workspace.yaml#/teams/oats' } };
  assert.deepEqual((await h.request({ body: { action: 'remove', label: 'oats' } })).body.reason.details, { label: 'oats', at: 'oats-workspace.yaml#/teams/oats' });
  refusal.error = { code: 'E_TEAM_IN_USE', message: 'x', details: { label: 'oats', usedBy: ['rm -rf'] } };
  assert.deepEqual((await h.request({ body: { action: 'remove', label: 'oats' } })).body.reason, { code: 'E_TEAM_IN_USE', message: 'x', details: { label: 'oats' } }, 'a usedBy outside the kernel grammar is dropped');
  refusal.error = { code: 'E_BAD_ARGS', message: 'nope', details: { label: 'oats' } };
  assert.deepEqual((await h.request({ body: { action: 'remove', label: 'oats' } })).body.reason, { code: 'E_BAD_ARGS', message: 'nope' }, 'details only for the team refusals');
  refusal.error = { code: 'E_TEAM_UNKNOWN' };
  assert.deepEqual((await h.request({ body: { action: 'remove', label: 'oats' } })).body.reason, { code: 'E_TEAM_UNKNOWN', message: 'The OATS CLI refused the request (E_TEAM_UNKNOWN)' }, 'a message is always present');
});

test('gates: team-model-2, local workspaces, known ws; a malformed document is E_CLI_PROTOCOL; one mutation per deployment', async () => {
  const h = http();
  h.cliState.features = ['teams']; assert.deepEqual((await h.request()).body, { status: 'refused', reason: { code: 'E_TEAMS_UNAVAILABLE', message: 'This OATS CLI has no team model (feature team-model-2, OATS 0.30, or team-model-3, OATS 0.38)' } }, 'on 0.29: a clear refusal, no kernel call');
  h.cliState.features = ['team-model-2']; h.workspace.remote = true; assert.equal((await h.request()).body.reason.code, 'unsupported-remote-operation');
  h.workspace.remote = false; assert.equal((await h.request({ url: '/api/workspace-teams?ws=other' })).body.reason.code, 'E_WORKSPACE_UNKNOWN');
  assert.equal(h.calls.length, 0);
  h.workspace.scope = '/elsewhere'; assert.equal((await h.request()).body.reason.code, 'E_DEPLOYMENT_SCOPE', 'a document for another deployment');
  h.workspace.scope = DEPLOYMENT;
  const broken = http({ reply: () => { const d = read('team-model-v2/teams-after'); d.result.teams[0].from = 'global'; return d; } });
  assert.equal((await broken.request()).body.reason.code, 'E_CLI_PROTOCOL');
  h.workspace.scope = DEPLOYMENT;
  let release; const gate = new Promise(r => { release = r; });
  const slow = http({ reply: argv => argv[1] === 'add' ? gate.then(() => read('team-model-v2/teams-after')) : read('team-model-v2/teams-after') });
  const first = slow.request({ body: { action: 'add', label: 'x', team: 't:ns' } });
  await new Promise(r => setImmediate(r));
  assert.equal((await slow.request({ body: { action: 'default', label: 'oats' } })).body.reason.code, 'E_BUSY');
  assert.equal((await slow.request()).body.status, 'ok', 'a read is not blocked by a write');
  release(); assert.equal((await first).body.status, 'ok');
  assert.equal((await slow.request({ body: { action: 'default', label: 'oats' } })).body.status, 'ok', 'the slot is released');
});

test('renderer proxy: both routes take the guarded generic path with ws pinned to the connected server\'s workspaces', () => {
  for (const path of ['/api/workspace-teams', '/api/workspace-soul-teams']) {
    assert.equal(classifyApiRoute(path, 'http://localhost:4820'), null, 'the generic path: frame guard + pinned ws + 20s deadline');
    assert.equal(apiUrl(path, 'http://localhost:4820', 'team', new Set(['team'])).searchParams.get('ws'), 'team');
    assert.equal(apiUrl(`${path}?ws=other`, 'http://localhost:4820', 'team', new Set(['team'])).searchParams.get('ws'), 'team', 'a ws the server does not advertise is re-pinned');
    assert.throws(() => apiUrl(`//evil${path}`, 'http://localhost:4820', 'team'));
  }
});
