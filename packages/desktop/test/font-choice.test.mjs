// The font choice (renderer/theme.mjs: FONTS, fontStacks, initFont, setFont; the product owner's call,
// 2026-10-23): Omarchy's font (fontconfig's monospace on Linux and Windows, UI and terminals; JetBrains Mono
// for the UI only on macOS), the default on an Omarchy computer, or System font (the UI's own stacks and
// Inconsolata terminals, exactly as before), the default elsewhere (2026-10-26). The stacks per platform and choice, what is stored, what open terminals do, and
// that every UI font rule follows the choice. theme.mjs evaluated on its own with the shipped CSS (jsdom
// CSSOM); no browser layout, Electron or live app.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { fitTerminal } from "../renderer/terminal-tab.mjs";

const read = name => readFileSync(new URL(`../renderer/${name}`, import.meta.url), "utf8");
const themeSource = read("theme.mjs"), themeCSS = read("theme.css"), shellCSS = read("shell.css"), shellSource = read("shell.mjs");
// Font stacks compared as lists: jsdom drops the space after a comma in custom properties.
const stack = value => String(value).trim().replace(/\s*,\s*/g, ", ");
const OS_MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
const INCONSOLATA = `"Inconsolata", ${OS_MONO}`;
const MAC_UI = '"JetBrainsMono Nerd Font", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

function runtime(t, { stored = {}, storage = true } = {}) {
  const dom = new JSDOM("<!doctype html><html data-theme=\"dark\"><head></head><body></body></html>");
  t.after(() => dom.window.close());
  // jsdom has no canvas: nothing to measure with, so fontDraws takes a stack as it is (the tests below stub one).
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  const style = dom.window.document.createElement("style");
  style.textContent = `${themeCSS}\n${shellCSS}`; dom.window.document.head.append(style);
  const writes = [];
  const context = { document: dom.window.document, getComputedStyle: dom.window.getComputedStyle.bind(dom.window) };
  if (storage) context.localStorage = {
    getItem: key => stored[key] ?? null, setItem: (key, value) => { writes.push([key, value]); stored[key] = String(value); },
    removeItem: key => { delete stored[key]; },
  };
  const theme = runInNewContext(`${themeSource.replace(/\bexport /g, "")}\n({ FONTS, defaultFont, terminalDefaultSize, terminalFace, fontStacks, fontChoices, initFont, setFont, currentFont, onFontChange,
    fontDraws, fontFallsBack, FONT_FALLBACK_NOTE,
    terminalTypography, onTerminalTypographyChange, setTerminalFontSize, setTerminalFontFamily, resetTerminalTypography, resetTerminalFontSize })`, context);
  const root = dom.window.document.documentElement;
  const token = name => dom.window.getComputedStyle(root).getPropertyValue(name);
  return { theme, dom, root, token, stored, writes, context };
}
/** initFont's options on a computer that runs Omarchy (preload's oatsDesktop.isOmarchy). */
const OMARCHY = Object.freeze({ isOmarchy: true });
/** The font stacks set inline on the root (the size token is not a font stack). */
const inlineStacks = u => ["--ui-font", "--mono", "--term-font-family"].filter(name => u.root.style.getPropertyValue(name) !== "");

test("the two fonts; the monospace (once Omarchy's font) is the default on an Omarchy computer and System elsewhere (2026-10-26)", t => {
  const { theme } = runtime(t);
  // JSON: the runtime is another realm (runInNewContext), whose arrays deepEqual does not take as ours.
  // The Appearance sheet's words (the Desktop UI rework, slice 4); the ids stay.
  assert.deepEqual(JSON.parse(JSON.stringify(theme.FONTS)), [{ id: "omarchy", label: "This computer's monospace" }, { id: "system", label: "System" }]);
  assert.ok(Object.isFrozen(theme.FONTS) && theme.FONTS.every(Object.isFrozen));
  assert.equal(theme.defaultFont(true), "omarchy"); assert.equal(theme.defaultFont(false), "system");
  assert.equal(theme.defaultFont(), "system", "before initFont is told otherwise: not Omarchy");
  // The terminal's default size is the face's, not the host's (#1571): Omarchy's font at 13px, Inconsolata at 15px.
  assert.equal(theme.terminalDefaultSize("omarchy"), 13); assert.equal(theme.terminalDefaultSize("bundled"), 15);
  assert.equal(theme.terminalFace(), "bundled"); assert.equal(theme.terminalDefaultSize(), 15, "before initFont: Inconsolata's");
  assert.equal(theme.terminalDefaultSize(true), 15, "a host boolean is no face: Inconsolata's");
});

