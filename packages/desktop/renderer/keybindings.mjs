// oats desktop — keybinding engine (pure logic; unit-tested without a DOM).
//
// One shared registry: the shell/wiring code registers actions
// ({ id, label, context, run }); this module owns chord parsing, the default
// keymap, user overrides (localStorage), context scoping, and dispatch.
//
// Terminal safety (docs/desktop-keyboard.md, principle 2). When the keydown target is inside
// `.xterm`, on macOS ONLY chords whose `Mod` resolves to ⌘ (meta) may fire — ⌘ never reaches the
// pty — plus shapes named by action id: Ctrl+Tab tab cycling, the leader's ⌃X (or ⌃\), and ⌥ with an
// arrow for the moves between tabs, groups and workspaces (the product owner's call, 2026-10-23: the program loses
// what xterm.js sends for them, ⌥←/→'s word moves ESC b / ESC f among them); every other chord
// (⌃digits, F6, Ctrl+letters, the other ⌥ keys) belongs to the attached program.
// On Linux/Windows the Ctrl key IS the terminal's control key, so only an explicit allowlist of
// action ids may fire inside the terminal; every other chord passes through. Their defaults there
// are chords xterm sends nothing for (Ctrl+Shift+key, the GNOME Terminal / Alacritty / Ghostty /
// kitty convention, and the Ctrl+Shift family's seven), a byte a plainer key still sends (the
// Ctrl+Alt family: ESC, then the Ctrl+letter byte or the digit), the Alt family's keys, which a
// program reads (Alt+letter and Alt+digit are ESC and the key, which it still gets from Esc, then
// the key; xterm.js sends an Alt arrow as the Ctrl arrow, CSI 1;5, on Linux/Windows; Alt+↑/↓ are the
// Alt family's alone, the other two leave them to the program) (the product owner's call, 2026-10-22: the rule that a default never takes a key a
// program reads gives way for the Alt family; the collision table names each), and three named
// exceptions (TERMINAL_ALLOWLIST has the rule), the leader's Ctrl+X among them. Every other plain
// Ctrl+letter (Ctrl+W, Ctrl+K, Ctrl+P, Ctrl+B, Ctrl+\) and F6 stay the program's, and so does every
// Alt key no chord holds. app-menu.mjs follows the same policy for the menu accelerators.
// docs/desktop-keyboard.md is the keymap's reference.
//
// The leader, the plain keys and the chords the Desktop shares with the TUI are written down once,
// in packages/client/keymap.mjs: DEFAULT_KEYMAP reads app.leader, the sidebar.key.* defaults and
// the chords of CHORDS_READ from there (chordFromKeyId), never a literal of its own. The palette's
// own keys (PALETTE_KEYS, read with paletteKey) are not bindings: paletteGroupDirection reads them
// for the open palette, and paletteGroupHint names them in its footer.
//
// The chord family (docs/desktop-keyboard.md, "The chord families"): on Linux/Windows the shared
// chords are the Alt family by default (the shared CHORDS `alt` column), or the Ctrl+Alt family
// (`other`) or the Ctrl+Shift family (`shift`: seven rows move, the others keep their Ctrl+Alt key)
// when keys.json says so. Main reads keys.json and
// hands the family to the page (chord-family.mjs, renderer/chord-family.mjs), which sets it here with
// setChordFamily before the shell listens to its first key; every reader of a default asks
// defaultBinding, which reads the active family's keymap, so a switch applies at once. macOS has no
// family: its keys are the same in both.

import { CHORDS, CHORD_FAMILIES, DEFAULT_CHORD_FAMILY, LEADER, PLAIN_KEYS, chordKeyOf, paletteKey } from "../../client/keymap.mjs";

const STORAGE_KEY = "oats-desktop-keymap";

// ---------------------------------------------------------------- chords

const MOD_ORDER = ["Mod", "Ctrl", "Alt", "Shift"];

// e.key values normalized so layouts/shift variants land on one spelling.
const KEY_ALIASES = new Map([
  ["pgdn", "pagedown"], ["pgup", "pageup"],
  ["esc", "escape"],
  [" ", "space"],
  ["spacebar", "space"],
  // An arrow's stored spelling is its label (chordToString: "Alt+Shift+↑"), read back as the key.
  ["↑", "arrowup"], ["↓", "arrowdown"], ["←", "arrowleft"], ["→", "arrowright"],
]);
// Only for a chord that holds Mod, Ctrl or Alt: there the shifted character names its key.
// A plain chord keeps its own character, so a plain `|` never fires on a plain `\`.
const MODIFIED_ALIASES = new Map([
  ["+", "="], // Shift-= / numpad plus both mean the "=" binding (Mod+=)
  ["|", "\\"], // Shift-\ produces "|" — both mean the "\" binding (Mod+Shift+\)
]);

/** A key as a chord holding a modifier names it (the aliases of both tables). */
export function normalizeKey(key) {
  const k = String(key || "").toLowerCase();
  const base = KEY_ALIASES.get(k) || k;
  return MODIFIED_ALIASES.get(base) || base;
}

const baseKey = (key) => { const k = String(key || "").toLowerCase(); return KEY_ALIASES.get(k) || k; };

/** One printable character that is not a letter (`?`, `|`, `[`, `/`, a digit): a plain chord on
 * such a key matches whatever Shift the layout needed to type it, so it never carries Shift
 * (`KeyboardEvent.key` already holds the shift). Letters keep their case: `N` is Shift+N. */
const shiftFreeKey = (key) => [...key].length === 1 && !/\p{L}/u.test(key) && /\S/u.test(key);

/** The chord's own spelling of its key, and Shift dropped where the rule above says so. A key
 * AltGr typed (`aliases` false) keeps its character: Spanish AltGr+1 is `|`, never `\`. */
function settleChord(chord, aliases = true) {
  if (chord.mod || chord.ctrl || chord.alt) { if (aliases) chord.key = MODIFIED_ALIASES.get(chord.key) || chord.key; }
  else if (shiftFreeKey(chord.key)) chord.shift = false;
  return chord;
}

/** Parse "Mod+Shift+K" → { key, mod, ctrl, alt, shift } or null. */
export function parseChord(str) {
  if (!str || typeof str !== "string") return null;
  const parts = str.split("+");
  // "Mod+=" splits as ["Mod", "", ""] — rejoin a trailing empty pair as "+".
  if (parts.length >= 2 && parts[parts.length - 1] === "" && parts[parts.length - 2] === "") {
    parts.splice(parts.length - 2, 2, "+");
  }
  const chord = { key: "", mod: false, ctrl: false, alt: false, shift: false };
  for (const raw of parts) {
    const p = raw.trim().toLowerCase();
    if (p === "mod" || p === "cmdorctrl" || p === "cmd" || p === "meta") chord.mod = true;
    else if (p === "ctrl" || p === "control") chord.ctrl = true;
    else if (p === "alt" || p === "option") chord.alt = true;
    else if (p === "shift") chord.shift = true;
    else if (p) {
      if (chord.key) return null; // two non-modifier keys — invalid
      chord.key = baseKey(p);
    }
  }
  if (!chord.key) return null;
  return settleChord(chord);
}

const KEY_LABELS = new Map([
  ["escape", "Esc"], ["arrowup", "↑"], ["arrowdown", "↓"],
  ["arrowleft", "←"], ["arrowright", "→"], ["space", "Space"],
  ["tab", "Tab"], ["enter", "Enter"], ["backspace", "Backspace"],
  ["pagedown", "PgDn"], ["pageup", "PgUp"],
]);

