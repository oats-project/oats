import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createCapabilityContents, contentsSubject, defaultSelection, firstSentence, sizeText, CONTENTS_COPY, capabilityContentsCSS } from '../renderer/capability-contents.mjs';
import { renderCapabilityPage } from '../renderer/capability-page.mjs';

// Spec C: the capability page's Contents — navigation (inject, skills and their files) and an in-place reader.
const commit = 'c0ffee1'.padEnd(40, '0'), commit2 = 'beef'.padEnd(40, '1');
const cli = { ok: true, features: ['capability-show'], capabilityShowApi: 1 };
const memberRow = { name: 'oats.desktop-ui', kind: 'member', repoKey: 'github.com/awebai/oats', commit };
const packageRow = { name: 'oats.aweb', kind: 'package', package: 'oats.aweb', commit };
const SKILL = `---\nname: oats-aweb\ndescription: >\n  The OATS instance's aweb playbook.\n  Use it first.\n---\n# Playbook\n\nSee [refs](refs/a.md), [inject](../../inject.md), [missing](nope.md), [web](https://example.com/x), [plain](http://example.com/y), [mail](mailto:a@b.c) and [down](#usage).\n\n## Usage\n\ntext\n`;
const showAnswer = (over = {}) => ({
  capabilityShowApi: 1, name: 'oats.aweb', kind: 'package', repoKey: null, package: 'oats.aweb', version: '1.17.0', commit, path: 'capabilities/oats.aweb',
  inject: { path: 'inject.md', bytes: 2048, text: '# Messaging\n\nInjected text.\n', binary: false, truncated: false },
  skills: [
    { name: 'oats-aweb', path: 'skills/oats-aweb', description: 'The OATS instance\'s aweb playbook. Use it before your first mail.', files: [{ path: 'skills/oats-aweb/SKILL.md', bytes: 300 }, { path: 'skills/oats-aweb/logo.png', bytes: 99 }, { path: 'skills/oats-aweb/refs/a.md', bytes: 10 }], filesTruncated: true },
    { name: 'aweb-identity', path: 'skills/aweb-identity', description: null, files: [{ path: 'skills/aweb-identity/SKILL.md', bytes: 5 }], filesTruncated: false },
  ],
  problems: [], ...over,
});
const fileAnswer = (path, file = {}, at = commit) => ({ capabilityShowApi: 1, name: 'oats.aweb', kind: 'package', commit: at, file: { path, bytes: 300, text: `# ${path}\n`, binary: false, truncated: false, ...file } });
const flush = () => new Promise(r => setTimeout(r, 0));

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
/** A fake POST /api/capabilities: `answer(body)` returns a value, an Error to reject with, or a deferred. */
function setup(t, { answer = body => body.action === 'show' ? showAnswer() : fileAnswer(body.path), row = packageRow, update = {}, options = {} } = {}) {
  const dom = new JSDOM('<!doctype html><body><main></main></body>', { pretendToBeVisual: true });
  const doc = dom.window.document, host = doc.querySelector('main');
  const calls = [], opened = [], unknown = [];
  const contents = createCapabilityContents(doc, {
    request: body => { calls.push(body); const a = answer(body); if (a?.promise) return a.promise; return a instanceof Error ? Promise.reject(a) : Promise.resolve(structuredClone(a)); },
    openExternal: url => opened.push(url), onCatalogStale: () => unknown.push(true), ...options,
  });
  host.append(contents.element);
  t.after(() => { contents.dispose(); dom.window.close(); });
  const go = (u = {}) => contents.update({ row, cli, deployment: '/ws', ...update, ...u });
  const $ = s => host.querySelector(s), $$ = s => [...host.querySelectorAll(s)];
  const items = () => $$('[role=treeitem]').filter(i => !i.parentElement.closest('[aria-expanded=false]'));
  const key = (el, k) => el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  return { dom, doc, host, contents, calls, opened, unknown, go, $, $$, items, key, readerText: () => $('.cap-reader-body').textContent.trim() };
}
const err = (code, message = 'kernel says no') => Object.assign(new Error(message), { code });

test('helpers: first sentence, sizes, default selection', () => {
  assert.equal(firstSentence('The playbook. Use it first.'), 'The playbook.');
  assert.equal(firstSentence('No period here'), 'No period here');
  assert.equal(firstSentence('v1.2 is out. More.'), 'v1.2 is out.');
  assert.equal(sizeText(812), '812 B'); assert.equal(sizeText(4300), '4.2 KiB'); assert.equal(sizeText(262144), '256 KiB'); assert.equal(sizeText(null), null);
  assert.equal(defaultSelection(showAnswer()), 'inject.md');
  assert.equal(defaultSelection(showAnswer({ inject: null })), 'skills/oats-aweb/SKILL.md');
  assert.equal(defaultSelection(showAnswer({ inject: null, skills: [] })), null);
});

