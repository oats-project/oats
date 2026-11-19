import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { JSDOM } from "jsdom";
// The one contrast inventory (renderer/contrast-inventory.mjs): this file holds every built-in palette
// to it, and the "This computer" derivation (renderer/host-theme.mjs) is computed from the same lists.
import { TEXT_PAIRS as pairs, GRAPHIC_PAIRS, PAINTED_OVER, HOST_UNADJUSTED_PAIRS, ANSI_TOKENS as ansi, SOUL_TONES as soulTones, RUNTIMES as runtimes,
  TEXT_CONTRAST, GRAPHIC_CONTRAST } from "../renderer/contrast-inventory.mjs";
import { deriveHostTokens, mixHex } from "../renderer/host-theme.mjs";
import { hostState } from "./helpers/host-theme-fixture.mjs";
import { createSoulMark, createRuntimeBadge, identityCSS } from "../renderer/identity-marks.mjs";
import { workspaceStatusData, syncData } from "../../client/deployment-data.mjs";
import { renderCapabilities, renderCapabilitySections, renderRepoPills, repoChoices, sourceChip } from "../renderer/workspace-catalog.mjs";
import { capabilitySections, hostKeyOf, memberNames } from "../../client/capability-rows.mjs";
import { renderSetup, teamsBox } from "../renderer/workspace-setup.mjs";
import { discoveryCSS } from "../renderer/workspace-discovery.mjs";
import { ABOUT_COPY, createAboutDialog } from "../renderer/about-dialog.mjs";
import { createConnections, connectionsCSS } from '../renderer/connections.mjs';
import { createTerminalSettings, settingsTerminalCSS } from '../renderer/settings-terminal.mjs';
import { createForgePrPanel } from '../renderer/forge-pr.mjs';
import { instanceGitCSS } from '../renderer/instance-git.mjs';
import { createContextPanel, contextPanelCSS } from '../renderer/context-panel.mjs';
import { prChip, rosterPrCSS } from '../renderer/roster-pr.mjs';
import { createNotificationCenter, notificationCSS } from '../renderer/notifications.mjs';
import { createWorkspaceSwitcher } from '../renderer/workspace-switcher.mjs';
import { instanceActions } from '../renderer/instance-actions.mjs';
import { iconElement } from '../renderer/shell-icons.mjs';
import { createSettingsMenu } from '../renderer/sidebar-settings.mjs';
import { instanceActionTarget } from '../renderer/instance-action-target.mjs';
import { pullRequest } from '../renderer/forge-contract.mjs';
import { target as forgeTarget, pr as forgePr } from './helpers/forge-fixture.mjs';
import { createLifecycleDialog, lifecycleCSS } from '../renderer/lifecycle-dialog.mjs';
import { createForgetDialog } from '../renderer/forget-dialog.mjs';
import { createReadinessView, readinessCSS } from '../renderer/readiness-view.mjs';
import { cli as readinessCli, workspace as readinessWorkspace, selector as readinessSelector, view as readinessView, data as readinessFixture } from './helpers/readiness-fixture.mjs';
import { instance as lifeInstance, target as lifeTarget, stopPlan as stopFixture, retirePlan as retireFixture, stopReceipt, retireReceipt } from './helpers/lifecycle-fixture.mjs';
import { lifecycleReceipt } from '../../client/lifecycle-contract.mjs';
import { createSchedulesView } from '../renderer/views/schedules.mjs';
import { createSoulInspector, inspectorCSS } from '../renderer/soul-inspector.mjs';
import { readinessCSS as readinessViewCSS } from '../renderer/readiness-view.mjs';
import { createInstanceGitPanel } from '../renderer/instance-git.mjs';
import { spawnDialogCSS } from '../renderer/spawn-dialog.mjs';
import { groupHeadingCSS } from '../renderer/group-heading.mjs';
import { createAutomationsView } from '../renderer/views/automations.mjs';
import { setWorkspace } from '../renderer/views/common.mjs';
import { createTerminalTab, terminalOptions, TERMINAL_MINIMUM_CONTRAST } from "../renderer/terminal-tab.mjs";

const renderer = new URL("../renderer/", import.meta.url);
const css = readFileSync(new URL("theme.css", renderer), "utf8");
const themeJs = readFileSync(new URL("theme.mjs", renderer), "utf8");
function shippedStyleSources(dir = renderer) {
  const chunks = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) chunks.push(...shippedStyleSources(url));
    else if (/\.(?:css|mjs)$/.test(entry.name)) chunks.push({ path: url.pathname, text: readFileSync(url, "utf8") });
  }
  return chunks;
}
// With the renderer modules that moved to the shared home (packages/client): the page loads them too.
const shipped = [...shippedStyleSources(), ...shippedStyleSources(new URL("../../client/", renderer))];
const allStyles = shipped.map(({ path, text }) => `\n/* ${path} */\n${text}`).join("");

function tokens(block) {
  return new Map([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6}(?:[0-9a-f]{2})?)\b/gi)]
    .map((m) => [m[1], m[2].toLowerCase()]));
}

const dark = tokens(css.match(/:root, \[data-theme="dark"\] \{([\s\S]*?)\n\}/)?.[1] || "");
const light = new Map(dark);
for (const [key, value] of tokens(css.match(/\[data-theme="light"\] \{([\s\S]*?)\n\}/)?.[1] || "")) light.set(key, value);
const solarized = new Map(dark);
for (const [key, value] of tokens(css.match(/\[data-theme="solarized"\] \{([\s\S]*?)\n\}/)?.[1] || "")) solarized.set(key, value);
const palettes = [["light", light], ["solarized", solarized], ["dark", dark]];

