/* oats desktop — the status line (the Desktop UI rework, slice 4; guide v6 tour step 46, D15).

   One line at the bottom of the window. It always shows the three most useful keys for where the focus is
   (`keysFor`, the shell's answer for the focused region), and it takes one-line messages (`say`): what was just done
   (the onboarding confirmation), a remote terminal in front that drops or reconnects (terminal-tab.mjs onLink; the
   pane's strip keeps its countdown and Reconnect now), and, drawn over it, the leader's line saying why a key could not
   act (leader-hint.mjs, shell.css). A message is announced (`role="status"`) and stays until the next key, click or
   focus change, or `ms` at the latest. There is no update prompt in the Desktop today; one built later says it here.

   It asks nothing. Its y/n questions for Stop, Start and Restart were built and then taken out of this slice by the
   lead after five review rounds (2026-11-19): a line that takes every key while it waits decides when a keystroke
   stops an agent, and wants a design of its own. Stop, Start and Restart keep their dialogs.

   It never takes focus. Its surface is --surface-2 with --fg and --muted text, inventoried pairs. */

const MODIFIERS = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "OS", "Super", "Hyper", "CapsLock", "NumLock", "ScrollLock", "Fn", "FnLock"]);

export const statusLineCSS = `
.status-line { flex:none; display:flex; align-items:center; gap:14px; min-height:26px; box-sizing:border-box; padding:3px 12px; border-top:1px solid var(--border); background:var(--surface-2); color:var(--muted); font-size:11.5px; line-height:1.4; overflow:hidden; white-space:nowrap; }
.status-line[hidden] { display:none; }
.status-keys { display:flex; gap:14px; min-width:0; overflow:hidden; }
.status-keys[hidden] { display:none; }
.status-key { display:inline-flex; gap:5px; align-items:baseline; }
.status-key kbd { font:inherit; font-family:var(--mono); color:var(--fg); }
.status-message { min-width:0; overflow:hidden; text-overflow:ellipsis; color:var(--fg); }
.status-message[data-tone=error] { color:var(--danger); }
`;

/**
 * @param {object} o
 * @param {Document} o.doc
 * @param {Element} o.host  where the line goes
 * @param {Element|null} [o.before]  the child of `host` it goes in front of (else it is appended)
 * @param {() => Array<{ keys: string, label: string }>} [o.keysFor]  the keys for where the focus is now
 * @param {number} [o.max]  how many of them it shows: three (slice 4), or four where a page lists its own (the shell's,
 *   slice 3c: the Souls page's "↑↓ move · Enter open · v table · Esc Home")
 * @param {Window} [o.win]
 */
export function createStatusLine({ doc, host, before = null, keysFor = () => [], max = 3, win = doc.defaultView }) {
  const el = doc.createElement("footer");
  el.id = "status-line"; el.className = "status-line";
  el.setAttribute("aria-label", "Status");
  const keys = doc.createElement("div"); keys.className = "status-keys";
  // The live region: a message is announced as it is put here.
  const live = doc.createElement("div"); live.className = "status-live"; live.setAttribute("role", "status");
  el.append(keys, live);
  host.insertBefore(el, before && before.parentNode === host ? before : null);
  let message = null, timer = null, armed = false, alive = true;

  function paintKeys() {
    if (message) { keys.hidden = true; return; }
    keys.hidden = false;
    let list = [];
    try { list = (keysFor() || []).slice(0, max); } catch { list = []; }
    keys.replaceChildren(...list.map(({ keys: chord, label }) => {
      const span = doc.createElement("span"); span.className = "status-key";
      const kbd = doc.createElement("kbd"); kbd.textContent = chord;
      span.append(kbd, ` ${label}`);
      return span;
    }));
  }
  function clearMessage() {
    clearTimeout(timer); timer = null;
    if (!message) return;
    message = null;
    live.replaceChildren();
    paintKeys();
  }
  /** One line, announced; it stays until the next key, click or focus change (armed after this task, so the press
   * that caused it does not clear it), or `ms` at the latest (0: no time limit). */
  function say(text, { tone = null, ms = 8000 } = {}) {
    if (!alive) return;
    clearTimeout(timer);
    const p = doc.createElement("span"); p.className = "status-message"; p.textContent = String(text);
    if (tone) p.dataset.tone = tone;
    message = { text: String(text) };
    live.replaceChildren(p);
    paintKeys();
    armed = false;
    setTimeout(() => { armed = !!message; }, 0);
    if (ms > 0) { timer = setTimeout(clearMessage, ms); timer?.unref?.(); }
  }

  const onKeydown = event => { if (message && armed && !MODIFIERS.has(String(event.key))) clearMessage(); };
  // A click anywhere (the line holds no control), the window losing focus or a focus change ends a message too.
  const onPointer = () => { if (message && armed) clearMessage(); };
  const onBlur = () => { if (message && armed) clearMessage(); };
  const onFocus = () => { if (message && armed) clearMessage(); else if (!message) paintKeys(); };
  win.addEventListener("keydown", onKeydown, true);
  win.addEventListener("pointerdown", onPointer, true);
  win.addEventListener("blur", onBlur);
  // The keys follow the focus.
  doc.addEventListener("focusin", onFocus);
  paintKeys();

  return {
    element: el,
    say,
    /** Repaint the keys (the focus or the keymap changed). */
    refresh: paintKeys,
    /** What the line says now: the message, or null. */
    text: () => message?.text ?? null,
    hideMessage: clearMessage,
    dispose() {
      alive = false; clearTimeout(timer);
      win.removeEventListener("keydown", onKeydown, true); win.removeEventListener("pointerdown", onPointer, true); win.removeEventListener("blur", onBlur);
      doc.removeEventListener("focusin", onFocus); el.remove();
    },
  };
}
