// The Appearance sheet (renderer/theme-picker.mjs createAppearanceSheet; the Desktop UI rework, slice 4): the theme,
// the terminals' font and their size in one sheet. It replaces the theme picker and the font picker, whose tests
// (theme-picker.test.mjs, font-picker.test.mjs) it carries over: the marks, the keys, the focus rules, the
// inventoried colours, the real theme runtime and the background chords. Inert jsdom; no Electron, storage or OS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { createAppearanceSheet, appearanceCSS } from '../renderer/theme-picker.mjs';
import { sheetCSS } from '../renderer/sheet.mjs';
import { createPalette } from '../renderer/palette.mjs';
import { THEMES, fontChoices } from '../renderer/theme.mjs';
import { TEXT_PAIRS } from '../renderer/contrast-inventory.mjs';
import { registerAction, handleKeydown } from '../renderer/keybindings.mjs';
import { createLifecycleDialog } from '../renderer/lifecycle-dialog.mjs';
import { instance as lifecycleInstance } from './helpers/lifecycle-fixture.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, { theme: initialTheme = 'dark', font: initialFont = 'system', isMac = false } = {}) {
  const dom = new JSDOM('<!doctype html><body><button id="opener">Appearance</button><input id="field"></body>', { pretendToBeVisual: true });
  const doc = dom.window.document, chosen = []; let theme = initialTheme, font = initialFont; const listeners = new Set();
  const sheet = createAppearanceSheet({ doc, themes: THEMES, fonts: () => fontChoices(isMac), currentTheme: () => theme, currentFont: () => font,
    chooseTheme: id => { chosen.push(id); theme = id; }, chooseFont: id => { chosen.push(`font:${id}`); font = id; },
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, chooseFamily: () => chosen.push('family') });
  t.after(() => { sheet.dispose(); dom.window.close(); });
  const opener = doc.getElementById('opener'); opener.focus();
  const key = (value, extra = {}, target = doc.activeElement) => {
    const event = new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra });
    target.dispatchEvent(event); return event;
  };
  const list = name => doc.querySelector(`[aria-labelledby="appearance-${name}"] .appearance-list`);
  return { dom, doc, sheet, chosen, opener, key,
    overlays: () => [...doc.querySelectorAll('.sheet-backdrop')].filter(el => el.querySelector('.appearance-sheet')),
    rows: (name = 'theme') => [...(list(name)?.querySelectorAll('li:not([hidden]) > .theme-picker-row') ?? [])],
    change(next) { theme = next; for (const fn of listeners) fn(next); },
    changeFont(next) { font = next; for (const fn of listeners) fn(next); } };
}
const label = row => row.querySelector('.theme-picker-label').textContent;

