// Soul launch preferences (feature launch-preference, OATS 0.30; docs/desktop-cli-api.md "Soul
// launch preferences"). The REAL kernel's documents (fixtures/launch-preference, main with #290:
// every from layer, a drift, a missing harness) are the ground truth below; the shape-edge cases are
// DERIVED scenarios (marked): the contract's Launch example on a real 0.30 capture.
// The capture is from `oats version` 0.29.4 at main 69d76a91 (fixtures/launch-preference/provenance.json): a
// kernel text read from it below (a problem's fix, a refusal's message) is that kernel's wording, not a later
// one's, and the fixtures are not refreshed to follow the kernel's words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { launchOf, REPORT_FROM, PREVIEW_FROM, RECORD_FROM } from '../../client/launch-contract.mjs';
import { soulsData, deploymentStatusData } from '../../client/deployment-data.mjs';
import { previewData } from '../../client/spawn-preview-contract.mjs';
import { inspectData } from '../../client/inspect-contract.mjs';
import * as remote from '../../client/remote-roster.mjs';
import { soulRows } from '../../client/soul-rows.mjs';
import { target } from './helpers/spawn-preview-fixture.mjs';

const v2 = name => JSON.parse(readFileSync(new URL(`./fixtures/team-model-v2/${name}.json`, import.meta.url), 'utf8'));
const DEPLOYMENT = '/fixture/base/northwind-workspace';
// The contract's example (a machine override of a package soul's declared preference).
const LAUNCH = () => ({ declared: { harness: 'claude', model: 'claude-opus-5-5' }, effective: { harness: 'codex', model: 'gpt-codex-astra', launchConfig: null },
  from: 'local', at: 'oats-local.yaml#/souls/launch/oats.engineering~1code-reviewer', problem: null });

test('the Launch object: closed at every level; from per document; problem is {code, message, fix}', () => {
  assert.deepEqual(launchOf(LAUNCH()), LAUNCH());
  assert.deepEqual(launchOf({ ...LAUNCH(), declared: null, from: 'host', at: null }).declared, null, 'no declared preference');
  const unavailable = { ...LAUNCH(), from: 'soul', problem: { code: 'E_HARNESS_UNAVAILABLE', message: 'harness codex is not installed on this machine', fix: 'install codex, or override it on this machine in oats-local.yaml souls.launch' } };
  assert.equal(launchOf(unavailable).problem.code, 'E_HARNESS_UNAVAILABLE', 'a report carries the refusal it would hit');
  assert.equal(launchOf({ ...LAUNCH(), from: 'flag' }, REPORT_FROM), undefined, 'a report never says flag');
  assert.ok(launchOf({ ...LAUNCH(), from: 'flag' }, PREVIEW_FROM));
  assert.equal(launchOf({ ...LAUNCH(), from: 'recorded' }, PREVIEW_FROM), undefined, 'only a home record says recorded');
  assert.ok(launchOf({ ...LAUNCH(), from: 'recorded' }, RECORD_FROM));
  for (const [what, change] of [['extra key', l => { l.extra = 1; }], ['missing problem', l => { delete l.problem; }], ['declared extra', l => { l.declared.args = []; }],
    ['declared harness', l => { l.declared.harness = 'vim'; }], ['declared model type', l => { l.declared.model = 7; }], ['effective missing launchConfig', l => { delete l.effective.launchConfig; }],
    ['effective harness', l => { l.effective.harness = 'Codex'; }], ['launchConfig shape', l => { l.effective.launchConfig = '-x'; }], ['from', l => { l.from = 'guess'; }],
    ['at type', l => { l.at = 3; }], ['at control', l => { l.at = 'a\nb'; }], ['problem shape', l => { l.problem = { code: 'E_X', message: 'm' }; }],
    ['problem code', l => { l.problem = { code: 'nope', message: 'm', fix: 'f' }; }], ['model oversized', l => { l.effective.model = 'm'.repeat(257); }]]) {
    const l = LAUNCH(); change(l); assert.equal(launchOf(l, RECORD_FROM), undefined, what);
  }
});

