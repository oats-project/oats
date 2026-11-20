/* oats desktop — shell navigation manifest + stage-view loader.
   Extracted from shell.mjs so shell-level tests can exercise the SAME
   name→module wiring the production rail uses. shell.mjs binds these
   one-to-one. */

/** First-class stage destinations on the nav rail. Every entry's `name`
 * must resolve through loadStageView to a mount-exporting view module.
 * There is deliberately NO "instances" stage: the instances context is the
 * shell's permanent sidebar roster (below the rail), not a rail destination
 * (scope correction of PR #29 — the human rejected the extra tab/sidebar). */
export const NAV = [
  // Home (the Desktop UI rework, slice 2): what needs you, what you have, and the overview whose rows open the
  // Workspace page on a tab. A workspace lands on it. It has no key of its own yet (slice 4's table decides one):
  // the palette's Home section opens it.
  { name: "home", label: "Home", icon: "workspace", title: "Home" },
  // The Workspace page (Workspace overview), which opens on Souls: no pinned row of its own since slice 2 (Home's
  // overview opens it on a tab, and its row stays Home's while it shows). ⌘2 / Ctrl+2 and ⌘3 / Ctrl+3 stay theirs
  // (bound by id), and so does its palette command, View: Workspace overview.
  { name: "spawn", label: "Workspace overview", icon: "workspace", title: "Workspace overview", pinned: false },
  // Schedules and Triggers are one destination with two subtabs (human, 2026-09-28).
  { name: "automations", label: "Automations", icon: "automations", title: "Automations" },
];

/** Destinations that are a tab of a NAV page, not a page of their own (2026-10-26): Machines, the
 * Deployments page of before (#482: the overview trees, split by deployment, one tab each), is a tab of
 * the Workspace page, before Setup. Its action (`stage.hierarchy`, ⌘1 / Ctrl+1), its palette command and every
 * open of the name land on that page and tab. Its `label` says where that is, the page's label, then the
 * tab's ("View: Workspace › Machines" in the palette and the shortcuts editor). */
export const NAV_TABS = [
  { name: "hierarchy", label: "Workspace › Machines", page: "spawn", tab: "machines" },
];

/** The NAV_TABS entry `name` opens, or null for a page of its own (or nothing). */
export function navTab(name) {
  return NAV_TABS.find((entry) => entry.name === name) ?? null;
}

/** The NAV entries the sidebar pins as rows (Home, then Automations): every one not marked `pinned: false`. */
export const PINNED = NAV.filter((v) => v.pinned !== false);

/** The pinned row that stands for a stage: its own, else Home's for the Workspace page, which Home opens. */
export function pinnedRowFor(name) {
  return name === "spawn" ? "home" : name;
}

/** Sidebar mode a stage view pairs with (spawn shows the souls context). */
export function stageSidebarMode(name) {
  return name === "spawn" ? "souls" : "overview";
}

/** The exact dynamic import the stage host performs. Kept here so tests can
 * prove every NAV entry loads a real mount-exporting module. */
export function loadStageView(name) {
  return import(new URL(`./views/${name}.mjs`, import.meta.url).href);
}
