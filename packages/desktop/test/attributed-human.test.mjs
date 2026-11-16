// The owning human (feature spawn-attribution): the kernel's `attributedHuman` on a status row, local or
// remote, read as it is (docs/desktop-cli-api.md, "Attributed human"): the label of the human the
// instance's messaging identity is attributed to, or null. The instance panel's Lineage section shows it
// as "Owning human" only when it is set; unset, nothing is shown and nothing reads as a fault. The
// instance name stays every row's label.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { deploymentStatusData } from '../../client/deployment-data.mjs';
import { panelInstance } from '../../client/deployment-panel.mjs';
import { createContextPanel, contextPanelCSS } from '../renderer/context-panel.mjs';
import { kernelRemoteRow, remoteRows } from './helpers/kernel-remote-row.mjs';

const DEPLOYMENT = '/fixture/base/northwind-workspace';
const status = JSON.parse(readFileSync(new URL('./fixtures/workspace-v2/desktop-facts/status.json', import.meta.url), 'utf8'));
/** The fixture's first local row as the roster reads it, its kernel row changed by `edit`. */
function localRow(edit) {
  const doc = structuredClone(status); edit(doc.agents[0].instances[0]);
  const roster = deploymentStatusData(doc, DEPLOYMENT);
  return { roster, row: roster.agents[0].instances[0] };
}
// Every value read as no human: the label's rule is a waiting claim's message rule (one line of 1 to 200
// characters, no control character, line break or bidi control), and text the clients withhold as unsafe.
const MALFORMED = [['a number', 7], ['an object', { label: 'Ada' }], ['an empty string', ''], ['a blank string', '   '],
  ['a line break', 'Ada\nExample'], ['a control character', 'Ada\u0007'], ['a bidi control', 'Ada‮elpmaxE'],
  ['201 code points', 'a'.repeat(201)], ['text withheld as unsafe', 'Ada token: abc123']];

test('local: a status row\'s attributedHuman is kept on the roster row and served to the panel', () => {
  const { roster, row } = localRow(i => { i.attributedHuman = 'Ada Example'; });
  assert.equal(row.attributedHuman, 'Ada Example');
  assert.equal(panelInstance({ ...row, agentsRoot: roster.root }).attributedHuman, 'Ada Example');
});

test('local: 200 code points (emoji included) is a label', () => {
  const label = '🙂'.repeat(200);
  assert.equal(localRow(i => { i.attributedHuman = label; }).row.attributedHuman, label);
});

test('local: null is no human, and an absent field stays absent (an older kernel)', () => {
  const { roster, row } = localRow(i => { i.attributedHuman = null; });
  assert.equal(row.attributedHuman, null);
  assert.equal(panelInstance({ ...row, agentsRoot: roster.root }).attributedHuman, null);
  const old = localRow(i => { delete i.attributedHuman; });
  assert.equal(Object.hasOwn(old.row, 'attributedHuman'), false, 'absent, not invented');
  assert.equal(Object.hasOwn(panelInstance({ ...old.row, agentsRoot: old.roster.root }), 'attributedHuman'), false);
});

test('local: a malformed attributedHuman reads as no human and never fails the roster', () => {
  for (const [what, value] of MALFORMED) {
    const { row } = localRow(i => { i.attributedHuman = value; });
    assert.equal(row.attributedHuman, null, what);
    assert.equal(row.instance, 'release-manager-facts', `${what}: the row is still read`);
  }
});

test('remote: a relayed row\'s attributedHuman is carried, null stays null, a malformed one reads as null', () => {
  const [set, unset, ...bad] = remoteRows([kernelRemoteRow('dev-set', { attributedHuman: 'Ada Example' }), kernelRemoteRow('dev-unset'),
    ...MALFORMED.map(([, value], n) => kernelRemoteRow(`dev-bad-${n}`, { attributedHuman: value }))]);
  assert.equal(set.attributedHuman, 'Ada Example');
  assert.equal(unset.attributedHuman, null);
  bad.forEach((row, n) => assert.equal(row.attributedHuman, null, MALFORMED[n][0]));
  const { attributedHuman: _absent, ...older } = kernelRemoteRow('dev-older');
  assert.equal(Object.hasOwn(remoteRows([older])[0], 'attributedHuman'), false, 'a host that does not report it: absent');
});

