import { launchSoul } from './helpers/workspace-actions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createSelectionOwnership } from '../renderer/selection-ownership.mjs';
import * as spawn from '../renderer/views/spawn.mjs';
import { currentWorkspace, setWorkspace, workspaceGeneration } from '../renderer/views/common.mjs';
import { soulInspection, homeInspection } from './helpers/inspect-fixture.mjs';
import { refreshCli } from '../renderer/views/cli-status.mjs';
import { workspaceStatusData } from '../../client/deployment-data.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const CLI = { ok: true, operationsApi: 2, features: ['operations'], relations: true };
const soul = (agentsRoot = '/a/agents') => ({ name: 'dev', agentsRoot, runtime: 'pi', work: 'worktree', description: 'Current roster soul' });
const home = { agent: 'dev', instance: 'dev-seat', agentsRoot: '/b/agents', home: '/b/agents/dev/instances/dev-seat' };
// operationsApi 2 inspections from the kernel capture: a soul subject, or an instance home.
const inspection = selector => selector.home
  ? homeInspection(selector.home, { instance: 'dev-seat', soul: 'dev', instructions: { file: `${selector.home}/AGENTS.md`, text: '# Captured instructions', truncated: false, sources: [] } })
  : soulInspection(selector.soul, { instructions: { file: '/a/AGENTS.md', text: '# Saved instructions', truncated: false } });

// With `catalog` (the capabilities read's answer, a value or a promise per call) the workspace is one whose catalog
// is read: a CLI that advertises workspace-v2 and an observed deployment (fixtures workspace-v2/f2).
const f2 = name => JSON.parse(readFileSync(new URL(`./fixtures/workspace-v2/f2/${name}.json`, import.meta.url), 'utf8'));
const CATALOG_CLI = { ...f2('version'), ok: true, bin: '/fixture/bin/oats', operationsApi: 2, features: [...(f2('version').features || []), 'operations', 'capability-show'], relations: true, capabilityShowApi: 1 };
const observedStatus = workspaceStatusData(f2('workspace-status'), '/fixture/base/northwind-workspace');

