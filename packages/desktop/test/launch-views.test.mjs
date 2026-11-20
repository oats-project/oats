// Soul launch preferences in the views (feature launch-preference, OATS 0.30; docs/desktop-cli-api.md
// "Launch preferences", oats feat/030-launch-preference @76cd1843; decoders in #287). Consumer-first:
// the kernel does not emit `launch` yet, so each Launch here is DERIVED (marked) from the contract's
// example onto the REAL 0.30 captures (fixtures/team-model-v2). Recapture when the kernel lands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createSoulInspector } from '../renderer/soul-inspector.mjs';
import { LAUNCH_REFUSED_HERE } from '../../client/soul-facts.mjs';
import { setWorkspace, currentWorkspace } from '../renderer/views/common.mjs';
import { refreshCli, resetCliStateForTests } from '../renderer/views/cli-status.mjs';
import { LAUNCH_FROM, launchFromText, launchModelText, declaredText, launchAtText, shownLaunch } from '../../client/launch-view.mjs';
import { launchHint } from '../renderer/spawn-dialog.mjs';
import { spawnProblem } from '../../client/spawn-messages.mjs';
import { spawnText } from '../renderer/spawn-words.mjs';
import { previewData } from '../../client/spawn-preview-contract.mjs';
import { target } from './helpers/spawn-preview-fixture.mjs';

const v2 = name => JSON.parse(readFileSync(new URL(`./fixtures/team-model-v2/${name}.json`, import.meta.url), 'utf8'));
const version = v2('version');
const FEATURED = { ...version, features: [...version.features, 'launch-preference'] };
const agentsRoot = '/fixture/base/northwind-workspace/agents';
const tick = () => new Promise(r => setTimeout(r, 0));
// DERIVED: the contract's example, a machine override of the soul's declared preference.
const OVERRIDE = () => ({ declared: { harness: 'claude', model: 'claude-opus-5-5' }, effective: { harness: 'codex', model: null, launchConfig: null },
  from: 'local', at: 'oats-local.yaml#/souls/launch/oats.engineering~1code-reviewer', problem: null });
const SOUL_PREF = () => ({ declared: { harness: 'claude', model: 'claude-opus-5-5' }, effective: { harness: 'claude', model: 'claude-opus-5-5', launchConfig: null },
  from: 'soul', at: 'local//fixture/base/fx/remotes/agents.git:souls/release-manager/soul.yaml#/launch', problem: null });
const MISSING = () => ({ ...SOUL_PREF(), problem: { code: 'E_HARNESS_UNAVAILABLE', message: 'harness claude is not installed on this machine',
  fix: 'install claude, or override it on this machine in oats-local.yaml souls.launch' } });

