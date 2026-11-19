// The keys the Desktop shares with the TUI (packages/client/keymap.mjs), pinned exactly: the leader
// per platform, the leader's table (rows, order, keys), the plain keys and the chords. A key bound
// twice in any table is a defect and fails here. The TUI reads the same module, and its own test
// (packages/tui/test/keymap.test.mjs) pins that; no Desktop test reads packages/tui.
// The Desktop's defaults for app.leader, every sidebar.key.* and the chords' actions (CHORDS_READ)
// come from the module: a copy of the module with another entry gives a copy of the engine another
// default, and keybindings.mjs holds no literal of its own.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CHORDS_READ, DEFAULT_KEYMAP, DEFAULT_KEYMAPS, SIDEBAR_KEYS, LEADER_CHOICES, defaultBinding, defaultKeymap, chordFromKeyId, parseChord,
  activeChordFamily, setChordFamily, getBinding, onKeymapChange,
} from "../renderer/keybindings.mjs";
import {
  CHORDS, CHORD_FAMILIES, CHORD_FAMILY_LABELS, DEFAULT_CHORD_FAMILY, LEADER, LEADER_TABLE, PALETTE_KEYS, PLAIN_KEYS,
  chordKey, chordKeyOf, leaderKey, leaderDoes, paletteKey, plainKeys, leaderRows, doesLabel,
} from "../../client/keymap.mjs";

test("the leader is Ctrl+X on macOS and elsewhere", () => {
  assert.deepEqual({ ...LEADER }, { mac: "ctrl+x", other: "ctrl+x" });
  assert.ok(Object.isFrozen(LEADER));
  assert.equal(leaderKey(true), "ctrl+x");
  assert.equal(leaderKey(false), "ctrl+x");
});

test("the leader's table: every row, in order, with its keys and what it does", () => {
  assert.deepEqual(LEADER_TABLE.map(({ keys, does, terminal }) => [keys.join(" "), does, !!terminal]), [
    ["k space", "palette", false],
    ["1", "instances", false],
    ["2", "souls", false],
    ["3", "capabilities", false],
    ["up", "workspace-previous", false],
    ["down", "workspace-next", false],
    ["z", "zoom", true],
    ["b", "sidebar", false],
    ["w", "close-terminal", true],
    ["left", "tab-previous", true],
    ["right", "tab-next", true],
    ["| h", "split-right", true],
    ["- v", "split-down", true],
    ["tab", "group-next", true],
    ["shift+tab", "group-previous", true],
    ["m", "tab-move", true],
    ["x", "group-close", true],
    ["X", "stop", false],
    ["R", "restart", false],
    ["S", "start", false],
    ["D", "retire", false],
    ["n", "spawn", false],
    ["N", "spawn-another", false],
    ["/", "filter", false],
    ["o", "workspaces", false],
    ["?", "help", false],
    ["escape", "list", false],
  ]);
  for (const row of LEADER_TABLE) assert.equal(typeof row.label, "string", `${row.does} has a label`);
  // ↑ ↓ move between workspaces; the previous / next instance has no leader key, only its chord.
  assert.deepEqual(LEADER_TABLE.filter((row) => row.keys.includes("up") || row.keys.includes("down")).map(({ keys, does, label }) => [keys.join(" "), does, label]),
    [["up", "workspace-previous", "previous workspace"], ["down", "workspace-next", "next workspace"]]);
  assert.equal(LEADER_TABLE.some((row) => row.does === "previous" || row.does === "next"), false, "no leader row for the instance moves");
  assert.deepEqual([leaderDoes("up"), leaderDoes("down")], ["workspace-previous", "workspace-next"]);
  // Tab and Shift+Tab go to the next and the previous group of a split.
  assert.deepEqual([leaderDoes("tab"), leaderDoes("shift+tab")], ["group-next", "group-previous"]);
  assert.deepEqual(LEADER_TABLE.filter((row) => row.does.startsWith("group-")).map(({ keys, does, label }) => [keys.join(" "), does, label]),
    [["tab", "group-next", "next group"], ["shift+tab", "group-previous", "previous group"], ["x", "group-close", "close group"]]);
});

test("an action's label: its leader row's, else its chord's; only the instance moves carry one in CHORDS", () => {
  assert.deepEqual(CHORDS.filter((entry) => Object.hasOwn(entry, "label")).map(({ does, label }) => [does, label]),
    [["previous", "previous instance"], ["next", "next instance"]]);
  for (const entry of CHORDS) if (Object.hasOwn(entry, "label")) {
    assert.equal(LEADER_TABLE.some((row) => row.does === entry.does), false, `${entry.does}: a chord's label only where no leader row names it`);
  }
  assert.deepEqual(["previous", "next", "workspace-previous", "workspace-next", "group-previous", "group-next", "palette", "tab-next", "edit-instance", "tab-1", "nothing"].map(doesLabel),
    ["previous instance", "next instance", "previous workspace", "next workspace", "previous group", "next group", "palette", "next tab", null, null, null]);
  for (const row of LEADER_TABLE) assert.equal(doesLabel(row.does), row.label, `${row.does}: the leader row's label`);
  // The workspace moves and the previous group have a chord, and a leader row that names them, so
  // their CHORDS rows carry no label.
  for (const does of ["workspace-previous", "workspace-next", "group-previous"]) {
    assert.equal(Object.hasOwn(CHORDS.find((entry) => entry.does === does), "label"), false, `${does}: no label in CHORDS`);
  }
  assert.equal(chordKey("workspace-previous", false), "alt+up", "the workspace moves have a chord in the Alt family");
  assert.equal(chordKey("workspace-previous", false, "ctrl+alt"), null, "and none in Ctrl+Alt");
  assert.equal(chordKey("workspace-next", true), "alt+down", "and ⌥↓ on macOS");
});