async function setup(t, { hold = false, beforeMount, catalog = null } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div>', { url: 'http://localhost' });
  const saved = { document: globalThis.document, window: globalThis.window, setInterval: globalThis.setInterval, ws: currentWorkspace() };
  globalThis.document = dom.window.document; globalThis.window = dom.window;
  const polls = []; globalThis.setInterval = fn => { polls.push(fn); return 0; };
  const rosters = [], calls = [], files = [], terminals = [], cliState = catalog ? CATALOG_CLI : CLI;
  let agents = [soul(), soul('/b/agents')], emits = 0;
  const ctx = {
    hasWorkspaceSwitcher: true,
    api: async (path, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : undefined; calls.push({ path, body });
      if (path === '/api/cli') return cliState;
      if (path.startsWith('/api/agents')) {
        if (!hold) return { agents };
        const request = deferred(); rosters.push(request); return request.promise;
      }
      if (path.startsWith('/api/panel')) return { workspace: { id: currentWorkspace(), scope: currentWorkspace() }, workspaces: [], instances: [home],
        ...(catalog ? { deployment: { status: 'observed', root: '/a/agents', workspace: observedStatus.workspace, workspaceStatus: observedStatus, reachable: { reachable: true }, withheld: [] } } : {}) };
      if (catalog && path.startsWith('/api/workspace-sync')) return catalog(body);
      if (catalog && path.startsWith('/api/capabilities') && body.action === 'show') return new Promise(() => {}); // the page's Contents: not this file's subject
      if (path.startsWith('/api/capabilities') && body.action === 'inspect') return inspection(body.selector);
      if (path.startsWith('/api/capabilities') && body.action === 'list') return { inventoryApi: 1,
        scope: { kind: 'classic', context: body.selector.context || currentWorkspace() }, packages: [], capabilities: [], legacy: [] };
      if (path.startsWith('/api/servers')) return { servers: [] };
      throw new Error(`Unexpected fixture API: ${path}`);
    },
    openBrain: name => files.push(name), openTerminal: ref => terminals.push(ref),
  };
  const doc = dom.window.document;
  t.after(() => {
    spawn.unmount(); setWorkspace(saved.ws);
    globalThis.document = saved.document; globalThis.window = saved.window; globalThis.setInterval = saved.setInterval;
    dom.window.close();
  });
  setWorkspace('/team'); await refreshCli({ api: async () => cliState });
  beforeMount?.(); spawn.mount(doc.querySelector('#host'), ctx); await tick();
  const selectedTab = () => doc.querySelector('[role=tab][aria-selected=true]');
  return {
    doc, ctx, rosters, calls, files, terminals, selectedTab,
    poll: () => polls.at(-1)(),
    // A CLI change (a gate-relevant difference): the view re-reads the capabilities catalog.
    cliEmit: () => refreshCli({ api: async () => ({ ...cliState, version: `${cliState.version}-emit${++emits}` }) }),
    setAgents: next => { agents = next; },
    resolve: (index, next = agents) => rosters[index].resolve({ agents: next }),
    tab: name => { const control = doc.getElementById(`workspace-tab-${name}`); control.focus(); control.click(); },
    key: key => { const control = selectedTab(); control.focus(); control.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); },
    inspections: () => calls.filter(call => call.path.startsWith('/api/capabilities') && call.body.action === 'inspect'),
  };
}
for (const outcome of ['success', 'rejection']) for (const choice of ['sources', 'current souls']) {
  test(`mounted Workspace ${choice} supersedes a shell footer import ${outcome}`, async t => {
    const u = await setup(t);
    const source = readFileSync(new URL('../renderer/shell.mjs', import.meta.url), 'utf8');
    const gate = createSelectionOwnership({ currentWorkspace, workspaceGeneration });
    const hook = source.match(/onSelectionIntent:\s*(\(\) => tabOpenIntents\.invalidate\(\))/)?.[1];
    assert.ok(hook, 'production ctx shares Workspace selection with shell foreground ownership');
    u.ctx.onSelectionIntent = runInNewContext(hook, { tabOpenIntents: gate });
    const deferredImport = deferred(), notices = [], stages = [];
    const chooser = source.match(/async function openWorkspaceSouls\([^]*?\n\}/)[0]
      .replace('import("./views/spawn.mjs")', 'loadSpawn()');
    const choose = runInNewContext(`(${chooser})`, {
      document: u.doc, tabOpenIntents: gate,
      loadSpawn: () => deferredImport.promise,
      ctx: { notify: message => notices.push(message) },
      showStage: name => stages.push(name),
    });
    const pending = choose();
    u.tab(choice === 'sources' ? 'sources' : 'souls');
    const focused = u.doc.activeElement;
    if (outcome === 'success') deferredImport.resolve(spawn);
    else deferredImport.reject(new Error('superseded chooser'));
    await pending; await tick();
    assert.deepEqual(stages, [], 'old footer import cannot navigate after a newer Workspace choice');
    assert.deepEqual(notices, [], 'old footer rejection cannot notify after a newer Workspace choice');
    assert.equal(u.selectedTab().id, `workspace-tab-${choice === 'sources' ? 'sources' : 'souls'}`);
    assert.equal(u.doc.activeElement, focused);
  });
}

// F7: a soul's actions live on its page in the Workspace view.
const inspectorFiles = u => [...u.doc.querySelectorAll('.workspace-soul-page button')].find(control => control.textContent === 'Files');
const handoff = kind => kind === 'soul' ? spawn.preselectSoul(soul('/b/agents')) : spawn.preselectHome(home);
function assertNoHandoff(u, tab) {
  assert.equal(u.selectedTab().id, `workspace-tab-${tab}`);
  assert.equal(u.doc.querySelector('.soul-inspector').hidden, true);
  assert.equal(u.doc.querySelector('.workspace-soul-page').hidden, true);
  assert.equal(u.doc.querySelector('.spawn-dialog'), null);
  assert.ok(u.inspections().every(call => !call.body.selector.soul && !call.body.selector.home), 'no superseded soul/home inspection was dispatched');
  assert.deepEqual(u.files, []); assert.deepEqual(u.terminals, []);
}

