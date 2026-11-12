// One Desktop window per workspace (#481): the workspace list's Open in new window and the window that has no
// workspace yet. No button is drawn for it: ⌘Enter (macOS) / Ctrl+Enter on a row does it, the rows'
// aria-describedby hint says so, and the row's context menu (the page's own popover, one menuitem) offers it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';
import { createWorkspaceSwitcher, openInNewWindowHint, OPEN_IN_NEW_WINDOW } from '../renderer/workspace-switcher.mjs';
import { createPalette } from '../renderer/palette.mjs';
import { takePickerFocusReturn } from '../renderer/overlay-picker.mjs';

const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
const A = { id: 'ws:aaaaaaaaaaaaaaaaaaaa', name: 'oats' };
const B = { id: 'ws:bbbbbbbbbbbbbbbbbbbb', name: 'web' };
const LOOSE = { id: 'remote:build:/x', name: 'build', unattached: true, deployments: ['remote:build:/x'] };

function setup({ mac = true, openInNewWindow = true } = {}) {
  const dom = new JSDOM(html, { url: 'file:///renderer/index.html' });
  // jsdom has no popover API: the menu's show and hide are recorded.
  const popovers = [];
  dom.window.HTMLElement.prototype.showPopover = function () { popovers.push(['show', this]); };
  dom.window.HTMLElement.prototype.hidePopover = function () { popovers.push(['hide', this]); };
  const document = dom.window.document, selected = [], opened = [];
  const controller = createWorkspaceSwitcher({ document, mac,
    selectWorkspace: (id) => selected.push(id), discoverSuggestions: async () => [],
    addWorkspace: async () => ({ ok: false }), pickWorkspace: async () => ({ ok: false, code: 'cancelled' }),
    ...(openInNewWindow ? { openInNewWindow: (id) => opened.push(id) } : {}) });
  controller.begin()(A, [A, B, LOOSE]);
  const key = (el, init) => {
    const event = new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const contextmenu = (el) => {
    const event = new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { dom, document, controller, selected, opened, popovers, key, contextmenu };
}
const option = (document, id) => document.querySelector(`.ws-option[data-workspace-id="${id}"]`);
const menu = (document) => document.querySelector('.ws-row-menu');

test('no per-row button: a row is its circle and its name', () => {
  const { document } = setup();
  assert.equal(document.querySelector('.ws-open-window'), null);
  for (const [choice, label] of [[A, 'oats'], [B, 'web'], [LOOSE, 'build']]) {
    const row = option(document, choice.id);
    assert.deepEqual([...row.children].map((child) => child.className), [choice === A ? 'ctx-dot on' : 'ctx-dot off', 'ws-option-name'], choice.id);
    assert.equal(row.textContent, label);
    assert.equal(row.parentElement.querySelectorAll('button').length, 1, 'nothing beside the row either');
  }
});

test('the rows say how to open in a new window (one shared aria-describedby hint, the platform chord in words)', () => {
  for (const [mac, chord] of [[true, '⌘Enter'], [false, 'Ctrl+Enter']]) {
    const { document } = setup({ mac });
    const hintId = option(document, A.id).getAttribute('aria-describedby');
    assert.equal(hintId, 'ws-open-window-hint');
    const hint = document.getElementById(hintId);
    assert.ok(hint, 'the hint exists in the document');
    assert.equal(hint.hidden, true, 'said, not shown');
    assert.equal(hint.textContent, openInNewWindowHint(mac));
    assert.equal(hint.textContent, `Press ${chord} to open this workspace in a new window.`);
    assert.doesNotMatch(hint.textContent, /Right Arrow/, 'no button to reach');
    for (const id of [B.id, LOOSE.id]) assert.equal(option(document, id).getAttribute('aria-describedby'), hintId, 'one shared hint');
  }
});

test('⌘Enter on macOS, Ctrl+Enter elsewhere, on a row opens it in a new window; plain Enter selects', () => {
  for (const [mac, chord] of [[true, { metaKey: true }], [false, { ctrlKey: true }]]) {
    const { document, key, opened, selected } = setup({ mac });
    option(document, B.id).focus();
    assert.equal(key(option(document, B.id), { key: 'Enter', ...chord }), true, 'consumed');
    assert.deepEqual(opened, [B.id]); assert.deepEqual(selected, []);
    const other = mac ? { ctrlKey: true } : { metaKey: true };
    assert.equal(key(option(document, A.id), { key: 'Enter', ...other }), false);
    assert.equal(key(option(document, A.id), { key: 'Enter', ...chord, shiftKey: true }), false, 'a Shift chord is not it');
    assert.deepEqual(opened, [B.id], 'the other platform\'s chord does nothing');
    // Plain Enter is the button's own activation: left alone, its click selects (jsdom does not turn the
    // keydown into that click, so the test sends it).
    assert.equal(key(option(document, B.id), { key: 'Enter' }), false);
    option(document, B.id).click();
    assert.deepEqual(selected, [B.id]); assert.deepEqual(opened, [B.id]);
  }
});

test('the row\'s context menu: the native one is prevented, the page\'s opens with one item, focused, for that row', () => {
  for (const [mac, chord] of [[true, '⌘Enter'], [false, 'Ctrl+Enter']]) {
    const { document, contextmenu, popovers } = setup({ mac });
    const rowMenu = menu(document);
    assert.ok(rowMenu, 'drawn once, inside the list section');
    assert.ok(document.getElementById('ws-list').contains(rowMenu));
    assert.equal(rowMenu.getAttribute('popover'), 'auto'); assert.equal(rowMenu.getAttribute('role'), 'menu');
    assert.ok(rowMenu.classList.contains('ctx-instance-menu'), 'the instance menu\'s look');
    option(document, B.id).focus();
    assert.equal(contextmenu(option(document, B.id)), true, 'default prevented: no native Copy/Paste menu for a row');
    assert.deepEqual(popovers, [['show', rowMenu]]);
    assert.equal(rowMenu.getAttribute('aria-label'), 'web', 'labelled with the row\'s name');
    const items = [...rowMenu.querySelectorAll('[role="menuitem"]')];
    assert.equal(items.length, 1);
    assert.equal(items[0].dataset.action, 'open-in-new-window');
    assert.equal(items[0].querySelector('span').textContent, OPEN_IN_NEW_WINDOW);
    assert.equal(OPEN_IN_NEW_WINDOW, 'Open in new window');
    assert.equal(items[0].querySelector('kbd').textContent, chord);
    assert.equal(document.activeElement, items[0], 'focus on its item');
    contextmenu(option(document, LOOSE.id));
    assert.equal(rowMenu.getAttribute('aria-label'), 'build', 'another row\'s menu is for that row');
  }
});

test('the menu\'s item opens that row in a new window, never selects it here, and focus goes back to the row', () => {
  const { document, contextmenu, opened, selected, popovers } = setup();
  contextmenu(option(document, B.id));
  document.activeElement.click();
  assert.deepEqual(opened, [B.id]); assert.deepEqual(selected, []);
  assert.deepEqual(popovers.at(-1), ['hide', menu(document)], 'the menu closes');
  assert.equal(document.activeElement, option(document, B.id));
  assert.equal(option(document, A.id).getAttribute('aria-current'), 'true', 'this window still shows its own');
});

test('Escape (and Tab) close the menu and return focus to its row; the arrows stay on its one item', () => {
  const { document, contextmenu, key, opened, popovers } = setup();
  contextmenu(option(document, B.id));
  const item = document.activeElement;
  assert.equal(key(item, { key: 'ArrowDown' }), true); assert.equal(document.activeElement, item, 'the list behind does not move');
  assert.equal(key(item, { key: 'Escape' }), true);
  assert.deepEqual(popovers.at(-1), ['hide', menu(document)]);
  assert.equal(document.activeElement, option(document, B.id));
  contextmenu(option(document, LOOSE.id));
  key(document.activeElement, { key: 'Tab' });
  assert.deepEqual(popovers.at(-1), ['hide', menu(document)]);
  assert.equal(document.activeElement, option(document, LOOSE.id));
  assert.deepEqual(opened, [], 'closing opens nothing');
});

test('without a window bridge (the browser harness): no hint, no describedby, no menu, and the native context menu stays', () => {
  const { document, contextmenu, popovers } = setup({ openInNewWindow: false });
  assert.equal(document.getElementById('ws-open-window-hint'), null);
  assert.equal(option(document, A.id).hasAttribute('aria-describedby'), false);
  assert.equal(menu(document), null);
  assert.equal(contextmenu(option(document, A.id)), false, 'not prevented');
  assert.deepEqual(popovers, []);
});

test('a row another window shows behaves like any row: same line, a pick takes it over, its menu opens a new window', () => {
  const { document, controller, selected, opened, contextmenu, key } = setup();
  controller.begin()(A, [A, { ...B, shown: true }, LOOSE]);
  const row = option(document, B.id);
  assert.equal(row.textContent, 'web', 'no "In another window"');
  assert.equal(row.title, 'web');
  assert.equal(row.hasAttribute('aria-disabled'), false);
  contextmenu(row); document.activeElement.click();
  assert.deepEqual(opened, [B.id], 'main focuses the window that has it');
  key(option(document, B.id), { key: 'Enter', metaKey: true });
  assert.deepEqual(opened, [B.id, B.id]);
  option(document, B.id).click();
  assert.deepEqual(selected, [B.id], 'the row itself selects it here (the shell asks main to take it over)');
});

test('a window with no workspace: the list says none is chosen, the choices come from main, none is current', () => {
  const { document, controller } = setup();
  controller.choose([A, B]);
  assert.equal(document.getElementById('ws-list').getAttribute('aria-description'), 'Current workspace: none chosen yet');
  const options = [...document.querySelectorAll('.ws-option')];
  assert.deepEqual(options.map((o) => o.dataset.workspaceId), [A.id, B.id]);
  assert.ok(options.every((o) => !o.hasAttribute('aria-current')), 'nothing is current');
  assert.ok(options.every((o) => !o.querySelector('svg')), 'no icon of any kind on a row');
  controller.reset();
  assert.equal(document.getElementById('ws-list').getAttribute('aria-description'), 'Current workspace: resolving', 'before main answers');
});

test('a window with no workspace hides its whole instance section (the shipped CSS honours [hidden])', () => {
  const dom = new JSDOM(html, { url: 'file:///renderer/index.html' });
  const style = dom.window.document.createElement('style');
  style.textContent = readFileSync(new URL('../renderer/shell.css', import.meta.url), 'utf8');
  dom.window.document.head.append(style);
  const roster = dom.window.document.getElementById('instance-roster');
  assert.equal(dom.window.getComputedStyle(roster).display, 'flex');
  roster.hidden = true;
  assert.equal(dom.window.getComputedStyle(roster).display, 'none', 'no header, count pill or filter for a workspace it does not have');
  dom.window.close();
});

// The chooser stage (shell.mjs showChooser), run on its own: its text is extracted and run with the shell's
// names it uses stubbed, as the shell harnesses do. Entering the stage and its button share one rule: the list
// when main served workspaces to choose from, else Add local workspace…, with the button as the opener.
function chooserStage(choices) {
  const source = readFileSync(new URL('../renderer/shell.mjs', import.meta.url), 'utf8');
  const fn = source.match(/async function showChooser\(\)[^]*?\n\}/)?.[0];
  assert.ok(fn, 'showChooser is found');
  const dom = new JSDOM('<main id="stage"></main>');
  const calls = [], list = { now: choices };
  const context = {
    document: dom.window.document, stageHost: dom.window.document.getElementById('stage'), contextRosterEl: null,
    tabOpenIntents: { invalidate() {} }, showTabLayer() {}, closeStage: async () => true, windowState: () => 'choosing',
    choosingWorkspaces: () => list.now, focusWorkspaceList: () => calls.push(['focus']),
    workspaceLabel: { choose: (rows) => calls.push(['choose', rows.length]), openModal: (opener) => { calls.push(['modal', opener?.textContent]); } },
  };
  vm.runInNewContext(`${fn}\nglobalThis.showChooser = showChooser;`, context);
  return { dom, calls, list, run: () => context.showChooser(), button: () => context.stageHost.querySelector('button') };
}

test('a window with no workspace and choices to show: the stage focuses the list, and so does its button', async () => {
  const s = chooserStage([{ id: 'ws:a' }]);
  await s.run();
  assert.deepEqual(s.calls, [['choose', 1], ['focus']]);
  s.button().click();
  assert.deepEqual(s.calls.at(-1), ['focus']);
  s.dom.window.close();
});

test('a window with no workspace and nothing served: the stage opens the Add dialog at once, its button opens it again', async () => {
  const s = chooserStage([]);
  await s.run();
  assert.deepEqual(s.calls, [['choose', 0], ['modal', 'Choose a workspace…']], 'opened by the chooser\'s button: focus goes back to it');
  s.button().click();
  assert.deepEqual(s.calls.at(-1), ['modal', 'Choose a workspace…']);
  // Choices served since (#521): the button goes to the list now.
  s.list.now = [{ id: 'ws:a' }];
  s.button().click();
  assert.deepEqual(s.calls.at(-1), ['focus']);
  s.dom.window.close();
});


// Show only the current workspace turned on (its chord) while another row's context menu has focus: the row goes,
// its menu closes, and focus lands on the current row, never <body> (review of PR 8).
test('a row whose menu holds focus, hidden by Show only the current workspace: the menu closes, focus on the current row', () => {
  const { document, controller, contextmenu, popovers } = setup();
  const rowMenu = menu(document);
  option(document, B.id).focus(); contextmenu(option(document, B.id));
  assert.equal(document.activeElement, rowMenu.querySelector('[role="menuitem"]'), 'focus in B\'s menu');
  controller.toggleCurrentOnly();
  assert.equal(controller.currentOnly, true);
  assert.equal(option(document, B.id).hidden, true, 'B is hidden');
  assert.deepEqual(popovers.at(-1), ['hide', rowMenu], 'its menu closed');
  assert.equal(document.activeElement, option(document, A.id), 'focus on the current row');
  // Focus elsewhere is left where it is: off and on again with focus outside the list and its menu.
  controller.toggleCurrentOnly();
  document.getElementById('ws-add-open').focus();
  controller.toggleCurrentOnly();
  assert.equal(document.activeElement, document.getElementById('ws-add-open'), 'focus outside the list stays put');
});

// The palette's Show only the current workspace, as shipped (shell.mjs), activated through the real palette: the
// palette hands focus to its command, which puts it back where the palette was opened before the toggle runs, so
// a hidden row's focus goes on to the current row and a control elsewhere keeps it (review of PR 8).
const shellSource = readFileSync(new URL('../renderer/shell.mjs', import.meta.url), 'utf8');
const paletteEntry = shellSource.match(/^ {4}\{ label: "Workspaces: show only the current workspace \(on \/ off\)"[^]*?\} \},$/m)?.[0];
async function viaPalette(s, opener) {
  const entry = vm.runInNewContext(`[${paletteEntry}][0]`, { chordDetail: () => () => '', takePickerFocusReturn, document: s.document,
    runAction: (id) => { assert.equal(id, 'workspaces.currentOnly'); s.controller.toggleCurrentOnly(); } });
  const picker = createPalette({ loadInstances: async () => [], openTerminal() {}, commands: [entry], doc: s.document });
  opener.focus();
  await picker.open();
  const input = s.document.querySelector('.palette-input');
  input.value = '>show only'; input.dispatchEvent(new s.dom.window.Event('input', { bubbles: true }));
  input.dispatchEvent(new s.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return picker;
}
test('the palette\'s entry, from a row it hides: focus goes to the current row; from another control: it stays there', async () => {
  assert.ok(paletteEntry, 'the shipped entry');
  const s = setup();
  await viaPalette(s, option(s.document, B.id));
  assert.equal(s.controller.currentOnly, true); assert.equal(option(s.document, B.id).hidden, true);
  assert.equal(s.document.querySelector('.palette-input'), null, 'the palette closed');
  assert.equal(s.document.activeElement, option(s.document, A.id), 'the current row, never <body>');
  // Off again from a control outside the list (a terminal's stand-in): focus back on it.
  const outside = s.document.createElement('textarea'); outside.className = 'xterm-helper-textarea'; s.document.getElementById('main').append(outside);
  await viaPalette(s, outside);
  assert.equal(s.controller.currentOnly, false);
  assert.equal(s.document.activeElement, outside, 'where the palette was opened');
});

// Linux and macOS fire a right-click's contextmenu on the press, with the right button down: opened then, the menu
// would be light-dismissed by the release outside it (context-menu-release.mjs). It opens once released; a cancelled
// press opens nothing.
test('a right-click held down opens the row\'s menu once released, and a cancelled one opens nothing', async () => {
  const { dom, document, popovers } = setup();
  const press = (el) => {
    const event = new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, buttons: 2, view: dom.window });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const end = (type) => dom.window.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true }));
  const task = () => new Promise((r) => dom.window.setTimeout(r));
  assert.equal(press(option(document, B.id)), true, 'the native menu is prevented at once');
  assert.deepEqual(popovers, [], 'nothing opens while the button is down');
  end('pointerup'); assert.deepEqual(popovers, [], 'not in the release itself (its light dismiss runs there)');
  await task();
  assert.deepEqual(popovers, [['show', menu(document)]]); assert.equal(menu(document).getAttribute('aria-label'), 'web');
  assert.equal(document.activeElement, menu(document).querySelector('[role="menuitem"]'));
  popovers.length = 0;
  press(option(document, LOOSE.id)); end('pointercancel'); end('pointerup'); await task();
  assert.deepEqual(popovers, [], 'a cancelled press opens nothing, and a later release is not its own');
});
