// Run in background (#1579), the Desktop's actions: the backend boundary (server/instance-background.mjs, on the
// boundary it shares with the colour: server/instance-record.mjs) over `oats instance background`, its argv
// (cli-adapter.mjs cliInstanceBackground), the row menu's Move to background / Move out of background
// (renderer/instance-background-menu.mjs in instance-actions.mjs), and the spawn dialog's Run in background switch
// (the choice, its flags, the preview's and the decision's `background`). The kernel branch is not merged: the
// fixtures carry the agreed shapes exactly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createInstanceBackgroundBoundary, instanceBackgroundOutcome, INSTANCE_BACKGROUND_FEATURE } from '../server/instance-background.mjs';
import { rereadsRoster } from '../server/instance-record.mjs';
import { cliInstanceBackground, spawnArgv } from '../../client/cli-adapter.mjs';
import { kernelMade } from '../../client/kernel-made.mjs';
import { classifyApiRoute } from '../api-url.mjs';
import { instanceActions } from '../renderer/instance-actions.mjs';
import { createInstanceBackgroundMenu, backgroundOffer, backgroundFailure, BACKGROUND_LABELS } from '../renderer/instance-background-menu.mjs';
import { backgroundPlacement, instanceId } from '../../client/instance-tree.mjs';
import { previewChoices, choiceArgv, previewData } from '../../client/spawn-preview-contract.mjs';
import { spawnDecision, spawnEffective } from '../../client/spawn-decision.mjs';
import { spawnApplyChoicesSupported } from '../../client/spawn-apply-contract.mjs';
import { soulsData } from '../../client/deployment-data.mjs';
import { soulRows } from '../../client/soul-rows.mjs';
import { mountSpawn, settle, kernel, catalogAgents } from './helpers/spawn-dialog-host.mjs';
import { cli as CLI, target } from './helpers/spawn-preview-fixture.mjs';
import { creation } from './helpers/spawn-apply-fixture.mjs';

// ── the backend boundary ───────────────────────────────────────────────────────────────────────────────

const LOCAL = { id: 'team', scope: '/fixture/team' };
const REMOTE = { id: 'remote:box', scope: '/fixture/team', remote: true, server: 'box', group: { server: 'box', probe: { ok: true, features: ['instance-background'] } } };
const row = { instance: 'dev-1', home: '/fixture/team/agents/dev/instances/dev-1' };
const remoteRow = { ...row, server: 'box', addressable: true };
const cli = (...features) => ({ ok: true, bin: '/fixture/oats', features: [INSTANCE_BACKGROUND_FEATURE, ...features] });
const answer = (over = {}) => ({ schemaVersion: 1, ok: true, result: { instanceBackgroundApi: 1, instance: 'dev-1', home: row.home, background: true, changed: true, ...over } });
function boundary(envelope = answer()) {
  const calls = [];
  const request = createInstanceBackgroundBoundary({ invoke: async (bin, args, io) => { calls.push({ bin, args, io }); return typeof envelope === 'function' ? envelope() : envelope; } });
  return { calls, request };
}
const context = (over = {}) => () => ({ workspace: LOCAL, cli: cli(), instances: [row], localCwd: '/fixture/cwd', ...over });

test('boundary: exactly { instance, home, background } or { instance, home, check: true }; anything else runs nothing', async () => {
  const { calls, request } = boundary();
  for (const bad of [null, [], { instance: 'dev-1', home: row.home }, { ...row, background: 'on' }, { ...row, background: 1 }, { ...row, background: null },
    { ...row, background: true, extra: 1 }, { ...row, color: 'sage' }, { instance: 'dev-1', home: 'relative', background: true },
    { instance: '../x', home: row.home, background: true }, { ...row, check: 'yes' }, { ...row, check: true, background: true }]) {
    assert.deepEqual((await request(bad, context())).reason, { code: 'E_BAD_ARGS', message: 'This background request was not valid.' }, JSON.stringify(bad));
  }
  assert.equal(calls.length, 0);
});

test('boundary: only a row this computer holds, in a known workspace; a remote one only when addressable', async () => {
  const { calls, request } = boundary();
  assert.equal((await request({ ...row, background: true }, context({ workspace: null }))).reason.code, 'E_WORKSPACE_UNKNOWN');
  assert.equal((await request({ ...row, background: true }, context({ instances: [] }))).reason.code, 'E_SNAPSHOT_UNKNOWN');
  assert.equal((await request({ ...row, background: true }, context({ instances: [{ ...row, home: '/elsewhere' }] }))).reason.code, 'E_SNAPSHOT_UNKNOWN', 'name and home together');
  assert.equal((await request({ ...row, background: true }, context({ workspace: REMOTE, cli: cli('server-probe-features'), instances: [{ ...remoteRow, addressable: false }] }))).reason.code, 'E_SNAPSHOT_UNKNOWN');
  assert.equal(calls.length, 0);
});

