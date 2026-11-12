// #1131: POST /api/server-forget through the shipped handler (oats-web.mjs), server/server-forget.mjs and the
// real CLI adapter (cli-adapter.mjs cliServerForget) over a fake process runner: the transport boundary is the
// argv the runner receives. Exactly one command per valid request, composed from the row's two values; a
// refused request runs nothing; the kernel's home and target never reach the answer; every command that ran is
// followed by one remote roster read, whatever it answered. #1170: it runs only for a row the held roster shows gone
// from its server at that server's last answered read; any other is refused and starts no read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerForget, forgetOutcome, forgetNotRun, heldGone } from '../server/server-forget.mjs';
import { readFileSync } from 'node:fs';
import { cliServerForget } from '../../client/cli-adapter.mjs';
import { createRefreshLoop } from '../../client/refresh-loop.mjs';
import { remoteRosterState } from '../../client/remote-roster.mjs';
import { classifyApiRoute } from '../api-url.mjs';
import { loadServer, alexState, CLI } from './helpers/workspace-views-fixture.mjs';
import { shippedMainApi } from './helpers/shipped-main-api.mjs';

const ROUTE = '/api/server-forget';
const OK = { schemaVersion: 1, ok: true, result: { server: 'build', instance: 'dev-a', home: '/srv/team/agents/dev/instances/dev-a',
  target: { sshHost: 'build-host', workspace: '/srv/team', oatsPath: 'oats' }, forgotten: true } };
const FAIL = (code, message) => ({ schemaVersion: 1, ok: false, error: { code, message } });
const exited = code => Object.assign(new Error(`Command failed: exit ${code}`), { code });
/** A held remote roster as remoteRosterState keeps it: one answered group per server, every listed instance gone. */
const gone = (...pairs) => [...new Set(pairs.map(([server]) => server))].map(server => ({ server, label: server, probe: { ok: true },
  instances: pairs.filter(([s]) => s === server).map(([, instance]) => ({ server, instance, savedRoute: true, missingRemotely: true })) }));
const HELD = gone(['build', 'dev-a'], ['build', 'dev-b'], ['b', 'x'], ['build-2', 'dev-a-b'], ['build', 'name with spaces'], ['build', '名前'], ['build', 'a'.repeat(256)]);

/** A runner that answers each command with `answer(argv, n)` ({ stdout, err }; n counts from 0), or holds it ('hold') until the test settles it. */
function runner(answer = () => ({ stdout: JSON.stringify(OK) })) {
  const calls = [], held = [];
  const exec = (bin, argv, opts, done) => {
    calls.push({ bin, argv, opts });
    const reply = answer(argv, calls.length - 1);
    if (reply === 'hold') { held.push(({ stdout = '', err = null }) => done(err, stdout)); return; }
    queueMicrotask(() => done(reply.err ?? null, reply.stdout ?? ''));
  };
  return { exec, calls, held };
}
/** The shipped handler over the real forget module and adapter. `reader` supplies the server's roster reads
 * (`refreshRemoteSnapshotAfter`, and `refreshRemoteSnapshot` for a Retry): by default a stub counting the reads
 * the route asks for, one entry in `rereads` each. */
async function serve({ answer, cli = CLI, adapter, reader, held = () => HELD } = {}) {
  const run = runner(answer);
  const rereads = [];
  const serverForget = createServerForget({ cli: () => cli, held,
    adapter: adapter ?? { cliServerForget: (bin, args) => cliServerForget(bin, args, { exec: run.exec }) } });
  const reads = reader ?? { after: () => { rereads.push(1); return Promise.resolve(); }, refresh: () => Promise.resolve() };
  const { request } = await loadServer(alexState().state, { serverForget, forgetNotRun,
    refreshRemoteSnapshotAfter: reads.after, refreshRemoteSnapshot: reads.refresh });
  const post = (body, extra = {}) => request({ url: ROUTE, method: 'POST', body, ...extra });
  return { post, request, run, rereads };
}

