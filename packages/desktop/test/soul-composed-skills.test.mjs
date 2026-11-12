// #1421 §1: the soul page's composed Skills from the kernel's list — `inspect --soul --composed-skills` (feature
// soul-composed-skills, `souls[0].composedSkills`): every skill a spawn gives the instance, each row saying where it
// comes from ("From this soul", "From <capability>"), a capability's files under their instance-home path with Open
// capability in the reader's head. Without the key, the composed Skills stay the soul's own and the "newer OATS" note
// (soul-skills.test.mjs). The answers are built on the shape the kernel documents (docs/desktop-cli-api.md:
// `{name, source, path, description, files: [{path, bytes, text, binary, truncated, omitted?}], filesTruncated}`, a soul
// skill's paths relative to the soul's directory, a capability's to the instance home). The request path is
// soul-composed-skills-gating.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createSoulInstructions, composedSkillsOf, SOUL_INSTRUCTIONS_COPY, OWN } from '../renderer/soul-instructions.mjs';
import { createSoulInspector } from '../renderer/soul-inspector.mjs';
import { setWorkspace, currentWorkspace } from '../renderer/views/common.mjs';
import { refreshCli, resetCliStateForTests } from '../renderer/views/cli-status.mjs';

const file = (path, text, over = {}) => ({ path, bytes: Buffer.byteLength(text ?? ''), text, binary: false, truncated: false, ...over });
const CORE = '.oats/modules/oats.core/skills/oats-operate';
/** As `inspect --soul oats-maintainer --composed-skills` answers it: sorted by name, a capability's skill among the soul's. */
const composedAnswer = () => [
  { name: 'git-tag-release', source: 'soul', path: 'skills/git-tag-release', description: "OATS's release lane.",
    files: [file('skills/git-tag-release/SKILL.md', '# Release lane\n\nSee [operate](../../../../.oats/modules/oats.core/skills/oats-operate/SKILL.md).\n')], filesTruncated: false },
  { name: 'oats-operate', source: 'module:oats.core', path: CORE, description: 'Operating OATS from an instance.',
    files: [file(`${CORE}/SKILL.md`, '# Operating OATS\n\nSee [the reference](references/commands.md).\n'), file(`${CORE}/references/commands.md`, '# Commands\n')], filesTruncated: false },
];
const ownSkills = () => [{ name: 'git-tag-release', path: 'skills/git-tag-release', description: "OATS's release lane.",
  files: [file('skills/git-tag-release/SKILL.md', '# Release lane\n')], filesTruncated: false }];
const AGENTS = '# oats-maintainer\n\nLoad [the release lane](skills/git-tag-release/SKILL.md).\n';
const row = (over = {}) => ({ name: 'oats-maintainer', path: 'souls/oats-maintainer', instructions: { file: '/cache/AGENTS.md', text: AGENTS, truncated: false },
  skills: ownSkills(), composedSkills: composedAnswer(), ...over });
const flush = () => new Promise(r => setTimeout(r, 0));

function setup(t, options = {}) {
  const dom = new JSDOM('<!doctype html><body><main></main></body>', { pretendToBeVisual: true });
  const doc = dom.window.document, host = doc.querySelector('main'), opened = [];
  const section = createSoulInstructions(doc, { openExternal: url => opened.push(url), ...options });
  host.append(section.element);
  t.after(() => { section.dispose(); dom.window.close(); });
  const $ = s => host.querySelector(s), $$ = s => [...host.querySelectorAll(s)];
  const item = key => $$('[role=treeitem]').find(i => i.dataset.path === key) || null;
  const copy = path => $$('[role=treeitem]').find(i => i.dataset.focusKey === `instructions:composed-skill:${path}`) || null;
  const [soulSection, composedSection] = [0, 1].map(i => () => $$('[role=tree] > li[role=none] > ul[role=group]')[i]);
  return { doc, host, section, opened, $, $$, item, copy, soulSection, composedSection };
}

/* ── the contract's decoder ──────────────────────────────────────────── */
test('composedSkillsOf: absent, null, [], a valid answer normalized with its source', () => {
  assert.equal(composedSkillsOf({ name: 'x' }), undefined); assert.equal(composedSkillsOf(null), undefined);
  assert.equal(composedSkillsOf({ composedSkills: null }), null);
  assert.deepEqual(composedSkillsOf({ composedSkills: [] }), []);
  const shown = composedSkillsOf(row());
  assert.deepEqual(shown.map(s => [s.name, s.source, s.path]), [['git-tag-release', 'soul', 'skills/git-tag-release'], ['oats-operate', 'module:oats.core', CORE]]);
  assert.deepEqual(shown[1].files.map(f => [f.path, f.omitted]), [[`${CORE}/SKILL.md`, false], [`${CORE}/references/commands.md`, false]]);
  // A source skillSource names nothing is still a row (its label is none, not a guess).
  assert.equal(composedSkillsOf({ composedSkills: [{ ...composedAnswer()[0], source: 'later:kind' }] })[0].source, 'later:kind');
});

