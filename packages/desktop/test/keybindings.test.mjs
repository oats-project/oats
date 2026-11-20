import test from "node:test";
import assert from "node:assert/strict";
import {
  parseChord, formatChord, chordToString, chordFromEvent, normalizeKey,
  DEFAULT_KEYMAP, TERMINAL_ALLOWLIST, CONTEXTS, defaultBinding,
  registerAction, listActions, setActiveContexts,
  getBinding, setBinding, resetBinding, resetAllBindings, onKeymapChange,
  matchEvent, handleKeydown, findConflict, keymapConflicts,
  chordFromKeyId, letThrough, eventMatchesBinding, runAction, pickerCycleDirection, setChordFamily, activeChordFamily,
} from "../renderer/keybindings.mjs";

// Minimal localStorage stub — the engine must survive without it too.
function installStorage() {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  return map;
}
installStorage();

const ev = (key, overrides = {}) => ({
  key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
  preventDefault() { this.defaultPrevented = true; },
  ...overrides,
});

// ---------------------------------------------------------------- chords

test("parseChord handles modifiers, aliases, and the Mod+= edge", () => {
  assert.deepEqual(parseChord("Mod+Shift+K"), { key: "k", mod: true, ctrl: false, alt: false, shift: true });
  assert.deepEqual(parseChord("Ctrl+Tab"), { key: "tab", mod: false, ctrl: true, alt: false, shift: false });
  assert.deepEqual(parseChord("Mod+="), { key: "=", mod: true, ctrl: false, alt: false, shift: false });
  assert.deepEqual(parseChord("Mod+-"), { key: "-", mod: true, ctrl: false, alt: false, shift: false });
  assert.deepEqual(parseChord("Mod+,"), { key: ",", mod: true, ctrl: false, alt: false, shift: false });
  assert.equal(parseChord("Mod+Shift"), null, "a chord needs a non-modifier key");
  assert.equal(parseChord(""), null);
  assert.equal(parseChord(null), null);
  assert.equal(parseChord("A+B"), null, "two main keys is invalid");
});

test("every DEFAULT_KEYMAP entry parses and round-trips through chordToString, on both platforms", () => {
  for (const id of Object.keys(DEFAULT_KEYMAP)) {
    for (const isMac of [true, false]) {
      const chord = defaultBinding(id, isMac);
      if (chord === null) continue; // no default on this platform (e.g. the theme cycle)
      const parsed = parseChord(chord);
      assert.ok(parsed, `${id} (${isMac ? "mac" : "other"}): ${chord} must parse`);
      assert.deepEqual(parseChord(chordToString(parsed)), parsed, `${id}: round-trip`);
    }
  }
});

test("formatChord: mac symbols vs Ctrl-style labels", () => {
  assert.equal(formatChord("Mod+Shift+K", true), "⇧⌘K");
  assert.equal(formatChord("Mod+Shift+K", false), "Ctrl+Shift+K");
  assert.equal(formatChord("Ctrl+Tab", true), "⌃Tab");
  assert.equal(formatChord("Ctrl+Tab", false), "Ctrl+Tab");
  assert.equal(formatChord("Mod+=", false), "Ctrl+=");
  assert.equal(formatChord(null, true), "");
});

test("chordFromEvent maps the platform Mod correctly and normalizes keys", () => {
  assert.deepEqual(chordFromEvent(ev("k", { metaKey: true }), true),
    { key: "k", mod: true, ctrl: false, alt: false, shift: false });
  assert.deepEqual(chordFromEvent(ev("k", { ctrlKey: true }), false),
    { key: "k", mod: true, ctrl: false, alt: false, shift: false });
  assert.equal(chordFromEvent(ev("Meta", { metaKey: true }), true), null, "bare modifier is not a chord");
  assert.equal(normalizeKey("+"), "=");
  assert.equal(normalizeKey("Escape"), "escape");
});

// ---------------------------------------------------------------- persistence

test("overrides persist to localStorage and reset cleanly", () => {
  const store = installStorage();
  resetAllBindings();
  assert.equal(getBinding("app.palette", true), "Mod+K");
  setBinding("app.palette", "Mod+P");
  assert.equal(getBinding("app.palette", true), "Mod+P");
  assert.equal(getBinding("app.palette", false), "Mod+P", "an override wins on every platform");
  assert.match(store.get("oats-desktop-keymap"), /Mod\+P/);
  setBinding("tabs.close", null); // explicit unbind
  assert.equal(getBinding("tabs.close", true), null);
  assert.equal(getBinding("tabs.close", false), null);
  resetBinding("app.palette");
  assert.equal(getBinding("app.palette", true), "Mod+K");
  assert.equal(getBinding("app.palette", false), "Alt+K");
  resetAllBindings();
  assert.equal(getBinding("tabs.close", true), "Mod+W");
  assert.equal(getBinding("tabs.close", false), "Alt+W");
  assert.equal(store.has("oats-desktop-keymap"), false, "empty overrides remove the key");
});

