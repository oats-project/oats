// Spec C: Cmd-Enter spawns instantly. The dialog hands a confirmed press to the background-spawn
// store (renderer/spawn-jobs.mjs) and closes; the store runs prepare → apply on the real broker,
// owns the pending roster row and the outcome notice, and keeps the draft for Reopen spawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountSpawn, settle, deferred, kernel, ROOT, DEPLOYMENT, catalogAgents, kernelPreviewName } from './helpers/spawn-dialog-host.mjs';
import { cli as CLI } from './helpers/spawn-preview-fixture.mjs';
import { createSpawnPreviewBoundary, createSpawnPreviewFlights } from '../../client/spawn-preview.mjs';
import { createSpawnApplyBoundary } from '../../client/spawn-apply.mjs';
import { creation } from './helpers/spawn-apply-fixture.mjs';
import { createSpawnJobs, pendingPlacement, DRIFT_TEXT, SPAWN_STORAGE_KEY } from '../renderer/spawn-jobs.mjs';
import { flagIgnored, EXAMPLE_WARNING_TWO, EXAMPLE_WARNING_ONE } from './helpers/launch-prompt-fixture.mjs';

const created = (name = 'preview-worktree-purpose') => kernel(name).result;
const receipt = (preview = created(), changes = {}) => ({ started: true, envelope: { schemaVersion: 1, ok: true, result: creation(preview, changes) } });
const failure = (code, started = false) => ({ started, envelope: { schemaVersion: 1, ok: false, error: { code, message: `kernel says ${code}` } } });
const realRow = (preview = created(), extra = {}) => {
  const d = preview.decision;
  return { instance: d.instance, agent: 'release-manager', agentsRoot: ROOT, home: d.home, running: true, tmux: { session: 'oats', window: d.instance }, ...extra };
};
const reopenButton = notice => notice.options.buttons?.find(b => b.label === 'Reopen spawn');

test('a valid press with a settled preview closes the dialog at once; the pending row carries the kernel’s name; the real row replaces it', async t => {
  const u = await mountSpawn(t, { jobs: true, apply: () => receipt() });
  await u.open(); await u.type('.fpurpose', 'api-v2'); await u.type('.ftask', 'Cut 3.2');
  u.q('.fspawn').click();
  assert.equal(u.dialog(), null, 'closed in the same task as the press (no await before the handoff)');
  const [row] = u.jobs.rows('northwind');
  assert.deepEqual(u.followed, [row.id], 'Spec E: after the dialog closed, the shell reveals its pending row and follows it');
  assert.equal(row.instance, created().decision.instance); assert.equal(row.home, created().decision.home);
  assert.equal(row.pending, 'spawning'); assert.equal(row.agent, 'release-manager'); assert.equal(row.agentsRoot, ROOT);
  await settle(20);
  assert.deepEqual(u.spawns().map(b => b.action), ['prepare', 'apply']);
  assert.equal(u.spawns()[0].task, 'Cut 3.2');
  assert.equal(u.jobs.rows('northwind').length, 1, 'created but not yet in the roster: still “Spawning…”');
  u.jobs.observe('northwind', [realRow()]);
  assert.equal(u.jobs.rows('northwind').length, 0, 'the roster reports it: the real row replaces the pending one');
  assert.equal(u.notified.length, 1, 'handed to the shell (spawn-follow.mjs: taken there, or its row says New)');
  assert.equal(u.notified[0].row.instance, created().decision.instance);
  assert.deepEqual(u.notified[0].arrival, { id: row.id, complete: true }, 'the press it belongs to, and a complete spawn');
  assert.deepEqual(u.opens, [], 'the view opens nothing itself'); assert.equal(u.jobs.size(), 0);
});

test('Cmd-Enter hands off the same way; two presses in one task start one spawn', async t => {
  const u = await mountSpawn(t, { jobs: true, apply: () => receipt() });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  const button = u.q('.fspawn'), ta = u.q('.ftask'); ta.focus();
  ta.dispatchEvent(new u.dom.window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }));
  button.click(); button.click();
  assert.equal(u.dialog(), null); assert.equal(u.jobs.size(), 1);
  await settle(20);
  assert.deepEqual(u.spawns().map(b => b.action), ['prepare', 'apply'], 'one prepare, one apply');
});

test('a press that waits for its preview (“Checking…”) closes as soon as the preview settles, not after apply', async t => {
  let gate = null;
  const applied = deferred();
  const u = await mountSpawn(t, { jobs: true, previewGate: () => gate?.promise, spawnGate: body => body.action === 'apply' ? applied.promise : undefined, apply: () => receipt() });
  await u.open(); await u.type('.fpurpose', 'api');
  gate = deferred();
  await u.type('.fpurpose', 'api-v2');
  u.q('.fspawn').click(); await settle();
  assert.ok(u.dialog(), 'held while the preview for these values is still reading'); assert.equal(u.jobs.size(), 0);
  gate.resolve(); await settle(20);
  assert.equal(u.dialog(), null, 'closed once the preview settled'); assert.equal(u.jobs.size(), 1);
  assert.deepEqual(u.spawns().map(b => b.action), ['prepare', 'apply'], 'apply still in flight after the close');
  applied.resolve(); await settle(20);
});

test('the dialog stays open for a refusal: nothing is handed off', async t => {
  const u = await mountSpawn(t, { jobs: true, previewName: () => 'preview-soul-unknown' });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  u.q('.fspawn').click(); await settle(10);
  assert.ok(u.dialog()); assert.equal(u.jobs.size(), 0); assert.deepEqual(u.spawns(), []);
});

test('a refused apply removes the row, says why with Reopen spawn, and Reopen restores the whole draft', async t => {
  const u = await mountSpawn(t, { jobs: true, apply: () => failure('E_BRANCH_EXISTS') });
  await u.open(); await u.type('.fpurpose', 'api-v2'); await u.type('.ftask', 'Cut 3.2');
  await u.change('.fruntime', 'claude'); await u.type('.fmodel', 'opus-custom');
  u.q('.fspawn').click(); await settle(20);
  assert.equal(u.dialog(), null);
  assert.deepEqual(u.jobs.rows('northwind'), [], 'the pending row is gone');
  assert.equal(u.notices.length, 1);
  const [notice] = u.notices;
  assert.equal(notice.options.sticky, true); assert.equal(notice.options.group, 'spawn-failed');
  assert.doesNotMatch(notice.message, /changed since you last looked/, 'E_BRANCH_EXISTS keeps its own words');
  assert.doesNotMatch(notice.message, /E_[A-Z]/);
  assert.equal(reopenButton(notice).ariaLabel, `Reopen spawn for ${created().decision.instance}`);
  await reopenButton(notice).activate(); await settle(20);
  assert.equal(notice.shown, false, 'Reopen dismisses the notice'); assert.equal(u.jobs.size(), 0, 'the draft moved back into the dialog');
  assert.ok(u.dialog(), 'the dialog is open again for that soul');
  assert.equal(u.q('.fpurpose').value, 'api-v2'); assert.equal(u.q('.ftask').value, 'Cut 3.2');
  assert.equal(u.q('.fruntime').value, 'claude'); assert.equal(u.q('.fmodel').value, 'opus-custom');
});

