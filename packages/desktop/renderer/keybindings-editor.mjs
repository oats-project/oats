// oats desktop — keyboard shortcuts editor (shell-owned dialog).
//
// Like the palette overlay: plain DOM, semantic tokens from theme.css /
// shell.css, keyboard-first, ARIA dialog. Lists every registered action
// grouped by context with its effective chord as keycaps; a search at the top
// filters rows by name, group or keys; click a chord to record a new one (Esc
// cancels, Backspace unbinds), conflicts warned inline via findConflict,
// per-row reset, reset-all. docs/desktop-keyboard.md has its keys.
//
// Its first section is Most useful (usefulRows): a read-only table of the keys most worth knowing,
// from the live keymap, hidden while a search shows the list. The list leads with the leader (the
// TUI's): a Leader group, the rebindable app.leader row and then one read-only row per key of the
// shared table the Desktop runs ("Ctrl+X then K or Space — Open the command palette"), with one quiet line saying
// the leader matches the TUI and the direct chords are Desktop extras; then the
// Sidebar keys; then the groups by context.
//
// What has no button teaches its keys here, on its own rows (no line of its own above them): the
// command palette, the Leader group's first row (the leader then K or Space) and a Global row (its
// chord in the family in use), and Connections (not in the settings cog's menu), the Global row
// "Settings: Connections…", named as the palette names it, unbound by default and rebindable there. The stage rows say where they land
// ("View: Workspace › Machines": NAV_TABS).
//
// On Linux/Windows its top holds the chord family (docs/desktop-keyboard.md, "The chord
// families"): a three-way choice, "Shortcut family, shared with oats tui", Alt (the default), Ctrl+Alt or Ctrl+Shift, which
// names the family in use. A change writes keys.json through main at once (renderer/chord-family.mjs)
// and the keymap switches at once; the TUI, which shares the file, takes it at its next start, as
// the line under the choice says, with the note main sends when keys.json was there and not taken.
// macOS has no family, and no choice.

import {
  listActions, getBinding, setBinding, resetBinding, resetAllBindings,
  onKeymapChange, findConflict, keymapConflicts, formatChord, chordFromEvent, chordToString,
  isPlainChord, defaultBinding, chordKeys, terminalAllows, terminalTaker, CHORDS_READ,
} from "./keybindings.mjs";
import { supportedLeaderRows, leaderLabel, keyIdCaps, rowKeysText } from "./leader-keys.mjs";
import { CHORD_FAMILIES, CHORD_FAMILY_LABELS, DEFAULT_CHORD_FAMILY } from "../../client/keymap.mjs";
import { takePickerFocusReturn } from "./overlay-picker.mjs";
import { revealInScrollport } from "./reveal-in-scrollport.mjs";
import { icon } from "./shell-icons.mjs";

const CONTEXT_LABELS = {
  leader: "Leader",
  sidebar: "Sidebar keys",
  global: "Global",
  tabs: "Tabs",
  roster: "Instance roster",
  "stage:hierarchy": "Machines",
  "stage:spawn": "Soul roster",
  // view-local contexts: never activated for window dispatch — the actions
  // dispatch inside their view surface but stay editor-visible here.
  "view:graph": "Graph",
  "view:spawn": "Soul roster",
  // a modal dialog's own keys: dispatched only by the open dialog (spawn-dialog-keys.mjs)
  "spawn-dialog-local": "Spawn dialog",
};

// A terminal lives in the tab layer, where the shell activates only the "tabs" context
// (shell.mjs, updateActiveContexts): global and tabs actions are the ones that can
// fire while a terminal has focus. Whether one does is the engine's terminalAllows.
const TERMINAL_LAYER_CONTEXTS = new Set(["global", "tabs"]);

/** The group an action is listed in: its context's, except the leader's own, which leads. */
const groupOf = (action) => (action.id === "app.leader" ? "leader" : action.context);

/** Group registered actions by context, stable order, for rendering. The Leader group (when
 * app.leader is registered) comes first, then the Sidebar keys. */
export function groupActions(actions = listActions()) {
  const order = ["leader", "sidebar", "global", "tabs", "roster", "stage:hierarchy", "view:graph", "stage:spawn", "view:spawn", "spawn-dialog-local"];
  const groups = new Map();
  for (const a of actions) {
    const g = groupOf(a);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(a);
  }
  const sorted = [...groups.entries()].sort((x, y) => {
    const xi = order.indexOf(x[0]); const yi = order.indexOf(y[0]);
    return (xi < 0 ? order.length : xi) - (yi < 0 ? order.length : yi);
  });
  for (const [, list] of sorted) list.sort((a, b) => a.label.localeCompare(b.label));
  return sorted.map(([context, list]) => ({
    context, label: CONTEXT_LABELS[context] || context, actions: list,
  }));
}

