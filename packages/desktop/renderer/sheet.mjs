/* oats desktop — sheets (the Desktop UI rework, slice 4; D10: "palette, New agent, Retire, Workspaces: centred
   sheets over a dim pass (a 150 ms ease in the Desktop); Appearance and Keyboard open as sheets from the palette").

   A sheet is a modal dialog centred in the window over the scrim (--scrim, the dim pass), coming in with a
   150 ms ease; with reduced motion asked for (prefers-reduced-motion) it appears at once. Its focus is trapped
   (Tab and Shift+Tab wrap inside it) and goes back where it came from when it closes (the opener, through the
   picker family's handoff: overlay-picker.mjs takePickerFocusReturn). Esc and a click on the scrim close it.

   Two ways in:
   - `SHEET_BACKDROP` and `SHEET` are the classes an existing dialog adds to its overlay and its dialog element
     to take the sheet's placement and motion (the Retire dialog, the keyboard shortcuts editor): they keep their
     own focus handling, which already traps and returns.
   - `openSheet` builds a new one (Appearance), with `trapTab` as its Tab handling. */
import { takePickerFocusReturn } from "./overlay-picker.mjs";

export const SHEET_BACKDROP = "sheet-backdrop";
export const SHEET = "sheet";
/** The sheet's ease, in ms (D10). */
export const SHEET_EASE_MS = 150;

export const sheetCSS = `
.palette-overlay.${SHEET_BACKDROP} { display:flex; align-items:center; justify-content:center; padding:16px; box-sizing:border-box; animation:sheet-dim ${SHEET_EASE_MS}ms ease both; }
.${SHEET_BACKDROP} > .${SHEET} { animation:sheet-in ${SHEET_EASE_MS}ms ease both; max-height:calc(100vh - 32px); }
@keyframes sheet-dim { from { background:transparent; } to { background:var(--scrim); } }
@keyframes sheet-in { from { transform:translateY(6px) scale(.985); } to { transform:none; } }
@media (prefers-reduced-motion: reduce) {
  .palette-overlay.${SHEET_BACKDROP}, .${SHEET_BACKDROP} > .${SHEET} { animation:none; }
}
.sheet-panel { width:min(440px,calc(100vw - 32px)); box-sizing:border-box; display:flex; flex-direction:column; border:1px solid var(--border); border-radius:10px; background:var(--surface); color:var(--fg); box-shadow:var(--shadow-modal); overflow:hidden; }
/* Slice 3d: the prototype's sheet head: the title in 15px 600 on the sheet's own surface, no rule under it. */
.sheet-head { min-height:44px; flex:none; display:flex; align-items:center; gap:10px; padding:10px 12px 6px 18px; }
.sheet-head h2 { margin:0; font-size:15px; font-weight:600; line-height:20px; }
.sheet-close { flex:none; margin-left:auto; width:28px; height:28px; display:grid; place-items:center; border:0; border-radius:6px; background:var(--surface); color:var(--muted); cursor:pointer; font:inherit; font-size:16px; }
.sheet-close:hover { background:var(--surface-2); color:var(--fg); }
.sheet-close:focus-visible { background:var(--sel); color:var(--fg); }
.sheet-body { overflow-y:auto; min-height:0; padding:4px 18px 18px; display:grid; gap:16px; }
`;

/** The controls Tab walks in `container`, in document order: enabled, not hidden, not taken out of the order. */
export function tabbables(container) {
  const shown = el => { for (let n = el; n && n !== container.parentElement; n = n.parentElement) if (n.hidden) return false; return true; };
  return [...container.querySelectorAll("button, input, select, textarea, a[href], summary, [tabindex]")]
    .filter(el => !el.disabled && el.tabIndex >= 0 && shown(el));
}

/** Keep Tab and Shift+Tab inside `container` (a keydown handler's work): from the last control Tab goes to the
 * first, from the first Shift+Tab goes to the last, and from outside it either goes in. True when it moved focus. */
export function trapTab(container, event, doc = container.ownerDocument) {
  if (event.key !== "Tab") return false;
  const all = tabbables(container);
  if (!all.length) { event.preventDefault(); return true; }
  const first = all[0], last = all.at(-1), inside = container.contains(doc.activeElement);
  if (event.shiftKey && (doc.activeElement === first || !inside)) { event.preventDefault(); last.focus(); return true; }
  if (!event.shiftKey && (doc.activeElement === last || !inside)) { event.preventDefault(); first.focus(); return true; }
  return false;
}

let sheets = 0;
/**
 * Open a sheet titled `title`. `build(body, close)` fills its body; `onClose()` runs once when it closes (before
 * focus goes back). `className` is added to the panel. Answers `{ element, panel, close }`; `close({ restoreFocus })`.
 */
export function openSheet({ doc = document, title, className = "", build = () => {}, onClose = () => {}, closeLabel = `Close ${title}` }) {
  // An opener inside a dialog that stays open under the sheet (Connections, Retire): focus-return skips every
  // control under .palette-overlay (a picker's own), so that one is returned to directly.
  const stillOpen = el => !!el?.isConnected && !el.disabled && !!el.closest?.(".palette-overlay");
  const prior = doc.activeElement, held = stillOpen(prior) ? prior : null;
  const restore = takePickerFocusReturn(doc);
  const id = `sheet-${++sheets}`;
  const overlay = doc.createElement("div");
  overlay.className = `palette-overlay ${SHEET_BACKDROP}`;
  const panel = doc.createElement("section");
  panel.className = `sheet-panel ${SHEET}${className ? ` ${className}` : ""}`;
  panel.setAttribute("role", "dialog"); panel.setAttribute("aria-modal", "true"); panel.setAttribute("aria-labelledby", `${id}-title`);
  const head = doc.createElement("header"); head.className = "sheet-head";
  const h2 = doc.createElement("h2"); h2.id = `${id}-title`; h2.textContent = title;
  const x = doc.createElement("button"); x.type = "button"; x.className = "sheet-close"; x.setAttribute("aria-label", closeLabel); x.textContent = "×";
  head.append(h2, x);
  const body = doc.createElement("div"); body.className = "sheet-body";
  panel.append(head, body); overlay.append(panel);
  let open = true;
  let lastInside = null;
  function close({ restoreFocus = true } = {}) {
    if (!open) return;
    open = false; overlay.remove(); doc.removeEventListener("focusin", contain);
    try { onClose(); } catch (error) { console.error(error); }
    if (restoreFocus) { if (stillOpen(held)) held.focus(); else restore?.restore(); }
  }
  x.addEventListener("click", () => close());
  overlay.addEventListener("mousedown", event => { if (event.target === overlay) close(); });
  overlay.addEventListener("keydown", event => {
    if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); close(); return; }
    trapTab(panel, event, doc);
  });
  // Focus stays in the sheet: a background action that moves focus (Alt+F to the roster) is pulled back to where it
  // was inside. Another modal taking over (the palette, a dialog over this one) keeps its focus.
  function contain(event) {
    if (!open) return;
    if (overlay.contains(event.target)) { lastInside = event.target; return; }
    if (event.target?.closest?.('.palette-overlay, [aria-modal="true"]')) return;
    (lastInside?.isConnected && overlay.contains(lastInside) ? lastInside : tabbables(panel)[0])?.focus();
  }
  doc.addEventListener("focusin", contain);
  build(body, close);
  doc.body.append(overlay);
  (tabbables(body)[0] ?? x).focus();
  return { element: overlay, panel, close, isOpen: () => open };
}