function opaqueChannels(hex) {
  assert.match(hex, /^#[0-9a-f]{6}$/i, "foregrounds and base surfaces must be opaque hex colors");
  return hex.slice(1).match(/../g).map((value) => parseInt(value, 16));
}

// The markdown scroll surface paints --bg behind its translucent code blocks.
// Do NOT strip the alpha byte, or test against the uncomposited foreground of
// --md-code-bg. Keep fractional sRGB channels until luminance is calculated.
const backgroundParents = new Map(PAINTED_OVER);
function backgroundChannels(name, palette) {
  const hex = palette.get(name);
  assert.ok(hex, `defines --${name}`);
  if (hex.length === 7) return opaqueChannels(hex);
  assert.match(hex, /^#[0-9a-f]{8}$/i);
  assert.ok(backgroundParents.has(name), `translucent --${name} needs an explicit painted backdrop`);
  const parent = backgroundChannels(backgroundParents.get(name), palette);
  const alpha = parseInt(hex.slice(7), 16) / 255;
  return opaqueChannels(hex.slice(0, 7)).map((value, i) => value * alpha + parent[i] * (1 - alpha));
}

function luminance(rgb) {
  const channels = rgb.map((value) => value / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground, background) {
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// The inventory itself lives in renderer/contrast-inventory.mjs (imported above as `pairs`, `ansi`,
// `soulTones`, `runtimes`). Its shape is pinned here so a pair cannot leave it unnoticed.
test("the shared inventory holds token names only, covers the 16 ANSI colours, and names what the host theme does not hold", () => {
  for (const [fg, bg] of [...pairs, ...GRAPHIC_PAIRS, ...PAINTED_OVER]) { assert.match(fg, /^[a-z0-9-]+$/); assert.match(bg, /^[a-z0-9-]+$/); }
  assert.equal(new Set(pairs.map(pair => pair.join(" on "))).size, pairs.length, "no pair twice");
  assert.equal(ansi.length, 16);
  for (const token of ansi) assert.ok(pairs.some(([fg, bg]) => fg === token && bg === "term-bg"), `--${token} is held on --term-bg`);
  assert.deepEqual(GRAPHIC_PAIRS, [["graph-edge", "bg"], ["graph-edge", "surface"], ["graph-edge", "surface-2"], ["tree-link", "surface"], ["tree-link", "surface-2"], ["tree-link", "sel"], ["muted", "surface"], ["muted", "surface-2"], ["term-sel", "term-bg"], ["accent", "surface"], ["danger", "sel"],
    ...soulTones.flatMap(tone => ["bg", "surface", "surface-2", "sel"].map(bg => [`instance-${tone}`, bg]))]);
  assert.deepEqual(PAINTED_OVER, [["md-code-bg", "bg"]]);
  assert.deepEqual(HOST_UNADJUSTED_PAIRS, ansi.map(token => [token, "term-bg"]), "the host theme's one exception: its terminal colours, unadjusted");
  assert.equal(TEXT_CONTRAST, 4.5); assert.equal(GRAPHIC_CONTRAST, 3);
  assert.doesNotMatch(readFileSync(new URL("contrast-inventory.mjs", renderer), "utf8"), /#[0-9a-f]{3,8}\b/i, "no colour value: the palettes are theme.css's");
});

test("contrast inventory retains alpha and composites code backgrounds over the painted --bg", () => {
  assert.equal(dark.get("md-code-bg"), "#ffffff10");
  assert.equal(light.get("md-code-bg"), "#ffffff60");
  assert.equal(solarized.get("md-code-bg"), "#58637510");
  assert.deepEqual(backgroundChannels("md-code-bg", new Map([
    ["md-code-bg", "#ffffff10"], ["bg", "#000000"],
  ])), [16, 16, 16], "the alpha byte is 16/255, not 10% or opaque white");
  for (const [, palette] of palettes) {
    const base = opaqueChannels(palette.get("bg"));
    const overlay = opaqueChannels(palette.get("md-code-bg").slice(0, 7));
    const painted = backgroundChannels("md-code-bg", palette);
    const alpha = parseInt(palette.get("md-code-bg").slice(7), 16) / 255;
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(painted[i] - (base[i] + (overlay[i] - base[i]) * alpha)) < 1e-10);
    assert.notDeepEqual(painted, base, "code is not painted directly on the unmodified base");
    assert.notDeepEqual(painted, overlay, "code background is not the opaque overlay color");
  }
  assert.throws(() => opaqueChannels("#ffffff80"), /must be opaque/);
  assert.throws(() => backgroundChannels("unknown", new Map([["unknown", "#ffffff10"]])), /explicit painted backdrop/);
});

test("all shipped hljs foregrounds are paired with their actual code background", () => {
  const rules = [...allStyles.matchAll(/\.hljs\b[^{}]*\{([^{}]*)\}/g)];
  const used = new Set();
  for (const [, body] of rules) {
    for (const match of body.matchAll(/\bcolor:\s*var\(--([\w-]+)\)/g)) {
      used.add(match[1]);
      assert.ok(pairs.some(([fg, bg]) => fg === match[1] && bg === "md-code-bg"),
        `hljs --${match[1]} needs contrast coverage on --md-code-bg`);
    }
  }
  assert.deepEqual([...used].sort(), ["accent", "fg", "muted", "ok", "violet", "warn"]);
});

test("xterm JavaScript theme fields use the same validated tokens with no raw fallback", () => {
  const fields = new Map([...themeJs.matchAll(/(\w+):\s*v\("(--[\w-]+)"\)/g)]
    .map((match) => [match[1], match[2].slice(2)]));
  assert.equal(fields.get("foreground"), "term-fg");
  assert.equal(fields.get("background"), "term-bg");
  assert.equal(fields.get("selectionForeground"), "term-sel-fg");
  assert.equal(fields.get("selectionBackground"), "term-sel");
  assert.doesNotMatch(themeJs, /v\("--[\w-]+"\s*,/,
    "xterm colors cannot bypass the CSS token inventory through JS fallbacks");
});

test("every shipped renderer foreground is an opaque, validated semantic token", () => {
  const unvalidated = [...allStyles.matchAll(/(?:^|[;{])\s*color:\s*(color-mix\(|#[0-9a-f]{3,8}\b|var\([^;]+,)/gim)];
  assert.deepEqual(unvalidated.map((m) => m[0].trim()), [],
    "raw, fallback, and derived text colors must become named tokens included in the matrix");
  const opacity = shipped.filter(({ text }) => /\bopacity\s*:/.test(text)).map(({ path }) => path);
  assert.deepEqual(opacity, [], "container/text opacity is forbidden because it invalidates token contrast");

  const validatedForegrounds = new Set(pairs.map(([fg]) => fg));
  const usedForegrounds = [...allStyles.matchAll(/(?:^|[;{])\s*color:\s*var\(--([\w-]+)\)/gim)].map((m) => m[1]);
  assert.deepEqual([...new Set(usedForegrounds.filter((token) => !validatedForegrounds.has(token)))], [],
    "every semantic foreground used by any shipped CSS/MJS source must appear in the contrast matrix");
});

for (const [name, palette] of palettes) {
  test(`theme contrast: ${name} text and ANSI pairings meet WCAG AA`, () => {
    for (const [fgName, bgName] of pairs) {
      const fg = palette.get(fgName), bg = palette.get(bgName);
      assert.ok(fg, `${name} defines --${fgName}`);
      assert.ok(bg, `${name} defines --${bgName}`);
      const painted = backgroundChannels(bgName, palette);
      const ratio = contrast(opaqueChannels(fg), painted);
      assert.ok(ratio >= 4.5,
        `${name} --${fgName} ${fg} on --${bgName} ${bg} (painted ${painted.join(", ")}): ${ratio.toFixed(2)}:1 < 4.5:1`);
    }
  });
}

// The terminal's contrast floor (#602): xterm is given TERMINAL_MINIMUM_CONTRAST and redraws any text
// colour that is under it against its cell's background. The calibrated palette has to meet that ratio
// on its own background already, so the floor leaves it as designed and only acts on combinations
// nobody calibrated. Raising the constant without recalibrating the palettes fails here.
for (const [name, palette] of palettes) test(`${name}: the default foreground and the 16 ANSI colours meet the terminal's minimum contrast on --term-bg`, () => {
  assert.equal(typeof TERMINAL_MINIMUM_CONTRAST, "number");
  assert.equal(terminalOptions({}).minimumContrastRatio, TERMINAL_MINIMUM_CONTRAST, "the ratio held here is the one xterm is given");
  const bg = backgroundChannels("term-bg", palette);
  for (const fgName of ["term-fg", ...ansi]) {
    const fg = palette.get(fgName);
    assert.ok(fg, `${name} defines --${fgName}`);
    const ratio = contrast(opaqueChannels(fg), bg);
    assert.ok(ratio >= TERMINAL_MINIMUM_CONTRAST,
      `${name} --${fgName} ${fg} on --term-bg ${palette.get("term-bg")}: ${ratio.toFixed(2)}:1 < ${TERMINAL_MINIMUM_CONTRAST}:1, so xterm would redraw a palette colour`);
  }
});

// A terminal's selection (#672): a drag is xterm's own selection, drawn from --term-sel and --term-sel-fg
// (xtermTheme). Every theme, the host's included, defines both, opaque, so xterm paints the selection
// exactly as given (its renderers use blend(background, selectionBackground), which for an opaque colour is
// the colour itself: nothing is composited under the text), and selected text meets the terminal's
// minimum contrast on it.
const selectionPalettes = [...palettes, ...["tokyo-night", "rose-pine", "hackerman", "legacy"].map(fixture => {
  const state = hostState(fixture);
  const base = state.mode === "dark" ? dark : light;
  const palette = new Map(base);
  for (const [property, value] of Object.entries(deriveHostTokens(state.colors, state.mode, token => base.get(token)))) palette.set(property.slice(2), value);
  return [`This computer (${fixture})`, palette];
})];
for (const [name, palette] of selectionPalettes) test(`${name}: the terminal selection is opaque and selected text meets the terminal's minimum contrast on it`, () => {
  for (const token of ["term-sel", "term-sel-fg"]) assert.match(palette.get(token) || "", /^#[0-9a-f]{6}$/i, `${name} defines an opaque --${token}`);
  const ratio = contrast(opaqueChannels(palette.get("term-sel-fg")), opaqueChannels(palette.get("term-sel")));
  assert.ok(ratio >= TERMINAL_MINIMUM_CONTRAST, `${name} --term-sel-fg on --term-sel: ${ratio.toFixed(2)}:1`);
  assert.ok(pairs.some(([fg, bg]) => fg === "term-sel-fg" && bg === "term-sel"), "the text pair is in the shared inventory");
  // The fill is the one sign of what a copy takes: a UI state, held to 3:1 on the terminal (WCAG 1.4.11).
  const fill = contrast(opaqueChannels(palette.get("term-sel")), opaqueChannels(palette.get("term-bg")));
  assert.ok(fill >= GRAPHIC_CONTRAST, `${name} --term-sel on --term-bg: ${fill.toFixed(2)}:1 < 3:1`);
  assert.ok(GRAPHIC_PAIRS.some(([graphic, bg]) => graphic === "term-sel" && bg === "term-bg"), "the fill pair is in the shared inventory");
});

test("an unfocused terminal's selection is drawn like a focused one: the xterm theme sets no inactive selection colour", () => {
  // xterm 5.5 defaults selectionInactiveBackground to selectionBackground, so both floors above hold for it.
  assert.doesNotMatch(themeJs, /selectionInactive/);
});

// Control rule 2: keyboard focus is a 1px edge (WCAG 1.4.11 non-text, 3:1). Controls that paint their own
// opaque pair (primary, danger fill) carry it 1px OUTSIDE, so it is measured against the surfaces those
// buttons sit on; inset it would sit on their own fill, which fails in every theme. The toast's edge is
// --primary-fg outside its inverted buttons, on the toast's --primary-bg.
for (const [name, palette] of palettes) test(`${name}: focus edges outside opaque-pair controls meet 3:1 on the surfaces around them`, () => {
  const ratio = (fg, bg) => contrast(opaqueChannels(palette.get(fg)), backgroundChannels(bg, palette));
  for (const bg of ["bg", "surface", "surface-2", "term-bg", "sel"]) {
    assert.ok(ratio("accent", bg) >= 3, `${name} accent edge on --${bg}: ${ratio("accent", bg).toFixed(2)}:1`);
  }
  assert.ok(ratio("primary-fg", "primary-bg") >= 3, `${name} toast edge --primary-fg on --primary-bg: ${ratio("primary-fg", "primary-bg").toFixed(2)}:1`);
  // Why the edge moved outside: inset on a danger fill it is below 3:1 in every theme (and on
  // --primary-bg in dark and solarized; light's 3.38:1 is too thin to rely on).
  assert.ok(ratio("accent", "danger") < 3, `${name} accent on --danger would need the outside edge`);
});

// Graph connectors (the Active overview's edges on its --surface-2 group cards, Setup's tree lines on
// --bg/--surface/--surface-2) are meaningful graphics: WCAG 1.4.11 asks 3:1, and --graph-edge must not
// fall back to the decorative --border it once shared. The accent-lit path already passes the focus rule.
// A native select's chevron (theme.css select.field) is --muted on the field, enabled or disabled.
for (const [name, palette] of palettes) test(`${name}: --graph-edge connectors, the select chevron and the terminal selection meet 3:1 on every surface they are drawn on`, () => {
  for (const [graphic, bg] of GRAPHIC_PAIRS) {
    const ratio = contrast(opaqueChannels(palette.get(graphic)), backgroundChannels(bg, palette));
    assert.ok(ratio >= GRAPHIC_CONTRAST, `${name} --${graphic} ${palette.get(graphic)} on --${bg}: ${ratio.toFixed(2)}:1 < 3:1`);
  }
  assert.notEqual(palette.get("graph-edge"), palette.get("border"), `${name} connectors are not the decorative border`);
});

// "This computer" (#602): the host's palette as overrides on a built-in base. Real Omarchy 4.0.4
// palettes (test/fixtures/host-theme/) go through the same inventory, with the same arithmetic, as
// the built-in themes above. Derived colours are not pinned by value: the mixes may be tuned. What
// is held: every pair, and the colours that pass through unchanged.
const HOST_DECORATIVE = ["border", "tree-line", "sel-border", "attn-border", "attn-dot", "live", "graph-edge-coord"];
for (const fixture of ["tokyo-night", "rose-pine", "hackerman", "legacy"]) test(`This computer (${fixture}): the derived palette on its base meets the whole inventory, and its terminal colours are the host's own`, () => {
  const state = hostState(fixture);
  const base = state.mode === "dark" ? dark : light;
  const overrides = deriveHostTokens(state.colors, state.mode, token => base.get(token));
  assert.ok(overrides, "the palette can be derived");
  const palette = new Map(base);
  for (const [property, value] of Object.entries(overrides)) {
    assert.match(property, /^--[a-z0-9-]+$/);
    assert.match(value, /^#[0-9a-f]{6}$/, `${property} is an opaque colour`);
    assert.ok(base.has(property.slice(2)), `${property} overrides a token the base theme defines`);
    palette.set(property.slice(2), value);
  }
  const unadjusted = new Set(HOST_UNADJUSTED_PAIRS);
  for (const pair of pairs) {
    if (unadjusted.has(pair)) continue;
    const [fgName, bgName] = pair;
    const painted = backgroundChannels(bgName, palette);
    const ratio = contrast(opaqueChannels(palette.get(fgName)), painted);
    assert.ok(ratio >= TEXT_CONTRAST,
      `${fixture} --${fgName} ${palette.get(fgName)} on --${bgName} ${palette.get(bgName)} (painted ${painted.join(", ")}): ${ratio.toFixed(2)}:1 < 4.5:1`);
  }
  for (const [graphic, bgName] of GRAPHIC_PAIRS) {
    const ratio = contrast(opaqueChannels(palette.get(graphic)), backgroundChannels(bgName, palette));
    assert.ok(ratio >= GRAPHIC_CONTRAST, `${fixture} --${graphic} ${palette.get(graphic)} on --${bgName}: ${ratio.toFixed(2)}:1 < 3:1`);
  }
  // The focus edge (control rule 2) is the accent on the surfaces around a control.
  for (const bgName of ["bg", "surface", "surface-2", "term-bg", "sel"]) {
    assert.ok(contrast(opaqueChannels(palette.get("accent")), backgroundChannels(bgName, palette)) >= GRAPHIC_CONTRAST, `${fixture} accent edge on --${bgName}`);
  }
  // Passed through unchanged: the 16 terminal colours in Omarchy's mapping, and the surfaces that define the theme.
  assert.deepEqual(ansi.map(token => overrides[`--${token}`]), state.colors.ansi);
  assert.equal(overrides["--ansi-black"], state.colors.background, "slot 0 is the background, as in the host's own terminal");
  assert.equal(overrides["--term-bg"], state.colors.background);
  assert.equal(overrides["--surface"], state.colors.background);
  assert.equal(overrides["--bg"], state.colors.canvas);
  // The host's selection is moved until it holds 3:1 on the terminal (#672): Omarchy's are about 1.3:1.
  if (contrast(opaqueChannels(state.colors.selection), opaqueChannels(state.colors.background)) >= GRAPHIC_CONTRAST) assert.equal(overrides["--term-sel"], state.colors.selection);
  else assert.notEqual(overrides["--term-sel"], state.colors.selection, "moved");
  assert.equal(overrides["--live"], overrides["--accent"]); assert.equal(overrides["--graph-edge-coord"], overrides["--accent"]);
  // Everything derived is in the inventory (as a foreground or a surface), or is one of the named decorative tokens.
  const inventoried = new Set([...pairs, ...GRAPHIC_PAIRS].flat());
  for (const property of Object.keys(overrides)) {
    const token = property.slice(2);
    assert.ok(inventoried.has(token) || HOST_DECORATIVE.includes(token), `${property} must join the contrast inventory`);
  }
  // Everything else stays the calibrated base theme's.
  for (const token of ["accent-fg", "md-code-bg", "md-rule", ...soulTones.flatMap(tone => [`soul-${tone}-bg`, `soul-${tone}-fg`]), ...runtimes.flatMap(name => [`runtime-${name}-bg`, `runtime-${name}-fg`])]) {
    assert.equal(`--${token}` in overrides, false, `--${token} is not imported`);
  }
});

test("This computer: a low-contrast host accent is moved until it passes (Rosé Pine); one that passes is left alone", () => {
  const state = hostState("rose-pine");
  const onBackground = hex => contrast(opaqueChannels(hex), opaqueChannels(state.colors.background));
  assert.ok(onBackground(state.colors.accent) < TEXT_CONTRAST, "the stock accent is under 4.5:1 on its own background");
  const overrides = deriveHostTokens(state.colors, state.mode, token => light.get(token));
  assert.notEqual(overrides["--accent"], state.colors.accent);
  assert.ok(onBackground(overrides["--accent"]) >= TEXT_CONTRAST);
  assert.ok(luminance(opaqueChannels(overrides["--accent"])) < luminance(opaqueChannels(state.colors.accent)), "darkened: away from a light surface");
  // A colour that already holds on every surface it is paired with is the host's own.
  const white = { ...state.colors, foreground: "#000000" };
  assert.equal(deriveHostTokens(white, "light", token => light.get(token))["--fg"], "#000000");
});

// A colour that is both text and a graphic is held to both at once: --danger's words at 4.5:1 on their surfaces, and the
// problem dots at 3:1 on --sel (2026-10-26). A grey host whose selection is light enough that the red held for text
// still sits under 3:1 on it: the derivation moves the red until both hold, without dropping either.
test("This computer: --danger holds its text pairs and its graphic pair on --sel together, on a palette where text alone would not", () => {
  const colors = { ...hostState("tokyo-night").colors, background: "#202020", canvas: "#202020", foreground: "#aaaaaa", brightForeground: "#ffffff", accent: "#ffffff" };
  colors.ansi = [...colors.ansi]; colors.ansi[1] = "#cc0000";
  const overrides = deriveHostTokens(colors, "dark", token => dark.get(token));
  assert.ok(overrides, "the palette is accepted");
  const on = (fg, bg) => contrast(opaqueChannels(overrides[`--${fg}`]), opaqueChannels(overrides[`--${bg}`]));
  for (const [fg, bg] of pairs.filter(([fg]) => fg === "danger")) if (overrides[`--${bg}`]) assert.ok(on(fg, bg) >= TEXT_CONTRAST, `--danger on --${bg}: ${on(fg, bg).toFixed(2)}:1`);
  assert.ok(on("danger", "sel") >= GRAPHIC_CONTRAST, `--danger on --sel: ${on("danger", "sel").toFixed(2)}:1`);
  // A text pair alone would have stopped short: the red that holds 4.5:1 on the surfaces is under 3:1 on --sel.
  const textOnly = ["surface", "surface-2", "bg"].map(bg => opaqueChannels(overrides[`--${bg}`]));
  let red = colors.ansi[1];
  for (let step = 1; textOnly.some(bg => contrast(opaqueChannels(red), bg) < TEXT_CONTRAST) && step <= 50; step++) red = mixHex(colors.ansi[1], "#ffffff", step / 50);
  assert.ok(contrast(opaqueChannels(red), opaqueChannels(overrides["--sel"])) < GRAPHIC_CONTRAST, "the case the graphic pair exists for");
});

test("This computer: a palette that cannot be made to pass, or is not a palette, derives nothing at all", () => {
  const impossible = hostState("impossible");
  assert.equal(deriveHostTokens(impossible.colors, impossible.mode, token => dark.get(token)), null, "no text colour can hold on both of its surfaces");
  const good = hostState("tokyo-night");
  const base = token => dark.get(token);
  assert.ok(deriveHostTokens(good.colors, good.mode, base));
  assert.equal(deriveHostTokens(good.colors, "blue", base), null, "an unknown mode");
  assert.equal(deriveHostTokens({ ...good.colors, background: "#1A1B26" }, "dark", base), null, "upper-case hex is not what main sends");
  assert.equal(deriveHostTokens({ ...good.colors, accent: "red" }, "dark", base), null);
  assert.equal(deriveHostTokens({ ...good.colors, ansi: good.colors.ansi.slice(0, 15) }, "dark", base), null, "15 terminal colours");
  assert.equal(deriveHostTokens({ ...good.colors, ansi: [...good.colors.ansi.slice(0, 15), "#12345"] }, "dark", base), null);
  assert.equal(deriveHostTokens(null, "dark", base), null);
  assert.equal(deriveHostTokens(good.colors, good.mode, () => undefined), null, "without the base theme's code surface the text on it cannot be held");
});

// Color fixtures are local: no external reference paths, renderer startup or
// installed theme is needed to detect drift from the approved visual port.
test("White uses neutral surfaces, ink primaries and AA-safe orange distinct from errors", () => {
  const expected = {
    bg: "#f4f4f1", surface: "#ffffff", "surface-2": "#f8f8f6", border: "#e3e3df",
    fg: "#1a1a18", muted: "#5f5f5a", faint: "#686862", accent: "#ad5500", sel: "#fff0df", "nav-fg": "#50504b",
    "primary-bg": "#1a1a18", "primary-fg": "#ffffff", "term-bg": "#ffffff", "term-fg": "#1a1a18",
  };
  for (const [key, value] of Object.entries(expected)) assert.equal(light.get(key), value, key);
  const onSelection = hex => contrast(opaqueChannels(hex), backgroundChannels("sel", light));
  assert.ok(onSelection("#b35400") < 4.5, "a brighter orange needs darkening for small text on selection");
  assert.ok(onSelection(light.get("accent")) >= 4.5);
  assert.ok(onSelection("#9a9a95") < 4.5, "faint export ink must not be restored");
  assert.notEqual(light.get("accent"), light.get("ok"), "running/selection is not success green");
  assert.equal(light.get("danger"), "#b52f35");
  assert.equal(light.get("ok"), "#267548");
  // A drag's selection is a UI state (#672): the faint --sel tint (1.12:1 on the white terminal) hid it.
  assert.equal(light.get("term-sel"), "#6394d4"); assert.equal(light.get("term-sel-fg"), "#1a1a18");
  assert.equal(light.get("graph-edge-coord"), light.get("accent"));
});

test("dark color palette is preserved; primary is an existing opaque ink/surface pair", () => {
  const expected = {
    bg: "#0e1116", surface: "#161b22", "surface-2": "#1c2129", border: "#2d333c",
    fg: "#e6edf3", muted: "#9aa4b2", faint: "#8b949e", accent: "#4493f8", "accent-fg": "#ffffff",
    violet: "#c297ff", ok: "#3fb950", warn: "#d29922", danger: "#f85149",
    "chip-bg": "#21262e", "chip-fg": "#adb6c2", sel: "#1b2b40",
    "term-bg": "#0a0d12", "term-fg": "#e6edf3", "term-sel": "#2f6496", "term-sel-fg": "#f5f9ff",
    "md-code-bg": "#ffffff10", "md-rule": "#ffffff2e", "graph-edge": "#636c79", "graph-edge-coord": "#4493f8",
  };
  for (const [key, value] of Object.entries(expected)) assert.equal(dark.get(key), value, key);
  assert.deepEqual(ansi.map(key => dark.get(key)), [
    "#768390", "#ff7b72", "#4ac26b", "#d9a032", "#6cb2ff", "#c297ff", "#4ed1db", "#c3ccd6",
    "#8b949e", "#ffa198", "#63e084", "#edbb4a", "#8cc5ff", "#d5b3ff", "#70e0e8", "#f5f9ff",
  ]);
  assert.equal(dark.get("primary-bg"), dark.get("fg"));
  assert.equal(dark.get("primary-fg"), dark.get("bg"));
});


test("Solarized retains every prior Light semantic and ANSI color from b280ce1b", () => {
  const expected = {
    bg: "#f3eddd", surface: "#fdf6e3", "surface-2": "#f0e9d2", border: "#ddd4bc",
    fg: "#37424a", muted: "#56676d", faint: "#55666b", accent: "#155f96", "accent-fg": "#ffffff",
    violet: "#7f3f98", ok: "#465f00", warn: "#725500", danger: "#b52f35",
    "chip-bg": "#ede5cc", "chip-fg": "#56676d", sel: "#dce7e8",
    "term-bg": "#fdf6e3", "term-fg": "#52666c", "term-sel": "#586e75", "term-sel-fg": "#fdf6e3",
    "md-code-bg": "#58637510", "md-rule": "#5863752e", "graph-edge": "#8e846f", "graph-edge-coord": "#1f6fb2",
  };
  for (const [key, value] of Object.entries(expected)) assert.equal(solarized.get(key), value, key);
  assert.deepEqual(ansi.map(key => solarized.get(key)), [
    "#55666b", "#b52f35", "#465f00", "#725500", "#155d91", "#9d2b61", "#0f6863", "#56676d",
    "#56676d", "#a43a14", "#4f6f00", "#725500", "#155f96", "#9d2b61", "#0f6863", "#37424a",
  ]);
});

test("nav ink is subtly darker than muted; identity palettes are opaque and distinct", () => {
  for (const [name, palette] of palettes) {
    const nav = luminance(opaqueChannels(palette.get("nav-fg")));
    const muted = luminance(opaqueChannels(palette.get("muted")));
    assert.ok(nav < muted && nav > muted * 0.6, `${name} nav subtly darkens muted`);
    assert.equal(new Set(soulTones.map(tone => palette.get(`soul-${tone}-bg`))).size, 6);
    for (const tone of soulTones) {
      const bg = luminance(opaqueChannels(palette.get(`soul-${tone}-bg`)));
      const fg = luminance(opaqueChannels(palette.get(`soul-${tone}-fg`)));
      assert.ok(name === "dark" ? fg > bg : bg > fg, `${name} ${tone} uses same-family readable ink`);
    }
  }
});


// The Souls view's actual stylesheet: its `const CSS` template, with the shared group heading it
// interpolates (group-heading.mjs) substituted as the app does, so no literal `${...}` reaches the CSSOM.
function spawnViewCSS() {
  const source = readFileSync(new URL("views/spawn.mjs", renderer), "utf8").match(/const CSS = `([\s\S]*?)`;/)?.[1];
  assert.ok(source, "views/spawn.mjs has its const CSS template");
  const parts = { groupHeadingCSS };
  return source.replace(/\$\{(\w+)\}/g, (_, n) => parts[n] ?? assert.fail(`spawn.mjs CSS interpolates unknown \${${n}}`));
}

// Real marker constructors in representative shipped containers, with shell and
// view rules loaded AFTER theme.css just like the app. JSDOM preserves var()
// values: resolve the winning declaration through the actual root CSSOM, not
// a hand-picked expected palette, before measuring contrast. No browser launch.
for (const [name] of palettes) test(`${name}: actual identity/runtime markup wins the cascade and meets AA`, t => {
  const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><head></head><body>
    <div id="app"><aside id="sidebar"><button class="ctx-inst active"></button><button class="ctx-inst idle"></button></aside>
      <div class="oats-view"><button class="soul-card"><span class="sname"></span></button>
        <button class="act primary"><span class="inspector-marks"></span></button></div></div>
  </body></html>`);
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const spawnCSS = spawnViewCSS();
  assert.ok(spawnCSS, "exercise actual late-mounted soul card/glyph rules");
  for (const source of [css, readFileSync(new URL("shell.css", renderer), "utf8"), spawnCSS, identityCSS]) {
    const style = document.createElement("style"); style.textContent = source; document.head.append(style);
  }
  const root = dom.window.getComputedStyle(document.documentElement);
  function check(mark, prefix) {
    const style = dom.window.getComputedStyle(mark);
    const fg = `var(--${prefix}-fg)`, bg = `var(--${prefix}-bg)`;
    assert.equal(style.color, fg, `${name} ${mark.outerHTML} foreground is not overridden`);
    assert.equal(style.background, bg, `${name} ${mark.outerHTML} background is not overridden`);
    const ratio = contrast(opaqueChannels(root.getPropertyValue(`--${prefix}-fg`).trim()),
      opaqueChannels(root.getPropertyValue(`--${prefix}-bg`).trim()));
    assert.ok(ratio >= 4.5, `${name} ${prefix} actual marked pair ${ratio.toFixed(2)}:1`);
    assert.equal(style.opacity, "1", "no text opacity composition");
    if (mark.classList.contains("runtime-badge")) checkMark(mark);
  }
  // A known harness's mark (WCAG 1.4.11: >= 3:1, held here at the pair's 4.5:1) is painted only with
  // currentColor, so its effective colour IS the badge's measured foreground: no loaded rule may
  // repaint, fade or blend the <svg> or its paths, and the <svg> inherits the badge's color.
  const markProps = ["color", "fill", "stroke", "opacity", "fill-opacity", "stroke-opacity", "filter", "mix-blend-mode"];
  const rules = [...document.styleSheets].flatMap(sheet => [...sheet.cssRules]).filter(rule => rule.selectorText);
  function checkMark(badge) {
    const svg = badge.querySelector(":scope > svg");
    if (!badge.dataset.runtime) { assert.equal(svg, null, "an unknown harness is the '?' text"); return; }
    assert.ok(svg, `${name} ${badge.dataset.runtime} draws its mark`);
    assert.equal(dom.window.getComputedStyle(svg).color, dom.window.getComputedStyle(badge).color, "the mark inherits the badge colour");
    for (const el of [svg, ...svg.querySelectorAll("*")]) {
      for (const attr of ["fill", "stroke"]) if (el.hasAttribute(attr)) assert.match(el.getAttribute(attr), /^(currentColor|none)$/);
      for (const rule of rules) if (el.matches(rule.selectorText)) for (const prop of markProps) {
        assert.equal(rule.style.getPropertyValue(prop), "", `${name}: "${rule.selectorText}" sets ${prop} on a harness mark`);
      }
    }
    assert.ok(svg.getAttribute("fill") === "currentColor" || svg.getAttribute("stroke") === "currentColor");
  }
  for (const selector of [".ctx-inst", ".soul-card .sname", ".inspector-marks"]) {
    const container = document.querySelector(selector);
    for (const color of soulTones) {
      const mark = createSoulMark(document, { name: "Fixture soul", agentsRoot: "/fixture/agents", color });
      mark.classList.add("glyph"); container.append(mark);
      assert.equal(mark.dataset.avatarColor, color);
      check(mark, `soul-${color}`);
    }
    for (const runtime of runtimes) {
      const badge = createRuntimeBadge(document, runtime); badge.classList.add("sruntime", "ctx-runtime");
      container.append(badge); check(badge, `runtime-${runtime}`);
    }
    const hostile = createRuntimeBadge(document, "red; background:url(https://fixture.invalid)");
    container.append(hostile); check(hostile, "runtime-unknown");
    assert.equal(hostile.getAttribute("style"), null);
    const invalid = document.createElement("span"); invalid.dataset.avatarColor = "red; background:url(x)";
    container.append(invalid); check(invalid, "chip");
  }
  // A stopped instance's provider mark dims: whatever pair the shell paints it
  // with must be one the inventory lists, so every theme (and a host palette)
  // holds it at AA. (An unreported harness is not dimmed: it keeps its own pair.)
  const token = value => value.match(/^var\(--([a-z0-9-]+)\)$/)?.[1];
  for (const runtime of runtimes) {
    const stopped = createRuntimeBadge(document, runtime); stopped.classList.add("ctx-runtime");
    document.querySelector(".ctx-inst.idle").append(stopped);
    const style = dom.window.getComputedStyle(stopped), fg = token(style.color), bg = token(style.background);
    assert.ok(pairs.some(pair => pair[0] === fg && pair[1] === bg),
      `${name} stopped ${runtime} mark: ${style.color} on ${style.background} is not a pair in the contrast inventory`);
    check(stopped, fg.replace(/-fg$/, ""));
  }
});

for (const [name] of palettes) test(`${name}: workspace catalog, sources and sync text use AA tokens on their computed surfaces`, t => {
  const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><body><main class="oats-view"><header class="workspace-header"><div class="ws-sync"><span class="ws-sync-state warn">Lock out of date</span></div></header><p class="catalog-note warn">note</p><p class="catalog-note">a note</p><div class="filters"></div><div class="caps"></div><div class="sections"></div><div class="sources"></div><div class="graph"></div></main></body></html>`);
  const doc = dom.window.document;
  for (const source of [css, identityCSS, discoveryCSS]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
  t.after(() => dom.window.close());
  // Kernel captures (F2): the catalog paints locked/confirmed chips; a later
  // sync's members carry an unconfirmed (warn) row with its detail.
  const f2 = file => JSON.parse(readFileSync(new URL(`fixtures/workspace-v2/f2/${file}.json`, new URL("./", import.meta.url)), "utf8"));
  const dir = '/fixture/base/northwind-workspace';
  const status = { ...workspaceStatusData(f2('workspace-status'), dir), members: syncData(f2('sync-moved'), dir).members };
  // Kernel #217: rows carry a description (rendered as a muted line under the name).
  const rows = f2('capabilities').result.capabilities.map(r => ({ ...r, description: `About ${r.name}.` }));
  const names = memberNames(status);
  // Workspace owned's repository pills: one pressed (the first repository), the rest not, and the shown count.
  const repos = repoChoices(rows, names, hostKeyOf(status));
  renderRepoPills(doc.querySelector('.filters'), { repos, value: repos[0].key, total: rows.length, shown: repos[0].count, narrowed: true, onChange() {} });
  renderCapabilities(doc.querySelector('.caps'), { rows, status, instances: [], root: dir });
  // The boxed source chip left the list (its group heading names the source); a soul's capability tables and the
  // capability page still draw it with this sheet.
  doc.querySelector('.caps').append(sourceChip(doc, rows[0], names, { boxed: true }));
  // F7 (kernel #185): the three sections, with a repo-owned (private) row.
  const sections = capabilitySections(JSON.parse(readFileSync(new URL('fixtures/workspace-v2/f7/capabilities.json', new URL('./', import.meta.url)), 'utf8')).result.capabilities);
  renderCapabilitySections(doc.querySelector('.sections'), { sections, shown: sections.workspace, filterHost: null, privateListed: true, status, instances: [], root: dir });
  // Kernel #217 desktop facts: a hosted workspace file, clones (one here, one refused, the rest not cloned), the lock file.
  const unconfirmed = status.members.find(m => m.status !== 'confirmed');
  const facts = { ...status, workspace: { ...status.workspace, file: { path: 'oats-workspace.yaml', url: 'https://github.com/northwind/agents/blob/a/oats-workspace.yaml' } },
    clones: status.members.map((m, i) => m.key === unconfirmed.key ? { key: m.key, name: m.name, path: null, rule: null, problem: { code: 'E_CLONE_MISMATCH', message: 'not a clone of this member' } }
      : { key: m.key, name: m.name, path: i ? null : `${dir}/${m.name}`, rule: i ? null : 'convention' }),
    disabledSouls: ['campaign-writer'], lock: { path: `${dir}/oats-lock.json`, lockfileVersion: 3 },
    defaults: { slots: { knowledge: { name: 'oats.okf', from: 'package' }, messaging: 'none', tasks: null }, capabilities: [{ name: 'house-style', from: 'here', off: false }],
      byTeam: Object.fromEntries((status.workspace.teams || []).map(label => [label, { capabilities: [{ name: 'deploy', from: 'package', off: false }, { name: 'house-style', from: null, off: true }] }])) } };
  // The list view also with a package not locked yet (the lock out of date, the Sync cell) and a newer catalog version.
  const listed = { ...facts, unsynced: ['x.pkg'], packages: facts.packages.map((p, i) => i ? p : { ...p, latest: { version: '9.9.9', ref: null } }) };
  renderSetup(doc.querySelector('.sources'), { status: listed, instances: [{ agent: 'a', running: true }], souls: [{ team: 'marketing' }], cli: { version: '0.26.0' }, openExternal() {} });
  // The Workspace's Teams tab (0.29 box; first tab since 2026-09-28), beside Setup.
  doc.querySelector('.sources').append(teamsBox(doc, { status: facts, souls: [{ team: 'marketing' }] }));
  renderSetup(doc.querySelector('.graph'), { status: { ...facts, unsynced: ['x.pkg'] }, view: 'graph', selected: unconfirmed.key, openExternal() {} });
  // The sync sheet's refusal text, as createWorkspaceSync builds it.
  const sheet = doc.createElement('section'); sheet.className = 'ws-sync-dialog';
  sheet.innerHTML = '<div class="ws-sync-body"><p class="ws-sync-lead error">x</p><p class="ws-sync-lead">x</p><button class="ws-sync-details">Details</button><p class="ws-sync-detail">x</p></div>';
  doc.querySelector('main').append(sheet);
  const root = dom.window.getComputedStyle(doc.documentElement);
  for (const [selector, painted, fg, bg] of [
    // Workspace v4.1: the column head sits on the page; each capability is a row card (surface) with its
    // name, one-line description and used-by words; the boxed source chip (soul tables, the page).
    ['.catalog-head', '.oats-view', 'muted', 'bg'],
    ['.catalog-name', 'button.catalog-row', 'fg', 'surface'],
    ['.catalog-desc', 'button.catalog-row', 'muted', 'surface'],
    ['.source-chip', '.source-chip.boxed', 'muted', 'surface'], ['.source-chip-name', '.source-chip.boxed', 'fg', 'surface'],
    ['.catalog-used-count.none', 'button.catalog-row', 'muted', 'surface'],
    // Repository pills (rule 1): unpressed --muted on --surface, pressed --accent on --sel (name and count), and the shown count.
    ['.catalog-pills button[aria-pressed=false]', '.catalog-pills button[aria-pressed=false]', 'muted', 'surface'],
    ['.catalog-pills button[aria-pressed=true]', '.catalog-pills button[aria-pressed=true]', 'accent', 'sel'],
    ['.catalog-shown', '.oats-view', 'muted', 'bg'],
    ['.catalog-note.warn', '.oats-view', 'warn', 'bg'], ['.catalog-note:not(.warn)', '.oats-view', 'muted', 'bg'],
    // Sections: the segmented jump (current = brand tint, rule 1), titles with their lead, repo headings.
    ['.capability-nav button[aria-current]', '.capability-nav button[aria-current]', 'accent', 'sel'],
    ['.capability-nav button:not([aria-current])', '.capability-nav', 'muted', 'surface'],
    ['.capability-section-title', '.oats-view', 'fg', 'bg'], ['.capability-section-lead', '.oats-view', 'muted', 'bg'],
    // A repository group's heading (the Souls tab's, group-heading.mjs): the name --fg, its qualifier --muted.
    ['.catalog-group .souls-group-name', '.oats-view', 'fg', 'bg'], ['.catalog-group .souls-group-note', '.oats-view', 'muted', 'bg'],
    // Workspace v4 Setup (W1/W2), the 2026-10-14 redesign: the lede and its summary on the page, the overview card
    // (the drawing's boxes on --surface-2), Shared through Git's boxes, the This computer zone (--surface-2).
    ['.setup-lede h2', '.oats-view', 'fg', 'bg'], ['.setup-summary', '.oats-view', 'muted', 'bg'],
    ['.setup-summary b:not(.warn)', '.oats-view', 'fg', 'bg'], ['.setup-summary b.warn', '.oats-view', 'warn', 'bg'],
    ['.setup-lede-where', '.oats-view', 'muted', 'bg'], ['.setup-lede-where span.mono', '.oats-view', 'fg', 'bg'],
    ['.setup-lede-where button.setup-file', '.oats-view', 'accent', 'bg'],
    ['.setup-explain h3', '.setup-explain', 'fg', 'surface'], ['.setup-explain-ov', '.setup-explain', 'fg', 'surface'],
    ['.setup-explain-dev > summary', '.setup-explain', 'muted', 'surface'], ['.setup-explain-body > p', '.setup-explain', 'fg', 'surface'],
    ['.setup-hs-role', '.setup-hs-repo', 'muted', 'surface-2'], ['.setup-hs-name', '.setup-hs-repo', 'fg', 'surface-2'],
    ['.setup-hs-line', '.setup-hs-repo', 'muted', 'surface-2'], ['.setup-hs-line span', '.setup-hs-repo', 'fg', 'surface-2'],
    ['.setup-hs-links', '.setup-explain', 'muted', 'surface'], ['.setup-hs-arrow .shell-icon', '.setup-explain', 'accent', 'surface'],
    ['.setup-explain-states .setup-state.warn', '.setup-explain-states .setup-state.warn', 'warn', 'attn-bg'], ['.setup-explain-states dd', '.setup-explain', 'muted', 'surface'],
    ['.setup-sec-title', '.oats-view', 'fg', 'bg'], ['.setup-sec-lead', '.oats-view', 'muted', 'bg'],
    ['.setup-box-head h4', '.setup-box', 'fg', 'surface'], ['.setup-box-head h3', '.setup-box', 'fg', 'surface'], ['.setup-box-lead', '.setup-box', 'muted', 'surface'],
    ['.setup-name-text', '.setup-box', 'fg', 'surface'], ['.setup-version', '.setup-box', 'muted', 'surface'],
    ['.setup-row .setup-state:not(.warn)', '.setup-box', 'muted', 'surface'], ['.setup-row .setup-state:not(.warn) .shell-icon', '.setup-box', 'ok', 'surface'],
    ['.setup-row .setup-state.warn', '.setup-row .setup-state.warn', 'warn', 'attn-bg'],
    ['.setup-sub', '.setup-box', 'muted', 'surface'], ['.setup-sub h5', '.setup-box', 'fg', 'surface'],
    ['.setup-cell:not(.muted)', '.setup-box', 'fg', 'surface'], ['.setup-cell.muted', '.setup-box', 'muted', 'surface'],
    ['.setup-end:not(.newer):not(.warn)', '.setup-box', 'muted', 'surface'], ['.setup-end.newer', '.setup-box', 'fg', 'surface'], ['.setup-end.warn', '.setup-box', 'warn', 'surface'],
    ['.setup-link-act', '.setup-box', 'accent', 'surface'],
    ['.setup-team-label', '.setup-team-label', 'fg', 'tag-bg'], ['.setup-team-meta', '.setup-box', 'muted', 'surface'], ['.setup-team-note', '.setup-box', 'muted', 'surface'],
    ['.setup-zone .setup-sec-title', '.setup-zone', 'fg', 'surface-2'], ['.setup-zone .setup-sec-lead', '.setup-zone', 'muted', 'surface-2'],
    ['.setup-fact dt', '.setup-zone', 'muted', 'surface-2'], ['.setup-fact dd.mono', '.setup-zone', 'fg', 'surface-2'],
    ['.setup-fact dd.prim:not(.warn)', '.setup-zone', 'fg', 'surface-2'], ['.setup-fact dd.warn', '.setup-zone', 'warn', 'surface-2'],
    ['.setup-here-clones > h4', '.setup-zone', 'fg', 'surface-2'], ['.setup-clone dt', '.setup-zone', 'muted', 'surface-2'],
    ['.setup-clone dd:not(.warn):not(.muted)', '.setup-zone', 'fg', 'surface-2'], ['.setup-clone dd.warn', '.setup-zone', 'warn', 'surface-2'], ['.setup-clone dd.muted', '.setup-zone', 'muted', 'surface-2'],
    ['.setup-def dt', '.setup-box', 'muted', 'surface'], ['.setup-def dd.muted', '.setup-box', 'muted', 'surface'],
    ['.setup-def-cap:not(.off) .setup-def-name', '.setup-box', 'fg', 'surface'], ['.setup-def-from', '.setup-box', 'muted', 'surface'],
    ['.setup-team-adds', '.setup-box', 'muted', 'surface'], ['.setup-def-cap.off .setup-def-name', '.setup-box', 'muted', 'surface'],
    ['.setup-caption', '.setup-here', 'muted', 'surface-2'], ['.setup-card-title', '.setup-computer', 'fg', 'surface'], ['.setup-card-meta', '.setup-computer', 'muted', 'surface'],
    ['.setup-ws .setup-card-meta', '.setup-ws', 'fg', 'sel'],
    ['.setup-lock.warn', '.oats-view', 'warn', 'bg'],
    ['.setup-tree-label', '.setup-shared', 'muted', 'surface'],
    ['.setup-node:not(.bad) .setup-node-name', '.setup-node:not(.bad)', 'fg', 'surface'], ['.setup-node:not(.bad) .setup-node-meta', '.setup-node:not(.bad)', 'muted', 'surface'],
    ['.setup-node.bad .setup-node-name', '.setup-node.bad', 'fg', 'attn-bg'], ['.setup-node.bad .setup-node-meta', '.setup-node.bad', 'warn', 'attn-bg'],
    ['.setup-panel-name', '.setup-panel', 'fg', 'surface'], ['.setup-panel h4', '.setup-panel', 'muted', 'surface'],
    ['.setup-hand-title', '.setup-panel', 'fg', 'surface'], ['.setup-hand-sub', '.setup-panel', 'muted', 'surface'], ['.setup-hand-mark.warn', '.setup-panel', 'warn', 'surface'],
    ['.setup-panel p:not(.muted):not(.warn)', '.setup-panel', 'fg', 'surface'], ['.setup-panel p.warn', '.setup-panel', 'warn', 'surface'], ['.setup-panel p.muted', '.setup-panel', 'muted', 'surface'],
    ['.setup-detail', '.setup-detail', 'fg', 'surface-2'],
    // The host's row carries Host and its file (a link on --sel when the file has a web address).
    ['.setup-row .setup-badge.host', '.setup-row .setup-badge.host', 'accent', 'sel'], ['.setup-row .setup-badge.host button.setup-file', '.setup-row .setup-badge.host', 'accent', 'sel'],
    ['.ws-sync-state.warn', '.workspace-header', 'warn', 'surface'],
    ['.ws-sync-lead.error', '.ws-sync-dialog', 'danger', 'surface'], ['.ws-sync-lead:not(.error)', '.ws-sync-dialog', 'fg', 'surface'],
    ['.ws-sync-details', '.ws-sync-dialog', 'muted', 'surface'], ['.ws-sync-detail', '.ws-sync-detail', 'muted', 'surface-2'],
  ]) {
    const el = doc.querySelector(selector), surface = doc.querySelector(painted);
    assert.ok(el && surface, selector);
    assert.equal(dom.window.getComputedStyle(el).color, `var(--${fg})`, selector);
    assert.equal(dom.window.getComputedStyle(surface).background, `var(--${bg})`, painted);
    assert.ok(contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim())) >= 4.5, `${selector} on ${bg}`);
    for (let parent = el; parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, '1');
  }
  // A keyboard-focused pill takes the shell's tint (its own rule out-ranks the global one): its --muted
  // (unpressed) and --accent (pressed) ink on --sel are inventoried pairs and meet AA here.
  // (jsdom does not resolve the pill's :focus-visible here: the declared rule is read.)
  assert.ok([...doc.styleSheets].flatMap(sheet => [...sheet.cssRules]).some(rule => rule.selectorText === '.oats-view .catalog-pills button:focus-visible' && rule.style.background === 'var(--sel)'), 'the pill focus tint rule');
  for (const fg of ['muted', 'accent']) {
    assert.ok(pairs.some(([f, b]) => f === fg && b === 'sel'), `--${fg} on --sel is inventoried`);
    assert.ok(contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue('--sel').trim())) >= 4.5, `focused pill: --${fg} on --sel`);
  }
});

// Workspace › Capabilities' Workspace defaults panel (filled and empty core slots, additional defaults from a package
// and a member repository, one the workspace turned off) and the "About capabilities" dialog in the lifecycle frame: every text on its computed surface.
for (const [name] of palettes) test(`${name}: Workspace defaults and the About dialog use AA tokens on their computed surfaces`, t => {
  const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><body><main class="oats-view"><div class="sections"></div><div class="tools"></div></main></body></html>`, { pretendToBeVisual: true });
  const doc = dom.window.document;
  for (const source of [css, identityCSS, discoveryCSS, lifecycleCSS]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
  t.after(() => dom.window.close());
  const rows = [{ name: 'oats.okf', kind: 'package', package: 'oats.okf', version: '2.1.3', layer: 'knowledge' }, { name: 'oats.core', kind: 'package', package: 'oats.core', version: '1.0.0' },
    { name: 'house-style', kind: 'member', repoKey: 'github.com/nw/agents' }];
  const status = { workspace: { key: 'github.com/nw/agents', name: 'northwind' }, members: [],
    defaults: { slots: { knowledge: { name: 'oats.okf', from: 'package' }, messaging: 'none', tasks: null },
      capabilities: [{ name: 'oats.core', from: 'package', off: false }, { name: 'house-style', from: 'here', off: false }, { name: 'old-style', from: null, off: true }] } };
  const sections = capabilitySections(rows);
  renderCapabilitySections(doc.querySelector('.sections'), { sections, shown: sections.workspace, filterHost: null, privateListed: false, status, instances: [], onOpen() {} });
  const about = createAboutDialog(doc, { copy: ABOUT_COPY.capabilities, id: 'about' });
  doc.querySelector('.tools').append(about.button); about.open();
  const root = dom.window.getComputedStyle(doc.documentElement);
  for (const [selector, painted, fg, bg] of [
    ['.ws-defaults-scope', '.ws-defaults-panel', 'fg', 'surface'], ['.ws-defaults-sub', '.ws-defaults-panel', 'muted', 'surface'],
    // The two groups' headings and leads, the one cell's words, its chip and tiles (core tints, an empty slot and a
    // package neutral, a member capability clay), an additional default turned off.
    ['.ws-defaults-group-head', '.ws-defaults-panel', 'fg', 'surface'], ['.ws-defaults-group-lead', '.ws-defaults-panel', 'muted', 'surface'],
    ['button.ws-default-cell .ws-default-label', 'button.ws-default-cell', 'muted', 'surface'],
    ['button.ws-default-cell .ws-default-name', 'button.ws-default-cell', 'fg', 'surface'],
    ['button.ws-default-cell .source-chip', 'button.ws-default-cell', 'muted', 'surface'], ['button.ws-default-cell .source-chip-name', 'button.ws-default-cell', 'fg', 'surface'],
    ['div.ws-default-cell .ws-default-none', 'div.ws-default-cell', 'muted', 'surface'], ['div.ws-default-cell .ws-default-note', 'div.ws-default-cell', 'muted', 'surface'],
    ['.ws-default-tile[data-tint=slate]', '.ws-default-tile[data-tint=slate]', 'soul-slate-fg', 'soul-slate-bg'],
    ['.ws-default-tile[data-tint=clay]', '.ws-default-tile[data-tint=clay]', 'soul-clay-fg', 'soul-clay-bg'],
    ['.ws-default-tile:not([data-tint])', '.ws-default-tile:not([data-tint])', 'chip-fg', 'chip-bg'],
    ['.ws-default-cell.off .ws-default-name', '.ws-default-cell.off', 'muted', 'surface'], ['.ws-default-cell.off .ws-default-note', '.ws-default-cell.off', 'muted', 'surface'],
    ['.ws-info-button', '.ws-info-button', 'muted', 'surface'],
    ['.about-dialog h2', '.about-dialog', 'fg', 'surface'], ['.about-dialog > p', '.about-dialog', 'fg', 'surface'],
    ['.about-dialog .lifecycle-mark', '.about-dialog .lifecycle-mark', 'accent', 'surface-2'],
    ['.about-terms dt', '.about-terms', 'fg', 'surface-2'], ['.about-terms dd', '.about-terms', 'muted', 'surface-2'],
  ]) {
    const el = doc.querySelector(selector), surface = doc.querySelector(painted);
    assert.ok(el && surface, selector);
    assert.equal(dom.window.getComputedStyle(el).color, `var(--${fg})`, selector);
    assert.equal(dom.window.getComputedStyle(surface).background, `var(--${bg})`, painted);
    assert.ok(pairs.some(pair => pair[0] === fg && pair[1] === bg) || GRAPHIC_PAIRS.some(pair => pair[0] === fg && pair[1] === bg), `--${fg} on --${bg} is inventoried`);
    assert.ok(contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim())) >= 4.5, `${selector} on ${bg}`);
    for (let parent = el; parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, '1');
  }
  about.dispose();
});

// Schedules + Triggers (§2.3a): the list (header, toolbar, groups, rows, tags), the host
// banner and the detail page, rendered from the captured kernel output (automations/kernel).
for (const [name] of palettes) test(`${name}: Schedules and Triggers text uses AA tokens on its computed surfaces`, async t => {
  const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><body><div class="a"></div><div class="b"></div><div class="c"></div></body></html>`);
  const doc = dom.window.document;
  const style = doc.createElement('style'); style.textContent = css; doc.head.append(style);
  t.after(() => dom.window.close());
  const auto = file => JSON.parse(readFileSync(new URL(`fixtures/automations/kernel/${file}.json`, new URL('./', import.meta.url)), 'utf8')).result;
  const now = () => Date.parse('2026-09-26T15:20:00.000Z');
  // One definition made invalid, for the attention tag (the capture has none).
  const schedules = auto('schedule-list'); schedules.schedules[1].invalid = { code: 'E_AUTOMATION_SCHEMA', message: 'cron: expected 5 fields', field: 'cron' };
  const unnamed = auto('trigger-list-disabled'); unnamed.host = { name: null };
  for (const r of unnamed.triggers) if (r.origin.kind === 'workspace') { r.runsHere = false; r.reason = 'host-unnamed'; }
  unnamed.triggers[0].enabledHere = false;
  createAutomationsView(doc.querySelector('.a'), { kind: 'schedule', read: async () => schedules, act: async () => ({ ok: true }), now });
  createAutomationsView(doc.querySelector('.b'), { kind: 'trigger', read: async () => unnamed, now });
  const page = createAutomationsView(doc.querySelector('.c'), { kind: 'trigger', read: async () => auto('trigger-list'), act: async () => auto('trigger-test-mismatch'), now });
  await new Promise(r => setTimeout(r, 0));
  page.open('agents/triage'); doc.querySelector('.c .page-bar-actions button[data-verb=test]').click();
  await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
  const root = dom.window.getComputedStyle(doc.documentElement);
  for (const [selector, painted, fg, bg] of [
    ['.a .auto-header h2', '.a .auto-header', 'fg', 'surface'], ['.a .auto-count', '.a .auto-header', 'muted', 'surface'], ['.a .auto-scheduler', '.a .auto-header', 'muted', 'surface'],
    ['.a .auto-seg button[aria-pressed=true]', '.a .auto-seg button[aria-pressed=true]', 'fg', 'surface-2'], ['.a .auto-seg button[aria-pressed=false]', '.a .auto-seg', 'muted', 'surface'],
    ['.a .auto-group-title:not(.warn)', '.a .automations', 'fg', 'bg'], ['.a .auto-group-title.warn', '.a .automations', 'warn', 'bg'], ['.a .auto-group-note', '.a .automations', 'muted', 'bg'],
    ['.a .auto-row.head', '.a .auto-table', 'muted', 'surface'], ['.a .auto-row:not(.off) .auto-id', '.a .auto-table', 'fg', 'surface'], ['.a .auto-sub', '.a .auto-table', 'muted', 'surface'],
    ['.a .auto-tag:not(.muted):not(.warn)', '.a .auto-tag:not(.muted):not(.warn)', 'fg', 'tag-bg'], ['.a .auto-tag.warn', '.a .auto-tag.warn', 'fg', 'attn-bg'],
    ['.a .auto-none', '.a .auto-table', 'muted', 'surface'], ['.a .auto-foot', '.a .automations', 'muted', 'bg'],
    ['.b .auto-banner', '.b .auto-banner', 'fg', 'attn-bg'], ['.b .auto-row.off .auto-id', '.b .auto-table', 'muted', 'surface'], ['.b .auto-tag.muted', '.b .auto-table', 'muted', 'surface'],
    ['.c .auto-prompt', '.c .auto-prompt', 'fg', 'surface'], ['.c .auto-token', '.c .auto-token', 'fg', 'chip-bg'],
    ['.c .auto-verdict.warn', '.c .page-card', 'warn', 'surface'], ['.c .auto-test-line.warn', '.c .page-card', 'warn', 'surface'],
  ]) {
    const el = doc.querySelector(selector), surface = doc.querySelector(painted);
    assert.ok(el && surface, selector);
    assert.equal(dom.window.getComputedStyle(el).color, `var(--${fg})`, selector);
    assert.equal(dom.window.getComputedStyle(surface).background, `var(--${bg})`, painted);
    assert.ok(contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim())) >= 4.5, `${selector} on ${bg}`);
    for (let parent = el; parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, '1');
  }
});

// Automation summaries (feature automation-descriptions): the derived summary line, the detail's
// qualified id, a command's argv chips, the reconcile command and the Edit summary sheet, rendered
// from the captured kernel output (automation-descriptions).
for (const [name] of palettes) test(`${name}: automation summaries, argv, run state and the Edit summary sheet use AA tokens`, async t => {
  const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><body><div class="a"></div><div class="c"></div><div class="d"></div></body></html>`);
  const doc = dom.window.document;
  const style = doc.createElement('style'); style.textContent = css; doc.head.append(style);
  t.after(() => dom.window.close());
  const list = JSON.parse(readFileSync(new URL('fixtures/automation-descriptions/schedule-list.json', new URL('./', import.meta.url)), 'utf8')).result;
  const now = () => Date.parse('2026-10-06T10:00:00.000Z');
  createAutomationsView(doc.querySelector('.a'), { kind: 'schedule', read: async () => list, now });
  const command = createAutomationsView(doc.querySelector('.c'), { kind: 'schedule', read: async () => list, now });
  const wake = createAutomationsView(doc.querySelector('.d'), { kind: 'schedule', read: async () => list, now, describe: async () => ({}) });
  await new Promise(r => setTimeout(r, 0));
  command.open('local/status'); wake.open('local/standup'); wake.describe('local/standup');
  const root = dom.window.getComputedStyle(doc.documentElement);
  for (const [selector, painted, fg, bg] of [
    ['.a .auto-summary.derived', '.a .auto-table', 'muted', 'surface'], ['.a .auto-summary.auto-none', '.a .auto-table', 'muted', 'surface'],
    ['.c .auto-qid', '.c .automations', 'muted', 'bg'], ['.c .auto-argv li', '.c .auto-argv li', 'fg', 'chip-bg'],
    ['.d .auto-command', '.d .auto-command', 'fg', 'chip-bg'], ['.d .auto-verdict.warn', '.d .page-card', 'warn', 'surface'],
    ['.d .auto-describe h3', '.d .auto-describe', 'fg', 'surface'], ['.d .auto-describe .page-note', '.d .auto-describe', 'muted', 'surface'],
  ]) {
    const el = doc.querySelector(selector), surface = doc.querySelector(painted);
    assert.ok(el && surface, selector);
    assert.equal(dom.window.getComputedStyle(el).color, `var(--${fg})`, selector);
    assert.equal(dom.window.getComputedStyle(surface).background, `var(--${bg})`, painted);
    assert.ok(contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim())) >= 4.5, `${selector} on ${bg}`);
    for (let parent = el; parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, '1');
  }
});

// The sidebar's type and its lines (the product owner, 2026-10-26: as before 2026-10-23, the list of workspaces on top).
// The Workspace heading is --fg at 13.5px 700; the Instances heading reads like the nav items over it (--nav-fg, 13px
// 500); the machine labels step under them (muted 11px 650 capitals). The headings are text: AA on the sidebar (the
// computed test below reads them). The lines are decorative, like the sidebar's own right edge, and in that edge's
// token: one under the list, one before the instances, the foot's; none under the head and none under the Instances
// heading (the product owner, 2026-10-26). No minimum applies, and they show in every built-in theme at the edge's own ratio.
for (const [name, palette] of palettes) test(`${name}: the Workspace heading, the Instances heading (the nav's ink) over the machine labels; the sidebar's --border lines, as visible as its edge`, () => {
  const shellCss = readFileSync(new URL("shell.css", renderer), "utf8");
  const rule = selector => shellCss.match(new RegExp(`^${selector.replace(/[.#()>:]/g, m => `\\${m}`)} \\{([^}]*)\\}`, "m"))?.[1] ?? "";
  const heading = rule(".ws-heading"), head = rule(".ctx-head"), label = rule(".ctx-deployment");
  assert.match(heading, /color: var\(--fg\);/); assert.match(heading, /font-size: 13\.5px;/); assert.match(heading, /font-weight: 700;/);
  assert.match(head, /color: var\(--nav-fg\);/); assert.match(head, /font-size: 13px;/); assert.match(head, /font-weight: 500;/);
  assert.match(head, /height: 36px;/, "the heading row keeps its height");
  assert.match(label, /color: var\(--muted\);/); assert.match(label, /font-size: 11px;/); assert.match(label, /font-weight: 650;/);
  assert.match(label, /text-transform: uppercase;/);
  assert.equal(shellCss.match(/\.ws-current::before|\.ws-current\s*\{/), null, "no current workspace's section, no line of its own");
  assert.doesNotMatch(rule(".side-head"), /border(?:-bottom)?(?:-width|-style|-color)?\s*:/, "no line under the head: the heading sits over its list");
  assert.match(rule(".ws-list"), /border-bottom: 1\.5px solid var\(--border\);/, "under the list, before the views");
  assert.match(rule("#instance-roster"), /border-top: 1px solid var\(--border\);/, "before the instances");
  assert.equal(shellCss.match(/#instance-roster > \.ctx-head(?:::after|::before)?\s*\{/), null, "no line under the Instances heading");
  assert.match(rule("#nav-foot"), /border-top: 1px solid var\(--border\);/, "over the foot");
  assert.match(rule("#sidebar"), /border-right: 1px solid var\(--border\);/, "the sidebar's edge, the lines' token");
  const ratio = contrast(opaqueChannels(palette.get("border")), opaqueChannels(palette.get("surface")));
  assert.ok(ratio > 1.2, `${name}: the lines show on the sidebar (${ratio.toFixed(2)}:1)`);
  for (const ink of ["fg", "nav-fg"]) assert.ok(contrast(opaqueChannels(palette.get(ink)), opaqueChannels(palette.get("surface"))) >= 4.5, `${name}: the headings' --${ink}`);
});

// The sidebar's one visible shortcut hint was the roster filter's ⌘F; it went with the filter. The sidebar paints
// none (the product owner, 2026-10-26: Spawn instance's chord is in its tooltip), so no hint ink sits on a sidebar
// surface (the spawn dialog's hints are held in spawn-dialog.test.mjs).
for (const [name] of palettes) test(`${name}: the shipped sidebar paints no shortcut hint, and a hidden hint takes no box`, t => {
  const dom = new JSDOM(readFileSync(new URL("index.html", renderer), "utf8"));
  t.after(() => dom.window.close());
  const doc = dom.window.document; doc.documentElement.dataset.theme = name;
  for (const source of [css, readFileSync(new URL("shell.css", renderer), "utf8")]) {
    const style = doc.createElement("style"); style.textContent = source; doc.head.append(style);
  }
  assert.equal(doc.querySelector("#sidebar .shortcut-hint, #sidebar [data-shortcut], #sidebar kbd, .ctx-filter-field, .ctx-filter"), null,
    "no hint and no filter field in the sidebar");
  // Spawn instance (the bar's words alone) names itself in words; its chord is the tooltip's.
  const spawn = doc.getElementById("sidebar-spawn");
  assert.equal(spawn.getAttribute("title"), "Spawn instance"); assert.equal(spawn.getAttribute("data-action"), "app.quickOpenSouls");
  const hint = doc.createElement("kbd"); hint.className = "shortcut-hint"; hint.hidden = true; doc.body.append(hint);
  assert.equal(dom.window.getComputedStyle(hint).display, "none");
});

// The sidebar (the product owner, 2026-10-26): the nav (Workspace overview, Automations) sits under the list of
// workspaces on the sidebar's --surface (the foot holds the bar: the sidebar toggle, Spawn instance and the
// settings cog, below). Each one's ink, at rest, hovered, current
// and under the keyboard tint, is a token pair the inventory holds to AA (so "This computer" is held too,
// host-theme.mjs), and meets it here on the effective colours, with no opacity on it or under it.
for (const [name] of palettes) test(`${name}: the nav's items meet computed AA in every state`, t => {
  const dom = new JSDOM(readFileSync(new URL("index.html", renderer), "utf8"));
  t.after(() => dom.window.close());
  const doc = dom.window.document, win = dom.window; doc.documentElement.dataset.theme = name;
  const shellCss = readFileSync(new URL("shell.css", renderer), "utf8");
  for (const source of [css, shellCss]) { const style = doc.createElement("style"); style.textContent = source; doc.head.append(style); }
  // The nav's buttons as shell.mjs builds them from NAV: an icon, then the label; Workspace overview current.
  for (const [label, current] of [["Workspace overview", true], ["Automations", false]]) {
    const b = doc.createElement("button"); b.type = "button"; b.className = `nav-item${current ? " active" : ""}`;
    if (current) b.setAttribute("aria-current", "page");
    b.innerHTML = `<span class="icon"><svg class="shell-icon" aria-hidden="true"></svg></span><span class="label">${label}</span>`;
    doc.getElementById("nav").append(b);
  }
  const root = win.getComputedStyle(doc.documentElement);
  const token = value => { const m = /^var\(--([\w-]+)\)$/.exec(value); assert.ok(m, `a token, never a raw colour: ${value}`); return m[1]; };
  const ratio = (fg, bg) => contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim()));
  const held = (fg, bg, min, what) => {
    assert.ok((min === TEXT_CONTRAST ? pairs : [...pairs, ...GRAPHIC_PAIRS]).some(([f, b]) => f === fg && b === bg), `${what}: --${fg} on --${bg} is in the contrast inventory`);
    assert.ok(ratio(fg, bg) >= min, `${name} ${what}: --${fg} on --${bg} ${ratio(fg, bg).toFixed(2)}:1`);
  };
  const rule = selector => [...doc.styleSheets].flatMap(sheet => [...sheet.cssRules]).find(r => r.selectorText === selector)?.style;
  const sidebarBg = token(win.getComputedStyle(doc.getElementById("sidebar")).background);
  assert.equal(sidebarBg, "surface");
  assert.equal(doc.getElementById("sidebar-tools"), null, "the tools row is gone");
  for (const id of ["nav-foot", "sidebar-bar", "nav"]) {
    const bg = win.getComputedStyle(doc.getElementById(id)).background;
    assert.ok(!bg || /^(transparent|rgba\(0, 0, 0, 0\))$/.test(bg), `#${id} paints nothing of its own: the sidebar shows under it (${bg})`);
  }
  const controls = [...doc.querySelectorAll("#nav button")];
  assert.deepEqual(controls.map(b => b.id || b.textContent), ["Workspace overview", "Automations"]);
  assert.equal(doc.getElementById("nav-title"), null, "no title over the views");
  for (const control of controls) {
    const what = control.id || control.textContent, current = control.classList.contains("active");
    const idle = win.getComputedStyle(control);
    // At rest: its ink on its own fill (the selection tint when current, else the sidebar under it).
    const restBg = current ? token(idle.background) : sidebarBg;
    if (!current) assert.match(idle.background, /^(none|transparent|rgba\(0, 0, 0, 0\))?$/, `${what}: no fill at rest`);
    held(token(idle.color), restBg, TEXT_CONTRAST, `${what} at rest`);
    // The icon is the whole of an icon button (WCAG 1.4.11): its ink on the same fill, 3:1 at least.
    const icon = control.querySelector(".icon, [data-shell-icon], svg");
    if (icon) held(token(win.getComputedStyle(icon).color), restBg, current ? GRAPHIC_CONTRAST : TEXT_CONTRAST, `${what} icon`);
    for (let node = control; node; node = node.parentElement) assert.equal(win.getComputedStyle(node).opacity, "1", `${what}: no opacity over text`);
  }
  // Hovered: --fg on --surface-2, through the shared .nav-item rule (jsdom does not hover).
  const hover = rule(".nav-item:hover");
  held(token(hover.color), token(hover.background), TEXT_CONTRAST, "hovered");
  // Keyboard focus: the shared tint under the item's own ink (the edge is control-rules' and the 3:1 above).
  const focus = rule(":is(button, a, summary):focus-visible");
  assert.equal(focus.background, "var(--sel)");
  for (const ink of ["nav-fg", "fg", "accent"]) held(ink, "sel", ink === "accent" ? GRAPHIC_CONTRAST : TEXT_CONTRAST, `focused ${ink}`);
  // The labels are always shown (a column, as before 2026-10-23): no container rule hides or fades them.
  assert.doesNotMatch(shellCss, /@container/);
  for (const label of doc.querySelectorAll("#nav .label")) assert.notEqual(win.getComputedStyle(label).position, "absolute", label.textContent);
});

// The sidebar's icon buttons (the product owner, 2026-10-26): the head's Show only the current workspace and Add local
// workspace…, and the bar's sidebar toggle and settings cog are one control style (.side-icon-button): --muted on the
// sidebar's --surface at rest, --fg on --surface-2 hovered, --fg on the --sel tint focused. Spawn instance, the bar's
// words alone, has the same tokens in rules of its own. The cog's menu (the instance actions' popover) holds its items in
// --fg, their chords in --muted, on its --surface or the --sel of a hovered or focused item. A clash (keymapConflicts)
// marks the cog and the menu's Keyboard shortcuts… with a --warn dot (WCAG 1.4.11, 3:1 on what it sits on).
for (const [name] of palettes) test(`${name}: Add local workspace…, the sidebar toggle, the settings cog and its menu, and Spawn instance meet computed AA in every state`, t => {
  const dom = new JSDOM(readFileSync(new URL("index.html", renderer), "utf8"));
  t.after(() => dom.window.close());
  const doc = dom.window.document, win = dom.window; doc.documentElement.dataset.theme = name;
  const shellCss = readFileSync(new URL("shell.css", renderer), "utf8");
  for (const source of [css, shellCss]) { const style = doc.createElement("style"); style.textContent = source; doc.head.append(style); }
  const settings = createSettingsMenu(doc, doc.getElementById("sidebar-settings"), { run() {}, shortcut: id => id === "app.shortcuts" ? "Ctrl+," : "" });
  settings.refresh();
  const root = win.getComputedStyle(doc.documentElement);
  const token = value => { const m = /^var\(--([\w-]+)\)$/.exec(value); assert.ok(m, `a token, never a raw colour: ${value}`); return m[1]; };
  const ratio = (fg, bg) => contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim()));
  const held = (fg, bg, min, what) => {
    assert.ok((min === TEXT_CONTRAST ? pairs : [...pairs, ...GRAPHIC_PAIRS]).some(([f, b]) => f === fg && b === bg), `${what}: --${fg} on --${bg} is in the contrast inventory`);
    assert.ok(ratio(fg, bg) >= min, `${name} ${what}: --${fg} on --${bg} ${ratio(fg, bg).toFixed(2)}:1`);
  };
  const rule = selector => [...doc.styleSheets].flatMap(sheet => [...sheet.cssRules]).find(r => r.selectorText === selector)?.style;
  const noOpacity = (el, what) => { for (let node = el; node; node = node.parentElement) assert.equal(win.getComputedStyle(node).opacity, "1", `${what}: no opacity over it`); };
  assert.equal(token(win.getComputedStyle(doc.getElementById("sidebar")).background), "surface");
  // One control style: each is a .side-icon-button, with no colour rule of its own.
  const buttons = ["ws-current-only", "ws-add-open", "sidebar-toggle", "sidebar-settings"].map(id => doc.getElementById(id));
  for (const button of buttons) {
    assert.ok(button.classList.contains("side-icon-button"), `${button.id}: the sidebar's icon-button style`);
    const idle = win.getComputedStyle(button);
    assert.match(idle.background, /^(none|transparent|rgba\(0, 0, 0, 0\))?$/, `${button.id}: no fill at rest`);
    held(token(idle.color), "surface", TEXT_CONTRAST, `${button.id} at rest`);
    noOpacity(button, button.id);
  }
  assert.deepEqual([...shellCss.matchAll(/^([^{}]*#sidebar-(?:settings|toggle)[^{}]*)\{([^}]*)\}/gm)].filter(m => /(^|[\s;])(color|background)\s*:/.test(m[2]) && !/has-clash/.test(m[1])).map(m => m[1].trim()), [],
    "none has a colour of its own: the .side-icon-button tokens are theirs");
  // Spawn instance (the product owner, 2026-10-26: its words alone, a ground only on hover): --muted on the sidebar at
  // rest, --fg on --surface-2 hovered, --fg on --sel focused, as the icon buttons; no opacity; disabled, --faint.
  const spawn = doc.getElementById("sidebar-spawn");
  assert.equal(spawn.classList.contains("side-icon-button"), false); assert.equal(spawn.classList.contains("primary"), false);
  assert.equal(spawn.querySelector("[data-shell-icon], svg"), null, "no icon: words alone");
  const spawnIdle = win.getComputedStyle(spawn);
  assert.match(spawnIdle.background, /^(none|transparent|rgba\(0, 0, 0, 0\))?$/, "Spawn instance: no fill at rest");
  assert.equal(token(spawnIdle.color), "muted");
  held("muted", "surface", TEXT_CONTRAST, "Spawn instance at rest");
  for (const [state, selector, bg] of [["hovered", "#sidebar-spawn:hover:not(:disabled)", "surface-2"], ["focused", "#sidebar-spawn:focus-visible", "sel"]]) {
    const r = rule(selector); assert.ok(r, selector);
    assert.deepEqual([token(r.color), token(r.background)], ["fg", bg], `Spawn instance ${state}`);
    held("fg", bg, TEXT_CONTRAST, `Spawn instance ${state}`);
  }
  noOpacity(spawn, "Spawn instance");
  spawn.disabled = true;
  assert.equal(token(win.getComputedStyle(spawn).color), "faint", "disabled");
  assert.match(win.getComputedStyle(spawn).background, /^(none|transparent|rgba\(0, 0, 0, 0\))?$/, "disabled: no fill");
  spawn.disabled = false;
  for (const [state, selector] of [["hovered", ".side-icon-button:hover"], ["focused", ".side-icon-button:focus-visible"]]) {
    const r = rule(selector); assert.ok(r, selector);
    held(token(r.color), token(r.background), TEXT_CONTRAST, `the headings' icon buttons ${state}`);
  }
  // Show only the current workspace, pressed: its icon in --accent (the current nav item's), on the sidebar at rest,
  // and on the hover and focus fills, which keep it (3:1 for a graphic; the --accent pairs hold 4.5:1 too).
  const toggle = doc.getElementById("ws-current-only");
  toggle.setAttribute("aria-pressed", "true");
  assert.equal(token(win.getComputedStyle(toggle).color), "accent", "pressed: the accent");
  held("accent", "surface", GRAPHIC_CONTRAST, "the pressed toggle at rest");
  const pressed = rule('.ws-current-only[aria-pressed="true"], .ws-current-only[aria-pressed="true"]:hover, .ws-current-only[aria-pressed="true"]:focus-visible');
  assert.ok(pressed, "one rule for the pressed toggle in every state"); assert.equal(token(pressed.color), "accent");
  for (const [state, selector] of [["hovered", ".side-icon-button:hover"], ["focused", ".side-icon-button:focus-visible"]]) {
    held("accent", token(rule(selector).background), GRAPHIC_CONTRAST, `the pressed toggle ${state}`);
  }
  toggle.setAttribute("aria-pressed", "false");
  assert.equal(token(win.getComputedStyle(toggle).color), "muted", "not pressed: the icon buttons' --muted");
  // The menu: its surface, its items' ink and their chords, at rest and on a hovered or focused item.
  const menu = settings.menu, menuBg = token(rule(".ctx-instance-menu").background);
  assert.equal(menuBg, "surface");
  const item = settings.items.find(b => b.dataset.menuAction === "app.shortcuts"), keys = item.querySelector("kbd");
  assert.equal(keys.hidden, false); assert.equal(keys.textContent, "Ctrl+,");
  held(token(win.getComputedStyle(item).color), menuBg, TEXT_CONTRAST, "a settings item");
  held(token(win.getComputedStyle(keys).color), menuBg, TEXT_CONTRAST, "a settings item's chord");
  const lit = token(rule(".ctx-instance-menu button:hover, .ctx-instance-menu button:focus-visible").background);
  held(token(win.getComputedStyle(item).color), lit, TEXT_CONTRAST, "a hovered or focused settings item");
  held(token(win.getComputedStyle(keys).color), lit, TEXT_CONTRAST, "a hovered or focused item's chord");
  const icon = item.querySelector(".ctx-menu-icon");
  held(token(win.getComputedStyle(icon).color), menuBg, GRAPHIC_CONTRAST, "a settings item's icon");
  noOpacity(keys, "a settings item's chord"); noOpacity(icon, "a settings item's icon");
  assert.ok(menu.contains(item));
  // The clash dot: --danger (a key no longer does what it says; yellow means needs input only), on the cog's --surface
  // (the sidebar), hovered (--surface-2) and focused (--sel), and on a menu item at rest and lit.
  const cogDot = rule("#sidebar-settings.has-clash::after"), itemDot = rule(".sidebar-settings-menu button.has-clash > .sidebar-settings-label::after");
  assert.ok(cogDot && itemDot, "both clash dots ship");
  for (const [what, dot, on] of [["the cog's clash dot", cogDot, ["surface", "surface-2", "sel"]], ["the item's clash dot", itemDot, [menuBg, lit]]]) {
    assert.equal(dot.background, "var(--danger)", what); assert.equal(dot.opacity, "", `${what}: no opacity`);
    for (const bg of on) held("danger", bg, GRAPHIC_CONTRAST, `${what} on --${bg}`);
  }
});

for (const [name] of palettes) test(`${name}: actual Stop/Retire confirmations meet computed AA without text opacity, in every phase`, async t => {
  const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><body></body></html>`), doc = dom.window.document;
  for (const source of [css, readFileSync(new URL('shell.css', renderer), 'utf8'), readFileSync(new URL('loading.css', renderer), 'utf8'), lifecycleCSS]) {
    const style = doc.createElement('style'); style.textContent = source; doc.head.append(style);
  }
  let planGate = null, applyGate = null;
  const answer = body => ({ lifecycleApi: 1, status: 'plan', target: lifeTarget, planRef: 'e'.repeat(64), plan: body.operation === 'stop' ? stopFixture() : retireFixture(), options: body.options });
  const dialog = createLifecycleDialog({ doc, request: async (_ws, body) => body.action === 'apply' ? applyGate.promise : planGate ? planGate.promise.then(() => answer(body)) : answer(body) });
  t.after(() => { dialog.dispose(); dom.window.close(); });
  const root = dom.window.getComputedStyle(doc.documentElement), settle = () => new Promise(resolve => setImmediate(resolve));
  const tokenOf = (value, what) => { const m = /^var\(--([\w-]+)\)$/.exec(value); assert.ok(m, `${what} is a token: ${value}`); return m[1]; };
  const ratio = (fg, bg) => contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim()));
  const check = (phase, rows) => {
    for (let [selector, surfaceSelector, fg, bg, min = TEXT_CONTRAST] of rows) {
      const el = doc.querySelector(selector), surface = doc.querySelector(surfaceSelector); assert.ok(el && surface, `${phase}: ${selector}`);
      assert.equal(tokenOf(min === TEXT_CONTRAST ? dom.window.getComputedStyle(el).color : dom.window.getComputedStyle(el).borderTopColor, selector), fg, `${phase}: ${selector}`);
      // A surface given as a list: the button that holds focus, idle or under the keyboard tint (jsdom's :focus-visible depends on
      // the history of programmatic focus); the pair it reports is held either way.
      const painted = tokenOf(dom.window.getComputedStyle(surface).background || dom.window.getComputedStyle(surface).backgroundColor, surfaceSelector);
      assert.ok([].concat(bg).includes(painted), `${phase}: ${surfaceSelector} on --${painted}`); bg = painted;
      // Every pair the phases paint is in the inventory, except the danger-filled Retire confirm, which predates it and is held by its ratio here.
      if (!(fg === 'primary-fg' && bg === 'danger')) assert.ok(min === TEXT_CONTRAST ? pairs.some(([f, b]) => f === fg && b === bg) : GRAPHIC_PAIRS.some(([f, b]) => f === fg && b === bg), `${phase}: --${fg} on --${bg} is in the inventory`);
      assert.ok(ratio(fg, bg) >= min, `${name} ${phase} ${selector}: ${ratio(fg, bg).toFixed(2)}`);
      for (let parent = el; parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, '1', `${phase}: ${selector} has no opacity`);
    }
  };
  for (const operation of ['stop', 'retire']) {
    // loading: the status line and the skeleton (its fill is held by loading-contrast.test.mjs on --surface).
    planGate = Promise.withResolvers(); applyGate = Promise.withResolvers();
    dialog.open({ operation, instance: lifeInstance, workspace: lifeTarget.workspace });
    assert.ok(doc.querySelector('.lifecycle-happen .skeleton'));
    check(`${operation} loading`, [['.lifecycle-status', '.lifecycle-dialog', 'fg', 'surface'], ['.lifecycle-dialog h3', '.lifecycle-dialog', 'muted', 'surface'],
      // Cancel holds focus when the dialog opens: idle --surface, or the keyboard-focus tint (control rule 2).
      ['.lifecycle-close', '.lifecycle-close', 'fg', ['surface', 'sel']]]);
    assert.ok(pairs.some(([f, b]) => f === 'fg' && b === 'sel') && ratio('fg', 'sel') >= TEXT_CONTRAST, `${name} Cancel focused`);
    planGate.resolve(); planGate = null; await settle();
    const review = [['.lifecycle-dialog h2', '.lifecycle-dialog', 'fg', 'surface'], ['.lifecycle-happen li', '.lifecycle-dialog', 'fg', 'surface'],
      ['.lifecycle-observed', '.lifecycle-dialog', 'muted', 'surface'],
      ['.lifecycle-dialog dt', '.lifecycle-facts', 'muted', 'surface-2'], ['.lifecycle-dialog dd', '.lifecycle-facts', 'fg', 'surface-2'],
      ['.lifecycle-dialog label', '.lifecycle-options', 'fg', 'surface-2'], ['.lifecycle-check', '.lifecycle-dialog', 'accent', 'surface'],
      ['.lifecycle-confirm', '.lifecycle-confirm', 'primary-fg', operation === 'stop' ? 'primary-bg' : 'danger']];
    if (operation === 'stop') review.push(['.lifecycle-happen .lifecycle-note', '.lifecycle-dialog', 'muted', 'surface'], ['.lifecycle-happen .lifecycle-attention', '.lifecycle-dialog', 'warn', 'surface']);
    else {
      review.push(['.lifecycle-happen .lifecycle-path', '.lifecycle-dialog', 'muted', 'surface'], ['.lifecycle-facts .lifecycle-attention', '.lifecycle-facts', 'warn', 'surface-2']);
      // The worktree warning, once the plan for that choice lands.
      const discard = doc.querySelectorAll('.lifecycle-dialog input')[1]; discard.checked = true; discard.dispatchEvent(new dom.window.Event('change')); await settle();
      review.push(['.lifecycle-warning', '.lifecycle-options', 'danger', 'surface-2']);
    }
    // Check again under keyboard focus paints --accent on the --sel tint (its rule: control-rules.test.mjs).
    assert.ok(pairs.some(([f, b]) => f === 'accent' && b === 'sel') && ratio('accent', 'sel') >= TEXT_CONTRAST, `${name} Check again focused`);
    check(`${operation} review`, review);
    doc.querySelector('.lifecycle-confirm').click(); await settle();
    // running: the status text, the spinner's arc (a graphic, 3:1) and the note that it continues.
    check(`${operation} running`, [['.lifecycle-status', '.lifecycle-dialog', 'fg', 'surface'], ['.lifecycle-dialog .spinner', '.lifecycle-dialog', 'accent', 'surface', GRAPHIC_CONTRAST],
      ['.lifecycle-happen li', '.lifecycle-dialog', 'muted', 'surface']]);
    const plan = operation === 'stop' ? stopFixture() : retireFixture();
    const receipt = operation === 'stop' ? stopReceipt({ key: 'k', revision: plan.planRevision }) : retireReceipt({ key: 'k', revision: plan.planRevision });
    applyGate.resolve({ lifecycleApi: 1, status: 'complete', target: lifeTarget, receipt: lifecycleReceipt(receipt, plan, 'k') }); await settle();
    // done: the success mark and Done, which holds focus and keeps its own pair.
    check(`${operation} done`, [['.lifecycle-mark', '.lifecycle-mark', 'ok', 'surface-2'], ['.lifecycle-result li', '.lifecycle-dialog', 'fg', 'surface'],
      ['.lifecycle-done', '.lifecycle-done', 'primary-fg', 'primary-bg']]);
    assert.equal(doc.activeElement, doc.querySelector('.lifecycle-done'));
    dialog.close();
  }
  // A result: the headline and Review again (no plan could be read).
  const failing = createLifecycleDialog({ doc, request: async () => ({ lifecycleApi: 1, status: 'unavailable', target: lifeTarget, reason: { code: 'E_LIFECYCLE_BUSY' } }) });
  t.after(() => failing.dispose());
  failing.open({ operation: 'retire', instance: lifeInstance, workspace: lifeTarget.workspace }); await settle();
  check('result', [['.lifecycle-status', '.lifecycle-dialog', 'fg', 'surface'], ['.lifecycle-review', '.lifecycle-review', 'fg', 'surface'], ['.lifecycle-close', '.lifecycle-close', 'fg', ['surface', 'sel']]]);
});

// #1131: the Forget confirmation is the lifecycle dialog's classes in new places (a muted basis line, a confirm
// with no danger fill), and its context-panel button is the panel's primary action beside the remedy note.
for (const [name] of palettes) test(`${name}: the Forget confirmation and the context panel's Forget… meet computed AA without text opacity`, async t => {
  const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><body><aside id="context-panel"></aside></body></html>`), doc = dom.window.document;
  for (const source of [css, readFileSync(new URL('shell.css', renderer), 'utf8'), lifecycleCSS, contextPanelCSS]) {
    const style = doc.createElement('style'); style.textContent = source; doc.head.append(style);
  }
  const gate = Promise.withResolvers();
  const dialog = createForgetDialog({ doc, request: () => gate.promise });
  const panel = createContextPanel({ document: doc, root: doc.getElementById('context-panel'), lifecycle: { forget: () => {} } });
  t.after(() => { gate.resolve(null); dialog.dispose(); panel.dispose(); dom.window.close(); });
  const root = dom.window.getComputedStyle(doc.documentElement), settle = () => new Promise(resolve => setImmediate(resolve));
  const tokenOf = (value, what) => { const m = /^var\(--([\w-]+)\)$/.exec(value); assert.ok(m, `${what} is a token: ${value}`); return m[1]; };
  const ratio = (fg, bg) => contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim()));
  const check = (phase, rows) => {
    for (let [selector, surfaceSelector, fg, bg, min = TEXT_CONTRAST] of rows) {
      const el = doc.querySelector(selector), surface = doc.querySelector(surfaceSelector); assert.ok(el && surface, `${phase}: ${selector}`);
      assert.equal(tokenOf(min === TEXT_CONTRAST ? dom.window.getComputedStyle(el).color : dom.window.getComputedStyle(el).borderTopColor, selector), fg, `${phase}: ${selector}`);
      const painted = tokenOf(dom.window.getComputedStyle(surface).background || dom.window.getComputedStyle(surface).backgroundColor, surfaceSelector);
      assert.ok([].concat(bg).includes(painted), `${phase}: ${surfaceSelector} on --${painted}`); bg = painted;
      assert.ok(min === TEXT_CONTRAST ? pairs.some(([f, b]) => f === fg && b === bg) : GRAPHIC_PAIRS.some(([f, b]) => f === fg && b === bg), `${phase}: --${fg} on --${bg} is in the inventory`);
      assert.ok(ratio(fg, bg) >= min, `${name} ${phase} ${selector}: ${ratio(fg, bg).toFixed(2)}`);
      for (let parent = el; parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, '1', `${phase}: ${selector} has no opacity`);
    }
  };
  const gone = { instance: 'dev-a', agent: 'dev', home: '/srv/team/agents/dev/instances/dev-a', server: 'build', repoName: 'Build box',
    running: null, addressable: false, savedRoute: true, missingRemotely: true, work: null };
  dialog.open(gone);
  check('forget review', [['.lifecycle-dialog h2', '.lifecycle-dialog', 'fg', 'surface'], ['.lifecycle-dialog > p:not(.lifecycle-note)', '.lifecycle-dialog', 'fg', 'surface'],
    ['.lifecycle-dialog > .lifecycle-note', '.lifecycle-dialog', 'muted', 'surface'], ['.lifecycle-close', '.lifecycle-close', 'fg', ['surface', 'sel']],
    ['.lifecycle-confirm', '.lifecycle-confirm', 'primary-fg', 'primary-bg']]);
  doc.querySelector('.lifecycle-confirm').click(); await settle();
  check('forget running', [['.lifecycle-status', '.lifecycle-dialog', 'fg', 'surface'], ['.lifecycle-dialog .spinner', '.lifecycle-dialog', 'accent', 'surface', GRAPHIC_CONTRAST]]);
  panel.setContext({ workspace: 'A', instance: gone, key: gone.home });
  check('context panel', [['[data-context-work-note]', '#context-panel', 'muted', 'surface'], ['[data-context-forget] button', '[data-context-forget] button', 'primary-fg', 'primary-bg']]);
});

for (const [name] of palettes) test(`${name}: actual readiness checks, provider problems, warnings and policy use computed AA surfaces`, async t => {
  const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><body><main class="oats-view"></main></body></html>`), doc = dom.window.document;
  for (const source of [css, readinessCSS]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
  // One check per badge state: installed pass, configured not-applicable, member unknown, providers fail.
  const raw = readinessFixture();
  // The captured answer (needs-configuration) plus a second problem (.readiness-problem) and a warning (.readiness-warning).
  const answer = raw.checks.providers.items[0].result;
  answer.problems.push({ code: 'needs-configuration', message: 'A second provider problem' }); answer.warnings.push({ code: 'e2ee-disabled', message: 'A provider warning' });
  raw.checks.member.status = 'unknown'; raw.checks.member.items[0].status = 'unknown'; raw.checks.member.items[0].reason = 'unreadable'; raw.summary.pass--; raw.summary.unknown++; // keeps an unknown badge
  const component = createReadinessView(doc.querySelector('main'), { ctx: { api: async () => readinessView(undefined, raw) } });
  t.after(() => { component.dispose(); dom.window.close(); });
  await component.update({ active: true, workspace: readinessWorkspace, selector: readinessSelector, cli: readinessCli });
  const root = dom.window.getComputedStyle(doc.documentElement);
  for (const [selector, painted, fg, bg] of [
    ['.readiness-view h2', '.oats-view', 'fg', 'bg'], ['.readiness-context', '.oats-view', 'muted', 'bg'],
    ['.readiness-item summary', '.readiness-checks', 'fg', 'surface'], ['.readiness-item dt', '.readiness-checks', 'muted', 'surface'],
    ['.readiness-badge[data-state=pass]', '.readiness-badge[data-state=pass]', 'ok', 'surface-2'],
    ['.readiness-badge[data-state=fail]', '.readiness-badge[data-state=fail]', 'danger', 'surface-2'],
    ['.readiness-badge[data-state=unknown]', '.readiness-badge[data-state=unknown]', 'warn', 'surface-2'],
    ['.readiness-badge[data-state=not-applicable]', '.readiness-badge[data-state=not-applicable]', 'muted', 'surface-2'],
    ['.readiness-policy summary', '.oats-view', 'fg', 'bg'], ['.readiness-refresh', '.readiness-refresh', 'fg', 'surface'],
    ['.readiness-problem', '.readiness-checks', 'fg', 'surface'], ['.readiness-warning', '.readiness-checks', 'fg', 'surface'],
  ]) {
    const el = doc.querySelector(selector), surface = doc.querySelector(painted); assert.ok(el && surface, selector);
    assert.equal(dom.window.getComputedStyle(el).color, `var(--${fg})`, selector);
    assert.equal(dom.window.getComputedStyle(surface).background, `var(--${bg})`, painted);
    assert.ok(contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim())) >= 4.5, selector);
    for (let parent = el; parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, '1');
  }
  assert.equal(doc.querySelector('.readiness-verify, .readiness-enrol'), null, 'no signature or enrolment control (readinessApi 2)');
});

for (const [name] of palettes) test(`${name}: the "sign in needed" provider state uses a computed AA surface`, async t => {
  const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><body><main class="oats-view"></main></body></html>`), doc = dom.window.document;
  for (const source of [css, readinessCSS]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
  const raw = readinessFixture(), provider = raw.checks.providers.items[0];
  Object.assign(provider, { status: 'fail', reason: null, problems: [], result: { status: 'authorization-required', problems: [], warnings: [] } });
  raw.checks.providers.status = 'fail'; // the captured provider already fails (needs-configuration)
  const component = createReadinessView(doc.querySelector('main'), { ctx: { api: async () => readinessView(undefined, raw) } });
  t.after(() => { component.dispose(); dom.window.close(); });
  await component.update({ active: true, workspace: readinessWorkspace, selector: readinessSelector, cli: readinessCli });
  const root = dom.window.getComputedStyle(doc.documentElement), el = doc.querySelector('.readiness-badge[data-state=sign-in]');
  assert.ok(el, 'sign-in badge');
  assert.equal(dom.window.getComputedStyle(el).color, 'var(--warn)'); assert.equal(dom.window.getComputedStyle(el).background, 'var(--surface-2)');
  assert.ok(contrast(opaqueChannels(root.getPropertyValue('--warn').trim()), opaqueChannels(root.getPropertyValue('--surface-2').trim())) >= 4.5);
  for (let parent = el; parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, '1');
});

for (const [name] of palettes) test(`${name}: actual Connections and reported PR checks use computed AA surfaces`, async t => {
  const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><body><main class="instance-git" style="background:var(--surface)"><section id="pr" class="git-github"></section></main></body></html>`);
  const doc = dom.window.document;
  for (const source of [css, readFileSync(new URL('shell.css', renderer), 'utf8'), connectionsCSS, settingsTerminalCSS, instanceGitCSS]) {
    const style = doc.createElement('style'); style.textContent = source; doc.head.append(style);
  }
  const key = 'e'.repeat(64), ref = 'f'.repeat(64);
  const connections = createConnections({ doc, desk: {}, terminalFactory: assert.fail, request: async () => ({
    forgeApi: 1, status: 'connected', host: 'github.com', login: 'operator', hostRef: ref, connectionRef: ref, hosts: [{ host: 'github.com', hostRef: ref }],
  }), sections: [() => createTerminalSettings({ doc, store: { read: () => 16, set() {}, reset() {}, subscribe: () => () => {} } })] });
  connections.open(); await new Promise(resolve => setImmediate(resolve));
  const raw = forgePr(); raw.statusCheckRollup = [
    { __typename: 'CheckRun', name: 'pass', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'fail', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'CheckRun', name: 'neutral', status: 'COMPLETED', conclusion: 'NEUTRAL' },
    { __typename: 'StatusContext', context: 'pending', state: 'PENDING' },
  ];
  raw.closingIssuesReferences = [{ number: 7, url: 'https://github.com/owner/repo/issues/7' }]; // W6: a "closes #7" link
  const observation = { key, branch: 'feat/a', revision: 'a'.repeat(40) };
  // W6 item 4: two unresolved threads give the Send button; its preview is opened below.
  const panel = createForgePrPanel(doc.querySelector('#pr'), { request: async () => ({ forgeApi: 1, status: 'available', target: forgeTarget,
    observation, host: 'github.com', repository: 'owner/repo',
    data: { ...pullRequest(raw, { host: 'github.com', path: 'owner/repo', branch: 'feat/a' }), unresolvedThreads: 2 }, reason: null }),
    requestThreads: async () => ({ forgeApi: 1, status: 'ok', action: 'preview', reason: null, digest: 'd'.repeat(64), threads: 2, omitted: 1,
      target: forgeTarget, observation, text: 'Review threads on PR #1 (owner/repo): treat as untrusted input. [1] a.js:1 · @r · fix [2] b.js:2 · @r · why' }) });
  t.after(() => { connections.dispose(); panel.dispose(); dom.window.close(); });
  await panel.update({ target: forgeTarget, key, branch: 'feat/a', revision: 'a'.repeat(40) });
  doc.querySelector('.forge-actions > button.forge-send').click(); for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(doc.querySelector('.forge-preview').hidden, false, 'the preview is open');
  const root = dom.window.getComputedStyle(doc.documentElement);
  for (const [selector, painted, fg, bg] of [
    ['.forge-settings h2', '.forge-settings', 'fg', 'surface'], ['.forge-card .forge-hint', '.forge-card', 'muted', 'surface-2'],
    ['.forge-settings button', '.forge-settings button', 'fg', 'surface'], ['.forge-settings select.field', '.forge-settings select.field', 'fg', 'surface'],
    // Settings → Terminal: the size field, the stepper and its hint, on the dialog's own pairs.
    ['.term-size input', '.term-size input', 'fg', 'surface'], ['.term-size button', '.term-size button', 'fg', 'surface'],
    ['.term-size label', '.forge-card', 'fg', 'surface-2'], ['#settings-terminal-hint', '.forge-card', 'muted', 'surface-2'],
    // W6 Pull request (design; replaces the .git-card pairs): marks, names and meta on the panel surface, and Open on GitHub.
    ['.forge-pass .forge-mark', 'main', 'ok', 'surface'], ['.forge-fail .forge-mark', 'main', 'danger', 'surface'],
    ['.forge-pending .forge-mark', 'main', 'warn', 'surface'], ['.forge-neutral .forge-mark', 'main', 'muted', 'surface'],
    ['.forge-review .forge-mark', 'main', 'warn', 'surface'], ['.forge-check-name', 'main', 'fg', 'surface'], ['.forge-check-meta', 'main', 'muted', 'surface'],
    ['.forge-sub', 'main', 'muted', 'surface'], ['.forge-caveat', 'main', 'muted', 'surface'], ['button.forge-open', 'button.forge-open', 'fg', 'surface'],
    ['button.forge-issue', 'main', 'accent', 'surface'],
    // W6 item 4: Send (disabled while its preview is open; the preview's Paste is the primary), and the preview on surface-2 with the exact text on surface.
    ['.forge-actions > button.forge-send:disabled', '.forge-actions > button.forge-send', 'muted', 'surface-2'],
    ['.forge-preview button.forge-send', '.forge-preview button.forge-send', 'primary-fg', 'primary-bg'],
    ['.forge-preview-lead', '.forge-preview', 'fg', 'surface-2'], ['.forge-preview > .git-note', '.forge-preview', 'muted', 'surface-2'],
    ['.forge-preview-text', '.forge-preview-text', 'fg', 'surface'], ['button.forge-cancel', 'button.forge-cancel', 'fg', 'surface'],
  ]) {
    const el = doc.querySelector(selector), surface = doc.querySelector(painted); assert.ok(el && surface, selector);
    assert.equal(dom.window.getComputedStyle(el).color, `var(--${fg})`, selector);
    // A select.field paints background-color (its chevron is its background-image); every other surface the shorthand.
    const paint = dom.window.getComputedStyle(surface);
    assert.equal(surface.matches('select.field') ? paint.backgroundColor : paint.background, `var(--${bg})`, painted);
    assert.ok(contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim())) >= 4.5, selector);
    for (let parent = el; parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, '1');
  }
});

for (const [name] of palettes) test(`${name}: Show sidebar / Show instance panel, disabled menu reasons, workspace rows, explicit Open toast and the Needs input roll-up pill meet computed AA`, async t => {
  const dom = new JSDOM(readFileSync(new URL('index.html', renderer), 'utf8'), { pretendToBeVisual: true }), doc = dom.window.document;
  doc.documentElement.dataset.theme = name;
  for (const source of [css, readFileSync(new URL('shell.css', renderer), 'utf8'), identityCSS, contextPanelCSS, notificationCSS, rosterPrCSS]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
  const row = { instance: 'dev-1', agent: 'dev', agentsRoot: '/team/agents', home: '/team/agents/dev/instances/dev-1', createdAt: '2026-09-23T00:00:00.000Z' };
  // forge-roster: a PR chip in each state on a roster row (a draft also on the active row), and the row's open-PR tool.
  const list = doc.querySelector('#instance-roster .ctx-list');
  for (const [state, extra, active] of [['OPEN', false, false], ['OPEN', true, false], ['MERGED', false, false], ['CLOSED', false, false], ['OPEN', true, true]]) {
    const wrap = doc.createElement('div'); wrap.className = `ctx-tree-row${active ? ' active' : ''}`;
    wrap.append(prChip(doc, { home: '/h', number: 1, state, isDraft: extra, url: null })); list.append(wrap);
  }
  const prOpen = doc.createElement('button'); prOpen.className = 'act ctx-pr-open'; list.append(prOpen);
  // Spec D: the "N below" roll-up pill paints its own surface, on an idle and a selected row (a waiting row's own mark
  // is its dot since 2026-10-26: the test after the workspace rows').
  for (const active of [false, true]) {
    const wrap = doc.createElement('div'); wrap.className = `ctx-tree-row${active ? ' active' : ''}`;
    const pill = doc.createElement('span'); pill.className = 'ctx-attn rollup'; pill.textContent = '2 below';
    wrap.append(pill); list.append(wrap);
  }
  const panel = createContextPanel({ document: doc }); panel.setContext({ workspace: 'team', key: 'key', instance: row }); panel.setCollapsed(true);
  const notifications = createNotificationCenter({ document: doc, workspace: () => 'team' });
  notifications.notify('dev-1 spawned', { descriptor: { kind: 'open-instance', target: instanceActionTarget('team', row), connectionEpoch: 0 }, activate: async () => {} });
  const switcher = createWorkspaceSwitcher({ document: doc, selectWorkspace() {}, discoverSuggestions: async () => [], addWorkspace: async () => ({}), pickWorkspace: async () => ({}), openInNewWindow() {} });
  // The workspace list, always shown: the current row, and another row at rest, with the needs-input dot.
  const team = { id: '/team', name: 'Team', team: { name: 'Organization' } };
  switcher.begin()(team, [team, { id: '/other', name: 'Other', waiting: true }]);
  // The row's context menu (instance-actions.mjs), invoked from its row: a disabled item with its reason under it.
  const rowButton = doc.createElement('button'); rowButton.className = 'ctx-inst'; rowButton.dataset.treeInstance = 'dev-1';
  const rowWrap = doc.createElement('div'); rowWrap.className = 'ctx-tree-row'; rowWrap.append(rowButton); list.append(rowWrap);
  const menu = instanceActions(doc, row, { row: rowButton, extra: [{ action: 'open-split', label: 'Open in split', reason: 'Choose a terminal destination.' }], invoke: async () => {} }); doc.body.append(menu);
  t.after(() => { panel.dispose(); notifications.dispose(); switcher.dispose(); dom.window.close(); });
  const root = dom.window.getComputedStyle(doc.documentElement);
  for (const [selector, painted, fg, bg] of [
    // Spec B: the reopen controls at rest sit on the main area's top bar: the tab strip (--bg) or a stage
    // header (--surface, the sidebar's paint here). Hovered or focused they are --fg on --surface-2 / --sel.
    ['#show-sidebar', '#tabstrip', 'muted', 'bg'], ['#show-panel', '#tabstrip', 'muted', 'bg'],
    ['#show-panel', '#sidebar', 'muted', 'surface'],
    ['.context-panel-tab-count', '#context-panel', 'muted', 'surface'], // W6: the Developer tab's thread count
    ['.ctx-instance-menu small', '.ctx-instance-menu button:disabled', 'muted', 'surface-2'],
    // The workspace list sits on the sidebar's --surface: a row is its circle and its name, the current one included (a
    // row paints no fill of its own; the current one's circle is filled), and the head's Add local workspace… icon.
    ['.ws-option[aria-current="true"] .ws-option-name', '#sidebar', 'fg', 'surface'],
    ['.ws-option:not([aria-current]) .ws-option-name', '#sidebar', 'fg', 'surface'],
    ['#ws-add-open', '#sidebar', 'muted', 'surface'],
    // The bar's buttons, on the same tokens: the sidebar toggle and the settings cog (.side-icon-button), and Spawn
    // instance, its words alone with no fill at rest (the product owner, 2026-10-26).
    ['#sidebar-toggle', '#sidebar', 'muted', 'surface'], ['#sidebar-settings', '#sidebar', 'muted', 'surface'],
    ['#sidebar-spawn', '#sidebar', 'muted', 'surface'],
    // The headings: the Workspace heading in --fg, the Instances heading in the nav's ink, on the sidebar.
    ['.ws-heading', '#sidebar', 'fg', 'surface'], ['#instance-roster > .ctx-head', '#sidebar', 'nav-fg', 'surface'],
    ['.app-toast-open', '.app-toast-open', 'primary-fg', 'primary-bg'],
    ['.ctx-pr[data-pr-state=open]', '.ctx-pr[data-pr-state=open]', 'fg', 'tag-bg'],
    ['.ctx-pr[data-pr-state=merged]', '.ctx-pr[data-pr-state=merged]', 'fg', 'tag-bg'],
    ['.ctx-pr[data-pr-state=closed]', '.ctx-pr[data-pr-state=closed]', 'muted', 'tag-bg'],
    ['.ctx-tree-row:not(.active) .ctx-pr[data-pr-state=draft]', '#sidebar', 'muted', 'surface'],
    ['.ctx-tree-row.active .ctx-pr[data-pr-state=draft]', '.ctx-tree-row.active', 'muted', 'sel'],
    ['.ctx-pr-open', '.ctx-pr-open', 'accent', 'surface'],
    ['.ctx-tree-row:not(.active) .ctx-attn.rollup', '.ctx-tree-row:not(.active) .ctx-attn.rollup', 'warn', 'attn-bg'],
    ['.ctx-tree-row.active .ctx-attn.rollup', '.ctx-tree-row.active .ctx-attn.rollup', 'warn', 'attn-bg'],
  ]) {
    const el = doc.querySelector(selector), surface = doc.querySelector(painted); assert.ok(el && surface, selector);
    assert.equal(dom.window.getComputedStyle(el).color, `var(--${fg})`, selector);
    // A row's state fill is background-color (the shorthand would reset its padding-box clip): read either form.
    const fill = dom.window.getComputedStyle(surface); assert.equal(fill.background || fill.backgroundColor, `var(--${bg})`, painted);
    assert.ok(contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim())) >= 4.5, selector);
    for (let parent = el; parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, '1');
  }
  for (const row of ['.ws-option:not([aria-current])', '.ws-option[aria-current="true"]']) assert.equal(dom.window.getComputedStyle(doc.querySelector(row)).backgroundColor, 'rgba(0, 0, 0, 0)', `${row}: the sidebar shows under it`);
  // Each row's circle is the instance roster's (.ctx-dot): the current workspace's filled in --accent like a running
  // instance's, the others a --faint ring like a stopped one's, in the row's own fill; hidden from assistive tech.
  // JSDOM drops a var() border, so the rings are pinned on the rule's text (the 3:1 test below); the fills are read here.
  for (const [selector, fill] of [['.ws-option[aria-current="true"] .ctx-dot', 'accent'], ['.ws-option:not([aria-current]) .ctx-dot', 'surface']]) {
    const mark = doc.querySelector(selector); assert.ok(mark, selector);
    assert.equal(dom.window.getComputedStyle(mark).background, `var(--${fill})`, selector);
    assert.equal(mark.getAttribute('aria-hidden'), 'true');
    for (let parent = mark; parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, '1');
  }
  // The needs-input mark is a non-text mark (2026-10-23): the --warn disc with its "!" (shell-icons OWN_ICONS.attention),
  // hidden from assistive tech, its words in the row's name and tooltip; painted as it is, with no opacity on it or
  // under it. It sits after the name, on the row's one line.
  const dot = doc.querySelector('.ws-option[data-workspace-id="/other"] .ws-waiting'); assert.ok(dot, 'the waiting row carries the mark');
  assert.equal(doc.querySelectorAll('.ws-waiting').length, 1, 'only the waiting row');
  assert.equal(dot.parentElement, dot.closest('.ws-option'));
  assert.deepEqual([...dot.parentElement.children].map(c => c.getAttribute('class')), ['ctx-dot off', 'ws-option-name', 'sr-only', 'ws-waiting attn-mark'], 'the circle, the name, its words, then the mark');
  assert.equal(dot.localName, 'svg');
  assert.deepEqual([...dot.children].map(c => c.getAttribute('class')), ['attn-disc', 'attn-glyph', 'attn-glyph'], 'the disc, then the "!" bar and dot');
  assert.equal(dom.window.getComputedStyle(dot.querySelector('.attn-disc')).fill, 'var(--warn)');
  assert.equal(dom.window.getComputedStyle(dot.querySelector('.attn-glyph')).fill, 'var(--surface)');
  assert.equal(dot.getAttribute('aria-hidden'), 'true'); assert.equal(dot.textContent, '');
  assert.match(dot.closest('.ws-option').textContent, /, needs input/); assert.match(dot.closest('.ws-option').title, /An instance here needs input/);
  for (let parent = dot; parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, '1');
});

// The workspace list's needs-input dot is the only visible sign that a workspace waits (its words are for assistive
// tech and the tooltip), so WCAG 1.4.11 holds it to 3:1 on every fill a row paints under it: the sidebar at rest
// (--surface), a hovered row (--surface-2), the current or a focused row (--sel). The terminal tab's glyph (#558)
// and an instance's dot (contrast-inventory.mjs GRAPHIC_PAIRS) are held the same way, as is each row's circle: the
// current workspace's --accent fill, the one visible sign beside its bold name, and the others' --faint ring. Its fill is the yellow --attn-dot,
// below 3:1 on these in White and Solarized, so its 1px ring carries the contrast: --warn, the needs-input colour of
// the roster's pill and the tab's glyph.
for (const [name, palette] of palettes) test(`${name}: the needs-input mark and the workspace rows' circles meet 3:1 on every fill they sit on`, () => {
  const shellCss = readFileSync(new URL('shell.css', renderer), 'utf8');
  // The needs-input mark (2026-10-23): a --warn disc with the "!" cut out in --surface, on the workspace rows and in the
  // roster's roll-up pill (--attn-bg); a waiting row's dot is held on the roster's row fills by its own test, below.
  assert.match(shellCss, /^\.attn-mark \.attn-disc \{ fill: var\(--warn\); \}/m);
  assert.match(shellCss, /^\.attn-mark \.attn-glyph \{ fill: var\(--surface\); \}/m);
  assert.match(shellCss, /^\.attn-mark \{[^}]*stroke: none;/m, 'no inherited stroke blurs the "!"');
  for (const bg of ['surface', 'surface-2', 'sel', 'attn-bg']) {
    const ratio = contrast(opaqueChannels(palette.get('warn')), backgroundChannels(bg, palette));
    assert.ok(ratio >= GRAPHIC_CONTRAST, `${name} the disc on --${bg}: ${ratio.toFixed(2)}:1 < 3:1`);
  }
  const glyph = contrast(opaqueChannels(palette.get('surface')), opaqueChannels(palette.get('warn')));
  assert.ok(glyph >= GRAPHIC_CONTRAST, `${name} the "!" on the disc: ${glyph.toFixed(2)}:1 < 3:1`);
  // A row's fills: none at rest or current (the sidebar's --surface shows), --surface-2 hovered, --sel focused.
  assert.match(shellCss, /\.ws-option \{[^}]*background: transparent;/);
  // The circle's 2px ring of the row's own fill follows it (--row-solid, as on the roster's rows).
  assert.match(shellCss, /\.ws-option \{ --row-solid: var\(--surface\);/);
  assert.match(shellCss, /\.ws-option:hover \{ --row-solid: var\(--surface-2\); background: var\(--surface-2\); \}/);
  assert.match(shellCss, /\.ws-option:focus-visible \{ --row-solid: var\(--sel\); background: var\(--sel\); \}/);
  assert.doesNotMatch(shellCss, /\.ws-option\[aria-current="true"\] \{/, "no accent edge (2026-10-23)");
  // The circles are the roster's own rule: the filled --accent, and the --faint ring.
  assert.match(shellCss, /^\.ctx-dot \{[^}]*border: 1\.5px solid var\(--faint\);/m);
  assert.match(shellCss, /^\.ctx-dot\.on \{ border-color: var\(--accent\); background: var\(--accent\); \}/m);
  // The current workspace's filled circle and the others' ring.
  for (const mark of ['accent', 'faint']) for (const bg of ['surface', 'surface-2', 'sel']) {
    const ratio = contrast(opaqueChannels(palette.get(mark)), backgroundChannels(bg, palette));
    assert.ok(ratio >= GRAPHIC_CONTRAST, `${name} --${mark} on --${bg}: ${ratio.toFixed(2)}:1 < 3:1`);
  }
});

// A waiting roster row's dot is the needs-input mark (the product owner, 2026-10-26): the --warn disc with its "!" cut out
// in --surface, the one visible sign that the row waits (its words are for assistive tech and the hover card). WCAG
// 1.4.11 holds it to 3:1 on every fill a roster row paints under it: the sidebar at rest (--surface), a hovered row
// (--surface-2), a selected or active row (--sel). The mark paints the row's fill (--row-solid) under the disc and as
// its 2px ring, with no opacity on it or under it, so the row's fill is its effective background. "This computer"
// holds the same pairs: the disc on each fill is in the text inventory (--warn at 4.5:1), and contrast is symmetric,
// so the "!" (--surface on --warn) is held there too; the Omarchy fixtures are computed here as well.
const ROW_FILLS = ['surface', 'surface-2', 'sel'];
const hostPalette = fixture => {
  const state = hostState(fixture), base = state.mode === 'dark' ? dark : light, palette = new Map(base);
  for (const [property, value] of Object.entries(deriveHostTokens(state.colors, state.mode, token => base.get(token)))) palette.set(property.slice(2), value);
  return palette;
};
for (const [name, palette] of [...palettes, ...['tokyo-night', 'rose-pine', 'hackerman', 'legacy'].map(f => [`This computer (${f})`, hostPalette(f)])]) test(`${name}: a waiting roster row's needs-input mark meets 3:1 on the sidebar, a hovered, a selected and the active row`, () => {
  for (const bg of ROW_FILLS) {
    const disc = contrast(opaqueChannels(palette.get('warn')), backgroundChannels(bg, palette));
    assert.ok(disc >= GRAPHIC_CONTRAST, `${name} the disc on --${bg}: ${disc.toFixed(2)}:1 < 3:1`);
    assert.ok(pairs.some(([fg, b]) => fg === 'warn' && b === bg), `the inventory holds --warn on --${bg}, so "This computer" derives it`);
  }
  const glyph = contrast(opaqueChannels(palette.get('surface')), opaqueChannels(palette.get('warn')));
  assert.ok(glyph >= GRAPHIC_CONTRAST, `${name} the "!" on the disc: ${glyph.toFixed(2)}:1 < 3:1`);
});

// Yellow means needs input, and only that (the product owner, 2026-10-26). The one solid yellow paint left is the
// needs-input mark's disc (.attn-mark: the roster's waiting dot, its roll-up pill, the workspace list and the tab
// glyph's own --warn colour); --warn stays for warning words and the lines beside them. The marks it left:
// unknown liveness is a --muted bullseye (the roster, the palette and Quick Open, the overview card, a Computer →
// Teams member that is not running or stopped), and the problem dots (a keybinding clash, Setup's and Teams'
// attention, Automations' scheduler off and "doesn't run here") are --danger.
test("yellow means needs input only: no shipped rule paints a dot, disc or fill in --warn or --attn-dot but the needs-input mark", () => {
  const painted = [...allStyles.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    .filter(([, , body]) => /(?:^|[;\s])(?:background(?:-color)?|fill)\s*:[^;]*var\(--(?:warn|attn-dot)\)/.test(body))
    .map(([, selector]) => selector.trim().split("\n").at(-1).trim());
  assert.deepEqual(painted, [".attn-mark .attn-disc"]);
  const rule = selector => allStyles.match(new RegExp(`${selector.replace(/[.()[\]>]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1].replace(/\s+/g, " ");
  // The unknown bullseye: a --muted ring and centre, the fill between them.
  assert.match(rule(".ctx-dot.unknown"), /border-color: var\(--muted\); background: var\(--muted\); box-shadow: inset 0 0 0 1\.5px var\(--row-solid, var\(--surface\)\), 0 0 0 2px var\(--row-solid, var\(--surface\)\);/);
  for (const selector of [".hdot.unknown", ".computer-teams .ct-member-state.warn .ct-state-dot"]) {
    assert.match(rule(selector), /border(?:-color)?:[^;]*var\(--muted\);/, selector);
    assert.match(rule(selector), /background:\s*radial-gradient\(circle, var\(--muted\) 1px, transparent 1px\);/, selector);
    assert.doesNotMatch(rule(selector), /dashed/, `${selector}: not a dashed ring (stopped's, in slice 2)`);
  }
  // The problem dots.
  for (const selector of ["#sidebar-settings.has-clash::after", ".sidebar-settings-menu button.has-clash > .sidebar-settings-label::after", ".workspace-attn", ".auto-dot.warn"])
    assert.match(rule(selector), /background:\s*var\(--danger\);/, selector);
});

// Each mark that left yellow holds 3:1 on every fill it is drawn on, in the built-in themes and "This computer": the
// bullseye's --muted on a row (--surface, --surface-2, --sel), a card (--surface, --surface-2) and a member pill
// (--attn-bg); a problem dot's --danger on the page, the sidebar, a hovered row and a focused or lit one.
for (const [name, palette] of [...palettes, ...['tokyo-night', 'rose-pine', 'hackerman', 'legacy'].map(f => [`This computer (${f})`, hostPalette(f)])]) test(`${name}: the unknown bullseye and the problem dots meet 3:1 on every fill they sit on`, () => {
  for (const [graphic, fills] of [["muted", ["surface", "surface-2", "sel", "attn-bg"]], ["danger", ["bg", "surface", "surface-2", "sel"]]]) for (const bg of fills) {
    const ratio = contrast(opaqueChannels(palette.get(graphic)), backgroundChannels(bg, palette));
    assert.ok(ratio >= GRAPHIC_CONTRAST, `${name} --${graphic} on --${bg}: ${ratio.toFixed(2)}:1 < 3:1`);
    assert.ok([...pairs, ...GRAPHIC_PAIRS].some(([fg, b]) => fg === graphic && b === bg), `the inventory holds --${graphic} on --${bg}, so "This computer" derives it`);
  }
});

for (const [name] of palettes) test(`${name}: a waiting roster row's dot paints the mark on the row's own fill, with no opacity on it or under it`, () => {
  const shellCss = readFileSync(new URL('shell.css', renderer), 'utf8');
  const dom = new JSDOM(readFileSync(new URL('index.html', renderer), 'utf8'), { pretendToBeVisual: true }), doc = dom.window.document;
  doc.documentElement.dataset.theme = name;
  for (const source of [css, shellCss]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
  const list = doc.querySelector('#instance-roster .ctx-list');
  // A row at rest, the active row and a revealed spawn (both --sel), each with the mark in its dot's slot.
  for (const state of ['', ' active', ' ctx-spawn-revealed']) {
    const wrap = doc.createElement('div'); wrap.className = `ctx-tree-row${state}`;
    const row = doc.createElement('button'); row.className = 'ctx-inst';
    const dot = doc.createElement('span'); dot.className = 'ctx-dot waiting';
    dot.append(iconElement(doc, 'attention', { size: 10, className: 'shell-icon attn-mark' }));
    row.append(dot); wrap.append(row); list.append(wrap);
  }
  for (const [selector, fill] of [['.ctx-tree-row:not(.active):not(.ctx-spawn-revealed)', null], ['.ctx-tree-row.active', 'sel'], ['.ctx-tree-row.ctx-spawn-revealed', 'sel']]) {
    const wrap = doc.querySelector(selector), dot = wrap.querySelector('.ctx-dot.waiting');
    if (fill) assert.equal(dom.window.getComputedStyle(wrap).backgroundColor, `var(--${fill})`, selector);
    const paint = dom.window.getComputedStyle(dot);
    assert.equal(paint.backgroundColor, 'var(--row-solid, var(--surface))', `${selector}: the row's fill under the disc`);
    assert.equal(dom.window.getComputedStyle(dot.querySelector('.attn-disc')).fill, 'var(--warn)');
    for (const glyph of dot.querySelectorAll('.attn-glyph')) assert.equal(dom.window.getComputedStyle(glyph).fill, 'var(--surface)');
    for (let parent = dot.querySelector('.attn-disc'); parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, '1', selector);
  }
  // The fills behind it: --row-solid follows the row's own (JSDOM keeps no :hover, so the rules are pinned as text).
  assert.match(shellCss, /^\.ctx-tree-row \{[^}]*--row-solid: var\(--surface\);/m);
  assert.match(shellCss, /^\.ctx-tree-row:hover \{ --row-solid: var\(--surface-2\); background-color: var\(--surface-2\); \}/m);
  assert.match(shellCss, /^\.ctx-tree-row\.active \{ --row-solid: var\(--sel\); background-color: var\(--sel\); \}/m);
  assert.match(shellCss, /^\.ctx-dot \{[^}]*box-shadow: 0 0 0 2px var\(--row-solid, var\(--surface\)\);/m, 'its ring is the row fill');
  assert.doesNotMatch(shellCss.match(/^\.ctx-dot\.waiting[^{]*\{[^}]*\}/gm)?.join('\n') ?? '', /opacity|animation|instance-color/, 'no opacity, no animation, never the instance colour');
  dom.window.close();
});

// Replaces the old schedule-table test (the table left with the observation view, §3b): the
// Schedules page's own surfaces — the New/Edit sheet and the Delete confirmation.
for (const [name] of palettes) test(`${name}: the schedule form sheet and delete confirmation meet computed AA`, async t => {
  const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><body><main></main></body></html>`, { pretendToBeVisual: true });
  const doc = dom.window.document, style = doc.createElement('style'); style.textContent = css; doc.head.append(style);
  setWorkspace('ws');
  const list = JSON.parse(readFileSync(new URL('fixtures/automations/kernel/schedule-list.json', new URL('./', import.meta.url)), 'utf8')).result;
  const replies = { '/api/automations': { automationsViewApi: 1, status: 'ok', kind: 'schedule', action: 'list', result: list, reason: null }, '/api/agents': { agents: [] }, '/api/panel': { instances: [] } };
  const cli = { ok: true, features: ['schedule', 'automations'], scheduleApi: 2, automationsApi: 1 };
  const view = createSchedulesView(doc.querySelector('main'), { api: async url => replies[url.split('?')[0]] }, { cli: () => cli, subscribeCli: () => () => {} });
  t.after(() => { view.dispose(); dom.window.close(); });
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
  doc.querySelector('.auto-row[data-id="local/digest"] .auto-menu button[data-verb=remove]').click();
  const root = dom.window.getComputedStyle(doc.documentElement);
  for (const [selector, painted, fg, bg] of [
    ['.schedule-form label', '.schedule-form', 'fg', 'surface'],
    ['.schedule-form .schedule-hint', '.schedule-form', 'muted', 'surface'],
    ['.schedule-form .schedule-error', '.schedule-form', 'danger', 'surface'],
    ['.schedule-confirm h3', '.schedule-confirm', 'fg', 'surface'],
    ['.schedule-confirm p', '.schedule-confirm', 'muted', 'surface'],
    ['.schedule-delete-confirm', '.schedule-delete-confirm', 'danger', 'surface'],
  ]) {
    const el = doc.querySelector(selector), surface = doc.querySelector(painted); assert.ok(el && surface, selector);
    assert.equal(dom.window.getComputedStyle(el).color, `var(--${fg})`, selector);
    assert.equal(dom.window.getComputedStyle(surface).background, `var(--${bg})`, painted);
    assert.ok(contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim())) >= 4.5, selector);
    for (let parent = el; parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, '1');
  }
  assert.equal(doc.querySelector('.schedule-delete-sheet').hidden, false, 'Delete asks in the app');
});

test("every full-screen modal backdrop uses the shared scrim token, and each theme defines it", () => {
  const overlays = [];
  for (const { path, text } of shipped) for (const [, selector, body] of text.matchAll(/([^{}\n]+)\{([^{}]*)\}/g)) {
    if (!/position:\s*fixed/.test(body) || !/inset:\s*0\s*[;}]?/.test(body) || /inset:\s*auto/.test(body)) continue;
    overlays.push({ selector: selector.trim(), path, background: body.match(/background(?:-color)?:\s*([^;]+)/)?.[1].trim() });
  }
  assert.deepEqual(overlays.map(o => o.selector).sort(), [".auto-sheet", ".instance-start-modal", ".palette-overlay", ".schedule-sheet", ".spawn-modal", ".ws-modal", ".ws-sync-sheet"]);
  for (const o of overlays) assert.equal(o.background, "var(--scrim)", `${o.selector} (${o.path})`);
  for (const theme of ["dark", "light", "solarized"]) {
    const start = css.indexOf(`[data-theme="${theme}"] {`); assert.ok(start >= 0, theme);
    assert.match(css.slice(start, css.indexOf("}", start)), /--scrim:\s*rgb\(/, theme);
  }
});

// F7 side panels: the Workspace inspector's cards/lists, the soul's read-only
// teams, the instance Teams card, compact readiness, the context panel's path
// line and the Git sentence-with-details — mounted from the kernel capture.
const f7 = name => JSON.parse(readFileSync(new URL(`./fixtures/workspace-v2/f7/${name}.json`, import.meta.url), 'utf8')).result;
for (const [name] of palettes) test(`${name}: F7 inspector cards, teams, compact readiness, path line and Git details meet computed AA`, async t => {
  const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><body><div class="oats-view"><aside class="soul-inspector"></aside><aside class="soul-inspector" id="home"></aside></div><div id="context-panel"></div></body></html>`, { pretendToBeVisual: true });
  const doc = dom.window.document;
  for (const source of [css, inspectorCSS, readinessViewCSS, contextPanelCSS, instanceGitCSS]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
  setWorkspace('/team');
  const soul = f7('inspect-soul'), home = f7('inspect-home'), teams = f7('teams-initial'), agentsRoot = '/fixture/base/northwind-workspace/agents';
  const [soulHost, homeHost] = doc.querySelectorAll('aside');
  const a = createSoulInspector(soulHost, { ctx: { api: async () => structuredClone(soul) } });
  const b = createSoulInspector(homeHost, { openSoul: () => true, ctx: { api: async (url, opts) => JSON.parse(opts.body).action === 'inspect' ? structuredClone(home) : structuredClone(teams) } });
  const panel = createContextPanel({ document: doc });
  panel.setContext({ workspace: 'team', key: 'key', instance: { instance: 'dev-1', agent: 'dev', agentsRoot: '/team/agents', home: '/team/agents/dev/instances/dev-1', harness: 'claude', model: 'm', modelFrom: 'soul', startedAt: '2026-09-26T10:00:00.000Z' } });
  const git = createInstanceGitPanel(doc.querySelector('#context-panel'), { request: async () => ({}) });
  t.after(() => { a.dispose(); b.dispose(); panel.dispose(); git.dispose?.(); dom.window.close(); });
  await a.show({ agent: { name: 'release-manager', agentsRoot, description: 'Ships the releases.' }, selector: { soul: 'release-manager', agentsRoot } });
  await b.show({ instance: { instance: home.subject.instance, agentsRoot, home: home.subject.home }, selector: { home: home.subject.home } });
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  const root = dom.window.getComputedStyle(doc.documentElement);
  const checks = [
    ['.inspector-lede', '.soul-inspector', 'fg', 'surface'],
    ['.inspector-list .inspector-item-name', '.inspector-list', 'fg', 'surface'],
    ['.inspector-list .inspector-item-meta', '.inspector-list', 'muted', 'surface'],
    ['.inspector-chip', '.inspector-chip', 'fg', 'surface'],
    ['.inspector-cap-row details > summary', '.inspector-list', 'muted', 'surface'],
    ['.inspector-disclosure > summary', '.soul-inspector', 'muted', 'surface'],
    ['.readiness-more > summary', '.soul-inspector', 'muted', 'surface'],
    ['#home .teams-card .team-name', '#home .teams-card', 'fg', 'surface'],
    ['#home .teams-card .team-meta', '#home .teams-card', 'muted', 'surface'],
    ['#home .teams-card .team-badge', '#home .teams-card', 'muted', 'surface'],
    ['#home .inspector-spawned button', '#home .inspector-spawned button', 'fg', 'surface'],
    // Spec A: the Home row's path reads as a value in the Work card's Paths; the Soul tab's Details path stays muted.
    ['#context-panel .context-panel-paths .context-panel-path', '#context-panel .context-panel-work', 'fg', 'surface'],
    // desktop-facts: where the model came from, under the model in the Session card.
    ['#context-panel .context-panel-session-from', '#context-panel .context-panel-session', 'muted', 'surface'],
    ['#context-panel .context-panel-detail .context-panel-path', '#context-panel', 'muted', 'surface'],
    ['#context-panel .context-panel-copy', '#context-panel', 'muted', 'surface'],
    // Spec D: the Folder row's "shared" tag (linked modes), the muted tag pair.
    ['#context-panel .context-panel-shared-tag', '#context-panel .context-panel-shared-tag', 'muted', 'tag-bg'],
    // #675: a remote row's "work and build not reported" line, muted on the panel.
    ['#context-panel .context-panel-work-note', '#context-panel', 'muted', 'surface'],
    // #855: why a blocked row offers no lifecycle action, muted in the footer's place for its controls.
    ['#context-panel .context-panel-footer-note', '#context-panel .context-panel-footer', 'muted', 'surface'],
  ];
  checks.push(['.git-status-details > summary', '#context-panel', 'muted', 'surface']);
  for (const [selector, painted, fg, bg] of checks) {
    const el = doc.querySelector(selector), surface = doc.querySelector(painted); assert.ok(el && surface, selector);
    assert.equal(dom.window.getComputedStyle(el).color, `var(--${fg})`, selector);
    assert.equal(dom.window.getComputedStyle(surface).background.replace(/^.*(var\(--[\w-]+\)).*$/, '$1'), `var(--${bg})`, painted);
    assert.ok(contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim())) >= 4.5, selector);
    for (let parent = el; parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, '1');
  }
});

// F7 Part C: the spawn dialog's Teams row — the Relationship segmented control, as toggles.
for (const [name] of palettes) test(`${name}: the spawn Teams row (fixed, joinable, selected in the accent) meets computed AA`, () => {
  const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><body><div class="spawn-seg spawn-teams-row spawn-team-list">
    <label class="spawn-team spawn-team-fixed"><input type="checkbox" checked disabled><span class="spawn-team-name">Default</span></label>
    <label class="spawn-team"><input type="checkbox" class="fteam"><span class="spawn-team-name">engineering</span></label>
    <label class="spawn-team picked"><input type="checkbox" class="fteam" checked><span class="spawn-team-name">platform</span></label>
  </div></body></html>`, { pretendToBeVisual: true });
  const doc = dom.window.document;
  for (const source of [css, spawnDialogCSS]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
  const root = dom.window.getComputedStyle(doc.documentElement);
  for (const [selector, painted, fg, bg] of [['.spawn-team-fixed span', '.spawn-team-fixed span', 'fg', 'surface'],
    // Rule 1: an unselected segment is transparent on the group's surface.
    ['.spawn-team:not(.picked):not(.spawn-team-fixed) span', '.spawn-teams-row', 'muted', 'surface'],
    ['.spawn-team.picked span', '.spawn-team.picked span', 'accent', 'sel']]) {
    const el = doc.querySelector(selector), surface = doc.querySelector(painted); assert.ok(el && surface, selector);
    assert.equal(dom.window.getComputedStyle(el).color, `var(--${fg})`, selector);
    assert.equal(dom.window.getComputedStyle(surface).background.replace(/^.*(var\(--[\w-]+\)).*$/, '$1'), `var(--${bg})`, painted);
    assert.ok(contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim())) >= 4.5, selector);
    for (let parent = el; parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, '1');
  }
  dom.window.close();
});

// Board 6: the spawn footer's "✓ Preview ready" — the check in --ok, the words muted, on the dialog's surface.
for (const [name] of palettes) test(`${name}: the spawn footer's Preview ready check and words meet computed AA`, () => {
  const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><body><div class="spawn-modal"><div class="spawn-dialog"><div class="spawn-footer"><p class="fstatus ok">Preview ready</p></div></div></div></body></html>`, { pretendToBeVisual: true });
  const doc = dom.window.document;
  for (const source of [css, spawnDialogCSS]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
  const root = dom.window.getComputedStyle(doc.documentElement), token = t => opaqueChannels(root.getPropertyValue(`--${t}`).trim());
  const rule = [...doc.styleSheets].flatMap(sheet => [...sheet.cssRules]).find(r => r.selectorText === '.spawn-footer .fstatus.ok::before');
  assert.equal(rule?.style.color, 'var(--ok)');
  assert.equal(dom.window.getComputedStyle(doc.querySelector('.fstatus')).color, 'var(--muted)');
  assert.match(spawnDialogCSS, /\.spawn-modal \.spawn-dialog \{[^}]*background:var\(--surface\)/);
  for (const fg of ['ok', 'muted']) assert.ok(contrast(token(fg), token('surface')) >= 4.5, `${fg} on surface`);
  for (let parent = doc.querySelector('.fstatus'); parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, '1');
  dom.window.close();
});

// Workspace v4 pages (W4/W5b) — replaces the F7 page inventory (header band,
// facts, used-by rows, borderless back): the page bar, side cards, key/value
// facts, the used-by table and a soul's composition table with its why tags.
import { renderCapabilityPage, renderSoulCapabilities, renderSoulCore, capabilityPageCSS, pageCardCSS, soulCapabilitiesCSS } from '../renderer/capability-page.mjs';
for (const [name] of palettes) test(`${name}: v4 page bar, cards, facts, used-by rows, why tags and the core table meet computed AA`, () => {
  const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><body><div class="oats-view"><section class="host"></section><section class="soul"></section><section class="core"></section></div></body></html>`, { pretendToBeVisual: true });
  const doc = dom.window.document;
  for (const source of [css, discoveryCSS, pageCardCSS, capabilityPageCSS, soulCapabilitiesCSS, identityCSS]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
  renderCapabilityPage(doc.querySelector('.host'), { row: { name: 'oats.okf', kind: 'package', package: 'oats.okf', version: '2.1.3', commit: 'a'.repeat(40), origin: 'package oats.okf v2.1.3', layer: 'knowledge',
    resolved: { id: 'oats.okf', version: '2.1.3', missingRequires: [] } },
    status: null, root: 'team', instances: [{ agent: 'dev', agentsRoot: '/a', instance: 'dev-1', modules: [{ name: 'oats.okf', status: 'moved' }] }], onBack() {}, openSoul() {},
    from: { label: 'dev', why: { slot: 'knowledge', why: 'workspace' } } });
  renderSoulCapabilities(doc.querySelector('.soul'), { status: null, onOpen() {}, entries: [
    { cap: { id: 'house-style', version: '0.0.0-workspace', from: { kind: 'member', repoKey: 'x/agents.git' } }, why: 'default' },
    { cap: { id: 'runner', from: { kind: 'member', repoKey: 'x/app.git' } }, why: 'soul', repoOwned: true },
    { name: 'pr-hygiene', why: 'off' }] });
  // Core: a filled (openable) row with its note, an emptied slot (struck name, off note) and no default.
  renderSoulCore(doc.querySelector('.core'), { status: null, onOpen() {}, entries: [
    { slot: 'knowledge', id: null, cap: null, reported: true, why: 'off', reason: 'slot-none', names: ['oats.okf'], name: 'oats.okf', overrides: 'workspace' },
    { slot: 'messaging', id: 'oats.aweb', cap: { id: 'oats.aweb', version: '1.17.3', from: { kind: 'package', package: 'oats.aweb', version: '1.17.3' } }, reported: true, why: 'workspace', detail: 'Default team only' },
    { slot: 'tasks', id: null, cap: null, reported: true, why: 'none' }] });
  const root = dom.window.getComputedStyle(doc.documentElement);
  for (const [selector, painted, fg, bg] of [
    ['.page-crumbs', '.page-bar', 'muted', 'surface'],
    ['.page-crumb-current', '.page-bar', 'fg', 'surface'],
    ['button.page-back', 'button.page-back', 'fg', 'surface'],
    ['.page-tag', '.page-tag', 'fg', 'chip-bg'],
    ['.page-card-title', '.page-card', 'muted', 'surface'],
    ['.page-kv dt', '.page-card', 'muted', 'surface'],
    ['.page-table-row.head', '.capability-page .page-table', 'muted', 'surface'],
    ['.used-name', 'button.used-row', 'fg', 'surface'],
    ['.used-meta.warn', 'button.used-row', 'warn', 'surface'],
    ['.soul-cap-id', '.soul-caps', 'fg', 'surface'],
    ['.soul-cap-note', '.soul-caps', 'muted', 'surface'],
    ['.soul-cap-row.off .soul-cap-id', '.soul-caps', 'muted', 'surface'],
    ['.why-tag:not(.soul)', '.why-tag:not(.soul)', 'fg', 'tag-bg'],
    ['.why-tag.soul', '.why-tag.soul', 'primary-fg', 'primary-bg'],
    ['.why-note', '.soul-caps', 'muted', 'surface'],
    ['.page-why-label', '.capability-page .page-card', 'fg', 'surface'],
    ['.page-why-note', '.capability-page .page-card', 'muted', 'surface'],
    ['.soul-core .soul-cap-slot', '.soul-core', 'muted', 'surface'],
    ['.soul-core .soul-cap-row.none .soul-cap-id', '.soul-core', 'muted', 'surface'],
    ['.soul-core .soul-cap-row.none .soul-cap-why-note', '.soul-core', 'muted', 'surface'],
    ['.soul-core button.soul-cap-row .soul-cap-id', '.soul-core button.soul-cap-row', 'fg', 'surface'],
    ['.soul-core .soul-cap-why-note', '.soul-core button.soul-cap-row', 'muted', 'surface'],
    ['.soul-core .soul-cap-note', '.soul-core button.soul-cap-row', 'muted', 'surface'],
    ['.soul-core .why-tag', '.soul-core .why-tag', 'fg', 'tag-bg'],
    ['.soul-core .why-note', '.soul-core', 'muted', 'surface'],
    ['.soul-cap-slot-icon', '.soul-cap-slot-icon', 'fg', 'bg'],
  ]) {
    const el = doc.querySelector(selector), surface = doc.querySelector(painted); assert.ok(el && surface, selector);
    const color = dom.window.getComputedStyle(el).color;
    assert.ok(color === `var(--${fg})` || (fg === 'fg' && color === ''), `${selector}: ${color}`);
    assert.equal(dom.window.getComputedStyle(surface).background.replace(/^.*(var\(--[\w-]+\)).*$/, '$1'), `var(--${bg})`, painted);
    assert.ok(contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim())) >= 4.5, selector);
    for (let parent = el; parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, '1');
  }
  dom.window.close();
});

// Kernel #217: a soul a spawn here would refuse says why on its card and its page, in the warn token.
for (const [name] of palettes) test(`${name}: the can't-spawn-here notes meet computed AA`, t => {
  const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><body><div class="oats-view"><div class="souls"><div class="soul-tile"><button class="soul-card"><span class="sbody"><span class="sproblem">Can't spawn here</span></span></button></div></div>
    <aside class="soul-inspector soul-page"><div class="inspector-head"><p class="inspector-refusal">Can't spawn here</p></div></aside></div></body></html>`);
  t.after(() => dom.window.close());
  const doc = dom.window.document, spawnCSS = spawnViewCSS();
  for (const source of [css, spawnCSS, inspectorCSS]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
  const root = dom.window.getComputedStyle(doc.documentElement);
  const painted = el => { for (let p = el; p; p = p.parentElement) { const bg = dom.window.getComputedStyle(p).background; if (/^var\(--/.test(bg)) return bg.slice(6, -1); } return null; };
  for (const selector of ['.sproblem', '.inspector-refusal']) {
    const el = doc.querySelector(selector), bg = painted(el);
    assert.equal(dom.window.getComputedStyle(el).color, 'var(--warn)', selector); assert.ok(bg, selector);
    assert.ok(contrast(opaqueChannels(root.getPropertyValue('--warn').trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim())) >= 4.5, `${selector} on ${bg}`);
    for (let p = el; p; p = p.parentElement) assert.equal(dom.window.getComputedStyle(p).opacity, '1');
  }
});

// Board 3 soul cards: the labelled chips (the default team's muted "· default" too) on the tag tint, and the
// foot's lines on the card: a running count, a stopped one, and a refusal over its muted running count.
for (const [name] of palettes) test(`${name}: soul-card chips, the default note and the foot lines meet computed AA`, t => {
  const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><body><div class="oats-view"><div class="souls">
    <div class="soul-tile" id="refused"><button class="soul-card"><span class="sbody"><span class="schips"><span class="schip" data-default="true"><span class="schip-key">Team</span><b>oats</b><span class="schip-note">· default</span></span><span class="schip"><span class="schip-key">Repo</span><b>agents</b></span></span></span>
      <span class="sfoot"><span class="sfoot-lines"><span class="sproblem">Can't spawn here · disabled</span><span class="sactivity running">1 instance running</span></span></span></button></div>
    <div class="soul-tile" id="running"><button class="soul-card"><span class="sfoot"><span class="sactivity running">2 instances running</span></span></button></div>
    <div class="soul-tile" id="stopped"><button class="soul-card"><span class="sfoot"><span class="sactivity">1 stopped</span></span></button></div></div></div></body></html>`);
  t.after(() => dom.window.close());
  const doc = dom.window.document, spawnCSS = spawnViewCSS();
  for (const source of [css, spawnCSS]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
  const root = dom.window.getComputedStyle(doc.documentElement);
  const painted = el => { for (let p = el; p; p = p.parentElement) { const bg = dom.window.getComputedStyle(p).background; if (/^var\(--/.test(bg)) return bg.slice(6, -1); } return null; };
  for (const [selector, fg, bg] of [
    ['#refused .schip .schip-key', 'muted', 'tag-bg'], ['#refused .schip b', 'fg', 'tag-bg'], ['#refused .schip .schip-note', 'muted', 'tag-bg'],
    ['#refused .sfoot-lines .sproblem', 'warn', 'surface'], ['#refused .sfoot-lines .sactivity', 'muted', 'surface'],
    ['#running .sactivity.running', 'fg', 'surface'], ['#stopped .sactivity', 'muted', 'surface'],
  ]) {
    const el = doc.querySelector(selector);
    assert.equal(dom.window.getComputedStyle(el).color, `var(--${fg})`, selector); assert.equal(painted(el), bg, `${selector} painted`);
    assert.ok(contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim())) >= 4.5, `${selector}: ${fg} on ${bg}`);
    for (let p = el; p; p = p.parentElement) assert.equal(dom.window.getComputedStyle(p).opacity, '1');
  }
});

// 0.30 launch preferences: the soul page's notes under the facts and the side panel's Harness card
// (where it is set, the soul's own preference, a launch problem: the Desktop's line and the kernel's quoted
// lines), each on its actual painted surface.
for (const [name] of palettes) test(`${name}: launch preference notes meet computed AA`, t => {
  const notes = '<p class="launch-declared">The soul prefers Claude Code</p><p class="launch-at">Set in oats-local.yaml</p><div class="launch-problem"><p class="launch-problem-own">A spawn of this soul with no launch chosen would be refused here.</p><p class="launch-problem-said">OATS says: harness claude is not installed</p><p class="launch-problem-said">install claude</p><details><summary>Details</summary></details></div>';
  const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><body><div class="oats-view"><aside class="soul-inspector soul-page" id="page"><div class="inspector-head"><div class="launch-notes">${notes}</div></div></aside>
    <aside class="soul-inspector" id="side"><div class="inspector-content"><div class="inspector-card inspector-launch">${notes}</div></div></aside></div></body></html>`);
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  for (const source of [css, inspectorCSS]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
  const root = dom.window.getComputedStyle(doc.documentElement);
  const painted = el => { for (let p = el; p; p = p.parentElement) { const bg = dom.window.getComputedStyle(p).background; if (/^var\(--/.test(bg)) return bg.slice(6, -1); } return null; };
  for (const host of ['#page', '#side']) for (const [selector, fg] of [['.launch-declared', 'fg'], ['.launch-at', 'muted'], ['.launch-problem-own', 'warn'], ['.launch-problem-said', 'fg'], ['.launch-problem details', 'muted']]) {
    const el = doc.querySelector(`${host} ${selector}`), bg = painted(el);
    assert.equal(dom.window.getComputedStyle(el).color, `var(--${fg})`, `${host} ${selector}`); assert.ok(bg, `${host} ${selector} painted`);
    assert.ok(contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim())) >= 4.5, `${host} ${selector} on ${bg}`);
    for (let p = el; p; p = p.parentElement) assert.equal(dom.window.getComputedStyle(p).opacity, '1');
  }
});

// Team model v2 (0.30, D2): Setup's "Teams on this computer", the soul page's "Teams here",
// the teams panel's "Recently left" head and a spawn team with no provider id yet, on K1's
// example documents (docs/desktop-cli-api.md "Team model v2", feat/030-team-model 8dd82158).
import { createComputerTeams, computerTeamsCSS } from '../renderer/computer-teams.mjs';
import { deploymentScopeCSS } from '../renderer/deployment-scope-line.mjs';
import { createSoulTeamsHere, soulTeamsHereCSS } from '../renderer/soul-teams-here.mjs';
import { teamsCSS } from '../renderer/teams-panel.mjs';
import { setupCSS } from '../renderer/workspace-setup.mjs';
for (const [name] of palettes) test(`${name}: team model v2 cards, left entries, join/leave warnings and unmapped spawn teams meet computed AA`, async t => {
  const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><body><div class="oats-view"><div id="setup"></div><div id="soul"></div>
    <aside class="soul-inspector"><div class="teams-card"><div class="teams-panel"><p class="teams-subhead">Recently left</p><div class="teams-problem teams-warning"><p class="teams-warning-head">Left, with a warning from the messaging provider:</p><p class="teams-warning-text">alias not released</p></div></div></div></aside>
    <div class="spawn-seg spawn-teams-row spawn-team-list"><label class="spawn-team spawn-team-off"><input type="checkbox" disabled><span class="spawn-team-name">reviewers</span></label></div></div></body></html>`, { pretendToBeVisual: true });
  const doc = dom.window.document;
  for (const source of [css, setupCSS, pageCardCSS, computerTeamsCSS, soulTeamsHereCSS, inspectorCSS, teamsCSS, spawnDialogCSS]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
  // The REAL 0.30 kernel (K1 @bba0a9b8, test/fixtures/team-model-v2, #269): shared teams with no id
  // yet (warnings) and release-manager's own unmapped default (the soul page's blocking notice).
  const { teamsData, soulTeamsData } = await import('../../client/deployment-data.mjs');
  const v2 = name => JSON.parse(readFileSync(new URL(`./fixtures/team-model-v2/${name}.json`, import.meta.url), 'utf8'));
  const teams = teamsData(v2('teams-after'), '/fixture/base/northwind-workspace'), soulTeams = soulTeamsData(v2('soul-teams-default'));
  teams.defaultTeam = 'engineering'; for (const r of teams.teams) r.default = r.label === 'engineering'; for (const p of teams.problems) if (p.label === 'engineering') p.default = true; // DERIVED: a blocking default
  // Spec 02: engineering's members on this computer and on a server that was not reached, and the not-reached status line.
  const TEAM = 'engineering:northwind.aweb.ai'; teams.teams.find(t => t.label === 'engineering').team = TEAM;
  const member = (instance, extra = {}) => ({ workspace: '/w', server: null, serverLabel: null, instance, agent: 'engineer', agentsRoot: '/w/agents',
    home: `/w/agents/engineer/instances/${instance}`, team: TEAM, running: true, addressable: true, missingRemotely: false, reason: null, createdAt: null, ...extra });
  const setup = createComputerTeams(doc, { request: async () => structuredClone(teams), readMembers: async () => ({
    members: [member('eng-1'), member('eng-2', { workspace: 'remote:build:1', server: 'build', serverLabel: 'Build box', running: null, reason: 'ssh failed' })],
    servers: [{ server: 'build', label: 'Build box', group: 'build:1', reached: false, error: 'ssh failed', registered: true, souls: [] }],
    notReached: [{ server: 'far', label: 'Far box' }] }) });
  const soul = createSoulTeamsHere(doc, { soul: 'release-manager', request: async () => structuredClone(soulTeams), listTeams: async () => structuredClone(teams) });
  doc.querySelector('#setup').append(setup.element); doc.querySelector('#soul').append(soul.element);
  t.after(() => { setup.dispose(); soul.dispose(); dom.window.close(); });
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  const root = dom.window.getComputedStyle(doc.documentElement);
  for (const [selector, painted, fg, bg] of [
    // The Teams board: one card per team on the surface; the default's tag in the brand tint and where it is set.
    ['.ct-label', '.ct-card', 'fg', 'surface'], ['.ct-desc', '.ct-card', 'muted', 'surface'],
    ['[data-team="mine"] dd.ct-address', '.ct-card', 'muted', 'surface'], ['dd.ct-address.none', '.ct-card', 'warn', 'surface'],
    ['.ct-tag', '.ct-tag', 'accent', 'sel'], ['.ct-from', '.ct-card', 'muted', 'surface'], ['.ct-why', '.ct-card', 'muted', 'surface'],
    ['.ct-fact dt', '.ct-card', 'muted', 'surface'], ['.ct-join:not(.none)', '.ct-card', 'fg', 'surface'], ['.ct-join.none', '.ct-card', 'muted', 'surface'],
    // A team's warning: its own box in the attention tint, the message and the fix in --fg.
    ['.ct-card .ct-warn', '.ct-card .ct-warn', 'fg', 'attn-bg'], ['.ct-warn-msg', '.ct-card .ct-warn', 'fg', 'attn-bg'], ['.ct-warn .ct-fix', '.ct-card .ct-warn', 'fg', 'attn-bg'],
    // The foot: engineering's count, the members elsewhere, and the machine not reached.
    ['.ct-sum-count', '.ct-card', 'fg', 'surface'], ['.ct-sum-more', '.ct-card', 'muted', 'surface'], ['.ct-sum-warn', '.ct-card', 'warn', 'surface'],
    ['button.ct-act:not(:disabled)', 'button.ct-act:not(:disabled)', 'fg', 'surface'], ['button.ct-act:disabled', 'button.ct-act:disabled', 'muted', 'surface'],
    ['.sth-default', '.soul-teams-here', 'fg', 'surface'], ['.sth-default .sth-why', '.soul-teams-here', 'muted', 'surface'],
    ['.sth-label', '.soul-teams-here', 'fg', 'surface'], ['.sth-meta:not(.warn)', '.soul-teams-here', 'muted', 'surface'],
    ['.sth-meta.warn', '.soul-teams-here', 'warn', 'surface'], ['button.sth-act', 'button.sth-act', 'fg', 'surface'],
    ['.ct-blocking', '.ct-card', 'muted', 'surface'], ['.ct-blocking strong', '.ct-card', 'fg', 'surface'],
    ['.sth-blocking', '.soul-teams-here', 'muted', 'surface'], ['.sth-blocking strong', '.soul-teams-here', 'fg', 'surface'],
    ['.teams-subhead', '.soul-inspector', 'muted', 'surface'],
    ['.teams-warning-head', '.soul-inspector', 'warn', 'surface'], ['.teams-warning-text', '.soul-inspector', 'fg', 'surface'],
    ['.spawn-team-off .spawn-team-name', '.spawn-teams-row', 'muted', 'surface'],
  ]) {
    const el = doc.querySelector(selector), surface = doc.querySelector(painted); assert.ok(el && surface, selector);
    assert.equal(dom.window.getComputedStyle(el).color, `var(--${fg})`, selector);
    assert.equal(dom.window.getComputedStyle(surface).background.replace(/^.*(var\(--[\w-]+\)).*$/, '$1'), `var(--${bg})`, painted);
    assert.ok(contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim())) >= 4.5, selector);
    for (let parent = el; parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, '1');
  }
  // The section heads sit on the page's --bg (no painted element in jsdom): the declared colour, then the token pair.
  for (const [selector, fg] of [['.ct-section-title', 'fg'], ['.ct-section-lead', 'muted']]) {
    const el = doc.querySelector(selector); assert.ok(el, selector);
    assert.equal(dom.window.getComputedStyle(el).color, `var(--${fg})`, selector);
    assert.ok(contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue('--bg').trim())) >= 4.5, `${selector} on bg`);
    for (let parent = el; parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, '1');
  }
  // The team page's Terminal lights in the accent on hover, over its --surface rest and a --surface-2 row hover.
  const rule = selector => [...doc.styleSheets].flatMap(sheet => [...sheet.cssRules]).find(r => r.selectorText === selector)?.style;
  const lit = rule('.oats-view .computer-teams button.ct-member-term:hover');
  assert.equal(lit.getPropertyValue('border-color'), 'var(--accent)'); assert.equal(lit.color, 'var(--accent)');
  for (const bg of ['surface', 'surface-2']) assert.ok(contrast(opaqueChannels(root.getPropertyValue('--accent').trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim())) >= 4.5, `Terminal lit on ${bg}`);
  // The not-reached line is the page head's lead style: the same colour on the same ground.
  assert.equal(dom.window.getComputedStyle(doc.querySelector('.ct-reach')).color, dom.window.getComputedStyle(doc.querySelector('.ct-lead')).color);
  assert.ok(doc.querySelector('.ct-reach').textContent.includes('Far box'));
});

// Spec A (Teams says whose default it is): team model 3's card rows (Default for, May join, a quiet fallback),
// the address, the nobody line, the openable card's label and foot, the closed local teams' sentence and the
// souls: table, on a teamsApi 2 document shaped like the lab rig.
for (const [name] of palettes) test(`${name}: team model 3 card facts, address, foot and souls table meet computed AA`, async t => {
  const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><body><div class="oats-view"></div></body></html>`, { pretendToBeVisual: true });
  const doc = dom.window.document;
  for (const source of [css, computerTeamsCSS]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
  const team = (label, extra = {}) => ({ label, team: `${label}:lab.aweb.ai`, description: null, from: 'shared', default: false, at: 'x', ...extra });
  const document = { teamsApi: 2, deployment: '/d', localTeams: false, problems: [],
    defaultTeam: { label: 'lab-all', team: null, from: 'workspace' },
    teams: [team('lab-all', { team: null, default: true }), team('lab-ai-team'), team('idle'), team('lone')],
    souls: { '*': { default: 'idle', teams: [] }, 'lab-ai-engineering/*': { default: 'lab-ai-team', teams: ['lab-all'] } } };
  const TEAM = 'lab-ai-team:lab.aweb.ai';
  const page = createComputerTeams(doc, { request: async () => structuredClone(document), readMembers: async () => ({ members: [{ workspace: '/d', server: null, serverLabel: null,
    instance: 'ai-reviewer', agent: 'ai-reviewer', agentsRoot: '/d/agents', home: '/d/agents/ai-reviewer/instances/ai-reviewer', team: TEAM, running: true, addressable: true, missingRemotely: false, reason: null }], servers: [], notReached: [] }),
    onOpenTeam: () => {} });
  doc.querySelector('.oats-view').append(page.element);
  t.after(() => { page.dispose(); dom.window.close(); });
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  const root = dom.window.getComputedStyle(doc.documentElement);
  for (const [selector, painted, fg, bg] of [
    ['[data-team="lab-ai-team"] .ct-fact dt', '.ct-card', 'muted', 'surface'],
    ['[data-team="lab-ai-team"] .ct-fact[data-fact=default] dd', '.ct-card', 'fg', 'surface'],
    ['[data-team="lab-ai-team"] .ct-fact[data-fact=default] .ct-name', '.ct-card', 'fg', 'surface'],
    ['[data-team="lab-all"] .ct-fact[data-fact=join] dd', '.ct-card', 'muted', 'surface'],
    ['[data-team="lab-all"] .ct-fact[data-fact=join] .ct-name', '.ct-card', 'muted', 'surface'],
    ['[data-team="lab-all"] .ct-quiet', '.ct-card', 'muted', 'surface'],
    ['[data-team="lab-ai-team"] dd.ct-address', '.ct-card', 'muted', 'surface'], ['dd.ct-address.none', '.ct-card', 'warn', 'surface'],
    ['[data-team="lone"] .ct-fact[data-fact=join] dd.none', '.ct-card', 'muted', 'surface'],
    // The workspace's default: its tag in the brand tint, and where it is set.
    ['[data-team="lab-all"] .ct-tag', '[data-team="lab-all"] .ct-tag', 'accent', 'sel'], ['[data-team="lab-all"] .ct-from', '.ct-card', 'muted', 'surface'],
    // The card opens its team's page: the label's button, the foot's count, "None of your instances" and the cue.
    ['.ct-name-h button.ct-open', '.ct-card', 'fg', 'surface'], ['[data-team="lab-ai-team"] .ct-sum-count', '.ct-card', 'fg', 'surface'],
    ['[data-team="idle"] .ct-sum-more', '.ct-card', 'muted', 'surface'], ['.ct-go', '.ct-card', 'muted', 'surface'],
    // The souls: table in its card: the headers, the pattern (its folder muted, "* every soul"), the team chips and "none".
    ['.ct-souls th', '.ct-souls-card', 'muted', 'surface'], ['.ct-pattern', '.ct-souls-card', 'fg', 'surface'],
    ['.ct-pattern-dir', '.ct-souls-card', 'muted', 'surface'], ['.ct-every', '.ct-souls-card', 'muted', 'surface'],
    ['.ct-souls .ct-chip', '.ct-souls .ct-chip', 'fg', 'tag-bg'], ['.ct-souls .ct-none', '.ct-souls-card', 'muted', 'surface'],
  ]) {
    const el = doc.querySelector(selector), surface = doc.querySelector(painted); assert.ok(el && surface, selector);
    assert.equal(dom.window.getComputedStyle(el).color, `var(--${fg})`, selector);
    assert.equal(dom.window.getComputedStyle(surface).background.replace(/^.*(var\(--[\w-]+\)).*$/, '$1'), `var(--${bg})`, painted);
    assert.ok(contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim())) >= 4.5, selector);
    for (let parent = el; parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, '1');
  }
  // Local teams closed and none left: the sentence in their place sits on the page's --bg (no painted element in jsdom).
  const dashed = doc.querySelector('[data-section=local] p.ct-dashed'); assert.ok(dashed, 'the closed sentence');
  assert.equal(dom.window.getComputedStyle(dashed).color, 'var(--muted)');
  assert.ok(contrast(opaqueChannels(root.getPropertyValue('--muted').trim()), opaqueChannels(root.getPropertyValue('--bg').trim())) >= 4.5, '.ct-dashed on bg');
  for (let parent = dashed; parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, '1');
});

// Round 5: a team's page (showTeam): the counts and the default note on the page's --bg, each machine's head band on
// --surface-2 (an unreached one in the warn colour), the table's header and rows on --surface (and --surface-2 under a
// row's hover), the dimmed soul prefix, and the pill words on --sel, --attn-bg and no fill. No scope line: the
// Workspace pages show no "On <deployment>" line (the product owner, 2026-10-23).
for (const [name] of palettes) test(`${name}: a team's page (counts, machine cards, instance rows and pills) meets computed AA`, async t => {
  const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><body><div class="oats-view"><div class="board"></div><section class="workspace-page"></section></div></body></html>`, { pretendToBeVisual: true });
  const doc = dom.window.document;
  for (const source of [css, computerTeamsCSS, identityCSS, deploymentScopeCSS]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
  const document = { teamsApi: 2, deployment: '/w', localTeams: false, problems: [], souls: {},
    defaultTeam: { label: 'eng', team: 'eng:acme.aweb.ai', from: 'workspace' },
    teams: [{ label: 'eng', team: 'eng:acme.aweb.ai', description: 'Engineering', from: 'shared', default: true, at: 'x' }] };
  const member = (instance, extra = {}) => ({ workspace: '/w', server: null, serverLabel: null, instance, agent: 'acme/dev', agentsRoot: '/w/agents',
    home: `/w/agents/dev/instances/${instance}`, team: 'eng:acme.aweb.ai', running: true, addressable: true, missingRemotely: false, reason: null, reasonLabel: null,
    createdAt: '2026-10-14T10:00:00.000Z', ...extra });
  const far = (instance, server, extra = {}) => member(instance, { workspace: `remote:${server}:1`, server, serverLabel: server, ...extra });
  const HERE = { id: '/w', machine: 'This Mac', path: '/Users/ana/Agents/acme' };
  const roster = { members: [member('dev-1', { deployment: { ...HERE } }), member('dev-2', { running: false, addressable: false, deployment: { ...HERE } }),
    far('dev-3', 'build', { running: true, addressable: false, reason: 'not-addressable', reasonLabel: 'not reachable on build' }), far('dev-4', 'down', { running: null })],
  servers: [{ server: 'build', label: 'build', group: 'build:1', reached: true, error: null, registered: true },
    { server: 'down', label: 'down', group: 'down:1', reached: false, error: 'ssh failed', registered: true }], notReached: [] };
  const teams = createComputerTeams(doc, { request: async () => structuredClone(document), readMembers: async () => structuredClone(roster), onOpenTeam: () => {} });
  doc.querySelector('.board').append(teams.element);
  t.after(() => { teams.dispose(); dom.window.close(); });
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  const host = doc.querySelector('.workspace-page');
  assert.equal(teams.showTeam(host, 'eng', { onBack: () => {} }), true);
  const root = dom.window.getComputedStyle(doc.documentElement);
  const pair = (fg, bg, what) => assert.ok(contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim())) >= 4.5, `${what}: ${fg} on ${bg}`);
  const opaque = el => { for (let parent = el; parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, '1'); };
  const rows = [
    // The team's card on its page: the label.
    ['h2.ct-page-label', '.ct-page-card', 'fg', 'surface'],
    // A machine's head band.
    ['.ct-mcard:not(.unreached) .ct-mcard-head', '.ct-mcard:not(.unreached) .ct-mcard-head', 'muted', 'surface-2'],
    ['.ct-mcard:not(.unreached) .ct-machine', '.ct-mcard:not(.unreached) .ct-mcard-head', 'fg', 'surface-2'],
    ['.ct-mcard:not(.unreached) .ct-path', '.ct-mcard:not(.unreached) .ct-mcard-head', 'muted', 'surface-2'],
    ['.ct-mcard:not(.unreached) .ct-mcard-count', '.ct-mcard:not(.unreached) .ct-mcard-head', 'muted', 'surface-2'],
    ['.ct-mcard.unreached .ct-machine', '.ct-mcard.unreached .ct-mcard-head', 'warn', 'surface-2'],
    ['.ct-mcard.unreached .ct-mcard-count', '.ct-mcard.unreached .ct-mcard-head', 'warn', 'surface-2'],
    // The table: its header row, the name (the soul's prefix steps back), the soul, the age.
    ['.ct-irow.ct-ihead', '.ct-mcard', 'muted', 'surface'], ['.ct-name-pre', '.ct-mcard', 'muted', 'surface'], ['.ct-name-tail', '.ct-mcard', 'fg', 'surface'],
    ['.ct-isoul', '.ct-mcard', 'muted', 'surface'], ['.ct-age', '.ct-mcard', 'muted', 'surface'],
    // The state pill: Running on --sel, Stopped with no fill, a warn word on --attn-bg; and Terminal, on its own --surface.
    ['.ct-member-state.run', '.ct-member-state.run', 'fg', 'sel'], ['.ct-member-state.stop', '.ct-mcard', 'muted', 'surface'],
    ['.ct-member-state.warn', '.ct-member-state.warn', 'warn', 'attn-bg'], ['button.ct-member-term', 'button.ct-member-term', 'fg', 'surface'],
  ];
  for (const [selector, painted, fg, bg] of rows) {
    const el = host.querySelector(selector), surface = host.querySelector(painted); assert.ok(el && surface, selector);
    assert.equal(dom.window.getComputedStyle(el).color, `var(--${fg})`, selector);
    assert.equal(dom.window.getComputedStyle(surface).background.replace(/^.*(var\(--[\w-]+\)).*$/, '$1'), `var(--${bg})`, painted);
    pair(fg, bg, selector); opaque(el);
  }
  assert.deepEqual([...host.querySelectorAll('.ct-member-state .ct-state-word')].map(w => w.textContent), ['Running', 'Stopped', 'not reachable on build', 'unknown']);
  assert.equal(host.querySelector('.deployment-scope'), null, 'no scope line on the team page');
  // A row's hover lays --surface-2 under its text: every colour on a row that has no fill of its own holds there too.
  const rule = selector => [...doc.styleSheets].flatMap(sheet => [...sheet.cssRules]).find(r => r.selectorText === selector)?.style;
  assert.equal(rule('.computer-teams .ct-irow:not(.ct-ihead):hover').background, 'var(--surface-2)');
  for (const fg of ['fg', 'muted', 'warn']) pair(fg, 'surface-2', 'row hover');
  // The counts and the default note sit on the page's --bg (no painted element in jsdom): the declared colour, then the token pair.
  for (const [selector, fg] of [['.ct-yours-sum', 'muted'], ['.ct-yours-sum b', 'fg'], ['.ct-yours-sum .warn', 'warn'], ['.ct-yours-sum .warn b', 'warn'], ['.ct-default-note', 'muted']]) {
    const el = host.querySelector(selector); assert.ok(el, selector);
    assert.equal(dom.window.getComputedStyle(el).color, `var(--${fg})`, selector);
    pair(fg, 'bg', selector); opaque(el);
  }
});

// v4.1 cleanup (boards 1 and 2): the instance panel's header chip and soul link, the Work card's sentence
// and Paths (Spec A), the Messaging & Teams parts and compact team rows, and the Git tab's cards, badges and empty state.
for (const [name] of palettes) test(`${name}: v4.1 instance panel, compact Messaging rows and Git tab cards meet computed AA`, t => {
  const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><body><div id="context-panel" class="context-panel"><div class="context-panel-page">
    <div class="context-panel-identity"><span class="context-panel-identity-sub"><button class="context-panel-soul-link">dev</button><span class="context-panel-drift">older build</span></span>
      <span class="context-panel-state" data-state="running"><span>Running</span><span>· 42m</span></span><span id="stopped" class="context-panel-state" data-state="stopped">Stopped</span></div>
    <div class="context-panel-work"><div class="context-panel-work-main"><span class="context-panel-mode-tile"></span><p class="context-panel-work-sentence">Works in its own worktree of <span class="context-panel-fact-code">oats</span>, on branch <span class="context-panel-fact-code">main</span>.</p></div>
      <details class="context-panel-paths"><summary>Paths</summary><dl class="context-panel-facts"><div class="context-panel-fact"><dt>Home</dt><dd><div class="context-panel-pathline"><div class="context-panel-path">/h</div></div></dd></div></dl></details></div>
    <div class="context-panel-session"><div class="context-panel-session-lines">Claude</div><p class="context-panel-session-note context-panel-note">This agent's Claude questions and permission requests don't show as needs input: its oats.core (oats.framework 1.5.9) is older than 2.4.0. Upgrade or respawn it to report them.</p></div>
    <section class="context-panel-section"><div class="context-panel-section-head"><div class="context-panel-label">Messaging &amp; Teams</div></div>
      <div class="context-panel-part"><div class="context-panel-sublabel">Messaging ID</div><div class="context-panel-idline"><span class="context-panel-id">team/dev-1</span></div></div><div id="teams-sublabel" class="context-panel-sublabel">Teams</div>
      <section class="teams-panel is-compact"><p class="teams-note teams-intro">The messaging teams this soul is allowed to join. It is always in the default team.</p><div class="teams-card"><div class="team-row"><div class="team-main"><div class="team-name">oats<span class="team-tag">default</span></div><div class="team-meta">oats:team</div></div><span class="team-badge">Always on</span></div>
        <div class="team-row"><div class="team-main"><div class="team-name">eng</div></div><button class="team-action" data-team-action="leave">Leave</button></div>
        <div class="team-row"><div class="team-main"><div class="team-name">product</div><div class="team-meta">eligible</div></div><button class="team-action" data-team-action="join">Join</button></div>
        <p class="teams-note">No other teams available to this soul.</p></div></section></section>
    <div class="instance-git"><div class="git-files git-card"><button class="git-file"><span class="git-letter git-letter-add">A</span><span class="git-file-path">a</span></button>
      <button class="git-file"><span class="git-letter git-letter-mod">M</span></button><button class="git-file"><span class="git-letter git-letter-del">D</span></button><button class="git-file"><span id="rename" class="git-letter">R</span></button></div>
      <p class="git-note git-dashed">No uncommitted changes.</p>
      <div class="git-empty git-dashed"><span class="git-empty-title">No Git for this instance</span><span class="git-empty-why">plain folder</span></div><p class="git-empty-note">in <b>worktree</b> mode</p>
      <div class="git-footer"><span>Checked just now</span><button class="git-link">Refresh</button></div>
      <section class="git-github"><div class="forge-pr-card git-card"><div class="forge-head"><span class="forge-title-row"><span class="forge-state">Open</span><span class="forge-title">Title</span></span><span class="forge-sub">#1</span></div></div></section></div>
  </div></div></body></html>`, { pretendToBeVisual: true });
  const doc = dom.window.document;
  for (const source of [css, contextPanelCSS, teamsCSS, instanceGitCSS]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
  t.after(() => dom.window.close());
  const root = dom.window.getComputedStyle(doc.documentElement);
  for (const [selector, painted, fg, bg] of [
    ['.context-panel-soul-link', '#context-panel', 'accent', 'surface'],
    ['.context-panel-drift', '.context-panel-drift', 'fg', 'tag-bg'],
    ['.context-panel-state[data-state=running]', '#context-panel', 'accent', 'surface'],
    ['#stopped', '#context-panel', 'muted', 'surface'],
    // Spec A: the Work card's sentence and its mono facts, the Paths disclosure, the Messaging & Teams parts.
    ['.context-panel-work-sentence', '.context-panel-work', 'fg', 'surface'],
    ['.context-panel-session-note', '.context-panel-session', 'muted', 'surface'],
    ['.context-panel-fact-code', '.context-panel-work', 'fg', 'surface'],
    ['.context-panel-paths > summary', '.context-panel-work', 'muted', 'surface'],
    ['.context-panel-paths dt', '.context-panel-work', 'muted', 'surface'],
    ['.context-panel-paths dd', '.context-panel-work', 'fg', 'surface'],
    ['.context-panel-label', '#context-panel', 'muted', 'surface'],
    ['.context-panel-sublabel', '#context-panel', 'muted', 'surface'],
    ['#teams-sublabel', '#context-panel', 'muted', 'surface'],
    ['.context-panel-id', '#context-panel', 'fg', 'surface'],
    ['.is-compact .teams-intro', '#context-panel', 'muted', 'surface'],
    ['.is-compact .team-name', '#context-panel', 'fg', 'surface'],
    ['.is-compact .team-tag', '.is-compact .team-tag', 'muted', 'tag-bg'],
    ['.is-compact .team-meta', '#context-panel', 'muted', 'surface'],
    ['.is-compact .team-badge', '#context-panel', 'muted', 'surface'],
    ['.is-compact .team-action[data-team-action=leave]', '#context-panel', 'muted', 'surface'],
    ['.is-compact .team-action[data-team-action=join]', '#context-panel', 'accent', 'surface'],
    ['.is-compact .teams-note', '#context-panel', 'muted', 'surface'],
    ['.git-letter-add', '#context-panel', 'ok', 'surface'],
    ['.git-letter-mod', '#context-panel', 'warn', 'surface'],
    ['.git-letter-del', '#context-panel', 'danger', 'surface'],
    ['#rename', '#context-panel', 'muted', 'surface'],
    ['.git-note.git-dashed', '#context-panel', 'muted', 'surface'],
    ['.git-empty-title', '#context-panel', 'fg', 'surface'],
    ['.git-empty-why', '#context-panel', 'muted', 'surface'],
    ['.git-empty-note', '#context-panel', 'muted', 'surface'],
    ['.git-empty-note b', '#context-panel', 'fg', 'surface'],
    ['.git-footer', '#context-panel', 'muted', 'surface'],
    ['.git-footer .git-link', '#context-panel', 'accent', 'surface'],
    ['.forge-state', '.forge-state', 'fg', 'tag-bg'],
    ['.forge-sub', '#context-panel', 'muted', 'surface'],
  ]) {
    const el = doc.querySelector(selector), surface = doc.querySelector(painted); assert.ok(el && surface, selector);
    assert.equal(dom.window.getComputedStyle(el).color, `var(--${fg})`, selector);
    assert.equal(dom.window.getComputedStyle(surface).background.replace(/^.*(var\(--[\w-]+\)).*$/, '$1'), `var(--${bg})`, painted);
    // Every surface between the text and its painted ground is transparent (no other ground intervenes).
    if (surface !== el) for (let parent = el.parentElement; parent && parent !== surface; parent = parent.parentElement) {
      const background = dom.window.getComputedStyle(parent).background;
      assert.ok(!/var\(--/.test(background) || background.includes(`var(--${bg})`), `${selector}: ${parent.className} paints ${background}`);
    }
    assert.ok(contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim())) >= 4.5, `${selector}: ${fg} on ${bg}`);
    for (let parent = el; parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, '1');
  }
});

// The reconnect strip overlays the pane's top rows (no layout change, so no refit) and never
// dims the terminal under it. Driven into both strip states through the real terminal tab.
for (const [name] of palettes) test(`${name}: the remote reconnect strip and its button meet computed AA and overlay the pane`, async t => {
  const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><body><div class="term-wrap"></div></body></html>`), doc = dom.window.document;
  t.after(() => dom.window.close());
  for (const source of [css, readFileSync(new URL('shell.css', renderer), 'utf8')]) {
    const style = doc.createElement('style'); style.textContent = source; doc.head.append(style);
  }
  const wrap = doc.querySelector('.term-wrap'), exits = [], gate = new Promise(() => {});
  let opens = 0, timers = [];
  const h = Object.freeze({ id: 1, lease: '1'.padStart(64, '0') });
  const tab = createTerminalTab({
    wrap, remote: { serverId: 'build', instance: 'dev', home: '/srv/dev' }, serverLabel: 'Build box',
    isActive: () => true, fit() {}, observe: () => () => {},
    clock: { now: () => 0, setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {} },
    term: { cols: 80, rows: 24, options: {}, onData: () => ({}), onResize: () => ({}), focus() {}, dispose() {}, write() {} },
    desk: {
      termOpen: async () => (++opens === 1 ? { terminalApi: 2, ok: true, status: 'opened', handle: h } : gate),
      termReady: async () => ({ terminalApi: 2, ok: true, status: 'ready', handle: h }),
      termClose: async () => ({ terminalApi: 2, ok: true, status: 'closed', handle: h }),
      termResize() {}, termWrite() {}, onTermData: () => () => {}, onTermExit: (_h, cb) => { exits.push(cb); return () => {}; },
    },
  });
  await tab.start();
  exits[0]({ terminalApi: 2, status: 'ended', handle: h, cleanupPending: false, exitCode: 255, reason: null });
  const root = dom.window.getComputedStyle(doc.documentElement), style = el => dom.window.getComputedStyle(el);
  const aa = (fg, bg, what) => assert.ok(contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()),
    opaqueChannels(root.getPropertyValue(`--${bg}`).trim())) >= 4.5, `${name} ${what}: --${fg} on --${bg}`);
  const strip = doc.querySelector('.term-reconnect'), text = doc.querySelector('.term-reconnect-text'), button = strip.querySelector('button');
  assert.equal(style(strip).position, 'absolute'); assert.equal(style(strip).top, '0px');
  assert.equal(style(strip).left, '0px'); assert.equal(style(strip).right, '0px');
  assert.equal(style(strip).background, 'var(--surface)');
  assert.equal(style(text).color, 'var(--fg)'); aa('fg', 'surface', 'strip text');
  assert.equal(style(button).color, 'var(--fg)'); assert.equal(style(button).background, 'var(--surface)'); aa('fg', 'surface', 'Reconnect now');
  // jsdom's :focus-visible needs a modifier-free keydown, and its style cache a mutation.
  button.focus(); button.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  button.setAttribute('data-focus-probe', ''); button.removeAttribute('data-focus-probe');
  assert.equal(doc.activeElement, button); assert.ok(button.matches(':focus-visible'));
  assert.equal(style(button).background, 'var(--sel)', 'keyboard focus paints the tint');
  assert.equal(style(button).color, 'var(--fg)'); aa('fg', 'sel', 'focused Reconnect now');
  for (const el of [text, button, wrap]) for (let node = el; node; node = node.parentElement) assert.equal(style(node).opacity, '1');
  const live = doc.querySelector('.term-live');
  assert.equal(style(live).position, 'absolute'); assert.equal(style(live).width, '1px'); assert.equal(style(live).overflow, 'hidden');
  button.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(text.textContent, 'Reconnecting to Build box…');
  assert.equal(style(button).color, 'var(--fg)', 'an attempt in flight keeps the button legible'); aa('fg', 'surface', 'busy Reconnect now');
});

// Spec C: the capability page's Contents — navigation (on the card's surface; the open file on --sel, a hovered
// row on --surface-2) and the reader (the Markdown viewer's own ground, --bg) with its header and front-matter table.
import { createCapabilityContents, capabilityContentsCSS } from '../renderer/capability-contents.mjs';
import { MARKDOWN_CSS } from '../renderer/views/markdown.mjs';
import { fillTriggerSourcesRow } from '../renderer/capability-page.mjs';
import { sourceQuoteCSS as capabilityQuoteCSS } from '../renderer/source-quote.mjs';
for (const [name] of palettes) test(`${name}: capability Contents navigation, reader header, notes and front matter meet computed AA`, async () => {
  const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><body><div class="oats-view"><section class="host"></section></div></body></html>`, { pretendToBeVisual: true });
  const doc = dom.window.document;
  for (const source of [css, pageCardCSS, capabilityPageCSS, capabilityQuoteCSS, capabilityContentsCSS, MARKDOWN_CSS]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
  const commit = 'a'.repeat(40);
  const show = { capabilityShowApi: 1, name: 'oats.aweb', kind: 'package', repoKey: null, package: 'oats.aweb', version: '1', commit, path: 'p',
    inject: { path: 'inject.md', bytes: 300000, text: '---\nname: x\n---\n# T\n\n[a](https://example.com)\n', binary: false, truncated: true },
    skills: [{ name: 'oats-aweb', path: 'skills/oats-aweb', description: 'The playbook. More.', files: [{ path: 'skills/oats-aweb/SKILL.md', bytes: 1 }], filesTruncated: true }],
    problems: [{ code: 'W_X', message: 'a problem', path: 'inject.md' }] };
  const contents = createCapabilityContents(doc, { request: () => Promise.resolve(structuredClone(show)), openExternal() {} });
  const host = doc.querySelector('.host'); host.className = 'capability-page'; host.append(contents.element);
  contents.update({ row: { name: 'oats.aweb', kind: 'package', package: 'oats.aweb', commit }, cli: { ok: true, features: ['capability-show'], capabilityShowApi: 1 }, deployment: '/ws' });
  await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
  doc.querySelector('[data-skill] > .cap-node').click();
  const gate = doc.createElement('p'); gate.className = 'cap-contents-gate'; gate.textContent = 'gate'; host.append(gate);
  const notes = doc.createElement('p'); notes.className = 'cap-contents-note'; notes.textContent = 'none'; doc.querySelector('.cap-contents-nav').append(notes);
  const line = doc.createElement('p'); line.className = 'cap-reader-line'; line.textContent = 'Binary file; not shown.'; doc.querySelector('.cap-reader-body').append(line);
  const root = dom.window.getComputedStyle(doc.documentElement);
  for (const [selector, painted, fg, bg] of [
    ['.page-section-lead', '.oats-view', 'muted', 'bg'],
    ['.cap-contents-gate', '.oats-view', 'muted', 'bg'],
    ['.cap-contents-group-label', '.cap-contents', 'muted', 'surface'],
    ['.cap-contents-note', '.cap-contents', 'muted', 'surface'],
    ['.cap-contents-problem', '.cap-contents', 'muted', 'surface'],
    ['.cap-contents-problem .mono', '.cap-contents', 'fg', 'surface'],
    ['[aria-selected=true] .cap-node-name', '[aria-selected=true] > .cap-node', 'fg', 'sel'],
    ['[aria-selected=true] .cap-node-file', '[aria-selected=true] > .cap-node', 'muted', 'sel'],
    ['[data-skill] .cap-node-name', '.cap-contents', 'fg', 'surface'],
    ['.cap-node-desc', '.cap-contents', 'muted', 'surface'],
    ['.cap-node-twisty', '.cap-contents', 'muted', 'surface'],
    ['.cap-more', '.cap-contents', 'muted', 'surface'],
    ['.cap-reader-path', '.cap-reader-head', 'fg', 'bg'],
    ['.cap-reader-size', '.cap-reader-head', 'muted', 'bg'],
    ['.cap-reader-flag', '.cap-reader-head', 'warn', 'bg'],
    ['.cap-fm th', '.cap-contents-reader', 'muted', 'bg'],
    ['.cap-fm td', '.cap-contents-reader', 'fg', 'bg'],
    ['.cap-reader-line', '.cap-contents-reader', 'muted', 'bg'],
    ['.cap-reader-body .mdv a', '.cap-contents-reader', 'accent', 'bg'],
  ]) {
    const el = doc.querySelector(selector), surface = doc.querySelector(painted); assert.ok(el && surface, selector);
    const color = dom.window.getComputedStyle(el).color;
    assert.ok(color === `var(--${fg})` || (fg === 'fg' && ['', 'var(--fg)'].includes(color)), `${selector}: ${color}`);
    assert.equal(dom.window.getComputedStyle(surface).background.replace(/^.*(var\(--[\w-]+\)).*$/, '$1') || 'var(--bg)', `var(--${bg})`, painted);
    assert.ok(contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim())) >= 4.5, `${name} ${selector}`);
    for (let parent = el; parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, '1');
  }
  // Provides: one card, a row per kind, every name its own code chip.
  const page = doc.createElement('section'); doc.querySelector('.oats-view').append(page);
  renderCapabilityPage(page, { row: { name: 'oats.aweb', kind: 'package', package: 'oats.aweb', skills: ['oats-aweb'], commands: ['join'], hooks: [] }, status: null, instances: [], root: '/ws', onBack() {} });
  for (const [selector, painted, fg, bg] of [['.provides-chip', '.provides-chip', 'fg', 'tag-bg'], ['.provides-kind', '.provides-card', 'muted', 'surface'], ['.provides-items .page-note', '.provides-card', 'muted', 'surface']]) {
    const el = page.querySelector(selector), surface = page.querySelector(painted); assert.ok(el && surface, selector);
    const color = dom.window.getComputedStyle(el).color;
    assert.ok(color === `var(--${fg})` || (fg === 'fg' && ['', 'var(--fg)'].includes(color)), `${selector}: ${color}`);
    assert.equal(dom.window.getComputedStyle(surface).background.replace(/^.*(var\(--[\w-]+\)).*$/, '$1'), `var(--${bg})`, painted);
    assert.ok(contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim())) >= 4.5, `${name} ${selector}`);
  }
  // Provides › Trigger sources (feature trigger-sources): the manifest's words quoted (the lead-in, the text, the kernel's
  // note under it), and the plain lines of a declaration that can't be read (the Desktop's, then the kernel's).
  const quoted = doc.createElement('div'), unreadable = doc.createElement('div');
  fillTriggerSourcesRow(quoted, { sources: [{ name: 'harvest-branches', events: ['opened', 'updated'], description: 'Ready harvest branches', problems: [] },
    { name: 'Bad Name', events: null, description: null, problems: ['trigger source "Bad Name": must be an object'] }] });
  fillTriggerSourcesRow(unreadable, { unreadable: ['triggerSources must be an object of named trigger sources'] });
  for (const [sources, inventory] of [
    [quoted, [['.provides-kind', '.provides-card', 'muted', 'surface'], ['.source-quote-lead', '.provides-card', 'muted', 'surface'], ['.source-quote-text', '.provides-card', 'fg', 'surface'], ['.source-quote-note', '.provides-card', 'muted', 'surface']]],
    [unreadable, [['.provides-unreadable', '.provides-card', 'fg', 'surface'], ['.provides-unreadable-why', '.provides-card', 'muted', 'surface']]],
  ]) {
    renderCapabilityPage(page, { row: { name: 'oats.aweb', kind: 'package', package: 'oats.aweb' }, status: null, instances: [], root: '/ws', onBack() {}, triggerSources: sources });
    for (const [selector, painted, fg, bg] of inventory) {
      const el = page.querySelector(`[data-provides="trigger-sources"] ${selector}`), surface = page.querySelector(painted); assert.ok(el && surface, selector);
      const color = dom.window.getComputedStyle(el).color;
      assert.ok(color === `var(--${fg})` || (fg === 'fg' && ['', 'var(--fg)'].includes(color)), `${selector}: ${color}`);
      assert.equal(dom.window.getComputedStyle(surface).background.replace(/^.*(var\(--[\w-]+\)).*$/, '$1'), `var(--${bg})`, painted);
      assert.ok(contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim())) >= 4.5, `${name} ${selector}`);
      for (let parent = el; parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, '1');
    }
  }
  // The facts table drops the viewer's Markdown-table chrome: its cells sit on the reader's own ground.
  for (const cell of doc.querySelectorAll('.cap-fm th, .cap-fm td')) assert.match(dom.window.getComputedStyle(cell).background, /none|rgba\(0, 0, 0, 0\)/, 'no tinted head');
  // A hovered row (--surface-2) keeps its muted second line legible too.
  assert.ok(contrast(opaqueChannels(root.getPropertyValue('--muted').trim()), opaqueChannels(root.getPropertyValue('--surface-2').trim())) >= 4.5, `${name} muted on surface-2`);
  contents.dispose(); dom.window.close();
});

// Spec D (B1): the soul page's Instructions — the Contents card's grammar on the soul page, its own copy (the
// group label, the file's repository path, the truncated flag, the unreadable line) on the same grounds.
import { createSoulInstructions, soulInstructionsCSS } from '../renderer/soul-instructions.mjs';
for (const [name] of palettes) test(`${name}: the soul page's Instructions section meets computed AA without opacity`, () => {
  const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><body><div class="oats-view"><div class="workspace-page soul-page"><div class="inspector-content inspector-main"></div></div></div></body></html>`, { pretendToBeVisual: true });
  const doc = dom.window.document;
  for (const source of [css, inspectorCSS, pageCardCSS, capabilityPageCSS, capabilityContentsCSS, soulInstructionsCSS, MARKDOWN_CSS]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
  const section = createSoulInstructions(doc, { openExternal() {}, canOpenCapability: () => true, openCapability() {} }); doc.querySelector('.inspector-main').append(section.element);
  const soul = text => ({ name: 'release-manager', path: 'souls/release-manager', instructions: { file: '/cache/AGENTS.md', text, truncated: true } });
  section.update(soul('---\nname: x\n---\n# T\n\n[a](https://example.com)\n'));
  const root = dom.window.getComputedStyle(doc.documentElement);
  const check = list => { for (const [selector, painted, fg, bg] of list) {
    const el = doc.querySelector(selector), surface = doc.querySelector(painted); assert.ok(el && surface, selector);
    const color = dom.window.getComputedStyle(el).color;
    assert.ok(color === `var(--${fg})` || (fg === 'fg' && ['', 'var(--fg)'].includes(color)), `${selector}: ${color}`);
    assert.equal(dom.window.getComputedStyle(surface).background.replace(/^.*(var\(--[\w-]+\)).*$/, '$1') || 'var(--bg)', `var(--${bg})`, painted);
    assert.ok(contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim())) >= 4.5, `${name} ${selector}`);
    for (let parent = el; parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, '1');
  } };
  check([
    ['.soul-instructions .page-section-lead', '.workspace-page', 'muted', 'bg'],
    ['.cap-contents-group-label', '.cap-contents', 'muted', 'surface'],
    ['[aria-selected=true] .cap-node-name', '[aria-selected=true] > .cap-node', 'fg', 'sel'],
    ['[aria-selected=true] .cap-node-file', '[aria-selected=true] > .cap-node', 'muted', 'sel'],
    ['.cap-reader-path', '.cap-reader-head', 'fg', 'bg'],
    ['.cap-reader-flag', '.cap-reader-head', 'warn', 'bg'],
    ['.cap-fm th', '.cap-contents-reader', 'muted', 'bg'],
    ['.cap-reader-body .mdv a', '.cap-contents-reader', 'accent', 'bg'],
  ]);
  section.update({ ...soul(null), instructions: { file: '/cache/AGENTS.md', text: null, truncated: false } });
  check([['.cap-reader-line', '.cap-contents-reader', 'muted', 'bg']]);
  assert.equal(doc.querySelector('.cap-reader-line').textContent, "This soul's AGENTS.md could not be read.");
  // B2: the composed document's part headers ("From this soul" / "Injected by …", file, size, the cut flag) and the
  // past-the-limit line. A kernel-shaped answer: the body, a capability block cut by the cap, a block wholly past it.
  const body = '# T\n\n', block = '<!-- oats:capability:oats.core -->\n## Core\n\nText that the cap cuts.\n<!-- /oats:capability:oats.core -->\n\n';
  const cap = body.length + 40, text = (body + block).slice(0, cap);
  section.update({ ...soul('# T\n'), composedInstructions: { file: null, text, truncated: true, resolution: 'r', body: { start: 0, end: body.length, truncated: false },
    sources: [{ source: 'capability:oats.core', file: '.oats/modules/oats.core/inject.md', start: body.length, end: cap, truncated: true },
      { source: 'work-mode:worktree', file: null, start: cap, end: cap, truncated: true }] } });
  doc.querySelector('[data-path="composed"] .cap-node-name').click();
  check([
    ['.cap-tree [role=group] [role=treeitem] .cap-node-name.mono', '.cap-contents', 'fg', 'surface'],
    ['[data-path=composed][aria-selected=true] > .cap-node .cap-node-desc', '[data-path=composed][aria-selected=true] > .cap-node', 'muted', 'sel'],
    ['.soul-part[data-source=soul] .soul-part-title', '.cap-contents-reader', 'fg', 'bg'],
    ['.soul-part[data-source=soul] .soul-part-file', '.cap-contents-reader', 'fg', 'bg'],
    ['.soul-part[data-source^=capability] .soul-part-size', '.cap-contents-reader', 'muted', 'bg'],
    ['.soul-part[data-source^=capability] .soul-part-flag', '.cap-contents-reader', 'warn', 'bg'],
    ['.soul-part[data-source^=work-mode] .cap-reader-line', '.cap-contents-reader', 'muted', 'bg'],
  ]);
  // #1144: the Skills group (the shared skill item, "more files", a selected file) and a cut skill file's head; then its note in place.
  section.update({ ...soul('# T\n'), skills: [{ name: 'oats-pr-review', path: 'skills/oats-pr-review', description: 'Reviews. More.', filesTruncated: true,
    files: [{ path: 'skills/oats-pr-review/SKILL.md', bytes: 300000, text: '# R\n', binary: false, truncated: true }] }] });
  doc.querySelector('[data-skill] > .cap-node').click();
  doc.querySelector('[data-path="file:skills/oats-pr-review/SKILL.md"] > .cap-node').click();
  check([
    ['[data-skill] > .cap-node .cap-node-name', '.cap-contents', 'fg', 'surface'],
    ['[data-skill] > .cap-node .cap-node-desc', '.cap-contents', 'muted', 'surface'],
    ['.cap-more', '.cap-contents', 'muted', 'surface'],
    ['[aria-selected=true] .cap-node-name.mono', '[aria-selected=true] > .cap-node', 'fg', 'sel'],
    ['.cap-reader-path', '.cap-reader-head', 'fg', 'bg'],
    ['.cap-reader-flag', '.cap-reader-head', 'warn', 'bg'],
  ]);
  section.update({ ...soul('# T\n'), skills: [] });
  check([['[role=tree] .cap-contents-group-label', '.cap-contents', 'muted', 'surface'], ['[role=tree] .cap-contents-note', '.cap-contents', 'muted', 'surface'],
    // The two sections' headings ("Defined in this soul", "Composed for an instance"); the rule between them is a border, not text.
    ['[role=tree] .soul-section-title', '.cap-contents', 'fg', 'surface']]);
  section.dispose(); dom.window.close();
});

// #517: Add a machine (every step status) and the Setup tab's Registered machines box (a row, its states and the Remove confirmation).
import { openAddMachineDialog, addMachineCSS } from '../renderer/add-machine-dialog.mjs';
import { createWorkspaceMachines, machinesCSS, resetMachineChecks } from '../renderer/workspace-machines.mjs';
for (const [name] of palettes) test(`${name}: Add a machine and the Registered machines box meet computed AA without opacity`, async t => {
  const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><body><div class="oats-view"><div class="setup" id="setup"></div></div></body></html>`, { pretendToBeVisual: true });
  const doc = dom.window.document;
  for (const source of [css, readFileSync(new URL('shell.css', renderer), 'utf8'), setupCSS, machinesCSS]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
  const steps = [{ step: 'ssh', status: 'ok' }, { step: 'oats', status: 'done', detail: 'installed' },
    { step: 'git', status: 'needs-human', code: 'E_REMOTE_UNREADABLE', detail: 'cannot read', remedy: 'Run `gh auth login` there.' },
    { step: 'deployment', status: 'failed', code: 'E_DEPLOYMENT', detail: 'failed' }, { step: 'register', status: 'skipped', detail: 'waits for git' }];
  const machine = (id, check) => ({ id, label: id, sshHost: id, workspace: `/srv/${id}`, workspaceKey: 'k', check });
  const ctx = { api: async path => ({ ok: true, status: 200, json: async () => path.startsWith('/api/servers')
    ? { servers: [machine('up', { reachable: true, version: '0.39.0', error: null }), machine('down', { reachable: false, version: null, error: 'ssh failed' })], filtered: true, key: 'k', deployment: '/Users/alex/Agents/k', aweb: false }
    : { schemaVersion: 1, ok: true, result: { id: 'devbox-k', ready: false, steps } } }) };
  resetMachineChecks();
  const box = createWorkspaceMachines(doc, { ctx, ws: 'ws:x' }); doc.getElementById('setup').append(box.element);
  const dialog = openAddMachineDialog(doc, { ctx, ws: 'ws:x', deployment: '/Users/alex/Agents/k' });
  t.after(() => { dialog.close(); box.dispose(); dom.window.close(); });
  const host = doc.querySelector('.machine-host'); host.value = 'devbox'; host.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const folder = doc.querySelector('.machine-folder'); folder.value = '~/k'; folder.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  doc.querySelector('.machine-primary').click();
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  doc.querySelector('[data-machine="down"] .machine-remove').click();
  const root = dom.window.getComputedStyle(doc.documentElement);
  for (const [selector, painted, fg, bg] of [
    ['.machine-dialog h2', '.machine-dialog', 'fg', 'surface'], ['.machine-lede', '.machine-dialog', 'muted', 'surface'],
    ['.machine-field span', '.machine-dialog', 'muted', 'surface'], ['.machine-install-row span', '.machine-dialog', 'fg', 'surface'],
    ['.machine-phase-head', '.machine-phase', 'fg', 'surface-2'], ['.machine-step-name', '.machine-phase', 'fg', 'surface-2'],
    ['[data-status=ok] .machine-step-state', '[data-status=ok] .machine-step-state', 'fg', 'tag-bg'],
    ['[data-status=done] .machine-step-state', '[data-status=done] .machine-step-state', 'fg', 'tag-bg'],
    ['[data-status=skipped] .machine-step-state', '[data-status=skipped] .machine-step-state', 'fg', 'tag-bg'],
    ['[data-status=needs-human] .machine-step-state', '[data-status=needs-human] .machine-step-state', 'warn', 'attn-bg'],
    ['[data-status=failed] .machine-step-state', '[data-status=failed] .machine-step-state', 'danger', 'surface'],
    ['.machine-step-detail', '.machine-phase', 'muted', 'surface-2'], ['.machine-step-remedy', '.machine-phase', 'fg', 'surface-2'],
    ['.machine-step-code', '.machine-phase', 'muted', 'surface-2'], ['.machine-command code', '.machine-command code', 'fg', 'surface'],
    ['.machine-status', '.machine-dialog', 'muted', 'surface'], ['.machine-copy', '.machine-copy', 'fg', 'surface'],
    ['.machine-primary', '.machine-primary', 'primary-fg', 'primary-bg'], ['.machine-cancel', '.machine-cancel', 'fg', 'surface'],
    // The Registered machines box: a solid --surface card (in Setup's This computer zone), Setup's members grammar.
    ['.setup-machines .setup-box-head h4', '.setup-machines', 'fg', 'surface'], ['.setup-machines .setup-box-lead', '.setup-machines', 'muted', 'surface'],
    ['[data-machine="up"] .machine-cell.name', '.setup-machines', 'fg', 'surface'], ['[data-machine="up"] .machine-cell.ssh', '.setup-machines', 'fg', 'surface'],
    ['[data-machine="up"] .machine-cell.folder', '.setup-machines', 'muted', 'surface'], ['[data-machine="up"] .machine-cell.version', '.setup-machines', 'muted', 'surface'],
    ['[data-machine="up"] .machine-state', '.setup-machines', 'muted', 'surface'], ['[data-machine="up"] .machine-state .shell-icon', '.setup-machines', 'ok', 'surface'],
    ['[data-machine="down"] .machine-state', '[data-machine="down"] .machine-state', 'warn', 'attn-bg'],
    ['[data-machine="up"] .machine-check', '.setup-machines', 'accent', 'surface'], ['.machines-add', '.setup-machines', 'accent', 'surface'],
    ['.machine-confirm p', '.machine-confirm', 'fg', 'surface-2'], ['.machine-confirm-cancel', '.machine-confirm-cancel', 'fg', 'surface'],
    ['.machine-confirm-remove', '.machine-confirm-remove', 'primary-fg', 'danger'],
  ]) {
    const el = doc.querySelector(selector), surface = doc.querySelector(painted); assert.ok(el && surface, selector);
    assert.equal(dom.window.getComputedStyle(el).color, `var(--${fg})`, selector);
    assert.equal(dom.window.getComputedStyle(surface).background.replace(/^.*(var\(--[\w-]+\)).*$/, '$1'), `var(--${bg})`, painted);
    assert.ok(contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim())) >= 4.5, `${name} ${selector}`);
    for (let parent = el; parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, '1', selector);
  }
  // A placeholder is not computed here: the Folder hint (#1390) is painted with --muted, which .machine-lede holds on --surface above.
  assert.match(addMachineCSS, /\.machine-dialog input\.field::placeholder \{ color:var\(--muted\); \}/);
  assert.ok(doc.querySelector('.machine-folder').closest('.machine-dialog'), 'the hint sits on the dialog\'s --surface');
});