async function inspector(t, launch, { layout, cli = FEATURED, agentLaunch } = {}) {
  await refreshCli({ api: async () => ({ ...cli, ok: true, bin: '/fixture/bin/oats' }) });
  const previous = currentWorkspace(); setWorkspace('/team');
  const inspected = { ...v2('inspect-soul').result, ...(launch ? { launch } : {}) };
  const dom = new JSDOM('<body><main><aside hidden></aside></main></body>'), el = dom.window.document.querySelector('aside');
  const view = createSoulInspector(el, { ...(layout ? { layout } : {}), ctx: { api: async (url) => url.startsWith('/api/workspace-soul-teams')
    ? { status: 'ok', soulTeams: { soul: 'release-manager', teams: [], defaultTeam: null, at: null } } : structuredClone(inspected) } });
  t.after(() => { view.dispose(); dom.window.close(); setWorkspace(previous); resetCliStateForTests(); });
  await view.show({ agent: { name: 'release-manager', agentsRoot, key: 'release-manager', ...(agentLaunch ? { launch: agentLaunch } : {}) }, selector: { soul: 'release-manager', agentsRoot } });
  for (let i = 0; i < 4; i++) await tick();
  const facts = () => Object.fromEntries([...el.querySelectorAll('.inspector-launch dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent]));
  return { el, facts };
}

test('the words: every from, a null model, where it is set, and the soul\'s own preference only when it differs', () => {
  assert.deepEqual({ ...LAUNCH_FROM }, { flag: 'chosen for this spawn', local: 'set for this soul on this computer', 'local-default': "this computer's default for every soul",
    soul: "the soul's preference", host: 'no preference set: the host default', recorded: 'recorded when it was spawned' });
  assert.equal(launchFromText('later'), 'from: later', 'an unknown from is said as sent');
  assert.equal(launchModelText({ harness: 'codex', model: null }), "Codex's default model");
  assert.equal(launchAtText(OVERRIDE().at), 'Set in oats-local.yaml › souls › launch › oats.engineering/code-reviewer, on this computer', 'JSON pointer unescaped');
  assert.equal(launchAtText('package:oats.engineering:souls/code-reviewer/soul.yaml#/launch'), 'Set in souls/code-reviewer/soul.yaml › launch, in the oats.engineering package');
  assert.equal(launchAtText(null), null, 'a flag or the host default: nowhere to point');
  assert.equal(declaredText(OVERRIDE()), 'The soul prefers Claude Code · claude-opus-5-5; this computer runs Codex.');
  assert.equal(declaredText({ ...SOUL_PREF(), effective: { harness: 'claude', model: 'claude-sonnet-5', launchConfig: null } }),
    'The soul prefers Claude Code · claude-opus-5-5; this computer runs Claude Code with claude-sonnet-5.');
  assert.equal(declaredText(SOUL_PREF()), null, 'the same: said once');
  assert.equal(declaredText({ ...OVERRIDE(), declared: null }), null, 'none declared: nothing to compare');
  assert.equal(shownLaunch(SOUL_PREF(), version), null, 'gated on the feature');
});

test('side panel: Harness shows the effective harness and model, what chose them, where, and the soul\'s own preference when overridden', async t => {
  const u = await inspector(t, OVERRIDE());
  assert.deepEqual(u.facts(), { Harness: 'Codex', Model: "Codex's default model", 'Chosen by': 'set for this soul on this computer', 'The soul prefers': 'Claude Code · claude-opus-5-5' });
  assert.equal(u.el.querySelector('.inspector-launch .launch-at').textContent, 'Set in oats-local.yaml › souls › launch › oats.engineering/code-reviewer, on this computer');
  assert.doesNotMatch(u.el.textContent, /No default harness|Default harness/);
  const same = await inspector(t, { ...SOUL_PREF(), effective: { ...SOUL_PREF().effective, launchConfig: 'opus' } });
  assert.deepEqual(same.facts(), { Harness: 'Claude Code', Model: 'claude-opus-5-5', 'Launch configuration': 'opus', 'Chosen by': "the soul's preference" });
  // The roster row's launch when the inspection has none (the same kernel report).
  const fromRow = await inspector(t, null, { agentLaunch: SOUL_PREF() });
  assert.equal(fromRow.facts().Harness, 'Claude Code');
});

/** The box as it reads: the Desktop's line, the kernel's lines, the code behind its own Details (the box may sit inside
 * another disclosure: the soul page's Ready), and its elements. */
const boxOf = box => ({ own: box.querySelector('.launch-problem-own')?.textContent, said: [...box.querySelectorAll('.launch-problem-said')].map(p => p.textContent),
  code: box.querySelector(':scope > details p').textContent, children: [...box.children].map(c => `${c.tagName.toLowerCase()}${c.className ? `.${c.className}` : ''}`) });
const REFUSED_HERE = 'A spawn of this soul with no launch chosen would be refused here.';

test('side panel: a missing harness reads as the Desktop\'s line, then the kernel\'s message and fix under its name, the code behind Details', async t => {
  const u = await inspector(t, MISSING());
  const box = u.el.querySelector('.inspector-launch .launch-problem');
  assert.equal(box.getAttribute('role'), 'note');
  assert.equal(LAUNCH_REFUSED_HERE, REFUSED_HERE);
  assert.deepEqual(boxOf(box), { own: REFUSED_HERE, said: ['OATS says: harness claude is not installed on this machine', 'install claude, or override it on this machine in oats-local.yaml souls.launch'],
    code: 'E_HARNESS_UNAVAILABLE', children: ['p.launch-problem-own', 'p.launch-problem-said', 'p.launch-problem-said', 'details'] });
  assert.equal(box.querySelector('.launch-problem-message, .launch-problem-fix'), null, 'the kernel\'s texts no longer stand alone');
  assert.equal(u.facts().Harness, 'Claude Code', 'the soul still lists its launch');
});

/* ── #1015: one rule for every launch problem, on the page and in the panel. The texts are this file's own. ── */
const SAID = 'the file points "ghost" at a launch and no soul answers to that name', REMEDY = 'point the entry at a soul, then drop "ghost"';
const problemOf = (code, message = SAID, fix = REMEDY) => ({ ...SOUL_PREF(), problem: { code, message, fix } });
// On the soul page (slice 3a) a launch problem is its Ready row's: the sentence, and this box behind Details.
const BOXES = [['side panel', undefined, '.inspector-launch .launch-problem'], ['soul page', 'page', '.soul-ready-problems .launch-problem']];

for (const [place, layout, selector] of BOXES) test(`${place}: every launch problem reads the same way, keyed on no code: the Desktop's line, "OATS says:" before the kernel's message, its fix under it`, async t => {
  // The six codes a Launch report can carry, and one the Desktop has never seen.
  for (const code of ['E_LAUNCH_PREFERENCE_UNMATCHED', 'E_LAUNCH_CONFIG_UNKNOWN', 'E_LAUNCH_CONFIG_AMBIGUOUS', 'E_CLAUDE_CONFIG_REMOVED', 'E_HARNESS_UNAVAILABLE', 'E_LAUNCH_EXECUTABLE', 'E_SOMETHING_NEW']) {
    const u = await inspector(t, problemOf(code), layout ? { layout } : {});
    assert.deepEqual(boxOf(u.el.querySelector(selector)), { own: REFUSED_HERE, said: [`OATS says: ${SAID}`, REMEDY], code,
      children: ['p.launch-problem-own', 'p.launch-problem-said', 'p.launch-problem-said', 'details'] }, code);
    // The Desktop's line holds nothing of the kernel's texts.
    assert.equal(REFUSED_HERE.includes('ghost'), false);
  }
});

for (const [place, layout, selector] of BOXES) test(`${place}: no text of the kernel's stands without its name, and each goes through the filter alone`, async t => {
  const HIDDEN = 'token: abc123 was in the file', long = 'word '.repeat(204).trim(), longer = 'step '.repeat(204).trim();
  const rows = [
    [SAID, REMEDY, [`OATS says: ${SAID}`, REMEDY]],
    [HIDDEN, REMEDY, ['[withheld]', `OATS says: ${REMEDY}`]],
    [' ', REMEDY, [`OATS says: ${REMEDY}`]],
    [SAID, HIDDEN, [`OATS says: ${SAID}`, '[withheld]']],
    [SAID, ' ', [`OATS says: ${SAID}`]],
    [HIDDEN, HIDDEN, ['[withheld]', '[withheld]']],
    [HIDDEN, ' ', ['[withheld]']],
    [' ', ' ', []],
    // Markup is text; each text is whole at the kernel's bound; the same text in both is shown in both.
    ['<b>bold</b> <script>x</script>', '<i>it</i>', ['OATS says: <b>bold</b> <script>x</script>', '<i>it</i>']],
    [long, longer, [`OATS says: ${long}`, longer]],
    [REMEDY, REMEDY, [`OATS says: ${REMEDY}`, REMEDY]],
  ];
  for (const [message, fix, said] of rows) {
    const u = await inspector(t, problemOf('E_LAUNCH_PREFERENCE_UNMATCHED', message, fix), layout ? { layout } : {});
    const box = u.el.querySelector(selector);
    assert.ok(box, 'a problem always has its box');
    assert.deepEqual(boxOf(box), { own: REFUSED_HERE, said, code: 'E_LAUNCH_PREFERENCE_UNMATCHED', children: ['p.launch-problem-own', ...said.map(() => 'p.launch-problem-said'), 'details'] }, JSON.stringify([message, fix]).slice(0, 60));
    assert.equal(box.querySelector('b, i, script'), null, 'the lines are text');
  }
});

test('a soul with no launch problem has no box, on the page and in the panel', async t => {
  for (const [, layout, selector] of BOXES) {
    const u = await inspector(t, SOUL_PREF(), layout ? { layout } : {});
    assert.equal(u.el.querySelector(selector), null); assert.equal(u.el.querySelector('.launch-problem'), null);
  }
});

test('without the feature: no launch is read; a kernel before 0.30 keeps its own words', async t => {
  const u = await inspector(t, null, { cli: version, agentLaunch: OVERRIDE() });
  assert.equal(u.el.querySelector('.inspector-launch'), null);
  assert.match(u.el.textContent, /No default harness: you choose one when you launch it\./);
});

test('soul page: the harness fact carries the model and what chose it; below, the soul\'s own preference, where it is set, and a problem', async t => {
  const u = await inspector(t, OVERRIDE(), { layout: 'page' });
  const fact = u.el.querySelector('[data-fact="harness"]');
  assert.equal(fact.querySelector('.strong').textContent, 'Codex');
  assert.equal(fact.querySelector('.muted').textContent, "Codex's default model · set for this soul on this computer");
  assert.ok(fact.querySelector('.runtime-badge'), 'the harness mark');
  const notes = u.el.querySelector('[data-launch-notes]');
  assert.equal(notes.querySelector('.launch-declared').textContent, 'The soul prefers Claude Code · claude-opus-5-5; this computer runs Codex.');
  assert.match(notes.querySelector('.launch-at').textContent, /^Set in oats-local\.yaml › souls › launch › oats\.engineering\/code-reviewer/);
  const pref = await inspector(t, { ...SOUL_PREF(), effective: { ...SOUL_PREF().effective, launchConfig: 'opus' } }, { layout: 'page' });
  assert.equal(pref.el.querySelector('[data-fact="harness"] .muted').textContent, "claude-opus-5-5 · launch configuration opus · the soul's preference");
  assert.equal(pref.el.querySelector('.launch-declared'), null, 'no difference, nothing more');
  const missing = await inspector(t, MISSING(), { layout: 'page' });
  assert.deepEqual([...missing.el.querySelectorAll('.soul-ready-problems .launch-problem-said')].map(p => p.textContent), [`OATS says: ${MISSING().problem.message}`, MISSING().problem.fix]);
  assert.equal(missing.el.querySelector('.soul-ready-line').textContent, `OATS says: ${MISSING().problem.message}`, 'Ready: the kernel\'s sentence');
  assert.equal(missing.el.querySelector('.soul-ready-problems .launch-problem-own').textContent, 'A spawn of this soul with no launch chosen would be refused here.');
  const host = await inspector(t, { declared: null, effective: { harness: 'pi', model: null, launchConfig: null }, from: 'host', at: null, problem: null }, { layout: 'page' });
  assert.equal(host.el.querySelector('[data-fact="harness"] .muted').textContent, "Pi's default model · no preference set: the host default");
  assert.equal(host.el.querySelector('[data-launch-notes]'), null, 'nothing to add');
});

test('spawn dialog: the run hint says what this spawn runs and what chose it (derived on the real 0.30 preview); the soul\'s preference when a flag overrides it', () => {
  const real = v2('preview').result;
  const withLaunch = (from, declared = null) => previewData({ ...structuredClone(real), launch: { declared, effective: { harness: real.harness, model: real.model, launchConfig: real.launchConfig }, from, at: null, problem: null } }, target);
  const model = real.model ?? `${{ pi: 'Pi', claude: 'Claude Code', codex: 'Codex' }[real.harness]}'s default model`;
  const name = { pi: 'Pi', claude: 'Claude Code', codex: 'Codex' }[real.harness];
  assert.equal(launchHint(withLaunch('host'), FEATURED), `Launches ${name} with ${model} · no preference set: the host default.`);
  const other = real.harness === 'codex' ? { harness: 'claude', model: 'claude-opus-5-5' } : { harness: 'codex', model: null };
  assert.match(launchHint(withLaunch('flag', other), FEATURED), new RegExp(`· chosen for this spawn\\. The soul prefers ${other.harness === 'codex' ? "Codex · Codex's default model" : 'Claude Code · claude-opus-5-5'}\\.$`));
  assert.equal(launchHint(withLaunch('host'), version), null, 'no feature: the dialog keeps its own words');
  assert.equal(launchHint(previewData(structuredClone(real), target), FEATURED), null, 'no launch reported');
});

test('spawn dialog: a missing harness is said as the kernel words it, with its fix; the code and message stay behind Details', () => {
  // The fix travels flat on the reason (#292: the main-process proxy keeps code, message and fix).
  const p = spawnProblem({ code: 'E_HARNESS_UNAVAILABLE', message: 'harness codex is not installed on this machine.', fix: 'install codex, or choose another --harness / --launch-config' });
  assert.equal(spawnText(p), 'harness codex is not installed on this machine: install codex, or choose another --harness / --launch-config');
  assert.equal(p.detail, 'E_HARNESS_UNAVAILABLE · harness codex is not installed on this machine.');
  assert.equal(spawnText(spawnProblem({ code: 'E_HARNESS_UNAVAILABLE', message: 'harness codex is not installed' })), 'harness codex is not installed', 'no fix sent: the message alone');
  assert.equal(spawnText(spawnProblem({ code: 'E_HARNESS_UNAVAILABLE', message: 'harness codex is not installed', details: { fix: 'x' } })), 'harness codex is not installed', 'details.fix never reaches the renderer: not read');
  // The REAL kernel's message already ends with its fix (fixtures/launch-preference, captured from 0.29.4 at
  // main 69d76a91: that kernel's wording, not a later one's): said once, verbatim.
  const real = JSON.parse(readFileSync(new URL('./fixtures/launch-preference/preview-dev-unavailable.json', import.meta.url), 'utf8')).error;
  assert.equal(spawnText(spawnProblem({ code: real.code, message: real.message, fix: real.details.fix })), real.message);
  assert.equal(spawnText(spawnProblem({ code: 'E_HARNESS_UNAVAILABLE' })), 'The harness this soul would run isn’t installed on this machine. Install it, or pick another harness above.');
});

// End to end (#292's boundary keeps the kernel's words and the flat fix): a preview refused
// E_HARNESS_UNAVAILABLE reaches the open dialog as "<message>: <fix>", Spawn disabled, the code behind Details.
test('spawn dialog end to end: a missing harness refusal from the kernel is said in its words with its fix', async t => {
  const { mountSpawn, settle } = await import('./helpers/spawn-dialog-host.mjs');
  // The REAL kernel's refusal (its message already ends with the fix), and one whose message does not.
  const real = JSON.parse(readFileSync(new URL('./fixtures/launch-preference/preview-dev-unavailable.json', import.meta.url), 'utf8'));
  const terse = structuredClone(real); terse.error.message = 'codex is not installed on this machine';
  for (const [envelope, said] of [[real, real.error.message], [terse, `codex is not installed on this machine: ${real.error.details.fix}`]]) {
    const u = await mountSpawn(t, { kernel: () => structuredClone(envelope) });
    await u.open(); await u.type('.fpurpose', 'launch'); await settle();
    assert.equal(u.text('.fstatus'), said);
    assert.equal(u.dialog().querySelector('.fspawn').disabled, true, 'nothing to spawn');
    assert.ok(u.dialog().textContent.includes(`E_HARNESS_UNAVAILABLE · ${envelope.error.message}`), 'the code and message behind Details');
  }
});
