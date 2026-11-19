import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { registerAction, setActiveContexts, getBinding, formatChord, setBinding, resetBinding, runAction, handleKeydown, onKeymapChange } from '../renderer/keybindings.mjs';
import { instanceActions, captureInstanceActionMenu, pendingActionReason } from "../renderer/instance-actions.mjs";
import { createLeaderDispatch } from "../renderer/leader-dispatch.mjs";
import { ROSTER_STALE_TITLE } from "../renderer/instance-tree-view.mjs";
import { cliRetire, parseRetireEnvelope } from "../../client/cli-adapter.mjs";
import { HERDR, MARKUP, CONTROL, DETAIL_WITHHELD, shown } from "./helpers/speaker-cases.mjs";
import { pinPlatform } from "./helpers/platform.mjs";

// jsdom has no top-layer API. Model only its open/close events here; native
// light-dismiss and rendering are Chromium's behavior, not this test's claim.
function menuDom() {
  const dom = new JSDOM("<body></body>", { pretendToBeVisual: true });
  for (const [method, newState] of [["showPopover", "open"], ["hidePopover", "closed"]]) {
    dom.window.HTMLElement.prototype[method] = function () {
      const event = new dom.window.Event("beforetoggle");
      Object.defineProperty(event, "newState", { value: newState });
      this.dispatchEvent(event);
      if (newState === "open") this.querySelector("[autofocus]")?.focus();
    };
  }
  return dom;
}
// #1559: the menu is the roster row's context menu. `menuFor` draws it for a row button of its own (the roster's
// `.ctx-inst`), and `attach` places both, as shell.mjs does.
const rows = new WeakMap();
const menuFor = (doc, instance, options = {}) => {
  const row = doc.createElement("button"); row.type = "button"; row.className = "ctx-inst"; row.textContent = instance.instance;
  const menu = instanceActions(doc, instance, { ...options, row }); rows.set(menu, row);
  return menu;
};
const rowOf = (menu) => rows.get(menu);
const attach = (parent, menu) => { parent.append(rowOf(menu), menu); return menu; };
const detach = (menu) => { rowOf(menu).remove(); menu.remove(); };
const isOpen = (menu) => menu.dataset.instanceMenuOpen === "true";
/** The row's `contextmenu`: a right-click (at the pointer) or a key's (Shift+F10, the Menu key: no pointer). True when
 * the page took it (no native menu). */
