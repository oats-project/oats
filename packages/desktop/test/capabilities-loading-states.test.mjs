// desktop/loading-states item 6: the Workspace's Capabilities tab — table-row skeletons (the real card
// rows) after 150ms, tab counts that reserve their width with a pill, a held table that is never set to
// null by a CLI emit or a sync (it refreshes in place), a failed re-read that keeps the table stale with
// Retry, and spec 02's held-table shapes. Timers run on a fake window clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import * as spawn from '../renderer/views/spawn.mjs';
import { currentWorkspace, setWorkspace } from '../renderer/views/common.mjs';
import { refreshCli } from '../renderer/views/cli-status.mjs';
import { workspaceStatusData, deploymentStatusData, soulsData } from '../../client/deployment-data.mjs';
import { PENDING_DELAY_MS, REFRESHING_DELAY_MS, SOULS_STALE_TITLE } from '../renderer/loading.mjs';
import { soulInspection } from './helpers/inspect-fixture.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 4; i++) await tick(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const f2 = name => JSON.parse(readFileSync(new URL(`./fixtures/workspace-v2/f2/${name}.json`, import.meta.url), 'utf8'));
const dir = '/fixture/base/northwind-workspace';
const CLI = { ...f2('version'), ok: true, bin: '/fixture/bin/oats', operationsApi: 2, features: [...(f2('version').features || []), 'operations'], relations: true };
const status = workspaceStatusData(f2('workspace-status'), dir);
const roster = deploymentStatusData(f2('status'), dir);
const agents = roster.agents.map(({ instances: _i, ...soul }) => ({ ...soul, agentsRoot: roster.root }));
const CATALOG = { capabilitiesApi: 1, ...f2('capabilities').result };
const okRead = (extra = {}) => ({ workspaceSyncApi: 1, status: 'ok', report: null, capabilities: CATALOG, reason: null, ...extra });
const failedRead = (extra = {}) => ({ workspaceSyncApi: 1, status: 'unavailable', reason: { code: 'E_CLI_TIMEOUT', message: 'The workspace command exceeded its time limit.' }, ...extra });

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

async function setup(t, { holdRoster = false, holdReads = false, cli = CLI, souls = agents, catalog = CATALOG } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div>', { url: 'http://localhost' });
  const saved = { document: globalThis.document, window: globalThis.window, setInterval: globalThis.setInterval, ws: currentWorkspace() };
  globalThis.document = dom.window.document; globalThis.window = dom.window;
  const polls = []; globalThis.setInterval = fn => { polls.push(fn); return 0; };
  const timers = clock(dom.window);
  const rosters = [], reads = [], calls = []; let emits = 0;
  const panel = () => ({ workspace: { id: currentWorkspace(), scope: currentWorkspace() }, workspaces: [], instances: [],
    deployment: { status: 'observed', root: roster.root, workspace: status.workspace, workspaceStatus: status, reachable: { reachable: true }, withheld: [] } });
  const ctx = { hasWorkspaceSwitcher: true, api: async (path, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined; calls.push({ path, body });
    if (path === '/api/cli') return cli;
    if (path.startsWith('/api/agents')) { if (!holdRoster) return { agents: souls }; const r = deferred(); rosters.push(r); return r.promise; }
    if (path.startsWith('/api/panel')) return panel();
    if (path.startsWith('/api/workspace-sync')) { if (!holdReads) return okRead({ capabilities: catalog }); const r = deferred(); reads.push({ ...r, body }); return r.promise; }
    if (path.startsWith('/api/capabilities') && body?.action === 'inspect') return soulInspection(body.selector.soul || 'release-manager');
    if (path.startsWith('/api/servers')) return { servers: [] };
    throw new Error(`Unexpected fixture API request: ${path}`);
  } };
  const doc = dom.window.document;
  t.after(() => { spawn.unmount(); setWorkspace(saved.ws); globalThis.document = saved.document; globalThis.window = saved.window; globalThis.setInterval = saved.setInterval; dom.window.close(); });
  setWorkspace('/team'); await refreshCli({ api: async () => cli });
  spawn.mount(doc.querySelector('#host'), ctx); await settle();
  const q = sel => doc.querySelector(sel);
  return {
    doc, timers, rosters, reads, calls, q,
    tab: async name => { doc.getElementById(`workspace-tab-${name}`).click(); await settle(); },
    count: name => q(`#workspace-tab-${name} .workspace-count`),
    rows: () => [...doc.querySelectorAll('.cap-list button.cap-row')],
    state: () => q('.catalog-state'), skeleton: () => q('.catalog-state [data-skeleton]'), status: () => q('.discovery-load-status'), notice: () => q('.discovery-notice'),
    reads_: () => calls.filter(c => c.path.startsWith('/api/workspace-sync')).map(c => c.body),
    resolveRead: async (index, reply) => { reads[index].resolve(reply); await settle(); },
    poll: () => polls.at(-1)(),
    // A CLI change: subscribers are told on a gate-relevant difference only (#321, cli-probe-contract), never for a fresh probedAt.
    cliEmit: async () => { emits++; await refreshCli({ api: async () => ({ ...CLI, version: `${CLI.version}-emit${emits}` }) }); await settle(); },
  };
}