test('only a kernel decision drift (E_DECISION_STALE) reads “These values changed…”; name and placement conflicts keep their own words', async t => {
  for (const [code, drift] of [['E_DECISION_STALE', true], ['E_INSTANCE_NAME_TAKEN', false], ['E_PLACEMENT_TAKEN', false], ['E_IDEMPOTENCY_CONFLICT', false]]) {
    await t.test(code, async t => {
      const u = await mountSpawn(t, { jobs: true, apply: () => failure(code, true) });
      await u.open(); await u.type('.fpurpose', 'api-v2');
      u.q('.fspawn').click(); await settle(20);
      assert.equal(u.notices.length, 1);
      if (drift) assert.equal(u.notices[0].message, DRIFT_TEXT);
      else assert.notEqual(u.notices[0].message, DRIFT_TEXT);
      assert.ok(reopenButton(u.notices[0]));
    });
  }
});

test('#1246 D1: a press 90 s after its preview prepares from the held answer, with no second kernel preview; a drift the kernel finds at apply reads as drifted, never refused or unknown', async t => {
  let time = 0, atApply = null, u;
  u = await mountSpawn(t, { jobs: true, previewNow: () => time, spawnGate: body => { if (body.action === 'apply') atApply = u.kernelPreviews(); },
    apply: () => failure('E_DECISION_STALE', true) });
  await u.open(); await u.type('.fpurpose', 'api-v2'); await settle(10);
  const reads = u.kernelPreviews();
  time += 90_000; // past the dialog's 60 s, within PREPARE_REUSE_MS
  u.q('.fspawn').click(); await settle(20);
  assert.deepEqual(u.spawns().map(b => b.action), ['prepare', 'apply']);
  assert.equal(atApply, reads, 'prepare took the held preview: no kernel preview between the press and the apply');
  assert.equal(u.applied.length, 1, 'the apply ran, bound to the held decision');
  assert.deepEqual(u.jobs.rows('northwind'), [], 'nothing was created: the row goes');
  assert.equal(u.notices.length, 1);
  assert.equal(u.notices[0].message, DRIFT_TEXT, 'the drifted reading, with its own words');
  assert.match(u.notices[0].options.detail, /^E_DECISION_STALE/);
  assert.ok(reopenButton(u.notices[0]), 'Reopen spawn reads the values again');
});

test('a decision that moved between the press and prepare is never applied: drift wording, Reopen', async t => {
  let drift = false;
  const u = await mountSpawn(t, { jobs: true, previewName: () => drift ? 'preview-after-apply' : 'preview-worktree-purpose' });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  drift = true; u.q('.fspawn').click(); await settle(20);
  assert.deepEqual(u.spawns().map(b => b.action), ['prepare']); assert.equal(u.applied.length, 0);
  assert.equal(u.notices[0].message, DRIFT_TEXT);
});

test('an unknown outcome keeps the row (“Outcome unknown”) and says so once; Check result asks on the same intent', async t => {
  let n = 0;
  const u = await mountSpawn(t, { jobs: true, apply: () => ++n === 1 ? failure('E_CLI_TIMEOUT', true) : receipt() });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  u.q('.fspawn').click(); await settle(20);
  const [row] = u.jobs.rows('northwind');
  assert.equal(row.pending, 'unknown'); assert.equal(u.notices.length, 1);
  assert.match(u.notices[0].message, /couldn’t confirm whether the instance was created/);
  u.jobs.observe('northwind', []); u.jobs.observe('northwind', []);
  assert.equal(u.notices.length, 1, 'said once'); assert.equal(u.jobs.rows('northwind').length, 1, 'never silently disappears');
  await u.jobs.check(row.id); await settle(10);
  assert.deepEqual(u.spawns().map(b => b.action), ['prepare', 'apply', 'result', 'apply']);
  assert.equal(u.applied[0].key, u.applied[1].key, 'the same idempotency key');
  u.jobs.observe('northwind', [realRow()]);
  assert.equal(u.jobs.rows('northwind').length, 0); assert.equal(u.notified.length, 1);
});

test('the draft survives while the spawn runs, and a new spawn of the same soul reads a fresh preview', async t => {
  const hold = deferred();
  const u = await mountSpawn(t, { jobs: true, spawnGate: body => body.action === 'apply' ? hold.promise : undefined, apply: () => receipt() });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  u.q('.fspawn').click(); await settle(10);
  const before = u.previews().length;
  await u.open(); await settle(10);
  assert.ok(u.dialog(), 'a new spawn of the same soul may open');
  assert.equal(u.q('.fpurpose').value, '', 'a fresh dialog, not the in-flight draft');
  assert.ok(u.previews().length > before, 'its name comes from a fresh preview');
  hold.resolve(); await settle(20);
  assert.equal(u.jobs.size(), 1);
});

// ── the store alone ────────────────────────────────────────────────────────

const decision = { instance: 'dev-x', home: '/d/agents/dev/instances/dev-x', revision: 'r1' };
function store(overrides = {}) {
  const posted = [], notes = [], spawned = [];
  const s = createSpawnJobs({
    post: async (_ws, body) => { posted.push(body); throw Object.assign(Error('offline'), { code: 'E_BACKEND_UNREACHABLE' }); },
    notify: (message, options = {}) => { const n = { message, options, shown: true }; notes.push(n); return { dismiss() { n.shown = false; }, get shown() { return n.shown; } }; },
    notifySpawned: row => spawned.push(row), currentWorkspace: () => 'A', ...overrides });
  return { s, posted, notes, spawned };
}
const spec = (extra = {}) => ({ token: {}, workspace: 'A', soul: { name: 'dev', agentsRoot: '/d/agents' }, selector: { soul: 'dev', agentsRoot: '/d/agents' },
  input: { action: 'prepare', selector: { soul: 'dev', agentsRoot: '/d/agents' }, choices: {} }, decision, draft: { purpose: 'x', task: 'do' }, ...extra });