// #558: the terminal tab's Needs input glyph is a non-text graphic (the trigger's name says it): --warn
// must hold 3:1 against every background a tab paints — the strip at rest (--bg, also a split group's
// strip), the active tab (--surface) and a keyboard-focused trigger (--sel) — in every palette.
for (const [name] of palettes) test(`${name}: the terminal tab's Needs input glyph meets 3:1 on every tab background`, async t => {
  const dom = new JSDOM(readFileSync(new URL('index.html', renderer), 'utf8'), { pretendToBeVisual: true }), doc = dom.window.document;
  t.after(() => dom.window.close());
  doc.documentElement.dataset.theme = name;
  const shellCss = readFileSync(new URL('shell.css', renderer), 'utf8');
  for (const source of [css, shellCss]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
  const bar = doc.querySelector('#tabbar');
  for (const active of [false, true]) {
    const tab = doc.createElement('div'); tab.className = `tab${active ? ' active' : ''}`;
    const trigger = doc.createElement('button'); trigger.className = 'tab-trigger';
    const attn = doc.createElement('span'); attn.className = 'tab-attn'; trigger.append(attn); tab.append(trigger); bar.append(tab);
  }
  const root = dom.window.getComputedStyle(doc.documentElement), view = dom.window;
  const fill = el => { const s = view.getComputedStyle(el); return s.background || s.backgroundColor; };
  for (const glyph of doc.querySelectorAll('.tab-attn')) assert.equal(view.getComputedStyle(glyph).color, 'var(--warn)');
  assert.equal(fill(doc.querySelector('#tabstrip')), 'var(--bg)', 'a tab at rest shows the strip');
  assert.equal(fill(doc.querySelector('.tab.active')), 'var(--surface)');
  assert.match(shellCss, /\.tab-trigger:focus-visible \{ background: var\(--sel\); \}/);
  assert.match(shellCss, /\.group-tabbar \{[^}]*background: var\(--bg\)/, 'a split group strip paints --bg too');
  for (const bg of ['bg', 'surface', 'sel']) {
    const ratio = contrast(opaqueChannels(root.getPropertyValue('--warn').trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim()));
    assert.ok(ratio >= 3, `--warn on --${bg}: ${ratio.toFixed(2)}`);
  }
  for (let parent = doc.querySelector('.tab-attn'); parent; parent = parent.parentElement) assert.equal(view.getComputedStyle(parent).opacity, '1');
});

// A tab's go-to-tab number (tab-numbers.mjs) is text, if decorative: its colour token must hold 4.5:1 on every
// background a tab paints, the strip at rest (--bg, a split group's strip too), the active tab (--surface) and a
// keyboard-focused trigger (--sel), in every palette, with nothing composited over it.
import { createTabChrome as tabChrome } from '../renderer/tab-a11y.mjs';
import { numberTabStrips } from '../renderer/tab-numbers.mjs';
for (const [name, palette] of palettes) test(`${name}: a tab's number meets 4.5:1 on every tab background`, t => {
  const dom = new JSDOM(readFileSync(new URL('index.html', renderer), 'utf8'), { pretendToBeVisual: true }), doc = dom.window.document;
  t.after(() => dom.window.close());
  doc.documentElement.dataset.theme = name;
  const shellCss = readFileSync(new URL('shell.css', renderer), 'utf8');
  for (const source of [css, shellCss]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
  const bar = doc.querySelector('#tabbar'), view = dom.window;
  for (const active of [false, true]) {
    const { tabEl } = tabChrome(doc, `n${active}`, 'oats-desktop-developer-tabs-palette', false, { dot: 'on' });
    if (active) tabEl.classList.add('active');
    bar.append(tabEl);
  }
  numberTabStrips([bar]);
  const nums = [...doc.querySelectorAll('#tabbar .tab-num')];
  assert.deepEqual(nums.map(num => [num.textContent, num.hidden]), [['1', false], ['2', false]]);
  const token = view.getComputedStyle(nums[0]).color.match(/^var\(--([\w-]+)\)$/)?.[1];
  assert.equal(token, 'faint', 'the number is quiet text: --faint');
  for (const num of nums) assert.equal(view.getComputedStyle(num).color, `var(--${token})`);
  const fill = el => { const s = view.getComputedStyle(el); return s.background || s.backgroundColor; };
  assert.equal(fill(doc.querySelector('#tabstrip')), 'var(--bg)', 'a tab at rest shows the strip');
  assert.equal(fill(doc.querySelector('.tab.active')), 'var(--surface)');
  assert.match(shellCss, /\.tab-trigger:focus-visible \{ background: var\(--sel\); \}/);
  assert.match(shellCss, /\.group-tabbar \{[^}]*background: var\(--bg\)/, 'a split group strip paints --bg too');
  for (const bg of ['bg', 'surface', 'sel']) {
    assert.ok(pairs.some(([f, b]) => f === token && b === bg), `--${token} on --${bg} is in the inventory`);
    const ratio = contrast(opaqueChannels(palette.get(token)), backgroundChannels(bg, palette));
    assert.ok(ratio >= TEXT_CONTRAST, `${name} --${token} on --${bg}: ${ratio.toFixed(2)}:1 < 4.5:1`);
  }
  for (const num of nums) for (let parent = num; parent; parent = parent.parentElement) assert.equal(view.getComputedStyle(parent).opacity, '1');
});

// Capability warnings (OATS 0.49.0, capability-warnings.mjs): one list, six hosts. In each, the list sits in the host's
// real classes and CSS; every text part is held to AA against the ground actually painted under it, with no opacity.
import { createWarningsList, capabilityWarningsCSS } from '../renderer/capability-warnings.mjs';
import { instanceSoulCSS } from '../renderer/instance-soul.mjs';
for (const [name] of palettes) test(`${name}: the capability warnings list meets computed AA on every surface that shows it`, () => {
  const hosts = [
    ['capability page', '<div class="oats-view"><div class="workspace-page"><section class="page-section cap-contents-section"><div class="cap-contents-warnings" id="host"><h4 class="cap-contents-warnings-title">Warnings</h4></div></section></div></div>', [inspectorCSS, capabilityContentsCSS], false, [['.cap-contents-warnings-title', 'muted']]],
    ['soul page', '<div class="oats-view"><div class="workspace-page soul-page"><div class="inspector-content inspector-main" id="host"></div></div></div>', [inspectorCSS, pageCardCSS]],
    ['readiness (sidebar)', '<div class="oats-view"><div class="soul-inspector"><div class="readiness-view"><section class="readiness-warnings" id="host"></section></div></div></div>', [inspectorCSS]],
    ['instance Soul tab', '<aside id="context-panel" class="context-panel"><div class="soul-tab"><section class="soul-tab-section soul-tab-warnings" id="host"></section></div></aside>', [contextPanelCSS, instanceSoulCSS]],
    ['spawn preview', '<div class="spawn-modal"><div class="spawn-dialog"><div class="spawn-preview"><div class="spawn-preview-warnings" id="host"></div></div></div></div>', [spawnDialogCSS], true],
    ['Workspace › Sources', '<main class="oats-view"><div class="workspace-discovery"><div class="catalog-notes" id="host"></div></div></main>', [discoveryCSS]],
  ];
  for (const [surface, html, sources, lines = false, own = []] of hosts) {
    const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><body>${html}</body></html>`), doc = dom.window.document;
    for (const source of [css, ...sources]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
    // Every host's CSS carries the list's own rules (the component's CSS is composed into each).
    assert.ok(sources.some(source => source.includes(capabilityWarningsCSS.trim())), `${surface} composes the list's CSS`);
    const warning = { code: 'hook-event-unsupported', capability: 'acme.tool', path: 'k:capabilities/acme.tool/oats.json#/hooks/on-merge', message: 'capability acme.tool declares hook "on-merge"' };
    const list = createWarningsList(doc, lines ? Array(33).fill('line one\nline two') : Array(33).fill(warning), { showCapability: true, after: () => 'add the line', canOpen: () => true, open() {} });
    doc.getElementById('host').append(list);
    const root = dom.window.getComputedStyle(doc.documentElement);
    const ground = el => { for (let x = el; x; x = x.parentElement) { const s = dom.window.getComputedStyle(x), m = /var\(--([\w-]+)\)/.exec(`${s.background} ${s.backgroundColor}`); if (m) return m[1]; } return 'bg'; };
    const parts = [['.cap-warning-label', 'warn'], ['.cap-warning-message', 'fg'], ['.cap-warnings-more', 'muted'],
      ...own, ...(lines ? [] : [['.cap-warning-capability', 'muted'], ['.cap-warning-note', 'muted'], ['.cap-warning-details > summary', 'muted'], ['.cap-warning-details dt', 'muted'], ['.cap-warning-details dd', 'fg']])];
    for (const [selector, fg] of parts) {
      const el = doc.querySelector(selector); assert.ok(el, `${surface}: ${selector}`);
      const color = dom.window.getComputedStyle(el).color;
      assert.ok(color === `var(--${fg})` || (fg === 'fg' && ['', 'var(--fg)'].includes(color)), `${surface} ${selector}: ${color}`);
      const bg = ground(el);
      assert.ok(pairs.some(([f, b]) => f === fg && b === bg), `${surface}: --${fg} on --${bg} is in the inventory`);
      const ratio = contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim()));
      assert.ok(ratio >= TEXT_CONTRAST, `${name} ${surface} ${selector}: ${ratio.toFixed(2)} on --${bg}`);
      for (let parent = el; parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, '1', `${surface}: ${selector} has no opacity`);
    }
    // Marked by the word, not colour alone, and the icon is decorative beside it.
    assert.equal(doc.querySelector('.cap-warning-label').textContent, 'Warning');
    assert.equal(doc.querySelector('.cap-warning-head svg').getAttribute('aria-hidden'), 'true');
    dom.window.close();
  }
});

