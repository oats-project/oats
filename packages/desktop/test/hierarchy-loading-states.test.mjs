/* Hierarchy (Active overview) loading states (desktop/loading-states, Phase A
   item 2): the shared controller drives the summary pill, aria-busy, the
   "Refreshing…" indicator and the status line; the view's own notice keeps the
   stale / failed copy. The controller's timers run on the view's window, so
   the tests install a fake clock on the JSDOM window and advance it: the
   150ms / 400ms delays are exact, never a race against a loaded machine. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import * as hierarchy from '../renderer/views/hierarchy.mjs';
import { currentWorkspace, setWorkspace } from '../renderer/views/common.mjs';
import { NOT_SERVED_CODE, NO_ANSWER_CODE, PENDING_LIMIT_MS } from '../renderer/deployment-header.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
/** A fake clock on the JSDOM window: timers fire in order when advanced. */
function clock(win) {
  let now = 1_000_000, seq = 0; const timers = new Map();
  win.setTimeout = (fn, ms = 0) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; };
  win.clearTimeout = id => { timers.delete(id); };
  return { advance(ms) {
    const until = now + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn();
    }
    now = until;
  } };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const instance = (name = 'dev', fields = {}) => ({ instance: name, agent: 'soul', agentsRoot: '/team/agents', home: `/team/agents/soul/instances/${name}`, running: true, repoName: 'reported-repo', runtime: 'pi', branch: 'reported-branch', ...fields });
const panel = (instances = [instance()], id = currentWorkspace(), extra = {}) => ({ instances, workspace: { id }, workspaces: [{ id: '/team', name: 'Team' }, { id: '/other', name: 'Other' }], generatedAt: 'observation-time', ...extra });

async function setup(t, { api, instances, ctx: extra = {} } = {}) {
  const dom = new JSDOM('<body><main id="host"></main></body>', { url: 'http://localhost' });
  const doc = dom.window.document, host = doc.querySelector('main');
  const old = { window: globalThis.window, document: globalThis.document, setInterval: globalThis.setInterval, ws: currentWorkspace() };
  const polls = []; globalThis.window = dom.window; globalThis.document = doc; globalThis.setInterval = fn => { polls.push(fn); return 0; };
  // A focused window (#481): the roster poll reads every tick (jsdom's document reports no focus).
  doc.hasFocus = () => true;
  const c = clock(dom.window);
  setWorkspace('/team');
  let read = api || (() => panel(instances));
  const ctx = { hasWorkspaceSwitcher: true, api: path => read(path), openTerminal() {}, startInstance() {}, restartInstance() {}, openView() {}, ...extra };
  // Every skeleton that ever enters the summary is recorded, so "never" is provable for fast replies.
  const skeletons = [];
  const observer = new dom.window.MutationObserver(records => { for (const r of records) for (const n of r.addedNodes) if (n.dataset?.skeleton) skeletons.push(n); });
  const dispose = hierarchy.mount(host, ctx);
  observer.observe(host.querySelector('.hier-sum'), { childList: true });
  t.after(() => { observer.disconnect(); dispose(); setWorkspace(old.ws); globalThis.window = old.window; globalThis.document = old.document; globalThis.setInterval = old.setInterval; dom.window.close(); });
  const canvas = host.querySelector('.hier-canvas');
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1200, height: 800 });
  const mouse = (target, type, fields = {}) => target.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, button: 0, ...fields }));
  return { dom, doc, host, canvas, dispose, mouse, skeletons, c, wait: async ms => { c.advance(ms); await tick(); },
    one: selector => host.querySelector(selector), all: selector => [...host.querySelectorAll(selector)],
    nodes: () => [...host.querySelectorAll('.hnode')], root: () => host.querySelector('.hier'),
    sum: () => host.querySelector('.hier-sum'), pill: () => host.querySelector('.hier-sum .skeleton-pill[data-skeleton="pill"]'),
    status: () => host.querySelector('.hier-status').textContent, indicator: () => host.querySelector('.hier-refreshing .loading-refreshing'),
    notice: () => (host.querySelector('.hier-notice').hidden ? '' : host.querySelector('.hier-notice-message').textContent),
    setRead: value => { read = value; }, poll: () => polls[0](), retry: () => host.querySelector('.hier-retry').click() };
}

test('first load: no counts, no empty copy and no pill before 150ms; then the pill, aria-busy and one "Loading roster…"', async t => {
  const first = deferred(); const u = await setup(t, { api: () => first.promise });
  assert.equal(u.sum().textContent, '', 'the summary is blank, not "0 running"');
  assert.equal(u.one('.spinner'), null, 'the bare spinner is retired');
  assert.equal(u.one('.empty'), null); assert.equal(u.nodes().length, 0);
  assert.equal(u.root().getAttribute('aria-busy'), 'true');
  assert.equal(u.status(), 'Loading roster…');
  const status = u.one('.hier-status'); assert.equal(status.getAttribute('role'), 'status'); assert.ok(status.classList.contains('loading-sr'));
  assert.doesNotMatch(u.host.textContent, /Loading reported roster|Reading/);
  await u.wait(60); assert.equal(u.pill(), null, 'nothing changes before the delay');
  await u.wait(110);
  const pill = u.pill(); assert.ok(pill, 'the pill arrives after ~150ms'); assert.equal(pill.getAttribute('aria-hidden'), 'true');
  assert.equal(u.sum().textContent, '', 'the pill carries no text'); assert.equal(u.one('.empty'), null);
  first.resolve(panel([instance('a'), instance('b', { running: false })])); await tick();
  assert.equal(u.pill(), null); assert.match(u.sum().textContent, /1 running · 1 stopped/);
  assert.equal(u.root().hasAttribute('aria-busy'), false); assert.equal(u.status(), '', 'a background completion announces nothing');
  assert.equal(u.nodes().length, 2); assert.equal(u.notice(), '');
});

