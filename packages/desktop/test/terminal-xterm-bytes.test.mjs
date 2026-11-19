// The terminal rule's guard: on Linux/Windows a chord fires in a terminal only when xterm sends
// nothing for it, or when what it sends is a byte the program still gets from a plainer key, or when
// it is one of the Alt family's, which the program still gets from Esc, then the key
// (docs/desktop-keyboard.md, principle 2). Each terminal-allowlisted action's Linux default, in each
// chord family, is pressed in a real xterm.js Terminal, the installed @xterm/xterm the renderer loads
// (index.html's script tag), and what xterm sends (onData) is pinned exactly. An xterm upgrade that
// starts sending something else for one of them, or a new allowlisted action whose chord sends data
// without a row in its family's table, fails here.
// Windows' AltGr is Ctrl+Alt: a layout's character on a Ctrl+Alt chord (Spanish €, @, #; Polish ą, ę,
// ó, ż) arrives as that character, matches no chord and reaches the program whole; the end of this
// file pins it through the shell's own key path, under xterm's Windows evaluation.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { JSDOM, VirtualConsole } from "jsdom";
import {
  DEFAULT_KEYMAP, TERMINAL_ALLOWLIST, defaultBinding, parseChord,
  registerAction, setActiveContexts, resetAllBindings, setBinding, matchEvent, handleKeydown, setChordFamily,
} from "../renderer/keybindings.mjs";
import { CHORD_FAMILIES, DEFAULT_CHORD_FAMILY } from "../../client/keymap.mjs";
import { terminalOptions, terminalKeyDecision } from "../renderer/terminal-tab.mjs";
import { createLeader } from "../renderer/leader.mjs";

const XTERM = readFileSync(createRequire(import.meta.url).resolve("@xterm/xterm"), "utf8");

// The allowlisted defaults that send something, per chord family, each with the plainer key (or keys,
// one after the other: "Escape, then o") that sends the same.
// The Ctrl+Alt chords send ESC and the Ctrl+letter byte (with Shift too: Ctrl+Alt+Shift+E is ESC
// Ctrl+E), or ESC and the digit, as Alt+digit does.
// The Alt family's Alt+letter and Alt+digit send ESC and the key (with Shift, the upper-case letter):
// exactly what Esc, then the key sends. Its Alt arrows, the tab moves and the workspace moves (which no
// other family has: #1491 B1), send what Ctrl with the arrow sends: xterm.js maps Alt+arrow to Ctrl+arrow on Linux and
// Windows (CSI 1;5 A–D, its "Alt+arrow behaves like Ctrl+arrow" hack), never CSI 1;3 A–D, so Ctrl+arrow
// is their plainer key, byte for byte (the Alt arrows test below pins what Esc, then the arrow sends).
// The named exceptions have none (plainer: null): app.leader, the TUI's leader Ctrl+X, whose 0x18 (the
// shell's Ctrl+X Ctrl+E, nano's exit) the leader pressed twice gives the program; focus.leaveTerminal,
// the way out of a terminal; and the Alt+Shift arrows (CSI 1;4 A–D), which no agent or readline binds:
// the shared previous / next instance in every family, the group moves in the Alt family, the tab moves
// in the other two.
const ctrlAlt = (letter) => ({ data: `\x1b${String.fromCharCode(letter.charCodeAt(0) - 64)}`, plainer: `Escape, then Ctrl+${letter}` });
const alt = (key) => ({ data: `\x1b${key}`, plainer: `Escape, then ${/^[A-Z]$/.test(key) ? `Shift+${key}` : key}` });
const altArrow = (arrow, final) => ({ data: `\x1b[1;5${final}`, plainer: `Ctrl+${arrow}` });
const altShiftArrow = (final) => ({ data: `\x1b[1;4${final}`, plainer: null });
// The same in every family.
const SHARED_SENDS = {
  // D18 (decided 2026-11-19): the Desktop's leader is Ctrl+Space, NUL; the leader pressed twice gives the program its NUL.
  "app.leader": { data: "\x00", plainer: null },
  "roster.openPrevious": altShiftArrow("A"),
  "roster.openNext": altShiftArrow("B"),
  "stage.automations": { data: "\x1b", plainer: "Escape" },
  "tabs.next": { data: "\t", plainer: "Tab" },
  "tabs.prev": { data: "\x1b[Z", plainer: "Shift+Tab" },
  "split.close": ctrlAlt("W"),
  "focus.leaveTerminal": { data: "\x1b[17;6~", plainer: null },
};
const CTRL_ALT_SENDS = {
  ...SHARED_SENDS,
  "app.palette": ctrlAlt("K"),
  "app.quickOpenSouls": ctrlAlt("P"),
  "app.workspaces": ctrlAlt("O"),
  "terminal.focusMode": ctrlAlt("Z"),
  "tabs.nextPage": altShiftArrow("C"),
  "tabs.prevPage": altShiftArrow("D"),
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`tabs.goto${i + 1}`, { data: `\x1b${i + 1}`, plainer: `Alt+${i + 1}` }])),
  "tabs.close": ctrlAlt("W"),
  "split.vertical": ctrlAlt("E"),
  "split.horizontal": ctrlAlt("E"),
  "split.focusPrevGroup": ctrlAlt("A"),
  "split.focusNextGroup": ctrlAlt("A"),
  "sidebar.focusFilter": ctrlAlt("F"),
  "instance.edit": ctrlAlt("R"),
  "app.newAgent": ctrlAlt("N"),
  "agent.viewFocus": ctrlAlt("T"),
};
// The Ctrl+Shift family's seven (below) send nothing; its other rows keep their Ctrl+Alt key.
const SEVEN = { "app.palette": "K", "app.quickOpenSouls": "P", "app.workspaces": "S", "terminal.focusMode": "M",
  "tabs.close": "W", "split.vertical": "E", "split.horizontal": "D" };