test("storage-less environments do not throw", () => {
  const saved = globalThis.localStorage;
  delete globalThis.localStorage;
  try {
    assert.doesNotThrow(() => { setBinding("app.palette", "Mod+P"); resetAllBindings(); });
  } finally { globalThis.localStorage = saved; }
});

test("onKeymapChange fires on set/reset and unsubscribes", () => {
  installStorage(); resetAllBindings();
  let calls = 0;
  const off = onKeymapChange(() => calls++);
  setBinding("app.palette", "Mod+P");
  resetBinding("app.palette");
  off();
  setBinding("app.palette", "Mod+P");
  assert.equal(calls, 2);
  resetAllBindings();
});

// ---------------------------------------------------------------- dispatch

function withActions(t, actions) {
  installStorage(); resetAllBindings();
  const offs = actions.map((a) => registerAction(a));
  setActiveContexts(new Set());
  t.after(() => { for (const off of offs) off(); resetAllBindings(); });
}

test("matchEvent: global action fires on its default chord (mac + non-mac)", (t) => {
  withActions(t, [{ id: "app.palette", label: "Palette", context: "global", run: () => {} }]);
  t.after(() => setChordFamily("alt"));
  assert.equal(activeChordFamily(), "alt");
  assert.equal(matchEvent(ev("k", { metaKey: true }), { isMac: true, insideTerminal: false }), "app.palette");
  // Linux/Windows: Alt+K (the default, the Alt family); plain Ctrl+K is the program's, Ctrl+Alt+K is
  // the Ctrl+Alt family's key and no binding here, and Ctrl+Shift+K, the palette's chord from #1217
  // to phase 3, is the Ctrl+Shift family's; Alt+P is Quick Open's.
  const linux = { isMac: false, insideTerminal: false };
  assert.equal(matchEvent(ev("k", { altKey: true }), linux), "app.palette");
  assert.equal(matchEvent(ev("k", { ctrlKey: true }), linux), null);
  assert.equal(matchEvent(ev("k", { ctrlKey: true, altKey: true }), linux), null);
  assert.equal(matchEvent(ev("K", { ctrlKey: true, shiftKey: true }), linux), null);
  assert.equal(matchEvent(ev("K", { altKey: true, shiftKey: true }), linux), null, "Shift is not part of it");
  assert.equal(matchEvent(ev("p", { altKey: true }), linux), null);
  // A user who chose Ctrl+Alt keeps Ctrl+Alt+K, and Alt+K is then the program's.
  setChordFamily("ctrl+alt");
  assert.equal(matchEvent(ev("k", { ctrlKey: true, altKey: true }), linux), "app.palette");
  assert.equal(matchEvent(ev("k", { altKey: true }), linux), null);
  assert.equal(matchEvent(ev("k", { metaKey: true }), { isMac: true, insideTerminal: false }), "app.palette", "macOS has no family");
  setChordFamily("alt");
  assert.equal(matchEvent(ev("k"), { isMac: true, insideTerminal: false }), null);
  assert.equal(matchEvent(ev("k", { metaKey: true, shiftKey: true }), { isMac: true, insideTerminal: false }), null,
    "extra modifiers must not match");
});

test("matchEvent: context scoping — non-global actions need an active context", (t) => {
  withActions(t, [{ id: "stage.hierarchy.focus", label: "Focus", context: "stage:hierarchy", run: () => {} }]);
  setBinding("stage.hierarchy.focus", "Mod+J");
  assert.equal(matchEvent(ev("j", { metaKey: true }), { isMac: true, insideTerminal: false }), null);
  setActiveContexts(new Set(["stage:hierarchy"]));
  assert.equal(matchEvent(ev("j", { metaKey: true }), { isMac: true, insideTerminal: false }), "stage.hierarchy.focus");
});

test("matchEvent: a context action beats a global action on the same chord", (t) => {
  withActions(t, [
    { id: "g.act", label: "Global", context: "global", run: () => {} },
    { id: "t.act", label: "Tabs", context: "tabs", run: () => {} },
  ]);
  setBinding("g.act", "Mod+J");
  setBinding("t.act", "Mod+J");
  setActiveContexts(new Set(["tabs"]));
  assert.equal(matchEvent(ev("j", { metaKey: true }), { isMac: true, insideTerminal: false }), "t.act");
  setActiveContexts(new Set());
  assert.equal(matchEvent(ev("j", { metaKey: true }), { isMac: true, insideTerminal: false }), "g.act");
});

