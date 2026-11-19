/** The Deployments page's tabs (UI spec, #482): `All` first, then one tab per deployment of the view,
 * in the panel's (served) order. A view of one deployment has only that deployment's tab, so the
 * machine is always named. The selected tab is remembered per view in localStorage (ids only, at most
 * DEPLOYMENT_TAB_VIEWS_MAX views, the most recent kept).
 *
 * Other surfaces (the switcher's "Not matched" entries) open a deployment's tab through
 * requestDeploymentTab(): it records the choice and tells the listeners (the shell shows the
 * Deployments stage; the page re-reads its tab). */
import { machineLabels } from '../../client/deployment-label.mjs';
import { DESKTOP_TERMS } from './desktop-terms.mjs';
import { validWorkspaceId as validId } from './workspace-id.mjs';

export const DEPLOYMENT_TAB_KEY = 'oats.desktop.deploymentTab';
export const DEPLOYMENT_TAB_VIEWS_MAX = 32;
export const ALL_TAB = 'all';
const defaultStorage = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };

function readMap(storage) {
  try {
    const value = JSON.parse(storage?.getItem(DEPLOYMENT_TAB_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

/** `[{ id, label, deployment|null }]`: All (only with two or more deployments), then each deployment
 * under its machine label (deployment-label.mjs machineLabels). */
export function deploymentTabs(deployments) {
  const list = Array.isArray(deployments) ? deployments.filter(d => d && validId(d.id)) : [];
  const labels = machineLabels(list, DESKTOP_TERMS);
  return [...(list.length >= 2 ? [{ id: ALL_TAB, label: 'All', deployment: null }] : []),
    ...list.map(d => ({ id: d.id, label: labels.get(d.id), deployment: d }))];
}

/** The tab remembered for a view, or null. */
export function rememberedDeploymentTab(viewId, storage = defaultStorage()) {
  if (!validId(viewId)) return null;
  const value = readMap(storage)[viewId];
  return validId(value) ? value : null;
}

/** Remember a view's tab (a convenience: a storage failure changes nothing on screen). */
export function rememberDeploymentTab(viewId, tab, storage = defaultStorage()) {
  if (!validId(viewId) || !validId(tab) || !storage) return;
  try {
    const map = readMap(storage);
    delete map[viewId]; map[viewId] = tab; // most recent last
    const keys = Object.keys(map);
    for (const key of keys.slice(0, Math.max(0, keys.length - DEPLOYMENT_TAB_VIEWS_MAX))) delete map[key];
    storage.setItem(DEPLOYMENT_TAB_KEY, JSON.stringify(map));
  } catch { /* storage refused: nothing on screen depends on it */ }
}

/** The tab a view shows: the remembered one while the view still has it, else the first (All with two
 * or more deployments, the only deployment with one). Null with no deployments. */
export function selectedDeploymentTab(viewId, deployments, storage = defaultStorage()) {
  const tabs = deploymentTabs(deployments);
  if (!tabs.length) return null;
  const remembered = rememberedDeploymentTab(viewId, storage);
  return tabs.some(t => t.id === remembered) ? remembered : tabs[0].id;
}

const listeners = new Set();
/** The last request not yet taken (`{ view, tab }`), held here because the page that shows it (the Graph, slice 6b)
 * loads lazily: a request made before it is imported is still there for it. */
let pending = null;
/** Open a deployment's tab of a view (the switcher's "Not matched" entries): remembered, held until a page takes it,
 * then announced to the listeners as `{ view, tab }`. */
export function requestDeploymentTab(viewId, tab, storage = defaultStorage()) {
  if (!validId(viewId) || !validId(tab)) return;
  rememberDeploymentTab(viewId, tab, storage);
  pending = { view: viewId, tab };
  for (const fn of [...listeners]) { try { fn({ view: viewId, tab }); } catch { /* one listener must not break another */ } }
}
/** Take the request held for `viewId`, once, when `accept(tab)` says the page can show it (its deployment is drawn);
 * else null, and the request stays held. */
export function takeDeploymentRequest(viewId, accept = () => true) {
  if (!pending || pending.view !== viewId || !accept(pending.tab)) return null;
  const { tab } = pending; pending = null; return tab;
}
/** Listen to tab requests; returns the unsubscribe. */
export function onDeploymentTabRequest(fn) { listeners.add(fn); return () => listeners.delete(fn); }
