// Spec D (B2): the soul page's composed AGENTS.md — `inspect --soul --instructions` (kernel feature
// soul-composed-instructions, awebai/oats#751) through the server's one optional `instructions` key, and the
// Instructions section's "Composed for an instance" section (its AGENTS.md "after spawn, with injects"): parts in order, their headers, scroll to a part, Open capability, Copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { cliCapability } from '../../client/cli-adapter.mjs';
import { capabilityRequest } from '../server/capabilities.mjs';
import { createInspectCache, inspectKey } from '../../client/inspect-cache.mjs';
import { createSoulInstructions, composedOf, blockText, sourceLabels, composedSupported, SOUL_INSTRUCTIONS_COPY, COMPOSED, OWN } from '../renderer/soul-instructions.mjs';
import { createSoulInspector } from '../renderer/soul-inspector.mjs';
import { setWorkspace, currentWorkspace } from '../renderer/views/common.mjs';
import { refreshCli, resetCliStateForTests } from '../renderer/views/cli-status.mjs';

const FEATURE = 'soul-composed-instructions';
const context = '/fixture/base/northwind-workspace';
const flush = () => new Promise(r => setTimeout(r, 0));

/** A composed answer built the way the kernel builds it (lib/soul-composition.mjs): the soul's body, then each block
 * between its markers, every range ending after the blank line that separates it from the next. */
function composedAnswer({ body = '# release-manager\n\nShip releases.\n', blocks = [
  ['kernel:instance-boundary', null, '## Your two directories\n\nHome and work.'],
  ['work-mode:worktree', null, '## Work mode: worktree\n\nYour own branch.'],
  ['capability:oats.core', '.oats/modules/oats.core/inject.md', '## You run on OATS\n\nLoad [the skill](https://example.com/s) and [here](#you-run-on-oats).'],
] } = {}) {
  let text = `${body}\n`;
  const sources = [], bodySpan = { start: 0, end: text.length, truncated: false };
  for (const [source, file, inner] of blocks) {
    const start = text.length;
    text += `<!-- oats:${source} src=/Users/someone/.cache/x -->\n${inner}\n<!-- /oats:${source} -->\n\n`;
    sources.push({ source, file, start, end: text.length, truncated: false });
  }
  return { file: null, text, truncated: false, resolution: 'e7b62ef1', body: bodySpan, sources };
}

/* ── the adapter and the server boundary ─────────────────────────────── */
const envelope = result => JSON.stringify({ schemaVersion: 1, ok: true, result });
function capture(document) { const calls = []; return { calls, exec(_b, argv, _o, done) { calls.push(argv); done(null, envelope(document)); } }; }

test('adapter: --instructions goes after the soul target and only to a CLI advertising the feature', async () => {
  const soulArgs = { action: 'inspect', context, soul: 'dev', agentsRoot: `${context}/agents`, localCwd: context };
  const io = capture({});
  await cliCapability('/b/oats', { ...soulArgs, instructions: true, features: [FEATURE] }, io);
  assert.deepEqual(io.calls, [['inspect', '--dir', context, '--soul', 'dev', '--agents-root', `${context}/agents`, '--instructions', '--json']]);
  for (const features of [[], undefined, ['observe-max-age']]) {
    const plain = capture({}), given = capture({});
    await cliCapability('/b/oats', { ...soulArgs, features }, plain);
    await cliCapability('/b/oats', { ...soulArgs, instructions: true, features }, given);
    assert.deepEqual(given.calls, plain.calls, 'an undeclared CLI gets the flagless argv');
  }
  // Routed with --server it goes too (the server asks only for a host that composes: remote-composed-gating.test.mjs).
  for (const bad of [{ action: 'inspect', home: '/h', localCwd: '/h' }, { action: 'run', home: '/h', localCwd: '/h', operation: 'knowledge:harvest' }])
    await assert.rejects(cliCapability('/b/oats', { ...bad, instructions: true, features: [FEATURE] }, { exec: assert.fail }), { code: 'E_BAD_ARGS' }, JSON.stringify(bad));
});