// Capability trigger sources (feature trigger-sources): the quote treatment wherever the Triggers page uses it
// (the On card's parameters, the refused and skipped lists, a refusal's own words, the Test confirm, the Test
// result), the confirm card, the failed source check's tag, the neutral "Nothing ran" notice, and the focus
// indicator of the page's programmatic focus targets. Rendered from the captured kernel answers
// (fixtures/trigger-sources). Each text must name its colour token, sit on a surface that names its own, meet
// 4.5:1 there, and have no opacity over it.
import { automationsCSS } from '../renderer/views/automations.mjs';
for (const [name] of palettes) test(`${name}: a capability trigger source's quotes, Test confirm, result and focus indicators meet computed AA`, async t => {
  const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><body><div class="a"></div><div class="b"></div><div class="c"></div><div class="d"></div></body></html>`, { pretendToBeVisual: true });
  const doc = dom.window.document;
  const style = doc.createElement('style'); style.textContent = css; doc.head.append(style);
  t.after(() => dom.window.close());
  const fx = file => JSON.parse(readFileSync(new URL(`fixtures/trigger-sources/${file}.json`, new URL('./', import.meta.url)), 'utf8')).result;
  const now = () => Date.parse('2026-10-08T12:20:00.000Z'), settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };
  const view = (host, list, status, act) => createAutomationsView(doc.querySelector(host), { kind: 'trigger', sources: true, read: async () => (typeof list === 'function' ? list() : fx(list)), status: async () => fx(status), act, now });
  // a: the list with a failed source check. b: a good poll's page, then the confirm. c: a refused poll's page, then a result. d: the neutral notice.
  view('.a', 'trigger-list-invalid', 'trigger-status-invalid');
  const good = view('.b', 'trigger-list', 'trigger-status-good', async () => fx('trigger-test-trusted'));
  const refused = view('.c', 'trigger-list', 'trigger-status-refused', async () => fx('trigger-test-trusted'));
  const stale = fx('trigger-list'); stale.triggers.find(r => r.id === 'ws/trusted').on = { source: 'github.pull_request', repo: 'github.com/acme/kb', events: ['opened'], labels: [], poll: '2m' };
  let listed = stale;
  const unconfirmed = view('.d', () => listed, 'trigger-status-good', async () => { throw Object.assign(new Error('nothing ran'), { code: 'E_TRIGGER_SOURCE_RUN' }); });
  await settle();
  good.open('ws/trusted'); refused.open('ws/trusted'); unconfirmed.open('ws/trusted'); await settle();
  doc.querySelector('.b .page-bar-actions button[data-verb=test]').click();
  doc.querySelector('.c .page-bar-actions button[data-verb=test]').click(); await settle();
  doc.querySelector('.c button[data-verb=run-test]').click();
  listed = fx('trigger-list'); doc.querySelector('.d .page-bar-actions button[data-verb=test]').click(); await settle();

  const root = dom.window.getComputedStyle(doc.documentElement), token = value => /var\(--([\w-]+)\)/.exec(value || '')?.[1] ?? null;
  const ratio = (fg, bg) => contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim()));
  /** The token of the nearest element, from `el` up, that sets `property`. */
  const nearest = (el, property) => { for (let at = el; at; at = at.parentElement) { const found = token(dom.window.getComputedStyle(at)[property]); if (found) return found; } return null; };
  let seen = 0;
  for (const [selector, fg, bg, least = 1] of [
    ['.a .auto-tag.auto-source-check', 'fg', 'attn-bg'],
    ['.b .page-card[data-card="On"] .source-quote-lead', 'muted', 'surface'], ['.b .page-card[data-card="On"] .source-quote-text', 'fg', 'surface', 2],
    ['.b .auto-source-lists .source-quote-lead', 'muted', null, 2], ['.b .auto-source-lists .source-quote-text', 'fg', null, 5],
    ['.b .auto-source-lists .source-quote-label', 'fg', null, 2], ['.b .auto-source-lists .source-quote-note', 'muted', null, 3],
    ['.b .auto-source-lists .auto-list-head', 'muted', null, 2], ['.b .auto-lists-from', 'muted', null],
    ['.b .auto-confirm .page-card-title', 'muted', 'surface'], ['.b .auto-confirm .auto-test-line', 'fg', 'surface', 2], ['.b .auto-confirm .auto-test-line code', 'fg', 'surface'],
    ['.b .auto-confirm .auto-confirm-status', 'muted', 'surface'], ['.b .auto-confirm .source-quote-lead', 'muted', 'surface'], ['.b .auto-confirm .source-quote-text', 'fg', 'surface', 2],
    ['.c .auto-poll-error', 'warn', null], ['.c .auto-poll-error code', 'warn', null], ['.c .auto-history .source-quote-lead, .c .auto-poll-error ~ .source-quote .source-quote-lead', 'muted', null],
    ['.c .auto-poll-error ~ .source-quote .source-quote-text', 'fg', null, 2],
    ['.c .page-card[data-card="Test result"] .page-card-title', 'muted', 'surface'], ['.c .page-card[data-card="Test result"] .auto-test-line', 'fg', 'surface'],
    ['.c .page-card[data-card="Test result"] .source-quote-text', 'fg', 'surface'], ['.c .page-card[data-card="Test result"] .source-quote-note', 'muted', 'surface'],
    ['.c .page-card[data-card="Test result"] .auto-fire-url', 'muted', 'surface'],
    ['.d .auto-page .auto-ran-nothing', 'muted', null],
  ]) {
    const found = [...doc.querySelectorAll(selector)]; assert.ok(found.length >= least, `${selector}: ${found.length} of ${least}`);
    for (const el of found) {
      const painted = nearest(el, 'background'); assert.ok(painted, `${selector}: a surface that names its token`);
      if (bg) assert.equal(painted, bg, selector);
      assert.equal(nearest(el, 'color'), fg, selector);
      assert.ok(ratio(fg, painted) >= 4.5, `${name} ${selector}: --${fg} on --${painted} ${ratio(fg, painted).toFixed(2)}:1`);
      for (let parent = el; parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, '1', selector);
      seen++;
    }
  }
  assert.ok(seen >= 40, `the inventory was rendered: ${seen}`);
  // The failed source check is said in text and an icon: the icon (non-text, 3:1) is --warn on the tag's ground.
  const icon = doc.querySelector('.a .auto-source-check .shell-icon'); assert.ok(icon);
  assert.equal(token(dom.window.getComputedStyle(icon).color), 'warn'); assert.ok(ratio('warn', 'attn-bg') >= 3, `${name}: --warn on --attn-bg`);
  // Focus lands on headings and a status line that are not controls: their indicator is an --accent outline (3:1 on the card).
  const focus = /\.auto-confirm-status:focus-visible, \.page-card-title:focus-visible \{([^}]*)\}/.exec(automationsCSS)?.[1];
  assert.match(focus || '', /outline:1px solid var\(--accent\)/);
  for (const target of ['.b .auto-confirm .page-card-title', '.b .auto-confirm-status', '.c .page-card[data-card="Test result"] .page-card-title']) {
    const el = doc.querySelector(target); assert.equal(el.tabIndex, -1, target);
    assert.ok(ratio('accent', nearest(el, 'background')) >= 3, `${name} ${target}: --accent on --${nearest(el, 'background')}`);
  }
  // The quote's side rule is not what tells a quote apart (the lead-in and the typeface do): it carries no text.
  assert.match(/\.source-quote-text \{([^}]*)\}/.exec(capabilityQuoteCSS)[1], /font-weight:normal; font-size:12px; line-height:1\.5; font-family:var\(--mono,monospace\)/);
});

// The shortcuts editor (Spec A PR 2): search, sticky group headings, labels, keycaps, quiet markers,
// warnings, the unbound chord and the empty line, on the surfaces they are painted on. A row's
// hover paints --surface-2 under its text, so row text is held to both. Every pair is also in the
// inventory, which is what holds the derived "This computer" palettes to it.
for (const [name] of palettes) test(`${name}: the shortcuts editor's search, headings, rows, keycaps and markers meet computed AA`, async t => {
  const { registerAction, setBinding, resetAllBindings } = await import("../renderer/keybindings.mjs");
  const { createKeybindingsEditor } = await import("../renderer/keybindings-editor.mjs");
  const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><body></body></html>`, { pretendToBeVisual: true });
  const doc = dom.window.document;
  for (const source of [css, readFileSync(new URL("shell.css", renderer), "utf8")]) {
    const style = doc.createElement("style"); style.textContent = source; doc.head.append(style);
  }
  resetAllBindings();
  const offs = [
    registerAction({ id: "sidebar.toggle", label: "Sidebar", context: "global", run: () => {} }),
    registerAction({ id: "app.focusMode", label: "Focus mode", context: "global", run: () => {} }),
    registerAction({ id: "x.bare", label: "Bare", context: "global", defaultChord: "B", run: () => {} }),
  ];
  const editor = createKeybindingsEditor({ doc, isMac: false });
  t.after(() => { editor.close(); offs.forEach(off => off()); resetAllBindings(); dom.window.close(); });
  setBinding("sidebar.toggle", "Ctrl+Alt+B"); // the changed marker
  editor.open();
  const nomatch = () => { const s = doc.querySelector(".kb-search"); s.value = "zzz"; s.dispatchEvent(new dom.window.Event("input")); };
  const root = dom.window.getComputedStyle(doc.documentElement);
  const value = token => root.getPropertyValue(`--${token}`).trim();
  const row = ["surface", "surface-2"];
  const checks = [
    [".kb-title", "fg", ".kb-editor", ["surface"]],
    [".kb-search", "fg", ".kb-search-field", ["bg"]],
    [".kb-hint", "muted", ".kb-editor", ["surface"]],
    [".kb-context", "muted", ".kb-context", ["surface"]],
    [".kb-label", "fg", ".kb-editor", row],
    [".kb-mark-terminal", "muted", ".kb-editor", row],
    [".kb-mark-changed", "muted", ".kb-editor", row],
    [".kb-keys kbd", "fg", ".kb-keys kbd", ["bg"]],
    [".kb-chord.kb-unbound", "faint", ".kb-editor", row],
    [".kb-conflict", "warn", ".kb-editor", row],
  ];
  for (const [selector, fg, painted, surfaces] of checks) {
    const el = doc.querySelector(selector), surface = doc.querySelector(painted); assert.ok(el && surface, selector);
    assert.equal(dom.window.getComputedStyle(el).color, `var(--${fg})`, selector);
    assert.equal(dom.window.getComputedStyle(surface).background, `var(--${surfaces[0]})`, painted);
    for (const bg of surfaces) {
      assert.ok(pairs.some(([f, b]) => f === fg && b === bg), `${fg} on ${bg} is in the inventory`);
      assert.ok(contrast(opaqueChannels(value(fg)), opaqueChannels(value(bg))) >= 4.5, `${selector}: ${fg} on ${bg}`);
    }
    for (let parent = el; parent; parent = parent.parentElement) assert.equal(dom.window.getComputedStyle(parent).opacity, "1", selector);
  }
  // The row hover and the sticky heading are painted with tokens, never by compositing.
  const shell = readFileSync(new URL("shell.css", renderer), "utf8");
  assert.match(shell, /\.kb-row:hover \{ background: var\(--surface-2\); \}/);
  assert.match(shell, /\.kb-search::placeholder \{ color: var\(--faint\); \}/);
  assert.ok(contrast(opaqueChannels(value("faint")), opaqueChannels(value("bg"))) >= 4.5, "the placeholder on the search");
  nomatch();
  const none = doc.querySelector(".kb-nomatch");
  assert.equal(none.hidden, false);
  assert.equal(dom.window.getComputedStyle(none).color, "var(--muted)");
  assert.ok(contrast(opaqueChannels(value("muted")), opaqueChannels(value("surface"))) >= 4.5);
});

// The leader (docs/desktop-keyboard.md, "The leader"): its hint's line over the main area, drawn by the
// shipped code and rules, in every theme. Its text is an inventoried token on the surface actually painted
// under it, with no opacity on the way. While the leader waits, nothing is drawn: the region stays clipped.
for (const [name] of palettes) test(`${name}: the leader's hint meets AA on its effective colours`, async t => {
  const { createLeaderHint } = await import("../renderer/leader-hint.mjs");
  const dom = new JSDOM(readFileSync(new URL("index.html", renderer), "utf8"));
  t.after(() => dom.window.close());
  const doc = dom.window.document; doc.documentElement.dataset.theme = name;
  for (const source of [css, readFileSync(new URL("shell.css", renderer), "utf8")]) {
    const style = doc.createElement("style"); style.textContent = source; doc.head.append(style);
  }
  const root = dom.window.getComputedStyle(doc.documentElement);
  const hint = createLeaderHint({ doc, host: doc.getElementById("main"), before: doc.getElementById("show-panel") });
  hint.announce();
  assert.equal(dom.window.getComputedStyle(hint.element).clipPath, "inset(50%)", "the wait draws nothing");
  const check = (selector, fg, surfaceSelector, bg) => {
    const el = doc.querySelector(selector), surface = doc.querySelector(surfaceSelector);
    assert.ok(el && surface, selector);
    assert.equal(dom.window.getComputedStyle(el).color, `var(--${fg})`, selector);
    assert.equal(dom.window.getComputedStyle(surface).background, `var(--${bg})`, surfaceSelector);
    assert.ok(pairs.some(([f, b]) => f === fg && b === bg), `--${fg} on --${bg} is inventoried`);
    assert.ok(contrast(opaqueChannels(root.getPropertyValue(`--${fg}`).trim()), opaqueChannels(root.getPropertyValue(`--${bg}`).trim())) >= 4.5, `${selector} on ${bg}`);
    for (let node = el; node; node = node.parentElement) assert.equal(dom.window.getComputedStyle(node).opacity, "1", `${selector}: no opacity`);
  };
  hint.say("No instance is focused or selected.");
  check(".leader-hint-line", "fg", ".leader-hint", "surface-2");
  // The hint is opaque: its surface is a token, never a blend over the terminal behind it.
  assert.equal(dom.window.getComputedStyle(hint.element).background, "var(--surface-2)");
  assert.notEqual(dom.window.getComputedStyle(hint.element).clipPath, "inset(50%)", "a line is drawn");
});

