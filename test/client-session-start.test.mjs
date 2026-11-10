// The start and restart rule of the shared home (packages/client/session-start.mjs): the gate's seven rules
// in order, the home a local start launches in, and what a failed start is ("refused": nothing was started;
// "uncertain": anything else).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGate, startInstance, verifiedLocalHome, STARTED_NOTHING_CODES, CLAIM_STARTED_NOTHING_CODES } from '../packages/client/session-start.mjs';
import { clientTerms } from '../packages/client/client-terms.mjs';

const terms = clientTerms({ name: 'the test client', self: 'this test client', selfInitial: 'This test client', update: 'Update the test client.', thisMachine: 'This machine' });
const CLI = { ok: true, bin: '/installed/oats', features: ['session-start', 'session-restart', 'launch-config'], remote: ['session-start', 'session-restart', 'launch-config'] };
const row = (more = {}) => ({ instance: 'dev-1', home: '/team/agents/dev/instances/dev-1', agentsRoot: '/team/agents', running: false, ...more });
const there = (more = {}) => row({ server: 'host', addressable: true, ...more });
const without = (list, name) => list.filter(f => f !== name);

test('every wording function refuses a call without the client\'s terms', async () => {
  for (const t of [undefined, null, { ...terms }]) {
    assert.throws(() => startGate(CLI, row(), {}, t), { name: 'TypeError', message: /^startGate: terms/ });
    await assert.rejects(startInstance(CLI, row(), {}, { terms: t, start: assert.fail }), { name: 'TypeError', message: /^startInstance: terms/ });
  }
});

test('the gate: the first of its seven rules that applies, in order, with its code and sentence', () => {
  const gate = (cli, r, o) => startGate(cli, r, o, terms);
  assert.equal(gate(CLI, row()), null, 'a stopped row, a CLI with every feature: no refusal');
  assert.equal(gate(CLI, row({ running: true }), { restart: true }), null, 'a restart of a running row');
  for (const [name, answer, code, sentence] of [
    ['1 not in the roster', gate(CLI, null), 'not-in-roster', 'This instance is no longer in this workspace. Refresh the workspace roster.'],
    ['2 running, not a restart', gate(CLI, row({ running: true })), 'already-running', 'This instance is already running.'],
    ['3 state not known', gate(CLI, row({ running: undefined })), 'state-unknown', 'Could not verify whether this instance is running. Refresh its status before starting.'],
    ['3 a restart of a row not known running', gate(CLI, row({ running: null }), { restart: true }), 'state-unknown', 'Could not verify whether this instance is running. Refresh its status before starting.'],
    ['4 a server\'s row not addressable', gate(CLI, there({ addressable: false })), 'E_SNAPSHOT_UNKNOWN', null],
    ['5 no accepted CLI', gate({ ok: false }, row()), 'cli-unavailable', 'Starting an existing instance needs an updated OATS CLI. Update OATS and retry.'],
    ['5 no session-start', gate({ ...CLI, features: [], install: 'npm install -g @awebai/oats' }, row()), 'unsupported-start-option', 'Starting an existing instance needs an updated OATS CLI. npm install -g @awebai/oats'],
    ['5 no remote session-start', gate({ ...CLI, remote: [] }, there()), 'unsupported-remote-operation', 'Update the OATS CLI to enable starting instances on a server.'],
    ['6 a restart without session-restart', gate({ ...CLI, features: without(CLI.features, 'session-restart') }, row(), { restart: true }), 'unsupported-start-option', 'Update OATS to restart with another harness or configuration.'],
    ['6 a server\'s restart without it remotely', gate({ ...CLI, remote: without(CLI.remote, 'session-restart') }, there(), { restart: true }), 'unsupported-start-option', 'Update OATS to restart with another harness or configuration.'],
    ['7 a launch choice without launch-config', gate({ ...CLI, features: without(CLI.features, 'launch-config') }, row(), { choices: { harness: 'codex' } }), 'unsupported-start-option', 'Update OATS to change the launch configuration.'],
    ['7 a server\'s launch choice without it remotely', gate({ ...CLI, remote: without(CLI.remote, 'launch-config') }, there(), { choices: { yolo: false } }), 'unsupported-start-option', 'Update OATS to change the launch configuration.'],
  ]) {
    assert.equal(answer?.code, code, name);
    if (sentence) assert.equal(answer.sentence, sentence, name); else assert.equal(typeof answer.sentence, 'string', name);
  }
  // Order: an earlier rule wins over a later one.
  assert.equal(gate({ ok: false }, row({ running: true })).code, 'already-running');
  assert.equal(gate({ ok: false }, there({ addressable: false })).code, 'E_SNAPSHOT_UNKNOWN');
  // The word that selects no configuration is a launch choice like any other: no refusal of its own.
  assert.equal(gate(CLI, there(), { choices: { launchConfig: 'none' } }), null);
  assert.equal(gate({ ...CLI, features: ['session-start'] }, row(), { choices: { launchConfig: 'none' } }).code, 'unsupported-start-option');
  // A row's own runtime error travels as `detail`, through the display filter, for the client to show with its speaker.
  assert.equal(gate(CLI, row({ running: undefined, runtimeError: 'tmux: no server' })).detail, 'tmux: no server');
  assert.doesNotMatch(gate(CLI, row({ running: undefined, runtimeError: 'tmux: no server\u0007' })).detail, /\u0007/);
  assert.equal(Object.hasOwn(gate(CLI, row({ running: undefined })), 'detail'), false, 'no runtime error: no detail');
});