test('server: one optional boolean, a soul inspect only; the cache key includes it; not routed without the hosts\u2019 features', async () => {
  const cli = { ok: true, operationsApi: 2, bin: '/b/oats', features: [FEATURE], remote: ['operations'] };
  const agents = [{ name: 'dev', agentsRoot: `${context}/agents` }], instances = [{ instance: 'dev-1', home: '/h' }];
  const calls = [], invoke = async (_bin, options) => { calls.push(options); return JSON.parse(envelope({ subject: { kind: 'soul' } })); };
  const local = { id: context, scope: context };
  const soul = { action: 'inspect', selector: { soul: 'dev', agentsRoot: `${context}/agents` } };
  const cache = createInspectCache();
  await capabilityRequest({ ...soul, instructions: true }, { workspace: local, cli, agents, instances, localCwd: context, invoke, cache });
  await capabilityRequest(soul, { workspace: local, cli, agents, instances, localCwd: context, invoke, cache });
  assert.deepEqual(calls.map(c => c.instructions === true), [true, false], 'two reads: the flag is part of the cache key');
  await capabilityRequest({ ...soul, instructions: true }, { workspace: local, cli, agents, instances, localCwd: context, invoke, cache });
  assert.equal(calls.length, 2, 'the flagged read is cached under its own key');
  assert.notEqual(inspectKey({ deployment: '/w', kind: 'soul', soul: 'dev', agentsRoot: '/a' }), inspectKey({ deployment: '/w', kind: 'soul', soul: 'dev', agentsRoot: '/a', instructions: true }));
  for (const bad of [{ ...soul, instructions: 'yes' }, { ...soul, instructions: 1 }, { action: 'inspect', selector: { home: '/h' }, instructions: true }, { action: 'run', selector: { home: '/h' }, operation: 'knowledge:x', instructions: false }])
    await assert.rejects(capabilityRequest(bad, { workspace: local, cli, agents, instances, localCwd: context, invoke }), { code: 'E_BAD_ARGS', message: 'Invalid instructions flag' }, JSON.stringify(bad));
  calls.length = 0;
  const remote = { id: 'remote:builder', scope: '/remote/member', remote: true, server: 'builder', registrationPresent: true };
  await capabilityRequest({ action: 'inspect', selector: { soul: 'dev', agentsRoot: '/remote/member/agents' }, instructions: true },
    { workspace: remote, cli, agents: [{ name: 'dev', agentsRoot: '/remote/member/agents' }], instances: [], localCwd: '/l', invoke });
  assert.equal(Object.hasOwn(calls[0], 'instructions'), false, 'a CLI without server-probe-features: the host’s features are not held, never routed');
});

