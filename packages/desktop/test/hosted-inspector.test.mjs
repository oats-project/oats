// Inert DOM-only ownership checks. The controlled host implements the optional
// lease contract; it does not stand in for native shell/layout acceptance.
// F7: the hosted slot now holds INSTANCES (a soul opens as a page in the
// Workspace view), so every hosted guarantee is exercised with an instance
// selection; the soul page's own back/focus guarantees are tested below.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import * as spawn from '../renderer/views/spawn.mjs';
import { createSoulInspector, INSPECTION_STALE_TITLE } from '../renderer/soul-inspector.mjs';
import { createReadinessView } from '../renderer/readiness-view.mjs';
import { createPanelOwner } from '../renderer/panel-owner.mjs';
import { createContextPanel } from '../renderer/context-panel.mjs';
import { currentWorkspace, setWorkspace, postJson, wsQuery, workspaceGeneration } from '../renderer/views/common.mjs';
import { refreshCli, cliStatus } from '../renderer/views/cli-status.mjs';
import { runtimeState } from '../../client/instance-presentation.mjs';
import { createSoulMark } from '../renderer/identity-marks.mjs';
import { inspectData, inspectFacts } from '../../client/inspect-contract.mjs';
import { soulInspection, homeInspection, capturedOperations, capturedRun } from './helpers/inspect-fixture.mjs';
import { iconElement } from '../renderer/shell-icons.mjs';
import { createDataState, skeletonBlock, skeleton, captureFocusState } from '../renderer/loading.mjs';
import { desktopFacts } from '../../client/soul-facts.mjs';
import { buildState } from '../renderer/soul-inspector.mjs';
import { createDeploymentScopeLine } from '../renderer/deployment-scope-line.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const CLI = { ok: true, operationsApi: 2, features: ['operations'], relations: true };
const soul = root => ({ name: 'dev', agentsRoot: `/${root}/agents`, runtime: 'pi', work: 'worktree', description: root });
const selection = root => ({ agent: soul(root), selector: { soul: 'dev', agentsRoot: soul(root).agentsRoot } });
// One instance per agents root (the hosted slot's subject), and its operationsApi 2
// inspection from the kernel capture, with oats.okf's captured status view.
const inst = root => ({ agent: 'dev', instance: `dev-${root}`, agentsRoot: `/${root}/agents`, home: `/${root}/agents/dev/instances/dev-${root}`, running: true });
const inspection = (root = 'a') => homeInspection(inst(root).home, { instance: inst(root).instance, soul: 'dev',
  instructions: { file: `${inst(root).home}/AGENTS.md`, text: `${root}-instructions`, truncated: false, sources: [] }, operations: capturedOperations().filter(op => op.name === 'status') });
const soulPageInspection = () => soulInspection('dev', { instructions: { text: 'soul-instructions', truncated: false } });
const button = (el, text) => { const found = [...el.querySelectorAll('button')].find(control => control.textContent === text); assert.ok(found, `button ${text}`); return found; };
const settle = (request, outcome, value) => outcome === 'success' ? request.resolve(value) : request.reject(new Error('controlled late rejection'));

// Presence is not effective visibility. Cover and collapse never mutate the
// inspector itself. Repeated setPresent(true) is observable even if a real host
// would choose not to expand; request completions must not make that call.
function controlledHost(doc) {
  const host = doc.querySelector('#panel'), records = [];
  let current = null, expanded = true, covered = false;
  const paint = () => { for (const record of records) record.slot.hidden = !record.lease.isVisible(); };
  return {
    records,
    attach(element) {
      const slot = doc.createElement('div'); slot.className = 'oats-view';
      const record = { element, originalParent: element.parentElement, slot, present: false, disposed: false, events: [] };
      const lease = record.lease = {
        setPresent(value) { record.events.push(['present', value]); if (!record.disposed) record.present = value; paint(); },
        isVisible() { return current === record && !record.disposed && record.present && expanded && !covered && element.isConnected; },
        collapse() { record.events.push(['collapse']); expanded = false; paint(); },
        dispose() {
          if (record.disposed) return;
          record.events.push(['dispose', element.hidden, element.childElementCount]);
          record.disposed = true; if (current === record) current = null;
          slot.remove(); paint();
        },
      };
      records.push(record); current = record;
      slot.append(element); host.append(slot); paint();
      return lease;
    },
    cover(value = true) { covered = value; doc.querySelector('#stage').hidden = value; paint(); },
    expand() { expanded = true; paint(); },
    get current() { return current; },
  };
}