test("the plain keys: every action, with its keys", () => {
  assert.deepEqual(PLAIN_KEYS.map(({ does, keys }) => [does, keys.join(" ")]), [
    ["up", "up k"], ["down", "down j"], ["top", "g home"], ["bottom", "G end"],
    ["page-up", "pageup"], ["page-down", "pagedown"], ["collapse", "left h"], ["expand", "right l"],
    ["filter", "/"], ["refresh", "r"], ["instances", "1"], ["souls", "2"], ["capabilities", "3"],
    ["workspaces", "w"], ["open", "enter"], ["zoom", "z"], ["close-terminal", "c"],
    ["tab-previous", "["], ["tab-next", "]"], ["split-right", "|"], ["split-down", "-"],
    ["stop", "X"], ["retire", "D"], ["start", "S"], ["restart", "R"],
    ["spawn", "n"], ["spawn-another", "N"], ["help", "?"],
  ]);
});

// Each row's macOS key, its key in the Alt family (the default) and in the Ctrl+Alt family (`other`).
test("the chords: every one, per platform, and what it does", () => {
  assert.deepEqual(CHORDS.map(({ does, mac, alt, other }) => [does, mac, alt, other]), [
    ["palette", "cmd+k", "alt+k", "ctrl+alt+k"],
    ["spawn", "cmd+p", "alt+p", "ctrl+alt+p"],
    ["workspaces", "cmd+alt+o", "alt+o", "ctrl+alt+o"],
    ["previous", "cmd+alt+up", "alt+shift+up", "alt+shift+up"],
    ["next", "cmd+alt+down", "alt+shift+down", "alt+shift+down"],
    ["workspace-previous", "alt+up", "alt+up", null],
    ["workspace-next", "alt+down", "alt+down", null],
    ["tab-previous", "alt+left", "alt+left", "alt+shift+left"],
    ["tab-next", "alt+right", "alt+right", "alt+shift+right"],
    ["tab-1", "cmd+alt+1", "alt+1", "ctrl+alt+1"],
    ["tab-2", "cmd+alt+2", "alt+2", "ctrl+alt+2"],
    ["tab-3", "cmd+alt+3", "alt+3", "ctrl+alt+3"],
    ["tab-4", "cmd+alt+4", "alt+4", "ctrl+alt+4"],
    ["tab-5", "cmd+alt+5", "alt+5", "ctrl+alt+5"],
    ["tab-6", "cmd+alt+6", "alt+6", "ctrl+alt+6"],
    ["tab-7", "cmd+alt+7", "alt+7", "ctrl+alt+7"],
    ["tab-8", "cmd+alt+8", "alt+8", "ctrl+alt+8"],
    ["tab-9", "cmd+alt+9", "alt+9", "ctrl+alt+9"],
    ["zoom", "cmd+alt+z", "alt+z", "ctrl+alt+z"],
    ["close-terminal", "cmd+w", "alt+w", "ctrl+alt+w"],
    ["split-right", "cmd+\\", "alt+e", "ctrl+alt+e"],
    ["split-down", "cmd+shift+\\", "alt+shift+e", "ctrl+alt+shift+e"],
    ["group-previous", "alt+shift+left", "alt+shift+left", "ctrl+alt+shift+a"],
    ["group-next", "alt+shift+right", "alt+shift+right", "ctrl+alt+a"],
    ["filter", "cmd+f", "alt+f", "ctrl+alt+f"],
    ["edit-instance", "cmd+alt+r", "alt+r", "ctrl+alt+r"],
    ["mail", "cmd+alt+m", "alt+m", "ctrl+alt+m"],
  ]);
  assert.ok(Object.isFrozen(CHORDS) && CHORDS.every((entry) => Object.isFrozen(entry)));
  assert.equal(new Set(CHORDS.map((entry) => entry.does)).size, CHORDS.length, "one chord per action");
  // No key twice on macOS nor in any family (where a row may have none: the workspace moves outside Alt).
  for (const column of ["mac", "alt", "other", "shift"]) {
    const keys = CHORDS.map((entry) => entry[column]).filter((key) => key !== null);
    assert.equal(new Set(keys).size, keys.length, `${column}: no chord twice`);
  }
  assert.deepEqual(CHORDS.filter((entry) => entry.mac === null).map((entry) => entry.does), [], "every row has a macOS key");
  assert.deepEqual(CHORDS.filter((entry) => entry.other === null || entry.shift === null).map((entry) => entry.does), ["workspace-previous", "workspace-next"],
    "only the workspace moves have none outside the Alt family");
  assert.equal(chordKey("palette", true), "cmd+k");
  assert.equal(chordKey("palette", false), "alt+k", "the default family is Alt");
  assert.equal(chordKey("palette", false, "ctrl+alt"), "ctrl+alt+k");
  assert.equal(chordKey("instances", false), null, "the stages are the Desktop's own");
  // The instance's name and colour: a chord of its own, no leader key, never a Shift variant.
  assert.equal(LEADER_TABLE.some((row) => row.does === "edit-instance"), false, "no leader key for it");
  assert.equal(PLAIN_KEYS.some((row) => row.does === "edit-instance"), false, "no plain key for it");
});

