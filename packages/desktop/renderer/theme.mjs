/* oats desktop — theme runtime.
   theme.css defines the semantic tokens (incl. the --ansi-* terminal set);
   this module owns switching (a saved choice, else the default the shell
   passes: "This computer" on Linux, White elsewhere; choices persisted under
   the SAME legacy key as the web panel) and derives the xterm.js theme object
   from the live tokens.

   "This computer" (`host`) is a choice, not a palette: what it shows is a
   built-in theme as base (Dark or White, on data-theme, so theme.css applies
   as it does for that theme) plus token overrides set inline on the root. The
   host source (host-theme.mjs) says which; the shell hands it to initTheme(),
   because this module imports nothing (tests evaluate its source on its own). */

const KEY = "oatsweb.theme"; // legacy key name kept so existing user prefs survive
const HOST = "host";
/* The labels are the Appearance sheet's (the Desktop UI rework, slice 4): Light, Solarized, Dark and System. "System"
   is the choice that was called "This computer", with its behaviour, which is what Joan decided for System
   (2026-11-19): the Omarchy theme on an Omarchy computer, and the OS's light or dark setting everywhere else (main's
   host-theme.mjs: Omarchy's colors.toml where it is there, else nativeTheme). The ids are unchanged. */
export const THEMES = Object.freeze([
  Object.freeze({ id: "light", label: "Light" }),
  Object.freeze({ id: "solarized", label: "Solarized" }),
  Object.freeze({ id: "dark", label: "Dark" }),
  Object.freeze({ id: HOST, label: "System" }),
]);
const validTheme = name => THEMES.some(theme => theme.id === name);
const normalizeTheme = name => validTheme(name) ? name : "light";

const listeners = new Set();
const terminalListeners = new Set();
const TERM_FONT_KEY = "oats.desktop.terminal.fontFamily";
/** Whether this computer runs Omarchy (main's check, preload's oatsDesktop.isOmarchy), as initFont was told:
 * it picks the default font choice (defaultFont), and nothing else. */
let hostOmarchy = false;
/* A terminal size belongs to the face it was chosen for (#1571): JetBrains Mono's advance is 0.6em against
   Inconsolata's 0.5em, so a size carried from one to the other is a fifth larger or smaller. Each face keeps
   its own stored size and default; switching the face never carries a size over. The one face→key and
   face→default mapping, which every reader and writer goes through:
   - "bundled", Inconsolata (System font, macOS, the fallback): the key every size was stored under before
     Omarchy's font reached the terminals, so those stay Inconsolata sizes; 15px (the operator's decision,
     2026-10-02; spec F item 6), theme.css's --term-font-size.
   - "omarchy", Omarchy's font in the terminals (fontconfig's monospace, JetBrains Mono by default): 13px
     (the product owner, 2026-10-26), which applyFont sets inline as --term-font-size. */
const TERMINAL_FACES = Object.freeze({
  bundled: Object.freeze({ sizeKey: "oats.desktop.terminal.fontSize", size: 15 }),
  omarchy: Object.freeze({ sizeKey: "oats.desktop.terminal.fontSize.omarchy", size: 13 }),
});
const terminalFaceOf = face => TERMINAL_FACES[face] ?? TERMINAL_FACES.bundled;
/** The face the terminals are in: "omarchy" when the font choice's stacks set --term-font-family (Omarchy's
 * font on Linux or Windows, drawing at a fixed width), else "bundled" (System font, macOS, the fallback). A
 * family set with "Terminal: set font family…" changes the family, not the face. */
export function terminalFace() { return fontFace; }
/** The terminal's default size, where none is stored for the face (the one in effect unless named): 13px
 * for Omarchy's, 15px for the bundled Inconsolata, on every host. Every reset lands here. */
export function terminalDefaultSize(face = terminalFace()) { return terminalFaceOf(face).size; }
/** The range every size control clamps to (keys, palette, Settings). */
export const TERMINAL_FONT_MIN = 9, TERMINAL_FONT_MAX = 28;

let hostSource = null;   // { mode(), tokens(base), shown(chosen) }, from initTheme
let hostChosen = false;  // the choice is "This computer"; data-theme then carries its base
let hostOverrides = [];  // the inline custom properties the host theme set