function keyLabel(key) {
  return KEY_LABELS.get(key) || (key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1));
}

/** The keys of a chord (object or string) as shown, one label per key, in the order
 * they are written: ["⇧", "⌘", "B"] on mac, ["Ctrl", "Shift", "B"] elsewhere. */
export function chordKeys(chord, isMac = defaultIsMac()) {
  const c = typeof chord === "string" ? parseChord(chord) : chord;
  if (!c) return [];
  const keys = [];
  if (isMac) {
    if (c.ctrl) keys.push("⌃");
    if (c.alt) keys.push("⌥");
    if (c.shift) keys.push("⇧");
    if (c.mod) keys.push("⌘");
  } else {
    if (c.mod || c.ctrl) keys.push("Ctrl");
    if (c.alt) keys.push("Alt");
    if (c.shift) keys.push("Shift");
  }
  keys.push(keyLabel(c.key));
  return keys;
}

/** Human label for a chord (object or string). Mod = ⌘ on mac, Ctrl elsewhere. */
export function formatChord(chord, isMac = defaultIsMac()) {
  return chordKeys(chord, isMac).join(isMac ? "" : "+");
}

/** Canonical storage/comparison string for a chord object. */
export function chordToString(chord) {
  const c = typeof chord === "string" ? parseChord(chord) : chord;
  if (!c) return null;
  const parts = [];
  if (c.mod) parts.push("Mod");
  if (c.ctrl) parts.push("Ctrl");
  if (c.alt) parts.push("Alt");
  if (c.shift) parts.push("Shift");
  parts.push(c.key === "=" ? "=" : keyLabel(c.key));
  return parts.join("+");
}

// macOS: Option changes the character a key types (⌥O is ø, ⌥1 ¡), so a chord that holds ⌥ with ⌘ or
// ⌃ names its letter or digit key by the layout's own character for the physical key (`code`):
// navigator.keyboard.getLayoutMap(), read at startup and whenever the window regains focus
// (shell.mjs), when that character is an ASCII letter, else the letter `code` names (a
// Russian layout's KeyO is щ: ⌘⌥ on it is ⌘⌥O). A digit key is its digit on every layout (the number
// row's place: ⌘⌥ on AZERTY's & key is ⌘⌥1, go to tab 1). Linux/Windows read `key` (AltGr's
// character must win there), and plain ⌥+key is typing.
let layoutMap = null;
/** The keyboard layout's map (code → base character), or null for none; tests inject one here. */
export function setKeyboardLayoutMap(map) { layoutMap = map && typeof map.get === "function" ? map : null; }
/** Read the layout map now (navigator.keyboard.getLayoutMap), keeping the last one if it fails. */
export function readKeyboardLayout(nav = globalThis.navigator) {
  try {
    const pending = nav?.keyboard?.getLayoutMap?.();
    if (pending && typeof pending.then === "function") return pending.then(setKeyboardLayoutMap, () => {});
  } catch { /* no keyboard API */ }
  return Promise.resolve();
}
function macOptionKey(e) {
  // ⌥Space types a no-break space, a key no chord names. Every ⌘⌥ / ⌃⌥ press on Space reads Space, as a
  // letter or digit key reads its letter or digit here, not only the font picker's: the key is read before any
  // action is known, and the shortcuts editor records what this reads, so a ⌥ chord with Space given there, for
  // any action, matches its own press. No default holds ⌥ with ⌘ or ⌃ on Space in any family, so no default's
  // matching changes (keymap-linux.test.mjs).
  if (e.code === "Space") return "space";
  const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(String(e.code || ""));
  if (!m) return null;
  if (m[2]) return m[2];
  let base = null;
  try { base = layoutMap?.get(e.code); } catch { /* a broken map reads as none */ }
  // The map's character names the key only when it is a letter of the table's: a Russian layout's
  // KeyO is "щ", and ⌘⌥ on it is ⌘⌥O, as the menus read it.
  return typeof base === "string" && /^[a-z]$/i.test(base) ? base.toLowerCase() : m[1].toLowerCase();
}

/** Build a chord object from a keydown event (for the recorder + matching).
 * On mac, metaKey is `Mod`; elsewhere ctrlKey is `Mod` (never both). */
export function chordFromEvent(e, isMac = defaultIsMac()) {
  const optionChord = isMac && !!e.altKey && !!(e.metaKey || e.ctrlKey);
  const key = (optionChord && macOptionKey(e)) || baseKey(e.key);
  if (!key || ["meta", "control", "alt", "altgraph", "shift"].includes(key)) return null;
  const altGraph = typeof e.getModifierState === "function" && e.getModifierState("AltGraph") === true;
  // AltGr is never Alt on Linux/Windows: a key it presses types its character, and no Alt chord
  // fires for it (an AltGr layout's AltGr+E is €, never Alt+E). Linux reports AltGr as AltGraph
  // alone; Windows as Ctrl and Alt with it, which stays the Ctrl+Alt chord it is there (where the
  // layout types a character, `key` is that character and matches nothing).
  const alt = !!e.altKey && !(altGraph && !isMac && !e.ctrlKey);
  const chord = { key, mod: false, ctrl: false, alt, shift: !!e.shiftKey };
  if (isMac) {
    chord.mod = !!e.metaKey;
    chord.ctrl = !!e.ctrlKey;
  } else {
    chord.mod = !!e.ctrlKey; // Ctrl plays the Mod role; explicit meta ignored
  }
  return settleChord(chord, !altGraph);
}

const NAMED_KEY_IDS = new Map([
  ["up", "ArrowUp"], ["down", "ArrowDown"], ["left", "ArrowLeft"], ["right", "ArrowRight"],
  ["escape", "Escape"], ["space", "Space"], ["enter", "Enter"], ["tab", "Tab"],
  ["home", "Home"], ["end", "End"], ["pageup", "PageUp"], ["pagedown", "PageDown"],
]);

/** A key id of the shared keymap (packages/client/keymap.mjs, the TUI's spelling: `alt+o`,
 * `ctrl+\\`, `N`, `?`, `ctrl+alt+shift+e`, `alt+shift+up`, and `cmd+` for ⌘) as this engine's
 * canonical chord string (`Alt+O`, `Ctrl+\\`, `Shift+N`, `?`, `Ctrl+Alt+Shift+E`, `Alt+Shift+↑`,
 * `Mod+K`). */
export function chordFromKeyId(keyId) {
  let rest = String(keyId || "");
  const chord = { key: "", mod: false, ctrl: false, alt: false, shift: false };
  for (;;) {
    if (rest.startsWith("cmd+") && rest.length > 4) { chord.mod = true; rest = rest.slice(4); }
    else if (rest.startsWith("ctrl+") && rest.length > 5) { chord.ctrl = true; rest = rest.slice(5); }
    else if (rest.startsWith("alt+") && rest.length > 4) { chord.alt = true; rest = rest.slice(4); }
    else if (rest.startsWith("shift+") && rest.length > 6) { chord.shift = true; rest = rest.slice(6); }
    else break;
  }
  if (NAMED_KEY_IDS.has(rest)) chord.key = baseKey(NAMED_KEY_IDS.get(rest));
  else if ([...rest].length === 1) {
    chord.key = rest.toLowerCase();
    chord.shift ||= rest !== chord.key; // a capital letter is Shift and the letter
  } else return null;
  return chordToString(settleChord(chord));
}

