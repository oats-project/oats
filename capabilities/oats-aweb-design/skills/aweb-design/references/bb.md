# bb: the look of aweb, moldable UI, and what a plugin can do

bb's look is the look of both aweb products. The aweb app is drawn with bb's tokens, sizes and components. The bb extension wears whatever theme the user has. Another look (Omarchy, herdr, your own) is a theme, not a design of ours.

Read from bb's source (github.com/get-bb/bb, commit b0ddaad7, 25 Nov 2026). Nothing was run. The complete extraction, with tokens and every file and line, is `full/bb-principles.md`.

## Moldable UI

bb's own words (apps/web/src/blog/posts/an-agentic-ide-that-builds-itself.md):
- "No Two Installs Look Alike."
- "Software that you use needs to get the fundamentals right and be malleable enough to adapt to your use case."
- "Clone it, run it, and then ask it for something it does not do yet."
- Much of what ships with bb is built on the same extension system a user gets.

## Themes

- A bb theme is one CSS file that overrides the app's CSS custom properties (plugins/theme-preview/skills/bb-theme-authoring/SKILL.md).
- It lives in `<theme dir>/<name>/theme.css`. `bb theme dir` prints the directory. Nothing needs a restart.
- Two blocks: light values in `:root, .light`, dark values in `.dark`. Every line is a `--token: value;`.
- So: never write a literal colour, radius or font. Use the token, and every theme just works.

## bb in twenty rules

1. Colour is almost absent. Every neutral is mixed from two anchors, `--canvas`
   and `--ink`; only status carries hue. Never a literal colour.
   (STATED, `AGENTS.md:42`; THEME:502-503; B2, B12)
2. There is no coloured primary button. The filled button is ink on canvas, and
   most buttons are `ghost` or `outline`, size `sm`.
   (STATED, `plugins/theme-preview/skills/bb-theme-authoring/SKILL.md:75-76`; OBSERVED, B4.1)
3. Surfaces are flat. Card, popover and page share one value; elevation is a
   1px border plus a small hard shadow, never a tint. (STATED, THEME:506-508)
4. Type is small and dense: body 13px (`text-sm` = 0.8125rem), secondary
   `text-xs` (the most used size), chrome 10px (`text-2xs`). Page titles are
   `text-sm font-semibold`. Nothing large. (STATED, THEME:112, 124-130; OBSERVED, B2.2)
5. Hierarchy comes from three grey tiers of text (foreground, muted, subtle),
   not from size or weight. Weights are normal, medium, semibold only.
   (THEME:527-530; OBSERVED, B2.2)
6. Radii: 8px for cards and dialogs, 6px for controls and rows, 4px for menu
   items and chips, 12px for the composer, the palette and drawers.
   (THEME:93-96, 658; B2.4)
7. Rows are 28px, small controls 28px, icons 14 or 16px. On a narrow touch
   screen, and only there, they grow to 40 / 36 / 20px.
   (THEME:659-660; `UI/coarse-pointer-sizing.ts:7-36`)
8. Hover is instant. Lists have no hover transition; controls fade out in 150ms
   and in at 0ms. Shell motion is 200-220ms. "Working" is a soft shimmer on an
   icon or label, not a busy spinner. (`UI/motion.ts:1-4`; THEME:307-311, 1037; B2.9)
9. Text is sentence case, verb first, no closing full stop on labels. U+2026
   marks work in progress, placeholders, and items that open another step.
   (OBSERVED, B6)
10. Words are scarce. Controls are icon-only with an accessible name and a
    design-system tooltip; a native `title` on a button is a lint error.
    (STATED, `scripts/oxlint-plugin.mjs:149, 167`)
11. Every action is meant to be a command: one registry, listed in the quick
    palette (Mod+Shift+P) and in Settings > Keyboard, rebindable by the user.
    A plugin command goes through the same path. (STATED, `AGENTS.md:26, 30`; B7)
12. Shortcuts are shown quietly: a small pill appears only after Cmd/Ctrl is
    held 700ms; otherwise the binding sits in the tooltip as "Label (keys)".
    Never hardcode a key label. (`CMD/AppCommandProvider.tsx:82`; STATED, `SKILL/frontend-renderer-slots.md:272-275`)
13. A palette row is a title, nothing else, with an optional group name and the
    keys at the right. Root groups are Threads, Actions, Settings, Plugins.
    (`apps/app/src/lib/command-palette/palette-action.ts:3-8`; `CMD/CommandPaletteBody.tsx:298-335`)
14. State on a row is one 16px glyph in the trailing slot, chosen by a fixed
    order of precedence. Needs-input is a grey question mark; unread is a 5px
    grey dot; only failure is red. No count chips, no coloured pills.
    (`packages/plugin-sdk/src/internal/thread-status.ts:100-119`; `apps/app/src/components/thread/ThreadStatusGlyph.tsx:131-196`)