test("the chord families: Alt the default, Ctrl+Alt keeps its keys, Ctrl+Shift moves seven, and macOS has none", () => {
  assert.deepEqual([...CHORD_FAMILIES], ["alt", "ctrl+alt", "ctrl+shift"]);
  assert.equal(DEFAULT_CHORD_FAMILY, "alt");
  assert.deepEqual({ ...CHORD_FAMILY_LABELS }, { alt: "Alt", "ctrl+alt": "Ctrl+Alt", "ctrl+shift": "Ctrl+Shift" });
  assert.ok(Object.isFrozen(CHORD_FAMILIES) && Object.isFrozen(CHORD_FAMILY_LABELS));
  // The Alt family has a key of its own on every row but the instance moves, which are the same in
  // every family (the `alt` table above pins each); the workspace moves are its alone.
  assert.deepEqual(CHORDS.filter((entry) => entry.alt === entry.other).map((entry) => entry.does), ["previous", "next"]);
  // The maintainer's cut (a43470ce): K P S M W E D.
  const moved = { palette: "ctrl+shift+k", spawn: "ctrl+shift+p", workspaces: "ctrl+shift+s", zoom: "ctrl+shift+m",
    "close-terminal": "ctrl+shift+w", "split-right": "ctrl+shift+e", "split-down": "ctrl+shift+d" };
  assert.deepEqual(CHORDS.map(({ does, shift }) => [does, shift]),
    CHORDS.map(({ does, other }) => [does, moved[does] ?? other]));
  assert.deepEqual(CHORDS.filter((entry) => entry.shift !== entry.other).map((entry) => entry.does), Object.keys(moved));
  const shifts = CHORDS.map((entry) => entry.shift).filter((key) => key !== null);
  assert.equal(new Set(shifts).size, shifts.length, "shift: no chord twice");
  for (const entry of CHORDS) {
    for (const family of CHORD_FAMILIES) assert.equal(chordKeyOf(entry, true, family), entry.mac, `${entry.does}: macOS has no family`);
    assert.equal(chordKeyOf(entry, false), entry.alt, `${entry.does}: the default is Alt`);
    assert.equal(chordKeyOf(entry, false, "alt"), entry.alt);
    assert.equal(chordKeyOf(entry, false, "ctrl+alt"), entry.other, `${entry.does}: Ctrl+Alt is the \`other\` key`);
    assert.equal(chordKeyOf(entry, false, "ctrl+shift"), entry.shift);
    assert.equal(chordKeyOf(entry, false, "anything"), entry.alt, `${entry.does}: an unknown family is the default`);
  }
  assert.equal(chordKey("palette", false, "ctrl+alt"), "ctrl+alt+k");
  assert.equal(chordKey("group-previous", false, "ctrl+shift"), "ctrl+alt+shift+a");
  assert.equal(chordKey("tab-previous", false, "ctrl+shift"), "alt+shift+left");
  assert.equal(chordKey("palette", false, "ctrl+shift"), "ctrl+shift+k");
  assert.equal(chordKey("filter", false, "ctrl+shift"), "ctrl+alt+f");
  assert.equal(chordKey("next", false, "ctrl+shift"), "alt+shift+down");
  assert.equal(chordKey("tab-9", false, "ctrl+shift"), "ctrl+alt+9");
  assert.equal(chordKey("palette", true, "ctrl+shift"), "cmd+k");
});

// macOS's moves between tabs, groups and workspaces are ⌥ with an arrow (the product owner's call, 2026-10-23); the
// Ctrl+Alt and Ctrl+Shift families leave Alt+↑/↓ to the program (#1491 B1): the leader's ↑/↓ reach
// the workspace moves there, as in every family.
test("macOS: ⌥ with an arrow moves between tabs, groups and workspaces; outside the Alt family the workspace moves have no chord", () => {
  const ids = { "workspace-previous": "workspace.previous", "workspace-next": "workspace.next", "tab-previous": "tabs.prevPage", "tab-next": "tabs.nextPage",
    "group-previous": "split.focusPrevGroup", "group-next": "split.focusNextGroup" };
  const mac = { "workspace-previous": "alt+up", "workspace-next": "alt+down", "tab-previous": "alt+left", "tab-next": "alt+right",
    "group-previous": "alt+shift+left", "group-next": "alt+shift+right" };
  for (const [does, id] of Object.entries(ids)) {
    assert.equal(CHORDS_READ.find((each) => each.does === does)?.id, id, `${does} is read by ${id}`);
    for (const family of CHORD_FAMILIES) assert.equal(chordKey(does, true, family), mac[does], `${does}: macOS has no family, ${family}`);
  }
  assert.deepEqual(Object.values(ids).map((id) => defaultBinding(id, true)), ["Alt+↑", "Alt+↓", "Alt+←", "Alt+→", "Alt+Shift+←", "Alt+Shift+→"]);
  // The instance moves keep ⌥⌘↑/↓, and the letters and digits ⌘ (⌥ with one types a character).
  assert.deepEqual(["roster.openPrevious", "roster.openNext", "tabs.goto1", "app.palette"].map((id) => defaultBinding(id, true)), ["Mod+Alt+↑", "Mod+Alt+↓", "Mod+Alt+1", "Mod+K"]);
  assert.equal(CHORDS.filter((entry) => /^alt\+(shift\+)?[^+]$/.test(entry.mac ?? "")).length, 0, "no macOS chord is ⌥ with a letter or a digit");
  for (const does of ["workspace-previous", "workspace-next"]) {
    const entry = CHORDS.find((each) => each.does === does);
    assert.deepEqual([entry.other, entry.shift], [null, null], `${does}: no Ctrl+Alt or Ctrl+Shift key, so no fallback can bring one`);
    for (const family of ["ctrl+alt", "ctrl+shift"]) {
      assert.equal(chordKey(does, false, family), null, `${does}: none in ${family}`);
      assert.equal(defaultBinding(ids[does], false, family), null, `${ids[does]}: no default in ${family}`);
    }
  }
  assert.deepEqual(CHORD_FAMILIES.map((family) => ["workspace.previous", "workspace.next", "split.focusPrevGroup"].map((id) => defaultBinding(id, false, family))), [
    ["Alt+↑", "Alt+↓", "Alt+Shift+←"],
    [null, null, "Ctrl+Alt+Shift+A"],
    [null, null, "Ctrl+Alt+Shift+A"],
  ]);
  assert.deepEqual(["workspace.previous", "workspace.next", "split.focusPrevGroup"].map((id) => defaultBinding(id, false)), ["Alt+↑", "Alt+↓", "Alt+Shift+←"],
    "the default family's");
});

// A chord as the platform reads it: Mod is Ctrl on Linux/Windows, and ⌘ apart from ⌃ on macOS.
const pressed = (chord, isMac) => {
  const { key, mod, ctrl, alt, shift } = parseChord(chord);
  return isMac ? `${key} mod=${mod} ctrl=${ctrl} alt=${alt} shift=${shift}` : `${key} ctrl=${mod || ctrl} alt=${alt} shift=${shift}`;
};

test("every family binds no key twice across the Desktop's whole default keymap, on Linux/Windows and on macOS", () => {
  for (const family of CHORD_FAMILIES) for (const isMac of [false, true]) {
    const seen = new Map();
    for (const id of Object.keys(DEFAULT_KEYMAPS[family])) {
      const chord = defaultBinding(id, isMac, family);
      if (chord === null) continue;
      assert.ok(parseChord(chord), `${id}: ${chord} parses`);
      const key = pressed(chord, isMac);
      assert.ok(!seen.has(key), `${family}, mac=${isMac}: ${chord} is ${seen.get(key)}'s and ${id}'s`);
      seen.set(key, id);
    }
  }
  // The rows that come closest: the Alt family's previous group and the other two's previous tab
  // are both Alt+Shift+←, never in one family.
  assert.equal(defaultBinding("split.focusPrevGroup", false, "alt"), "Alt+Shift+←");
  assert.equal(defaultBinding("tabs.prevPage", false, "alt"), "Alt+←");
  assert.equal(defaultBinding("tabs.prevPage", false, "ctrl+alt"), "Alt+Shift+←");
  assert.equal(defaultBinding("split.focusPrevGroup", false, "ctrl+alt"), "Ctrl+Alt+Shift+A");
});

