// The roster read asks only for the open windows' workspaces (#1124, the Desktop half). With a CLI that
// lists `roster-workspace-key`, the one read passes `--workspace-key=<key>` once per distinct usable key of
// the views the open windows show, and the kernel then probes those workspaces' registrations, those of
// unknown workspace and saved routes, and no other. Pinned here:
//   * the argv (cli-adapter.mjs `cliRemoteRoster`): no key, the unfiltered read exactly as before; each key
//     one argv element; a key the kernel would refuse refused; the timeout unchanged;
//   * which keys (panel-views.mjs `rosterWorkspaceKeys`), as a table, and when the read is unfiltered;
//   * what a filtered answer makes of what is held (remote-roster.mjs `remoteRosterState` with `asked`): the
//     groups it could not have listed are kept as last read, with their read time, and stay remembered;
//     an unfiltered outcome is what it was (the TUI passes no keys);
//   * main's side: the window set tells it of every change (window-set.mjs `onChange`), and the notifier
//     posts the set in order, again for a new server, and again after a failed post (window-activity.mjs);
//   * the backend: POST /api/windows (guards, refusals that leave the held set as it was, a new key reads
//     now) and the read itself (oats-web.mjs `rosterAsk`, gated on the feature word, and the read block).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cliRemoteRoster, ROSTER_WORKSPACE_KEY } from '../../client/cli-adapter.mjs';
import { remoteRosterState, remotePanelEntries, lastKnownKey, keptReadTimes, unavailableGroups } from '../../client/remote-roster.mjs';
import { observeIdentities, identityMemory } from '../../client/remote-identity-memory.mjs';
import * as shared from '../../client/panel-views.mjs';
import { viewId } from '../../client/workspace-views.mjs';
import { createWindowSet } from '../window-set.mjs';
import { createViewsNotifier, postedViews, MAX_WINDOW_VIEWS } from '../window-activity.mjs';
import { validWorkspaceId } from '../renderer/workspace-id.mjs';
import { DESKTOP_TERMS } from '../renderer/desktop-terms.mjs';
import { deploymentState, rowStale } from '../../client/roster-sections.mjs';
import { createRemoteIdentityStore } from '../server/remote-identity.mjs';
import { SOURCE, HELD, viewDeps, loadServer, alexState, group, identity, remoteRow, observed, row,
  OATS, LAB, A, L, R, V, V_OATS, V_LAB } from './helpers/workspace-views-fixture.mjs';

const T1 = '2026-10-14T10:00:00.000Z', T2 = '2026-10-14T10:00:10.000Z', T3 = '2026-10-14T10:00:20.000Z', T4 = '2026-10-14T10:00:30.000Z';
const ok = (groups) => ({ schemaVersion: 1, ok: true, result: { groups, bounds: { budgetMs: 45000, perTargetTimeoutMs: 20000, elapsedMs: 1 } } });
const WORD = 'roster-workspace-key';

/* ── the argv ─────────────────────────────────────────────────────────────── */

/** An exec double: records each call, prints `answer`. */
function printing(answer = ok([])) {
  const calls = [];
  const exec = (bin, argv, opts, done) => { calls.push({ bin, argv, opts }); done(null, JSON.stringify(answer)); };
  return { calls, exec };
}

test('argv: no key is the unfiltered read, exactly as before; each key is one --workspace-key=<key> element, once', async () => {
  for (const io of [{}, { workspaceKeys: [] }, { workspaceKeys: undefined }]) {
    const p = printing();
    await cliRemoteRoster('/abs/oats', { ...io, exec: p.exec });
    assert.deepEqual(p.calls[0].argv, ['server', 'roster', '--json'], JSON.stringify(io));
  }
  const p = printing();
  await cliRemoteRoster('/abs/oats', { workspaceKeys: [OATS, LAB, OATS], exec: p.exec });
  assert.deepEqual(p.calls[0].argv, ['server', 'roster', `--workspace-key=${OATS}`, `--workspace-key=${LAB}`, '--json'], 'two windows of one workspace: one flag');
});

