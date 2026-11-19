import { launchSoul } from './helpers/workspace-actions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import * as spawn from '../renderer/views/spawn.mjs';
import { currentWorkspace, setWorkspace } from '../renderer/views/common.mjs';
import { refreshCli, resetCliStateForTests } from '../renderer/views/cli-status.mjs';
import { createWorkspaceDiscovery } from '../renderer/workspace-discovery.mjs';
import { soulInspection, homeInspection } from './helpers/inspect-fixture.mjs';
import { remotePanel } from '../../client/remote-roster.mjs';
import { workspaceStatusData } from '../../client/deployment-data.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const CLI = { ok: true, bin: '/fixture/oats', version: '0.25.7', operationsApi: 2, workspaceApi: 2, features: ['operations', 'workspace-v2'], remote: ['operations'], relations: true };
const catalogFixture = JSON.parse(readFileSync(new URL('./fixtures/workspace-v2/f2/capabilities.json', import.meta.url), 'utf8'));
// The kernel's workspace header, captured from a real Northwind run and
// projected exactly as the server does; the panel carries it with the roster.
const northwind = JSON.parse(readFileSync(new URL('./fixtures/workspace-v2/workspace-status.json', import.meta.url), 'utf8'));
const northwindDir = northwind.result.workspace.local.replace(/\/oats-local\.yaml$/, '');
const observed = () => ({ status: 'observed', root: `${northwindDir}/agents`, workspace: workspaceStatusData(northwind, northwindDir).workspace,
  workspaceStatus: workspaceStatusData(northwind, northwindDir), reachable: { reachable: true } });
const soul = (root = '/team/one/agents', name = 'dev') => ({ name, agentsRoot: root, description: 'Build and review', runtime: 'pi', work: 'worktree', repoName: 'project' });
// operationsApi 2 soul inspection (kernel capture) carrying one package module `id`.
const capability = id => ({ id, version: '1.2.3', layer: null, command: null, dir: null, settings: {}, missingRequires: [], operations: [],
  from: { kind: 'package', package: 'fixture.package', version: '1.2.3', commit: 'a'.repeat(40), integrity: `sha256-${'a'.repeat(64)}`, repoKey: 'github.com/fixture/package' } });
const inspectData = (id = 'fixture.notes', selector = {}) => soulInspection(selector.soul || 'dev', { capabilities: [capability(id)],
  instructions: { file: '/fixture/AGENTS.md', text: '# Literal AGENTS.md\n<img src=x onerror=evil()>', truncated: false } });