test("terminal policy mac: command shortcuts and Ctrl+Tab navigation fire inside xterm", (t) => {
  withActions(t, [
    { id: "app.palette", label: "Palette", context: "global", run: () => {} },
    { id: "tabs.next", label: "Next", context: "global", run: () => {} },
    { id: "x.ctrl", label: "Explicit ctrl", context: "global", run: () => {} },
  ]);
  setBinding("x.ctrl", "Ctrl+B");
  // ⌘K fires inside terminal
  assert.equal(matchEvent(ev("k", { metaKey: true }), { isMac: true, insideTerminal: true }), "app.palette");
  // Tab navigation remains available while the agent input has focus.
  assert.equal(matchEvent(ev("Tab", { ctrlKey: true }), { isMac: true, insideTerminal: true }), "tabs.next");
  setBinding("tabs.next", "Ctrl+B");
  assert.equal(matchEvent(ev("b", { ctrlKey: true }), { isMac: true, insideTerminal: true }), null);
  resetBinding("tabs.next");
  assert.equal(matchEvent(ev("Tab", { ctrlKey: true }), { isMac: true, insideTerminal: false }), "tabs.next");
  // explicit Ctrl chord never fires inside terminal on mac (tmux prefix etc.)
  assert.equal(matchEvent(ev("b", { ctrlKey: true }), { isMac: true, insideTerminal: true }), null);
  assert.equal(matchEvent(ev("b", { ctrlKey: true }), { isMac: true, insideTerminal: false }), "x.ctrl");
});

test("terminal policy non-mac: only allowlisted action ids fire inside xterm", (t) => {
  withActions(t, [
    { id: "app.palette", label: "Palette", context: "global", run: () => {} },
    { id: "tabs.next", label: "Next", context: "global", run: () => {} },
    { id: "tabs.prev", label: "Prev", context: "global", run: () => {} },
    { id: "tabs.close", label: "Close", context: "global", run: () => {} },
    { id: "app.themeToggle", label: "Theme", context: "global", run: () => {} },
  ]);
  const inTerm = { isMac: false, insideTerminal: true };
  assert.equal(matchEvent(ev("k", { altKey: true }), inTerm), "app.palette");
  assert.equal(matchEvent(ev("Tab", { ctrlKey: true }), inTerm), "tabs.next");
  assert.equal(matchEvent(ev("Tab", { ctrlKey: true, shiftKey: true }), inTerm), "tabs.prev");
  assert.equal(matchEvent(ev("w", { altKey: true }), inTerm), "tabs.close");
  // The Ctrl+Alt family's keys are no binding in the default family: the program gets them.
  assert.equal(matchEvent(ev("k", { ctrlKey: true, altKey: true }), inTerm), null);
  assert.equal(matchEvent(ev("w", { ctrlKey: true, altKey: true }), inTerm), null);
  // Ctrl+K / Ctrl+W are the program's (kill line, delete word): no default claims them.
  assert.equal(matchEvent(ev("k", { ctrlKey: true }), inTerm), null);
  assert.equal(matchEvent(ev("w", { ctrlKey: true }), inTerm), null);
  // A non-allowlisted action never fires inside the terminal, whatever its chord.
  setBinding("app.themeToggle", "Ctrl+Shift+T");
  assert.equal(matchEvent(ev("T", { ctrlKey: true, shiftKey: true }), inTerm), null);
  assert.equal(matchEvent(ev("T", { ctrlKey: true, shiftKey: true }), { isMac: false, insideTerminal: false }), "app.themeToggle");
  // allowlist is action-id based, so it follows a rebind (the user's choice)
  setBinding("app.palette", "Ctrl+K");
  assert.equal(matchEvent(ev("k", { ctrlKey: true }), inTerm), "app.palette");
  assert.equal(matchEvent(ev("k", { altKey: true }), inTerm), null, "old chord no longer bound");
});