test('open: one centred sheet, a labelled modal dialog, the themes in order, the current one marked and focused', t => {
  const f = fixture(t);
  f.sheet.open();
  assert.equal(f.overlays().length, 1);
  const overlay = f.overlays()[0];
  assert.ok(overlay.classList.contains('palette-overlay'), 'the shared modal backdrop (scrim, focus provenance)');
  const dialog = overlay.querySelector('[role="dialog"]');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  const title = f.doc.getElementById(dialog.getAttribute('aria-labelledby'));
  assert.ok(title && dialog.contains(title)); assert.equal(title.textContent, 'Appearance');
  assert.equal(dialog.querySelector('.sheet-close').getAttribute('aria-label'), 'Close Appearance');
  const rows = f.rows();
  assert.deepEqual(rows.map(label), ['System', 'Dark', 'Light', 'More themes…']);
  assert.ok(rows.every(row => row.tagName === 'BUTTON' && row.type === 'button' && row.parentElement.tagName === 'LI'));
  assert.equal(rows[0].querySelector('.theme-picker-note').textContent, "Follows this computer's theme");
  for (const row of rows.slice(0, 3)) {
    const isCurrent = row.dataset.choiceId === 'dark';
    assert.equal(row.getAttribute('aria-current'), isCurrent ? 'true' : null, row.dataset.choiceId);
    assert.equal(/Current/.test(row.textContent), isCurrent, `${row.dataset.choiceId}: the visible word, not colour alone`);
    assert.equal(!!row.querySelector('.theme-picker-current svg[aria-hidden="true"]'), isCurrent, 'the check icon');
  }
  assert.equal(f.doc.activeElement, rows[1], 'focus on the current row');
  assert.match(sheetCSS, /\.palette-overlay\.sheet-backdrop \{ display:flex; align-items:center; justify-content:center;/, 'centred');
  assert.match(sheetCSS, /animation:sheet-in 150ms ease/, 'a 150 ms ease');
  assert.match(sheetCSS, /@media \(prefers-reduced-motion: reduce\) \{\n  \.palette-overlay\.sheet-backdrop, \.sheet-backdrop > \.sheet \{ animation:none; \}/, 'reduced motion: none');
  for (const css of [sheetCSS, appearanceCSS]) assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgb|hsl|opacity/i, 'no raw colour, no opacity');
});

test('More themes… shows the other themes; one of them current is shown at once', t => {
  const f = fixture(t);
  f.sheet.open();
  f.rows().at(-1).click();
  assert.deepEqual(f.rows().map(label), ['System', 'Dark', 'Light', 'Solarized']);
  assert.equal(f.doc.activeElement, f.rows()[3], 'focus on the first one it shows');
  f.sheet.close();
  const g = fixture(t, { theme: 'solarized' });
  g.sheet.open();
  assert.deepEqual(g.rows().map(label), ['System', 'Dark', 'Light', 'Solarized']);
  assert.equal(g.doc.activeElement, g.rows()[3]);
});

for (const how of ['click', 'Enter', 'Space']) test(`choose by ${how}: chooseTheme(id) once, the marks move, the sheet stays`, t => {
  const f = fixture(t);
  f.sheet.open(); const light = f.rows()[2];
  if (how === 'click') light.click();
  else { light.focus(); const event = f.key(how === 'Enter' ? 'Enter' : ' '); if (!event.defaultPrevented) light.click(); }
  assert.deepEqual(f.chosen, ['light']);
  assert.equal(f.sheet.isOpen(), true);
  assert.equal(light.getAttribute('aria-current'), 'true');
  assert.equal(f.doc.querySelectorAll('[aria-labelledby="appearance-theme"] .theme-picker-current').length, 1);
});

for (const how of ['Escape', 'close button', 'backdrop']) test(`${how} closes with nothing chosen and focus back on the opener`, t => {
  const f = fixture(t);
  f.sheet.open();
  if (how === 'Escape') { const event = f.key('Escape'); assert.equal(event.defaultPrevented, true); }
  else if (how === 'close button') f.doc.querySelector('.sheet-close').click();
  else f.overlays()[0].dispatchEvent(new f.dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  assert.deepEqual(f.chosen, []); assert.equal(f.overlays().length, 0);
  assert.equal(f.doc.activeElement, f.opener);
});

test('a click inside the sheet but not on a row does not close it', t => {
  const f = fixture(t);
  f.sheet.open();
  for (const target of [f.doc.querySelector('.sheet h2'), f.doc.querySelector('.appearance-list'), f.doc.querySelector('.sheet')]) {
    target.dispatchEvent(new f.dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    target.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  }
  assert.equal(f.overlays().length, 1); assert.deepEqual(f.chosen, []);
});

test('arrows wrap inside a list, Home/End go to its ends, and Tab / Shift+Tab never leave the sheet', t => {
  const f = fixture(t);
  f.sheet.open(); const rows = f.rows(), close = f.doc.querySelector('.sheet-close');
  const at = () => rows.indexOf(f.doc.activeElement);
  assert.equal(at(), 1);
  f.key('ArrowDown'); assert.equal(at(), 2);
  f.key('ArrowDown'); assert.equal(at(), 3);
  f.key('ArrowDown'); assert.equal(at(), 0, 'Down wraps to the first row');
  f.key('ArrowUp'); assert.equal(at(), 3, 'Up wraps to the last row');
  f.key('Home'); assert.equal(at(), 0); f.key('End'); assert.equal(at(), 3);
  assert.deepEqual(f.chosen, [], 'moving applies nothing (no preview)');
  const dialog = f.doc.querySelector('.sheet');
  const stops = [close, ...dialog.querySelectorAll('.sheet-body button')].filter(el => !el.closest('[hidden]'));
  stops.at(-1).focus(); assert.equal(f.key('Tab').defaultPrevented, true); assert.equal(f.doc.activeElement, close, 'Tab from the last control wraps to the close button');
  assert.equal(f.key('Tab', { shiftKey: true }).defaultPrevented, true); assert.equal(f.doc.activeElement, stops.at(-1), 'Shift+Tab from the close button wraps to the last');
  for (const stop of stops) for (const shiftKey of [false, true]) {
    stop.focus(); f.key('Tab', { shiftKey }); assert.ok(dialog.contains(f.doc.activeElement), `Tab${shiftKey ? '+Shift' : ''} from ${stop.className}`);
  }
  assert.equal(f.overlays().length, 1);
});

test('modified keys and key repeat on a row choose nothing: the opening chord goes on to the keymap engine', t => {
  const f = fixture(t);
  f.sheet.open(); const row = f.rows()[0]; row.focus();
  for (const mods of [{ ctrlKey: true, shiftKey: true }, { metaKey: true, shiftKey: true }, { ctrlKey: true }]) {
    const event = f.key(' ', { code: 'Space', ...mods });
    assert.equal(event.defaultPrevented, false, JSON.stringify(mods));
  }
  f.key('Enter', { repeat: true }); f.key(' ', { repeat: true });
  assert.deepEqual(f.chosen, []); assert.equal(f.overlays().length, 1);
});

test('toggle() opens then closes; open() twice is one sheet', t => {
  const f = fixture(t);
  f.sheet.toggle(); assert.equal(f.overlays().length, 1); assert.equal(f.sheet.isOpen(), true);
  f.sheet.toggle(); assert.equal(f.overlays().length, 0); assert.equal(f.doc.activeElement, f.opener);
  f.sheet.open(); const rows = f.rows(); f.sheet.open();
  assert.equal(f.overlays().length, 1); assert.equal(f.doc.querySelectorAll('[aria-modal="true"]').length, 1);
  assert.deepEqual(f.rows(), rows, 'the same rows, not a second build');
  f.sheet.close(); assert.equal(f.doc.activeElement, f.opener, 'the opener survives a second open()');
});

test('open({ focus }) lands on the Font list or the size; open() on an open sheet moves there', t => {
  const f = fixture(t);
  f.sheet.open({ focus: 'font' });
  assert.equal(f.doc.activeElement, f.rows('font')[0], 'the current font, System');
  f.sheet.open({ focus: 'theme' });
  assert.equal(f.doc.activeElement, f.rows()[1]);
  assert.equal(f.overlays().length, 1);
});

test('a theme or font changed while open moves the marks only: the rows and focus stay', t => {
  const f = fixture(t);
  f.sheet.open(); const rows = f.rows(); rows[0].focus();
  f.change('host');
  assert.deepEqual(f.rows(), rows, 'no rebuild under focus');
  assert.equal(f.doc.activeElement, rows[0], 'focus stays where it is');
  assert.deepEqual(rows.slice(0, 3).map(row => row.getAttribute('aria-current')), ['true', null, null]);
  f.changeFont('omarchy');
  assert.deepEqual(f.rows('font').slice(0, 2).map(row => row.getAttribute('aria-current')), [null, 'true']);
  f.sheet.close(); f.change('light'); assert.equal(f.overlays().length, 0, 'a change while closed builds nothing');
});

test('the Font list: System, this computer\'s monospace (not on macOS), Choose…; a pick applies at once', t => {
  const f = fixture(t);
  f.sheet.open({ focus: 'font' });
  assert.deepEqual(f.rows('font').map(label), ['System', "This computer's monospace", 'Choose…']);
  f.rows('font')[1].click();
  assert.deepEqual(f.chosen, ['font:omarchy']);
  const mac = fixture(t, { isMac: true });
  mac.sheet.open({ focus: 'font' });
  assert.deepEqual(mac.rows('font').map(label), ['System', 'Choose…'], 'on macOS the choice changes nothing since D2');
});

test('opened from the palette: the palette and its focus trap are gone, and closing returns to the original opener', async t => {
  const f = fixture(t), previous = globalThis.document;
  let palette;
  try {
    globalThis.document = f.doc;
    palette = createPalette({ loadInstances: async () => [], openTerminal: () => {},
      commands: [{ label: 'Appearance…', run: () => f.sheet.open() }] });
  } finally { globalThis.document = previous; }
  t.after(() => palette.close());
  await palette.open(); await tick();
  const input = f.doc.querySelector('.palette-input');
  input.value = '>appearance'; input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true })); await tick();
  f.key('Enter', {}, input); await tick();
  assert.equal(f.doc.querySelector('.palette-input'), null, 'the palette is gone');
  assert.equal(f.doc.querySelectorAll('[aria-modal="true"]').length, 1, 'one modal: the sheet');
  assert.equal(f.doc.activeElement, f.rows()[1]);
  f.doc.getElementById('field').focus();
  assert.equal(f.doc.activeElement, f.rows()[1], 'focus stays in the open sheet');
  f.key('Escape');
  assert.equal(f.overlays().length, 0); assert.equal(f.doc.activeElement, f.opener, 'focus back on what had it before the palette');
  f.doc.getElementById('field').focus();
  assert.equal(f.doc.activeElement.id, 'field', 'once closed, no sheet or palette trap is left behind');
});

