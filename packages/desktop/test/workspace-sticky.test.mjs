// Spec G item 3: Workspace's tab row and each tab's top-level controls stay in view while the content
// scrolls. jsdom has no layout or scrolling: these tests pin the CSSOM (sticky position and top, the
// opaque background, scroll-margin-top on the jump and focus targets, the contained view and its one
// scroller per tab) and drive sticky-top.mjs with stubbed geometry. The browser behaviour — the header
// top unchanged and no ancestor or document scroll after scrolling to the end by wheel, End and
// PageDown, at a normal and a short window — was verified live over CDP on the rig.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import * as spawn from '../renderer/views/spawn.mjs';
import { currentWorkspace, setWorkspace } from '../renderer/views/common.mjs';
import { refreshCli } from '../renderer/views/cli-status.mjs';
import { workspaceStatusData, teamsData } from '../../client/deployment-data.mjs';
import { discoveryCSS } from '../renderer/workspace-discovery.mjs';
import { createComputerTeams } from '../renderer/computer-teams.mjs';
import { trackStickyTop, trackScrolledEdge } from '../renderer/sticky-top.mjs';
import { inspectorCSS } from '../renderer/soul-inspector.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const themeCss = read('../renderer/theme.css'), shellCss = read('../renderer/shell.css'), loadingCss = read('../renderer/loading.css');
const tick = () => new Promise(resolve => setImmediate(resolve));
const f2 = name => JSON.parse(read(`./fixtures/workspace-v2/f2/${name}.json`));
const CLI = { ok: true, operationsApi: 2, bin: '/fixture/bin/oats', workspaceApi: 2, relations: true, features: ['operations', 'workspace-v2', 'capabilities-private'] };
const observedStatus = workspaceStatusData(f2('workspace-status'), '/fixture/base/northwind-workspace');
const catalogReply = () => ({ workspaceSyncApi: 1, status: 'ok', capabilities: { capabilitiesApi: 1, ...f2('capabilities').result } });
const soul = { name: 'dev', agentsRoot: '/fixture/agents', repoName: 'fixture', runtime: 'pi', work: 'worktree', description: 'Build and review' };

async function mountWorkspace(t) {
  const dom = new JSDOM('<body><div id="host"></div></body>', { url: 'http://localhost' });
  const doc = dom.window.document;
  const saved = { document: globalThis.document, window: globalThis.window, setInterval: globalThis.setInterval, ws: currentWorkspace() };
  for (const text of [themeCss, shellCss]) { const style = doc.createElement('style'); style.textContent = text; doc.head.append(style); }
  globalThis.document = doc; globalThis.window = dom.window; globalThis.setInterval = () => 0;
  setWorkspace('/fixture');
  await refreshCli({ api: async () => CLI });
  const ctx = { hasWorkspaceSwitcher: true, openBrain() {}, openView() {},
    api: async (path) => {
      if (path === '/api/cli') return CLI;
      if (path.startsWith('/api/agents')) return { agents: [soul] };
      if (path.startsWith('/api/panel')) return { instances: [], workspace: { id: currentWorkspace() }, workspaces: [{ id: '/fixture', name: 'Fixture' }],
        deployment: { status: 'observed', root: '/fixture/agents', workspace: observedStatus.workspace, workspaceStatus: observedStatus, reachable: { reachable: true }, withheld: [] } };
      if (path.startsWith('/api/workspace-sync')) return catalogReply();
      if (path.startsWith('/api/servers')) return { servers: [] };
      throw new Error(`Unexpected fixture request: ${path}`);
    } };
  t.after(() => { spawn.unmount(); setWorkspace(saved.ws); globalThis.document = saved.document; globalThis.window = saved.window; globalThis.setInterval = saved.setInterval; dom.window.close(); });
  spawn.mount(doc.querySelector('#host'), ctx); await tick();
  return { dom, doc, get: s => doc.querySelector(s), css: el => dom.window.getComputedStyle(typeof el === 'string' ? doc.querySelector(el) : el) };
}

