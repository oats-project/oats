/** "Add a machine to this workspace…" (#517): the modal that runs `oats server connect` and, when the
 * window's deployment uses oats.aweb for messaging and connect reached `register`, `oats aweb connect`,
 * through `/api/server-connect?ws=<view>` (server/machines.mjs). It never runs anything over ssh itself
 * and never asks for or shows a secret.
 *
 * - Fields: Machine (an ssh host alias), Name (`<host>-<deployment folder name>` until the operator edits
 *   it), Folder on that machine (empty and required: no folder is suggested, #1390), "Install OATS there
 *   if it's missing" (on). A value the kernel would refuse is said beside its field (machine-contract.mjs).
 * - Each phase's steps are rows, as the CLI sends them: the step, its status in words (ok, done, needs
 *   you, waiting, failed: never colour alone), the CLI's own `detail`, `remedy` and code, and a copy
 *   button for each command the remedy names. No wording here replaces the CLI's.
 * - The primary action becomes "Check again" after the first run: both commands are idempotent, so it
 *   re-runs connect (then the messaging step) with the fields as they are.
 * - Success (connect ready, and the messaging step ready when it applies) closes the dialog and hands the
 *   machine's id to `onAdded`. Anything else keeps it open with every row shown.
 * - While a phase runs the fields and the action are locked, a spinner marks the phase, and focus waits
 *   on the status line (it is restored to the action when the run ends). Close and Escape always work:
 *   the CLI finishes on its own, and a late answer after close changes nothing.
 * - Tab stays inside the dialog; Escape is the dialog's (it never reaches a dialog underneath); focus
 *   returns to whatever held it when the dialog opened. */
import { postJson } from './views/common.mjs';
import { machineName, machineFieldProblem, connectOutcome, registerReached, stepCommands,
  STEP_LABELS, CONNECT_STEPS, AWEB_STEPS } from '../../client/machine-contract.mjs';