test('a fast reply never shows a pill; a successful zero read is the only empty state', async t => {
  const u = await setup(t, { instances: [] }); await tick();
  assert.ok(u.one('.empty'), 'a successful empty read paints the empty copy');
  assert.match(u.sum().textContent, /0 running · 0 stopped · 0 groups/);
  await u.wait(200);
  assert.deepEqual(u.skeletons, [], 'no skeleton ever entered the summary');
  assert.equal(u.root().hasAttribute('aria-busy'), false); assert.equal(u.status(), '');
});

test('a poll with data present refreshes in place: nodes and focus survive, "Refreshing…" only after 400ms, no aria-busy', async t => {
  const u = await setup(t, { instances: [instance('a'), instance('b')] }); await tick();
  const nodes = u.nodes(); u.mouse(nodes[0], 'click'); const pop = u.one('.hier-pop'), button = u.one('.pterm'); button.focus();
  const slow = deferred(); u.setRead(() => slow.promise); u.poll();
  assert.equal(u.indicator(), null); assert.equal(u.root().hasAttribute('aria-busy'), false); assert.equal(u.status(), '');
  assert.deepEqual(u.nodes(), nodes, 'the canvas is untouched while the read is in flight');
  await u.wait(200); assert.equal(u.indicator(), null, 'not yet');
  await u.wait(230);
  const indicator = u.indicator(); assert.ok(indicator, 'the indicator arrives after ~400ms'); assert.equal(indicator.textContent, 'Refreshing…');
  assert.ok(u.one('.hier-bar').contains(indicator), 'beside the summary in the bar');
  assert.equal(u.root().hasAttribute('aria-busy'), false); assert.equal(u.status(), '', 'background polls are silent');
  assert.equal(u.pill(), null); assert.equal(u.doc.activeElement, button);
  slow.resolve({ ...panel([instance('a'), instance('b')]), generatedAt: 'later' }); await tick();
  assert.equal(u.indicator(), null);
  assert.deepEqual(u.nodes(), nodes, 'an unchanged observation does not repaint');
  assert.equal(u.one('.hier-pop'), pop); assert.equal(u.doc.activeElement, button);
  assert.equal(u.status(), '');
});

test('a failed poll with data goes stale: content kept, the view notice with Retry roster, actions disabled, no controller block or pill', async t => {
  const u = await setup(t, { instances: [instance('a')] }); await tick();
  const nodes = u.nodes(); u.mouse(nodes[0], 'click'); const button = u.one('.pterm');
  u.setRead(() => Promise.reject(new Error('offline'))); u.poll(); await tick();
  assert.deepEqual(u.nodes(), nodes, 'the last observation stays painted');
  assert.match(u.notice(), /^Roster unavailable: offline\. Showing the last observation, not current state; actions disabled\.$/, 'no observedAt reported: no age invented');
  assert.equal(u.one('.hier-retry').hidden, false); assert.equal(u.one('.hier-retry').textContent, 'Retry roster');
  assert.equal(button.disabled, true, 'actions that need current state are disabled');
  assert.equal(u.status(), 'Couldn\'t refresh roster.', 'the failure is announced through the status line');
  assert.equal(u.root().hasAttribute('aria-busy'), false); assert.equal(u.indicator(), null); assert.equal(u.pill(), null);
  assert.equal(u.one('.loading-notice'), null, 'the view notice owns the stale line: no duplicate');
  assert.equal(u.one('.loading-failed'), null);
  assert.match(u.sum().textContent, /1 running/, 'the counts are the last observation, not "Roster unknown"');
  u.setRead(() => panel([instance('a')])); u.retry(); await tick();
  assert.equal(u.notice(), ''); assert.equal(button.disabled, false); assert.deepEqual(u.nodes(), nodes);
  assert.equal(u.status(), 'Roster updated', 'a user-invoked Retry announces its completion');
});

test('Retry on a remote window reads its servers again first (#1117): the refresh route, and only once it answered the panel; a local window\'s Retry asks no server', async t => {
  const REFRESH = '/api/remote-roster/refresh';
  const remote = (instances, extra = {}) => panel(instances, currentWorkspace(), { workspace: { id: currentWorkspace(), remote: true }, ...extra });
  const paths = []; let answer = () => remote([], { error: 'ssh to garnet-host timed out: no answer within 20 s' });
  const refreshed = deferred();
  const u = await setup(t, { api: path => { paths.push(path); return path === REFRESH ? refreshed.promise : answer(); } }); await tick();
  assert.match(u.notice(), /^Roster unavailable: ssh to garnet-host timed out/, 'the window\'s one server was not reached');
  answer = () => remote([instance('a')]);
  paths.length = 0; u.retry(); await tick();
  assert.deepEqual(paths, [REFRESH], 'the servers are read again before the roster is');
  refreshed.resolve({ refreshed: true }); await tick();
  const PANEL = `/api/panel?ws=${encodeURIComponent(currentWorkspace())}`;
  assert.deepEqual(paths, [REFRESH, PANEL], 'then the panel, which serves that read');
  assert.equal(u.notice(), ''); assert.equal(u.nodes().length, 1);
  // A background poll of the same window asks no server: only a Retry does.
  paths.length = 0; u.poll(); await tick();
  assert.deepEqual(paths, [PANEL]);
});