const opaqueBg = () => {
  for (const [name, block] of [['dark', /:root, \[data-theme="dark"\] \{([\s\S]*?)\n\}/], ['light', /\[data-theme="light"\] \{([\s\S]*?)\n\}/], ['solarized', /\[data-theme="solarized"\] \{([\s\S]*?)\n\}/]]) {
    assert.match(themeCss.match(block)[1], /--bg: #[0-9a-f]{6};/i, `${name} --bg is an opaque colour, so nothing shows through a pinned block`);
  }
};

test('Capabilities: the search is one sticky block, flush at the top on the opaque page background; the list scrolls under it', async t => {
  const u = await mountWorkspace(t);
  u.get('#workspace-tab-capabilities').click(); await tick(); await tick();
  const panel = u.get('.workspace-discovery'), block = u.get('.workspace-discovery > .ws-toolbar');
  assert.equal(panel.dataset.tab, 'capabilities');
  assert.ok(block.classList.contains('ws-sticky'));
  assert.equal(u.get('.cap-list').closest('.ws-sticky'), null, 'the list is not pinned');
  assert.ok(block.querySelector('.ws-search input'), 'and the search');
  assert.equal(panel.firstElementChild, block, 'the block opens the scroller');
  const style = u.css(block);
  assert.equal(style.position, 'sticky');
  assert.equal(style.top, 'calc(-1 * var(--ws-pad-top))', 'pinned at -padding: Chromium insets sticky boxes by the scroller padding');
  assert.match(u.css(panel).getPropertyValue('--ws-pad-top').trim(), /^16px$/);
  assert.match(discoveryCSS, /\.workspace-discovery\[data-tab=capabilities\] \{ --ws-pad-top:16px; padding:var\(--ws-pad-top\) 28px 20px; \}/, 'the pin offset is the padding it undoes');
  assert.match(style.background, /var\(--bg\)/, 'a solid page background behind the controls');
  opaqueBg();
  assert.match(style.borderBottom, /^1px solid (transparent|rgba\(0, 0, 0, 0\))$/, 'the edge is always there, transparent at rest: sticking never changes the height');
  assert.equal(style.marginTop, '-8px'); assert.equal(style.paddingTop, '8px');
  assert.equal(style.paddingBottom, '8px'); assert.equal(style.marginBottom, '7px', 'still 16px to the content below, edge included');
  block.classList.add('is-stuck');
  assert.equal(u.css(block).borderBottomColor, 'var(--border)');
});

test('Capabilities: rows keep clear of the pinned block (scroll-margin-top = its height)', async t => {
  const u = await mountWorkspace(t);
  u.get('#workspace-tab-capabilities').click(); await tick(); await tick();
  const targets = [...u.doc.querySelectorAll('.cap-row')];
  assert.ok(targets.length >= 3, 'rows rendered');
  for (const target of targets) assert.equal(u.css(target).scrollMarginTop, 'var(--ws-sticky-h, 60px)', target.className);
});

test('sticky-top: .is-stuck appears only once content has scrolled under the block, and --ws-sticky-h follows its height', () => {
  const dom = new JSDOM('<div id="scroller"><div class="ws-sticky" id="block"></div><div id="content"></div></div>');
  const doc = dom.window.document, scroller = doc.getElementById('scroller'), block = doc.getElementById('block');
  let blockTop = 8;
  scroller.getBoundingClientRect = () => ({ top: 100, bottom: 900, height: 800 });
  block.getBoundingClientRect = () => ({ top: 100 + blockTop, bottom: 100 + blockTop + 53, height: 53 });
  const tracker = trackStickyTop(scroller); tracker.sync();
  assert.equal(block.classList.contains('is-stuck'), false, 'at rest: no edge');
  assert.equal(scroller.style.getPropertyValue('--ws-sticky-h'), '53px');
  scroller.scrollTop = 4; blockTop = 4; scroller.dispatchEvent(new dom.window.Event('scroll'));
  assert.equal(block.classList.contains('is-stuck'), false, 'still travelling up to its pin: no edge yet');
  scroller.scrollTop = 400; blockTop = 0; scroller.dispatchEvent(new dom.window.Event('scroll'));
  assert.equal(block.classList.contains('is-stuck'), true, 'pinned with content under it: the edge');
  scroller.scrollTop = 0; blockTop = 8; scroller.dispatchEvent(new dom.window.Event('scroll'));
  assert.equal(block.classList.contains('is-stuck'), false, 'back at the top: the edge goes');
  block.hidden = true; tracker.sync();
  assert.equal(block.classList.contains('is-stuck'), false, 'a hidden block never keeps its edge');
  tracker.dispose();
});

test('Souls: the bar sits outside the one scroller; the grid gets its top edge only while scrolled', async t => {
  const u = await mountWorkspace(t);
  assert.equal(u.get('#workspace-tab-souls').getAttribute('aria-selected'), 'true', 'the page opens on Souls');
  assert.equal(u.get('.souls-grid').hidden, false); assert.equal(u.get('.souls-bar').hidden, false);
  const grid = u.get('.souls-grid'), bar = u.get('.souls-bar');
  assert.equal(grid.contains(bar), false, 'the search and Group by never scroll');
  assert.equal(u.get('.workspace-header').contains(grid), false);
  assert.equal(u.css(grid).overflowY, 'auto'); assert.equal(u.css(grid).overscrollBehavior, 'contain');
  assert.match(u.css(grid).borderTop, /^1px solid (transparent|rgba\(0, 0, 0, 0\))$/);
  assert.equal(grid.classList.contains('is-scrolled'), false);
  grid.scrollTop = 120; grid.dispatchEvent(new u.dom.window.Event('scroll'));
  assert.equal(grid.classList.contains('is-scrolled'), true);
  assert.equal(u.css(grid).borderTopColor, 'var(--border)');
  grid.scrollTop = 0; grid.dispatchEvent(new u.dom.window.Event('scroll'));
  assert.equal(grid.classList.contains('is-scrolled'), false);
  // The standalone helper behaves the same on any scroller.
  const other = u.doc.createElement('div'), edge = trackScrolledEdge(other);
  other.scrollTop = 5; other.dispatchEvent(new u.dom.window.Event('scroll'));
  assert.equal(other.classList.contains('is-scrolled'), true); edge.dispose();
});

test('Teams: the page head ("Teams" + Add a team on this computer) is the pinned block; its sections scroll', async t => {
  const capture = JSON.parse(read('./fixtures/team-model-v2/teams-after.json'));
  const dom = new JSDOM('<!doctype html><body><main class="oats-view"><section class="workspace-discovery" data-tab="teams"><div></div></section></main></body>');
  const doc = dom.window.document;
  for (const text of [themeCss, discoveryCSS]) { const style = doc.createElement('style'); style.textContent = text; doc.head.append(style); }
  const page = createComputerTeams(doc, { request: async () => teamsData(capture, '/fixture/base/northwind-workspace'), instances: () => [] });
  doc.querySelector('.workspace-discovery > div').append(page.element);
  t.after(() => { page.dispose(); dom.window.close(); });
  for (let i = 0; i < 6; i++) await tick();
  const head = doc.querySelector('.ct-page-head'), style = dom.window.getComputedStyle(head);
  assert.ok(head.classList.contains('ws-sticky'));
  assert.ok([...head.querySelectorAll('button')].some(b => b.textContent.includes('Add a team on this computer')));
  assert.equal(style.position, 'sticky'); assert.equal(style.top, 'calc(-1 * var(--ws-pad-top))');
  assert.match(style.background, /var\(--bg\)/);
  assert.equal(style.paddingBottom, '8px'); assert.equal(style.marginBottom, '-9px', 'the page keeps its 18px gap below the head');
  assert.equal(dom.window.getComputedStyle(doc.querySelector('.workspace-discovery')).getPropertyValue('--ws-pad-top').trim(), '20px');
  assert.equal(doc.querySelector('.ct-section-head')?.closest('.ws-sticky') ?? null, null, 'section heads scroll normally');
  const focusables = [...doc.querySelectorAll('.ct-body button')];
  assert.ok(focusables.length, 'the page has focusable controls below the head');
  for (const el of focusables) assert.equal(dom.window.getComputedStyle(el).scrollMarginTop, 'var(--ws-sticky-h, 60px)');
});

test('the Workspace view is one fixed column that can never scroll; the document never scrolls either', async t => {
  const u = await mountWorkspace(t);
  const view = u.css('.souls');
  assert.equal(view.position, 'relative', 'anything positioned that escapes a scroller is contained by the view');
  assert.equal(view.overflow, 'clip', 'and clipped there: the view itself is not a scroll container');
  assert.equal(view.height, '100%'); assert.match(view.minHeight, /^0(px)?$/);
  const discovery = u.css('.workspace-discovery');
  assert.equal(discovery.position, 'relative'); assert.equal(discovery.overflow, 'auto');
  assert.equal(discovery.overscrollBehavior, 'contain'); assert.match(discovery.minHeight, /^0(px)?$/);
  assert.equal(u.get('.workspace-header').parentElement, u.get('.workspace-main'), 'the header is outside every scroller');
  for (const scroller of [u.get('.souls-grid'), u.get('.workspace-discovery')]) assert.equal(scroller.contains(u.get('.workspace-header')), false);
  // The Machines tab's Map (the product owner, 2026-10-26; slice 3b put it behind List | Map): its panel fills the
  // column under the header, which it never holds; the Deployments view in it scrolls inside itself.
  u.get('#workspace-tab-machines').click(); await tick();
  u.get('.workspace-tools[data-tools=machines] [data-machines-view=map]').click(); await tick();
  const machines = u.get('#workspace-machines');
  assert.equal(machines.hidden, false); assert.equal(machines.contains(u.get('.workspace-header')), false);
  assert.equal(machines.parentElement, u.get('.workspace-main'));
  const panel = u.css(machines);
  assert.equal(panel.display, 'flex'); assert.equal(panel.flexDirection, 'column'); assert.match(panel.minHeight, /^0(px)?$/);
  // The app shell: html clips at the viewport; the body is positioned and clipped, so an absolute
  // element with no positioned ancestor is contained by it and cannot stretch the document.
  assert.equal(u.css(u.doc.documentElement).overflow, 'clip');
  const body = u.css(u.doc.body);
  assert.equal(body.position, 'relative'); assert.equal(body.overflow, 'clip'); assert.equal(body.height, '100%');
});

test('narrow: the Workspace keeps its fixed header and one scroller per tab; only the side inspector stacks and scrolls with the list', async t => {
  // jsdom evaluates no container queries: soul-inspector's narrow block is applied unwrapped to model a
  // container at most 700px wide (the rule the rig showed scrolling the whole view, header included).
  const narrow = inspectorCSS.match(/@container\(max-width:700px\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(narrow, 'the narrow block exists');
  const u = await mountWorkspace(t);
  const style = u.doc.createElement('style'); style.textContent = narrow; u.doc.head.append(style);
  const body = u.get('.souls-body');
  assert.equal(body.classList.contains('inspecting'), false);
  assert.notEqual(u.css(body).display, 'block', 'no side inspector: the view keeps its layout');
  assert.doesNotMatch(u.css(body).overflow, /auto|scroll/, 'and .souls-body never scrolls the header away');
  const main = u.css('.workspace-main');
  assert.equal(main.display, 'flex'); assert.equal(main.flexDirection, 'column'); assert.match(main.minHeight, /^0(px)?$/);
  // jsdom does not expand the overflow shorthand: each is read in the form it is declared.
  for (const [selector, property] of [['.souls-grid', 'overflowY'], ['.workspace-discovery', 'overflow']]) {
    assert.equal(u.css(selector)[property], 'auto', `${selector} is still its tab's scroller`);
    assert.match(u.css(selector).minHeight, /^0(px)?$/, `${selector} can shrink in its flex column`);
  }
  // With the side inspector shown, the narrow view stacks it under the list and the two scroll together.
  body.classList.add('inspecting');
  assert.equal(u.css(body).display, 'block'); assert.equal(u.css(body).overflow, 'auto');
  assert.equal(u.css('.workspace-discovery').overflow, 'visible');
});

test('every visually-hidden utility is anchored at its containing block, so it cannot stretch a scroller', () => {
  const sources = { 'views/spawn.mjs': read('../renderer/views/spawn.mjs'), 'workspace-discovery.mjs': read('../renderer/workspace-discovery.mjs'), 'loading.css': loadingCss,
    'shell.css': read('../renderer/shell.css') };
  const rules = [];
  for (const [file, text] of Object.entries(sources)) for (const [, rule, body] of text.matchAll(/(\.[\w-]*(?:sr-only|-sr))\s*\{([^}]*)\}/g)) rules.push({ file, rule, body });
  assert.deepEqual(rules.map(r => `${r.file} ${r.rule}`).sort(), ['loading.css .loading-sr', 'shell.css .sr-only', 'views/spawn.mjs .workspace-sr-only', 'workspace-discovery.mjs .workspace-sr-only']);
  for (const { file, rule, body } of rules) {
    for (const decl of [/position:\s*absolute/, /top:\s*0/, /left:\s*0/, /width:\s*1px/, /height:\s*1px/, /overflow:\s*hidden/, /clip-path:\s*inset\(50%\)/, /white-space:\s*nowrap/, /margin:\s*-1px/]) {
      assert.match(body, decl, `${file} ${rule} has ${decl}`);
    }
  }
});
