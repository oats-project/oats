// F7 side panels (human direction; Phase F boundary doc F7): the terminal-side
// context panel shows only what the instance reported, in the spawn modal's
// design language; Instance · Soul · Developer (Developer last); Teams folded into
// the Instance tab (injected, like Git: the host performs no IO); the Soul tab
// hands off to the Workspace view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createContextPanel, contextPanelCSS, driftText } from '../renderer/context-panel.mjs';
import { ageText } from '../renderer/age-text.mjs';
import { createInstanceTeamsSection } from '../renderer/instance-teams.mjs';
import { teamsCSS } from '../renderer/teams-panel.mjs';
import { instanceSoulCSS } from '../renderer/instance-soul.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(t, { teams, openSoul, git, fallbackFocus } = {}) {
  const dom = new JSDOM(`<!doctype html><body><div id="app"><aside id="sidebar"></aside><main id="main"></main><aside id="context-panel"></aside>
    <div id="tab-actions"><button id="split-right">Split</button></div></div></body>`);
  const document = dom.window.document, style = document.createElement('style'); style.textContent = contextPanelCSS; document.head.append(style);
  const updates = [], opened = [], hosts = [];
  const panel = createContextPanel({ document, root: document.getElementById('context-panel'),
    createTeamsSection: teams ?? ((host, { onPresence, tools }) => { hosts.push({ host, onPresence, tools }); return { update: u => updates.push(u), dispose() {} }; }),
    openSoul: openSoul ?? (ref => opened.push(ref)), ...(git ? { createGitPanel: git } : {}), ...(fallbackFocus ? { fallbackFocus } : {}) });
  t.after(() => { panel.dispose(); dom.window.close(); });
  const q = s => document.querySelector(s);
  const row = id => q(`#context-panel [data-row="${id}"]`);
  return { dom, document, panel, q, row, updates, opened, hosts,
    select: (instance, workspace = 'A') => panel.setContext({ workspace, instance, key: instance?.home }),
    tab: id => q(`[data-context-tab="${id}"]`), field: id => q(`[data-context-field="${id}"]`) };
}
const HOME = '/Users/me/work/northwind/agents/web-developer/instances/web-developer-1';
const instance = (extra = {}) => ({ instance: 'web-developer-1', agent: 'web-developer', agentsRoot: '/Users/me/work/northwind/agents', home: HOME,
  repo: '/Users/me/work/northwind', branch: 'feat/checkout', harness: 'claude', work: 'directory', running: true, ...extra });

test('only reported facts: an unreported fact hides its row (its field still says so), and an empty section hides', t => {
  const u = fixture(t); u.select(instance());
  // Workspace v4 (W6): harness and model sit in the Session card; an unreported model is not shown.
  assert.equal(u.field('model').textContent, 'Not reported'); assert.equal(u.field('model').hidden, true, 'no "Not reported" is shown');
  assert.equal(u.field('harness').closest('.context-panel-section').hidden, false); assert.equal(u.q('[data-context-work]').closest('.context-panel-section').hidden, false);
  const lineage = u.row('parentInstance').closest('.context-panel-section');
  assert.equal(lineage.hidden, true, 'no parent or sibling reported: no Lineage section');
  u.select(instance({ parentInstance: 'lead-1' }));
  assert.equal(lineage.hidden, false); assert.equal(u.row('parentInstance').hidden, false); assert.equal(u.row('siblingInstance').hidden, true);
  // v4.1: no Built from section and no Details disclosure on the Instance tab.
  const page = u.q('[data-context-page="instance"]');
  assert.equal(page.querySelector('.context-panel-details'), null);
  assert.doesNotMatch(page.textContent, /Built from|Team label|Messaging address/);
  const work = u.q('[data-context-work]').closest('.context-panel-section');
  u.select(instance({ home: undefined, repoName: undefined, branch: undefined, work: undefined }));
  assert.equal(work.hidden, true, 'no work mode reported: no Work section');
  assert.doesNotMatch([...u.document.querySelectorAll('#context-panel [data-row]:not([hidden])')].map(r => r.textContent).join('|'), /Not reported/);
});