test('store: one press token starts one spawn; a second spawn of the same soul waits until the first is no longer in flight (Spec D)', async () => {
  const { s, posted } = store();
  const press = spec();
  const first = s.submit(press);
  assert.ok(first); assert.equal(s.submit(press), null, 'the same press never starts a second spawn');
  assert.deepEqual(s.inFlight('A', press.soul), { id: first, instance: 'dev-x', home: decision.home });
  assert.equal(s.submit(spec()), null, 'a new press of the same soul is refused while one is in flight');
  assert.ok(s.submit(spec({ soul: { name: 'other', agentsRoot: '/d/agents' } })), 'another soul is not blocked');
  await settle(4);
  assert.equal(s.inFlight('A', press.soul), null, 'settled (refused here): no longer in flight');
  assert.ok(s.submit(spec()), 'a new press of the same soul is allowed again');
  await settle(4);
  assert.equal(posted.filter(b => b.action === 'prepare').length, 3);
});

test('store: a failure before submit is a refusal whose draft Reopen restores; dismissing the notice forgets it', async () => {
  const reopened = [];
  const { s, notes } = store({ reopen: job => reopened.push(job) });
  s.submit(spec()); await settle(4);
  assert.equal(s.rows('A').length, 0); assert.equal(s.size(), 1, 'the store keeps the draft until Reopen or dismissal');
  assert.match(notes[0].message, /Nothing was created/);
  notes[0].options.onDismiss(); assert.equal(s.size(), 0);
  s.submit(spec()); await settle(4);
  await notes[1].options.buttons[0].activate();
  assert.equal(reopened.length, 1); assert.deepEqual(reopened[0].draft, { purpose: 'x', task: 'do' });
});

test('store: an outcome is held while another workspace is on screen and posted on return; a cleared failure is posted again', async () => {
  let ws = 'B';
  const { s, notes } = store({ currentWorkspace: () => ws });
  s.submit(spec()); await settle(4);
  assert.equal(notes.length, 0, 'held'); assert.equal(s.rows('A').length, 0);
  ws = 'A'; s.observe('A', []);
  assert.equal(notes.length, 1, 'posted on return');
  s.observe('A', []); assert.equal(notes.length, 1, 'posted once while shown');
  notes[0].shown = false; // the center cleared it (scope change)
  s.observe('A', []); assert.equal(notes.length, 2, 're-posted after a clear');
});

// The store on the real broker (the kernel captures), for outcomes the dialog cannot reach by typing.
function brokerStore({ apply, wake = null, worktreeEvent = false, hooks, broker: brokerOptions = {}, ...overrides } = {}) {
  const cli = { ...structuredClone(CLI), features: [...CLI.features, ...(worktreeEvent ? ['worktree-event'] : [])] };
  const context = () => ({ workspace: { id: 'northwind', scope: DEPLOYMENT }, cli: structuredClone(cli), agents: catalogAgents(), instances: [] });
  const preview = (target, choices) => { const k = kernel(kernelPreviewName(target.selector.soul, choices)); if (hooks) k.result.worktreeHooks = hooks; return k; };
  const read = createSpawnPreviewBoundary({ flights: createSpawnPreviewFlights(), invoke: async (_c, { target, choices }) => preview(target, choices) });
  let ids = 0;
  const broker = createSpawnApplyBoundary({ mint: () => (++ids).toString(16).padStart(64, '0'), read, invoke: async args => apply(args), ...brokerOptions });
  const selector = { soul: 'release-manager', agentsRoot: ROOT };
  const t = store({ post: async (_ws, body) => broker(body, context), currentWorkspace: () => 'northwind', ...overrides });
  const id = t.s.submit({ token: {}, workspace: 'northwind', soul: { name: 'release-manager', agentsRoot: ROOT }, selector,
    input: { action: 'prepare', selector, choices: { purpose: 'api-v2', model: { kind: 'inherit' }, relation: { kind: 'unrelated' } }, task: '', ...(wake ? { wake } : {}) },
    decision: created().decision, draft: { purpose: 'api-v2' } });
  return { ...t, id };
}

test('store: complete but not seen in the roster in time says so truthfully, and opens nothing', async () => {
  let clock = 0;
  const { s, notes, spawned } = brokerStore({ apply: () => receipt(), now: () => clock, visibleWithinMs: 1000 });
  await settle(10);
  assert.equal(s.settling('northwind'), true); assert.equal(s.rows('northwind')[0].pending, 'spawning');
  s.observe('northwind', [realRow(created(), { running: true, tmux: null })]);
  assert.equal(notes.length + spawned.length, 0, 'present without a session is not “spawned”');
  clock = 1000; s.observe('northwind', []);
  assert.match(notes[0].message, /not yet visible as a running session/); assert.equal(spawned.length, 0);
  assert.equal(s.rows('northwind').length, 0); assert.equal(s.settling('northwind'), false);
});

// Session providers (spec C1): a row on one has no tmux session to wait for.
test('store: a launched spawn whose row runs on a session provider is complete once the roster shows it running, with no tmux session; a stopped or unknown one is still awaited', async () => {
  let clock = 0;
  const { s, notes, spawned } = brokerStore({ apply: () => receipt(), now: () => clock, visibleWithinMs: 1000 });
  await settle(10);
  const bb = extra => realRow(created(), { backend: 'bb', tmux: null, runtimeState: 'unknown', session: { provider: 'oats.bb', threadId: 'thr_x' }, ...extra });
  s.observe('northwind', [bb({ running: null })]);
  s.observe('northwind', [bb({ running: false, runtimeState: 'stopped' })]);
  assert.equal(notes.length + spawned.length, 0, 'not reported running yet: still awaited');
  s.observe('northwind', [bb({ running: true })]);
  assert.equal(spawned.length, 1, 'spawned, as a tmux row with its session is');
  assert.equal(spawned[0].backend, 'bb');
  assert.equal(notes.length, 0, 'and never “not yet visible as a running session”');
  clock = 5000; s.observe('northwind', [bb({ running: true })]);
  assert.equal(notes.length, 0);
});

test('store: partial (the wake was not saved) posts the kernel’s words with View schedules', async () => {
  const viewed = [];
  const { s, notes } = brokerStore({ viewSchedules: () => viewed.push(true), wake: { cron: '0 * * * *', tz: 'UTC', message: 'wake', enabled: false },
    apply: () => receipt(created(), { wake: { requested: true, saved: false, error: { code: 'E_SCHEDULE', message: 'secret provider text' } } }) });
  await settle(10);
  assert.equal(notes.length, 1); assert.doesNotMatch(notes[0].message, /secret provider text/);
  const view = notes[0].options.buttons.find(b => b.label === 'View schedules');
  await view.activate(); assert.equal(viewed.length, 1);
  assert.equal(s.rows('northwind')[0].pending, 'spawning', 'the row waits for the roster');
  s.observe('northwind', [realRow()]); assert.equal(s.size(), 0);
});

