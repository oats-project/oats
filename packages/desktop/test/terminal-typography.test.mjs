// Native terminal geometry (060de502; the human's 2026-09-29 direction over
// the Redesign v3 "transcript rhythm"): xterm's default line height,
// horizontal-only 12px gutters. Spec F item 6 made the face the bundled
// Inconsolata, at 15px by the operator's decision (2026-10-02). Isolated renderer module + CSSOM;
// no browser layout, Electron, storage or live app.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { terminalOptions } from "../renderer/terminal-tab.mjs";
import { createHostTheme } from "../renderer/host-theme.mjs";
import { hostState, systemState } from "./helpers/host-theme-fixture.mjs";

const read = name => readFileSync(new URL(`../renderer/${name}`, import.meta.url), "utf8");
const themeSource = read("theme.mjs"), html = read("index.html");
const themeCSS = read("theme.css"), shellCSS = read("shell.css"), shellSource = read("shell.mjs");
// Font stacks compared as lists: jsdom drops the space after a comma in custom properties.
const stack = value => String(value).trim().replace(/\s*,\s*/g, ", ");

function fixture(t, { stored = {}, noStorage = false, palette, fonts } = {}) {
  const dom = new JSDOM(html);
  t.after(() => dom.window.close());
  const style = dom.window.document.createElement("style");
  style.textContent = `${themeCSS}\n${shellCSS}`; dom.window.document.head.append(style);
  if (palette) dom.window.document.documentElement.dataset.theme = palette;
  // jsdom has no FontFaceSet: a stub stands in for the bundled face's load state.
  if (fonts) Object.defineProperty(dom.window.document, "fonts", { value: fonts });
  const context = {
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
  };
  if (!noStorage) context.localStorage = { getItem: key => stored[key] ?? null, setItem: (key, value) => { stored[key] = String(value); }, removeItem: key => { delete stored[key]; } };
  const theme = runInNewContext(`${themeSource.replace(/\bexport /g, "")}\n({ terminalTypography, onTerminalTypographyChange, setTerminalFontFamily, setTerminalFontSize, resetTerminalTypography, BUNDLED_MONO, terminalDefaultSize,
    terminalFontWeight, TERMINAL_FONT_WEIGHT, xtermTheme, applyTheme, onThemeChange, initTheme, setTheme, refreshHostTheme, initFont, setFont })`, context);
  const rule = selector => {
    for (const sheet of dom.window.document.styleSheets) {
      for (const r of sheet.cssRules) if (r.selectorText === selector) return r.style;
    }
    return null;
  };
  return { theme, doc: dom.window.document, rule };
}

for (const palette of ["light", "solarized", "dark"]) {
  test(`fresh Desktop (${palette}): terminal typography is 15px Inconsolata, then the OS monospace stack, with no line height`, t => {
    const u = fixture(t, { palette });
    const type = u.theme.terminalTypography();
    assert.equal(type.fontSize, 15, "Inconsolata at 15px, the operator's default");
    assert.match(stack(type.fontFamily), /^"Inconsolata", ui-monospace,/, "the bundled face first, then the OS stack (--term-font-family)");
    assert.equal("lineHeight" in type, false, "typography carries no line height; xterm's default 1.0 applies");
    assert.deepEqual(Object.keys(type).sort(), ["fontFamily", "fontSize"]);
  });
}

test("theme.css seeds --term-font-size: 15px (the JS default agrees) and defines no --term-line-height token", t => {
  const u = fixture(t);
  const root = u.doc.defaultView.getComputedStyle(u.doc.documentElement);
  assert.equal(root.getPropertyValue("--term-font-size").trim(), "15px");
  assert.equal(u.theme.terminalDefaultSize(), 15, "the storage- and token-less fallback is the same size");
  assert.equal(root.getPropertyValue("--term-line-height").trim(), "", "no --term-line-height token");
  assert.doesNotMatch(themeCSS, /--term-line-height/, "the token must not come back under another rule");
});