const SENDS = {
  alt: {
    ...SHARED_SENDS,
    "app.palette": alt("k"),
    "app.quickOpenSouls": alt("p"),
    "app.workspaces": alt("o"),
    "terminal.focusMode": alt("z"),
    "tabs.nextPage": altArrow("→", "C"),
    "tabs.prevPage": altArrow("←", "D"),
    "workspace.previous": altArrow("↑", "A"),
    "workspace.next": altArrow("↓", "B"),
    ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`tabs.goto${i + 1}`, alt(`${i + 1}`)])),
    "tabs.close": alt("w"),
    "split.vertical": alt("e"),
    "split.horizontal": alt("E"),
    "split.focusPrevGroup": altShiftArrow("D"),
    "split.focusNextGroup": altShiftArrow("C"),
    "sidebar.focusFilter": alt("f"),
    "instance.edit": alt("r"),
    // New agent's Alt+N (the Desktop UI rework): readline's and zsh's history search forward get ESC n from Esc, then n.
    "app.newAgent": alt("n"),
    "agent.viewFocus": alt("t"),
  },
  "ctrl+alt": CTRL_ALT_SENDS,
  "ctrl+shift": Object.fromEntries(Object.entries(CTRL_ALT_SENDS).filter(([id]) => !Object.hasOwn(SEVEN, id))),
};
// The named exceptions of the terminal rule, exactly, per family (docs/desktop-keyboard.md, principle 2).
const EXCEPTIONS = {
  alt: ["app.leader", "focus.leaveTerminal", "roster.openNext", "roster.openPrevious", "split.focusNextGroup", "split.focusPrevGroup"],
  "ctrl+alt": ["app.leader", "focus.leaveTerminal", "roster.openNext", "roster.openPrevious", "tabs.nextPage", "tabs.prevPage"],
  "ctrl+shift": ["app.leader", "focus.leaveTerminal", "roster.openNext", "roster.openPrevious", "tabs.nextPage", "tabs.prevPage"],
};
/** Bind `family`'s defaults for the rest of the test; the default family, Alt, again after it. */
function inFamily(t, family) {
  setChordFamily(family);
  t.after(() => setChordFamily(DEFAULT_CHORD_FAMILY));
}

// What a keyboard reports for a chord's key (KeyboardEvent key/code/keyCode): a description
// of the keydown, not of what xterm does with it.
function keydownInit(chordString) {
  const c = parseChord(chordString);
  assert.ok(c, chordString);
  let key, code, keyCode;
  if (/^[a-z]$/.test(c.key)) {
    key = c.shift ? c.key.toUpperCase() : c.key; code = `Key${c.key.toUpperCase()}`; keyCode = c.key.toUpperCase().charCodeAt(0);
  } else if (/^\d$/.test(c.key)) {
    key = c.key; code = `Digit${c.key}`; keyCode = 48 + Number(c.key);
  } else if (/^f\d{1,2}$/.test(c.key)) {
    key = c.key.toUpperCase(); code = key; keyCode = 111 + Number(c.key.slice(1));
  } else {
    const named = {
      ",": [",", "Comma", 188], "=": ["=", "Equal", 187], "-": ["-", "Minus", 189], "\\": ["\\", "Backslash", 220],
      tab: ["Tab", "Tab", 9], space: [" ", "Space", 32], escape: ["Escape", "Escape", 27],
      arrowup: ["ArrowUp", "ArrowUp", 38], arrowdown: ["ArrowDown", "ArrowDown", 40],
      arrowleft: ["ArrowLeft", "ArrowLeft", 37], arrowright: ["ArrowRight", "ArrowRight", 39],
    }[c.key];
    assert.ok(named, `no keydown description for ${chordString}: add its key here`);
    [key, code, keyCode] = named;
  }
  return { key, code, keyCode, ctrlKey: c.mod || c.ctrl, shiftKey: c.shift, altKey: c.alt, metaKey: false };
}

function xtermTerminal(t, { platform = null, keyHandler = null } = {}) {
  const virtualConsole = new VirtualConsole(); // jsdom has no canvas: xterm's measuring falls back, quietly
  const dom = new JSDOM(`<div id="host"></div>`, { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole });
  t.after(() => dom.window.close());
  const { window } = dom;
  // xterm reads navigator.platform once, as its bundle loads: set before it, it evaluates keys as there.
  if (platform) Object.defineProperty(window.navigator, "platform", { value: platform, configurable: true });
  // xterm watches the device pixel ratio through matchMedia, which jsdom lacks.
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  window.eval(XTERM); // the UMD bundle defines window.Terminal, as the renderer's script tag does
  // navigator.platform is empty in jsdom, so xterm evaluates keys as on Linux (neither macOS nor Windows).
  const term = new window.Terminal(terminalOptions({ fontSize: 15, fontFamily: "monospace", fontWeight: "normal", theme: {} }));
  term.open(window.document.getElementById("host"));
  t.after(() => term.dispose());
  const textarea = window.document.querySelector(".xterm-helper-textarea");
  assert.ok(textarea, "xterm opened");
  let sent = [];
  term.onData(data => sent.push(data));
  // The shell's key path in front of xterm (terminal-tab.mjs attaches the same handler), when given.
  if (keyHandler) term.attachCustomKeyEventHandler(keyHandler);
  const press = (init) => {
    sent = [];
    textarea.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    return sent.join("");
  };
  /** Events one after the other ([type, init]: keydown, keypress), on xterm's textarea: what xterm sends
   * for all of them, and the events dispatched. */
  press.sequence = (events) => {
    sent = [];
    const dispatched = events.map(([type, init]) => {
      const e = new window.KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
      textarea.dispatchEvent(e);
      return e;
    });
    return { data: sent.join(""), events: dispatched };
  };
  press.isMac = /Mac/.test(window.navigator.platform);
  press.isWindows = /Win/.test(window.navigator.platform);
  press.textarea = textarea;
  press.window = window;
  return press;
}