test('pending: both tab counts are pills; on Capabilities the real card rows as a skeleton after 150ms, aria-busy and "Loading capabilities…"; hidden on other tabs', async t => {
  const u = await setup(t, { holdRoster: true, holdReads: true });
  assert.ok(u.count('souls').querySelector('.skeleton-pill'), 'the Souls count reserves its width'); assert.ok(u.count('capabilities').querySelector('.skeleton-pill'));
  u.rosters[0].resolve({ agents }); await settle();
  assert.equal(u.count('souls').textContent, String(agents.length)); assert.ok(u.count('capabilities').querySelector('.skeleton-pill'), 'the catalog is being read');
  assert.equal(u.reads.length, 1, 'read once on mount, on any tab');
  assert.equal(u.state().hidden, true, 'the Souls tab shows nothing of it'); assert.equal(u.status().hidden, true);
  await u.tab('capabilities');
  assert.equal(u.state().hidden, false); assert.equal(u.state().getAttribute('aria-busy'), 'true'); assert.equal(u.status().textContent, 'Loading capabilities…');
  assert.doesNotMatch(u.doc.body.textContent, /Reading the workspace capabilities/);
  assert.equal(u.skeleton(), null, 'nothing before 150ms'); u.timers.advance(PENDING_DELAY_MS);
  const sk = u.skeleton(); assert.ok(sk); assert.equal(sk.getAttribute('aria-hidden'), 'true'); assert.equal(sk.textContent, '');
  const bones = sk.querySelectorAll('.cap-list > li > .cap-row.skeleton-catalog-row'); assert.ok(bones.length >= 5, 'rows wearing the list classes');
  // The settled row's two lines: its name line, then its one line of what it does; nothing in it takes focus.
  for (const row of bones) { assert.equal(row.tagName, 'DIV'); assert.ok(row.querySelector('.skeleton-name')); assert.ok(row.querySelector('.skeleton-desc')); }
  assert.equal(sk.querySelectorAll('button, [tabindex]').length, 0);
  await u.resolveRead(0, okRead());
  assert.equal(u.rows()[0].firstElementChild.className, 'cap-row-line', 'the skeleton is the settled row: its name line first');
  assert.equal(u.skeleton(), null); assert.equal(u.rows().length, 10); assert.equal(u.state().getAttribute('aria-busy'), null);
  assert.equal(u.count('capabilities').textContent, '10'); assert.equal(u.status().textContent, '');
});

