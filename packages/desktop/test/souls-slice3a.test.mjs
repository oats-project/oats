// The Desktop UI rework, slice 3a: Souls (grid and table) and a soul's page (pinned acceptance tests).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { soulKind, compareSouls, SOUL_KINDS } from '../../client/soul-kind.mjs';
import { createSoulInstructions, SOUL_INSTRUCTIONS_COPY, OWN, COMPOSED } from '../renderer/soul-instructions.mjs';
import { createSoulInspector } from '../renderer/soul-inspector.mjs';
import { setWorkspace, currentWorkspace } from '../renderer/views/common.mjs';

const tick = () => new Promise(r => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
const CLI_OK = { ok: true, bin: '/seed/oats', version: '0.18.0', source: 'path', required: { desktopApi: 1, range: '>=0.18.0 <0.21.0' }, probedAt: 1, tried: [] };
const HOST = 'github.com/acme/agents';

/* ── the souls list ──────────────────────────────────────────────────────── */
const member = (name, over = {}) => ({ name, agentsRoot: '/w/agents', description: `${name} does its job`, work: 'worktree', soulKind: 'member', repo: HOST, repoName: 'agents', ...over });
const packaged = (pkg, name) => member(name, { soulKind: 'package', package: pkg, version: '1.0.0', repo: `github.com/acme/${pkg}`, repoName: `package ${pkg}`, key: `${pkg}/${name}` });
const SOULS = [
  member('zed-developer'), member('acme-oats-setup-expert'), member('notes'), member('lane-maintainer'), member('acme-expert'), member('desk-developer'),
  packaged('oats.okf', 'knowledge-harvester'), packaged('oats.okf', 'okf-expert'),
  packaged('oats.engineering', 'code-reviewer'), packaged('oats.engineering', 'review-maintainer'),
];

async function mountSouls(t, { storage = null, souls = SOULS } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id=host></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
  const oldDoc = globalThis.document, oldWin = globalThis.window, oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  globalThis.document = dom.window.document; globalThis.window = dom.window;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage ?? dom.window.localStorage });
  const spawn = await import('../renderer/views/spawn.mjs');
  const cli = await import('../renderer/views/cli-status.mjs');
  await cli.refreshCli({ api: async () => ({ ok: true, status: 200, json: async () => CLI_OK }) });
  const ctx = {
    api(pathname) {
      if (pathname === '/api/cli' || pathname === '/api/cli/reprobe') return Promise.resolve(CLI_OK);
      if (pathname.startsWith('/api/agents')) return Promise.resolve({ agents: structuredClone(souls), catalog: {} });
      if (pathname.startsWith('/api/panel')) return Promise.resolve({ instances: [
        { instance: 'desk-developer-1', agent: 'desk-developer', agentsRoot: '/w/agents', running: true, home: '/w/a/1' },
        { instance: 'desk-developer-2', agent: 'desk-developer', agentsRoot: '/w/agents', running: false, home: '/w/a/2' },
      ], workspace: { id: 'w' }, workspaces: [],
      deployment: { status: 'observed', workspaceStatus: { workspace: { key: HOST }, members: [] } } });
      if (pathname.startsWith('/api/capabilities')) return Promise.resolve({ operationsApi: 2, capabilities: [] });
      return Promise.resolve({});
    },
    openTerminal: () => {},
  };
  spawn.mount(dom.window.document.getElementById('host'), ctx);
  await settle();
  const unmount = () => spawn.unmount();
  t.after(() => {
    try { spawn.unmount(); } finally {
      globalThis.document = oldDoc; globalThis.window = oldWin;
      if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage); else delete globalThis.localStorage;
      dom.window.close();
    }
  });
  const doc = dom.window.document;
  const key = (target, k) => { const e = new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }); target.dispatchEvent(e); return e; };
  return { dom, doc, spawn, ctx, unmount, key, $: s => doc.querySelector(s), $$: s => [...doc.querySelectorAll(s)] };
}

test('slice3a kind rule', () => {
  const cases = {
    'oats-maintainer': 'maintainer', 'joan-product-maintainer': 'maintainer',
    'oats-expert': 'expert', 'oats-desktop-expert': 'expert', 'research-expert': 'expert',
    'oats-desktop-developer': 'developer', 'oats-kernel-developer': 'developer',
    'oats-oats-setup-expert': 'operations', 'acme-operator': 'operations', 'ops-admin': 'operations', 'site-operations': 'operations',
    'oats.okf/knowledge-harvester': 'other', 'oats.engineering/code-reviewer': 'other', 'notes': 'other', 'expert-notes': 'other',
    'Platform_Developer': 'developer', 'oats.engineering/review-maintainer': 'maintainer',
  };
  for (const [name, kind] of Object.entries(cases)) assert.equal(soulKind({ name }), kind, name);
  assert.equal(soulKind('oats-expert'), 'expert', 'a bare name reads the same');
  assert.deepEqual(SOUL_KINDS, ['maintainer', 'expert', 'developer', 'operations', 'other']);
  assert.deepEqual(['b-developer', 'z', 'a-expert', 'c-maintainer', 'x-setup-expert', 'a-developer'].map(name => ({ name })).sort(compareSouls).map(s => s.name),
    ['c-maintainer', 'a-expert', 'a-developer', 'b-developer', 'x-setup-expert', 'z']);
});