// The palette's own chord, pressed again while it is open, moves the selection down; with Shift, up
// (pickerCycleDirection). In the Alt family that is Alt+K and Alt+Shift+K; in the Ctrl+Alt family
// Ctrl+Alt+K and Ctrl+Alt+Shift+K.
test("pickerCycleDirection on Linux/Windows: the palette's chord in the active family cycles down, with Shift up", (t) => {
  withActions(t, [{ id: "app.palette", label: "Palette", context: "global", run: () => {} }]);
  t.after(() => setChordFamily("alt"));
  assert.equal(activeChordFamily(), "alt");
  assert.equal(pickerCycleDirection(ev("k", { altKey: true }), "app.palette", false), 1, "Alt+K moves down");
  assert.equal(pickerCycleDirection(ev("K", { altKey: true, shiftKey: true }), "app.palette", false), -1, "Alt+Shift+K moves up");
  assert.equal(pickerCycleDirection(ev("j", { altKey: true }), "app.palette", false), 0);
  assert.equal(pickerCycleDirection(ev("k", { ctrlKey: true, altKey: true }), "app.palette", false), 0, "the Ctrl+Alt family's key is not the palette's here");
  assert.equal(pickerCycleDirection(ev("k"), "app.palette", false), 0, "a plain K types in the palette's field");
  setChordFamily("ctrl+alt");
  assert.equal(pickerCycleDirection(ev("k", { ctrlKey: true, altKey: true }), "app.palette", false), 1, "Ctrl+Alt+K moves down");
  assert.equal(pickerCycleDirection(ev("K", { ctrlKey: true, altKey: true, shiftKey: true }), "app.palette", false), -1, "Ctrl+Alt+Shift+K moves up");
  assert.equal(pickerCycleDirection(ev("k", { altKey: true }), "app.palette", false), 0, "Alt+K is the program's there");
  setChordFamily("alt");
});

test("the legacy palette chord check is gone: the engine is the one palette policy", async () => {
  const palette = await import("../renderer/palette.mjs");
  assert.equal(palette.isPaletteShortcut, undefined);
});

test("handleKeydown runs the action, preventDefaults, and isolates errors", (t) => {
  let ran = 0;
  withActions(t, [
    { id: "app.palette", label: "Palette", context: "global", run: () => { ran++; } },
    { id: "x.boom", label: "Boom", context: "global", run: () => { throw new Error("boom"); } },
  ]);
  setBinding("x.boom", "Mod+B");
  const e1 = ev("k", { metaKey: true });
  assert.equal(handleKeydown(e1, { isMac: true, insideTerminal: false }), true);
  assert.equal(ran, 1);
  assert.equal(e1.defaultPrevented, true);
  const e2 = ev("b", { metaKey: true });
  assert.doesNotThrow(() => handleKeydown(e2, { isMac: true, insideTerminal: false }));
  assert.equal(e2.defaultPrevented, true);
  const e3 = ev("z");
  assert.equal(handleKeydown(e3, { isMac: true, insideTerminal: false }), false);
  assert.equal(e3.defaultPrevented, undefined);
});

test("unbound actions never match; rebinding is honored by dispatch", (t) => {
  withActions(t, [{ id: "app.palette", label: "Palette", context: "global", run: () => {} }]);
  setBinding("app.palette", null);
  assert.equal(matchEvent(ev("k", { metaKey: true }), { isMac: true, insideTerminal: false }), null);
  setBinding("app.palette", "Mod+Shift+P");
  assert.equal(matchEvent(ev("p", { metaKey: true, shiftKey: true }), { isMac: true, insideTerminal: false }), "app.palette");
});

test("matchEvent ignores events already consumed via preventDefault", (t) => {
  withActions(t, [{ id: "app.palette", label: "Palette", context: "global", run: () => {} }]);
  const e = ev("k", { metaKey: true });
  e.preventDefault();
  assert.equal(matchEvent(e, { isMac: true, insideTerminal: false }), null,
    "a defaultPrevented event must never dispatch");
  assert.equal(handleKeydown(ev("k", { metaKey: true, defaultPrevented: true }), { isMac: true, insideTerminal: false }), false);
  // and the unconsumed event still works
  assert.equal(matchEvent(ev("k", { metaKey: true }), { isMac: true, insideTerminal: false }), "app.palette");
});

test("unmodified chords do not fire from editable fields; modified chords do", (t) => {
  withActions(t, [
    { id: "hier.filter", label: "Filter", context: "stage:hierarchy", run: () => {} },
    { id: "app.palette", label: "Palette", context: "global", run: () => {} },
  ]);
  setActiveContexts(new Set(["stage:hierarchy"]));
  setBinding("hier.filter", "F");
  const opts = (editableTarget) => ({ isMac: true, insideTerminal: false, editableTarget });
  // plain key: fires outside editables, not inside
  assert.equal(matchEvent(ev("f"), opts(false)), "hier.filter");
  assert.equal(matchEvent(ev("f"), opts(true)), null, "plain chord must not steal typing");
  // shift-only counts as unmodified (typing produces shifted chars)
  setBinding("hier.filter", "Shift+F");
  assert.equal(matchEvent(ev("f", { shiftKey: true }), opts(true)), null);
  assert.equal(matchEvent(ev("f", { shiftKey: true }), opts(false)), "hier.filter");
  // modified chords still fire from editable fields
  assert.equal(matchEvent(ev("k", { metaKey: true }), opts(true)), "app.palette");
  // default editable detection from e.target (tagName / contentEditable)
  setBinding("hier.filter", "F");
  assert.equal(matchEvent({ ...ev("f"), target: { tagName: "INPUT" } }, { isMac: true, insideTerminal: false }), null);
  assert.equal(matchEvent({ ...ev("f"), target: { tagName: "TEXTAREA" } }, { isMac: true, insideTerminal: false }), null);
  assert.equal(matchEvent({ ...ev("f"), target: { tagName: "DIV", isContentEditable: true } }, { isMac: true, insideTerminal: false }), null);
  assert.equal(matchEvent({ ...ev("f"), target: { tagName: "DIV" } }, { isMac: true, insideTerminal: false }), "hier.filter");
});

