/** The keys both clients share: the leader, the table read after it, the plain keys of the list
 * of instances, the chords, and the palette's own keys. Written down once, here; the Desktop and the TUI read their defaults
 * from it (packages/tui/lib/actions.mjs LEADER is LEADER_TABLE, and the TUI's test
 * packages/tui/test/keymap.test.mjs fails on a `does` the TUI does not handle).
 *
 * Pure data and readers: no state, no DOM, no imports. Every value is frozen.
 *
 * Key ids are the TUI's spelling (packages/tui/lib/term/keys.mjs keyId): one character as itself,
 * case kept (`n`, `N`, `|`, `?`, `/`, `-`); named keys `up` `down` `left` `right` `tab` `escape`
 * `space` `enter` `home` `end` `pageup` `pagedown`; modifiers as `ctrl+` / `alt+` / `shift+`
 * prefixes, in that order. A chord adds two: `shift+` with Ctrl or Alt and a letter or an arrow
 * (`ctrl+alt+shift+e`, `alt+shift+up`), and `cmd+`, first, for macOS's Command (`cmd+k`, the
 * Desktop's ⌘K), which a terminal never passes to a program.
 *
 *   leaderKey(isMac)        -> the leader's key id on that platform        "ctrl+x" on both
 *   leaderDoes(key)         -> what the leader then does for a key id, or null
 *   plainKeys(does)         -> the plain key ids of an action (empty when it has none)
 *   leaderRows()            -> LEADER_TABLE
 *   chordKey(does, isMac, family)    -> the chord's key id on that platform and in that family, or null
 *   chordKeyOf(entry, isMac, family) -> the same for a CHORDS row (null where the row has none)
 *   doesLabel(does)         -> an action's label (its LEADER_TABLE row's, else its CHORDS row's), or null
 *   paletteKey(does, isMac) -> the palette's own key id on that platform, or null
 *
 * `does` names an action, not a client's code: each client maps it to its own. Its label, the words a
 * help names it by, is its LEADER_TABLE row's, else its CHORDS row's (`doesLabel`): a CHORDS row carries
 * a label only for an action the leader has no key for. The TUI's help reads it; the Desktop names its
 * actions in its own words (packages/desktop/renderer/leader-keys.mjs). */

/** The leader per platform: Ctrl+X on both, as Emacs has it (#1433). Without the kitty keyboard
 * protocol it is one byte, 0x18, in every terminal; pressed twice it sends that byte to the program
 * (the shell's Ctrl+X Ctrl+E, nano's exit). The Desktop leaves it to Cut in an editable field on
 * Linux and Windows (packages/desktop/docs/desktop-keyboard.md, "The leader"). */
export const LEADER = Object.freeze({ mac: "ctrl+x", other: "ctrl+x" });

/** The keys read after the leader, in the TUI's order, and what each does. `terminal`: named in
 * the hint only while a terminal is open. The leader pressed twice is not here: it is the user's
 * key, and each client says what it does. ↑ and ↓ move to the previous and the next workspace of
 * the sidebar's list (`workspace-previous`, `workspace-next`); the previous and the next instance
 * are the chords' alone (CHORDS `previous`, `next`), which carry their own labels for it. Tab and
 * Shift+Tab go to the next and the previous group of a split, as the chords `group-next` and
 * `group-previous` do. */
export const LEADER_TABLE = Object.freeze([
  { keys: ["k", "space"], does: "palette", label: "palette" },
  { keys: ["1"], does: "instances", label: "instances" },
  { keys: ["2"], does: "souls", label: "souls" },
  { keys: ["3"], does: "capabilities", label: "capabilities" },
  { keys: ["up"], does: "workspace-previous", label: "previous workspace" },
  { keys: ["down"], does: "workspace-next", label: "next workspace" },
  { keys: ["z"], does: "zoom", label: "zoom", terminal: true },
  { keys: ["w"], does: "close-terminal", label: "close terminal", terminal: true },
  { keys: ["left"], does: "tab-previous", label: "previous tab", terminal: true },
  { keys: ["right"], does: "tab-next", label: "next tab", terminal: true },
  { keys: ["|"], does: "split-right", label: "split right", terminal: true },
  { keys: ["-"], does: "split-down", label: "split down", terminal: true },
  { keys: ["tab"], does: "group-next", label: "next group", terminal: true },
  { keys: ["shift+tab"], does: "group-previous", label: "previous group", terminal: true },
  { keys: ["m"], does: "tab-move", label: "move tab", terminal: true },
  { keys: ["x"], does: "group-close", label: "close group", terminal: true },
  { keys: ["X"], does: "stop", label: "stop" },
  { keys: ["R"], does: "restart", label: "restart" },
  { keys: ["S"], does: "start", label: "start" },
  { keys: ["D"], does: "retire", label: "retire" },
  { keys: ["n"], does: "spawn", label: "spawn" },
  { keys: ["N"], does: "spawn-another", label: "spawn another" },
  { keys: ["/"], does: "filter", label: "filter" },
  { keys: ["o"], does: "workspaces", label: "workspaces" },
  { keys: ["?"], does: "help", label: "help" },
  { keys: ["escape"], does: "list", label: "the list" },
].map((row) => Object.freeze({ ...row, keys: Object.freeze([...row.keys]) })));