/* ── the contract's decoder ──────────────────────────────────────────── */
test('decoder: parts in order, markers dropped, labels; absent, null and a broken answer stay apart', () => {
  const c = composedAnswer();
  const shown = composedOf({ name: 'release-manager', path: 'souls/release-manager', composedInstructions: c });
  assert.deepEqual(shown.parts.map(p => [p.nav, p.header]), [['This soul', 'From this soul'], ['Instance boundary · OATS', 'Injected by OATS · instance boundary'],
    ['Work mode · worktree', 'Injected by OATS · work mode worktree'], ['oats.core', 'Injected by oats.core']]);
  assert.equal(shown.parts[0].file, 'souls/release-manager/AGENTS.md'); assert.equal(shown.parts[3].file, '.oats/modules/oats.core/inject.md');
  assert.equal(shown.parts[2].text, '## Work mode: worktree\n\nYour own branch.');
  assert.ok(shown.parts.every(p => !p.text.includes('<!--')), 'no marker line is shown');
  assert.equal(shown.text, c.text, 'the exact text is kept for Copy');
  assert.equal(composedOf({ name: 'x' }), undefined); assert.equal(composedOf({ name: 'x', composedInstructions: null }), null);
  const broken = [{ ...c, body: { ...c.body, start: 1 } }, { ...c, sources: c.sources.slice(1) }, { ...c, text: `${c.text}x` },
    { ...c, sources: [...c.sources.slice(0, 2), { ...c.sources[2], file: 5 }] }, { ...c, truncated: 'no' }, 'text'];
  for (const b of broken) assert.equal(composedOf({ composedInstructions: b }), false, JSON.stringify(b).slice(0, 80));
  assert.equal(blockText('<!-- oats:x -->\nbody\n<!-- /oats:x -->\n\n'), 'body');
  assert.equal(blockText('<!-- oats:x -->\nbody cut by the c'), 'body cut by the c', 'a block cut by the cap has no closing marker');
  assert.deepEqual(sourceLabels('kernel:other'), { nav: 'other · OATS', header: 'OATS · other' });
  assert.equal(composedOf({ composedInstructions: { ...composedAnswer({ blocks: [['capability:x', '/abs/host/path', 'y']] }) } }).parts[1].file, null, 'a file that is not display-safe is not shown');
  assert.equal(composedSupported({ ok: true, features: [FEATURE] }), true); assert.equal(composedSupported({ ok: true, features: [] }), false); assert.equal(composedSupported(null), false);
});

test('decoder: a part wholly past the cap is listed and says so; a cut part is flagged', () => {
  const c = composedAnswer();
  const cap = c.sources[1].start + 30, text = c.text.slice(0, cap);
  const clamp = s => ({ ...s, start: Math.min(s.start, cap), end: Math.min(s.end, cap), truncated: s.end > cap });
  const shown = composedOf({ composedInstructions: { ...c, text, truncated: true, sources: c.sources.map(clamp) } });
  assert.deepEqual(shown.parts.map(p => [p.truncated, p.past]), [[false, false], [false, false], [true, false], [true, true]]);
});

/* ── the section ─────────────────────────────────────────────────────── */
const row = (over = {}) => ({ name: 'release-manager', path: 'souls/release-manager', instructions: { file: '/cache/AGENTS.md', text: '# Own file\n', truncated: false },
  composedInstructions: composedAnswer(), ...over });
function setup(t, options = {}) {
  const dom = new JSDOM('<!doctype html><body><main></main></body>', { pretendToBeVisual: true });
  const doc = dom.window.document, host = doc.querySelector('main'), opened = [];
  const section = createSoulInstructions(doc, { openExternal: url => opened.push(['external', url]), canOpenCapability: id => id === 'oats.core', openCapability: id => opened.push(['capability', id]), ...options });
  host.append(section.element);
  t.after(() => { section.dispose(); dom.window.close(); });
  const $ = s => host.querySelector(s), $$ = s => [...host.querySelectorAll(s)];
  const key = (el, k) => el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const item = path => $(`[role=treeitem][data-path="${path}"]`);
  return { dom, doc, host, section, opened, $, $$, key, item };
}
function scrollable(el) { let top = 0; Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: v => { top = Math.max(0, Number(v) || 0); } }); return el; }

test('navigation: "Defined in this soul" then "Composed for an instance", its AGENTS.md "after spawn, with injects" collapsed; the own file stays the default', t => {
  const u = setup(t); u.section.update(row());
  const sections = u.$$('[role=tree] > li[role=none] > ul[role=group]');
  assert.deepEqual(sections.map(g => u.doc.getElementById(g.getAttribute('aria-labelledby')).textContent), ['Defined in this soul', 'Composed for an instance']);
  const composed = u.item(COMPOSED);
  assert.equal(composed.parentElement, sections[1], 'the second section\'s first item');
  assert.equal(composed.getAttribute('aria-label'), 'AGENTS.md, after spawn, with injects', 'the section\'s top item, parallel to the soul\'s');
  assert.deepEqual([...composed.querySelectorAll(':scope > .cap-node .cap-node-name, :scope > .cap-node .cap-node-desc')].map(n => n.textContent), ['AGENTS.md', 'after spawn, with injects']);
  assert.equal(composed.getAttribute('aria-expanded'), 'false'); assert.equal(composed.getAttribute('aria-description'), '4 parts');
  assert.deepEqual([...composed.querySelectorAll('[role=treeitem]')].map(i => i.getAttribute('aria-label')), ['This soul', 'Instance boundary · OATS', 'Work mode · worktree', 'oats.core']);
  assert.equal(u.section.selected, OWN); assert.equal(u.$('.cap-reader-path').textContent, 'souls/release-manager/AGENTS.md');
  assert.equal(u.$('.soul-part'), null);
});