// Each modifier keycap and the words a search may use for it.
const KEY_WORDS = new Map([
  ["ctrl", ["ctrl", "control"]], ["⌃", ["⌃", "ctrl", "control"]],
  ["alt", ["alt", "option"]], ["⌥", ["⌥", "option", "opt", "alt"]],
  ["shift", ["shift"]], ["⇧", ["⇧", "shift"]],
  ["⌘", ["⌘", "cmd", "command"]],
]);

/** Does a row match the search? Case-insensitive, on the action's label, its group's
 * name, or the chord as shown: "shift+b", "ctrl shift b" and "ctrlshiftb" all find
 * Ctrl+Shift+B, and on macOS "cmd shift b" finds ⇧⌘B (each word starts one of the
 * chord's keys, in any order). An unbound row's chord reads "unbound". */
export function shortcutMatches({ label = "", group = "", chord = null, keys: shown = null }, query, isMac) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  if (label.toLowerCase().includes(q) || group.toLowerCase().includes(q)) return true;
  // `keys`: a row's keys as shown when they are not one chord (a leader row: the leader's, then its key's),
  // or several chords (each a list), of which one must match: the terminal's scroll row never mixes them.
  const listed = shown ?? (chord ? chordKeys(chord, isMac) : []);
  const chords = (Array.isArray(listed[0]) ? listed : [listed]).map(keys => keys.map(k => String(k).toLowerCase())).filter(keys => keys.length);
  if (!chords.length) return "unbound".includes(q);
  const compact = q.replace(/[\s+]+/g, "");
  const words = q.split(/[\s+]+/).filter(Boolean);
  return chords.some(keys => (!!compact && keys.join("").includes(compact))
    || (words.length > 0 && words.every(w => keys.some(k => (KEY_WORDS.get(k) || [k]).some(name => name.startsWith(w))))));
}

/** One clash of keymapConflicts, said: when only one side is the user's, the one that runs where
 * both apply (matchEvent: an override wins over a default), else both named, as before. */
const clashWords = (isMac) => ({ chord, actions: [a, b], own = [true, true] }) => {
  const key = formatChord(chord, isMac);
  if (own[0] === own[1]) return `${key} is both “${a.label}” and “${b.label}”`;
  const [yours, fixed] = own[0] ? [a, b] : [b, a];
  return `${key} runs “${yours.label}” (yours) where both apply; “${fixed.label}” has it by default`;
};

/** The chord family choice's words: its title, each family's option, and the line under it. */
export const CHORD_FAMILY_WORDS = Object.freeze({
  title: "Shortcut family, shared with oats tui",
  options: Object.freeze({
    alt: `${CHORD_FAMILY_LABELS.alt} (default)`,
    "ctrl+alt": `${CHORD_FAMILY_LABELS["ctrl+alt"]} (for programs that read Alt)`,
    "ctrl+shift": `${CHORD_FAMILY_LABELS["ctrl+shift"]} (foot, Alacritty)`,
  }),
  tui: "All three work here; pick the one your terminal passes to oats tui. oats tui uses it from its next start.",
  /** When main could not write keys.json: the family in use stays. */
  unwritten: (family) => `Could not write keys.json: the shortcuts stay ${CHORD_FAMILY_LABELS[family] ?? CHORD_FAMILY_LABELS[DEFAULT_CHORD_FAMILY]}. Fix or remove the file, then choose again.`,
});

// ── Most useful: the editor's first section, a read-only table of the keys most worth knowing ────
// One row per entry, named here, its keys read from the live keymap at every render: the platform,
// the chord family and the user's rebinds as they are. Each `does` is a row of the shared keymap
// (packages/client/keymap.mjs): its action is the CHORDS_READ one, and where that action has no chord
// (none in the active family, or unbound in the list below) the leader's key for the same `does`
// stands in ("Ctrl+X then ↑ / ↓": the workspace moves in the Ctrl+Alt and Ctrl+Shift families). A pair
// is one row, "A / B"; the tab keys one row, "first to last", while the nine follow one pattern. The
// help row is the leader's `?`. The scroll row is tmux's keys, no action's: scrollBackKeys has them.
// The roster's filter is gone, so no row teaches `sidebar.focusFilter`.
const USEFUL = Object.freeze([
  { name: "Command palette", does: ["palette"] },
  { name: "Quick open a soul to spawn", does: ["spawn"] },
  { name: "Previous / next tab", does: ["tab-previous", "tab-next"] },
  { name: "Go to tab 1–9", does: Array.from({ length: 9 }, (_, i) => `tab-${i + 1}`), range: true },
  { name: "Previous / next workspace", does: ["workspace-previous", "workspace-next"] },
  { name: "Split right / split down", does: ["split-right", "split-down"] },
  { name: "Previous / next split pane", does: ["group-previous", "group-next"] },
  { name: "Close tab", does: ["close-terminal"] },
  { name: "Focus mode", does: ["zoom"] },
  { name: "Scroll back in a terminal", scrollBack: true },
  { name: "The leader, then ? for everything", does: ["help"], leaderOnly: true },
].map((row) => Object.freeze({ ...row, does: Object.freeze(row.does ?? []) })));