/** Two chords that are one key on Linux/Windows, where Mod is Ctrl. */
function sameLinuxChord(a, b) {
  const [x, y] = [parseChord(a), parseChord(b)];
  return !!x && !!y && x.key === y.key && (x.mod || x.ctrl) === (y.mod || y.ctrl) && x.alt === y.alt && x.shift === y.shift;
}

/** A key as a browser gives it: its keydown, then, for a key that types a character (no Ctrl or Alt:
 * `o`, Shift+E) and whose keydown nobody prevented, its keypress (xterm sends an upper-case letter
 * from its keypress, a lower-case one from its keydown, which it then prevents). What xterm sends. */
const pressKey = (press, chord) => {
  const init = keydownInit(chord);
  if (init.ctrlKey || init.altKey || [...init.key].length !== 1) return press(init);
  const sent = [];
  const down = press.sequence([["keydown", init]]);
  sent.push(down.data);
  const code = init.key.codePointAt(0);
  if (!down.events[0].defaultPrevented) sent.push(press.sequence([["keypress", { ...init, charCode: code, keyCode: code, which: code }]]).data);
  return sent.join("");
};
/** A plainer key, or keys pressed one after the other ("Escape, then o"): what they send together. */
const pressPlainer = (press, plainer) => plainer.split(", then ").map(chord => pressKey(press, chord)).join("");

test("the harness sees what xterm sends: Ctrl+B is the tmux prefix byte; a typed key is its character, once", t => {
  const press = xtermTerminal(t);
  assert.equal(press(keydownInit("Ctrl+B")), "\x02");
  assert.equal(press(keydownInit("Ctrl+P")), "\x10");
  assert.equal(press(keydownInit("Shift+E")), "", "an upper-case letter's keydown alone sends nothing: its keypress does");
  assert.equal(pressPlainer(press, "o"), "o");
  assert.equal(pressPlainer(press, "Shift+E"), "E");
  assert.equal(pressPlainer(press, "1"), "1");
});

for (const family of CHORD_FAMILIES) {
  test(`every terminal-allowlisted Linux default sends nothing, or exactly its row (${family})`, t => {
    inFamily(t, family);
    const press = xtermTerminal(t);
    for (const id of TERMINAL_ALLOWLIST) {
      const chord = defaultBinding(id, false);
      // The workspace moves have no key outside the Alt family: Alt+↑/↓ are the program's there (#1491 B1).
      if (family !== "alt" && /^workspace\./.test(id)) { assert.equal(chord, null, `${id}: no key in ${family}`); continue; }
      assert.ok(chord, `${id} has a Linux/Windows default`);
      assert.equal(press(keydownInit(chord)), SENDS[family][id]?.data ?? "", `${id} (${chord}), ${family}`);
    }
    for (const id of Object.keys(SENDS[family])) assert.ok(TERMINAL_ALLOWLIST.includes(id), `${id}'s row is for an allowlisted action`);
  });

  test(`each byte an allowlisted default takes is one the program still gets from a plainer key (${family})`, t => {
    inFamily(t, family);
    const press = xtermTerminal(t);
    for (const [id, { data, plainer }] of Object.entries(SENDS[family])) {
      if (!plainer) continue;
      assert.equal(pressPlainer(press, plainer), data, `${id}: ${plainer} sends the same, ${family}`);
      // A plainer key is one no default takes in a terminal: the program still gets it there.
      for (const chord of plainer.split(", then ")) {
        const taker = TERMINAL_ALLOWLIST.find(other => sameLinuxChord(defaultBinding(other, false), chord));
        assert.equal(taker, undefined, `${id}: its plainer ${chord} is ${taker}'s in a terminal, ${family}`);
      }
    }
    assert.deepEqual(Object.keys(SENDS[family]).filter(id => SENDS[family][id].plainer === null).sort(), EXCEPTIONS[family], `the named exceptions, and no other, ${family}`);
  });
}

// The exact sequences of the Alt family's keys, as the installed xterm sends them (Linux evaluation).
test("Alt family: the exact bytes of its keys, and ESC with a letter or a digit is exactly Esc, then that key", t => {
  inFamily(t, "alt");
  const press = xtermTerminal(t);
  for (const [chord, data] of [
    ["Alt+K", "\x1bk"], ["Alt+P", "\x1bp"], ["Alt+O", "\x1bo"], ["Alt+Z", "\x1bz"], ["Alt+W", "\x1bw"], ["Alt+E", "\x1be"],
    ["Alt+Shift+E", "\x1bE"], ["Alt+F", "\x1bf"], ["Alt+R", "\x1br"], ["Alt+1", "\x1b1"], ["Alt+9", "\x1b9"],
    ["Alt+Shift+←", "\x1b[1;4D"], ["Alt+Shift+→", "\x1b[1;4C"], ["Alt+Shift+↑", "\x1b[1;4A"], ["Alt+Shift+↓", "\x1b[1;4B"],
    // xterm.js's Alt arrows are Ctrl's (CSI 1;5), not CSI 1;3.
    ["Alt+←", "\x1b[1;5D"], ["Alt+→", "\x1b[1;5C"], ["Alt+↑", "\x1b[1;5A"], ["Alt+↓", "\x1b[1;5B"],
  ]) assert.equal(press(keydownInit(chord)), data, chord);
  for (const key of ["k", "p", "o", "z", "w", "e", "E", "f", "r", ..."123456789"]) {
    const chord = /^[A-Z]$/.test(key) ? `Alt+Shift+${key}` : `Alt+${key}`;
    assert.equal(press(keydownInit(chord)), pressPlainer(press, `Escape, then ${/^[A-Z]$/.test(key) ? `Shift+${key}` : key}`), `${chord} is Esc, then ${key}`);
  }
});

