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
  assert.equal(main.firstElementChild, header);
  // No "On <deployment>" line under the header: the Workspace pages do not name the deployment they read (the
  // product owner, 2026-10-23; #482's rule, docs/desktop-deployment-model.md); the side panel and Deployments do.
  assert.equal(header.nextElementSibling, u.get('.workspace-recovery'));
  assert.equal(main.querySelector('.deployment-scope'), null);
  assert.equal(u.get('.workspace-recovery').hidden, true, 'compatible CLI adds no visible row before the cards');
  // Workspace v4 (human decision 2026-09-26; replaces the header-placed filter): the
  // search and Team/Repo control are the view's own toolbar, directly above the cards.
  assert.equal(u.get('.workspace-recovery').nextElementSibling, u.get('.souls-bar'), 'the Souls toolbar sits in the view, before the cards');
  // Between the toolbar and the cards only the grid's stale-line host (desktop/loading-states), empty and display:none while the read is good.
  assert.equal(u.get('.souls-bar').nextElementSibling, u.get('.souls-notice'), 'no repo-heading row before the cards');
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
  // Workspace v4.1 (board 3): search first, then Group by (Repo, Team), then the "About souls" i (2026-10-23);
  // every group header opens its own section.
  assert.deepEqual([...u.get('.souls-bar').children].map(el => el.className), ['ws-search', 'ws-toolbar-lead souls-bar-lead', 'ws-toolbar-label', 'ws-segmented souls-group-by', 'ws-info-button', 'souls-sum workspace-sr-only', 'loading-status loading-sr souls-status']);
  assert.deepEqual([...u.get('.souls-group-by').querySelectorAll('button')].map(b => [b.textContent, b.getAttribute('aria-pressed')]), [['Repo', 'true'], ['Team', 'false']], 'Repo is the default');
  assert.equal(u.get('.souls-bar-lead').childElementCount, 0, 'no group heading in the toolbar');
  const first = u.get('.souls-grid .souls-group');
  assert.equal(first.firstElementChild, first.querySelector('.souls-group-title')); assert.equal(first.getAttribute('aria-labelledby'), first.firstElementChild.id);
  assert.equal(u.css('.souls-group-cards').gap, '14px');
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

