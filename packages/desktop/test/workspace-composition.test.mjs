// Source/DOM/CSSOM checks against the geometry in Redesign.dc.html screens 03/04.
// jsdom has no layout engine: these are composition constraints, NOT screenshots,
// measured browser positions, or Electron/terminal verification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import * as spawn from '../renderer/views/spawn.mjs';
import { currentWorkspace, setWorkspace } from '../renderer/views/common.mjs';
import { refreshCli, resetCliStateForTests } from '../renderer/views/cli-status.mjs';
import { inspectorCSS } from '../renderer/soul-inspector.mjs';
import { soulInspection } from './helpers/inspect-fixture.mjs';
import { workspaceStatusData } from '../../client/deployment-data.mjs';
import * as automationsStage from '../renderer/views/automations.mjs';
import { NAV, navTab } from '../renderer/shell-nav.mjs';
const { preselectAutomationsTab } = automationsStage;

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const CLI = { ok: true, operationsApi: 2, features: ['operations'], relations: true };
const f2 = name => JSON.parse(readFileSync(new URL(`./fixtures/workspace-v2/f2/${name}.json`, import.meta.url), 'utf8'));
const V2_CLI = { ...CLI, bin: '/fixture/bin/oats', workspaceApi: 2, features: ['operations', 'workspace-v2'] };
const observedStatus = workspaceStatusData(f2('workspace-status'), '/fixture/base/northwind-workspace');
const catalogReply = (capabilities = f2('capabilities').result.capabilities) => ({ workspaceSyncApi: 1, status: 'ok',
  capabilities: { capabilitiesApi: 1, ...f2('capabilities').result, capabilities } });
const soul = { name: 'dev', agentsRoot: '/fixture/agents', repoName: 'fixture', runtime: 'pi', work: 'worktree', description: 'Build and review' };
// operationsApi 2 soul inspection from the kernel capture.
const inspection = soulInspection('dev', { instructions: { file: '/fixture/AGENTS.md', text: 'Saved instructions', truncated: false } });
async function fixture(t, { cli = CLI, inspect = () => inspection, agents = [soul], sync = null, instances = [], automations = null, route = () => {} } = {}) {
  const dom = new JSDOM('<body><div id="host"></div></body>', { url: 'http://localhost' });
  const doc = dom.window.document;
  const saved = { document: globalThis.document, window: globalThis.window, setInterval: globalThis.setInterval, ws: currentWorkspace() };
  const theme = doc.createElement('style'); theme.textContent = readFileSync(new URL('../renderer/theme.css', import.meta.url), 'utf8'); doc.head.append(theme);
  globalThis.document = doc; globalThis.window = dom.window; globalThis.setInterval = () => 0;
  setWorkspace('/fixture');
  if (cli === null) resetCliStateForTests(); else await refreshCli({ api: async () => cli });
  const calls = [], files = [], views = [];
  let currentCli = cli;
  const ctx = { hasWorkspaceSwitcher: true, openBrain: name => files.push(name), openView: name => { views.push(name); route(name, { doc, ctx }); },
    api: async (path, opts = {}) => {
      const body = opts.body && JSON.parse(opts.body); calls.push({ path, body });
      if (path === '/api/cli') { if (currentCli === null) throw new Error('Synthetic transport pending'); return currentCli; }
      if (path.startsWith('/api/agents')) return { agents };
      if (path.startsWith('/api/panel')) return { instances, workspace: { id: currentWorkspace() }, workspaces: [{ id: '/fixture', name: 'Fixture' }, { id: '/other', name: 'Other' }],
        ...(sync ? { deployment: { status: 'observed', root: '/fixture/agents', workspace: observedStatus.workspace, workspaceStatus: observedStatus, reachable: { reachable: true }, withheld: [] } } : {}) };
      if (path.startsWith('/api/workspace-sync') && sync) return sync(body);
      if (path.startsWith('/api/capabilities')) return inspect(body);
      if (automations && path.startsWith('/api/automations')) return automations(body);
      if (path.startsWith('/api/servers')) return { servers: [] };
      throw new Error(`Unexpected fixture request: ${path}`);
    } };
  t.after(() => { spawn.unmount(); setWorkspace(saved.ws); globalThis.document = saved.document; globalThis.window = saved.window; globalThis.setInterval = saved.setInterval; dom.window.close(); });
  spawn.mount(doc.querySelector('#host'), ctx); await tick();
  return { doc, dom, ctx, calls, files, views, get: selector => doc.querySelector(selector),
    css: selector => dom.window.getComputedStyle(doc.querySelector(selector)),
    click: text => { const control = [...doc.querySelectorAll('button')].find(b => b.textContent === text); assert.ok(control, text); control.click(); },
    setCli: async next => { currentCli = next; await refreshCli({ api: async () => next }); } };
}

