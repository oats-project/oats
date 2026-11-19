// Capabilities "Used by" from each soul's composition (kernel feature souls-capabilities, OATS 0.45.0): the
// souls whose `oats souls` row lists the capability by name, kind and origin, not only the souls whose live
// instances recorded it. The parse (deployment-data.mjs soulCapabilitiesOf), the /api/agents projection,
// the join (workspace-catalog.mjs composes/soulsUsing), and the capability page's "Used by" fold (the list's
// "Used by" column went in the Desktop UI rework, slice 3b: rows say who made a capability, the page who uses it).
// Fixture: workspace-v2/souls-capabilities, a REAL capture from the kernel PR (awebai/oats#745 @ 0ee79761,
// provenance.json): member souls dev and keeper, the package soul acme.pkg/keeper (the member's bare name),
// a private capability, workspace defaults (scribe takes only those), the disabled soul off (capabilities null)
// and quiet, spawnable with every default turned off (capabilities []).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { soulsData, capabilitiesData, soulCapabilitiesOf } from '../../client/deployment-data.mjs';
import * as remote from '../../client/remote-roster.mjs';
import { soulRows } from '../../client/soul-rows.mjs';
import { catalogCSS } from '../renderer/workspace-catalog.mjs';
import { composes, soulsUsing, rosterAgentName, soulsComposition, SOULS_CAPABILITIES_FEATURE } from '../../client/capability-rows.mjs';
import { renderCapabilityPage } from '../renderer/capability-page.mjs';
import { SOULS_STALE_TITLE, ROSTER_STALE_TITLE } from '../renderer/loading.mjs';

const fx = name => JSON.parse(readFileSync(new URL(`./fixtures/workspace-v2/${name}.json`, import.meta.url), 'utf8'));
const capture = name => fx(`souls-capabilities/${name}`);
const ROOT = '/fixture/base/deployment/agents';
const REPO = 'local//fixture/base/remotes/ws.git';
const CATALOG = capabilitiesData(capture('capabilities')).capabilities;
const cap = name => CATALOG.find(row => row.name === name);
// The souls as /api/agents hands them to the renderer (the server's projection, agentsData below).
const agentRow = s => ({ name: s.name, key: s.key, soulKind: s.kind, ...(s.kind === 'package' ? { package: s.package } : {}),
  ...(Object.hasOwn(s, 'capabilities') ? { capabilities: s.capabilities } : {}), agentsRoot: ROOT });
const SOULS = soulsData(capture('souls')).souls.map(agentRow);
const soul = key => SOULS.find(s => s.key === key);
const refused = fn => assert.throws(fn, { code: 'E_CLI_PROTOCOL' });

test('the capture is the kernel\'s: it advertises souls-capabilities, read from the CLI probe in one place', () => {
  assert.ok(capture('version').features.includes('souls-capabilities'), 'the kernel PR\'s probe');
  assert.equal(SOULS_CAPABILITIES_FEATURE, 'souls-capabilities');
  assert.equal(soulsComposition(capture('version')), true);
  assert.equal(soulsComposition({ features: ['workspace-v2'] }), false);
  assert.equal(soulsComposition(null), false);
});

test('soulsData keeps each soul\'s composition in the catalog\'s own keys; null for a soul that did not resolve', () => {
  const souls = Object.fromEntries(soulsData(capture('souls')).souls.map(s => [s.key, s]));
  // Turned off (acme.off) and an emptied slot (notes) are absent; acme.ws, a default it also declares, is the soul's.
  assert.deepEqual(souls.dev.capabilities, [
    { name: 'acme-tool', kind: 'package', package: 'acme.pkg', from: 'workspace' },
    { name: 'acme.own', kind: 'member', repoKey: REPO, from: 'soul' },
    { name: 'acme.private', kind: 'member', repoKey: REPO, from: 'soul' },
    { name: 'acme.ws', kind: 'member', repoKey: REPO, from: 'soul' },
    { name: 'acme_z', kind: 'member', repoKey: REPO, from: 'soul' },
    { name: 'chat', kind: 'member', repoKey: REPO, from: 'workspace' },
  ]);
  assert.deepEqual(souls['acme.pkg/keeper'].capabilities.find(c => c.name === 'acme-tool'), { name: 'acme-tool', kind: 'package', package: 'acme.pkg', from: 'soul' }, 'a package soul too');
  assert.equal(souls.off.capabilities, null, 'disabled here: did not resolve');
  assert.deepEqual([souls.quiet.spawnable, souls.quiet.capabilities], [true, []], 'spawnable and composes nothing: [] is accepted and kept, never refused or made null');
  assert.deepEqual(soulCapabilitiesOf([]), [], 'composes nothing (the contract\'s [])');
  // Every entry names exactly one catalog row (the contract): the join never guesses.
  for (const s of Object.values(souls)) for (const entry of s.capabilities || []) assert.equal(CATALOG.filter(row => composes(entry, row)).length, 1, `${s.key}: ${entry.name}`);
});

