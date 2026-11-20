import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { compositionEntries, coreEntries, coreNote, whyTag, whyFact, renderSoulCapabilities, renderSoulCore, renderCapabilityPage } from '../renderer/capability-page.mjs';
import { desktopFacts } from '../../client/soul-facts.mjs';
import { capabilityRow } from '../renderer/workspace-catalog.mjs';

// Kernel #217 (feature desktop-facts): the soul page says why each capability is there from
// `capabilities[].composedFrom` and `capabilitiesOff[]`, never from a guess. The f7 capture
// predates #217, so the two facts are added here in the documented shape (docs/desktop-cli-api.md
// § "Desktop facts").
const inspected = () => JSON.parse(readFileSync(new URL('./fixtures/workspace-v2/f7/inspect-soul.json', import.meta.url), 'utf8')).result;
function withFacts() {
  const v = inspected(), from = { 'nw-deploy': 'team:engineering', 'nw-house-style': 'workspace', 'nw-release-tooling': 'soul', 'nw.teams': 'workspace', 'oats.core': 'workspace', 'oats.okf': 'workspace' };
  for (const cap of v.capabilities) cap.composedFrom = from[cap.id];
  v.capabilitiesOff = [{ id: 'acme-lint', off: true, from: 'soul', reason: 'off', overrides: 'team:engineering' },
    { id: 'nw.tasks', off: true, from: 'soul', reason: 'slot-none', slot: 'tasks', overrides: 'workspace' }];
  return v;
}
const view = entries => entries.map(e => [e.cap?.id ?? e.name, e.why, ...(e.team ? [e.team] : [])]);

test('the gate: desktop facts are read only from a CLI that reports them', () => {
  assert.equal(desktopFacts({ features: ['desktop-facts'] }), true);
  assert.equal(desktopFacts({ features: ['layers-from'] }), false); assert.equal(desktopFacts(null), false);
});

test("with the facts, the kernel's composedFrom and capabilitiesOff say why, in layer order", () => {
  assert.deepEqual(view(compositionEntries(withFacts(), null, { facts: true })), [
    ['nw-house-style', 'workspace'], ['oats.core', 'workspace'], ['nw-deploy', 'team', 'engineering'], ['nw-release-tooling', 'soul'],
    ['acme-lint', 'off']], 'core capabilities (knowledge, messaging) and the emptied tasks slot are the Core section\'s');
  const off = compositionEntries(withFacts(), null, { facts: true }).filter(e => e.why === 'off');
  assert.deepEqual(off.map(whyTag), [['turned off by soul', "This soul turns off the engineering team's default", true]]);
  // The emptied slot is a core fact: Core's tasks row, with the same off note and its title.
  const tasks = coreEntries(withFacts(), { layersFrom: true, facts: true })[2];
  assert.deepEqual([tasks.slot, tasks.id, tasks.why, tasks.name], ['tasks', null, 'off', 'nw.tasks']);
  assert.deepEqual(whyTag(tasks), ['turned off by soul', 'This soul empties the tasks slot, which the workspace default filled with nw.tasks', true]);
  assert.deepEqual(whyTag({ why: 'team', team: 'engineering' }), ['team · engineering', 'A default of the engineering team', false]);
});

test('without the feature, or on an instance (composedFrom null), the page keeps reading the declarations', () => {
  assert.ok(compositionEntries(withFacts(), null, { facts: false }).every(e => e.why === 'default'), 'an older CLI: nothing is claimed');
  const home = withFacts(); for (const cap of home.capabilities) cap.composedFrom = null; home.capabilitiesOff = [];
  assert.ok(compositionEntries(home, null, { facts: true }).every(e => e.why === 'default'));
});