test("off Omarchy: initFont is System font and the terminal's 15px, with nothing inline and nothing stored; only `true` is Omarchy", t => {
  for (const options of [undefined, {}, { isOmarchy: false }, { isOmarchy: "true" }, { isOmarchy: 1 }]) {
    for (const isMac of [false, true]) {
      const u = runtime(t);
      assert.equal(u.theme.initFont(isMac, undefined, options), "system", JSON.stringify(options));
      assert.equal(u.root.getAttribute("style"), null, "nothing inline"); assert.deepEqual(u.writes, []);
      assert.equal(u.theme.terminalTypography().fontSize, 15); assert.equal(u.theme.defaultFont(), "system");
    }
  }
});

// D2 (the Desktop UI rework, 2026-11-19): the chrome is the system sans; the choice is the terminals' face only.
test("the stacks per platform and per choice: fontconfig's monospace on Linux/Windows for the terminals only, nothing on macOS, none for System", t => {
  const { theme } = runtime(t);
  assert.deepEqual({ ...theme.fontStacks("omarchy", false) }, { "--term-font-family": "ui-monospace, monospace" });
  assert.deepEqual({ ...theme.fontStacks("omarchy", true) }, {}, "macOS: the terminals keep Inconsolata, and the chrome is the system's");
  for (const isMac of [false, true]) {
    assert.deepEqual({ ...theme.fontStacks("system", isMac) }, {}, `System font sets nothing, mac=${isMac}`);
    assert.deepEqual({ ...theme.fontStacks("nonsense", isMac) }, {});
    // Never the bare generic: alone, `monospace` changes the default font size.
    for (const [, value] of Object.entries(theme.fontStacks("omarchy", isMac))) {
      assert.notEqual(value.trim(), "monospace"); assert.match(value, /, monospace$/, "the generic last, so fontconfig's alias answers");
    }
  }
  assert.doesNotMatch(themeSource, /\.(ttf|otf|woff2?)\b/, "no font file is bundled for it");
});

test("Omarchy: initFont applies the monospace to the terminals at 13px (not the UI: D2), stores nothing, and marks the root", t => {
  const u = runtime(t);
  assert.equal(u.theme.initFont(false, undefined, OMARCHY), "omarchy");
  assert.deepEqual(u.writes, [], "the default stays a default");
  assert.equal(u.root.dataset.font, "omarchy");
  assert.equal(stack(u.token("--term-font-family")), "ui-monospace, monospace");
  assert.equal(u.token("--ui-font").trim(), "", "the chrome keeps its system sans");
  assert.equal(stack(u.token("--mono")), INCONSOLATA, "the UI's code face is theme.css's");
  assert.equal(stack(u.theme.terminalTypography().fontFamily), "ui-monospace, monospace", "new terminals start in it");
  assert.equal(u.theme.terminalFace(), "omarchy");
  assert.equal(u.root.style.getPropertyValue("--term-font-size"), "13px", "the size token follows the face's default");
  assert.equal(u.theme.terminalTypography().fontSize, 13, "Omarchy's terminal default");
  // A stored size wins; a reset lands on Omarchy's default again.
  u.theme.setTerminalFontSize(17); assert.equal(u.theme.terminalTypography().fontSize, 17);
  u.theme.resetTerminalTypography(); assert.equal(u.theme.terminalTypography().fontSize, 13);
  // A stored System font beats the Omarchy default, and its terminals are Inconsolata at Inconsolata's 15px: the size
  // follows the face, not the host (#1571; 13px Inconsolata on an Omarchy computer was undersized).
  const chosen = runtime(t, { stored: { "oats.desktop.font": "system" } });
  assert.equal(chosen.theme.initFont(false, undefined, OMARCHY), "system"); assert.deepEqual(inlineStacks(chosen), []);
  assert.equal(chosen.theme.terminalFace(), "bundled"); assert.equal(chosen.root.getAttribute("style"), null, "nothing inline, the size token neither");
  assert.equal(chosen.theme.terminalTypography().fontSize, 15);
});