test("the palette's own keys: next and previous group, per platform, read only while it is open", () => {
  assert.deepEqual(PALETTE_KEYS.map(({ does, mac, other }) => [does, mac, other]), [
    ["palette-next-group", "cmd+n", "alt+shift+down"],
    ["palette-previous-group", "cmd+alt+n", "alt+shift+up"],
  ]);
  assert.ok(Object.isFrozen(PALETTE_KEYS) && PALETTE_KEYS.every((entry) => Object.isFrozen(entry)));
  assert.equal(paletteKey("palette-next-group", true), "cmd+n");
  assert.equal(paletteKey("palette-previous-group", false), "alt+shift+up");
  assert.equal(paletteKey("next", false), null, "a chord is no palette key");
  assert.equal(chordKey("palette-next-group", false), null, "and a palette key no chord");
});

test("no key is bound twice, in the leader's table or in the plain keys", () => {
  for (const [name, rows] of [["LEADER_TABLE", LEADER_TABLE], ["PLAIN_KEYS", PLAIN_KEYS]]) {
    const seen = new Map();
    for (const row of rows) for (const key of row.keys) {
      assert.ok(!seen.has(key), `${name}: ${key} is bound to ${seen.get(key)} and to ${row.does}`);
      seen.set(key, row.does);
    }
    assert.equal(new Set(rows.map((row) => row.does)).size, rows.length, `${name}: one row per action`);
  }
});

test("the readers answer from the tables, and every value they return is frozen", () => {
  assert.equal(leaderDoes("k"), "palette");
  assert.equal(leaderDoes("space"), "palette");
  assert.equal(leaderDoes("N"), "spawn-another");
  assert.equal(leaderDoes("escape"), "list");
  assert.equal(leaderDoes("q"), null);
  assert.equal(leaderDoes("K"), null, "case is kept");
  assert.deepEqual([...plainKeys("bottom")], ["G", "end"]);
  assert.deepEqual([...plainKeys("palette")], [], "no plain key");
  assert.ok(Object.isFrozen(plainKeys("bottom")));
  assert.ok(Object.isFrozen(plainKeys("nothing")));
  assert.equal(leaderRows(), LEADER_TABLE);
  assert.ok(Object.isFrozen(LEADER_TABLE) && Object.isFrozen(PLAIN_KEYS));
  for (const row of [...LEADER_TABLE, ...PLAIN_KEYS]) {
    assert.ok(Object.isFrozen(row) && Object.isFrozen(row.keys), `${row.does} is frozen`);
  }
});

test("the Desktop's chords are the module's entries, each read by one action", () => {
  assert.deepEqual(CHORDS_READ.map(({ does }) => does), CHORDS.map(({ does }) => does), "every chord is read, once, in the table's order");
  assert.equal(new Set(CHORDS_READ.map(({ id }) => id)).size, CHORDS_READ.length, "one action per chord");
  // Who reads what: the shared tab moves are the second tab-cycling chords (Ctrl+Tab and Ctrl+Shift+Tab
  // stay the Desktop's own tabs.next / tabs.prev), the instance moves (previous, next), the workspace
  // moves and zoom have actions of their own.
  assert.deepEqual(Object.fromEntries(CHORDS_READ.map(({ id, does }) => [does, id])), {
    palette: "app.palette", spawn: "app.quickOpenSouls", workspaces: "app.workspaces",
    previous: "roster.openPrevious", next: "roster.openNext",
    "workspace-previous": "workspace.previous", "workspace-next": "workspace.next",
    "tab-previous": "tabs.prevPage", "tab-next": "tabs.nextPage",
    ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`tab-${i + 1}`, `tabs.goto${i + 1}`])),
    zoom: "terminal.focusMode", "close-terminal": "tabs.close", "split-right": "split.vertical", "split-down": "split.horizontal",
    "group-previous": "split.focusPrevGroup", "group-next": "split.focusNextGroup", filter: "sidebar.focusFilter", "edit-instance": "instance.edit",
    mail: "instance.mail",
  });
  for (const { id, does } of CHORDS_READ) {
    assert.ok(Object.hasOwn(DEFAULT_KEYMAP, id), id);
    assert.equal(defaultBinding(id, true), chordFromKeyId(chordKey(does, true)), `${id} on macOS`);
    assert.equal(defaultBinding(id, false), chordFromKeyId(chordKey(does, false)), `${id} elsewhere`);
  }
  assert.deepEqual(["cmd+k", "cmd+shift+\\", "ctrl+shift+k", "ctrl+shift+tab", "ctrl+tab", "shift+tab"].map(chordFromKeyId),
    ["Mod+K", "Mod+Shift+\\", "Ctrl+Shift+K", "Ctrl+Shift+Tab", "Ctrl+Tab", "Shift+Tab"]);
  assert.deepEqual(["ctrl+alt+k", "ctrl+alt+shift+e", "ctrl+alt+1", "alt+shift+up", "alt+shift+right", "cmd+alt+down", "cmd+alt+left", "cmd+alt+o"].map(chordFromKeyId),
    ["Ctrl+Alt+K", "Ctrl+Alt+Shift+E", "Ctrl+Alt+1", "Alt+Shift+↑", "Alt+Shift+→", "Mod+Alt+↓", "Mod+Alt+←", "Mod+Alt+O"]);
  assert.deepEqual(["alt+k", "alt+shift+e", "alt+1", "alt+up", "alt+left", "alt+shift+left", "ctrl+alt+shift+a"].map(chordFromKeyId),
    ["Alt+K", "Alt+Shift+E", "Alt+1", "Alt+↑", "Alt+←", "Alt+Shift+←", "Ctrl+Alt+Shift+A"]);
});