/** The plain keys both clients read in the list of instances (the TUI's ACTIONS), one entry per action. */
export const PLAIN_KEYS = Object.freeze([
  { does: "up", keys: ["up", "k"] },
  { does: "down", keys: ["down", "j"] },
  { does: "top", keys: ["g", "home"] },
  { does: "bottom", keys: ["G", "end"] },
  { does: "page-up", keys: ["pageup"] },
  { does: "page-down", keys: ["pagedown"] },
  { does: "collapse", keys: ["left", "h"] },
  { does: "expand", keys: ["right", "l"] },
  { does: "filter", keys: ["/"] },
  { does: "refresh", keys: ["r"] },
  { does: "instances", keys: ["1"] },
  { does: "souls", keys: ["2"] },
  { does: "capabilities", keys: ["3"] },
  { does: "workspaces", keys: ["w"] },
  { does: "open", keys: ["enter"] },
  { does: "zoom", keys: ["z"] },
  { does: "close-terminal", keys: ["c"] },
  { does: "tab-previous", keys: ["["] },
  { does: "tab-next", keys: ["]"] },
  { does: "split-right", keys: ["|"] },
  { does: "split-down", keys: ["-"] },
  { does: "stop", keys: ["X"] },
  { does: "retire", keys: ["D"] },
  { does: "start", keys: ["S"] },
  { does: "restart", keys: ["R"] },
  { does: "spawn", keys: ["n"] },
  { does: "spawn-another", keys: ["N"] },
  { does: "help", keys: ["?"] },
].map((entry) => Object.freeze({ ...entry, keys: Object.freeze([...entry.keys]) })));