test('the composed document: one continuous reader, every part a labelled section, "From this soul" / "Injected by …"', t => {
  const u = setup(t); u.section.update(row());
  u.item(COMPOSED).querySelector('.cap-node-name').click();
  assert.equal(u.section.selected, COMPOSED); assert.equal(u.item(COMPOSED).getAttribute('aria-expanded'), 'true', 'opening it shows its parts');
  assert.equal(u.$('.cap-reader-path').textContent, 'Composed AGENTS.md');
  const parts = u.$$('.cap-reader-body > section.soul-part');
  assert.deepEqual(parts.map(p => u.doc.getElementById(p.getAttribute('aria-labelledby')).textContent),
    ['From this soul', 'Injected by OATS · instance boundary', 'Injected by OATS · work mode worktree', 'Injected by oats.core']);
  assert.deepEqual(parts.map(p => p.dataset.source), ['soul', 'kernel:instance-boundary', 'work-mode:worktree', 'capability:oats.core']);
  assert.equal(parts[0].querySelector('.soul-part-file').textContent, 'souls/release-manager/AGENTS.md');
  assert.equal(parts[3].querySelector('.soul-part-file').textContent, '.oats/modules/oats.core/inject.md');
  assert.equal(parts[0].querySelector('.soul-part-size'), null); assert.ok(parts[3].querySelector('.soul-part-size').textContent.endsWith(' B'));
  assert.equal(parts[1].querySelector('.soul-part-file'), null, "the kernel's own blocks report no file");
  assert.doesNotMatch(u.$('.cap-reader-body').textContent, /<!--|oats:|src=/, 'no marker is shown');
  assert.equal(parts[3].querySelector('.mdv h2').textContent, 'You run on OATS', 'each part renders through the strict reader');
});

test('Open capability opens that capability; only a capability part the page can open carries it', t => {
  const u = setup(t); u.section.update(row({ composedInstructions: composedAnswer({ blocks: [['capability:oats.core', null, 'a'], ['capability:acme.gone', null, 'b']] }) }));
  u.item(COMPOSED).querySelector('.cap-node-name').click();
  const buttons = u.$$('.soul-part-open');
  assert.equal(buttons.length, 1); assert.equal(buttons[0].textContent, 'Open capability'); assert.equal(buttons[0].closest('.soul-part').dataset.source, 'capability:oats.core');
  buttons[0].click(); assert.deepEqual(u.opened, [['capability', 'oats.core']]);
});

test('a part: selecting it scrolls the reader to its header below the sticky head; "This soul" is the soul part, not the own file', t => {
  const u = setup(t); u.section.update(row());
  const reader = scrollable(u.$('.cap-contents-reader'));
  u.item(COMPOSED).querySelector('.cap-node-name').click();
  const parts = u.$$('.soul-part');
  parts.forEach((p, i) => Object.defineProperty(p, 'offsetTop', { configurable: true, get: () => 100 + i * 400 }));
  Object.defineProperty(u.$('.cap-reader-head'), 'offsetHeight', { configurable: true, get: () => 32 });
  u.item('part:2').querySelector('.cap-node').click();
  assert.equal(reader.scrollTop, 100 + 2 * 400 - 32 - 8); assert.equal(u.section.selected, 'part:2');
  assert.equal(u.$$('.soul-part')[0], parts[0], 'the same document: a part is a place in it');
  u.item('part:0').querySelector('.cap-node').click();
  assert.equal(reader.scrollTop, 100 - 32 - 8); assert.equal(u.$('.cap-reader-path').textContent, 'Composed AGENTS.md');
  u.item(COMPOSED).querySelector('.cap-node-name').click(); assert.equal(reader.scrollTop, 0, 'the composed item opens the top');
  u.item(OWN).querySelector('.cap-node').click(); assert.equal(u.$('.cap-reader-path').textContent, 'souls/release-manager/AGENTS.md');
  assert.equal(u.$('.soul-part'), null);
});