test('Retry on a local window reads the panel only: there is no server to read again', async t => {
  const paths = [];
  const u = await setup(t, { api: path => { paths.push(path); return Promise.reject(new Error('probe down')); } }); await tick();
  paths.length = 0; u.retry(); await tick();
  assert.deepEqual(paths, [`/api/panel?ws=${encodeURIComponent(currentWorkspace())}`]);
});

test('a failure without data: "Roster unknown", the view notice, no empty copy, no controller failed block in the summary', async t => {
  const u = await setup(t, { api: () => Promise.reject(new Error('probe down')) }); await tick();
  assert.equal(u.sum().textContent, 'Roster unknown'); assert.equal(u.one('.hier-sum .loading-failed'), null); assert.equal(u.one('.loading-failed'), null);
  assert.equal(u.one('.empty'), null); assert.equal(u.nodes().length, 0);
  assert.equal(u.root().hasAttribute('aria-busy'), false); assert.equal(u.pill(), null);
  assert.equal(u.notice(), 'Roster unavailable: probe down. No current observation.');
  assert.equal(u.status(), 'Couldn\'t refresh roster. probe down');
  await u.wait(200); assert.deepEqual(u.skeletons, [], 'no pill lands after the failure');
  u.setRead(() => panel([instance('back')])); u.retry();
  assert.equal(u.root().getAttribute('aria-busy'), 'true', 'a retry without data is pending again');
  assert.equal(u.sum().textContent, 'Roster unknown', 'the summary keeps its truthful text while the retry runs');
  await tick();
  assert.match(u.sum().textContent, /1 running/); assert.equal(u.nodes().length, 1); assert.equal(u.notice(), '');
  assert.equal(u.status(), 'Roster updated'); assert.equal(u.root().hasAttribute('aria-busy'), false);
});

test('a workspace switch is a new subject: blank summary (never "0 running"), pending again, pill after 150ms, painted on reply', async t => {
  const u = await setup(t, { instances: [instance('team-a')] }); await tick();
  assert.equal(u.nodes().length, 1);
  const next = deferred(); u.setRead(() => next.promise);
  setWorkspace('/other');
  assert.equal(u.nodes().length, 0, 'the old roster is revoked synchronously');
  assert.equal(u.sum().textContent, ''); assert.equal(u.one('.empty'), null);
  assert.equal(u.root().getAttribute('aria-busy'), 'true'); assert.equal(u.status(), 'Loading roster…');
  assert.equal(u.indicator(), null, 'a switch is pending, not refreshing');
  assert.equal(u.pill(), null); await u.wait(170); assert.ok(u.pill());
  next.resolve(panel([instance('other-a'), instance('other-b')], '/other')); await tick();
  assert.equal(u.pill(), null); assert.match(u.sum().textContent, /2 running/); assert.equal(u.nodes().length, 2);
  assert.equal(u.root().hasAttribute('aria-busy'), false); assert.equal(u.status(), '');
});

test('a switch while a slow first read is pending keeps one pill, and the superseded reply never lands', async t => {
  const requests = []; const u = await setup(t, { api: () => { const d = deferred(); requests.push(d); return d.promise; } });
  await u.wait(170); assert.ok(u.pill());
  setWorkspace('/other');
  assert.equal(u.pill(), null, 'reset drops the old pill'); assert.equal(u.root().getAttribute('aria-busy'), 'true');
  await u.wait(170); assert.equal(u.all('.hier-sum .skeleton-pill').length, 1, 'exactly one pill for the new subject');
  requests[0].resolve(panel([instance('stale')], '/team')); await tick();
  assert.ok(u.pill(), 'a superseded success cannot end the pending state'); assert.equal(u.nodes().length, 0);
  requests[1].resolve(panel([instance('current')], '/other')); await tick();
  assert.equal(u.pill(), null); assert.match(u.host.textContent, /current/); assert.doesNotMatch(u.host.textContent, /stale/);
});

test('observedAt is taken from the reply when present and never invented; it does not force a repaint', async t => {
  const u = await setup(t, { api: () => panel([instance('a')], '/team', { observedAt: new Date().toISOString() }) }); await tick();
  const nodes = u.nodes();
  assert.equal(u.one('.loading-notice'), null, 'fresh data shows no age line');
  u.setRead(() => panel([instance('a')], '/team', { observedAt: new Date(Date.now() + 1000).toISOString() })); u.poll(); await tick();
  assert.deepEqual(u.nodes(), nodes, 'a changed observedAt alone is not a roster change');
  u.setRead(() => panel([instance('a')])); u.poll(); await tick();
  assert.equal(u.one('.loading-notice'), null, 'no age shown when the field is absent');
});