test('gating: an older CLI, a remote workspace, an external capability and an unlisted one make no call', async t => {
  assert.deepEqual(contentsSubject({ row: packageRow, cli: { ok: true, features: ['capability-show'] } }), { gate: CONTENTS_COPY.unsupported });
  assert.deepEqual(contentsSubject({ row: packageRow, cli, remote: true }), { gate: CONTENTS_COPY.remote });
  assert.deepEqual(contentsSubject({ row: { name: 'x', kind: 'external' }, cli }), { gate: CONTENTS_COPY.external });
  assert.deepEqual(contentsSubject({ row: null, cli }), { gate: CONTENTS_COPY.unlisted });
  const u = setup(t);
  u.go({ cli: { ok: true, features: [] } }); await flush();
  assert.equal(u.$('.cap-contents-gate').textContent, "This OATS version can't show what a capability ships. Update OATS to see its instructions and skill files.");
  assert.equal(u.$('.cap-contents').hidden, true);
  u.go({ remote: true }); await flush();
  assert.equal(u.$('.cap-contents-gate').textContent, 'Not available for a remote workspace yet.');
  assert.equal(u.calls.length, 0, 'no call while gated');
  u.go(); await flush();
  assert.equal(u.$('.cap-contents-gate').hidden, true); assert.equal(u.calls.length, 1, 'the gate lifting reads');
});

test('pending catalog: the navigation is a skeleton, no call, until the row lands', async t => {
  const u = setup(t);
  u.go({ catalogPending: true });
  assert.equal(u.$('.cap-contents-nav').getAttribute('aria-busy'), 'true');
  await new Promise(r => setTimeout(r, 200));
  assert.ok(u.$('.cap-nav-skeleton'), 'the skeleton stands in the left pane');
  assert.equal(u.calls.length, 0);
  u.go(); await flush(); await flush();
  assert.equal(u.$('.cap-nav-skeleton'), null); assert.equal(u.calls.length, 1);
  assert.deepEqual(u.calls[0], { action: 'show', capability: { name: 'oats.aweb', kind: 'package', package: 'oats.aweb' } });
});

test('navigation: Instructions then Skills, SKILL.md first, descriptions, truncation note, tree semantics', async t => {
  const u = setup(t); u.go(); await flush(); await flush();
  assert.equal(u.$('.page-section-lead').textContent, 'What an instance gets, at c0ffee1');
  assert.deepEqual(u.$$('.cap-contents-group-label').map(l => l.textContent), ['Instructions', 'Skills']);
  const tree = u.$('[role=tree]');
  assert.equal(u.$$('[role=tree]').length, 1, 'both groups in one tree (one tab stop)');
  assert.deepEqual(u.$$('[role=tree] > li > [role=group]').map(g => u.doc.getElementById(g.getAttribute('aria-labelledby')).textContent), ['Instructions', 'Skills']);
  const inject = u.$('[data-path="inject.md"]');
  assert.equal(inject.querySelector('.cap-node-name').textContent, 'Injected instructions');
  assert.equal(inject.querySelector('.cap-node-file').textContent, 'inject.md');
  const skill = u.$('[data-skill="skills/oats-aweb"]');
  assert.equal(skill.querySelector('.cap-node-name').textContent, 'oats-aweb');
  assert.equal(skill.querySelector('.cap-node-desc').textContent, "The OATS instance's aweb playbook.");
  assert.equal(skill.querySelector('.cap-node').title, "The OATS instance's aweb playbook. Use it before your first mail.");
  assert.equal(skill.getAttribute('aria-expanded'), 'false', 'a skill that does not hold the selection starts collapsed');
  assert.deepEqual([...skill.querySelectorAll('[role=treeitem]')].map(i => i.textContent), ['SKILL.md', 'logo.png', 'refs/a.md'], 'relative to the skill, SKILL.md first');
  assert.equal(skill.querySelector('.cap-more').textContent, 'More files not listed.');
  assert.match(skill.getAttribute('aria-description'), /More files not listed\./);
  assert.equal(inject.getAttribute('aria-selected'), 'true', 'the inject opens first');
  assert.deepEqual(u.$$('[role=treeitem]').filter(i => i.tabIndex === 0), [inject], 'one roving tab stop, on the open file');
  assert.equal(tree.getAttribute('aria-label'), 'Files of oats.aweb');
});

test('empty states and problems', async t => {
  const u = setup(t, { answer: () => showAnswer({ inject: null, skills: [], problems: [{ code: 'E_INJECT_MISSING', message: 'inject file is missing', path: 'inject.md' }, { code: 'W_X', message: 'something else', path: null }] }) });
  u.go(); await flush(); await flush();
  assert.deepEqual(u.$$('.cap-contents-note').map(n => n.textContent), ['Injects no instructions.', 'Ships no skills.']);
  assert.equal(u.$('[role=tree]'), null);
  assert.deepEqual(u.$$('.cap-contents-problem').map(p => p.textContent), ['inject.md — inject file is missing', 'something else']);
  assert.equal(u.$('.cap-contents-problem .mono').textContent, 'inject.md');
  assert.equal(u.readerText(), CONTENTS_COPY.empty);
  const v = setup(t, { answer: () => showAnswer({ skills: null }) });
  v.go(); await flush(); await flush();
  assert.equal(v.$('.cap-contents-note').textContent, "Its skills can't be listed: a spawn of it would refuse.");
  assert.ok(v.$('[role=tree] [data-path="inject.md"]'), 'the Instructions group still forms the tree');
  assert.equal(v.$$('.cap-contents-group-label').map(l => l.textContent).join(), 'Instructions,Skills', 'order kept');
});