test('keyboard: one tree across both sections; Right/Left expand and climb; Enter opens', t => {
  const u = setup(t); u.section.update(row());
  const own = u.item(OWN), composed = u.item(COMPOSED);
  own.focus(); u.key(own, 'ArrowDown'); assert.equal(u.doc.activeElement, composed, 'the arrows cross the section boundary');
  u.key(composed, 'ArrowRight'); assert.equal(composed.getAttribute('aria-expanded'), 'true');
  u.key(composed, 'ArrowRight'); assert.equal(u.doc.activeElement, u.item('part:0'), 'into its first part');
  u.key(u.item('part:0'), 'End'); assert.equal(u.doc.activeElement, u.item('part:3'));
  u.key(u.item('part:3'), 'Enter'); assert.equal(u.section.selected, 'part:3'); assert.ok(u.$('.soul-part'), 'the composed document is open');
  u.key(u.item('part:3'), 'ArrowLeft'); assert.equal(u.doc.activeElement, composed, 'Left climbs to the composed item');
  u.key(composed, 'ArrowLeft'); assert.equal(composed.getAttribute('aria-expanded'), 'false');
  assert.equal(u.$$('[role=treeitem][tabindex="0"]').length, 1, 'one tab stop');
  u.key(composed, 'Enter'); assert.equal(u.section.selected, COMPOSED); assert.equal(composed.getAttribute('aria-expanded'), 'true');
  composed.querySelector('.cap-node-twisty').click(); assert.equal(composed.getAttribute('aria-expanded'), 'false', 'the twisty only folds');
  assert.equal(u.section.selected, COMPOSED);
});

test('Copy copies the kernel’s exact text, markers included', async t => {
  const u = setup(t); const answer = composedAnswer(); u.section.update(row({ composedInstructions: answer }));
  const copied = [];
  Object.defineProperty(u.dom.window.navigator, 'clipboard', { configurable: true, value: { writeText: v => { copied.push(v); return Promise.resolve(); } } });
  u.item(COMPOSED).querySelector('.cap-node-name').click();
  const button = u.$('.cap-reader-head button.soul-copy');
  assert.equal(button.textContent, 'Copy composed AGENTS.md');
  button.click(); await flush();
  assert.deepEqual(copied, [answer.text]); assert.equal(button.textContent, 'Copied');
  Object.defineProperty(u.dom.window.navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } });
  button.click(); await flush(); assert.equal(button.textContent, 'Copy failed');
  u.item(OWN).querySelector('.cap-node').click(); assert.equal(u.$('.soul-copy'), null, 'the own file has no Copy');
});

test('without the feature no composed AGENTS.md and no note; a null answer is a note pointing at the problem; a broken one says it cannot be read', t => {
  const u = setup(t);
  u.section.update(row({ composedInstructions: undefined }));
  const { composedInstructions, ...without } = row(); void composedInstructions;
  u.section.update(without);
  const composedSection = () => u.$$('[role=tree] > li[role=none] > ul[role=group]')[1];
  // Without the feature the section holds only its Skills row (soul-skills.test.mjs): today's silence for the composed file.
  assert.equal(u.item(COMPOSED), null); assert.doesNotMatch(u.host.textContent, /after spawn/);
  assert.deepEqual([...composedSection().children].map(c => c.querySelector('.cap-contents-group-label')?.textContent), ['Skills']);
  u.section.update(row({ composedInstructions: null }));
  assert.equal(u.item(COMPOSED), null);
  // The note stands where the composed AGENTS.md would, first in its section (the Skills row follows it).
  const noteOf = () => composedSection().children[0];
  assert.deepEqual([...noteOf().children].map(c => [c.className, c.textContent]), [['cap-contents-note', SOUL_INSTRUCTIONS_COPY.cannotCompose]]);
  assert.equal(noteOf().getAttribute('role'), 'none');
  u.section.update(row({ composedInstructions: { text: 'x' } }));
  assert.equal(noteOf().textContent, SOUL_INSTRUCTIONS_COPY.cannotRead);
});