// The Alt arrows (the Alt family's tab moves and workspace moves): xterm.js
// sends Ctrl+arrow's CSI 1;5 for them on Linux and Windows, where a terminal such as xterm or kitty sends
// CSI 1;3. Ctrl+arrow, which no default takes, sends exactly the same bytes. Esc, then the arrow, the key a
// program that binds the Meta arrow reads as it (ESC as Meta), sends ESC and the arrow's own sequence:
// not the same bytes, which this pins rather than claiming they are.
test("the Alt arrows: xterm sends Ctrl+arrow's CSI 1;5 for them; Esc, then the arrow is ESC and the arrow's own sequence", t => {
  const press = xtermTerminal(t);
  for (const [arrow, final] of [["←", "D"], ["→", "C"], ["↑", "A"], ["↓", "B"]]) {
    const sent = press(keydownInit(`Alt+${arrow}`));
    assert.equal(sent, `\x1b[1;5${final}`, `Alt+${arrow}`);
    assert.notEqual(sent, `\x1b[1;3${final}`, `Alt+${arrow} is not CSI 1;3${final} in xterm.js`);
    assert.equal(press(keydownInit(`Ctrl+${arrow}`)), sent, `Ctrl+${arrow} sends the same`);
    const plain = press(keydownInit(arrow));
    assert.equal(plain, `\x1b[${final}`, arrow);
    assert.equal(pressPlainer(press, `Escape, then ${arrow}`), `\x1b${plain}`, `Esc, then ${arrow}: ESC and the arrow`);
    assert.notEqual(`\x1b${plain}`, sent);
  }
  // Which defaults hold them, per family: the tab moves and the workspace moves in the Alt family, none in
  // the other two (their tab moves are the Alt+Shift arrows, and they leave Alt+↑/↓ to the program).
  for (const [family, ids] of [["alt", ["tabs.prevPage", "tabs.nextPage", "workspace.previous", "workspace.next"]],
    ["ctrl+alt", []], ["ctrl+shift", []]]) {
    const holders = TERMINAL_ALLOWLIST.filter(id => /^Alt\+[←→↑↓]$/.test(defaultBinding(id, false, family) ?? ""));
    assert.deepEqual(holders.sort(), [...ids].sort(), family);
  }
});

test("the Alt+Shift arrows, a named exception: no plainer arrow sends their sequence", t => {
  const press = xtermTerminal(t);
  // The instances in every family; the groups in the Alt family; the tabs in the other two.
  for (const [family, rows] of [
    ["alt", [["roster.openPrevious", "↑"], ["roster.openNext", "↓"], ["split.focusPrevGroup", "←"], ["split.focusNextGroup", "→"]]],
    ["ctrl+alt", [["roster.openPrevious", "↑"], ["roster.openNext", "↓"], ["tabs.prevPage", "←"], ["tabs.nextPage", "→"]]],
    ["ctrl+shift", [["roster.openPrevious", "↑"], ["roster.openNext", "↓"], ["tabs.prevPage", "←"], ["tabs.nextPage", "→"]]],
  ]) for (const [id, arrow] of rows) {
    assert.equal(defaultBinding(id, false, family), `Alt+Shift+${arrow}`, `${id}, ${family}`);
    for (const plainer of [arrow, `Shift+${arrow}`, `Alt+${arrow}`, `Ctrl+${arrow}`, `Ctrl+Shift+${arrow}`, `Ctrl+Alt+${arrow}`]) {
      assert.notEqual(press(keydownInit(plainer)), SENDS[family][id].data, `${plainer} does not send ${id}'s sequence`);
    }
    assert.notEqual(pressPlainer(press, `Escape, then Shift+${arrow}`), SENDS[family][id].data, `nor Esc, then Shift+${arrow}`);
  }
});

// The leader is Ctrl+Space on every platform in the Desktop (D18; Ctrl+X, keymap.mjs LEADER, is the other choice), which
// fires in a terminal by the allowlist on Linux/Windows and by name on macOS (principle 3's exception). Pressed twice,
// its second press is the program's: what xterm sends for it, NUL (Ctrl+X: 0x18, CAN), pinned here under xterm's
// Linux, Windows and macOS evaluation (navigator.platform set before load). The end of this file runs it through the leader.
test("the leader, Ctrl+Space, is NUL in xterm on every platform (Ctrl+X, the other choice, 0x18), which the leader pressed twice gives the program", t => {
  for (const [platform, isMac] of [[null, false], ["Win32", false], ["MacIntel", true]]) {
    const press = xtermTerminal(t, { platform });
    assert.equal(press.isMac, isMac, `xterm loaded under ${platform ?? "Linux"}`);
    assert.equal(defaultBinding("app.leader", isMac), "Ctrl+Space");
    assert.equal(press(keydownInit(defaultBinding("app.leader", isMac))), "\x00", platform ?? "Linux");
    assert.equal(press(keydownInit("Ctrl+X")), "\x18", `${platform ?? "Linux"}: the Ctrl+X choice`);
  }
  // ⌃\, the macOS leader before 0.67, which macOS still fires by name when bound back: 0x1c (FS, SIGQUIT's byte).
  assert.equal(xtermTerminal(t, { platform: "MacIntel" })(keydownInit("Ctrl+\\")), "\x1c");
});

// ---------------------------------------------------------------- macOS: the ⌥ arrows

