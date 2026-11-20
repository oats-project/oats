/** The Desktop's own half of the roster tree: the connectors it draws, its terminal tabs' keys, the
 * focus and scroll it keeps across a rebuild, the roster's count line and loading state, and each row's name. The tree
 * itself (identity, relations, groups, order, visibility) is the shared packages/client/instance-tree.mjs. */
import { createDataState, statusLine, skeleton, skeletonBlock, ROSTER_STALE_TITLE } from './loading.mjs';
import { instanceId, resolveLinkId, findRosterInstance, siblingLinksOf } from '../../client/instance-tree.mjs';
import { instanceDisplayName } from '../../client/instance-display-name.mjs';
import { drawsParentLine, drawsSiblingLink } from '../../client/related-work.mjs';
import { iconElement } from './shell-icons.mjs';

/** An instance row's name (0.68.1, the product owner): the words shown (instanceDisplayName: "Oats expert maintainer
 * lanes"), the real name kept where it identifies the instance. The words are hidden from assistive tech and a visually
 * hidden copy of the real name is read in their place, so the row's accessible name is the name a search, a copy and
 * the CLI use; the real name is also the element's data-name. The title, the hover card, Quick Open and tabs keep it. */
export function rosterName(doc, instanceName) {
  const name = doc.createElement("span");
  name.className = "ctx-name";
  name.dataset.name = instanceName;
  const shown = doc.createElement("span");
  shown.setAttribute("aria-hidden", "true");
  shown.textContent = instanceDisplayName(instanceName) || instanceName;
  const real = doc.createElement("span");
  real.className = "sr-only";
  real.textContent = instanceName;
  name.append(shown, real);
  return name;
}

/** A roster row's state in words for assistive technology (slice 1: the hover card said it, and the dot says it by
 * shape and colour alone): ", running", ", stopped" or ", status unknown", visually hidden after its second line. */
export function stateSpan(doc, state) {
  const span = doc.createElement("span"); span.className = "sr-only ctx-state";
  span.textContent = `, ${state === "running" ? "running" : state === "stopped" ? "stopped" : "status unknown"}`;
  return span;
}

/** A roster row's relations in words for assistive technology (the roster's lines, drawn for related work only,
 * are aria-hidden), ", under p, related work, sibling of s", visually hidden after its lines; null when it has none.
 * The words are the command palette's ("under …", siblingText's "sibling of …"). */
export function relationSpan(doc, words) {
  if (!words) return null;
  const span = doc.createElement("span"); span.className = "sr-only ctx-relation"; span.textContent = `, ${words}`;
  return span;
}

/** A pinned row's mark on its name line (feature instance-pin): the pin icon, in the muted text colour, as an image
 * named "Pinned", so the pin is seen and heard, never inferred from the row's place, and has no colour-only meaning. */
export function pinnedMark(doc) {
  const mark = doc.createElement("span");
  mark.className = "ctx-pin";
  mark.setAttribute("role", "img");
  mark.setAttribute("aria-label", "Pinned");
  mark.append(iconElement(doc, "pin", { size: 12 }));
  return mark;
}

/** Agent-group boundary for the instances sidebar (Workspace v4): no title,
 * a 6px gap (2026-10-23; was 14px), with the cluster's indent and its root,
 * and the boundary is still exposed to assistive technology (role=separator with the group's name and
 * the number of rows shown under it). The group is the relation cluster
 * (never the repo), decided on the full roster, so a collapse never moves
 * a row to another group; unrelated instances share one
 * "independent" group. Importable so the regression exercises the exact
 * builder the shell uses. */
export function clusterSeparator(doc, { label, count } = {}) {
  const gap = doc.createElement("div");
  gap.className = "ctx-group"; gap.setAttribute("role", "separator");
  gap.setAttribute("aria-label", `${label}, ${count} ${count === 1 ? "instance" : "instances"}`);
  gap.dataset.group = label;
  return gap;
}

