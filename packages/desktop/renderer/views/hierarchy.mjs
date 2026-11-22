/* oats desktop — the Deployments page (UI spec, #482; formerly the "Active"
   overview): reported runtime and relationship observations, not an inferred
   activity feed.
   Tabs (deployments-page.mjs, the Workspace page's tab component): All first,
   then one tab per deployment of the shown view, in served order; a view of one
   deployment has only its own tab. The selected tab is remembered per view
   (deployment-tabs.mjs) and other surfaces open one through
   requestDeploymentTab. The header's count line counts the selected tab only.
   All stacks one section per deployment on the one canvas, each under its
   heading (label and counts; a deployment that is not live adds its state chip,
   short reason and a "How to fix" disclosure) with its own tree: relations
   never cross sections. A deployment's tab shows its heading and its tree
   alone; with no rows and not live, the heading is the tab's empty state. A
   view of one live deployment draws no heading: the overview as it always was.
   Agent clusters — connected
   components of parent/child/sibling links (see clusters.mjs) — are the
   primary visual unit: each multi-member cluster renders as a card with its
   internal tidy tree (parent/child solid S-curves, bottom-centre to
   top-centre; sibling links as dashed shallow arcs between peers — never
   color alone). Unrelated
   single instances collect in a visually quieter "Independent" strip below.
   Layout inside a cluster is a layered tidy tree, deliberately NOT
   force-directed: deterministic, no jitter.
   Node cards show reported runtime state (running = filled orange dot;
   stopped = hollow dot + dashed card; unknown a muted bullseye, never yellow). Activity is NOT
   inferred from task/transcript prose: K7 reads are explicit and selected-only. Click
   selects and shows the action popover: its facts and exactly two acts, Go to
   instance (the terminal tab; Start… on a stopped row) and Go to soul (the
   Workspace page's page of this instance's exact soul, or disabled with why);
   double-click / Enter take Go to instance's act; hovering highlights the lineage.
   Canvas: pan by drag, zoom by pinch/⌘-wheel or the −/+/fit controls; the
   graph auto-fits the visible screen on first paint and after workspace
   switches; each agent box can be grabbed and moved freely (drag past the
   click threshold — spawn edges follow live, and offsets persist across the
   4s refresh).
   Keyboard: arrows walk the tree, Enter/t go to the instance (Start… when
   stopped), s Workspace (the Spawn view), o action popover, +/- zoom, f fits,
   Escape clears.
   The Workspace page's Machines tab (2026-10-26; views/spawn.mjs mounts it):
   one plain sentence under the bar says what a machine is, and each
   machine's heading says the tree under it is the instances on it.
   Loading (desktop/loading-states): the shared controller in loading.mjs owns
   the pending / refreshing presentation. Pending (no roster for this workspace
   yet) shows a skeleton pill in .hier-sum after 150ms, aria-busy on the view
   root and one "Loading roster…" announcement; the canvas paints no fake
   nodes (a tidy tree has no honest skeleton shape). Refreshing appends
   "Refreshing…" beside the summary after 400ms. Stale and failed keep the
   view's own .hier-notice and its "Retry roster" button (the notice owns that
   copy; the primitive gets no noticeHost and no failedHost). The controller's
   hidden status line is the view's one live region: the notice is a note.
   Contract: mount(el, ctx) / unmount(); roster from GET /api/panel, explicit
   selected activity from the guarded K7 POST /api/instance-events boundary. */
import { ROSTER_POLL_FOCUSED_MS, rosterPollDue } from "../roster-cadence.mjs";
import { computeClusters, siblingEdges } from "./clusters.mjs";
import { sameRepo } from "../../../client/repo-moves.mjs";
import { runtimeState, runtimeCounts } from "../../../client/instance-presentation.mjs";
import { serverLabel } from "../../../client/remote-address.mjs";
import { unsupportedLine, speakerParts, keptFailureLine, heldLine, heldStatus } from "../speaker-line.mjs";
import { noTerminal } from "../provider-row.mjs";
import { displayLine } from "../../../client/display-text.mjs";
import { keptFailure } from "../../../client/deployment-facts.mjs";
import { createInstanceEventsView, instanceEventsCSS } from "../instance-events-view.mjs";
import { instanceId, resolveLinkId, heldHome } from "../../../client/instance-tree.mjs";
import { instanceActs, openAct } from "../../../client/instance-acts.mjs";
import { projectActivePanel, activeSignature, activeTargetLabel, canAddressInstance } from "../active-observation.mjs";
import {
  apiJson, ensureTheme,
  currentWorkspace, switchWorkspace, adoptWorkspace, staleWorkspaceSelection, onWorkspaceChange,
  renderWorkspaceSelect, wsQuery, workspaceGeneration, rowDeployment,
} from "./common.mjs";
import { createDataState, skeleton, statusLine, observedText } from "../loading.mjs";
import { NOT_SERVED_CODE, NO_ANSWER_CODE, unservedError, createPendingWatch } from "../deployment-header.mjs";
import { deploymentUnavailableText } from "../../../client/deployment-facts.mjs";
import { keymapTakes, registerAction } from "../keybindings.mjs";
import { resolveViewKey } from "../view-keys.mjs";
import { icon } from "../shell-icons.mjs";
import { attachDeployments } from "../view-deployments.mjs";
import { isMultiDeployment, splitByDeployment, rowStale } from "../../../client/roster-sections.mjs";
import { deploymentLabel } from "../../../client/deployment-label.mjs";
import { DESKTOP_TERMS } from "../desktop-terms.mjs";
import { ALL_TAB, deploymentTabs, selectedDeploymentTab, rememberDeploymentTab, onDeploymentTabRequest } from "../deployment-tabs.mjs";
import { deploymentsPageCSS, createDeploymentTabBar, deploymentHead, deploymentReasonBlock, deploymentNeedsWords } from "../deployments-page.mjs";
import { paintDotColor } from "../instance-dot.mjs";

export const hierarchyCSS = `
.hier { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg); color: var(--fg);
        font-weight: normal; font-size: 13px; line-height: 1.45; font-family: var(--ui-font, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif); }
.hier * { box-sizing: border-box; }
.hier-bar { display: flex; align-items: center; gap: 10px; height:var(--bar-h); flex: none; padding:0 calc(12px + var(--main-trail-inset, 0px)) 0 calc(16px + var(--main-lead-inset, 0px));
            border-bottom: 1px solid var(--border); background: var(--surface); }
/* The counts sit at the right of the header (never against the tabs); the tabs take what is left and
   scroll when they overflow (deployments-page.mjs). */
.hier-sum { flex: none; color: var(--muted); font-size: 12.5px; white-space: nowrap; }
.hier-sum b { color: var(--fg); font-weight: 600; }
.hier-sum .skeleton-pill { height: 0.9em; }
.hier-refreshing { flex: none; display: inline-flex; align-items: center; }
.hier-refreshing:empty { display: none; }
.hier-notice { flex:none; display:flex; align-items:center; gap:8px; padding:8px 16px; color:var(--muted); background:var(--surface); font-size:12px; overflow-wrap:anywhere; }
.hier-notice-message { flex:1; }
.hier-retry, .hier-readd { flex:none; }
.hier-readd[hidden] { display:none; }
.hier-notice[hidden] { display:none; }
/* The canvas is a large focusable panel: the global 1px edge only (its base rule clears the outline). */
.hier-canvas:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
.hier-canvas { flex: 1; position: relative; overflow: hidden; min-height: 0; cursor: grab; outline: none; }
.hier-canvas.panning { cursor: grabbing; }
.hier-stage { position: absolute; left: 0; top: 0; transform-origin: 0 0; will-change: transform; }
.hier-group { position: absolute; }
/* The selected tab's panel: the canvas. */
.hier-panel { flex: 1; display: flex; flex-direction: column; min-height: 0; }
/* Deployment sections (#482): a zero-size wrapper at the stage origin (its groups keep stage
   coordinates) and its heading (deployments-page.mjs) above its clusters. */
.hier-deployment { position: absolute; left: 0; top: 0; }
.hier-group.hier-cluster { background:var(--surface-2);
                           border: 1px solid var(--border); border-radius: 14px; }
.hier-group.hier-solo .hnode { box-shadow: none; }
.hier-chead { position: absolute; left: 14px; top: 9px; display: flex; align-items: baseline; gap: 8px;
              max-width: calc(100% - 24px); white-space: nowrap; pointer-events: none; }
.hier-chead .cnm, .hier-dhead .cnm { color: var(--muted); font-size: 11px; font-weight: 650; text-transform: uppercase;
                   letter-spacing: .06em; min-width: 0; flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; }
.hier-chead .cct, .hier-dhead .cct { color: var(--muted); font-size: 11px; min-width: 0; flex: 0 1000 auto; overflow: hidden; text-overflow: ellipsis; }
.hier-zoom { position: absolute; right: 14px; bottom: 14px; z-index: 5; display: flex; gap: 4px;
             background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 3px; box-shadow: var(--shadow); }
.hier-zoom button { background: none; border: none; color: var(--muted); font: 14px/1 inherit; width: 26px; height: 24px;
                    border-radius: 5px; cursor: pointer; }
.hier-zoom button:hover { background: var(--surface-2); color: var(--fg); }
.hier-zoom button:focus-visible { background: var(--sel); }
.hier-edges { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.hier-edges path { stroke: var(--graph-edge); stroke-width: 1.5; fill: none; }
.hier-edges path.sib { stroke-dasharray:5 4; }
.hier-edges path.lit { stroke: var(--accent); stroke-width: 2; }
.hier-ws { position: absolute; color: var(--faint); font-size: 11px; font-weight: 650;
           text-transform: uppercase; letter-spacing: .06em; white-space: nowrap; }
.hnode { position: absolute; width:220px; min-height:60px; background: var(--surface); border: 1px solid var(--border);
         border-radius: 10px; padding:9px 12px; cursor: pointer; user-select: none; }
.hnode.dragging { cursor: grabbing; }
.hnode:hover { background: var(--surface-2); }
.hnode.idle { border-style: dashed; background: var(--surface-2); }
.hnode.sel { border-color: var(--accent); background: var(--surface); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent); }
.hnode.lit { border-color: var(--accent); }
.hnode .hname { font-weight: 600; font-size: 13px; display: flex; align-items: center; gap:8px; min-width: 0; }
.hnode .hname .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hnode .hmeta { color: var(--muted); font-size: 11.5px; margin-top:3px; padding-left:16px; overflow: hidden;
                text-overflow: ellipsis; white-space: nowrap; }
.hdot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.hdot.on { background: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
/* Unknown: the roster's muted bullseye (shell.css .ctx-dot.unknown; yellow means needs input only), its ring and
   2px centre with the card's own fill between them. */
.hdot.unknown { box-sizing: border-box; border: 1.5px solid var(--muted); background: radial-gradient(circle, var(--muted) 1px, transparent 1px); }
.hdot.off { box-sizing: border-box; background: transparent; border: 1.5px solid var(--faint); }
/* An instance's colour (instance-dot.mjs): the running dot and its halo in it, the stopped ring in it. */
.hdot.on[data-instance-color] { background: var(--instance-color); box-shadow: 0 0 0 3px color-mix(in srgb, var(--instance-color) 18%, transparent); }
.hdot.off[data-instance-color] { border-color: var(--instance-color); }
.hnode.idle .hname { color: var(--muted); }
.hier-pop { position: absolute; z-index:4; width:224px; max-width:calc(100% - 16px); background:var(--surface); border:1px solid var(--border);
            border-radius:10px; box-shadow:var(--shadow-popover); padding:11px 12px; font-size:12px; overflow-wrap:anywhere; }
.hier-pop .pname { margin:0 0 8px; font-size:12.5px; font-weight:650; }
.hier-pop .pstate, .hier-pop .pavailability, .hier-pop .pstatus { margin:0 0 8px; color:var(--muted); line-height:1.5; }
.hier-pop .pstatus:empty { display:none; }
.hier-pop .pidentity { color:var(--muted); font-weight:normal; font-size:11px; line-height:1.5; font-family:var(--mono,monospace); margin:0 0 8px; }
.hier-pop .pidentity[hidden] { display:none; }
.hier-pop .pchips { display: flex; gap: 5px; flex-wrap: wrap; margin-bottom: 9px; }
/* The two acts, one per row: each label whole at the popover's width (never cut, never letter by letter). */
.hier-pop .pacts { display:grid; grid-template-columns:1fr; gap:6px; }
.hier-pop .pacts button { min-width:0; padding:6px 4px; font-size:12px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.hier-empty-wrap { flex: 1; display: flex; align-items: center; justify-content: center; }
${deploymentsPageCSS}
${instanceEventsCSS}
/* What a machine is, once, under the bar (the Machines tab, 2026-10-26): plain words, not a dialog. */
.hier-intro { flex: none; margin: 0; padding: 8px 16px; border-bottom: 1px solid var(--border); background: var(--surface);
  color: var(--muted); font-size: 12px; line-height: 1.5; }
.hier-dhead .hier-dsub { color: var(--muted); font-size: 11px; line-height: 1.4; }
`;

