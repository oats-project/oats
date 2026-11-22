// The Desktop UI rework, slice 3d: the main screen looks like the prototype's frame A — the sidebar, the tab strip, the
// agent view, the key bar and the sheets — in the theme's tokens (pinned acceptance tests). In-memory DOM and CSSOM
// checks, from the shipped rule text where jsdom can't compute; the live look is the Electron check in the hand-back.
// The prototype's values are its frame A stylesheet's (style.css, "frame A: the app"), quoted beside each.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { TEXT_PAIRS, TEXT_CONTRAST } from '../renderer/contrast-inventory.mjs';
import { statusLineCSS, createStatusLine } from '../renderer/status-line.mjs';
import { sheetCSS } from '../renderer/sheet.mjs';
import { mailSheetCSS } from '../renderer/mail-sheet.mjs';
import { appearanceCSS } from '../renderer/theme-picker.mjs';
import { createAgentBoard, createHiddenFacts, defaultMeasure, outerHeight } from '../renderer/agent-board.mjs';
import { createTabChrome } from '../renderer/tab-a11y.mjs';
import { numberTabStrips } from '../renderer/tab-numbers.mjs';
import { boardData } from '../../client/instance-board.mjs';
import { NOW, board } from './helpers/board-fixture.mjs';

const renderer = new URL('../renderer/', import.meta.url);
const read = name => readFileSync(new URL(name, renderer), 'utf8');
const themeCSS = read('theme.css'), shellCSS = read('shell.css'), html = read('index.html');

