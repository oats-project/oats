/* oats desktop — the Graph (the Desktop UI rework, slice 6b; guide tour step 28): who started whom, and where it runs.
   A stage view on the shell's mount(el, ctx) contract, a page of its own: Home › Graph, the palette's "Workspace:
   Graph". It replaces the Machines tab's canvas (views/hierarchy.mjs until slice 6b), and Machines is the list.

   - Every machine of the view is a column, this computer's first, its agents an outline tree under "started by" edges
     (packages/client/instance-graph.mjs, the TUI's to draw too): a node is the roster's dot (its needs-input mark
     included), the agent's name and its soul; a child doing its parent's work says "same work" on its node, in words.
     "You" is the root above the agents a human started that have no parent. A parent on another machine is drawn
     dotted between the columns, and its node says where in words. m toggles one field: every agent in one tree, its
     machine on its node.
   - The facts are the roster's the sidebar shows (ctx.homeRoster, its paints through ctx.subscribeHomeRoster, as
     Home reads them): its loading, failed, unavailable and empty states, its stale rule and its held retires. This
     view reads nothing of its own but an agent's recent events, when asked.
   - Keys, on a focused node: ←→ between machines, ↑↓ between the agents of a column (Home, End), Enter opens the agent
     as the roster's Enter does (ctx.openAgent), m columns ⇄ one field, + and − zoom, 0 fits; the menu key (Shift+F10,
     a right-click) opens the node's menu: Open terminal, Details, Open soul, Recent events…. Every node is a treeitem
     with a roving tabindex, a visible focus and its whole story as its name ("<name>, <soul>, on <machine>, started by
     <parent or you>, <state>"). Drag pans and the wheel scrolls; Ctrl/⌘ + the wheel zooms.
   - Copy reads its nouns from DESKTOP_NOUNS. Nothing moves on its own, so reduced motion has nothing to stop. */
import { instanceGraph, graphStops } from "../../../client/instance-graph.mjs";
import { instanceId, heldHome } from "../../../client/instance-tree.mjs";
import { rosterRowFacts } from "../../../client/roster-row-facts.mjs";
import { runtimeState } from "../../../client/instance-presentation.mjs";
import { waitingClaim } from "../../../client/waiting-on-you.mjs";
import { serverLabel } from "../../../client/remote-address.mjs";
import { DESKTOP_NOUNS, DESKTOP_TERMS } from "../desktop-terms.mjs";
import { iconElement } from "../shell-icons.mjs";
import { paintDotColor } from "../instance-dot.mjs";
import { keymapTakes, registerAction } from "../keybindings.mjs";
import { resolveViewKey } from "../view-keys.mjs";
import { onDeploymentTabRequest } from "../deployment-tabs.mjs";
import { deploymentsPageCSS, deploymentReasonBlock, deploymentHasWords } from "../deployments-page.mjs";
import { splitByDeployment, deploymentState } from "../../../client/roster-sections.mjs";
import { whenRightButtonReleased } from "../context-menu-release.mjs";
import { createInstanceEventsView, instanceEventsCSS } from "../instance-events-view.mjs";
import { workspaceGeneration, onWorkspaceChange, rowDeployment } from "./common.mjs";

export const GRAPH_COPY = Object.freeze({
  title: "Graph",
  lead: `Who started whom, and where each ${DESKTOP_NOUNS.instance} runs.`,
  you: "You",
  sameWork: "same work",
  thisComputer: "this computer",
  field: "All machines",
  reading: `Reading your ${DESKTOP_NOUNS.instances}…`,
  failed: `Couldn't read your ${DESKTOP_NOUNS.instances}.`,
  empty: `No ${DESKTOP_NOUNS.instances} yet.`,
  emptyColumn: `No ${DESKTOP_NOUNS.instances} here.`,
  modeColumns: "Machines as columns",
  modeField: "One field",
});

/* Geometry, in stage pixels (the zoom scales the stage). */
export const GRAPH_GEOMETRY = Object.freeze({ COL_W: 300, FIELD_W: 420, COL_GAP: 64, HEAD: 58, ROW: 52, NODE_H: 42, IND: 24, MAX_INDENT: 6, INSET: 12, PAD: 24 });
const G = GRAPH_GEOMETRY, Z_MIN = 0.3, Z_MAX = 2, Z_STEP = 1.2, DRAG_THRESHOLD = 4;