// macOS moves between tabs, groups and workspaces with ⌥ and an arrow (the product owner's call, 2026-10-23), which fire
// in a terminal by name (keybindings.mjs macStructuralChord). Under xterm's macOS evaluation (navigator.platform
// set before load) this is what the program would get without them: for ⌥←/→ readline's word moves, ESC b and
// ESC f (xterm.js's macOS form of its "Alt+arrow moves a word" hack, whatever macOptionIsMeta says), which
// Esc, then b or f still sends; for ⌥↑/↓ CSI 1;3 A/B; for ⌥⇧ with an arrow CSI 1;4. Behind the shell's key
// path the chord takes each: its move runs and the program gets nothing. A user who wants the bytes back
// unbinds or rebinds the move in the shortcuts editor (docs/desktop-keyboard.md).
const MAC_ARROW_SENDS = {
  "tabs.prevPage": "\x1bb", "tabs.nextPage": "\x1bf",
  "split.focusPrevGroup": "\x1b[1;4D", "split.focusNextGroup": "\x1b[1;4C",
  "workspace.previous": "\x1b[1;3A", "workspace.next": "\x1b[1;3B",
};
/** The shell's interceptKey (shell.mjs) behind terminal-tab.mjs's custom key handler, on macOS. */
const macKeyPath = (event) => {
  const interceptKey = (ev) => {
    if (!matchEvent(ev, { isMac: true, insideTerminal: true })) return false;
    if (ev.type === "keydown") handleKeydown(ev, { isMac: true, insideTerminal: true });
    return true;
  };
  return !terminalKeyDecision(event, interceptKey).handled;
};

test("macOS: what xterm sends for the ⌥ arrow moves, and in a terminal each runs its move and sends the program nothing", t => {
  const bare = xtermTerminal(t, { platform: "MacIntel" });
  assert.equal(bare.isMac, true, "xterm loaded under macOS");
  for (const [id, data] of Object.entries(MAC_ARROW_SENDS)) {
    const chord = defaultBinding(id, true);
    assert.match(chord, /^Alt\+(Shift\+)?[←→↑↓]$/, `${id}: ⌥ with an arrow`);
    assert.equal(bare(keydownInit(chord)), data, `${id} (${chord})`);
  }
  assert.equal(pressPlainer(bare, "Escape, then b"), MAC_ARROW_SENDS["tabs.prevPage"], "Esc, then b is still readline's backward-word");
  assert.equal(pressPlainer(bare, "Escape, then f"), MAC_ARROW_SENDS["tabs.nextPage"], "and Esc, then f its forward-word");
  const ran = registerDefaults(t);
  const press = xtermTerminal(t, { platform: "MacIntel", keyHandler: macKeyPath });
  for (const id of Object.keys(MAC_ARROW_SENDS)) {
    ran.length = 0;
    const { data, events } = press.sequence([["keydown", keydownInit(defaultBinding(id, true))]]);
    assert.deepEqual(ran, [id], `${id} runs in a terminal`);
    assert.equal(data, "", `${id}: no byte reaches the pty`);
    assert.equal(events[0].defaultPrevented, true, `${id} is claimed`);
  }
  // Unbound (the shortcuts editor's Backspace), ⌥← and ⌥→ are the program's word moves again.
  setBinding("tabs.prevPage", null); setBinding("tabs.nextPage", null);
  ran.length = 0;
  assert.equal(press.sequence([["keydown", keydownInit("Alt+←")]]).data, "\x1bb");
  assert.equal(press.sequence([["keydown", keydownInit("Alt+→")]]).data, "\x1bf");
  assert.deepEqual(ran, []);
});

// ---------------------------------------------------------------- the Alt family through the shell's key path

/** The shell's interceptKey (shell.mjs) behind terminal-tab.mjs's custom key handler, on Linux. */
const linuxKeyPath = (event) => {
  const interceptKey = (ev) => {
    if (!matchEvent(ev, { isMac: false, insideTerminal: true })) return false;
    if (ev.type === "keydown") handleKeydown(ev, { isMac: false, insideTerminal: true });
    return true;
  };
  return !terminalKeyDecision(event, interceptKey).handled;
};

// The Alt family's keys are claimed in a terminal: each runs its action and xterm sends the program
// nothing, the Alt arrows included; in the other two families the same keys are no binding, Alt+↑/↓
// too (#1491 B1), and reach the program as the rows above pin.
test("Alt family: each of its keys in a terminal runs its action and sends the program nothing; in the other families it reaches the program", t => {
  const ran = registerDefaults(t);
  inFamily(t, "alt");
  const press = xtermTerminal(t, { keyHandler: linuxKeyPath });
  const altKeys = TERMINAL_ALLOWLIST.filter(id => /^Alt\+/.test(defaultBinding(id, false, "alt")));
  for (const id of ["tabs.prevPage", "tabs.nextPage", "workspace.previous", "workspace.next", "split.focusPrevGroup", "split.focusNextGroup", "app.palette", "tabs.goto1"]) {
    assert.ok(altKeys.includes(id), `${id} is an Alt key of the Alt family`);
  }
  for (const family of CHORD_FAMILIES) {
    setChordFamily(family);
    for (const id of altKeys) {
      const chord = defaultBinding(id, false, "alt");
      ran.length = 0;
      const { data, events } = press.sequence([["keydown", keydownInit(chord)]]);
      const holder = TERMINAL_ALLOWLIST.find(other => sameLinuxChord(defaultBinding(other, false, family), chord));
      if (holder) {
        assert.deepEqual(ran, [holder], `${chord} runs ${holder}, ${family}`);
        assert.equal(data, "", `${chord} is claimed: no byte reaches the pty, ${family}`);
        assert.equal(events[0].defaultPrevented, true, `${chord} is claimed, ${family}`);
      } else {
        assert.deepEqual(ran, [], `${chord} is no binding in ${family}`);
        // xterm itself prevents a keydown it sends data for: what shows the key is the program's is its bytes.
        assert.equal(data, SENDS.alt[id].data, `${chord} reaches the program, ${family}`);
      }
      if (family === "alt") assert.equal(holder, id, `${chord} is ${id}'s in the Alt family`);
    }
  }
  // The Alt arrows, by name: in the Alt family all four are the Desktop's; in the Ctrl+Alt and Ctrl+Shift
  // families all four are the program's (CSI 1;5 A–D), the workspace moves' ↑/↓ included (#1491 B1).
  setChordFamily("alt");
  for (const [arrow, id] of [["←", "tabs.prevPage"], ["→", "tabs.nextPage"], ["↑", "workspace.previous"], ["↓", "workspace.next"]]) {
    ran.length = 0;
    assert.equal(press.sequence([["keydown", keydownInit(`Alt+${arrow}`)]]).data, "", `Alt+${arrow}: nothing reaches the pty`);
    assert.deepEqual(ran, [id]);
  }
  for (const family of ["ctrl+alt", "ctrl+shift"]) {
    setChordFamily(family);
    for (const [arrow, final] of [["←", "D"], ["→", "C"], ["↑", "A"], ["↓", "B"]]) {
      ran.length = 0;
      assert.equal(press.sequence([["keydown", keydownInit(`Alt+${arrow}`)]]).data, `\x1b[1;5${final}`, `Alt+${arrow} is the program's under ${family}`);
      assert.deepEqual(ran, []);
    }
  }
});