test('a valid request runs exactly one command with the exact argv, answers without home or target, and re-reads once', async () => {
  const s = await serve();
  const answer = await s.post({ server: 'build', instance: 'dev-a' });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { status: 'forgotten', server: 'build', instance: 'dev-a' });
  assert.equal(JSON.stringify(answer.body).includes('/srv/team'), false, 'no home or target crosses the backend');
  assert.equal(s.run.calls.length, 1);
  assert.deepEqual(s.run.calls[0].argv, ['server', 'forget', 'build', '--instance', 'dev-a', '--json']);
  assert.equal(s.run.calls[0].bin, CLI.bin);
  assert.equal(s.run.calls[0].opts.shell, false);
  assert.equal(s.rereads.length, 1, 'the remote roster is read again');
});

test('the row identity reaches argv as given: each value one entry, nothing added from the body', async () => {
  const s = await serve({ answer: argv => ({ stdout: JSON.stringify({ ...OK, result: { ...OK.result, server: argv[2], instance: argv[4] } }) }) });
  for (const [server, instance] of [['b', 'x'], ['build-2', 'dev-a-b'], ['build', 'name with spaces'], ['build', '名前'], ['build', 'a'.repeat(256)]]) {
    const answer = await s.post({ server, instance });
    assert.equal(answer.body.status, 'forgotten', `${server} ${instance}`);
    assert.deepEqual(s.run.calls.at(-1).argv, ['server', 'forget', server, '--instance', instance, '--json']);
  }
});

test('a missing or invalid server or instance is refused with 400 E_BAD_ARGS and runs nothing', async () => {
  const s = await serve();
  const bodies = [{}, { server: 'build' }, { instance: 'dev-a' }, { server: '', instance: 'dev-a' }, { server: 'build', instance: '' },
    { server: '--json', instance: 'dev-a' }, { server: 'build', instance: '--server' }, { server: '-x', instance: 'dev-a' }, { server: 'build', instance: '-i' },
    { server: 'build', instance: 'dev\na' }, { server: 'bu\u0000ild', instance: 'dev-a' }, { server: 'build', instance: 'dev\u007fa' }, { server: 'build\t', instance: 'dev-a' },
    { server: 'build', instance: 'a'.repeat(257) }, { server: 3, instance: 'dev-a' }, { server: 'build', instance: ['dev-a'] }, { server: 'build', instance: null },
    { server: 'build', instance: 'dev-a', argv: ['--force'] }, { server: 'build', instance: 'dev-a', home: '/elsewhere' }, ['build', 'dev-a']];
  for (const body of bodies) {
    const answer = await s.post(body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.deepEqual(answer.body.reason.code, 'E_BAD_ARGS');
    assert.equal(answer.body.status, 'not-run');
  }
  for (const raw of ['{', 'null', '"build"', '']) assert.equal((await s.post(raw)).status, 400, `raw ${JSON.stringify(raw)}`);
  assert.equal((await s.request({ url: `${ROUTE}?server=build&instance=dev-a`, method: 'POST', body: { server: 'build', instance: 'dev-a' } })).status, 400, 'no query');
  assert.equal((await s.request({ url: ROUTE, method: 'GET' })).status, 404, 'POST only');
  assert.deepEqual([s.run.calls.length, s.rereads.length], [0, 0]);
});

test('the Host and Origin guards hold: a foreign host or origin is 403 and runs nothing', async () => {
  const s = await serve();
  const body = { server: 'build', instance: 'dev-a' };
  for (const headers of [{ host: 'evil.example:4820', origin: 'http://localhost:4820' }, { host: '127.0.0.1:4820', origin: 'http://evil.example' },
    { host: '127.0.0.1:4820', origin: 'null' }, { host: '127.0.0.1:4820', origin: 'not a url' }]) {
    const answer = await s.post(body, { headers });
    assert.equal(answer.status, 403, JSON.stringify(headers));
  }
  assert.deepEqual([s.run.calls.length, s.rereads.length], [0, 0]);
  assert.equal((await s.post(body, { headers: { host: 'localhost:4820' } })).status, 200, 'no Origin header from a loopback host: allowed');
});

test('E_SNAPSHOT_UNKNOWN and another refusal are the kernel\'s, with its message; each re-reads once', async () => {
  for (const [code, message] of [['E_SNAPSHOT_UNKNOWN', 'no saved route for dev-a through server build (oats server roster --json)'],
    ['E_SNAPSHOT_UNREADABLE', '/x/remote/build/dev-a.json: Unexpected token']]) {
    const s = await serve({ answer: () => ({ stdout: JSON.stringify(FAIL(code, message)), err: exited(1) }) });
    const answer = await s.post({ server: 'build', instance: 'dev-a' });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { status: 'refused', reason: { code, message } });
    assert.deepEqual([s.run.calls.length, s.rereads.length], [1, 1]);
  }
});