// #1571: the product owner's Desktop had 15 stored, chosen when the terminals were Inconsolata; JetBrains Mono's
// advance is 0.6em against Inconsolata's 0.5em, so at 15px Omarchy's font was a fifth larger. A size belongs to its face.
const SIZE = "oats.desktop.terminal.fontSize", OMARCHY_SIZE = "oats.desktop.terminal.fontSize.omarchy";

test("a stored Inconsolata 15 does not carry over to Omarchy's font: 13px there, 15px again with System font", t => {
  const u = runtime(t, { stored: { [SIZE]: "15" } });
  u.theme.initFont(false, () => true, OMARCHY);
  assert.equal(u.theme.terminalTypography().fontSize, 13, "Omarchy's face, nothing stored for it: its default");
  u.theme.setFont("system");
  assert.equal(u.theme.terminalFace(), "bundled"); assert.equal(u.theme.terminalTypography().fontSize, 15, "the stored Inconsolata size");
  assert.deepEqual(u.writes, [["oats.desktop.font", "system"]], "no migration: nothing written but the choice");
  assert.equal(u.stored[SIZE], "15", "and nothing deleted");
});

test("a size set under one face leaves the other's untouched, by every control; each reset forgets the face in effect only", t => {
  const u = runtime(t);
  u.theme.initFont(false, () => true, OMARCHY);
  u.theme.setTerminalFontSize(u.theme.terminalTypography().fontSize - 1); // ⌘- (shell.mjs, verbatim)
  assert.deepEqual([u.stored[OMARCHY_SIZE], u.stored[SIZE]], ["12", undefined]);
  u.theme.setFont("system");
  assert.equal(u.theme.terminalTypography().fontSize, 15, "System font: Inconsolata's default, not Omarchy's 12");
  u.theme.setTerminalFontSize(u.theme.terminalTypography().fontSize + 2); // ⌘= twice
  assert.deepEqual([u.stored[OMARCHY_SIZE], u.stored[SIZE]], ["12", "17"]);
  u.theme.setFont("omarchy");
  assert.equal(u.theme.terminalTypography().fontSize, 12, "Omarchy's own size comes back");
  u.theme.resetTerminalFontSize(); // Settings → Terminal's "Reset to default"
  assert.deepEqual([u.stored[OMARCHY_SIZE], u.stored[SIZE]], [undefined, "17"]); assert.equal(u.theme.terminalTypography().fontSize, 13);
  u.theme.setTerminalFontSize(20); u.theme.setTerminalFontFamily("Iosevka");
  u.theme.resetTerminalTypography(); // ⌘0, "Terminal: reset typography"
  assert.deepEqual([u.stored[OMARCHY_SIZE], u.stored[SIZE], u.stored["oats.desktop.terminal.fontFamily"]], [undefined, "17", undefined],
    "the face's size and the family; Inconsolata's size stays");
  u.theme.setFont("system");
  u.theme.resetTerminalTypography();
  assert.deepEqual([u.stored[OMARCHY_SIZE], u.stored[SIZE]], [undefined, undefined]); assert.equal(u.theme.terminalTypography().fontSize, 15);
  // An unreadable size is the face's default, under the face's key.
  u.theme.setFont("omarchy"); u.theme.setTerminalFontSize("nonsense");
  assert.deepEqual([u.stored[OMARCHY_SIZE], u.stored[SIZE]], ["13", undefined]);
});