test("registerAction defaultChord: folds into the effective keymap (addendum 3)", (t) => {
  installStorage(); resetAllBindings();
  const off = registerAction({ id: "hier.fit", label: "Fit", context: "stage:hierarchy", run: () => {}, defaultChord: "F" });
  t.after(() => { off(); resetAllBindings(); setActiveContexts(new Set()); });

  // registration-supplied default visible via getBinding (canonicalized)
  assert.equal(getBinding("hier.fit"), "F");

  // dispatches like any binding (context active, outside editables)
  setActiveContexts(new Set(["stage:hierarchy"]));
  assert.equal(matchEvent(ev("f"), { isMac: true, insideTerminal: false, editableTarget: false }), "hier.fit");

  // user override wins
  setBinding("hier.fit", "Mod+F");
  assert.equal(getBinding("hier.fit"), "Mod+F");
  assert.equal(matchEvent(ev("f"), { isMac: true, insideTerminal: false, editableTarget: false }), null);
  assert.equal(matchEvent(ev("f", { metaKey: true }), { isMac: true, insideTerminal: false }), "hier.fit");

  // reset returns to the registration default
  resetBinding("hier.fit");
  assert.equal(getBinding("hier.fit"), "F");

  // explicit null unbind kills the default and stops dispatch
  setBinding("hier.fit", null);
  assert.equal(getBinding("hier.fit"), null);
  assert.equal(matchEvent(ev("f"), { isMac: true, insideTerminal: false, editableTarget: false }), null);

  // …and the unbind survives a storage reload (persisted null round-trips)
  const raw = localStorage.getItem("oats-desktop-keymap");
  assert.match(raw, /"hier\.fit":null/);

  // static DEFAULT_KEYMAP wins over a registration default for the same id
  const off2 = registerAction({ id: "app.palette", label: "P", context: "global", run: () => {}, defaultChord: "Mod+9" });
  assert.equal(getBinding("app.palette", true), "Mod+K");
  assert.equal(getBinding("app.palette", false), "Alt+K");
  off2();
  // …including a static "no default" on a platform: never the registration's chord.
  const off4 = registerAction({ id: "app.themeToggle", label: "T", context: "global", run: () => {}, defaultChord: "Mod+Shift+T" });
  assert.equal(getBinding("app.themeToggle", true), null);
  assert.equal(getBinding("app.themeToggle", false), null);
  off4();

  // invalid defaultChord is discarded, not thrown
  const off3 = registerAction({ id: "x.bad", label: "Bad", context: "global", run: () => {}, defaultChord: "A+B" });
  assert.equal(getBinding("x.bad"), null);
  off3();
});

test("registerAction defaultChord: unbind persisted across module reload; conflicts seen", async (t) => {
  installStorage(); resetAllBindings();
  localStorage.setItem("oats-desktop-keymap", JSON.stringify({ "hier.fit": null }));
  const fresh = await import("../renderer/keybindings.mjs?fresh=" + Math.random());
  const off = fresh.registerAction({ id: "hier.fit", label: "Fit", context: "stage:hierarchy", run: () => {}, defaultChord: "F" });
  t.after(() => { off(); fresh.resetAllBindings(); });
  assert.equal(fresh.getBinding("hier.fit"), null,
    "explicit unbind loaded from storage suppresses the registration default");

  // findConflict treats a registration default like any binding
  fresh.resetAllBindings();
  assert.equal(fresh.getBinding("hier.fit"), "F");
  assert.equal(fresh.findConflict("F", "stage:hierarchy", null, true)?.id, "hier.fit");
  assert.equal(fresh.findConflict("F", "tabs", null, true), null, "other non-global context: no conflict");
});

// ---------------------------------------------------------------- conflicts

