// Workspace › Capabilities says the workspace's defaults in one sentence above its one list, each default a tag on its
// row (renderer/workspace-defaults.mjs; the Desktop UI rework, slice 3b, which replaces the Core / Additional panel of
// workspace-defaults-show-scope-and-purpose with Joan's design), and its "i" opens "About capabilities"
// (renderer/about-dialog.mjs, shared with Workspace › Souls). Facts only from `oats workspace status --json`
// `defaults` and the catalog rows: without a reported `defaults` nothing is shown. jsdom; no CLI, server or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderCapabilityList, catalogCSS } from '../renderer/workspace-catalog.mjs';
import { defaultsLead, defaultsCSS, DEFAULTS_COPY } from '../renderer/workspace-defaults.mjs';
import { ABOUT_COPY, aboutCSS, createAboutDialog } from '../renderer/about-dialog.mjs';
import { takePickerFocusReturn } from '../renderer/overlay-picker.mjs';

const HOST = 'github.com/nw/agents', MKT = 'github.com/nw/marketing';
const ROWS = [
  { name: 'oats.okf', kind: 'package', package: 'oats.okf', version: '2.1.3', layer: 'knowledge' },
  { name: 'oats.aweb', kind: 'package', package: 'oats.aweb', version: '1.28.0', layer: 'messaging' },
  { name: 'oats.core', kind: 'package', package: 'oats.framework', version: '1.11.0' },
  { name: 'nw-house-style', kind: 'member', repoKey: HOST },
  { name: 'nw-brand-voice', kind: 'member', repoKey: MKT },
  // The same name in another repository: matching never takes it for the host's.
  { name: 'nw-tasks', kind: 'member', repoKey: MKT, layer: 'tasks' },
];
const MEMBERS = [{ key: HOST, name: 'agents', status: 'confirmed' }, { key: MKT, name: 'marketing', status: 'confirmed' }];
const status = (defaults, workspace = { key: HOST, name: 'northwind' }) => ({ workspace, members: MEMBERS, ...(defaults === undefined ? {} : { defaults }) });
const FULL = {
  slots: { knowledge: { name: 'oats.okf', from: 'package' }, messaging: { name: 'oats.aweb', from: 'package' }, tasks: { name: 'nw-tasks', from: MKT } },
  capabilities: [{ name: 'oats.core', from: 'package', off: false }, { name: 'nw-brand-voice', from: MKT, off: false }, { name: 'nw-house-style', from: null, off: true }],
};

function mount(t) {
  const dom = new JSDOM('<!doctype html><html data-theme="light"><body><main class="oats-view"><div class="toolbar"><div class="lead"></div></div><div class="sections"></div></main></body></html>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const style = doc.createElement('style'); style.textContent = catalogCSS + defaultsCSS + aboutCSS; doc.head.append(style);
  const $ = sel => doc.querySelector(sel), $$ = sel => [...doc.querySelectorAll(sel)];
  const opened = [];
  const render = (st, { rows = ROWS, query = '' } = {}) => renderCapabilityList($('.sections'), { rows, status: st, query, onOpen: row => opened.push(row) });
  const key = (el, name, init = {}) => el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }));
  return { dom, doc, $, $$, opened, render, key };
}
const tags = u => Object.fromEntries(u.$$('.cap-row').map(row => [row.dataset.capability, [...row.querySelectorAll('.cap-tag')].map(tag => tag.textContent)]));

test('every default is a tag on its own row, matched by name and source; one turned off says so; core is a tag too', t => {
  const u = mount(t);
  u.render(status(FULL));
  assert.deepEqual(tags(u), {
    'oats.okf': ['core', 'default'], 'oats.aweb': ['core', 'default'], 'nw-tasks': ['core', 'default'],
    'nw-brand-voice': ['default'], 'nw-house-style': ['default · off'], 'oats.core': ['default'],
  });
  assert.equal(u.$('[data-capability="nw-house-style"] [data-tag=default-off]').title, DEFAULTS_COPY.offTitle);
  assert.equal(u.$('[data-capability="oats.core"] [data-tag=default]').title, DEFAULTS_COPY.tagTitle);
  // A default from the host ("here") is not the same name in another member.
  u.render(status({ slots: { tasks: { name: 'nw-tasks', from: 'here' } }, capabilities: [] }));
  assert.deepEqual(tags(u)['nw-tasks'], ['core']);
  // Every default is a row that opens its page.
  u.$('[data-capability="oats.okf"]').click();
  assert.equal(u.opened.at(-1).name, 'oats.okf');
});