const sentenceOf = u => u.q('[data-context-work]');
const codesOf = u => [...sentenceOf(u).querySelectorAll('.context-panel-fact-code')].map(c => c.textContent);
test('Work: one card — the mode tile and one sentence saying what the mode means; each fact in the mono face, never invented', t => {
  const u = fixture(t); u.select(instance({ work: 'worktree', repoName: 'northwind', branch: 'feat/checkout' }));
  const sentence = sentenceOf(u), section = sentence.closest('.context-panel-section'), card = u.q('.context-panel-work');
  assert.equal(section.querySelector(':scope > .context-panel-label').textContent, 'Work');
  // The first section shown (slice 1): Needs input, hidden unless the instance waits on you, stands above it.
  assert.equal(section.parentElement.querySelector(':scope > .context-panel-section:not([hidden])'), section, 'the first section of the Instance tab');
  assert.equal(section.parentElement.querySelector(':scope > .context-panel-section').dataset.contextSection, 'waiting', 'only Needs input, hidden here, before it');
  assert.deepEqual([...section.children].map(c => c.className), ['context-panel-label', 'context-panel-work'], 'one card');
  assert.equal(sentence.closest('.context-panel-work'), card); assert.equal(sentence.tagName, 'P');
  assert.equal(card.querySelector('.context-panel-mode-tile').getAttribute('aria-hidden'), 'true');
  assert.ok([...card.querySelectorAll('dl')].every(dl => dl.closest('.context-panel-paths')), 'no facts grid outside Paths');
  assert.doesNotMatch(card.textContent, /Own worktree|Shared checkout|Plain folder|Workspace view|Repo|Branch/, 'no label/meaning band, no Repo or Branch rows');
  const modes = {
    worktree: [{ repoName: 'northwind', branch: 'feat/checkout' }, 'Works in its own worktree of northwind, on branch feat/checkout.', ['northwind', 'feat/checkout'], 'branch'],
    checkout: [{ repoName: 'northwind' }, 'Works in the shared checkout of northwind, alongside the other instances that use it.', ['northwind'], 'branch'],
    attached: [{ parentInstance: 'lead-1' }, "Works in lead-1's tree, sharing its branch and changes.", ['lead-1'], 'link'],
    directory: [{ repoName: 'northwind' }, 'Has its own folder, not tied to one repository: free to work across repos as its task needs.', [], 'folder'],
    workspace: [{ repoName: 'northwind' }, 'Sees the whole workspace: reads across every member repository.', [], 'layers'],
  };
  for (const [work, [facts, words, codes]] of Object.entries(modes)) {
    u.select(instance({ work, branch: undefined, ...facts }));
    assert.equal(sentence.textContent, words, work); assert.deepEqual(codesOf(u), codes, `${work}: the facts in the mono face`);
    for (const code of sentence.querySelectorAll('.context-panel-fact-code')) assert.equal(code.title, code.textContent, 'the full value in its title');
    assert.equal(card.querySelector('.context-panel-mode-tile').dataset.work, work);
    assert.ok(card.querySelector('.context-panel-mode-tile svg'), `${work}: an icon tile`);
  }
  // Fallbacks: an unreported fact says the generic words, never an invented name.
  for (const [extra, words] of [
    [{ work: 'worktree', repoName: 'northwind', branch: undefined }, 'Works in its own worktree of northwind.'],
    [{ work: 'worktree', repoName: undefined, branch: 'feat/x' }, "Works in its own worktree of its soul's repository, on branch feat/x."],
    [{ work: 'worktree', repoName: '', branch: '' }, "Works in its own worktree of its soul's repository."],
    [{ work: 'checkout', repoName: undefined }, "Works in the shared checkout of its soul's repository, alongside the other instances that use it."],
    [{ work: 'attached', parentInstance: undefined }, "Works in its parent's tree, sharing its branch and changes."],
    [{ work: 'attached', parentInstance: 42 }, "Works in its parent's tree, sharing its branch and changes."],
  ]) { u.select(instance({ branch: undefined, ...extra })); assert.equal(sentence.textContent, words, JSON.stringify(extra)); }
  // An unknown or unreported mode hides the whole section.
  for (const work of ['bogus', undefined, '__proto__', 'constructor']) { u.select(instance({ work })); assert.equal(section.hidden, true, String(work)); }
  // The sentence wraps (a long name breaks inside only when it cannot fit a line); it is never truncated.
  assert.match(contextPanelCSS, /\.context-panel-work-sentence \{[^}]*overflow-wrap:anywhere;/);
  assert.doesNotMatch(contextPanelCSS.match(/\.context-panel-work-sentence \{[^}]*\}/)[0] + contextPanelCSS.match(/\.context-panel-fact-code \{[^}]*\}/)[0], /ellipsis|nowrap|overflow:hidden/);
});