const NODE_W = 220, NODE_H = 60, GAP_X = 50, GAP_Y = 40, PAD = 40;
const CL_PAD = 18, CL_LEFT = 60, CL_HEAD = 26, CL_GAP = 44, ROW_MAX = 1000, SOLO_GAP_Y = 20;

/* Name index over a roster: name -> instance[] (resolveLinkId's shape). */
function nameIndex(instances) {
  const byName = new Map();
  for (const i of instances) {
    if (!byName.has(i.instance)) byName.set(i.instance, []);
    byName.get(i.instance).push(i);
  }
  return byName;
}

/* Tidy-tree layout for a forest: post-order, children centered under the
   parent; leaves packed left-to-right. Returns nodes with x/y set.
   IDENTITY: nodes key by instanceId, and parent NAMES resolve through the
   shared resolveLinkId — duplicate names across agents roots stay distinct
   nodes. rosterByName is the FULL-roster name index: resolution scope must
   not shrink to the cluster, or a globally-ambiguous name could falsely
   become "unique" post-clustering and reintroduce a dropped edge (review
   3ab2a40). Callers without a wider roster may omit it. */
export function layoutForest(instances, rosterByName) {
  const byId = new Map(instances.map((i) => [instanceId(i), { inst: i, id: instanceId(i), children: [] }]));
  const byName = rosterByName || nameIndex(instances);
  const roots = [];
  const parentOf = new Map();
  for (const n of byId.values()) {
    const pid = n.inst.parentInstance ? resolveLinkId(n.inst, n.inst.parentInstance, byName) : null;
    const p = pid && byId.get(pid);
    if (p && p !== n) { p.children.push(n); parentOf.set(n, p); }
    else roots.push(n);
  }
  const stateRank = instance => instance.running === true ? 0 : instance.running === false ? 1 : 2;
  const rank = (a, b) => stateRank(a.inst) - stateRank(b.inst)
    || String(a.inst.instance).localeCompare(String(b.inst.instance)) || a.id.localeCompare(b.id);

  // A malformed parentInstance cycle has no natural root and used to vanish
  // entirely. Mark normal root-reachable nodes, then promote one deterministic
  // node from every still-unreachable component and sever only its incoming
  // edge. Because every node has at most one parent, that single cut breaks the
  // component's cycle while retaining all nodes and all other valid edges.
  const reachable = new Set();
  const mark = (n) => {
    if (reachable.has(n)) return;
    reachable.add(n);
    n.children.forEach(mark);
  };
  roots.forEach(mark);
  for (const start of [...byId.values()].sort(rank)) {
    if (reachable.has(start)) continue;

    // Follow parent links from this node until the path repeats. `start` may
    // be a valid descendant that merely sorts ahead of its malformed cycle;
    // only nodes in the repeated suffix are eligible for promotion.
    const path = [], pathIndex = new Map();
    let cursorNode = start;
    while (cursorNode && !reachable.has(cursorNode) && !pathIndex.has(cursorNode)) {
      pathIndex.set(cursorNode, path.length);
      path.push(cursorNode);
      cursorNode = parentOf.get(cursorNode);
    }
    const cycle = cursorNode && pathIndex.has(cursorNode)
      ? path.slice(pathIndex.get(cursorNode))
      : [];
    const promoted = cycle.length ? [...cycle].sort(rank)[0] : start;
    const p = parentOf.get(promoted);
    if (p) p.children = p.children.filter((child) => child !== promoted);
    parentOf.delete(promoted);
    roots.push(promoted);
    mark(promoted);
  }

  roots.sort(rank);
  let cursor = 0; // next free leaf x slot
  const place = (n, depth) => {
    n.children.sort(rank);
    n.depth = depth;
    n.y = depth * (NODE_H + GAP_Y);
    if (!n.children.length) {
      n.x = cursor;
      cursor += NODE_W + GAP_X;
      return;
    }
    for (const c of n.children) place(c, depth + 1);
    const first = n.children[0], last = n.children[n.children.length - 1];
    n.x = (first.x + last.x) / 2;
    // parent wider than its subtree span never overlaps a neighbor
    if (n.x + NODE_W + GAP_X > cursor) cursor = n.x + NODE_W + GAP_X;
  };
  for (const r of roots) place(r, 0);
  const all = [];
  const collect = (n) => { all.push(n); n.children.forEach(collect); };
  roots.forEach(collect);
  return { nodes: all, width: Math.max(cursor - GAP_X, NODE_W), height: (Math.max(...all.map((n) => n.y), 0)) + NODE_H };
}

let state = null, viewSequence = 0;

/* Cluster-level placement: multi-member clusters flow left-to-right in
   wrapping rows (deterministic — cluster order comes from computeClusters);
   singletons collect in one quiet "Independent" block below. Every node's
   x/y is made group-LOCAL including the card padding/header, so the
   existing drag/edge/fit machinery works unchanged. Pure — exported for
   tests. */
export function layoutClusters(instances) {
  const clusters = computeClusters(instances);
  // FULL-roster name index: all relation resolution inside clusters (forest
  // parents, sibling edges) must use global scope — see layoutForest's note.
  const rosterByName = nameIndex((instances || []).filter((i) => i && i.instance));
  const multi = clusters.filter((c) => c.size > 1);
  const solo = clusters.filter((c) => c.size === 1);

  const placed = [];
  let cx = 0, cy = 0, rowH = 0;
  for (const c of multi) {
    const lay = layoutForest(c.instances, rosterByName);
    for (const n of lay.nodes) { n.x += CL_LEFT + n.depth * 40; n.y += CL_HEAD + CL_PAD; }
    const w = Math.max(...lay.nodes.map(n => n.x + NODE_W)) + CL_PAD;
    const h = lay.height + CL_HEAD + CL_PAD * 2;
    if (cx > 0 && cx + w > ROW_MAX) { cx = 0; cy += rowH + CL_GAP; rowH = 0; }
    placed.push({ cluster: c, nodes: lay.nodes, x: cx, y: cy, w, h,
                  sibs: siblingEdges(c, rosterByName) });
    cx += w + CL_GAP;
    rowH = Math.max(rowH, h);
  }

  let soloBlock = null;
  if (solo.length) {
    const top = placed.length ? cy + rowH + CL_GAP : 0;
    const perRow = Math.max(1, Math.floor(ROW_MAX / (NODE_W + GAP_X)));
    const nodes = solo.map((c, i) => ({
      inst: c.instances[0], id: instanceId(c.instances[0]), children: [],
      x: (i % perRow) * (NODE_W + GAP_X),
      y: CL_HEAD + Math.floor(i / perRow) * (NODE_H + SOLO_GAP_Y),
    }));
    const rows = Math.ceil(solo.length / perRow);
    soloBlock = {
      nodes, x: 0, y: top,
      w: Math.min(solo.length, perRow) * (NODE_W + GAP_X) - GAP_X,
      h: CL_HEAD + rows * (NODE_H + SOLO_GAP_Y) - SOLO_GAP_Y,
    };
  }

  let width = 0, height = 0;
  for (const p of placed) { width = Math.max(width, p.x + p.w); height = Math.max(height, p.y + p.h); }
  if (soloBlock) { width = Math.max(width, soloBlock.w); height = Math.max(height, soloBlock.y + soloBlock.h); }
  return { placed, soloBlock, clusters, width: Math.max(width, NODE_W), height: Math.max(height, NODE_H) };
}

const DEP_HEAD = 30, DEP_FIX = 22, DEP_GAP = 56, HEAD_GAP = 12;
/** The room a deployment's heading takes above its clusters: one line, and a second for the
 * "How to fix" summary of a deployment that is not live. An open disclosure is measured on screen
 * and pushes the sections below it down (placeSections). */
const headRoom = (d) => (deploymentNeedsWords(d) && (d.reason || d.fix?.length) || d.note ? DEP_HEAD + DEP_FIX : DEP_HEAD);

/** Stack deployment sections (#482): each entry's rows are laid out on their own (relations are
 * recorded within one deployment) under a heading at `y`, in the given order. A deployment with no
 * rows keeps its heading. Blocks come back in stage coordinates. */
function stackDeployments(entries) {
  const sections = [];
  let top = 0, width = 0;
  for (const { deployment, rows } of entries) {
    const room = headRoom(deployment), dy = top + room;
    const lay = rows.length ? layoutClusters(rows) : { placed: [], soloBlock: null, clusters: [], width: 0, height: 0 };
    for (const p of lay.placed) p.y += dy;
    if (lay.soloBlock) lay.soloBlock.y += dy;
    sections.push({ deployment, rows, label: deploymentLabel(deployment, DESKTOP_TERMS), y: top, room, ...lay });
    width = Math.max(width, lay.width);
    top = dy + lay.height + DEP_GAP;
  }
  return { sections, width: Math.max(width, NODE_W), height: Math.max(top - DEP_GAP, NODE_H) };
}

/** The All tab of a view of two or more deployments: one section per deployment, in the panel's order.
 * Null with one deployment (its tab is that deployment's). A row with no known deployment joins the
 * primary's. */
export function layoutByDeployment(instances, deployments) {
  if (!isMultiDeployment(deployments)) return null;
  const parts = splitByDeployment(deployments)(instances);
  return stackDeployments(deployments.map(deployment => ({ deployment, rows: parts.get(deployment.id) })));
}

/** What a tab shows: `{ rows, entries }`, `entries` being the headed sections (`[{ deployment, rows }]`)
 * or null for the unheaded overview (no deployments reported). One deployment is headed too: every machine's
 * tree sits under its name and "Instances on …" (the Machines tab, 2026-10-26). */
function tabContent(instances, deployments, tab) {
  const all = instances || [], list = Array.isArray(deployments) ? deployments : [];
  if (!list.length) return { rows: all, entries: null };
  const parts = splitByDeployment(list)(all);
  if (tab === ALL_TAB && isMultiDeployment(list)) return { rows: all, entries: list.map(deployment => ({ deployment, rows: parts.get(deployment.id) })) };
  const deployment = list.find(d => d.id === tab) || list[0], rows = parts.get(deployment.id);
  return { rows, entries: [{ deployment, rows }] };
}

const DRAG_THRESHOLD = 5; // px before a node-drag moves its tree (else it's a click)
const ROSTER_NOUN = 'roster';
const SUMMARY_PILL_WIDTH = '15em'; // about the width of "2 running · 1 stopped · 1 group"