test('a deployment the server has not observed yet (status pending, no instances) is not an empty roster: its copy in the summary, no counts, no empty state, aria-busy; the observation then paints', async t => {
  const u = await setup(t, { api: () => panel([], currentWorkspace(), { deployment: { status: 'pending' } }) }); await tick();
  assert.equal(u.sum().textContent, 'Reading the deployment through the installed OATS CLI…');
  assert.equal(u.one('.empty'), null, 'no "No instances reported"'); assert.equal(u.nodes().length, 0);
  assert.equal(u.root().getAttribute('aria-busy'), 'true'); assert.equal(u.status(), 'Loading roster…'); assert.equal(u.notice(), '');
  await u.wait(200); assert.equal(u.pill(), null, 'the copy stands in for the pill: a deployment state is not a skeleton');
  await u.poll(); await tick(); assert.equal(u.sum().textContent, 'Reading the deployment through the installed OATS CLI…', 'a repeated pending poll changes nothing');
  u.setRead(() => panel([instance('a'), instance('b', { running: false })]));
  await u.poll(); await tick();
  assert.match(u.sum().textContent, /1 running · 1 stopped/); assert.equal(u.nodes().length, 2); assert.equal(u.root().hasAttribute('aria-busy'), false);
  // A deployment the kernel refused is a failed read, with the existing notice.
  u.setRead(() => panel([], currentWorkspace(), { deployment: { status: 'unavailable', reason: { code: 'E_NO_KERNEL', message: 'no kernel here' } } }));
  await u.poll(); await tick();
  assert.match(u.notice(), /Roster unavailable: E_NO_KERNEL: no kernel here/); assert.equal(u.nodes().length, 2, 'the last observation stays');
});

test('the stale notice carries the kept observation\'s age when the reply reported observedAt (the model\'s rule for every stale line)', async t => {
  // The view's age reads Date.now: one fixed instant for the observation and the view, so the age is 45 s by construction.
  const now = Date.now(); t.mock.method(Date, 'now', () => now);
  const at = new Date(now - 45_000).toISOString();
  const u = await setup(t, { api: () => panel([instance('a')], '/team', { observedAt: at }) }); await tick();
  u.setRead(() => Promise.reject(new Error('offline'))); u.poll(); await tick();
  assert.match(u.notice(), /^Roster unavailable: offline\. Showing the last observation · observed 45s ago, not current state; actions disabled\.$/);
  u.setRead(() => panel([instance('a')], '/team', { observedAt: at, error: 'remote unreachable' })); await u.poll(); await tick();
  assert.match(u.notice(), /Showing a reported observation · observed 45s ago, not current state/);
});

test('a panel that reports an error beside its instances is announced as stale once (the notice is a note, the status line speaks)', async t => {
  const u = await setup(t); await tick();
  assert.equal(u.nodes().length, 1);
  u.setRead(() => panel([instance()], currentWorkspace(), { error: 'remote unreachable' }));
  await u.poll(); await tick();
  assert.match(u.notice(), /^Roster unavailable: remote unreachable\./); assert.equal(u.one('.hier-notice').getAttribute('role'), 'note');
  assert.equal(u.status(), "Couldn't refresh roster."); assert.equal(u.nodes().length, 1, 'the observation is kept');
  const status = u.one('.hier-status'); status.textContent = 'sentinel';
  await u.poll(); await tick(); assert.equal(status.textContent, 'sentinel', 'announced once, not on every poll');
  u.setRead(() => panel([instance()])); await u.poll(); await tick();
  assert.equal(u.notice(), ''); assert.equal(u.status(), '');
});

/* ── #982: the kept failure's message is shown with who made it, and a failure with no words is still one ── */
const OWN_NOTE = 'Showing a reported observation, not current state; actions disabled.';
test("the note over rows kept after a failed read: the kernel's words after the Desktop's sentence, a message with no speaker inside it, each one display line", async t => {
  const u = await setup(t); await tick();
  const note = async (extra) => { u.setRead(() => panel([instance()], currentWorkspace(), extra)); await u.poll(); await tick(); return u.notice(); };
  // The six forms.
  assert.equal(await note({ error: 'the cache is locked', errorOrigin: 'kernel' }), `Roster unavailable. ${OWN_NOTE} OATS says: the cache is locked`);
  assert.equal(await note({ error: 'wipe \x1b[2J the screen', errorOrigin: 'kernel' }), `Roster unavailable. ${OWN_NOTE} [withheld]`);
  assert.equal(await note({ error: '', errorOrigin: 'kernel' }), `Roster unavailable. ${OWN_NOTE}`);
  assert.equal(await note({ error: 'the cache is locked' }), `Roster unavailable: the cache is locked. ${OWN_NOTE}`);
  assert.equal(await note({ error: 'token: abc123' }), `Roster unavailable: [withheld]. ${OWN_NOTE}`);
  assert.equal(await note({ error: '' }), `Roster unavailable. ${OWN_NOTE}`);
  // Spaces alone are nothing to show; several lines are one; the line is cut at 300 as before, the lead not counted.
  assert.equal(await note({ error: ' \n\t ', errorOrigin: 'kernel' }), `Roster unavailable. ${OWN_NOTE}`);
  assert.equal(await note({ error: 'first\nsecond', errorOrigin: 'kernel' }), `Roster unavailable. ${OWN_NOTE} OATS says: first second`);
  const long = 'word '.repeat(100).trim();
  assert.equal(await note({ error: long, errorOrigin: 'kernel' }), `Roster unavailable. ${OWN_NOTE} OATS says: ${long.slice(0, 300)}`);
  assert.equal(await note({ error: long }), `Roster unavailable: ${long.slice(0, 300)}. ${OWN_NOTE}`);
  // Only the one value names the kernel; markup stays text.
  for (const errorOrigin of ['Kernel', 'roster-read', 'terminal-probe', true, { origin: 'kernel' }]) {
    assert.equal(await note({ error: 'the cache is locked', errorOrigin }), `Roster unavailable: the cache is locked. ${OWN_NOTE}`, JSON.stringify(errorOrigin));
  }
  assert.equal(await note({ error: '<b>bold</b>', errorOrigin: 'kernel' }), `Roster unavailable. ${OWN_NOTE} OATS says: <b>bold</b>`);
  assert.equal(u.one('.hier-notice b'), null, 'the note is text');
  assert.equal(await note({}), '', 'a panel with no failure has no note');
});