test("the face: Omarchy's only where its stacks set the terminals' family; macOS, the fallback and a stored family keep the face of the choice", t => {
  // Omarchy's font chosen off Omarchy (Linux): its face, and its default, wherever it is chosen.
  const linux = runtime(t, { stored: { "oats.desktop.font": "omarchy", [SIZE]: "15" } });
  linux.theme.initFont(false, () => true);
  assert.deepEqual([linux.theme.terminalFace(), linux.theme.terminalTypography().fontSize], ["omarchy", 13]);
  // macOS: the terminals keep Inconsolata, so its size and default.
  const mac = runtime(t, { stored: { "oats.desktop.font": "omarchy", [SIZE]: "16", [OMARCHY_SIZE]: "11" } });
  mac.theme.initFont(true, () => true);
  assert.deepEqual([mac.theme.terminalFace(), mac.theme.terminalTypography().fontSize], ["bundled", 16]);
  assert.equal(mac.root.style.getPropertyValue("--term-font-size"), "", "theme.css's 15px token stands");
  // The fallback: System font's faces, so Inconsolata's size, until the check passes on a later choice.
  let draws = false;
  const fallback = runtime(t, { stored: { [SIZE]: "16", [OMARCHY_SIZE]: "11" } });
  fallback.theme.initFont(false, () => draws, OMARCHY);
  assert.deepEqual([fallback.theme.terminalFace(), fallback.theme.terminalTypography().fontSize], ["bundled", 16]);
  fallback.theme.setTerminalFontSize(18);
  assert.deepEqual([fallback.stored[SIZE], fallback.stored[OMARCHY_SIZE]], ["18", "11"], "stored as Inconsolata's");
  draws = true; fallback.theme.setFont("omarchy");
  assert.deepEqual([fallback.theme.terminalFace(), fallback.theme.terminalTypography().fontSize], ["omarchy", 11]);
  assert.equal(fallback.root.style.getPropertyValue("--term-font-size"), "13px");
  // A family set with "Terminal: set font family…" wins for the family; the size stays the choice's face's.
  fallback.theme.setTerminalFontFamily("Iosevka");
  assert.deepEqual([fallback.theme.terminalFace(), fallback.theme.terminalTypography().fontSize], ["omarchy", 11]);
  fallback.theme.setFont("system");
  assert.deepEqual({ ...fallback.theme.terminalTypography() }, { fontFamily: "Iosevka", fontSize: 18 });
  assert.equal(fallback.root.style.getPropertyValue("--term-font-size"), "", "back to theme.css's token");
  // Storage-less: each face's default.
  const none = runtime(t, { storage: false });
  none.theme.initFont(false, () => true, OMARCHY);
  assert.equal(none.theme.terminalTypography().fontSize, 13);
  none.theme.setFont("system"); assert.equal(none.theme.terminalTypography().fontSize, 15);
  // A stored garbage value: that face's default.
  const junk = runtime(t, { stored: { [OMARCHY_SIZE]: "big", [SIZE]: "" } });
  junk.theme.initFont(false, () => true, OMARCHY);
  assert.equal(junk.theme.terminalTypography().fontSize, 13); junk.theme.setFont("system"); assert.equal(junk.theme.terminalTypography().fontSize, 15);
});

// The product owner, 2026-10-26, on Omarchy's font: "can we make the instance name font on the sidebar and on the
// tabs a bit smaller?" That was for a monospace chrome; since D2 the chrome is always the system sans, so the names
// are the rules' own 12.5px in every choice (the rules still read --name-size, which nothing sets).
test("an instance's name on its row and its tab: 12.5px in every font choice (D2)", t => {
  const sizes = u => {
    const row = u.dom.window.document.createElement("span"); row.className = "ctx-name";
    const tab = u.dom.window.document.createElement("div"); tab.className = "tab";
    u.dom.window.document.body.append(row, tab);
    // jsdom leaves var() in a computed font-size unresolved: resolve it against the root's token, as Chromium does.
    return [row, tab].map(el => {
      const declared = u.dom.window.getComputedStyle(el).fontSize, ref = declared.match(/^var\((--[\w-]+), ([^)]+)\)$/);
      return ref ? (u.token(ref[1]).trim() || ref[2]) : declared;
    });
  };
  for (const isMac of [false, true]) {
    const omarchy = runtime(t, { stored: { "oats.desktop.font": "omarchy" } });
    omarchy.theme.initFont(isMac, () => true);
    assert.deepEqual(sizes(omarchy), ["12.5px", "12.5px"], `the monospace, mac=${isMac}: the chrome is not monospace`);
    omarchy.theme.setFont("system");
    assert.deepEqual(sizes(omarchy), ["12.5px", "12.5px"], "System font: as before, in place");
    assert.equal(omarchy.root.style.getPropertyValue("--name-size"), "", "nothing left inline");
    const fallback = runtime(t, { stored: { "oats.desktop.font": "omarchy" } });
    fallback.theme.initFont(isMac, () => false);
    assert.deepEqual(sizes(fallback), ["12.5px", "12.5px"], "the fallback shows System font's faces, at their size");
  }
  // The rules read the token as a longhand beside their other properties (never a font shorthand).
  for (const selector of [".ctx-name", ".tab"]) {
    assert.match(shellCSS, new RegExp(`(^|\\n)\\${selector} \\{[^}]*font-size: var\\(--name-size, 12\\.5px\\);`), selector);
  }
});