for (const [label, replacement] of [
  ['root replacement', soul('/b/agents')],
  ['host replacement', { ...soul(), server: 'other-host' }],
  ['remote replacement', { ...soul(), remote: true }],
]) test(`captured Files refuses ${label}, not just ambiguous names`, async t => {
  const u = await setup(t);
  u.setAgents([soul()]); u.poll(); await tick();
  u.doc.querySelector('.soul-card').click(); await tick();
  const captured = inspectorFiles(u); assert.ok(captured); assert.equal(captured.disabled, false);
  u.setAgents([replacement]); u.poll(); await tick();
  assert.equal(inspectorFiles(u), captured, 'polling preserves the inspector rather than disguising a retarget');
  captured.click();
  assert.deepEqual(u.files, [], 'old /a/agents/dev must never route to the same-named replacement');
  const refresh = [...u.doc.querySelectorAll('.workspace-soul-page button')].find(control => control.textContent === 'Refresh');
  refresh.click(); await tick();
  assert.equal(inspectorFiles(u).disabled, true, 'a rerender disables the stale Files selector too');
  if (label === 'root replacement') {
    const currentCard = u.doc.querySelector('.soul-card'); currentCard.focus();
    currentCard.dispatchEvent(new u.doc.defaultView.KeyboardEvent('keydown', { key: 'b', bubbles: true }));
    assert.deepEqual(u.files, ['dev'], 'the actual current unique local B path remains compatible');
    u.doc.querySelector('.soul-card').click(); await tick();
    assert.equal(inspectorFiles(u).disabled, false);
    inspectorFiles(u).click(); assert.deepEqual(u.files, ['dev', 'dev']);
  }
});

test('captured Files accepts a new roster object with the SAME composite identity', async t => {
  const u = await setup(t);
  u.setAgents([soul()]); u.poll(); await tick();
  u.doc.querySelector('.soul-card').click(); await tick();
  const captured = inspectorFiles(u);
  u.setAgents([{ ...soul(), server: '', description: 'New metadata, same local identity' }]); u.poll(); await tick();
  captured.click(); assert.deepEqual(u.files, ['dev']);
  spawn.unmount(); captured.click();
  assert.deepEqual(u.files, ['dev'], 'a disposed owner cannot use even a matching captured Files control');
});

const choices = [
  ['click Capabilities', u => u.tab('capabilities'), 'capabilities'],
  ['keyboard Sources', u => u.key('End'), 'sources'],
  ['footer Sources', () => spawn.preselectWorkspaceTab('sources'), 'sources'],
  ['click current Souls', u => u.tab('souls'), 'souls'],
  // Home lands on Souls, the first tab again (product owner, 2026-10-23: Souls, Capabilities, Teams, Setup).
  ['keyboard current Souls', u => u.key('Home'), 'souls'],
  ['footer current Souls', () => spawn.preselectWorkspaceTab('souls'), 'souls'],
  ['Souls → Sources → Souls', u => { u.tab('sources'); u.tab('souls'); }, 'souls'],
];
for (const kind of ['soul', 'home']) for (const [label, choose, tab] of choices) for (const outcome of ['success', 'rejection']) {
  test(`pending ${kind} loses to ${label} after roster ${outcome}`, async t => {
    const u = await setup(t, { hold: true });
    handoff(kind); choose(u);
    const focused = u.doc.activeElement;
    const summary = u.doc.querySelector('.souls-sum').textContent;
    if (outcome === 'success') u.resolve(0); else u.rosters[0].reject(new Error('superseded roster failure'));
    await tick();
    assertNoHandoff(u, tab);
    assert.equal(u.doc.activeElement, focused, 'late completion cannot restore focus to an older soul card');
    if (outcome === 'rejection') assert.equal(u.doc.querySelector('.souls-sum').textContent, summary, 'older rejection does not paint over the newer selection');
    else assert.equal(u.doc.querySelectorAll('.soul-card').length, 2, 'selection changes do NOT cancel roster population');
    // A later successful retry must not resurrect the obsolete pending handoff.
    u.poll(); u.resolve(1); await tick();
    assertNoHandoff(u, tab);
    assert.equal(u.doc.querySelector('#workspace-tab-souls .workspace-count').textContent, '2');
    for (const { path, body } of u.calls.filter(call => call.body)) {
      assert.equal(path.split('?')[0], '/api/capabilities');
      if (body.action === 'list') assert.deepEqual(body, { action: 'list', selector: {} });
      else assert.equal(body.action, 'inspect', 'no implicit launch/mutation');
    }
  });
}