async function workspace(t, { hosted = true, createHost = controlledHost, api = body => body.selector?.soul ? soulPageInspection() : inspection(body.selector?.home?.startsWith('/b/') ? 'b' : 'a') } = {}) {
  const dom = new JSDOM('<body><button id="outside">Outside</button><div id="stage"></div><aside id="panel"></aside></body>', { url: 'http://localhost' });
  const doc = dom.window.document, stage = doc.querySelector('#stage'), host = createHost(doc);
  const saved = { document: globalThis.document, window: globalThis.window, setInterval: globalThis.setInterval, ws: currentWorkspace() };
  const polls = [], calls = [], focuses = [];
  globalThis.document = doc; globalThis.window = dom.window;
  globalThis.setInterval = fn => { polls.push(fn); return 0; };
  const focus = dom.window.HTMLElement.prototype.focus;
  dom.window.HTMLElement.prototype.focus = function (...args) { focuses.push(this); return focus.apply(this, args); };
  const theme = doc.createElement('style'); theme.textContent = readFileSync(new URL('../renderer/theme.css', import.meta.url), 'utf8'); doc.head.append(theme);
  const ctx = {
    hasWorkspaceSwitcher: true, ...(hosted ? { rightPanel: host } : {}),
    openBrain() {}, openView() {},
    api: async (path, opts = {}) => {
      const body = opts.body && JSON.parse(opts.body); calls.push({ path, body });
      if (path === '/api/cli') return CLI;
      if (path.startsWith('/api/agents')) return { agents: [soul('a'), soul('b')] };
      if (path.startsWith('/api/panel')) return { workspace: { id: currentWorkspace() }, workspaces: [], instances: [inst('a'), inst('b')] };
      if (path.startsWith('/api/capabilities')) return api(body);
      if (path.startsWith('/api/servers')) return { servers: [] };
      throw new Error(`Unexpected inert API: ${path}`);
    },
  };
  t.after(() => {
    spawn.unmount(); host.dispose?.(); setWorkspace(saved.ws);
    globalThis.document = saved.document; globalThis.window = saved.window; globalThis.setInterval = saved.setInterval;
    dom.window.close();
  });
  setWorkspace('/team'); await refreshCli({ api: async () => CLI });
  spawn.mount(stage, ctx); await tick();
  const get = selector => doc.querySelector(selector);
  return { dom, doc, stage, ctx, host, calls, focuses, get,
    card: (root = 'a') => [...doc.querySelectorAll('.soul-card')].find(card => card.dataset.root === soul(root).agentsRoot),
    click: text => button(get('.soul-inspector'), text).click(),
    // Open an instance in the hosted sidebar (the Workspace's own handoff).
    select: async (root = 'a') => { spawn.preselectHome(inst(root)); await tick(); await tick(); },
    poll: async () => { polls.at(-1)(); await tick(); },
  };
}

// The inspector is read-only; its local UI state is the disclosed
// instructions. Hosting must keep that exact node and its open state.
const instructionsOf = u => [...u.get('.soul-inspector').querySelectorAll('details')].find(d => d.querySelector('summary')?.textContent === 'AGENTS.md / instructions');
async function openInstructions(u) {
  await u.select();
  const details = instructionsOf(u); assert.ok(details, 'instructions disclosure'); details.open = true;
  return details;
}