test('the painted text and focus pairs are inventoried tokens (held to AA in every theme by theme-contrast.test.mjs)', t => {
  const f = fixture(t, { theme: 'host' });
  const style = f.doc.createElement('style'); style.textContent = sheetCSS + appearanceCSS; f.doc.head.append(style);
  f.sheet.open();
  const css = el => f.dom.window.getComputedStyle(el), value = v => v.match(/^var\(--([a-z0-9-]+)\)$/)?.[1];
  const pairs = [];
  const panel = f.doc.querySelector('.sheet-panel'), row = f.doc.querySelector('.theme-picker-row[aria-current]'), close = f.doc.querySelector('.sheet-close');
  pairs.push([value(css(panel).color), value(css(panel).background)]);
  pairs.push([value(css(row).color), value(css(row).background)]);
  pairs.push([value(css(row.querySelector('.theme-picker-note')).color), value(css(row).background)]);
  pairs.push([value(css(row.querySelector('.theme-picker-current')).color), value(css(row).background)]);
  pairs.push([value(css(close).color), value(css(close).background)]);
  pairs.push([value(css(f.doc.querySelector('.appearance-section h3')).color), 'surface']);
  pairs.push([value(css(f.doc.querySelector('.appearance-note')).color), 'surface']);
  const rule = selector => [...f.doc.styleSheets[0].cssRules].find(r => r.selectorText === selector)?.style;
  const focusBg = value(rule('.theme-picker-row:focus-visible').background), hoverBg = value(rule('.theme-picker-row:hover').background);
  for (const bg of [focusBg, hoverBg]) for (const fg of ['fg', 'muted', 'accent']) pairs.push([fg, bg]);
  pairs.push([value(rule('.sheet-close:focus-visible').color), value(rule('.sheet-close:focus-visible').background)]);
  for (const [fg, bg] of pairs) {
    assert.ok(fg && bg, `token pair: ${fg} on ${bg}`);
    assert.ok(TEXT_PAIRS.some(([a, b]) => a === fg && b === bg), `${fg} on ${bg} is in the contrast inventory`);
  }
});