const ENGINE = new URL("../renderer/keybindings.mjs", import.meta.url);
const MODULE = new URL("../../client/keymap.mjs", import.meta.url);

test("the Desktop's leader and sidebar-key defaults are the module's entries", () => {
  // D18 (decided 2026-11-19): the Desktop's default leader is its own, Ctrl+Space; the shared LEADER (Ctrl+X, the
  // TUI's) is the other choice the Keyboard shortcuts sheet offers.
  assert.deepEqual([defaultBinding("app.leader", true), defaultBinding("app.leader", false)], ["Ctrl+Space", "Ctrl+Space"]);
  assert.deepEqual(LEADER_CHOICES, ["Ctrl+Space", chordFromKeyId(LEADER.other)]);
  assert.equal(chordFromKeyId(LEADER.mac), "Ctrl+X");
  const sidebar = SIDEBAR_KEYS.map(({ id, does }) => [id, does]);
  assert.equal(new Set(sidebar.map(([, does]) => does)).size, sidebar.length, "one action per key");
  for (const [id, does] of sidebar) {
    assert.ok(Object.hasOwn(DEFAULT_KEYMAP, id), id);
    assert.equal(plainKeys(does).length, 1, `${does}: one key`);
    assert.equal(defaultBinding(id, false), chordFromKeyId(plainKeys(does)[0]), id);
    assert.equal(defaultBinding(id, true), defaultBinding(id, false), `${id}: the same on every platform`);
  }
  assert.deepEqual(Object.fromEntries(sidebar.map(([id]) => [id, defaultBinding(id, false)])), {
    "sidebar.key.instances": "1", "sidebar.key.souls": "2", "sidebar.key.capabilities": "3", "sidebar.key.workspaces": "W",
    "sidebar.key.filter": "/", "sidebar.key.refresh": "R", "sidebar.key.zoom": "Z", "sidebar.key.closeTerminal": "C",
    "sidebar.key.tabPrevious": "[", "sidebar.key.tabNext": "]", "sidebar.key.splitRight": "|", "sidebar.key.splitDown": "-",
    "sidebar.key.stop": "Shift+X", "sidebar.key.retire": "Shift+D", "sidebar.key.start": "Shift+S", "sidebar.key.restart": "Shift+R",
    "sidebar.key.spawn": "N", "sidebar.key.spawnAnother": "Shift+N", "sidebar.key.help": "?",
  });
});