const contextMenu = (menu, { x = 0, y = 0 } = {}) => {
  const view = rowOf(menu).ownerDocument.defaultView;
  return !rowOf(menu).dispatchEvent(new view.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
};
const choose = async (control, action) => {
  control.querySelector(`[data-action="${action}"]`).click();
  await new Promise((r) => setImmediate(r));
};

test("instance actions keep full identity and open plan dialogs, never dispatch unguarded stop/retire", async () => {
  const dom = menuDom();
  const instance = { instance: "dev-one", home: "/remote/home", server: "host", addressable: true };
  const calls = [], dialogs = [];
  const select = attach(dom.window.document.body, menuFor(dom.window.document, instance, {
    invoke: async (...args) => { calls.push(args); return {}; },
    openLifecycle: (...args) => dialogs.push(args), done: () => {}, report: (m) => assert.fail(m), say: (m) => assert.fail(m),
  }));
  assert.equal(contextMenu(select), true); assert.equal(isOpen(select), true, "the row's context menu opens");
  await choose(select, "retire"); assert.equal(calls.length, 0);
  await choose(select, "inspect"); assert.deepEqual(calls[0], ["inspect", instance]);
  await choose(select, 'stop'); assert.deepEqual(dialogs, [['retire', instance], ['stop', instance]]);
  assert.equal(calls.length, 1);
  detach(select); await choose(select, 'retire'); assert.equal(dialogs.length, 2, 'detached old controls are revoked');
  // A remote row the kernel does not report addressable: no actions, and asking for them says why (a saved route is not enough).
  const said = [];
  const refused = attach(dom.window.document.body, menuFor(dom.window.document, { ...instance, repoName: 'Build box', savedRoute: true, addressable: false, missingRemotely: true }, { say: (line) => said.push(line) }));
  rowOf(refused).focus();
  assert.equal(contextMenu(refused), true, 'no native menu either');
  assert.equal(isOpen(refused), false);
  assert.deepEqual(said, ['dev-one is no longer on Build box. Remove it from this computer with: oats server forget host --instance dev-one']);
  assert.equal(dom.window.document.activeElement, rowOf(refused), 'the focus stays on the row');
  dom.window.close();
});

test('#1131: a row its host no longer lists offers Forget… alone when the host gives openForget; it opens the confirmation and sends nothing', async () => {
  const dom = menuDom(), doc = dom.window.document;
  const gone = { instance: 'dev-one', home: '/remote/home', server: 'host', repoName: 'Build box', savedRoute: true, addressable: false, missingRemotely: true, running: null };
  const calls = [], forgets = [];
  const control = attach(doc.body, menuFor(doc, gone, { invoke: async (...args) => { calls.push(args); return {}; }, openLifecycle: (...args) => calls.push(['lifecycle', ...args]),
    openForget: (...args) => forgets.push(args), report: m => assert.fail(m), say: m => assert.fail(`not held: ${m}`),
    extra: [{ action: 'open-split', actionId: 'instance.openSplit', label: 'Open in split', reason: '' }] }));
  // The row says the remedy itself (shell.mjs: an unavailable row's title and description); its context menu opens, on Forget….
  contextMenu(control);
  assert.equal(isOpen(control), true); assert.equal(doc.activeElement.dataset.action, 'forget');
  assert.deepEqual([...control.querySelectorAll('[role=menuitem]')].map(item => [item.dataset.action, item.textContent]), [['forget', 'Forget…']],
    'Forget alone: none of the caller\'s items, no lifecycle act');
  await choose(control, 'forget');
  assert.deepEqual(forgets, [[gone]]); assert.deepEqual(calls, [], 'the menu sends nothing itself');
  // Reopened and chosen again: the menu hands the row to the confirmation again; the confirmation refuses a second send while busy.
  await choose(control, 'forget'); assert.equal(forgets.length, 2); assert.deepEqual(calls, []);
  // Not offered (strictly missingRemotely === true on a reached server): no Forget, and the menu opens nothing, as before.
  for (const [why, row] of [['false', { ...gone, missingRemotely: false }], ['absent', (({ missingRemotely, ...r }) => r)(gone)], ['null', { ...gone, missingRemotely: null }],
    ['unreached', { ...gone, serverUnreached: true, runtimeError: 'ssh: connect to host timed out' }]]) {
    const said = [];
    const other = attach(doc.body, menuFor(doc, row, { openForget: () => assert.fail(why), invoke: async () => assert.fail(why), say: line => said.push(line) }));
    contextMenu(other);
    assert.equal(isOpen(other), false, why); assert.equal(said.length, 1, why);
    assert.equal(other.querySelector('[data-action="forget"]'), null, why);
  }
  const reachable = menuFor(doc, { ...gone, addressable: true, missingRemotely: false, running: true }, { openForget: () => assert.fail('addressable'), invoke: async () => ({}) });
  assert.equal(reachable.querySelector('[data-action="forget"]'), null, 'an addressable row offers its usual acts, not Forget');
  dom.window.close();
});

test('a Herdr-recorded row shows Start disabled with the kernel reason, offers no Restart, and still retires through the plan', async () => {
  const reason = 'E_HERDR_REMOVED: Herdr is no longer supported by OATS (removed in 0.31.0); tmux is the only session backend.';
  for (const instance of [{ instance: 'h1', home: '/home/h1', running: null, runtimeState: 'unsupported', runtimeError: `${reason} (h1)` },
    { instance: 'h2', home: '/remote/h2', server: 'host', addressable: true, running: true, backend: 'herdr' }]) {
    const dom = menuDom(), doc = dom.window.document, calls = [], dialogs = [];
    const control = menuFor(doc, instance, { invoke: async (...args) => calls.push(args), openLifecycle: (...args) => dialogs.push(args), report: m => assert.fail(m) });
    attach(doc.body, control);
    const start = control.querySelector('[data-action="start"]'), shown = instance.runtimeError || reason;
    assert.equal(start.disabled, true); assert.equal(start.title, shown); assert.equal(start.querySelector('small').textContent, shown);
    assert.equal(control.querySelector('[data-action="restart"]'), null);
    await choose(control, 'start'); assert.deepEqual(calls, []);
    await choose(control, 'retire'); assert.deepEqual(dialogs, [['retire', instance]]);
    dom.window.close();
  }
});

test('the shipped menu handler handles every action the menu can invoke and refuses any other, sending nothing (#627)', async () => {
  // The roster's `invoke` from shell.mjs, run as shipped: only its collaborators are stubbed (the inspect
  // view's dynamic import included). Each handled action records what it opened; no request may be sent.
  const source = readFileSync(new URL('../renderer/shell.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('invoke: async (action, instance) => {'), end = source.indexOf('\n          openLifecycle:', start);
  assert.ok(start > 0 && end > start, 'the roster menu handler is found in shell.mjs');
  const handler = source.slice(start + 'invoke: '.length, end).trim().replace(/,$/, '');
  const opened = [], requests = [];
  const c = { ws: 'A', rosterGeneration: 1, currentWorkspace: () => 'A', workspaceGeneration: () => 1, actionTarget: {}, menuOwner: () => true,
    openTerminalTab: () => opened.push('open-split'), instancePrAction: { open: () => opened.push('open-pr') },
    openInstanceStart: (_, { restart }) => opened.push(restart ? 'restart' : 'start'),
    tabOpenIntents: { begin: () => () => true }, loadView: async () => ({ preselectHome: () => {} }), showStage: async () => opened.push('inspect'),
    api: (...args) => requests.push(args), postJson: (...args) => requests.push(args), instanceApiPath: (...args) => requests.push(args),
    // #1579: Move to background / out of it run through the background menu (instance-background-menu.mjs), its own handler.
    backgroundMenu: { handles: action => action === 'background-on' || action === 'background-off', run: async action => { opened.push(action); } },
    // Pin to top / Unpin run through the pin menu (instance-pin-menu.mjs), its own handler, as the background's do.
    pinMenu: { handles: action => action === 'pin-on' || action === 'pin-off', run: async action => { opened.push(action); } } };
  const invoke = runInNewContext(`(${handler.replace('import("./views/spawn.mjs")', 'loadView("./views/spawn.mjs")')})`, c);
  // Every action a row's menu passes to invoke, in each launch state, with the shell's extra items.
  const invoked = new Set();
  for (const running of [true, false, undefined]) {
    const dom = menuDom(), doc = dom.window.document, instance = { instance: 'dev', home: '/home/dev', running };
    const control = menuFor(doc, instance, { scope: 'A',
      extra: [{ action: 'open-split', label: 'Open in split' }, { action: 'open-pr', label: 'Open pull request…' },
        { action: running ? 'background-on' : 'background-off', label: running ? 'Move to background' : 'Move out of background' },
        { action: running ? 'pin-on' : 'pin-off', label: running ? 'Pin to top' : 'Unpin' }],
      invoke: (action, row) => { invoked.add(action); return invoke(action, row); },
      openLifecycle: () => {}, report: (headline, { detail }) => assert.fail(`${headline} ${detail}`) });
    attach(doc.body, control);
    for (const item of control.querySelectorAll('[data-action]')) await choose(control, item.dataset.action);
    dom.window.close();
  }
  assert.deepEqual([...invoked].sort(), ['background-off', 'background-on', 'inspect', 'open-pr', 'open-split', 'pin-off', 'pin-on', 'restart', 'start']);
  assert.deepEqual([...new Set(opened)].sort(), [...invoked].sort(), 'each invoked action reached its own handler');
  // Anything else is refused: no path is built from the action's name.
  for (const action of ['harvest', 'chat', 'retire', 'stop', '../panel']) {
    await assert.rejects(invoke(action, { instance: 'dev', home: '/home/dev' }), { message: `Unknown instance action "${action}"` }, action);
  }
  assert.deepEqual(requests, []);
});

test('frame10 extra actions dispatch registered IDs, refresh reasons/hints on open, and skip disabled entries', async () => {
  const dom = menuDom(), doc = dom.window.document; let available = false, hint = 'first', active;
  const calls = [], dispatched = [];
  const control = menuFor(doc, { instance: 'dev', home: '/home/dev' }, { scope: 'A', invoke: async action => calls.push(action),
    extra: [{ action: 'open-split', actionId: 'instance.openSplit', label: 'Open in split', reason: () => available ? '' : 'Select a destination.' }],
    shortcut: () => hint, onMenuState: value => { active = value; }, dispatch: id => { dispatched.push(id); return active?.run('open-split'); } });
  attach(doc.body, control); const item = control.querySelector('[data-action="open-split"]');
  assert.equal(item.disabled, true); contextMenu(control); assert.equal(doc.activeElement.dataset.action, 'inspect');
  control.hidePopover(); available = true; hint = 'rebound'; contextMenu(control); assert.equal(item.disabled, false); assert.equal(item.querySelector('kbd').textContent, 'rebound');
  item.click(); await new Promise(setImmediate); assert.deepEqual(dispatched, ['instance.openSplit']); assert.deepEqual(calls, ['open-split']); assert.equal(active, null); dom.window.close();
});
for (const reject of [false, true]) test(`frame10 owner revokes menu late ${reject ? 'rejection' : 'success'} and old completion cannot unlock another workspace`, async () => {
  const dom = menuDom(), doc = dom.window.document; let current = true, finish, fail; const effects = [];
  const options = { scope: 'A', owner: () => current, invoke: () => new Promise((a,b) => { finish = a; fail = b; }), done: () => effects.push('done'), report: () => effects.push('error') };
  const row = { instance: 'dev', home: '/home/dev', createdAt: 'birth' }, first = menuFor(doc, row, options); attach(doc.body, first);
  first.querySelector('[data-action=inspect]').click(); current = false;
  const next = menuFor(doc, row, { ...options, scope: 'B', owner: () => true }); attach(doc.body, next);
  const opens = (menu) => { contextMenu(menu); const open = isOpen(menu); if (open) menu.hidePopover(); return open; };
  assert.equal(pendingActionReason('A', row), 'Waiting for Knowledge & capabilities to finish');
  assert.equal(pendingActionReason('B', row), null); assert.equal(opens(next), true, 'pending key includes workspace');
  assert.equal(opens(first), false, 'a revoked owner opens nothing');
  if (reject) fail(Error('PRIVATE')); else finish({}); await new Promise(setImmediate);
  assert.deepEqual(effects, []); assert.equal(opens(first), false); assert.equal(opens(next), true);
  dom.window.close();
});
test('shipped frame10 action registration is menu-focus scoped, mouse/key equivalent and live rebind-aware without default Ctrl chords', async () => {
  const dom = menuDom(), doc = dom.window.document, source = readFileSync(new URL('../renderer/shell.mjs', import.meta.url), 'utf8'), off = [], calls = [];
  const c = { document: doc, activeInstanceMenu: null, tabLayerVisible: false, stage: null, setActiveContexts, getBinding, formatChord,
    baseTitles: new WeakMap(), isMac: true, registerAction: spec => off.push(registerAction(spec)) };
  const functions = ['updateActiveContexts', 'menuState', 'applyChordTitles'].map(name => source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0]).join('\n');
  const start = source.indexOf('for (const [id, action, label] of'), end = source.indexOf('registerAction({ id: "app.palette"', start);
  const s = runInNewContext(`${functions}\n${source.slice(start, end)}\n({ menuState, updateActiveContexts, applyChordTitles })`, c);
  const offKeys = onKeymapChange(s.applyChordTitles);
  try {
    assert.equal(getBinding('instance.openSplit'), null); assert.equal(getBinding('instance.openPullRequest'), null);
    setBinding('instance.openSplit', 'Mod+Shift+S');
    const outside = doc.createElement('input'); doc.body.append(outside);
    const control = menuFor(doc, { instance: 'dev', home: '/dev' }, { scope: 'A', owner: () => true,
      extra: [{ action: 'open-split', actionId: 'instance.openSplit', label: 'Open in split' }],
      shortcut: id => getBinding(id) ? formatChord(getBinding(id), true) : '', dispatch: runAction,
      onMenuState: s.menuState, onFocusChange: s.updateActiveContexts, invoke: async action => calls.push(action) });
    attach(doc.body, control); contextMenu(control);
    const event = new dom.window.KeyboardEvent('keydown', { key: 'S', metaKey: true, shiftKey: true, cancelable: true });
    assert.equal(handleKeydown(event, { isMac: true }), true); await new Promise(setImmediate); assert.deepEqual(calls, ['open-split']);
    contextMenu(control); setBinding('instance.openSplit', 'Mod+Shift+O');
    assert.equal(control.querySelector('kbd').textContent, formatChord('Mod+Shift+O', true));
    control.querySelector('[data-action=open-split]').click(); await new Promise(setImmediate); assert.deepEqual(calls, ['open-split', 'open-split']);
    contextMenu(control); outside.focus(); runAction('instance.openSplit'); await new Promise(setImmediate);
    assert.equal(calls.length, 2); assert.equal(runAction('instance.openSplit'), false);
    resetBinding('instance.openSplit'); assert.equal(getBinding('instance.openSplit'), null);
  } finally { offKeys(); resetBinding('instance.openSplit'); resetBinding('instance.openPullRequest'); for (const dispose of off) dispose(); setActiveContexts(new Set()); dom.window.close(); }
});
test('frame10 hidden or removed controls cannot execute or restore focus', async () => {
  const dom = menuDom(), doc = dom.window.document, wrap = doc.createElement('div'); doc.body.append(wrap);
  let calls = 0; const control = menuFor(doc, { instance: 'dev', home: '/home/dev' }, { invoke: async () => { calls++; } }); attach(wrap, control);
  wrap.hidden = true; await choose(control, 'inspect'); assert.equal(calls, 0); wrap.hidden = false; detach(control); await choose(control, 'inspect'); assert.equal(calls, 0); dom.window.close();
});

test("retire adapter preserves incomplete local results and routes remote by saved identity", async () => {
  assert.equal(parseRetireEnvelope('{"retired":"dev-one","removedDir":true}').ok, true);
  const partial = parseRetireEnvelope('{"retired":"dev-one","removedDir":false,"rollbackIncomplete":["cleanup"]}');
  assert.equal(partial.ok, false); assert.equal(partial.error.code, "E_RETIRE_INCOMPLETE");
  assert.equal(parseRetireEnvelope(JSON.stringify({ schemaVersion: 1, ok: true, result: partial.result })).ok, false);
  let call;
  const env = await cliRetire("/installed/oats", { instance: "dev-one", home: "/remote/selected", workspaceDir: "/local", server: "host" }, {
    exec: (bin, argv, opts, cb) => { call = { bin, argv, opts }; cb(null, '{"schemaVersion":1,"ok":true,"result":{"retired":"dev-one"}}'); },
  });
  assert.equal(env.ok, true);
  assert.deepEqual(call.argv, ["retire", "dev-one", "--home", "/remote/selected", "--server", "host", "--json"]);
  assert.equal(call.opts.cwd, "/local");
});

test("roster rebuilds cannot submit a second lifecycle action while one is pending", async () => {
  const dom = menuDom();
  let finish; let calls = 0;
  const instance = { instance: "dev-pending", home: "/home/dev-pending" };
  const said = [];
  const options = { invoke: () => { calls++; return new Promise((r) => { finish = r; }); },
    openLifecycle: assert.fail, done() {}, report: assert.fail, say: (line) => said.push(line) };
  const first = menuFor(dom.window.document, instance, options);
  attach(dom.window.document.body, first);
  first.querySelector('[data-action="inspect"]').click();
  const replacement = attach(dom.window.document.body, menuFor(dom.window.document, instance, options));
  contextMenu(replacement);
  assert.equal(isOpen(replacement), false); assert.deepEqual(said, ["Waiting for Knowledge & capabilities to finish"]);
  replacement.querySelector('[data-action="retire"]').click();
  assert.equal(calls, 1);
  finish({}); await new Promise((r) => setImmediate(r));
  contextMenu(replacement);
  assert.equal(isOpen(replacement), true, "the currently displayed menu opens again without another poll"); replacement.hidePopover();
  const fresh = attach(dom.window.document.body, menuFor(dom.window.document, instance, options));
  contextMenu(fresh); assert.equal(isOpen(fresh), true); assert.equal(said.length, 1);
  dom.window.close();
});

// A held menu (an act of it in flight, a stale roster) opens nothing from any of its inputs and says why; the row
// keeps its own marking (shell.mjs), the menu adds none, and the focus stays on the row.
test("a pending act holds its row's context menu, says why it waits, keeps focus on the row, and ends only its own hold", async () => {
  const dom = menuDom(), doc = dom.window.document; dom.window.alert = () => assert.fail("no alert");
  let finish; let calls = 0;
  const instance = { instance: "dev-wait", home: "/home/dev-wait" };
  const said = [];
  const options = { invoke: () => { calls++; return new Promise((r) => { finish = r; }); }, openLifecycle: assert.fail, done() {}, report: assert.fail, say: (line) => said.push(line) };
  const waiting = "Waiting for Knowledge & capabilities to finish";
  const unmarked = row => { for (const name of ["aria-disabled", "title", "aria-description", "aria-haspopup", "aria-expanded"]) assert.equal(row.hasAttribute(name), false, name); };
  const held = (menu, reason) => {
    for (const input of [{ x: 4, y: 4 }, {}]) { // a right-click; a key's (Shift+F10, the Menu key)
      said.length = 0; rowOf(menu).focus();
      assert.equal(contextMenu(menu, input), true, "no native menu either");
      assert.equal(isOpen(menu), false, "a held menu opens nothing"); assert.deepEqual(said, [reason]);
      assert.equal(doc.activeElement, rowOf(menu), "the focus stays on the row");
    }
    unmarked(rowOf(menu));
  };
  const first = attach(doc.body, menuFor(doc, instance, options)), row = rowOf(first);
  contextMenu(first); assert.equal(doc.activeElement.dataset.action, "inspect");
  doc.activeElement.click(); assert.equal(calls, 1);
  assert.equal(isOpen(first), false); assert.equal(doc.activeElement, row, "focus returns to the row");
  held(first, waiting);
  await choose(first, "inspect"); assert.equal(calls, 1, "no second action while one is pending");
  const replacement = attach(doc.body, menuFor(doc, instance, options)); held(replacement, waiting);
  const stale = attach(doc.body, menuFor(doc, instance, { ...options, stale: ROSTER_STALE_TITLE }));
  finish({}); await new Promise(setImmediate);
  for (const menu of [first, replacement]) { said.length = 0; contextMenu(menu); assert.equal(isOpen(menu), true); assert.deepEqual(said, []); menu.hidePopover(); unmarked(rowOf(menu)); }
  held(stale, ROSTER_STALE_TITLE);
  dom.window.close();
});

// The leader's and the sidebar's X R S D (docs/desktop-keyboard.md, "Sidebar keys") are held while
// the row's menu waits for one of its acts, as the menu is, its row drawn or not: the shipped
// rosterActsHeld reads the menu's pending reason by its own key (scope, identity, incarnation).
test("a lifecycle shortcut waits while the row's menu has an act in flight, and runs once it settles", async () => {
  const dom = menuDom(), doc = dom.window.document;
  let finish;
  const instance = { instance: "dev-held", home: "/home/dev-held", running: true, createdAt: "2026-10-19T00:00:00Z" };
  const options = { scope: "ws-a", invoke: () => new Promise((r) => { finish = r; }), openLifecycle: assert.fail, done() {}, report: assert.fail };
  const control = menuFor(doc, instance, options); attach(doc.body, control);
  const shell = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
  const source = shell.match(/function rosterActsHeld\([^]*?\n\}/)?.[0];
  assert.ok(source, "exercise the shipped rosterActsHeld");
  const rosterActsHeld = runInNewContext(`${source}; rosterActsHeld;`, { pendingActionReason, contextWorkspace: "ws-a", currentWorkspace: () => "ws-a",
    rosterStale: false, rowStale: () => false, contextDeployments: [], ROSTER_STALE_TITLE });
  const calls = [];
  const d = createLeaderDispatch({ say: (line) => calls.push(["say", line]), targetId: () => "dev-held", target: () => instance, rosterRows: () => [],
    menuReason: rosterActsHeld, openAct: (verb) => calls.push(["dialog", verb]), spawnSoul() {} });
  control.querySelector('[data-action="inspect"]').click();
  const waiting = "Waiting for Knowledge & capabilities to finish";
  assert.equal(pendingActionReason("ws-a", instance), waiting);
  assert.equal(pendingActionReason("ws-b", instance), null, "another workspace's menu is another menu");
  assert.equal(pendingActionReason("ws-a", { ...instance, createdAt: "2026-10-20T00:00:00Z" }), null, "another incarnation's too");
  control.remove(); // filtered or collapsed away: the act is still in flight
  d.run("stop", {});
  finish({}); await new Promise(setImmediate);
  assert.equal(pendingActionReason("ws-a", instance), null);
  d.run("stop", {});
  assert.deepEqual(calls, [["say", waiting], ["dialog", "stop"]]);
  dom.window.close();
});

test("a failing action reports a plain headline with the error as detail, never an alert", async () => {
  const dom = menuDom(), doc = dom.window.document; dom.window.alert = () => assert.fail("no alert");
  const reports = [], instance = { instance: "dev-fail", home: "/home/dev-fail" };
  const control = menuFor(doc, instance, { invoke: async () => { throw new Error("E_SPAWN: preview refused"); },
    openLifecycle: assert.fail, done: assert.fail, report: (...args) => reports.push(args),
    extra: [{ action: "open-split", label: "Open in split" }] });
  attach(doc.body, control);
  await choose(control, "inspect"); await choose(control, "open-split");
  assert.deepEqual(reports, [
    ["Knowledge & capabilities didn't finish for dev-fail.", { detail: "E_SPAWN: preview refused", action: "inspect", instance }],
    ["Open in split didn't finish for dev-fail.", { detail: "E_SPAWN: preview refused", action: "open-split", instance }]]);
  contextMenu(control); assert.equal(isOpen(control), true, "a failed act holds nothing"); control.hidePopover();
  const unplanned = menuFor(doc, instance, { invoke: assert.fail, report: (...args) => reports.push(args) }); attach(doc.body, unplanned);
  await choose(unplanned, "retire");
  assert.deepEqual(reports.at(-1), ["A plan-backed confirmation is required for Stop or Retire.", { action: "retire", instance }]);
  dom.window.close();
});

test("the retire item reads Retire instance…", () => {
  const dom = menuDom();
  const control = menuFor(dom.window.document, { instance: "dev", home: "/home/dev" }, {});
  assert.equal(control.querySelector('[data-action="retire"]').textContent, "Retire instance…");
  assert.doesNotMatch(control.textContent, /Remove/);
  dom.window.close();
});


test("actions are app buttons with keyboard navigation, dismissal and refresh restoration", () => {
  const dom = menuDom(), doc = dom.window.document;
  const instance = { instance: "menu-worker", home: "/menu/worker" };
  const options = { invoke: assert.fail, openLifecycle: assert.fail, done() {}, report: assert.fail };
  let control = menuFor(doc, instance, options); attach(doc.body, control);
  assert.equal(control.querySelector("select"), null, "no OS-formatted select or native dropdown arrow");
  let row = rowOf(control);
  assert.equal(control.getAttribute("role"), "menu"); assert.equal(control.getAttribute("popover"), "auto");
  assert.equal(control.getAttribute("aria-label"), "Actions for menu-worker");
  const key = (element, value) => element.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
  // The row's own keys open nothing (roster-keys.mjs has them); its contextmenu (Shift+F10, the Menu key) does.
  row.focus(); for (const value of ["ArrowDown", "ArrowUp", "Enter"]) key(row, value);
  assert.equal(isOpen(control), false);
  contextMenu(control);
  assert.equal(isOpen(control), true);
  assert.equal(doc.activeElement.dataset.action, "inspect");
  key(doc.activeElement, "ArrowDown");
  assert.equal(doc.activeElement.dataset.action, 'stop');
  key(doc.activeElement, 'ArrowDown');
  assert.equal(doc.activeElement.dataset.action, "retire");
  control.style.left = "40px"; control.style.top = "60px"; // where it was drawn
  const restore = captureInstanceActionMenu(doc.body);
  detach(control); control = menuFor(doc, instance, options); attach(doc.body, control); restore();
  row = rowOf(control);
  assert.equal(isOpen(control), true);
  assert.equal(doc.activeElement.dataset.action, "retire", "refresh keeps the selected action");
  assert.deepEqual([control.style.left, control.style.top], ["40px", "60px"], "and the place it was open at");
  key(doc.activeElement, "Home"); assert.equal(doc.activeElement.dataset.action, "inspect");
  key(doc.activeElement, "End"); assert.equal(doc.activeElement.dataset.action, "retire");
  const esc = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  let escaped = false; doc.body.addEventListener("keydown", () => { escaped = true; }, { once: true });
  doc.activeElement.dispatchEvent(esc);
  assert.equal(isOpen(control), false); assert.equal(esc.defaultPrevented, true); assert.equal(escaped, false, "Esc closes the menu, nothing behind it");
  assert.equal(doc.activeElement, row, "Esc hands the focus back to the row");
  contextMenu(control); assert.equal(doc.activeElement.dataset.action, "inspect");
  key(doc.activeElement, "Tab"); assert.equal(isOpen(control), false);
  assert.equal(doc.activeElement, row, "Tab continues from the row, not a hidden menu item");
  contextMenu(control); control.hidePopover(); // the browser's light-dismiss path
  assert.equal(isOpen(control), false);
  dom.window.close();
});

// In the open menu, an arrow chord the keymap binds is the keymap's (keybindings.mjs keymapTakes): Alt+Shift+↓
// opens the next instance's terminal from an item too, and a rebind follows; so do the workspace steps (Alt+↑/↓ in
// every Linux/Windows family); an arrow chord bound to nothing (Ctrl+↓) still walks the items. The row's own arrows
// are roster-keys.mjs's, never the menu's: they open nothing.
test("the row's context menu gives way to the keymap's arrow chords, and only to those", t => {
  pinPlatform(t); // the Linux and Windows keymap: Alt+Shift+↑/↓ the instances, Alt+↑/↓ the workspaces (not the Mac's)
  const dom = menuDom(), doc = dom.window.document;
  const options = { invoke: assert.fail, openLifecycle: assert.fail, done() {}, report: assert.fail };
  // The shell's global arrow chords (shell.mjs).
  const offs = ["roster.openPrevious", "roster.openNext", "workspace.previous", "workspace.next"]
    .map(id => registerAction({ id, label: id, context: "global", run: () => {} }));
  t.after(() => { offs.forEach(off => off()); resetBinding("roster.openNext"); dom.window.close(); });
  const control = menuFor(doc, { instance: "menu-worker", home: "/menu/worker" }, options); attach(doc.body, control);
  const row = rowOf(control);
  const press = (target, init) => { const e = new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }); target.dispatchEvent(e); return e; };
  for (const key of ["ArrowDown", "ArrowUp"]) for (const mods of [{}, { altKey: true, shiftKey: true }, { altKey: true }, { ctrlKey: true }]) {
    assert.equal(press(row, { key, ...mods }).defaultPrevented, false, `${JSON.stringify(mods)} ${key} on the row is not the menu's`);
    assert.equal(isOpen(control), false);
  }
  contextMenu(control);
  const first = doc.activeElement;
  assert.equal(isOpen(control), true);
  for (const key of ["ArrowDown", "ArrowUp"]) for (const mods of [{ altKey: true, shiftKey: true }, { altKey: true }]) {
    assert.equal(press(doc.activeElement, { key, ...mods }).defaultPrevented, false, `${JSON.stringify(mods)} ${key} in the menu is the keymap's`);
    assert.equal(doc.activeElement, first, "and moves no focus");
  }
  setBinding("roster.openNext", "Ctrl+Shift+↓");
  assert.equal(press(doc.activeElement, { key: "ArrowDown", ctrlKey: true, shiftKey: true }).defaultPrevented, false, "the rebind is the keymap's");
  assert.equal(doc.activeElement, first);
  resetBinding("roster.openNext");
  assert.equal(press(doc.activeElement, { key: "ArrowDown", ctrlKey: true }).defaultPrevented, true, "Ctrl+↓, bound to nothing, walks the menu");
  assert.notEqual(doc.activeElement, first);
});

// Placed as the workspace row's context menu is (workspace-switcher.mjs openRowMenu): at the pointer for a
// right-click on the row (or wherever a key's event says it is on it: Chromium gives the focused row's centre), under the
// row's start for an event with no point (jsdom's key-less model) or a point off the row, kept 8px inside the window.
test("the row's context menu opens at the event's point on the row, else under the row, inside the window", () => {
  const dom = menuDom(), doc = dom.window.document, view = dom.window;
  Object.defineProperty(view, "innerWidth", { value: 400, configurable: true }); Object.defineProperty(view, "innerHeight", { value: 300, configurable: true });
  const control = attach(doc.body, menuFor(doc, { instance: "dev", home: "/home/dev" }, { invoke: assert.fail }));
  const rect = (left, top, width, height) => () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
  rowOf(control).getBoundingClientRect = rect(20, 100, 200, 28);
  control.getBoundingClientRect = rect(0, 0, 200, 120);
  const at = (input) => { contextMenu(control, input); const place = [control.style.left, control.style.top]; control.hidePopover(); return place; };
  assert.deepEqual(at({ x: 60, y: 110 }), ["60px", "110px"], "a right-click: at the pointer");
  assert.deepEqual(at({}), ["28px", "128px"], "no point: under the row, at its start");
  assert.deepEqual(at({ x: 380, y: 300 }), ["28px", "128px"], "a point outside the row is not a pointer on it");
  assert.deepEqual(at({ x: 210, y: 120 }), ["192px", "120px"], "kept inside the window's right edge");
  rowOf(control).getBoundingClientRect = rect(20, 250, 200, 28);
  assert.deepEqual(at({}), ["28px", "130px"], "with no room below, above the row");
  dom.window.close();
});

// Linux and macOS fire a right-click's contextmenu on the press, with the right button down: opened then, the menu
// would be light-dismissed by the release outside it (context-menu-release.mjs). It opens, or says why it is held,
// once released, at the press's point; a cancelled press does neither.
test("a right-click held down opens the row's context menu once released, and a held one says why only then", async () => {
  const dom = menuDom(), doc = dom.window.document, view = dom.window, said = [];
  let held = null;
  const control = attach(doc.body, menuFor(doc, { instance: "dev", home: "/home/dev" }, { invoke: assert.fail, say: (line) => said.push(line) }));
  const pending = attach(doc.body, menuFor(doc, { instance: "dev-held", home: "/home/dev-held" }, { invoke: () => new Promise((r) => { held = r; }), say: (line) => said.push(line) }));
  pending.querySelector('[data-action="inspect"]').click();
  rowOf(control).getBoundingClientRect = () => ({ left: 0, top: 0, right: 200, bottom: 30, width: 200, height: 30 });
  const press = (menu, x = 0, y = 0) => {
    const event = new view.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, buttons: 2, clientX: x, clientY: y, view });
    rowOf(menu).dispatchEvent(event); return event.defaultPrevented;
  };
  const end = (type) => view.dispatchEvent(new view.MouseEvent(type, { bubbles: true }));
  const task = () => new Promise((r) => view.setTimeout(r));
  assert.equal(press(control, 40, 12), true, "the native menu is prevented at once");
  assert.equal(isOpen(control), false, "nothing opens while the button is down");
  end("pointerup"); assert.equal(isOpen(control), false, "not in the release itself (its light dismiss runs there)");
  await task();
  assert.equal(isOpen(control), true); assert.equal(doc.activeElement.dataset.action, "inspect");
  assert.equal(control.style.left, "40px", "at the press's point");
  control.hidePopover();
  press(control); end("pointercancel"); end("pointerup"); await task();
  assert.equal(isOpen(control), false, "a cancelled press opens nothing, and a later release is not its own");
  press(pending); assert.deepEqual(said, [], "a held menu says nothing while the button is down");
  end("pointerup"); await task();
  assert.deepEqual(said, ["Waiting for Knowledge & capabilities to finish"]); assert.equal(isOpen(pending), false);
  held({}); await task();
  dom.window.close();
});