test('host moves the actual inspector; its stage stays one column and shared head/action styles survive', async t => {
  const u = await workspace(t), record = u.host.current, aside = record.element;
  assert.equal(record.originalParent, u.get('.souls-body'));
  assert.equal(aside.parentElement, record.slot);
  assert.equal(aside.closest('.oats-view'), record.slot);
  assert.equal(u.stage.querySelector('.soul-inspector'), null);
  assert.equal(aside.hidden, true); assert.equal(record.lease.isVisible(), false);
  assert.deepEqual([...u.get('.souls-body').children], [u.get('.workspace-main')]);
  assert.equal(u.card().hasAttribute('aria-pressed'), false, 'a card opens its soul\'s page, not the sidebar');
  assert.equal(u.doc.getElementById(u.card().getAttribute('aria-controls')), u.get('.workspace-soul-page'));
  await openInstructions(u);
  assert.equal(record.lease.isVisible(), true); assert.equal(aside.hidden, false);
  assert.equal(aside.querySelector('h2').textContent, 'dev-a', 'the hosted slot holds the instance');
  assert.equal(u.get('.souls-body').classList.contains('inspecting'), false);
  assert.equal(record.slot.classList.contains('inspecting'), false);
  const css = el => u.dom.window.getComputedStyle(el);
  assert.equal(css(u.get('.souls-body')).gridTemplateColumns, 'minmax(0,1fr)');
  assert.equal(css(aside.querySelector('.inspector-head')).minHeight, 'var(--bar-h)', 'the one top-bar height (slice 3d: 44px)');
  assert.equal(css(aside.querySelector(':scope > .inspector-content')).padding, '0px 14px 16px');
  assert.equal(css(aside.querySelector('button.act')).borderRadius, '7px');
});

test('hosted X, cover and polling preserve the selected instance and the exact disclosed instructions node', async t => {
  const u = await workspace(t), field = await openInstructions(u), aside = u.get('.soul-inspector'), lease = u.host.current.lease;
  u.get('[aria-label="Close inspector"]').click();
  assert.equal(lease.isVisible(), false);
  assert.equal(aside.hidden, false, 'legacy hidden tracks presence, not host visibility');
  assert.equal(aside.querySelector('h2').textContent, 'dev-a', 'the selection is retained');
  await u.poll();
  u.host.expand();
  assert.equal(lease.isVisible(), true);
  assert.equal(instructionsOf(u), field);
  u.host.cover(); await u.poll();
  assert.equal(lease.isVisible(), false);
  assert.equal(instructionsOf(u), field);
  u.host.cover(false);
  assert.equal(lease.isVisible(), true);
  assert.equal(field.open, true, 'local disclosure state survives');
  assert.equal(u.calls.filter(call => call.body?.action === 'inspect').length, 1, 'presentation never re-inspects');
  assert.ok(u.calls.every(call => !call.body?.action || ['inspect', 'run'].includes(call.body.action)), 'read-only inspector');
});

// Exercise every inspector await: initial read and provider operation.
// Hidden owners may paint themselves, never the host.
for (const path of ['inspect', 'operation']) {
  for (const visibility of ['collapsed', 'covered']) for (const outcome of ['success', 'rejection']) {
    test(`late ${path} ${outcome} cannot reveal the ${visibility} hosted slot`, async t => {
      const pending = deferred(); let reads = 0;
      const u = await workspace(t, { api: body => {
        if (body.action === 'inspect') {
          reads++;
          if (path === 'inspect') return pending.promise;
          return inspection();
        }
        if (body.action === 'run') return pending.promise;
        throw new Error(`Unexpected action ${body.action}`);
      } });
      await u.select();
      if (path === 'operation') u.get('.soul-inspector [data-operation]').click();
      const record = u.host.current;
      if (visibility === 'covered') u.host.cover(); else u.get('[aria-label="Close inspector"]').click();
      u.get('#outside').focus(); u.focuses.length = 0;
      const events = [...record.events];
      const value = path === 'operation' ? capturedRun({ result: { summary: 'Owned hidden output' } }) : inspection();
      settle(pending, outcome, value); await tick(); await tick();
      assert.deepEqual(record.events, events, 'completion must not report presence or reclaim the host');
      assert.equal(record.lease.isVisible(), false); assert.equal(record.slot.hidden, true);
      assert.equal(record.element.hidden, false, 'hidden retained selection is still present');
      assert.equal(u.doc.activeElement, u.get('#outside')); assert.deepEqual(u.focuses, []);
      assert.equal(u.get('.souls-body').classList.contains('inspecting'), false);
      assert.equal(record.slot.classList.contains('inspecting'), false);
      assert.equal(record.element.querySelector('h2').textContent, 'dev-a', 'the hidden selection is retained');
      const status = record.element.querySelector('.inspector-status').textContent;
      if (outcome === 'rejection') assert.match(status, /controlled late rejection/);
      else if (path === 'operation') assert.match(record.element.textContent, /Owned hidden output/);
    });
  }
}

