// #517: the Setup tab's Registered machines box — this workspace's registrations with what the last check said,
// one background check per machine per run, Check, Remove (confirmed) and Add a machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createWorkspaceMachines, resetMachineChecks } from '../renderer/workspace-machines.mjs';

const WS = 'ws:0123456789abcdef0123', KEY = 'github.com/awebai/ac', DEPLOYMENT = '/Users/juanre/Agents/aweb';
const machine = (id, extra = {}) => ({ id, label: id.split('-')[0], sshHost: id.split('-')[0], workspace: `/home/j/${id}`, workspaceKey: KEY, check: null, ...extra });
const answer = (servers, extra = {}) => ({ servers, filtered: true, key: KEY, deployment: DEPLOYMENT, aweb: false, ...extra });
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };

function setup(t, routes, options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { pretendToBeVisual: true });
  const doc = dom.window.document, calls = [];
  const ctx = { api: async (path, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined; calls.push({ path, body });
    const route = Object.keys(routes).find(p => path.startsWith(p));
    assert.ok(route, `unexpected ${path}`);
    const value = await routes[route](body, path);
    if (value?.httpStatus) return { ok: false, status: value.httpStatus, json: async () => value.body };
    return { ok: true, status: 200, json: async () => value };
  } };
  resetMachineChecks();
  const ui = createWorkspaceMachines(doc, { ctx, ws: WS, ...options });
  doc.getElementById('host').append(ui.element);
  t.after(() => { ui.dispose(); dom.window.close(); });
  const q = s => doc.querySelector(s), qa = s => [...doc.querySelectorAll(s)];
  const row = id => q(`[data-machine="${id}"]`);
  const cells = id => [...row(id).querySelectorAll('.machine-cell')].map(c => c.textContent);
  return { dom, doc, ui, calls, q, qa, row, cells };
}

test('lists this workspace\'s machines (name, host, folder, OATS version, reachable) and checks each unchecked one once in the background', async t => {
  let released;
  const gate = new Promise(r => { released = r; });
  const u = setup(t, {
    '/api/servers': () => answer([machine('altair-aweb'), machine('vega-aweb', { check: { reachable: false, version: null, error: 'ssh to vega failed: timeout' } })]),
    '/api/server-check': async body => { await gate; return { id: body.id, check: { reachable: true, version: '0.39.0', error: null } }; },
  });
  await settle();
  assert.equal(u.q('.setup-box-head h4').textContent, 'Registered machines');
  // A solid card (Setup's This computer zone says it is not shared): no scope chip, Add at the end of its head.
  assert.ok(u.ui.element.classList.contains('setup-box'));
  assert.equal(u.q('.setup-scope'), null);
  assert.deepEqual([...u.q('.setup-box-head').children].map(c => c.className), ['', 'setup-box-lead', 'machines-add']);
  assert.deepEqual(u.calls.map(c => c.path), [`/api/servers?ws=${encodeURIComponent(WS)}`, `/api/server-check?ws=${encodeURIComponent(WS)}`]);
  assert.deepEqual(u.cells('altair-aweb'), ['altair-aweb', 'altair', '/home/j/altair-aweb', '', 'checking…']);
  assert.deepEqual(u.cells('vega-aweb'), ['vega-aweb', 'vega', '/home/j/vega-aweb', '', 'not reachable'], 'a held check is shown, not re-run');
  assert.equal(u.row('vega-aweb').querySelector('.machine-state').title, 'ssh to vega failed: timeout');
  assert.equal(u.row('vega-aweb').querySelector('.machine-state').dataset.reachable, 'false', 'the warn chip');
  // Narrow rows hide the ssh host, folder and version: the name's title keeps them.
  assert.equal(u.row('vega-aweb').querySelector('.machine-cell.name').title, 'vega-aweb · vega · vega · /home/j/vega-aweb');
  released(); await settle();
  assert.deepEqual(u.cells('altair-aweb'), ['altair-aweb', 'altair', '/home/j/altair-aweb', 'oats 0.39.0', 'reachable']);
  assert.ok(u.row('altair-aweb').querySelector('.machine-state[data-reachable=true] svg'), 'reachable: a check and a muted word');
  assert.equal(u.row('altair-aweb').querySelector('.machine-cell.name').title, 'altair-aweb · altair · altair · /home/j/altair-aweb · oats 0.39.0');
  u.ui.refresh(); await settle();
  assert.equal(u.calls.filter(c => c.path.startsWith('/api/server-check')).length, 1, 'once per machine per run');
});

