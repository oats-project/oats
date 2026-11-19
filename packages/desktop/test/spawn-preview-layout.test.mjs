// The spawn preview's "What will be created" column (Spec B, item 5): the instance first and largest
// with its home beneath, then the facts in one order (Works in, Harness, Team, Relationship, Runs on),
// the launch-prompt policy as a note after them, and the facts stacking label-above-value in a narrow
// column. The dialog is mounted with a stubbed ctx answering the kernel captures (fixtures/workspace-v2/f3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createSpawnDialog, spawnDialogCSS, SPAWN_NARROW } from '../renderer/spawn-dialog.mjs';
import { homeText, worktreeText, relationText } from '../../client/spawn-preview-facts.mjs';
import { identityCSS } from '../renderer/identity-marks.mjs';
import { cli as CLI, kernel, ROOT, target, view } from './helpers/spawn-preview-fixture.mjs';

const themeCSS = readFileSync(new URL('../renderer/theme.css', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function settle(n = 12) { for (let i = 0; i < n; i++) await tick(); }
const soul = { name: 'release-manager', description: 'Cuts releases.', kind: 'persistent', work: 'worktree', agentsRoot: ROOT, soulKind: 'member', origin: 'member', repoName: 'agents' };
const preview = name => kernel(name).result;

function mount(t, data, chosen = soul) {
  const asked = { ...target, selector: { soul: chosen.name, agentsRoot: chosen.agentsRoot } };
  const dom = new JSDOM('<!doctype html><html data-theme="light"><body><div class="oats-view"><div class="spawn-modal"></div></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
  const doc = dom.window.document;
  for (const source of [themeCSS, identityCSS, spawnDialogCSS]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
  const ctx = { api: async path => {
    if (path.startsWith('/api/workspace-spawn-preview')) return view(asked, data);
    if (path === '/api/models') return { models: [] };
    if (path.startsWith('/api/launch-configs')) return { configurations: [] };
    throw new Error(`unexpected ${path}`);
  } };
  const ui = createSpawnDialog(doc.querySelector('.spawn-modal'), { ctx, soul: chosen, agents: [chosen], workspace: () => ({ id: 'northwind', name: 'northwind' }), cli: () => CLI,
    owns: () => true, canChoose: () => true, choose: () => {}, close: () => {}, servers: [], delay: 0, busyDelay: 0 });
  ui.start();
  t.after(() => { ui.dispose(); dom.window.close(); });
  return { doc, q: selector => ui.dialog.querySelector(selector), all: selector => [...ui.dialog.querySelectorAll(selector)] };
}

test('homeText: relative to the deployment when the home lies inside it, else the last three segments; the full path is the title', () => {
  const dir = '/fixture/base/northwind-workspace', home = `${dir}/agents/release-manager/instances/release-manager-1`;
  assert.deepEqual(homeText(home, dir), { text: 'agents/release-manager/instances/release-manager-1', title: home });
  assert.deepEqual(homeText(home, `${dir}/`), { text: 'agents/release-manager/instances/release-manager-1', title: home }, 'a trailing slash on the deployment');
  const outside = '/srv/elsewhere/agents/release-manager/instances/release-manager-1';
  assert.deepEqual(homeText(outside, dir), { text: '…/release-manager/instances/release-manager-1', title: outside });
  assert.deepEqual(homeText(`${dir}-other/agents/x/instances/x-1`, dir), { text: '…/x/instances/x-1', title: `${dir}-other/agents/x/instances/x-1` }, 'a sibling directory sharing the prefix is not inside it');
  assert.deepEqual(homeText('/a/b', null), { text: '/a/b', title: '/a/b' }, 'short paths stay whole');
  assert.equal(homeText(null, dir), null); assert.equal(homeText('', dir), null);
});

test('worktreeText and relationText: the branch and its base, the relation with its anchor', () => {
  assert.deepEqual(worktreeText({ branch: 'agents/api-2', base: { ref: 'origin/main', oid: 'a'.repeat(40) } }), { lead: 'worktree · branch ', branch: 'agents/api-2', tail: ' from origin/main' });
  assert.deepEqual(worktreeText({ branch: 'agents/api-2', base: null }), { lead: 'worktree · branch ', branch: 'agents/api-2', tail: '' });
  assert.equal(relationText({ relation: null }), null); assert.equal(relationText({}), null);
  const anchored = kind => ({ relation: kind, decision: { effective: { relation: { kind, anchor: { instance: 'dev-1', agentsRoot: ROOT } } } } });
  assert.equal(relationText(anchored('child')), 'child of dev-1');
  assert.equal(relationText(anchored('sibling')), 'sibling of dev-1');
  assert.equal(relationText(anchored('parent')), 'parent of dev-1');
  assert.equal(relationText({ relation: 'child' }), 'child of');
  assert.equal(relationText({ relation: 'cousin' }), 'cousin', 'an unknown kind verbatim');
});

test('the column reads in one order: the instance and its home, then Works in, Harness, Team, Relationship; the launch prompts last, apart', async t => {
  const data = structuredClone(preview('preview-worktree-default'));
  const anchor = { instance: 'dev-1', agentsRoot: ROOT };
  data.relation = 'child'; data.decision.effective.relation = { kind: 'child', anchor };
  data.launchPromptAnswers = { awebDevelopmentChannel: false, consentSource: null };
  const u = mount(t, data); await settle();
  const body = u.q('.spawn-preview-created .spawn-preview-body');
  assert.deepEqual([...body.children].map(c => c.className), ['spawn-preview-identity', 'spawn-preview-facts', 'spawn-preview-prompts']);
  assert.deepEqual(u.all('.spawn-preview-identity dd').map(dd => [dd.className, dd.textContent]),
    [['spawn-preview-name', data.instance], ['spawn-preview-home', 'agents/release-manager/instances/release-manager-1']]);
  assert.equal(u.q('.spawn-preview-home').title, data.home);
  assert.deepEqual(u.all('.spawn-preview-facts dt').map(dt => dt.textContent), ['Works in', 'Harness', 'Team', 'Relationship']);
  const value = label => u.all('.spawn-preview-facts dt').find(dt => dt.textContent === label).nextElementSibling;
  assert.equal(value('Works in').textContent, 'worktree · branch agents/release-manager-1 from HEAD');
  assert.equal(value('Works in').querySelector('.mono').textContent, 'agents/release-manager-1');
  assert.equal(value('Harness').querySelector('.spawn-preview-harness').textContent.trim().endsWith('Pi · default model'), true);
  assert.equal(value('Harness').querySelector('.spawn-fact-sub').textContent, 'native default', 'where it came from, on its own muted line');
  assert.equal(value('Relationship').textContent, 'child of dev-1');
  assert.equal(u.q('.spawn-preview-prompts dt').textContent, 'Launch prompts');
  assert.equal(u.q('.spawn-preview-prompts dd').textContent, 'None. The launcher will not answer prompts for this home. This policy does not confirm readiness.');
});

test('an independent spawn has no Relationship row; other work modes say Works in as before', async t => {
  // The contract binds a base to every worktree decision, so the branch-only wording is worktreeText's alone (above).
  const triager = { ...soul, name: 'support-triager', work: 'directory' };
  const u = mount(t, structuredClone(preview('preview-directory')), triager); await settle();
  const labels = u.all('.spawn-preview-facts dt').map(dt => dt.textContent);
  assert.equal(labels.includes('Relationship'), false);
  assert.equal(u.all('.spawn-preview-facts dt').find(dt => dt.textContent === 'Works in').nextElementSibling.textContent, 'own folder · free to work across repos');
  assert.equal(u.q('.spawn-preview-prompts'), null, 'no policy reported: no note');
});

test('type and rhythm: labels 11.5px muted, values 12.5px fg at line-height ≥1.45; the facts stack label-above-value below ~300px', () => {
  const rule = selector => spawnDialogCSS.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`, 'm'))?.[1] ?? '';
  assert.match(rule('.spawn-preview-facts'), /font-size:12\.5px; line-height:1\.5; color:var\(--fg\)/);
  assert.match(rule('.spawn-preview-facts dt'), /color:var\(--muted\); font-size:11\.5px;/);
  assert.match(rule('.spawn-preview-name'), /color:var\(--fg\); font-weight:650; font-size:13\.5px; line-height:1\.45; font-family:var\(--mono,monospace\)/);
  assert.match(rule('.spawn-preview-home'), /color:var\(--muted\); font-weight:normal; font-size:11\.5px; line-height:1\.45; font-family:var\(--mono,monospace\)/);
  assert.match(rule('.spawn-preview'), /container:spawn-preview \/ inline-size/);
  const narrow = spawnDialogCSS.match(/@container spawn-preview \(max-width:299px\) \{([\s\S]*?)\n\}/);
  assert.ok(narrow, 'a container query on the preview column');
  assert.match(narrow[1], /\.spawn-preview-facts \{ grid-template-columns:minmax\(0,1fr\);/, 'one column: the label above its value');
});

test('the footer: Cancel and Start are one right-aligned group after the status, which yields first; Advanced\'s topics wrap under its link', async t => {
  const u = mount(t, structuredClone(preview('preview-worktree-default'))); await settle();
  const footer = u.q('.spawn-footer');
  assert.deepEqual([...footer.children].map(el => el.className), ['spawn-status', 'spawn-actions', 'spawn-problem-detail'], 'the status, then the one actions group, then the details line');
  assert.deepEqual([...u.q('.spawn-actions').children].map(el => el.textContent), ['Cancel', 'Start'], 'Cancel then Start, together');
  // The group never wraps or shrinks apart and sits at the right; the status takes what is left and wraps its own text.
  assert.match(spawnDialogCSS, /\.spawn-actions \{ flex:none; display:flex; align-items:center; gap:8px; margin-left:auto; \}/);
  assert.match(spawnDialogCSS, /\.spawn-status \{ flex:1 1 160px; min-width:0;/);
  // Advanced: a dim link whose topics wrap with it (never widening the sheet).
  assert.match(spawnDialogCSS, /\.spawn-advanced > summary \{[^}]*flex-wrap:wrap; max-width:100%;/);
  assert.match(spawnDialogCSS, /\.spawn-advanced > summary small \{ min-width:0;/);
});

// Slice 5: one column at every width. What will be created is the last of Advanced, in the form's own scroll area,
// above the footer, which stays in view; the compact line under the fields says it in one line.
test('What will be created is the last of Advanced, in the form\'s scroll area above the footer; the compact line says it under the fields', async t => {
  const u = mount(t, structuredClone(preview('preview-worktree-default'))); await settle();
  const body = u.q('.spawn-form-body'), aside = u.q('.spawn-preview'), task = u.q('.ftask'), footer = u.q('.spawn-footer');
  assert.ok(body.contains(aside), 'inside the form\'s scroll area'); assert.equal(u.q('.spawn-advanced-body').lastElementChild, aside, 'the last of Advanced');
  assert.equal(u.q('.spawn-form').lastElementChild, footer, 'the footer stays outside the scroll, in view');
  const before = (a, b) => !!(a.compareDocumentPosition(b) & 4); // DOCUMENT_POSITION_FOLLOWING
  assert.ok(before(task, aside) && before(aside, footer), 'reading and tab order: Task, the fields, the preview, the footer');
  assert.equal(u.q('.spawn-columns'), null, 'no columns');
  assert.equal(u.q('.spawn-preview-line').textContent, 'Creates release-manager-1 · Pi · Pi\'s default model · worktree on agents/release-manager-1');
  assert.equal(u.q('.spawn-advanced').nextElementSibling, null); assert.equal(u.q('.spawn-preview-line').nextElementSibling, u.q('.spawn-advanced'), 'right above Advanced');
  // Narrow: only paddings and the two-up rows change.
  const narrow = spawnDialogCSS.match(/@media\(max-width:760px\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.equal(SPAWN_NARROW, '(max-width:760px)'); assert.match(narrow, /\.spawn-row \{ grid-template-columns:minmax\(0,1fr\); \}/);
  assert.doesNotMatch(spawnDialogCSS, /data-layout/);
});