async function setup(t, options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'http://localhost' });
  const previous = { document: globalThis.document, window: globalThis.window, setInterval: globalThis.setInterval, ws: currentWorkspace() };
  globalThis.document = dom.window.document; globalThis.window = dom.window;
  const polls = []; globalThis.setInterval = fn => { polls.push(fn); return 0; };
  let cli = options.cli === undefined ? CLI : options.cli;
  let agents = options.agents || [soul()];
  let getAgents = options.getAgents, getPanel = options.getPanel;
  const calls = [], files = [], opens = [];
  const panel = () => ({ workspace: { id: currentWorkspace(), scope: currentWorkspace(), ...(options.workspace || {}) }, workspaces: options.workspaces || [], instances: options.instances || [],
    ...(options.deployment !== null ? { deployment: options.deployment ? options.deployment() : observed() } : {}) });
  const ctx = { hasWorkspaceSwitcher: options.shell ?? true,
    api: async (path, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : undefined; calls.push({ path, body, method: opts.method || 'GET' });
      if (path === '/api/cli') return cli;
      if (path.startsWith('/api/agents')) return getAgents ? getAgents() : { agents };
      if (path.startsWith('/api/panel')) return getPanel ? getPanel() : panel();
      if (path.startsWith('/api/workspace-sync')) return options.sync ? options.sync(body)
        : { workspaceSyncApi: 1, status: 'ok', report: null, capabilities: { capabilitiesApi: 1, ...catalogFixture.result }, reason: null };
      if (path.startsWith('/api/capabilities')) return options.inspect ? options.inspect(body) : inspectData('fixture.notes', body.selector);
      if (path.startsWith('/api/servers')) return options.servers ? options.servers(path) : { servers: [] };
      if (path === '/api/spawn' && options.spawn) return options.spawn(body);
      throw new Error(`Unexpected fixture API request: ${path}`);
    }, openBrain: name => files.push(name), openTerminal: ref => opens.push(ref) };
  t.after(() => { spawn.unmount(); setWorkspace(previous.ws); globalThis.document = previous.document; globalThis.window = previous.window; globalThis.setInterval = previous.setInterval; dom.window.close(); });
  setWorkspace('/team');
  if (options.pendingCli) resetCliStateForTests(); else await refreshCli({ api: async () => cli });
  options.beforeMount?.();
  spawn.mount(dom.window.document.querySelector('#host'), ctx); await tick();
  const doc = dom.window.document;
  return { doc, dom, calls, files, opens, ctx, polls, panel,
    tab: name => doc.getElementById(`workspace-tab-${name}`).click(),
    click: text => { const control = [...doc.querySelectorAll('button')].find(el => el.textContent === text); assert.ok(control, text); control.click(); },
    change: (selector, value) => { const el = doc.querySelector(selector); el.value = value; el.dispatchEvent(new dom.window.Event('change', { bubbles: true })); return el; },
    inspections: () => calls.filter(call => call.path.startsWith('/api/capabilities') && call.body.action === 'inspect'),
    inventories: () => calls.filter(call => call.path.startsWith('/api/capabilities') && call.body.action === 'list'),
    setAgents: value => { agents = value; },
    setLoaders: (a, p) => { getAgents = a; getPanel = p; },
    setCli: async value => { cli = value; await refreshCli({ api: async () => cli }); },
  };
}

for (const [name, deployment, expected] of [
  ['missing feature', { status: 'unavailable', reason: { code: 'E_DEPLOYMENT_FEATURE', message: 'x', feature: 'instance-modules' } }, /does not advertise instance-modules/],
  ['kernel refusal', { status: 'unavailable', reason: { code: 'E_LOCAL_MISSING', message: 'no oats-local.yaml at this directory' } }, /E_LOCAL_MISSING: no oats-local\.yaml at this directory/],
  ['pending', { status: 'pending' }, /Reading the deployment/],
]) test(`unobserved deployment (${name}) is explained in the header and the soul roster, never shown as empty`, async t => {
  const u = await setup(t, { agents: [], deployment: () => deployment });
  assert.equal(u.doc.querySelector('.workspace-header h1'), null, 'no title in the bar (human, 2026-09-28): the tabs lead');
  assert.match(u.doc.querySelector('.souls-grid').textContent, expected);
  u.tab('capabilities'); await tick();
  const status = u.doc.querySelector('.discovery-status');
  assert.match(status.textContent, expected); assert.equal(status.getAttribute('role'), 'status');
  assert.equal(u.calls.filter(call => call.path.startsWith('/api/workspace-sync')).length, 0, 'an unobserved deployment is never read or synced');
});

const inventoryData = (context = '/team', capability = 'acquired.export') => ({ inventoryApi: 1, scope: { kind: 'classic', context },
  packages: [{ package: 'acquired.package', level: context, version: '1.0', capabilities: [capability], locked: true }],
  capabilities: [{ capability, package: 'acquired.package', level: context, installed: false, trusted: true, status: 'missing' }], legacy: [] });

test('shell feature-detect removes duplicate selector; standalone selection uses literal safe ids', async t => {
  const evil = 'w"><img src=x onerror=evil()>';
  const u = await setup(t, { shell: false, workspaces: [{ id: '/team', name: 'Team' }, { id: evil, name: '<script>literal</script>' }] });
  assert.equal(u.doc.querySelector('.wssel').style.display, '');
  assert.equal(u.doc.querySelector('img,script'), null);
  u.change('.wssel', evil); await tick();
  assert.equal(currentWorkspace(), evil);
  assert.equal(u.doc.querySelector('.wssel').options[1].value, evil);
  u.ctx.hasWorkspaceSwitcher = true; u.polls[0](); await tick();
  assert.equal(u.doc.querySelector('.wssel').style.display, 'none');
});

