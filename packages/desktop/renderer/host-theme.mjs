/* oats desktop — "This computer": the theme of the computer that runs Desktop
   (renderer, #602).

   The host theme is a built-in theme as base plus a set of token overrides. The
   base is Dark or White by the host's polarity, so every rule and every token
   the host does not supply keeps its calibrated value (soul and runtime pairs,
   shadows, the scrim, fonts, the terminal's text weight). The overrides are
   derived here from the host's colours: surfaces are the host's, and every text
   colour is moved until it meets the contrast inventory
   (`contrast-inventory.mjs`) on each surface it is drawn on. A palette that
   cannot be made to pass is not applied at all.

   Main reads the host (`../host-theme.mjs`) and sends plain state; this module
   validates it again, derives the tokens, remembers the last state shown for
   the next first paint, and says so when the host's theme could not be used.
   `theme.mjs` applies what this module answers; it never imports it (tests
   evaluate its source on its own), so the shell hands one to `initTheme()`. */
import { TEXT_PAIRS, GRAPHIC_PAIRS, PAINTED_OVER, ANSI_TOKENS, SOUL_TONES, TEXT_CONTRAST, GRAPHIC_CONTRAST } from "./contrast-inventory.mjs";

const HEX = /^#[0-9a-f]{6}$/; // what main sends: opaque and lower-case
// A base theme's own token, as theme.css writes it: opaque, or with an alpha byte.
const CSS_OPAQUE = /^#[0-9a-f]{6}$/i, CSS_ALPHA = /^#[0-9a-f]{8}$/i;
const channels = hex => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16));
const toHex = rgb => `#${rgb.map(value => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
/** `a` moved towards `b` by `t` (0–1): a linear mix of the sRGB channels. */
export function mixHex(a, b, t) {
  const from = channels(a), to = channels(b);
  return toHex(from.map((value, i) => value + (to[i] - value) * t));
}
function luminance(rgb) {
  const [r, g, b] = rgb.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG contrast ratio of two colours given as channel triples. */
function contrast(one, other) {
  const a = luminance(one), b = luminance(other);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const REASONS = ["missing", "unreadable", "invalid"];
const COLOR_KEYS = ["background", "foreground", "accent", "selection", "canvas", "brightForeground"];
/** Main's state, checked again before use (shape, lower-case `#rrggbb`, mode):
 * a clean copy, or null. A stored last state goes through the same check. */
export function validHostState(value) {
  if (!value || typeof value !== "object") return null;
  const { mode } = value;
  if (mode !== "dark" && mode !== "light") return null;
  if (value.source === "system") {
    if (value.problem === undefined) return { source: "system", mode };
    const { problem } = value;
    if (!problem || typeof problem !== "object" || problem.origin !== "omarchy" || !REASONS.includes(problem.reason)) return null;
    return { source: "system", mode, problem: { origin: "omarchy", reason: problem.reason } };
  }
  if (value.source !== "omarchy") return null;
  const colors = value.colors, hex = item => typeof item === "string" && HEX.test(item);
  if (!colors || typeof colors !== "object" || !COLOR_KEYS.every(key => hex(colors[key]))) return null;
  if (!Array.isArray(colors.ansi) || colors.ansi.length !== ANSI_TOKENS.length || !colors.ansi.every(hex)) return null;
  return { source: "omarchy", mode, colors: { ...Object.fromEntries(COLOR_KEYS.map(key => [key, colors[key]])), ansi: [...colors.ansi] } };
}

/** `start`, or the first colour on the way from it to white or black (2% steps)
 * that holds every `[surface, ratio]` need; null when neither direction gets
 * there. It moves away from the surfaces first: towards white when it is
 * lighter than their mean luminance, else towards black. */
function ensure(start, needs) {
  const holds = hex => needs.every(([surface, ratio]) => contrast(channels(hex), surface) >= ratio);
  if (!needs.length || holds(start)) return start;
  const mean = needs.reduce((total, [surface]) => total + luminance(surface), 0) / needs.length;
  const targets = luminance(channels(start)) >= mean ? ["#ffffff", "#000000"] : ["#000000", "#ffffff"];
  for (const target of targets) {
    for (let step = 1; step <= 50; step++) {
      const moved = mixHex(start, target, step / 50);
      if (holds(moved)) return moved;
    }
  }
  return null;
}

