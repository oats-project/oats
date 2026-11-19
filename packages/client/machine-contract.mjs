/* oats desktop — a workspace's own machines (#517): the gates, the Add a machine Name default and field
   rules, and the step rows of `oats server connect --json` and `oats aweb connect --json` as the CLI
   sends them (docs/desktop-cli-api.md; interface §2 and §4).

   Step rows are data: `detail` and `remedy` are shown as the CLI words them, never rewritten. A row
   the contract does not allow is dropped, never guessed.

   Pure data; no node: imports so the renderer can share it with the server. */

/** The kernel's own rules (lib/servers.mjs): a registration id, and an OpenSSH host alias or name. */
export const MACHINE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SSH_HOST = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FOLDER_MAX = 1024;

export const CONNECT_STEPS = Object.freeze(['ssh', 'oats', 'git', 'deployment', 'register', 'readiness']);
export const AWEB_STEPS = Object.freeze(['aw', 'invite', 'join', 'readiness']);
/** Each status, as its row says it. */
export const STEP_LABELS = Object.freeze({ ok: 'ok', done: 'done', 'needs-human': 'needs you', skipped: 'waiting', failed: 'failed' });

const text = value => typeof value === 'string' && value.length > 0;
const features = cli => (cli?.ok && Array.isArray(cli.features) ? cli.features : []);

/** A workspace's own machines and Add a machine: kernel features servers-per-workspace and server-connect. */
export function machinesGated(cli) {
  const f = features(cli);
  return f.includes('servers-per-workspace') && f.includes('server-connect');
}
/** The messaging step (`oats aweb connect`) also needs capability-route. */
export function awebConnectGated(cli) {
  return machinesGated(cli) && features(cli).includes('capability-route');
}

const basename = dir => String(dir || '').replace(/\/+$/, '').split('/').pop() || '';
/** The default Name: `<host>-<this deployment dir basename>`, made a valid registration id. */
export function machineName(host, deploymentDir) {
  if (!text(host)) return '';
  return `${host}-${basename(deploymentDir)}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-')
    .replace(/^-+/, '').slice(0, 64).replace(/-+$/, '');
}

/** The first field that the kernel would refuse, as `{ field, text }`, or null. */
export function machineFieldProblem({ id, host, folder }) {
  if (!text(host)) return { field: 'host', text: 'Type the machine\'s ssh host alias.' };
  if (!SSH_HOST.test(host)) return { field: 'host', text: 'Use an ssh host alias or host name from your ssh config (no user@, no options).' };
  if (!text(id)) return { field: 'id', text: 'Give the machine a name.' };
  if (!MACHINE_ID.test(id)) return { field: 'id', text: 'A name is lowercase letters, digits and dashes, up to 64 characters.' };
  if (!text(folder) || !(folder.startsWith('/') || folder.startsWith('~/')) || folder.length > FOLDER_MAX || /[\u0000-\u001f\u007f]/.test(folder)) {
    return { field: 'folder', text: 'The folder is a path on that machine, starting with / or ~/.' };
  }
  return null;
}

const STATUSES = new Set(Object.keys(STEP_LABELS));
/** One step row, or null when the contract does not allow it. Optional text fields are kept only as text. */
function stepRow(row, names) {
  if (!row || typeof row !== 'object' || !names.includes(row.step) || !STATUSES.has(row.status)) return null;
  const out = { step: row.step, status: row.status };
  for (const key of ['code', 'detail', 'remedy', 'hint']) if (text(row[key])) out[key] = row[key];
  return out;
}
const stepRows = (value, names) => (Array.isArray(value) ? value.slice(0, 32) : []).map(row => stepRow(row, names)).filter(Boolean);

/** A connect envelope (`server connect` or `aweb connect`) as `{ ok, ready, id, steps, error }`.
 * A failed run's steps are `error.details.steps` (the steps so far, the failed one last). */
export function connectOutcome(envelope, names = CONNECT_STEPS) {
  if (envelope?.ok === true && envelope.result && typeof envelope.result === 'object') {
    const r = envelope.result;
    return { ok: true, ready: r.ready === true, id: text(r.id) ? r.id : text(r.server) ? r.server : null, steps: stepRows(r.steps, names), error: null };
  }
  const error = envelope?.error;
  return { ok: false, ready: false, id: null, steps: stepRows(error?.details?.steps, names),
    error: { code: text(error?.code) ? error.code : 'E_CLI_PROTOCOL', message: text(error?.message) ? error.message : 'oats did not answer as expected' } };
}

/** Whether connect reached `register` (it registered the machine, now or before). */
export function registerReached(steps) {
  return (Array.isArray(steps) ? steps : []).some(s => s?.step === 'register' && (s.status === 'ok' || s.status === 'done'));
}

/** The commands a remedy names: its backticked spans, in order. */
export function stepCommands(remedy) {
  if (!text(remedy)) return [];
  return [...remedy.matchAll(/`([^`\n]+)`/g)].map(m => m[1].trim()).filter(Boolean);
}

/** Why a window offers no remote machine (`machineScope` in packages/desktop/server/oats-web.mjs), one line each. */
export const MACHINE_SCOPE_REASONS = Object.freeze({
  'no-key': 'This deployment reports no workspace key, so no other machine can be matched to it.',
  'no-local': 'This workspace has no deployment on this computer, so machines are added from one that does.',
});

/** How a consumer follows the server's backfill: the first re-read after BACKFILL_POLL_MS, each next one
 * 1.5 times later, up to BACKFILL_POLL_MAX_MS apart. */
export const BACKFILL_POLL_MS = 2000;
export const BACKFILL_POLL_MAX_MS = 15_000;
/** Consecutive failed reads after which a consumer stops following (the server is gone or refusing). */
export const BACKFILL_READ_FAILURES = 5;
/** Read the list again while the server's answers say `backfilling` (packages/desktop/server/machines.mjs): `read()` answers
 * the list, `use(answer)` takes each, `owns()` is the consumer's latest intent (false: stop, nothing used).
 * It follows until an answer is settled: the backfill itself is bounded (each check has its own deadline),
 * so the follow ends with it, at most one read per BACKFILL_POLL_MAX_MS. It stops early when the owner
 * moves on, on stop(), or after BACKFILL_READ_FAILURES failed reads in a row. Returns stop(). */
export function followBackfill({ read, use, owns = () => true, delay = BACKFILL_POLL_MS, maxDelay = BACKFILL_POLL_MAX_MS, timers = globalThis }) {
  let stopped = false, timer = null, wait = delay, failures = 0;
  const next = () => {
    if (stopped) return;
    timer = timers.setTimeout(async () => {
      timer = null;
      let answer;
      try { answer = await read(); failures = 0; }
      catch { if (++failures < BACKFILL_READ_FAILURES) { wait = Math.min(maxDelay, wait * 1.5); next(); } return; }
      if (stopped || !owns()) return;
      use(answer);
      if (answer?.backfilling === true) { wait = Math.min(maxDelay, wait * 1.5); next(); }
    }, wait);
  };
  next();
  return () => { stopped = true; if (timer !== null) timers.clearTimeout(timer); timer = null; };
}
