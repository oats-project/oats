/** The spawn dialog's Deployment field (#482, decision Q2, UI spec): which of the view's deployments the
 * new instance is spawned in. Shown only when the view has two or more deployments; with one, there is
 * no field and nothing changes (the dialog addresses that deployment). It is the form's first choice,
 * after the Opening instruction: where the instance runs decides everything else.
 *
 * - The control is the form's own family, never a native select: with two or three deployments the
 *   segmented control (Relationship's; one tab stop, arrows choose), with more the Harness-style
 *   dropdown (choice-popup.mjs). Each option is the deployment's machine label (machineLabels: "This
 *   Mac", "devbox", "This Mac · oats-qa"; never an id) and, for a deployment that is not live, its state
 *   in words ("not reached", "remembered": deploymentState) as a tag. The full deploymentLabel
 *   ("devbox · ~/acme") is the dialog's "Runs on" row (`runsOn()`).
 * - Availability is the CHOSEN deployment's own spawn catalog (`/api/agents?ws=<deployment id>`;
 *   a remote deployment's catalog is its roster group's, answered by the server). A deployment
 *   without the soul, or not reached, stays selectable; choosing it blocks Spawn, and the dialog says
 *   why in its footer only (`blockText()`): "devbox isn't reachable right now" when it is not reached
 *   ("This Mac's deployment hasn't been read yet. Try again in a moment." for a local one not yet
 *   read), else "<soul> isn't available on devbox". The field itself shows no message.
 * - The default: the deployment last used in this view, if it has the soul; else the first that has
 *   it, local before remote; else the last used (blocked, saying why); with nothing used yet, the
 *   first local deployment, else the first. Until the catalogs answer the field shows that
 *   provisional choice and the dialog does not read a preview (`pending()`); an untouched field then
 *   moves to the rule's choice.
 * - "Last used" is kept per view in localStorage (`SPAWN_DEPLOYMENT_KEY`): only deployment ids, at
 *   most `SPAWN_DEPLOYMENT_VIEWS_MAX` views, the most recent kept. It is recorded on a successful
 *   spawn only (`rememberSpawnDeployment`).
 *
 * The catalog reads carry a latest-intent token: a reply after dispose() or a newer read is dropped. */
import { apiJson } from './views/common.mjs';
import { deploymentLabel, machineLabels } from '../../client/deployment-label.mjs';
import { DESKTOP_TERMS } from './desktop-terms.mjs';
import { deploymentState } from '../../client/roster-sections.mjs';
import { createChoicePopup } from './choice-popup.mjs';
import { validWorkspaceId as validId } from './workspace-id.mjs';

export const SPAWN_DEPLOYMENT_KEY = 'oats.desktop.spawnDeployment';
export const SPAWN_DEPLOYMENT_VIEWS_MAX = 32;
/** Up to this many deployments the field is a segmented control; more get the dropdown. */
export const SPAWN_DEPLOYMENT_SEGMENTS_MAX = 3;
const text = v => typeof v === 'string' && v ? v : null;
const defaultStorage = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };

