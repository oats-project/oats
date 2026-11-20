// Settings → Terminal (spec F, the operator's 2026-10-02 decision): the default
// terminal size is the face's, 15px for Inconsolata and 13px for Omarchy's font (the product owner, 2026-10-26;
// per face since #1571), and every reset lands there; a stepper in Settings
// changes the size live, clamped to 9–28 and persisted for the face in effect, on the same store as
// ⌘= / ⌘- / ⌘0 and the palette, so the keys and the control always agree.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { createTerminalSettings } from "../renderer/settings-terminal.mjs";
import { createConnections } from "../renderer/connections.mjs";

const read = name => readFileSync(new URL(`../renderer/${name}`, import.meta.url), "utf8");
const themeSource = read("theme.mjs"), shell = read("shell.mjs");

/** The shipped theme module over a jsdom document and a real-shaped storage. */
function rig(t, stored = {}, { isOmarchy = false, draws = () => true } = {}) {
  const dom = new JSDOM('<!doctype html><body><button id="opener">Settings</button></body>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const style = doc.createElement("style"); style.textContent = read("theme.css"); doc.head.append(style);
  const context = {
    document: doc, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
    localStorage: { getItem: key => stored[key] ?? null, setItem: (key, value) => { stored[key] = String(value); }, removeItem: key => { delete stored[key]; } },
  };
  const theme = runInNewContext(`${themeSource.replace(/\bexport /g, "")}
({ terminalTypography, setTerminalFontSize, resetTerminalFontSize, resetTerminalTypography, onTerminalTypographyChange, terminalDefaultSize, initFont, setFont })`, context);
  theme.initFont(false, draws, { isOmarchy }); // the shell's start: the host's defaults
  // The section's default store, composed from this theme instance (the same five calls).
  const store = { read: () => theme.terminalTypography().fontSize, set: theme.setTerminalFontSize,
    reset: theme.resetTerminalFontSize, subscribe: theme.onTerminalTypographyChange, defaultSize: theme.terminalDefaultSize };
  const section = createTerminalSettings({ doc, store, chords: { bigger: "⌘=", smaller: "⌘-", reset: "⌘0" } });
  doc.body.append(section.element);
  const q = selector => section.element.querySelector(selector);
  const ui = {
    input: q("input"), smaller: q('button[aria-label="Decrease font size"]'), bigger: q('button[aria-label="Increase font size"]'),
    reset: [...section.element.querySelectorAll("button")].find(b => b.textContent.startsWith("Reset")),
  };
  const type = value => { ui.input.value = value; ui.input.dispatchEvent(new dom.window.Event("change", { bubbles: true })); };
  // The shell's ⌘= and ⌘- actions, verbatim from shell.mjs (asserted below).
  const keys = { bigger: () => theme.setTerminalFontSize(theme.terminalTypography().fontSize + 1),
    smaller: () => theme.setTerminalFontSize(theme.terminalTypography().fontSize - 1) };
  return { dom, doc, theme, stored, section, ui, type, keys };
}
const SIZE = "oats.desktop.terminal.fontSize", OMARCHY_SIZE = "oats.desktop.terminal.fontSize.omarchy";

test("the default terminal size is 15px, and every reset (⌘0, the palette, Settings) lands on 15", t => {
  const r = rig(t, { [SIZE]: "20", "oats.desktop.terminal.fontFamily": "Menlo" });
  assert.equal(r.theme.terminalDefaultSize(), 15);
  assert.equal(r.dom.window.getComputedStyle(r.doc.documentElement).getPropertyValue("--term-font-size").trim(), "15px");
  assert.equal(r.ui.input.value, "20", "a stored user size wins over the default");
  r.ui.reset.click();
  assert.equal(r.theme.terminalTypography().fontSize, 15); assert.equal(r.stored[SIZE], undefined, "reset stores nothing");
  assert.equal(r.stored["oats.desktop.terminal.fontFamily"], "Menlo", "Settings resets the size only; the family is the palette's");
  assert.equal(r.ui.input.value, "15");
  assert.equal(r.ui.reset.textContent, "Reset to default (15)");
  r.theme.setTerminalFontSize(22); r.theme.resetTerminalTypography(); // ⌘0 and "Terminal: reset typography"
  assert.equal(r.theme.terminalTypography().fontSize, 15);
  assert.equal(r.ui.input.value, "15");
  assert.equal(shell.match(/run: \(\) => resetTerminalTypography\(\) \}/g)?.length, 2, "both shell resets use the forgetting reset");
});