/** Platform-concrete equality: does `chord` (with Mod) match the event chord? */
function chordMatches(chord, evChord, isMac) {
  if (!chord || !evChord) return false;
  if (chord.key !== evChord.key || chord.alt !== evChord.alt || chord.shift !== evChord.shift) return false;
  if (isMac) return chord.mod === evChord.mod && chord.ctrl === evChord.ctrl;
  // non-mac: Mod and Ctrl are the same physical modifier
  return (chord.mod || chord.ctrl) === (evChord.mod || evChord.ctrl);
}

function defaultIsMac() {
  try {
    return /mac/i.test(navigator.platform || "");
  } catch { return false; }
}

/** True when the event target is a real editable control — plain-key chords
 * must not steal typing (mirrors the panel's logical key-routing lesson). */
function isEditableTarget(target) {
  if (!target) return false;
  const tag = String(target.tagName || "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return !!target.isContentEditable;
}

/** The input types whose popup Chromium opens with Alt+↑ / Alt+↓ (a date or time picker). */
const PICKER_INPUTS = new Set(["date", "time", "datetime-local", "month", "week"]);
/** True when the event target is a native control that opens its popup with Alt+↑ / Alt+↓ on Linux and
 * Windows: a select (its list), an input with a datalist (its suggestions) or a date or time input (its
 * picker). A default chord on those keys (the workspace moves) is left to it; matchEvent applies it. */
function opensOnAltArrow(target) {
  if (!target) return false;
  const tag = String(target.tagName || "").toUpperCase();
  if (tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  return !!target.getAttribute?.("list") || PICKER_INPUTS.has(String(target.type || "").toLowerCase());
}

/** The input types a caret moves through. */
const CARET_INPUTS = new Set(["text", "search", "url", "tel", "email", "password", "number"]);
/** True when the event target is a field of text, where macOS moves the caret with ⌥ and an arrow (by
 * word with ⌥←/→, to the paragraph's start or end with ⌥↑/↓) and selects so with ⇧ too: a textarea, a
 * contenteditable or a text input, a read-only one too (its selection still moves). A terminal's helper
 * textarea is one: matchEvent tells terminals apart. A default chord on those keys (the moves between
 * tabs, groups and workspaces) is left to it there; matchEvent applies it. */
function movesCaretOnOption(target) {
  if (!target) return false;
  const tag = String(target.tagName || "").toUpperCase();
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") return CARET_INPUTS.has(String(target.type || "text").toLowerCase());
  return !!target.isContentEditable;
}

// ---------------------------------------------------------------- defaults

// One entry per action: a chord string (the same on every platform, `Mod` = ⌘ on
// macOS and Ctrl elsewhere) or `{ mac, other }` when the platforms differ (null =
// no default there). Principles (docs/desktop-keyboard.md): Super/Meta belongs to
// the window manager on Linux, so `Mod` is Ctrl there and nothing binds Super;
// a chord that must work while a terminal has focus is one xterm.js sends no byte
// for on Linux/Windows, or a byte the program still gets from a plainer key
// (TERMINAL_ALLOWLIST has the rule), because plain Ctrl+letter belongs to the
// program; macOS keeps ⌘, which never reaches the pty. Every default passed the collision review in the
// keyboard lesson, shifted punctuation included (KEY_ALIASES, tested with the
// real shifted event). Action ids never change, so stored overrides survive.
//
// The sidebar's plain keys (context `sidebar`): one action per key of the shared PLAIN_KEYS that
// the Desktop reads in the sidebar, each with the `does` its default comes from. The tree keys
// (up/down/top/bottom/page/collapse/expand) stay DOM-local in roster-keys.mjs; `open` is the
// row's own Enter.
export const SIDEBAR_KEYS = Object.freeze([
  ["sidebar.key.instances", "instances"], ["sidebar.key.souls", "souls"], ["sidebar.key.capabilities", "capabilities"],
  ["sidebar.key.workspaces", "workspaces"], ["sidebar.key.filter", "filter"], ["sidebar.key.refresh", "refresh"],
  ["sidebar.key.zoom", "zoom"], ["sidebar.key.closeTerminal", "close-terminal"],
  ["sidebar.key.tabPrevious", "tab-previous"], ["sidebar.key.tabNext", "tab-next"],
  ["sidebar.key.splitRight", "split-right"], ["sidebar.key.splitDown", "split-down"],
  ["sidebar.key.stop", "stop"], ["sidebar.key.retire", "retire"], ["sidebar.key.start", "start"], ["sidebar.key.restart", "restart"],
  ["sidebar.key.spawn", "spawn"], ["sidebar.key.spawnAnother", "spawn-another"], ["sidebar.key.help", "help"],
].map(([id, does]) => Object.freeze({ id, does })));

const plainDefault = (does) => chordFromKeyId(PLAIN_KEYS.find((entry) => entry.does === does)?.keys[0]) ?? null;

// The chords the Desktop shares with the TUI (packages/client/keymap.mjs CHORDS), by the action that
// reads each and its `does`, in the table's order. One string where both platforms have the same
// chord. The shared tab moves are the second tab-cycling chords (tabs.prevPage, tabs.nextPage):
// Ctrl+Tab and Ctrl+Shift+Tab stay the Desktop's own (tabs.next, tabs.prev). The leader's ↑ ↓ z
// have actions of their own here (roster.openPrevious, roster.openNext, terminal.focusMode: shell.mjs),
// which run what the leader then that key runs.
export const CHORDS_READ = Object.freeze([
  ["app.palette", "palette"], ["app.quickOpenSouls", "spawn"], ["app.workspaces", "workspaces"],
  ["roster.openPrevious", "previous"], ["roster.openNext", "next"],
  ["workspace.previous", "workspace-previous"], ["workspace.next", "workspace-next"],
  ["tabs.prevPage", "tab-previous"], ["tabs.nextPage", "tab-next"],
  ...Array.from({ length: 9 }, (_, i) => [`tabs.goto${i + 1}`, `tab-${i + 1}`]),
  ["terminal.focusMode", "zoom"], ["tabs.close", "close-terminal"],
  ["split.vertical", "split-right"], ["split.horizontal", "split-down"],
  ["split.focusPrevGroup", "group-previous"], ["split.focusNextGroup", "group-next"],
  ["sidebar.focusFilter", "filter"], ["instance.edit", "edit-instance"],
].map(([id, does]) => Object.freeze({ id, does })));
/** The default of the CHORDS row `does` in `family`: macOS's key, and Linux/Windows' key in that
 * family (chordKeyOf), as one string where both are the same chord. */
function chordDefault(does, family) {
  const entry = CHORDS.find((each) => each.does === does);
  const mac = chordFromKeyId(entry.mac), other = chordFromKeyId(chordKeyOf(entry, false, family));
  return mac === other ? mac : { mac, other };
}

/** The Desktop's default keymap in one chord family: every action's default, the CHORDS_READ ones
 * in that family (chordDefault). Built once per family at module load (DEFAULT_KEYMAPS); they
 * differ only in the Linux/Windows keys of the CHORDS_READ rows. */
function keymapIn(family) {
  const chordOf = (id) => chordDefault(CHORDS_READ.find((each) => each.id === id).does, family);
  return Object.freeze({
    // The leader (docs/desktop-keyboard.md, "The leader"): the TUI's, read from the shared keymap,
    // Ctrl+X on every platform. ⌃X on macOS fires in a terminal by name (macStructuralChord); on
    // Linux/Windows it is terminal-allowlisted, a named exception (0x18 is a byte a program reads:
    // the leader pressed twice gives it); in a text field there Cut keeps it (leaderLeftToField).
    "app.leader": { mac: chordFromKeyId(LEADER.mac), other: chordFromKeyId(LEADER.other) },
    ...Object.fromEntries(SIDEBAR_KEYS.map(({ id, does }) => [id, plainDefault(does)])),
    // The leader's Tab and Shift+Tab, as chords (CHORDS group-next, group-previous): Alt+Shift+→/←
    // in the Alt family; Ctrl+Alt+A and Ctrl+Alt+Shift+A in the others; ⌥⇧→/← on macOS.
    "split.focusPrevGroup": chordOf("split.focusPrevGroup"),
    "split.focusNextGroup": chordOf("split.focusNextGroup"),
    // The shared chords on Linux/Windows are Alt+letter by default (Alt+K, Alt+P, Alt+O): xterm sends
    // ESC then the letter for them, which the program still gets from Esc, then the letter. In the
    // Ctrl+Alt family they are Ctrl+Alt+letter (plain Ctrl+K and Ctrl+P are bytes a program reads,
    // readline's kill-line and shell history; xterm sends ESC then that byte, which the program gets
    // from Esc, then Ctrl+K). AltGr is never Alt (chordFromEvent): where a layout types a character
    // with it, the event carries that character and matches no chord (docs/desktop-keyboard.md). In
    // the Ctrl+Shift family seven of them are Ctrl+Shift+letter instead (K, P, S, M, W, E, D), which
    // xterm sends nothing for: its Ctrl+letter bytes need Shift up.
    "app.palette": chordOf("app.palette"),
    "app.quickOpenSouls": chordOf("app.quickOpenSouls"),
    "app.workspaces": chordOf("app.workspaces"),
    // The previous / next instance and the leader's z, as chords: Alt+Shift+↑/↓ in every family,
    // and Alt+Z (Ctrl+Alt+Z, Ctrl+Shift+M) on Linux/Windows; ⌘⌥↑/↓ and ⌘⌥Z on macOS.
    "roster.openPrevious": chordOf("roster.openPrevious"),
    "roster.openNext": chordOf("roster.openNext"),
    "terminal.focusMode": chordOf("terminal.focusMode"),
    // The leader's ↑ / ↓, the previous / next workspace of the sidebar's list, as chords: Alt+↑/↓ in
    // the Alt family and ⌥↑/↓ on macOS. The Ctrl+Alt and Ctrl+Shift families have none (CHORDS
    // `other: null`, `shift: null`): they leave Alt+↑/↓ to the program, and the leader reaches them.
    "workspace.previous": chordOf("workspace.previous"),
    "workspace.next": chordOf("workspace.next"),
    // The instance's name and colour (#1421): Alt+R (Ctrl+Alt+R in the other two families, not one of
    // the seven) on Linux/Windows, ⌘⌥R on macOS. The instance is the leader's
    // target (shell.mjs leaderTargetId).
    "instance.edit": chordOf("instance.edit"),
    "app.chooseSoul": { mac: "Mod+N", other: "Ctrl+Shift+N" },
    "app.shortcuts": "Mod+,",
    // No default (spec F): ⌘⇧T is "reopen closed tab" in browsers and Ctrl+Shift+T "new tab" in
    // Linux terminals. The palette keeps the command; the editor can bind one.
    "app.themeToggle": null,
    // The theme picker: the in-app counterpart of Omarchy's theme menu (Super+Ctrl+Shift+Space), without
    // Super on Linux/Windows (the window manager's) and with ⌘ for Super on macOS, without ⌃: on macOS a
    // chord holding ⌃ never fires in a terminal (matchEvent). xterm.js sends nothing for either chord.
    "app.themePicker": { mac: "Mod+Shift+Space", other: "Ctrl+Shift+Space" },
    // The font picker (the product owner's call, 2026-10-23) takes no default chord: the palette's
    // Font: choose… and the settings cog's Font… open it. A chord given in the shortcuts editor works
    // as the explicit themes' do: in a terminal, only a macOS chord with ⌘ (it is not on TERMINAL_ALLOWLIST).
    "app.fontPicker": null,
    "stage.hierarchy": "Mod+1",
    "stage.spawn": "Mod+2",
    "stage.automations": "Mod+3",
    // The Desktop's own, on both platforms (a terminal program never sees Ctrl+Tab as anything but Tab).
    "tabs.next": "Ctrl+Tab",
    "tabs.prev": "Ctrl+Shift+Tab",
    // The shared tab moves: Alt+→/← (Alt+Shift+→/← in the other two families), ⌥→/← on macOS.
    "tabs.nextPage": chordOf("tabs.nextPage"),
    "tabs.prevPage": chordOf("tabs.prevPage"),
    // ⌘⌥1–⌘⌥9 on macOS (⌘1–⌘3 are the stages; ⌃digits are control bytes a program reads);
    // Alt+1–Alt+9 elsewhere (Ctrl+Alt+1–9 in the other two families), which send ESC and the
    // digit. 9 is the last tab.
    ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`tabs.goto${i + 1}`, chordOf(`tabs.goto${i + 1}`)])),
    "tabs.close": chordOf("tabs.close"),
    // F6 / Shift+F6 cycle regions outside a terminal (mc, htop and nano read F6 in one);
    // ⌘⇧F6 / Ctrl+Shift+F6 leaves a terminal for the next region, after which F6 works.
    "focus.nextRegion": "F6",
    "focus.prevRegion": "Shift+F6",
    "focus.leaveTerminal": "Mod+Shift+F6",
    // Alt+F (Ctrl+Alt+F) / Ctrl+Shift+B on Linux/Windows: plain Ctrl+F and Ctrl+B are bytes a
    // program reads (readline's forward-char, the tmux prefix).
    "sidebar.focusFilter": chordOf("sidebar.focusFilter"),
    "sidebar.toggle": { mac: "Mod+B", other: "Ctrl+Shift+B" },
    // Alt+E splits right, Alt+Shift+E down (Ctrl+Alt+E, Ctrl+Alt+Shift+E).
    "split.vertical": chordOf("split.vertical"),
    "split.horizontal": chordOf("split.horizontal"),
    "split.close": { mac: "Mod+Alt+W", other: "Ctrl+Shift+Alt+W" },
    // The instance panel (the right-hand panel). Ctrl+Shift+I on Linux/Windows: plain Ctrl+I is
    // the Tab byte, which stays with the program.
    "panel.toggle": { mac: "Mod+I", other: "Ctrl+Shift+I" },
    // Copy the terminal's selection (#672): Ctrl+Shift+C, the Linux terminals' copy (Ctrl+C is the
    // interrupt). No macOS default: ⌘C is Edit › Copy, the menu role. xterm.js sends nothing for
    // Ctrl+Shift+C (its Ctrl+letter control bytes need Shift up), so claiming it takes nothing.
    "terminal.copySelection": { mac: null, other: "Ctrl+Shift+C" },
    "terminal.fontBigger": "Mod+=",
    "terminal.fontSmaller": "Mod+-",
    "terminal.fontReset": "Mod+0",
  });
}

