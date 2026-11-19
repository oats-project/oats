/** A view's deployments and its roster, from the panel's facts alone (#482): which deployment
 * deployment-level surfaces read, a deployment's state in words, which rows are held from a stale
 * deployment, and the roster split into one section per deployment when a view has two or more.
 *
 * A deployment is `{ id, machine, path, label, local, reachable, identityFrom, primary, stale?, reason? }`
 * and a row carries `deployment: { id }`. Nothing is derived from a host name or a path beyond the
 * display label. A view with one deployment has one section and no heading. */
import { rosterGroups, instanceId } from './instance-tree.mjs';
import { waitingClaim } from './waiting-on-you.mjs';
import { machineLabelParts } from './deployment-label.mjs';
import { requireTerms } from './client-terms.mjs';

const text = (v, max = 4096) => typeof v === 'string' && v.length > 0 && v.length <= max;

/** Grouping and "On …" lines apply only to a view of two or more deployments. */
export const isMultiDeployment = deployments => Array.isArray(deployments) && deployments.length >= 2;

/** The deployment deployment-level surfaces read and act on: the one marked primary, else the first. */
export const primaryDeployment = deployments => (Array.isArray(deployments) && (deployments.find(d => d?.primary) || deployments[0])) || null;

/** A deployment's state, in words (never colour alone): `{ key, text, detail }`.
 * live: reached (or, on this computer, observed) now. stale: this computer's deployment whose last
 * re-read failed, or a machine the last roster read did not ask for (#1124): its rows are the last
 * observation. remembered: not reached, its workspace is the last report. not reached / not observed: with why. */
export function deploymentState(d) {
  // Its rows are the last observation: a failed re-read here, or a machine outside a filtered roster read.
  if (d?.stale) return { key: 'stale', text: 'stale', detail: d.reason || '' };
  if (d?.reachable) return { key: 'live', text: 'live', detail: '' };
  if (d?.identityFrom === 'remembered') {
    return { key: 'remembered', text: 'remembered', detail: ['Last report, not live now.', d.reason].filter(Boolean).join(' ') };
  }
  // This computer's own deployment is not "reached": it is observed or not, the reason says why
  // (still reading, or the kernel's refusal).
  if (d?.local) return { key: 'unobserved', text: 'not observed', detail: d.reason || '' };
  return { key: 'unreached', text: 'not reached', detail: d?.reason || '' };
}

/** The deployment a row belongs to, by the id the panel tagged it with (null when untagged). */
const rowDeployment = row => (text(row?.deployment?.id) ? row.deployment.id : null);

/** Whether a row is held from its deployment's last observation (the deployment is stale): its
 * Start and actions wait for a current read, as for a stale roster. */
export const rowStale = (row, deployments) => {
  const id = rowDeployment(row);
  return !!id && Array.isArray(deployments) && deployments.some(d => d?.id === id && d.stale);
};

/** The sidebar roster's sections. One deployment (or none reported): a single section with no
 * heading whose groups are exactly the relation clusters the roster always drew. Two or more: one
 * section per deployment, in the panel's order, each with its own clusters (relations are recorded
 * within one deployment); a row without a known deployment (a pending spawn) joins the primary's.
 * Sections with no visible row are left out. Each is labelled by its machine, with the path tail
 * only when one machine holds two (deployment-label.mjs machineLabels), in the client's terms
 * (client-terms.mjs: the label of a deployment that names no machine). Returns
 * `[{ deployment|null, label|null, groups }]`, a group being `{ key, label, clusters }` as before.
 * `lastFocus` (Map<instanceId, time>, optional; the command palette's, #1383): each section's groups follow
 * last focus (rosterGroups), and the sections are ordered by the latest focus over each one's full roster,
 * most recent first, then the panel's order. Without it, the panel's order (the sidebar's and the TUI's).
 * `roster` (optional; #1579): the full roster `instances` is a part of (the main tree's rows or the Background
 * section's, `sidebarSections`). Names resolve over its rows of the same deployment, and a relation to a row outside
 * `instances` is none: that row's relatives are roots here. Without it, `instances`.
 * `pins` (optional): this computer's CLI lists instance-tree.mjs `PIN_FEATURE`: pinned rows lead each section's
 * order (`clusterInstances`). The section split comes first, so a pin ranks only within its own section. */
