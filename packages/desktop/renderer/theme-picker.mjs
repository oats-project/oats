// oats desktop — the Appearance sheet (the Desktop UI rework, slice 4; guide v6 tour step 21, D2, D10): one sheet
// from the palette for how the app looks. Three parts, in order:
//   Theme   System, Dark, Light, and "More themes…", which shows the others (Solarized). System is the choice
//           that was "This computer": it follows this computer's theme (host-theme.mjs), as before.
//   Font    the terminals' face (D2: the chrome is always the system sans): System (Inconsolata), this
//           computer's monospace on Linux and Windows (theme.mjs fontChoices), and Choose…, a family by name.
//   Terminal font size  the stepper of settings-terminal.mjs, over the same store as the keys.
// It replaces the theme picker, the font picker and the settings cog's terminal size, which it merges (the cog
// went in slice 1). app.themePicker opens it on Theme, app.fontPicker on Font.
//
// A row is a button: Enter, Space or a click applies its choice at once (stored like any choice, through the
// caller's `chooseTheme` / `chooseFont`) and the sheet stays open, the marks moving to it. The current row of
// each list says "Current" in words and a check, and has aria-current. ↑/↓ move within a list and wrap, Home
// and End go to its ends; Tab walks the sheet and wraps inside it (sheet.mjs). A choice changed by another path
// (the palette, a key, the host) only moves the marks. It is on the palette layer, so it does not open while a
// dialog above that layer is shown (the spawn dialog, the workspace dialog).
import { iconElement } from './shell-icons.mjs';
import { isShown } from './focus-regions.mjs';
import { openSheet } from './sheet.mjs';

export const appearanceCSS = `
.appearance-sheet { width:min(420px,calc(100vw - 32px)); }
.appearance-section { display:grid; gap:6px; margin:0; padding:0; border:0; min-width:0; }
.appearance-section h3 { margin:6px 0 0; font-size:11px; line-height:16px; font-weight:500; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; }
.appearance-note { margin:0; color:var(--muted); font-size:12px; line-height:1.45; }
.appearance-list { list-style:none; margin:0; padding:0; display:grid; gap:2px; }
.theme-picker-row { width:100%; display:flex; align-items:center; gap:12px; min-height:36px; padding:4px 10px; border:0; border-radius:6px; background:var(--surface); color:var(--fg); font:inherit; font-size:13px; text-align:left; cursor:pointer; }
.theme-picker-row:hover { background:var(--surface-2); }
.theme-picker-row:focus-visible { background:var(--sel); }
.theme-picker-row.appearance-more { color:var(--accent); }
/* Slice 3d: the prototype's option rows: the name, then what it does on the same line, muted. */
.theme-picker-text { flex:1; min-width:0; display:flex; flex-wrap:wrap; align-items:baseline; column-gap:12px; row-gap:0; }
.theme-picker-label { flex:0 0 132px; min-width:0; }
.theme-picker-text > .theme-picker-note { flex:1 1 120px; min-width:0; }
.theme-picker-note { color:var(--muted); font-size:12px; }
.theme-picker-current { flex:none; display:flex; align-items:center; gap:4px; color:var(--accent); font-size:12px; font-weight:600; }
.appearance-sheet .forge-card { padding:0; border:0; background:none; }
.appearance-sheet .term-size { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.appearance-sheet .term-size input { width:7ch; height:30px; box-sizing:border-box; padding:0 6px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--fg); font:inherit; text-align:center; font-variant-numeric:tabular-nums; }
.appearance-sheet .term-size input:focus-visible { outline:none; border-color:var(--accent); }
.appearance-sheet .term-size button, .appearance-sheet .forge-actions button { min-width:32px; height:30px; padding:0 10px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--fg); font:inherit; font-size:12.5px; cursor:pointer; }
.appearance-sheet .term-size button:focus-visible, .appearance-sheet .forge-actions button:focus-visible { background:var(--sel); }
.appearance-sheet .term-size [aria-disabled=true] { cursor:default; color:var(--faint); }
.appearance-sheet .forge-actions { margin-top:6px; }
.appearance-sheet .forge-hint { margin:6px 0 0; color:var(--muted); font-size:12px; }
.appearance-sheet section h3#settings-terminal-title { display:none; }
.appearance-family { display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin-top:4px; }
.appearance-family[hidden] { display:none; }
.appearance-family label { flex-basis:100%; color:var(--fg); font-size:12px; }
.appearance-family input { flex:1; min-width:0; height:30px; box-sizing:border-box; padding:0 8px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--fg); font:inherit; }
.appearance-family input:focus-visible { outline:none; border-color:var(--accent); }
.appearance-family button { height:30px; padding:0 10px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--fg); font:inherit; cursor:pointer; }
.appearance-family button:focus-visible { background:var(--sel); }
.appearance-family .appearance-note { flex-basis:100%; }
`;
/** Kept for the shell's one style sheet: the Appearance sheet's rules. */
export const themePickerCSS = appearanceCSS;

