// Spec F, Part 3: a keymap that is sane on Linux (and Omarchy) as well as macOS.
// The rule: a default chord never takes a key a program inside the terminal reads, except the Alt
// family's (the default on Linux/Windows, the product owner's call, 2026-10-22): Alt with a letter, a digit or an
// arrow, which the program still gets from Esc, then the key. Every changed default resolves per
// platform and per chord family; inside a terminal on Linux/Windows only the allowlisted actions fire
// (chords xterm sends nothing for, or a byte a plainer key still sends, the Alt family's keys, and the
// named exceptions: test/terminal-xterm-bytes.test.mjs), and the program keeps Ctrl+W/K/\/P/B/I/F/O, F6,
// Ctrl+PgUp/PgDn and every Alt key no chord holds (Alt+digit too, in the Ctrl+Alt and Ctrl+Shift
// families, and Alt+↑/↓ there); on macOS only ⌘ chords (and Ctrl+Tab, the leader's ⌃X and the ⌥ arrows
// of the moves between tabs, groups and workspaces) fire there, so ⌃digits and F6 stay the program's.
// Chords are dispatched as the REAL events a keyboard sends (the shifted character in `key`).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import {
  CHORDS_READ, DEFAULT_KEYMAP, TERMINAL_ALLOWLIST, defaultBinding, chordFromEvent, chordToString, keymapTakes,
  setKeyboardLayoutMap, readKeyboardLayout, getBinding, formatChord, isPlainChord,
  registerAction, setActiveContexts, resetAllBindings, setBinding, matchEvent, handleKeydown, findConflict, keymapConflicts,
  eventMatchesBinding, pickerCycleDirection, paletteGroupDirection, paletteGroupHint, chordFromKeyId,
  setChordFamily, parseChord, terminalAllows, leaderLeftToField, listActions, runAction, resetBinding,
} from "../renderer/keybindings.mjs";
import { runInNewContext } from "node:vm";
import { NAV, NAV_TABS } from "../renderer/shell-nav.mjs";
import { readdirSync } from "node:fs";
import { appMenuTemplate } from "../app-menu.mjs";
import { CHORDS, CHORD_FAMILIES, DEFAULT_CHORD_FAMILY, PALETTE_KEYS, paletteKey } from "../../client/keymap.mjs";
import { resolveViewKey } from "../renderer/view-keys.mjs";
import { terminalKeyDecision } from "../renderer/terminal-tab.mjs";
import { copyTerminalSelection } from "../renderer/terminal-clipboard.mjs";

const map = new Map();
globalThis.localStorage = { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) };

const ev = (key, mods = {}) => ({
  key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false,
  preventDefault() { this.defaultPrevented = true; }, ...mods,
});
// What Linux/Windows sends for Ctrl(+Shift)(+Alt)+key: with Shift, `key` is the shifted character.
const linux = (key, mods = {}) => ev(key, { ctrlKey: true, ...mods });

// Every action the shell registers with a default, in its context (tabs actions live in "tabs", the
// sidebar's plain keys in "sidebar").
const IDS = Object.keys(DEFAULT_KEYMAP);
const contextOf = id => (/^(tabs|split)\./.test(id) ? "tabs" : /^sidebar\.key\./.test(id) ? "sidebar" : "global");
function registerAll(t) {
  resetAllBindings();
  const offs = IDS.map(id => registerAction({ id, label: id, context: contextOf(id), run: () => {} }));
  setActiveContexts(new Set(["tabs"]));
  t.after(() => { offs.forEach(off => off()); setActiveContexts(new Set()); resetAllBindings(); });
}
/** Bind `family`'s defaults for the rest of the test; the default family, Alt, again after it. */
function inFamily(t, family) {
  setChordFamily(family);
  t.after(() => setChordFamily(DEFAULT_CHORD_FAMILY));
}
/** The keydown Linux/Windows sends for a stored chord string ("Alt+Shift+←", "Ctrl+Alt+K"): with
 * Shift, a letter's `key` is the upper-case letter. */