/** Design connectors for one visible row, drawn from the dots (Redesign v3), for related work only (no flag, no
 * line: packages/client/related-work.mjs): solid parent→child elbows (rounded into the child dot), solid
 * pass-through lines for open ancestor branches and beside a non-last child's elbow, and a DOTTED dot-to-dot link
 * between top-level rows a related sibling link joins. The dotted link sits on the dot column and the solid lineage
 * just right of it (shell.css --tree-branch-offset), so a row between two joined roots draws its own
 * `link-through` and never lets a solid line stand in for it (#1312).
 * The solid lineage joins only a child that draws its parent line (#1577, `drawsParentLine`; the gate is stamped
 * on each row by the panel): a child that does not keeps its indent and gets no elbow, and its parent's stem and
 * vertical do not reach it. The dotted link is `siblingLinkSpans`'. The lines are aria-hidden; the row's words say
 * the same (`relationSpan`). `items` is the rendered group order. */
export function treeConnectors(items, item, allInstances = items) {
  const at = items.indexOf(item), depth = item.depth || 0;
  const segments = treeGuideSegments(items, item, allInstances);
  const out = [];
  segments.forEach((segment, level) => {
    if (segment === "continue") out.push({ kind: "line", level });
    // A branch keeps its vertical whole through the row: a full-height line beside the elbow, whose
    // curve leaves it. A half-height `down` from 50% left a notch above the elbow's rounded corner.
    else if (segment === "branch") out.push({ kind: "elbow", level }, { kind: "line", level });
    else if (segment === "end") out.push({ kind: "elbow", level });
  });
  // The stem: an expanded parent's own line leaves its dot downward to the
  // first child's elbow (the child is the very next rendered item), when that child draws its line.
  const next = at >= 0 ? items[at + 1] : null;
  if (next && (next.depth || 0) === depth + 1 && drawsParentLine(next)) out.push({ kind: "down", level: depth });
  if (at < 0) return out;
  const { spans, joined } = siblingLinkSpans(items, allInstances);
  // A top-level row no related link joins is a gap in the line, and so are the rows of its block (its descendants,
  // which follow it): none carries a dotted segment, so nothing touches its dot. The line above ends at the bottom
  // edge of the row before, and starts again at the top edge of the row after (the lead's choice B, 2026-11-20:
  // the roster's order stays as it is).
  let block = at;
  while (block > 0 && (items[block].depth || 0)) block--;
  if ((items[block].depth || 0) || !joined.has(block)) return out;
  if (!depth) {
    if (spans.some(([from, to]) => from < at && at <= to)) out.push({ kind: "link-in", level: 0 });
    if (spans.some(([from, to]) => from <= at && at < to)) out.push({ kind: "link-out", level: 0 });
  } else if (spans.some(([from, to]) => from < at && at < to)) out.push({ kind: "link-through", level: 0 });
  return out;
}

/** The dotted links of one rendered group: `spans`, one `[from, to]` pair of `items` indexes per related sibling
 * link (from < to), and `joined`, the set of indexes a span ends at. A link is a top-level row that draws it
 * (related-work.mjs `drawsSiblingLink`) whose `siblingInstance` resolves (over `allInstances`, by identity, as the
 * tree does) to another top-level row shown in `items`. The links are edges, not a star: S may link to R and T to S.
 * A link to a row that is hidden, filtered out, or not top-level draws nothing. */
export function siblingLinkSpans(items, allInstances = items) {
  const byName = new Map();
  for (const candidate of allInstances) {
    if (!byName.has(candidate.instance)) byName.set(candidate.instance, []);
    byName.get(candidate.instance).push(candidate);
  }
  const roots = new Map();
  items.forEach((candidate, index) => { if (!(candidate.depth || 0)) roots.set(instanceId(candidate), index); });
  const spans = [], joined = new Set();
  items.forEach((candidate, index) => {
    if ((candidate.depth || 0) || !drawsSiblingLink(candidate)) return;
    for (const name of siblingLinksOf(candidate)) {
      const other = roots.get(resolveLinkId(candidate, name, byName));
      if (other === undefined || other === index) continue;
      spans.push([Math.min(index, other), Math.max(index, other)]);
      joined.add(index).add(other);
    }
  });
  return { spans, joined };
}

