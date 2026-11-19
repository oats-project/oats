// desktop/loading-states item 5: the Souls grid's data states — pending (card skeletons after 150ms,
// never an empty message), ready, refreshing (cards stay), stale (cards kept, "Couldn't refresh souls"
// with Retry above the grid), failed (cause + Retry in the grid), empty only after a successful zero
// read; an unchanged poll never rebuilds the cards. Timers run on a fake window clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import * as spawn from '../renderer/views/spawn.mjs';
import { currentWorkspace, setWorkspace } from '../renderer/views/common.mjs';
import { refreshCli } from '../renderer/views/cli-status.mjs';
import { PENDING_DELAY_MS, REFRESHING_DELAY_MS } from '../renderer/loading.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const CLI = { ok: true, operationsApi: 2, features: ['operations'], relations: true };
const soul = (name, agentsRoot = '/a/agents') => ({ name, agentsRoot, runtime: 'pi', work: 'worktree', description: `${name} soul`, repoName: 'r' });
const ROSTER = [soul('dev'), soul('ops')];
const observed = { status: 'observed', root: '/a', workspaceStatus: { members: [] } };

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

async function setup(t, { panel = {} } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div>', { url: 'http://localhost' });
  const saved = { document: globalThis.document, window: globalThis.window, setInterval: globalThis.setInterval, ws: currentWorkspace() };
  globalThis.document = dom.window.document; globalThis.window = dom.window;
  const polls = []; globalThis.setInterval = fn => { polls.push(fn); return 0; };
  const timers = clock(dom.window);
  const rosters = [];
  let panelData = { workspace: { id: '/team' }, workspaces: [], instances: [], deployment: observed, ...panel };
  const ctx = {
    hasWorkspaceSwitcher: true,
    api: async (path, opts = {}) => {
      if (path === '/api/cli') return CLI;
      if (path.startsWith('/api/agents')) { const request = deferred(); rosters.push(request); return request.promise; }
      if (path.startsWith('/api/panel')) return panelData;
      if (path.startsWith('/api/servers')) return { servers: [] };
      const body = opts.body ? JSON.parse(opts.body) : {};
      if (path.startsWith('/api/workspace-sync')) return { status: 'unavailable', reason: { code: 'E_TEST', message: 'no catalog in this fixture' } };
      throw new Error(`Unexpected fixture API: ${path} ${JSON.stringify(body)}`);
    },
  };
  const doc = dom.window.document;
  t.after(() => {
    spawn.unmount(); setWorkspace(saved.ws);
    globalThis.document = saved.document; globalThis.window = saved.window; globalThis.setInterval = saved.setInterval;
    dom.window.close();
  });
  setWorkspace('/team'); await refreshCli({ api: async () => CLI });
  spawn.mount(doc.querySelector('#host'), ctx); await tick();
  const q = sel => doc.querySelector(sel);
  return {
    doc, timers, rosters, q,
    grid: () => q('.souls-grid'), status: () => q('.souls-status'), notice: () => q('.souls-notice'), sum: () => q('.souls-sum'),
    cards: () => [...doc.querySelectorAll('.souls-grid .soul-card:not(.skeleton-card)')],
    skeleton: () => q('.souls-grid [data-skeleton]'),
    poll: () => polls.at(-1)(),
    setPanel: next => { panelData = { ...panelData, ...next }; },
    resolve: async (index, reply) => { rosters[index].resolve(reply); await tick(); await tick(); },
    reject: async (index, error) => { rosters[index].reject(error); await tick(); await tick(); },
    text: () => q('.souls-grid').textContent,
  };
}