test('a souls document without the feature (no capabilities key) parses unchanged', () => {
  const older = fx('f7/souls');
  assert.ok(older.result.souls.every(s => !Object.hasOwn(s, 'capabilities')), 'the real 0.29 capture');
  const rows = soulsData(older).souls;
  assert.ok(rows.length > 0 && rows.every(s => !Object.hasOwn(s, 'capabilities')), 'no composition invented');
  // The capture without the field: everything else reads identically.
  const doc = capture('souls'); for (const s of doc.result.souls) delete s.capabilities;
  assert.deepEqual(soulsData(doc).souls, soulsData(capture('souls')).souls.map(({ capabilities: _c, ...rest }) => rest));
});

test('anything but the contract\'s entry shape refuses the document (the parse\'s idiom); null exactly when not spawnable', () => {
  const entry = { name: 'acme-tool', kind: 'package', package: 'acme.pkg', from: 'soul' };
  const member = { name: 'acme.ws', kind: 'member', repoKey: REPO, from: 'workspace' };
  assert.deepEqual(soulCapabilitiesOf([entry, member]), [entry, member]);
  assert.deepEqual(soulCapabilitiesOf([{ ...member, extra: 1 }]), [member], 'unknown keys are dropped, not kept');
  for (const bad of [
    undefined, {}, 'oats.core', [null], [{ ...entry, from: 'team' }], [{ ...entry, from: undefined }], [{ ...entry, name: '' }],
    [{ ...entry, kind: 'external', repoKey: REPO, package: undefined }], [{ ...member, kind: 'external' }], [{ ...entry, kind: 'team' }],
    [{ ...entry, package: 'Not A Package' }], [{ ...entry, repoKey: REPO }], [{ ...member, repoKey: '' }], [{ name: 'x', kind: 'member', from: 'soul' }],
    [{ ...member, package: 'acme.pkg' }], Array.from({ length: 1025 }, () => entry),
  ]) assert.equal(soulCapabilitiesOf(bad), undefined, JSON.stringify(bad)?.slice(0, 80));
  const row = (d, key) => d.result.souls.find(s => (s.qualifiedName || s.name) === key);
  let d = capture('souls'); row(d, 'dev').capabilities = [{ ...member, kind: 'external' }]; refused(() => soulsData(d));
  d = capture('souls'); row(d, 'dev').capabilities = null; refused(() => soulsData(d)); // spawnable, yet did not resolve
  d = capture('souls'); row(d, 'off').capabilities = []; refused(() => soulsData(d)); // not spawnable, yet composed
  d = capture('souls'); delete row(d, 'dev').spawnable; row(d, 'dev').capabilities = null;
  assert.equal(soulsData(d).souls.find(s => s.key === 'dev').capabilities, null, 'no spawnable reported: nothing to agree with');
});