export function mount(el, ctx) {
  ensureTheme(el.ownerDocument);
  const s = state = {
    el, ctx, win: el.ownerDocument.defaultView, windowFocused:true, panel: { instances: [] }, sel: null,
    request:0, loading:false, dataGen:null, dataWorkspace:null, stale:true, signature:null, pending:null,
    renderEpoch:0, actionTicket:0, domId:`active-${++viewSequence}`, nodeIds:new Map(), nextNodeId:0,
    tx: PAD, ty: PAD, z: 1, fitted: false,
    nodeOffsets: new Map(),        // instance -> {x,y} user-dragged box offsets
    timers: [], unsubWs: null, alive: true,
    nodeEls: new Map(), lineage: new Set(),
    tab: null, tabView: null, shown: [], fixOpen: new Set(), // the selected tab, its view, its rows, open "How to fix"
  };
  el.innerHTML = `
    <div class="hier oats-view" style="display:flex">
      <style>${hierarchyCSS}</style>
      <div class="hier-bar">
        <select class="field wssel" aria-label="Workspace" style="display:none"></select>
        <span class="hier-tabs-host"></span>
        <span style="flex:1"></span>
        <span class="hier-sum"></span>
        <span class="hier-refreshing"></span>
      </div>
      <p class="hier-intro">Each machine runs this workspace in a folder of its own. The instances under a machine run on that machine.</p>
      <div class="hier-notice" role="note" hidden><span class="hier-notice-message"></span><button class="act hier-retry" type="button">Retry roster</button><button class="act hier-readd" type="button" hidden>Re-add workspace</button></div>
      <div class="hier-panel">
        <div class="hier-canvas" tabindex="0" role="tree" aria-label="Active agents by cluster">
          <div class="hier-zoom">
            <button class="zout" title="Zoom out" aria-label="Zoom out">${icon("zoomOut", { size: 14 })}</button>
            <button class="zin" title="Zoom in" aria-label="Zoom in">${icon("zoomIn", { size: 14 })}</button>
            <button class="zfit" title="Fit to screen" aria-label="Fit to screen">${icon("fit", { size: 14 })}</button>
          </div>
        </div>
      </div>
    </div>`;
  s.q = (cls) => el.querySelector("." + cls);
  s.canvas = s.q("hier-canvas");
  s.tabPanel = s.q("hier-panel"); s.tabPanel.id = `${s.domId}-panel`;
  // The deployment tabs lead the bar (the Workspace page's tab component); the count line follows them.
  s.tabs = createDeploymentTabBar(el.ownerDocument, { idPrefix: s.domId, onSelect: (tab) => selectTab(s, tab) });
  s.q("hier-tabs-host").replaceWith(s.tabs.element);
  const doc = el.ownerDocument;
  // The shared loading controller. The summary hosts the pending pill; the
  // view's own .hier-notice keeps the stale / failed copy, so no noticeHost.
  s.status = statusLine(doc, { visuallyHidden: true, className: 'hier-status' });
  s.q('hier-bar').after(s.status);
  s.load = createDataState({ doc, noun: ROSTER_NOUN, region: s.q('hier'), skeletonHost: s.q('hier-sum'),
    skeleton: () => skeleton(doc, 'pill', { width: SUMMARY_PILL_WIDTH }), status: s.status,
    indicatorHost: s.q('hier-refreshing'), noticeHost: null, failedHost: null,
    setTimeout: (fn, ms) => s.win.setTimeout(fn, ms), clearTimeout: id => s.win.clearTimeout(id) });
  // Retry roster keeps its plain click: a second click supersedes the first
  // request (the ownership race tests pin this), so it is not bound through
  // the controller's busy gate.
  s.q('hier-retry').addEventListener('click', () => { if (s.alive) void refresh(s, { user: true }); });
  // Re-add: a deployment this Desktop's server does not serve, through the normal add (#461).
  s.q('hier-readd').addEventListener('click', () => { if (s.alive) void reAdd(s); });
  // Main binds the switch first; a workspace another window shows moves here (a take-over, as a pick from the list does).
  s.q("wssel").addEventListener("change", (e) => { void switchWorkspace(e.target.value, { takeOver: true }).then((r) => { if (!r.ok) e.target.value = currentWorkspace(); }); });
  s.q("zin").addEventListener("click", () => zoomBy(s, 1.2));
  s.q("zout").addEventListener("click", () => zoomBy(s, 1 / 1.2));
  s.q("zfit").addEventListener("click", () => { if (visibleOwner(s)) fit(s); });

  // canvas pan by drag (ignore drags that start on a node/popover/controls)
  s.pan = null;
  s.canvas.addEventListener("mousedown", (e) => {
    if (!visibleOwner(s) || e.button !== 0 || e.target.closest(".hnode") || e.target.closest(".hier-pop") || e.target.closest(".hier-zoom") || e.target.closest(".hier-dfix")) return;
    s.fitted = true; // an explicit camera gesture wins over a later first observation
    s.pan = { x: e.clientX - s.tx, y: e.clientY - s.ty };
    s.canvas.classList.add("panning");
    closePop(s);
  });
  s.win.addEventListener("mousemove", s.onMove = (e) => {
    if (!visibleOwner(s)) { cancelGesture(s); return; }
    if (s.drag) { onNodeDragMove(s, e); return; }
    if (!s.pan) return;
    s.tx = e.clientX - s.pan.x; s.ty = e.clientY - s.pan.y;
    applyTransform(s);
  });
  s.win.addEventListener('blur', s.onBlur = () => { s.windowFocused = false; s.activity?.invalidate(); cancelGesture(s); });
  s.win.addEventListener('focus', s.onFocus = () => { s.windowFocused = true; s.activity?.sync(); });
  s.win.addEventListener('resize', s.onResize = () => { if (visibleOwner(s)) { if (!s.fitted) fit(s); positionPop(s); } });
  s.win.addEventListener("mouseup", s.onUp = (e) => {
    if (!visibleOwner(s)) { cancelGesture(s); return; }
    if (s.drag) { onNodeDragEnd(s, e); return; }
    s.pan = null; s.canvas.classList.remove("panning"); applyPending(s);
  });

  // zoom: pinch / ⌘-wheel zooms about the cursor; plain wheel pans
  s.canvas.addEventListener("wheel", (e) => {
    if (!visibleOwner(s) || e.defaultPrevented || e.target.closest?.('.hier-pop')) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY * 0.01);
      zoomBy(s, factor, e.clientX, e.clientY);
    } else {
      s.tx -= e.deltaX; s.ty -= e.deltaY;
      applyTransform(s);
    }
  }, { passive: false });

  // keyboard: walk the tree, Enter opens terminal, f fits, Escape clears
  s.canvas.addEventListener("keydown", (e) => onKey(s, e));

  // Register the canvas keys as actions. Their DEFAULT chords ride the
  // registration (engine addendum 3: defaultChord) so the shortcuts editor
  // shows them honestly and Backspace/reset behave. The context is a VIEW
  // context the shell never activates (review afd2114): these actions are
  // editor-visible and conflict-checked but window-dispatch-INELIGIBLE —
  // matchEvent skips them before selecting/preventDefault, so an outside
  // rail/sidebar keypress is not swallowed and colliding global actions
  // still run. ALL dispatch is view-local (onKey → resolveViewKey against
  // the engine's effective bindings). Disposed on unmount.
  s.viewActions = [
    { id: "hier.fit", defaultChord: "F", label: "Hierarchy: fit to screen", run: () => fit(s) },
    // Spec F: the canvas's zoom keys are - / = / 0 (zoom out, in, fit); 0 is fit's second shortcut.
    { id: "hier.fitZero", defaultChord: "0", label: "Hierarchy: fit to screen (second shortcut)", run: () => fit(s) },
    { id: "hier.terminal", defaultChord: "T", label: "Hierarchy: go to the instance of selection", run: () => { if (s.sel) openTerm(s, s.sel); } },
    { id: "hier.spawn", defaultChord: "S", label: "Hierarchy: open the Spawn view", run: () => openWorkspace(s) },
    { id: "hier.popover", defaultChord: "O", label: "Hierarchy: open the action popover", run: () => { if (s.sel) { openPop(s, s.sel); s.pop?.querySelector('button:not(:disabled)')?.focus(); } } },
    { id: "hier.zoomIn", defaultChord: "=", label: "Hierarchy: zoom in", run: () => zoomBy(s, 1.2) },
    { id: "hier.zoomOut", defaultChord: "-", label: "Hierarchy: zoom out", run: () => zoomBy(s, 1 / 1.2) },
  ];
  s.disposers = s.viewActions.map((a) => registerAction({
    id: a.id, label: a.label, context: "view:hierarchy", run: a.run, defaultChord: a.defaultChord,
  }));

  s.unsubWs = onWorkspaceChange(() => { resetObservation(s); void refresh(s); });
  // A new connection (backend replaced, forge auth changed): the read in flight belongs to the old one.
  // A read on the new connection starts now; it revokes the old read's outcome and arms the new
  // subject's deadline (#461), so neither waits for the old read to settle.
  const offConnections = s.ctx.subscribeConnections?.(() => { if (s.alive) void refresh(s); });
  if (typeof offConnections === 'function') s.disposers.push(offConnections);
  // #1247: a retire of this window began, was refused or was read after: the rows read again from the held set.
  const offRetires = s.ctx.subscribeRetires?.(() => retiresChanged(s));
  if (typeof offRetires === 'function') s.disposers.push(offRetires);
  // Another surface opens a deployment's tab (the switcher's "Not matched" entries): already remembered,
  // so a view not on screen yet reads it when its panel lands; the shown view switches now.
  s.disposers.push(onDeploymentTabRequest(({ view, tab }) => {
    if (s.alive && dataCurrent(s) && view === s.panel.workspace?.id) selectTab(s, tab, { remember: false });
  }));
  refresh(s); s.polledAt = Date.now();
  // Every 4 s while its window is focused, at the server's blurred cadence otherwise (roster-cadence.mjs, #481).
  // The document's own focus, read on each tick: a window can lose focus before this stage mounts.
  s.timers.push(setInterval(() => {
    if (s.loading || !rosterPollDue({ focused: el.ownerDocument.hasFocus(), last: s.polledAt, now: Date.now() })) return;
    s.polledAt = Date.now(); void refresh(s);
  }, ROSTER_POLL_FOCUSED_MS));

  return () => teardown(s);
}

export function unmount() { if (state) teardown(state); }

function teardown(s) {
  if (!s.alive) return;
  s.alive = false; s.request++; s.actionTicket++; s.pending = null; s.pan = null; s.drag = null;
  s.activity?.dispose(); s.activity = null;
  s.load?.dispose(); s.load = null;
  s.pendingWatch?.dispose();
  s.tabs?.dispose?.();
  s.win.clearTimeout(s.clickResetTimer);
  s.timers.forEach(clearInterval);
  (s.disposers || []).forEach((off) => { try { off(); } catch {} });
  if (s.unsubWs) s.unsubWs();
  s.win.removeEventListener("mousemove", s.onMove);
  s.win.removeEventListener("mouseup", s.onUp);
  s.win.removeEventListener('resize', s.onResize);
  s.win.removeEventListener('blur', s.onBlur); s.win.removeEventListener('focus', s.onFocus);
  s.el.innerHTML = "";
  if (state === s) state = null;
}

const docOf = s => s.el?.ownerDocument || document;
function node(s, tag, text, cls) {
  const el = docOf(s).createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (cls) el.className = cls;
  return el;
}
function visibleOwner(s, element = s.canvas) {
  if (!s.alive || s.windowFocused === false || !element?.isConnected) return false;
  for (let parent = element; parent; parent = parent.parentElement) {
    if (parent.hidden || parent.inert || parent.style?.display === 'none' || parent.style?.visibility === 'hidden') return false;
  }
  return true;
}
function dataCurrent(s) {
  return s.alive && s.dataGen === workspaceGeneration() && s.dataWorkspace === currentWorkspace();
}
function actionsCurrent(s) { return dataCurrent(s) && !s.stale && !s.pending; }
/** Actions on one row also wait when its deployment is stale (#482: that deployment's last re-read failed). */
function rowActionsCurrent(s, i) { return actionsCurrent(s) && !rowStale(i, s.panel.deployments); }
/** The stale rule's age (" · observed 45s ago") for the kept observation, from the panel's observedAt; nothing when unreported. */
/** The notice of a kept failure (the last read failed), composed from its parts. `own` is the Desktop's
 * sentence about what is on screen. The failure's message is one display line, cut to 300, and its speaker
 * is the one the failure notice beside it names (speaker-line.mjs, from the same mark):
 *
 *   the kernel's, a line     "Roster unavailable. <own> OATS says: <line>"
 *   the kernel's, withheld   "Roster unavailable. <own> [withheld]"
 *   no speaker, a line       "Roster unavailable: <line>. <own>"
 *   no speaker, withheld     "Roster unavailable: [withheld]. <own>"
 *   nothing to show          "Roster unavailable. <own>"
 *
 * The kernel's words stand apart, after the Desktop's own sentences; a message with no speaker stays inside
 * them. Both of the view's notes of a kept failure are written here: the one over the rows it kept
 * (`reportedObservationNote`) and the one of a failed read that kept none (`presentFailure`). */