/** The theme rows in the sheet's order: System, Dark, Light, then the rest behind More themes. */
export const THEME_ORDER = Object.freeze(['host', 'dark', 'light']);
const THEME_NOTES = Object.freeze({ host: "Follows this computer's theme" });

const plainKey = event => !event.ctrlKey && !event.metaKey && !event.altKey;

/**
 * @param {object} spec
 * @param {Document} spec.doc
 * @param {ReadonlyArray<{id: string, label: string}>} spec.themes  THEMES
 * @param {() => ReadonlyArray<{id: string, label: string, note?: string}>} spec.fonts  fontChoices for this platform, now
 * @param {() => string} spec.currentTheme
 * @param {(id: string) => void} spec.chooseTheme  setTheme
 * @param {() => string} spec.currentFont
 * @param {(id: string) => void} spec.chooseFont  setFont
 * @param {(fn: Function) => Function} [spec.subscribe]  every change that moves a mark or a note (theme and font)
 * @param {() => { element: Element, dispose(): void }} [spec.terminalSize]  the size stepper (createTerminalSettings)
 * @param {(family: string) => void} [spec.chooseFamily]  Font › Choose…: applies a family by name (setTerminalFontFamily)
 * @param {() => string} [spec.currentFamily]  the terminals' family now (the field's first value)
 * @param {() => string | null} [spec.customFamily]  the family chosen by name, or null: while one is in effect no named
 *   font is marked Current (it wins over them), and Choose… says "Current: <family>"
 * @param {() => void} [spec.onIntent]
 */