/** The token overrides for a host palette: `{ "--bg": "#rrggbb", … }`, or null
 * when the input is not a valid palette or some text colour cannot be made to
 * pass. `base(token)` reads the base theme's value of a token the host does not
 * override (the translucent `md-code-bg`, painted over the derived `--bg`). */
export function deriveHostTokens(colors, mode, base = () => undefined) {
  const state = validHostState({ source: "omarchy", mode, colors });
  if (!state) return null;
  const { background, foreground, accent, selection, canvas, brightForeground, ansi } = state.colors;
  const [, red, green, yellow, , magenta] = ansi;
  // Surfaces define the theme: the host's own, unadjusted.
  const raised = mixHex(background, foreground, 0.06);
  const tokens = {
    "term-bg": background, surface: background, sidebar: background, bg: canvas,
    "surface-2": raised, "chip-bg": raised, "tag-bg": raised,
    border: mixHex(background, foreground, 0.14),
    "tree-line": mixHex(background, foreground, 0.2),
    sel: mixHex(background, accent, 0.18), "sel-border": mixHex(background, accent, 0.45),
    "attn-bg": mixHex(background, yellow, 0.16), "attn-border": mixHex(background, yellow, 0.4), "attn-dot": yellow,
  };
  // The 16 terminal colours are the host's, unadjusted (HOST_UNADJUSTED_PAIRS says why).
  ANSI_TOKENS.forEach((token, slot) => { tokens[token] = ansi[slot]; });

  const behind = new Map(PAINTED_OVER);
  /** The channels a surface token paints: its derived value, else the base theme's; a translucent one over its backdrop. */
  const painted = token => {
    const value = tokens[token] ?? base(token);
    if (typeof value !== "string") return null;
    if (CSS_OPAQUE.test(value)) return channels(value);
    if (!CSS_ALPHA.test(value) || !behind.has(token)) return null;
    const backdrop = painted(behind.get(token));
    if (!backdrop) return null;
    const alpha = parseInt(value.slice(7), 16) / 255;
    return channels(value.slice(0, 7)).map((channel, i) => channel * alpha + backdrop[i] * (1 - alpha));
  };
  /** `token` = `start`, moved until it holds on every surface the inventory pairs it with: 4.5:1 where it is text
   * (TEXT_PAIRS), 3:1 where it is a graphic (GRAPHIC_PAIRS), together, so a colour that is both (--danger: words,
   * and the problem dots on --sel) never trades one for the other. */
  const hold = (token, start) => {
    const needs = [[TEXT_PAIRS, TEXT_CONTRAST], [GRAPHIC_PAIRS, GRAPHIC_CONTRAST]]
      .flatMap(([pairs, ratio]) => pairs.filter(([fg]) => fg === token).map(([, bg]) => [painted(bg), ratio]));
    const value = needs.some(([surface]) => !surface) ? null : ensure(start, needs);
    if (value) tokens[token] = value;
    return Boolean(value);
  };
  // A terminal's selection (#672) is the one sign of what a copy takes: its fill holds 3:1 on the terminal's
  // background (GRAPHIC_PAIRS) and its text 4.5:1 on the fill. The host's selection colour, moved until it
  // does (Omarchy's are about 1.3:1). Moving all the way to white or black is at least 4.58:1 on any colour,
  // so both always get there.
  if (!hold("term-sel", selection)) return null;
  const secondary = mixHex(foreground, background, 0.3);
  // --primary-fg and --primary-bg are each other's surface (toast buttons invert on focus):
  // the first starts as the host's background, and is held to the final --primary-bg below.
  tokens["primary-fg"] = background;
  const text = [
    ["fg", foreground], ["term-fg", foreground], ["primary-bg", foreground], ["primary-fg", background],
    ["muted", secondary], ["chip-fg", secondary],
    ["nav-fg", mixHex(foreground, background, 0.34)], ["faint", mixHex(foreground, background, 0.38)],
    ["accent", accent], ["ok", green], ["warn", yellow], ["danger", red], ["violet", magenta],
    ["term-sel-fg", brightForeground],
  ];
  for (const [token, start] of text) if (!hold(token, start)) return null;
  if (!hold("graph-edge", mixHex(background, foreground, 0.4))) return null;
  // The sidebar's dotted sibling link is the only mark on its column (#1312): a meaningful graphic too. The harness
  // mark on a row's line 2 (shell.css .ctx-row-detail > .ctx-harness, slice 3d) is in the same ink, on the same fills.
  if (!hold("tree-link", mixHex(background, foreground, 0.4))) return null;
  // Its solid lines are drawn for related work only, so they are the sign of it: a meaningful graphic as well.
  if (!hold("tree-stroke", mixHex(background, foreground, 0.4))) return null;
  // An instance's colour on its dot (#1421): the base theme's (its soul's -fg), moved until it holds on every fill a
  // dot is drawn on. The soul pairs themselves stay calibrated. Without a base value (no stylesheet) it is left alone.
  for (const tone of SOUL_TONES) {
    const start = base(`instance-${tone}`);
    if (typeof start === "string" && CSS_OPAQUE.test(start) && !hold(`instance-${tone}`, start.toLowerCase())) return null;
  }
  // The running dot and the lit graph path are the accent, as in the built-in themes.
  tokens.live = tokens["graph-edge-coord"] = tokens.accent;
  return Object.fromEntries(Object.entries(tokens).map(([token, value]) => [`--${token}`, value]));
}