test("a persisted user size is respected, not migrated (12 and 13 stay); reset forgets it and lands on 15", t => {
  const stored = { "oats.desktop.terminal.fontSize": "12", "oats.desktop.terminal.fontFamily": "Menlo" };
  const u = fixture(t, { stored });
  const type = u.theme.terminalTypography();
  assert.equal(type.fontSize, 12, "a size the user chose is kept");
  assert.equal(type.fontFamily, "Menlo");
  assert.equal("lineHeight" in type, false);
  assert.equal(fixture(t, { stored: { "oats.desktop.terminal.fontSize": "13" } }).theme.terminalTypography().fontSize, 13,
    "a stored 13 (the old default, kept by a size change) stays: the new default applies only where nothing is stored");
  const heard = [];
  u.theme.onTerminalTypographyChange(value => heard.push(value));
  u.theme.resetTerminalTypography();
  assert.deepEqual(Object.keys(stored), [], "reset stores nothing: later default changes reach the user");
  assert.equal(heard.length, 1, "live terminals hear the reset");
  assert.equal(heard[0].fontSize, 15);
  assert.match(stack(heard[0].fontFamily), /^"Inconsolata",/);
  const fresh = fixture(t, { noStorage: true }).theme.terminalTypography();
  assert.equal(fresh.fontSize, 15, "storage-less falls back to the 15px token");
  u.theme.setTerminalFontSize("nonsense");
  assert.equal(stored["oats.desktop.terminal.fontSize"], "15", "an unreadable size falls back to the default");
  for (const [value, expected] of [[0, "9"], [-3, "9"], [0.4, "9"], ["0", "9"], [99, "28"], [12.5, "13"], [null, "15"], ["  ", "15"], [undefined, "15"], [NaN, "15"]]) {
    u.theme.setTerminalFontSize(value);
    assert.equal(stored["oats.desktop.terminal.fontSize"], expected, `${String(value)}: numbers clamp to 9–28, only unreadable values give the default`);
  }
});

test("terminal gutters: .term-wrap .xterm has 12px horizontal padding only, and .term-wrap none", t => {
  const u = fixture(t);
  const xterm = u.rule(".term-wrap .xterm");
  assert.ok(xterm, ".term-wrap .xterm rule present");
  assert.equal(xterm.paddingLeft, "12px"); assert.equal(xterm.paddingRight, "12px");
  assert.equal(xterm.paddingTop, "0px", "no vertical inset: tmux owns row geometry");
  assert.equal(xterm.paddingBottom, "0px");
  assert.equal(xterm.width, "100%"); assert.equal(xterm.height, "100%");
  // FitAddon subtracts padding from .xterm itself; a gutter on .term-wrap
  // would allocate columns wider than the visible terminal.
  const wrap = u.rule(".term-wrap");
  assert.ok(wrap, ".term-wrap rule present");
  assert.equal(wrap.padding, "", "gutters live on .xterm, not .term-wrap");
});

// Spec F item 6: Inconsolata, bundled, is the default monospace face of the terminal and the UI.
test("theme.css bundles Inconsolata with @font-face and puts it first in --term-font-family and --mono", t => {
  const u = fixture(t);
  const root = u.doc.defaultView.getComputedStyle(u.doc.documentElement);
  const os = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
  assert.equal(stack(root.getPropertyValue("--term-font-family")), `"Inconsolata", ${os}`);
  assert.equal(stack(root.getPropertyValue("--mono")), `"Inconsolata", ${os}`, "terminal and UI agree");
  const face = themeCSS.match(/@font-face \{[^}]*\}/)?.[0];
  assert.ok(face, "an @font-face rule");
  assert.match(face, /font-family: "Inconsolata"; src: url\("fonts\/Inconsolata-VF\.ttf"\) format\("truetype"\);/);
  assert.match(face, /font-weight: 200 900;/); assert.match(face, /font-display: block;/, "text in the face waits for it instead of swapping in a fallback");
  const font = readFileSync(new URL("../renderer/fonts/Inconsolata-VF.ttf", import.meta.url));
  assert.equal(font.readUInt32BE(0), 0x00010000, "a TrueType file");
  assert.match(readFileSync(new URL("../renderer/fonts/OFL.txt", import.meta.url), "utf8"), /SIL Open Font License, Version 1\.1/);
  const notice = readFileSync(new URL("../renderer/fonts/README.md", import.meta.url), "utf8");
  assert.match(notice, /version 3\.001/); assert.match(notice, /github\.com\/google\/fonts/);
  const builder = readFileSync(new URL("../electron-builder.config.cjs", import.meta.url), "utf8");
  assert.match(builder, /"renderer\/\*\*\/\*"/, "the font ships with the renderer");
  assert.match(html, /default-src 'self'/, "the CSP admits a local font (no font-src restriction)");
  assert.doesNotMatch(html, /font-src/);
  assert.match(shellCSS, /\.ctx-repo-label \{[^}]*font-family: var\(--mono\);/, "the roster's paths use the shared token");
});

