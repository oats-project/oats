// Workspace › Capabilities opens with the workspace's defaults (renderer/workspace-defaults.mjs, rendered first by
// workspace-catalog.mjs renderCapabilitySections) and its "i" opens "About capabilities" (renderer/about-dialog.mjs,
// shared with Workspace › Souls). Facts only from `oats workspace status --json` `defaults` and the catalog rows:
// without a reported `defaults` nothing is shown. jsdom; no CLI, server or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderCapabilitySections, syncCapabilityNav, catalogCSS } from '../renderer/workspace-catalog.mjs';
import { workspaceDefaults, defaultRow, defaultsCSS, DEFAULTS_COPY } from '../renderer/workspace-defaults.mjs';
import { ABOUT_COPY, aboutCSS, createAboutDialog } from '../renderer/about-dialog.mjs';
import { takePickerFocusReturn } from '../renderer/overlay-picker.mjs';
import { capabilitySections } from '../../client/capability-rows.mjs';
import { iconElement } from '../renderer/shell-icons.mjs';
import { captureFocusState } from '../renderer/loading.mjs';

const HOST = 'github.com/nw/agents', MKT = 'github.com/nw/marketing';
const ROWS = [
  { name: 'oats.okf', kind: 'package', package: 'oats.okf', version: '2.1.3', layer: 'knowledge', origin: 'package oats.okf v2.1.3' },
  { name: 'oats.aweb', kind: 'package', package: 'oats.aweb', version: '1.28.0', layer: 'messaging', origin: 'package oats.aweb v1.28.0' },
  { name: 'oats.core', kind: 'package', package: 'oats.framework', version: '1.11.0', origin: 'package oats.framework v1.11.0' },
  { name: 'nw-house-style', kind: 'member', repoKey: HOST, origin: `member ${HOST}` },
  { name: 'nw-brand-voice', kind: 'member', repoKey: MKT, origin: `member ${MKT}` },
  // The same name in another repository: matching never takes it for the host's.
  { name: 'nw-tasks', kind: 'member', repoKey: MKT, layer: 'tasks', origin: `member ${MKT}` },
];
const MEMBERS = [{ key: HOST, name: 'agents', status: 'confirmed' }, { key: MKT, name: 'marketing', status: 'confirmed' }];
const status = (defaults, workspace = { key: HOST, name: 'northwind' }) => ({ workspace, members: MEMBERS, ...(defaults === undefined ? {} : { defaults }) });
const FULL = {
  slots: { knowledge: { name: 'oats.okf', from: 'package' }, messaging: { name: 'oats.aweb', from: 'package' }, tasks: { name: 'nw-tasks', from: 'here' } },
  capabilities: [{ name: 'oats.core', from: 'package', off: false }, { name: 'nw-brand-voice', from: MKT, off: false }, { name: 'nw-house-style', from: null, off: true }],
};
const MIXED = { slots: { knowledge: { name: 'oats.okf', from: 'package' }, messaging: 'none', tasks: null }, capabilities: [{ name: 'nw-house-style', from: 'here', off: false }] };

function mount(t) {
  const dom = new JSDOM('<!doctype html><html data-theme="light"><body><main class="oats-view"><div class="toolbar"><div class="lead"></div></div><div class="sections"></div></main></body></html>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const style = doc.createElement('style'); style.textContent = defaultsCSS + aboutCSS; doc.head.append(style);
  const $ = sel => doc.querySelector(sel), $$ = sel => [...doc.querySelectorAll(sel)];
  const opened = [];
  const u = { last: null };
  const render = (st, { rows = ROWS, query = '', shown, onOpen = row => opened.push(row) } = {}) => {
    u.last = st;
    const sections = capabilitySections(rows);
    $('.lead').replaceChildren(); // the tab host clears its toolbar's jump before each paint
    renderCapabilitySections($('.sections'), { sections, shown: shown ?? sections.workspace, filterHost: null, privateListed: false, status: st, instances: [], query, onOpen });
  };
  const key = (el, name, init = {}) => el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }));
  return Object.assign(u, { dom, doc, $, $$, opened, render, key });
}
const slotCells = u => u.$$('.ws-defaults-group[data-group=core] .ws-defaults-cells > li > .ws-default-cell');
const addCells = u => u.$$('.ws-defaults-group[data-group=additional] .ws-defaults-cells > li > .ws-default-cell');
// A tile's icon, by its Lucide drawing.
const drawn = (u, name) => iconElement(u.doc, name, { size: 14 }).innerHTML;
// The words as they read: every text run, one space apart (a chip's name and version are separate spans).
const text = el => { const walk = el.ownerDocument.createTreeWalker(el, 4), out = []; while (walk.nextNode()) { const t = walk.currentNode.textContent.trim(); if (t) out.push(t); } return out.join(' '); };

test('workspaceDefaults reads only what the kernel reports: absent → null; a missing slot, "none", null or another string → empty; the count', () => {
  assert.equal(workspaceDefaults(status(undefined)), null, 'no defaults reported: no claim');
  assert.equal(workspaceDefaults(status(null)), null);
  const d = workspaceDefaults(status({ slots: { knowledge: 'none', messaging: 'kernel-says-something' }, capabilities: [{ name: 'a', from: 'package', off: true }, { name: 'b', from: 'package' }, { from: 'package' }] }));
  assert.deepEqual(d.slots.map(s => [s.slot, s.value]), [['knowledge', null], ['messaging', null], ['tasks', null]], 'the strip order, every slot empty');
  assert.deepEqual(d.capabilities.map(c => c.name), ['a', 'b'], 'an entry without a name is not shown');
  assert.equal(d.count, 1, 'filled slots plus capabilities not turned off'); assert.equal(d.empty, false);
  assert.equal(workspaceDefaults(status(FULL)).count, 5);
  assert.equal(workspaceDefaults(status({ slots: { knowledge: null, messaging: 'none', tasks: 'none' }, capabilities: [] })).empty, true);
  assert.equal(workspaceDefaults(status({ slots: {} })).empty, true, 'no capabilities key: none');
});