/** The one DOM builder for a row's connectors (`treeConnectors`' answer), shared by the sidebar's rows (a
 * roster row and a pending spawn's) and the command palette's tree rows (overlay-picker.mjs): an aria-hidden
 * `.ctx-guides` holding one `.ctx-guide <kind>` per connector at its `--guide-level`. shell.css positions them
 * from the custom properties each row kind sets (`--tree-step`, `--tree-branch-offset`, `--row-gap`). */
export function treeGuides(doc, connectors) {
  const guides = doc.createElement("span");
  guides.className = "ctx-guides";
  guides.setAttribute("aria-hidden", "true");
  for (const { kind, level } of connectors) {
    const guide = doc.createElement("span");
    guide.className = `ctx-guide ${kind}`;
    guide.style.setProperty("--guide-level", String(level));
    guides.append(guide);
  }
  return guides;
}

/** Terminal-tab dedup key for an instance reference: workspace-scoped and
 * IDENTITY-scoped, so two same-named instances from different agents roots
 * are different terminals (review 46f3fdc). Bare-name refs key by name
 * (legacy callers; findRosterInstance already refuses ambiguous names). */
export function terminalKey(workspace, ref) {
  const id = typeof ref === "string" ? ref : instanceId(ref);
  return `term:${workspace}:${id}`;
}

/** Resolve a terminal-open reference and mint its canonical dedup key — in
 * that ORDER (review 7d740f9): the key must derive from the RESOLVED roster
 * instance, never the caller's ref shape, so a bare-name open and a sidebar
 * object open of the same identity share one tab, and a stale bare-name
 * tab can never be activated once the name has become ambiguous (resolution
 * refuses first). Returns { inst, key } or { error: "ambiguous"|"unknown" }.
 * Importable so the ordering regression exercises this exact layer. */
export function resolveTerminalOpen(instances, ref, workspace) {
  const name = typeof ref === "string" ? ref : ref.instance;
  const inst = findRosterInstance(instances, ref);
  if (!inst) {
    const dup = instances.filter((i) => i.instance === name).length > 1;
    return { error: dup ? "ambiguous" : "unknown", name };
  }
  return { inst, key: terminalKey(workspace, inst), name };
}

/** VS Code-style guide segments for one row in a flattened parent-first tree.
 * `continue` is an ancestor/sibling vertical; `branch` has a later sibling and
 * an elbow; `end` is the final sibling, stopping at its elbow; `none` suppresses
 * an exhausted ancestor line through deeper descendants, and the row's own segment when it does not draw
 * its parent line (#1577, `drawsParentLine`: related work only). A vertical counts only later siblings that draw theirs: under
 * one parent those come first (instance-tree.mjs `clusterInstances`), so it ends at the last one.
 * Pass the full roster as allInstances when items is a cluster/filtered subset:
 * resolve parent names there first, using the same identity rules as clustering.
 * Then walk only visible ancestry and count only visible siblings — a hidden
 * parent stops the path, never falling back to a visible same-named twin. */
export function treeGuideSegments(items, item, allInstances = items) {
  const byName = new Map();
  for (const candidate of allInstances) {
    if (!byName.has(candidate.instance)) byName.set(candidate.instance, []);
    byName.get(candidate.instance).push(candidate);
  }
  const parentIdOf = new Map();
  for (const candidate of allInstances) {
    const id = instanceId(candidate);
    const pid = candidate.parentInstance ? resolveLinkId(candidate, candidate.parentInstance, byName) : null;
    if (pid && pid !== id) parentIdOf.set(id, pid);
  }
  const positions = new Map(items.map((candidate, index) => [instanceId(candidate), index]));
  const chain = [];
  const seen = new Set();
  let cursor = instanceId(item);
  while (positions.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor);
    const pid = parentIdOf.get(cursor);
    if (!pid || !positions.has(pid)) break;
    chain.unshift(cursor);
    cursor = pid;
  }
  return chain.map((branch, index) => {
    const at = positions.get(branch);
    const hasLaterSibling = items.slice(at + 1)
      .some((candidate) => parentIdOf.get(instanceId(candidate)) === parentIdOf.get(branch) && drawsParentLine(candidate));
    const current = index === chain.length - 1;
    if (!current) return hasLaterSibling ? "continue" : "none";
    // No elbow; a later sibling that draws (never, in the roster's order) would still take the vertical past it.
    if (!drawsParentLine(item)) return hasLaterSibling ? "continue" : "none";
    return hasLaterSibling ? "branch" : "end";
  });
}

