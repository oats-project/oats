// #1144: the soul page's Skills groups — the soul's own skills (`inspect --soul --skills`, feature soul-skills,
// `souls[0].skills`) in the Instructions card, under "Defined in this soul" and again, each "From this soul", under
// "Composed for an instance" (until the kernel lists what capabilities add): the shared skill item
// (contents-reader.mjs `skillTreeItem`, as capability Contents), each file read under its repository path through
// the strict reader, links to a listed file opened in place. The answers are built on the shape the issue documents
// (`{name, path, description, files: [{path, bytes, text, binary, truncated, omitted?}], filesTruncated}`, every path
// relative to the soul's directory, a file's under its skill's), on this repository's oats-maintainer soul.
// The request path (gate, server, adapter) is soul-skills-gating.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSoulInstructions, skillsOf, soulFilePath, skillSource, SOUL_INSTRUCTIONS_COPY, OWN, COMPOSED } from '../renderer/soul-instructions.mjs';
import { SKILL_COPY, sizeText } from '../renderer/contents-reader.mjs';

const REVIEW_MD = `---\nname: oats-pr-review\ndescription: "The OATS repository's part of a review."\n---\n# Reviewing an OATS pull request\n\nSee [the checklist](references/checklist.md), [the release lane](../git-tag-release/SKILL.md), [a missing one](../git-tag-release/gone.md), [outside](../../../../docs/x.md), [GitHub](https://github.com/awebai/oats), [plain](http://example.com/y) and [mail](mailto:a@b.c).\n\n<script>alert(1)</script><img src="https://evil.example/x.png" onerror="alert(2)">\n\n## Usage\n\nRead [usage](#usage).\n`;
const file = (path, text, over = {}) => ({ path, bytes: Buffer.byteLength(text ?? ''), text, binary: false, truncated: false, ...over });
/** Two skills, as `inspect --soul oats-maintainer --skills` answers them (sorted by name). */
const skillsAnswer = () => [
  { name: 'git-tag-release', path: 'skills/git-tag-release', description: "OATS's release lane: the release workflow and scripts. Load it with /plan-and-ship-release.",
    files: [file('skills/git-tag-release/SKILL.md', '---\nname: git-tag-release\n---\n# OATS\'s release lane\n')], filesTruncated: false },
  { name: 'oats-pr-review', path: 'skills/oats-pr-review', description: "The OATS repository's part of a review: which consumers to read. Load it with /pr-review.",
    files: [
      file('skills/oats-pr-review/references/checklist.md', '# Checklist\n\n- one\n'),
      file('skills/oats-pr-review/SKILL.md', REVIEW_MD),
      file('skills/oats-pr-review/scripts/check.sh', '#!/bin/sh\necho "<b>not markup</b>"\n'),
      file('skills/oats-pr-review/assets/logo.png', null, { bytes: 2048, binary: true }),
      file('skills/oats-pr-review/references/big.md', null, { bytes: 900000, omitted: true }),
      file('skills/oats-pr-review/references/cut.md', '# Cut\n', { bytes: 300000, truncated: true }),
    ], filesTruncated: true },
];
const AGENTS = '# oats-maintainer\n\nLoad [the review skill](skills/oats-pr-review/SKILL.md).\n';
const row = (over = {}) => ({ name: 'oats-maintainer', path: 'souls/oats-maintainer', instructions: { file: '/cache/AGENTS.md', text: AGENTS, truncated: false },
  skills: skillsAnswer(), ...over });
const flush = () => new Promise(r => setTimeout(r, 0));