for (const outcome of ['success', 'rejection']) test(`roster per-path tickets reject same-workspace stale ${outcome}`, async t => {
  const u = await setup(t);
  const requests = [];
  u.setLoaders(() => { const d = deferred(); requests.push(d); return d.promise; });
  u.polls[0](); u.polls[0]();
  requests[1].resolve({ agents: [soul('/team/current/agents', 'new-roster')] }); await tick();
  if (outcome === 'success') requests[0].resolve({ agents: [soul('/team/stale/agents', 'old-roster')] }); else requests[0].reject(new Error('old-roster failure'));
  await tick();
  assert.match(u.doc.querySelector('.souls-grid').textContent, /new-roster/);
  assert.doesNotMatch(u.doc.querySelector('.souls').textContent, /old-roster/);
});

test('subtab preselection is consumed on mount/current view, drops stale generations and never spawns', async t => {
  const u = await setup(t, { beforeMount: () => spawn.preselectWorkspaceTab('sources') });
  await tick(); assert.equal(u.doc.getElementById('workspace-tab-sources').getAttribute('aria-selected'), 'true');
  // The page's tab, as the shell's surface reads it (surface-return.mjs): what shows, null once unmounted.
  assert.equal(spawn.currentWorkspaceTab(), 'sources');
  assert.equal(spawn.preselectWorkspaceTab('knowledge'), false);
  spawn.preselectWorkspaceTab('souls'); assert.equal(u.doc.querySelector('.souls-grid').hidden, false);
  assert.equal(spawn.currentWorkspaceTab(), 'souls');
  spawn.unmount(); assert.equal(spawn.currentWorkspaceTab(), null);
  spawn.preselectWorkspaceTab('sources'); setWorkspace('/other');
  spawn.mount(u.doc.querySelector('#host'), u.ctx); await tick();
  assert.equal(u.doc.getElementById('workspace-tab-souls').getAttribute('aria-selected'), 'true');
  assert.equal(u.doc.querySelector('.spawn-dialog'), null);
  // Read-only POSTs only: inspect, and the catalog read the tab bar counts (never a spawn or sync).
  assert.ok(u.calls.filter(c => c.method === 'POST').every(c => c.body.action === 'inspect' || (c.path.startsWith('/api/workspace-sync') && c.body.action === 'read')));
});

test('root/name/host focus survives polling, the soul page\'s back and modal close without selecting a twin', async t => {
  const evil = 'dev"<unsafe>';
  const agents = [soul('/team/one/agents', evil), soul('/team/two/agents', evil)];
  const u = await setup(t, { agents });
  let card = [...u.doc.querySelectorAll('.soul-card')].find(c => c.dataset.root === '/team/two/agents');
  card.focus(); u.polls[0](); await tick();
  assert.equal(u.doc.activeElement.dataset.root, '/team/two/agents');
  card = u.doc.activeElement;
  card.click(); await tick();
  assert.equal(u.doc.querySelector('.workspace-soul-page').hidden, false);
  assert.equal(u.doc.querySelector('.souls-grid').hidden, true, 'the soul\'s page replaces the grid (F7)');
  assert.equal(u.inspections().at(-1).body.selector.agentsRoot, '/team/two/agents');
  assert.equal(u.doc.querySelector('img'), null);
  u.doc.querySelector('.workspace-soul-page .inspector-back').click();
  assert.equal(u.doc.activeElement.dataset.root, '/team/two/agents');
  launchSoul(u.doc, u.doc.activeElement); await tick();
  u.doc.querySelector('.fcancel').click();
  assert.equal(u.doc.querySelector('.soul-card.open').dataset.root, '/team/two/agents');
  assert.equal(u.doc.activeElement.closest('.workspace-soul-page'), u.doc.querySelector('.workspace-soul-page'));
  assert.equal(u.doc.activeElement.classList.contains('spawn-act'), true);
  assert.ok([...u.doc.querySelectorAll('.brain-act')].every(b => b.disabled), 'legacy name-only Files boundary fails closed for twins');
  assert.deepEqual(u.files, []); assert.deepEqual(u.opens, []);
});