test('boundary: the gate is the feature, said as where it is missing (this CLI, its relay, then the host); a check runs nothing', async () => {
  const { calls, request } = boundary();
  assert.deepEqual(await request({ ...row, background: true }, context({ cli: { ok: true, bin: '/fixture/oats', features: ['instance-color'] } })),
    { status: 'not-run', reason: { code: 'E_INSTANCE_BACKGROUND_UNAVAILABLE', message: "This OATS can't move an instance to the background.", details: { where: 'local' } } });
  const host = { ...REMOTE, group: { server: 'box', probe: { ok: true, features: ['instance-color'] } } };
  assert.deepEqual((await request({ ...row, check: true }, context({ workspace: host, cli: cli('server-probe-features'), instances: [remoteRow] }))).reason.details, { where: 'server' });
  assert.deepEqual((await request({ ...row, check: true }, context({ workspace: REMOTE, cli: cli(), instances: [remoteRow] }))).reason.details, { where: 'local' }, 'this CLI must relay the hosts\' features');
  const relaysOnly = { ok: true, bin: '/fixture/oats', features: ['server-probe-features'] };
  assert.deepEqual((await request({ ...row, check: true }, context({ workspace: REMOTE, cli: relaysOnly, instances: [remoteRow] }))).reason.details, { where: 'local' }, 'the host is never blamed for this computer\'s CLI');
  const unreached = { ...REMOTE, group: { server: 'box', probe: { ok: false, features: ['instance-background'] } } };
  assert.deepEqual((await request({ ...row, check: true }, context({ workspace: unreached, cli: cli('server-probe-features'), instances: [remoteRow] }))).reason.details, { where: 'server' }, 'a host not reached advertises nothing');
  assert.deepEqual(await request({ ...row, check: true }, context()), { status: 'ok', instance: 'dev-1', check: true });
  assert.deepEqual(await request({ ...row, check: true }, context({ workspace: REMOTE, cli: cli('server-probe-features'), instances: [remoteRow] })), { status: 'ok', instance: 'dev-1', check: true });
  assert.equal(calls.length, 0);
});

test('boundary: a write runs the verb in the workspace, or routed with --server for a remote row, and decodes the answer', async () => {
  const { calls, request } = boundary();
  assert.deepEqual(await request({ ...row, background: true }, context()), { status: 'ok', instance: 'dev-1', background: true, changed: true });
  assert.deepEqual(calls[0], { bin: '/fixture/oats', args: { instance: 'dev-1', home: row.home, background: true, context: '/fixture/team' }, io: {} });
  await request({ ...row, background: false }, context({ workspace: REMOTE, cli: cli('server-probe-features'), instances: [remoteRow] }));
  assert.deepEqual(calls[1], { bin: '/fixture/oats', args: { instance: 'dev-1', home: row.home, background: false, server: 'box' }, io: { cwd: '/fixture/cwd' } });
  const thrown = createInstanceBackgroundBoundary({ invoke: async () => { throw new Error('PRIVATE'); } });
  assert.deepEqual(await thrown({ ...row, background: true }, context()), { status: 'unknown', reason: { code: 'E_OUTCOME_UNKNOWN' } }, 'a crash is an unknown outcome');
});

test('boundary: one write per home at a time; another window\'s second is refused without running', async () => {
  let release; const held = new Promise(r => { release = r; });
  const { calls, request } = boundary(() => held.then(() => answer()));
  const first = request({ ...row, background: true }, context());
  assert.deepEqual((await request({ ...row, background: false }, context())).reason, { code: 'E_BUSY', message: 'Another window is moving this instance. Try again.' });
  release(); assert.equal((await first).status, 'ok');
  assert.equal((await request({ ...row, background: false }, context())).status, 'ok', 'free again');
  assert.equal(calls.length, 2);
});

