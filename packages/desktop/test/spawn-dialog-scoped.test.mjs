// The New agent form on one soul (slice 5; the preview of design board 6): the sheet, the full preview at the end of
// Advanced, the segmented Harness control and the one-border Name field. The form is mounted directly with a stubbed
// ctx whose preview endpoint answers the kernel captures (test/fixtures/workspace-v2/f3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createSpawnDialog, spawnDialogCSS, composePreviewModules } from '../renderer/spawn-dialog.mjs';
import { worksInText, moduleSourceText } from '../../client/spawn-preview-facts.mjs';
import { identityCSS } from '../renderer/identity-marks.mjs';
import { spawnProblem } from '../../client/spawn-messages.mjs';
import { spawnText } from '../renderer/spawn-words.mjs';
import { cli as CLI, kernel, ROOT, target, view, deferred } from './helpers/spawn-preview-fixture.mjs';

const themeCSS = readFileSync(new URL('../renderer/theme.css', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function settle(n = 8) { for (let i = 0; i < n; i++) await tick(); }
const member = { name: 'release-manager', description: 'Cuts releases.', kind: 'persistent', work: 'worktree', agentsRoot: ROOT, soulKind: 'member', origin: 'member', repoName: 'agents' };
const other = { name: 'support-triager', description: 'Triages.', kind: 'persistent', work: 'directory', agentsRoot: ROOT, soulKind: 'member', origin: 'member', repoName: 'agents' };
const packaged = { name: 'code-reviewer', description: 'Reviews.', kind: 'persistent', work: 'worktree', agentsRoot: ROOT, soulKind: 'package', package: 'oats.engineering', version: '1.3.0', repoName: 'package oats.engineering' };
const preview = name => kernel(name).result;
const v2 = name => JSON.parse(readFileSync(new URL(`./fixtures/team-model-v2/${name}.json`, import.meta.url), 'utf8'));

// The previews here are `--purpose` captures, chosen by a typed purpose: by default the dialog's CLI lacks spawn-name,
// the older kernel's path, where a typed name is a purpose (spawn-dialog.test.mjs covers the --name path).
const PURPOSE_CLI = { ...CLI, features: CLI.features.filter(f => f !== 'spawn-name') };
function mount(t, { soul = member, agents = [member, other, packaged], previews = () => view(target, preview('preview-worktree-default')), cli = PURPOSE_CLI, theme = 'light', workspace = () => ({ id: 'northwind', name: 'northwind' }) } = {}) {
  const dom = new JSDOM(`<!doctype html><html data-theme="${theme}"><body><div class="oats-view"><div class="spawn-modal"></div></div></body></html>`, { url: 'http://localhost', pretendToBeVisual: true });
  const doc = dom.window.document;
  for (const source of [themeCSS, identityCSS, spawnDialogCSS]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
  const calls = [], chosen = [];
  const ctx = { api: async (path, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : undefined; calls.push({ path, body });
    if (path.startsWith('/api/workspace-spawn-preview')) return previews(body);
    if (path === '/api/models') return { models: [] };
    if (path.startsWith('/api/launch-configs')) return { selected: body.selector, configurations: [] };
    throw new Error(`unexpected ${path}`);
  } };
  const ui = createSpawnDialog(doc.querySelector('.spawn-modal'), { ctx, soul, agents, workspace, cli: () => cli,
    owns: () => true, canChoose: () => true, choose: (candidate, draft) => chosen.push({ candidate, draft }), close: () => {}, servers: [], delay: 0, busyDelay: 0 });
  ui.start();
  t.after(() => { ui.dispose(); dom.window.close(); });
  const q = selector => ui.dialog.querySelector(selector);
  return { dom, doc, ui, calls, chosen, q, text: selector => (q(selector)?.textContent || '').trim(), style: el => dom.window.getComputedStyle(el),
    hidden: el => !el || el.hidden || !!el.closest('[hidden]'),
    // A fact's words, without the decorative harness badge's glyph; a value's second line after " / ".
    facts: () => Object.fromEntries([...ui.dialog.querySelectorAll('.spawn-preview-created dt')].map(dt => {
      const dd = dt.nextElementSibling.cloneNode(true); for (const badge of dd.querySelectorAll('.runtime-badge')) badge.remove();
      for (const line of dd.querySelectorAll('.spawn-fact-sub')) line.textContent = ` / ${line.textContent}`;
      return [dt.textContent, dd.textContent.trim()];
    })),
    // jsdom does not compute a shorthand holding var() (border:1px solid var(--border)), so frames are read from the rules.
    rule: (selector, prop) => [...doc.styleSheets].flatMap(sheet => [...sheet.cssRules]).filter(r => r.selectorText?.split(',').map(x => x.trim()).includes(selector)).map(r => r.style.getPropertyValue(prop)).filter(Boolean).at(-1) ?? '',
    async type(selector, value) { const el = q(selector); el.value = value; el.dispatchEvent(new dom.window.Event('input', { bubbles: true })); await settle(); } };
}

test('the sheet: one column, "New agent · in <workspace>", a close button named for it, capped by the viewport', async t => {
  const u = mount(t); await settle();
  const title = u.q('h2#spawn-dialog-title');
  assert.equal(title.textContent, 'New agent'); assert.equal(u.ui.dialog.getAttribute('aria-labelledby'), 'spawn-dialog-title');
  assert.equal(u.text('.spawn-context'), 'in northwind');
  assert.equal(u.q('.close-act').getAttribute('aria-label'), 'Close New agent');
  assert.equal(u.style(u.ui.dialog).width, '640px');
  // A narrower window never clips it: the cap is the viewport less the modal's 24px padding, not 100%
  // (the modal's centring grid track grows to the dialog, so a percentage would not cap it).
  assert.equal(u.style(u.ui.dialog).maxWidth, 'calc(100vw - 48px)');
  assert.equal(u.q('.spawn-columns, .spawn-chooser, .spawn-change-soul'), null, 'no columns, no chooser, no Change soul');
  // The sheet eases in over 150 ms (D10), and stands still under reduced motion.
  assert.match(spawnDialogCSS, /\.spawn-modal \.spawn-dialog \{[^}]*animation:spawn-sheet-rise \.15s ease;/);
  assert.match(spawnDialogCSS, /@media \(prefers-reduced-motion: reduce\) \{ \.spawn-modal, \.spawn-modal \.spawn-dialog \{ animation:none; \} \}/);
});

test('a soul pick in the Soul field goes to the host with what was typed; the form is never reopened by itself', async t => {
  const u = mount(t); await settle();
  await u.type('.fpurpose', 'api-v2'); await u.type('.ftask', 'Cut 3.2');
  const dialog = u.ui.dialog;
  u.q('.spawn-soul-current').click();
  u.q('.spawn-soul-option[data-agent="support-triager"]').click();
  assert.equal(u.ui.dialog, dialog);
  assert.equal(u.chosen.length, 1); assert.equal(u.chosen[0].candidate.name, 'support-triager');
  assert.deepEqual(u.chosen[0].draft, { query: '', purpose: 'api-v2', task: 'Cut 3.2' });
});

test('the preview column: a skeleton with aria-busy while reading, then the facts the kernel decided', async t => {
  const gate = deferred();
  const u = mount(t, { previews: async () => { await gate.promise; return view(target, preview('preview-worktree-default')); } });
  await settle();
  const aside = u.q('.spawn-preview');
  assert.equal(aside.getAttribute('aria-busy'), 'true');
  assert.equal(aside.querySelectorAll('.spawn-preview-skeleton span').length, 8, '4 rows of blocks');
  assert.equal(u.style(aside.querySelector('.spawn-preview-skeleton span')).background, 'var(--tag-bg)');
  assert.equal(u.text('.spawn-preview-reading'), 'Reading the preview…'); assert.ok(u.q('.spawn-preview-reading').classList.contains('workspace-sr-only'));
  assert.equal(u.text('.spawn-preview-title'), 'What will be created', 'section titles stay while loading');
  assert.equal(u.text('.spawn-preview-note'), 'Resolved by the installed CLI. Start refuses if this changes before you confirm.');
  assert.equal(u.text('.fstatus'), 'Reading defaults…'); assert.equal(u.q('.fstatus').classList.contains('ok'), false);
  gate.resolve(); await settle(12);
  assert.equal(aside.getAttribute('aria-busy'), 'false'); assert.equal(aside.querySelector('.spawn-preview-skeleton'), null);
  // Board 6: the footer says the preview settled — a check in --ok (decoration, empty alt), then the words.
  assert.equal(u.text('.fstatus'), 'Preview ready'); assert.ok(u.q('.fstatus').classList.contains('ok'));
  assert.equal(u.rule('.spawn-footer .fstatus.ok::before', 'color'), 'var(--ok)');
  assert.match(u.rule('.spawn-footer .fstatus.ok::before', 'content'), /^"\\2713"\s*\/\s*""$/);
  const data = preview('preview-worktree-default');
  assert.deepEqual(u.facts(), { Name: data.instance, Home: 'agents/release-manager/instances/release-manager-1', 'Works in': 'worktree · branch agents/release-manager-1 from HEAD',
    Harness: 'Pi · default model / native default', Team: 'engineering' });
  // The instance leads, apart from the facts: its name and its home (relative to the deployment, the full path its title).
  const created = u.q('.spawn-preview-created .spawn-preview-body');
  assert.deepEqual([...created.children].map(c => c.className), ['spawn-preview-identity', 'spawn-preview-facts']);
  assert.equal(u.q('.spawn-preview-name').textContent, data.instance); assert.equal(u.q('.spawn-preview-home').title, data.home);
  assert.equal(u.rule('.spawn-preview-name', 'font-size'), '13.5px'); assert.match(u.rule('.spawn-preview-name', 'font-family'), /^var\(--mono/); assert.equal(u.style(u.q('.spawn-preview-name')).color, 'var(--fg)');
  assert.equal(u.style(u.q('.spawn-preview-home')).color, 'var(--muted)');
  assert.ok([...u.q('.spawn-preview-identity').querySelectorAll('dt')].every(dt => dt.classList.contains('workspace-sr-only')), 'the terms are for assistive tech');
  assert.equal(u.q('.spawn-preview-facts dd .mono').textContent, data.branch, 'the branch in monospace');
  const harness = u.q('.spawn-preview-harness'); assert.equal(harness.querySelector('.runtime-badge').dataset.runtime, 'pi');
  assert.equal(harness.querySelector('.runtime-badge').getAttribute('aria-hidden'), 'true', 'decorative beside the words');
  assert.equal(u.style(harness.querySelector('.runtime-badge')).width, '16px');
  // The captured kernel's modules[] (projected as names and sources): Core capabilities and the Capabilities list.
  assert.equal(u.hidden(u.q('.spawn-preview-core')), false); assert.equal(u.q('.spawn-preview-core h3').textContent, 'Core capabilities');
  assert.deepEqual([...u.q('.spawn-preview-core').querySelectorAll('.spawn-core-row')].map(row => row.textContent), ['Knowledgeoats.okfpackage oats.okf 2.1.3', 'MessagingNone', 'TasksNone']);
  // A module filling a core slot is Core's: never listed or counted again under Capabilities.
  const others = data.modules.filter(m => !['knowledge', 'messaging', 'tasks'].includes(m.layer));
  assert.ok(others.length < data.modules.length, 'the capture has a core provider');
  assert.equal(u.hidden(u.q('.spawn-preview-caps')), false); assert.equal(u.q('.spawn-preview-caps h3').textContent, `Capabilities · ${others.length}`);
  assert.deepEqual([...u.q('.spawn-preview-caps').querySelectorAll('.spawn-cap-row')].map(row => row.dataset.module), others.map(m => m.name).sort());
  // A kernel without modules[]: neither section exists, not even a title.
  const bare = { ...data }; delete bare.modules;
  const without = mount(t, { previews: () => view(target, bare) }); await settle(12);
  assert.equal(without.hidden(without.q('.spawn-preview-core')), true); assert.equal(without.q('.spawn-preview-core').childElementCount, 0);
  assert.equal(without.hidden(without.q('.spawn-preview-caps')), true); assert.doesNotMatch(without.q('.spawn-preview').textContent, /Core capabilities|Capabilities ·/);
  assert.equal(u.style(aside).background, 'var(--surface-2)'); assert.equal(u.rule('.spawn-preview', 'width'), '', 'as wide as Advanced');
});

test('the preview follows the latest choice: typing keeps the settled facts, marked Updating…, and the Name fact follows the form at once', async t => {
  const gate = deferred(); let n = 0;
  const u = mount(t, { previews: async body => { n++; if (body.choices.purpose) await gate.promise; return view(target, preview(body.choices.purpose ? 'preview-worktree-purpose' : 'preview-worktree-default')); } });
  await settle();
  const aside = u.q('.spawn-preview'), mark = u.q('.spawn-preview-updating');
  assert.equal(u.facts().Name, preview('preview-worktree-default').instance); assert.equal(u.hidden(mark), true, 'nothing is updating');
  const core = u.q('.spawn-preview-core .spawn-core-box');
  const el = u.q('.fpurpose'); el.value = 'api-v2'; el.dispatchEvent(new u.dom.window.Event('input', { bubbles: true }));
  assert.equal(aside.getAttribute('aria-busy'), 'true', 'a read is due for the new choice');
  assert.equal(u.q('.spawn-preview-skeleton'), null, 'never the skeleton after the first settle');
  assert.equal(u.hidden(mark), false); assert.equal(mark.textContent, 'Updating…');
  assert.equal(mark.parentElement, u.q('.spawn-preview-created .spawn-preview-head'), 'beside the "What will be created" title');
  assert.equal(u.facts().Name, 'release-manager-api-v2', 'the name the form spells, at once: never a stale name');
  assert.equal(u.facts()['Works in'], 'worktree · branch agents/release-manager-1 from HEAD', 'the other settled facts stay');
  assert.equal(u.hidden(u.q('.spawn-preview-core')), false); assert.equal(u.q('.spawn-preview-core .spawn-core-box'), core, 'Core capabilities stay in place, not redrawn');
  assert.equal(u.hidden(u.q('.spawn-preview-caps')), false);
  await settle(12);
  assert.equal(aside.getAttribute('aria-busy'), 'true', 'still reading'); assert.equal(u.hidden(mark), false);
  assert.equal(u.text('.fstatus'), 'Preview ready', 'the footer stays quiet while updating: no "Reading defaults…" churn');
  gate.resolve(); await settle(12);
  assert.equal(u.facts().Name, 'release-manager-api-v2'); assert.equal(n, 2);
  assert.equal(aside.getAttribute('aria-busy'), 'false'); assert.equal(u.hidden(mark), true);
  // The marker is words in the muted token, beside the title: no text is faded (AA).
  assert.equal(u.style(mark).color, 'var(--muted)'); assert.equal(u.style(mark).opacity, '1');
});

test('Harness says where the launch came from (0.30 launch), Team the default the kernel resolved (team model v2)', async t => {
  const featured = { ...structuredClone(CLI), features: [...CLI.features, 'launch-preference'] };
  const data = { ...preview('preview-worktree-default'), launch: { declared: { harness: 'pi', model: null }, effective: { harness: 'pi', model: null, launchConfig: null }, from: 'soul', at: 'souls/release-manager/soul.yaml#/launch', problem: null } };
  const u = mount(t, { cli: featured, previews: () => view(target, data) }); await settle(12);
  assert.equal(u.facts().Harness, "Pi · default model / the soul's preference", 'the harness and model, where it came from beneath');
  const teams = mount(t, { cli: { ...structuredClone(v2('version')), ok: true, bin: '/fixture/oats' }, previews: () => view(target, v2('preview').result) }); await settle(12);
  // The default, then (muted, its own line) the other teams this spawn may join.
  assert.equal(teams.facts().Team, 'engineering · default / may also join global, mine');
  const teamValue = u => [...u.ui.dialog.querySelectorAll('.spawn-preview-facts dt')].find(dt => dt.textContent === 'Team').nextElementSibling;
  assert.deepEqual([...teamValue(teams).querySelectorAll('.muted')].map(m => [m.className, m.textContent]), [['muted', ' · default'], ['muted spawn-fact-sub', 'may also join global, mine']]);
  const none = mount(t, { cli: { ...structuredClone(v2('version')), ok: true, bin: '/fixture/oats' }, previews: () => view(target, { ...v2('preview').result, defaultTeam: null, teams: [] }) }); await settle(12);
  assert.equal(none.facts().Team, 'none'); assert.equal(teamValue(none).querySelector('.muted').textContent, 'none');
});

test('a kernel refusal replaces the facts with the footer\'s plain sentence; a name refusal stays at the Name field', async t => {
  const refusal = kernel('preview-clone-missing');
  const u = mount(t, { previews: () => ({ spawnPreviewViewApi: 1, status: 'unavailable', target, data: null, reason: { code: refusal.error.code, message: refusal.error.message } }) });
  await settle(12);
  const said = spawnText(spawnProblem({ code: refusal.error.code, message: refusal.error.message }, 'preview'), 'preview');
  assert.equal(u.text('.spawn-preview-failure'), said); assert.equal(u.text('.fstatus'), said, 'the same sentence as the footer');
  assert.equal(u.q('.fstatus').classList.contains('ok'), false, 'a refusal is never "ready"');
  assert.equal(u.style(u.q('.spawn-preview-failure')).color, 'var(--warn)');
  assert.equal(u.q('.spawn-preview-facts'), null); assert.equal(u.q('.spawn-preview').getAttribute('aria-busy'), 'false');
  const taken = kernel('preview-name-taken');
  const n = mount(t, { previews: () => ({ spawnPreviewViewApi: 1, status: 'unavailable', target, data: null, reason: { code: taken.error.code, message: taken.error.message } }) });
  await settle(12);
  assert.equal(n.q('.spawn-preview-failure'), null, 'said once, next to the name'); assert.ok(n.q('.spawn-name-result').classList.contains('err'));
  assert.equal(n.text('.spawn-preview-empty'), 'No preview until the name is accepted.');
});

test('Core capabilities and Capabilities come from the preview\'s modules only', () => {
  const dom = new JSDOM('<body></body>'), doc = dom.window.document;
  assert.equal(composePreviewModules(doc, undefined), null); assert.equal(composePreviewModules(doc, null), null);
  const modules = preview('preview-worktree-purpose').modules.map(m => ({ name: m.name, layer: m.layer, from: m.from }));
  const { core, caps } = composePreviewModules(doc, modules);
  assert.equal(core[0].textContent, 'Core capabilities');
  // Core rows speak the Capabilities rows' grammar (the module in mono, its source chip), led by the slot.
  assert.deepEqual([...core[1].querySelectorAll('.spawn-core-row')].map(row => [...row.children].map(c => [c.className, c.textContent])),
    [[['spawn-core-layer', 'Knowledge'], ['spawn-core-module', 'oats.okfpackage oats.okf 2.1.3']],
      [['spawn-core-layer', 'Messaging'], ['muted', 'None']], [['spawn-core-layer', 'Tasks'], ['muted', 'None']]]);
  // An empty slot reads as an absence (muted "None"), never as a provider named "none".
  assert.match(spawnDialogCSS, /\.spawn-core-row \.muted, [^{]*\{ color:var\(--muted\); \}/);
  // oats.okf fills the knowledge slot: Core's only.
  assert.equal(caps[0].textContent, 'Capabilities · 4');
  assert.deepEqual([...caps[1].querySelectorAll('.spawn-cap-row')].map(row => [row.querySelector('.mono').textContent, row.querySelector('.spawn-cap-source').textContent]),
    [['nw-deploy', 'package nw.tools 0.4.0'], ['nw-house-style', 'agents · latest'], ['nw-release-tooling', 'agents · latest'], ['oats.core', 'package oats.framework 1.1.3']]);
  // Line 1 the module, line 2 its chips as one wrapping group: the same structure at every width, nothing right-justified.
  assert.deepEqual([...caps[1].querySelector('.spawn-cap-row').children].map(c => c.className), ['mono', 'spawn-cap-tags']);
  assert.deepEqual([...core[1].querySelector('.spawn-core-module').children].map(c => c.className), ['mono', 'spawn-cap-tags']);
  assert.match(spawnDialogCSS, /\.spawn-core-row \{ display:grid; grid-template-columns:84px minmax\(0,1fr\);/, 'the slot is a fixed left column');
  assert.match(spawnDialogCSS, /\.spawn-cap-row, \.spawn-core-module \{ display:flex; flex-direction:column; align-items:flex-start;/);
  assert.match(spawnDialogCSS, /\.spawn-cap-tags \{ display:flex; flex-wrap:wrap; justify-content:flex-start;/);
  assert.doesNotMatch(spawnDialogCSS, /justify-content:flex-end/, 'nothing right-justified');
  assert.doesNotMatch(spawnDialogCSS.match(/^\.spawn-cap-source, \.spawn-cap-why \{[^}]*\}/m)[0], /nowrap/, 'a long source wraps inside its chip');
  // Nothing but core: the Capabilities box says so rather than standing empty.
  const only = composePreviewModules(doc, modules.filter(m => m.layer));
  assert.equal(only.caps[0].textContent, 'Capabilities · 0'); assert.equal(only.caps[1].textContent, 'No other capabilities: only the core ones.');
  assert.equal(moduleSourceText({ kind: 'external' }), 'external'); assert.equal(moduleSourceText(undefined), '');
  assert.equal(worksInText('checkout'), 'shared checkout'); assert.equal(worksInText('attached'), "a parent's worktree"); assert.equal(worksInText('directory'), 'own folder · free to work across repos');
  assert.equal(worksInText('workspace'), 'all member repos'); assert.equal(worksInText('other'), 'other');
  dom.window.close();
});

test('Harness: claude · codex · pi as a tinted segmented control without a focus ring; the soul\'s default marked in words', async t => {
  const u = mount(t); await settle(12);
  const seg = u.q('.spawn-seg.fharness');
  assert.equal(seg.getAttribute('role'), 'radiogroup');
  assert.deepEqual([...seg.querySelectorAll('label')].map(l => [l.querySelector('input').value, l.querySelector('span').firstChild.textContent]), [['claude', 'Claude Code'], ['codex', 'Codex'], ['pi', 'Pi']]);
  assert.equal(u.q('.fharness input:checked').value, 'pi', 'the soul\'s default (the preview launches pi) is chosen');
  assert.deepEqual([...seg.querySelectorAll('.spawn-harness-default')].map(m => m.hidden), [true, true, false], 'and marked "· default"');
  const checked = u.q('.spawn-seg input:checked + span'), unchecked = u.q('.spawn-seg input:not(:checked) + span');
  const s = u.style(seg);
  assert.equal(s.background, 'var(--surface)'); assert.equal(u.rule('.spawn-seg', 'border'), '1px solid var(--border)'); assert.equal(s.padding, '2px'); assert.equal(s.borderRadius, '8px');
  const c = u.style(checked);
  assert.equal(c.background, 'var(--sel)'); assert.equal(c.color, 'var(--accent)'); assert.equal(c.fontWeight, '650'); assert.equal(c.boxShadow, ''); assert.equal(c.borderRadius, '6px'); assert.equal(c.height, '28px');
  const n = u.style(unchecked);
  assert.equal(n.background, ''); assert.equal(n.color, 'var(--muted)'); assert.equal(n.fontWeight, '500');
  // The CSS itself: keyboard focus is the tint plus a 1px accent edge; no outline anywhere on the segments.
  const rules = [...u.doc.styleSheets].flatMap(sheet => [...sheet.cssRules]).filter(rule => rule.selectorText?.includes('.spawn-seg input:focus-visible'));
  const onSpan = rules.find(rule => rule.selectorText.includes('+ span')); assert.ok(onSpan);
  assert.equal(onSpan.style.background, 'var(--sel)'); assert.equal(onSpan.style.boxShadow, 'inset 0 0 0 1px var(--accent)'); assert.equal(onSpan.style.outline, '');
  const onInput = rules.find(rule => rule.selectorText.startsWith('.spawn-dialog .spawn-seg input:focus-visible')); assert.ok(onInput, 'the dialog-wide ring is switched off for the segments');
  assert.equal(onInput.style.outline, 'none');
});

test('Name: one border on the wrapper that turns to the accent on focus, no ring; the inner input stays borderless', async t => {
  const u = mount(t); await settle();
  const wrapper = u.q('.spawn-name-input'), input = u.q('.fpurpose');
  assert.equal(u.rule('.spawn-name-input', 'border'), '1px solid var(--border)'); assert.equal(u.style(wrapper).height, '36px'); assert.equal(u.style(wrapper).borderRadius, '8px');
  input.focus(); assert.equal(u.doc.activeElement, input);
  assert.ok(wrapper.matches(':focus-within'));
  assert.equal(u.rule('.spawn-name-input:focus-within', 'border-color'), 'var(--accent)'); assert.equal(u.rule('.spawn-name-input:focus-within', 'box-shadow'), 'none');
  assert.equal(u.style(input).border, '0px' === u.style(input).border ? '0px' : u.style(input).border); assert.match(u.style(input).border, /^0/);
  assert.equal(u.style(input).outline, 'none'); assert.equal(u.style(input).boxShadow, 'none');
  const rules = [...u.doc.styleSheets].flatMap(sheet => [...sheet.cssRules]).filter(rule => rule.selectorText?.includes('.spawn-name-input'));
  assert.ok(!rules.some(rule => /focus-within/.test(rule.selectorText) && /3px/.test(rule.style.boxShadow)), 'no 3px ring for the name field');
  assert.ok(rules.some(rule => rule.selectorText.includes('.spawn-name-input input.field:focus-visible') && rule.style.outline === 'none' && rule.style.border === '0px'));
});

test('a remote soul: the preview column says the host decides, without a skeleton or a read', async t => {
  const remote = { ...member, name: 'builder', server: 'build', repoName: 'team', agentsRoot: '/srv/team/agents' };
  const u = mount(t, { soul: remote, agents: [remote] }); await settle();
  assert.equal(u.text('.spawn-preview-empty'), 'Decided on build when it spawns.'); assert.equal(u.q('.spawn-preview').getAttribute('aria-busy'), 'false');
  assert.equal(u.calls.filter(c => c.path.startsWith('/api/workspace-spawn-preview')).length, 0);
});

// Every new fg/bg pairing this layout introduces, checked on the computed tokens like test/theme-contrast.test.mjs.
function luminance(hex) {
  assert.match(hex, /^#[0-9a-f]{6}$/i);
  const c = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
}
for (const theme of ['light', 'solarized', 'dark']) test(`${theme}: the form's header, preview, tags and segments meet computed-token AA with no opacity`, async t => {
  const failing = kernel('preview-clone-missing');
  const u = mount(t, { theme, cli: { ...structuredClone(v2('version')), ok: true, bin: '/fixture/oats' }, previews: () => view(target, v2('preview').result) }); await settle(12);
  // Put every element on screen: the facts and a module section (with a reason tag), then a failure sentence beside them.
  const sections = composePreviewModules(u.doc, v2('preview').result.modules.map(m => ({ name: m.name, layer: m.layer, from: m.from, composedFrom: 'workspace' })));
  u.q('.spawn-preview-core').hidden = false; u.q('.spawn-preview-core').append(...sections.core); u.q('.spawn-preview-caps').hidden = false; u.q('.spawn-preview-caps').append(...sections.caps);
  const failure = u.doc.createElement('p'); failure.className = 'spawn-preview-failure'; failure.textContent = spawnText(spawnProblem({ code: failing.error.code, message: failing.error.message })); u.q('.spawn-preview-body').append(failure);
  const prompts = u.doc.createElement('dl'); prompts.className = 'spawn-preview-prompts'; prompts.innerHTML = '<dt>Launch prompts</dt><dd>None.</dd>'; u.q('.spawn-preview-body').append(prompts);
  const root = u.dom.window.getComputedStyle(u.doc.documentElement);
  for (const [selector, surfaceSelector, fg, bg] of [
    ['.spawn-dialog-head h2', '.spawn-dialog', 'fg', 'surface'], ['.spawn-context', '.spawn-dialog', 'muted', 'surface'],
    ['.spawn-preview-title', '.spawn-preview', 'muted', 'surface-2'], ['.spawn-preview-facts dt', '.spawn-preview', 'muted', 'surface-2'], ['.spawn-preview-facts', '.spawn-preview', 'fg', 'surface-2'],
    ['.spawn-preview-facts dd .muted', '.spawn-preview', 'muted', 'surface-2'], ['.spawn-preview-name', '.spawn-preview', 'fg', 'surface-2'], ['.spawn-preview-home', '.spawn-preview', 'muted', 'surface-2'],
    ['.spawn-preview-facts .spawn-fact-sub', '.spawn-preview', 'muted', 'surface-2'], ['.spawn-preview-prompts dt', '.spawn-preview-prompts', 'muted', 'surface'], ['.spawn-preview-prompts dd', '.spawn-preview-prompts', 'muted', 'surface'], ['.spawn-preview-failure', '.spawn-preview', 'warn', 'surface-2'], ['.spawn-preview-note', '.spawn-preview', 'muted', 'surface-2'],
    ['.spawn-core-box', '.spawn-core-box', 'fg', 'surface'], ['.spawn-core-layer', '.spawn-core-box', 'muted', 'surface'], ['.spawn-core-row .muted', '.spawn-core-box', 'muted', 'surface'],
    ['.spawn-cap-list', '.spawn-cap-list', 'fg', 'surface'], ['.spawn-core-row .spawn-cap-why', '.spawn-core-row .spawn-cap-why', 'muted', 'tag-bg'], ['.spawn-cap-source', '.spawn-cap-source', 'muted', 'tag-bg'], ['.spawn-cap-why', '.spawn-cap-why', 'muted', 'tag-bg'],
    ['.spawn-seg input:checked + span', '.spawn-seg input:checked + span', 'accent', 'sel'], ['.spawn-seg input:not(:checked) + span', '.spawn-seg', 'muted', 'surface'],
  ]) {
    const pick = sel => u.ui.dialog.matches(sel) ? u.ui.dialog : u.q(sel);
    const element = pick(selector), surface = pick(surfaceSelector); assert.ok(element && surface, selector);
    assert.equal(u.style(element).color, `var(--${fg})`, selector);
    assert.match(u.style(surface).background || u.style(surface).backgroundColor, new RegExp(`var\\(--${bg}\\)`), surfaceSelector);
    const f = luminance(root.getPropertyValue(`--${fg}`).trim()), b = luminance(root.getPropertyValue(`--${bg}`).trim());
    assert.ok((Math.max(f, b) + .05) / (Math.min(f, b) + .05) >= 4.5, `${theme} ${selector}: ${fg} on ${bg}`);
    for (let parent = element; parent; parent = parent.parentElement) assert.equal(u.style(parent).opacity, '1', selector);
  }
  // The skeleton paints a token, no text: nothing to read, nothing to contrast.
  assert.match(spawnDialogCSS, /\.spawn-preview-skeleton span \{[^}]*background:var\(--tag-bg\)/);
  assert.doesNotMatch(spawnDialogCSS, /#[0-9a-f]{3,8}\b|rgba?\(/i, 'tokens only');
});

test('roster polls (sync) with unchanged facts never supersede the read in flight; a changed fact re-reads under latest intent', async t => {
  // A preview slower than the poll: each read waits on its own gate.
  const gates = [], cli = structuredClone(CLI);
  const u = mount(t, { cli, previews: async () => { const gate = deferred(); gates.push(gate); await gate.promise; return view(target, preview(['preview-worktree-default', 'preview-name', 'preview-worktree-purpose'][gates.length - 1])); } });
  await settle();
  const reads = () => u.calls.filter(c => c.path.startsWith('/api/workspace-spawn-preview')).length;
  assert.equal(reads(), 1); assert.equal(u.q('.spawn-preview').getAttribute('aria-busy'), 'true');
  for (let i = 0; i < 3; i++) { u.ui.sync(); await settle(); } // three polls while the read is in flight
  assert.equal(reads(), 1, 'a routine poll does not re-read');
  gates[0].resolve(); await settle(12);
  assert.equal(reads(), 1, 'nor restart the read when it settles'); assert.equal(u.q('.spawn-preview').getAttribute('aria-busy'), 'false');
  assert.equal(u.facts().Name, preview('preview-worktree-default').instance, 'the read settled and its facts are shown');
  u.ui.sync(); await settle(); assert.equal(reads(), 1, 'a settled preview stays put under polls');
  // A fact the preview depends on changes (the CLI's features): the next poll reads again.
  cli.features = [...cli.features, 'a-new-feature'];
  u.ui.sync(); await settle();
  assert.equal(reads(), 2);
  assert.equal(u.facts().Name, 'release-manager-1', 'the same choices: the last facts stay while it reads (no flash)');
  // It changes again while that read is in flight: latest intent wins, the superseded answer is never shown.
  cli.features = [...cli.features, 'another'];
  u.ui.sync(); await settle();
  gates[1].resolve(); await settle(12);
  assert.equal(reads(), 3, 'the superseded read is followed by one for the latest facts');
  assert.equal(u.facts().Name, 'release-manager-1', 'the superseded answer (api-gateway) is never shown');
  gates[2].resolve(); await settle(12);
  assert.equal(u.facts().Name, 'release-manager-api-v2', 'the latest read is shown'); assert.equal(reads(), 3);
});

const reads = u => u.calls.filter(c => c.path.startsWith('/api/workspace-spawn-preview')).length;
const refusal = (code, message = code) => ({ spawnPreviewViewApi: 1, status: 'unavailable', target, data: null, reason: { code, message } });

test('a preview that settled on a transient failure (E_CLI_FAILED) is read again by the next poll; a settled success is not', async t => {
  let n = 0;
  const u = mount(t, { previews: () => { if (n++ === 0) throw Object.assign(new Error('boom'), { code: 'E_CLI_FAILED' }); return view(target, preview('preview-worktree-default')); } });
  await settle(12);
  assert.equal(reads(u), 1); assert.ok(u.q('.spawn-preview-failure'), 'the failure is shown'); assert.equal(u.q('.fspawn').disabled, true);
  u.ui.sync(); await settle(12); // a routine poll, no fact changed
  assert.equal(reads(u), 2, 'the poll retries the failed read');
  assert.equal(u.facts().Name, preview('preview-worktree-default').instance); assert.equal(u.text('.fstatus'), 'Preview ready');
  for (let i = 0; i < 3; i++) { u.ui.sync(); await settle(); }
  assert.equal(reads(u), 2, 'a settled success stands under polls while its facts are unchanged');
});

test('E_BUSY (the server\'s two-read budget) is retried inside the dialog, never shown as a failure', async t => {
  let n = 0;
  const u = mount(t, { previews: () => n++ < 2 ? refusal('E_BUSY', 'The workspace is busy.') : view(target, preview('preview-worktree-default')) });
  await settle(20);
  assert.equal(reads(u), 3, 'retried until a slot was free');
  assert.equal(u.q('.spawn-preview-failure'), null); assert.equal(u.q('.fstatus').classList.contains('err'), false);
  assert.equal(u.facts().Name, preview('preview-worktree-default').instance); assert.equal(u.text('.fstatus'), 'Preview ready');
});

test('a name refusal is not retried by a poll: it waits for the operator to change the name', async t => {
  const taken = kernel('preview-name-taken').error;
  const u = mount(t, { previews: () => refusal(taken.code, taken.message) });
  await settle(12);
  assert.equal(reads(u), 1); assert.ok(u.q('.spawn-name-result').classList.contains('err'));
  for (let i = 0; i < 3; i++) { u.ui.sync(); await settle(); }
  assert.equal(reads(u), 1);
});

test('a workspace-id change under the open dialog re-previews for the new workspace and settles there', async t => {
  let ws = 'northwind';
  const u = mount(t, { workspace: () => ({ id: ws, name: ws }),
    previews: () => view({ ...target, workspace: ws }, preview(ws === 'northwind' ? 'preview-worktree-default' : 'preview-worktree-purpose')) });
  await settle(12);
  assert.equal(u.facts().Name, 'release-manager-1');
  ws = 'northwind-2'; u.ui.sync(); await settle(12);
  assert.equal(reads(u), 2); assert.match(u.calls.at(-1).path, /ws=northwind-2$/, 'read for the new workspace');
  assert.equal(u.facts().Name, 'release-manager-api-v2', 'the new workspace\'s answer is shown'); assert.equal(u.text('.fstatus'), 'Preview ready');
});