test('slice3a souls grouped by source and sorted by kind', async t => {
  const u = await mountSouls(t);
  const groups = u.$$('.souls-group').map(g => [g.querySelector('.souls-group-name').textContent, [...g.querySelectorAll('.soul-card .stitle')].map(c => c.textContent)]);
  assert.deepEqual(groups, [
    ['agents', ['lane-maintainer', 'acme-expert', 'desk-developer', 'zed-developer', 'acme-oats-setup-expert', 'notes']],
    ['oats.engineering 1.0.0', ['review-maintainer', 'code-reviewer']],
    ['oats.okf 1.0.0', ['okf-expert', 'knowledge-harvester']],
  ], 'the host repository first, then each package; maintainers, experts, developers, operations, the rest');
  const card = u.$('.soul-card[data-agent="desk-developer"]');
  assert.equal(card.querySelector('.sdesc').textContent, 'desk-developer does its job', 'what it does');
  assert.equal(card.querySelector('.sactivity').textContent, '1 agent running', 'how many agents of it run');
  assert.equal(card.querySelector('.skind').textContent, '· developer', 'its kind');
  assert.equal(u.$('.soul-card[data-agent="notes"] .sactivity').textContent, 'No agents running');
});

test('slice3a souls view toggle remembered', async t => {
  const store = new Map();
  const storage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => { store.set(k, String(v)); }, removeItem: k => { store.delete(k); } };
  const u = await mountSouls(t, { storage });
  assert.ok(u.$('.soul-card'), 'a grid by default');
  assert.equal(u.$('.souls-view [data-view="grid"]').getAttribute('aria-pressed'), 'true');
  const card = u.$('.soul-card[data-agent="acme-expert"]'); card.focus();
  const v = u.key(card, 'v');
  assert.equal(v.defaultPrevented, true, 'v is the view key');
  assert.equal(u.$('.soul-card'), null, 'the grid is gone');
  const table = u.$('table.souls-table');
  assert.ok(table, 'a table');
  assert.deepEqual([...table.querySelectorAll('thead th')].map(th => th.textContent), ['Name', 'What it does', 'Kind', 'Agents running', 'Harness · model', 'Ready']);
  assert.equal(u.doc.activeElement?.dataset.agent, 'acme-expert', 'the same soul keeps focus in the table');
  const row = u.$('.soul-row-open[data-agent="desk-developer"]').closest('tr');
  assert.deepEqual([...row.cells].map(c => c.textContent), ['desk-developer', 'desk-developer does its job', 'developer', '1', '—', '—']);
  assert.equal(u.$('.souls-view [data-view="table"]').getAttribute('aria-pressed'), 'true');
  // A reload: the view comes back as it was left.
  u.unmount();
  const host = u.doc.getElementById('host');
  u.spawn.mount(host, u.ctx); await settle();
  assert.ok(u.$('table.souls-table'), 'the table again after a reload');
  assert.equal(u.$('.soul-card'), null);
  // And v back to the grid, remembered too.
  const first = u.$('.soul-row-open'); first.focus(); u.key(first, 'v');
  assert.ok(u.$('.soul-card'));
  u.unmount(); u.spawn.mount(host, u.ctx); await settle();
  assert.ok(u.$('.soul-card'), 'the grid after another reload');
});

test('slice3a no spawn button, no about dialog, no group by team on souls', async t => {
  const u = await mountSouls(t);
  assert.ok(u.$$('.soul-card').length >= SOULS.length);
  assert.equal(u.$('.soul-spawn'), null, 'no Spawn on a card');
  assert.equal(u.$$('.souls button').filter(b => /^\s*Spawn\b/.test(b.textContent)).length, 0, 'no Spawn button anywhere on Souls');
  assert.equal(u.$('#workspace-souls-about, .souls-bar .ws-info-button, [aria-controls="workspace-souls-about"]'), null, 'no About souls');
  assert.equal(u.$('.souls-group-by, [data-group-by]'), null, 'no Group by');
  assert.equal(u.$$('.souls-bar button').some(b => /team/i.test(b.textContent)), false, 'no Team grouping');
});