/* ── #982: a reason that is the row's own text is shown with who made it ── */
test("Start on a Herdr row says who made its reason: each speaker, none, and hostile text as text; it stays disabled whatever the text shows", () => {
  const dom = menuDom(), doc = dom.window.document;
  const start = (extra) => {
    const control = menuFor(doc, { instance: "h1", home: "/home/h1", running: null, runtimeState: "unsupported", ...extra },
      { invoke: () => assert.fail("nothing is sent"), openLifecycle: () => assert.fail("no dialog"), report: m => assert.fail(m) });
    attach(doc.body, control);
    return control.querySelector('[data-action="start"]');
  };
  const reason = `${HERDR} (h1)`;
  for (const [origin, line] of shown(reason)) {
    const item = start({ runtimeError: reason, ...(origin ? { runtimeErrorOrigin: origin } : {}) });
    assert.equal(item.title, line, String(origin)); assert.equal(item.querySelector("small").textContent, line, String(origin));
    assert.equal(item.disabled, true);
  }
  // The stand-in for an older kernel's row is the client's sentence: no lead, whatever mark the row carries.
  for (const row of [{ runtimeState: undefined, backend: "herdr", running: true }, { runtimeState: undefined, backend: "herdr", running: true, runtimeError: "another text", runtimeErrorOrigin: "kernel" }]) {
    assert.equal(start(row).title, HERDR);
  }
  const markup = start({ runtimeError: `E_HERDR_REMOVED: ${MARKUP}`, runtimeErrorOrigin: "kernel" });
  assert.equal(markup.querySelector("small").textContent, `OATS says: E_HERDR_REMOVED: ${MARKUP}`);
  assert.equal(doc.querySelector("small b, small script"), null, "the reason is text");
  const withheld = start({ runtimeError: `E_HERDR_REMOVED: ${CONTROL}`, runtimeErrorOrigin: "kernel" });
  assert.equal(withheld.title, DETAIL_WITHHELD, "an unsafe reason is withheld, under no speaker's name"); assert.equal(withheld.disabled, true);
  // A reason with nothing to show: the act is listed as not enabled all the same, with no words.
  const blank = start({ runtimeError: "   ", runtimeErrorOrigin: "kernel" });
  assert.equal(blank.title, ""); assert.equal(blank.disabled, true);
  dom.window.close();
});