test("macOS: the monospace, when stored from before, sets nothing: the chrome is the system's and the terminals keep Inconsolata (D2)", t => {
  const u = runtime(t, { stored: { "oats.desktop.font": "omarchy" } });
  assert.equal(u.theme.initFont(true), "omarchy", "a stored choice beats the default");
  assert.equal(u.token("--ui-font").trim(), ""); assert.equal(stack(u.token("--mono")), INCONSOLATA);
  assert.equal(stack(u.token("--term-font-family")), INCONSOLATA);
  assert.match(stack(u.theme.terminalTypography().fontFamily), /^"Inconsolata",/);
});

test("System font is exactly the faces before: no --ui-font, theme.css's --mono and Inconsolata terminals", t => {
  for (const isMac of [false, true]) {
    const u = runtime(t, { stored: { "oats.desktop.font": "system" } });
    assert.equal(u.theme.initFont(isMac), "system");
    assert.equal(u.root.getAttribute("style"), null, `nothing inline, mac=${isMac}`);
    assert.equal(u.token("--ui-font").trim(), "", "unset: each rule's own stack applies");
    assert.equal(stack(u.token("--mono")), INCONSOLATA); assert.equal(stack(u.token("--term-font-family")), INCONSOLATA);
  }
  // Switching back removes exactly what Omarchy's font set, and nothing the host theme set.
  const u = runtime(t);
  u.theme.initFont(false);
  u.root.style.setProperty("--accent", "#123456");
  u.theme.setFont("system");
  assert.equal(u.token("--ui-font").trim(), ""); assert.equal(stack(u.token("--term-font-family")), INCONSOLATA);
  assert.equal(u.root.style.getPropertyValue("--accent"), "#123456", "another source's inline token stays");
  u.theme.setFont("omarchy");
  assert.equal(stack(u.token("--term-font-family")), "ui-monospace, monospace");
});

test("persistence: a choice is stored per computer and read back at the next start; an unknown one is the default; no storage still works", t => {
  const stored = {};
  const first = runtime(t, { stored });
  first.theme.initFont(false);
  const heard = []; first.theme.onFontChange(id => heard.push(id));
  assert.equal(first.theme.setFont("system"), "system");
  assert.deepEqual(first.writes, [["oats.desktop.font", "system"]]);
  assert.deepEqual(heard, ["system"], "listeners (the open picker's marks) hear it");
  // The next start (a reload, another window) reads it.
  const second = runtime(t, { stored });
  assert.equal(second.theme.initFont(false), "system"); assert.equal(second.theme.currentFont(), "system");
  second.theme.setFont("omarchy");
  assert.equal(runtime(t, { stored }).theme.initFont(true), "omarchy");
  assert.equal(runtime(t, { stored: { "oats.desktop.font": "comic" } }).theme.initFont(false), "system", "an unknown saved value is the default");
  assert.equal(runtime(t, { stored: { "oats.desktop.font": "comic" } }).theme.initFont(false, undefined, OMARCHY), "omarchy", "Omarchy's, on Omarchy");
  assert.equal(first.theme.setFont("comic"), "system", "an unknown choice is the default");
  const none = runtime(t, { storage: false });
  assert.equal(none.theme.initFont(false, undefined, OMARCHY), "omarchy");
  assert.equal(none.theme.setFont("system"), "system", "storage-less: the choice applies in memory");
  assert.equal(stack(none.token("--term-font-family")), INCONSOLATA);
  const throwing = runtime(t);
  throwing.context.localStorage.setItem = () => { throw new Error("storage full"); };
  throwing.theme.initFont(false);
  assert.equal(throwing.theme.setFont("system"), "system"); assert.equal(throwing.theme.currentFont(), "system");
});

// The fallback (2026-10-26): Omarchy's font is used only once this computer's monospace font draws at a fixed
// width. Measured in Chromium on Linux with a private fontconfig: no monospace font gives a proportional sans,
// a bitmap one is skipped for the next match, and the bitmap one alone draws nothing.
function canvasDoc(widths, { throws = false } = {}) {
  const fonts = [];
  return { fonts, createElement: tag => {
    assert.equal(tag, "canvas");
    return { getContext: kind => {
      assert.equal(kind, "2d");
      if (throws) throw new Error("no context");
      if (!widths) return null;
      return { set font(value) { fonts.push(value); }, measureText: text => ({ width: widths[text[0]] }) };
    } };
  } };
}

