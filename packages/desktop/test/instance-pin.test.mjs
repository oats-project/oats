// Pinned instances (feature instance-pin), the Desktop's acts: the backend boundary (server/instance-pin.mjs, on the
// boundary it shares with the colour and the background: server/instance-record.mjs) over `oats instance pin`, and
// its argv (cli-adapter.mjs cliInstancePin). The kernel branch is not merged: the fixtures carry the agreed shapes
// exactly (docs/desktop-cli-api.md "Pinned instances": `{ instancePinApi: 1, instance, home, pinned, changed }`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstancePinBoundary, instancePinOutcome, INSTANCE_PIN_FEATURE } from '../server/instance-pin.mjs';
import { rereadsRoster } from '../server/instance-record.mjs';
import { cliInstancePin } from '../../client/cli-adapter.mjs';
import { kernelMade } from '../../client/kernel-made.mjs';
import { classifyApiRoute } from '../api-url.mjs';
import { OPERATIONS } from '../../client/above-tested.mjs';

// ── the backend boundary ───────────────────────────────────────────────────────────────────────────────

const LOCAL = { id: 'team', scope: '/fixture/team' };
const REMOTE = { id: 'remote:box', scope: '/fixture/team', remote: true, server: 'box', group: { server: 'box', probe: { ok: true, features: ['instance-pin'] } } };
const row = { instance: 'dev-1', home: '/fixture/team/agents/dev/instances/dev-1' };
const remoteRow = { ...row, server: 'box', addressable: true };
const cli = (...features) => ({ ok: true, bin: '/fixture/oats', features: [INSTANCE_PIN_FEATURE, ...features] });
const answer = (over = {}) => ({ schemaVersion: 1, ok: true, result: { instancePinApi: 1, instance: 'dev-1', home: row.home, pinned: true, changed: true, ...over } });
function boundary(envelope = answer()) {
  const calls = [];
  const request = createInstancePinBoundary({ invoke: async (bin, args, io) => { calls.push({ bin, args, io }); return typeof envelope === 'function' ? envelope() : envelope; } });
  return { calls, request };
}
const context = (over = {}) => () => ({ workspace: LOCAL, cli: cli(), instances: [row], localCwd: '/fixture/cwd', ...over });

test('the feature is the kernel\'s', () => {
  assert.equal(INSTANCE_PIN_FEATURE, 'instance-pin');
});

test('boundary: exactly { instance, home, pinned } or { instance, home, check: true }; anything else runs nothing', async () => {
  const { calls, request } = boundary();
  for (const bad of [null, [], { instance: 'dev-1', home: row.home }, { ...row, pinned: 'on' }, { ...row, pinned: 1 }, { ...row, pinned: null },
    { ...row, pinned: true, extra: 1 }, { ...row, background: true }, { instance: 'dev-1', home: 'relative', pinned: true },
    { instance: '../x', home: row.home, pinned: true }, { ...row, check: 'yes' }, { ...row, check: true, pinned: true }]) {
    assert.deepEqual((await request(bad, context())).reason, { code: 'E_BAD_ARGS', message: 'This pin request was not valid.' }, JSON.stringify(bad));
  }
  assert.equal(calls.length, 0);
});

test('boundary: only a row this computer holds, in a known workspace; a remote one only when addressable', async () => {
  const { calls, request } = boundary();
  assert.equal((await request({ ...row, pinned: true }, context({ workspace: null }))).reason.code, 'E_WORKSPACE_UNKNOWN');
  assert.equal((await request({ ...row, pinned: true }, context({ instances: [] }))).reason.code, 'E_SNAPSHOT_UNKNOWN', 'a retired row is gone: nothing runs');
  assert.equal((await request({ ...row, pinned: true }, context({ instances: [{ ...row, home: '/elsewhere' }] }))).reason.code, 'E_SNAPSHOT_UNKNOWN', 'name and home together');
  assert.equal((await request({ ...row, pinned: true }, context({ workspace: REMOTE, cli: cli('server-probe-features'), instances: [{ ...remoteRow, addressable: false }] }))).reason.code, 'E_SNAPSHOT_UNKNOWN');
  assert.equal(calls.length, 0);
});