test('defaultRow: a package by name and kind, a member by its key, "here" as the host; unmatched names its source with no version', () => {
  assert.equal(defaultRow(ROWS, { name: 'oats.okf', from: 'package' }, HOST).row, ROWS[0]);
  assert.equal(defaultRow(ROWS, { name: 'nw-brand-voice', from: MKT }, HOST).row, ROWS[4]);
  assert.equal(defaultRow(ROWS, { name: 'nw-house-style', from: 'here' }, HOST).row, ROWS[3]);
  const other = defaultRow(ROWS, { name: 'nw-tasks', from: 'here' }, HOST);
  assert.deepEqual(other, { row: { name: 'nw-tasks', kind: 'member', repoKey: HOST }, listed: false }, 'the same name in another repository is not the host\'s');
  assert.deepEqual(defaultRow(ROWS, { name: 'nw-house-style', from: 'package' }, HOST), { row: { name: 'nw-house-style', kind: 'package' }, listed: false }, 'a member row is never taken for a package, and no package is named');
  assert.equal(defaultRow(ROWS, { name: 'x', from: null }, HOST), null, 'no source: nothing to name');
  assert.equal(defaultRow(ROWS, { name: 'x', from: 'here' }, null), null, 'no host key: "here" names nothing');
});

test('filled slots and other defaults: Knowledge, Messaging, Tasks with their id and source chip, each a button opening the matched row', t => {
  const u = mount(t);
  u.render(status(FULL));
  const section = u.$('.capability-section');
  assert.equal(section.dataset.section, 'defaults', 'the first section');
  assert.equal(section.getAttribute('aria-labelledby'), 'capability-section-defaults');
  const head = u.$('#capability-section-defaults');
  assert.equal(head.tagName, 'H2'); assert.ok(head.classList.contains('capability-section-title'));
  assert.equal(head.textContent, 'Workspace defaults'); assert.equal(head.querySelector('.capability-section-lead'), null, 'no lead text');
  assert.equal(text(u.$('.ws-defaults-scope')), 'Every soul in northwind starts with these, unless it turns one off.');
  assert.equal(u.$('.ws-defaults-scope .ws-defaults-ws').textContent, 'northwind');
  assert.equal(u.$('.ws-defaults-panel .identity-mark'), null, 'no identity mark');
  // Two groups in the panel, Core then Additional, each headed (h3) with its lead; each list is labelled by its heading.
  assert.deepEqual(u.$$('.ws-defaults-group').map(g => [g.dataset.group, g.querySelector('h3').firstChild.textContent, g.querySelector('.ws-defaults-group-lead').textContent]),
    [['core', 'Core capabilities', 'at most one of each per soul'], ['additional', 'Additional capabilities', 'any number per soul']]);
  for (const g of u.$$('.ws-defaults-group')) assert.equal(g.querySelector('ul').getAttribute('aria-labelledby'), g.querySelector('h3').id);
  const cells = slotCells(u);
  assert.deepEqual(cells.map(c => [c.tagName, c.dataset.slot, c.querySelector('.ws-default-label').textContent, c.querySelector('.ws-default-name').textContent, text(c.querySelector('.source-chip'))]), [
    ['BUTTON', 'knowledge', 'Knowledge', 'oats.okf', 'oats.okf 2.1.3'],
    ['BUTTON', 'messaging', 'Messaging', 'oats.aweb', 'oats.aweb 1.28.0'],
    ['BUTTON', 'tasks', 'Tasks', 'nw-tasks', 'agents'],
  ]);
  assert.deepEqual(cells.map(c => c.querySelector('.ws-default-tile').dataset.tint), ['slate', 'sage', 'mauve']);
  assert.deepEqual(cells.map(c => c.querySelector('.ws-default-tile svg').innerHTML), [drawn(u, 'knowledge'), drawn(u, 'mail'), drawn(u, 'tasks')]);
  assert.equal(cells[0].getAttribute('aria-label'), 'Knowledge: oats.okf, the workspace default — open its page');
  assert.deepEqual(cells.map(c => c.dataset.focusKey), ['defaults:knowledge', 'defaults:messaging', 'defaults:tasks']);
  cells[0].click(); cells[2].click();
  assert.equal(u.opened[0], ROWS[0], 'the catalog row itself');
  assert.deepEqual(u.opened[1], { name: 'nw-tasks', kind: 'member', repoKey: HOST }, 'unlisted: a minimal row, still opened (the page says it is not listed)');
  assert.equal(cells[2].querySelector('.source-chip-version'), null, 'never a guessed version');
  // Additional: the same cell, no slot label; the one turned off is a plain cell, struck through, with its note.
  const extra = addCells(u);
  assert.deepEqual(extra.map(c => [c.tagName, c.dataset.defaultCapability, text(c), c.querySelector('.ws-default-label')]), [
    ['BUTTON', 'oats.core', 'oats.core oats.framework 1.11.0', null],
    ['BUTTON', 'nw-brand-voice', 'nw-brand-voice marketing latest', null],
    ['DIV', 'nw-house-style', 'nw-house-style turned off by the workspace', null],
  ]);
  // Tiles: a package neutral with the package icon, a member capability clay with the repository icon, a default turned
  // off (no source reported) neutral with no source's icon.
  assert.deepEqual(extra.map(c => [c.querySelector('.ws-default-tile').dataset.tint ?? null, c.querySelector('.ws-default-tile svg').innerHTML]),
    [[null, drawn(u, 'package')], ['clay', drawn(u, 'repo')], [null, drawn(u, 'layers')]]);
  assert.equal(extra[0].getAttribute('aria-label'), 'oats.core, from oats.framework 1.11.0, a workspace default — open its page');
  assert.equal(extra[1].dataset.focusKey, 'defaults:cap:nw-brand-voice');
  assert.ok(extra[2].classList.contains('off')); assert.equal(extra[2].dataset.focusKey, undefined); assert.equal(extra[2].querySelector('.source-chip'), null);
  extra[1].click(); assert.equal(u.opened[2], ROWS[4]);
});