test("findConflict: same context and global<->context collisions, exclusion", (t) => {
  withActions(t, [
    { id: "g.one", label: "One", context: "global", run: () => {} },
    { id: "t.two", label: "Two", context: "tabs", run: () => {} },
    { id: "h.three", label: "Three", context: "stage:hierarchy", run: () => {} },
  ]);
  setBinding("g.one", "Mod+J");
  setBinding("t.two", "Mod+L");
  setBinding("h.three", "Mod+L");
  // global chord vs context binding
  assert.equal(findConflict("Mod+J", "tabs", null, true)?.id, "g.one");
  // same-context conflict
  assert.equal(findConflict("Mod+L", "tabs", null, true)?.id, "t.two");
  // different non-global contexts never both fire — no conflict
  assert.equal(findConflict("Mod+L", "stage:spawn", null, true), null);
  // excluding the action being edited
  assert.equal(findConflict("Mod+L", "tabs", "t.two", true), null);
  // no conflict for a free chord
  assert.equal(findConflict("Mod+Shift+9", "global", null, true), null);
  // non-mac folding: Ctrl+J collides with Mod+J
  assert.equal(findConflict("Ctrl+J", "global", null, false)?.id, "g.one");
});

test("findConflict: a modal dialog's own context clashes only with itself, never with global (Spec E)", (t) => {
  withActions(t, [
    { id: "g.active", label: "Show Active", context: "global", run: () => {}, defaultChord: "Mod+1" },
    { id: "d.name", label: "Go to Name", context: "spawn-dialog-local", run: () => {}, defaultChord: "Mod+1" },
    { id: "d.harness", label: "Go to Harness", context: "spawn-dialog-local", run: () => {}, defaultChord: "Mod+2" },
  ]);
  assert.equal(findConflict("Mod+1", "spawn-dialog-local", "d.name", true), null, "the open dialog owns Mod+1 and stops it");
  assert.equal(findConflict("Mod+1", "global", "g.active", true), null, "Show Active keeps Mod+1 everywhere else");
  assert.equal(findConflict("Mod+2", "spawn-dialog-local", "d.name", true)?.id, "d.harness", "within the dialog a clash is a clash");
  assert.deepEqual(keymapConflicts(true), []);
  setBinding("d.harness", "Mod+1");
  assert.equal(keymapConflicts(true).length, 1, "a rebind onto a sibling dialog key is reported");
});

test("registry basics: contexts constant, list/unregister", (t) => {
  assert.deepEqual([...CONTEXTS], ["global", "stage:hierarchy", "stage:spawn", "roster", "tabs", "sidebar"]);
  assert.ok(TERMINAL_ALLOWLIST.includes("app.palette"));
  const off = registerAction({ id: "tmp.x", label: "X", context: "tabs", run: () => {} });
  assert.ok(listActions().some((a) => a.id === "tmp.x"));
  off();
  assert.ok(!listActions().some((a) => a.id === "tmp.x"));
  assert.throws(() => registerAction({ id: "", run: () => {} }));
  assert.throws(() => registerAction({ id: "y" }));
});

// ---------------------------------------------------------------- plain keys, the shared keymap

test("a plain one-character punctuation chord matches with or without Shift and is stored without it; letters keep case", (t) => {
  assert.deepEqual(parseChord("Shift+?"), { key: "?", mod: false, ctrl: false, alt: false, shift: false });
  assert.equal(chordToString(chordFromEvent(ev("?", { shiftKey: true }), false)), "?", "a recorded Shift+/ is stored as ?");
  assert.equal(chordToString(chordFromEvent(ev("|", { shiftKey: true }), false)), "|");
  assert.equal(chordToString(chordFromEvent(ev("N", { shiftKey: true }), false)), "Shift+N", "N is Shift+N");
  assert.equal(chordToString(chordFromEvent(ev("n"), false)), "N", "n is the plain letter (stored as its cap)");
  withActions(t, [
    { id: "p.split", label: "split", context: "global", run: () => {}, defaultChord: "|" },
    { id: "p.help", label: "help", context: "global", run: () => {}, defaultChord: "?" },
    { id: "p.another", label: "another", context: "global", run: () => {}, defaultChord: "Shift+N" },
    { id: "p.spawn", label: "spawn", context: "global", run: () => {}, defaultChord: "N" },
  ]);
  for (const isMac of [false, true]) {
    // The real shifted keydowns: Shift+\ arrives as "|", Shift+/ as "?".
    assert.equal(matchEvent(ev("|", { shiftKey: true }), { isMac }), "p.split");
    assert.equal(matchEvent(ev("?", { shiftKey: true }), { isMac }), "p.help");
    assert.equal(matchEvent(ev("?"), { isMac }), "p.help", "a layout that types ? without Shift");
    assert.equal(matchEvent(ev("\\"), { isMac }), null, "a plain | never fires on a plain \\");
    assert.equal(matchEvent(ev("N", { shiftKey: true }), { isMac }), "p.another");
    assert.equal(matchEvent(ev("n"), { isMac }), "p.spawn");
  }
});

