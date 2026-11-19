/** The New agent form's Soul field (Desktop UI rework, slice 5; guide steps 22 and 23).
 *
 * A soul chosen: a button that shows it (its mark, its name and its description) and opens the list. No soul yet, or
 * the list opened: a combobox (the APG pattern: focus stays in the text field, ↑↓ move the active option, Enter
 * chooses it) over a listbox of every soul with its description. Typing filters the list with Quick Open's own
 * matcher (`quickOpenRows`, renderer/quick-open.mjs), so the form and the palette's souls find the same souls in the
 * same order. A soul that can't be started here (attached only, refused) is listed, marked, and can't be chosen.
 *
 * Choosing is the host's: `choose(soul, query)` (the dialog reopens on that soul, its Task focused). Escape in an
 * open list with a soul chosen closes the list and stays in the form; with no soul yet it is the sheet's own Escape. */
import { quickOpenRows } from './quick-open.mjs';
import { createSoulMark } from './identity-marks.mjs';

export const soulFieldCSS = `
.spawn-soul-box { display:flex; flex-direction:column; gap:6px; min-width:0; }
.spawn-soul-current { width:100%; min-height:44px; display:flex; align-items:center; gap:10px; padding:6px 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--fg); font:inherit; text-align:left; cursor:pointer; }
.spawn-soul-current:focus-visible { outline:none; border-color:var(--accent); }
.spawn-soul-current::after { content:''; flex:none; width:6px; height:6px; margin:-3px 4px 0 auto; border-right:1.5px solid var(--muted); border-bottom:1.5px solid var(--muted); transform:rotate(45deg); }
.spawn-soul-current .identity-mark, .spawn-soul-option .identity-mark { flex:none; width:26px; height:26px; border-radius:7px; font-size:11px; }
.spawn-soul-copy { min-width:0; flex:1; display:flex; flex-direction:column; gap:1px; }
.spawn-soul-copy strong { font-size:13px; font-weight:650; overflow-wrap:anywhere; }
.spawn-soul-copy small { font-size:11.5px; line-height:1.45; color:var(--muted); overflow-wrap:anywhere; }
.spawn-soul-search { height:36px; }
.spawn-soul-list { max-height:248px; overflow:auto; display:flex; flex-direction:column; gap:2px; padding:4px; border:1px solid var(--border); border-radius:8px; background:var(--surface); }
.spawn-soul-option { display:flex; align-items:center; gap:10px; min-height:40px; padding:5px 8px; border-radius:6px; color:var(--fg); cursor:pointer; }
.spawn-soul-option[aria-selected=true] { background:var(--sel); box-shadow:inset 0 0 0 1px var(--accent); }
.spawn-soul-option[aria-disabled=true] { color:var(--muted); cursor:default; }
.spawn-soul-option[aria-disabled=true] .spawn-soul-copy strong { font-weight:500; }
.spawn-soul-empty { margin:0; padding:6px 8px; color:var(--muted); font-size:12px; }
.spawn-soul-empty:empty { display:none; }
`;

const same = (a, b) => !!a && !!b && a.name === b.name && (a.agentsRoot || '') === (b.agentsRoot || '') && (a.server || '') === (b.server || '');
/** What the list says under a soul's name: why it can't be chosen, else its description, else where it comes from. */
const soulLine = (soul, choosable) => soul.work === 'attached' ? 'Attached only: started by the agent it attaches to'
  : !choosable && soul.problem ? String(soul.problem) : soul.description || soul.repoName || '';

/**
 * @param doc
 * @param opts  agents (the catalog rows), soul (the chosen one, or null), canChoose(soul), choose(soul, query),
 *              query (the filter to start with), keyHint (an element shown beside the label, or null)
 */