for (const latest of ['soul', 'home']) for (const outcome of ['success', 'rejection']) {
  test(`latest ${latest} handoff survives a newer roster ticket and ignores older ${outcome}`, async t => {
    const u = await setup(t, { hold: true, beforeMount: () => handoff(latest === 'soul' ? 'home' : 'soul') });
    handoff(latest); u.poll();
    u.resolve(1); await tick();
    const expected = latest === 'soul' ? { soul: 'dev', agentsRoot: '/b/agents' } : { home: home.home };
    assert.deepEqual(u.inspections().map(call => call.body.selector), [expected], 'only the latest handoff consumes the current roster');
    assert.equal(u.doc.querySelector('.inspector-head h2').textContent, latest === 'soul' ? 'dev' : 'dev-seat');
    if (outcome === 'success') u.resolve(0, [{ ...soul(), name: 'stale-roster' }]); else u.rosters[0].reject(new Error('stale-roster failure'));
    await tick();
    assert.doesNotMatch(u.doc.querySelector('.souls').textContent, /stale-roster/);
    assert.deepEqual(u.inspections().map(call => call.body.selector), [expected]);
    assert.equal(u.doc.querySelector('.spawn-dialog'), null, 'Quick Open inspects, never launches');
    if (latest === 'soul') {
      assert.ok(u.doc.activeElement.classList.contains('inspector-back'), 'preselection opens the soul\'s page and focuses it');
      u.doc.querySelector('.workspace-soul-page .inspector-back').click();
      assert.equal(u.doc.activeElement.dataset.root, '/b/agents', 'back returns to the composite card, not its same-name twin');
      launchSoul(u.doc, u.doc.activeElement);
      assert.ok(u.doc.querySelector('.spawn-dialog'), 'Launch remains an explicit separate action');
      u.doc.querySelector('.fcancel').click();
      assert.equal(u.doc.querySelector('.soul-card.open').dataset.root, '/b/agents', 'same composite soul remains selected');
      assert.equal(u.doc.activeElement, u.doc.querySelector('.workspace-soul-page .spawn-act'), 'Launch cancellation returns to its page action');
    } else assert.match(u.doc.querySelector('.soul-inspector').textContent, /As spawned.*Captured instructions/s);
  });
}

// A handoff turns the page to Souls itself: that tab change is its own step, never a newer choice superseding it
// (Go to soul from the Machines tab turned the page and opened nothing).
for (const kind of ['soul', 'home']) test(`a ${kind} handoff made while another Workspace tab is shown turns the page to Souls and opens`, async t => {
  const u = await setup(t, { hold: true });
  u.resolve(0); await tick();
  u.tab('capabilities'); await tick();
  handoff(kind); await tick();
  assert.equal(u.selectedTab().id, 'workspace-tab-souls');
  const expected = kind === 'soul' ? { soul: 'dev', agentsRoot: '/b/agents' } : { home: home.home };
  assert.deepEqual(u.inspections().map(call => call.body.selector), [expected], 'the handoff opened what it carried');
  assert.equal(u.doc.querySelector('.inspector-head h2').textContent, kind === 'soul' ? 'dev' : 'dev-seat');
});