function setup(t, options = {}) {
  const dom = new JSDOM('<!doctype html><body><main></main></body>', { pretendToBeVisual: true });
  const doc = dom.window.document, host = doc.querySelector('main'), opened = [];
  const section = createSoulInstructions(doc, { openExternal: url => opened.push(url), ...options });
  host.append(section.element);
  t.after(() => { section.dispose(); dom.window.close(); });
  const $ = s => host.querySelector(s), $$ = s => [...host.querySelectorAll(s)];
  const key = (el, k) => el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  // The first match is in "Defined in this soul"; the composed Skills' copies are `copy(path)` and their files `composed-file:<skill path>//<path in the skill>`.
  const item = path => $$('[role=treeitem]').find(i => i.dataset.path === path) || null;
  const skill = path => $$('[role=treeitem]').find(i => i.dataset.skill === path) || null;
  const copy = path => $$('[role=treeitem]').find(i => i.dataset.focusKey === `instructions:composed-skill:${path}`) || null;
  /** Every labelled group, in document order: the two sections and the groups inside them. */
  const groups = () => $$('[role=tree] ul[role=group][aria-labelledby]').map(g => doc.getElementById(g.getAttribute('aria-labelledby')).textContent);
  /** The two sections' rows (the tree's top-level groups). */
  const sections = () => $$('[role=tree] > li[role=none] > ul[role=group]');
  return { dom, doc, host, section, opened, $, $$, key, item, skill, copy, groups, sections };
}
function scrollable(el) { let top = 0; Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: v => { top = Math.max(0, Number(v) || 0); } }); return el; }
/** A composed answer of one body and no blocks (the composed AGENTS.md, for order). */
const composedOf1 = text => ({ file: null, text, truncated: false, resolution: 'r', body: { start: 0, end: text.length, truncated: false }, sources: [] });

/* ── the contract's decoder ──────────────────────────────────────────── */
test('skillsOf: absent, null, [], a valid answer normalized', () => {
  assert.equal(skillsOf({ name: 'x' }), undefined); assert.equal(skillsOf(null), undefined);
  assert.equal(skillsOf({ skills: null }), null);
  assert.deepEqual(skillsOf({ skills: [] }), []);
  const shown = skillsOf(row());
  assert.deepEqual(shown.map(s => [s.name, s.path, s.filesTruncated, s.files.length]), [['git-tag-release', 'skills/git-tag-release', false, 1], ['oats-pr-review', 'skills/oats-pr-review', true, 6]]);
  assert.deepEqual(shown[1].files.find(f => f.binary), { path: 'skills/oats-pr-review/assets/logo.png', bytes: 2048, text: null, binary: true, truncated: false, omitted: false });
  assert.equal(shown[1].files.find(f => f.path.endsWith('big.md')).omitted, true);
  // An optional description and filesTruncated; an unlisted skill.
  assert.deepEqual(skillsOf({ skills: [{ name: 'a', path: 'skills/a', files: null }] }), [{ name: 'a', path: 'skills/a', description: null, files: null, filesTruncated: false }]);
});

test('skillsOf: every contract break makes the whole answer false (never a partial list)', () => {
  const good = skillsAnswer()[0];
  const withSkill = over => ({ skills: [good, { ...skillsAnswer()[1], ...over }] });
  const withFile = over => withSkill({ files: [file('skills/oats-pr-review/SKILL.md', 'x', over)] });
  const breaks = {
    'not an array': { skills: { 0: good } }, 'a string': { skills: 'skills' }, 'a skill not a record': { skills: [good, 'x'] },
    'no name': withSkill({ name: '' }), 'a name not a string': withSkill({ name: 5 }),
    'an absolute path': withSkill({ path: '/abs/skills/x' }), 'a parent path': withSkill({ path: 'skills/../x' }), 'a backslash': withSkill({ path: 'skills\\x' }),
    'a duplicate skill path': { skills: [good, good] }, 'a description not a string': withSkill({ description: 7 }),
    'filesTruncated not a boolean': withSkill({ filesTruncated: 'yes' }), 'files not an array': withSkill({ files: 'x' }),
    'unlisted yet truncated': withSkill({ files: null, filesTruncated: true }),
    'a file not a record': withSkill({ files: [null] }),
    'a file outside its skill': withSkill({ files: [file('skills/git-tag-release/SKILL.md', 'x')] }),
    'a file at the skill root itself': withSkill({ files: [file('skills/oats-pr-review', 'x')] }),
    'a file path with ..': withSkill({ files: [file('skills/oats-pr-review/../x.md', 'x')] }),
    'a duplicate file': withSkill({ files: [file('skills/oats-pr-review/SKILL.md', 'x'), file('skills/oats-pr-review/SKILL.md', 'y')] }),
    'negative bytes': withFile({ bytes: -1 }), 'fractional bytes': withFile({ bytes: 1.5 }), 'bytes a string': withFile({ bytes: '1' }),
    'text a number': withFile({ text: 5 }), 'binary not a boolean': withFile({ binary: 'no' }), 'truncated missing': withFile({ truncated: undefined }),
    'omitted false': withFile({ omitted: false }), 'omitted with text': withFile({ omitted: true }), 'binary with text': withFile({ binary: true }),
    'text null, neither binary nor omitted': withFile({ text: null }),
  };
  for (const [what, soul] of Object.entries(breaks)) assert.equal(skillsOf(soul), false, what);
});