test('Check re-runs the check for that machine and shows what it said', async t => {
  let n = 0;
  const u = setup(t, {
    '/api/servers': () => answer([machine('altair-aweb', { check: { reachable: true, version: '0.38.0', error: null } })]),
    '/api/server-check': body => ({ id: body.id, check: ++n === 1 ? { reachable: false, version: null, error: 'ssh failed' } : null }),
  });
  await settle();
  assert.equal(u.calls.length, 1, 'checked already: no background check');
  const check = u.row('altair-aweb').querySelector('.machine-check');
  assert.equal(check.getAttribute('aria-label'), 'Check altair-aweb');
  check.click(); await settle();
  assert.deepEqual(u.calls.at(-1), { path: `/api/server-check?ws=${encodeURIComponent(WS)}`, body: { id: 'altair-aweb' } });
  assert.equal(u.cells('altair-aweb')[4], 'not reachable');
  assert.equal(u.doc.activeElement, u.row('altair-aweb').querySelector('.machine-check'), 'focus stays on Check');
});

test('Remove asks first; Cancel keeps it; confirming removes it through the CLI and re-reads the list', async t => {
  let servers = [machine('altair-aweb', { check: { reachable: true, version: '0.39.0', error: null } })];
  const u = setup(t, {
    '/api/servers': () => answer(servers),
    '/api/server-remove': body => { servers = []; return { schemaVersion: 1, ok: true, result: { removed: body.id, remoteInstancesStillTracked: [] } }; },
  });
  await settle();
  u.row('altair-aweb').querySelector('.machine-remove').click();
  const confirm = u.row('altair-aweb').querySelector('.machine-confirm');
  assert.equal(confirm.querySelector('p').textContent, 'Remove altair-aweb? Instances spawned there keep running and can still be retired from here.');
  assert.equal(u.doc.activeElement, confirm.querySelector('.machine-confirm-cancel'));
  confirm.querySelector('.machine-confirm-cancel').click();
  assert.equal(u.row('altair-aweb').querySelector('.machine-confirm'), null);
  assert.equal(u.doc.activeElement, u.row('altair-aweb').querySelector('.machine-remove'));
  assert.equal(u.calls.filter(c => c.path.startsWith('/api/server-remove')).length, 0);
  u.row('altair-aweb').querySelector('.machine-remove').click();
  u.row('altair-aweb').querySelector('.machine-confirm-remove').click(); await settle();
  assert.deepEqual(u.calls.find(c => c.path.startsWith('/api/server-remove')).body, { id: 'altair-aweb' });
  assert.equal(u.row('altair-aweb'), null);
  assert.equal(u.q('.setup-empty').textContent, 'No machine runs this workspace yet.');
  assert.equal(u.doc.activeElement, u.q('.machines-add'));
});

test('a refused Remove is said in the row, in the CLI\'s words', async t => {
  const u = setup(t, {
    '/api/servers': () => answer([machine('altair-aweb', { check: { reachable: true, version: '0.39.0', error: null } })]),
    '/api/server-remove': () => ({ schemaVersion: 1, ok: false, error: { code: 'E_SERVERS_UNREADABLE', message: 'servers.json is not valid JSON' } }),
  });
  await settle();
  u.row('altair-aweb').querySelector('.machine-remove').click();
  u.row('altair-aweb').querySelector('.machine-confirm-remove').click(); await settle();
  assert.equal(u.row('altair-aweb').querySelector('.machine-error').textContent, 'servers.json is not valid JSON (E_SERVERS_UNREADABLE)');
});