test('outcome: only an error the CLI printed is a refusal; the adapter\'s own, or an answer for another instance or home, is unknown', () => {
  const asked = { instance: 'dev-1', home: row.home };
  assert.deepEqual(instanceBackgroundOutcome(answer({ background: false, changed: false }), asked), { status: 'ok', instance: 'dev-1', background: false, changed: false });
  assert.deepEqual(instanceBackgroundOutcome({ ok: false, error: kernelMade({ code: 'E_INSTANCE_RETIRING', message: 'dev-1 is being retired' }) }, asked),
    { status: 'refused', reason: { code: 'E_INSTANCE_RETIRING', message: 'dev-1 is being retired' } });
  assert.deepEqual(instanceBackgroundOutcome({ ok: false, error: kernelMade({ code: 'E_REMOTE_INCOMPATIBLE', message: 'box: no instance-background' }) }, asked).reason.code, 'E_REMOTE_INCOMPATIBLE');
  assert.deepEqual(instanceBackgroundOutcome({ ok: false, error: { code: 'E_SESSION_UNKNOWN', message: 'forged' } }, asked), { status: 'unknown', reason: { code: 'E_OUTCOME_UNKNOWN' } }, 'unmarked: not the kernel\'s');
  assert.deepEqual(instanceBackgroundOutcome({ ok: false, error: { code: 'E_CLI_TIMEOUT' } }, asked), { status: 'unknown', reason: { code: 'E_CLI_TIMEOUT' } });
  for (const [label, over] of [['another instance', { instance: 'other' }], ['another home', { home: '/fixture/team/agents/dev/instances/dev-2' }],
    ['no home', { home: undefined }], ['not a boolean', { background: 'on' }], ['no changed', { changed: undefined }], ['another api', { instanceBackgroundApi: 2 }]]) {
    assert.equal(instanceBackgroundOutcome(answer(over), asked).status, 'unknown', label);
  }
  assert.equal(instanceBackgroundOutcome({ ok: true, result: null }, asked).status, 'unknown');
});

test('the route re-reads the roster on a change or an unknown outcome only; it is classified for its 50 s deadline', () => {
  assert.equal(rereadsRoster({ status: 'ok', instance: 'dev-1', background: true, changed: true }), true);
  assert.equal(rereadsRoster({ status: 'unknown', reason: { code: 'E_CLI_TIMEOUT' } }), true);
  for (const result of [{ status: 'ok', instance: 'dev-1', background: true, changed: false }, { status: 'ok', instance: 'dev-1', check: true },
    { status: 'refused', reason: { code: 'E_SESSION_UNKNOWN' } }, { status: 'not-run', reason: { code: 'E_BUSY' } }, null]) assert.equal(rereadsRoster(result), false, JSON.stringify(result));
  assert.equal(classifyApiRoute('/api/instance-background?ws=team'), 'instance-background');
});

test('cliInstanceBackground: argv only, on or off, --home and --dir or --server, --json; refuses bad arguments without running', async () => {
  const runs = [];
  const exec = (bin, argv, opts, done) => { runs.push({ bin, argv, cwd: opts.cwd, shell: opts.shell, timeout: opts.timeout });
    done(null, JSON.stringify(answer())); };
  await cliInstanceBackground('/fixture/oats', { instance: 'dev-1', home: '/h/dev-1', context: '/fixture/team', background: true }, { exec });
  await cliInstanceBackground('/fixture/oats', { instance: 'dev-1', home: '/h/dev-1', server: 'box', background: false }, { exec, cwd: '/fixture/cwd' });
  assert.deepEqual(runs, [
    { bin: '/fixture/oats', argv: ['instance', 'background', 'dev-1', 'on', '--home', '/h/dev-1', '--dir', '/fixture/team', '--json'], cwd: '/fixture/team', shell: false, timeout: 30000 },
    { bin: '/fixture/oats', argv: ['instance', 'background', 'dev-1', 'off', '--home', '/h/dev-1', '--server', 'box', '--json'], cwd: '/fixture/cwd', shell: false, timeout: 45000 },
  ]);
  const never = () => assert.fail('must not run');
  for (const bad of [{ instance: '-x', home: '/h', context: '/c', background: true }, { instance: 'a', home: 'h', context: '/c', background: true },
    { instance: 'a', home: '/h', context: '/c', background: 'on' }, { instance: 'a', home: '/h', context: '/c' }, { instance: 'a', home: '/h', server: 'Bad Host', background: true },
    { instance: 'a', home: '/h', context: 'c', background: true }]) {
    assert.equal((await cliInstanceBackground('/fixture/oats', bad, { exec: never })).error.code, 'E_BAD_ARGS', JSON.stringify(bad));
  }
  assert.equal((await cliInstanceBackground('oats', { instance: 'a', home: '/h', context: '/c', background: true }, { exec: never })).error.code, 'E_BAD_ARGS', 'an absolute binary');
});