function panel(t) {
  const dom = new JSDOM('<!doctype html><body><aside id="context-panel"></aside></body>');
  const document = dom.window.document, style = document.createElement('style'); style.textContent = contextPanelCSS; document.head.append(style);
  const p = createContextPanel({ document, root: document.getElementById('context-panel'), openSoul() {} });
  t.after(() => { p.dispose(); dom.window.close(); });
  const q = s => document.querySelector(s);
  return { q, select: instance => p.setContext({ workspace: 'A', instance, key: instance.home }),
    row: id => q(`#context-panel [data-row="${id}"]`), page: () => q('[data-context-page="instance"]') };
}
const instance = (extra = {}) => ({ instance: 'web-developer-1', agent: 'web-developer', agentsRoot: '/w/agents',
  home: '/w/agents/web-developer/instances/web-developer-1', harness: 'claude', work: 'directory', running: true, ...extra });

test('panel: an attributed human is the Lineage section\'s "Owning human" field, first, even with no parent or sibling', t => {
  const u = panel(t); u.select(instance({ attributedHuman: 'Ada Example' }));
  const row = u.row('attributedHuman'), lineage = row.closest('.context-panel-section');
  assert.equal(row.hidden, false); assert.equal(lineage.hidden, false);
  assert.equal(lineage.querySelector(':scope > .context-panel-label').textContent, 'Lineage');
  assert.equal(row.querySelector('dt').textContent, 'Owning human');
  assert.equal(row.querySelector('dd').textContent, 'Ada Example');
  assert.equal(row, lineage.querySelector('[data-row]'), 'the first fact of Lineage');
  assert.equal(u.q('.context-panel-identity-name').textContent, 'web-developer-1', 'the panel still names the instance');
  u.select(instance({ attributedHuman: 'Ada Example', parentInstance: 'lead-1' }));
  assert.deepEqual([...lineage.querySelectorAll('[data-row]:not([hidden]) dt')].map(dt => dt.textContent), ['Owning human', 'Parent']);
});

test('panel: no attributed human (null or absent) shows no field, no empty section and no fault', t => {
  const u = panel(t);
  for (const unset of [{ attributedHuman: null }, {}]) {
    u.select(instance(unset));
    assert.equal(u.row('attributedHuman').hidden, true);
    assert.equal(u.row('attributedHuman').closest('.context-panel-section').hidden, true, 'nothing else in Lineage: the section hides');
    const shown = [...u.page().querySelectorAll('[data-row]:not([hidden]), .context-panel-note:not([hidden])')].map(n => n.textContent).join('|');
    assert.doesNotMatch(shown, /Not reported|human|attribut/i);
    assert.equal(u.page().querySelector('[role="alert"]:not([hidden])'), null);
  }
  u.select(instance({ parentInstance: 'lead-1' }));
  assert.equal(u.row('attributedHuman').hidden, true, 'beside a parent: still no human field');
  assert.equal(u.row('parentInstance').hidden, false);
});

test('panel: moving from an attributed instance to one without clears the field', t => {
  const u = panel(t);
  u.select(instance({ attributedHuman: 'Ada Example' }));
  u.select(instance({ instance: 'web-developer-2', home: '/w/agents/web-developer/instances/web-developer-2' }));
  assert.equal(u.row('attributedHuman').hidden, true);
  assert.doesNotMatch(u.page().textContent, /Ada Example/);
});

test('rows keep the instance name: only the instance panel reads attributedHuman in the renderer', () => {
  const dir = new URL('../renderer/', import.meta.url);
  const readers = readdirSync(dir).filter(f => f.endsWith('.mjs') && readFileSync(new URL(f, dir), 'utf8').includes('attributedHuman'));
  assert.deepEqual(readers, ['context-panel.mjs']);
});