test('Work: a fact arriving later rewrites the sentence in place; an unchanged repaint writes nothing', t => {
  const u = fixture(t); u.select(instance({ work: 'worktree', repoName: 'northwind', branch: undefined }));
  const sentence = sentenceOf(u), first = sentence.firstChild;
  assert.equal(sentence.textContent, 'Works in its own worktree of northwind.');
  const observer = new u.dom.window.MutationObserver(() => {}); observer.observe(sentence, { childList: true, subtree: true, characterData: true });
  u.select(instance({ work: 'worktree', repoName: 'northwind', branch: undefined, running: false }));
  assert.equal(observer.takeRecords().length, 0, 'the same words: no write'); assert.equal(sentence.firstChild, first);
  u.select(instance({ work: 'worktree', repoName: 'northwind', branch: 'feat/late' }));
  assert.equal(sentence.textContent, 'Works in its own worktree of northwind, on branch feat/late.');
  assert.equal(sentenceOf(u), sentence, 'the same sentence element'); assert.equal(sentence.closest('.context-panel-section').hidden, false);
  observer.disconnect();
});

test('Paths: a closed disclosure under the sentence holds Folder (shared when linked) and Home with an icon Copy; hidden without a home', async t => {
  const u = fixture(t), shared = u.q('[data-context-shared]');
  const tip = 'A link to the shared tree; changes here are visible to every instance that shares it.';
  u.select(instance({ work: 'worktree' }));
  const paths = u.q('.context-panel-paths');
  assert.equal(paths.tagName, 'DETAILS'); assert.equal(paths.open, false, 'closed');
  assert.equal(paths.querySelector(':scope > summary').textContent, 'Paths');
  assert.equal(paths.parentElement, u.q('.context-panel-work'), 'in the Work card'); assert.equal(paths.previousElementSibling.contains(sentenceOf(u)), true, 'under the sentence');
  for (const work of ['worktree', 'directory', 'checkout', 'attached', 'workspace']) {
    u.select(instance({ work }));
    assert.equal(paths.hidden, false, work);
    assert.deepEqual([...paths.querySelectorAll('.context-panel-fact:not([hidden]) dt')].map(dt => dt.textContent), ['Folder', 'Home'], work);
    assert.equal(u.field('workFolder').textContent, `${HOME}/work`, work);
    assert.equal(u.field('workFolder').closest('.context-panel-path').title, `${HOME}/work`);
    assert.equal(u.field('workFolder').closest('.context-panel-path').dir, 'rtl', 'clipped at the start');
    const copy = u.q('[data-copy="workFolder"]');
    assert.equal(copy.getAttribute('aria-label'), 'Copy folder path'); assert.equal(copy.textContent, '', 'icon only');
    assert.equal(shared.hidden, !['checkout', 'attached', 'workspace'].includes(work), `${work}: shared only when linked`);
    assert.equal(shared.textContent, 'shared'); assert.equal(shared.title, tip);
    assert.equal(shared.previousElementSibling, u.field('workFolder').closest('.context-panel-path'), 'the tag follows the path');
  }
  // Home: left-truncated, the full path in the field and the title; Copy is icon-only and copies it.
  const home = u.field('home');
  assert.equal(home.textContent, HOME); assert.equal(home.closest('.context-panel-path').dir, 'rtl'); assert.equal(home.closest('.context-panel-path').title, HOME);
  const copy = u.q('[data-copy="home"]');
  assert.equal(copy.getAttribute('aria-label'), 'Copy home path'); assert.equal(copy.textContent, ''); assert.ok(copy.querySelector('svg'));
  const written = [];
  Object.defineProperty(u.dom.window.navigator, 'clipboard', { value: { writeText: async text => { written.push(text); } }, configurable: true });
  copy.click(); await tick(); u.q('[data-copy="workFolder"]').click(); await tick();
  assert.deepEqual(written, [HOME, `${HOME}/work`]); assert.equal(copy.getAttribute('aria-label'), 'Copied');
  assert.equal(u.document.querySelector('#context-panel').textContent.includes('Copy'), false, 'no text Copy button');
  // Folder is built from the home, with the home's own separator.
  u.select(instance({ home: 'C:\\Users\\me\\agents\\dev\\instances\\dev-1\\' }));
  assert.equal(u.field('workFolder').textContent, 'C:\\Users\\me\\agents\\dev\\instances\\dev-1\\work');
  u.select(instance({ home: 'C:/Users/me/dev-1/' })); assert.equal(u.field('workFolder').textContent, 'C:/Users/me/dev-1/work');
  // No home (or not a string): neither path, so no Paths; the sentence stays.
  for (const value of [undefined, 42, '']) {
    u.select(instance({ home: value, work: 'checkout' }));
    assert.equal(paths.hidden, true, `home ${JSON.stringify(value)}: no Paths`); assert.equal(sentenceOf(u).closest('.context-panel-section').hidden, false);
  }
});