// ── the row menu ───────────────────────────────────────────────────────────────────────────────────────

const tick = () => new Promise(r => setImmediate(r));
// The roster: boss runs in the background, its child worker is placed there through it; dev-1 and flagged-child (whose
// own flag is set under a main-tree parent) are rows of their own.
const ROSTER = [
  { instance: 'boss', agent: 'lead', agentsRoot: '/fixture/team/agents', home: '/fixture/team/agents/lead/instances/boss', background: true },
  { instance: 'worker', agent: 'dev', agentsRoot: '/fixture/team/agents', home: '/fixture/team/agents/dev/instances/worker', parentInstance: 'boss' },
  { instance: 'dev-1', agent: 'dev', agentsRoot: '/fixture/team/agents', home: '/fixture/team/agents/dev/instances/dev-1' },
  { instance: 'flagged-child', agent: 'dev', agentsRoot: '/fixture/team/agents', home: '/fixture/team/agents/dev/instances/flagged-child', parentInstance: 'dev-1', background: true },
];
const byName = name => ROSTER.find(r => r.instance === name);

test('which item a row offers: out on its own flag, to on any other, neither when it is there only through an ancestor', () => {
  const placed = backgroundPlacement(ROSTER, true);
  assert.equal(backgroundOffer(byName('boss'), placed), 'background-off');
  assert.equal(backgroundOffer(byName('dev-1'), placed), 'background-on');
  assert.equal(backgroundOffer(byName('worker'), placed), null, 'move the parent');
  assert.equal(backgroundOffer(byName('flagged-child'), placed), 'background-off', 'its own flag, whatever its parent');
  assert.deepEqual(BACKGROUND_LABELS, { 'background-on': 'Move to background', 'background-off': 'Move out of background' });
  for (const label of Object.values(BACKGROUND_LABELS)) assert.doesNotMatch(label, /spawn/i);
});

function menuHarness(answers = {}) {
  const requests = [];
  let gated = 0;
  const reply = (r, body) => {
    const a = answers[body.check ? 'check' : 'write'];
    return typeof a === 'function' ? a(r, body) : a ?? (body.check ? { status: 'ok', instance: r.instance, check: true } : { status: 'ok', instance: r.instance, background: body.background, changed: true });
  };
  const menu = createInstanceBackgroundMenu({ deploymentOf: r => r.server ? `remote:${r.server}` : 'team', onGate: () => { gated++; },
    request: async (r, body) => { requests.push({ instance: r.instance, ...body }); return reply(r, body); } });
  return { menu, requests, gated: () => gated };
}

test('the gate is the route\'s check, asked once per deployment and held; until it answers, and without the feature, nothing is drawn', async () => {
  const { menu, requests, gated } = menuHarness({ check: (r) => r.server ? { status: 'not-run', reason: { code: 'E_INSTANCE_BACKGROUND_UNAVAILABLE', details: { where: 'server' } } } : { status: 'ok', instance: r.instance, check: true } });
  const placed = backgroundPlacement(ROSTER, true);
  assert.deepEqual(menu.items(byName('dev-1'), placed), [], 'not known yet');
  assert.deepEqual(menu.items(byName('boss'), placed), [], 'one check in flight for the deployment');
  await tick(); await tick();
  assert.deepEqual(requests, [{ instance: 'dev-1', home: byName('dev-1').home, check: true }]);
  assert.equal(gated(), 1, 'a held answer that changes asks for a repaint');
  assert.deepEqual(menu.items(byName('dev-1'), placed), [{ action: 'background-on', label: 'Move to background' }]);
  assert.deepEqual(menu.items(byName('boss'), placed), [{ action: 'background-off', label: 'Move out of background' }]);
  assert.deepEqual(menu.items(byName('worker'), placed), []);
  assert.deepEqual(menu.items(byName('dev-1'), ROSTER), [{ action: 'background-on', label: 'Move to background' }], 'the rows, walked once, when no placement is given');
  // A remote row's host without the feature: its deployment never offers them.
  const far = { ...byName('dev-1'), server: 'box', addressable: true };
  menu.items(far, placed); await tick(); await tick();
  assert.deepEqual(menu.items(far, placed), []);
  assert.equal(requests.length, 2);
  // An unaddressable remote row never asks (the route could not admit it).
  menu.items({ ...far, server: 'other', addressable: false }, placed); await tick();
  assert.equal(requests.length, 2);
});