/** The chords: one key that does what the leader then a key does, from every focus, the same in
 * both clients, per platform (`mac`) and, on Linux and Windows, per chord family (`alt`, `other`,
 * `shift`: CHORD_FAMILIES). Three have no leader key: `previous` and `next` (the previous / next
 * instance, whose `label` is here, since no LEADER_TABLE row names them) and `edit-instance`. The
 * Desktop's DEFAULT_KEYMAP reads these entries from here (CHORDS_READ, docs/desktop-keyboard.md); the
 * TUI binds the family's ones, and the `mac` ones without `cmd+`, from every focus (docs/tui.md,
 * "Chords"). The leader stays the key that always works: help, the views and the acts (stop,
 * restart, start, retire) are reached by it alone.
 *
 * `alt`, the default family (the product owner's call, 2026-10-22; the maintainer's defaults, f592e979): Alt with
 * a letter or a digit for an action, Alt with an arrow to move between tabs (←/→) and workspaces
 * (↑/↓), Alt+Shift with an arrow between groups (←/→) and instances (↑/↓). These take keys a program
 * in a terminal reads (readline's M-b, M-f and M-digit, an agent's Alt+P); the program still gets
 * each from Esc, then the key, or the user picks Ctrl+Alt (docs/desktop-keyboard.md, the collision
 * table). Alt+letter is ESC then the letter in every terminal, and an Alt arrow has a sequence of its
 * own (`CSI 1;3A`, `CSI 1;4A` with Shift), so all of them reach the TUI with or without the kitty
 * keyboard protocol. A row without an `alt` key keeps its `other` one there.
 *
 * `other`, the Ctrl+Alt family, the option for whoever needs Alt in their programs: Ctrl+Alt with a
 * letter or a digit for an action and Alt+Shift with an arrow to move. It leaves Alt alone, the Alt
 * arrows included: the workspace moves have no chord there (`other: null`, and none in `shift`),
 * so Alt+↑/↓ reach the program in a terminal; the leader's ↑/↓ move between workspaces in every
 * family. A Ctrl+Alt chord reaches the TUI only under the kitty keyboard protocol (ESC then Ctrl+K
 * is what Ctrl+Alt+K sends without it). Its keys are those from before the Alt family, and the
 * previous group, whose Alt+Shift+← is the previous tab's here, is Ctrl+Alt+Shift+A, the next
 * group's Ctrl+Alt+A with Shift.
 *
 * `shift` is the row's key in the Ctrl+Shift family, the option a user picks in keys.json
 * (packages/client/keys-file.mjs) for a terminal that passes Ctrl+Shift apart from Ctrl: foot and
 * Alacritty (docs/tui.md, "Which family for my terminal"). Seven rows move (K palette, P spawn,
 * S workspaces, M zoom, W close, E split right, D split down: the maintainer's cut, a43470ce); the
 * others keep their `other` key: the Alt+Shift arrows, since Ctrl+Shift+arrow selects text in
 * inputs and editors; Ctrl+Alt+1–9, since Ctrl+Shift+digit is a shifted symbol on most layouts;
 * the groups and filter, whose Ctrl+Shift A and F a terminal or an agent takes; and edit-instance.
 *
 * On macOS there is no family and `mac` is the only key. The letters and digits are held by ⌘ (⌘⌥
 * for the rows new in phase 3), and the moves between tabs, groups and workspaces by ⌥ with an arrow
 * (the product owner's call, 2026-10-23): ⌥←/→ the tabs, ⌥⇧←/→ the groups, ⌥↑/↓ the workspaces; ⌥⌘↑/↓ stay the
 * instances. ⌥ with a letter or a digit types a character on many layouts (⌥2 is @ on a Spanish
 * one), so no row takes it. ⌥←/→ are the word moves of macOS text fields and of a shell in a
 * terminal: the clients give way in an editable field (docs/desktop-keyboard.md), and the TUI,
 * which binds the `mac` keys without `cmd+`, reads them from every focus. `tab-N` shows the Nth tab
 * of the focused group, `tab-9` its last. The Desktop's Ctrl+Tab, Ctrl+1/2/3 (the stages) and Ctrl+, are the Desktop's own and are
 * not here. */
export const CHORDS = Object.freeze([
  { does: "palette", mac: "cmd+k", alt: "alt+k", other: "ctrl+alt+k", shift: "ctrl+shift+k" },
  { does: "spawn", mac: "cmd+p", alt: "alt+p", other: "ctrl+alt+p", shift: "ctrl+shift+p" },
  { does: "workspaces", mac: "cmd+alt+o", alt: "alt+o", other: "ctrl+alt+o", shift: "ctrl+shift+s" },
  { does: "previous", mac: "cmd+alt+up", other: "alt+shift+up", label: "previous instance" },
  { does: "next", mac: "cmd+alt+down", other: "alt+shift+down", label: "next instance" },
  // The Alt family's alone on Linux and Windows: the others leave Alt+↑/↓ to the program.
  { does: "workspace-previous", mac: "alt+up", alt: "alt+up", other: null, shift: null },
  { does: "workspace-next", mac: "alt+down", alt: "alt+down", other: null, shift: null },
  { does: "tab-previous", mac: "alt+left", alt: "alt+left", other: "alt+shift+left" },
  { does: "tab-next", mac: "alt+right", alt: "alt+right", other: "alt+shift+right" },
  ...Array.from({ length: 9 }, (_, i) => ({ does: `tab-${i + 1}`, mac: `cmd+alt+${i + 1}`, alt: `alt+${i + 1}`, other: `ctrl+alt+${i + 1}` })),
  { does: "zoom", mac: "cmd+alt+z", alt: "alt+z", other: "ctrl+alt+z", shift: "ctrl+shift+m" },
  { does: "close-terminal", mac: "cmd+w", alt: "alt+w", other: "ctrl+alt+w", shift: "ctrl+shift+w" },
  { does: "split-right", mac: "cmd+\\", alt: "alt+e", other: "ctrl+alt+e", shift: "ctrl+shift+e" },
  { does: "split-down", mac: "cmd+shift+\\", alt: "alt+shift+e", other: "ctrl+alt+shift+e", shift: "ctrl+shift+d" },
  { does: "group-previous", mac: "alt+shift+left", alt: "alt+shift+left", other: "ctrl+alt+shift+a" },
  { does: "group-next", mac: "alt+shift+right", alt: "alt+shift+right", other: "ctrl+alt+a" },
  { does: "filter", mac: "cmd+f", alt: "alt+f", other: "ctrl+alt+f" },
  // The Desktop's alone for now (#1421): its name and colour dialog. No leader key; the TUI has no
  // such action, so it binds no key for it (chordKeys skips a `does` it does not handle). Not one of
  // the seven the Ctrl+Shift family moves: Ctrl+Alt+R in both of those (the maintainer's ruling).
  { does: "edit-instance", mac: "cmd+alt+r", alt: "alt+r", other: "ctrl+alt+r" },
].map((entry) => Object.freeze({ ...entry, alt: entry.alt ?? entry.other, shift: entry.shift ?? entry.other })));