for (const kind of ['soul', 'home']) for (const boundary of ['workspace A → B → A', 'unmount/remount']) for (const outcome of ['success', 'rejection']) {
  test(`pending ${kind} dies across ${boundary}, including old roster ${outcome}`, async t => {
    const u = await setup(t, { hold: true });
    handoff(kind);
    if (boundary === 'unmount/remount') { spawn.unmount(); spawn.mount(u.doc.querySelector('#host'), u.ctx); }
    else { setWorkspace('/other'); setWorkspace('/team'); }
    u.resolve(u.rosters.length - 1); await tick();
    assertNoHandoff(u, 'souls');
    if (outcome === 'success') u.resolve(0, [{ ...soul(), name: 'stale-boundary' }]); else u.rosters[0].reject(new Error('stale-boundary failure'));
    if (boundary !== 'unmount/remount') u.resolve(1, [{ ...soul(), name: 'stale-boundary' }]);
    await tick();
    assertNoHandoff(u, 'souls');
    assert.doesNotMatch(u.doc.querySelector('.souls').textContent, /stale-boundary/);
  });
}

test('current roster rejection still reports failure and a current pending home can recover', async t => {
  const u = await setup(t, { hold: true, beforeMount: () => handoff('home') });
  u.rosters[0].reject(new Error('current roster unavailable')); await tick();
  // desktop/loading-states: a failed first read is the failed block in the grid (cause + Retry) and one announcement.
  assert.equal(u.doc.querySelector('.souls-grid .loading-failed-message').textContent, 'current roster unavailable');
  assert.equal(u.doc.querySelector('.souls-status').textContent, "Couldn't refresh souls. current roster unavailable");
  u.poll(); u.resolve(1); await tick();
  assert.deepEqual(u.inspections().map(call => call.body.selector), [{ home: home.home }]);
  assert.equal(u.doc.querySelector('.inspector-head h2').textContent, 'dev-seat');
});

test('F7: an instance\'s "Open soul" selects the exact roster soul it was spawned from (twins by agentsRoot are not confused); a miss is said', async t => {
  const u = await setup(t);
  spawn.preselectHome(home); await tick(); await tick();
  const open = u.doc.querySelector('.inspector-spawned button');
  assert.ok(open, 'the instance names its soul with Open soul');
  open.click(); await tick(); await tick();
  assert.deepEqual(u.inspections().at(-1).body.selector, { soul: 'dev', agentsRoot: '/b/agents' }, 'the /b twin, not /a');
  assert.equal(u.doc.querySelector('.workspace-soul-page').hidden, false, 'the soul opens as its page');
  assert.equal(u.doc.querySelector('.workspace-soul-page h2')?.textContent, 'dev');
  assert.equal(u.doc.querySelector('.soul-inspector h2')?.textContent, 'dev-seat', 'the instance keeps the sidebar beside it');
  // the roster no longer carries it: nothing opens, and the inspector says why
  spawn.preselectHome(home); await tick(); await tick();
  u.setAgents([soul()]); u.poll(); await tick(); await tick();
  const before = u.inspections().length;
  u.doc.querySelector('.inspector-spawned button').click(); await tick();
  assert.equal(u.inspections().length, before);
  assert.equal(u.doc.querySelector('.soul-inspector .inspector-status').textContent, "dev is not in this workspace's souls.");
});

