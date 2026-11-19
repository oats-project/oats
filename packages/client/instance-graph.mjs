/** The Graph (the Desktop UI rework, slice 6b; guide tour step 28): who started whom, and where it runs. One column
 * per machine of the view, its agents as an outline tree under "started by" edges, so the Desktop draws it now and
 * the Terminal UI can draw the same graph later. Pure: no DOM, no IO, deterministic.
 *
 *   instanceGraph(rows, deployments, terms, { mode, here }) -> { mode, columns, edges, labels }
 *
 * - `rows`: the roster's rows (the sidebar's, `/api/panel` instances); `deployments`: the view's (#482:
 *   `{ id, machine, path, local, … }`), each row tagged `deployment: { id }`. A row with no known deployment joins
 *   the primary's (roster-sections.mjs `splitByDeployment`).
 * - `mode`: 'columns' (one column per deployment: this computer's first, then the others by label) or 'field' (one
 *   column of every agent, each agent's machine said on its node).
 * - A column is `{ key, label, deployment, local, rows }`; `label` is the machine (deployment-label.mjs
 *   `machineLabelParts`: the folder's tail too only when one machine holds two), this computer's own name (`here`)
 *   where it is known. `rows`, top to bottom, are the outline: `{ kind: 'you', key, depth: 0 }`, or `{ kind:
 *   'agent', id, row, depth, machine, parent, recordedParent, byYou, sameWork, crossMachine }`.
 * - Edges are "started by", parent → child: `{ from, to, kind, sameWork }`, `kind` 'started' (solid), 'you' (from a
 *   column's "You" root) or 'cross' (the parent is in another column: drawn dotted between them). A field keeps
 *   a cross-machine edge's kind, so it is drawn the same way in both modes.
 * - `labels`: Map<column key, machine label> of the view's columns, in both modes (a field names each agent's).
 *
 * The facts, read as the kernel reports them, and nothing guessed beyond the one display rule below:
 * - A parent is the row's `parentInstance`, resolved among its own column's rows (instance-tree.mjs `resolveLinkId`:
 *   the same host, then the same agents root). The kernel never resolves a parent across hosts, so a parent on
 *   another machine is a display rule: a name no row of its own column has, which exactly one row of another
 *   column has, is drawn to that row as a cross-machine edge. Anything else (no such row, or two) is no edge: the row
 *   is a root, and `recordedParent` keeps the name it records so its node can still say who started it.
 * - "You" (`byYou`): a row with an attributed human (attributed-human.mjs) and no recorded parent. Each column with
 *   such rows has one "You" root above them. The guide's schedule ("clock") root needs a fact no row carries
 *   (gap map, contradiction 13): there is none.
 * - Same work (`sameWork`): the kernel's flag on a child that does its parent's work (same-work.mjs), read only
 *   where its host declares the feature (`sameWorkKnown`), and only on a drawn edge. There is no same-work label
 *   (gap map, contradiction 3): a node says "same work" in words.
 * - Order: the roster's (instance-tree.mjs `rosterOrder`, newest spawn first) at every level; the "You" root first.
 *   A malformed `parentInstance` cycle is cut at its first row in that order, so every row is drawn once. */
import { instanceId, resolveLinkId, rosterOrder } from './instance-tree.mjs';
import { splitByDeployment, primaryDeployment } from './roster-sections.mjs';
import { machineLabelParts } from './deployment-label.mjs';
import { attributedHumanData } from './attributed-human.mjs';
import { displayLine, DETAIL_WITHHELD } from './display-text.mjs';
import { requireTerms } from './client-terms.mjs';

export const GRAPH_MODES = Object.freeze(['columns', 'field']);
/** The one field's column key. */
export const FIELD_KEY = 'field';

const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const rowsOf = (rows) => (Array.isArray(rows) ? rows.filter((r) => record(r) && typeof r.instance === 'string' && r.instance) : []);
const shown = (value) => {
  const line = typeof value === 'string' ? displayLine(value) : null;
  return line && line !== DETAIL_WITHHELD ? line : null;
};
const recorded = (row) => (typeof row.parentInstance === 'string' && row.parentInstance ? row.parentInstance : null);

function nameIndex(rows) {
  const byName = new Map();
  for (const row of rows) byName.set(row.instance, [...(byName.get(row.instance) || []), row]);
  return byName;
}