test('no kernel answer is an unknown outcome, never a refusal: a timeout, no envelope, a crash, a success for another row; each re-reads once', async () => {
  const cases = [
    [() => ({ stdout: '', err: Object.assign(exited(null), { killed: true, signal: 'SIGTERM' }) }), 'E_CLI_TIMEOUT'],
    // A nonzero exit with no envelope (a crash after the route file went) and one with a success envelope: E_CLI_FAILED
    // (cli-adapter.mjs runJson strictExit); a clean exit that printed no envelope: E_CLI_PROTOCOL.
    [() => ({ stdout: 'TypeError: Cannot read properties of null', err: exited(1) }), 'E_CLI_FAILED'],
    [() => ({ stdout: JSON.stringify(OK), err: exited(1) }), 'E_CLI_FAILED'],
    [() => ({ stdout: 'not an envelope' }), 'E_CLI_PROTOCOL'],
    [() => ({ stdout: JSON.stringify({ ...OK, result: { ...OK.result, instance: 'dev-b' } }) }), 'E_OUTCOME_UNKNOWN'],
    [() => ({ stdout: JSON.stringify({ ...OK, result: { ...OK.result, forgotten: false } }) }), 'E_OUTCOME_UNKNOWN'],
  ];
  for (const [answer, code] of cases) {
    const s = await serve({ answer });
    const reply = await s.post({ server: 'build', instance: 'dev-a' });
    assert.deepEqual(reply.body, { status: 'unknown', reason: { code } }, code);
    assert.deepEqual([s.run.calls.length, s.rereads.length], [1, 1]);
  }
  const thrown = await serve({ adapter: { cliServerForget: async () => { throw new Error('spawn EACCES /secret/path'); } } });
  const reply = await thrown.post({ server: 'build', instance: 'dev-a' });
  assert.deepEqual(reply.body, { status: 'unknown', reason: { code: 'E_OUTCOME_UNKNOWN' } }, 'a thrown text never crosses');
  assert.equal(thrown.rereads.length, 1);
});

test('an error the adapter wrote is not the kernel\'s, even with a kernel-looking code', () => {
  assert.deepEqual(forgetOutcome(FAIL('E_SNAPSHOT_UNKNOWN', 'unmarked'), 'build', 'dev-a'), { status: 'unknown', reason: { code: 'E_OUTCOME_UNKNOWN' } });
  assert.deepEqual(forgetOutcome(null, 'build', 'dev-a'), { status: 'unknown', reason: { code: 'E_OUTCOME_UNKNOWN' } });
});