test('default selection: no inject → the first skill\'s SKILL.md, its skill expanded, read with --file', async t => {
  const u = setup(t, { answer: body => body.action === 'show' ? showAnswer({ inject: null }) : fileAnswer(body.path) });
  u.go(); await flush(); await flush(); await flush();
  assert.deepEqual(u.calls[1], { action: 'file', capability: { name: 'oats.aweb', kind: 'package', package: 'oats.aweb' }, path: 'skills/oats-aweb/SKILL.md' });
  assert.equal(u.$('[data-skill="skills/oats-aweb"]').getAttribute('aria-expanded'), 'true');
  assert.equal(u.$('[data-skill="skills/aweb-identity"]').getAttribute('aria-expanded'), 'false');
  assert.equal(u.$('[data-path="skills/oats-aweb/SKILL.md"]').getAttribute('aria-selected'), 'true');
  assert.equal(u.$('.cap-reader-path').textContent, 'skills/oats-aweb/SKILL.md');
  assert.equal(u.$('.cap-reader-size').textContent, '300 B');
});

test('the inject is shown from the show answer: no --file call; header path and size', async t => {
  const u = setup(t); u.go(); await flush(); await flush();
  assert.equal(u.calls.length, 1);
  assert.equal(u.$('.cap-reader-path').textContent, 'inject.md');
  assert.equal(u.$('.cap-reader-size').textContent, '2 KiB');
  assert.equal(u.$('.cap-reader-body .mdv h1').textContent, 'Messaging');
});

test('keyboard: arrows, Home/End, Right/Left expand and climb, Enter/Space open or toggle', async t => {
  const u = setup(t); u.go(); await flush(); await flush();
  const inject = u.$('[data-path="inject.md"]'); inject.focus();
  u.key(inject, 'ArrowDown');
  const skill = u.$('[data-skill="skills/oats-aweb"]');
  assert.equal(u.doc.activeElement, skill);
  u.key(skill, 'ArrowRight'); assert.equal(skill.getAttribute('aria-expanded'), 'true');
  u.key(skill, 'ArrowRight'); const first = u.$('[data-path="skills/oats-aweb/SKILL.md"]'); assert.equal(u.doc.activeElement, first);
  u.key(first, 'ArrowLeft'); assert.equal(u.doc.activeElement, skill, 'Left on a child climbs to its skill');
  u.key(skill, 'ArrowLeft'); assert.equal(skill.getAttribute('aria-expanded'), 'false');
  u.key(skill, 'End'); assert.equal(u.doc.activeElement, u.$('[data-skill="skills/aweb-identity"]'), 'End: the last VISIBLE item');
  u.key(u.doc.activeElement, 'Home'); assert.equal(u.doc.activeElement, inject);
  u.key(inject, 'ArrowUp'); assert.equal(u.doc.activeElement, inject, 'Up at the top stays');
  u.key(inject, 'ArrowDown'); u.key(skill, ' '); assert.equal(skill.getAttribute('aria-expanded'), 'true', 'Space toggles a skill');
  u.key(skill, 'ArrowDown'); u.key(u.doc.activeElement, 'Enter'); await flush(); await flush();
  assert.equal(u.$('.cap-reader-path').textContent, 'skills/oats-aweb/SKILL.md', 'Enter opens a file');
  assert.equal(u.$('[data-path="skills/oats-aweb/SKILL.md"]').getAttribute('aria-selected'), 'true');
  assert.equal(inject.getAttribute('aria-selected'), 'false');
  assert.deepEqual(u.$$('[role=treeitem]').filter(i => i.tabIndex === 0), [u.doc.activeElement], 'one tab stop follows focus');
  // Escape is not the tree's: it reaches the page (Back).
  assert.equal(u.key(u.doc.activeElement, 'Escape'), true, 'not cancelled');
});

test('Markdown: front matter as a facts table, links open in place / externally / are inert', async t => {
  const u = setup(t, { answer: body => body.action === 'show' ? showAnswer() : fileAnswer(body.path, body.path.endsWith('SKILL.md') ? { text: SKILL } : {}) });
  u.go(); await flush(); await flush();
  u.$('[data-skill="skills/oats-aweb"] > .cap-node').click();
  u.$('[data-path="skills/oats-aweb/SKILL.md"] > .cap-node').click(); await flush(); await flush();
  const rows = u.$$('.cap-fm tr').map(r => [r.querySelector('th').textContent, r.querySelector('td').textContent]);
  assert.deepEqual(rows, [['name', 'oats-aweb'], ['description', "The OATS instance's aweb playbook. Use it first."]]);
  assert.doesNotMatch(u.readerText(), /^---/, 'no raw YAML');
  const link = text => u.$$('.cap-reader-body a').find(a => a.textContent === text);
  assert.equal(link('missing'), undefined, 'an unlisted file is plain text');
  assert.equal(link('plain'), undefined, 'http: is inert');
  assert.equal(link('mail'), undefined, 'mailto: is inert');
  assert.match(u.readerText(), /missing/);
  link('web').click(); assert.deepEqual(u.opened, ['https://example.com/x']);
  link('down').click(); // scrolls the reader, opens nothing
  assert.equal(u.$('.cap-reader-path').textContent, 'skills/oats-aweb/SKILL.md');
  assert.equal(u.$('.cap-reader-body .hanchor'), null, 'no hover heading anchors in the narrow reader');
  link('inject').click(); await flush();
  assert.equal(u.$('.cap-reader-path').textContent, 'inject.md', 'a relative link to a listed file opens it');
  assert.equal(u.$('[data-path="inject.md"]').getAttribute('aria-selected'), 'true', 'and selects it on the left');
  u.$('[data-path="skills/oats-aweb/SKILL.md"] > .cap-node').click(); await flush(); await flush();
  u.$('[data-skill="skills/oats-aweb"] > .cap-node').click(); // collapse; a link into it expands it again
  link('refs').click(); await flush(); await flush();
  assert.equal(u.$('.cap-reader-path').textContent, 'skills/oats-aweb/refs/a.md');
  assert.equal(u.$('[data-skill="skills/oats-aweb"]').getAttribute('aria-expanded'), 'true');
});