/** Capture focus identity + scroll before a keyed rebuild and return a restore
 * callback. Both disclosure and terminal buttons carry these data attributes. */
export function captureTreeRenderState(listEl) {
  const active = listEl.ownerDocument.activeElement;
  const inside = active && listEl.contains(active);
  const identity = inside ? {
    instance: active.dataset.treeInstance,
    control: active.dataset.treeControl,
  } : null;
  const scrollTop = listEl.scrollTop;
  return () => {
    if (!identity?.instance || !identity?.control) {
      listEl.scrollTop = scrollTop;
      return false;
    }
    const replacement = [...listEl.querySelectorAll("[data-tree-instance][data-tree-control]")]
      .find((element) => element.dataset.treeInstance === identity.instance
        && element.dataset.treeControl === identity.control
        && !element.disabled);
    // Chromium normally scrolls focused controls into view. preventScroll is
    // the primary guard; restoring afterward is a fallback for older engines
    // and ensures row reordering cannot overwrite the user's saved position.
    replacement?.focus({ preventScroll: true });
    listEl.scrollTop = scrollTop;
    return listEl.ownerDocument.activeElement === replacement;
  };
}

/** A first-launch request dispatched with ws="" may complete before or after
 * another view silently adopts the same server-resolved workspace. Both are
 * owned; a real generation/workspace change is not. A STALE dispatch (a
 * persisted selection the served list no longer contains, see
 * staleWorkspaceSelection) is resolved the same way and owned under the same
 * rule: the selection may still be current, or the other path may already
 * have adopted the served workspace. */
export function rosterResponseOwns({ dispatchWorkspace, responseWorkspace, currentWorkspace,
  dispatchGeneration, currentGeneration, staleDispatch = false }) {
  if (dispatchGeneration !== currentGeneration) return false;
  return currentWorkspace === dispatchWorkspace
    || ((!dispatchWorkspace || staleDispatch) && currentWorkspace === responseWorkspace);
}

/** Roster count line, "● 4 running · 2 stopped" (Redesign v3); unknown
 * liveness is named, never folded into either bucket.
 * `pending`: no read of this subject has succeeded yet, so the count is a
 * skeleton pill (reserving its width), never "0 running" (desktop/loading-states).
 * `failed`: the read failed with no data: the reserved box, empty and still.
 * `stale`: the last read failed and the count is the last observation. */
export function renderRosterCount(el, instances, { pending = false, stale = false, failed = false } = {}) {
  if (!el) return;
  const doc = el.ownerDocument;
  // Failed with no data: nothing is loading, so no shimmering pill — the box stays reserved, empty and still.
  if (failed) {
    if (el.dataset.rosterCount !== "failed") { const reserve = doc.createElement("span"); reserve.className = "ctx-count-reserve"; reserve.setAttribute("aria-hidden", "true"); el.replaceChildren(reserve); }
    el.dataset.rosterCount = "failed"; el.removeAttribute("title"); delete el.dataset.stale;
    return;
  }
  if (pending) {
    if (el.dataset.rosterCount !== "pending") el.replaceChildren(skeleton(doc, "pill"));
    el.dataset.rosterCount = "pending"; el.removeAttribute("title"); delete el.dataset.stale;
    return;
  }
  // Same tri-state as runtimeState(): only reported booleans count.
  const running = instances.filter((i) => i.running === true).length;
  const stopped = instances.filter((i) => i.running === false).length;
  const unknown = instances.length - running - stopped;
  const dot = doc.createElement("span"); dot.className = "ctx-count-dot"; dot.setAttribute("aria-hidden", "true");
  // The head says how many are running (human, 2026-09-26); the full breakdown stays in its title.
  // Stale: the count is the last observation, said to AT (a hidden span), shown muted (shell.css
  // reads data-stale) and titled; the visible number stays, because it is what was last observed.
  const last = doc.createElement("span"); last.className = "loading-sr ctx-count-stale"; last.textContent = "Last observation: ";
  el.replaceChildren(...(stale ? [last] : []), ...(running ? [dot] : []), doc.createTextNode(`${running} running`));
  el.dataset.rosterCount = "ready";
  const breakdown = [`${running} running`, `${stopped} stopped`, ...(unknown ? [`${unknown} unknown`] : [])].join(" · ");
  el.title = stale ? `Last observation — ${breakdown}` : breakdown;
  if (stale) el.dataset.stale = "1"; else delete el.dataset.stale;
}

