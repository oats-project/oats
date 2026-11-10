/** Sync for a workspace-v2 deployment. `oats sync` resolves every
 * `packages:` entry, fetches it and writes the lock; declaring a package is
 * the trust decision, so there is nothing to approve (packages-no-approval).
 * The header says whether the lock is current. A sync that did not finish,
 * or that reports problems, opens a sheet that says so in plain words; the
 * kernel's own code and message stay behind Details. */
import { postJson, wsQuery, workspaceGeneration } from './views/common.mjs';
import { iconElement } from './shell-icons.mjs';
import { createDeploymentScopeLine } from './deployment-scope-line.mjs';

export const syncCSS = `
.ws-sync { display:flex; align-items:center; gap:10px; min-width:0; flex:none; }
.ws-sync-state { color:var(--muted); font-size:12px; font-weight:600; white-space:nowrap; }
.ws-sync-state.warn { color:var(--warn); }
.ws-sync-state:empty { display:none; }
.oats-view .ws-sync button.ws-sync-run { display:inline-flex; align-items:center; gap:6px; height:28px; min-height:28px; padding:0 10px; border-radius:7px; font-size:12px; font-weight:600; white-space:nowrap; }
.ws-sync-sheet { position:fixed; inset:0; z-index:40; display:grid; place-items:center; padding:24px; background:var(--scrim); }
.ws-sync-sheet[hidden] { display:none; }
.ws-sync-dialog { width:min(560px,100%); max-height:88vh; display:flex; flex-direction:column; border:1px solid var(--border); border-radius:12px; background:var(--surface); color:var(--fg); box-shadow:var(--shadow-modal); }
.ws-sync-head { display:flex; align-items:center; gap:10px; min-height:52px; padding:0 16px 0 20px; border-bottom:1px solid var(--border); }
.ws-sync-head h2 { flex:1; margin:0; font-size:15px; font-weight:700; }
.ws-sync-dialog > .ws-sync-scope { padding:8px 20px 0; }
.ws-sync-body { overflow:auto; padding:16px 20px; display:grid; gap:10px; }
.ws-sync-body > p { margin:0; color:var(--muted); font-size:12.5px; line-height:1.55; overflow-wrap:break-word; }
.ws-sync-body > p.ws-sync-lead { color:var(--fg); font-size:13px; }
.ws-sync-body > p.ws-sync-lead.error { color:var(--danger); }
.ws-sync-details { border:0; background:none; padding:0; justify-self:start; font:inherit; font-size:12px; color:var(--muted); text-decoration:underline; text-underline-offset:2px; cursor:pointer; }
.ws-sync-details:hover { color:var(--fg); }
.ws-sync-details[hidden], .ws-sync-detail[hidden] { display:none; }
.ws-sync-body > p.ws-sync-detail { padding:8px 10px; border-radius:6px; background:var(--surface-2); font-size:11.5px; overflow-wrap:anywhere; }
.ws-sync-foot { display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:12px 20px; border-top:1px solid var(--border); }
.ws-sync-foot .spacer { flex:1; }
.ws-sync-head .icon-button { display:grid; place-items:center; width:28px; height:28px; padding:0; border:0; border-radius:7px; background:none; color:var(--muted); cursor:pointer; }
.ws-sync-head .icon-button:hover { background:var(--surface-2); color:var(--fg); }
`;

let sheets = 0; // unique dialog ids per mount
const list = value => Array.isArray(value) ? value : [];
const short = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) ? value.slice(0, 7) : value;
export const reasonText = reason => reason ? [reason.code, reason.message].filter(v => typeof v === 'string' && v).join(': ') : '';

/** What a sync refusal means, in plain words. The kernel's message (which
 * package, which path) is shown under Details. */