test('boundary: the gate is the feature, said as where it is missing (this CLI, its relay, then the host); a check runs nothing', async () => {
  const { calls, request } = boundary();
  assert.deepEqual(await request({ ...row, pinned: true }, context({ cli: { ok: true, bin: '/fixture/oats', features: ['instance-background'] } })),
    { status: 'not-run', reason: { code: 'E_INSTANCE_PIN_UNAVAILABLE', message: "This OATS can't pin an instance.", details: { where: 'local' } } });
  const host = { ...REMOTE, group: { server: 'box', probe: { ok: true, features: ['instance-background'] } } };
  assert.deepEqual((await request({ ...row, check: true }, context({ workspace: host, cli: cli('server-probe-features'), instances: [remoteRow] }))).reason.details, { where: 'server' });
  assert.deepEqual((await request({ ...row, check: true }, context({ workspace: REMOTE, cli: cli(), instances: [remoteRow] }))).reason.details, { where: 'local' }, 'this CLI must relay the hosts\' features');
  assert.deepEqual(await request({ ...row, check: true }, context()), { status: 'ok', instance: 'dev-1', check: true });
  assert.deepEqual(await request({ ...row, check: true }, context({ workspace: REMOTE, cli: cli('server-probe-features'), instances: [remoteRow] })), { status: 'ok', instance: 'dev-1', check: true });
  assert.equal(calls.length, 0);
});

test('boundary: a write runs the verb in the workspace, or routed with --server for a remote row, and decodes the answer', async () => {
  const { calls, request } = boundary();
  assert.deepEqual(await request({ ...row, pinned: true }, context()), { status: 'ok', instance: 'dev-1', pinned: true, changed: true });
  assert.deepEqual(calls[0], { bin: '/fixture/oats', args: { instance: 'dev-1', home: row.home, pinned: true, context: '/fixture/team' }, io: {} });
  await request({ ...row, pinned: false }, context({ workspace: REMOTE, cli: cli('server-probe-features'), instances: [remoteRow] }));
  assert.deepEqual(calls[1], { bin: '/fixture/oats', args: { instance: 'dev-1', home: row.home, pinned: false, server: 'box' }, io: { cwd: '/fixture/cwd' } });
  const thrown = createInstancePinBoundary({ invoke: async () => { throw new Error('PRIVATE'); } });
  assert.deepEqual(await thrown({ ...row, pinned: true }, context()), { status: 'unknown', reason: { code: 'E_OUTCOME_UNKNOWN' } }, 'a crash is an unknown outcome');
});

test('boundary: one write per home at a time; another window\'s second is refused without running', async () => {
  let release; const held = new Promise(r => { release = r; });
  const { calls, request } = boundary(() => held.then(() => answer()));
  const first = request({ ...row, pinned: true }, context());
  assert.deepEqual((await request({ ...row, pinned: false }, context())).reason, { code: 'E_BUSY', message: 'Another window is pinning this instance. Try again.' });
  release(); assert.equal((await first).status, 'ok');
  assert.equal((await request({ ...row, pinned: false }, context())).status, 'ok', 'free again');
  assert.equal(calls.length, 2);
});