test('a CLI emit never sets the held table to null: it refreshes in place ("Refreshing…" after 400ms), keeps its nodes and focus', async t => {
  const u = await setup(t, { holdReads: true });
  await u.resolveRead(0, okRead()); await u.tab('capabilities');
  const [first] = u.rows(); first.focus(); assert.equal(u.doc.activeElement, first);
  await u.cliEmit();
  assert.equal(u.reads.length, 2, 're-read'); assert.equal(u.rows().length, 10, 'the table stays'); assert.equal(u.rows()[0], first);
  assert.equal(u.count('capabilities').textContent, '10', 'the count stays a number'); assert.equal(u.state().getAttribute('aria-busy'), null);
  assert.equal(u.q('.discovery-refreshing .loading-refreshing'), null); u.timers.advance(REFRESHING_DELAY_MS);
  assert.equal(u.q('.discovery-refreshing .loading-refreshing')?.textContent, 'Refreshing…');
  await u.resolveRead(1, okRead());
  assert.equal(u.q('.discovery-refreshing .loading-refreshing'), null); assert.equal(u.rows()[0], first, 'identical data: the same nodes'); assert.equal(u.doc.activeElement, first);
});

test('a failed re-read keeps the table stale: the line with the cause behind Details and Retry above it; Retry reads live and announces', async t => {
  const u = await setup(t, { holdReads: true });
  await u.resolveRead(0, okRead()); await u.tab('capabilities');
  await u.cliEmit(); await u.resolveRead(1, failedRead());
  assert.equal(u.rows().length, 10, 'Retry keeps the table');
  const line = u.notice().querySelector('.loading-notice[data-kind=stale]'); assert.ok(line);
  assert.equal(line.querySelector('.loading-notice-text').textContent, "Couldn't refresh capabilities");
  assert.equal(line.querySelector('.loading-notice-cause').textContent, 'The workspace command exceeded its time limit. (E_CLI_TIMEOUT)');
  assert.equal(u.status().textContent, "Couldn't refresh capabilities."); assert.ok(u.status().classList.contains('loading-quiet'));
  assert.equal(u.count('capabilities').textContent, '10', 'the last observation stays counted');
  const retry = line.querySelector('.loading-retry'); retry.focus(); retry.click(); await settle();
  assert.deepEqual(u.reads.at(-1).body, { action: 'read', refresh: true }); assert.equal(retry.getAttribute('aria-disabled'), 'true'); assert.equal(u.doc.activeElement, retry);
  retry.click(); await settle(); assert.equal(u.reads.length, 3, 'a repeat activation while busy is ignored');
  await u.resolveRead(2, okRead());
  assert.equal(u.notice().childElementCount, 0); assert.equal(u.status().textContent, 'Capabilities updated'); assert.equal(u.rows().length, 10);
});

test("spec 02's held-table shapes: ok + reason (a failed re-read behind a held table) and non-ok + lastGood both paint the table stale with the observation's age", async t => {
  // The age reads Date.now: one fixed instant for the observation and the view, so each age is exact by construction.
  const now = Date.now(); t.mock.method(Date, 'now', () => now);
  const u = await setup(t, { holdReads: true });
  const old = new Date(now - 3 * 60_000).toISOString();
  await u.resolveRead(0, okRead({ reason: { code: 'E_CLI_TIMEOUT', message: 'timed out' }, observedAt: old, refreshing: false })); await u.tab('capabilities');
  assert.equal(u.rows().length, 10);
  let line = u.notice().querySelector('.loading-notice[data-kind=stale]'); assert.ok(line, 'ok with a reason: stale');
  assert.equal(line.querySelector('.loading-notice-text').textContent, "Couldn't refresh capabilities · observed 3 min ago");
  const v = await setup(t, { holdReads: true });
  await v.resolveRead(0, { workspaceSyncApi: 1, status: 'unavailable', reason: { code: 'E_CLI_FAILED', message: 'bridge down' }, lastGood: { capabilities: CATALOG, observedAt: old } }); await v.tab('capabilities');
  assert.equal(v.rows().length, 10, 'the last good table is shown');
  line = v.notice().querySelector('.loading-notice[data-kind=stale]'); assert.ok(line);
  assert.equal(line.querySelector('.loading-notice-text').textContent, "Couldn't refresh capabilities · observed 3 min ago");
  assert.equal(line.querySelector('.loading-notice-cause').textContent, 'bridge down (E_CLI_FAILED)');
  assert.equal(v.count('capabilities').textContent, '10');
});