test('Spec E: a launched partial spawn is followed to its instance once it runs, with no second notice', async () => {
  const arrivals = [];
  const { s, id, notes } = brokerStore({ notifySpawned: (row, ws, epoch, arrival) => arrivals.push({ row, ws, arrival }),
    wake: { cron: '0 * * * *', tz: 'UTC', message: 'wake', enabled: false },
    apply: () => receipt(created(), { wake: { requested: true, saved: false, error: { code: 'E_SCHEDULE', message: 'x' } } }) });
  await settle(10);
  assert.equal(notes.length, 1, 'its own notice (what did not finish)');
  s.observe('northwind', [realRow(created(), { running: false, tmux: null })]);
  assert.equal(arrivals.length, 0, 'present but not running: nothing to open yet'); assert.equal(s.size(), 1);
  s.observe('northwind', [realRow()]);
  assert.equal(arrivals.length, 1); assert.deepEqual(arrivals[0].arrival, { id, complete: false });
  assert.equal(notes.length, 1, 'no second notice'); assert.equal(s.size(), 0);
});

test('Spec E: a partial spawn that was not launched is never followed (no terminal to open)', async () => {
  const arrivals = [];
  const { s } = brokerStore({ notifySpawned: (...a) => arrivals.push(a), wake: { cron: '0 * * * *', tz: 'UTC', message: 'wake', enabled: false },
    apply: () => receipt(created(), { launched: false, wake: { requested: true, saved: false, error: { code: 'E_SCHEDULE', message: 'x' } } }) });
  await settle(10);
  s.observe('northwind', [realRow(created(), { running: false, tmux: null })]);
  assert.equal(arrivals.length, 0); assert.equal(s.size(), 0);
});

test('store: incomplete keeps the existing wording (open it from the instance list)', async () => {
  const d = created().decision;
  const { s, notes } = brokerStore({ apply: () => ({ started: true, envelope: { schemaVersion: 1, ok: false,
    error: { code: 'E_SPAWN_INCOMPLETE', message: 'x', details: { instance: d.instance, home: d.home, launched: false } } } }) });
  await settle(10);
  assert.equal(notes[0].message, `${d.instance} was created but didn’t finish starting. Open it from the instance list instead of spawning again.`);
  assert.equal(s.rows('northwind').length, 1);
});

test('Spec E: the store highlights the pressed spawn\'s pending row, and keeps which real rows say New until seen', async () => {
  let changes = 0;
  const { s } = store({ post: () => new Promise(() => {}), onChange: () => { changes++; } });
  const a = s.submit(spec()), b = s.submit(spec({ soul: { name: 'other', agentsRoot: '/d/agents' } }));
  assert.equal(s.reveal(a), true);
  assert.deepEqual(s.rows('A').map(r => [r.id, !!r.revealed]), [[a, true], [b, false]]);
  s.reveal(b); assert.deepEqual(s.rows('A').map(r => [r.id, !!r.revealed]), [[a, false], [b, true]], 'one at a time: the latest press');
  assert.equal(s.reveal('spawn-gone'), false);
  const row = { instance: 'dev-x', home: decision.home };
  const before = changes; s.markNew('A', row);
  assert.ok(changes > before, 'the roster repaints'); assert.equal(s.isNew('A', row), true);
  assert.equal(s.isNew('B', row), false, 'by workspace'); assert.equal(s.isNew('A', { ...row, server: 'srv' }), false, 'and by server and home');
  assert.equal(s.seen('A', row), true); assert.equal(s.isNew('A', row), false); assert.equal(s.seen('A', row), false);
});

test('pendingPlacement: the row sits where the roster will place the real one', () => {
  const anchor = { instance: 'lead', agentsRoot: '/r' };
  assert.deepEqual(pendingPlacement({ kind: 'unrelated' }), {});
  assert.deepEqual(pendingPlacement({ kind: 'child', anchor }), { parentInstance: 'lead' });
  assert.deepEqual(pendingPlacement({ kind: 'sibling', anchor }, [{ instance: 'lead', agentsRoot: '/r', parentInstance: 'boss' }]), { parentInstance: 'boss' });
  assert.deepEqual(pendingPlacement({ kind: 'sibling', anchor }, [{ instance: 'lead', agentsRoot: '/r' }]), { siblingInstance: 'lead' });
  assert.deepEqual(pendingPlacement({ kind: 'parent', anchor }), { siblingInstance: 'lead' });
});

// ── Spec D (#383): no second spawn of a soul in flight; a reload does not lose an outcome ─────────────

test('Spec D: reopening Spawn for a soul whose spawn is in flight shows the press disabled, says so politely, and links to its row; it re-enables when the job settles', async t => {
  const hold = deferred();
  const u = await mountSpawn(t, { jobs: true, spawnGate: body => body.action === 'apply' ? hold.promise : undefined, apply: () => receipt() });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  u.q('.fspawn').click(); await settle(10);
  assert.equal(u.dialog(), null);
  await u.open(); await settle(10);
  const line = u.q('.spawn-inflight');
  assert.equal(line.hidden, false); assert.equal(line.getAttribute('role'), 'status', 'announced politely');
  assert.equal(u.text('.spawn-inflight-text'), 'A spawn of release-manager is in progress.');
  assert.equal(u.q('.fspawn').disabled, true, 'the press is disabled');
  const show = u.q('.spawn-inflight-show');
  assert.equal(show.getAttribute('aria-label'), `Show the pending row of ${created().decision.instance}`);
  const before = u.spawns().length;
  const ta = u.q('.ftask'); ta.focus();
  ta.dispatchEvent(new u.dom.window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true })); await settle(5);
  assert.equal(u.spawns().length, before, 'Cmd-Enter does nothing while blocked'); assert.ok(u.dialog());
  hold.resolve(); await settle(20);
  assert.equal(u.q('.spawn-inflight').hidden, true, 'the job settled: the line goes');
  assert.equal(u.q('.fspawn').disabled, false, 'and the press is enabled again');
});

test('Spec D: “Show its row” closes the dialog and focuses the pending row; another soul is not blocked', async t => {
  const hold = deferred();
  const u = await mountSpawn(t, { jobs: true, spawnGate: body => body.action === 'apply' ? hold.promise : undefined, apply: () => receipt() });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  u.q('.fspawn').click(); await settle(10);
  await u.open('support-triager'); await settle(10);
  assert.equal(u.q('.spawn-inflight').hidden, true, 'a different soul'); assert.equal(u.q('.fspawn').disabled, false);
  await u.open(); await settle(10);
  const [row] = u.jobs.rows('northwind');
  u.q('.spawn-inflight-show').click(); await settle();
  assert.equal(u.dialog(), null); assert.deepEqual(u.shownRows, [row.id]);
  hold.resolve(); await settle(20);
});

