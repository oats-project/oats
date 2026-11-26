# Omarchy: the command-first way

We don't take Omarchy's look. The aweb app looks like bb, and a theme can change that.
We take how Omarchy is driven: everything by a key or a typed command. bb has the base for it (one command registry, a palette) but is still pointer-led, and Octolens has keys only in its onboarding. This file is what they don't give.

Read from Omarchy as installed, and from herdr's config, 26 Nov 2026. Nothing was run. The complete extraction, look included, is `full/omarchy-principles.md`.

STATED = the authors wrote it down. OBSERVED = read from consistent code or config.

## Omarchy in twelve rules

Command-first rules (1-10), then feedback and text (11-12).

1. **One key opens one menu that holds everything** (apps and every system act). OBSERVED.
   `BIND/utilities.lua:1` `o.bind("SUPER + SPACE", "Omarchy menu", { menu = "root" })`; 425 rows under 10 roots (MENU:24-33).
2. **Every list filters as you type; the filter line is the only header.** OBSERVED, 5 list surfaces.
   `SH/plugins/menu/Menu.qml:1422` placeholder is `"Go") + "[ellipsis]"`; the shared filter line (`FilterInput` / `Util.editsFilter`) is also used by the clipboard, emojis, app grid and image picker, and there is a searchable dropdown control.
3. **Every act is a named command; keys and menu rows only call commands.** STATED + OBSERVED.
   `SKILL-OM/SKILL.md:93` "Omarchy ships a single `omarchy` CLI that dispatches to all `omarchy-*` binaries via `omarchy <group> <action>`"; 562 commands in /usr/bin, 559 with a one-line summary.
4. **One key shows all keys, and choosing a row runs it.** STATED + OBSERVED.
   `OM/default/i18n/en/cli.json:134` "Super + K for cheatsheet.\nSuper + Space for Omarchy Menu."; `/usr/bin/omarchy-menu-keybindings:823` `dispatch_binding "$dispatcher" "$arg"`.
5. **Modifier layers mean something, and one key belongs to one object.** OBSERVED, 157 Super bindings.
   Super = the desktop; +Shift = launch an app, or move/reverse; +Ctrl = a system panel or menu; +Alt = the variant. See table (C).
6. **Letters are mnemonics, numbers are places, arrows are directions.** STATED (letters, numbers) + OBSERVED.
   `BIND/utilities.lua:122` "The letters above name a panel; the numbers count them."
7. **The same small key set works inside every surface.** OBSERVED, 7 surfaces.
   Up/Down, Enter, Esc, Backspace/Left = back, Delete = remove, Tab = next section; `SH/Ui/PanelKeyCatcher.qml:56-98`.
8. **The pointer is optional and never fights the keyboard: one cursor highlight for both.** STATED.
   `SH/plugins/dev-gallery/GalleryPanel.qml:419` "No initial highlight, then one highlight on screen once the keyboard or mouse enters."; `OM/default/hypr/looknfeel.lua:121` `hide_on_key_press = true`.
9. **Focus is never taken from you and never lost.** STATED.
   `SH/plugins/notifications/Service.qml:272` "Notifications never take the keyboard on their own: a card grabbing focus".
10. **Small losses just happen; large ones ask once, in place, by key (Esc cancels, Enter confirms).** OBSERVED, 3 places.
    `SH/plugins/clipboard/Clipboard.qml:370` `if (event.modifiers & Qt.ShiftModifier) root.requestClearHistory()`; `SH/Ui/ConfirmDialog.qml:27-36`.
11. **Feedback is two or three words, then it leaves; nothing on screen jumps.** OBSERVED.
    "Animations disabled", "Screenshot saved" (`cli.json:40,85`); `SH/plugins/osd/Osd.qml:20` `property int duration: 1200`.
12. **Very little text; state is a dot, a glyph, a colour or an opacity.** OBSERVED.
    Menu labels: median 1 word, 98% are 3 words or fewer (en/menu.json, 444 strings); `SH/plugins/bar/widgets/Workspaces.qml:274` `opacity: occupied || shown ? 1 : 0.5`.

---

## Fourteen rules for a command-first app

Each rule is tied to the evidence above. "Palette" = the app's one list of commands.

1. **Give every act one named command in one registry** (id, label, group, key, one-line summary). No act exists only as a button. Name it general word first; let the group carry the verb and the row be a noun of 1 or 2 words.
   Evidence: 2.7 (562 commands, `# omarchy:summary=`); 2.1 (verb parent, noun leaf).
2. **One key opens the palette of everything: commands, agents, places.** It opens at once, with no animation, takes the keyboard, and closes with Esc.
   Evidence: `BIND/utilities.lua:1`; `SH/plugins/README.md:125-126` (~30ms); `omarchy-shell.lua:12` (no_anim); herdr "Go to" (3.3).
3. **Type-to-filter on every list, with no step to focus a search box.** The filter line is the title ("Agents[ellipsis]"). Search everything below the current level and show each hit's path in small dim text.
   Evidence: 2.2 (`FilterInput.qml:9`, `Menu.qml:1422`, `:729`, `:1574`); `GalleryPanel.qml:1626`.