test('empty slots: None and the note, not interactive, a neutral tile; no additional defaults: the group says so', t => {
  const u = mount(t);
  u.render(status(MIXED));
  const cells = slotCells(u);
  assert.deepEqual(cells.map(c => c.tagName), ['BUTTON', 'DIV', 'DIV']);
  for (const cell of cells.slice(1)) {
    assert.equal(cell.querySelector('.ws-default-none').textContent, 'None');
    assert.equal(cell.querySelector('.ws-default-note').textContent, 'No workspace default. Each soul chooses its own.');
    assert.equal(cell.querySelector('.ws-default-tile').dataset.tint, undefined, 'neutral: --chip-bg / --chip-fg');
    assert.equal(cell.getAttribute('tabindex'), null); assert.equal(cell.dataset.focusKey, undefined);
  }
  assert.equal(text(addCells(u)[0]), 'nw-house-style agents latest', '"here" is the host repository');
  u.render(status({ ...MIXED, capabilities: [] }));
  assert.equal(addCells(u).length, 0);
  assert.equal(u.$('[data-group=additional] .ws-defaults-none').textContent, 'None. Each soul adds its own.');
  assert.equal(u.$('[data-group=additional] ul'), null);
  u.render(status({ slots: { knowledge: null, messaging: null, tasks: null }, capabilities: [{ name: 'x', from: null, off: true }] }));
  assert.equal(slotCells(u).length, 3, 'a turned-off default is still something the workspace says'); assert.equal(addCells(u).length, 1);
  assert.equal(u.$('[data-jump=defaults]'), null, 'no Defaults segment, so no count of them on the page');
});

// A core provider may be named under defaults.capabilities rather than defaults.<slot>: the kernel fills the slot by the
// capability's layer (test/resolve.test.mjs "layers-from"), so does the panel, from the catalog row's layer only.
test('a core capability named under defaults.capabilities fills its core cell, also over a slot that says none; never Additional', t => {
  const u = mount(t);
  const CHAT = { name: 'nw-chat', kind: 'member', repoKey: HOST, layer: 'messaging', origin: `member ${HOST}` };
  const rows = [...ROWS, CHAT];
  for (const messaging of [null, 'none']) {
    u.render(status({ slots: { knowledge: { name: 'oats.okf', from: 'package' }, messaging, tasks: null },
      capabilities: [{ name: 'nw-chat', from: 'here', off: false }, { name: 'oats.core', from: 'package', off: false }] }), { rows });
    const cell = slotCells(u)[1];
    assert.equal(cell.tagName, 'BUTTON'); assert.equal(cell.dataset.slot, 'messaging');
    assert.equal(text(cell), 'Messaging nw-chat agents latest');
    assert.equal(cell.querySelector('.ws-default-none'), null, 'not "None"');
    assert.equal(cell.querySelector('.ws-default-tile').dataset.tint, 'sage', 'the slot\'s tile');
    assert.equal(cell.getAttribute('aria-label'), 'Messaging: nw-chat, the workspace default — open its page');
    assert.equal(cell.dataset.focusKey, 'defaults:cap:nw-chat', 'its declaration\'s key, wherever it is drawn');
    assert.deepEqual(addCells(u).map(c => c.dataset.defaultCapability), ['oats.core'], 'not under Additional');
    assert.equal(workspaceDefaults(u.last).count, 3, 'the count is unchanged by where it shows');
    cell.click(); assert.equal(u.opened.at(-1), CHAT);
  }
  // Only the only one: with nothing else Additional says there is none.
  u.render(status({ slots: {}, capabilities: [{ name: 'nw-chat', from: 'here', off: false }] }), { rows });
  assert.equal(u.$('[data-group=additional] .ws-defaults-none').textContent, 'None. Each soul adds its own.');
  // A layer the catalog does not report is not guessed: unlisted, or turned off, it stays Additional.
  u.render(status({ slots: {}, capabilities: [{ name: 'nw-chat', from: 'here', off: false }] }), { rows: ROWS });
  assert.deepEqual(addCells(u).map(c => c.dataset.defaultCapability), ['nw-chat']); assert.equal(slotCells(u)[1].querySelector('.ws-default-none').textContent, 'None');
  u.render(status({ slots: {}, capabilities: [{ name: 'nw-chat', from: null, off: true }] }), { rows });
  assert.deepEqual(addCells(u).map(c => c.dataset.defaultCapability), ['nw-chat']);
});

