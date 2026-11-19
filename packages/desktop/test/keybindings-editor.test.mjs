import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  registerAction, setBinding, resetAllBindings, getBinding, defaultBinding, keymapConflicts, setChordFamily, activeChordFamily, runAction, listActions,
  matchEvent, setActiveContexts,
} from "../renderer/keybindings.mjs";
import { createKeybindingsEditor, groupActions, shortcutMatches, CHORD_FAMILY_WORDS } from "../renderer/keybindings-editor.mjs";
import { createChordFamily } from "../renderer/chord-family.mjs";
import { NAV, NAV_TABS } from "../renderer/shell-nav.mjs";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// storage stub so overrides work in node
const map = new Map();
globalThis.localStorage = {
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k),
};

const key = (doc, key, overrides = {}) =>
  new doc.defaultView.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...overrides });

function setup(t) {
  const dom = new JSDOM("<!doctype html><body>");
  const doc = dom.window.document;
  resetAllBindings();
  const offs = [
    registerAction({ id: "app.palette", label: "Command palette", context: "global", run: () => {} }),
    registerAction({ id: "tabs.close", label: "Close tab", context: "tabs", run: () => {} }),
    registerAction({ id: "stage.hierarchy.focus", label: "Focus tree", context: "stage:hierarchy", run: () => {} }),
    registerAction({ id: "hier.fit", label: "Fit to screen", context: "stage:hierarchy", run: () => {}, defaultChord: "F" }),
  ];
  t.after(() => { for (const off of offs) off(); resetAllBindings(); dom.window.close(); });
  return { dom, doc, editor: createKeybindingsEditor({ doc, isMac: true }) };
}

test("groupActions groups by context in stable order with labels", (t) => {
  const { } = setup(t);
  const groups = groupActions();
  assert.deepEqual(groups.map((g) => g.context), ["global", "tabs", "stage:hierarchy"]);
  assert.equal(groups[0].label, "Global");
  assert.equal(groups[2].label, "Machines"); // the Workspace page's Machines tab (the product owner, 2026-10-26)
});

test("editor renders an ARIA dialog listing every action with effective chords", (t) => {
  const { doc, editor } = setup(t);
  editor.open();
  const dialog = doc.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  const rows = [...doc.querySelectorAll(".kb-row")];
  assert.equal(rows.length, 5, "the four actions, and the Tabs group's read-only scroll row (#1502)");
  assert.equal(rows.filter((r) => r.classList.contains("kb-row-fixed")).map((r) => r.querySelector(".kb-label").textContent).join(), "Scroll back in a terminal");
  const labels = rows.map((r) => r.querySelector(".kb-label").textContent);
  assert.ok(labels.includes("Command palette"));
  const paletteRow = rows.find((r) => r.querySelector(".kb-label").textContent === "Command palette");
  assert.equal(paletteRow.querySelector(".kb-chord").textContent, "⌘K");
  // unregistered-default action of stage context shows "unbound" (no default for it)
  const treeRow = rows.find((r) => r.querySelector(".kb-label").textContent === "Focus tree");
  assert.equal(treeRow.querySelector(".kb-chord").textContent, "unbound");
  assert.ok(treeRow.querySelector(".kb-chord").classList.contains("kb-unbound"));
  editor.close();
  assert.equal(doc.querySelector(".kb-overlay"), null);
});

test("recording: keydown sets the binding; Esc cancels; Backspace unbinds", (t) => {
  const { doc, editor } = setup(t);
  editor.open();
  const rowFor = (label) => [...doc.querySelectorAll(".kb-row")]
    .find((r) => r.querySelector(".kb-label").textContent === label);

  // record a new chord
  rowFor("Command palette").querySelector(".kb-chord").click();
  assert.match(rowFor("Command palette")?.querySelector(".kb-chord").textContent ?? doc.querySelector(".kb-recording").textContent, /Press keys/);
  doc.dispatchEvent(key(doc, "p", { metaKey: true, shiftKey: true }));
  assert.equal(getBinding("app.palette", true), "Mod+Shift+P");
  assert.equal(rowFor("Command palette").querySelector(".kb-chord").textContent, "⇧⌘P");
  // macOS ⌘⌥O as a Mac reports it (⌥ makes `key` "ø"): recorded by the physical key, Mod+Alt+O.
  rowFor("Command palette").querySelector(".kb-chord").click();
  doc.dispatchEvent(key(doc, "ø", { code: "KeyO", metaKey: true, altKey: true }));
  assert.equal(getBinding("app.palette", true), "Mod+Alt+O");
  assert.equal(rowFor("Command palette").querySelector(".kb-chord").textContent, "⌥⌘O");

  // Esc cancels without changing the binding
  rowFor("Close tab").querySelector(".kb-chord").click();
  doc.dispatchEvent(key(doc, "Escape"));
  assert.equal(getBinding("tabs.close", true), defaultBinding("tabs.close", true));
  assert.ok(doc.querySelector('[role="dialog"]'), "Esc during recording must not close the dialog");

  // Backspace unbinds
  rowFor("Close tab").querySelector(".kb-chord").click();
  doc.dispatchEvent(key(doc, "Backspace"));
  assert.equal(getBinding("tabs.close", true), null);
  assert.equal(rowFor("Close tab").querySelector(".kb-chord").textContent, "unbound");
  editor.close();
});

test("conflict warning appears when a recorded chord collides", (t) => {
  const { doc, editor } = setup(t);
  setBinding("app.palette", "Mod+J");
  editor.open();
  const rowFor = (label) => [...doc.querySelectorAll(".kb-row")]
    .find((r) => r.querySelector(".kb-label").textContent === label);
  rowFor("Close tab").querySelector(".kb-chord").click();
  doc.dispatchEvent(key(doc, "j", { metaKey: true }));
  // after re-render the row shows the persistent conflict computed from findConflict
  assert.match(rowFor("Close tab").querySelector(".kb-conflict").textContent, /Command palette/);
  editor.close();
});

test("recording a bare key shows the editable-field warning on the row", (t) => {
  const { doc, editor } = setup(t);
  editor.open();
  const rowFor = (label) => [...doc.querySelectorAll(".kb-row")]
    .find((r) => r.querySelector(".kb-label").textContent === label);
  rowFor("Focus tree").querySelector(".kb-chord").click();
  doc.dispatchEvent(key(doc, "b"));
  assert.equal(getBinding("stage.hierarchy.focus", true), "B");
  assert.match(rowFor("Focus tree").querySelector(".kb-conflict").textContent,
    /won’t fire while typing/, "bare-key binding warns about the editable-field guard");
  // shift-only is still a bare key
  rowFor("Focus tree").querySelector(".kb-chord").click();
  doc.dispatchEvent(key(doc, "b", { shiftKey: true }));
  assert.match(rowFor("Focus tree").querySelector(".kb-conflict").textContent, /won’t fire while typing/);
  // a modified chord clears the warning
  rowFor("Focus tree").querySelector(".kb-chord").click();
  doc.dispatchEvent(key(doc, "b", { metaKey: true }));
  assert.equal(rowFor("Focus tree").querySelector(".kb-conflict").textContent, "");
  // a bare chord that ALSO conflicts shows BOTH messages (review c5493b1)
  setBinding("app.palette", "B"); // global → conflicts with any context
  setBinding("stage.hierarchy.focus", "B");
  const both = rowFor("Focus tree").querySelector(".kb-conflict").textContent;
  assert.match(both, /Command palette/, "conflict disclosed");
  assert.match(both, /won’t fire while typing/, "editable-field suppression still disclosed");
  editor.close();
});

test("per-row reset and reset-all restore defaults", (t) => {
  const { doc, editor } = setup(t);
  setBinding("app.palette", "Mod+P");
  setBinding("tabs.close", "Mod+X");
  editor.open();
  const rowFor = (label) => [...doc.querySelectorAll(".kb-row")]
    .find((r) => r.querySelector(".kb-label").textContent === label);
  const paletteReset = rowFor("Command palette").querySelector(".kb-reset");
  assert.equal(paletteReset.hidden, false, "overridden row shows reset");
  paletteReset.click();
  assert.equal(getBinding("app.palette", true), "Mod+K");
  assert.equal(rowFor("Command palette").querySelector(".kb-reset").hidden, true, "default row hides reset");
  doc.querySelector(".kb-reset-all").click();
  assert.equal(getBinding("tabs.close", true), "Mod+W");
  editor.close();
});

test("registration defaultChord displays honestly and Backspace-unbind disables dispatch", async (t) => {
  const { doc, editor } = setup(t);
  const { matchEvent } = await import("../renderer/keybindings.mjs");
  const { setActiveContexts } = await import("../renderer/keybindings.mjs");
  setActiveContexts(new Set(["stage:hierarchy"]));
  t.after(() => setActiveContexts(new Set()));
  editor.open();
  const rowFor = (label) => [...doc.querySelectorAll(".kb-row")]
    .find((r) => r.querySelector(".kb-label").textContent === label);
  const row = rowFor("Fit to screen");
  assert.equal(row.querySelector(".kb-chord").textContent, "F", "registration default shown, not 'unbound'");
  assert.equal(row.querySelector(".kb-reset").hidden, true, "registration default counts as default (no reset)");
  // Backspace-unbind actually disables dispatch
  row.querySelector(".kb-chord").click();
  doc.dispatchEvent(key(doc, "Backspace"));
  assert.equal(getBinding("hier.fit", true), null);
  assert.equal(rowFor("Fit to screen").querySelector(".kb-chord").textContent, "unbound");
  const fakeEvent = { key: "f", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, preventDefault() {} };
  assert.equal(matchEvent(fakeEvent, { isMac: true, insideTerminal: false, editableTarget: false }), null,
    "unbound registration default no longer dispatches");
  // per-row reset restores the registration default
  rowFor("Fit to screen").querySelector(".kb-reset").click();
  assert.equal(getBinding("hier.fit", true), "F");
  editor.close();
});