test('a kept failure with no words is still a failure: the rows go stale and their actions are disabled, whatever the message holds', async t => {
  for (const extra of [{ error: '' }, { error: '', errorOrigin: 'kernel' }, { error: '   ', errorOrigin: 'kernel' }, { error: 'bell\u0007', errorOrigin: 'kernel' }, { error: 'the cache is locked', errorOrigin: 'kernel' }]) {
    const u = await setup(t); await tick();
    u.mouse(u.nodes()[0], 'click'); assert.equal(u.one('.pterm').disabled, false, 'live before the failure');
    u.setRead(() => panel([instance()], currentWorkspace(), extra)); await u.poll(); await tick();
    assert.equal(u.nodes().length, 1, 'the last observation stays'); assert.equal(u.one('.pterm').disabled, true, JSON.stringify(extra));
    assert.match(u.one('.pstate').textContent, / \(last observation\)$/, JSON.stringify(extra));
    assert.match(u.notice(), /^Roster unavailable[.:]/, JSON.stringify(extra)); assert.equal(u.status(), "Couldn't refresh roster.");
    u.setRead(() => panel([instance()])); await u.poll(); await tick();
    assert.equal(u.notice(), ''); assert.equal(u.one('.pterm').disabled, false, 'an observed roster is live again');
    u.dispose();
  }
});

test("a failed read with nothing to show: the notice sets the kernel's words after the Desktop's own, as the note over kept rows does, and the spoken status carries the same speaker", async t => {
  const failed = async (extra) => { const u = await setup(t, { api: () => panel([], '/team', extra) }); await tick(); const said = [u.notice(), u.status(), u.sum().textContent, u.one('.empty')]; u.dispose(); return said; };
  const NONE = 'No current observation.';
  // The kernel's: its words stand after the Desktop's sentences, never inside them.
  assert.deepEqual(await failed({ error: 'the cache is locked', errorOrigin: 'kernel' }),
    [`Roster unavailable. ${NONE} OATS says: the cache is locked`, "Couldn't refresh roster. OATS says: the cache is locked", 'Roster unknown', null]);
  assert.deepEqual((await failed({ error: 'wipe \x1b[2J the screen', errorOrigin: 'kernel' })).slice(0, 2),
    [`Roster unavailable. ${NONE} [withheld]`, "Couldn't refresh roster. [withheld]"]);
  // No speaker (another machine's panel, or a value that is not the kernel's): inside the sentence, as on the base.
  assert.deepEqual(await failed({ error: 'the cache is locked' }),
    [`Roster unavailable: the cache is locked. ${NONE}`, "Couldn't refresh roster. the cache is locked", 'Roster unknown', null]);
  assert.deepEqual((await failed({ error: 'the cache is locked', errorOrigin: 'roster-read' })).slice(0, 2),
    [`Roster unavailable: the cache is locked. ${NONE}`, "Couldn't refresh roster. the cache is locked"]);
  assert.deepEqual((await failed({ error: 'token: abc123' })).slice(0, 2), [`Roster unavailable: [withheld]. ${NONE}`, "Couldn't refresh roster. [withheld]"]);
  // No words: a failed read all the same, never an observed empty roster, and the Desktop's sentences alone.
  for (const extra of [{ error: '' }, { error: '', errorOrigin: 'kernel' }, { error: ' \n ', errorOrigin: 'kernel' }]) {
    assert.deepEqual(await failed(extra), [`Roster unavailable. ${NONE}`, "Couldn't refresh roster.", 'Roster unknown', null], JSON.stringify(extra));
  }
  // One line, cut at 300 as the path cuts it, the lead not counted; markup stays text.
  const long = 'word '.repeat(100).trim();
  assert.equal((await failed({ error: `first\n${long}`, errorOrigin: 'kernel' }))[0], `Roster unavailable. ${NONE} OATS says: ${`first ${long}`.slice(0, 300)}`);
  assert.equal((await failed({ error: long }))[0], `Roster unavailable: ${long.slice(0, 300)}. ${NONE}`);
  assert.equal((await failed({ error: '<b>bold</b>', errorOrigin: 'kernel' }))[0], `Roster unavailable. ${NONE} OATS says: <b>bold</b>`);
  // "read failed" is a thrown error with no message, not a kept failure.
  const thrown = await setup(t, { api: () => Promise.reject(new Error('')) }); await tick();
  assert.equal(thrown.notice(), `Roster unavailable: read failed. ${NONE}`); thrown.dispose();
});

