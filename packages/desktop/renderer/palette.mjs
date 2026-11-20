/* oats desktop — command palette (app.palette: ⌘K on macOS, Alt+K on
   Linux/Windows by default; the keymap engine owns the chord and its terminal policy).
   One input, two result kinds: instances (default; jump-to-terminal) and
   commands (also matched by name — ">" prefix restricts to commands).
   Instances are the sidebar's tree ordered by last focus (#1383): the sidebar's
   deployment sections, relation groups and depth, from its own builders
   (packages/client: rosterSections, roster-sections.mjs; rosterGroups and
   recencyOrder, instance-tree.mjs), given the workspace's last-focus record.
   At every level (a deployment's section, a relation cluster, a cluster's roots,
   a parent's children) a node sits where the most recently focused instance of
   its subtree puts it; never-focused nodes keep the sidebar's order after the
   rest; a child stays under its parent. A parent's children are split first,
   those that draw their parent line before the rest (#1577, packages/client
   related-work.mjs), and recency orders each part. This supersedes Spec C's flat Recent
   group; the record is still instance-recency.mjs, and the sidebar keeps its
   stable spawn order, newest first. The order is decided on the full roster: a query decides
   only which rows show, each match with its non-matching ancestors as disabled
   context rows. Each row carries the sidebar row's connectors (treeConnectors,
   instance-tree-view.mjs) and state; an instance at either end of an explicit
   sibling link (#1312; instanceSiblings, resolved per deployment over its full
   roster) says "sibling of <name>" to assistive technology, as a child says
   "under <parent>": the dotted line carries siblinghood visibly. The palette
   opens on its first selectable row: the top of the list, which the order makes
   the most recently focused path (with a query, the first match; #1391).
   While open, the palette's own chord moves the active row down (Shift + the
   chord: up), skipping context rows, and its group keys (packages/client/keymap.mjs
   PALETTE_KEYS: ⌘N / ⌥⌘N on macOS, Alt+Shift+↓ / ↑ elsewhere) move it to the
   first selectable row of the next group or of the one before, wrapping: a
   relation group (one per deployment where there are several) is one, and the
   commands after the instances are one more. They win over every binding while
   the palette is open, and only then; a footer under the list names them.
   The Desktop UI rework, slice 4 (guide v6 tour step 19): the palette is the one place to reach everything.
   Its groups, in order: Needs you (the rows with a needs-input claim, waitingClaim, newest claim first: a
   shortcut, so such a row is in the tree below as well), the recent agents (the tree above, by last focus),
   Sections (the shell's pages: Workspace and its tabs, Automations, Connections), the commands, and the souls
   ("New agent: <soul>", quickOpenRows over GET /api/agents, which open the New agent form on that soul). An
   agent row is its dot, its name and its soul. ">" restricts the list to the commands, and "+" to the souls
   (Alt+P opens the palette on "+": Quick Open's separate overlay folded into the palette).
   Overlay chrome lives in overlay-picker.mjs, the fuzzy
   matcher in packages/client/subsequence-score.mjs (shared with the TUI); this
   module owns only the palette's row semantics. */
import { runtimeState, siblingText } from "../../client/instance-presentation.mjs";
import { filterInstanceTree, instanceId, instanceSiblings } from "../../client/instance-tree.mjs";
import { rosterSections, splitByDeployment, isMultiDeployment } from "../../client/roster-sections.mjs";
import { DESKTOP_TERMS } from "./desktop-terms.mjs";
import { treeConnectors } from "./instance-tree-view.mjs";
import { createOverlayPicker } from "./overlay-picker.mjs";
import { dotColor } from "./instance-dot.mjs";
import { subsequenceScore } from "../../client/subsequence-score.mjs";
import { needsYouRows } from "../../client/waiting-on-you.mjs";
import { quickOpenRows } from "./quick-open.mjs";
import { DESKTOP_NOUNS } from "./desktop-terms.mjs";

/** The palette's groups, in their order (the Desktop UI rework, slice 4). The recent agents' rows keep the sidebar's
 * relation groups (their keys and labels), and the commands are the run of rows with no group, as before. */
export const PALETTE_GROUPS = Object.freeze({
  needsYou: Object.freeze({ key: "needs-you", label: "Needs you" }),
  sections: Object.freeze({ key: "sections", label: "Sections" }),
  souls: Object.freeze({ key: "souls", label: `New ${DESKTOP_NOUNS.instance}` }),
});
/** The order of a row's kind in the palette: needs you, recent, sections, commands, souls. */
export const PALETTE_ORDER = Object.freeze(["needs-you", "recent", "section", "command", "soul"]);

/** Commands listed at most (after every instance row; the instance list scrolls). */
export const PALETTE_COMMAND_CAP = 12;