test("rerender keeps keyboard focus inside the modal (record/unbind/reset)", (t) => {
  const { doc, editor } = setup(t);
  setBinding("app.palette", "Mod+P"); // ensure the palette row has a visible reset
  editor.open();
  const dialog = doc.querySelector('[role="dialog"]');
  const rowFor = (label) => [...doc.querySelectorAll(".kb-row")]
    .find((r) => r.querySelector(".kb-label").textContent === label);

  // record from a focused chord button: focus returns to the SAME row's button
  const chordBtn = rowFor("Command palette").querySelector(".kb-chord");
  chordBtn.focus();
  chordBtn.click();
  doc.dispatchEvent(key(doc, "j", { metaKey: true }));
  assert.ok(dialog.contains(doc.activeElement), "focus stays in the dialog after recording");
  assert.equal(doc.activeElement.dataset.actionId, "app.palette");
  assert.ok(doc.activeElement.classList.contains("kb-chord"));

  // Backspace-unbind: same containment
  doc.activeElement.click();
  doc.dispatchEvent(key(doc, "Backspace"));
  assert.ok(dialog.contains(doc.activeElement), "focus stays after unbind");
  assert.equal(doc.activeElement.dataset.actionId, "app.palette");

  // per-row reset: the reset button disappears (row back at default) — focus
  // falls back to the row's chord button, still inside the dialog
  const resetBtn = rowFor("Command palette").querySelector(".kb-reset");
  assert.equal(resetBtn.hidden, false);
  resetBtn.focus();
  resetBtn.click();
  assert.ok(dialog.contains(doc.activeElement), "focus stays after per-row reset");
  assert.equal(doc.activeElement.dataset.actionId, "app.palette");
  assert.ok(doc.activeElement.classList.contains("kb-chord"), "hidden reset falls back to chord button");

  // and the NEXT Tab cannot escape: it wraps within the dialog
  const overlay = doc.querySelector(".kb-overlay");
  const tab = key(doc, "Tab");
  overlay.dispatchEvent(tab);
  assert.ok(dialog.contains(doc.activeElement), "Tab after rerender remains trapped");

  // reset-all from its own (non-row) button keeps focus in the dialog too
  setBinding("tabs.close", "Mod+X");
  const resetAll = doc.querySelector(".kb-reset-all");
  resetAll.focus();
  resetAll.click();
  assert.ok(dialog.contains(doc.activeElement), "focus stays after reset-all");
  editor.close();
});

test("Escape (outside recording) and overlay backdrop close the dialog; toggle works", (t) => {
  const { doc, editor } = setup(t);
  editor.open();
  assert.equal(editor.isOpen(), true);
  doc.querySelector(".kb-overlay").dispatchEvent(key(doc, "Escape"));
  assert.equal(editor.isOpen(), false);
  editor.toggle();
  assert.equal(editor.isOpen(), true);
  editor.toggle();
  assert.equal(editor.isOpen(), false);
});

test("recording does not survive dialog close or reset-all", (t) => {
  const { doc, editor } = setup(t);
  editor.open();
  const rowFor = (label) => [...doc.querySelectorAll(".kb-row")]
    .find((r) => r.querySelector(".kb-label").textContent === label);

  // close during recording: the capture listener must be torn down
  rowFor("Command palette").querySelector(".kb-chord").click();
  editor.close();
  const e = key(doc, "x", { metaKey: true });
  doc.dispatchEvent(e);
  assert.equal(e.defaultPrevented, false, "closed editor must not swallow keys");
  assert.equal(getBinding("app.palette", true), defaultBinding("app.palette", true),
    "closed editor must not persist a binding");

  // reset-all during recording: capture ends, nothing recorded afterwards
  editor.open();
  rowFor("Command palette").querySelector(".kb-chord").click();
  doc.querySelector(".kb-reset-all").click();
  doc.dispatchEvent(key(doc, "y", { metaKey: true }));
  assert.equal(getBinding("app.palette", true), defaultBinding("app.palette", true));

  // rerender (keymap change from elsewhere) also invalidates a capture
  rowFor("Command palette").querySelector(".kb-chord").click();
  setBinding("tabs.close", "Mod+X"); // triggers render
  doc.dispatchEvent(key(doc, "z", { metaKey: true }));
  assert.equal(getBinding("app.palette", true), defaultBinding("app.palette", true));
  editor.close();
});

test("malformed persisted overrides are sanitized and cannot break the editor", async (t) => {
  // corrupt payload BEFORE the module (re)reads storage
  localStorage.setItem("oats-desktop-keymap",
    JSON.stringify({ "app.palette": 42, "tabs.close": { evil: true }, "stage.hierarchy.focus": "Mod+K+P", "x.legacy": "Mod+Shift+L", "x.unbound": null }));
  const fresh = await import("../renderer/keybindings.mjs?fresh=" + Math.random());
  assert.equal(fresh.getBinding("app.palette", true), "Mod+K", "non-string value discarded → default");
  assert.equal(fresh.getBinding("tabs.close", true), "Mod+W", "object value discarded → default");
  assert.equal(fresh.getBinding("stage.hierarchy.focus", true), null,
    "unparsable chord string (two main keys) discarded → no default → unbound");
  assert.equal(fresh.getBinding("x.legacy", true), "Mod+Shift+L", "valid chord survives");
  assert.equal(fresh.getBinding("x.unbound", true), null, "explicit null unbind survives");
  localStorage.removeItem("oats-desktop-keymap");

  // and the editor renders instead of throwing on a poisoned live map too
  const { doc, editor } = setup(t);
  assert.doesNotThrow(() => { editor.open(); editor.close(); });
});

test("Tab wraps focus inside the modal dialog", (t) => {
  const { doc, editor } = setup(t);
  const outside = doc.createElement("button");
  outside.textContent = "outside";
  doc.body.append(outside);
  editor.open();
  const overlay = doc.querySelector(".kb-overlay");
  const dialog = overlay.querySelector(".kb-editor");
  const focusable = [...dialog.querySelectorAll("input, button:not([disabled])")]
    .filter((el) => !el.closest("[hidden]") && el.tabIndex >= 0);
  const first = focusable[0], last = focusable.at(-1);
  assert.equal(first, dialog.querySelector(".kb-search"), "the search is the trap's first stop");

  last.focus();
  const tab = key(doc, "Tab");
  overlay.dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, true, "Tab on the last control is wrapped");
  assert.equal(doc.activeElement, first);

  first.focus();
  const shiftTab = key(doc, "Tab", { shiftKey: true });
  overlay.dispatchEvent(shiftTab);
  assert.equal(shiftTab.defaultPrevented, true, "Shift+Tab on the first control is wrapped");
  assert.equal(doc.activeElement, last);
  editor.close();
});

test("a stored rebind that clashes with another binding is surfaced, never changed silently", (t) => {
  const { doc, editor } = setup(t);
  assert.deepEqual(keymapConflicts(true), [], "the defaults alone never clash");
  // e.g. an old rebind that a new default now shares: ⌘W was set for the palette.
  setBinding("app.palette", "Mod+W");
  const clashes = keymapConflicts(true);
  assert.equal(clashes.length, 1);
  assert.deepEqual(clashes[0].actions.map((a) => a.id).sort(), ["app.palette", "tabs.close"]);
  assert.equal(getBinding("app.palette", true), "Mod+W", "the stored rebind is kept");
  assert.equal(getBinding("tabs.close", true), "Mod+W", "and so is the default");
  editor.open();
  const banner = doc.querySelector(".kb-clashes");
  assert.equal(banner.hidden, false);
  assert.equal(banner.getAttribute("role"), "status");
  assert.match(banner.textContent, /⌘W runs “Command palette” \(yours\) where both apply; “Close tab” has it by default\. Rebind or reset one\./);
  const paletteRow = doc.querySelector('.kb-chord[data-action-id="app.palette"]').closest(".kb-row");
  assert.match(paletteRow.querySelector(".kb-conflict").textContent, /Also bound to “Close tab”/, "and marked on its row");
  // Both sides set by the user: neither holds it by default, so both are named, as before.
  setBinding("tabs.close", "Mod+W");
  editor.close();
  editor.open();
  assert.match(doc.querySelector(".kb-clashes").textContent, /⌘W is both “(Command palette|Close tab)” and “(Close tab|Command palette)”\. Rebind or reset one\./);
  // A clash between defaults only (no stored rebind) is not the operator's to fix: not listed.
  resetAllBindings();
  assert.deepEqual(keymapConflicts(true), []);
  assert.equal(doc.querySelector(".kb-clashes").hidden, true);
});