for (const boundary of ['workspace', 'subtab', 'unmount/remount']) for (const outcome of ['success', 'rejection']) {
  test(`${boundary} silently releases presence and invalidates late inspection ${outcome}`, async t => {
    const pending = deferred(); let reads = 0;
    const u = await workspace(t, { api: () => ++reads === 1 ? pending.promise : inspection('b') });
    spawn.preselectHome(inst('a')); await tick(); const old = u.host.current;
    // Even a focused card must not be refocused by the silent close callback.
    u.card().focus(); u.focuses.length = 0;
    if (boundary === 'workspace') setWorkspace('/other');
    else if (boundary === 'subtab') u.get('#workspace-tab-sources').click();
    else { spawn.unmount(); spawn.unmount(); }
    assert.deepEqual(u.focuses, [], 'reset must not focus obsolete/hidden cards, even transiently');
    assert.equal(old.element.hidden, true); assert.equal(old.element.childElementCount, 0);
    assert.equal(old.present, false);
    if (boundary === 'unmount/remount') {
      assert.deepEqual(old.events.slice(-2), [['present', false], ['dispose', true, 0]], 'inspector clears before lease disposal');
      assert.equal(old.events.filter(event => event[0] === 'dispose').length, 1);
      spawn.mount(u.stage, u.ctx); await tick(); await u.select('b');
    } else {
      assert.equal(old.disposed, false, 'workspace/subtab reset retains the mounted lease');
      await tick();
      assert.equal(old.element.hidden, true, 'nothing is selected after the reset');
    }
    const active = u.host.current, events = [...old.events], html = active.element.innerHTML;
    u.get('#outside').focus(); u.focuses.length = 0;
    settle(pending, outcome, inspection()); await tick();
    assert.deepEqual(old.events, events);
    assert.equal(active.element.innerHTML, html, 'obsolete success and rejection cannot repaint current ownership');
    assert.deepEqual(u.focuses, []);
    if (boundary === 'unmount/remount') {
      assert.equal(u.host.current, active); assert.notEqual(active, old); assert.equal(active.lease.isVisible(), true);
      assert.match(active.element.textContent, /b-instructions/);
    } else assert.equal(active.lease.isVisible(), false);
  });
}

for (const hosted of [false, true]) for (const boundary of ['workspace', 'subtab', 'unmount', 'covered poll']) {
  test(`${hosted ? 'hosted' : 'standalone'} ${boundary} never focuses a hidden/obsolete card`, async t => {
    const u = await workspace(t, { hosted }); await openInstructions(u);
    u.card('b').focus(); u.focuses.length = 0;
    if (boundary === 'workspace') setWorkspace('/other');
    else if (boundary === 'subtab') u.get('#workspace-tab-capabilities').click();
    else if (boundary === 'unmount') spawn.unmount();
    else { u.stage.hidden = true; await u.poll(); }
    await tick();
    assert.deepEqual(u.focuses, []);
  });
}

test('standalone X deselects the instance and removes the inline column; it moves no focus (an instance has no card)', async t => {
  const u = await workspace(t, { hosted: false });
  await u.select('b');
  assert.equal(u.get('.soul-inspector').parentElement, u.get('.souls-body'));
  assert.equal(u.get('.souls-body').classList.contains('inspecting'), true);
  u.get('#outside').focus(); u.focuses.length = 0;
  u.get('[aria-label="Close inspector"]').click();
  assert.equal(u.get('.soul-inspector').hidden, true); assert.equal(u.get('.soul-inspector').childElementCount, 0);
  assert.equal(u.get('.souls-body').classList.contains('inspecting'), false);
  assert.deepEqual(u.focuses, []);
});

// The soul page (replaces the sidebar for souls): back returns to the grid and focuses
// only the matching current card, never a same-name twin, never a hidden stage.
test('soul page: back deselects, shows the grid again and focuses only the matching current card', async t => {
  const u = await workspace(t);
  u.card('b').click(); await tick();
  const page = u.get('.workspace-soul-page');
  assert.equal(page.hidden, false); assert.equal(u.get('.souls-grid').hidden, true);
  assert.equal(u.get('.souls-body').classList.contains('inspecting'), false, 'a page is not a side column');
  assert.equal(u.get('.workspace-main').classList.contains('inspecting'), false, 'nor does it mark its own parent');
  assert.equal(u.host.current.lease.isVisible(), false, 'the hosted slot is not used for a soul');
  u.get('.workspace-soul-page .inspector-back').click();
  assert.equal(page.hidden, true); assert.equal(page.childElementCount, 0); assert.equal(u.get('.souls-grid').hidden, false);
  assert.equal(u.doc.activeElement, u.card('b'), 'never the same-name twin');
  u.card('b').click(); await tick(); u.stage.style.display = 'none'; u.focuses.length = 0;
  u.get('.workspace-soul-page .inspector-back').click();
  assert.deepEqual(u.focuses, [], 'even an explicit back must not focus a hidden retained stage');
});