test("the fixed-width check's verdicts: a monospace face draws, a proportional face and nothing drawn do not", t => {
  const { theme } = runtime(t);
  const verdict = (widths, opts) => { const doc = canvasDoc(widths, opts); return [theme.fontDraws("ui-monospace, monospace", doc), doc.fonts]; };
  assert.deepEqual(verdict({ i: 78, M: 78 }), [true, ["13px ui-monospace, monospace"]], "monospace (JetBrains Mono): the stack, at 13px");
  assert.equal(verdict({ i: 78.00003, M: 78.4 })[0], true, "within 1%: fractional advances");
  // The bound is 1% of the wider, exactly: 0.79 of 79 is in, 0.80 is out, and 78 against 79.2 (1.5%) is out.
  assert.equal(verdict({ i: 79, M: 79.79 })[0], true, "just inside 1%");
  assert.equal(verdict({ i: 79, M: 79.81 })[0], false, "just outside 1%");
  assert.equal(verdict({ i: 79.81, M: 79 })[0], false, "just outside 1%, the i's the wider");
  assert.equal(verdict({ i: 78, M: 79.2 })[0], false, "1.5% apart");
  assert.equal(verdict({ i: 78, M: 0 })[0], false, "the M's drew nothing");
  assert.equal(verdict({ i: 0, M: 0.5 })[0], false, "the i's drew nothing");
  assert.equal(verdict({ i: 30, M: 110 })[0], false, "proportional (no monospace font: fontconfig's sans)");
  assert.equal(verdict({ i: 0, M: 0 })[0], false, "zero width (a bitmap font alone: nothing is drawn)");
  assert.equal(verdict(null)[0], true, "no canvas context: nothing to measure, the stack as it is");
  assert.equal(verdict({}, { throws: true })[0], true, "a failing canvas: the same");
});

test("the fallback: where the monospace font does not draw at a fixed width, the monospace shows System's faces and stays chosen", t => {
  {
    // macOS sets no stack for it (D2), so there is nothing to check and nothing to fall back from.
    const mac = runtime(t, { stored: { "oats.desktop.font": "omarchy" } }), checked = [];
    mac.theme.initFont(true, stack => { checked.push(stack); return false; });
    assert.deepEqual(checked, [], "macOS: nothing checked"); assert.equal(mac.theme.fontFallsBack(), false);
  }
  for (const isMac of [false]) {
    // Linux: the monospace is the default on Omarchy.
    const u = runtime(t), checked = [];
    assert.equal(u.theme.initFont(isMac, stack => { checked.push(stack); return false; }, { isOmarchy: !isMac }), "omarchy");
    assert.deepEqual(checked, [u.theme.fontStacks("omarchy", isMac)["--term-font-family"]], "the terminals' stack is checked");
    assert.equal(u.theme.currentFont(), "omarchy", "still the choice"); assert.deepEqual(u.writes, [], "and nothing stored");
    assert.equal(u.theme.fontFallsBack(), true);
    assert.equal(u.root.dataset.font, "omarchy"); assert.equal(u.root.dataset.fontFallback, "system");
    assert.deepEqual(inlineStacks(u), [], "no font stack inline: System font's faces");
    assert.equal(u.token("--ui-font").trim(), ""); assert.equal(stack(u.token("--term-font-family")), INCONSOLATA);
    // The check runs on each choice, whichever is chosen.
    u.theme.setFont("system");
    assert.equal(checked.length, 2); assert.equal(u.theme.fontFallsBack(), true, "known before Omarchy's font is chosen again");
    assert.equal(u.root.dataset.fontFallback, undefined, "System font chosen: no fallback shown");
    u.theme.setFont("omarchy");
    assert.equal(checked.length, 3); assert.deepEqual(u.writes.at(-1), ["oats.desktop.font", "omarchy"], "the choice is stored as made");
    assert.deepEqual(inlineStacks(u), []); assert.equal(u.root.dataset.fontFallback, "system");
  }
  // A monospace font that draws: the stacks, and no fallback.
  const ok = runtime(t);
  ok.theme.initFont(false, () => true, OMARCHY);
  assert.equal(ok.theme.fontFallsBack(), false); assert.equal(ok.root.dataset.fontFallback, undefined);
  assert.equal(stack(ok.token("--term-font-family")), "ui-monospace, monospace");
});

