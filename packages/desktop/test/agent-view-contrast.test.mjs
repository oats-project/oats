// The agent view (renderer/agent-board.mjs) meets WCAG AA 4.5:1 on the surface it is painted over, in every built-in
// theme: computed from the shipped shell.css, resolved through the theme's tokens. Token colours only, and nothing
// above the text is translucent (no opacity compositing over text; a disabled option is its own token pair).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createAgentBoard, createHiddenFacts } from '../renderer/agent-board.mjs';
import { boardData } from '../../client/instance-board.mjs';
import { TEXT_PAIRS } from '../renderer/contrast-inventory.mjs';
import { NOW, board } from './helpers/board-fixture.mjs';

const renderer = new URL('../renderer/', import.meta.url);
const theme = readFileSync(new URL('theme.css', renderer), 'utf8'), shell = readFileSync(new URL('shell.css', renderer), 'utf8');
const channels = hex => { assert.match(hex, /^#[0-9a-f]{6}$/i, 'an opaque hex colour'); return hex.slice(1).match(/../g).map(v => parseInt(v, 16)); };
const luminance = rgb => { const c = rgb.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const token = value => value.replace(/^.*var\(--([\w-]+)\).*$/, '$1');

// [text selector, its painted surface's selector, the surface token]
const TEXTS = [
  ['.agent-fact-label', '.agent-facts', 'surface'], ['.agent-fact-value', '.agent-facts', 'surface'], ['.agent-fact-updated', '.agent-facts', 'surface'],
  ['.agent-fact-link', '.agent-fact-link', 'surface'], ['.agent-fact-says', '.agent-fact-link', 'surface'], ['.agent-fact-host', '.agent-fact-link', 'surface'],
  ['.agent-fact-hide', '.agent-fact-hide', 'surface'], ['.agent-facts-fold', '.agent-facts-fold', 'surface'],
  ['.agent-q-tag', '.agent-questions', 'attn-bg'], ['.agent-q-age', '.agent-questions', 'attn-bg'], ['.agent-q-text', '.agent-questions', 'attn-bg'],
  ['.agent-q-option:not(:disabled)', '.agent-q-option:not(:disabled)', 'surface'], ['.agent-q-option:not(:disabled) .agent-q-num', '.agent-q-option:not(:disabled) .agent-q-num', 'surface-2'],
  ['.agent-q-option:disabled', '.agent-q-option:disabled', 'surface'], ['.agent-q-option:disabled .agent-q-num', '.agent-q-option:disabled .agent-q-num', 'surface-2'],
  ['.agent-q-turn', '.agent-q-turn', 'surface'], ['.agent-q-note', '.agent-questions', 'attn-bg'], ['.agent-q-hint', '.agent-questions', 'attn-bg'],
  ['.agent-q-context > summary', '.agent-questions', 'attn-bg'], ['.agent-q-says', '.agent-questions', 'attn-bg'], ['.agent-q-context-text', '.agent-questions', 'attn-bg'],
];

for (const name of ['light', 'solarized', 'dark']) test(`${name}: the agent view's text meets computed AA on its surface`, () => {
  const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><body><div class="tab-pane active"><div class="term-wrap"></div></div></body></html>`, { pretendToBeVisual: true });
  const doc = dom.window.document, win = dom.window;
  for (const source of [theme, shell]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
  const pane = doc.querySelector('.tab-pane');
  const store = new Map();
  const view = createAgentBoard({ pane, home: '/h', name: 'dev-a', now: () => NOW, type: () => true, focusTerminal: () => {}, openLink: () => {},
    hidden: createHiddenFacts({ getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }) });
  const many = board();
  many.facts.push(...['c', 'd'].map(key => ({ ...many.facts[0], key })));
  many.questions[0].options = ['Yes', 'token=abcdefghij'];
  many.questions[0].hasContext = true;
  view.update(boardData(many));
  view.detail({ state: 'ok', facts: new Map(), questions: new Map([['q1', { context: 'one\ntwo' }]]) });
  const root = win.getComputedStyle(doc.documentElement), value = t => channels(root.getPropertyValue(`--${t}`).trim());
  for (const [selector, surface, bg] of TEXTS) {
    const el = doc.querySelector(selector), under = doc.querySelector(surface);
    assert.ok(el, selector); assert.ok(under, surface);
    const paint = win.getComputedStyle(under);
    assert.equal(token(/var\(/.test(paint.background) ? paint.background : paint.backgroundColor), bg, `${selector}: painted on --${bg}`);
    const fg = token(win.getComputedStyle(el).color);
    assert.ok(TEXT_PAIRS.some(([a, b]) => a === fg && b === bg), `${fg} on ${bg} is in the contrast inventory`);
    assert.ok(contrast(value(fg), value(bg)) >= 4.5, `${name} ${selector}: --${fg} on --${bg}`);
    for (let parent = el; parent; parent = parent.parentElement) assert.equal(win.getComputedStyle(parent).opacity, '1', `${selector}: no opacity`);
  }
  dom.window.close();
});

test('the agent view paints tokens only: no raw colour in its rules', () => {
  const block = shell.slice(shell.indexOf('/* The agent view (S2-D'), shell.indexOf('.term-banner {'));
  assert.ok(block.length > 1000, 'the agent view\'s rules');
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|opacity\s*:/i);
});

// Round 1's layout findings: the terminal is the one scrolling region (a long context scrolls only inside its open
// fold), and a link's whole address is shown before the press, wrapped, never cut with an ellipsis.
test('the agent view layout: no scrolling zone, the context fold\'s text the one exception; links shown whole', () => {
  const dom = new JSDOM(`<!doctype html><html data-theme="dark"><body><div class="tab-pane active"><div class="term-wrap"></div></div></body></html>`);
  const doc = dom.window.document, win = dom.window;
  for (const source of [theme, shell]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
  const view = createAgentBoard({ pane: doc.querySelector('.tab-pane'), home: '/h', name: 'dev-a', now: () => NOW, type: () => true, focusTerminal: () => {}, openLink: () => {},
    hidden: createHiddenFacts({ getItem: () => null, setItem: () => {} }) });
  const long = `https://example.com/${'a'.repeat(480)}`;
  const b = board(); b.facts[1].link = long; b.questions[0].hasContext = true;
  view.update(boardData(b));
  view.detail({ state: 'ok', facts: new Map(), questions: new Map([['q1', { context: 'line\n'.repeat(400) }]]) });
  for (const selector of ['.agent-questions', '.agent-facts', '.agent-q-context', '.agent-q-context-body']) {
    const css = win.getComputedStyle(doc.querySelector(selector));
    assert.ok(!['auto', 'scroll'].includes(css.overflowY) && !['auto', 'scroll'].includes(css.overflow), `${selector} does not scroll`);
  }
  assert.equal(win.getComputedStyle(doc.querySelector('.agent-q-context-text')).overflowY, 'auto', 'a long context scrolls in its open fold');
  const link = doc.querySelector('.agent-fact-link'), css = win.getComputedStyle(link);
  assert.ok(link.textContent.endsWith(long), 'the whole address is the text');
  assert.notEqual(css.textOverflow, 'ellipsis'); assert.notEqual(css.whiteSpace, 'nowrap'); assert.notEqual(css.overflow, 'hidden');
  dom.window.close();
});