test('Add a machine opens the dialog for this workspace; an added machine is listed', async t => {
  let servers = [];
  const u = setup(t, {
    '/api/servers': () => answer(servers, { aweb: false }),
    '/api/server-connect': body => { servers = [machine(body.id)]; return { schemaVersion: 1, ok: true, result: { id: body.id, ready: true, steps: [] } }; },
    '/api/server-check': body => ({ id: body.id, check: { reachable: true, version: '0.39.0', error: null } }),
  });
  await settle();
  assert.equal(u.q('.setup-empty').textContent, 'No machine runs this workspace yet.');
  u.q('.machines-add').click();
  assert.ok(u.q('.machine-dialog'));
  assert.equal(u.q('.machine-folder').value, '', 'no folder is suggested');
  const host = u.q('.machine-host'); host.value = 'altair'; host.dispatchEvent(new u.dom.window.Event('input', { bubbles: true }));
  const folder = u.q('.machine-folder'); folder.value = '~/aweb'; folder.dispatchEvent(new u.dom.window.Event('input', { bubbles: true }));
  u.q('.machine-primary').click(); await settle();
  assert.equal(u.q('.machine-dialog'), null);
  assert.ok(u.row('altair-aweb'));
  assert.equal(u.doc.activeElement, u.q('.machines-add'));
});

test('no workspace key: the box says why and offers nothing; gates off: no box at all', async t => {
  const reason = 'This deployment reports no workspace key, so no other machine can be matched to it.';
  const u = setup(t, { '/api/servers': () => ({ servers: [], filtered: true, key: null, deployment: null, aweb: false, reason }) });
  await settle();
  assert.equal(u.q('.machines-reason').textContent, reason);
  assert.equal(u.q('.machines-add'), null);
  const off = setup(t, { '/api/servers': () => ({ servers: [{ id: 'altair-tsm', label: 'altair', sshHost: 'altair', workspace: '/srv' }] }) });
  await settle();
  assert.equal(off.ui.element.hidden, true);
});

test('a list that cannot be read says so, with Retry', async t => {
  let fail = true;
  const u = setup(t, { '/api/servers': () => fail ? { httpStatus: 500, body: { error: 'boom' } } : answer([]) });
  await settle();
  assert.match(u.q('.machines-reason').textContent, /could not be read/);
  fail = false; u.q('.machines-retry').click(); await settle();
  assert.equal(u.q('.setup-empty').textContent, 'No machine runs this workspace yet.');
});

// Review round 1.
test('the registry could not be read (the route\'s own answer): the CLI\'s words, Retry, and Add still offered', async t => {
  let fail = true;
  const u = setup(t, { '/api/servers': () => fail ? answer([], { error: { code: 'E_SERVERS_UNREADABLE', message: 'servers.json is not valid JSON' } }) : answer([]) });
  await settle();
  assert.equal(u.ui.element.hidden, false);
  assert.match(u.q('.machines-reason').textContent, /could not be read: servers\.json is not valid JSON/);
  assert.ok(u.q('.machines-add'));
  fail = false; u.q('.machines-retry').click(); await settle();
  assert.equal(u.q('.setup-empty').textContent, 'No machine runs this workspace yet.');
});

test('while the server learns unknown keys the box reads again, and shows the machines it found', async t => {
  const answers = [answer([machine('altair-aweb', { check: { reachable: true, version: '0.39.0', error: null } })], { backfilling: true }),
    answer([machine('altair-aweb', { check: { reachable: true, version: '0.39.0', error: null } }), machine('legacy', { check: { reachable: true, version: '0.38.0', error: null } })])];
  const u = setup(t, { '/api/servers': () => answers.length > 1 ? answers.shift() : answers[0] }, { backfillDelay: 0 });
  for (let i = 0; i < 4; i++) { await settle(); await new Promise(r => setTimeout(r, 0)); }
  assert.deepEqual(u.qa('[data-machine]').map(r => r.dataset.machine), ['altair-aweb', 'legacy']);
  assert.equal(u.calls.filter(c => c.path.startsWith('/api/servers')).length, 2);
});