const memoryStorage = () => { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), raw: () => m.get(SPAWN_STORAGE_KEY) ?? null }; };
/** One backend (the real broker) and stores that come and go like a window reload. */
function reloadRig(apply) {
  const context = () => ({ workspace: { id: 'northwind', scope: DEPLOYMENT }, cli: structuredClone(CLI), agents: catalogAgents(), instances: [] });
  const read = createSpawnPreviewBoundary({ flights: createSpawnPreviewFlights(), invoke: async (_c, { target, choices }) => kernel(kernelPreviewName(target.selector.soul, choices)) });
  let ids = 0;
  const broker = createSpawnApplyBoundary({ mint: () => (++ids).toString(16).padStart(64, '0'), read, invoke: async args => apply(args) });
  const posts = [];
  const selector = { soul: 'release-manager', agentsRoot: ROOT };
  return {
    posts,
    window(storage, overrides = {}) {
      return store({ storage, sleep: () => settle(2), post: async (_ws, body) => { posts.push(body.action); return broker(body, context); }, currentWorkspace: () => 'northwind', ...overrides });
    },
    submit(s) {
      return s.submit({ token: {}, workspace: 'northwind', soul: { name: 'release-manager', agentsRoot: ROOT }, selector,
        input: { action: 'prepare', selector, choices: { purpose: 'api-v2', model: { kind: 'inherit' }, relation: { kind: 'unrelated' } }, task: 'private opening words' },
        decision: created().decision, draft: { purpose: 'api-v2', task: 'private opening words' } });
    },
  };
}

test('Spec D: a spawn submitted before a window reload is recovered: its pending row comes back and its outcome is reported (result action only)', async () => {
  const gate = deferred();
  const rig = reloadRig(async () => { await gate.promise; return receipt(); });
  const storage = memoryStorage();
  const before = rig.window(storage);
  rig.submit(before.s); await settle(10);
  assert.ok(storage.raw(), 'kept while the apply runs'); assert.doesNotMatch(storage.raw(), /private opening words/, 'never the opening instruction');
  assert.doesNotMatch(storage.raw(), /idempotency|"key"/, 'never a key');
  before.s.dispose(); // pagehide: the window reloads
  const after = rig.window(storage);
  assert.equal(after.s.recover(), 1);
  const [row] = after.s.rows('northwind');
  assert.equal(row.instance, created().decision.instance); assert.equal(row.pending, 'spawning');
  assert.ok(after.s.inFlight('northwind', { name: 'release-manager', agentsRoot: ROOT }), 'still in flight after the reload');
  await settle(6);
  assert.ok(rig.posts.filter(a => a === 'result').length >= 1); assert.equal(rig.posts.filter(a => a === 'apply').length, 1, 'never applied again');
  gate.resolve(); await settle(20);
  assert.ok(storage.raw(), 'created but not yet reported: still kept');
  after.s.observe('northwind', [realRow()]);
  assert.equal(after.spawned.length, 1, '“spawned” is posted after the reload'); assert.equal(after.s.size(), 0);
  assert.equal(storage.raw(), null, 'dropped once the outcome is reported');
});

test('Spec D: a failure settled while another workspace is on screen survives reloads until its workspace is back, then is reported once', async () => {
  const gate = deferred();
  let current = 'northwind';
  const rig = reloadRig(async () => { await gate.promise; return failure('E_BRANCH_EXISTS'); });
  const storage = memoryStorage(), onScreen = { currentWorkspace: () => current };
  const first = rig.window(storage, onScreen);
  rig.submit(first.s); await settle(10);
  current = 'other';
  gate.resolve(); await settle(20);
  assert.equal(first.notes.length, 0, 'held: its workspace is not on screen');
  assert.ok(storage.raw(), 'settled but not reported: kept');
  first.s.dispose(); // reload while still away
  const second = rig.window(storage, onScreen);
  assert.equal(second.s.recover(), 1); await settle(20);
  assert.equal(second.notes.length, 0, 'still held after the reload');
  assert.ok(storage.raw(), 'still kept: recovering it settled it again without reporting it');
  second.s.dispose(); // and once more
  const third = rig.window(storage, onScreen);
  assert.equal(third.s.recover(), 1); await settle(20);
  current = 'northwind'; third.s.observe('northwind', []);
  assert.equal(third.notes.length, 1, 'reported once its workspace is back'); assert.match(third.notes[0].message, /Nothing was created/);
  assert.equal(rig.posts.filter(a => a === 'apply').length, 1, 'never applied again');
  assert.ok(storage.raw(), 'a failure stays until it is dismissed or reopened');
  third.notes[0].options.onDismiss();
  assert.equal(storage.raw(), null);
});

test('Spec D: a “spawned” notice held for another workspace survives a reload and is posted on return', async () => {
  let current = 'northwind';
  const rig = reloadRig(async () => receipt());
  const storage = memoryStorage(), onScreen = { currentWorkspace: () => current };
  const first = rig.window(storage, onScreen);
  rig.submit(first.s); await settle(20);
  current = 'other';
  first.s.observe('northwind', [realRow()]); // a background read of its workspace
  assert.equal(first.spawned.length, 0, 'held'); assert.ok(storage.raw(), 'kept until posted');
  first.s.dispose();
  const second = rig.window(storage, onScreen);
  second.s.recover(); await settle(20);
  current = 'northwind'; second.s.observe('northwind', [realRow()]);
  assert.equal(second.spawned.length, 1, 'posted on return'); assert.equal(storage.raw(), null);
});

test('Spec D: a spawn that fails after a reload is reported, with Reopen restoring the exact name', async () => {
  const gate = deferred();
  const rig = reloadRig(async () => { await gate.promise; return failure('E_BRANCH_EXISTS'); });
  const storage = memoryStorage(), reopened = [];
  const before = rig.window(storage);
  rig.submit(before.s); await settle(10);
  before.s.dispose();
  const after = rig.window(storage, { reopen: job => reopened.push(job) });
  after.s.recover(); gate.resolve(); await settle(20);
  assert.equal(after.s.rows('northwind').length, 0, 'the row goes');
  assert.equal(after.notes.length, 1); assert.match(after.notes[0].message, /Nothing was created/);
  await after.notes[0].options.buttons[0].activate();
  assert.deepEqual(reopened[0].draft, { layout: 'scoped', restore: { choices: { name: created().decision.instance } } });
  assert.equal(storage.raw(), null);
});

