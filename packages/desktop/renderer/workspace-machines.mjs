/** Workspace › Machines (#517; the Desktop UI rework, slice 3b, guide tour step 38): the computers this workspace
 * runs on, as one list. This computer first (where the view has a deployment here), then each registration whose
 * workspace key is this window's (`/api/servers?ws=<view>`, server/machines.mjs). A row says whether the computer is
 * reachable (this computer: whether its deployment was read; a registration: its last check) and its OATS version.
 * Enter opens a registered machine's row: its ssh host and folder, Check and Remove. "Add a machine to this
 * workspace…" is the dialog (renderer/add-machine-dialog.mjs). The guide's agents per machine are not shown in this
 * slice (the effort's lead, after a third review major on binding roster observations to machines): the Map and the
 * roster show where agents run.
 *
 * - A machine with no check this run is checked once in the background (`/api/server-check`), at most
 *   two at a time; the facts the server holds (its backfill, an earlier Check) are shown as they are.
 * - Remove asks first, in the row, then runs `oats server remove` (`/api/server-remove`); a refusal is
 *   said in the row in the CLI's words.
 * - The first list read says it is reading; a failed read says why with Retry. Without the gates (`gated: false`) nothing
 *   is read: this computer's row alone, and no Add.
 * - `here()` false (a remote-only view, or one with no deployment on this computer): no "This computer" row; the view's
 *   other deployments (`elsewhere()`, the panel's #482 `deployments`) are listed instead (their machine, whether reached).
 * - The section owns its state: the Machines tab mounts it once per workspace and keeps it across re-renders, and a
 *   repaint keeps focus on the same control (a row's, or the section's Retry and Add). Every read carries this section's
 *   latest-intent ticket; nothing lands after dispose(). */
import { apiJson, postJson } from './views/common.mjs';
import { iconElement } from './shell-icons.mjs';
import { openAddMachineDialog } from './add-machine-dialog.mjs';
import { followBackfill, BACKFILL_POLL_MS } from '../../client/machine-contract.mjs';
import { cliHeldBack, onCliChange } from './views/cli-status.mjs';
import { DESKTOP_NOUNS } from './desktop-terms.mjs';

/** Above the tested bound (#1879) a machine's Check, Remove and Add are held back (packages/client/above-tested.mjs):
 * the notice for one, or null. */
const machineHeld = verb => cliHeldBack(`POST /api/server-${verb}`);

export const MACHINES_COPY = Object.freeze({
  title: 'Machines',
  lead: 'The computers this workspace runs on.',
  thisComputer: 'This computer',
  add: 'Add a machine to this workspace…',
  none: 'No other machine runs this workspace yet.',
  reading: 'Reading the machines of this workspace…',
});