/* ── preselectCapability: a capability's page by name, on the Capabilities subtab ─────────────────────── */
const CATALOG = { capabilitiesApi: 1, ...f2('capabilities').result };
const HOUSE = CATALOG.capabilities.find(row => row.name === 'nw-house-style');
const catalogRead = (capabilities = CATALOG) => ({ workspaceSyncApi: 1, status: 'ok', report: null, capabilities, reason: null });
const settle = async () => { for (let i = 0; i < 4; i++) await tick(); };
const capabilityPage = u => u.doc.querySelector('.capability-page');
const showsAsked = u => u.calls.filter(call => call.path.startsWith('/api/capabilities') && call.body?.action === 'show').map(call => call.body.capability);
/** A setup whose catalog reads are held: `reads[i].resolve(answer)` lands the i-th. */
async function heldCatalog(t, options = {}) {
  const reads = [];
  const u = await setup(t, { ...options, catalog: () => { const read = deferred(); reads.push(read); return read.promise; } });
  await settle();
  return { ...u, reads, land: async (index, answer = catalogRead()) => { reads[index].resolve(answer); await settle(); } };
}

test('preselectCapability opens the one catalog row of that name, on the Capabilities subtab; launching nothing', async t => {
  assert.equal(HOUSE.kind, 'member');
  const u = await setup(t, { catalog: () => catalogRead() }); await settle();
  assert.equal(u.selectedTab().id, 'workspace-tab-souls');
  const misses = [];
  spawn.preselectCapability('nw-house-style', { onMiss: count => misses.push(count) }); await settle();
  assert.equal(u.selectedTab().id, 'workspace-tab-capabilities');
  assert.equal(capabilityPage(u)?.dataset.capability, 'nw-house-style');
  assert.equal(u.doc.querySelector('.workspace-cap-page').hidden, false);
  assert.deepEqual(capabilityPage(u).querySelector('.page-crumbs').textContent.includes('Capabilities'), true, 'as its table row opens it: Back returns to the list');
  assert.deepEqual(showsAsked(u), [{ name: 'nw-house-style', kind: 'member', repoKey: HOUSE.repoKey }], "the row's own selector");
  assert.ok(u.doc.activeElement.classList.contains('page-back'), 'focus moves into the page');
  assert.deepEqual(misses, []);
  assert.equal(u.doc.querySelector('.spawn-dialog'), null);
  // Consumed once: a later catalog read opens nothing again after Back.
  capabilityPage(u).querySelector('.page-back').click(); await settle();
  assert.equal(capabilityPage(u), null);
  const reads = () => u.calls.filter(call => call.path.startsWith('/api/workspace-sync')).length, before = reads();
  u.poll(); await u.cliEmit(); await settle();
  assert.equal(reads(), before + 1, 'the catalog was read again');
  assert.equal(capabilityPage(u), null);
  // Already on the tab with the catalog held: on the spot, replacing the page that was open.
  spawn.preselectCapability('nw-house-style');
  assert.equal(capabilityPage(u)?.dataset.capability, 'nw-house-style', 'applied synchronously');
  spawn.preselectCapability('oats.core');
  assert.equal(capabilityPage(u).dataset.capability, 'oats.core');
  assert.equal(u.doc.querySelectorAll('.capability-page').length, 1);
});

test('preselectCapability: no row or several rows of that name open nothing and say so through onMiss', async t => {
  // Two capabilities of one name (a member's and a package's): a bare name must not pick one.
  const twins = structuredClone(CATALOG);
  twins.capabilities.push({ ...twins.capabilities.find(row => row.kind === 'package'), name: 'nw-house-style' });
  const u = await setup(t, { catalog: () => catalogRead(twins) }); await settle();
  const misses = [];
  const onMiss = count => misses.push(count);
  spawn.preselectCapability('nw-not-here', { onMiss }); await settle();
  assert.deepEqual(misses, [0]);
  assert.equal(capabilityPage(u), null);
  assert.equal(u.selectedTab().id, 'workspace-tab-capabilities', 'the list it was looked for in');
  // A miss is consumed: a later catalog read neither resurrects it nor reports it again.
  const reads = () => u.calls.filter(call => call.path.startsWith('/api/workspace-sync')).length, before = reads();
  u.poll(); await u.cliEmit(); await settle();
  assert.equal(reads(), before + 1, 'the catalog was read again');
  assert.equal(capabilityPage(u), null); assert.deepEqual(misses, [0]);
  spawn.preselectCapability('nw-house-style', { onMiss }); await settle();
  assert.deepEqual(misses, [0, 2], 'ambiguous');
  assert.equal(capabilityPage(u), null);
  // Exact names only: no prefix, no case folding, no trimming.
  for (const name of ['nw-house', 'NW-HOUSE-STYLE', ' nw-lint', 'nw-lint ']) spawn.preselectCapability(name, { onMiss });
  assert.deepEqual(misses, [0, 2, 0, 0, 0, 0]);
  // Not a name at all: nothing is held, nothing is said.
  for (const name of [undefined, null, '', 7, {}]) spawn.preselectCapability(name, { onMiss });
  assert.deepEqual(misses, [0, 2, 0, 0, 0, 0]);
  assert.deepEqual(showsAsked(u), []);
  spawn.preselectCapability('nw-lint', { onMiss }); await settle();
  assert.equal(capabilityPage(u)?.dataset.capability, 'nw-lint', 'the one row of its name still opens');
});