test('the gate is asked again once the held answer is old, the held one in force meanwhile', async () => {
  let now = 0, enabled = true;
  const requests = [];
  const menu = createInstanceBackgroundMenu({ deploymentOf: () => 'team', now: () => now, ttlMs: 1000,
    request: async (r, body) => { requests.push(body); return enabled ? { status: 'ok', instance: r.instance, check: true } : { status: 'not-run', reason: { code: 'E_INSTANCE_BACKGROUND_UNAVAILABLE', details: { where: 'local' } } }; } });
  menu.items(byName('dev-1'), ROSTER); await tick(); await tick();
  assert.equal(menu.gate(byName('dev-1')), true); assert.equal(requests.length, 1);
  now = 500; menu.gate(byName('dev-1')); await tick(); assert.equal(requests.length, 1, 'fresh: not asked');
  enabled = false; now = 1500;
  assert.equal(menu.gate(byName('dev-1')), true, 'the held answer while the check runs');
  await tick(); await tick();
  assert.equal(menu.gate(byName('dev-1')), false); assert.equal(requests.length, 2);
});

test('running an item: a success or an unknown outcome resolves (the roster re-read moves the row); a refusal or nothing run throws why', async () => {
  const dev = byName('dev-1');
  let write = (r, body) => ({ status: 'ok', instance: r.instance, background: body.background, changed: true });
  const { menu, requests } = menuHarness({ write: (r, body) => write(r, body) });
  assert.deepEqual(await menu.run('background-on', dev), { status: 'ok', instance: 'dev-1', background: true, changed: true });
  assert.deepEqual(requests.at(-1), { instance: 'dev-1', home: dev.home, background: true });
  await menu.run('background-off', byName('boss'));
  assert.deepEqual(requests.at(-1), { instance: 'boss', home: byName('boss').home, background: false });
  write = () => ({ status: 'unknown', reason: { code: 'E_CLI_TIMEOUT' } });
  assert.equal((await menu.run('background-on', dev)).status, 'unknown');
  write = () => ({ status: 'refused', reason: { code: 'E_INSTANCE_RETIRING', message: 'dev-1 is being retired' } });
  await assert.rejects(menu.run('background-on', dev), error => /dev-1 is being retired/.test(error.message) && /OATS/.test(error.message));
  write = () => ({ status: 'not-run', reason: { code: 'E_BUSY', message: 'Another window is moving this instance. Try again.' } });
  await assert.rejects(menu.run('background-on', dev), { message: 'Another window is moving this instance. Try again.' });
  write = () => ({ status: 'ok', instance: 'dev-1', background: false, changed: true });
  await assert.rejects(menu.run('background-on', dev), /not one this Desktop reads/, 'a success for the other value is no success');
  await assert.rejects(menu.run('open-pr', dev), /Unknown instance action/);
  assert.equal(menu.handles('background-on'), true); assert.equal(menu.handles('retire'), false);
});

test('the reasons a write did not run: the feature missing here or on the host, said apart; the kernel\'s refusal under its name', () => {
  const unavailable = where => ({ status: 'not-run', reason: { code: 'E_INSTANCE_BACKGROUND_UNAVAILABLE', message: 'x', details: { where } } });
  assert.equal(backgroundFailure(unavailable('local'), byName('dev-1'), true), 'Moving an instance to the background needs a newer OATS on this computer.');
  assert.match(backgroundFailure(unavailable('server'), { ...byName('dev-1'), server: 'box', repoName: 'box' }, true), /^box's OATS can't move instances to the background yet\.$/);
  assert.equal(backgroundFailure({ status: 'refused', reason: { code: 'E_SESSION_UNKNOWN', message: '' } }, byName('dev-1'), true), 'E_SESSION_UNKNOWN');
  assert.equal(backgroundFailure({ status: 'ok', instance: 'dev-1', check: true }, byName('dev-1'), true) !== null, true, 'a check is not a write');
});

test('a write the host refuses for the feature withdraws the items at once', async () => {
  const { menu, gated } = menuHarness({ write: () => ({ status: 'not-run', reason: { code: 'E_INSTANCE_BACKGROUND_UNAVAILABLE', message: 'x', details: { where: 'local' } } }) });
  menu.items(byName('dev-1'), ROSTER); await tick(); await tick();
  assert.equal(menu.gate(byName('dev-1')), true);
  await assert.rejects(menu.run('background-on', byName('dev-1')));
  assert.equal(menu.gate(byName('dev-1')), false); assert.equal(gated(), 2);
});

