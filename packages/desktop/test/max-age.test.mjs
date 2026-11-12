// Bounded observation reuse (kernel feature observe-max-age): the three read
// adapters pass `--max-age <seconds>` ONLY when the probe declares the feature,
// never to a mutating verb, and never an unvalidated value; the observation
// block is projected once. Fake executors capture argv; no CLI runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cliDeploymentRead } from '../../client/deployment-read-cli.mjs';
import { cliWorkspace, workspaceArgv } from '../../client/workspace-cli.mjs';
import { cliCapability } from '../../client/cli-adapter.mjs';
import { capabilityRequest } from '../server/capabilities.mjs';
import { createInspectCache } from '../../client/inspect-cache.mjs';
import { observationData } from '../../client/deployment-data.mjs';
import { OBSERVE_MAX_AGE_FEATURE, validMaxAge, maxAgeArgv } from '../../client/deployment-contract.mjs';
import { DESKTOP_TERMS } from '../renderer/desktop-terms.mjs';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/workspace-v2/${name}.json`, import.meta.url), 'utf8'));
const probe = fixture('version'), status = fixture('status'), header = fixture('workspace-status');
const context = '/fixture/base/northwind-workspace';
const cli = declared => ({ ...probe, ok: true, bin: '/fixture/bin/oats', features: declared ? [...probe.features, OBSERVE_MAX_AGE_FEATURE] : [...probe.features] });
const envelope = result => JSON.stringify({ schemaVersion: 1, ok: true, result });
/** Captures every argv the adapter hands to the executor and replies with `document`. */
function capture(document) {
  const calls = [];
  return { calls, exec(_bin, argv, _options, done) { calls.push(argv); done(null, typeof document === 'string' ? document : JSON.stringify(document)); } };
}
const flagCount = argv => argv.filter(a => a === '--max-age').length;
const INVALID = [-1, 1.5, '60', 1e9, null, NaN, Infinity, 86401, true, [], {}];

test('contract: the feature name, the value grammar and the gated argv fragment', () => {
  assert.equal(OBSERVE_MAX_AGE_FEATURE, 'observe-max-age');
  for (const ok of [undefined, 0, 1, 60, 86400]) assert.equal(validMaxAge(ok), true, String(ok));
  for (const bad of INVALID) assert.equal(validMaxAge(bad), false, String(bad));
  assert.deepEqual(maxAgeArgv(['observe-max-age'], 60), ['--max-age', '60']);
  assert.deepEqual(maxAgeArgv(['observe-max-age'], 0), ['--max-age', '0']);
  assert.deepEqual(maxAgeArgv(['observe-max-age'], undefined), []);
  for (const features of [undefined, null, [], ['workspace-v2'], 'observe-max-age', { includes: () => true }]) assert.deepEqual(maxAgeArgv(features, 60), [], String(features));
});

/* ── deployment-read-cli: status and workspace status ── */
for (const action of ['status', 'workspace-status']) {
  const verb = action === 'status' ? ['status'] : ['workspace', 'status'];
  const document = action === 'status' ? status : header;
  test(`${action}: declared feature puts --max-age once, before --json; 0 is live`, async () => {
    for (const [maxAge, token] of [[60, '60'], [0, '0']]) {
      const io = capture(document);
      const result = await cliDeploymentRead(cli(true), { action, context, maxAge }, io);
      assert.equal(result.ok, true);
      assert.deepEqual(io.calls, [[...verb, '--dir', context, '--max-age', token, '--json']]);
      assert.equal(flagCount(io.calls[0]), 1);
    }
  });
  test(`${action}: without the feature the argv is byte-identical to the flagless read`, async () => {
    const plain = capture(document), given = capture(document);
    assert.equal((await cliDeploymentRead(cli(false), { action, context }, plain)).ok, true);
    assert.equal((await cliDeploymentRead(cli(false), { action, context, maxAge: 60 }, given)).ok, true);
    assert.deepEqual(given.calls, plain.calls);
    assert.deepEqual(given.calls, [[...verb, '--dir', context, '--json']]);
    assert.equal(flagCount(given.calls[0]), 0);
  });
  test(`${action}: an invalid maxAge is E_BAD_ARGS before any exec, feature or not`, async () => {
    for (const declared of [true, false]) for (const maxAge of INVALID) {
      const result = await cliDeploymentRead(cli(declared), { action, context, maxAge }, { exec: () => assert.fail(`exec with maxAge ${String(maxAge)}`) });
      assert.deepEqual(result.ok, false); assert.equal(result.reason.code, 'E_BAD_ARGS');
    }
  });
}

/* ── workspace-cli: capabilities and souls take it; sync and onboard never ── */
const capabilities = fixture('f2/capabilities');
for (const action of ['capabilities', 'souls']) {
  test(`${action}: declared feature puts --max-age once, before --json; 0 is live`, async () => {
    for (const [maxAge, token] of [[60, '60'], [0, '0']]) {
      assert.deepEqual(workspaceArgv({ action, context, maxAge }).argv, [action, '--dir', context, '--max-age', token, '--json']);
      const io = capture(capabilities);
      const result = await cliWorkspace(cli(true), { action, context, maxAge }, DESKTOP_TERMS, io);
      assert.equal(result.ok, true);
      assert.deepEqual(io.calls, [[action, '--dir', context, '--max-age', token, '--json']]);
      assert.equal(flagCount(io.calls[0]), 1);
    }
  });
  test(`${action}: without the feature the flag is dropped from a copy and the argv is the flagless one`, async () => {
    const plain = capture(capabilities), given = capture(capabilities);
    const request = Object.freeze({ action, context, maxAge: 60 });
    assert.equal((await cliWorkspace(cli(false), { action, context }, DESKTOP_TERMS, plain)).ok, true);
    assert.equal((await cliWorkspace(cli(false), request, DESKTOP_TERMS, given)).ok, true);
    assert.deepEqual(given.calls, plain.calls);
    assert.deepEqual(given.calls, [[action, '--dir', context, '--json']]);
    assert.deepEqual(request, { action, context, maxAge: 60 }, 'the caller\'s request is not mutated');
  });
  test(`${action}: an invalid maxAge is E_BAD_ARGS before any exec, feature or not`, async () => {
    for (const maxAge of INVALID) {
      assert.equal(workspaceArgv({ action, context, maxAge }), null, String(maxAge));
      for (const declared of [true, false]) {
        const result = await cliWorkspace(cli(declared), { action, context, maxAge }, DESKTOP_TERMS, { exec: () => assert.fail(`exec with maxAge ${String(maxAge)}`) });
        assert.equal(result.ok, false); assert.equal(result.reason.code, 'E_BAD_ARGS');
      }
    }
  });
}
test('sync and onboard refuse maxAge (any value, feature or not) before any exec', async () => {
  const requests = [{ action: 'sync', context }, { action: 'onboard', dir: context, workspace: 'github.com/acme/agents' }];
  for (const base of requests) for (const maxAge of [60, 0, undefined]) {
    assert.equal(workspaceArgv({ ...base, maxAge }), null, `${base.action} ${String(maxAge)}`);
    for (const declared of [true, false]) {
      const result = await cliWorkspace(cli(declared), { ...base, maxAge }, DESKTOP_TERMS, { exec: () => assert.fail(`${base.action} exec with maxAge`) });
      assert.equal(result.ok, false); assert.equal(result.reason.code, 'E_BAD_ARGS');
    }
  }
  // Without the key the same requests are well-formed: the refusal is the flag's, not the verb's.
  assert.deepEqual(workspaceArgv(requests[0]).argv, ['sync', '--dir', context, '--json']);
  assert.deepEqual(workspaceArgv(requests[1]).argv, ['onboard', context, '--workspace', 'github.com/acme/agents', '--json']);
});

/* ── cli-adapter: inspect takes it; operation run never ── */
const declared = cli(true).features, undeclared = cli(false).features;
test('inspect: declared feature puts --max-age once, after the target and before --json; 0 is live', async () => {
  for (const [maxAge, token] of [[60, '60'], [0, '0']]) {
    const io = capture(envelope({ capabilities: [] }));
    const result = await cliCapability('/fixture/bin/oats', { action: 'inspect', home: '/homes/dev-1', localCwd: '/homes/dev-1', maxAge, features: declared }, io);
    assert.equal(result.ok, true);
    assert.deepEqual(io.calls, [['inspect', '--home', '/homes/dev-1', '--max-age', token, '--json']]);
    assert.equal(flagCount(io.calls[0]), 1);
  }
});
test('inspect: without the feature (absent or undeclared) the argv is byte-identical to the flagless read', async () => {
  const plain = capture(envelope({}));
  await cliCapability('/fixture/bin/oats', { action: 'inspect', context, soul: 'dev', agentsRoot: `${context}/agents`, localCwd: context, features: undeclared }, plain);
  for (const features of [undeclared, undefined, null]) {
    const given = capture(envelope({}));
    await cliCapability('/fixture/bin/oats', { action: 'inspect', context, soul: 'dev', agentsRoot: `${context}/agents`, localCwd: context, maxAge: 60, features }, given);
    assert.deepEqual(given.calls, plain.calls);
    assert.deepEqual(given.calls, [['inspect', '--dir', context, '--soul', 'dev', '--agents-root', `${context}/agents`, '--json']]);
  }
});
test('operation run refuses maxAge (E_BAD_ARGS, no exec) even with the feature; inspect refuses invalid values', async () => {
  for (const features of [declared, undeclared]) for (const maxAge of [60, 0]) {
    await assert.rejects(cliCapability('/fixture/bin/oats', { action: 'run', home: '/homes/dev-1', localCwd: '/homes/dev-1', operation: 'knowledge:harvest', maxAge, features }, { exec: assert.fail }),
      { code: 'E_BAD_ARGS', message: /inspection/ });
  }
  for (const features of [declared, undeclared]) for (const maxAge of INVALID) {
    await assert.rejects(cliCapability('/fixture/bin/oats', { action: 'inspect', home: '/homes/dev-1', localCwd: '/homes/dev-1', maxAge, features }, { exec: assert.fail }),
      { code: 'E_BAD_ARGS', message: /observation age/ }, String(maxAge));
  }
  // The run path is otherwise unchanged: the same request without maxAge reaches the CLI.
  const io = capture(envelope({ harvest: 'skipped' }));
  await cliCapability('/fixture/bin/oats', { action: 'run', home: '/homes/dev-1', localCwd: '/homes/dev-1', operation: 'knowledge:harvest', features: declared }, io);
  assert.deepEqual(io.calls, [['operation', 'run', 'knowledge:harvest', '--home', '/homes/dev-1', '--json']]);
});

test('inspect --server never carries --max-age (reuse is local only): the adapter refuses the pair, the boundary omits it for a remote workspace', async () => {
  for (const features of [declared, undeclared]) for (const maxAge of [60, 0]) {
    await assert.rejects(cliCapability('/fixture/bin/oats', { action: 'inspect', context, server: 'builder', soul: 'dev', agentsRoot: `${context}/agents`, localCwd: '/local', maxAge, features }, { exec: assert.fail }),
      { code: 'E_BAD_ARGS', message: /route/ });
  }
  // Through the capability boundary: a routed inspect is asked WITHOUT maxAge even when the boundary has one and refresh is forced.
  const calls = [];
  const remoteCli = { ...cli(true), operationsApi: 2, remote: ['operations'] };
  const workspace = { id: 'remote:builder', scope: '/remote/member', remote: true, server: 'builder', registrationPresent: true };
  const agents = [{ name: 'dev', agentsRoot: '/remote/member/agents' }];
  const invoke = async (_bin, options) => { calls.push(options); return JSON.parse(envelope({ subject: { kind: 'soul', soul: 'dev' } })); };
  for (const request of [{ action: 'inspect', selector: { soul: 'dev', agentsRoot: '/remote/member/agents' } }, { action: 'inspect', selector: { soul: 'dev', agentsRoot: '/remote/member/agents' }, refresh: true }]) {
    await capabilityRequest(request, { workspace, cli: remoteCli, agents, instances: [], localCwd: '/local', invoke, maxAge: 60, cache: createInspectCache() });
  }
  assert.equal(calls.length, 2);
  for (const options of calls) { assert.equal(options.server, 'builder'); assert.equal(Object.hasOwn(options, 'maxAge'), false, JSON.stringify(options)); }
  // The same requests on a local workspace do carry it.
  calls.length = 0;
  await capabilityRequest({ action: 'inspect', selector: { soul: 'dev', agentsRoot: `${context}/agents` } }, { workspace: { id: context, scope: context }, cli: remoteCli, agents: [{ name: 'dev', agentsRoot: `${context}/agents` }], instances: [], localCwd: context, invoke, maxAge: 60, cache: createInspectCache() });
  assert.equal(calls[0].maxAge, 60);
});

/* ── observationData: one projection for both document shapes ── */
const observation = { observedAt: '2026-01-05T10:11:12.000Z', reused: true };
test('observationData: absent is {null, null} for both a raw status object and an envelope', () => {
  assert.deepEqual(observationData(status), { observedAt: null, reused: null });
  assert.deepEqual(observationData(header), { observedAt: null, reused: null });
  assert.deepEqual(observationData({ schemaVersion: 1, ok: true, result: {} }), { observedAt: null, reused: null });
  assert.deepEqual(observationData({ schemaVersion: 1, ok: true }), { observedAt: null, reused: null });
});
test('observationData: reads the raw status top level and the envelope result, and copies only the two fields', () => {
  assert.deepEqual(observationData({ ...status, observation: { ...observation, extra: 1 } }), observation);
  assert.deepEqual(observationData({ ...header, result: { ...header.result, observation: { observedAt: '2026-01-05T10:11:12Z', reused: false } } }), { observedAt: '2026-01-05T10:11:12Z', reused: false });
  // An envelope's top-level `observation` is not the kernel's placement; it is not read.
  assert.deepEqual(observationData({ ...header, observation }), { observedAt: null, reused: null });
});
test('observationData: a malformed block is no stamp (nulls), never a refusal of the document (maintainer decision: provenance beside the result cannot cost the result)', () => {
  const malformed = [null, 'live', [], 42, {}, { observedAt: observation.observedAt }, { reused: true },
    { observedAt: 1736072000000, reused: true }, { observedAt: 'yesterday', reused: true }, { observedAt: '', reused: true },
    { observedAt: `${observation.observedAt}${' '.repeat(60)}`, reused: true }, { observedAt: observation.observedAt, reused: 'true' },
    { observedAt: observation.observedAt, reused: 1 }, { observedAt: observation.observedAt, reused: null }];
  for (const block of malformed) {
    assert.deepEqual(observationData({ ...status, observation: block }), { observedAt: null, reused: null }, JSON.stringify(block));
    assert.deepEqual(observationData({ ...header, result: { ...header.result, observation: block } }), { observedAt: null, reused: null }, JSON.stringify(block));
  }
  for (const document of [undefined, null, [], 'status']) assert.deepEqual(observationData(document), { observedAt: null, reused: null });
  // --max-age 0 is live but still stamped: a live stamp reads like any other.
  assert.deepEqual(observationData({ ...status, observation: { ...observation, reused: false } }), { ...observation, reused: false });
});