function keptFailureNote(kept, own) {
  const { lead, line } = speakerParts(kept.origin, kept.message);
  const shown = line === null ? null : line.slice(0, 300);
  if (kept.origin === 'kernel') return ['Roster unavailable.', own, lead, shown].filter(part => part !== null).join(' ');
  return shown === null ? `Roster unavailable. ${own}` : `Roster unavailable: ${shown}. ${own}`;
}
/** The note over rows kept after a failed read. */
const reportedObservationNote = (kept, age) => keptFailureNote(kept, `Showing a reported observation${age}, not current state; actions disabled.`);
/** A failed read that kept no rows, as the error `refresh` throws: the kept failure itself travels on it,
 * for `presentFailure` to compose the notice from; its message is the line the loading status speaks. */
function keptFailureError(kept) { return Object.assign(Error(keptFailureLine(kept) ?? ''), { kept }); }
function staleAge(s) {
  const age = observedText(s.load?.observedAt ?? null, Date.now());
  return age ? ` · ${age}` : '';
}
/** Re-add the deployment named by the not-served notice through the normal add, then read again.
 * Latest intent: only the newest Re-add, in the same workspace selection, may act on its outcome, and a
 * failure never replaces an observation that landed meanwhile (the add itself restarts the server). */
async function reAdd(s) {
  const button = s.q('hier-readd'), path = s.reAddPath;
  if (!path || typeof s.ctx.reAddWorkspace !== 'function' || s.reAdding) return;
  const lease = s.reAddLease = (s.reAddLease || 0) + 1, gen = workspaceGeneration();
  s.reAdding = true; button?.setAttribute?.('aria-disabled', 'true');
  let result;
  try { result = await s.ctx.reAddWorkspace(path); } catch (error) { result = { ok: false, reason: error?.message }; }
  if (!s.alive || lease !== s.reAddLease) return;
  s.reAdding = false; button?.removeAttribute?.('aria-disabled');
  if (gen !== workspaceGeneration() || currentWorkspace() !== path) return;
  if (result?.ok) { s.pendingWatch?.reset(); void refresh(s, { user: true }); return; }
  if (!s.stale && s.dataWorkspace === path) return; // a newer observation of this deployment stands
  notice(s, `Couldn't re-add ${path}: ${result?.reason || 'the add failed'}`);
  s.load?.say?.(`Couldn't re-add ${path}.`);
}
function notice(s, message) {
  const el = s.q('hier-notice'); if (!el) return;
  const text = el.querySelector?.('.hier-notice-message');
  if (text) text.textContent = message; else el.textContent = message;
  el.hidden = !message;
}
function clearCanvas(s, retainedPop = null) {
  const controls = s.canvas.querySelector('.hier-zoom');
  if (retainedPop) {
    // A remove+reinsert collapses native text ranges even when the same popup
    // object is reused. Keep the reading surface CONNECTED during roster paint.
    for (const child of [...s.canvas.children]) if (child !== controls && child !== retainedPop) child.remove();
  } else { s.canvas.innerHTML = ''; if (controls) s.canvas.append(controls); }
  s.nodeEls.clear(); s.dragConsumedClick = null; s.canvas.removeAttribute?.('aria-activedescendant');
}
function cancelGesture(s) {
  if (!s.alive) return;
  s.drag?.node.classList.remove('dragging'); s.drag = null; s.pan = null; s.dragConsumedClick = null;
  s.canvas.classList.remove('panning'); if (s.alive) applyPending(s);
}
function resetObservation(s) {
  s.request = (s.request || 0) + 1; s.actionTicket = (s.actionTicket || 0) + 1;
  closePop(s); s.sel = null; s.fitted = false; s.nodeOffsets.clear(); s.nodeIds?.clear();
  s.drag?.node.classList.remove('dragging'); s.drag = null; s.dragConsumedClick = null; s.pan = null;
  s.canvas.classList.remove('panning'); s.pending = null; s.signature = null; s.bounds = null;
  s.panel = { instances: [] }; s.observed = null; s.retiresLater = false; s.loading = false; s.dataGen = null; s.dataWorkspace = null; s.stale = true; s.readsServers = false;
  // A new subject: the controller forgets its data; the summary stays blank
  // until the pending pill (150ms) or the first reply. Never counts of nothing.
  s.load?.reset();
  s.tab = null; s.tabView = null; s.shown = []; s.fixOpen?.clear(); paintTabs(s, []);
  clearCanvas(s); s.q('hier-sum').textContent = ''; notice(s, '');
}
/** What a paint depends on: the observation, and (#482) the view's deployments, which head its sections. */
const viewSignature = (panel) => `${activeSignature(panel)}\n${JSON.stringify(panel.deployments || [])}`;
/** The observation as the canvas draws it and offers acts on it (#1247): the shell's own retires in flight
 * held as retiring (ctx.retiringRows), as the roster draws them. */
const shownPanel = (s, panel) => typeof s.ctx.retiringRows === 'function' ? { ...panel, instances: s.ctx.retiringRows(panel.instances) } : panel;
/** The held set changed: the observation on screen is drawn again through it, after a gesture when one runs. */
function retiresChanged(s) {
  if (!s.observed || !dataCurrent(s)) return;
  if (s.drag || s.pan) { s.retiresLater = true; return; }
  const panel = shownPanel(s, s.observed), signature = viewSignature(panel);
  s.panel = panel;
  if (signature !== s.signature) { s.signature = signature; render(s); } else updatePop(s);
}
function acceptObservation(s, observed, gen) {
  const panel = shownPanel(s, observed);
  s.observed = observed;
  const signature = viewSignature(panel);
  const ids = new Set(panel.instances.map(instanceId));
  for (const key of s.nodeOffsets.keys()) if (!ids.has(key)) s.nodeOffsets.delete(key);
  for (const key of s.nodeIds?.keys() || []) if (!ids.has(key)) s.nodeIds.delete(key);
  // Whether the last read failed is the shared home's rule (keptFailure), never a test of the message.
  const kept = keptFailure(panel);
  s.panel = panel; s.dataGen = gen; s.dataWorkspace = currentWorkspace(); s.stale = !!kept; s.pending = null;
  // The read landed: the controller drops the pill / indicator before the summary repaints. A panel
  // that reports an error beside its instances is the kernel's last observation: stale, announced once
  // (the view's notice is a note; the controller's hidden status line is the one live region).
  if (s.load && (!kept || !s.load.hasData)) s.load.succeed({ observedAt: panel.observedAt ?? null, empty: !panel.instances.length });
  // The failure's message with who made it (speaker-line.mjs); a repeated stale poll updates in place, no re-announcement.
  if (kept) s.load?.fail({ message: keptFailureLine(kept) });
  if (s.ctx.hasWorkspaceSwitcher) s.q('wssel').style.display = 'none';
  else renderWorkspaceSelect(s.q('wssel'), panel.workspaces, panel.workspace?.id || '');
  notice(s, kept ? reportedObservationNote(kept, staleAge(s)) : '');
  if (signature !== s.signature) { s.signature = signature; render(s); }
  else { if (!s.fitted) fit(s); updatePop(s); }
}
function applyPending(s) {
  const pending = s.pending, later = s.retiresLater; s.pending = null; s.retiresLater = false;
  if (!pending || !s.alive || pending.gen !== workspaceGeneration() || pending.request !== s.request) { if (later && s.alive) retiresChanged(s); return; }
  acceptObservation(s, pending.panel, pending.gen);
}

/* Every request owns BOTH outcomes, even within the same workspace. The
   loading controller hears begin() here and succeed()/fail() only from the
   request that still owns the view. `user`: a Retry the person asked for. */
export async function refresh(s, { user = false } = {}) {
  if (!s.alive) return;
  // The deadline is its own timer on the view's window: it fires at the bound even while an unanswered
  // read holds the single-flight poll (s.loading), and a later owned observation still recovers.
  // (A view state without a window, a unit test's, keeps the check on each settled read only.)
  s.pendingWatch ||= createPendingWatch(s.win ? { onOverdue: subject => overdue(s, subject),
    setTimeout: (fn, ms) => s.win.setTimeout(fn, ms), clearTimeout: id => s.win.clearTimeout(id) } : {});
  if (user) s.pendingWatch.reset(); // a Retry restarts the bounded wait for an answer
  const myGen = workspaceGeneration(), requestedWorkspace = currentWorkspace();
  // The bounded wait (#461) runs from the first read of this deployment, on this connection, that brought
  // no observation: answered "pending", or not answered at all. Any other answer from the server ends it.
  const subject = pendingSubject(s);
  s.pendingWatch.observe(subject, true);
  const request = s.request = (s.request || 0) + 1;
  const owns = () => s.alive && request === s.request && myGen === workspaceGeneration();
  s.loading = true;
  // A background re-read of a failed roster is not announced again; a Retry, or a changed outcome, is.
  if (user || s.load?.state !== 'failed') s.load?.begin({ user });
  try {
    // A Retry of a window with a deployment on another machine reads the servers again first (#1117): the panel
    // is served from the server's last roster read, and the refresh answers once a fresh one has landed.
    if (user && s.readsServers) await apiJson(s.ctx, '/api/remote-roster/refresh', { method: 'POST' });
    if (!owns()) return;
    const data = await apiJson(s.ctx, `/api/panel${wsQuery()}`);
    if (!owns()) return;
    const panel = projectActivePanel(data);
    attachDeployments(panel, data, instanceId); // #482: the view's deployments and each row's, for the deployment sections
    // Whether this window has a deployment on another machine, as its last reply said: what a Retry reads again.
    s.readsServers = panel.workspace?.remote === true || (panel.deployments || []).some(d => !d.local);
    // observedAt (spec 02, additive) labels the observation's age; never invented.
    panel.observedAt = typeof data.observedAt === 'string' && data.observedAt ? data.observedAt : null;
    if (data.deployment?.status !== 'pending') s.pendingWatch.observe(null, false); // the server answered
    // Failed absence is not an observed empty roster: the kept failure, its message and who made it.
    const kept = keptFailure(panel);
    if (kept && !panel.instances.length) throw keptFailureError(kept);
    // A deployment the kernel has not observed yet (the server's first read is
    // still running) or could not observe is not an empty roster either. Pending
    // keeps its own copy in the summary — no skeleton, no counts, no empty state —
    // and the next poll brings the observation; a refusal is a failed read.
    const deployment = !panel.workspace?.remote && data.deployment && typeof data.deployment === 'object' && data.deployment.status !== 'observed' ? data.deployment : null;
    if (deployment && !panel.instances.length) {
      if (deployment.status !== 'pending') throw Error(deploymentUnavailableText(deployment, DESKTOP_TERMS));
      // Pending past the bound is no answer, not a longer wait (#461); a later observation still lands.
      if (s.pendingWatch.observe(subject, true)) throw unservedError(NO_ANSWER_CODE, requestedWorkspace || panel.workspace?.id || '');
      // With this deployment's observation on screen (a new connection still reading), it stays as it was.
      if (s.dataGen != null) { s.load?.cancel(); return; }
      // The controller stays pending (aria-busy, the one announcement) without a pill: the copy is the summary.
      s.load?.defer(); s.q('hier-sum').textContent = deploymentUnavailableText(deployment, DESKTOP_TERMS); notice(s, '');
      return;
    }
    // A stale selection (persisted, no longer served) behaves like an empty
    // one: adopt the served workspace. A served selection answered with
    // another workspace is a real mismatch and stays refused.
    const stale = staleWorkspaceSelection(requestedWorkspace, panel);
    if (requestedWorkspace && !stale && panel.workspace?.id && panel.workspace.id !== requestedWorkspace) throw Error('The roster reply belongs to a different workspace. Choose the workspace again.');
    if ((!requestedWorkspace || stale) && panel.workspace?.id) adoptWorkspace(panel.workspace.id);
    if ((s.drag || s.pan) && viewSignature(panel) !== s.signature) {
      s.pending = { panel, gen: myGen, request }; updatePop(s);
      notice(s, 'Roster changed during this gesture; the latest observation will apply on release.');
      return;
    }
    acceptObservation(s, panel, myGen);
  } catch (caught) {
    if (!owns()) return;
    let error = caught;
    // Not served is an answer. Anything else that leaves this deployment without an observation past the
    // bound (a read the proxy timed out, the bridge down) is reported as no answer, by name.
    if (error?.code === NOT_SERVED_CODE) s.pendingWatch.observe(null, false);
    else if (error?.code !== NO_ANSWER_CODE && s.pendingWatch.observe(subject, true)) error = unservedError(NO_ANSWER_CODE, requestedWorkspace);
    presentFailure(s, error, requestedWorkspace);
  } finally { if (owns()) s.loading = false; }
}

