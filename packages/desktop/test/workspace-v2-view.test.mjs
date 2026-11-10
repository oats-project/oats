// The v2 Workspace view (F2, no package approval; F7 sections/Setup): the
// Capabilities sections from `oats capabilities` (Workspace owned with team/repo
// dropdowns, Packages, Repo owned behind capabilities-private), Setup (graph + lists)
// from `oats workspace status`, and Sync. Fixtures captured from main's kernel (packages-no-approval);
// the shipped Workspace stage is mounted in jsdom with a
// fixture ctx.api. No CLI, server, GUI or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import * as spawn from '../renderer/views/spawn.mjs';
import { currentWorkspace, setWorkspace } from '../renderer/views/common.mjs';
import { refreshCli } from '../renderer/views/cli-status.mjs';
import { workspaceStatusData, deploymentStatusData, syncData } from '../../client/deployment-data.mjs';
import { repoChoices } from '../renderer/workspace-catalog.mjs';
import { capabilityUse, memberNames, capabilitySections, hostKeyOf } from '../../client/capability-rows.mjs';
import { iconElement } from '../renderer/shell-icons.mjs';
import { syncStateText } from '../renderer/workspace-sync-view.mjs';
import { runInNewContext } from 'node:vm';
import { workspaceGeneration } from '../renderer/views/common.mjs';
import { createSelectionOwnership } from '../renderer/selection-ownership.mjs';
import { notePanel, resetViewDeployments } from '../renderer/view-deployments.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 4; i++) await tick(); };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const f2 = name => JSON.parse(readFileSync(new URL(`./fixtures/workspace-v2/f2/${name}.json`, import.meta.url), 'utf8'));
const dir = '/fixture/base/northwind-workspace';
const CLI = { ...f2('version'), ok: true, bin: '/fixture/bin/oats', operationsApi: 1, relations: true };
const APPROVAL_TEXT = /approv/i;
const fx = name => name.includes('/') ? JSON.parse(readFileSync(new URL(`./fixtures/workspace-v2/${name}.json`, import.meta.url), 'utf8')) : f2(name);
const statusOf = name => workspaceStatusData(fx(name), dir);
const roster = deploymentStatusData(f2('status'), dir);
const instances = roster.agents.flatMap(agent => agent.instances.map(i => ({ ...i, agent: i.agent || agent.name, agentsRoot: roster.root })));
const catalog = name => ({ workspaceSyncApi: 1, status: 'ok', report: null, capabilities: { capabilitiesApi: 1, ...fx(name).result }, reason: null });
const report = (name, status) => ({ workspaceSyncApi: 1, status, report: syncData(f2(name), dir), capabilities: null, reason: null });

async function setup(t, { status = 'workspace-status', cli = CLI, sync, teams, members, workspace = {}, deployment, beforeMount, openView } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'http://localhost' });
  const previous = { document: globalThis.document, window: globalThis.window, setInterval: globalThis.setInterval, ws: currentWorkspace() };
  const polls = [];
  globalThis.document = dom.window.document; globalThis.window = dom.window; globalThis.setInterval = fn => { polls.push(fn); return 0; };
  const calls = [];
  let observedStatus = typeof status === 'string' ? statusOf(status) : status;
  const panel = () => ({ workspace: { id: currentWorkspace(), scope: currentWorkspace(), ...workspace }, workspaces: [], instances,
    deployment: deployment ?? { status: 'observed', root: roster.root, workspace: observedStatus.workspace, workspaceStatus: observedStatus, reachable: { reachable: true }, withheld: [] } });
  const ctx = { hasWorkspaceSwitcher: true, api: async (path, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined; calls.push({ path, body });
    if (path === '/api/cli') return cli;
    if (path.startsWith('/api/agents')) return { agents: roster.agents.map(({ instances: _i, ...soul }) => ({ ...soul, agentsRoot: roster.root })) };
    if (path.startsWith('/api/panel')) return panel();
    if (path.startsWith('/api/workspace-sync')) return sync ? sync(body, calls) : catalog('capabilities');
    if (teams && path.startsWith('/api/workspace-teams')) return teams(body, calls);
    if (members && path.startsWith('/api/team-members')) return members();
    if (path.startsWith('/api/servers')) return { servers: [] };
    throw new Error(`Unexpected fixture API request: ${path}`);
  }, ...(openView ? { openView } : {}) };
  t.after(() => { spawn.unmount(); setWorkspace(previous.ws); globalThis.document = previous.document; globalThis.window = previous.window; globalThis.setInterval = previous.setInterval; dom.window.close(); });
  setWorkspace('/team');
  await refreshCli({ api: async () => cli });
  beforeMount?.(); // a handoff made before the view exists (the shell preselects, then shows the stage)
  spawn.mount(dom.window.document.querySelector('#host'), ctx); await settle();
  const doc = dom.window.document;
  return { doc, dom, calls, ctx,
    tab: async name => { doc.getElementById(`workspace-tab-${name}`).click(); await settle(); },
    rows: () => [...doc.querySelectorAll('.catalog-table .catalog-row:not(.head)')],
    owned: () => [...doc.querySelectorAll('[data-section=workspace] .catalog-row:not(.head)')].map(el => el.dataset.capability),
    button: text => [...doc.querySelectorAll('button')].find(el => el.textContent.trim() === text),
    syncCalls: () => calls.filter(call => call.path.startsWith('/api/workspace-sync')).map(call => call.body),
    setStatus: name => { observedStatus = statusOf(name); },
    // The roster poll, answered by a newer observation of the same workspace status.
    poll: async observedAt => { observedStatus = { ...observedStatus, workspace: { ...observedStatus.workspace, observedAt } }; for (const fn of polls) fn(); await settle(); },
  };
}

test('Capabilities is the kernel catalog: counts, jump pills, and Capability | Used by in v2 terms (the source in the group heading and the accessible name)', async t => {
  const u = await setup(t);
  // Workspace v4: the tab bar counts capabilities, so the catalog is read once on mount (any tab).
  assert.deepEqual(u.syncCalls(), [{ action: 'read' }], 'exactly one read; never a sync');
  await u.tab('capabilities');
  assert.deepEqual(u.syncCalls(), [{ action: 'read' }], 'opening the tab does not read again');
  assert.equal(u.doc.querySelector('#workspace-tab-capabilities .workspace-count').textContent, '10');
  // Workspace v4.1: the section jump is one segmented group (navigation: aria-current); each capability is a row card under a column head.
  assert.deepEqual([...u.doc.querySelectorAll('.capability-nav button')].map(el => [el.dataset.jump, el.textContent, el.getAttribute('aria-current')]),
    [['workspace', 'Workspace owned6', 'true'], ['packages', 'Packages4', null]]);
  assert.deepEqual([...u.doc.querySelectorAll('[data-section=workspace] .catalog-head span')].map(el => el.textContent), ['', 'Capability', 'Used by', '']);
  assert.equal(u.rows().length, 10);
  const row = name => u.rows().find(el => el.dataset.capability === name);
  // Source: no column (the group heading names it); the card's accessible name still says it — the package and
  // its pinned version, or the member repository at its latest.
  assert.equal(u.doc.querySelector('[data-section] .catalog-row .source-chip, .catalog-source'), null, 'no Source cell');
  assert.equal(row('oats.okf').getAttribute('aria-label'), 'oats.okf, capability, from oats.okf 2.1.3');
  assert.equal(row('nw-brand-voice').getAttribute('aria-label'), 'nw-brand-voice, capability, from marketing latest');
  assert.doesNotMatch(u.doc.querySelector('.workspace-discovery').textContent, APPROVAL_TEXT);
  // Used by = souls whose instances record the module (roster module rows).
  const used = capabilityUse(instances, 'nw-release-tooling');
  assert.deepEqual(used.souls.map(s => s.name), ['release-manager']);
  assert.equal(row('nw-release-tooling').querySelector('.catalog-used-count').textContent, '1 soul');
  assert.equal(row('nw-release-tooling').querySelector('.catalog-used-count').title, 'Used by release-manager');
  assert.equal(row('nw-brand-voice').querySelector('.catalog-used-count').textContent, 'Not used', 'never a lone dash');
  assert.equal(u.doc.querySelector('.workspace-discovery').textContent.includes('Members'), false, 'no Members list in Capabilities');
});

// Human, 2026-10-07: Workspace owned is split by repository, and group pills replace the Team and
// Repo dropdowns (the Team one was dead: kernel capability rows carry no team).
test('repository pills choose one Workspace owned group (single choice, All by default), name only what it holds, and count truthfully with the search', async t => {
  const u = await setup(t);
  await u.tab('capabilities');
  const status = statusOf('workspace-status');
  const choices = repoChoices(capabilitySections(f2('capabilities').result.capabilities).workspace, memberNames(status), hostKeyOf(status));
  assert.deepEqual(choices.map(c => [c.label, c.count]), [['agents', 2], ['data', 1], ['marketing', 2], ['nw-tools', 1]], 'repositories (the host first), never packages');
  const pills = () => [...u.doc.querySelectorAll('[data-section=workspace] .capability-section-head .catalog-pills button')];
  const group = u.doc.querySelector('.catalog-pills');
  assert.equal(group.getAttribute('role'), 'group'); assert.equal(group.getAttribute('aria-label'), 'Show capabilities from');
  assert.deepEqual(pills().map(b => [b.textContent, b.getAttribute('aria-pressed'), b.tabIndex]),
    [['All 6', 'true', 0], ['agents 2', 'false', -1], ['data 1', 'false', -1], ['marketing 2', 'false', -1], ['nw-tools 1', 'false', -1]], 'All by default, the one tab stop');
  assert.equal(u.doc.querySelector('.workspace-discovery select'), null, 'no dropdowns');
  assert.equal(u.doc.querySelector('.catalog-shown'), null, 'nothing narrowed yet');
  pills()[3].focus(); pills()[3].click(); await settle();
  assert.deepEqual(u.owned(), ['nw-brand-voice', 'nw-campaign-metrics']);
  assert.equal(u.doc.querySelector('.catalog-shown').textContent, '2 of 6 shown');
  assert.deepEqual(pills().map(b => b.getAttribute('aria-pressed')), ['false', 'false', 'false', 'true', 'false']);
  assert.equal(u.doc.querySelectorAll('[data-section=packages] .catalog-row:not(.head)').length, 4, 'Packages are not narrowed');
  assert.equal(u.doc.activeElement, pills()[3], 'focus stays on the chosen pill across the re-render');
  assert.equal(pills()[3].tabIndex, 0);
  assert.deepEqual([...u.doc.querySelectorAll('[data-section=workspace] .catalog-group')].map(h => h.dataset.repo), ['member:local//fixture/base/fx/remotes/marketing.git'], 'only that group');
  // The search narrows within the choice; the count says what is on screen, the pills keep their totals.
  const search = u.doc.querySelector('.ws-toolbar[data-tools=capabilities] input');
  search.value = 'brand'; search.dispatchEvent(new u.dom.window.Event('input', { bubbles: true })); await settle();
  assert.deepEqual(u.owned(), ['nw-brand-voice']);
  assert.equal(u.doc.querySelector('.catalog-shown').textContent, '1 of 6 shown');
  assert.deepEqual(pills().map(b => b.textContent), ['All 6', 'agents 2', 'data 1', 'marketing 2', 'nw-tools 1']);
  pills()[0].click(); await settle();
  assert.deepEqual(u.owned(), ['nw-brand-voice']); assert.equal(u.doc.querySelector('.catalog-shown').textContent, '1 of 6 shown', 'a search alone still narrows');
  search.value = ''; search.dispatchEvent(new u.dom.window.Event('input', { bubbles: true })); await settle();
  assert.equal(u.owned().length, 6);
  assert.equal(u.doc.querySelector('.catalog-shown'), null);
  assert.deepEqual(u.syncCalls(), [{ action: 'read' }], 'choosing is local');
});