/** The default keymap of each chord family (CHORD_FAMILIES), frozen. */
export const DEFAULT_KEYMAPS = Object.freeze(Object.fromEntries(CHORD_FAMILIES.map((family) => [family, keymapIn(family)])));
/** The default keymap in the default family, Alt: the one a user who never chose has. */
export const DEFAULT_KEYMAP = DEFAULT_KEYMAPS[DEFAULT_CHORD_FAMILY];

// The active chord family (CHORD_FAMILIES): the default until main's answer is set (setChordFamily).
let chordFamily = DEFAULT_CHORD_FAMILY;

/** The chord family the keymap binds now. */
export function activeChordFamily() { return chordFamily; }

/** Bind `family`'s defaults from now on (anything that is not one of CHORD_FAMILIES is the default):
 * every reader of a default follows at once, and the keymap's listeners hear of it. A user's own
 * override is untouched, and still wins over either family's default (getBinding). */
export function setChordFamily(family) {
  const next = CHORD_FAMILIES.includes(family) ? family : DEFAULT_CHORD_FAMILY;
  if (next === chordFamily) return;
  chordFamily = next;
  notifyKeymapChange();
}

/** The default keymap of `family` (the active one when none is given). */
export function defaultKeymap(family = chordFamily) {
  return DEFAULT_KEYMAPS[family] ?? DEFAULT_KEYMAP;
}

