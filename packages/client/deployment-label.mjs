/** How a deployment is named on screen: its machine and a short path (#482). Shared by the server,
 * which labels every deployment of a workspace view, and the renderer, which shows the labels.
 * A deployment that names no machine is on the machine the client runs on, and takes that machine's
 * label from the client's terms (client-terms.mjs `thisMachine`: "This Mac"). */
import { requireTerms } from './client-terms.mjs';

const MAX_PATH = 40;

/** A path for display only: the home directory as `~` (this computer's own home for a local
 * deployment; a remote host's `/Users/<name>` or `/home/<name>` prefix, which is only a display
 * guess, since the host's home is never asked), and its last two segments when it is still long. */
export function shortPath(path, { home = null } = {}) {
  if (typeof path !== 'string' || !path) return '';
  let shown = path;
  if (typeof home === 'string' && home.length > 1 && (path === home || path.startsWith(home.endsWith('/') ? home : `${home}/`))) {
    shown = `~${path.slice(home.replace(/\/$/, '').length)}`;
  } else if (home === null) {
    const m = path.match(/^\/(?:Users|home)\/[^/]+(\/.*)?$/);
    if (m) shown = `~${m[1] || ''}`;
  }
  if (shown.length <= MAX_PATH) return shown;
  const parts = shown.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : shown;
}

/** The two halves of a deployment's label: `{ machine, path }` ("This Mac", "~/acme"; path ''
 * when none). Headings style them apart: a machine label may be uppercased, a path never. */
export function deploymentLabelParts(deployment, terms) {
  requireTerms(terms, 'deploymentLabelParts');
  const machine = typeof deployment?.machine === 'string' && deployment.machine ? deployment.machine : terms.thisMachine;
  const path = typeof deployment?.label === 'string' && deployment.label ? deployment.label : '';
  return { machine, path };
}

/** `This Mac · ~/acme`, `builder · ~/northwind`. */
export function deploymentLabel(deployment, terms) {
  requireTerms(terms, 'deploymentLabel');
  const { machine, path } = deploymentLabelParts(deployment, terms);
  return path ? `${machine} · ${path}` : machine;
}

/** The last segment of a path ("/Users/alex/work/acme" → "acme"), or the last `n`. */
export function pathTail(path, n = 1) {
  if (typeof path !== 'string' || !path) return '';
  return path.split('/').filter(Boolean).slice(-n).join('/');
}

/** Each deployment's short name on screen (UI spec, #482): its machine ("This Mac", "builder"); when one
 * machine holds two or more of the deployments, the machine and its path tail ("This Mac · acme"),
 * the last two segments when the tails collide. Never an id. Returns Map<deployment id, label>. */
export function machineLabels(deployments, terms) {
  requireTerms(terms, 'machineLabels');
  const out = new Map();
  for (const [id, { machine, tail }] of machineLabelParts(deployments, terms)) out.set(id, tail ? `${machine} · ${tail}` : machine);
  return out;
}

/** machineLabels in two halves: Map<deployment id, { machine, tail }> (`tail` '' when the machine is
 * enough). A heading uppercases the machine only; a path tail keeps its case. */
export function machineLabelParts(deployments, terms) {
  requireTerms(terms, 'machineLabelParts');
  const list = Array.isArray(deployments) ? deployments.filter(d => d && typeof d.id === 'string') : [];
  const machineOf = d => (typeof d.machine === 'string' && d.machine) ? d.machine : terms.thisMachine;
  const byMachine = new Map();
  for (const d of list) byMachine.set(machineOf(d), [...(byMachine.get(machineOf(d)) || []), d]);
  const out = new Map();
  for (const [machine, same] of byMachine) {
    if (same.length === 1) { out.set(same[0].id, { machine, tail: '' }); continue; }
    const tails = same.map(d => pathTail(d.path));
    same.forEach((d, i) => {
      const tail = tails.filter(t => t === tails[i]).length > 1 ? pathTail(d.path, 2) : tails[i];
      out.set(d.id, { machine, tail: tail || '' });
    });
  }
  return out;
}