/** The bounded wait's subject: this deployment on this connection. */
function pendingSubject(s) { return `${s.ctx.connectionGeneration?.() ?? 0}\n${currentWorkspace()}`; }

/** The bounded wait ran out for the deployment still shown (#461): no answer, said now. */
function overdue(s, subject) {
  if (!s.alive || subject !== pendingSubject(s)) return;
  const ws = currentWorkspace();
  presentFailure(s, unservedError(NO_ANSWER_CODE, ws), ws);
}

/** A read of `requestedWorkspace` failed (or got no answer in time): stale with data, failed without. */
function presentFailure(s, error, requestedWorkspace) {
  s.pending = null; s.stale = true; s.actionTicket = (s.actionTicket || 0) + 1;
  // The controller announces the failure and drops its pill; the view's
  // notice below is the visible failure surface (no failedHost).
  s.load?.fail(error);
  if (s.dataGen == null) s.q('hier-sum').textContent = 'Roster unknown';
  // A deployment the server does not serve, or does not answer for (#461), is named in full; Re-add when not served.
  const unserved = [NOT_SERVED_CODE, NO_ANSWER_CODE].includes(error?.code);
  const readd = s.q('hier-readd');
  s.reAddPath = error?.code === NOT_SERVED_CODE && String(requestedWorkspace || '').startsWith('/') ? requestedWorkspace : null;
  if (readd) readd.hidden = !(s.reAddPath && typeof s.ctx.reAddWorkspace === 'function');
  const said = error?.code === NOT_SERVED_CODE ? unservedError(NOT_SERVED_CODE, requestedWorkspace).message
    : String(error?.message || 'read failed').slice(0, 300);
  const own = s.dataGen == null ? 'No current observation.' : `Showing the last observation${staleAge(s)}, not current state; actions disabled.`;
  // A kept failure is said in its own forms (keptFailureNote); "read failed" is a thrown error with no message.
  notice(s, error?.kept ? keptFailureNote(error.kept, own) : `${unserved ? said : `Roster unavailable: ${said}.`} ${own}`);
  updatePop(s);
}

/** localStorage of the view's own window (the tab choice is a convenience: none, nothing changes). */
function tabStorage(s) { try { return s.win?.localStorage ?? null; } catch { return null; } }

/** Paint the tab bar for `tabs` with the selected tab; the panel is a tabpanel only while tabs show. */
function paintTabs(s, tabs) {
  if (!s.tabs) return;
  s.tabs.paint(tabs, s.tab, s.tabPanel?.id);
  const selected = tabs.length ? s.tabs.selected() : null;
  if (!s.tabPanel) return;
  if (selected) { s.tabPanel.setAttribute('role', 'tabpanel'); s.tabPanel.setAttribute('aria-labelledby', selected.id); }
  else { s.tabPanel.removeAttribute('role'); s.tabPanel.removeAttribute('aria-labelledby'); }
}

/** The tab the shown view shows: kept while the view and the tab stand, else the remembered one (or the
 * first) for this view. Paints the bar. */
function resolveTab(s) {
  const deployments = s.panel.deployments || [], view = s.panel.workspace?.id || null, tabs = deploymentTabs(deployments);
  if (s.tabView !== view || !tabs.some(t => t.id === s.tab)) { s.tab = selectedDeploymentTab(view, deployments, tabStorage(s)); s.tabView = view; }
  paintTabs(s, tabs);
  return s.tab;
}

/** A tab chosen (a click, an arrow key, or another surface's request): remembered for the view, and
 * the canvas repainted for it and fitted. Selection and popover stay while their row is still shown. */
function selectTab(s, tab, { remember = true } = {}) {
  if (!s.alive || !dataCurrent(s)) return;
  const view = s.panel.workspace?.id || null;
  if (!deploymentTabs(s.panel.deployments).some(t => t.id === tab)) return;
  if (remember) rememberDeploymentTab(view, tab, tabStorage(s));
  if (tab === s.tab && view === s.tabView) return;
  s.tab = tab; s.tabView = view; s.fitted = false;
  render(s);
}

function render(s) {
  const canvas = s.canvas;
  const prevPop = s.popFor, preservedPop = s.pop, focused = docOf(s).activeElement;
  const preserveFocus = preservedPop?.contains(focused);
  s.renderEpoch = (s.renderEpoch || 0) + 1;
  clearCanvas(s, visibleOwner(s, preservedPop) ? preservedPop : null);
  // The selected tab's rows, and its headed sections (null: the unheaded overview). The count line
  // counts this tab only.
  const { rows: list, entries } = tabContent(s.panel.instances || [], s.panel.deployments, resolveTab(s));
  s.shown = list;
  const { running, stopped, unknown } = runtimeCounts(list);
  const status = `<b>${running}</b> running · <b>${stopped}</b> stopped${unknown ? ` · <b>${unknown}</b> unknown` : ""}`;
  s.q("hier-sum").innerHTML =
    status;
  const quiet = !entries || entries.every(e => !deploymentNeedsWords(e.deployment));
  if (!list.length && (quiet || entries.length === 1)) {
    s.q('hier-sum').innerHTML = `${status} · <b>0</b> groups`;
    s.sel = null; closePop(s);
    const w = document.createElement("div");
    w.className = "hier-empty-wrap";
    w.style.height = "100%";
    if (quiet) {
      w.innerHTML = `<div class="empty"><span class="big">${icon("overview", { size: 22 })}</span>` +
        `No instances reported in this observation.<br>Choose a soul in Workspace or use <code>oats spawn &lt;agent&gt;</code>.</div>`;
      // Live deployments' notes (information, not a failure) still head the empty tab, All included.
      const noted = (entries || []).filter(e => e.deployment.note);
      if (noted.length) w.prepend(...noted.map(e => deploymentReasonBlock(docOf(s), headOptions(s, e.deployment, e.rows))));
    } else {
      // A deployment that is not live, with nothing to show: why and how to fix it, never a silent empty.
      w.append(deploymentReasonBlock(docOf(s), headOptions(s, entries[0].deployment, entries[0].rows)));
    }
    canvas.append(w);
    return;
  }

  // Clusters — connected components over the FULL roster's parent/child +
  // sibling links — are computed before any visual decoration, so a valid
  // relation crossing agent/workspace roots never turns a child into an
  // orphan. Node metadata still identifies its repo/root.
  // Views (#482): each headed section lays out its own deployment's rows (relations never cross
  // sections); unheaded, the single section is exactly the layout the overview always drew.
  const byDeployment = entries ? stackDeployments(entries) : null;
  const sections = byDeployment ? byDeployment.sections : [{ deployment: null, ...layoutClusters(list) }];
  const { width, height } = byDeployment || sections[0];
  const nGroups = sections.reduce((n, x) => n + x.placed.length, 0), nIndependent = sections.reduce((n, x) => n + (x.soloBlock?.nodes.length || 0), 0);
  s.q("hier-sum").innerHTML = `${status} · <b>${nGroups}</b> group${nGroups === 1 ? '' : 's'}${nIndependent ? ` · <b>${nIndependent}</b> independent` : ''}`;
  const stage = document.createElement("div");
  stage.className = "hier-stage";

  s.edgesByNode = new Map(); // instance -> [path els touching it]
  s.bounds = { w: width, h: height, base: height };

  const BLEED = 2000; // edge svg overdraw so dragged boxes keep their edges
  const groupFor = (block, key, ariaLabel, cls) => {
    const group = document.createElement("div");
    group.className = "hier-group" + (cls ? " " + cls : "");
    group.dataset.ws = key;
    group.style.left = `${block.x}px`;
    group.style.top = `${block.y}px`;
    group.style.width = `${block.w}px`;
    group.style.height = `${block.h}px`;
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", ariaLabel);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("hier-edges");
    svg.setAttribute("width", block.w + BLEED * 2);
    svg.setAttribute("height", block.h + NODE_H + BLEED * 2);
    svg.setAttribute("viewBox", `${-BLEED} ${-BLEED} ${block.w + BLEED * 2} ${block.h + NODE_H + BLEED * 2}`);
    svg.style.left = `${-BLEED}px`; svg.style.top = `${-BLEED}px`;
    group.append(svg);
    // final position = tidy layout + any user drag offset
    for (const n of block.nodes) {
      const off = s.nodeOffsets.get(n.id) || { x: 0, y: 0 };
      n.fx = n.x + off.x; n.fy = n.y + off.y;
      group.append(nodeEl(s, n, key));
    }
    const addEdge = (p, a, b) => {
      svg.append(p);
      for (const nm of [a, b]) {
        if (!s.edgesByNode.has(nm)) s.edgesByNode.set(nm, []);
        s.edgesByNode.get(nm).push(p);
      }
    };
    for (const n of block.nodes) {
      for (const c of n.children) {
        const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.dataset.child = c.id;
        p.dataset.parent = n.id;
        drawEdge(p, n, c);
        addEdge(p, n.id, c.id);
      }
    }
    // sibling links: dashed peer edges, distinct by STYLE (never color alone)
    const byId = new Map(block.nodes.map((n) => [n.id, n]));
    for (const { a, b } of block.sibs || []) {
      const na = byId.get(a), nb = byId.get(b);
      if (!na || !nb) continue;
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.classList.add("sib");
      p.dataset.parent = a; p.dataset.child = b; // endpoint names for redraw on drag
      drawSiblingEdge(p, na, nb);
      addEdge(p, a, b);
    }
    return group;
  };

  // Agent groups (Redesign v3; supersedes the anonymous-card decision): the
  // header names the group by its deterministic key — the same name as the
  // sidebar group — then "count · reported repos".
  for (const { deployment, rows, y, room, placed, soloBlock } of sections) {
    const host = deployment ? deploymentSection(s, { deployment, rows, y, room }) : stage;
    if (host !== stage) stage.append(host);
    for (const pc of placed) {
      const c = pc.cluster;
      const aria = `Agent group ${c.label}: ${c.size} agents, ${c.running} running${c.unknown ? `, ${c.unknown} unknown` : ""}`;
      const group = groupFor(pc, c.name, aria, "hier-cluster");
      group.dataset.top = String(pc.y);
      const head = document.createElement("div");
      head.className = "hier-chead";
      const contexts = [...new Set(c.instances.map(i => i.repoName).filter(Boolean))];
      head.append(node(s, 'span', c.label, 'cnm'), node(s, 'span', [String(c.size), ...contexts].join(' · '), 'cct'));
      head.title = `${c.label} — ${c.running}/${c.size} running${c.unknown ? `, ${c.unknown} unknown` : ''}`;
      group.prepend(head);
      host.append(group);
    }
    if (soloBlock) {
      // Each deployment's Independent strip is its own keyboard group.
      const group = groupFor({ ...soloBlock, sibs: [] }, deployment ? `Independent:${deployment.id}` : "Independent",
        `Independent agents: ${soloBlock.nodes.length}`, "hier-solo");
      group.dataset.top = String(soloBlock.y);
      const head = document.createElement("div");
      head.className = "hier-chead solo";
      head.innerHTML = `<span class="cnm">Independent</span>` +
        `<span class="cct">${soloBlock.nodes.length}</span>`;
      group.prepend(head);
      host.append(group);
    }
  }
  canvas.insertBefore(stage, preservedPop?.parentNode === canvas ? preservedPop : null);
  if (byDeployment) placeSections(s);
  // first paint (or workspace / tab switch): fit the forest to the visible screen
  if (!s.fitted) fit(s); else applyTransform(s);
  if (s.sel && !list.some((i) => instanceId(i) === s.sel)) s.sel = null;
  paintSelection(s);
  // keep the popover across the 4s refresh if its instance still exists
  if (prevPop && list.some((i) => instanceId(i) === prevPop)) {
    openPop(s, prevPop, preservedPop);
    // Retain the actual focused control, but never reclaim focus moved by a
    // synchronous blur handler elsewhere. No request completion selects a node.
    if (preserveFocus && visibleOwner(s, focused) && docOf(s).activeElement === docOf(s).body) focused.focus({ preventScroll: true });
  } else { s.activity?.dispose(); s.activity = null; preservedPop?.remove(); s.pop = null; s.popFor = null; }
}

/** One deployment's section (#482): a group named by its heading's words, the heading (deployments-page.mjs)
 * at `y`, and the clusters added by the caller. The heading's disclosure stays open across repaints. */