test("change the module's entry in a copy: the Desktop's default follows, and keybindings.mjs writes none down", async t => {
  const root = mkdtempSync(join(tmpdir(), "keymap-shared-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "client")); mkdirSync(join(root, "desktop", "renderer"), { recursive: true });
  const module = readFileSync(MODULE, "utf8");
  const changed = module.replace('other: "ctrl+x"', 'other: "alt+l"').replace('{ does: "refresh", keys: ["r"] }', '{ does: "refresh", keys: ["F"] }')
    .replace('{ does: "palette", mac: "cmd+k", alt: "alt+k", other: "ctrl+alt+k", shift: "ctrl+shift+k" }', '{ does: "palette", mac: "cmd+j", alt: "alt+shift+j", other: "ctrl+shift+j" }')
    .replace('{ does: "previous", mac: "cmd+alt+up", other: "alt+shift+up", label: "previous instance" }', '{ does: "previous", mac: "cmd+alt+u", other: "ctrl+alt+u", label: "previous instance" }')
    .replace('{ does: "workspace-previous", mac: "alt+up", alt: "alt+up", other: null, shift: null }', '{ does: "workspace-previous", mac: "cmd+shift+up", alt: "alt+shift+w", other: "ctrl+alt+up" }')
    .replace('`ctrl+alt+${i + 1}`', '`ctrl+shift+alt+${i + 1}`')
    .replace('`alt+${i + 1}`', '`alt+shift+${i + 1}`');
  assert.notEqual(changed, module);
  writeFileSync(join(root, "client", "keymap.mjs"), changed);
  writeFileSync(join(root, "desktop", "renderer", "keybindings.mjs"), readFileSync(ENGINE, "utf8"));
  const copy = await import(pathToFileURL(join(root, "desktop", "renderer", "keybindings.mjs")).href);
  assert.equal(copy.defaultBinding("app.leader", false), "Ctrl+Space", "the Desktop's own default (D18)");
  assert.equal(copy.LEADER_CHOICES[1], "Alt+L", "the other choice is the module's LEADER, read");
  assert.equal(copy.defaultBinding("sidebar.key.refresh", false), "Shift+F");
  assert.deepEqual([copy.defaultBinding("app.palette", true), copy.defaultBinding("app.palette", false), copy.defaultBinding("app.palette", false, "ctrl+alt")],
    ["Mod+J", "Alt+Shift+J", "Ctrl+Shift+J"]);
  // A row without an `alt` key keeps its `other` one in the Alt family.
  assert.deepEqual([copy.defaultBinding("roster.openPrevious", true), copy.defaultBinding("roster.openPrevious", false), copy.defaultBinding("roster.openPrevious", false, "ctrl+alt")],
    ["Mod+Alt+U", "Ctrl+Alt+U", "Ctrl+Alt+U"]);
  // A row new with the Alt family is read like the others, macOS included.
  assert.deepEqual([copy.defaultBinding("workspace.previous", true), copy.defaultBinding("workspace.previous", false), copy.defaultBinding("workspace.previous", false, "ctrl+alt")],
    ["Mod+Shift+↑", "Alt+Shift+W", "Ctrl+Alt+↑"]);
  assert.deepEqual([copy.defaultBinding("tabs.goto1", false), copy.defaultBinding("tabs.goto9", false)], ["Alt+Shift+1", "Alt+Shift+9"]);
  assert.deepEqual([copy.defaultBinding("tabs.goto1", false, "ctrl+alt"), copy.defaultBinding("tabs.goto9", false, "ctrl+alt")], ["Ctrl+Alt+Shift+1", "Ctrl+Alt+Shift+9"]);
  // No literal duplicate: the engine names neither chord nor key of the shared tables.
  const engine = readFileSync(ENGINE, "utf8");
  assert.doesNotMatch(engine, /"Ctrl\+X"|"ctrl\+x"/, "the leader is read, not retyped");
  assert.doesNotMatch(engine, /"sidebar\.key\.\w+":\s*"/, "no sidebar key with a literal default");
  for (const { id } of CHORDS_READ) assert.doesNotMatch(engine, new RegExp(`"${id.replace(".", "\\.")}":\\s*[{"]`), `${id}: the chord is read, not retyped`);
  assert.doesNotMatch(engine, /`tabs\.goto\$\{i \+ 1\}`, \{|Alt\+\$\{i \+ 1\}/, "go to tab is read, not retyped");
});

// Every default of the Desktop's keymap, as written: what the engine reads per platform
// (defaultBinding), in the default family, Alt. Pinned before the chords moved to the shared module
// (packages/client/keymap.mjs CHORDS) and after: reading them from there changed no key, no shape and
// no order. Phase 3's table (c4d4a391) changed exactly its rows: the palette, Quick Open, close tab,
// filter and the splits moved to Ctrl+Alt on Linux/Windows, the second tab-cycling chords to
// Alt+Shift+←/→ (⌘⌥←/→, new on macOS), go to tab to Ctrl+Alt+digit; the workspace switcher and the
// next editor group got a chord; roster.openPrevious, roster.openNext and terminal.focusMode are new.
// 0.67 (#1433) changed only the leader, to Ctrl+X on both. The Alt family (the product owner's call, 2026-10-22)
// made Alt the default on Linux/Windows: every shared chord there is Alt with the key (Alt+←/→ the
// tab moves, Alt+Shift+←/→ the groups), Ctrl+Alt's keys became an option (CTRL_ALT_MOVED below), and
// split.focusPrevGroup, workspace.previous and workspace.next are new. Then macOS took ⌥ with an
// arrow for the moves (the product owner's call, 2026-10-23): ⌥←/→ the tabs, ⌥⇧←/→ the groups, ⌥↑/↓ the workspaces, the
// same chord as Linux/Windows' Alt family, so one string. The font picker (app.fontPicker, the product
// owner's call, 2026-10-23) is new: the Desktop's own, with no default chord, shared with no TUI row.
// The Desktop UI rework (Joan, 2026-11-19): the leader is the Desktop's own Ctrl+Space (D18), and new are Delete (a
// second sidebar key for retire) and Alt+N (New agent: Ctrl+Alt+N in the other families, ⌥⌘N on macOS).
const DEFAULTS = [
  ["app.leader","Ctrl+Space"],
  ["sidebar.key.instances","1"],
  ["sidebar.key.souls","2"],
  ["sidebar.key.capabilities","3"],
  ["sidebar.key.workspaces","W"],
  ["sidebar.key.filter","/"],
  ["sidebar.key.refresh","R"],
  ["sidebar.key.zoom","Z"],
  ["sidebar.key.closeTerminal","C"],
  ["sidebar.key.tabPrevious","["],
  ["sidebar.key.tabNext","]"],
  ["sidebar.key.splitRight","|"],
  ["sidebar.key.splitDown","-"],
  ["sidebar.key.stop","Shift+X"],
  ["sidebar.key.retire","Shift+D"],
  ["sidebar.key.start","Shift+S"],
  ["sidebar.key.restart","Shift+R"],
  ["sidebar.key.spawn","N"],
  ["sidebar.key.spawnAnother","Shift+N"],
  ["sidebar.key.help","?"],
  ["sidebar.key.retireDelete","Delete"],
  ["app.newAgent",{"mac":"Mod+Alt+N","other":"Alt+N"}],
  ["split.focusPrevGroup","Alt+Shift+←"],
  ["split.focusNextGroup","Alt+Shift+→"],
  ["app.palette",{"mac":"Mod+K","other":"Alt+K"}],
  ["app.quickOpenSouls",{"mac":"Mod+P","other":"Alt+P"}],
  ["app.workspaces",{"mac":"Mod+Alt+O","other":"Alt+O"}],
  ["roster.openPrevious",{"mac":"Mod+Alt+↑","other":"Alt+Shift+↑"}],
  ["roster.openNext",{"mac":"Mod+Alt+↓","other":"Alt+Shift+↓"}],
  ["terminal.focusMode",{"mac":"Mod+Alt+Z","other":"Alt+Z"}],
  ["workspace.previous","Alt+↑"],
  ["workspace.next","Alt+↓"],
  ["instance.edit",{"mac":"Mod+Alt+R","other":"Alt+R"}],
  ["instance.mail",{"mac":"Mod+Alt+M","other":"Alt+M"}],
  ["agent.viewFocus",{"mac":"Mod+Alt+T","other":"Alt+T"}],
  ["app.chooseSoul",{"mac":"Mod+N","other":"Ctrl+Shift+N"}],
  ["app.shortcuts","Mod+,"],
  ["app.themeToggle",null],
  ["app.themePicker",{"mac":"Mod+Shift+Space","other":"Ctrl+Shift+Space"}],
  ["app.fontPicker",null],
  ["stage.hierarchy","Mod+1"],
  ["stage.spawn","Mod+2"],
  ["stage.automations","Mod+3"],
  ["tabs.next","Ctrl+Tab"],
  ["tabs.prev","Ctrl+Shift+Tab"],
  ["tabs.nextPage","Alt+→"],
  ["tabs.prevPage","Alt+←"],
  ["tabs.goto1",{"mac":"Mod+Alt+1","other":"Alt+1"}],
  ["tabs.goto2",{"mac":"Mod+Alt+2","other":"Alt+2"}],
  ["tabs.goto3",{"mac":"Mod+Alt+3","other":"Alt+3"}],
  ["tabs.goto4",{"mac":"Mod+Alt+4","other":"Alt+4"}],
  ["tabs.goto5",{"mac":"Mod+Alt+5","other":"Alt+5"}],
  ["tabs.goto6",{"mac":"Mod+Alt+6","other":"Alt+6"}],
  ["tabs.goto7",{"mac":"Mod+Alt+7","other":"Alt+7"}],
  ["tabs.goto8",{"mac":"Mod+Alt+8","other":"Alt+8"}],
  ["tabs.goto9",{"mac":"Mod+Alt+9","other":"Alt+9"}],
  ["tabs.close",{"mac":"Mod+W","other":"Alt+W"}],
  ["focus.nextRegion","F6"],
  ["focus.prevRegion","Shift+F6"],
  ["focus.leaveTerminal","Mod+Shift+F6"],
  ["sidebar.focusFilter",{"mac":"Mod+F","other":"Alt+F"}],
  ["sidebar.toggle",{"mac":"Mod+B","other":"Ctrl+Shift+B"}],
  ["split.vertical",{"mac":"Mod+\\","other":"Alt+E"}],
  ["split.horizontal",{"mac":"Mod+Shift+\\","other":"Alt+Shift+E"}],
  ["split.close",{"mac":"Mod+Alt+W","other":"Ctrl+Shift+Alt+W"}],
  ["panel.toggle",{"mac":"Mod+I","other":"Ctrl+Shift+I"}],
  ["terminal.copySelection",{"mac":null,"other":"Ctrl+Shift+C"}],
  ["terminal.fontBigger","Mod+="],
  ["terminal.fontSmaller","Mod+-"],
  ["terminal.fontReset","Mod+0"],
];

test("the Desktop's default keymap, every action on both platforms, is as pinned", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(Object.entries(DEFAULT_KEYMAP))), DEFAULTS);
  for (const [id, entry] of DEFAULTS) {
    const [mac, other] = entry !== null && typeof entry === "object" ? [entry.mac, entry.other] : [entry, entry];
    assert.equal(defaultBinding(id, true), mac, `${id} on macOS`);
    assert.equal(defaultBinding(id, false), other, `${id} elsewhere`);
  }
});

// The Ctrl+Alt family (keys.json "chords": "ctrl+alt"; docs/desktop-keyboard.md, "The chord
// families"): the same keymap, with the Linux/Windows key of every shared chord that is not the same
// in every family, as it was before the Alt family. The Ctrl+Shift family ("chords": "ctrl+shift"):
// the Ctrl+Alt keymap, with the Linux/Windows key of the seven rows it moves (the maintainer's cut,
// a43470ce) and nothing else. macOS has no family: its keys are the same in all three. Neither has a
// workspace move: Alt+↑/↓ are left to the program (#1491 B1).
const CTRL_ALT_MOVED = {
  "workspace.previous": null,
  "workspace.next": null,
  "split.focusPrevGroup": "Ctrl+Alt+Shift+A",
  "split.focusNextGroup": "Ctrl+Alt+A",
  "app.palette": "Ctrl+Alt+K",
  "app.quickOpenSouls": "Ctrl+Alt+P",
  "app.workspaces": "Ctrl+Alt+O",
  "terminal.focusMode": "Ctrl+Alt+Z",
  "instance.edit": "Ctrl+Alt+R",
  // New agent (the Desktop UI rework, 2026-11-19): the Desktop's own chord, not a shared row yet, family by family too.
  "app.newAgent": "Ctrl+Alt+N",
  "instance.mail": "Ctrl+Alt+M",
  "agent.viewFocus": "Ctrl+Alt+T",
  "tabs.nextPage": "Alt+Shift+→",
  "tabs.prevPage": "Alt+Shift+←",
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`tabs.goto${i + 1}`, `Ctrl+Alt+${i + 1}`])),
  "tabs.close": "Ctrl+Alt+W",
  "sidebar.focusFilter": "Ctrl+Alt+F",
  "split.vertical": "Ctrl+Alt+E",
  "split.horizontal": "Ctrl+Alt+Shift+E",
};
const SHIFT_MOVED = {
  "app.palette": "Ctrl+Shift+K",
  "app.quickOpenSouls": "Ctrl+Shift+P",
  "app.workspaces": "Ctrl+Shift+S",
  "terminal.focusMode": "Ctrl+Shift+M",
  "tabs.close": "Ctrl+Shift+W",
  "split.vertical": "Ctrl+Shift+E",
  "split.horizontal": "Ctrl+Shift+D",
};
const macOf = (entry) => (entry !== null && typeof entry === "object" ? entry.mac : entry);
const moveIn = (table, moved) => table.map(([id, entry]) => [id, Object.hasOwn(moved, id) ? { mac: macOf(entry), other: moved[id] } : entry]);
const CTRL_ALT_DEFAULTS = moveIn(DEFAULTS, CTRL_ALT_MOVED);
const SHIFT_DEFAULTS = moveIn(CTRL_ALT_DEFAULTS, SHIFT_MOVED);