function readMap(storage) {
  try {
    const value = JSON.parse(storage?.getItem(SPAWN_DEPLOYMENT_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
/** The deployment last used for a spawn in this view, or null. */
export function lastSpawnDeployment(viewId, storage = defaultStorage()) {
  if (!validId(viewId)) return null;
  const value = readMap(storage)[viewId];
  return validId(value) ? value : null;
}
/** Record a successful spawn's deployment for its view (bounded: the most recent views only). */
export function rememberSpawnDeployment(viewId, deploymentId, storage = defaultStorage()) {
  if (!storage || !validId(viewId) || !validId(deploymentId)) return;
  const map = readMap(storage);
  delete map[viewId]; map[viewId] = deploymentId; // insertion order: the most recent last
  const kept = Object.entries(map).filter(([k, v]) => validId(k) && validId(v)).slice(-SPAWN_DEPLOYMENT_VIEWS_MAX);
  try { storage.setItem(SPAWN_DEPLOYMENT_KEY, JSON.stringify(Object.fromEntries(kept))); } catch { /* storage is a convenience */ }
}

/** The panel's deployments, kept as far as they validate (labels enter the DOM as text only). */
export function spawnDeployments(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).filter(d => d && typeof d === 'object' && validId(d.id) && !seen.has(d.id) && seen.add(d.id));
}

/** The soul's row in another deployment's catalog: the same name and root, else the one row of that
 * name, else the one of that name from the same repository and kind. Null when absent or ambiguous. */
export function catalogSoul(agents, soul) {
  const named = (Array.isArray(agents) ? agents : []).filter(a => a && a.name === soul?.name && typeof a.agentsRoot === 'string' && a.agentsRoot);
  const exact = named.filter(a => a.agentsRoot === soul.agentsRoot);
  if (exact.length === 1) return exact[0];
  if (named.length === 1) return named[0];
  const same = named.filter(a => (a.repoName || '') === (soul.repoName || '') && (a.soulKind || '') === (soul.soulKind || ''));
  return same.length === 1 ? same[0] : null;
}

/** The default deployment (decision Q2). `has(id)`: true, false, or null while unknown. */
export function defaultSpawnDeployment(deployments, { has = () => null, lastUsed = null } = {}) {
  const ids = deployments.map(d => d.id);
  const last = ids.includes(lastUsed) ? lastUsed : null;
  if (last && has(last) === true) return last;
  const local = deployments.filter(d => d.local === true), remote = deployments.filter(d => d.local !== true);
  const holder = [...local, ...remote].find(d => has(d.id) === true);
  if (holder) return holder.id;
  return last ?? (local[0] ?? deployments[0])?.id ?? null;
}

/** A remote deployment's server: its catalog row's, else the id's (`remote:<server>:<targetKey>`). */
const serverOf = (deployment, row) => {
  if (deployment.local === true) return '';
  if (text(row?.server)) return row.server;
  const m = /^remote:([a-z0-9][a-z0-9-]{0,63}):/.exec(deployment.id);
  return m ? m[1] : '';
};

/** A non-live deployment's state in words ("not reached", "remembered", "not observed"); '' when live. */
const stateText = d => { const state = deploymentState(d); return state.key === 'live' ? '' : state.text; };
let groups = 0; // each segmented group's radios get their own name

/**
 * @param doc  the dialog's document
 * @param opts ctx (apiJson), soul (the dialog's soul), viewId, deployments (the panel's list),
 *             preferred (a deployment id to choose first, e.g. Reopen spawn's), storage (localStorage),
 *             rove (the dialog's roveSegment: the segmented control's keyboard),
 *             onChange({ moved, programmatic }) — the choice or its availability changed,
 *             read(id) — optional: the catalog's agents (default: GET /api/agents?ws=<id>).
 * @returns null with fewer than two deployments; else the field. An operator's choice also fires a
 *          bubbling `change` from the control, as the form's other fields do.
 */
export function createSpawnDeploymentField(doc, { ctx, soul, viewId, deployments, preferred = null, storage = defaultStorage(), rove = () => {}, onChange = () => {}, read = null }) {
  const list = spawnDeployments(deployments);
  if (list.length < 2) return null;
  const el = (tag, value, cls) => { const node = doc.createElement(tag); if (value !== undefined) node.textContent = value; if (cls) node.className = cls; return node; };
  const readCatalog = read || (id => apiJson(ctx, `/api/agents?ws=${encodeURIComponent(id)}`).then(d => d?.agents));
  // Per deployment: { state: 'pending' | 'ok' | 'failed', row } (the soul's catalog row, or null).
  const catalogs = new Map(list.map(d => [d.id, { state: 'pending', row: null }]));
  const lastUsed = validId(preferred) && catalogs.has(preferred) ? preferred : lastSpawnDeployment(viewId, storage);
  let alive = true, serial = 0, touched = validId(preferred) && catalogs.has(preferred);
  const labels = machineLabels(list, DESKTOP_TERMS);
  const machine = d => labels.get(d.id) || deploymentLabel(d, DESKTOP_TERMS);
  /** The option's words: its machine, then its state when not live (the tag, never colour alone). */
  const spoken = d => [machine(d), stateText(d)].filter(Boolean).join(', ');
  const describe = (host, d) => {
    host.replaceChildren(doc.createTextNode(machine(d)));
    const state = stateText(d); if (state) host.append(el('small', state, 'spawn-trigger-tag'));
  };
  /** Whether a deployment offers the soul: true, false, or null while unknown (its catalog is still read, or failed). */
  const has = id => {
    const c = catalogs.get(id), d = list.find(x => x.id === id);
    if (c?.state === 'ok') return !!c.row;
    // A deployment that is not reached has no catalog to offer (the server answers none): not available.
    return d?.reachable === false ? false : null;
  };
  let chosen = defaultSpawnDeployment(list, { has, lastUsed }) ?? list[0].id;
  const deployment = () => list.find(d => d.id === chosen) || list[0];

  let field, paint, popup = null;
  if (list.length <= SPAWN_DEPLOYMENT_SEGMENTS_MAX) {
    // Relationship's segmented control: a radiogroup under a legend, one tab stop, arrows choose.
    field = el('fieldset', undefined, 'spawn-field spawn-deployment');
    field.append(el('legend', 'Deployment'));
    const seg = el('div', undefined, 'spawn-seg fdeployment'); seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', 'Deployment');
    const name = `spawn-deployment-${++groups}`;
    for (const d of list) {
      const option = el('label'), input = el('input'), face = el('span');
      input.type = 'radio'; input.name = name; input.value = d.id; input.setAttribute('aria-label', spoken(d));
      option.title = deploymentLabel(d, DESKTOP_TERMS); describe(face, d); option.append(input, face); seg.append(option);
    }
    field.append(seg);
    const sync = rove(seg, { selects: true }) || (() => {});
    paint = () => { for (const input of seg.querySelectorAll('input')) input.checked = input.value === chosen; sync(); };
    seg.addEventListener('change', event => { if (event.target?.checked) picked(event.target.value); });
  } else {
    // The Harness picker: a labelled trigger and its listbox popup.
    field = el('div', undefined, 'spawn-field spawn-deployment');
    const row = el('div', undefined, 'spawn-row'), label = el('label');
    label.append(el('span', 'Deployment', 'spawn-label-text')); row.append(label); field.append(row);
    popup = createChoicePopup(doc, label, 'Deployment choices', 'spawn-deployment-choices',
      () => list.map(d => ({ value: d.id, label: machine(d), detail: stateText(d) || undefined, selected: d.id === chosen })),
      // The form hears the pick as it hears its other fields: a bubbling change, after the field took it.
      item => { if (item.value === chosen || !alive) return; picked(item.value); popup.trigger.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true })); });
    popup.trigger.classList.add('fdeployment');
    paint = () => {
      const d = deployment(); describe(popup.trigger, d);
      popup.trigger.setAttribute('aria-label', `Deployment: ${spoken(d)}`); popup.trigger.title = deploymentLabel(d, DESKTOP_TERMS);
      popup.refresh();
    };
  }
  /** The operator chose (a click, an arrow, a pick): the dialog re-reads for that deployment. */
  function picked(id) {
    if (!alive || !catalogs.has(id)) return;
    chosen = id; touched = true; paint(); onChange({ moved: true, programmatic: false });
  }
  function choose(id, programmatic) {
    const before = chosen;
    if (id && catalogs.has(id)) chosen = id;
    paint();
    return chosen !== before || !programmatic;
  }

  const api = {
    element: field,
    /** The chosen deployment's id: every spawn request of the dialog addresses it. */
    value: () => deployment().id,
    deployment,
    /** The "Runs on" row's words: the chosen deployment's full label ("devbox · ~/acme"). */
    runsOn: () => deploymentLabel(deployment(), DESKTOP_TERMS),
    /** The chosen deployment's server ('' for a local one): a remote deployment spawns through it. */
    server: () => serverOf(deployment(), catalogs.get(deployment().id)?.row),
    /** The selector for the chosen deployment: its catalog's row for the soul (the root differs per deployment). */
    selector: () => { const r = catalogs.get(deployment().id)?.row; return { soul: soul.name, agentsRoot: r?.agentsRoot ?? soul.agentsRoot }; },
    /** The soul's default harness in the chosen deployment's catalog, as its machine reports it; null while unknown. */
    harness: () => { const h = catalogs.get(deployment().id)?.row?.harness; return typeof h === 'string' && h ? h : null; },
    /** Some catalog is still being read and the operator has not chosen: the default may still move. */
    pending: () => !touched && [...catalogs.values()].some(c => c.state === 'pending'),
    /** The chosen deployment does not offer the soul (or is not reached, so offers none): Spawn is blocked. */
    blocked: () => has(deployment().id) === false,
    /** Why Spawn is blocked, for the footer (the caller ends the sentence). */
    // A local deployment is never "unreachable": it just hasn't been read yet (the dialog adds the final period).
    blockText: () => deployment().reachable === false
      ? (deployment().local ? `${deployment().machine || DESKTOP_TERMS.thisMachine}'s deployment hasn't been read yet. Try again in a moment` : `${machine(deployment())} isn't reachable right now`)
      : `${soul.name} isn't available on ${machine(deployment())}`,
    /** Read every deployment's catalog (latest intent: a reply after dispose or a newer start is dropped). */
    start() {
      const ticket = ++serial;
      for (const d of list) {
        catalogs.set(d.id, { state: 'pending', row: null });
        Promise.resolve().then(() => readCatalog(d.id)).then(agents => ({ state: Array.isArray(agents) ? 'ok' : 'failed', row: Array.isArray(agents) ? catalogSoul(agents, soul) : null }),
          () => ({ state: 'failed', row: null })).then(result => {
          if (!alive || ticket !== serial) return;
          catalogs.set(d.id, result);
          const settledAll = ![...catalogs.values()].some(c => c.state === 'pending');
          // An untouched field moves to the rule's choice once every catalog answered.
          const moved = settledAll && !touched ? choose(defaultSpawnDeployment(list, { has, lastUsed }), true) : false;
          if (settledAll || moved) onChange({ moved, programmatic: true });
        });
      }
    },
    /** A successful spawn: this view's last-used deployment is now the chosen one. */
    remember: () => rememberSpawnDeployment(viewId, deployment().id, storage),
    closePopup: () => popup?.close(),
    dispose() { alive = false; serial++; popup?.dispose(); },
  };
  paint();
  return api;
}