test('argv: a key with odd characters is one argv element, never through a shell; the timeout is unchanged', async () => {
  const odd = 'git.example.com/a;b/$(id)/`id`/"q"\'/*?|&>';
  const p = printing();
  await cliRemoteRoster('/abs/oats', { workspaceKeys: [odd], exec: p.exec });
  assert.deepEqual(p.calls[0].argv, ['server', 'roster', `--workspace-key=${odd}`, '--json']);
  assert.equal(p.calls[0].opts.shell, false);
  assert.equal(p.calls[0].opts.timeout, 60_000, 'the read keeps its own timeout');
  const plain = printing();
  await cliRemoteRoster('/abs/oats', { exec: plain.exec });
  assert.equal(plain.calls[0].opts.timeout, 60_000);
});

test('argv: a key the kernel would refuse is refused here, before anything runs', () => {
  const p = printing();
  for (const keys of [[''], ['a b'], ['a\tb'], ['a\nb'], ['a\u0000b'], ['a\u007fb'], ['--json'], ['--x=y'], [7], [null], 'github.com/o/r', [OATS, 'a b'],
    Array.from({ length: 65 }, (_, i) => `k/${i}`)]) {
    assert.throws(() => cliRemoteRoster('/abs/oats', { workspaceKeys: keys, exec: p.exec }), { code: 'E_BAD_ARGS' }, JSON.stringify(keys));
  }
  assert.equal(p.calls.length, 0);
  // A single leading dash is a value (keys are host/path, so none starts so, but the kernel reads it as the value).
  assert.ok(ROSTER_WORKSPACE_KEY.test('-x') && ROSTER_WORKSPACE_KEY.test(OATS) && !ROSTER_WORKSPACE_KEY.test('--x'));
});

/* ── which keys ───────────────────────────────────────────────────────────── */

/** The server's `held` (cut out of oats-web.mjs) over Alex's fixture, with `over` laid on. */
function heldOf(over = {}) {
  const { state } = alexState(over);
  const deps = viewDeps(state);
  return new Function(...Object.keys(deps), `${HELD}\nreturn held;`)(...Object.values(deps))();
}
const keys = (windows, over) => shared.rosterWorkspaceKeys(heldOf(over), windows, DESKTOP_TERMS);
const MEMBER = 'github.com/acme/member-of', ODD = 'github.com/odd key';
const memberIdentity = { ...identity(MEMBER, 'acme:m'), keyFrom: 'member' };
const builder = (ws, extra = {}) => group('builder:s1', 'builder', '/srv/s', ws, [remoteRow('s-a', '/srv/s')], extra);
const S = 'remote:builder:s1';

test('which keys: one per distinct usable key of the windows\' views, sorted', () => {
  assert.deepEqual(keys([]), [], 'no window: no key (the caller reads unfiltered)');
  assert.deepEqual(keys([V_OATS]), [OATS], 'a matched view: its key (its local and remote deployments share it)');
  assert.deepEqual(keys([V_OATS, V_LAB]), [OATS, LAB], 'a remote-only matched view too');
  assert.deepEqual(keys([V_LAB, V_OATS]), [OATS, LAB], 'in one order whatever the windows\' order');
  assert.deepEqual(keys([L]), [], 'a local deployment with no key: no key, and nothing of another machine to lose');
  assert.deepEqual(keys([V_OATS, L]), [OATS]);
  // Two views of one key (another default team): one key.
  const otherTeam = group('build:r1', 'build', '/srv/r', identity(OATS, 'aweb:other'), []);
  const both = keys([V_OATS, viewId(OATS, 'aweb:other')], { remoteGroups: [alexState().devbox, alexState().laptop, otherTeam] });
  assert.deepEqual(both, [OATS]);
});

