/* oats desktop — the leader (docs/desktop-keyboard.md, "The leader").

   The leader chord (app.leader: Ctrl+X on every platform, rebindable) opens a
   wait; the next keydown that is not a lone modifier settles it. A key of the shared table
   (packages/client/keymap.mjs LEADER_TABLE) runs what it does, once; any other key cancels.
   Either way that key is consumed whole: its keydown, its keypress and its keyup (and its
   repeats while held) reach neither xterm nor the focused control. There is no time limit.

   The leader pressed again (the effective app.leader chord) closes the wait. In a terminal that
   second press is not claimed (keybindings.mjs `letThrough`): xterm sends exactly what it sends
   for the chord (Ctrl+X 0x18), so the program still has the key. In a text field on Linux/Windows
   (keybindings.mjs leaderLeftToField) it closes the wait and stays the field's Cut, as Ctrl+X there
   never opens it. Elsewhere it only closes the wait.

   A click, a paste, the window losing focus, a modal opening or the focused element leaving the
   document cancels the wait, with nothing run. A modal already shown when a key arrives cancels it
   too, and that key goes where it would have gone.

   The follow-up is read by `KeyboardEvent.key`, whatever Shift or AltGr produced it (Shift+x is
   `X`, Shift+\ is `|`). A named key that Shift moves, Tab or an arrow, Home, End, PgUp or PgDn, is
   spelled with `shift+` held, as the TUI spells it (Shift+Tab is `shift+tab`, the previous
   group; Shift+↑ is no row). A key held with Ctrl, ⌘ or Alt (AltGr aside) is not in the table, as in
   the TUI, which reads it as ctrl+/alt+ something.

   The engine listens on the window in the capture phase, before xterm's textarea and every
   focused control's own handlers. What a key does, what the hint says and who the target is
   belong to the shell (leader-keys.mjs, shell.mjs); this module only decides when the wait
   settles, on which `does`, and which events it eats. */

import { leaderDoes } from "../../client/keymap.mjs";
import { eventMatchesBinding, leaderLeftToField, letThrough } from "./keybindings.mjs";

const NAMED = Object.freeze({
  __proto__: null,
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  Escape: "escape", Esc: "escape", " ": "space", Spacebar: "space", Tab: "tab", Enter: "enter",
  Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown",
});
/** The named keys a held Shift is part of (`shift+tab`); Space, Enter and Esc read the same with it. */
const SHIFTED_NAMES = new Set(["tab", "up", "down", "left", "right", "home", "end", "pageup", "pagedown"]);
const MODIFIERS = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "OS", "Super", "Hyper",
  "CapsLock", "NumLock", "ScrollLock", "Fn", "FnLock", "Symbol", "SymbolLock"]);

/** A keydown of a modifier alone: it settles nothing. */
export function isLoneModifier(e) {
  return MODIFIERS.has(String(e?.key ?? ""));
}

/** The key id (the shared keymap's spelling) a follow-up keydown names, or null when it cannot be
 * in the table: held with Ctrl, ⌘ or Alt (AltGr aside), composing, or a key with no single
 * character and no name the table uses. */
export function followUpKey(e) {
  const altGraph = typeof e.getModifierState === "function" && e.getModifierState("AltGraph");
  if (!altGraph && (e.ctrlKey || e.metaKey || e.altKey)) return null;
  if (e.isComposing) return null;
  const key = String(e.key ?? "");
  if (NAMED[key]) return e.shiftKey && SHIFTED_NAMES.has(NAMED[key]) ? `shift+${NAMED[key]}` : NAMED[key];
  return [...key].length === 1 ? key : null;
}

/** The event's physical key, for following its keypress and keyup (the key itself when the event
 * carries no code: a synthetic event). */
const physical = (e) => e.code || String(e.key ?? "").toLowerCase();

/**
 * @param {object} o
 * @param {Window} o.win
 * @param {boolean} [o.isMac]
 * @param {() => boolean} o.modalOpen       a modal dialog or the palette is shown (aria-modal)
 * @param {(does: string) => boolean} [o.supports]   whether the Desktop runs this `does` now
 * @param {(origin: object) => void} [o.onOpen]      the wait began (the shell announces it)
 * @param {(does: string, origin: object) => void} [o.onSettle]   a table key settled it
 * @param {(why: string) => void} [o.onClose]        the wait ended: "settled", "again", "key",
 *                                                  "pointer", "paste", "blur", "modal", "focus"
 */
