// F7: the Workspace inspector in the spawn modal's language — soul teams
// (read-only, kernel `teams`), readiness as one line, compact cards/lists,
// declarations behind a disclosure; the instance: Teams first, then the
// instance, "Spawned from", the as-spawned modules collapsed. Kernel capture
// fixtures/workspace-v2/f7 (kernel 0.29.3, the real oats.aweb 1.16.0 + a fake aw).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createSoulInspector } from '../renderer/soul-inspector.mjs';
import { soulTeams } from '../renderer/teams-panel.mjs';
import { setWorkspace, currentWorkspace } from '../renderer/views/common.mjs';
import { refreshCli, resetCliStateForTests } from '../renderer/views/cli-status.mjs';
import { notePanel, resetViewDeployments } from '../renderer/view-deployments.mjs';

const doc = name => JSON.parse(readFileSync(new URL(`./fixtures/workspace-v2/f7/${name}.json`, import.meta.url), 'utf8'));
const soul = doc('inspect-soul').result, home = doc('inspect-home').result, teamsRun = doc('teams-initial').result;
const agentsRoot = '/fixture/base/northwind-workspace/agents';
const soulSelection = { agent: { name: 'release-manager', agentsRoot }, selector: { soul: 'release-manager', agentsRoot } };
const homeSelection = { instance: { instance: home.subject.instance, agentsRoot, home: home.subject.home }, selector: { home: home.subject.home } };
const tick = () => new Promise(r => setTimeout(r, 0));

async function rendered(t, selection, answer, options = {}) {
  const previous = currentWorkspace(); setWorkspace('/team'); const calls = [];
  const dom = new JSDOM('<body><main><aside hidden></aside></main></body>'), el = dom.window.document.querySelector('aside');
  const inspector = createSoulInspector(el, { ...options, ctx: { api: async (url, opts) => {
    const body = JSON.parse(opts.body); calls.push(body);
    const out = typeof answer === 'function' ? answer(body) : answer; if (out instanceof Error) throw out; return structuredClone(out);
  } } });
  t.after(() => { inspector.dispose(); dom.window.close(); setWorkspace(previous); });
  await inspector.show(selection); await tick(); await tick();
  return { el, calls, sections: () => [...el.querySelectorAll('h3.inspector-section')].map(h => h.textContent) };
}

test('the capture: a soul with two labels, one mapped; the kernel answers teams primary first', () => {
  assert.deepEqual(soulTeams(soul.teams), [{ label: 'engineering', team: 'northwind:eng', mapped: true }, { label: 'global', team: null, mapped: false }]);
  assert.equal(soul.teamsSource, 'live');
  for (const bad of [null, {}, [{ label: 'x', team: null, mapped: true }], [{ label: 'x', team: 'a:b', mapped: false }], [{ label: 'Bad Label', team: null, mapped: false }],
    [{ label: 'x', team: null, mapped: false }, { label: 'x', team: null, mapped: false }], [{ label: 'x', team: null }]]) assert.equal(soulTeams(bad), null, JSON.stringify(bad));
  assert.deepEqual(soulTeams([]), []);
});

test('soul: only what a person needs — Teams, Harness, Core capabilities, Capabilities; no readiness, source, spawn internals or declarations', async t => {
  const u = await rendered(t, soulSelection, soul);
  // The core providers (oats.okf, oats.aweb) are the Core capabilities card's: never counted or listed again.
  const others = soul.capabilities.filter(cap => !cap.layer);
  assert.deepEqual(u.sections(), ['Teams', 'Harness', 'Core capabilities', `Capabilities · ${others.length}`]);
  assert.doesNotMatch(u.el.textContent, /When spawned|Effective providers|Declared in soul\.yaml|AGENTS\.md|Provider operations/);
  assert.equal(u.el.querySelector('.readiness-view'), null);
  const chips = u.el.querySelector('h3.inspector-section + p + .inspector-chips');
  assert.ok(chips, 'one horizontal row of chips follows the one-line explanation');
  assert.equal(chips.previousElementSibling.textContent, "The teams this soul has access to. Its instances start in the workspace's default team only and can join these:");
  assert.deepEqual([...chips.children].map(c => [c.textContent, c.className, c.title]),
    [['engineering', 'inspector-chip', 'engineering (northwind:eng)']], 'global is not mapped: not shown');
  assert.doesNotMatch(u.el.textContent, /global/);
  assert.equal(u.el.querySelector('form, input, select, textarea'), null, 'read-only: joining is per instance');
  const caps = [...u.el.querySelectorAll('.inspector-cap-row')];
  assert.deepEqual(caps.map(row => row.querySelector('.inspector-item-name').textContent), others.map(cap => cap.id));
  assert.doesNotMatch(u.el.querySelector('.inspector-list').textContent, /provider/, 'no "<layer> provider" rows');
});