test('which keys: an unattached view gives its deployment\'s key, member-derived included, reported or remembered', () => {
  // A host whose key is member-derived is registered under that key (the kernel records the host's key, whatever its keyFrom).
  const { devbox, laptop } = alexState();
  assert.deepEqual(keys([S], { remoteGroups: [devbox, laptop, builder(memberIdentity)] }), [MEMBER]);
  // A machine not reached keeps the key remembered for it.
  const remoteIdentities = createRemoteIdentityStore({ file: null });
  remoteIdentities.observe([builder(memberIdentity)]);
  const down = builder(null, { probe: { ok: false, error: { code: 'E_SSH', message: 'ssh failed' } } });
  assert.deepEqual(keys([S], { remoteGroups: [devbox, laptop, down], remoteIdentities }), [MEMBER]);
});

test('which keys: unfiltered (null) wherever a window\'s machines could not be named', () => {
  const { devbox, laptop } = alexState();
  assert.equal(keys(null), null, 'no window set yet: main has not posted');
  assert.equal(keys(undefined), null);
  assert.equal(keys([V_OATS], { rosterAnswered: false }), null, 'no roster answer yet: the first read holds every machine');
  assert.equal(keys([V_OATS, null]), null, 'a window showing the switcher lists every workspace');
  assert.equal(keys(['ws:nosuch']), null, 'a view this server does not serve (a window ahead of the served list)');
  const down = builder(null, { probe: { ok: false, error: { code: 'E_SSH', message: 'ssh failed' } } });
  assert.equal(keys([V_OATS, S], { remoteGroups: [devbox, laptop, down] }), null, 'a machine whose key is unknown, neither reported nor remembered');
  // A key the kernel would refuse is no registration's: on another machine's view the read is unfiltered, on a local one it adds nothing.
  assert.equal(keys([S], { remoteGroups: [devbox, laptop, builder({ ...identity(ODD), keyFrom: 'member' })] }), null);
  assert.equal(keys([S], { remoteGroups: [devbox, laptop, builder({ ...identity('--odd'), keyFrom: 'member' })] }), null);
  const oddLocal = { ...observed(L, { reachable: true, ...identity(ODD), keyFrom: 'member' }, [row(L, 'l-a')]) };
  const { state } = alexState();
  assert.deepEqual(keys([V_OATS, L], { snapshot: { byWs: new Map([...state.snapshot.byWs, [L, oddLocal]]) } }), [OATS]);
});

/* ── a filtered answer, merged ────────────────────────────────────────────── */

const devboxG = () => alexState().devbox, laptopG = () => alexState().laptop;
const unknownG = () => group('box:d1', 'box', '/srv/d', null, [], { probe: { ok: false, error: { code: 'E_SSH', message: 'ssh failed' } } });
const answered = (groups) => ({ remoteGroups: groups, rosterAnswered: true, rosterFailure: null });
const askedFor = (keyList, remembered = identityMemory({ memory: new Map(), notes: new Map() })) => ({ keys: keyList, keyOf: (g) => lastKnownKey(g, remembered) });

test('a filtered answer replaces what it could list, and keeps, as last read, what it did not ask for', () => {
  const before = answered([devboxG(), laptopG(), unknownG()]);
  const fresh = { ...devboxG(), instances: [] };
  const next = remoteRosterState(before, { envelope: ok([fresh]), asked: askedFor([OATS]) }, T2);
  assert.deepEqual(next.remoteGroups.map((g) => g.id), ['devbox:a1', 'laptop:v1'], 'laptop (another workspace) is kept; box (key unknown) was probed and is gone');
  assert.equal(next.remoteGroups[0], fresh, 'a group the answer lists is the answer\'s');
  assert.equal(next.remoteGroups[1], before.remoteGroups[1], 'a kept group is the object held, unchanged');
  assert.deepEqual(next.kept, ['laptop:v1']);
  assert.deepEqual(next.reported.map((g) => g.id), ['devbox:a1', 'laptop:v1'], 'the memory is handed the kept groups too');
  assert.deepEqual([next.rosterAnswered, next.rosterFailure], [true, null]);
  // A group inside the asked set that the answer does not list is gone, as after any answer.
  const gone = remoteRosterState(before, { envelope: ok([]), asked: askedFor([OATS]) }, T2);
  assert.deepEqual(gone.remoteGroups.map((g) => g.id), ['laptop:v1']);
  assert.deepEqual(remoteRosterState(before, { envelope: ok([]), asked: askedFor([OATS, LAB]) }, T2).remoteGroups, []);
});