test("the Desktop's default keymap in each chord family, every action on both platforms, is as pinned", t => {
  t.after(() => setChordFamily(DEFAULT_CHORD_FAMILY));
  assert.deepEqual(Object.keys(DEFAULT_KEYMAPS), ["alt", "ctrl+alt", "ctrl+shift"]);
  assert.ok(Object.isFrozen(DEFAULT_KEYMAPS) && Object.values(DEFAULT_KEYMAPS).every(Object.isFrozen));
  assert.equal(DEFAULT_KEYMAP, DEFAULT_KEYMAPS.alt, "the default keymap is the Alt one");
  assert.deepEqual(JSON.parse(JSON.stringify(Object.entries(DEFAULT_KEYMAPS.alt))), DEFAULTS);
  assert.deepEqual(JSON.parse(JSON.stringify(Object.entries(DEFAULT_KEYMAPS["ctrl+alt"]))), CTRL_ALT_DEFAULTS);
  assert.deepEqual(JSON.parse(JSON.stringify(Object.entries(DEFAULT_KEYMAPS["ctrl+shift"]))), SHIFT_DEFAULTS);
  for (const [family, table] of [["alt", DEFAULTS], ["ctrl+alt", CTRL_ALT_DEFAULTS], ["ctrl+shift", SHIFT_DEFAULTS]]) {
    for (const [id, entry] of table) {
      const [mac, other] = entry !== null && typeof entry === "object" ? [entry.mac, entry.other] : [entry, entry];
      assert.equal(defaultBinding(id, true, family), mac, `${id} on macOS, ${family}`);
      assert.equal(defaultBinding(id, false, family), other, `${id} elsewhere, ${family}`);
    }
  }
  // Ctrl+Alt differs from Alt exactly in the shared chords that are not the same in every family;
  // Ctrl+Shift from Ctrl+Alt exactly in the seven; on Linux/Windows only.
  const differ = (a, b) => Object.keys(DEFAULT_KEYMAP).filter((id) => defaultBinding(id, false, a) !== defaultBinding(id, false, b)).sort();
  assert.deepEqual(differ("alt", "ctrl+alt"), Object.keys(CTRL_ALT_MOVED).sort());
  assert.deepEqual(differ("ctrl+alt", "ctrl+shift"), Object.keys(SHIFT_MOVED).sort());
  assert.deepEqual(differ("alt", "ctrl+alt").filter((id) => !CHORDS_READ.some((each) => each.id === id)), ["app.newAgent"],
    "only the shared chords differ, and New agent's Alt+N (the Desktop's own until the TUI takes it)");
  for (const id of Object.keys(DEFAULT_KEYMAP)) for (const family of CHORD_FAMILIES) {
    assert.equal(defaultBinding(id, true, family), defaultBinding(id, true, "alt"), `${id}: macOS has no family`);
  }
  // The same in every family: the instance moves. The workspace moves are the Alt family's alone.
  for (const family of CHORD_FAMILIES) {
    assert.deepEqual(["roster.openPrevious", "roster.openNext", "workspace.previous", "workspace.next"].map((id) => defaultBinding(id, false, family)),
      ["Alt+Shift+↑", "Alt+Shift+↓", ...(family === "alt" ? ["Alt+↑", "Alt+↓"] : [null, null])], family);
  }
  // The rows Ctrl+Shift keeps keep their Ctrl+Alt key: the groups, filter, the Alt+Shift arrows and Ctrl+Alt+1–9.
  assert.deepEqual(["split.focusPrevGroup", "split.focusNextGroup", "sidebar.focusFilter", "roster.openPrevious", "tabs.nextPage", "tabs.goto1", "tabs.goto9"].map((id) => defaultBinding(id, false, "ctrl+shift")),
    ["Ctrl+Alt+Shift+A", "Ctrl+Alt+A", "Ctrl+Alt+F", "Alt+Shift+↑", "Alt+Shift+→", "Ctrl+Alt+1", "Ctrl+Alt+9"]);
  // An unknown family is the default's keymap.
  assert.equal(defaultKeymap("ctrl+meta"), DEFAULT_KEYMAP);
  assert.equal(defaultBinding("app.palette", false, "ctrl+meta"), "Alt+K");
});