test('repository paths: the soul directory joined when it is a plain path, else the soul-relative path', () => {
  assert.equal(soulFilePath('souls/oats-maintainer', 'skills/a/SKILL.md'), 'souls/oats-maintainer/skills/a/SKILL.md');
  assert.equal(soulFilePath('souls/x/', 'skills/a/SKILL.md'), 'souls/x/skills/a/SKILL.md');
  for (const bad of [null, undefined, '', '/abs', '../x']) assert.equal(soulFilePath(bad, 'skills/a/SKILL.md'), 'skills/a/SKILL.md', JSON.stringify(bad));
});

/* ── the group ───────────────────────────────────────────────────────── */
test('navigation: Skills under each section; each skill its mono name, its description\'s first sentence, collapsed', t => {
  const u = setup(t); u.section.update(row({ composedInstructions: composedOf1('# x\n') }));
  assert.deepEqual(u.groups(), ['Defined in this soul', 'Skills', 'Composed for an instance', 'Skills']);
  const [soulSection] = u.sections();
  const skills = soulSection.querySelector('ul[role=group][aria-labelledby]').querySelectorAll(':scope > [role=treeitem]');
  assert.deepEqual([...skills].map(s => s.getAttribute('aria-label')), ['git-tag-release', 'oats-pr-review']);
  const review = u.skill('skills/oats-pr-review');
  assert.equal(review.querySelector('.cap-node-name').className, 'cap-node-name mono');
  assert.equal(review.querySelector('.cap-node-desc').textContent, "The OATS repository's part of a review: which consumers to read.");
  assert.equal(review.querySelector(':scope > .cap-node').title, skillsAnswer()[1].description, 'the full description in the title');
  assert.equal(review.getAttribute('aria-description'), "The OATS repository's part of a review: which consumers to read. More files not listed.");
  assert.equal(review.getAttribute('aria-expanded'), 'false'); assert.equal(review.getAttribute('aria-level'), '1');
  assert.equal(u.section.selected, OWN, 'the soul\'s AGENTS.md stays the file opened first');
  assert.equal(u.$('.cap-reader-path').textContent, 'souls/oats-maintainer/AGENTS.md');
});

test('composed Skills: after the composed AGENTS.md, each skill again saying "From this soul", then the note on capability skills', t => {
  const u = setup(t); u.section.update(row({ composedInstructions: composedOf1('# x\n') }));
  const [, composedSection] = u.sections();
  assert.deepEqual([...composedSection.children].map(c => c.getAttribute('role')), ['treeitem', 'none'], 'the composed AGENTS.md, then the Skills row');
  assert.equal(composedSection.children[0].dataset.path, COMPOSED);
  const skillsRow = composedSection.children[1], skillsGroup = skillsRow.querySelector(':scope > ul[role=group]');
  assert.deepEqual([...skillsRow.children].map(c => [c.className, c.tagName === 'UL' ? '' : c.textContent]),
    [['cap-contents-group-label', 'Skills'], ['', ''], ['cap-contents-note', 'Skills that capabilities add are listed by a newer OATS.']]);
  const copies = [...skillsGroup.querySelectorAll(':scope > [role=treeitem]')];
  assert.deepEqual(copies.map(s => s.getAttribute('aria-label')), ['git-tag-release', 'oats-pr-review']);
  const review = u.copy('skills/oats-pr-review');
  assert.equal(review, copies[1]); assert.notEqual(review, u.skill('skills/oats-pr-review'), 'its own row, not the one above');
  assert.equal(review.querySelector('.cap-node-desc').textContent, 'From this soul', 'where it comes from, in place of the sentence');
  assert.equal(review.getAttribute('aria-description'), "From this soul. The OATS repository's part of a review: which consumers to read. More files not listed.");
  assert.equal(review.querySelector(':scope > .cap-node').title, skillsAnswer()[1].description);
  assert.equal(review.getAttribute('aria-expanded'), 'false'); assert.equal(review.getAttribute('aria-level'), '1');
  // A skill whose files can't be listed says where it comes from too.
  u.section.update(row({ skills: [{ ...skillsAnswer()[1], files: null, filesTruncated: false }] }));
  const unlisted = u.copy('skills/oats-pr-review');
  assert.equal(unlisted.querySelector('.cap-node-desc').textContent, "From this soul · Its files can't be listed.");
  assert.equal(unlisted.getAttribute('aria-description'), "From this soul · Its files can't be listed.");
});