test('a remembered repository the catalog no longer offers falls back to All; a focused pill keeps focus across a repaint', async t => {
  let rows = f2('capabilities').result.capabilities;
  const reply = () => ({ workspaceSyncApi: 1, status: 'ok', report: null, reason: null, capabilities: { capabilitiesApi: 1, ...f2('capabilities').result, capabilities: rows } });
  const u = await setup(t, { sync: body => body.action === 'sync' ? report('sync-current', 'ok') : reply() });
  await u.tab('capabilities');
  const pills = () => [...u.doc.querySelectorAll('.catalog-pills button')];
  const marketing = () => pills().find(b => b.dataset.repo.endsWith('marketing.git'));
  marketing().click(); await settle();
  // Arrow keys move focus along the group (not the choice); the focused pill becomes the one tab stop.
  marketing().focus(); marketing().dispatchEvent(new u.dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
  assert.equal(u.doc.activeElement.dataset.repo, 'member:local//fixture/base/fx/remotes/data.git');
  assert.equal(marketing().getAttribute('aria-pressed'), 'true', 'moving is not choosing');
  // The catalog changes (a sync re-reads it): the pills are rebuilt and the same repository keeps focus.
  rows = rows.filter(r => r.name !== 'nw-house-style');
  u.doc.querySelector('.ws-sync button.ws-sync-run').click(); await settle();
  assert.deepEqual(pills().map(b => b.textContent), ['All 5', 'agents 1', 'data 1', 'marketing 2', 'nw-tools 1']);
  assert.equal(u.doc.activeElement, pills()[2], 'focus survives the repaint on the same repository');
  assert.deepEqual(pills().map(b => b.tabIndex), [-1, -1, 0, -1, -1]);
  // The chosen repository disappears from the catalog: All again, every row shown.
  rows = rows.filter(r => !String(r.repoKey).endsWith('marketing.git'));
  u.doc.querySelector('.ws-sync button.ws-sync-run').click(); await settle();
  assert.deepEqual(pills().map(b => [b.textContent, b.getAttribute('aria-pressed')]), [['All 3', 'true'], ['agents 1', 'false'], ['data 1', 'false'], ['nw-tools 1', 'false']]);
  assert.deepEqual(u.owned(), ['nw-release-tooling', 'nw-warehouse-access', 'nw-tools-dev']);
  assert.equal(u.doc.querySelector('.catalog-shown'), null);
  // No workspace-owned capability at all: no pills.
  rows = rows.filter(r => r.kind === 'package');
  u.doc.querySelector('.ws-sync button.ws-sync-run').click(); await settle();
  assert.equal(u.doc.querySelector('.catalog-pills'), null);
  assert.match(u.doc.querySelector('[data-section=workspace] .catalog-empty').textContent, /No workspace repository offers a capability yet/);
});

test('Workspace owned is split by repository, headed as on the Souls tab: the host first, then by name', async t => {
  const u = await setup(t);
  await u.tab('capabilities');
  const heads = [...u.doc.querySelectorAll('[data-section=workspace] .catalog-group')];
  assert.deepEqual(heads.map(h => [h.tagName, h.querySelector('svg').getAttribute('data-icon'), h.querySelector('.souls-group-name').textContent, h.querySelector('.souls-group-note').textContent]), [
    ['H3', 'repo', 'agents', 'member repo · host · 2 capabilities'], ['H3', 'repo', 'data', 'member repo · 1 capability'],
    ['H3', 'repo', 'marketing', 'member repo · 2 capabilities'], ['H3', 'repo', 'nw-tools', 'member repo · 1 capability']]);
  assert.deepEqual(u.owned(), ['nw-house-style', 'nw-release-tooling', 'nw-warehouse-access', 'nw-brand-voice', 'nw-campaign-metrics', 'nw-tools-dev'], 'the rows under their heading');
  assert.equal(heads[0].nextElementSibling.dataset.capability, 'nw-house-style');
  // A search that empties a group hides its heading.
  const search = u.doc.querySelector('.ws-toolbar[data-tools=capabilities] input');
  search.value = 'warehouse'; search.dispatchEvent(new u.dom.window.Event('input', { bubbles: true })); await settle();
  assert.deepEqual([...u.doc.querySelectorAll('[data-section=workspace] .catalog-group .souls-group-name')].map(el => el.textContent), ['data']);
});

// Workspace defaults (product owner, 2026-10-23): the Capabilities tab opens with what the workspace gives every
// soul (status.defaults), never narrowed by the search; its "i" is built once, sits in the toolbar's lead (the section
// jump is All capabilities' own, under its title) and survives every repaint; leaving the tab closes its dialog without
// moving focus. Souls has its own "i".
test('Capabilities: Workspace defaults first, the "i" in the toolbar across repaints, its dialog closes with the tab', async t => {
  const defaults = { slots: { knowledge: { name: 'oats.okf', from: 'package' }, messaging: 'none', tasks: null }, capabilities: [] };
  const u = await setup(t, { status: { ...statusOf('workspace-status'), defaults } });
  await u.tab('capabilities');
  const lead = u.doc.querySelector('.ws-toolbar[data-tools=capabilities] .ws-toolbar-lead');
  const info = lead.querySelector('.ws-info-button');
  assert.deepEqual([...lead.children].map(el => el.className), ['ws-info-button'], 'the toolbar\'s lead: the "i" alone');
  assert.equal(info.getAttribute('aria-label'), 'About capabilities');
  assert.deepEqual([...u.doc.querySelectorAll('.capability-nav button')].map(el => el.dataset.jump), ['workspace', 'packages'], 'no Defaults segment');
  assert.equal(u.doc.querySelector('.capability-nav').closest('.capability-part').querySelector(':scope > h2').textContent, 'All capabilities');
  assert.equal(u.doc.querySelector('.capability-section').dataset.section, 'defaults');
  const slot = u.doc.querySelector('.ws-default-cell[data-slot=knowledge]');
  assert.equal(slot.getAttribute('aria-label'), 'Knowledge: oats.okf, the workspace default — open its page');
  // A repaint (a search) keeps the same "i", focused, and never narrows the defaults.
  info.focus();
  const search = u.doc.querySelector('.ws-toolbar[data-tools=capabilities] input');
  search.value = 'no-such'; search.dispatchEvent(new u.dom.window.Event('input', { bubbles: true })); await settle();
  assert.equal(lead.querySelector('.ws-info-button'), info, 'the same element'); assert.equal(u.doc.activeElement, info, 'focus stays on it');
  assert.equal(lead.lastElementChild, info, 'still the lead\'s');
  assert.equal(u.doc.querySelectorAll('[data-group=core] .ws-default-cell').length, 3, 'the search does not narrow the defaults');
  // A focused default column keeps focus across a repaint (its data-focus-key).
  u.doc.querySelector('.ws-default-cell[data-slot=knowledge]').focus();
  search.value = 'okf'; search.dispatchEvent(new u.dom.window.Event('input', { bubbles: true })); await settle();
  assert.equal(u.doc.activeElement?.dataset.focusKey, 'defaults:knowledge');
  // The dialog: open, then leave the tab: it closes and focus is not moved.
  info.click();
  assert.ok(u.doc.querySelector('.about-dialog')); assert.equal(u.doc.activeElement.textContent, 'Close');
  await u.tab('souls');
  assert.equal(u.doc.querySelector('.about-dialog'), null, 'leaving Capabilities closes it');
  assert.notEqual(u.doc.activeElement, info, 'no focus return: the person moved on');
  // Souls: its own "i" at the end of its toolbar row.
  const souls = u.doc.querySelector('.souls-bar .ws-info-button');
  assert.equal(souls.getAttribute('aria-label'), 'About souls'); assert.equal(souls.previousElementSibling.classList.contains('souls-group-by'), true);
  souls.click(); assert.ok(u.doc.querySelector('.about-dialog'));
  await u.tab('capabilities');
  assert.equal(u.doc.querySelector('.about-dialog'), null, 'leaving Souls closes its dialog');
});

// Back from a capability page lands on the control that opened it: a default (by its focus key) even when the search
// hides that capability's catalog row; a catalog row, never a default that carries the same name.
test('Capabilities: Back returns to the default that opened the page, filtered or not; a catalog row\'s Back skips its defaults', async t => {
  const defaults = { slots: { knowledge: { name: 'oats.okf', from: 'package' }, messaging: 'none', tasks: null },
    capabilities: [{ name: 'oats.core', from: 'package', off: false }, { name: 'nw-house-style', from: null, off: true }] };
  const u = await setup(t, { status: { ...statusOf('workspace-status'), defaults } });
  await u.tab('capabilities');
  const q = sel => u.doc.querySelector(sel);
  const back = async how => {
    const page = q('.workspace-cap-page'); assert.equal(page.hidden, false, 'the page is open');
    const control = page.querySelector('.page-back');
    if (how === 'escape') control.dispatchEvent(new u.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); else control.click();
    await settle();
  };
  const search = q('.ws-toolbar[data-tools=capabilities] input');
  const find = text => { search.value = text; search.dispatchEvent(new u.dom.window.Event('input', { bubbles: true })); return settle(); };
  await find('nw-');
  assert.equal(u.rows().some(row => row.dataset.capability === 'oats.okf'), false, 'the search hides oats.okf\'s row');
  const slot = q('.ws-default-cell[data-slot=knowledge]'); slot.focus(); slot.click(); await settle();
  await back('click');
  assert.equal(u.doc.activeElement?.dataset.focusKey, 'defaults:knowledge', 'Back lands on the Knowledge default');
  const chip = q('[data-group=additional] button.ws-default-cell'); chip.focus(); chip.click(); await settle();
  await back('escape');
  assert.equal(u.doc.activeElement?.dataset.focusKey, 'defaults:cap:oats.core', 'Escape too, on the chip');
  await find('');
  for (const name of ['oats.core', 'nw-house-style']) {
    const row = u.rows().find(el => el.dataset.capability === name); row.focus(); row.click(); await settle();
    await back('click');
    assert.equal(u.doc.activeElement, u.rows().find(el => el.dataset.capability === name), `${name}: Back lands on its catalog row`);
  }
});

// A package default the catalog does not list yet names no package (its id is not its package's). Its page, once open,
// follows a catalog refresh that lists it: the one package row of that name (spawn.mjs contentsRow).
test('Capabilities: the page of an unlisted package default follows a catalog read that lists it', async t => {
  const full = catalog('capabilities');
  const without = { ...full, capabilities: { ...full.capabilities, capabilities: full.capabilities.capabilities.filter(c => c.name !== 'oats.okf') } };
  let reads = 0;
  const defaults = { slots: { knowledge: { name: 'oats.okf', from: 'package' }, messaging: 'none', tasks: null }, capabilities: [] };
  const u = await setup(t, { status: { ...statusOf('workspace-status'), defaults }, sync: () => (reads++ ? full : without) });
  await u.tab('capabilities');
  const slot = u.doc.querySelector('.ws-default-cell[data-slot=knowledge]');
  assert.equal(slot.querySelector('.source-chip-name').textContent, 'package', 'unlisted: the kind alone');
  slot.focus(); slot.click(); await settle();
  const page = u.doc.querySelector('.workspace-cap-page');
  assert.equal(page.hidden, false);
  assert.equal(page.textContent.includes('2.1.3'), false, 'no version while the catalog does not list it');
  // A CLI change re-reads the catalog, which now lists oats.okf in its package: the open page follows, in place.
  await refreshCli({ api: async () => ({ ...CLI, version: `${CLI.version}-later` }) }); await settle();
  assert.ok(reads >= 2, 'the catalog was read again');
  assert.equal(page.hidden, false, 'the page stays open');
  assert.ok(page.textContent.includes('2.1.3'), 'the listed package row\'s facts');
  // Only a package row of that name, and only one: contentsRow never guesses.
  const rows = full.capabilities.capabilities;
  assert.equal(spawn.contentsRow({ name: 'oats.okf', kind: 'package' }, null, rows).package, 'oats.okf');
  assert.equal(spawn.contentsRow({ name: 'nw-house-style', kind: 'package' }, null, rows), null, 'a member row of that name is not it');
  assert.equal(spawn.contentsRow({ name: 'oats.okf', kind: 'package' }, null, [...rows, { ...rows.find(r => r.name === 'oats.okf'), package: 'other.pkg' }]), null, 'two packages: ambiguous, none');
});

// A default keeps its declaration's focus key wherever the panel draws it: a catalog refresh that moves a focused named
// default from Additional into its Core cell keeps focus on it, and of two same-name declarations (the slot's, from one
// repository; a named one, from another) Back returns to the one that opened the page.
test('Capabilities: focus follows a default\'s declaration across a catalog refresh that moves it from Additional to Core', async t => {
  const AGENTS = 'local//fixture/base/fx/remotes/agents.git';
  const full = catalog('capabilities'), base = full.capabilities.capabilities;
  const chat = repoKey => ({ ...base.find(c => c.name === 'nw-house-style'), name: 'nw-chat', repoKey, origin: `member ${repoKey}`, layer: 'messaging', path: 'capabilities/nw-chat' });
  const withRows = rows => ({ ...full, capabilities: { ...full.capabilities, capabilities: rows } });
  // The first read does not list nw-chat; the next one lists it with layer messaging.
  let reads = 0;
  {
    const defaults = { slots: { knowledge: null, messaging: null, tasks: null }, capabilities: [{ name: 'nw-chat', from: 'here', off: false }] };
    const u = await setup(t, { status: { ...statusOf('workspace-status'), defaults }, sync: () => (reads++ ? withRows([...base, chat(AGENTS)]) : full) });
    await u.tab('capabilities');
    const additional = u.doc.querySelector('[data-group=additional] button.ws-default-cell');
    assert.equal(additional.dataset.defaultCapability, 'nw-chat'); additional.focus();
    await refreshCli({ api: async () => ({ ...CLI, version: `${CLI.version}-later` }) }); await settle();
    assert.ok(reads >= 2, 'the catalog was read again');
    const messaging = u.doc.querySelector('.ws-default-cell[data-slot=messaging]');
    assert.equal(messaging.querySelector('.ws-default-name').textContent, 'nw-chat', 'now in its Core cell');
    assert.equal(u.doc.activeElement, messaging, 'focus followed it');
    assert.equal(u.doc.querySelector('[data-group=additional] .ws-default-cell'), null);
  }
});
test('Capabilities: Back from the second of two same-name defaults returns to it, not to the first', async t => {
  const AGENTS = 'local//fixture/base/fx/remotes/agents.git', MARKETING = 'local//fixture/base/fx/remotes/marketing.git';
  const full = catalog('capabilities'), base = full.capabilities.capabilities;
  const chat = repoKey => ({ ...base.find(c => c.name === 'nw-house-style'), name: 'nw-chat', repoKey, origin: `member ${repoKey}`, layer: 'messaging', path: 'capabilities/nw-chat' });
  const rows = { ...full, capabilities: { ...full.capabilities, capabilities: [...base, chat(AGENTS), chat(MARKETING)] } };
  const defaults = { slots: { knowledge: null, messaging: { name: 'nw-chat', from: AGENTS }, tasks: null }, capabilities: [{ name: 'nw-chat', from: MARKETING, off: false }] };
  const u = await setup(t, { status: { ...statusOf('workspace-status'), defaults }, sync: () => rows });
  await u.tab('capabilities');
  const entries = () => [...u.doc.querySelectorAll('.ws-default-cell[data-slot=messaging] button.ws-default-entry')];
  assert.deepEqual(entries().map(e => e.querySelector('.source-chip-name').textContent), ['agents', 'marketing'], 'the slot\'s first');
  entries()[1].focus(); entries()[1].click(); await settle();
  const page = u.doc.querySelector('.workspace-cap-page');
  assert.equal(page.hidden, false);
  page.querySelector('.page-back').click(); await settle();
  assert.equal(u.doc.activeElement, entries()[1], 'Back lands on the marketing declaration');
  assert.equal(u.doc.activeElement.querySelector('.source-chip-name').textContent, 'marketing');
});

// Workspace v4 (human decision 2026-09-26; replaces the header search): the search is
// the Capabilities view's own toolbar, above the sections.
test('the view search narrows every section by capability name', async t => {
  const u = await setup(t);
  await u.tab('capabilities');
  const search = u.doc.querySelector('.ws-toolbar[data-tools=capabilities] input');
  assert.equal(search.closest('.workspace-header'), null, 'not in the header');
  assert.equal(search.closest('.ws-toolbar').hidden, false);
  assert.equal(search.closest('.ws-toolbar').querySelector('.capability-nav'), null, 'the section pills are All capabilities\', not the search row\'s');
  assert.ok(u.doc.querySelector('.capability-part > .capability-nav'));
  search.focus();
  search.value = 'OKF'; search.dispatchEvent(new u.dom.window.Event('input', { bubbles: true })); await settle();
  assert.deepEqual(u.rows().map(el => el.dataset.capability), ['oats.okf']);
  assert.equal(u.doc.activeElement, search, 'narrowing rebuilds the pills, never the search under the caret');
  await u.tab('souls');
  assert.equal(search.closest('.ws-toolbar').hidden, true, 'the search belongs to Capabilities');
});

test('three sections: Workspace owned, Repo owned (grouped by repo, only when the CLI advertises capabilities-private), then Packages grouped by package', async t => {
  const sections = capabilitySections(fx('f7/capabilities').result.capabilities);
  assert.deepEqual(sections.repo.map(r => r.name), ['nw-platform-runbook'], 'the kernel\'s private: true row (#185)');
  const withFeature = { ...CLI, features: [...CLI.features, 'capabilities-private'] };
  const u = await setup(t, { cli: withFeature, sync: () => catalog('f7/capabilities') });
  await u.tab('capabilities');
  assert.deepEqual([...u.doc.querySelectorAll('.capability-section-title > span:first-child')].map(el => el.textContent), ['Workspace owned', 'Repo owned', 'Packages']);
  assert.deepEqual([...u.doc.querySelectorAll('.capability-section-lead')].map(el => el.textContent), ['latest from member repos', 'only for souls of the same repo', 'pinned versions, same everywhere']);
  assert.deepEqual([...u.doc.querySelectorAll('.capability-nav button')].map(el => el.dataset.jump), ['workspace', 'repo', 'packages']);
  assert.ok(!u.owned().includes('nw-platform-runbook'), 'a repo-owned capability is never listed as workspace owned');
  const group = u.doc.querySelector('[data-section=repo] .catalog-group');
  assert.equal(group.querySelector('.souls-group-name').textContent, 'platform');
  assert.equal(group.querySelector('.souls-group-note').textContent, 'member repo · 1 capability', 'the same heading grammar as Workspace owned');
  assert.equal(group.querySelector('svg').innerHTML, iconElement(u.doc, 'repo').innerHTML, 'the repository icon');
  const runbook = u.doc.querySelector('[data-section=repo] .catalog-row[data-capability=nw-platform-runbook]');
  assert.equal(group.nextElementSibling, runbook);
  assert.equal(runbook.querySelector('.source-chip'), null, 'no Source cell: the group heading names the repository');
  assert.equal(runbook.getAttribute('aria-label'), 'nw-platform-runbook, capability, from platform latest', 'the accessible name still names it');
  // Packages: one group per package, its heading "package · v<version> · N capabilities", in name order.
  const packages = [...u.doc.querySelectorAll('[data-section=packages] .catalog-group')];
  assert.deepEqual(packages.map(h => [h.querySelector('.souls-group-name').textContent, h.querySelector('.souls-group-note').textContent]), [
    ['nw.chat', 'package · v0.1.0 · 1 capability'], ['nw.tools', 'package · v0.4.0 · 2 capabilities'], ['oats.aweb', 'package · v1.16.0 · 1 capability'],
    ['oats.framework', 'package · v1.1.3 · 1 capability'], ['oats.okf', 'package · v2.1.3 · 1 capability']]);
  assert.ok(packages.every(h => h.querySelector('svg').innerHTML === iconElement(u.doc, 'package').innerHTML), 'the package icon');
  const tools = packages[1];
  assert.deepEqual([tools.nextElementSibling, tools.nextElementSibling.nextElementSibling].map(el => el.dataset.capability), ['nw-deploy', 'nw-lint'], 'its rows follow its heading');
  assert.equal(tools.dataset.repo, 'package:nw.tools');
  // Without the feature the section is hidden, never guessed.
  spawn.unmount();
  const v = await setup(t, { sync: () => catalog('f7/capabilities') });
  await v.tab('capabilities');
  assert.deepEqual([...v.doc.querySelectorAll('.capability-section')].map(el => el.dataset.section), ['workspace', 'packages']);
  assert.deepEqual([...v.doc.querySelectorAll('.capability-nav button')].map(el => el.dataset.jump), ['workspace', 'packages']);
});

// Workspace v4 (W1/W2) — replaces the Setup tests that pinned the old
// Repositories/Packages/External souls lists and the always-on graph.
test('W1 Setup list: members with handshake and contribution, packages with origin and lock, teams, this computer; kernel detail verbatim', async t => {
  const moved = syncData(f2('sync-moved'), dir);
  const u = await setup(t);
  await u.tab('sources');
  // Workspace v4: Setup carries no count; its dot says when something needs attention (here nothing does).
  assert.equal(u.doc.querySelector('#workspace-tab-sources .workspace-count').textContent, '');
  assert.equal(u.doc.querySelector('#workspace-tab-sources .workspace-attn').hidden, true);
  const ws = statusOf('workspace-status').workspace;
  assert.equal(u.doc.querySelector('.setup-lede h2').textContent, ws.name);
  assert.match(u.doc.querySelector('.setup-lede-where').textContent, new RegExp(`'s workspace file at ${ws.commit.slice(0, 7)}\\.$`), 'the declaration and its commit');
  assert.doesNotMatch(u.doc.querySelector('.setup').textContent, /oats-workspace\.yaml|oats-membership\.yaml|oats-lock\.json/, 'a kernel without desktop facts reports no file names, so none is shown (desktop-facts-setup.test.mjs covers the reported ones)');
  assert.deepEqual([...u.doc.querySelectorAll('[data-zone=shared] .setup-box')].map(el => el.dataset.box), ['Members', 'Packages'], 'Teams has its own tab (human, 2026-09-28)');
  assert.equal(u.doc.querySelector('[data-zone=here] .setup-sec-title').textContent, 'This computer');
  const repos = [...u.doc.querySelectorAll('[data-box=Members] [data-member]')];
  assert.equal(repos.length, 5);
  assert.ok(repos.every(row => row.querySelector('.setup-state').textContent === 'confirmed' && row.querySelector('.setup-state svg')));
  assert.equal(u.doc.querySelectorAll('[data-box=Packages] [data-package]').length, 3);
  const local = Object.fromEntries([...u.doc.querySelectorAll('[data-zone=here] .setup-fact')].map(r => [r.querySelector('dt').textContent, r.querySelector('dd').textContent]));
  assert.equal(local.Folder, dir); assert.equal(local.Settings, 'oats-local.yaml'); assert.equal(local.Lock, 'current');
  for (const zone of u.doc.querySelectorAll('[data-zone]')) assert.doesNotMatch(zone.textContent, /\b[0-9a-f]{7,40}\b/, 'no commits in the lists');
  assert.doesNotMatch(u.doc.querySelector('.workspace-discovery').textContent, APPROVAL_TEXT);
  assert.deepEqual(u.syncCalls(), [{ action: 'read' }], 'Setup renders the observation only (the one read is the tab bar\'s catalog count)');
  // An unconfirmed member (kernel row from a later sync) keeps its status; "Why?" opens its membership in the graph.
  const status = { ...statusOf('workspace-status'), members: moved.members };
  const { renderSetup } = await import('../renderer/workspace-setup.mjs');
  const host = u.doc.createElement('div'); let picked = null;
  renderSetup(host, { status, onSelect: key => { picked = key; } });
  const marketing = host.querySelector('[data-box=Members] [data-member$="marketing.git"]');
  assert.equal(marketing.querySelector('.setup-state').textContent, 'no backlink');
  assert.ok(marketing.querySelector('.setup-state').classList.contains('warn'));
  marketing.querySelector('button.setup-link-act').click();
  assert.match(picked, /marketing\.git$/);
  renderSetup(host, { status, view: 'graph', selected: picked, onSelect() {} });
  const panel = host.querySelector('.setup-panel');
  assert.equal(panel.querySelector('.setup-panel-name').textContent, 'marketing');
  assert.deepEqual([...panel.querySelectorAll('.setup-hand-mark')].map(m => m.dataset.side), ['yes', 'no'], 'listed, but no backlink');
  assert.match(panel.querySelector('.setup-detail').textContent, /has no oats-membership\.yaml/, 'the kernel detail, verbatim');
});

test('W2 Setup graph: this computer → the lock → the workspace → members and packages; a member opens its Member panel, which opens its capabilities', async t => {
  const u = await setup(t, { status: 'f7/workspace-status' });
  await u.tab('sources');
  u.doc.querySelector('.ws-segmented [data-setup-view=graph]').click(); await settle();
  const graph = u.doc.querySelector('.setup-graph');
  const computer = graph.querySelector('.setup-computer'), ws = graph.querySelector('.setup-ws');
  assert.equal(computer.querySelector('.setup-card-meta.mono').textContent, dir);
  assert.equal([...computer.querySelectorAll('.setup-card-meta')].at(-1).textContent, `oats-local.yaml · ${instances.length} instance${instances.length === 1 ? '' : 's'}`);
  assert.equal(graph.querySelector('.setup-lock').getAttribute('aria-label'), 'Lock current');
  assert.equal(ws.querySelector('.setup-card-title').textContent, 'Workspace northwind');
  assert.equal(ws.querySelector('.setup-card-meta.mono').textContent, 'agents');
  const nodes = [...graph.querySelectorAll('.setup-node')];
  assert.deepEqual(nodes.map(el => el.querySelector('.setup-node-name').textContent),
    ['agents', 'platform', 'data', 'marketing', 'nw-tools', 'nw.chat 0.1.0', 'nw.tools 0.4.0', 'oats.aweb 1.16.0', 'oats.framework 1.1.3', 'oats.okf 2.1.3', 'security-reviewer']);
  assert.equal(nodes[0].querySelector('.setup-node-meta').textContent, 'host · member · 2 souls');
  assert.deepEqual(nodes.filter(n => n.dataset.package).map(n => n.querySelector('.setup-node-meta').textContent), ['git tag', 'git tag', 'git tag', 'official', 'official']);
  const repoIcon = iconElement(u.doc, 'repo').innerHTML, packageIcon = iconElement(u.doc, 'package').innerHTML;
  assert.ok(nodes.every(el => el.querySelector('svg').innerHTML === (el.dataset.package ? packageIcon : repoIcon)), 'git repositories carry the repository icon, packages the package icon');
  // The kernel's workspace warnings, verbatim (#185 warnings[]); a kernel before #185 sends none.
  assert.deepEqual(statusOf('workspace-status').warnings, []);
  assert.equal(statusOf('f7/workspace-status').warnings[0].code, 'unmapped-team-label');
  // An unmapped team label is said on its team's row on the Teams tab, in the
  // kernel's words; Teams carries the attention dot for it, and Setup neither repeats it nor counts it.
  assert.equal(u.doc.querySelector('#workspace-tab-teams .workspace-attn').hidden, false);
  assert.equal(u.doc.querySelector('#workspace-tab-teams .workspace-sr-only').textContent, ' — 2 items need attention', 'global and marketing');
  assert.equal(u.doc.querySelector('#workspace-tab-sources .workspace-attn').hidden, true);
  assert.equal([...u.doc.querySelectorAll('.catalog-note.warn')].some(el => /messaging\.byTeam/.test(el.textContent)), false, 'not a Setup note');
  await u.tab('teams');
  assert.deepEqual([...u.doc.querySelectorAll('.workspace-tabs [role=tab]')].map(tab => tab.firstChild.textContent), ['Souls', 'Capabilities', 'Teams', 'Machines', 'Setup']);
  assert.deepEqual([...u.doc.querySelectorAll('.workspace-discovery .setup-box')].map(el => el.dataset.box), ['Teams']);
  assert.match(u.doc.querySelector('.setup-team[data-team=global] .setup-team-warn').textContent, /team "global" has no messaging\.byTeam entry/);
  assert.equal(u.doc.querySelector('.setup-team[data-team=engineering] .setup-team-warn'), null);
  assert.equal([...u.doc.querySelectorAll('.catalog-note.warn')].some(el => /messaging\.byTeam/.test(el.textContent)), false, 'said once, on its row');
  await u.tab('sources');
  // A member opens its Member panel; the panel opens its capabilities, filtered.
  u.doc.querySelector('button.setup-node[data-member$="agents.git"]').click(); await settle();
  const panel = u.doc.querySelector('.setup-panel');
  assert.equal(u.doc.activeElement, panel.querySelector('.icon-act'), 'focus moves into the panel');
  assert.equal(u.doc.querySelector('button.setup-node[data-member$="agents.git"]').getAttribute('aria-pressed'), 'true');
  assert.deepEqual([...panel.querySelectorAll('.setup-hand-mark')].map(m => m.dataset.side), ['yes', 'yes']);
  [...panel.querySelectorAll('button')].find(b => b.textContent === 'Show its capabilities').click(); await settle();
  assert.equal(u.doc.getElementById('workspace-tab-capabilities').getAttribute('aria-selected'), 'true');
  assert.match(u.doc.querySelector('.catalog-pills button[aria-pressed=true]').dataset.repo, /agents\.git$/, 'the pressed pill is that repository');
  assert.deepEqual(u.owned(), ['nw-house-style', 'nw-release-tooling']);
  assert.equal(u.doc.activeElement, u.doc.getElementById('capability-section-workspace'));
});

test('header state: lock out of date or current — from workspace status; there is no approval state', async () => {
  assert.deepEqual(syncStateText({ ...statusOf('workspace-status'), unsynced: ['x'] }), { text: 'Lock out of date', warn: true });
  assert.deepEqual(syncStateText({ ...statusOf('workspace-status'), stale: ['x'] }), { text: 'Lock out of date', warn: true });
  assert.deepEqual(syncStateText(statusOf('workspace-status')), { text: 'Lock current', warn: false });
  assert.equal(syncStateText(null).text, '');
});

test('Sync runs oats sync and nothing else: no approval control, no sheet for a clean sync, the catalog re-read', async t => {
  const u = await setup(t, { sync: body => body.action === 'sync' ? report('sync-current', 'ok') : catalog('capabilities') });
  assert.equal(u.doc.querySelector('.ws-sync-state').textContent, '', 'a current lock is shown on Setup (This computer), not beside Sync');
  assert.equal(u.button('Review approvals'), undefined); assert.equal(u.doc.querySelector('.ws-approval'), null);
  await u.tab('capabilities');
  u.doc.querySelector('.ws-sync button.ws-sync-run').click(); await settle();
  // desktop/loading-states: the re-read after a sync is live (refresh: true, spec 02) and the held table stays on screen through it.
  assert.deepEqual(u.syncCalls(), [{ action: 'read' }, { action: 'sync' }, { action: 'read', refresh: true }], 'sync, then the catalog is read again, live');
  assert.equal(u.rows().length, 10, 'the table never left');
  assert.equal(u.doc.querySelector('.ws-sync-sheet').hidden, true, 'a clean sync needs nothing from the operator');
  assert.equal(u.doc.querySelector('.ws-sync-state').textContent, '', 'a current lock is shown on Setup (This computer), not beside Sync');
});

test('a sync that reports problems says so in a sheet, in the kernel\'s words', async t => {
  const withProblems = report('sync-current', 'ok');
  withProblems.report.problems = [{ code: 'E_MEMBER_UNREADABLE', message: 'member marketing could not be read', path: null, repoKey: null }];
  const u = await setup(t, { sync: body => body.action === 'sync' ? withProblems : catalog('capabilities') });
  u.doc.querySelector('.ws-sync button.ws-sync-run').click(); await settle();
  const sheet = u.doc.querySelector('.ws-sync-sheet');
  assert.equal(sheet.hidden, false); assert.equal(sheet.querySelector('h2').textContent, 'Synced, with problems');
  assert.match(sheet.textContent, /member marketing could not be read/);
  u.button('Close').click(); assert.equal(sheet.hidden, true);
});

test('a refused sync reads plainly; the kernel code and message stay verbatim behind Details', async t => {
  const integrity = f2('sync-integrity').error;
  const u = await setup(t, { sync: body => body.action === 'sync'
    ? { workspaceSyncApi: 1, status: 'refused', report: null, reason: { code: integrity.code, message: integrity.message } } : catalog('capabilities') });
  u.doc.querySelector('.ws-sync button.ws-sync-run').click(); await settle();
  const sheet = u.doc.querySelector('.ws-sync-sheet');
  assert.equal(sheet.hidden, false); assert.equal(sheet.querySelector('h2').textContent, 'Sync didn’t finish');
  const lead = sheet.querySelector('.ws-sync-lead');
  assert.ok(lead.classList.contains('error')); assert.doesNotMatch(lead.textContent, /E_[A-Z]|\//);
  assert.match(lead.textContent, /doesn’t match what the workspace file or the lock records for it/, 'a moved tag names no why: the general meaning (#1765)');
  const detail = sheet.querySelector('.ws-sync-detail');
  assert.equal(detail.hidden, true); sheet.querySelector('.ws-sync-details').click();
  assert.equal(detail.hidden, false); assert.equal(detail.textContent, `${integrity.code} · ${integrity.message}`);
});

test('a sync that settles after a workspace switch is inert', async t => {
  const gate = deferred();
  const u = await setup(t, { sync: body => body.action === 'sync' ? gate.promise : catalog('capabilities') });
  u.button('Sync').click(); await tick();
  setWorkspace('/other'); await settle();
  gate.resolve({ workspaceSyncApi: 1, status: 'refused', report: null, reason: { code: 'E_PACKAGE_INTEGRITY', message: 'old' } }); await settle();
  assert.equal(u.doc.querySelector('.ws-sync-sheet').hidden, true, 'the old workspace\'s report never opens a sheet');
});

test('no workspace-v2 CLI or a remote workspace: nothing is read or synced, and the reason is named', async t => {
  const legacy = await setup(t, { cli: { ...CLI, workspaceApi: null, features: CLI.features.filter(f => f !== 'workspace-v2') } });
  await legacy.tab('capabilities');
  assert.match(legacy.doc.querySelector('.discovery-status').textContent, /does not advertise workspace-v2/);
  assert.equal(legacy.button('Sync').disabled, true);
  assert.deepEqual(legacy.syncCalls(), []);
});

test('hostile catalog text renders literally', async t => {
  const hostile = f2('capabilities');
  hostile.result.capabilities[0] = { ...hostile.result.capabilities[0], name: '<img src=x onerror=alert(1)>', origin: '"><script>bad()</script>' };
  const u = await setup(t, { sync: () => ({ workspaceSyncApi: 1, status: 'ok', capabilities: { capabilitiesApi: 1, ...hostile.result } }) });
  await u.tab('capabilities');
  assert.equal(u.doc.querySelector('.catalog-table img, .catalog-table script'), null);
  assert.ok(u.rows().some(el => el.querySelector('.catalog-name').textContent === '<img src=x onerror=alert(1)>'));
});

/* ── latest-intent ownership, mutation-verified (success AND rejection) ── */
async function loadMutant(path, from, to) {
  const url = new URL(`../renderer/${path}`, import.meta.url);
  let source = readFileSync(url, 'utf8');
  assert.equal(source.split(from).length, 2, `mutate exactly one guard in ${path}`);
  source = source.replace(from, to).replace(/from '(\.[^']+)'/g, (_all, spec) => `from '${new URL(spec, url).href}'`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
async function syncOwnership(t, create, outcome) {
  const dom = new JSDOM('<!doctype html><body><main class="oats-view"><header></header></main></body>');
  const previous = currentWorkspace(); setWorkspace('/team');
  const gate = deferred();
  const ctx = { api: () => gate.promise };
  const view = create(dom.window.document.querySelector('header'), { ctx });
  t.after(() => { view.dispose(); setWorkspace(previous); dom.window.close(); });
  view.update({ status: statusOf('workspace-status'), canSync: true });
  dom.window.document.querySelector('.ws-sync button.ws-sync-run').click(); await tick();
  setWorkspace('/other'); // a newer workspace intent
  if (outcome === 'success') gate.resolve({ workspaceSyncApi: 1, status: 'refused', report: null, reason: { code: 'E_PACKAGE_INTEGRITY', message: 'OLD refusal' } });
  else gate.resolve(Promise.reject(new Error('OLD sync failure')));
  await settle();
  return dom.window.document.querySelector('.ws-sync-sheet').hidden;
}
for (const outcome of ['success', 'rejection']) test(`sync ${outcome} after a workspace switch never opens a sheet (mutation-verified)`, async t => {
  const { createWorkspaceSync } = await import('../renderer/workspace-sync-view.mjs');
  assert.equal(await syncOwnership(t, createWorkspaceSync, outcome), true, 'the shipped guard keeps the sheet closed');
  const mutant = await loadMutant('workspace-sync-view.mjs', 'alive && id === serial && gen === workspaceGeneration()', 'alive && id === serial');
  assert.equal(await syncOwnership(t, mutant.createWorkspaceSync, outcome), false, 'without the workspace generation the stale result would paint');
});

async function catalogOwnership(t, create, outcome) {
  const dom = new JSDOM('<!doctype html><body><main class="oats-view"><header></header><section id="panel"></section><section id="souls"></section></main></body>');
  const previous = currentWorkspace(); setWorkspace('/team');
  await refreshCli({ api: async () => CLI });
  const gate = deferred(); let reads = 0;
  // The first read belongs to /team; the newer workspace's own read stays pending.
  const ctx = { api: async (path) => path === '/api/cli' ? CLI : reads++ === 0 ? gate.promise : deferred().promise };
  const doc = dom.window.document, host = doc.querySelector('#panel');
  const view = create(doc.querySelector('header'), host, { ctx, soulsPanel: doc.querySelector('#souls') });
  t.after(() => { view.dispose(); setWorkspace(previous); dom.window.close(); });
  const observed = statusOf('workspace-status');
  const panel = () => ({ workspace: { id: currentWorkspace(), scope: currentWorkspace() }, instances: [], deployment: { status: 'observed', workspace: observed.workspace, workspaceStatus: observed } });
  view.updateRoster([], panel()); view.setTab('capabilities'); await tick();
  setWorkspace('/other'); view.updateRoster([], panel());
  if (outcome === 'success') gate.resolve(catalog('capabilities')); else gate.resolve(Promise.reject(new Error('OLD catalog failure')));
  await settle();
  return { rows: host.querySelectorAll('.catalog-row:not(.head)').length, text: host.textContent };
}
for (const outcome of ['success', 'rejection']) test(`catalog ${outcome} for a previous workspace never renders (mutation-verified)`, async t => {
  const { createWorkspaceDiscovery } = await import('../renderer/workspace-discovery.mjs');
  const shipped = await catalogOwnership(t, createWorkspaceDiscovery, outcome);
  assert.equal(shipped.rows, 0); assert.doesNotMatch(shipped.text, /OLD catalog failure/);
  const mutant = await loadMutant('workspace-discovery.mjs', 'alive && serial === id && workspaceGeneration() === gen', 'alive');
  const stale = await catalogOwnership(t, mutant.createWorkspaceDiscovery, outcome);
  assert.ok(stale.rows > 0 || /OLD catalog failure/.test(stale.text), 'without ownership the old workspace\'s result would paint');
});

test('a failed catalog read names the failure and offers an explicit retry', async t => {
  let fail = true;
  const u = await setup(t, { sync: () => fail ? { workspaceSyncApi: 1, status: 'unavailable', reason: { code: 'E_CLI_TIMEOUT', message: 'The workspace command exceeded its time limit.' } } : catalog('capabilities') });
  await u.tab('capabilities');
  // desktop/loading-states: with nothing held, the failed block in the table's place — the kernel's message, its code behind Details, Retry.
  const failed = u.doc.querySelector('.catalog-state .loading-failed'); assert.ok(failed);
  assert.equal(failed.querySelector('.loading-failed-message').textContent, 'The workspace command exceeded its time limit.');
  assert.equal(failed.querySelector('.loading-failed-code').textContent, 'E_CLI_TIMEOUT');
  assert.equal(u.doc.querySelector('.discovery-load-status').textContent, "Couldn't refresh capabilities. The workspace command exceeded its time limit.");
  assert.equal(u.doc.querySelector('#workspace-tab-capabilities .workspace-count').textContent, '', 'no count and no pill after a failed read');
  const retry = failed.querySelector('.loading-retry');
  fail = false; retry.click(); await settle();
  assert.equal(u.rows().length, 10); assert.equal(u.doc.querySelector('.catalog-state .loading-failed'), null);
  assert.equal(u.doc.querySelector('.discovery-load-status').textContent, 'Capabilities updated', 'a Retry is announced on completion');
  assert.deepEqual(u.syncCalls(), [{ action: 'read' }, { action: 'read', refresh: true }], 'Retry reads live');
});

// Team model v2 (0.30, D2): the Workspace's Teams tab (first on 2026-09-28; third since 2026-10-26) holds "Teams on this
// computer" from the kernel's `oats teams` (K1's example document, feat/030-team-model 8dd82158);
// its problems light the tab's dot. A workspace on another computer keeps its teams there.
const { teamsData } = await import('../../client/deployment-data.mjs');
// The REAL 0.30 kernel's `oats teams` (K1 @bba0a9b8, test/fixtures/team-model-v2/teams-after, #269), decoded as the route answers it.
const K1_TEAMS = () => teamsData(JSON.parse(readFileSync(new URL('./fixtures/team-model-v2/teams-after.json', import.meta.url), 'utf8')), dir);
test('Teams tab (team-model-2): third, after Capabilities; the Teams page from oats teams; its problems light the dot; Setup has no teams', async t => {
  const u = await setup(t, { cli: { ...CLI, features: [...CLI.features, 'team-model-2'] }, teams: () => ({ status: 'ok', teams: K1_TEAMS() }) });
  // Souls, Capabilities, Teams, Machines, Setup (product owner, 2026-10-26, over 2026-10-23's order; Automations is a
  // page of its own again, and Machines, the Deployments page of before, sits before Setup).
  assert.deepEqual([...u.doc.querySelectorAll('.workspace-tabs [role=tab]')].map(tab => tab.id), ['workspace-tab-souls', 'workspace-tab-capabilities', 'workspace-tab-teams', 'workspace-tab-machines', 'workspace-tab-sources']);
  assert.equal(u.doc.getElementById('workspace-tab-automations'), null, 'no Automations tab');
  assert.equal(u.doc.getElementById('workspace-tab-souls').getAttribute('aria-selected'), 'true', 'Souls stays where the Workspace opens');
  // The roving keys follow the order: Right from Capabilities is Teams, then Machines; Left from Souls wraps to Setup, Home is Souls.
  const key = name => { const tab = u.doc.querySelector('.workspace-tabs [aria-selected=true]'); tab.dispatchEvent(new u.dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })); return u.doc.activeElement.id; };
  assert.equal(key('ArrowRight'), 'workspace-tab-capabilities'); assert.equal(key('ArrowRight'), 'workspace-tab-teams'); assert.equal(key('ArrowRight'), 'workspace-tab-machines');
  assert.equal(key('ArrowRight'), 'workspace-tab-sources');
  assert.equal(key('Home'), 'workspace-tab-souls'); assert.equal(key('ArrowLeft'), 'workspace-tab-sources'); assert.equal(key('ArrowLeft'), 'workspace-tab-machines');
  assert.equal(key('Home'), 'workspace-tab-souls');
  await u.tab('teams');
  const card = u.doc.querySelector('.workspace-discovery .computer-teams');
  assert.ok(card, 'the page'); assert.equal(card.dataset.box, 'Teams'); assert.equal(card.querySelector('.ct-title').textContent, 'Teams');
  assert.equal(u.doc.querySelector('.workspace-discovery').dataset.tab, 'teams');
  // One card per team: the shared ones, then this computer's own.
  const cards = [...card.querySelectorAll('.ct-card')].map(r => [r.closest('.ct-section').dataset.section, r.dataset.team]);
  assert.deepEqual(cards.map(([, team]) => team).sort(), ['engineering', 'global', 'marketing', 'mine']);
  assert.deepEqual(cards, [...cards].sort((a, b) => (a[0] === 'local') - (b[0] === 'local')), 'shared first');
  assert.deepEqual(u.calls.filter(c => c.path.startsWith('/api/workspace-teams')).map(c => c.body), [{ action: 'list' }], 'one read');
  assert.equal(u.doc.querySelector('#workspace-tab-teams .workspace-attn').hidden, false);
  assert.equal(u.doc.querySelector('#workspace-tab-teams .workspace-sr-only').textContent, ' — 3 items need attention', 'the three shared teams with no provider id yet');
  await u.tab('sources');
  assert.equal(u.doc.querySelector('.computer-teams'), null);
  assert.deepEqual([...u.doc.querySelectorAll('.setup-box, .setup-zone')].map(el => el.dataset.box || el.dataset.zone), ['Members', 'Packages', 'here']);
  await u.tab('teams');
  assert.equal(u.doc.querySelector('.workspace-discovery .computer-teams'), card, 'the same card: a half-typed form survives');
  assert.equal(u.calls.filter(c => c.path.startsWith('/api/workspace-teams')).length, 1, 'not re-read by switching tabs');
  assert.doesNotMatch(u.doc.querySelector('.workspace-discovery').textContent, /primary|personal/i);
});

