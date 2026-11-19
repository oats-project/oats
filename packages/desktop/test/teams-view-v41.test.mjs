// The Workspace › Teams page after the v4.1 board (design/v4.1/Teams.dc.html): the page's own
// fg/bg pairings hold computed AA in the three themes (the same approach as theme-contrast.test.mjs:
// the declared token pair on the element, then its effective contrast), and the shared control rules
// (a selected state is the brand tint; no ring on pointer focus; one border per field).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createComputerTeams, computerTeamsCSS } from '../renderer/computer-teams.mjs';
import { identityCSS } from '../renderer/identity-marks.mjs';
import { teamsData } from '../../client/deployment-data.mjs';

const css = readFileSync(new URL('../renderer/theme.css', import.meta.url), 'utf8');
const capture = name => JSON.parse(readFileSync(new URL(`./fixtures/team-model-v2/${name}.json`, import.meta.url), 'utf8'));
const tokens = block => new Map([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6}(?:[0-9a-f]{2})?)\b/gi)].map(m => [m[1], m[2].toLowerCase()]));
const dark = tokens(css.match(/:root, \[data-theme="dark"\] \{([\s\S]*?)\n\}/)?.[1] || '');
const themed = name => { const palette = new Map(dark); for (const [k, v] of tokens(css.match(new RegExp(`\\[data-theme="${name}"\\] \\{([\\s\\S]*?)\\n\\}`))?.[1] || '')) palette.set(k, v); return palette; };
const palettes = [['light', themed('light')], ['solarized', themed('solarized')], ['dark', dark]];
const channels = hex => { assert.match(hex, /^#[0-9a-f]{6}$/i, 'opaque'); return hex.slice(1).match(/../g).map(v => parseInt(v, 16)); };
const luminance = rgb => { const [r, g, b] = rgb.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (fg, bg) => { const a = luminance(fg), b = luminance(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

/** The real K1 capture (teams-after), with engineering given an id so a mapped shared team has members. */
function document() {
  const d = teamsData(capture('teams-after'), '/fixture/base/northwind-workspace');
  d.teams.find(t => t.label === 'engineering').team = 'engineering:northwind.aweb.ai'; d.problems = d.problems.filter(p => p.label !== 'engineering');
  return d;
}
const roster = [{ instance: 'rm-1', agent: 'release-manager', agentsRoot: '/a', identity: { team: 'mine:alex.aweb.ai' }, running: true },
  { instance: 'e-1', agent: 'engineer', agentsRoot: '/a', identity: { team: 'engineering:northwind.aweb.ai' }, running: true }];

async function mount(t, theme, { onOpenTeam = null, elsewhere = false } = {}) {
  const dom = new JSDOM(`<!doctype html><html data-theme="${theme}"><body><main class="oats-view"><div class="workspace-discovery" data-tab="teams"></div></main></body></html>`, { pretendToBeVisual: true });
  const doc = dom.window.document;
  for (const source of [css, identityCSS, computerTeamsCSS]) { const style = doc.createElement('style'); style.textContent = source; doc.head.append(style); }
  // The members as /api/team-members answers them for these rows of this computer.
  const members = roster.map(r => ({ workspace: '/w', server: null, serverLabel: null, instance: r.instance, agent: r.agent, agentsRoot: r.agentsRoot,
    home: `/a/${r.agent}/instances/${r.instance}`, team: r.identity.team, running: r.running, addressable: true, missingRemotely: false, reason: null, createdAt: null }));
  // `elsewhere`: one more engineer on a machine that was not reached, so engineering's foot says so (more, warn).
  if (elsewhere) members.push({ ...members[1], workspace: 'remote:build:1', server: 'build', serverLabel: 'Build box', instance: 'e-2', home: '/a/engineer/instances/e-2', running: null });
  const servers = elsewhere ? [{ server: 'build', label: 'Build box', group: 'build:1', reached: false, error: 'ssh failed' }] : [];
  const page = createComputerTeams(doc, { request: async () => document(), readMembers: async () => ({ members, servers, notReached: [] }), onOpenTeam });
  doc.querySelector('.workspace-discovery').append(page.element);
  t.after(() => { page.dispose(); dom.window.close(); });
  await tick();
  return { dom, doc, page };
}

for (const [name, palette] of palettes) test(`${name}: the Teams page's text sits on its declared surfaces at AA (the tag accent on sel; muted and fg on the card; the warning on attn-bg; the titles on bg)`, async t => {
  const u = await mount(t, name);
  // The card opens its team's page: its label is a button, and its foot says so.
  const open = await mount(t, name, { onOpenTeam: () => {}, elsewhere: true });
  const style = el => (el.ownerDocument === u.doc ? u : open).dom.window.getComputedStyle(el);
  const painted = el => style(el).background.replace(/^.*(var\(--[\w-]+\)).*$/, '$1');
  const team = (page, label) => page.doc.querySelector(`[data-team="${label}"]`);
  const mine = team(u, 'mine'), eng = team(u, 'engineering'), global = team(u, 'global'), marketing = team(u, 'marketing'), openEng = team(open, 'engineering');
  const cases = [
    // [element, its painted surface, fg token, bg token]
    [mine.querySelector('.ct-tag'), mine.querySelector('.ct-tag'), 'accent', 'sel'], [mine.querySelector('.ct-from'), mine, 'muted', 'surface'],
    [mine.querySelector('.ct-name-h .ct-label'), mine, 'fg', 'surface'], [openEng.querySelector('.ct-name-h button.ct-open'), openEng, 'fg', 'surface'],
    [mine.querySelector('.ct-desc'), mine, 'muted', 'surface'], [mine.querySelector('.ct-fact dt'), mine, 'muted', 'surface'],
    [mine.querySelector('dd.ct-address'), mine, 'muted', 'surface'], [global.querySelector('dd.ct-address.none'), global, 'warn', 'surface'],
    [mine.querySelector('.ct-join'), mine, 'fg', 'surface'], [marketing.querySelector('.ct-join.none'), marketing, 'muted', 'surface'],
    [mine.querySelector('.ct-why'), mine, 'muted', 'surface'],
    // The warning box paints --attn-bg itself; its message and fix are --fg on it.
    [global.querySelector('.ct-warn'), global.querySelector('.ct-warn'), 'fg', 'attn-bg'], [global.querySelector('.ct-warn-msg'), global.querySelector('.ct-warn'), 'fg', 'attn-bg'],
    [global.querySelector('.ct-warn .ct-fix'), global.querySelector('.ct-warn'), 'fg', 'attn-bg'],
    // The foot: the count, the rest of the sum, a machine not reached, and the "Open team" cue.
    [mine.querySelector('.ct-sum-count'), mine, 'fg', 'surface'], [openEng.querySelector('.ct-sum-more'), openEng, 'muted', 'surface'],
    [openEng.querySelector('.ct-sum-warn'), openEng, 'warn', 'surface'], [openEng.querySelector('.ct-go'), openEng, 'muted', 'surface'],
    [u.doc.querySelector('button.ct-add'), u.doc.querySelector('button.ct-add'), 'fg', 'surface'],
    [eng.querySelector('button.ct-act:not(:disabled)'), eng.querySelector('button.ct-act:not(:disabled)'), 'fg', 'surface'],
    [global.querySelector('button.ct-act:disabled'), global.querySelector('button.ct-act:disabled'), 'muted', 'surface'],
  ];
  for (const [el, surface, fg, bg] of cases) {
    assert.ok(el && surface, `${fg} on ${bg}: rendered`);
    assert.equal(style(el).color, `var(--${fg})`, `${fg} on ${bg}: declared`);
    assert.equal(painted(surface), `var(--${bg})`, `${fg} on ${bg}: painted`);
    assert.ok(contrast(channels(palette.get(fg)), channels(palette.get(bg))) >= 4.5, `${name}: --${fg} on --${bg}`);
    for (let parent = el; parent; parent = parent.parentElement) assert.equal(style(parent).opacity, '1', 'no opacity compositing over text');
  }
  // The titles, the leads and the empty dashed card are painted on the page's --bg; the link is accent on bg.
  for (const [fg, bg] of [['muted', 'bg'], ['fg', 'bg'], ['accent', 'bg'], ['accent', 'surface'], ['fg', 'surface-2']]) {
    assert.ok(contrast(channels(palette.get(fg)), channels(palette.get(bg))) >= 4.5, `${name}: --${fg} on --${bg}`);
  }
  for (const sel of ['.ct-title', '.ct-section-title']) assert.equal(style(u.doc.querySelector(sel)).color, 'var(--fg)', sel);
  for (const sel of ['.ct-lead', '.ct-section-lead']) assert.equal(style(u.doc.querySelector(sel)).color, 'var(--muted)', sel);
});

test('the board\'s measures and the shared control rules, in the page\'s own CSS (tokens only)', () => {
  const rule = selector => { const m = computerTeamsCSS.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`, 'm')); assert.ok(m, selector); return m[1]; };
  assert.doesNotMatch(computerTeamsCSS, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|opacity/i, 'no raw colours, no opacity');
  assert.match(rule('.workspace-discovery[data-tab=teams] > :has(> .computer-teams)'), /max-width:1120px/, 'the board is one wide column (the box holding the page)');
  assert.match(rule('.computer-teams .ct-title'), /font-size:24px; font-weight:700/); assert.match(rule('.computer-teams .ct-lead'), /font-size:13px/);
  assert.match(rule('.oats-view .computer-teams button.ct-add'), /height:32px;.*border-radius:7px; font-size:12.5px/);
  // The sections (and any page problem) stack 40px apart in the body, which the page's own 18px gap and margin set under the head.
  assert.match(rule('.computer-teams'), /gap:18px/); assert.match(rule('.computer-teams .ct-body'), /display:flex; flex-direction:column; gap:40px; margin-top:22px/);
  assert.doesNotMatch(computerTeamsCSS, /\.ct-section \+ \.ct-section/, 'no tighter margin of its own');
  // A section title is sentence case at 18/650 in --fg, never an uppercase label.
  assert.match(rule('.computer-teams .ct-section-title'), /color:var\(--fg\); font-size:18px; font-weight:650; line-height:1.25; letter-spacing:-.01em/);
  assert.doesNotMatch(rule('.computer-teams .ct-section-title'), /text-transform/);
  assert.match(rule('.computer-teams .ct-section-lead'), /color:var\(--muted\); font-size:13px/);
  // A card is one column on the surface; a local team's frame is dashed.
  assert.match(rule('.computer-teams .ct-card'), /display:flex; flex-direction:column;.*background:var\(--surface\); border:1px solid var\(--border\); border-radius:10px/);
  assert.match(rule('.computer-teams .ct-card.local'), /border:1px dashed var\(--tree-line\)/);
  // At a narrow board (container under 760px) the actions wrap under the description.
  assert.match(computerTeamsCSS, /@container \(max-width: 759\.98px\) \{\n \.computer-teams \.ct-head \{ grid-template-columns:minmax\(0,1fr\); \}\n \.computer-teams \.ct-head > \.ct-actions \{ grid-column:1; grid-row:auto; justify-content:flex-start; \}/);
  assert.match(rule('.computer-teams .ct-tag'), /background:var\(--sel\); color:var\(--accent\); font-weight:600; font-size:11.5px;/, 'rule 1: the selected state is the brand tint');
  assert.match(rule('.computer-teams .ct-label'), /color:var\(--fg\); font-size:17px; font-weight:700/);
  assert.match(rule('.oats-view .computer-teams button.ct-open'), /background:none; color:var\(--fg\); font-weight:700; font-size:17px; line-height:1.3;/, 'the openable label reads as the plain one');
  assert.match(rule('.computer-teams .ct-empty'), /padding:16px 18px; border:1px dashed var\(--tree-line\); border-radius:10px; color:var\(--muted\); font-size:13px/);
  assert.match(rule('.oats-view .computer-teams button.ct-link'), /border:0;.*background:none; color:var\(--accent\)/);
  // Rule 2 is the shell's (theme.css :focus-visible): the page adds no focus rule of its own for its buttons.
  assert.doesNotMatch(computerTeamsCSS, /button[^{]*:focus|outline:2px|outline-offset/);
  // Rule 3: one border per field, the wrapper's; accent on focus-within; the input has none in every state.
  assert.match(rule('.computer-teams .ct-field'), /border:1px solid var\(--border\)/); assert.match(rule('.computer-teams .ct-field:focus-within'), /border-color:var\(--accent\)/);
  assert.match(rule('.oats-view .computer-teams .ct-field input'), /border:0; outline:none/);
  assert.match(rule('.oats-view .computer-teams .ct-field input:focus, .oats-view .computer-teams .ct-field input:focus-visible'), /border:0; outline:none/);
});

test('the copy is the board\'s; the roster shows only matches, and nothing without a roster', async t => {
  const u = await mount(t, 'light');
  assert.equal(u.doc.querySelector('.ct-lead').textContent, 'Who your agents can message. A team never adds capabilities or restricts what a soul can do.');
  assert.deepEqual([...u.doc.querySelectorAll('.ct-section-head')].map(h => [h.querySelector('.ct-section-title').textContent, h.querySelector('.ct-section-lead').textContent]),
    [['Shared teams', 'Declared in oats-workspace.yaml and shared through Git, so every computer that runs the workspace has them.'],
      ['Local teams', 'Only on this computer, in its oats-local.yaml. Not shared.']]);
  // Each card's foot sums up your instances on it; a team with no provider id has none, so no foot (nothing opens the card here).
  assert.deepEqual([...u.doc.querySelectorAll('.ct-card')].map(c => [c.dataset.team, c.querySelector('.ct-foot')?.textContent ?? null]),
    [['engineering', '1 of your instances'], ['global', null], ['marketing', null], ['mine', '1 of your instances']]);
  // Where the card opens its team's page, every card has the foot's cue; the unmapped teams' sums stay empty.
  const open = await mount(t, 'light', { onOpenTeam: () => {} });
  assert.deepEqual([...open.doc.querySelectorAll('.ct-card')].map(c => [c.dataset.team, c.querySelector('.ct-sum').textContent, c.querySelector('.ct-go').textContent, c.querySelector('.ct-go').getAttribute('aria-hidden')]),
    [['engineering', '1 of your instances', 'Open team', 'true'], ['global', '', 'Open team', 'true'], ['marketing', '', 'Open team', 'true'], ['mine', '1 of your instances', 'Open team', 'true']]);
  const dom = new JSDOM('<!doctype html><body><main class="oats-view"></main></body>'), doc = dom.window.document;
  const bare = createComputerTeams(doc, { request: async () => document() }); doc.querySelector('main').append(bare.element);
  t.after(() => { bare.dispose(); dom.window.close(); }); await tick();
  assert.equal(doc.querySelector('.ct-foot, .ct-sum'), null, 'no roster option: nothing about instances');
  assert.doesNotMatch(doc.querySelector('main').textContent, /instance/i);
});