// Until #1571 this test stored 20 under the one size key and expected it on Omarchy: that key is now Inconsolata's,
// and Omarchy's font keeps its own.
test("in Omarchy's font the default terminal size is 13px: shown, reset to, and a size stored for it still wins", t => {
  const r = rig(t, { [SIZE]: "15", [OMARCHY_SIZE]: "20" }, { isOmarchy: true });
  assert.equal(r.theme.terminalDefaultSize(), 13);
  assert.equal(r.dom.window.getComputedStyle(r.doc.documentElement).getPropertyValue("--term-font-size").trim(), "13px");
  assert.equal(r.ui.input.value, "20", "a size stored for Omarchy's font wins over the default");
  assert.equal(r.ui.reset.textContent, "Reset to default (13)");
  r.ui.reset.click();
  assert.equal(r.theme.terminalTypography().fontSize, 13); assert.equal(r.ui.input.value, "13"); assert.equal(r.stored[OMARCHY_SIZE], undefined);
  assert.equal(r.stored[SIZE], "15", "Inconsolata's size is not Settings' to reset in Omarchy's font");
  r.theme.setTerminalFontSize(22); r.theme.resetTerminalTypography(); // ⌘0
  assert.equal(r.theme.terminalTypography().fontSize, 13); assert.equal(r.stored[SIZE], "15");
});

test("a stored 15 (chosen for Inconsolata) opens at 13 in Omarchy's font; the stepper writes the face in effect only, and the label follows the font", t => {
  const r = rig(t, { [SIZE]: "15" }, { isOmarchy: true });
  const heard = [];
  r.theme.onTerminalTypographyChange(value => heard.push(value.fontSize)); // what every open terminal listens to
  assert.equal(r.ui.input.value, "13"); assert.equal(r.ui.reset.textContent, "Reset to default (13)");
  r.ui.bigger.click();
  assert.deepEqual([r.stored[OMARCHY_SIZE], r.stored[SIZE]], ["14", "15"]);
  r.theme.setFont("system");
  assert.equal(r.ui.input.value, "15", "System font: the stored Inconsolata size, in the open control");
  assert.equal(r.ui.reset.textContent, "Reset to default (15)", "the label is the face's default, updated in place");
  assert.deepEqual(heard, [14, 15], "open terminals hear the new face's size");
  r.ui.smaller.click(); r.type("11");
  assert.deepEqual([r.stored[OMARCHY_SIZE], r.stored[SIZE]], ["14", "11"]);
  r.ui.reset.click();
  assert.deepEqual([r.stored[OMARCHY_SIZE], r.stored[SIZE]], ["14", undefined]); assert.equal(r.ui.input.value, "15");
  r.theme.setFont("omarchy");
  assert.equal(r.ui.input.value, "14"); assert.equal(r.ui.reset.textContent, "Reset to default (13)");
});

test("the defaults are the face's on every host: Inconsolata 15 on Omarchy with System font, Omarchy's font 13 elsewhere; the fallback is Inconsolata's", t => {
  const system = rig(t, { "oats.desktop.font": "system" }, { isOmarchy: true });
  assert.deepEqual([system.ui.input.value, system.ui.reset.textContent], ["15", "Reset to default (15)"]);
  const chosen = rig(t, { "oats.desktop.font": "omarchy" });
  assert.deepEqual([chosen.ui.input.value, chosen.ui.reset.textContent], ["13", "Reset to default (13)"]);
  const fallback = rig(t, { [SIZE]: "16", [OMARCHY_SIZE]: "11" }, { isOmarchy: true, draws: () => false });
  assert.deepEqual([fallback.ui.input.value, fallback.ui.reset.textContent], ["16", "Reset to default (15)"],
    "Omarchy's font showing System font's faces: Inconsolata's size and default");
});