test('soul: no teams reported shows nothing; an empty list says default team only', async t => {
  const none = structuredClone(soul); delete none.teams;
  const a = await rendered(t, soulSelection, none);
  assert.equal(a.sections()[0], 'Harness');
  const empty = structuredClone(soul); empty.teams = [];
  const b = await rendered(t, soulSelection, empty);
  assert.equal(b.sections()[0], 'Teams');
  assert.match(b.el.textContent, /Default team only: this soul has access to no other team\./);
  const unmapped = structuredClone(soul); unmapped.teams = [{ label: 'global', team: null, mapped: false, payload: {} }];
  const c = await rendered(t, soulSelection, unmapped);
  assert.match(c.el.textContent, /Default team only: this soul has access to no other team\./); assert.doesNotMatch(c.el.textContent, /global/);
  assert.equal(b.el.querySelector('.inspector-chips'), null);
});

test('soul: a declared default harness and model are named; the summary is the description only', async t => {
  const v = structuredClone(soul); v.souls[0].harness = 'claude'; v.souls[0].model = 'claude-opus-4';
  const u = await rendered(t, { agent: { ...soulSelection.agent, description: 'Ships the releases.' }, selector: soulSelection.selector }, v);
  const harness = [...u.el.querySelectorAll('h3.inspector-section')].find(h => h.textContent === 'Harness').nextElementSibling;
  assert.deepEqual([...harness.querySelectorAll('dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent]), [['Default harness', 'Claude Code'], ['Default model', 'claude-opus-4']]);
  assert.equal(u.el.querySelector('.inspector-summary .inspector-lede').textContent, 'Ships the releases.');
  assert.equal(u.el.querySelector('.inspector-summary .inspector-facts'), null, 'no Source/Runtime facts');
});

test('instance: Teams first, then the instance card, "Spawned from" with Open soul, the as-spawned modules collapsed', async t => {
  const opened = [];
  const u = await rendered(t, homeSelection, body => body.action === 'inspect' ? home : teamsRun, { openSoul: ref => { opened.push(ref); return true; } });
  assert.deepEqual(u.sections().slice(0, 2), ['Teams', 'Instance']);
  const panel = u.el.querySelector('h3.inspector-section + .teams-panel');
  assert.ok(panel, 'the Teams card follows its heading'); assert.equal(panel.querySelector('h3'), null);
  const spawned = u.el.querySelector('.inspector-spawned');
  assert.equal(spawned.querySelector('span').textContent, `Spawned from release-manager @ ${home.souls[0].commit.slice(0, 7)}`);
  spawned.querySelector('button').click();
  assert.deepEqual(opened, [{ name: 'release-manager', agentsRoot, server: null }]);
  const modules = [...u.el.querySelectorAll('details.inspector-disclosure')].find(d => /^Modules as spawned · \d+$/.test(d.querySelector('summary').textContent));
  assert.ok(modules); assert.equal(modules.open, false);
  assert.ok(modules.querySelector('.inspector-cap-row'), 'the frozen capabilities are inside');
  assert.equal(u.el.querySelector('.soul-declarations'), null, 'an instance does not restate the soul\'s declarations');
});

test('instance: Open soul says so when the roster has no exact match; no host resolver, no button', async t => {
  const u = await rendered(t, homeSelection, body => body.action === 'inspect' ? home : teamsRun, { openSoul: () => false });
  u.el.querySelector('.inspector-spawned button').click();
  assert.equal(u.el.querySelector('.inspector-status').textContent, "release-manager is not in this workspace's souls.");
  const v = await rendered(t, homeSelection, body => body.action === 'inspect' ? home : teamsRun);
  assert.equal(v.el.querySelector('.inspector-spawned button'), null);
  assert.match(v.el.querySelector('.inspector-spawned').textContent, /^Spawned from release-manager/);
});

// desktop/loading-states: a first read that fails is the failed block where the skeleton stood (the
// kernel's sentence, the code behind Details, Retry); the status line announces it once.
test('a refused inspection reads as the kernel sentence with the code behind Details (E_TEAM_CONFLICT, captured)', async t => {
  const refused = doc('inspect-soul-conflict').error;
  const u = await rendered(t, soulSelection, Object.assign(new Error(refused.message), { code: refused.code }));
  const status = u.el.querySelector('.inspector-status');
  assert.equal(status.textContent, `Couldn't refresh soul. ${refused.message}`); assert.equal(status.classList.contains('error'), false, 'a failed read is calm information, not the error red');
  assert.equal(status.classList.contains('loading-quiet'), true, 'announced; the failed block below is the visible message');
  assert.match(status.textContent, /team labels "engineering" and "global" give it different entries/);
  const failed = u.el.querySelector('.inspector-content .loading-failed');
  assert.equal(failed.querySelector('.loading-failed-message').textContent, refused.message);
  const details = failed.querySelector('.loading-failed-details');
  assert.equal(details.querySelector('summary').textContent, 'Details'); assert.equal(details.querySelector('.loading-failed-code').textContent, 'E_TEAM_CONFLICT');
  assert.equal(failed.querySelector('.loading-retry').textContent, 'Retry');
});

// E_TEAM_CONFLICT end to end: the kernel's details.labels, bounded, through the
// server refusal, the HTTP payload and both renderer error paths, to the inspector.
import { capabilityRequest } from '../server/capabilities.mjs';
import { apiJson, httpError } from '../renderer/views/common.mjs';
const spawnErrorPayload = (() => {
  const source = readFileSync(new URL('../server/oats-web.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function spawnErrorPayload(e)'), end = source.indexOf('/* OATSWEB_SPAWNERR_END */', start);
  return new Function(`${source.slice(start, end)}\nreturn spawnErrorPayload;`)();
})();
const conflict = doc('inspect-soul-conflict');
const refusal = async envelope => {
  try {
    await capabilityRequest({ action: 'inspect', selector: { soul: 'release-manager', agentsRoot } }, {
      workspace: { id: 'nw', scope: '/fixture/base/northwind-workspace' }, cli: { ok: true, operationsApi: 2, bin: '/fixture/bin/oats' },
      agents: [{ name: 'release-manager', agentsRoot }], invoke: async () => envelope });
  } catch (error) { return error; }
  assert.fail('expected a refusal');
};

test('E_TEAM_CONFLICT: the server refusal carries the two labels (validated); nothing else does', async () => {
  assert.deepEqual(conflict.error.details.labels, ['engineering', 'global'], 'captured');
  const e = await refusal(conflict);
  assert.equal(e.code, 'E_TEAM_CONFLICT'); assert.equal(e.message, conflict.error.message); assert.deepEqual(e.labels, ['engineering', 'global']);
  for (const labels of [['engineering'], ['engineering', '-x'], 'engineering,global', Array.from({ length: 17 }, (_, i) => `t${i}`)]) {
    const bad = structuredClone(conflict); bad.error.details.labels = labels;
    assert.equal(Object.hasOwn(await refusal(bad), 'labels'), false, JSON.stringify(labels));
  }
  const other = structuredClone(conflict); other.error.code = 'E_SOUL_UNKNOWN';
  assert.equal(Object.hasOwn(await refusal(other), 'labels'), false, 'only the conflict carries labels');
  assert.deepEqual(spawnErrorPayload(e).body, { error: conflict.error.message, code: 'E_TEAM_CONFLICT', labels: ['engineering', 'global'] });
  assert.equal(Object.hasOwn(spawnErrorPayload(Object.assign(new Error('x'), { code: 'E_SOUL_UNKNOWN', labels: ['a', 'b'] })).body, 'labels'), false);
  // both renderer paths keep them
  const body = spawnErrorPayload(e).body;
  const viaFetch = await apiJson({ api: async () => ({ ok: false, status: 409, json: async () => body }) }, '/api/capabilities', {}).catch(x => x);
  assert.deepEqual(viaFetch.labels, ['engineering', 'global']);
  assert.deepEqual(httpError({ status: 409, body }, '/api/capabilities').labels, ['engineering', 'global']);
});

test('E_TEAM_CONFLICT in the inspector: the sentence, the two labels, the code behind Details; unreadable labels are not shown', async t => {
  const make = labels => Object.assign(new Error(conflict.error.message), { code: 'E_TEAM_CONFLICT', labels });
  const u = await rendered(t, soulSelection, make(['engineering', 'global']));
  assert.equal(u.el.querySelector('.inspector-conflict-labels').textContent, 'Team labels in conflict: engineering, global');
  assert.equal(u.el.querySelector('.loading-failed-code').textContent, 'E_TEAM_CONFLICT');
  assert.equal(u.el.querySelector('.loading-failed').nextElementSibling, u.el.querySelector('.inspector-conflict-labels'), 'the labels follow the failed block');
  for (const labels of [undefined, ['engineering'], ['engineering', 'engineering'], ['a b', 'c']]) {
    const v = await rendered(t, soulSelection, make(labels));
    assert.equal(v.el.querySelector('.inspector-conflict-labels'), null, JSON.stringify(labels));
  }
});

test('Core capabilities say why each slot is filled in the soul page\'s words, only with the features (kernel #191, #217, captured)', async t => {
  assert.deepEqual(soul.layers.knowledge, { id: 'oats.okf', from: 'workspace' }, 'the capture');
  assert.deepEqual(home.layers.messaging, { id: 'oats.aweb', from: 'workspace' }, 'a home answers what its spawn recorded');
  const core = el => {
    const head = [...el.querySelectorAll('h3.inspector-section')].find(h => h.textContent === 'Core capabilities');
    return Object.fromEntries([...head.nextElementSibling.querySelectorAll('dd')].map(dd => [dd.dataset.layer, {
      id: dd.querySelector('.inspector-core-id').textContent, tag: dd.querySelector('.why-tag, .why-note')?.textContent ?? null,
      title: dd.querySelector('.why-tag, .why-note')?.title ?? null, note: dd.querySelector('.inspector-core-note')?.textContent ?? null }]));
  };
  t.after(() => resetCliStateForTests());
  await refreshCli({ api: async () => ({ ...doc('version'), ok: true, bin: '/fixture/bin/oats' }) });
  assert.ok(doc('version').features.includes('layers-from') && doc('version').features.includes('desktop-facts'));
  const withFrom = await rendered(t, soulSelection, soul);
  assert.deepEqual(core(withFrom.el), {
    knowledge: { id: 'oats.okf', tag: 'workspace', title: 'A workspace default', note: "Resolves the workspace default: this soul doesn't choose a knowledge capability" },
    messaging: { id: 'oats.aweb', tag: 'workspace', title: 'A workspace default', note: "Resolves the workspace default: this soul doesn't choose a messaging capability" },
    tasks: { id: 'None', tag: 'No default', title: 'Neither this soul nor the workspace fills the tasks slot', note: 'Neither this soul nor the workspace fills the tasks slot.' } });
  // An instance: what its spawn recorded; a home reports no emptied slot, so an empty one claims nothing.
  const spawned = await rendered(t, homeSelection, body => body.action === 'inspect' ? home : teamsRun);
  assert.deepEqual(core(spawned.el), {
    knowledge: { id: 'oats.okf', tag: 'workspace', title: 'A workspace default', note: 'Resolved the workspace default at spawn' },
    messaging: { id: 'oats.aweb', tag: 'workspace', title: 'A workspace default', note: 'Resolved the workspace default at spawn' },
    tasks: { id: 'None', tag: null, title: null, note: null } });
  const modules = [...spawned.el.querySelectorAll('h3.inspector-section')].find(h => /^Capabilities · /.test(h.textContent));
  assert.equal(modules.textContent, `Capabilities · ${home.capabilities.filter(cap => !cap.layer).length}`, 'the core providers are not listed again');
  await refreshCli({ api: async () => ({ ...doc('version'), features: doc('version').features.filter(f => f !== 'layers-from'), ok: true, bin: '/fixture/bin/oats' }) });
  const without = await rendered(t, soulSelection, soul);
  assert.deepEqual(core(without.el), { knowledge: { id: 'oats.okf', tag: null, title: null, note: null }, messaging: { id: 'oats.aweb', tag: null, title: null, note: null },
    tasks: { id: 'None', tag: null, title: null, note: null } }, 'no reason without the feature, and no "No default" guessed');
});

// Team model v2 (0.30, D2 screen 2): with kernel feature team-model-2 the soul page shows
// "Teams here" (this computer's membership, editable) through /api/workspace-soul-teams, in
// place of the 0.29 read-only Teams card; without the feature, the 0.29 card stays.
test('soul page: team-model-2 shows "Teams here" from the soul teams route; without it, the 0.29 Teams card', async t => {
  // The REAL 0.30 kernel's `oats soul teams release-manager` (K1 @bba0a9b8, test/fixtures/team-model-v2/soul-teams-show, #269).
  const { soulTeamsData } = await import('../../client/deployment-data.mjs');
  const soulTeamsDoc = soulTeamsData(JSON.parse(readFileSync(new URL('./fixtures/team-model-v2/soul-teams-show.json', import.meta.url), 'utf8')));
  const urls = [];
  // The roster row carries the kernel's soul key (#275): the bare name for a member soul.
  const keyed = { ...soulSelection, agent: { ...soulSelection.agent, key: 'release-manager' } };
  const page = async () => {
    const previous = currentWorkspace(); setWorkspace('/team');
    const dom = new JSDOM('<body><main><aside hidden></aside></main></body>'), el = dom.window.document.querySelector('aside');
    const inspector = createSoulInspector(el, { layout: 'page', ctx: { api: async (url, opts) => {
      urls.push([url.replace(/\?.*$/, ''), JSON.parse(opts.body)]);
      return url.startsWith('/api/workspace-soul-teams') ? { status: 'ok', soulTeams: structuredClone(soulTeamsDoc) } : structuredClone(soul);
    } } });
    t.after(() => { inspector.dispose(); dom.window.close(); setWorkspace(previous); });
    await inspector.show(keyed); for (let i = 0; i < 4; i++) await tick();
    return el;
  };
  t.after(() => resetCliStateForTests());
  await refreshCli({ api: async () => ({ ...doc('version'), features: [...doc('version').features, 'team-model-2'], ok: true, bin: '/fixture/bin/oats' }) });
  const v2 = await page();
  const card = v2.querySelector('[data-card="Teams here"]');
  assert.ok(card, 'the Teams here card');
  assert.equal(v2.querySelector('[data-card="Teams"]'), null, 'in place of the 0.29 card');
  assert.deepEqual(urls.filter(([url]) => url === '/api/workspace-soul-teams'), [['/api/workspace-soul-teams', { soul: 'release-manager', action: 'show' }]]);
  assert.equal(card.querySelector('.sth-default').textContent, "Default: mine (the workspace's default on this computer)");
  assert.doesNotMatch(v2.textContent, /primary|personal/i);
  await refreshCli({ api: async () => ({ ...doc('version'), ok: true, bin: '/fixture/bin/oats' }) });
  urls.length = 0;
  const v1 = await page();
  assert.equal(v1.querySelector('[data-card="Teams here"]'), null);
  assert.ok(v1.querySelector('[data-card="Teams"]'), 'the 0.29 card');
  assert.equal(urls.some(([url]) => url === '/api/workspace-soul-teams'), false);
});

test("soul page: 'Teams here' is keyed by the roster row's kernel key (always present, #276): a package soul sends <package>/<soul>, an external soul its name; a row without one names the CLI", async t => {
  const previous = currentWorkspace(); setWorkspace('/team');
  t.after(() => { setWorkspace(previous); resetCliStateForTests(); });
  await refreshCli({ api: async () => ({ ...doc('version'), features: [...doc('version').features, 'team-model-2'], ok: true, bin: '/fixture/bin/oats' }) });
  const open = async (agent, kind) => {
    const inspected = structuredClone(soul); inspected.souls[0].kind = kind; const bodies = [];
    const dom = new JSDOM('<body><main><aside hidden></aside></main></body>'), el = dom.window.document.querySelector('aside');
    const inspector = createSoulInspector(el, { layout: 'page', ctx: { api: async (url, opts) => {
      if (!url.startsWith('/api/workspace-soul-teams')) return structuredClone(inspected);
      const body = JSON.parse(opts.body); bodies.push(body);
      return { status: 'refused', reason: { code: 'E_SOUL_UNKNOWN', message: `no soul ${body.soul} here` } };
    } } });
    t.after(() => { inspector.dispose(); dom.window.close(); });
    await inspector.show({ ...soulSelection, agent: { ...soulSelection.agent, ...agent } }); for (let i = 0; i < 4; i++) await tick();
    return { card: el.querySelector('[data-card="Teams here"]'), bodies };
  };
  const pkg = await open({ key: 'acme.pkg/release-manager' }, 'package');
  assert.deepEqual(pkg.bodies, [{ soul: 'acme.pkg/release-manager', action: 'show' }], "the kernel's key, never a name the Desktop builds");
  const external = await open({ key: 'release-manager' }, 'external');
  assert.deepEqual(external.bodies, [{ soul: 'release-manager', action: 'show' }], 'the kind does not matter: the key does');
  const unkeyed = await open({}, 'package');
  assert.equal(unkeyed.card.querySelector('.page-note').textContent, "Set this soul's teams with the CLI (oats soul teams): this Desktop's server does not report the soul's key.", 'a server from before #275');
  assert.equal(unkeyed.card.querySelector('button'), null);
  assert.deepEqual(unkeyed.bodies, [], 'nothing asked without the kernel key');
});

test("the soul page's Refresh ('Inspect again') asks the server for a live inspection (refresh: true); the first show does not", async t => {
  const previous = currentWorkspace(); setWorkspace('/team');
  t.after(() => { setWorkspace(previous); resetCliStateForTests(); });
  await refreshCli({ api: async () => ({ ...doc('version'), ok: true, bin: '/fixture/bin/oats' }) });
  const bodies = [];
  const dom = new JSDOM('<body><main><aside hidden></aside></main></body>'), el = dom.window.document.querySelector('aside');
  const inspector = createSoulInspector(el, { layout: 'page', ctx: { api: async (url, opts) => {
    if (url.startsWith('/api/capabilities')) bodies.push(JSON.parse(opts.body));
    return url.startsWith('/api/workspace-soul-teams') ? { status: 'ok', soulTeams: {} } : structuredClone(soul);
  } } });
  t.after(() => { inspector.dispose(); dom.window.close(); });
  await inspector.show(soulSelection); for (let i = 0; i < 4; i++) await tick();
  assert.deepEqual(bodies, [{ action: 'inspect', selector: soulSelection.selector }], 'a visit is a plain read (served from the held inspection when one exists)');
  const refresh = el.querySelector('button[title="Inspect again"]');
  assert.ok(refresh, 'the Refresh control');
  refresh.click(); for (let i = 0; i < 4; i++) await tick();
  assert.deepEqual(bodies.at(-1), { action: 'inspect', selector: soulSelection.selector, refresh: true }, 'Refresh is a live read');
});

// #482's line (2026-10-23): in a view of two or more deployments the side panel's soul inspector says which deployment it
// reads ("On <primary>", under its heading); the soul's page on the Workspace page does not (the Workspace pages name
// no deployment). A view of one shows neither.
test('the side panel\'s soul inspector names the deployment it reads in a view of two; the soul page does not', async t => {
  t.after(resetViewDeployments);
  const two = [
    { id: '/d1', machine: 'This Mac', path: '/Users/ana/Agents/first', label: '~/Agents/first', local: true, primary: true, reachable: true },
    { id: '/d2', machine: 'devbox', path: '/srv/first', label: '~/first', local: false, primary: false, reachable: true },
  ];
  notePanel({ workspace: { id: '/team' }, deployments: two });
  const side = await rendered(t, soulSelection, soul);
  const line = side.el.querySelector('.deployment-scope');
  assert.ok(line, 'the side panel shows the line');
  assert.equal(line.hidden, false); assert.equal(line.textContent, 'On This Mac · ~/Agents/first');
  assert.equal(line.previousElementSibling?.classList.contains('inspector-notice'), true, 'under the heading, its notice between');
  const page = await rendered(t, soulSelection, soul, { layout: 'page' });
  assert.ok(page.el.querySelector('.page-bar'), 'the soul page');
  assert.equal(page.el.querySelector('.deployment-scope'), null, 'no line on the Workspace page');
  assert.doesNotMatch(page.el.textContent, /On This Mac/);
  notePanel({ workspace: { id: '/team' }, deployments: two.slice(0, 1) }); await tick();
  assert.equal(line.hidden, true, 'one deployment: the side panel\'s line hides');
});