test('one Forget per row at a time: a second request while the first runs is 409 E_BUSY and runs nothing; another row runs', async () => {
  // Only the first command is held; every later one answers at once.
  const s = await serve({ answer: (argv, n) => (n === 0 ? 'hold' : { stdout: JSON.stringify({ ...OK, result: { ...OK.result, instance: argv[4] } }) }) });
  const first = s.post({ server: 'build', instance: 'dev-a' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.run.calls.length, 1);
  const second = await s.post({ server: 'build', instance: 'dev-a' });
  assert.deepEqual([second.status, second.body.status, second.body.reason.code], [409, 'not-run', 'E_BUSY']);
  assert.equal(s.run.calls.length, 1, 'nothing ran for the second');
  const other = await s.post({ server: 'build', instance: 'dev-b' });
  assert.equal(other.body.status, 'forgotten');
  s.run.held[0]({ stdout: JSON.stringify(OK) });
  assert.equal((await first).body.status, 'forgotten', 'the late answer lands');
  assert.equal(s.rereads.length, 2, 'one re-read per command that ran');
  assert.equal((await s.post({ server: 'build', instance: 'dev-a' })).body.status, 'forgotten', 'free again once answered');
});

test('without a CLI that reads the remote roster nothing runs: 409 E_FEATURE', async () => {
  for (const cli of [{ ok: false }, { ...CLI, remote: [] }, { ...CLI, remote: 'roster' }]) {
    const s = await serve({ cli });
    const answer = await s.post({ server: 'build', instance: 'dev-a' });
    assert.deepEqual([answer.status, answer.body.reason.code], [409, 'E_FEATURE']);
    assert.deepEqual([s.run.calls.length, s.rereads.length], [0, 0]);
  }
});

test('the adapter refuses option-shaped values itself', async () => {
  const run = runner();
  for (const args of [{ server: '--x', instance: 'a' }, { server: 'b', instance: '-a' }, { server: 'b' }, undefined]) {
    assert.equal((await cliServerForget('/oats', args, { exec: run.exec })).error.code, 'E_BAD_ARGS');
  }
  assert.equal(run.calls.length, 0);
});

/** The server's own roster reader (oats-web.mjs, the OATSWEB_REMOTEREAD block), over a fake adapter whose reads
 * the test settles one by one: `reads` holds each read's settle function, in the order they began. */
function remoteReader() {
  const src = readFileSync(new URL('../server/oats-web.mjs', import.meta.url), 'utf8');
  const block = src.match(/\/\* OATSWEB_REMOTEREAD_BEGIN[^*]*\*\/([\s\S]*?)\/\* OATSWEB_REMOTEREAD_END \*\//)[1];
  const reads = [];
  const adapter = { cliRemoteRoster: () => new Promise(resolve => { reads.push(() => resolve({ schemaVersion: 1, ok: true, result: { groups: [] } })); }) };
  const make = new Function('adapter', 'cliReadsRemotes', 'takeRosterOutcome', 'rosterAsk',
    `let remoteRead = null, cliState = { ok: true, bin: 'oats' };\n${block}\nreturn { refresh: refreshRemoteSnapshot, after: refreshRemoteSnapshotAfter };`);
  return { ...make(adapter, () => true, () => {}, () => null), reads }; // rosterAsk: the unfiltered read (#1124)
}
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

test('the answer does not wait for the roster read; the read is asked for after the command, and a failing read changes no answer', async () => {
  const order = [];
  const s = await serve({ answer: () => { order.push('command'); return { stdout: JSON.stringify(OK) }; },
    reader: { after: () => { order.push('read'); return new Promise(() => {}); }, refresh: () => Promise.resolve() } });
  assert.equal((await s.post({ server: 'build', instance: 'dev-a' })).body.status, 'forgotten', 'answered with the read still running');
  assert.deepEqual(order, ['command', 'read']);
  const failing = await serve({ reader: { after: () => Promise.reject(new Error('roster')), refresh: () => Promise.resolve() } });
  assert.equal((await failing.post({ server: 'build', instance: 'dev-a' })).body.status, 'forgotten');
});

test('a Retry\'s read in flight when the command runs is not the read after it: one more read runs once it lands', async () => {
  const r = remoteReader();
  const s = await serve({ reader: r, answer: argv => ({ stdout: JSON.stringify({ ...OK, result: { ...OK.result, instance: argv[4] } }) }) });
  void s.request({ url: '/api/remote-roster/refresh', method: 'POST', body: {} }); await flush(); // R0: a Retry, outside the loop
  assert.equal(r.reads.length, 1);
  assert.equal((await s.post({ server: 'build', instance: 'dev-a' })).body.status, 'forgotten', 'answered at once');
  assert.equal((await s.post({ server: 'build', instance: 'dev-b' })).body.status, 'forgotten');
  await flush(); assert.equal(r.reads.length, 1, 'R0 is still the only read');
  r.reads[0](); await flush();
  assert.equal(r.reads.length, 2, 'R1 begins after R0: the read after both commands, shared');
  r.reads[1](); await flush();
  assert.equal(r.reads.length, 2, 'exactly one read after the commands');
  void s.post({ server: 'build', instance: 'dev-a' }); await flush();
  assert.equal(r.reads.length, 3, 'with no read in flight, the read starts at once'); r.reads[2](); await flush();
});

test('with the server\'s refresh loop owning a read in flight, the same: one more read after it', async () => {
  const r = remoteReader();
  const loop = createRefreshLoop({ run: () => r.refresh(), focusedMs: 3_600_000, blurredMs: 3_600_000, timers: { setTimeout: () => null, clearTimeout: () => {} } });
  const s = await serve({ reader: r });
  void loop.request(); await flush();
  assert.equal(r.reads.length, 1);
  await s.post({ server: 'build', instance: 'dev-a' });
  r.reads[0](); await flush();
  assert.equal(r.reads.length, 2); r.reads[1](); await flush();
  assert.equal(r.reads.length, 2);
});

test('the route keeps the proxy\'s ordinary deadline, which outlasts the forget call', async () => {
  let limit;
  await cliServerForget('/oats', { server: 'build', instance: 'dev-a' }, { exec: (_bin, _argv, opts, done) => { limit = opts.timeout; done(null, JSON.stringify(OK)); } });
  assert.equal(classifyApiRoute(ROUTE), null, 'no class of its own');
  const api = shippedMainApi({ window: '/d/first', advertised: new Set(['/d/first']), served: [{ id: '/d/first' }] });
  const seen = [];
  api.context.AbortSignal = { timeout: ms => { seen.push(ms); return { ms }; } };
  api.context.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: 'forgotten', server: 'build', instance: 'dev-a' }) });
  await api.call(ROUTE, { method: 'POST', body: JSON.stringify({ server: 'build', instance: 'dev-a' }) });
  assert.ok(seen[0] > limit, `the proxy's ${seen[0]} ms must outlast the forget call's ${limit} ms`);
});