export const graphCSS = `
.graph { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--bg); color:var(--fg);
  font-family:var(--ui-font, system-ui); font-size:13px; line-height:1.4; }
.graph * { box-sizing:border-box; }
.graph-bar { flex:none; display:flex; align-items:center; flex-wrap:wrap; gap:6px 16px; padding:14px calc(16px + var(--main-trail-inset, 0px)) 12px calc(20px + var(--main-lead-inset, 0px));
  border-bottom:1px solid var(--border); background:var(--surface); }
.graph-titles { display:flex; flex-direction:column; gap:2px; flex:1 1 280px; min-width:0; }
.graph-title { margin:0; font-size:18px; font-weight:650; line-height:1.25; }
.graph-lead { margin:0; color:var(--muted); font-size:12.5px; }
.graph-tools { display:flex; align-items:center; gap:6px; }
.graph-mode { color:var(--muted); font-size:12px; white-space:nowrap; }
.graph-mode kbd, .graph-hint kbd { font:inherit; font-weight:600; color:var(--fg); }
.graph.oats-view button.graph-tool { display:inline-flex; align-items:center; justify-content:center; gap:6px; height:28px; min-height:28px; min-width:28px; padding:0 8px;
  border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--fg); font:inherit; font-size:12px; font-weight:600; cursor:pointer; }
.graph.oats-view button.graph-tool:hover { background:var(--surface-2); }
.graph.oats-view button.graph-tool:focus-visible { background:var(--sel); }
.graph-state { flex:none; margin:0; padding:16px 20px; color:var(--muted); font-size:13px; display:flex; align-items:center; gap:12px; }
.graph-state.failed { color:var(--fg); }
.graph-state[hidden] { display:none; }
.graph-canvas { position:relative; flex:1; min-height:0; overflow:hidden; cursor:grab; }
.graph-canvas.panning { cursor:grabbing; }
.graph-canvas[hidden] { display:none; }
.graph-stage { position:absolute; left:0; top:0; transform-origin:0 0; }
.graph-col { position:absolute; border:1px solid var(--border); border-radius:10px; background:var(--surface-2); }
.graph-col-head { position:absolute; left:14px; right:14px; top:10px; display:flex; flex-direction:column; gap:1px; min-width:0; }
.graph-col-name { font-size:13px; font-weight:650; color:var(--fg); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.graph-col-sub { font-size:11.5px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.graph-col-empty { position:absolute; left:14px; color:var(--muted); font-size:12px; }
.graph-edges { position:absolute; left:0; top:0; overflow:visible; pointer-events:none; }
.graph-edges path { fill:none; stroke:var(--graph-edge); stroke-width:1.5; }
/* A parent on another machine: dotted (its node says so in words too). */
.graph-edges path.cross { stroke-dasharray:1.5 5; stroke-linecap:round; stroke-width:2; }
.graph-node { position:absolute; display:flex; align-items:center; gap:10px; height:${G.NODE_H}px; padding:0 10px 0 12px; --row-solid:var(--surface);
  border:1px solid var(--border); border-radius:7px; background:var(--surface); color:var(--fg); cursor:pointer; user-select:none; }
.graph-node:hover { background:var(--surface-2); --row-solid:var(--surface-2); }
.graph-node.stopped { border-style:dashed; }
/* Keyboard focus: the house's tint and its 1px inset accent edge (the global :focus-visible), the border in accent too. */
.graph-node:focus-visible { border-color:var(--accent); background:var(--sel); --row-solid:var(--sel); }
.graph-node-copy { display:flex; flex-direction:column; min-width:0; flex:1; }
.graph-node-name { font-weight:600; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.graph-node-sub { color:var(--muted); font-size:11.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.graph-node-sub b { font-weight:600; color:var(--fg); }
.graph-you { position:absolute; display:inline-flex; align-items:center; height:24px; padding:0 12px; border:1px solid var(--border); border-radius:12px;
  background:var(--surface); color:var(--fg); font-size:12px; font-weight:650; }
.graph-zoom { position:absolute; right:14px; bottom:14px; z-index:3; display:flex; gap:4px; padding:3px; border:1px solid var(--border); border-radius:8px;
  background:var(--surface); box-shadow:var(--shadow); }
.graph-hint { position:absolute; left:14px; bottom:14px; z-index:3; margin:0; padding:4px 8px; border-radius:6px; background:var(--surface); color:var(--muted); font-size:11.5px; }
.graph-pop { position:fixed; z-index:20; width:320px; max-width:calc(100vw - 16px); max-height:calc(100vh - 16px); overflow:auto; margin:0; padding:12px;
  border:1px solid var(--border); border-radius:10px; background:var(--surface); color:var(--fg); box-shadow:var(--shadow-popover); font-size:12px; }
.graph-pop h2 { margin:0 0 4px; font-size:13px; font-weight:650; }
.graph-pop .graph-pop-close { float:right; }
/* A machine that is not live (or carries a note): its heading, the short reason and "How to fix", above the canvas
   (deployments-page.mjs, the Machines canvas's of before), readable and reachable whatever the zoom. */
.graph-notes { flex:none; display:flex; flex-wrap:wrap; gap:10px 28px; padding:10px 20px; border-bottom:1px solid var(--border); background:var(--surface); }
.graph-notes[hidden] { display:none; }
.graph-notes .hier-dhead .cnm { color:var(--muted); font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.06em; }
.graph-notes .hier-dhead .cct, .graph-notes .hier-dsub { color:var(--muted); font-size:11px; }
${deploymentsPageCSS}
${instanceEventsCSS}
`;

/** The mode the Graph opens in: the last one chosen in this window (columns until then). */
let lastMode = "columns";

/** The deployment a request asked to show (the switcher's "Not matched" entries, deployment-tabs.mjs): its column
 * takes the focus when the Graph next paints it. */
