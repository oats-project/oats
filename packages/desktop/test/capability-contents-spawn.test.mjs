// Spec C through the real Workspace view (views/spawn.mjs): the capability page's Contents follows the CURRENT
// catalog row — a refresh that moves the commit re-reads `capabilities show`, a row that leaves the catalog says so,
// and an answer at another commit than the row's re-reads the catalog, then renders once the row catches up.
// Setup mirrors capabilities-loading-states.test.mjs (fixtures f2, a fake window clock).
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import * as spawn from '../renderer/views/spawn.mjs';
import { currentWorkspace, setWorkspace } from '../renderer/views/common.mjs';
import { refreshCli } from '../renderer/views/cli-status.mjs';
import { workspaceStatusData, deploymentStatusData } from '../../client/deployment-data.mjs';
import { soulInspection } from './helpers/inspect-fixture.mjs';
import { CONTENTS_COPY } from '../renderer/capability-contents.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 4; i++) await tick(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const f2 = name => JSON.parse(readFileSync(new URL(`./fixtures/workspace-v2/f2/${name}.json`, import.meta.url), 'utf8'));
const dir = '/fixture/base/northwind-workspace';
const CLI = { ...f2('version'), ok: true, bin: '/fixture/bin/oats', operationsApi: 2, features: [...(f2('version').features || []), 'operations', 'capability-show'], relations: true, capabilityShowApi: 1 };
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

async function setup(t, { holdRoster = false, holdReads = false, shows } = {}) {
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
    if (path === '/api/cli') return CLI;
    if (path.startsWith('/api/agents')) { if (!holdRoster) return { agents }; const r = deferred(); rosters.push(r); return r.promise; }
    if (path.startsWith('/api/panel')) return panel();
    if (path.startsWith('/api/workspace-sync')) { if (!holdReads) return okRead(); const r = deferred(); reads.push({ ...r, body }); return r.promise; }
    if (path.startsWith('/api/capabilities') && body?.action === 'show') return shows.answer(body);
    if (path.startsWith('/api/capabilities') && body?.action === 'inspect') return soulInspection(body.selector.soul || 'release-manager');
    if (path.startsWith('/api/servers')) return { servers: [] };
    throw new Error(`Unexpected fixture API request: ${path}`);
  } };
  const doc = dom.window.document;
  t.after(() => { spawn.unmount(); setWorkspace(saved.ws); globalThis.document = saved.document; globalThis.window = saved.window; globalThis.setInterval = saved.setInterval; dom.window.close(); });
  setWorkspace('/team'); await refreshCli({ api: async () => CLI });
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

const ROW = CATALOG.capabilities.find(r => r.name === 'nw-house-style');
const at = c => ({ name: ROW.name, kind: 'member', repoKey: ROW.repoKey, package: null, version: null, commit: c, path: ROW.path ?? null, capabilityShowApi: 1,
  inject: { path: 'inject.md', bytes: 12, text: `# Inject at ${c.slice(0, 7)}`, binary: false, truncated: false }, skills: [], problems: [] });
const movedCatalog = commit => { const c = structuredClone(CATALOG); Object.assign(c.capabilities.find(r => r.name === ROW.name), { commit, description: `At ${commit.slice(0, 7)}.`, skills: [`skill-${commit.slice(0, 3)}`] }); return c; };
async function openFromCatalog(t, answer) {
  const asked = [];
  const u = await setup(t, { holdReads: true, shows: { answer: body => { asked.push(body); return answer(body); } } });
  await u.resolveRead(0, okRead()); await u.tab('capabilities');
  u.q(`.cap-row[data-capability="${ROW.name}"]`).click(); await settle();
  return { ...u, asked, lead: () => u.q('.cap-contents-section .page-section-lead'), reader: () => u.q('.cap-reader-body')?.textContent.trim() };
}

test('catalog form: a refresh that moves the row\'s commit re-reads Contents; a row that leaves the catalog says so', async t => {
  assert.equal(ROW.kind, 'member'); assert.match(ROW.commit, /^[0-9a-f]{40}$/);
  let answer = at(ROW.commit);
  const u = await openFromCatalog(t, () => answer);
  assert.equal(u.lead().textContent, `What an instance gets, at ${ROW.commit.slice(0, 7)}`);
  assert.deepEqual(u.asked[0], { action: 'show', capability: { name: ROW.name, kind: 'member', repoKey: ROW.repoKey } });
  const moved = 'b'.repeat(40); answer = at(moved);
  await u.cliEmit(); await u.resolveRead(1, okRead({ capabilities: movedCatalog(moved) }));
  assert.equal(u.asked.length, 2, 'the moved row is read again');
  assert.equal(u.lead().textContent, 'What an instance gets, at bbbbbbb');
  assert.match(u.reader(), /Inject at bbbbbbb/);
  // The whole page follows the same row: its provenance never shows another commit than its contents.
  const latest = [...u.doc.querySelectorAll('details.cap-fold[data-fold="source"] .page-kv')].find(r => r.querySelector('dt').textContent === 'Latest').querySelector('dd');
  assert.equal(latest.textContent, 'bbbbbbb'); assert.equal(latest.title, moved);
  assert.equal(u.q('.capability-page .page-lede').textContent, 'At bbbbbbb.');
  // Skills are the answer's at the same commit (it ships none), not the catalog's names.
  assert.equal(u.q('.capability-page .cap-skills-note').textContent, CONTENTS_COPY.skillsNone);
  const gone = structuredClone(CATALOG); gone.capabilities = gone.capabilities.filter(r => r.name !== ROW.name);
  await u.cliEmit(); await u.resolveRead(2, okRead({ capabilities: gone }));
  assert.equal(u.q('.cap-contents-gate').textContent, CONTENTS_COPY.unlisted);
  assert.equal(u.q('.cap-contents').hidden, true);
  assert.equal(u.asked.length, 2, 'no read for a row the catalog no longer lists');
});

test('an answer at another commit than the row re-reads the catalog live, and renders once the row catches up', async t => {
  const head = 'c'.repeat(40);
  const u = await openFromCatalog(t, () => at(head)); // the member moved after the catalog read
  assert.equal(u.q('.cap-contents-nav .loading-failed-message').textContent, CONTENTS_COPY.moved);
  assert.equal(u.q('[role=tree]'), null, 'nothing of the other commit is rendered');
  const reread = u.reads_().at(-1);
  assert.equal(reread.refresh, true, 'the catalog is re-read live');
  await u.resolveRead(u.reads.length - 1, okRead({ capabilities: movedCatalog(head) }));
  assert.equal(u.q('.cap-contents-nav .loading-failed'), null);
  assert.equal(u.lead().textContent, 'What an instance gets, at ccccccc');
  assert.match(u.reader(), /Inject at ccccccc/);
});