test("the stepper changes the size live, clamps to 9–28 and persists; its bounds stay focusable", t => {
  const r = rig(t, { [SIZE]: "15" }); // a stored start: these steps do not depend on the default
  const heard = [];
  r.theme.onTerminalTypographyChange(value => heard.push(value.fontSize)); // what every open terminal listens to
  r.ui.bigger.click(); r.ui.bigger.click();
  assert.equal(r.ui.input.value, "17"); assert.equal(r.stored[SIZE], "17"); assert.deepEqual(heard, [16, 17]);
  r.ui.smaller.click();
  assert.equal(r.stored[SIZE], "16");
  r.type("40");
  assert.equal(r.ui.input.value, "28", "a typed value above the range reads back as what applies");
  assert.equal(r.stored[SIZE], "28"); assert.equal(r.ui.bigger.getAttribute("aria-disabled"), "true");
  r.ui.bigger.click(); assert.equal(r.stored[SIZE], "28", "no step past the top");
  assert.equal(r.ui.bigger.disabled, false, "aria-disabled, not disabled: a focused button keeps focus at the bound");
  r.type("3");
  assert.equal(r.ui.input.value, "9"); assert.equal(r.stored[SIZE], "9");
  assert.equal(r.ui.smaller.getAttribute("aria-disabled"), "true"); assert.equal(r.ui.bigger.getAttribute("aria-disabled"), "false");
  r.ui.smaller.click(); assert.equal(r.stored[SIZE], "9");
  for (const below of ["0", "-3", "0.4"]) {
    r.type("20"); r.type(below);
    assert.deepEqual([r.ui.input.value, r.stored[SIZE]], ["9", "9"], `${below} is a number below the range: it clamps to 9, never resets`);
  }
  r.type("12.6"); assert.equal(r.stored[SIZE], "13", "whole pixels");
  for (const junk of ["", "abc", "  "]) { r.type(junk); assert.equal(r.ui.input.value, "13", `"${junk}" restores the size, never applies`); }
  assert.equal(r.stored[SIZE], "13");
  // Enter commits too; plain typing does not (no "1" on the way to "12").
  r.ui.input.value = "1"; r.ui.input.dispatchEvent(new r.dom.window.Event("input", { bubbles: true }));
  assert.equal(r.stored[SIZE], "13", "no commit per keystroke");
  r.ui.input.value = "12"; r.ui.input.dispatchEvent(new r.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  assert.equal(r.stored[SIZE], "12");
});

test("⌘= / ⌘- and the stepper agree: either one moves the other", t => {
  const r = rig(t, { [SIZE]: "15" }); // a stored start: these steps do not depend on the default
  r.keys.bigger(); r.keys.bigger();
  assert.equal(r.ui.input.value, "17", "⌘= updates the open control");
  r.ui.smaller.click();
  assert.equal(r.theme.terminalTypography().fontSize, 16, "the stepper is what ⌘= reads next");
  r.keys.bigger();
  assert.equal(r.ui.input.value, "17");
  r.keys.smaller();
  assert.equal(r.ui.input.value, "16");
  // The keys are the shell's registered actions (and the palette's commands).
  assert.match(shell, /id: "terminal\.fontBigger"[^\n]*run: \(\) => setTerminalFontSize\(terminalTypography\(\)\.fontSize \+ 1\)/);
  assert.match(shell, /id: "terminal\.fontSmaller"[^\n]*run: \(\) => setTerminalFontSize\(terminalTypography\(\)\.fontSize - 1\)/);
  r.section.dispose();
  r.keys.bigger();
  assert.equal(r.ui.input.value, "16", "a closed section no longer listens");
});

test("the section is labelled and keyboard-operable, built from the Settings components", t => {
  const r = rig(t);
  const el = r.section.element;
  assert.equal(el.getAttribute("aria-labelledby"), "settings-terminal-title");
  assert.equal(r.doc.getElementById("settings-terminal-title").textContent, "Terminal");
  assert.equal(r.ui.input.type, "number"); assert.deepEqual([r.ui.input.min, r.ui.input.max, r.ui.input.step], ["9", "28", "1"]);
  assert.equal(r.doc.querySelector(`label[for="${r.ui.input.id}"]`).textContent, "Font size", "the field's label");
  assert.match(r.doc.getElementById(r.ui.input.getAttribute("aria-describedby")).textContent, /every open terminal, from 9 to 28px\. ⌘= \/ ⌘- \/ ⌘0 change it too\./);
  assert.ok([r.ui.smaller, r.ui.bigger, r.ui.reset].every(b => b.type === "button" && b.tabIndex >= 0));
  assert.ok(el.querySelector(".forge-card") && el.querySelector(".forge-actions") && el.querySelector(".forge-hint"), "the dialog's own card, actions and hint");
  assert.match(read("settings-terminal.mjs"), /read: \(\) => terminalTypography\(\)\.fontSize, set: setTerminalFontSize, reset: resetTerminalFontSize,\s+subscribe: onTerminalTypographyChange,/,
    "the shipped default store is the composition the tests use");
});

test("Settings mounts Terminal after Connections, traps Tab through its field, and disposes it on close; it opens from the palette and its action", async t => {
  const dom = new JSDOM('<!doctype html><body><button id="opener">Settings</button></body>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  let size = 15, disposed = 0;
  const listeners = new Set();
  const store = { read: () => size, set: v => { size = v; for (const fn of listeners) fn({ fontSize: v }); }, reset: () => store.set(15),
    subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn); disposed++; }; } };
  const view = createConnections({ doc, desk: {}, terminalFactory: assert.fail,
    request: async () => ({ forgeApi: 1, status: "not-connected", host: "github.com", login: null, hostRef: "d".repeat(64), connectionRef: "f".repeat(64), hosts: [{ host: "github.com", hostRef: "d".repeat(64) }] }),
    sections: [() => createTerminalSettings({ doc, store })] });
  t.after(() => view.dispose());
  doc.getElementById("opener").focus();
  view.open(); await new Promise(resolve => setImmediate(resolve));
  const dialog = doc.querySelector('[role="dialog"]');
  assert.deepEqual([...dialog.querySelectorAll(":scope > h3, :scope > section > h3")].map(h => h.textContent), ["Connections", "GitHub", "Terminal"], "Terminal follows the Connections section (its GitHub card)");
  const controls = [...dialog.querySelectorAll("button,select,input")].filter(el => !el.hidden);
  const last = controls.at(-1);
  assert.equal(last.textContent, "Reset to default (15)");
  last.focus();
  last.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  assert.equal(doc.activeElement, controls[0], "Tab wraps inside the dialog");
  const field = dialog.querySelector('input[type="number"]');
  assert.ok(controls.includes(field), "the size field is part of the trap");
  view.close();
  assert.equal(disposed, 1, "closing Settings drops the section's subscription");
  assert.equal(doc.querySelector('[role="dialog"]'), null);
  const html = read("index.html");
  // The sidebar layout (2026-10-23): Connections lives in the palette (its Sections group since slice 4) and the
  // registry (app.connections), both opening this dialog. The sidebar has no button for it (slice 1: nor a settings cog).
  assert.doesNotMatch(html, /data-action="app\.connections"|id="sidebar-settings"/);
  assert.match(shell, /\{ label: "Connections", detail: "GitHub CLI accounts on this machine", run: \(\) => openConnections\(\) \}/);
  assert.match(shell, /registerAction\(\{ id: "app\.connections", label: "Settings: Connections…", context: "global", run: \(\) => openConnections\(\) \}\);/);
  assert.match(shell, /sections: \[\(\) => createTerminalSettings\(\{ doc: document, chords: \{/);
  assert.match(shell, /connectionsCSS \+ settingsTerminalCSS/);
});