function menuDom() {
  const dom = new JSDOM('<body></body>', { pretendToBeVisual: true });
  for (const [method, newState] of [['showPopover', 'open'], ['hidePopover', 'closed']]) {
    dom.window.HTMLElement.prototype[method] = function () {
      const event = new dom.window.Event('beforetoggle'); Object.defineProperty(event, 'newState', { value: newState });
      this.dispatchEvent(event);
      if (newState === 'open') this.querySelector('[autofocus]')?.focus();
    };
  }
  return dom;
}

test('the row menu draws the item among the caller\'s own, runs it through invoke, and says a refusal through report', async () => {
  const dom = menuDom(), doc = dom.window.document;
  const { menu } = menuHarness({ write: () => ({ status: 'refused', reason: { code: 'E_INSTANCE_RETIRING', message: 'dev-1 is being retired' } }) });
  menu.items(byName('dev-1'), ROSTER); await tick(); await tick();
  const instance = { ...byName('dev-1'), running: true };
  const reports = [], invoked = [];
  const rowButton = doc.createElement('button'); rowButton.className = 'ctx-inst';
  const element = instanceActions(doc, instance, { row: rowButton, scope: 'team', extra: menu.items(instance, ROSTER),
    invoke: async (action, i) => { invoked.push(action); return menu.handles(action) ? menu.run(action, i) : null; },
    report: (headline, { detail }) => reports.push({ headline, detail }), say: m => assert.fail(m) });
  doc.body.append(rowButton, element);
  const item = element.querySelector('[data-action="background-on"]');
  assert.ok(item, 'drawn'); assert.equal(item.getAttribute('role'), 'menuitem'); assert.equal(item.textContent, 'Move to background');
  assert.equal(element.querySelector('[data-action="background-off"]'), null);
  rowButton.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 0));
  item.click(); await tick(); await tick();
  assert.deepEqual(invoked, ['background-on']);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].headline, "Move to background didn't finish for dev-1.");
  assert.match(reports[0].detail, /dev-1 is being retired/);
  dom.window.close();
});

test('a held row (a stale roster) opens no menu at all, so offers nothing; a blocked remote row draws no caller items', async () => {
  const dom = menuDom(), doc = dom.window.document;
  const { menu } = menuHarness();
  menu.items(byName('dev-1'), ROSTER); await tick(); await tick();
  const said = [];
  const rowButton = doc.createElement('button');
  const element = instanceActions(doc, byName('dev-1'), { row: rowButton, scope: 'team', stale: 'The roster is stale.', extra: menu.items(byName('dev-1'), ROSTER),
    invoke: async () => assert.fail('nothing runs'), say: m => said.push(m) });
  doc.body.append(rowButton, element);
  rowButton.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(said, ['The roster is stale.']); assert.notEqual(element.dataset.instanceMenuOpen, 'true');
  const far = { ...byName('dev-1'), server: 'box', addressable: false };
  const blocked = instanceActions(doc, far, { row: doc.createElement('button'), scope: 'remote:box', extra: [{ action: 'background-on', label: 'Move to background' }], invoke: async () => {} });
  assert.equal(blocked.querySelector('[data-action="background-on"]'), null);
  dom.window.close();
});

// ── the spawn contract ─────────────────────────────────────────────────────────────────────────────────

test('choices: background is a boolean or absent; the flags are --background / --no-background, the same to preview and apply', () => {
  assert.equal(Object.hasOwn(previewChoices({}), 'background'), false);
  assert.equal(previewChoices({ background: true }).background, true);
  assert.equal(previewChoices({ background: false }).background, false);
  for (const bad of ['true', 1, null, {}]) assert.equal(previewChoices({ background: bad }), null, JSON.stringify(bad));
  assert.deepEqual(choiceArgv(previewChoices({ purpose: 'api', background: true }), CLI), ['--purpose', 'api', '--background']);
  assert.deepEqual(choiceArgv(previewChoices({ purpose: 'api', background: false }), CLI), ['--purpose', 'api', '--no-background']);
  assert.deepEqual(choiceArgv(previewChoices({ purpose: 'api' }), CLI), ['--purpose', 'api']);
  const withFeature = { ...CLI, features: [...CLI.features, 'instance-background'] };
  assert.equal(spawnApplyChoicesSupported(withFeature, previewChoices({ background: false })), true);
  assert.equal(spawnApplyChoicesSupported(CLI, previewChoices({ background: true })), false, 'only where the CLI lists instance-background');
  assert.equal(spawnApplyChoicesSupported(CLI, previewChoices({})), true);
});