test('the declared soul is read-only; its page is stable under roster polling', async t => {
  const u = await setup(t);
  u.doc.querySelector('.soul-card').click(); await tick();
  const inspector = u.doc.querySelector('.workspace-soul-page');
  assert.match(inspector.textContent, /Capabilities/); assert.ok(inspector.querySelector('.soul-capabilities .cap-line'));
  assert.doesNotMatch(inspector.textContent, /Edit this soul/);
  assert.equal(inspector.querySelector('form, textarea, input'), null, 'no in-place editor');
  const main = inspector.querySelector('.inspector-main');
  u.polls[0](); await tick();
  assert.equal(inspector.querySelector('.inspector-main'), main, 'polling keeps the rendered page');
  assert.equal(u.inspections().length, 1, 'polling never refreshes the inspector');
  assert.ok(u.inspections().every(c => c.body.action === 'inspect'));
});

test('attached launch/schedule and capability downgrade remain disabled in the inspector', async t => {
  const agent = { ...soul(), work: 'attached' };
  const u = await setup(t, { agents: [agent], inspect: () => { const v = inspectData(); v.souls[0].work = 'attached'; return v; } });
  u.doc.querySelector('.soul-card').click(); await tick();
  assert.ok([...u.doc.querySelectorAll('.workspace-soul-page [data-launch]')].every(el => el.disabled));
  assert.equal(u.doc.querySelector('.spawn-act').disabled, true);
  await u.setCli({ ok: false });
  assert.ok([...u.doc.querySelectorAll('.workspace-soul-page [data-launch]')].every(el => el.disabled));
});

for (const outcome of ['success', 'rejection']) test(`selected inspector ignores late ${outcome} after another soul is selected`, async t => {
  const old = deferred();
  const agents = [soul('/team/one/agents', 'old-soul'), soul('/team/two/agents', 'new-soul')];
  const u = await setup(t, { agents, inspect: body => body.selector.soul === 'old-soul' ? old.promise : inspectData('new-capability', body.selector) });
  [...u.doc.querySelectorAll('.soul-card')].find(c => c.dataset.agent === 'old-soul').click();
  [...u.doc.querySelectorAll('.soul-card')].find(c => c.dataset.agent === 'new-soul').click(); await tick();
  if (outcome === 'success') old.resolve(inspectData('old-capability')); else old.reject(new Error('old-inspection-failure'));
  await tick();
  assert.equal(u.doc.querySelector('.inspector-head h2').textContent, 'new-soul');
  assert.match(u.doc.querySelector('.workspace-soul-page').textContent, /new-capability/);
  assert.doesNotMatch(u.doc.querySelector('.workspace-soul-page').textContent, /old-capability|old-inspection-failure/);
  assert.equal(u.doc.querySelector('.spawn-dialog'), null);
});

// Slice 3a: the soul page lists no instances; its card counts them (exact root and host), and an instance opens in the
// sidebar from the roster (preselectHome), beside the soul page when one is open.
test('instance counts reflect exact root/host identity; an instance opens only as a read-only snapshot in the sidebar', async t => {
  const instance = { agent: 'dev', instance: 'dev-seat', agentsRoot: '/team/one/agents', home: '/team/one/agents/dev/instances/dev-seat', running: true };
  const u = await setup(t, { instances: [instance, { ...instance, agentsRoot: '/team/two/agents', home: '/team/two/agents/dev/instances/dev-seat' }, { ...instance, server: 'another-host' }],
    inspect: body => body.selector.home ? homeInspection(body.selector.home, { instance: 'dev-seat', soul: 'dev', instructions: { file: '/fixture/AGENTS.md', text: 'Captured instructions', truncated: false, sources: [] } }) : inspectData() });
  assert.equal(u.doc.querySelector('.sactivity').textContent, '1 agent running');
  u.doc.querySelector('.soul-card').click(); await tick();
  assert.equal(u.doc.querySelector('.workspace-soul-page .inspector-instance'), null, 'no instances on the soul page');
  spawn.preselectHome(instance); await tick();
  assert.deepEqual(u.inspections().at(-1).body.selector, { home: instance.home });
  // F7: the instance opens in the sidebar beside the soul's page, which keeps the soul.
  assert.equal(u.doc.querySelector('.workspace-soul-page .inspector-head h2').textContent, 'dev');
  assert.equal(u.doc.querySelector('.soul-inspector .inspector-head h2').textContent, 'dev-seat');
  assert.match(u.doc.querySelector('.soul-inspector').textContent, /As spawned/);
  assert.match(u.doc.querySelector('.soul-inspector').textContent, /Captured instructions/);
  assert.equal(u.doc.querySelector('.soul-inspector [data-launch]'), null);
  assert.equal([...u.doc.querySelectorAll('.soul-inspector button')].some(el => el.textContent.startsWith('Edit')), false);
  assert.deepEqual(u.opens, []);
});