test('outcome: only an error the CLI printed is a refusal; the adapter\'s own, or an answer for another instance or home, is unknown', () => {
  const asked = { instance: 'dev-1', home: row.home };
  assert.deepEqual(instancePinOutcome(answer({ pinned: false, changed: false }), asked), { status: 'ok', instance: 'dev-1', pinned: false, changed: false });
  assert.deepEqual(instancePinOutcome({ ok: false, error: kernelMade({ code: 'E_INSTANCE_RETIRING', message: 'dev-1 is being retired' }) }, asked),
    { status: 'refused', reason: { code: 'E_INSTANCE_RETIRING', message: 'dev-1 is being retired' } });
  assert.equal(instancePinOutcome({ ok: false, error: kernelMade({ code: 'E_LIFECYCLE_BUSY', message: 'busy' }) }, asked).reason.code, 'E_LIFECYCLE_BUSY');
  assert.equal(instancePinOutcome({ ok: false, error: kernelMade({ code: 'E_REMOTE_INCOMPATIBLE', message: 'box: no instance-pin' }) }, asked).reason.code, 'E_REMOTE_INCOMPATIBLE');
  assert.deepEqual(instancePinOutcome({ ok: false, error: { code: 'E_SESSION_UNKNOWN', message: 'forged' } }, asked), { status: 'unknown', reason: { code: 'E_OUTCOME_UNKNOWN' } }, 'unmarked: not the kernel\'s');
  assert.deepEqual(instancePinOutcome({ ok: false, error: { code: 'E_CLI_TIMEOUT' } }, asked), { status: 'unknown', reason: { code: 'E_CLI_TIMEOUT' } });
  for (const [label, over] of [['another instance', { instance: 'other' }], ['another home', { home: '/fixture/team/agents/dev/instances/dev-2' }],
    ['no home', { home: undefined }], ['not a boolean', { pinned: 'on' }], ['no changed', { changed: undefined }], ['another api', { instancePinApi: 2 }],
    ['the background\'s answer', { instancePinApi: undefined, instanceBackgroundApi: 1 }]]) {
    assert.equal(instancePinOutcome(answer(over), asked).status, 'unknown', label);
  }
  assert.equal(instancePinOutcome({ ok: true, result: null }, asked).status, 'unknown');
});

test('the route re-reads the roster on a change or an unknown outcome only; it is classified for its 50 s deadline and allowed above the tested bound', () => {
  assert.equal(rereadsRoster({ status: 'ok', instance: 'dev-1', pinned: true, changed: true }), true);
  assert.equal(rereadsRoster({ status: 'unknown', reason: { code: 'E_CLI_TIMEOUT' } }), true);
  for (const result of [{ status: 'ok', instance: 'dev-1', pinned: true, changed: false }, { status: 'ok', instance: 'dev-1', check: true },
    { status: 'refused', reason: { code: 'E_SESSION_UNKNOWN' } }, { status: 'not-run', reason: { code: 'E_BUSY' } }, null]) assert.equal(rereadsRoster(result), false, JSON.stringify(result));
  assert.equal(classifyApiRoute('/api/instance-pin?ws=team'), 'instance-pin');
  assert.equal(OPERATIONS['POST /api/instance-pin']?.class, 'allowed');
});

test('cliInstancePin: argv only, on or off, --home and --dir or --server, --json; refuses bad arguments without running', async () => {
  const runs = [];
  const exec = (bin, argv, opts, done) => { runs.push({ bin, argv, cwd: opts.cwd, shell: opts.shell, timeout: opts.timeout });
    done(null, JSON.stringify(answer())); };
  await cliInstancePin('/fixture/oats', { instance: 'dev-1', home: '/h/dev-1', context: '/fixture/team', pinned: true }, { exec });
  await cliInstancePin('/fixture/oats', { instance: 'dev-1', home: '/h/dev-1', server: 'box', pinned: false }, { exec, cwd: '/fixture/cwd' });
  assert.deepEqual(runs, [
    { bin: '/fixture/oats', argv: ['instance', 'pin', 'dev-1', 'on', '--home', '/h/dev-1', '--dir', '/fixture/team', '--json'], cwd: '/fixture/team', shell: false, timeout: 30000 },
    { bin: '/fixture/oats', argv: ['instance', 'pin', 'dev-1', 'off', '--home', '/h/dev-1', '--server', 'box', '--json'], cwd: '/fixture/cwd', shell: false, timeout: 45000 },
  ]);
  const never = () => assert.fail('must not run');
  for (const bad of [{ instance: '-x', home: '/h', context: '/c', pinned: true }, { instance: 'a', home: 'h', context: '/c', pinned: true },
    { instance: 'a', home: '/h', context: '/c', pinned: 'on' }, { instance: 'a', home: '/h', context: '/c' }, { instance: 'a', home: '/h', server: 'Bad Host', pinned: true },
    { instance: 'a', home: '/h', context: 'c', pinned: true }]) {
    assert.equal((await cliInstancePin('/fixture/oats', bad, { exec: never })).error.code, 'E_BAD_ARGS', JSON.stringify(bad));
  }
  assert.equal((await cliInstancePin('oats', { instance: 'a', home: '/h', context: '/c', pinned: true }, { exec: never })).error.code, 'E_BAD_ARGS', 'an absolute binary');
});