test('a successful read of an old observation says so, muted, without Retry; a fresh one says nothing', async t => {
  const now = Date.now(); t.mock.method(Date, 'now', () => now);
  const u = await setup(t, { holdReads: true });
  await u.resolveRead(0, okRead({ observedAt: new Date(now - 5 * 60_000).toISOString() })); await u.tab('capabilities');
  const line = u.notice().querySelector('.loading-notice[data-kind=observed]'); assert.ok(line);
  assert.equal(line.querySelector('.loading-notice-text').textContent, 'Observed 5 min ago'); assert.equal(line.querySelector('.loading-retry'), null);
  const v = await setup(t, { holdReads: true });
  await v.resolveRead(0, okRead({ observedAt: new Date(now).toISOString() })); await v.tab('capabilities');
  assert.equal(v.notice().childElementCount, 0);
});

test('a failed roster read with nothing to show leaves the Souls count empty and still (no pill); a workspace switch makes both counts pills again', async t => {
  const u = await setup(t, { holdRoster: true, holdReads: true });
  u.rosters[0].reject(new Error('down')); await settle();
  assert.equal(u.count('souls').textContent, ''); assert.equal(u.count('souls').querySelector('.skeleton'), null);
  u.poll(); await tick(); u.rosters[1].resolve({ agents }); await settle();
  assert.equal(u.count('souls').textContent, String(agents.length));
  setWorkspace('/other'); await settle();
  assert.ok(u.count('souls').querySelector('.skeleton-pill')); assert.ok(u.count('capabilities').querySelector('.skeleton-pill'));
});