test('the sentence says what defaults are, with the purpose wording: shared working, nothing compulsory', t => {
  const u = mount(t);
  u.render(status(FULL));
  assert.equal(u.$('.cap-lead').textContent, 'Capabilities tagged default are the ones northwind gives every soul, so your agents share one way of working. A soul can turn a default off and choose its own instead.');
  assert.equal(u.$('.cap-lead b').textContent, 'default');
  assert.equal(u.$('.cap-lead .cap-lead-name').textContent, 'northwind');
  // The About dialog keeps the whole purpose (knowledge first, nothing automatic): the sentence never contradicts it.
  const purpose = ABOUT_COPY.capabilities.body.map(part => (part.p || []).map(x => typeof x === 'string' ? x : x.strong ?? x.code ?? '').join('')).join(' ');
  assert.match(purpose, /one shared way of working/);
  assert.match(purpose, /It can turn a default off/);
});

test('the sentence names what no row can show: empty core slots, unlisted defaults; none set; nothing reported', t => {
  const u = mount(t);
  u.render(status({ slots: { knowledge: { name: 'oats.okf', from: 'package' }, messaging: 'none', tasks: null }, capabilities: [{ name: 'gone', from: 'package' }, { name: 'nowhere', off: true }] }));
  assert.equal(u.$('.cap-lead').textContent, 'Capabilities tagged default are the ones northwind gives every soul, so your agents share one way of working. A soul can turn a default off and choose its own instead. No default for messaging and tasks. Also a default, but not in this list: gone. Turned off by the workspace, and not in this list: nowhere.');
  // A core capability named under defaults.capabilities fills its slot: no "No default for" it.
  u.render(status({ slots: { knowledge: null, messaging: 'none', tasks: null }, capabilities: [{ name: 'oats.aweb', from: 'package' }] }));
  assert.match(u.$('.cap-lead').textContent, /No default for knowledge and tasks\.$/);
  u.render(status({ slots: { knowledge: null, messaging: null, tasks: null }, capabilities: [] }, { key: HOST }));
  assert.equal(u.$('.cap-lead').textContent, 'This workspace sets no defaults: each soul chooses all of its own capabilities.');
  u.render(status(undefined));
  assert.equal(u.$('.cap-lead'), null, 'no reported defaults: nothing inferred');
  assert.equal(defaultsLead(u.doc, { status: null, rows: ROWS }), null);
});

test('search never narrows the sentence; a catalog with no rows still says what every soul gets', t => {
  const u = mount(t);
  u.render(status(FULL), { query: 'okf' });
  assert.deepEqual(u.$$('.cap-row').map(r => r.dataset.capability), ['oats.okf']);
  assert.match(u.$('.cap-lead').textContent, /^Capabilities tagged default/);
  u.render(status(FULL), { rows: [] });
  assert.match(u.$('.cap-lead').textContent, /Also a default, but not in this list: oats\.okf, oats\.aweb, nw-tasks, oats\.core and nw-brand-voice\. Turned off by the workspace, and not in this list: nw-house-style\.$/);
});

test('the sentence\'s look: one muted paragraph at a readable width, its tag word and the workspace in --fg', () => {
  assert.match(defaultsCSS, /\.cap-lead \{ margin:0 0 14px; max-width:80ch; color:var\(--muted\); font-size:13px; line-height:1\.55; \}/);
  assert.match(defaultsCSS, /\.cap-lead b \{ color:var\(--fg\); font-weight:600; \}/);
  assert.doesNotMatch(defaultsCSS, /ws-defaults|ws-default-/, 'the Core / Additional panel is gone');
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

test('About souls: the same dialog with its own button and copy', t => {
  const u = mount(t);
  const souls = createAboutDialog(u.doc, { copy: ABOUT_COPY.souls, id: 'workspace-souls-about' });
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