test("shell wiring: the settings cog and its Keyboard shortcuts… item carry the clash marker, recomputed on keymap change", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
  const mark = src.match(/function markShortcutClashes\(\) \{[^]*?\n\}/)?.[0];
  assert.ok(mark, "markShortcutClashes");
  assert.match(mark, /keymapConflicts\(isMac\)/);
  assert.match(mark, /settingsMenu\.items\.find\(el => el\.dataset\.menuAction === "app\.shortcuts"\)/, "the menu's Keyboard shortcuts… item");
  assert.match(mark, /for \(const button of \[document\.getElementById\("sidebar-settings"\), item\]\) \{[^]*?classList\.toggle\("has-clash"[^]*?aria-description/,
    "the cog and the item, both");
  assert.match(src, /onKeymapChange\(\(\) => \{[^]*?markShortcutClashes\(\)/);
  const css = readFileSync(new URL("../renderer/shell.css", import.meta.url), "utf8");
  // --danger: a key no longer does what it says (yellow means needs input only, 2026-10-26).
  assert.match(css, /#sidebar-settings\.has-clash::after \{[^}]*background: var\(--danger\)/);
  assert.match(css, /\.sidebar-settings-menu button\.has-clash > \.sidebar-settings-label::after \{[^}]*background: var\(--danger\)/);
  assert.doesNotMatch(css, /#sidebar-shortcuts/, "the foot's shortcuts button is gone");
});

// ── Spec A, PR 2: search, keycaps and markers ──────────────────────────────────────────────
// Linux/Windows: the shipped defaults of these ids come from DEFAULT_KEYMAP, in the default family,
// Alt (sidebar Ctrl+Shift+B, Quick Open Alt+P, go to tab Alt+1, F6); focus mode has none.
function setupLinux(t, { isMac = false, extra = [] } = {}) {
  const dom = new JSDOM("<!doctype html><body>");
  const doc = dom.window.document;
  resetAllBindings();
  const offs = [
    ["app.palette", "Command palette", "global"],
    ["app.quickOpenSouls", "Quick open a soul", "global"],
    ["sidebar.toggle", "Sidebar: show or hide", "global"],
    ["panel.toggle", "Instance panel: show or hide", "global"],
    ["app.focusMode", "Focus mode: toggle", "global"],
    ["focus.nextRegion", "Focus the next region", "global"],
    ["tabs.close", "Close tab", "tabs"],
    ["tabs.next", "Next tab", "tabs"],
    ["tabs.goto1", "Go to tab 1", "tabs"],
    ...extra,
  ].map(([id, label, context, defaultChord = null]) => registerAction({ id, label, context, defaultChord, run: () => {} }));
  t.after(() => { for (const off of offs) off(); resetAllBindings(); dom.window.close(); });
  const editor = createKeybindingsEditor({ doc, isMac });
  t.after(() => editor.close());
  const search = () => doc.querySelector(".kb-search");
  return {
    doc, editor, search,
    type(text) { search().value = text; search().dispatchEvent(new dom.window.Event("input", { bubbles: true })); },
    press(target, k, mods = {}) { const e = key(doc, k, mods); target.dispatchEvent(e); return e; },
    rowFor: (label) => [...doc.querySelectorAll(".kb-row")].find((r) => r.querySelector(".kb-label").textContent === label),
    shown: () => [...doc.querySelectorAll(".kb-row")].filter((r) => !r.closest("[hidden]")).map((r) => r.querySelector(".kb-label").textContent),
    marks: (label, kind) => [...doc.querySelectorAll(".kb-row")].find((r) => r.querySelector(".kb-label").textContent === label)
      .querySelector(`.kb-mark-${kind}`)?.textContent ?? null,
  };
}

test("search: focused on open; filters by label, by group name and by the chord as shown, case- and separator-insensitive", (t) => {
  const f = setupLinux(t);
  f.editor.open();
  assert.equal(f.doc.activeElement, f.search(), "the search has focus when the editor opens");
  assert.equal(f.search().getAttribute("aria-label"), "Search shortcuts");
  f.type("sidebar");
  assert.deepEqual(f.shown(), ["Sidebar: show or hide"]);
  assert.equal(f.doc.querySelector('.kb-group[data-label="Tabs"]').hidden, true, "a group with no match disappears");
  f.type("TABS");
  assert.deepEqual(f.shown(), ["Close tab", "Go to tab 1", "Next tab", "Scroll back in a terminal"], "the group's name finds its rows");
  assert.equal(f.doc.querySelector('.kb-group[data-label="Global"]').hidden, true);
  for (const q of ["shift+b", "ctrl shift b", "Ctrl+Shift+B", "ctrlshiftb", "shift ctrl b", " Shift + B "]) {
    f.type(q);
    assert.deepEqual(f.shown(), ["Sidebar: show or hide"], `“${q}” finds Ctrl+Shift+B and nothing else`);
  }
  // The default family's chords: Alt+P, Alt+K. The Ctrl+Alt family's keys are no binding here.
  f.type("alt+p");
  assert.deepEqual(f.shown(), ["Quick open a soul"]);
  f.type("p alt");
  assert.deepEqual(f.shown(), ["Quick open a soul"], "in any order");
  f.type("alt+k");
  assert.deepEqual(f.shown(), ["Command palette"]);
  f.type("ctrl+alt+k");
  assert.deepEqual(f.shown(), [], "Ctrl+Alt+K is no binding in the Alt family");
  // The keys typed need not be all of the chord's: in the Ctrl+Alt family, Ctrl+P also finds Ctrl+Alt+P.
  t.after(() => setChordFamily("alt"));
  setChordFamily("ctrl+alt");
  f.type("ctrl+p");
  assert.deepEqual(f.shown(), ["Quick open a soul"]);
  f.type("ctrl+alt+k");
  assert.deepEqual(f.shown(), ["Command palette"]);
  setChordFamily("alt");
  f.type("f6");
  assert.deepEqual(f.shown(), ["Focus the next region"]);
  f.type("unbound");
  assert.deepEqual(f.shown(), ["Focus mode: toggle"], "an unbound row's chord reads unbound");
  f.type("");
  assert.equal(f.shown().length, 10, "clearing the search shows every row, the scroll row too");
});

test("search: the count is announced politely; nothing matching shows one quiet line", (t) => {
  const f = setupLinux(t);
  f.editor.open();
  const count = f.doc.querySelector(".kb-count");
  assert.equal(count.getAttribute("role"), "status");
  assert.ok(count.classList.contains("sr-only"));
  assert.equal(count.textContent, "", "nothing is announced on open");
  f.type("tab");
  assert.equal(count.textContent, `${f.shown().length} shortcuts`);
  f.type("sidebar");
  assert.equal(count.textContent, "1 shortcut");
  f.type("zzz");
  assert.deepEqual(f.shown(), []);
  assert.equal(count.textContent, "0 shortcuts");
  for (const group of f.doc.querySelectorAll(".kb-group")) assert.equal(group.hidden, true);
  const none = f.doc.querySelector(".kb-nomatch");
  assert.equal(none.hidden, false);
  assert.equal(none.textContent, "No shortcut matches “zzz”");
  f.type("close");
  assert.equal(none.hidden, true);
});

test("search: a rebind while filtering keeps the filter", (t) => {
  const f = setupLinux(t);
  f.editor.open();
  f.type("sidebar");
  setBinding("app.palette", "Ctrl+J"); // rerenders every row
  assert.deepEqual(f.shown(), ["Sidebar: show or hide"]);
  assert.equal(f.search().value, "sidebar");
});

test("keyboard: Down from the search enters the rows, Up/Down move between them, Up from the first returns to the search", (t) => {
  const f = setupLinux(t);
  f.editor.open();
  const chordOf = (label) => f.rowFor(label).querySelector(".kb-chord");
  const down = f.press(f.search(), "ArrowDown");
  assert.equal(down.defaultPrevented, true);
  assert.equal(f.doc.activeElement, chordOf("Command palette"), "the first visible row");
  f.press(f.doc.activeElement, "ArrowDown");
  assert.equal(f.doc.activeElement, chordOf("Focus mode: toggle"));
  f.press(f.doc.activeElement, "ArrowUp");
  assert.equal(f.doc.activeElement, chordOf("Command palette"));
  f.press(f.doc.activeElement, "ArrowUp");
  assert.equal(f.doc.activeElement, f.search(), "Up from the first row returns to the search");
  // Filtered: Down goes to the first row the search shows, and stops at the last.
  f.type("tabs");
  f.press(f.search(), "ArrowDown");
  assert.equal(f.doc.activeElement, chordOf("Close tab"));
  f.press(f.doc.activeElement, "ArrowDown"); f.press(f.doc.activeElement, "ArrowDown");
  assert.equal(f.doc.activeElement, chordOf("Next tab"));
  f.press(f.doc.activeElement, "ArrowDown");
  assert.equal(f.doc.activeElement, chordOf("Scroll back in a terminal"), "the group's read-only row is a row too");
  f.press(f.doc.activeElement, "ArrowDown");
  assert.equal(f.doc.activeElement, chordOf("Scroll back in a terminal"), "Down on the last row stays");
  // A row's reset button moves along the rows too.
  setBinding("tabs.close", "Ctrl+Shift+X");
  f.rowFor("Close tab").querySelector(".kb-reset").focus();
  f.press(f.doc.activeElement, "ArrowDown");
  assert.equal(f.doc.activeElement, chordOf("Go to tab 1"));
});

test("keyboard: Esc clears a non-empty search first (from the search or a row), then closes; while recording it only cancels", (t) => {
  const f = setupLinux(t);
  f.editor.open();
  f.type("side");
  f.press(f.search(), "ArrowDown");
  const esc = f.press(f.doc.activeElement, "Escape");
  assert.equal(esc.defaultPrevented, true);
  assert.equal(f.search().value, "");
  assert.equal(f.doc.activeElement, f.search(), "focus goes back to the search");
  assert.equal(f.shown().length, 10);
  assert.equal(f.doc.querySelector(".kb-count").textContent, "10 shortcuts");
  assert.equal(f.editor.isOpen(), true);
  // Recording: Esc cancels the recording, the search stays as it is.
  f.type("side");
  f.rowFor("Sidebar: show or hide").querySelector(".kb-chord").click();
  f.doc.dispatchEvent(key(f.doc, "Escape"));
  assert.equal(f.editor.isOpen(), true);
  assert.equal(f.search().value, "side");
  assert.equal(getBinding("sidebar.toggle", false), "Ctrl+Shift+B");
  f.press(f.search(), "Escape");
  assert.equal(f.search().value, "");
  f.press(f.search(), "Escape");
  assert.equal(f.editor.isOpen(), false, "an empty search: Esc closes");
});

test("keyboard: the Tab trap skips the rows the search hides", (t) => {
  const f = setupLinux(t);
  f.editor.open();
  f.type("sidebar");
  const sidebarChord = f.rowFor("Sidebar: show or hide").querySelector(".kb-chord");
  sidebarChord.focus();
  const tab = f.press(f.doc.querySelector(".kb-overlay"), "Tab");
  assert.equal(tab.defaultPrevented, true, "the last visible control wraps (its reset is hidden)");
  assert.equal(f.doc.activeElement, f.search());
  const back = f.press(f.doc.querySelector(".kb-overlay"), "Tab", { shiftKey: true });
  assert.equal(back.defaultPrevented, true);
  assert.equal(f.doc.activeElement, sidebarChord);
});

test("rows: one keycap per key, read as one string; changed marker and Reset only when the binding differs from the default", (t) => {
  const f = setupLinux(t);
  f.editor.open();
  const chord = f.rowFor("Sidebar: show or hide").querySelector(".kb-chord");
  assert.deepEqual([...chord.querySelectorAll("kbd")].map((k) => k.textContent), ["Ctrl", "Shift", "B"]);
  assert.equal(chord.querySelector(".kb-keys").getAttribute("aria-hidden"), "true", "keycaps are not read key by key");
  assert.equal(chord.getAttribute("aria-label"), "Change shortcut for Sidebar: show or hide, currently Ctrl+Shift+B, works in a terminal");
  assert.equal(f.rowFor("Sidebar: show or hide").querySelector(".kb-marks").getAttribute("aria-hidden"), "true");
  assert.equal(f.marks("Sidebar: show or hide", "changed"), null);
  assert.equal(f.rowFor("Sidebar: show or hide").querySelector(".kb-reset").hidden, true);
  setBinding("sidebar.toggle", "Ctrl+Alt+B");
  const row = f.rowFor("Sidebar: show or hide");
  assert.equal(f.marks("Sidebar: show or hide", "changed"), "changed");
  assert.equal(row.querySelector(".kb-mark-changed").title, "Changed from the default, Ctrl+Shift+B");
  assert.equal(row.querySelector(".kb-reset").hidden, false);
  assert.match(row.querySelector(".kb-chord").getAttribute("aria-label"), /currently Ctrl\+Alt\+B, works in a terminal, changed from the default$/);
  row.querySelector(".kb-reset").click();
  assert.equal(f.marks("Sidebar: show or hide", "changed"), null);
  // macOS keycaps: the modifier symbols, one per key.
  const mac = setupLinux(t, { isMac: true });
  mac.editor.open();
  assert.deepEqual([...mac.rowFor("Sidebar: show or hide").querySelectorAll(".kb-chord kbd")].map((k) => k.textContent), ["⌘", "B"]);
});

test("terminal marker on Linux/Windows: the allowlisted actions, by id, so it follows a rebind; never a non-allowlisted action", (t) => {
  const f = setupLinux(t);
  f.editor.open();
  const marked = () => [...f.doc.querySelectorAll(".kb-row")].filter((r) => r.querySelector(".kb-mark-terminal"))
    .map((r) => r.querySelector(".kb-label").textContent).sort();
  assert.deepEqual(marked(), ["Close tab", "Command palette", "Go to tab 1", "Instance panel: show or hide", "Next tab", "Quick open a soul", "Sidebar: show or hide"]);
  assert.equal(f.marks("Sidebar: show or hide", "terminal"), "terminal");
  assert.equal(f.rowFor("Sidebar: show or hide").querySelector(".kb-mark-terminal").title, "Works while a terminal has focus");
  // A rebind of an allowlisted action keeps the marker (the policy is by id), even to a plain Ctrl letter.
  setBinding("sidebar.toggle", "Ctrl+K");
  assert.equal(f.marks("Sidebar: show or hide", "terminal"), "terminal");
  // A non-allowlisted action never gets it, whatever it is bound to.
  setBinding("app.focusMode", "Ctrl+Shift+U");
  setBinding("focus.nextRegion", "Ctrl+Shift+Q");
  assert.equal(f.marks("Focus mode: toggle", "terminal"), null);
  assert.equal(f.marks("Focus the next region", "terminal"), null);
  assert.doesNotMatch(f.rowFor("Focus the next region").querySelector(".kb-chord").getAttribute("aria-label"), /terminal/);
  // Unbound, an allowlisted action fires nothing: no marker.
  setBinding("panel.toggle", null);
  assert.equal(f.marks("Instance panel: show or hide", "terminal"), null);
});

test("terminal marker on macOS follows the engine: ⌘ chords and Ctrl+Tab, not ⌃ chords, F6 or a modal dialog's own keys", (t) => {
  const f = setupLinux(t, { isMac: true, extra: [["spawn.jumpName", "Jump to Name", "spawn-dialog-local", "Mod+1"]] });
  f.editor.open();
  assert.equal(f.marks("Command palette", "terminal"), "terminal", "⌘K");
  assert.equal(f.marks("Quick open a soul", "terminal"), "terminal", "⌘P fires in a terminal on macOS");
  assert.equal(f.marks("Next tab", "terminal"), "terminal", "⌃Tab, the structural shape");
  assert.equal(f.marks("Go to tab 1", "terminal"), "terminal", "⌥⌘1");
  assert.equal(f.marks("Focus the next region", "terminal"), null, "F6 is the program's");
  assert.equal(f.marks("Jump to Name", "terminal"), null, "dispatched only by the open spawn dialog");
  setBinding("app.palette", "Ctrl+G");
  assert.equal(f.marks("Command palette", "terminal"), null, "a ⌃ rebind stays the program's");
  setBinding("tabs.next", "Ctrl+G");
  assert.equal(f.marks("Next tab", "terminal"), null, "the exemption is the shape as well as the id");
});

test("shortcutMatches: label, group, chord as shown; macOS words for the modifier symbols", () => {
  const row = { label: "Sidebar: show or hide", group: "Global", chord: "Mod+Shift+B" };
  assert.equal(shortcutMatches(row, "", false), true);
  assert.equal(shortcutMatches(row, "SHOW OR", false), true);
  assert.equal(shortcutMatches(row, "glob", false), true);
  for (const q of ["shift+b", "ctrl shift b", "ctrlshiftb", "control shift b"]) assert.equal(shortcutMatches(row, q, false), true, q);
  for (const q of ["cmd shift b", "⇧⌘B", "command+b", "shift b"]) assert.equal(shortcutMatches(row, q, true), true, `mac ${q}`);
  for (const q of ["ctrl+p", "alt b", "cmd b"]) assert.equal(shortcutMatches(row, q, false), false, q);
  assert.equal(shortcutMatches({ label: "x", group: "Tabs", chord: null }, "unb", false), true);
  assert.equal(shortcutMatches({ label: "x", group: "Tabs", chord: null }, "ctrl", false), false);
});

test("group headings keep today's order and stick to the top of the scroll area", async (t) => {
  const f = setupLinux(t);
  f.editor.open();
  const groups = [...f.doc.querySelectorAll(".kb-body > .kb-group")];
  assert.deepEqual(groups.map((g) => g.querySelector(":scope > h3.kb-context").textContent), ["Global", "Tabs"]);
  for (const g of groups) assert.equal(g.firstElementChild.className, "kb-context", "the heading leads its group");
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../renderer/shell.css", import.meta.url), "utf8");
  assert.match(css, /\.kb-context \{ position: sticky; top: 0;[^}]*background: var\(--surface\)/, "sticky on an opaque surface");
  assert.match(css, /\.kb-group\[hidden\], \.kb-row\[hidden\], \.kb-nomatch\[hidden\] \{ display: none; \}/);
});

test("search: the announced count follows a rebind, unbind or reset that changes what the search shows", (t) => {
  const f = setupLinux(t);
  f.editor.open();
  const count = f.doc.querySelector(".kb-count");
  setBinding("app.palette", "Ctrl+J");
  assert.equal(count.textContent, "", "no search yet: a rebind announces nothing");
  f.type("shift+b");
  assert.equal(count.textContent, "1 shortcut");
  setBinding("sidebar.toggle", null); // Backspace in the recorder
  assert.deepEqual(f.shown(), []);
  assert.equal(count.textContent, "0 shortcuts");
  assert.equal(f.doc.querySelector(".kb-nomatch").textContent, "No shortcut matches “shift+b”");
  f.rowFor("Sidebar: show or hide").querySelector(".kb-reset").click();
  assert.equal(count.textContent, "1 shortcut");
});

test("a focused row is revealed below its group's pinned heading, not left under it", (t) => {
  const f = setupLinux(t);
  f.editor.open();
  // jsdom has no layout: give the scroll area, the heading and the row the geometry of a row
  // scrolled up under the pinned heading (Chromium's own focus scroll ignores the heading).
  const body = f.doc.querySelector(".kb-body");
  const row = f.rowFor("Next tab");
  const heading = row.closest(".kb-group").querySelector(".kb-context");
  Object.defineProperty(body, "clientHeight", { value: 300 });
  Object.defineProperty(body, "scrollTop", { value: 200, writable: true });
  body.getBoundingClientRect = () => ({ top: 100, bottom: 400 });
  heading.getBoundingClientRect = () => ({ top: 100, bottom: 130 });
  row.getBoundingClientRect = () => ({ top: 112, bottom: 146 });
  row.querySelector(".kb-chord").focus();
  assert.equal(body.scrollTop, 182, "scrolled up by the 18px the heading covered");
  // A row already clear of the heading is left where it is.
  row.getBoundingClientRect = () => ({ top: 160, bottom: 194 });
  f.search().focus();
  row.querySelector(".kb-chord").focus();
  assert.equal(body.scrollTop, 182);
});

test("a narrow window keeps every control inside the editor: the title gives way, row controls wrap under the label", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../renderer/shell.css", import.meta.url), "utf8");
  const narrow = css.match(/@media \(max-width: 620px\) \{\n([^]*?)\n\}/)?.[1] ?? "";
  for (const rule of [/\.kb-head \{ flex-wrap: wrap; \}/, /\.kb-title \{ display: none; \}/, /\.kb-row \{ flex-wrap: wrap;/,
    /\.kb-main \{ flex-basis: 100%; \}/, /\.kb-marks \{ width: auto;/, /\.kb-chord-cell \{ width: auto; \}/]) assert.match(narrow, rule);
});

// ── The leader (docs/desktop-keyboard.md, "The leader"): help leads with it ─────────────────────
const LEADER_EXTRA = [
  ["app.leader", "Leader: the commands that follow one key", "global"],
  ["stage.hierarchy", "View: Workspace › Machines", "global"],
  ["stage.automations", "View: Automations", "global"],
  ["sidebar.key.instances", "Instances", "sidebar"],
  ["sidebar.key.help", "Edit keyboard shortcuts", "sidebar"],
];

// The stage rows above are labelled as the shell labels them: `View: <label>` of NAV and NAV_TABS, so
// Machines, a tab of the Workspace page (NAV_TABS, the product owner, 2026-10-26), reads "View: Workspace › Machines"
// in the editor, and Automations, a page of its own again (NAV), "View: Automations".
test("the stage rows' labels are the shell's, Machines' from NAV_TABS, Automations' from NAV", async () => {
  const { readFileSync } = await import("node:fs");
  const shell = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
  assert.match(shell, /\[\.\.\.NAV, \.\.\.NAV_TABS\]\.forEach\(\(v\) => registerAction\(\{\n  id: `stage\.\$\{v\.name\}`, label: `View: \$\{v\.label\}`/);
  for (const [id, label] of LEADER_EXTRA.filter(([id]) => id.startsWith("stage."))) {
    const entry = [...NAV, ...NAV_TABS].find((v) => `stage.${v.name}` === id);
    assert.ok(entry, `${id} is a shell destination`);
    assert.equal(label, `View: ${entry.label}`, id);
  }
  assert.deepEqual(NAV_TABS.map((v) => [v.name, v.page, v.tab]), [["hierarchy", "spawn", "machines"]]);
  assert.ok(NAV.some((v) => v.name === "automations"), "Automations is a page again");
  assert.equal(NAV.some((v) => v.name === "hierarchy"), false, "Machines is no page of its own");
});

// The group moves as the shell registers them (shell.mjs), so the leader's Tab and Shift+Tab rows
// carry their labels.
const GROUP_MOVES = [
  ["split.focusNextGroup", "Focus the next editor group", "tabs"],
  ["split.focusPrevGroup", "Focus the previous editor group", "tabs"],
];

test("the editor opens on a Leader group, then Sidebar keys, then the groups as today", (t) => {
  const f = setupLinux(t, { extra: [...LEADER_EXTRA, ...GROUP_MOVES] });
  f.editor.open();
  const groups = [...f.doc.querySelectorAll(".kb-body > .kb-group")].map((g) => g.dataset.label);
  assert.deepEqual(groups, ["Leader", "Sidebar keys", "Global", "Tabs"]);
  assert.deepEqual(groupActions().map((g) => g.context).slice(0, 2), ["leader", "sidebar"]);
  const leader = f.doc.querySelector('.kb-group[data-label="Leader"]');
  const rows = [...leader.querySelectorAll(".kb-row")];
  // First the rebindable leader itself, marked as working in a terminal.
  assert.equal(rows[0].querySelector(".kb-label").textContent, "Leader: the commands that follow one key");
  assert.deepEqual([...rows[0].querySelectorAll("button.kb-chord kbd")].map((k) => k.textContent), ["Ctrl", "X"]);
  assert.equal(f.marks("Leader: the commands that follow one key", "terminal"), "terminal");
  // Then one read-only row per entry of the table the Desktop runs: no m.
  const fixed = rows.slice(1);
  assert.equal(fixed.length, 25, "26 rows of the TUI's table, less m");
  assert.ok(fixed.every((row) => row.classList.contains("kb-row-fixed") && !row.querySelector("button")), "read-only: no button to record or reset");
  const palette = fixed[0];
  assert.equal(palette.querySelector(".kb-label").textContent, "Command palette", "a key that runs one action shows its label");
  assert.equal(palette.querySelector(".kb-chord .sr-only").textContent, "Ctrl+X then K or Space, fixed");
  assert.deepEqual([...palette.querySelectorAll(".kb-keys kbd")].map((k) => k.textContent), ["Ctrl+X", "K", "Space"]);
  assert.ok(fixed.some((row) => row.querySelector(".kb-label").textContent === "Instance roster"), "Esc");
  // ↑ / ↓ are the workspace moves, in the Desktop's words; the previous / next instance are no leader row (chords alone).
  const labelled = (text) => fixed.find((row) => row.querySelector(".kb-label").textContent === text);
  for (const [text, cap] of [["Show the previous workspace in the list", "↑"], ["Show the next workspace in the list", "↓"]]) {
    assert.ok(labelled(text), text);
    assert.deepEqual([...labelled(text).querySelectorAll(".kb-keys kbd")].map((k) => k.textContent), ["Ctrl+X", cap], text);
  }
  assert.equal(labelled("Open the previous instance's terminal") ?? labelled("Open the next instance's terminal") ?? null, null, "not the leader's");
  // Tab and Shift+Tab are the next and the previous group, by their actions' labels, in the table's order.
  for (const [text, caps] of [["Focus the next editor group", ["Ctrl+X", "Tab"]], ["Focus the previous editor group", ["Ctrl+X", "Shift+Tab"]]]) {
    assert.ok(labelled(text), text);
    assert.deepEqual([...labelled(text).querySelectorAll(".kb-keys kbd")].map((k) => k.textContent), caps, text);
  }
  assert.equal(fixed.indexOf(labelled("Focus the previous editor group")), fixed.indexOf(labelled("Focus the next editor group")) + 1, "Shift+Tab right after Tab");
  assert.equal(labelled("Focus the previous editor group").querySelector(".kb-chord .sr-only").textContent, "Ctrl+X then Shift+Tab, fixed");
  // The quiet line: the leader is the TUI's, the direct chords are extras, and where 1 and 3 differ.
  const extras = leader.querySelector(".kb-extras");
  assert.match(extras.textContent, /the TUI's/);
  assert.match(extras.textContent, /Ctrl\+X then 1 is Instances and Ctrl\+X then 3 is Capabilities, while Ctrl\+1 stays Machines and Ctrl\+3 stays Automations/);
  // The stage rows say it too.
  assert.match(f.rowFor("View: Workspace › Machines").querySelector(".kb-note").textContent, /Ctrl\+X then 1 is Instances/);
  assert.match(f.rowFor("View: Automations").querySelector(".kb-note").textContent, /Ctrl\+X then 3 is Capabilities/);
});

test("the leader's rows are found by their keys and by \"leader\", and Up/Down reach them", (t) => {
  const f = setupLinux(t, { extra: LEADER_EXTRA });
  f.editor.open();
  f.type("ctrl+x k");
  const found = () => [...f.doc.querySelectorAll(".kb-row")].filter((r) => !r.closest("[hidden]"))
    .map((r) => `${r.closest(".kb-group").dataset.label}: ${r.querySelector(".kb-label").textContent}`);
  // The leader's row alone: no key of the palette's own chord Alt+K starts with "x".
  assert.deepEqual(found().sort(), ["Leader: Command palette"]);
  f.type("ctrl+x shift+n");
  assert.ok(f.shown().includes("Spawn another of the instance's soul…"));
  f.type("leader");
  assert.equal(f.shown().length, 26, "the group's name finds all of it");
  f.type("");
  // Arrow walk: the leader's row, then its fixed rows.
  const chords = [...f.doc.querySelectorAll('.kb-group[data-label="Leader"] .kb-chord')];
  chords[0].focus();
  f.press(chords[0], "ArrowDown");
  assert.equal(f.doc.activeElement, chords[1], "a read-only row takes focus from the arrows");
  assert.equal(chords[1].tabIndex, -1, "but is not a Tab stop");
});

test("a rebind of the leader is shown everywhere the editor names it", (t) => {
  const f = setupLinux(t, { extra: LEADER_EXTRA });
  setBinding("app.leader", "Alt+L");
  f.editor.open();
  const fixed = f.doc.querySelector(".kb-row-fixed");
  assert.equal(fixed.querySelector(".kb-chord .sr-only").textContent, "Alt+L then K or Space, fixed");
  assert.match(f.doc.querySelector(".kb-extras").textContent, /Alt\+L then 1 is Instances/);
  f.type("alt+l k");
  assert.deepEqual(f.shown(), ["Command palette"]);
});

// ── The chord family (keys.json; docs/desktop-keyboard.md, "The chord families") ────────────────
// On Linux/Windows the page's top holds a three-way choice, Alt (the default), Ctrl+Alt or
// Ctrl+Shift; a change writes keys.json through main at once and the keymap switches at once.
// `desk` stands for main: it answers, writes and fails as told.
function familySetup(t, { isMac = false, answer = { family: "alt", why: "missing", note: null }, fail = false } = {}) {
  const dom = new JSDOM("<!doctype html><body>");
  const doc = dom.window.document;
  resetAllBindings();
  const offs = [
    registerAction({ id: "app.palette", label: "Command palette", context: "global", run: () => {} }),
    registerAction({ id: "sidebar.toggle", label: "Sidebar: show or hide", context: "global", run: () => {} }),
    registerAction({ id: "tabs.close", label: "Close tab", context: "tabs", run: () => {} }),
  ];
  const writes = [];
  const desk = {
    chordFamily: async () => answer,
    setChordFamily: async (family) => { writes.push(family); if (fail) throw new Error("EACCES"); return { family, why: null, note: null }; },
    onChordFamilyChanged: () => () => {},
  };
  const chordFamily = createChordFamily({ desk, apply: setChordFamily });
  const editor = createKeybindingsEditor({ doc, isMac, chordFamily });
  t.after(() => { editor.close(); for (const off of offs) off(); resetAllBindings(); setChordFamily("alt"); dom.window.close(); });
  const choice = () => doc.querySelector(".kb-family");
  const radio = (family) => doc.querySelector(`.kb-family input[value="${family}"]`);
  const choose = async (family) => { radio(family).click(); for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  // A row's chord as its keycaps show it, one per key ("Ctrl+Shift+K": Ctrl, Shift, K).
  const chordOf = (label) => [...[...doc.querySelectorAll(".kb-row")].find((r) => r.querySelector(".kb-label").textContent === label).querySelectorAll(".kb-keys kbd")].map((k) => k.textContent).join("+");
  return { doc, editor, chordFamily, writes, choice, radio, choose, chordOf };
}

test("chord family: Linux/Windows shows the choice at the top, in its words, naming the family in use", async (t) => {
  const f = familySetup(t, { answer: { family: "ctrl+shift", why: null, note: null } });
  await f.chordFamily.start();
  f.editor.open();
  const choice = f.choice();
  assert.ok(choice, "the choice is there");
  assert.equal(choice.tagName, "FIELDSET");
  assert.equal(choice.previousElementSibling.className, "kb-head", "at the top, under the head");
  assert.equal(choice.querySelector("legend").textContent, "Shortcut family, shared with oats tui");
  assert.deepEqual([...choice.querySelectorAll("label")].map((l) => l.textContent.trim()),
    ["Alt (default)", "Ctrl+Alt (for programs that read Alt)", "Ctrl+Shift (foot, Alacritty)"]);
  assert.deepEqual([...choice.querySelectorAll("input")].map((i) => i.value), ["alt", "ctrl+alt", "ctrl+shift"], "in that order");
  assert.deepEqual({ ...CHORD_FAMILY_WORDS.options },
    { alt: "Alt (default)", "ctrl+alt": "Ctrl+Alt (for programs that read Alt)", "ctrl+shift": "Ctrl+Shift (foot, Alacritty)" });
  assert.equal(f.radio("ctrl+shift").checked, true, "the family in use is the one chosen");
  assert.equal(f.radio("alt").checked, false);
  assert.equal(f.radio("ctrl+alt").checked, false);
  assert.equal(choice.querySelector(".kb-family-tui").textContent, "All three work here; pick the one your terminal passes to oats tui. oats tui uses it from its next start.");
  assert.equal(choice.querySelector(".kb-family-note").hidden, true, "nothing more to say");
  assert.equal(f.chordOf("Command palette"), "Ctrl+Shift+K", "the rows show the family's keys");
});

test("chord family: macOS has no choice, and neither has an editor given no family", async (t) => {
  const mac = familySetup(t, { isMac: true });
  mac.editor.open();
  assert.equal(mac.choice(), null);
  mac.editor.close();
  const dom = new JSDOM("<!doctype html><body>");
  t.after(() => dom.window.close());
  const bare = createKeybindingsEditor({ doc: dom.window.document, isMac: false });
  bare.open();
  assert.equal(dom.window.document.querySelector(".kb-family"), null);
  bare.close();
});

test("chord family: a change writes keys.json at once and the keymap switches at once, rows included", async (t) => {
  const f = familySetup(t);
  await f.chordFamily.start();
  f.editor.open();
  assert.equal(f.radio("alt").checked, true, "no file: the default, Alt");
  assert.equal(f.chordOf("Command palette"), "Alt+K");
  assert.equal(f.chordOf("Close tab"), "Alt+W");
  await f.choose("ctrl+shift");
  assert.deepEqual(f.writes, ["ctrl+shift"], "written once, with the family chosen");
  assert.equal(activeChordFamily(), "ctrl+shift");
  assert.equal(getBinding("app.palette", false), "Ctrl+Shift+K");
  assert.equal(f.chordOf("Command palette"), "Ctrl+Shift+K", "the page follows");
  assert.equal(f.chordOf("Close tab"), "Ctrl+Shift+W");
  assert.equal(f.radio("ctrl+shift").checked, true);
  await f.choose("ctrl+alt");
  assert.deepEqual(f.writes, ["ctrl+shift", "ctrl+alt"]);
  assert.equal(activeChordFamily(), "ctrl+alt");
  assert.equal(f.chordOf("Command palette"), "Ctrl+Alt+K");
  assert.equal(f.chordOf("Close tab"), "Ctrl+Alt+W");
  assert.equal(f.radio("ctrl+alt").checked, true);
  await f.choose("alt");
  assert.deepEqual(f.writes, ["ctrl+shift", "ctrl+alt", "alt"], "Alt, chosen, is written too");
  assert.equal(activeChordFamily(), "alt");
  assert.equal(f.chordOf("Command palette"), "Alt+K");
  assert.equal(f.radio("alt").checked, true);
});

test("chord family: a user who chose Ctrl+Alt sees it chosen, and its keys", async (t) => {
  const f = familySetup(t, { answer: { family: "ctrl+alt", why: null, note: null } });
  await f.chordFamily.start();
  f.editor.open();
  assert.equal(f.radio("ctrl+alt").checked, true);
  assert.equal(f.radio("alt").checked, false);
  assert.equal(f.choice().querySelector(".kb-family-note").hidden, true, "the file chose it: nothing to say");
  assert.equal(f.chordOf("Command palette"), "Ctrl+Alt+K");
});

test("chord family: the note main sends is shown under the choice", async (t) => {
  const f = familySetup(t, { answer: { family: "alt", why: "unknown-chords", note: "keys.json: unknown chords value, using Alt" } });
  await f.chordFamily.start();
  f.editor.open();
  const note = f.choice().querySelector(".kb-family-note");
  assert.equal(note.hidden, false);
  assert.equal(note.textContent, "keys.json: unknown chords value, using Alt");
  assert.equal(f.radio("alt").checked, true);
  // Chosen now, the file chose: nothing more to say.
  await f.choose("ctrl+shift");
  assert.equal(note.hidden, true);
});

test("chord family: a write that fails keeps the family in use, and says so", async (t) => {
  const f = familySetup(t, { fail: true });
  await f.chordFamily.start();
  f.editor.open();
  await f.choose("ctrl+shift");
  assert.deepEqual(f.writes, ["ctrl+shift"]);
  assert.equal(activeChordFamily(), "alt", "nothing switched");
  assert.equal(f.radio("alt").checked, true, "the choice is back on the family in use");
  const note = f.choice().querySelector(".kb-family-note");
  assert.equal(note.hidden, false);
  assert.equal(note.textContent, "Could not write keys.json: the shortcuts stay Alt. Fix or remove the file, then choose again.");
  assert.equal(note.getAttribute("role"), "status");
});

test("chord family: a stored override on one of the seven keys shows its clash with the new default", async (t) => {
  const f = familySetup(t);
  await f.chordFamily.start();
  setBinding("sidebar.toggle", "Ctrl+Shift+K");
  f.editor.open();
  assert.equal(f.doc.querySelector(".kb-clashes").hidden, true, "no clash under Alt, the default");
  await f.choose("ctrl+shift");
  const banner = f.doc.querySelector(".kb-clashes");
  assert.equal(banner.hidden, false);
  assert.match(banner.textContent, /Ctrl\+Shift\+K runs “Sidebar: show or hide” \(yours\) where both apply; “Command palette” has it by default\./);
  const row = f.doc.querySelector('.kb-chord[data-action-id="sidebar.toggle"]').closest(".kb-row");
  assert.match(row.querySelector(".kb-conflict").textContent, /Also bound to “Command palette”/);
  assert.equal(getBinding("sidebar.toggle", false), "Ctrl+Shift+K", "the stored rebind is kept");
});

// Settings: Connections (#1497) left the sidebar's settings menu (2026-10-23): it stays findable from the shortcuts
// list, where the shell's registry entry (app.connections) is listed under Global with its label, and found by search.
test("Settings: Connections is in the shortcuts list (Global, by its label) and its search, from the shell's own registry entry", (t) => {
  const shell = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
  const line = shell.match(/^registerAction\(\{ id: "app\.connections",[^\n]*\}\);$/m)?.[0];
  assert.ok(line, "the shipped registration");
  let opened = 0;
  const f = setupLinux(t);
  const off = runInNewContext(line, { registerAction, openConnections: () => { opened++; } });
  t.after(off);
  assert.equal(groupActions().find((g) => g.context === "global")?.actions.some((a) => a.id === "app.connections" && a.label === "Settings: Connections…"), true);
  f.editor.open();
  const row = f.rowFor("Settings: Connections…");
  assert.ok(row, "listed");
  assert.equal(row.closest(".kb-group").dataset.label, "Global");
  assert.equal(row.querySelector(".kb-chord").textContent, "unbound", "no default key, rebindable like every row");
  for (const q of ["connections", "Settings: Conn", "settings"]) {
    f.type(q);
    assert.ok(f.shown().includes("Settings: Connections…"), `"${q}" finds it`);
  }
  assert.equal(opened, 0, "listing it runs nothing");
});

// ── What has no button (the sidebar's simpler foot) is taught by the editor's own rows ───────────
// The palette and Connections have no button (the settings cog's menu holds Theme… and Keyboard
// shortcuts… alone); Machines is a tab of the Workspace page, and Spawn instance (Quick Open), Workspace overview and
// Automations are small buttons (the product owner, 2026-10-26). These are all taught in the shortcuts editor, by
// their rows alone (no line above them). The rows are the shipped registrations, run as shipped.
async function shippedRows() {
  const { readFileSync } = await import("node:fs");
  const { runInNewContext } = await import("node:vm");
  const src = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
  const statements = ["app.palette", "app.quickOpenSouls", "app.chooseSoul", "app.connections"]
    .map((id) => src.match(new RegExp(`^registerAction\\(\\{ id: "${id.replace(".", "\\.")}", .*\\);$`, "m"))?.[0]);
  statements.push(src.match(/\[\.\.\.NAV, \.\.\.NAV_TABS\]\.forEach\(\(v\) => registerAction\(\{[^]*?\n\}\)\);/)?.[0]);
  assert.ok(statements.every(Boolean), "the shipped registrations");
  const rows = [];
  for (const statement of statements) {
    runInNewContext(statement, { NAV, NAV_TABS, registerAction: ({ id, label, context }) => { rows.push([id, label, context]); } });
  }
  return rows;
}

for (const [platform, isMac] of [["macOS", true], ["Linux", false]]) {
  for (const family of ["alt", "ctrl+alt", "ctrl+shift"]) {
    test(`what lost its button is taught by its rows: ${platform}, ${family} family`, async (t) => {
      setChordFamily(family);
      t.after(() => setChordFamily("alt"));
      const shipped = await shippedRows();
      const f = setupLinux(t, { isMac, extra: [LEADER_EXTRA[0], ...shipped] });
      f.editor.open();
      const caps = (row) => [...row.querySelectorAll(".kb-keys kbd")].map((k) => k.textContent);
      const rowIn = (group, label) => [...f.doc.querySelectorAll(`.kb-group[data-label="${group}"] .kb-row`)]
        .find((r) => r.querySelector(".kb-label").textContent === label);
      const chord = (label) => f.rowFor(label).querySelector("button.kb-chord");
      // The command palette: the leader then K or Space leads the editor, and its own chord is in Global,
      // in the family in use (macOS has none: ⌘K).
      const leaderRow = f.doc.querySelector('.kb-group[data-label="Leader"] .kb-row-fixed');
      assert.equal(leaderRow.querySelector(".kb-label").textContent, "Open the command palette", "the Leader group's first key");
      assert.deepEqual(caps(leaderRow), [isMac ? "⌃X" : "Ctrl+X", "K", "Space"]);
      assert.equal(leaderRow.querySelector(".kb-chord .sr-only").textContent, `${isMac ? "⌃X" : "Ctrl+X"} then K or Space, fixed`);
      const palette = rowIn("Global", "Open the command palette");
      const paletteKeys = isMac ? ["⌘", "K"] : { alt: ["Alt", "K"], "ctrl+alt": ["Ctrl", "Alt", "K"], "ctrl+shift": ["Ctrl", "Shift", "K"] }[family];
      assert.deepEqual(caps(palette), paletteKeys);
      assert.equal(palette.querySelector("button.kb-chord").getAttribute("aria-label"),
        `Change shortcut for Open the command palette, currently ${paletteKeys.join(isMac ? "" : "+")}, works in a terminal`);
      // Connections: listed with no default chord, named as the palette names it, rebindable from its row.
      const settings = rowIn("Global", "Settings: Connections…");
      assert.ok(settings, "Connections is a row of its own");
      assert.equal(settings.querySelector("button.kb-chord").textContent, "unbound");
      assert.ok(settings.querySelector("button.kb-chord").classList.contains("kb-unbound"));
      assert.equal(settings.querySelector("button.kb-chord").getAttribute("aria-label"), "Change shortcut for Settings: Connections…, currently unbound");
      // Each lands where its row says, on its default chord in either family.
      const mod = (k) => (isMac ? ["⌘", k] : ["Ctrl", k]);
      // The sidebar's Spawn instance runs Quick Open: its row, in the family in use.
      assert.deepEqual(caps(rowIn("Global", "New agent: choose a soul")),
        isMac ? ["⌘", "P"] : { alt: ["Alt", "P"], "ctrl+alt": ["Ctrl", "Alt", "P"], "ctrl+shift": ["Ctrl", "Shift", "P"] }[family]);
      assert.deepEqual(caps(rowIn("Global", "Souls: choose a soul to spawn (Workspace › Souls)")), isMac ? ["⌘", "N"] : ["Ctrl", "Shift", "N"]);
      const machines = rowIn("Global", "View: Workspace › Machines");
      assert.ok(machines, "Machines says it is the Workspace page's tab");
      assert.deepEqual(caps(machines), mod("1"));
      assert.equal(machines.querySelector(".kb-note").textContent, `${isMac ? "⌃X" : "Ctrl+X"} then 1 is Instances, as in the TUI`);
      assert.deepEqual(caps(rowIn("Global", "View: Workspace overview")), mod("2"));
      const automations = rowIn("Global", "View: Automations");
      assert.ok(automations, "Automations is a page of its own");
      assert.deepEqual(caps(automations), mod("3"));
      assert.equal(automations.querySelector(".kb-note").textContent, `${isMac ? "⌃X" : "Ctrl+X"} then 3 is Capabilities, as in the TUI`);
      assert.equal(f.rowFor("View: Workspace › Automations"), undefined, "no Automations tab");
      assert.match(f.doc.querySelector(".kb-extras").textContent, new RegExp(`${isMac ? "⌘1" : "Ctrl\\+1"} stays Machines and ${isMac ? "⌘3" : "Ctrl\\+3"} stays Automations\\.$`));
      // The rows alone: nothing above them but the editor's own lines (the family choice on Linux/Windows when given).
      assert.deepEqual([...f.doc.querySelectorAll(".kb-editor > p")].map((p) => p.className), ["kb-hint", "kb-clashes", "kb-count sr-only"]);
      // Found by their names.
      f.type("settings");
      assert.deepEqual(f.shown(), ["Settings: Connections…"]);
      f.type("palette");
      assert.deepEqual(f.shown(), ["Open the command palette", "Open the command palette"], "the leader's row and the chord's");
      f.type("automations");
      assert.deepEqual(f.shown(), ["View: Automations"]);
      f.type("");
      // Connections is rebound from its row, and its row then shows the chord.
      chord("Settings: Connections…").click();
      f.doc.dispatchEvent(key(f.doc, "j", isMac ? { code: "KeyJ", metaKey: true, altKey: true } : { ctrlKey: true, altKey: true }));
      assert.equal(getBinding("app.connections", isMac), "Mod+Alt+J");
      assert.deepEqual(caps(rowIn("Global", "Settings: Connections…")), isMac ? ["⌥", "⌘", "J"] : ["Ctrl", "Alt", "J"]);
    });
  }
}

// ── Most useful: the editor's first section, a read-only table from the live keymap ───────────────
const usefulShown = (doc) => [...doc.querySelectorAll(".kb-useful tbody tr")]
  .map((tr) => [tr.querySelector("th").textContent, tr.querySelector("td").textContent]);
// macOS has no family: its rows are the same in each. The workspace moves have a chord in the Alt
// family alone (Ctrl+Alt and Ctrl+Shift leave Alt+↑ / ↓ to the program), so there the leader's ↑ / ↓
// stand in.
const MAC_USEFUL = [
  ["Command palette", "⌘K"], ["New agent: choose a soul", "⌘P"], ["Previous / next tab", "⌥← / ⌥→"],
  ["Go to tab 1–9", "⌥⌘1 to ⌥⌘9"], ["Previous / next workspace", "⌥↑ / ⌥↓"], ["Split right / split down", "⌘\\ / ⇧⌘\\"],
  ["Previous / next split pane", "⌥⇧← / ⌥⇧→"], ["Close tab", "⌘W"], ["Focus mode", "⌥⌘Z"],
  ["Scroll back in a terminal", "Wheel up, ⇧PgUp or ⌃B then ["], ["The leader, then ? for everything", "⌃X then ?"],
];
const MOST_USEFUL = {
  mac: { alt: MAC_USEFUL, "ctrl+alt": MAC_USEFUL, "ctrl+shift": MAC_USEFUL },
  linux: {
    alt: [
      ["Command palette", "Alt+K"], ["New agent: choose a soul", "Alt+P"], ["Previous / next tab", "Alt+← / Alt+→"],
      ["Go to tab 1–9", "Alt+1 to Alt+9"], ["Previous / next workspace", "Alt+↑ / Alt+↓"],
      ["Split right / split down", "Alt+E / Alt+Shift+E"], ["Previous / next split pane", "Alt+Shift+← / Alt+Shift+→"],
      ["Close tab", "Alt+W"], ["Focus mode", "Alt+Z"],
      ["Scroll back in a terminal", "Wheel up, Shift+PgUp or Ctrl+B then ["], ["The leader, then ? for everything", "Ctrl+X then ?"],
    ],
    "ctrl+alt": [
      ["Command palette", "Ctrl+Alt+K"], ["New agent: choose a soul", "Ctrl+Alt+P"], ["Previous / next tab", "Alt+Shift+← / Alt+Shift+→"],
      ["Go to tab 1–9", "Ctrl+Alt+1 to Ctrl+Alt+9"], ["Previous / next workspace", "Ctrl+X then ↑ / ↓"],
      ["Split right / split down", "Ctrl+Alt+E / Ctrl+Alt+Shift+E"], ["Previous / next split pane", "Ctrl+Alt+Shift+A / Ctrl+Alt+A"],
      ["Close tab", "Ctrl+Alt+W"], ["Focus mode", "Ctrl+Alt+Z"],
      ["Scroll back in a terminal", "Wheel up, Shift+PgUp or Ctrl+B then ["], ["The leader, then ? for everything", "Ctrl+X then ?"],
    ],
    "ctrl+shift": [
      ["Command palette", "Ctrl+Shift+K"], ["New agent: choose a soul", "Ctrl+Shift+P"], ["Previous / next tab", "Alt+Shift+← / Alt+Shift+→"],
      ["Go to tab 1–9", "Ctrl+Alt+1 to Ctrl+Alt+9"], ["Previous / next workspace", "Ctrl+X then ↑ / ↓"],
      ["Split right / split down", "Ctrl+Shift+E / Ctrl+Shift+D"], ["Previous / next split pane", "Ctrl+Alt+Shift+A / Ctrl+Alt+A"],
      ["Close tab", "Ctrl+Shift+W"], ["Focus mode", "Ctrl+Shift+M"],
      ["Scroll back in a terminal", "Wheel up, Shift+PgUp or Ctrl+B then ["], ["The leader, then ? for everything", "Ctrl+X then ?"],
    ],
  },
};

for (const [platform, isMac] of [["macOS", true], ["Linux", false]]) {
  for (const family of ["alt", "ctrl+alt", "ctrl+shift"]) {
    test(`Most useful: the first section, a table of the live keys: ${platform}, ${family} family`, (t) => {
      setChordFamily(family);
      t.after(() => setChordFamily("alt"));
      const f = setupLinux(t, { isMac, extra: [LEADER_EXTRA[0]] });
      f.editor.open();
      const section = f.doc.querySelector(".kb-body").firstElementChild;
      assert.equal(section.className, "kb-useful", "above the list");
      assert.equal(section.querySelector("h3").textContent, "Most useful");
      const table = section.querySelector("table");
      assert.equal(table.getAttribute("aria-labelledby"), section.querySelector("h3").id, "the table is named by its heading");
      assert.deepEqual([...table.querySelectorAll("thead th")].map((th) => [th.scope, th.textContent]), [["col", "Action"], ["col", "Keys"]]);
      for (const tr of table.querySelectorAll("tbody tr")) {
        assert.equal(tr.firstElementChild.tagName, "TH", "each row's action is its header");
        assert.equal(tr.firstElementChild.scope, "row");
        assert.equal(tr.lastElementChild.tagName, "TD");
      }
      assert.deepEqual(usefulShown(f.doc), MOST_USEFUL[isMac ? "mac" : "linux"][family]);
      // Keycaps are the list's (.kb-keys kbd), the words the leader rows' (.kb-then); nothing in it is a control.
      const palette = table.querySelector("tbody tr td");
      assert.deepEqual([...palette.querySelectorAll(".kb-keys kbd")].map((k) => k.textContent), [MOST_USEFUL[isMac ? "mac" : "linux"][family][0][1]]);
      // The workspace moves: their chords, or the leader once and its two keys where the family has none.
      const leaderStandsIn = !isMac && family !== "alt";
      assert.deepEqual([...table.querySelectorAll("tbody tr")[4].querySelectorAll(".kb-then")].map((w) => w.textContent), leaderStandsIn ? ["then", "/"] : ["/"]);
      assert.equal(section.querySelector("button, input, [tabindex]"), null, "read-only");
      assert.equal(section.querySelector(".kb-row, .kb-chord"), null, "not a row of the list: the search and the arrows walk the list alone");
      assert.equal(f.doc.querySelectorAll('style[data-kb-useful]').length, 1, "its rules, once");
    });
  }
}

test("Most useful follows a rebind, an unbind and a reset in the list below, the leader standing in for a missing chord, and a search shows the list alone", (t) => {
  // The Ctrl+Alt family, where the workspace moves have no chord: the leader's keys show.
  setChordFamily("ctrl+alt");
  t.after(() => setChordFamily("alt"));
  const f = setupLinux(t, { extra: [LEADER_EXTRA[0]] });
  f.editor.open();
  const useful = (name) => usefulShown(f.doc).find(([n]) => n === name)[1];
  assert.equal(useful("Command palette"), "Ctrl+Alt+K");
  // Rebound in the list: shown here at once.
  f.doc.querySelector('button.kb-chord[data-action-id="app.palette"]').click();
  f.doc.dispatchEvent(key(f.doc, "j", { ctrlKey: true, shiftKey: true }));
  assert.equal(useful("Command palette"), "Ctrl+Shift+J");
  // Unbound: the leader's key for it stands in.
  f.doc.querySelector('button.kb-chord[data-action-id="tabs.close"]').click();
  f.doc.dispatchEvent(key(f.doc, "Backspace"));
  assert.equal(useful("Close tab"), "Ctrl+X then W");
  setBinding("tabs.prevPage", null);
  assert.equal(useful("Previous / next tab"), "Ctrl+X then ← / Alt+Shift+→", "one of a pair");
  setBinding("tabs.nextPage", null);
  assert.equal(useful("Previous / next tab"), "Ctrl+X then ← / →", "both: the leader once");
  // A tab key off the pattern: the nine are listed.
  setBinding("tabs.goto5", "Ctrl+Alt+F5");
  assert.equal(useful("Go to tab 1–9"), "Ctrl+Alt+1 / Ctrl+Alt+2 / Ctrl+Alt+3 / Ctrl+Alt+4 / Ctrl+Alt+F5 / Ctrl+Alt+6 / Ctrl+Alt+7 / Ctrl+Alt+8 / Ctrl+Alt+9");
  // The leader rebound or unbound: every leader key follows it, and with no leader they are unbound.
  setBinding("app.leader", "Alt+L");
  assert.equal(useful("Previous / next workspace"), "Alt+L then ↑ / ↓");
  assert.equal(useful("The leader, then ? for everything"), "Alt+L then ?");
  setBinding("app.leader", null);
  assert.equal(useful("Previous / next workspace"), "unbound / unbound");
  assert.equal(useful("Close tab"), "unbound");
  assert.equal(useful("Command palette"), "Ctrl+Shift+J", "a chord needs no leader");
  // Reset all: the defaults again.
  f.doc.querySelector(".kb-reset-all").click();
  assert.deepEqual(usefulShown(f.doc), MOST_USEFUL.linux["ctrl+alt"]);
  // A search shows the list alone; cleared, the section is back.
  f.type("palette");
  assert.equal(f.doc.querySelector(".kb-useful").hidden, true);
  f.type("");
  assert.equal(f.doc.querySelector(".kb-useful").hidden, false);
});

// Show only the current workspace (2026-10-23): the shell's own registration, run as shipped, is a Global row of the
// shortcuts list with its label and default chord (⌥⇧⌘O on macOS, Ctrl+Alt+Shift+O elsewhere), found by search, in
// the palette's list of actions, and running it toggles the list of workspaces (workspaceLabel.toggleCurrentOnly).
for (const isMac of [true, false]) test(`Show only the current workspace: the shell's registration is a Global row (${isMac ? "macOS" : "Linux/Windows"}), and runs the toggle`, (t) => {
  const shell = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
  const line = shell.match(/^registerAction\(\{ id: "workspaces\.currentOnly",[^\n]*\}\);$/m)?.[0];
  assert.ok(line, "the shipped registration");
  assert.match(line, /run: \(\) => workspaceLabel\.toggleCurrentOnly\(\)/);
  const f = setupLinux(t, { isMac });
  let toggled = 0;
  const off = runInNewContext(line, { registerAction, workspaceLabel: { toggleCurrentOnly: () => { toggled++; } } });
  t.after(off);
  const action = listActions().find((a) => a.id === "workspaces.currentOnly");
  assert.deepEqual([action?.label, action?.context], ["Show only the current workspace", "global"], "the palette lists it by this label");
  f.editor.open();
  const row = f.rowFor("Show only the current workspace");
  assert.ok(row, "listed"); assert.equal(row.closest(".kb-group").dataset.label, "Global");
  assert.equal(row.querySelector(".kb-chord").textContent, isMac ? "⌥⇧⌘O" : "CtrlAltShiftO", "its keycaps");
  f.type("current workspace"); assert.ok(f.shown().includes("Show only the current workspace"));
  assert.equal(toggled, 0, "listing it runs nothing");
  runAction("workspaces.currentOnly"); runAction("workspaces.currentOnly");
  assert.equal(toggled, 2, "each run toggles once");
});

// #1502: the Tabs group's one read-only row says how to scroll back in a terminal: the wheel, Shift+PgUp and
// Ctrl+B [, which every pane takes (the local viewer and the kernel's alike; Ctrl+B [ from tmux 3.3).
test("the Tabs group ends with a read-only row: scroll back with the wheel, Shift+PgUp or Ctrl+B [", (t) => {
  for (const [isMac, caps, said] of [[false, ["Shift+PgUp", "Ctrl+B", "["], "Wheel up, Shift+PgUp or Ctrl+B then [, fixed"],
    [true, ["⇧PgUp", "⌃B", "["], "Wheel up, ⇧PgUp or ⌃B then [, fixed"]]) {
    const f = setupLinux(t, { isMac });
    f.editor.open();
    const tabs = f.doc.querySelector('.kb-group[data-label="Tabs"]');
    const row = [...tabs.querySelectorAll(".kb-row")].at(-1);
    assert.equal(row.querySelector(".kb-label").textContent, "Scroll back in a terminal");
    assert.ok(row.classList.contains("kb-row-fixed") && !row.querySelector("button"), "read-only: no button to record or reset");
    assert.deepEqual([...row.querySelectorAll(".kb-keys kbd")].map((k) => k.textContent), caps);
    assert.equal(row.querySelector(".kb-keys").textContent, `Wheel up,${caps[0]}or${caps[1]}then${caps[2]}`, "the words between the keys");
    assert.equal(row.querySelector(".kb-chord .sr-only").textContent, said);
    assert.equal(row.title, `${TMUX_SENTENCE} ${REMOTE_SENTENCE}`, "its conditions, in the tooltip");
    assert.equal(row.querySelector(".kb-chord").tabIndex, -1, "reached by the arrows, not a Tab stop");
  }
});

// The scroll row's conditions: tmux 3.3 for Ctrl+B [ wherever the agent runs, and, for a terminal on another
// computer, that computer's OATS: a viewer older than 0.69.0 has neither Shift+PgUp nor Ctrl+B [.
const TMUX_SENTENCE = "Ctrl+B [ needs tmux 3.3 or later on the computer the agent runs on.";
const REMOTE_SENTENCE = "On another computer, Shift+PgUp and Ctrl+B [ need OATS 0.69.0 or later there.";
const scrollRow = (f) => f.rowFor("Scroll back in a terminal");
const scrollUseful = (f) => usefulShown(f.doc).find(([name]) => name === "Scroll back in a terminal")?.[1];

// A shortcut that fires while a terminal has focus takes its key before tmux: the scroll rows leave that key
// out, and the Tabs row's tooltip says which shortcut holds it. The rows ask the dispatcher's own rule, so they
// say what a keydown in a terminal does: matchEvent from xterm's helper textarea, with the tabs context active.
const terminalKeydown = (f, k, mods) => {
  const xterm = f.doc.createElement("div");
  xterm.className = "xterm";
  const textarea = f.doc.createElement("textarea");
  xterm.append(textarea);
  f.doc.body.append(xterm);
  const e = key(f.doc, k, mods);
  textarea.dispatchEvent(e);
  xterm.remove();
  return e;
};
const firesInATerminal = (f, k, mods) => {
  setActiveContexts(new Set(["tabs"]));
  try { return matchEvent(terminalKeydown(f, k, mods), { isMac: false }); } finally { setActiveContexts(new Set()); }
};

test("Ctrl+B recorded in the editor for a shortcut that works in a terminal: the scroll rows leave Ctrl+B [ out, and the tooltip names it", (t) => {
  const f = setupLinux(t, { extra: [LEADER_EXTRA[0]] });
  f.editor.open();
  // Recorded as a person does (the recorder stores Ctrl+B as Mod+B on Linux/Windows).
  f.doc.querySelector('button.kb-chord[data-action-id="tabs.next"]').click();
  f.doc.dispatchEvent(key(f.doc, "b", { ctrlKey: true }));
  assert.equal(getBinding("tabs.next", false), "Mod+B");
  assert.equal(firesInATerminal(f, "b", { ctrlKey: true }), "tabs.next", "the dispatcher takes Ctrl+B in a terminal");
  const row = scrollRow(f);
  assert.equal(row.querySelector(".kb-keys").textContent, "Wheel uporShift+PgUp");
  assert.equal(row.querySelector(".kb-chord .sr-only").textContent, "Wheel up or Shift+PgUp, fixed");
  assert.equal(row.title, "On another computer, Shift+PgUp needs OATS 0.69.0 or later there. Ctrl+B is bound to “Next tab”, which takes it before the terminal.");
  assert.equal(scrollUseful(f), "Wheel up or Shift+PgUp", "Most useful too");
  f.type("ctrl+b [");
  assert.ok(!f.shown().includes("Scroll back in a terminal"), "a key it leaves out does not find it");
  f.type("");
  // The leader on Ctrl+B takes it as well, and the tooltip names the leader.
  setBinding("tabs.next", null);
  setBinding("app.leader", "Ctrl+B");
  assert.equal(firesInATerminal(f, "b", { ctrlKey: true }), "app.leader");
  assert.equal(scrollRow(f).title, "On another computer, Shift+PgUp needs OATS 0.69.0 or later there. Ctrl+B is bound to “Leader: the commands that follow one key”, which takes it before the terminal.");
  // Reset: Ctrl+B is tmux's again, and both rows name it.
  f.doc.querySelector(".kb-reset-all").click();
  assert.equal(firesInATerminal(f, "b", { ctrlKey: true }), null);
  assert.equal(scrollRow(f).querySelector(".kb-keys").textContent, "Wheel up,Shift+PgUporCtrl+Bthen[");
  assert.equal(scrollRow(f).title, `${TMUX_SENTENCE} ${REMOTE_SENTENCE}`);
  assert.equal(scrollUseful(f), "Wheel up, Shift+PgUp or Ctrl+B then [");
});

test("Shift+PgUp bound to a shortcut that works in a terminal never fires there (a plain chord stays the terminal's), so the scroll rows keep it", (t) => {
  const f = setupLinux(t, { extra: [LEADER_EXTRA[0]] });
  f.editor.open();
  setBinding("tabs.next", "Shift+PageUp");
  assert.equal(firesInATerminal(f, "PageUp", { shiftKey: true }), null, "the dispatcher leaves it to the terminal");
  assert.equal(scrollRow(f).querySelector(".kb-keys").textContent, "Wheel up,Shift+PgUporCtrl+Bthen[");
  assert.equal(scrollRow(f).title, `${TMUX_SENTENCE} ${REMOTE_SENTENCE}`);
  assert.equal(scrollUseful(f), "Wheel up, Shift+PgUp or Ctrl+B then [");
});

// Linux/Windows: app.focusMode and focus.nextRegion are not on TERMINAL_ALLOWLIST. macOS: tabs.next and tabs.close are,
// but there only a chord with ⌘ fires in a terminal.
for (const [platform, isMac, ctrlB, shiftPgUp, whole] of [
  ["Linux/Windows", false, "app.focusMode", "focus.nextRegion", "Wheel up,Shift+PgUporCtrl+Bthen["],
  ["macOS", true, "tabs.next", "tabs.close", "Wheel up,⇧PgUpor⌃Bthen["],
]) test(`Ctrl+B and Shift+PgUp bound where they never fire in a terminal leave the scroll rows whole (${platform})`, (t) => {
  const f = setupLinux(t, { isMac });
  f.editor.open();
  setBinding(ctrlB, "Ctrl+B");
  setBinding(shiftPgUp, "Shift+PageUp");
  assert.equal(scrollRow(f).querySelector(".kb-keys").textContent, whole);
  assert.equal(scrollRow(f).title, `${TMUX_SENTENCE} ${REMOTE_SENTENCE}`);
});

test("the scroll row is found by its words and each of its keys, and adds no match to another chord's search", (t) => {
  const f = setupLinux(t);
  f.editor.open();
  for (const q of ["scroll", "wheel", "wheel up", "Wheel up", "shift+pgup", "pgup", "ctrl+b", "ctrl b [", "terminal"]) {
    f.type(q);
    assert.ok(f.shown().includes("Scroll back in a terminal"), q);
  }
  for (const q of ["shift+b", "Ctrl+Shift+B", "ctrl+shift+pgup"]) {
    f.type(q);
    assert.ok(!f.shown().includes("Scroll back in a terminal"), `${q}: its keys are three chords, never mixed`);
  }
});

test("shortcutMatches: a row whose keys are several chords matches when one chord does", () => {
  const row = { label: "Scroll back in a terminal", group: "Tabs", keys: [["Wheel", "up"], ["Shift", "PgUp"], ["Ctrl", "B", "["]] };
  assert.equal(shortcutMatches(row, "shift pgup", false), true);
  assert.equal(shortcutMatches(row, "ctrl+b", false), true);
  assert.equal(shortcutMatches(row, "wheel", false), true);
  assert.equal(shortcutMatches(row, "wheel up", false), true, "the gesture as shown");
  assert.equal(shortcutMatches(row, "ctrl+shift+b", false), false, "Ctrl and B from one chord, Shift from another, is no match");
  assert.equal(shortcutMatches(row, "ctrlb[", false), true, "a chord typed without separators");
  assert.equal(shortcutMatches({ ...row, keys: [] }, "ctrl", false), false);
});