test('skillSource: the soul, or a capability by its id, as the composed parts name their sources', () => {
  assert.deepEqual(skillSource('soul'), { label: 'From this soul', capability: null });
  assert.deepEqual(skillSource('module:oats.core'), { label: 'From oats.core', capability: 'oats.core' });
  for (const other of ['capability:oats.core', 'module:', '', null, undefined]) assert.deepEqual(skillSource(other), { label: null, capability: null }, `${other}: no guess`);
});

test('a composed skill file: its own selection, links staying in the composed section, kept by a refresh', t => {
  const u = setup(t); u.section.update(row({ composedInstructions: composedOf1('# x\n') }));
  const review = u.copy('skills/oats-pr-review');
  review.querySelector(':scope > .cap-node').click();
  assert.equal(review.getAttribute('aria-expanded'), 'true'); assert.equal(u.skill('skills/oats-pr-review').getAttribute('aria-expanded'), 'false', 'the copy expands on its own');
  const key = 'composed-file:skills/oats-pr-review//SKILL.md';
  u.item(key).querySelector('.cap-node').click();
  assert.equal(u.section.selected, key);
  assert.equal(u.$('.cap-reader-path').textContent, 'souls/oats-maintainer/skills/oats-pr-review/SKILL.md', 'the same file, its repository path');
  assert.deepEqual(u.$$('[role=treeitem][aria-selected=true]').map(i => i.dataset.path), [key], 'one selected item: the copy\'s, not the one above');
  // A link from the composed copy opens the composed copy of its target.
  u.$$('.cap-reader-body a').find(a => a.textContent === 'the release lane').click();
  assert.equal(u.section.selected, 'composed-file:skills/git-tag-release//SKILL.md');
  assert.equal(u.copy('skills/git-tag-release').getAttribute('aria-expanded'), 'true');
  assert.equal(u.skill('skills/git-tag-release').getAttribute('aria-expanded'), 'false');
  u.item('composed-file:skills/git-tag-release//SKILL.md').focus();
  // A refresh with another skill: selection, expansion and focus are found again by their keys.
  const more = [{ name: 'aaa', path: 'skills/aaa', description: null, files: [file('skills/aaa/SKILL.md', '# a\n')], filesTruncated: false }, ...skillsAnswer()];
  u.section.update(row({ skills: more, composedInstructions: composedOf1('# x\n') }));
  assert.equal(u.section.selected, 'composed-file:skills/git-tag-release//SKILL.md');
  assert.equal(u.doc.activeElement, u.item('composed-file:skills/git-tag-release//SKILL.md'));
  assert.equal(u.copy('skills/oats-pr-review').getAttribute('aria-expanded'), 'true');
  // From the composed AGENTS.md a link to a skill file opens its composed copy; from the soul's own, the one above.
  u.item(OWN).querySelector('.cap-node').click();
  u.$$('.cap-reader-body a').find(a => a.textContent === 'the review skill').click();
  assert.equal(u.section.selected, 'file:skills/oats-pr-review/SKILL.md');
});

test('a skill: selecting it toggles it; its files SKILL.md first, relative to the skill, then "more files"', t => {
  const u = setup(t); u.section.update(row());
  const review = u.skill('skills/oats-pr-review');
  review.querySelector(':scope > .cap-node').click();
  assert.equal(review.getAttribute('aria-expanded'), 'true'); assert.equal(u.section.selected, OWN, 'a skill opens nothing');
  assert.deepEqual([...review.querySelectorAll('[role=treeitem]')].map(i => i.getAttribute('aria-label')),
    ['SKILL.md', 'references/checklist.md', 'scripts/check.sh', 'assets/logo.png', 'references/big.md', 'references/cut.md']);
  assert.ok([...review.querySelectorAll('[role=treeitem] .cap-node-name')].every(n => n.classList.contains('mono')), 'file names are monospace');
  assert.equal(review.querySelector('.cap-more').textContent, SKILL_COPY.moreFiles);
  review.querySelector(':scope > .cap-node').click();
  assert.equal(review.getAttribute('aria-expanded'), 'false');
});