test("a stored terminal font wins; the bundled default applies only where nothing is stored", t => {
  assert.equal(fixture(t, { stored: { "oats.desktop.terminal.fontFamily": "JetBrains Mono" } }).theme.terminalTypography().fontFamily, "JetBrains Mono");
  assert.match(stack(fixture(t, { stored: {} }).theme.terminalTypography().fontFamily), /^"Inconsolata",/);
});

test("until Inconsolata has loaded, terminals get the rest of the stack, then the full family (xterm re-measures)", async t => {
  let loaded = false, loads = 0, settle;
  const fonts = {
    check: spec => { assert.equal(spec, '13px "Inconsolata"', "a probe size: availability does not depend on it"); return loaded; },
    load: () => { loads++; return new Promise(resolve => { settle = () => { loaded = true; resolve([{}]); }; }); },
  };
  const u = fixture(t, { fonts });
  const heard = [];
  u.theme.onTerminalTypographyChange(value => heard.push(value.fontFamily));
  const early = u.theme.terminalTypography();
  assert.equal(stack(early.fontFamily), "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", "never measured with fallback metrics under the bundled name");
  u.theme.terminalTypography();
  await Promise.resolve();
  assert.equal(loads, 1, "one load, however many terminals ask");
  settle(); await new Promise(setImmediate);
  assert.deepEqual(heard.map(stack), ['"Inconsolata", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'],
    "a real option change: live terminals switch and re-measure");
  assert.match(stack(u.theme.terminalTypography().fontFamily), /^"Inconsolata",/);
});

test("a face that fails to load still settles to the full family (the stack falls back as the browser would)", async t => {
  const fonts = { check: () => false, load: () => Promise.reject(new Error("no font")) };
  const u = fixture(t, { fonts });
  const heard = [];
  u.theme.onTerminalTypographyChange(value => heard.push(value.fontFamily));
  assert.doesNotMatch(u.theme.terminalTypography().fontFamily, /Inconsolata/);
  await new Promise(setImmediate);
  assert.equal(heard.length, 1);
  assert.match(stack(u.theme.terminalTypography().fontFamily), /^"Inconsolata",/);
});