/** The view's columns before layout: `[{ key, label, deployment, local, rows }]`, this computer's first, then by label. */
function columnsOf(rows, deployments, terms, here) {
  const list = Array.isArray(deployments) ? deployments.filter((d) => record(d) && typeof d.id === 'string' && d.id) : [];
  const hereName = shown(here) ?? terms.thisMachine;
  if (!list.length) return [{ key: 'here', label: hereName, deployment: null, local: true, rows }];
  const labels = machineLabelParts(list, terms), parts = splitByDeployment(list)(rows);
  const columns = list.map((d) => {
    const local = d.local === true, { machine = terms.thisMachine, tail = '' } = labels.get(d.id) || {};
    // This computer's own deployment carries its name where the caller knows it; a second folder of one machine its tail.
    const label = [local ? hereName : machine, tail].filter(Boolean).join(' · ');
    return { key: d.id, label, deployment: d, local, rows: parts.get(d.id) || [] };
  });
  const primary = primaryDeployment(list)?.id;
  return columns.sort((a, b) => Number(b.local) - Number(a.local) || a.label.localeCompare(b.label)
    || Number(b.key === primary) - Number(a.key === primary) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Each row's parent: Map<id, { id, cross }>, resolved within its column first, then (a display rule) by a name
 * exactly one row of another column has. */
function parents(columns) {
  const columnOf = new Map(), all = [];
  for (const c of columns) for (const row of c.rows) { columnOf.set(instanceId(row), c.key); all.push(row); }
  const everywhere = nameIndex(all), out = new Map();
  for (const c of columns) {
    const own = nameIndex(c.rows);
    for (const row of c.rows) {
      const name = recorded(row), id = instanceId(row);
      if (!name || name === row.instance) continue;
      const local = resolveLinkId(row, name, own);
      if (local && local !== id) { out.set(id, { id: local, cross: false }); continue; }
      if (own.has(name)) continue; // the name is here, but not one row: no edge, never a guess elsewhere
      const elsewhere = (everywhere.get(name) || []).filter((r) => columnOf.get(instanceId(r)) !== c.key);
      if (elsewhere.length === 1) out.set(id, { id: instanceId(elsewhere[0]), cross: true });
    }
  }
  return { parentOf: out, columnOf };
}

/** The outline of one column's rows: `rows` (its 'you' root and its agents, top to bottom) and its edges. A row
 * whose parent is drawn in this column hangs under it; any other is a root. */
function outline(key, rows, parentOf, columnOf, labels, mode) {
  const ids = new Set(rows.map(instanceId)), children = new Map(), roots = [];
  const sorted = [...rows].sort(rosterOrder);
  for (const row of sorted) {
    const p = parentOf.get(instanceId(row));
    if (p && ids.has(p.id)) children.set(p.id, [...(children.get(p.id) || []), row]);
    else roots.push(row);
  }
  const same = (row) => row.sameWorkKnown === true && row.sameWork === true;
  const out = [], edges = [], placed = new Set();
  const walk = (row, depth) => {
    const id = instanceId(row), p = parentOf.get(id);
    placed.add(id);
    out.push({ kind: 'agent', id, row, depth, column: key, machine: labels.get(columnOf.get(id)) ?? null,
      parent: p ? { id: p.id, column: columnOf.get(p.id) ?? null, cross: p.cross } : null, recordedParent: recorded(row),
      byYou: !recorded(row) && !!attributedHumanData(row.attributedHuman), sameWork: !!p && same(row), crossMachine: !!p?.cross });
    for (const child of children.get(id) || []) {
      const cid = instanceId(child);
      if (placed.has(cid)) continue; // the way back into a cycle: not drawn
      edges.push({ from: id, to: cid, kind: parentOf.get(cid)?.cross ? 'cross' : 'started', sameWork: same(child) });
      walk(child, depth + 1);
    }
  };
  const yours = roots.filter((r) => !recorded(r) && attributedHumanData(r.attributedHuman));
  if (yours.length) {
    const you = `you:${key}`;
    out.push({ kind: 'you', key: you, depth: 0, column: key });
    for (const row of yours) { edges.push({ from: you, to: instanceId(row), kind: 'you', sameWork: false }); walk(row, 1); }
  }
  for (const row of roots) {
    if (yours.includes(row)) continue;
    walk(row, 0);
    // A parent in another column: the edge runs between the two columns.
    const p = parentOf.get(instanceId(row));
    if (mode === 'columns' && p?.cross) edges.push({ from: p.id, to: instanceId(row), kind: 'cross', sameWork: same(row) });
  }
  // A parentInstance cycle has no root: it is cut at its first row in the roster's order, drawn as a root.
  for (const row of sorted) {
    if (placed.has(instanceId(row))) continue;
    const at = out.length;
    walk(row, 0);
    Object.assign(out[at], { parent: null, sameWork: false, crossMachine: false });
  }
  return { rows: out, edges };
}

export function instanceGraph(rows, deployments, terms, { mode = 'columns', here = null } = {}) {
  requireTerms(terms, 'instanceGraph');
  const all = rowsOf(rows), kind = GRAPH_MODES.includes(mode) ? mode : 'columns';
  const columns = columnsOf(all, deployments, terms, here);
  const { parentOf, columnOf } = parents(columns);
  const labels = new Map(columns.map((c) => [c.key, c.label]));
  if (kind === 'field') {
    const field = outline(FIELD_KEY, all, parentOf, columnOf, labels, kind);
    return { mode: kind, columns: [{ key: FIELD_KEY, label: null, deployment: null, local: false, rows: field.rows }], edges: field.edges, labels };
  }
  const edges = [];
  const laid = columns.map((c) => {
    const o = outline(c.key, c.rows, parentOf, columnOf, labels, kind);
    edges.push(...o.edges);
    return { key: c.key, label: c.label, deployment: c.deployment, local: c.local, rows: o.rows };
  });
  return { mode: kind, columns: laid, edges, labels };
}

/** The agents of a graph's columns, as the keys walk them: Array<Array<agent row>> (the 'you' roots are not stops). */
export const graphStops = (graph) => graph.columns.map((c) => c.rows.filter((r) => r.kind === 'agent'));
