/** The Desktop's "i": a 28px round icon button that opens an explanation in a modal dialog.
 * Workspace › Capabilities ("About capabilities") is its caller (Workspace › Souls dropped its "About souls" in the
 * Desktop UI rework, slice 3a: the page's first line says what a soul is); it builds its button once and keeps it
 * across repaints (like the search field beside it).
 *
 * The dialog is the Stop/Retire/Forget frame (lifecycle-dialog.mjs lifecycleCSS: `palette-overlay
 * lifecycle-overlay` > `section.lifecycle-dialog`), widened by `.about-dialog`, with one Close button.
 * Opening focuses Close; Tab and Shift+Tab stay on it; Escape and Close close it and focus goes back to the
 * opener (the "i"). No scrim click closes it, as the lifecycle and Forget dialogs. It joins the shared
 * overlay handoff as forget-dialog.mjs does (takePickerFocusReturn / joinPickerFocusReturn): another modal
 * opening over it dismisses it and inherits its opener; any other `aria-modal` taking focus closes it.
 * `close({ focus: 'none' })` is for the caller leaving its tab or the workspace: it moves no focus.
 *
 * All the dialogs' words live in ABOUT_COPY, one frozen object, so the copy changes in one place. */
import { iconElement } from './shell-icons.mjs';
import { takePickerFocusReturn, joinPickerFocusReturn } from './overlay-picker.mjs';

export const aboutCSS = `
.oats-view button.ws-info-button { display:inline-grid; place-items:center; flex:none; width:28px; height:28px; min-height:0; margin:0; padding:0; border:1px solid var(--border); border-radius:50%; background:var(--surface); color:var(--muted); cursor:pointer; }
.oats-view button.ws-info-button:hover { color:var(--fg); }
.oats-view button.ws-info-button:focus-visible { background:var(--sel); }
/* The lifecycle dialog's frame, wider, at 13px; the mark is the accent's "i". */
.lifecycle-dialog.about-dialog { width:min(520px, calc(100vw - 32px)); font-size:13px; }
.about-dialog h2, .about-dialog > p { color:var(--fg); }
.about-dialog .lifecycle-mark { color:var(--accent); }
.about-dialog code { font-weight:normal; font-size:12px; line-height:normal; font-family:var(--mono,monospace); }
.lifecycle-dialog.about-dialog dl.about-terms { grid-template-columns:max-content minmax(0,1fr); gap:10px 14px; align-items:baseline; margin:0; padding:12px 14px; border:1px solid var(--border); border-radius:8px; background:var(--surface-2); }
.lifecycle-dialog.about-dialog .about-terms dt { display:flex; align-items:center; align-self:start; gap:7px; color:var(--fg); font-weight:650; white-space:nowrap; line-height:1.5; }
.about-dialog .about-terms dt .shell-icon { flex:none; color:var(--muted); }
.about-dialog .about-terms dd { margin:0; color:var(--muted); line-height:1.5; }
.about-dialog strong { font-weight:650; }
@media (max-width:560px) {
 .lifecycle-dialog.about-dialog dl.about-terms { grid-template-columns:minmax(0,1fr); gap:2px; }
 .about-dialog .about-terms dd { margin-bottom:8px; }
}
`;

/** A body is a list of blocks: `{ p: [...parts] }` a paragraph, `{ terms: [[icon, term, definition], ...] }`
 * the boxed term list. A part is a string, `{ code }` or `{ strong }`. */
export const ABOUT_COPY = Object.freeze({
  close: 'Close',
  capabilities: Object.freeze({
    button: 'About capabilities',
    title: 'What capabilities are',
    body: Object.freeze([
      { p: ['A capability is a reusable bundle of skills, commands and instructions, given to every soul whose work needs it.'] },
      // The composed AGENTS.md (product owner, 2026-10-23: injects go into the composed instance AGENTS.md).
      { p: ['A soul names the capabilities it needs. When an instance starts, it gets a copy of each one, and the capability’s instructions are injected into the instance’s composed ', { code: 'AGENTS.md' }, ', after the soul’s own.'] },
      { p: ['Each capability comes from one of three places:'] },
      { terms: [
        ['repo', 'Workspace owned', 'Defined in one of the workspace’s repos. Any soul can use it, always at that repo’s latest version.'],
        ['home', 'Repo owned', 'Defined in one repo and kept to it. Only souls from that same repo can use it.'],
        ['package', 'Packages', 'Installed into the workspace at a pinned version, the same on every machine.'],
      ] },
      // Checked against design-brief §5 and the kernel's one-per-slot rule (design owner, 2026-10-23).
      { p: ['Three capabilities are core: knowledge (what an instance knows and learns), messaging (who it can talk to) and tasks (where its work is tracked). A soul has at most one of each. Every other capability is additional: a soul can have any number.'] },
      { p: [{ strong: 'Workspace defaults' }, ' are capabilities the workspace gives to every soul. They are how an organisation gives its agents one shared way of working: the same tools for knowledge, messaging and tasks. Knowledge matters most: with a knowledge capability, what agents learn and the procedures the organisation writes down are kept and reach later instances, instead of ending with each session. A soul gets the defaults without asking. It can turn a default off and name its own in its place, or leave a core capability (knowledge, messaging or tasks) empty.'] },
    ]),
  }),
});

