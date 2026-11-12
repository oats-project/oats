// The harness rename (kernel #194, feature harness, OATS 0.27.0): the Desktop
// speaks `harness`; with the feature it writes --harness and `harness` keys, and
// without it (a released kernel) --runtime and `runtime`. Every read takes either
// spelling. Kernel captures: test/fixtures/workspace-v2/harness (#194, scratch
// Northwind) for the new names; f3 (0.25.9) for the released ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { acceptProbe } from '../../client/cli-locator.mjs';
import { harnessList, harnessOf, harnessFlag, harnessKey } from '../../client/harness-names.mjs';
import { cliSpawnPreview } from '../../client/spawn-preview-cli.mjs';
import { createSpawnPreviewBoundary, createSpawnPreviewFlights } from '../../client/spawn-preview.mjs';
import { previewData } from '../../client/spawn-preview-contract.mjs';
import { spawnCreationReceipt } from '../../client/spawn-apply-contract.mjs';
import { deploymentStatusData } from '../../client/deployment-data.mjs';
import { inspectFacts } from '../../client/inspect-contract.mjs';
import { launchConfigRequest } from '../server/launch-configs.mjs';
import { scheduleRequest } from '../server/schedules.mjs';
import { scheduleDraft } from '../renderer/schedule-read-data.mjs';
import { eventsData } from '../renderer/instance-events-data.mjs';

const fx = (set, name) => JSON.parse(readFileSync(new URL(`./fixtures/workspace-v2/${set}/${name}.json`, import.meta.url), 'utf8'));
const h = name => fx('harness', name);
const provenance = fx('harness', 'provenance');
const DEPLOYMENT = '/fixture/base/northwind-workspace', ROOT = `${DEPLOYMENT}/agents`;
const version = h('version'), released = fx('f3', 'version');
const cliOf = v => ({ ok: true, bin: '/fixture/oats', version: v.version, spawnPreviewApi: v.spawnPreviewApi, spawnApplyApi: v.spawnApplyApi, workspaceApi: v.workspaceApi,
  features: [...v.features], harnesses: harnessList(v), sessionBackends: [...v.sessionBackends], launchOptions: [...v.launchOptions], remote: [...(v.remote || [])] });
const cli = cliOf(version), oldCli = cliOf(released);
const target = { workspace: 'northwind', context: DEPLOYMENT, selector: { soul: 'release-manager', agentsRoot: ROOT } };

test('the probe: feature harness lists harnesses (no runtimes alias); a released kernel lists runtimes; both are accepted', () => {
  assert.ok(version.features.includes('harness') && !Object.hasOwn(version, 'runtimes'));
  assert.deepEqual(harnessList(version), ['pi', 'claude', 'codex']);
  assert.ok(!released.features.includes('harness'));
  assert.deepEqual(harnessList(released), released.runtimes);
  assert.equal(harnessList({ ...version, harnesses: undefined, runtimes: ['pi'] }), null, 'with the feature, never the old list');
  // f3 was captured at 0.25.9, below the band's floor; the 0.26 line prints the same `runtimes` and no
  // `harness` (bin/oats.mjs at v0.26.0), so the capture stands for it under that line's first version.
  for (const v of [version, { ...released, version: '0.26.0' }]) assert.equal(acceptProbe(v, '0.69.17').ok, true, v.version);
  assert.deepEqual([harnessFlag(cli), harnessKey(cli), harnessFlag(oldCli), harnessKey(oldCli)], ['--harness', 'harness', '--runtime', 'runtime']);
});