test('a slot declared and a same-layer named default (the workspace\'s own conflict): both ids in the cell, the slot\'s first, each opening its page', t => {
  const u = mount(t);
  const CHAT = { name: 'nw-chat', kind: 'member', repoKey: HOST, layer: 'messaging', origin: `member ${HOST}` };
  u.render(status({ slots: { messaging: { name: 'oats.aweb', from: 'package' } }, capabilities: [{ name: 'nw-chat', from: 'here', off: false }] }), { rows: [...ROWS, CHAT] });
  const cell = slotCells(u)[1];
  assert.equal(cell.tagName, 'DIV', 'two pages: the cell is not one button'); assert.equal(cell.dataset.focusKey, undefined);
  const entries = [...cell.querySelectorAll('button.ws-default-entry')];
  assert.deepEqual(entries.map(e => [text(e), e.dataset.focusKey, e.getAttribute('aria-label')]), [
    ['oats.aweb oats.aweb 1.28.0', 'defaults:messaging', 'Messaging: oats.aweb, the workspace default — open its page'],
    ['nw-chat agents latest', 'defaults:cap:nw-chat', 'Messaging: nw-chat, the workspace default — open its page'],
  ]);
  assert.equal(cell.querySelector('.ws-default-label').textContent, 'Messaging'); assert.equal(cell.querySelectorAll('.ws-default-note').length, 0, 'no new copy');
  entries[1].click(); assert.equal(u.opened.at(-1), CHAT); entries[0].click(); assert.equal(u.opened.at(-1), ROWS[1]);
  assert.equal(addCells(u).length, 0);
});

// A repaint (the tab host's captureFocusState on the sections) puts focus back on the same declaration when a refresh
// moves it between the groups, turns one cell into two, or two declarations share a name.
test('focus follows the declaration across repaints: Additional → Core, one entry → two, the same name from two sources', t => {
  const u = mount(t);
  const CHAT = { name: 'nw-chat', kind: 'member', repoKey: HOST, layer: 'messaging', origin: `member ${HOST}` };
  const CHAT2 = { ...CHAT, repoKey: MKT, origin: `member ${MKT}` };
  const repaint = (st, opts) => { const restore = captureFocusState(u.$('.sections'), { scroller: null }); u.render(st, opts); return restore(); };
  // Unlisted (Additional), then listed with layer messaging (Core): the same declaration keeps focus.
  const named = status({ slots: {}, capabilities: [{ name: 'nw-chat', from: 'here', off: false }] });
  u.render(named, { rows: ROWS });
  addCells(u)[0].focus();
  assert.equal(repaint(named, { rows: [...ROWS, CHAT] }), true);
  assert.equal(u.doc.activeElement, slotCells(u)[1], 'now the Messaging cell');
  // One entry, then two (a named default of that layer joins the slot's): focus stays on the slot declaration.
  const slotOnly = status({ slots: { messaging: { name: 'oats.aweb', from: 'package' } }, capabilities: [] });
  u.render(slotOnly, { rows: [...ROWS, CHAT] });
  slotCells(u)[1].focus();
  assert.equal(repaint(status({ ...slotOnly.defaults, capabilities: [{ name: 'nw-chat', from: 'here', off: false }] }), { rows: [...ROWS, CHAT] }), true);
  assert.equal(u.doc.activeElement.textContent.startsWith('oats.aweb'), true, 'the slot\'s own entry');
  // The same name declared in the slot (one repository) and by name (another): each keeps its own focus.
  const twice = status({ slots: { messaging: { name: 'nw-chat', from: HOST } }, capabilities: [{ name: 'nw-chat', from: MKT, off: false }] });
  u.render(twice, { rows: [...ROWS, CHAT, CHAT2] });
  const second = () => [...slotCells(u)[1].querySelectorAll('button.ws-default-entry')][1];
  assert.notEqual(second().dataset.focusKey, [...slotCells(u)[1].querySelectorAll('button.ws-default-entry')][0].dataset.focusKey, 'two declarations, two keys');
  second().focus();
  assert.equal(repaint(twice, { rows: [...ROWS, CHAT, CHAT2] }), true);
  assert.equal(u.doc.activeElement, second()); assert.equal(text(u.doc.activeElement), 'nw-chat marketing latest');
  u.doc.activeElement.click(); assert.equal(u.opened.at(-1), CHAT2);
});

test('an unlisted package default never presents the capability as its package: the chip names the kind alone', t => {
  const u = mount(t);
  // oats.core is listed nowhere here (its package, oats.framework, is not locked yet): the id says nothing about the package.
  u.render(status({ slots: { knowledge: { name: 'oats.okf', from: 'package' } }, capabilities: [{ name: 'oats.core', from: 'package', off: false }] }), { rows: ROWS.filter(r => r.name !== 'oats.core' && r.name !== 'oats.okf') });
  const extra = () => addCells(u)[0];
  for (const owner of [slotCells(u)[0], extra()]) {
    const chip = owner.querySelector('.source-chip');
    assert.equal(chip.querySelector('.source-chip-name').textContent, 'package');
    assert.equal(chip.querySelector('.source-chip-version'), null);
    assert.equal(chip.title, 'A locked package; not in the workspace’s capability list');
    assert.equal(chip.querySelector('svg').innerHTML, iconElement(u.doc, 'package', { size: 13 }).innerHTML, 'the package icon');
  }
  assert.equal(text(extra()), 'oats.core package', 'the id once, never as a package name');
  assert.equal(extra().getAttribute('aria-label'), 'oats.core, from a package, a workspace default — open its page');
  assert.equal(extra().querySelector('.ws-default-tile svg').innerHTML, drawn(u, 'package'));
  extra().click();
  assert.deepEqual(u.opened.at(-1), { name: 'oats.core', kind: 'package' }, 'the page still opens, with no package claimed');
});

