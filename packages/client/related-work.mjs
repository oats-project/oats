/** Which parent→child lines a roster draws, and so the order under one parent (awebai/oats#1577, the contract
 * on comment 6441606665, item 7). The one rule, shared by the Desktop's sidebar and command palette and by the
 * TUI; neither client keeps a copy.
 *
 * The kernel reports `sameWork: true` on a child row that does the same work as its current parent (feature
 * instance-same-work), and leaves the key out otherwise. It has already bound the flag to the current parent:
 * a client reads `sameWork === true` and nothing more, and never compares parents.
 *
 * The gate: whether a row's host declares the feature. A local row: this computer's CLI advertises it. A remote
 * row: this CLI advertises it and relays the hosts' own lists (server-probe-features), and the row's group's
 * host names it (composed-gate.mjs `hostAdvertises`). Unknown is not supported: an unread or failed probe keeps
 * today's lines. panel-views.mjs `deploymentPanel` stamps the gate's answer on each row it serves as
 * `sameWorkKnown: true` (`withSameWorkGate`), present only when the host declares the feature; it is the
 * client's own field, never the kernel's.
 *
 * Pure: no DOM, no Node builtin, so a page loads it as it is. */
import { hostAdvertises, PROBE_FEATURES_FEATURE } from './composed-gate.mjs';

export const SAME_WORK_FEATURE = 'instance-same-work';

const advertises = (cli, feature) => !!cli?.ok && Array.isArray(cli.features) && cli.features.includes(feature);

/** Whether a host declares the feature: `group` null for this computer's rows, else the remote roster group the
 * rows came from. */
export function sameWorkDeclared(cli, group = null) {
  if (!advertises(cli, SAME_WORK_FEATURE)) return false;
  return group === null || (advertises(cli, PROBE_FEATURES_FEATURE) && hostAdvertises(group, SAME_WORK_FEATURE));
}

/** A row with the gate's answer stamped: `sameWorkKnown: true` when `declared`, else no key. Whatever the row
 * carried under that key is dropped first, so a host can never set it. */
export function withSameWorkGate(row, declared) {
  const { sameWorkKnown: _carried, ...rest } = row;
  return declared ? { ...rest, sameWorkKnown: true } : rest;
}

/** A row the client made itself (a pending spawn's) has no stamp: it takes its parent's, since a child is on its
 * parent's host (instance-tree.mjs `resolveLinkId` never resolves across hosts). `parent` is the row its
 * `parentInstance` resolves to, or null. */
export const withParentGate = (row, parent) => withSameWorkGate(row, parent?.sameWorkKnown === true);

/** Whether a row draws the line to its parent: always when its host does not declare the feature (today's
 * lines), else only when the kernel flagged it. A root has no parent line to draw, whatever this says. */
export const drawsParentLine = (row) => row?.sameWorkKnown !== true || row.sameWork === true;

/** The order of one parent's children, a comparator for a stable sort or a first key before another: the
 * children that draw their parent line first, then those that don't. So a parent's line ends at its last
 * joined child and never passes a child it doesn't join. Within each part the caller's own order stands. */
export const drawingFirst = (a, b) => Number(!drawsParentLine(a)) - Number(!drawsParentLine(b));