test('an unfiltered outcome is what it always was: the TUI, which passes no keys, sees no change', () => {
  const before = answered([devboxG(), laptopG()]);
  const next = remoteRosterState(before, { envelope: ok([devboxG()]) }, T2);
  assert.deepEqual(Object.keys(next).sort(), ['remoteGroups', 'reported', 'rosterAnswered', 'rosterFailure'], 'no `kept`');
  assert.deepEqual(next.remoteGroups.map((g) => g.id), ['devbox:a1']);
  const tui = readFileSync(new URL('../../../test/tui-boundary.test.mjs', import.meta.url), 'utf8');
  assert.ok(tui.includes('"cli-adapter.mjs": ["cliRemoteRoster"]'), 'the TUI reads through the same adapter, with no keys');
});

test('an E_BAD_ARGS answer, or any failure, of a filtered read reads as a failed roster read, as today', () => {
  const before = answered([devboxG(), laptopG()]);
  const refused = { schemaVersion: 1, ok: false, error: { code: 'E_BAD_ARGS', message: '--workspace-key takes a value' } };
  assert.deepEqual(remoteRosterState(before, { envelope: refused, asked: askedFor([OATS]) }, T2), remoteRosterState(before, { envelope: refused }, T2));
  assert.deepEqual(remoteRosterState(before, { envelope: refused, asked: askedFor([OATS]) }, T2).remoteGroups, unavailableGroups(before.remoteGroups, refused.error));
  assert.deepEqual(remoteRosterState(before, { thrown: 'boom' }, T2), remoteRosterState(before, { thrown: 'boom' }, T2));
});

test('lastKnownKey: what the last reached read reported, else what is remembered, else unknown', () => {
  const store = createRemoteIdentityStore({ file: null });
  store.observe([laptopG()]);
  const remembered = identityMemory({ memory: new Map([['laptop:v1', store.get('laptop:v1')]]), notes: new Map() });
  assert.equal(lastKnownKey(devboxG(), remembered), OATS);
  assert.equal(lastKnownKey(builder(memberIdentity), remembered), MEMBER, 'member-derived counts');
  const laptopDown = { ...laptopG(), probe: { ok: false, error: { code: 'E_SSH', message: 'x' } }, workspace: null };
  assert.equal(lastKnownKey(laptopDown, remembered), LAB, 'not reached: remembered');
  assert.equal(lastKnownKey(unknownG(), remembered), null);
  assert.equal(lastKnownKey({ ...devboxG(), workspace: { reachable: true } }, remembered), null, 'a host that reports no identity');
  assert.equal(lastKnownKey(builder({ ...identity(), key: null, keyFrom: null }), remembered), null);
});

test('a kept group keeps its read time: a filtered read never makes it look newer; an unfiltered answer reads it again', () => {
  let held = answered([]), times = new Map(), answeredAt = null;
  const take = (outcome, at) => {
    const next = remoteRosterState(held, outcome, at);
    times = keptReadTimes(times, next, answeredAt);
    if (next.reported) answeredAt = at;
    held = next;
    return next;
  };
  take({ envelope: ok([devboxG(), laptopG()]) }, T1);
  assert.deepEqual([...times], []);
  take({ envelope: ok([devboxG()]), asked: askedFor([OATS]) }, T2);
  assert.deepEqual([...times], [['laptop:v1', T1]], 'read by the answer at T1');
  take({ envelope: ok([devboxG()]), asked: askedFor([OATS]) }, T3);
  assert.deepEqual([...times], [['laptop:v1', T1]], 'still T1');
  take({ thrown: 'boom' }, T4);
  assert.deepEqual([...times], [['laptop:v1', T1]], 'a failed read changes no read time');
  const panels = new Map(remotePanelEntries(held.remoteGroups, T4, times));
  assert.equal(panels.get(V).generatedAt, T1, 'the kept group\'s panel says when it was read');
  assert.equal(panels.get(R).generatedAt, T4);
  assert.deepEqual(remotePanelEntries(held.remoteGroups, T4).map(([, p]) => p.generatedAt), [T4, T4], 'without times, as before');
  take({ envelope: ok([devboxG(), laptopG()]) }, T4);
  assert.deepEqual([...times], [], 'read again: no kept time');
  assert.deepEqual([...keptReadTimes(new Map([['x', T1]]), { remoteGroups: [], reported: null }, T2)], [], 'gated: nothing held');
});