test('composedSkillsOf: every contract break makes the whole answer false', () => {
  const [soul, core] = composedAnswer();
  const breaks = {
    'not a list': 'x', 'no source': [{ ...soul, source: undefined }], 'empty source': [{ ...soul, source: '' }], 'source not a string': [{ ...soul, source: 1 }],
    'absolute path': [{ ...core, path: '/home/x/.oats/modules/oats.core/skills/oats-operate' }], 'dot-dot path': [{ ...core, path: '../oats-operate' }],
    'same path twice': [soul, { ...soul, name: 'other' }], 'a file outside its skill': [{ ...core, files: [file('skills/git-tag-release/SKILL.md', 'x')] }],
    'a file listed twice': [core, { ...core, name: 'y', path: `${CORE}-2`, files: [file(`${CORE}/SKILL.md`, 'x')] }],
    'text on a binary file': [{ ...core, files: [file(`${CORE}/a.png`, 'x', { binary: true })] }],
  };
  for (const [what, composedSkills] of Object.entries(breaks)) assert.equal(composedSkillsOf({ composedSkills }), false, what);
});

/* ── the listing ─────────────────────────────────────────────────────── */
test('the composed Skills list the kernel’s rows in its order, each saying where it comes from; no "newer OATS" note', t => {
  const u = setup(t);
  u.section.update(row());
  const rows = [...u.composedSection().querySelectorAll('[role=treeitem][data-skill]')];
  assert.deepEqual(rows.map(r => [r.getAttribute('aria-label'), r.querySelector(':scope > .cap-node .cap-node-desc').textContent]),
    [['git-tag-release', SOUL_INSTRUCTIONS_COPY.fromSoul], ['oats-operate', 'From oats.core']]);
  assert.match(rows[1].getAttribute('aria-description'), /^From oats\.core\. Operating OATS from an instance\.$/);
  assert.equal(u.$$('.cap-contents-note').some(n => n.textContent === SOUL_INSTRUCTIONS_COPY.capabilitySkills), false);
  // "Defined in this soul" still lists the soul's own skills, with no source line.
  const own = [...u.soulSection().querySelectorAll('[role=treeitem][data-skill]')];
  assert.deepEqual(own.map(r => [r.getAttribute('aria-label'), r.querySelector('.cap-node-desc').textContent]), [['git-tag-release', "OATS's release lane."]]);
});

test('the composed Skills group when the list is empty, unlistable or unreadable: that case’s note alone', t => {
  const cases = [[[], SOUL_INSTRUCTIONS_COPY.noComposedSkills], [null, SOUL_INSTRUCTIONS_COPY.composedSkillsUnlistable], ['x', SOUL_INSTRUCTIONS_COPY.composedSkillsUnreadable]];
  for (const [composedSkills, note] of cases) {
    const u = setup(t);
    u.section.update(row({ composedSkills }));
    const skillsRow = [...u.composedSection().children].at(-1);
    assert.deepEqual([...skillsRow.children].map(c => [c.className, c.textContent]),
      [['cap-contents-group-label', SOUL_INSTRUCTIONS_COPY.skillsGroup], ['cap-contents-note', note]], JSON.stringify(composedSkills));
    assert.equal(u.composedSection().querySelector('[data-skill]'), null);
  }
  // Without the key: the soul's own again, then the note that a newer OATS lists the rest.
  const u = setup(t), older = row(); delete older.composedSkills; u.section.update(older);
  assert.equal(u.composedSection().querySelector('[data-skill]').getAttribute('aria-label'), 'git-tag-release');
  assert.equal(u.composedSection().querySelector(':scope .cap-contents-note').textContent, SOUL_INSTRUCTIONS_COPY.capabilitySkills);
});