test('notes: absent, [], null and a broken answer each a label and its note in place, in both sections; never an empty list', t => {
  const u = setup(t);
  const cases = [[undefined, SOUL_INSTRUCTIONS_COPY.skillsAbsent], [[], SOUL_INSTRUCTIONS_COPY.noSkills], [null, SOUL_INSTRUCTIONS_COPY.skillsUnlistable],
    [[{ name: 'x', path: '/abs' }], SOUL_INSTRUCTIONS_COPY.skillsUnreadable]];
  assert.deepEqual(cases.map(c => c[1]), ["This OATS doesn't report a soul's skills.", 'No skills of its own.', "Its skills can't be listed: see the problem above.",
    "This OATS answered skills this Desktop can't read."]);
  for (const [skills, note] of cases) {
    const { skills: _drop, ...without } = row({ composedInstructions: composedOf1('# x\n') }); void _drop;
    u.section.update(skills === undefined ? without : { ...without, skills });
    const [soulSection, composedSection] = u.sections();
    assert.deepEqual([...soulSection.children].map(c => c.getAttribute('role')), ['treeitem', 'none'], 'AGENTS.md, the Skills row');
    const row1 = soulSection.children[1];
    assert.deepEqual([...row1.children].map(c => [c.className, c.textContent]), [['cap-contents-group-label', 'Skills'], ['cap-contents-note', note]]);
    assert.equal(row1.querySelector('[role=treeitem], [role=group]'), null, 'a note is not a tree item');
    // The composed Skills: today's note for that case; a listed answer (an empty one) is followed by the capability note.
    const row2 = composedSection.children[1];
    assert.deepEqual([...row2.children].map(c => [c.className, c.textContent]), [['cap-contents-group-label', 'Skills'], ['cap-contents-note', note],
      ...(Array.isArray(skills) && note === SOUL_INSTRUCTIONS_COPY.noSkills ? [['cap-contents-note', SOUL_INSTRUCTIONS_COPY.capabilitySkills]] : [])]);
    assert.equal(row2.querySelector('[role=treeitem], [role=group]'), null);
    assert.deepEqual(u.groups(), ['Defined in this soul', 'Composed for an instance']);
  }
  // The same place when nothing follows.
  u.section.update(row({ skills: [] }));
  assert.equal(u.sections()[0].querySelector('.cap-contents-note').textContent, SOUL_INSTRUCTIONS_COPY.noSkills);
});

test('a skill whose files can\'t be listed: a reachable item that says so and opens nothing', t => {
  const u = setup(t); u.section.update(row({ skills: [{ ...skillsAnswer()[1], files: null, filesTruncated: false }] }));
  const item = u.$$('[role=treeitem]').find(i => i.getAttribute('aria-label') === 'oats-pr-review');
  assert.equal(item.getAttribute('aria-disabled'), 'true'); assert.equal(item.hasAttribute('aria-expanded'), false);
  assert.equal(item.getAttribute('aria-description'), SKILL_COPY.unlisted);
  assert.equal(item.querySelector('.cap-node-desc').textContent, "Its files can't be listed.");
  item.querySelector('.cap-node').click(); u.key(item, 'Enter');
  assert.equal(u.section.selected, OWN); assert.equal(u.doc.activeElement, item);
});