test("the Appearance sheet's monospace row says when it falls back; macOS offers System alone (D2)", t => {
  const { theme } = runtime(t);
  assert.equal(theme.FONT_FALLBACK_NOTE, "No monospace font on this computer: showing System");
  const rows = (isMac, fallback) => JSON.parse(JSON.stringify(theme.fontChoices(isMac, fallback)));
  const system = { id: "system", label: "System", note: "Inconsolata in the terminals" };
  assert.deepEqual(rows(false, false), [system, { id: "omarchy", label: "This computer's monospace", note: "Fontconfig's monospace in the terminals" }]);
  assert.deepEqual(rows(false, true), [system, { id: "omarchy", label: "This computer's monospace", note: "No monospace font on this computer: showing System" }]);
  assert.deepEqual(rows(true, false), [system]); assert.deepEqual(rows(true, true), [system]);
  assert.deepEqual(rows(false), rows(false, false), "no fallback unless said");
});

// The shell's terminal tab listener (shell.mjs openTerminalTabInner), run as shipped against the real runtime.
const tabListener = shellSource.match(/  const offTypography = onTerminalTypographyChange\(\(next\) => \{[^]*?\n  \}\);/)?.[0];
function openTerminal(u) {
  const fits = [];
  const term = { options: { ...u.theme.terminalTypography() }, cols: 80, rows: 24 };
  const fit = { fit: () => fits.push(term.options.fontFamily) };
  const off = runInNewContext(`${tabListener}\noffTypography`, {
    onTerminalTypographyChange: u.theme.onTerminalTypographyChange, term, fit, fitTerminal, requestAnimationFrame: fn => fn(),
  });
  return { term, fits, off };
}

// #1571 changed what a font change does to the size: it was kept (a size was one for both faces); now the open
// terminals take the new face's size in place, with the family, before the one refit.
test("open terminals switch family and size in place and refit (the grid and the PTY size follow); each face keeps its stored size, and a stored family is kept", t => {
  assert.ok(tabListener, "the terminal tab's typography listener is where this test reads it");
  assert.match(tabListener, /term\.options\.fontFamily = next\.fontFamily;\s+term\.options\.fontSize = next\.fontSize;[^]*fitTerminal\(term, fit\)/,
    "family and size first, then the refit");
  // Off Omarchy, with Omarchy's font chosen: its face, at its 13px.
  const u = runtime(t, { stored: { "oats.desktop.font": "omarchy" } });
  u.theme.initFont(false);
  const a = openTerminal(u), b = openTerminal(u);
  assert.equal(stack(a.term.options.fontFamily), "ui-monospace, monospace"); assert.equal(a.term.options.fontSize, 13);
  u.theme.setFont("system");
  for (const { term, fits } of [a, b]) {
    assert.match(stack(term.options.fontFamily), /^"Inconsolata",/, "the new family, in place");
    assert.equal(term.options.fontSize, 15, "and Inconsolata's size");
    assert.equal(fits.length, 1, "one refit, after the family and size changed");
    assert.match(stack(fits[0]), /^"Inconsolata",/);
  }
  u.theme.setFont("omarchy");
  assert.equal(stack(a.term.options.fontFamily), "ui-monospace, monospace"); assert.equal(a.term.options.fontSize, 13); assert.equal(a.fits.length, 2);
  // A size set in Omarchy's font is Omarchy's: System font shows Inconsolata's, and Omarchy's comes back with it.
  u.theme.setTerminalFontSize(19);
  u.theme.setFont("system");
  assert.equal(a.term.options.fontSize, 15, "Inconsolata's size, not the one chosen for Omarchy's font");
  // A family stored by the palette's "Terminal: set font family…" still wins over the font choice.
  u.theme.setTerminalFontFamily("Iosevka");
  u.theme.setFont("omarchy");
  assert.equal(a.term.options.fontFamily, "Iosevka"); assert.equal(a.term.options.fontSize, 19, "Omarchy's chosen size is back");
  u.theme.resetTerminalTypography();
  assert.equal(stack(a.term.options.fontFamily), "ui-monospace, monospace", "reset typography lands on the font choice's family");
  assert.equal(a.term.options.fontSize, 13, "and its face's default");
  a.off(); b.off();
  const fits = a.fits.length; u.theme.setFont("system"); assert.equal(a.fits.length, fits, "a closed terminal hears nothing");
});