test('retired wording: "Reading the workspace capabilities" and the separate Retry button are gone from the source', () => {
  const source = readFileSync(new URL('../renderer/workspace-discovery.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Reading the workspace capabilities \(|discovery-retry/);
});

// ── item 7: the capability page ─────────────────────────────────────────────────────────────────
const pageOf = u => u.q('.workspace-cap-page .capability-page');

test('opened from a soul before the catalog is read: the page stands with the catalog facts as skeletons, filled in place when they land; focus stays', async t => {
  const u = await setup(t, { holdReads: true });
  u.q('.soul-card').click(); await settle();
  assert.equal(u.q('.workspace-soul-page').hidden, false, 'the soul page');
  const row = u.q('.workspace-soul-page .soul-caps [data-capability="nw-house-style"]'); assert.ok(row, 'the soul lists it'); row.click(); await settle();
  const before = pageOf(u); assert.ok(before); assert.equal(before.dataset.capability, 'nw-house-style'); assert.equal(before.dataset.catalogPending, 'true');
  assert.ok(before.querySelector('.page-lede.skeleton'), 'a lede-sized line where the description goes');
  assert.ok(before.querySelector('.page-facts-skeleton[aria-hidden=true]'), 'a facts-sized block in Comes from'); assert.equal(before.querySelector('.page-notice').childElementCount, 0);
  assert.equal(u.doc.activeElement, before.querySelector('.page-back'));
  await u.resolveRead(0, okRead());
  const after = pageOf(u); assert.notEqual(after, before, 'filled in place'); assert.equal(after.dataset.catalogPending, undefined);
  assert.equal(after.querySelector('.page-lede.skeleton'), null); assert.equal(after.querySelector('.page-facts-skeleton'), null);
  assert.match(after.querySelector('.page-side').textContent, /Path.*capabilities\/nw-house-style/s, "the catalog's facts");
  assert.equal(u.doc.activeElement, after.querySelector('.page-back'), 'focus is kept on the same control');
  assert.equal(u.q('.workspace-cap-page').hidden, false);
});

test('a catalog refresh while the page is open updates it in place: a failed re-read shows the stale line with Retry (reads live); an unchanged catalog never rebuilds it', async t => {
  const u = await setup(t, { holdReads: true });
  await u.resolveRead(0, okRead()); await u.tab('capabilities');
  u.q('.cap-row[data-capability="nw-house-style"]').click(); await settle();
  const first = pageOf(u); assert.ok(first); assert.equal(first.querySelector('.page-notice').childElementCount, 0);
  await u.cliEmit(); await u.resolveRead(1, okRead());
  assert.equal(pageOf(u), first, 'identical catalog: the same page node');
  await u.cliEmit(); await u.resolveRead(2, failedRead());
  assert.equal(pageOf(u), first, 'the page stands; only its age line changes');
  const line = first.querySelector('.page-notice .loading-notice[data-kind=stale]'); assert.ok(line);
  assert.equal(line.querySelector('.loading-notice-text').textContent, "Couldn't refresh capabilities");
  assert.equal(line.querySelector('.loading-notice-cause').textContent, 'E_CLI_TIMEOUT: The workspace command exceeded its time limit.');
  const retry = line.querySelector('.loading-retry'); retry.focus(); retry.click(); await settle();
  assert.deepEqual(u.reads.at(-1).body, { action: 'read', refresh: true });
  assert.equal(retry.getAttribute('aria-disabled'), 'true', 'the page\'s Retry is busy while the re-read runs'); assert.equal(u.doc.activeElement, retry);
  assert.equal(line.querySelector('.loading-notice-cause').textContent, 'E_CLI_TIMEOUT: The workspace command exceeded its time limit.', 'the cause stays while the re-read runs');
  assert.equal(line.querySelector('.loading-notice-details').hidden, false);
  retry.click(); await settle(); assert.equal(u.reads.length, 4, 'a repeat activation while busy is ignored');
  // The re-read fails again: the same line, updated in place, Retry still focused, no busy mark.
  await u.resolveRead(3, failedRead());
  assert.equal(first.querySelector('.page-notice .loading-notice'), line, 'the same node'); assert.equal(u.doc.activeElement, retry); assert.equal(retry.getAttribute('aria-disabled'), null);
  retry.click(); await settle(); await u.resolveRead(4, okRead());
  assert.equal(pageOf(u).querySelector('.page-notice').childElementCount, 0, 'current again');
  assert.equal(u.doc.activeElement, pageOf(u).querySelector('.page-back'), 'a vanished Retry hands focus to Back, never to nowhere');
});

test('the page\'s age line ticks with the roster poll, and a failed Retry with a held table keeps the table\'s line and its focused Retry', async t => {
  const base = Date.now(); let now = base; t.mock.method(Date, 'now', () => now);
  const u = await setup(t, { holdReads: true });
  const old = new Date(base - 3 * 60_000).toISOString();
  await u.resolveRead(0, { workspaceSyncApi: 1, status: 'unavailable', reason: { code: 'E_CLI_FAILED', message: 'bridge down' }, lastGood: { capabilities: CATALOG, observedAt: old } }); await u.tab('capabilities');
  const line = u.notice().querySelector('.loading-notice[data-kind=stale]'); assert.ok(line);
  assert.equal(line.querySelector('.loading-notice-text').textContent, "Couldn't refresh capabilities · observed 3 min ago");
  const retry = line.querySelector('.loading-retry'); retry.focus(); retry.click(); await settle();
  await u.resolveRead(1, { workspaceSyncApi: 1, status: 'unavailable', reason: { code: 'E_CLI_FAILED', message: 'bridge down' }, lastGood: { capabilities: CATALOG, observedAt: old } });
  assert.equal(u.notice().querySelector('.loading-notice'), line, 'a failed Retry updates the line in place'); assert.equal(u.doc.activeElement, retry, 'Retry keeps focus');
  assert.equal(u.status().textContent, "Couldn't refresh capabilities.");
  u.q('.cap-row[data-capability="nw-house-style"]').click(); await settle();
  const pageLine = pageOf(u).querySelector('.page-notice .loading-notice'); assert.ok(pageLine);
  assert.equal(pageLine.querySelector('.loading-notice-text').textContent, "Couldn't refresh capabilities · observed 3 min ago");
  now = base + 6 * 60_000; u.poll(); await settle();
  assert.equal(pageOf(u).querySelector('.page-notice .loading-notice'), pageLine, 'the same node');
  assert.equal(pageLine.querySelector('.loading-notice-text').textContent, "Couldn't refresh capabilities · observed 9 min ago", 'the age ticked with the poll');
});

test('roster-derived "Used by" claims wait for a settled good roster: "—" with the reason while the roster is failed or stale, on the page', async t => {
  const u = await setup(t, { holdRoster: true, holdReads: true });
  u.rosters[0].resolve({ agents }); await settle(); await u.resolveRead(0, okRead()); await u.tab('capabilities');
  u.poll(); await tick(); u.rosters[1].reject(new Error('down')); await settle();
  u.q('.cap-row[data-capability="nw-brand-voice"]').click(); await settle();
  const page = pageOf(u); assert.equal(page.querySelector('.used-unknown')?.textContent, '—', 'the page makes no claim either');
  assert.equal(page.querySelector('.used-unknown').getAttribute('aria-description'), 'Unavailable: roster is not current');
  assert.doesNotMatch(page.textContent, /No instance carries it yet/);
  u.poll(); await tick(); u.rosters[2].resolve({ agents }); await settle();
  assert.match(pageOf(u).textContent, /No instance carries it yet/, 'a good read restores the claim on the open page');
});

// souls-capabilities: "Used by" derives from the souls list (each soul's composition), the same read's state.
// The kernel PR's real capture (fixtures/workspace-v2/souls-capabilities): its souls and its own catalog.
const capture = name => JSON.parse(readFileSync(new URL(`./fixtures/workspace-v2/souls-capabilities/${name}.json`, import.meta.url), 'utf8'));
const COMPOSED_CATALOG = { capabilitiesApi: 1, ...capture('capabilities').result };
const COMPOSED = soulsData(capture('souls')).souls
  .map(s => ({ name: s.name, key: s.key, soulKind: s.kind, ...(s.kind === 'package' ? { package: s.package, version: s.version, qualifiedName: s.qualifiedName } : {}),
    description: s.description || '', kind: 'persistent', work: s.work, capabilities: s.capabilities, agentsRoot: roster.root }));
const COMPOSING_CLI = { ...CLI, features: [...CLI.features, 'souls-capabilities'] };
test('souls-derived "Used by" waits for a settled good souls read: "—" with the souls list\'s reason, on the page', async t => {
  const u = await setup(t, { holdRoster: true, holdReads: true, cli: COMPOSING_CLI });
  const souls = COMPOSED.filter(s => s.key !== 'dev'); // acme_z: only dev composes it
  u.rosters[0].resolve({ agents: souls }); await settle(); await u.resolveRead(0, okRead({ capabilities: COMPOSED_CATALOG })); await u.tab('capabilities');
  u.poll(); await tick(); u.rosters[1].reject(new Error('down')); await settle();
  u.q('.cap-row[data-capability="acme_z"]').click(); await settle();
  assert.equal(pageOf(u).querySelector('.used-unknown').getAttribute('aria-description'), SOULS_STALE_TITLE, 'the page makes no claim either');
  u.poll(); await tick(); u.rosters[2].resolve({ agents: souls }); await settle();
  assert.match(pageOf(u).textContent, /No soul here includes it/, 'a good read restores the claim on the open page');
});

test('the page opens a package soul from "Used by" by its key, never the member soul of its bare name', async t => {
  // The capture's member soul keeper and package soul acme.pkg/keeper both compose acme-tool.
  const u = await setup(t, { cli: COMPOSING_CLI, souls: COMPOSED, catalog: COMPOSED_CATALOG });
  await u.tab('capabilities');
  u.q('.cap-row[data-capability="acme-tool"]').click(); await settle();
  const rows = [...pageOf(u).querySelectorAll('.used-row:not(.head)')];
  assert.deepEqual(rows.map(r => [r.querySelector('.used-name').textContent, r.title]), [['dev', 'Open dev'], ['keeper', 'Open keeper'], ['keeper', 'Open acme.pkg/keeper'], ['scribe', 'Open scribe']]);
  rows[2].click(); await settle();
  assert.equal(pageOf(u), null, 'the capability page closed');
  const soulPage = u.q('.workspace-soul-page');
  assert.match(soulPage.textContent, /keeper package soul\./, 'the package soul\'s page');
  assert.doesNotMatch(soulPage.textContent, /keeper fixture soul\./, 'never the member soul\'s');
  // Which row opens is this page's business; how the soul page then addresses the kernel (a bare-name selector on
  // every soul surface) is the soul page's own, unchanged here.
});

test('a catalog that failed with nothing held shows the failed treatment on the page (cause, Details, Retry), not silence', async t => {
  const u = await setup(t, { holdReads: true });
  await u.resolveRead(0, failedRead()); await u.tab('capabilities');
  // Open a page from a soul (the table has nothing to open from).
  u.doc.getElementById('workspace-tab-souls').click(); await settle(); u.q('.soul-card').click(); await settle();
  u.q('.workspace-soul-page .soul-caps [data-capability="nw-house-style"]').click(); await settle();
  const failed = pageOf(u).querySelector('.page-notice .loading-failed'); assert.ok(failed, 'the failed block under the bar');
  assert.equal(failed.querySelector('.loading-failed-message').textContent, 'The workspace command exceeded its time limit.'); assert.equal(failed.querySelector('.loading-failed-code').textContent, 'E_CLI_TIMEOUT');
  const retry = failed.querySelector('.loading-retry'); retry.focus(); retry.click(); await settle();
  assert.equal(pageOf(u).querySelector('.page-notice .loading-failed'), failed, 'the block is updated in place, not rebuilt'); assert.equal(pageOf(u).querySelector('.page-lede.skeleton'), null, 'a Retry over a failure paints no skeleton');
  assert.deepEqual(u.reads.at(-1).body, { action: 'read', refresh: true }); assert.equal(retry.getAttribute('aria-disabled'), 'true'); assert.equal(u.doc.activeElement, retry);
  await u.resolveRead(1, okRead());
  assert.equal(pageOf(u).querySelector('.page-notice').childElementCount, 0, 'current'); assert.equal(u.doc.activeElement, pageOf(u).querySelector('.page-back'));
});

test('the age rule on the page: an old observation is said, muted, without Retry', async t => {
  const now = Date.now(); t.mock.method(Date, 'now', () => now);
  const u = await setup(t, { holdReads: true });
  await u.resolveRead(0, okRead({ observedAt: new Date(now - 4 * 60_000).toISOString() })); await u.tab('capabilities');
  u.q('.cap-row[data-capability="nw-house-style"]').click(); await settle();
  const line = pageOf(u).querySelector('.page-notice .loading-notice[data-kind=observed]'); assert.ok(line);
  assert.equal(line.querySelector('.loading-notice-text').textContent, 'Observed 4 min ago'); assert.equal(line.querySelector('.loading-retry'), null);
});