test('keyboard: one tree, one tab stop, the arrows across both sections and every group; Enter toggles a skill and opens a file', t => {
  const u = setup(t); u.section.update(row({ composedInstructions: composedOf1('# x\n') }));
  const own = u.item(OWN), release = u.skill('skills/git-tag-release'), review = u.skill('skills/oats-pr-review'), composed = u.item(COMPOSED);
  const lastCopy = u.copy('skills/oats-pr-review');
  own.focus();
  u.key(own, 'ArrowDown'); assert.equal(u.doc.activeElement, release, 'from AGENTS.md into Skills');
  u.key(release, 'ArrowDown'); assert.equal(u.doc.activeElement, review);
  u.key(review, 'ArrowDown'); assert.equal(u.doc.activeElement, composed, 'and on across the section boundary');
  u.key(composed, 'ArrowDown'); assert.equal(u.doc.activeElement, u.copy('skills/git-tag-release'), 'into the composed Skills');
  u.key(composed, 'Home'); assert.equal(u.doc.activeElement, own);
  u.key(own, 'ArrowDown'); u.key(release, 'ArrowDown');
  u.key(review, 'Enter'); assert.equal(review.getAttribute('aria-expanded'), 'true', 'Enter toggles a skill'); assert.equal(u.section.selected, OWN);
  u.key(review, 'ArrowRight'); const skillMd = u.item('file:skills/oats-pr-review/SKILL.md'); assert.equal(u.doc.activeElement, skillMd, 'Right enters the skill');
  u.key(skillMd, 'Enter'); assert.equal(u.section.selected, 'file:skills/oats-pr-review/SKILL.md');
  assert.equal(u.$('.cap-reader-path').textContent, 'souls/oats-maintainer/skills/oats-pr-review/SKILL.md');
  assert.equal(skillMd.getAttribute('aria-selected'), 'true'); assert.equal(own.getAttribute('aria-selected'), 'false');
  u.key(skillMd, 'ArrowLeft'); assert.equal(u.doc.activeElement, review, 'Left climbs to its skill');
  u.key(review, 'ArrowLeft'); assert.equal(review.getAttribute('aria-expanded'), 'false');
  assert.equal(u.$$('[role=treeitem][tabindex="0"]').length, 1, 'one tab stop');
  u.key(review, 'End'); assert.equal(u.doc.activeElement, lastCopy);
});

/* ── the reader ──────────────────────────────────────────────────────── */
test('a file: its repository path, its size; Markdown through the strict reader, front matter as facts, no raw HTML or images', t => {
  const u = setup(t); u.section.update(row());
  u.skill('skills/oats-pr-review').querySelector(':scope > .cap-node').click();
  u.item('file:skills/oats-pr-review/SKILL.md').querySelector('.cap-node').click();
  assert.equal(u.$('.cap-reader-path').textContent, 'souls/oats-maintainer/skills/oats-pr-review/SKILL.md');
  assert.equal(u.$('.cap-reader-size').textContent, sizeText(Buffer.byteLength(REVIEW_MD)));
  assert.equal(u.$('.cap-reader-flag'), null);
  assert.deepEqual([...u.$$('.cap-fm th')].map(th => th.textContent), ['name', 'description']);
  assert.equal(u.$('.mdv h1').textContent, 'Reviewing an OATS pull request');
  assert.equal(u.$('.cap-reader-body script'), null); assert.equal(u.$('.cap-reader-body img'), null);
  assert.match(u.$('.cap-reader-body').textContent, /<script>alert\(1\)<\/script>/, 'raw HTML is shown as text');
  assert.equal(u.$('.cap-reader-body [onerror], .cap-reader-body [src]'), null, 'no attribute made from the text');
});

test('other text highlighted; binary, omitted and truncated files', t => {
  const u = setup(t); u.section.update(row());
  const open = path => { if (u.skill('skills/oats-pr-review').getAttribute('aria-expanded') === 'false') u.skill('skills/oats-pr-review').querySelector(':scope > .cap-node').click(); u.item(`file:${path}`).querySelector('.cap-node').click(); };
  open('skills/oats-pr-review/scripts/check.sh');
  assert.equal(u.$('.cap-reader-body .mdv h1'), null); assert.ok(u.$('.cap-reader-body .mdv pre, .cap-reader-body .mdv code'), 'highlighted code');
  assert.equal(u.$('.cap-reader-body b'), null); assert.match(u.$('.cap-reader-body').textContent, /<b>not markup<\/b>/);
  open('skills/oats-pr-review/assets/logo.png');
  assert.equal(u.$('.cap-reader-path').textContent, 'souls/oats-maintainer/skills/oats-pr-review/assets/logo.png');
  assert.equal(u.$('.cap-reader-size').textContent, '2 KiB'); assert.equal(u.$('.cap-reader-body').textContent, 'Binary file; not shown.');
  open('skills/oats-pr-review/references/big.md');
  assert.equal(u.$('.cap-reader-body').textContent, 'Not shown: past the size limit of this answer.'); assert.equal(u.$('.cap-reader-size').textContent, '878.9 KiB');
  assert.equal(u.$('.cap-reader-flag'), null);
  open('skills/oats-pr-review/references/cut.md');
  assert.equal(u.$('.cap-reader-flag').textContent, 'Truncated at 256 KiB'); assert.equal(u.$('.mdv h1').textContent, 'Cut');
});