/* ── a soul's page ───────────────────────────────────────────────────────── */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/workspace-v2/f7/inspect-soul.json', import.meta.url), 'utf8')).result;
const agentsRoot = '/fixture/base/northwind-workspace/agents';
const selection = name => ({ agent: { name, agentsRoot }, selector: { soul: name, agentsRoot } });
const OWN_TEXT = '# Release manager\n\nShips releases. See [the skill](skills/ship/SKILL.md).\n\n## Usage\n\nRun it.\n\n## Limits\n\nNone.\n';
const SKILLS = [{ name: 'ship', path: 'skills/ship', description: 'Ships a release.', filesTruncated: false,
  files: [{ path: 'skills/ship/SKILL.md', bytes: 20, text: '# Ship\n\nShip it.\n', binary: false, truncated: false }] }];
function composedAnswer(own) {
  const blocks = [['capability:nw-deploy', 'capabilities/nw-deploy/injects/x.md', '<!-- oats:capability:nw-deploy -->\n## Deploying\n\nDeploy well.\n<!-- /oats:capability:nw-deploy -->\n'],
    ['capability:oats.okf', null, '<!-- oats:capability:oats.okf -->\n## Knowledge\n\nKeep notes.\n<!-- /oats:capability:oats.okf -->\n']];
  let text = own; const body = { start: 0, end: own.length, truncated: false }, sources = [];
  for (const [source, file, block] of blocks) { sources.push({ source, file, start: text.length, end: text.length + block.length, truncated: false }); text += block; }
  return { text, truncated: false, body, sources };
}
function inspection(name = 'release-manager') {
  const v = structuredClone(fixture); v.subject.soul = name;
  Object.assign(v.souls[0], { name, path: `souls/${name}`, instructions: { file: `/cache/${name}/AGENTS.md`, text: OWN_TEXT, truncated: false },
    composedInstructions: composedAnswer(OWN_TEXT), skills: SKILLS });
  return v;
}
function page(t, answer = () => inspection()) {
  const previous = currentWorkspace(); setWorkspace('/team');
  const dom = new JSDOM('<body><main><section hidden></section></main></body>', { pretendToBeVisual: true }), el = dom.window.document.querySelector('section');
  const opened = [];
  const inspector = createSoulInspector(el, { layout: 'page', openCapability: (cap, soul, entry) => opened.push([cap.id, soul.name, entry.slot ?? entry.why]),
    ctx: { api: async (url, opts) => url.startsWith('/api/capabilities') ? structuredClone(answer(JSON.parse(opts.body))) : { status: 'ok' } } });
  t.after(() => { inspector.dispose(); dom.window.close(); setWorkspace(previous); });
  const key = (target, k) => { const e = new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }); target.dispatchEvent(e); return e; };
  return { el, dom, doc: dom.window.document, inspector, opened, key, $: s => el.querySelector(s), $$: s => [...el.querySelectorAll(s)] };
}

test('slice3a soul page capabilities one list core first', async t => {
  const u = page(t);
  await u.inspector.show(selection('release-manager')); await settle();
  const lists = u.$$('.soul-capabilities ul.cap-lines');
  assert.equal(lists.length, 1, 'one list');
  const rows = [...lists[0].querySelectorAll('.cap-line')];
  assert.deepEqual(rows.map(r => r.dataset.capability), ['oats.okf', 'oats.aweb', 'nw-house-style', 'oats.core', 'nw-deploy', 'nw-release-tooling'],
    'core first (knowledge, messaging), then the rest in composition order');
  assert.deepEqual(rows.map(r => !!r.querySelector('.cap-line-tag')), [true, true, false, false, false, false], 'a dim "core" tag on core rows only');
  assert.equal(rows[0].querySelector('.cap-line-tag').textContent, 'core');
  assert.ok(rows.every(r => r.className === 'cap-line'), 'the same row styling for core and additional');
  assert.equal(rows[0].querySelector('.cap-line-by').textContent, 'by oats.okf', '"by <source>": no rule says official yet');
  assert.equal(u.$('.cap-line-verified'), null, 'no verified mark');
  assert.equal(u.$('.soul-capabilities-note').textContent, 'no tasks capability', 'an empty core slot is said, not a row');
  // One tab stop; the arrows move; Enter (the button's click) opens the capability page.
  assert.deepEqual(rows.map(r => r.tabIndex), [0, -1, -1, -1, -1, -1]);
  rows[0].focus(); u.key(rows[0], 'ArrowDown');
  assert.equal(u.doc.activeElement, rows[1]);
  rows[1].click();
  assert.deepEqual(u.opened, [['oats.aweb', 'release-manager', 'messaging']]);
  // The top block, and no Agents (Instances) on the page.
  assert.deepEqual(u.$$('.soul-top > dt').map(dt => dt.textContent), ['Harness · model', 'Teams', 'Knowledge', 'Ready']);
  assert.equal(u.$('.soul-top [data-fact="teams"]').textContent.startsWith('engineering'), true);
  assert.equal(u.$('.soul-ready-line').textContent, 'Ready');
  assert.equal(u.$('.inspector-instances, .inspector-instance'), null, 'no Agents on the soul page');
  assert.equal(u.$('details.soul-ready-details > summary').textContent, 'Details', 'readiness detail behind a native disclosure');
});