15. Selected is `bg-state-active`, hover is `bg-state-hover` or
    `bg-sidebar-accent`, focus is a 1-2px ring in `--ring` (grey, never the
    browser's blue). (`UI/context-selection.ts:1`; APPCSS:137-146)
16. Lists, not tables: rows inside one bordered card split by hairlines, or
    flush hairline rows. bb's own `Table` component has no user in the app.
    (OBSERVED, B4.6)
17. Confirmation is a `Dialog`: `max-w-lg`, `p-6`, title `text-base
    font-semibold`, Cancel (outline) left of the action, destructive in red.
    Under 768px the same dialog is a bottom drawer.
    (`UI/dialog.tsx:276, 300, 336, 385`; `UI/confirm-delete-dialog.tsx:39-60`)
18. Empty, loading and error are small: one line of muted text, skeleton bars
    shown after 200ms, an error line with an outline "Retry".
    (`UI/empty-state.tsx:21-39`; `UI/delayed-loading.tsx:3`; `UI/resource/row.tsx:415`; STATED, `docs/ui-code-splitting.md:34-39`)
19. "Compact" is one rule: `(max-width: 767px)`. The sidebar becomes a drawer,
    dialogs and menus become bottom drawers, hover actions become a long press.
    (`UI/hooks/use-compact-viewport.tsx:10`; `apps/app/src/components/ui/sidebar.tsx:30-32`)
20. A plugin page lives inside the host's chrome: bb draws the title bar and the
    side panel, the plugin draws a full-bleed body with bb's token classes and
    bb's vendored components. (STATED, `SKILL/frontend-core-slots.md:112-120, 131-138`; `SKILL/frontend-hooks-and-ui.md:244-247, 324-330`)

---

## What gives a foreign screen away

The ten likeliest ways a foreign screen betrays itself inside bb.

1. A coloured button or a coloured "primary". bb's filled button is grey ink,
   and at most one appears on any surface that was read. (B4.1)
2. Any hue for state: blue "running", green "done" chips, amber "needs you"
   badges, a bold unread title. bb uses one grey glyph, a shimmer for work, a
   5px dot for unread, red only for failure. (B4.7, B8)
3. A tinted or shadowed card on the page. bb's cards are the page colour with
   a 1px border; lists live inside one card split by hairlines. (B2.1, B4.6)
4. Big type. A 20-24px page heading, 14-16px body, bold labels, or upper-case
   section headers. bb's title is 13px semibold; labels are `text-xs` grey. (B2.2)
5. Tall rows and wide padding. bb's rows are 28px (34px in a tool list) and its
   controls 28px; a 40-48px row reads as another product. (B2.3)
6. A grid table with column headers, or a dashboard of tiles. (B4.6, B4.8)
7. Hover transitions on rows, slide-in panels with spring easing, pulsing
   badges, a spinner where bb shimmers. (B2.9)
8. Title Case, exclamation marks, "Successfully ...", "Oops", "Please ...",
   three dots where bb uses U+2026, or a full stop on a button. (B6)
9. Keys drawn its own way: a monospace keycap, `Cmd+K` spelled out on a Mac,
   keys always visible beside every item, or a fixed key that ignores the
   user's rebinding. bb shows `[SHIFT] [CMD] P` in a sans pill, only on hold,
   or in the palette. (B7.3)
10. Its own chrome: a second title bar repeating the page name, its own side
    panel, its own toaster, its own icon set, its own modal that does not turn
    into a bottom drawer at 390, a literal grey that does not follow the
    user's palette, or a blue browser focus ring. (B3.2, B4.4, B11, B12)

---

## How command-first bb really is (the reader's assessment)

- The foundation is real and stated: one registry, one palette, rebinding,
  per-platform defaults, context rules, the same commands in the CLI
  (`AGENTS.md:26`), plugin commands on the same path (`AGENTS.md:30`).
- The surface is still pointer-led. 524 buttons against 88 commands; the
  thread row's four commands ship without keys; the sidebar list has no arrow
  navigation; menus never show keys; key hints are hidden until a modifier is
  held; several gestures have no command at all (B7.8).
- bb's own plugins show the gap: Tasks registers one command (`New task`) and
  handles `s`, `p`, digits and Escape with local key handlers that the user
  cannot see in the palette or rebind.
- For "everything by commands and keys" a new screen must therefore do more
  than bb does, with bb's own means: register every act as a command with a
  self-identifying title, give page-scoped bare keys, show keys with
  `experimental_useCommandShortcut`, and build its own search-then-arrows list.

## What a plugin can and can't do (tried on bb 0.50.1)

Can:
- Mount bb's whole new-thread composer on its own page, with one control above it.
- Add tabs to bb's side panel, and rows and sections to bb's own thread Info.
- Register commands in bb's palette, with default keys the user can change.
- Re-point itself to another workspace without a restart.

Can't:
- Call a bb command from plugin code.
- Add or change palette commands after start-up. A palette row is its title only.
- Remove bb's panel button from a plugin page.
- Fire a plugin key while a terminal tab has focus.
- Use bb's pending-interaction card and keep the composer: the card removes it.
- Hold an aweb agent in bb's own automations: they are time-only.

bb gives no UI kit to plugins. Where bb has no component to mount, copy bb's look by hand with bb's theme tokens.