function deploymentSection(s, { deployment, rows, y, room }) {
  const section = node(s, 'div', undefined, 'hier-deployment');
  section.setAttribute('role', 'group');
  section.dataset.deployment = deployment.id;
  const { element: head, label } = deploymentHead(docOf(s), headOptions(s, deployment, rows));
  section.setAttribute('aria-label', label);
  head.style.top = `${y}px`; head.dataset.top = String(y); head.dataset.room = String(room);
  section.append(head);
  return section;
}
/** A heading's facts, and its disclosure's open state kept per deployment across repaints. */
function headOptions(s, deployment, rows) {
  s.fixOpen ||= new Set();
  return { deployment, rows, open: s.fixOpen.has(deployment.id), onToggle: (open) => {
    if (!s.alive) return;
    if (open) s.fixOpen.add(deployment.id); else s.fixOpen.delete(deployment.id);
    placeSections(s);
  } };
}

/** Keep each section's clusters below its heading as drawn: a heading taller than the room the layout
 * gave it (an open "How to fix") pushes its clusters and every later section down by the difference.
 * Idempotent (from the laid-out tops); a host without layout (no measured height) moves nothing. */
function placeSections(s) {
  let shift = 0;
  for (const section of s.canvas.querySelectorAll?.('.hier-stage > .hier-deployment') || []) {
    const head = section.querySelector(':scope > .hier-dhead');
    if (!head) continue;
    head.style.top = `${Number(head.dataset.top) + shift}px`;
    const height = head.offsetHeight || 0;
    if (height) shift += Math.max(0, height + HEAD_GAP - Number(head.dataset.room));
    for (const group of section.querySelectorAll(':scope > .hier-group')) group.style.top = `${Number(group.dataset.top) + shift}px`;
  }
  if (s.bounds) s.bounds.h = s.bounds.base + shift;
  positionPop(s);
}

function nodeEl(s, n, wsName) {
  // #802: a home the kernel holds names its state ("Setting up worktree…", "Spawn didn't finish"…) in words.
  const i = n.inst, id = n.id ?? instanceId(i), status = runtimeState(i), held = heldHome(i);
  const d = node(s, 'div', undefined, 'hnode' + (status === 'stopped' ? ' idle' : status === 'unknown' ? ' unknown' : ''));
  s.nodeIds ||= new Map();
  if (!s.nodeIds.has(id)) s.nodeIds.set(id, `${s.domId || 'active'}-node-${s.nextNodeId = (s.nextNodeId || 0) + 1}`);
  d.id = s.nodeIds.get(id);
  d.style.left = `${n.fx}px`; d.style.top = `${n.fy}px`;
  d.setAttribute('role', 'treeitem'); d.setAttribute('aria-level', String((n.depth || 0) + 1));
  const target = activeTargetLabel(i, s.panel.instances);
  d.setAttribute('aria-label', `${i.instance}, ${held?.status ?? status}${target ? `, ${target}` : ''}`);
  d.dataset.name = i.instance; d.dataset.id = id;
  const name = node(s, 'div', undefined, 'hname');
  const dot = node(s, 'span', undefined, `hdot ${status === 'running' ? 'on' : status === 'stopped' ? 'off' : 'unknown'}`); dot.setAttribute('aria-hidden', 'true');
  paintDotColor(dot, i, status);
  name.append(dot, node(s, 'span', i.instance, 'nm'));
  const metadata = [target, i.repoName || 'Context not reported', i.harness || 'Harness not reported', i.branch || '', status === 'unknown' ? 'state unknown' : '', held?.state || ''].filter(Boolean).join(' · ');
  d.append(name, node(s, 'div', metadata, 'hmeta'));
  d.title = `${i.instance}\n${metadata}\nHome: ${i.home || 'not reported'}\nRoot: ${i.agentsRoot || 'not reported'}`;
  const current = () => dataCurrent(s) && visibleOwner(s, d) && !s.pending && s.nodeEls.get(id)?.el === d;
  d.addEventListener('mousedown', e => {
    if (!current() || e.button !== 0) return;
    s.fitted = true;
    e.stopPropagation();
    const off = s.nodeOffsets.get(id) || { x: 0, y: 0 };
    s.drag = { name: id, node: d, n, startX: e.clientX, startY: e.clientY, off: { ...off }, moved: false };
  });
  d.addEventListener('click', e => {
    e.stopPropagation();
    if (!current()) return;
    if (s.dragConsumedClick?.node === d) { s.dragConsumedClick = null; return; }
    select(s, id); s.canvas.focus?.({ preventScroll: true });
  });
  d.addEventListener('dblclick', e => { e.stopPropagation(); if (current()) openTerm(s, id); });
  d.addEventListener('mouseenter', () => { if (current()) litLineage(s, id, true); });
  d.addEventListener('mouseleave', () => { if (current()) litLineage(s, id, false); });
  s.nodeEls.set(id, { el: d, node: n, ws: wsName });
  return d;
}

function openWorkspace(s, owner = () => true) {
  if (!visibleOwner(s) || !owner() || !s.ctx.openView) return;
  const gen = workspaceGeneration(), ticket = s.actionTicket = (s.actionTicket || 0) + 1, pop = s.pop;
  const failed = error => {
    if (!visibleOwner(s) || !owner() || gen !== workspaceGeneration() || ticket !== s.actionTicket || s.pop !== pop) return;
    const message = `Workspace unavailable: ${String(error?.message || 'navigation failed').slice(0, 300)}`;
    const status = pop?.querySelector('.pstatus');
    if (status) setText(status, message); else { try { s.ctx.notify?.(message); } catch { /* optional host feedback */ } }
  };
  try { Promise.resolve(s.ctx.openView('spawn')).catch(failed); } catch (error) { failed(error); }
}

function selectedInstance(s, id) {
  if (!dataCurrent(s)) return null;
  const matches = (s.panel.instances || []).filter(i => instanceId(i) === id);
  return matches.length === 1 ? matches[0] : null;
}
/** What Go to instance may do, from the shared table (packages/client/instance-acts.mjs), as the roster menu
 * decides it: `start` when `instanceActs` lists it enabled (a stopped row: Start…), `open` (the terminal) when
 * `openAct` is enabled, that is when the row runs. A held home (#802), a blocked row and a Herdr-recorded one get none,
 * and a row on a session provider never gets `open`: it has no terminal (its title says where it runs). */
function rowActs(i) {
  const { acts } = instanceActs(i);
  return { start: acts.some(act => act.verb === 'start' && act.enabled), open: openAct(i)?.enabled === true };
}

function invokeInstance(s, id, action) {
  const i = selectedInstance(s, id);
  // #802: a held home (spawning, being retired, or left half cleaned) starts and opens nothing.
  if (!rowActionsCurrent(s, i) || !visibleOwner(s) || !canAddressInstance(i) || heldHome(i)) return;
  // The keyboard and double-click paths act exactly when the popover's buttons would (updatePop).
  const acts = rowActs(i);
  const call = action === 'terminal' && acts.open && s.ctx.openTerminal ? () => s.ctx.openTerminal({
    instance: i.instance, home: i.home || undefined, agentsRoot: i.agentsRoot || undefined, ...(i.server ? { server: i.server } : {}),
  }) : action === 'start' && acts.start && s.ctx.startInstance ? () => s.ctx.startInstance(i) : null;
  if (!call) return;
  const ticket = s.actionTicket = (s.actionTicket || 0) + 1, gen = workspaceGeneration(), epoch = s.renderEpoch, pop = s.pop;
  const failed = error => {
    if (!actionsCurrent(s) || !visibleOwner(s) || gen !== workspaceGeneration() || ticket !== s.actionTicket || epoch !== s.renderEpoch || s.pop !== pop || s.popFor !== id) return;
    const status = pop?.querySelector('.pstatus'); if (status) status.textContent = `Action unavailable: ${String(error?.message || 'request failed').slice(0, 300)}`;
  };
  try { Promise.resolve(call()).catch(failed); } catch (error) { failed(error); }
}
/* Terminal and Start handoffs use the exact current home/root/server, never a
 * captured instance object or a bare name. Unknown state does not mean stopped. */
function openTerm(s, id) {
  const i = selectedInstance(s, id);
  if (i) invokeInstance(s, id, i.running === false ? 'start' : 'terminal');
}

/* ── Go to soul ──
 * The Workspace page's page of this instance's EXACT soul, never one found by a bare agent name. The Workspace page
 * reads the souls of one deployment (`/api/agents?ws=<view>`: the view's primary, desktop-deployment-model.md "The
 * primary deployment"), so only a row of that deployment can go there; any other row's button says so. The catalog
 * read is that deployment's own (`/api/agents?ws=<rowDeployment(row)>`), once per popover per roster observation.
 * Exact means:
 *   a local row   its recorded soul key (`soulKey`, the roster's agent `key`) and soul source (`soul.repoKey`) name
 *                 exactly one catalog row of its agents root, and the key is not ambiguous in the catalog;
 *   a remote row  its agent dir names exactly one of the host's agent dirs of its root (unique per root).
 * The soul page itself is read by bare name and root, so an exact soul that shares its name with another soul of
 * its root cannot be shown, and says so. Anything else is disabled with why. */

/** Whether the Workspace page can show the souls of row `i`'s deployment: null when it can, else why not. */
function soulScopeReason(s, i) {
  const list = s.panel.deployments || [], id = rowDeployment(i);
  // An untagged row, or a view of one deployment: the view is the deployment the Workspace page reads.
  if (!i.deployment?.id || list.length < 2) return null;
  const primary = list.find(d => d.primary);
  if (primary?.id === id) return null;
  const label = d => d ? deploymentLabel(d, DESKTOP_TERMS) : 'another deployment';
  return `This instance is on ${label(list.find(d => d.id === id))}; the Workspace page shows only the souls of ${primary ? label(primary) : "this view's primary deployment"}.`;
}

/** Go to soul's target for row `i`: `{ ref, label }` (what preselectSoul is handed, and the soul's name in the
 * title), or `{ reason }`. Starts the catalog read when this popover has none for the current observation. */
function soulTarget(s, i) {
  if (!s.ctx.openView) return { reason: 'The Workspace page is not available here.' };
  if (!rowActionsCurrent(s, i)) return { reason: 'Requires a current roster.' };
  const scope = soulScopeReason(s, i);
  if (scope) return { reason: scope };
  const remote = !!i.server, key = remote ? i.agent : i.soulKey, repoKey = i.soul?.repoKey;
  if (!key || !i.agentsRoot || (!remote && !repoKey)) return { reason: 'This instance does not record the soul it was spawned from.' };
  const read = soulCatalog(s, rowDeployment(i)), answer = read.state === 'pending' ? read.prev : read;
  if (!answer) return { reason: "Checking this instance's soul…" };
  if (answer.state === 'failed') return { reason: catalogFailureTitle(answer.error) };
  const several = { reason: `Several souls match ${key}; open it from the Workspace page.` };
  if (!remote && answer.ambiguous.includes(key)) return several;
  const matches = answer.agents.filter(a => a.agentsRoot === i.agentsRoot && (remote
    ? a.name === key && a.server === i.server
    : a.key === key && sameRepo(a.soulSource?.repoKey, repoKey)));
  if (!matches.length) return { reason: `${key} is not among this deployment's souls now.` };
  if (matches.length > 1) return several;
  const a = matches[0];
  // The Workspace page's soul page inspects a soul by its bare name and root (inspect-boundary.mjs refuses a name
  // two souls of one root share): the exact soul is found, but its page could not load. Said, never opened.
  if (answer.agents.filter(x => x.name === a.name && x.agentsRoot === a.agentsRoot && (x.server || '') === (a.server || '')).length > 1) {
    return { reason: `Another soul in this deployment is also named ${a.name}, so the Workspace page cannot open ${key}.` };
  }
  return { label: key, ref: remote ? { name: a.name, agentsRoot: a.agentsRoot, server: a.server }
    : { name: a.name, key, repoKey, agentsRoot: a.agentsRoot } };
}

/** A failed catalog read's title. `error` is `{ lead, line }` (speaker-line.mjs speakerParts): the kernel's own
 * words after "OATS says:", a transport failure's as the cause, nothing when there is nothing to show. */
function catalogFailureTitle({ lead, line }) {
  if (lead && line) return `Could not read this deployment's souls. ${lead} ${line}`;
  return line ? `Could not read this deployment's souls: ${line.replace(/\.$/, '')}.` : "Could not read this deployment's souls.";
}