const replay = async (name, choices, useCli = cli) => {
  const envelope = h(name); let seen;
  const read = createSpawnPreviewBoundary({ flights: createSpawnPreviewFlights(), invoke: (c, opts) => cliSpawnPreview(c, opts, { env: {}, exec: (_b, argv, _o, callback) => {
    seen = argv; callback(envelope.ok ? null : { code: 1 }, JSON.stringify(envelope)); } }) });
  const context = () => ({ workspace: { id: 'northwind', scope: DEPLOYMENT }, cli: structuredClone(useCli), agents: [{ name: 'release-manager', agentsRoot: ROOT, work: 'worktree' }], instances: [] });
  const response = await read({ action: 'preview', selector: target.selector, choices }, context);
  const captured = provenance.files[name].argv.slice(1).map(v => v.replaceAll('<base>', '/fixture/base'));
  return { response, seen, captured, envelope };
};
test('spawn preview on a harness kernel: the Desktop sends --harness (the captured argv) and reads effective.harness', async () => {
  for (const [name, choices, harness] of [['preview-default', {}, 'pi'], ['preview-harness-claude', { harness: 'claude' }, 'claude']]) {
    const { response, seen, captured, envelope } = await replay(name, { purpose: 'harness', ...choices });
    const order = argv => argv.filter(v => v !== '--preview');
    assert.deepEqual(order(seen), order(captured), `${name}: the Desktop argv is the argv the kernel was captured with`);
    assert.equal(response.status, 'available', name);
    assert.equal(envelope.result.decision.effective.harness, harness);
    assert.equal(response.data.harness, harness, name); assert.equal(response.data.decision.effective.harness, harness);
    assert.equal(Object.hasOwn(response.data, 'runtime'), false);
  }
});
test('the deprecated spelling answers an envelope warning, which the Desktop tolerates; disagreeing flags are the kernel\'s E_BAD_ARGS verbatim', async () => {
  // A kernel without the feature is sent --runtime; the #194 kernel still reads it and warns.
  const warned = await replay('preview-runtime-claude', { purpose: 'harness', harness: 'claude' }, { ...cli, features: cli.features.filter(f => f !== 'harness') });
  assert.ok(warned.seen.includes('--runtime') && !warned.seen.includes('--harness'));
  assert.deepEqual(warned.envelope.warnings.map(w => [w.code, w.key, w.replacement]), [['deprecated-runtime-name', 'runtime', 'harness']]);
  assert.equal(warned.response.status, 'available'); assert.equal(warned.response.data.harness, 'claude');
  const disagree = h('preview-harness-disagree');
  assert.equal(disagree.error.code, 'E_BAD_ARGS'); assert.match(disagree.error.message, /--harness pi and --runtime claude disagree/);
});
test('the apply receipt and a released kernel\'s receipt both read as harness', () => {
  const preview = previewData(h('preview-harness-claude').result, target);
  const receipt = spawnCreationReceipt(h('apply-harness-claude').result, { target, preview });
  assert.equal(receipt.harness, 'claude'); assert.equal(Object.hasOwn(receipt, 'runtime'), false);
  const f3 = name => fx('f3', name);
  const old = spawnCreationReceipt(f3('apply-bound').result, { target, preview: previewData(f3('preview-worktree-purpose').result, target) });
  assert.equal(old.harness, harnessOf(f3('apply-bound').result));
});
test('status, inspect and events rows: harness on 0.27; the DTO never carries runtime', () => {
  const status = deploymentStatusData(h('status'), DEPLOYMENT);
  const row = status.agents.find(a => a.name === 'release-manager').instances.find(i => i.instance === 'release-manager-harness');
  assert.equal(row.harness, 'claude'); assert.equal(Object.hasOwn(row, 'runtime'), false);
  const released = deploymentStatusData(fx('f2', 'status'), DEPLOYMENT).agents.flatMap(a => a.instances)[0];
  assert.equal(typeof released.harness, 'string', 'a released kernel\'s runtime reads as the harness');
  const home = h('inspect-home').result.instance;
  assert.deepEqual(inspectFacts.instance(home).find(([label]) => label === 'Harness'), ['Harness', 'claude']);
  assert.equal(harnessOf(h('inspect-soul').result.souls[0]), null, 'release-manager declares no default harness');
  const events = h('instance-events').result, spawned = events.events.find(e => e.kind === 'spawned');
  const out = eventsData(events, { workspace: 'northwind', context: DEPLOYMENT, selector: { instance: events.instance, agent: 'release-manager', agentsRoot: ROOT, server: null },
    home: events.home, incarnation: events.incarnation });
  assert.equal(spawned.data.harness, 'claude');
  assert.equal(out.events.find(e => e.kind === 'spawned').data.harness, 'claude');
});
test('launch configurations: rows read either spelling; a definition is written in the kernel\'s key and a preview names its flag', async () => {
  const rows = h('launch-config-list').result.configurations;
  assert.deepEqual(rows.map(r => [r.name, harnessOf(r)]), [['legacy', 'claude'], ['personal', 'codex']], 'the legacy definition (written as runtime) lists as harness');
  assert.deepEqual(h('launch-config-set-runtime').warnings.map(w => w.code), ['deprecated-runtime-name']);
  const selection = h('launch-config-preview').result.selection;
  assert.ok(Object.hasOwn(selection, 'harness') && !Object.hasOwn(selection, 'runtime'), 'the selection speaks harness (null: none chosen explicitly)');
  const calls = [], invoke = async (_bin, options) => { calls.push(options); return { ok: true, result: {} }; };
  const workspace = { id: 'northwind', scope: DEPLOYMENT };
  for (const c of [{ ...cli, features: [...cli.features, 'launch-config'] }, { ...oldCli, features: [...oldCli.features, 'launch-config'] }]) {
    await launchConfigRequest({ action: 'set', name: 'fast', definition: { harness: 'claude', args: [] } }, { workspace, cli: c, invoke });
    await launchConfigRequest({ action: 'preview', selector: { soul: 'release-manager', agentsRoot: ROOT }, choices: { harness: 'claude' } },
      { workspace, cli: c, agents: [{ name: 'release-manager', agentsRoot: ROOT }], invoke });
  }
  assert.deepEqual(calls.map(c => c.definition ?? c.choices), [{ harness: 'claude', args: [] }, { harness: 'claude', harnessFlag: '--harness' },
    { runtime: 'claude', args: [] }, { harness: 'claude', harnessFlag: '--runtime' }]);
});
test('schedules: a stored job reads either spelling into the draft; a spec is written in the kernel\'s key', async () => {
  const job = h('schedule-list').result.schedules.find(s => s.id === 'nightly');
  assert.equal(job.harness, 'claude');
  const draft = scheduleDraft(job);
  assert.equal(draft.harness, 'claude'); assert.equal(Object.hasOwn(draft, 'runtime'), false);
  const { harness: _new, ...releasedJob } = job;
  assert.equal(scheduleDraft({ ...releasedJob, runtime: 'codex' }).harness, 'codex', 'a released kernel\'s job');
  assert.equal(scheduleDraft({ ...job, runtime: 'codex' }), null, 'both spellings: not an editable draft');
  const specs = [], invoke = async (_bin, options) => { specs.push(options.spec); return { ok: true, result: {} }; };
  const agents = [{ name: 'release-manager', agentsRoot: ROOT, work: 'worktree' }];
  const value = { cron: '0 3 * * *', tz: 'UTC', enabled: false, kind: 'spawn', agent: 'release-manager', agentsRoot: ROOT, task: 'Nightly', harness: 'claude' };
  for (const c of [cli, oldCli]) await scheduleRequest({ operation: 'add', id: 'nightly', spec: value }, { workspace: { id: 'northwind', scope: DEPLOYMENT },
    cli: { ...c, scheduleApi: 2, features: [...c.features, 'schedule'] }, agents, invoke });
  assert.deepEqual(specs.map(s => [s.harness, s.runtime]), [['claude', undefined], [undefined, 'claude']]);
});