export function createSoulField(doc, { agents = [], soul = null, canChoose = () => true, choose, query = '', keyHint = null }) {
  const el = (tag, text, cls) => { const node = doc.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
  const field = el('div', undefined, 'spawn-field spawn-soul');
  const label = el('label', 'Soul', 'spawn-label'); label.id = 'spawn-soul-label'; label.htmlFor = 'spawn-soul-search';
  if (keyHint) label.append(keyHint);
  const box = el('div', undefined, 'spawn-soul-box');
  field.append(label, box);
  // The chosen soul, as a button that opens the list.
  const current = el('button', undefined, 'spawn-soul-current'); current.type = 'button';
  current.setAttribute('aria-haspopup', 'listbox'); current.setAttribute('aria-expanded', 'false');
  if (soul) {
    const copy = el('span', undefined, 'spawn-soul-copy');
    copy.append(el('strong', soul.name), el('small', soul.description || soul.repoName || ''));
    const mark = createSoulMark(doc, soul); mark.setAttribute('aria-hidden', 'true');
    current.append(mark, copy);
    current.setAttribute('aria-label', `Soul: ${soul.name}. Change the soul`);
  }
  // The combobox and its list.
  const search = el('input', undefined, 'field spawn-soul-search'); search.id = 'spawn-soul-search';
  search.type = 'text'; search.autocomplete = 'off'; search.spellcheck = false; search.value = query;
  search.placeholder = 'Type to filter souls · ↑↓ · Enter';
  search.setAttribute('role', 'combobox'); search.setAttribute('aria-autocomplete', 'list');
  search.setAttribute('aria-controls', 'spawn-soul-list'); search.setAttribute('aria-expanded', 'true');
  const list = el('div', undefined, 'spawn-soul-list'); list.id = 'spawn-soul-list';
  list.setAttribute('role', 'listbox'); list.setAttribute('aria-labelledby', label.id);
  const empty = el('p', '', 'spawn-soul-empty'); empty.setAttribute('role', 'status');
  box.append(current, search, list, empty);

  let rows = [], active = -1, opened = false;
  const choosable = i => !!rows[i] && rows[i].choosable;
  function setActive(i) {
    active = i;
    rows.forEach((row, at) => row.option.setAttribute('aria-selected', String(at === i)));
    if (rows[i]) { search.setAttribute('aria-activedescendant', rows[i].option.id); rows[i].option.scrollIntoView?.({ block: 'nearest' }); }
    else search.removeAttribute('aria-activedescendant');
  }
  function filter() {
    const matched = quickOpenRows(agents, search.value, { limit: Infinity, onPick: () => {} });
    list.replaceChildren();
    rows = matched.map((match, at) => {
      const candidate = match.soul, ok = canChoose(candidate);
      const option = el('div', undefined, 'spawn-soul-option'); option.id = `spawn-soul-option-${at}`;
      option.setAttribute('role', 'option'); option.setAttribute('aria-disabled', String(!ok));
      option.dataset.agent = candidate.name; option.dataset.root = candidate.agentsRoot || ''; option.dataset.server = candidate.server || '';
      const copy = el('span', undefined, 'spawn-soul-copy');
      copy.append(el('strong', candidate.name), el('small', soulLine(candidate, ok)));
      const mark = createSoulMark(doc, candidate); mark.setAttribute('aria-hidden', 'true');
      option.append(mark, copy);
      // A press on an option never takes focus from the text field (the combobox keeps it).
      option.addEventListener('mousedown', event => event.preventDefault());
      option.addEventListener('click', () => { if (ok) pick(candidate); });
      list.append(option);
      return { option, soul: candidate, choosable: ok };
    });
    empty.textContent = rows.length ? '' : agents.length ? 'No soul matches.' : 'No souls to start in this workspace.';
    // The chosen soul is the first active option while nothing is typed; else the best match that can be chosen.
    const chosenAt = !search.value.trim() && soul ? rows.findIndex(row => same(row.soul, soul) && row.choosable) : -1;
    setActive(chosenAt >= 0 ? chosenAt : rows.findIndex(row => row.choosable));
  }
  function pick(candidate) { choose?.(candidate, search.value); }
  /** Show the list (focus in its text field). */
  function open({ text = '' } = {}) {
    opened = true; current.hidden = true; search.hidden = list.hidden = empty.hidden = false;
    current.setAttribute('aria-expanded', 'true');
    if (text) search.value = text;
    filter(); search.focus();
    if (text) { const end = search.value.length; try { search.setSelectionRange(end, end); } catch { /* not a text field here */ } }
  }
  /** Back to the chosen soul (only with one). */
  function close({ focus = true } = {}) {
    if (!soul) return;
    opened = false; current.hidden = false; search.hidden = list.hidden = empty.hidden = true;
    current.setAttribute('aria-expanded', 'false'); search.value = '';
    if (focus) current.focus();
  }
  current.addEventListener('click', () => open());
  current.addEventListener('keydown', event => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); open(); return; }
    // Typing on the chosen soul starts a filter: the character goes to the list's text field.
    if (event.key.length === 1 && event.key !== ' ') { event.preventDefault(); event.stopPropagation(); open({ text: event.key }); }
  });
  search.addEventListener('input', filter);
  search.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey) return;
    const move = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (move) {
      event.preventDefault(); event.stopPropagation();
      if (!rows.length) return;
      // Wraps at the ends; a soul that can't be chosen is passed over.
      for (let step = 0, next = active; step < rows.length; step++) {
        next = next < 0 ? (move > 0 ? 0 : rows.length - 1) : (next + move + rows.length) % rows.length;
        if (choosable(next)) { setActive(next); return; }
      }
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.repeat) {
      event.preventDefault(); event.stopPropagation();
      if (choosable(active)) pick(rows[active].soul);
      return;
    }
    if (event.key === 'Escape' && soul) { event.preventDefault(); event.stopPropagation(); close(); }
  });
  // Focus leaving the field closes an opened list back to the chosen soul (never with no soul: it is the sheet's first step).
  field.addEventListener('focusout', event => { if (opened && soul && !field.contains(event.relatedTarget)) close({ focus: false }); });
  if (soul) close({ focus: false }); else { opened = true; current.hidden = true; filter(); }
  return {
    element: field, search, current,
    /** The control a jump or the sheet's first focus lands on. */
    focus() { if (opened) search.focus(); else current.focus(); },
    open, close, isOpen: () => opened,
  };
}