/** The default chord for an action on this platform, in `family` (the active one when none is
 * given): a string, null for none, or undefined when the keymap has no entry for the action. */
export function defaultBinding(actionId, isMac = defaultIsMac(), family = chordFamily) {
  const keymap = defaultKeymap(family);
  if (!Object.prototype.hasOwnProperty.call(keymap, actionId)) return undefined;
  const entry = keymap[actionId];
  if (entry && typeof entry === "object") return (isMac ? entry.mac : entry.other) ?? null;
  return entry ?? null;
}

// Action ids allowed to fire inside .xterm on Linux/Windows, where their
// chords would otherwise belong to the attached program. Allowlisting by
// action id (not chord) keeps the policy stable across user rebinds.
// The rule (docs/desktop-keyboard.md, principle 2): a chord fires in a terminal
// on Linux/Windows only when xterm sends nothing for it, or when what it sends is
// a byte the program still gets from a plainer key, or when it is one of the Alt family's.
// Nothing: the Ctrl+Shift+letter defaults and Ctrl+Shift+Space (xterm's Ctrl+letter and
// Ctrl+Space bytes need Shift up), Ctrl+1, Ctrl+2, Ctrl+, and the zoom chords Ctrl+= Ctrl+- Ctrl+0.
// A byte the program still gets: Ctrl+3 (ESC: Esc), Ctrl+Tab (Tab), Ctrl+Shift+Tab
// (back-tab: Shift+Tab), the Ctrl+Alt chords (Ctrl+Alt+letter, with Shift
// or without, sends ESC and the Ctrl+letter byte: Esc, then Ctrl+letter; Ctrl+Alt+digit
// ESC and the digit: Alt+digit) and Ctrl+Shift+Alt+W (ESC Ctrl+W: Esc, then Ctrl+W).
// On Windows xterm sends nothing for Ctrl+Alt+letter or digit: it reads them as AltGr.
// The Alt family (the default, the product owner's call over the rule above): Alt+letter and Alt+digit send
// ESC and the key, which the program still gets from Esc, then the key. An Alt arrow (the tab
// moves and the workspace moves, the Alt family's alone) is a byte a plainer key still sends: xterm.js
// sends it as the Ctrl arrow on Linux/Windows (CSI 1;5 A–D), so Ctrl+arrow gives the program
// exactly that (docs/desktop-keyboard.md, the collision table).
// Named exceptions, sequences no plainer key sends: Ctrl+Shift+F6, without which F6
// cannot get out of a terminal, the Alt+Shift arrows (CSI 1;4 A–D: the shared
// previous / next instance in every family, the editor groups in the Alt family, the tab moves
// in the other two), which no agent or readline binds, and app.leader, the TUI's leader Ctrl+X
// (0x18, the shell's Ctrl+X Ctrl+E and nano's exit), which the leader pressed twice gives the program.
// The chord family changes the key, never the list: the Alt family's keys are no binding in
// the other two, so they go to the program there, and the other two's keys are no binding in
// the Alt family (Ctrl+Alt+K goes to the program as ESC, then Ctrl+K). Since the list is by
// action id, each chord fires in a terminal under every family by the rule above, on whichever
// key the family gives it; the workspace moves have none in the Ctrl+Alt and Ctrl+Shift families,
// so Alt+↑/↓ (CSI 1;5 A/B) reach the program there.
// test/terminal-xterm-bytes.test.mjs runs each allowlisted default, in each family, through
// xterm's own keydown and pins exactly what it sends.
// Every plain Ctrl+letter, every other Alt key and the F-keys stay the program's, so these stay
// out: app.openFile (Ctrl+O) and focus.next/prevRegion (F6: mc, htop, nano).
export const TERMINAL_ALLOWLIST = Object.freeze([
  "app.leader", "app.palette", "app.quickOpenSouls", "app.workspaces", "app.chooseSoul", "app.themePicker", "app.shortcuts", "terminal.copySelection",
  "roster.openPrevious", "roster.openNext", "workspace.previous", "workspace.next", "terminal.focusMode", "instance.edit",
  "tabs.next", "tabs.prev", "tabs.nextPage", "tabs.prevPage", "tabs.close",
  ...Array.from({ length: 9 }, (_, i) => `tabs.goto${i + 1}`),
  "split.vertical", "split.horizontal", "split.close", "split.focusPrevGroup", "split.focusNextGroup",
  "focus.leaveTerminal",
  "sidebar.toggle", "sidebar.focusFilter", "panel.toggle",
  "stage.hierarchy", "stage.spawn", "stage.automations",
  "terminal.fontBigger", "terminal.fontSmaller", "terminal.fontReset",
]);

export const CONTEXTS = Object.freeze([
  "global", "stage:hierarchy", "stage:spawn", "roster", "tabs", "sidebar",
]);

// ---------------------------------------------------------------- registry

const actions = new Map();   // id -> { id, label, context, run, when }
let activeContexts = new Set();
const keymapListeners = new Set();

/** Register an action; returns an unregister function. Re-registering an id
 * replaces it (views re-mount). Optional `defaultChord` folds into the
 * effective keymap exactly like a DEFAULT_KEYMAP entry: user override wins,
 * an explicit editor unbind (persisted null) kills it, and getBinding /
 * findConflict / the editor all see it — view-local actions registered at
 * mount carry their defaults with the registration (contract addendum 3).
 * Optional `when()`: while it answers false the action does not exist for dispatch — its chord
 * is not matched, so the key goes where it would go without it (app.leader under a modal). */
export function registerAction({ id, label, context = "global", run, defaultChord = null, when = null }) {
  if (!id || typeof run !== "function") throw new Error("registerAction: id and run required");
  const canonical = defaultChord == null ? null : chordToString(parseChord(defaultChord));
  const action = { id, label: label || id, context, run, defaultChord: canonical, when: typeof when === "function" ? when : null };
  actions.set(id, action);
  notifyKeymapChange(); // a new default can change effective bindings
  return () => {
    if (actions.get(id) === action) { actions.delete(id); notifyKeymapChange(); }
  };
}