test('Teams tab: a poll that only re-stamps the workspace status keeps the page and its focus', async t => {
  const u = await setup(t, { cli: { ...CLI, features: [...CLI.features, 'team-model-2'] }, teams: () => ({ status: 'ok', teams: K1_TEAMS() }) });
  await u.tab('teams');
  const add = u.button('Add a local team'); add.focus();
  await u.poll('2026-09-30T07:28:04.414Z');
  assert.ok(u.calls.filter(c => c.path.startsWith('/api/panel')).length >= 2, 'the poll read the panel again');
  assert.equal(u.doc.activeElement, add, 'focus stays where it was');
});

// A team's page (packages/desktop/docs/desktop-teams.md "A team's page"): a Workspace page like a soul's or a
// capability's, opened from its card; Back and Esc return to the board on that card; its team leaving closes it.
test('Teams: a card opens its team\'s page in place of the tabs; Esc and Back return to the board, focus on that team\'s name; a tab change closes it', async t => {
  const u = await setup(t, { cli: { ...CLI, features: [...CLI.features, 'team-model-2'] }, teams: () => ({ status: 'ok', teams: K1_TEAMS() }),
    members: () => ({ members: [{ workspace: '/team', server: null, serverLabel: null, instance: 'rm-1', agent: 'release-manager', agentsRoot: dir, home: `${dir}/agents/release-manager/instances/rm-1`,
      team: 'mine:juan.aweb.ai', running: true, addressable: true, missingRemotely: false, reason: null, reasonLabel: null, createdAt: null }], servers: [], notReached: [] }) });
  await u.tab('teams');
  const page = u.doc.querySelector('.workspace-team-page'), header = u.doc.querySelector('.workspace-header'), board = u.doc.querySelector('.workspace-discovery');
  assert.equal(page.hidden, true); assert.equal(page.getAttribute('aria-label'), 'Team details');
  const open = () => u.doc.querySelector('.ct-card[data-team="mine"] .ct-open');
  assert.equal(u.doc.querySelector('.ct-card[data-team="mine"] .ct-sum').textContent, '1 of your instances');
  open().click(); await settle();
  assert.equal(page.hidden, false); assert.equal(header.hidden, true, 'the page bar replaces the Workspace tabs'); assert.equal(board.hidden, true);
  assert.equal(u.doc.activeElement, page.querySelector('.page-back'), 'opening focuses Back');
  assert.equal(page.querySelector('.page-crumbs .page-crumb-current').textContent, 'mine');
  assert.equal(page.querySelector('h2.ct-page-label').textContent, 'mine');
  assert.equal(page.querySelector('.ct-member-name').getAttribute('aria-label'), 'Show rm-1 in the roster');
  page.querySelector('.ct-member-name').dispatchEvent(new u.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await settle();
  assert.equal(page.hidden, true); assert.equal(header.hidden, false); assert.equal(board.hidden, false);
  assert.equal(page.childElementCount, 0, 'the page is emptied');
  assert.equal(u.doc.activeElement, open(), 'Esc: back on the team\'s name');
  open().click(); await settle();
  page.querySelector('.page-back').click(); await settle();
  assert.equal(page.hidden, true); assert.equal(u.doc.activeElement, open(), 'Back: the same');
  open().click(); await settle();
  // A tab change (here a programmatic one, as the shell's footer navigation makes) closes it.
  spawn.preselectWorkspaceTab('sources'); await settle();
  assert.equal(page.hidden, true); assert.equal(header.hidden, false); assert.equal(u.doc.querySelector('.workspace-discovery').dataset.tab, 'sources');
});

// A Make default confirmation opened on a team's page ends with the page: Esc leaves no confirmation behind on
// the board's card, and the board's redraw barrier is released, so a roster change repaints it.
test('Teams: Esc on a team\'s page with its Make default confirmation open closes both, and the board redraws again', async t => {
  const doc = () => { const d = K1_TEAMS(); d.teams.push({ label: 'spare', team: 'spare:juan.aweb.ai', from: 'local', default: false, description: null }); return d; };
  const rm = (instance, team) => ({ workspace: '/team', server: null, serverLabel: null, instance, agent: 'release-manager', agentsRoot: dir, home: `${dir}/agents/release-manager/instances/${instance}`,
    team, running: true, addressable: true, missingRemotely: false, reason: null, reasonLabel: null, createdAt: null });
  let members = [rm('rm-1', 'spare:juan.aweb.ai')];
  const u = await setup(t, { cli: { ...CLI, features: [...CLI.features, 'team-model-2'] }, teams: () => ({ status: 'ok', teams: doc() }),
    members: () => ({ members, servers: [], notReached: [] }) });
  await u.tab('teams');
  const sum = () => u.doc.querySelector('.ct-card[data-team="spare"] .ct-sum').textContent;
  assert.equal(sum(), '1 of your instances');
  u.doc.querySelector('.ct-card[data-team="spare"] .ct-open').click(); await settle();
  const page = u.doc.querySelector('.workspace-team-page');
  [...page.querySelectorAll('.ct-page-card .ct-head .ct-act')].find(b => b.textContent === 'Make default').click(); await settle();
  assert.ok(page.querySelector('.ct-confirm')); assert.equal(u.doc.activeElement, page.querySelector('.ct-confirm .primary'));
  u.doc.activeElement.dispatchEvent(new u.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await settle();
  assert.equal(page.hidden, true);
  assert.equal(u.doc.querySelector('.workspace-discovery .ct-confirm'), null, 'no confirmation left on the board\'s card');
  assert.equal(u.doc.activeElement, u.doc.querySelector('.ct-card[data-team="spare"] .ct-open'), 'back on the team\'s name');
  u.doc.activeElement.blur();
  members = [rm('rm-1', 'spare:juan.aweb.ai'), rm('rm-2', 'spare:juan.aweb.ai')];
  await u.poll('2026-09-30T07:28:04.414Z');
  assert.equal(sum(), '2 of your instances', 'the roster change repaints the board');
  assert.deepEqual(u.calls.filter(c => c.path.startsWith('/api/workspace-teams')).map(c => c.body), [{ action: 'list' }], 'nothing sent');
});

test('Teams: removing the team from its page closes the page once the document answers, and focus goes to the Teams tab', async t => {
  const doc = () => { const d = K1_TEAMS(); d.teams.push({ label: 'spare', team: 'spare:juan.aweb.ai', from: 'local', default: false, description: null }); return d; };
  let removed = false;
  const u = await setup(t, { cli: { ...CLI, features: [...CLI.features, 'team-model-2'] },
    teams: body => { if (body?.action === 'remove') removed = true; const d = doc(); if (removed) d.teams = d.teams.filter(x => x.label !== 'spare'); return { status: 'ok', teams: d }; } });
  await u.tab('teams');
  u.doc.querySelector('.ct-card[data-team="spare"] .ct-open').click(); await settle();
  const page = u.doc.querySelector('.workspace-team-page');
  const remove = [...page.querySelectorAll('.ct-page-card .ct-act')].find(b => b.textContent === 'Remove');
  assert.equal(remove.getAttribute('aria-label'), 'Remove spare');
  remove.focus(); remove.click(); await settle();
  assert.deepEqual(u.calls.filter(c => c.path.startsWith('/api/workspace-teams')).at(-1).body, { action: 'remove', label: 'spare' });
  assert.equal(page.hidden, true); assert.equal(u.doc.querySelector('.workspace-header').hidden, false);
  assert.equal(u.doc.querySelector('.ct-card[data-team="spare"]'), null, 'gone from the board too');
  assert.equal(u.doc.activeElement, u.doc.getElementById('workspace-tab-teams'), 'no card to return to: the Teams tab');
});

// Opening a team is an explicit choice: it claims the selection intent, so a shell footer handoff still waiting on its
// import (the production openWorkspaceSouls, held) neither navigates nor notifies when it lands or fails.
for (const outcome of ['success', 'rejection']) test(`Teams: opening a team supersedes a shell footer import's ${outcome}`, async t => {
  const u = await setup(t, { cli: { ...CLI, features: [...CLI.features, 'team-model-2'] }, teams: () => ({ status: 'ok', teams: K1_TEAMS() }) });
  await u.tab('teams');
  const source = readFileSync(new URL('../renderer/shell.mjs', import.meta.url), 'utf8');
  const gate = createSelectionOwnership({ currentWorkspace, workspaceGeneration });
  const hook = source.match(/onSelectionIntent:\s*(\(\) => tabOpenIntents\.invalidate\(\))/)?.[1];
  assert.ok(hook, 'production ctx shares Workspace selection with shell foreground ownership');
  let land, fail; const held = new Promise((yes, no) => { land = yes; fail = no; });
  const stages = [], notices = [];
  const chooser = source.match(/async function openWorkspaceSouls\([^]*?\n\}/)[0].replace('import("./views/spawn.mjs")', 'loadSpawn()');
  const choose = runInNewContext(`(${chooser})`, { document: u.doc, tabOpenIntents: gate, loadSpawn: () => held,
    ctx: { notify: message => notices.push(message) }, showStage: name => stages.push(name) });
  u.ctx.onSelectionIntent = runInNewContext(hook, { tabOpenIntents: gate });
  const pending = choose();
  u.doc.querySelector('.ct-card[data-team="mine"] .ct-open').click(); await settle();
  const page = u.doc.querySelector('.workspace-team-page');
  assert.equal(page.hidden, false);
  if (outcome === 'success') land(spawn); else fail(new Error('superseded chooser'));
  await pending; await settle();
  assert.deepEqual(stages, [], 'the older import does not navigate');
  assert.deepEqual(notices, [], 'nor say it failed');
  assert.equal(page.hidden, false, 'the team page stays');
  assert.equal(u.doc.querySelector('[role=tab][aria-selected=true]').id, 'workspace-tab-teams');
  assert.equal(u.doc.activeElement, page.querySelector('.page-back'));
});

// The Workspace pages do not name the deployment they read (the product owner, 2026-10-23): in a view of two
// deployments a team's page edits the primary, as before (#482), with no "On <deployment>" line.
test('Teams: in a view of two deployments a team\'s page shows no "On <deployment>" line', async t => {
  const doc = () => { const d = K1_TEAMS(); d.teams.push({ label: 'spare', team: 'spare:juan.aweb.ai', from: 'local', default: false, description: null }); return d; };
  const u = await setup(t, { cli: { ...CLI, features: [...CLI.features, 'team-model-2'] }, teams: () => ({ status: 'ok', teams: doc() }) });
  t.after(resetViewDeployments);
  const deployments = second => [
    { id: '/d1', machine: 'This Mac', path: '/Users/ana/Agents/first', label: '~/Agents/first', local: true, primary: true, reachable: true },
    ...(second ? [{ id: '/d2', machine: 'This Mac', path: '/Users/ana/Agents/second', label: '~/Agents/second', local: true, primary: false, reachable: true }] : []),
  ];
  notePanel({ workspace: { id: '/team' }, deployments: deployments(true) });
  await u.tab('teams');
  u.doc.querySelector('.ct-card[data-team="spare"] .ct-open').click(); await settle();
  const page = u.doc.querySelector('.workspace-team-page');
  assert.equal(page.hidden, false);
  assert.deepEqual([...page.querySelectorAll('.ct-page-card .ct-act')].map(b => b.textContent), ['Make default', 'Remove']);
  assert.equal(page.querySelector('.deployment-scope'), null, 'no scope line on the page');
  assert.doesNotMatch(page.textContent, /On This Mac/);
  assert.equal(u.doc.querySelector('.workspace-main .deployment-scope'), null, 'nor under the Workspace header');
  notePanel({ workspace: { id: '/team' }, deployments: deployments(false) }); await settle();
  assert.equal(page.querySelector('.deployment-scope'), null);
});

// #482 (unchanged by the Workspace pages losing their "On <deployment>" line, 2026-10-23): in a view of two or more
// deployments of one workspace the Workspace pages read the view's primary deployment, as before. They address every
// read by the view id (the server answers deployment-level reads from the primary: workspace-views-server.test.mjs),
// never by a deployment id, and offer no choice of deployment; only the side panel and the Deployments page name one.
test('#482: in a view of two deployments the Workspace pages read the primary through the view id, with no deployment choice or line', async t => {
  t.after(resetViewDeployments);
  const deployments = [
    { id: '/d1', machine: 'This Mac', path: '/Users/ana/Agents/first', label: '~/Agents/first', local: true, primary: true, reachable: true },
    { id: '/d2', machine: 'altair', path: '/srv/first', label: '~/first', local: false, primary: false, reachable: true },
  ];
  const u = await setup(t, { cli: { ...CLI, features: [...CLI.features, 'team-model-2'] }, teams: () => ({ status: 'ok', teams: K1_TEAMS() }),
    workspace: { primary: '/d1' }, beforeMount: () => notePanel({ workspace: { id: '/team', primary: '/d1' }, deployments }) });
  // Machines is the one tab that names the machines: they are its subject (the Deployments view's tabs and headings).
  for (const tab of ['souls', 'capabilities', 'teams', 'sources']) {
    await u.tab(tab);
    assert.equal(u.doc.querySelector('.workspace-main .deployment-scope'), null, `${tab}: no "On <deployment>" line`);
    assert.doesNotMatch(u.doc.querySelector('.workspace-main').textContent, /On This Mac|~\/Agents\/first|altair/, `${tab}: no deployment named`);
  }
  // A capability's page and a soul's page: no line either.
  await u.tab('capabilities');
  u.rows()[0].click(); await settle();
  const capPage = u.doc.querySelector('.workspace-cap-page');
  assert.equal(capPage.hidden, false, 'the capability page is open'); assert.equal(capPage.querySelector('.deployment-scope'), null, 'none on the capability page');
  capPage.querySelector('.page-back').click(); await settle();
  await u.tab('souls');
  u.doc.querySelector('.soul-card').click(); await settle();
  const soulPage = u.doc.querySelector('.workspace-soul-page');
  assert.equal(soulPage.hidden, false, 'the soul page is open'); assert.equal(soulPage.querySelector('.deployment-scope'), null, 'none on the soul page');
  const addressed = u.calls.map(call => call.path).filter(path => !/^\/api\/(cli|servers)\b/.test(path));
  assert.ok(addressed.some(path => path.startsWith('/api/agents')) && addressed.some(path => path.startsWith('/api/workspace-sync'))
    && addressed.some(path => path.startsWith('/api/workspace-teams')), 'the souls, the catalog and the teams were read');
  for (const path of addressed) assert.match(path, /[?&]ws=%2Fteam(?:&|$)/, `${path}: by the view id`);
  assert.equal(addressed.some(path => /ws=%2Fd[12]\b/.test(path)), false, 'never by a deployment id');
});

// 0.30 automation trust: the REAL kernel's workspace-status warnings (fixtures/automations-trust, kernel
// PR #300) spliced into this Northwind status: Setup says each one and its remedy, verbatim.
test('Setup: automation-untrusted and automation-trust-stale are said verbatim, each untrusted one with its remedy (the oats-local.yaml line)', async t => {
  const trust = JSON.parse(readFileSync(new URL('./fixtures/automations-trust/partial-workspace-status.json', import.meta.url), 'utf8'));
  const status = statusOf('workspace-status');
  status.warnings = workspaceStatusData(trust, '/fixture/base/deployment').warnings;
  const u = await setup(t, { status });
  await u.tab('sources');
  // Each through the shared warnings list (capability-warnings.mjs): "Warning", the message, its remedy as a muted note.
  const items = [...u.doc.querySelectorAll('.catalog-notes .cap-warning')].map(el => [el.querySelector('.cap-warning-label').textContent,
    el.querySelector('.cap-warning-message').textContent, el.querySelector('.cap-warning-note')?.textContent ?? null]);
  const said = trust.result.warnings;
  assert.deepEqual(items.filter(([, message]) => said.some(w => w.message === message)), [
    ['Warning', said[0].message, said[0].remedy], ['Warning', said[1].message, null]]);
  assert.equal(u.doc.querySelector('#workspace-tab-sources .workspace-attn').hidden, false, 'Setup carries the attention dot');
});

// Machines is a Workspace tab, before Setup (the product owner, 2026-10-26; the page opens on Souls): its panel is
// the view's own, like the Souls grid, and the Deployments view (views/hierarchy.mjs) lives in it only while the tab
// is shown (views/spawn.mjs syncMachines): chosen, or preselected (stage.hierarchy, ⌘1 / Ctrl+1). Automations is no
// tab any more: a page of its own again.
const machinesPanel = u => u.doc.getElementById('workspace-machines');
const panelReads = u => u.calls.filter(c => c.path.startsWith('/api/panel')).length;
const agentsReads = u => u.calls.filter(c => c.path.startsWith('/api/agents')).length;
/** What a workspace change and back reads: the page reads its souls and its roster each time; a Deployments view on
 * screen reads its roster too. */
async function workspaceChangeReads(u) {
  const panel = panelReads(u), agents = agentsReads(u);
  setWorkspace('/other'); await settle(); setWorkspace('/team'); await settle();
  return { panel: panelReads(u) - panel, agents: agentsReads(u) - agents };
}

test('Machines tab: not mounted while Souls opens; chosen, its own tabpanel, labelled by its tab, holds the Deployments view; the grid and the discovery panel are hidden and the discovery paints nothing', async t => {
  const u = await setup(t);
  const tab = u.doc.getElementById('workspace-tab-machines');
  assert.equal(spawn.currentWorkspaceTab(), 'souls', 'the page opens on Souls');
  assert.equal(tab.getAttribute('aria-selected'), 'false'); assert.equal(tab.getAttribute('aria-controls'), 'workspace-machines');
  assert.equal(machinesPanel(u).hidden, true, 'not shown while Souls is'); assert.equal(machinesPanel(u).childElementCount, 0, 'and nothing mounted in it');
  assert.equal(u.doc.querySelector('.hier'), null, 'no Deployments view anywhere');
  assert.deepEqual(await workspaceChangeReads(u), { panel: 2, agents: 2 }, 'only the page reads');
  await u.tab('machines');
  const panel = machinesPanel(u);
  assert.equal(u.doc.querySelectorAll('#workspace-machines').length, 1, 'one element carries the id the tab controls');
  assert.ok(panel.classList.contains('workspace-machines-panel'));
  assert.equal(panel.getAttribute('role'), 'tabpanel'); assert.equal(panel.getAttribute('aria-labelledby'), 'workspace-tab-machines');
  assert.equal(tab.getAttribute('aria-selected'), 'true'); assert.equal(panel.hidden, false);
  assert.equal(spawn.currentWorkspaceTab(), 'machines');
  // The Deployments view, mounted in it: its bar, its sentence, its canvas.
  assert.equal(panel.querySelectorAll(':scope > .hier').length, 1, 'the Deployments view, once');
  assert.ok(panel.querySelector('.hier-bar') && panel.querySelector('.hier-canvas'));
  assert.equal(panel.querySelector('.hier-intro').textContent, 'Each machine runs this workspace in a folder of its own. The instances under a machine run on that machine.');
  assert.deepEqual(await workspaceChangeReads(u), { panel: 4, agents: 2 }, 'the view reads its roster beside the page');
  assert.equal(u.doc.querySelector('.souls-grid').hidden, true, 'the souls grid is hidden');
  assert.equal(u.doc.querySelector('.souls-bar').hidden, true, 'and its bar'); assert.equal(u.doc.querySelector('.souls-notice').hidden, true, 'and its notice');
  const discovery = u.doc.querySelector('.workspace-discovery');
  assert.equal(discovery.hidden, true, 'the discovery panel is hidden');
  assert.equal(discovery.dataset.tab, 'machines');
  assert.equal(discovery.querySelector('.catalog-notes').childElementCount, 0, 'no notes painted');
  assert.equal(discovery.lastElementChild.childElementCount, 0, 'no body painted');
  assert.equal(discovery.querySelector('.catalog-row, .setup-box, .computer-teams'), null);
  // No Automations tab, and no panel for one.
  assert.equal(u.doc.getElementById('workspace-tab-automations'), null); assert.equal(u.doc.getElementById('workspace-automations'), null);
  assert.equal(spawn.preselectWorkspaceTab('automations'), false, 'no such tab to preselect');
  assert.equal(spawn.currentWorkspaceTab(), 'machines');
});

test('Machines tab: choosing another tab unmounts the Deployments view (it reads no more), and the tab chosen again mounts a fresh one', async t => {
  const u = await setup(t);
  await u.tab('machines');
  const first = machinesPanel(u).querySelector('.hier');
  assert.ok(first);
  await u.tab('capabilities');
  assert.equal(machinesPanel(u).hidden, true); assert.equal(machinesPanel(u).childElementCount, 0, 'the view is gone from its panel');
  assert.equal(first.isConnected, false);
  assert.deepEqual(await workspaceChangeReads(u), { panel: 2, agents: 2 }, 'left: only the page reads');
  await u.tab('souls');
  assert.equal(machinesPanel(u).childElementCount, 0, 'nothing remounted behind another tab');
  await u.tab('machines');
  const second = machinesPanel(u).querySelector('.hier');
  assert.ok(second); assert.notEqual(second, first, 'a fresh view');
  assert.equal(machinesPanel(u).hidden, false); assert.equal(u.doc.querySelector('.souls-grid').hidden, true);
  assert.deepEqual(await workspaceChangeReads(u), { panel: 4, agents: 2 }, 'the fresh view reads its roster');
});

test('Machines tab: unmounting the view unmounts the Deployments view; neither reads any more', async t => {
  const u = await setup(t);
  await u.tab('machines');
  assert.ok(machinesPanel(u).querySelector('.hier'));
  spawn.unmount();
  assert.equal(spawn.currentWorkspaceTab(), null);
  const before = u.calls.length;
  setWorkspace('/other'); await settle(); setWorkspace('/team'); await settle();
  assert.deepEqual(u.calls.slice(before), [], 'no read after unmount: not the page, not the Deployments view');
});

test('Machines tab: preselectWorkspaceTab(\'machines\') (stage.hierarchy) before the view mounts lands on it, the Deployments view mounted', async t => {
  const u = await setup(t, { beforeMount: () => assert.equal(spawn.preselectWorkspaceTab('machines'), true) });
  assert.equal(u.doc.getElementById('workspace-tab-machines').getAttribute('aria-selected'), 'true');
  assert.equal(u.doc.getElementById('workspace-tab-souls').getAttribute('aria-selected'), 'false');
  assert.equal(spawn.currentWorkspaceTab(), 'machines');
  assert.equal(machinesPanel(u).hidden, false); assert.equal(machinesPanel(u).querySelectorAll(':scope > .hier').length, 1, 'mounted at once');
  assert.equal(u.doc.querySelector('.souls-grid').hidden, true);
  assert.equal(u.doc.querySelector('.souls-bar').hidden, true, 'the Souls bar waits for Souls'); assert.equal(u.doc.querySelector('.souls-notice').hidden, true);
  assert.equal(u.doc.querySelector('.workspace-discovery').hidden, true);
  assert.deepEqual(await workspaceChangeReads(u), { panel: 4, agents: 2 }, 'the view reads its roster beside the page');
  // On the page already shown, the preselect switches the tab there and then.
  await u.tab('teams'); assert.equal(machinesPanel(u).childElementCount, 0);
  assert.equal(spawn.preselectWorkspaceTab('machines'), true); await settle();
  assert.equal(spawn.currentWorkspaceTab(), 'machines'); assert.equal(machinesPanel(u).querySelectorAll(':scope > .hier').length, 1);
});

test('Machines tab: the Deployments view\'s "s" (Workspace) turns the page to Souls, not a stage switch to the page already shown', async t => {
  const views = [];
  const u = await setup(t, { openView: name => views.push(name) });
  await u.tab('machines');
  const canvas = machinesPanel(u).querySelector('.hier-canvas');
  canvas.focus();
  const event = new u.dom.window.KeyboardEvent('keydown', { key: 's', bubbles: true, cancelable: true });
  canvas.dispatchEvent(event); await settle();
  assert.equal(event.defaultPrevented, true, 'the view took the key');
  assert.equal(u.doc.getElementById('workspace-tab-souls').getAttribute('aria-selected'), 'true', 'the page is on Souls');
  assert.equal(spawn.currentWorkspaceTab(), 'souls');
  assert.equal(u.doc.querySelector('.souls-grid').hidden, false);
  assert.equal(machinesPanel(u).hidden, true); assert.equal(machinesPanel(u).childElementCount, 0, 'the Deployments view left with its tab');
  assert.equal(canvas.isConnected, false);
  assert.deepEqual(views, [], 'the shell\'s openView is not asked for the page already shown');
});
