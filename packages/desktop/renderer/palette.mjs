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
   same-work.mjs), and recency orders each part. This supersedes Spec C's flat Recent
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
   Overlay chrome lives in overlay-picker.mjs (shared with Quick Open), the fuzzy
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
 * of the list (with a query, the first match), #1391. */
export function paletteRows(roster, commands, raw, { openTerminal } = {}) {
  const instances = (Array.isArray(roster) ? roster : roster?.instances) || [];
  const deployments = (Array.isArray(roster) ? null : roster?.deployments) || [];
  const recent = !Array.isArray(roster) && roster?.recent instanceof Map ? roster.recent : new Map();
  const cmdMode = raw.startsWith(">");
  const q = (cmdMode ? raw.slice(1) : raw).trim();
  const rows = [];
  if (!cmdMode) {
    // The house fuzzy matcher decides what matches; the tree path around a
    // match is kept by the identity-aware filterInstanceTree (the TUI's filter's
    // too; the sidebar has no filter).
    const matches = (inst) => !q || subsequenceScore(`${inst.instance} ${inst.agent || ""} ${inst.repoName || ""}`, q) != null;
    // Relations resolve inside a deployment, over its full roster, as the sidebar's do (#482).
    const multi = isMultiDeployment(deployments);
    const own = multi ? splitByDeployment(deployments)(instances) : null;
    const siblings = new Map(multi ? [...own.values()].flatMap((list) => [...instanceSiblings(list)]) : instanceSiblings(instances));
    // What a query leaves of each deployment's roster: its matches and their ancestor paths.
    const visible = !q ? instances
      : multi ? [...own.values()].flatMap((list) => filterInstanceTree(list, q, matches)) : filterInstanceTree(instances, q, matches);
    const opens = (inst) => () => openTerminal({ instance: inst.instance, home: inst.home, agentsRoot: inst.agentsRoot, ...(inst.server ? { server: inst.server } : {}) });
    for (const section of rosterSections(instances, visible, deployments, DESKTOP_TERMS, { lastFocus: recent })) {
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
            label: inst.instance,
            detail: [inst.server, inst.agent, inst.branch, runtimeState(inst)].filter(Boolean).join(" · "),
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
  const commandRows = [];
  for (const c of commands) {
    const sc = q ? subsequenceScore(c.label, q) : 0;
    if (sc == null) continue;
    // detail may be a function so chord labels stay live against the
    // current keymap (rebinding in the editor updates the next render).
    const detail = typeof c.detail === "function" ? c.detail() : (c.detail || "");
    commandRows.push({ sc, label: c.label, detail, dot: null, run: c.run });
  }
  commandRows.sort((a, b) => a.sc - b.sc);
  return [...rows, ...commandRows.slice(0, PALETTE_COMMAND_CAP).map(({ sc, ...row }) => row)];
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
export function createPalette({ loadInstances, openTerminal, commands = [], cycleKey, groupKey, footer, doc }) {
  return createOverlayPicker({
    placeholder: 'Jump to an instance… (">" for commands)',
    ariaLabel: "Command palette",
    loadItems: async () => { try { return await loadInstances(); } catch { return []; } },
    computeRows: (roster, raw) => paletteRows(roster || [], commands, raw, { openTerminal }),
    cycleKey,
    groupKey,
    footer,
    doc, // undefined: the picker's own default (the global document)
  });
}
