// The inspect boundary of the shared home (packages/client/inspect-boundary.mjs) and the inspect cache it reads
// (packages/client/inspect-cache.mjs). A client makes its own boundary with its own cache, and two share nothing:
// a flight, a held entry, an epoch or an invalidation of one is not seen by the other. The boundary holds nothing
// itself, so the Desktop may make one per call and the TUI one for its life. The CLI runs through the exec a
// boundary is given, and a provider operation (the Desktop's `run`) is admitted by the same function as an inspect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createInspectBoundary, capabilityAdmission } from '../packages/client/inspect-boundary.mjs';
import { createInspectCache } from '../packages/client/inspect-cache.mjs';
import { capabilityRequest } from '../packages/desktop/server/capabilities.mjs';

const D = '/a/oats', ROOT = `${D}/agents`, HOME = `${ROOT}/dev/instances/dev-1`;
const CLI = { ok: true, bin: '/usr/local/bin/oats', operationsApi: 2, features: ['observe-max-age'] };
const WORKSPACE = { id: D, scope: D, name: 'oats' };
const CONTEXT = { workspace: WORKSPACE, cli: CLI, agents: [{ name: 'dev', agentsRoot: ROOT }],
  instances: [{ home: HOME, instance: 'dev-1', soul: 'dev', createdAt: 'c', startedAt: 's', modules: [] }], localCwd: '/home/me', catalogKey: 'k1' };
const SOUL = { action: 'inspect', selector: { soul: 'dev', agentsRoot: ROOT } };
const ok = (result) => ({ schemaVersion: 1, ok: true, result });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

/** A boundary with its own cache, whose CLI answers `who` and is counted; held back while `gate` (if given) is. */
function boundary(who) {
  const calls = [], cache = createInspectCache();
  let gate = null;
  const made = createInspectBoundary({ cache, maxAge: 60, invoke: async (bin, options, io) => {
    calls.push({ bin, options, io });
    if (gate) await gate.promise;
    return ok({ subject: { kind: 'soul' }, souls: [{ name: who }] });
  } });
  return { calls, cache, made, hold: () => { gate = deferred(); return gate; } };
}
const who = result => result.souls[0].name;

test('two boundaries with two caches share nothing: a held entry of one is not served by the other', async () => {
  const one = boundary('one'), other = boundary('other');
  assert.equal(who(await one.made.inspect(SOUL, CONTEXT)), 'one');
  assert.equal(who(await one.made.inspect(SOUL, CONTEXT)), 'one');
  assert.equal(one.calls.length, 1, 'premise: the second inspect of one is its held entry');
  assert.equal(who(await other.made.inspect(SOUL, CONTEXT)), 'other', 'the other reads its own');
  assert.equal(other.calls.length, 1);
  assert.equal(one.cache.size(), 1); assert.equal(other.cache.size(), 1);
});

test('two boundaries with two caches share nothing: a flight of one is not joined by the other', async () => {
  const one = boundary('one'), other = boundary('other');
  const gate = one.hold();
  const flying = one.made.inspect(SOUL, CONTEXT); await tick();
  assert.equal(one.calls.length, 1);
  assert.equal(who(await other.made.inspect(SOUL, CONTEXT)), 'other', 'the other does not wait on the first one\'s flight');
  assert.equal(other.calls.length, 1);
  // A second inspect of the first joins its own flight.
  const joined = one.made.inspect(SOUL, CONTEXT); await tick();
  assert.equal(one.calls.length, 1);
  gate.resolve();
  assert.deepEqual([who(await flying), who(await joined)], ['one', 'one']);
});

