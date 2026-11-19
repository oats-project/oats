// The action table: what the TUI can do and the keys that do it. The reducer and the help view
// both read it, so the help cannot name a key the program does not act on. `keys` are key ids
// (term/keys.mjs keyId); they are the part a user's tui.json replaces (config.mjs), so everything
// that acts on a key or names one reads the EFFECTIVE table it is handed, never this constant.
// An action that does one thing in the list of instances and another in the switcher (`open`)
// says so in `views`: what it does in each, in the order the help lists them. An action of one
// view only (the four acts) names that view, so the help says where it acts.
// The keys the TUI shares with the Desktop are not written here: an action with no `keys` of its own
// takes its default keys from the shared keymap (packages/client/keymap.mjs PLAIN_KEYS), and the
// leader's table is the shared one (LEADER, below). What only the TUI has (q, Ctrl+C, Ctrl+Z, Ctrl+L,
// Ctrl+K, Tab, Esc, Delete, C, i, p) keeps its keys here. packages/tui/test/keymap.test.mjs pins both.
import { CHORDS, DEFAULT_CHORD_FAMILY, LEADER_TABLE, PALETTE_KEYS, chordKeyOf, plainKeys } from "./client.mjs";
// An action's words, for the help (views/help.mjs): a view takes the shared home's keymap through this module only.
export { doesLabel } from "./client.mjs";
import { legacyChord } from "./term/kitty.mjs";
import { isBackKey } from "./term/through.mjs";