test('untrusted content: no raw HTML, scripts, handlers or remote images', async t => {
  const evil = '# Hi\n\n<img src="https://example.com/x.png">\n\n![alt text](https://example.com/y.png)\n\n<script>alert(1)</script>\n\n<p onerror="x()">p</p>\n';
  const u = setup(t, { answer: body => body.action === 'show' ? showAnswer({ inject: { path: 'inject.md', bytes: 9, text: evil, binary: false, truncated: false } }) : fileAnswer(body.path) });
  u.go(); await flush(); await flush();
  const body = u.$('.cap-reader-body');
  assert.equal(body.querySelector('img, script, iframe, picture, source'), null);
  assert.equal([...body.querySelectorAll('*')].some(el => [...el.attributes].some(a => /^on/i.test(a.name) || a.name === 'src' || a.name === 'srcset')), false);
  assert.match(body.textContent, /alt text/);
});

test('front matter that is not the readable subset shows as code; other text is highlighted code that wraps', async t => {
  const odd = '---\nname: x\nnested:\n  a: 1\n---\nBody\n';
  const u = setup(t, { answer: body => body.action === 'show' ? showAnswer({ inject: { path: 'inject.md', bytes: 9, text: odd, binary: false, truncated: false } }) : fileAnswer(body.path, { text: 'const a = "<b>";\n' }) });
  u.go(); await flush(); await flush();
  assert.equal(u.$('.cap-fm'), null);
  assert.match(u.$('.cap-reader-body pre.md-code').textContent, /nested:/);
  assert.match(u.readerText(), /Body/);
});