/* ── the roster's loading state (desktop/loading-states) ─────────────────── */
/** Why a stopped row's Start, and the row's context menu, are held while the roster is stale: the reason the row
 * carries for the pointer (title) and for assistive tech (aria-description), since a greyed look alone says nothing. */
export { ROSTER_STALE_TITLE };
/** The pending skeleton: five roster rows, the height of the real ones. */
export const ROSTER_SKELETON_ROWS = 5;

/** The sidebar foot's Spawn instance while it can take focus, else null. */
function spawnAction(rosterEl) {
  const spawn = rosterEl.ownerDocument.getElementById("sidebar-spawn");
  return spawn && !spawn.disabled && !spawn.closest("[hidden]") ? spawn : null;
}

/** The sidebar roster's data-state controller (renderer/loading.mjs), wired
 * to the shipped chrome of `#instance-roster`:
 *   region / skeletonHost   .ctx-list  (aria-busy while pending; the skeleton or the failed block live here)
 *   indicatorHost           .ctx-head  ("Refreshing…" after the count)
 *   noticeHost              .ctx-status, created between the head and the list (the stale line + Retry)
 *   status                  a visually hidden role="status" line appended to the roster (the sidebar shows none)
 *   focusFallback           the roster's current row, else the foot's Spawn instance (an empty roster), else the
 *                           workspace list's stop or its Add, when a focused Retry has to go
 * Test DOMs may lack the head: the controller then has
 * no indicator host and the status host sits right before the list.
 * `now` / `setTimeout` / `clearTimeout` are the primitive's injectable clock. */
export function createRosterLoading(doc, rosterEl, { onRetry = null, now, setTimeout, clearTimeout } = {}) {
  const listEl = rosterEl.querySelector(".ctx-list");
  const status = statusLine(doc, { visuallyHidden: true });
  status.classList.add("ctx-loading-status");
  rosterEl.append(status);
  let noticeHost = rosterEl.querySelector(".ctx-status");
  if (!noticeHost) {
    noticeHost = doc.createElement("div"); noticeHost.className = "ctx-status";
    listEl.before(noticeHost);
  }
  // createDataState's defaults apply on undefined, so the clock passes straight through.
  return createDataState({
    doc, noun: "instances", region: listEl, skeletonHost: listEl,
    skeleton: () => skeletonBlock(doc, "roster-row", { count: ROSTER_SKELETON_ROWS }),
    status, indicatorHost: rosterEl.querySelector(".ctx-head"), noticeHost, onRetry,
    // As the shell's rosterEntry: an empty roster's way in is its one action, the foot's Spawn instance.
    focusFallback: () => rosterEl.querySelector('.ctx-list .ctx-inst[tabindex="0"]') || rosterEl.querySelector(".ctx-list .ctx-inst")
      || spawnAction(rosterEl) || doc.querySelector('#ws-options [tabindex="0"]') || doc.getElementById("ws-add-open"),
    now, setTimeout, clearTimeout,
  });
}

/** What one roster paint depends on, as a string: a poll whose signature
 * equals the last painted one rebuilds nothing. `facts` carries whatever the
 * paint reads besides the instances (workspace, panel error, deployment
 * note, the active terminal key…). */
export function rosterSignature(instances, facts = {}) {
  return JSON.stringify([facts, instances]);
}
