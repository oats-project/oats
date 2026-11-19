// keybindings wiring — the shell installs ONE engine keydown listener and
// every mouse affordance is registered as a rebindable action. Source-level
// assertions in the shell-nav.test.mjs house style: they pin the wiring
// without booting Electron.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(PKG, f), "utf8");

test("shell installs exactly one window keydown listener: the engine's handleKeydown", () => {
  const src = read("renderer/shell.mjs");
  const listeners = [...src.matchAll(/window\.addEventListener\("keydown"/g)];
  assert.equal(listeners.length, 1, "ONE window keydown listener (contract)");
  // engine addendum: handleKeydown itself skips defaultPrevented events,
  // so the shell listener is a bare delegation.
  assert.match(src, /window\.addEventListener\("keydown", \(e\) => handleKeydown\(e\)\)/);
  assert.ok(!/isPaletteShortcut\(/.test(src), "ad-hoc palette shortcut check replaced by the engine");
});

test("shell registers global + tabs actions covered by the engine's DEFAULT_KEYMAP", () => {
  const src = read("renderer/shell.mjs");
  for (const id of [
    "app.palette", "app.shortcuts", "app.themeToggle", "app.workspaces", "sidebar.focusFilter",
    "terminal.fontBigger", "terminal.fontSmaller", "terminal.fontReset",
    "tabs.next", "tabs.prev", "tabs.close",
  ]) assert.match(src, new RegExp(`id: "${id.replace(".", "\\.")}"`), `action ${id} registered`);
  assert.match(src, /\[\.\.\.NAV, \.\.\.NAV_TABS\]\.forEach\(\(v\) => registerAction\(/, "stage actions derive from the nav manifest, the Workspace tabs (stage.hierarchy, the Machines tab) included");
  assert.match(src, /setActiveContexts/, "shell drives active contexts");
});

test("the Graph and spawn views register rebindable view-local actions and dispose them", () => {
  const graph = read("renderer/views/graph.mjs");
  for (const id of ["graph.toggleField", "graph.zoomIn", "graph.zoomInPlus", "graph.zoomOut", "graph.fit"]) {
    assert.match(graph, new RegExp(`id: "${id.replace(".", "\\.")}", defaultChord:`), `Graph action ${id} declared`);
  }
  assert.match(graph, /context: "view:graph"/, "the Graph's actions use a never-activated view context (editor-visible, window-dispatch-ineligible — review afd2114)");
  assert.match(graph, /const disposers = viewActions\.map\(\(a\) => register\(/, "the Graph keeps its action disposers");
  assert.match(graph, /for \(const off of disposers\)/, "and disposes them with the view");
  assert.match(graph, /resolveViewKey\(e, viewActions\)/, "its keys resolve through the engine keymap (rebindable)");

  const spawn = read("renderer/views/spawn.mjs");
  for (const id of ["spawn.filter", "spawn.brain"]) {
    assert.match(spawn, new RegExp(`id: "${id.replace(".", "\\.")}"`), `spawn action ${id}`);
  }
  assert.match(spawn, /context: "view:spawn"/, "spawn actions use the never-activated view context");
  assert.match(spawn, /resolveViewKey\(/, "spawn keys resolve through the engine keymap");
  assert.match(spawn, /\(state\.disposers \|\| \[\]\)\.forEach/, "spawn disposes actions on unmount");
});

test("palette rows and data-action tooltips carry live chord labels", () => {
  const shell = read("renderer/shell.mjs");
  assert.match(shell, /detail: chordDetail\(/, "palette commands show the current chord");
  assert.match(shell, /onKeymapChange\(\(\) => applyChordTitles\(\)\)/, "tooltips live-update on rebinding");
  const palette = read("renderer/palette.mjs");
  assert.match(palette, /typeof c\.detail === "function" \? c\.detail\(\)/, "palette re-evaluates chord details per render");
});

test("view-local defaults are first-class engine bindings (registerAction defaultChord)", () => {
  // engine addendum 3: dynamic view actions carry their default in the
  // registration; getBinding folds override ?? DEFAULT_KEYMAP ?? defaultChord,
  // so the editor shows real defaults and Backspace-unbind kills the key.
  const graph = read("renderer/views/graph.mjs");
  const expected = { "graph.toggleField": "M", "graph.zoomIn": "=", "graph.zoomInPlus": "Shift\\+=", "graph.zoomOut": "-", "graph.fit": "0" };
  for (const [id, chord] of Object.entries(expected)) {
    assert.match(graph, new RegExp(`id: "${id.replace(".", "\\.")}", defaultChord: "${chord}"`), `${id} registers defaultChord ${chord}`);
  }
  assert.match(graph, /register\(\{ id: a\.id, label: a\.label, context: "view:graph", run: a\.run, defaultChord: a\.defaultChord \}\)/,
    "the Graph passes defaultChord through registerAction");
  const spawn = read("renderer/views/spawn.mjs");
  assert.match(spawn, /id: "spawn\.filter", label:.*defaultChord: "\/"/, "spawn.filter default '/'");
  assert.match(spawn, /id: "spawn\.brain", label:.*defaultChord: "B"/, "spawn.brain default B");
});

test("the leader is wired as one rebindable global action, inert under a modal, with its hint and no footer button", () => {
  const src = read("renderer/shell.mjs");
  assert.match(src, /registerAction\(\{ id: "app\.leader", label: "Leader: the commands that follow one key", context: "global", when: \(\) => !modalOpen\(\),/);
  assert.match(src, /const leader = createLeader\(\{ win: window, isMac, modalOpen,/);
  assert.match(src, /onSettle: does => \{ const why = notApplicable\(does\); if \(why\) sayInHint\(why\); else leaderDispatch\.run\(does, leaderOrigin\(document\.activeElement\)\); \}/);
  // The wait shows nothing: it is announced (leader-hint.mjs announce), and the keys are the shortcuts editor's.
  assert.match(src, /onOpen: \(\) => leaderHint\.announce\(\),/);
  assert.doesNotMatch(src, /showKeys|leaderRowsNow/);
  assert.match(src, /createLeaderHint\(\{ doc: document, host: document\.getElementById\("main"\), before: document\.getElementById\("show-panel"\) \}\)/);
  assert.match(src, /registerAction\(\{ id: "split\.focusNextGroup", label: "Focus the next editor group", context: "tabs",/);
  // The footer has no leader button: the shortcuts editor is where the commands are listed.
  assert.doesNotMatch(read("renderer/index.html"), /sidebar-leader|data-shortcut="app\.leader"/);
  assert.doesNotMatch(src, /sidebar-leader/);
  // A terminal's interception goes through matchEvent, which a let-through event (the leader twice) passes.
  assert.match(read("renderer/keybindings.mjs"), /if \(e\.defaultPrevented \|\| letThroughEvents\.has\(e\)\) return null;/);
});

// The views whose arrow keys are their own give way to the keymap where it binds the chord (the
// shared Alt+Shift+↑/↓, ⌘⌥↑/↓, or a rebind), never by modifier: an unbound Alt+↑ or ⌘↑ stays theirs.
// Behaviour: test/roster-keys, spawn-grid-keys and instance-actions (the row's context menu); the Graph here.
test("the Graph, the Souls grid, the roster tree and the row's context menu ask keymapTakes", () => {
  assert.match(read("renderer/views/graph.mjs"), /\["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "Enter"\]\.includes\(e\.key\)\) \{\n      if \(keymapTakes\(e\)\) return;\n      e\.preventDefault\(\);/);
  assert.match(read("renderer/views/spawn.mjs"), /\["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"\]\.includes\(e\.key\) && keymapTakes\(e\)\) return;/);
  assert.match(read("renderer/roster-keys.mjs"), /if \(named && keymapTakes\(event\)\) return null;/);
  assert.match(read("renderer/instance-actions.mjs"), /if \(!\["ArrowDown", "ArrowUp", "Home", "End"\]\.includes\(event\.key\) \|\| keymapTakes\(event\)\) return;/);
  for (const file of ["renderer/views/graph.mjs", "renderer/views/spawn.mjs", "renderer/roster-keys.mjs", "renderer/instance-actions.mjs"]) {
    // The roster's letter guard (`!named && …`: a letter held with Ctrl, Alt or ⌘ is not the tree's) is not about the arrows.
    assert.doesNotMatch(read(file), /(?<!!named && \((?:e|event)\.ctrlKey \|\| )(?:e|event)\.altKey \|\| (?:e|event)\.metaKey\)\) return/, `${file}: no modifier guess`);
  }
});