test('pending: no empty message, no "Loading souls…" block; card skeletons at the real card structure after 150ms; a fast reply never flashes them', async t => {
  const u = await setup(t);
  assert.equal(u.grid().getAttribute('aria-busy'), 'true'); assert.equal(u.status().textContent, 'Loading souls…');
  assert.equal(u.grid().childElementCount, 0, 'nothing before 150ms');
  assert.doesNotMatch(u.doc.body.textContent, /No souls are materialized|Nothing matches|Loading agents|loading-block/);
  u.timers.advance(PENDING_DELAY_MS - 1); assert.equal(u.skeleton(), null);
  u.timers.advance(1);
  const sk = u.skeleton(); assert.ok(sk, 'the skeleton after 150ms'); assert.equal(sk.getAttribute('aria-hidden'), 'true');
  assert.ok(sk.classList.contains('souls-group'), 'shaped like a group'); assert.ok(sk.querySelector('.souls-group-cards'));
  const cardBones = sk.querySelectorAll('.soul-tile > .soul-card'); assert.ok(cardBones.length >= 2, 'one row plus one (jsdom: one column)');
  for (const card of cardBones) { assert.ok(card.querySelector('.sbody .sname .glyph.skeleton')); assert.ok(card.querySelector('.sbody .sdesc')); assert.ok(card.querySelector('.sfoot .skeleton')); }
  assert.equal(sk.textContent, '', 'no text in a skeleton');
  assert.equal(u.cards().length, 0);
  await u.resolve(0, { agents: ROSTER, catalog: { reason: null, ambiguous: [] } });
  assert.equal(u.skeleton(), null); assert.equal(u.cards().length, 2); assert.equal(u.grid().getAttribute('aria-busy'), null);
  assert.equal(u.status().textContent, '', 'a background load is not announced on completion');
  // A fast reply: nothing pending ever shows.
  u.poll(); await tick(); await u.resolve(1, { agents: ROSTER, catalog: { reason: null, ambiguous: [] } });
  assert.equal(u.skeleton(), null);
});

test('a successful zero read is empty (the existing copy); an unobserved deployment says so in its own words and stays pending, no skeleton', async t => {
  const u = await setup(t);
  await u.resolve(0, { agents: [], catalog: { reason: null, ambiguous: [] } });
  assert.equal(u.text(), 'No souls are materialized in this deployment yet.'); assert.equal(u.grid().getAttribute('aria-busy'), null);
  const v = await setup(t, { panel: { deployment: { status: 'pending' } } });
  v.timers.advance(PENDING_DELAY_MS);
  await v.resolve(0, { agents: [] });
  assert.equal(v.skeleton(), null); assert.equal(v.grid().getAttribute('aria-busy'), 'true', 'still pending: the deployment is not observed yet');
  assert.equal(v.text(), 'Reading the deployment through the installed OATS CLI…');
  assert.equal(v.status().textContent, 'Loading souls…');
});

test('an observed deployment still reading its list (refreshing, nothing held) keeps the skeleton and never says empty', async t => {
  const u = await setup(t);
  await u.resolve(0, { agents: [], catalog: { reason: null, ambiguous: [] }, refreshing: true, observedAt: null });
  assert.equal(u.grid().getAttribute('aria-busy'), 'true'); assert.doesNotMatch(u.text(), /No souls/);
  u.timers.advance(PENDING_DELAY_MS); assert.ok(u.skeleton(), 'the skeleton arrives: the list is being read');
  u.poll(); await tick(); await u.resolve(1, { agents: ROSTER, catalog: { reason: null, ambiguous: [] }, refreshing: false });
  assert.equal(u.skeleton(), null); assert.equal(u.cards().length, 2);
});

// The Workspace page is the home surface (2026-10-23), so the Souls grid reads at launch, while the server makes its
// first observation. Its two reads run side by side: /api/agents answered before that observation (the server's
// agentsData: nothing listed, no `catalog`) and /api/panel after it (observed) is no read of the souls. The grid keeps
// its loading state until the first read of the list lands, never "No souls are materialized".
test('launch: an empty souls answer from before the first observation, beside an observed panel, keeps the grid loading until the list lands', async t => {
  const u = await setup(t);
  await u.resolve(0, { workspace: { id: '/team', name: 'Team' }, agents: [], observedAt: null, refreshing: false });
  assert.doesNotMatch(u.text(), /No souls are materialized/);
  assert.equal(u.grid().getAttribute('aria-busy'), 'true', 'still loading'); assert.equal(u.status().textContent, 'Loading souls…');
  u.timers.advance(PENDING_DELAY_MS); assert.ok(u.skeleton(), 'the skeleton, as for any first read');
  // The next poll reads the list: the cards replace the skeleton.
  u.poll(); await tick(); await u.resolve(1, { agents: ROSTER, catalog: { reason: null, ambiguous: [] } });
  assert.equal(u.skeleton(), null); assert.equal(u.cards().length, 2); assert.equal(u.grid().getAttribute('aria-busy'), null);
  // A real zero read (a `catalog` with nothing listed) is still empty, and a remote view's (its panel names no deployment) too.
  const v = await setup(t);
  await v.resolve(0, { agents: [], catalog: { reason: null, ambiguous: [] }, refreshing: false });
  assert.equal(v.text(), 'No souls are materialized in this deployment yet.');
  const remote = await setup(t, { panel: { deployment: undefined, workspace: { id: '/team', remote: true } } });
  await remote.resolve(0, { workspace: { id: '/team', server: 'devbox' }, agents: [], observedAt: null, refreshing: false });
  assert.equal(remote.text(), 'No souls are materialized in this deployment yet.');
});