/** The choice: a built-in theme, or `host`. */
export function currentTheme() {
  return hostChosen ? HOST : appliedTheme();
}

/** The built-in theme on data-theme (the CSS hook): the choice itself, or the
 * base "This computer" is shown on. */
export function appliedTheme() {
  const name = normalizeTheme(document.documentElement.dataset.theme);
  return name === HOST ? "light" : name;
}

// Non-persisting projection, retained for callers that apply a temporary theme.
export function applyTheme(name) {
  const next = normalizeTheme(name);
  const root = document.documentElement;
  // Every override goes before anything is set, so a built-in theme chosen
  // after "This computer" is exactly what it is on its own.
  for (const property of hostOverrides) root.style.removeProperty(property);
  hostOverrides = [];
  hostChosen = next === HOST;
  if (!hostChosen) root.dataset.theme = next;
  else {
    // The whole map is derived before any of it is set: no override at all
    // when the host has no palette or it cannot be used, never half of one.
    let base = "light", tokens = null;
    try {
      base = hostSource?.mode() === "dark" ? "dark" : "light";
      root.dataset.theme = base;
      const css = getComputedStyle(root);
      tokens = hostSource?.tokens(token => css.getPropertyValue(`--${token}`).trim()) ?? null;
    } catch { root.dataset.theme = base; tokens = null; }
    for (const [property, value] of Object.entries(tokens ?? {})) { root.style.setProperty(property, value); hostOverrides.push(property); }
  }
  try { hostSource?.shown(hostChosen); } catch { /* the theme is applied either way */ }
  for (const fn of [...listeners]) { try { fn(next); } catch { /* one listener must not break others */ } }
  return next;
}

export function initTheme(host = null, fallback = "light") {
  hostSource = host;
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* storage-less */ }
  // A fresh/invalid preference means `fallback`, the platform's default (the
  // shell passes it: "This computer" on Linux, White elsewhere; anything that
  // is not a theme is White). Intentionally no OS listener, and nothing is
  // stored: the default stays a default until the user chooses.
  return applyTheme(validTheme(saved) ? saved : fallback);
}

export function setTheme(name) {
  const next = normalizeTheme(name);
  try { localStorage.setItem(KEY, next); } catch { /* choice still works in memory */ }
  return applyTheme(next);
}

// White → Solarized → Dark → This computer → White, independent of storage availability.
export function toggleTheme() {
  const index = THEMES.findIndex(theme => theme.id === currentTheme());
  return setTheme(THEMES[(index + 1) % THEMES.length].id);
}

/** The host's theme changed: show it again while "This computer" is the choice
 * (one pass over the properties, then one notification to the listeners). */
export function refreshHostTheme() {
  if (hostChosen) applyTheme(HOST);
}

export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* tmux carries cells/colors, never the host terminal emulator's font. Keep
   desktop typography as an explicit persisted preference, seeded from
   semantic CSS tokens (the bundled Inconsolata, then the OS monospace stack)
   at the face's size. A stored family, or a size stored for the face in
   effect, wins; the defaults apply only where nothing is stored. */
export function terminalTypography(el = document.documentElement) {
  const css = getComputedStyle(el);
  let family = css.getPropertyValue("--term-font-family").trim() || `"${BUNDLED_MONO}", ui-monospace, monospace`;
  let size = terminalDefaultSize();
  try {
    family = localStorage.getItem(TERM_FONT_KEY) || family;
    size = Number(localStorage.getItem(terminalFaceOf(terminalFace()).sizeKey)) || size;
  } catch { /* storage-less */ }
  // xterm measures its cell from the font when a terminal is created, and again
  // only when the font option changes. Until the bundled face has loaded, hand
  // out the rest of the stack; once it has, listeners get the full family (a
  // real change, so every live terminal re-measures and refits).
  if (BUNDLED_FIRST.test(family) && !bundledMonoReady(el.ownerDocument)) {
    family = family.replace(BUNDLED_FIRST, "") || "ui-monospace, monospace";
  }
  // No line height: xterm's default (1.0) keeps native cell geometry (a block
  // cursor one cell tall); tmux owns row spacing (060de502).
  return { fontFamily: family, fontSize: clampTerminalFontSize(size) };
}

