/** Which lines a roster draws: a child's line to its parent, and the dotted link between two top-level siblings
 * (awebai/oats#1577 for the child's line; the related-work lines for both). The one rule, shared by the Desktop's
 * sidebar and command palette and by the TUI; no client keeps a copy. No flag, no line.
 *
 * What a host reports (docs/desktop-cli-api.md):
 * - A host that declares `instance-related-work` puts `relatedWork: true` on a row whose related work is bound to
 *   its current parent (a row with a `parentInstance`), or, for a row with no parent, to its current
 *   `siblingInstance` (the root the sibling was spawned relative to, itself possibly a sibling of another root). It
 *   leaves the key out otherwise, and puts no `sameWork` on any row.
 * - An older host, which declares only `instance-same-work`, puts `sameWork: true` on a child bound to its parent,
 *   and nothing on a sibling. Relayed through a CLI that declares `instance-related-work` (`--server`), such a
 *   host's `sameWork` arrives as `relatedWork` instead; the host's own feature list still lacks the new feature.
 * - A host with neither feature reports no flag.
 * The kernel has already bound the flag to the current parent or sibling: a client reads `=== true` and nothing
 * more, and never compares names.
 *
 * The gate: which of the two features a row's host declares. A local row: this computer's CLI. A remote row: what
 * this CLI relays and what the host itself lists (composed-gate.mjs `hostAdvertises`, through
 * server-probe-features), the lesser of the two: a CLI relays only the flag it knows. Unknown is not supported: an
 * unread or failed probe declares nothing. panel-views.mjs `deploymentPanel` stamps the gate's answer on each row
 * it serves as `relatedWorkKnown` (`withRelatedWorkGate`), the feature's name, present only when the host declares
 * one; it is the client's own field, never the kernel's.
 *
 * Pure: no DOM, no Node builtin, so a page loads it as it is. */
import { hostAdvertises, PROBE_FEATURES_FEATURE } from './composed-gate.mjs';

export const RELATED_WORK_FEATURE = 'instance-related-work';
export const SAME_WORK_FEATURE = 'instance-same-work';

const advertises = (list, feature) => Array.isArray(list) && list.includes(feature);
/** The feature a feature list declares, the newer first, or null. */
const levelOf = (has) => (has(RELATED_WORK_FEATURE) ? RELATED_WORK_FEATURE : has(SAME_WORK_FEATURE) ? SAME_WORK_FEATURE : null);

/** Which related-work feature a row's host declares: `RELATED_WORK_FEATURE`, `SAME_WORK_FEATURE` or null. `group` is
 * null for this computer's rows, else the remote roster group the rows came from. A remote host's answer is the
 * lesser of this CLI's (which flag it relays) and the host's own list; this CLI must also relay the hosts' lists. */
export function relatedWorkDeclared(cli, group = null) {
  if (!cli?.ok || !Array.isArray(cli.features)) return null;
  const local = levelOf((feature) => advertises(cli.features, feature));
  if (group === null || local === null) return local;
  if (!advertises(cli.features, PROBE_FEATURES_FEATURE)) return null;
  const host = levelOf((feature) => hostAdvertises(group, feature));
  return host === null ? null : local === RELATED_WORK_FEATURE ? host : SAME_WORK_FEATURE;
}

/** A row with the gate's answer stamped: `relatedWorkKnown: <feature>` when `declared` names one of the two
 * features, else no key. Whatever the row carried under that key is dropped first, so a host can never set it. */
export function withRelatedWorkGate(row, declared) {
  const { relatedWorkKnown: _carried, ...rest } = row;
  return declared === RELATED_WORK_FEATURE || declared === SAME_WORK_FEATURE ? { ...rest, relatedWorkKnown: declared } : rest;
}

/** A row the client made itself (a pending spawn's) has no stamp: it takes its parent's, since a child is on its
 * parent's host (instance-tree.mjs `resolveLinkId` never resolves across hosts). `parent` is the row its
 * `parentInstance` resolves to, or null. Such a row carries no flag, so it draws no line. */
export const withParentGate = (row, parent) => withRelatedWorkGate(row, parent?.relatedWorkKnown);

const hasParent = (row) => typeof row?.parentInstance === 'string' && row.parentInstance !== '';

/** Whether a child draws the line to its parent: its host reports it related to its parent. On a host that
 * declares `instance-related-work`, `relatedWork === true`; on one that declares only `instance-same-work`,
 * `sameWork === true` (or `relatedWork === true`, as a relaying CLI turns it). Any other host: never. A root has no
 * parent line to draw: a row without a `parentInstance` answers false. */
export function drawsParentLine(row) {
  if (!hasParent(row)) return false;
  if (row.relatedWorkKnown === RELATED_WORK_FEATURE) return row.relatedWork === true;
  if (row.relatedWorkKnown === SAME_WORK_FEATURE) return row.sameWork === true || row.relatedWork === true;
  return false;
}

/** Whether a top-level row joins the sibling its `siblingInstance` names: its host declares
 * `instance-related-work` and reports `relatedWork: true` on a row with no parent. An older host joins no sibling.
 * Which row the link reaches, and whether it is drawn, is the tree's (instance-tree-view.mjs `treeConnectors`). */
export function drawsSiblingLink(row) {
  return !hasParent(row) && row?.relatedWorkKnown === RELATED_WORK_FEATURE && row.relatedWork === true;
}

/** Whether a row reports related work at all, to its parent or to its sibling: the words a screen reader hears. */
export const relatedWork = (row) => drawsParentLine(row) || drawsSiblingLink(row);

/** The order of one parent's children, a comparator for a stable sort or a first key before another: the
 * children that draw their parent line first, then those that don't. So a parent's line ends at its last
 * joined child and never passes a child it doesn't join. Within each part the caller's own order stands. */
export const drawingFirst = (a, b) => Number(!drawsParentLine(a)) - Number(!drawsParentLine(b));