test('launch: a deployment read first as pending, then observed with its list still being read, drops its own copy for the skeleton', async t => {
  const u = await setup(t, { panel: { deployment: { status: 'pending' } } });
  await u.resolve(0, { agents: [], observedAt: null, refreshing: false });
  assert.equal(u.text(), 'Reading the deployment through the installed OATS CLI…');
  u.setPanel({ deployment: observed });
  u.poll(); await tick();
  await u.resolve(1, { agents: [], catalog: { reason: null, ambiguous: [] }, observedAt: null, refreshing: true });
  assert.equal(u.text(), '', 'the deployment\'s copy is gone: the list is being read');
  assert.equal(u.grid().getAttribute('aria-busy'), 'true');
  u.timers.advance(PENDING_DELAY_MS); assert.ok(u.skeleton(), 'the skeleton arrives');
  u.poll(); await tick(); await u.resolve(2, { agents: ROSTER, catalog: { reason: null, ambiguous: [] } });
  assert.equal(u.skeleton(), null); assert.equal(u.cards().length, 2);
});

test('refreshing: the cards stay and keep focus; "Refreshing…" only after 400ms; an unchanged poll does not rebuild the cards', async t => {
  const u = await setup(t);
  await u.resolve(0, { agents: ROSTER, catalog: { reason: null, ambiguous: [] } });
  const [dev] = u.cards(); dev.focus(); assert.equal(u.doc.activeElement, dev);
  u.poll(); await tick();
  assert.equal(u.grid().getAttribute('aria-busy'), null, 'refreshing is not busy'); assert.equal(u.cards()[0], dev, 'the cards stay');
  assert.equal(u.q('.souls-bar .loading-refreshing'), null);
  u.timers.advance(REFRESHING_DELAY_MS); assert.equal(u.q('.souls-bar .loading-refreshing')?.textContent, 'Refreshing…');
  await u.resolve(1, { agents: ROSTER, catalog: { reason: null, ambiguous: [] } });
  assert.equal(u.q('.souls-bar .loading-refreshing'), null);
  assert.equal(u.cards()[0], dev, 'identical data: the same nodes'); assert.equal(u.doc.activeElement, dev, 'focus survives');
  // Changed data repaints: a new soul appears.
  u.poll(); await tick(); await u.resolve(2, { agents: [...ROSTER, soul('qa')], catalog: { reason: null, ambiguous: [] } });
  assert.equal(u.cards().length, 3); assert.notEqual(u.cards()[0], dev, 'a changed roster is rebuilt');
  assert.equal(u.doc.activeElement?.dataset.agent, 'dev', 'and the focused card is found again by identity');
});

test('stale: a failed poll keeps the cards, says "Couldn\'t refresh souls" with the cause behind Details and Retry above the grid; Retry re-reads and announces', async t => {
  const u = await setup(t);
  await u.resolve(0, { agents: ROSTER, catalog: { reason: null, ambiguous: [] } });
  u.poll(); await tick(); await u.reject(1, Object.assign(new Error('bridge down'), { code: 'E_BRIDGE' }));
  assert.equal(u.cards().length, 2, 'the last good list stays');
  const line = u.notice().querySelector('.loading-notice[data-kind=stale]'); assert.ok(line);
  assert.equal(line.querySelector('.loading-notice-text').textContent, "Couldn't refresh souls");
  assert.equal(line.querySelector('.loading-notice-cause').textContent, 'bridge down (E_BRIDGE)');
  assert.equal(u.status().textContent, "Couldn't refresh souls."); assert.ok(u.status().classList.contains('loading-quiet'), 'one visible message');
  assert.equal(u.sum().classList.contains('workspace-sr-only'), true, 'the count summary is no longer hijacked for the error');
  assert.doesNotMatch(u.sum().textContent, /Unable to refresh|Retrying/);
  const retry = line.querySelector('.loading-retry'); retry.focus(); retry.click(); await tick();
  assert.equal(u.rosters.length, 3, 'Retry re-reads'); assert.equal(retry.getAttribute('aria-disabled'), 'true'); assert.equal(u.doc.activeElement, retry, 'never `disabled`');
  retry.click(); await tick(); assert.equal(u.rosters.length, 3, 'a repeat activation while busy is ignored');
  await u.resolve(2, { agents: ROSTER, catalog: { reason: null, ambiguous: [] } });
  assert.equal(u.notice().childElementCount, 0, 'the line leaves on success'); assert.equal(u.status().textContent, 'Souls updated', 'a user-invoked read is announced');
  assert.equal(u.status().classList.contains('loading-quiet'), false);
  assert.equal(u.doc.activeElement, u.q('.filter'), 'the vanished Retry hands focus to the search field, never to <body>');
  // The grid's line belongs to the grid: another tab or an open page hides it with the grid.
  u.poll(); await tick(); await u.reject(3, new Error('down again')); assert.ok(u.notice().querySelector('.loading-notice'));
  u.doc.getElementById('workspace-tab-capabilities').click(); await tick();
  assert.equal(u.notice().hidden, true); assert.equal(u.grid().hidden, true);
  u.doc.getElementById('workspace-tab-souls').click(); await tick(); assert.equal(u.notice().hidden, false);
  u.cards()[0].click(); await tick(); await tick(); assert.equal(u.notice().hidden, true, 'a soul page replaces the grid and its line');
});