test('two caches share nothing: an invalidation of a deployment in one leaves the other\'s entries, and does not bump its epoch', async () => {
  const one = boundary('one'), other = boundary('other');
  await one.made.inspect(SOUL, CONTEXT); await other.made.inspect(SOUL, CONTEXT);
  one.cache.invalidate(D);
  assert.equal(one.cache.size(), 0);
  assert.equal(other.cache.size(), 1, 'the other\'s entry for the deployment stays');
  await other.made.inspect(SOUL, CONTEXT);
  assert.equal(other.calls.length, 1, 'and is served');
  // The epoch: a flight of the other that is in the air while the first invalidates the deployment still stores.
  other.cache.clear();
  const gate = other.hold();
  const flying = other.made.inspect(SOUL, CONTEXT); await tick();
  one.cache.invalidate(D);
  gate.resolve(); await flying;
  assert.equal(other.cache.size(), 1, 'the other\'s epoch did not move: its flight stored');
  // Premise: an invalidation of the other's own cache while its flight is in the air does keep it from storing.
  other.cache.clear();
  const own = other.hold();
  const again = other.made.inspect(SOUL, CONTEXT); await tick();
  other.cache.invalidate(D);
  own.resolve(); await again;
  assert.equal(other.cache.size(), 0, 'its own invalidation bumped its own epoch');
});

test('the exec a boundary is given is the one the CLI runs through; without one, the call gets no exec', async () => {
  const runs = [];
  const exec = (bin, argv, options, done) => { runs.push({ bin, argv, cwd: options.cwd }); done(null, JSON.stringify(ok({ subject: { kind: 'soul' }, souls: [{ name: 'dev' }] }))); };
  const result = await createInspectBoundary({ exec }).inspect(SOUL, CONTEXT);
  assert.equal(result.souls[0].name, 'dev');
  assert.equal(typeof result.observedAt, 'string');
  assert.equal(result.refreshing, false);
  assert.deepEqual(runs.map(run => [run.bin, run.argv[0], run.argv.includes('--soul'), run.argv.at(-1), run.cwd]), [[CLI.bin, 'inspect', true, '--json', D]]);
  // A caller's own invoke sees what the boundary passes as `io`: { exec } when it has one, {} when not.
  const seen = [];
  const invoke = async (bin, options, io) => { seen.push(io); return ok({ souls: [] }); };
  await createInspectBoundary({ invoke, exec }).inspect(SOUL, CONTEXT);
  await createInspectBoundary({ invoke }).inspect(SOUL, CONTEXT);
  assert.deepEqual(seen, [{ exec }, {}]);
});

test('an inspect boundary inspects only: a run is refused as an unknown action, and nothing runs', async () => {
  const one = boundary('one');
  await assert.rejects(one.made.inspect({ action: 'run', operation: 'knowledge:sync', selector: { home: HOME } }, CONTEXT), { code: 'E_BAD_ARGS', message: 'Unknown capability action' });
  assert.equal(one.calls.length, 0);
});

