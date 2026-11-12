// One Desktop window per workspace (#481): main's shipped window section, run in a vm with the real
// registry (window-set.mjs) and records (window-records.mjs) over fake BrowserWindows. Covers the window
// channels (claim in place, open, New Window), the take-over relay (window:release-workspace and its
// answer), restore at launch, titles, and closing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createWindowSet } from '../window-set.mjs';
import { fakeWindowClass } from './helpers/fake-window.mjs';
import { parseWindowRecords, resolveView, restorePlan, clampBounds, windowTitle, createWindowRecords } from '../window-records.mjs';
import { trustedForgeFrame } from '../forge-proxy.mjs';
import { validWorkspaceId } from '../renderer/workspace-id.mjs';
import { workspaceHash, trustedRendererUrl, frameWorkspace } from '../renderer/window-binding.mjs';
import { validLayout } from '../renderer/layout-handover.mjs';

const RENDERER = 'file:///app/renderer/index.html';
const A = 'ws:aaaaaaaaaaaaaaaaaaaa', B = 'ws:bbbbbbbbbbbbbbbbbbbb';
const SERVED = [{ id: A, name: 'oats', deployments: ['/d/oats'] }, { id: B, name: 'web', deployments: ['/d/web'] },
  { id: 'remote:build:/x', name: 'x', deployments: ['remote:build:/x'], machines: ['build'], remote: true }];
const source = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
const section = source.slice(source.indexOf('// ---- windows: one per workspace (#481)'), source.indexOf('function createWindow(workspaceId'));
const windowBlock = source.match(/function createWindow\(workspaceId, record = null\)[^]*?\n\}/)[0];
const noteServedBlock = source.match(/function noteServed\(list\) \{[^]*?\n\}/)[0];
const terminalFrameBlock = source.match(/const terminalFrame = \(e\) => \{[^]*?\n\};/)[0];
const tick = () => new Promise((r) => setImmediate(r));

const FakeWindow = fakeWindowClass(RENDERER);
FakeWindow.onClose = (quitting) => { main.quitStarted = quitting; };
let main;

