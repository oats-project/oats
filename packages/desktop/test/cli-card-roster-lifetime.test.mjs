// The recovery card is a long-lived action owner inside a polling Workspace.
// Exercise its real mounted caller, not a standalone card replica.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import * as spawn from '../renderer/views/spawn.mjs';
import { resetCliStateForTests } from '../renderer/views/cli-status.mjs';
import { currentWorkspace, setWorkspace } from '../renderer/views/common.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const unavailable = { ok: false, tried: [{ path: '/fixture/old-oats', version: '0.1.0' }], required: { range: 'fixture-band', desktopApi: 1 }, install: 'fixture pinned install command' };
async function setup(t) {
  const dom = new JSDOM('<body><main></main></body>', { url: 'http://127.0.0.1/' });
  const previous = { doc: globalThis.document, interval: globalThis.setInterval, ws: currentWorkspace() };
  globalThis.document = dom.window.document;
  const polls = []; globalThis.setInterval = fn => { polls.push(fn); return 0; };
  setWorkspace('/fixture'); resetCliStateForTests();
  const choose = deferred(), requests = [];
  let empty = false;
  const ctx = {
    hasWorkspaceSwitcher: true,
    chooseCliBinary: () => choose.promise,
    api: async (path, opts) => {
      if (path === '/api/cli') return unavailable;
      if (path === '/api/cli/reprobe') {
        const request = { ...deferred(), body: JSON.parse(opts.body) }; requests.push(request); return request.promise;
      }
      if (path.startsWith('/api/agents')) return { agents: empty ? [] : [{ name: 'fixture-expert', agentsRoot: '/fixture/agents', runtime: 'pi', work: 'worktree' }] };
      if (path.startsWith('/api/panel')) return { workspace: { id: '/fixture', scope: '/fixture' }, workspaces: [], instances: [] };
      throw new Error(`Unexpected fixture request ${path}`);
    },
  };
  const host = dom.window.document.querySelector('main');
  spawn.mount(host, ctx); await tick();
  t.after(() => { spawn.unmount(); resetCliStateForTests(); setWorkspace(previous.ws); globalThis.document = previous.doc; globalThis.setInterval = previous.interval; dom.window.close(); });
  return { host, doc: dom.window.document, choose, requests,
    async poll({ noSouls = false } = {}) { empty = noSouls; polls.at(-1)(); await tick(); },
  };
}

for (const noSouls of [false, true]) test(`pending Choose survives roster repaint${noSouls ? ' to an empty roster' : ''}`, async t => {
  const u = await setup(t), card = u.host.querySelector('.cli-card');
  const button = card.querySelector('.cli-choose'); button.focus(); button.click();
  await u.poll({ noSouls });
  assert.equal(u.host.querySelector('.cli-card'), card, 'polling is not recovery-card disposal');
  assert.equal(u.doc.activeElement, button, 'polling must not tear focused recovery controls out of the DOM');
  u.choose.resolve({ path: '/fixture/chosen-oats' }); await tick();
  assert.equal(u.requests.length, 1);
  // Main wrote the pick (cli:pick); the reprobe that follows names no binary.
  assert.deepEqual(u.requests[0].body, {});
  u.requests[0].resolve(unavailable); await tick();
  assert.match(card.querySelector('.cli-status').textContent, /Could not verify/);
  assert.match(card.textContent, /fixture-band/);
});

test('current Retry failure feedback survives the CLI-change roster paint', async t => {
  const u = await setup(t), card = u.host.querySelector('.cli-card');
  card.querySelector('.cli-retry').click(); await tick();
  await u.poll();
  assert.equal(u.host.querySelector('.cli-card'), card);
  u.requests[0].resolve(unavailable); await tick();
  assert.equal(u.host.querySelector('.cli-card'), card);
  assert.equal(card.querySelector('.cli-status').textContent, 'Still no compatible oats CLI.');
});

for (const tab of ['capabilities', 'sources']) test(`CLI recovery stays visible and owned in ${tab}`, async t => {
  const u = await setup(t), card = u.host.querySelector('.cli-card');
  assert.ok(card.querySelector('.cli-explanation > code'), 'inline CLI name stays in one explanatory paragraph');
  u.host.querySelector(`#workspace-tab-${tab}`).click(); await tick();
  assert.equal(u.host.querySelector('.cli-card'), card);
  assert.equal(card.closest('[hidden]'), null, 'recovery must not live in the hidden Souls panel');
  assert.match(card.textContent, /fixture-band/);
  assert.match(card.textContent, /fixture pinned install command/);
  card.querySelector('.cli-choose').click(); await u.poll();
  u.choose.resolve({ path: '/fixture/chosen-oats' }); await tick();
  assert.equal(u.requests.length, 1);
  // Main wrote the pick (cli:pick); the reprobe that follows names no binary.
  assert.deepEqual(u.requests[0].body, {});
  u.requests[0].resolve(unavailable); await tick();
  assert.equal(card.closest('[hidden]'), null);
  assert.match(card.querySelector('.cli-status').textContent, /Could not verify/);
});

test('actual Workspace disposal still revokes a pending Choose', async t => {
  const u = await setup(t);
  u.host.querySelector('.cli-choose').click();
  spawn.unmount(); u.choose.resolve({ path: '/fixture/late-oats' }); await tick();
  assert.deepEqual(u.requests, []);
});