test('a spawn on another machine: --background / --no-background on the routed argv, a boolean only', () => {
  assert.deepEqual(spawnArgv('dev', '/w', '/t', { server: 'box', background: true }), ['spawn', 'dev', '--task-file', '/t', '--server', 'box', '--background', '--json']);
  assert.deepEqual(spawnArgv('dev', '/w', '/t', { server: 'box', background: false }).slice(-2), ['--no-background', '--json']);
  assert.equal(spawnArgv('dev', '/w', '/t', { server: 'box' }).includes('--background'), false);
  assert.throws(() => spawnArgv('dev', '/w', '/t', { server: 'box', background: 'yes' }), { code: 'E_BAD_ARGS' });
});

/** The captured preview, as a kernel with the feature answers it: `background` always, `backgroundFrom` when declared,
 * and the decision binding `effective.background: true` only when true. */
function withBackground(v, background, from) {
  const out = structuredClone(v);
  out.background = background;
  if (from) out.backgroundFrom = from;
  if (background) out.decision.effective.background = true;
  return out;
}
const captured = () => kernel('preview-worktree-purpose').result;

test('the preview: background agrees with the decision, backgroundFrom names who chose it; absent on an older kernel', () => {
  const older = previewData(captured(), target);
  assert.ok(older); assert.equal(Object.hasOwn(older, 'background'), false); assert.equal(Object.hasOwn(older.decision.effective, 'background'), false);
  const on = previewData(withBackground(captured(), true, 'soul'), target);
  assert.equal(on.background, true); assert.equal(on.backgroundFrom, 'soul'); assert.equal(on.decision.effective.background, true);
  assert.deepEqual(previewData(on, target), on, 'the renderer\'s re-validation keeps it');
  const off = previewData(withBackground(captured(), false, 'flag'), target);
  assert.equal(off.background, false); assert.equal(off.backgroundFrom, 'flag'); assert.equal(Object.hasOwn(off.decision.effective, 'background'), false);
  assert.equal(Object.hasOwn(previewData(withBackground(captured(), false), target), 'backgroundFrom'), false, 'neither declared it');
  for (const [label, v] of [
    ['top-level true, the decision silent', (() => { const x = withBackground(captured(), true); delete x.decision.effective.background; return x; })()],
    ['the decision binds it, top-level false', (() => { const x = withBackground(captured(), false); x.decision.effective.background = true; return x; })()],
    ['the decision binds it, top-level absent', (() => { const x = captured(); x.decision.effective.background = true; return x; })()],
    ['the decision binds false', (() => { const x = withBackground(captured(), false); x.decision.effective.background = false; return x; })()],
    ['not a boolean', withBackground(captured(), 'yes')],
    ['an unknown origin', withBackground(captured(), true, 'workspace')],
    ['an origin without a value', (() => { const x = captured(); x.backgroundFrom = 'soul'; return x; })()]]) assert.equal(previewData(v, target), null, label);
});

test('the decision: effective.background is true or absent, and part of the decision compared', () => {
  const e = captured().decision.effective;
  assert.equal(Object.hasOwn(spawnEffective(e), 'background'), false);
  assert.equal(spawnEffective({ ...e, background: true }).background, true);
  assert.equal(spawnEffective({ ...e, background: false }), null);
  const d = captured().decision;
  assert.notDeepEqual(spawnDecision(d, { effectiveRequired: true }), spawnDecision({ ...d, effective: { ...d.effective, background: true } }, { effectiveRequired: true }));
});

test('souls: a soul row carries background exactly when true, and its spawn row keeps it', () => {
  const doc = kernel('souls');
  doc.result.souls[0].background = true; if (doc.result.souls[1]) doc.result.souls[1].background = 'yes';
  const souls = soulsData(doc).souls;
  assert.equal(souls[0].background, true);
  if (souls[1]) assert.equal(Object.hasOwn(souls[1], 'background'), false, 'any other value is dropped');
  const rows = soulRows({ root: '/fixture/base/northwind-workspace/agents', souls: [], workspaceStatus: { members: [] } }, souls);
  assert.equal(rows.find(r => r.name === souls[0].name).background, true);
});

// ── the spawn dialog's switch ──────────────────────────────────────────────────────────────────────────