test('03 (F7): a soul opens as a page in the main area — it replaces the grid, adds no side column; header precedes canvas directly', async t => {
  const u = await fixture(t);
  assert.equal(u.get('.soul-inspector').hidden, true, 'mount never chooses a soul automatically');
  assert.equal(u.get('.workspace-soul-page').hidden, true);
  assert.equal(u.get('.spawn-act'), null, 'Launch is owned by an explicitly selected soul, not an arbitrary default');
  u.get('.soul-card').click(); await tick();
  const main = u.get('.workspace-main'), aside = u.get('.soul-inspector'), header = u.get('.workspace-header'), page = u.get('.workspace-soul-page');
  assert.deepEqual([...u.get('.souls-body').children], [main, aside]);
  assert.equal(aside.tagName, 'ASIDE'); assert.equal(aside.hidden, true, 'the sidebar is for instances');
  assert.equal(page.parentElement, main); assert.equal(page.hidden, false);
  assert.equal(u.get('.souls-grid').hidden, true, 'the page replaces the grid'); assert.equal(u.get('.souls-bar').hidden, true, 'and its filter');
  assert.equal(u.css('.workspace-soul-page').padding, '0px', 'Workspace v4 (W4): the page bar is flush; its body pads itself');
  assert.equal(header.hidden, true, 'the page bar replaces the Workspace header while the page is open');
  assert.ok(page.querySelector('.page-bar .inspector-back'), 'the back control lives in the page bar');
  // The page's title (slice 2b: "Workspace › Souls") sits above the header, and hides with it under a page's own bar; its
  // row holds the Souls tab's Grid | Table beside it (slice 3c), hidden with it.
  assert.equal(main.firstElementChild, u.get('.workspace-title-row')); assert.equal(main.firstElementChild.firstElementChild, u.get('.workspace-title'));
  assert.equal(main.firstElementChild.nextElementSibling, header); assert.equal(u.get('.souls-view').hidden, true);
  assert.equal(u.get('.workspace-title').hidden, true, "the soul's page keeps its own breadcrumb");
  // No "On <deployment>" line under the header: the Workspace pages do not name the deployment they read (the
  // product owner, 2026-10-23; #482's rule, docs/desktop-deployment-model.md); the side panel and Deployments do.
  assert.equal(header.nextElementSibling, u.get('.workspace-recovery'));
  assert.equal(main.querySelector('.deployment-scope'), null);
  assert.equal(u.get('.workspace-recovery').hidden, true, 'compatible CLI adds no visible row before the cards');
  // Workspace v4 (human decision 2026-09-26; replaces the header-placed filter): the
  // search and the Grid | Table control are the view's own toolbar, directly above the cards.
  assert.equal(u.get('.workspace-recovery').nextElementSibling, u.get('.souls-bar'), 'the Souls toolbar sits in the view, before the cards');
  // Between the toolbar and the cards: the page's first line (what a soul is; slice 3a, in place of About souls), then
  // the grid's stale-line host (desktop/loading-states), empty and display:none while the read is good.
  assert.equal(u.get('.souls-bar').nextElementSibling, u.get('.souls-lede'), 'the first line under the toolbar');
  assert.ok(u.get('.souls-lede').textContent.startsWith(spawn.SOULS_LEDE.split('. ')[0]), 'what a soul is');
  assert.match(u.get('.souls-lede').textContent, / You have \d+ souls?, (?:\d+|none) with agents running, grouped by where they come from; /, 'with the real counts (slice 3c)');
  assert.equal(u.get('.souls-lede').nextElementSibling, u.get('.souls-notice'), 'no repo-heading row before the cards');
  assert.equal(u.get('.souls-notice').childElementCount, 0); assert.equal(u.css('.souls-notice').display, 'none');
  assert.equal(u.get('.souls-notice').nextElementSibling, u.get('.souls-grid'));
  assert.equal(u.get('.repo-head'), null);
  assert.equal(u.css('.souls-body').display, 'grid');
  assert.equal(u.css('.souls-body').gridTemplateColumns, 'minmax(0,1fr)', 'no side column for a soul');
  assert.equal(u.css('.soul-inspector').width, '340px', 'the instance sidebar keeps its width');
  for (const selector of ['.workspace-header']) {
    assert.equal(u.css(selector).minHeight, '48px');
    assert.equal(u.css(selector).boxSizing, 'border-box');
    assert.equal(u.css(selector).paddingTop, '0px');
    assert.equal(u.css(selector).paddingBottom, '0px', 'no 32px control + 16px padding + 1px border = 49px conflict');
  }
  assert.equal(u.css('.workspace-header').flexWrap, 'nowrap', 'ordinary header controls shrink/scroll rather than breaking the 48px baseline');
  assert.equal(u.css('.workspace-tabs').flexWrap, 'nowrap');
  assert.equal(u.css('.workspace-tabs button').flexShrink, '0');
  assert.equal(u.css('.souls-bar .filter').height, '28px'); assert.equal(u.css('.souls-bar .filter').minHeight, '28px', 'generic 36px field floor is explicitly overridden');
  page.querySelector('.inspector-back').click(); await tick();
  assert.equal(u.get('.souls-grid').hidden, false); assert.equal(header.hidden, false, 'back restores the Workspace header');
  assert.equal(u.css('.souls-grid').padding, '0px 20px 16px', 'Workspace v4: groups start under the view toolbar');
  // Slice 3a: search first; no Group by and no "About souls" i. Grid | Table (v) sits beside the page's title since slice
  // 3c. Every group header opens its own section.
  assert.deepEqual([...u.get('.souls-bar').children].map(el => el.className), ['ws-search', 'ws-toolbar-lead souls-bar-lead', 'souls-sum workspace-sr-only', 'loading-status loading-sr souls-status']);
  assert.equal(u.get('.souls-view').parentElement, u.get('.workspace-title-row'));
  assert.deepEqual([...u.get('.souls-view').querySelectorAll('button')].map(b => [b.textContent, b.getAttribute('aria-pressed'), b.getAttribute('aria-keyshortcuts')]), [['Grid', 'true', 'V'], ['Table', 'false', 'V']], 'the grid is the default');
  assert.equal(u.get('.souls-bar-lead').childElementCount, 0, 'no group heading in the toolbar');
  const first = u.get('.souls-grid .souls-group');
  assert.equal(first.firstElementChild, first.querySelector('.souls-group-title')); assert.equal(first.getAttribute('aria-labelledby'), first.firstElementChild.id);
  assert.equal(u.css('.souls-group-cards').gap, '10px');
  assert.equal(u.get('.souls-bar').parentElement, main, 'the toolbar belongs to the view, not the header');
  assert.equal(header.querySelector('.souls-bar, input'), null, 'the header keeps only the tabs');
  assert.equal(u.get('.wssel').parentElement, header);
  assert.equal(u.get('.wssel').style.display, 'none', 'shell still owns its selector');
  assert.equal(u.css('.souls-bar').minHeight, '28px', 'one control row: no 48px bar floor');
  const rules = [...u.doc.styleSheets].flatMap(sheet => [...sheet.cssRules]);
  const responsive = rules.find(rule => rule.cssText.startsWith('@container (max-width:700px)') || rule.cssText.startsWith('@container (max-width: 700px)'));
  assert.ok(responsive, 'shipped container-width stacking rule');
  assert.match(responsive.cssText, /display:\s*block/, 'narrow intrinsic-height flow cannot shrink grid tracks under overflowing cards');
  assert.match(responsive.cssText, /overflow:\s*visible/);
  assert.doesNotMatch(inspectorCSS, /display:\s*contents|order:\s*-1|position:\s*absolute/);
});