async function launchVisibility(factory = createSoulInspector) {
  const dom = new JSDOM('<body><button id="outside">Outside</button><main id="stage"><aside hidden></aside></main><div id="panel"></div></body>');
  const doc = dom.window.document, el = doc.querySelector('aside'), host = controlledHost(doc), lease = host.attach(el);
  const closed = [];
  const inspector = factory(el, { ctx: { api: async () => inspection() }, presentation: lease, closed: detail => closed.push(detail) });
  try {
    // No hosted-parent class ownership, even when somebody else set the class.
    el.parentElement.classList.add('inspecting');
    await inspector.show(selection('a'));
    assert.equal(inspector.focusLaunch(soul('a')), true);
    assert.equal(inspector.focusLaunch(soul('b')), false, 'identity check still applies');
    doc.querySelector('#outside').focus(); lease.collapse();
    // Visibility is a lease fact, not a DOM attribute contract (a shell can
    // cover via CSS or change foreground ownership before painting hidden).
    host.current.slot.hidden = false;
    assert.equal(inspector.focusLaunch(soul('a')), false, 'hidden lease refuses focusLaunch');
    assert.equal(doc.activeElement.id, 'outside');
    host.expand(); host.cover();
    assert.equal(inspector.focusLaunch(soul('a')), false, 'covered lease refuses focusLaunch');
    host.cover(false);
    assert.equal(inspector.focusLaunch(soul('a')), true);
    inspector.close();
    assert.equal(el.parentElement.classList.contains('inspecting'), true, 'hosted reset must not remove parent classes');
    assert.equal(el.hidden, true); assert.equal(lease.isVisible(), false);
    assert.equal(inspector.focusLaunch(soul('a')), false);
    assert.deepEqual(closed.map(detail => detail.restoreFocus), [false]);
    await inspector.show(selection('a'));
    inspector.dispose(); const events = [...host.current.events];
    inspector.dispose(); inspector.close(); await inspector.show(selection('b'));
    assert.deepEqual(host.current.events, events, 'disposed inspector is inert and idempotent');
    assert.equal(host.current.disposed, false, 'Workspace, not inspector, disposes the lease');
  } finally { inspector.dispose(); lease.dispose(); dom.window.close(); }
}

test('focusLaunch requires effective hosted visibility; silent close/disposal preserve host ownership', () => launchVisibility());

test('mutation: focusLaunch test detects removal of the effective hosted visibility guard', async () => {
  const source = createSoulInspector.toString(), guard = ' || (presentation && !presentation.isVisible())';
  assert.equal(source.split(guard).length, 2);
  const mutant = runInNewContext(`(${source.replace(guard, '')})`, { postJson, wsQuery, workspaceGeneration, runtimeState, createSoulMark, createReadinessView, cliStatus, iconElement, inspectData, inspectFacts, createDataState, skeletonBlock, skeleton, captureFocusState, desktopFacts, buildState, INSPECTION_STALE_TITLE, createDeploymentScopeLine });
  await assert.rejects(launchVisibility(mutant), /hidden lease refuses focusLaunch/);
});

