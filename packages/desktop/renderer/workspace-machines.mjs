/** The Setup tab's Registered machines box (#517; "Machines" until 2026-10-26, when the Workspace page's
 * Machines tab took the word): the registrations whose workspace key is this window's
 * (`/api/servers?ws=<view>`, server/machines.mjs), each with its name, ssh host, folder on the host, the
 * OATS version and reachability its last check reported, and Check and Remove; and "Add a machine to
 * this workspace…" (renderer/add-machine-dialog.mjs).
 *
 * - A machine with no check this run is checked once in the background (`/api/server-check`), at most
 *   two at a time; the facts the server holds (its backfill, an earlier Check) are shown as they are.
 * - Remove asks first, in the row, then runs `oats server remove` (`/api/server-remove`); a refusal is
 *   said in the row in the CLI's words.
 * - Without the gates the route answers today's list: the box is hidden. Without a workspace key the box
 *   says why (the route's reason) and offers nothing.
 * - The box owns its state: the Setup tab mounts it once per workspace and keeps it across re-renders,
 *   moving the same element into This computer (list view) or below the graph.
 *   Every read carries this box's latest-intent ticket; nothing lands after dispose(). */
import { apiJson, postJson } from './views/common.mjs';
import { box } from './workspace-setup.mjs';
import { iconElement } from './shell-icons.mjs';
import { openAddMachineDialog } from './add-machine-dialog.mjs';
import { followBackfill, BACKFILL_POLL_MS } from '../../client/machine-contract.mjs';
import { cliHeldBack } from './views/cli-status.mjs';

/** Above the tested bound (#1879) a machine's Check, Remove and Add are held back (packages/client/above-tested.mjs):
 * the notice for one, or null. */
const machineHeld = verb => cliHeldBack(`POST /api/server-${verb}`);

export const machinesCSS = `
/* One grid per box, each machine a subgrid row (Setup's members grammar). */
.machines-body { display:grid; grid-template-columns:minmax(0,.9fr) minmax(0,.8fr) minmax(0,1.3fr) 82px 110px auto; column-gap:16px; min-width:0; }
.machines-body > p { grid-column:1 / -1; }
.machines-row { grid-column:1 / -1; display:grid; grid-template-columns:subgrid; align-items:center; min-height:40px; padding:0 20px; box-sizing:border-box; border-top:1px solid var(--border); }
.machines-row > * { min-width:0; }
.machine-cell { color:var(--fg); font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.machine-cell.name { font-size:14px; font-weight:600; }
.machine-cell.muted { color:var(--muted); font-size:12px; }
.machine-cell.mono { font-weight:normal; font-size:13px; line-height:normal; font-family:var(--mono,monospace); }
/* Reachable: a check and a muted word; not reachable: the warn chip (the error is its title); not checked
   and checking…: muted words. */
.machine-state { justify-self:start; display:inline-flex; align-items:center; gap:5px; color:var(--muted); font-size:12px; }
.machine-state .shell-icon { flex:none; color:var(--ok); }
.machine-state[data-reachable=false] { height:20px; padding:0 7px; box-sizing:border-box; border-radius:5px; background:var(--attn-bg); color:var(--warn); font-size:11.5px; font-weight:650; }
.machine-acts { display:flex; gap:14px; justify-self:end; }
.oats-view .setup button.machine-act, .oats-view .setup button.machines-add, .oats-view .setup button.machines-retry { height:auto; min-height:0; padding:2px 0; border:0; background:transparent; color:var(--accent); font-weight:600; font-size:12px; line-height:normal; font-family:var(--ui-font,system-ui); white-space:nowrap; cursor:pointer; }
.oats-view .setup button.machine-act:hover, .oats-view .setup button.machines-add:hover, .oats-view .setup button.machines-retry:hover { text-decoration:underline; }
.oats-view .setup button.machine-act:disabled { color:var(--muted); cursor:default; text-decoration:none; }
.oats-view .setup button.machine-act:focus-visible, .oats-view .setup button.machines-add:focus-visible, .oats-view .setup button.machines-retry:focus-visible { background:var(--sel); border-radius:4px; padding:2px 4px; margin:0 -4px; }
.oats-view .setup .setup-box-head button.machines-add { margin-left:auto; }
.oats-view .setup .setup-box-head button.machines-add:focus-visible { margin:0 -4px 0 auto; }
.machine-confirm, .machine-error { grid-column:1 / -1; margin:0 0 10px; }
.machine-confirm { display:flex; flex-direction:column; gap:8px; padding:8px 10px; border:1px solid var(--border); border-radius:7px; background:var(--surface-2); }
.machine-confirm p { margin:0; color:var(--fg); font-size:12px; line-height:1.45; }
.machine-confirm-acts { display:flex; gap:8px; }
.oats-view .setup .machine-confirm button { height:26px; padding:0 12px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--fg); font-weight:600; font-size:12px; line-height:normal; font-family:var(--ui-font,system-ui); cursor:pointer; }
.oats-view .setup .machine-confirm button:focus-visible { background:var(--sel); }
.oats-view .setup .machine-confirm button.machine-confirm-remove { background:var(--danger); color:var(--primary-fg); border-color:var(--danger); }
.machine-error { color:var(--danger); font-size:12px; }
.machines-reason { margin:0; padding:12px 20px; border-top:1px solid var(--border); color:var(--muted); font-size:12px; display:flex; gap:12px; align-items:baseline; }
/* Narrow (the box under 860px): the name, the state and the actions; the name's title keeps the rest. */
@container setup-rows (max-width: 859.98px) {
 .machines-body { grid-template-columns:minmax(0,1fr) auto auto; }
 .machines-row > :is(.ssh, .folder, .version) { display:none; }
}
`;