test('03 (slice 3a): a card is one button: its name, what it does, its agents and its kind; it opens the soul page, which has New agent', async t => {
  const u = await fixture(t);
  const card = u.get('.soul-card');
  assert.equal(card.tagName, 'BUTTON'); assert.equal(card.type, 'button');
  assert.equal(card.getAttribute('aria-label'), 'dev');
  assert.equal(card.getAttribute('aria-description'), 'Build and review. No agents running. other soul');
  assert.equal(u.doc.getElementById(card.getAttribute('aria-controls')), u.get('.workspace-soul-page'), 'a card opens its soul\'s page');
  // The name, what it does, then a foot: its agents and its kind. No mark, no harness, no team chips, no Spawn.
  assert.deepEqual([...card.children].map(el => el.className), ['stitle', 'sdesc', 'sfoot']);
  assert.equal(card.querySelector('.stitle').textContent, 'dev'); assert.equal(card.querySelector('.sdesc').textContent, 'Build and review');
  assert.deepEqual([...card.querySelector('.sfoot').children].map(el => [el.className, el.textContent]), [['sactivity', 'No agents running'], ['skind', '· other']]);
  assert.doesNotMatch(card.textContent, /Works in|worktree|Pi\b/, 'the card does not say where the soul works nor its harness');
  assert.equal(card.querySelector('button'), null, 'no control nested inside the card button');
  assert.equal(card.parentElement.className, 'souls-group-cards', 'no tile: the card is the grid cell');
  assert.equal(u.get('.soul-spawn, .soul-tile, .glyph, .runtime-badge, .schip'), null);
  assert.equal(u.css('.sdesc').fontSize, 'var(--text-desc)'); assert.equal(u.css('.sdesc').webkitLineClamp || u.css('.sdesc').getPropertyValue('-webkit-line-clamp'), '2', 'two lines at most');
  card.focus(); card.dispatchEvent(new u.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await tick();
  for (const text of ['New agent', 'Files', 'Schedule…']) assert.ok([...u.get('.workspace-soul-page').querySelectorAll('button')].find(b => b.textContent === text), text);
  for (const text of ['Edit defaults', 'Edit instructions', 'Spawn']) assert.equal([...u.get('.workspace-soul-page').querySelectorAll('button')].some(b => b.textContent === text), false, `no ${text}`);
  assert.equal(u.get('.inspector-repository'), null, 'no "Edit this soul" block (human, F7)');
  assert.equal(u.get('.spawn-dialog'), null, 'keyboard inspection does not launch');
  // The soul page's New agent opens the scoped dialog; Escape closes it and focus returns to New agent.
  const newAgent = [...u.get('.workspace-soul-page').querySelectorAll('button')].find(b => b.textContent === 'New agent');
  assert.equal(newAgent.getAttribute('aria-label'), 'New agent of dev');
  newAgent.click(); await tick();
  assert.equal(u.get('.spawn-dialog').dataset.layout, 'scoped'); assert.equal(u.get('.spawn-dialog #spawn-dialog-title').textContent, 'Spawn dev');
  u.get('.spawn-dialog').dispatchEvent(new u.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await tick();
  assert.equal(u.get('.spawn-dialog'), null);
  assert.equal(u.doc.activeElement, newAgent, 'focus returns to New agent');
  u.click('Schedule…'); assert.deepEqual(u.views, ['automations'], 'Automations, on its Schedules subtab');
  u.get('.workspace-soul-page .inspector-back').click();
  assert.equal(u.doc.activeElement, u.get('.soul-card'), 'back returns to the roving card');
  assert.equal(u.css('.souls-body').gridTemplateColumns, 'minmax(0,1fr)');
});

// The Workspace page's tabs (the product owner, 2026-10-26): Souls | Capabilities | Teams | Machines | Setup, opening on
// Souls. Machines opens on its list of computers (slice 3b); its Map holds the Deployments view (views/hierarchy.mjs),
// mounted only while the Map is shown on the tab: chosen, or preselected (stage.hierarchy, ⌘1 / Ctrl+1: shell.mjs
// openWorkspaceSouls → preselectWorkspaceTab) once the Map was chosen.
test('Machines mounts the Deployments view while its Map is shown, and unmounts it on another tab; the page opens on Souls', async t => {
  const u = await fixture(t);
  assert.deepEqual([...u.doc.querySelectorAll('.workspace-tabs [role=tab]')].map(b => [b.id, b.firstChild.textContent, b.getAttribute('aria-selected')]) /* the label, before its count */, [
    ['workspace-tab-souls', 'Souls', 'true'], ['workspace-tab-capabilities', 'Capabilities', 'false'], ['workspace-tab-teams', 'Teams', 'false'],
    ['workspace-tab-machines', 'Machines', 'false'], ['workspace-tab-sources', 'Setup', 'false']]);
  assert.equal(u.get('#workspace-tab-automations'), null, 'no Automations tab: it is a page of its own');
  const panel = u.get('#workspace-machines');
  assert.ok(panel.classList.contains('workspace-machines-panel')); assert.equal(panel.getAttribute('role'), 'tabpanel');
  assert.equal(panel.getAttribute('aria-labelledby'), 'workspace-tab-machines');
  assert.equal(panel.hidden, true); assert.equal(panel.childElementCount, 0, 'not mounted while Souls is shown: it reads nothing');
  assert.equal(u.get('.souls-grid').hidden, false); assert.equal(u.get('.souls-bar').hidden, false);
  u.get('#workspace-tab-machines').click(); await tick();
  assert.equal(u.get('#workspace-tab-machines').getAttribute('aria-selected'), 'true');
  assert.equal(panel.hidden, true); assert.ok(u.get('.workspace-discovery section.machines'), 'the list of computers first');
  u.get('.workspace-tools[data-tools=machines] [data-machines-view=map]').click(); await tick();
  assert.equal(u.get('#workspace-tab-machines').getAttribute('aria-controls'), 'workspace-machines');
  assert.equal(panel.hidden, false); assert.ok(panel.querySelector('.hier'), 'the Deployments view, mounted');
  assert.ok(panel.querySelector('.hier-intro'), 'with its one sentence under the bar');
  assert.equal(u.get('.souls-grid').hidden, true); assert.equal(u.get('.souls-bar').hidden, true); assert.equal(u.get('.souls-notice').hidden, true);
  assert.equal(u.get('.workspace-discovery').hidden, true);
  u.get('#workspace-tab-souls').click(); await tick();
  assert.equal(panel.hidden, true); assert.equal(panel.childElementCount, 0, 'unmounted on another tab: it reads nothing in the background');
  assert.equal(u.get('.souls-grid').hidden, false); assert.equal(u.get('.souls-bar').hidden, false);
  // The shell's stage.hierarchy on the page already shown: its preselection chooses Machines.
  assert.equal(spawn.preselectWorkspaceTab('machines'), true); await tick();
  assert.equal(u.get('#workspace-tab-machines').getAttribute('aria-selected'), 'true');
  assert.equal(panel.hidden, false); assert.ok(panel.querySelector('.hier'), 'mounted again');
});

// A soul's Schedule… (the product owner, 2026-10-26: Automations is a page of its own again, no tab of the Workspace
// page): the view preselects Schedules and asks the shell for 'automations', which the shell loads as its own stage
// (shell.mjs showStage: no NAV_TABS route for it). Here the shell's load is played back: the Automations stage opens on
// Schedules, even when Triggers was the last subtab.
test("a soul's Schedule… asks the shell for the Automations page, which opens on Schedules", async t => {
  assert.equal(navTab('automations'), null, 'a page of its own, not a tab of one');
  assert.ok(NAV.some(v => v.name === 'automations'), 'a sidebar view');
  preselectAutomationsTab('trigger'); t.after(() => preselectAutomationsTab('schedule'));
  const kernelList = kind => JSON.parse(readFileSync(new URL(`./fixtures/automations/kernel/${kind}-list.json`, import.meta.url), 'utf8')).result;
  let stageHost = null;
  const u = await fixture(t, { cli: { ...CLI, scheduleApi: 2, automationsApi: 1, features: [...CLI.features, 'schedule', 'automations'] },
    automations: body => ({ automationsViewApi: 1, status: 'ok', kind: body.kind, action: body.action, result: kernelList(body.kind), reason: null }),
    route: (name, { doc, ctx }) => {
      if (navTab(name) || !NAV.some(v => v.name === name)) return;
      stageHost = doc.createElement('div'); doc.body.append(stageHost); automationsStage.mount(stageHost, ctx);
    } });
  try {
    u.get('.soul-card').click(); await tick();
    u.click('Schedule…'); for (let i = 0; i < 6; i++) await tick();
    assert.deepEqual(u.views, ['automations'], 'the view asked the shell for Automations');
    assert.equal(u.get('#workspace-tab-automations'), null, 'no tab of this page to switch to');
    assert.ok(stageHost, 'the shell loaded the Automations page');
    assert.equal(stageHost.querySelector('.auto-tabs [aria-selected=true]').id, 'automations-tab-schedule', 'on Schedules');
    assert.equal(stageHost.querySelector('.automations').dataset.kind, 'schedule');
  } finally { automationsStage.unmount(); }
});

// The Desktop UI rework, slice 3b (replaces W5's grid): one list of calm rows, names in the chrome's sans (D2).
test('slice 3b: the capability list is one column of rows — name, tags, who made it, one line; no grid, tiles, marks or pills', async t => {
  const u = await fixture(t, { cli: V2_CLI, sync: () => catalogReply() });
  u.get('#workspace-tab-capabilities').click(); await tick(); await tick();
  assert.equal(u.get('.discovery-tools'), null, 'no classic "Filter & scope" selector remains');
  assert.equal(u.get('.readiness-view, .deployment-inventory, .workspace-readiness-entry'), null, 'the 0.24 readiness/inventory blocks are gone');
  const header = u.get('.workspace-header');
  assert.equal(u.get('.ws-sync').closest('.workspace-header'), header, 'sync lives in the Workspace header (Setup tools)');
  // Slice 3c (the prototype's look): no box around the list, rows on the page with a hairline under each.
  assert.equal(u.css('.cap-list').display, 'flex'); assert.equal(u.css('button.cap-row').background, 'rgba(0, 0, 0, 0)');
  assert.equal(u.css('button.cap-row').minHeight, 'var(--row-h)'); assert.equal(u.css('button.cap-row').borderRadius, 'var(--radius-control)');
  const name = u.css('.cap-row-name');
  assert.deepEqual([name.fontWeight, name.fontSize], ['var(--name-weight)', 'var(--text-name)']);
  assert.equal(u.get('.cap-list .identity-mark, .cap-list .catalog-tile, .cap-list .source-chip'), null, 'no marks, tiles or package chips');
  assert.equal(u.get('.workspace-discovery').querySelectorAll('select, .catalog-pills, .capability-nav').length, 0, 'no dropdown, pills or section jump');
  assert.equal(u.css('.workspace-discovery[data-tab=capabilities] > *').maxWidth, '880px', 'one centred column');
  u.get('#workspace-tab-sources').click(); await tick();
  assert.equal(u.get('.workspace-discovery').querySelector('.cap-list button, .cap-list a, .cap-list input'), null, 'Sources are read-only');
  for (const { path, body } of u.calls.filter(c => c.body && c.path.startsWith('/api/workspace-sync'))) assert.equal(body.action, 'read', `no mutation from ${path}`);
});

for (const state of ['no operations', 'wrong API', 'rejection', 'pending', 'soul omitted']) test(`${state}: inspection never blocks otherwise compatible legacy Launch/Files`, async t => {
  const request = deferred();
  const u = await fixture(t, {
    cli: state === 'no operations' ? { ok: true, features: [] } : CLI,
    inspect: () => state === 'wrong API' ? { operationsApi: 0 } : state === 'soul omitted' ? { ...structuredClone(inspection), souls: [] }
      : state === 'rejection' ? Promise.reject(new Error('Reported inspection failure')) : request.promise,
  });
  u.get('.soul-card').click();
  const launch = u.get('.workspace-soul-page .spawn-act');
  assert.equal(launch.disabled, false, 'Launch is ready before any inspection await');
  u.click('Files'); assert.deepEqual(u.files, ['dev']);
  launch.click(); const modal = u.get('.spawn-dialog'); assert.ok(modal);
  modal.querySelector('.ftask').value = 'Retain my task';
  await tick();
  if (state === 'pending') { request.resolve(inspection); await tick(); }
  const diagnostic = u.get('.inspector-status').textContent;
  if (state === 'no operations') assert.match(diagnostic, /operations API 2/);
  if (state === 'wrong API') assert.match(diagnostic, /cannot read/);
  if (state === 'rejection') assert.match(diagnostic, /Reported inspection failure/);
  if (state === 'soul omitted') assert.match(u.get('.workspace-soul-page').textContent, /did not report this soul/);
  assert.equal(u.get('.spawn-dialog'), modal); assert.equal(modal.querySelector('.ftask').value, 'Retain my task');
  assert.equal(u.get('.workspace-soul-page .spawn-act'), launch, 'inspection does not replace the action opener');
  modal.querySelector('.fcancel').click(); assert.equal(u.doc.activeElement, launch);
  assert.equal(u.calls.some(c => c.path === '/api/spawn'), false, 'selection or opening Launch does not submit it');
  if (state === 'no operations') assert.equal(u.calls.some(c => c.path.startsWith('/api/capabilities')), false);
});

for (const cli of [null, { ok: false }]) test(`CLI ${JSON.stringify(cli)}: launch fails closed while roster Files and inspection diagnostics remain`, async t => {
  const u = await fixture(t, { cli });
  u.get('.soul-card').click();
  assert.equal(u.get('.spawn-act').disabled, true);
  assert.match(u.get('.spawn-act').title, cli === null ? /Checking/ : /compatible installed/);
  u.get('.spawn-act').dispatchEvent(new u.dom.window.Event('click')); assert.equal(u.get('.spawn-dialog'), null);
  u.click('Files'); assert.deepEqual(u.files, ['dev']);
  assert.match(u.get('.inspector-status').textContent, /operations API 2/);
  await u.setCli({ ok: true, features: [] });
  assert.equal(u.get('.spawn-act').disabled, false, 'CLI recovery enables Spawn without an operations request');
  u.get('.spawn-act').click(); assert.ok(u.get('.spawn-dialog'));
  await u.setCli({ ok: false });
  assert.equal(u.get('.spawn-dialog'), null); assert.equal(u.get('.spawn-act').disabled, true);
});

test('an empty catalog uses factual empty copy, and empty rosters never select or launch', async t => {
  const u = await fixture(t, { agents: [], cli: V2_CLI, sync: () => catalogReply([]) });
  assert.equal(u.get('.soul-card, .spawn-act'), null); assert.equal(u.get('.soul-inspector').hidden, true);
  u.get('#workspace-tab-capabilities').click(); await tick(); await tick();
  assert.match(u.get('.catalog-empty').textContent, /The workspace reports no capabilities/);
  assert.doesNotMatch(u.get('.workspace-discovery').textContent, /Installed capabilities|No capabilities installed/);
});

// F7: soul and capability PAGES in the Workspace view (instances keep the sidebar).
import { capabilityRow } from '../renderer/workspace-catalog.mjs';
const key = (u, el, name) => el.dispatchEvent(new u.dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));

test('F7: a Capabilities row opens its page (click or Enter) — "← Capabilities", the catalog facts, back or Esc returns to the focused row', async t => {
  const u = await fixture(t, { cli: V2_CLI, sync: () => catalogReply() });
  u.get('#workspace-tab-capabilities').click(); await tick(); await tick();
  const row = u.get('.workspace-discovery .cap-row[data-capability="oats.okf"]');
  assert.equal(row.localName, 'button');
  row.click();
  const page = u.get('.workspace-cap-page');
  assert.equal(page.hidden, false); assert.equal(u.get('.workspace-discovery').hidden, true, 'the page replaces the table');
  assert.equal(page.querySelector('.page-back').textContent, 'Capabilities');
  assert.equal(u.doc.activeElement, page.querySelector('.page-back'), 'focus moves into the page');
  // The page bar (back, breadcrumb), its name, then "Comes from" folded (slice 3b).
  assert.equal(page.querySelector('h2.page-title > span').textContent, 'oats.okf');
  assert.equal(page.querySelector('.page-crumb-current').textContent, 'oats.okf');
  assert.equal(page.querySelector('.page-crumb-current').getAttribute('aria-current'), 'page');
  const source = page.querySelector('details.cap-fold[data-fold="source"]');
  assert.equal(source.querySelector('summary').textContent, 'Comes from');
  const facts = Object.fromEntries([...source.querySelectorAll('dt')].map(dt => [dt.textContent, dt.nextElementSibling]));
  const catalogRow = f2('capabilities').result.capabilities.find(r => r.name === 'oats.okf');
  assert.equal(facts.Package.textContent, catalogRow.package); assert.match(facts.Pinned.textContent, new RegExp(`^${catalogRow.version.replace(/\./g, '\\.')}`));
  assert.equal(facts.Commit.textContent, catalogRow.commit.slice(0, 7)); assert.equal(facts.Commit.title, catalogRow.commit, 'the full commit stays reachable');
  assert.equal(Object.hasOwn(facts, 'Team'), false, 'the design has no team fact');
  assert.equal(page.querySelector('details.cap-fold[data-fold="as-soul"]'), null, 'no soul context from the catalog');
  page.querySelector('.page-back').click();
  assert.equal(page.hidden, true); assert.equal(page.childElementCount, 0); assert.equal(u.get('.workspace-discovery').hidden, false);
  assert.equal(u.doc.activeElement.dataset.capability, 'oats.okf', 'back returns to its row');
  // Enter is the native button's: a browser follows an uncancelled keydown with the button's click.
  const focused = u.doc.activeElement; assert.equal(focused.localName, 'button');
  if (key(u, focused, 'Enter')) focused.click();
  assert.equal(page.hidden, false, 'Enter opens it too (native activation: nothing cancels the key)');
  key(u, u.doc.activeElement, 'Escape');
  assert.equal(page.hidden, true, 'Esc goes back'); assert.equal(u.doc.activeElement.dataset.capability, 'oats.okf');
  // a tab change closes an open capability page
  u.get('.workspace-discovery .cap-row[data-capability="oats.okf"]').click();
  u.get('#workspace-tab-souls').click(); await tick();
  assert.equal(page.hidden, true); assert.equal(page.childElementCount, 0); assert.equal(u.get('.souls-grid').hidden, false);
});

test('v4.1: a row shows one line of its description and the page the whole of it; Back keeps the list\'s scroll offset and search', async t => {
  const long = 'Release tooling: cut, tag and publish a release from the agents repository, with the changelog, the version bump and the notes. '.repeat(3).trim();
  const rows = f2('capabilities').result.capabilities.map(r => r.name === 'nw-release-tooling' ? { ...r, description: long } : r);
  const u = await fixture(t, { cli: V2_CLI, sync: () => catalogReply(rows) });
  u.get('#workspace-tab-capabilities').click(); await tick(); await tick();
  const list = u.get('.workspace-discovery');
  const desc = list.querySelector('.cap-row[data-capability="nw-release-tooling"] .cap-row-desc');
  assert.equal(desc.textContent, long); assert.equal(u.css('.cap-row-desc').whiteSpace, 'nowrap'); assert.equal(u.css('.cap-row-desc').textOverflow, 'ellipsis');
  // A search, then scroll the list.
  const search = list.querySelector('.ws-search input'); search.value = 'nw-'; search.dispatchEvent(new u.dom.window.Event('input', { bubbles: true }));
  const shown = () => [...list.querySelectorAll('.cap-list .cap-row')].map(r => r.dataset.capability);
  const before = shown();
  assert.ok(before.includes('nw-release-tooling') && !before.includes('oats.okf'));
  list.scrollTop = 180;
  list.querySelector('.cap-row[data-capability="nw-release-tooling"]').click();
  const page = u.get('.workspace-cap-page');
  assert.equal(page.hidden, false); assert.ok(page.querySelector('.page-lede'), 'the page leads with the description');
  assert.equal(page.querySelector('.page-lede').textContent, long, 'the whole description, not the row\'s one line');
  list.scrollTop = 0; // Chromium drops a display:none scroller's offset
  page.querySelector('.page-back').click();
  assert.equal(list.hidden, false); assert.equal(list.scrollTop, 180, 'back to where the list was');
  assert.equal(list.querySelector('.ws-search input').value, 'nw-');
  assert.deepEqual(shown(), before, 'the same rows');
  assert.equal(u.doc.activeElement.dataset.capability, 'nw-release-tooling');
});

// The Desktop UI rework, slice 3a (replaces W4's two tables): a soul's capabilities are one list of rows, core first
// with a dim "core" tag, each its name, "by <source>" and one line of what it does; a row opens the capability as the
// soul resolves it, and back returns to that row.
test('slice 3a: a soul page lists its capabilities as one list of rows, core first; a row opens the capability as the soul resolves it, back returns to the soul', async t => {
  const described = f2('capabilities').result.capabilities.map(r => ({ ...r, description: `About ${r.name}.` }));
  const u = await fixture(t, { cli: V2_CLI, sync: () => catalogReply(described) });
  u.get('.soul-card').click(); await tick(); await tick();
  const soulPage = u.get('.workspace-soul-page');
  assert.equal(soulPage.querySelector('.inspector-core-table, .inspector-capability-table, .soul-caps, .core-card'), null, 'no tables and no cards');
  const lists = soulPage.querySelectorAll('.soul-capabilities ul.cap-list');
  assert.equal(lists.length, 1);
  const rows = [...lists[0].querySelectorAll('.cap-row')];
  const coreIds = ['knowledge', 'messaging', 'tasks'].map(slot => inspection.layers[slot]?.id).filter(Boolean);
  const others = inspection.capabilities.filter(c => !coreIds.includes(c.id) && !['knowledge', 'messaging', 'tasks'].includes(c.layer)).map(c => c.id);
  assert.deepEqual(rows.slice(0, coreIds.length).map(r => r.dataset.capability), coreIds, 'core first, in slot order');
  assert.deepEqual(rows.slice(coreIds.length).map(r => r.dataset.capability).sort(), [...others].sort(), 'then every other capability, once');
  for (const row of rows) {
    const core = coreIds.includes(row.dataset.capability);
    assert.equal(row.querySelector('.cap-tag')?.textContent ?? null, core ? 'core' : null, `${row.dataset.capability}: the core tag on core rows only`);
    // Slice 3b's rule (capability-origin.mjs), as on the Capabilities page: official, or "by <source>"; the workspace's
    // own repository (agents.git, the host) is named too.
    const cap = inspection.capabilities.find(c => c.id === row.dataset.capability), origin = row.querySelector('.cap-origin');
    if (cap.from?.kind === 'member' && cap.from.repoKey === 'local//fixture/base/fx/remotes/agents.git') assert.match(origin.textContent, /^by \S/, `${cap.id}: the host repository, named`);
    else assert.ok(origin.dataset.official === 'true' || /^by \S/.test(origin.textContent), `${cap.id}: where it comes from`);
    assert.equal(row.querySelector('.cap-tag[data-tag^=default]'), null, `${cap.id}: no "default" tag on a soul's row`);
  }
  const first = others[0], line = rows.find(r => r.dataset.capability === first);
  const listed = described.filter(r => r.name === first);
  if (listed.length === 1) assert.equal(line.querySelector('.cap-row-desc').textContent, `About ${first}.`, 'one line of what it does, from the catalog');
  line.click();
  const cap = u.get('.workspace-cap-page');
  assert.equal(cap.hidden, false); assert.equal(soulPage.hidden, true);
  assert.equal(cap.querySelector('.page-back').textContent, 'dev');
  // Slice 2b (E): the whole way there, Home first, each part above this page a link.
  assert.deepEqual([...cap.querySelectorAll('.page-crumbs > :not(.page-crumb-sep)')].map(s => s.textContent), ['Home', 'Workspace', 'Souls', 'dev', first]);
  assert.deepEqual([...cap.querySelectorAll('.page-crumbs > button.page-crumb-link')].map(s => s.textContent), ['Home', 'Workspace', 'Souls', 'dev']);
  const resolved = cap.querySelector('details.cap-fold[data-fold="as-soul"]');
  assert.equal(resolved.querySelector('summary').textContent, 'As dev resolves it');
  assert.ok(resolved, 'what the soul resolves');
  assert.match(resolved.textContent, /Missing/);
  key(u, u.doc.activeElement, 'Escape');
  assert.equal(cap.hidden, true); assert.equal(soulPage.hidden, false, 'back to the soul\'s page');
  assert.equal(u.doc.activeElement.dataset.capability, first);
});

// Spec A: with layers-from and desktop-facts, the capability page opened from a soul's row repeats why it is there in
// its "As <soul> resolves it" card; focus comes back to the row. A slot the soul empties is said under the list.
test('a core row and a capability row open their page with the soul page\'s reason as a "Why" row', async t => {
  const facts = structuredClone(inspection);
  facts.layers = { knowledge: { id: 'oats.okf', from: 'workspace' }, messaging: { id: null, from: null }, tasks: { id: null, from: null } };
  for (const cap of facts.capabilities) cap.composedFrom = cap.id === 'nw-release-tooling' ? 'soul' : 'workspace';
  facts.capabilitiesOff = [{ id: 'oats.aweb', off: true, from: 'soul', reason: 'slot-none', slot: 'messaging', overrides: 'workspace' }];
  const u = await fixture(t, { cli: { ...V2_CLI, features: [...V2_CLI.features, 'layers-from', 'desktop-facts'] }, inspect: () => facts, sync: () => catalogReply() });
  u.get('.soul-card').click(); await tick(); await tick();
  const soulPage = u.get('.workspace-soul-page');
  const list = soulPage.querySelector('.soul-capabilities .cap-list');
  const knowledge = list.querySelector('.cap-row[data-capability="oats.okf"]');
  assert.equal(knowledge.querySelector('.cap-tag').textContent, 'core');
  assert.match(knowledge.title, /Resolves the workspace default|A workspace default|workspace/i, 'why it is here, in its title');
  assert.equal(list.querySelector('[data-capability="oats.aweb"]'), null, 'the emptied slot is not a row');
  assert.equal(soulPage.querySelector('.soul-capabilities-note').textContent, 'no messaging capability · no tasks capability');
  const why = () => { const row = u.get('.workspace-cap-page [data-fact="why"]'); return row && [row.querySelector('.page-why-label').textContent, row.querySelector('.page-why-note').textContent]; };
  knowledge.focus(); knowledge.click();
  assert.equal(u.get('.workspace-cap-page').hidden, false);
  assert.deepEqual(why(), ['Workspace default · knowledge', "dev doesn't choose a knowledge capability; it resolves the workspace's default."]);
  key(u, u.doc.activeElement, 'Escape');
  assert.equal(u.doc.activeElement.dataset.capability, 'oats.okf', 'back to the core row');
  u.get('.soul-capabilities .cap-row[data-capability="nw-release-tooling"]').click();
  assert.deepEqual(why(), ['Declared by the soul', 'dev declares it.']);
  key(u, u.doc.activeElement, 'Escape');
  u.get('.soul-capabilities .cap-row[data-capability="nw-house-style"]').click();
  assert.deepEqual(why(), ['Workspace default', "dev doesn't declare it; it resolves the workspace's default."]);
});

test('F7: capabilityRow maps an inspected capability onto the catalog row shape (reported facts only)', () => {
  const pkg = inspection.capabilities.find(c => c.from?.kind === 'package');
  const row = capabilityRow(pkg);
  assert.equal(row.name, pkg.id); assert.equal(row.kind, 'package'); assert.equal(row.package, pkg.from.package); assert.equal(row.commit, pkg.from.commit);
  assert.equal(Object.hasOwn(row, 'team'), false, 'inspect reports no team');
  assert.equal(row.resolved, pkg);
  const member = inspection.capabilities.find(c => c.from?.kind === 'member');
  if (member) { const m = capabilityRow(member); assert.equal(m.kind, 'member'); assert.equal(m.repoKey, member.from.repoKey); }
  assert.equal(capabilityRow({ id: 'x', from: { kind: 'weird' } }).kind, 'external');
});

// Kernel #217 via the server pass-through (#230): the /api/agents facts, from the real capture.
const factsSouls = JSON.parse(readFileSync(new URL('./fixtures/workspace-v2/desktop-facts/souls.json', import.meta.url), 'utf8')).result.souls;
const factsRow = (name, extra = {}) => { const k = factsSouls.find(r => r.name === name); return { ...soul, name, spawnable: k.spawnable, problem: k.problem, file: k.file, ...extra }; };
const FACTS_CLI = { ...CLI, features: ['operations', 'desktop-facts'] };

test('kernel #217: a soul a spawn here would refuse says why on its card and on its page (Ready); New agent is disabled', async t => {
  const refused = factsRow('campaign-writer'), message = refused.problem.message;
  assert.equal(refused.problem.code, 'E_SOUL_DISABLED', 'the capture disables campaign-writer on this machine');
  const u = await fixture(t, { cli: FACTS_CLI, agents: [soul, refused], inspect: body => soulInspection(body.selector.soul),
    instances: [{ instance: 'campaign-writer-1', agent: 'campaign-writer', agentsRoot: refused.agentsRoot, running: true, home: '/h/cw-1' }] });
  const card = name => u.get(`.soul-card[data-agent="${name}"]`);
  assert.equal(card('dev').querySelector('.sproblem'), null);
  assert.equal(card('campaign-writer').querySelector('.sproblem').textContent, `Can't spawn here · ${message}`);
  assert.match(card('campaign-writer').getAttribute('aria-description'), new RegExp(`Can't spawn here · ${message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  // Refusing new agents stops none already running: the card keeps their count, under the refusal.
  assert.deepEqual([...card('campaign-writer').children].map(el => el.className), ['stitle', 'sdesc', 'sproblem', 'sfoot']);
  assert.equal(card('campaign-writer').querySelector('.sfoot .sactivity').textContent, '1 agent running');
  assert.match(card('campaign-writer').getAttribute('aria-description'), /1 agent running/);
  // The table says it in its Ready column; a soul a spawn would not refuse is Ready.
  u.get('.souls-view [data-view="table"]').click();
  const ready = name => u.get(`.soul-row-open[data-agent="${name}"]`).closest('tr').cells[5];
  assert.equal(ready('dev').textContent, 'Ready'); assert.equal(ready('campaign-writer').textContent, message);
  assert.equal(ready('campaign-writer').className, 'problem');
  u.get('.souls-view [data-view="grid"]').click();
  card('campaign-writer').click(); await tick(); await tick();
  assert.equal(u.get('.soul-ready-line').textContent, message, 'Ready: the one problem, in one sentence');
  assert.ok(u.get('.soul-ready-line').classList.contains('problem'));
  assert.match(u.get('.soul-ready-problems').textContent, /E_SOUL_DISABLED/, 'its code behind Details');
  const spawnAct = u.get('.spawn-act'); assert.equal(spawnAct.disabled, true); assert.equal(spawnAct.title, `Can't spawn here: ${message}`);
});

test("kernel #217: a soul's file opens as its web page, or shows its path when the repo has none", async t => {
  const local = factsRow('data-analyst'), url = 'https://github.com/northwind/agents/blob/abc/souls/release-manager/soul.yaml';
  assert.equal(local.file.url, null, 'the capture\'s repos are local: no web address');
  const hosted = factsRow('release-manager', { file: { path: 'souls/release-manager/soul.yaml', url } });
  const u = await fixture(t, { cli: FACTS_CLI, agents: [local, hosted] });
  const opened = []; u.ctx.openExternal = link => opened.push(link);
  u.get('.soul-card[data-agent="data-analyst"]').click(); await tick(); await tick();
  assert.equal(u.get('.file-act'), null); assert.equal(u.get('.page-fact[data-fact="file"]').textContent, local.file.path);
  u.get('.page-back').click(); await tick();
  u.get('.soul-card[data-agent="release-manager"]').click(); await tick(); await tick();
  assert.equal(u.get('.page-fact[data-fact="file"]'), null);
  u.get('.file-act').click(); assert.deepEqual(opened, [url]);
});

test('kernel #217 facts are ignored from a CLI that does not report desktop-facts', async t => {
  const u = await fixture(t, { agents: [factsRow('campaign-writer')] });
  assert.equal(u.get('.sproblem'), null);
  u.get('.souls-view [data-view="table"]').click();
  const ready = u.get('.soul-row-open').closest('tr').cells[5];
  assert.equal(ready.textContent, '—', 'no claim either way'); assert.equal(ready.className, 'muted');
});

test("kernel #217: a capability opened from a soul page adds the catalog's facts for it (description)", async t => {
  const described = f2('capabilities').result.capabilities.map(r => ({ ...r, description: `About ${r.name}.` }));
  const u = await fixture(t, { cli: V2_CLI, sync: () => catalogReply(described) });
  u.get('.soul-card').click(); await tick(); await tick();
  const coreIds = new Set(Object.values(inspection.layers).map(l => l?.id).filter(Boolean));
  const other = inspection.capabilities.find(c => !coreIds.has(c.id) && described.filter(r => r.name === c.id).length === 1);
  assert.ok(other, 'a composed capability the catalog lists once');
  u.get(`.soul-capabilities .cap-row[data-capability="${other.id}"]`).click();
  const cap = u.get('.workspace-cap-page');
  assert.equal(cap.querySelector('.page-lede').textContent, `About ${other.id}.`);
  assert.ok(cap.querySelector('details.cap-fold[data-fold="as-soul"]'), 'the soul\'s resolution still there');
});

// Review round 1: one readiness rule for the card, the table and the page: the kernel's refusal holds for an attached
// soul too; only its own launch report is not what runs it.
test('soulReadiness: a refusal holds for an attached soul; an attached soul\'s launch report is not its problem; no claim without desktop-facts', () => {
  const facts = { features: ['desktop-facts'] };
  const refused = { name: 'reviewer', work: 'attached', spawnable: false, problem: { message: 'Requires an owning instance.', code: 'E_SOUL_ATTACHED' } };
  assert.deepEqual(spawn.soulReadiness(refused, facts), { ready: false, text: 'Requires an owning instance.' });
  assert.deepEqual(spawn.soulProblem(refused, facts), { text: 'Requires an owning instance.', line: "Can't spawn here · Requires an owning instance." });
  assert.deepEqual(spawn.soulReadiness({ name: 'reviewer', work: 'attached', spawnable: true }, facts), { ready: true, text: 'Ready' });
  assert.equal(spawn.soulReadiness(refused, { features: [] }), null, 'this OATS does not say: no claim');
});

// Review round 2: a catalog read that lands while a capability page covers the soul page still reaches its rows: Back
// shows each capability's one line, and focus returns to the row that opened the capability.
test('a catalog that lands while a capability page covers the soul page: Back shows the rows\' descriptions, focus on the row', async t => {
  const held = deferred();
  const described = f2('capabilities').result.capabilities.map(r => ({ ...r, description: `About ${r.name}.` }));
  const u = await fixture(t, { cli: V2_CLI, sync: () => held.promise });
  u.get('.soul-card').click(); await tick(); await tick();
  const soulPage = u.get('.workspace-soul-page');
  assert.equal(soulPage.querySelectorAll('.cap-row-desc').length, 0, 'no catalog yet: no line');
  soulPage.querySelector('.cap-row[data-capability="nw-house-style"]').click(); await tick();
  assert.equal(soulPage.hidden, true, 'the capability page covers it');
  held.resolve(catalogReply(described)); await tick(); await tick(); await tick();
  key(u, u.doc.activeElement, 'Escape'); await tick();
  assert.equal(soulPage.hidden, false);
  assert.equal(soulPage.querySelector('.cap-row[data-capability="nw-house-style"] .cap-row-desc')?.textContent, 'About nw-house-style.');
  assert.equal(u.doc.activeElement?.dataset.capability, 'nw-house-style', 'focus back on the row');
});

// The Desktop UI rework, slice 2b, Amendment 1, E (Pepe, 2026-11-20: "El navigation dintre de home un cop has entrat a
// souls o algun altre es raro. En plan no pots tornar al home."): the way back is on every Workspace page.
const trail = el => [...el.querySelectorAll(':scope > :not(.page-crumb-sep):not([aria-hidden=true])')].map(part => [part.textContent, part.tagName === 'BUTTON' ? 'link' : 'here']);
test('slice2b breadcrumb on every workspace page', async t => {
  const u = await fixture(t);
  // A tab: Home › Workspace › Souls, above the tab bar; the section is the page's h1.
  const head = u.get('.workspace-title');
  assert.equal(head.tagName, 'NAV'); assert.equal(head.getAttribute('aria-label'), 'Breadcrumb');
  assert.equal(head.nextElementSibling, u.get('.workspace-header'), 'above the tab bar');
  assert.deepEqual(trail(head), [['Home', 'link'], ['Workspace', 'link'], ['Souls', 'here']]);
  assert.equal(head.querySelector('h1').getAttribute('aria-current'), 'page');
  u.get('#workspace-tab-capabilities').click(); await tick();
  assert.equal(head.querySelector('h1').textContent, 'Capabilities', 'it follows the tab');
  // Workspace goes to the page's first tab, with the focus on its control.
  [...head.querySelectorAll('button')].find(b => b.textContent === 'Workspace').click(); await tick();
  assert.equal(u.get('#workspace-tab-souls').getAttribute('aria-selected'), 'true'); assert.equal(u.doc.activeElement, u.get('#workspace-tab-souls'));
  // A soul's page: its own bar carries the trail one level deeper; the head hides.
  u.get('.soul-card').click(); await tick();
  const page = u.get('.workspace-soul-page');
  assert.equal(page.hidden, false); assert.equal(head.hidden, true);
  assert.deepEqual(trail(page.querySelector('.page-crumbs')), [['Home', 'link'], ['Workspace', 'link'], ['Souls', 'link'], ['dev', 'here']]);
  // Its Workspace link: the page closes, the Souls list shows.
  [...page.querySelectorAll('.page-crumbs button')].find(b => b.textContent === 'Workspace').click(); await tick();
  assert.equal(page.hidden, true); assert.equal(u.get('.souls-grid').hidden, false); assert.equal(head.hidden, false);
  // Its Souls link is Back: one level up.
  u.get('.soul-card').click(); await tick();
  [...page.querySelectorAll('.page-crumbs button')].find(b => b.textContent === 'Souls').click(); await tick();
  assert.equal(page.hidden, true); assert.equal(u.doc.activeElement, u.get('.soul-card'), 'back on the card it came from');
  // Home, from the head.
  [...head.querySelectorAll('button')].find(b => b.textContent === 'Home').click();
  assert.deepEqual(u.views, ['home']);
});

test('slice2b home reachable from a soul page in one click and by esc twice', async t => {
  const u = await fixture(t);
  u.get('.soul-card').click(); await tick();
  const page = u.get('.workspace-soul-page');
  // One click: the bar's Home.
  [...page.querySelectorAll('.page-crumbs button')].find(b => b.textContent === 'Home').click();
  assert.deepEqual(u.views, ['home']);
  // Esc twice: the soul's page, then the Workspace page (the shell's shipped listener on its stage host: Esc nothing on
  // the page took goes to Home).
  const shell = readFileSync(new URL('../renderer/shell.mjs', import.meta.url), 'utf8');
  const listener = shell.match(/stageHost\.addEventListener\("keydown", \(e\) => \{[^]*?\n\}\);/)[0];
  const went = [];
  const { runInNewContext } = await import('node:vm');
  runInNewContext(listener, { stageHost: u.get('#host'), stage: { name: 'spawn' }, Element: u.dom.window.Element, showStageFocused: name => went.push(name) });
  u.get('.soul-card').click(); await tick();
  key(u, u.doc.activeElement, 'Escape'); await tick();
  assert.equal(page.hidden, true, 'the first Esc: up to Souls'); assert.deepEqual(went, []);
  assert.equal(u.doc.activeElement, u.get('.soul-card'));
  key(u, u.doc.activeElement, 'Escape');
  assert.deepEqual(went, ['home'], 'the second Esc: Home');
});