test('a part past the size limit says so in its section; a cut part is flagged in its header', t => {
  const u = setup(t);
  const c = composedAnswer(), cap = c.sources[1].start + 30, text = c.text.slice(0, cap);
  const clamp = s => ({ ...s, start: Math.min(s.start, cap), end: Math.min(s.end, cap), truncated: s.end > cap });
  u.section.update(row({ composedInstructions: { ...c, text, truncated: true, sources: c.sources.map(clamp) } }));
  u.item(COMPOSED).querySelector('.cap-node-name').click();
  const parts = u.$$('.soul-part');
  assert.equal(u.$('.cap-reader-flag').textContent, 'Truncated at 200,000 characters');
  assert.equal(parts[2].querySelector('.soul-part-flag').textContent, 'Truncated');
  assert.equal(parts[3].querySelector('.cap-reader-line').textContent, 'Not included: past the size limit.');
  assert.equal(parts[3].querySelector('.soul-part-flag'), null);
});

test('repaint stability: an unchanged answer rebuilds nothing; selection, expansion and focus survive; a gone part falls back', t => {
  const u = setup(t); u.section.update(row());
  u.item(COMPOSED).querySelector('.cap-node-name').click(); u.item('part:3').querySelector('.cap-node').click();
  const view = u.$('.cap-reader-body .soul-part'), part = u.item('part:3'); part.focus();
  u.section.update(structuredClone(row()));
  assert.equal(u.$('.cap-reader-body .soul-part'), view); assert.equal(u.item('part:3'), part); assert.equal(u.doc.activeElement, part);
  // One block fewer (a capability left the soul): the tree is rebuilt, focus found again by key or on its composed item.
  u.section.update(row({ composedInstructions: composedAnswer({ blocks: [['kernel:instance-boundary', null, 'a']] }) }));
  assert.equal(u.section.selected, OWN, 'the part is gone: back to the own file');
  assert.equal(u.doc.activeElement, u.item(COMPOSED)); assert.equal(u.item(COMPOSED).getAttribute('aria-expanded'), 'true', 'expansion kept');
  // The CLI lost the feature: the group goes, the own file stays.
  const { composedInstructions, ...without } = row(); void composedInstructions;
  u.section.update(without); assert.equal(u.item(COMPOSED), null); assert.equal(u.section.selected, OWN);
});

test('untrusted content in a part: no raw HTML, scripts or images; links settle as in the own file', t => {
  const u = setup(t);
  u.section.update(row({ composedInstructions: composedAnswer({ blocks: [['capability:oats.core', null, '<script>alert(1)</script><img src="https://evil.example/x.png">\n\n[out](https://example.com) [rel](skills/x.md)']] }) }));
  u.item(COMPOSED).querySelector('.cap-node-name').click();
  assert.equal(u.$('.cap-reader-body script, .cap-reader-body img'), null);
  assert.deepEqual(u.$$('.soul-part a').map(a => a.getAttribute('href')), ['https://example.com']);
  u.$('.soul-part a').click(); assert.deepEqual(u.opened, [['external', 'https://example.com']]);
});