test("the shell's reset (⌘0 and the palette) forgets the stored typography instead of pinning a size", () => {
  const shell = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
  assert.equal(shell.match(/Terminal: reset typography"[^\n]*run: \(\) => resetTerminalTypography\(\) \}/g)?.length, 2, "the action and the palette command");
  assert.doesNotMatch(shell, /setTerminalFontSize\(1[34]\)/, "no hard-coded default size in the shell");
});

// Text weight follows the theme, not typography: Chromium draws dark-on-light
// text lighter than light-on-dark, so each palette carries the weight that
// matches a native macOS terminal with font smoothing (Ghostty font-thicken,
// measured at Inconsolata 15). Weight is not cell geometry; bold stays 700.
const WEIGHTS = { light: 475, solarized: 450, dark: 400 };

for (const [palette, weight] of Object.entries(WEIGHTS)) {
  test(`${palette}: --term-font-weight resolves to ${weight} and terminalFontWeight() returns it`, t => {
    const u = fixture(t, { palette });
    const root = u.doc.defaultView.getComputedStyle(u.doc.documentElement);
    assert.equal(root.getPropertyValue("--term-font-weight").trim(), String(weight));
    assert.equal(u.theme.terminalFontWeight(), weight);
    assert.deepEqual(Object.keys(u.theme.terminalTypography()).sort(), ["fontFamily", "fontSize"], "weight is not a typography preference");
  });
}

test("a missing or unusable --term-font-weight falls back to 400 (xterm's normal)", t => {
  const u = fixture(t, { palette: "light" });
  assert.equal(u.theme.TERMINAL_FONT_WEIGHT, 400);
  const el = u.doc.documentElement;
  for (const value of ["bold", "475px", "0", "1001", "-5", "NaN", "Infinity"]) {
    el.style.setProperty("--term-font-weight", value);
    assert.equal(u.theme.terminalFontWeight(), 400, `${value} is not a usable weight`);
  }
  el.style.setProperty("--term-font-weight", "1000");
  assert.equal(u.theme.terminalFontWeight(), 1000, "the CSS range's edge is usable");
  el.style.removeProperty("--term-font-weight");
  assert.equal(u.theme.terminalFontWeight(), 475, "the palette's token applies again");
  // No stylesheet at all: no token.
  const bare = new JSDOM("<!doctype html><html></html>"); t.after(() => bare.window.close());
  assert.equal(u.theme.terminalFontWeight(bare.window.document.documentElement), 400);
});

// Both creation sites in shell.mjs, executed from the shipped source against the
// real theme module: the terminal tab and the Settings preview terminal.
function slice(from, to) {
  const start = shellSource.indexOf(from);
  assert.ok(start >= 0, `shell.mjs has ${from}`);
  const end = shellSource.indexOf(to, start);
  assert.ok(end > start, `shell.mjs has ${JSON.stringify(to)} after ${from}`);
  return shellSource.slice(start, end + to.length);
}
function sites(theme) {
  const made = [];
  const Terminal = class {
    constructor(options) { this.created = { ...options }; this.options = { ...options }; made.push(this); }
    loadAddon() {} open() {} dispose() {} onData() {} attachCustomKeyEventHandler() {}
  };
  const context = { ...theme, terminalOptions, Terminal, FitAddon: { FitAddon: class { fit() {} } },
    onTerminalTypographyChange: () => () => {}, wireTerminalSelection: () => () => {}, wrap: {},
    navigator: { clipboard: { writeText() {} } }, ResizeObserver: class { observe() {} disconnect() {} } };
  // The tab: from its typography read to its theme listener (openTerminalTabInner).
  const tab = runInNewContext(`(() => {\n${slice("  const type = terminalTypography();\n  const term = new Terminal(terminalOptions({", "\n  const offTheme = onThemeChange(")}${slice("() => { term.options.theme = xtermTheme();", "});\n")}\nreturn offTheme;\n})()`, context);
  const preview = runInNewContext(`({ ${slice("terminalFactory: mount => {", "\n  },\n")} })`, context).terminalFactory({});
  assert.equal(made.length, 2, "one terminal per site");
  return { terms: [["terminal tab", made[0]], ["Settings preview", made[1]]], dispose: () => { tab(); preview.dispose(); } };
}

for (const [palette, weight] of Object.entries(WEIGHTS)) {
  test(`${palette}: both shell terminals are created at weight ${weight}, bold left to xterm, and follow every theme change`, t => {
    const u = fixture(t, { palette });
    const { terms, dispose } = sites(u.theme);
    t.after(dispose);
    for (const [site, term] of terms) {
      assert.equal(term.created.fontWeight, weight, `${site}: created at the theme's weight`);
      assert.ok(!("fontWeightBold" in term.created) || term.created.fontWeightBold === "bold", `${site}: bold stays xterm's (700)`);
    }
    for (const next of ["light", "solarized", "dark", palette]) {
      u.theme.applyTheme(next);
      for (const [site, term] of terms) {
        assert.equal(term.options.fontWeight, WEIGHTS[next], `${site}: a theme change to ${next} updates the live terminal's weight`);
        assert.equal(term.options.theme.background, u.theme.xtermTheme().background, `${site}: colours follow too`);
      }
    }
  });
}

// The readability floor (#602): xterm's minimumContrastRatio comes from
// terminalOptions(), so both sites get it, and neither theme listener replaces it.
for (const palette of Object.keys(WEIGHTS)) {
  test(`${palette}: both shell terminals are created with a minimum contrast ratio of 4.5 and keep it through every theme change`, t => {
    const u = fixture(t, { palette });
    const { terms, dispose } = sites(u.theme);
    t.after(dispose);
    for (const [site, term] of terms) assert.equal(term.created.minimumContrastRatio, 4.5, `${site}: created with the floor`);
    for (const next of ["light", "solarized", "dark", palette]) {
      u.theme.applyTheme(next);
      for (const [site, term] of terms) {
        assert.equal(term.options.minimumContrastRatio, 4.5, `${site}: the floor is still set after a theme change to ${next}`);
        assert.equal(term.options.fontWeight, WEIGHTS[next], `${site}: and the theme listener ran`);
      }
    }
  });
}

// "This computer" (#602): a host theme pushed by main reaches both terminals through the same
// onThemeChange path as any theme change. The colours are the host's (the selection moved until it is
// visible, theme-contrast.test.mjs); the weight is the base
// theme's (Dark's 400 for a dark host palette, White's 475 for a light one).
test("This computer: a pushed host theme updates both shell terminals' colours and weight (dark 400, light 475), and the floor stays", t => {
  const u = fixture(t);
  const pushes = new Set();
  const desk = { hostTheme: () => new Promise(() => {}), onHostThemeChanged: fn => { pushes.add(fn); return () => pushes.delete(fn); } };
  const host = createHostTheme({ desk, onChange: () => u.theme.refreshHostTheme() });
  t.after(() => host.dispose());
  u.theme.initTheme(host); host.start();
  const { terms, dispose } = sites(u.theme);
  t.after(dispose);
  assert.equal(u.theme.setTheme("host"), "host");
  const push = state => { for (const fn of [...pushes]) fn(state); };
  for (const [name, weight] of [["tokyo-night", 400], ["rose-pine", 475], ["tokyo-night", 400]]) {
    const state = hostState(name);
    push(state);
    assert.equal(u.doc.documentElement.dataset.theme, state.mode, `${name}: the base follows the host's polarity`);
    for (const [site, term] of terms) {
      assert.equal(term.options.fontWeight, weight, `${site}: ${name} is drawn at the base theme's weight`);
      assert.equal(term.options.theme.background, state.colors.background, `${site}: the host's background`);
      // The selection is derived (#672): the host's colour moved until it holds 3:1 on the terminal.
      assert.equal(term.options.theme.selectionBackground, u.theme.xtermTheme().selectionBackground, `${site}: the derived selection`);
      assert.notEqual(term.options.theme.selectionBackground, state.colors.selection, `${site}: ${name}'s 1.3:1 selection was moved`);
      assert.deepEqual([term.options.theme.black, term.options.theme.red, term.options.theme.brightBlack, term.options.theme.brightWhite],
        [state.colors.ansi[0], state.colors.ansi[1], state.colors.ansi[8], state.colors.ansi[15]], `${site}: the host's own terminal colours`);
      assert.equal(term.options.theme.foreground, u.theme.xtermTheme().foreground);
      assert.equal(term.options.minimumContrastRatio, 4.5, `${site}: the floor that keeps unadjusted colours readable is still set`);
    }
  }
  // A computer with no Omarchy theme: the built-in theme of the system's appearance, as it is.
  push(systemState("light"));
  for (const [site, term] of terms) {
    assert.equal(term.options.fontWeight, 475, site);
    assert.equal(term.options.theme.background, "#ffffff", `${site}: White's own terminal background`);
  }
  // Another choice: a later push changes nothing in this window's terminals.
  u.theme.setTheme("dark");
  push(hostState("rose-pine"));
  for (const [site, term] of terms) {
    assert.equal(term.options.fontWeight, 400, site);
    assert.equal(term.options.theme.background, "#1a1b26", `${site}: Dark's own terminal background (slice 3d: the app's --bg)`);
  }
});

// The GitHub sign-in terminal (Settings: Connections…, connections.mjs) is the second creation site. A size or family
// change keeps its mount's box, so its ResizeObserver need not fire: the shipped adapter tells its resize listeners
// itself, and Connections' listener refits the grid and sends it to the sign-in PTY (forgeAuthResize).
test("the sign-in terminal: a font or size change reaches its resize listeners (the refit and the PTY's new grid), never a disposed one", t => {
  const u = fixture(t);
  let typography = null, fits = 0;
  const Terminal = class {
    constructor(options) { this.options = { ...options }; }
    loadAddon() {} open() {} dispose() {} onData() {} attachCustomKeyEventHandler() {}
  };
  const context = { ...u.theme, terminalOptions, Terminal, FitAddon: { FitAddon: class { fit() { fits++; } } },
    onTerminalTypographyChange: fn => { typography = fn; return () => { typography = null; }; },
    ResizeObserver: class { observe() {} disconnect() {} } };
  const adapter = runInNewContext(`({ ${slice("terminalFactory: mount => {", "\n  },\n")} })`, context).terminalFactory({});
  // Connections' own listener (connections.mjs resize): fit, then the grid to the PTY.
  const sent = [];
  const sub = adapter.onResize(() => { adapter.fit(); sent.push([adapter.cols, adapter.rows]); });
  typography({ fontSize: 15, fontFamily: "ui-monospace, monospace" });
  assert.equal(fits, 1, "a family change refits");
  assert.equal(sent.length, 1, "and the grid goes to the PTY");
  typography({ fontSize: 16, fontFamily: "ui-monospace, monospace" });
  assert.equal(fits, 2, "a size change too");
  sub.dispose();
  typography({ fontSize: 17, fontFamily: "ui-monospace, monospace" });
  assert.equal(fits, 2, "a disposed listener is not told");
  adapter.dispose();
  assert.equal(typography, null, "disposing the terminal stops listening");
});

// #1571: a font change gives the open sign-in terminal the new face's size (Omarchy's 13, Inconsolata's stored 15) too.
test("the sign-in terminal takes the new face's size in place when the font changes, and refits", t => {
  const u = fixture(t, { stored: { "oats.desktop.terminal.fontSize": "15" } });
  u.theme.initFont(false, () => true, { isOmarchy: true });
  let term = null, fits = 0;
  const Terminal = class {
    constructor(options) { this.options = { ...options }; term = this; }
    loadAddon() {} open() {} dispose() {} onData() {} attachCustomKeyEventHandler() {}
  };
  const context = { ...u.theme, terminalOptions, Terminal, FitAddon: { FitAddon: class { fit() { fits++; } } },
    ResizeObserver: class { observe() {} disconnect() {} } };
  const adapter = runInNewContext(`({ ${slice("terminalFactory: mount => {", "\n  },\n")} })`, context).terminalFactory({});
  adapter.onResize(() => adapter.fit());
  assert.equal(term.options.fontSize, 13, "created in Omarchy's font at its default");
  u.theme.setFont("system");
  assert.equal(term.options.fontSize, 15, "the stored Inconsolata size, in place"); assert.match(stack(term.options.fontFamily), /^"Inconsolata",/);
  assert.equal(fits, 1, "and refits");
  u.theme.setFont("omarchy");
  assert.equal(term.options.fontSize, 13); assert.equal(fits, 2);
  adapter.dispose();
});