const SYNC_PROBLEMS = {
  // The family's meaning: true for every case, a tag that moved and a newer kernel's `why` included (#1765).
  E_PACKAGE_INTEGRITY: 'A package doesn’t match what the workspace file or the lock records for it. Check its version in the workspace file and see Details, then sync again.',
  E_PACKAGE_MISSING: 'A package the workspace declares couldn’t be found. Check its version in the workspace file, then sync again.',
  E_REMOTE_UNREADABLE: 'A repository the workspace uses couldn’t be read. Check your network and access, then sync again.',
  E_WORKSPACE_SCHEMA: 'The workspace file has a mistake OATS can’t read. Fix it, then sync again.',
  E_LOCK_SCHEMA: 'The lock file couldn’t be read. Sync again; if it keeps failing, see Details.',
  E_LOCAL_MISSING: 'This deployment is missing its oats-local.yaml. Onboard the workspace again.',
  E_SYNC_BUSY: 'A sync is already running for this deployment. Wait for it to finish.',
  E_WORKSPACE_UNKNOWN: 'This deployment isn’t available anymore. Choose it again from the workspace menu.',
  E_WORKSPACE_FEATURE: 'Syncing needs a newer OATS. Update OATS, then try again.',
  E_CLI_UNAVAILABLE: 'Choose a compatible OATS CLI first.',
  E_CLI_TIMEOUT: 'OATS took too long to sync. Try again.',
};
/** E_PACKAGE_INTEGRITY's cases the kernel names in `details.why` (docs/packages.md, `oats sync`), each worded
 * for what it is; any other `why`, or none, keeps the family's meaning above. */
const LOCK_EDITED = 'The lock’s record of a package doesn’t match what that package ships: the lock was edited. Remove the package’s entry from the lock file, then sync again.';
const INTEGRITY_CASES = new Map([
  ['branch', 'A package in the workspace file is pinned to a branch, which can move. Pin a tag or a full commit instead, then sync again.'],
  ['package-id', 'A package’s manifest names a different package id than the one the workspace file pins it under. Change that pin as Details says, then sync again.'],
  ['capabilities', LOCK_EDITED],
  ['souls', LOCK_EDITED],
]);
export function syncProblem(reason) {
  const code = typeof reason?.code === 'string' ? reason.code : 'E_CLI_FAILED';
  const message = typeof reason?.message === 'string' ? reason.message.trim() : '';
  const text = (code === 'E_PACKAGE_INTEGRITY' && INTEGRITY_CASES.get(reason?.why)) || SYNC_PROBLEMS[code];
  return { text: text ?? 'OATS couldn’t finish the sync. Try again, or see Details.', code, detail: message ? `${code} · ${message}` : code };
}

/** Header state from workspace status: the lock is out of date, or current. */
export function syncStateText(status) {
  if (list(status?.unsynced).length || list(status?.stale).length) return { text: 'Lock out of date', warn: true };
  if (status) return { text: 'Lock current', warn: false };
  return { text: '', warn: false };
}

