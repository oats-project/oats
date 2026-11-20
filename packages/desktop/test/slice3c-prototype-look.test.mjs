// The Desktop UI rework, slice 3c: the Workspace pages look like the prototype (frame A) — the Souls grid and table,
// Capabilities with its Workspace defaults, a soul's and a capability's page — in the theme's tokens (pinned acceptance
// tests). In-memory DOM and CSSOM checks; the live look is the Electron check in the hand-back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { TEXT_PAIRS, TEXT_CONTRAST } from '../renderer/contrast-inventory.mjs';
import { groupHeadingCSS } from '../renderer/group-heading.mjs';
import { catalogCSS, renderCapabilityList, INTRO_COPY } from '../renderer/workspace-catalog.mjs';
import { defaultsCSS } from '../renderer/workspace-defaults.mjs';
import { pageCardCSS, capabilityPageCSS, soulCapabilitiesCSS } from '../renderer/capability-page.mjs';
import { inspectorCSS } from '../renderer/soul-inspector.mjs';
import { soulInstructionsCSS } from '../renderer/soul-instructions.mjs';
import { capabilityContentsCSS } from '../renderer/capability-contents.mjs';
import { statusLineCSS, createStatusLine } from '../renderer/status-line.mjs';

const renderer = new URL('../renderer/', import.meta.url);
const themeCSS = readFileSync(new URL('theme.css', renderer), 'utf8');
const spawnSource = readFileSync(new URL('views/spawn.mjs', renderer), 'utf8');
/** The Souls view's own stylesheet, its interpolated group heading substituted as the app does. */
const spawnCSS = () => spawnSource.match(/const CSS = `([\s\S]*?)`;/)[1].replace(/\$\{(\w+)\}/g, (_, n) => ({ groupHeadingCSS })[n] ?? assert.fail(n));