test('Paths: a background repaint keeps the disclosure and a focused Copy inside it; another instance starts closed', t => {
  const u = fixture(t, { fallbackFocus: () => u.q('#split-right') }), other = `${HOME}-2`; u.select(instance({ work: 'worktree', repoName: 'northwind' }));
  const paths = u.q('.context-panel-paths'); paths.open = true;
  const copy = u.q('[data-copy="home"]'); copy.focus(); assert.equal(u.document.activeElement, copy);
  // The same instance, repainted with a new fact: nothing rebuilt, still open, focus kept.
  u.select(instance({ work: 'worktree', repoName: 'northwind', branch: 'feat/late', running: false }));
  assert.equal(u.q('.context-panel-paths'), paths); assert.equal(paths.open, true); assert.equal(u.q('[data-copy="home"]'), copy);
  assert.equal(u.document.activeElement, copy, 'focus survives a background repaint');
  // Another instance: closed again, and focus leaves the hidden Copy for the panel's fallback, never stays on it.
  u.select(instance({ work: 'worktree', home: other }));
  assert.equal(paths.open, false, 'reset to closed for the new selection');
  assert.equal(u.document.activeElement, u.q('#split-right'), "focus leaves the Copy the closed disclosure hides, for the shell's fallback");
});

test('ahead/behind leave the Instance tab; the changes dot and the Developer tab thread count still follow the Git panel', t => {
  let hooks = null;
  const u = fixture(t, { git: (_host, h) => { hooks = h; return { update() {}, dispose() {} }; } });
  const subject = instance({ work: 'worktree', repoName: 'northwind', branch: 'feat/checkout', createdAt: '2026-09-30T10:00:00.000Z' });
  u.select(subject);
  const identity = JSON.stringify(['A', HOME, HOME, subject.agent, subject.agentsRoot, null, subject.createdAt]);
  hooks.onObservation({ identity, connection: 0, changed: true, ahead: 3, behind: 2 });
  hooks.onPullRequest({ identity, connection: 0, unresolvedThreads: 2 });
  const page = u.q('[data-context-page="instance"]');
  assert.doesNotMatch(page.textContent, /[↑↓]/, 'no ↑/↓ on the Instance tab');
  assert.equal(page.querySelector('.context-panel-ahead'), null);
  assert.equal(u.panel.state().changes, true, 'the changes state (the Show instance panel dot) is unchanged');
  assert.equal(u.tab('git').querySelector('.context-panel-tab-count').textContent, '2', 'the review-thread count is unchanged');
  assert.equal(u.tab('git').getAttribute('aria-label'), 'Developer, 2 unresolved review threads');
});

test('created reads as a relative age with the exact value in its title', t => {
  // The panel's ages read Date.now: one fixed instant for the timestamp and the panel, so the age is exact by construction.
  const now = Date.now(); t.mock.method(Date, 'now', () => now);
  const u = fixture(t), at = new Date(now - 3 * 3600e3).toISOString();
  u.select(instance({ createdAt: at }));
  assert.equal(u.field('createdAt').textContent, '3 h ago'); assert.equal(u.field('createdAt').title, at);
  assert.equal(ageText('2026-09-25T10:00:00.000Z', Date.parse('2026-09-25T10:00:30.000Z')), 'just now');
  assert.equal(ageText('2026-09-25T10:00:00.000Z', Date.parse('2026-09-25T10:42:00.000Z')), '42 min ago');
  assert.equal(ageText('2026-09-20T10:00:00.000Z', Date.parse('2026-09-25T10:00:00.000Z')), '5 d ago');
  assert.equal(ageText('not a date'), 'not a date');
});

