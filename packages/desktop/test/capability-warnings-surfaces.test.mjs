// Capability warnings (OATS 0.49.0, `hook-event-unsupported`; docs/desktop-cli-api.md § "Capability warnings") on
// the soul page, the sidebar soul inspector, readiness, the instance Soul tab and the spawn preview: the shared
// list (capability-warnings.mjs) under a "Warnings" heading, the kernel's words as text, Open capability only
// where the surface navigates and the name resolves. A warning blocks nothing and never changes a ready state;
// an older kernel's absent list (or an empty one) shows no section.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createSoulInspector } from '../renderer/soul-inspector.mjs';
import { createReadinessView } from '../renderer/readiness-view.mjs';
import { createInstanceSoulSection } from '../renderer/instance-soul.mjs';
import { readinessData, readinessTarget } from '../../client/readiness-contract.mjs';
import { previewData } from '../../client/spawn-preview-contract.mjs';
import { setWorkspace, currentWorkspace } from '../renderer/views/common.mjs';
import { refreshCli, resetCliStateForTests } from '../renderer/views/cli-status.mjs';
import * as readiness from './helpers/readiness-fixture.mjs';
import { data as previewDocument, target as previewTargetFixture } from './helpers/spawn-preview-fixture.mjs';
import { mountSpawn, kernel } from './helpers/spawn-dialog-host.mjs';
import { homeInspection } from './helpers/inspect-fixture.mjs';

const flush = () => new Promise(r => setTimeout(r, 0));
const warning = (capability, message, fields = {}) => ({ code: 'hook-event-unsupported', capability, path: `capabilities/${capability}/oats-capability.yaml#/hooks/0`, message, ...fields });
const AWEB = warning('oats.aweb', '<b>oats.aweb</b> declares a session-start hook this harness never runs.');
const UNKNOWN = warning('elsewhere.cap', 'elsewhere.cap declares a pre-compact hook this harness never runs.');
const text = el => el?.textContent ?? '';

/* ── the projections ─────────────────────────────────────────────────── */
test('readinessData: warnings projected beside the checks, never in the summary; malformed reads as none; idempotent', () => {
  const plain = readinessData(readiness.data(), readiness.target);
  assert.deepEqual(plain.warnings, [], 'an older kernel: none');
  const raw = readiness.data(); raw.warnings = [AWEB, 7, { capability: 'x' }, { ...UNKNOWN, capability: 'bad name!' }];
  const projected = readinessData(raw, readiness.target);
  assert.deepEqual(projected.warnings, [{ code: AWEB.code, capability: 'oats.aweb', path: AWEB.path, message: AWEB.message }, { code: UNKNOWN.code, capability: null, path: UNKNOWN.path, message: UNKNOWN.message }]);
  assert.deepEqual(projected.summary, plain.summary, 'the summary is the kernel\'s, untouched');
  assert.deepEqual(readinessData(projected, readinessTarget(readiness.target)), projected, 'the renderer re-projects the server projection');
  for (const bad of ['warnings', 7, null, { 0: AWEB }, [null, [], 'x']]) {
    const v = readiness.data(); v.warnings = bad;
    const got = readinessData(v, readiness.target);
    assert.ok(got, JSON.stringify(bad)); assert.deepEqual(got.warnings, [], JSON.stringify(bad));
  }
});

test('previewData: the warning strings at the end, absent stays absent; malformed never refuses the preview; idempotent', () => {
  const t = structuredClone(previewTargetFixture);
  assert.equal(Object.hasOwn(previewData(previewDocument(), t), 'warnings'), false, 'an older kernel: no key');
  const v = previewDocument(); v.warnings = ['first line\nsecond line', 7, '', 'one'];
  const projected = previewData(v, t);
  assert.deepEqual(projected.warnings, ['first line\nsecond line', 'one']);
  assert.equal(Object.keys(projected).at(-1), 'warnings');
  assert.deepEqual(previewData(projected, t), projected);
  for (const bad of ['w', 7, null, { 0: 'x' }, [{ message: 'x' }]]) {
    const m = previewDocument(); m.warnings = bad;
    const got = previewData(m, t);
    assert.ok(got, JSON.stringify(bad)); assert.deepEqual(got.warnings, [], JSON.stringify(bad));
  }
});