function node(doc, tag, value, cls) {
  const el = doc.createElement(tag);
  if (value !== undefined && value !== null) el.textContent = value;
  if (cls) el.className = cls;
  return el;
}
const part = (doc, value) => typeof value === 'string' ? value : value.code ? node(doc, 'code', value.code) : node(doc, 'strong', value.strong);
/** A body's blocks as DOM (text nodes only, never HTML). */
export function aboutBody(doc, blocks) {
  return blocks.map(block => {
    if (block.terms) {
      const dl = node(doc, 'dl', null, 'about-terms');
      for (const [icon, term, definition] of block.terms) {
        const dt = node(doc, 'dt'); dt.append(iconElement(doc, icon, { size: 14 }), node(doc, 'span', term));
        dl.append(dt, node(doc, 'dd', definition));
      }
      return dl;
    }
    const p = node(doc, 'p'); p.append(...block.p.map(value => part(doc, value))); return p;
  });
}

let dialogs = 0;
/** The "i" and the dialog it opens, for one of ABOUT_COPY's entries (`copy`). `id`: the button's id (the
 * opener a replacement dialog's focus return resolves); `onIntent`: a newer user intent; `applyFocus(fn)`:
 * how the host moves focus. Returns `{ button, open, close, isOpen, dispose }`. */
export function createAboutDialog(doc, { copy, id, onIntent = () => {}, applyFocus = fn => fn() }) {
  let alive = true, overlay = null, restore = null, handoff = null, yieldTo = null;
  const button = node(doc, 'button', null, 'ws-info-button'); button.type = 'button'; button.id = id;
  button.setAttribute('aria-label', copy.button); button.title = copy.button; button.setAttribute('aria-haspopup', 'dialog');
  button.append(iconElement(doc, 'info', { size: 15 }));
  button.addEventListener('click', () => open());

  function close({ focus = 'opener' } = {}) {
    if (yieldTo) { doc.removeEventListener('focusin', yieldTo, true); yieldTo = null; }
    handoff?.(); handoff = null;
    if (!overlay) return;
    overlay.remove(); overlay = null;
    const back = restore; restore = null;
    if (focus === 'none') return;
    applyFocus(() => { if (!back?.restore()) button.focus(); });
  }
  function open() {
    if (!alive) return false;
    close({ focus: 'none' });
    onIntent(); restore = takePickerFocusReturn(doc);
    const key = `about-${++dialogs}`;
    const mine = overlay = node(doc, 'div', null, 'palette-overlay lifecycle-overlay');
    const dialog = node(doc, 'section', null, 'lifecycle-dialog about-dialog'); dialog.dataset.operation = 'about';
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', `${key}-title`);
    const heading = node(doc, 'div', null, 'lifecycle-heading'), mark = node(doc, 'span', null, 'lifecycle-mark');
    mark.setAttribute('aria-hidden', 'true'); mark.append(iconElement(doc, 'info', { size: 18 }));
    const titles = node(doc, 'div', null, 'lifecycle-titles'), h2 = node(doc, 'h2', copy.title); h2.id = `${key}-title`;
    titles.append(h2); heading.append(mark, titles);
    const footer = node(doc, 'div', null, 'lifecycle-footer');
    const done = node(doc, 'button', ABOUT_COPY.close, 'lifecycle-close'); done.type = 'button';
    done.addEventListener('click', () => { if (overlay === mine) close(); });
    footer.append(done);
    dialog.append(heading, ...aboutBody(doc, copy.body), footer); mine.append(dialog); doc.body.append(mine);
    mine.addEventListener('keydown', event => {
      if (overlay !== mine) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key === 'Tab') { event.preventDefault(); done.focus(); } // one control: Tab and Shift+Tab stay on it
    });
    // Another modal closes this one: through the handoff before it captures its opener, else when it takes focus.
    handoff = joinPickerFocusReturn(doc, { opener: restore, dismiss: () => { if (overlay === mine) close({ focus: 'none' }); } });
    yieldTo = event => {
      if (overlay !== mine || dialog.contains(event.target)) return;
      if (event.target?.closest?.('[aria-modal="true"]')) close({ focus: 'none' });
    };
    doc.addEventListener('focusin', yieldTo, true);
    applyFocus(() => done.focus());
    return true;
  }
  return { button, open, close, isOpen: () => !!overlay, dispose() { close({ focus: 'none' }); alive = false; } };
}