export function createWorkspaceSync(host, { ctx, onSynced }) {
  const doc = host.ownerDocument;
  const node = (tag, value, cls) => { const el = doc.createElement(tag); if (value !== undefined && value !== null) el.textContent = value; if (cls) el.className = cls; return el; };
  let alive = true, serial = 0, busy = false, status = null, available = false;
  host.className = 'ws-sync';
  const state = node('span', '', 'ws-sync-state'); state.setAttribute('role', 'status');
  const sync = node('button', 'Sync', 'act ws-sync-run'); sync.type = 'button';
  sync.title = 'Run oats sync: read the workspace, fetch its packages and write the lock';
  host.append(state, sync);

  // The result sheet lives beside the view, not inside the header strip.
  const sheet = node('div', null, 'ws-sync-sheet'); sheet.hidden = true;
  const dialog = node('section', null, 'ws-sync-dialog'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
  const titleId = `ws-sync-title-${++sheets}`;
  dialog.setAttribute('aria-labelledby', titleId);
  const head = node('header', null, 'ws-sync-head'); const heading = node('h2', 'Sync'); heading.id = titleId;
  const close = node('button', null, 'icon-button'); close.type = 'button'; close.setAttribute('aria-label', 'Close'); close.append(iconElement(doc, 'close', { size: 14 }));
  head.append(heading, close);
  const body = node('div', null, 'ws-sync-body');
  const foot = node('footer', null, 'ws-sync-foot');
  const done = node('button', 'Close', 'act'); done.type = 'button';
  foot.append(node('span', null, 'spacer'), done);
  // #482: in a view of two or more deployments, the deployment a sync runs on (the primary).
  const scope = createDeploymentScopeLine(doc, { className: 'ws-sync-scope' });
  dialog.append(head, scope.element, body, foot); sheet.append(dialog);
  (host.closest('.oats-view') || doc.body).append(sheet);

  const owns = (id, gen) => alive && id === serial && gen === workspaceGeneration();
  function paint() {
    const view = syncStateText(status);
    // Only an out-of-date lock is said here; a current lock is shown on Setup (This computer).
    state.textContent = view.warn ? view.text : ''; state.classList.toggle('warn', view.warn);
    sync.disabled = busy || !available;
    sync.lastChild.textContent = busy ? 'Syncing…' : 'Sync';
  }
  function closeSheet(restore = true) {
    sheet.hidden = true; body.replaceChildren();
    if (restore) sync.focus({ preventScroll: true });
  }
  /** One plain lead sentence, what changed, and each problem with its kernel text behind Details. */
  function openSheet({ title, lead, error = false, detail = '', report = null }) {
    heading.textContent = title; body.replaceChildren();
    body.append(node('p', lead, `ws-sync-lead${error ? ' error' : ''}`));
    for (const change of list(report?.changes)) body.append(node('p', `${change.id}: ${change.from ?? 'new'} → ${change.to ?? 'removed'}${change.commit ? ` @ ${short(change.commit)}` : ''}`));
    for (const problem of list(report?.problems)) body.append(node('p', problem.message || problem.code || ''));
    if (detail) {
      const toggle = node('button', 'Details', 'ws-sync-details'); toggle.type = 'button'; toggle.setAttribute('aria-expanded', 'false');
      const text = node('p', detail, 'ws-sync-detail'); text.hidden = true; text.id = `${titleId}-detail`; toggle.setAttribute('aria-controls', text.id);
      toggle.addEventListener('click', () => { text.hidden = !text.hidden; toggle.setAttribute('aria-expanded', String(!text.hidden)); toggle.textContent = text.hidden ? 'Details' : 'Hide details'; });
      body.append(toggle, text);
    }
    sheet.hidden = false; done.focus({ preventScroll: true });
  }
  function setBusy(value) { busy = value; dialog.setAttribute('aria-busy', String(value)); paint(); }
  async function request(payload) {
    const id = ++serial, gen = workspaceGeneration();
    setBusy(true);
    let result;
    try { result = await postJson(ctx, `/api/workspace-sync${wsQuery()}`, payload); }
    catch (error) { result = { status: 'unavailable', reason: { code: 'E_CLI_FAILED', message: error?.message || '' } }; }
    if (!owns(id, gen)) return null;
    setBusy(false);
    return result;
  }
  async function runSync() {
    if (busy || !available) return;
    state.textContent = 'Syncing…'; state.classList.remove('warn');
    const result = await request({ action: 'sync' });
    if (!result) return;
    if (result.status === 'ok') {
      onSynced?.(result); paint();
      if (list(result.report?.problems).length) openSheet({ title: 'Synced, with problems', lead: 'The lock was written, but OATS reported problems with this workspace:', report: result.report });
      return;
    }
    paint();
    const problem = syncProblem(result.reason);
    openSheet({ title: 'Sync didn’t finish', lead: problem.text, error: true, detail: problem.detail });
  }
  sync.addEventListener('click', () => void runSync());
  done.addEventListener('click', () => closeSheet());
  close.addEventListener('click', () => closeSheet());
  sheet.addEventListener('mousedown', event => { if (event.target === sheet) closeSheet(); });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeSheet(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('button:not([disabled])')].filter(el => !el.hidden);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  paint();
  return {
    /** status: the observed workspace status (or null); canSync: v2 CLI + local deployment. */
    update({ status: next = null, canSync = false } = {}) { status = next; available = !!canSync; paint(); },
    reset() { serial++; busy = false; status = null; available = false; closeSheet(false); paint(); },
    get busy() { return busy; },
    dispose() { alive = false; serial++; scope.dispose(); sheet.remove(); },
  };
}