/* ── the soul page and the sidebar soul inspector ────────────────────── */
const f7 = JSON.parse(readFileSync(new URL('./fixtures/workspace-v2/f7/inspect-soul.json', import.meta.url), 'utf8')).result;
const version = JSON.parse(readFileSync(new URL('./fixtures/workspace-v2/f7/version.json', import.meta.url), 'utf8'));
const agentsRoot = '/fixture/base/northwind-workspace/agents';
async function soulInspector(t, { layout = 'page', opens = true, answer = () => f7 } = {}) {
  const previous = currentWorkspace(); setWorkspace('/team');
  await refreshCli({ api: async () => ({ ...version, ok: true, bin: '/fixture/bin/oats' }) });
  const opened = [];
  const dom = new JSDOM('<body><main><aside hidden></aside></main></body>', { pretendToBeVisual: true }), el = dom.window.document.querySelector('aside');
  let reply = answer;
  const inspector = createSoulInspector(el, { layout, ...(opens ? { openCapability: (cap, soul, entry) => opened.push([cap.id, soul.name, entry?.cap?.id ?? null]) } : {}),
    ctx: { api: async (url, opts) => url.startsWith('/api/capabilities') ? structuredClone(reply(JSON.parse(opts.body))) : { status: 'ok', soulTeams: {} } } });
  t.after(() => { inspector.dispose(); dom.window.close(); setWorkspace(previous); resetCliStateForTests(); });
  const selection = { agent: { name: 'release-manager', agentsRoot }, selector: { soul: 'release-manager', agentsRoot } };
  const show = async () => { await inspector.show(selection, { user: true }); for (let i = 0; i < 4; i++) await flush(); };
  await show();
  return { el, doc: dom.window.document, opened, show, answer: next => { reply = next; } };
}
const withWarnings = (list, fields = {}) => () => ({ ...structuredClone(f7), warnings: list, ...fields });

// Slice 3a: the page's problems are its top block's Ready row (the first in one sentence, every one behind Details);
// the warnings follow that block, before the capabilities.
test('soul page: Warnings below the top block and its problems; the kernel\'s words as text; Open capability for a capability this soul has', async t => {
  const u = await soulInspector(t, { answer: withWarnings([AWEB, UNKNOWN], { problems: [{ code: 'E_X', message: 'A problem the kernel reported.' }] }) });
  const section = u.el.querySelector('.inspector-warnings');
  assert.ok(section, 'a section of its own');
  assert.equal(section.querySelector('h3').textContent, 'Warnings');
  assert.equal(section.previousElementSibling.className, 'soul-top', 'right below the top block');
  assert.equal(u.el.querySelector('.soul-ready-line').textContent, 'A problem the kernel reported.', 'the problem: Ready\'s sentence');
  assert.ok(u.el.querySelector('.soul-ready-problems .inspector-problem'), 'and in full behind Details');
  assert.equal(section.nextElementSibling.classList.contains('soul-capabilities'), true, 'before the capabilities');
  const items = [...section.querySelectorAll('.cap-warning')];
  assert.equal(items.length, 2);
  assert.equal(text(items[0].querySelector('.cap-warning-label')), 'Warning');
  assert.equal(text(items[0].querySelector('.cap-warning-capability')), 'oats.aweb');
  assert.equal(text(items[0].querySelector('.cap-warning-message')), AWEB.message);
  assert.equal(items[0].querySelector('.cap-warning-message b'), null, 'markup stays text');
  const open = items[0].querySelector('.cap-warning-open');
  assert.ok(open, 'oats.aweb is one of the soul\'s capabilities');
  assert.equal(items[1].querySelector('.cap-warning-open'), null, 'a capability the inspection does not have opens nothing');
  open.click();
  assert.deepEqual(u.opened, [['oats.aweb', 'release-manager', 'oats.aweb']], 'the tables\' own path: the capability with its core entry');
});