/* ── the palettes, as theme-contrast reads them ─────────────────────────────────────────────────────────── */
const tokens = block => new Map([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim().toLowerCase()]));
const dark = tokens(themeCSS.match(/:root, \[data-theme="dark"\] \{([\s\S]*?)\n\}/)[1]);
const overlay = name => { const out = new Map(dark); for (const [k, v] of tokens(themeCSS.match(new RegExp(`\\[data-theme="${name}"\\] \\{([\\s\\S]*?)\\n\\}`))[1])) out.set(k, v); return out; };
const palettes = [['dark', dark], ['light', overlay('light')], ['solarized', overlay('solarized')]];
/** The shared scale (`:root` blocks outside the palettes). */
const scale = new Map([...themeCSS.matchAll(/:root \{([^}]*)\}/g)].flatMap(m => [...tokens(m[1])]));
const channels = hex => { assert.match(hex, /^#[0-9a-f]{6}$/, `opaque: ${hex}`); return hex.slice(1).match(/../g).map(v => parseInt(v, 16)); };
const luminance = rgb => { const c = rgb.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const x = luminance(channels(a)), y = luminance(channels(b)); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

function sheet(t, body, sources, theme = 'dark') {
  const dom = new JSDOM(`<!doctype html><html data-theme="${theme}"><body>${body}</body></html>`, { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  for (const source of [themeCSS, ...sources]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
  return { dom, doc, css: sel => dom.window.getComputedStyle(doc.querySelector(sel)), $: s => doc.querySelector(s), $$: s => [...doc.querySelectorAll(s)] };
}

/* ── the souls page, mounted ─────────────────────────────────────────────────────────────────────────────── */
const tick = () => new Promise(r => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
const CLI_OK = { ok: true, bin: '/seed/oats', version: '0.18.0', source: 'path', required: { desktopApi: 1, range: '>=0.18.0 <0.21.0' }, probedAt: 1, tried: [] };
const HOST = 'github.com/acme/agents';
const member = (name, over = {}) => ({ name, agentsRoot: '/w/agents', description: `${name} does its job`, work: 'worktree', soulKind: 'member', repo: HOST, repoName: 'agents', ...over });
const packaged = (pkg, name) => member(name, { soulKind: 'package', package: pkg, version: '1.0.0', repo: `github.com/acme/${pkg}`, repoName: `package ${pkg}`, key: `${pkg}/${name}` });
const SOULS = [member('lane-maintainer'), member('desk-developer'), member('acme-expert'), packaged('oats.okf', 'okf-expert'), packaged('oats.engineering', 'code-reviewer')];

async function mountSouls(t) {
  const dom = new JSDOM('<!doctype html><html><body><div id=host></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
  const oldDoc = globalThis.document, oldWin = globalThis.window, oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  globalThis.document = dom.window.document; globalThis.window = dom.window;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: dom.window.localStorage });
  const spawn = await import('../renderer/views/spawn.mjs');
  const cli = await import('../renderer/views/cli-status.mjs');
  await cli.refreshCli({ api: async () => ({ ok: true, status: 200, json: async () => CLI_OK }) });
  const ctx = {
    api(pathname) {
      if (pathname === '/api/cli' || pathname === '/api/cli/reprobe') return Promise.resolve(CLI_OK);
      if (pathname.startsWith('/api/agents')) return Promise.resolve({ agents: structuredClone(SOULS), catalog: {} });
      if (pathname.startsWith('/api/panel')) return Promise.resolve({ instances: [
        { instance: 'desk-developer-1', agent: 'desk-developer', agentsRoot: '/w/agents', running: true, home: '/w/a/1' },
        { instance: 'desk-developer-2', agent: 'desk-developer', agentsRoot: '/w/agents', running: true, home: '/w/a/2' },
        { instance: 'lane-maintainer-1', agent: 'lane-maintainer', agentsRoot: '/w/agents', running: false, home: '/w/a/3' },
      ], workspace: { id: 'w' }, workspaces: [], deployment: { status: 'observed', workspaceStatus: { workspace: { key: HOST }, members: [] } } });
      if (pathname.startsWith('/api/capabilities')) return Promise.resolve({ operationsApi: 2, capabilities: [] });
      return Promise.resolve({});
    },
    openTerminal: () => {},
  };
  const doc = dom.window.document;
  // The view's own sheet is in its markup; the theme's tokens come from theme.css, as index.html links it.
  const theme = doc.createElement('style'); theme.textContent = themeCSS; doc.head.append(theme);
  spawn.mount(doc.getElementById('host'), ctx);
  await settle();
  t.after(() => {
    try { spawn.unmount(); } finally {
      globalThis.document = oldDoc; globalThis.window = oldWin;
      if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage); else delete globalThis.localStorage;
      dom.window.close();
    }
  });
  return { dom, doc, spawn, css: el => dom.window.getComputedStyle(typeof el === 'string' ? doc.querySelector(el) : el), $: s => doc.querySelector(s), $$: s => [...doc.querySelectorAll(s)] };
}

/** A rule's declarations as written (JSDOM drops a shorthand that holds a var(), so a border or a padding is read here). */
function ruleBody(source, selector) {
  const body = source.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`, 'm'))?.[1];
  assert.ok(body, `a rule for ${selector}`);
  return body;
}

/** How many tracks `repeat(auto-fill, minmax(<min>, 1fr))` makes in `width` px with `gap` px between them. */
function autoFillTracks(width, gap, min) { return Math.max(1, Math.floor((width + gap) / (min + gap))); }

test('slice3c souls grid at most 3 columns at 1280', t => {
  const u = sheet(t, '<div class="souls-group-cards"></div>', [spawnCSS()]);
  const rule = u.css('.souls-group-cards');
  assert.equal(rule.display, 'grid');
  assert.equal(rule.gridTemplateColumns, 'repeat(auto-fill, minmax(max(min(240px, 100%), calc((100% - 20px) / 3)), 1fr))',
    'tracks at least a third of the row (less two gaps), never under 240px');
  assert.equal(rule.gap, '10px');
  // The track floor the rule says, at the widths the Souls page has: the window at 1280px less the 288px sidebar and
  // the grid's 20px paddings is 952px; and a wide window, and a narrow one.
  const min = width => Math.max(Math.min(240, width), (width - 20) / 3);
  for (const [window, expected] of [[1280, 3], [1920, 3], [2560, 3], [3840, 3], [900, 2], [600, 1]]) {
    const width = window - 288 - 40;
    assert.equal(autoFillTracks(width, 10, min(width)), expected, `${window}px window: ${expected} columns`);
  }
  // A card: a roomy raised tile, its name strong, what it does muted on two lines at most, then one meta line.
  const card = sheet(t, '<button class="soul-card"><span class="stitle">dev</span><p class="sdesc">Builds</p><span class="sproblem">Can\'t spawn here: codex is not installed</span><span class="sfoot"><span class="sactivity running">2 agents running</span><span class="skind">· developer</span></span></button>', [spawnCSS()]);
  const cardRule = ruleBody(spawnCSS(), '.soul-card');
  for (const decl of ['padding:var(--space-3) 14px', 'background:var(--surface)', 'border:1px solid var(--border)', 'border-radius:var(--radius-card)']) assert.ok(cardRule.includes(decl), decl);
  assert.match(ruleBody(spawnCSS(), '.soul-card:hover'), /background:var\(--surface-2\)/, 'hover raises the tile');
  assert.match(ruleBody(spawnCSS(), '.soul-card.open'), /border-color:var\(--accent\); background:var\(--sel\)/, 'the open card: the accent edge on the selected fill');
  assert.deepEqual([card.css('.stitle').fontSize, card.css('.stitle').fontWeight], ['var(--text-card-name)', 'var(--card-name-weight)']);
  assert.deepEqual([card.css('.sdesc').fontSize, card.css('.sdesc').color, card.css('.sdesc').getPropertyValue('-webkit-line-clamp')], ['var(--text-desc)', 'var(--muted)', '2']);
  assert.deepEqual([card.css('.sfoot').fontSize, card.css('.sfoot').color], ['var(--text-meta)', 'var(--muted)']);
  // The refusal, kept but quiet: one line at the meta size and weight, an ellipsis.
  const refusal = card.css('.sproblem');
  assert.deepEqual([refusal.color, refusal.fontSize, refusal.fontWeight, refusal.whiteSpace, refusal.textOverflow], ['var(--warn)', 'var(--text-meta)', '400', 'nowrap', 'ellipsis']);
  // The scale the card reads: name over body over meta.
  const px = name => parseFloat(scale.get(name));
  assert.ok(px('text-card-name') > px('text-desc') && px('text-desc') > px('text-meta'), 'three steps');
});

test('slice3c souls title, switch inline, counts sentence, uppercase group heads', async t => {
  const u = await mountSouls(t);
  // The title, with the grid/table switch inline beside it.
  const row = u.$('.workspace-title-row');
  assert.ok(row, 'the title row');
  assert.equal(row.querySelector('h1').textContent, 'Souls');
  const sw = row.querySelector('.souls-view');
  assert.ok(sw, 'the switch beside the title');
  assert.equal(row.querySelector('.workspace-title').nextElementSibling, sw, 'right after the title');
  assert.deepEqual([...sw.querySelectorAll('button')].map(b => [b.textContent, b.getAttribute('aria-pressed')]), [['Grid', 'true'], ['Table', 'false']]);
  assert.equal(u.css('.workspace-title-row').display, 'flex'); assert.equal(u.css('.workspace-title-row').alignItems, 'center');
  // In a narrow pane the trail gives way and wraps inside the row (the page clips what overflows): it shrinks, never
  // holds its one-line width. The live check measures it in Electron at a 312px pane.
  const trail = u.css('.workspace-title');
  assert.deepEqual([trail.flexShrink, trail.minWidth, trail.flexWrap], ['1', '0px', 'wrap']);
  // One sentence with the real counts: five souls, one of them with agents running (lane-maintainer's agent is stopped).
  assert.equal(u.$('.souls-lede').textContent, 'A soul is what an agent is made of: its instructions, its skills and capabilities, and the knowledge it keeps. '
    + 'You have 5 souls, 1 with agents running, grouped by where they come from; maintainers first, then experts, developers, operations. Enter opens one.');
  assert.equal(u.spawn.soulsLede({ souls: 1, running: 0 }).match(/You have [^,]+, [^,]+,/)[0], 'You have 1 soul, none with agents running,');
  assert.equal(u.spawn.soulsLede({ souls: 0, running: 0 }).match(/You have [^,]+, [^,]+,/)[0], 'You have 0 souls, none with agents running,');
  // Group heads: small uppercase, tracked, with the count after the name.
  const head = u.$('.souls-group-title');
  assert.equal(head.querySelector('.souls-group-name').textContent, 'agents');
  assert.match(head.querySelector('.souls-group-note').textContent, /3 souls$/);
  const name = u.css(head.querySelector('.souls-group-name'));
  assert.deepEqual([name.textTransform, name.fontSize, name.letterSpacing], ['uppercase', 'var(--text-label)', 'var(--label-tracking)']);
  assert.equal(scale.get('text-label'), '11px');
  assert.equal(u.css(head).color, 'var(--muted)');
  assert.equal(u.css(head.querySelector('.souls-group-note')).textTransform, 'none', 'the count in ordinary case');
  assert.equal(u.css(head.querySelector('svg')).display, 'none', 'no icon on a plain group');
  // The table in the same type scale: small uppercase heads, the rows at the description size.
  u.$('.souls-view [data-view="table"]').click(); await settle();
  assert.ok(u.$('table.souls-table'));
  const th = u.css('.souls-table thead th');
  assert.deepEqual([th.textTransform, th.fontSize, th.letterSpacing, th.color], ['uppercase', 'var(--text-label)', 'var(--label-tracking)', 'var(--muted)']);
  assert.equal(u.css('.souls-table').fontSize, 'var(--text-desc)');
  assert.equal(u.css('.souls-table .souls-group-name').textTransform, 'uppercase', 'the group rows wear the same heads');
});

/* ── capabilities ────────────────────────────────────────────────────────────────────────────────────────── */
const ROWS = [
  { name: 'zeta-notes', kind: 'member', repoKey: HOST, layer: null, description: 'Notes the team keeps.' },
  { name: 'oats.okf', kind: 'package', package: 'oats.okf', version: '2.1.3', layer: 'knowledge', description: 'The OKF knowledge slot.' },
  { name: 'oats.aweb', kind: 'package', package: 'oats.aweb', version: '1.42.1', layer: 'messaging', description: 'Messaging layer via aweb.' },
  { name: 'oats.core', kind: 'package', package: 'oats.framework', version: '1.4.0', layer: null, description: 'How to operate inside OATS.' },
  { name: 'own-runbook', kind: 'member', repoKey: HOST, layer: null, private: true },
];
const STATUS = {
  workspace: { name: 'acme', key: HOST },
  members: [{ key: HOST, name: 'agents', status: 'confirmed' }],
  packages: [{ id: 'oats.okf', source: 'catalog:oats.okf' }, { id: 'oats.aweb', source: 'catalog:oats.aweb' }, { id: 'oats.framework', source: 'catalog:oats.framework' }],
  defaults: { slots: { knowledge: { name: 'oats.okf', from: 'package' }, messaging: null, tasks: null }, capabilities: [{ name: 'oats.core', from: 'package', off: false }, { name: 'zeta-notes', from: 'here', off: false }] },
};
const capSheet = t => sheet(t, '<main class="oats-view"><div class="caps"></div></main>', [catalogCSS, defaultsCSS]);

test('slice3c capabilities rows with pills and intro', t => {
  const u = capSheet(t);
  renderCapabilityList(u.$('.caps'), { rows: ROWS, status: STATUS, onOpen() {} });
  // The page's first line: what a capability is, the counts, then what the mark, "core" and "default" say, on the
  // official rule (in the OATS catalog, or from the OATS repository).
  const intro = u.$('.caps > .cap-intro');
  assert.equal(u.$('.caps').firstElementChild, intro, 'first, above the Workspace defaults');
  assert.equal(intro.textContent, `${INTRO_COPY.what} You have 5 capabilities, 3 official: the mark ✓ means official (in the OATS catalog, or from the OATS repository); `
    + 'the others say who made them. “core” fills one of the three places every soul has: knowledge, messaging, tasks; “default” is what this workspace gives a soul unless it says otherwise.');
  assert.ok(intro.querySelector('.cap-official[aria-hidden=true] svg'), 'the mark itself, drawn as the rows draw it');
  renderCapabilityList(u.$('.caps'), { rows: ROWS, status: STATUS, query: 'zeta', onOpen() {} });
  assert.match(u.$('.cap-intro').textContent, /You have 5 capabilities/, 'the search never narrows the counts');
  renderCapabilityList(u.$('.caps'), { rows: ROWS, status: { ...STATUS, defaults: undefined }, onOpen() {} });
  assert.doesNotMatch(u.$('.cap-intro').textContent, /default/, 'no defaults reported: nothing said about them');
  // A read that found none still says what a capability is, with its zero; an unread catalog says nothing.
  renderCapabilityList(u.$('.caps'), { rows: [], status: STATUS, onOpen() {} });
  assert.match(u.$('.cap-intro').textContent, /You have 0 capabilities, 0 official: /);
  renderCapabilityList(u.$('.caps'), { rows: null, status: STATUS, onOpen() {} });
  assert.equal(u.$('.cap-intro'), null);
  renderCapabilityList(u.$('.caps'), { rows: ROWS, status: STATUS, onOpen() {} });
  // Rows: no box around the list, a thin rule under each row, a quiet hover and selected state.
  assert.match(ruleBody(catalogCSS, '.cap-list > li'), /border-bottom:1px solid var\(--border\)/, 'a thin rule under each row');
  assert.doesNotMatch(ruleBody(catalogCSS, '.cap-list'), /border|background/, 'no box');
  const row = u.css('[data-part=all] button.cap-row');
  assert.deepEqual([row.background, row.borderRadius, row.minHeight], ['rgba(0, 0, 0, 0)', 'var(--radius-control)', 'var(--row-h)']);
  assert.match(catalogCSS, /button\.cap-row:hover \{ background:var\(--surface-2\); \}/);
  assert.match(catalogCSS, /button\.cap-row:focus-visible \{ background:var\(--sel\); \}/);
  // The line: the name, its mark or "by <source>" right after it, then the pills; one muted line of what it does.
  const okf = u.$('[data-part=all] [data-capability="oats.okf"]');
  const order = el => Number(u.dom.window.getComputedStyle(el).order || 0);
  const [name, origin, core, deflt] = ['.cap-row-name', '.cap-origin', '[data-tag=core]', '[data-tag=default]'].map(s => okf.querySelector(s));
  assert.ok(order(name) < order(origin) && order(origin) < order(core) && order(core) <= order(deflt), 'name · mark · core · default');
  assert.ok(origin.querySelector('.cap-official svg'));
  assert.deepEqual([u.css('.cap-row-name').fontSize, u.css('.cap-row-name').fontWeight], ['var(--text-name)', 'var(--name-weight)']);
  assert.deepEqual([u.css('.cap-row-desc').color, u.css('.cap-row-desc').fontSize, u.css('.cap-row-desc').whiteSpace], ['var(--muted)', 'var(--text-meta)', 'nowrap']);
  // Pills: "core" a hairline frame, "default" a quiet fill; muted words.
  const corePill = u.dom.window.getComputedStyle(core), defaultPill = u.dom.window.getComputedStyle(deflt);
  assert.match(ruleBody(catalogCSS, '.cap-tag'), /border:1px solid var\(--border\)/);
  assert.deepEqual([corePill.color, corePill.borderRadius, corePill.fontSize], ['var(--muted)', 'var(--radius-tag)', 'var(--text-label)']);
  assert.deepEqual([defaultPill.background, defaultPill.color], ['var(--tag-bg)', 'var(--muted)']);
});

test('slice3c workspace defaults section kept and styled', t => {
  const u = capSheet(t);
  renderCapabilityList(u.$('.caps'), { rows: ROWS, status: STATUS, onOpen() {} });
  // Kept (Joan's decision): Workspace defaults above All capabilities, its Core slots then Additional.
  assert.deepEqual(u.$$('.caps > *').map(el => el.dataset.part || el.className), ['cap-intro', 'defaults', 'all']);
  assert.deepEqual(u.$$('.caps h3').map(h => h.textContent), ['Workspace defaults', 'All capabilities']);
  assert.deepEqual(u.$$('[data-part=defaults] .cap-group-title').map(h => h.textContent), ['Core', 'Additional']);
  assert.deepEqual(u.$$('[data-part=defaults] .cap-slot-label').map(h => h.textContent), ['Knowledge', 'Messaging', 'Tasks']);
  // Styled the same way: the parts' titles in the small uppercase label, the slots' labels too, its rows the list's.
  for (const title of u.$$('.cap-part-title')) {
    const style = u.dom.window.getComputedStyle(title);
    assert.deepEqual([style.textTransform, style.fontSize, style.letterSpacing, style.color], ['uppercase', 'var(--text-label)', 'var(--label-tracking)', 'var(--muted)']);
  }
  const slot = u.css('.cap-slot-label');
  assert.deepEqual([slot.textTransform, slot.fontSize, slot.color], ['uppercase', 'var(--text-label)', 'var(--muted)']);
  assert.equal(slot.backgroundColor || 'rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', 'on the page, no box');
  const rows = u.$$('[data-part=defaults] button.cap-row');
  assert.deepEqual(rows.map(r => r.dataset.capability), ['oats.okf', 'oats.core', 'zeta-notes']);
  for (const r of rows) assert.equal(u.dom.window.getComputedStyle(r).background, 'rgba(0, 0, 0, 0)', 'the list\'s own row');
  assert.equal(u.css('.cap-lead').fontSize, 'var(--text-body)');
});

/* ── tokens, not page-local values ───────────────────────────────────────────────────────────────────────── */
const CHANGED = { spawnCSS: spawnCSS(), groupHeadingCSS, catalogCSS, defaultsCSS, pageCardCSS, capabilityPageCSS, soulCapabilitiesCSS, inspectorCSS, soulInstructionsCSS, capabilityContentsCSS, statusLineCSS };

test('slice3c tokens not page-local', () => {
  for (const [name, source] of Object.entries(CHANGED)) {
    const rules = source.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(rules, /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\bopacity\s*:/i, `${name}: colours are the theme's tokens, never raw values or text transparency`);
  }
  // The prototype's scale lives in theme.css, shared by every theme; the dark palette is its Tokyo Night hues.
  for (const [token, value] of [['space-1', '4px'], ['space-2', '8px'], ['space-3', '12px'], ['space-4', '16px'], ['space-5', '24px'], ['space-6', '28px'],
    ['text-label', '11px'], ['text-meta', '12px'], ['text-desc', '12.5px'], ['text-body', '13px'], ['text-name', '13.5px'], ['text-card-name', '15px'], ['text-title', '17px'],
    ['radius-tag', '4px'], ['radius-control', '6px'], ['radius-card', '8px'], ['row-h', '40px']]) assert.equal(scale.get(token), value, token);
  for (const [token, value] of [['bg', '#1a1b26'], ['surface', '#1f2130'], ['surface-2', '#24273a'], ['fg', '#c0caf5'], ['accent', '#7aa2f7'], ['ok', '#9ece6a'], ['warn', '#e0af68'], ['danger', '#f7768e'], ['violet', '#bb9af7']])
    assert.equal(dark.get(token), value, `dark --${token}`);
  // The rows, cards, pages and labels this slice drew read those tokens, not literal sizes.
  for (const [rule, source] of [['.soul-card .stitle', 'spawnCSS'], ['.cap-row-name', 'catalogCSS'], ['.cap-part-title', 'catalogCSS'], ['.page-title', 'pageCardCSS'], ['.page-section-title', 'pageCardCSS'], ['.souls-group-name', 'groupHeadingCSS']]) {
    const body = CHANGED[source].match(new RegExp(`^${rule.replace(/[.*]/g, '\\$&')} \\{([^}]*)\\}`, 'm'))?.[1];
    assert.ok(body, rule); assert.match(body, /font-size:var\(--text-[a-z-]+\)/, `${rule}: a type token`);
  }
  // Terminal cell geometry is untouched (a design-direction decision): its size and the terminal's colours are as before.
  assert.equal(dark.get('term-font-size'), '15px'); assert.equal(dark.get('term-bg'), '#0a0d12');
});

/* ── contrast ─────────────────────────────────────────────────────────────────────────────────────────────── */
// Every ink/fill pair the slice's rules paint, as [what, foreground, surface]. The rows and cards now sit on the page's
// --bg (rows) or a raised --surface (cards), with --surface-2 on hover and --sel when focused or open.
const CHANGED_PAIRS = [
  ['card name, description, meta, refusal', ['fg', 'muted', 'warn'], ['surface', 'surface-2', 'sel']],
  ['group heads and the lede', ['muted', 'warn'], ['bg']],
  ['table heads and cells', ['fg', 'muted', 'warn'], ['bg', 'surface', 'sel']],
  ['capability rows: name, origin, pills, description', ['fg', 'muted', 'accent'], ['bg', 'surface-2', 'sel']],
  ['the default pill', ['muted'], ['tag-bg']],
  ['capability intro, defaults lead, part and slot labels', ['fg', 'muted'], ['bg']],
  ['page title, facts, section labels, tabs, folds, skills', ['fg', 'muted', 'accent', 'warn'], ['bg', 'surface-2', 'sel']],
  ['status line keys', ['fg', 'muted'], ['surface-2']],
];

test('slice3c contrast AA in every theme for the changed pairs', () => {
  for (const [what, fgs, bgs] of CHANGED_PAIRS) for (const fg of fgs) for (const bg of bgs) {
    assert.ok(TEXT_PAIRS.some(([f, b]) => f === fg && b === bg), `${what}: --${fg} on --${bg} is in the contrast inventory`);
    for (const [theme, palette] of palettes) {
      const ratio = contrast(palette.get(fg), palette.get(bg));
      assert.ok(ratio >= TEXT_CONTRAST, `${theme}, ${what}: --${fg} on --${bg} is ${ratio.toFixed(2)}:1`);
    }
  }
  // The official mark's accent check on a row, hovered and focused, is a graphic held to text contrast anyway.
  for (const [theme, palette] of palettes) for (const bg of ['bg', 'surface-2', 'sel']) assert.ok(contrast(palette.get('accent'), palette.get(bg)) >= TEXT_CONTRAST, `${theme}: accent on ${bg}`);
});

/* ── the status line ──────────────────────────────────────────────────────────────────────────────────────── */
test('slice3c status line shows a page\'s four keys', t => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const keys = [{ keys: '↑↓', label: 'move' }, { keys: 'Enter', label: 'open' }, { keys: 'v', label: 'table' }, { keys: 'Esc', label: 'Home' }];
  const line = createStatusLine({ doc, host: doc.body, keysFor: () => keys, max: 4 });
  t.after(() => line.dispose());
  assert.deepEqual([...doc.querySelectorAll('.status-key')].map(k => k.textContent), ['↑↓ move', 'Enter open', 'v table', 'Esc Home']);
  // The shell asks for four, and gives the Workspace page's own keys while it is shown with the focus on it.
  const shell = readFileSync(new URL('shell.mjs', renderer), 'utf8');
  assert.match(shell, /keysFor: \(\) => statusKeys\(\), max: 4 \}\)/);
  const fn = shell.match(/function workspacePageKeys\(key\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /\[\["↑↓", "move"\], \["Enter", "open"\], \[v, host\.querySelector\("\.souls-grid \.souls-table"\) \? "grid" : "table"\], \["Esc", "Home"\]\]/);
  assert.match(fn, /dataset\.tab === "capabilities"\) return \[\["↑↓", "move"\], \["Enter", "open"\], \["Esc", "Home"\]\]/);
  assert.match(fn, /return \[\["↑↓", "move"\], \["Enter", "open"\], \["Esc", "back"\]\]/);
});