/** The bundled default monospace face (theme.css @font-face; fonts/README.md). */
export const BUNDLED_MONO = "Inconsolata";
const BUNDLED_FIRST = /^\s*(["']?)Inconsolata\1\s*(,\s*|$)/i;
let bundledMono = "unknown"; // "loading" | "ready"
/** Whether the bundled face can be measured now. The first miss starts its load;
 * when it settles (loaded, or failed: the stack then falls back as the browser
 * would) every terminal typography listener hears the full family. */
function bundledMonoReady(doc) {
  const fonts = doc?.fonts;
  if (bundledMono === "ready" || typeof fonts?.check !== "function") return true;
  try { if (fonts.check(`13px "${BUNDLED_MONO}"`)) { bundledMono = "ready"; return true; } } catch { return true; }
  if (bundledMono !== "loading") {
    bundledMono = "loading";
    Promise.resolve().then(() => fonts.load(`13px "${BUNDLED_MONO}"`)).catch(() => {})
      .then(() => { bundledMono = "ready"; notifyTerminalTypography(); });
  }
  return false;
}

function notifyTerminalTypography() {
  const value = terminalTypography();
  for (const fn of [...terminalListeners]) { try { fn(value); } catch { /* isolate listener */ } }
}
/** A whole pixel size within TERMINAL_FONT_MIN..MAX. Any finite number is
 * rounded and clamped (0, -3 and 0.4 all give the minimum); only an unreadable
 * value (missing, blank, not a number) falls back to the face's default. */
export function clampTerminalFontSize(size) {
  const n = typeof size === "number" ? size : typeof size === "string" && size.trim() !== "" ? Number(size) : NaN;
  if (!Number.isFinite(n)) return terminalDefaultSize();
  return Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, Math.round(n)));
}
/** Stored for the face in effect only; the other face's size is untouched. */
export function setTerminalFontSize(size) {
  const value = clampTerminalFontSize(size);
  try { localStorage.setItem(terminalFaceOf(terminalFace()).sizeKey, String(value)); } catch { /* storage-less */ }
  notifyTerminalTypography();
}
/** The terminals' family chosen by name (Appearance › Font › Choose…, the palette's "Terminal: set font family…"),
 * or null when the font choice's own family applies. While one is set, it wins over the font choice. */
export function terminalFamilyChosen() {
  try { return localStorage.getItem(TERM_FONT_KEY) || null; } catch { return null; }
}
export function setTerminalFontFamily(family) {
  const value = String(family || "").trim();
  try {
    if (value) localStorage.setItem(TERM_FONT_KEY, value);
    else localStorage.removeItem(TERM_FONT_KEY);
  } catch { /* storage-less */ }
  notifyTerminalTypography();
}
/** Back to the defaults: forget the stored family and the face's size, so the
 * tokens and the face's default (and any later change to them) apply again
 * instead of a pinned copy. The other face's size stays. */
export function resetTerminalTypography() {
  try { localStorage.removeItem(TERM_FONT_KEY); localStorage.removeItem(terminalFaceOf(terminalFace()).sizeKey); } catch { /* storage-less */ }
  notifyTerminalTypography();
}
/** Settings' "Reset to default": the face's size only; a chosen family and the other face's size stay. */
export function resetTerminalFontSize() {
  try { localStorage.removeItem(terminalFaceOf(terminalFace()).sizeKey); } catch { /* storage-less */ }
  notifyTerminalTypography();
}
export function onTerminalTypographyChange(fn) {
  terminalListeners.add(fn);
  return () => terminalListeners.delete(fn);
}

/* D2 (the Desktop UI rework, decided 2026-11-19): the chrome is the system sans, whatever the font choice; the
   choice is the terminals' face only. "Omarchy's font" no longer sets --ui-font or --mono: it sets only
   --term-font-family, on Linux and Windows (on macOS it sets nothing, so the Appearance sheet does not offer it
   there). The terminals' cell geometry is unchanged: the same face and the same default size per face.

   Before D2 (kept for the record): the font (the product owner's call, 2026-10-23): "Omarchy's font" or "System font", the faces
   Desktop had before. The default is Omarchy's font on an Omarchy computer and System font everywhere
   else (2026-10-26: "lets use omachys font on omarchy"); a stored choice always wins. Omarchy's font is fontconfig's `monospace` alias (`omarchy font
   current` is `fc-match monospace`), which Chromium on Linux resolves the CSS generic `monospace`
   through, so the stack follows `omarchy font set` with nothing read from the host. Omarchy's font
   sets this platform's stacks inline on the root (fontStacks); System font sets none, so --mono and
   --term-font-family are theme.css's and --ui-font is unset, which every UI font rule reads as
   var(--ui-font, <its own stack>). The choice is per computer, stored like the theme; the shell
   passes the platform, because this module imports nothing and reads no platform. */