test('a second Forget of the row before the read lands runs the command again and answers the kernel\'s E_SNAPSHOT_UNKNOWN', async () => {
  const s = await serve({ answer: (argv, n) => (n === 0 ? { stdout: JSON.stringify(OK) }
    : { stdout: JSON.stringify(FAIL('E_SNAPSHOT_UNKNOWN', 'no saved route for dev-a through server build (oats server roster --json)')), err: exited(1) }),
  reader: { after: () => new Promise(() => {}), refresh: () => Promise.resolve() } });
  assert.equal((await s.post({ server: 'build', instance: 'dev-a' })).body.status, 'forgotten');
  const again = await s.post({ server: 'build', instance: 'dev-a' });
  assert.deepEqual([again.status, again.body.status, again.body.reason.code], [200, 'refused', 'E_SNAPSHOT_UNKNOWN']);
  assert.equal(s.run.calls.length, 2);
});

const notGone = (answer, what) => {
  assert.deepEqual([answer.status, answer.body.status, answer.body.reason.code], [409, 'not-run', 'E_FORGET_NOT_GONE'], what);
  assert.equal(answer.body.reason.message, 'Forget is only for an instance its server did not list at the last read; nothing was run.');
};

test('#1170: a row the held roster does not show gone is refused with 409 E_FORGET_NOT_GONE, runs nothing and starts no read', async () => {
  const row = over => [{ server: 'build', label: 'build', probe: { ok: true }, instances: [{ server: 'build', instance: 'dev-a', savedRoute: true, ...over }] }];
  const cases = [
    [row({}), 'held without missingRemotely'],
    [row({ missingRemotely: false }), 'missingRemotely: false'],
    [row({ missingRemotely: 'true' }), 'missingRemotely: "true"'],
    [row({ missingRemotely: 1 }), 'missingRemotely: 1'],
    [gone(['build', 'dev-b']), 'an unknown instance on a known server'],
    [gone(['other', 'dev-a']), 'a known instance on another server'],
    [[], 'an empty held roster'],
    [remoteRosterState({ remoteGroups: gone(['build', 'dev-a']), rosterAnswered: true, rosterFailure: null },
      { thrown: 'read failed' }, '2026-01-01T00:00:00.000Z').remoteGroups, 'gone at an earlier read, held through a failed one'],
    [[{ ...gone(['build', 'dev-a'])[0], probe: undefined }], 'a group with no probe'],
    [[{ ...gone(['build', 'dev-a'])[0], server: undefined }], 'a group with no server'],
  ];
  for (const [groups, what] of cases) {
    const s = await serve({ held: () => groups });
    notGone(await s.post({ server: 'build', instance: 'dev-a' }), what);
    assert.deepEqual([s.run.calls.length, s.rereads.length], [0, 0], what);
  }
  for (const groups of [undefined, null, {}, [null], [{ server: 'build', probe: { ok: true }, instances: null }]]) {
    const s = await serve({ held: () => groups });
    notGone(await s.post({ server: 'build', instance: 'dev-a' }), JSON.stringify(groups));
    assert.deepEqual([s.run.calls.length, s.rereads.length], [0, 0], JSON.stringify(groups));
  }
  const throwing = await serve({ held: () => { throw new Error('roster'); } });
  notGone(await throwing.post({ server: 'build', instance: 'dev-a' }), 'a held roster that cannot be read');
  assert.deepEqual([throwing.run.calls.length, throwing.rereads.length], [0, 0]);
});