test("a failed read that kept no rows, over an observation already on screen: the same forms around the Desktop's sentence for what stays shown", async t => {
  const LAST = 'Showing the last observation, not current state; actions disabled.';
  const u = await setup(t, { instances: [instance('a')] }); await tick();
  const after = async (extra) => { u.setRead(() => panel([], currentWorkspace(), extra)); await u.poll(); await tick(); return u.notice(); };
  assert.equal(await after({ error: 'the cache is locked', errorOrigin: 'kernel' }), `Roster unavailable. ${LAST} OATS says: the cache is locked`);
  assert.equal(u.nodes().length, 1, 'the last observation stays painted');
  assert.equal(await after({ error: 'bell\u0007', errorOrigin: 'kernel' }), `Roster unavailable. ${LAST} [withheld]`);
  assert.equal(await after({ error: '', errorOrigin: 'kernel' }), `Roster unavailable. ${LAST}`);
  assert.equal(await after({ error: 'the cache is locked' }), `Roster unavailable: the cache is locked. ${LAST}`);
  assert.equal(await after({ error: 'token: abc123' }), `Roster unavailable: [withheld]. ${LAST}`);
  assert.equal(await after({ error: '' }), `Roster unavailable. ${LAST}`);
});

test('a Herdr-recorded instance: the popover disables Go to instance with the kernel reason as its title, and offers no Restart', async t => {
  const reason = 'E_HERDR_REMOVED: Herdr is no longer supported by OATS (removed in 0.31.0); tmux is the only session backend.';
  const u = await setup(t, { instances: [instance('h1', { running: null, runtimeState: 'unsupported', runtimeError: reason })] }); await tick();
  u.mouse(u.nodes()[0], 'click');
  const terminal = u.one('.pterm');
  assert.equal(terminal.disabled, true); assert.equal(terminal.title, reason); assert.equal(terminal.textContent, 'Go to instance');
  assert.equal(u.one('.prestart'), null, 'Restart with… is the roster menu\'s and the instance panel\'s');
});

test('a Herdr-recorded instance: the popover says who made the reason (#982): each speaker the panel names, none, and a hostile text as text or withheld', async t => {
  const reason = 'E_HERDR_REMOVED: Herdr is no longer supported by OATS (removed in 0.31.0); tmux is the only session backend.';
  const cases = [['kernel', `OATS says: ${reason}`], ['terminal-probe', `Desktop's terminal check says: ${reason}`], ['roster-read', `Desktop's read of other machines says: ${reason}`],
    [undefined, reason], ['server-probe', reason], [{ lead: 'kernel' }, reason]];
  for (const [origin, line] of cases) {
    const u = await setup(t, { instances: [instance('h1', { running: null, runtimeState: 'unsupported', runtimeError: reason, ...(origin ? { runtimeErrorOrigin: origin } : {}) })] }); await tick();
    u.mouse(u.nodes()[0], 'click');
    assert.equal(u.one('.pterm').title, line, String(origin));
    assert.equal(u.one('.pterm').disabled, true);
    u.dispose();
  }
  for (const [text, line] of [['E_HERDR_REMOVED: <b>bold</b>', 'OATS says: E_HERDR_REMOVED: <b>bold</b>'], ['E_HERDR_REMOVED: gone\u001b[2J', '[withheld]']]) {
    const u = await setup(t, { instances: [instance('h1', { running: null, runtimeState: 'unsupported', runtimeError: text, runtimeErrorOrigin: 'kernel' })] }); await tick();
    u.mouse(u.nodes()[0], 'click');
    assert.equal(u.one('.pterm').title, line); assert.equal(u.one('.pterm').disabled, true);
    u.dispose();
  }
  // The stand-in for an older kernel's row is written here: no lead beside another marked text.
  const u = await setup(t, { instances: [instance('h1', { backend: 'herdr', runtimeError: 'another text', runtimeErrorOrigin: 'kernel' })] }); await tick();
  u.mouse(u.nodes()[0], 'click');
  assert.equal(u.one('.pterm').title, reason);
});

/* ── #461: a deployment the server does not serve, or does not answer for ── */
const notServed = () => Promise.reject(Object.assign(new Error("This Desktop's server isn't serving this deployment."), { code: NOT_SERVED_CODE, status: 404 }));