export const ACTIONS = Object.freeze([
  { id: "up", label: "up" },
  { id: "down", label: "down" },
  { id: "top", label: "first" },
  { id: "bottom", label: "last" },
  { id: "page-up", label: "page up" },
  { id: "page-down", label: "page down" },
  { id: "collapse", label: "collapse, or go to the parent" },
  { id: "expand", label: "expand, or go to the first child" },
  { id: "detail", keys: ["tab"], label: "detail" },
  { id: "filter", label: "filter" },
  { id: "refresh", label: "refresh" },
  // The views by their number. The sidebar names the views, each with its key at the right of its row
  // (docs/tui.md, "What it shows"): the digits are named here, so in the help and the sidebar.
  { id: "instances", label: "instances" },
  { id: "souls", label: "souls" },
  { id: "capabilities", label: "capabilities" },
  { id: "workspaces", label: "workspaces" },
  // The palette (docs/tui.md, "The palette"): from every focus it is the leader and then `k`.
  { id: "palette", keys: ["ctrl+k"], label: "palette" },
  { id: "open", label: "open", views: [["instances", "open the selected agent's terminal as a tab beside the list, or show its tab when it has one, in the list of instances"], ["switcher", "open the selected workspace, in the switcher"], ["souls", "show the selected soul's detail, and from the detail its instances, in the Souls view"], ["capabilities", "show the selected capability's detail, and from the detail the marked soul that uses it, in the Capabilities view"]] },
  // The switcher's Remove (docs/tui.md, "The switcher"; awebai/oats#1390): a row of this computer's
  // deployments list, after a confirmation; nothing on disk is touched. Delete, and no letter: a new
  // default key that a user's tui.json already gives to another action would make that file refused
  // at the start (config.mjs claims every default first), and the free letters are the ones a
  // tui.json is likeliest to use (`x` and `m` among them, see the split below).
  { id: "remove", keys: ["delete"], label: "remove", views: [["switcher", "remove the selected row of this computer's list of deployments, after a confirmation; its folder stays"]] },
  // The Souls view (docs/tui.md, "The Souls view"): the selected soul's instances, in the
  // Instances view, filtered by that soul.
  { id: "soul-instances", keys: ["i"], label: "instances", views: [["souls", "the selected soul's instances, in the Instances view"]] },
  // The open terminal, from the list (docs/tui.md, "Open an agent's terminal"). While the terminal
  // has the focus the TUI takes no key but the leader (tui.json's open.detachKey), so neither of
  // these is ever read there: the leader's table has its own (LEADER).
  { id: "zoom", label: "zoom", views: [["instances", "go to the shown terminal with the whole screen; the leader then Esc brings the list back"]] },
  { id: "close-terminal", label: "close terminal", views: [["instances", "close the shown terminal and show its neighbour; the agent keeps running"]] },
  { id: "tab-previous", label: "previous tab", views: [["instances", "show the terminal of the tab before the shown one"]] },
  { id: "tab-next", label: "next tab", views: [["instances", "show the terminal of the tab after the shown one"]] },
  // The split (docs/tui.md, "Splits"): two groups of tabs at most, side by side or one above the
  // other. `group-next`, `group-previous`, `tab-move` and `group-close` have no key of their own
  // here by default (Tab is the detail's, and `m` and `x` are often a tui.json's): the leader's are.
  // With two groups at most, the previous group is the other one, as the next is: `group-previous`
  // is the shared table's own row (the Desktop's splits have more), and does what `group-next` does.
  { id: "split-right", label: "split right", views: [["instances", "split the panel side by side; the new group, on the right, is empty and focused"]] },
  { id: "split-down", label: "split down", views: [["instances", "split the panel one above the other; the new group, below, is empty and focused"]] },
  { id: "group-next", keys: [], label: "next group", views: [["instances", "go to the other group's terminal, or to the focused group's from the list"]] },
  { id: "group-previous", keys: [], label: "previous group", views: [["instances", "the same as next group: a split has two groups"]] },
  { id: "tab-move", keys: [], label: "move tab", views: [["instances", "move the shown tab to the other group, and go there"]] },
  { id: "group-close", keys: [], label: "close group", views: [["instances", "close the focused group while it is empty"]] },
  // The four acts on an instance: each opens a confirmation, and nothing is done before a move and
  // a press in it. Capitals: a lower-case key is one slip away, a capital takes Shift.
  { id: "stop", label: "stop", views: [["instances", "stop the selected agent, after a confirmation"]] },
  { id: "retire", label: "retire", views: [["instances", "retire the selected agent, after a confirmation"]] },
  { id: "start", label: "start", views: [["instances", "start the selected agent as it was last launched, after a confirmation"]] },
  { id: "restart", label: "restart", views: [["instances", "restart the selected agent as it was last launched, after a confirmation"]] },
  // A spawn (docs/tui.md, "Spawning an agent"): a prompt over the list, the soul picked, the
  // shared preview, and one Enter. Only on this machine's workspace, one spawn at a time.
  { id: "spawn", label: "spawn", views: [["instances", "spawn an agent: pick its soul, then the preview, and Enter spawns it"], ["souls", "spawn an agent of the selected soul: the preview, and Enter spawns it"]] },
  { id: "spawn-another", label: "spawn another", views: [["instances", "spawn another agent of the selected agent's soul: the preview, and Enter spawns it"], ["souls", "the same as n"]] },
  // Offered only while a spawn's outcome is not known: it asks the kernel once, never spawns again.
  { id: "spawn-check", keys: ["C"], label: "check spawn", views: [["instances", "check the result of a spawn whose outcome is not known, while one is"]] },
  // Pinned instances (feature instance-pin; docs/tui.md, "Pinning"): at once, no confirmation (a pin only orders the
  // list, and the same key undoes it). `p` is a new default key: a tui.json that gives it to another action is
  // refused at the start with the line that says so (config.mjs), until that action moves or pin gets another key.
  // Lower-case, unlike the four acts above: it opens no confirmation and changes nothing but the order. Its help
  // line fits one row of the help: the shared pin and the feature's line are in docs/tui.md and on the status line.
  { id: "pin", keys: ["p"], label: "pin", views: [["instances", "pin the selected agent at the top of its list or unpin it, as oats instance pin <name> on|off; needs instance-pin"]] },
  { id: "help", label: "help" },
  { id: "close", keys: ["escape"], label: "close" },
  { id: "quit", keys: ["q", "ctrl+c"], label: "quit" },
  { id: "suspend", keys: ["ctrl+z"], label: "suspend" },
  { id: "redraw", keys: ["ctrl+l"], label: "redraw" },
].map(({ keys, ...action }) => Object.freeze({ id: action.id, keys: Object.freeze([...(keys ?? plainKeys(action.id))]), ...action, ...(action.views ? { views: Object.freeze(action.views.map((view) => Object.freeze([...view]))) } : {}) })));

/** THE LEADER'S TABLE (docs/tui.md, "The leader"): the keys read after the leader (tui.json's
 *  open.detachKey) and what each does, from every focus. It is the shared one, the Desktop's too
 *  (packages/client/keymap.mjs LEADER_TABLE), in its order, with its labels and its `terminal`
 *  rows, which do nothing without a terminal open. Nothing is drawn while the leader waits: the
 *  help lists the table (views/help.mjs). Fixed: tui.json's
 *  `keys` rebinds the plain keys of ACTIONS only. Each `does` is handled by the TUI
 *  (leaderHandles); the leader pressed again is not in the table, as it is the user's key: from the
 *  open terminal's focus it types the leader's own bytes into the agent, the focus staying there,
 *  and from any other focus it only cancels the leader (lib/store.mjs `twice`). */
export const LEADER = LEADER_TABLE;
/** What the leader does that no action of ACTIONS does (lib/store.mjs `led`): `workspace-previous`
 *  and `workspace-next` (the workspace before or after the open one in the list of workspaces) and
 *  `list` (the list's focus, which Esc gives). */
