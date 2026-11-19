/** One capability as a row (the Desktop UI rework): its name, then where it comes from ("by <source>", or the
 * verified mark once a rule establishes "official"), a dim "core" tag on a core capability and "default" on a
 * workspace default, and one line of what it does. The same row wherever a capability is listed: a soul's page
 * (slice 3a) and the Capabilities page (slice 3b). A row that opens something is a button; Enter and a click open
 * it. Up/Down, Home and End move between the rows of one list (`roveCapabilityLines`), one tab stop for the list.
 *
 * Every word on the row is the kernel's (the name, the source, the manifest's description), shown as text. */
import { iconElement } from './shell-icons.mjs';

export const CAPABILITY_LINE_COPY = Object.freeze({
  core: 'core',
  isDefault: 'default',
  by: source => `by ${source}`,
  verified: 'Verified: published by OATS',
  open: 'open its page',
});

export const capabilityLineCSS = `
.cap-lines { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; min-width:0; border-top:1px solid var(--border); }
.cap-lines > li { min-width:0; border-bottom:1px solid var(--border); }
.cap-line { display:flex; flex-direction:column; gap:2px; width:100%; min-width:0; box-sizing:border-box; padding:8px 10px; text-align:left; color:var(--fg); font:inherit; }
.oats-view button.cap-line { height:auto; min-height:0; margin:0; border:0; border-radius:6px; background:none; font-weight:400; line-height:normal; cursor:pointer; }
.oats-view button.cap-line:hover { background:var(--surface); }
.oats-view button.cap-line:focus-visible { background:var(--sel); }
.cap-line-head { display:flex; align-items:baseline; flex-wrap:wrap; gap:2px 8px; min-width:0; }
.cap-line-name { color:var(--fg); font-size:13px; font-weight:600; overflow-wrap:anywhere; }
.cap-line-by { color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
.cap-line-tag { color:var(--muted); font-size:11px; font-weight:600; letter-spacing:.02em; }
.cap-line-verified { color:var(--accent); font-size:12px; }
.cap-line-desc { color:var(--muted); font-size:12.5px; line-height:1.45; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
`;

/**
 * @param {Document} doc
 * @param {object} o
 * @param {string} o.name           the capability's name, as shown
 * @param {string|null} [o.by]      where it comes from (a repository or a package), shown as "by <source>"; null: nothing
 * @param {string|null} [o.description]  one line of what it does (the manifest's); null: no second line
 * @param {boolean} [o.core]        a core capability (knowledge, messaging, tasks): the dim "core" tag
 * @param {boolean} [o.isDefault]   a workspace default: the "default" tag
 * @param {boolean} [o.verified]    published by OATS (the official rule's): the mark instead of "by <source>"
 * @param {string|null} [o.title]   the row's tooltip (what the tags stand for)
 * @param {string|null} [o.focusKey]  a stable key, so a repaint finds the row again (loading.mjs captureFocusState)
 * @param {() => void} [o.onOpen]   opens the capability; absent, the row is plain text
 * @returns {HTMLElement} a <button> (opens) or a <div>, carrying data-capability = name
 */
export function capabilityLine(doc, { name, by = null, description = null, core = false, isDefault = false, verified = false, title = null, focusKey = null, onOpen = null }) {
  const node = (tag, text, cls) => { const el = doc.createElement(tag); if (text !== undefined && text !== null) el.textContent = text; if (cls) el.className = cls; return el; };
  const opens = typeof onOpen === 'function';
  const row = node(opens ? 'button' : 'div', undefined, 'cap-line');
  row.dataset.capability = name;
  const head = node('span', undefined, 'cap-line-head');
  head.append(node('span', name, 'cap-line-name'));
  if (verified) {
    const mark = node('span', undefined, 'cap-line-verified'); mark.title = CAPABILITY_LINE_COPY.verified;
    mark.setAttribute('role', 'img'); mark.setAttribute('aria-label', CAPABILITY_LINE_COPY.verified);
    mark.append(iconElement(doc, 'check', { size: 12 })); head.append(mark);
  }
  else if (typeof by === 'string' && by) head.append(node('span', CAPABILITY_LINE_COPY.by(by), 'cap-line-by'));
  if (core) head.append(node('span', CAPABILITY_LINE_COPY.core, 'cap-line-tag'));
  if (isDefault) head.append(node('span', CAPABILITY_LINE_COPY.isDefault, 'cap-line-tag'));
  row.append(head);
  if (typeof description === 'string' && description) { const line = node('span', description, 'cap-line-desc'); line.title = description; row.append(line); }
  if (title) row.title = title;
  if (focusKey) row.dataset.focusKey = focusKey;
  if (opens) {
    row.type = 'button';
    row.addEventListener('click', () => onOpen());
  }
  return row;
}

/** A list of rows (`<ul class="cap-lines">`, one `<li>` each) with one tab stop: Up/Down, Home and End move between
 * the rows that open; Enter and Space are the buttons' own. `label` names the list for assistive technology. */
export function capabilityLines(doc, rows, { label }) {
  const list = doc.createElement('ul'); list.className = 'cap-lines'; list.setAttribute('aria-label', label);
  for (const row of rows) { const item = doc.createElement('li'); item.append(row); list.append(item); }
  roveCapabilityLines(list);
  return list;
}
function roveCapabilityLines(list) {
  const buttons = () => [...list.querySelectorAll('button.cap-line')];
  const elect = target => { for (const b of buttons()) b.tabIndex = b === target ? 0 : -1; };
  elect(buttons()[0]);
  list.addEventListener('focusin', event => { if (event.target.matches?.('button.cap-line')) elect(event.target); });
  list.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const all = buttons(), at = all.indexOf(event.target);
    if (at < 0) return;
    const next = event.key === 'ArrowDown' ? Math.min(all.length - 1, at + 1) : event.key === 'ArrowUp' ? Math.max(0, at - 1)
      : event.key === 'Home' ? 0 : event.key === 'End' ? all.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault(); elect(all[next]); all[next].focus();
  });
}