/** The open popover's read of `deployment`'s soul catalog for the current roster observation: `{ state: 'pending' |
 * 'ok' | 'failed', agents, ambiguous, error, prev }`. A new observation reads again; until it answers, the last
 * answer for this popover and deployment (`prev`) stands, so a focused Go to soul is not disabled by every poll.
 * An answer is kept only while it is still this popover's read (closePop and every reselection drop it).
 * The reply is read as the Workspace page reads it (spawn.mjs settleGridState): a `catalog.reason` is a failed
 * read, its souls the last good list and never proof; a deployment whose catalog is not observed yet (no
 * `catalog`, or `refreshing` with no souls) is still being read, so the read stays pending. */
function soulCatalog(s, deployment) {
  const held = s.soulRead, gen = workspaceGeneration(), pop = s.pop, id = s.popFor;
  if (held && held.pop === pop && held.id === id && held.deployment === deployment && held.gen === gen && held.observed === s.observed) return held;
  const same = held && held.pop === pop && held.id === id && held.deployment === deployment && held.gen === gen;
  const entry = s.soulRead = { pop, id, deployment, gen, observed: s.observed, state: 'pending',
    prev: same ? (held.state === 'pending' ? held.prev : held) : null };
  const owns = () => s.alive && s.soulRead === entry && s.pop === pop && s.popFor === id && gen === workspaceGeneration() && dataCurrent(s);
  // A settled read needs no earlier answer: only the latest one is ever shown.
  const settle = answer => { if (!owns()) return; Object.assign(entry, answer, { prev: null }); updatePop(s); };
  // No deployment selected at all (a bare harness): the server's first, as wsQuery() reads it.
  apiJson(s.ctx, `/api/agents${deployment ? `?ws=${encodeURIComponent(deployment)}` : ''}`).then(data => {
    if (!Array.isArray(data?.agents)) throw Error('The souls list could not be read');
    const reason = data.catalog?.reason;
    if (reason) { settle({ state: 'failed', error: speakerParts('kernel', reason.message) }); return; }
    const remote = typeof data.workspace?.server === 'string';
    if (!data.agents.length && (data.refreshing === true || (!remote && !data.catalog))) return; // not read yet: still checking
    const ambiguous = Array.isArray(data.catalog?.ambiguous) ? data.catalog.ambiguous.filter(k => typeof k === 'string') : [];
    settle({ state: 'ok', agents: data.agents.filter(a => a && typeof a === 'object'), ambiguous });
  }).catch(error => settle({ state: 'failed', error: { lead: null, line: displayLine(String(error?.message || '')) } }));
  return entry;
}

/** Go to soul pressed: hand the exact soul to the Workspace page and show it. A miss on arrival (the catalog changed
 * in between) and a failed navigation are said in this popover's status line while it is on screen, else as a
 * notification, as openWorkspace does. */
function openSoul(s, id) {
  const pop = s.pop, i = selectedInstance(s, id), target = i ? soulTarget(s, i) : null;
  if (!target?.ref || !visibleOwner(s, pop) || s.popFor !== id) return;
  const gen = workspaceGeneration(), ticket = s.actionTicket = (s.actionTicket || 0) + 1, ctx = s.ctx;
  const owned = () => s.alive && ticket === s.actionTicket && s.pop === pop && s.popFor === id && visibleOwner(s, pop);
  const say = message => {
    if (gen !== workspaceGeneration()) return;
    if (owned()) setText(pop.querySelector('.pstatus'), message);
    else { try { ctx.notify?.(message); } catch { /* optional host feedback */ } }
  };
  const failed = error => say(`Workspace unavailable: ${String(error?.message || 'navigation failed').slice(0, 300)}`);
  import('./spawn.mjs').then(mod => {
    if (!owned() || !dataCurrent(s) || gen !== workspaceGeneration()) return;
    // The roster may have moved while the module loaded: hand over only the soul the row still resolves to, now.
    const now = selectedInstance(s, id), still = now ? soulTarget(s, now) : null;
    if (!still?.ref || JSON.stringify(still.ref) !== JSON.stringify(target.ref)) return;
    mod.preselectSoul({ ...target.ref, onMiss: (count, { sharedName } = {}) => say(sharedName
      ? `Another soul in this deployment is also named ${sharedName}, so the Workspace page cannot open ${target.label}.`
      : count ? `Several souls match ${target.label}; open it from the Workspace page.` : `${target.label} is not among this deployment's souls now.`) });
    return ctx.openView('spawn');
  }).catch(failed);
}

/* Edge between a parent and child node, from their FINAL (fx/fy) positions:
   a smooth cubic S-curve from the parent's bottom-centre to the child's
   top-centre (OAS's connector), both control points on the vertical midpoint. */
function drawEdge(p, parent, child) {
  const x1 = parent.fx + NODE_W / 2, y1 = parent.fy + NODE_H;
  const x2 = child.fx + NODE_W / 2, y2 = child.fy;
  const my = (y1 + y2) / 2;
  p.setAttribute('d', `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`);
}

/* Sibling peer edge: a shallow dashed arc between the two boxes' facing
   vertical midpoints — distinguishable from parent edges by STYLE (dash + flat
   arc), not color alone. */
function drawSiblingEdge(p, a, b) {
  const [l, r] = a.fx <= b.fx ? [a, b] : [b, a];
  const x1 = l.fx + NODE_W, y1 = l.fy + NODE_H / 2;
  const x2 = r.fx, y2 = r.fy + NODE_H / 2;
  const mx = (x1 + x2) / 2;
  p.setAttribute('d', `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`);
}

/* Redraw one edge path from its endpoints' final positions. */
function redrawEdge(s, p) {
  const a = s.nodeEls.get(p.dataset.parent)?.node;
  const b = s.nodeEls.get(p.dataset.child)?.node;
  if (!a || !b) return;
  if (p.classList.contains("sib")) drawSiblingEdge(p, a, b);
  else drawEdge(p, a, b);
}

function onNodeDragMove(s, e) {
  const dr = s.drag;
  const dx = (e.clientX - dr.startX) / s.z, dy = (e.clientY - dr.startY) / s.z;
  if (!dr.moved && Math.hypot(e.clientX - dr.startX, e.clientY - dr.startY) < DRAG_THRESHOLD) return;
  if (!dr.moved) { dr.moved = true; dr.node.classList.add("dragging"); closePop(s); }
  const nx = dr.off.x + dx, ny = dr.off.y + dy;
  s.nodeOffsets.set(dr.name, { x: nx, y: ny });
  dr.n.fx = dr.n.x + nx; dr.n.fy = dr.n.y + ny;
  dr.node.style.left = `${dr.n.fx}px`;
  dr.node.style.top = `${dr.n.fy}px`;
  // redraw only the edges touching this box
  for (const p of s.edgesByNode?.get(dr.name) || []) redrawEdge(s, p);
}

function onNodeDragEnd(s) {
  const dr = s.drag;
  s.drag = null;
  dr.node.classList.remove("dragging");
  if (dr.moved) {
    // Suppress only this gesture's native click. If mouseup happened elsewhere,
    // do not swallow a future intentional click on the same node.
    const suppression = s.dragConsumedClick = { node: dr.node };
    s.win.clearTimeout(s.clickResetTimer);
    s.clickResetTimer = s.win.setTimeout(() => {
      if (s.alive && s.dragConsumedClick === suppression) s.dragConsumedClick = null;
    }, 0);
  }
  applyPending(s);
}

function applyTransform(s) {
  const stage = s.canvas.querySelector(".hier-stage");
  if (stage) stage.style.transform = `translate(${s.tx}px, ${s.ty}px) scale(${s.z})`;
  positionPop(s);
}

const Z_MIN = 0.25, Z_MAX = 2;
function zoomBy(s, factor, cx, cy) {
  if (!visibleOwner(s)) return;
  s.fitted = true;
  const rect = s.canvas.getBoundingClientRect();
  const px = cx != null ? cx - rect.left : rect.width / 2;   // zoom about cursor (or center)
  const py = cy != null ? cy - rect.top : rect.height / 2;
  const nz = Math.min(Z_MAX, Math.max(Z_MIN, s.z * factor));
  const k = nz / s.z;
  s.tx = px - (px - s.tx) * k;
  s.ty = py - (py - s.ty) * k;
  s.z = nz;
  applyTransform(s);
}

/* Fit the whole forest (incl. dragged offsets) inside the visible canvas. */
function fit(s) {
  if (!s.alive) return;
  if (typeof s.canvas.getBoundingClientRect !== "function") return; // non-DOM host (tests)
  const rect = s.canvas.getBoundingClientRect();
  if (!rect.width || !rect.height || !s.bounds || !s.bounds.w) { s.tx = PAD; s.ty = PAD; s.z = 1; applyTransform(s); return; }
  s.fitted = true;
  // actual extent: every node's FINAL (layout + drag) position
  let minX = 0, minY = 0, maxX = s.bounds.w, maxY = s.bounds.h + NODE_H;
  for (const { el, node } of s.nodeEls.values()) {
    const gx = Number(el.parentElement?.style.left?.replace("px", "") || 0);
    const gy = Number(el.parentElement?.style.top?.replace("px", "") || 0);
    const fx = gx + (node.fx ?? node.x), fy = gy + (node.fy ?? node.y);
    minX = Math.min(minX, fx); minY = Math.min(minY, fy);
    maxX = Math.max(maxX, fx + NODE_W); maxY = Math.max(maxY, fy + NODE_H);
  }
  const w = maxX - minX, h = maxY - minY;
  const z = Math.min(Z_MAX, Math.max(Z_MIN, Math.min((rect.width - PAD * 2) / w, (rect.height - PAD * 2) / h, 1)));
  s.z = z;
  // Anchor at the canvas's top-left inset (Redesign v3), never centred.
  s.tx = PAD - minX * z;
  s.ty = PAD - minY * z;
  applyTransform(s);
}

/* lineage highlight: ancestors + descendants of the hovered node (by id;
   parent names resolve through the shared resolver) */
function litLineage(s, id, on) {
  const list = s.panel.instances || [];
  const byId = new Map(list.map((i) => [instanceId(i), i]));
  const byName = new Map();
  for (const i of list) {
    if (!byName.has(i.instance)) byName.set(i.instance, []);
    byName.get(i.instance).push(i);
  }
  const parentIdOf = (i) => (i.parentInstance ? resolveLinkId(i, i.parentInstance, byName) : null);
  const kin = new Set([id]);
  let cur = byId.get(id);
  while (cur) {
    const pid = parentIdOf(cur);
    if (!pid || kin.has(pid) || !byId.has(pid)) break;
    kin.add(pid); cur = byId.get(pid);
  }
  const grow = (nid) => {
    for (const i of list) {
      const iid = instanceId(i);
      if (parentIdOf(i) === nid && !kin.has(iid)) { kin.add(iid); grow(iid); }
    }
  };
  grow(id);
  for (const [nm, { el }] of s.nodeEls) el.classList.toggle("lit", on && kin.has(nm) && nm !== s.sel);
  for (const paths of (s.edgesByNode || new Map()).values()) {
    for (const p of paths) {
      const lit = on && kin.has(p.dataset.child) && kin.has(p.dataset.parent);
      p.classList.toggle("lit", lit);
    }
  }
}

function select(s, name) {
  if (!dataCurrent(s) || !visibleOwner(s) || s.pending || !s.nodeEls.has(name)) return;
  s.actionTicket = (s.actionTicket || 0) + 1;
  s.sel = name; paintSelection(s); revealNode(s, name); openPop(s, name);
}

/* Keep a keyboard-selected node on screen: pan the camera (never zoom) just
   enough to bring it inside the canvas with a PAD margin. */
function revealNode(s, id) {
  const entry = s.nodeEls.get(id);
  if (!entry || typeof s.canvas.getBoundingClientRect !== "function") return;
  const rect = s.canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const gx = Number(entry.el.parentElement?.style.left?.replace("px", "") || 0);
  const gy = Number(entry.el.parentElement?.style.top?.replace("px", "") || 0);
  const x = (gx + (entry.node.fx ?? entry.node.x)) * s.z + s.tx, y = (gy + (entry.node.fy ?? entry.node.y)) * s.z + s.ty;
  const w = NODE_W * s.z, h = NODE_H * s.z;
  let dx = 0, dy = 0;
  if (x < PAD) dx = PAD - x; else if (x + w > rect.width - PAD) dx = Math.max(PAD - x, rect.width - PAD - (x + w));
  if (y < PAD) dy = PAD - y; else if (y + h > rect.height - PAD) dy = Math.max(PAD - y, rect.height - PAD - (y + h));
  if (!dx && !dy) return;
  s.fitted = true; s.tx += dx; s.ty += dy; applyTransform(s);
}