test('empty state: no slot and no capability (a standalone deployment too): the scope line alone', t => {
  const u = mount(t);
  u.render(status({ slots: { knowledge: null, messaging: 'none', tasks: null }, capabilities: [] }));
  assert.equal(text(u.$('.ws-defaults-scope')), 'northwind sets no defaults. Each soul chooses all of its own capabilities.');
  assert.equal(u.$('.ws-defaults-sub').textContent, 'Each soul chooses all of its own capabilities.');
  assert.equal(u.$('.ws-defaults-group'), null, 'no groups');
  assert.equal(u.$('[data-jump=defaults]'), null, 'never a segment');
  // No workspace name: "this workspace". A name with markup is text, never HTML.
  u.render(status({ slots: {}, capabilities: [] }, { key: HOST }));
  assert.equal(text(u.$('.ws-defaults-scope')), 'this workspace sets no defaults. Each soul chooses all of its own capabilities.');
  u.render(status(MIXED, { key: HOST, name: '<img src=x onerror=alert(1)>' }));
  assert.equal(u.$('.ws-defaults-ws').textContent, '<img src=x onerror=alert(1)>'); assert.equal(u.$('.ws-defaults-panel img'), null);
});

test('without reported defaults: no section and no Defaults segment, nothing inferred', t => {
  const u = mount(t);
  u.render(status(undefined));
  assert.equal(u.$('[data-section=defaults]'), null); assert.equal(u.$('[data-jump=defaults]'), null);
  assert.equal(u.$('.capability-nav [aria-current]').dataset.jump, 'workspace', 'Workspace owned is current, as before');
});

// The Capabilities tab in two parts (the product owner, 2026-10-23): Workspace defaults, a part of its own, then All
// capabilities, whose segmented nav (Workspace owned | Repo owned | Packages, no Defaults) sits under its title and
// whose sections are its h3 subsections. The scroll sync tracks those sections only.
test('two parts: Workspace defaults first, then All capabilities with its segments under its title; no Defaults segment', t => {
  const u = mount(t);
  u.render(status(FULL));
  const sections = u.$('.sections');
  assert.deepEqual([...sections.children].map(el => [el.tagName, el.className, el.dataset.section ?? null]),
    [['SECTION', 'capability-section', 'defaults'], ['SECTION', 'capability-part', null]], 'the defaults, then All capabilities');
  const defaultsHead = u.$('#capability-section-defaults');
  assert.equal(defaultsHead.tagName, 'H2'); assert.ok(defaultsHead.classList.contains('capability-part-title'), 'titled as a part');
  const all = u.$('.sections > .capability-part'), title = all.firstElementChild;
  assert.deepEqual([title.tagName, title.id, title.className, title.textContent], ['H2', 'capability-part-all', 'capability-part-title', 'All capabilities']);
  assert.equal(all.getAttribute('aria-labelledby'), 'capability-part-all');
  assert.equal(title.nextElementSibling, u.$('.capability-nav'), 'the segments right under its title');
  assert.equal(u.$('.lead .capability-nav'), null, 'not in the toolbar');
  assert.equal(u.$$('.capability-nav').length, 1);
  const jumps = u.$$('.capability-nav button');
  assert.deepEqual(jumps.map(b => [b.dataset.jump, b.firstChild.textContent, b.querySelector('.capability-nav-count').textContent, b.getAttribute('aria-current')]),
    [['workspace', 'Workspace owned', '3', 'true'], ['packages', 'Packages', '3', null]], 'Workspace owned is the initial current one');
  // Its sections are its subsections (h3), in the segments' order.
  assert.deepEqual([...all.querySelectorAll(':scope > .capability-section')].map(el => [el.dataset.section, el.querySelector('.capability-section-title').tagName]),
    [['workspace', 'H3'], ['packages', 'H3']]);
  for (const head of all.querySelectorAll('.capability-section-title')) assert.equal(head.classList.contains('capability-part-title'), false, `${head.id}: a subsection's title`);
  jumps[1].click();
  assert.equal(u.doc.activeElement, u.$('#capability-section-packages')); assert.equal(jumps[1].getAttribute('aria-current'), 'true');
  jumps[0].click();
  assert.equal(u.doc.activeElement, u.$('#capability-section-workspace'));
  // Scroll sync tracks All capabilities' sections only: the defaults above them never make a segment current.
  const tops = { defaults: -300, workspace: 200, packages: 400 };
  for (const el of u.$$('.capability-section')) el.getBoundingClientRect = () => ({ top: tops[el.dataset.section] });
  const scroller = { getBoundingClientRect: () => ({ top: 0 }) };
  syncCapabilityNav(u.$('.sections'), scroller, u.$('.lead'));
  assert.equal(u.$('.capability-nav [aria-current]').dataset.jump, 'workspace', 'with only the defaults scrolled past, the first section');
  tops.workspace = -100; tops.packages = 10;
  syncCapabilityNav(u.$('.sections'), scroller, u.$('.lead'));
  assert.equal(u.$('.capability-nav [aria-current]').dataset.jump, 'packages');
  // Without a pinned toolbar the top is the scroller's own.
  tops.packages = 400; syncCapabilityNav(u.$('.sections'), scroller);
  assert.equal(u.$('.capability-nav [aria-current]').dataset.jump, 'workspace');
  // Pinned (spec G), the toolbar's bottom edge is the top: a section under it is not in view.
  tops.workspace = 200; tops.packages = 380;
  const toolbar = u.$('.toolbar'); toolbar.classList.add('ws-sticky'); toolbar.getBoundingClientRect = () => ({ top: 0, bottom: 360 });
  syncCapabilityNav(u.$('.sections'), scroller, u.$('.lead'));
  assert.equal(u.$('.capability-nav [aria-current]').dataset.jump, 'packages', 'the section under the pinned toolbar is past');
  syncCapabilityNav(u.$('.sections'), scroller);
  assert.equal(u.$('.capability-nav [aria-current]').dataset.jump, 'workspace', 'measured from the scroller, Workspace owned is still in view');
});