test('the home a local start launches in: only the exact home a deployment reported, inside that deployment', t => {
  const scope = realpathSync(mkdtempSync(join(tmpdir(), 'oats-start-home-'))), outside = realpathSync(mkdtempSync(join(tmpdir(), 'oats-start-out-')));
  t.after(() => { rmSync(scope, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  const home = join(scope, 'agents', 'dev', 'instances', 'dev-1'); mkdirSync(home, { recursive: true });
  const evil = join(outside, 'instances', 'evil-1'); mkdirSync(evil, { recursive: true });
  const link = join(scope, 'agents', 'dev', 'instances', 'link-1'); symlinkSync(evil, link);
  const unreported = join(scope, 'agents', 'dev', 'instances', 'other-1'); mkdirSync(unreported, { recursive: true });
  const deployments = [{ id: scope, instances: [{ instance: 'dev-1', home }, { instance: 'link-1', home: link }, { instance: 'evil-1', home: evil }] }];
  const verify = r => verifiedLocalHome(r, deployments, realpathSync);
  assert.equal(verify({ instance: 'dev-1', home }), home, 'the reported home');
  assert.equal(verify({ instance: 'other-1', home: unreported }), null, 'a home the kernel did not report');
  assert.equal(verify({ instance: 'link-1', home: link }), null, 'a reported home that resolves outside');
  assert.equal(verify({ instance: 'evil-1', home: evil }), null, 'a reported home outside the deployment');
  assert.equal(verify({ instance: 'other-name', home }), null, 'a name that is not the home\'s');
  assert.equal(verify({ instance: 'dev-1', home, server: 'host' }), null, 'a server\'s row has no local home');
  assert.equal(verifiedLocalHome({ instance: 'dev-1', home }, [{ ...deployments[0], remote: true }], realpathSync), null, 'a remote deployment grants none');
  for (const bad of [{ instance: 'dev-1' }, { instance: 'dev-1', home: 42 }, null]) assert.equal(verify(bad), null);
});

test('a start: the gate and the home check run first and call nothing; the CLI gets the row\'s home, its choices and the kernel\'s harness flag', async () => {
  const calls = [];
  const start = async (bin, args, io) => { calls.push({ bin, args, io }); return { schemaVersion: 1, ok: true, result: { launched: true } }; };
  const run = (cli, r, choices, more = {}) => startInstance(cli, r, choices, { verifyHome: x => x.home, localCwd: '/here', start, terms, ...more });
  assert.deepEqual(await run(CLI, row({ running: true }), {}), { ok: false, outcome: 'refused', code: 'already-running', sentence: 'This instance is already running.', detail: null, ran: false });
  assert.deepEqual(await run(CLI, row(), {}, { verifyHome: () => null }),
    { ok: false, outcome: 'refused', code: 'E_HOME_UNVERIFIED', sentence: 'Instance home is outside the workspace instances layout', detail: null, ran: false });
  assert.equal(calls.length, 0, 'nothing was called for a refusal');
  assert.deepEqual(await run(CLI, row(), { model: 'opus', launchConfig: 'none', harness: 'codex' }), { ok: true, result: { launched: true } });
  assert.deepEqual(calls[0].args, { home: row().home, model: 'opus', launchConfig: 'none', harness: 'codex', harnessFlag: '--runtime', yolo: undefined, restart: false, workspaceDir: '/team', server: undefined });
  await run({ ...CLI, features: [...CLI.features, 'harness'] }, there({ running: true }), {}, { restart: true, wait: 5 });
  assert.deepEqual([calls[1].args.server, calls[1].args.workspaceDir, calls[1].args.restart, calls[1].args.harnessFlag], ['host', '/here', true, '--harness']);
  assert.deepEqual(calls[1].io, { wait: 5 }, 'the wait, the timer and the exec pass to the CLI call as given');
  // A server's row needs no local home check.
  assert.equal((await run(CLI, there(), {}, { verifyHome: () => assert.fail('a server\'s row has no local home') })).ok, true);
});

test('a failed start: refused only for the kernel\'s three codes; anything else, the end of the wait included, is uncertain', async () => {
  assert.deepEqual(STARTED_NOTHING_CODES, ['E_SESSION_START_BUSY', 'E_SESSION_START_LOCK_STUCK', 'E_SESSION_RUNNING']); assert.equal(Object.isFrozen(STARTED_NOTHING_CODES), true);
  const answering = error => startInstance(CLI, row(), {}, { verifyHome: x => x.home, start: async () => ({ schemaVersion: 1, ok: false, ...(error ? { error } : {}) }), terms });
  for (const [error, outcome, sentence] of [
    [{ code: 'E_SESSION_START_BUSY', message: 'session start busy: the home\'s start lock is held' }, 'refused', 'OATS refused this start as busy. Nothing was started.'],
    [{ code: 'E_SESSION_START_LOCK_STUCK', message: '/w/agents/dev/instances/dev-1/.oats-start.lock is the start lock directory of an earlier OATS; nothing was stopped or started. Once no earlier oats is running, remove that directory and retry' },
      'refused', 'An earlier OATS\'s start lock, or something else that is no upgrade\'s, is in this instance\'s home; OATS\'s message names it. Nothing was started. Remove it once no earlier OATS is running: waiting will not clear it.'],
    [{ code: 'E_SESSION_RUNNING', message: 'session already running in tmux window =agents:=dev-1' }, 'refused', 'This instance is already running. Nothing was started.'],
    [{ code: 'E_START_UNCONFIRMED' }, 'uncertain', null],
    [{ code: 'E_LAUNCH_CONFIG_AMBIGUOUS', message: 'two configurations for codex' }, 'uncertain', null],
    [{ code: 'E_CLI_PROTOCOL', message: 'oats did not print a valid JSON envelope on stdout' }, 'uncertain', null],
    [null, 'uncertain', null],
  ]) {
    const answer = await answering(error);
    assert.equal(answer.ok, false); assert.equal(answer.outcome, outcome, error?.code); assert.equal(answer.sentence, sentence, error?.code); assert.equal(answer.ran, true);
    assert.equal(answer.code, error?.code ?? 'E_CLI_PROTOCOL');
    // The kernel's message is `detail`, as it came for an ordinary line: the text the Desktop shows today.
    assert.equal(answer.detail, error?.message ?? null, error?.code);
  }
  // Through the display filter: a control character never reaches a client.
  assert.equal((await answering({ code: 'E_SESSION_RUNNING', message: 'running\u001b[2J here' })).detail.includes('\u001b'), false);
});

test('a start refused because of something else on the home: refused from a kernel that lists lifecycle-claim-start, by the answering kernel\'s list, in words for a start or a restart', async () => {
  assert.deepEqual(CLAIM_STARTED_NOTHING_CODES, ['E_LIFECYCLE_BUSY', 'E_INSTANCE_RETIRING']); assert.equal(Object.isFrozen(CLAIM_STARTED_NOTHING_CODES), true);
  const CLAIMS = { ...CLI, features: [...CLI.features, 'lifecycle-claim-stop', 'lifecycle-claim-start', 'server-probe-features'] };
  const answering = (cli, r, error, options = {}) => startInstance(cli, r, {}, { verifyHome: x => x.home, start: async () => ({ schemaVersion: 1, ok: false, error }), terms, ...options });
  const busy = holder => ({ code: 'E_LIFECYCLE_BUSY', message: 'a stop of dev-1 is already running', details: { action: 'stop', ...(holder ? { holder } : {}) } });
  const retiring = { code: 'E_INSTANCE_RETIRING', message: 'dev-1 is being retired', details: { action: 'retire' } };
  // The sentence of each answer, for a start and for a restart: only a holder that runs is offered waiting.
  for (const [error, started, restarted] of [
    [busy('running'), 'Another OATS command is running on this instance. Nothing was started. Wait for it to finish, then try again.', 'Another OATS command is running on this instance. Nothing was stopped or started. Wait for it to finish, then try again.'],
    [busy('unknown'), 'Nothing was started. OATS can\'t tell whether another command is still running on this instance.', 'Nothing was stopped or started. OATS can\'t tell whether another command is still running on this instance.'],
    [busy('none'), 'Nothing was started. There is no other command to wait for.', 'Nothing was stopped or started. There is no other command to wait for.'],
    [busy(), 'OATS refused this start as busy. Nothing was started.', 'OATS refused this restart as busy. Nothing was stopped or started.'],
    [busy('a holder of another kernel'), 'OATS refused this start as busy. Nothing was started.', 'OATS refused this restart as busy. Nothing was stopped or started.'],
    [retiring, 'This instance is being retired, or has cleanup to finish. Nothing was started.', 'This instance is being retired, or has cleanup to finish. Nothing was stopped or started.'],
  ]) {
    assert.deepEqual(await answering(CLAIMS, row(), error), { ok: false, outcome: 'refused', code: error.code, sentence: started, detail: error.message, ran: true, atClaim: true });
    assert.equal((await answering(CLAIMS, row({ running: true }), error, { restart: true })).sentence, restarted);
  }
  // A kernel without the feature: uncertain, as before, with the kernel's message and no sentence of the rule's.
  for (const error of [busy('running'), retiring])
    assert.deepEqual(await answering(CLI, row(), error), { ok: false, outcome: 'uncertain', code: error.code, sentence: null, detail: error.message, ran: true });
  // A server's row is judged by its host's list, never this computer's, and a host not known is no host that has it.
  const group = (features, ok = true) => ({ probe: { ok, features } });
  for (const [name, cli, options, outcome] of [
    ['the host lists it, this computer does not', { ...CLI, features: [...CLI.features, 'server-probe-features'] }, { group: group(['lifecycle-claim-stop', 'lifecycle-claim-start']) }, 'refused'],
    ['this computer lists it, the host does not', CLAIMS, { group: group(['lifecycle-claim-stop']) }, 'uncertain'],
    ['the host\'s roster was not read', CLAIMS, { group: group(['lifecycle-claim-start'], false) }, 'uncertain'],
    ['no roster group', CLAIMS, {}, 'uncertain'],
    ['this computer relays no host\'s features', { ...CLI, features: [...CLI.features, 'lifecycle-claim-start'] }, { group: group(['lifecycle-claim-start']) }, 'uncertain'],
  ]) assert.equal((await answering(cli, there(), busy('running'), options)).outcome, outcome, name);
  // A group says nothing of a local row: this computer's kernel answers it.
  assert.equal((await answering(CLI, row(), retiring, { group: group(['lifecycle-claim-start']) })).outcome, 'uncertain');
  // Another code of a kernel with the feature is not read by this rule; a takeover's answer stays uncertain.
  const failed = await answering(CLAIMS, row(), { code: 'E_LIFECYCLE_FAILED', message: 'a step was ended; after that: a stop is running', details: { holder: 'running' } });
  assert.deepEqual([failed.outcome, failed.sentence, Object.hasOwn(failed, 'atClaim')], ['uncertain', null, false]);
});

test('a call that fails on its way is uncertain, in the rule\'s words, with no exception text: an exec that throws, a rejected call', async () => {
  const failed = { ok: false, outcome: 'uncertain', code: 'E_CLI_FAILED', sentence: 'The start could not be confirmed: the call to the OATS CLI failed. Refresh its status before starting it again.', detail: null, ran: true };
  // The CLI call itself (cli-adapter.mjs cliStart), whose exec throws before any child exists.
  assert.deepEqual(await startInstance(CLI, row(), {}, { verifyHome: x => x.home, terms, exec: () => { throw new Error('spawn /installed/oats EAGAIN'); }, after: () => () => {} }), failed);
  assert.deepEqual(await startInstance(CLI, row(), {}, { verifyHome: x => x.home, terms, start: async () => { throw new Error('socket hang up'); } }), failed);
  assert.deepEqual(await startInstance(CLI, row(), {}, { verifyHome: x => x.home, terms, start: () => { throw new Error('thrown at the call'); } }), failed);
});

test('a start that stopped at a launch prompt keeps its retained outcome when it names this row, as the route did', async () => {
  const home = row().home;
  const details = { retained: true, unconfirmed: true, instance: 'dev-1', home, launched: 'unknown',
    target: { backend: 'tmux', socket: '/tmp/fixture.sock', session: 'agents', window: 'dev-1', windowId: '@2', paneId: '%2', pid: 1234 }, parentLineageCommitted: false,
    launchPrompts: { status: 'blocked', answers: [], reason: 'blocked: unexpected prompt', receipt: [{ ok: true, results: [{ path: `${home}/.oats-events.jsonl`, ok: true }] }] } };
  const answering = d => startInstance(CLI, row(), {}, { verifyHome: x => x.home, terms,
    start: async () => ({ schemaVersion: 1, ok: false, error: { code: 'E_SPAWN_INCOMPLETE', message: 'blocked: unexpected prompt', details: d } }) });
  const kept = await answering(details);
  assert.equal(kept.outcome, 'uncertain'); assert.equal(kept.incomplete?.instance, 'dev-1');
  assert.equal(Object.hasOwn(await answering({ ...details, instance: 'someone-else' }), 'incomplete'), false, 'another instance\'s outcome is not this row\'s');
  assert.equal(Object.hasOwn(await answering({ nonsense: true }), 'incomplete'), false, 'an outcome that does not decode');
});