test('real context-panel lease composes with Workspace without copying, reloading or claiming the foreground', async t => {
  const u = await workspace(t, { createHost: realHost });
  const context = { workspace: '/team', owner: u.host.owner };
  const panel = u.host.panel, root = u.get('#panel');
  assert.equal(root.hidden, true, 'empty inspector explicitly reports no presence after attach');
  const field = await openInstructions(u), aside = u.get('.soul-inspector');
  assert.equal(root.hidden, false); assert.ok(aside.closest('.context-panel-stage.oats-view'));
  assert.equal(u.get('.souls-body').classList.contains('inspecting'), false);
  u.get('[aria-label="Close inspector"]').click();
  assert.equal(root.hidden, true, 'closed: nothing left in its place'); assert.equal(aside.hidden, false);
  await u.poll();
  assert.equal(root.hidden, true);
  assert.equal(instructionsOf(u), field);
  const refresh = button(aside, 'Refresh');
  panel.setCollapsed(false);
  panel.setContext({ workspace: '/team', key: 'file-tab' });
  assert.equal(aside.closest('.context-panel-stage').hidden, true);
  await u.poll();
  assert.equal(instructionsOf(u), field);
  assert.equal(field.open, true);
  assert.equal(button(aside, 'Refresh'), refresh); assert.equal(refresh.disabled, false);
  panel.setContext(context);
  assert.equal(aside.closest('.context-panel-stage').hidden, false);
  assert.equal(instructionsOf(u), field);
  assert.equal(u.calls.filter(call => call.body?.action === 'inspect').length, 1);
  spawn.unmount(); spawn.unmount();
  assert.equal(root.querySelector('.context-panel-stage'), null);
  assert.equal(root.hidden, true);
});

// Match the shell's stable stage owner and workspace-generation facade, not a
// raw presentation lease. Only the shell chooses foreground; view callbacks
// renew presence through the same facade after each synchronous workspace reset.
function realHost(doc) {
  const owner = { name: 'spawn' };
  const panel = createContextPanel({ document: doc, root: doc.querySelector('#panel') });
  panel.setContext({ workspace: '/team', owner });
  const stageOwner = createPanelOwner(panel, owner, workspaceGeneration);
  return { panel, owner, attach: stageOwner.attach,
    visit(workspace) { panel.setContext({ workspace, owner }); setWorkspace(workspace); },
    dispose() { stageOwner.dispose(); panel.dispose(); },
  };
}

test('Workspace keeps its actual panel facade across A→B→A resets and releases it on real unmount', async t => {
  const u = await workspace(t, { createHost: realHost });
  await openInstructions(u);
  const aside = u.get('.soul-inspector'), wrapper = aside.parentElement;
  u.host.visit('/other');
  assert.equal(u.get('#panel').hidden, true); assert.equal(aside.childElementCount, 0);
  await tick(); await u.select('b');
  assert.equal(u.get('.soul-inspector'), aside); assert.equal(aside.parentElement, wrapper);
  assert.equal(wrapper.hidden, false); assert.equal(u.get('#panel').hidden, false);
  assert.match(aside.textContent, /b-instructions/);
  u.host.visit('/team'); await tick(); await u.select();
  assert.equal(u.get('.soul-inspector'), aside); assert.equal(aside.parentElement, wrapper);
  assert.equal(wrapper.hidden, false); assert.match(aside.textContent, /a-instructions/);
  spawn.unmount(); spawn.unmount();
  assert.equal(wrapper.isConnected, false); assert.equal(u.get('#panel').hidden, true);
  assert.equal(u.get('.context-panel-stage'), null);
});

for (const outcome of ['success', 'rejection']) test(`real facade: hidden inspection ${outcome} cannot uncollapse or replace the current owner`, async t => {
  const gate = deferred();
  const u = await workspace(t, { createHost: realHost, api: () => gate.promise });
  await u.select();
  const aside = u.get('.soul-inspector');
  u.get('[aria-label="Close inspector"]').click();
  u.host.panel.setContext({ workspace: '/team', key: 'newer-terminal', instance: { instance: 'newer' } });
  u.get('#outside').focus(); u.focuses.length = 0;
  settle(gate, outcome, inspection()); await tick();
  assert.equal(u.get('#panel').hidden, false, "the newer terminal's details follow their own preference");
  assert.equal(aside.parentElement.hidden, true);
  assert.equal(u.get('[data-context-field="instance"]').textContent, 'newer');
  assert.equal(u.doc.activeElement, u.get('#outside')); assert.deepEqual(u.focuses, []);
  u.host.panel.setCollapsed(false);
  assert.equal(aside.parentElement.hidden, true, 'expansion still belongs to the newer terminal');
  u.host.panel.setContext({ workspace: '/team', owner: u.host.owner });
  assert.equal(aside.parentElement.hidden, true, 'the completion did not reopen the closed inspector');
  u.host.panel.setCollapsed(false);
  assert.equal(aside.parentElement.hidden, false, 'only shell selection and the user reopening it expose retained completion');
});