/** Pure row computation — exported for tests. `roster` is the panel's
 * `{ instances, deployments, recent? }` (one snapshot), or just the instances
 * where there is a single deployment; `commands` the static command list, `raw`
 * the input value. `recent` is the workspace's last-focus record
 * (Map<instanceId, time>, instance-recency.mjs).
 * Every instance is listed once, in the sidebar's tree ordered by `recent`
 * (rosterSections with `lastFocus`). Instance rows carry { depth, group: { key,
 * label }, connectors, state, under?, sibling? }: `connectors` is treeConnectors
 * over the row's cluster as listed and its deployment's full roster, `state` is
 * runtimeState (running, stopped or unknown), `under` "under <parent>" for a
 * child; a row of an instance with a sibling by explicit link carries
 * `sibling: "sibling of <names>"` (siblingText over instanceSiblings, built per
 * deployment over its full roster as the sidebar resolves relations, never over
 * the listed rows), and a row without one has no `sibling` field. An ancestor
 * shown only as a match's context carries { context: true } and no run. No row
 * is marked to open on: the picker starts on the first selectable row, the top
 * of the list (with a query, the first match), #1391.
 * `roster.pins` (feature instance-pin, this computer's CLI lists it): pinned rows lead each section's order, as in
 * the sidebar, so rows never focused keep it; recency still leads (`recencyOrder`). A command with `when()` is
 * listed only while it answers true (an instance command that applies to the leader's target). */
export function paletteRows(roster, commands, raw, { openTerminal, sections = [], onSoul = null } = {}) {
  const instances = (Array.isArray(roster) ? roster : roster?.instances) || [];
  const deployments = (Array.isArray(roster) ? null : roster?.deployments) || [];
  const recent = !Array.isArray(roster) && roster?.recent instanceof Map ? roster.recent : new Map();
  const pins = !Array.isArray(roster) && roster?.pins === true;
  const souls = (!Array.isArray(roster) && Array.isArray(roster?.souls)) ? roster.souls : [];
  const cmdMode = raw.startsWith(">"), soulMode = raw.startsWith("+");
  const q = (cmdMode || soulMode ? raw.slice(1) : raw).trim();
  const rows = [];
  // Needs you: the rows with a claim, newest claim first, each its dot, its name and its soul.
  const needsYou = [];
  if (!cmdMode && !soulMode) {
    // The shared order (packages/client waiting-on-you.mjs needsYouRows), then the query.
    const claimed = needsYouRows(instances).map(({ row }) => row)
      .filter(inst => !q || subsequenceScore(`${inst.instance} ${inst.agent || ""} ${inst.repoName || ""}`, q) != null);
    for (const inst of claimed) {
      const state = runtimeState(inst);
      needsYou.push({ kind: "needs-you", label: inst.instance, detail: [inst.agent, inst.server].filter(Boolean).join(" · "),
        depth: 0, group: PALETTE_GROUPS.needsYou, connectors: [], state, color: dotColor(inst, state),
        run: () => openTerminal({ instance: inst.instance, home: inst.home, agentsRoot: inst.agentsRoot, ...(inst.server ? { server: inst.server } : {}) }) });
    }
  }
  if (!cmdMode && !soulMode) {
    // The house fuzzy matcher decides what matches; the tree path around a
    // match is kept by the identity-aware filterInstanceTree (the TUI's filter's
    // too; the sidebar has no filter).
    const matches = (inst) => !q || subsequenceScore(`${inst.instance} ${inst.agent || ""} ${inst.repoName || ""}`, q) != null;
    // Relations resolve inside a deployment, over its full roster, as the sidebar's do (#482).
    const multi = isMultiDeployment(deployments);
    const own = multi ? splitByDeployment(deployments)(instances) : null;
    const siblings = new Map(multi ? [...own.values()].flatMap((list) => [...instanceSiblings(list, { pins })]) : instanceSiblings(instances, { pins }));
    // What a query leaves of each deployment's roster: its matches and their ancestor paths.
    const visible = !q ? instances
      : multi ? [...own.values()].flatMap((list) => filterInstanceTree(list, q, matches)) : filterInstanceTree(instances, q, matches);
    const opens = (inst) => () => openTerminal({ instance: inst.instance, home: inst.home, agentsRoot: inst.agentsRoot, ...(inst.server ? { server: inst.server } : {}) });
    for (const section of rosterSections(instances, visible, deployments, DESKTOP_TERMS, { lastFocus: recent, pins })) {
      const full = section.deployment ? own.get(section.deployment.id) : instances;
      for (const each of section.groups) {
        // A group is named, and kept apart, by its deployment where there are several.
        const group = section.deployment
          ? { key: `${section.deployment.id}|${each.key}`, label: `${section.label} · ${each.label}` }
          : { key: each.key, label: each.label };
        for (const cluster of each.clusters) for (const inst of cluster.instances) {
          const depth = inst.depth || 0;
          const parent = depth > 0 && inst.parentInstance ? inst.parentInstance : null;
          const said = siblingText(siblings.get(instanceId(inst)));
          const row = {
            kind: "recent",
            label: inst.instance,
            // Its name and its soul (the dot is its state); a remote row's machine after, and an unknown state in words.
            detail: [inst.agent, inst.server, runtimeState(inst) === "unknown" ? "unknown" : null].filter(Boolean).join(" · "),
            depth,
            group,
            // The sidebar row's lines and dot: its connectors over the cluster as listed, and its state.
            connectors: treeConnectors(cluster.instances, inst, full),
            state: runtimeState(inst),
            // Its colour on that dot (instance-dot.mjs), a palette name or null.
            color: dotColor(inst, runtimeState(inst)),
            // Depth and siblinghood reach assistive technology as words (aria-level is not an option's).
            ...(parent ? { under: `under ${parent}` } : {}),
            ...(said ? { sibling: said } : {}),
          };
          if (q && !matches(inst)) row.context = true;
          else row.run = opens(inst);
          rows.push(row);
        }
      }
    }
  }
  // detail may be a function so chord labels stay live against the current keymap (rebinding in the editor updates
  // the next render).
  const scored = (list, kind, group) => {
    const out = [];
    for (const c of list) {
      if (typeof c.when === "function" && !c.when()) continue;
      const sc = q ? subsequenceScore(c.label, q) : 0;
      if (sc == null) continue;
      const detail = typeof c.detail === "function" ? c.detail() : (c.detail || "");
      out.push({ sc, kind, label: c.label, detail, dot: null, run: c.run, ...(group ? { group } : {}) });
    }
    return out.sort((a, b) => a.sc - b.sc).map(({ sc, ...row }) => row);
  };
  const sectionRows = cmdMode || soulMode ? [] : scored(sections, "section", PALETTE_GROUPS.sections);
  const commandRows = soulMode ? [] : scored(commands, "command", null).slice(0, PALETTE_COMMAND_CAP);
  // The souls: "New agent: <soul>", each opening the New agent form on that soul (onSoul).
  const soulRows = cmdMode || typeof onSoul !== "function" ? [] : quickOpenRows(souls, q, { onPick: onSoul })
    .map(({ sc, ...row }) => ({ ...row, kind: "soul", label: `New ${DESKTOP_NOUNS.instance}: ${row.label}`, group: PALETTE_GROUPS.souls }));
  return [...needsYou, ...rows, ...sectionRows, ...commandRows, ...soulRows];
}