export function createAppearanceSheet({ doc, themes, fonts, currentTheme, chooseTheme, currentFont, chooseFont, subscribe = () => () => {},
  terminalSize = null, chooseFamily = null, currentFamily = () => '', customFamily = () => null, onIntent = () => {} } = {}) {
  let sheet = null, lists = [], disposeSize = null, family = null, sizeSection = null;
  const node = (tag, text, cls) => { const el = doc.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
  /** A shown modal dialog that is not on the palette layer: it stacks above the sheet. */
  const higherDialogShown = () => [...doc.querySelectorAll('[aria-modal="true"]')].some(el => !el.closest('.palette-overlay') && isShown(el));

  /** One list of choices: its rows (buttons), its marks and notes kept in place. */
  function choiceList({ name, choices, current, choose, extra = [] }) {
    const list = node('ul', undefined, 'appearance-list');
    const rows = [];
    const row = ({ id, label, note }, run, cls = '') => {
      const item = node('li'), button = node('button', undefined, `theme-picker-row${cls ? ` ${cls}` : ''}`); button.type = 'button';
      if (id) button.dataset.choiceId = id;
      const text = node('span', undefined, 'theme-picker-text'); text.append(node('span', label, 'theme-picker-label'));
      if (note) text.append(node('span', note, 'theme-picker-note'));
      button.append(text); button.addEventListener('click', run);
      item.append(button); list.append(item); rows.push(button); return button;
    };
    for (const choice of choices()) row(choice, () => { if (sheet?.isOpen()) { choose(choice.id); mark(); } });
    for (const more of extra) more.button = row({ ...more, note: typeof more.note === 'function' ? more.note() : more.note }, () => more.run(), more.className);
    function mark() {
      let id = null;
      try { id = current(); } catch { /* no mark rather than a wrong one */ }
      for (const button of rows) {
        if (!button.dataset.choiceId) {
          // An extra row with a live note (Choose…: the family chosen by name, when one is in effect).
          const more = extra.find(each => each.button === button);
          if (typeof more?.note === 'function') {
            const note = more.note(), text = button.querySelector('.theme-picker-text'), shown = text.querySelector('.theme-picker-note');
            if (note && shown) { if (shown.textContent !== note) shown.textContent = note; }
            else if (note) text.append(node('span', note, 'theme-picker-note'));
            else shown?.remove();
          }
          continue;
        }
        const isCurrent = button.dataset.choiceId === id, shown = button.querySelector('.theme-picker-current');
        if (isCurrent) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current');
        if (isCurrent && !shown) {
          const badge = node('span', undefined, 'theme-picker-current');
          badge.append(iconElement(doc, 'check', { size: 14 }), node('span', 'Current'));
          button.append(badge);
        } else if (!isCurrent && shown) shown.remove();
      }
    }
    function annotate() {
      let now = [];
      try { now = choices(); } catch { return; }
      for (const button of rows) {
        const found = now.find(choice => choice.id === button.dataset.choiceId);
        if (!found) continue;
        const text = button.querySelector('.theme-picker-text'), shown = text.querySelector('.theme-picker-note');
        if (found.note && shown) { if (shown.textContent !== found.note) shown.textContent = found.note; }
        else if (found.note) text.append(node('span', found.note, 'theme-picker-note'));
        else shown?.remove();
      }
    }
    const shownRows = () => rows.filter(button => !button.closest('li').hidden);
    list.addEventListener('keydown', event => {
      const all = shownRows(), at = all.indexOf(event.target);
      if (at < 0 || !plainKey(event)) return;
      if ((event.key === 'Enter' || event.key === ' ') && event.repeat) { event.preventDefault(); return; }
      const to = { ArrowDown: (at + 1) % all.length, ArrowUp: (at - 1 + all.length) % all.length, Home: 0, End: all.length - 1 }[event.key];
      if (to === undefined) return;
      event.preventDefault(); event.stopPropagation(); all[to].focus();
    });
    mark();
    return { name, list, rows, mark, annotate, current: () => rows.find(button => button.getAttribute('aria-current') === 'true') ?? null };
  }

  function section(title, ...children) {
    const s = node('section', undefined, 'appearance-section'), h = node('h3', title);
    h.id = `appearance-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`; s.setAttribute('aria-labelledby', h.id);
    s.append(h, ...children); return s;
  }

  function open({ focus = 'theme' } = {}) {
    if (sheet?.isOpen()) { focusOn(focus); return; }
    if (higherDialogShown()) return; // the sheet never opens where it cannot be seen
    onIntent();
    sheet = openSheet({ doc, title: 'Appearance', className: 'appearance-sheet', closeLabel: 'Close Appearance',
      onClose: () => { disposeSize?.(); disposeSize = null; lists = []; },
      build: body => {
        const byId = new Map(themes.map(theme => [theme.id, theme]));
        const first = THEME_ORDER.filter(id => byId.has(id)), rest = themes.filter(theme => !THEME_ORDER.includes(theme.id));
        const themeChoices = () => [...first.map(id => byId.get(id)), ...rest].map(({ id, label }) => (THEME_NOTES[id] ? { id, label, note: THEME_NOTES[id] } : { id, label }));
        const more = { label: 'More themes…', className: 'appearance-more', run: () => {
          for (const theme of rest) themeList.rows.find(b => b.dataset.choiceId === theme.id).closest('li').hidden = false;
          more.button.closest('li').hidden = true;
          themeList.rows.find(b => b.dataset.choiceId === rest[0]?.id)?.focus();
        } };
        const themeList = choiceList({ name: 'theme', choices: themeChoices, current: currentTheme, choose: chooseTheme, extra: rest.length ? [more] : [] });
        // The other themes are folded behind More themes…, unless one of them is the current one.
        const restShown = rest.some(theme => theme.id === currentTheme());
        for (const theme of rest) themeList.rows.find(b => b.dataset.choiceId === theme.id).closest('li').hidden = !restShown;
        if (rest.length) more.button.closest('li').hidden = restShown;
        // Choose…: a family by name, in a labelled field of the sheet (Enter or Apply sets it; Esc closes the sheet).
        family = chooseFamily ? familyField() : null;
        const fontExtra = family ? [{ label: 'Choose…', className: 'appearance-more', run: () => family.show(),
          note: () => { const chosen = customFamily(); return chosen ? `Current: ${chosen}` : ''; } }] : [];
        const fontList = choiceList({ name: 'font', choices: fonts, current: () => (customFamily() ? null : currentFont()), choose: chooseFont, extra: fontExtra });
        lists = [themeList, fontList];
        const parts = [section('Theme', themeList.list),
          section('Font', node('p', "The terminals' font. The app's own text is always the system font.", 'appearance-note'), fontList.list, ...(family ? [family.element] : []))];
        if (terminalSize) {
          const size = terminalSize(); disposeSize = () => size.dispose();
          sizeSection = section('Terminal font size', size.element);
          parts.push(sizeSection);
        }
        body.append(...parts);
      } });
    focusOn(focus);
  }
  /** The family field: hidden until Choose… (or open({ focus: 'family' })). */
  function familyField() {
    const form = node('form', undefined, 'appearance-family'); form.hidden = true;
    const id = `appearance-family-${Math.random().toString(36).slice(2)}`;
    const label = node('label', 'Font family (a CSS font-family value)'); label.htmlFor = id;
    const input = node('input'); input.id = id; input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false;
    const apply = node('button', 'Apply'); apply.type = 'submit';
    const said = node('p', '', 'appearance-note'); said.setAttribute('role', 'status');
    form.append(label, input, apply, said);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) { said.textContent = 'Type a font family, like "JetBrains Mono", monospace.'; return; }
      chooseFamily(value);
      said.textContent = `The terminals use ${value} now.`;
      for (const list of lists) list.mark();
    });
    return { element: form, show() { form.hidden = false; input.value = currentFamily() || ''; input.focus(); input.select?.(); } };
  }
  function focusOn(focus) {
    if (!sheet?.isOpen()) return;
    if (focus === 'family' && family) { family.show(); return; }
    // The size section's own field, never the family field (hidden until Choose…).
    if (focus === 'size') { sizeSection?.querySelector('input')?.focus(); return; }
    const list = lists.find(each => each.name === focus) ?? lists[0];
    (list?.current() ?? list?.rows.find(b => !b.closest('li').hidden))?.focus();
  }
  const close = options => sheet?.close(options);
  const isOpen = () => !!sheet?.isOpen();
  const off = subscribe(() => { if (isOpen()) for (const list of lists) { list.annotate(); list.mark(); } });
  return { open, close, isOpen, toggle: options => (isOpen() ? close() : open(options)), dispose() { close({ restoreFocus: false }); off(); } };
}