/** Machines already checked in the background this run (a Check press always runs). */
const checkedThisRun = new Set();
/** Forget them (tests). */
export function resetMachineChecks() { checkedThisRun.clear(); }
const BACKGROUND_CHECKS = 2;
const text = value => typeof value === 'string' && value.length > 0;

/** `owns()` is the owner's latest intent (its workspace generation): once false, no answer renders, takes
 * focus or starts the next step, and the owner disposes the box. */
export function createWorkspaceMachines(doc, { ctx, ws, owns = () => true, backfillDelay = BACKFILL_POLL_MS }) {
  const el = (tag, value, cls) => { const n = doc.createElement(tag); if (value !== undefined && value !== null) n.textContent = value; if (cls) n.className = cls; return n; };
  const query = () => `?ws=${encodeURIComponent(ws)}`;
  // A solid card: in the list view it sits in Setup's This computer zone, which says it is not shared.
  const element = box(doc, 'Registered machines', 'that run this workspace', { heading: 'h4' });
  element.classList.add('setup-machines'); element.hidden = true;
  const head = element.querySelector('.setup-box-head');
  const body = el('div', undefined, 'machines-body'); element.append(body);
  let alive = true, ticket = 0, answer = null, failure = null, confirming = null, stopFollow = null;
  const checking = new Set(), rowErrors = new Map(), dialog = { current: null };
  const live = () => alive && owns();
  const current = t => live() && t === ticket;
  // Each press or key in the box is a newer interaction: an older operation's answer never moves focus
  // away from it, nor from a control outside the box.
  let intent = 0;
  for (const type of ['click', 'keydown']) element.addEventListener(type, () => { intent++; }, true);
  const mayFocus = since => live() && since === intent
    && (!doc.activeElement || doc.activeElement === doc.body || element.contains(doc.activeElement));

  let add = null;
  function addButton() {
    if (add) return add;
    add = el('button', 'Add a machine to this workspace…', 'machines-add'); add.type = 'button';
    if (machineHeld('connect')) { add.disabled = true; add.title = machineHeld('connect'); }
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
  function render() {
    const focusedId = doc.activeElement?.closest?.('[data-machine]')?.dataset.machine;
    const focusedClass = doc.activeElement?.className;
    body.replaceChildren();
    if (!answer && !failure) return;
    if (answer?.deployment) { if (!add?.isConnected) head.append(addButton()); }
    else add?.remove();
    if (failure || answer?.error) {
      const why = answer?.error?.message || failure;
      const line = el('p', `The machines of this workspace could not be read${typeof why === 'string' && why ? `: ${why}` : '.'}`, 'machines-reason');
      const retry = el('button', 'Retry', 'machines-retry'); retry.type = 'button'; retry.addEventListener('click', () => void load({ focus: 'retry' }));
      line.append(retry); body.append(line); return;
    }
    if (!answer.deployment) { body.append(el('p', answer.reason || '', 'machines-reason')); return; }
    if (!answer.servers.length) { body.append(el('p', 'No machine runs this workspace yet.', 'setup-empty')); return; }
    for (const m of answer.servers) {
      const row = el('div', undefined, 'machines-row'); row.dataset.machine = m.id;
      const state = stateText(m), badge = el('span', undefined, 'machine-cell machine-state');
      if (state.reachable === true) badge.append(iconElement(doc, 'check', { size: 13 }));
      badge.append(state.text);
      if (state.reachable !== null) badge.dataset.reachable = String(state.reachable);
      if (state.title) badge.title = state.title;
      const version = text(m.check?.version) ? `oats ${m.check.version}` : '';
      // Narrow rows hide the ssh host, folder and version: the name's title keeps them.
      const name = el('span', m.id, 'machine-cell name');
      name.title = [m.id, m.label && m.label !== m.id ? m.label : null, m.sshHost, m.workspace, version].filter(text).join(' · ');
      const folder = el('span', m.workspace, 'machine-cell mono muted folder'); folder.title = m.workspace;
      row.append(name, el('span', m.sshHost, 'machine-cell mono ssh'), folder, el('span', version, 'machine-cell muted version'), badge);
      const acts = el('span', undefined, 'machine-acts');
      const check = el('button', 'Check', 'machine-act machine-check'); check.type = 'button'; check.setAttribute('aria-label', `Check ${m.id}`);
      check.disabled = checking.has(m.id) || !!machineHeld('check'); check.title = machineHeld('check') ?? '';
      check.addEventListener('click', () => void runCheck(m.id, { focus: true }));
      const remove = el('button', 'Remove', 'machine-act machine-remove'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${m.id}`);
      if (machineHeld('remove')) { remove.disabled = true; remove.title = machineHeld('remove'); }
      remove.addEventListener('click', () => { confirming = m.id; rowErrors.delete(m.id); render(); body.querySelector(`[data-machine="${m.id}"] .machine-confirm-cancel`)?.focus(); });
      acts.append(check, remove); row.append(acts);
      if (confirming === m.id) {
        const confirm = el('div', undefined, 'machine-confirm');
        confirm.append(el('p', `Remove ${m.id}? Instances spawned there keep running and can still be retired from here.`));
        const buttons = el('div', undefined, 'machine-confirm-acts');
        const yes = el('button', 'Remove', 'machine-confirm-remove'); yes.type = 'button'; yes.addEventListener('click', () => void runRemove(m.id));
        const no = el('button', 'Cancel', 'machine-confirm-cancel'); no.type = 'button';
        no.addEventListener('click', () => { confirming = null; render(); body.querySelector(`[data-machine="${m.id}"] .machine-remove`)?.focus(); });
        buttons.append(yes, no); confirm.append(buttons); row.append(confirm);
      }
      if (rowErrors.has(m.id)) { const error = el('p', rowErrors.get(m.id), 'machine-error'); error.setAttribute('role', 'alert'); row.append(error); }
      body.append(row);
    }
    // A repaint keeps focus on the same control of the same machine.
    if (focusedId && focusedClass) body.querySelector(`[data-machine="${focusedId}"] .${String(focusedClass).split(' ').pop()}`)?.focus();
  }

  /** Take a list answer: gates off (no filtered answer) hides the box. */
  function take(d) {
    failure = null;
    if (d?.filtered !== true || !Array.isArray(d.servers)) { answer = null; element.hidden = true; return false; }
    answer = d; element.hidden = false;
    if (confirming && !d.servers.some(m => m.id === confirming)) confirming = null;
    return true;
  }
  async function load({ focus = null } = {}) {
    const t = ++ticket, since = intent;
    stopFollow?.(); stopFollow = null;
    try {
      const d = await apiJson(ctx, `/api/servers${query()}`);
      if (!current(t)) return;
      if (!take(d)) return;
      // The server is still learning unknown keys: read again until it is done (machine-contract.mjs).
      if (d.backfilling === true) stopFollow = followBackfill({ read: () => apiJson(ctx, `/api/servers${query()}`), owns: () => current(t), delay: backfillDelay,
        use: next => { if (take(next)) { render(); backgroundChecks(); } if (next?.backfilling !== true) stopFollow = null; } });
    } catch (error) {
      if (!current(t)) return;
      failure = error?.message || true; element.hidden = false;
    }
    render();
    if (focus && mayFocus(since)) {
      if (focus === 'add') add?.focus();
      if (focus === 'retry') (body.querySelector('.machines-retry') || add || body.querySelector('button'))?.focus();
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
    if (focus && mayFocus(since)) body.querySelector(`[data-machine="${id}"] .machine-check`)?.focus();
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
    if (mayFocus(since)) body.querySelector(`[data-machine="${id}"] .machine-remove`)?.focus();
  }

  void load();
  return {
    element,
    /** Read the list again (a machine added or removed elsewhere). */
    refresh() { if (live()) void load(); },
    dispose() { alive = false; ticket++; stopFollow?.(); dialog.current?.close({ restoreFocus: false }); element.remove(); },
  };
}