// ---------------------------------------------------------------- the Ctrl+Shift family

// The option (keys.json "chords": "ctrl+shift"; docs/desktop-keyboard.md, "Switch to Ctrl+Shift"):
// seven rows take Ctrl+Shift+letter (SEVEN, above), which xterm sends nothing for (its Ctrl+letter bytes
// need Shift up), so by the rule they fire in a terminal. The allowlist is by action id and does not
// change; the keys are the family's, so the Ctrl+Shift keys are chords only while the option is on.
test("Ctrl+Shift family: the seven send nothing, and have no row of their own", t => {
  inFamily(t, "ctrl+shift");
  const press = xtermTerminal(t);
  for (const [id, letter] of Object.entries(SEVEN)) {
    assert.ok(TERMINAL_ALLOWLIST.includes(id), `${id} is allowlisted`);
    assert.equal(defaultBinding(id, false), `Ctrl+Shift+${letter}`, id);
    assert.equal(press(keydownInit(`Ctrl+Shift+${letter}`)), "", `Ctrl+Shift+${letter} (${id}) sends nothing`);
    assert.equal(SENDS["ctrl+shift"][id], undefined, `${id} has no row in the Ctrl+Shift family`);
  }
});

test("the Ctrl+Shift keys are chords only while the option is on, and each fires in a terminal then", t => {
  const ran = registerDefaults(t);
  inFamily(t, DEFAULT_CHORD_FAMILY);
  const press = xtermTerminal(t, { keyHandler: linuxKeyPath });
  for (const family of CHORD_FAMILIES) {
    setChordFamily(family);
    for (const [id, letter] of Object.entries(SEVEN)) {
      ran.length = 0;
      const { data, events } = press.sequence([["keydown", keydownInit(`Ctrl+Shift+${letter}`)]]);
      assert.equal(data, "", `Ctrl+Shift+${letter}: xterm sends nothing, ${family}`);
      if (family === "ctrl+shift") {
        assert.deepEqual(ran, [id], `Ctrl+Shift+${letter} runs ${id} in a terminal`);
        assert.equal(events[0].defaultPrevented, true, `Ctrl+Shift+${letter} is claimed`);
      } else {
        assert.deepEqual(ran, [], `Ctrl+Shift+${letter} is no binding under ${family}`);
        assert.equal(events[0].defaultPrevented, false);
      }
      // The row's key in each of the other two families: the Desktop's in its own family, the
      // program's (as SENDS pins it) in the others.
      for (const keyFamily of ["alt", "ctrl+alt"]) {
        ran.length = 0;
        const key = defaultBinding(id, false, keyFamily);
        const sent = press.sequence([["keydown", keydownInit(key)]]);
        if (family === keyFamily) {
          assert.deepEqual(ran, [id], `${key} runs ${id} under ${family}`);
          assert.equal(sent.data, "", `${key} is claimed: the program gets nothing`);
        } else {
          assert.deepEqual(ran, [], `${key} is no binding under ${family}`);
          assert.equal(sent.data, SENDS[keyFamily][id].data, `${key} reaches the program under ${family}`);
        }
      }
    }
  }
});

// ---------------------------------------------------------------- AltGr (Windows)

// On Windows, Ctrl+Alt IS AltGr: Chromium reports the layout's character in `key` (the physical key in
// `code`, ctrlKey and altKey both true), then a keypress with the character, which is what xterm sends
// (its keydown passes Ctrl+Alt+key over as a third-level shift on Windows, and its keypress handler
// sends the character; an input event alone sends nothing). The engine matches on `key`
// (chordFromEvent), so such a key matches no chord, in a terminal or in a text field, and the program
// gets the character, in every chord family. Where the layout types nothing on the chord, `key` is the
// plain letter and, in the Ctrl+Alt family, the shared chord is the Desktop's (Spanish Ctrl+Alt+K, the
// palette); in the Alt family, the default, Ctrl+Alt+letter is no binding.
const ALTGR = {
  Spanish: [["e", "€"], ["1", "|"], ["2", "@"], ["3", "#"]],
  Polish: [["a", "ą"], ["e", "ę"], ["o", "ó"], ["z", "ż"]],
};
const physical = (k) => (/^\d$/.test(k) ? { code: `Digit${k}`, keyCode: 48 + Number(k) } : { code: `Key${k.toUpperCase()}`, keyCode: k.toUpperCase().charCodeAt(0) });
/** The events Chromium on Windows gives for AltGr (Ctrl+Alt) and physical key `k` typing `char`. */
const altGrEvents = (k, char) => [
  ["keydown", { key: char, ...physical(k), ctrlKey: true, altKey: true, modifierAltGraph: true }],
  ["keypress", { key: char, code: physical(k).code, charCode: char.codePointAt(0), keyCode: char.codePointAt(0), which: char.codePointAt(0), ctrlKey: true, altKey: true, modifierAltGraph: true }],
];

