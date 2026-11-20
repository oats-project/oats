/* oats desktop — the leader's hint (docs/desktop-keyboard.md, "The leader").

   A live region at the bottom of the main area. While the leader waits it shows nothing: the wait is
   announced once to a screen reader ("Leader: press a key, Esc for the instances list"), and the keys
   are listed in the shortcuts editor (the leader's `?`). After a key whose act cannot run, or a
   sidebar key's, it shows one quiet line saying why, announced as it shows (`role="status"`). It
   never takes focus and holds nothing focusable. Shown, its surface is opaque (--surface-2, a raised
   surface with --fg text, an inventoried pair). The region is always in the document, out of sight
   unless it shows a line, so assistive technology hears what is put into it.

   The shell decides when it closes: a line stays until the next keydown, click or focus change.

   The help sheet (the Desktop UI rework, slice 4; guide v6 D15, tour steps 45 and 46): while the leader waits, a
   small sheet at the bottom right lists the keys it takes now (the rows that apply where you are: leader-keys.mjs
   leaderApplies), and goes with the next key. The leader then `?` pins it, with the same keys, until Esc. A
   setting turns the waiting sheet off (`leaderHelpEnabled`, the Keyboard shortcuts sheet and the palette); the
   pinned one is always there on `?`. The waiting sheet is drawn for sight only (aria-hidden: the wait is announced,
   as before); the pinned one is a labelled region a screen reader can read. It never takes focus. */

const HELP_KEY = "oats.desktop.leaderHelp";
const helpListeners = new Set();
/** Whether the leader shows its help sheet while it waits: on unless turned off (stored per computer, as the theme). */
export function leaderHelpEnabled(storage = globalThis.localStorage) {
  try { return storage?.getItem(HELP_KEY) !== "off"; } catch { return true; }
}
/** Turn the waiting help sheet on or off. */
export function setLeaderHelpEnabled(on, storage = globalThis.localStorage) {
  try { storage?.setItem(HELP_KEY, on ? "on" : "off"); } catch { /* the choice holds for this window only */ }
  for (const fn of [...helpListeners]) { try { fn(!!on); } catch { /* one listener must not break others */ } }
}
export function onLeaderHelpChange(fn) { helpListeners.add(fn); return () => helpListeners.delete(fn); }

export const LEADER_ANNOUNCEMENT = "Leader: press a key, Esc for the instances list";

/** @param {{ doc: Document, host: Element, before?: Element | null }} o  host: the main area (#main);
 *  before: the child it goes in front of (Show instance panel stays the main area's last child). */
export function createLeaderHint({ doc, host, before = null }) {
  const el = doc.createElement("div");
  el.className = "leader-hint";
  el.id = "leader-hint";
  el.setAttribute("role", "status");
  host.insertBefore(el, before && before.parentNode === host ? before : null);
  let mode = null; // null | "wait" | "line"
  // The help sheet: its own element, beside the line (fixed at the window's bottom right, above the status line).
  const help = doc.createElement("aside");
  help.className = "leader-help";
  help.id = "leader-help";
  help.hidden = true;
  doc.body.append(help);
  let helpMode = null; // null | "wait" | "pinned"

  const clear = () => { el.replaceChildren(); };

  return {
    element: el,
    /** The leader waits: announced, for a screen reader only. Nothing is drawn. */
    announce() {
      clear();
      const said = doc.createElement("p");
      said.className = "sr-only";
      said.textContent = LEADER_ANNOUNCEMENT;
      el.append(said);
      el.dataset.mode = mode = "wait";
    },
    /** One line saying why nothing ran. */
    say(line) {
      clear();
      const p = doc.createElement("p");
      p.className = "leader-hint-line";
      p.textContent = String(line);
      el.append(p);
      el.dataset.mode = mode = "line";
    },
    hide() {
      if (!mode) return;
      clear();
      delete el.dataset.mode;
      mode = null;
    },
    mode: () => mode,
    /** Draw the help sheet: `title` ("After Ctrl+Space") and `rows` ([{ keys, label }]); `pinned` keeps it until Esc;
     * `note`, a last line (how to switch the leader when an input method takes it). */
    showHelp({ title, rows = [], pinned = false, note = "" }) {
      const head = doc.createElement("p"); head.className = "leader-help-title"; head.textContent = title;
      const list = doc.createElement("dl"); list.className = "leader-help-keys";
      for (const { keys, label } of rows) {
        const dt = doc.createElement("dt"), kbd = doc.createElement("kbd"); kbd.textContent = keys; dt.append(kbd);
        const dd = doc.createElement("dd"); dd.textContent = label;
        list.append(dt, dd);
      }
      const parts = [head, list];
      if (note) { const p = doc.createElement("p"); p.className = "leader-help-foot"; p.textContent = note; parts.push(p); }
      if (pinned) { const foot = doc.createElement("p"); foot.className = "leader-help-foot"; foot.textContent = "Esc closes this"; parts.push(foot); }
      help.replaceChildren(...parts);
      if (pinned) { help.removeAttribute("aria-hidden"); help.setAttribute("aria-label", title); }
      else { help.setAttribute("aria-hidden", "true"); help.removeAttribute("aria-label"); }
      help.dataset.mode = helpMode = pinned ? "pinned" : "wait";
      help.hidden = false;
    },
    hideHelp() {
      if (!helpMode) return;
      help.hidden = true; help.replaceChildren(); delete help.dataset.mode; helpMode = null;
    },
    /** null, "wait" (shown while the leader waits) or "pinned" (until Esc). */
    helpMode: () => helpMode,
    /** Close the pinned sheet on Esc, pressed anywhere in `win` (capture phase); that Esc goes nowhere else. Not while
     * `blocked()` (a modal is shown, or the leader waits: its Esc is the leader's). Answers the listener's removal. */
    closeOnEscape(win, blocked = () => false) {
      const onKeydown = e => {
        if (e.key !== "Escape" || helpMode !== "pinned" || blocked()) return;
        e.preventDefault(); e.stopImmediatePropagation();
        help.hidden = true; help.replaceChildren(); delete help.dataset.mode; helpMode = null;
      };
      win.addEventListener("keydown", onKeydown, true);
      return () => win.removeEventListener("keydown", onKeydown, true);
    },
    helpElement: help,
    /** Something is drawn: a line (the wait draws nothing). */
    isShown: () => mode === "line",
  };
}
