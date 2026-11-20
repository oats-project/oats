import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { capabilitiesData } from '../../client/deployment-data.mjs';
import { renderCapabilityPage } from '../renderer/capability-page.mjs';
import { renderCapabilityList } from '../renderer/workspace-catalog.mjs';
import { createCapabilityContents } from '../renderer/capability-contents.mjs';

// Kernel #217 (desktop-facts) on the capability views, from the real capture through the
// server's projection (#230): description, what it provides, its file and its fingerprint.
const capture = JSON.parse(readFileSync(new URL('./fixtures/workspace-v2/desktop-facts/capabilities.json', import.meta.url), 'utf8'));
const rows = capabilitiesData(capture).capabilities;
const row = name => rows.find(r => r.name === name);

// The page's Skills rows are its Contents controller's: here one whose CLI cannot show contents, so the rows are the
// catalog's skill names (capability-contents.mjs), as on an older OATS.
function page(t, target, options = {}) {
  const dom = new JSDOM('<!doctype html><body><main></main></body>'), host = dom.window.document.querySelector('main');
  const contents = createCapabilityContents(dom.window.document, { request: async () => { throw new Error('not asked'); } });
  t.after(() => { contents.dispose(); dom.window.close(); });
  contents.update({ row: target, cli: null });
  renderCapabilityPage(host, { row: target, status: null, instances: [], root: '/fx', onBack() {}, skills: contents.skills, skillView: contents.skillView, ...options });
  const facts = fold => Object.fromEntries([...host.querySelectorAll(`details.cap-fold[data-fold="${fold}"] .page-kv`)].map(r => [r.querySelector('dt').textContent, r.querySelector('dd').textContent]));
  const provides = kind => kind === 'skills' ? [...host.querySelectorAll('.cap-skills-section .cap-skill-name')].map(i => i.textContent)
    : [...host.querySelectorAll(`details.cap-fold[data-fold="${kind}"] .provides-chip`)].map(i => i.textContent);
  return { host, facts, provides, $: s => host.querySelector(s) };
}

test('a member capability: description, what it provides, its manifest path and its tree fingerprint', t => {
  const cap = row('nw-release-tooling'), u = page(t, cap);
  assert.equal(u.$('.page-lede').textContent, cap.description);
  assert.deepEqual([u.provides('skills'), u.provides('commands'), u.provides('hooks')], [['cut-release'], ['cut', 'verify'], []]);
  assert.equal(u.$('details.cap-fold[data-fold="hooks"] .page-note').textContent, 'None');
  const from = u.facts('source');
  assert.equal(from.Fingerprint, cap.tree.slice(0, 7)); assert.equal(from.File, 'capabilities/nw-release-tooling/oats.json');
  assert.equal(u.$('details.cap-fold[data-fold="source"] button[data-verb=file]'), null, 'the capture\'s repos are local: no web address, the path shows');
});

test('a package capability keeps its lock integrity as fingerprint (tree is null); a core one says its layer', t => {
  const okf = row('oats.okf'), u = page(t, okf);
  assert.equal(okf.tree, null); assert.equal(okf.layer, 'knowledge', 'package rows carry layer now');
  assert.match(u.$('.page-title').textContent, /Core · Knowledge/);
  assert.deepEqual(u.provides('hooks'), ['retire', 'spawn']);
  assert.equal(Object.hasOwn(u.facts('source'), 'File'), true);
});

test('skills and commands a spawn could not list say so; a hosted manifest opens as its web page', t => {
  const url = 'https://github.com/northwind/agents/blob/abc/capabilities/nw-house-style/oats.json', opened = [];
  const u = page(t, { ...row('nw-house-style'), skills: null, commands: null, file: { path: 'capabilities/nw-house-style/oats.json', url } }, { openExternal: link => opened.push(link) });
  assert.match(u.$('.cap-skills-section .cap-skills-note').textContent, /can't be listed/);
  assert.match(u.$('details.cap-fold[data-fold="commands"] .page-note').textContent, /Not listable/);
  u.$('details.cap-fold[data-fold="source"] button[data-verb=file]').click(); assert.deepEqual(opened, [url]);
});

test('an older kernel (no facts) shows none of it; the catalog table adds the description line', t => {
  const { description, skills, commands, hooks, file, tree, ...old } = row('nw-deploy');
  const u = page(t, old);
  assert.equal(u.$('.page-lede'), null); assert.equal(u.$('details.cap-fold[data-fold="commands"], details.cap-fold[data-fold="hooks"]'), null);
  assert.equal(u.$('.cap-skills-section').hidden, true, 'no skills reported: no Skills rows');
  assert.equal(Object.hasOwn(u.facts('source'), 'File'), false);
  const dom = new JSDOM('<!doctype html><body><div></div></body>'), host = dom.window.document.querySelector('div');
  t.after(() => dom.window.close());
  renderCapabilityList(host, { rows: [row('nw-deploy'), { ...old, name: 'nw-deploy-old' }], status: null });
  const lines = [...host.querySelectorAll('.cap-row')].map(r => r.querySelector('.cap-row-desc')?.textContent ?? null);
  assert.deepEqual(lines, [description, null]);
});