/** Run a registered action by id exactly as a matched chord would —
 * context-gated, so a mouse affordance can never fire an action its
 * keyboard dispatch could not (buttons and chords share ONE registered
 * run — single source of truth). Returns true when the action ran. */
export function runAction(id) {
  const action = actions.get(id);
  if (!action || !contextEligible(action.context) || !actionLive(action)) return false;
  try { action.run(); } catch { /* an action must not break its caller */ }
  return true;
}

/** Registered actions (editor rendering). */
export function listActions() {
  return [...actions.values()];
}

export function setActiveContexts(set) {
  activeContexts = new Set(set || []);
}

function contextEligible(context) {
  return context === "global" || activeContexts.has(context);
}

function actionLive(action) {
  try { return !action.when || action.when() !== false; } catch { return false; }
}

// ---------------------------------------------------------------- overrides

function readOverrides() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const obj = raw ? JSON.parse(raw) : null;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    // Sanitize: only `null` (explicit unbind) or a parseable chord string
    // survives — anything else (numbers, objects, junk strings) is discarded
    // so a corrupted/legacy payload can never reach formatChord/matchEvent.
    const clean = {};
    for (const [id, value] of Object.entries(obj)) {
      if (value === null) clean[id] = null;
      else if (typeof value === "string") {
        const canonical = chordToString(parseChord(value));
        if (canonical) clean[id] = canonical;
      }
    }
    return clean;
  } catch { return {}; }
}

function writeOverrides(overrides) {
  try {
    if (Object.keys(overrides).length) localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* storage-less */ }
}

let overrides = readOverrides();

function notifyKeymapChange() {
  for (const fn of [...keymapListeners]) { try { fn(); } catch { /* isolate listener */ } }
}

/** Effective chord string for an action (override ?? this platform's static
 * default ?? registration default), or null. An explicit persisted null (editor
 * Backspace-unbind) wins over BOTH default sources, and a DEFAULT_KEYMAP entry
 * that is null on this platform means "no default" (never the registration's). */
export function getBinding(actionId, isMac = defaultIsMac()) {
  if (Object.prototype.hasOwnProperty.call(overrides, actionId)) {
    const v = overrides[actionId];
    return v == null ? null : v; // explicit null = unbound
  }
  const fixed = defaultBinding(actionId, isMac);
  if (fixed !== undefined) return fixed;
  return actions.get(actionId)?.defaultChord ?? null;
}

/** Persist an override: chord (string or object) or null to unbind. */
export function setBinding(actionId, chordOrNull) {
  if (chordOrNull == null) {
    overrides[actionId] = null;
  } else {
    const s = chordToString(chordOrNull);
    if (!s) return;
    overrides[actionId] = s;
  }
  writeOverrides(overrides);
  notifyKeymapChange();
}

export function resetBinding(actionId) {
  if (!Object.prototype.hasOwnProperty.call(overrides, actionId)) return;
  delete overrides[actionId];
  writeOverrides(overrides);
  notifyKeymapChange();
}

export function resetAllBindings() {
  overrides = {};
  writeOverrides(overrides);
  notifyKeymapChange();
}

export function onKeymapChange(fn) {
  keymapListeners.add(fn);
  return () => keymapListeners.delete(fn);
}

// ---------------------------------------------------------------- conflicts

/** A modal dialog's own context (`spawn-dialog-local`): while the dialog is open
 * its keys are its own and it stops them, so nothing behind the modal sees them;
 * while it is closed they do nothing. Its chords collide only with each other,
 * never with a global action (Spec E: Mod+1 jumps to the Opening instruction in the
 * spawn dialog and shows Deployments everywhere else). */
const isModalContext = (context) => typeof context === "string" && context.endsWith("-dialog-local");

/** Two contexts the shell has on at once (shell.mjs updateActiveContexts): the sidebar's, while
 * focus is in the sidebar, beside the tab layer's or a stage's. A chord bound in both would run
 * only one of them, so they clash like a same-context pair. */
const SHARES_SIDEBAR = (context) => context === "tabs" || context === "roster" || (typeof context === "string" && context.startsWith("stage:"));
const onTogether = (a, b) => (a === "sidebar" && SHARES_SIDEBAR(b)) || (b === "sidebar" && SHARES_SIDEBAR(a));

/** First OTHER action whose effective binding collides with `chord` in a way
 * visible from `context` (same context, either side global, or two contexts on at
 * once, the sidebar's beside the tabs' or a stage's — except a modal dialog's own
 * context, which only its own actions share), optionally excluding one action id
 * (the one being edited). Returns the action or null. */
export function findConflict(chord, context, excludeId = null, isMac = defaultIsMac()) {
  const c = typeof chord === "string" ? parseChord(chord) : chord;
  if (!c) return null;
  for (const action of actions.values()) {
    if (action.id === excludeId) continue;
    const bound = parseChord(getBinding(action.id, isMac) || "");
    if (!bound) continue;
    if (!chordMatches(bound, resolveForCompare(c, isMac), isMac)) continue;
    if (action.context === context) return action;
    if (isModalContext(context) || isModalContext(action.context)) continue;
    if (context === "global" || action.context === "global") return action;
    if (onTogether(context, action.context)) return action;
  }
  return null;
}

/** Clashes that involve a stored rebind: pairs of actions whose effective chords
 * collide (findConflict's visibility rule) where at least one side is a user
 * override — e.g. a rebind that a new default now shares. Nothing is ever changed
 * silently; the shell marks the settings cog and its Keyboard shortcuts… item, and the editor lists them. */
export function keymapConflicts(isMac = defaultIsMac()) {
  const own = (id) => Object.prototype.hasOwnProperty.call(overrides, id);
  const out = [], seen = new Set();
  for (const action of actions.values()) {
    const chord = getBinding(action.id, isMac);
    if (!chord) continue;
    const other = findConflict(chord, action.context, action.id, isMac);
    if (!other || !(own(action.id) || own(other.id))) continue;
    const key = [action.id, other.id].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    // `own`: which of the two the user bound there. When only one is, that one runs where both
    // apply (matchEvent: an override wins over a default), and the editor says so.
    out.push({ chord, actions: [action, other], own: [own(action.id), own(other.id)] });
  }
  return out;
}

// findConflict compares two stored chords (both may use Mod); flatten one to
// the event-shaped side so chordMatches' non-mac Mod/Ctrl folding applies.
function resolveForCompare(chord, isMac) {
  if (isMac) return { ...chord };
  return { ...chord, mod: chord.mod || chord.ctrl, ctrl: false };
}

/** True for a chord with no ctrl/alt/mod modifiers (shift-only counts as
 * plain — typing produces shifted characters). Such bindings are guarded off
 * editable fields by matchEvent; the editor warns when recording one.
 * Function keys (F1–F24) never type text, so they are not plain: F6 must cycle
 * regions from a text field and from a terminal's input textarea (spec F). */
export function isPlainChord(chord) {
  const c = typeof chord === "string" ? parseChord(chord) : chord;
  return !!c && !c.mod && !c.ctrl && !c.alt && !/^f\d{1,2}$/.test(c.key);
}

// ---------------------------------------------------------------- dispatch

/** The moves between tabs, groups and workspaces: on macOS ⌥ with an arrow (CHORDS `mac`, the product
 * owner's call, 2026-10-23), which fire in a terminal by name (macStructuralChord). */
