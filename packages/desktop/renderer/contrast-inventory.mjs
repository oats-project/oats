/* oats desktop — the contrast inventory: which foreground token is drawn on
   which surface token. Token names only, never a colour value.

   One list, two consumers:
   - `test/theme-contrast.test.mjs` holds every built-in palette (White,
     Solarized, Dark) to it;
   - `host-theme.mjs` derives the "This computer" theme from it: each imported
     text colour is moved until it meets the ratio on every surface listed for
     it here, and the same test file holds the derived palettes to the list.

   A rule that paints a new foreground on a surface adds its pair here, and both
   consumers follow. */

export const SOUL_TONES = Object.freeze(["sand", "sage", "slate", "mauve", "clay", "olive"]);
export const RUNTIMES = Object.freeze(["claude", "pi", "codex", "unknown"]);
/** The 16 terminal colours, in xterm's slot order (0–15). */
export const ANSI_TOKENS = Object.freeze([
  "ansi-black", "ansi-red", "ansi-green", "ansi-yellow", "ansi-blue", "ansi-magenta", "ansi-cyan", "ansi-white",
  "ansi-bright-black", "ansi-bright-red", "ansi-bright-green", "ansi-bright-yellow",
  "ansi-bright-blue", "ansi-bright-magenta", "ansi-bright-cyan", "ansi-bright-white",
]);

/** Text ratio (WCAG AA) and the ratio for meaningful graphics (WCAG 1.4.11). */
export const TEXT_CONTRAST = 4.5, GRAPHIC_CONTRAST = 3;

// Explicitly mirrors shipped foreground/background use: shell/view metadata can
// sit on any base/raised surface; status text appears in shell and transcript;
// chip and terminal colors have their dedicated surfaces; ANSI is xterm-only.
/** [foreground, surface] pairs held to TEXT_CONTRAST. */
export const TEXT_PAIRS = Object.freeze([
  ...["surface", "surface-2", "sel"].map(bg => ["nav-fg", bg]),
  ...SOUL_TONES.map(name => [`soul-${name}-fg`, `soul-${name}-bg`]),
  ...RUNTIMES.map(name => [`runtime-${name}-fg`, `runtime-${name}-bg`]),
  ...["fg", "muted", "faint", "accent"].flatMap((fg) => ["bg", "surface", "surface-2"].map((bg) => [fg, bg])),
  ...["ok", "warn", "danger"].flatMap((fg) => ["bg", "surface", "surface-2", "term-bg"].map((bg) => [fg, bg])),
  ["chip-fg", "chip-bg"], ["accent", "chip-bg"], ["warn", "chip-bg"], ["fg", "chip-bg"],
  ["primary-fg", "primary-bg"], ["primary-bg", "primary-fg"] /* toast buttons invert on keyboard focus */,
  ["term-fg", "term-bg"], ["term-sel-fg", "term-sel"],
  ["term-fg", "surface-2"], ["muted", "term-bg"],
  ["fg", "term-bg"], ["accent", "term-bg"], ["violet", "term-bg"], ["violet", "surface-2"],
  ...["fg", "muted", "faint", "accent", "warn", "ok"].map((fg) => [fg, "sel"]),
  // Slice 3d: the Automations row's "1 failed" (shell.css .nav-failed), in --danger on the row's fills: plain and hovered
  // are pairs above; selected, while the Automations page is open, is this one.
  ["danger", "sel"],
  // Slice 3d: the sidebar's own ground (--sidebar; Dark's sunken tone, --surface elsewhere): every ink its rows, heads,
  // pinned rows and foot paint at rest.
  ...["fg", "muted", "faint", "accent", "nav-fg", "warn", "danger"].map((fg) => [fg, "sidebar"]),
  ...["fg", "muted", "accent", "violet", "ok", "warn"].map((fg) => [fg, "md-code-bg"]),
  ...ANSI_TOKENS.map((fg) => [fg, "term-bg"]),
  // Workspace v4: amber attention chips/nodes, and reason/tag chips.
  ["warn", "attn-bg"], ["fg", "attn-bg"], ["muted", "attn-bg"],
  ...["fg", "muted"].map((fg) => [fg, "tag-bg"]),
].map(pair => Object.freeze(pair)));

/** [graphic, surface] pairs held to GRAPHIC_CONTRAST: graph connectors (the
 * Active overview's edges, Setup's tree lines), the sidebar's dotted sibling
 * link and its solid related-work lines are meaningful graphics, and a
 * terminal's selection fill is the one sign of what a copy will take (issue 672). */
export const GRAPHIC_PAIRS = Object.freeze([
  ...["bg", "surface", "surface-2"].map(bg => Object.freeze(["graph-edge", bg])),
  // The sidebar's dotted sibling link (shell.css .ctx-guide.link-*), the sibling cue alone on its column (issue 1312),
  // on every row fill: plain, hovered and selected.
  ...["sidebar", "surface", "surface-2", "sel"].map(bg => Object.freeze(["tree-link", bg])),
  // The roster's solid lines (shell.css .ctx-guide line, elbow, down): drawn for related work only, so the line is the
  // sign of it (the related-work lines), on every row fill it crosses: plain, hovered and selected.
  ...["sidebar", "surface", "surface-2", "sel"].map(bg => Object.freeze(["tree-stroke", bg])),
  // A native select's chevron (theme.css select.field): --muted, on the field and on a disabled field.
  ...["surface", "surface-2"].map(bg => Object.freeze(["muted", bg])),
  Object.freeze(["term-sel", "term-bg"]),
  // A running lifecycle confirmation's spinner arc (lifecycle-dialog.mjs .spinner) on the dialog's --surface.
  Object.freeze(["accent", "surface"]),
  // A problem dot, in --danger since yellow means needs input only (2026-10-26): the keybinding clash dot on the foot's
  // ?, the pinned Automations row's failure mark (slice 1), and the Workspace page's Setup and Teams attention dot, on a
  // focused or lit --sel (--surface and --surface-2 are text pairs already).
  Object.freeze(["danger", "sel"]),
  // An instance's colour (issue 1421; instance-dot.mjs): its dot, filled or a ring, on every fill it is drawn on: the
  // roster's rows (plain, hovered, selected), the tab strip and its active and focused tab, the palette's rows, the
  // hierarchy's cards, the colour dialog's swatches and mark. The colour never says the state alone (the shape does).
  // --instance-<tone> is the soul's -fg in the built-in themes; "This computer" moves it until it holds (host-theme.mjs).
  ...SOUL_TONES.flatMap(tone => ["bg", "sidebar", "surface", "surface-2", "sel"].map(bg => Object.freeze([`instance-${tone}`, bg]))),
]);

/** Translucent surfaces and the token painted behind each: contrast is measured
 * on the composite. The markdown scroll surface paints --bg behind its code blocks. */
export const PAINTED_OVER = Object.freeze([Object.freeze(["md-code-bg", "bg"])]);

/** The pairs the "This computer" theme does not hold: its 16 terminal colours
 * are the host's own, unadjusted, as the host's terminal shows them. They are
 * drawn only by xterm, whose minimum contrast ratio keeps them readable when
 * drawn, and slot 0 equals the background in every Omarchy theme, so it cannot
 * meet a ratio against it. The built-in palettes hold every pair. */
export const HOST_UNADJUSTED_PAIRS = Object.freeze(TEXT_PAIRS.filter(([fg, bg]) => ANSI_TOKENS.includes(fg) && bg === "term-bg"));