export function rosterSections(instances, visible, deployments, terms, { lastFocus, roster = instances, pins = false } = {}) {
  requireTerms(terms, 'rosterSections');
  const recency = lastFocus instanceof Map ? { lastFocus } : {};
  const groupsOf = (all, shown, whole) => rosterGroups(all, shown, { ...recency, roster: whole, pins }); // the relation groups the palette lists too
  if (!isMultiDeployment(deployments)) return [{ deployment: null, label: null, groups: groupsOf(instances, visible, roster) }];
  const sectionOf = splitByDeployment(deployments);
  const all = sectionOf(instances), shown = sectionOf(visible), whole = sectionOf(roster), labels = machineLabelParts(deployments, terms);
  const label = ({ machine, tail }) => (tail ? `${machine} · ${tail}` : machine);
  const sections = deployments.map(d => ({ deployment: d, parts: labels.get(d.id), all: all.get(d.id), shown: shown.get(d.id) }));
  if (recency.lastFocus) {
    const latest = rows => rows.reduce((max, row) => {
      const time = lastFocus.get(instanceId(row));
      return Number.isFinite(time) && (max === null || time > max) ? time : max;
    }, null);
    const keyed = new Map(sections.map(s => [s, latest(s.all)]));
    // Stable: sections without a focus keep the panel's order, after those with one.
    sections.sort((a, b) => {
      const ka = keyed.get(a), kb = keyed.get(b);
      return ka === null ? (kb === null ? 0 : 1) : kb === null ? -1 : kb - ka;
    });
  }
  return sections.filter(s => s.shown.length)
    .map(s => ({ deployment: s.deployment, label: label(s.parts), machine: s.parts.machine, tail: s.parts.tail, groups: groupsOf(s.all, s.shown, whole.get(s.deployment.id)) }));
}

/** The section a row is painted in (#482, #1579), as a key: its deployment's, in the main tree or in the
 * Background section (`placement`: instance-tree.mjs `backgroundPlacement`). A collapse hides, and rolls up,
 * only rows of its own section: give it as `section` to `instanceVisibleInTree` and `waitingRollup`. Two rows
 * are in one section exactly when their keys are equal; the key says nothing else. */
export function rosterSectionKey(deployments, placement = new Set()) {
  const ids = Array.isArray(deployments) ? new Set(deployments.map(d => d?.id)) : new Set();
  const primary = primaryDeployment(deployments)?.id ?? null;
  return row => {
    const id = rowDeployment(row);
    const deployment = isMultiDeployment(deployments) ? (id && ids.has(id) ? id : primary) : null;
    return `${placement.has(instanceId(row)) ? 'background' : 'main'}\u0000${deployment ?? ''}`;
  };
}

/** The sidebar's roster and the TUI's (#1579): the main tree's sections, then the Background section.
 * `instances`: the full roster; `visible`: the rows a filter and a collapse leave (instanceVisibleInTree, given
 * `rosterSectionKey` as its section); `placement`: instance-tree.mjs `backgroundPlacement`.
 * Options: `open`, whether the Background section is drawn open (the client's stored state, or a filter that is
 * on: a filter shows its matches without changing what is stored); `listed`, the rows the filter leaves (all rows
 * when nothing is filtered), which the heading counts; `stale(row)`, the client's held-stale test.
 * Returns `{ main, background }`. `main` is `rosterSections` over the rows outside the section. `background` is
 * null when no listed row is in the section (no heading is drawn), else `{ count, open, waiting, sections }`:
 * `count` the listed rows in it, `waiting` whether any row in it waits (waitingClaim; open or closed, a filtered
 * one included), and `sections` its own tree, `rosterSections` over its rows (with the machine sub-headings in a
 * view of two or more deployments), empty while closed. Each part is a tree of its own: a relation to a row of the
 * other part is none (a background row whose parent is in the main tree is a root of the Background section), and
 * names still resolve over the full roster. The palette never asks this: it lists every row.
 * `pins`: as for `rosterSections`; a pinned row in the Background section leads that section's own tree. */
export function sidebarSections(instances, visible, deployments, terms, { placement = new Set(), open = false, listed = instances, stale = () => false, pins = false } = {}) {
  requireTerms(terms, 'sidebarSections');
  const inside = row => placement.has(instanceId(row));
  const main = rosterSections(instances.filter(r => !inside(r)), visible.filter(r => !inside(r)), deployments, terms, { roster: instances, pins });
  const rows = instances.filter(inside), count = listed.filter(inside).length;
  if (!count) return { main, background: null };
  return { main, background: {
    count, open: !!open,
    waiting: rows.some(row => waitingClaim(row, { stale: stale(row) }) !== null),
    sections: open ? rosterSections(rows, visible.filter(inside), deployments, terms, { roster: instances, pins }) : [],
  } };
}

/** `rows → Map<deployment id, rows>` over the given deployments; an unknown or missing deployment
 * id goes to the primary deployment. */
export function splitByDeployment(deployments) {
  const primary = primaryDeployment(deployments)?.id;
  const ids = new Set(deployments.map(d => d.id));
  return rows => {
    const out = new Map(deployments.map(d => [d.id, []]));
    for (const row of rows || []) {
      const id = rowDeployment(row);
      out.get(id && ids.has(id) ? id : primary)?.push(row);
    }
    return out;
  };
}