test('the memory keeps a kept group\'s identity: a filtered answer forgets only what it could have listed', () => {
  const first = observeIdentities({ memory: new Map(), notes: new Map() }, [devboxG(), laptopG()], T1);
  const next = remoteRosterState(answered([devboxG(), laptopG()]), { envelope: ok([devboxG()]), asked: askedFor([OATS]) }, T2);
  const after = observeIdentities(first, next.reported, T2);
  assert.deepEqual([...after.memory.keys()], ['devbox:a1', 'laptop:v1']);
  assert.equal(after.memory.get('laptop:v1').reportedAt, T1, 'not reported again: its time is kept');
  assert.equal(after.changed, false);
});

test('only a registered group is kept: one known only from saved routes is always probed, and the memory drops it', () => {
  const routeOnly = group('kb-host:m1', 'kb-host', '/srv/m', identity(LAB, 'aweb:lab'), [remoteRow('m-a', '/srv/m', { savedRoute: true })], { registrationPresent: false });
  const before = answered([devboxG(), laptopG(), routeOnly]);
  const next = remoteRosterState(before, { envelope: ok([devboxG()]), asked: askedFor([OATS]) }, T2);
  assert.deepEqual(next.remoteGroups.map((g) => g.id), ['devbox:a1', 'laptop:v1'], 'kb-host (last known LAB, not asked for) is gone: the read probed it');
  assert.deepEqual(next.kept, ['laptop:v1']);
  const first = observeIdentities({ memory: new Map(), notes: new Map() }, before.remoteGroups, T1);
  assert.ok(first.memory.has('kb-host:m1'));
  assert.deepEqual([...observeIdentities(first, next.reported, T2).memory.keys()], ['devbox:a1', 'laptop:v1'], 'its identity is forgotten');
});

test('a kept group reaches the panel and the switcher as last read: stale with its read time, its rows held, never live', async () => {
  const { state } = alexState();
  const at = (kept) => loadServer({ ...state, keptReadAt: new Map(kept) });
  const { request, views } = await at([['laptop:v1', T1]]);
  for (const ws of [V_LAB, V]) {
    const panel = (await request({ url: `/api/panel?ws=${encodeURIComponent(ws)}` })).body;
    assert.equal(panel.generatedAt, T1, `${ws}: made at its read time, not now`);
    assert.equal(panel.error, null);
    const [deployment] = panel.deployments;
    assert.deepEqual([deployment.id, deployment.stale, deploymentState(deployment).key], [V, true, 'stale']);
    assert.ok(panel.instances.length && panel.instances.every((r) => rowStale(r, panel.deployments)), 'its rows wait for a current read');
  }
  const choice = (id) => views.workspaceChoices().find((w) => w.id === id);
  assert.deepEqual([choice(V_LAB).notLive, choice(V_OATS).notLive], [1, 0], 'the switcher does not count it live');
  // Read again (no kept time): live, made now, as before.
  const fresh = await at([]);
  const panel = (await fresh.request({ url: `/api/panel?ws=${encodeURIComponent(V_LAB)}` })).body;
  assert.notEqual(panel.generatedAt, T1);
  assert.deepEqual([panel.deployments[0].stale, deploymentState(panel.deployments[0]).key], [undefined, 'live']);
  assert.equal(fresh.views.workspaceChoices().find((w) => w.id === V_LAB).notLive, 0);
  // A held group the kept times do not name, and a not-reached one, read as they always did.
  const down = alexState({ remoteGroups: [devboxG(), { ...laptopG(), probe: { ok: false, error: { code: 'E_SSH', message: 'x' } } }] });
  const unreached = (await (await loadServer({ ...down.state, keptReadAt: new Map([['laptop:v1', T1]]) })).request({ url: `/api/panel?ws=${encodeURIComponent(V)}` })).body;
  assert.equal(deploymentState(unreached.deployments[0]).key, 'unreached', 'a machine not reached is not reached, kept or not');
});