test('soul page: an unchanged refresh keeps the list and focus on Open capability; a changed one restores it by key', async t => {
  const u = await soulInspector(t, { answer: withWarnings([AWEB, UNKNOWN]) });
  const open = u.el.querySelector('.cap-warning-open'); open.focus();
  await u.show();
  assert.equal(u.el.querySelector('.cap-warning-open'), open, 'not repainted');
  assert.equal(u.doc.activeElement, open);
  u.answer(withWarnings([AWEB, { ...UNKNOWN, message: 'Another hook never runs here.' }]));
  await u.show();
  const again = u.el.querySelector('.cap-warning-open');
  assert.notEqual(again, open, 'repainted'); assert.equal(u.doc.activeElement, again, 'focus found again by its key');
  assert.match(text(u.el.querySelector('.inspector-warnings')), /Another hook never runs here\./);
});

test('soul page: an older kernel\'s absent list or an empty one shows no section', async t => {
  for (const answer of [() => f7, withWarnings([])]) {
    const u = await soulInspector(t, { answer });
    assert.equal(u.el.querySelector('.inspector-warnings, .cap-warnings'), null);
    assert.doesNotMatch(text(u.el.querySelector('.inspector-main')), /Warnings/);
  }
});

test('sidebar soul inspector: the same list under the inspector\'s section title; Open capability only where the host opens capabilities', async t => {
  const plain = await soulInspector(t, { layout: 'sidebar', opens: false, answer: withWarnings([AWEB]) });
  const title = [...plain.el.querySelectorAll('h3.inspector-section')].find(h => h.textContent === 'Warnings');
  assert.ok(title); assert.ok(title.nextElementSibling.querySelector('.cap-warning'));
  assert.equal(text(plain.el.querySelector('.cap-warning-message')), AWEB.message);
  assert.equal(plain.el.querySelector('.cap-warning-open'), null, 'the Workspace sidebar gets no openCapability: no action');
  const hosted = await soulInspector(t, { layout: 'sidebar', answer: withWarnings([AWEB]) });
  hosted.el.querySelector('.cap-warning-open').click();
  assert.deepEqual(hosted.opened, [['oats.aweb', 'release-manager', 'oats.aweb']]);
  const none = await soulInspector(t, { layout: 'sidebar', answer: withWarnings([]) });
  assert.equal(none.el.querySelector('.cap-warnings'), null);
  assert.equal([...none.el.querySelectorAll('h3')].some(h => h.textContent === 'Warnings'), false);
});

/* ── readiness ────────────────────────────────────────────────────────── */
function readinessHost(t, { value = readiness.data(), opens = true, can = name => name === 'oats.okf' } = {}) {
  const dom = new JSDOM('<!doctype html><body><main></main>', { pretendToBeVisual: true }), doc = dom.window.document, host = doc.querySelector('main');
  const previous = currentWorkspace(); setWorkspace('team'); const opened = [];
  let current = value;
  const component = createReadinessView(host, { ctx: { api: async () => readiness.view(readiness.target, structuredClone(current)) },
    ...(opens ? { canOpenCapability: can, openCapability: name => opened.push(name) } : {}) });
  t.after(() => { component.dispose(); setWorkspace(previous); dom.window.close(); });
  return { doc, host, component, opened, set: v => { current = v; },
    update: () => component.update({ active: true, workspace: readiness.workspace, selector: readiness.selector, cli: readiness.cli }) };
}
const OKF = warning('oats.okf', 'oats.okf declares a stop hook this harness never runs.');