/** Every default action registered, in the shell's contexts with the tab layer on (localStorage-less:
 * the shipped defaults). */
function registerDefaults(t) {
  resetAllBindings();
  const contextOf = id => (/^(tabs|split)\./.test(id) ? "tabs" : /^sidebar\.key\./.test(id) ? "sidebar" : "global");
  const ran = [];
  const offs = Object.keys(DEFAULT_KEYMAP).map(id => registerAction({ id, label: id, context: contextOf(id), run: () => ran.push(id) }));
  setActiveContexts(new Set(["tabs"]));
  t.after(() => { offs.forEach(off => off()); setActiveContexts(new Set()); resetAllBindings(); });
  return ran;
}
/** The shell's interceptKey (shell.mjs) behind terminal-tab.mjs's custom key handler, on Windows. */
const windowsKeyPath = (event) => {
  const interceptKey = (ev) => {
    if (!matchEvent(ev, { isMac: false, insideTerminal: true })) return false;
    if (ev.type === "keydown") handleKeydown(ev, { isMac: false, insideTerminal: true });
    return true;
  };
  return !terminalKeyDecision(event, interceptKey).handled;
};

test("Windows AltGr: a layout's character on a Ctrl+Alt chord matches no chord and reaches the program, in every family", t => {
  const ran = registerDefaults(t);
  inFamily(t, DEFAULT_CHORD_FAMILY);
  const press = xtermTerminal(t, { platform: "Win32", keyHandler: windowsKeyPath });
  assert.equal(press.isWindows, true, "xterm loaded under the Windows platform");
  const dom = new JSDOM(`<input class="palette-input"><textarea class="ftask"></textarea>`);
  t.after(() => dom.window.close());
  const fields = [...dom.window.document.querySelectorAll("input, textarea")];
  for (const family of CHORD_FAMILIES) for (const [layout, keys] of Object.entries(ALTGR)) for (const [k, char] of keys) {
    setChordFamily(family);
    const name = `${layout} Ctrl+Alt+${k.toUpperCase()} (${char}), ${family}`;
    const [[, down]] = altGrEvents(k, char);
    // The engine: nothing matches, in a terminal or in a text field, so nothing is prevented.
    assert.equal(matchEvent({ ...down }, { isMac: false, insideTerminal: true }), null, `${name} in a terminal`);
    for (const target of fields) {
      const e = { ...down, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      assert.equal(matchEvent(e, { isMac: false }), null, `${name} in ${target.className}`);
      assert.equal(handleKeydown(e, { isMac: false }), false); assert.equal(e.defaultPrevented, false, `${name}: ${target.className} types it`);
    }
    // xterm, behind the shell's key path: exactly the character.
    const { data, events } = press.sequence(altGrEvents(k, char));
    assert.equal(data, char, `${name} reaches the program`);
    assert.equal(events[0].defaultPrevented, false, `${name}: the keydown is not claimed`);
  }
  assert.deepEqual(ran, [], "no action ran");
  // A plain Ctrl+Alt+E keydown (no AltGr character) is split right in the Ctrl+Alt family: the layouts'
  // own key is the only thing between the two. In the Alt family split right is Alt+E, and Ctrl+Alt+E nothing.
  const plainE = { key: "e", code: "KeyE", ctrlKey: true, altKey: true };
  setChordFamily("ctrl+alt");
  assert.equal(matchEvent({ ...plainE }, { isMac: false, insideTerminal: true }), "split.vertical");
  setChordFamily("alt");
  assert.equal(matchEvent({ ...plainE }, { isMac: false, insideTerminal: true }), null);
  assert.equal(matchEvent({ key: "e", code: "KeyE", altKey: true }, { isMac: false, insideTerminal: true }), "split.vertical");
});

test("Windows, Ctrl+Alt family: where AltGr types nothing, the shared Ctrl+Alt chords are the Desktop's, in a terminal and in a text field", t => {
  const ran = registerDefaults(t);
  inFamily(t, "ctrl+alt");
  const press = xtermTerminal(t, { platform: "Win32", keyHandler: windowsKeyPath });
  const dom = new JSDOM(`<input class="palette-input">`);
  t.after(() => dom.window.close());
  const input = dom.window.document.querySelector("input");
  // Spanish and Polish type nothing on K, P, W, F; Spanish nothing on O, Z, A either.
  for (const [layout, k, id] of [
    ["Spanish", "k", "app.palette"], ["Spanish", "p", "app.quickOpenSouls"], ["Spanish", "w", "tabs.close"], ["Spanish", "f", "sidebar.focusFilter"],
    ["Spanish", "o", "app.workspaces"], ["Spanish", "z", "terminal.focusMode"], ["Spanish", "a", "split.focusNextGroup"], ["Spanish", "9", "tabs.goto9"],
    ["Polish", "k", "app.palette"], ["Polish", "p", "app.quickOpenSouls"], ["Polish", "w", "tabs.close"], ["Polish", "f", "sidebar.focusFilter"],
  ]) {
    const name = `${layout} Ctrl+Alt+${k.toUpperCase()}`;
    const down = { key: k, ...physical(k), ctrlKey: true, altKey: true };
    assert.equal(matchEvent({ ...down, target: input }, { isMac: false }), id, `${name} in a text field`);
    ran.length = 0;
    const { data, events } = press.sequence([["keydown", down]]);
    assert.deepEqual(ran, [id], `${name} runs ${id} in a terminal`);
    assert.equal(data, "", `${name} sends the program nothing`);
    assert.equal(events[0].defaultPrevented, true, `${name} is claimed`);
    // In the Alt family the same key is no binding: nothing runs and nothing is claimed.
    setChordFamily("alt");
    ran.length = 0;
    assert.equal(matchEvent({ ...down, target: input }, { isMac: false }), null, `${name} in a text field, alt`);
    const inAlt = press.sequence([["keydown", down]]);
    assert.deepEqual(ran, [], `${name} runs nothing in the Alt family`);
    assert.equal(inAlt.events[0].defaultPrevented, false, `${name} is not claimed in the Alt family`);
    setChordFamily("ctrl+alt");
  }
});

// ---------------------------------------------------------------- the leader

/** The shell's interceptKey (shell.mjs) behind terminal-tab.mjs's custom key handler, on a platform. */
const shellKeyPath = (isMac) => (event) => {
  const interceptKey = (ev) => {
    if (!matchEvent(ev, { isMac, insideTerminal: true })) return false;
    if (ev.type === "keydown") handleKeydown(ev, { isMac, insideTerminal: true });
    return true;
  };
  return !terminalKeyDecision(event, interceptKey).handled;
};

// The leader through the shell's key path and its engine (renderer/leader.mjs), as the shell wires it:
// Ctrl+X opens it and sends the program nothing; pressed again it closes the wait and is let through,
// so xterm sends 0x18, once. Alt+O, the Linux/Windows leader before 0.67, is not the leader: with the
// leader alone registered it reaches the program as ESC o (in the Alt family, with every default
// registered, it is the workspace switcher's: keymap-linux.test.mjs).
for (const [platform, isMac] of [[null, false], ["Win32", false], ["MacIntel", true]]) {
  test(`the leader in a terminal (${platform ?? "Linux"}): Ctrl+Space sends nothing, twice sends NUL once, Alt+O is not the leader`, t => {
    resetAllBindings();
    const press = xtermTerminal(t, { platform, keyHandler: shellKeyPath(isMac) });
    const log = [];
    const leader = createLeader({ win: press.window, isMac,
      onOpen: () => log.push("open"), onSettle: does => log.push(does), onClose: why => log.push(why) });
    const off = registerAction({ id: "app.leader", label: "Leader", context: "global", run: () => leader.start({ from: "terminal" }) });
    t.after(() => { off(); leader.dispose(); resetAllBindings(); });
    const ctrlX = keydownInit(defaultBinding("app.leader", isMac));
    const first = press.sequence([["keydown", ctrlX]]);
    assert.equal(first.data, "", "the leader itself sends nothing");
    assert.equal(first.events[0].defaultPrevented, true, "claimed before the pty");
    assert.ok(leader.isWaiting());
    const second = press.sequence([["keydown", ctrlX]]);
    assert.equal(second.data, "\x00", "the leader pressed twice: exactly NUL, once");
    assert.equal(leader.isWaiting(), false);
    assert.deepEqual(log, ["open", "again"], "nothing ran");
    // xterm's macOS evaluation reads ⌥O as the third-level ø (no macOptionIsMeta), so only elsewhere is it ESC o.
    const altO = press.sequence([["keydown", keydownInit("Alt+O")]]);
    if (!isMac) assert.equal(altO.data, "\x1bo", "Alt+O reaches the program as ESC o");
    assert.equal(leader.isWaiting(), false, "Alt+O opens nothing");
    assert.deepEqual(log, ["open", "again"]);
  });
}

// Shift+PgUp / Shift+PgDn (#1502): xterm.js takes them to scroll its own viewport and sends nothing,
// which on tmux's alternate screen scrolls nothing. Through the shell's key path (terminal-tab.mjs
// writes the decision's byte to the pty), they reach tmux as S-PPage and S-NPage, and xterm sends nothing.
test("Shift+PgUp and Shift+PgDn: xterm alone sends nothing; through the shell's key path tmux gets CSI 5;2 ~ and CSI 6;2 ~", t => {
  const page = (key, init = {}) => ({ key, code: key, keyCode: key === "PageUp" ? 33 : 34, shiftKey: true, ...init });
  const bare = xtermTerminal(t);
  assert.equal(bare(page("PageUp")), "", "xterm keeps Shift+PgUp for its own viewport");
  assert.equal(bare(page("PageDown")), "");
  assert.equal(bare(page("PageUp", { shiftKey: false })), "\x1b[5~", "plain PgUp still reaches the program as xterm sends it");
  const written = [];
  const shellKeyPath = (event) => {
    const { handled, byte } = terminalKeyDecision(event, () => false);
    if (!handled) return true;
    if (byte !== null) written.push(byte);
    return false;
  };
  const press = xtermTerminal(t, { keyHandler: shellKeyPath });
  for (const [key, bytes] of [["PageUp", "\x1b[5;2~"], ["PageDown", "\x1b[6;2~"]]) {
    written.length = 0;
    const { data } = press.sequence([["keydown", page(key)], ["keyup", page(key)]]);
    assert.equal(data, "", `${key}: xterm sends nothing of its own`);
    assert.deepEqual(written, [bytes], `Shift+${key}: the shell writes tmux's key, once`);
  }
  written.length = 0;
  assert.equal(press(page("PageUp", { shiftKey: false })), "\x1b[5~", "plain PgUp is untouched");
  assert.deepEqual(written, []);
});
