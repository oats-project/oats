/* oats desktop — the sidebar roster's disclosure (the product owner, 2026-11-19).

   A row with children in its own section (the main tree or the Background section, and a deployment's part of
   it) shows that it has them: a chevron and the count of the rows under it, first on its name line, before the
   name, where the row tools overlaying the row's end on hover never cover it (review round 3). The chevron points
   right while the row is collapsed and down while it is open. A click on it opens or closes the row; a click on
   the rest of the row opens its terminal as before. The keys stay the tree's (roster-keys.mjs: Right opens,
   Left closes), and the row's own `aria-expanded` says the state, so the mark adds no tab stop.

   A root of its section (a row with no parent in that section) starts collapsed in every window: by default the
   sidebar shows the top-level rows only. A row under a root starts open, so opening a root shows its group as it
   was drawn before. A row whose lifecycle takes it (a spawn in flight, or a home held while it is spawning,
   retiring or left half done: shell.mjs draws its state there) is always drawn open, whatever was chosen for it:
   its lines have no room for the needs-input roll-up, so a collapse there would hide a waiting child with no mark.
   It wears no disclosure and the tree keys do not collapse it; a choice made by hand before is kept, and applies
   again once its lifecycle is over. A root with a pinned row under it in its section (feature instance-pin; spec B
   of the pinned instances, agreed with this module's lead) starts open, so the pinned row is seen; closed by hand,
   it stays closed (`startsOpen`). What the operator opens or closes is kept in memory per workspace, as a
   collapse always was:
   `collapsed` holds the rows closed by hand, `expanded` the roots opened by hand. A waiting row a default
   collapse hides rolls up onto its root ("! N below") as any collapse's does (waitingRollup; decision
   needs-input-preserves-liveness-and-recognition). */

import { instanceId, rosterParentId, collapseKey } from "../../client/instance-tree.mjs";
import { iconElement } from "./shell-icons.mjs";

/** The children of each row inside the row's own section: Map(instanceId(parent) → [instanceId(child)]), in
 * roster order. A child whose parent is painted in another section is a root of its own section here, and its
 * parent has nothing to collapse for it. `section(row)`: shell.mjs's rosterSectionKey. */
export function sectionChildren(instances, section) {
  const byId = new Map(instances.map((row) => [instanceId(row), row]));
  const out = new Map();
  for (const child of instances) {
    const id = instanceId(child), pid = rosterParentId(instances, id), parent = pid ? byId.get(pid) : null;
    if (!parent || pid === id || section(parent) !== section(child)) continue;
    if (!out.has(pid)) out.set(pid, []);
    out.get(pid).push(id);
  }
  return out;
}

/** The collapse keys the roster draws collapsed (instanceVisibleInTree, waitingRollup): the rows closed by hand,
 * and every root of its section that has children there, was not opened by hand and that `startsOpen(id)` does not
 * open by default (a root with a pinned row under it); never a row `staysOpen(id)` says its lifecycle takes, closed
 * by hand or not. `startsOpen` changes only the default: a root closed by hand stays closed. `children`:
 * sectionChildren. */
export function collapsedRows(workspace, { collapsed, expanded, children, staysOpen = () => false, startsOpen = () => false }) {
  const out = new Set(collapsed);
  const under = new Set([...children.values()].flat());
  for (const id of children.keys()) {
    const key = collapseKey(workspace, id);
    if (staysOpen(id)) out.delete(key);
    else if (!under.has(id) && !expanded.has(key) && !startsOpen(id)) out.add(key);
  }
  return out;
}

/** Whether a row under `id` in its section, at any depth, passes `test(rowId)` (cycle-safe). `children`:
 * sectionChildren. The row itself is not asked. */
export function anyBelow(children, id, test) {
  const seen = new Set([id]), stack = [...(children.get(id) || [])];
  while (stack.length) {
    const next = stack.pop();
    if (seen.has(next)) continue;
    seen.add(next);
    if (test(next)) return true;
    stack.push(...(children.get(next) || []));
  }
  return false;
}

/** How many rows sit under `id` in its section, at every depth (cycle-safe). `children`: sectionChildren. */
export function rowsUnder(children, id) {
  const seen = new Set([id]), stack = [...(children.get(id) || [])];
  let count = 0;
  while (stack.length) {
    const next = stack.pop();
    if (seen.has(next)) continue;
    seen.add(next); count++;
    stack.push(...(children.get(next) || []));
  }
  return count;
}

/** The mark on a parent's name line (`mark`, `span.ctx-disclosure`, aria-hidden): the chevron and the count of the
 * rows under it, which the shell puts before the name. It is not a control of its own: the shell's row click opens or
 * closes the row when the click lands on it. A screen reader hears the row's `aria-expanded` and `spoken`, the hidden
 * words ", N below", which the shell puts after the name so the name is still said first. */
export function rowDisclosure(doc, { count }) {
  const mark = doc.createElement("span");
  mark.className = "ctx-disclosure"; mark.setAttribute("aria-hidden", "true");
  const shown = doc.createElement("span");
  shown.className = "ctx-disclosure-count"; shown.textContent = String(count);
  mark.append(iconElement(doc, "chevronRight", { size: 12, className: "shell-icon ctx-disclosure-chevron" }), shown);
  const spoken = doc.createElement("span");
  spoken.className = "sr-only"; spoken.textContent = `, ${count} below`;
  return { mark, spoken };
}

/** Open (`open` true) or close a row by hand: the one place both sets change, so a root opened by hand stays open
 * and a row closed by hand stays closed until the operator changes it again. */
export function setRowOpen({ collapsed, expanded }, key, open) {
  if (open) { collapsed.delete(key); expanded.add(key); }
  else { collapsed.add(key); expanded.delete(key); }
}