/** The Most useful rows as the keymap binds them now: each `{ name, keys }`, `keys` a list of pieces,
 * `{ cap }` a keycap (a chord as one, "⌘K", "Ctrl+Alt+K") or `{ word }` ("then", "/", "to", "unbound"). */
export function usefulRows(isMac) {
  const leaderChord = getBinding("app.leader", isMac);
  const leaderRows = supportedLeaderRows();
  const chordOf = (does) => { const id = CHORDS_READ.find((each) => each.does === does)?.id; return id ? getBinding(id, isMac) : null; };
  const leaderKeys = (does) => leaderRows.find((row) => row.does === does)?.keys ?? null;
  const caps = (keyId) => keyIdCaps(keyId, isMac).join(isMac ? "" : "+");
  // One `does`: its chord, else the leader's key for it, else unbound.
  const part = (does, leaderOnly) => {
    const chord = leaderOnly ? null : chordOf(does);
    if (chord) return { chord };
    const keys = leaderKeys(does);
    return keys && leaderChord ? { leader: caps(keys[0]) } : { unbound: true };
  };
  return USEFUL.map(({ name, does, range, leaderOnly, scrollBack }) => {
    if (scrollBack) return { name, keys: scrollBackKeys(isMac).parts };
    const parts = does.map((each) => part(each, leaderOnly));
    const keys = [];
    const piece = (p) => {
      if (p.chord) keys.push({ cap: formatChord(p.chord, isMac) });
      else if (p.leader) keys.push({ cap: formatChord(leaderChord, isMac) }, { word: "then" }, { cap: p.leader });
      else keys.push({ word: "unbound" });
    };
    // The nine tab keys: "first to last" while each is the first's with its own digit.
    const first = parts[0].chord ? chordKeys(parts[0].chord, isMac) : null;
    const pattern = range && first && parts.every((p, i) => p.chord
      && chordKeys(p.chord, isMac).join(" ") === [...first.slice(0, -1), String(i + 1)].join(" "));
    if (pattern) { piece(parts[0]); keys.push({ word: "to" }); piece(parts.at(-1)); }
    else if (parts.length > 1 && parts.every((p) => p.leader)) {
      // A pair the leader reaches: the leader once, then its keys ("Ctrl+X then ↑ / ↓").
      keys.push({ cap: formatChord(leaderChord, isMac) }, { word: "then" });
      parts.forEach((p, i) => { if (i) keys.push({ word: "/" }); keys.push({ cap: p.leader }); });
    } else parts.forEach((p, i) => { if (i) keys.push({ word: "/" }); piece(p); });
    return { name, keys };
  });
}

// ── Scroll back in a terminal (#1502): Most useful's row and the Tabs group's read-only row ──────
// The wheel, Shift+PgUp, or Ctrl+B then [, which the Desktop's own viewer and the kernel's take alike.
// Ctrl+B [ needs tmux 3.3 or later where the agent runs (the viewer binds it only there); a terminal on
// another computer runs that computer's viewer, which has the two keys from OATS 0.69.0. A key that a
// shortcut takes while a terminal has focus (terminalTaker, the dispatcher's rule) never reaches tmux:
// it is left out, and the tooltip names the shortcut that holds it.
const SCROLL_KEYS = Object.freeze([
  Object.freeze({ chord: "Shift+PageUp", name: "Shift+PgUp", then: null }),
  Object.freeze({ chord: "Ctrl+B", name: "Ctrl+B", then: "[" }),
]);

/** The scroll keys as they reach a terminal now: `parts` ({ cap } or { word }, "Wheel up, Shift+PgUp
 * or Ctrl+B then ["), `keys` (each chord's keys, for the search), `said` (the parts as one sentence)
 * and `title` (the conditions, and each shortcut that takes one of the keys). */