4. **One key lists every key, as a filterable list whose rows run.** Generate it from the registry; order it by importance; chord in a fixed-width column, then 2 to 4 words. In the app, `?`.
   Evidence: 2.5 (`omarchy-menu-keybindings:478-481`, `:564-567`, `:823`); `SKILL-APP:112`.
5. **Show the key beside the act wherever there is room, in a short notation, leaving out the modifier every key shares.** Omarchy's shell does not do this inside panels; Joan added it himself.
   Evidence: `~/.local/bin/app-keybinding-hints:2-4`; `DeedButton.qml:16`; herdr footers (3.3); the gap in 2.5.
6. **Give each modifier layer one meaning and keep it.** Plain = go or act; Shift = the reverse, or move the thing, or one level up; Alt = the variant or the finer step; Ctrl = the bigger step or the system surface. Put all acts on one object on one key.
   Evidence: table (C); comma family (`BIND/utilities.lua:24-29`); herdr c/r/k/p/n with Shift (3.2).
7. **Letters are mnemonics; digits jump to the nth place in the order drawn; arrows are directions.** Add j/k/h/l only where typing is not filtering.
   Evidence: `BIND/utilities.lua:122-125`; `BIND/tiling.lua:22-28`; herdr `switch_tab` (`config.toml:64`); `PanelKeyCatcher.qml:71-85` vs 2.3.
8. **One cursor.** Keyboard cursor, hover and focus draw the same single highlight; a resting pointer never moves it; nothing needs hover to be found; the pointer may vanish while typing.
   Evidence: `GalleryPanel.qml:419`; TPL:40,47-49; `PointerMoveGate.qml:3-5`; `looknfeel.lua:121`.
9. **Focus is always visible and lands somewhere sensible.** A list opens with its first selectable row selected; dim rows are skipped; the cursor wraps; after a list changes, the cursor is re-settled; closing gives focus back; nothing that arrives by itself takes focus.
   Evidence: `Menu.qml:611-632` (nextSelectable, settleCursor); `KeyboardPanel.qml:77-83` (focusTarget); `Service.qml:272-277`.
10. **The same keys in every surface:** Up/Down, PageUp/PageDown, Home/End, Enter = act, Right = go in, Left or Backspace on an empty filter = go back, Esc = clear the filter then close, Tab = next section, Space = toggle, Delete = remove, modifier + Enter = the variant.
    Evidence: 2.3; `PanelKeyCatcher.qml:56-98`; `Clipboard.qml:362-394`.
11. **A destructive act is started by a key on the selected row and confirmed where it is,** by Enter, cancelled by Esc; never by a second target far away. One item: no question. Many items, or no way back: one question, one line, the button named by the verb, red only there.
    Evidence: 2.8 (`Clipboard.qml:369-371`; `ConfirmDialog.qml:27-36,97-106`; `Menu.qml:1327-1332`, `:1376`).
12. **A toggle is one row naming the act available now; a choice marks the current option with a check; an unavailable row stays, dim.** No switch to aim at.
    Evidence: MENU:60-61, 17-21; `Menu.qml:1499`.