test('other text is read-only highlighted code (escaped, never markup)', async t => {
  const skills = [{ name: 'tool', path: 'skills/tool', description: null, files: [{ path: 'skills/tool/run.mjs', bytes: 30 }], filesTruncated: false }];
  const u = setup(t, { answer: body => body.action === 'show' ? showAnswer({ inject: null, skills }) : fileAnswer(body.path, { text: 'const a = "<img src=x onerror=alert(1)>";\n' }) });
  u.go(); await flush(); await flush(); await flush();
  assert.equal(u.$('.cap-reader-path').textContent, 'skills/tool/run.mjs', 'no SKILL.md: the skill\'s first file');
  const pre = u.$('.cap-reader-body pre.md-code code.hljs');
  assert.match(pre.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(u.$('.cap-reader-body img'), null);
});

test('binary, truncated, missing inject, oversize and unlisted-by-design files', async t => {
  const answer = body => {
    if (body.action === 'show') return showAnswer({ inject: { path: 'inject.md', bytes: null, text: null, binary: false, truncated: false }, problems: [{ code: 'E_INJECT_BUDGET', message: 'inject.md is over its budget', path: 'inject.md' }] });
    if (body.path.endsWith('logo.png')) return fileAnswer(body.path, { text: null, binary: true });
    if (body.path.endsWith('refs/a.md')) return err('E_REMOTE_FILE_OVERSIZE', 'too big');
    if (body.path === 'skills/aweb-identity/SKILL.md') return err('E_CAPABILITY_FILE_UNKNOWN', 'unknown');
    return fileAnswer(body.path, { text: 'x'.repeat(10), truncated: true, bytes: 900000 });
  };
  const u = setup(t, { answer }); u.go(); await flush(); await flush();
  assert.equal(u.readerText(), 'inject.md is over its budget', 'the inject\'s problem, in the reader');
  u.$('[data-skill="skills/oats-aweb"] > .cap-node').click();
  u.$('[data-path="skills/oats-aweb/logo.png"] > .cap-node').click(); await flush(); await flush();
  assert.equal(u.readerText(), 'Binary file; not shown.');
  u.$('[data-path="skills/oats-aweb/refs/a.md"] > .cap-node').click(); await flush(); await flush();
  assert.equal(u.readerText(), 'Too large to show (10 B).');
  assert.equal(u.$('.cap-reader-body .loading-failed'), null);
  u.$('[data-path="skills/oats-aweb/SKILL.md"] > .cap-node').click(); await flush(); await flush();
  assert.equal(u.$('.cap-reader-flag').textContent, 'Truncated at 256 KiB');
  assert.equal(u.$('.cap-reader-size').textContent, '878.9 KiB');
  u.$('[data-skill="skills/aweb-identity"] > .cap-node').click();
  u.$('[data-path="skills/aweb-identity/SKILL.md"] > .cap-node').click(); await flush(); await flush();
  assert.equal(u.readerText(), 'Not available.', 'a muted line, not the failed state');
});

test('kernel refinements: an unlistable skill and an inject whose manifest value is not a safe path', async t => {
  const u = setup(t, { answer: body => body.action === 'show' ? showAnswer({
    inject: { path: null, bytes: null, text: null, binary: false, truncated: false },
    skills: [{ name: 'broken', path: 'skills/broken', description: 'Broken.', files: null, filesTruncated: false }, ...showAnswer().skills],
    problems: [{ code: 'E_INJECT_UNSAFE', message: 'inject "../../etc/passwd" is not a safe relative path', path: null }, { code: 'E_SKILL_UNREADABLE', message: 'cannot list', path: 'skills/broken' }] }) : fileAnswer(body.path) });
  u.go(); await flush(); await flush();
  assert.equal(u.calls.length, 1, 'no --file call for an inject without a path');
  assert.equal(u.$('.cap-reader-path').textContent, 'Injected instructions');
  assert.equal(u.readerText(), 'inject "../../etc/passwd" is not a safe relative path');
  const inject = u.$('[data-path="/inject"]');
  assert.equal(inject.getAttribute('aria-selected'), 'true'); assert.equal(inject.querySelector('.cap-node-file'), null);
  const broken = u.$('[data-focus-key="skill:skills/broken"]');
  assert.equal(broken.getAttribute('aria-disabled'), 'true'); assert.equal(broken.hasAttribute('aria-expanded'), false);
  assert.equal(broken.querySelector('.cap-node-desc').textContent, "Its files can't be listed.");
  inject.focus(); u.key(inject, 'ArrowDown'); assert.equal(u.doc.activeElement, broken, 'reachable');
  u.key(broken, 'Enter'); u.key(broken, 'ArrowRight'); await flush();
  assert.equal(u.calls.length, 1, 'opens nothing');
  u.key(broken, 'ArrowDown'); assert.equal(u.doc.activeElement.dataset.skill, 'skills/oats-aweb');
});

test('a file read the user has left is discarded (A → B → A)', async t => {
  const pending = new Map();
  const u = setup(t, { answer: body => { if (body.action === 'show') return showAnswer(); const d = deferred(); pending.set(`${body.path}#${[...pending.keys()].length}`, d); return d; } });
  u.go(); await flush(); await flush();
  u.$('[data-skill="skills/oats-aweb"] > .cap-node').click();
  const A = '[data-path="skills/oats-aweb/SKILL.md"] > .cap-node', B = '[data-path="skills/oats-aweb/refs/a.md"] > .cap-node';
  u.$(A).click(); u.$(B).click(); u.$(A).click();
  const [a1, b, a2] = [...pending.values()];
  a2.resolve(fileAnswer('skills/oats-aweb/SKILL.md', { text: '# second A\n' })); await flush(); await flush();
  assert.match(u.readerText(), /second A/);
  a1.resolve(fileAnswer('skills/oats-aweb/SKILL.md', { text: '# first A\n' }));
  b.resolve(fileAnswer('skills/oats-aweb/refs/a.md', { text: '# B\n' })); await flush(); await flush();
  assert.match(u.readerText(), /second A/, 'late answers for left selections never paint');
  assert.equal(u.$('.cap-reader-path').textContent, 'skills/oats-aweb/SKILL.md');
  // A late FAILURE for a left selection is discarded too.
  u.$(B).click(); u.$(A).click();
  const [, , , b2, a3] = [...pending.values()];
  a3.resolve(fileAnswer('skills/oats-aweb/SKILL.md', { text: '# third A\n' })); await flush(); await flush();
  b2.reject(err('E_CLI_FAILED', 'late failure')); await flush(); await flush();
  assert.match(u.readerText(), /third A/); assert.equal(u.$('.loading-failed'), null);
});

test('failures: the failed block with the CLI message and Retry; unknown capability re-reads the catalog', async t => {
  let fail = true;
  const u = setup(t, { answer: body => body.action === 'show' ? (fail ? err('E_CAPABILITY_UNKNOWN', 'capability oats.aweb is not in the catalog at a1b2c3d') : showAnswer()) : fileAnswer(body.path) });
  u.go(); await flush(); await flush();
  assert.equal(u.$('.cap-contents-nav .loading-failed-message').textContent, 'capability oats.aweb is not in the catalog at a1b2c3d');
  assert.equal(u.unknown.length, 1);
  fail = false;
  const retry = u.$('.cap-contents-nav .loading-retry'); retry.focus(); retry.click(); await flush(); await flush();
  assert.equal(u.$('.cap-contents-nav .loading-failed'), null);
  assert.ok(u.$('[role=tree]'));
  assert.notEqual(u.doc.activeElement, u.doc.body, 'focus never falls to <body> when the Retry leaves');
  // A file read failure: the reader's failed block, Retry reads again.
  let fileFail = true;
  const v = setup(t, { answer: body => body.action === 'show' ? showAnswer({ inject: null }) : fileFail ? err('E_CLI_TIMEOUT', 'timed out') : fileAnswer(body.path) });
  v.go(); await flush(); await flush(); await flush();
  assert.equal(v.$('.cap-reader-body .loading-failed-message').textContent, 'timed out');
  fileFail = false; v.$('.cap-reader-body .loading-retry').click(); await flush(); await flush();
  assert.equal(v.$('.cap-reader-body .loading-failed'), null);
  assert.match(v.readerText(), /SKILL\.md/);
});

test('repaints: the same subject reads nothing; a moved commit re-reads and keeps the open path when listed', async t => {
  let current = showAnswer();
  const u = setup(t, { answer: body => body.action === 'show' ? current : fileAnswer(body.path, {}, current.commit) });
  u.go(); await flush(); await flush();
  u.$('[data-skill="skills/oats-aweb"] > .cap-node').click();
  u.$('[data-path="skills/oats-aweb/refs/a.md"] > .cap-node').click(); await flush(); await flush();
  const focused = u.$('[data-path="skills/oats-aweb/refs/a.md"]'); focused.focus();
  const before = u.calls.length;
  u.go(); u.go(); await flush();
  assert.equal(u.calls.length, before, 'a background repaint with the same subject makes no call');
  assert.equal(u.doc.activeElement, focused);
  current = showAnswer({ commit: commit2 });
  u.go({ row: { ...packageRow, commit: commit2 } }); await flush(); await flush(); await flush();
  assert.equal(u.$('.page-section-lead').textContent, 'What an instance gets, at beef111');
  assert.equal(u.$('.cap-reader-path').textContent, 'skills/oats-aweb/refs/a.md', 'still listed: kept');
  assert.equal(u.doc.activeElement?.dataset.path, 'skills/oats-aweb/refs/a.md', 'focus found again by key');
  current = showAnswer({ commit, skills: [{ name: 'oats-aweb', path: 'skills/oats-aweb', description: null, files: [{ path: 'skills/oats-aweb/SKILL.md', bytes: 3 }], filesTruncated: false }] });
  u.go({ row: { ...packageRow, commit } }); await flush(); await flush(); await flush();
  assert.equal(u.$('.cap-reader-path').textContent, 'inject.md', 'gone: back to the default');
});

test('a stale show answer is discarded when the subject moved on', async t => {
  const shows = [];
  const u = setup(t, { answer: body => { if (body.action !== 'show') return fileAnswer(body.path); const d = deferred(); shows.push([body, d]); return d; } });
  u.go(); u.go({ row: memberRow });
  shows[0][1].resolve(showAnswer()); await flush(); await flush();
  assert.equal(u.$('[role=tree]'), null, 'the first capability\'s answer never paints');
  shows[1][1].resolve(showAnswer({ name: 'oats.desktop-ui', kind: 'member', repoKey: 'github.com/awebai/oats', package: null, inject: null, skills: [] })); await flush(); await flush();
  assert.deepEqual(shows[1][0].capability, { name: 'oats.desktop-ui', kind: 'member', repoKey: 'github.com/awebai/oats' });
  assert.equal(u.$('.cap-contents-note').textContent, 'Injects no instructions.');
});

test('an answer at another commit than the catalog row is never rendered: the catalog is re-read', async t => {
  let at = commit2;
  const u = setup(t, { answer: body => body.action === 'show' ? showAnswer({ commit: at }) : fileAnswer(body.path, {}, commit2) });
  u.go(); await flush(); await flush();
  assert.equal(u.$('[role=tree]'), null, 'no mix of two commits');
  assert.equal(u.$('.loading-failed-message').textContent, CONTENTS_COPY.moved);
  assert.equal(u.unknown.length, 1, 'the catalog row is refreshed');
  // The refreshed row lands at the new commit: read again, rendered.
  u.go({ row: { ...packageRow, commit: commit2 } }); await flush(); await flush();
  assert.ok(u.$('[role=tree]')); assert.equal(u.$('.loading-failed'), null);
  // A file answer at another commit than the show answer: the reader fails the same way.
  at = commit; u.go({ row: { ...packageRow, commit } }); await flush(); await flush();
  u.$('[data-skill="skills/oats-aweb"] > .cap-node').click();
  u.$('[data-path="skills/oats-aweb/refs/a.md"] > .cap-node').click(); await flush(); await flush();
  assert.equal(u.$('.cap-reader-body .loading-failed-message').textContent, CONTENTS_COPY.moved);
  assert.equal(u.unknown.length, 2);
});

test('an answer this Desktop cannot read is a failure, never a partial render', async t => {
  const u = setup(t, { answer: () => ({ ...showAnswer(), capabilityShowApi: 2 }) });
  u.go(); await flush(); await flush();
  assert.match(u.$('.loading-failed-message').textContent, /can't read/);
  assert.equal(u.$('[role=tree]'), null);
});

test('the page places Skills under what it does and Contents in its Files fold, last; hold() keeps focus across a rebuild', async t => {
  const u = setup(t); u.go(); await flush(); await flush();
  const page = u.doc.createElement('div'); u.doc.body.append(page);
  const row = { ...packageRow, skills: ['oats-aweb'], commands: [], hooks: [] };
  const render = from => renderCapabilityPage(page, { row, status: null, instances: [], root: '/ws', onBack() {}, contents: u.contents.element, skills: u.contents.skills, skillView: u.contents.skillView, ...(from ? { from } : {}) });
  render();
  const order = () => [...page.querySelector('.page-main').children, ...page.querySelector('.cap-folds').children].map(el => el.dataset.fold ?? el.dataset.section ?? el.className);
  assert.deepEqual(order(), ['cap-page-head', 'Skills', 'cap-folds', 'commands', 'hooks', 'used-by', 'source', 'files']);
  assert.equal(page.querySelector('details[data-fold=files]').lastElementChild, u.contents.element);
  page.querySelector('details[data-fold=files]').open = true;
  const item = page.querySelector('[data-path="inject.md"]'); item.focus();
  const keep = u.contents.hold();
  render({ label: 'soul-x' });
  keep();
  assert.equal(u.doc.activeElement, item);
  assert.deepEqual(order(), ['cap-page-head', 'Skills', 'cap-folds', 'commands', 'hooks', 'used-by', 'source', 'files'], 'the soul form too');
  assert.equal(page.querySelector('details[data-fold=files]').open, true, 'a fold opened on this capability stays open across the rebuild');
});

test('slice3b capability page skills open whole and folds', async t => {
  const u = setup(t, { answer: body => body.action === 'show' ? showAnswer() : fileAnswer(body.path, body.path.endsWith('SKILL.md') ? { text: SKILL } : {}) });
  u.go(); await flush(); await flush();
  const page = u.doc.createElement('div'); page.className = 'oats-view'; u.doc.body.append(page);
  const row = { ...packageRow, layer: 'messaging', description: 'Messaging layer via aweb: per-instance team identities.', commands: ['aweb-connect'], hooks: ['spawn'] };
  const status = { packages: [{ id: 'oats.aweb', source: 'catalog:oats.aweb' }], defaults: { slots: { messaging: { name: 'oats.aweb', from: 'package' } }, capabilities: [] } };
  const render = () => renderCapabilityPage(page, { row, status, instances: [], root: '/ws', onBack() {}, contents: u.contents.element, triggerSources: u.contents.triggerSources, skills: u.contents.skills, skillView: u.contents.skillView });
  render();
  const $ = s => page.querySelector(s), $$ = s => [...page.querySelectorAll(s)];
  // What it does, as one paragraph; its tags; the origin line ("Comes from" in one line).
  assert.equal($('.cap-page-what').textContent, row.description);
  assert.deepEqual($$('.page-title .page-tag').map(t => t.textContent), ['Core · Messaging', 'default']);
  assert.equal($('.cap-page-origin').textContent, 'Verified: published by OATS · package oats.aweb');
  // Skills: each skill's name and one line (the first sentence of its description); a button that opens it.
  const skillRows = $$('.cap-skills-section button.cap-skill-row');
  assert.deepEqual(skillRows.map(b => [b.querySelector('.cap-skill-name').textContent, b.querySelector('.cap-skill-desc')?.textContent ?? null]),
    [['oats-aweb', "The OATS instance's aweb playbook."], ['aweb-identity', null]]);
  assert.equal(skillRows[0].getAttribute('aria-label'), 'oats-aweb: open the whole skill');
  // Then Commands, Triggers (none declared here), Hooks, Used by, Source and Files, each folded: a native disclosure.
  const folds = $$('.page-main > .cap-folds > details.cap-fold');
  assert.deepEqual(folds.map(d => [d.dataset.fold, d.open, d.querySelector('summary .cap-fold-title').textContent]),
    [['commands', false, 'Commands'], ['hooks', false, 'Hooks'], ['used-by', false, 'Used by'], ['source', false, 'Comes from'], ['files', false, 'Files']]);
  assert.deepEqual($$('details[data-fold=commands] .provides-chip').map(c => c.textContent), ['aweb-connect']);
  assert.ok($('details[data-fold=source] .page-kv'), 'the "Comes from" facts stay reachable');
  // Enter on a skill opens the whole skill in the pane: its front matter as facts, then its body; the body hides.
  skillRows[0].focus(); skillRows[0].click(); await flush(); await flush();
  const view = u.contents.skillView;
  assert.equal(view.hidden, false); assert.equal($('.page-body').hidden, true);
  assert.equal(view.querySelector('.skill-view-title').textContent, 'oats-aweb');
  assert.deepEqual(u.calls.at(-1), { action: 'file', capability: { name: 'oats.aweb', kind: 'package', package: 'oats.aweb' }, path: 'skills/oats-aweb/SKILL.md' });
  const fm = view.querySelector('table.cap-fm');
  assert.deepEqual([...fm.querySelectorAll('th')].map(th => th.textContent), ['name', 'description']);
  assert.equal(fm.compareDocumentPosition(view.querySelector('.mdv h1')) & u.dom.window.Node.DOCUMENT_POSITION_FOLLOWING, u.dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'front matter, then the body');
  assert.equal(view.querySelector('.mdv h1').textContent, 'Playbook');
  assert.equal(view.querySelectorAll('input, textarea, [contenteditable]').length, 0, 'read-only');
  assert.equal(u.doc.activeElement, view.querySelector('.skill-view-reader'));
  // Its other files are a press away; a link to a listed file opens it in place.
  assert.deepEqual([...view.querySelectorAll('.skill-view-files button')].map(b => b.textContent), ['SKILL.md', 'logo.png', 'refs/a.md']);
  view.querySelector('.skill-view-files button[data-path="skills/oats-aweb/refs/a.md"]').click(); await flush(); await flush();
  assert.equal(view.querySelector('.cap-reader-path').textContent, 'skills/oats-aweb/refs/a.md');
  // A catalog repaint while it is open keeps the skill open and the body hidden.
  render();
  assert.equal(page.querySelector('.skill-view'), view); assert.equal(view.hidden, false); assert.equal($('.page-body').hidden, true);
  // Esc returns to the capability, focus on the skill's row.
  view.querySelector('.skill-view-reader').dispatchEvent(new u.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(view.hidden, true); assert.equal($('.page-body').hidden, false);
  assert.equal(u.doc.activeElement, $('.cap-skills-section button.cap-skill-row[data-skill="skills/oats-aweb"]'));
  // Enter on a fold's summary unfolds it (the native disclosure); a fold the user opened stays open across a repaint.
  const used = $('details[data-fold=used-by]');
  used.querySelector('summary').click();
  assert.equal(used.open, true);
  render();
  assert.equal($('details[data-fold=used-by]').open, true);
});

test('a skill read that lands after the skill was left is dropped (latest intent), on success and on failure', async t => {
  const pending = [];
  const u = setup(t, { answer: body => body.action === 'show' ? showAnswer() : (() => { const d = deferred(); pending.push([body.path, d]); return d; })() });
  u.go(); await flush(); await flush();
  const page = u.doc.createElement('div'); u.doc.body.append(page);
  renderCapabilityPage(page, { row: packageRow, status: null, instances: [], root: '/ws', onBack() {}, contents: u.contents.element, skills: u.contents.skills, skillView: u.contents.skillView });
  const skillPending = () => pending.filter(([path]) => path.startsWith('skills/oats-aweb/SKILL.md'));
  page.querySelector('button.cap-skill-row[data-skill="skills/oats-aweb"]').click(); await flush();
  const [, first] = skillPending().at(-1);
  // Esc before it lands: the late answer paints nothing.
  u.contents.skillView.dispatchEvent(new u.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  first.resolve(fileAnswer('skills/oats-aweb/SKILL.md', { text: '# Late' })); await flush(); await flush();
  assert.equal(u.contents.skillView.hidden, true);
  assert.doesNotMatch(u.contents.skillView.textContent, /Late/);
  // A→B: a failure of A's read that arrives after B opened says nothing; B's answer is painted.
  page.querySelector('button.cap-skill-row[data-skill="skills/oats-aweb"]').click(); await flush();
  const [, a] = skillPending().at(-1);
  u.contents.closeSkill({ focus: false });
  page.querySelector('button.cap-skill-row[data-skill="skills/aweb-identity"]').click(); await flush();
  const [, b] = pending.filter(([path]) => path === 'skills/aweb-identity/SKILL.md').at(-1);
  a.reject(err('E_CLI_FAILED', 'old failure')); await flush(); await flush();
  assert.doesNotMatch(u.contents.skillView.textContent, /old failure/);
  b.resolve(fileAnswer('skills/aweb-identity/SKILL.md', { text: '# Identity' })); await flush(); await flush();
  assert.equal(u.contents.openSkill, 'skills/aweb-identity');
  assert.equal(u.contents.skillView.querySelector('.mdv h1').textContent, 'Identity');
});

test('code blocks keep a working copy button: the code to the clipboard, "copied", back to "copy"', async t => {
  const text = '# T\n\n```js\nconst a = 1;\n```\n';
  const u = setup(t, { answer: body => body.action === 'show' ? showAnswer({ inject: { path: 'inject.md', bytes: 9, text, binary: false, truncated: false } }) : fileAnswer(body.path) });
  const copied = [];
  Object.defineProperty(u.dom.window.navigator, 'clipboard', { configurable: true, value: { writeText: v => { copied.push(v); return Promise.resolve(); } } });
  u.go(); await flush(); await flush();
  const button = u.$('.cap-reader-body pre.md-code .md-copy');
  button.click(); await flush();
  assert.deepEqual(copied, ['const a = 1;']);
  assert.equal(button.textContent, 'copied');
  await new Promise(r => setTimeout(r, 1300));
  assert.equal(button.textContent, 'copy');
  Object.defineProperty(u.dom.window.navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } });
  button.click(); await flush(); await flush();
  assert.equal(button.textContent, 'copy failed');
});

test('the hidden attribute always wins over the section\'s own display rules (Chromium honours author display over [hidden])', () => {
  assert.match(capabilityContentsCSS, /\.cap-contents-section \[hidden\] \{ display:none !important; \}/);
  // Every element the controller hides lives inside the section.
  for (const cls of ['cap-contents', 'cap-reader-head']) assert.match(capabilityContentsCSS, new RegExp(`\\.${cls} \\{[^}]*display:`), cls);
});