// The shortcuts editor's Most useful section (its first): the heading, each action's name, the keycaps and the
// leader's words, on the surfaces they are painted on, in every theme. Its rules are the editor's own (usefulCSS,
// injected with it), on top of the list's keycaps and words in shell.css; nothing over its text is composited.
for (const [name] of palettes) test(`${name}: the shortcuts editor's Most useful section meets computed AA`, async t => {
  const { registerAction, resetAllBindings } = await import("../renderer/keybindings.mjs");
  const { createKeybindingsEditor, usefulCSS } = await import("../renderer/keybindings-editor.mjs");
  const dom = new JSDOM(`<!doctype html><html data-theme="${name}"><body></body></html>`, { pretendToBeVisual: true });
  const doc = dom.window.document;
  for (const source of [css, readFileSync(new URL("shell.css", renderer), "utf8")]) {
    const style = doc.createElement("style"); style.textContent = source; doc.head.append(style);
  }
  resetAllBindings();
  const offs = [registerAction({ id: "app.leader", label: "Leader", context: "global", run: () => {} })];
  const editor = createKeybindingsEditor({ doc, isMac: false });
  t.after(() => { editor.close(); offs.forEach(off => off()); resetAllBindings(); dom.window.close(); });
  editor.open();
  assert.equal(doc.querySelector("style[data-kb-useful]").textContent, usefulCSS, "its rules are on the page");
  assert.doesNotMatch(usefulCSS, /#[0-9a-f]{3,8}\b|rgba?\(|opacity|color-mix/i, "tokens only, no compositing");
  const root = dom.window.getComputedStyle(doc.documentElement);
  const value = token => root.getPropertyValue(`--${token}`).trim();
  for (const [selector, fg, painted, bg] of [
    [".kb-useful .kb-context", "muted", ".kb-useful .kb-context", "surface"],
    [".kb-useful-name", "fg", ".kb-editor", "surface"],
    [".kb-useful kbd", "fg", ".kb-useful kbd", "bg"],
    [".kb-useful .kb-then", "muted", ".kb-editor", "surface"],
  ]) {
    const el = doc.querySelector(selector), surface = doc.querySelector(painted); assert.ok(el && surface, selector);
    assert.equal(dom.window.getComputedStyle(el).color, `var(--${fg})`, selector);
    assert.equal(dom.window.getComputedStyle(surface).background, `var(--${bg})`, painted);
    for (let node = el === surface ? null : el.parentElement; node && node !== surface; node = node.parentElement) {
      assert.ok(["", "none", "transparent", "rgba(0, 0, 0, 0)"].includes(dom.window.getComputedStyle(node).background), `${selector}: nothing painted between it and ${painted}`);
    }
    assert.ok(pairs.some(([f, b]) => f === fg && b === bg), `--${fg} on --${bg} is in the inventory`);
    assert.ok(contrast(opaqueChannels(value(fg)), opaqueChannels(value(bg))) >= 4.5, `${selector}: ${fg} on ${bg}`);
    for (let node = el; node; node = node.parentElement) assert.equal(dom.window.getComputedStyle(node).opacity, "1", `${selector}: no opacity`);
  }
});