export const addMachineCSS = `
/* The shared modal backdrop (.palette-overlay, shell.css), raised over the spawn dialog it can open from. */
.palette-overlay.machine-overlay { z-index:200; align-items:center; padding:24px 0; }
.machine-dialog { width:min(560px,calc(100vw - 32px)); max-height:88vh; overflow:auto; display:flex; flex-direction:column; gap:14px; padding:20px; box-sizing:border-box;
  border:1px solid var(--border); border-radius:12px; background:var(--surface); color:var(--fg); box-shadow:var(--shadow-popover); font-weight:normal; font-size:12.5px; line-height:normal; font-family:var(--ui-font,system-ui); }
.machine-dialog h2 { margin:0; font-size:15px; font-weight:700; }
.machine-dialog p { margin:0; line-height:1.5; overflow-wrap:anywhere; }
.machine-lede { color:var(--muted); }
.machine-fields { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:10px 12px; }
.machine-field { display:flex; flex-direction:column; gap:4px; min-width:0; color:var(--muted); font-size:12px; font-weight:600; }
.machine-field.wide { grid-column:1 / -1; }
.machine-dialog input.field { height:30px; padding:0 9px; border:1px solid var(--border); border-radius:7px; background:var(--surface); color:var(--fg); font-weight:normal; font-size:12.5px; line-height:normal; font-family:var(--mono,monospace); box-sizing:border-box; min-width:0; }
.machine-dialog input.field::placeholder { color:var(--muted); } /* the Folder hint is the field's only format note: --muted holds AA on --surface */
.machine-dialog input.field:focus-visible { outline:none; border-color:var(--accent); }
.machine-dialog input.field:disabled { background:var(--surface-2); color:var(--muted); }
.machine-dialog input.field[aria-invalid=true] { border-color:var(--danger); }
.machine-install-row { grid-column:1 / -1; display:flex; align-items:center; gap:8px; color:var(--fg); font-size:12.5px; }
.machine-install-row input { accent-color:var(--accent); margin:0; }
.machine-problem { color:var(--danger); font-size:12px; }
.machine-problem:empty { display:none; }
.machine-phase { display:flex; flex-direction:column; gap:6px; padding:10px 12px; border:1px solid var(--border); border-radius:8px; background:var(--surface-2); }
.machine-phase-head { display:flex; align-items:center; gap:8px; margin:0; color:var(--fg); font-size:12.5px; font-weight:650; }
.machine-phase-head .spinner { flex:none; width:12px; height:12px; box-sizing:border-box; border:2px solid var(--border); border-top-color:var(--accent); border-radius:50%; animation:oats-spin .7s linear infinite; }
.machine-steps { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:6px; }
.machine-step { display:grid; grid-template-columns:96px 78px minmax(0,1fr); gap:4px 10px; align-items:baseline; }
.machine-step-name { color:var(--fg); font-weight:600; }
.machine-step-state { justify-self:start; padding:0 6px; border-radius:5px; background:var(--tag-bg); color:var(--fg); font-size:11.5px; font-weight:600; white-space:nowrap; }
.machine-step[data-status=needs-human] .machine-step-state { background:var(--attn-bg); color:var(--warn); }
.machine-step[data-status=failed] .machine-step-state { background:var(--surface); color:var(--danger); }
.machine-step-body { display:flex; flex-direction:column; gap:3px; min-width:0; }
.machine-step-detail, .machine-step-code { color:var(--muted); }
.machine-step-code { font-family:var(--mono,monospace); font-size:11.5px; }
.machine-step-remedy { color:var(--fg); white-space:pre-line; } /* a readiness remedy is its lines joined by newlines */
.machine-commands { display:flex; flex-direction:column; gap:4px; }
.machine-command { display:flex; align-items:center; gap:8px; min-width:0; }
.machine-command code { min-width:0; overflow-wrap:anywhere; padding:2px 6px; border-radius:5px; background:var(--surface); color:var(--fg); font-weight:normal; font-size:11.5px; line-height:normal; font-family:var(--mono,monospace); }
.machine-status { color:var(--muted); }
.machine-status:focus { outline:none; }
.machine-dialog button { height:30px; padding:0 14px; border:1px solid var(--border); border-radius:7px; background:var(--surface); color:var(--fg); font:inherit; font-weight:600; cursor:pointer; }
.machine-dialog button:disabled { color:var(--muted); background:var(--surface-2); cursor:default; }
.machine-dialog button:focus-visible { background:var(--sel); }
.machine-dialog button.machine-copy { height:22px; padding:0 8px; font-size:11.5px; }
.machine-dialog .machine-primary:not(:disabled) { background:var(--primary-bg); color:var(--primary-fg); border-color:var(--primary-bg); }
.machine-dialog .machine-primary:not(:disabled):focus-visible { background:var(--primary-fg); color:var(--primary-bg); }
.machine-footer { display:flex; align-items:center; justify-content:flex-end; gap:8px; }
`;

/** Each step as its row names it. */
const STEP_NAMES = { ssh: 'SSH', oats: 'OATS', git: 'Git access', deployment: 'Deployment', register: 'Registration', readiness: 'Readiness',
  aw: 'aw', invite: 'Invite', join: 'Team' };
const PHASES = { connect: { title: 'This machine', steps: CONNECT_STEPS }, aweb: { title: 'Messaging (oats.aweb)', steps: AWEB_STEPS } };
let dialogs = 0;

function ensureCSS(doc) {
  if (!doc.head || doc.head.querySelector('style[data-add-machine]')) return;
  const style = doc.createElement('style'); style.dataset.addMachine = ''; style.textContent = addMachineCSS; doc.head.append(style);
}

/** Open the dialog. `ctx` is the view's (its `api`), `ws` the window's view id, `deployment` the local
 * deployment directory the CLI runs in (its folder name gives the Name default), `aweb` whether the messaging
 * step follows, `owns()` the opener's latest intent (its workspace and its own life): once it is false
 * the dialog closes at the next answer and starts nothing more. Returns `{ close }`. */