const STORE_KEY = "oats.desktop.hostTheme"; // the last host state shown, for the next first paint
const DETAILS = {
  missing: "The Omarchy theme has no colors file.",
  unreadable: "The Omarchy theme's colors file could not be read.",
  invalid: "The Omarchy theme's colors are not usable.",
};

/** What "This computer" shows in this window, kept current.
 *
 * `theme.mjs` asks it (`initTheme(hostTheme)`): `mode()` is the base, `tokens(base)`
 * the overrides (null for none: the system appearance, or a problem), and
 * `shown(chosen)` is called after every theme change. `start()` subscribes to
 * main's pushes and asks once; `onChange` then re-applies the theme (`theme.mjs`
 * does so only while "This computer" is the choice). `attach(notify)` gives it
 * the notification centre, which is created after the first paint.
 *
 * A problem is said once per episode: an episode is a reason plus the base
 * shown instead, so the notice is not posted again after its × or after the
 * centre clears, is replaced when either changes, and is dismissed by a usable
 * state or by choosing another theme. */
export function createHostTheme({ desk = null, storage = null, onChange = () => {} } = {}) {
  let state = null;    // the latest valid state from main, or the stored one until main answers
  let failed = false;  // the current palette could not be derived
  let chosen = false, notify = null, notice = null, episode = null;
  let serial = 0, off = null, alive = true;
  try { state = validHostState(JSON.parse(storage.getItem(STORE_KEY))); } catch { /* nothing stored, or no longer valid */ }
  if (state?.problem) state = null; // only a state that was shown is ever stored: a problem here is not one
  const mode = () => state?.mode === "dark" ? "dark" : "light";
  function receive(value) {
    const next = validHostState(value);
    if (!next) return;
    state = next;
    onChange();
  }
  function announce() {
    const reason = chosen ? state?.problem?.reason ?? (failed ? "invalid" : null) : null;
    const next = reason ? `${reason}:${mode()}` : null;
    if (next === episode || (next && !notify)) return;
    notice?.dismiss(); notice = null; episode = next;
    if (!next) return;
    notice = notify(`This computer's theme could not be read. Showing ${mode() === "dark" ? "Dark" : "White"} instead.`,
      { sticky: true, detail: DETAILS[reason] }) || null;
  }
  return {
    mode,
    tokens(base) {
      const tokens = state?.source === "omarchy" ? deriveHostTokens(state.colors, state.mode, base) : null;
      failed = state?.source === "omarchy" && !tokens;
      return tokens;
    },
    shown(isChosen) {
      chosen = isChosen === true;
      if (chosen && state && !state.problem && !failed) { try { storage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* still shown; only the next first paint misses it */ } }
      announce();
    },
    attach(notifier) { notify = typeof notifier === "function" ? notifier : null; announce(); },
    start() {
      if (off || !alive) return;
      off = desk?.onHostThemeChanged?.(value => { serial++; receive(value); }) ?? (() => {});
      // Latest intent: a push is newer than the answer to this read, so an answer that arrives after one is dropped.
      const asked = serial;
      Promise.resolve().then(() => desk?.hostTheme?.())
        .then(value => { if (alive && asked === serial) receive(value); }, () => { /* no answer: the stored state and later pushes stand */ });
    },
    dispose() { alive = false; try { off?.(); } catch { /* bridge gone */ } off = null; },
  };
}
