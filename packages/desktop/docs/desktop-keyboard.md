# Desktop keyboard: the keymap, regions and reach

The whole Desktop works from the keyboard, with a keymap that is sane on Linux
(Omarchy, GNOME, KDE) and Windows as well as macOS. This page is the reference
for the default chords, the rules that chose them, how focus moves between the
window's regions, and how each interactive element is reached and operated.

Code: `renderer/keybindings.mjs` (the engine, `DEFAULT_KEYMAP`,
`TERMINAL_ALLOWLIST`, `SIDEBAR_KEYS`, `CHORDS_READ`), `packages/client/keymap.mjs`
(the leader, its table, the plain keys and the chords, the TUI's too, and the palette's own keys,
`PALETTE_KEYS`), `packages/client/keys-file.mjs` (keys.json, the chord family both clients
bind; see "The chord families"), `renderer/tab-numbers.mjs` (the tabs' numbers, and the keys their tooltips name), `renderer/leader.mjs` (the
leader's wait), `renderer/leader-keys.mjs` (which rows apply, the Desktop's
labels), `renderer/leader-dispatch.mjs` (what each key does),
`renderer/leader-hint.mjs` (the hint's announcement and its line), `renderer/focus-regions.mjs` (F6),
`renderer/surface-return.mjs` (back to where you were), `renderer/focus-place.mjs` (the focus a workspace switch puts back),
`renderer/instance-recency.mjs` (the palette's last-focus record),
`renderer/shell.mjs` (action registration). Tests: `test/keymap-linux.test.mjs`,
`test/terminal-xterm-bytes.test.mjs` (what xterm sends for each terminal-allowlisted chord, and AltGr),
`test/leader.test.mjs`, `test/leader-dispatch.test.mjs`, `test/keymap-shared.test.mjs`,
`test/sidebar-keys.test.mjs`, the TUI's `packages/tui/test/keymap.test.mjs` (the TUI reads the same table),
`test/keybindings.test.mjs`, `test/focus-regions.test.mjs`,
`test/spawn-dialog-keyboard.test.mjs`, `test/palette-tree.test.mjs` (the palette's tree rows, connectors, cycling, group keys and footer),
`test/palette-recency.test.mjs` (its recency order, first-row opening and focus record), `test/tab-strip-reveal.test.mjs`,
`test/roster-scrollport.test.mjs` (a focused roster row is revealed inside the list),
`test/roster-reveal-row.test.mjs` (an active terminal tab reveals its roster row),
`test/theme-picker.test.mjs` (the theme picker's keys), `test/font-picker.test.mjs` (the font picker's), `test/sidebar-slice1.test.mjs` (the
sidebar's foot, pinned rows and roster rows), `test/shell-design.test.mjs` (Show sidebar,
Show instance panel and the closed sidebar and panel).

## Principles

1. **Super/Meta belongs to the window manager on Linux.** Omarchy (Hyprland),
   GNOME and KDE bind Super+* heavily. The Desktop never binds Super on
   Linux/Windows: `Mod` is ⌘ on macOS and Ctrl everywhere else.
2. **What a program in the terminal keeps.** Plain Ctrl+letter: Ctrl+W
   deletes a word, Ctrl+K kills to the end of the line, Ctrl+\ is SIGQUIT,
   Ctrl+P is shell history, Ctrl+B is the tmux prefix. Function keys: F1 and
   F6 in htop, mc and nano. Ctrl+PgUp/PgDn in vim and weechat. On macOS the
   ⌃digits, which are control bytes (⌃3 ESC, ⌃4–⌃7 FS/GS/RS/US, ⌃8 DEL; ⌃6 is
   vim's alternate file), and every ⌥ key but ⌥ with an arrow, which the
   moves take (principle 3). Such a key may stay bound for focus
   outside a terminal, but it is never terminal-allowlisted, with one named
   exception: the leader's Ctrl+X (the TUI's, as in Emacs), whose 0x18 the
   leader pressed twice gives the program (see "The leader").

   **The Alt family takes keys a program reads, on purpose.** Changed in the
   next release: the rule was that a default chord never takes a key that a
   program inside the terminal reads. For the Alt family, the default on
   Linux and Windows, the product owner overrode it on 2026-10-22, and the
   maintainer set its keys (see "The chord families"). Alt+letter, Alt+digit
   and the Alt arrows are what readline, Emacs, Claude Code and others bind
   (M-b, M-f, M-d, M-digit, Alt+P…). [The collision table](#what-the-alt-family-takes)
   names each key it takes and how the program still gets it: in a terminal,
   Alt+key sends ESC and then the key, so **Esc, then the key** sends the same
   bytes, and a program that reads Meta reads it as Alt+key. Or choose the
   Ctrl+Alt family, which keeps the old rule. Alt keys that no chord holds
   (Alt+B, Alt+D, Alt+., Alt+T…) are still the program's.

   On Linux/Windows a chord fires in a terminal when xterm sends nothing for
   it, when what it sends is a byte the program still gets from a plainer
   key, or when it is one of the Alt family's.
   - **Ctrl+Shift+key** sends nothing: the convention of GNOME Terminal,
     Alacritty, Ghostty and kitty, which Omarchy's terminals follow. So the
     Ctrl+Shift family's seven letter chords fire in a terminal (see "The
     chord families").
   - **Ctrl+Alt+key** sends ESC and then what the key sends with Ctrl alone
     (ESC and the digit, for a digit). The program still gets exactly that
     from Esc, then that key.
   - **Alt+key** (the Alt family) sends ESC and the key, which Esc, then the
     key still sends. An Alt arrow is sent as the Ctrl arrow (`CSI 1;5` and
     its letter: xterm.js does so on Linux and Windows), which Ctrl+arrow
     still sends.
   - xterm also sends nothing for Ctrl+1, Ctrl+2, Ctrl+, and Ctrl+= Ctrl+-
     Ctrl+0.

   The allowlisted defaults that do send something:

   | Chord | xterm sends | The program still gets it from |
   |---|---|---|
   | Ctrl+X (the leader) | 0x18 (CAN) | no plainer key: a named exception. The leader pressed twice sends it, so the shell's Ctrl+X Ctrl+E and nano's exit stay the program's |
   | Alt+K, P, O, Z, W, E, F, R (palette, Quick Open, the list of workspaces, focus mode, close tab, split right, the instance roster, name and colour; the Alt family) | ESC and the letter (ESC k for K) | Esc, then the letter |
   | Alt+Shift+E (split down; the Alt family) | ESC E | Esc, then Shift+E |
   | Alt+1–Alt+9 (go to tab; the Alt family) | ESC and the digit | Esc, then the digit |
   | Alt+← / Alt+→ (previous / next tab; the Alt family) | ESC [ 1 ; 5 D / C, what Ctrl+← / → sends (xterm.js sends an Alt arrow as the Ctrl arrow on Linux and Windows) | Ctrl+← / Ctrl+→ |
   | Alt+↑ / Alt+↓ (previous / next workspace; the Alt family's alone: the other two leave them to the program) | ESC [ 1 ; 5 A / B, as for Alt+← / → | Ctrl+↑ / Ctrl+↓ |
   | Ctrl+Alt+K, P, O, Z, W, E, A, F, R (the Ctrl+Alt family) | ESC, then Ctrl+that letter (ESC 0x0b for K) | Esc, then Ctrl+that letter |
   | Ctrl+Alt+Shift+E, Ctrl+Alt+Shift+A (split down, previous editor group; the Ctrl+Alt family) | ESC Ctrl+E, ESC Ctrl+A | Esc, then Ctrl+E or Ctrl+A |
   | Ctrl+Alt+1–Ctrl+Alt+9 (go to tab; the Ctrl+Alt family) | ESC and the digit | Alt+digit, or Esc, then the digit |
   | Ctrl+3 (Automations) | ESC | Esc (Ctrl+[ stays the program's too) |
   | Ctrl+Tab (next tab) | Tab | Tab |
   | Ctrl+Shift+Tab (previous tab) | ESC [ Z | Shift+Tab |
   | Ctrl+Shift+Alt+W (close the split) | ESC Ctrl+W | Esc, then Ctrl+W |
   | Alt+Shift+↑ / ↓ (previous / next instance, every family), Alt+Shift+← / → (previous / next editor group in the Alt family, previous / next tab in the others) | ESC [ 1 ; 4 A / B / D / C | no plainer key: a named exception. No agent, shell or readline binds them (Esc, then Shift+arrow sends something else) |
   | Ctrl+Shift+F6 (leave the terminal) | ESC [ 17 ; 6 ~ | no plainer key: a named exception, because without it F6 cannot get out of a terminal |

   On Windows xterm sends nothing for Ctrl+Alt with a letter or a digit: it
   reads them as AltGr (see "AltGr" below). AltGr is never Alt, on Linux or
   Windows: a key it presses types its character and fires no Alt chord.
   `test/terminal-xterm-bytes.test.mjs` presses every allowlisted default, in
   each family, in the installed xterm.js and pins exactly what it sends, that
   each plainer key sends the same and is no default's in a terminal, and that
   the named exceptions are exactly these, so an xterm upgrade that changes
   one fails CI.
3. **macOS keeps ⌘, and moves with ⌥ and an arrow.** ⌘ never reaches the pty, so the macOS column changes only
   where a chord is wrong for macOS users too. Two named exceptions fire in a
   terminal, each checked by action id *and* shape, as Ctrl+Tab is:
   - **The leader**, ⌃X (the TUI's): ⌃ alone, key `x`; or key `\`, for ⌃\, the
     leader before 0.67, bound back. ⌃X is 0x18 (⌃\ is SIGQUIT's byte, 0x1c); the
     leader pressed twice gives the program exactly that. A rebind of the leader
     to a ⌘ chord fires by the ⌘ rule; a rebind to another ⌃ chord (⌃Y) stays
     the program's.
   - **The moves between tabs, groups and workspaces** (the product
     owner's call, 2026-10-23): ⌥← / ⌥→ the tabs, ⌥⇧← / ⌥⇧→ the editor groups, ⌥↑ / ⌥↓ the
     workspaces, the same chords as the Alt family's. Their shape is ⌥, with ⇧
     or without, and an arrow, with neither ⌘ nor ⌃: a move rebound to another
     such chord still fires in a terminal, one rebound to ⌥ with a letter does
     not, and no other action fires on a plain ⌥ arrow there. The letters and
     digits stay on ⌘ (⌥ with one types a character: ⌥2 is @ on a Spanish
     layout), and the instance moves keep ⌥⌘↑ / ⌥⌘↓.

     They take keys the program would get. The Desktop's terminal, xterm.js,
     with its "Option as Meta" off, as the Desktop leaves it, sends ⌥← / ⌥→ as
     ESC b / ESC f, readline's (and zsh's and Emacs') backward-word and
     forward-word, ⌥↑ / ⌥↓ as ESC [ 1 ; 3 A / B, and ⌥⇧ with an arrow as
     ESC [ 1 ; 4 and the arrow's letter (`evaluateKeyboardEvent` in xterm.js's
     `Keyboard.ts`, 5.5; `test/terminal-xterm-bytes.test.mjs` pins each). With
     the chords, the program gets none of them. **Esc, then b** and **Esc,
     then f** still send the word moves. **To give ⌥← / ⌥→ back to the
     program**, unbind or rebind *Next / previous tab, second chord* in the
     shortcuts editor (⌘,; Backspace on the row unbinds it), and the same for
     the groups and workspaces: an unbound ⌥← sends ESC b again. In a field of
     text the moves give way to the field ("macOS text fields keep ⌥ with an
     arrow", below).
4. **Every default goes through the collision review** in the keyboard lesson
   (`keyboard-focus-and-action-ownership`). That includes shifted punctuation:
   `KeyboardEvent.key` reports the shifted character (Shift+\ arrives as `|`).
   A chord that holds ⌘, Ctrl or Alt aliases it back (`MODIFIED_ALIASES`:
   `|` is `\`, `+` is `=`), so ⌘⇧\ matches. A plain chord keeps its
   character: one printable non-letter key (`?`, `|`, `[`, `/`) matches with
   whatever Shift the layout needed and is stored without Shift, so plain `|`
   never fires on plain `\`; a letter keeps its case (`N` is Shift+N). A
   character AltGr typed (`getModifierState("AltGraph")`) is never aliased:
   Spanish AltGr+1 is `|`, not `Ctrl+Alt+\`. On macOS ⌥ changes the character
   too (⌥O is ø, ⌥1 ¡), so a chord holding ⌥ with ⌘ or ⌃ names a letter key
   by the physical key (`KeyboardEvent.code`), as the keyboard layout labels
   it (`navigator.keyboard.getLayoutMap()`, read at startup and whenever the
   window comes back) when it labels it with an ASCII letter (AZERTY's KeyQ
   is A), else by the letter the code names (a Russian layout's KeyO, щ, is
   O; and so without the layout's map), and a digit key
   by its digit, on every layout (⌘⌥ on AZERTY's & key is ⌘⌥1): ⌘⌥O is
   Mod+Alt+O on every layout, and the shortcuts editor records it so. A
   rebind 0.66 recorded by the character ⌥ typed (Mod+Alt+Ø) still matches
   that press, ahead of any default, until it is recorded again (`eventChordsFor`). Linux and Windows keep `key`, and plain ⌥+key is typing. The tests
   dispatch the real shifted event, not a parse round-trip.

## How the engine holds it

- `DEFAULT_KEYMAP` has one entry per action id: a chord string (the same on
  every platform) or `{ mac, other }` when the platforms differ; `null` is "no
  default here". `defaultBinding(id, isMac)` reads it; `getBinding(id, isMac)`
  is override → platform default → a view's registration default.
- **Stored overrides win**, on every platform. Action ids never changed, so an
  override saved before this keymap still applies. The shortcuts editor shows
  the platform's effective chord and offers Reset when it differs from the
  platform default. A stored rebind that now shares its chord with another
  binding (a new default, say) is never changed for you: `keymapConflicts`
    finds it at load and on every keymap change, the sidebar foot's **?** (Keyboard
  shortcuts) carries a `--danger` dot and a description, and the
  editor names each clash at the top and on its row until you rebind or reset
  one side.
- One chord per action. Where the table has two (Ctrl+Tab and Alt+Shift+→; =
  and + on the Graph), the second is its own action (`tabs.nextPage`,
  `graph.zoomInPlus`), rebindable and unbindable on its own.
- **Terminal policy.** On Linux/Windows only the action ids in
  `TERMINAL_ALLOWLIST` fire while a terminal has focus; everything else reaches
  the program. The rule is by action id, so a user who rebinds an allowlisted
  action keeps their choice in the terminal; the allowlist is chosen by the
  defaults (principle 2). On macOS only ⌘ chords fire in a
  terminal (⌘ never reaches the pty), plus two shapes, each checked by
  action id *and* shape: Ctrl+Tab / Ctrl+Shift+Tab (`tabs.next`, `tabs.prev`)
  and the leader's ⌃X or ⌃\ (`app.leader`, principle 3's exception).
- Unmodified chords never fire from an editable field, nor, on Linux/Windows,
  the leader's Ctrl+X, which is the field's Cut (`leaderLeftToField`; see "The
  leader"); a view's own keys (the
  Graph, the Souls grid) stay local to that view. Where a view moves
  with the arrows (the roster tree, the Graph, the Souls grid, a
  row's actions button), an arrow chord the keymap binds is the keymap's
  (`keymapTakes`): Alt+Shift+↑/↓ (⌥⌘↑/↓), or a rebind, works from there as
  from anywhere, and an arrow chord bound to nothing stays the view's.

## The leader

New in 0.65.0. The leader is the TUI's: one chord, then one key from the TUI's
table. Both clients read it from `LEADER_TABLE` in `packages/client/keymap.mjs`,
and neither keeps a copy (`packages/tui/test/keymap.test.mjs` fails when the
TUI has no handler for a row). It is
**Ctrl+X** on every platform, as in Emacs (`app.leader`, rebindable like any
action; the table after it is fixed, as in the TUI). Changed in 0.67.0: it was
Alt+O on Linux and Windows and ⌃\ on macOS. A leader you set yourself is kept,
and ⌃\ bound back still fires in a terminal on macOS; Alt+O now reaches the
focused control or the program (ESC o in a terminal on Linux and Windows; on
macOS Option+O types its character, `ø` on a US layout).

**The leader, the keys after it and the shared chords are the TUI's; the
other direct shortcuts are Desktop extras.** So the two can differ, on purpose: leader then 1 is
Instances and leader then 3 is Capabilities, while ⌘1 / Ctrl+1 stays
Machines (the Workspace page's Machines tab: **View: Workspace › Machines**,
in the palette and the shortcuts editor) and ⌘3 / Ctrl+3 stays Automations
(**View: Automations**). The shortcuts editor says the same on those rows.

**Where it works.** From every focus, a terminal included, and on macOS an
editable field too. On Linux and Windows Ctrl+X in a text field (a text input
or a textarea that is not read-only, or a contenteditable; not a password or a
date, where there is nothing to cut, and not a terminal's input) is the field's Cut:
the leader leaves it there and does not open (`leaderLeftToField`). The rule
is the chord's: a leader you rebind to Ctrl+X follows it, and one you rebind
to another chord opens from a field as well. macOS cuts with ⌘X, so ⌃X is the
leader in a field there. It is inert while a modal dialog or the palette is shown, as F6 and
the tab switches are: the chord then goes where it goes without the leader.
The keys after it are listed in the shortcuts editor, which leads with the
Leader group (the sidebar foot's **?**, Ctrl+, / ⌘, or the palette); the
sidebar has no button of its own for the leader.

**While it waits** (there is no time limit), the next keydown that is not a
lone modifier settles it:

- A key in the table runs what the table below says, once, and is consumed:
  no phase of it (keydown, keypress, keyup, repeats) reaches the terminal or
  the focused control.
- The leader again: in a terminal, that second press is the program's, so it
  gets exactly what the chord sends (Ctrl+X 0x18, once: the shell's Ctrl+X
  Ctrl+E, nano's exit). In a text field on Linux/Windows it closes the wait and
  stays the field's Cut. Elsewhere it only closes the wait.
- Any other key cancels it and is dropped: nothing is typed, nothing else runs.
- A key is matched by what it types (`KeyboardEvent.key`: Shift+x is `X`,
  Shift+\ is `|`), whatever Shift or AltGr produced it. A named key that Shift
  moves (Tab, an arrow, Home, End, PgUp, PgDn) is read with Shift, as the TUI
  reads it: Shift+Tab is the previous group, and Shift+↑ is no row and
  cancels. A key held with Ctrl, ⌘ or Alt (AltGr aside) is not in the table,
  as in the TUI, and cancels.
- A click, a paste, the window losing focus, a modal opening or the focused
  element leaving the document cancels it, with nothing run.

**The hint.** While it waits, nothing shows: no panel lists the keys. The wait is announced once to
a screen reader ("Leader: press a key, Esc for the instances list", a visually
hidden `role="status"`), and the keys after it are listed in the shortcuts
editor (the leader's `?`). When a key cannot act (no target instance, an act
the row's context menu would not offer, no other tab, nothing to split), one quiet
line at the bottom of the main area says why, and is announced; it stays until
the next key, click or focus change. It is the only answer such a key gets. The
rows the TUI marks as terminal rows (`z`, `w`, the tab and split keys) act only
while a terminal tab is open; besides, ←/→ need two tabs or more in the strip
they walk (with the tabs split, the focused group's), `|`/`-` an
active tab that can split that way, and Tab, Shift+Tab and `x` tabs that are split.

**The target instance** of `X` `R` `S` `D` `N` is read when the key after the
leader is pressed, not when the leader is: the focused roster row's; else the
shown terminal tab's (in a terminal, or with focus nowhere; a terminal pane
keeps focus only as the shown one counts, so a pane hidden since names
nothing); else none. The previous / next instance moves have no leader key:
they are the chords' (`roster.openPrevious`, `roster.openNext`: Alt+Shift+↑ /
↓, ⌥⌘↑ / ⌥⌘↓), which read the same target where the chord was pressed and go
on from the instance an open still in flight is opening (until it fails, or
another selection supersedes it), else from the target: presses faster than
`/api/panel` answers or a terminal attaches make one move each, and none
re-opens the instance being opened. They open the terminal of the roster row
before / after the target, as the roster is drawn (collapsed
rows absent), passing over rows whose Enter would not open a terminal; no wrap.
With no target, the next opens the first and the previous the last. These two
and `terminal.focusMode` (the leader's `z`) run the leader's own dispatch, and
say why in the same line when they cannot act.

| Leader, then | Desktop does |
|---|---|
| `k`, Space | the command palette (`app.palette`) |
| `1` | Instances: the workspace's terminals again when any is open, else Workspace › Machines |
| `2` | Workspace › Souls |
| `3` | Workspace › Capabilities |
| ↑, ↓ | shows the previous / next workspace of the sidebar's [list of workspaces](#the-list-of-workspaces) in this window, as a click on its row does (`workspace-previous`, `workspace-next`). A row another window shows is not passed over: the move takes it over, and it moves here. The moves wrap: ↓ on the last row shows the first, ↑ on the first shows the last, over the whole list. With no other workspace to show, nothing moves and the line says "No other workspace to show." With no workspace shown, ↓ goes to the first row and ↑ to the last. The focus then goes back where it was in the workspace shown ([after a switch](#the-list-of-workspaces)); a move made from the list of workspaces leaves it on the list. Also the chords `workspace.previous`, `workspace.next`: Alt+↑ / Alt+↓ on Linux and Windows, ⌥↑ / ⌥↓ on macOS |
| ←, → | previous / next tab of the active tab's strip, in the order drawn: with the tabs split, the focused group's, each press another tab of it; an empty or one-tab group says "There is no other tab." (`tabs.prev`, `tabs.next`; the Desktop's cycling wraps, the TUI's does not) |
| `z` | focus mode on or off (`app.focusMode`), and the active terminal takes focus. Also `terminal.focusMode` |
| `w` | closes the active tab (`tabs.close`); the agent keeps running |
| `\|`, `-` | split right / split down (`split.vertical`, `split.horizontal`) |
| Tab, Shift+Tab | focuses the next / previous editor group's active tab, or the group when it is empty, wrapping (`split.focusNextGroup`, `split.focusPrevGroup`). On macOS the previous group has no chord, so Shift+Tab here is its key |
| `x` | closes the split, every tab kept (`split.close`) |
| `X`, `R`, `S`, `D` | Stop… / Restart… / Start… / Retire… for the target: the same dialogs and availability as its row's context menu |
| `n` | Quick Open: pick a soul, then the spawn dialog (`app.quickOpenSouls`) |
| `N` | the spawn dialog for the target's soul, as Quick Open opens it |
| `/` | the instance roster's current row (`sidebar.focusFilter`) |
| `o` | focuses the [list of workspaces](#the-list-of-workspaces) on its current row (`app.workspaces`) |
| `?` | the shortcuts editor (`app.shortcuts`), the Desktop's help |
| Esc | the instance roster, its one tab stop; a hidden sidebar or focus mode is shown first |

**Cannot apply:** `m` (move the tab to the other group). The Desktop has no
way to move a tab between groups; the key cancels like any key not in the
table, and the shortcuts editor leaves it out.

Changed in the next release: ↑ and ↓ move between workspaces. They opened the
previous / next instance's terminal before; Alt+Shift+↑ / ↓ (⌥⌘↑ / ⌥⌘↓) still
do that, from every focus. New: Shift+Tab, the previous editor group.

## The keymap as shipped

The keys come in three layers, as in `oats tui`:

1. **In the sidebar:** plain keys, such as `n` to spawn, `w` for the list of workspaces, `/` for the roster's current row ([Sidebar keys](#sidebar-keys)).
2. **Anywhere, a terminal included:** the shortcuts below, ⌘K and the rest on macOS, `Alt+K` and the rest on Linux and Windows by default, `Ctrl+Alt+K` or `Ctrl+Shift+K` and the rest [as an option](#the-chord-families). Not plain `Ctrl+K`: that is the program's, kill to the end of the line in Claude Code, Codex, pi and the shell.
3. **Always:** [the leader](#the-leader), `Ctrl+X` then a key, on every platform (in a text field on Linux and Windows, Ctrl+X is Cut).

The three Linux / Windows columns are [the chord families](#the-chord-families): Alt is the default, and Ctrl+Alt and Ctrl+Shift are options. "Works in a terminal" is for Linux and Windows; on macOS the ⌘ chords work there, and so do the ⌥ arrow moves (principle 3).

| Action (id) | macOS | Alt (the default) | Ctrl+Alt | Ctrl+Shift | Works in a terminal |
|---|---|---|---|---|---|
| Command palette (`app.palette`) | ⌘K | Alt+K | Ctrl+Alt+K | Ctrl+Shift+K | yes (plain Ctrl+K, kill to the end of the line, stays the program's) |
| Quick open a soul (`app.quickOpenSouls`; also the sidebar's **New agent**) | ⌘P | Alt+P | Ctrl+Alt+P | Ctrl+Shift+P | yes (plain Ctrl+P, shell history, stays the program's) |
| Focus the list of workspaces (`app.workspaces`; the leader's `o`, the sidebar's `w`, the palette's **Workspace: switch…**) | ⌥⌘O | Alt+O | Ctrl+Alt+O | Ctrl+Shift+S | yes |
| Open the previous / next instance's terminal (`roster.openPrevious`, `roster.openNext`; no leader key: the leader's ↑ ↓ move between workspaces) | ⌥⌘↑ / ⌥⌘↓ | Alt+Shift+↑ / ↓ | the same | the same | yes (a named exception, principle 2) |
| Show the previous / next workspace of the list (`workspace.previous`, `workspace.next`; the leader's ↑ ↓; the focus goes back where it was in that workspace, or stays on the list when the move is made from there) | ⌥↑ / ⌥↓ | Alt+↑ / Alt+↓ | none (the leader): Alt+↑ / ↓ are the program's | none (the leader) | yes |
| Focus mode on or off, in the active terminal (`terminal.focusMode`; the leader's `z`) | ⌥⌘Z | Alt+Z | Ctrl+Alt+Z | Ctrl+Shift+M | yes |
| Souls: choose a soul to spawn (Workspace › Souls) (`app.chooseSoul`) | ⌘N | Ctrl+Shift+N | the same | the same | yes |
| Close tab (`tabs.close`) | ⌘W | Alt+W | Ctrl+Alt+W | Ctrl+Shift+W | yes |
| Next / previous tab of the active tab's strip, wrapping; split, the focused group's (`tabs.next`, `tabs.prev`) | ⌃Tab / ⌃⇧Tab | Ctrl+Tab / Ctrl+Shift+Tab | the same | the same | yes |
| Next / previous tab, second chord (`tabs.nextPage`, `tabs.prevPage`; the leader's → ←) | ⌥→ / ⌥← | Alt+→ / Alt+← | Alt+Shift+→ / Alt+Shift+← | Alt+Shift+→ / Alt+Shift+← | yes (in Ctrl+Alt and Ctrl+Shift, a named exception, principle 2) |
| Go to tab 1–8, last tab, of the active tab's strip; split, the focused group's (`tabs.goto1`…`tabs.goto9`; each tab shows its number) | ⌥⌘1–⌥⌘9 | Alt+1–Alt+9 | Ctrl+Alt+1–Ctrl+Alt+9 | Ctrl+Alt+1–Ctrl+Alt+9 | yes (ESC and the digit, which Esc, then the digit still sends) |
| Split right (`split.vertical`) | ⌘\ | Alt+E | Ctrl+Alt+E | Ctrl+Shift+E | yes |
| Split down (`split.horizontal`) | ⌘⇧\ | Alt+Shift+E | Ctrl+Alt+Shift+E | Ctrl+Shift+D | yes |
| Focus the previous / next editor group (`split.focusPrevGroup`, `split.focusNextGroup`; the leader's Shift+Tab, Tab) | ⌥⇧← / ⌥⇧→ | Alt+Shift+← / Alt+Shift+→ | Ctrl+Alt+Shift+A / Ctrl+Alt+A | Ctrl+Alt+Shift+A / Ctrl+Alt+A | yes (in the Alt family, a named exception, principle 2) |
| Close the split (`split.close`; no button since spec F) | ⌥⌘W | Ctrl+Shift+Alt+W | the same | the same | yes |
| Home (`stage.home`, the palette's **View: Home**; its key comes with a later slice) | none | none | none | none | no |
| Workspace › Machines / Workspace overview / Automations (`stage.hierarchy`: the Workspace page on its Machines tab, the palette's **View: Workspace › Machines**; `stage.spawn`, `stage.automations`) | ⌘1 / ⌘2 / ⌘3 | Ctrl+1 / Ctrl+2 / Ctrl+3 | the same | the same | yes (Ctrl+3 is ESC, which Esc still sends) |
| Focus next / previous region (`focus.nextRegion`, `focus.prevRegion`) | F6 / ⇧F6 | F6 / Shift+F6 | the same | the same | no (mc, htop, nano) |
| Leave the terminal for the next region (`focus.leaveTerminal`) | ⇧⌘F6 | Ctrl+Shift+F6 | the same | the same | yes |
| Sidebar (`sidebar.toggle`; also the palette's **Sidebar: toggle (hide/show)**, and Show sidebar while it is hidden) | ⌘B | Ctrl+Shift+B | the same | the same | yes (plain Ctrl+B, the tmux prefix, stays the program's) |
| The sidebar's width back to 288px (`sidebar.resetWidth`; the palette's **Sidebar: reset width**; also Enter or a double-click on the sidebar's width handle) | none | none | none | none | – (the palette keeps it) |
| Focus the instance roster, on its current row, or, on an empty roster, the foot's New agent (`sidebar.focusFilter`, its id from when the roster had a filter; to find an instance by name, use the command palette) | ⌘F | Alt+F | Ctrl+Alt+F | Ctrl+Alt+F | yes |
| An instance's name and colour, for the leader's target (`instance.edit`; also **Instance: name and colour…**; no leader key) | ⌥⌘R | Alt+R | Ctrl+Alt+R | Ctrl+Alt+R | yes |
| Instance panel (`panel.toggle`; also Show instance panel while it is closed, and the panel's own close button) | ⌘I | Ctrl+Shift+I | the same | the same | yes (plain Ctrl+I, the Tab byte, stays the program's) |
| Theme picker (`app.themePicker`; also the palette's **Theme: choose…**) | ⇧⌘Space | Ctrl+Shift+Space | the same | the same | yes |
| Font picker: Omarchy's font or System font (`app.fontPicker`; also the palette's **Font: choose…**) | none | none | none | none | – (the palette keeps it) |
| Theme cycle: White, Solarized, Dark, This computer (`app.themeToggle`) | none | none | none | none | – (the palette keeps it) |
| Keyboard shortcuts (`app.shortcuts`) | ⌘, | Ctrl+, | the same | the same | yes |
| The leader, then one key (`app.leader`; see "The leader") | ⌃X | Ctrl+X | the same | the same | yes (a named exception, principle 2: it sends 0x18, which the leader pressed twice gives the program; on macOS by principle 3's exception; not in a text field on Linux/Windows, where Ctrl+X is Cut) |
| Copy the terminal selection (`terminal.copySelection`) | ⌘C (Edit › Copy, the menu role; the action has no macOS default) | Ctrl+Shift+C | the same | the same | yes |
| Terminal zoom (`terminal.fontBigger`, `…Smaller`, `…Reset`; also Settings → Terminal; reset lands on the default, 13px on Omarchy and 15px elsewhere) | ⌘= ⌘- ⌘0 | Ctrl+= Ctrl+- Ctrl+0 | the same | the same | yes |
| Open a file read-only (`app.openFile`) | ⌘O | Ctrl+O | the same | the same | no (Ctrl+O is a byte programs read) |
| New window, with no workspace (`app.newWindow`) | ⌘⇧N (File → New Window, the menu's accelerator) | none (the palette's **Window: new window**) | none | none | – |
| Cycle the app's windows | ⌘\` (macOS's own, Window menu) | none (the window manager's) | none | none | – |

The Ctrl+Alt and Ctrl+Shift columns are options, off by default: "The chord
families" below says what each changes and how to switch. Elsewhere on this
page a chord is named in the default family, Alt.

**The tabs' numbers.** Each tab shows a small number at its end: the N that
go to tab (Alt+N; ⌥⌘N on macOS) reaches in its strip. Tabs 1 to 8 show 1 to
8, and the last tab shows 9 once its strip has nine or more; the other tabs
past the eighth show none. With the tabs split, each group numbers its own
tabs, as the tab keys walk them. The number shows in every family and on
macOS: it is a position, not a key label. It is visual only (`aria-hidden`):
the tab's accessible name stays its name, and go to tab is in the shortcuts
editor. The tab's tooltip names the key, as the shortcuts editor shows it:
"oats-dev (Alt+3)", "(Ctrl+Alt+3)" in the Ctrl+Alt and Ctrl+Shift families,
"(⌥⌘3)" on macOS, and a key you rebound once you rebind it. A screen reader
reads the tooltip as the tab's description, so it learns the key there. A tab
with no number, or whose go to tab you unbound, names none. It never crowds out the name: as a strip narrows, the name truncates
first, down to the minimum the tab's floor keeps ("oats-…" and the last
eight characters), and then the number hides whole (`renderer/tab-numbers.mjs`,
`.tab-num` in `shell.css`; `test/tab-numbers.test.mjs`).

While the command palette is open, its group keys take their presses over
every binding (see "The command palette"): ⌘N and ⌥⌘N on macOS, Alt+Shift+↓
and Alt+Shift+↑ on Linux/Windows. The previous group is ⌥⌘N, not ⇧⌘N: ⇧⌘N is
File → New Window, a key the menu shows, so the palette doesn't shadow it. So ⌘N is `app.chooseSoul` only while the
palette is closed, and Alt+Shift+↓ / ↑ are `roster.openNext` /
`roster.openPrevious` only while it is closed.

Changed in the next release on Linux/Windows: the default family is Alt,
in both clients. The palette is Alt+K (was Ctrl+Alt+K), Quick Open Alt+P,
the list of workspaces Alt+O, focus mode Alt+Z, close tab Alt+W, split right
Alt+E and split down Alt+Shift+E, focus the instance roster Alt+F, an instance's name
and colour Alt+R, and go to tab Alt+1–Alt+9 (were Ctrl+Alt with the same
key). The second tab-cycling chords are Alt+← / Alt+→ (were Alt+Shift+← /
→), and Alt+Shift+← / → now move between the editor groups: the previous
group, new, and the next (was Ctrl+Alt+A). New in the Alt family alone: the
previous / next workspace of the list on Alt+↑ / Alt+↓; the other two leave
Alt+↑ / ↓ to the program, and the leader's ↑ ↓ move between workspaces in
every family. New in every family: the previous editor group
(Ctrl+Alt+Shift+A in the other two families; the leader's Shift+Tab
everywhere). Alt+Shift+↑ / ↓, the previous / next instance, are unchanged.
Whoever chose a family keeps it: a keys.json that says `"ctrl+alt"` or
`"ctrl+shift"` keeps that family, with today's keys, and only a user who never
chose moves to Alt. A binding you set yourself is kept as it is; when it is a
chord a default now takes, the shortcuts editor shows the clash. On macOS
the moves are ⌥ with an arrow (principle 3): the previous / next tab ⌥← / ⌥→
(were ⌥⌘← / ⌥⌘→), the previous / next editor group ⌥⇧← / ⌥⇧→ (the next was
⌥⌘A, which now does nothing; the previous is new) and the previous / next
workspace ⌥↑ / ⌥↓ (new). In a terminal they take ⌥← / ⌥→ from the program,
which got them as its word moves; in a text field they stay the field's. The
letters and digits keep ⌘, and the instance moves ⌥⌘↑ / ⌥⌘↓. Each tab now
shows its number, and its tooltip names its key (see "The tabs' numbers"
above).

Changed in 0.67.0 on Linux/Windows: the chords shared with the TUI
are one Ctrl+Alt family. The palette is Ctrl+Alt+K (was Ctrl+Shift+K), Quick
Open Ctrl+Alt+P (was Ctrl+Shift+P), close tab Ctrl+Alt+W (was Ctrl+Shift+W),
focus the instance roster Ctrl+Alt+F (was Ctrl+Shift+F), split right Ctrl+Alt+E (was
Ctrl+Shift+E) and split down Ctrl+Alt+Shift+E (was Ctrl+Shift+O). Go to tab is
Ctrl+Alt+1–Ctrl+Alt+9 (was Alt+1–Alt+9), and the second tab-cycling chords
are Alt+Shift+→ / Alt+Shift+← (were Ctrl+PgDn / Ctrl+PgUp); both now work
from a terminal. New, from a terminal too: the workspace switcher Ctrl+Alt+O
and the next editor group Ctrl+Alt+A (both had no default), the previous /
next instance's terminal Alt+Shift+↑ / Alt+Shift+↓ and focus mode in the
active terminal Ctrl+Alt+Z. Ctrl+Shift+K, P, W, F, E and O, Alt+digit and
Ctrl+PgUp/PgDn run nothing now, so they reach the focused control or the
program, unless you choose the Ctrl+Shift option (below), which gives K, P,
W and E their actions back. Ctrl+Tab / Ctrl+Shift+Tab and the shortcuts editor's Ctrl+, are
unchanged. On macOS nothing moved; new there are ⌥⌘O, ⌥⌘↑ / ⌥⌘↓, ⌥⌘→ / ⌥⌘←,
⌥⌘Z and ⌥⌘A. A binding you set yourself is kept as it is; when it is a chord a
default now takes, the shortcuts editor shows the clash.

Changed in 0.57.0 on Linux/Windows: the palette is Ctrl+Shift+K (was
Ctrl+Shift+P), and Quick Open is Ctrl+Shift+P (was Ctrl+P) and now works from
a terminal. Ctrl+Shift+P, which opened the palette since 0.30.3, opens Quick
Open. A binding you set yourself is kept as it is; when it is a chord a
default now takes, the shortcuts editor shows the clash. A Quick Open binding
you set yourself now fires from a terminal too, so a plain Ctrl+letter there
takes that key from the program.

Changed in 0.56.0 on Linux/Windows: the sidebar (was Ctrl+B) is
Ctrl+Shift+B, the instance panel (was Ctrl+I) Ctrl+Shift+I, and filter
instances (was Ctrl+F) Ctrl+Shift+F; these, the stages (Ctrl+1/2/3), the
shortcuts editor (Ctrl+,) and terminal zoom now work from a terminal. A
binding you set yourself is kept as it is.

Changed from 0.30.1 on Linux/Windows: the palette (was Ctrl+K), close tab (was
Ctrl+W), the splits (were Ctrl+\ and Ctrl+Shift+\, Ctrl+Alt+W), and Spawn
instance (was Ctrl+N). The theme cycle lost ⌘⇧T / Ctrl+Shift+T on both
platforms: it means "reopen closed tab" in browsers and "new tab" in Linux
terminals. New: go to tab, Ctrl+PgDn/PgUp, ⌘3/Ctrl+3, F6, and ⇧⌘F6 /
Ctrl+Shift+F6 to leave a terminal.

On macOS the "works in a terminal" column is simpler: every ⌘ chord works there
(⌘ never reaches the pty), and so do ⌃Tab and the leader's ⌃X; ⌃digits and F6 are the program's.
From a terminal, Ctrl+Tab switches tabs on every platform, and go to tab works
there too: ⌥⌘digit on macOS, Alt+digit on Linux/Windows.

Copy and paste in a terminal (#672). A drag, double-click or triple-click is
xterm's own selection. Ctrl+Shift+C (`terminal.copySelection`, allowlisted)
writes it to the clipboard on Linux/Windows; with nothing selected it does
nothing and sends nothing to the pty, and Ctrl+C, which xterm sends as the
interrupt, stays the program's. On macOS ⌘C is Edit › Copy, the menu's role,
not a keymap action. Right-click › Copy works on every platform. Paste is not
a keymap action either: ⌘V (Edit › Paste) on macOS and Ctrl+Shift+V on
Linux/Windows are Chromium's own paste into the terminal's input, which xterm
sends as one bracketed paste when the program asked for it; right-click ›
Paste does the same, and so does middle-click on Linux, which pastes the
primary selection a drag sets.

Scroll back in a terminal (#1502). A pane on this computer scrolls back with
the wheel or touchpad, Shift+PgUp, or Ctrl+B then `[`. A pane on another
machine runs that machine's viewer, which has Shift+PgUp and Ctrl+B `[` from
OATS 0.69.0; with an older OATS there, the wheel alone scrolls back. Each
enters tmux's copy mode, where the copy-mode keys move (PgUp, PgDn, the
arrows) and `q` leaves it. The shortcuts window lists them in Most useful and
in the Tabs group, as one read-only row ("Scroll back in a terminal") whose
tooltip names these conditions (`scrollBackKeys` in
`renderer/keybindings-editor.mjs`). So a terminal on
another machine opens without the kernel viewer's own status line, which
names the same keys (`--no-status-line`, asked only of a CLI that lists
`session-attach-no-status-line`): that row goes to the agent.
- **Shift+PgUp and Shift+PgDn reach tmux.** xterm.js would keep them to scroll
  its own viewport, which is empty while tmux draws on the alternate screen.
  The terminal's key path sends them on instead (CSI 5;2 ~ and CSI 6;2 ~,
  `shiftPageAction` in `renderer/terminal-tab.mjs`). No shortcut takes them
  first: a chord with no modifier but Shift never fires from a terminal's
  input, even when you bind it. tmux binds Shift+PgUp to scroll back a
  page; Shift+PgDn reaches the program as a native terminal sends it.
- **Ctrl+B [ is the one Ctrl+B key the viewer takes.** Ctrl+B then any other
  key reaches the agent as both keys, as typed, with no timeout. So C-b n,
  C-b C-b and Emacs or readline's C-b still work. Ctrl+B [ needs tmux 3.3 or
  later on the computer the agent runs on, because tmux sends a bound key on
  only from then. With an older tmux, Ctrl+B reaches the agent as before, and
  the wheel and Shift+PgUp still scroll back. One limitation: tmux resets
  every client's key table when any terminal opens on the same tmux server, so
  a Ctrl+B still waiting for its next key at that instant is dropped. Press it
  again.
- **A shortcut can take Ctrl+B before tmux.** On Linux/Windows, a shortcut
  on `TERMINAL_ALLOWLIST` (the ones marked as working in a terminal) bound to
  Ctrl+B fires instead, so Ctrl+B never reaches the pane. The two scroll rows
  then leave Ctrl+B [ out, and the Tabs row's tooltip names the shortcut that
  holds it (`terminalTaker` in `renderer/keybindings.mjs`, the dispatcher's
  own rule). On macOS only a chord with ⌘ fires in a terminal, so Ctrl+B is
  never taken there.
- **A scrolling viewer pauses the pane for everyone.** Copy mode is the pane's
  own, so while one viewer of a shared pane scrolls back, the others see the
  same paused view until it leaves copy mode. The wheel has always done this.
  The keys reach copy mode and nothing else: no window or session command.

The theme picker's chord is the in-app counterpart of Omarchy's theme menu
(Super+Ctrl+Shift+Space). Linux/Windows leave out Super, which belongs to the
window manager (principle 1); macOS puts ⌘ in Super's place and leaves out ⌃,
because on macOS a chord that holds ⌃ never fires while a terminal has focus
(Ctrl+Tab and the leader aside).
xterm.js sends no byte for either chord (its Ctrl+Space → NUL needs Shift up),
so the picker takes nothing from a program, and plain Ctrl+Space stays the
program's. On Omarchy, Super+Ctrl+Shift+Space opens Omarchy's own theme menu,
which changes the computer's theme (the one This computer follows), and
Ctrl+Shift+Space opens Desktop's picker. On Linux the engine ignores Super, so
where the window manager lets Super+Ctrl+Shift+Space through, it opens
Desktop's picker as well. A held chord does not open and close the picker over
and over. The palette's **Theme: choose…** opens the picker too; the theme
cycle stays in the palette.

The font picker has no default chord: the palette's **Font: choose…** opens it, and a chord given in the shortcuts editor
works as the explicit themes' do (in a terminal, only a macOS chord with ⌘).
On macOS ⌥ with Space types a no-break space, so the engine reads Space from
the physical key, and a ⌥ chord with Space can be given.

Inside the theme picker (and the font picker, which is the same picker over the
two fonts): ↑/↓ move between the themes (wrapping), Home/End go to
the first and last, Enter, Space or a click chooses (nothing applies before
that), Escape, the close button or the backdrop closes with nothing changed,
and Tab / Shift+Tab stay inside it; a background shortcut that moves focus
(⌘F / Alt+F to the instance roster) cannot take it out. Focus returns to what had
it, also to a control in a dialog that stays open under the picker (Stop or
Retire, Connections). The picker is on the palette layer, so it never opens where it
cannot be seen: while a dialog above that layer is shown (the spawn dialog,
the workspace dialog, the start dialog), the chord and **Theme: choose…** do
nothing.

F1 was considered as a second palette chord and left out: in a terminal F1
belongs to programs such as htop and mc.

Ctrl+Shift+N stays the soul chooser on Linux/Windows: New Window has no default
chord there, and the app installs no menu there, so it takes no Ctrl
accelerator from the terminal.

Actions without a default (bind them in the shortcuts editor): New window
(Linux/Windows), Settings (**Settings: Connections…**, as the palette names
it), focus mode, focus the active terminal, return to terminal groups,
explicit themes (`app.theme.light`, `app.theme.solarized`,
`app.theme.dark`, and `app.theme.host` for This computer), the font picker
(`app.fontPicker`), and the row context menu's Open in split / Open
pull request.

Rebinding applies everywhere a chord is shown: tooltips (the sidebar's Spawn
instance's among them), the settings menu's items, the palette's command
details and the spawn dialog's Spawn button.

**Shared with the TUI.** Twenty-six of these chords are written down once, in
`CHORDS` in `packages/client/keymap.mjs`, and `DEFAULT_KEYMAP` reads them from
there (`CHORDS_READ`, one action each), per family on Linux/Windows; on
macOS ⌘ or ⌥⌘ with a letter or a digit, and ⌥ with an arrow. In the Alt family, Alt with a letter does an action: the palette
(K), Quick open (P; a spawn, in the TUI), the list of workspaces (O), focus
mode (Z, the leader's `z`), close tab (W), split right (E) and split down
(Shift+E), the instance roster (F) and the instance's name and colour (R;
`instance.edit`, ⌥⌘R on macOS, no leader key). Alt with a digit goes to tab
1–8 of the active tab's strip, 9 to its last (with the tabs split, the
focused group's). Alt with an arrow moves between tabs (← →, the leader's
← →) and workspaces (↑ ↓, the leader's ↑ ↓; the Alt family's alone); Alt+Shift with an arrow
between editor groups (← →, the leader's Shift+Tab and Tab) and instances
(↑ ↓, which have no leader key). The Ctrl+Alt and Ctrl+Shift families move
some of them (see "The chord families"), in both clients. The TUI binds the
same chords from every focus (docs/tui.md, "Chords"); the leader stays the
key that always works. Ctrl+Tab / Ctrl+Shift+Tab, the stages' ⌘1–⌘3 /
Ctrl+1–Ctrl+3 and the shortcuts editor's ⌘, / Ctrl+, are the Desktop's own
and are not shared; help is the leader's `?`. `edit-instance` (Alt+R) is the
Desktop's alone so far: the TUI has no such action and binds no key for it.
`test/keymap-shared.test.mjs` pins the table and the whole default keymap in
each family.

**AltGr.** AltGr is never Alt. On Linux it is a key of its own (the event
reports `getModifierState("AltGraph")`, not Alt); on Windows it is Ctrl+Alt.
Either way, a key that types a character with AltGr types it and fires no
Alt chord: on a German layout AltGr+E is €, never Alt+E (split right), and
Polish AltGr+A is ą, never the Alt family's anything. The engine matches the
character a key types (`KeyboardEvent.key`), and on Linux and Windows it
reads Alt as not held when AltGraph is and Ctrl is not (`chordFromEvent`).
In the Ctrl+Alt family, on Windows, a layout that types a character on a
Ctrl+Alt chord (Spanish: € on E, | @ # on 1 2 3; Polish: ą ę ó ż on A E O Z)
keeps that chord: the key types its character, in a text field and in a
terminal, and runs nothing. The chords whose keys type nothing there are the
Desktop's as everywhere (Spanish Ctrl+Alt+K is the palette). For the others
the leader still works (Ctrl+X, then the key: `|` splits right, `z` is focus
mode), Ctrl+Tab still cycles the tabs where go to tab is the layout's, and
the shortcuts editor can rebind the action. German gives up Ctrl+Alt+E (€)
and the digits 2, 3, 7, 8 and 9 the same way. On AZERTY the digit row types
& é " ' … without Shift, so on Linux and Windows Alt+1 arrives as Alt+& and
go to tab never matches there; on macOS ⌘⌥ with the digit key matches,
whatever the layout types on it. A character AltGr types is never read as
another key: Spanish AltGr+1 is `|`, never a binding on `Ctrl+Alt+\`.
`test/terminal-xterm-bytes.test.mjs` pins both layouts through the terminal's
own key path, and `test/keymap-linux.test.mjs` that an AltGr press fires no
Alt chord.

### The chord families

On Linux and Windows the chords shared with the TUI come in three families,
one choice per user for both clients. macOS has no choice: ⌘ stays for the
letters and digits, and ⌥ with an arrow moves (principle 3).

- **Alt, the default.** Alt with a letter or a digit for an action, Alt with
  an arrow to move between tabs and workspaces, Alt+Shift with an arrow
  between editor groups and instances. Changed in the next release (the
  product owner's call, 2026-10-22; the maintainer set the keys): it takes keys programs in
  a terminal read, listed in [what the Alt family takes](#what-the-alt-family-takes).
- **Ctrl+Alt, the option for whoever needs Alt in their programs.** The
  default until the next release, with its keys unchanged: Ctrl+Alt with a
  letter or a digit for an action, Alt+Shift with an arrow to move between
  tabs and instances, and Ctrl+Alt+A / Ctrl+Alt+Shift+A between editor
  groups. It leaves the Alt keys to the program, the Alt arrows included:
  the workspace moves have no chord here, so in a terminal Alt+↑ / Alt+↓
  reach the program (xterm.js sends them as Ctrl+↑ / ↓ on Linux and
  Windows), and the leader's ↑ ↓ move between workspaces.
- **Ctrl+Shift, the option for a terminal that passes Ctrl+Shift apart from
  Ctrl** (foot, Alacritty). Seven of the Ctrl+Alt family's chords move to
  Ctrl+Shift: the palette (K), Quick Open (P), the list of workspaces (S),
  focus mode (M), close tab (W), split right (E) and split down (D). The
  others keep their Ctrl+Alt key: the Alt+Shift arrows, since Ctrl+Shift with
  an arrow selects text in an input; go to tab, since Ctrl+Shift with a digit
  is a shifted symbol on most layouts; the editor groups and the instance
  roster, whose Ctrl+Shift+A and Ctrl+Shift+F terminals and agents take;
  an instance's name and colour (Ctrl+Alt+R), the Desktop's alone. Like the
  Ctrl+Alt family it has no workspace move: Alt+↑ / Alt+↓ are the program's,
  and the leader's ↑ ↓ move.

**Who gets which.** A user who never chose has the default, Alt. A choice is
kept: keys.json's `"chords": "ctrl+alt"`, written by the Shortcuts page or by
hand, keeps the Ctrl+Alt family, with the keys it had. No file, or one with
no `chords`, is no choice. An older client that does not know the Alt family
reads `"chords": "alt"` as a value it cannot take, so it binds its own
default and says so.

In the Desktop every family works. The options are for the programs in a
terminal (Ctrl+Alt) and for the terminal you run `oats tui` in (Ctrl+Shift:
only foot and Alacritty let the seven through; docs/tui.md, "Which family
for my terminal"). None of the families' chords is one of the Desktop's own
(Ctrl+Shift N, B, I, C, Space, Tab, Alt+W, F6), and the Desktop installs no
menu on Linux or Windows (`app-menu.mjs`), so no accelerator takes one, and
Alt alone opens no menu bar.

- **In a terminal.** Each family's chords fire while a terminal has focus:
  they are on `TERMINAL_ALLOWLIST`, by action id (principle 2). A chord of
  another family is no binding at all: in the Alt family, Ctrl+Alt+K and
  Ctrl+Shift+K reach the program; in the Ctrl+Alt family, Alt+K does.
  `test/terminal-xterm-bytes.test.mjs` pins what each family's chords send
  through xterm.
- **Your own bindings still win, row by row.** An action you rebound in the
  shortcuts editor keeps your chord in every family. A rebind of another
  action to a chord a family's default now holds (an Alt+letter you bound
  before, say) clashes with it: the editor shows the clash, as it shows
  any, and your rebind is the one that fires, until you rebind or reset one
  side. On any chord two actions share, the one you bound wins over the one
  holding it by default.
- **Text fields, on Linux and Windows.** No text field of the Desktop reads Alt+letter or an Alt
  arrow: every one is a native input or text area (the palette's and Quick
  Open's inputs, the dialogs' fields, the shortcuts
  editor's search), which moves by word with Ctrl+← / Ctrl+→ on Linux and
  Windows, and the Desktop has no code editor. So the Alt family's chords
  fire from a field as from anywhere, and take nothing from it.
- **A select keeps Alt+↑ / Alt+↓.** A native control opens its popup with
  them on Linux and Windows: a select's list (Brain's Agent selector, the
  setup pages' selects), an input's suggestions, a date or time picker. While
  one has focus, the workspace moves' default Alt+↑ / Alt+↓ (the Alt
  family's; ⌥↑ / ⌥↓ on macOS) are left to it; from anywhere else they move
  between workspaces. A binding of those keys you made yourself still fires
  there.
- **macOS text fields keep ⌥ with an arrow.** There ⌥← / ⌥→ move by word,
  ⌥⇧← / ⌥⇧→ select by word, and ⌥↑ / ⌥↓ go to the paragraph's start or end
  (with ⇧, selecting). While a field of text has focus (a text input, a
  password or a read-only one too, a text area, a contenteditable), the
  moves' defaults are left to it; from anywhere else,
  a terminal included, they move. A binding of those keys you made yourself
  still fires there. Linux and Windows move by word with Ctrl+← / Ctrl+→,
  which no default takes, so their fields need no such rule.
- **The palette's cycle.** Its chord with Shift moves up: Alt+Shift+K by
  default, Ctrl+Alt+Shift+K in the Ctrl+Alt family. Ctrl+Shift+K already
  holds Shift, so in the Ctrl+Shift family the palette moves up with
  ArrowUp. The palette's own group keys, Alt+Shift+↓ / ↑, win over the
  instance moves while it is open, in every family (see "The command
  palette").

### What the Alt family takes

These are the keys the Alt family takes from a program in a terminal, by
the program's own key documentation (researched 2026-10-23; sources below).
"Esc, then the key" works where the program says an ESC prefix is Meta:
readline, zsh, Emacs and irssi do. Where its docs don't say, the way is
marked unknown, and the Ctrl+Alt family gives the key back
([Switch family](#switch-family)). An Alt key no chord holds (Alt+B, Alt+D,
Alt+T, Alt+.) is still the program's.

The Alt arrows take nothing in the Desktop. Its terminal (xterm.js) sends an
Alt arrow as the Ctrl arrow on Linux and Windows (`CSI 1;5`), before and after
this change, so a program never got Alt+arrow from it, and Ctrl+arrow still
sends exactly what it sent. Programs bind Alt arrows too (Codex's agent
threads, irssi's split windows, WeeChat's buffers, readline's and pi's word
moves): in `oats tui`, in a terminal that sends `CSI 1;3`, the Alt family
takes those (docs/tui.md).

| Program | Key the Alt family takes | What the program does with it | How it still gets it |
|---|---|---|---|
| Claude Code | Alt+P | the model picker | unknown: its docs don't say whether Esc, then P is Meta+P, and Esc alone interrupts; switch to Ctrl+Alt |
| Claude Code | Alt+O | fast mode on or off | as Alt+P |
| Claude Code | Alt+F | forward a word | as Alt+P |
| Codex | Alt+R | raw output on or off | unknown; switch to Ctrl+Alt |
| Codex | Alt+F | a word right | Ctrl+→, its other key for it |
| pi | Alt+F | a word right | Esc, then f: pi reads ESC f as a word right |
| bash (readline) | Alt+P, Alt+F, Alt+R | search history back; forward a word; revert the line | Esc, then p, f or r |
| bash (readline) | Alt+1–Alt+9 | a numeric argument | Esc, then the digit |
| zsh (emacs keymap) | Alt+P, Alt+Z, Alt+W, Alt+F | history search back; run the last named command; copy the region; forward a word | Esc, then the letter |
| zsh (emacs keymap) | Alt+1–Alt+9 | a numeric argument | Esc, then the digit |
| irssi | Alt+1–Alt+9; Alt+W, E, R, O | go to window 1–9; to window 12, 13, 14, 19 | Esc, then the key |
| irssi | Alt+K, P, F | erase completion; page back; forward a word | Esc, then the key |
| WeeChat | Alt+1–Alt+9 | go to buffer 1–9 | unknown; switch to Ctrl+Alt |
| WeeChat | Alt+K, R, F, P, Z, W | grab a key; delete the line; next word; previous highlight; zoom; Alt+W starts the window keys | unknown; switch to Ctrl+Alt |
| tmux | nothing without the prefix (the root table binds only the mouse) | after the prefix: Alt+1–Alt+7 the preset layouts, Alt+O / P / N rotate panes and go to a window with an alert | its commands (`select-layout`, `resize-pane`); Esc, then the key is read as Alt only within `escape-time` (10 ms by default in tmux 3.7c), so not by hand; or switch to Ctrl+Alt |
| Emacs (`emacs -nw`) | Alt+K, E, Shift+E, Z, W, F, R | kill-sentence, forward-sentence (with Shift too), zap-to-char, kill-ring-save, forward-word, move-to-window-line | Esc, then the letter |
| Emacs | Alt+1–Alt+9 | a numeric argument | Esc, then the digit |

Not taken from any of them: Alt+A, which the Alt family leaves alone (the
next group is Alt+Shift+→ there), so zsh's accept-and-hold, irssi's and
WeeChat's next active window or buffer and Emacs's backward-sentence keep it.
Not taken from these programs, by their docs: Alt+K, Z, W, E and R in
Claude Code; the Alt+Shift arrows everywhere above but in WeeChat's cursor
mode; Alt+O in Emacs since 28. On macOS the table does not
apply: ⌥ with a letter or a digit is no chord there. What ⌥ with an arrow
takes on macOS is below.

Sources: Claude Code [interactive mode](https://code.claude.com/docs/en/interactive-mode)
and [keybindings](https://code.claude.com/docs/en/keybindings); Codex
[`keymap.rs`](https://github.com/openai/codex/blob/d6817454d76885e9d0e118bbf82e507aed6f715a/codex-rs/tui/src/keymap.rs)
and [`app/input.rs`](https://github.com/openai/codex/blob/d6817454d76885e9d0e118bbf82e507aed6f715a/codex-rs/tui/src/app/input.rs);
pi [`keybindings.md`](https://github.com/badlogic/pi-mono/blob/42cb822f1c5d3153069dd0661bfd297424666cf1/packages/coding-agent/docs/keybindings.md)
and [`keys.ts`](https://github.com/badlogic/pi-mono/blob/42cb822f1c5d3153069dd0661bfd297424666cf1/packages/tui/src/keys.ts);
the [Readline manual](https://tiswww.case.edu/php/chet/readline/readline.html)
("Typing 'ESC f' is equivalent to typing M-f") and readline 8.3's `readline.c`
for the Alt arrows; the [zsh line editor](https://zsh.sourceforge.io/Doc/Release/Zsh-Line-Editor.html);
irssi's [startup HOWTO](https://github.com/irssi/irssi/blob/43f1727ef9fe1cb51d5031ee2dd0e1965217e4cb/docs/startup-HOWTO.txt)
and [`gui-readline.c`](https://github.com/irssi/irssi/blob/43f1727ef9fe1cb51d5031ee2dd0e1965217e4cb/src/fe-text/gui-readline.c);
the [WeeChat user guide](https://weechat.org/files/doc/weechat/stable/weechat_user.en.html#key_bindings) (4.10.1);
[tmux(1)](https://man7.org/linux/man-pages/man1/tmux.1.html); the
[Emacs manual](https://www.gnu.org/software/emacs/manual/html_node/emacs/User-Input.html)
(ESC as Meta) and its Sentences, Words, Moving Point, Other Kill Commands and
Arguments nodes.

#### What ⌥ with an arrow takes on macOS

The moves between tabs, groups and workspaces (principle 3) take these keys.
What a terminal's program gets is what xterm.js sends with "Option as Meta"
off, as the Desktop leaves it (`test/terminal-xterm-bytes.test.mjs` pins it).

| Where | Key | What it does there | How it still gets it |
|---|---|---|---|
| A text field of the Desktop | ⌥← / ⌥→; with ⇧ | a word back / forward; select by word | kept: the moves give way in a field of text |
| A text field of the Desktop | ⌥↑ / ⌥↓; with ⇧ | to the paragraph's start / end; select so | kept, as above |
| bash (readline), zsh (emacs keymap), Emacs (`emacs -nw`) in a terminal | ⌥← / ⌥→, sent as ESC b / ESC f | backward-word / forward-word (M-b, M-f) | Esc, then b or f; or unbind the tab moves in the shortcuts editor, and ⌥← / ⌥→ send ESC b / ESC f again |
| pi in a terminal | ⌥→, sent as ESC f | a word right (pi reads ESC f so) | Esc, then f; or unbind as above |
| A program that reads Alt+↑ / ↓ in a terminal (Codex's edit-queued-message and pi's restore-queued, by #1491's review) | ⌥↑ / ⌥↓, sent as ESC [ 1 ; 3 A / B | its own | no plainer key sends it: unbind or rebind the workspace moves |
| Any program in a terminal | ⌥⇧ with an arrow, sent as ESC [ 1 ; 4 and the arrow's letter | nothing in the programs above (principle 2's table says so of the Alt+Shift arrows) | – |

### Which family for my terminal

The choice is shared with `oats tui`, so pick it by the terminal you run
`oats tui` in. In the Desktop every family works. `✓` is a family whose
chords reach `oats tui` in that terminal, `✗` one whose chords do not, with
the reason (docs/tui.md, [Which family for my
terminal](../../../docs/tui.md#which-family-for-my-terminal), and its full
matrix). The Alt family needs no kitty keyboard protocol: Alt+letter and
Alt+digit are ESC and the key, and the Alt arrows have sequences of their own,
in every terminal below.

| Terminal | Alt (default) | Ctrl+Alt | Ctrl+Shift |
|---|---|---|---|
| foot | ✓ | ✓ | ✓ |
| Alacritty | ✓ | ✓ | ✓ |
| Ghostty | ✓, but on Linux Alt+1 to 8 are its tabs and Alt+9 its last, when the tab changes | ✓ | ✗ Ghostty closes its own tab on Ctrl+Shift+W, taking oats tui with it |
| kitty | ✓ | ✓ | ✗ kitty takes Ctrl+Shift+K, P, S, W and E for itself; W closes its window, `oats tui` with it |
| WezTerm | ✓ | ✓ with `enable_kitty_keyboard`; without it only the Alt+Shift arrows | ✗ WezTerm takes Ctrl+Shift+K, P, M and W for itself: clear the scrollback, its command palette, hide the window, close the tab |
| GNOME Terminal | ✓, but with two tabs or more Alt+1 to 9 are its tabs | ✗ no kitty keyboard protocol (VTE has none): only the Alt+Shift arrows arrive | ✗ no kitty keyboard protocol: a Ctrl+Shift letter reaches a program as the Ctrl letter |
| Konsole | ✓, but with two tabs or more Alt+1 to 9 are its tabs | ✓ since 26.08 | ✗ Konsole takes all seven for itself; Ctrl+Shift+W closes the tab |
| Windows Terminal | ✓, but with split panes the Alt arrows move between them and the Alt+Shift arrows resize them | ✓, but `Ctrl+Alt+1` to `9` are its tabs, and the Alt+Shift arrows resize its split panes | ✗ Windows Terminal takes Ctrl+Shift+K, P, M, W and D for itself; W closes the pane |

Where a terminal takes go to tab's Alt+digit, go to tab is still Ctrl+Tab or
the leader's ← →, or choose Ctrl+Alt. On macOS `oats tui` binds only the
arrow chords (⌥ with an arrow), which reach it where the terminal sends an
Option arrow as one (docs/tui.md says which do); Option with a letter or a
digit is no chord there.
Sources: [GNOME Terminal's
accelerators](https://gitlab.gnome.org/GNOME/gnome-terminal/-/blob/master/src/terminal-accels.cc),
[Konsole's tab shortcuts](https://invent.kde.org/utilities/konsole/-/blob/master/src/ViewManager.cpp),
[Ghostty's default keybinds](https://github.com/ghostty-org/ghostty/blob/main/src/config/Config.zig),
[Windows Terminal's defaults](https://github.com/microsoft/terminal/blob/main/src/cascadia/TerminalSettingsModel/defaults.json),
and each terminal's own key reference for the rest.

### Switch family

- **On the Shortcuts page** (`app.shortcuts`, Ctrl+,), at its top,
  Linux/Windows only: **Shortcut family, shared with oats tui**, with
  **Alt (default)**, **Ctrl+Alt (for programs that read Alt)** and
  **Ctrl+Shift (foot, Alacritty)**. Under it: "All three work here; pick the
  one your terminal passes to oats tui. oats tui uses it from its next start."
  A change writes the file at once and switches the keymap at once, in every
  window, with no restart.
- **Or by hand:** `$OATS_HOME_DIR/config/keys.json`, else
  `~/.oats/config/keys.json`, beside the TUI's `tui.json`:
  `{ "chords": "ctrl+alt" }` or `{ "chords": "ctrl+shift" }` (`"alt"` is the
  default, and no file is the default too). The main process reads it as
  each window opens, and again each time the Desktop gets the focus, and
  hands the family to every window: a change by hand applies when you switch
  back to the Desktop. `oats tui` reads it at its start.
- **A file it cannot take means Alt.** A file that cannot be read or is
  larger than 16 KiB, not a JSON object, with no `chords` or another value:
  each is the default, and the Shortcuts page says why under the choice
  ("keys.json: unknown chords value, using Alt"). A missing file is the
  default with nothing to say. Nothing needs fixing.
- **The Desktop writes only `chords`** and keeps every other key, so a key
  a later client adds survives an older Desktop. It writes a temp file in
  the same directory, then renames it over the file, so the file is never
  half written. A `keys.json` that is a symbolic link is written where the
  link leads, and the link stays. A file it cannot keep whole (one it
  cannot read, not a JSON object, or too large once `chords` is set) it
  leaves as it is, and the page says what to do: "Could not write
  keys.json: the shortcuts stay Alt. Fix or remove the file, then choose
  again."
- **It is the clients' file.** The kernel never reads it.
- The reader is `packages/client/keys-file.mjs`, which the TUI reads too.

### Sidebar keys

New in 0.65.0. While focus is in the sidebar (the list of workspaces, the
heading's controls, the nav, a roster row, the foot), the TUI's plain keys work there too (`PLAIN_KEYS` in
`packages/client/keymap.mjs`). Each is its own action in the `sidebar`
context (`sidebar.key.*`, `SIDEBAR_KEYS`), rebindable and unbindable in the
shortcuts editor's **Sidebar keys** group, and each does what the same key
does after the leader. They never fire in an editable field (one there would
type them) or inside a menu open there (an instance row's context menu), and
never with focus outside the sidebar.

| Key | Action id | Does |
|---|---|---|
| `1` `2` `3` | `sidebar.key.instances`, `…souls`, `…capabilities` | Instances, Workspace › Souls, Workspace › Capabilities |
| `w` | `sidebar.key.workspaces` | focuses the [list of workspaces](#the-list-of-workspaces), as the leader's `o` does |
| `/` | `sidebar.key.filter` | the instance roster's current row |
| `r` | `sidebar.key.refresh` | reads the instance roster now |
| `z` | `sidebar.key.zoom` | focus mode on or off, then the active terminal |
| `c` | `sidebar.key.closeTerminal` | closes the active tab |
| `[` `]` | `sidebar.key.tabPrevious`, `…tabNext` | previous / next tab |
| `\|` `-` | `sidebar.key.splitRight`, `…splitDown` | split right / split down |
| `X` `D` `S` `R` | `sidebar.key.stop`, `…retire`, `…start`, `…restart` | Stop… / Retire… / Start… / Restart… for the focused roster row (on a workspace row, a heading's control, a nav button or the foot, the active terminal tab's instance) |
| `n`, `N` | `sidebar.key.spawn`, `…spawnAnother` | Quick Open; the spawn dialog for the focused row's soul |
| `?` | `sidebar.key.help` | the shortcuts editor |

A key that cannot act says why in one line at the bottom of the main area, as
the leader does. While focus is in the sidebar the tab layer's (or a stage's)
shortcuts are on too, so a sidebar key and a tab shortcut on the same chord
clash: the shortcuts editor shows it, as it shows any clash with a stored
rebind. A one-character non-letter key (`?`, `|`, `[`, `/`) matches
whatever Shift the keyboard layout needs for it; a letter keeps its case, so
`x` is not Stop.

On a roster row the tree also reads the TUI's `k` `j` (up, down), `g` `G`
(first, last), `h` `l` (collapse or go to the parent, expand), beside the
arrows, and PageUp/PageDown move by the rows that fit the list. These stay the
tree's own keys, as the arrows are, and are not in the shortcuts editor. An
arrow held with a modifier is the tree's too, unless it is a shortcut: the
shortcuts on arrows work from a row as from anywhere (in the Alt family Alt+↑ /
↓ and Alt+Shift+↑ / ↓, and, while tabs show, Alt+← / → and Alt+Shift+← / →;
on macOS ⌥↑ / ↓ and ⌥⌘↑ / ↓, and ⌥← / → and ⌥⇧← / →), and so does a shortcut
rebound to an arrow.

**Not taken, and why:**

- Tab: the sidebar's own focus order.
- Esc: keeps closing what it closes today.
- `q`, Ctrl+C (quit): a stray letter must not close a window; the window
  manager and ⌘Q own that.
- Ctrl+Z, Ctrl+L: a terminal program's suspend and redraw; nothing to do in a
  window.
- Ctrl+K: the Desktop's palette is ⌘K / Alt+K, and plain Ctrl+K is the
  program's in a terminal, so it would work in only half the places; the
  leader's `k` is the shared key.
- `C` (check an unknown spawn): the Desktop reports a spawn's outcome in its
  own notification; there is no command to put on a key.
- `i`, and the Souls and Capabilities views' own keys: those views keep their
  local keys.

### The list of workspaces

The sidebar's top lists every workspace this window can show, one line each:
its name ([OATS Desktop](../../../docs/desktop.md#workspaces) says what the
list shows). It is a list of buttons, not a listbox, so the sidebar keys work
on its rows.

- **Reaching it.** One tab stop: the row last focused there, else the current
  one. It is the first region: F6 lands on that stop, and Tab from the
  heading's **Add local workspace…** reaches it. `w` in the sidebar, the leader's `o`, ⌥⌘O / Alt+O
  (`app.workspaces`, "Focus the list of workspaces") and the palette's
  **Workspace: switch…** focus its current row from anywhere: a hidden sidebar
  is shown and focus mode is left first.
- **Moving.** Up/Down move between the rows, Home/End go to the first and the
  last; moving focus selects nothing. The list scrolls within about six rows,
  the current row kept in view.
- **Every workspace, always.** The list always shows every workspace (slice 1
  of the Desktop UI rework dropped Show only the current workspace and its
  ⌥⇧⌘O / Ctrl+Alt+Shift+O, which reach a terminal's program again). A focused
  row that goes from the list hands focus to the current row.
- **Opening.** Enter or Space shows the row's workspace in this window.
- **Open in new window.** ⌘Enter (macOS) / Ctrl+Enter (Linux/Windows) on a row
  opens its workspace in its own window, or brings that window to the front;
  the row's description says so. The row's context menu (Shift+F10 or the Menu
  key, or a right-click) has **Open in new window** too: Enter runs it, Esc or
  Tab closes the menu, back on the row.
- **Moving between workspaces from anywhere.** The leader's ↑ / ↓ show the
  previous / next workspace of the list (see [the leader](#the-leader)), and
  so do Alt+↑ / Alt+↓ on Linux and Windows in the Alt family, and ⌥↑ / ⌥↓ on
  macOS (`workspace.previous`, `workspace.next`). The Ctrl+Alt and Ctrl+Shift
  families have no chord for them: they leave Alt+↑ / ↓ to the program.
- **Where the focus goes after a switch.** Back where it was in that
  workspace when this window last showed it, whatever made the switch (a
  pick, a move, the Workspace page's select, or the window falling back after
  another one took its workspace over): the terminal's input, ready to type
  (a terminal still attaching takes it once attached; one whose session ended
  has its tab focused, and nothing typed reaches it);
  a tab's content, or the tab, a split control or the empty group it was on;
  the instance's row in the list of instances, once that list has been read
  (its selected row, or Retry, when that instance is gone; nothing moves if
  you have moved on meanwhile); the control of the page, the views or the
  instance panel, or that region's current item when it is gone. A focus on
  this list, the palette, a dialog or a menu doesn't count: the place is the
  last focus before it. With no place (a first visit), the focus stays where
  it is when that is still shown, and goes to the main area when the switch
  hid it. A move made while the focus is in this list (Alt+↑ / ↓, ⌥↑ / ↓,
  the leader's ↑ / ↓) leaves it here: you are browsing workspaces. With focus
  mode on or the sidebar hidden, a row of the list of instances can't take
  the focus: the main area does. A spawn that hands off to its new instance in
  another workspace focuses that instance instead, and a take-over focuses
  the handed layout's active terminal. Only the focus inside the window moves:
  a window is never raised for it.

**A workspace another window shows** is a row like any other. Picking it (a
click, Enter, the
leader's ↑ / ↓, the workspace select of the Workspace page, or a spawn
that hands off to its new instance there) moves it to this window; nothing
else is focused. The other window lets it go: it shows the workspace it showed
most recently before that one among those the Desktop still serves and no
other window shows, else no workspace ("Choose a workspace", its list
focused, or the Add dialog when the Desktop serves no workspace).
It then closes every tab it had of that workspace and forgets its layout. Main
waits at most 2 seconds for that window's answer; a window that answers late
ends the same way. **Open in new window** still brings the other window to the
front instead.

Only the terminals and the split move with the workspace: this window opens
the same terminal tabs in the same split, each with a fresh viewer, and the
agents keep running. File, brain and view tabs do not move: they close in the
other window.

## Regions (F6)

F6 moves focus to the next region, Shift+F6 to the previous one, in this order:

1. **Workspaces**: the list's one tab stop (the row last focused, else the
      current one), else the heading's **Add local workspace…** (Shift+Tab from
   the list reaches it).
2. **Views**: the current view's nav button (Home, also for the Workspace
   page Home opens, or Automations, `aria-current`), else the first; the nav
   sits under the list.
3. **Instance roster**: its one tab stop, the selected row (the one whose
   terminal is the active tab), else the first row; with no rows, a control it
      shows (Retry), else the foot's **New agent**, its one action. It has
   no filter: the command palette finds an instance by name.
   The sidebar's foot (one bar: **N need you** while an instance needs input,
   **New agent** and **?**) and the sidebar's width handle after it are no
   region: Tab reaches them after the roster, and F6 from there goes on to
   Main, Shift+F6 back to the roster. From an empty roster's stop there (New
   instance), Shift+F6 goes back as from the roster, to the views.
4. **Main**: with tabs open, the active tab's content (a terminal's input,
   through the same selection intent as any explicit terminal focus), else a
   focused empty split group, else the active tab in the strip; on a stage,
   its first control. The tab strip, the split controls, Show sidebar and Show
   instance panel belong here.
5. **Instance panel**: its selected tab (a stage's content, such as the soul
   inspector: its first control), while the panel is open.

Inside a terminal F6 belongs to the program (mc, htop, nano). **⇧⌘F6 /
Ctrl+Shift+F6** (`focus.leaveTerminal`) leaves the terminal for the next region
in the same order; from there plain F6 and Shift+F6 cycle as usual.

Then back to the workspaces. A hidden region is skipped (the sidebar while hidden or
in focus mode, the panel while closed or when it has nothing to show), and so
is a region with nothing focusable at that moment: focus never lands on
`<body>`. From a terminal the closed panel is opened by `panel.toggle`'s chord.

**A closed sidebar or panel leaves nothing behind** (no strip, rail or edge).
Two buttons reopen them, at the two ends of the main area's top bar (the tab
strip with tabs open, else the stage's header): **Show sidebar** at its start,
shown while the sidebar is hidden or focus mode is on (`sidebar.toggle`, which
also leaves focus mode), and **Show instance panel** at its end, shown while the
panel is closed, or hidden by focus mode, and has something to show
(`panel.toggle`; with the Developer page's change dot, "Show instance panel,
Developer has changes"). They are ordinary buttons in the Main region's tab
order, Show sidebar first and Show instance panel last, each with
`aria-controls` and `aria-expanded="false"`, and their tooltips name the live
chord. Focus follows them: hiding the sidebar with focus in it moves focus to
Show sidebar; closing the panel with focus in it moves focus to Show instance
panel; opening the panel with that button moves focus to the panel's selected
tab; a chord pressed in a terminal opens or closes either and leaves focus in
the terminal. Entering focus mode is the exception: focus that was in the
sidebar goes to the active tab, the content focus mode is for. Opening an instance's terminal never opens the panel: whether it
is open is the user's, kept on this computer, and it starts closed. While a modal
dialog or the palette is open, F6 and the tab switches (Ctrl+Tab, Alt+→/←,
go to tab) do nothing; the dialog keeps focus.

Tab switches from the keyboard (Ctrl+Tab, Alt+→, go to tab) keep focus in
the new tab's content when it was in content, and on the strip when it was on
the strip. Whenever another terminal tab becomes active (any of these, a click
or an arrow on the strip, a close's successor, a pane of another split group),
and on a click on the tab that is already active, its roster row reads as
selected and the roster scrolls just enough to show it, without taking focus.
It does not scroll while the sidebar is hidden or in focus mode; under a collapsed parent it shows the nearest visible
ancestor's row and leaves the parent collapsed. A stage switch from a chord, the palette or a nav button leaves
focus where it was when that is still shown, else on the stage's first
control.

## The command palette (⌘K)

- **⌘K / Alt+K** opens the palette: the sidebar's tree, in the modal,
  ordered by last focus. Every instance of the window's workspace is listed
  once, in the sidebar's deployment sections, relation groups and runs of
  independent instances, indented by depth (the sidebar's collapsed state is
  ignored). Then up to twelve commands. `>` restricts to commands.
- **The order is last focus.** An instance is focused when its tab becomes the
  active tab, by any path, or its terminal takes keyboard focus. At every level
  a node sits where the most recently focused instance of its subtree puts it:
  a relation cluster or a single instance by its most recent member, a
  cluster's roots and each parent's children the same way, and, with several
  deployments, each deployment's section by its most recent instance. So a
  child focused after its parent lifts the parent's group and the parent above
  its siblings. A child always stays under its parent. Under one parent, the
  children its line joins come first (#1577, below) and the rest after them,
  and focus orders each part on its own: a child the line does not join stays
  after the joined ones however recently it was focused. Instances never focused
  keep the sidebar's order (name), after the rest of their part; with no record
  at all the palette lists exactly the sidebar's order. Groups form again after ordering
  by the sidebar's rule, so an instance focused a minute ago is not held behind
  a stale run of independent ones. The sidebar roster keeps its stable name
  order; only the palette is ordered by focus.
- **The palette opens on its first row.** With an empty query the active row
  is the top of the list: by the order above, the root of the most recently
  focused path. ⌘K again moves down from there. (Until #1391 it opened on the
  agent you were on before, often a row in the middle of the list.)
- The focus record is per machine: one `localStorage` key
  (`oats-desktop-instance-recency`), keyed by workspace and by the instance's
  exact identity (the terminal tab's key), the 200 most recent per workspace.
  It survives a restart and is never written to a deployment or sent to the
  server. A missing or corrupt value reads as empty; an entry for an instance
  no longer in the roster is not listed.
- **With a query** each match is listed with its non-matching ancestors shown
  dimmed for context, in the same order as the unfiltered list: the order is
  decided on the full roster and the query only decides which rows show, so a
  group's place never changes while you type. A match stays in its relation
  group, as in the sidebar: one match out of a group of five is listed
  under that group's name, not under independent. The active row is the first
  match. A context row is `aria-disabled`: the arrows, the chord and the pointer
  skip it, and it opens nothing.
- **The rows look like the sidebar's.** Each instance row draws the sidebar's
  connectors, from the sidebar's own code (`treeConnectors` and its DOM builder
  `treeGuides`, `renderer/instance-tree-view.mjs`, and the same `.ctx-guide`
  rules): the dotted line joining the roots of one group (sibling links) on the
  dot column, and the solid parent→child elbows and pass-throughs to its right.
    As the sidebar's order does (the sidebar itself draws no lines since slice 1
  of the Desktop UI rework), a solid line joins only a child that draws its parent line
  (`drawsParentLine`, `packages/client/same-work.mjs`, #1577), and those
  children are listed first under their parent, by recency within each part.
  Its dot is the sidebar's state dot: running, stopped or unknown. A context row
  keeps its lines; only its text is dimmed.
- **Relations in words.** A nested row's option reads "…, under <parent>" and an
  instance at either end of an explicit sibling link reads "…, sibling of
    <name>", visually hidden and read once with the option; the lines show both,
  so no relation text is drawn. The sidebar's rows say the same words after
  their two lines. Only direct links within one deployment count,
  and a sibling's name does not match the row.
- **While the palette is open, its own chord cycles**: ⌘K / Alt+K moves
  the active row down, ⇧⌘K / Alt+Shift+K up, both wrapping past the ends
  (under the Ctrl+Shift option, Ctrl+Shift+K down and ArrowUp up).
  Releasing commits nothing: **Enter** opens the active row and **Esc** closes.
  The arrows move too and stop at the ends. The cycle follows a rebind of
  `app.palette`. A chord that already holds Shift (a rebind to Ctrl+Shift+K,
  say) has no Shift form, so ArrowUp moves up there. A plain-key binding never
  cycles: typing belongs to the input. Quick Open's chord does not cycle: a
  second ⌘P / Alt+P closes it.
- **While the palette is open, its group keys jump between groups**: ⌘N /
  Alt+Shift+↓ moves the active row to the first row of the next group, ⌥⌘N /
  Alt+Shift+↑ to the first row of the group before, both wrapping past the
  ends. A group is a relation group (named by its deployment where there are
  several); the commands after the instances are one more. The move lands on a
  group's first selectable row, past its context rows, and passes over a group
  with none; with a single group both keys go to its first row. Nothing commits
  until **Enter**. They are the palette's own keys (`PALETTE_KEYS` in
  `packages/client/keymap.mjs`, read by `paletteGroupDirection`), not bindings:
  the shortcuts editor does not list them and no rebind moves them. While the
  palette is open they win over every binding, taken before the keymap engine
  sees them: ⌘N is the palette's there and `app.chooseSoul` everywhere else,
  and Alt+Shift+↓ / ↑ are the palette's there and `roster.openNext` /
  `roster.openPrevious` everywhere else. A footer under the list names them:
  "⌘N next group · ⌥⌘N previous" on macOS, "Alt+Shift+↓ next group ·
  Alt+Shift+↑ previous" elsewhere (`paletteGroupHint`, in the engine's own
  labels), plain text in the dialog and the input's description (`aria-describedby`), read once as the palette opens: the focus stays in the input, so it is never reached otherwise. Quick Open has neither.
- For assistive technology each relation group is a named `role=group`
  (announced once, on entry); the lines and dots are `aria-hidden`, and the
  relations are read as the words above. Options carry no `aria-level`, which
  is not an option's attribute.

## Quick Open and the spawn dialog

- **⌘P / Alt+P** finds a soul, from a terminal too; picking it opens
  the spawn dialog scoped to that soul, exactly as its card's Spawn does (the
  Workspace stage behind it). A soul
  that can't be spawned here (attached only, refused, no verified CLI) opens
  its soul page instead, which says why. Focus lands on the dialog's first
  field.
- Dismissing the dialog (Cancel, Esc, ×, the backdrop) returns to where the
  operator was before Quick Open: the same tab re-activated (its terminal
  focused when that is where they were), or the same stage and control, else
  that region's current item. If they moved on while the dialog was open (a
  workspace switch, another stage or tab), the return is not forced and the
  dialog restores focus itself. A successful spawn closes the dialog at once and,
  when the instance runs, opens its terminal unless the operator acted since the
  press (a key other than a lone modifier, a paste, a focus move, a navigation) or
  an overlay is open (`docs/desktop-spawn-preview.md`, Background spawn).
- **Focus on open:** the form's first field, the Opening instruction,
  whenever the dialog opens for a chosen soul (a card, the soul page, Quick
  Open, Reopen spawn, a pick in the soul list), without scrolling, with the
  caret at the end of a restored instruction (never selected). Name is optional
  and the form's last field; its section key (Mod+6) reaches it, with the caret
  at the end of a restored name. Quick Open from a tab opens the dialog just before the
  Workspace stage is shown; the first field takes focus once it is, unless the
  operator has focused something else by then.
- **Spawn: Mod+Enter (⌘↵ / Ctrl+Enter) from any field**, the Opening
  instruction and the segmented controls included; plain Enter in Name does
  not spawn, Enter or Space on the focused Spawn button does. The button
  shows the effective chord.
- **Tab order** is the visual order: Opening instruction → Deployment (when
  shown) → Harness → Model (its field, then its suggestions button) → Where to
  run (when shown) → Relationship (one stop) → its target when shown → Teams
  (one stop) → Name → Developer settings → (in a narrow window, What will be
  created, below the fields) → (Details, when a problem shows it) → Cancel →
  Spawn, then the header's Change soul and Close. Tab is trapped in the dialog.
- Segmented controls and radio groups are one tab stop: Arrow keys move (and
  choose, in a radio group), Home/End go to the ends (`roveSegment`).
- The Harness and Model pickers open with Enter, Space or Alt+Down and close
  with Escape back on their trigger. Escape closes an open picker first; with
  none open it closes the dialog.
- **Change soul** shows the soul list, focus on the selected soul (the search
  when the filter hides it): a listbox with Arrow/Home/End. Typing on the list
  filters it through its search; Enter in the search picks the best match;
  Enter, Space or a click on a soul picks it. Every pick moves focus to the
  form's first field.
- **Section keys** (Spec E), from any field of the dialog:

  | Section | macOS | Linux / Windows | Lands on |
  |---|---|---|---|
  | Opening instruction (`spawn.jumpTask`) | ⌘1 | Ctrl+1 | the instruction |
  | Harness (`spawn.jumpHarness`) | ⌘2 | Ctrl+2 | the Harness picker |
  | Model (`spawn.jumpModel`) | ⌘3 | Ctrl+3 | the Model field |
  | Relationship (`spawn.jumpRelationship`) | ⌘4 | Ctrl+4 | the selected segment |
  | Teams (`spawn.jumpTeams`) | ⌘5 | Ctrl+5 | the first team that can be ticked (nothing when Teams is not shown) |
  | Name (`spawn.jumpName`) | ⌘6 | Ctrl+6 | the Name field |
  | Developer settings (`spawn.toggleAdvanced`) | ⌘7 | Ctrl+7 | opens it on its first control; again closes it back on its summary |

  The section keys follow the form's order: ⌘1–⌘7 reach the fields in the
  order they are on screen, so the Opening instruction, the form's first
  field, is ⌘1 and Name, its last before Developer settings, ⌘6 (in 0.67.1
  and earlier Name was ⌘1 and the Opening instruction ⌘6; a rebind of either
  is kept, by action id). Where a rebind of yours shares a chord with another section's
  default, yours runs, as everywhere in the keymap. A closed disclosure holding the target opens first. Each chord shows as a
  quiet hint beside its section's label (`aria-hidden`; the control carries
  `aria-keyshortcuts`). They are actions of the `spawn-dialog-local` context
  (`renderer/spawn-dialog-keys.mjs`, with Mod+Enter): the shortcuts editor
  lists them under **Spawn dialog** from the start and they can be rebound,
  but only the open dialog dispatches them. While it is open these chords are
  the dialog's: it stops them, held or not, so ⌘1–⌘3 never switch the stage
  behind the modal. A modal dialog's own context clashes only with itself in
  the editor (`findConflict`), never with a global key it shadows.
- ⌘N / Ctrl+Shift+N goes to Workspace › Souls; it never spawns. (While the
  command palette is open, ⌘N is its next group.)

## Keyboard audit

Walked with the keyboard only (static review of every renderer surface, then
the rig). "Fixed" marks a gap this change closed.

| Element | How it is reached | How it is operated |
|---|---|---|
| List of workspaces (`#ws-list`: a list of buttons, the current one `aria-current`) | One roving stop, the row last focused, else the current row; Tab from the heading's Add; F6 (the first region); `w` in the sidebar, the leader's `o`, ⌥⌘O / Alt+O and the palette's **Workspace: switch…** focus its current row | Up/Down/Home/End move over every row; Enter/Space show the workspace in this window (one another window shows moves here); ⌘Enter (macOS) / Ctrl+Enter (Linux/Windows) opens it in a new window, as the row's description says; the sidebar keys work on a row. The leader's ↑ / ↓, and Alt+↑ / ↓ on Linux and Windows, show the previous / next row from anywhere |
| A row's context menu (`role="menu"`, one item: **Open in new window**) | Shift+F10 or the Menu key on a row, or a right-click; focus on its item | Enter/Space open the workspace in its own window (or bring that window to the front), back on the row; Esc or Tab close it, back on the row |
| Add local workspace… (the **+** at the end of the sidebar's Workspace heading) | Tab (first stop of the sidebar) | Enter/Space open the Add / onboard dialog |
| Add / onboard workspace dialog | From the header's Add, or the chooser's button; opened by itself in a window with no workspace when the Desktop serves none | Each found deployment is a button, then each row of this computer's list that can't be opened (`aria-disabled`, its state in words); one Tab stop among them, Up/Down/Home/End move: Enter/Space on a found one adds it and opens it here; Right Arrow on a row that can't be opened reaches its **Remove**, Left Arrow or Esc go back; Esc elsewhere closes; trapped; returns to what opened it, or to the list after an add |
| Pinned rows, under the list of workspaces (Home, Automations; one under the other, in the roster rows' style; Automations' name says "a run failed" while its red dot shows) | F6 (current item, the second region); Tab; ⌘2 (the Workspace page, under Home's row)/⌘3 (⌘1: Workspace overview on its Machines tab) | Enter/Space |
| Home (the board, the overview, Home › Agents) | Tab through its rows | Enter/Space opens a row (an agent as the roster does; a section on its Workspace tab, whose Esc comes back to Home); in Home › Agents, Esc or **‹ Home** (Back to Home) returns to the board |
| Roster rows | One roving stop, the selected row, else the first; F6; ⌘F / Alt+F (`sidebar.focusFilter`) and the sidebar's `/` land on it; the leader then Esc; Up/Down/Home/End (and the TUI's `k` `j` `g` `G`), PageUp/PageDown by the rows that fit; Right (`l`) expands, Left (`h`) collapses or goes to the parent; the sidebar keys (see "Sidebar keys"). A collapse never moves a row to another group: a root collapsed over its whole group stays under that group's name, and the selected row stays where it is. The list shows no scrollbar (the wheel and the touchpad scroll it): a row that takes keyboard focus (these keys, ⌘F / Alt+F, F6) is revealed whole by scrolling the list alone, never an ancestor | Enter/Space open the terminal (running) or Start (stopped); an arrow chord the keymap binds is the keymap's, so Alt+Shift+↑/↓ (⌥⌘↑/↓) open the terminal of the row above / below, as from anywhere |
| Rows whose state is unknown or that the kernel does not report addressable | **Focusable, `aria-disabled` with the reason as a description (fixed: were `disabled`, which hid their tools from the keyboard)** | Activation does nothing; their context menu works |
| A row's context menu (Open in split, Open pull request…, Knowledge & capabilities…, Start…, Restart with…, Stop…, Retire instance…; Forget… alone on a row its server no longer lists). The row has no ⋯ button | Shift+F10 or the ContextMenu key on the focused row (it opens on the row); a right-click (where you click, once the button is released; the row is not activated) | Focus on its first act; arrows, Home/End move; Enter/Space choose; Esc or Tab close it, back on the row. While it is held (a stale roster, one of its acts still running, a row that can't be used from here) it opens nothing, the focus stays on the row and the line at the bottom of the main area says why |
| Start / Restart dialog, lifecycle dialog | From the row, its context menu, the instance panel or the leader | Esc (Cancel before anything is sent, Close or Done after); trapped; the lifecycle dialog starts on Cancel and focuses Close or Done when it ends; **focus returns to the row (fixed: fell to `<body>`)**, and after a retire to the row that followed it |
| N need you (at the left of the sidebar's foot, a bar named "Sidebar tools"; shown while an agent of this workspace needs input; its name: "2 agents need you. Go to the first") | Tab, after the roster | Enter/Space focus the first row that needs you, in the roster's order, itself: a collapsed parent above it is expanded, or the Background section opened, first; its terminal is not opened |
| New agent (at the right of the sidebar's foot, a + and its words; its chord in its tooltip) | Tab, after N need you; on an empty roster, its one way in: F6, ⌘F / Alt+F (`sidebar.focusFilter`) and the sidebar's `/` land on it (a failed read's Retry first) | Enter/Space run `app.quickOpenSouls` (Quick Open), as its chord does |
| ? (Keyboard shortcuts, at the right end of the sidebar's foot; a red dot while a shortcut you set clashes) | Tab, after New agent | Enter/Space open the shortcuts editor (`app.shortcuts`), as ⌘, / Ctrl+, do |
| Sidebar width (the handle on the sidebar's right edge: a vertical `separator` labelled "Sidebar width", `aria-valuenow`, `-valuemin` and `-valuemax` in px; the split separator's resizer, its hover and focus the accent fill) | Tab, after the foot's ? (the last stop of the sidebar); F6 from it goes on to Main, Shift+F6 back to the roster | ←/→ narrow and widen it by 8px, Shift+←/→ by 32px; Home and End go to 240px and to the most the window allows (480px, or 45% of a narrower window); Enter or a double-click go back to 288px, as **Sidebar: reset width** does; a drag with the pointer. The width is remembered on this computer and kept while the sidebar is hidden |
| Show sidebar (start of the main area's top bar, while the sidebar is hidden or in focus mode) | Tab, first in the Main region; hiding the sidebar moves focus to it | Enter/Space: `sidebar.toggle` (leaves focus mode too), focus back on the roster's current row (on an empty roster, New agent) |
| Tab bar | One roving stop per tablist (per group when split); F6 (main). Tabs shrink to fit (spec F); the active tab is scrolled fully into view in its own strip on every activation, close and strip resize, and a focused control is revealed in its strip, never by scrolling an ancestor | Left/Right/Home/End select; Delete closes the focused tab, and the keymap's `tabs.close` (⌘W / Alt+W, rebindable; the close button's tooltip names it) closes the active one; Ctrl+Tab, Alt+→/← (⌥⌘→/←) and go-to-tab (each tab shows its number) from anywhere in the tab layer, a terminal included, **keeping focus in the content (fixed: fell to `<body>`)** |
| Terminal | Enter on its roster row; F6 (main) | Every key reaches the program except the terminal-allowlisted chords; ⇧⌘F6 / Ctrl+Shift+F6 leaves for the next region; ⌘C / Ctrl+Shift+C copy the selection and ⌘V / Ctrl+Shift+V paste |
| Tab close buttons | Tab | Enter |
| Split right / down (the only buttons after the tabs: closing the split and the instance panel are on their chords and the palette) | Tab (shown for a terminal) | Enter; their chords |
| Split separator | Tab | Arrows resize, Home/End to the ends, **Enter resets to even (fixed: double-click only)** |
| Empty split group | Tab; F6 (main) | Focus selects the group |
| Workspace › Machines: its rows, Retry, Add a machine | First stops of the tab's panel; F6 (main) | Enter |
| The Graph (Home › Graph, the palette's **Workspace: Graph**): its nodes | One roving stop (Tab) | ←/→ between machines, ↑/↓ Home End between a machine's agents; Enter opens the agent as the roster does (Start… when stopped); `m` columns ⇄ one field; `+` (`=`) and `-` zoom, `0` fits; Esc back to Home; **the focused node is panned into view** |
| The Graph's node menu (Open terminal, Details, Open soul, Recent events…) | The menu key, Shift+F10, a right-click | ↑/↓ Home End; Enter; Esc or Tab back to the node |
| The Graph's mode and zoom buttons, a machine's How to fix | Tab | Enter |
| Workspace tabs (Souls, Capabilities, Teams, Machines, Setup) | One roving stop; F6 (main) | Left/Right/Home/End, in that order; Souls is selected first |
| Souls search, Group by | Tab; `/` from the grid | Typing; Enter |
| Souls: **About souls** (the round "i" after Group by) and its dialog | Tab | As About capabilities below |
| Soul cards and their Spawn | One roving stop; the card's Spawn follows it | Arrows; Enter/Space open the soul page; `B` files; Spawn: Enter |
| Teams board cards | One Tab stop per card: its team's name | Enter/Space on the name open the team's page; a click anywhere on the card that is not another control opens it too |
| Soul page, capability page, team page | Opening focuses Back | Esc goes back and restores focus; from a team page, Esc and Back return to the board with focus on that team's name |
| Capability page: Contents navigation (one tree: Instructions, Skills) | One roving stop: the open file, else the focused item | Up/Down move through visible items, Home/End; Right opens a skill, then enters it; Left closes it, or climbs from a file to its skill; Enter/Space open a file or toggle a skill; Esc still goes back |
| Capability page: Contents reader | Tab (a labelled scrollable region) | Arrows/PgUp/PgDn scroll; Enter on a link: a listed file opens in place (and is selected on the left), `https:` opens in the browser, `#heading` scrolls; any other link is plain text |
| Capabilities: Workspace owned's repository pills ("Show capabilities from") | One roving stop: the pressed pill | Left/Right (and Up/Down) move along the pills, wrapping; Home/End go to the ends; Enter/Space choose. Moving never chooses. Focus stays on the same repository's pill when the list repaints |
| Capabilities: Workspace defaults' filled core slots and additional capabilities | Tab (an empty slot and a default the workspace turned off are not stops) | Enter/Space open the capability's page |
| Capabilities: **About capabilities** (the round "i" after the section jump) and its dialog | Tab | Enter/Space open the dialog, a modal with one button, Close; trapped; Esc or Close closes it back on the "i" button; leaving the tab or the workspace closes it |
| Capabilities rows; Setup list/graph; Teams forms; Sync | Tab | Native controls; the sync sheet traps and closes on Esc |
| Automations: its Schedules and Triggers tabs, origin filter, search, on/off switch, rows | Roving tabs; Tab | Native |
| Automations row menu | Tab (its summary) | Enter/Space open; **Esc closes it back on its summary, choosing an item keeps focus on the row, Tab out closes it (fixed: stayed open, focus fell to `<body>`)** |
| New schedule form | New schedule | **A modal dialog with a Tab trap (fixed: Tab walked out behind the scrim)**; Esc closes back on the opener |
| Schedule delete confirm | Its row action | Trapped; Esc |
| Brain: a running instance's heading | **Tab (fixed: a clickable heading, now a button)** | Enter/Space open its terminal |
| Instance panel tabs | F6 (selected tab); roving | Left/Right/Home/End |
| Show instance panel (end of the main area's top bar, while the panel is closed and has something to show) | Tab, last in the Main region; closing the panel moves focus to it | Enter/Space: `panel.toggle`, then focus on the panel's selected tab |
| Panel sections: soul link, copy, details, Open soul page, Teams, Git, lifecycle Restart…/Start…/Stop…/Retire… | Tab | Native buttons and summaries |
| Spawn dialog | Spawn on a card, a soul page, Quick Open | See above |
| Command palette, Quick Open | ⌘K / Alt+K, ⌘P / Alt+P (from a terminal too) | Type, arrows, Enter, Esc; Tab stays in the input; in the palette its chord cycles rows (⇧ + it: up), skipping context rows, and ⌘N / ⌥⌘N (Alt+Shift+↓ / ↑ on Linux/Windows) move to the next / previous group's first row, named in its footer (see "The command palette") |
| Shortcuts editor | ⌘, / Ctrl+, (from a terminal too); focus starts in its search | Its first section, **Most useful**, is a read-only table (each row an action, then its keys) of the palette, Quick Open, the tab moves, tabs 1–9, the workspace moves, the splits, the moves between split panes, close tab, focus mode and the leader then `?`, read from the live keymap: the platform, the chord family and your rebinds as they are, and the leader's key where an action has no chord (the workspace moves in the Ctrl+Alt and Ctrl+Shift families: the leader then ↑ / ↓); a search hides it. Then the list: the **Leader** group comes first (the leader's own row, then one fixed row per key after it), then **Sidebar keys**; typing in the search filters by name, group or keys (`shift+b` and `ctrl shift b` find Ctrl+Shift+B, `ctrl+x k` finds the leader's `k`), and the count is announced; Down enters the rows, Up/Down move between them, Up from the first returns to the search; Tab reaches each row's shortcut and Reset; Enter records, Esc cancels a recording, Backspace unbinds; Esc clears the search, then closes; trapped, the search its first stop. A row shows "terminal" when its shortcut works while a terminal has focus and "changed" when it differs from the default. What has no button in the sidebar is taught by its rows, with no line of their own above them: the command palette is the Leader group's first key (the leader then K or Space) and a Global row (⌘K, Alt+K, Ctrl+Alt+K or Ctrl+Shift+K by the family); Connections, which the settings cog's menu leaves out, is the Global row **Settings: Connections…**, unbound by default and bound from that row; **Quick open a soul to spawn** (the sidebar foot's Spawn instance runs it), **View: Workspace › Machines**, **View: Workspace overview** and **View: Automations** show their chords |
| Settings (Connections, Terminal) | The palette's **Settings: Connections…** | Trapped, through the Terminal size field too; the sign-in terminal has an explicit Shift+Tab exit; the font size stepper's − and + stay focusable at 9 and 28 (aria-disabled) and a typed size applies on Enter or on leaving the field |
| Notifications | Tab (they come last in the document) | Open and Dismiss are buttons; focus moves on after dismissing |

Known limits, left as they are: the overview has no keyboard pan without a
selection (selecting a node pans to it); node dragging is pointer-only and
cosmetic; notifications have no chord of their own.