const MAC_ARROW_MOVES = new Set(["tabs.prevPage", "tabs.nextPage", "split.focusPrevGroup", "split.focusNextGroup", "workspace.previous", "workspace.next"]);
const ARROW_KEYS = new Set(["arrowleft", "arrowright", "arrowup", "arrowdown"]);

/** On macOS inside a terminal, a few non-⌘ shapes still belong to the app, by
 * action id AND chord shape (a rebind to another Ctrl chord stays the program's):
 * Ctrl+Tab / Ctrl+Shift+Tab cycling tabs (standard on macOS too; a terminal
 * program never sees Ctrl+Tab as anything but Tab), the leader's ⌃X or ⌃\\, and
 * ⌥ (⇧ or not) with an arrow for the moves of MAC_ARROW_MOVES. xterm.js would send
 * the program ESC b / ESC f for ⌥←/→ (readline's word moves, which Esc, then b or f
 * still sends), CSI 1;3 A/B for ⌥↑/↓ and CSI 1;4 for ⌥⇧ with an arrow; a user who
 * wants them back rebinds the action (docs/desktop-keyboard.md). */
function macStructuralChord(id, c) {
  if (MAC_ARROW_MOVES.has(id)) return c.alt && !c.mod && !c.ctrl && ARROW_KEYS.has(c.key);
  if (c.mod || c.alt) return false;
  if (id === "tabs.next" || id === "tabs.prev") return c.key === "tab" && c.ctrl;
  // The leader (a named exception to principle 3): ⌃ alone with `x`, as shipped, or with `\`, the
  // leader before 0.67, for whoever binds it back. A rebind to ⌘something fires by the ⌘ rule; a
  // rebind to another ⌃ chord stays the program's.
  if (id === "app.leader") return c.ctrl && !c.shift && (c.key === "x" || c.key === "\\");
  return false;
}

/** True when the event target is a field Cut works in: a textarea or a text input that is not
 * read-only, or a contenteditable. A terminal's own helper textarea is one too: the caller tells
 * terminals apart. */
function isTextField(target) {
  if (!target) return false;
  const tag = String(target.tagName || "").toUpperCase();
  if (tag === "TEXTAREA") return !target.readOnly;
  if (tag === "INPUT") return !target.readOnly && TEXT_INPUTS.has(String(target.type || "text").toLowerCase());
  return !!target.isContentEditable;
}
/** The input types whose text Chromium cuts: not a password (Cut is disabled there), a date or
 * time, or a control that holds no text. */
const TEXT_INPUTS = new Set(["text", "search", "url", "tel", "email", "number"]);

/** Whether this keydown, which presses app.leader's effective chord, is left to the focused field
 * (docs/desktop-keyboard.md, "The leader"): on Linux/Windows, while that chord is Ctrl+X with no
 * other modifier, in a text field that is not a terminal (xterm's helper textarea is one, and there
 * the leader fires), Ctrl+X stays Chromium's Cut. The rule is the chord's, not the default's: a
 * rebind to Ctrl+X follows it, a rebind to anything else does not. macOS cuts with ⌘X. */
export function leaderLeftToField(e, isMac = defaultIsMac()) {
  if (isMac || !e || e.target?.closest?.(".xterm") || !isTextField(e.target)) return false;
  const c = parseChord(getBinding("app.leader", isMac) || "");
  return !!c && (c.mod || c.ctrl) && !c.alt && !c.shift && c.key === "x";
}

/** Whether an action bound to `chord` may fire while a terminal has focus: on
 * Linux/Windows when its id is in TERMINAL_ALLOWLIST, whatever the chord; on macOS
 * when the chord holds ⌘ and not ⌃ (⌘ never reaches the pty), or is the Ctrl+Tab
 * shape of tabs.next/prev, the ⌃X or ⌃\\ shape of app.leader, or the ⌥-arrow shape of
 * a move between tabs, groups or workspaces. matchEvent applies it; the shortcuts
 * editor shows it. */
export function terminalAllows(actionId, chord, isMac = defaultIsMac()) {
  const c = typeof chord === "string" ? parseChord(chord) : chord;
  if (!c) return false;
  if (!isMac) return TERMINAL_ALLOWLIST.includes(actionId);
  return macStructuralChord(actionId, c) || (c.mod && !c.ctrl);
}

/** The action that takes `chord` while a terminal has focus, or null, as matchEvent decides it for a
 * keydown in xterm's helper textarea: one of `contexts` whose binding presses the chord (Mod is Ctrl off
 * macOS) and that terminalAllows. A plain chord (Shift+PgUp among them) never fires from that textarea,
 * so nothing takes it. Its `when` is not asked: the shortcuts editor names what a binding may take. */
export function terminalTaker(chord, contexts, isMac = defaultIsMac()) {
  const c = typeof chord === "string" ? parseChord(chord) : chord;
  if (!c || isPlainChord(c)) return null;
  for (const action of actions.values()) {
    if (!contexts.has(action.context)) continue;
    const bound = parseChord(getBinding(action.id, isMac) || "");
    if (bound && chordMatches(bound, c, isMac) && terminalAllows(action.id, c, isMac)) return action;
  }
  return null;
}

/** Match a keydown to an eligible action id, or null. Honors context scoping
 * and the terminal policy. `opts` is for tests: { isMac, insideTerminal,
 * editableTarget } — each defaults from the environment/event. */
export function matchEvent(e, opts = {}) {
  // A consumed event stays consumed: view-local handlers (hierarchy canvas,
  // roster rows, palette input) preventDefault what they own — the engine
  // must never double-dispatch it (contract addendum a). An event let through
  // (letThrough) is the focused control's, whatever it matches.
  if (e.defaultPrevented || letThroughEvents.has(e)) return null;
  const isMac = opts.isMac ?? defaultIsMac();
  const insideTerminal = opts.insideTerminal ?? !!e.target?.closest?.(".xterm");
  const evChord = chordFromEvent(e, isMac);
  if (!evChord) return null;
  // Unmodified (or shift-only) chords belong to editable fields when one has
  // focus — a plain "b" binding must not fire while typing (addendum b).
  const editable = opts.editableTarget ?? isEditableTarget(e.target);
  const plainKey = isPlainChord(evChord);
  if (plainKey && editable) return null;
  // Alt+↑ / Alt+↓ (no other modifier) open a native control's popup (opensOnAltArrow): while one has
  // focus, a default bound there (workspace.previous / workspace.next) is left to it; a user's own
  // binding of those keys still fires, as it does over a default anywhere.
  const popupKeeps = !evChord.ctrl && !evChord.mod && !evChord.shift && evChord.alt
    && (evChord.key === "arrowup" || evChord.key === "arrowdown") && opensOnAltArrow(e.target);
  // macOS: ⌥ with an arrow moves the caret in a field of text, by word with ←/→, and ⌥⇧ selects so
  // (movesCaretOnOption): while one has focus, a default bound there (the moves between tabs, groups and
  // workspaces) is left to it, as above. A terminal's own textarea is not such a field: there the chord
  // fires (macStructuralChord). Linux and Windows move by word with Ctrl+←/→, which no default takes,
  // so they need no such rule.
  const caretKeeps = isMac && !insideTerminal && evChord.alt && !evChord.ctrl && !evChord.mod
    && ARROW_KEYS.has(evChord.key) && movesCaretOnOption(e.target);

  // Two actions on one chord (a clash the editor names, keymapConflicts): the one the user bound
  // there wins over one that holds it by default, so a user's own rebinding wins over a default
  // of any chord family, row by row (docs/desktop-keyboard.md, "The chord families": a stored
  // Ctrl+Shift+K rebind keeps firing after the option makes Ctrl+Shift+K the palette's default).
  // Within each, a specific context wins over global.
  const find = (chord, only = () => true) => {
    const hits = { own: { context: null, global: null }, fixed: { context: null, global: null } };
    for (const action of actions.values()) {
      if (!only(action.id) || !contextEligible(action.context) || !actionLive(action)) continue;
      const bound = parseChord(getBinding(action.id, isMac) || "");
      if (!bound || !chordMatches(bound, chord, isMac)) continue;
      // Inside a terminal, every other chord stays with the attached program, even after
      // a custom rebind (on macOS the event's chord equals the bound one here).
      if (insideTerminal && !terminalAllows(action.id, chord, isMac)) continue;
      // The leader's Ctrl+X is Cut in a text field on Linux/Windows (leaderLeftToField).
      if (action.id === "app.leader" && !insideTerminal && leaderLeftToField(e, isMac)) continue;
      if ((popupKeeps || caretKeeps) && !hasOverride(action.id)) continue;
      const tier = hits[hasOverride(action.id) ? "own" : "fixed"];
      if (action.context === "global") tier.global = tier.global || action;
      else tier.context = tier.context || action;
    }
    return hits.own.context || hits.own.global || hits.fixed.context || hits.fixed.global;
  };
  // A rebind the shortcuts editor recorded before macOS ⌘⌥ chords were read by the physical key
  // holds the character ⌥ typed (⌘⌥O was stored as Mod+Alt+Ø): it still matches that press, and
  // first, so a default on the physical key (Mod+Alt+O) never takes it.
  const typed = typedOptionChord(e, isMac, evChord);
  const hit = (typed && find(typed, hasOverride)) || find(evChord);
  return hit ? hit.id : null;
}