test("the Desktop's chords are the module's entries in each family: CHORDS alt, other and shift, read by chordKeyOf", () => {
  for (const { id, does } of CHORDS_READ) for (const family of CHORD_FAMILIES) {
    assert.equal(defaultBinding(id, false, family), chordFromKeyId(chordKey(does, false, family)), `${id} elsewhere, ${family}`);
    assert.equal(defaultBinding(id, true, family), chordFromKeyId(chordKey(does, true)), `${id} on macOS, ${family}`);
  }
});

test("the active family: the default until set, every reader follows at once, and the keymap's listeners hear of it", t => {
  t.after(() => setChordFamily(DEFAULT_CHORD_FAMILY));
  assert.equal(activeChordFamily(), "alt", "the default, Alt");
  assert.equal(getBinding("app.palette", false), "Alt+K");
  let heard = 0;
  const off = onKeymapChange(() => { heard++; });
  t.after(off);
  setChordFamily("ctrl+shift");
  assert.equal(activeChordFamily(), "ctrl+shift");
  assert.equal(heard, 1);
  assert.equal(defaultBinding("app.palette", false), "Ctrl+Shift+K", "defaultBinding reads the active family");
  assert.equal(getBinding("split.horizontal", false), "Ctrl+Shift+D", "and so does getBinding, every reader's");
  assert.equal(getBinding("app.palette", true), "Mod+K", "macOS is the same");
  setChordFamily("ctrl+shift");
  assert.equal(heard, 1, "the same family again is no change");
  setChordFamily("ctrl+alt");
  assert.equal(activeChordFamily(), "ctrl+alt", "Ctrl+Alt, a family of its own");
  assert.equal(heard, 2);
  assert.equal(getBinding("app.palette", false), "Ctrl+Alt+K");
  assert.equal(getBinding("tabs.prevPage", false), "Alt+Shift+←");
  setChordFamily("Ctrl+Shift ");
  assert.equal(activeChordFamily(), "alt", "anything that is not a family is the default");
  assert.equal(heard, 3);
  assert.equal(getBinding("app.palette", false), "Alt+K");
  assert.equal(getBinding("tabs.prevPage", false), "Alt+←");
});

test("change the module's shift entry in a copy: the Desktop's Ctrl+Shift default follows", async t => {
  const root = mkdtempSync(join(tmpdir(), "keymap-shared-shift-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "client")); mkdirSync(join(root, "desktop", "renderer"), { recursive: true });
  const module = readFileSync(MODULE, "utf8");
  const changed = module.replace('shift: "ctrl+shift+k"', 'shift: "ctrl+shift+j"').replace('{ does: "filter", mac: "cmd+f", alt: "alt+f", other: "ctrl+alt+f" }', '{ does: "filter", mac: "cmd+f", alt: "alt+f", other: "ctrl+alt+f", shift: "ctrl+shift+f" }');
  assert.notEqual(changed, module);
  writeFileSync(join(root, "client", "keymap.mjs"), changed);
  writeFileSync(join(root, "desktop", "renderer", "keybindings.mjs"), readFileSync(ENGINE, "utf8"));
  const copy = await import(pathToFileURL(join(root, "desktop", "renderer", "keybindings.mjs")).href);
  assert.deepEqual([copy.defaultBinding("app.palette", false, "ctrl+shift"), copy.defaultBinding("app.palette", false, "ctrl+alt"), copy.defaultBinding("app.palette", false)],
    ["Ctrl+Shift+J", "Ctrl+Alt+K", "Alt+K"]);
  assert.deepEqual([copy.defaultBinding("sidebar.focusFilter", false, "ctrl+shift"), copy.defaultBinding("sidebar.focusFilter", false, "ctrl+alt"), copy.defaultBinding("sidebar.focusFilter", false)],
    ["Ctrl+Shift+F", "Ctrl+Alt+F", "Alt+F"]);
  assert.equal(copy.defaultBinding("app.palette", true, "ctrl+shift"), "Mod+K");
});