test('a capability’s file opens under its instance-home path with Open capability in the head; a soul’s under its repository path, without', t => {
  const opened = [];
  const u = setup(t, { canOpenCapability: id => id === 'oats.core', openCapability: id => opened.push(id) });
  u.section.update(row());
  u.copy(CORE).querySelector('.cap-node').click();
  u.item(`composed-file:${CORE}//SKILL.md`).querySelector('.cap-node').click();
  assert.ok(u.$('.cap-reader-head').textContent.includes(`${CORE}/SKILL.md`));
  assert.ok(!u.$('.cap-reader-head').textContent.includes('souls/'), 'not under the soul’s directory');
  const button = u.$('.cap-reader-head button.soul-file-open');
  assert.ok(button); assert.equal(button.textContent, SOUL_INSTRUCTIONS_COPY.openCapability); assert.equal(button.getAttribute('aria-description'), 'oats.core');
  button.click(); assert.deepEqual(opened, ['oats.core']);
  // A soul skill's composed copy: its repository path, no Open capability.
  u.copy('skills/git-tag-release').querySelector('.cap-node').click();
  u.item('composed-file:skills/git-tag-release//SKILL.md').querySelector('.cap-node').click();
  assert.ok(u.$('.cap-reader-head').textContent.includes('souls/oats-maintainer/skills/git-tag-release/SKILL.md'));
  assert.equal(u.$('.cap-reader-head button.soul-file-open'), null);
  // A capability the page can't open: no button.
  const v = setup(t, { canOpenCapability: () => false, openCapability: () => assert.fail('not openable') });
  v.section.update(row());
  v.copy(CORE).querySelector('.cap-node').click(); v.item(`composed-file:${CORE}//SKILL.md`).querySelector('.cap-node').click();
  assert.equal(v.$('.cap-reader-head button.soul-file-open'), null);
});

test('links: inside a capability’s skill they open its listed files; a soul file’s link keeps to the section it is read in', t => {
  const u = setup(t);
  u.section.update(row());
  u.copy(CORE).querySelector('.cap-node').click();
  u.item(`composed-file:${CORE}//SKILL.md`).querySelector('.cap-node').click();
  u.$('.cap-reader-body a').click();
  assert.equal(u.section.selected, `composed-file:${CORE}//references/commands.md`);
  // From the composed copy of a soul skill, a link into a capability's skill opens it there.
  u.copy('skills/git-tag-release').querySelector('.cap-node').click();
  u.item('composed-file:skills/git-tag-release//SKILL.md').querySelector('.cap-node').click();
  u.$('.cap-reader-body a').click();
  assert.equal(u.section.selected, `composed-file:${CORE}//SKILL.md`);
  // From the soul's own AGENTS.md, a link to its skill opens the copy in "Defined in this soul".
  u.item(OWN).querySelector('.cap-node').click();
  u.$('.cap-reader-body a').click();
  assert.equal(u.section.selected, 'file:skills/git-tag-release/SKILL.md');
  // A link to a file listed in one section only opens it there, from either section.
  const v = setup(t);
  v.section.update(row({ instructions: { file: '/c', text: `[operate](../../${CORE}/SKILL.md)`, truncated: false } }));
  v.$('.cap-reader-body a').click();
  assert.equal(v.section.selected, `composed-file:${CORE}//SKILL.md`);
  const w = setup(t);
  w.section.update(row({ composedSkills: null, composedInstructions: { file: null, text: AGENTS, truncated: false, resolution: 'r',
    body: { start: 0, end: AGENTS.length, truncated: false }, sources: [] } }));
  w.item('composed').querySelector('.cap-node-name').click();
  w.$('.cap-reader-body a').click();
  assert.equal(w.section.selected, 'file:skills/git-tag-release/SKILL.md', 'the composed list is unlistable: the soul’s own copy');
});

test('a refresh with a changed composed list repaints the tree; an unchanged one keeps what is open', t => {
  const u = setup(t);
  u.section.update(row());
  const tree = u.$('[role=tree]');
  u.section.update(row());
  assert.equal(u.$('[role=tree]'), tree, 'unchanged: the same tree');
  u.section.update(row({ composedSkills: [composedAnswer()[0]] }));
  assert.notEqual(u.$('[role=tree]'), tree);
  assert.equal(u.copy(CORE), null);
});