test('links: a listed file opens in place (its skill expanded), https goes out, anything else is text', t => {
  const u = setup(t); u.section.update(row());
  const reader = scrollable(u.$('.cap-contents-reader'));
  u.skill('skills/oats-pr-review').querySelector(':scope > .cap-node').click();
  u.item('file:skills/oats-pr-review/SKILL.md').querySelector('.cap-node').click();
  const links = Object.fromEntries(u.$$('.cap-reader-body a').map(a => [a.textContent, a]));
  assert.deepEqual(Object.keys(links).sort(), ['GitHub', 'the checklist', 'the release lane', 'usage'], 'the missing, outside, http and mailto links are text');
  assert.match(u.$('.cap-reader-body').textContent, /a missing one, outside, GitHub, plain and mail/);
  links.GitHub.click(); assert.deepEqual(u.opened, ['https://github.com/awebai/oats']);
  reader.scrollTop = 300;
  links['the checklist'].click();
  assert.equal(u.section.selected, 'file:skills/oats-pr-review/references/checklist.md'); assert.equal(u.$('.cap-reader-path').textContent, 'souls/oats-maintainer/skills/oats-pr-review/references/checklist.md');
  assert.equal(reader.scrollTop, 0, 'a new file opens at its top');
  u.item('file:skills/oats-pr-review/SKILL.md').querySelector('.cap-node').click();
  const release = u.skill('skills/git-tag-release'); assert.equal(release.getAttribute('aria-expanded'), 'false');
  u.$$('.cap-reader-body a').find(a => a.textContent === 'the release lane').click();
  assert.equal(u.section.selected, 'file:skills/git-tag-release/SKILL.md', '../other-skill/SKILL.md opens when listed');
  assert.equal(release.getAttribute('aria-expanded'), 'true', 'its skill is expanded to show it');
  assert.equal(u.item('file:skills/git-tag-release/SKILL.md').getAttribute('aria-selected'), 'true');
});

test('links from the soul\'s own AGENTS.md to a listed skill file open it in place (one resolver, by repository path)', t => {
  const u = setup(t); u.section.update(row());
  const link = u.$$('.cap-reader-body a').find(a => a.textContent === 'the review skill');
  assert.ok(link, 'the AGENTS.md link resolves to souls/oats-maintainer/skills/oats-pr-review/SKILL.md, which the answer lists');
  link.click();
  assert.equal(u.section.selected, 'file:skills/oats-pr-review/SKILL.md');
  // Without the skills the same link is text.
  const { skills: _drop, ...without } = row(); void _drop;
  u.item(OWN).querySelector('.cap-node').click(); u.section.update(without);
  assert.equal(u.$$('.cap-reader-body a').find(a => a.textContent === 'the review skill'), undefined);
});

test('hostile names, descriptions and text stay literal: nothing is made from them', t => {
  const u = setup(t);
  const name = '<img src=x onerror=alert(1)>', description = '<b>bold</b> {{agent.name}} https://evil.example/x. Second.';
  u.section.update(row({ skills: [{ name, path: 'skills/evil', description, files: [file('skills/evil/SKILL.md', '<iframe src="https://evil.example"></iframe>\n\n{{placeholder}}\n')], filesTruncated: false }] }));
  const item = u.skill('skills/evil');
  assert.equal(u.$('.cap-contents-nav img, .cap-contents-nav b, .cap-contents-nav a'), null, 'no element from a name or a description');
  assert.equal(item.querySelector('.cap-node-name').textContent, name); assert.equal(item.getAttribute('aria-label'), name);
  assert.equal(item.querySelector('.cap-node-desc').textContent, '<b>bold</b> {{agent.name}} https://evil.example/x.');
  assert.equal(item.querySelector(':scope > .cap-node').title, description);
  item.querySelector(':scope > .cap-node').click(); u.item('file:skills/evil/SKILL.md').querySelector('.cap-node').click();
  assert.equal(u.$('.cap-reader-body iframe'), null); assert.match(u.$('.cap-reader-body').textContent, /<iframe src="https:\/\/evil\.example"><\/iframe>/);
  assert.match(u.$('.cap-reader-body').textContent, /\{\{placeholder\}\}/);
});