test('Spec D: a recovered spawn whose record is gone (the backend restarted) stays “Outcome unknown”, never guessed', async () => {
  const gate = deferred();
  const first = reloadRig(async () => { await gate.promise; return receipt(); });
  const storage = memoryStorage();
  const before = first.window(storage);
  first.submit(before.s); await settle(10);
  before.s.dispose();
  const restarted = reloadRig(async () => receipt()); // a new backend: the ref is unknown to it
  const after = restarted.window(storage);
  after.s.recover(); await settle(10);
  const [row] = after.s.rows('northwind');
  assert.equal(row.pending, 'unknown'); assert.equal(after.notes.length, 1);
  assert.deepEqual(restarted.posts, ['result'], 'it only asked');
  assert.ok(storage.raw(), 'kept while unknown, so Check result survives another reload');
  gate.resolve(); await settle(5);
});

test('Spec D / #802: a recovered spawn the server still reports pending past its stored deadline becomes unknown', async () => {
  const gate = deferred();
  let clock = 1000;
  const rig = reloadRig(async () => { await gate.promise; return receipt(); });
  const storage = memoryStorage();
  const before = rig.window(storage, { now: () => clock });
  rig.submit(before.s); await settle(10);
  assert.equal(JSON.parse(storage.raw())[0].deadline, 1000 + 60000 + 30000, 'the press keeps its deadline: the CLI deadline plus 30 s, absolute');
  before.s.dispose();
  const sleeps = [];
  const after = rig.window(storage, { now: () => clock, sleep: async ms => { sleeps.push(ms); clock += 20000; await settle(1); } });
  after.s.recover(); await settle(40);
  assert.equal(after.s.rows('northwind')[0].pending, 'unknown');
  assert.match(after.notes[0].message, /still running/);
  assert.ok(clock >= 91000 && clock < 91000 + 20000, 'it followed until the stored deadline, not a fixed recovery window');
  assert.ok(sleeps.every(ms => ms === 2000), 'result is read every 2 s');
  gate.resolve(); await settle(5);
});

test('Spec D: a stored job without a deadline (an older Desktop) follows the ordinary apply deadline from its recovery', async () => {
  let clock = 5000;
  const storage = memoryStorage();
  storage.setItem(SPAWN_STORAGE_KEY, JSON.stringify([{ workspace: 'northwind', deployment: 'northwind', spawnRef: 'a'.repeat(64), soul: { name: 'release-manager', agentsRoot: ROOT },
    selector: { soul: 'release-manager', agentsRoot: ROOT }, instance: 'release-manager-api-v2', home: `${ROOT}/release-manager/instances/release-manager-api-v2`, placement: {}, startedAt: 1 }]));
  const { s } = store({ storage, now: () => clock, currentWorkspace: () => 'northwind',
    post: async (_ws, body) => ({ spawnApplyViewApi: 1, status: 'unavailable', target: null, spawnRef: null, preview: null, receipt: null, reason: { code: 'E_INTERRUPTED' }, body }) });
  assert.equal(s.recover(), 1);
  assert.equal(JSON.parse(storage.raw())[0].deadline, 5000 + 90000);
  await settle(5);
});

test('Spec D: storage that throws or holds junk never breaks the store', async () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  const { s } = store({ storage: broken });
  assert.equal(s.recover(), 0); assert.ok(s.submit(spec())); await settle(4);
  const junk = memoryStorage(); junk.setItem(SPAWN_STORAGE_KEY, JSON.stringify([{ workspace: 'A' }, 7, null, { spawnRef: 'x' }]));
  const t2 = store({ storage: junk });
  assert.equal(t2.s.recover(), 0); assert.equal(junk.raw(), null, 'junk is dropped');
});

test('store: retained prompt outcome explains reason/recovery without Reopen spawn or automatic follow', async () => {
  const { retained } = await import('./helpers/launch-prompt-fixture.mjs');
  for (const status of ['blocked', 'incomplete']) {
    const d = created().decision;
    const { s, notes } = brokerStore({ apply: () => ({ started: true, envelope: { schemaVersion: 1, ok: false,
      error: { code: 'E_SPAWN_INCOMPLETE', details: retained(d, status) } } }) });
    await settle(10);
    assert.match(notes[0].message, status === 'blocked' ? /blocked: unexpected prompt/ : /audit failed after possible input/);
    assert.match(notes[0].message, /Inspect its existing pane, then use oats session start --home/);
    assert.equal(reopenButton(notes[0]), undefined); assert.equal(s.rows('northwind').length, 1);
  }
});

// ── Claude Code ignored the channel option (the receipt's `flagIgnored`): the store says it once per apply ──

const IGNORED_NAME = created().decision.instance;
const IGNORED = `${IGNORED_NAME} started. Claude Code reported that channels are not available and ignored the channel option, so mail and chat will not wake this instance.`;
const IGNORED_DETAIL = `OATS says:\n${EXAMPLE_WARNING_ONE}\n${EXAMPLE_WARNING_TWO}`;
const ignoredReceipt = (changes = {}) => receipt(created(), { launchPrompts: flagIgnored(), warnings: [EXAMPLE_WARNING_ONE, EXAMPLE_WARNING_TWO], ...changes });
const said = notes => notes.filter(n => n.message === IGNORED);
const WAKE = { cron: '0 * * * *', tz: 'UTC', message: 'wake', enabled: false };

test('flag-ignored: the store says it once when the apply settles as created, and the spawn is still followed to its instance', async () => {
  const arrivals = [];
  const { s, id, notes } = brokerStore({ apply: () => ignoredReceipt(), notifySpawned: (row, ws, epoch, arrival) => arrivals.push(arrival) });
  await settle(10);
  assert.deepEqual(notes.map(n => [n.message, n.options]), [[IGNORED, { detail: IGNORED_DETAIL }]], 'the notice of a start, with what OATS reported');
  assert.equal(notes[0].options.sticky, undefined, 'not sticky, as the start\'s');
  assert.equal(s.rows('northwind')[0].pending, 'spawning', 'it does not wait for the roster, and the row still does');
  s.observe('northwind', []); s.observe('northwind', [realRow(created(), { running: false, tmux: null })]);
  assert.equal(notes.length, 1, 'once, however often the roster is observed');
  s.observe('northwind', [realRow()]);
  assert.deepEqual(arrivals, [{ id, complete: true }], 'a complete spawn: followed and announced as any other');
  assert.equal(notes.length, 1); assert.equal(s.size(), 0);
});

test('flag-ignored: a replayed spawn says it too; no warnings, no detail; more than 16 says how many more', async () => {
  const replayed = brokerStore({ apply: () => ignoredReceipt({ replayed: true, warnings: [] }) });
  await settle(10);
  assert.deepEqual(replayed.notes.map(n => [n.message, n.options]), [[IGNORED, {}]]);
  const lines = Array.from({ length: 19 }, (_, i) => `warning ${i + 1}`);
  const many = brokerStore({ apply: () => ignoredReceipt({ warnings: lines }) });
  await settle(10);
  assert.equal(many.notes[0].options.detail, ['OATS says:', ...lines.slice(0, 16), '3 more not shown.'].join('\n'));
});