/* ── on the soul page: the request ───────────────────────────────────── */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/workspace-v2/f7/inspect-soul.json', import.meta.url), 'utf8')).result;
const version = JSON.parse(readFileSync(new URL('./fixtures/workspace-v2/f7/version.json', import.meta.url), 'utf8'));
const agentsRoot = '/fixture/base/northwind-workspace/agents';
async function page(t, { layout = 'page', agent = {}, features = [FEATURE], answer = () => fixture } = {}) {
  const previous = currentWorkspace(); setWorkspace('/team');
  await refreshCli({ api: async () => ({ ...version, features: [...version.features, ...features], ok: true, bin: '/fixture/bin/oats' }) });
  const bodies = [], opened = [];
  const dom = new JSDOM('<body><main><aside hidden></aside></main></body>', { pretendToBeVisual: true }), el = dom.window.document.querySelector('aside');
  const inspector = createSoulInspector(el, { layout, openCapability: (cap, soul, entry) => opened.push([cap.id, soul.name, !!entry]), ctx: { api: async (url, opts) => {
    if (!url.startsWith('/api/capabilities')) return { status: 'ok', soulTeams: {} };
    const body = JSON.parse(opts.body); bodies.push(body); return structuredClone(answer(body));
  } } });
  t.after(() => { inspector.dispose(); dom.window.close(); setWorkspace(previous); resetCliStateForTests(); });
  await inspector.show({ agent: { name: 'release-manager', agentsRoot, ...agent }, selector: { soul: 'release-manager', agentsRoot } });
  for (let i = 0; i < 4; i++) await flush();
  return { el, bodies, opened, inspector };
}

test('the soul page asks for the composed AGENTS.md only with the feature; the sidebar never does; a remote soul only with server-probe-features', async t => {
  const flagged = await page(t);
  assert.deepEqual(flagged.bodies, [{ action: 'inspect', selector: { soul: 'release-manager', agentsRoot }, instructions: true }]);
  // A routed soul: the page asks when this CLI relays the hosts' features; whether the host composes is the server's call.
  for (const agent of [{ remote: true, server: 'builder' }, { server: 'builder' }]) {
    const routed = await page(t, { agent, features: [FEATURE, 'server-probe-features'] });
    assert.deepEqual(routed.bodies, [{ action: 'inspect', selector: { soul: 'release-manager', agentsRoot }, instructions: true }], JSON.stringify(agent));
  }
  for (const [label, options] of [['no feature', { features: [] }], ['sidebar', { layout: 'sidebar' }], ['remote soul', { agent: { remote: true, server: 'builder' } }],
    ['remote soul, relays but does not compose', { agent: { remote: true, server: 'builder' }, features: ['server-probe-features'] }],
    ['remote soul in the sidebar', { layout: 'sidebar', agent: { remote: true, server: 'builder' }, features: [FEATURE, 'server-probe-features'] }]]) {
    const u = await page(t, options);
    assert.equal(u.bodies.some(b => Object.hasOwn(b, 'instructions')), false, label);
  }
});

test('on the page: the composed group from the inspection, and Open capability takes the tables’ own path', async t => {
  const answer = () => { const v = structuredClone(fixture); v.souls[0].composedInstructions = composedAnswer({ blocks: [['capability:oats.aweb', null, '## Messaging']] }); return v; };
  const u = await page(t, { answer });
  const section = u.el.querySelector('.soul-instructions');
  section.querySelector('[data-path="composed"] .cap-node-name').click();
  const open = section.querySelector('.soul-part-open'); assert.ok(open, 'oats.aweb is one of the soul’s capabilities');
  open.click(); assert.deepEqual(u.opened, [['oats.aweb', 'release-manager', true]]);
});