export function scrollBackKeys(isMac) {
  const reach = [], taken = [];
  for (const key of SCROLL_KEYS) {
    const taker = terminalTaker(key.chord, TERMINAL_LAYER_CONTEXTS, isMac);
    if (taker) taken.push(`${key.name} is bound to “${taker.label}”, which takes it before the terminal.`);
    else reach.push(key);
  }
  const parts = [{ word: reach.length > 1 ? "Wheel up," : "Wheel up" }];
  const keys = [["Wheel", "up"]];
  reach.forEach((key, i) => {
    if (i === reach.length - 1) parts.push({ word: "or" });
    parts.push({ cap: formatChord(key.chord, isMac) });
    if (key.then) parts.push({ word: "then" }, { cap: key.then });
    keys.push(key.then ? [...chordKeys(key.chord, isMac), key.then] : chordKeys(key.chord, isMac));
  });
  const named = reach.map((key) => (key.then ? `${key.name} ${key.then}` : key.name));
  const title = [
    ...(reach.some((key) => key.then) ? ["Ctrl+B [ needs tmux 3.3 or later on the computer the agent runs on."] : []),
    ...(named.length ? [`On another computer, ${named.join(" and ")} ${named.length > 1 ? "need" : "needs"} OATS 0.69.0 or later there.`] : []),
    ...taken,
  ].join(" ");
  return { parts, keys, said: parts.map((part) => part.cap ?? part.word).join(" "), title };
}

/** The Most useful section's own rules (injected once per document with the editor): a two-column
 * reference table under a heading like the groups', its keycaps the rows' `.kb-keys kbd`, its words
 * the leader rows' `.kb-then`. Theme tokens only, every pair from the contrast inventory. */
export const usefulCSS = `
.kb-useful { margin-bottom: 4px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
.kb-useful-table { width: 100%; border-collapse: collapse; }
.kb-useful-name { padding: 5px 6px; text-align: left; vertical-align: middle; color: var(--fg); font-size: 13px; font-weight: 400; }
.kb-useful-keys { padding: 4px 6px; vertical-align: middle; }
.kb-useful-keys .kb-keys { justify-content: flex-end; flex-wrap: wrap; row-gap: 3px; }
`;

function ensureUsefulCSS(doc) {
  if (!doc.head || doc.head.querySelector("style[data-kb-useful]")) return;
  const style = doc.createElement("style"); style.dataset.kbUseful = ""; style.textContent = usefulCSS; doc.head.append(style);
}

/** Where a stage's direct chord and the leader's key mean different things (the leader's are the TUI's). */
const STAGE_DIFFERENCES = Object.freeze({ "stage.hierarchy": "1", "stage.automations": "3" });

/** `chordFamily` is the page's chord family (renderer/chord-family.mjs: current, set, onChange);
 * without it, or on macOS, the editor has no family choice. */