test('oats souls rows (derived on the real 0.30 capture): launch passes through to /api/agents; a flag launch refuses; absent unchanged', () => {
  const doc = v2('souls'); const row = doc.result.souls.find(s => s.name === 'release-manager');
  row.launch = { ...LAUNCH(), effective: { harness: 'claude', model: 'claude-opus-5-5', launchConfig: null }, from: 'soul', at: 'local//fixture/base/fx/remotes/agents.git:souls/release-manager/soul.yaml#/launch' };
  const souls = soulsData(doc).souls, rm = souls.find(s => s.name === 'release-manager');
  assert.deepEqual([rm.launch.effective.harness, rm.launch.effective.model, rm.launch.from], ['claude', 'claude-opus-5-5', 'soul']);
  assert.equal(soulsData(v2('souls')).souls.some(s => Object.hasOwn(s, 'launch')), false, 'the real capture (no feature yet): no launch invented');
  const bad = v2('souls'); bad.result.souls[0].launch = { ...LAUNCH(), from: 'flag' }; assert.throws(() => soulsData(bad), { code: 'E_CLI_PROTOCOL' });
  const source = readFileSync(new URL('../server/oats-web.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function agentsData('), end = source.indexOf('/* ── Model catalog', start);
  const agentsData = new Function('deploymentFor', 'deployments', 'snapshot', 'remote', 'dirname', 'resolve', 'soulRows', `const held = () => null, DESKTOP_TERMS = null; ${source.slice(start, end)}; return agentsData;`);
  const roster = deploymentStatusData(v2('status'), DEPLOYMENT), ws = { id: DEPLOYMENT, name: 'northwind', roots: [roster.root] };
  const snapshot = { byWs: new Map([[DEPLOYMENT, { deployment: { status: 'observed', root: roster.root, souls: roster.agents.map(({ instances: _i, ...s }) => s), catalog: { souls, ambiguous: [], reason: null } } }]]) };
  const agents = agentsData(() => ws, () => [ws], snapshot, remote, dirname, resolve, soulRows)().agents;
  assert.deepEqual(agents.find(a => a.name === 'release-manager').launch, rm.launch);
  assert.equal(agents.filter(a => a.name !== 'release-manager').some(a => Object.hasOwn(a, 'launch')), false);
});

test('spawn --preview (derived on the real 0.30 preview): launch with flags; its effective must BE the preview\'s; absent unchanged', () => {
  const real = v2('preview').result;
  const withLaunch = from => ({ ...structuredClone(real), launch: { declared: null, effective: { harness: real.harness, model: real.model, launchConfig: real.launchConfig }, from, at: null, problem: null } });
  assert.deepEqual(previewData(withLaunch('flag'), target).launch.from, 'flag');
  assert.equal(previewData(withLaunch('host'), target).launch.effective.harness, real.harness);
  assert.equal(Object.hasOwn(previewData(structuredClone(real), target), 'launch'), false, 'no feature: no launch');
  const other = withLaunch('local'); other.launch.effective.harness = real.harness === 'claude' ? 'codex' : 'claude';
  assert.equal(previewData(other, target), null, 'a launch that disagrees with the preview refuses it');
  const model = withLaunch('local'); model.launch.effective.model = 'another-model'; assert.equal(previewData(model, target), null);
  assert.equal(previewData(withLaunch('recorded'), target), null, 'a preview is never a record');
  const problem = withLaunch('soul'); problem.launch.problem = { code: 'E_HARNESS_UNAVAILABLE', message: 'm', fix: 'f' };
  assert.equal(previewData(problem, target), null, 'only reports carry a problem: a preview refuses instead');
});

test('inspect --soul / --home (derived on the real 0.30 captures): launch, launchCurrent; recorded only on a home', () => {
  const soul = v2('inspect-soul').result, selectSoul = { agent: { name: soul.subject.soul } };
  assert.ok(inspectData({ ...structuredClone(soul), launch: { ...LAUNCH(), from: 'local-default', at: 'oats-local.yaml#/souls/launch/*' } }, selectSoul));
  assert.equal(inspectData({ ...structuredClone(soul), launch: { ...LAUNCH(), from: 'recorded' } }, selectSoul), null, 'a soul is never a record');
  assert.equal(inspectData({ ...structuredClone(soul), launchCurrent: null }, selectSoul), null, 'launchCurrent is a home\'s');
  const rows = structuredClone(soul); rows.souls[0].launch = { ...LAUNCH(), from: 'flag' }; assert.equal(inspectData(rows, selectSoul), null, 'soul rows are reports');
  assert.ok(inspectData(structuredClone(soul), selectSoul), 'the real capture (no feature yet) still reads');
  const home = v2('inspect-home').result, selectHome = { instance: {}, selector: { home: home.subject.home } };
  assert.ok(inspectData({ ...structuredClone(home), launch: { ...LAUNCH(), declared: null, from: 'recorded', at: null }, launchCurrent: LAUNCH() }, selectHome));
  assert.ok(inspectData({ ...structuredClone(home), launch: LAUNCH(), launchCurrent: null }, selectHome), 'a soul that no longer resolves');
  assert.equal(inspectData({ ...structuredClone(home), launch: LAUNCH(), launchCurrent: { ...LAUNCH(), from: 'recorded' } }, selectHome), null, 'launchCurrent is what reselect WOULD choose');
  assert.equal(inspectData({ ...structuredClone(home), launch: { ...LAUNCH(), extra: 1 } }, selectHome), null);
});

test('readiness launch-changed (--home; derived on the real instance readiness capture): recorded, current and from kept', async () => {
  const { readinessData } = await import('../../client/readiness-contract.mjs');
  const { data, instanceTarget } = await import('./helpers/readiness-fixture.mjs');
  const item = { subject: 'launch', status: 'fail', required: false, producer: 'launch preference', code: 'launch-changed', evidence: null,
    reason: 'this home launches pi; the current preference is claude', remedy: '`oats session restart --reselect-launch`, or respawn',
    recorded: { harness: 'pi', model: null, launchConfig: null }, current: { harness: 'claude', model: 'claude-opus-5-5', launchConfig: null },
    from: 'local-default', at: 'oats-local.yaml#/souls/launch/*' };
  const doc = () => { const v = data(instanceTarget); v.checks.configured.items.push(structuredClone(item)); return v; };
  const got = readinessData(doc(), instanceTarget).checks.configured.items.find(i => i.code === 'launch-changed');
  assert.deepEqual([got.recorded, got.current, got.from, got.at, got.required], [item.recorded, item.current, 'local-default', item.at, false]);
  for (const [what, change] of [['recorded shape', i => { i.recorded = { harness: 'pi' }; }], ['current harness', i => { i.current.harness = 'emacs'; }],
    ['from flag', i => { i.from = 'flag'; }], ['from unknown', i => { i.from = 'guess'; }]]) {
    const v = doc(); change(v.checks.configured.items.at(-1)); assert.equal(readinessData(v, instanceTarget), null, what);
  }
  // The current launch from the host default (the soul dropped its `launch:` after the spawn): `at` is null.
  const host = doc(); Object.assign(host.checks.configured.items.at(-1), { from: 'host', at: null, current: { harness: 'pi', model: null, launchConfig: null } });
  const hosted = readinessData(host, instanceTarget);
  assert.ok(hosted, 'the whole readiness document still reads');
  assert.deepEqual([hosted.checks.configured.items.at(-1).at, hosted.checks.configured.items.at(-1).from], [null, 'host']);
  for (const bad of [7, '', 'a\nb']) { const v = doc(); v.checks.configured.items.at(-1).at = bad; assert.equal(readinessData(v, instanceTarget), null, `at ${JSON.stringify(bad)}`); }
  assert.ok(readinessData(data(instanceTarget), instanceTarget).checks.configured.items.every(i => !Object.hasOwn(i, 'recorded') && !Object.hasOwn(i, 'from')), 'no keys invented');
});

// ── The REAL kernel, as captured from 0.29.4 at main 69d76a91 (fixtures/launch-preference/provenance.json) ──
const real = name => JSON.parse(readFileSync(new URL(`./fixtures/launch-preference/${name}.json`, import.meta.url), 'utf8'));
const LP = '/fixture/base/deployment';

test('real: oats souls rows carry every from layer (soul, local, host) and a missing harness as a report problem', () => {
  const byName = Object.fromEntries(soulsData(real('souls')).souls.map(s => [s.name, s.launch]));
  assert.deepEqual([byName.dev.from, byName.dev.effective, byName.dev.declared], ['soul', { harness: 'claude', model: 'claude-opus-5-5', launchConfig: null }, { harness: 'claude', model: 'claude-opus-5-5' }]);
  assert.match(byName.dev.at, /souls\/dev\/soul\.yaml#\/launch$/);
  assert.deepEqual([byName.reviewer.from, byName.reviewer.declared.harness, byName.reviewer.effective.harness, byName.reviewer.at], ['local', 'codex', 'pi', 'oats-local.yaml#/souls/launch/reviewer'], 'the machine overrides the soul');
  assert.deepEqual([byName.plain.from, byName.plain.declared, byName.plain.at, byName.plain.effective.model], ['host', null, null, null]);
  const dev = soulsData(real('souls-unavailable')).souls.find(s => s.name === 'dev').launch;
  assert.deepEqual([dev.problem.code, dev.problem.fix, dev.from], ['E_HARNESS_UNAVAILABLE', 'install codex, or change oats-local.yaml souls.launch', 'local'], 'a soul whose harness is missing still lists');
});

test('real: the preview carries launch (and a flag), and its refusal\'s fix reaches the dialog through the proxy', async () => {
  const p = real('preview-dev').result, t = { workspace: 'w', context: p.subject.dir, selector: { soul: 'dev', agentsRoot: p.subject.agentsRoot } };
  assert.equal(previewData(structuredClone(p), t).launch.from, 'soul');
  const flag = previewData(real('preview-dev-flag').result, t);
  assert.deepEqual([flag.launch.from, flag.launch.effective.harness, flag.harness], ['flag', 'pi', 'pi']);
  const { previewFailure } = await import('../../client/spawn-preview-contract.mjs');
  const e = real('preview-dev-unavailable').error;
  assert.deepEqual(previewFailure(e.code, null, e.message, e.details.fix).reason, { code: 'E_HARNESS_UNAVAILABLE', message: e.message, fix: e.details.fix });
});

test('real: inspect --soul and --home (the record, launchCurrent, and a drift); readiness launch-changed', async () => {
  const soul = real('inspect-soul-dev').result;
  assert.ok(inspectData(soul, { agent: { name: 'dev' } }));
  assert.equal(soul.launch.from, 'soul', 'inspect --soul carries launch at the top level');
  for (const name of ['inspect-home', 'inspect-home-drift']) { const h = real(name).result; assert.ok(inspectData(h, { instance: {}, selector: { home: h.subject.home } }), name); }
  const drift = real('inspect-home-drift').result;
  assert.deepEqual([drift.launch.from, drift.launch.effective.harness, drift.launchCurrent.from, drift.launchCurrent.effective.harness], ['soul', 'claude', 'local', 'codex']);
  const { readinessData } = await import('../../client/readiness-contract.mjs');
  const r = real('readiness-home-drift').result, s = r.subject;
  const target = { workspace: 'w', context: LP, observedAs: 'instance', home: s.home, selector: { kind: 'instance', instance: s.instance, agent: s.soul, agentsRoot: r.selector.agentsRoot } };
  const item = readinessData(r, target).checks.configured.items.find(i => i.code === 'launch-changed');
  assert.deepEqual([item.required, item.recorded.harness, item.current.harness, item.from, item.at], [false, 'claude', 'codex', 'local', 'oats-local.yaml#/souls/launch/dev']);
});

// #292's review: readiness `recorded`/`current` mean what the item's CODE says. The REAL kernel
// (capture-launch.mjs, main 69d76a91 = main's lib/) emits three shapes; each reads, and a mutant per rule refuses.
const readinessOf = name => {
  const r = real(name).result, s = r.subject;
  return { r, target: { workspace: 'w', context: s.home.slice(0, s.home.indexOf('/agents/')), observedAs: 'instance', home: s.home,
    selector: { kind: 'instance', instance: s.instance, agent: s.soul, agentsRoot: r.selector.agentsRoot } } };
};
const itemsOf = doc => doc.checks.configured.items;

test('real readiness: launch-changed forward (a layer, at a string), reverse (host, at null), and default-team-changed (DefaultTeam objects) all read', async () => {
  const { readinessData } = await import('../../client/readiness-contract.mjs');
  const forward = readinessOf('readiness-home-drift'), f = itemsOf(readinessData(forward.r, forward.target)).find(i => i.code === 'launch-changed');
  assert.deepEqual([f.from, f.at, f.recorded, f.current], ['local', 'oats-local.yaml#/souls/launch/dev',
    { harness: 'claude', model: 'claude-opus-5-5', launchConfig: null }, { harness: 'codex', model: null, launchConfig: null }]);
  // A preference removed after the spawn: the current launch is the host default, from nowhere.
  const reverse = readinessOf('readiness-home-reverse-drift'), rv = itemsOf(readinessData(reverse.r, reverse.target)).find(i => i.code === 'launch-changed');
  assert.deepEqual([rv.from, rv.at, rv.recorded.harness, rv.current.harness], ['host', null, 'claude', 'pi']);
  // The team item carries recorded/current too, as the kernel's DefaultTeam: the home's readiness still reads (it went blank).
  const team = readinessOf('readiness-home-default-team-changed'), doc = readinessData(team.r, team.target);
  assert.ok(doc, 'the whole readiness view reads');
  const t = itemsOf(doc).find(i => i.code === 'default-team-changed');
  assert.deepEqual([t.subject, t.required, t.recorded, t.current, t.remedy, Object.hasOwn(t, 'from')],
    ['teams', false, { label: 'mine', team: 'mine:me.aweb.ai', from: 'deployment' }, { label: 'oats', team: 'oats:oats.aweb.ai', from: 'deployment' }, 'respawn', false]);
});

test('real readiness mutants: each code decodes its own recorded/current; another code\'s are not read', async () => {
  const { readinessData } = await import('../../client/readiness-contract.mjs');
  const mutate = (name, change) => { const { r, target } = readinessOf(name); const v = structuredClone(r); change(v.checks.configured.items.find(i => /-changed$/.test(i.code ?? ''))); return readinessData(v, target); };
  for (const [what, change] of [['launch recorded a DefaultTeam', i => { i.recorded = { label: 'mine', team: null, from: 'deployment' }; }],
    ['launch current null', i => { i.current = null; }], ['launch from missing', i => { delete i.from; }], ['launch from flag', i => { i.from = 'flag'; }],
    ['launch at missing', i => { delete i.at; }], ['launch at control', i => { i.at = 'a\nb'; }]])
    assert.equal(mutate('readiness-home-drift', change), null, what);
  assert.ok(mutate('readiness-home-reverse-drift', i => { i.at = null; }), 'host with at null reads');
  for (const [what, change] of [['team recorded a launch', i => { i.recorded = { harness: 'pi', model: null, launchConfig: null }; }],
    ['team current label', i => { i.current.label = 'a b'; }], ['team current from', i => { i.current.from = 'shared'; }], ['team recorded missing', i => { delete i.recorded; }]])
    assert.equal(mutate('readiness-home-default-team-changed', change), null, what);
  const none = mutate('readiness-home-default-team-changed', i => { i.recorded = null; i.current = null; });
  assert.deepEqual([itemsOf(none).find(i => i.code === 'default-team-changed').recorded, itemsOf(none).find(i => i.code === 'default-team-changed').current], [null, null], 'no default team (null) on either side reads');
  // Another code carrying these keys: not decoded, not kept; the item and the document still read.
  const other = mutate('readiness-home-default-team-changed', i => { i.code = 'something-new'; i.from = 'somewhere'; });
  const kept = itemsOf(other).find(i => i.code === 'something-new');
  assert.deepEqual([Object.hasOwn(kept, 'recorded'), Object.hasOwn(kept, 'current'), Object.hasOwn(kept, 'from')], [false, false, false]);
});