/* ── the palettes, as theme-contrast reads them ─────────────────────────────────────────────────────────── */
const tokens = block => new Map([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim().toLowerCase()]));
const dark = tokens(themeCSS.match(/:root, \[data-theme="dark"\] \{([\s\S]*?)\n\}/)[1]);
const overlay = name => { const out = new Map(dark); for (const [k, v] of tokens(themeCSS.match(new RegExp(`\\[data-theme="${name}"\\] \\{([\\s\\S]*?)\\n\\}`))[1])) out.set(k, v); return out; };
const palettes = [['dark', dark], ['light', overlay('light')], ['solarized', overlay('solarized')]];
const channels = hex => { assert.match(hex, /^#[0-9a-f]{6}$/, `opaque: ${hex}`); return hex.slice(1).match(/../g).map(v => parseInt(v, 16)); };
const luminance = rgb => { const c = rgb.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const x = luminance(channels(a)), y = luminance(channels(b)); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

/** The declarations of the one top-level rule (outside @media and the like) whose selector is exactly `selector`, in `source` (comments stripped). */
function declarations(source, selector) {
  const topLevel = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@(?:media|supports|container)[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  const rules = [...topLevel.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, sel]) => sel.trim().replace(/\s+/g, ' ') === selector);
  assert.equal(rules.length, 1, `one rule: ${selector}`);
  return new Map(rules[0][2].split(';').map(d => d.trim()).filter(Boolean).map(d => { const at = d.indexOf(':'); return [d.slice(0, at).trim(), d.slice(at + 1).trim()]; }));
}
const decl = (selector, source = shellCSS) => declarations(source, selector);

function page(t, body, sources, theme = 'dark') {
  const dom = new JSDOM(`<!doctype html><html data-theme="${theme}"><body>${body}</body></html>`, { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  for (const source of [themeCSS, ...sources]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
  return { dom, doc, css: el => dom.window.getComputedStyle(typeof el === 'string' ? doc.querySelector(el) : el), $: s => doc.querySelector(s), $$: s => [...doc.querySelectorAll(s)] };
}

/* ── the sidebar ─────────────────────────────────────────────────────────────────────────────────────────── */
test('slice3d sidebar heads uppercase and rows two-line compact', () => {
  // The heads: .kicker / .hdr — 10px, 650, .075em, uppercase, the dim ink. "WORKSPACES" (the words, in capitals by CSS)
  // and "AGENTS", each 20px in from the sidebar's edge (the side's 8px and the head's 12px), on the rows' dots' left edge.
  assert.match(html, /<span id="ws-heading" class="ws-heading">Workspaces<\/span>/);
  assert.match(html, /<div class="ctx-head"><span>Agents<\/span>/);
  for (const selector of ['.ws-heading', '.ctx-head']) {
    const d = decl(selector);
    assert.deepEqual([d.get('font-size'), d.get('font-weight'), d.get('letter-spacing'), d.get('text-transform'), d.get('color')],
      ['10px', '650', '.075em', 'uppercase', 'var(--muted)'], selector);
  }
  assert.equal(decl('.side-head').get('padding'), '6px 10px 0 20px'); assert.equal(decl('.side-head').get('height'), '34px'); // .wshead
  assert.match(decl('.ctx-head').get('padding'), / 20px$/, 'AGENTS 20px in');
  assert.equal(decl('.ctx-count').get('font-size'), '11px', 'the running count, quieter');
  // The workspace rows: .wsrow — 28px, 12px in, the name 13px; the current one bold (650).
  const ws = decl('.ws-option');
  assert.deepEqual([ws.get('min-height'), ws.get('padding'), ws.get('font-size'), ws.get('gap')], ['28px', '0 8px 0 12px', '13px', '12px']);
  assert.equal(decl('.ws-option[aria-current="true"] .ws-option-name').get('font-weight'), '650');
  assert.equal(decl('.ws-list').get('border-bottom'), '1.5px solid var(--border)', 'the 1.5px rule under the list');
  // The pinned rows: .row.one — 34px, the name 13px 500; Automations says "N failed" after its name in the failure ink.
  const nav = decl('.nav-item');
  assert.deepEqual([nav.get('min-height'), nav.get('font-size'), nav.get('font-weight')], ['34px', '13px', '500']);
  assert.deepEqual([decl('.nav-failed').get('color'), decl('.nav-failed').get('margin-left')], ['var(--danger)', '2px']);
  const shell = read('shell.mjs');
  assert.match(shell, /shown\.textContent = `\$\{count\} failed`;/, 'the count in words: "1 failed"');
  assert.match(shell, /onCount: \(count\) => paintAutomationsFailed\(count\),/);
  // The agent rows: .row — 44px, two lines: the name 13px/17px, then soul · machine 11.5px/15px in the dim ink; children
  // 18px a level (--tree-step); the dot 12px in.
  const row = decl('.ctx-tree-row');
  assert.deepEqual([row.get('min-height'), row.get('--tree-step'), row.get('--dot-inset')], ['44px', '18px', '12px']);
  assert.equal(row.get('padding-left'), 'calc(var(--depth) * var(--tree-step))', 'children indented under their parent');
  const name = decl('.ctx-name'), meta = decl('.ctx-meta.ctx-row-detail');
  assert.deepEqual([name.get('font-size'), name.get('line-height'), name.get('font-weight')], ['13px', '17px', '400']);
  assert.deepEqual([meta.get('font-size'), meta.get('line-height'), meta.get('color')], ['11.5px', '15px', 'var(--muted)']);
  assert.equal(decl('.ctx-copy').get('gap'), '0', 'two compact lines, nothing between them');
  // "new": .new — 11px, a 1px ring in the hairline, radius 4, padding 0 4px, line-height 14px, the word itself.
  const fresh = decl('.ctx-new');
  assert.deepEqual([fresh.get('font-size'), fresh.get('border-radius'), fresh.get('padding'), fresh.get('line-height'), fresh.get('box-shadow'), fresh.get('text-transform')],
    ['11px', '4px', '0 4px', '14px', 'inset 0 0 0 1px var(--border)', 'lowercase']);
  assert.equal(decl('.ctx-new-dot').get('display'), 'none');
  // The foot: "● 3 need you" in the body ink, 13px, and ?, .foot .q — a 22px circle in the hairline.
  assert.deepEqual([decl('#sidebar-need-you').get('font-size'), decl('#sidebar-need-you').get('font-weight'), decl('#sidebar-need-you').get('color')], ['13px', '400', 'var(--fg)']);
  assert.deepEqual([decl('#sidebar-bar > .side-icon-button').get('width'), decl('#sidebar-bar > .side-icon-button').get('border-radius')], ['22px', '50%']);
  assert.equal(decl('#sidebar-help').get('box-shadow'), 'inset 0 0 0 1px var(--border)');
});

/* ── the tab strip ───────────────────────────────────────────────────────────────────────────────────────── */
test('slice3d tab strip numbered with dot', t => {
  // .tabs — 44px; .tab — 28px pills, radius 8, 12px in, 12.5px, 4px apart; .tab.on — the raised fill, the bright ink,
  // its number in the accent.
  assert.equal(tokens(themeCSS.match(/:root, \[data-theme="dark"\] \{([\s\S]*?)\n\}/)[1]).get('bar-h'), '44px');
  const tab = decl('.tab');
  assert.deepEqual([tab.get('height'), tab.get('border-radius'), tab.get('font-size'), tab.get('padding')], ['28px', '8px', '12.5px', '0 4px 0 12px']);
  assert.equal(tab.get('border-right'), undefined, 'a pill, no divider');
  const strip = decl('#tabbar, .group-tabbar');
  assert.deepEqual([strip.get('align-items'), strip.get('gap'), strip.get('padding-left')], ['center', '4px', '12px']);
  assert.deepEqual([decl('.tab.active').get('background'), decl('.tab.active').get('color')], ['var(--surface-2)', 'var(--fg)']);
  assert.equal(decl('.tab.active').get('box-shadow'), undefined, 'no edge of its own: the fill is the mark');
  assert.equal(decl('.tab.active .tab-num').get('color'), 'var(--accent)');
  assert.equal(decl('.tab-num').get('font-family'), 'inherit', "the number in the chrome's sans, not a monospace");
  // Rendered: each tab has its status dot and its go-to number; the pane controls are quiet icon buttons.
  const u = page(t, '<div id="tabbar"></div>', [shellCSS]);
  const bar = u.$('#tabbar');
  for (const [i, active] of [[0, false], [1, true]]) {
    const { tabEl } = createTabChrome(u.doc, `t${i}`, `agent-${i}`, false, { dot: 'on' });
    if (active) tabEl.classList.add('active');
    bar.append(tabEl);
  }
  numberTabStrips([bar]);
  assert.deepEqual(u.$$('#tabbar .tab').map(el => [el.querySelector('.tab-dot') !== null, el.querySelector('.tab-num')?.textContent]), [[true, '1'], [true, '2']]);
  assert.equal(u.css('.tab-dot').width, '7px');
  const control = decl('#tab-actions button');
  assert.deepEqual([control.get('background'), control.get('color'), control.get('border')], ['none', 'var(--muted)', '0']);
});

/* ── the agent view's question card ──────────────────────────────────────────────────────────────────────── */
test('slice3d question card head, hint, boxed options with number badges', t => {
  const u = page(t, '<div class="tab-pane active"><div class="term-wrap"></div></div>', [shellCSS]);
  const view = createAgentBoard({ pane: u.$('.tab-pane'), home: '/h', name: 'dev-a', now: () => NOW, type: () => true, focusTerminal: () => {}, openLink: () => {},
    hidden: createHiddenFacts({ getItem: () => null, setItem: () => {} }) });
  view.update(boardData(board({ questions: [board().questions[0]] })));
  // .reqcard — the raised surface in the waiting border, radius 8, padding 9px 16px 7px, inset from the pane's edges.
  const card = decl('.agent-questions');
  assert.deepEqual([card.get('background-color'), card.get('border'), card.get('border-radius'), card.get('padding'), card.get('margin')],
    ['var(--surface)', '1px solid var(--attn-border)', '8px', '9px 16px 7px', '8px 20px 12px']);
  // .rqh — the needs-input mark, "needs you" in the waiting ink, " · asked … ago" muted; 12px.
  const head = u.$('.agent-q-head');
  assert.deepEqual([...head.children].map(el => el.getAttribute('class')).slice(0, 2), ['attn-mark agent-q-mark', 'agent-q-tag']);
  assert.equal(head.querySelector('.agent-q-tag').textContent, 'needs you');
  assert.match(head.querySelector('.agent-q-age').textContent, /^ · asked .+ ago$/);
  assert.deepEqual([decl('.agent-q-head').get('font-size'), decl('.agent-q-tag').get('color'), decl('.agent-q-tag').get('font-weight')], ['12px', 'var(--warn)', '400']);
  // The hint: its own keys ("1–2 …"), muted.
  assert.match(u.$('.agent-q-hint').textContent, /^1–2 /);
  assert.equal(u.css('.agent-q-hint').color, 'var(--muted)');
  // .rqq — the question line, 14px/20px 500.
  const q = decl('.agent-q-text');
  assert.deepEqual([q.get('font-size'), q.get('line-height'), q.get('font-weight')], ['14px', '20px', '500']);
  // .opts / .opt — a column of boxed rows, 3px apart: 30px at least, padding 5px 10px, a 1px hairline, radius 6, on the
  // page's ground; .num — a 20px badge, radius 4, on the raised fill, 11.5px 600.
  assert.deepEqual([decl('.agent-q-options').get('flex-direction'), decl('.agent-q-options').get('gap')], ['column', '3px']);
  const opt = decl('.agent-q-option');
  assert.deepEqual([opt.get('min-height'), opt.get('padding'), opt.get('border'), opt.get('border-radius'), opt.get('background')],
    ['30px', '5px 10px', '1px solid var(--border)', '6px', 'var(--bg)']);
  const num = decl('.agent-q-num');
  assert.deepEqual([num.get('width'), num.get('height'), num.get('border-radius'), num.get('background'), num.get('font-size'), num.get('font-weight')],
    ['20px', '20px', '4px', 'var(--surface-2)', '11.5px', '600']);
  assert.deepEqual(u.$$('.agent-q-option').map(b => [b.querySelector('.agent-q-num').textContent, b.querySelector('.agent-q-label').textContent]),
    [['1', 'Yes, one clean commit'], ['2', 'No, keep them']]);
  // The hovered or focused option: the accent border on the selection's fill, its number in the accent.
  const lit = decl('.agent-q-option:hover, .agent-q-option:focus-visible');
  assert.deepEqual([lit.get('border-color'), lit.get('background')], ['var(--accent)', 'var(--sel)']);
  // .opt.on .num — the highlighted option's badge filled with the accent, in its own ink (an inventoried pair).
  const litNum = decl('.agent-q-option:hover .agent-q-num, .agent-q-option:focus-visible .agent-q-num');
  assert.deepEqual([litNum.get('background'), litNum.get('color')], ['var(--accent)', 'var(--accent-fg)']);
  assert.ok(TEXT_PAIRS.some(([f, b]) => f === 'accent' && b === 'accent-fg'), 'the accent and its ink are a pair of the contrast inventory (held by "This computer" too)');
  // The facts: .pin — each its own 28px strip on the raised fill, radius 6, the pin and the time at the right.
  const fact = decl('.agent-fact');
  assert.deepEqual([fact.get('min-height'), fact.get('border-radius'), fact.get('background')], ['28px', '6px', 'var(--surface)']);
  assert.ok(u.$('.agent-fact > .agent-fact-pin'), 'the pin');
  assert.equal(decl('.agent-fact-focus > .agent-fact-updated').get('margin-left'), 'auto', 'the time at the right');
});

// Round 1's finding: the card's inset (8px above, 12px below) is the terminal's loss as much as the card is, so the
// board's budget (agent-board.mjs fit: the terminal keeps max(120px, 40% of the pane)) counts every child's outer
// height, margins included. jsdom lays nothing out (offsetHeight 0), so the margins it reads are the shipped CSS's.
test('slice3d the card\'s inset counts in the terminal\'s budget', t => {
  const u = page(t, '<div class="tab-pane active"><div class="term-wrap"></div></div>', [shellCSS]);
  const pane = u.$('.tab-pane');
  const view = createAgentBoard({ pane, home: '/h', name: 'dev-a', now: () => NOW, type: () => true, focusTerminal: () => {}, openLink: () => {},
    hidden: createHiddenFacts({ getItem: () => null, setItem: () => {} }), observe: () => () => {} });
  t.after(() => view.dispose());
  view.update(boardData(board({ questions: [board().questions[0]] })));
  const zone = u.$('.agent-questions');
  assert.equal(outerHeight(zone), 20, 'the card\'s 8px and 12px, its own box unmeasured here');
  assert.equal(defaultMeasure.used(pane), 20, 'the pane\'s budget counts them; the terminal counts nothing');
  // A laid-out box: its height and its margins.
  Object.defineProperty(zone, 'offsetHeight', { configurable: true, value: 150 });
  assert.equal(defaultMeasure.used(pane), 170);
});

/* ── the key bar ─────────────────────────────────────────────────────────────────────────────────────────── */
test('slice3d key bar layout', t => {
  // .status — 28px, 16px in, 12px, on the window's ground under a hairline; .hk the key in the bright ink, 500, in the
  // chrome's sans; .hl its words dim, 5px after; .sep a dim dot between two.
  const u = page(t, '', [statusLineCSS]);
  const keys = [{ keys: 'Enter', label: 'send the choice' }, { keys: '1..2', label: 'choose' }, { keys: 'Alt+K', label: 'palette' }];
  const line = createStatusLine({ doc: u.doc, host: u.doc.body, keysFor: () => keys });
  t.after(() => line.dispose());
  const bar = decl('.status-line', statusLineCSS);
  assert.deepEqual([bar.get('min-height'), bar.get('padding'), bar.get('font-size'), bar.get('background'), bar.get('border-top'), bar.get('color')],
    ['28px', '0 16px', '12px', 'var(--bg)', '1px solid var(--border)', 'var(--muted)']);
  assert.deepEqual(u.$$('.status-key').map(k => [k.querySelector('kbd').textContent, k.textContent]),
    [['Enter', 'Enter send the choice'], ['1..2', '1..2 choose'], ['Alt+K', 'Alt+K palette']]);
  const key = decl('.status-key kbd', statusLineCSS);
  assert.deepEqual([key.get('font'), key.get('font-weight'), key.get('color')], ['inherit', '500', 'var(--fg)']);
  assert.equal(key.get('font-family'), undefined, 'no monospace of its own');
  assert.equal(decl('.status-key', statusLineCSS).get('gap'), '5px');
  const sep = decl('.status-key + .status-key::before', statusLineCSS);
  assert.deepEqual([sep.get('content'), sep.get('width'), sep.get('height'), sep.get('border-radius'), sep.get('background')], ['""', '3px', '3px', '50%', 'var(--muted)'],
    'a drawn dot, no character for a screen reader to say');
});

/* ── tokens and contrast ─────────────────────────────────────────────────────────────────────────────────── */
const CHANGED = { 'shell.css': shellCSS, statusLineCSS, sheetCSS, mailSheetCSS, appearanceCSS };

test('slice3d tokens not page-local', () => {
  for (const [name, source] of Object.entries(CHANGED)) {
    const rules = source.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(rules, /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\bopacity\s*:/i, `${name}: colours are the theme's tokens, never raw values or text transparency`);
  }
  // The sheets' heads: the title in 15px 600, the section heads small uppercase (.sheet .ch .ttl, .spage h6).
  assert.deepEqual([decl('.sheet-head h2', sheetCSS).get('font-size'), decl('.sheet-head h2', sheetCSS).get('font-weight')], ['15px', '600']);
  assert.deepEqual([decl('.mail-sheet-head h2', mailSheetCSS).get('font-size'), decl('.mail-sheet-head h2', mailSheetCSS).get('font-weight')], ['15px', '600']);
  for (const [selector, source] of [['.appearance-section h3', appearanceCSS], ['.mail-sheet-lead', mailSheetCSS], ['.leader-help-title', shellCSS], ['.kb-context', shellCSS]]) {
    const d = declarations(source, selector);
    assert.deepEqual([d.get('font-size'), d.get('text-transform'), d.get('letter-spacing')], ['11px', 'uppercase', '.06em'], selector);
  }
  assert.deepEqual([decl('.kb-title').get('font-size'), decl('.kb-title').get('font-weight')], ['15px', '600']);
  // Appearance: frame A's page sheet (.sheet.pgsheet 760px) and its option columns (.spage .opt: 16px 160px 1fr): the
  // name in a 160px column, what it does beside it, wrapping under it only where the window is too narrow.
  assert.equal(declarations(appearanceCSS, '.appearance-sheet').get('width'), 'min(760px,calc(100vw - 32px))');
  assert.equal(declarations(appearanceCSS, '.theme-picker-label').get('flex'), '0 0 160px');
  assert.equal(declarations(appearanceCSS, '.theme-picker-text').get('flex-wrap'), 'wrap');
  // The terminal's cell geometry is untouched: its size and its face are as before.
  assert.equal(dark.get('term-font-size'), '15px');
  assert.match(dark.get('term-font-family'), /^"inconsolata"/);
});

// Every ink/fill pair the slice's rules paint, as [what, foregrounds, surfaces].
const CHANGED_PAIRS = [
  ['the WORKSPACES and AGENTS heads, a row\'s second line, the count', ['muted'], ['surface', 'surface-2', 'sel']],
  ['the pinned rows and the workspace rows', ['fg'], ['surface', 'surface-2', 'sel']],
  ['"1 failed"', ['danger'], ['surface', 'surface-2', 'sel']],
  ['a tab at rest, hovered, focused: its name and number', ['muted', 'faint'], ['bg', 'surface', 'sel']],
  ['the active tab: its name and number', ['fg', 'accent'], ['surface-2', 'sel']],
  ['the facts: label, value, time', ['fg', 'muted', 'accent'], ['surface']],
  ['the card: needs you, its age, the question, the hint, the context', ['warn', 'muted', 'fg'], ['surface']],
  ['an option, hovered or focused, and its number', ['fg', 'muted', 'accent'], ['bg', 'sel', 'surface-2']],
  ['a highlighted option\'s filled number (the pair, accent first, as the inventory holds it)', ['accent'], ['accent-fg']],
  ['the key bar', ['fg', 'muted'], ['bg']],
  ['the sheets: titles, section heads, rows', ['fg', 'muted', 'accent'], ['surface', 'surface-2', 'sel']],
];

test('slice3d contrast AA in every theme for the changed pairs', () => {
  for (const [what, fgs, bgs] of CHANGED_PAIRS) for (const fg of fgs) for (const bg of bgs) {
    assert.ok(TEXT_PAIRS.some(([f, b]) => f === fg && b === bg), `${what}: --${fg} on --${bg} is in the contrast inventory`);
    for (const [theme, palette] of palettes) {
      const ratio = contrast(palette.get(fg), palette.get(bg));
      assert.ok(ratio >= TEXT_CONTRAST, `${theme}, ${what}: --${fg} on --${bg} is ${ratio.toFixed(2)}:1`);
    }
  }
});