test('preselectCapability stays pending until the catalog of the current workspace lands; its tab is selected at once', async t => {
  const u = await heldCatalog(t);
  const misses = [];
  spawn.preselectCapability('nw-house-style', { onMiss: count => misses.push(count) }); await settle();
  assert.equal(u.selectedTab().id, 'workspace-tab-capabilities', 'the subtab, before the catalog is read');
  assert.equal(capabilityPage(u), null); assert.deepEqual(misses, []);
  u.poll(); await settle(); // a roster poll while it waits changes nothing
  assert.equal(capabilityPage(u), null);
  await u.land(0);
  assert.equal(capabilityPage(u)?.dataset.capability, 'nw-house-style');
  assert.deepEqual(misses, []);
});

test('preselectCapability made before the mount applies when the view mounts and its catalog is read', async t => {
  const misses = [];
  const u = await heldCatalog(t, { beforeMount: () => spawn.preselectCapability('nw-house-style', { onMiss: count => misses.push(count) }) });
  assert.equal(u.selectedTab().id, 'workspace-tab-capabilities');
  assert.equal(capabilityPage(u), null);
  await u.land(0);
  assert.equal(capabilityPage(u)?.dataset.capability, 'nw-house-style');
  assert.deepEqual(misses, []);
});

test('a pending preselectCapability survives a failed catalog read and opens when a retry lands', async t => {
  const u = await heldCatalog(t);
  const misses = [];
  spawn.preselectCapability('nw-house-style', { onMiss: count => misses.push(count) }); await settle();
  await u.land(0, { workspaceSyncApi: 1, status: 'unavailable', reason: { code: 'E_CLI_TIMEOUT', message: 'The workspace command exceeded its time limit.' } });
  assert.equal(capabilityPage(u), null); assert.deepEqual(misses, [], 'not a miss: the list was not read');
  const retry = [...u.doc.querySelectorAll('.workspace-discovery button')].find(control => control.textContent === 'Retry');
  assert.ok(retry, 'the failed catalog offers Retry');
  retry.click(); await settle(); await u.land(1);
  assert.equal(capabilityPage(u)?.dataset.capability, 'nw-house-style');
});