let requestedColumn = null;
onDeploymentTabRequest(({ tab }) => { requestedColumn = typeof tab === "string" ? tab : null; });

/** A node's state, in words (Home's): "needs you", "running", "stopped", "status unknown", or a held home's status. */
export function nodeState(row, { stale = false } = {}) {
  const held = heldHome(row);
  if (held?.status) return held.status;
  if (waitingClaim(row, { stale })) return "needs you";
  const state = runtimeState(row);
  return state === "running" ? "running" : state === "stopped" ? "stopped" : "status unknown";
}

/** Who started a node, in words for its name and its line, or null: "you", its parent ("lead"; "lead on polaris"
 * across machines), else the parent it records (a name no row of the view resolves to). */
export function startedByWords(node, rowsById, labels) {
  if (node.byYou) return "you";
  if (node.parent) {
    const parent = rowsById.get(node.parent.id);
    const name = parent?.instance ?? node.recordedParent;
    return node.parent.cross ? `${name} on ${labels.get(node.parent.column) ?? "another machine"}` : name;
  }
  return node.recordedParent || null;
}

/** A node's accessible name: "<name>, <soul>, on <machine>, started by <parent or you>, <state>" (and ", same work"). */
export function nodeLabel(node, { rowsById, labels, stale = false }) {
  const row = node.row, soul = rosterRowFacts(row, DESKTOP_TERMS).soul;
  const by = startedByWords(node, rowsById, labels);
  return [row.instance, soul, node.machine ? `on ${node.machine}` : null, by ? `started by ${by}` : null,
    node.sameWork ? GRAPH_COPY.sameWork : null, nodeState(row, { stale })].filter(Boolean).join(", ");
}

/** Lay a graph out in stage pixels: Map<id|you-key, { x, y, w, h, column }>, the columns' boxes, and the stage size. */
export function layoutGraph(graph) {
  const width = graph.mode === "field" ? G.FIELD_W : G.COL_W;
  const at = new Map(), boxes = [];
  let height = 0;
  graph.columns.forEach((c, ci) => {
    const x0 = ci * (width + G.COL_GAP);
    c.rows.forEach((r, ri) => {
      const indent = Math.min(r.depth, G.MAX_INDENT) * G.IND, x = x0 + G.INSET + indent, y = G.HEAD + ri * G.ROW;
      const w = r.kind === "you" ? 64 : Math.max(150, width - G.INSET * 2 - indent);
      at.set(r.kind === "you" ? r.key : r.id, { x, y: r.kind === "you" ? y + 9 : y, w, h: r.kind === "you" ? 24 : G.NODE_H, column: c.key });
    });
    const h = G.HEAD + Math.max(c.rows.length, 1) * G.ROW + 6;
    boxes.push({ key: c.key, x: x0, y: 0, w: width, h });
    height = Math.max(height, h);
  });
  for (const b of boxes) b.h = height; // one height, so the columns line up
  return { at, boxes, width: Math.max(width, graph.columns.length * (width + G.COL_GAP) - G.COL_GAP), height: Math.max(height, G.HEAD + G.ROW) };
}

/** An edge's path: within a column, down the parent's guide and across to the child (orthogonal: a tree's edges
 * never cross); between columns, a curve from the parent's side to the child's. */
export function edgePath(edge, at, mode) {
  const a = at.get(edge.from), b = at.get(edge.to);
  if (!a || !b) return null;
  if (edge.kind === "cross" && mode === "columns" && a.column !== b.column) {
    const right = a.x < b.x, x1 = right ? a.x + a.w : a.x, x2 = right ? b.x : b.x + b.w;
    const y1 = a.y + a.h / 2, y2 = b.y + b.h / 2, dx = Math.max(24, Math.abs(x2 - x1) / 2) * (right ? 1 : -1);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }
  const gx = a.x + 14, y2 = b.y + b.h / 2;
  return `M ${gx} ${a.y + a.h} V ${y2} H ${b.x}`;
}