test('a capability’s nested skills: both rows list their files, each its own item; a link keeps to the skill being read', t => {
  // A capability may declare skills/parent and skills/parent/child: the parent's files include the child's.
  const at = '.oats/modules/acme.ops/skills/parent', md = (path, text) => file(path, text);
  const parent = { name: 'parent', source: 'module:acme.ops', path: at, description: null, filesTruncated: false,
    files: [md(`${at}/SKILL.md`, '# Parent\n\nSee [the child](child/SKILL.md).\n'), md(`${at}/child/SKILL.md`, '# Child\n\nSee [its notes](notes.md).\n'), md(`${at}/child/notes.md`, '# Notes\n')] };
  const child = { name: 'parent-child', source: 'module:acme.ops', path: `${at}/child`, description: null, filesTruncated: false,
    files: [md(`${at}/child/SKILL.md`, '# Child\n\nSee [its notes](notes.md).\n'), md(`${at}/child/notes.md`, '# Notes\n')] };
  assert.deepEqual(composedSkillsOf({ composedSkills: [parent, child] }).map(s => [s.name, s.files.length]), [['parent', 3], ['parent-child', 2]]);
  assert.equal(composedSkillsOf({ composedSkills: [{ ...child, files: [...child.files, child.files[0]] }] }), false, 'a file twice in one skill still breaks it');
  const u = setup(t);
  u.section.update(row({ composedSkills: [parent, child] }));
  const ofParent = `composed-file:${at}//child/SKILL.md`, ofChild = `composed-file:${at}/child//SKILL.md`;
  assert.ok(u.item(ofParent) && u.item(ofChild) && u.item(ofParent) !== u.item(ofChild), 'one item each');
  u.copy(`${at}/child`).querySelector('.cap-node').click();
  u.item(ofChild).querySelector('.cap-node').click();
  assert.equal(u.section.selected, ofChild);
  assert.equal(u.item(ofChild).getAttribute('aria-selected'), 'true'); assert.equal(u.item(ofParent).getAttribute('aria-selected'), 'false');
  u.$('.cap-reader-body a').click();
  assert.equal(u.section.selected, `composed-file:${at}/child//notes.md`, 'from the child, its own copy');
  u.copy(at).querySelector('.cap-node').click();
  u.item(`composed-file:${at}//SKILL.md`).querySelector('.cap-node').click();
  u.$('.cap-reader-body a').click();
  assert.equal(u.section.selected, ofParent, 'from the parent, the parent’s copy');
});

/* ── on the soul page: the request ───────────────────────────────────── */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/workspace-v2/f7/inspect-soul.json', import.meta.url), 'utf8')).result;
const version = JSON.parse(readFileSync(new URL('./fixtures/workspace-v2/f7/version.json', import.meta.url), 'utf8'));
const agentsRoot = '/fixture/base/northwind-workspace/agents';
async function page(t, { layout = 'page', agent = {}, features = ['soul-composed-skills'] } = {}) {
  const previous = currentWorkspace(); setWorkspace('/team');
  await refreshCli({ api: async () => ({ ...version, features: [...version.features, ...features], ok: true, bin: '/fixture/bin/oats' }) });
  const bodies = [];
  const dom = new JSDOM('<body><main><aside hidden></aside></main></body>', { pretendToBeVisual: true }), el = dom.window.document.querySelector('aside');
  const inspector = createSoulInspector(el, { layout, ctx: { api: async (url, opts) => {
    if (!url.startsWith('/api/capabilities')) return { status: 'ok', soulTeams: {} };
    bodies.push(JSON.parse(opts.body)); return structuredClone(fixture);
  } } });
  t.after(() => { inspector.dispose(); dom.window.close(); setWorkspace(previous); resetCliStateForTests(); });
  await inspector.show({ agent: { name: 'release-manager', agentsRoot, ...agent }, selector: { soul: 'release-manager', agentsRoot } });
  for (let i = 0; i < 4; i++) await flush();
  return { bodies };
}

test('the soul page asks for the composed skills only with the feature; the sidebar never does; a remote soul only with server-probe-features', async t => {
  const selector = { soul: 'release-manager', agentsRoot };
  assert.deepEqual((await page(t)).bodies, [{ action: 'inspect', selector, composedSkills: true }]);
  for (const agent of [{ remote: true, server: 'builder' }, { server: 'builder' }])
    assert.deepEqual((await page(t, { agent, features: ['soul-composed-skills', 'server-probe-features'] })).bodies, [{ action: 'inspect', selector, composedSkills: true }], JSON.stringify(agent));
  for (const [label, options] of [['no feature', { features: [] }], ['own skills only', { features: ['soul-skills'] }], ['sidebar', { layout: 'sidebar' }],
    ['remote soul', { agent: { remote: true, server: 'builder' } }],
    ['remote soul, relays but does not list', { agent: { remote: true, server: 'builder' }, features: ['server-probe-features'] }]]) {
    const { bodies } = await page(t, options);
    assert.equal(bodies.some(b => Object.hasOwn(b, 'composedSkills')), false, label);
  }
});