test('a Check that answers late leaves focus where a newer press put it', async t => {
  let release;
  const u = setup(t, {
    '/api/servers': () => answer([machine('altair-aweb', { check: { reachable: true, version: '0.39.0', error: null } })]),
    '/api/server-check': () => new Promise(r => { release = () => r({ id: 'altair-aweb', check: { reachable: true, version: '0.39.0', error: null } }); }),
  });
  await settle();
  u.row('altair-aweb').querySelector('.machine-check').click(); await settle();
  u.row('altair-aweb').querySelector('.machine-remove').click();
  assert.equal(u.doc.activeElement.className, 'machine-confirm-cancel');
  release(); await settle();
  assert.equal(u.doc.activeElement.className, 'machine-confirm-cancel');
});

test('an owner that moved on: no answer renders or starts the next step, and the Add dialog closes', async t => {
  let owned = true, release;
  const u = setup(t, {
    '/api/servers': () => answer([], { aweb: true }),
    '/api/server-connect': body => body.phase === 'connect' ? new Promise(r => { release = () => r({ schemaVersion: 1, ok: true, result: { id: 'altair-aweb', ready: true, steps: [{ step: 'register', status: 'done' }] } }); }) : assert.fail('no messaging step'),
  }, { owns: () => owned });
  await settle();
  u.q('.machines-add').click();
  const host = u.q('.machine-host'); host.value = 'altair'; host.dispatchEvent(new u.dom.window.Event('input', { bubbles: true }));
  const folder = u.q('.machine-folder'); folder.value = '~/aweb'; folder.dispatchEvent(new u.dom.window.Event('input', { bubbles: true }));
  u.q('.machine-primary').click(); await settle();
  owned = false; release(); await settle();
  assert.equal(u.q('.machine-dialog'), null);
  assert.deepEqual(u.calls.map(c => c.path.split('?')[0]), ['/api/servers', '/api/server-connect'], 'no messaging step, no list read');
});

test('#1879: above the tested bound Add, Check and Remove are held back with the notice, and no check runs; a reprobe into the bound gives them back', async t => {
  const cs = await import('../renderer/views/cli-status.mjs');
  const cli = (extra = {}) => ({ ok: true, bin: '/oats', version: '0.70.1', source: 'path', required: { desktopApi: 1, range: '>=0.26.0, tested through 0.69' }, tried: [], features: [], ...extra });
  let probe = cli({ aboveTested: true, testedThrough: '0.69' });
  const cliCtx = { api: async () => probe };
  await cs.refreshCli(cliCtx);
  t.after(() => cs.resetCliStateForTests());
  const u = setup(t, {
    '/api/servers': () => answer([machine('altair-aweb')]),
    '/api/server-check': body => ({ id: body.id, check: { reachable: true, version: '0.70.1', error: null } }),
  });
  await settle();
  const notice = cs.cliHeldBack('POST /api/server-connect');
  assert.match(notice, /^This Desktop was tested with oats CLIs up to 0\.69; the installed CLI is 0\.70\.1\. /);
  const controls = () => ['.machines-add', '.machine-check', '.machine-remove'].map(s => [u.q(s).disabled, u.q(s).title]);
  assert.deepEqual(controls(), [[true, notice], [true, notice], [true, notice]]);
  assert.deepEqual(u.calls.map(c => c.path), [`/api/servers?ws=${encodeURIComponent(WS)}`], 'no background check');
  probe = cli({ version: '0.69.25' });
  await cs.refreshCli(cliCtx); await settle();
  assert.deepEqual(controls(), [[false, ''], [false, ''], [false, '']]);
  probe = cli({ aboveTested: true, testedThrough: '0.69' });
  await cs.refreshCli(cliCtx); await settle();
  assert.deepEqual(controls(), [[true, notice], [true, notice], [true, notice]], 'and back again, on the button kept across renders');
});