export function createGraph(el, ctx, { doc = el.ownerDocument, generation = workspaceGeneration, subscribeWorkspace = onWorkspaceChange,
  register = registerAction } = {}) {
  const win = doc.defaultView;
  const node = (tag, className, text) => { const n = doc.createElement(tag); if (className) n.className = className; if (text != null) n.textContent = text; return n; };
  const roster = () => (typeof ctx.homeRoster === "function" ? ctx.homeRoster() : { rows: [], deployments: [], phase: "loading", stale: () => false, here: null });
  const style = node("style"); style.dataset.graph = ""; style.textContent = graphCSS;
  const root = node("div", "graph oats-view");
  const bar = node("div", "graph-bar"), titles = node("div", "graph-titles");
  const title = node("h1", "graph-title", GRAPH_COPY.title); title.tabIndex = -1;
  titles.append(title, node("p", "graph-lead", GRAPH_COPY.lead));
  const tools = node("div", "graph-tools"), modeLine = node("span", "graph-mode");
  const modeButton = node("button", "graph-tool graph-mode-toggle"); modeButton.type = "button";
  tools.append(modeLine, modeButton);
  bar.append(titles, tools);
  const stateLine = node("p", "graph-state"); stateLine.setAttribute("role", "status"); stateLine.hidden = true;
  const canvas = node("div", "graph-canvas");
  const stage = node("div", "graph-stage");
  const tree = node("div", "graph-tree"); tree.setAttribute("role", "tree"); tree.setAttribute("aria-label", GRAPH_COPY.title);
  const zoom = node("div", "graph-zoom");
  const zoomButton = (cls, label, iconName, run) => {
    const b = node("button", `graph-tool ${cls}`); b.type = "button"; b.title = label; b.setAttribute("aria-label", label);
    b.append(iconElement(doc, iconName, { size: 14 })); b.addEventListener("click", run); zoom.append(b); return b;
  };
  const hint = node("p", "graph-hint"); hint.setAttribute("aria-hidden", "true");
  stage.append(tree); canvas.append(stage, zoom, hint);
  const notes = node("div", "graph-notes"); notes.hidden = true;
  root.append(style, bar, stateLine, notes, canvas);
  el.replaceChildren(root);

  let alive = true, mode = lastMode, graph = null, place = null, signature = null, gen = generation();
  let z = 1, tx = G.PAD, ty = G.PAD, fitted = false, focusId = null, pop = null, menu = null, intent = 0;
  const nodeEls = new Map();
  let rowsById = new Map(), labels = new Map(), staleOf = () => false;
  const fixOpen = new Set(); // the deployments whose "How to fix" is open, kept across repaints

  zoomButton("graph-zoom-out", "Zoom out", "zoomOut", () => zoomBy(1 / Z_STEP));
  zoomButton("graph-zoom-in", "Zoom in", "zoomIn", () => zoomBy(Z_STEP));
  zoomButton("graph-zoom-fit", "Fit to screen", "fit", () => fit());
  modeButton.addEventListener("click", () => toggleMode());

  function paintMode() {
    modeLine.textContent = mode === "columns" ? GRAPH_COPY.modeColumns : GRAPH_COPY.modeField;
    modeButton.textContent = mode === "columns" ? GRAPH_COPY.modeField : GRAPH_COPY.modeColumns;
    modeButton.setAttribute("aria-label", `Show ${mode === "columns" ? "one field" : "machines as columns"} (m)`);
    modeButton.title = "m";
    hint.textContent = `←→ machines · ↑↓ ${DESKTOP_NOUNS.instances} · Enter opens · m ${mode === "columns" ? "one field" : "columns"} · + − zoom · 0 fits`;
  }

  const applyTransform = () => { stage.style.transform = `translate(${tx}px, ${ty}px) scale(${z})`; };
  function fit() {
    if (!alive || !place) return;
    fitted = true;
    const rect = canvas.getBoundingClientRect?.();
    if (!rect?.width || !rect?.height) { z = 1; tx = G.PAD; ty = G.PAD; applyTransform(); return; }
    z = Math.min(1, Math.max(Z_MIN, Math.min((rect.width - G.PAD * 2) / place.width, (rect.height - G.PAD * 2 - 36) / place.height)));
    tx = G.PAD; ty = G.PAD; applyTransform();
  }
  function zoomBy(factor, cx, cy) {
    if (!alive) return;
    fitted = true;
    const rect = canvas.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
    const px = cx != null ? cx - rect.left : rect.width / 2, py = cy != null ? cy - rect.top : rect.height / 2;
    const nz = Math.min(Z_MAX, Math.max(Z_MIN, z * factor)), k = nz / z;
    tx = px - (px - tx) * k; ty = py - (py - ty) * k; z = nz;
    applyTransform();
  }
  /** A zoom key: about the focused node, which stays where it was on screen. */
  function zoomKey(factor) {
    const e = focusId ? nodeEls.get(focusId) : null, box = e?.getBoundingClientRect?.();
    if (box?.width) zoomBy(factor, box.left + box.width / 2, box.top + box.height / 2); else zoomBy(factor);
  }
  /** Keep a focused node on screen: pan (never zoom) just enough. */
  function reveal(id) {
    const p = place?.at.get(id), rect = canvas.getBoundingClientRect?.();
    if (!p || !rect?.width || !rect?.height) return;
    const x = p.x * z + tx, y = p.y * z + ty, w = p.w * z, h = p.h * z;
    let dx = 0, dy = 0;
    if (x < G.PAD) dx = G.PAD - x; else if (x + w > rect.width - G.PAD) dx = Math.max(G.PAD - x, rect.width - G.PAD - (x + w));
    if (y < G.PAD) dy = G.PAD - y; else if (y + h > rect.height - G.PAD - 36) dy = Math.max(G.PAD - y, rect.height - G.PAD - 36 - (y + h));
    if (dx || dy) { fitted = true; tx += dx; ty += dy; applyTransform(); }
  }

  /* Pan by drag (not from a node or a control), scroll by the wheel, zoom by Ctrl/⌘ + the wheel. */
  let pan = null;
  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.closest?.(".graph-node, .graph-zoom, button")) return;
    pan = { x: e.clientX - tx, y: e.clientY - ty, moved: false, sx: e.clientX, sy: e.clientY };
  });
  const onMove = (e) => {
    if (!pan) return;
    if (!pan.moved && Math.hypot(e.clientX - pan.sx, e.clientY - pan.sy) < DRAG_THRESHOLD) return;
    pan.moved = true; fitted = true; canvas.classList.add("panning");
    tx = e.clientX - pan.x; ty = e.clientY - pan.y; applyTransform();
  };
  const onUp = () => { pan = null; canvas.classList.remove("panning"); };
  win.addEventListener("mousemove", onMove); win.addEventListener("mouseup", onUp);
  canvas.addEventListener("wheel", (e) => {
    if (e.defaultPrevented || e.target.closest?.(".graph-pop")) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomBy(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    else { fitted = true; tx -= e.deltaX; ty -= e.deltaY; applyTransform(); }
  }, { passive: false });
  const onResize = () => { if (!fitted) fit(); };
  win.addEventListener("resize", onResize);

  /* The rebindable keys (the shortcuts editor lists them; they fire only from the Graph, view-keys.mjs). */
  const viewActions = [
    { id: "graph.toggleField", defaultChord: "M", label: "Graph: machines as columns or one field", run: () => toggleMode() },
    { id: "graph.zoomIn", defaultChord: "=", label: "Graph: zoom in", run: () => zoomKey(Z_STEP) },
    { id: "graph.zoomInPlus", defaultChord: "Shift+=", label: "Graph: zoom in (+)", run: () => zoomKey(Z_STEP) },
    { id: "graph.zoomOut", defaultChord: "-", label: "Graph: zoom out", run: () => zoomKey(1 / Z_STEP) },
    { id: "graph.fit", defaultChord: "0", label: "Graph: fit to screen", run: () => fit() },
  ];
  const disposers = viewActions.map((a) => register({ id: a.id, label: a.label, context: "view:graph", run: a.run, defaultChord: a.defaultChord }));

  function toggleMode() {
    if (!alive) return;
    mode = lastMode = mode === "columns" ? "field" : "columns";
    fitted = false; signature = null; paint({ keepFocus: true });
  }

  function dot(row, claim, state) {
    const d = node("span");
    if (claim) { d.className = "ctx-dot waiting"; d.append(iconElement(doc, "attention", { size: 10, className: "shell-icon attn-mark" })); }
    else { d.className = `ctx-dot ${state === "running" ? "on" : state === "stopped" ? "off" : "unknown"}`; paintDotColor(d, row, state); }
    d.setAttribute("aria-hidden", "true");
    return d;
  }

  function nodeEl(n) {
    const row = n.row, stale = staleOf(row), claim = waitingClaim(row, { stale }), state = runtimeState(row);
    const facts = rosterRowFacts(row, DESKTOP_TERMS);
    const p = place.at.get(n.id);
    const d = node("div", `graph-node${state === "stopped" ? " stopped" : ""}`);
    d.dataset.graphNode = n.id; d.dataset.column = n.column;
    d.setAttribute("role", "treeitem"); d.setAttribute("aria-level", String(n.depth + 1)); d.tabIndex = -1;
    d.setAttribute("aria-label", nodeLabel(n, { rowsById, labels, stale }));
    d.setAttribute("aria-haspopup", "menu");
    Object.assign(d.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${p.w}px` });
    const copy = node("span", "graph-node-copy");
    copy.append(node("span", "graph-node-name", facts.name));
    const sub = node("span", "graph-node-sub");
    const by = n.crossMachine && n.parent ? `started by ${startedByWords(n, rowsById, labels)}` : null;
    const parts = [facts.soul, mode === "field" ? n.machine : null, by].filter(Boolean);
    sub.textContent = parts.join(" · ");
    if (n.sameWork) { if (parts.length) sub.append(" · "); sub.append(node("b", null, GRAPH_COPY.sameWork)); }
    copy.append(sub);
    d.append(dot(row, claim, state), copy);
    d.title = [row.instance, row.home].filter(Boolean).join("\n");
    d.addEventListener("click", () => { if (alive) focusNode(n.id); });
    d.addEventListener("dblclick", () => { if (alive) open(n.id); });
    d.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const box = d.getBoundingClientRect(), atPointer = !!(e.clientX || e.clientY) && e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
      const at = atPointer ? { x: e.clientX, y: e.clientY } : null;
      whenRightButtonReleased(e, () => { if (alive && d.isConnected) openMenu(n.id, at); });
    });
    nodeEls.set(n.id, d);
    return d;
  }

  /** What a paint depends on: the graph's facts and its mode (a poll that changes nothing repaints nothing). */
  const signatureOf = (data) => JSON.stringify([mode, data.phase, data.note ?? null, data.here ?? null, data.deployments ?? [],
    (data.rows || []).map((r) => [instanceId(r), r.instance, r.agent, r.running, r.runtimeState, r.parentInstance, r.attributedHuman, r.sameWork, r.sameWorkKnown,
      r.color, r.waitingOnYou, r.deployment?.id, r.spawnInProgress, r.retirePending, r.rollbackIncomplete, r.retireInFlight, r.retire, data.stale?.(r) === true])]);

  function paint({ keepFocus = false } = {}) {
    if (!alive) return;
    const data = roster(), sig = signatureOf(data);
    if (sig === signature && !keepFocus) return;
    signature = sig;
    const hadFocus = root.contains(doc.activeElement) && doc.activeElement?.dataset?.graphNode ? doc.activeElement.dataset.graphNode : null;
    paintMode();
    stateLine.className = "graph-state"; stateLine.replaceChildren(); stateLine.hidden = true; notes.hidden = true;
    const say = (text, cls) => { stateLine.hidden = false; if (cls) stateLine.classList.add(cls); stateLine.append(node("span", null, text)); };
    const showCanvas = (on) => { canvas.hidden = !on; tools.hidden = !on; };
    if (data.phase === "loading") { say(GRAPH_COPY.reading); root.setAttribute("aria-busy", "true"); showCanvas(false); clear(); return; }
    root.removeAttribute("aria-busy");
    if (data.phase === "failed" || data.phase === "unavailable") {
      say(data.phase === "unavailable" && data.note ? data.note : GRAPH_COPY.failed, "failed");
      if (typeof data.retry === "function") {
        const retry = node("button", "graph-tool graph-retry", "Retry"); retry.type = "button";
        retry.addEventListener("click", () => data.retry()); stateLine.append(retry);
      }
      showCanvas(false); clear(); return;
    }
    paintNotes(data);
    if (!data.rows?.length) { say(GRAPH_COPY.empty); showCanvas(false); clear(); return; }
    showCanvas(true);
    staleOf = (row) => data.stale?.(row) === true;
    graph = instanceGraph(data.rows, data.deployments, DESKTOP_TERMS, { mode, here: data.here });
    place = layoutGraph(graph);
    rowsById = new Map(data.rows.map((r) => [instanceId(r), r]));
    labels = graph.labels;
    draw(data);
    // The focus stays on the node it was on, else the requested column's first, else the first node (roving tabindex).
    const stops = graphStops(graph).flat();
    let target = focusId && nodeEls.has(focusId) ? focusId : null;
    if (requestedColumn && mode === "columns") {
      const first = graphStops(graph)[graph.columns.findIndex((c) => c.key === requestedColumn)]?.[0];
      if (first) { target = first.id; requestedColumn = null; if (!hadFocus) win.queueMicrotask?.(() => focusNode(first.id)); }
    }
    focusId = target ?? stops[0]?.id ?? null;
    for (const [id, e] of nodeEls) e.tabIndex = id === focusId ? 0 : -1;
    if (!fitted) fit(); else applyTransform();
    if ((hadFocus || keepFocus) && focusId) focusNode(focusId, { reveal: false });
  }

  /** Each deployment with something to say (not live, not matched, or a note): its heading's words above the canvas. */
  function paintNotes(data) {
    const list = Array.isArray(data.deployments) ? data.deployments.filter((d) => d && typeof d.id === "string") : [];
    const said = list.filter((d) => deploymentHasWords(d));
    const parts = said.length ? splitByDeployment(list)(data.rows || []) : new Map();
    const focused = notes.contains(doc.activeElement) ? doc.activeElement.closest?.("[data-deployment]")?.dataset.deployment : null;
    notes.replaceChildren(...said.map((d) => deploymentReasonBlock(doc, { deployment: d, rows: parts.get(d.id) || [], open: fixOpen.has(d.id),
      onToggle: (open) => { if (open) fixOpen.add(d.id); else fixOpen.delete(d.id); } })));
    notes.hidden = !said.length;
    if (focused) [...notes.querySelectorAll("[data-deployment]")].find((b) => b.dataset.deployment === focused)?.querySelector("summary")?.focus();
  }

  function clear() { tree.replaceChildren(); nodeEls.clear(); graph = null; place = null; closeMenu(); }

  function draw() {
    nodeEls.clear(); closeMenu({ restore: false });
    const NS = "http://www.w3.org/2000/svg", svg = doc.createElementNS(NS, "svg");
    svg.classList.add("graph-edges"); svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("width", String(place.width)); svg.setAttribute("height", String(place.height));
    const parts = [];
    graph.columns.forEach((c, ci) => {
      const b = place.boxes[ci], col = node("div", "graph-col");
      Object.assign(col.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });
      const group = node("div", "graph-col-group"); group.setAttribute("role", "group");
      const head = node("div", "graph-col-head");
      const name = c.label ?? GRAPH_COPY.field, agents = c.rows.filter((r) => r.kind === "agent").length;
      const st = c.deployment ? deploymentState(c.deployment) : null;
      const sub = [c.local ? GRAPH_COPY.thisComputer : null, `${agents} ${agents === 1 ? DESKTOP_NOUNS.instance : DESKTOP_NOUNS.instances}`,
        st && st.key !== "live" ? st.text : null].filter(Boolean).join(" · ");
      head.append(node("span", "graph-col-name", name), node("span", "graph-col-sub", sub));
      if (st?.detail) head.title = st.detail;
      group.setAttribute("aria-label", `${name}, ${sub}`);
      col.append(head);
      if (!agents) { const empty = node("span", "graph-col-empty", GRAPH_COPY.emptyColumn); empty.style.top = `${G.HEAD}px`; col.append(empty); }
      parts.push(col);
      for (const r of c.rows) {
        if (r.kind === "you") {
          const p = place.at.get(r.key), you = node("span", "graph-you", GRAPH_COPY.you);
          you.setAttribute("aria-hidden", "true"); you.dataset.graphYou = c.key;
          Object.assign(you.style, { left: `${p.x}px`, top: `${p.y}px` });
          parts.push(you);
        } else group.append(nodeEl(r));
      }
      parts.push(group);
    });
    for (const e of graph.edges) {
      const d = edgePath(e, place.at, graph.mode);
      if (!d) continue;
      const path = doc.createElementNS(NS, "path");
      path.setAttribute("d", d); path.dataset.from = e.from; path.dataset.to = e.to; path.dataset.kind = e.kind;
      if (e.kind === "cross") path.classList.add("cross");
      if (e.sameWork) path.dataset.sameWork = "true";
      svg.append(path);
    }
    // The columns' backgrounds first, then the edges over them, then the nodes over the edges.
    const backs = parts.filter((p) => p.classList.contains("graph-col"));
    tree.replaceChildren(...backs, svg, ...parts.filter((p) => !backs.includes(p)));
  }

  function focusNode(id, { reveal: show = true } = {}) {
    const e = nodeEls.get(id);
    if (!e) return;
    for (const [other, x] of nodeEls) x.tabIndex = other === id ? 0 : -1;
    focusId = id;
    e.focus({ preventScroll: true });
    if (show) reveal(id);
  }

  /** Where a key moves from `id`: ←→ the nearest agent of the next column (by its row), ↑↓ the column's next. */
  function moveFrom(id, key) {
    const stops = graphStops(graph);
    const ci = stops.findIndex((list) => list.some((n) => n.id === id));
    if (ci < 0) return null;
    const list = stops[ci], ri = list.findIndex((n) => n.id === id);
    if (key === "ArrowUp") return list[Math.max(0, ri - 1)].id;
    if (key === "ArrowDown") return list[Math.min(list.length - 1, ri + 1)].id;
    if (key === "Home") return list[0].id;
    if (key === "End") return list[list.length - 1].id;
    const step = key === "ArrowRight" ? 1 : -1, y = place.at.get(id).y;
    for (let c = ci + step; c >= 0 && c < stops.length; c += step) {
      if (!stops[c].length) continue;
      return stops[c].reduce((best, n) => (Math.abs(place.at.get(n.id).y - y) < Math.abs(place.at.get(best.id).y - y) ? n : best)).id;
    }
    return null;
  }

  function open(id) {
    const row = rowsById.get(id);
    if (!row || typeof ctx.openAgent !== "function") return;
    if (ctx.openAgent(row) === false) ctx.notify?.(`${row.instance} isn't in the roster now.`);
  }

  root.addEventListener("keydown", (e) => {
    if (!alive || e.defaultPrevented || e.isComposing) return;
    const id = e.target?.dataset?.graphNode;
    if (!id || !nodeEls.has(id)) return;
    // The structural keys are the Graph's unless the keymap binds the chord (the shared Alt+Shift+↑/↓, a rebind):
    // never a guess by modifier.
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(e.key)) {
      if (keymapTakes(e)) return;
      e.preventDefault();
      if (e.key === "Enter") { open(id); return; }
      const next = moveFrom(id, e.key);
      if (next) focusNode(next);
      return;
    }
    if (e.repeat) return;
    const hit = resolveViewKey(e, viewActions);
    if (hit) { e.preventDefault(); viewActions.find((a) => a.id === hit)?.run(); }
  });

  /* The node's menu: Open terminal, Details, Open soul, Recent events… (the old popup's Go to instance, Go to soul
     and events). Esc or Tab close it back on the node; ↑↓ Home End move. */
  function closeMenu({ restore = false } = {}) {
    if (menu) { const m = menu; menu = null; try { m.element.hidePopover?.(); } catch { /* already closed */ } m.element.remove(); if (restore) nodeEls.get(m.id)?.focus(); }
  }
  function openMenu(id, at) {
    const row = rowsById.get(id), anchor = nodeEls.get(id);
    if (!row || !anchor) return;
    closeMenu(); closePop();
    const m = node("div", "ctx-instance-menu graph-menu"); m.setAttribute("role", "menu"); m.setAttribute("aria-label", `Actions for ${row.instance}`);
    m.setAttribute("popover", "auto"); m.tabIndex = -1;
    const items = [];
    const item = (action, label, iconName, run, enabled = true) => {
      const b = node("button"); b.type = "button"; b.tabIndex = -1; b.setAttribute("role", "menuitem"); b.dataset.action = action; b.disabled = !enabled;
      const glyph = node("span", "ctx-menu-icon"); glyph.setAttribute("aria-hidden", "true"); glyph.append(iconElement(doc, iconName, { size: 15 }));
      b.append(glyph, node("span", null, label));
      b.addEventListener("click", () => { if (!alive || b.disabled) return; closeMenu({ restore: true }); run(); });
      items.push(b); m.append(b);
    };
    item("open", "Open terminal", "terminal", () => open(id), typeof ctx.openAgent === "function");
    item("details", "Details", "info", () => { if (ctx.openAgentDetails?.(row) === false) ctx.notify?.(`${row.instance} isn't in the roster now.`); }, typeof ctx.openAgentDetails === "function");
    item("soul", "Open soul", "soul", () => ctx.openSoulOf?.(row), typeof ctx.openSoulOf === "function" && !!row.agent);
    item("events", "Recent events…", "overview", () => openEvents(id));
    m.addEventListener("keydown", (e) => {
      if (e.key === "Tab") { closeMenu({ restore: true }); return; }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu({ restore: true }); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) || keymapTakes(e)) return;
      e.preventDefault(); e.stopPropagation();
      const enabled = items.filter((b) => !b.disabled), i = enabled.indexOf(doc.activeElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? enabled.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length;
      enabled[next]?.focus();
    });
    m.addEventListener("toggle", (e) => { if (e.newState === "closed" && menu?.element === m) { menu = null; m.remove(); } });
    root.append(m);
    menu = { id, element: m };
    try { m.showPopover?.(); } catch { /* not a popover host (a test's DOM) */ }
    const box = anchor.getBoundingClientRect(), size = m.getBoundingClientRect();
    const x = at ? at.x : box.left + 8, y = at ? at.y : box.bottom + 4;
    m.style.left = `${Math.max(8, Math.min(x, (win.innerWidth || 0) - size.width - 8))}px`;
    m.style.top = `${Math.max(8, y + size.height + 8 <= (win.innerHeight || Infinity) ? y : y - size.height - (at ? 0 : box.height + 8))}px`;
    (items.find((b) => !b.disabled) || m).focus();
  }

  /* Recent events: the old popup's events view (instance-events-view.mjs), for one agent, in a small dialog by its
     node. Its read is guarded by this dialog and the workspace it was opened in. */
  function closePop({ restore = false } = {}) {
    if (!pop) return;
    const p = pop; pop = null; p.view?.dispose?.(); p.element.remove();
    if (restore) nodeEls.get(p.id)?.focus();
  }
  function openEvents(id) {
    const row = rowsById.get(id), anchor = nodeEls.get(id);
    if (!row || !anchor) return;
    closePop();
    const asked = generation(), mine = ++intent;
    const box = node("section", "graph-pop"); box.setAttribute("role", "dialog"); box.setAttribute("aria-label", `Recent events of ${row.instance}`);
    const close = node("button", "graph-tool graph-pop-close", "Close"); close.type = "button";
    close.addEventListener("click", () => closePop({ restore: true }));
    box.append(close, node("h2", null, row.instance));
    const summary = node("p", "graph-node-sub");
    box.append(summary);
    box.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePop({ restore: true }); } });
    root.append(box);
    const r = anchor.getBoundingClientRect();
    box.style.left = `${Math.max(8, Math.min(r.right + 8, (win.innerWidth || 0) - 328))}px`;
    box.style.top = `${Math.max(8, Math.min(r.top, (win.innerHeight || 0) - 240))}px`;
    const owns = () => alive && pop?.element === box && mine === intent && asked === generation();
    const selection = () => {
      const now = rowsById.get(id);
      if (!now) return null;
      return { workspace: rowDeployment(now), selector: { instance: now.instance, agent: now.agent, agentsRoot: now.agentsRoot, server: now.server || null },
        home: now.home, incarnation: now.createdAt ?? null, serverLabel: serverLabel(now) };
    };
    pop = { id, element: box, view: null };
    pop.view = createInstanceEventsView(box, { ctx, summary, selection, owner: owns });
    close.focus();
  }

  const unsubscribe = typeof ctx.subscribeHomeRoster === "function" ? ctx.subscribeHomeRoster(() => paint()) : () => {};
  const unsubscribeWorkspace = subscribeWorkspace(() => {
    if (!alive || generation() === gen) return;
    gen = generation(); focusId = null; fitted = false; signature = null; closeMenu(); closePop(); paint();
  });
  paint();

  return {
    get mode() { return mode; },
    get graph() { return graph; },
    refresh: () => { signature = null; paint(); },
    focus: () => { if (focusId) focusNode(focusId); else title.focus(); },
    dispose() {
      if (!alive) return;
      alive = false; intent++; closeMenu(); closePop(); unsubscribe(); unsubscribeWorkspace();
      for (const off of disposers) { try { off?.(); } catch (e) { console.error(e); } }
      win.removeEventListener("mousemove", onMove); win.removeEventListener("mouseup", onUp); win.removeEventListener("resize", onResize);
    },
  };
}

/** The stage contract: mount returns its disposer (view-lifecycle.mjs); the module-wide unmount disposes every Graph
 * still mounted. */
const mounted = new Set();
export function mount(el, ctx) {
  const view = createGraph(el, ctx); mounted.add(view);
  return () => { mounted.delete(view); view.dispose(); };
}
export function unmount() { for (const view of mounted) view.dispose(); mounted.clear(); }