test('readiness: Warnings after the four checks, apart from the provider\'s own; the summary and counts are unchanged', async t => {
  const before = readinessHost(t); await before.update();
  const summary = text(before.host.querySelector('.readiness-summary'));
  assert.equal(before.host.querySelector('.readiness-warnings'), null, 'none: no section');
  const empty = readinessHost(t, { value: { ...readiness.data(), warnings: [] } }); await empty.update();
  assert.equal(empty.host.querySelector('.readiness-warnings, .cap-warnings'), null, 'an empty list: no section');
  const u = readinessHost(t, { value: { ...readiness.data(), warnings: [OKF, UNKNOWN] } }); await u.update();
  assert.equal(text(u.host.querySelector('.readiness-summary')), summary);
  const section = u.host.querySelector('.readiness-warnings');
  assert.equal(section.previousElementSibling, u.host.querySelector('.readiness-checks'), 'after the four checks');
  assert.equal(section.querySelector('h3').textContent, 'Warnings');
  assert.equal(text(section.querySelector('.cap-warning-label')), 'Warning');
  assert.equal(text(section.querySelector('.cap-warning-message')), OKF.message);
  assert.equal(u.host.querySelector('.readiness-checks .cap-warning'), null, 'not mixed into the checks');
  const opens = [...section.querySelectorAll('.cap-warning-open')];
  assert.equal(opens.length, 1, 'only the name the host resolves');
  opens[0].click(); assert.deepEqual(u.opened, ['oats.okf']);
  const without = readinessHost(t, { value: { ...readiness.data(), warnings: [OKF] }, opens: false }); await without.update();
  assert.ok(without.host.querySelector('.cap-warning')); assert.equal(without.host.querySelector('.cap-warning-open'), null, 'no host action: no button');
});

test('readiness: an unchanged refresh keeps focus on Open capability; whether it opens follows the host', async t => {
  let resolves = false;
  const u = readinessHost(t, { value: { ...readiness.data(), warnings: [OKF] }, can: () => resolves });
  await u.update();
  assert.equal(u.host.querySelector('.cap-warning-open'), null, 'the host\'s inspection has not landed');
  resolves = true; await u.update();
  const open = u.host.querySelector('.cap-warning-open'); assert.ok(open, 'the next host sync shows it');
  u.host.querySelector('.readiness-more')?.setAttribute('open', '');
  open.focus();
  await u.component.refresh(); await flush();
  assert.equal(u.host.querySelector('.cap-warning-open'), open, 'unchanged: not repainted');
  assert.equal(u.doc.activeElement, open);
  u.set({ ...readiness.data(), warnings: [{ ...OKF, message: 'Changed.' }] });
  await u.component.refresh(); await flush();
  assert.equal(u.doc.activeElement, u.host.querySelector('.cap-warning-open'), 'repainted: focus found by key');
  assert.equal(text(u.host.querySelector('.cap-warning-message')), 'Changed.');
});

test('readiness in the sidebar inspector: an instance\'s warnings open through the host, resolved against its inspection', async t => {
  const dom = new JSDOM('<!doctype html><body><aside></aside>', { pretendToBeVisual: true }), doc = dom.window.document, previous = currentWorkspace();
  setWorkspace('team'); resetCliStateForTests();
  const home = readiness.instance, opened = [];
  const ctx = { api: async (path, opts) => {
    if (path === '/api/cli') return { ...readiness.cli, operationsApi: 2 };
    if (path.startsWith('/api/workspace-readiness')) return readiness.view(readiness.instanceTarget, { ...readiness.data(readiness.instanceTarget), warnings: [OKF, UNKNOWN] });
    if (path.startsWith('/api/capabilities')) return homeInspection(home.home, { instance: home.instance, soul: home.agent });
    return {};
  } };
  await refreshCli(ctx);
  const inspector = createSoulInspector(doc.querySelector('aside'), { ctx, workspace: () => readiness.workspace, openCapability: (cap, soul, entry) => opened.push([cap.id, soul, !!entry]) });
  t.after(() => { inspector.dispose(); resetCliStateForTests(); setWorkspace(previous); dom.window.close(); });
  await inspector.show({ instance: home, selector: { home: home.home } });
  for (let i = 0; i < 6; i++) await flush();
  const view = doc.querySelector('.readiness-view');
  assert.ok(view.querySelector('.readiness-warnings'));
  assert.equal(doc.querySelectorAll('.cap-warnings').length, 1, 'an instance\'s warnings are its readiness view\'s, not listed twice');
  const open = view.querySelector('.cap-warning-open'); assert.ok(open, 'oats.okf is this instance\'s capability');
  assert.equal(view.querySelectorAll('.cap-warning-open').length, 1);
  open.click();
  assert.deepEqual(opened, [['oats.okf', null, true]]);
});