test('flag-ignored: a partial apply shows both facts, and neither replaces the other', async () => {
  const arrivals = [], viewed = [];
  const { s, id, notes } = brokerStore({ wake: WAKE, viewSchedules: () => viewed.push(true), notifySpawned: (row, ws, epoch, arrival) => arrivals.push(arrival),
    apply: () => ignoredReceipt({ wake: { requested: true, saved: false, error: { code: 'E_SCHEDULE', message: 'x' } } }) });
  await settle(10);
  assert.equal(notes.length, 2, 'two notices for one spawn');
  assert.equal(said(notes).length, 1); assert.equal(said(notes)[0].options.detail, IGNORED_DETAIL);
  const own = notes.find(n => n.message !== IGNORED);
  assert.match(own.message, /wake schedule was not saved/);
  await own.options.buttons.find(b => b.label === 'View schedules').activate(); assert.equal(viewed.length, 1);
  assert.equal(said(notes)[0].options.buttons, undefined, 'each keeps its own options');
  // Both stay as they were while the roster catches up, and the launched partial spawn is still followed.
  s.observe('northwind', []); s.observe('northwind', [realRow()]);
  assert.equal(notes.length, 2); assert.deepEqual(arrivals, [{ id, complete: false }]); assert.equal(s.size(), 0);
});

test('flag-ignored: every other spawn that worked reads as today, with no such notice', async () => {
  for (const changes of [{ launchPrompts: undefined }, { launchPrompts: { status: 'not-engaged', startId: 's', at: 't' } },
    { launchPrompts: { status: 'completed', answers: [], reason: 'recognized launch boundary', receipt: [] } }, { launchPrompts: 'flag-ignored' }, { launchPrompts: { status: 'flag-future' } }]) {
    const { s, notes, spawned } = brokerStore({ apply: () => ignoredReceipt(changes) });
    await settle(10);
    assert.deepEqual(notes, [], JSON.stringify(changes));
    s.observe('northwind', [realRow()]); assert.equal(spawned.length, 1); assert.equal(notes.length, 0);
  }
  // Not launched: "started" would be untrue. Today's one notice, and nothing beside it.
  const scaffold = brokerStore({ apply: () => ignoredReceipt({ launched: false }) });
  await settle(10);
  assert.deepEqual(scaffold.notes.map(n => n.message), [`Created ${IGNORED_NAME} — not launched. Open its session from the roster.`]);
});

test('flag-ignored: held while another workspace is on screen and shown on return, with the job\'s own notice', async () => {
  let ws = 'other';
  const { s, notes } = brokerStore({ currentWorkspace: () => ws, wake: WAKE,
    apply: () => ignoredReceipt({ wake: { requested: true, saved: false, error: { code: 'E_SCHEDULE', message: 'x' } } }) });
  await settle(10);
  assert.equal(notes.length, 0, 'held: its workspace is not on screen');
  s.observe('northwind', [realRow()]); // a background read of its workspace
  assert.equal(notes.length, 0, 'still held');
  ws = 'northwind'; s.observe('northwind', [realRow()]);
  assert.equal(notes.length, 2); assert.equal(said(notes).length, 1);
  s.observe('northwind', [realRow()]); assert.equal(notes.length, 2, 'once');
});

test('flag-ignored: an unknown outcome that Check result finds created says it once', async () => {
  let n = 0;
  const { s, id, notes } = brokerStore({ apply: () => ++n === 1 ? failure('E_CLI_TIMEOUT', true) : ignoredReceipt({ replayed: true, warnings: [] }) });
  await settle(10);
  assert.equal(said(notes).length, 0); assert.equal(s.rows('northwind')[0].pending, 'unknown');
  await s.check(id); await settle(10);
  assert.equal(said(notes).length, 1);
  s.observe('northwind', [realRow()]); assert.equal(said(notes).length, 1);
});

test('flag-ignored and a reload: held when the window reloads, it is shown once on return', async () => {
  let current = 'other';
  const rig = reloadRig(async () => ignoredReceipt());
  const storage = memoryStorage(), onScreen = { currentWorkspace: () => current };
  const first = rig.window(storage, onScreen);
  rig.submit(first.s); await settle(20);
  assert.equal(first.notes.length, 0, 'held: its workspace is not on screen');
  assert.doesNotMatch(storage.raw(), /flagSaid/, 'held is not shown: nothing is remembered yet');
  first.s.dispose(); // the window reloads while it is held
  const second = rig.window(storage, onScreen);
  assert.equal(second.s.recover(), 1); await settle(20);
  assert.equal(second.notes.length, 0, 'still held after the reload');
  assert.doesNotMatch(storage.raw(), /flagSaid/);
  current = 'northwind'; second.s.observe('northwind', []);
  assert.deepEqual(second.notes.map(n => [n.message, n.options]), [[IGNORED, { detail: IGNORED_DETAIL }]], 'shown on return');
  assert.match(storage.raw(), /"flagSaid":true/, 'remembered from the moment it was shown');
  second.s.observe('northwind', []); second.s.observe('northwind', [realRow()]);
  assert.equal(second.notes.length, 1, 'once'); assert.equal(second.spawned.length, 1); assert.equal(storage.raw(), null);
  assert.equal(rig.posts.filter(a => a === 'apply').length, 1, 'never applied again');
});

test('flag-ignored and a reload: shown before the window reloads, it is not shown again', async () => {
  const rig = reloadRig(async () => ignoredReceipt());
  const storage = memoryStorage();
  const first = rig.window(storage);
  rig.submit(first.s); await settle(20);
  assert.equal(said(first.notes).length, 1, 'shown: its workspace is on screen');
  // The job waits for the roster, so it is still kept: with the fact that the notice was shown, never its text.
  const kept = JSON.parse(storage.raw());
  assert.equal(kept.length, 1); assert.equal(kept[0].flagSaid, true);
  assert.doesNotMatch(storage.raw(), /OATS says|will not wake|example|warning|hook|check a setting/i, 'no warning text and no sentence is stored');
  first.s.dispose(); // the window reloads
  const second = rig.window(storage);
  assert.equal(second.s.recover(), 1); await settle(20);
  assert.ok(rig.posts.filter(a => a === 'result').length >= 1, 'the same apply is settled again from `result`');
  assert.deepEqual(second.notes, [], 'and says nothing a second time');
  second.s.observe('northwind', []); second.s.observe('northwind', [realRow()]);
  assert.deepEqual(second.notes, []); assert.equal(second.spawned.length, 1, 'its "spawned" is still reported');
  assert.equal(storage.raw(), null);
  // Only the stored `true` means shown: anything else in its place shows the notice (once) rather than losing it.
  for (const value of ['true', 1, {}, null]) {
    const again = reloadRig(async () => ignoredReceipt()), store2 = memoryStorage();
    const before = again.window(store2);
    again.submit(before.s); await settle(20);
    const entries = JSON.parse(store2.raw()); entries[0].flagSaid = value;
    store2.setItem(SPAWN_STORAGE_KEY, JSON.stringify(entries));
    before.s.dispose();
    const after = again.window(store2);
    after.s.recover(); await settle(20);
    assert.equal(said(after.notes).length, 1, JSON.stringify(value));
  }
});

