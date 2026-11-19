// Workspace › Capabilities as one flat list (the Desktop UI rework, slice 3b; guide tour step 34): core capabilities
// first with a dim "core" tag, no sections, no tiles or two-letter marks; each row its name, who made it (✓ or
// "by <source>"), one line of what it does and its "default" tag; the defaults said in one sentence above the list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { catalogCSS, renderCapabilityList } from '../renderer/workspace-catalog.mjs';
import { defaultsCSS } from '../renderer/workspace-defaults.mjs';
import { capabilityList, defaultState, defaultsSummary } from '../../client/capability-list.mjs';

const themeCSS = readFileSync(new URL('../renderer/theme.css', import.meta.url), 'utf8');

// Same palette reading as test/theme-contrast.test.mjs: hex tokens per theme block.
function tokens(block) {
  return new Map([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6}(?:[0-9a-f]{2})?)\b/gi)].map(m => [m[1], m[2].toLowerCase()]));
}
const dark = tokens(themeCSS.match(/:root, \[data-theme="dark"\] \{([\s\S]*?)\n\}/)?.[1] || '');
const overlay = name => { const out = new Map(dark); for (const [k, v] of tokens(themeCSS.match(new RegExp(`\\[data-theme="${name}"\\] \\{([\\s\\S]*?)\\n\\}`))?.[1] || '')) out.set(k, v); return out; };
const palettes = [['light', overlay('light')], ['solarized', overlay('solarized')], ['dark', dark]];
const channels = hex => { assert.match(hex, /^#[0-9a-f]{6}$/i, 'opaque'); return hex.slice(1).match(/../g).map(v => parseInt(v, 16)); };
const luminance = rgb => { const c = rgb.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

const ROWS = [
  { name: 'zeta-notes', kind: 'member', repoKey: 'github.com/acme/agents', layer: null, description: 'Notes the team keeps.' },
  { name: 'oats.jira', kind: 'package', package: 'oats.jira', version: '1.0.1', layer: 'tasks', description: 'Tasks layer via Jira.' },
  { name: 'oats.okf', kind: 'package', package: 'oats.okf', version: '2.1.3', layer: 'knowledge', description: 'The OKF knowledge slot for working souls: consult the accepted bases remotely, keep the mirror pinned.' },
  { name: 'oats.aweb', kind: 'package', package: 'oats.aweb', version: '1.42.1', layer: 'messaging', description: 'Messaging layer via aweb.' },
  { name: 'oats.authoring', kind: 'member', repoKey: 'github.com/awebai/oats', layer: null, description: 'Additive framework-authoring guidance.' },
  { name: 'oats.core', kind: 'package', package: 'oats.framework', version: '1.4.0', layer: null, description: 'How to operate inside OATS.' },
  { name: 'oats.folio', kind: 'package', package: 'oats.apps', version: '1.0.0', layer: null, description: 'Folio documents.' },
  { name: 'own-runbook', kind: 'member', repoKey: 'github.com/acme/agents', layer: null, private: true },
];
const STATUS = {
  workspace: { name: 'acme', key: 'github.com/acme/agents' },
  members: [{ key: 'github.com/acme/agents', name: 'agents', status: 'confirmed' }, { key: 'github.com/awebai/oats', name: 'oats', status: 'confirmed' }],
  packages: [{ id: 'oats.okf', source: 'catalog:oats.okf' }, { id: 'oats.aweb', source: 'catalog:oats.aweb' }, { id: 'oats.jira', source: 'catalog:oats.jira' },
    { id: 'oats.framework', source: 'catalog:oats.framework' }, { id: 'oats.apps', source: 'git:github.com/awebai/oats-apps@v1.0.0' }],
  defaults: { slots: { knowledge: { name: 'oats.okf', from: 'package' }, messaging: 'none', tasks: null },
    capabilities: [{ name: 'oats.core', from: 'package', off: false }, { name: 'zeta-notes', from: 'here', off: false }, { name: 'oats.authoring', off: true }] },
};

function mount(t, theme = 'light') {
  const dom = new JSDOM(`<!doctype html><html data-theme="${theme}"><body><main class="oats-view"><div class="caps"></div></main></body></html>`);
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  for (const source of [themeCSS, catalogCSS, defaultsCSS]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
  return { dom, doc, css: el => dom.window.getComputedStyle(el), $: sel => doc.querySelector(sel), $$: sel => [...doc.querySelectorAll(sel)] };
}
const key = (u, el, name) => el.dispatchEvent(new u.dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
const line = row => [...row.querySelector('.cap-row-line').children].map(el => el.dataset.tag ? `[${el.textContent}]` : el.textContent).join(' ');

test('slice3b capabilities one list core first with tags', t => {
  const u = mount(t);
  const opened = [];
  renderCapabilityList(u.$('.caps'), { rows: ROWS, status: STATUS, onOpen: row => opened.push(row.name) });
  // One list, no sections, headings, pills, tiles or two-letter marks.
  assert.equal(u.$$('.cap-list').length, 1);
  assert.equal(u.$$('.caps h2, .caps h3, .catalog-pills, .catalog-tile, .identity-mark, .capability-nav').length, 0);
  // Core first in slot order (knowledge, messaging, tasks), then the rest by name; every row says who made it.
  assert.deepEqual(u.$$('.cap-row').map(line), [
    'oats.okf [core] [default] Verified: published by OATS',
    'oats.aweb [core] Verified: published by OATS',
    'oats.jira [core] Verified: published by OATS',
    'oats.authoring [default · off] Verified: published by OATS',
    'oats.core [default] Verified: published by OATS',
    'oats.folio by oats-apps',
    'own-runbook [repo only] by agents',
    'zeta-notes [default] by agents',
  ]);
  // The verified mark is a check in a circle; its words are its title and its accessible text.
  const official = u.$('.cap-row .cap-origin[data-official]');
  assert.equal(official.title, 'Verified: published by OATS');
  assert.ok(official.querySelector('.cap-verified[aria-hidden=true] svg'));
  // The core tag names its slot in its tooltip; no package name or version on the row.
  assert.match(u.$('[data-tag=core]').title, /^Core: Knowledge/);
  assert.doesNotMatch(u.$('.cap-list').textContent, /2\.1\.3|oats\.framework|1\.4\.0/);
  // One line of what it does, on one line; a row without a description has none.
  const desc = u.$('[data-capability="oats.okf"] .cap-row-desc');
  assert.equal(u.css(desc).whiteSpace, 'nowrap'); assert.equal(u.css(desc).textOverflow, 'ellipsis');
  assert.equal(desc.title, ROWS[2].description);
  assert.equal(u.$('[data-capability="own-runbook"] .cap-row-desc'), null);
  // The defaults, in one sentence above the list: what they are for, and what no row can show (an empty slot).
  const lead = u.$('.cap-lead');
  assert.equal(lead.nextElementSibling, u.$('.cap-list'));
  assert.match(lead.textContent, /^Capabilities tagged default are the ones acme gives every soul, so your agents share one way of working\. A soul can turn a default off and choose its own instead\./);
  assert.match(lead.textContent, /No default for messaging and tasks\.$/);
  // Each row is one button: Enter and Space are the native button's; arrows move along the list, one tab stop.
  const rows = u.$$('button.cap-row');
  assert.deepEqual(rows.map(r => r.tabIndex), [0, ...Array(rows.length - 1).fill(-1)]);
  rows[0].focus(); key(u, rows[0], 'ArrowDown');
  assert.equal(u.doc.activeElement, rows[1]);
  assert.deepEqual(rows.map(r => r.tabIndex).slice(0, 2), [-1, 0], 'the focused row is the tab stop');
  key(u, rows[1], 'End'); assert.equal(u.doc.activeElement, rows.at(-1));
  key(u, rows.at(-1), 'Home'); assert.equal(u.doc.activeElement, rows[0]);
  rows[3].click();
  assert.deepEqual(opened, ['oats.authoring']);
  // A focus key per row, so a repaint puts focus back on it.
  assert.equal(rows[0].dataset.focusKey, 'cap:package:oats.okf:oats.okf');
});

test('the list rule is the shared one: core order, defaults matched by name and source, nothing claimed without defaults', () => {
  const entries = capabilityList(ROWS, STATUS);
  assert.deepEqual(entries.map(e => [e.row.name, e.core, e.default]).slice(0, 3), [['oats.okf', 'knowledge', 'on'], ['oats.aweb', 'messaging', null], ['oats.jira', 'tasks', null]]);
  // A default names a source: a member's same-named capability is not the package's default.
  assert.equal(defaultState(STATUS, { name: 'oats.core', kind: 'member', repoKey: 'github.com/acme/agents' }), null);
  assert.equal(defaultState(STATUS, { name: 'zeta-notes', kind: 'member', repoKey: 'github.com/acme/agents' }), 'on', '`here` is the host repository');
  assert.equal(defaultState({ ...STATUS, defaults: undefined }, ROWS[2]), null);
  assert.deepEqual(capabilityList(ROWS, STATUS, { query: 'OKF' }).map(e => e.row.name), ['oats.okf']);
  // A declared default no row matches is unlisted: the sentence names it.
  const summary = defaultsSummary({ ...STATUS, defaults: { ...STATUS.defaults, capabilities: [{ name: 'gone', from: 'package' }, { name: 'nowhere', off: true }] } }, ROWS);
  assert.deepEqual(summary.unlisted, [{ name: 'gone', off: false }, { name: 'nowhere', off: true }]);
  assert.equal(defaultsSummary({}, ROWS), null);
});

test('the defaults sentence: none set, unlisted ones, and nothing when the kernel reports no defaults', t => {
  const u = mount(t);
  renderCapabilityList(u.$('.caps'), { rows: ROWS, status: { ...STATUS, defaults: { slots: { knowledge: null, messaging: null, tasks: null }, capabilities: [] } }, onOpen() {} });
  assert.equal(u.$('.cap-lead').textContent, 'acme sets no defaults: each soul chooses all of its own capabilities.');
  assert.equal(u.$$('[data-tag^=default]').length, 0);
  renderCapabilityList(u.$('.caps'), { rows: ROWS, status: { ...STATUS, defaults: { ...STATUS.defaults, capabilities: [{ name: 'gone', from: 'package' }, { name: 'nowhere', off: true }] } }, onOpen() {} });
  assert.match(u.$('.cap-lead').textContent, / Also a default, but not in this list: gone\. Turned off by the workspace, and not in this list: nowhere\.$/);
  renderCapabilityList(u.$('.caps'), { rows: ROWS, status: { ...STATUS, defaults: undefined }, onOpen() {} });
  assert.equal(u.$('.cap-lead'), null, 'no reported defaults: no claim');
  assert.equal(u.$$('[data-tag^=default]').length, 0);
});

test('empty and narrowed lists keep their words; a list with no opener is plain rows', t => {
  const u = mount(t);
  renderCapabilityList(u.$('.caps'), { rows: [], status: null, onOpen() {} });
  assert.match(u.$('.catalog-empty').textContent, /^The workspace reports no capabilities yet/);
  renderCapabilityList(u.$('.caps'), { rows: ROWS, status: STATUS, query: 'nothing-like-it', onOpen() {} });
  assert.equal(u.$('.catalog-empty').textContent, 'No capability matches this search.');
  assert.ok(u.$('.cap-lead'), 'the defaults sentence is never filtered by the search');
  renderCapabilityList(u.$('.caps'), { rows: ROWS, status: STATUS });
  assert.equal(u.$$('button.cap-row').length, 0);
  assert.equal(u.$$('div.cap-row').length, ROWS.length);
});

test('rule 2 in the row CSS: hover and focus restyle the surface; no outline of its own, no opacity, no raw colour', () => {
  assert.match(catalogCSS, /button\.cap-row:hover \{ background:var\(--surface-2\); \}/);
  assert.match(catalogCSS, /button\.cap-row:focus-visible \{ background:var\(--sel\); \}/);
  assert.doesNotMatch(catalogCSS, /\.cap-[\w-]+[^{]*\{[^}]*(outline|opacity)/);
  assert.doesNotMatch(catalogCSS + defaultsCSS, /#[0-9a-f]{3,8}\b|rgba?\(/i);
});

for (const [theme, palette] of palettes) test(`${theme}: the row's text, tags and origin hold WCAG AA on their painted surfaces`, () => {
  const ratio = (fg, bg) => contrast(channels(palette.get(fg)), channels(palette.get(bg)));
  // Name, description, tags and origin on a row, at rest, hovered and focused; the sentence on the view background.
  for (const bg of ['surface', 'surface-2', 'sel']) for (const fg of ['fg', 'muted']) assert.ok(ratio(fg, bg) >= 4.5, `${theme}: ${fg} on ${bg}`);
  assert.ok(ratio('muted', 'bg') >= 4.5); assert.ok(ratio('fg', 'bg') >= 4.5);
});