export function createKeybindingsEditor({ doc = document, isMac, chordFamily = null } = {}) {
  const labelOf = (id) => listActions().find((a) => a.id === id)?.label ?? null;
  const familyChoice = !isMac && !!chordFamily;
  const leaderText = () => { const chord = getBinding("app.leader", isMac); return chord ? formatChord(chord, isMac) : "the leader"; };
  let overlay = null;
  let offKeymap = null;
  let offFamily = null;
  let restoreFocus = null;
  let stopRecording = null; // teardown for an in-flight chord capture

  function endRecording() {
    if (stopRecording) { const stop = stopRecording; stopRecording = null; stop(); }
  }

  function close() {
    if (!overlay) return;
    endRecording(); // the capture listener must not outlive the dialog
    offKeymap?.(); offKeymap = null;
    offFamily?.(); offFamily = null;
    overlay.remove(); overlay = null;
    try { restoreFocus?.restore(); } catch { /* focus target may be gone */ }
    restoreFocus = null;
  }

  function open() {
    // Direct Mod+, must release an existing picker exactly like a palette-row
    // handoff, without leaving its document-level focus trap behind the editor.
    const opener = takePickerFocusReturn(doc);
    if (overlay) { overlay.querySelector(".kb-search").focus(); return; }
    restoreFocus = opener;
    ensureUsefulCSS(doc);
    overlay = doc.createElement("div");
    overlay.className = "palette-overlay kb-overlay";
    overlay.innerHTML = `
      <div class="kb-editor" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <div class="kb-head">
          <h2 class="kb-title">Keyboard shortcuts</h2>
          <div class="kb-search-field">${icon("search", { size: 13 })}<input type="search" class="kb-search"
            aria-label="Search shortcuts" placeholder="Search by name, group or keys" autocomplete="off" spellcheck="false"></div>
          <button type="button" class="kb-reset-all">Reset all</button>
          <button type="button" class="kb-close" aria-label="Close shortcuts editor">${icon("close", { size: 14 })}</button>
        </div>${familyChoice ? `
        <fieldset class="kb-family">
          <legend class="kb-family-title">${CHORD_FAMILY_WORDS.title}</legend>
          <div class="kb-family-options">${CHORD_FAMILIES.map((family) => `
            <label class="kb-family-option"><input type="radio" name="kb-family" value="${family}"> ${CHORD_FAMILY_WORDS.options[family]}</label>`).join("")}
          </div>
          <p class="kb-family-tui">${CHORD_FAMILY_WORDS.tui}</p>
          <p class="kb-family-note" role="status" hidden></p>
        </fieldset>` : ""}
        <p class="kb-hint">Click a shortcut to record a new one — Esc cancels, Backspace unbinds.</p>
        <p class="kb-clashes" role="status" hidden></p>
        <p class="kb-count sr-only" role="status"></p>
        <div class="kb-body"></div>
      </div>`;
    const search = overlay.querySelector(".kb-search");
    const body = overlay.querySelector(".kb-body");
    // The chord family: the choice shows the family in use, and the note main sent (keys.json was
    // there and not taken) or, after a write that failed, that the family in use stays.
    const familyEl = overlay.querySelector(".kb-family"), own = overlay;
    let unwritten = false;
    const renderFamily = () => {
      if (!familyEl || overlay !== own) return; // a write answered after this editor closed
      const { family: active, note } = chordFamily.current();
      for (const radio of familyEl.querySelectorAll('input[type="radio"]')) radio.checked = radio.value === active;
      const line = unwritten ? CHORD_FAMILY_WORDS.unwritten(active) : note;
      const noteEl = familyEl.querySelector(".kb-family-note");
      noteEl.textContent = line ?? "";
      noteEl.hidden = !line;
    };
    if (familyEl) {
      familyEl.addEventListener("change", (e) => {
        const family = e.target?.value;
        if (!CHORD_FAMILIES.includes(family)) return;
        unwritten = false;
        // Written at once; the keymap switches when main answers (chordFamily applies its state).
        chordFamily.set(family).then(renderFamily, () => { unwritten = true; renderFamily(); });
      });
      offFamily = chordFamily.onChange(() => { unwritten = false; renderFamily(); });
      renderFamily();
    }
    // The chord buttons of the rows the search shows, in order (Up/Down move along them).
    const visibleChords = () => [...body.querySelectorAll(".kb-chord")].filter((el) => !el.closest("[hidden]"));

    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener("keydown", (e) => {
      if (stopRecording) return; // the recorder owns every key, Esc included (it cancels)
      if (e.key === "Escape") {
        e.preventDefault();
        // A search is cleared first, from anywhere in the editor; the next Esc closes.
        if (search.value) { search.value = ""; applySearch({ announce: true }); search.focus(); } else close();
        return;
      }
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const chords = visibleChords();
        const row = e.target.closest?.(".kb-row");
        let to = null;
        if (e.target === search) to = e.key === "ArrowDown" ? chords[0] : null;
        else if (row) {
          const at = chords.indexOf(row.querySelector(".kb-chord"));
          to = e.key === "ArrowDown" ? chords[at + 1] : at === 0 ? search : chords[at - 1];
        }
        if (to) { e.preventDefault(); to.focus(); }
        return;
      }
      if (e.key !== "Tab") return;
      // aria-modal promises focus containment — wrap Tab/Shift+Tab inside the
      // dialog (same handling as the workspace-switcher modal). The search is
      // the first stop; rows the search hides have none.
      const dialog = overlay.querySelector(".kb-editor");
      const focusable = [...dialog.querySelectorAll("input, button:not([disabled])")]
        .filter((el) => !el.closest("[hidden]") && el.tabIndex >= 0);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable.at(-1);
      if (e.shiftKey && (doc.activeElement === first || !dialog.contains(doc.activeElement))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && (doc.activeElement === last || !dialog.contains(doc.activeElement))) {
        e.preventDefault(); first.focus();
      }
    });
    doc.body.append(overlay);
    overlay.querySelector(".kb-close").addEventListener("click", close);
    overlay.querySelector(".kb-reset-all").addEventListener("click", () => { endRecording(); resetAllBindings(); });
    search.addEventListener("input", () => applySearch({ announce: true }));
    // A focused row is revealed below its group's pinned heading, which would otherwise cover it
    // when Up/Down or Shift+Tab walks upwards (the browser's own focus scroll ignores the heading).
    body.addEventListener("focusin", (e) => {
      const row = e.target.closest?.(".kb-row");
      if (row) revealInScrollport(body, row, row.closest(".kb-group")?.querySelector(".kb-context"));
    });

    // Show the rows that match the search, hide groups left empty, say when nothing
    // matches, and announce the count politely: when the query changes, and when a rebind,
    // unbind or reset changes what a search shows (never on open).
    const applySearch = ({ announce = false } = {}) => {
      const query = search.value;
      let shown = 0;
      for (const group of body.querySelectorAll(".kb-group")) {
        let inGroup = 0;
        for (const row of group.querySelectorAll(".kb-row")) {
          const keys = row.dataset.keys ? JSON.parse(row.dataset.keys) : null;
          const match = shortcutMatches({ label: row.dataset.label, group: group.dataset.label, chord: row.dataset.chord || null, keys }, query, isMac);
          row.hidden = !match;
          if (match) inGroup++;
        }
        group.hidden = inGroup === 0;
        shown += inGroup;
      }
      // Most useful is the editor's first section, not a search result: a search shows the list alone.
      const useful = body.querySelector(".kb-useful");
      if (useful) useful.hidden = !!query.trim();
      const none = body.querySelector(".kb-nomatch");
      if (none) {
        none.hidden = shown > 0;
        none.textContent = shown > 0 ? "" : `No shortcut matches “${query.trim()}”`;
      }
      if (announce) overlay.querySelector(".kb-count").textContent = `${shown} ${shown === 1 ? "shortcut" : "shortcuts"}`;
    };

    const render = () => {
      endRecording(); // a rerender invalidates any in-flight capture
      // Preserve keyboard focus across the rebuild (review 267c551): remember
      // which row control owned focus (keyed by action id + control kind) and
      // restore it on the replacement node, else fall back into the dialog so
      // Tab can never restart from <body> outside the trap.
      const focused = doc.activeElement;
      const hadDialogFocus = overlay.contains(focused);
      const focusKey = hadDialogFocus && focused?.dataset?.actionId
        ? { id: focused.dataset.actionId, kind: focused.classList.contains("kb-reset") ? "kb-reset" : "kb-chord" }
        : null;
      body.innerHTML = "";
      // A shortcut you set that now shares its chord with another (a new default, say): named
      // up top, marked on its row. Nothing is rebound for you.
      const clashes = keymapConflicts(isMac);
      const clashEl = overlay.querySelector(".kb-clashes");
      clashEl.hidden = !clashes.length;
      clashEl.textContent = clashes.length
        ? `${clashes.length === 1 ? "A shortcut you set clashes" : `${clashes.length} shortcuts you set clash`} with another: ${clashes
          .map(clashWords(isMac)).join("; ")}. Rebind or reset one.`
        : "";
      const groups = groupActions();
      if (!groups.length) {
        const d = doc.createElement("div");
        d.className = "kb-empty";
        d.textContent = "No actions registered.";
        body.append(d);
      } else {
        body.append(usefulSection());
        for (const group of groups) {
          // One group: its heading sticks to the top of the scroll area while its rows scroll.
          const section = doc.createElement("section");
          section.className = "kb-group";
          section.dataset.label = group.label;
          const h = doc.createElement("h3");
          h.className = "kb-context";
          h.textContent = group.label;
          section.append(h);
          for (const action of group.actions) section.append(row(action, group));
          if (group.context === "leader") {
            // The leader matches the TUI; the direct chords are Desktop extras, and where one means
            // something else than the leader's key, both are named.
            const extras = doc.createElement("p");
            extras.className = "kb-extras";
            const stage = (id) => { const chord = getBinding(id, isMac); return chord ? formatChord(chord, isMac) : "unbound"; };
            extras.textContent = `The leader and the keys after it are the TUI's; the direct shortcuts are Desktop extras. ${leaderText()} then 1 is Instances and ${leaderText()} then 3 is Capabilities, while ${stage("stage.hierarchy")} stays Machines and ${stage("stage.automations")} stays Automations.`;
            h.after(extras);
            for (const leaderRow of supportedLeaderRows()) section.append(leaderFixedRow(leaderRow));
          }
          if (group.context === "tabs") section.append(scrollBackRow());
          body.append(section);
        }
        const none = doc.createElement("p");
        none.className = "kb-empty kb-nomatch";
        none.hidden = true;
        body.append(none);
      }
      applySearch({ announce: !!search.value || !!overlay.querySelector(".kb-count").textContent });
      if (focusKey) {
        const controls = [...body.querySelectorAll(".kb-chord, .kb-reset")];
        const target = controls.find((el) => el.dataset.actionId === focusKey.id && el.classList.contains(focusKey.kind) && !el.hidden)
          // a hidden per-row reset (row back at default) falls back to its chord button
          ?? controls.find((el) => el.dataset.actionId === focusKey.id && el.classList.contains("kb-chord"));
        if (target && !target.closest("[hidden]")) { target.focus(); return; }
      }
      // focus left the rebuilt rows, or its row is filtered out: keep it inside the dialog
      if (hadDialogFocus && !overlay.contains(doc.activeElement)) search.focus();
    };

    // Most useful (usefulRows): a table, so a screen reader reads each row's action and then its keys.
    // Read-only, rebuilt with the list at every keymap change, so a rebind below shows here at once.
    const usefulSection = () => {
      const section = doc.createElement("section");
      section.className = "kb-useful";
      section.setAttribute("aria-labelledby", "kb-useful-title");
      section.innerHTML = `
        <h3 class="kb-context" id="kb-useful-title">Most useful</h3>
        <table class="kb-useful-table" aria-labelledby="kb-useful-title">
          <thead><tr><th scope="col" class="sr-only">Action</th><th scope="col" class="sr-only">Keys</th></tr></thead>
          <tbody></tbody>
        </table>`;
      const tbody = section.querySelector("tbody");
      for (const { name, keys } of usefulRows(isMac)) {
        const tr = doc.createElement("tr");
        tr.className = "kb-useful-row";
        const th = doc.createElement("th");
        th.scope = "row";
        th.className = "kb-useful-name";
        th.textContent = name;
        const td = doc.createElement("td");
        td.className = "kb-useful-keys";
        const shown = doc.createElement("span");
        shown.className = "kb-keys";
        keys.forEach((k, i) => {
          if (i) shown.append(" "); // read as words, not run together
          const el = doc.createElement(k.cap ? "kbd" : "span");
          if (!k.cap) el.className = "kb-then";
          el.textContent = k.cap ?? k.word;
          shown.append(el);
        });
        td.append(shown);
        tr.append(th, td);
        tbody.append(tr);
      }
      return section;
    };

    const row = (action, group) => {
      const el = doc.createElement("div");
      el.className = "kb-row";
      const chordStr = getBinding(action.id, isMac); // this platform's effective chord
      // the effective default: static table or registration-supplied
      const fixed = defaultBinding(action.id, isMac);
      const defaultChord = fixed !== undefined ? fixed : action.defaultChord ?? null;
      const isDefault = chordStr === defaultChord;
      const chordText = chordStr ? formatChord(chordStr, isMac) : "unbound";
      // What matchEvent would allow from a focused terminal: by id on Linux/Windows, by chord on macOS.
      const inTerminal = !!chordStr && TERMINAL_LAYER_CONTEXTS.has(action.context) && terminalAllows(action.id, chordStr, isMac);
      el.dataset.label = action.label;
      if (chordStr) el.dataset.chord = chordStr;
      el.innerHTML = `
        <span class="kb-main"><span class="kb-label"></span><span class="kb-conflict" role="status"></span></span>
        <span class="kb-marks" aria-hidden="true"></span>
        <span class="kb-chord-cell"><button type="button" class="kb-chord"></button></span>
        <span class="kb-reset-slot"><button type="button" class="kb-reset" title="Reset to default" aria-label="Reset to default">${icon("reset", { size: 14 })}</button></span>`;
      el.querySelector(".kb-label").textContent = action.label;
      // Quiet markers; the chord button's name carries them for assistive technology.
      const marks = el.querySelector(".kb-marks");
      const mark = (kind, text, title) => {
        const m = doc.createElement("span");
        m.className = `kb-mark kb-mark-${kind}`;
        m.textContent = text;
        m.title = title;
        marks.append(m);
      };
      if (inTerminal) mark("terminal", "terminal", "Works while a terminal has focus");
      // A stage whose leader key is something else (the leader's 1 and 3 are the TUI's): said on the row.
      if (STAGE_DIFFERENCES[action.id]) {
        const note = doc.createElement("span");
        note.className = "kb-note";
        note.textContent = `${leaderText()} then ${STAGE_DIFFERENCES[action.id]} is ${STAGE_DIFFERENCES[action.id] === "1" ? "Instances" : "Capabilities"}, as in the TUI`;
        el.querySelector(".kb-main").append(note);
      }
      if (!isDefault) mark("changed", "changed", `Changed from the default, ${defaultChord ? formatChord(defaultChord, isMac) : "unbound"}`);
      const chordBtn = el.querySelector(".kb-chord");
      chordBtn.dataset.actionId = action.id;
      if (chordStr) {
        // One keycap per key, not read key by key: the button's name has the chord as one string.
        const keys = doc.createElement("span");
        keys.className = "kb-keys";
        keys.setAttribute("aria-hidden", "true");
        for (const k of chordKeys(chordStr, isMac)) {
          const kbd = doc.createElement("kbd");
          kbd.textContent = k;
          keys.append(kbd);
        }
        chordBtn.append(keys);
      } else chordBtn.textContent = "unbound";
      chordBtn.classList.toggle("kb-unbound", !chordStr);
      chordBtn.setAttribute("aria-label", `Change shortcut for ${action.label}, currently ${chordText}`
        + (inTerminal ? ", works in a terminal" : "") + (isDefault ? "" : ", changed from the default"));
      const note = el.querySelector(".kb-note");
      if (note) chordBtn.setAttribute("aria-description", note.textContent);
      const resetBtn = el.querySelector(".kb-reset");
      resetBtn.dataset.actionId = action.id;
      resetBtn.hidden = isDefault;
      resetBtn.setAttribute("aria-label", `Reset shortcut for ${action.label} to default`);
      resetBtn.addEventListener("click", () => resetBinding(action.id));

      const conflictEl = el.querySelector(".kb-conflict");
      const existing = chordStr ? findConflict(chordStr, action.context, action.id, isMac) : null;
      // Both facts matter independently: a bare chord that ALSO conflicts
      // must still disclose the editable-field suppression (review c5493b1).
      const warnings = [];
      if (existing) warnings.push(`Also bound to “${existing.label}”`);
      if (chordStr && isPlainChord(chordStr)) {
        // review-mandated warning: bare-key bindings are suppressed while an
        // editable field has focus (matchEvent's editable-field guard).
        warnings.push("Bare key — won’t fire while typing in a text field");
      }
      conflictEl.textContent = warnings.join(" · ");

      chordBtn.addEventListener("click", () => startRecording(action, chordBtn, conflictEl));
      return el;
    };

    // A read-only row, reached by Up/Down and never a Tab stop: its label, its keys and the words
    // between them (`parts`: { cap } or { word }), the keys a search finds it by, what a screen reader
    // says, and a tooltip when the keys have a condition.
    const fixedRow = ({ id, label, parts, keys: searchKeys, said, title = null }) => {
      const el = doc.createElement("div");
      el.className = "kb-row kb-row-fixed";
      el.dataset.label = label;
      el.dataset.keys = JSON.stringify(searchKeys);
      if (title) el.title = title;
      el.innerHTML = `
        <span class="kb-main"><span class="kb-label"></span></span>
        <span class="kb-marks" aria-hidden="true"></span>
        <span class="kb-chord-cell"><span class="kb-chord kb-fixed" tabindex="-1"></span></span>
        <span class="kb-reset-slot"></span>`;
      el.querySelector(".kb-label").textContent = label;
      const chord = el.querySelector(".kb-chord");
      chord.dataset.actionId = id;
      const keys = doc.createElement("span");
      keys.className = "kb-keys";
      keys.setAttribute("aria-hidden", "true");
      for (const part of parts) {
        const node = doc.createElement(part.cap ? "kbd" : "span");
        if (!part.cap) node.className = "kb-then";
        node.textContent = part.cap ?? part.word;
        keys.append(node);
      }
      const sr = doc.createElement("span");
      sr.className = "sr-only";
      sr.textContent = said;
      chord.append(keys, sr);
      return el;
    };
    const capText = (caps) => caps.join(isMac ? "" : "+");

    // A key of the leader's table: read-only (the table is fixed, as in the TUI), reached by Up/Down,
    // found by its keys ("ctrl+x k") and by "leader".
    const leaderFixedRow = (leaderRow) => {
      const leaderChord = getBinding("app.leader", isMac);
      const leaderCaps = leaderChord ? chordKeys(leaderChord, isMac) : [];
      const parts = [leaderCaps.length ? { cap: capText(leaderCaps) } : { word: "leader" }, { word: "then" }];
      leaderRow.keys.forEach((key, i) => { if (i) parts.push({ word: "or" }); parts.push({ cap: capText(keyIdCaps(key, isMac)) }); });
      return fixedRow({
        id: `leader:${leaderRow.does}`, label: leaderLabel(leaderRow.does, labelOf), parts,
        keys: [...leaderCaps, ...leaderRow.keys.flatMap((key) => keyIdCaps(key, isMac))],
        said: `${leaderText()} then ${rowKeysText(leaderRow, isMac)}, fixed`,
      });
    };

    // How to scroll back in a terminal (#1502): the keys that reach it now, and their conditions in the
    // tooltip (scrollBackKeys).
    const scrollBackRow = () => {
      const { parts, keys, said, title } = scrollBackKeys(isMac);
      return fixedRow({ id: "terminal:scrollBack", label: "Scroll back in a terminal", parts, keys, said: `${said}, fixed`, title });
    };

    const startRecording = (action, btn, conflictEl) => {
      if (stopRecording) return;
      btn.classList.add("kb-recording");
      btn.textContent = "Press keys…";
      const onKey = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") { endRecording(); render(); return; }
        if (e.key === "Backspace" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
          endRecording(); setBinding(action.id, null); return;
        }
        const chord = chordFromEvent(e, isMac);
        if (!chord) return; // bare modifier — keep recording
        const conflict = findConflict(chord, action.context, action.id, isMac);
        if (conflict) conflictEl.textContent = `Also bound to “${conflict.label}”`;
        endRecording();
        setBinding(action.id, chordToString(chord));
      };
      stopRecording = () => {
        doc.removeEventListener("keydown", onKey, true);
        btn.classList.remove("kb-recording");
      };
      doc.addEventListener("keydown", onKey, true);
    };

    offKeymap = onKeymapChange(render);
    render();
    search.focus();
  }

  return {
    open,
    close,
    toggle: () => (overlay ? close() : open()),
    isOpen: () => !!overlay,
  };
}