const FONT_KEY = "oats.desktop.font";
export const FONTS = Object.freeze([
  Object.freeze({ id: "omarchy", label: "This computer's monospace" }),
  Object.freeze({ id: "system", label: "System" }),
]);
/** Where no font was ever chosen: Omarchy's font on an Omarchy computer, System font elsewhere. */
export function defaultFont(isOmarchy = hostOmarchy) { return isOmarchy ? "omarchy" : "system"; }
const validFont = id => FONTS.some(font => font.id === id);
// Never the bare `monospace`: alone, it changes the default font size (the generic's quirk).
const FONTCONFIG_MONO = "ui-monospace, monospace";

/** The custom properties a font choice sets on the root, on macOS (`isMac`) or elsewhere (D2): the terminals'
 * family alone, fontconfig's monospace, for the monospace choice on Linux and Windows (on Windows Chromium's
 * `monospace` is its own default, Consolas); nothing for System, and nothing on macOS. */
export function fontStacks(font, isMac) {
  // D2: the terminals' face only, never the chrome's (--ui-font) or its code and paths (--mono).
  if (font !== "omarchy" || isMac) return Object.freeze({});
  return Object.freeze({ "--term-font-family": FONTCONFIG_MONO });
}

/** The Omarchy row's note when this computer's monospace font does not draw at a fixed width (fontDraws). */
export const FONT_FALLBACK_NOTE = "No monospace font on this computer: showing System";

/** The picker's rows for this platform: on macOS Omarchy's font is named by its face, since what it
 * shows there is JetBrains Mono, not a font Omarchy chose. `fallback` (fontFallsBack) says Omarchy's
 * font is showing System font's faces. */
export function fontChoices(isMac, fallback = false) {
  // System first (the Appearance sheet's order). On macOS the monospace choice changes nothing since D2 (the
  // terminals keep Inconsolata there), so it is not offered.
  const system = { id: "system", label: "System", note: "Inconsolata in the terminals" };
  if (isMac) return [system];
  return [system, { id: "omarchy", label: FONTS[0].label, note: fallback ? FONT_FALLBACK_NOTE : "Fontconfig's monospace in the terminals" }];
}

/* Whether a stack draws at a fixed width here: ten i's and ten M's in it, on a canvas, are wider than
   nothing and as wide as each other (within 1%). Chromium on Linux takes fontconfig's best match when
   there is no monospace font (a proportional sans, which breaks the terminals), skips a bitmap font
   (Skia draws outline fonts only) for the next match, and draws nothing when that was the only font;
   document.fonts.check says yes to all of them. Without a canvas (nothing to measure with) the stack
   is taken as it is. */
export function fontDraws(stack, doc = document) {
  try {
    const context = doc.createElement("canvas").getContext("2d");
    if (!context) return true;
    context.font = `13px ${stack}`;
    const narrow = context.measureText("iiiiiiiiii").width, wide = context.measureText("MMMMMMMMMM").width;
    // Both drawn (a width above zero), and equal within 1% of the wider: no absolute allowance on top.
    return narrow > 0 && wide > 0 && Math.abs(narrow - wide) <= 0.01 * Math.max(narrow, wide);
  } catch { return true; }
}

let fontChosen = "system", fontIsMac = false, fontOverrides = [], fontFallback = false, fontCheck = fontDraws, fontFace = "bundled";
const fontListeners = new Set();

/** The font choice: an id of FONTS. */
export function currentFont() { return fontChosen; }
/** Whether Omarchy's font shows System font's faces here: this computer's monospace font does not draw
 * at a fixed width (fontDraws, checked at start and on each choice, whichever is chosen, so the picker's
 * note is right before Omarchy's font is chosen). The stored choice stays. */
export function fontFallsBack() { return fontFallback; }