test('#1170: the check reads what is held at each request: gone, then listed again, the second is refused; a held gone row runs once', async () => {
  let groups = gone(['build', 'dev-a']);
  const s = await serve({ held: () => groups });
  assert.equal((await s.post({ server: 'build', instance: 'dev-a' })).body.status, 'forgotten');
  assert.deepEqual(s.run.calls.map(c => c.argv), [['server', 'forget', 'build', '--instance', 'dev-a', '--json']]);
  groups = [{ ...groups[0], instances: [{ server: 'build', instance: 'dev-a', savedRoute: true, missingRemotely: false, running: true }] }];
  notGone(await s.post({ server: 'build', instance: 'dev-a' }), 'listed again by its server');
  assert.deepEqual([s.run.calls.length, s.rereads.length], [1, 1], 'the refusal ran nothing and read nothing');
});

test('#1170: the order of the checks: body, CLI, held row, in flight', async () => {
  const s = await serve({ cli: { ok: false }, held: () => [] });
  assert.equal((await s.post({ server: '--x', instance: 'dev-a' })).body.reason.code, 'E_BAD_ARGS', 'the body before the CLI');
  assert.equal((await s.post({ server: 'build', instance: 'dev-a' })).body.reason.code, 'E_FEATURE', 'the CLI before the held row');
  let groups = gone(['build', 'dev-a']);
  const held = await serve({ answer: (argv, n) => (n === 0 ? 'hold' : { stdout: JSON.stringify(OK) }), held: () => groups });
  const first = held.post({ server: 'build', instance: 'dev-a' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await held.post({ server: 'build', instance: 'dev-a' })).body.reason.code, 'E_BUSY', 'held gone and in flight: busy');
  groups = [];
  assert.equal((await held.post({ server: 'build', instance: 'dev-a' })).body.reason.code, 'E_FORGET_NOT_GONE', 'the held row before in flight');
  held.run.held[0]({ stdout: JSON.stringify(OK) });
  assert.equal((await first).body.status, 'forgotten');
  assert.equal(held.run.calls.length, 1);
});

test('#1170: the shipped server hands the module its live held roster, never a copy taken at start', async () => {
  const src = readFileSync(new URL('../server/oats-web.mjs', import.meta.url), 'utf8');
  const line = src.split('\n').find(l => l.startsWith('const serverForget = createServerForget('));
  const run = runner();
  const made = new Function('createServerForget', 'adapter', 'cliState',
    `let remoteGroups = [];\n${line}\nreturn { serverForget, hold: g => { remoteGroups = g; } };`)(
    createServerForget, { cliServerForget: (bin, args) => cliServerForget(bin, args, { exec: run.exec }) }, CLI);
  assert.equal((await made.serverForget.forget({ server: 'build', instance: 'dev-a' })).answer.reason.code, 'E_FORGET_NOT_GONE');
  made.hold(gone(['build', 'dev-a']));
  assert.equal((await made.serverForget.forget({ server: 'build', instance: 'dev-a' })).answer.status, 'forgotten');
  assert.equal(run.calls.length, 1);
  assert.equal(heldGone(gone(['build', 'dev-a']), 'build', 'dev-a'), true);
});