const FEATURE_CLI = () => ({ ...structuredClone(CLI), features: [...CLI.features, 'instance-background'] });
/** A kernel with the feature: release-manager's previews, answering the flag or the soul's default (`soulDefault`). */
function backgroundKernel(soulDefault) {
  return (_c, { target: t, choices }) => {
    const name = t.selector.soul === 'release-manager' ? (choices.purpose ? 'preview-worktree-purpose' : 'preview-worktree-default') : 'preview-soul-unknown';
    const doc = kernel(name);
    if (doc.ok !== true) return doc;
    const flag = choices.background;
    doc.result = withBackground(doc.result, flag ?? soulDefault, flag !== undefined ? 'flag' : soulDefault ? 'soul' : undefined);
    return doc;
  };
}
async function dialog(t, { soulDefault = false, catalogDefault = soulDefault, cli = FEATURE_CLI(), ...options } = {}) {
  const previews = backgroundKernel(soulDefault);
  const applied = [];
  const u = await mountSpawn(t, { cli, kernel: previews,
    agents: catalogAgents().map(a => a.name === 'release-manager' && catalogDefault ? { ...a, background: true } : a),
    apply: args => { applied.push(structuredClone(args)); return { started: true, envelope: { schemaVersion: 1, ok: true, result: creation(previews(null, args).result) } }; }, ...options });
  await u.open(); await u.type('.fpurpose', 'api-v2'); await settle();
  return { u, applied };
}

test('dialog: without instance-background the switch is not shown and nothing is sent', async t => {
  const { u } = await dialog(t, { cli: structuredClone(CLI), kernel: undefined });
  assert.equal(u.q('.spawn-background').hidden, true);
  assert.ok(u.previews().length > 0);
  assert.ok(u.previews().every(p => !Object.hasOwn(p.choices, 'background')));
});

test('dialog: a real switch, set to the soul\'s default; the default sends no flag, a change sends it, previewed and applied as one', async t => {
  const { u, applied } = await dialog(t, { soulDefault: true });
  const field = u.q('.spawn-background'), control = u.q('.fbackground');
  assert.equal(field.hidden, false);
  assert.equal(control.type, 'checkbox'); assert.equal(control.getAttribute('role'), 'switch');
  assert.equal(control.closest('label').textContent, 'Run in background');
  assert.equal(control.checked, true, 'the soul declares background: true');
  assert.equal(u.q(`#${control.getAttribute('aria-describedby')}`).textContent, 'Listed under Background in the sidebar.');
  assert.doesNotMatch(field.textContent, /spawn/i);
  assert.ok(u.previews().every(p => !Object.hasOwn(p.choices, 'background')), 'the default sends nothing');
  await u.change('.fbackground', false); await settle();
  assert.equal(u.previews().at(-1).choices.background, false);
  assert.equal(u.text('.spawn-background-hint'), 'Listed in the main tree of the sidebar.');
  assert.equal(u.q('.fspawn').disabled, false);
  await u.spawn(); await settle();
  assert.deepEqual(u.spawns().map(b => b.action), ['prepare', 'apply']);
  assert.equal(u.spawns()[0].choices.background, false);
  assert.equal(applied.length, 1);
  assert.deepEqual(choiceArgv(applied[0].choices, FEATURE_CLI()).slice(-1), ['--no-background'], 'the apply carries the flag the preview did');
});

test('dialog: a soul without the default starts off; on sends --background; back to the default sends nothing', async t => {
  const { u } = await dialog(t);
  assert.equal(u.q('.fbackground').checked, false);
  await u.change('.fbackground', true); await settle();
  assert.equal(u.previews().at(-1).choices.background, true);
  await u.change('.fbackground', false); await settle();
  assert.equal(Object.hasOwn(u.previews().at(-1).choices, 'background'), false);
});

test('dialog: one press toggles the switch: the form\'s repaint on `input` finds it touched (the live run, 2026-10-27)', async t => {
  const { u } = await dialog(t);
  const control = u.q('.fbackground');
  // A real press: click, then input, then change. The form's own input listener repaints before change fires.
  control.click(); await settle();
  assert.equal(control.checked, true, 'the first press is kept');
  assert.equal(u.previews().at(-1).choices.background, true);
  control.click(); await settle();
  assert.equal(control.checked, false);
  assert.equal(Object.hasOwn(u.previews().at(-1).choices, 'background'), false, 'back to the default sends nothing');
});

test('dialog: an older catalog is corrected by the preview without the flag: the switch follows the kernel\'s default', async t => {
  const { u } = await dialog(t, { soulDefault: true, catalogDefault: false });
  assert.equal(u.q('.fbackground').checked, true, 'the preview reports the soul\'s default');
  assert.ok(u.previews().every(p => !Object.hasOwn(p.choices, 'background')));
  assert.equal(u.q('.fspawn').disabled, false);
});