test('/api/agents carries each soul\'s composition (a copy; null kept; absent stays absent)', () => {
  const source = readFileSync(new URL('../server/oats-web.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function agentsData('), end = source.indexOf('/* ── Model catalog', start);
  const agentsData = new Function('deploymentFor', 'deployments', 'snapshot', 'remote', 'dirname', 'resolve', 'soulRows', `const held = () => null, DESKTOP_TERMS = null; ${source.slice(start, end)}; return agentsData;`);
  const run = catalogSouls => {
    const snapshot = { byWs: new Map([['/d', { deployment: { status: 'observed', root: ROOT, souls: [], catalog: { souls: catalogSouls, ambiguous: [], reason: null } } }]]) };
    const ws = { id: '/d', name: 'fixture', roots: [ROOT] };
    return Object.fromEntries(agentsData(() => ws, () => [ws], snapshot, remote, dirname, resolve, soulRows)().agents.map(a => [a.key, a]));
  };
  const souls = soulsData(capture('souls')).souls, agents = run(souls);
  assert.deepEqual(agents.dev.capabilities, souls.find(s => s.key === 'dev').capabilities);
  assert.notEqual(agents.dev.capabilities, souls.find(s => s.key === 'dev').capabilities, 'a copy');
  assert.equal(agents.off.capabilities, null);
  assert.deepEqual([agents['acme.pkg/keeper'].soulKind, agents['acme.pkg/keeper'].package, agents['acme.pkg/keeper'].name], ['package', 'acme.pkg', 'keeper']);
  assert.equal(Object.hasOwn(run(soulsData(fx('f7/souls')).souls)['release-manager'], 'capabilities'), false, 'an older CLI: no field');
});

test('a soul\'s roster agent name is the kernel\'s (lib/workspace.mjs packageSoulAgentName): <package>--<soul> for a package soul', () => {
  assert.equal(rosterAgentName(soul('keeper')), 'keeper');
  assert.equal(rosterAgentName(soul('acme.pkg/keeper')), 'acme-pkg--keeper', 'the roster capture\'s name (team-model-v2/package-souls/status.json)');
  assert.equal(rosterAgentName({ name: 'security-reviewer', soulKind: 'external' }), 'security-reviewer');
  assert.equal(rosterAgentName({ name: 'knowledge-maintainer', soulKind: 'package', package: 'oats.okf' }), 'oats-okf--knowledge-maintainer');
  assert.equal(rosterAgentName({ name: 'x', soulKind: 'package', package: 'a_b.c' }), 'a-b-c--x', 'every character outside [a-z0-9-]');
});

test('the join: name, kind and origin (repository or package); private rows the same; null never counted; a mismatch never', () => {
  const who = name => soulsUsing(SOULS, cap(name)).map(s => s.key);
  assert.deepEqual(who('acme.own'), ['dev', 'keeper'], 'member; off declares it too but did not resolve');
  assert.deepEqual(who('acme-tool'), ['dev', 'keeper', 'acme.pkg/keeper', 'scribe'], 'package, the package soul included; quiet turned it off');
  assert.deepEqual(who('acme.private'), ['dev'], 'a repo-owned (private) row');
  assert.equal(cap('acme.private').private, true);
  assert.deepEqual(who('acme.off'), ['keeper', 'acme.pkg/keeper', 'scribe'], 'dev and quiet turned the default off');
  assert.deepEqual(who('notes'), ['keeper', 'acme.pkg/keeper', 'scribe'], 'dev and quiet emptied the knowledge slot');
  assert.ok(SOULS.filter(s => Array.isArray(s.capabilities) && !s.capabilities.length).every(s => !CATALOG.some(row => soulsUsing([s], row).length)), 'quiet ([]) uses nothing');
  assert.equal(composes({ name: 'acme.own', kind: 'member', repoKey: 'local//fixture/base/remotes/other.git', from: 'soul' }, cap('acme.own')), false, 'another repository');
  assert.equal(composes({ name: 'acme-tool', kind: 'package', package: 'oats.okf', from: 'soul' }, cap('acme-tool')), false, 'another package');
  assert.equal(composes({ name: 'acme-tool', kind: 'member', repoKey: REPO, from: 'soul' }, cap('acme-tool')), false, 'another kind');
  const external = { name: 'nw-review', kind: 'external', repoKey: 'local//fixture/base/remotes/experts.git' };
  assert.equal(composes({ name: 'nw-review', kind: 'member', repoKey: external.repoKey, from: 'soul' }, external), false, 'an external row never matches');
  assert.deepEqual(soulsUsing([{ name: 'a', capabilities: null }, { name: 'b' }], cap('acme.ws')), [], 'no composition: not counted');
});

function mount(t) {
  const dom = new JSDOM('<!doctype html><html data-theme="light"><body><main class="oats-view"><div class="caps"></div></main></body></html>');
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const style = doc.createElement('style'); style.textContent = catalogCSS; doc.head.append(style);
  return { doc, $: sel => doc.querySelector(sel), $$: sel => [...doc.querySelectorAll(sel)] };
}
// Live instances and the modules they recorded (the roster's rows).
const INSTANCES = [
  { agent: 'dev', agentsRoot: ROOT, modules: [{ name: 'acme_z' }, { name: 'acme-tool', status: 'moved' }] },
  { agent: 'dev', agentsRoot: ROOT, modules: [{ name: 'acme-tool' }] },
  { agent: 'acme-pkg--keeper', agentsRoot: ROOT, modules: [{ name: 'acme-tool' }] }, // the package soul's
  { agent: 'keeper', agentsRoot: ROOT, modules: [{ name: 'acme.own' }] }, // the member soul's: it never recorded acme-tool
  { agent: 'dev', agentsRoot: '/elsewhere/agents', modules: [{ name: 'acme-tool' }] }, // another deployment's agents root
];


const page = (t, opts) => {
  const u = mount(t), opened = [];
  renderCapabilityPage(u.$('.caps'), { status: null, instances: INSTANCES, souls: SOULS, composition: true, root: '/d', onBack() {}, openSoul: s => opened.push(s), ...opts });
  const section = u.$('details.cap-fold[data-fold="used-by"]');
  const lines = () => [...section.querySelectorAll('.used-row:not(.head)')];
  return { u, opened, section, lines, rows: () => lines().map(r => [r.querySelector('.used-name').textContent, r.querySelector('.used-meta').textContent]) };
};

test('the page\'s "Used by": one row per soul whose composition includes it, with that soul\'s live instances carrying it', t => {
  const { section, rows, lines, opened } = page(t, { row: cap('acme-tool') });
  assert.match(section.querySelector('summary').textContent, /4 souls/);
  // dev: two here (one on an older version; the one under another agents root is not this deployment's). The member
  // keeper's instance never recorded acme-tool: 0. The package keeper's instance is acme-pkg--keeper: 1. scribe runs none.
  assert.deepEqual(rows(), [['dev', '2 · 1 on an older version'], ['keeper', '0'], ['keeper', '1'], ['scribe', '0']]);
  // Two souls named keeper: the visible name is bare, the tooltip and focus key are the soul's key.
  assert.deepEqual(lines().map(r => [r.title, r.dataset.focusKey]), [['Open dev', `used:dev:${ROOT}`], ['Open keeper', `used:keeper:${ROOT}`], ['Open acme.pkg/keeper', `used:acme.pkg/keeper:${ROOT}`], ['Open scribe', `used:scribe:${ROOT}`]]);
  lines()[2].click();
  assert.deepEqual([opened[0].key, opened[0].name, opened[0].agentsRoot], ['acme.pkg/keeper', 'keeper', ROOT], 'opens the soul by its key');
});

test('the page counts "0" instances for a soul that composes it with none running it, says none on a good read, "—" with the reason otherwise', t => {
  assert.deepEqual(page(t, { row: cap('notes') }).rows(), [['keeper', '0'], ['keeper', '0'], ['scribe', '0']]);
  const souls = SOULS.filter(s => s.key !== 'dev');
  const none = page(t, { row: cap('acme_z'), souls });
  assert.equal(none.rows().length, 0); assert.match(none.section.textContent, /No soul here includes it\./); assert.match(none.section.querySelector('summary').textContent, /0 souls/);
  const stale = page(t, { row: cap('acme_z'), souls, rosterState: 'failed' });
  const dash = stale.section.querySelector('.used-unknown');
  assert.equal(dash.textContent, '—'); assert.equal(dash.getAttribute('aria-description'), SOULS_STALE_TITLE); assert.equal(dash.title, SOULS_STALE_TITLE);
  assert.doesNotMatch(stale.section.textContent, /No soul here includes it/);
  // Without the feature: the instance-derived page, unchanged.
  const old = page(t, { row: cap('acme.ws'), composition: false });
  assert.equal(old.rows().length, 0); assert.match(old.section.textContent, /No instance carries it yet\./);
});