function tabGeometry(u) {
  const strip = u.doc.querySelector('.workspace-tabs');
  // Five tabs: Souls, Capabilities, Teams, Machines, Setup (2026-10-26). Setup keeps its place and width, at
  // 246px in a 287px strip, so 41px of it shows until the strip scrolls 32px.
  Object.defineProperties(strip, { clientWidth: { value: 287, configurable: true }, clientLeft: { value: 0 } });
  strip.getBoundingClientRect = () => ({ left: 100, right: 387, width: 287 });
  const widths = [50, 70, 60, 50, 73], starts = [0, 52, 124, 186, 246];
  const controls = [...strip.querySelectorAll('button')];
  controls.forEach((control, i) => { control.getBoundingClientRect = () => ({ left: 100 + starts[i] - strip.scrollLeft, right: 100 + starts[i] + widths[i] - strip.scrollLeft, width: widths[i] }); });
  // Any scrollIntoView could move the outer page. Only strip.scrollLeft is allowed.
  u.dom.window.HTMLElement.prototype.scrollIntoView = () => assert.fail('must not scroll ancestors');
  u.dom.window.scrollTo = () => assert.fail('must not scroll the window');
  const outer = u.doc.querySelector('.workspace-main'); outer.scrollTop = 87; strip.scrollTop = 5;
  const visible = control => Math.min(387, control.getBoundingClientRect().right) - Math.max(100, control.getBoundingClientRect().left);
  return { strip, controls, widths, visible, assertOuter() { assert.equal(outer.scrollTop, 87); assert.equal(strip.scrollTop, 5); } };
}

test('1100px Sources focus reveals all 73px in-strip without selecting, inspecting or moving outer scroll', async t => {
  const u = await setup(t), g = tabGeometry(u), source = g.controls[4];
  assert.equal(g.visible(source), 41);
  source.focus({ preventScroll: true });
  assert.equal(u.doc.activeElement, source); assert.equal(g.visible(source), 73); assert.equal(g.strip.scrollLeft, 32);
  assert.equal(source.getAttribute('aria-selected'), 'false', 'plain focus does not activate a section');
  assert.equal(u.inspections().length, 0); g.assertOuter();
  source.dispatchEvent(new u.dom.window.FocusEvent('focus'));
  assert.equal(g.strip.scrollLeft, 32, 'fully revealed tabs do not jitter');
});