/* The nearest node in the same group on the next row up (dir -1) or down (1):
   Up/Down's move when a node has no parent/child to go to (the Independent
   grid, a leaf). Closest row first, then the closest horizontal position. */
function rowNeighbour(s, cur, dir) {
  const y0 = cur.node.fy ?? cur.node.y, x0 = cur.node.fx ?? cur.node.x;
  let best = null;
  for (const [id, entry] of s.nodeEls) {
    if (entry.ws !== cur.ws || entry === cur) continue;
    const y = entry.node.fy ?? entry.node.y, x = entry.node.fx ?? entry.node.x;
    if (dir < 0 ? y >= y0 : y <= y0) continue;
    const rank = [Math.abs(y - y0), Math.abs(x - x0)];
    if (!best || rank[0] < best.rank[0] || (rank[0] === best.rank[0] && rank[1] < best.rank[1])) best = { id, rank };
  }
  return best?.id ?? null;
}

function paintSelection(s) {
  for (const [id, { el }] of s.nodeEls) {
    el.classList.toggle('sel', id === s.sel); el.setAttribute('aria-selected', String(id === s.sel));
  }
  const selected = s.sel && s.nodeEls.get(s.sel)?.el;
  if (selected) s.canvas.setAttribute?.('aria-activedescendant', selected.id);
  else s.canvas.removeAttribute?.('aria-activedescendant');
}

function closePop(s) {
  s.activity?.dispose(); s.activity = null;
  s.pop?.remove(); s.pop = null; s.popFor = null; s.soulRead = null;
  s.actionTicket = (s.actionTicket || 0) + 1;
}
const setText = (el, text) => { if (el && el.textContent !== text) el.textContent = text; };

function openPop(s, id, retained = null) {
  const entry = s.nodeEls.get(id), i = selectedInstance(s, id);
  if (!entry || !i) return;
  let pop = retained;
  if (!pop) {
    closePop(s);
    pop = node(s, 'section', undefined, 'hier-pop'); pop.setAttribute('aria-label', 'Selected instance actions');
    pop.append(node(s, 'h2', '', 'pname'), node(s, 'p', '', 'pidentity'), node(s, 'p', '', 'pstate'),
      node(s, 'p', 'Activity: unknown · Waiting on you: unknown', 'pavailability'));
    const chips = node(s, 'div', undefined, 'pchips'); chips.append(node(s, 'span', '', 'chip rt'), node(s, 'span', '', 'chip pbranch')); pop.append(chips);
    // Exactly two acts, in this order: the instance (its terminal tab, or Start… when stopped) and its soul.
    // Restart with… lives in the roster row's menu and the instance panel's footer, Git on the panel's
    // Developer page, the soul's own facts on the panel's Soul tab; the Workspace page is the rail's and S here.
    const actions = node(s, 'div', undefined, 'pacts');
    const button = (label, cls) => { const el = node(s, 'button', label, `act ${cls}`); el.type = 'button'; actions.append(el); return el; };
    const terminal = button('Go to instance', 'pterm'), soul = button('Go to soul', 'psoul');
    const owns = () => dataCurrent(s) && visibleOwner(s, pop) && s.pop === pop && s.popFor === id;
    terminal.addEventListener('click', () => { if (owns()) openTerm(s, id); });
    soul.addEventListener('click', () => { if (owns()) openSoul(s, id); });
    const status = node(s, 'p', '', 'pstatus'); status.setAttribute('role', 'status');
    pop.append(actions, status);
  }
  s.pop = pop; s.popFor = id;
  // Keep action text screen-sized: camera zoom transforms nodes, not the popup.
  if (pop.parentNode !== s.canvas) s.canvas.append(pop);
  if (!retained) s.activity = createInstanceEventsView(pop, { ctx: s.ctx,
    summary: pop.querySelector('.pavailability'), selection: () => activitySelection(s, id),
    layout: () => { if (s.pop === pop && visibleOwner(s, pop)) positionPop(s); },
    owner: () => dataCurrent(s) && !s.stale && visibleOwner(s, pop) && s.pop === pop && s.popFor === id });
  updatePop(s);
}

function activitySelection(s, id) {
  const i = selectedInstance(s, id);
  if (!i) return null;
  // Addressed to the row's own deployment (#482): the events read and its echo name that deployment.
  const selection = row => ({ workspace: rowDeployment(row), selector: { instance: row.instance, agent: row.agent,
    agentsRoot: row.agentsRoot, server: row.server || null }, home: row.home, incarnation: row.createdAt ?? null, serverLabel: serverLabel(row) });
  const selected = selection(i);
  if (s.pending) {
    const next = s.pending.panel.instances.filter(row => instanceId(row) === id);
    if (keptFailure(s.pending.panel) || next.length !== 1 || JSON.stringify(selection(next[0])) !== JSON.stringify(selected)) return null;
  }
  return selected;
}

function updatePop(s) {
  const pop = s.pop, i = selectedInstance(s, s.popFor);
  if (!pop || !i) return;
  setText(pop.querySelector('.pname'), i.instance);
  const identity = pop.querySelector('.pidentity'); identity.hidden = !activeTargetLabel(i, s.panel.instances);
  setText(identity, `Host: ${i.server || (i.remote ? 'not reported' : 'local')} · Root: ${i.agentsRoot || 'not reported'} · Home: ${i.home || 'not reported'}`);
  const held = heldHome(i);
  setText(pop.querySelector('.pstate'), `Reported state: ${heldStatus(held) ?? runtimeState(i)}${s.stale || rowStale(i, s.panel.deployments) ? ' (last observation)' : ''}`);
  setText(pop.querySelector('.rt'), i.harness || 'Harness not reported');
  setText(pop.querySelector('.pbranch'), i.branch ? `Reported branch: ${i.branch}` : 'Branch not reported');
  // Which acts are enabled is the shared table's (rowActs); a current roster, a well-formed address and the shell's
  // own handler are this view's conditions on top. Go to instance is the Start act on a stopped row (a stopped
  // instance has no terminal: the press is an informed Start…), open otherwise (running or unknown).
  const allowed = rowActionsCurrent(s, i) && canAddressInstance(i), acts = rowActs(i);
  const terminal = pop.querySelector('.pterm');
  setText(terminal, i.running === false ? 'Start…' : 'Go to instance');
  terminal.disabled = !allowed || (i.running === false ? !acts.start || !s.ctx.startInstance : !acts.open || !s.ctx.openTerminal);
  // A Herdr row's reason is said with who made it (speaker-line.mjs).
  terminal.title = unsupportedLine(i) || heldLine(held) || (i.running !== false && noTerminal(i)?.sentence) || (terminal.disabled ? 'Requires a current, addressed instance with known runtime state and an available route.' : i.running === false ? 'Stopped: no terminal to go to. Opens the Start dialog.' : 'Open this exact instance terminal');
  // Go to soul: enabled only for the exact soul (soulTarget); disabled, its title says why.
  const soul = pop.querySelector('.psoul'), target = soulTarget(s, i);
  soul.disabled = !target.ref;
  soul.title = target.ref ? `Open ${target.label} on the Workspace page` : target.reason;
  s.activity?.sync();
  positionPop(s);
}

function positionPop(s) {
  const pop = s.pop, entry = s.nodeEls.get(s.popFor);
  if (!pop || !entry) return;
  const rect = s.canvas.getBoundingClientRect?.(), group = entry.el.parentElement;
  const gx = parseFloat(group?.style.left) || 0, gy = parseFloat(group?.style.top) || 0;
  const nx = s.tx + (gx + (entry.node.fx ?? entry.node.x)) * s.z;
  let x = nx + NODE_W * s.z + 10, y = s.ty + (gy + (entry.node.fy ?? entry.node.y)) * s.z;
  if (rect?.width && rect.height) {
    const width = Math.min(224, Math.max(40, rect.width - 16));
    pop.style.maxHeight = `${Math.max(40, rect.height - 16)}px`; pop.style.overflow = 'auto';
    if (x + width > rect.width - 8) x = nx - width - 10;
    x = Math.max(8, Math.min(x, rect.width - width - 8));
    y = Math.max(8, Math.min(y, rect.height - 8 - (pop.offsetHeight || Math.min(280, rect.height - 16))));
  }
  pop.style.left = `${x}px`; pop.style.top = `${y}px`;
}

/* keyboard tree-walk over the laid-out nodes. Escape/Enter/arrows are the
   tree's structural keys (not rebindable); everything else resolves through
   the engine keymap so shortcut-editor rebinds take effect here. */
function onKey(s, e) {
  if (!dataCurrent(s) || !visibleOwner(s) || s.pending || e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
  const list = s.shown || []; // the selected tab's rows: the keys walk what is drawn
  if (!list.length) return;
  if (e.key === 'Escape') { e.preventDefault(); s.sel = null; paintSelection(s); closePop(s); s.canvas.focus?.({ preventScroll: true }); return; }
  // Native popup buttons own Enter/Space; tree commands must not also open a
  // terminal when the focused button's intent is Start… or Go to soul.
  if (e.target.closest?.('.hier-pop,button,input,select,textarea,summary,[contenteditable=true]')) return;
  if (e.repeat && !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  // [ / ] hop between clusters (selects the hopped-to cluster's first node)
  // — structural like the arrows; fit moved to the rebindable hier.fit action
  if (e.key === "[" || e.key === "]") {
    e.preventDefault();
    const groups = [];
    for (const { node, ws } of s.nodeEls.values()) {
      let g = groups.find((x) => x.ws === ws);
      if (!g) { g = { ws, first: node }; groups.push(g); }
      else if (node.y < g.first.y || (node.y === g.first.y && node.x < g.first.x)) g.first = node;
    }
    if (!groups.length) return;
    const curWs = s.sel ? s.nodeEls.get(s.sel)?.ws : null;
    const at = groups.findIndex((g) => g.ws === curWs);
    const next = groups[(at + (e.key === "]" ? 1 : -1) + groups.length) % groups.length]
      || groups[0];
    select(s, next.first.id);
    return;
  }
  // Enter opens with FULL identity (openTerm), never the bare selection id
  if (e.key === "Enter" && s.sel) { e.preventDefault(); openTerm(s, s.sel); return; }
  const hit = resolveViewKey(e, s.viewActions);
  if (hit) {
    e.preventDefault();
    s.viewActions.find((a) => a.id === hit)?.run();
    return;
  }
  // An arrow chord the keymap binds (the shared Alt+Shift+↑/↓, ⌘⌥↑/↓: the previous / next
  // instance's terminal; a rebind) is the keymap's from the canvas as from anywhere.
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) || keymapTakes(e)) return;
  e.preventDefault();
  if (!s.sel) { select(s, instanceId(list[0])); return; }
  const cur = s.nodeEls.get(s.sel);
  if (!cur) return;
  const byId = new Map(list.map((i) => [instanceId(i), i]));
  const byName = new Map();
  for (const i of list) {
    if (!byName.has(i.instance)) byName.set(i.instance, []);
    byName.get(i.instance).push(i);
  }
  if (e.key === "ArrowUp") {
    const me = byId.get(s.sel);
    const pid = me?.parentInstance ? resolveLinkId(me, me.parentInstance, byName) : null;
    const up = pid && s.nodeEls.has(pid) ? pid : rowNeighbour(s, cur, -1);
    if (up) select(s, up);
  } else if (e.key === "ArrowDown") {
    const kid = cur.node.children[0]?.id ?? rowNeighbour(s, cur, 1);
    if (kid) select(s, kid);
  } else {
    // peers: same row (y) within the SAME cluster group, ordered by x
    const sibs = [...s.nodeEls.values()].filter((x) => x.node.y === cur.node.y && x.ws === cur.ws).sort((a, b) => a.node.x - b.node.x);
    const at = sibs.findIndex((x) => x.node.id === s.sel);
    const next = sibs[at + (e.key === "ArrowRight" ? 1 : -1)];
    if (next) select(s, next.node.id);
  }
}