export function openAddMachineDialog(doc, { ctx, ws, deployment, aweb = false, owns = () => true, onAdded = () => {}, onClose = () => {} }) {
  ensureCSS(doc);
  const node = (tag, text, cls) => { const el = doc.createElement(tag); if (text !== undefined && text !== null) el.textContent = text; if (cls) el.className = cls; return el; };
  const returnTo = doc.activeElement;
  const n = ++dialogs, idOf = part => `machine-${part}-${n}`;
  let alive = true, running = false, ran = false, nameEdited = false, ticket = 0;

  const overlay = node('div', undefined, 'palette-overlay machine-overlay');
  const dialog = node('section', undefined, 'machine-dialog');
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
  const title = node('h2', 'Add a machine to this workspace'); title.id = idOf('title'); dialog.setAttribute('aria-labelledby', title.id);
  const lede = node('p', 'OATS connects to the machine over ssh with your own ssh config, sets this workspace up there and registers it here. It never asks for a password or a key.', 'machine-lede');

  const fields = node('div', undefined, 'machine-fields');
  const field = (label, cls, wide = false) => {
    const wrap = node('label', undefined, `machine-field${wide ? ' wide' : ''}`), input = node('input', undefined, `field ${cls}`);
    input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false;
    wrap.append(node('span', label), input); fields.append(wrap); return input;
  };
  const host = field('Machine', 'machine-host'), name = field('Name', 'machine-name'), folder = field('Folder on that machine', 'machine-folder', true);
  host.placeholder = 'ssh host alias, e.g. devbox';
  folder.placeholder = 'A path on that machine, starting with / or ~/';
  const installRow = node('label', undefined, 'machine-install-row'), install = node('input', undefined, 'machine-install');
  install.type = 'checkbox'; install.checked = true; installRow.append(install, node('span', 'Install OATS there if it\'s missing')); fields.append(installRow);
  const problem = node('p', '', 'machine-problem'); problem.id = idOf('problem'); problem.setAttribute('role', 'alert');

  const phases = node('div', undefined, 'machine-phases');
  const status = node('p', '', 'machine-status'); status.setAttribute('role', 'status'); status.tabIndex = -1;
  const footer = node('div', undefined, 'machine-footer');
  const cancel = node('button', 'Cancel', 'machine-cancel'); cancel.type = 'button';
  const primary = node('button', 'Add machine', 'machine-primary'); primary.type = 'button';
  footer.append(cancel, primary);
  dialog.append(title, lede, fields, problem, phases, status, footer); overlay.append(dialog); doc.body.append(overlay);

  const inputs = [host, name, folder, install];
  const values = () => ({ id: name.value.trim(), host: host.value.trim(), folder: folder.value.trim() });
  const fieldInput = { host, id: name, folder };
  function clearProblem() {
    problem.textContent = '';
    for (const input of [host, name, folder]) { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); }
  }
  function lock() {
    for (const input of inputs) input.disabled = running;
    primary.disabled = running;
    primary.textContent = ran ? 'Check again' : 'Add machine';
    cancel.textContent = ran ? 'Close' : 'Cancel';
    if (running) status.setAttribute('aria-busy', 'true'); else status.removeAttribute('aria-busy');
  }

  /** One phase's box: its heading (with a spinner while it runs) and its rows. */
  function phaseBox(phase) {
    let box = phases.querySelector(`[data-phase="${phase}"]`);
    if (!box) {
      box = node('div', undefined, 'machine-phase'); box.dataset.phase = phase;
      const head = node('h3', undefined, 'machine-phase-head'); head.append(node('span', PHASES[phase].title));
      box.append(head, node('ol', undefined, 'machine-steps'));
      phases.append(box);
    }
    return box;
  }
  function spin(phase, on) {
    const head = phaseBox(phase).querySelector('.machine-phase-head');
    head.querySelector('.spinner')?.remove();
    if (on) { const s = node('span', undefined, 'spinner'); s.setAttribute('aria-hidden', 'true'); head.prepend(s); }
  }
  function copyButton(command) {
    const b = node('button', 'Copy', 'machine-copy'); b.type = 'button'; b.setAttribute('aria-label', `Copy ${command}`);
    b.addEventListener('click', async () => {
      try { await doc.defaultView?.navigator?.clipboard?.writeText(command); b.textContent = 'Copied'; } catch { b.textContent = 'Copy failed'; }
    });
    return b;
  }
  function renderSteps(phase, steps) {
    const list = phaseBox(phase).querySelector('.machine-steps');
    list.replaceChildren(...steps.map(s => {
      const row = node('li', undefined, 'machine-step'); row.dataset.step = s.step; row.dataset.status = s.status;
      const body = node('div', undefined, 'machine-step-body');
      if (s.detail) body.append(node('p', s.detail, 'machine-step-detail'));
      if (s.remedy) {
        body.append(node('p', s.remedy, 'machine-step-remedy'));
        const commands = stepCommands(s.remedy);
        if (commands.length) {
          const box = node('div', undefined, 'machine-commands');
          for (const command of commands) { const line = node('div', undefined, 'machine-command'); line.append(node('code', command), copyButton(command)); box.append(line); }
          body.append(box);
        }
      }
      if (s.code && s.status !== 'ok' && s.status !== 'done') body.append(node('p', s.code, 'machine-step-code'));
      row.append(node('span', STEP_NAMES[s.step] || s.step, 'machine-step-name'), node('span', STEP_LABELS[s.status], 'machine-step-state'), body);
      return row;
    }));
  }
  /** What a phase answered, as `{ ok, ready, steps, error }`; a Desktop refusal or a lost answer is a failed phase with no rows. */
  async function phaseRun(phase, body, mine) {
    spin(phase, true);
    try {
      return connectOutcome(await postJson(ctx, `/api/server-connect?ws=${encodeURIComponent(ws)}`, { phase, ...body }), PHASES[phase].steps);
    } catch (error) {
      return { ok: false, ready: false, steps: [], error: { code: error?.code || 'E_REQUEST', message: error?.message || 'The Desktop could not run this step.' }, refused: true };
    } finally { if (mine()) spin(phase, false); }
  }
  function settle(text) {
    running = false; lock(); status.textContent = text;
    if (doc.activeElement === status || !dialog.contains(doc.activeElement)) primary.focus();
  }

  async function run() {
    if (alive && !owns()) { close({ restoreFocus: false }); return; }
    if (!alive || running) return;
    clearProblem();
    const v = values(), bad = machineFieldProblem(v);
    if (bad) {
      const input = fieldInput[bad.field];
      problem.textContent = bad.text; input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', problem.id); input.focus();
      return;
    }
    // This run's answers count only while it is the latest run of an open dialog whose opener still owns it.
    const mine = (t => () => {
      if (alive && !owns()) close({ restoreFocus: false });
      return alive && t === ticket;
    })(++ticket);
    running = true; ran = true; lock();
    status.textContent = `Connecting ${v.id}… This can take a few minutes when OATS is installed there.`;
    status.focus();
    const connect = await phaseRun('connect', { id: v.id, host: v.host, folder: v.folder, installOats: install.checked }, mine);
    if (!mine()) return;
    if (connect.refused) { phases.querySelector('[data-phase="connect"]')?.remove(); settle(connect.error.message); return; }
    renderSteps('connect', connect.steps);
    phases.querySelector('[data-phase="aweb"]')?.remove();
    if (!connect.ok) { settle(`${connect.error.message} (${connect.error.code})`); return; }
    let messaging = null;
    if (aweb && registerReached(connect.steps)) {
      status.textContent = `Joining ${v.id} to this workspace's team…`;
      messaging = await phaseRun('aweb', { id: v.id }, mine);
      if (!mine()) return;
      if (messaging.refused) { phases.querySelector('[data-phase="aweb"]')?.remove(); settle(messaging.error.message); return; }
      renderSteps('aweb', messaging.steps);
      if (!messaging.ok) { settle(`${messaging.error.message} (${messaging.error.code})`); return; }
    }
    if (connect.ready && (!aweb || messaging?.ready)) { close({ restoreFocus: false }); if (owns()) onAdded(v.id); return; }
    settle('Some steps need you: do what each one says, then Check again.');
  }

  function close({ restoreFocus = true } = {}) {
    if (!alive) return;
    alive = false; ticket++; overlay.remove();
    if (restoreFocus && returnTo?.isConnected) returnTo.focus();
    onClose();
  }

  host.addEventListener('input', () => { if (!nameEdited) name.value = machineName(host.value.trim(), deployment); });
  name.addEventListener('input', () => { nameEdited = true; });
  primary.addEventListener('click', () => { void run(); });
  cancel.addEventListener('click', () => close());
  overlay.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'Enter' && event.target?.tagName === 'INPUT' && event.target.type === 'text') { event.preventDefault(); void run(); return; }
    if (event.key !== 'Tab') return;
    const all = [...dialog.querySelectorAll('input,button')].filter(el => !el.disabled && el.tabIndex >= 0);
    if (!all.length) { event.preventDefault(); return; }
    if (event.shiftKey && (doc.activeElement === all[0] || doc.activeElement === status)) { event.preventDefault(); all.at(-1).focus(); }
    else if (!event.shiftKey && (doc.activeElement === all.at(-1) || doc.activeElement === status)) { event.preventDefault(); all[0].focus(); }
  });
  lock(); host.focus();
  return { close };
}