function pressOf(chord, mods = {}) {
  const c = parseChord(chord);
  const named = { arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight" }[c.key];
  const key = named ?? (c.shift && /^[a-z]$/.test(c.key) ? c.key.toUpperCase() : c.key);
  return ev(key, { ctrlKey: c.mod || c.ctrl, altKey: c.alt, shiftKey: c.shift, ...mods });
}

test("the shipped table: each changed default resolves per platform and per chord family", () => {
  assert.equal(DEFAULT_CHORD_FAMILY, "alt", "Alt is the default family on Linux/Windows");
  assert.deepEqual(CHORD_FAMILIES, ["alt", "ctrl+alt", "ctrl+shift"]);
  // [macOS, Alt (the default), Ctrl+Alt, Ctrl+Shift]: one string for the three when they agree.
  const table = {
    "app.palette": ["Mod+K", "Alt+K", "Ctrl+Alt+K", "Ctrl+Shift+K"],
    "app.quickOpenSouls": ["Mod+P", "Alt+P", "Ctrl+Alt+P", "Ctrl+Shift+P"],
    "app.workspaces": ["Mod+Alt+O", "Alt+O", "Ctrl+Alt+O", "Ctrl+Shift+S"],
    "app.chooseSoul": ["Mod+N", "Ctrl+Shift+N"],
    "roster.openPrevious": ["Mod+Alt+↑", "Alt+Shift+↑"], "roster.openNext": ["Mod+Alt+↓", "Alt+Shift+↓"],
    // New with the Alt family: the leader's ↑ / ↓ as chords, Alt+↑/↓ in the Alt family alone (the other
    // two leave them to the program, #1491 B1), ⌥↑/↓ on macOS.
    "workspace.previous": ["Alt+↑", "Alt+↑", null, null], "workspace.next": ["Alt+↓", "Alt+↓", null, null],
    "terminal.focusMode": ["Mod+Alt+Z", "Alt+Z", "Ctrl+Alt+Z", "Ctrl+Shift+M"],
    "instance.edit": ["Mod+Alt+R", "Alt+R", "Ctrl+Alt+R", "Ctrl+Alt+R"],
    "tabs.close": ["Mod+W", "Alt+W", "Ctrl+Alt+W", "Ctrl+Shift+W"],
    "tabs.next": ["Ctrl+Tab", "Ctrl+Tab"], "tabs.prev": ["Ctrl+Shift+Tab", "Ctrl+Shift+Tab"],
    "tabs.nextPage": ["Alt+→", "Alt+→", "Alt+Shift+→", "Alt+Shift+→"], "tabs.prevPage": ["Alt+←", "Alt+←", "Alt+Shift+←", "Alt+Shift+←"],
    "tabs.goto1": ["Mod+Alt+1", "Alt+1", "Ctrl+Alt+1", "Ctrl+Alt+1"], "tabs.goto9": ["Mod+Alt+9", "Alt+9", "Ctrl+Alt+9", "Ctrl+Alt+9"],
    "split.vertical": ["Mod+\\", "Alt+E", "Ctrl+Alt+E", "Ctrl+Shift+E"], "split.horizontal": ["Mod+Shift+\\", "Alt+Shift+E", "Ctrl+Alt+Shift+E", "Ctrl+Shift+D"],
    "split.close": ["Mod+Alt+W", "Ctrl+Shift+Alt+W"],
    // The leader's Shift+Tab and Tab as chords: Alt+Shift+←/→ in the Alt family and ⌥⇧←/→ on macOS.
    "split.focusPrevGroup": ["Alt+Shift+←", "Alt+Shift+←", "Ctrl+Alt+Shift+A", "Ctrl+Alt+Shift+A"],
    "split.focusNextGroup": ["Alt+Shift+→", "Alt+Shift+→", "Ctrl+Alt+A", "Ctrl+Alt+A"],
    "stage.hierarchy": ["Mod+1", "Mod+1"], "stage.spawn": ["Mod+2", "Mod+2"], "stage.automations": ["Mod+3", "Mod+3"],
    "focus.nextRegion": ["F6", "F6"], "focus.prevRegion": ["Shift+F6", "Shift+F6"],
    "focus.leaveTerminal": ["Mod+Shift+F6", "Mod+Shift+F6"],
    "sidebar.toggle": ["Mod+B", "Ctrl+Shift+B"], "sidebar.focusFilter": ["Mod+F", "Alt+F", "Ctrl+Alt+F", "Ctrl+Alt+F"], "panel.toggle": ["Mod+I", "Ctrl+Shift+I"],
    "app.themeToggle": [null, null], "app.themePicker": ["Mod+Shift+Space", "Ctrl+Shift+Space"], "app.shortcuts": ["Mod+,", "Mod+,"],
    "app.fontPicker": [null, null],
    "terminal.fontBigger": ["Mod+=", "Mod+="], "terminal.fontSmaller": ["Mod+-", "Mod+-"], "terminal.fontReset": ["Mod+0", "Mod+0"],
    "terminal.copySelection": [null, "Ctrl+Shift+C"],
  };
  for (const [id, [mac, ...others]] of Object.entries(table)) {
    for (const family of CHORD_FAMILIES) {
      assert.equal(defaultBinding(id, true, family), mac, `${id} on macOS (${family}: macOS has no family)`);
      const other = others.length === 1 ? others[0] : others[CHORD_FAMILIES.indexOf(family)];
      assert.equal(defaultBinding(id, false, family), other, `${id} on Linux/Windows, ${family}`);
    }
    // With no family given: the active one, the default until keys.json says otherwise.
    assert.equal(defaultBinding(id, false), others[0], `${id} on Linux/Windows, the default family`);
  }
  // Shown as each platform reads it (the shortcuts editor and the hints use getBinding + formatChord).
  assert.equal(formatChord(getBinding("app.palette", false), false), "Alt+K");
  assert.equal(formatChord(getBinding("app.quickOpenSouls", false), false), "Alt+P");
  assert.equal(formatChord(getBinding("app.quickOpenSouls", true), true), "⌘P");
  assert.equal(formatChord(getBinding("tabs.nextPage", false), false), "Alt+→");
  assert.equal(formatChord(getBinding("tabs.nextPage", true), true), "⌥→");
  assert.equal(formatChord(getBinding("workspace.previous", false), false), "Alt+↑");
  assert.equal(formatChord(getBinding("workspace.previous", true), true), "⌥↑");
  assert.equal(formatChord(getBinding("split.focusPrevGroup", false), false), "Alt+Shift+←");
  assert.equal(formatChord(getBinding("split.focusPrevGroup", true), true), "⌥⇧←");
  assert.equal(formatChord(getBinding("roster.openPrevious", true), true), "⌥⌘↑");
  assert.equal(formatChord(getBinding("split.horizontal", false), false), "Alt+Shift+E");
  assert.equal(formatChord(getBinding("tabs.goto3", false), false), "Alt+3");
  assert.equal(formatChord(getBinding("tabs.goto3", true), true), "⌥⌘3");
  assert.equal(formatChord(getBinding("focus.leaveTerminal", false), false), "Ctrl+Shift+F6");
  assert.equal(formatChord(getBinding("sidebar.toggle", false), false), "Ctrl+Shift+B");
  assert.equal(formatChord(getBinding("sidebar.toggle", true), true), "⌘B");
});

test("the Ctrl+Alt family, an explicit choice: its keys as the shortcuts editor and the hints show them", t => {
  inFamily(t, "ctrl+alt");
  assert.equal(formatChord(getBinding("app.palette", false), false), "Ctrl+Alt+K");
  assert.equal(formatChord(getBinding("app.quickOpenSouls", false), false), "Ctrl+Alt+P");
  assert.equal(formatChord(getBinding("tabs.nextPage", false), false), "Alt+Shift+→");
  assert.equal(formatChord(getBinding("split.horizontal", false), false), "Ctrl+Alt+Shift+E");
  assert.equal(formatChord(getBinding("split.focusPrevGroup", false), false), "Ctrl+Alt+Shift+A");
  assert.equal(formatChord(getBinding("tabs.goto3", false), false), "Ctrl+Alt+3");
  assert.equal(getBinding("workspace.next", false), null, "no workspace move: Alt+↑/↓ are the program's (#1491 B1)");
});

test("nothing binds Super/Meta on Linux/Windows: Mod is Ctrl there", () => {
  for (const id of IDS) {
    const chord = defaultBinding(id, false);
    if (chord) assert.doesNotMatch(chord, /\b(Meta|Cmd|Super)\b/, id);
  }
});

test("the terminal allowlist is exactly the actions that must work in a terminal", () => {
  assert.deepEqual([...TERMINAL_ALLOWLIST].sort(), [
    "app.chooseSoul", "app.leader", "app.newAgent", "app.palette", "app.quickOpenSouls", "app.shortcuts", "app.themePicker", "app.workspaces", "focus.leaveTerminal",
    "instance.edit", "panel.toggle", "roster.openNext", "roster.openPrevious", "sidebar.focusFilter", "sidebar.toggle",
    "split.close", "split.focusNextGroup", "split.focusPrevGroup", "split.horizontal", "split.vertical",
    "stage.automations", "stage.hierarchy", "stage.spawn",
    "tabs.close", "tabs.next", "tabs.nextPage", "tabs.prev", "tabs.prevPage",
    ...Array.from({ length: 9 }, (_, i) => `tabs.goto${i + 1}`),
    "terminal.copySelection", "terminal.fontBigger", "terminal.fontReset", "terminal.fontSmaller", "terminal.focusMode",
    "workspace.next", "workspace.previous",
  ].sort());
  // Every shared chord works in a terminal (CHORDS_READ): the leader's keys are reachable from every focus.
  for (const { id } of CHORDS_READ) assert.ok(TERMINAL_ALLOWLIST.includes(id), `${id} is allowlisted`);
  // No allowlisted default on Linux/Windows, in any family, is a plain Ctrl+letter, a bare function
  // key or Ctrl+PgUp/PgDn. The one named exception, the leader's Ctrl+Space (NUL, which the leader
  // pressed twice gives the program; D18).
  for (const family of CHORD_FAMILIES) for (const id of TERMINAL_ALLOWLIST) {
    const chord = defaultBinding(id, false, family);
    if (id === "app.leader") { assert.equal(chord, "Ctrl+Space"); continue; }
    // The workspace moves have no key outside the Alt family: Alt+↑/↓ are left to the program there.
    if (chord === null) { assert.ok(family !== "alt" && ["workspace.previous", "workspace.next"].includes(id), `${id} has no key, ${family}`); continue; }
    assert.doesNotMatch(chord, /^(Mod|Ctrl)\+[A-Za-z\\]$|^(Shift\+)?F\d+$|^Ctrl\+Page(Up|Down)$/, `${id}: ${chord}, ${family}`);
    if (!/^Alt\+/.test(chord)) continue;
    // A chord of Alt without Ctrl, a key a program reads (ESC and the key, or an Alt arrow's own
    // sequence). In the Alt family it is one of the shared chords (CHORDS_READ), the family's own keys,
    // which the program still gets from Esc, then the key. In the other two only the Alt+Shift arrows;
    // Alt+digit, Alt+letter and the Alt arrows stay the program's.
    // New agent's Alt+N (the Desktop UI rework, decided 2026-11-19) is the one Alt family key the Desktop holds alone
    // until the TUI takes it; readline's and zsh's history search forward still get ESC n from Esc, then n.
    if (family === "alt") assert.ok(CHORDS_READ.some((read) => read.id === id) || id === "app.newAgent", `${id}: ${chord} is a shared chord of the Alt family`);
    else assert.match(chord, /^Alt\+Shift\+[←→↑↓]$/, `${id}: ${chord}, ${family}`);
  }
});

// The allowlisted chords each family gives a key of its own, as Linux/Windows sends them.
const ctrlAltPresses = [
  [linux("k", { altKey: true }), "app.palette"], [linux("p", { altKey: true }), "app.quickOpenSouls"], [linux("o", { altKey: true }), "app.workspaces"],
  [linux("w", { altKey: true }), "tabs.close"], [linux("e", { altKey: true }), "split.vertical"], [linux("E", { altKey: true, shiftKey: true }), "split.horizontal"],
  [linux("A", { altKey: true, shiftKey: true }), "split.focusPrevGroup"], [linux("a", { altKey: true }), "split.focusNextGroup"],
  [linux("z", { altKey: true }), "terminal.focusMode"], [linux("r", { altKey: true }), "instance.edit"], [linux("f", { altKey: true }), "sidebar.focusFilter"],
  [linux("n", { altKey: true }), "app.newAgent"],
  ...Array.from({ length: 9 }, (_, i) => [linux(`${i + 1}`, { altKey: true }), `tabs.goto${i + 1}`]),
  // The Alt+Shift arrows: the tab moves.
  [ev("ArrowLeft", { altKey: true, shiftKey: true }), "tabs.prevPage"], [ev("ArrowRight", { altKey: true, shiftKey: true }), "tabs.nextPage"],
];
const FAMILY_PRESSES = {
  // Alt with a letter or a digit (no Ctrl), Alt with ←/→ for the tab moves, Alt+Shift with ←/→ for the groups.
  alt: [
    [ev("k", { altKey: true }), "app.palette"], [ev("p", { altKey: true }), "app.quickOpenSouls"], [ev("o", { altKey: true }), "app.workspaces"],
    [ev("w", { altKey: true }), "tabs.close"], [ev("e", { altKey: true }), "split.vertical"], [ev("E", { altKey: true, shiftKey: true }), "split.horizontal"],
    [ev("ArrowLeft", { altKey: true, shiftKey: true }), "split.focusPrevGroup"], [ev("ArrowRight", { altKey: true, shiftKey: true }), "split.focusNextGroup"],
    [ev("z", { altKey: true }), "terminal.focusMode"], [ev("r", { altKey: true }), "instance.edit"], [ev("f", { altKey: true }), "sidebar.focusFilter"],
    [ev("n", { altKey: true }), "app.newAgent"],
    ...Array.from({ length: 9 }, (_, i) => [ev(`${i + 1}`, { altKey: true }), `tabs.goto${i + 1}`]),
    [ev("ArrowLeft", { altKey: true }), "tabs.prevPage"], [ev("ArrowRight", { altKey: true }), "tabs.nextPage"],
    // The leader's ↑ / ↓, the Alt family's alone.
    [ev("ArrowUp", { altKey: true }), "workspace.previous"], [ev("ArrowDown", { altKey: true }), "workspace.next"],
  ],
  "ctrl+alt": ctrlAltPresses,
  // The seven move to Ctrl+Shift+letter (e.key is the upper-case letter with Shift); the others keep their Ctrl+Alt key.
  "ctrl+shift": [
    [linux("K", { shiftKey: true }), "app.palette"], [linux("P", { shiftKey: true }), "app.quickOpenSouls"], [linux("S", { shiftKey: true }), "app.workspaces"],
    [linux("M", { shiftKey: true }), "terminal.focusMode"], [linux("W", { shiftKey: true }), "tabs.close"],
    [linux("E", { shiftKey: true }), "split.vertical"], [linux("D", { shiftKey: true }), "split.horizontal"],
    ...ctrlAltPresses.filter(([, id]) => !["app.palette", "app.quickOpenSouls", "app.workspaces", "terminal.focusMode", "tabs.close", "split.vertical", "split.horizontal"].includes(id)),
  ],
};
// The same key in every family.
const SHARED_PRESSES = [
  [linux("N", { shiftKey: true }), "app.chooseSoul"], [linux("Tab"), "tabs.next"], [linux("Tab", { shiftKey: true }), "tabs.prev"],
  [linux("W", { shiftKey: true, altKey: true }), "split.close"], [linux(" ", { code: "Space" }), "app.leader"],
  // The Alt+Shift arrows (no Ctrl) ↑ / ↓: the previous / next instance.
  [ev("ArrowUp", { altKey: true, shiftKey: true }), "roster.openPrevious"], [ev("ArrowDown", { altKey: true, shiftKey: true }), "roster.openNext"],
  [linux("F6", { shiftKey: true }), "focus.leaveTerminal"], [linux("C", { shiftKey: true }), "terminal.copySelection"],
  // Allowlisted with this keymap: the moved defaults (e.key is the upper-case letter with Shift),
  // the stages (Ctrl+3 is ESC, which Esc still sends), the shortcuts editor and the zoom chords.
  [linux("B", { shiftKey: true }), "sidebar.toggle"], [linux("I", { shiftKey: true }), "panel.toggle"],
  [linux("1"), "stage.hierarchy"], [linux("2"), "stage.spawn"], [linux("3"), "stage.automations"],
  [linux(","), "app.shortcuts"], [linux(" ", { code: "Space", shiftKey: true }), "app.themePicker"],
  [linux("="), "terminal.fontBigger"], [linux("-"), "terminal.fontSmaller"], [linux("0"), "terminal.fontReset"],
];

for (const family of CHORD_FAMILIES) {
  test(`Linux/Windows inside a terminal: the allowlisted chords fire from real (shifted) events (${family})`, t => {
    registerAll(t);
    inFamily(t, family);
    const inTerm = { isMac: false, insideTerminal: true };
    const presses = [...FAMILY_PRESSES[family], ...SHARED_PRESSES];
    // Every allowlisted action with a Linux/Windows default is pressed here (the workspace moves have
    // none outside the Alt family).
    for (const id of TERMINAL_ALLOWLIST) {
      if (defaultBinding(id, false) === null) { assert.ok(family !== "alt" && /^workspace\./.test(id), `${id} has a default (${family})`); continue; }
      assert.ok(presses.some(([, each]) => each === id), `${id} is pressed (${family})`);
    }
    for (const [event, id] of presses) {
      assert.equal(matchEvent(event, inTerm), id, `${JSON.stringify({ key: event.key, ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey })}, ${family}`);
      const claimed = ev(event.key, event); handleKeydown(claimed, inTerm);
      assert.equal(claimed.defaultPrevented, true, `${id} is claimed before the pty (${family})`);
    }
    // The instance's name and colour has no Shift variant: Alt+Shift+R and Ctrl+Alt+Shift+R are the program's.
    assert.equal(matchEvent(ev("R", { altKey: true, shiftKey: true }), inTerm), null, `Alt+Shift+R is no chord (${family})`);
    assert.equal(matchEvent(linux("R", { altKey: true, shiftKey: true }), inTerm), null, `Ctrl+Alt+Shift+R is no chord (${family})`);
  });
}

test("Linux/Windows inside a terminal: Ctrl+W/K/\\/P/B, F6, Ctrl+PgUp/PgDn and every Alt key no chord holds reach the program (never preventDefault'ed)", t => {
  registerAll(t);
  inFamily(t, DEFAULT_CHORD_FAMILY);
  const inTerm = { isMac: false, insideTerminal: true };
  const reachesProgram = (name, event) => {
    assert.equal(matchEvent(event, inTerm), null, name);
    assert.equal(handleKeydown(event, inTerm), false); assert.equal(event.defaultPrevented, false, `${name} is the program's`);
  };
  // In every family: the plain Ctrl+letters, F6, Ctrl+PgUp/PgDn, and the Alt keys of readline and the
  // agents that no table holds (M-b and M-d, the word moves and kill; M-. the last argument; M-t transpose).
  const everyFamily = () => [
    ...["w", "k", "\\", "p", "b", "n", "e", "o", "f", "i"].map(key => [`Ctrl+${key}`, linux(key)]),
    ["F6 (mc, htop, nano)", ev("F6")], ["Shift+F6", ev("F6", { shiftKey: true })],
    ["Ctrl+PgDn (vim, weechat)", linux("PageDown")], ["Ctrl+PgUp", linux("PageUp")],
    ["Alt+B (readline backward-word)", ev("b", { altKey: true })], ["Alt+D (readline kill-word)", ev("d", { altKey: true })],
    ["Alt+. (readline yank-last-arg)", ev(".", { altKey: true })], ["Alt+T (readline transpose-words)", ev("t", { altKey: true })],
  ];
  for (const family of CHORD_FAMILIES) {
    setChordFamily(family);
    for (const [name, event] of everyFamily()) reachesProgram(`${name}, ${family}`, event);
  }
  // The Alt family takes Alt+1..9 (go to tab N) and Alt+O, Alt+K, Alt+←/→; their Ctrl+Alt keys are the program's there.
  setChordFamily("alt");
  for (let n = 1; n <= 9; n++) assert.equal(matchEvent(ev(`${n}`, { altKey: true }), inTerm), `tabs.goto${n}`, `Alt+${n} is the Alt family's`);
  for (const [name, event] of [["Ctrl+Alt+1", linux("1", { altKey: true })], ["Ctrl+Alt+9", linux("9", { altKey: true })],
    ["Ctrl+Alt+K", linux("k", { altKey: true })], ["Ctrl+Alt+O", linux("o", { altKey: true })]]) reachesProgram(`${name}, alt`, event);
  // The other two leave Alt+digit to the program (readline's numeric argument), and Alt with a letter.
  for (const family of ["ctrl+alt", "ctrl+shift"]) {
    setChordFamily(family);
    for (const [name, event] of [
      ["Alt+1 (readline numeric argument)", ev("1", { altKey: true })], ["Alt+9", ev("9", { altKey: true })],
      ["Alt+O (ESC o; the leader before 0.67)", ev("o", { altKey: true })], ["Alt+K", ev("k", { altKey: true })],
      ["Alt+P (an agent's model picker)", ev("p", { altKey: true })], ["Alt+←", ev("ArrowLeft", { altKey: true })], ["Alt+→", ev("ArrowRight", { altKey: true })],
      // #1491 B1: these families leave Alt+↑/↓ to the program (xterm.js sends them as Ctrl+↑/↓'s CSI 1;5 A/B).
      ["Alt+↑", ev("ArrowUp", { altKey: true })], ["Alt+↓", ev("ArrowDown", { altKey: true })],
    ]) reachesProgram(`${name}, ${family}`, event);
  }
  setChordFamily(DEFAULT_CHORD_FAMILY);
  // Outside the terminal F6 is the app's and Ctrl+PgUp/PgDn are bound to nothing; go to tab is Alt+digit
  // in the Alt family and Ctrl+Alt+digit in the other two, whose Alt+digit is bound to nothing.
  const out = { isMac: false, insideTerminal: false };
  assert.equal(matchEvent(ev("F6"), out), "focus.nextRegion");
  assert.equal(matchEvent(linux("PageDown"), out), null);
  assert.equal(matchEvent(ev("3", { altKey: true }), out), "tabs.goto3");
  assert.equal(matchEvent(linux("3", { altKey: true }), out), null);
  setChordFamily("ctrl+alt");
  assert.equal(matchEvent(ev("3", { altKey: true }), out), null);
  assert.equal(matchEvent(linux("3", { altKey: true }), out), "tabs.goto3");
  setChordFamily(DEFAULT_CHORD_FAMILY);
  // Ctrl+Shift+\ (the shifted "|") is not claimed on Linux either.
  assert.equal(matchEvent(linux("|", { shiftKey: true }), inTerm), null);
  // Actions that are not allowlisted never fire inside, even on their own chord: Open file
  // (Ctrl+O, a view's registration default) and F6.
  t.after(registerAction({ id: "app.openFile", label: "Open file", context: "global", defaultChord: "Mod+O", run: () => {} }));
  for (const [event, id] of [
    [linux("o"), "app.openFile"], [ev("F6"), "focus.nextRegion"],
  ]) {
    assert.equal(matchEvent(event, inTerm), null, id);
    assert.equal(matchEvent(event, { isMac: false, insideTerminal: false }), id, `${id} still works outside the terminal`);
  }
  // The moved defaults left their plain chords to the program everywhere: Ctrl+B, Ctrl+I and
  // Ctrl+F run nothing on Linux/Windows, inside a terminal or out.
  for (const key of ["b", "i", "f"]) {
    assert.equal(matchEvent(linux(key), { isMac: false, insideTerminal: false }), null, `Ctrl+${key} outside`);
  }
  // Ctrl+Shift+= arrives as "+" with Shift held; KEY_ALIASES folds "+" into "=", and the Shift keeps it
  // from matching Ctrl+= (today's behaviour). Numpad plus (no Shift) is Ctrl+= and zooms, in a terminal too.
  assert.equal(matchEvent(linux("+", { shiftKey: true }), inTerm), null, "Ctrl+Shift+= is not the zoom chord");
  assert.equal(matchEvent(linux("+", { code: "NumpadAdd" }), inTerm), "terminal.fontBigger", "numpad Ctrl++ zooms");
});

test("Linux/Windows outside a terminal: the old plain chords no longer run the changed actions", t => {
  registerAll(t);
  const out = { isMac: false, insideTerminal: false };
  assert.equal(matchEvent(linux("k"), out), null, "Ctrl+K was the palette");
  assert.equal(matchEvent(linux("p"), out), null, "Ctrl+P was Quick Open");
  assert.equal(matchEvent(linux("w"), out), null, "Ctrl+W was close tab");
  assert.equal(matchEvent(linux("\\"), out), null, "Ctrl+\\ was split right");
  assert.equal(matchEvent(linux("n"), out), null, "Ctrl+N was spawn instance");
  assert.equal(matchEvent(linux("T", { shiftKey: true }), out), null, "the theme cycle has no default");
  assert.equal(matchEvent(linux("3"), out), "stage.automations");
});

test("macOS inside a terminal: ⌘ chords fire (they never reach the pty), plus Ctrl+Tab and the ⌥ arrow moves; ⌃digits and F6 are the program's", t => {
  registerAll(t);
  const inTerm = { isMac: true, insideTerminal: true };
  for (const [event, id] of [
    [ev("b", { metaKey: true }), "sidebar.toggle"], [ev("i", { metaKey: true }), "panel.toggle"], [ev("f", { metaKey: true }), "sidebar.focusFilter"],
    [ev("k", { metaKey: true }), "app.palette"], [ev("p", { metaKey: true }), "app.quickOpenSouls"], [ev("w", { metaKey: true }), "tabs.close"],
    [ev("|", { metaKey: true, shiftKey: true }), "split.horizontal"], [ev("\\", { metaKey: true }), "split.vertical"],
    // ⌘⌥ with a letter or digit, as a Mac reports it: `key` is what ⌥ types (⌥3 is £), `code` the key.
    [ev("£", { code: "Digit3", metaKey: true, altKey: true }), "tabs.goto3"], [ev("Tab", { ctrlKey: true }), "tabs.next"],
    [ev("F6", { metaKey: true, shiftKey: true }), "focus.leaveTerminal"], [ev("3", { metaKey: true }), "stage.automations"],
    // The shared ⌘⌥ rows: the instance moves, the leader's z and the workspace switcher.
    [ev("ArrowUp", { metaKey: true, altKey: true }), "roster.openPrevious"], [ev("ArrowDown", { metaKey: true, altKey: true }), "roster.openNext"],
    [ev("ø", { code: "KeyO", metaKey: true, altKey: true }), "app.workspaces"], [ev("Ω", { code: "KeyZ", metaKey: true, altKey: true }), "terminal.focusMode"],
    [ev("∑", { code: "KeyW", metaKey: true, altKey: true }), "split.close"],
    // ⌥ with an arrow, by name (the product owner's call, 2026-10-23): the tabs, the groups (with ⇧) and the workspaces.
    [ev("ArrowLeft", { altKey: true }), "tabs.prevPage"], [ev("ArrowRight", { altKey: true }), "tabs.nextPage"],
    [ev("ArrowLeft", { altKey: true, shiftKey: true }), "split.focusPrevGroup"], [ev("ArrowRight", { altKey: true, shiftKey: true }), "split.focusNextGroup"],
    [ev("ArrowUp", { altKey: true }), "workspace.previous"], [ev("ArrowDown", { altKey: true }), "workspace.next"],
    [ev("¡", { code: "Digit1", metaKey: true, altKey: true }), "tabs.goto1"],
    [ev("®", { code: "KeyR", metaKey: true, altKey: true }), "instance.edit"],
  ]) assert.equal(matchEvent(event, inTerm), id, id);
  // ⌃3 is ESC, ⌃4–⌃7 FS/GS/RS/US, ⌃8 DEL, ⌃6 vim's alternate file; F6 is mc's/htop's/nano's. The old
  // ⌥⌘←/→ and ⌥⌘A are bound to nothing now (one key a row), and ⌥⇧↑/↓ to nothing on macOS.
  for (const [name, event] of [["⌃3", ev("3", { ctrlKey: true })], ["⌃6", ev("6", { ctrlKey: true })], ["F6", ev("F6")], ["⇧F6", ev("F6", { shiftKey: true })],
    ["⌥⌘←", ev("ArrowLeft", { metaKey: true, altKey: true })], ["⌥⌘→", ev("ArrowRight", { metaKey: true, altKey: true })],
    ["⌥⌘A", ev("å", { code: "KeyA", metaKey: true, altKey: true })], ["⌥⇧↑", ev("ArrowUp", { altKey: true, shiftKey: true })]]) {
    assert.equal(matchEvent(event, inTerm), null, name);
    assert.equal(handleKeydown(event, inTerm), false); assert.equal(event.defaultPrevented, false, `${name} reaches the pty`);
  }
  assert.equal(matchEvent(ev("F6"), { isMac: true, insideTerminal: false }), "focus.nextRegion", "F6 cycles outside a terminal");
  // The one structural exemption follows the action AND its shape: a rebind to a Ctrl letter stays the program's.
  setBinding("tabs.next", "Ctrl+G");
  assert.equal(matchEvent(ev("g", { ctrlKey: true }), inTerm), null);
  assert.equal(matchEvent(ev("g", { ctrlKey: true }), { isMac: true, insideTerminal: false }), "tabs.next");
  setBinding("tabs.goto1", "Ctrl+1");
  assert.equal(matchEvent(ev("1", { ctrlKey: true }), inTerm), null, "a ⌃digit rebind never fires in a terminal");
  // The ⌥ arrows follow the action AND the shape too (terminalAllows, which the shortcuts editor reads):
  // a move rebound to another ⌥ arrow still fires there; to ⌥ with a letter, or ⌃⌥ with an arrow, it is
  // the program's; and no other action fires on a plain ⌥ arrow in a terminal.
  assert.equal(terminalAllows("tabs.prevPage", "Alt+←", true), true);
  assert.equal(terminalAllows("workspace.next", "Alt+Shift+↓", true), true);
  assert.equal(terminalAllows("tabs.prevPage", "Alt+B", true), false);
  assert.equal(terminalAllows("tabs.prevPage", "Ctrl+Alt+←", true), false);
  assert.equal(terminalAllows("roster.openPrevious", "Alt+↑", true), false, "the instance moves keep ⌥⌘↑/↓");
  setBinding("tabs.prevPage", "Alt+↑"); setBinding("workspace.previous", null);
  assert.equal(matchEvent(ev("ArrowUp", { altKey: true }), inTerm), "tabs.prevPage", "a move on another ⌥ arrow");
  setBinding("roster.openPrevious", "Alt+←");
  assert.equal(matchEvent(ev("ArrowLeft", { altKey: true }), inTerm), null, "another action on ⌥← stays the program's in a terminal");
  assert.equal(matchEvent(ev("ArrowLeft", { altKey: true }), { isMac: true, insideTerminal: false }), "roster.openPrevious", "and fires outside it");
});

test("a stored override survives the new defaults and wins on every platform", t => {
  registerAll(t);
  setBinding("app.palette", "Ctrl+K");
  assert.equal(getBinding("app.palette", false), "Ctrl+K");
  // The palette's terminal reach follows the action id, so the user's choice keeps working there.
  assert.equal(matchEvent(linux("k"), { isMac: false, insideTerminal: true }), "app.palette");
  setBinding("app.themeToggle", "Mod+Shift+T");
  assert.equal(matchEvent(linux("T", { shiftKey: true }), { isMac: false, insideTerminal: false }), "app.themeToggle");
});

test("shell wiring: the new actions are registered, rebindable and discoverable", () => {
  const src = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
  for (const id of ["tabs.nextPage", "tabs.prevPage", "focus.nextRegion", "focus.prevRegion", "focus.leaveTerminal", "terminal.copySelection"]) assert.match(src, new RegExp(`id: "${id.replace(".", "\\.")}"`), id);
  assert.match(src, /id: `tabs\.goto\$\{n\}`/, "go to tab 1–9");
  assert.match(src, /\[\.\.\.NAV, \.\.\.NAV_TABS\]\.forEach\(\(v\) => registerAction\(\{\n  id: `stage\.\$\{v\.name\}`/, "stage.automations comes from the nav manifest (NAV), stage.hierarchy from NAV_TABS");
});

// Machines, the Deployments page of before, is a tab of the Workspace page and Automations a page of its own again
// (the product owner, 2026-10-26); neither action moved: the shipped registration, run as shipped, still makes
// stage.hierarchy (from NAV_TABS) a global, rebindable action on Mod+1 with its label, and stage.automations (from
// NAV) Mod+3; each opens its name (showStage routes Machines to the Workspace page's tab).
test("stage.hierarchy: registered from NAV_TABS as shipped, \"View: Workspace › Machines\", Ctrl+1 / ⌘1, rebindable; stage.automations from NAV, Ctrl+3 / ⌘3", t => {
  resetAllBindings();
  const src = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
  const statement = src.match(/\[\.\.\.NAV, \.\.\.NAV_TABS\]\.forEach\(\(v\) => registerAction\(\{[^]*?\n\}\)\);/)?.[0];
  assert.ok(statement, "the shipped stage registration");
  const offs = [], opened = [];
  runInNewContext(statement, { NAV, NAV_TABS, registerAction: action => { offs.push(registerAction(action)); }, showStageFocused: name => opened.push(name) });
  t.after(() => { offs.forEach(off => off()); resetAllBindings(); });
  const stages = listActions().filter(a => a.id.startsWith("stage.") && !a.id.includes(".", 6));
  assert.deepEqual(stages.map(a => [a.id, a.label, a.context]), [
    // NAV's order (Home, Workspace overview, Automations), then NAV_TABS (Machines); each keeps its own chord (bound
    // by id). Home has none yet (slice 2: slice 4's table gives it one).
    ["stage.home", "View: Home", "global"], ["stage.spawn", "View: Workspace overview", "global"], ["stage.automations", "View: Automations", "global"],
    ["stage.hierarchy", "View: Workspace › Machines", "global"],
  ]);
  assert.deepEqual(["stage.hierarchy", "stage.spawn", "stage.automations"].map(id => getBinding(id, false)), ["Mod+1", "Mod+2", "Mod+3"],
    "⌘1 / Ctrl+1 is Machines, ⌘3 / Ctrl+3 Automations");
  for (const isMac of [false, true]) assert.equal(getBinding("stage.hierarchy", isMac), "Mod+1");
  const out = { isMac: false, insideTerminal: false };
  assert.equal(matchEvent(linux("1"), out), "stage.hierarchy");
  assert.equal(matchEvent(ev("1", { metaKey: true }), { isMac: true, insideTerminal: true }), "stage.hierarchy", "⌘1, a terminal focused too");
  assert.equal(matchEvent(linux("3"), out), "stage.automations");
  assert.equal(matchEvent(ev("3", { metaKey: true }), { isMac: true, insideTerminal: true }), "stage.automations", "⌘3, a terminal focused too");
  assert.equal(runAction("stage.hierarchy"), true); assert.equal(runAction("stage.automations"), true);
  assert.deepEqual(opened, ["hierarchy", "automations"]);
  // A chord no default takes, in any family (Ctrl+Alt+Shift+A is a split move's in the Ctrl+Alt family).
  setBinding("stage.hierarchy", "Ctrl+Alt+Shift+Y");
  assert.equal(matchEvent(linux("Y", { altKey: true, shiftKey: true }), out), "stage.hierarchy", "rebound");
  assert.equal(matchEvent(linux("1"), out), null, "the old chord is free");
  setBinding("stage.hierarchy", null);
  assert.equal(getBinding("stage.hierarchy", false), null, "unbound");
  resetBinding("stage.hierarchy");
  assert.equal(matchEvent(linux("1"), out), "stage.hierarchy", "reset to Mod+1");
});

test("real targets: F6 cycles from text fields; in xterm's textarea F6 is the program's and Mod+Shift+F6 leaves", t => {
  registerAll(t);
  const dom = new JSDOM(`<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div><input class="palette-input"><textarea class="ftask"></textarea>`);
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  // Real targets: matchEvent derives insideTerminal and editable from them (function keys never
  // type, so the editable-field guard does not drop F6 in a text field).
  const term = doc.querySelector(".xterm-helper-textarea");
  for (const target of [doc.querySelector(".palette-input"), doc.querySelector(".ftask")]) {
    for (const isMac of [true, false]) {
      assert.equal(matchEvent(ev("F6", { target }), { isMac }), "focus.nextRegion", `${target.className} mac=${isMac}`);
      assert.equal(matchEvent(ev("F6", { target, shiftKey: true }), { isMac }), "focus.prevRegion", `${target.className} mac=${isMac}`);
    }
  }
  for (const isMac of [true, false]) {
    const f6 = ev("F6", { target: term });
    assert.equal(matchEvent(f6, { isMac }), null, `F6 in a terminal is the program's (mac=${isMac})`);
    assert.equal(handleKeydown(f6, { isMac }), false); assert.equal(f6.defaultPrevented, false);
    const leave = ev("F6", { target: term, shiftKey: true, ...(isMac ? { metaKey: true } : { ctrlKey: true }) });
    assert.equal(matchEvent(leave, { isMac }), "focus.leaveTerminal", `Mod+Shift+F6 leaves (mac=${isMac})`);
  }
  assert.equal(isPlainChord("F6"), false); assert.equal(isPlainChord("Shift+F12"), false);
  // Keys that type stay the field's: a plain-letter binding never fires while typing.
  setBinding("sidebar.toggle", "B");
  assert.equal(isPlainChord("B"), true);
  assert.equal(matchEvent(ev("b", { target: doc.querySelector(".palette-input") }), { isMac: false }), null);
  assert.equal(matchEvent(ev("b", { target: doc.querySelector(".xterm-helper-textarea") }), { isMac: true }), null);
});

// The theme picker's chord, dispatched as the real keydown: Space reports key " " (KEY_ALIASES → "space").
const space = (mods = {}) => ev(" ", { code: "Space", ...mods });
test("theme picker: Ctrl+Shift+Space on Linux/Windows, ⇧⌘Space on macOS, from the real Space event", t => {
  registerAll(t);
  assert.equal(formatChord(getBinding("app.themePicker", false), false), "Ctrl+Shift+Space");
  assert.equal(formatChord(getBinding("app.themePicker", true), true), "⇧⌘Space");
  assert.ok(TERMINAL_ALLOWLIST.includes("app.themePicker"));
  for (const insideTerminal of [false, true]) {
    const linuxOpts = { isMac: false, insideTerminal }, macOpts = { isMac: true, insideTerminal };
    assert.equal(matchEvent(space({ ctrlKey: true, shiftKey: true }), linuxOpts), "app.themePicker", `Linux, terminal=${insideTerminal}`);
    // Linux ignores metaKey (chordFromEvent): where the window manager lets Super+Ctrl+Shift+Space through, it opens the picker too.
    assert.equal(matchEvent(space({ ctrlKey: true, shiftKey: true, metaKey: true }), linuxOpts), "app.themePicker", `Linux + Super, terminal=${insideTerminal}`);
    assert.equal(matchEvent(space({ metaKey: true, shiftKey: true }), macOpts), "app.themePicker", `macOS, terminal=${insideTerminal}`);
    const claimed = space({ ctrlKey: true, shiftKey: true }); handleKeydown(claimed, linuxOpts);
    assert.equal(claimed.defaultPrevented, true, "claimed before the pty");
    // Plain Ctrl+Space (NUL: set-mark in emacs, completion in shells and editors) is the leader since D18 (decided
    // 2026-11-19), on both platforms: the leader pressed twice gives the program its NUL (leader.test.mjs).
    const nul = space({ ctrlKey: true });
    for (const opts of [linuxOpts, macOpts]) assert.equal(matchEvent(nul, opts), "app.leader", `Ctrl+Space, mac=${opts.isMac}`);
    // Not the other platform's chord: ⌃⇧Space on macOS (⌃ in a terminal is the program's), ⌘ alone elsewhere.
    assert.equal(matchEvent(space({ ctrlKey: true, shiftKey: true }), macOpts), null);
    assert.equal(matchEvent(space({ metaKey: true, ctrlKey: true, shiftKey: true }), macOpts), null, "⌃⇧⌘Space is not the macOS chord");
  }
  // In a text field (the palette's input, the spawn form): a modified chord is not typing, so the engine's
  // editable-field guard (plain chords only) lets it fire there.
  const dom = new JSDOM(`<input class="palette-input"><textarea class="ftask"></textarea><div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>`);
  t.after(() => dom.window.close());
  for (const target of dom.window.document.querySelectorAll("input, textarea")) {
    assert.equal(matchEvent(space({ target, ctrlKey: true, shiftKey: true }), { isMac: false }), "app.themePicker", target.className);
    assert.equal(matchEvent(space({ target, metaKey: true, shiftKey: true }), { isMac: true }), "app.themePicker", target.className);
  }
});

test("theme picker: no other default shares either chord", t => {
  registerAll(t);
  for (const isMac of [false, true]) {
    const chord = getBinding("app.themePicker", isMac);
    assert.equal(findConflict(chord, "global", "app.themePicker", isMac), null, `mac=${isMac}: ${chord}`);
    for (const id of IDS) if (id !== "app.themePicker") assert.notEqual(getBinding(id, isMac), chord, id);
    assert.deepEqual(keymapConflicts(isMac), [], `mac=${isMac}`);
  }
  // A user who bound the chord to another action keeps it; the existing warning names the clash.
  setBinding("app.shortcuts", "Ctrl+Shift+Space");
  assert.equal(getBinding("app.shortcuts", false), "Ctrl+Shift+Space");
  assert.deepEqual(keymapConflicts(false).map(c => c.actions.map(a => a.id).sort()), [["app.shortcuts", "app.themePicker"]]);
});

// The font picker (app.fontPicker, the product owner's call, 2026-10-23) takes no default chord: the palette's
// Font: choose… and the settings cog's Font… open it.
test("font picker: no default chord in any family, on either platform, and the Desktop's own (not a shared chord)", t => {
  registerAll(t);
  t.after(() => setChordFamily(DEFAULT_CHORD_FAMILY));
  assert.equal(CHORDS_READ.some(({ id }) => id === "app.fontPicker"), false, "not read from the TUI's chord table");
  assert.equal(CHORDS.some(entry => /fontPicker|font-picker/.test(JSON.stringify(entry))), false, "the shared table has no font row");
  assert.equal(TERMINAL_ALLOWLIST.includes("app.fontPicker"), false, "no default, so no terminal bytes to keep");
  for (const family of CHORD_FAMILIES) {
    setChordFamily(family);
    for (const isMac of [false, true]) {
      assert.equal(defaultBinding("app.fontPicker", isMac, family), null, `${family}, mac=${isMac}`);
      assert.equal(getBinding("app.fontPicker", isMac), null, `${family}, mac=${isMac}`);
      assert.deepEqual(keymapConflicts(isMac), [], `${family}, mac=${isMac}`);
    }
  }
  // Nothing is left on the chord it had: Ctrl+Alt+Shift+Space and ⌥⇧⌘Space are nobody's.
  for (const insideTerminal of [false, true]) {
    assert.equal(matchEvent(space({ ctrlKey: true, altKey: true, shiftKey: true }), { isMac: false, insideTerminal }), null, `Linux, terminal=${insideTerminal}`);
    assert.equal(matchEvent(space({ metaKey: true, altKey: true, shiftKey: true }), { isMac: true, insideTerminal }), null, `macOS, terminal=${insideTerminal}`);
  }
});

test("font picker: a chord given in the shortcuts editor works as the explicit themes' do, ⌥ with Space read from the key", t => {
  registerAll(t);
  t.after(() => { resetBinding("app.fontPicker"); });
  setBinding("app.fontPicker", "Ctrl+Alt+Shift+Space");
  assert.equal(matchEvent(space({ ctrlKey: true, altKey: true, shiftKey: true }), { isMac: false, insideTerminal: false }), "app.fontPicker");
  assert.equal(matchEvent(space({ ctrlKey: true, altKey: true, shiftKey: true }), { isMac: false, insideTerminal: true }), null,
    "not from a Linux/Windows terminal: the program keeps its bytes");
  setBinding("app.fontPicker", "Mod+Alt+Shift+Space");
  for (const insideTerminal of [false, true]) {
    // ⌥ with Space types a no-break space on macOS: the key is read from its code, Space.
    assert.equal(matchEvent(ev("\u00a0", { code: "Space", metaKey: true, altKey: true, shiftKey: true }), { isMac: true, insideTerminal }), "app.fontPicker",
      `macOS, ⌥'s no-break space, terminal=${insideTerminal}`);
  }
  assert.equal(matchEvent(space({ metaKey: true, shiftKey: true }), { isMac: true }), "app.themePicker", "without ⌥ it is the theme picker's");
});

// macOS reads ⌥ with ⌘ or ⌃ on Space as Space for every action (keybindings.mjs macOptionKey), not only the font
// picker's: no default is such a chord, so every default matches as it did, and those presses still match nothing.
test("macOS: ⌘⌥ / ⌃⌥ on Space read Space for any action, and no default's matching changed", t => {
  registerAll(t);
  inFamily(t, DEFAULT_CHORD_FAMILY);
  const isMac = true;
  const nbsp = (mods) => ev("\u00a0", { code: "Space", altKey: true, ...mods });
  const presses = [{ metaKey: true }, { ctrlKey: true }, { metaKey: true, shiftKey: true }, { ctrlKey: true, shiftKey: true }, { metaKey: true, ctrlKey: true }];
  for (const family of CHORD_FAMILIES) {
    setChordFamily(family);
    for (const id of IDS) {
      const c = parseChord(getBinding(id, isMac));
      assert.ok(!(c && c.key === "space" && c.alt && (c.mod || c.ctrl)), `${id} (${getBinding(id, isMac)}) holds ⌥ with ⌘ or ⌃ on Space, ${family}`);
    }
    for (const context of [["tabs"], ["sidebar"], []]) {
      setActiveContexts(new Set(context));
      for (const mods of presses) for (const insideTerminal of [false, true]) {
        assert.equal(matchEvent(nbsp(mods), { isMac, insideTerminal }), null, `${JSON.stringify(mods)} matches no default, ${family}, ${context}, terminal=${insideTerminal}`);
      }
    }
    setActiveContexts(new Set(["tabs"]));
    // The other Space chords are as before: ⇧⌘Space is the theme picker's; ⌥Space alone is typing.
    assert.equal(matchEvent(space({ metaKey: true, shiftKey: true }), { isMac }), "app.themePicker", family);
    assert.equal(chordToString(chordFromEvent(nbsp({}), isMac)), "Alt+\u00a0", "plain ⌥Space is the character it types");
    assert.equal(matchEvent(nbsp({}), { isMac, insideTerminal: true }), null);
  }
  // What the recorder stores (chordToString(chordFromEvent(e))), and any action given it matches its press.
  assert.equal(chordToString(chordFromEvent(nbsp({ metaKey: true }), isMac)), "Mod+Alt+Space");
  assert.equal(chordToString(chordFromEvent(nbsp({ ctrlKey: true, shiftKey: true }), isMac)), "Ctrl+Alt+Shift+Space");
  t.after(() => resetBinding("app.shortcuts"));
  setBinding("app.shortcuts", chordToString(chordFromEvent(nbsp({ metaKey: true }), isMac)));
  assert.equal(matchEvent(nbsp({ metaKey: true }), { isMac, insideTerminal: false }), "app.shortcuts", "not only the font picker's");
});

// Phase 3 (c4d4a391): the palette took Ctrl+Alt+K and Quick Open Ctrl+Alt+P (#1217's Ctrl+Shift+K and
// Ctrl+Shift+P before); the Alt family, the default since 2026-10-22, gives them Alt+K and Alt+P. A
// stored binding on the family's chord is kept, and the shortcuts editor's warning names the clash;
// one on an older chord, or on another family's, clashes with nothing.
test("palette and Quick Open chords: a stored binding on either is kept and named as a clash, in every family", t => {
  registerAll(t);
  inFamily(t, DEFAULT_CHORD_FAMILY);
  for (const family of CHORD_FAMILIES) {
    setChordFamily(family);
    resetAllBindings();
    assert.deepEqual(keymapConflicts(false), [], `the defaults clash with nothing, ${family}`);
    const palette = defaultBinding("app.palette", false, family), quickOpen = defaultBinding("app.quickOpenSouls", false, family);
    setBinding("sidebar.toggle", palette);
    assert.deepEqual(keymapConflicts(false).map(c => c.actions.map(a => a.id).sort()), [["app.palette", "sidebar.toggle"]], `${palette}, ${family}`);
    resetAllBindings();
    setBinding("app.palette", quickOpen);
    assert.equal(getBinding("app.palette", false), quickOpen);
    assert.deepEqual(keymapConflicts(false).map(c => c.actions.map(a => a.id).sort()), [["app.palette", "app.quickOpenSouls"]], `${quickOpen}, ${family}`);
    // The palette's keys of the other families are nobody's default in this one.
    for (const other of CHORD_FAMILIES.map(each => defaultBinding("app.palette", false, each)).filter(chord => chord !== palette)) {
      resetAllBindings();
      setBinding("sidebar.toggle", other);
      assert.deepEqual(keymapConflicts(false), [], `${other} is nobody's default in ${family}`);
    }
  }
  setChordFamily(DEFAULT_CHORD_FAMILY);
  resetAllBindings();
  setBinding("sidebar.toggle", "Ctrl+Shift+K"); // the palette's chord from #1217 to phase 3, set by hand
  assert.deepEqual(keymapConflicts(false), [], "the old chord is nobody's default in the default family");
  setBinding("sidebar.toggle", "Ctrl+Alt+K"); // the palette's default before the Alt family
  assert.deepEqual(keymapConflicts(false), [], "nor the Ctrl+Alt family's");
});

// #672: Ctrl+Shift+C copies the terminal's selection on Linux/Windows. The terminal's key path is the
// shell's: terminal-tab.mjs's custom key handler runs terminalKeyDecision with the shell's interceptKey,
// and a handled key writes only the decision's byte. Ctrl+C stays the program's interrupt.
function terminalKeyPath(t, selection) {
  resetAllBindings();
  const pty = [], clipboard = [];
  const term = { hasSelection: () => selection !== "", getSelection: () => selection };
  const offs = IDS.map(id => registerAction({ id, label: id, context: contextOf(id),
    run: id === "terminal.copySelection" ? () => copyTerminalSelection(term, text => { clipboard.push(text); }) : () => {} }));
  setActiveContexts(new Set(["tabs"]));
  t.after(() => { offs.forEach(off => off()); setActiveContexts(new Set()); resetAllBindings(); });
  const opts = { isMac: false, insideTerminal: true };
  const interceptKey = (e) => {
    if (!matchEvent(e, opts)) return false;
    if (e.type === "keydown") handleKeydown(e, opts);
    return true;
  };
  // What xterm sends when the custom handler lets a key through (Keyboard.ts: Ctrl+letter only with Shift up).
  const xtermBytes = (e) => (e.ctrlKey && !e.shiftKey && !e.altKey && /^[a-z]$/i.test(e.key) ? String.fromCharCode(e.key.toUpperCase().charCodeAt(0) - 64)
    : e.key === "Enter" ? "\r" : e.key.length === 1 && !e.ctrlKey ? e.key : "");
  const press = (e) => {
    const { handled, byte } = terminalKeyDecision(e, interceptKey);
    if (!handled) pty.push(xtermBytes(e));
    else if (byte !== null) pty.push(byte);
    return { handled, prevented: e.defaultPrevented };
  };
  return { press, pty, clipboard };
}
const keydown = (key, mods = {}) => ev(key, { type: "keydown", ...mods });

test("Linux/Windows: Ctrl+Shift+C with nothing selected sends nothing to the pty and copies nothing", t => {
  const { press, pty, clipboard } = terminalKeyPath(t, "");
  assert.deepEqual(press(keydown("C", { ctrlKey: true, shiftKey: true })), { handled: true, prevented: true });
  assert.equal(press(ev("C", { type: "keyup", ctrlKey: true, shiftKey: true })).handled, true, "every phase is claimed");
  assert.deepEqual(pty, [], "no byte reaches the program");
  assert.deepEqual(clipboard, []);
});

test("Linux/Windows: Ctrl+Shift+C copies exactly the selection, and still sends nothing", async t => {
  const { press, pty, clipboard } = terminalKeyPath(t, "  line one\nline two");
  press(keydown("C", { ctrlKey: true, shiftKey: true }));
  await new Promise(r => setImmediate(r));
  assert.deepEqual(clipboard, ["  line one\nline two"]);
  assert.deepEqual(pty, []);
});

test("Linux/Windows: Ctrl+C is still the interrupt, selection or not; plain keys and Shift+Enter are unchanged", t => {
  for (const selection of ["", "selected"]) {
    const { press, pty, clipboard } = terminalKeyPath(t, selection);
    assert.deepEqual(press(keydown("c", { ctrlKey: true })), { handled: false, prevented: false });
    press(keydown("a"));
    press(keydown("Enter", { shiftKey: true }));
    press(keydown("Enter"));
    assert.equal(pty[0], "\x03", "ETX reaches the program");
    assert.equal(pty[1], "a");
    assert.equal(pty[2], "\n", "Shift+Enter keeps its own byte (a newline in the agent's draft)");
    assert.equal(pty[3], "\r");
    assert.deepEqual(clipboard, []);
  }
});

test("macOS: the copy action has no chord, so ⌘C stays the menu's Copy and ⌃⇧C the program's", t => {
  registerAll(t);
  assert.equal(getBinding("terminal.copySelection", true), null);
  assert.equal(matchEvent(ev("c", { metaKey: true }), { isMac: true, insideTerminal: true }), null);
  assert.equal(matchEvent(ev("C", { ctrlKey: true, shiftKey: true }), { isMac: true, insideTerminal: true }), null);
});

// The leader (docs/desktop-keyboard.md, "The leader"): the TUI's, Ctrl+X on every platform, from every
// focus. On Linux/Windows it is allowlisted, a named exception to principle 2 (it sends 0x18, which the
// leader pressed twice gives the program: terminal-xterm-bytes), and Cut keeps it in a text field
// (leaderLeftToField). On macOS ⌃X fires in a terminal by name and shape (⌃\, the leader before 0.67,
// too), a named exception to principle 3, and in a field as well: Cut is ⌘X there.
test("the leader: Ctrl+X (the other choice; D18's default is Ctrl+Space) fires app.leader inside a terminal on Linux/Windows, and claims it", t => {
  registerAll(t);
  assert.equal(defaultBinding("app.leader", false), "Ctrl+Space");
  assert.equal(defaultBinding("app.leader", true), "Ctrl+Space");
  setBinding("app.leader", "Ctrl+X"); // the Ctrl+X choice (the Keyboard shortcuts sheet)
  for (const insideTerminal of [true, false]) {
    const opts = { isMac: false, insideTerminal };
    const ctrlX = linux("x");
    assert.equal(matchEvent(ctrlX, opts), "app.leader", `terminal=${insideTerminal}`);
    handleKeydown(ctrlX, opts);
    assert.equal(ctrlX.defaultPrevented, true);
  }
  // Ctrl+Shift+X, Ctrl+Alt+X and Alt+X are not the leader, in any family; nor is Alt+O, the leader
  // before 0.67: the workspace switcher in the Alt family, the program's (ESC o) in the other two.
  const inTerm = { isMac: false, insideTerminal: true };
  inFamily(t, DEFAULT_CHORD_FAMILY);
  for (const family of CHORD_FAMILIES) {
    setChordFamily(family);
    assert.equal(matchEvent(linux("X", { shiftKey: true }), inTerm), null, family);
    assert.equal(matchEvent(linux("x", { altKey: true }), inTerm), null, family);
    assert.equal(matchEvent(ev("x", { altKey: true }), inTerm), null, family);
    const altO = ev("o", { altKey: true });
    if (family === "alt") { assert.equal(matchEvent(altO, inTerm), "app.workspaces", "Alt+O, alt"); continue; }
    assert.equal(matchEvent(altO, inTerm), null, `Alt+O, ${family}`);
    assert.equal(handleKeydown(altO, inTerm), false); assert.equal(altO.defaultPrevented, false, `Alt+O is the program's, ${family}`);
  }
  setChordFamily(DEFAULT_CHORD_FAMILY);
  assert.equal(formatChord(getBinding("app.leader", false), false), "Ctrl+X");
  assert.equal(formatChord(getBinding("app.leader", true), true), "⌃X");
});

test("the leader in a text field: Linux/Windows leave Ctrl+X to Cut; a terminal's own textarea, a field with nothing to cut and macOS open it", t => {
  registerAll(t);
  setBinding("app.leader", "Ctrl+X"); // the Ctrl+X choice: Ctrl+Space, the default, types nothing in a field and opens there
  const dom = new JSDOM(`<input class="palette-input"><input type="search" class="search"><textarea class="ftask"></textarea>
    <div class="editable" contenteditable="true"></div><input type="checkbox" class="check"><button class="button">b</button>
    <input class="readonly" readonly><textarea class="readonly-area" readonly></textarea><input type="password" class="password"><input type="date" class="date">
    <div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>`);
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const editable = doc.querySelector(".editable");
  Object.defineProperty(editable, "isContentEditable", { value: true }); // jsdom does not compute it
  const fields = [doc.querySelector(".palette-input"), doc.querySelector(".search"), doc.querySelector(".ftask"), editable];
  const ctrlX = target => linux("x", { target });
  // Linux and Windows are one path (isMac false): Ctrl+X in a text input, a textarea or a contenteditable
  // matches nothing and is not prevented, so Chromium's Cut runs.
  for (const target of fields) {
    const e = ctrlX(target);
    assert.equal(leaderLeftToField(e, false), true, `${target.className}: left to the field`);
    assert.equal(matchEvent(e, { isMac: false }), null, `${target.className}: not the leader`);
    assert.equal(handleKeydown(e, { isMac: false }), false);
    assert.equal(e.defaultPrevented, false, `${target.className}: Cut runs`);
    // macOS cuts with ⌘X: ⌃X is the leader there, in a field too.
    const mac = ctrlX(target);
    assert.equal(leaderLeftToField(mac, true), false, `${target.className} on macOS`);
    assert.equal(handleKeydown(mac, { isMac: true }), true, `${target.className} on macOS opens the leader`);
    assert.equal(mac.defaultPrevented, true);
  }
  // xterm's helper textarea is a textarea inside .xterm: there Ctrl+X is the leader (the terminal rule).
  const helper = doc.querySelector(".xterm-helper-textarea");
  assert.equal(leaderLeftToField(ctrlX(helper), false), false, "a terminal is not a field");
  const inTerminal = ctrlX(helper);
  assert.equal(handleKeydown(inTerminal, { isMac: false }), true, "the terminal's textarea opens the leader");
  assert.equal(inTerminal.defaultPrevented, true);
  // Nothing Cut takes text from is a field: an input with no text, a button, a read-only input or
  // textarea, a password (Chromium disables Cut there) and a date.
  for (const target of [".check", ".button", ".readonly", ".readonly-area", ".password", ".date"].map(s => doc.querySelector(s))) {
    assert.equal(leaderLeftToField(ctrlX(target), false), false, target.className);
    assert.equal(matchEvent(ctrlX(target), { isMac: false }), "app.leader", `${target.className} opens the leader`);
  }
  // The rule is the chord's: a stored rebind to Ctrl+X (or Mod+X, the same key here) follows it.
  for (const chord of ["Ctrl+X", "Mod+X"]) {
    setBinding("app.leader", chord);
    for (const target of fields) {
      const e = ctrlX(target);
      assert.equal(handleKeydown(e, { isMac: false }), false, `${chord} rebind, ${target.className}`);
      assert.equal(e.defaultPrevented, false);
    }
    assert.equal(matchEvent(ctrlX(doc.querySelector(".button")), { isMac: false }), "app.leader", `${chord} rebind on a button`);
  }
  // A rebind to anything else fires in a field as before, and Ctrl+X is then plain in a field: nothing matches.
  setBinding("app.leader", "Alt+O");
  for (const target of fields) {
    const altO = ev("o", { altKey: true, target });
    assert.equal(leaderLeftToField(altO, false), false);
    assert.equal(handleKeydown(altO, { isMac: false }), true, `Alt+O in ${target.className} opens the leader`);
    assert.equal(altO.defaultPrevented, true);
    const e = ctrlX(target);
    assert.equal(matchEvent(e, { isMac: false }), null, `Ctrl+X in ${target.className} is Cut`);
    assert.equal(handleKeydown(e, { isMac: false }), false); assert.equal(e.defaultPrevented, false);
  }
  setBinding("app.leader", "Ctrl+Shift+X");
  assert.equal(matchEvent(linux("X", { shiftKey: true, target: fields[0] }), { isMac: false }), "app.leader", "Ctrl+Shift+X is not Cut's");
});

test("the leader on macOS: ⌃X fires inside a terminal, and ⌃\\ bound back; another ⌃ chord does not, ⌘ does", t => {
  registerAll(t);
  setBinding("app.leader", "Ctrl+X"); // the Ctrl+X choice; ⌃Space, the default, fires there by the same rule
  const inTerm = { isMac: true, insideTerminal: true };
  const ctrlX = ev("x", { ctrlKey: true });
  assert.equal(matchEvent(ctrlX, inTerm), "app.leader");
  handleKeydown(ctrlX, inTerm);
  assert.equal(ctrlX.defaultPrevented, true, "claimed before the pty");
  assert.equal(matchEvent(ev("X", { ctrlKey: true, shiftKey: true }), inTerm), null, "⌃⇧X is not the leader's shape");
  // By action id and shape (the shortcuts editor reads terminalAllows too): ⌃X and ⌃\, no other ⌃ chord.
  assert.equal(terminalAllows("app.leader", "Ctrl+X", true), true);
  assert.equal(terminalAllows("app.leader", "Ctrl+\\", true), true);
  assert.equal(terminalAllows("app.leader", "Ctrl+Y", true), false);
  assert.equal(terminalAllows("app.leader", "Ctrl+Shift+X", true), false);
  assert.equal(terminalAllows("app.leader", "Ctrl+Alt+X", true), false);
  assert.equal(terminalAllows("tabs.close", "Ctrl+X", true), false, "⌃X is the leader's alone");
  setBinding("app.leader", "Ctrl+\\");
  assert.equal(matchEvent(ev("\\", { ctrlKey: true }), inTerm), "app.leader", "⌃\\, the leader before 0.67, bound back");
  assert.equal(matchEvent(ev("x", { ctrlKey: true }), inTerm), null, "⌃X is then the program's");
  assert.equal(matchEvent(ev("|", { ctrlKey: true, shiftKey: true }), inTerm), null, "⌃⇧\\ is not the leader's shape");
  setBinding("app.leader", "Ctrl+Y");
  assert.equal(matchEvent(ev("y", { ctrlKey: true }), inTerm), null, "another ⌃ chord stays the program's");
  assert.equal(matchEvent(ev("y", { ctrlKey: true }), { isMac: true, insideTerminal: false }), "app.leader", "and is the leader outside");
  setBinding("app.leader", "Mod+J");
  assert.equal(matchEvent(ev("j", { metaKey: true }), inTerm), "app.leader", "a ⌘ rebind fires by the ⌘ rule");
  resetAllBindings();
  // On Linux/Windows a terminal is the program's for Ctrl+\ (SIGQUIT).
  assert.equal(matchEvent(ev("\\", { ctrlKey: true }), { isMac: false, insideTerminal: true }), null);
});

test("the leader is inert under a shown modal: the chord goes where it goes today", t => {
  resetAllBindings();
  let modal = false;
  const off = registerAction({ id: "app.leader", label: "Leader", context: "global", when: () => !modal, run: () => {} });
  setBinding("app.leader", "Ctrl+X"); // the Ctrl+X choice
  t.after(() => { off(); resetAllBindings(); });
  assert.equal(matchEvent(linux("x"), { isMac: false, insideTerminal: true }), "app.leader");
  modal = true;
  const ctrlX = linux("x");
  assert.equal(matchEvent(ctrlX, { isMac: false, insideTerminal: true }), null);
  assert.equal(handleKeydown(ctrlX, { isMac: false, insideTerminal: true }), false);
  assert.equal(ctrlX.defaultPrevented, false, "the program gets it");
});

// Show only the current workspace (2026-10-23) left in slice 1 of the Desktop UI rework: its chord, ⌥⇧⌘O on macOS and
// Ctrl+Alt+Shift+O elsewhere, is bound to nothing in any family, so a terminal's program gets it; without Shift it is
// still the workspace switcher's key.
test("⌥⇧⌘O / Ctrl+Alt+Shift+O are free again in every family: a terminal's program gets them", t => {
  registerAll(t);
  inFamily(t, DEFAULT_CHORD_FAMILY);
  assert.equal(TERMINAL_ALLOWLIST.includes("workspaces.currentOnly"), false);
  for (const family of CHORD_FAMILIES) {
    setChordFamily(family);
    for (const isMac of [false, true]) assert.equal(defaultBinding("workspaces.currentOnly", isMac, family) ?? null, null, `no default, mac=${isMac}, ${family}`);
    const linuxPress = pressOf("Ctrl+Alt+Shift+O"), macPress = ev("Ø", { code: "KeyO", metaKey: true, altKey: true, shiftKey: true });
    for (const [press, isMac] of [[linuxPress, false], [macPress, true]]) {
      assert.equal(matchEvent(press, { isMac, insideTerminal: true }), null, `mac=${isMac}, ${family}`);
      assert.equal(handleKeydown(press, { isMac, insideTerminal: true }), false); assert.equal(press.defaultPrevented, false, `the program's, mac=${isMac}, ${family}`);
    }
    assert.equal(matchEvent(ev("ø", { code: "KeyO", metaKey: true, altKey: true }), { isMac: true, insideTerminal: true }), "app.workspaces");
  }
});

test("the leader's, the sidebar's and the shared chords clash with no other default, in every family", t => {
  registerAll(t);
  inFamily(t, DEFAULT_CHORD_FAMILY);
  // Every shared row has a macOS chord; the workspace moves have none outside the Alt family on
  // Linux/Windows (CHORDS `other: null`, `shift: null`: #1491 B1).
  assert.deepEqual(CHORDS_READ.filter(({ does }) => CHORDS.find(entry => entry.does === does).mac === null), []);
  const noChord = (id, isMac, family) => !isMac && family !== "alt" && ["workspace.previous", "workspace.next"].includes(id);
  for (const family of CHORD_FAMILIES) {
    setChordFamily(family);
    for (const isMac of [false, true]) assert.deepEqual(keymapConflicts(isMac), [], `mac=${isMac}, ${family}`);
    for (const isMac of [false, true]) for (const id of ["app.leader", ...CHORDS_READ.map(({ id }) => id), ...IDS.filter(id => id.startsWith("sidebar.key."))]) {
      const chord = getBinding(id, isMac);
      if (noChord(id, isMac, family)) { assert.equal(chord, null, `${id} has no chord, ${family}`); continue; }
      assert.ok(chord || id.startsWith("sidebar.key."), `${id} has a chord, mac=${isMac}, ${family}`);
      if (chord) assert.equal(findConflict(chord, contextOf(id), id, isMac), null, `${id} (${chord}) mac=${isMac}, ${family}`);
    }
  }
  // The leader's Tab and Shift+Tab, as the shared group-next and group-previous.
  for (const [family, next, previous] of [["alt", "Alt+Shift+→", "Alt+Shift+←"], ["ctrl+alt", "Ctrl+Alt+A", "Ctrl+Alt+Shift+A"], ["ctrl+shift", "Ctrl+Alt+A", "Ctrl+Alt+Shift+A"]]) {
    setChordFamily(family);
    assert.equal(getBinding("split.focusNextGroup", false), next, `group-next, ${family}`);
    assert.equal(getBinding("split.focusPrevGroup", false), previous, `group-previous, ${family}`);
  }
  setChordFamily(DEFAULT_CHORD_FAMILY);
});

// Desktop text fields (the spawn dialog's fields, the palette's input): no default
// takes a key a field edits with, on either platform, so a field keeps every one of them (the leader's
// Ctrl+X is Cut's in a field on Linux/Windows: leaderLeftToField; on macOS the ⌥ arrows, which move
// between tabs, groups and workspaces elsewhere, are the field's caret moves and give way there); the
// other shared chords are not such keys, and fire from a field as from anywhere (they type nothing).
test("text fields keep their own keys: no default takes an editing key, and the shared chords fire from a field", t => {
  registerAll(t);
  const dom = new JSDOM(`<input class="palette-input"><textarea class="ftask"></textarea>`);
  t.after(() => dom.window.close());
  const fields = [...dom.window.document.querySelectorAll("input, textarea")];
  const arrows = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
  const editing = {
    // Linux/Windows: select, word moves and word selection, line ends, delete a word, undo/redo, clipboard.
    false: [
      ...arrows.flatMap(key => [ev(key), ev(key, { shiftKey: true }), linux(key), linux(key, { shiftKey: true })]),
      ...["Home", "End"].flatMap(key => [ev(key), ev(key, { shiftKey: true }), linux(key), linux(key, { shiftKey: true })]),
      linux("Backspace"), linux("Delete"), ...["a", "c", "v", "x", "z", "y"].map(key => linux(key)), linux("Z", { shiftKey: true }), linux("V", { shiftKey: true }),
    ],
    // macOS: ⌘ and ⌥ arrows (line and word moves), with ⇧ to select; ⌘/⌥ Backspace; the Emacs ⌃ keys; undo/redo, clipboard.
    true: [
      ...arrows.flatMap(key => [ev(key), ev(key, { shiftKey: true }), ev(key, { metaKey: true }), ev(key, { metaKey: true, shiftKey: true }),
        ev(key, { altKey: true }), ev(key, { altKey: true, shiftKey: true })]),
      ev("Backspace", { metaKey: true }), ev("Backspace", { altKey: true }),
      ...["a", "e", "k", "d", "h", "f", "b", "n", "p"].map(key => ev(key, { ctrlKey: true })),
      ...["a", "c", "v", "x", "z"].map(key => ev(key, { metaKey: true })), ev("z", { metaKey: true, shiftKey: true }),
    ],
  };
  inFamily(t, DEFAULT_CHORD_FAMILY);
  for (const family of CHORD_FAMILIES) for (const isMac of [false, true]) {
    setChordFamily(family);
    for (const target of fields) for (const e of editing[isMac]) {
      const keyed = ev(e.key, { ...e, target });
      assert.equal(matchEvent(keyed, { isMac }), null, `${JSON.stringify({ key: e.key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey })} mac=${isMac}, ${family}: ${target.className}'s`);
      assert.equal(handleKeydown(keyed, { isMac }), false); assert.equal(keyed.defaultPrevented, false);
    }
  }
  // The shared chords, pressed in a field: each is the Desktop's (Linux/Windows in each family, and macOS).
  const inField = {
    alt: [
      [ev("k", { altKey: true }), "app.palette"], [ev("1", { altKey: true }), "tabs.goto1"], [ev("E", { altKey: true, shiftKey: true }), "split.horizontal"],
      [ev("ArrowUp", { altKey: true, shiftKey: true }), "roster.openPrevious"], [ev("ArrowRight", { altKey: true }), "tabs.nextPage"],
      [ev("ArrowLeft", { altKey: true, shiftKey: true }), "split.focusPrevGroup"], [ev("ArrowUp", { altKey: true }), "workspace.previous"],
    ],
    "ctrl+alt": [
      [linux("k", { altKey: true }), "app.palette"], [linux("1", { altKey: true }), "tabs.goto1"], [linux("E", { altKey: true, shiftKey: true }), "split.horizontal"],
      [ev("ArrowUp", { altKey: true, shiftKey: true }), "roster.openPrevious"], [ev("ArrowRight", { altKey: true, shiftKey: true }), "tabs.nextPage"],
      [linux("A", { altKey: true, shiftKey: true }), "split.focusPrevGroup"], [ev("ArrowUp", { altKey: true }), null],
    ],
  };
  for (const [family, presses] of Object.entries(inField)) {
    setChordFamily(family);
    for (const target of fields) for (const [e, id] of presses) {
      assert.equal(matchEvent(ev(e.key, { ...e, target }), { isMac: false }), id, `${id} from ${target.className}, ${family}`);
    }
  }
  setChordFamily(DEFAULT_CHORD_FAMILY);
  for (const target of fields) {
    for (const [e, id] of [
      [ev("k", { metaKey: true }), "app.palette"], [ev("ArrowDown", { metaKey: true, altKey: true }), "roster.openNext"],
      [ev("Ω", { code: "KeyZ", metaKey: true, altKey: true }), "terminal.focusMode"],
    ]) assert.equal(matchEvent(ev(e.key, { ...e, target }), { isMac: true }), id, `${id} from ${target.className} on macOS`);
  }
});

// macOS: ⌥←/→ move the caret by word in a field of text and ⌥⇧←/→ select by word (⌥↑/↓ to the
// paragraph's start or end): while one has focus a default on those keys gives way to it, as a select
// keeps Alt+↑/↓ on Linux and Windows (opensOnAltArrow). A user's own binding still fires there; a
// terminal's helper textarea, a button or a row is no such field, and the moves fire from it.
test("macOS: the ⌥ arrow moves give way to a field of text, never to a terminal; a user's own binding fires there", t => {
  registerAll(t);
  const dom = new JSDOM(`<input class="palette-input"><input class="secret" type="password"><input class="ro" readonly><textarea class="ftask"></textarea>
    <button class="b">b</button><input class="check" type="checkbox">
    <div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>`);
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const moves = [[ev("ArrowLeft", { altKey: true }), "tabs.prevPage"], [ev("ArrowRight", { altKey: true }), "tabs.nextPage"],
    [ev("ArrowLeft", { altKey: true, shiftKey: true }), "split.focusPrevGroup"], [ev("ArrowRight", { altKey: true, shiftKey: true }), "split.focusNextGroup"],
    [ev("ArrowUp", { altKey: true }), "workspace.previous"], [ev("ArrowDown", { altKey: true }), "workspace.next"]];
  const press = (e, target) => { const keyed = ev(e.key, { ...e, target }); return [matchEvent(keyed, { isMac: true }), keyed]; };
  // jsdom has no isContentEditable: a contenteditable, as Chromium reports it.
  const editor = { tagName: "DIV", className: "contenteditable", isContentEditable: true, closest: () => null };
  for (const target of [...doc.querySelectorAll(".palette-input, .secret, .ro, .ftask"), editor]) {
    for (const [e] of moves) {
      const [id, keyed] = press(e, target);
      assert.equal(id, null, `${e.key}${e.shiftKey ? "+⇧" : ""} in ${target.className}`);
      assert.equal(handleKeydown(keyed, { isMac: true }), false); assert.equal(keyed.defaultPrevented, false, "the field's own move");
    }
  }
  for (const target of doc.querySelectorAll(".b, .check, .xterm-helper-textarea")) {
    for (const [e, want] of moves) assert.equal(press(e, target)[0], want, `${want} from ${target.className}`);
  }
  // Linux and Windows have no such rule: their word moves are Ctrl+←/→, and Alt+← is the tab move in a field.
  assert.equal(matchEvent(ev("ArrowLeft", { altKey: true, target: doc.querySelector(".palette-input") }), { isMac: false }), "tabs.prevPage");
  // A user's own binding of a ⌥ arrow fires from a field, as one of Alt+↑/↓ does from a select.
  setBinding("tabs.prevPage", "Alt+←");
  assert.equal(press(ev("ArrowLeft", { altKey: true }), doc.querySelector(".ftask"))[0], "tabs.prevPage", "the user's own ⌥←");
  assert.equal(press(ev("ArrowRight", { altKey: true }), doc.querySelector(".ftask"))[0], null, "the default ⌥→ still gives way");
});

// macOS: ⌥ changes the character a key types (⌥O is ø), so a chord holding ⌥ with ⌘ or ⌃ names its
// letter by the layout's base character for `code` when it is an ASCII letter (navigator.keyboard.getLayoutMap(),
// in setKeyboardLayoutMap), else by the letter `code` names; a digit key is its digit. Plain ⌥+key is typing, and
// Linux/Windows keep `key` (AltGr's character).
test("macOS ⌘⌥ chords name their key by the physical key, through the layout's map when there is one", t => {
  registerAll(t);
  t.after(() => setKeyboardLayoutMap(null));
  const mac = (key, code, mods = { metaKey: true, altKey: true }) => ev(key, { code, ...mods });
  // No layout map: the letter or digit in `code`.
  for (const [event, chord] of [
    [mac("ø", "KeyO"), "Mod+Alt+O"], [mac("Ω", "KeyZ"), "Mod+Alt+Z"], [mac("å", "KeyA"), "Mod+Alt+A"], [mac("∑", "KeyW"), "Mod+Alt+W"],
    [mac("¡", "Digit1"), "Mod+Alt+1"], [mac("ª", "Digit9"), "Mod+Alt+9"], [mac("Ø", "KeyO", { metaKey: true, altKey: true, shiftKey: true }), "Mod+Alt+Shift+O"],
    [mac("ø", "KeyO", { ctrlKey: true, altKey: true }), "Ctrl+Alt+O"],
  ]) assert.equal(chordToString(chordFromEvent(event, true)), chord, `${event.key} ${event.code}`);
  // The recorder stores what it reads (keybindings-editor.mjs: chordToString(chordFromEvent(e))).
  assert.equal(chordToString(chordFromEvent(mac("ø", "KeyO"), true)), "Mod+Alt+O", "recorded as Mod+Alt+O, never Mod+Alt+Ø");
  // Plain ⌥+key types its character; ⌘ alone keeps `key`; the arrows keep theirs.
  assert.equal(chordToString(chordFromEvent(mac("ø", "KeyO", { altKey: true }), true)), "Alt+Ø");
  assert.equal(chordToString(chordFromEvent(mac("k", "KeyK", { metaKey: true }), true)), "Mod+K");
  assert.equal(chordToString(chordFromEvent(mac("ArrowUp", "ArrowUp"), true)), "Mod+Alt+↑");
  // A plain ⌥ arrow is no typing: it is the arrow with Alt, as the moves are stored (CHORDS `mac`).
  assert.equal(chordToString(chordFromEvent(mac("ArrowLeft", "ArrowLeft", { altKey: true }), true)), "Alt+←");
  assert.equal(chordToString(chordFromEvent(mac("ArrowRight", "ArrowRight", { altKey: true, shiftKey: true }), true)), "Alt+Shift+→");
  // Linux/Windows read `key`: Ctrl+Alt+E typing € is €, not E (AltGr).
  assert.equal(chordToString(chordFromEvent(ev("€", { code: "KeyE", ctrlKey: true, altKey: true }), false)), "Mod+Alt+€");
  // A French (AZERTY) Mac: the key the layout calls A is KeyQ; its digit row types & é " …, read as its digits
  setKeyboardLayoutMap(new Map([["KeyQ", "a"], ["KeyA", "q"], ["KeyZ", "w"], ["KeyW", "z"], ["KeyO", "o"], ["Digit1", "&"]]));
  assert.equal(matchEvent(mac("Å", "KeyZ"), { isMac: true, insideTerminal: true }), "split.close", "AZERTY ⌘⌥W, on KeyZ");
  assert.equal(matchEvent(mac("Â", "KeyW"), { isMac: true, insideTerminal: true }), "terminal.focusMode", "AZERTY ⌘⌥Z, on KeyW");
  assert.equal(matchEvent(mac("‡", "KeyA"), { isMac: true, insideTerminal: true }), null, "KeyA is Q there");
  assert.equal(chordToString(chordFromEvent(mac("", "Digit1"), true)), "Mod+Alt+1", "a digit key is its digit, whatever the layout types on it");
  assert.equal(matchEvent(mac("", "Digit1"), { isMac: true, insideTerminal: true }), "tabs.goto1", "AZERTY ⌘⌥ on the & key: go to tab 1");
  // A layout whose key is no ASCII letter (Russian: KeyO is щ) names it by `code`.
  setKeyboardLayoutMap(new Map([["KeyO", "щ"], ["KeyZ", "я"], ["KeyA", "ф"]]));
  assert.equal(chordToString(chordFromEvent(mac("щ", "KeyO"), true)), "Mod+Alt+O");
  assert.equal(matchEvent(mac("щ", "KeyO"), { isMac: true, insideTerminal: true }), "app.workspaces", "Russian ⌘⌥ on KeyO: the switcher");
  assert.equal(matchEvent(mac("я", "KeyZ"), { isMac: true, insideTerminal: true }), "terminal.focusMode", "Russian ⌘⌥ on KeyZ: zoom");
  // Read from navigator.keyboard; a failing or missing API keeps the last map.
  return readKeyboardLayout({ keyboard: { getLayoutMap: () => Promise.resolve(new Map([["KeyQ", "q"]])) } }).then(async () => {
    assert.equal(chordToString(chordFromEvent(mac("œ", "KeyQ"), true)), "Mod+Alt+Q");
    await readKeyboardLayout({ keyboard: { getLayoutMap: () => Promise.reject(new Error("no")) } });
    await readKeyboardLayout({});
    assert.equal(chordToString(chordFromEvent(mac("œ", "KeyQ"), true)), "Mod+Alt+Q");
  });
});

// 0.66's shortcuts editor recorded a ⌘⌥ press by the character ⌥ typed: ⌘⌥O on a US Mac was stored
// as Mod+Alt+Ø. That stored rebind still matches the press, before the physical key's default.
test("macOS: a ⌘⌥ rebind stored by the character ⌥ typed (0.66) keeps working, ahead of a default", t => {
  registerAll(t);
  const mac = (key, code, mods = { metaKey: true, altKey: true }) => ev(key, { code, ...mods });
  const opts = { isMac: true, insideTerminal: false };
  assert.equal(matchEvent(mac("ø", "KeyO"), opts), "app.workspaces", "without a rebind: the default on KeyO");
  setBinding("app.palette", "Mod+Alt+Ø");
  assert.equal(getBinding("app.palette", true), "Mod+Alt+Ø", "stored as 0.66 recorded it");
  assert.equal(matchEvent(mac("ø", "KeyO"), opts), "app.palette", "the rebind wins the press it was recorded from");
  assert.equal(matchEvent(mac("ø", "KeyO"), { isMac: true, insideTerminal: true }), "app.palette", "in a terminal too (the palette is allowlisted)");
  setBinding("app.workspaces", "Mod+Alt+Shift+Ø");
  assert.equal(matchEvent(mac("Ø", "KeyO", { metaKey: true, altKey: true, shiftKey: true }), opts), "app.workspaces", "with Shift");
  // Every reader of one action's binding reads it so (eventChordsFor): the palette's own chord
  // cycles down, with Shift up; the leader rebound so is the leader again on its second press.
  setBinding("app.workspaces", null);
  assert.equal(pickerCycleDirection(mac("ø", "KeyO"), "app.palette", true), 1);
  assert.equal(pickerCycleDirection(mac("Ø", "KeyO", { metaKey: true, altKey: true, shiftKey: true }), "app.palette", true), -1, "⇧ cycles up");
  assert.equal(eventMatchesBinding(mac("ø", "KeyO"), "app.palette", true), true);
  setBinding("app.leader", "Mod+Alt+Ø");
  assert.equal(eventMatchesBinding(mac("ø", "KeyO"), "app.leader", true), true, "the leader again");
  assert.equal(resolveViewKey(mac("ø", "KeyO"), [{ id: "app.leader" }], { isMac: true }), "app.leader", "a view's own keys too");
  assert.equal(eventMatchesBinding(mac("ø", "KeyO"), "app.workspaces", true), false, "unbound stays unbound");
  // A default is never matched by the typed character: only a stored rebind is.
  resetAllBindings();
  t.after(registerAction({ id: "x.oslash", label: "x", context: "global", defaultChord: "Mod+Alt+Ø", run: () => {} }));
  assert.equal(matchEvent(mac("ø", "KeyO"), opts), "app.workspaces");
});

// Windows AltGr (Ctrl+Alt) types a character, and the engine keeps it as typed: Spanish AltGr+1 is
// "|", which a chord holding a modifier would otherwise read as "\\" (MODIFIED_ALIASES).
test("Windows AltGr: its character is kept as typed (no alias), and the modifier keydowns before it match nothing", t => {
  registerAll(t);
  const altGr = (key, code) => ev(key, { code, ctrlKey: true, altKey: true, getModifierState: m => m === "AltGraph" });
  t.after(registerAction({ id: "x.backslash", label: "x", context: "global", run: () => {} }));
  setBinding("x.backslash", "Ctrl+Alt+\\");
  const inTerm = { isMac: false, insideTerminal: true }, out = { isMac: false, insideTerminal: false };
  for (const opts of [inTerm, out]) assert.equal(matchEvent(altGr("|", "Digit1"), opts), null, "Spanish AltGr+1 types |");
  assert.equal(matchEvent(ev("\\", { code: "Backslash", ctrlKey: true, altKey: true }), out), "x.backslash", "the chord itself still matches");
  assert.equal(chordToString(chordFromEvent(altGr("|", "Digit1"), false)), "Mod+Alt+|");
  // What Windows sends before the character: Control, then AltGraph (both with Ctrl and Alt held).
  for (const e of [ev("Control", { code: "ControlLeft", ctrlKey: true }), ev("AltGraph", { code: "AltRight", ctrlKey: true, altKey: true, getModifierState: m => m === "AltGraph" })]) {
    assert.equal(chordFromEvent(e, false), null, `${e.key} alone is no chord`);
    for (const opts of [inTerm, out]) assert.equal(matchEvent(e, opts), null, e.key);
  }
});

// A view's own arrow keys give way to the keymap only where it binds the chord (keymapTakes): the
// roster tree, the overview canvas, the Souls grid and an instance row's open context menu use it.
test("keymapTakes: a live binding, a rebind included, is the keymap's; an unbound chord is not", t => {
  registerAll(t);
  inFamily(t, DEFAULT_CHORD_FAMILY);
  const out = { isMac: false };
  assert.equal(keymapTakes(ev("ArrowDown", { altKey: true, shiftKey: true }), out), true, "Alt+Shift+↓, roster.openNext");
  assert.equal(keymapTakes(ev("ArrowDown", { metaKey: true, altKey: true }), { isMac: true }), true, "⌘⌥↓");
  // Alt+↓ is workspace.next on Linux/Windows in the Alt family, and bound to nothing in the other two
  // (#1491 B1); ⌥↓ is workspace.next on macOS.
  for (const family of CHORD_FAMILIES) {
    setChordFamily(family);
    assert.equal(keymapTakes(ev("ArrowDown", { altKey: true }), out), family === "alt", `Alt+↓, workspace.next (${family})`);
  }
  setChordFamily(DEFAULT_CHORD_FAMILY);
  assert.equal(keymapTakes(ev("ArrowDown", { altKey: true }), { isMac: true }), true, "⌥↓ on macOS");
  for (const e of [ev("ArrowDown"), linux("ArrowDown", { altKey: true }), ev("ArrowUp", { metaKey: true }), ev("ArrowDown", { ctrlKey: true, shiftKey: true })]) {
    assert.equal(keymapTakes(e, out), false, JSON.stringify(e));
  }
  assert.equal(keymapTakes(ev("ArrowUp", { metaKey: true }), { isMac: true }), false, "⌘↑ is bound to nothing");
  setBinding("roster.openNext", "Ctrl+Shift+↓");
  assert.equal(keymapTakes(ev("ArrowDown", { ctrlKey: true, shiftKey: true }), out), true, "the rebind");
  assert.equal(keymapTakes(ev("ArrowDown", { altKey: true, shiftKey: true }), out), false, "the old default, no longer bound");
  // It answers as matchEvent does: a consumed event is nobody's.
  const consumed = ev("ArrowDown", { ctrlKey: true, shiftKey: true, defaultPrevented: true });
  assert.equal(keymapTakes(consumed, out), false);
});

// The palette's own group keys (packages/client/keymap.mjs PALETTE_KEYS), read only while the palette
// is open (overlay-picker's capture-phase handler: palette-tree.test.mjs). With it closed the same
// presses stay the keymap's: ⌘N is app.chooseSoul, Alt+Shift+↓/↑ are roster.openNext/openPrevious.
test("paletteGroupDirection: ⌘N / ⌥⌘N on macOS, Alt+Shift+↓ / ↑ elsewhere, read from PALETTE_KEYS; the hint names them", t => {
  registerAll(t);
  assert.deepEqual(PALETTE_KEYS.map(({ does }) => [does, chordFromKeyId(paletteKey(does, true)), chordFromKeyId(paletteKey(does, false))]), [
    ["palette-next-group", "Mod+N", "Alt+Shift+↓"], ["palette-previous-group", "Mod+Alt+N", "Alt+Shift+↑"],
  ]);
  assert.equal(paletteGroupDirection(ev("n", { metaKey: true }), true), 1);
  assert.equal(paletteGroupDirection(ev("Dead", { metaKey: true, altKey: true, code: "KeyN" }), true), -1, "⌥⌘N as a US Mac sends it: ⌥N is a dead key, read by the physical key");
  assert.equal(paletteGroupDirection(ev("˜", { metaKey: true, altKey: true, code: "KeyN" }), true), -1, "and where it types ˜");
  for (const e of [ev("n"), ev("N", { shiftKey: true }), ev("n", { ctrlKey: true }), ev("N", { metaKey: true, shiftKey: true }),
    ev("ArrowDown", { altKey: true, shiftKey: true }), ev("ArrowDown", { metaKey: true, altKey: true }), ev("k", { metaKey: true })]) {
    assert.equal(paletteGroupDirection(e, true), 0, `macOS: ${JSON.stringify(e)}`);
  }
  assert.equal(paletteGroupDirection(ev("ArrowDown", { altKey: true, shiftKey: true }), false), 1);
  assert.equal(paletteGroupDirection(ev("ArrowUp", { altKey: true, shiftKey: true }), false), -1);
  for (const e of [ev("ArrowDown"), ev("ArrowDown", { altKey: true }), ev("ArrowDown", { shiftKey: true }), linux("ArrowDown", { altKey: true, shiftKey: true }),
    linux("n"), linux("N", { shiftKey: true }), ev("n", { metaKey: true }), ev("ArrowRight", { altKey: true, shiftKey: true })]) {
    assert.equal(paletteGroupDirection(e, false), 0, `Linux: ${JSON.stringify(e)}`);
  }
  // Not bindings: a rebind of the actions they shadow moves neither, and closed, those actions keep the presses.
  assert.equal(matchEvent(ev("n", { metaKey: true }), { isMac: true, insideTerminal: false }), "app.chooseSoul");
  assert.equal(matchEvent(ev("ArrowDown", { altKey: true, shiftKey: true }), { isMac: false, insideTerminal: false }), "roster.openNext");
  assert.equal(matchEvent(ev("ArrowUp", { altKey: true, shiftKey: true }), { isMac: false, insideTerminal: false }), "roster.openPrevious");
  setBinding("app.chooseSoul", "Mod+J"); setBinding("roster.openNext", "Ctrl+Shift+↓");
  assert.equal(paletteGroupDirection(ev("n", { metaKey: true }), true), 1);
  assert.equal(paletteGroupDirection(ev("ArrowDown", { altKey: true, shiftKey: true }), false), 1);
  assert.equal(paletteGroupDirection(linux("ArrowDown", { shiftKey: true }), false), 0);
  // The footer's words, in the engine's own labels (formatChord).
  assert.equal(paletteGroupHint(true), "⌘N next group · ⌥⌘N previous");
  assert.equal(paletteGroupHint(false), "Alt+Shift+↓ next group · Alt+Shift+↑ previous");
  // Read, never retyped: the engine names neither key of the shared table.
  const engine = readFileSync(new URL("../renderer/keybindings.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(engine, /"cmd\+(alt\+)?n"|"alt\+shift\+(up|down)"/, "no copy of PALETTE_KEYS");
});

// ---------------------------------------------------------------- the Alt family

// The default on Linux/Windows (the product owner's call, 2026-10-22). Dispatched as the shell does it, through
// handleKeydown on a real target: a terminal's helper textarea (inside .xterm, so the engine reads the
// terminal rule from it) and a roster row in the sidebar, with the contexts the shell has on there
// (the tab layer's and the sidebar's: shell.mjs updateActiveContexts).
function aliveDom(t) {
  const dom = new JSDOM(`<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>
    <nav id="sidebar"><div class="roster-row" role="treeitem" tabindex="0">oats-desktop-developer</div></nav>`);
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  return { window: dom.window, terminal: doc.querySelector(".xterm-helper-textarea"), roster: doc.querySelector(".roster-row") };
}
function registerRecording(t) {
  resetAllBindings();
  const ran = [];
  const offs = IDS.map(id => registerAction({ id, label: id, context: contextOf(id), run: () => ran.push(id) }));
  t.after(() => { offs.forEach(off => off()); setActiveContexts(new Set()); resetAllBindings(); });
  return ran;
}
/** A real keydown on `target`, dispatched to the engine as the shell's window listener does (isMac false). */
function dispatchOn(window, target, init) {
  const e = new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  let handled = null;
  const listener = (event) => { handled = handleKeydown(event, { isMac: false }); };
  window.document.addEventListener("keydown", listener);
  target.dispatchEvent(e);
  window.document.removeEventListener("keydown", listener);
  return { handled, prevented: e.defaultPrevented, event: e };
}

test("Alt family: Alt+K, Alt+←, Alt+Shift+← and Alt+↑ run their actions from a terminal and from the roster, and are claimed", t => {
  const ran = registerRecording(t);
  inFamily(t, "alt");
  const { window, terminal, roster } = aliveDom(t);
  for (const [where, target, contexts] of [["a terminal", terminal, ["tabs"]], ["the roster", roster, ["tabs", "sidebar"]]]) {
    setActiveContexts(new Set(contexts));
    for (const [init, id] of [
      [{ key: "k", code: "KeyK", altKey: true }, "app.palette"],
      [{ key: "ArrowLeft", code: "ArrowLeft", altKey: true }, "tabs.prevPage"],
      [{ key: "ArrowLeft", code: "ArrowLeft", altKey: true, shiftKey: true }, "split.focusPrevGroup"],
      [{ key: "ArrowUp", code: "ArrowUp", altKey: true }, "workspace.previous"],
    ]) {
      ran.length = 0;
      const { handled, prevented } = dispatchOn(window, target, init);
      assert.deepEqual(ran, [id], `${JSON.stringify(init)} from ${where}`);
      assert.equal(handled, true);
      assert.equal(prevented, true, `${id} from ${where} is preventDefault'ed`);
    }
  }
});

test("Ctrl+Alt family: Alt+K, Alt+← and Alt+↑ reach the program from a terminal; Ctrl+Alt+K is the palette", t => {
  const ran = registerRecording(t);
  inFamily(t, "ctrl+alt");
  const { window, terminal, roster } = aliveDom(t);
  for (const [where, target, contexts] of [["a terminal", terminal, ["tabs"]], ["the roster", roster, ["tabs", "sidebar"]]]) {
    setActiveContexts(new Set(contexts));
    // Alt+↑/↓ too (#1491 B1): the Ctrl+Alt family leaves the Alt keys to the program, the arrows included.
    for (const init of [{ key: "k", code: "KeyK", altKey: true }, { key: "ArrowLeft", code: "ArrowLeft", altKey: true },
      { key: "ArrowUp", code: "ArrowUp", altKey: true }, { key: "ArrowDown", code: "ArrowDown", altKey: true }]) {
      ran.length = 0;
      const { handled, prevented } = dispatchOn(window, target, init);
      assert.deepEqual(ran, [], `${JSON.stringify(init)} from ${where} runs nothing`);
      assert.equal(handled, false);
      assert.equal(prevented, false, `${JSON.stringify(init)} from ${where} is not preventDefault'ed`);
    }
    for (const [init, id] of [
      [{ key: "k", code: "KeyK", ctrlKey: true, altKey: true }, "app.palette"],
      [{ key: "ArrowLeft", code: "ArrowLeft", altKey: true, shiftKey: true }, "tabs.prevPage"],
    ]) {
      ran.length = 0;
      const { prevented } = dispatchOn(window, target, init);
      assert.deepEqual(ran, [id], `${JSON.stringify(init)} from ${where}`);
      assert.equal(prevented, true, `${id} from ${where} is preventDefault'ed`);
    }
  }
});

// AltGr is never Alt on Linux/Windows (chordFromEvent): a key it presses types its character. Linux
// reports AltGr as AltGraph with altKey and without ctrlKey; Windows as AltGraph with both.
test("AltGr: no Alt chord fires for an AltGr key on Linux or Windows, and nothing is prevented; plain Alt+E is split right", t => {
  const ran = registerRecording(t);
  inFamily(t, "alt");
  const { window, terminal, roster } = aliveDom(t);
  const altGraph = { modifierAltGraph: true };
  const probe = new window.KeyboardEvent("keydown", { key: "€", altKey: true, ...altGraph });
  assert.equal(probe.getModifierState("AltGraph"), true, "jsdom reports AltGraph from modifierAltGraph");
  for (const [where, target, contexts] of [["a terminal", terminal, ["tabs"]], ["the roster", roster, ["tabs", "sidebar"]]]) {
    setActiveContexts(new Set(contexts));
    for (const [shape, init] of [
      ["Linux AltGr+E typing €", { key: "€", code: "KeyE", altKey: true, ctrlKey: false, ...altGraph }],
      // Contrived: AltGr with the plain letter in `key`. Still no Alt+E.
      ["Linux AltGr with key e", { key: "e", code: "KeyE", altKey: true, ctrlKey: false, ...altGraph }],
      ["Linux AltGr+Shift with key E", { key: "E", code: "KeyE", altKey: true, shiftKey: true, ...altGraph }],
      ["Windows AltGr+E typing €", { key: "€", code: "KeyE", altKey: true, ctrlKey: true, ...altGraph }],
    ]) {
      ran.length = 0;
      const { handled, prevented, event } = dispatchOn(window, target, init);
      assert.equal(event.getModifierState("AltGraph"), true);
      assert.deepEqual(ran, [], `${shape} from ${where} fires nothing`);
      assert.equal(handled, false);
      assert.equal(prevented, false, `${shape} from ${where} is not preventDefault'ed`);
    }
    ran.length = 0;
    const plain = dispatchOn(window, target, { key: "e", code: "KeyE", altKey: true });
    assert.equal(plain.event.getModifierState("AltGraph"), false);
    assert.deepEqual(ran, ["split.vertical"], `plain Alt+E from ${where}`);
    assert.equal(plain.prevented, true);
  }
  // As the engine reads them.
  const ev2 = (init) => new window.KeyboardEvent("keydown", init);
  assert.equal(chordToString(chordFromEvent(ev2({ key: "€", code: "KeyE", altKey: true, ...altGraph }), false)), "€", "Linux AltGr: the character, no Alt");
  assert.equal(chordToString(chordFromEvent(ev2({ key: "e", code: "KeyE", altKey: true, ...altGraph }), false)), "E", "no Alt either");
  assert.equal(chordToString(chordFromEvent(ev2({ key: "€", code: "KeyE", altKey: true, ctrlKey: true, ...altGraph }), false)), "Mod+Alt+€", "Windows AltGr: Ctrl+Alt with the character");
  assert.equal(chordToString(chordFromEvent(ev2({ key: "e", code: "KeyE", altKey: true }), false)), "Alt+E");
});

// ---------------------------------------------------------------- the Ctrl+Shift family

// The option (keys.json "chords": "ctrl+shift"; docs/desktop-keyboard.md, "Switch to Ctrl+Shift"): the
// seven rows it moves, as Linux/Windows sends them (with Shift, `key` is the upper-case letter).
const SEVEN = [
  ["app.palette", "K"], ["app.quickOpenSouls", "P"], ["app.workspaces", "S"], ["terminal.focusMode", "M"],
  ["tabs.close", "W"], ["split.vertical", "E"], ["split.horizontal", "D"],
];
function shiftFamily(t) {
  inFamily(t, "ctrl+shift");
}

test("Ctrl+Shift family: every action's Linux/Windows default, as the shortcuts editor and the hints show it", t => {
  registerAll(t);
  shiftFamily(t);
  for (const [id, letter] of SEVEN) {
    assert.equal(getBinding(id, false), `Ctrl+Shift+${letter}`, id);
    assert.equal(formatChord(getBinding(id, false), false), `Ctrl+Shift+${letter}`, `${id} as shown`);
    assert.equal(getBinding(id, true), defaultBinding(id, true, "ctrl+alt"), `${id}: macOS has no family`);
  }
  for (const id of IDS) if (!SEVEN.some(([moved]) => moved === id)) {
    assert.equal(getBinding(id, false), defaultBinding(id, false, "ctrl+alt"), `${id} keeps its key`);
  }
  // The leader is the same in both families, and so are the palette's own group keys.
  assert.equal(getBinding("app.leader", false), "Ctrl+Space");
  assert.equal(paletteGroupHint(false), "Alt+Shift+↓ next group · Alt+Shift+↑ previous");
});

test("Ctrl+Shift family: the seven fire from real (shifted) events, in a terminal and in a text field; their Ctrl+Alt keys are no binding", t => {
  registerAll(t);
  shiftFamily(t);
  const dom = new JSDOM(`<input class="palette-input"><textarea class="ftask"></textarea>`);
  t.after(() => dom.window.close());
  const fields = [...dom.window.document.querySelectorAll("input, textarea")];
  for (const [id, letter] of SEVEN) {
    const press = () => linux(letter, { shiftKey: true });
    assert.equal(matchEvent(press(), { isMac: false, insideTerminal: true }), id, `Ctrl+Shift+${letter} in a terminal`);
    assert.equal(matchEvent(press(), { isMac: false, insideTerminal: false }), id, `Ctrl+Shift+${letter}`);
    for (const target of fields) assert.equal(matchEvent({ ...press(), target }, { isMac: false }), id, `Ctrl+Shift+${letter} in ${target.className}`);
    const claimed = press(); handleKeydown(claimed, { isMac: false, insideTerminal: true });
    assert.equal(claimed.defaultPrevented, true, `${id} is claimed before the pty`);
    // The Ctrl+Alt key of the row is nobody's now: the program gets it (ESC, then the Ctrl+letter byte).
    const old = defaultBinding(id, false, "ctrl+alt");
    const c = parseChord(old);
    const oldPress = linux(c.shift ? c.key.toUpperCase() : c.key, { altKey: true, shiftKey: c.shift });
    assert.equal(matchEvent(oldPress, { isMac: false, insideTerminal: true }), null, `${old} is no binding in the Ctrl+Shift family`);
  }
  // Nor are the seven's Alt family keys (the program gets ESC and the letter).
  for (const [id] of SEVEN) {
    const altKey = defaultBinding(id, false, "alt");
    assert.equal(matchEvent(pressOf(altKey), { isMac: false, insideTerminal: true }), null, `${altKey} is no binding in the Ctrl+Shift family`);
  }
  // In the default family, Alt, and in the Ctrl+Alt family, the seven Ctrl+Shift keys are no binding, in a terminal or anywhere.
  for (const family of ["alt", "ctrl+alt"]) {
    setChordFamily(family);
    for (const [id, letter] of SEVEN) {
      for (const insideTerminal of [true, false]) assert.equal(matchEvent(linux(letter, { shiftKey: true }), { isMac: false, insideTerminal }), null, `Ctrl+Shift+${letter} (${id}), ${family}`);
    }
  }
});

test("Ctrl+Shift family: no two actions share a chord in an overlapping context, and no registered default takes one of the seven", t => {
  registerAll(t);
  shiftFamily(t);
  // Every default of the keymap, in the contexts the shell registers them in.
  for (const id of IDS) {
    const chord = getBinding(id, false);
    if (chord) assert.equal(findConflict(chord, contextOf(id), id, false)?.id ?? null, null, `${id} (${chord})`);
  }
  assert.deepEqual(keymapConflicts(false), []);
  // The seven are no other action's Linux/Windows default, in any context.
  for (const [id, letter] of SEVEN) {
    const taker = IDS.find((other) => other !== id && getBinding(other, false) === `Ctrl+Shift+${letter}`);
    assert.equal(taker, undefined, `Ctrl+Shift+${letter} is ${id}'s alone`);
  }
  // Nor a default a renderer module registers with its action (registerAction's defaultChord: the
  // spawn dialog's Mod+Enter and Mod+1–7, File: open Mod+O, the views' plain keys).
  const registered = [];
  const walk = (dir) => {
    for (const e of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
      if (e.isDirectory()) { if (e.name !== "vendor" && e.name !== "fonts") walk(`${dir}${e.name}/`); continue; }
      if (!e.name.endsWith(".mjs")) continue;
      const src = readFileSync(new URL(`${dir}${e.name}`, import.meta.url), "utf8");
      for (const m of src.matchAll(/defaultChord:\s*"([^"]+)"/g)) registered.push([`${dir}${e.name}`, m[1]]);
    }
  };
  walk("../renderer/");
  assert.ok(registered.some(([, chord]) => chord === "Mod+O") && registered.some(([, chord]) => chord === "Mod+Enter"), "the registrations were read");
  for (const [file, chord] of registered) {
    for (const [id, letter] of SEVEN) assert.notEqual(chordToString(parseChord(chord)), `Ctrl+Shift+${letter}`, `${file}: ${chord} is ${id}'s`);
    // Mod is Ctrl on Linux/Windows: Mod+Shift+letter would be the same key.
    for (const [id, letter] of SEVEN) assert.notEqual(chordToString(parseChord(chord)), `Mod+Shift+${letter}`, `${file}: ${chord} is ${id}'s`);
  }
  // The menu accelerators: the Desktop installs a menu only on macOS, where there is no family; on
  // Linux and Windows there is none, so no accelerator can take a Ctrl+Shift key before the page.
  for (const platform of ["linux", "win32"]) assert.equal(appMenuTemplate(platform, { newWindow() {} }), null, platform);
  const mac = JSON.stringify(appMenuTemplate("darwin", { newWindow() {} }));
  assert.deepEqual([...mac.matchAll(/"accelerator":"([^"]+)"/g)].map((m) => m[1]), ["CmdOrCtrl+Shift+N"], "macOS' one accelerator, New Window, is no key of the seven");
});

test("Ctrl+Shift family: a user's own override of one of the seven still wins, and its old default key stays theirs", t => {
  registerAll(t);
  shiftFamily(t);
  setBinding("app.palette", "Ctrl+Alt+K");
  assert.equal(getBinding("app.palette", false), "Ctrl+Alt+K", "the override, not the family's default");
  assert.equal(matchEvent(linux("k", { altKey: true }), { isMac: false, insideTerminal: true }), "app.palette");
  assert.equal(matchEvent(linux("K", { shiftKey: true }), { isMac: false, insideTerminal: true }), null, "Ctrl+Shift+K is nobody's");
  // An explicit unbind stays unbound in every family, and the override stays the override.
  setBinding("tabs.close", null);
  for (const family of CHORD_FAMILIES) {
    setChordFamily(family);
    assert.equal(getBinding("tabs.close", false), null, family);
    assert.equal(getBinding("app.palette", false), "Ctrl+Alt+K", family);
  }
});

test("Ctrl+Shift family: a stored override on one of the seven keys clashes with the new default, the editor names it, and the user's fires", t => {
  registerAll(t);
  // The palette's 0.66 key, rebound by hand to another action: nobody's default under Alt or Ctrl+Alt.
  setBinding("sidebar.toggle", "Ctrl+Shift+K");
  assert.deepEqual(keymapConflicts(false), [], "no clash in the default family");
  inFamily(t, "ctrl+alt");
  assert.deepEqual(keymapConflicts(false), [], "nor in the Ctrl+Alt family");
  shiftFamily(t);
  assert.deepEqual(keymapConflicts(false).map(c => c.actions.map(a => a.id).sort()), [["app.palette", "sidebar.toggle"]]);
  assert.equal(findConflict("Ctrl+Shift+K", "global", "sidebar.toggle", false)?.id, "app.palette", "the editor's row warning");
  for (const insideTerminal of [false, true]) {
    assert.equal(matchEvent(linux("K", { shiftKey: true }), { isMac: false, insideTerminal }), "sidebar.toggle", `the user's fires (terminal: ${insideTerminal})`);
  }
  // Across contexts too: a global override over a tab-layer default (tabs.close, Ctrl+Shift+W).
  setBinding("app.shortcuts", "Ctrl+Shift+W");
  assert.equal(matchEvent(linux("W", { shiftKey: true }), { isMac: false, insideTerminal: true }), "app.shortcuts");
  assert.equal(matchEvent(linux("W", { shiftKey: true }), { isMac: false, insideTerminal: false }), "app.shortcuts");
  // Reset, the family's default fires.
  resetAllBindings();
  assert.equal(matchEvent(linux("K", { shiftKey: true }), { isMac: false, insideTerminal: true }), "app.palette");
  assert.equal(matchEvent(linux("W", { shiftKey: true }), { isMac: false, insideTerminal: true }), "tabs.close");
});

test("a user's override wins a clash with a default in every family; two overrides keep the context rule", t => {
  registerAll(t);
  inFamily(t, DEFAULT_CHORD_FAMILY);
  for (const family of CHORD_FAMILIES) {
    setChordFamily(family);
    resetAllBindings();
    const close = defaultBinding("tabs.close", false, family); // the tab layer's, Alt+W in the default family
    setBinding("app.workspaces", close);
    assert.equal(matchEvent(pressOf(close), { isMac: false, insideTerminal: true }), "app.workspaces", `${close}, ${family}`);
    setBinding("tabs.close", close); // both the user's: the tab layer's, as before
    assert.equal(matchEvent(pressOf(close), { isMac: false, insideTerminal: true }), "tabs.close", `${close}, ${family}`);
    assert.ok(terminalAllows("app.workspaces", close, false), "allowlisted by id, whatever the chord");
  }
});