export const machinesCSS = `
.machines { display:flex; flex-direction:column; gap:14px; min-width:0; }
.machines-head { display:flex; align-items:flex-end; flex-wrap:wrap; gap:8px 16px; min-width:0; }
.machines-titles { display:flex; flex-direction:column; gap:4px; flex:1 1 320px; min-width:0; }
.machines-title { margin:0; color:var(--fg); font-size:18px; font-weight:650; line-height:1.25; }
.machines-lead { margin:0; color:var(--muted); font-size:13px; line-height:1.45; }
.machines-list { display:flex; flex-direction:column; margin:0; padding:0; list-style:none; background:var(--surface); border:1px solid var(--border); border-radius:10px; overflow:hidden; }
.machines-list > li { display:flex; flex-direction:column; min-width:0; }
.machines-list > li + li { border-top:1px solid var(--tag-bg); }
/* A row: name | reachable | OATS version | a chevron when it opens. One grid, so the columns line up. */
.oats-view button.machine-row, .machine-row { appearance:none; -webkit-appearance:none; display:grid; grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) minmax(0,.8fr) 16px; column-gap:16px; align-items:center; width:100%; height:auto; min-height:48px; margin:0; padding:8px 16px; border:0; border-radius:0; background:var(--surface); color:var(--fg); font:inherit; font-family:var(--ui-font,system-ui); text-align:left; box-sizing:border-box; }
.oats-view button.machine-row { cursor:pointer; }
.oats-view button.machine-row:hover { background:var(--surface-2); }
.oats-view button.machine-row:focus-visible { background:var(--sel); }
.machine-row > * { min-width:0; }
.machine-cell { color:var(--fg); font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.machine-cell.name { font-size:13.5px; font-weight:600; }
.machine-cell.muted { color:var(--muted); font-size:12px; }
.machine-chevron { color:var(--muted); transition:transform .15s; }
.machine-row[aria-expanded=true] .machine-chevron { transform:rotate(90deg); }
@media (prefers-reduced-motion: reduce) { .machine-chevron { transition:none; } }
/* Reachable: a check and a muted word; not reachable: the warn chip (the error is its title); not checked
   and checking…: muted words. */
.machine-state { justify-self:start; display:inline-flex; align-items:center; gap:5px; color:var(--muted); font-size:12px; }
.machine-state .shell-icon { flex:none; color:var(--ok); }
.machine-state[data-reachable=false] { height:20px; padding:0 7px; box-sizing:border-box; border-radius:5px; background:var(--attn-bg); color:var(--warn); font-size:11.5px; font-weight:650; }
/* An open machine: its ssh host and folder, then Check and Remove. */
.machine-detail { display:flex; flex-direction:column; gap:10px; padding:4px 16px 14px; }
.machine-facts { display:grid; grid-template-columns:max-content minmax(0,1fr); gap:4px 14px; margin:0; font-size:12.5px; }
.machine-facts dt { color:var(--muted); }
.machine-facts dd { margin:0; min-width:0; color:var(--fg); font-family:var(--mono,monospace); overflow-wrap:anywhere; }
.machine-acts { display:flex; gap:8px; }
.oats-view .machines button.machine-act, .oats-view .machines .machine-confirm button { height:28px; min-height:28px; padding:0 12px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--fg); font-weight:600; font-size:12px; line-height:normal; font-family:var(--ui-font,system-ui); cursor:pointer; }
.oats-view .machines button.machine-act:hover:not(:disabled) { background:var(--surface-2); }
.oats-view .machines button.machine-act:disabled { color:var(--muted); cursor:default; }
.oats-view .machines button.machine-act:focus-visible, .oats-view .machines .machine-confirm button:focus-visible { background:var(--sel); }
.oats-view .machines button.machines-add, .oats-view .machines button.machines-retry { height:auto; min-height:0; padding:2px 0; border:0; background:transparent; color:var(--accent); font-weight:600; font-size:12.5px; line-height:normal; font-family:var(--ui-font,system-ui); white-space:nowrap; cursor:pointer; }
.oats-view .machines button.machines-add:hover, .oats-view .machines button.machines-retry:hover { text-decoration:underline; }
.oats-view .machines button.machines-add:disabled { color:var(--muted); cursor:default; text-decoration:none; }
.oats-view .machines button.machines-add:focus-visible, .oats-view .machines button.machines-retry:focus-visible { background:var(--sel); border-radius:4px; padding:2px 4px; margin:0 -4px; }
.machine-confirm, .machine-error { margin:0; }
.machine-confirm { display:flex; flex-direction:column; gap:8px; padding:8px 10px; border:1px solid var(--border); border-radius:7px; background:var(--surface-2); }
.machine-confirm p { margin:0; color:var(--fg); font-size:12px; line-height:1.45; }
.machine-confirm-acts { display:flex; gap:8px; }
.oats-view .machines .machine-confirm button.machine-confirm-remove { background:var(--danger); color:var(--primary-fg); border-color:var(--danger); }
.machine-error { color:var(--danger); font-size:12px; }
.machines-reason { margin:0; padding:12px 16px; color:var(--muted); font-size:12px; display:flex; gap:12px; align-items:baseline; }
.machines-empty { margin:0; padding:12px 16px; color:var(--muted); font-size:12px; }
/* Narrow: name and state on the first line, the version under them. */
@container (max-width: 640px) {
 .oats-view button.machine-row, .machine-row { grid-template-columns:minmax(0,1fr) auto 16px; row-gap:2px; }
 .machine-row > .version { grid-row:2; grid-column:1; }
 .machine-row > .machine-chevron { grid-row:1; grid-column:3; }
}
`;