test('Sources activation, repeated current-tab activation and keyboard movement reveal only the strip', async t => {
  const u = await setup(t), g = tabGeometry(u), [souls, caps, , teams, source] = g.controls;
  const input = u.doc.querySelector('.filter'); input.focus({ preventScroll: true });
  u.tab('sources'); await tick();
  assert.equal(u.doc.activeElement, input, 'programmatic current-tab activation must not steal focus');
  assert.equal(g.visible(source), 73);
  g.strip.scrollLeft = 0; spawn.preselectWorkspaceTab('sources');
  assert.equal(g.visible(source), 73, 'already-current tab activation also reveals after resize/strip scroll');
  assert.equal(u.doc.activeElement, input);
  const focusOptions = [];
  for (const control of g.controls) {
    const focus = control.focus.bind(control);
    control.focus = options => { focusOptions.push(options); focus(options); };
  }
  const key = (control, value) => control.dispatchEvent(new u.dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  key(source, 'Home'); assert.equal(u.doc.activeElement, souls); assert.equal(g.strip.scrollLeft, 0);
  key(souls, 'ArrowRight'); assert.equal(u.doc.activeElement, caps);
  key(caps, 'End'); assert.equal(u.doc.activeElement, source); assert.equal(g.visible(source), 73);
  key(source, 'ArrowLeft'); assert.equal(u.doc.activeElement, teams);
  g.strip.scrollLeft = 0; key(teams, 'ArrowRight'); assert.equal(u.doc.activeElement, source); assert.equal(g.visible(source), 73);
  key(source, 'ArrowRight'); assert.equal(u.doc.activeElement, souls, 'wraps to the first tab'); assert.equal(g.strip.scrollLeft, 0);
  assert.ok(focusOptions.length >= 5 && focusOptions.every(options => options?.preventScroll === true));
  const syncCalls = u.calls.filter(call => call.path.startsWith('/api/workspace-sync'));
  // Passing through Capabilities reads its catalog once; nothing ever mutates.
  assert.deepEqual(syncCalls.map(call => call.body.action), ['read'], 'one catalog read, no sync or approval'); g.assertOuter();
});

test('a settled catalog count keeps the current tab revealed without moving focus', async t => {
  const pending = deferred(), u = await setup(t, { sync: () => pending.promise }), g = tabGeometry(u);
  u.tab('sources'); assert.equal(g.strip.scrollLeft, 32);
  const before = u.doc.activeElement;
  g.widths[4] = 147; u.tab('sources'); await tick();
  assert.equal(g.visible(g.controls[4]), 147); assert.equal(g.strip.scrollLeft, 106);
  assert.equal(u.doc.activeElement, before); g.assertOuter();
  pending.resolve({ workspaceSyncApi: 1, status: 'ok', capabilities: { capabilitiesApi: 1, ...catalogFixture.result } });
});

test('soul identity marks stay qualified and stable across reordered polling and selected inspection', async t => {
  const name = 'dev<img src=x>', agents = [
    { ...soul('/team/one/shared/agents', name), color: 'sage', runtime: 'claude' },
    { ...soul('/team/two/shared/agents', name), color: 'url(javascript:evil())', runtime: 'pi' },
    { ...soul('/team/two/shared/agents', name), server: 'remote-one', color: 'clay', runtime: 'codex' },
    { ...soul('/team/two/shared/agents', name), server: 'remote-two', runtime: '<svg onload=evil()>' },
  ];
  const u = await setup(t, { agents });
  const identity = card => JSON.stringify([card.dataset.root, card.dataset.agent, card.dataset.server]);
  // Slice 3a: a card carries no mark (name, what it does, agents, kind); the soul's page head shows its mark.
  assert.equal(u.doc.querySelector('.soul-card [data-avatar-color]'), null, 'no mark on a card');
  const marks = async () => {
    const out = {};
    for (const card of [...u.doc.querySelectorAll('.soul-card')]) {
      card.click(); await tick();
      const selected = u.doc.querySelector('.inspector-head .soul-avatar');
      assert.equal(selected.getAttribute('aria-hidden'), 'true');
      assert.equal(u.doc.querySelector('.inspector-head h2').textContent, name);
      assert.equal(u.doc.querySelector('[name=color]'), null, 'no invented writable CLI field');
      out[identity(card)] = [selected.dataset.avatarColor, selected.textContent];
      u.doc.querySelector('.workspace-soul-page .inspector-back').click(); await tick();
    }
    return out;
  };
  const before = await marks();
  assert.equal(Object.keys(before).length, agents.length, 'every qualified soul its own page');
  assert.equal(before[JSON.stringify(['/team/one/shared/agents', name, ''])][0], 'sage');
  u.setAgents([...agents].reverse()); u.polls[0](); await tick();
  assert.deepEqual(await marks(), before, 'stable across a reordered poll');
  assert.equal(u.doc.querySelector('img,svg:not(.shell-icon):not(.runtime-mark),script,[data-runtime="<svg onload=evil()>"]'), null, 'only the vetted Lucide chrome and the static harness marks render SVG');
  for (const mark of u.doc.querySelectorAll('svg.runtime-mark')) assert.match(mark.parentElement.dataset.runtime, /^(claude|pi|codex)$/, 'a harness mark only inside a known harness badge');
  // Read-only POSTs only: inspect, and the catalog read the tab bar counts (never a spawn or sync).
  assert.ok(u.calls.filter(c => c.method === 'POST').every(c => c.body.action === 'inspect' || (c.path.startsWith('/api/workspace-sync') && c.body.action === 'read')));
  assert.deepEqual(u.files, []); assert.deepEqual(u.opens, []);
});

// Slice 3a (replaces W3's team grouping and chips): cards grouped by repository only, no team chips; souls of an
// unconfirmed member listed apart with its reason.
test('Souls group by repository, and unconfirmed members explain their hidden souls', async t => {
  const agents = [
    { ...soul('/nw/agents', 'writer'), team: 'marketing', repoName: 'site', labels: ['marketing', 'engineering'] },
    { ...soul('/nw/agents', 'builder'), team: 'engineering', repoName: 'app' },
    { ...soul('/nw/agents', 'reviewer'), team: 'engineering', repoName: 'site' },
  ];
  const status = () => {
    const d = observed();
    d.workspaceStatus = { ...d.workspaceStatus, members: [...d.workspaceStatus.members,
      { key: 'github.com/nw/lab', name: 'lab', status: 'no-backlink', team: 'research', souls: ['prober'], capabilities: [] }] };
    return d;
  };
  const u = await setup(t, { agents, deployment: status });
  // Board 3: each header is an icon, the name and a muted qualifier (with the count).
  const titles = () => [...u.doc.querySelectorAll('.souls-group-title')].map(el => [el.querySelector('svg').getAttribute('data-icon'),
    el.querySelector('.souls-group-name').textContent, el.querySelector('.souls-group-note').textContent]);
  assert.equal(u.doc.querySelector('.souls-group-by, [data-group-by]'), null, 'no Group by');
  assert.deepEqual(titles(), [['repo', 'app', '1 soul'], ['repo', 'site', '2 souls'], ['warning', 'Not available', "lab hasn't joined the workspace"]]);
  assert.equal(u.doc.querySelector('.soul-card .schip, .soul-card .scontext, .soul-card .runtime-badge'), null, 'no team chips, no harness on a card');
  assert.equal(u.doc.querySelector('.soul-card[data-agent=builder] .sactivity').textContent, 'No agents running', 'never the bare word "none"');
  assert.doesNotMatch(u.doc.querySelector('.souls-grid').textContent, /\bnone\b/);
  const hidden = u.doc.querySelector('[data-unavailable=prober]');
  assert.equal(hidden.tagName, 'DIV', 'an unavailable soul is not a control: it has no page to open');
  assert.equal(hidden.querySelector('.sfoot .sproblem').textContent, 'Hidden until membership is confirmed', 'the reason, in the foot');
  assert.equal(hidden.querySelector('.sdesc').textContent, 'lab', 'the member it comes from');
  assert.equal(u.doc.querySelectorAll('.souls-grid .soul-card[tabindex="0"]').length, 1, 'one roving card');
  // The table lists them the same way, the hidden one as a row that opens nothing.
  u.doc.querySelector('.souls-view [data-view=table]').click();
  assert.deepEqual([...u.doc.querySelectorAll('.souls-table th.souls-table-group .souls-group-name')].map(el => el.textContent), ['app', 'site', 'Not available']);
  const row = u.doc.querySelector('.souls-table tr[data-unavailable=prober]');
  assert.equal(row.querySelector('button'), null); assert.equal(row.cells[1].textContent, 'Hidden until membership is confirmed');
  assert.equal(u.doc.querySelectorAll('.souls-table .soul-row-open[tabindex="0"]').length, 1, 'one roving row');
});

// #517 and the Desktop UI rework's slice 3b: the Machines tab lists the workspace's computers; with the CLI's machine
// gates, the machines registered to this workspace too.
test('Machines: the list follows the gates; it is read for this window and kept across repaints; Setup holds no machines', async t => {
  const gated = { ...CLI, features: [...CLI.features, 'servers-per-workspace', 'server-connect'] };
  const machine = { id: 'devbox-team', label: 'devbox', sshHost: 'devbox', workspace: '/home/alex/team', workspaceKey: 'github.com/acme/team', check: { reachable: true, version: '0.39.0', error: null } };
  const u = await setup(t, { cli: gated, servers: () => ({ servers: [machine], filtered: true, key: 'github.com/acme/team', deployment: '/team', aweb: false }) });
  u.tab('machines'); for (let i = 0; i < 6; i++) await tick();
  const list = u.doc.querySelector('.workspace-discovery section.machines');
  assert.ok(list, 'the Machines list');
  assert.deepEqual([...list.querySelectorAll('[data-machine]')].map(r => r.dataset.machine), [':here', 'devbox-team']);
  assert.ok(u.calls.some(c => c.path === `/api/servers?ws=${encodeURIComponent('/team')}`));
  assert.equal(list.querySelector('.machines-add').textContent, 'Add a machine to this workspace…');
  u.tab('souls'); await tick(); u.tab('machines'); await tick();
  assert.equal(u.doc.querySelector('.workspace-discovery section.machines'), list, 'the same list across repaints');
  u.tab('sources'); for (let i = 0; i < 6; i++) await tick();
  assert.equal(u.doc.querySelector('.setup section.machines, .setup .setup-machines'), null, 'not in Setup');
});

test('Machines: without servers-per-workspace and server-connect the list is this computer alone, with no Add a machine', async t => {
  const u = await setup(t);
  u.tab('machines'); for (let i = 0; i < 6; i++) await tick();
  const list = u.doc.querySelector('.workspace-discovery section.machines');
  assert.deepEqual([...list.querySelectorAll('[data-machine]')].map(r => r.dataset.machine), [':here']);
  assert.equal([...u.doc.querySelectorAll('button')].some(b => b.textContent === 'Add a machine to this workspace…'), false);
  assert.equal(u.calls.some(c => c.path.startsWith('/api/servers?')), false, 'nothing to read');
});

// Review round 2: the soul page follows its roster row across polls: a refusal that appears or clears changes its
// Ready line and New agent, as it changes the card, from the real roster read (not an injected refusal).
test('a roster poll that refuses or clears a soul moves its page\'s Ready line and New agent, both ways', async t => {
  const cli = { ...CLI, features: [...CLI.features, 'desktop-facts'] };
  const ready = { ...soul(), spawnable: true, problem: null };
  const refused = { ...soul(), spawnable: false, problem: { code: 'E_SOUL_DISABLED', message: 'Disabled on this computer.' } };
  const u = await setup(t, { cli, agents: [ready] });
  u.doc.querySelector('.soul-card').click(); await tick(); await tick();
  const line = () => u.doc.querySelector('.workspace-soul-page .soul-ready-line').textContent;
  const newAgent = () => u.doc.querySelector('.workspace-soul-page .spawn-act');
  assert.equal(line(), 'Ready'); assert.equal(newAgent().disabled, false);
  u.setAgents([refused]); u.polls[0](); await tick(); await tick();
  assert.equal(line(), 'Disabled on this computer.', 'the refusal reaches the page');
  assert.equal(newAgent().disabled, true, 'and New agent');
  newAgent().ownerDocument.querySelector('.workspace-soul-page button[title="Inspect again"]').click(); await tick(); await tick();
  assert.equal(line(), 'Disabled on this computer.', 'an explicit Refresh keeps the current row');
  u.setAgents([ready]); u.polls[0](); await tick(); await tick();
  assert.equal(line(), 'Ready', 'cleared again'); assert.equal(newAgent().disabled, false);
});