test('without reported defaults All capabilities is the page\'s one part', t => {
  const u = mount(t);
  u.render(status(undefined));
  assert.deepEqual([...u.$('.sections').children].map(el => el.className), ['capability-part']);
  assert.equal(u.$('.capability-part > h2').textContent, 'All capabilities');
  // No space above it then; after the defaults, its 32px.
  const style = u.doc.createElement('style'); style.textContent = catalogCSS; u.doc.head.append(style);
  assert.equal(u.dom.window.getComputedStyle(u.$('.capability-part')).marginTop, '0px');
  u.render(status(FULL));
  assert.equal(u.dom.window.getComputedStyle(u.$('.capability-part')).marginTop, '32px');
});

test('the parts\' titles: larger than the sections\' (18px at 700 over 15px at 650), in --fg; the segments their own width', () => {
  const rule = selector => catalogCSS.match(new RegExp(`^${selector.replace(/[.()]/g, m => `\\${m}`)} \\{([^}]*)\\}`, 'm'))?.[1] ?? '';
  assert.match(rule('.capability-part-title, .capability-section-title.capability-part-title'), /color:var\(--fg\); font-size:18px; font-weight:700;/);
  assert.match(rule('.capability-section-title'), /color:var\(--fg\); font-size:15px; font-weight:650;/);
  assert.match(rule('.capability-part > .capability-nav'), /align-self:flex-start;/);
  assert.match(rule('.capability-part'), /display:flex; flex-direction:column; gap:14px; margin-top:32px;/, 'after the defaults');
  assert.match(rule('.capability-part:first-child'), /^ ?margin-top:0; ?$/, 'first, with no defaults reported: no space above it');
});

test('search and the repository pills never narrow the defaults', t => {
  const u = mount(t);
  u.render(status(FULL), { query: 'no-such-capability', shown: [] });
  assert.equal(slotCells(u).length, 3); assert.equal(addCells(u).length, 3);
  assert.equal(u.$('[data-jump=defaults]'), null);
  assert.equal(slotCells(u)[0].querySelector('.source-chip-version').textContent, '2.1.3', 'matched against every catalog row, not the filtered ones');
});

test('a catalog with no rows still says what every soul gets, with no section jump', t => {
  const u = mount(t);
  u.render(status(MIXED), { rows: [] });
  assert.deepEqual(u.$$('.capability-section').map(el => el.dataset.section), ['defaults']);
  assert.equal(u.$('.capability-nav'), null);
  assert.ok(u.$('.catalog-empty'), 'the catalog\'s own empty line follows');
  assert.equal(slotCells(u)[0].querySelector('.source-chip-version'), null, 'nothing listed: no version');
});