/* ── main's side ──────────────────────────────────────────────────────────── */

const win = () => { let destroyed = false; return { isDestroyed: () => destroyed, destroy: () => { destroyed = true; }, isMinimized: () => false, restore() {}, show() {}, focus() {} }; };

test('the window set tells main of every change of which window shows which view', () => {
  let changes = 0;
  const set = createWindowSet({ create: () => win(), onChange: () => { changes++; } });
  const views = () => set.entries().map(([, key]) => key);
  const a = set.open('ws:a').win; assert.deepEqual([changes, views()], [1, ['ws:a']]);
  set.open('ws:a'); assert.equal(changes, 1, 'focusing the window that has it changes nothing');
  const b = set.openUnbound(); assert.deepEqual([changes, views()], [2, ['ws:a', null]]);
  set.claim(b, 'ws:b'); assert.deepEqual([changes, views()], [3, ['ws:a', 'ws:b']]);
  set.claim(b, 'ws:a', { focus: false }); assert.equal(changes, 3, 'a refused claim changes nothing');
  set.unbind(a); assert.deepEqual([changes, views()], [4, [null, 'ws:b']]);
  set.remove(b); assert.ok(changes >= 5); assert.deepEqual(views(), [null]);
  assert.doesNotThrow(() => createWindowSet({ create: () => win() }).open('ws:x'), 'onChange is optional');
});

test('the views notifier posts the set in order, one post at a time, and again for a new server or after a failure', async () => {
  const posts = [];
  const post = (body) => new Promise((resolve) => posts.push({ body, resolve }));
  const n = createViewsNotifier({ post });
  const first = n.update(['ws:b', null, 'ws:a'], 1);
  assert.deepEqual(posts.map((p) => p.body), [{ views: [null, 'ws:a', 'ws:b'] }], 'sorted, the switcher first');
  n.update(['ws:a'], 1); n.update(['ws:c'], 1);
  assert.equal(posts.length, 1, 'one in flight');
  posts[0].resolve(true); await new Promise((r) => setImmediate(r));
  assert.deepEqual(posts.map((p) => p.body.views), [[null, 'ws:a', 'ws:b'], ['ws:c']], 'then only the newest set, never an older one after it');
  posts[1].resolve(true); await first;
  await n.update(['ws:c'], 1);
  assert.equal(posts.length, 2, 'the set the backend holds is not posted again');
  const again = n.update(['ws:c'], 2);
  assert.equal(posts.length, 3, 'a new server gets the set');
  posts[2].resolve(false); await again;
  const retry = n.update(['ws:c'], 2);
  assert.equal(posts.length, 4, 'a refused post is posted again at the next update');
  posts[3].resolve(true); await retry;
  const throwing = createViewsNotifier({ post: () => { throw new Error('down'); } });
  await assert.doesNotReject(throwing.update(['ws:a'], 1));
});

test('postedViews: sorted, and more windows than a post may name read as the switcher (every machine)', () => {
  assert.deepEqual(postedViews(['b', 'a', null, 'c']), [null, 'a', 'b', 'c']);
  assert.deepEqual(postedViews(Array.from({ length: MAX_WINDOW_VIEWS + 1 }, (_, i) => `ws:${i}`)), [null]);
  assert.equal(postedViews(Array.from({ length: MAX_WINDOW_VIEWS }, (_, i) => `ws:${i}`)).length, MAX_WINDOW_VIEWS);
  assert.deepEqual(postedViews(undefined), []);
});