test("the aliases are for chords that hold a modifier: Mod+Shift+\\ and Mod+= keep their shifted forms", (t) => {
  assert.deepEqual(parseChord("Mod+Shift+|"), parseChord("Mod+Shift+\\"));
  assert.deepEqual(chordFromEvent(ev("|", { metaKey: true, shiftKey: true }), true), { key: "\\", mod: true, ctrl: false, alt: false, shift: true });
  assert.deepEqual(chordFromEvent(ev("+", { ctrlKey: true }), false), { key: "=", mod: true, ctrl: false, alt: false, shift: false });
  assert.deepEqual(parseChord("+"), { key: "+", mod: false, ctrl: false, alt: false, shift: false }, "a plain + stays +");
  withActions(t, [
    { id: "s.right", label: "right", context: "global", run: () => {}, defaultChord: "Mod+\\" },
    { id: "s.down", label: "down", context: "global", run: () => {}, defaultChord: "Mod+Shift+\\" },
  ]);
  // findConflict still tells Mod+\ from Mod+Shift+\ (the Shift rule is for plain chords only).
  assert.equal(findConflict("Mod+\\", "global", "s.right", true), null);
  assert.equal(findConflict("Mod+Shift+\\", "global", "s.down", true), null);
  assert.equal(findConflict("Mod+Shift+|", "global", null, true)?.id, "s.down");
  assert.equal(matchEvent(ev("|", { metaKey: true, shiftKey: true }), { isMac: true }), "s.down");
  assert.equal(matchEvent(ev("\\", { metaKey: true }), { isMac: true }), "s.right");
});

test("chordFromKeyId: the shared keymap's key ids as this engine's chords", () => {
  assert.equal(chordFromKeyId("ctrl+x"), "Ctrl+X");
  assert.equal(chordFromKeyId("alt+o"), "Alt+O");
  assert.equal(chordFromKeyId("ctrl+\\"), "Ctrl+\\");
  assert.equal(chordFromKeyId("N"), "Shift+N");
  assert.equal(chordFromKeyId("n"), "N");
  assert.equal(chordFromKeyId("?"), "?");
  assert.equal(chordFromKeyId("|"), "|");
  assert.equal(chordFromKeyId("["), "[");
  assert.equal(chordFromKeyId("1"), "1");
  assert.equal(chordFromKeyId("escape"), "Esc");
  assert.equal(chordFromKeyId("nonsense"), null);
  assert.equal(chordFromKeyId("ctrl+alt+shift+e"), "Ctrl+Alt+Shift+E");
  assert.equal(chordFromKeyId("alt+shift+up"), "Alt+Shift+↑");
  assert.equal(chordFromKeyId("cmd+alt+right"), "Mod+Alt+→");
});

test("an arrow chord is stored as its label and read back as the arrow: the real keydown matches it", (t) => {
  for (const [label, key] of [["↑", "ArrowUp"], ["↓", "ArrowDown"], ["←", "ArrowLeft"], ["→", "ArrowRight"]]) {
    assert.equal(parseChord(`Alt+Shift+${label}`).key, key.toLowerCase());
    assert.equal(chordToString(chordFromEvent(ev(key, { altKey: true, shiftKey: true }), false)), `Alt+Shift+${label}`, "a recorded arrow");
    assert.equal(formatChord(`Mod+Alt+${label}`, true), `⌥⌘${label}`);
  }
  withActions(t, [{ id: "a.up", label: "up", context: "global", run: () => {} }]);
  setBinding("a.up", "Alt+Shift+↑");
  assert.equal(matchEvent(ev("ArrowUp", { altKey: true, shiftKey: true }), { isMac: false, insideTerminal: false }), "a.up");
  assert.equal(matchEvent(ev("ArrowUp", { altKey: true }), { isMac: false, insideTerminal: false }), null, "Shift is part of it");
});

test("`when`: an action that is not live does not exist for dispatch; its chord goes on", (t) => {
  let live = true, ran = 0;
  withActions(t, [{ id: "w.lead", label: "lead", context: "global", run: () => ran++, defaultChord: "Alt+O", when: () => live }]);
  assert.equal(matchEvent(ev("o", { altKey: true }), { isMac: false }), "w.lead");
  live = false;
  const e = ev("o", { altKey: true });
  assert.equal(matchEvent(e, { isMac: false }), null);
  assert.equal(handleKeydown(e, { isMac: false }), false);
  assert.ok(!e.defaultPrevented, "the key is the focused control's");
  assert.equal(runAction("w.lead"), false, "nor does a button run it");
  assert.equal(ran, 0);
});