test("a row that offers nothing says why when its context menu is asked for, with who made the text when it is the row's own", () => {
  const dom = menuDom(), doc = dom.window.document;
  // What the menu says for a row, and that it opened nothing.
  const says = (extra) => {
    const said = [];
    const control = attach(doc.body, menuFor(doc, { instance: "dev-a", home: "/remote/dev-a", server: "box", repoName: "box-repo", addressable: false, running: null, serverUnreached: true, ...extra },
      { invoke: () => assert.fail("nothing is sent"), openLifecycle: () => assert.fail("no dialog"), say: line => said.push(line) }));
    contextMenu(control);
    assert.equal(isOpen(control), false); assert.equal(said.length, 1);
    return said[0];
  };
  const text = "the read did not answer";
  for (const [origin, line] of shown(text)) assert.equal(says({ runtimeError: text, ...(origin ? { runtimeErrorOrigin: origin } : {}) }), line, String(origin));
  assert.equal(says({}), "box-repo was not reached.", "a sentence written here has no lead");
  assert.equal(says({ serverUnreached: false, runtimeError: text, runtimeErrorOrigin: "kernel" }), "box-repo did not report this instance as reachable.",
    "a sentence written here stays without one beside a row's marked text");
  assert.equal(says({ runtimeError: CONTROL, runtimeErrorOrigin: "roster-read" }), DETAIL_WITHHELD);
  dom.window.close();
});