test('failed: a first read that fails shows the cause, the code behind Details and Retry in the grid — never the empty copy', async t => {
  const u = await setup(t);
  u.timers.advance(PENDING_DELAY_MS); assert.ok(u.skeleton());
  await u.reject(0, Object.assign(new Error('bridge down'), { code: 'E_BRIDGE' }));
  assert.equal(u.skeleton(), null);
  const failed = u.grid().querySelector('.loading-failed'); assert.ok(failed);
  assert.equal(failed.querySelector('.loading-failed-message').textContent, 'bridge down'); assert.equal(failed.querySelector('.loading-failed-code').textContent, 'E_BRIDGE');
  assert.doesNotMatch(u.text(), /No souls|Nothing matches/); assert.equal(u.grid().getAttribute('aria-busy'), null);
  assert.equal(u.status().textContent, "Couldn't refresh souls. bridge down");
  // A CLI flip or a filter edit while failed paints no empty message either.
  const filter = u.q('.filter'); filter.value = 'x'; filter.dispatchEvent(new u.doc.defaultView.Event('input', { bubbles: true }));
  assert.ok(u.grid().querySelector('.loading-failed'), 'the failed block stays'); assert.doesNotMatch(u.text(), /Nothing matches/);
  filter.value = ''; filter.dispatchEvent(new u.doc.defaultView.Event('input', { bubbles: true }));
  const retry = failed.querySelector('.loading-retry'); retry.focus(); retry.click(); await tick();
  assert.equal(u.rosters.length, 2); assert.ok(u.grid().querySelector('.loading-failed'), 'a retry keeps the block, its Retry focused'); assert.equal(u.doc.activeElement, retry);
  await u.resolve(1, { agents: ROSTER, catalog: { reason: null, ambiguous: [] } });
  assert.equal(u.grid().querySelector('.loading-failed'), null); assert.equal(u.cards().length, 2); assert.equal(u.status().textContent, 'Souls updated');
});

test('the kernel\'s catalog reason is a failed read: failed without souls, stale with them (the kernel\'s message kept)', async t => {
  const u = await setup(t);
  await u.resolve(0, { agents: [], catalog: { reason: { code: 'E_WORKSPACE_SYNC', message: 'lock out of date' }, ambiguous: [] } });
  const failed = u.grid().querySelector('.loading-failed'); assert.ok(failed, 'not "No souls are materialized"');
  assert.equal(failed.querySelector('.loading-failed-message').textContent, "Couldn't read this workspace's souls: lock out of date");
  assert.equal(failed.querySelector('.loading-failed-code').textContent, 'E_WORKSPACE_SYNC');
  u.poll(); await tick(); await u.resolve(1, { agents: ROSTER, catalog: { reason: { code: 'E_WORKSPACE_SYNC', message: 'lock out of date' }, ambiguous: [] } });
  assert.equal(u.cards().length, 2); const line = u.notice().querySelector('.loading-notice[data-kind=stale]'); assert.ok(line, 'partial souls with a reason: stale');
  assert.equal(u.status().textContent, "Couldn't refresh souls.");
  // The reason persists across polls: the same line, its focused Retry kept, no second announcement.
  const retry = line.querySelector('.loading-retry'); retry.focus(); u.status().textContent = '';
  u.poll(); await tick(); await u.resolve(2, { agents: ROSTER, catalog: { reason: { code: 'E_WORKSPACE_SYNC', message: 'lock out of date' }, ambiguous: [] } });
  assert.equal(u.notice().querySelector('.loading-notice'), line, 'the same node'); assert.equal(u.doc.activeElement, retry, 'Retry keeps focus');
  assert.equal(u.status().textContent, '', 'not announced again');
});

