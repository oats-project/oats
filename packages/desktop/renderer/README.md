# oats desktop — renderer views (webpanel-dev)

Ports of the retired browser panel's functionality as desktop renderer views,
per the desktop-app contract: each view is a plain ES module exporting
`mount(el, ctx)` / `unmount()`, where `ctx = { api(pathname, opts),
openFile(path), openTerminal(instance) }` is provided by the shell.
No frameworks, no dependencies; data comes from the bundled backend HTTP API.

## Views (`views/`)

- **spawn.mjs** — **Workspace**, with Souls / Capabilities / Teams / Machines / Setup subtabs
  (`workspace-discovery.mjs` `workspaceTabs`); the page opens on Souls. Souls and Machines are
  panels the view owns: Machines (`.workspace-machines-panel`, id `workspace-machines`) mounts
  `hierarchy.mjs`, the Deployments page of before, only while its tab is shown (chosen, or
  preselected by `stage.hierarchy`) and unmounts it on
  leaving (`syncMachines`), and that view's "Workspace" (`s`, Go to soul's page) is the Souls tab
  here. `shell-nav.mjs` NAV is Home (`home`, the Desktop UI rework's slice 2), Workspace
  (`spawn`, with its own pinned row again since slice 2b: `PINNED` is Home, Workspace and Automations, and
  `pinnedRowFor` is each stage's own row) and Automations (`automations`, a page of its
  own again, as before 2026-10-23), and its NAV_TABS route
  `stage.hierarchy` (⌘1 / Ctrl+1), the palette's **View: Workspace › Machines** (the entry's label
  names its page, as the shortcuts editor's row does) and every
  `showStage("hierarchy")` / `ctx.openView("hierarchy")` to this page on the Machines tab.
  Souls come from `GET /api/agents` (the kernel's `oats souls` catalog),
  grouped by where they come from (the member repository, the host first,
  then packages with their pinned version, then external souls) and, inside a
  group, in kind order (`packages/client/soul-role.mjs` `compareSoulsByRole`: maintainers,
  experts, developers, operations, the rest; a name rule until the kernel reports a
  role). They show as cards or as a table (`v`, `spawn.view`, or the toolbar's
  Grid | Table; `rememberSoulsView` keeps the choice per view id in localStorage,
  `oats.desktop.soulsView`). A card is one button: the name, the description
  clamped to two lines, and a foot with its agents (*N agents running*, *No agents
  running · N stopped*, through `DESKTOP_NOUNS`) and its kind; a soul a spawn here
  would refuse says why in `--warn` on a line above the foot, which keeps its count. The table's rows carry
  the name (the row's one button), what it does, kind, agents running, harness ·
  model and Ready (`soulReadiness`: *Ready*, the refusal, or *—* without
  `desktop-facts`). Cards and rows' names share one roving tab stop (`.soul-item`).
  No Spawn on a card, no team grouping or chips, no "About souls" (slice 3a): the
  page's first line (`SOULS_LEDE`) says what a soul is.
  Selection opens the soul's page — read-only: a v2 soul is edited in its
  repository and the inspector never writes it in place; there are no layer bindings
  (`oats use` was removed by workspace model v2). Its New agent action opens the Spawn dialog
  (see below), which previews through the kernel and applies through the
  confirmed `/api/spawn?ws=` transaction. An empty opening instruction waits
  for instructions; attached-mode souls cannot launch standalone. The shell's
  `app.chooseSoul` (⌘N / Ctrl+Shift+N, **Souls: choose a soul to spawn (Workspace › Souls)**) navigates to soul
  selection, and the sidebar foot's **New agent** opens Quick Open (`app.quickOpenSouls`); neither launches.
  Capability facts and source provenance use negotiated read-only inspection,
  never inferred membership, installation or remote discovery. Shared CLI recovery
  stays visible across subtabs; incompatible installations are observation-only.
- **cli-status.mjs** — shared CLI degradation state + the ONE card
  (detected path/version, required range, **Choose oats…**, **Retry**, docs
  link, copyable install command; no command when the detected CLI is above
  the band, see [Troubleshooting](../../../docs/desktop.md#troubleshooting)).
  Views subscribe via `onCliChange`;
  re-probe triggers: launch, app focus, Retry, choose (contract).
- **common.mjs** — shared helpers: escaping, mini-markdown, ctx.api JSON
  wrappers, roster grouping, and workspace switching (`?ws=`) — the selected
  workspace is shared across this window's views via `onWorkspaceChange`, so
  the sidebar's list of workspaces can drive it too. One window per workspace: the
  window's workspace is its URL's hash (`#ws=<id>`, window-binding.mjs),
  rewritten with `history.replaceState`; localStorage only holds the default
  a new window takes when main says no other window has it (`startWindow`;
  a window with a hash confirms that binding there, and chooses when main
  answers `open-elsewhere`: a take-over moved it while the page loaded).
  Every switch goes through `switchWorkspace`, which main binds first
  (`window:claim-workspace`): a workspace another window has brings that
  window to the front and leaves this one unchanged, unless the switch is a
  take-over (`{ takeOver: true }`: a pick from the list of workspaces, the
  Workspace page's and its Machines tab's selects, spawn.mjs `handOff`). Then main asks the
  holder to release it (`window:release-workspace { request, workspace,
  workspaces }`), waits for its `window:release-answer` or 2 s, and moves the
  binding here. The holder (shell.mjs `releaseTakenWorkspace`) answers, then
  leaves it through `leaveTakenWorkspace`, queued behind any switch already
  queued: the newest workspace of its session history (`noteShown`, at most
  16) that main still serves and that no other window has, else `choosing`.
  Then it closes its tabs of that workspace in the background
  (`closeWorkspaceTabs`) and forgets its layout (`workspaceTabMemory.forget`).
  A holder that answers late ends the same way. Its answer hands over the
  workspace's terminals and split (`layout-handover.mjs`: `describeLayout`, a
  closed shape main checks with `validLayout` and passes on whole or not at
  all, in the claim answer's `layout`); the asking window reads it once
  (`handedLayout`, during the switch's listeners) and shell.mjs
  `restoreHandedLayout` opens those terminals again (fresh viewers) under one
  intent ticket, then lays them out (`composeLayout`). A selection, a switch or
  a new connection meanwhile stops what is left. File, brain and view tabs do
  not move. Claims run one at a
  time and a switch commits only after main's yes (`setWorkspace`). Main may
  move a window ahead of it: a window bound to a deployment whose view is
  observed later is registered under the view at once (main's
  `noteServed`), and the window's next roster read follows it there. A
  window with no workspace is `choosing`
  (`windowState`): the shell shows "Choose a workspace", focuses the list of
  workspaces with main's choices, and reads nothing.
  A persisted selection the server no longer serves is **stale**
  (`staleWorkspaceSelection`: non-empty and absent from the reply's
  `workspaces` plus `workspace`); both roster paths (hierarchy refresh and
  the shell's context roster) treat it like an empty selection and silently
  `adoptWorkspace` the served id, without a generation bump. Without a
  served list nothing is guessed. A selection that IS served and gets a reply
  for another workspace stays a refused mismatch. A deployment id saved before
  workspace views (a path, `remote:<server>:<target>`) is stale once a view
  holds it: the server answers it with that view, whose id is adopted.

`theme.css` carries semantic WCAG AA tokens for **Light** (the id `light`, once
White), **Solarized**, and **Dark**. A fourth choice, **System** (`host`, once
"This computer"), has no palette of its own: it shows the Omarchy theme on an
Omarchy computer and the OS's light or dark setting everywhere else
(host-theme.mjs), as "This computer" did (Joan's decision for System,
2026-11-19). **The Appearance sheet** (`theme-picker.mjs`
`createAppearanceSheet`; the Desktop UI rework, slice 4) is where a theme is
chosen: the palette's **Appearance…** and Ctrl+Shift+Space (⇧⌘Space on macOS;
`app.themePicker`) open it on Theme (System, Dark, Light, then More themes…
for Solarized), and **Font: choose…** (`app.fontPicker`) on Font (also **Theme: choose…** for Theme). A row
applies at once through `setTheme` / `setFont` and the sheet stays open; its
third part is the terminals' font size (`settings-terminal.mjs`). It replaces
the theme picker and the font picker. The other theme actions are in the
command palette; cycling follows the THEMES order (Light, Solarized, Dark,
System). Existing valid `oatsweb.theme` preferences survive, on
every platform. A missing or invalid preference means the platform's default:
This computer on Linux, White elsewhere. The shell decides which from
`navigator.platform` and passes it to `initTheme()` as the fallback;
`theme.mjs` itself knows no platform, and a fallback that is not a theme is
White. Starting never stores the default, so it stays a default until the
operator chooses: an install where no theme was ever chosen cannot be told
from a fresh one and follows a change of default, and one where White was
chosen keeps White. Views use tokens only, scoped under `.oats-view`. Orange
selection is distinct from error/success.

**The font** (the product owner's call, 2026-10-23; D2 of the Desktop UI rework, 2026-11-19)
is the terminals' face only: the chrome is always the system sans. **This computer's
monospace** (the id `omarchy`, once "Omarchy's font"), the default on an Omarchy
computer, or **System** (Inconsolata in the terminals), the default everywhere else
(2026-10-26). The Appearance sheet's Font list (`theme.mjs` `fontChoices`) offers them,
and **Choose…**, a family by name; on macOS the monospace row is not offered (it
changed only the chrome there). Before D2, Omarchy's font also set the chrome
(`--ui-font`, `--mono`, `--name-size`); the record of that is below, marked as before D2.

- **What it sets (since D2).** The monospace choice sets `--term-font-family` alone,
  on Linux and Windows; nothing else, and nothing on macOS. The terminals' face and
  default size per face are unchanged (`TERMINAL_FACES`), so their cell geometry is.
- **What it set before D2.** `theme.mjs` `fontStacks(font, isMac)` is the custom
  properties a choice sets inline on the root, and `initFont`, `setFont`,
  `currentFont` and `onFontChange` switch it as `initTheme` and `setTheme` do the
  theme. Omarchy's font on Linux and Windows: `--ui-font`, `--mono` and
  `--term-font-family` are `ui-monospace, monospace` (never the bare `monospace`,
  whose quirk changes the default size). Chromium on Linux resolves the generic
  through fontconfig, which is what Omarchy's font is (`omarchy font current` is
  `fc-match monospace`), so nothing is read from the host and no IPC is added;
  `ui-monospace` is a macOS face that Chromium elsewhere skips. On Windows the
  generic is Chromium's own default monospace. On macOS: `--ui-font` and
  `--mono` are `"JetBrainsMono Nerd Font", "JetBrains Mono", ui-monospace,
  SFMono-Regular, Menlo, monospace` (no file is bundled), and the terminals keep
  Inconsolata. On every platform Omarchy's font also sets `--name-size: 12px`,
  which an instance's name on its sidebar row (`.ctx-name`) and its tab (`.tab`)
  read as `font-size: var(--name-size, 12.5px)`: the wider monospace face, a
  little smaller (the product owner, 2026-10-26). System font sets nothing.
- **Every UI font rule follows it** by reading `font-family: var(--ui-font,
  <its own stack>)`, a longhand beside its size, weight and line-height (never
  inside a `font` shorthand: jsdom drops a shorthand that holds `var()`, so a
  test would read the parent's values): the body, `.oats-view`, the context panel, the Machines (hierarchy), brain
  and markdown views, and the rules that once read `var(--sans,system-ui)`, a
  token nothing defined. The monospace rules do too: code in the markdown view,
  the context panel's ids, paths and facts, the soul tab's meta and sources, PR
  chips, team details, the tab hints and numbers, and the terminal search's
  controls. theme.css never defines `--ui-font`, so with System font each rule
  is its own stack exactly as before. The rules on `--mono` are longhands too
  (`font-weight`, `font-size`, `line-height`, then `font-family: var(--mono,
  …)`): no `font` shorthand in the shipped CSS holds a `var()`.
  `test/font-choice.test.mjs` refuses one, and a sans or monospace stack outside
  that fallback (or a font token: `--mono`, `--term-font-family`).
- **Stored per computer** under `oats.desktop.font` (like `oatsweb.theme`); a
  missing or unknown value is `defaultFont()`, and the default is never stored.
  The shell calls `initFont(isMac, undefined, { isOmarchy })` before its first
  await, so the first paint is in it. `isOmarchy` is preload's constant
  `oatsDesktop.isOmarchy` (only `true` counts): main checks Omarchy's presence
  once with `host-theme.mjs` `omarchyHost` (Linux only; the "This computer"
  theme's marker, Omarchy's `current/` directory; any error is false) and adds
  `--oats-host-omarchy` to each window's `additionalArguments`, which preload
  reads. No IPC channel carries it. It picks `defaultFont()` (Omarchy's font,
  else System font), nothing else: the terminal's size follows the face
  (`terminalFace()`, below), not the host.
- **Terminals** switch in place: `applyFont` notifies the terminal typography
  listeners, and each open terminal sets xterm's `fontFamily` and `fontSize`
  (the new face's size) and refits
  (`fitTerminal`; the PTY follows the grid). The GitHub sign-in terminal
  (Settings: Connections…) keeps its box when the font changes, so its adapter
  (shell.mjs `terminalFactory`) tells its resize listeners itself: Connections
  refits it and sends the new grid to the sign-in PTY (`forgeAuthResize`). A stored terminal family
  (`oats.desktop.terminal.fontFamily`) still wins, and the size is the face's.
- **The fallback.** Omarchy's font is used only once its stack draws at a fixed
  width: `fontDraws(stack)` measures ten i's and ten M's on a canvas, wider than
  nothing and equal within 1%, at start and on each choice (whichever is
  chosen, so the picker's note is right in advance). Measured in Chromium on
  Linux with a private fontconfig: with no monospace font the generic is
  fontconfig's best match, a proportional sans; a bitmap font is skipped (Skia
  draws outline fonts only) for the next match, and alone it draws nothing;
  `document.fonts.check` says yes to all of them. Failing, Omarchy's font sets
  nothing (System font's faces), the root gets `data-font-fallback="system"`,
  `fontFallsBack()` is true and the picker's Omarchy row reads
  `FONT_FALLBACK_NOTE`; the stored choice stays.
- **Layout.** A monospace UI is wider: the nav's labels, one under the other
  (Home, Automations), fit whole in the 264px sidebar either way.
  Names that already ellipsize (instances, workspaces) ellipsize sooner, and
  nothing in the sidebar wraps or leaves the right-hand column. A terminal tab
  shows a name of up to 26 characters whole before its 280px cap; a longer one
  ellipsizes its head and keeps its tail and close button (measured in
  Chromium, 2026-10-26).

**This computer.** On a computer with an Omarchy theme, the chrome and every
terminal (local and remote instances alike: they share the two creation sites)
take the current Omarchy theme and follow a theme change without a restart.
Anywhere else the choice follows the system's appearance: Dark when the system
is dark, White when it is light, each exactly as it is, with nothing imported.

- **The source** is Omarchy's own `colors.toml`
  (`~/.local/state/omarchy/current/theme/colors.toml`; Omarchy hard-codes that
  directory, so `XDG_STATE_HOME` is not consulted). It is the file every terminal
  config is generated from, every theme has one, and it alone carries the
  polarity and the accent; a generated terminal config is per-terminal output a
  theme can replace. The main process (`../host-theme.mjs`) reads it with a small
  line parser (no TOML dependency) and resolves the colours Desktop uses by
  these rules: each colour is the first valid `#rrggbb` among its keys, in the
  order `resolveHostPalette` lists them (magenta is `magenta`, `color5`,
  `purple`, the order Omarchy applies those aliases). The file is opened
  without blocking, and the file
  that was opened, not its path, is what must be a regular file of at most
  64 KiB before anything is read: a path can be replaced between a check and the
  open, and a blocking open of a FIFO would hold the main process. The polarity is
  the file's `mode` (or `theme_type`), else it follows the background: light
  when its R+G+B is over 382, Omarchy's own rule. Omarchy's `light.mode` marker
  file is not read. It never runs a host program
  to read colours.
- **Following a change.** `omarchy-theme-set` replaces `current/theme/` with a
  new directory, so main watches the parent `current/`, never `theme/` or the
  file (that watch would end at the first change). An event is debounced, then
  read; a missing file is read once more before it is reported, so the moment
  between the removal and the move never shows as a problem. App focus and a
  system appearance change re-read too, which corrects a missed or failed watch.
  A computer with no `current/` at start is not watched: Omarchy installed
  later is picked up at the next start.
- **What crosses to the renderer** is plain state, on `host-theme:get` (asked
  once per window) and `host-theme:changed` (pushed to every window): a palette
  (`source: "omarchy"`, the mode and the colours), or the system appearance
  (`source: "system"`), with a `problem` when an Omarchy theme exists but its
  colours are missing, unreadable or invalid. No path, name or file content.
  `host-theme.mjs` validates it again before use.
- **Base plus overrides.** The choice (`currentTheme()`, what is saved and
  cycled) is separate from what is applied (`appliedTheme()`): `data-theme`
  stays a built-in id, Dark or White by the host's polarity, so every rule in
  `theme.css` applies as it does for that theme, and the palette is a set of
  custom properties set inline on the root. Leaving the choice removes all of
  them. `theme.mjs` applies what the host source answers and imports nothing
  (tests evaluate its source on its own); the shell hands the source to
  `initTheme()`.
- **The derivation** (`deriveHostTokens` in `host-theme.mjs`) maps the host's
  colours to tokens: the surfaces are the host's (background, the darker canvas,
  and mixes of background towards foreground, accent and yellow for raised,
  border, selected and attention surfaces), and each text colour starts from the
  host's (foreground and its mixes for the text ramp, accent, and green, yellow,
  red and magenta for the status colours). The terminal's selection fill starts
  from the host's selection colour and is moved until it holds 3:1 on the
  terminal's background, a UI state like the graph edges (`GRAPHIC_PAIRS`;
  Omarchy's selections are about 1.3:1); its text is then held to 4.5:1 on it
  (#672). Each token is moved until it holds every pair the inventory gives it
  at once: 4.5:1 where it is text (`TEXT_PAIRS`), 3:1 where it is a graphic
  (`GRAPHIC_PAIRS`). A colour that is both, like `--danger` (its words, and the
  problem dots on `--sel`), never trades one for the other.
- **First paint.** The last state shown is kept in `localStorage`
  (`oats.desktop.hostTheme`) and applied synchronously by `initTheme()`, then
  reconciled with main's answer, so a dark host does not flash White at launch.
  A push that arrives before that answer wins over it. Until This computer has
  been shown once in a profile nothing is kept, so the first start in it (on
  Linux, where it is the default, a profile's very first start) paints White
  until main's answer arrives. There is deliberately no wait for that answer.
- **Several windows.** Every window gets each push and applies it only while
  This computer is its own choice. A window reads the saved choice when it
  loads (there is no storage listener), so two windows can show different
  themes until one reloads.
- **When it falls back.** A problem state, or a palette the derivation refuses,
  applies no override at all and shows Dark or White (by the system's
  appearance, or by the palette's own polarity when it resolved but could not be
  derived). One sticky notification says so, once per episode: an episode is a
  reason plus the base shown. It is replaced when either changes and dismissed
  by a usable state or by choosing another theme.

What keeps an imported palette inside the quality bar:

1. Only the surfaces, the text ramp, the accent and the status colours come
   from the host. Everything else (soul and runtime identity pairs, shadows, the
   scrim, the markdown code surface, fonts, sizes, the terminal's text weight)
   is the calibrated built-in theme of the same polarity.
2. Every imported text colour is moved towards white or black until it is 4.5:1
   on each surface it is drawn on (3:1 for the graph connectors). The whole map
   is derived before any of it is set, and a palette that cannot be made to
   pass is not applied.
3. The pairs come from one list, `contrast-inventory.mjs`: the derivation reads
   it to know each colour's surfaces, and `test/theme-contrast.test.mjs` holds
   the built-in palettes and real Omarchy palettes
   (`test/fixtures/host-theme/`) to the same list with the same arithmetic. A
   rule that paints a new foreground on a surface adds its pair there.
4. The 16 terminal colours are the host's own, unadjusted, in Omarchy's mapping
   (slot 0 is the background, as in the host's terminal). This is the one place
   the host theme does not hold the inventory (`HOST_UNADJUSTED_PAIRS`): they
   are drawn only by xterm, whose minimum contrast ratio (below) keeps them
   readable when drawn.

Outside Desktop's control: the taste of the host's palette; that an adjusted
accent or status colour is lighter or darker than the host's; that a program
painting both text and background is readable but not re-themed.

The default monospace face of System font, and of the macOS terminals with
either font, is **Inconsolata**, bundled (`fonts/`, SIL OFL 1.1;
source, version and checksum in `fonts/README.md`) so it is the same on every
machine. `theme.css` declares it with `@font-face` (`font-display: block`) and puts
it first in `--term-font-family` (the terminal) and `--mono` (the UI's code, paths
and chord hints), ahead of the OS monospace stack. A terminal size belongs to its face
(#1571; JetBrains Mono's advance is 0.6em, Inconsolata's 0.5em). `terminalFace()` is
`"omarchy"` when the applied font stacks set `--term-font-family` (Omarchy's font on Linux or
Windows, drawing at a fixed width), else `"bundled"` (System font, macOS, the fallback); a family
stored with "Terminal: set font family…" does not change it. `TERMINAL_FACES` in `theme.mjs` is
the one face→key and face→default map: the bundled face keeps `oats.desktop.terminal.fontSize`
(every size stored before Omarchy's font reached the terminals is an Inconsolata size) at 15px
(the operator's decision), Omarchy's face `oats.desktop.terminal.fontSize.omarchy` at 13px (the
product owner, 2026-10-26), on every host. `terminalTypography`, `setTerminalFontSize`,
`clampTerminalFontSize`'s fallback, both resets and Settings → Terminal go through it, for the
face in effect only. theme.css's `--term-font-size: 15px` is the bundled face's default, and
`applyFont` sets it inline to 13px while the face is Omarchy's, so the token names the default in
effect; `terminalTypography` reads the map, not the token. A stored terminal family (`oats.desktop.terminal.fontFamily`)
or a size stored for the face still wins. Reset typography (⌘0 / Ctrl+0, the palette) forgets the
family and the face's size, and Settings → Terminal's "Reset to default" the face's size, so the
defaults apply again; the other face's size stays. A font change notifies the typography
listeners, so open terminals take the new face's size with its family. Every size control clamps
to 9–28 (`clampTerminalFontSize`).

The terminal's text weight belongs to the theme, not to typography: each palette sets
`--term-font-weight` (White 475, Solarized 450, Dark 400; This computer has its base's,
so 400 for a dark host theme and 475 for a light one), which `terminalFontWeight()`
(`theme.mjs`) reads into xterm's `fontWeight` when a terminal is created and again on
every theme change, at both creation sites in `shell.mjs` (the terminal tab and the
Settings preview). Chromium renders dark-on-light text lighter than light-on-dark, while
a native macOS terminal with font smoothing (Ghostty with `font-thicken`, measured at
Inconsolata 15) inks the same in every scheme, so one fixed weight cannot match all
three palettes. A missing or unusable token means 400 (xterm's `normal`). Bold stays
xterm's 700 (`fontWeightBold` is not set), and weight never changes the cell, so
`terminalTypography()` stays `{ fontFamily, fontSize }` and no weight is stored.

Every terminal keeps a minimum contrast ratio (#602): `terminalOptions()`
(`terminal-tab.mjs`) gives xterm `minimumContrastRatio: TERMINAL_MINIMUM_CONTRAST` (4.5),
so both creation sites in `shell.mjs` get it. It is one number for every theme: not a
parameter, a setting or a token. Text that is under 4.5:1 against its cell's background
is drawn lighter or darker until it reaches it; xterm never changes the background. 4.5
is WCAG AA for text, Desktop's bar in every theme, and the highest WCAG level that
leaves the hand-calibrated palettes unadjusted on their own background: the default
foreground and the 16 ANSI colours already meet it on `--term-bg` in White, Solarized
and Dark (`test/theme-contrast.test.mjs` holds them to the constant), so xterm acts only
on combinations nobody calibrated: ANSI on ANSI backgrounds, 256-colour and truecolour
text. 7 (AAA) would redraw most of the palette, and 3 would leave mid-grey on white
below AA. Dim text asks for half the ratio (2.25), which the palette colours meet, so
dim keeps xterm's own half-opacity rendering. xterm excludes box drawing and block
elements (U+2500–259F) and powerline glyphs from the floor, so borders and bars keep
the colour a program chose. Setting `options.theme` clears xterm's contrast cache, so
after a theme change the floor is applied against the new palette with no listener of
its own. `node packages/desktop/test/fixtures/terminal-colors.mjs` prints a labelled
screen of colour cases to look at in a terminal tab, in each theme.

**Selecting and copying (#520, #672).** A terminal tab is a tmux client with tmux's
mouse on, and tmux asks the terminal for mouse tracking (DECSET 1000/1002/1006).
`terminal-mouse.mjs` records those requests instead of letting xterm obey them: a
DECSET/DECRST whose every parameter is a tracking mode (9, 1000, 1001, 1002, 1003)
updates its own state and is consumed, so xterm never enables tracking and its
SelectionService always owns the buttons: a drag, double-click (word) and triple-click
(line) select, and a click focuses the terminal. A sequence with no tracking mode goes
to xterm as before (1006 is also recorded, for the wheel's encoding). A sequence mixing
tracking with other modes is left to xterm, tracking included, which is the old
behaviour (tmux never sends one); later tracking resets are then passed to xterm too, so
its tracking cannot stick. A RIS (`ESC c`) clears the recorded state. Each new
`Terminal` starts clean and tmux re-sends its modes on every attach, reconnects included.
The wheel is reported by the renderer while VT200, button-event or any-event tracking is on
(`attachCustomWheelEventHandler`; X10 tracking reports no wheel, as in xterm):
the line amount is xterm's own (`Viewport.getLinesScrolled`: pixel deltas accumulated per
cell height, LINE as is, PAGE times rows, Shift or a horizontal-only delta gives nothing),
and a non-zero amount writes ONE report per event, button 64 up or 65 down plus xterm's
modifier bits, at the pointer's cell, SGR when 1006 is set (pixels for 1016) and X10
otherwise (a report that needs a byte above 127 is not sent: xterm sends X10 as binary,
and `term.input` would UTF-8 encode it), through
`term.input(seq, false)` and so the usual `onData` → pty path. tmux's locked
`WheelUpPane` binding (`tmux-target.mjs`) therefore still drives copy-mode scrollback,
and a program that grabbed the mouse (Codex) still gets the wheel; the selection is
cleared, since the content scrolls under it. Copying is xterm's: ⌘C and Edit › Copy
(the menu role), right-click › Copy (xterm puts the selection in its textarea on
right-click, so the main process's editable context menu copies it) and the
`terminal.copySelection` action (Ctrl+Shift+C on Linux/Windows, terminal-allowlisted),
which writes `term.getSelection()` with `navigator.clipboard` and posts a notification
when the write fails; with nothing selected it does nothing. Every copy trims the spaces
and tabs that end each line (`trimLineEnds`), as Ghostty, kitty and VTE do: tmux redraws
copy mode with written spaces, which xterm keeps in a selection. ⌘C and right-click ›
Copy both reach the xterm textarea's `copy` event; `attachSelectionCopy` takes it first,
in the capture phase on the tab's wrap, and stops it so xterm's untrimmed handler never
runs. It takes only a copy aimed at xterm's own input (`term.textarea`): a copy from the
page's own content in the wrap (the banner, the reconnect strip, an input) is left alone,
terminal selection or not. With nothing selected it cancels that copy and writes nothing,
so the clipboard keeps what it held (#695): xterm's right-click handler, and on Linux its
mouse selection, leave the selected text in the textarea, still selected there, after the
terminal's selection is cleared, and Chromium's default copy would write that stale text. On Linux xterm also puts a mouse selection in its textarea and selects it there,
which makes it the primary selection, and middle-click pastes it through xterm's own paste
handler (its `auxclick` moves the textarea under the pointer), so it is one bracketed paste
like Ctrl+Shift+V. The primary selection is xterm's text, untrimmed: Chromium takes it only
from selection changes made while it handles the mouse event, so a later rewrite of the
textarea (on `select` or `onSelectionChange`) does not reach it, and no public seam runs
inside every one of xterm's writes (a re-drag of the same range and a right-click on the
selection fire no selection change). Verified live (#694).
`terminalOptions` sets `altClickMovesCursor: false`: with the SelectionService always
owning the buttons, xterm would otherwise turn a quick Alt/Option+click into cursor keys,
and a tmux client has no scrollback of its own, so those include Up/Down, which recall a
prompt's history (#694). OSC 52 is still written to
the clipboard by `terminal-clipboard.mjs`: it is how a tmux copy-mode copy arrives (a
keyboard copy inside copy mode, or a drag after the mixed-sequence fallback has handed
tracking to xterm). The renderer consumes the tracking requests whatever the remote's
version, so no drag from a Desktop tab reaches tmux. Write-only, a query is never
answered, at most 1 MiB, valid UTF-8 only. A refused OSC 52 write is said only while the
window has focus (`osc52Refused` in `shell.mjs`): tmux sends its copies to every client
showing the pane and an unfocused window's write is refused, so a copy made in another
terminal would otherwise stack notifications. The chord and the action always say it. The viewer's `MouseDrag1Pane` binding is
unchanged and serves only the direct CLI viewer (`lib/session-viewer.mjs` binds the
same) and the mixed-sequence fallback: no drag from a Desktop tab reaches tmux.

A terminal tab shows its program the way a native terminal would. It renders with
xterm's WebGL renderer (`@xterm/addon-webgl`, `createGlyphRenderer` in
`terminal-tab.mjs`), whose built-in glyphs draw box drawing and block elements
(Claude Code's input box, tmux borders) as thin joined strokes whatever the font;
the DOM renderer would take them from Inconsolata, at twice the weight. Every
failure falls back to the DOM renderer. Where WebGL2 is unavailable (a throwaway
probe, asked again on every show until it says yes) the addon is not activated:
addon-webgl 0.18 adds a canvas and listeners before it asks for the context, and
its dispose cannot undo a constructor that threw. An activation that throws
although WebGL2 was there is not retried for that terminal, which stays on the DOM
renderer until it is reopened.

When Chromium replaces its GPU process (after sleep, or a Space or window switch), every
WebGL context is lost and then restored within about 3 s. xterm keeps one glyph atlas per
configuration, shared by every terminal in the window, and the reset wipes its canvases
while its cache still believes the glyphs are drawn there, so every terminal would show
only backgrounds and the cursor (#1190). Re-showing a tab, `term.refresh()` or a fresh
addon do not cure it: they draw from the same stale atlas. `terminal-atlas-recovery.mjs`
does, created once by the shell over the tabs map: it hears each `webglcontextrestored`
on the document in the capture phase (the event does not bubble), waits until none has
come for `ATLAS_RECOVERY_SETTLE_MS` (250 ms), then calls `clearTextureAtlas()` on every
live terminal, hidden tabs included, in one synchronous pass. Never one terminal's own
clear from its own restore: each clear re-lays out the shared atlas under terminals that
already uploaded it again, and their glyphs garble. A context that is not restored within
addon-webgl's 3 s wait (Chromium also keeps only about 16, dropping the oldest) disposes
the addon instead, back to the DOM renderer, and showing the tab tries WebGL again; that
reload re-joins the shared atlas, so it asks the same recovery for a pass
(`createGlyphRenderer`'s `onRecovered`). `fitTerminal` sizes the grid to the pane's padded box
with no width kept for xterm's scrollbar (tmux draws in the alternate screen, so it
never scrolls, and `shell.css` hides it) and centres the remainder across and down,
in whole device pixels, like a native terminal's balanced padding. It counts cells
from the renderer's device cell, never its CSS cell: xterm reports the CSS cell as
the rounded screen extent divided by the current count, so fitting from it can
flip between two counts at a fractional width.

xterm measures its cell
when a terminal is created and only re-measures on a font change, so
`terminalTypography()` (`theme.mjs`) hands out the stack without Inconsolata
until the face has loaded, then notifies the typography listeners with the full
family, and live terminals re-measure and refit.

**Synchronized output (#1193).** Each keystroke in a program like Claude Code reaches
a tab as one tmux redraw that hides the cursor, repaints and shows it again; when the
IPC delivers it in two messages and xterm paints between them, the cursor flashes
hidden. The local viewer therefore attaches with tmux's `sync` client feature
(`-T sync`, `local-tmux-io.mjs`, where `tmux -V` says 3.2 or later; 3.0 and 3.1 have no
`-T`, and an unreadable version means none), so tmux wraps each redraw in DEC mode 2026
(`ESC[?2026h` … `ESC[?2026l`); a remote tab gets the same from the remote oats's
viewer. xterm 5.5 ignores the mode, so each lease's output goes through a gate
(`terminal-sync.mjs`) that holds a block and writes it to xterm in one call, however
the messages split it, the 8-byte sequences included. Everything outside a block is
written at once and unchanged (only a trailing prefix of `ESC[?2026h` waits for the
next message), and a block whose end never comes is written after 1000 ms, the bound
xterm 6 and tmux use. A lease that ends writes what its gate holds before the tab shows
it ended or reconnecting, and a close writes it before the terminal is disposed. xterm
6 honours mode 2026 itself: upgrading to it retires the gate.

### Control rules (selection, focus, search fields)

Three rules hold everywhere in the renderer (design v4.1 board 7; spec A implemented the
global part, views follow them in their own CSS). `test/control-rules.test.mjs` pins them.

1. **Selected = brand tint.** A selected segment/pill/toggle is `background: var(--sel);
   color: var(--accent); font-weight: 650`; unselected is transparent with `var(--muted)`.
   A segmented group is one 1px `var(--border)` frame with 2px inner padding and 6px-radius
   segments, no dividers. The shared `.ws-segmented` block in `workspace-discovery.mjs`
   (Setup List/Graph, Souls Group by) is the reference. Never "white vs grey".
2. **No ring on pointer interaction.** Visuals hang off `:focus-visible`, never `:focus`,
   so a clicked button, tab, segment, row or link stays quiet. `theme.css` styles keyboard
   focus globally: `:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px }`
   (the edge overlays a bordered control's border and is the inner pixel of a borderless
   one) plus `background: var(--sel)` on `button`, `a` and `summary`. The tint rule has
   (0,1,1) specificity on purpose: a control that paints its own opaque pair (primaries,
   danger, the toast) keeps it and shows the edge only, drawn 1px *outside* (`outline-offset:
   1px`) because inset it would sit on the control's own fill (accent on `--primary-bg` is
   1.52-3.38:1, on `--danger` about 1.1:1). `theme.css` lists those controls in one
   `:where(…):focus-visible` rule; a new opaque-fill control joins it. A control whose base rule has an
   id or two classes and should tint declares its own `:focus-visible { background:
   var(--sel) }` (`#tab-actions button`, `.ws-dialog-foot .secondary`).
   Do not add per-component `outline: 2px` rings. Large focusable panels (tabpanels,
   canvases, `pre` blocks) get the edge only. Padding-free text tabs and links
   (`.workspace-tabs`, `.auto-tabs`, Setup links) give the tint a layout-neutral inset
   on focus (`padding: 0 6px; margin: 0 -6px`) so it does not hug the label.
3. **Search/filter fields have one border.** A wrapped field (`.kb-search-field`) turns
   its wrapper border accent on `:focus-within`; the `<input>` inside has `border: 0;
   outline: none` in every state. A bare field (`.field`, `#ws-suggestion-search`, the palette
   input's bottom rule) turns its own border accent on `:focus-visible` and never outlines.
4. **Native selects have one look.** Every `<select>` is `class="field"` and takes
   `theme.css`'s `select.field` rule, unscoped because Brain and the Settings overlay render
   outside `.oats-view`. That rule gives `appearance: none`, the text field's frame and
   padding, and a static chevron drawn from two thin `--muted` gradient strokes (the inventory
   holds it as a graphic on `--surface`/`--surface-2`). Each theme declares `color-scheme`
   (`dark` for Dark, `light` for White and Solarized), so an open list and its scrollbars
   follow the theme. A page may size a select (width, height, vertical padding, font
   size), never paint it: `test/select-field.test.mjs` holds every sheet to that.

Contrast is checked on effective colours in all three themes: `--accent` on `--sel`
(selected text, focus tint) is AA text, and the accent edge/border is ≥3:1 on `--surface`,
`--bg` and `--sel`. Dark `--danger` on `--sel` is 4.27:1, which is why danger buttons
never tint.

Soul marks use a stable hash of the reported root/name/server identity and a
muted six-color palette. Optional top-level `color: sage` in an existing canonical
`soul.yaml` overrides the local Desktop mark. Accepted names: `sand`, `sage`,
`slate`, `mauve`, `clay`, `olive` (case-insensitive); invalid/absent values fall
back to the hash. This is display-only metadata, not a kernel identity or launch
setting, and there is no color editor or `soul.yml` alias. Current remote CLI
rosters do not report this field, so remote marks use the fallback. Change
package-owned declarations in reviewed package source, not locked installed
payloads. Colors can collide and never determine selection, status or identity.
Runtime marks show the reported runtime, not installation/authentication status.

## Workspace views (#482)

A window shows a workspace **view**: one matched workspace identity across machines
(`ws:…`), or one unattached deployment under its own id. `/api/panel` names the view's
`deployments` and tags every row with its `deployment`; `view-deployments.mjs` reads them
(validated, text only) and keeps the last deployments seen per view for surfaces that do
not read the panel. What they say (a deployment's state in words, the primary, the roster
split into sections) is `packages/client/roster-sections.mjs`.

- **The sidebar, top to bottom** (the product owner, 2026-10-26; slice 1 of the Desktop UI rework, its head,
  pinned rows, rows and foot): the head (`.side-head`, 40px, its 8px top padding keeping the heading's centre 24px
  down, as in the 48px bar, so the first row sits close under it; no line under it): the heading `#ws-heading`
  "Workspace" (13.5px 700 `--fg`; it labels the list), then **Add local workspace…** (`#ws-add-open`), a 28px
  `.side-icon-button` box; the list (`#ws-list`, a 1.5px `--border` line under it, a little bolder than the 1px one
  before the instances; rows `.ws-option`, 4px 8px 4px 10px, at least 24px tall); the pinned rows (`#nav`, PINNED:
  Home, Automations; 8px above the first and below the last, 4px on the left as the roster's list; a
  column of 32px `.nav-item`s in the roster rows' style: the icon on the roster's dot column, 18px in, the name in
  the roster's name type, 12.5px 600 `--fg`, the current one 650 on `--sel`; Automations carries `.nav-failed`, an
  8px `--danger` dot in the right-hand column, 25px from the right, and the sr-only ", a run failed", while
  `automations-failure.mjs` says a run failed: `paintAutomationsFailed` adds it and removes it); the roster
  (`#instance-roster`, its top border the line before the instances) under its heading, a `.ctx-head` (13px 500
  `--nav-fg`) holding "Instances" and the count, with "Refreshing…" after the count when loading.mjs adds it; then
  the foot (`#nav-foot`, pushed to the bottom, under a `--border` line, 4px 10px 4px 6px), one bar (`#sidebar-bar`,
  `role="group"` "Sidebar tools"), `[need you] … [New agent][?]`, built by `sidebar-foot.mjs`: **N need you**
  (`#sidebar-need-you`, hidden at 0; the needs-input mark and "2 need you" in `--fg` 600, its name "2 agents need
  you. Go to the first"; its mark on the rows' dots, 18px in: the foot's 6px, the bar's 2px, its own 5px, half the
  10px mark; it runs `focusFirstNeedingYou`, which focuses the first row in the roster's order with a claim, itself: chosen
  from the model in the painted order (sidebarSections, main then Background) with the count's gate, so a row a
  held parent hides is found though it draws no roll-up; its section opened, its collapsed ancestors expanded,
  then the list painted again and the row focused, its terminal not opened),
  painted by every roster paint from this workspace's rows with a claim (`waitingClaim`, the held-stale gate);
  **New agent** (`#sidebar-spawn`, `app.quickOpenSouls`: Quick Open), a + and its words (24px tall, 12px
  `--muted`, no fill at rest; `--surface-2` on hover and `--sel` on keyboard focus, in rules it shares with the
  count) with no hint element, its chord in its title (`applyChordTitles`); and 6px after it **?**
  (`#sidebar-help`, `app.shortcuts`: the shortcuts editor), a 24px `.side-icon-button`, centred 25px in from the
  right edge (the foot's 10px, the bar's 3px, half its 24px). No mark, no sidebar toggle (`sidebar.toggle` is
  ⌘B / Ctrl+Shift+B, the palette's and Show sidebar's) and no settings cog (Theme…, Font… and Keyboard
  shortcuts… are the palette's). The foot's nouns are `DESKTOP_NOUNS`' (desktop-terms.mjs: "agent", D3 decided; the CLI and the docs keep
  "instance"), never in the markup.
  Every `#nav-foot [data-action]` runs its action through the same registry as the keys. The workspace rows'
  names are the sidebar's 13px (the current one at 650), the roster's machine labels (`.ctx-deployment`) 11px 650
  muted capitals, its agent groups 12px apart (`.ctx-group`) and each top-level bundle inside a group 12px after
  the one before (`.ctx-bundle-gap`, a spacer: no row box is spaced). The palette has no button: it has its own
  chord, and **Connections**, in its Sections group, is Connections' only entry. The workspace list hides its scrollbar
  as the roster does.
  The roster has no
  filter field (the TUI keeps its own): the palette finds an instance by name. `sidebar.focusFilter`
  keeps its id, chord and leader key (**Focus the instance roster**): `focusRoster` lands on
  `rosterEntry()`, the roster's current row, else its first row, else a control it shows under its heading
  (Retry), else, on an empty roster, its one action, the foot's **New agent** (Quick Open; F6's stop in an
  empty roster too: one way in, the product owner's rule), else, while the roster is hidden (a window with no
  workspace), the list of workspaces' stop, else **Add local workspace…**, so focus never falls to `<body>`.
  The same entry takes focus when the last terminal tab closes, and a focused Retry that goes on an empty
  answer hands focus to the same New agent (instance-tree-view.mjs `focusFallback`). An empty roster says
  "No agents yet · <key> starts one" (`emptyRosterLine`: the noun `DESKTOP_NOUNS`', the key
  `app.quickOpenSouls`' from the keymap, said again on a keymap change).
- **A roster row** (slice 1): a 44px `.ctx-tree-row` box (the button 40px inside 2px transparent borders, the dot
  centred on it) of two lines, `.ctx-name` and `.ctx-meta.ctx-row-detail`, the shared row facts
  (`packages/client/roster-row-facts.mjs` `rosterRowFacts`, for the TUI too): the display name, then
  `<soul> · <machine>` (its deployment's machine, else a server row's label, else this machine: `here`, the host name
  the kernel reports, else `DESKTOP_TERMS.thisMachine`; a row of this machine's own deployment is this machine's; the
  machine alone with no soul). `here` is the schedule list's `host.name` (oats-local.yaml), which the Automations
  mark's reader hands on (`onHost`, shell.mjs `thisHostName`; the roster repaints when it first arrives). No repository, branch, pull request, reason label or harness badge on the row, no
  hover card and no tools overlay: the instance panel shows the facts (Work: repository and branch; Session:
  harness, model, the reporting-gap note and the runtime error; Needs input: the claim's words, its wait and its
  message; Developer: the pull request), the row's description says its reason (an unavailable row: as its title
  too) and its wait in absolute time, and its context menu holds every act (Open pull request…, Start…). An interim the lead agreed: the row's
  runtime error is its title and description, and `rowFactsTitle` (row-facts-title.mjs) adds the repository, the
  branch and the harness and model as a line of its title, never its description (a known keyboard limitation for
  a row with no terminal, until Details serves any row). A held
      home keeps its state and hint on its lines (a reported one setting up its worktree adds its soul and
  `rowFactsTitle` to its tooltip); a collapsed parent's roll-up takes line 2, which its description
  then says. Lines for related work only (superseding in part D26's "no lines"; no flag, no line): the pre-D26
  drawing, `treeConnectors` and `treeGuides` (instance-tree-view.mjs) over the cluster's drawn rows, by the shared rule
  in packages/client/related-work.mjs. The solid elbow and stem (`--tree-stroke`, 3:1 on every row fill) reach a child
  its host reports related to its parent (`drawsParentLine`: `relatedWork` with `instance-related-work`, `sameWork`
  with only `instance-same-work`); the dotted link (`--tree-link`) joins the dots of top-level rows a related sibling
  link joins (`drawsSiblingLink`, `siblingLinkSpans`: edges, not a star), passing beside the children between them. A
  top-level row no related link joins, and its block, carry no dotted segment: the line breaks around it, and the
  order never changes for it (the lead's choice, 2026-11-20). A row with no line carries no `.ctx-guides`. `--depth`
  indents a child 18px a level, `.ctx-bundle-gap`
  separates bundles, `stateSpan` says its state (", running", ", stopped", ", status unknown"; a held home's line says its own),
  and `relationSpan` (instance-tree-view.mjs) says ", under <parent>" (", related work" after it where the solid line
  joins them) and siblingText's ", sibling of …" (", related work" after the related siblings, at both ends of a link:
  instance-tree.mjs `relatedSiblings`) after the row's lines, resolved per deployment over its full roster as the
  palette's are.
- **The sidebar's width** (`sidebar-width.mjs`): one custom property, `--sidebar-w` on `#app` (288px in
  shell.css), which `#sidebar` takes as `width` and `min-width`. Its handle (`#sidebar-resizer`, the sidebar's last
  child and last Tab stop, after the foot; focus-regions counts it as the foot) is the split panes' resizer:
  `split-resize.mjs` builds both with `createResizeHandle` and drives both with `wireResizer` (pointer capture, the
  keys, double-click), the split's in ratios, the sidebar's in px (8px steps, Shift 32px, Home/End to the bounds,
  Enter and double-click to 288px; `sidebar.resetWidth`, no default chord, is the palette's **Sidebar: reset
  width**). Bounds: 240px to `sidebarMax` = min(480px, 45% of `innerWidth`), the minimum winning. The chosen width
  is stored as `oats.desktop.sidebarWidth` (a missing, invalid or out-of-bounds value, or storage that throws, reads
  as 288) and applied clamped on every window resize, so a window that shrinks and grows gives it back. A drag
  writes at most once per animation frame; terminals refit through their own ResizeObservers as on a hide, and
  `holdTerminalResizes` (terminal-tab.mjs) keeps their PTY resizes from the program until the drag lets go (key
  steps: until the keys rest 150ms), when each terminal that resized refits once more and sends its size.
- **No deployments above the navigation.** The sidebar lists no deployments; the Workspace
  page's Machines tab and the roster headings say where things run (UI spec, after the operator rejected a
  deployments block under the workspace switcher). The list of workspaces lists views.
- **The list of workspaces** (`workspace-switcher.mjs`, `#ws-list` under the sidebar's head,
  always shown; docs/desktop.md, "Workspaces"): one row per served view, whatever machine it is
  on, the matched views first, then the unattached ones, in ONE `<ul>` with no heading. A list
  of buttons, not a listbox, so the sidebar's plain keys stay live on it (shell.mjs
  `updateActiveContexts`). A row is one line: the instance roster's circle (its own `.ctx-dot`
  rule, `on` for the current workspace, `off` for the others, aria-hidden; its ring in the row's
  fill through `--row-solid`, and in the column of the roster's top-level dots) and the name
  (`rowNames`: twins of one name show their team and key, never a folder or a machine, which the
  shared `workspaceChoiceLabels` falls back to for the TUI): no other mark, no
  muted line, no not-live mark, no per-row button. Its tooltip is the whole name (a long one is
  cut by an ellipsis), never a path or a machine. Rows cut off below the bounded height are
  counted under the list (`.ws-more`, `moreBelowText`, aria-hidden), with the rows' needs-input
  mark (`.ws-waiting.attn-mark`, the "!" disc) after the count when one of them waits (the TUI's `+N ●`). `reset(current)` (a switch
  landed) keeps the rows and marks `current`; a pick on its way (`pickedId`) is where `step`
  goes on from, and a pick of the current row supersedes it. Choosing an unattached row also
  calls `requestDeploymentTab`, so the Workspace page opens on Machines, on that deployment's tab.
  - The current row is `aria-current="true"`, marked by style alone (its circle filled in
    `--accent`, the name in bold; no fill or edge of its own, `--sel` is the nav's); the section's `aria-description` names the current workspace by its row's name, never a path.
  - The needs-input mark: `choice.waiting`, only `true` draws it (`.ws-waiting` at the row's far right, `margin-left: auto`, the name cut off before it;
    the `.attn-mark` icon, shell-icons.mjs `attention`: a `--warn` disc with the "!" cut out in `--surface`, the mark of a waiting instance's roster dot and of the roster's roll-up pill too, which holds 3:1 on every row fill), with `WAITING_NAME` (", needs input", sr-only in the name) and
    `WAITING_TITLE` in the tooltip. It reads only what the client observes (panel-views.mjs
    `workspaceChoices`); it never reorders.
  - Keys (`onListKey`): one roving stop (`stopKey`, the row last focused, else the current
    one), Up/Down/Home/End over every row, Enter opens; ⌘Enter / Ctrl+Enter opens a row in a
    new window (`aria-describedby` the hint). `focusList()` (the current row, else the stop) is `app.workspaces` (shell.mjs
    `focusWorkspaceList`, which also leaves focus mode and shows a hidden sidebar).
  - The row's context menu (a `contextmenu` event: a right-click, Shift+F10, the Menu key) is
    the page's own `role="menu"` popover (`.ctx-instance-menu.ws-row-menu`, styled as the
    instance menu) with one item, `OPEN_IN_NEW_WINDOW`; the event is default-prevented, so
    main's native Copy/Paste menu never shows for a row. A right-click's opens once the button is
    released (`context-menu-release.mjs`). Esc or Tab close it, back on the row.
    No IPC of its own: the item calls `openInNewWindow`, as ⌘Enter does.
  - `step(±1)` is the leader's ↑ / ↓ (`workspace-previous` / `workspace-next`,
    leader-dispatch.mjs, which says `NO_OTHER_WORKSPACE` when it is false):
    `packages/client/workspace-step.mjs` with `wrap` over the rows as drawn (`drawn`, every
    one openable); it opens
    the row as a click does, and is false when no row but the current one can be shown.
  - A pick (click, Enter, `step`) calls `selectWorkspace`, which the shell runs as
    `switchWorkspace(id, { takeOver: true })` (see common.mjs above).
    - **Every workspace, always** (slice 1 of the Desktop UI rework): Show only the current workspace (2026-10-23)
    is gone with its button, its `workspaces.currentOnly` action, chord and palette command; the
    `oats-desktop-workspaces-current-only` value a window saved for it is neither read nor written. A focused
    row that goes from the list hands focus to the current row.
  - **Add local workspace…** (`openModal(opener)`, focus back on `opener` when it closes): this
    computer's deployments not served (`discoverSuggestions`, asked only as it opens), each a
    button that adds it and opens it here (`runAdd`, the main-validated add); then the stale rows
    of this computer's list, each its state in a word (`LISTED_STATE_WORD`, the sentence
    `LISTED_STATE_TEXT` in its tooltip and sr-only), opening nothing, with **Remove** beside it
    (`runRemove`, `removeListed`: Right Arrow reaches it, Left Arrow or Esc come back). One
    roving stop over them (`suggestionStop`). `#ws-confirm` is Onboard's alone. A window with
    no workspace opens it at once when nothing is served (shell.mjs `showChooser`).
- **Grouping by deployment** only when a view has two or more deployments: the sidebar
  roster (`rosterSections`, a heading per deployment named by `machineLabels` in the
  cluster-label type, a status mark when not live, none for a deployment without rows) and
  the Machines tab (below). With one deployment the roster renders exactly as before; the Machines tab heads
  its one deployment too (`tabContent`), so every machine's tree is under its name.
- **Agent groups and their order** (`rosterGroups`, `packages/client/instance-tree.mjs`, shared with the
  palette and the TUI): one sequence by each cluster's first root, in spawn order, newest first (`rosterOrder`:
  by `createdAt`, a row without a readable one last, then by name, ties by `instanceId`; the product owner's
  2026-11-13 request, which replaces #1262's name order and keeps #1083's running-first order out). A
  multi-member cluster is a group under its name; each run of consecutive single instances is one
  "independent" group, in place. So a bundle keeps its place when its instance gains or loses children, and
  a start or a stop moves no row. Keys: `cluster:<n>:<name>`, `independent:<first member's instanceId>`,
  decided on the full roster (a filter or a collapse moves no row, #971). The palette alone passes its
  last-focus record (`{ lastFocus }`): the clusters are ordered by `recencyOrder` first (#1383), and the
  sidebar and the TUI never pass it. Pinned first (feature `instance-pin`, `pins`): at every level a node whose
  subtree holds a pinned row comes before the others, each part in the order above, so a pin lifts its
  bundle and the path down to it; a cluster's rank within its part is still its first root's without pins
  (`docs/desktop.md`, "Pinned instances"). The palette's focused rows keep their recency order.
- **The disclosure, and roots that start collapsed** (the product owner, 2026-11-19; `roster-disclosure.mjs`):
  `sectionChildren` lists each row's children inside its own section (the main tree or the Background section,
  and a deployment's part), and a row with any gets `span.ctx-disclosure` (`aria-hidden`) on its
  `.ctx-name-line`, right after the name (the product owner, 2026-11-20), so every name at a level starts at the
  same place; an instance row has no tools over its end (slice 1), and a long name ellipsizes before the mark: a
  chevron (`svg.ctx-disclosure-chevron`, turned down by `.ctx-inst[aria-expanded="true"]`) and the count of every
  row under it (`rowsUnder`). A `.sr-only` ", N below" follows the mark, so the name is said first. The row's click handler
  opens or closes the row when the click lands on the mark (no terminal opens; the focus and the roving stop stay
  on the row), and the tree keys do the same (`onRosterRowKey`). The rows drawn collapsed are `collapsedRows`: the
  shell's `collapsedInstances` (closed by hand) and every root of its section with children that is not in
  `expandedInstances` (opened by hand). A row drawn as a pending row or a held home is never drawn collapsed
  (`staysOpen`: its lifecycle takes the row, which has no room for the roll-up) and wears no mark, so the keys have
  nothing to collapse there; a choice made by hand stays in the sets and applies again afterwards. A root whose
  subtree in its section holds a pinned row, its own included (feature `instance-pin`, `rowPinned`), is not collapsed
  by default (`startsOpen`: its own pin, or one `anyBelow` it), so the pin is seen with its group; a root closed by hand stays closed. Both sets are in memory per workspace and re-homed together
  (`rehomeWorkspaceState`), and `setRowOpen` is the one place both change (the row keys, the mark, `showInRoster`
  and `revealPendingSpawn`). Tests of other behaviour draw every root open (test/helpers/view-context.mjs
  `expandedInstances`); `roster-disclosure-shell.test.mjs` runs the default.
- **A row's name is its words** (0.68.1, the product owner): `rosterName(doc, name)` (instance-tree-view.mjs)
  builds `.ctx-name` for both row builders (shell.mjs `renderContextRoster` and `pendingSpawnRow`). Its first
  child is `instanceDisplayName(name)` (`packages/client/instance-display-name.mjs`, the TUI's too:
  "oats-expert-maintainer-lanes" shows "Oats expert maintainer lanes"), `aria-hidden`. Its second is the real
  name in `.sr-only`, so the row's accessible name stays the real name, and `data-name` holds it as well. Find a row by
  `.ctx-name`'s `dataset.name`, never its `textContent` (which holds both). Everything else that names an
  instance keeps the real name: the instance panel, the row's tooltips and descriptions, the
  palette's label and match, tabs, dialogs and copies. The `.ctx-name` rule (ellipsis, one line) is unchanged.
- **Needs-input reporting coverage** (`packages/client/needs-input-reporting-gap.mjs`): a Claude row whose
    recorded `oats.core` comes from package `oats.framework` below `1.6.0` gets the instance panel's Session
  note (below; the roster's hover card said it too until slice 1 removed the card). The reader accepts the drift-row array and the recorded map, local and remote,
  and uses `from.version`, never the current
  lock version. A prerelease of `1.6.0` sorts below it. Other harnesses, sources or packages, missing
  facts and malformed versions show nothing. This standing fact changes no row label or live-claim
    mark, and adds nothing to the terminal pane. The panel's live Needs input section from the agent's own
  `oats instance attention` claim can appear alongside it; neither suppresses the other.
- **The Machines tab** (the Workspace page's, before Setup; the Deployments page until 2026-10-26, and the Active
  overview before that; stage `hierarchy` opens it): tabs from
  `deployment-tabs.mjs` (All, then one per deployment; one deployment has only its own tab;
  the choice remembered per view); All stacks one section per deployment, a deployment's tab
  shows its tree alone. A non-live deployment's heading has a state chip, its `short` reason
  and **How to fix** (the `fix` steps, else the sentence, and any note); a live deployment's
  note shows under **Details** with no chip (`deploymentHasWords`). Under each machine's heading,
  `.hier-dsub` says what its tree is ("Instances on this machine", or "Instances on <machine>";
  `deployments-page.mjs` `deploymentHead`), and under the bar `.hier-intro` says once what a
  machine is ("Each machine runs this workspace in a folder of its own. The instances under a
  machine run on that machine."): plain words, no About dialog.
- **"On <deployment>"** (`deployment-scope-line.mjs`): deployment-level surfaces read the
  view's primary deployment, and some say which in a line under their heading, only with two
  or more deployments: the side panel's soul inspector for a soul, Brain and the Sync sheet.
  No Workspace page does (the product owner, 2026-10-23), and none makes the line: not the
  Workspace header (`workspace-discovery.mjs`) or any tab, nor Automations/Schedules
  (`views/automations.mjs`), nor a capability's page (`capability-page.mjs`), a
  team's page (`computer-teams.mjs`) or a soul's page (`soul-inspector.mjs` in
  `layout: 'page'`). They read the primary all the same (#482: their reads carry the view id, which the
  server answers from the primary), with no choice of deployment. The Machines tab names
  each deployment on its own tab. Launch configurations and spawn are not wired here.
- **Re-homing** (`workspace-rehome.mjs`, shell `rehomeWorkspaceState`, on every roster
  read): state under a deployment id (a selection, tab layout and active-terminal memory,
  open tabs with their `term:`/view keys, collapsed rows, stored spawn jobs) moves to the view
  that holds that deployment; a terminal follows its row's deployment when that moves to
  another view; a selected view id that is no longer served follows its deployments when one
  view holds them all. A group that never reports keeps its own id, so nothing moves.
  Spawn jobs keep `deployment` (where the transaction is addressed) apart from `workspace`
  (the owner that moves).

## Machines tab (formerly the Deployments page and the Active overview) — slice 7a, reported roster only

The existing `hierarchy` stage consumes **GET `/api/panel` only**. Relation groups
are connected components of the shared parent/sibling resolver across roots and
repositories, never repository buckets. Groups remain anonymous/count-labeled;
reported context is metadata, not a derived group name. Header counts distinguish
multi-member groups from independent instances and keep unknown runtime state
separate from stopped. Parent/child edges are OAS-style cubic S-curves from the
parent's bottom-centre to the child's top-centre; sibling edges are shallow arcs
dashed `5 4`, so the two kinds do not rely on color alone. `--graph-edge` holds
3:1 against every surface it is drawn on (WCAG 1.4.11, pinned in
`theme-contrast`); the lit lineage is `--accent`. The 220px cards show reported context/runtime/branch—not guessed
PRs, worktree health or task activity. Same-named nodes carry visible root/home
suffixes and host qualifiers; their popup exposes the full reported address.
Those are per-instance identity cues, never invented group names.

Activity and waiting-on-you are explicitly **unknown / available after K7**.
`TASK`, `STATE`, transcript prose, unnegotiated activity/group labels and the old
aggregate `instance.git` are not consumed by this projection. The popover offers
exactly two acts, **Go to instance** and **Go to soul** (below); Git, Restart
with… and the soul's own facts live in the roster row's menu and the instance
panel, and no Tasks destination or Stop/Retire surface is introduced.

`active-observation.mjs` validates the roster/address shape and rejects duplicate
identities rather than silently losing nodes. Local request tickets and global
workspace generations guard both outcomes. Workspace switches synchronously
revoke old graph/actions/gestures; a foreign workspace reply is not silently
adopted over an explicit selection that the server still serves (a stale
selection, no longer among the served choices, is adopted like an empty one).
Failures retain an explicitly stale last
observation with actions disabled, not a false healthy empty graph. A manual
retry can supersede a read; periodic polling skips its own pending request so
slow responses are not starved. A manual retry of a window whose last reply
named a deployment on another machine first awaits
`POST /api/remote-roster/refresh` (the servers read again), then reads the
panel; polls never ask for it.

No-op polls ignore timestamps/unconsumed metadata and preserve actual popup
controls, focus, camera, offsets and selection. Changed observations wait for
an active gesture to finish; a newer failure revokes a queued success. Window
blur/hidden ownership cancels gestures, and drag-click suppression expires after
its own native click window rather than swallowing a future intentional click. Popup
controls survive meaningful updates for the same identity and resolve the current
record, not a captured stale object. Hidden/disposed/replaced controls cannot
act or reclaim focus. Action text remains screen-sized outside the scaled stage,
bounded to the viewport during zoom/pan/resize. Go to instance (the terminal tab,
or **Start…** on a stopped row, which has no terminal) uses the current full
home/root/server and requires known runtime state and an available route;
double-click, Enter and `T` take exactly its act. Terminal key handling itself is
unchanged.

**Go to soul never guesses.** It opens the Workspace page's page of the
instance's exact soul, handed over with `preselectSoul({ name, key, repoKey,
agentsRoot, server })` and `ctx.openView('spawn')`. The facts are the row's
`soulKey` (the roster agent row's `key`, carried by `rosterRows`/`panelInstance`
and kept by `active-observation.mjs`) and `soul.repoKey`, matched against the
row's own deployment's catalog (`/api/agents?ws=<rowDeployment(row)>`, read once
per popover per roster observation, the last answer standing while a re-read
runs): a local row is exact when exactly one catalog row has its key, source and
agents root and the key is not in `catalog.ambiguous`; a remote row when exactly
one of its host's agent dirs has its name, root and server. The Workspace page
shows only the view's primary deployment's souls, so a row of another
deployment is disabled before any read. The soul page inspects by bare name
and root (`inspectSoul`'s selector `{ soul, agentsRoot }`, which
`inspect-boundary.mjs` refuses when two souls of the root share the name), so
an exact soul whose name another soul of its root shares is disabled too, and
`preselectSoul` refuses a keyed handoff that meets one on arrival (`onMiss`
with `sharedName`). A
`catalog.reason` reply is a failed read and a deployment whose catalog is not
read yet keeps it checking, as the Workspace page reads them. Every other case
is disabled with a title that says why (nothing recorded, not in the catalog
now, several, the read failed, still checking). A late answer is kept only while its read is
still the popover's (`s.soulRead`, dropped by `closePop`), and a miss on arrival
is said in the popover's status line, or as a notification once the page has
gone.

## Spawn dialog — workspace model v2

`spawn-dialog.mjs` owns the form; `views/spawn.mjs` is a thin host (modal,
focus trap, Esc/backdrop close, the `spawn.submit` binding and the handoff). In
the shell a confirmed local press is handed to `spawn-jobs.mjs` (`ctx.spawnJobs`)
and the dialog closes at once; the store runs the shared transaction
(`packages/client/spawn-transaction.mjs` `createSpawnTransaction`), owns the roster's
pending row (`shell.mjs` `pendingSpawnRow`), the outcome notifications and the
**New** marks, and keeps the draft for **Reopen spawn** (`preselectSpawn({…, draft})`).
After the press the shell reveals the pending row without focus (`ctx.followSpawn`)
and, when the instance runs, `spawn-follow.mjs` takes the operator to its terminal
unless they acted since the press (input, a focus move, a navigation) or an overlay is
open; focus merely resting where the dialog returned it does not count. Otherwise its row says New. See
`docs/desktop-spawn-preview.md`, "Background spawn". Souls come from the kernel's spawn catalog (`oats souls --json` via
`GET /api/agents`), never from the roster. Two layouts, switched in place
(design board 6): **scoped** — opened from the soul page's New agent or Quick
Open — heads the dialog *Spawn <soul>* with where the soul comes from
and shows the preview column (*What will be created*: name, works in, harness
and where it came from, default team; *Core capabilities* and *Capabilities*
from the preview's projected `modules`, each with its source and, when the
preview reports it, its reason; a skeleton while it reads, the footer's
refusal sentence when it fails). The facts are data from the shared home's
`previewFacts` (`packages/client/spawn-preview-facts.mjs`), which any client
draws its own way; the dialog draws them. **Change soul** switches the same dialog to
the **picker** (the soul chooser, grouped by source, alphabetical, externals
last, keyed by `agentsRoot + name + server`); switching soul keeps the typed
name and instruction, and a soul chosen there reopens in the picker. Quick
Open (⌘P / Alt+P) opens the scoped layout too (`preselectSpawn`), and
dismissing that dialog returns to where the operator was.

Keyboard (spec F; `../docs/desktop-keyboard.md`): Mod+Enter (`spawn.submit`)
spawns from any field, plain Enter in Name never does; DOM order is Tab order;
Relationship and Teams are one tab stop each (`roveSegment`: arrows, Home/End);
the soul chooser is a `listbox` of `option` buttons where typing filters,
Enter in the search picks the best match and Enter, Space or a click on a soul
picks it, every pick moving focus to the first field. The dialog opens on its
first field, the Opening instruction (`focusFirst`: no scroll, the caret at the
end of a restored draft); Name is optional and last. Mod+1–Mod+7 jump to the
instruction, Harness, Model, Relationship, Teams, Name (`focusName`: caret at
the end) and Developer settings: the keys follow the form's order
(`spawn-dialog-keys.mjs` registers them with `spawn.submit` in the
`spawn-dialog-local` context, once, for the editor; the host resolves and stops
them; `jump()` and `setShortcuts()` are the dialog's).

Main form, in order: the **Opening instruction**, **Runtime** and **Model** (always visible, showing the kernel's real defaults
with a *default* pill), **Relationship** (Independent / Child of / Sibling of /
Parent of, a segmented control; choosing one reveals the instance picker), **Teams**
and **Name · optional**. Below `SPAWN_NARROW` (760px, one column) the preview column moves
into the form's scroll area after its last field, above the footer (`placePreview`, a
`matchMedia` listener): moved in the document, so reading and Tab order stay the order on screen. Name: with `spawn-name` on a local spawn
(`roleNamed()`), a typed name goes as `--name`, lowercased (the kernel uses a
name exactly as given) and with nothing appended (`finalName`), and
an empty one reads "Left empty, the kernel numbers it." (with `spawn-suggest-name`
and a field never typed in: "Left empty, the instance is named from its task.", and the
task's suggested name is the placeholder and the choices' `name`; the suggest read is in
`packages/desktop/docs/desktop-spawn-preview.md`); otherwise (an older
kernel, a remote target, whose `/api/spawn` takes a purpose) it is a purpose
with the `<soul>-` prefix shown. The 64-character check runs on the final name
(the typed name itself, or `<soul>-<purpose>`);
the kernel's name refusals show under the field. **Developer settings** is collapsed: work area (base | branch,
the worktree path relative to the deployment, *Use a worktree instead* for
checkout souls), permissions, **messaging identity** (Default / Local /
Global + resident, sent as `--provider <cap> identity.mode=…` to the messaging
provider the preview reports; shown only with `spawn-provider-payload` and a
messaging provider, and its hint says what the decision binds), launch
configuration, session backend, Run on and the wake schedule. The footer (Cancel, Spawn ⌘↵) is sticky.

Every value shown is the kernel's own preview: the dialog reads
`POST /api/workspace-spawn-preview` in the background (debounced; a newer
choice starts its own read at once and only the latest ticket settles,
owner-checked on success and rejection) and never resolves a default itself.
Editing never waits on it: no field is disabled or rebuilt by a read, and after
the first settle the preview column keeps the last settled facts marked
**Updating…** (`aria-busy`) while the Name fact follows the form. **Spawn** is
one click, pressable whenever the form is valid (a press before the preview for
those choices settled waits as **Checking…**, and an edit drops it): prepare →
the server checks the prepared decision still matches what was shown → apply
with the bound revision and key.
If the kernel decided differently at Spawn time nothing is applied and the
dialog shows the new values for review. An unknown outcome offers **Check
result** on the same intent. A completed receipt hands off to the terminal
only after an exact composite roster match; partial wake results stay
created with **View schedules**. Execution-server spawns (Run on, or a remote
soul) use the host's own defaults and naming. The `spawn.submit` chord hint
lives on `data-chord`, not `data-shortcut`, so the shell's shortcut titling
never hides the Spawn button.

**Deployment** (#482, decision Q2; `spawn-deployment-field.mjs`, wired in one
delimited block of `spawn-dialog.mjs`). A workspace view can hold several
deployments (`/api/panel` `deployments`). With two or more, the form shows a
**Deployment** field first, before Name, in place of *Where to run*: the form's
segmented control with two or three deployments, the Harness-style dropdown with
more (never a native select). Options are named by `machineLabels` ("This Mac",
"devbox", "This Mac · oats-qa") with a state tag when not live; the preview
column's **Runs on** row gives the chosen one's `deploymentLabel`. With one
there is no field and the form is unchanged. Rules:

- **Addressing.** Every spawn request addresses a deployment, never the view:
  `?ws=<chosen id>` (else the only one, else `workspace.primary`) on the preview,
  prepare/apply and the launch-configuration list. The preview and apply echo
  that deployment.
- **Availability** is each deployment's own catalog (`/api/agents?ws=<id>`, read
  when the dialog starts, latest intent). The selector is the chosen deployment's
  catalog row (`catalogSoul`: the root differs per deployment). A deployment
  without the soul stays selectable (a deployment that isn't live is marked by
  its state). Choosing it blocks Spawn, said once, in the footer only: "<machine>
  isn't reachable right now." when a remote isn't live, "This Mac's deployment
  hasn't been read yet. Try again in a moment." for a local one not read yet, else
  "<soul> isn't available on <machine>."; nothing is read.
- **Default.** The last used in this view if it has the soul; else the first
  that has it, local before remote; else the last used (blocked). With nothing
  used yet: the first local one. Until every catalog answers, an untouched field
  holds a provisional choice and no preview is read.
- **Last used** is `localStorage['oats.desktop.spawnDeployment']`, a
  `{viewId: deploymentId}` map of at most 32 views. It is written on a created
  spawn only: the dialog's own completion, a remote reply, or `spawn-jobs`
  `created()`.
- **Changing deployment** clears the settled preview and re-reads (Spec B's
  prepare/apply/cache are unchanged). The choice key includes the deployment, so
  a reply for the previous one never settles. Relation anchors are the chosen
  deployment's rows only.
- **A remote deployment** spawns through the execution-server path: `serverId`
  is its server and `agentsRoot` comes from its catalog row. The reply's
  `workspaceId` is a view, and `doSpawn` switches only when that view is not
  the one on screen.
- **Background jobs** (`spawn-jobs.mjs`) are owned by `workspace` (the view: pending
  row, notices, in-flight) and addressed by `deployment` (every `post` and reply
  check). The deployment is kept in `sessionStorage` across a reload, and a
  created row becomes real only when its own deployment's row reports it.

*Where to run* (one-deployment views) lists the registered servers, or, with
`servers-per-workspace` and `server-connect`, only the window's machines
(`/api/servers?ws=`) followed by *Add a machine to this workspace…*
(`add-machine-dialog.mjs`; a button under the Deployment field in views of two
or more deployments). See `../docs/desktop-machines.md`. Its disabled states
come from every view holding a remote deployment (`serverFacts`, since
`/api/team-members` is view-scoped). A chosen group's relation rows are that
group's deployment only (`serverRows`).

Problems read as one plain sentence about what happened and what to do, keyed
by the contract's stable code: the shared home says what happened (`fact`) and
names the act that follows as a `next` code (`packages/client/spawn-messages.mjs`,
`SPAWN_NEXT`), and `spawn-words.mjs` composes the Desktop's sentence from them
with its own words for that act, which name its controls (`spawnText`, and
`outcomeText` for the store's and the dialog's outcome notices). The code and the
technical or kernel text — paths, hashes, the `git clone` remedy — stay
behind a **Details** toggle and in `data-code`; no decision depends on wording.
For an unmatched launch preference (`E_LAUNCH_PREFERENCE_UNMATCHED`) Details
hold the code and then the kernel's message and fix, each on its own line
under "OATS says:" (`packages/client/kernel-lines.mjs` `kernelLines`, one
`span.spawn-problem-line` each). A soul's launch problem (the soul page and
panel, `soul-inspector.mjs` `launchProblem`) is drawn by the same function for
every code, from the parts the shared home gives (`packages/client/soul-facts.mjs`
`soulFacts`, which also gives the harness card's rows and notes, the work line
and the spawn refusal): the Desktop's line (`p.launch-problem-own`), then one
`p.launch-problem-said` per kernel line, and the code behind Details.

Model suggestions are advisory (`/api/models`), custom entries stay valid, and
a remote target never borrows local model/configuration facts. No capability
or readiness facts appear in this dialog; soul readiness belongs to the soul
inspector.

## The soul inspector on the workspace model (`operationsApi: 2`, `soulsApi: 2`)

`POST /api/capabilities` runs `oats inspect` for exactly one subject: the
selected **soul** (`--soul`, what a spawn of it resolves now) or the selected
**instance** (`--home`, as spawned — an instance never changes under itself).
There is no scope subject. The gate is the probe integer `operationsApi === 2`
(`packages/client/inspect-contract.mjs`); any other value gets the "update OATS" line and no
request. The response must name exactly the selected subject, or it is not
rendered The payload's own integer is checked too: a classic scope
still answers `operationsApi: 1`, which the inspector names ("still uses the
classic layout") instead of reading.

The inspector is read-only (the soul is edited in its repository) and shows the
kernel's records: the soul row's source (`member <repo> @ <c7>`), team, path,
work, declared runtime/model; its declarations (`capabilities`, `requires`,
`defaults`, `knowledge`, `teams`, `resources`, `children`) with declaration
problems verbatim; the instructions (for a home, with the composed inject
sources); the effective layer providers; each resolved module with its version,
layer, origin (its `from`), missing requirements and merged settings; and the
layer providers' operations. Top-level `problems[]` read as one plain sentence
each (the kernel's message), the code behind **Details**. No classic field
(scope chain, activation, trust, snapshot drift, sources provenance) is read.

Provider operations are addressed `<layer>:<name>` (`oats operation run
knowledge:status --home <h> --json`). An operation that is unavailable (e.g. a
home operation on a soul: "needs a running home (--home)") or that has a
required argument shows its reason instead of a control; optional arguments are
never synthesized. A run result is read only when it is `operationsApi: 2` for
exactly the operation pressed (a classic scope's `1` is named); a view renders
its `summary` and `documents` as inert text, and an action its JSON. Kernel
refusals (e.g. `E_OPERATION_UNKNOWN`) are shown in the kernel's words.

These reuse the existing inspection lifetimes and latest-intent guards; there is
no per-card request fan-out or polling inspection. Routine roster/CLI polls keep
the settled DOM; stale successes and rejections cannot overwrite the current
observation. Native visual acceptance is not inferred from the DOM/CSSOM and
computed-token AA tests.

## Loading states (`loading.mjs`, `loading.css`)

Every data region runs on one state model, owned by the controller
`createDataState()` in `loading.mjs` (vanilla DOM, no tokens of its own):

| State | When | What is painted |
|---|---|---|
| pending | no data for this subject yet | after 150ms a skeleton shaped like the final content; `aria-busy` on the region; the status line says "Loading <noun>…" once — never an empty-state message |
| ready / empty | the last read succeeded | the content, or the surface's own empty copy after a successful zero read |
| refreshing | data present, a read in flight | the content stays interactive; "Refreshing…" with a static dot after 400ms in the surface header (the Instances heading: after the count); no `aria-busy`, no announcement |
| stale | data present, the read failed | content kept; "Couldn't refresh <noun> · observed <age>" with **Retry** in the attention style and the cause behind a **Details** disclosure (and in the line's title, which never holds a refusal's detail: that stays in Details, alone in its `<bdi>`; the controller repaints both from the cause it was given, never from the title); announced once through the status line, which is then clipped (`.loading-quiet`, its box kept) so the amber line is the one visible message — never the error red; actions that need current state are held by the surface with `aria-disabled` (never `disabled`: Chromium blurs a focused control that becomes disabled) and an accessible reason (`aria-description` + title: "Unavailable: roster is not current", "Unavailable: inspection is not current"), and every handler on a held control checks the mark first |
| failed | no data, the read failed | the cause, a **Details** disclosure with the code (and a refusal's detail after it, alone in its `<bdi>`) and **Retry**, where the skeleton stood |

The controller owns the two delays, `aria-busy`, the status-line text, the age
line (`observedAt` from the response, `Observed <age>` after two minutes even
on success; no age when the field is absent) and the Retry wiring. The surface
owns its latest-intent tokens and calls `begin()` / `succeed()` / `fail()`
only for the read it still owns; `reset()` on a new subject, `defer()` when a
read settled without an observation (the server's deployment is still
`pending`: its copy stands in, no skeleton, still busy), `cancel()` when a read
was abandoned. Wording is fixed in `wording`; "Reading …" and "Loading…" are
retired. Refresh and Retry controls go through `bindRefresh()`: `aria-disabled`
while a read is in flight, never `disabled`, so a focused control keeps focus.
A rebuild from new data restores focus and scroll through `captureFocusState()`,
called right before the repaint (focus may have moved while the read ran):
actionable controls carry `data-focus-key` (`remove:<label>`, `op:<layer>:<name>`,
`instance:<home>`…) and are re-found by key only — a path is never trusted onto
a button, since a repaint happens exactly when positions shift — while a
disclosure summary is re-found by its structural path; a control that vanished
hands focus to the surface's Refresh. An identical poll is skipped through a
JSON signature of what the surface paints. CLI-missing, deployment-pending and
not-observed states keep their own copy: they are separate truthful states, not
skeletons.

Skeleton shapes (`skeleton(doc, shape)` / `skeletonBlock`): `roster-row`,
`soul-card`, `table-row`, `detail-section`, plus `pill` for counts and `line`.
The roster-row and soul-card skeletons wear the real classes (`.ctx-tree-row`,
`.ctx-inst`, …; `.soul-tile > .soul-card > .sbody / .sfoot`) so shell.css and the
Souls grid's CSS own their geometry: a redesign moves the skeleton with it, and
no pixel value is copied into loading.css. The Capabilities list's skeleton
(`catalogSkeleton` in `workspace-discovery.mjs`) is an `aria-hidden`
`ul.cap-list` of `div.cap-row` rows for the same reason. `defer({ keepSkeleton: true })` is
for a server that answers "still reading" (`refreshing: true` with nothing
held): the subject is loading, so the skeleton stays, or arrives when an
earlier `defer()` (an unobserved deployment's copy, no skeleton) left the
state pending.
`loading.css` (linked from `index.html` and the harness) derives their fill
from the theme tokens (`color-mix` of `--fg` over the host), shimmers at 1.6s
and stops every animation — including the older `.spinner` — under
`prefers-reduced-motion`. Text colours are the inventoried AA pairs (muted on
bg/surface, warn on attn-bg); `test/loading-contrast.test.mjs` proves them on
the effective colours. One live region per surface: where a surface has no
visible status line (the sidebar roster, the hierarchy), `statusLine(doc,
{ visuallyHidden: true })` speaks and the visible notice is a `role=note`.

Where each surface wires it: the sidebar roster in `instance-tree-view.mjs`
(`createRosterLoading`, `rosterSignature`, the pending count pill,
`ROSTER_STALE_TITLE`) and `shell.mjs` (`refreshContextRoster`;
while stale, Start…, the row's context menu and a *stopped* row's own activation are
held — a stale `running:false` may be running by now — while a running row
still opens its terminal; a row of a `stale` deployment, `rowStale` in
`packages/client/roster-sections.mjs`, is held the same way, and so are its actions in the
overview); the hierarchy in `views/hierarchy.mjs` (the summary
pill, its own notice keeps the stale copy with the observation's age); the soul
inspector in `soul-inspector.mjs` (while `loading.settled === 'stale'` — the settled state, so a Retry in flight over stale content keeps the hold — every
`[data-mutate]` control and the teams panel's join/leave — `createTeamsPanel`'s
`mutable` / `mutableReason` — wait with `INSPECTION_STALE_TITLE`; Launch,
Schedule and Files come from the roster and stay; a same-subject `show()` is a refresh that never runs
`frame()`: the actions are built once per subject and read the current row at
click time, the roster-derived block — lede, refusal, facts, Instances — is
repainted behind its own signature, and "Teams here" is created with the frame
so `soul teams` runs beside `inspect`) and `soul-teams-here.mjs`; readiness in `readiness-view.mjs` (the
summary line is separate from the status line so an announcement never
overwrites it).

The Workspace view (`views/spawn.mjs`): the Souls grid's controller
(`s.gridState`) paints card skeletons in the grid (one row plus one, at the
real card size), the failed block in the grid and the stale line in
`.souls-notice` above it; `settleGridState()` reads the reply — the kernel's
`catalog.reason` is a failed read (stale beside a partial list, failed with
none), an unobserved deployment defers with the deployment's own copy, and
`refreshing: true` with no souls keeps the skeleton. So does an empty list
with no `catalog` beside a panel that says the deployment is observed: the two
reads run side by side, and when the Workspace page opens with no read held yet
`/api/agents` can be answered before the server's first observation and
`/api/panel` just after it; that answer is no read of the souls, so the grid
keeps loading until the next poll, never "No souls are materialized". A remote
view's panel names no deployment, so its zero read stays empty.
`renderGrid()` leaves the grid to the controller while there is no data (the
one exception is the unobserved deployment's copy, removed once the deployment
is observed) and skips an unchanged paint behind `s.gridSignature`. The Capabilities tab (`workspace-discovery.mjs`): the held
table is never set to null within one workspace generation — a CLI emit or a
sync re-reads it in place (live after a sync, `refresh: true`), a failed
re-read marks it stale with Retry, and spec 02's held-table shapes (`status:
'ok'` with `reason`; non-ok with `lastGood: { capabilities, observedAt }`) are
shown stale. Both tab counts reserve their width with a pill while the count is
expected (`paintCount`); a failed roster read leaves the Souls count empty and
still (`rosterUnavailable()`). The capability page (`capability-page.mjs`,
painted by `paintCapabilityPage` in `views/spawn.mjs`): opened from a soul
before the catalog is read, the lede and the Comes-from facts are skeletons
filled in place when the discovery's `onCatalog` fires; a catalog refresh
while the page is open repaints it behind a signature over the content only,
with focus kept by `data-focus-key` (`used:<soul>:<root>`, `file`; a vanished
control hands focus to Back); the catalog's age line under the page bar is
the controller's own notice (`noticeElement` / `updateNotice` in loading.mjs,
through `catalogNotice` / `updateCatalogNotice`), updated in place on every
catalog event and on the roster poll (`touchCapabilityPage`), so its Retry
keeps focus, wears the busy mark while the re-read runs, and its age ticks.
A failed read that carries data (the kernel's `catalog.reason` beside a list;
a non-ok capabilities read with `lastGood`) calls `succeed()` only when
nothing was shown yet, then `fail(error, { observedAt })`: with data on screen
`fail()` alone updates the stale line in place — one node, one announcement,
a focused Retry kept. The spawn dialog's harness, model and launch hints (`matched()` in
`spawn-dialog.mjs`) read only a preview for the choices on screen, like the
name and work hints.

**The capability page's Contents (spec C).** What an instance gets, read through
`oats capabilities show` (feature `capability-show` AND `capabilityShowApi: 1`;
gated off with a line for an older CLI, a remote workspace, an external
capability or one the catalog does not list): `capability-contents.mjs`, a
controller `views/spawn.mjs` creates per open page (`s.capOpen.contents`) and
whose one long-lived `element` `renderCapabilityPage` re-appends after
Provides on every rebuild (`hold()` puts focus and both panes' scroll back),
so a catalog repaint never touches what is open. `update()` takes the
CATALOG row (from a soul page, the catalog's row, not the resolved one): its
selector (`--member repoKey` / `--package id`) and commit key the subject; an
unchanged subject reads nothing. The decoder (`packages/client/capability-show-contract.mjs`,
shared with the server) refuses a whole answer it cannot read. Every path is
relative to the capability directory (a skill's files too; the tree shows
them relative to the skill). The show read and each file read carry tickets
checked on success and failure (A→B→A safe); an answer at another commit
than the row's is never rendered (`E_CAPABILITY_MOVED`: the catalog is re-read
through `onCatalogStale`, as on `E_CAPABILITY_UNKNOWN`). A moved commit keeps
the open file while it is still listed. The navigation is ONE `role=tree`
holding two labelled `role=group`s (Instructions, Skills; an empty group is a
label and a note beside it), with a roving tab stop found again by
`data-focus-key` (`file:<path>`, `skill:<path>`). The reader renders Markdown
through `views/markdown.mjs` in its strict profile (front matter through
`front-matter.mjs` as a facts table, or as YAML code when outside its subset)
and everything else as highlighted code; links are settled after rendering
(`settleLinks`): a listed file, `https:` through `openExternal`, `#fragment`,
or plain text. The card's CSS, the tree's keyboard model
(`createContentsTree`: roving tab stop, arrows, Home/End, Right/Left
expand/collapse or enter/climb, Enter/Space call the host's `activate`) and the
reader (`createContentsReader`: sticky head, file rendering, link settling,
copy buttons) and a skill's tree item (`skillTreeItem`) live in
`contents-reader.mjs`, shared with the soul page's Instructions; the host decides what is listed, read and opened. `E_CAPABILITY_FILE_UNKNOWN` and `E_REMOTE_FILE_OVERSIZE` are
muted lines, not failures. The reader sits on `--bg`, the viewer's own ground,
so the viewer's checked colours hold, with a type scale kept under the page's
own (headings below the 20px title, code at 12px). The page's *Provides* is one
compact card (`providesSection`): a row per kind (Skills, Commands, Hooks; from
a soul, Commands and Settings) with every name its own code chip, wrapping.
`paintCapabilityPage` renders the page's facts and Contents from the same
current catalog row (`contentsRow`), so a refresh moves them together.

**Trigger sources on the capability page (kernel feature `trigger-sources`).**
`capabilities show` answers `triggerSources` only when the manifest declares
the key, exactly as written and whatever its shape, and
`triggerSourceProblems` (`[{source, pointer, message}]`; `source: null` is a
top-level problem, which disables every source) only when the declaration has
problems. Both are tolerant fields of `capabilityShowData`, like `warnings`:
an answer without them projects without them, and nothing about them refuses
the answer. `triggerSourcesOf` keeps the first 16 sources in the kernel's
order (a name cut at 128 characters), each as `{ events, description? }`
(the string events only, at most 16 of 64 characters; a description of at
most 1024) or `null` when its value is not a source's shape; a declaration
that is not an object is `null` and its raw value is not relayed.
`triggerSourceProblemsOf` keeps at most 64 problems (source 128, pointer
1024, message 4096 characters), skipping an entry without a message. A
source's `command`, `parameters`, `fields` and `urlHosts` are not shown, so
they are not relayed. The projection is idempotent (the server projects
before it relays and holds the answer, the renderer projects the relayed
answer again) and built from entries, never by assignment: a manifest key may
be `__proto__`. The problems are the kernel's text about the declaration:
they never join `problems`, never change the Contents section's state or its
warnings, and never mark the capability as failed. `triggerSourcesView`
(DOM-free) is what the page says: nothing, `{ unreadable }` (not an object,
or a top-level problem) or `{ sources }`, each with the kernel's messages
about it; a source with a message, or whose value is not a source's shape,
is declared but not usable, and a source only a problem names is listed too.
`fillTriggerSourcesRow` (`capability-page.mjs`) draws it as the Provides
card's last row, in both forms of the page. A source's name, events and
description are the manifest's words, neither the kernel's nor the Desktop's,
so they are shown only through `sourceQuote` (`source-quote.mjs`) under
"From the capability's manifest:": text, one `displayLine` each, never
markup, a link, a button or a tooltip. The kernel's message is a note of its
line, outside the quote ("declared, but not usable: …"); a declaration that
can't be read is the Desktop's plain line and then the kernel's messages, no
quote. The answer is the Contents controller's, so the row is too: a second
long-lived element (`contents.triggerSources`), repainted only when its view
changed and empty while nothing is declared. `renderCapabilityPage({
triggerSources })` appends it while it has content (building the card for it
alone when the page has no other row), and the controller calls
`onProvidesChange` when it gains or loses content, which
`paintCapabilityPage` holds in its signature so the page is rebuilt around
it with focus kept.

**Opening a capability by name.** `preselectCapability(name, { onMiss })`
(`views/spawn.mjs`) selects the Capabilities subtab and opens the page of the
ONE catalog row whose `name` is exactly `name`, as its table row does; with
none or several nothing opens and `onMiss(count)` says so. It follows the
selection-handoff rules of `preselectSoul`: held until the view is mounted
and the catalog of the current workspace has been read (applied on the spot
when both already are; a failed read keeps it waiting for the retry),
consumed once, and superseded by a workspace switch or any newer selection.
The discovery mints a selection intent for every tab change, its own
projections included, so the handoff adopts the intent its tab change mints.

**Capability warnings (OATS 0.49.0, `hook-event-unsupported`).** A capability
that declares a hook event the kernel does not run still composes; the answers
that show it carry `warnings[]` (`{code, capability, path, message}`; strings in
`spawn --preview`). A warning is not an error: it blocks nothing and never
changes a ready state or an attention count (the Sources tab's count already
counts every non-team workspace warning, unchanged). Two modules, used by every
surface:
`packages/client/capability-warnings-contract.mjs` (pure, imported by the server: `warningsOf`,
`previewWarningsOf`, `warningsShown`) projects tolerantly (a missing or
malformed list is none, a malformed entry is skipped, nothing refuses its
document) and idempotently (every string is already a `displayLine`, so the
renderer re-projects the server's relayed projection to itself; preview lines
are joined by `\n`). `capability-warnings.mjs` (`createWarningsList`,
`capabilityWarningsCSS`) is the one presentation: the icon and the word
"Warning", the message as text, code and path behind **Details**, at most 32
then "and N more"; the host owns the heading and the repaint barrier, and the
controls carry `data-focus-key` `<prefix>:<i>:details|open`. Surfaces: the
capability page's Contents (a block above the card, no Open capability:
a tolerant field of `capabilityShowData`), the soul page (below the problems,
**Open capability** through the inspector's `capabilityTargets`, the composed
instructions' path; prefix `soul-warning`), readiness (`readinessData.warnings`,
after the four checks, apart from a provider's own `result.warnings`;
`createReadinessView({canOpenCapability, openCapability})` from the inspector;
in the Workspace sidebar, where readiness shows, Open capability opens the page
as the Capabilities table does, Back to the list, and only for an instance on
this computer in the view's primary deployment, the one the page reads (#482;
another deployment's or a server's instance shows its warnings without it);
`readiness-warning`), the instance Soul tab (compact,
no Open capability: the context panel navigates nowhere, `soul-tab-warning`),
the spawn preview (lines only, after the launch prompts) and Workspace ›
Sources (every non-team workspace warning, its remedy a muted line; Open
capability when the catalog lists the name, each warning resolving its own row
by its path, so two capabilities of one name each open theirs; an unchanged list
is kept as the same element, so a roster repaint leaves an open Details open;
`ws-warning`; `workspaceStatusData`
keeps `capability` and `path` only when they are text). The contrast test holds
the list on each host's real ground.

**The soul page (slice 3a).** One column (`soul-inspector.mjs` `renderSoulPage`):
the top block (`dl.soul-top`: Harness · model, Teams with "Teams on this computer"
folded under it, Knowledge, Ready), the soul's warnings, its capabilities as one
list of rows (`workspace-catalog.mjs` `capabilityRowElement` and `roveRows`, the
Capabilities page's own row since slice 3b: core first with its *core* tag, the
official mark or *by <source>* by the same rule, the catalog's one line, and no
*default* tag; one roving stop, Up/Down/Home/End), then the instructions. Ready
(`createReadyBlock`) is *Ready* or the first of: the roster row's spawn refusal,
the inspection's first problem, the launch problem; behind a native **Details**
the problems in full and the soul's readiness checks (`readiness-view.mjs`, a soul
selector), created on the disclosure's first open. Its agents are not listed (the
grid and table count them); an instance opens in the sidebar from the roster.

**The soul page's Instructions (spec D; slice 3a's tabs).** `soul-instructions.mjs`,
after Capabilities on the soul page only (not the 340px inspector, not an
instance): two tabs, **Soul instructions** and **Composed instructions** (one
roving stop, Left/Right/Home/End switch), each a reader at a readable measure
with its section list on the left when the page is wide (a container query hides
it under 760px), then **Skills** folded under a native disclosure. The soul's own
AGENTS.md comes from the inspection the page already
read (`souls[0].instructions` = `{ file, text, truncated }`, no request of
its own), rendered through `contents-reader.mjs`. The
path shown is `<souls[0].path>/AGENTS.md` (`path` is the soul's directory in
its repository), else just `AGENTS.md`; the absolute `file` is a host cache
path and is never shown. `text: null` (or no `instructions`) is the reader
line "This soul's AGENTS.md could not be read."; `truncated` is the head's
flag, worded for the inspection's 200,000-character cap. The inspector
creates one controller per subject in `frame()` (disposed with the subject)
and `render()` re-appends its element after taking `hold()` before
`content.replaceChildren()`, so a repaint keeps focus and both scroll
offsets; `update(soul)` repaints a reader or the Skills tree only when what
it shows changed. The tabs' focus keys are `instructions:tab:own|composed`.

**The composed AGENTS.md (spec D, B2; routed, spec R part RD).** The gate is
`packages/client/composed-gate.mjs` (the shared home's, read by the page and the server). On the soul page of a
local soul, when the CLI's probe advertises `soul-composed-instructions`
(`composedSupported`), the inspect request carries `instructions: true`
(`composedWanted` in `soul-inspector.mjs`; never the sidebar). On a routed
soul's page (`agent.remote` or `agent.server`) it asks only when the CLI also
advertises `server-probe-features` (`routedComposedSupported`): that CLI's
roster relays each host's own features as the group's `probe.features`. The
server accepts that one boolean on a soul inspect only and keys the cache on
it; for a routed workspace it keeps it only when the roster group it holds for
that workspace says the host composes (`hostComposes`: `probe.ok` and an
array `probe.features` naming the feature; `null`, a missing key or a failed
pull is unknown, and unknown is not supported), else drops it, so the read is
exactly the plain one. The renderer's ask is never the proof, nothing is
decided from `E_REMOTE_INCOMPATIBLE`, and nothing probes. The adapter appends
`--instructions` (after `--server` and the soul target) only when the probe's
features list it. `composedOf(soul)` decodes `souls[0].composedInstructions`:
`undefined` (key absent: no group), `null` (cannot be composed here: a note,
the problem shows with the page's others), `false` (an answer that breaks the
contract — ranges that don't tile `text` from 0 — a note, nothing rendered), or
`{ text, truncated, parts }`. Parts are the body (`source: 'soul'`, file
`<path>/AGENTS.md`) then each `sources[]` entry with its marker lines dropped
(`blockText`; a part cut by the cap may lack its closing one); a part wholly
past the cap (`start == end == text.length`) shows "Not included: past the size
limit." It is the top item of the "Composed for an instance" section: "AGENTS.md" with
"after spawn, with injects" as its second line (`.cap-node-desc`, the description
style, not the path's `.cap-node-file`), accessible
name "AGENTS.md, after spawn, with injects", and its parts count as
`aria-description` (the reader head says "Composed AGENTS.md").
That item is expandable and selectable (the twisty only folds;
the row opens the document); a part's item scrolls the one continuous reader to
its `section.soul-part`, labelled by its header. Every part renders as Markdown (`fileView(…, { markdown: true })`: an `inject.txt` is still a slice of
AGENTS.md; its file is provenance only), and the document's heading ids are renumbered across parts with
one `createHeadingSlugger` (`views/markdown.mjs`, the same slugging `decorateMarkdown` uses; a suffix
never reuses an id already emitted, so "Usage", "Usage", "Usage 1" are usage, usage-1, usage-1-1), so they are
the ids the whole AGENTS.md would give; a part's own `#fragment` links follow its renamed headings.
**Copy** copies the kernel's
`text` exactly (markers included); **Open capability** appears only on a
capability part the page lists, and goes through the page's own
`openCapability` path. Keys: `composed`, `part:<i>`.

**The two sections.** The tree's top level is two `role=group` sections, each
labelled by its heading (`.soul-section-title`), a rule above the second:
"Defined in this soul" (the own AGENTS.md, key `own`, then a Skills group) and
"Composed for an instance" (the composed AGENTS.md, or its note, then a Skills
group). One tree still: one tab stop, the arrows cross the boundary. Without
`soul-composed-instructions` the composed section has no AGENTS.md row and no
note, as before.

**The soul's own skills (#1144, kernel feature `soul-skills`).** A Skills
group sits in each section of the same tree. The request
follows the composed AGENTS.md exactly: `skillsWanted` in `soul-inspector.mjs`
adds `skills: true` (soul page only) when `skillsSupported` (local) or
`routedSkillsSupported` (routed) holds; the server validates it like
`instructions`, keys the cache on it and, routed, keeps it only when the held
roster row's host reports it (`hostReportsSkills`; the shared host half is
`hostAdvertises` in `packages/client/composed-gate.mjs`); the adapter appends `--skills` after
`--instructions` only when the probe's features list it. `skillsOf(soul)`
decodes `souls[0].skills`: `undefined` (key absent), `null` (can't be listed),
`false` (any contract break, one bad skill or file included: never a partial
list), else the list. Each path is a plain path relative to the soul's
directory, a file's under its skill's and unique; a file's `text` is `null`
exactly when it is `binary` or `omitted`. A group that lists nothing is its
label and one note as a `role=none` row in its place inside the tree (absent,
`[]`, `null`, broken each have their own sentence), never a tree item. Each
skill is `skillTreeItem` from `contents-reader.mjs`, the same item capability
Contents lists (name, first sentence of its description, the full text in the
row's title, "More files not listed.", the unlisted item for `files: null`);
selecting it toggles it. A file opens in the reader under its repository path
(`soulFilePath`: `<souls[0].path>/<file path>`, else the soul-relative path),
with its size, "Truncated at 256 KiB" when cut, the binary line, or "Not
shown: past the size limit of this answer." when omitted; the kernel's answer
carries every text, so nothing more is read. The reader's link resolver is
keyed by repository path across the card: a link to a listed skill file opens
it in place (its skill expanded), from a skill file, the soul's AGENTS.md or
the composed "From this soul" part; a change of the listed files repaints what
the reader shows, so no link outlives its target. Keys: `file:<path>` (soul
relative); a skill item's `skill:<path>` names it in the expanded set and its
focus key, never the selection.

The composed section's Skills list the same skills again, each with "From this
soul" as its second line (`skillTreeItem`'s `source`, which puts the
description's sentence in its `aria-description`), then the note "Skills that
capabilities add are listed by a newer OATS." (only when the skills were
listed, an empty list included; an absent, unlistable or unreadable answer is
that case's note alone). These rows are copies with their own keys
(`composed-skill:<path>`, `composed-file:<skill path>//<path in the skill>`), so selecting one never
selects the row above; a link from a composed copy or the composed document
opens the composed copy of its target, else the copy that is listed.

**Every skill an instance gets (#1421 §1, kernel feature
`soul-composed-skills`).** When the inspection carries
`souls[0].composedSkills`, the composed Skills are that list, not the soul's
own again, and the "newer OATS" note goes. The request is the soul skills'
again: `composedSkillsWanted` adds `composedSkills: true` (soul page only)
when `composedSkillsSupported` (local) or `routedComposedSkillsSupported`
(routed) holds; the server validates it ("Invalid composed skills flag"),
keys the cache on it and, routed, keeps it only when the held row's host
lists them (`hostComposesSkills`); the adapter appends `--composed-skills`
after `--skills` only when the probe's features list it. `composedSkillsOf`
decodes it by `skillsOf`'s rules (`undefined`, `null`, `false`, the list),
each row also carrying a non-empty `source`. Each row's second line is
`skillSource(source).label`: "From this soul", "From <id>" for
`module:<id>`, nothing for a value it doesn't know. A soul skill's files open
under their repository path; a capability's paths are home-relative
(`.oats/modules/<id>/…`) and shown as they are, with Open capability in the
reader head when the page can open that capability (`canOpenCapability`, as
for a composed part). `[]`, `null` and a broken answer are a note each ("No
skills from this soul or its capabilities.", "The skills an instance gets
can't be listed: see the problem above.", "This OATS answered composed skills
this Desktop can't read."). A capability may declare one skill inside
another, so a composed file path is unique within its skill only (the composed
keys name the skill) and a link from a composed file prefers the copy in the
skill being read. A flagged skills read may print more than any other read:
the adapter gives it `SKILLS_INSPECT_MAX_BUFFER` (32 MiB: the 3 MiB of skill text JSON may print sixfold, and room) in place of
`ENVELOPE_MAX_BUFFER` (4 MiB).

**Core capabilities and Capabilities read as one system.** Wherever the two
sections appear (the soul page, the inspector's *Modules as spawned*, the
spawn preview, the context panel's Soul tab), a core slot's provider (by
`layers.<slot>.id` or by a core `layer`) and a soul emptying a slot
(`capabilitiesOff[]` with `reason: "slot-none"`) belong to Core only: never
listed or counted under Capabilities (`compositionEntries`,
`composePreviewModules`). Core's rows come from `coreEntries` in
`capability-page.mjs`: one per slot, with the reason the kernel reports
(`layers.<slot>.from` behind `layers-from`, the emptied slot behind
`desktop-facts`, "No default" only with both and a soul subject; never a
guess), in the same words everywhere (`whyTag`, `coreNote`, `whyFact` for the
capability page's "Why" row). On the soul page (slice 3a) both are one list of
`capabilityRowElement` rows, core first, each a `button` with
`data-focus-key="capability:<id>"`; why a capability is there is the row's title and
its page's "Why" row, and what the soul turns off is one line under the list.

The terminal-side context panel's Soul tab (`instance-soul.mjs`) and its
Messaging & Teams section (`instance-teams.mjs`): the roster-derived header is the
context panel's and stays put; each section owns a body under it
(`context-panel.mjs` mounts the Soul section on `.context-panel-soul-body`;
the Teams section appends `.instance-teams-body` to its host) where the
controller paints the skeleton (rows wearing the real classes), the failed
block with Retry (`refresh: true`) and, for the soul, the stale line — never
a silent absence, nothing prepended above. Both re-read the same selection
when `instanceStatusIdentity(instance)` (`instance-status-identity.mjs`:
home, last start, running, module drift rows, soul source) changes: the soul
as a refresh that keeps its content, the teams by refreshing the card's list
(or inspecting again when there is no card). An inspection without the soul,
or without a messaging provider, is an empty read: the header stands, the
Messaging & Teams section hides. That section claims its place during the
inspection only when the roster row already reports `identityAddress` (or a
failure is on screen), never again after a no-provider answer, so nothing
under it shifts. Every controller has a `focusFallback` (the section head or
the card's Refresh; the Soul body host; the Souls search field; the
Capabilities search field): a focused Retry whose line or block leaves on
success never lands on `<body>`.

A row on a registered server reads through the same route by its deployment
(`remote:<group>`) and home: its identity also carries the server, and it gets
the same one read per selection, never a poll. The Soul tab says "Reading from
<server>…" while the read waits. Before sending, the gate runs in `update()`
(and Retry goes through it): a row the kernel doesn't report addressable shows
`unaddressableSentence`, and a CLI here without `operations` in `remote` shows
`unroutableReason`, each as the failed block with nothing sent. A host's
refusal arrives as the route's relayed `reason` (`/api/capabilities` attaches
`hostReason`, `apiJson`/`httpError` keep it only through `remoteReason`), and
`relayedFailure` (`packages/client/remote-address.mjs`) turns it into the failed block: the
headline, or for `E_REMOTE_INCOMPATIBLE` the section's own
`incompatibleSentence`, with the code and the kernel's message under Details.
The Teams card's own provider operations (its list, Refresh, join/leave) relay
a host's refusal the same way, with the kernel's message after the code in its
Details. A card already up for a row that stops being routable (it left the
host's list, or this computer's OATS lost remote operations) holds its controls
and is replaced by the reason at the next render, with nothing sent. The soul
page shows the same relayed reason.

Roster-derived claims follow the roster's *settled* state
(`rosterSettledState(s)` in `views/spawn.mjs`: the controller's `settled`
while a re-read runs — a refresh over a stale roster is still stale — else
its `state`), synced after every poll, settled or failed: the soul
inspector's Instances card (`instancesState()` → `syncRoster()`) says "No
instances yet." only after a good read, shows a skeleton line while pending
and makes no claim (no count) while failed or stale; the capability page's
"Used by" fold (the list's column went in slice 3b)
shows a muted "—" carrying `ROSTER_STALE_TITLE` (`loading.mjs`, re-exported by
`instance-tree-view.mjs`) as their accessible description instead of "Not used" /
"No instance carries it yet." while the roster is not settled-good. With
`souls-capabilities` the claim derives from the souls list (the same read, the
same state) and the "—" carries `SOULS_STALE_TITLE` instead. A
roster failure discarded because the selection moved still `cancel()`s the
grid's read, so nothing is left "refreshing". A catalog that failed with
nothing held shows the failed treatment on an open capability page
(`failedElement` / `updateFailed`, shared with the controller's own block:
cause, Details, Retry), never silence; a Retry over it paints no skeleton
(`catalogPending` only before the first read settles). The Messaging & Teams section
treats a no-provider answer as a settled absence (`cancel()`, not data), so a
later failed re-read is the failed block with Retry, never a header over an
empty body.

Spawn stays enabled over a stale Souls grid: a local spawn goes through the
dialog's live kernel preview (the preview boundary binds the choices to the
kernel's decision at spawn time), so the grid's staleness cannot make it act
on old facts. A remote spawn (`runRemote` → `doSpawn`) has no preview binding;
that path is unchanged by the loading-states work. Filed for a later a11y
pass: consolidating each surface's several live regions into one.

## Team controls on a live instance (teams contract 2026-09-25)

An instance's inspector shows a **Teams** section (after its Instance facts)
when the home's messaging provider **declares** the home operation
`messaging:teams`; Join/Leave need `messaging:join` / `messaging:leave`, whose
one required argument's name is read from the operation row (`--arg
<name>=<label>`). The gate is never a provider name or version
(`teams-panel.mjs`). No messaging provider: no section. A provider without
`messaging:teams`: "Not supported by this messaging provider." — never an
error. A soul subject has no section (home operations).

The teams document (1.16 names: `{defaultTeam{team, source}, primary, eligible[{label, team,
joined}], joined[{label, team, since, identityHome, receive}], unmapped[label],
at}`) is read only from an `operationsApi: 2` run for exactly that operation
and decoded strictly (exact keys, bounded strings, absolute identity homes,
unique labels; `source` is exactly `setting` or `root`). Rows: the workspace's default team (always on, no Leave; its id and, in words, where it comes from: "set by the workspace or host setting" or "the messaging root's active team"); each eligible
label (primary marked) with Join, or when joined its date, how its mail
arrives (`poll` → "Checks this team's mail between tasks", `native` →
"Receives this team's mail as it arrives", anything else as sent — a poll team
never reads as live delivery), its identity home and Leave; labels the
workspace does not map, unavailable. Join/Leave answer the same document (plus `actions[{action: join|leave, label,
released?, receipt?}]`, accepted on those answers only: each label an eligible or
joined row, the receipt opaque and never shown), so the panel repaints from it; a refusal (`E_TEAM_NOT_ELIGIBLE`,
`E_TEAM_DEFAULT`) shows the relayed message verbatim under its row with the
code behind **Details**, keeps the last good state and re-reads. If the re-read
no longer offers that row (e.g. the mapping was removed between read and
click), the refusal moves to the top of the panel, verbatim with its code and
"<label> is no longer offered to this instance.", and stays until the next team
action or an explicit Refresh/Retry. One action at
a time: while it runs every team control and Refresh are locked. Reads and
actions carry the inspector's selection lifetime plus their own serial, checked
on success and rejection, so an obsolete answer paints nothing and re-arms
nothing. The generic Provider operations list leaves the three team verbs to
the panel on an instance.

## Workspace view on workspace model v2 — Capabilities, Sources, sync (F2)

Every fact comes from the installed kernel; the Desktop parses no deployment
file and resolves nothing itself (`workspace-discovery.mjs`, `workspace-catalog.mjs`,
`workspace-sync-view.mjs`, server `server/workspace-sync.mjs`, `packages/client/workspace-cli.mjs`).
A capability row's rules (its source and group, the sections, the search and
who uses it) are the shared home's `packages/client/capability-rows.mjs`, and
the capability page's facts and words its `capability-facts.mjs`;
`workspace-catalog.mjs` and `capability-page.mjs` draw them.
Gate: `version --json` advertises `workspace-v2` with `workspaceApi: 2`; a remote
workspace is observed through its server and never synced from here.

- **Capabilities** is `oats capabilities --dir <deployment> --json`
  (capabilitiesApi 1), held by the server and re-read when the workspace
  state it was read under moves, or when viewed after 60 s
  (`docs/desktop-load-path.md`); the tab reads
  the held table via `POST /api/workspace-sync?ws=<id>` `{action:"read"}`
  when it opens (`refresh: true` forces a live read; after a sync the table
  is re-read). Since the Desktop UI rework's slice 3b the tab is **one list**
  (`renderCapabilityList`, `ul.cap-list`): no sections, section jump, repository
  pills, group headings, tiles or two-letter marks (two-letter-identity-marks no
  longer applies on this page; the marks stay everywhere else). The order and
  the tags are the shared `packages/client/capability-list.mjs`
  (`capabilityList`): core capabilities (a knowledge, messaging or tasks
  `layer`) first in that order, then the rest by name. A row is one native
  button (`button.cap-row`, Enter and Space its own; ↑/↓, Home and End move
  along the list, which keeps one tab stop), two lines: the name, its dim tags
  (`core`; `default` or `default · off` from `defaultState`; `repo only` for a
  `private` row) and who made it (`originElement`: the official ✓ in a circle
  with "Official: in the OATS catalog" or "Official: from the OATS repository" as its
  title and accessible text, per the fact that made it official, or
  "by <source>"), then the manifest's description on one line. Who made it is
  `packages/client/capability-origin.mjs` (`capabilityOrigin`, D24): official
  when workspace status reports the row's package pinned from the catalog
  (`packages[].source` is `catalog:<id>`), or for a member capability of the
  OATS repository (`github.com/oats-project/oats`, or its old key); never from
  an `oats.` prefix. A package's name and version are not on the list (Setup's
  Packages box and the page have them), and neither is *Used by* (the page's
  fold has it). Each row carries a `data-focus-key`
  (`cap:<kind>:<package or repo>:<name>`) the tab host restores after a
  repaint. Back from a page returns to the row with the list's scroll offset
  and search.
  **The defaults** (`workspace-defaults.mjs` `defaultsLead`) are a tag on their
  own rows and, since slice 2b's Amendment 1 (D), a **Workspace defaults** part above the list
  (`workspace-catalog.mjs` `workspaceDefaultsPart`, from `packages/client/capability-list.mjs`
  `workspaceDefaultsSections`: Core, one slot each for Knowledge, Messaging, Tasks, its default's row or "No default";
  then Additional, every other default, on or off), opened by one sentence (`p.cap-lead`), then **All capabilities**
  over the list, whenever `oats workspace status` reports `defaults` (`defaultsSummary`); without it there is no part,
  no sentence and no tag, and the list is the tab's only content. The part's rows are the list's own
  (`capabilityRowElement`), one roving stop across both groups, their focus key prefixed `defaults:`. The sentence says what defaults are and what they are
  for (one shared way of working; a soul can turn one off and choose its own),
  then which core slot no default fills and any declared default no row
  matches (`defaultNames` matches by name and source: `from: "package"` a
  package row, a member key that member's row, `"here"` the host's). The search
  never narrows it. Slice 3b had replaced slice 0's Core / Additional panel with the tag and the sentence; slice 2b
  brings the Core / Additional grouping back as rows (Pepe, 2026-11-20, Joan's yes). Neither ever edited the defaults,
  which the workspace file declares.
  The capability page (`capability-page.mjs` `renderCapabilityPage`) is one
  column: the name and its tags, the origin line (who made it, then the package
  and version or the repository at its latest), the description as one
  paragraph, then **Skills** (`capability-contents.mjs`: the `capabilities
  show` answer's skills, each a button with its name and first sentence, or the
  catalog's names while that answer is not there), then native disclosures
  (`details.cap-fold`, `data-fold`): Commands, Settings, Triggers, Hooks, Used
  by, Comes from (`source`), As <soul> resolves it (`as-soul`) and Files (the
  Contents card). A fold opened on a capability stays open across its page's
  rebuilds. Enter on a skill opens the whole skill (`skillView`, placed by the
  page beside its body, which is hidden meanwhile): its SKILL.md through the
  reader (front matter as a facts table, then the body), its other files a
  press away; Esc or its Back returns, focus on the skill's row. The skill's
  file reads carry their own latest-intent ticket.
  The page's *Used by* fold uses the same rule as before (`capabilityUsers`):
  with the kernel feature `souls-capabilities` (`soulsComposition`) the souls
  whose composition includes the capability (`composes` / `soulsUsing`, a soul
  whose `capabilities` is `null` not counted), else the souls whose instances
  record the module (`capabilityUse`); one row per soul, and its column counts
  that soul's live agents carrying it. A package soul's instances are matched by
  the roster's agent name, `rosterAgentName`: `<package>--<soul>`, the kernel's
  `packageSoulAgentName`. Opening a soul goes by its key. "None" is said only
  after a settled good read.
  The toolbar's round "i" (`about-dialog.mjs` `createAboutDialog`) is built
  once by `workspace-discovery.mjs` and kept in the toolbar's lead across
  repaints, as the search field is. Workspace › Souls has its own "i", built once by
  `views/spawn.mjs` (the Machines tab has none: one sentence under its bar says what a machine is). The dialogs are the lifecycle dialog's frame, with focus
  handling from `forget-dialog.mjs`: they join the overlay handoff, and leaving the
  tab or the workspace closes them with `close({ focus: 'none' })`. All their
  words live in `ABOUT_COPY`.
- **Teams** (kernel feature `team-model-2` or `team-model-3`, `teamModelOf`;
  `computer-teams.mjs`) is the
  *Teams* page: *Workspace teams* (read-only, edited by PR) and
  *This computer's teams* (the kernel's local teams, declared in this computer's
  `oats-local.yaml`: add, remove, make default; `TEAMS_COPY`), one card per team with
  its address, who may join and, from the roster, the instances whose
  identity's team is that team's id (nothing when none). Those members come
  from `/api/team-members?ws=<view>` (#482, decision Q5): the view's
  deployments only. A card groups them by deployment (`memberGroups`), each
  heading labelled by `deploymentLabel` ("This Mac · ~/acme · 3",
  "devbox · ~/northwind · not reached"), this Mac's first. A member's
  `workspace` is its deployment id. Its Show and Terminal actions stay in the
  view on screen (`teamMemberAction` never switches workspace). They wait for
  the row of that deployment, and the open is owned by the view
  (`instanceActionTarget(view, row)`).
  Team model 3 (`teamsApi: 2`) adds *Souls in the workspace*, the committed
  `souls:` patterns, read only; local teams take Add and Make default only
  where `localTeams` allows them, and a local team left where they are closed
  keeps Remove under the kernel's local-teams-closed failure. The soul page's
  *Teams here* (`soul-teams-here.mjs`) is read only then (`soulTeamsApi: 2`).
  Wording about where teams change is the kernel's (`LOCAL_TEAMS_CLOSED`,
  `SOULS_WHERE`, `UNMAPPED_FIX`, `UNCONFIGURED`; tests pin them to
  `lib/teams.mjs`).
- **Sources** (Setup) renders the roster observation's `oats workspace status`
  as one list (its graph went in slice 3b): repositories (team, confirmation
  status), packages (lock, capabilities), external souls and this computer.
  Each member's **Details** / **Why?** opens its panel under its row
  (`selected`, `onSelect`): the handshake, what it means, its capabilities by
  name and the kernel's detail. No extra read.
- **Machines** opens on the list of the computers the workspace runs on
  (`workspace-machines.mjs`, `../docs/desktop-machines.md`): this computer, then,
  with `servers-per-workspace` and `server-connect`, this workspace's machines,
  each with reachable and its OATS version (no agent counts in this slice);
  Enter opens one with Check and Remove; Add a machine at its head. Mounted once
  per workspace and kept mounted across the page's repaints (focus stays on its
  controls), `sync()` on each roster poll. Its header's **List | Map** (`machinesView`, `setMachinesView`;
  `onMachinesView` tells `views/spawn.mjs`) swaps it for the Deployments view
  (`views/hierarchy.mjs`, mounted in `.workspace-machines-panel` only while the
  Map is shown), until slice 6 makes that the Graph. A handoff may name the view
  (`preselectWorkspaceTab('machines', { machinesView: 'list' | 'map' })`); without it
  the tab opens on the view last chosen.
- **Notes** keep the F1 guards visible: an unreachable workspace (module drift
  not current), withheld instance rows, unsynced/stale declarations and
  workspace problems, each in the kernel's own terms.
- **Sync** (header) runs `oats sync --json`: it resolves every `packages:`
  entry, fetches it and writes the lock. There is **no package approval** —
  declaring a package is the trust decision (kernel feature
  `packages-no-approval`; a kernel without it gets the "update OATS"
  state, never a half-working view). The header says *Lock current* or *Lock
  out of date* (from `oats workspace status`). A sync that did not finish
  (`E_PACKAGE_INTEGRITY`, lock drift, an unreadable remote…) or that reports
  problems opens a sheet with one plain sentence; the kernel's code and
  message stay behind Details. One sync per deployment (`E_SYNC_BUSY`). The
  roster refreshes after a sync.
- **Onboarding** (Add workspace → Browse…): a picked folder without
  `oats-local.yaml` gets a single-use offer bound to its canonical path; the
  operator types the workspace repository and main runs `oats onboard <dir>
  --workspace <ref> --json`, then the ordinary transactional add. A refused ref
  gets a fresh offer for the same folder; `rolledBack` is reported.

**Pinned tops and one scroller per tab (spec G, `sticky-top.mjs`).** The view
is one fixed-height column that never scrolls: the tab row (`.workspace-header`,
which also carries Setup's Sync and Machines' List | Map) and the Souls bar sit outside the
content scrollers (`.souls-grid`, `.workspace-discovery`). Each scroller is
positioned, `min-height:0` and `overscroll-behavior: contain`; the view root
(`.souls`) is `position:relative; overflow:clip`. Inside the Capabilities
scroller the search and its "i" (`.ws-toolbar.ws-sticky`) and the Teams page
head (`.ct-page-head.ws-sticky`) are `position:sticky` on the opaque `--bg`; the
list scrolls under them.
Chromium insets a sticky box by its scroller's padding, so they pin at
`top: -var(--ws-pad-top)` (flush with the scrollport; nothing shows above
them) and keep an 8px inner top. Their 1px bottom edge is always there,
transparent until content has scrolled under the block (`.is-stuck`), so the
block never changes height; the Souls grid does the same with a top edge
(`.is-scrolled`). `trackStickyTop` also writes the pinned block's height to
`--ws-sticky-h`, the `scroll-margin-top` of the capability rows and the
Teams page's controls, so a focused row never lands under it. This
holds at every width: soul-inspector's narrow `@container(max-width:700px)`
block restacks only `.souls-body.inspecting` (the side inspector under the
list, scrolling together); without it the view keeps the layout above.

Why the containment matters: an absolutely positioned element with no
positioned ancestor (the shell's one `.sr-only` and the views' `workspace-sr-only` / `loading-sr` words) escapes a scroller's
clip and stretches the document; wheel chaining, `scrollIntoView` and End then
scroll the whole app, headers included. The sr-only utilities are anchored
(`top:0; left:0`) and the shell's `body` is positioned and clipped, so the
document never has anything to scroll (`workspace-sticky.test.mjs`; the
browser behaviour is verified live over CDP).

All awaited reads and mutations carry latest-intent ownership (request serial +
workspace generation) checked on success and rejection, mutation-verified in
`workspace-v2-view.test.mjs`. Fixtures are kernel captures
(`test/fixtures/workspace-v2/f2`, with provenance).

## Keybindings (shell-level)

The keymap, its per-platform defaults, the terminal policy, the F6 regions and
the keyboard audit are documented in `../docs/desktop-keyboard.md`; this
section is the module map.

- **⌘F / Alt+F** reveals the sidebar and focuses the instance roster (its current row; on an empty roster, the
    foot's New agent); **⌘N /
  Ctrl+Shift+N** opens Workspace's soul chooser, never automatically spawning
  an instance. Visible hints and tooltips follow the effective bindings
  (including explicit unbinds). Existing user overrides are retained.

- **keybindings.mjs** — the keymap engine: action registry
  (`registerAction`/`setActiveContexts`; a registration may carry a
  `defaultChord` that folds into the effective keymap like a
  `DEFAULT_KEYMAP` entry — override wins, explicit unbind kills it),
  `DEFAULT_KEYMAP` (one entry per action: a chord, or `{ mac, other }`
  when the platforms differ; `defaultBinding(id, isMac)`), one such keymap
  per chord family (`DEFAULT_KEYMAPS`: Alt, the default and
  `DEFAULT_KEYMAP`; Ctrl+Alt; and Ctrl+Shift, which moves the Linux/Windows key
  of seven of Ctrl+Alt's `CHORDS_READ` rows; `setChordFamily` binds one, from
  `chord-family.mjs`, and every reader of a default follows at once), user overrides
  persisted under `localStorage["oats-desktop-keymap"]`, chord
  parse/format/match, and dispatch (`matchEvent`/`handleKeydown`).
  `getBinding(id, isMac)` is override → platform default (in the active
  family) → registration default; pass the platform wherever a chord is shown.
  When two actions match one keydown, one bound there by the user wins over one
  holding it by default (a stored rebind keeps firing after a family's default
  takes its key), and within each a specific context wins over global. A view's
  own keys follow the same first rule (`view-keys.mjs` `resolveViewKey`, the
  spawn dialog's section keys among them). The engine
  skips already-consumed (`defaultPrevented`) events, and unmodified/
  shift-only chords never fire while an editable field (input, textarea,
  select, contenteditable) has focus. Two defaults give way to the focused
  control, a user's own binding of the same keys still firing: Alt+↑ / ↓ to a
  select, a datalist input or a date picker (`opensOnAltArrow`), and on macOS ⌥
  with an arrow, ⇧ or not, to a field of text, a terminal's textarea aside
  (`movesCaretOnOption`: its word and paragraph moves). Terminal
  policy (plain Ctrl+letter and the F-keys are the program's; the Alt
  family's keys are taken on purpose, and the program still gets each from
  Esc, then the key):
  inside `.xterm`, on macOS only ⌘-resolved chords fire, plus Ctrl+Tab for
  tabs.next/prev, the leader's ⌃X (or ⌃\ bound back) and ⌥ with an arrow for
  the moves between tabs, groups and workspaces (`MAC_ARROW_MOVES`; each by
  action id and shape, `macStructuralChord`); on Linux/Windows only
  `TERMINAL_ALLOWLIST` action ids may
  fire (a default xterm sends nothing for, or a byte the program still gets
  from a plainer key, or one of the Alt family's, or a named exception: the leader's
  Ctrl+X, whose 0x18 the leader pressed twice gives the program, `focus.leaveTerminal`
  and the Alt+Shift arrows; `test/terminal-xterm-bytes.test.mjs` pins each) —
  every other plain Ctrl+letter, F6 and every Alt key no chord holds belong to the attached program, and
  AltGr is never Alt (`chordFromEvent`), and
  `focus.leaveTerminal` (Mod+Shift+F6) is the way out. Outside a terminal on
  Linux/Windows the leader's Ctrl+X is a text field's Cut (`leaderLeftToField`). `keymapConflicts`
  lists clashes that involve a stored rebind; the shell marks the settings
  cog and its **Keyboard shortcuts…** item (`markShortcutClashes`: a `--danger` dot and an `aria-description`)
  and the editor names them. The chords shared with the
  TUI (`CHORDS_READ`, read from `packages/client/keymap.mjs` CHORDS) all
  fire from a focused terminal: `app.palette` (⌘K / Alt+K) and
  `app.quickOpenSouls` (⌘P / Alt+P) among them, while plain Ctrl+K
  and Ctrl+P stay the program's (readline's kill-line, shell history).
  The previous / next instance, the previous / next workspace and the leader's
  `z` are chords of their own (`roster.openPrevious`, `roster.openNext`,
  `workspace.previous`, `workspace.next`, `terminal.focusMode`, shell.mjs
  `runAsLeaderKey`), which run the leader's dispatch (leader-dispatch.mjs
  `previous`, `next`, `workspace-previous`, `workspace-next`, `zoom`); the
  editor groups' are `split.focusNextGroup` / `split.focusPrevGroup`, the
  leader's Tab / Shift+Tab (shell.mjs `focusGroup`). The instance steps have no
  leader key: the leader's ↑ ↓ are `workspace-previous` / `workspace-next`, the list of
  workspaces' `step` (their labels are leader-keys.mjs `LEADER_LABELS`, which
  also names `previous` / `next` for the chords). All read their origin when
  the key is pressed (`leaderOrigin`): the target (`leaderTargetId`), and for
  the instance steps the instance an open still in flight is opening
  (`openingInstanceId`, from `openTerminalTabFlow`'s `terminalOpening`), so
  presses faster than an open each move.
  The leader's wait is announced (`leader-hint.mjs` `announce`, for a screen
  reader) and shows the help sheet (`showHelp`; slice 4, D15) unless it is
  turned off; `?` pins it until Esc. Its line says why a key could not act.
  `keymapTakes(e)` tells a view's own key handler that the keymap binds this
  keydown (matchEvent's answer, nothing run); the roster tree, the overview
  canvas, the Souls grid and a row's actions button give way to it on their
  arrows. On macOS a chord holding ⌥ with ⌘ or ⌃ names its letter or digit by
  `KeyboardEvent.code`, as the layout labels it (`readKeyboardLayout`, called
  by the shell at startup and on window focus; `setKeyboardLayoutMap` for
  tests), since ⌥ changes `key`; a character AltGr typed is never aliased.
- **context-menu-release.mjs** — `whenRightButtonReleased(event, run)`: a row's context menu (the
  workspace row's, an instance row's) opens once the right-click that asked for it is released, in the
  task after the release (whose popover light dismiss would close a menu opened on the press, as Linux and
  macOS fire `contextmenu`); a cancelled press opens nothing; a key's (no button down) opens at once.
  Tests: `test/instance-actions.test.mjs`, `test/workspace-open-in-window.test.mjs`.
- **sidebar-foot.mjs** — the sidebar's foot (slice 1 of the Desktop UI rework): `createSidebarFoot(doc, { nouns,
  onNeedYou })` paints **N need you** (`paint(count)`, hidden at 0) and **New agent**'s words, and the words for
  the empty roster (`emptyRosterText`), all from the nouns given (`DESKTOP_NOUNS`). The shell marks the foot's ? on a
  clash (`markShortcutClashes`). Tests: `test/sidebar-slice1.test.mjs`, `test/shell-design.test.mjs`.
- **automations-failure.mjs** — the pinned Automations row's failure mark: `failedRuns` over the list answers
  (`POST /api/automations { kind, action: "list" }`, schedules and triggers), a run failed when a schedule's
  `lastRun.outcome` is `launch-failed` or `invalid` (`FAILED_OUTCOMES`; `unknown`, no last run and every trigger
  mark nothing); `createAutomationsFailure` reads both lists for the workspace on screen with the roster's poll, at
  most once a minute (`AUTOMATIONS_FAILURE_TTL`), a latest-intent token per read (a switch clears the mark at once;
  an answer or a failure for another workspace, or overtaken, changes nothing; a failed read keeps the verdict).
  Tests: `test/sidebar-slice1.test.mjs`.
- **focus-regions.mjs** — F6 / Shift+F6 (`focus.nextRegion`/`prevRegion`,
  outside a terminal; `focus.leaveTerminal` from inside one): workspaces →
  views (`#nav`, under the list) → roster → main → instance panel, hidden regions skipped, each region's
  current item focused, never `<body>`. The head's control (Add local workspace…) counts as workspaces. The
  foot (its bar: N need you, New agent, ?) is no region: Tab reaches it,
  F6 from it goes on to main, Shift+F6 back to the roster. An empty roster's stop is the foot's New
  instance (after a failed read's Retry), and Shift+F6 from that stop goes back as from the roster. F6 and
  the tab switches are no-ops
  under an open modal.
- **surface-return.mjs** — "back to where you were" after a flow that moved
  the main surface (Quick Open's spawn dialog): the same tab or stage and
  control, unless the operator moved on.
- **focus-place.mjs** — where the keyboard was in a workspace, so a switch back puts it there (a tab's
  content or control, a roster row, anything else with its F6 region), each with a `captureFocusReturn`
  handle. The list of workspaces, the palette, dialogs, menus and listboxes are transit surfaces, never a
  place: the shell keeps the last focus outside them per workspace (a `focusin` tracker), so a pick from
  the list remembers what was focused before. See "Workspace-local tab memory".
- **overlay-picker.mjs** — the shared overlay + fuzzy machinery behind the
  command palette and Quick Open: one input over a listbox
  (arrows/Enter/Esc, aria option pattern) and the stale-load generation guard.
  Both filter with the house subsequence scorer, the shared home's
  `packages/client/subsequence-score.mjs` `subsequenceScore` (`null` = no
  match — prefix bonuses make real scores negative). Rows may carry a tree shape:
  consecutive rows sharing `group.key` sit in one named `role=group`, `depth`
  indents, `connectors` draws the sidebar's lines (its `treeGuides` builder and
  `.ctx-guide` rules, on the sidebar's dot column), `state` the sidebar's state
  dot, `under` and `sibling` are visually hidden text read with the option, and a
  `context` row is `aria-disabled` and never active. An optional `cycleKey(e)`
  lets the picker's own chord move the active row while open (wrapping,
  skipping context rows); with it, `toggle()` on an open picker cycles.
- **palette.mjs** — the command palette's rows (`paletteRows`), in groups (slice 4,
  `PALETTE_ORDER`): Needs you (claimed rows, newest claim first), the recent agents,
  Sections (the shell's `sections`), the commands, and New agent ("New agent: <soul>",
  `quickOpenRows`, `onSoul`); each row carries its `kind`. `>` keeps the commands, `+`
  the souls. The recent agents are the sidebar's
  tree ordered by last focus (#1383), from the sidebar's own builders
  (`filterInstanceTree` with the fuzzy matcher as its predicate, then
  `rosterSections` with `{ lastFocus }`, whose groups are `rosterGroups` over
  `recencyOrder`), every instance listed, each row carrying the sidebar row's
  `connectors` (`treeConnectors`) and `state`, then at most
  `PALETTE_COMMAND_CAP` commands. The shell hands it one panel snapshot,
  `{ instances, deployments, recent }`: with several deployments each one is filtered
  and clustered on its own, its sections by latest focus, then the panel's order, and a group's key and label
  carry its deployment, so no relation or query context crosses deployments. The shell passes
  `cycleKey` from `pickerCycleDirection(e, "app.palette")` (keybindings.mjs), so
  ⌘K cycles while open (Shift: up) and follows a rebind. The palette opens on
  its first selectable row, the top of the list (#1391).
- **settings-terminal.mjs** — Settings → Terminal: the font size stepper
  (− / typed value / +, 9–28, "Reset to default (N)", the default of the
  terminals' face, updated on every typography change), mounted by
  `connections.mjs` through its `sections` option after Connections and disposed
  on close. It reads and writes the same store as ⌘= / ⌘- / ⌘0 and the palette
  (`theme.mjs`: `setTerminalFontSize`, `resetTerminalFontSize`,
  `onTerminalTypographyChange`), so every open terminal and the control follow
  each other. A typed size applies on Enter or on leaving the field, never per
  keystroke. The font family is the Appearance sheet's Choose… field (the palette's **Terminal: set font family…** opens it).
- **quick-open.mjs** — the souls' rows (`quickOpenRows`), shared by the palette's
  New agent group and the New agent form's soul field (slice 5). Quick Open's own
  overlay folded into the palette (slice 4): ⌘P / Alt+P opens the palette on its
  souls (`+`). A pick goes to `openNewAgent` (shell.mjs), today the spawn dialog
  through `views/spawn.mjs` `preselectSpawn()`: the
  spawn dialog scoped to that soul, as its page's New agent opens it, with focus
  in the Opening instruction. Opening never spawns; Spawn stays explicit. Attached-only, refused
  and CLI pending/unavailable souls open their soul page instead, which says
  why. Dismissing the dialog returns to where the operator was
  (`surface-return.mjs`). No second spawn form exists.
- **status-line.mjs** — the status line (slice 4): one line at the bottom of the window with
  the three keys for where the focus is (`statusKeys` in the shell) and one-line messages
  (`say`). It asks nothing: its y/n questions for Stop, Start and Restart were taken out of the
  slice after five review rounds, and those keep their dialogs.
- **sheet.mjs** — centred sheets over the scrim with a 150 ms ease (none with reduced
  motion), focus trapped and returned: `openSheet` (Appearance), and the `sheet` /
  `sheet-backdrop` classes the Retire dialog and the shortcuts editor take.
  **retire-ghosts.mjs** keeps a retired row's dim ✕ ghost for 10 s.
- **keybindings-editor.mjs** — the shortcuts editor sheet (`Mod+,`), with the leader's
  help-sheet setting at its top. Its first section is
  **Most useful** (`usefulRows`): a read-only table (a row header per action, then its keys) of
  the shared keymap's most used rows, read from the live keymap at every render (platform,
  chord family, rebinds), the leader's key standing in for an action with no chord, hidden
  while a search shows the list; its rules are the module's own `usefulCSS`, injected with
  the editor, its keycaps and words the list's. Then
  a search (focused on open; `shortcutMatches` filters by label, group name
  or the chord as shown, case- and separator-insensitive), actions grouped
  by context under sticky headings, the chord as keycaps (`chordKeys`; the
  button's name carries it as one string), a quiet "terminal" marker from
  the engine's `terminalAllows` (global and tabs actions only: a terminal
  lives in the tab layer), a "changed" marker and Reset when the binding
  differs from the default, click-to-record (Esc cancels, Backspace
  unbinds), conflict warnings via `findConflict`, reset-all. On Linux/Windows,
  given the page's chord family, its top holds the family choice ("Shortcuts
  anywhere": Alt, Ctrl+Alt or Ctrl+Shift), which writes keys.json through main and
  switches the keymap at once, with main's note when the file was not taken.
  What has no sidebar button is taught by its rows: the palette is the Leader group's first
  key (the leader then K or Space) and a Global row with its chord; Connections (no sidebar
  control) is the Global row **Settings: Connections…** (`app.connections`, the palette's name), unbound by default
  and bound there; the stage rows say where they land (**View: Workspace › Machines**, **View: Workspace
  overview**, **View: Automations**).
- **chord-family.mjs** — the chord family in the page: asks main
  (`../chord-family.mjs`) as the window starts, follows its pushes, writes the
  Shortcuts page's choice through it, checks what main sends again, and applies
  each state to the engine (`setChordFamily`). The shell awaits `start()` before
  it installs its keydown listener, so no key is read in the wrong family. It
  never imports `keys-file.mjs`, which names a Node builtin.

## Shared Components — existing-data frame 10 parity

`notifications.mjs` replaces the roster-prepended `ctx.notify` notices with one
renderer-only, viewport-bounded scroll stack. Messages are literal text, not inferred severity/activity,
links or action callbacks. There are at most three cards; capacity eviction skips
the focused card. `notify` returns a handle `{dismiss(), shown}` (or `false`).
Options add owned `buttons` (each an explicit, epoch-checked activation whose
failure says "<label> did not complete. Try again."), a `detail` behind a
Details disclosure, and `sticky` cards (background-spawn failures) that are
exempt from the cap, report the operator's × through `onDismiss`, and collapse
by `group` into one expandable "N … failed" entry when there are more than
three. **No expiry timer**: dismissal is explicit, while a workspace
visit or disposal revokes the old scope. Background arrival never focuses or
mints navigation intent. Actual notification entry does; dismissal recovery uses
the shell's projection guard, a surviving next control or a visible same-scope
return target. The polite live region is independent of roster repaints and
continues to work without a roster. Primary foreground/background pairs and
existing popover shadows adapt to White/Solarized/Dark without raw colors.
The roster row's context menu (`instance-actions.mjs`; #1559: the row draws no ⋯
trigger for it) draws what `instanceActs` (`packages/client/instance-acts.mjs`)
decides: the acts in its order under the menu's own labels and icons, the shell's
items (Open in split, Open pull request…) in front unless the row is `blocked` or
`limited`, an act with a reason disabled with it, and for a `blocked` row no menu:
asked for, it says the reason. It decides nothing itself. It opens on the row's
`contextmenu` (a right-click, Shift+F10 or the ContextMenu key), as the workspace
row's does (`workspace-switcher.mjs`): the page's own menu, never the native one; at
the event's point when it falls on the row (a right-click's pointer; Chromium gives
Shift+F10 and the Menu key the focused row's centre), else under the row's start,
kept 8px inside the window; on its first enabled act. Both menus open a right-click's
once the button is released (`context-menu-release.mjs`: Linux and macOS fire
`contextmenu` on the press, and the release, outside the popover just opened, would
light-dismiss it). A right-click sends no click, so it never activates the row. Esc and Tab close it with the focus back on the row;
the row's own keys (`roster-keys.mjs`) and its ARIA are untouched, with no
`aria-haspopup` (the workspace row has none either). While the menu is held (an act
of it in flight, a stale roster, a `blocked` row) the row's `contextmenu` opens
nothing and says why through the leader hint line (`sayInHint`, `role="status"`), the
focus staying on the row; the row keeps its own marking, the menu adds none. The instance panel's
lifecycle footer and the overview popover draw from the same answer (#855): a
footer control (Restart…, Start…, Stop…, Retire…) is shown exactly when its act
is listed and enabled exactly when the act is, so a stopped row and one whose
state is unknown offer Stop, `inspect` has none there, and a `blocked` row shows
no control but one muted line with the blocked reason instead (nothing more for
a row gone from its server, whose Work note already says it); the popover's
**Start…**/**Go to instance** is the `start` act on a stopped row and `openAct` on any
other, with the view's own conditions (a current roster, a well-formed address,
the shell's handler) on top. A held home (#802, #1247; `heldHome`) reads its state
on the row in words ("Setting up worktree…", "Spawn didn't finish", "Retiring…",
"Retire failed", "Retire didn't finish"), its muted hint when it has one (a retiring
row has none), and its reason (`speaker-line.mjs` `heldLine`: a failed retire's
recorded message after "OATS says:", filtered) as the row's description; the hover
card and the popover say `heldStatus`. A `secondary` act (Retire on a retiring row)
stays in the menu, enabled, but is never its default: no `autofocus`, the menu opens
on itself (`tabIndex -1`) and the arrows reach it; the footer draws no control for it
and its note says the limited reason (as it does for a reason carrying the kernel's
words). The rows every surface draws pass `shell.mjs` `shownRows` first: this
window's own retires in flight (`retire-in-flight.mjs`) read as retiring until a
roster read after their answer that observed their deployment live
([desktop-lifecycle-confirmations.md](../docs/desktop-lifecycle-confirmations.md#quarantined-and-spawning-rows)).
The menu reports here, never with
`alert`: an action that fails says "<Action> didn't finish for <name>." with its
error in Details. While one of its actions runs, the menu is held and says
"Waiting for <action> to finish" (`pendingActionReason` gives the same reason to the
leader's and the sidebar's X R S D); when it settles, a stale roster still holds it. Stop
and Retire never run from the menu: they open the plan-backed confirmation
(`lifecycle-dialog.mjs`, phases in
[desktop-lifecycle-confirmations.md](../docs/desktop-lifecycle-confirmations.md#ui-states)).
The one exception to "a `blocked` row has no menu" is the Desktop's own (#1131): a
row whose reason is `missing` (its host no longer lists it) keeps its context menu and offers
**Forget…** alone when the shell passes `openForget`. Forget… never runs from the menu
either: it opens `forget-dialog.mjs`, the lifecycle dialog's classes and focus handling
with no plan, which sends `{server, instance}` once to `/api/server-forget`
(`../server/server-forget.mjs`), which answers the outcome and starts the roster read after the command; the row leaves the roster when that read lands
([desktop-deployment-model.md](../docs/desktop-deployment-model.md#remote-rows)).

An instance's colour (#1421 §2) has no row menu item: the palette's **Instance: name and
colour…** and `instance.edit` (CHORDS `edit-instance`, Alt+R / ⌥⌘R) open
`instance-color-dialog.mjs` for the leader's target (`leaderTargetId`; the palette captures
it when it opens). The dialog is Forget's pattern: it asks `/api/instance-color` with
`check: true` on open (nothing runs), then sends one `{instance, home, color}` at a time,
the latest press winning (`../server/instance-color.mjs`, which runs `oats instance color`,
routed with `--server` for a remote row, and reads the roster again after a change). The dots
draw the colour from the row (`instance-dot.mjs` over `instanceColor`): `data-instance-color`
on a running or stopped dot, which shell.css maps to `--instance-<colour>` (theme.css: the
soul's `-fg` in the built-in themes); the contrast inventory (`contrast-inventory.mjs`
GRAPHIC_PAIRS) holds every colour on every fill, and "This computer" moves these tokens until
they hold (`host-theme.mjs`), leaving the soul pairs as calibrated.

`choice-popup.mjs` owns the existing provider/model popup behavior. Model search
is local to reported advisory IDs/labels; **Defaults**, **Reported suggestions**
and **Custom** are control/data groups, not model-quality claims. Arbitrary
model IDs and comma-separated preferences remain free text. Filtering does not
probe the model catalog, change the model or launch. Late owned model-catalog fills refresh
choices without rebuilding the filter, losing its query or taking foreign focus.
Keyboard/retained-option focus reveals only within the popup below its sticky
search header, never by scrolling the outer dialog/page. Notification arrival
can reveal existing focused content within its stack, but never changes focus.
Provider/host changes revoke the old scope; render epochs and DOM membership
prevent removed/reopened options from acting. Popup Enter is consumed before the
outer launch handler; spaces, caret keys and IME remain text in the filter.
Resolved defaults and the disabled force-native K6 control retain their meaning.

Workspace/model/soul chooser notices distinguish **nothing reported** from
**no matching rows**. Workspace empty notices are outside the selectable
listbox, never fake workspaces; removed options cannot select through a new
empty state. Registry transaction behavior and source/context soul grouping are
unchanged. Already-conforming badges, workspace/context menus and native titles
with live keymap chords are retained—not replaced by a new tooltip manager or
keyboard interceptor. No Stop/Retire, K6, editor/detach/PR or OS notification
surface is introduced. Tests are inert DOM/CSSOM/ownership/contrast checks, not
native rendered acceptance.

## Instance panel (context panel) and focus mode

The shell owns one right-side region outside all editor groups, the **instance
panel** (`#context-panel`, `context-panel.mjs`). A selected terminal shows its
instance in three tabs (v4.1 board 1): **Instance** (header with the soul mark,
"instance of <soul>" linking to the Soul tab, an "older build" chip only when
the kernel reports `soul.status`/`modules[].status` other than `current`, and
"Running · 42m"; then Work, Session, Messaging & Teams, Lineage and the
lifecycle footer), **Soul** and **Developer** (Git and GitHub). Work is one card:
the work mode's tile and one sentence saying what the mode means for this
instance (`WORK_MODES` in `context-panel.mjs`: an icon and a sentence builder per
mode). The roster row's own facts (repo, branch, parent) sit in it in the mono
face, and an unreported fact gets the generic words ("its soul's repository",
"its parent's tree"), never an invented name. An unknown mode hides the section.
The sentence is rebuilt only when its words change. A row on a server takes
its repository from its own `repo` (the host path's last segment, display only),
never from `repoName`, which is the server's label there. When a server row has
no `work` key (this computer's OATS predates the relay) or a null one (the host
doesn't report it), one muted line in the Work section's place says so and names
which OATS to update; a local row never shows it. A row the kernel built from its
saved route alone has every fact null, which says nothing about either OATS, so
it says why first: gone from the server (`unaddressableSentence`, with the
forget command), or the server wasn't reached. Ahead/behind counts are the
Developer tab's alone. Under the sentence, a closed **Paths** disclosure holds
Folder and Home, each with an icon Copy. It is built once and never rebuilt, so a
repaint keeps its open state and a focused Copy. It closes when the selection
changes. The panel's visibility check treats a closed `<details>`'s content as
hidden, so focus inside it falls back. Folder is
`<home>/work`, joined from the roster row's `home` with the home's own separator:
the kernel gives every instance that folder, a real one in worktree and
directory mode and a link to the shared tree in checkout, attached and workspace
mode, where a muted "shared" tag follows the path (the link's target is not
resolved; that would need a server read). Home is the instance home, where its
own files live; without a reported `home` string there is no Paths. Messaging &
Teams' header is the label plus a tools slot the injected Teams section fills
with its icon Refresh (`createTeamsPanel(…, { compact: true, refreshHost })`).
Under it come two parts with sentence-case sub-labels. **Messaging ID** is the
identity address (`identityAddress`, else the served identity) on one mono line
with an icon Copy. **Teams** is followed by the compact card's lead line, shown
once a teams document has been read, and the card. Empty groups
and file/brain tabs do not inherit another terminal's context. Roster refresh
matches the exact workspace/terminal identity and never selects or focuses a
panel; a missing or ambiguous observation makes session state unknown.

The **Session** card keeps its harness, model and session-age lines together. Under them, a muted
DOM-text note uses the needs-input coverage reader (`needsInputReportingGap`): "This agent's Claude questions
and permission requests don't show as needs input: its oats.core (oats.framework `<version>`) is older than
2.4.0. Upgrade or respawn it to report them." The version is inserted as text. The note clears on the
roster refresh after an upgrade or respawn moves the home's recorded version to a supporting release. It uses `--muted` on
`--surface`, held to WCAG AA by the contrast inventory and computed theme tests. Under it, the row's runtime error,
said with who made it (`runtimeErrorLine`), unless the lifecycle row's note already says it.

**Needs input** (slice 1 of the Desktop UI rework, which removed the roster's hover card): a section at the top of the
Instance page, shown while the row has a claim through the sidebar's own gate (`setContext`'s `waiting`, the shell's
`waitingClaim` with the held-stale rule): the needs-input mark and "<reason> · waiting <N> (since <clock>)",
computed at each paint (the roster's poll), then the agent's message as text. A withheld note shows the reason
alone (`context-panel-waiting.test.mjs`).

Workspace projects its actual selected-soul inspector into that same region.
Workspace still owns its requests and lifetime. Collapse or covering the
stage with a terminal preserves the inspector's DOM, local disclosure state and
in-flight content; a late response cannot reclaim foreground visibility. True stage unmount
or workspace reset ends that selection. Standalone view hosts keep the inline
inspector fallback.

There is no status bar under the editor groups. After the tabs the editor tab bar
holds only the two split buttons (spec F). `panel.toggle` (default **⌘I /
Ctrl+Shift+I**, terminal-allowlisted; plain Ctrl+I, the Tab byte, stays with the
program in a Linux/Windows terminal), the palette's "Instance panel: show /
hide", Show instance panel and the panel's own close button open and close the
instance panel.

**A closed sidebar or panel leaves nothing behind** (Spec B): no strip, rail
or edge. The sidebar hidden (`#app.sidebar-hidden`) or in focus mode is
`display:none`; the panel closed is `hidden`. Two shell-owned buttons reopen
them, at the two ends of the main area's top bar: `#show-sidebar` (first child
of `#main`, `sidebar.toggle`, shown only while the sidebar is away) and
`#show-panel` (last child, `panel.toggle`, shown only while the panel is closed
and has something to show; it carries the Developer page's change dot and
says so in its name). They are absolutely placed over the bar; every top bar
reserves their room with `--main-lead-inset` / `--main-trail-inset` (40px each
while its control is shown, set on `#main` by `:has()`), always outside any
horizontal scrollport, so scrolled content never passes under a control:
`#tabbar-row` pads around its scrolling `#tabbar`; a split group strip at the
main area's top corners is itself the scroller, so it takes them as a margin
and its `.group-cell` paints the bar behind it; the stage headers (`.hier-bar`,
`.workspace-header`, `.auto-header`, `.page-bar`) do not scroll sideways
themselves and add them to their own padding (a scroller inside one, like
`.auto-tabs`, sits within it). A new top bar in `#main` must do the same.

Instance details open or closed is ONE per-machine preference
(`localStorage` `oats-desktop-instance-panel-open`, absent = closed): opening a
terminal never opens the panel; only `panel.toggle`, Show instance panel and the
panel's close button change it. The panel's selected page stays per workspace,
in memory. A stage's panel content (the Workspace soul inspector) keeps its own
per-workspace, in-memory state, open by default: selecting a soul inspects it,
its X closes it. **Focus mode** (`app.focusMode`: palette and a rebindable
action, no default chord) hides the sidebar and the panel without closing tabs
or changing split weights; leaving it restores both as they were. Show sidebar
and (with content) Show instance panel stay shown in focus mode, and each
leaves it.

Focus never lands on `<body>`. Hiding the sidebar with focus in it moves focus
to Show sidebar (and showing it, from there, to the sidebar's toggle); closing
the panel with focus in it moves focus to Show instance panel; opening the panel
by that control moves focus to its selected tab (a stage's content: its first
control); a chord pressed in a terminal opens or closes either without taking
focus from it. Entering focus mode is the one deliberate exception: it means
"work in the content", so focus that was in the sidebar it hides moves to the
active tab's trigger, not to Show sidebar, else to a stable visible control (`stableFocusTarget` in
`shell.mjs`: the foot's ?, Show sidebar, Show instance panel); a
focus-mode change made after focus was already lost (the palette removes its
input before running the command) lands there too. `sidebar.focusFilter` and
`sidebar.toggle` leave focus mode. Native terminal input and per-window lifecycle policies are unchanged.

### Git inspection (slice 2a)

**Desktop Git reads = K1 route only.** The legacy background collector's Git
commands and unused aggregate parsers are retired. They ran against every
instance tree without helper controls and substituted healthy zero aggregates
on failure. Local roster `git` is now explicitly null, overriding recorded
metadata; remote legacy data stays inert. No renderer interprets it as clean.

`instance-git.mjs` is an injected, on-demand read controller. The context-panel
host projects effective visibility and the committed terminal's exact identity;
first-visible and explicit Refresh read, ordinary roster polls do not. Hiding,
covering, switching workspace/instance or disposing revokes old controls and
pending success **and** rejection. Separate observation/file tickets protect
retries and same-file reselection; global workspace generations protect A→B→A.
Focus recovery stays inside the host's projection guard, not a new terminal-open
intent. No terminal keyboard or viewer lifecycle changes.

The panel displays the actual observed worktree/branch/revision/time, recorded
branch drift, and **separate upstream/default-branch comparisons**. Missing refs
and counts remain unknown, not 0/0. File kinds/counts and rename paths are the
reported ones; there are no invented per-file line totals. A selected file's
patch is read-only, text-only and against the captured OID (or empty for an
untracked file), never the moving HEAD. Binary and 256 KiB truncation are explicit;
a 4,000-line presentation limit is separately labeled. Failed refreshes retain an
explicitly stale observation with actions disabled, never a healthy empty tree.

`POST /api/instance-git?ws=<id>` accepts only the qualified
`{instance,agent,agentsRoot,server?}` selector plus action and opaque diff
id/revisions. The server, not the renderer, supplies `--home` and `--dir` from
its exact roster/scope. The accepted installed CLI must meet the 0.24.7 floor and
return `instanceGitApi:1`; diff responses must carry the hardened `readOnly`
contract and captured-OID `against`. Unsupported/missing commands are unavailable,
not a direct-Git fallback. Remote inspection is explicitly unavailable until a
negotiated remote command exists. `E_STALE_OBSERVATION` clears the patch and
re-observes; the user selects again, never an automatically substituted file.

The single POST route is loopback Host/Origin guarded and workspace-pinned in
the privileged proxy. Reads use fixed argv, `shell:false`, 15-second / 4 MiB execution bounds,
in-flight coalescing and a four-flight cap, with no persistent server cache.
Only validated DTO fields and sanitized diagnostics cross the boundary; paths
in a patch/observation do not authorize arbitrary file opening. See
[the Desktop Git boundary](../docs/desktop-git-inspection.md) for request and
refusal details. DOM/CSSOM and computed-token AA tests do not establish native
or rendered acceptance.

## Editor groups (splits) and the hideable sidebar (shell-level)

The roster draws relationship guides for related work only (superseding in part slice 1's D26), with the command
palette's builder and rules: its rows nest by an 18px step and say their relations in words (`relationSpan`). Compact outer gutters reserve more width for instance
names without changing relationship grouping, disclosure controls, 56px row
height or the selected row's 8px content inset.

Splits follow VS Code editor-group semantics (`split-layout.mjs` is the
pure model; `split-dom.mjs` the DOM projection). A split creates PERSISTENT
GROUPS on the tab layer: each group owns an ordered tab list and its own
active tab, and renders its own tab strip (`.group-tabbar`, a per-group
tablist holding the group's REAL tab elements) above its pane inside a
`.group-cell` flex cell of `#tabhost`. The first split seeds group 1 with
ALL of the layer's current terminal tabs (its selected tab stays visible) and
creates a new empty group that takes focus with no globally active tab — the next terminal opened from
any path (sidebar roster, palette, quick-open) lands in the FOCUSED group
(`openTabInFocusedGroup`); group focus follows the active tab (`focusTab`).
Switching tabs within a group, or focusing another group, never dismantles
the split — the layout belongs to the tab layer, not to any tab. The tab keys
(`tabs.next`/`prev`, their second chords, `tabs.goto1..9`) and a strip's own
arrows walk one strip (`walkedTabs`): while the split renders, the active (or
focused) tab's group, an empty focused group walking nothing; else the flat
strip. They never cross into another group. The former
pending-slot indirection (split → absorb next terminal) is gone: an empty
focused group with a placeholder plays that role directly. While the split
is visible the top `#tabstrip` row is hidden (each group has its own strip;
keeping the old row would render an empty phantom chrome bar) and the split
controls (`#tab-actions`) ride the focused group's strip. Activating a
non-terminal tab covers the split without destroying group state. Closing a tab
**does not close its panel**: empty panels retain their identities and proportions.
Each has an independent focusable placeholder; selecting it clears `activeTab`,
so tab/terminal commands cannot accidentally target the previous instance.
Reopening an instance enters that selected panel; selecting an already-open
instance into it moves the existing tab without another attachment. Closing an
active tab selects its adjacent group-mate, or leaves that panel empty.

**Close split** (`split.close`: its chord and the palette; there is no button)
explicitly joins back to the flat strip. **Split: return to terminal
groups** in the palette restores a covered layout, including an all-empty one.
There is no new default shortcut. Clickable controls mirror the chords with no duplicated
logic: the split-right/down buttons and Show sidebar (shown while the sidebar is
hidden) all dispatch the
registered actions through `runAction(id)` — context-gated exactly like
chord dispatch — and their enablement dry-runs the same model transition
via `split-controls.mjs` `splitControlsState`. One chrome per tab means the
tab-a11y roving/aria/close semantics hold PER GROUP (each group strip is a
tablist with a single selected, tabbable trigger; arrows walk the group).

Tab sizing (spec F, superseding "strips scroll instead of compressing"): tabs fit
their strip like VS Code's "shrink" mode. Each `.tab` is `flex: 1 1 0px` with
`max-width: fit-content` (its natural width, which the trigger caps so a tab
never passes `--tab-max`, 280px) and `min-width: --tab-min` (168px, measured
live in bold: the status dot, the name's start and an ellipsis ("oats-…") and its
last eight characters, next to the close button).
Below the floor the strip scrolls. Names share long prefixes (the soul), so a
terminal tab truncates in the middle: `tabNameTailStart()` (`tab-a11y.mjs`)
picks a tail (the last eight characters, or what follows the soul when that is
shorter) that never shrinks, and the head before it ellipsizes, so shrunk tabs
read "oats-…palette" / "oats-…awn-flow" rather than seven "oats-…". A remote
tab's " · host" follows the tail in its own span and gives way first. The branch detail grows from zero into what the name
leaves, so it ellipsizes and disappears first; the full name stays in the
trigger's `title` and accessible name. **The selected tab is always visible**:
`revealActiveTabs()` in `shell.mjs` scrolls each strip (`#tabbar` and every
`.group-tabbar`) to its active tab after every activation and tab close, and a
`ResizeObserver` on the current strips (re-observed by `renderSplit`) does the
same when one resizes (window, sidebar, panel, split). Only the strip's
`scrollLeft` moves (`revealInStrip` in `reveal-in-scrollport.mjs`), never
`scrollIntoView`, which would also scroll the workbench's own ancestors; keyboard
focus on a tab's trigger or close uses the same helper. In a group strip the split
buttons scroll with the tabs, so they are pinned to its end (`position: sticky`)
and the strip declares their width as `scroll-padding-right`, which
`revealInStrip` honours: a revealed tab never sits under them.
**Each tab ends with its number** (`.tab-num`, aria-hidden, empty from
`createTabChrome`): the N that go to tab reaches in its strip, 1–8 and 9 for
the last of nine or more (`tab-numbers.mjs` `tabNumber`, `numberTabStrips`).
`observeTabStrips()` numbers every current strip and points a
`MutationObserver` (`tabNumberObserver`) at each, so a tab added, closed,
hidden by context or moved between groups renumbers them; the observer ignores
its own `.tab-num` writes. Harnesses that run `observeTabStrips` by its text give
it `numberTabStrips` and `tabNumberObserver: null`. The number is aria-hidden, so
the trigger's tooltip names the key it stands for, the live binding of
`tabs.goto<N>` ("name (Alt+3)", "name (⌥⌘3)" on macOS); the shell renumbers on
`onKeymapChange` too, so a rebind or a chord family switch shows there. The
tooltip has three writers, each setting only its part through `tab-a11y.mjs`
`setTabTitle`: the name (`createTabChrome`), the key (`numberTabStrips`) and the
needs-input note (`syncTabNeedsInput`); harnesses that run `syncTabNeedsInput` by
its text give it `setTabTitle`, and `syncWaitingRow` (`waiting-row.mjs`, the row it
draws over the tab's terminal). The number never crowds out
the name: the trigger wraps and shows only its first line, and the label's flex
basis is `--tab-name-min` (102px, what the floor budgets the name), so line
breaking sees the name at its minimum and the number wraps out of sight, whole,
only when even that does not fit (`shell.css`, `.tab-trigger`).

### Workspace-local tab memory

`workspace-tab-memory.mjs` retains each workspace's group membership/order,
orientation, proportions, selected tabs and focused group for the current app
session. Workspace switches hide all outgoing panes synchronously and park their
DOM nodes before restoring the destination layout; existing terminal attachments
are retained, not recreated. Empty layouts and their focused destinations are
remembered too; only a workspace with neither open tabs nor a retained layout
falls back to the stage. Restart restoration of tab layouts is not implemented yet.
Memory is keyed by the view id; `rehome(map)` moves a deployment id's memory to its view
(see "Workspace views"). A workspace another window takes over is forgotten here
(`forget(workspace)`, from shell.mjs `closeWorkspaceTabs`), its tabs closed first.

The memory also holds the workspace's focus place (`focus-place.mjs`), taken by
`restoreWorkspaceTabs` as the workspace is left, before its panes hide, so `rehome`
and `forget` cover it. `focusArrival` applies the arriving one's place at the end of
`restoreWorkspaceTabs` under one `tabOpenIntents` ticket: a tab's content through
`selectTab(…, { focusContent: true })` (never `term.focus()`; a terminal that can't take
its input focus now, attaching or ended, has its tab trigger focused meanwhile), a tab
control through its handle, else the region's landing (`focusRegion`), never `<body>`.
A landing on the page (or the views, the panel, the foot), and the no-place rule (keep a
focus still shown, else main), wait for `watchPage`: the
mounted views repaint in their own workspace listeners, which run after the shell's, so
it lands in a microtask, and again at each repaint of `#stagehost` while it has not
landed or the focus fell to `<body>`, until the operator acts or the ticket goes. A page
handle is accepted only in its own region and off the transit surfaces (its ancestor
fallback can reach any control of the window). The list of workspaces repaints through
the shell's `applyFocus` (workspace-switcher.mjs `applyFocus`), so keeping its focused
row is no new intent for the sidebar's focusin.
A roster place waits for the roster: `applyRosterPlace` runs at the end of every roster
paint of rows, of the empty copy or of a failed read (not a pending one), and applies it
once, unless the ticket is gone or the operator pressed a key, or clicked and moved the
focus (`watchOperator`), since the switch. `views/common.mjs` `landsFocusPlace(ws)` says
whether a landing places at all: `switchWorkspace(…, { focusPlace: false })` (handOff,
followView, a step made from the list of workspaces) and a take-over that brought a
layout (`restoreHandedLayout` owns the focus) do not. Nothing is applied under a modal or
the palette. Tests: `test/workspace-switch-focus-shell.test.mjs`.

All artifact tabs (terminal, brain, file) are workspace-scoped, including their
activation boundary and deduplication keys. A retained brain tab has a pinned
`ctx.workspace` and per-mount lifecycle instead of changing identity with the
workspace bus. Standalone brain views without that context still follow the bus.
Open requests share a latest-selection token plus the workspace generation, so a
slow earlier open cannot steal selection or land after an A → B → A switch.

### A terminal tab is one incarnation; a retired instance's tabs close (#1237)

A terminal tab's key (`terminalKey`: workspace + home) names a home, not an
instance: a home can be retired and spawned again under the same name. So the tab
also records, once at open, the row's `createdAt` (the kernel's incarnation of a
home), its deployment tag and its server (`terminalOrigin` in `retired-tabs.mjs`,
`tab.origin`). Every place that ties a tab to a row goes through `tabShowsRow`
(the key, and not `otherIncarnation`): the active-row highlight, Needs input,
the panel rebinding, the row reveal, and the dedup of `addTab`, the open flow
(`pendingTerms` holds `[key, incarnation]`) and the followed spawn. A null
`createdAt` on either side matches by key alone. `wsActiveTerminal` still
remembers a key; it is a restoration fallback only.

`retiredTabs(tabs, panel)` is the one rule that decides a tab's instance is
retired, and its header lists the panel facts that prove each case: (R) the same
home with another incarnation, (G) a remote row `missingRemotely`, (A) absent
from a successful, current read of the tab's recorded deployment (its
`deployments[]` entry reachable, not stale, of the tab's kind, and no kept
`error` or `serverUnreached` row for it). (R) and (G) count only from a current
read of the row's own deployment: a held row keeps its last-read facts. Anything
it cannot prove keeps the tab.
`refreshContextRoster` runs it (`closeRetiredTabs`) on an owned answer of the
shown workspace, on the connection it was read on, only when that answer is not
a failed, kept or pending read, and before the panel binding and the paint. A
hidden workspace's tabs are judged when its own answer lands.

The close is `closeTab(id, focused, { explicit: false, background: true })`: the
viewer's own teardown (`confirmClose`), with a `watch()` ticket instead of
`begin()`, so it cancels no pending open, and passive, so a covered tab layer stays
covered. It never takes over a user's close already in flight. Focus moves to the
group's successor's trigger only when it is in the closed tab at its removal (a
batch's earlier close may have handed it there), or was when the answer landed
and has not gone elsewhere during the teardown. An open whose own
`/api/panel` read is older than the last judged answer (`panelReads` numbers
every read in dispatch order) checks that answer before it makes its tab, so no
tab opens for an incarnation the roster already shows retired. The PTY ending is
never evidence (Stop ends it too); the viewer's `detach-on-destroy on`
(`tmux-target.mjs`) makes sure a dying source ends the tab instead of moving it
to another session. Tests: `retired-tabs.test.mjs` (the rule, over the server's
own panels) and `retired-tabs-shell.test.mjs` (the shipped shell close).

## A launch's `--instance` (`launch-focus.mjs`)

Main reads `--instance <name>` beside `--dir` with one reader for both launch paths (`single-instance.mjs`
`launchInstance`, the kernel's `--name` rule from `packages/client/instance-name.mjs` `validInstanceName`). It
pushes the `--dir` deployment's window `window:focus-instance` with `{ deployment, name }`, or `{ invalid: true }`,
which never carries the value. The push is one-way: no renderer→main call answers it. The preload keeps the latest
ask until the shell subscribes (`onLaunchFocus`). `createLaunchFocus` holds the one pending request:
- Each observed roster read of this computer's rows (`refreshContextRoster`, after the paint) is checked with
  `launchFocusMatch`, which counts only that deployment's local rows (a spawning home included, a remote row never).
- One match observed `running === true` is selected through `showInRoster` then opened by `openTerminalTab`,
  the row click's path. The opener uses the painted roster (`followed`) and `focusContent: false` for new and
  retained tabs, including delayed readiness: keyboard focus stays on the row. Held, unavailable or stale rows
  select only. A match observed not running selects only and consumes the request, even if it later starts.
  Nothing starts or receives input. Two or more say so. None waits
  `LAUNCH_FOCUS_PENDING_MS`, then says "No instance <name> in this workspace" from a timer, with no read of its own.
- A person's choice drops the request: the selection-ownership ticket (`tabOpenIntents.watch()`, taken at the first
  roster read so the window's own binding does not count), or input or a pointer press (`watchOperator`).
- A later ask replaces the request, including the validity of an open still awaiting. The shell checks selection
  ownership across selection and open, on both success and rejection. Rows already shown answer at once.

## Supporting read-only files

**File: open read-only…** in the command palette, or **Mod+O**, opens a browser
file chooser and adds a normal workspace-scoped tab. Markdown renders as a reader;
code/plaintext renders with semantic syntax colors. There is no editor or save
operation. The action is rebindable; Ctrl+O inside a Linux/Windows terminal still
belongs to its program (the action is not terminal-allowlisted).

`open-file.mjs` captures selection/workspace ownership before the chooser opens.
Each selection gets a distinct identity, even for identical basenames. Once a tab
exists, its immutable read belongs to the tab's lifetime, so selecting elsewhere
does not strand it in Loading. Browser-selected files are limited to 2 MiB and
reject NUL-bearing content. They have no authoritative absolute path; local links
and embedded resources are disabled rather than guessed. Existing guarded
`ctx.openFile(path)` links keep their path-backed behavior. Files stay alongside
terminal/brain tabs without becoming a primary navigation surface.

There is no agent-facing CLI command for opening a file. The read route's guards and the
renderer's sanitizing are in [the file viewer](../docs/desktop-file-viewer.md).

## Terminal focus discipline (shell-level)

`selectTab(id, { focusContent, intent })` is the explicit-selection boundary.
Async opens reuse their dispatch ticket; pointer, keyboard and close actions
supersede older foreground work. `activateTab()` only projects/restores state.
`selection-ownership.mjs` binds focus permission to the selected tab, request and
workspace generation. A delayed terminal attachment can initialize a retained
terminal without stealing focus from a newer selection, sidebar or workspace.
Only a current explicit content-focus request focuses its input when ready;
workspace restoration and close fallback remain focus-neutral.

`terminal.focusActive` is rebindable and editor-visible, with no default chord.
Palette/Quick Open share one modal lifetime per document. Cancellation restores
the logical opener even after roster repaint; activation hands focus to the
chosen destination without a transient return to the old control.

## Developing without the shell

`harness.html` supplies a stub `ctx` and tab chrome for ALL views — including
the Markdown tab (it prompts for a file path;
`ctx.openFile` routes into the markdown view); `harness-server.mjs`
serves it and proxies `/api/*` to a backend server you started by hand, over
its socket (same-origin, so GETs and guarded POSTs both work exactly as in the
real shell). The backend's credential stays in the harness: it makes a token of
its own at start and prints the page's URL with it, and every `/api/` request
must carry that token (`x-oats-harness-token`, which `harness.html` sends from
the URL's `#t=`), else 401. The token file must not be inside a directory the
harness serves (the renderer, `node_modules`, `packages/client`):

```sh
dir=$(mktemp -d) && chmod 700 "$dir"
( umask 077; node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))' > "$dir/token" )
node packages/desktop/server/oats-web.mjs start --socket "$dir/s" --token-file "$dir/token" --dir <workspace>
node packages/desktop/renderer/harness-server.mjs --port 4899 --api-socket "$dir/s" --token-file "$dir/token"
# open the URL it prints: http://127.0.0.1:4899/harness.html#t=<its token>
```

## Home (`views/home.mjs`, the Desktop UI rework's slices 2 and 2b)

The landing surface: `showStage("home")` at start and when a window is bound again (`onWindowState`), and the
nav's fallback when no stage shows (`setNavActive(stage?.name || "home")`). A stage view on the `mount(el, ctx)`
contract (its mount returns its disposer), so a later slice can put it in a tab. It reads nothing the shell
doesn't read already:

- **The roster** through `ctx.homeRoster()` (the rows the sidebar shows, held retires included, its deployments, the
  read's `phase`: loading, failed, unavailable (the kernel could not observe the deployment: the sidebar's note, never
  an empty workspace, so no first run and no zero) or ready, the held-stale rule, this machine's name and Retry) and
  `ctx.subscribeHomeRoster(fn)`, run after each paint of the roster (and after a first read fails with nothing
  shown). The board is the shared `packages/client/home-board.mjs` (`homeBoard`: Needs you by the one claim gate,
  newest claim first, and the summary line's counts, each row counted once as running, needing you, stopped or
  unknown; `homeAgents`, pinned first where the roster shows pins (`ctx.homeRoster().pins`), then newest spawn first;
  `startedBy`), so the TUI can draw the same Home. Nothing reorders the roster. Slice 2b (Pepe, 2026-11-20) dropped
  slice 2's Running group: Home lists only what needs you (`NEEDS_YOU_SHOWN`, 8, then "Show all N", which expands in
  place and focuses the first row it showed), then one summary line ("24 agents · 21 running · 3 need you · 0
  stopped"), then the tiles.
- **Counts**: Souls from `GET /api/agents` (read by the Workspace page's rules: a `catalog.reason` is a failure; an
  empty list while the catalog is still reading, or with no catalog observed yet, is pending, "Counting…", and is
  asked again every 3 s on a timer Home owns (cleared on a switch and on disposal) for as long as it stays pending,
  never taken as zero (not on the roster's paints: an unchanged roster read paints nothing); a remote view's answer has
  no catalog of its own, and its list is the count), Capabilities from `POST /api/workspace-sync {action:"read"}`, Teams from
  `POST /api/workspace-teams {action:"list"}` (only where the CLI has a team model: "Counting…" while its probe is
  pending, no count where it has none; `onCliChange` settles it), Machines from the roster's deployments (a workspace
  with no deployment list is this machine's: one), Automations from `POST /api/automations {kind, action:"list"}`
  for schedules and triggers (only where `automationsSupported`; its red mark is the sidebar row's, slice 1's
  reader, through `ctx.automationsFailed()` and `ctx.subscribeAutomationsFailed`). Each count is its own read, owned
  by the workspace generation it was asked in (a late answer or failure for a workspace since left is dropped), and
  never rejects: a refused or malformed answer is that count's "Couldn't count", the others stand. The tiles are one
  row of buttons (`TILES`), each named with its count ("Souls, 26"); their heights are `HOME_LAYOUT`'s, the budget the
  DOM test sums so the tiles stay in the first viewport at 1280×800 with 8 needs-you rows. No Graph tile: the Graph is
  frozen, and Machines keeps List | Map. The stage stays mounted across a
  workspace switch, so Home follows `onWorkspaceChange` itself: its board again, and the new workspace's counts.
- **Identity**: an agent row is known by `instanceId` (its home, its host), never its bare name, so a repaint keeps
  focus and activation on the same agent when names repeat across roots and hosts.
- **Opening**: an agent row runs `ctx.openAgent(row)`, the shell's `openRosterInstance`, which activates the
  roster's own row (showing it first if a collapsed parent or the closed Background section hides it), so its gates
  are the row's (held, unknown or unaddressable, stopped on a stale roster: refused) and can't drift. A tile runs
  `ctx.openWorkspaceTab(tab, options)` (`openWorkspaceTabFocused`: `openWorkspaceSouls`, then the focus on the
  page's tab control where the Home button it left is gone, so the first Esc is heard); the Workspace page's unclaimed Esc (no field, dialog, menu or
  list took it) goes back to Home (`stageHost`'s keydown in shell.mjs), and Home focuses the tile that opened it.
  The Automations tile opens its page (`ctx.openPage`, `showStageFocused`).
  Agents opens Home › Agents in place (the board's dot grammar: a row with a claim wears the needs-input mark and says
  "needs you" first); its Esc, or its "‹ Home" back control (the capability page's quiet `.page-back` look, named
  "Back to Home"), returns to the board.
- **First run** (the roster is ready and empty): two lines, three keys (`ctx.chordText`: New agent's and the
  palette's bound keys; Home's is its palette command until it has a key), then the tiles.
- **Where you are** (slice 2b; supersedes slice 2's "Home's row stands for the Workspace page"): `PINNED` is Home,
  Workspace and Automations, and `pinnedRowFor(name)` is a stage's own row, so every way onto the Workspace page (a
  tile, the palette, ⌘2 / Ctrl+2, a soul's or capability's page, a soul's files) marks Workspace, and Home's row marks
  Home and Home › Agents only. The Workspace page's head is a trail, "Home › Workspace › <tab>", above its tab bar
  (`views/spawn.mjs` `nav.workspace-title`, the tab its `h1`, `syncWorkspaceTitle`; Home's head type), hidden while a
  soul's, capability's or team's page shows its bar. A Workspace page's bar (`capability-page.mjs` `pageBar`, crumbs
  starting "Workspace") draws the same trail one level deeper, Home first, each part above the page a link: Home,
  Workspace and a tab dispatch `workspace-navigate` (`workspaceNavigate`), which the Workspace page handles
  (`navigateTrail`: Home through `ctx.openPage`; else its pages closed, then the tab, focus on its control); the part
  just above the page is its Back. A capability's open skill extends the trail (a MutationObserver on the skill
  view's `hidden`). Esc goes up one level (a page to its list, the page to Home: shell.mjs `stageHost`).
- **Amendment 1** (Pepe, 2026-11-20; Joan's yes): the column is centred (`.home-inner` 880px, `margin:0 auto`); a
  Running group under the tiles (`RUNNING_SHOWN`, 5, in the roster's order, "Show all N running" / "Show fewer");
  the Souls grid's cards in the information-role type scale (name 17 / 700, what it does 13 muted, the meta line 12
  muted).