test('the panel\'s look: one --surface panel, two headed groups of one 3-column cell grid, 24px tiles, rules in --tag-bg, stacking below 700px', () => {
  assert.match(defaultsCSS, /\.ws-defaults-panel \{ background:var\(--surface\); border:1px solid var\(--border\); border-radius:10px;/);
  assert.match(defaultsCSS, /\.ws-defaults-group \+ \.ws-defaults-group \{ border-top:1px solid var\(--border\); \}/);
  assert.match(defaultsCSS, /\.ws-defaults-group-head \{[^}]*padding:12px 18px 0; color:var\(--fg\); font-size:12\.5px; font-weight:650; \}/);
  assert.match(defaultsCSS, /\.ws-defaults-group-lead \{ color:var\(--muted\); font-size:12px; font-weight:400; \}/);
  assert.match(defaultsCSS, /\.ws-defaults-cells \{ display:grid; grid-template-columns:repeat\(3, minmax\(0,1fr\)\); margin:0; padding:6px 0 4px;/);
  assert.match(defaultsCSS, /\.ws-defaults-cells > li \{[^}]*border-left:1px solid var\(--tag-bg\)/);
  assert.match(defaultsCSS, /\.ws-defaults-cells > li:nth-child\(3n\+1\) \{ border-left:0; \}/);
  assert.match(defaultsCSS, /@container \(max-width:700px\) \{\n \.ws-defaults-cells \{ grid-template-columns:minmax\(0,1fr\); \}/);
  assert.match(defaultsCSS, /\.ws-defaults-none \{ margin:0; padding:8px 18px 14px; color:var\(--muted\); font-size:12px; \}/);
  assert.match(defaultsCSS, /\.oats-view \.ws-default-cell, \.ws-default-cell \{[^}]*display:grid; grid-template-columns:24px minmax\(0,1fr\); column-gap:12px;[^}]*padding:10px 18px 12px;/);
  assert.match(defaultsCSS, /\.ws-default-tile \{[^}]*width:24px; height:24px; border-radius:6px; background:var\(--chip-bg\); color:var\(--chip-fg\); \}/);
  assert.match(defaultsCSS, /\.ws-default-tile\[data-tint=clay\] \{ background:var\(--soul-clay-bg\); color:var\(--soul-clay-fg\); \}/);
  assert.match(defaultsCSS, /\.ws-default-label \{ height:24px; color:var\(--muted\); font-weight:600; font-size:12px; font-family:var\(--ui-font,system-ui\); line-height:24px; \}/);
  assert.doesNotMatch(defaultsCSS, /uppercase|dashed/);
  assert.match(defaultsCSS, /\.ws-default-name \{[^}]*font-weight:650; font-size:14px; font-family:var\(--mono,monospace\); line-height:24px;/);
  assert.match(defaultsCSS, /\.ws-default-none \{ color:var\(--muted\); font-weight:500; font-size:14px;/);
  assert.match(defaultsCSS, /\.ws-default-cell\.off \.ws-default-name \{ color:var\(--muted\); text-decoration:line-through; \}/);
  assert.match(defaultsCSS, /\.oats-view button\.ws-default-cell:focus-visible \{ background:var\(--sel\); \}/, 'keyboard focus keeps the shell tint');
  assert.deepEqual([DEFAULTS_COPY.core, DEFAULTS_COPY.coreLead, DEFAULTS_COPY.additional, DEFAULTS_COPY.additionalLead, DEFAULTS_COPY.additionalNone],
    ['Core capabilities', 'at most one of each per soul', 'Additional capabilities', 'any number per soul', 'None. Each soul adds its own.']);
});

function about(t) {
  const u = mount(t);
  const dialog = createAboutDialog(u.doc, { copy: ABOUT_COPY.capabilities, id: 'workspace-capabilities-about' });
  u.$('.lead').append(dialog.button);
  t.after(() => dialog.dispose());
  return { ...u, dialog, overlay: () => u.$('.palette-overlay.lifecycle-overlay'), close: () => u.$('.about-dialog .lifecycle-close') };
}

test('the "i": a 28px round icon button, "About capabilities", aria-haspopup=dialog', t => {
  const u = about(t);
  const b = u.dialog.button;
  assert.equal(b.tagName, 'BUTTON'); assert.equal(b.type, 'button');
  assert.equal(b.getAttribute('aria-label'), 'About capabilities'); assert.equal(b.title, 'About capabilities'); assert.equal(b.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(b.querySelector('svg').getAttribute('width'), '15');
  assert.match(aboutCSS, /\.oats-view button\.ws-info-button \{[^}]*width:28px; height:28px;[^}]*border-radius:50%;/);
  assert.equal(u.overlay(), null, 'closed until pressed');
});

test('About capabilities: the lifecycle frame, labelled by its title, the exact copy, focus on Close', t => {
  const u = about(t);
  u.dialog.button.focus(); u.dialog.button.click();
  const overlay = u.overlay(), dialog = overlay.querySelector('section.lifecycle-dialog.about-dialog');
  assert.ok(dialog);
  assert.equal(dialog.getAttribute('role'), 'dialog'); assert.equal(dialog.getAttribute('aria-modal'), 'true');
  const title = u.doc.getElementById(dialog.getAttribute('aria-labelledby'));
  assert.equal(title.tagName, 'H2'); assert.equal(title.textContent, 'What capabilities are');
  assert.equal(dialog.querySelector('.lifecycle-heading .lifecycle-mark').getAttribute('aria-hidden'), 'true');
  assert.ok(dialog.querySelector('.lifecycle-mark svg'));
  const paragraphs = [...dialog.querySelectorAll(':scope > p')].map(p => p.textContent);
  assert.deepEqual(paragraphs, [
    'A capability is a reusable bundle of skills, commands and instructions, given to every soul whose work needs it.',
    'A soul names the capabilities it needs. When an instance starts, it gets a copy of each one, and the capability’s instructions are injected into the instance’s composed AGENTS.md, after the soul’s own.',
    'Each capability comes from one of three places:',
    'Three capabilities are core: knowledge (what an instance knows and learns), messaging (who it can talk to) and tasks (where its work is tracked). A soul has at most one of each. Every other capability is additional: a soul can have any number.',
    'Workspace defaults are capabilities the workspace gives to every soul. They are how an organisation gives its agents one shared way of working: the same tools for knowledge, messaging and tasks. Knowledge matters most: with a knowledge capability, what agents learn and the procedures the organisation writes down are kept and reach later instances, instead of ending with each session. A soul gets the defaults without asking. It can turn a default off and name its own in its place, or leave a core capability (knowledge, messaging or tasks) empty.',
  ]);
  assert.equal(dialog.querySelector('p code').textContent, 'AGENTS.md');
  assert.equal(dialog.querySelector('p strong').textContent, 'Workspace defaults');
  const terms = [...dialog.querySelectorAll('dl.about-terms dt')].map(dt => [dt.textContent, dt.nextElementSibling.tagName, dt.nextElementSibling.textContent, !!dt.querySelector('svg')]);
  assert.deepEqual(terms, [
    ['Workspace owned', 'DD', 'Defined in one of the workspace’s repos. Any soul can use it, always at that repo’s latest version.', true],
    ['Repo owned', 'DD', 'Defined in one repo and kept to it. Only souls from that same repo can use it.', true],
    ['Packages', 'DD', 'Installed into the workspace at a pinned version, the same on every machine.', true],
  ]);
  assert.deepEqual([...dialog.querySelectorAll('button')].map(b => [b.textContent, b.className]), [['Close', 'lifecycle-close']]);
  assert.equal(u.doc.activeElement, u.close(), 'opening focuses Close');
  assert.match(aboutCSS, /\.lifecycle-dialog\.about-dialog \{ width:min\(520px, calc\(100vw - 32px\)\); font-size:13px; \}/);
  assert.match(aboutCSS, /\.about-dialog \.lifecycle-mark \{ color:var\(--accent\); \}/);
});

test('About capabilities: Tab and Shift+Tab stay on Close; Escape and Close close it and focus returns to the "i"', t => {
  const u = about(t);
  u.dialog.button.focus(); u.dialog.button.click();
  u.key(u.close(), 'Tab'); assert.equal(u.doc.activeElement, u.close());
  u.key(u.close(), 'Tab', { shiftKey: true }); assert.equal(u.doc.activeElement, u.close());
  let outside = 0; u.doc.body.addEventListener('keydown', e => { if (e.key === 'Escape') outside++; });
  u.key(u.close(), 'Escape');
  assert.equal(u.overlay(), null); assert.equal(outside, 0, 'Escape is the dialog\'s: it does not reach the page');
  assert.equal(u.doc.activeElement, u.dialog.button, 'focus back on the "i"');
  u.dialog.button.click(); u.close().click();
  assert.equal(u.overlay(), null); assert.equal(u.doc.activeElement, u.dialog.button);
  // A scrim click does nothing (as the lifecycle and Forget dialogs).
  u.dialog.button.click(); u.overlay().dispatchEvent(new u.dom.window.MouseEvent('click', { bubbles: true }));
  assert.ok(u.overlay(), 'still open');
});

test('About capabilities: leaving the tab or the workspace closes it without moving focus; another modal dismisses it', t => {
  const u = about(t);
  const other = u.doc.createElement('input'); u.doc.body.append(other);
  u.dialog.button.focus(); u.dialog.button.click();
  other.focus(); u.dialog.close({ focus: 'none' });
  assert.equal(u.overlay(), null); assert.equal(u.doc.activeElement, other, 'focus stays where it is');
  // A dialog opening through the shared handoff (takePickerFocusReturn) dismisses it and inherits its opener: the "i".
  u.dialog.button.focus(); u.dialog.button.click();
  const opener = takePickerFocusReturn(u.doc);
  assert.equal(u.overlay(), null, 'dismissed'); assert.equal(u.doc.activeElement, u.doc.body, 'no focus return of its own');
  assert.equal(opener.resolve(), u.dialog.button, 'the replacement returns focus to the "i"');
  // Any other aria-modal taking focus closes it too.
  u.dialog.button.click();
  const modal = u.doc.createElement('div'); modal.setAttribute('aria-modal', 'true'); const field = u.doc.createElement('input'); modal.append(field); u.doc.body.append(modal);
  field.focus();
  assert.equal(u.overlay(), null); assert.equal(u.doc.activeElement, field);
});

test('About souls is gone (the Desktop UI rework, slice 3a): one copy object, the capabilities\' only', () => {
  assert.deepEqual(Object.keys(ABOUT_COPY), ['capabilities']);
  assert.ok(Object.isFrozen(ABOUT_COPY) && Object.isFrozen(ABOUT_COPY.capabilities), 'one frozen copy object');
});
  t.after(() => souls.dispose());
  u.$('.lead').append(souls.button);
  assert.equal(souls.button.getAttribute('aria-label'), 'About souls');
  souls.button.focus(); souls.button.click();
  const dialog = u.$('.about-dialog');
  assert.equal(u.doc.getElementById(dialog.getAttribute('aria-labelledby')).textContent, ABOUT_COPY.souls.title);
  assert.equal(u.doc.activeElement, dialog.querySelector('.lifecycle-close'));
  assert.equal(ABOUT_COPY.souls.title, 'What a soul is');
  assert.deepEqual([...dialog.querySelectorAll(':scope > p')].map(p => p.textContent), [
    'A soul defines a kind of agent: the work it specialises in, and the capabilities it gets to do that work.',
    'A team organises its specialist agents as souls, and souls can also organise knowledge: what each one is responsible for knowing, and what it reads to get started. Each running agent is an instance of a soul. Every instance gets the workspace’s default capabilities first, then the soul’s own choices: a soul can add capabilities, turn a default off, or leave a core capability (knowledge, messaging or tasks) empty.',
  ]);
  assert.equal(dialog.querySelector('dl'), null, 'no term list');
  assert.ok(Object.isFrozen(ABOUT_COPY) && Object.isFrozen(ABOUT_COPY.souls) && Object.isFrozen(ABOUT_COPY.capabilities), 'one frozen copy object');
  u.key(u.doc.activeElement, 'Escape'); assert.equal(u.doc.activeElement, souls.button);
});