test("letThrough: an event handed to the focused control matches nothing; eventMatchesBinding reads the live chord", (t) => {
  withActions(t, [{ id: "app.leader", label: "leader", context: "global", run: () => {} }]);
  setBinding("app.leader", "Ctrl+X"); // the Ctrl+X choice (D18's default is Ctrl+Space)
  const e = ev("x", { ctrlKey: true });
  assert.equal(eventMatchesBinding(e, "app.leader", false), true);
  letThrough(e);
  assert.equal(matchEvent(e, { isMac: false }), null);
  assert.equal(matchEvent(ev("x", { ctrlKey: true }), { isMac: false }), "app.leader", "only that event");
  setBinding("app.leader", "Alt+L");
  assert.equal(eventMatchesBinding(ev("x", { ctrlKey: true }), "app.leader", false), false);
  assert.equal(eventMatchesBinding(ev("l", { altKey: true }), "app.leader", false), true);
});

// The sidebar's context is on beside the tab layer's (or a stage's) while focus is in the sidebar
// (shell.mjs updateActiveContexts), so a chord bound in both runs only one of them: a clash, which
// the editor and keymapConflicts show. A stored rebind is kept, never changed.
test("a sidebar key and a tab shortcut on one chord clash: both contexts are on at once", (t) => {
  withActions(t, [
    { id: "tabs.close", label: "Close tab", context: "tabs", run: () => {} },
    { id: "sidebar.key.spawn", label: "Quick Open", context: "sidebar", run: () => {} },
    { id: "view.only", label: "A view's own key", context: "view:hierarchy", run: () => {}, defaultChord: "N" },
  ]);
  assert.equal(getBinding("sidebar.key.spawn", false), "N");
  assert.deepEqual(keymapConflicts(false), [], "the defaults clash with nothing");
  setBinding("tabs.close", "N"); // a stored rebind that the new sidebar default now shares
  assert.equal(findConflict("N", "sidebar", "sidebar.key.spawn", false)?.id, "tabs.close");
  assert.equal(findConflict("N", "tabs", "tabs.close", false)?.id, "sidebar.key.spawn");
  assert.equal(findConflict("N", "stage:hierarchy", null, false)?.id, "sidebar.key.spawn", "a stage's context is on beside it too");
  assert.equal(findConflict("N", "view:hierarchy", "view.only", false), null, "a view's own keys stay local to the view");
  assert.deepEqual(keymapConflicts(false).map((c) => c.actions.map((a) => a.id).sort()), [["sidebar.key.spawn", "tabs.close"]]);
  assert.equal(getBinding("tabs.close", false), "N", "kept as set");
});

// A native control that opens its popup with Alt+↑ / Alt+↓ on Linux and Windows (a select's list, a datalist's
// suggestions, a date or time picker) keeps those keys from the workspace moves' defaults; a user's own binding
// of them still fires there, and the defaults fire from any other control. Brain's Agent selector is such a select.
test("Alt+↑ / Alt+↓ stay with a focused select, datalist or picker input; a user's own binding still fires", (t) => {
  installStorage(); resetAllBindings();
  withActions(t, [
    { id: "workspace.previous", label: "Previous workspace", context: "global", run: () => {} },
    { id: "workspace.next", label: "Next workspace", context: "global", run: () => {} },
  ]);
  t.after(() => resetAllBindings());
  const opts = { isMac: false, insideTerminal: false };
  const press = (key, target, more = {}) => matchEvent({ ...ev(key, { altKey: true, ...more }), target }, opts);
  const select = { tagName: "SELECT" };
  const datalist = { tagName: "INPUT", type: "text", getAttribute: (name) => (name === "list" ? "souls" : null) };
  const date = { tagName: "INPUT", type: "date", getAttribute: () => null };
  for (const target of [select, datalist, date]) {
    assert.equal(press("ArrowDown", target), null, `${target.tagName}/${target.type ?? ""}: its popup's key`);
    assert.equal(press("ArrowUp", target), null);
  }
  // Any other control, and none: the defaults fire.
  assert.equal(press("ArrowDown", { tagName: "INPUT", type: "text", getAttribute: () => null }), "workspace.next");
  assert.equal(press("ArrowDown", { tagName: "BUTTON" }), "workspace.next");
  assert.equal(press("ArrowUp", undefined), "workspace.previous");
  // Another chord on a select is not left to it.
  setBinding("workspace.next", "Alt+Shift+ArrowDown");
  assert.equal(press("ArrowDown", select, { shiftKey: true }), "workspace.next", "only Alt alone with ↑ / ↓ is the popup's");
  // A user's own binding of Alt+↓ fires on a select, as over a default anywhere.
  setBinding("workspace.next", "Alt+ArrowDown");
  assert.equal(press("ArrowDown", select), "workspace.next");
});