test('the admission is the same function for run: the same request is refused the same way by both paths', async () => {
  // capabilities.mjs keeps no admission of its own: it imports the boundary's, and none of its refusals is written there.
  const source = readFileSync(new URL('../packages/desktop/server/capabilities.mjs', import.meta.url), 'utf8');
  assert.match(source, /import \{[^}]*\bcapabilityAdmission\b[^}]*\} from '\.\.\/\.\.\/client\/inspect-boundary\.mjs';/);
  for (const words of ['Select a known workspace', 'operations API 2', 'Unknown capability action', 'Invalid refresh flag', 'Select one soul and its agents root',
    'Select one existing home', 'inspection has no scope subject']) assert.equal(source.includes(words), false, `capabilities.mjs words "${words}" itself`);
  // Behaviour: each refusal that does not depend on the action is the same, code and message, for an inspect and a run.
  const run = (request, context) => capabilityRequest({ ...request, action: 'run', operation: 'knowledge:sync' }, { ...context, invoke: assert.fail });
  const inspect = (request, context) => createInspectBoundary({ invoke: assert.fail }).inspect({ ...request, action: 'inspect' }, context);
  const cases = {
    'no workspace': [{ selector: { home: HOME } }, { ...CONTEXT, workspace: null }],
    'an old CLI': [{ selector: { home: HOME } }, { ...CONTEXT, cli: { ...CLI, operationsApi: 1 } }],
    'a remote workspace with no route': [{ selector: { home: HOME } }, { ...CONTEXT, workspace: { ...WORKSPACE, remote: true, server: 'devbox', registrationPresent: true }, cli: { ...CLI, remote: [] } }],
    'a home and a soul': [{ selector: { home: HOME, soul: 'dev' } }, CONTEXT],
    'an unknown home': [{ selector: { home: '/elsewhere' } }, CONTEXT],
    'an unknown soul': [{ selector: { soul: 'ops', agentsRoot: ROOT } }, CONTEXT],
    'no subject': [{ selector: {} }, CONTEXT],
  };
  for (const [what, [request, context]] of Object.entries(cases)) {
    const refusal = await inspect(request, context).then(() => assert.fail(`${what}: inspect admitted`), error => ({ code: error.code, message: error.message, reason: error.reason }));
    const runs = await run(request, context).then(() => assert.fail(`${what}: run admitted`), error => ({ code: error.code, message: error.message, reason: error.reason }));
    assert.deepEqual(runs, refusal, what);
  }
  // The action-specific checks are the same function's too: a run's arguments are refused for an inspect, a refresh for a run.
  assert.throws(() => capabilityAdmission({ action: 'inspect', args: { a: 'b' }, selector: { home: HOME } }, CONTEXT), { message: 'Invalid operation arguments' });
  assert.throws(() => capabilityAdmission({ action: 'run', refresh: true, selector: { home: HOME } }, CONTEXT), { message: 'Invalid refresh flag' });
  // And what it admits is the same subject for both.
  const forInspect = capabilityAdmission({ action: 'inspect', selector: { home: HOME } }, CONTEXT), forRun = capabilityAdmission({ action: 'run', selector: { home: HOME } }, CONTEXT);
  assert.deepEqual({ ...forRun, action: 'inspect' }, forInspect);
});

test('a refusal carries the team labels its details name, bounded, whatever its code; the boundary names no code, and the Desktop keeps them for E_TEAM_CONFLICT', async () => {
  const answer = error => async () => ({ schemaVersion: 1, ok: false, error });
  const refusal = error => createInspectBoundary({ invoke: answer(error) }).inspect(SOUL, CONTEXT).then(() => assert.fail('admitted'), thrown => thrown);
  const conflict = await refusal({ code: 'E_TEAM_CONFLICT', message: 'two teams', details: { labels: ['engineering', 'global'] } });
  assert.deepEqual([conflict.code, conflict.message, conflict.labels], ['E_TEAM_CONFLICT', 'two teams', ['engineering', 'global']]);
  assert.deepEqual((await refusal({ code: 'E_OTHER', message: 'x', details: { labels: ['a', 'b'] } })).labels, ['a', 'b'], 'any code');
  for (const labels of [['a'], ['a', '-x'], 'a,b', Array.from({ length: 17 }, (_, i) => `t${i}`)]) {
    assert.equal(Object.hasOwn(await refusal({ code: 'E_OTHER', message: 'x', details: { labels } }), 'labels'), false, JSON.stringify(labels));
  }
  const source = readFileSync(new URL('../packages/client/inspect-boundary.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /E_TEAM_CONFLICT/, 'the shared home writes no retired kernel code');
  // The Desktop's capabilityRequest keeps the labels of E_TEAM_CONFLICT only, for an inspect and a run alike.
  const desktop = (action, error) => capabilityRequest({ ...SOUL, action, ...(action === 'run' ? { operation: 'knowledge:sync', selector: { home: HOME } } : {}) },
    { ...CONTEXT, invoke: answer(error) }).then(() => assert.fail('admitted'), thrown => thrown);
  for (const action of ['inspect', 'run']) {
    assert.deepEqual((await desktop(action, { code: 'E_TEAM_CONFLICT', message: 'c', details: { labels: ['a', 'b'] } })).labels, ['a', 'b'], action);
    assert.equal(Object.hasOwn(await desktop(action, { code: 'E_OTHER', message: 'x', details: { labels: ['a', 'b'] } }), 'labels'), false, action);
  }
});