test('main posts the set on every change of the window set and at each served-list update, to /api/windows', () => {
  const main = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
  assert.match(main, /createWindowSet\(\{ create: \(key, record\) => createWindow\(key, record\), onChange: \(\) => noteWindowViews\(\) \}\)/);
  assert.match(main, /backendFetch\("\/api\/windows"/);
  const served = main.slice(main.indexOf('function noteServed(list) {'), main.indexOf('\n}', main.indexOf('function noteServed(list) {')));
  assert.match(served, /noteWindowViews\(\);/, 'every served-list update re-posts a set the backend has not taken (a new server, a failed post)');
  assert.match(main, /windowViewsNotifier\.update\(windows\.entries\(\)\.map\(\(\[, key\]\) => key\), serverEpoch\)/);
});

/* ── the backend ──────────────────────────────────────────────────────────── */

/** The shipped handler over Alex's state, with a remote loop that counts its requests. */
async function windowsRoute(over = {}, features = ['workspace-identity', WORD]) {
  const requests = [];
  const { state } = alexState(over);
  const { request } = await loadServer({ ...state, cliState: { ok: true, bin: '/oats', features, remote: ['roster'] } },
    { windowViews: null, MAX_WINDOW_VIEWS, validWorkspaceId, remoteLoop: { request: () => { requests.push(1); } } });
  const post = (body, headers) => request({ url: '/api/windows', method: 'POST', body, ...(headers ? { headers } : {}) });
  return { post, requests };
}

test('POST /api/windows: the loopback Host and POST Origin guards apply', async () => {
  const r = await windowsRoute();
  assert.equal((await r.post({ views: [V_OATS] }, { host: 'evil.example:4820', origin: 'http://localhost:4820' })).status, 403);
  assert.equal((await r.post({ views: [V_OATS] }, { host: '127.0.0.1:4820', origin: 'http://evil.example' })).status, 403);
  assert.equal((await r.post({ views: [V_OATS] }, { host: '127.0.0.1:4820', origin: 'null' })).status, 403);
  assert.equal(r.requests.length, 0);
  assert.deepEqual((await r.post({ views: [V_OATS] })).body, { views: 1 });
});

test('POST /api/windows: a malformed or oversized body is refused and leaves the held set as it was', async () => {
  const r = await windowsRoute();
  assert.equal((await r.post({ views: [V_OATS] })).status, 200);
  assert.equal(r.requests.length, 1, 'a window showing a workspace the last set did not ask for: a read now');
  for (const body of [{}, { views: 'ws:a' }, { views: [1] }, { views: [''] }, { views: ['a\u0001'] }, { views: [{}] }, { views: [V_OATS], extra: 1 },
    { views: Array.from({ length: MAX_WINDOW_VIEWS + 1 }, (_, i) => `ws:${i}`) }, [], null, 'not json']) {
    const answer = await r.post(body);
    assert.deepEqual([answer.status, answer.body.code], [400, 'E_BAD_ARGS'], JSON.stringify(body));
  }
  assert.equal(r.requests.length, 1, 'no refusal reads');
  assert.equal((await r.post({ views: [V_OATS] })).status, 200);
  assert.equal(r.requests.length, 1, 'the held set was the same: posting it again asks for nothing new');
});

test('POST /api/windows: a new workspace reads at once; a window closing or the same set does not; the switcher reads every machine', async () => {
  const r = await windowsRoute();
  await r.post({ views: [V_OATS] }); assert.equal(r.requests.length, 1);
  await r.post({ views: [V_OATS, V_LAB] }); assert.equal(r.requests.length, 2, 'a window opened on another workspace');
  await r.post({ views: [V_LAB] }); assert.equal(r.requests.length, 2, 'a window closed: the next read asks for less, no read now');
  await r.post({ views: [V_LAB, null] }); assert.equal(r.requests.length, 3, 'a window showing the switcher: an unfiltered read now');
  await r.post({ views: [V_LAB, null] }); assert.equal(r.requests.length, 3);
  await r.post({ views: [V_LAB] }); assert.equal(r.requests.length, 4, 'the switcher closed: a read now (coalesced with one in flight)');
  await r.post({ views: [] }); assert.equal(r.requests.length, 4, 'no window');
  await r.post({ views: [V_OATS] }); assert.equal(r.requests.length, 5, 'a window opened after none');
});

test('POST /api/windows: a set says what the next read asks for, never what the last read covered: a workspace opened after an unfiltered set reads now', async () => {
  // A filtered read of oats has landed (lab kept); no read runs between the posts.
  for (const between of [[L], []]) {
    const r = await windowsRoute({ keptReadAt: new Map([['laptop:v1', T1]]) });
    await r.post({ views: [V_OATS] });
    const before = r.requests.length;
    await r.post({ views: between }); assert.equal(r.requests.length, before, `${JSON.stringify(between)}: no key to add`);
    await r.post({ views: [V_LAB] }); assert.equal(r.requests.length, before + 1, `oats -> ${JSON.stringify(between)} -> lab: lab's machines read now`);
  }
});

test('POST /api/windows with a CLI without the word: the set is held, and no read is requested (every read covers every machine)', async () => {
  const r = await windowsRoute({}, ['workspace-identity']);
  assert.deepEqual((await r.post({ views: [V_OATS, V_LAB, null] })).body, { views: 3 });
  assert.equal(r.requests.length, 0);
});

/** oats-web.mjs `rosterAsk`, over doubles of what it reads. */
function rosterAsk({ windowViews, over } = {}) {
  const src = SOURCE.slice(SOURCE.indexOf('function rosterAsk(probe) {'), SOURCE.indexOf('/* OATSWEB_REMOTEREAD_BEGIN'));
  const deps = { rosterWorkspaceKeys: shared.rosterWorkspaceKeys, held: () => heldOf(over), windowViews, DESKTOP_TERMS,
    remote: { lastKnownKey }, remoteIdentities: identityMemory({ memory: new Map(), notes: new Map() }) };
  return new Function(...Object.keys(deps), `${src}\nreturn rosterAsk;`)(...Object.values(deps));
}

test('the read is gated on the feature word of the CLI that answers, never on a version', () => {
  const withWord = { ok: true, bin: '/oats', version: '0.1.0', features: ['workspace-identity', WORD], remote: ['roster'] };
  const without = { ok: true, bin: '/oats', version: '99.0.0', features: ['workspace-identity'], remote: ['roster'] };
  const asked = rosterAsk({ windowViews: [V_OATS, V_LAB] })(withWord);
  assert.deepEqual(asked.keys, [OATS, LAB]);
  assert.equal(asked.keyOf(laptopG()), LAB);
  assert.equal(rosterAsk({ windowViews: [V_OATS, V_LAB] })(without), null, 'no word: today\'s read, whatever the version');
  assert.equal(rosterAsk({ windowViews: [V_OATS, V_LAB] })({ ...withWord, features: null }), null);
  assert.equal(rosterAsk({ windowViews: [] })(withWord), null, 'no usable key: no flag');
  assert.equal(rosterAsk({ windowViews: null })(withWord), null, 'no window set yet');
  assert.equal(rosterAsk({ windowViews: [V_OATS, null] })(withWord), null);
});

test('the window set is read at each read: open, close and switch change the next read\'s keys', () => {
  const cli = { ok: true, bin: '/oats', features: ['workspace-identity', WORD], remote: ['roster'] };
  let windowViews = [V_OATS];
  const src = SOURCE.slice(SOURCE.indexOf('function rosterAsk(probe) {'), SOURCE.indexOf('/* OATSWEB_REMOTEREAD_BEGIN'));
  const ask = new Function('rosterWorkspaceKeys', 'held', 'getViews', 'DESKTOP_TERMS', 'remote', 'remoteIdentities',
    `${src.replaceAll('windowViews', 'getViews()')}\nreturn rosterAsk;`)(shared.rosterWorkspaceKeys, () => heldOf(), () => windowViews, DESKTOP_TERMS, { lastKnownKey }, identityMemory({ memory: new Map(), notes: new Map() }));
  assert.deepEqual(ask(cli).keys, [OATS]);
  windowViews = [V_OATS, V_LAB]; assert.deepEqual(ask(cli).keys, [OATS, LAB], 'opened');
  windowViews = [V_LAB]; assert.deepEqual(ask(cli).keys, [LAB], 'closed');
  windowViews = [L]; assert.equal(ask(cli), null, 'switched to a workspace with no key: unfiltered');
});