/** Machines already checked in the background this run (a Check press always runs). */
const checkedThisRun = new Set();
/** Forget them (tests). */
export function resetMachineChecks() { checkedThisRun.clear(); }
const BACKGROUND_CHECKS = 2;
const text = value => typeof value === 'string' && value.length > 0;
const list = value => Array.isArray(value) ? value : [];
/** This computer's row id: never a registration's (a registration id is `<host>-<folder>`, no colon). */
export const THIS_COMPUTER = ':here';

/** `owns()` is the owner's latest intent (its workspace generation): once false, no answer renders, takes
 * focus or starts the next step, and the owner disposes the section. `cli()`: the CLI probe
 * (this computer's OATS version); `localObservation()`: this computer's deployment, read or not. `sync()` repaints. */
export function createWorkspaceMachines(doc, { ctx, ws, owns = () => true, backfillDelay = BACKFILL_POLL_MS, cli = () => null, gated = true, here = () => true, elsewhere = () => [], localObservation = () => ({ status: 'observed' }) }) {
  const el = (tag, value, cls) => { const n = doc.createElement(tag); if (value !== undefined && value !== null) n.textContent = value; if (cls) n.className = cls; return n; };
  const query = () => `?ws=${encodeURIComponent(ws)}`;
  const element = el('section', undefined, 'machines'); element.dataset.section = 'machines';
  const head = el('div', undefined, 'machines-head'), titles = el('div', undefined, 'machines-titles');
  const title = el('h2', MACHINES_COPY.title, 'machines-title'); title.id = `machines-title-${++sections}`; title.tabIndex = -1;
  titles.append(title, el('p', MACHINES_COPY.lead, 'machines-lead'));
  head.append(titles); element.setAttribute('aria-labelledby', title.id);
  const body = el('ul', undefined, 'machines-list'); body.setAttribute('aria-labelledby', title.id);
  const notes = el('div', undefined, 'machines-notes');
  element.append(head, body, notes);
  // `reading`: the list read is in flight with nothing settled yet (the first read, or a Retry after a failure).
  let alive = true, ticket = 0, answer = null, failure = null, confirming = null, stopFollow = null, open = null, reading = false;
  const checking = new Set(), rowErrors = new Map(), dialog = { current: null };
  const live = () => alive && owns();
  const rowOf = id => [...body.children].find(li => li.dataset.machine === id) || null;
  const current = t => live() && t === ticket;
  // Each press or key in the section is a newer interaction: an older operation's answer never moves focus
  // away from it, nor from a control outside the section.
  let intent = 0;
  for (const type of ['click', 'keydown']) element.addEventListener(type, () => { intent++; }, true);
  const mayFocus = since => live() && since === intent
    && (!doc.activeElement || doc.activeElement === doc.body || element.contains(doc.activeElement));

  let add = null;
  function addButton() {
    if (add) return add;
    add = el('button', MACHINES_COPY.add, 'machines-add'); add.type = 'button';
    add.addEventListener('click', () => {
      if (!live() || !answer?.deployment) return;
      dialog.current?.close({ restoreFocus: false });
      dialog.current = openAddMachineDialog(doc, { ctx, ws, deployment: answer.deployment, aweb: answer.aweb === true, owns: live,
        onAdded: () => { dialog.current = null; void load({ focus: 'add' }); }, onClose: () => { dialog.current = null; } });
    });
    return add;
  }

  function stateText(m) {
    if (checking.has(m.id)) return { text: 'checking…', reachable: null, title: '' };
    if (!m.check) return { text: 'not checked', reachable: null, title: '' };
    return { text: m.check.reachable ? 'reachable' : 'not reachable', reachable: m.check.reachable, title: m.check.error || '' };
  }
  function badge(state) {
    const span = el('span', undefined, 'machine-cell machine-state');
    if (state.reachable === true) span.append(iconElement(doc, 'check', { size: 13 }));
    span.append(state.text);
    if (state.reachable !== null) span.dataset.reachable = String(state.reachable);
    if (state.title) span.title = state.title;
    return span;
  }
  function cells(row, { name, state, version, chevron }) {
    const n = el('span', name, 'machine-cell name'); n.title = name;
    row.append(n, badge(state), el('span', version, 'machine-cell muted version'));
    row.append(chevron ? iconElement(doc, 'chevronRight', { size: 14, className: 'shell-icon machine-chevron' }) : el('span'));
  }
  function hereRow() {
    const li = el('li'); li.dataset.machine = THIS_COMPUTER;
    const row = el('div', undefined, 'machine-row');
    const version = text(cli()?.version) ? `oats ${cli().version}` : '';
    // This computer is always here; its deployment of the workspace may not have been read (pending) or be unreadable.
    const o = localObservation();
    const state = o?.status === 'observed' ? { text: 'reachable', reachable: true, title: '' }
      : o?.status === 'pending' ? { text: 'reading…', reachable: null, title: '' }
      : { text: 'not read', reachable: false, title: text(o?.text) ? o.text : '' };
    cells(row, { name: MACHINES_COPY.thisComputer, state, version, chevron: false });
    li.append(row); return li;
  }
  /** Another machine's deployment of a remote-only view (#482 `deployments`: its machine, whether it was reached). Not a
   * registration: nothing to check or remove here. */
  function deploymentRow(d) {
    const li = el('li'); li.dataset.machine = `deployment:${d.id}`;
    const row = el('div', undefined, 'machine-row');
    const reached = d.reachable === true ? true : d.reachable === false ? false : null;
    cells(row, { name: text(d.machine) ? d.machine : text(d.label) ? d.label : d.id, state: { text: reached === true ? 'reachable' : reached === false ? 'not reachable' : 'not checked', reachable: reached, title: text(d.reason) ? d.reason : '' }, version: '', chevron: false });
    row.title = [d.machine, d.path].filter(text).join(' · ');
    li.append(row); return li;
  }
  function render() {
    const focused = doc.activeElement && element.contains(doc.activeElement) ? doc.activeElement : null;
    const focusedId = focused?.closest?.('[data-machine]')?.dataset.machine;
    const focusedKey = focused?.dataset?.focusKey;
    const focusedRetry = !!focused?.classList?.contains('machines-retry');
    body.replaceChildren(); notes.replaceChildren();
    // This computer only where the view has a deployment here; a remote-only view lists its machines' deployments.
    const local = here();
    if (local) {
      body.append(hereRow());
      // Why this computer's deployment was not read, in the observation's own words (the other tabs' status line).
      const o = localObservation();
      if (o?.status !== 'observed' && o?.status !== 'pending' && text(o?.text)) notes.append(el('p', o.text, 'machines-reason'));
    }
    else for (const d of list(elsewhere())) body.append(deploymentRow(d));
    if (answer?.deployment) { if (!add?.isConnected) head.append(addButton()); }
    else add?.remove();
    // Held back or not as the CLI is now: the button is kept across renders, and a reprobe renders again.
    if (add) { const held = machineHeld('connect'); add.disabled = !!held; add.title = held ?? ''; }
    if (reading && !answer && !failure) {
      const wait = el('p', MACHINES_COPY.reading, 'machines-reason machines-loading'); wait.setAttribute('role', 'status');
      notes.append(wait); body.setAttribute('aria-busy', 'true'); return restore();
    }
    body.removeAttribute('aria-busy');
    if (failure || answer?.error) {
      const why = answer?.error?.message || failure;
      const line = el('p', `The machines of this workspace could not be read${typeof why === 'string' && why ? `: ${why}` : '.'}`, 'machines-reason');
      const retry = el('button', 'Retry', 'machines-retry'); retry.type = 'button'; retry.addEventListener('click', () => void load({ focus: 'retry' }));
      line.append(retry); notes.append(line); return restore();
    }
    if (!answer) return restore();
    if (!answer.deployment) { notes.append(el('p', answer.reason || '', 'machines-reason')); return restore(); }
    if (!answer.servers.length) { if (local || !body.childElementCount) notes.append(el('p', MACHINES_COPY.none, 'machines-empty')); return restore(); }
    for (const m of answer.servers) {
      const li = el('li'); li.dataset.machine = m.id;
      const expanded = open === m.id;
      const row = el('button', undefined, 'machine-row'); row.type = 'button'; row.dataset.focusKey = 'row';
      row.setAttribute('aria-expanded', String(expanded));
      const version = text(m.check?.version) ? `oats ${m.check.version}` : '';
      cells(row, { name: m.id, state: stateText(m), version, chevron: true });
      row.title = [m.id, m.label && m.label !== m.id ? m.label : null, m.sshHost, m.workspace, version].filter(text).join(' · ');
      row.addEventListener('click', () => { open = expanded ? null : m.id; if (open !== m.id) confirming = null; render(); rowOf(m.id)?.querySelector('.machine-row')?.focus(); });
      li.append(row);
      if (expanded) li.append(detail(m));
      body.append(li);
    }
    restore();
    function restore() {
      if (focused?.isConnected && element.contains(focused)) return;
      // A repaint keeps focus on the section's Retry while the failure stands, else on the list's head; on the same
      // control of the same machine.
      if (focusedRetry) { focusFirst(notes.querySelector('.machines-retry'), add); return; }
      if (!focusedId || !focusedKey) return;
      rowOf(focusedId)?.querySelector(`[data-focus-key="${focusedKey}"]`)?.focus();
    }
  }
  /** Focus the first of `candidates` that is in the section and enabled, else the section's heading (never <body>). */
  function focusFirst(...candidates) {
    const target = candidates.find(c => c?.isConnected && element.contains(c) && !c.disabled) || title;
    target.focus({ preventScroll: false });
  }
  function detail(m) {
    const box = el('div', undefined, 'machine-detail'); box.dataset.detail = m.id;
    const facts = el('dl', undefined, 'machine-facts');
    for (const [key, value] of [['Name', m.label && m.label !== m.id ? m.label : null], ['ssh host', m.sshHost], ['Folder', m.workspace]]) {
      if (!text(value)) continue;
      facts.append(el('dt', key), el('dd', value));
    }
    box.append(facts);
    const acts = el('div', undefined, 'machine-acts');
    const check = el('button', 'Check', 'machine-act machine-check'); check.type = 'button'; check.dataset.focusKey = 'check'; check.setAttribute('aria-label', `Check ${m.id}`);
    check.disabled = checking.has(m.id) || !!machineHeld('check'); check.title = machineHeld('check') ?? '';
    check.addEventListener('click', () => void runCheck(m.id, { focus: true }));
    const remove = el('button', 'Remove', 'machine-act machine-remove'); remove.type = 'button'; remove.dataset.focusKey = 'remove'; remove.setAttribute('aria-label', `Remove ${m.id}`);
    if (machineHeld('remove')) { remove.disabled = true; remove.title = machineHeld('remove'); }
    remove.addEventListener('click', () => { confirming = m.id; rowErrors.delete(m.id); render(); rowOf(m.id)?.querySelector('.machine-confirm-cancel')?.focus(); });
    acts.append(check, remove); box.append(acts);
    if (confirming === m.id) {
      const confirm = el('div', undefined, 'machine-confirm');
      confirm.append(el('p', `Remove ${m.id}? ${capitalized(DESKTOP_NOUNS.instances)} started there keep running and can still be retired from here.`));
      const buttons = el('div', undefined, 'machine-confirm-acts');
      const yes = el('button', 'Remove', 'machine-confirm-remove'); yes.type = 'button'; yes.dataset.focusKey = 'confirm'; yes.addEventListener('click', () => void runRemove(m.id));
      const no = el('button', 'Cancel', 'machine-confirm-cancel'); no.type = 'button'; no.dataset.focusKey = 'cancel';
      no.addEventListener('click', () => { confirming = null; render(); rowOf(m.id)?.querySelector('.machine-remove')?.focus(); });
      buttons.append(yes, no); confirm.append(buttons); box.append(confirm);
    }
    if (rowErrors.has(m.id)) { const error = el('p', rowErrors.get(m.id), 'machine-error'); error.setAttribute('role', 'alert'); box.append(error); }
    return box;
  }

  /** Take a list answer: gates off (no filtered answer) offers no registered machine. */
  function take(d) {
    failure = null;
    if (d?.filtered !== true || !Array.isArray(d.servers)) { answer = null; return false; }
    answer = d;
    if (confirming && !d.servers.some(m => m.id === confirming)) confirming = null;
    if (open && !d.servers.some(m => m.id === open)) open = null;
    return true;
  }
  async function load({ focus = null } = {}) {
    const t = ++ticket, since = intent;
    stopFollow?.(); stopFollow = null;
    // The first read (or a Retry over a failure) says it is reading; a refresh over a held list keeps it on screen.
    if (!answer) { reading = true; failure = null; render(); }
    try {
      const d = await apiJson(ctx, `/api/servers${query()}`);
      if (!current(t)) return;
      reading = false;
      if (!take(d)) { render(); return; }
      // The server is still learning unknown keys: read again until it is done (machine-contract.mjs).
      if (d.backfilling === true) stopFollow = followBackfill({ read: () => apiJson(ctx, `/api/servers${query()}`), owns: () => current(t), delay: backfillDelay,
        use: next => { if (take(next)) { render(); backgroundChecks(); } if (next?.backfilling !== true) stopFollow = null; } });
    } catch (error) {
      if (!current(t)) return;
      reading = false;
      failure = error?.message || true;
    }
    render();
    if (focus && mayFocus(since)) {
      if (focus === 'add') focusFirst(add);
      if (focus === 'retry') focusFirst(notes.querySelector('.machines-retry'), add, body.querySelector('button'));
    }
    backgroundChecks();
  }
  function backgroundChecks() {
    // A check held back above the tested bound is not run in the background either: nothing to be refused.
    if (machineHeld('check')) return;
    const due = (answer?.servers || []).filter(m => !m.check && !checkedThisRun.has(m.id));
    for (const m of due) { checkedThisRun.add(m.id); checking.add(m.id); }
    if (!due.length) return;
    render();
    let next = 0;
    const worker = async () => { while (live() && next < due.length) await runCheck(due[next++].id); };
    for (let i = 0; i < Math.min(BACKGROUND_CHECKS, due.length); i++) void worker();
  }
  async function runCheck(id, { focus = false } = {}) {
    if (!live()) return;
    const since = intent;
    checkedThisRun.add(id); checking.add(id); rowErrors.delete(id); render();
    let result = null, error = null;
    try { result = await postJson(ctx, `/api/server-check${query()}`, { id }); } catch (e) { error = e?.message || 'The check could not run.'; }
    if (!live()) return;
    checking.delete(id);
    const m = answer?.servers.find(row => row.id === id);
    if (m && result?.id === id) m.check = result.check ?? null;
    if (error) rowErrors.set(id, error);
    render();
    if (focus && mayFocus(since)) rowOf(id)?.querySelector('.machine-check')?.focus();
  }
  async function runRemove(id) {
    if (!live()) return;
    const since = intent;
    let envelope = null, error = null;
    try { envelope = await postJson(ctx, `/api/server-remove${query()}`, { id }); } catch (e) { error = e?.message || 'The machine could not be removed.'; }
    if (!live()) return;
    if (confirming === id) confirming = null;
    if (envelope?.ok) { rowErrors.delete(id); await load({ focus: mayFocus(since) ? 'add' : null }); return; }
    rowErrors.set(id, error || `${envelope?.error?.message || 'The machine could not be removed.'}${envelope?.error?.code ? ` (${envelope.error.code})` : ''}`);
    render();
    if (mayFocus(since)) rowOf(id)?.querySelector('.machine-remove')?.focus();
  }

  // A CLI moving into or out of the tested bound changes what the rows and Add offer.
  const offCli = onCliChange(() => { if (live()) render(); });
  render();
  // Without the machine gates (machine-contract.mjs machinesGated) the route answers no list for this workspace: none is read.
  if (gated) void load();
  return {
    element,
    /** Read the list again (a machine added or removed elsewhere). */
    refresh() { if (live() && gated) void load(); },
    /** The roster or the CLI probe moved: this computer's observation, the view's deployments and this computer's
     * version follow. */
    sync() { if (live()) render(); },
    dispose() { alive = false; ticket++; offCli(); stopFollow?.(); dialog.current?.close({ restoreFocus: false }); element.remove(); },
  };
}
const capitalized = word => word.charAt(0).toUpperCase() + word.slice(1);
let sections = 0; // ids for the titles, unique in the document
