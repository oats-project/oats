/* oats desktop — what the leader's table means in the Desktop (pure).

   The table itself is the shared one (packages/client/keymap.mjs LEADER_TABLE, the TUI's, with
   its terse labels). Here: the Desktop's word for each `does`, which rows apply in the window's
   present state (a key whose row does not apply now still settles, and the shell says why in the
   hint's line: shell.mjs onSettle, notApplicable. Only `m`, which the Desktop has no operation
   for, cancels like a key outside the table), and how a key id is drawn (the shortcuts editor's
   Leader group lists the rows). The shell supplies the state and runs the
   rows (shell.mjs, leader-dispatch.mjs); docs/desktop-keyboard.md, "The leader", is the table. */

import { LEADER_TABLE } from "../../client/keymap.mjs";
import { chordFromKeyId, chordKeys } from "./keybindings.mjs";

/** A `does` that runs one registered action: its label is that action's, so the editor and the
 * palette show one name for one thing. */
export const LEADER_ACTIONS = Object.freeze({
  __proto__: null,
  palette: "app.palette",
  souls: "app.chooseSoul",
  "close-terminal": "tabs.close",
  "tab-previous": "tabs.prev",
  "tab-next": "tabs.next",
  "split-right": "split.vertical",
  "split-down": "split.horizontal",
  "group-next": "split.focusNextGroup",
  "group-previous": "split.focusPrevGroup",
  "group-close": "split.close",
  spawn: "app.quickOpenSouls",
  filter: "sidebar.focusFilter",
  workspaces: "app.workspaces",
  help: "app.shortcuts",
});

/** The Desktop's own words for the rest (and for the sidebar's `refresh`, which the leader lacks, and the
 * chords' `previous` / `next`, which it has no key for). */
export const LEADER_LABELS = Object.freeze({
  __proto__: null,
  instances: "Instances",
  capabilities: "Workspace › Capabilities",
  previous: "Open the previous instance's terminal",
  next: "Open the next instance's terminal",
  "workspace-previous": "Show the previous workspace in the list",
  "workspace-next": "Show the next workspace in the list",
  zoom: "Focus mode on or off, in the active terminal",
  stop: "Stop the instance…",
  restart: "Restart the instance…",
  start: "Start the instance…",
  retire: "Retire the instance…",
  "spawn-another": "Spawn another of the instance's soul…",
  list: "Instance roster",
  refresh: "Read the instance roster now",
});

/** What the Desktop cannot do from the leader: `m`, moving a tab to the other group (no input
 * moves a tab between groups today). Such a key cancels, and the shortcuts editor omits it. */
export const LEADER_UNSUPPORTED = Object.freeze(new Set(["tab-move"]));

/** The Desktop's label for `does`: its action's (`labelOf(actionId)`, the registry's), else its own. */
export function leaderLabel(does, labelOf = () => null) {
  const id = LEADER_ACTIONS[does];
  return (id && labelOf(id)) || LEADER_LABELS[does] || does;
}

/**
 * Does a row of the table apply now? `state`:
 *   terminalOpen   a terminal tab is open in this window's workspace
 *   tabs           the tabs the tab keys walk now (shell.mjs walkedTabs: the focused group's when split)
 *   canSplitRow / canSplitCol   the tab layer can split right / down now (split-controls.mjs)
 *   split          the tab layer is split (two groups or more)
 * Rows marked `terminal` apply only with a terminal open; the tab keys with two tabs or more; the
 * split keys while the layer can split that way; Tab, Shift+Tab and `x` while it is split. `m` never.
 */
export function leaderApplies(row, state = {}) {
  if (LEADER_UNSUPPORTED.has(row.does)) return false;
  if (row.terminal && !state.terminalOpen) return false;
  switch (row.does) {
    case "tab-previous": case "tab-next": return (state.tabs ?? 0) >= 2;
    case "split-right": return !!state.canSplitRow;
    case "split-down": return !!state.canSplitCol;
    case "group-next": case "group-previous": case "group-close": return !!state.split;
    default: return true;
  }
}

/** The row a key id belongs to, or null. */
export function leaderRowOf(keyId, rows = LEADER_TABLE) {
  return rows.find((row) => row.keys.includes(keyId)) ?? null;
}

/** The rows the Desktop supports at all (the editor's Leader group). */
export function supportedLeaderRows(rows = LEADER_TABLE) {
  return rows.filter((row) => !LEADER_UNSUPPORTED.has(row.does));
}

/** A key id as keycaps: `k` is K, `N` is Shift+N (⇧N), `space` Space, `up` ↑, `escape` Esc. */
export function keyIdCaps(keyId, isMac) {
  return chordKeys(chordFromKeyId(keyId), isMac);
}

/** A row's keys as words, "K or Space". */
export function rowKeysText(row, isMac) {
  return row.keys.map((key) => keyIdCaps(key, isMac).join(isMac ? "" : "+")).join(" or ");
}