test('03: cards have one semantic Details entry with compact identity, description, teams and a foot (the harness only as reported)', async t => {
  const u = await fixture(t);
  const card = u.get('.soul-card');
  assert.equal(card.tagName, 'BUTTON'); assert.equal(card.type, 'button');
  assert.equal(card.getAttribute('aria-label'), 'Inspect dev');
  assert.equal(u.doc.getElementById(card.getAttribute('aria-controls')), u.get('.workspace-soul-page'), 'a card opens its soul\'s page');
  // Workspace v4.1 (board 3): a body (head: mark, name, harness; the description; labelled chips) and a foot.
  assert.deepEqual([...card.children].map(el => el.className), ['sbody', 'sfoot']);
  // No team reported: no team chip invented; and no work-mode chip (human, 2026-09-29), so no chip row at all.
  assert.deepEqual([...card.querySelector('.sbody').children].map(el => el.className), ['sname', 'sdesc']);
  assert.doesNotMatch(card.textContent, /Works in|worktree/, 'the card does not say where the soul works');
  assert.equal(card.querySelector('button, .sactions'), null, 'no control nested inside the card button');
  // Workspace v4 (human, 2026-09-26; replaces "launch only from an opened soul"): each
  // spawnable card has a Spawn button beside it in one grid cell, which roves with its card.
  const tile = card.parentElement, spawn = tile.querySelector(':scope > .soul-spawn');
  assert.equal(tile.className, 'soul-tile can-spawn'); assert.equal(u.css('.soul-tile').display, 'grid');
  assert.equal(spawn.textContent, 'Spawn'); assert.equal(spawn.getAttribute('aria-label'), 'Spawn dev');
  assert.equal(spawn.tabIndex, card.tabIndex, 'Spawn enters the tab order with its card');
  assert.equal(spawn.disabled, false);
  spawn.click(); await tick(); assert.ok(u.get('.spawn-dialog'), 'Spawn opens the spawn dialog for that soul, without opening its page');
  assert.equal(u.get('.workspace-soul-page').hidden, true);
  // Board 6: scoped to that soul — its preview column, no soul picker, "Spawn dev" and Change soul.
  const dialog = u.get('.spawn-dialog');
  assert.equal(dialog.dataset.layout, 'scoped'); assert.equal(dialog.querySelector('.spawn-chooser').hidden, true); assert.equal(dialog.querySelector('.spawn-preview').hidden, false);
  assert.equal(dialog.querySelector('#spawn-dialog-title').textContent, 'Spawn dev'); assert.equal(dialog.querySelector('.spawn-change-soul').hidden, false);
  assert.equal(u.doc.activeElement, dialog.querySelector('.ftask'), 'the first field, the Opening instruction, takes the focus');
  u.get('.spawn-dialog').dispatchEvent(new u.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await tick();
  assert.equal(u.get('.spawn-dialog'), null, 'Escape closes it');
  assert.equal(u.doc.activeElement, u.get('.soul-tile > .soul-spawn'), 'focus returns to the Spawn button that opened it');
  assert.equal(u.css('.soul-card').padding, '0px');
  assert.equal(u.css('.sdesc').fontSize, '12.5px'); assert.equal(u.css('.sdesc').webkitLineClamp || u.css('.sdesc').getPropertyValue('-webkit-line-clamp'), '2', 'two lines at most');
  assert.equal(u.css('.glyph').width, '32px'); assert.equal(u.css('.glyph').height, '32px'); assert.equal(u.css('.glyph').borderRadius, '8px');
  // The harness appears only as the roster reports it on the soul row (this fixture: pi, no launch): no model claimed.
  assert.equal(u.get('.scontext').textContent, 'Pi');
  assert.equal(u.get('.soul-card .runtime-badge').getAttribute('aria-label'), 'Harness: Pi');
  // The foot: what runs (never the bare word "none") in one 48px row under a hairline that spans the card.
  assert.equal(u.get('.soul-card .sactivity').textContent, 'No instances');
  const foot = u.css('.soul-card .sfoot');
  assert.equal(foot.boxSizing, 'border-box'); assert.equal(foot.height, '49px'); assert.equal(foot.alignItems, 'center');
  assert.equal(foot.paddingTop, '0px'); assert.equal(foot.paddingBottom, '0px');
  const shippedCSS = [...u.doc.querySelectorAll('style')].map(style => style.textContent).join('\n');
  assert.match(shippedCSS, /\.soul-card \.sfoot \{[^}]*border-top:1px solid var\(--border\)/, 'a 1px border hairline');
  assert.equal(u.css('.soul-card .sfoot').marginTop, 'auto');
  // The button (human, 2026-09-29: smaller, on the instances' line, clear of the hairline): 24px,
  // secondary (surface + 1px border), centred in the 48px row: 12px above it, 12px + the card's
  // 1px edge below it.
  const button = u.css('.soul-tile > .soul-spawn');
  assert.equal(button.boxSizing, 'border-box'); assert.equal(button.height, '24px'); assert.equal(button.marginBottom, '13px'); assert.equal(button.background, 'var(--surface)');
  assert.equal((48 - parseInt(button.height)) / 2 + 1, parseInt(button.marginBottom), 'the button shares the row\'s centre line');
  assert.match(shippedCSS, /button\.soul-spawn \{[^}]*border:1px solid var\(--border\)/);

  const fresh = u.get('.soul-card'); // closing the dialog repaints the grid
  fresh.focus(); fresh.dispatchEvent(new u.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await tick();
  for (const text of ['Spawn', 'Files', 'Schedule…']) assert.ok([...u.get('.workspace-soul-page').querySelectorAll('button')].find(b => b.textContent === text), text);
  for (const text of ['Edit defaults', 'Edit instructions']) assert.equal([...u.get('.workspace-soul-page').querySelectorAll('button')].some(b => b.textContent === text), false, `${text}: a v2 soul is edited in its repository`);
  assert.equal(u.get('.inspector-repository'), null, 'no "Edit this soul" block (human, F7)');
  assert.equal(u.get('.spawn-dialog'), null, 'keyboard inspection does not launch');
  // The soul page's Spawn opens the same scoped dialog.
  [...u.get('.workspace-soul-page').querySelectorAll('button')].find(b => b.textContent === 'Spawn').click(); await tick();
  assert.equal(u.get('.spawn-dialog').dataset.layout, 'scoped'); assert.equal(u.get('.spawn-dialog #spawn-dialog-title').textContent, 'Spawn dev');
  u.get('.spawn-dialog').dispatchEvent(new u.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await tick();
  assert.equal(u.get('.spawn-dialog'), null);
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
test('slice 3b: the capability list is one bordered column of rows — name, tags, who made it, one line; no grid, tiles, marks or pills', async t => {
  const u = await fixture(t, { cli: V2_CLI, sync: () => catalogReply() });
  u.get('#workspace-tab-capabilities').click(); await tick(); await tick();
  assert.equal(u.get('.discovery-tools'), null, 'no classic "Filter & scope" selector remains');
  assert.equal(u.get('.readiness-view, .deployment-inventory, .workspace-readiness-entry'), null, 'the 0.24 readiness/inventory blocks are gone');
  const header = u.get('.workspace-header');
  assert.equal(u.get('.ws-sync').closest('.workspace-header'), header, 'sync lives in the Workspace header (Setup tools)');
  assert.equal(u.css('.cap-list').display, 'flex'); assert.equal(u.css('.cap-list').borderRadius, '10px');
  assert.equal(u.css('button.cap-row').minHeight, '54px'); assert.equal(u.css('button.cap-row').padding, '9px 16px');
  const name = u.css('.cap-row-name');
  assert.deepEqual([name.fontWeight, name.fontSize], ['600', '13.5px']);
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

// Replaces the F7 test that pinned the Capabilities view's table on the soul
// page: Workspace v4 (W4) shows core capabilities and the rest as two tables of
// one grammar (Core capability / Capability | Source | Why it's here).
test('W4: a soul page shows its core capabilities and the rest in one row grammar with why each is there; a row opens the capability as the soul resolves it, back returns to the soul', async t => {
  const u = await fixture(t, { cli: V2_CLI, sync: () => catalogReply() });
  u.get('.soul-card').click(); await tick(); await tick();
  const soulPage = u.get('.workspace-soul-page');
  const coreTable = soulPage.querySelector('.inspector-core-table .soul-caps.soul-core');
  assert.ok(coreTable, 'the Core capabilities table, in the composition table\'s grid');
  assert.deepEqual([...coreTable.querySelectorAll('.soul-cap-row:not(.head)')].map(c => c.dataset.layer), ['knowledge', 'messaging', 'tasks'], 'one row per core slot');
  assert.equal(soulPage.querySelector('.core-card'), null, 'no cards');
  assert.ok(coreTable.querySelector('.soul-cap-row[data-layer="knowledge"] .source-chip.boxed'), 'the same source chip');
  const coreIds = new Set(Object.values(inspection.layers).map(l => l?.id).filter(Boolean));
  const table = soulPage.querySelector('.inspector-capability-table .soul-caps');
  assert.ok(table, 'the composition table');
  assert.deepEqual([...table.querySelectorAll('.soul-cap-row.head span')].map(s => s.textContent), ['Capability', 'Source', "Why it's here"]);
  const others = inspection.capabilities.filter(c => !coreIds.has(c.id)).map(c => c.id);
  assert.deepEqual([...table.querySelectorAll('.soul-cap-row:not(.head)')].map(r => r.dataset.capability).sort(), [...others].sort(), 'every non-core capability, once');
  assert.equal(soulPage.querySelector('.cap-list, .inspector-cap-row'), null, 'neither the catalog list nor the old per-soul list');
  for (const row of table.querySelectorAll('.soul-cap-row:not(.head)')) assert.ok(row.querySelector('.why-tag, .why-note'), `${row.dataset.capability} says why it is here`);
  const first = others[0];
  table.querySelector(`.soul-cap-row[data-capability="${first}"]`).click();
  const cap = u.get('.workspace-cap-page');
  assert.equal(cap.hidden, false); assert.equal(soulPage.hidden, true);
  assert.equal(cap.querySelector('.page-back').textContent, 'dev');
  assert.deepEqual([...cap.querySelectorAll('.page-crumbs > span:not(.page-crumb-sep)')].map(s => s.textContent), ['Workspace', 'Souls', 'dev', first]);
  const resolved = cap.querySelector('details.cap-fold[data-fold="as-soul"]');
  assert.equal(resolved.querySelector('summary').textContent, 'As dev resolves it');
  assert.ok(resolved, 'what the soul resolves');
  assert.match(resolved.textContent, /Missing/);
  key(u, u.doc.activeElement, 'Escape');
  assert.equal(cap.hidden, true); assert.equal(soulPage.hidden, false, 'back to the soul\'s page');
  assert.equal(u.doc.activeElement.dataset.capability, first);
});

// Spec A: with layers-from and desktop-facts the soul page's Core rows say why, and the capability page
// opened from either table repeats it in its "As <soul> resolves it" card; focus comes back to the row.
test('a core row and a capability row open their page with the soul page\'s reason as a "Why" row', async t => {
  const facts = structuredClone(inspection);
  facts.layers = { knowledge: { id: 'oats.okf', from: 'workspace' }, messaging: { id: null, from: null }, tasks: { id: null, from: null } };
  for (const cap of facts.capabilities) cap.composedFrom = cap.id === 'nw-release-tooling' ? 'soul' : 'workspace';
  facts.capabilitiesOff = [{ id: 'oats.aweb', off: true, from: 'soul', reason: 'slot-none', slot: 'messaging', overrides: 'workspace' }];
  const u = await fixture(t, { cli: { ...V2_CLI, features: [...V2_CLI.features, 'layers-from', 'desktop-facts'] }, inspect: () => facts, sync: () => catalogReply() });
  u.get('.soul-card').click(); await tick(); await tick();
  const soulPage = u.get('.workspace-soul-page');
  const knowledge = soulPage.querySelector('.soul-core .soul-cap-row[data-layer="knowledge"]');
  assert.equal(knowledge.querySelector('.why-tag').textContent, 'workspace');
  assert.equal(knowledge.querySelector('.soul-cap-why-note').textContent, "Resolves the workspace default: this soul doesn't choose a knowledge capability");
  const messaging = soulPage.querySelector('.soul-core .soul-cap-row[data-layer="messaging"]');
  assert.equal(messaging.querySelector('.soul-cap-id').textContent, 'None'); assert.equal(messaging.querySelector('.soul-cap-why-note').textContent, 'This soul empties the messaging slot; the workspace default is oats.aweb');
  assert.equal(messaging.querySelector('.why-note').textContent, 'turned off by soul');
  assert.equal(soulPage.querySelector('.soul-core .soul-cap-row[data-layer="tasks"] .why-note').textContent, 'No default');
  const caps = soulPage.querySelector('.inspector-capability-table .soul-caps');
  assert.equal(caps.querySelector('[data-capability="oats.aweb"]'), null, 'the emptied slot is not a Capabilities row');
  const why = () => { const row = u.get('.workspace-cap-page [data-fact="why"]'); return row && [row.querySelector('.page-why-label').textContent, row.querySelector('.page-why-note').textContent]; };
  knowledge.focus(); knowledge.click();
  assert.equal(u.get('.workspace-cap-page').hidden, false);
  assert.deepEqual(why(), ['Workspace default · knowledge', "dev doesn't choose a knowledge capability; it resolves the workspace's default."]);
  key(u, u.doc.activeElement, 'Escape');
  assert.equal(u.doc.activeElement.dataset.focusKey, 'core:knowledge', 'back to the core row');
  caps.querySelector('[data-capability="nw-release-tooling"]').click();
  assert.deepEqual(why(), ['Declared by the soul', 'dev declares it.']);
  key(u, u.doc.activeElement, 'Escape');
  caps.querySelector('[data-capability="nw-house-style"]').click();
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

test('kernel #217: a soul a spawn here would refuse says why on its card and page; Spawn is disabled', async t => {
  const refused = factsRow('campaign-writer'), message = refused.problem.message;
  assert.equal(refused.problem.code, 'E_SOUL_DISABLED', 'the capture disables campaign-writer on this machine');
  const u = await fixture(t, { cli: FACTS_CLI, agents: [soul, refused], instances: [{ instance: 'campaign-writer-1', agent: 'campaign-writer', agentsRoot: refused.agentsRoot, running: true, home: '/h/cw-1' }] });
  const tile = name => u.get(`.soul-card[data-agent="${name}"]`).parentElement;
  assert.equal(tile('dev').querySelector('.sproblem'), null);
  assert.equal(tile('campaign-writer').querySelector('.sproblem').textContent, `Can't spawn here · ${message}`);
  // The refusal does not hide what runs: its count is a second, muted line in the same fixed-height foot.
  const lines = tile('campaign-writer').querySelector('.sfoot > .sfoot-lines');
  assert.deepEqual([...lines.children].map(el => [el.className, el.textContent]), [['sproblem', `Can't spawn here · ${message}`], ['sactivity running', '1 instance running']]);
  const cw = '.soul-card[data-agent="campaign-writer"]';
  assert.equal(u.css(`${cw} .sfoot-lines .sactivity`).color, 'var(--muted)'); assert.equal(u.css(`${cw} .sfoot-lines`).flexDirection, 'column');
  assert.equal(u.css(`${cw} .sfoot`).height, '49px', 'the foot keeps its height, so a row of cards does not jump');
  assert.equal(u.css('.soul-card[data-agent="dev"] .sfoot').height, '49px');
  const button = tile('campaign-writer').querySelector('.soul-spawn');
  assert.equal(button.disabled, true); assert.equal(button.title, `Can't spawn here: ${message}`);
  assert.equal(tile('dev').querySelector('.soul-spawn').disabled, false);
  u.get('.soul-card[data-agent="campaign-writer"]').click(); await tick(); await tick();
  assert.equal(u.get('.inspector-refusal').textContent, `Can't spawn here · ${message}`);
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
  assert.equal(u.get('.sproblem'), null); assert.equal(u.get('.soul-spawn').disabled, false);
});

test("kernel #217: a capability opened from a soul page adds the catalog's facts for it (description)", async t => {
  const described = f2('capabilities').result.capabilities.map(r => ({ ...r, description: `About ${r.name}.` }));
  const u = await fixture(t, { cli: V2_CLI, sync: () => catalogReply(described) });
  u.get('.soul-card').click(); await tick(); await tick();
  const coreIds = new Set(Object.values(inspection.layers).map(l => l?.id).filter(Boolean));
  const other = inspection.capabilities.find(c => !coreIds.has(c.id) && described.filter(r => r.name === c.id).length === 1);
  assert.ok(other, 'a composed capability the catalog lists once');
  u.get(`.soul-cap-row[data-capability="${other.id}"]`).click();
  const cap = u.get('.workspace-cap-page');
  assert.equal(cap.querySelector('.page-lede').textContent, `About ${other.id}.`);
  assert.ok(cap.querySelector('details.cap-fold[data-fold="as-soul"]'), 'the soul\'s resolution still there');
});