/* ── repaint and refresh ─────────────────────────────────────────────── */
test('repaint: an unchanged answer rebuilds nothing; hold() keeps focus and both scroll offsets', t => {
  const u = setup(t); u.section.update(row());
  const nav = scrollable(u.$('.cap-contents-nav')), reader = scrollable(u.$('.cap-contents-reader'));
  u.skill('skills/oats-pr-review').querySelector(':scope > .cap-node').click();
  const fileItem = u.item('file:skills/oats-pr-review/SKILL.md'); fileItem.querySelector('.cap-node').click(); fileItem.focus();
  const view = u.$('.cap-reader-body .mdv');
  nav.scrollTop = 40; reader.scrollTop = 500;
  const restore = u.section.hold();
  u.section.element.remove(); u.section.update(row()); u.host.append(u.section.element); restore();
  assert.equal(u.item('file:skills/oats-pr-review/SKILL.md'), fileItem, 'the same tree nodes'); assert.equal(u.$('.cap-reader-body .mdv'), view, 'the same reader nodes');
  assert.equal(u.doc.activeElement, fileItem); assert.equal(nav.scrollTop, 40); assert.equal(reader.scrollTop, 500);
  assert.equal(u.skill('skills/oats-pr-review').getAttribute('aria-expanded'), 'true');
});

test('refresh: expansion, selection and focus survive while the skill and file exist; a removed file falls back to AGENTS.md', t => {
  const u = setup(t); u.section.update(row());
  u.skill('skills/oats-pr-review').querySelector(':scope > .cap-node').click();
  u.item('file:skills/oats-pr-review/SKILL.md').querySelector('.cap-node').click(); u.item('file:skills/oats-pr-review/SKILL.md').focus();
  // Another skill appears: the tree is rebuilt around the open file.
  const more = [{ name: 'aaa', path: 'skills/aaa', description: null, files: [file('skills/aaa/SKILL.md', '# a\n')], filesTruncated: false }, ...skillsAnswer()];
  u.section.update(row({ skills: more }));
  assert.equal(u.skill('skills/oats-pr-review').getAttribute('aria-expanded'), 'true', 'expanded still');
  assert.equal(u.section.selected, 'file:skills/oats-pr-review/SKILL.md');
  assert.equal(u.doc.activeElement, u.item('file:skills/oats-pr-review/SKILL.md'), 'focus found again by its key');
  // Its text changed: the reader repaints in place.
  const changed = more.map(s => s.path !== 'skills/oats-pr-review' ? s : { ...s, files: s.files.map(f => f.path.endsWith('/SKILL.md') ? file(f.path, '# Changed\n') : f) });
  u.section.update(row({ skills: changed })); assert.equal(u.$('.mdv h1').textContent, 'Changed');
  // The open file goes: AGENTS.md opens, and focus goes to its skill.
  const gone = changed.map(s => s.path !== 'skills/oats-pr-review' ? s : { ...s, files: s.files.filter(f => !f.path.endsWith('/SKILL.md')) });
  u.section.update(row({ skills: gone }));
  assert.equal(u.section.selected, OWN); assert.equal(u.$('.cap-reader-path').textContent, 'souls/oats-maintainer/AGENTS.md');
  assert.equal(u.doc.activeElement, u.skill('skills/oats-pr-review'));
});

test('each group on its own: skills without AGENTS.md or a composed answer, and a composed answer without skills', t => {
  const u = setup(t);
  u.section.update(row({ instructions: null }));
  assert.deepEqual(u.groups(), ['Defined in this soul', 'Skills', 'Composed for an instance', 'Skills']);
  assert.equal(u.item(COMPOSED), null, 'no composed AGENTS.md without the answer, and no note for it');
  assert.equal(u.$('.cap-reader-body').textContent, "This soul's AGENTS.md could not be read.");
  u.section.update(row({ skills: null, composedInstructions: composedOf1('# x\n') }));
  assert.deepEqual(u.groups(), ['Defined in this soul', 'Composed for an instance']);
  assert.ok(u.item(COMPOSED));
  u.section.update(row({ path: '/not/plain' }));
  u.skill('skills/git-tag-release').querySelector(':scope > .cap-node').click();
  u.item('file:skills/git-tag-release/SKILL.md').querySelector('.cap-node').click();
  assert.equal(u.$('.cap-reader-path').textContent, 'skills/git-tag-release/SKILL.md', 'no plain soul directory: the soul-relative path');
});

test('after dispose nothing opens', async t => {
  const u = setup(t); u.section.update(row());
  u.section.dispose(); await flush();
  u.section.update(row({ skills: [] }));
  assert.equal(u.skill('skills/oats-pr-review').isConnected, true, 'a disposed section is not repainted');
});