test('slice3a soul page two instruction tabs', async t => {
  const dom = new JSDOM('<!doctype html><body><main></main></body>', { pretendToBeVisual: true });
  const doc = dom.window.document, host = doc.querySelector('main');
  const section = createSoulInstructions(doc, { canOpenCapability: () => true, openCapability: () => {} });
  host.append(section.element);
  t.after(() => { section.dispose(); dom.window.close(); });
  section.update(inspection().souls[0]);
  const key = (target, k) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const tabs = [...host.querySelectorAll('[role=tablist] [role=tab]')];
  assert.deepEqual(tabs.map(x => x.textContent), [SOUL_INSTRUCTIONS_COPY.ownTab, SOUL_INSTRUCTIONS_COPY.composedTab]);
  assert.deepEqual(tabs.map(x => x.getAttribute('aria-selected')), ['true', 'false']);
  assert.deepEqual(tabs.map(x => x.tabIndex), [0, -1], 'one tab stop: Tab lands on the shown tab, then moves into its panel');
  const panel = name => host.querySelector(`[role=tabpanel][data-tab="${name}"]`);
  assert.equal(panel(OWN).hidden, false); assert.equal(panel(COMPOSED).hidden, true);
  assert.equal(panel(OWN).getAttribute('aria-labelledby'), tabs[0].id);
  // Soul instructions: the own AGENTS.md, its headings listed on the left.
  assert.equal(panel(OWN).querySelector('.mdv h1').textContent, 'Release manager');
  assert.deepEqual([...panel(OWN).querySelectorAll('.soul-doc-nav .soul-doc-link')].map(b => b.textContent), ['Release manager', 'Usage', 'Limits']);
  // The arrows switch (selection follows focus), Home and End too.
  tabs[0].focus(); key(tabs[0], 'ArrowRight');
  assert.equal(section.tab, COMPOSED); assert.equal(doc.activeElement, tabs[1]);
  assert.equal(panel(OWN).hidden, true); assert.equal(panel(COMPOSED).hidden, false);
  assert.deepEqual(tabs.map(x => x.tabIndex), [-1, 0]);
  // Composed: the soul, then one section per capability, as one document; its sections listed on the left.
  const parts = [...panel(COMPOSED).querySelectorAll('.soul-part')];
  assert.deepEqual(parts.map(p => p.querySelector('.soul-part-title').textContent), ['From this soul', 'Injected by nw-deploy', 'Injected by oats.okf']);
  assert.deepEqual([...panel(COMPOSED).querySelectorAll('.soul-doc-link')].map(b => b.textContent), ['This soul', 'nw-deploy', 'oats.okf']);
  assert.doesNotMatch(panel(COMPOSED).textContent, /oats:capability/, 'the marker lines are dropped');
  key(tabs[1], 'ArrowLeft'); assert.equal(section.tab, OWN);
  key(tabs[0], 'End'); assert.equal(section.tab, COMPOSED);
  key(tabs[1], 'Home'); assert.equal(section.tab, OWN);
  key(tabs[0], 'ArrowLeft'); assert.equal(section.tab, COMPOSED, 'the arrows wrap');
  tabs[0].click(); assert.equal(section.tab, OWN, 'a click switches too');
});

test('slice3a soul skills still reachable', async t => {
  const u = page(t);
  await u.inspector.show(selection('release-manager')); await settle();
  const skills = u.$('.soul-instructions details.soul-skills');
  assert.ok(skills, 'a folded Skills list on the page');
  assert.equal(skills.open, false, 'folded');
  assert.match(skills.querySelector('summary').textContent, /^Skills/);
  const item = [...skills.querySelectorAll('[role=treeitem]')].find(i => i.getAttribute('aria-label') === 'ship');
  assert.ok(item, 'the soul\'s own skill is listed');
  // A link from the soul's AGENTS.md to the skill's file opens it in the Skills reader, unfolded.
  u.$('[role=tabpanel][data-tab="own"] .mdv a').click();
  assert.equal(skills.open, true);
  assert.equal(skills.querySelector('.cap-reader-path').textContent, 'souls/release-manager/skills/ship/SKILL.md');
  assert.equal(skills.querySelector('.cap-reader-body .mdv h1').textContent, 'Ship');
});