/** True when the user bound `actionId` themselves (a stored override, an unbind included). Where two actions
 * hold one chord, the one the user bound wins over one that has it by default (matchEvent, resolveViewKey). */
export const hasOverride = (actionId) => Object.prototype.hasOwnProperty.call(overrides, actionId);

/** The chords a keydown presses for `actionId`'s binding: as it reads now (chordFromEvent), and,
 *  while that action holds a stored rebind, as 0.66 read a macOS ⌘⌥ press (typedOptionChord), first.
 *  Every reader of one action's binding (eventMatchesBinding, pickerCycleDirection, view-keys.mjs)
 *  asks this, so a rebind 0.66 recorded works there as in matchEvent. */
export function eventChordsFor(e, actionId, isMac = defaultIsMac()) {
  const physical = chordFromEvent(e, isMac);
  if (!physical) return [];
  const typed = hasOverride(actionId) ? typedOptionChord(e, isMac, physical) : null;
  return typed ? [typed, physical] : [physical];
}

/** A macOS ⌘⌥ or ⌃⌥ press read as the engine read it before the physical key named it: by the
 *  character ⌥ typed (`key`), or null when that is the same chord or none. */
function typedOptionChord(e, isMac, physical) {
  if (!isMac || !e.altKey || !(e.metaKey || e.ctrlKey)) return null;
  const key = baseKey(e.key);
  if (!key || key === physical.key || ["meta", "control", "alt", "altgraph", "shift"].includes(key)) return null;
  return settleChord({ key, mod: !!e.metaKey, ctrl: !!e.ctrlKey, alt: true, shift: !!e.shiftKey });
}

const letThroughEvents = new WeakSet();
/** Hand an event to the focused control: no action matches it, in any phase of dispatch
 * (the window listener or a terminal's interception). The leader pressed twice in a terminal. */
export function letThrough(e) {
  if (e && typeof e === "object") letThroughEvents.add(e);
}

/** Does the keymap take this keydown here: would `matchEvent` (same options) run an action for
 * it? For a view's own key handler: a key the keymap binds, the user's rebinds included, is the
 * keymap's, and the view gives way; a key bound to nothing stays the view's. */
export function keymapTakes(e, opts = {}) {
  return matchEvent(e, opts) !== null;
}

/** Does the event press the effective chord of `actionId` (whatever its context)? */
export function eventMatchesBinding(e, actionId, isMac = defaultIsMac()) {
  const bound = parseChord(getBinding(actionId, isMac) || "");
  return eventChordsFor(e, actionId, isMac).some((chord) => chordMatches(bound, chord, isMac));
}

/** The single shell-level keydown listener body: match, prevent, run. */
export function handleKeydown(e, opts = {}) {
  const id = matchEvent(e, opts);
  if (!id) return false;
  e.preventDefault();
  const action = actions.get(id);
  try { action.run(e); } catch { /* an action must not break dispatch */ }
  return true;
}

/** While a picker opened by `actionId` is open, its own chord moves the active
 * row down (1) and Shift + that chord moves it up (-1); anything else is 0.
 * Read from the live keymap, so a rebind follows. A chord that already holds
 * Shift (a rebind to Ctrl+Shift+K, say) has no Shift form: ArrowUp moves up
 * there. An unbound action, or a plain chord (typing belongs to the input),
 * never cycles. */
export function pickerCycleDirection(e, actionId, isMac = defaultIsMac()) {
  const bound = parseChord(getBinding(actionId, isMac) || "");
  const chords = eventChordsFor(e, actionId, isMac);
  if (!bound || !chords.length || isPlainChord(bound)) return 0;
  if (chords.some((chord) => chordMatches(bound, chord, isMac))) return 1;
  if (!bound.shift && chords.some((chord) => chordMatches({ ...bound, shift: true }, chord, isMac))) return -1;
  return 0;
}

/** The palette's own group keys on this platform (packages/client/keymap.mjs PALETTE_KEYS), as
 * chord strings: next ⌘N / Alt+Shift+↓, previous ⌥⌘N / Alt+Shift+↑. */
function paletteGroupChords(isMac) {
  return { next: chordFromKeyId(paletteKey("palette-next-group", isMac)), previous: chordFromKeyId(paletteKey("palette-previous-group", isMac)) };
}

/** While the palette is open, its next-group key moves the active row to the first selectable row
 * of the next group (1) and its previous-group key to that of the group before (-1); anything else
 * is 0. They are fixed palette keys, not bindings: no rebind reaches them, and the palette's
 * capture-phase handler takes them before the keymap engine (⌘N is app.chooseSoul, and
 * Alt+Shift+↓/↑ are roster.openNext/openPrevious, only while the palette is closed). */
export function paletteGroupDirection(e, isMac = defaultIsMac()) {
  const chord = chordFromEvent(e, isMac);
  if (!chord) return 0;
  const { next, previous } = paletteGroupChords(isMac);
  if (chordMatches(parseChord(next), chord, isMac)) return 1;
  if (chordMatches(parseChord(previous), chord, isMac)) return -1;
  return 0;
}

/** The palette's footer line naming its group keys, in the engine's own labels:
 * "⌘N next group · ⌥⌘N previous" on macOS, "Alt+Shift+↓ next group · Alt+Shift+↑ previous" elsewhere. */
export function paletteGroupHint(isMac = defaultIsMac()) {
  const { next, previous } = paletteGroupChords(isMac);
  return `${formatChord(next, isMac)} next group · ${formatChord(previous, isMac)} previous`;
}
