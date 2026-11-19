// The New agent form (Desktop UI rework, slice 5; guide steps 22 to 24): the spec's pinned acceptance tests. The form is
// the spawn dialog, mounted in the real Workspace view with the real preview boundary and apply broker; the kernel is the
// f3 captures, and a naming kernel shaped like spawn-suggest-name's answers. No harness, process or session is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountSpawn, settle, kernel, kernelPreviewName, catalogAgents, deferred } from './helpers/spawn-dialog-host.mjs';
import { cli as CLI } from './helpers/spawn-preview-fixture.mjs';
import { creation } from './helpers/spawn-apply-fixture.mjs';
import { quickOpenRows } from '../renderer/quick-open.mjs';
import * as spawn from '../renderer/views/spawn.mjs';

const SUGGEST_CLI = { ...structuredClone(CLI), features: [...CLI.features, 'spawn-suggest-name'] };
const envelope = v => ({ schemaVersion: 1, ok: true, result: v });
const DEFAULT = kernel('preview-worktree-default').result;
const named = name => JSON.parse(JSON.stringify(DEFAULT).replaceAll(DEFAULT.instance, name));
/** A kernel that names from the task (spawn-suggest-name): suggest reads answer `release-notes-manager`; `--name`
 * previews the named capture; everything else the f3 captures. */
