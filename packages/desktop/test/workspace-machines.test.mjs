// #517 and the Desktop UI rework's slice 3b: the Workspace's Machines section — this computer and this workspace's
// registrations with what the last check said, one background check per machine per run, Enter opens one with Check
// and Remove (confirmed), and Add a machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createWorkspaceMachines, resetMachineChecks, THIS_COMPUTER } from '../renderer/workspace-machines.mjs';

const WS = 'ws:0123456789abcdef0123', KEY = 'github.com/example/ac', DEPLOYMENT = '/Users/alex/Agents/aweb';
const machine = (id, extra = {}) => ({ id, label: id.split('-')[0], sshHost: id.split('-')[0], workspace: `/home/alex/${id}`, workspaceKey: KEY, check: null, ...extra });
const answer = (servers, extra = {}) => ({ servers, filtered: true, key: KEY, deployment: DEPLOYMENT, aweb: false, ...extra });
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };

function setup(t, routes, options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="host" class="oats-view"></div></body></html>', { pretendToBeVisual: true });
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
  const row = id => qa('[data-machine]').find(li => li.dataset.machine === id) ?? null;
  const cells = id => [...row(id).querySelectorAll('.machine-row > .machine-cell')].map(c => c.textContent);
  /** Enter on a machine's row (its button) opens it: Check and Remove. */
  const open = id => row(id).querySelector('button.machine-row').click();
  return { dom, doc, ui, calls, q, qa, row, cells, open };
}