/**
 * @param {object} deps
 * @param {(e: KeyboardEvent) => (1|-1|0)} [deps.cycleKey] while open: 1 when
 *        the event is the palette's own chord (move down), -1 for Shift + it
 *        (move up), 0 otherwise. The shell derives it from the live keymap.
 * @param {(e: KeyboardEvent) => (1|-1|0)} [deps.groupKey] while open: 1 for the
 *        next-group key (to the first selectable row of the next group), -1 for
 *        the previous-group key, 0 otherwise (paletteGroupDirection, keybindings.mjs).
 * @param {string} [deps.footer] the line under the list naming the group keys
 *        (paletteGroupHint, keybindings.mjs).
 */
export function createPalette({ loadInstances, loadSouls = null, onSoul = null, sections = () => [], openTerminal, commands = [], cycleKey, groupKey, footer, doc }) {
  // `commands` is the list itself, read at each render: a command the shell adds later is listed from then on.
  return Object.assign(createOverlayPicker({
    placeholder: `Go to an ${DESKTOP_NOUNS.instance}, a section or a command… (">" commands, "+" new ${DESKTOP_NOUNS.instance})`,
    ariaLabel: "Command palette",
    // The roster and the souls are read side by side; either one failing leaves its groups empty, never the other's.
    loadItems: async () => {
      const [roster, souls] = await Promise.all([
        (async () => { try { return await loadInstances(); } catch { return []; } })(),
        (async () => { if (!loadSouls) return []; try { return (await loadSouls())?.agents || []; } catch { return []; } })(),
      ]);
      if (Array.isArray(roster)) return souls.length ? { instances: roster, souls } : roster;
      return { ...(roster || {}), souls };
    },
    computeRows: (roster, raw) => paletteRows(roster || [], commands, raw, { openTerminal, sections: sections(), onSoul }),
    cycleKey,
    groupKey,
    footer,
    doc, // undefined: the picker's own default (the global document)
  }), { commands });
}