/** Every directory tempDir() made, removed when the file has ended. */
const made = [];
function tempDir() { const dir = mkdtempSync(join(tmpdir(), 'oats-win-')); made.push(dir); return dir; }
test.after(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function boot({ records = [], served = SERVED, reread = null, dirs = ['/d/oats', '/d/web'], displays = [{ workArea: { x: 0, y: 25, width: 1440, height: 875 } }] } = {}) {
  FakeWindow.all = [];
  const handlers = new Map(), file = join(tempDir(), 'windows.json');
  const context = {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, app: { getPath: () => '/memory' }, join, HERE: '/memory',
    BrowserWindow: Object.assign(FakeWindow, { fromWebContents: (wc) => FakeWindow.all.find((w) => w.webContents === wc) }),
    screen: { getAllDisplays: () => displays }, RENDERER_URL: RENDERER, servedList: served, allowedWs: new Set(served.map((w) => w.id)),
    advertisedBefore: new Set(), quitStarted: false, console, Menu: {}, shell: {},
    // The take-over's wait (RELEASE_WAIT_MS), on fake timers: a test fires them (fire()).
    setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { if (timer) timer.cleared = true; },
    createWindowSet, restorePlan, resolveView, clampBounds, windowTitle, trustedForgeFrame, validWorkspaceId, workspaceHash, trustedRendererUrl, frameWorkspace, validLayout,
    omarchyArguments: Object.freeze(["--oats-host-omarchy"]), // main's start-time answer (omarchy-host.test.mjs), as on Omarchy
    terminalBroker: { register() {} }, suggestionCalls: { forget() {} }, lastPickChoices: new Map(), workspaceDirs: dirs,
    // main's post of the window set to the backend (#1124), recorded: the views the windows show at each call.
    noteWindowViews: () => noted.push(main.windows.entries().map(([, key]) => key)),
  };
  const noted = [], timers = [];
  context.advertisedNow = () => context.allowedWs;
  // The server's answer to main's re-read of /api/panel: `reread`, else what it served before.
  context.panelWorkspaces = async () => { context.rereads = (context.rereads ?? 0) + 1; if (reread) { context.servedList = reread; context.allowedWs = new Set(reread.map((w) => w.id)); } return context.servedList; };
  main = runInNewContext(`${section}\n${windowBlock}\n${noteServedBlock}\n${terminalFrameBlock}\n({ noteServed, terminalFrame, windows, choosers, openWorkspaceWindow, openNewWindow, restoreWindows, RELEASE_WAIT_MS, releases, holdsHash, setRecords: (r) => { windowRecords = r; }, setAdvertised: (set) => { allowedWs = set; }, setServed: (list) => { servedList = list; }, get windowRecords() { return windowRecords; } })`, context);
  Object.defineProperty(main, 'quitStarted', { set: (v) => { context.quitStarted = v; } });
  main.setRecords(createWindowRecords({ file, initial: records, timers: { setTimeout: () => 1, clearTimeout() {} } }));
  const event = (win) => ({ sender: Object.assign(win.webContents, { isDestroyed: () => false }), senderFrame: win.webContents.mainFrame });
  // Replies built in the vm are compared by value (their prototypes are the vm's).
  const plain = (value) => JSON.parse(JSON.stringify(value));
  return { main, handlers, event, file, claim: async (win, id, options) => plain(await handlers.get('window:claim-workspace')(event(win), id, options)),
    open: async (win, id) => plain(await handlers.get('window:open-workspace')(event(win), id)),
    choices: async (win, e = event(win)) => plain(await handlers.get('window:choices')(e)), rereads: () => context.rereads ?? 0, noted,
    answer: async (win, request, payload = null, e = event(win)) => plain(await handlers.get('window:release-answer')(e, request, payload)),
    timers, fire: () => { for (const timer of timers.splice(0)) if (!timer.cleared) timer.fn(); } };
}
const record = (workspace, x = 50) => ({ workspace, bounds: { x, y: 60, width: 900, height: 700 }, maximized: false });

test('restore with two workspaces: a window each, bound by its hash, titled from the served list, with its bounds', () => {
  const b = boot({ records: [record(A), record(B, 300)] });
  b.main.restoreWindows();
  assert.equal(FakeWindow.all.length, 2);
  assert.deepEqual(FakeWindow.all.map((w) => [w.loaded.hash, w.title, w.options.x]), [[workspaceHash(A).slice(1), 'oats', 50], [workspaceHash(B).slice(1), 'web', 300]]);
  // Each window's preload hears main's Omarchy answer (oatsDesktop.isOmarchy), in an array of its own.
  for (const w of FakeWindow.all) assert.deepEqual([...w.options.webPreferences.additionalArguments], ['--oats-host-omarchy']);
  assert.notEqual(FakeWindow.all[0].options.webPreferences.additionalArguments, FakeWindow.all[1].options.webPreferences.additionalArguments);
});

test('restore with one workspace missing: no window for it, and windows.json still lists it', () => {
  const b = boot({ records: [record('/d/gone'), record(B)] });
  b.main.restoreWindows();
  assert.deepEqual(FakeWindow.all.map((w) => w.title), ['web']);
  assert.deepEqual(b.main.windowRecords.records().map((r) => r.workspace), ['/d/gone', B]);
});

test('restore with bounds off-screen: clamped onto a visible display', () => {
  const b = boot({ records: [{ ...record(A), bounds: { x: 4000, y: 3000, width: 900, height: 700 } }] });
  b.main.restoreWindows();
  const { x, y, width, height } = FakeWindow.all[0].options;
  assert.deepEqual({ x, y, width, height }, { x: 270, y: 112, width: 900, height: 700 });
});

test('with nothing to restore (the first launch after the update), one window that takes the shared default', () => {
  const b = boot();
  b.main.restoreWindows();
  assert.equal(FakeWindow.all.length, 1);
  assert.deepEqual({ ...FakeWindow.all[0].loaded }, {}, 'no hash: the renderer takes the localStorage selection when main lets it');
  assert.equal(FakeWindow.all[0].title, 'OATS Desktop');
});

test('a Finder launch serving no local deployment opens one unbound window that chooses, never one on / (#518)', async () => {
  for (const served of [[], SERVED.filter((w) => w.remote)]) {
    // (a) nothing saved, (b) a saved set of non-deployments, (c) a windows.json record bound to '/': none is served.
    const b = boot({ records: [{ ...record('/'), deployments: ['/'] }], served, dirs: [] });
    b.main.restoreWindows();
    assert.equal(FakeWindow.all.length, 1);
    const win = FakeWindow.all[0];
    assert.deepEqual({ ...win.loaded }, {}, 'no #ws=: bound to nothing');
    assert.equal(win.title, 'OATS Desktop');
    for (const id of ['', '/']) {
      const refused = await b.claim(win, id, { focus: false, initial: true });
      assert.equal(refused.code, 'choose', 'the shared default (even a stale "/") is never taken: the switcher opens');
      assert.deepEqual(refused.workspaces, served);
    }
    assert.equal(b.main.windows.keyOf(win), null);
    assert.deepEqual(b.main.windowRecords.records().map((r) => r.workspace), ['/'], 'restore binds nothing to "/" (startup cleans the stale record: forgetNonDeployments)');
  }
});

test('the launch\'s own deployment gets its window beside the restored ones, or focuses the one it has', () => {
  const b = boot({ records: [record(A)] });
  b.main.restoreWindows(B);
  assert.deepEqual(FakeWindow.all.map((w) => w.title), ['oats', 'web']);
  const again = boot({ records: [record(A)] });
  again.main.restoreWindows(A);
  assert.equal(FakeWindow.all.length, 1); assert.deepEqual(FakeWindow.all[0].calls, ['show', 'focus']);
});

test('open: a workspace\'s window is focused when it has one, and no duplicate is created', async () => {
  const b = boot();
  const first = FakeWindow.all[0] ?? b.main.openNewWindow();
  assert.deepEqual(await b.open(first, A), { ok: true, opened: true });
  const created = FakeWindow.all.length;
  assert.deepEqual(await b.open(first, A), { ok: true, focused: true });
  assert.equal(FakeWindow.all.length, created, 'refuses a duplicate');
  assert.deepEqual(FakeWindow.all.at(-1).calls, ['show', 'focus']);
  assert.deepEqual(await b.open(first, 'a\nb'), { ok: false, code: 'bad-workspace' });
});

test('an in-place switch rebinds the window: its title and its record follow', async () => {
  const b = boot({ records: [record(A)] });
  b.main.restoreWindows();
  const win = FakeWindow.all[0];
  assert.deepEqual(await b.claim(win, B), { ok: true, workspace: B });
  assert.equal(win.title, 'web', 'the title follows the switch');
  assert.equal(b.main.windows.windowOf(B), win); assert.equal(b.main.windows.windowOf(A), null);
  assert.deepEqual(b.main.windowRecords.records().map((r) => r.workspace), [B], 'the window\'s record follows it');
  assert.deepEqual(await b.claim(win, 'remote:build:/x'), { ok: true, workspace: 'remote:build:/x' });
  assert.equal(win.title, 'x — build', 'a remote workspace is titled with its server');
});

test('a claim for a workspace another window has focuses that window and refuses with the choices', async () => {
  const b = boot({ records: [record(A), record(B)] });
  b.main.restoreWindows();
  const [a, other] = FakeWindow.all;
  const refused = await b.claim(a, B);
  assert.equal(refused.ok, false); assert.equal(refused.code, 'focused-other'); assert.equal(refused.workspaces.length, SERVED.length);
  assert.deepEqual(other.calls, ['show', 'focus']); assert.equal(a.title, 'oats', 'this window does not change');
  const quiet = await b.claim(a, B, { focus: false });
  assert.equal(quiet.code, 'open-elsewhere'); assert.deepEqual(other.calls, ['show', 'focus'], 'not focused again');
});

test('a New Window chooses: its first claim of the shared default is refused; its choice then binds it', async () => {
  const b = boot();
  const win = b.main.openNewWindow();
  const refused = await b.claim(win, A, { focus: false, initial: true });
  assert.equal(refused.code, 'choose'); assert.equal(refused.workspaces.length, SERVED.length);
  assert.deepEqual(await b.claim(win, A), { ok: true, workspace: A });
  assert.equal(win.title, 'oats');
});

test('a window that leaves its workspace (claim null) keeps its record, untitled', async () => {
  const b = boot({ records: [record(A)] });
  b.main.restoreWindows();
  const win = FakeWindow.all[0];
  assert.deepEqual(await b.claim(win, null), { ok: true });
  assert.equal(win.title, 'OATS Desktop'); assert.equal(b.main.windows.windowOf(A), null);
  win.close();
  assert.deepEqual(b.main.windowRecords.records().map((r) => r.workspace), [A], 'not the window\'s any more: kept');
});

test('the window set follows the windows (#1124): opening, rebinding and closing a window each tell main to post the views shown', async () => {
  const b = boot({ records: [record(A)] });
  b.main.restoreWindows();
  const win = FakeWindow.all[0];
  assert.deepEqual(b.noted.at(-1), [A], 'restored');
  let calls = b.noted.length;
  assert.deepEqual(await b.claim(win, B), { ok: true, workspace: B });
  assert.ok(b.noted.length > calls); assert.deepEqual(b.noted.at(-1), [B], 'rebound in place');
  calls = b.noted.length;
  assert.deepEqual(await b.open(win, A), { ok: true, opened: true });
  assert.ok(b.noted.length > calls); assert.deepEqual([...b.noted.at(-1)].sort(), [A, B].sort(), 'opened');
  calls = b.noted.length;
  win.close();
  assert.ok(b.noted.length > calls); assert.deepEqual(b.noted.at(-1), [A], 'closed');
});

test('closing removes a window from the registry; its record goes only if its workspace is served and the app is not quitting', () => {
  const b = boot({ records: [record(A), record(B)] });
  b.main.restoreWindows();
  const [a, other] = FakeWindow.all;
  a.close();
  assert.equal(b.main.windows.windowOf(A), null);
  assert.deepEqual(b.main.windowRecords.records().map((r) => r.workspace), [B]);
  other.close({ quitting: true });
  assert.deepEqual(b.main.windowRecords.records().map((r) => r.workspace), [B], 'quitting forgets nothing');
});

test('a closed window whose workspace is not served keeps its record', () => {
  const b = boot({ records: [record(A)] });
  b.main.restoreWindows();
  b.main.setAdvertised(new Set([B])); // the server stopped serving A
  FakeWindow.all[0].close();
  assert.deepEqual(b.main.windowRecords.records().map((r) => r.workspace), [A]);
});

test('titles are main\'s: the page cannot retitle a window', () => {
  boot().main.restoreWindows();
  let prevented = false;
  FakeWindow.all[0].emit('page-title-updated', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
});

test('the shared default is taken only while the server advertises it: otherwise not-served, and the window adopts as before', async () => {
  const b = boot();
  b.main.restoreWindows();
  const win = FakeWindow.all[0];
  const refused = await b.claim(win, 'ws:gonegonegonegonegone', { focus: false, initial: true });
  assert.equal(refused.code, 'not-served');
  assert.equal(b.main.windows.keyOf(win), null, 'still no workspace: it reads with the verified one and adopts');
  assert.deepEqual(await b.claim(win, A, { focus: false, initial: true }), { ok: true, workspace: A });
});

test('a relaunch before observation restores the window through its deployments; it follows to its ws: view once observed', async () => {
  // Before the server has read alpha's identity, alpha is served under its own deployment id.
  const unobserved = [{ id: '/d/oats', name: 'oats', deployments: ['/d/oats'], unattached: true }, SERVED[1]];
  const b = boot({ records: [{ ...record(A), deployments: ['/d/oats'] }], served: unobserved });
  b.main.restoreWindows();
  assert.equal(FakeWindow.all.length, 1, 'restored, not lost');
  const win = FakeWindow.all[0];
  assert.equal(win.loaded.hash, workspaceHash('/d/oats').slice(1)); assert.equal(win.options.x, 50, 'with its bounds');
  // Observed: the view is served under its ws: id; the renderer's rehome claims it without focusing anything.
  b.main.setAdvertised(new Set(SERVED.map((w) => w.id)));
  assert.deepEqual(await b.claim(win, A, { focus: false }), { ok: true, workspace: A });
  assert.deepEqual(b.main.windowRecords.records().map((r) => r.workspace), [A], 'the record follows the window (rewritten, not added)');
  assert.deepEqual(win.calls, [], 'nothing focused');
});

test('a claim or open naming a deployment id is resolved to the view that holds it: an open view keeps its window', async () => {
  const b = boot({ records: [record(A), record(B)] });
  b.main.restoreWindows();
  const [a, other] = FakeWindow.all;
  // Browse… to the folder of a workspace another window has: that window is focused; this one is unchanged.
  const refused = await b.claim(other, '/d/oats');
  assert.equal(refused.code, 'focused-other');
  assert.deepEqual(a.calls, ['show', 'focus']); assert.equal(b.main.windows.keyOf(other), B);
  assert.equal(b.main.windows.windowOf('/d/oats'), null, 'never a second key for the same workspace');
  // Open in new window by deployment id: the view's window.
  assert.deepEqual(await b.open(other, '/d/web'), { ok: true, focused: true });
  assert.equal(FakeWindow.all.length, 2);
});

test('a claim of a deployment id whose view has no window binds the view, and says so', async () => {
  const b = boot();
  const win = b.main.openNewWindow();
  assert.deepEqual(await b.claim(win, '/d/web'), { ok: true, workspace: B });
  assert.equal(b.main.windows.keyOf(win), B); assert.equal(win.title, 'web');
});

test('a window left with no workspace is one main knows has nothing to read', async () => {
  const b = boot({ records: [record(A), record(B)] });
  b.main.restoreWindows();
  const [a, other] = FakeWindow.all;
  await b.claim(a, null);
  assert.equal((await b.claim(a, B, { focus: false, initial: true })).code, 'choose', 'left choosing: never the shared default');
  const fresh = b.main.openNewWindow(); b.main.choosers.delete(fresh); // a window opened with no workspace, adopting
  assert.equal((await b.claim(fresh, B, { focus: false, initial: true })).code, 'open-elsewhere');
  assert.equal((await b.claim(fresh, A, { focus: false, initial: true })).code, 'choose', 'its default open elsewhere: it chooses from then on');
  assert.deepEqual(await b.claim(fresh, '/d/gone'), { ok: true, workspace: '/d/gone' }, 'a choice binds it');
  assert.equal(b.main.choosers.has(fresh), false);
  assert.equal(other.title, 'web');
});

test('a window keyed by a deployment moves to its view in main as soon as the served list names it, so no second window can take it', async () => {
  const unobserved = [{ id: '/d/oats', name: 'oats', deployments: ['/d/oats'], unattached: true }, SERVED[1]];
  const b = boot({ records: [{ ...record(A), deployments: ['/d/oats'] }, record(B)], served: unobserved });
  b.main.restoreWindows();
  const [win, other] = FakeWindow.all;
  assert.equal(b.main.windows.keyOf(win), '/d/oats');
  b.main.noteServed(SERVED); // the identity observed: the served list now names the view ws:aaaa…
  assert.equal(b.main.windows.keyOf(win), A, 'rekeyed in main at once, before the window\'s next read');
  assert.equal(win.title, 'oats', 'titled from its view');
  assert.deepEqual(win.calls, [], 'nothing focused');
  assert.deepEqual(b.main.windowRecords.records().map((r) => r.workspace), [A, B]);
  const refused = await b.claim(other, A);
  assert.equal(refused.code, 'focused-other', 'another window cannot take the workspace in the meantime');
  assert.deepEqual(await b.claim(win, A, { focus: false }), { ok: true, workspace: A }, 'the window\'s own follow is a no-op');
});

test('a window keyed by a deployment whose view another window already has is left to its own follow (it will choose)', () => {
  const unobserved = [{ id: '/d/oats', name: 'oats', deployments: ['/d/oats'], unattached: true }, SERVED[1]];
  const b = boot({ served: unobserved });
  const byPath = b.main.openWorkspaceWindow('/d/oats').win;
  b.main.setServed(SERVED);
  const byView = b.main.openWorkspaceWindow(A).win;
  b.main.noteServed(SERVED);
  assert.equal(b.main.windows.keyOf(byPath), '/d/oats', 'not moved onto the view another window has');
  assert.equal(b.main.windows.keyOf(byView), A);
  assert.deepEqual(byView.calls, [], 'the other window is not focused');
});

test('window:choices: a window main knows gets the served list as re-read now; a foreign frame or unknown window gets nothing (#521)', async () => {
  const later = [...SERVED, { id: 'remote:laptop:/y', name: 'y', deployments: ['remote:laptop:/y'], machines: ['laptop'], remote: true }];
  const b = boot({ served: [], reread: later, dirs: [] });
  b.main.restoreWindows();
  const [win] = FakeWindow.all;
  assert.equal((await b.claim(win, '', { focus: false, initial: true })).code, 'choose');
  assert.deepEqual(await b.choices(win), { ok: true, workspaces: later });
  assert.equal(b.rereads(), 1, 'main re-reads the served list for it');
  assert.equal(b.main.windows.keyOf(win), null, 'asking binds nothing');
  const foreign = { sender: Object.assign(win.webContents, { isDestroyed: () => false }), senderFrame: { url: 'https://evil.example/' } };
  assert.deepEqual(await b.choices(win, foreign), { ok: false, code: 'forbidden' });
  const stranger = new FakeWindow({ width: 10, height: 10 });
  assert.deepEqual(await b.choices(stranger), { ok: false, code: 'unknown-window' });
  assert.equal(b.rereads(), 1, 'a refusal reads nothing');
});

/* ── the take-over (a pick from the list of workspaces) ── */

/** Two restored windows, on A and on B (the holder), each recording what main sends it. */
function twoWindows() {
  const b = boot({ records: [record(A), record(B, 300)] });
  b.main.restoreWindows();
  const [asker, holder] = FakeWindow.all;
  for (const win of FakeWindow.all) { win.sent = []; win.webContents.send = (channel, message) => win.sent.push([channel, JSON.parse(JSON.stringify(message))]); }
  return { b, asker, holder };
}
/** A claim's promise, and whether it has settled yet. */
function watched(promise) {
  const w = { settled: false, promise: promise.then((value) => { w.settled = true; return value; }) };
  return w;
}

test('a take-over of a workspace another window holds asks that window only to release it, and focuses nothing', async () => {
  const { b, asker, holder } = twoWindows();
  const claim = watched(b.claim(asker, B, { takeOver: true }));
  await tick();
  assert.deepEqual(holder.sent, [['window:release-workspace', { request: holder.sent[0]?.[1]?.request, workspace: B, workspaces: SERVED }]]);
  assert.ok(Number.isSafeInteger(holder.sent[0][1].request), 'a request id to answer');
  assert.deepEqual(asker.sent, [], 'only the holder is asked');
  assert.equal(claim.settled, false, 'main waits for the answer');
  assert.equal(b.main.windows.windowOf(B), holder, 'nothing moves before it');
  assert.deepEqual(b.timers.map((t) => t.ms), [b.main.RELEASE_WAIT_MS], 'one wait, of RELEASE_WAIT_MS');
  assert.equal(b.main.RELEASE_WAIT_MS, 2000);
  assert.deepEqual(holder.calls, [], 'the holder is never restored, shown or focused');
  assert.deepEqual(await b.answer(holder, holder.sent[0][1].request), { ok: true });
  assert.deepEqual(await claim.promise, { ok: true, workspace: B });
  assert.deepEqual([holder.calls, asker.calls], [[], []], 'nor is any window afterwards');
});

test('the holder\'s answer moves the binding: the asker has the workspace, its title and its record; the holder has none and chooses', async () => {
  const { b, asker, holder } = twoWindows();
  const claim = b.claim(asker, B, { takeOver: true });
  await tick();
  await b.answer(holder, holder.sent[0][1].request);
  assert.deepEqual(await claim, { ok: true, workspace: B });
  assert.equal(b.main.windows.windowOf(B), asker); assert.equal(b.main.windows.keyOf(holder), null);
  assert.equal(b.main.windows.windowOf(A), null, 'the asker\'s old workspace is free');
  assert.equal(asker.title, 'web'); assert.equal(holder.title, 'OATS Desktop');
  assert.deepEqual(b.main.windowRecords.records().map((r) => [r.workspace, r.bounds.x]), [[B, 50]], 'one record for B, the asker\'s (its bounds), none left for the holder');
  assert.equal(b.main.choosers.has(holder), true, 'the holder has nothing to read until it binds again');
  assert.equal(b.main.choosers.has(asker), false);
  assert.equal((await b.claim(holder, A, { focus: false, initial: true })).code, 'choose', 'never the shared default');
  assert.deepEqual(b.noted.at(-1), [B, null], 'the backend is told the views shown: B, and the holder with none');
  assert.equal(b.timers.every((t) => t.cleared), true, 'the wait is cleared');
  b.fire();
  assert.equal(b.main.windows.windowOf(B), asker, 'a cleared wait does nothing');
});

test('a holder that does not answer: the binding moves after RELEASE_WAIT_MS, and its late answer is refused', async () => {
  const { b, asker, holder } = twoWindows();
  const claim = watched(b.claim(asker, B, { takeOver: true }));
  await tick();
  const { request } = holder.sent[0][1];
  assert.equal(claim.settled, false);
  b.fire(); // RELEASE_WAIT_MS passes
  assert.deepEqual(await claim.promise, { ok: true, workspace: B });
  assert.equal(b.main.windows.windowOf(B), asker); assert.equal(b.main.windows.keyOf(holder), null);
  assert.equal(holder.title, 'OATS Desktop'); assert.equal(b.main.choosers.has(holder), true);
  assert.deepEqual(b.main.windowRecords.records().map((r) => r.workspace), [B]);
  // The holder answers late (it leaves the workspace all the same: views/common.mjs leaveTakenWorkspace).
  assert.deepEqual(await b.answer(holder, request), { ok: false, code: 'unknown-request' });
  assert.equal(b.main.windows.windowOf(B), asker, 'already the asker\'s; nothing changes');
  assert.deepEqual(holder.calls, []);
});

test('a holder main cannot send to is not waited for', async () => {
  const { b, asker, holder } = twoWindows();
  holder.webContents.send = () => { throw new Error('destroyed'); };
  assert.deepEqual(await b.claim(asker, B, { takeOver: true }), { ok: true, workspace: B });
  assert.equal(b.main.windows.keyOf(holder), null);
});

test('the release answer is accepted once, from the window asked, for a request still open, from a trusted frame', async () => {
  const { b, asker, holder } = twoWindows();
  const third = b.main.openNewWindow();
  const claim = watched(b.claim(asker, B, { takeOver: true }));
  await tick();
  const { request } = holder.sent[0][1];
  const foreign = { sender: Object.assign(holder.webContents, { isDestroyed: () => false }), senderFrame: { url: 'https://evil.example/' } };
  const subframe = { sender: holder.webContents, senderFrame: { url: RENDERER } };
  const refusals = [
    [await b.answer(asker, request), 'the asker'],
    [await b.answer(third, request), 'another window'],
    [await b.answer(holder, request + 1), 'an unknown request'],
    [await b.answer(holder, String(request)), 'a request id that is not an integer'],
    [await b.answer(holder, request, null, foreign), 'a foreign frame'],
    [await b.answer(holder, request, null, subframe), 'a frame that is not the main frame'],
  ];
  assert.deepEqual(refusals.map(([r, why]) => [r.code, why]), [['unknown-request', 'the asker'], ['unknown-request', 'another window'],
    ['unknown-request', 'an unknown request'], ['unknown-request', 'a request id that is not an integer'], ['forbidden', 'a foreign frame'], ['forbidden', 'a frame that is not the main frame']]);
  const stranger = new FakeWindow({ width: 10, height: 10 }); // a window main never registered
  assert.deepEqual(await b.answer(stranger, request), { ok: false, code: 'unknown-request' });
  await tick();
  assert.equal(claim.settled, false, 'no refused answer ends the wait');
  assert.equal(b.main.windows.windowOf(B), holder, 'nor moves anything');
  assert.deepEqual(await b.answer(holder, request), { ok: true });
  assert.deepEqual(await b.answer(holder, request), { ok: false, code: 'unknown-request' }, 'a second answer to one request');
  assert.deepEqual(await claim.promise, { ok: true, workspace: B });
});

test('two take-overs of one workspace: the first answered wins; the other is refused, open elsewhere, with the choices', async () => {
  const { b, asker, holder } = twoWindows();
  const other = b.main.openNewWindow();
  assert.deepEqual(await b.claim(other, 'remote:build:/x'), { ok: true, workspace: 'remote:build:/x' });
  const first = b.claim(asker, B, { takeOver: true }), second = b.claim(other, B, { takeOver: true });
  await tick();
  const [askerRequest, otherRequest] = holder.sent.map(([, m]) => m.request);
  assert.notEqual(askerRequest, otherRequest, 'each take-over its own request');
  await b.answer(holder, otherRequest);
  assert.deepEqual(await second, { ok: true, workspace: B });
  await b.answer(holder, askerRequest);
  const refused = await first;
  assert.deepEqual([refused.ok, refused.code, refused.workspaces], [false, 'open-elsewhere', SERVED]);
  assert.equal(b.main.windows.windowOf(B), other); assert.equal(b.main.windows.keyOf(asker), A, 'the refused asker is unchanged');
  assert.deepEqual([asker.calls, holder.calls, other.calls], [[], [], []], 'nothing is focused');
});

test('a take-over of a workspace no other window holds binds at once, with no release event', async () => {
  const b = boot({ records: [record(A)] });
  b.main.restoreWindows();
  const [win] = FakeWindow.all;
  win.webContents.send = () => assert.fail('nobody to ask');
  assert.deepEqual(await b.claim(win, B, { takeOver: true }), { ok: true, workspace: B });
  assert.deepEqual(await b.claim(win, B, { takeOver: true }), { ok: true, workspace: B }, 'its own workspace');
  assert.deepEqual(b.timers, [], 'no wait');
  assert.equal(win.title, 'web'); assert.deepEqual(b.main.windowRecords.records().map((r) => r.workspace), [B]);
  const chooser = b.main.openNewWindow();
  assert.deepEqual(await b.claim(chooser, A, { takeOver: true }), { ok: true, workspace: A }, 'a choosing window binds by one too');
  assert.equal(b.main.choosers.has(chooser), false);
});

test('an initial claim never takes over: it is refused as before, and the holder is not asked', async () => {
  const { b, holder } = twoWindows();
  const fresh = b.main.openNewWindow(); b.main.choosers.delete(fresh); // a window opened with no workspace, adopting
  fresh.webContents.send = () => {};
  assert.equal((await b.claim(fresh, B, { focus: false, initial: true, takeOver: true })).code, 'open-elsewhere');
  assert.deepEqual(holder.sent, []); assert.equal(b.main.windows.windowOf(B), holder);
  assert.equal((await b.claim(fresh, A, { focus: false, initial: true, takeOver: true })).code, 'choose', 'from then on it chooses');
  assert.deepEqual(holder.sent, []); assert.deepEqual(b.timers, []);
});

/* ── the layout a take-over hands over (renderer/layout-handover.mjs) ── */

const LAYOUT = { terminals: [{ instance: 'dev', home: '/h/dev', agentsRoot: '/h' }, { instance: 'qa', server: 'build' }],
  split: { orientation: 'row', focused: 1, groups: [{ tabs: [0], active: 0 }, { tabs: [1], active: 1, weight: 2 }] }, active: 1 };

test('a holder\'s answer with a valid layout: it reaches the asker\'s claim answer as `layout`', async () => {
  const { b, asker, holder } = twoWindows();
  const claim = b.claim(asker, B, { takeOver: true });
  await tick();
  assert.deepEqual(await b.answer(holder, holder.sent[0][1].request, { layout: LAYOUT }), { ok: true });
  assert.deepEqual(await claim, { ok: true, workspace: B, layout: LAYOUT });
  assert.equal(b.main.windows.windowOf(B), asker);
});

test('an answer that is not exactly { layout } with a valid descriptor is refused whole: the take-over happens without it', async () => {
  const invalid = [
    ['a bad shape', { layout: { ...LAYOUT, terminals: [] } }],
    ['an unknown key in the descriptor', { layout: { ...LAYOUT, tabs: [] } }],
    ['a split index out of range', { layout: { ...LAYOUT, split: { ...LAYOUT.split, groups: [{ tabs: [0], active: 0 }, { tabs: [5], active: null }] } } }],
    ['an extra key in the answer', { layout: LAYOUT, extra: 1 }],
    ['a layout that is not an object', { layout: 'dev' }],
    ['an answer that is not an object', 'layout'],
    ['an array', [LAYOUT]],
    ['the bare descriptor', LAYOUT],
  ];
  for (const [why, payload] of invalid) {
    const { b, asker, holder } = twoWindows();
    const claim = b.claim(asker, B, { takeOver: true });
    await tick();
    assert.deepEqual(await b.answer(holder, holder.sent[0][1].request, payload), { ok: true }, why);
    assert.deepEqual(await claim, { ok: true, workspace: B }, `${why}: no layout`);
    assert.equal(b.main.windows.windowOf(B), asker, `${why}: the binding moves all the same`);
    assert.equal(b.main.windows.keyOf(holder), null);
  }
});

/* ── #1488: a holder whose page loaded or reloaded while it was asked (the ask never reached that page) ── */

test('a window just opened on X, taken over while its page loads: its start claim settles the ask, and it chooses', async () => {
  const { b, asker } = twoWindows();
  const X = 'remote:build:/x';
  const fresh = b.main.openWorkspaceWindow(X).win; // "Open in new window": main binds it, its page then loads
  fresh.sent = []; fresh.webContents.send = (channel, message) => fresh.sent.push([channel, JSON.parse(JSON.stringify(message))]);
  const claim = watched(b.claim(asker, X, { takeOver: true }));
  await tick();
  assert.equal(fresh.sent.length, 1, 'asked to release X');
  assert.equal(claim.settled, false);
  // Its page comes up from #ws=X and confirms its binding (views/common.mjs startWindow).
  assert.deepEqual(await b.claim(fresh, X, { focus: false }), { ok: false, code: 'open-elsewhere', workspaces: SERVED });
  assert.deepEqual(await claim.promise, { ok: true, workspace: X }, 'the take-over lands at once, with no layout');
  assert.equal(b.main.windows.windowOf(X), asker); assert.equal(b.main.windows.keyOf(fresh), null);
  assert.equal(b.main.choosers.has(fresh), true); assert.equal(b.main.releases.size, 0);
  assert.equal(b.main.holdsHash(fresh, X), false, 'its hash no longer reads X');
  assert.deepEqual(fresh.calls, []);
});

test('a holder reloaded during the wait: its start claim settles the ask, and it chooses; its old page\'s answer is refused', async () => {
  const { b, asker, holder } = twoWindows();
  const claim = watched(b.claim(asker, B, { takeOver: true }));
  await tick();
  const { request } = holder.sent[0][1];
  assert.deepEqual(await b.claim(holder, B, { focus: false }), { ok: false, code: 'open-elsewhere', workspaces: SERVED });
  assert.deepEqual(await claim.promise, { ok: true, workspace: B });
  assert.equal(b.main.windows.windowOf(B), asker); assert.equal(b.main.windows.keyOf(holder), null);
  assert.deepEqual(await b.answer(holder, request), { ok: false, code: 'unknown-request' });
  assert.equal(b.timers.every((t) => t.cleared), true, 'the wait is cleared');
  // A reload after the take-over has landed: the claim is refused as any held workspace's is.
  assert.deepEqual(await b.claim(holder, B, { focus: false }), { ok: false, code: 'open-elsewhere', workspaces: SERVED });
});

test('only the holder\'s claim of the workspace asked settles the ask: another workspace, another window or a take-over does not', async () => {
  const { b, asker, holder } = twoWindows();
  const third = b.main.openWorkspaceWindow('remote:build:/x').win;
  const claim = watched(b.claim(asker, B, { takeOver: true }));
  await tick();
  assert.equal((await b.claim(third, B, { focus: false })).code, 'open-elsewhere', 'a third window is refused as before');
  assert.equal(b.main.releases.size, 1); assert.equal(claim.settled, false);
  assert.deepEqual(await b.answer(holder, holder.sent[0][1].request), { ok: true });
  assert.deepEqual(await claim.promise, { ok: true, workspace: B });
});

test('the holder closes during the wait: the asker binds after it, and nothing is left waiting', async () => {
  const { b, asker, holder } = twoWindows();
  const claim = watched(b.claim(asker, B, { takeOver: true }));
  await tick();
  holder.close();
  assert.equal(claim.settled, false, 'the wait runs its course');
  b.fire();
  assert.deepEqual(await claim.promise, { ok: true, workspace: B });
  assert.equal(b.main.windows.windowOf(B), asker); assert.equal(b.main.releases.size, 0);
  assert.deepEqual(b.main.windowRecords.records().map((r) => r.workspace), [B]);
});

test('the asker closes during the wait: the holder leaves as asked, and the workspace ends in no window', async () => {
  const { b, asker, holder } = twoWindows();
  const claim = b.claim(asker, B, { takeOver: true });
  await tick();
  asker.close();
  await b.answer(holder, holder.sent[0][1].request);
  assert.deepEqual(await claim, { ok: false, code: 'unknown-window', workspaces: SERVED });
  assert.deepEqual(await b.claim(holder, null), { ok: true }, 'its leave (views/common.mjs leaveTakenWorkspace): nothing else to show');
  assert.equal(b.main.windows.windowOf(B), null); assert.equal(b.main.releases.size, 0);
});

/** The shipped renderer start (views/common.mjs, fresh) of `win`'s page, its hash `#ws=<id>`, claiming through main. */
let pages = 0;
const PAGE_GLOBALS = ['location', 'localStorage', 'history', 'oatsDesktop'];
test.after(() => { for (const name of PAGE_GLOBALS) delete globalThis[name]; });
async function pageOf(b, win, id) {
  globalThis.location = { hash: workspaceHash(id), pathname: '/app/renderer/index.html', search: '' };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.history = { state: null, replaceState: (_state, _title, url) => { globalThis.location.hash = url.startsWith('#') ? url : ''; } };
  globalThis.oatsDesktop = { windowClaimWorkspace: (claimed, options) => b.claim(win, claimed, options) };
  return import(`../renderer/views/common.mjs?page=${++pages}`); // its bridge is read at each claim: the globals stay
}

test('the shipped start of a page taken over while it loaded: it chooses, and main binds it to nothing', async () => {
  const { b, asker, holder } = twoWindows();
  const claim = b.claim(asker, B, { takeOver: true });
  await tick();
  const page = await pageOf(b, holder, B);
  assert.equal(await page.startWindow(), 'choosing');
  assert.deepEqual(await claim, { ok: true, workspace: B });
  assert.equal(b.main.windows.windowOf(B), asker); assert.equal(b.main.windows.keyOf(holder), null);
  assert.equal(b.main.choosers.has(holder), true);
});

test('the asker closes during the wait, then the holder\'s page starts: it chooses, and the workspace is in no window', async () => {
  const { b, asker, holder } = twoWindows();
  const claim = b.claim(asker, B, { takeOver: true });
  await tick();
  asker.close();
  const page = await pageOf(b, holder, B);
  assert.equal(await page.startWindow(), 'choosing');
  assert.equal((await claim).code, 'unknown-window');
  await page.leaveTakenWorkspace(B, SERVED); // the kept ask, handed to the shell: nothing left to leave
  assert.equal(b.main.windows.keyOf(holder), null, 'no workspace main still binds to a window that shows none');
  assert.equal(b.main.choosers.has(holder), true); assert.equal(holder.title, 'OATS Desktop');
  assert.equal(b.main.windows.windowOf(B), null);
  assert.equal(b.main.openWorkspaceWindow(B).opened, true, 'Open in new window opens B, never focuses the chooser');
});

test('holdsHash: a window reads the workspace main binds it to, under its deployment id or its view; nothing else', async () => {
  const { b, asker, holder } = twoWindows();
  assert.equal(b.main.holdsHash(asker, A), true); assert.equal(b.main.holdsHash(asker, '/d/oats'), true, 'the deployment id of its view');
  assert.equal(b.main.holdsHash(asker, B), false); assert.equal(b.main.holdsHash(holder, A), false);
  await b.claim(holder, null);
  assert.equal(b.main.holdsHash(holder, B), false, 'a window bound to nothing reads nothing');
  assert.equal(b.main.holdsHash(null, A), false); assert.equal(b.main.holdsHash(new FakeWindow({}), A), false, 'nor does an unknown window');
});

test('terminal opens (main\'s admitFrame): only from the hash main binds the window to, or a window still adopting', async () => {
  assert.match(source, /createTerminalOwnerBroker\(\{[^}]*admitFrame: terminalFrame,/, 'the broker is given it');
  const { b, asker, holder } = twoWindows();
  const frame = (win, hash = '') => ({ sender: win.webContents, senderFrame: { url: `${RENDERER}${hash}` } });
  assert.equal(b.main.terminalFrame(frame(asker, workspaceHash(A))), true);
  assert.equal(b.main.terminalFrame(frame(asker, workspaceHash('/d/oats'))), true, 'its deployment id, before the page follows to the view');
  assert.equal(b.main.terminalFrame(frame(asker, workspaceHash(B))), false, 'a workspace another window has');
  const claim = b.claim(asker, B, { takeOver: true });
  await tick(); b.fire(); await claim; // the holder never answered: its page still says #ws=B
  assert.equal(b.main.terminalFrame(frame(holder, workspaceHash(B))), false, 'the holder moved away from opens none of it');
  assert.equal(b.main.terminalFrame(frame(holder)), false, 'nor, with no hash, any: it has no workspace (choosers)');
  const fresh = b.main.openNewWindow();
  assert.equal(b.main.terminalFrame(frame(fresh)), false, 'a New Window chooses: it opens none');
  b.main.choosers.delete(fresh); // as a first launch's window, still adopting its first workspace
  assert.equal(b.main.terminalFrame(frame(fresh)), true, 'a window with no hash still adopting opens as before');
  assert.equal(b.main.terminalFrame({ sender: asker.webContents, senderFrame: { url: 'https://evil.example/#ws=x' } }), false);
});

test('a take-over that times out, or of a workspace no other window holds, carries no layout', async () => {
  const { b, asker } = twoWindows();
  const claim = b.claim(asker, B, { takeOver: true });
  await tick();
  b.fire();
  assert.deepEqual(await claim, { ok: true, workspace: B });
  assert.deepEqual(await b.claim(asker, 'remote:build:/x', { takeOver: true }), { ok: true, workspace: 'remote:build:/x' });
});