test('repeated headings across parts: ids stay unique, a part’s own fragment goes to its own heading, a document-style one resolves', t => {
  const u = setup(t);
  u.section.update(row({ composedInstructions: composedAnswer({ blocks: [
    ['capability:oats.core', '.oats/modules/oats.core/inject.md', '## Usage\n\nFirst.'],
    ['capability:acme.ops', '.oats/modules/acme.ops/inject.md', '## Usage\n\nSecond: see [usage](#usage) and [the next one](#usage-1).\n\n## Usage\n\nAgain.'],
    ['capability:acme.more', null, 'Elsewhere: [the third Usage](#usage-2).'],
  ] }) }));
  const reader = scrollable(u.$('.cap-contents-reader'));
  u.item(COMPOSED).querySelector('.cap-node-name').click();
  const ids = u.$$('.cap-reader-body [id]').map(el => el.id);
  assert.equal(new Set(ids).size, ids.length, `unique: ${ids}`);
  const [first, second, third] = u.$$('.soul-part-body h2');
  assert.deepEqual([first.id, second.id, third.id], ['usage', 'usage-1', 'usage-2'], 'the ids the whole document would give');
  assert.equal(second.closest('.soul-part').dataset.source, 'capability:acme.ops');
  const [own, next] = u.$$('.soul-part[data-source="capability:acme.ops"] a');
  assert.equal(own.getAttribute('href'), '#usage-1', 'the part’s own #usage follows its renamed heading');
  assert.equal(next.getAttribute('href'), '#usage-2', 'and its own #usage-1 (its second Usage) too');
  assert.equal(u.$('.soul-part[data-source="capability:acme.more"] a').getAttribute('href'), '#usage-2', 'a part with no headings keeps whole-document lookup');
  Object.defineProperty(u.$('.cap-reader-head'), 'offsetHeight', { configurable: true, get: () => 32 });
  [first, second, third].forEach((h, i) => Object.defineProperty(h, 'offsetTop', { configurable: true, get: () => 60 + i * 500 }));
  own.click(); assert.equal(reader.scrollTop, 560 - 32 - 8, 'it scrolls to the second part’s heading, not the first');
  // The soul's own file (a single document) keeps the reader's ids as they were.
  u.item(OWN).querySelector('.cap-node').click(); assert.equal(u.$('.soul-part'), null);
});

test('a generated suffix never takes an id a later heading needs: every id is unique, and each part’s link stays in its part', t => {
  const u = setup(t);
  u.section.update(row({ composedInstructions: composedAnswer({ blocks: [
    ['capability:oats.core', null, '## Usage\n\nOne.\n\n## Usage\n\nTwo.'],
    ['capability:acme.ops', null, '## Usage 1\n\n[Return](#usage-1).'],
  ] }) }));
  const reader = scrollable(u.$('.cap-contents-reader'));
  u.item(COMPOSED).querySelector('.cap-node-name').click();
  const heads = u.$$('.soul-part-body h2');
  assert.deepEqual(heads.map(h => h.id), ['usage', 'usage-1', 'usage-1-1']);
  const link = u.$('.soul-part[data-source="capability:acme.ops"] a');
  assert.equal(link.getAttribute('href'), '#usage-1-1', 'B’s #usage-1 is its own "Usage 1"');
  Object.defineProperty(u.$('.cap-reader-head'), 'offsetHeight', { configurable: true, get: () => 32 });
  heads.forEach((h, i) => Object.defineProperty(h, 'offsetTop', { configurable: true, get: () => 60 + i * 500 }));
  link.click(); assert.equal(reader.scrollTop, 1060 - 32 - 8, 'it scrolls to B’s heading, not A’s second Usage');
});

test('a part is Markdown whatever its source file is called (an inject.txt is still a slice of AGENTS.md)', t => {
  const u = setup(t);
  u.section.update(row({ composedInstructions: composedAnswer({ blocks: [['capability:acme.ops', '.oats/modules/acme.ops/inject.txt', '## Important instructions\n\nDo **this**.']] }) }));
  u.item(COMPOSED).querySelector('.cap-node-name').click();
  const part = u.$('.soul-part[data-source="capability:acme.ops"]');
  assert.equal(part.querySelector('.soul-part-file').textContent, '.oats/modules/acme.ops/inject.txt', 'the reported file stays as provenance');
  assert.equal(part.querySelector('h2')?.textContent, 'Important instructions'); assert.equal(part.querySelector('pre'), null);
  assert.equal(part.querySelector('strong')?.textContent, 'this');
});