// The Desktop UI rework, slice 3b: the Machines section lists the computers this workspace runs on — this computer, then
// each registered machine — reachable or not and the OATS version; Enter opens one with Check and Remove. The agents per
// machine are cut from this slice (the effort's lead): no count is shown.
test('slice3b machines section lists servers', async t => {
  const u = setup(t, {
    '/api/servers': () => answer([machine('devbox-aweb', { check: { reachable: true, version: '0.69.20', error: null } }), machine('laptop-aweb', { check: { reachable: false, version: null, error: 'ssh to laptop failed: timeout' } })]),
  }, { cli: () => ({ version: '0.69.21' }) });
  await settle();
  assert.equal(u.q('.machines-title').textContent, 'Machines');
  assert.equal(u.q('.machines-lead').textContent, 'The computers this workspace runs on.');
  assert.deepEqual(u.qa('[data-machine]').map(li => li.dataset.machine), [THIS_COMPUTER, 'devbox-aweb', 'laptop-aweb']);
  // name | reachable | OATS version; no agent count anywhere.
  assert.deepEqual(u.cells(THIS_COMPUTER), ['This computer', 'reachable', 'oats 0.69.21']);
  assert.deepEqual(u.cells('devbox-aweb'), ['devbox-aweb', 'reachable', 'oats 0.69.20']);
  assert.deepEqual(u.cells('laptop-aweb'), ['laptop-aweb', 'not reachable', '']);
  assert.equal(u.q('.agents'), null); assert.doesNotMatch(u.ui.element.textContent, /\bagents?\b/);
  // This computer is not a registration: nothing to open, check or remove.
  assert.equal(u.row(THIS_COMPUTER).querySelector('button'), null);
  // A registered machine's row is one button: Enter opens it (native activation), with its facts, Check and Remove.
  const button = u.row('devbox-aweb').querySelector('button.machine-row');
  assert.equal(button.getAttribute('aria-expanded'), 'false'); assert.equal(u.row('devbox-aweb').querySelector('.machine-check'), null, 'closed: no actions yet');
  button.focus(); button.click();
  assert.equal(u.row('devbox-aweb').querySelector('button.machine-row').getAttribute('aria-expanded'), 'true');
  assert.equal(u.doc.activeElement, u.row('devbox-aweb').querySelector('button.machine-row'), 'focus stays on the row');
  const facts = Object.fromEntries([...u.row('devbox-aweb').querySelectorAll('.machine-facts dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent]));
  assert.deepEqual(facts, { Name: 'devbox', 'ssh host': 'devbox', Folder: '/home/alex/devbox-aweb' });
  assert.deepEqual([...u.row('devbox-aweb').querySelectorAll('.machine-acts button')].map(b => b.textContent), ['Check', 'Remove']);
  // A repaint keeps the open machine open.
  u.ui.sync();
  assert.ok(u.row('devbox-aweb').querySelector('.machine-check'));
  // "Add a machine" is today's dialog.
  assert.equal(u.q('.machines-add').textContent, 'Add a machine to this workspace…');
  // A view with no deployment on this computer (a remote-only one): no "This computer"; its machines' deployments, from
  // the panel's facts, with no version claimed.
  const remote = setup(t, { '/api/servers': () => ({ servers: [], filtered: true, key: null, deployment: null, aweb: false, reason: 'No deployment of this workspace on this computer.' }) },
    { here: () => false, elsewhere: () => [{ id: 'r1', machine: 'devbox', path: '/srv/team', local: false, reachable: true }, { id: 'r2', machine: 'lab', local: false, reachable: false }],
      cli: () => ({ version: '0.69.21' }) });
  await settle();
  assert.deepEqual(remote.qa('[data-machine]').map(li => [...li.querySelectorAll('.machine-row > .machine-cell')].map(c => c.textContent)),
    [['devbox', 'reachable', ''], ['lab', 'not reachable', '']]);
  assert.equal(remote.row(THIS_COMPUTER), null);
  assert.equal(remote.q('.machines-reason').textContent, 'No deployment of this workspace on this computer.');
  assert.equal(remote.q('.machines-add'), null);
});

// This computer's deployment, read or not: pending reads, unreadable says why in the observation's own words.
test('this computer says whether its deployment was read: reading, not read with why, reachable', async t => {
  const state = { local: { status: 'pending' } };
  const u = setup(t, { '/api/servers': () => answer([]) }, { localObservation: () => state.local, cli: () => ({ version: '0.69.21' }) });
  await settle();
  assert.deepEqual(u.cells(THIS_COMPUTER), ['This computer', 'reading…', 'oats 0.69.21']);
  state.local = { status: 'unavailable', text: 'E_CLI_FAILED: roster command failed' }; u.ui.sync();
  assert.deepEqual(u.cells(THIS_COMPUTER).slice(1, 2), ['not read']);
  assert.equal(u.row(THIS_COMPUTER).querySelector('.machine-state').title, 'E_CLI_FAILED: roster command failed');
  assert.equal(u.q('.machines-notes .machines-reason').textContent, 'E_CLI_FAILED: roster command failed', 'why, in the observation\'s words');
  state.local = { status: 'observed' }; u.ui.sync();
  assert.deepEqual(u.cells(THIS_COMPUTER).slice(1, 2), ['reachable']);
  assert.equal(u.q('.machines-notes .machines-reason'), null);
});

// Whole-surface review: the first list read has a loading state; a failed one keeps focus on its Retry across repaints.
test('the first list read says it is reading; a failed read keeps focus on Retry across a repaint', async t => {
  let release, fail = false;
  const u = setup(t, { '/api/servers': () => fail ? { httpStatus: 500, body: { error: 'boom' } } : new Promise(r => { release = () => r(answer([machine('devbox-aweb')])); }) });
  await settle();
  const loading = u.q('.machines-loading');
  assert.equal(loading.textContent, 'Reading the machines of this workspace…'); assert.equal(loading.getAttribute('role'), 'status');
  assert.equal(u.q('.machines-list').getAttribute('aria-busy'), 'true');
  assert.deepEqual(u.qa('[data-machine]').map(li => li.dataset.machine), [THIS_COMPUTER], 'this computer stands meanwhile');
  release(); await settle();
  assert.equal(u.q('.machines-loading'), null); assert.equal(u.q('.machines-list').getAttribute('aria-busy'), null);
  assert.ok(u.row('devbox-aweb'));
  // A failed read: its Retry keeps focus while the failure stands, across a repaint.
  const f = setup(t, { '/api/servers': () => ({ httpStatus: 500, body: { error: 'boom' } }) });
  await settle();
  f.q('.machines-retry').focus(); f.ui.sync();
  assert.equal(f.doc.activeElement, f.q('.machines-retry'));
  // Retry pressed: the read runs again (reading), and focus never falls to <body>.
  f.q('.machines-retry').click();
  assert.notEqual(f.doc.activeElement, f.doc.body);
  await settle();
  assert.equal(f.doc.activeElement, f.q('.machines-retry'), 'failed again: back on Retry');
});

test('lists this workspace\'s machines and checks each unchecked one once in the background', async t => {
  let released;
  const gate = new Promise(r => { released = r; });
  const u = setup(t, {
    '/api/servers': () => answer([machine('devbox-aweb'), machine('laptop-aweb', { check: { reachable: false, version: null, error: 'ssh to laptop failed: timeout' } })]),
    '/api/server-check': async body => { await gate; return { id: body.id, check: { reachable: true, version: '0.39.0', error: null } }; },
  });
  await settle();
  assert.deepEqual(u.calls.map(c => c.path), [`/api/servers?ws=${encodeURIComponent(WS)}`, `/api/server-check?ws=${encodeURIComponent(WS)}`]);
  assert.deepEqual(u.cells('devbox-aweb'), ['devbox-aweb', 'checking…', '']);
  assert.deepEqual(u.cells('laptop-aweb'), ['laptop-aweb', 'not reachable', ''], 'a held check is shown, not re-run');
  assert.equal(u.row('laptop-aweb').querySelector('.machine-state').title, 'ssh to laptop failed: timeout');
  assert.equal(u.row('laptop-aweb').querySelector('.machine-state').dataset.reachable, 'false', 'the warn chip');
  // The row's title keeps the facts a narrow row hides.
  assert.equal(u.row('laptop-aweb').querySelector('.machine-row').title, 'laptop-aweb · laptop · laptop · /home/alex/laptop-aweb');
  released(); await settle();
  assert.deepEqual(u.cells('devbox-aweb'), ['devbox-aweb', 'reachable', 'oats 0.39.0']);
  assert.ok(u.row('devbox-aweb').querySelector('.machine-state[data-reachable=true] svg'), 'reachable: a check and a muted word');
  u.ui.refresh(); await settle();
  assert.equal(u.calls.filter(c => c.path.startsWith('/api/server-check')).length, 1, 'once per machine per run');
});

test('Check re-runs the check for that machine and shows what it said', async t => {
  let n = 0;
  const u = setup(t, {
    '/api/servers': () => answer([machine('devbox-aweb', { check: { reachable: true, version: '0.38.0', error: null } })]),
    '/api/server-check': body => ({ id: body.id, check: ++n === 1 ? { reachable: false, version: null, error: 'ssh failed' } : null }),
  });
  await settle();
  assert.equal(u.calls.length, 1, 'checked already: no background check');
  u.open('devbox-aweb');
  const check = u.row('devbox-aweb').querySelector('.machine-check');
  assert.equal(check.getAttribute('aria-label'), 'Check devbox-aweb');
  check.click(); await settle();
  assert.deepEqual(u.calls.at(-1), { path: `/api/server-check?ws=${encodeURIComponent(WS)}`, body: { id: 'devbox-aweb' } });
  assert.equal(u.cells('devbox-aweb')[1], 'not reachable');
  assert.equal(u.doc.activeElement, u.row('devbox-aweb').querySelector('.machine-check'), 'focus stays on Check');
});

test('Remove asks first; Cancel keeps it; confirming removes it through the CLI and re-reads the list', async t => {
  let servers = [machine('devbox-aweb', { check: { reachable: true, version: '0.39.0', error: null } })];
  const u = setup(t, {
    '/api/servers': () => answer(servers),
    '/api/server-remove': body => { servers = []; return { schemaVersion: 1, ok: true, result: { removed: body.id, remoteInstancesStillTracked: [] } }; },
  });
  await settle();
  u.open('devbox-aweb');
  u.row('devbox-aweb').querySelector('.machine-remove').click();
  const confirm = u.row('devbox-aweb').querySelector('.machine-confirm');
  assert.equal(confirm.querySelector('p').textContent, 'Remove devbox-aweb? Agents started there keep running and can still be retired from here.');
  assert.equal(u.doc.activeElement, confirm.querySelector('.machine-confirm-cancel'));
  confirm.querySelector('.machine-confirm-cancel').click();
  assert.equal(u.row('devbox-aweb').querySelector('.machine-confirm'), null);
  assert.equal(u.doc.activeElement, u.row('devbox-aweb').querySelector('.machine-remove'));
  assert.equal(u.calls.filter(c => c.path.startsWith('/api/server-remove')).length, 0);
  u.row('devbox-aweb').querySelector('.machine-remove').click();
  u.row('devbox-aweb').querySelector('.machine-confirm-remove').click(); await settle();
  assert.deepEqual(u.calls.find(c => c.path.startsWith('/api/server-remove')).body, { id: 'devbox-aweb' });
  assert.equal(u.row('devbox-aweb'), null);
  assert.equal(u.q('.machines-empty').textContent, 'No other machine runs this workspace yet.');
  assert.equal(u.doc.activeElement, u.q('.machines-add'));
});

test('a refused Remove is said in the row, in the CLI\'s words', async t => {
  const u = setup(t, {
    '/api/servers': () => answer([machine('devbox-aweb', { check: { reachable: true, version: '0.39.0', error: null } })]),
    '/api/server-remove': () => ({ schemaVersion: 1, ok: false, error: { code: 'E_SERVERS_UNREADABLE', message: 'servers.json is not valid JSON' } }),
  });
  await settle();
  u.open('devbox-aweb');
  u.row('devbox-aweb').querySelector('.machine-remove').click();
  u.row('devbox-aweb').querySelector('.machine-confirm-remove').click(); await settle();
  assert.equal(u.row('devbox-aweb').querySelector('.machine-error').textContent, 'servers.json is not valid JSON (E_SERVERS_UNREADABLE)');
});

test('Add a machine opens the dialog for this workspace; an added machine is listed', async t => {
  let servers = [];
  const u = setup(t, {
    '/api/servers': () => answer(servers, { aweb: false }),
    '/api/server-connect': body => { servers = [machine(body.id)]; return { schemaVersion: 1, ok: true, result: { id: body.id, ready: true, steps: [] } }; },
    '/api/server-check': body => ({ id: body.id, check: { reachable: true, version: '0.39.0', error: null } }),
  });
  await settle();
  assert.equal(u.q('.machines-empty').textContent, 'No other machine runs this workspace yet.');
  u.q('.machines-add').click();
  assert.ok(u.q('.machine-dialog'));
  assert.equal(u.q('.machine-folder').value, '', 'no folder is suggested');
  const host = u.q('.machine-host'); host.value = 'devbox'; host.dispatchEvent(new u.dom.window.Event('input', { bubbles: true }));
  const folder = u.q('.machine-folder'); folder.value = '~/aweb'; folder.dispatchEvent(new u.dom.window.Event('input', { bubbles: true }));
  u.q('.machine-primary').click(); await settle();
  assert.equal(u.q('.machine-dialog'), null);
  assert.ok(u.row('devbox-aweb'));
  assert.equal(u.doc.activeElement, u.q('.machines-add'));
});

test('no workspace key: the section says why and offers nothing; gates off: this computer only, nothing to add', async t => {
  const reason = 'This deployment reports no workspace key, so no other machine can be matched to it.';
  const u = setup(t, { '/api/servers': () => ({ servers: [], filtered: true, key: null, deployment: null, aweb: false, reason }) });
  await settle();
  assert.equal(u.q('.machines-reason').textContent, reason);
  assert.equal(u.q('.machines-add'), null);
  const off = setup(t, { '/api/servers': () => ({ servers: [{ id: 'devbox-web', label: 'devbox', sshHost: 'devbox', workspace: '/srv' }] }) });
  await settle();
  // An unfiltered answer (a route without the gates) lists no registered machine.
  assert.deepEqual(off.qa('[data-machine]').map(li => li.dataset.machine), [THIS_COMPUTER]);
  assert.equal(off.q('.machines-add'), null);
  // Without the gates nothing is read at all.
  const ungated = setup(t, {}, { gated: false });
  await settle();
  assert.deepEqual(ungated.calls, []);
  assert.deepEqual(ungated.qa('[data-machine]').map(li => li.dataset.machine), [THIS_COMPUTER]);
});

test('a list that cannot be read says so, with Retry', async t => {
  let fail = true;
  const u = setup(t, { '/api/servers': () => fail ? { httpStatus: 500, body: { error: 'boom' } } : answer([]) });
  await settle();
  assert.match(u.q('.machines-reason').textContent, /could not be read/);
  fail = false; u.q('.machines-retry').click(); await settle();
  assert.equal(u.q('.machines-empty').textContent, 'No other machine runs this workspace yet.');
});

// Review round 1.
test('the registry could not be read (the route\'s own answer): the CLI\'s words, Retry, and Add still offered', async t => {
  let fail = true;
  const u = setup(t, { '/api/servers': () => fail ? answer([], { error: { code: 'E_SERVERS_UNREADABLE', message: 'servers.json is not valid JSON' } }) : answer([]) });
  await settle();
  assert.match(u.q('.machines-reason').textContent, /could not be read: servers\.json is not valid JSON/);
  assert.ok(u.q('.machines-add'));
  fail = false; u.q('.machines-retry').click(); await settle();
  assert.equal(u.q('.machines-empty').textContent, 'No other machine runs this workspace yet.');
});

test('while the server learns unknown keys the section reads again, and shows the machines it found', async t => {
  const answers = [answer([machine('devbox-aweb', { check: { reachable: true, version: '0.39.0', error: null } })], { backfilling: true }),
    answer([machine('devbox-aweb', { check: { reachable: true, version: '0.39.0', error: null } }), machine('legacy', { check: { reachable: true, version: '0.38.0', error: null } })])];
  const u = setup(t, { '/api/servers': () => answers.length > 1 ? answers.shift() : answers[0] }, { backfillDelay: 0 });
  for (let i = 0; i < 4; i++) { await settle(); await new Promise(r => setTimeout(r, 0)); }
  assert.deepEqual(u.qa('[data-machine]').map(r => r.dataset.machine), [THIS_COMPUTER, 'devbox-aweb', 'legacy']);
  assert.equal(u.calls.filter(c => c.path.startsWith('/api/servers')).length, 2);
});

test('a Check that answers late leaves focus where a newer press put it', async t => {
  let release;
  const u = setup(t, {
    '/api/servers': () => answer([machine('devbox-aweb', { check: { reachable: true, version: '0.39.0', error: null } })]),
    '/api/server-check': () => new Promise(r => { release = () => r({ id: 'devbox-aweb', check: { reachable: true, version: '0.39.0', error: null } }); }),
  });
  await settle();
  u.open('devbox-aweb');
  u.row('devbox-aweb').querySelector('.machine-check').click(); await settle();
  u.row('devbox-aweb').querySelector('.machine-remove').click();
  assert.equal(u.doc.activeElement.className, 'machine-confirm-cancel');
  release(); await settle();
  assert.equal(u.doc.activeElement.className, 'machine-confirm-cancel');
});

test('an owner that moved on: no answer renders or starts the next step, and the Add dialog closes', async t => {
  let owned = true, release;
  const u = setup(t, {
    '/api/servers': () => answer([], { aweb: true }),
    '/api/server-connect': body => body.phase === 'connect' ? new Promise(r => { release = () => r({ schemaVersion: 1, ok: true, result: { id: 'devbox-aweb', ready: true, steps: [{ step: 'register', status: 'done' }] } }); }) : assert.fail('no messaging step'),
  }, { owns: () => owned });
  await settle();
  u.q('.machines-add').click();
  const host = u.q('.machine-host'); host.value = 'devbox'; host.dispatchEvent(new u.dom.window.Event('input', { bubbles: true }));
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
    '/api/servers': () => answer([machine('devbox-aweb')]),
    '/api/server-check': body => ({ id: body.id, check: { reachable: true, version: '0.70.1', error: null } }),
  });
  await settle();
  u.open('devbox-aweb');
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