const newer = [
  ['click Sources', u => u.tab('sources'), 'sources', null],
  ['click current Capabilities', u => u.tab('capabilities'), 'capabilities', null],
  ['keyboard Souls', u => u.key('Home'), 'souls', null],
  ['footer Souls', () => spawn.preselectWorkspaceTab('souls'), 'souls', null],
  ['a soul handoff', () => spawn.preselectSoul(soul('/b/agents')), 'souls', null],
  ['a home handoff', () => spawn.preselectHome(home), 'souls', null],
  ['another capability handoff', () => spawn.preselectCapability('oats.core'), 'capabilities', 'oats.core'],
];
for (const [label, choose, tab, opens] of newer) test(`a pending preselectCapability loses to ${label}`, async t => {
  const u = await heldCatalog(t);
  const misses = [];
  spawn.preselectCapability('nw-house-style', { onMiss: count => misses.push(count) }); await settle();
  choose(u); await settle();
  await u.land(0);
  assert.equal(u.selectedTab().id, `workspace-tab-${tab}`);
  assert.equal(capabilityPage(u)?.dataset.capability ?? null, opens, 'the superseded capability never opens');
  assert.deepEqual(misses, [], 'a superseded handoff is not a miss');
  // Nor on a later read of the roster or of the catalog.
  u.poll(); await u.cliEmit(); await settle(); u.reads.at(-1).resolve(catalogRead()); await settle();
  assert.equal(u.reads.length, 2, 'the catalog was read again');
  assert.equal(capabilityPage(u)?.dataset.capability ?? null, opens);
  assert.deepEqual(showsAsked(u).map(capability => capability.name), opens ? [opens] : []);
});

for (const boundary of ['workspace A → B → A', 'unmount/remount']) test(`a pending preselectCapability dies across ${boundary}`, async t => {
  const u = await heldCatalog(t);
  const misses = [];
  spawn.preselectCapability('nw-house-style', { onMiss: count => misses.push(count) }); await settle();
  if (boundary === 'unmount/remount') { spawn.unmount(); spawn.mount(u.doc.querySelector('#host'), u.ctx); }
  else { setWorkspace('/other'); setWorkspace('/team'); }
  await settle();
  for (const read of u.reads) read.resolve(catalogRead());
  await settle();
  assert.equal(capabilityPage(u), null, "another workspace's (or a past view's) handoff never opens");
  assert.deepEqual(misses, []); assert.deepEqual(showsAsked(u), []);
  u.poll(); await settle();
  assert.equal(capabilityPage(u), null);
});

test('preselectCapability from an open soul page closes it and opens the capability', async t => {
  const u = await setup(t, { catalog: () => catalogRead() }); await settle();
  spawn.preselectSoul(soul('/b/agents')); await settle();
  assert.equal(u.doc.querySelector('.workspace-soul-page').hidden, false);
  spawn.preselectCapability('nw-house-style'); await settle();
  assert.equal(u.doc.querySelector('.workspace-soul-page').hidden, true);
  assert.equal(u.doc.querySelector('.workspace-cap-page').hidden, false);
  assert.equal(capabilityPage(u).dataset.capability, 'nw-house-style');
  // Back returns to the Capabilities list, where the row is.
  capabilityPage(u).querySelector('.page-back').click(); await settle();
  assert.equal(u.selectedTab().id, 'workspace-tab-capabilities');
  assert.equal(u.doc.querySelector('.workspace-discovery').hidden, false);
});

// The Graph's Open soul (slice 6b, views/graph.mjs soulHandoff) hands the soul an agent was spawned from by its key
// and its source's repoKey: a soul of the same name that replaced it is not that soul, and nothing opens.
test('a keyed soul handoff opens only the exact soul: a same-named replacement is a miss', async t => {
  const u = await setup(t);
  u.setAgents([{ ...soul('/b/agents'), key: 'new-key', soulSource: { repoKey: 'github.com/acme/new' } }]);
  u.poll(); await settle();
  const misses = [];
  spawn.preselectSoul({ name: 'dev', agentsRoot: '/b/agents', key: 'old-key', repoKey: 'github.com/acme/old', onMiss: count => misses.push(count) }); await settle();
  assert.deepEqual(misses, [0], 'the replacement is not the recorded soul');
  assert.equal(u.doc.querySelector('.workspace-soul-page').hidden, true, 'no soul page opened');
  spawn.preselectSoul({ name: 'dev', agentsRoot: '/b/agents', key: 'new-key', repoKey: 'github.com/acme/new', onMiss: count => misses.push(count) }); await settle();
  assert.deepEqual(misses, [0]); assert.equal(u.doc.querySelector('.workspace-soul-page').hidden, false, 'the exact soul opens');
});