test('a workspace switch drops the other workspace\'s cards at once and is pending again (no "Loading agents…", no empty message)', async t => {
  const u = await setup(t);
  await u.resolve(0, { agents: ROSTER, catalog: { reason: null, ambiguous: [] } });
  assert.equal(u.cards().length, 2);
  setWorkspace('/other'); await tick();
  assert.equal(u.cards().length, 0); assert.equal(u.grid().getAttribute('aria-busy'), 'true'); assert.equal(u.status().textContent, 'Loading souls…');
  assert.doesNotMatch(u.doc.body.textContent, /Loading agents|No souls are materialized/);
  u.timers.advance(PENDING_DELAY_MS); assert.ok(u.skeleton());
  await u.resolve(1, { agents: [soul('qa')], catalog: { reason: null, ambiguous: [] } });
  assert.equal(u.cards().map(c => c.dataset.agent).join(), 'qa'); assert.equal(u.skeleton(), null);
});

test('the soul page\'s Instances card follows the host roster: a skeleton line while pending, no claim while failed or stale, "No instances yet." only after a good read', async t => {
  const u = await setup(t);
  await u.resolve(0, { agents: ROSTER, catalog: { reason: null, ambiguous: [] } });
  u.cards()[0].click(); await tick(); await tick();
  const card = () => u.q('.workspace-soul-page .inspector-instances');
  assert.ok(card()); assert.equal(card().querySelector('.page-note')?.textContent, 'No instances yet.', 'a good read with none: the empty copy');
  assert.equal(card().querySelector('.page-card-count')?.textContent, '0');
  // A failed poll: the roster is stale — the card makes no claim and shows no count.
  u.poll(); await tick(); await u.reject(1, new Error('down')); await tick();
  assert.equal(card().querySelector('.page-note'), null, 'no "No instances yet." over a stale roster');
  assert.ok(card().querySelector('.inspector-instances-unknown[data-roster-state=stale]')); assert.equal(card().querySelector('.page-card-count'), null, 'no count either');
  // The maintainer's repro (#326): a poll or Retry over the stale roster is 'refreshing' while settled stays 'stale' — Back, open the
  // card again: still no claim, no "0" (the settled state rules, as for the catalog's notice).
  u.poll(); await tick();
  u.q('.workspace-soul-page .inspector-back').click(); await tick(); u.cards()[0].click(); await tick(); await tick();
  assert.equal(card().querySelector('.page-note'), null, 'no "No instances yet." while a re-read runs over a stale roster');
  assert.ok(card().querySelector('.inspector-instances-unknown[data-roster-state=stale]')); assert.equal(card().querySelector('.page-card-count'), null);
  await u.resolve(2, { agents: ROSTER, catalog: { reason: null, ambiguous: [] } });
  assert.equal(card().querySelector('.page-note')?.textContent, 'No instances yet.', 'a good read restores the claim');
  // A workspace switch: pending — a skeleton line, no claim.
  setWorkspace('/other'); await tick();
  u.timers.advance(PENDING_DELAY_MS);
  assert.ok(u.skeleton(), 'the grid is pending'); assert.equal(u.doc.body.textContent.includes('No instances yet.'), false);
});

test('a roster failure discarded because the selection moved still ends the read: the grid is not left "refreshing"', async t => {
  const u = await setup(t);
  await u.resolve(0, { agents: ROSTER, catalog: { reason: null, ambiguous: [] } });
  u.poll(); await tick(); assert.equal(u.q('.souls-grid').getAttribute('aria-busy'), null);
  u.cards()[0].click(); await tick(); // a selection: the in-flight poll no longer owns the selection
  await u.reject(1, new Error('down'));
  assert.equal(u.notice().childElementCount, 0, 'a discarded failure paints no stale line');
  u.timers.advance(REFRESHING_DELAY_MS); assert.equal(u.q('.souls-bar .loading-refreshing'), null, 'and leaves no "Refreshing…" behind');
});

test('retired wording: "Loading agents…", the "Loading souls…" block and "Unable to refresh souls" are gone from the view source', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../renderer/views/spawn.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Loading agents…|loading-block|Unable to refresh souls/);
});
