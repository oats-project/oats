/* oats desktop — the layout a workspace takes with it when another window takes it over (pure).

   A pick from the list of workspaces always shows the workspace in the window it was made in; one that
   another window shows moves (main's window:claim-workspace take-over). That window answers main's
   release with this descriptor of what it showed of the workspace: its terminal tabs and its split.
   Main checks it (`validLayout`) and passes it on whole, or not at all; the window that took the
   workspace opens those terminals again (fresh viewers: the agents keep running) and lays them out
   (`composeLayout`). File, brain and view tabs do not move: the window they were in closes them.

   The descriptor, a closed shape (nothing else is accepted):
     { terminals: [{ instance, home?, agentsRoot?, server? }],   the terminal tabs, in strip order
       split: null | { orientation: "row" | "col", focused,       the focused group's index
                       groups: [{ tabs: [index…], active, weight? }] },
       active: index | null }                                     the active tab
   An `index` is a position in `terminals`. Each terminal is in at most one group, and a group's `active`
   is one of its own tabs or null. */

import { MAX_SPLIT_GROUPS } from "./split-layout.mjs";

/** At most this many terminals move with a workspace. */
export const MAX_HANDED_TERMINALS = 64;
const MAX_NAME = 1024, MAX_PATH = 4096;
const REF_FIELDS = Object.freeze({ instance: MAX_NAME, home: MAX_PATH, agentsRoot: MAX_PATH, server: MAX_NAME });

const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const onlyKeys = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
// No control characters (C0, DEL, C1) and no line or paragraph separators.
const plainText = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max
  && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value);
const index = (value, count) => Number.isSafeInteger(value) && value >= 0 && value < count;

function validRef(ref) {
  if (!plainObject(ref) || !onlyKeys(ref, Object.keys(REF_FIELDS)) || !plainText(ref.instance, REF_FIELDS.instance)) return false;
  return Object.entries(ref).every(([key, value]) => plainText(value, REF_FIELDS[key]));
}

function validSplit(split, count) {
  if (split === null) return true;
  if (!plainObject(split) || !onlyKeys(split, ["orientation", "focused", "groups"])) return false;
  if (split.orientation !== "row" && split.orientation !== "col") return false;
  const groups = split.groups;
  if (!Array.isArray(groups) || groups.length < 2 || groups.length > MAX_SPLIT_GROUPS || !index(split.focused, groups.length)) return false;
  const seen = new Set();
  for (const group of groups) {
    if (!plainObject(group) || !onlyKeys(group, ["tabs", "active", "weight"]) || !Array.isArray(group.tabs) || group.tabs.length > count) return false;
    for (const tab of group.tabs) {
      if (!index(tab, count) || seen.has(tab)) return false;
      seen.add(tab);
    }
    if (group.active !== null && !group.tabs.includes(group.active)) return false;
    if ("weight" in group && !(Number.isFinite(group.weight) && group.weight > 0 && group.weight <= 1e6)) return false;
  }
  return true;
}

/** Is `value` a layout descriptor (the shape above, within its bounds)? Anything else is refused whole. */
export function validLayout(value) {
  if (!plainObject(value) || !onlyKeys(value, ["terminals", "split", "active"]) || !("split" in value) || !("active" in value)) return false;
  const terminals = value.terminals;
  if (!Array.isArray(terminals) || terminals.length < 1 || terminals.length > MAX_HANDED_TERMINALS) return false;
  // Every index, a hole's too (a structured clone keeps holes, and `every` would skip them).
  for (let i = 0; i < terminals.length; i++) if (!validRef(terminals[i])) return false;
  if (value.active !== null && !index(value.active, terminals.length)) return false;
  return validSplit(value.split, terminals.length);
}

/** The descriptor of what a window shows of workspace `workspace`: its terminal tabs (`tabs`, the shell's map
 * of id → tab, in strip order), the split over them, the active tab. Null when it has no terminal tab. A tab
 * of another workspace, or not a terminal, is not in it; nor is a split group's tab that isn't one of those. */
export function describeLayout(tabs, split, activeTab, workspace) {
  const ids = [], terminals = [];
  for (const [id, tab] of tabs) {
    if (tab?.kind !== "terminal" || tab.workspace !== workspace || !tab.instanceRef) continue;
    const ref = { instance: tab.instanceRef.instance };
    for (const key of ["home", "agentsRoot", "server"]) if (tab.instanceRef[key]) ref[key] = tab.instanceRef[key];
    if (!validRef(ref)) continue;
    ids.push(id); terminals.push(ref);
    if (terminals.length === MAX_HANDED_TERMINALS) break;
  }
  if (!terminals.length) return null;
  const at = (id) => { const i = ids.indexOf(id); return i < 0 ? null : i; };
  let shape = null;
  if (split && Array.isArray(split.groups) && split.groups.length >= 2) {
    const groups = split.groups.slice(0, MAX_SPLIT_GROUPS).map((group) => {
      const members = group.tabs.map(at).filter((i) => i !== null);
      // A group whose active tab doesn't move (a page, a brain, a file: slice 6a puts them in the groups) is
      // described by the terminal it shows next to them: its newest one, else none.
      const own = at(group.activeTab), active = own !== null && members.includes(own) ? own : members.at(-1) ?? null;
      return { tabs: members, active,
        ...(Number.isFinite(group.weight) && group.weight > 0 && group.weight <= 1e6 ? { weight: group.weight } : {}) };
    });
    const focused = split.groups.findIndex((group) => group.id === split.focusedGroup);
    if (groups.length >= 2) shape = { orientation: split.orientation === "col" ? "col" : "row", focused: focused >= 0 && focused < groups.length ? focused : 0, groups };
  }
  return { terminals, split: shape, active: at(activeTab) };
}

/** The layout to show here, once `layout`'s terminals are open: `tabIdOf(index)` is the tab each one opened as,
 * or null when it did not (it no longer resolves, or no longer runs). The split (split-layout.mjs's model, group
 * ids from 1) keeps every group, an empty one too. `activeTab`: the descriptor's active tab when it opened, else
 * the focused group's active one (null: that group is empty, and it is what shows), else, with no split, the
 * first tab that opened. */
export function composeLayout(layout, tabIdOf) {
  const opened = layout.terminals.map((_, i) => tabIdOf(i) ?? null);
  const idOf = (i) => (i === null || i === undefined ? null : opened[i] ?? null);
  let split = null;
  if (layout.split) {
    const groups = layout.split.groups.map((group, i) => {
      const tabs = group.tabs.map(idOf).filter((id) => id !== null);
      const active = idOf(group.active);
      return { id: i + 1, tabs, activeTab: active ?? tabs[0] ?? null, ...(group.weight ? { weight: group.weight } : {}) };
    });
    // Every terminal of a split is in a group: one the descriptor left out joins the focused group.
    const placed = new Set(groups.flatMap((group) => group.tabs));
    const loose = opened.filter((id) => id !== null && !placed.has(id));
    const into = groups[layout.split.focused];
    into.tabs.push(...loose);
    if (into.activeTab === null) into.activeTab = into.tabs[0] ?? null;
    split = { orientation: layout.split.orientation, nextId: groups.length + 1, groups, focusedGroup: layout.split.focused + 1 };
  }
  const focused = split?.groups.find((group) => group.id === split.focusedGroup);
  // Split, an empty focused group is what shows (an empty layout is a real surface, workspace-tab-memory.mjs).
  const activeTab = idOf(layout.active) ?? (split ? focused?.activeTab ?? null : opened.find((id) => id !== null) ?? null);
  return { split, activeTab };
}