/* ── the instance Soul tab ───────────────────────────────────────────── */
const homeFx = () => JSON.parse(readFileSync(new URL('./fixtures/workspace-v2/teams/inspect-home.json', import.meta.url), 'utf8')).result;
async function soulTab(t, answer) {
  const dom = new JSDOM('<body><section></section></body>', { pretendToBeVisual: true });
  const host = dom.window.document.querySelector('section'), document = homeFx();
  const s = createInstanceSoulSection(host, { cli: () => ({ ok: true, operationsApi: 2, features: [] }), request: async () => answer(structuredClone(document)) });
  t.after(() => { s.dispose(); dom.window.close(); });
  s.update({ active: true, workspace: 'A', instance: { instance: 'x', home: document.subject.home, agentsRoot: '/r/agents' } });
  for (let i = 0; i < 3; i++) await flush();
  return host;
}

test('instance Soul tab: Warnings after Capabilities, compact, each naming its capability, no Open capability', async t => {
  const host = await soulTab(t, v => ({ ...v, warnings: [AWEB, UNKNOWN] }));
  const section = host.querySelector('.soul-tab-warnings');
  assert.ok(section);
  assert.equal(section.previousElementSibling.querySelector('.context-panel-label').textContent, 'Capabilities');
  assert.equal(section.querySelector('.context-panel-label').textContent, 'Warnings');
  assert.ok(section.querySelector('.cap-warnings.compact'));
  assert.equal(text(section.querySelector('.cap-warning-label')), 'Warning');
  assert.equal(text(section.querySelector('.cap-warning-capability')), 'oats.aweb');
  assert.equal(text(section.querySelector('.cap-warning-message')), AWEB.message);
  assert.equal(section.querySelector('.cap-warning-open, button'), null, 'the context panel navigates nowhere');
  for (const answer of [v => v, v => ({ ...v, warnings: [] })]) assert.equal((await soulTab(t, answer)).querySelector('.soul-tab-warnings, .cap-warnings'), null);
});

/* ── the spawn preview ───────────────────────────────────────────────── */
for (const mode of ['lines', 'absent', 'empty']) test(`spawn preview warnings: ${mode}`, async t => {
  const u = await mountSpawn(t, { kernel: () => {
    const v = kernel('preview-worktree-default');
    if (mode === 'lines') v.result.warnings = ['oats.aweb: a session-start hook never runs here\n  declared in capabilities/oats.aweb/oats-capability.yaml', '<i>one</i> line'];
    if (mode === 'empty') v.result.warnings = [];
    return v;
  } });
  await u.open();
  const box = u.q('.spawn-preview-warnings');
  if (mode !== 'lines') { assert.equal(box, null); assert.equal(u.q('.cap-warnings'), null); return; }
  assert.equal(box.parentElement, u.q('.spawn-preview-body'));
  assert.equal(box.parentElement.lastElementChild, box, 'at the end of "What will be created"');
  assert.equal(box.querySelector('.spawn-preview-title').textContent, 'Warnings');
  const items = [...box.querySelectorAll('.cap-warning')];
  assert.equal(items.length, 2);
  assert.equal(text(items[0].querySelector('.cap-warning-label')), 'Warning');
  assert.deepEqual([...items[0].querySelectorAll('.cap-warning-message')].map(p => p.textContent),
    ['oats.aweb: a session-start hook never runs here', 'declared in capabilities/oats.aweb/oats-capability.yaml'], 'each line its own');
  assert.equal(text(items[1].querySelector('.cap-warning-message')), '<i>one</i> line');
  assert.equal(items[1].querySelector('i'), null, 'markup stays text');
  assert.equal(box.querySelector('button, details'), null, 'lines mode: no Details, no Open capability');
  assert.equal(u.q('.fspawn').disabled, false, 'a warning blocks nothing');
});