test('the soul table shows the tags with their reasons as titles', () => {
  const dom = new JSDOM('<!doctype html><body><div class="soul"></div></body>'), host = dom.window.document.querySelector('.soul');
  try {
    renderSoulCapabilities(host, { status: null, entries: compositionEntries(withFacts(), null, { facts: true }) });
    const rows = [...host.querySelectorAll('.soul-cap-row:not(.head)')].map(r => [r.dataset.capability, r.querySelector('.why-tag, .why-note').textContent, r.querySelector('.why-tag, .why-note').title]);
    assert.deepEqual(rows.map(r => r.slice(0, 2)), [['nw-house-style', 'workspace'], ['oats.core', 'workspace'], ['nw-deploy', 'team · engineering'],
      ['nw-release-tooling', 'soul'], ['acme-lint', 'turned off by soul']]);
    assert.match(rows.at(-1)[2], /turns off the engineering team's default/);
    assert.equal(host.querySelector('[data-capability="nw.tasks"]'), null, 'the emptied slot is not a Capabilities row');
  } finally { dom.window.close(); }
});

// Spec A (core capabilities and capabilities as one system): the Core capabilities table, the same grid,
// row grammar, source chip and why tag as the Capabilities table.
const layered = (layers, extra = {}) => { const v = withFacts(); v.layers = layers; return Object.assign(v, extra); };
const render = (fn, options) => {
  const dom = new JSDOM('<!doctype html><body><div class="host"></div></body>'), host = dom.window.document.querySelector('.host');
  fn(host, options); return { dom, host };
};
const coreRow = (host, slot) => host.querySelector(`.soul-cap-row[data-layer="${slot}"]`);
const whyOf = row => { const tag = row.querySelector('.why-tag, .why-note'); return tag ? [tag.textContent, tag.title, tag.className] : null; };

test('Core rows say why in the Capabilities grammar: workspace, team, soul, emptied by the soul, no default', () => {
  const v = layered({ knowledge: { id: null, from: null }, messaging: { id: 'oats.aweb', from: 'workspace' }, tasks: { id: null, from: null } },
    { capabilitiesOff: [{ id: 'oats.okf', off: true, from: 'soul', reason: 'slot-none', slot: 'knowledge', overrides: 'workspace' }] });
  v.capabilities.find(c => c.id === 'oats.aweb').composedFrom = 'workspace';
  const entries = coreEntries(v, { layersFrom: true, facts: true });
  assert.deepEqual(entries.map(e => [e.slot, e.id, e.why]), [['knowledge', null, 'off'], ['messaging', 'oats.aweb', 'workspace'], ['tasks', null, 'none']]);
  const { dom, host } = render(renderSoulCore, { entries, status: null, onOpen() {} });
  try {
    const table = host.querySelector('.page-table.soul-caps.soul-core');
    assert.equal(table.getAttribute('role'), 'table'); assert.equal(table.getAttribute('aria-label'), 'Core capabilities');
    assert.deepEqual([...table.querySelectorAll('[role=columnheader]')].map(c => c.textContent), ['Core capability', 'Source', "Why it's here"]);
    assert.deepEqual([...table.querySelectorAll('.soul-cap-row:not(.head)')].map(r => r.dataset.layer), ['knowledge', 'messaging', 'tasks'], 'always the three slots, in order');
    for (const row of table.querySelectorAll('.soul-cap-row:not(.head)')) {
      assert.equal(row.getAttribute('role'), 'row'); assert.deepEqual([...row.children].map(c => c.getAttribute('role')), ['cell', 'cell', 'cell']);
    }
    const knowledge = coreRow(host, 'knowledge');
    assert.equal(knowledge.querySelector('.soul-cap-slot').textContent, 'Knowledge'); assert.equal(knowledge.querySelector('.soul-cap-id').textContent, 'None');
    assert.deepEqual(whyOf(knowledge), ['turned off by soul', 'This soul empties the knowledge slot, which the workspace default filled with oats.okf', 'why-note']);
    // The reason is visible row text, not only a title: what was turned off is named once, in the note.
    assert.equal(knowledge.querySelector('.soul-cap-why-note').textContent, 'This soul empties the knowledge slot; the workspace default is oats.okf');
    assert.equal(knowledge.querySelector('.soul-cap-name').textContent, 'KnowledgeNone', 'no second statement of the turned-off name');
    assert.match(knowledge.textContent, /This soul empties the knowledge slot; the workspace default is oats\.okf/);
    assert.equal(knowledge.localName, 'div', 'an empty slot does not open'); assert.equal(knowledge.querySelector('.source-chip'), null);
    const messaging = coreRow(host, 'messaging');
    assert.equal(messaging.localName, 'button'); assert.equal(messaging.dataset.focusKey, 'core:messaging'); assert.equal(messaging.dataset.capability, 'oats.aweb');
    assert.deepEqual(whyOf(messaging), ['workspace', 'A workspace default', 'why-tag']);
    assert.equal(messaging.querySelector('.soul-cap-why-note').textContent, "Resolves the workspace default: this soul doesn't choose a messaging capability", 'the note is row text');
    assert.ok(messaging.querySelector('.soul-cap-source .source-chip.boxed'), 'the Capabilities table\'s source chip');
    assert.equal(messaging.getAttribute('aria-label'), "Messaging: oats.aweb, Resolves the workspace default: this soul doesn't choose a messaging capability — open its page");
    const tasks = coreRow(host, 'tasks');
    assert.equal(tasks.querySelector('.soul-cap-id').textContent, 'None');
    assert.deepEqual(whyOf(tasks), ['No default', 'Neither this soul nor the workspace fills the tasks slot', 'why-note']);
    assert.equal(tasks.querySelector('.soul-cap-why-note').textContent, 'Neither this soul nor the workspace fills the tasks slot.');
  } finally { dom.window.close(); }
});

test('Core rows: a team default, the soul\'s own choice, a detail line; a filled row opens with its entry', () => {
  const v = layered({ knowledge: { id: 'oats.okf', from: 'soul' }, messaging: { id: 'oats.aweb', from: 'team:engineering' }, tasks: { id: null, from: null } });
  const entries = coreEntries(v, { layersFrom: true, facts: true }).map(e => ({ ...e, detail: e.slot === 'messaging' ? 'Default team · can join engineering' : null }));
  const opened = [];
  const { dom, host } = render(renderSoulCore, { entries, status: null, onOpen: entry => opened.push(entry) });
  try {
    const knowledge = coreRow(host, 'knowledge'), messaging = coreRow(host, 'messaging');
    assert.deepEqual(whyOf(knowledge), ['soul', 'Declared by this soul', 'why-tag soul']); assert.equal(knowledge.querySelector('.soul-cap-why-note'), null);
    assert.deepEqual(whyOf(messaging), ['team · engineering', 'A default of the engineering team', 'why-tag']);
    assert.equal(messaging.querySelector('.soul-cap-why-note').textContent, "Resolves the engineering team's default");
    assert.equal(messaging.querySelector('.soul-cap-note').textContent, 'Default team · can join engineering');
    assert.equal(messaging.getAttribute('aria-label'), "Messaging: oats.aweb, Default team · can join engineering, Resolves the engineering team's default — open its page");
    assert.equal(knowledge.getAttribute('aria-label'), 'Knowledge: oats.okf, Declared by this soul — open its page');
    messaging.click();
    assert.deepEqual(opened.map(e => [e.slot, e.id, e.cap?.id, e.why, e.team]), [['messaging', 'oats.aweb', 'oats.aweb', 'team', 'engineering']]);
  } finally { dom.window.close(); }
  assert.equal(coreNote({ why: 'team', team: 'eng' }, { spawned: true }), "Resolved the eng team's default at spawn");
  assert.equal(coreNote({ why: 'workspace', slot: 'tasks' }, { spawned: true }), 'Resolved the workspace default at spawn');
  // An emptied slot names the default it turned off, a team's in the overridden() wording; a home reports neither.
  assert.equal(coreNote({ why: 'off', slot: 'messaging', name: 'oats.aweb', overrides: 'team:oats' }), "This soul empties the messaging slot; the oats team's default is oats.aweb");
  assert.equal(coreNote({ why: 'off', slot: 'knowledge', name: 'oats.okf', overrides: 'workspace' }, { spawned: true }), null);
  assert.equal(coreNote({ why: 'none', slot: 'tasks' }, { spawned: true }), null);
});

test('Core: no reason without the features; a contradiction shows the provider; a missing provider row; layers not reported', () => {
  const v = layered({ knowledge: { id: 'oats.okf', from: 'workspace' }, messaging: { id: 'ghost.mail', from: 'workspace' }, tasks: { id: null, from: null } },
    { capabilitiesOff: [{ id: 'oats.okf', off: true, from: 'soul', reason: 'slot-none', slot: 'knowledge', overrides: 'workspace' },
      { id: 'nw.tasks', off: true, from: 'soul', reason: 'slot-none', slot: 'tasks', overrides: 'workspace' }] });
  assert.deepEqual(coreEntries(v).map(e => e.why), [null, null, null], 'neither feature: nothing is said');
  assert.deepEqual(coreEntries(v, { layersFrom: true }).map(e => e.why), ['workspace', 'workspace', null], 'without desktop-facts: no emptied slot and no "No default"');
  assert.deepEqual(coreEntries(v, { facts: true }).map(e => e.why), [null, null, 'off'], 'without layers-from: the kernel\'s off entry only');
  const both = coreEntries(v, { layersFrom: true, facts: true });
  assert.deepEqual(both.map(e => [e.id, e.why]), [['oats.okf', 'workspace'], ['ghost.mail', 'workspace'], [null, 'off']], 'a filled slot never takes an off entry');
  assert.ok(!compositionEntries(v, null, { facts: true }).some(e => e.name === 'oats.okf' || e.cap?.id === 'oats.okf'), 'nor does Capabilities show it');
  const { dom, host } = render(renderSoulCore, { entries: both, status: null, onOpen() {} });
  try {
    const ghost = coreRow(host, 'messaging');
    assert.equal(ghost.localName, 'div', 'no provider row: not openable'); assert.equal(ghost.querySelector('.soul-cap-id').textContent, 'ghost.mail');
    assert.equal(ghost.querySelector('.source-chip'), null);
  } finally { dom.window.close(); }
  const unreported = coreEntries({ capabilities: [] }, { layersFrom: true, facts: true });
  assert.deepEqual(unreported.map(e => [e.reported, e.why]), [[false, null], [false, null], [false, null]]);
  const r = render(renderSoulCore, { entries: unreported, status: null });
  try { assert.deepEqual([...r.host.querySelectorAll('.soul-cap-row:not(.head) .soul-cap-id')].map(n => n.textContent), ['Not reported', 'Not reported', 'Not reported']); } finally { r.dom.window.close(); }
  // A home: capabilitiesOff is always [], so an empty slot claims nothing.
  const home = layered({ knowledge: { id: null, from: null }, messaging: { id: null, from: null }, tasks: { id: null, from: null } }, { subject: { kind: 'instance' }, capabilitiesOff: [] });
  assert.deepEqual(coreEntries(home, { layersFrom: true, facts: true }).map(e => e.why), [null, null, null]);
});

test('every emptied-slot entry lands in exactly one section: all of a slot\'s in Core, one Core cannot place in Capabilities', () => {
  const empty = { knowledge: { id: null, from: null }, messaging: { id: null, from: null }, tasks: { id: null, from: null } };
  const two = layered(empty, { capabilitiesOff: [{ id: 'acme.notes', off: true, from: 'soul', reason: 'slot-none', slot: 'knowledge', overrides: 'workspace' },
    { id: 'oats.okf', off: true, from: 'soul', reason: 'slot-none', slot: 'knowledge', overrides: 'workspace' }] });
  const knowledge = coreEntries(two, { layersFrom: true, facts: true })[0];
  assert.deepEqual([knowledge.why, knowledge.names], ['off', ['acme.notes', 'oats.okf']], 'both, not the first');
  assert.equal(whyTag(knowledge)[1], 'This soul empties the knowledge slot, which the workspace default filled with acme.notes, oats.okf');
  assert.deepEqual(compositionEntries(two, null, { facts: true }).filter(e => e.why === 'off'), []);
  const { dom, host } = render(renderSoulCore, { entries: coreEntries(two, { layersFrom: true, facts: true }), status: null });
  try { assert.equal(coreRow(host, 'knowledge').querySelector('.soul-cap-why-note').textContent, 'This soul empties the knowledge slot; the workspace default is acme.notes, oats.okf'); } finally { dom.window.close(); }
  // A slot-none without a core slot: Core cannot place it, so it stays a Capabilities off row and no slot claims "No default".
  const loose = layered(empty, { capabilitiesOff: [{ id: 'oats.okf', off: true, from: 'soul', reason: 'slot-none', overrides: 'workspace' }] });
  assert.deepEqual(coreEntries(loose, { layersFrom: true, facts: true }).map(e => e.why), [null, null, null]);
  const kept = compositionEntries(loose, null, { facts: true }).filter(e => e.why === 'off');
  assert.deepEqual(kept.map(e => [e.name, e.reason]), [['oats.okf', 'slot-none']]);
  assert.equal(whyTag(kept[0])[1], 'This soul empties a core slot, which the workspace default filled with oats.okf');
});

test('a core-layer capability whose slot inspect does not report stays under Capabilities (Core has no row to show it)', () => {
  const v = layered({}, { capabilitiesOff: [] }); v.capabilities = [{ id: 'oats.aweb', layer: 'messaging', from: { kind: 'package', package: 'oats.aweb' }, composedFrom: 'workspace' }];
  assert.deepEqual(coreEntries(v, { layersFrom: true, facts: true }).map(e => e.reported), [false, false, false]);
  assert.deepEqual(compositionEntries(v, null, { facts: true }).map(e => e.cap?.id), ['oats.aweb']);
  v.layers = { messaging: { id: null, from: null } };
  assert.deepEqual(compositionEntries(v, null, { facts: true }).map(e => e.cap?.id), [], 'a reported slot: Core\'s');
});

test('Capabilities never lists a core-layer module, even one the soul also declares', () => {
  const v = withFacts();
  v.capabilities.push({ ...v.capabilities.find(c => c.id === 'oats.core'), id: 'acme.mail', layer: 'messaging', composedFrom: 'soul' });
  const soul = { declarations: { capabilities: { 'oats.aweb': {}, 'acme.mail': {} } } };
  for (const facts of [true, false]) {
    const ids = compositionEntries(v, soul, { facts }).map(e => e.cap?.id ?? e.name);
    assert.ok(!ids.includes('oats.aweb') && !ids.includes('acme.mail') && !ids.includes('oats.okf'), JSON.stringify(ids));
  }
});

test('the capability page opened from a soul says why, in the soul page\'s words; no reported reason, no row', () => {
  assert.deepEqual(whyFact({ slot: 'messaging', why: 'workspace' }, 'dev'), ['Workspace default · messaging', "dev doesn't choose a messaging capability; it resolves the workspace's default."]);
  assert.deepEqual(whyFact({ slot: 'knowledge', why: 'soul' }, 'dev'), ['Chosen by the soul · knowledge', 'dev chooses its knowledge capability.']);
  assert.deepEqual(whyFact({ slot: 'messaging', why: 'team', team: 'eng' }, 'dev'), ['eng team default · messaging', "dev doesn't choose a messaging capability; it resolves the eng team's default."]);
  assert.deepEqual(whyFact({ why: 'workspace' }, 'dev'), ['Workspace default', "dev doesn't declare it; it resolves the workspace's default."]);
  assert.deepEqual(whyFact({ why: 'soul' }, 'dev'), ['Declared by the soul', 'dev declares it.']);
  assert.deepEqual(whyFact({ why: 'team', team: 'eng' }, 'dev'), ['eng team default', "dev doesn't declare it; it resolves the eng team's default."]);
  for (const entry of [{ why: 'default' }, { why: null, slot: 'tasks' }, { why: 'off', name: 'x' }, { why: 'none', slot: 'tasks' }, null]) assert.equal(whyFact(entry, 'dev'), null);
  const cap = withFacts().capabilities.find(c => c.id === 'oats.aweb');
  const page = why => {
    const { dom, host } = render(renderCapabilityPage, { row: capabilityRow(cap), status: null, instances: [], root: '/w', onBack() {}, from: { label: 'dev', why } });
    const card = host.querySelector('details.cap-fold[data-fold="as-soul"]');
    assert.equal(card.querySelector('summary').textContent, 'As dev resolves it');
    const row = card.querySelector('[data-fact="why"]');
    const out = row ? [row.querySelector('dt').textContent, row.querySelector('.page-why-label').textContent, row.querySelector('.page-why-note').textContent] : null;
    dom.window.close(); return out;
  };
  assert.deepEqual(page({ slot: 'messaging', id: 'oats.aweb', why: 'workspace' }),
    ['Why', 'Workspace default · messaging', "dev doesn't choose a messaging capability; it resolves the workspace's default."]);
  assert.deepEqual(page({ cap, why: 'soul' }), ['Why', 'Declared by the soul', 'dev declares it.']);
  assert.equal(page({ cap, why: 'default' }), null, 'a legacy "default" is not a reported reason');
  assert.equal(page(undefined), null);
});