function namingKernel() {
  const asked = [];
  const invoke = async (_cli, args) => {
    if (args.task !== undefined) {
      asked.push(args.task);
      return envelope({ ...named('release-notes-manager'), naming: { source: 'suggested', ms: 900, harness: 'pi', model: null } });
    }
    if (args.choices.name) return envelope(named(args.choices.name));
    return kernel(kernelPreviewName(args.target.selector.soul, args.choices));
  };
  return { invoke, asked };
}
const apply = args => ({ started: true, envelope: envelope(creation(args.choices.name ? named(args.choices.name) : DEFAULT)) });
const shown = el => !!el && !el.hidden && !el.closest('[hidden]');
/** Whether `el` is in the form itself, not behind Advanced. */
const onForm = el => shown(el) && !el.closest('.spawn-advanced');
const key = (u, target, init) => target.dispatchEvent(new u.dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
/** Type into a field the way a person does: one input event per value. */
async function typeInto(u, el, value) { el.value = value; el.dispatchEvent(new u.dom.window.Event('input', { bubbles: true })); await settle(); }

test('slice5 form fields', async t => {
  const k = namingKernel(), u = await mountSpawn(t, { cli: SUGGEST_CLI, spawnName: true, kernel: k.invoke });
  await u.open();
  // Soul, Task and Harness are the form; the soul's default harness is marked and chosen.
  assert.ok(onForm(u.q('.spawn-soul')), 'Soul'); assert.ok(onForm(u.q('.ftask')), 'Task'); assert.ok(onForm(u.q('.spawn-harness')), 'Harness');
  assert.equal(u.q('.ftask').tagName, 'TEXTAREA', 'Task is multi-line');
  assert.deepEqual([...u.q('.fharness').querySelectorAll('input')].map(i => i.value), ['claude', 'codex', 'pi'], 'claude · codex · pi');
  assert.equal(u.q('.fharness input:checked').value, 'pi', 'the soul\'s default (the f3 preview launches pi) is chosen');
  const marked = [...u.q('.fharness').querySelectorAll('.spawn-harness-default')].filter(m => !m.hidden);
  assert.equal(marked.length, 1); assert.equal(marked[0].closest('label').querySelector('input').value, 'pi', 'and marked');
  // One machine: no Where.
  assert.equal(shown(u.q('.spawn-place')), false, 'no Where with one machine');
  // No Name in the form (the kernel names it: it is Advanced's override), no Relationship anywhere (D6).
  assert.equal(onForm(u.q('.spawn-name')), false, 'no Name field in the form');
  assert.ok(u.q('.spawn-advanced').contains(u.q('.spawn-name')), 'the kernel name is Advanced\'s');
  assert.equal(u.q('.spawn-relationship, .frelation, .frelto'), null, 'no relation picker');
  assert.doesNotMatch(u.dialog().textContent, /Relationship|Child of|Sibling of|Parent of/);
  // Advanced is hidden by default; the copy says agent.
  assert.equal(u.q('.spawn-advanced').open, false);
  assert.equal(u.text('#spawn-dialog-title'), 'New agent');
  assert.match(u.q('.ftask').placeholder, /this agent/);

  // Two machines (this computer and a registered one): Where is in the form.
  const two = await mountSpawn(t, { cli: SUGGEST_CLI, spawnName: true, kernel: k.invoke, servers: [{ id: 'devbox', label: 'devbox' }] });
  await two.open();
  assert.ok(onForm(two.q('.spawn-place')), 'Where with two machines');
  assert.deepEqual([...two.q('.fserver').options].map(o => o.value), ['', 'devbox']);
});

test('slice5 soul filter by typing', async t => {
  const base = catalogAgents(), row = base.find(a => a.name === 'release-manager');
  const agents = [...base, { ...row, name: 'kernel-developer', description: 'Builds the kernel.' }, { ...row, name: 'desktop-developer', description: 'Builds the Desktop.' }];
  const u = await mountSpawn(t, { agents });
  // Quick Open's key and the sidebar's New agent open the form on its Soul list, the list's text field focused.
  spawn.preselectSpawn({ soulFirst: true }); await settle();
  assert.equal(u.dialog().dataset.step, 'soul');
  const search = u.q('.spawn-soul-search');
  assert.equal(u.doc.activeElement, search, 'the soul list is first');
  assert.equal(search.getAttribute('role'), 'combobox');
  assert.ok(u.q('.spawn-soul-list [role=option]'), 'each soul is listed');
  assert.match(u.q('.spawn-soul-option[data-agent="release-manager"]').textContent, /Cuts, verifies and announces platform releases/, 'with its description');
  await typeInto(u, search, 'dev');
  const matches = quickOpenRows(agents, 'dev', { limit: Infinity }).map(r => r.soul.name);
  assert.deepEqual([...u.dialog().querySelectorAll('.spawn-soul-option')].map(o => o.dataset.agent), matches, 'filtered as Quick Open filters');
  assert.ok(matches.length >= 2);
  key(u, search, { key: 'ArrowDown' }); await settle(2);
  assert.equal(u.doc.getElementById(search.getAttribute('aria-activedescendant')).dataset.agent, matches[1], '↓ moves to the second match');
  key(u, search, { key: 'Enter' }); await settle();
  // Enter chooses it and the form goes on to Task.
  assert.equal(u.dialog().dataset.step, undefined, 'the form, on the chosen soul');
  assert.match(u.text('.spawn-soul-current'), new RegExp(matches[1]));
  assert.equal(u.doc.activeElement, u.q('.ftask'), 'Task is focused');
});

test('slice5 spawn uses suggest-name', async t => {
  const k = namingKernel();
  const u = await mountSpawn(t, { cli: SUGGEST_CLI, spawnName: true, kernel: k.invoke, apply, suggestDelay: 5, jobs: true });
  await u.open();
  assert.equal(onForm(u.q('.spawn-name')), false, 'no name field: the kernel names it');
  await typeInto(u, u.q('.ftask'), 'Write the release notes for the next version');
  await new Promise(r => setTimeout(r, 20)); await settle();
  assert.deepEqual(k.asked, ['Write the release notes for the next version'], 'the kernel was asked to name it from its task');
  assert.match(u.text('.spawn-task-hint'), /Named release-notes-manager from its task/);
  assert.match(u.text('.spawn-preview-line'), /Creates release-notes-manager/, 'the compact preview names it');
  key(u, u.q('.ftask'), { key: 'Enter' }); await settle(20);
  const job = u.jobs.rows('northwind')[0] ?? null;
  assert.equal(job?.instance, 'release-notes-manager', 'the roster shows the suggested words');
  assert.equal(u.applied.at(-1)?.choices.name, 'release-notes-manager', 'and the spawn binds them');
});

test('slice5 older kernel falls back to naming', async t => {
  // spawn-name, but no spawn-suggest-name: today's Name field, in the form, with one dim line saying why.
  const u = await mountSpawn(t, { spawnName: true });
  await u.open();
  assert.ok(onForm(u.q('.spawn-name')), 'the Name field is in the form');
  assert.ok(onForm(u.q('.spawn-naming-fallback')));
  assert.match(u.text('.spawn-naming-fallback'), /can't name an agent from its task/);
  assert.match(u.text('.spawn-name label'), /^Name/);
  await u.type('.fpurpose', 'notes');
  assert.equal(u.previews().at(-1).choices.name, 'notes', 'a typed name goes as today');
});

test('slice5 advanced holds every other option', async t => {
  const cli = { ...structuredClone(SUGGEST_CLI), features: [...SUGGEST_CLI.features, 'instance-background', 'settings-declared'] };
  const u = await mountSpawn(t, { cli, spawnName: true, kernel: namingKernel().invoke, servers: { servers: [], filtered: true, deployment: '/d', aweb: false } });
  await u.open();
  const advanced = u.q('.spawn-advanced');
  // Everything today's dialog offered beyond Soul, Task, Harness and Where: model, the kernel name, work base and branch,
  // background, permissions, launch configuration, session backend, wake, add a machine, and the full preview.
  for (const selector of ['.fmodel', '.fpurpose', '.fbase', '.fbranch', '.spawn-work', '.spawn-background', '.fyolo', '.flaunch', '.fbackend',
    '.fwake-enabled', '.spawn-add-machine-button', '.spawn-preview', '.spawn-teams', '.spawn-identity']) {
    const el = u.q(selector); assert.ok(el, selector);
    assert.ok(advanced.contains(el), `${selector} is in Advanced`);
  }
  assert.ok(advanced.querySelector('.spawn-preview .spawn-preview-title'), 'What will be created stays, in full');
  // Its key (today's dialog-local chord, spawn.toggleAdvanced) opens it.
  assert.equal(u.q('.spawn-advanced > summary').textContent.startsWith('Advanced'), true);
});

test('slice5 submit waits for preview', async t => {
  const gate = deferred();
  let hold = false;
  const u = await mountSpawn(t, { jobs: true, previewGate: async body => { if (hold && body?.action === 'preview') await gate.promise; } });
  await u.open();
  hold = true;
  await u.type('.fpurpose', 'api-v2'); // a new input: its preview is held
  key(u, u.q('.ftask'), { key: 'Enter' }); await settle();
  assert.ok(u.dialog(), 'the sheet stays while the preview for these inputs has not answered');
  assert.equal(u.spawns().length, 0, 'nothing is prepared');
  assert.equal(u.jobs.rows('northwind').length, 0, 'nothing is handed off');
  assert.equal(u.q('.fspawn').textContent, 'Checking…', 'the press is held, and says so');
  gate.resolve(); await settle(30);
  assert.equal(u.dialog(), null, 'once it answered, the press goes on and the sheet closes');
  assert.equal(u.jobs.rows('northwind')[0]?.instance, 'release-manager-api-v2');
});

test('slice5 sheet closes and row pulses', async t => {
  const u = await mountSpawn(t, { jobs: true });
  await u.open();
  await typeInto(u, u.q('.ftask'), 'Cut the release');
  // Shift+Enter is a newline: nothing starts.
  assert.equal(key(u, u.q('.ftask'), { key: 'Enter', shiftKey: true }), true, 'Shift+Enter is the textarea\'s');
  assert.ok(u.dialog());
  // Enter starts it: the sheet closes at once, the row is pending and followed.
  key(u, u.q('.ftask'), { key: 'Enter' });
  assert.equal(u.dialog(), null, 'closed at once');
  const [job] = u.jobs.rows('northwind');
  assert.equal(job?.instance, DEFAULT.instance);
  assert.deepEqual(u.followed, [job.id], 'the shell reveals its row and follows it');
  // The pending row's dot pulses (respecting reduced motion), and the follow opens its terminal without input focus.
  const read = name => readFileSync(new URL(`../renderer/${name}`, import.meta.url), 'utf8');
  const shell = read('shell.mjs'), css = read('shell.css');
  assert.match(shell, /mark\.className = unknown && !checking \? "ctx-dot unknown" : "ctx-dot starting";/);
  assert.match(css, /\.ctx-dot\.starting \{[^}]*animation: ctx-dot-starting/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.ctx-dot\.starting \{ animation: none; \} \}/);
  const follow = shell.slice(shell.indexOf('const spawnFollow = createSpawnFollow({'), shell.indexOf('markNew: (row, workspace)'));
  assert.match(follow, /openTerminalTab\(target, \{ quiet: true, expected: target, valid, followed: true, focusContent: false \}\)/, 'no input focus is taken');
  assert.match(follow, /await showInRoster\(row, \{ read: false \}\);/, 'focus stays on its roster row');
});