test('header: "instance of <soul>" links to the Soul tab; the state reads "Running · 42m" or "Stopped"', t => {
  const now = Date.now(); t.mock.method(Date, 'now', () => now);
  const u = fixture(t), started = new Date(now - 42 * 60e3).toISOString();
  u.select(instance({ startedAt: started }));
  const link = u.q('[data-context-soul-link]');
  assert.equal(link.tagName, 'BUTTON'); assert.equal(link.textContent, 'web-developer');
  assert.equal(link.previousElementSibling.textContent, 'instance of'); assert.equal(link.title, 'web-developer: show the Soul tab');
  // The soul name ellipsizes its own text (a button is atomic inside an ellipsized line, so the line is a flex row).
  assert.match(contextPanelCSS, /button\.context-panel-soul-link \{ flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis;/);
  // Two-row header grid: tile | name | state, then the soul line (+ chip) spanning name and state.
  const head = u.q('[data-context-page="instance"] > .context-panel-identity');
  assert.ok(head.classList.contains('is-instance'));
  assert.match(contextPanelCSS, /\.context-panel-identity\.is-instance \{ display:grid; grid-template-columns:36px minmax\(0,1fr\) auto;/);
  assert.match(contextPanelCSS, /\.is-instance \.context-panel-identity-sub \{ grid-column:2 \/ 4; grid-row:2;/);
  assert.equal(link.closest('.context-panel-identity-sub').querySelector('[data-context-drift]') !== null, true, 'the chip is inline after the soul line');
  assert.equal(u.field('instance').title, 'web-developer-1');
  const state = u.q('.context-panel-state');
  assert.equal(state.dataset.state, 'running'); assert.equal(state.title, `started ${started}`);
  assert.equal(u.field('running').textContent, 'Running'); assert.equal(state.querySelector('.context-panel-state-age').textContent, '· 42m');
  link.click();
  assert.equal(u.tab('soul').getAttribute('aria-selected'), 'true'); assert.equal(u.document.activeElement, u.tab('soul'));
  u.select(instance({ running: false, startedAt: started }));
  assert.equal(u.field('running').textContent, 'Stopped'); assert.equal(state.querySelector('.context-panel-state-age').hidden, true);
  u.select(instance({ agent: undefined })); assert.equal(link.parentElement.hidden, true, 'no soul reported: no sub-line');
  u.select(instance({ running: undefined })); assert.equal(state.hidden, true, 'an unknown state is not shown');
  u.select(instance()); assert.equal(state.hidden, false);
});

test('drift: one neutral "older build" chip only for moved/missing (soul or capability rows), with a plain-words tooltip', t => {
  const u = fixture(t), chip = () => u.q('[data-context-drift]');
  const current = { soul: { repoKey: 'github.com/nw/agents', commit: 'abcdef1234', status: 'current' }, modules: [{ name: 'oats.okf', status: 'current' }] };
  u.select(instance(current)); assert.equal(chip().hidden, true, 'current: no chip');
  u.select(instance({ modules: { 'oats.okf': {} } })); assert.equal(chip().hidden, true, 'a recorded map is not observed drift');
  u.select(instance()); assert.equal(chip().hidden, true, 'unreported: no chip');
  u.select(instance({ ...current, soul: { ...current.soul, status: 'moved', current: '99999999' } }));
  assert.equal(chip().hidden, false); assert.equal(chip().textContent, 'older build');
  assert.match(chip().title, /soul's repository has moved on/); assert.match(chip().title, /Re-spawning picks up the new state/);
  assert.equal(chip().getAttribute('aria-label'), `older build: ${chip().title}`);
  u.select(instance({ modules: [{ name: 'oats.okf', status: 'moved', from: { version: '2.1.3' }, current: { version: '2.2.0' } }, { name: 'oats.x', status: 'missing', reason: 'package removed' }] }));
  assert.equal(chip().hidden, false);
  assert.match(chip().title, /oats\.okf has changed since \(2\.1\.3 → 2\.2\.0\)/); assert.match(chip().title, /oats\.x is no longer available \(package removed\)/);
  assert.equal(chip().closest('.context-panel-identity') !== null, true, 'in the header');
  assert.equal(driftText({ modules: [], soul: { status: 'current' } }), null);
});

test('Soul tab: the description under the name, Open soul page hands the soul identity off; no disclaimer paragraph', t => {
  const u = fixture(t); u.select(instance({ description: 'Builds the storefront', server: null }));
  u.tab('soul').click();
  const page = u.q('[data-context-page="soul"]');
  assert.match(page.textContent, /web-developer.*Builds the storefront/s);
  assert.doesNotMatch(page.textContent, /Metadata reported by this instance/);
  const open = u.q('[data-action="soul.open"]');
  assert.equal(open.textContent, 'Open soul page', 'Workspace v4 (W6) wording'); assert.equal(open.disabled, false);
  open.click();
  assert.deepEqual(u.opened, [{ workspace: 'A', name: 'web-developer', agentsRoot: '/Users/me/work/northwind/agents', server: undefined }]);
  u.select(instance({ agent: undefined }));
  assert.equal(open.disabled, true, 'no reported soul: nothing to open');
  assert.equal(u.field('description').hidden, true);
});

test('Messaging & Teams sits in the Instance tab under Session, injected: the Messaging ID with an icon Copy, then the Teams sub-label; active only on the Instance tab', async t => {
  const u = fixture(t); u.select(instance({ identityAddress: 'northwind/web-developer-1' }));
  const section = u.q('[data-context-section="teams"]');
  assert.equal(u.hosts.length, 1); assert.equal(u.hosts[0].host, section);
  assert.equal(section.previousElementSibling.querySelector('.context-panel-label').textContent, 'Session', 'order: Work, Session, Messaging & Teams');
  // The header: the label and a tools slot (the icon Refresh goes there, at its right).
  const head = section.querySelector('.context-panel-section-head');
  assert.equal(head.querySelector('.context-panel-label').textContent, 'Messaging & Teams');
  assert.equal(u.hosts[0].tools, head.querySelector('.context-panel-tools')); assert.equal(head.lastElementChild, u.hosts[0].tools);
  assert.equal(head.querySelector('[data-context-field]'), null, 'the ID is not inline in the header');
  // Messaging ID: a sentence-case sub-label, then the one-line mono value (full value in its title) and its icon Copy.
  const id = u.row('identity');
  assert.equal(head.nextElementSibling, id); assert.equal(id.querySelector('.context-panel-sublabel').textContent, 'Messaging ID');
  assert.equal(u.field('identity').className, 'context-panel-id'); assert.equal(u.field('identity').textContent, 'northwind/web-developer-1');
  assert.equal(u.field('identity').title, 'northwind/web-developer-1');
  assert.match(contextPanelCSS, /\.context-panel-id \{[^}]*overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:normal; font-size:12px; line-height:1\.45; font-family:var\(--ui-font, ui-monospace, Menlo, monospace\)/, "the id follows the font choice, its own stack the fallback");
  assert.match(contextPanelCSS, /\.context-panel-sublabel \{ font-size:11\.5px; font-weight:600; line-height:1\.45; color:var\(--muted\); \}/);
  assert.doesNotMatch(contextPanelCSS.match(/\.context-panel-sublabel \{[^}]*\}/)[0], /uppercase/);
  const copy = u.q('[data-copy="identity"]');
  assert.equal(copy.parentElement, u.field('identity').parentElement, 'the Copy on the ID line');
  assert.equal(copy.className, u.q('[data-copy="home"]').className, 'the same icon Copy the path lines use');
  assert.equal(copy.getAttribute('aria-label'), 'Copy messaging ID'); assert.equal(copy.textContent, ''); assert.ok(copy.querySelector('svg'));
  const written = [];
  Object.defineProperty(u.dom.window.navigator, 'clipboard', { value: { writeText: async text => { written.push(text); } }, configurable: true });
  copy.click(); await tick(); assert.deepEqual(written, ['northwind/web-developer-1']);
  // Teams: its sub-label, then whatever the injected section mounts after it (the lead line and the card).
  const teams = id.nextElementSibling;
  assert.equal(teams.className, 'context-panel-sublabel'); assert.equal(teams.textContent, 'Teams'); assert.equal(teams.parentElement, section);
  // An unreported ID hides its part; the Teams part stays the section's.
  u.select(instance({ identityAddress: undefined })); assert.equal(id.hidden, true); assert.equal(teams.hidden, false);
  assert.equal(section.hidden, true, 'hidden until the section says it has something');
  u.hosts[0].onPresence(true); assert.equal(section.hidden, false);
  assert.equal(u.updates.at(-1).active, true); assert.equal(u.updates.at(-1).instance.home, HOME); assert.equal(u.updates.at(-1).workspace, 'A');
  u.tab('git').click(); assert.equal(u.updates.at(-1).active, false, 'another tab: no reads');
  u.panel.setCollapsed(true); assert.equal(u.updates.at(-1).active, false);
});

// The injected section: inspect --home says which operations the provider declares, then the shared Teams card.
const fx = name => JSON.parse(readFileSync(new URL(`./fixtures/workspace-v2/teams/${name}.json`, import.meta.url), 'utf8'));
const TEAMS_HOME = fx('inspect-home').result.subject.home;
const teamsInstance = (home = TEAMS_HOME, extra = {}) => ({ instance: home.split('/').pop(), home, ...extra });
function section(t, request, cli = () => ({ ok: true, operationsApi: 2 })) {
  const dom = new JSDOM('<body><section></section></body>'), host = dom.window.document.querySelector('section'), calls = [], presence = [];
  let gen = 0;
  const s = createInstanceTeamsSection(host, { cli, generation: () => gen, onPresence: p => presence.push(p),
    request: async (workspace, body) => { calls.push({ workspace, ...body }); return request(workspace, body); } });
  t.after(() => { s.dispose(); dom.window.close(); });
  return { host, s, calls, presence, bump: () => ++gen };
}
test('the injected Teams section reads once per instance, gates on the declared operations, and mounts the shared card', async t => {
  const u = section(t, (_ws, body) => body.action === 'inspect' ? fx('inspect-home').result : fx('teams-initial').result);
  u.s.update({ active: true, workspace: 'A', instance: teamsInstance() }); await tick(); await tick();
  assert.deepEqual(u.calls.map(c => [c.workspace, c.action, c.operation ?? null]), [['A', 'inspect', null], ['A', 'run', 'messaging:teams']]);
  assert.deepEqual(u.calls[0].selector, { home: TEAMS_HOME });
  assert.deepEqual(u.presence.at(-1), true); assert.ok(u.host.querySelector('.teams-panel [data-team-row="default"]'));
  assert.equal(u.host.querySelector('.teams-panel > h3'), null, 'the context panel labels the section itself');
  for (let i = 0; i < 5; i++) u.s.update({ active: true, workspace: 'A', instance: teamsInstance() });
  await tick(); assert.equal(u.calls.length, 2, 'renders are frequent: one inspection per selection');
  u.s.update({ active: true, workspace: 'A', instance: teamsInstance(`${TEAMS_HOME}-2`) }); await tick();
  assert.equal(u.calls.filter(c => c.action === 'inspect').length, 2, 'a new selection reads again');
});
test('no messaging provider, no compatible CLI, a remote instance or an inactive tab: no section and no read', async t => {
  const none = fx('inspect-home').result; for (const c of none.capabilities) if (c.layer === 'messaging') c.layer = null;
  const a = section(t, () => none); a.s.update({ active: true, workspace: 'A', instance: teamsInstance() }); await tick();
  // desktop/loading-states: the roster row says nothing of messaging (no identityAddress), so the section never claims its place — no flash that would shift Lineage.
  assert.equal(a.calls.length, 1); assert.deepEqual(a.presence, [false, false]); assert.equal(a.host.querySelector('.teams-panel'), null);
  assert.equal(a.host.querySelector('.loading-failed'), null, 'no provider is not a failure');
  const b = section(t, () => assert.fail('no read'), () => ({ ok: true, operationsApi: 1 }));
  b.s.update({ active: true, workspace: 'A', instance: teamsInstance() });
  const c = section(t, () => assert.fail('no read')); c.s.update({ active: true, workspace: 'A', instance: teamsInstance(TEAMS_HOME, { server: 'host' }) });
  const d = section(t, () => assert.fail('no read')); d.s.update({ active: false, workspace: 'A', instance: teamsInstance() });
  await tick(); assert.equal(b.calls.length + c.calls.length + d.calls.length, 0);
});
test('a stale inspection (the selection or workspace changed while it was in flight) mounts nothing', async t => {
  let release; const gate = new Promise(r => { release = r; });
  const u = section(t, async (_ws, body) => { if (body.action === 'inspect') { await gate; return fx('inspect-home').result; } return fx('teams-initial').result; });
  u.s.update({ active: true, workspace: 'A', instance: teamsInstance() });
  u.s.update({ active: false, workspace: 'A', instance: teamsInstance(`${TEAMS_HOME}-2`) });
  release(); await tick(); await tick();
  assert.equal(u.host.querySelector('.teams-panel'), null); assert.equal(u.calls.some(c => c.action === 'run'), false);
  let release2; const gate2 = new Promise(r => { release2 = r; });
  const v = section(t, async (_ws, body) => { if (body.action === 'inspect') { await gate2; return fx('inspect-home').result; } return fx('teams-initial').result; });
  v.s.update({ active: true, workspace: 'A', instance: teamsInstance() }); v.bump();
  release2(); await tick(); await tick();
  assert.equal(v.host.querySelector('.teams-panel'), null, 'a workspace-generation change revokes it too');
});

// Kernel #217 desktop facts on the instance page (views only): the last start,
// where the model came from and the messaging address, each only when reported.
test('desktop facts: a reported start replaces the spawn age, the model says where it came from, the messaging address is the Messaging ID', t => {
  const u = fixture(t);
  const captured = JSON.parse(readFileSync(new URL('./fixtures/workspace-v2/desktop-facts/status.json', import.meta.url), 'utf8')).agents.flatMap(a => a.instances)[0];
  const now = Date.now(); t.mock.method(Date, 'now', () => now);
  const created = new Date(now - 26 * 3600e3).toISOString(), started = new Date(now - 12 * 60e3).toISOString();
  const age = which => u.q(`.context-panel-session-age${which === 'started' ? '[data-age=started]' : ':not([data-age])'}`);
  // The real capture: spawned with --model, never launched (startedAt null), no messaging identity.
  u.select(instance({ createdAt: created, model: captured.model, modelFrom: captured.modelFrom, startedAt: captured.startedAt, identityAddress: captured.identityAddress }));
  assert.equal(captured.modelFrom, 'spawn'); assert.equal(captured.startedAt, null);
  assert.equal(u.field('modelFrom').textContent, 'chosen at spawn'); assert.equal(u.field('modelFrom').hidden, false);
  assert.equal(age('started').hidden, true, 'never launched: no start'); assert.equal(age('created').hidden, false);
  assert.equal(u.row('identity').hidden, true, 'no address reported');
  // A restarted home: the start replaces the age, the spawn time stays in its title.
  u.select(instance({ createdAt: created, model: 'claude-opus-5-5', modelFrom: 'soul', startedAt: started, identityAddress: 'northwind/web-developer-1' }));
  assert.equal(age('started').textContent, 'started 12 min ago'); assert.equal(age('created').hidden, true);
  assert.equal(u.field('startedAt').title, `${started} · created ${created}`);
  assert.equal(u.field('modelFrom').textContent, "the soul's choice");
  assert.equal(u.row('identity').hidden, false); assert.equal(u.field('identity').textContent, 'northwind/web-developer-1');
  assert.equal(u.field('identity').closest('[data-context-section="teams"]') !== null, true);
  // 0.30 launch preferences: an inline override on this computer, for the soul or for every soul.
  for (const [from, words] of [['local', 'set for this soul on this computer'], ['local-default', "this computer's default for every soul"]]) {
    u.select(instance({ createdAt: created, model: 'gpt-codex-astra', modelFrom: from }));
    assert.equal(u.field('modelFrom').textContent, words, from); assert.equal(u.field('modelFrom').hidden, false, from);
  }
  for (const odd of ['later', 'constructor', '__proto__']) {
    u.select(instance({ createdAt: created, model: 'm', modelFrom: odd }));
    assert.equal(u.field('modelFrom').hidden, true, `${odd}: an unknown source says nothing`);
  }
  // An older kernel (none of the keys) or a pre-0.29 home (modelFrom null): as before.
  u.select(instance({ createdAt: created, modelFrom: 'soul' }));
  assert.equal(u.field('modelFrom').hidden, true, 'no model reported: its source alone says nothing');
  for (const extra of [{}, { modelFrom: null }]) {
    u.select(instance({ createdAt: created, model: 'm', ...extra }));
    assert.equal(u.field('modelFrom').hidden, true); assert.equal(age('started').hidden, true);
    assert.equal(age('created').textContent, 'created 1 d ago'); assert.equal(u.row('identity').hidden, true);
  }
});

test('the instance panel CSS leaves keyboard focus to the global rule: no per-component focus rings or outlines', () => {
  for (const [name, source] of [['contextPanelCSS', contextPanelCSS], ['teamsCSS', teamsCSS], ['instanceSoulCSS', instanceSoulCSS]]) {
    assert.doesNotMatch(source, /:focus-visible|:focus\b|outline:/, name);
    assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b|color-mix|opacity/i, `${name}: tokens only`);
  }
  // Spec F: the tab bar has no panel toggle, so the panel styles nothing outside itself.
  assert.doesNotMatch(contextPanelCSS, /#tab-actions|#panel-toggle/);
});