/** The palette's own keys, read only while the palette is open: there they win over every binding
 * (the Desktop's ⌘N, `app.chooseSoul`; the chords `previous` and `next`), so they are not CHORDS,
 * which are bound from every focus. The selection goes to the first row of the next group, or of
 * the one before, and wraps (docs/tui.md, "The palette"; packages/desktop/docs/desktop-keyboard.md).
 * On macOS the TUI has none: a terminal never passes ⌘. The previous group is ⌥⌘N, not ⇧⌘N: that is
 * the Desktop's File → New Window, a key its menu shows, which the palette does not shadow. */
export const PALETTE_KEYS = Object.freeze([
  { does: "palette-next-group", mac: "cmd+n", other: "alt+shift+down" },
  { does: "palette-previous-group", mac: "cmd+alt+n", other: "alt+shift+up" },
].map((entry) => Object.freeze({ ...entry })));

/** The chord families on Linux and Windows: the default, Alt, and the two options (CHORDS `alt`,
 * `other` and `shift`), with the name a client shows for each. A user who never chose binds the
 * default; one who chose Ctrl+Alt keeps it (keys.json `chords`, packages/client/keys-file.mjs). */
export const CHORD_FAMILIES = Object.freeze(["alt", "ctrl+alt", "ctrl+shift"]);
export const DEFAULT_CHORD_FAMILY = "alt";
export const CHORD_FAMILY_LABELS = Object.freeze({ alt: "Alt", "ctrl+alt": "Ctrl+Alt", "ctrl+shift": "Ctrl+Shift" });

const NONE = Object.freeze([]);

/** The leader's key id on macOS (`true`) or elsewhere. */
export function leaderKey(isMac) {
  return isMac ? LEADER.mac : LEADER.other;
}

/** What the leader then does for `keyId`, or null when the table has no such key. */
export function leaderDoes(keyId) {
  for (const row of LEADER_TABLE) if (row.keys.includes(keyId)) return row.does;
  return null;
}

/** The plain key ids of the action `does`, frozen; empty when it has none. */
export function plainKeys(does) {
  return PLAIN_KEYS.find((entry) => entry.does === does)?.keys ?? NONE;
}

/** The leader's table, LEADER_TABLE itself. */
export function leaderRows() {
  return LEADER_TABLE;
}

/** The key id of the CHORDS row `entry` on macOS (`true`) or elsewhere, in `family` (CHORD_FAMILIES;
 * anything else is the default, Alt), which macOS ignores; null where the row has no key (the
 * workspace moves outside the Alt family). */
export function chordKeyOf(entry, isMac, family = DEFAULT_CHORD_FAMILY) {
  if (isMac) return entry.mac ?? null;
  return (family === "ctrl+shift" ? entry.shift : family === "ctrl+alt" ? entry.other : entry.alt) ?? null;
}

/** The key id of the chord that does `does` on macOS (`true`) or elsewhere, in `family` (chordKeyOf),
 * or null when none does there. */
export function chordKey(does, isMac, family = DEFAULT_CHORD_FAMILY) {
  const entry = CHORDS.find((each) => each.does === does);
  return entry === undefined ? null : chordKeyOf(entry, isMac, family);
}

/** The label of the action `does`: its LEADER_TABLE row's, else its CHORDS row's, else null (an action
 * no table names in words, such as `edit-instance`, or none). */
export function doesLabel(does) {
  return LEADER_TABLE.find((row) => row.does === does)?.label ?? CHORDS.find((entry) => entry.does === does)?.label ?? null;
}

/** The key id of the palette's own key that does `does` on macOS (`true`) or elsewhere, or null. */
export function paletteKey(does, isMac) {
  const entry = PALETTE_KEYS.find((each) => each.does === does);
  return entry === undefined ? null : isMac ? entry.mac : entry.other;
}