export const LEADER_OWN = Object.freeze(["workspace-previous", "workspace-next", "list"]);
/** What a chord does that neither the leader's table nor an action does (lib/store.mjs `led`):
 *  `tab-1` to `tab-8`, the focused group's Nth tab shown, and `tab-9`, its last (as the Desktop and
 *  the browsers do). No key after the leader does them: LEADER has no row for them. */
export const CHORD_OWN = Object.freeze(Array.from({ length: 9 }, (_, i) => `tab-${i + 1}`));
/** The chords' moves between instances, which no key after the leader does either (the leader's Up
 *  and Down move between workspaces): `previous` and `next`, the instance before or after the shown
 *  terminal's, or the selection's, its tab shown, or opened as a new one, with the focus in it. */
export const CHORD_MOVES = Object.freeze(["previous", "next"]);
/** Whether the TUI acts on `does`, a `does` of the shared leader table or of the chords: it is one
 *  of the leader's own (LEADER_OWN), of the chords' own (CHORD_OWN), or the id of an action of
 *  ACTIONS, which lib/store.mjs `led` runs as its key runs it, or in its own way from the leader
 *  (the terminal's keys, the acts, the spawns). A `does` the TUI does not handle is a failure of
 *  packages/tui/test/keymap.test.mjs or chords.test.mjs, never a key that does nothing. */
export const leaderHandles = (does) => LEADER_OWN.includes(does) || CHORD_OWN.includes(does) || CHORD_MOVES.includes(does) || ACTIONS.some((action) => action.id === does);
/** key id -> what the leader then does (LEADER's `does`). */
export const LEADER_KEYS = new Map(LEADER.flatMap((entry) => entry.keys.map((key) => [key, entry.does])));

/** THE CHORDS (docs/tui.md, "Chords"): key id -> `does`, the shared ones (packages/client/keymap.mjs
 *  CHORDS) on macOS (`isMac`) or elsewhere, in the table's order, each doing what the leader then
 *  its key does, or a tab by its place (CHORD_OWN; lib/store.mjs `led`), from every focus. Each
 *  row's key is the one of `family` (keymap.mjs chordKeyOf: CHORD_FAMILIES, keys.json's `chords`,
 *  lib/config.mjs loadKeys): `alt`, the default, binds the `alt` keys; `ctrl+alt` the `other`
 *  ones; `ctrl+shift` the `shift` ones (seven rows move, the others keep their `other` key); macOS
 *  ignores it. A key is the TUI's key id (tuiChordKey): Alt+Shift with a letter is `alt+E`, as a
 *  terminal sends it. Left out: a row with no key there (a `null` key: the Ctrl+Alt and Ctrl+Shift
 *  families leave the workspace moves to the program, and none is borrowed from another family), a
 *  chord with `cmd+` (a terminal never passes macOS's Command to a program: with the shared table
 *  that is every chord of macOS but the six ⌥ arrows), one whose key an action of `actions` binds (a user's tui.json keeps its
 *  key, row by row, whichever the family), one whose key is `leader` (the leader's key id, null for
 *  none: a tui.json's open.detachKey M-o is Alt+O, and the leader wins, in the list and in a
 *  terminal), and one whose `does` the TUI does not handle (leaderHandles: a row may be the
 *  Desktop's alone): packages/tui/test/chords.test.mjs. `chords` is the shared table. Which of them
 *  are read depends on the kitty keyboard protocol (chordsRead). */
export function chordKeys(isMac, actions = ACTIONS, chords = CHORDS, family = DEFAULT_CHORD_FAMILY, leader = null) {
  const bound = new Set(actions.flatMap((action) => action.keys));
  return new Map(chords.map((entry) => [chordKeyOf(entry, isMac, family), entry.does])
    .filter(([key]) => key !== null && !key.startsWith("cmd+")).map(([key, does]) => [tuiChordKey(key), does])
    .filter(([key, does]) => !bound.has(key) && key !== leader && leaderHandles(does)));
}

/** A shared chord's key (keymap.mjs's spelling) as the TUI's key id (term/keys.mjs keyId): Alt+Shift
 *  with a letter is `alt+E`, the capital after ESC that a terminal sends for it; every other key is
 *  spelled the same in both. */
export const tuiChordKey = (key) => (/^alt\+shift\+[a-z]$/.test(key) ? `alt+${key.at(-1).toUpperCase()}` : key);

/** THE PALETTE'S OWN KEYS (docs/tui.md, "The palette"): key id -> `does`, the shared ones
 *  (packages/client/keymap.mjs PALETTE_KEYS) on macOS (`isMac`) or elsewhere, in the table's order:
 *  `palette-next-group` and `palette-previous-group`, the first row of the next group or of the one
 *  before. Read only while the palette is open, and there before every other key: the chords that
 *  share a key (Alt+Shift+Down is the chord `next` too) and the palette's own (lib/store.mjs
 *  `leading` hands them on, and inPalette reads them first). Left out: a key with `cmd+` (a
 *  terminal never passes macOS's Command to a program: with the shared table that is both of
 *  macOS's, so the macOS TUI has none). Fixed, as the palette's Up and Down are: tui.json's `keys`
 *  rebinds the plain keys of ACTIONS only. On Linux and Windows each is an Alt+Shift arrow, read
 *  with or without the kitty keyboard protocol (term/kitty.mjs LEGACY_CHORDS). `table` is the
 *  shared table. */