export function createLeader({ win, isMac, modalOpen = () => false, supports = () => true,
  onOpen = () => {}, onSettle = () => {}, onClose = () => {} }) {
  const doc = win.document;
  let waiting = null;    // { origin, focused }
  // The physical keys of consumed follow-ups, each until its own keyup (or the window losing focus,
  // which loses keyups): another key going down meanwhile (rollover, a modifier) releases none of them.
  const swallowed = new Set();
  let pressEaten = false; // the last keydown was consumed: its keypress is too
  let observer = null;

  const eat = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };

  function close(why) {
    if (!waiting) return;
    waiting = null;
    observer?.disconnect(); observer = null;
    try { onClose(why); } catch { /* the hint must not break the keyboard */ }
  }

  function watch() {
    const Observer = win.MutationObserver;
    if (typeof Observer !== "function") return;
    observer = new Observer(() => {
      if (!waiting) return;
      if (modalOpen()) close("modal");
      else if (waiting.focused && !waiting.focused.isConnected) close("focus");
    });
    observer.observe(doc.documentElement, { subtree: true, childList: true, attributes: true,
      attributeFilter: ["hidden", "open", "aria-modal", "class", "style", "inert"] });
  }

  /** Begin the wait. `origin`, the caller's, is handed back to onSettle (the shell passes none: it
   * reads its target at the key); the focused element is noted here. Returns false, and does
   * nothing, under a modal. */
  function start(origin = {}) {
    if (modalOpen()) return false;
    if (waiting) close("again");
    waiting = { origin, focused: doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null };
    watch();
    try { onOpen(origin); } catch { /* as above */ }
    return true;
  }

  function onKeyDown(e) {
    pressEaten = false;
    if (swallowed.has(physical(e))) {
      if (e.repeat) { eat(e); pressEaten = true; return; }
      swallowed.delete(physical(e)); // pressed anew: its keyup was lost
    }
    if (!waiting || isLoneModifier(e)) return;
    if (modalOpen()) { close("modal"); return; }
    if (eventMatchesBinding(e, "app.leader", isMac)) {
      const inTerminal = !!e.target?.closest?.(".xterm");
      close("again");
      if (inTerminal || leaderLeftToField(e, isMac)) letThrough(e);
      else eat(e);
      return;
    }
    const key = followUpKey(e);
    const does = key === null ? null : leaderDoes(key);
    const { origin } = waiting;
    eat(e);
    pressEaten = true;
    swallowed.add(physical(e));
    const runs = does !== null && supports(does);
    close(runs ? "settled" : "key");
    if (runs) onSettle(does, origin);
  }

  function onKeyPress(e) {
    if (pressEaten) eat(e);
  }

  function onKeyUp(e) {
    if (!swallowed.delete(physical(e))) return;
    eat(e);
  }

  const onPointerDown = () => { if (waiting) close("pointer"); };
  const onPaste = () => close("paste");
  const onBlur = (e) => { if (e.target === win) { swallowed.clear(); pressEaten = false; close("blur"); } };

  win.addEventListener("keydown", onKeyDown, true);
  win.addEventListener("keypress", onKeyPress, true);
  win.addEventListener("keyup", onKeyUp, true);
  win.addEventListener("pointerdown", onPointerDown, true);
  win.addEventListener("mousedown", onPointerDown, true);
  win.addEventListener("paste", onPaste, true);
  win.addEventListener("blur", onBlur);

  return {
    start,
    cancel: () => close("cancel"),
    isWaiting: () => !!waiting,
    origin: () => waiting?.origin ?? null,
    dispose() {
      close("cancel");
      win.removeEventListener("keydown", onKeyDown, true);
      win.removeEventListener("keypress", onKeyPress, true);
      win.removeEventListener("keyup", onKeyUp, true);
      win.removeEventListener("pointerdown", onPointerDown, true);
      win.removeEventListener("mousedown", onPointerDown, true);
      win.removeEventListener("paste", onPaste, true);
      win.removeEventListener("blur", onBlur);
    },
  };
}