// With the real theme runtime (as theme-selection.test.mjs evaluates it): the Linux default since #637.
test('no saved theme and the "host" fallback: System is marked current, and choosing it stores host', t => {
  const source = readFileSync(new URL('../renderer/theme.mjs', import.meta.url), 'utf8');
  const dom = new JSDOM('<!doctype html><html data-theme="light"><body><button id="opener">Theme</button></body></html>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  let saved = null; const writes = [];
  const context = { document: dom.window.document, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    localStorage: { getItem: () => saved, setItem: (key, value) => { writes.push([key, value]); saved = value; } } };
  const theme = runInNewContext(`${source.replace(/\bexport /g, '')}\n({ THEMES, initTheme, currentTheme, setTheme, onThemeChange })`, context);
  assert.equal(theme.initTheme(null, 'host'), 'host'); assert.deepEqual(writes, [], 'the default is not stored');
  const doc = dom.window.document;
  const sheet = createAppearanceSheet({ doc, themes: theme.THEMES, fonts: () => [], currentTheme: theme.currentTheme, chooseTheme: theme.setTheme,
    currentFont: () => 'system', chooseFont: () => {}, subscribe: theme.onThemeChange });
  t.after(() => sheet.dispose());
  doc.getElementById('opener').focus(); sheet.open();
  const rows = [...doc.querySelectorAll('[aria-labelledby="appearance-theme"] .theme-picker-row[data-choice-id]')];
  assert.equal(rows[0].dataset.choiceId, 'host'); assert.equal(rows[0].getAttribute('aria-current'), 'true', 'System is current');
  assert.equal(doc.activeElement, rows[0]);
  rows[0].click();
  assert.deepEqual(writes, [['oatsweb.theme', 'host']], 'stored like any choice');
  // Storage that throws: the choice still applies in memory and the sheet shows it.
  context.localStorage.setItem = () => { throw new Error('storage full'); };
  rows[1].click();
  assert.equal(theme.currentTheme(), 'dark');
  assert.equal(rows[1].getAttribute('aria-current'), 'true');
});

// With the real runtime: the font default on Omarchy, stored only once chosen.
test('no saved font on Omarchy: the monospace is current and not stored; choosing System stores it and marks it', t => {
  const source = readFileSync(new URL('../renderer/theme.mjs', import.meta.url), 'utf8');
  const dom = new JSDOM('<!doctype html><html><body><button id="opener">Font</button></body></html>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  let saved = null; const writes = [];
  const context = { document: dom.window.document, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    localStorage: { getItem: () => saved, setItem: (key, value) => { writes.push([key, value]); saved = value; } } };
  const theme = runInNewContext(`${source.replace(/\bexport /g, '')}\n({ initFont, currentFont, setFont, onFontChange, fontChoices, fontFallsBack, FONT_FALLBACK_NOTE })`, context);
  assert.equal(theme.initFont(false, () => true, { isOmarchy: true }), 'omarchy'); assert.deepEqual(writes, [], 'the default is not stored');
  const doc = dom.window.document;
  const sheet = createAppearanceSheet({ doc, themes: THEMES, fonts: () => theme.fontChoices(false, theme.fontFallsBack()), currentTheme: () => 'dark', chooseTheme: () => {},
    currentFont: theme.currentFont, chooseFont: theme.setFont, subscribe: theme.onFontChange });
  t.after(() => sheet.dispose());
  doc.getElementById('opener').focus(); sheet.open({ focus: 'font' });
  const rows = [...doc.querySelectorAll('[aria-labelledby="appearance-font"] .theme-picker-row[data-choice-id]')];
  assert.deepEqual(rows.map(row => row.getAttribute('aria-current')), [null, 'true'], 'the monospace is current');
  rows[0].click();
  assert.deepEqual(writes, [['oats.desktop.font', 'system']], 'stored, per computer, like the theme');
  assert.deepEqual(rows.map(row => row.getAttribute('aria-current')), ['true', null]);
});

// The monospace row's note follows the latest fixed-width verdict (theme.mjs fontDraws, fontFallsBack), in place.
test('the fallback note follows a changed verdict in the same window, in place while open', t => {
  const shell = readFileSync(new URL('../renderer/shell.mjs', import.meta.url), 'utf8');
  assert.match(shell, /fonts: \(\) => fontChoices\(navigator\.platform\.includes\("Mac"\), fontFallsBack\(\)\), currentFont, chooseFont: \(id\) => \{ setTerminalFontFamily\(""\); setFont\(id\); \},/,
    'the shell reads the rows at each open and notification, not once at start');
  const source = readFileSync(new URL('../renderer/theme.mjs', import.meta.url), 'utf8');
  const dom = new JSDOM('<!doctype html><html><body><button id="opener">Font</button></body></html>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const context = { document: dom.window.document, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), localStorage: { getItem: () => null, setItem() {} } };
  const theme = runInNewContext(`${source.replace(/\bexport /g, '')}\n({ initFont, currentFont, setFont, onFontChange, fontChoices, fontFallsBack, FONT_FALLBACK_NOTE })`, context);
  let draws = true;
  theme.initFont(false, () => draws);
  const doc = dom.window.document;
  const sheet = createAppearanceSheet({ doc, themes: THEMES, fonts: () => theme.fontChoices(false, theme.fontFallsBack()), currentTheme: () => 'dark', chooseTheme: () => {},
    currentFont: theme.currentFont, chooseFont: theme.setFont, subscribe: theme.onFontChange });
  t.after(() => sheet.dispose());
  const notes = () => [...doc.querySelectorAll('[aria-labelledby="appearance-font"] .theme-picker-row[data-choice-id]')].map(row => row.querySelector('.theme-picker-note')?.textContent ?? null);
  doc.getElementById('opener').focus(); sheet.open({ focus: 'font' });
  assert.deepEqual(notes(), ['Inconsolata in the terminals', "Fontconfig's monospace in the terminals"], 'it draws');
  const focused = doc.activeElement;
  draws = false; theme.setFont('omarchy');
  assert.equal(theme.fontFallsBack(), true);
  assert.deepEqual(notes(), ['Inconsolata in the terminals', theme.FONT_FALLBACK_NOTE], 'in place');
  assert.equal(doc.activeElement, focused, 'and focus stays');
});

// With the keymap engine and the shell's one window keydown listener present (Linux chords).
function withEngine(t, f) {
  const offs = [
    registerAction({ id: 'sidebar.focusFilter', label: 'Focus the instance roster', context: 'global', run: () => f.doc.getElementById('field').focus() }),
    registerAction({ id: 'app.themePicker', label: 'Appearance…', context: 'global', run: e => { if (!e?.repeat) f.sheet.toggle(); } }),
  ];
  const listener = event => handleKeydown(event, { isMac: false });
  f.dom.window.addEventListener('keydown', listener);
  t.after(() => { offs.forEach(off => off()); f.dom.window.removeEventListener('keydown', listener); });
  return { chord: (extra = {}) => f.key(' ', { code: 'Space', ctrlKey: true, shiftKey: true, ...extra }) };
}

test('a background focus chord (Alt+F) cannot take focus out of the sheet: Tab and Escape keep working', t => {
  const f = fixture(t), engine = withEngine(t, f);
  engine.chord();
  assert.equal(f.overlays().length, 1, 'the chord opens it from the opener');
  const rows = f.rows(); rows[2].focus();
  const filter = f.key('f', { altKey: true });
  assert.equal(filter.defaultPrevented, true, 'the background action ran');
  assert.equal(f.doc.activeElement, rows[2], 'focus is pulled back to where it was in the sheet');
  f.key('Escape'); assert.equal(f.overlays().length, 0); assert.equal(f.doc.activeElement, f.opener, 'Escape closes and returns focus');
  engine.chord(); assert.equal(f.overlays().length, 1);
  engine.chord({ repeat: true }); assert.equal(f.overlays().length, 1, 'a repeat neither closes nor reopens');
  engine.chord(); assert.equal(f.overlays().length, 0); assert.equal(f.doc.activeElement, f.opener);
  assert.deepEqual(f.chosen, []);
});

// Opened from a dialog that stays open under it: focus-return skips controls under .palette-overlay, so the
// sheet returns focus to that control itself.
const dialogs = {
  'Retire/Stop (the real lifecycle dialog)': f => {
    const dialog = createLifecycleDialog({ doc: f.doc, request: () => new Promise(() => {}) });
    dialog.open({ operation: 'stop', instance: lifecycleInstance, workspace: 'team' });
    return { opener: f.doc.querySelector('.lifecycle-close'), dispose: () => dialog.dispose() };
  },
  'Connections (its overlay and close button)': f => {
    const overlay = f.doc.createElement('div'); overlay.className = 'palette-overlay forge-overlay';
    overlay.innerHTML = '<section role="dialog" aria-modal="true" aria-label="Settings"><button type="button">Close settings</button></section>';
    f.doc.body.append(overlay); const opener = overlay.querySelector('button'); opener.focus();
    return { opener, dispose: () => overlay.remove() };
  },
};
for (const [name, mount] of Object.entries(dialogs)) {
  for (const how of ['Escape', 'the chord', 'the close button']) test(`opened from ${name}: closing by ${how} returns focus to its control`, t => {
    const f = fixture(t), engine = withEngine(t, f), under = mount(f);
    t.after(() => under.dispose());
    assert.equal(f.doc.activeElement, under.opener);
    engine.chord(); assert.equal(f.overlays().length, 1); assert.ok(f.rows().includes(f.doc.activeElement));
    if (how === 'Escape') f.key('Escape');
    else if (how === 'the chord') engine.chord();
    else f.doc.querySelector('.sheet-close').click();
    assert.equal(f.overlays().length, 0);
    assert.ok(under.opener.isConnected, 'the dialog under it stays open');
    assert.equal(f.doc.activeElement, under.opener, 'focus is back on its control');
  });
}

// The sheet is on the palette layer: it never opens while a dialog above that layer is shown.
test('a shown dialog above the palette layer: the chord and open() do nothing; hidden or gone, the sheet opens', t => {
  const f = fixture(t), engine = withEngine(t, f);
  const spawn = f.doc.createElement('div'); spawn.className = 'spawn-modal';
  spawn.innerHTML = '<section class="spawn-dialog" role="dialog" aria-modal="true" aria-label="Spawn"><form><input class="fname"></form></section>';
  const workspace = f.doc.createElement('div'); workspace.className = 'ws-modal'; workspace.hidden = true;
  workspace.innerHTML = '<section class="ws-dialog" role="dialog" aria-modal="true" aria-label="Add a workspace"><input id="ws-suggestion-search"></section>';
  f.doc.body.append(spawn, workspace);
  const field = spawn.querySelector('input'); field.focus();
  engine.chord();
  f.sheet.open(); f.sheet.toggle();
  assert.equal(f.overlays().length, 0, 'no sheet under the spawn dialog');
  assert.equal(f.doc.activeElement, field, 'focus stays in the spawn form');
  spawn.remove(); f.opener.focus();
  engine.chord(); assert.equal(f.overlays().length, 1, 'opens once no higher dialog is shown');
  f.key('Escape'); assert.equal(f.doc.activeElement, f.opener);
  workspace.hidden = false; workspace.querySelector('input').focus();
  engine.chord(); assert.equal(f.overlays().length, 0, 'no sheet under the workspace dialog');
});

// Review round 4: Electron has no window.prompt; Choose… is a labelled field of the sheet, and the palette's
// "Terminal: set font family…" opens the sheet on it.
test("Font › Choose… shows a labelled field with the terminals' family; Enter applies it, and an empty one says what to type", t => {
  const dom = new JSDOM('<!doctype html><body><button id="opener">o</button></body>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document, applied = [];
  const sheet = createAppearanceSheet({ doc, themes: THEMES, fonts: () => fontChoices(false), currentTheme: () => 'dark', chooseTheme() {},
    currentFont: () => 'system', chooseFont() {}, chooseFamily: value => applied.push(value), currentFamily: () => 'Inconsolata, monospace' });
  t.after(() => sheet.dispose());
  doc.getElementById('opener').focus();
  sheet.open({ focus: 'font' });
  const form = doc.querySelector('.appearance-family');
  assert.equal(form.hidden, true, 'hidden until Choose…');
  [...doc.querySelectorAll('.appearance-more')].find(b => b.textContent.includes('Choose…')).click();
  const input = form.querySelector('input');
  assert.equal(form.hidden, false); assert.equal(doc.activeElement, input);
  assert.equal(doc.querySelector(`label[for="${input.id}"]`).textContent, 'Font family (a CSS font-family value)');
  assert.equal(input.value, 'Inconsolata, monospace');
  input.value = '  '; form.requestSubmit();
  assert.deepEqual(applied, []); assert.match(form.querySelector('[role="status"]').textContent, /Type a font family/);
  input.value = '"JetBrains Mono", monospace'; form.requestSubmit();
  assert.deepEqual(applied, ['"JetBrains Mono", monospace']);
  assert.equal(sheet.isOpen(), true, 'the sheet stays');
  sheet.close();
  sheet.open({ focus: 'family' });
  assert.equal(doc.activeElement, doc.querySelector('.appearance-family input'), "open({ focus: 'family' }) lands in the field");
  const shell = readFileSync(new URL('../renderer/shell.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(shell, /window\.prompt\(/, 'no window.prompt: Electron does not support it');
  assert.match(shell, /\{ label: "Terminal: set font family…", run: \(\) => appearance\.open\(\{ focus: "family" \}\) \}/);
});

test("open({ focus: 'size' }) lands on the size field, with the family field present, shown or not", t => {
  const dom = new JSDOM('<!doctype html><body><button id="opener">o</button></body>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const sheet = createAppearanceSheet({ doc, themes: THEMES, fonts: () => fontChoices(false), currentTheme: () => 'dark', chooseTheme() {},
    currentFont: () => 'system', chooseFont() {}, chooseFamily() {}, currentFamily: () => 'mono',
    terminalSize: () => { const el = doc.createElement('div'); el.innerHTML = '<input id="size" type="number" value="13">'; return { element: el, dispose() {} }; } });
  t.after(() => sheet.dispose());
  doc.getElementById('opener').focus();
  sheet.open({ focus: 'size' });
  assert.equal(doc.activeElement.id, 'size');
  sheet.open({ focus: 'family' });
  assert.ok(doc.activeElement.closest('.appearance-family'));
  sheet.open({ focus: 'size' });
  assert.equal(doc.activeElement.id, 'size', 'after Choose… too');
});

// The two-area reader: a family chosen by name won over the named fonts, which were marked Current but changed nothing.
test("with the real runtime: after Choose… sets a family, a named font clears it and applies, and the marks follow", t => {
  const source = readFileSync(new URL('../renderer/theme.mjs', import.meta.url), 'utf8');
  const dom = new JSDOM('<!doctype html><html><body><button id="opener">Font</button></body></html>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const stored = new Map();
  const context = { document: dom.window.document, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    localStorage: { getItem: k => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, String(v)), removeItem: k => stored.delete(k) } };
  const theme = runInNewContext(`${source.replace(/\bexport /g, '')}\n({ initFont, currentFont, setFont, onFontChange, fontChoices, fontFallsBack, setTerminalFontFamily, terminalTypography, terminalFamilyChosen, onTerminalTypographyChange })`, context);
  theme.initFont(false, () => true, { isOmarchy: true });
  const doc = dom.window.document;
  // The shell's wiring (shell.mjs createAppearanceSheet), against the runtime.
  const sheet = createAppearanceSheet({ doc, themes: THEMES, currentTheme: () => 'dark', chooseTheme() {},
    fonts: () => theme.fontChoices(false, theme.fontFallsBack()), currentFont: theme.currentFont,
    chooseFont: (id) => { theme.setTerminalFontFamily(''); theme.setFont(id); },
    customFamily: () => theme.terminalFamilyChosen(), chooseFamily: (family) => theme.setTerminalFontFamily(family),
    currentFamily: () => theme.terminalTypography().fontFamily,
    subscribe: fn => { const offs = [theme.onFontChange(fn), theme.onTerminalTypographyChange(fn)]; return () => offs.forEach(off => off()); } });
  t.after(() => sheet.dispose());
  doc.getElementById('opener').focus(); sheet.open({ focus: 'family' });
  const form = doc.querySelector('.appearance-family');
  form.querySelector('input').value = '"Iosevka", monospace'; form.requestSubmit();
  assert.equal(theme.terminalTypography().fontFamily, '"Iosevka", monospace');
  const rows = () => [...doc.querySelectorAll('[aria-labelledby="appearance-font"] .theme-picker-row[data-choice-id]')];
  assert.deepEqual(rows().map(r => r.getAttribute('aria-current')), [null, null], 'no named font is Current while a chosen family wins');
  const choose = [...doc.querySelectorAll('.appearance-more')].find(b => b.textContent.includes('Choose'));
  assert.match(choose.textContent, /Current: "Iosevka", monospace/);
  rows()[0].click(); // System
  assert.equal(theme.terminalFamilyChosen(), null, 'the chosen family is cleared');
  assert.match(theme.terminalTypography().fontFamily, /^"Inconsolata",/, 'System applies: Inconsolata');
  assert.deepEqual(rows().map(r => r.getAttribute('aria-current')), ['true', null]);
  assert.doesNotMatch(choose.textContent, /Current:/);
  rows()[1].click(); // the monospace
  assert.match(theme.terminalTypography().fontFamily, /ui-monospace, monospace/);
});