export function paletteKeys(isMac, table = PALETTE_KEYS) {
  return new Map(table.map((entry) => [isMac ? entry.mac : entry.other, entry.does]).filter(([key]) => !key.startsWith("cmd+")));
}

/** The chords of `chords` (chordKeys) the TUI reads while the terminal confirms the kitty keyboard
 *  protocol (`kitty`) or not: all of them under it; without it those whose bytes are their own
 *  (term/kitty.mjs legacyChordText): every chord of the Alt family (Alt with a letter or a digit is
 *  ESC and the character, an Alt arrow `CSI 1 ; 3 A`, an Alt+Shift one `CSI 1 ; 4 A`), and the
 *  arrow chords of the other two. A Ctrl+Alt chord without the protocol is the bytes of two
 *  keys (ESC, then Ctrl+K), the agent's, and in the list no key. A Ctrl+Shift one is Ctrl and its
 *  letter's byte, the same as Ctrl alone (Ctrl+Shift+D is 0x04, EOF; Ctrl+Shift+M is 0x0d, Enter):
 *  never a chord, the agent's in its terminal and the list's key in the list (term/kitty.mjs kittyId
 *  reads one only from the protocol's event). */
export function chordsRead(chords, kitty) {
  return kitty ? chords : new Map([...chords].filter(([key]) => legacyChord(key)));
}

/** key id -> action id. A key bound twice is a defect of the table, refused when it is read. */
export function bindings(actions = ACTIONS) {
  const map = new Map();
  for (const action of actions) for (const key of action.keys) {
    if (map.has(key)) throw new Error(`key ${key} is bound to ${map.get(key)} and to ${action.id}`);
    map.set(key, action.id);
  }
  return map;
}

const NAMES = Object.freeze({ escape: "Esc", enter: "Enter", tab: "Tab", backspace: "Backspace", space: "Space", up: "Up", down: "Down", left: "Left", right: "Right", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", insert: "Insert", delete: "Delete", ctrl: "Ctrl", alt: "Alt", shift: "Shift" });
/** A key id as a person reads it: `ctrl+c` is `Ctrl+C`, `escape` is `Esc`, `?` is `?`, and `alt+E`,
 *  Alt with a capital, is `Alt+Shift+E`, the keys pressed for it. */
export function keyLabel(key) {
  if (key.length === 1) return key;
  if (/^alt\+[A-Z]$/.test(key)) return `Alt+Shift+${key.at(-1)}`;
  const parts = key.split("+"), last = parts.pop();
  const name = NAMES[last] ?? (/^f\d+$/.test(last) ? last.toUpperCase() : parts.length && last.length === 1 ? last.toUpperCase() : last);
  return [...parts.map((part) => NAMES[part] ?? part), name].join("+");
}

/** Key ids as one label, the modifiers they share said once: `alt+shift+up` and `alt+shift+down` are
 *  `Alt+Shift+Up/Down`; keys that share none are each said whole, `/` between them. */
export function keysTogether(keys) {
  const labels = keys.map(keyLabel), shared = labels[0].slice(0, labels[0].lastIndexOf("+") + 1);
  return labels.every((label) => label.startsWith(shared) && label.length > shared.length) ? shared + labels.map((label) => label.slice(shared.length)).join("/") : labels.join("/");
}

/** The modifiers of the back key's grammar (term/through.mjs BACK_KEY) as a person reads them. */
const BACK_MODIFIERS = Object.freeze({ C: "Ctrl", M: "Alt", S: "Shift" });
/** A back key (tui.json's open.detachKey, the leader) as the cheat sheet and the help name it, spelt
 *  for people as keyLabel spells a key id: `C-\\` is `Ctrl+\\`, `C-x` is `Ctrl+X`, `M-o` is `Alt+O`,
 *  `M-5` is `Alt+5`, `F12` is `F12`, `S-F5` is `Shift+F5`. A letter is written as a capital, which
 *  never means Shift (the grammar has lowercase Meta letters only). Pure. A value outside the
 *  grammar is answered as it was given (tui.json refuses it; a view draws it as text from outside). */
export function backKeyLabel(key) {
  if (!isBackKey(key)) return key;
  const [, mod, rest] = /^(?:([CMS])-)?(.+)$/.exec(key);
  const name = rest.length === 1 ? rest.toUpperCase() : rest;
  return mod ? `${BACK_MODIFIERS[mod]}+${name}` : name;
}