// ── #802: long spawns ──────────────────────────────────────────────────────

function manualTimer() {
  const armed = [];
  return { armed, timer: (fn, ms) => { const t = { fn, ms, cleared: false }; armed.push(t); return () => { t.cleared = true; }; },
    fire: () => { for (const t of armed.splice(0)) if (!t.cleared) t.fn(); } };
}

test('#802: an apply that answers pending is followed with result every 2 s until it completes; nothing is applied twice', async () => {
  const gate = deferred(), clock = manualTimer(), sleeps = [];
  const t = brokerStore({ apply: async () => { await gate.promise; return receipt(); }, broker: { timer: clock.timer }, sleep: async ms => { sleeps.push(ms); await settle(1); } });
  const jobs = t.s;
  await settle(10);
  clock.fire(); await settle(10); // the broker's 50 s: apply answers pending
  assert.equal(jobs.rows('northwind')[0].pending, 'spawning', 'still Spawning…, never Outcome unknown while it runs');
  assert.equal(t.notes.length, 0, 'no notice while it runs');
  assert.ok(jobs.inFlight('northwind', { name: 'release-manager', agentsRoot: ROOT }));
  gate.resolve(); await settle(20);
  assert.ok(sleeps.length >= 1 && sleeps.every(ms => ms === 2000));
  assert.equal(jobs.settling('northwind'), true, 'complete: waiting for the roster, as before');
  jobs.observe('northwind', [realRow()]);
  assert.equal(t.spawned.length, 1); assert.equal(jobs.size(), 0);
  });

test('#802: a pending apply is followed until its own deadline (the preview\'s CLI deadline + 30 s), then reads Outcome unknown', async () => {
  const clock = manualTimer();
  let now = 0;
  const storage = memoryStorage();
  const t = brokerStore({ worktreeEvent: true, hooks: [{ capability: 'nw-setup', required: true }], storage, now: () => now,
    apply: () => new Promise(() => {}), broker: { timer: clock.timer }, sleep: async () => { now += 600000; await settle(1); } });
  await settle(10);
  assert.equal(JSON.parse(storage.raw())[0].deadline, 1920000 + 30000, 'one hook: 60 s + 30 min + 60 s, plus 30 s');
  clock.fire(); await settle(40);
  const [row] = t.s.rows('northwind');
  assert.equal(row.pending, 'unknown'); assert.match(t.notes[0].message, /still running/);
  assert.ok(now >= 1950000 && now < 1950000 + 600000);
});

test('#802: rows carry the job\'s start, for the roster\'s “since” line', async () => {
  const { s } = store({ now: () => 1234, post: async () => new Promise(() => {}) });
  s.submit(spec());
  assert.equal(s.rows('A')[0].startedAt, 1234);
});

for (const [code, words] of [['E_INTERRUPTED', /^The spawn of release-manager-api-v2 was interrupted while its worktree was being set up, and was rolled back\. Nothing was created\.$/],
  ['E_REQUIRED_HOOK_FAILED', /^A capability couldn’t set up the worktree for release-manager-api-v2, so the spawn was rolled back\. Nothing was created\.$/],
  ['E_HOOK_ENVIRONMENT_CONTRACT', /^A capability couldn’t set up the worktree for release-manager-api-v2, so the spawn was rolled back\. Nothing was created\.$/]]) {
  test(`#802: ${code} without unconfirmed is a known rollback: the failure notice with Reopen spawn, the kernel's words under Details`, async () => {
    const reopened = [];
    const message = `a capability could not set up the new worktree:\n  nw-setup worktree hook (declared required): exited 3 (log: /h/.oats/logs/w.log) — spawn rolled back`;
    const { s, notes } = brokerStore({ worktreeEvent: true, reopen: job => reopened.push(job),
      apply: () => ({ started: true, envelope: { schemaVersion: 1, ok: false, error: { code, message } } }) });
    await settle(20);
    assert.equal(s.rows('northwind').length, 0, 'nothing was created: the row goes');
    assert.equal(notes.length, 1); assert.match(notes[0].message, words);
    assert.equal(notes[0].options.detail, `${code} · a capability could not set up the new worktree: nw-setup worktree hook (declared required): exited 3 (log: /h/.oats/logs/w.log) — spawn rolled back`, 'one line, through displayLine');
    assert.ok(reopenButton(notes[0]));
    await reopenButton(notes[0]).activate(); assert.equal(reopened.length, 1);
  });
  test(`#802: ${code} with unconfirmed is cleanup owed: it says Retire completes it, with no Check result or Reopen`, async () => {
    const { s, notes } = brokerStore({ worktreeEvent: true,
      apply: () => ({ started: true, envelope: { schemaVersion: 1, ok: false, error: { code, message: 'rollback INCOMPLETE', details: { unconfirmed: true } } } }) });
    await settle(20);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].message, 'The spawn of release-manager-api-v2 was stopped, but its cleanup didn’t finish. Retire release-manager-api-v2 from the roster to complete it.');
    assert.equal(notes[0].options.detail, `${code} · rollback INCOMPLETE`);
    assert.equal(reopenButton(notes[0]), undefined);
    assert.equal(s.rows('northwind').length, 0, 'the roster\'s own quarantined row offers Retire');
    assert.equal(s.size(), 0);
  });
}

test('#802: without worktree-event, or for E_SPAWN_FAILED, today\'s handling: Outcome unknown', async () => {
  for (const [feature, code] of [[false, 'E_INTERRUPTED'], [true, 'E_SPAWN_FAILED']]) {
    const { s, notes } = brokerStore({ worktreeEvent: feature, apply: () => ({ started: true, envelope: { schemaVersion: 1, ok: false, error: { code, message: 'x' } } }) });
    await settle(20);
    assert.equal(s.rows('northwind')[0].pending, 'unknown'); assert.doesNotMatch(notes[0].message, /rolled back/);
  }
});