function applyFont(id) {
  const root = document.documentElement;
  for (const property of fontOverrides) root.style.removeProperty(property);
  fontOverrides = [];
  fontChosen = validFont(id) ? id : defaultFont();
  // Omarchy's font is used only once it draws at a fixed width; otherwise System font's faces (none set).
  fontFallback = !fontIsMac && !fontCheck(FONTCONFIG_MONO, document);
  const stacks = fontChosen === "omarchy" && fontFallback ? {} : fontStacks(fontChosen, fontIsMac);
  for (const [property, value] of Object.entries(stacks)) {
    root.style.setProperty(property, value); fontOverrides.push(property);
  }
  // The terminals' face follows their family: Omarchy's when the stacks set it, else Inconsolata. Its default
  // size goes on the size token too, where it is not theme.css's own (the bundled face's 15px).
  fontFace = "--term-font-family" in stacks ? "omarchy" : "bundled";
  if (fontFace !== "bundled") {
    root.style.setProperty("--term-font-size", `${terminalDefaultSize()}px`); fontOverrides.push("--term-font-size");
  }
  root.dataset.font = fontChosen;
  if (fontChosen === "omarchy" && fontFallback) root.dataset.fontFallback = "system"; else delete root.dataset.fontFallback;
  for (const fn of [...fontListeners]) { try { fn(fontChosen); } catch { /* one listener must not break others */ } }
  // Open terminals take the new family and the new face's size in place, and refit (a stored terminal family still wins).
  if (terminalListeners.size) notifyTerminalTypography();
  return fontChosen;
}

/** At start: the saved choice, else defaultFont(), which is not stored (it stays a default, as the
 * theme's does). `isMac` picks the platform's stacks and `isOmarchy` (oatsDesktop.isOmarchy, true only
 * as a boolean) the default choice, for this window's life; the terminals' size follows their face
 * (terminalFace), not the host.
 * `check` is fontDraws but for tests. */
export function initFont(isMac = false, check = fontDraws, { isOmarchy = false } = {}) {
  fontIsMac = !!isMac; fontCheck = check; hostOmarchy = isOmarchy === true;
  let saved = null;
  try { saved = localStorage.getItem(FONT_KEY); } catch { /* storage-less */ }
  return applyFont(validFont(saved) ? saved : defaultFont());
}

/** A choice: stored, then applied in place (no reload: open terminals keep their state). */
export function setFont(id) {
  const next = validFont(id) ? id : defaultFont();
  try { localStorage.setItem(FONT_KEY, next); } catch { /* the choice still works in memory */ }
  return applyFont(next);
}

export function onFontChange(fn) {
  fontListeners.add(fn);
  return () => fontListeners.delete(fn);
}

/* Build the xterm.js theme object from the live CSS tokens so the embedded
   terminal always matches the app theme (incl. the solarized light remap). */
const ANSI = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "bright-black", "bright-red", "bright-green", "bright-yellow",
  "bright-blue", "bright-magenta", "bright-cyan", "bright-white",
];
export function xtermTheme(el = document.documentElement) {
  const css = getComputedStyle(el);
  const v = (name) => (css.getPropertyValue(name) || "").trim();
  const t = {
    background: v("--term-bg"),
    foreground: v("--term-fg"),
    cursor: v("--term-fg"),
    cursorAccent: v("--term-bg"),
    selectionBackground: v("--term-sel"),
    selectionForeground: v("--term-sel-fg"),
  };
  const camel = (s) => s.replace(/-(\w)/g, (m, c) => c.toUpperCase());
  for (const name of ANSI) {
    const val = v(`--ansi-${name}`);
    if (val) t[camel(name)] = val;
  }
  return t;
}

/** xterm's `normal`: the weight when the theme names none, or an unusable one. */
export const TERMINAL_FONT_WEIGHT = 400;
/** The terminal's text weight: the theme's --term-font-weight, not a typography
 * preference (why: renderer/README.md, the typography paragraph). */
export function terminalFontWeight(el = document.documentElement) {
  const weight = Number(getComputedStyle(el).getPropertyValue("--term-font-weight"));
  return Number.isFinite(weight) && weight >= 1 && weight <= 1000 ? weight : TERMINAL_FONT_WEIGHT;
}