13. **Feedback is a glyph and 2 to 4 words, auto-dismissed; a failure says what and what next; a repeat replaces the last one; nothing changes width or position; persistent state is a small mark that exists only while the state does.** Assume toasts are off (Joan's are).
    Evidence: 2.11; section 5; 4.7 "nothing jumps"; `notifications-off:2`.
14. **A row of many agents is a dot, then the task's name, then where it runs, dimmer;** the name is set once, 3 to 5 words, and elides on the right; rows are dense with fixed height; a cut list shows part of the next row; order can switch to "who needs me"; the dot alone carries the state (idle, working, blocked, done until looked at).
    Evidence: 3.4 (`config.toml:106-114`; `machine-setup/SKILL.md:290`; `AGENTS.md:14`; herdr `row_gap`, `agent_panel_sort`); `Menu.qml:131-133`.

---

## The key scheme

## Omarchy (from BIND; 206 literal `o.bind` lines, plus 3 numbered loops that add 44 more)

157 of the 206 carry Super. Of the other 49, 38 are hardware keys (XF86 media keys, Print, the lid switch) and 11 are old conventions (Alt+Tab, Ctrl+Alt+Delete, Alt+Space for dictation, Ctrl+Space pass-through, and so on). The meanings below are OBSERVED from the descriptions; only the letters/numbers rule is STATED (`utilities.lua:122`). Counts are per layer.

| Layer | Count | Meaning | Examples (file:line) |
|---|---|---|---|
| Super | 37 | The window and the desktop itself: close, float, full screen, focus, the menu, the key list | W close (tiling:1), F full screen (tiling:8), T float (tiling:7), arrows focus (tiling:17-20), Space menu (utilities:1), K keys (utilities:10), Esc system menu (utilities:8), Return terminal (applications:2) |
| Super + Shift | 32 | With a letter: launch an app, mostly by its initial (19). With an arrow, a digit or Tab: move the thing, or go the other way | B browser, F files, M music, E email, C calendar, O Obsidian (applications:4-29); arrows swap window (tiling:50-53); Tab previous workspace (tiling:37); digit moves the window there (tiling:26) |
| Super + Ctrl | 31 | A system surface by its initial: a panel, a utility menu, a system toggle | A audio, B bluetooth, D display, N network, P power (utilities:113-119); C capture, T theme, S share, R reminder (utilities:4,17,100,104); V clipboard (clipboard:49); L lock (utilities:143) |
| Super + Alt | 21 | The variant of the Super act, or the smaller step | F full width (tiling:10) beside F full screen; L layout back (tiling:15); Space apps (utilities:2) beside Space menu; Return tmux (applications:12); "a little" resize (tiling:70-71) |
| Super + Shift + Alt | 15 | The variant of the app, or move a bigger thing | B private browser (applications:7), E new email (applications:30), X new post (applications:37); arrows move the workspace to another monitor (tiling:40-43) |
| Super + Ctrl + Alt | 11 | Read a status, or the second panel on a letter | T show time, B show battery, W weather (utilities:108-110); D calendar, E world clock (utilities:116-117); Z reset zoom (utilities:139) |
| Super + Ctrl + Shift | 10 | Move across monitors; the stronger form | arrows move window to monitor (tiling:45-48); R clear reminders (utilities:106) |
| No Super | 49 | Hardware keys and old conventions; Shift / Alt / Ctrl on a hardware key = maximum / precise / other device | Shift+brightness = maximum (media:8); Alt+volume = "precise" (media:23); Alt+Tab (tiling:58) |

Rules that cut across the layers (OBSERVED):

| Rule | Evidence |
|---|---|
| Digits are places. Super+1..0 = workspace; +Shift = move the window there; +Shift+Alt = move it silently; Super+Alt+1..5 = nth window in a group; Super+Ctrl+1..9 = nth bar panel | tiling.lua:23-28, 103-105; utilities.lua:126-132 |
| Arrows are directions, always (no h/j/k/l at this level: Super+J, K, L are other acts) | tiling.lua:5,14,17-20; utilities.lua:10 |
| Tab is "next"; Shift = previous; Ctrl = the one before | tiling.lua:36-38, 58-59, 62-63, 94-95 |
| One object, one key, modifiers are its verbs: comma = notifications (6 acts); K = key lists (3); Space = menu, apps, bar, background, theme (5); Return = terminal, browser, tmux, herdr (4); Backspace = window look toggles (3); Print = capture (4); R = reminders set / show / clear (3) | utilities.lua:24-29; 10-12; 1,2,13,14,16; applications.lua:2,3,12,13; utilities.lua:18-20; 40-46; 104-106 |
| Modifiers scale a step: plain 100, Alt 25 ("a little"), Ctrl 300 ("a lot"); Shift = the other axis | tiling.lua:65-78 |
| Mnemonic letters where one is free; 11 of the 19 app letters are a clear initial (B, F, M, D, O, C, E, Y, P, X, W for Omawrite). The reason for the rest (N editor, G Signal, S Maps, Q calculator, A ChatGPT, T activity, / passwords) is not stated | applications.lua:4-37; utilities.lua:120 |
| Two keys for one act are allowed for a habit (W and Q both close; Return and B both open the browser) | tiling.lua:1-2; applications.lua:3,6 |
| A key that would collide is rebound, and the user is told what it used to do | SKILL-OM/hyprland.md:50-51 |

## herdr (Joan's config; 3.1)

| Layer | Meaning | Examples (config.toml line) |
|---|---|---|
| Prefix (Ctrl+Space), then a letter | The learnable route: a mnemonic for every act | c create tab (61), r rename (62), k kill (63), n / p next / previous (65-66), x close pane (40), z zoom (41), d detach (32), q reload (30), ? all keys (31) |
| Prefix, then Shift + the same letter | The same verb one level up (workspace) | Shift+c, r, k, p, n (73-77); Shift+o rename pane (58) |
| Prefix, then 1..9 | The nth tab | 64 |
| Alt + arrow or digit | Direct, by level: left / right = tab, up / down = workspace, digit = nth tab | 64-66, 76-77 |
| Alt + Shift + arrow | Move the tab instead of going to it | 69-70 |
| Ctrl + Alt + arrow | Focus the pane in that direction | 44-47 |
| Ctrl + Alt + Shift + arrow | Resize the pane instead of going to it | 52-55 |
| Alt + Enter / Alt + Shift + Enter / Alt + Esc | Open a pane one way / the other way / close it | 38-40 |
| Inside an overlay | / filter, j/k or arrows move, Enter open, Esc back (binary fragments, 3.3) | |

Shared by both schemes: one modifier names the level (desktop, tab, pane), the plain key or arrow names the act or direction, Shift turns "go" into "move / change" or reverses it, digits are places, and every key has a one-line name that a single key lists.

---
