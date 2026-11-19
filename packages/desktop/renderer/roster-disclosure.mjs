/* oats desktop — the sidebar roster's disclosure (the product owner, 2026-11-19).

   A row with children in its own section (the main tree or the Background section, and a deployment's part of
   it) shows that it has them: a chevron and the count of the rows under it, on its name line. The chevron points
   right while the row is collapsed and down while it is open. A click on it opens or closes the row; a click on
   the rest of the row opens its terminal as before. The keys stay the tree's (roster-keys.mjs: Right opens,
   Left closes), and the row's own `aria-expanded` says the state, so the mark adds no tab stop.

   A root of its section (a row with no parent in that section) starts collapsed in every window: by default the
   sidebar shows the top-level rows only. A row under a root starts open, so opening a root shows its group as it
   was drawn before. What the operator opens or closes is kept in memory per workspace, as a collapse always was:
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
 * and every root of its section that has children there and was not opened by hand. `children`: sectionChildren. */
export function collapsedRows(workspace, { collapsed, expanded, children }) {
  const out = new Set(collapsed);
  const under = new Set([...children.values()].flat());
  for (const id of children.keys()) {
    const key = collapseKey(workspace, id);
    if (!under.has(id) && !expanded.has(key)) out.add(key);
  }
  return out;
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

/** The mark on a parent's name line (`span.ctx-disclosure`): the chevron and the count of the rows under it. It is
 * not a control of its own: the shell's row click opens or closes the row when the click lands on it, and a screen
 * reader hears the row's `aria-expanded` and the hidden words ", N below". */
export function rowDisclosure(doc, { count }) {
  const mark = doc.createElement("span");
  mark.className = "ctx-disclosure";
  const shown = doc.createElement("span");
  shown.className = "ctx-disclosure-count"; shown.setAttribute("aria-hidden", "true"); shown.textContent = String(count);
  const spoken = doc.createElement("span");
  spoken.className = "sr-only"; spoken.textContent = `, ${count} below`;
  mark.append(iconElement(doc, "chevronRight", { size: 12, className: "shell-icon ctx-disclosure-chevron" }), shown, spoken);
  return mark;
}

/** Open (`open` true) or close a row by hand: the one place both sets change, so a root opened by hand stays open
 * and a row closed by hand stays closed until the operator changes it again. */
export function setRowOpen({ collapsed, expanded }, key, open) {
  if (open) { collapsed.delete(key); expanded.add(key); }
  else { collapsed.add(key); expanded.delete(key); }
}