test("the shell applies the font before its first await, with the platform; the Appearance sheet, palette and action are wired", () => {
  const firstAwait = shellSource.indexOf("await ");
  const init = shellSource.indexOf('initFont(navigator.platform.includes("Mac"), undefined, { isOmarchy: desk?.isOmarchy === true });');
  assert.ok(shellSource.indexOf("const desk = window.oatsDesktop;") < init, "preload's constant, read where the shell reads its bridge");
  assert.ok(init > 0 && init < firstAwait, "initFont runs before the window's first paint can wait on anything");
  assert.match(shellSource, /fonts: \(\) => fontChoices\(navigator\.platform\.includes\("Mac"\), fontFallsBack\(\)\), currentFont, chooseFont: \(id\) => \{ setTerminalFontFamily\(""\); setFont\(id\); \},/);
  assert.match(shellSource, /\{ label: "Font: choose…", detail: chordDetail\("app\.fontPicker"\), run: \(\) => runAction\("app\.fontPicker"\) \}/);
  assert.match(shellSource, /registerAction\(\{ id: "app\.fontPicker", label: "Appearance: font…", context: "global", run: \(e\) => \{ if \(!e\?\.repeat\) appearance\.toggle\(\{ focus: "font" \}\); \} \}\);/);
  assert.doesNotMatch(shellSource, /location\.reload|webContents\.reload/, "a font change never reloads the window");
});

// Every font rule of the UI reads the choice: a sans or a monospace stack appears only as var(--ui-font, …)'s
// fallback (or is a font token, --mono or the terminals'), so System font (no --ui-font) is each rule's own stack
// exactly as before, and Omarchy's font reaches code, ids, paths and tab numbers too.
test("every UI font rule follows the choice: no sans or monospace stack outside var(--ui-font, <its own stack>)", () => {
  const dir = new URL("../renderer/", import.meta.url);
  const files = ["shell.css", "theme.css", "loading.css", ...readdirSync(dir).filter(name => name.endsWith(".mjs")),
    ...readdirSync(new URL("views/", dir)).filter(name => name.endsWith(".mjs")).map(name => `views/${name}`)];
  let follows = 0;
  for (const name of files) {
    const text = read(name);
    const outside = text.replace(/var\(--ui-font,[^)]*\)/g, () => { follows++; return "var(--ui-font)"; });
    assert.doesNotMatch(outside, /-apple-system|BlinkMacSystemFont|system-ui|"Segoe UI"|sans-serif/, `${name}: a sans stack that does not follow the font`);
    assert.doesNotMatch(text, /var\(--sans\b/, `${name}: the old, never-defined --sans token`);
    // A font token (the choice's --ui-font, --mono) is a longhand, font-family: var(--ui-font, …), never inside a font
    // shorthand: jsdom drops a shorthand that holds var(), so a test would read the parent's size, weight and
    // line-height (Chromium resolves it). No shorthand holds a var() at all.
    assert.doesNotMatch(text, /(?<![-\w])font\s*:[^;{}]*var\(/, `${name}: a font shorthand with var(): use longhands`);
    // A font declaration (not a custom property's definition) names a monospace face only inside a font token.
    for (const [, value] of outside.matchAll(/(?<![-\w])font(?:-family)?\s*:\s*([^;{}]*)/g)) {
      const bare = value.replace(/var\(--(?:ui-font|mono|term-font-family)\b[^)]*\)/g, "");
      assert.doesNotMatch(bare, /monospace|Menlo|"SF Mono"|SFMono|Consolas|Monaco/, `${name}: a monospace stack that does not follow the font: ${value.trim()}`);
    }
  }
  assert.ok(follows >= 20, `the UI's font rules read --ui-font (${follows})`);
  assert.match(shellCSS, /^body \{[^}]*font-weight: normal; font-size: 13px; line-height: 1\.45; font-family: var\(--ui-font, -apple-system, "Segoe UI", system-ui, sans-serif\);/m, "the body: today's stack as the fallback");
  assert.match(themeCSS, /\.oats-view \{[^}]*font-weight: normal; font-size: 13px; line-height: 1\.45; font-family: var\(--ui-font, -apple-system, "Segoe UI", system-ui, sans-serif\);/);
  assert.doesNotMatch(themeCSS, /--ui-font\s*:/, "--ui-font is set by the choice alone, never by theme.css");
});