test('not served: the notice names the deployment, offers Retry and Re-add, and the status line says it once', async t => {
  const added = [];
  const u = await setup(t, { api: notServed, ctx: { reAddWorkspace: async path => { added.push(path); return { ok: true, workspace: { id: path } }; } } }); await tick();
  assert.match(u.notice(), /^This Desktop's server isn't serving this deployment: \/team\. Re-add the workspace, or retry\. No current observation\.$/);
  assert.equal(u.one('.hier-readd').hidden, false); assert.equal(u.one('.hier-retry').hidden, false);
  assert.match(u.status(), /^Couldn't refresh roster\./); assert.equal(u.sum().textContent, 'Roster unknown');
  assert.doesNotMatch(u.host.textContent, /Reading the deployment/);
  // Re-add: that exact path through the normal add, then a read of the now-served deployment.
  u.setRead(() => panel([instance('a')]));
  u.one('.hier-readd').click(); await tick(); await tick();
  assert.deepEqual(added, ['/team']);
  assert.equal(u.notice(), ''); assert.equal(u.nodes().length, 1);
});

test('not served without an add bridge (a hosted view) offers Retry only', async t => {
  const u = await setup(t, { api: notServed }); await tick();
  assert.match(u.notice(), /isn't serving this deployment: \/team/);
  assert.equal(u.one('.hier-readd').hidden, true);
});

test('a refused Re-add says why and keeps the notice', async t => {
  const u = await setup(t, { api: notServed, ctx: { reAddWorkspace: async () => ({ ok: false, reason: 'path does not exist' }) } }); await tick();
  u.one('.hier-readd').click(); await tick();
  assert.equal(u.notice(), "Couldn't re-add /team: path does not exist");
});

test('pending past the bound is "No answer" (no Re-add); Retry restarts the wait', async t => {
  let now = 5_000_000; t.mock.method(Date, 'now', () => now);
  const pending = () => panel([], currentWorkspace(), { deployment: { status: 'pending' } });
  const u = await setup(t, { api: pending, ctx: { reAddWorkspace: async () => ({ ok: true }) } }); await tick();
  assert.equal(u.sum().textContent, 'Reading the deployment through the installed OATS CLI…');
  now += PENDING_LIMIT_MS - 1; await u.poll(); await tick(); assert.equal(u.notice(), '', 'inside the bound');
  now += 1; await u.poll(); await tick();
  assert.match(u.notice(), /^No answer from the Desktop's server for this deployment: \/team\./);
  assert.equal(u.one('.hier-readd').hidden, true, 'served, only slow: no Re-add');
  assert.equal(u.root().hasAttribute('aria-busy'), false, 'an answer, not a wait');
  u.retry(); await tick();
  assert.equal(u.notice(), '', 'Retry restarts the bounded wait');
  assert.equal(u.sum().textContent, 'Reading the deployment through the installed OATS CLI…');
});

/** Every text the polite status line took, in order. */
function statusHistory(u) {
  const el = u.one('.hier-status'), seen = [];
  const record = () => { if (seen.at(-1) !== el.textContent) seen.push(el.textContent); };
  new u.dom.window.MutationObserver(record).observe(el, { childList: true, characterData: true, subtree: true });
  return { seen, flush: async () => { await tick(); record(); } };
}

test('background re-reads of a failed overview are not announced again: no "Loading…" between failures', async t => {
  const u = await setup(t, { api: notServed }); await tick();
  const said = u.status(), history = statusHistory(u);
  await u.poll(); await tick(); await u.poll(); await tick(); await history.flush();
  assert.deepEqual(history.seen.filter(text => text !== said), [], JSON.stringify(history.seen));
});

test('a transport failure past the bound is "No answer" by name; inside it, the generic notice', async t => {
  let now = 5_000_000; t.mock.method(Date, 'now', () => now);
  const u = await setup(t, { api: () => Promise.reject(new Error('timed out')) }); await tick();
  assert.match(u.notice(), /^Roster unavailable: timed out\./);
  now += PENDING_LIMIT_MS; await u.poll(); await tick();
  assert.match(u.notice(), /^No answer from the Desktop's server for this deployment: \/team\./);
  assert.equal(u.one('.hier-readd').hidden, true);
});

test('pending after an observation keeps it (no pending copy, no notice); past the bound it is stale with "No answer"', async t => {
  let now = 5_000_000, connection = 0; t.mock.method(Date, 'now', () => now);
  const u = await setup(t, { instances: [instance('a'), instance('b')], ctx: { connectionGeneration: () => connection } }); await tick();
  assert.equal(u.nodes().length, 2); const summary = u.sum().textContent;
  connection = 1; u.setRead(() => panel([], currentWorkspace(), { deployment: { status: 'pending' } }));
  await u.poll(); await tick();
  assert.equal(u.nodes().length, 2); assert.equal(u.sum().textContent, summary); assert.equal(u.notice(), '');
  assert.equal(u.root().hasAttribute('aria-busy'), false);
  now += PENDING_LIMIT_MS; await u.poll(); await tick();
  assert.equal(u.nodes().length, 2, 'the last observation stays');
  assert.match(u.notice(), /^No answer from the Desktop's server for this deployment: \/team\. .*Showing the last observation/);
});

test('a Re-add outcome belongs to its own selection: after A→B→A it reads nothing; a refusal never replaces a newer observation', async t => {
  let add = deferred(), reads = 0, answer = notServed;
  const u = await setup(t, { api: () => { reads++; return answer(); }, ctx: { reAddWorkspace: () => add.promise } }); await tick();
  u.one('.hier-readd').click(); await tick();
  setWorkspace('/other'); await tick(); setWorkspace('/team'); await tick();
  const before = reads; add.resolve({ ok: true }); await tick(); await tick();
  assert.equal(reads, before, 'the superseded Re-add starts no read');
  // A refusal that arrives after a poll observed the deployment: the observation stands.
  add = deferred(); u.one('.hier-readd').click(); await tick();
  answer = () => panel([instance('a')]); await u.poll(); await tick();
  assert.equal(u.nodes().length, 1); assert.equal(u.notice(), '');
  add.resolve({ ok: false, reason: 'path does not exist' }); await tick();
  assert.equal(u.notice(), '', 'no failure over the newer observation'); assert.equal(u.nodes().length, 1);
});

/** The shipped 4 s poll callback and the window clock, a second at a time; Date.now follows. No refresh by hand. */
function shippedSchedule(u, clockNow) {
  let elapsed = 0;
  return async seconds => {
    for (let n = 0; n < seconds; n++) {
      elapsed += 1000; clockNow.value += 1000; u.c.advance(1000); await tick(); await tick();
      if (elapsed % 4000 === 0) { u.poll(); await tick(); await tick(); }
    }
  };
}

test('the shipped poll with a read that never answers: "No answer" at exactly the bound, with one read in flight', async t => {
  const clockNow = { value: 5_000_000 }; t.mock.method(Date, 'now', () => clockNow.value);
  let reads = 0;
  const u = await setup(t, { api: () => { reads++; return new Promise(() => {}); } }); await tick();
  const run = shippedSchedule(u, clockNow);
  await run(44);
  assert.equal(reads, 1, 'the stuck read holds every poll'); assert.equal(u.notice(), '');
  await run(1);
  assert.match(u.notice(), /^No answer from the Desktop's server for this deployment: \/team\. .*No current observation\./);
  assert.match(u.status(), /No answer from the Desktop's server for this deployment: \/team/);
  assert.equal(reads, 1, 'said without another read');
});

test('the shipped poll with the proxy\'s 20 s timeouts: the generic notice inside the bound, "No answer" at 45 s', async t => {
  const clockNow = { value: 5_000_000 }; t.mock.method(Date, 'now', () => clockNow.value);
  let reads = 0;
  const u = await setup(t, { api: () => { reads++; return new Promise((_, reject) => globalThis.window.setTimeout(() => reject(new Error('timed out')), 20_000)); } }); await tick();
  const run = shippedSchedule(u, clockNow);
  await run(44);
  assert.match(u.notice(), /^Roster unavailable: timed out\./);
  await run(1);
  assert.match(u.notice(), /^No answer from the Desktop's server for this deployment: \/team\./);
  assert.ok(reads <= 3, `no extra full read cycle was needed: ${reads}`);
});

test('the deadline is the view\'s: teardown cancels it', async t => {
  const clockNow = { value: 5_000_000 }; t.mock.method(Date, 'now', () => clockNow.value);
  const u = await setup(t, { api: () => new Promise(() => {}) }); await tick();
  const line = u.one('.hier-status'); u.dispose(); const said = line.textContent;
  u.c.advance(PENDING_LIMIT_MS * 2); await tick();
  assert.equal(line.textContent, said, 'nothing fires into a torn-down view');
});

test('the shipped poll across a connection change with a read unresolved: a read on the new connection at once, its own 45 s, and the old read can neither paint nor cancel it', async t => {
  const clockNow = { value: 5_000_000 }; t.mock.method(Date, 'now', () => clockNow.value);
  let connection = 0; const listeners = new Set(), reads = [];
  const u = await setup(t, { api: () => { const d = deferred(); reads.push(d); return d.promise; },
    ctx: { connectionGeneration: () => connection, subscribeConnections: fn => { listeners.add(fn); return () => listeners.delete(fn); } } }); await tick();
  const run = shippedSchedule(u, clockNow);
  await run(10); assert.equal(reads.length, 1, 'the stuck read holds the poll');
  connection = 1; for (const fn of [...listeners]) fn(); await tick();
  assert.equal(reads.length, 2, 'the new connection reads at once');
  reads[0].resolve(panel([instance('old')])); await tick(); await tick();
  assert.equal(u.nodes().length, 0, 'the old read is revoked: it paints nothing');
  await run(34); // t = 44 s
  assert.equal(u.notice(), '', 'the old deadline went with its subject');
  await run(11); // t = 55 s
  assert.match(u.notice(), /^No answer from the Desktop's server for this deployment: \/team\./);
  assert.equal(reads.length, 2, 'said without another read');
  reads[1].resolve(panel([instance('a')])); await tick(); await tick();
  assert.equal(u.notice(), ''); assert.equal(u.nodes().length, 1, 'the new connection\'s late answer lands');
  u.dispose(); assert.equal(listeners.size, 0, 'teardown unsubscribes');
});

test('an empty deployment\'s observed answer, as the server sends it, is the empty overview (never "Reading the deployment…"); refresh still works', async t => {
  const empty = panel([], currentWorkspace(), { deployment: { status: 'observed', root: '/team/agents', workspace: { name: 'web', key: 'k' }, reachable: { reachable: true }, withheld: [],
    catalog: { souls: [], ambiguous: [], reason: null, observedAt: null, refreshing: false } }, observedAt: '2026-10-02T00:00:00.000Z', refreshing: false, running: 0 });
  const u = await setup(t, { api: () => empty }); await tick();
  assert.ok(u.one('.empty'), 'the empty copy'); assert.equal(u.notice(), '');
  assert.doesNotMatch(u.host.textContent, /Reading the deployment/); assert.equal(u.root().hasAttribute('aria-busy'), false);
  u.setRead(() => panel([instance('a')])); await u.poll(); await tick();
  assert.equal(u.nodes().length, 1);
});
