// Trigger sources (kernel feature `trigger-sources`) on the capability page: the "Trigger sources" row of its
// Triggers fold (the Desktop UI rework, slice 3b: the page's Provides card became its folds), drawn from `capabilities show` by the Contents controller (capability-contents.mjs) and placed by the page
// (capability-page.mjs). jsdom, no CLI, server or GUI.
//
// The answers are the kernel's own, recorded in test/fixtures/trigger-sources/ (envelopes; the answer is `.result`):
//   capability-show.json            one well-formed source
//   capability-show-problems.json   a source with a problem, a well-formed one, and `"Bad Name": 7` (two problems)
//   capability-show-not-object.json `triggerSources` is a string; one top-level problem (`source: null`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createCapabilityContents } from '../renderer/capability-contents.mjs';
import { renderCapabilityPage, fillTriggerSourcesRow, capabilityPageCSS, TRIGGER_SOURCES_COPY } from '../renderer/capability-page.mjs';
import { capabilityShowData, triggerSourcesView } from '../../client/capability-show-contract.mjs';
import { LEAD_INS, sourceQuoteCSS } from '../renderer/source-quote.mjs';
import * as spawn from '../renderer/views/spawn.mjs';
import { currentWorkspace, setWorkspace } from '../renderer/views/common.mjs';
import { refreshCli } from '../renderer/views/cli-status.mjs';
import { workspaceStatusData, deploymentStatusData } from '../../client/deployment-data.mjs';

const recorded = name => JSON.parse(readFileSync(new URL(`./fixtures/trigger-sources/${name}.json`, import.meta.url), 'utf8')).result;
const GOOD = recorded('capability-show'), PROBLEMS = recorded('capability-show-problems'), NOT_OBJECT = recorded('capability-show-not-object');
const SELECTOR = { name: 'acme.graph', kind: 'member', repoKey: 'local//fixture/base/remotes/ws.git' };
const DESCRIPTION = 'Ready harvest branches, one event per judged head';
const LEAD = "From the capability's manifest:";
const cli = { ok: true, features: ['capability-show', 'trigger-sources'], capabilityShowApi: 1 };
const flush = () => new Promise(r => setTimeout(r, 0));
const rowOf = answer => ({ ...SELECTOR, commit: answer.commit });
/** The same answer with another declaration (and its problems): what a manifest could hold, in the recorded envelope. */
const declaring = (triggerSources, triggerSourceProblems) => ({ ...GOOD, triggerSources, ...(triggerSourceProblems ? { triggerSourceProblems } : {}) });

/** The page as its host keeps it: the controller's two long-lived elements, the page rebuilt around them on a
 * catalog repaint (`render`) and when the row appears or leaves (`onProvidesChange`). */
function page(t, answer, { catalogRow = {}, from = null } = {}) {
  const dom = new JSDOM('<!doctype html><body><main></main></body>', { pretendToBeVisual: true });
  const doc = dom.window.document, host = doc.querySelector('main'), calls = [], changes = [];
  const state = { row: rowOf(answer.current) };
  const render = () => renderCapabilityPage(host, { row: { ...state.row, ...catalogRow, ...(from ? { resolved: { id: SELECTOR.name, operations: [] } } : {}) }, status: null, instances: [], root: '/ws', onBack() {},
    from, contents: contents.element, triggerSources: contents.triggerSources });
  const contents = createCapabilityContents(doc, { request: body => { calls.push(body); return Promise.resolve(structuredClone(answer.current)); },
    onProvidesChange: () => { changes.push(contents.triggerSources.childElementCount > 0); render(); } });
  t.after(() => { contents.dispose(); dom.window.close(); });
  const go = async () => { state.row = rowOf(answer.current); render(); contents.update({ row: state.row, cli, deployment: '/ws' }); await flush(); };
  const $ = s => host.querySelector(s), $$ = s => [...host.querySelectorAll(s)];
  return { doc, host, calls, changes, contents, render, go, $, $$, row: () => $('.provides-card > [data-provides="trigger-sources"]'), folds: () => $$('details.cap-fold').map(d => d.dataset.fold),
    lines: () => $$('.source-quote-line').map(line => ({ text: [...line.querySelectorAll('.source-quote-text')].map(n => n.textContent), notes: [...line.querySelectorAll('.source-quote-note')].map(n => n.textContent) })) };
}
/** No element, link, button, image or tooltip is ever made from a manifest's text: only text in quote lines. */
function assertOnlyQuotedText(row) {
  for (const selector of ['a', 'button', 'img', 'script', 'iframe', 'input', 'b', 'i', '[title]', '[href]', '[src]', '[onerror]', '[onclick]', '[tabindex]', '[aria-description]'])
    assert.equal(row.querySelectorAll(selector).length, 0, selector);
  assert.deepEqual([...new Set([...row.querySelectorAll('*')].map(n => n.tagName))].sort(), ['BLOCKQUOTE', 'DD', 'DIV', 'DT', 'LI', 'P', 'SPAN', 'UL'].filter(tag => row.querySelector(tag)).sort());
}

test('capability-show.json: one source, its events and description quoted under the manifest lead-in, in the Triggers fold', async t => {
  const u = page(t, { current: GOOD }, { catalogRow: { skills: ['graph'], commands: ['review-source'], hooks: [] } });
  await u.go();
  const row = u.row();
  assert.ok(row, 'a row of the Triggers fold');
  assert.equal(row.closest('details.cap-fold').dataset.fold, 'triggers');
  assert.equal(row, u.contents.triggerSources, "the controller's own element");
  assert.deepEqual(u.folds(), ['commands', 'triggers', 'hooks', 'used-by', 'source', 'files'], 'after Commands, before Hooks');
  assert.equal(row.querySelector('dt.provides-kind').textContent, 'Trigger sources1');
  assert.equal(row.querySelector('dt .provides-count').textContent, '1');
  const group = row.querySelector('dd.provides-items .source-quote');
  assert.equal(group.getAttribute('role'), 'group');
  const lead = u.doc.getElementById(group.getAttribute('aria-labelledby'));
  assert.equal(lead.textContent, LEAD); assert.equal(lead, group.querySelector('.source-quote-lead')); assert.equal(LEAD_INS.manifest, LEAD);
  assert.deepEqual(u.lines(), [{ text: ['harvest-branches: opened, updated', DESCRIPTION], notes: [] }]);
  assert.doesNotMatch(row.textContent, /review-source|graph\.example\.org|prefix|pattern/, 'command, parameters, fields and urlHosts are not shown');
  assertOnlyQuotedText(row);
  assert.deepEqual(u.changes, [true], 'the host was told once, when the row appeared');
  assert.ok(capabilityPageCSS.includes('.provides-sources') && sourceQuoteCSS.includes('.source-quote-text'));
});

test('capability-show-problems.json: a source with a problem or of another shape shows its name and why it is not usable; the good one as usual', async t => {
  const u = page(t, { current: PROBLEMS });
  await u.go();
  const [command, name, shape] = PROBLEMS.triggerSourceProblems.map(p => p.message);
  assert.equal(u.row().querySelector('.provides-count').textContent, '3');
  assert.equal(u.$$('.source-quote-lines > li.source-quote-line').length, 3, 'one line per source');
  assert.deepEqual(u.lines(), [
    { text: ['harvest-branches'], notes: [`declared, but not usable: ${command}`] },
    { text: ['good: opened, updated', DESCRIPTION], notes: [] },
    { text: ['Bad Name'], notes: [`declared, but not usable: ${name}`, `declared, but not usable: ${shape}`] },
  ]);
  assert.match(command, /^trigger source "harvest-branches": command "missing"/, "the kernel's message, verbatim");
  // The kernel's messages are notes of their line: outside the quoted text, in the plain style.
  for (const note of u.$$('.source-quote-note')) assert.equal(note.closest('.source-quote-text'), null);
  assert.equal(u.$('.provides-unreadable'), null);
  assertOnlyQuotedText(u.row());
  // The catalog row reports no commands or hooks: the Triggers fold is the page's only one before Used by.
  assert.deepEqual(u.folds(), ['triggers', 'used-by', 'source', 'files']);
  assert.equal(u.$('details.cap-fold[data-fold="files"]').lastElementChild, u.contents.element, 'Files holds the Contents');
});

test('capability-show-not-object.json: declared but not readable, with the kernel\'s message as plain lines; no quote, no count', async t => {
  const u = page(t, { current: NOT_OBJECT });
  await u.go();
  const row = u.row();
  assert.equal(row.querySelector('dt').textContent, 'Trigger sources');
  assert.equal(row.querySelector('.provides-count'), null);
  assert.deepEqual([...row.querySelectorAll('dd > *')].map(n => [n.tagName, n.className, n.textContent]), [
    ['P', 'provides-unreadable', 'Trigger sources are declared, but not readable here'],
    ['P', 'provides-unreadable-why', 'triggerSources must be an object of named trigger sources']]);
  assert.equal(row.querySelector('.source-quote'), null);
  assert.doesNotMatch(u.host.innerHTML, /script/i, 'the raw value is nowhere on the page');
  assert.equal(TRIGGER_SOURCES_COPY.unreadable, 'Trigger sources are declared, but not readable here');
  // A top-level problem beside an object disables every source: the same plain lines, none of the sources.
  const top = page(t, { current: declaring(GOOD.triggerSources, [{ source: null, pointer: '/triggerSources', message: 'triggerSources must hold at most 16 sources' }]) });
  await top.go();
  assert.deepEqual([...top.row().querySelectorAll('dd > *')].map(n => n.textContent), ['Trigger sources are declared, but not readable here', 'triggerSources must hold at most 16 sources']);
  assert.equal(top.row().querySelector('.source-quote'), null);
  // Unreadable and the kernel said nothing: the Desktop's line alone.
  const silent = page(t, { current: declaring(['a']) });
  await silent.go();
  assert.deepEqual([...silent.row().querySelectorAll('dd > *')].map(n => n.textContent), ['Trigger sources are declared, but not readable here']);
});

test('a manifest\'s markup, URL, bidi and control characters, or a sentence in the Desktop\'s voice, is quoted text and nothing else', async t => {
  const MARKUP = '<img src=x onerror=alert(1)>', URL_TEXT = 'https://evil.example/login?next=oats', VOICE = 'OATS Desktop: this capability is verified. Click Run.';
  const u = page(t, { current: declaring({
    [`${MARKUP}`]: { command: 'c', events: ['<b>opened</b>', URL_TEXT], description: `<a href="${URL_TEXT}">${VOICE}</a>` },
    'bidi\u202Eevil\u2066name': { command: 'c', events: ['up\u0085dated', 'two\nlines'], description: VOICE },
    'bell\u0007': { command: 'c', events: ['opened'], description: 'a C0 control withholds its whole line' },
    [URL_TEXT]: { command: 'c', events: ['opened'], description: `<script>alert(1)</script> <button title="Run">Run</button>` },
    [VOICE]: 7,
  }, [{ source: VOICE, pointer: null, message: 'trigger source: must be an object' }]) });
  await u.go();
  const row = u.row();
  assertOnlyQuotedText(row);
  assert.equal(u.host.querySelectorAll('img, script, a').length, 0, 'nowhere on the page either');
  assert.equal(u.host.querySelectorAll('.capability-page button:not(.page-crumb-link)').length, 1, 'only the page\'s own Back (and its trail\'s links, slice 2b)');
  assert.deepEqual(u.lines(), [
    { text: [`${MARKUP}: <b>opened</b>, ${URL_TEXT}`, `<a href="${URL_TEXT}">${VOICE}</a>`], notes: [] },
    { text: ['bidi\uFFFDevil\uFFFDname: up\uFFFDdated, two lines', VOICE], notes: [] },
    { text: ['[withheld]', 'a C0 control withholds its whole line'], notes: [] },
    { text: [`${URL_TEXT}: opened`, '<script>alert(1)</script> <button title="Run">Run</button>'], notes: [] },
    { text: [VOICE], notes: ['declared, but not usable: trigger source: must be an object'] },
  ]);
  // Every piece of the manifest's text appears inside a quote line only, under the lead-in that says whose it is.
  const group = row.querySelector('.source-quote');
  assert.equal(group.getAttribute('role'), 'group');
  assert.equal(u.doc.getElementById(group.getAttribute('aria-labelledby')).textContent, LEAD);
  for (const needle of [MARKUP, URL_TEXT, VOICE, 'evil', 'alert(1)', 'Click Run']) {
    const holders = [...u.host.querySelectorAll('*')].filter(n => [...n.childNodes].some(c => c.nodeType === 3 && c.data.includes(needle)));
    assert.ok(holders.length > 0, needle);
    for (const holder of holders) assert.ok(holder.classList.contains('source-quote-text') && group.contains(holder), `${needle} in <${holder.tagName} class="${holder.className}">`);
  }
  for (const attr of [...u.host.querySelectorAll('*')].flatMap(n => [...n.attributes])) for (const needle of [MARKUP, URL_TEXT, VOICE, 'evil.example'])
    assert.ok(!attr.value.includes(needle), `${needle} in the attribute ${attr.name}`);
  assert.equal(row.querySelector('.provides-count').textContent, '5');
});

test('the list is capped at 16 sources; a problem\'s source the listing does not hold is still a line', async t => {
  const many = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`source-${String(i).padStart(2, '0')}`, { command: 'c', events: ['opened'] }]));
  const u = page(t, { current: declaring(many) });
  await u.go();
  assert.equal(u.lines().length, 16);
  assert.equal(u.row().querySelector('.provides-count').textContent, '16');
  assert.deepEqual([u.lines()[0].text[0], u.lines()[15].text[0]], ['source-00: opened', 'source-15: opened'], "the first 16, in the kernel's order");
  const ghost = page(t, { current: declaring({ a: { command: 'c', events: ['e'] }, b: { command: 'c' } }, [{ source: 'gone', pointer: '/triggerSources/gone', message: 'no such source' }]) });
  await ghost.go();
  assert.deepEqual(ghost.lines(), [{ text: ['a: e'], notes: [] }, { text: ['b'], notes: ['declared, but not usable'] }, { text: ['gone'], notes: ['declared, but not usable: no such source'] }]);
  // Declared and empty: the row says so in the card's own grammar.
  const none = page(t, { current: declaring({}) });
  await none.go();
  assert.deepEqual([none.row().querySelector('.provides-count').textContent, none.row().querySelector('dd').textContent], ['0', 'None']);
});

test('an answer without triggerSources renders no row, and no Triggers fold for it', async t => {
  const { triggerSources: _t, ...older } = GOOD;
  const u = page(t, { current: older });
  await u.go();
  assert.equal(u.contents.triggerSources.childElementCount, 0);
  assert.equal(u.row(), null); assert.equal(u.contents.triggerSources.isConnected, false);
  assert.equal(u.$('details.cap-fold[data-fold="triggers"]'), null, 'no empty fold');
  assert.deepEqual(u.changes, []);
  // With other facts the folds are theirs alone.
  const listed = page(t, { current: older }, { catalogRow: { skills: [], commands: ['x'] } });
  await listed.go();
  assert.deepEqual(listed.folds(), ['commands', 'used-by', 'source', 'files']);
  // Problems without a declaration show nothing either.
  const stray = page(t, { current: { ...older, triggerSourceProblems: PROBLEMS.triggerSourceProblems } });
  await stray.go();
  assert.equal(stray.row(), null);
});

test('triggerSourceProblems never change the Contents state, its problems or its warnings', async t => {
  const { triggerSources: _t, triggerSourceProblems: _p, ...plain } = PROBLEMS;
  const a = page(t, { current: plain }), b = page(t, { current: PROBLEMS }), c = page(t, { current: NOT_OBJECT });
  await a.go(); await b.go(); await c.go();
  for (const u of [b, c]) {
    assert.equal(u.$('.cap-contents-problems'), null, 'not a problem of the capability');
    assert.equal(u.$('.cap-contents-nav .loading-failed'), null, 'the section did not fail');
    assert.equal(u.$('.cap-contents-warnings').hidden, true);
    assert.equal(u.$('.cap-contents').hidden, false); assert.equal(u.$('.cap-contents-gate').hidden, true);
    assert.equal(u.$('.cap-contents-nav-body').innerHTML, a.$('.cap-contents-nav-body').innerHTML, 'the navigation is what it is without them');
    assert.equal(u.$('.cap-reader-body').textContent, a.$('.cap-reader-body').textContent);
    assert.equal(u.$('.cap-contents-section .page-section-lead').textContent, `What an instance gets, at ${(u === b ? PROBLEMS : NOT_OBJECT).commit.slice(0, 7)}`);
  }
  // The capability's own problems stay in Contents, and the trigger sources' stay in Triggers.
  const own = page(t, { current: { ...PROBLEMS, problems: [{ code: 'E_X', message: 'cannot list skills', path: null }] } });
  await own.go();
  assert.deepEqual(own.$$('.cap-contents-problem').map(n => n.textContent), ['cannot list skills']);
  assert.doesNotMatch(own.$('.cap-contents-section').textContent, /declared, but not usable|harvest-branches/);
  assert.equal(own.lines().length, 3);
});

test('a catalog repaint keeps the row; the same answer re-applied does not rebuild it; a changed one repaints in place; a gone one leaves', async t => {
  const answer = { current: PROBLEMS };
  const u = page(t, answer, { catalogRow: { skills: ['graph'] } });
  await u.go();
  const row = u.row(), group = row.querySelector('.source-quote'), first = row.querySelector('.source-quote-text');
  // A catalog repaint: the page is rebuilt, the row is the same node with the same children.
  u.render(); u.render();
  assert.equal(u.row(), row); assert.equal(u.row().querySelector('.source-quote'), group);
  assert.equal(u.host.querySelectorAll('[data-provides="trigger-sources"]').length, 1);
  // The same answer read again (a refresh at the same commit): nothing is rebuilt, and the host is not asked to repaint.
  u.contents.refresh(); await flush();
  assert.equal(u.calls.filter(c => c.action === 'show').length, 2, 'read again');
  assert.equal(u.row().querySelector('.source-quote'), group); assert.equal(u.row().querySelector('.source-quote-text'), first);
  assert.deepEqual(u.changes, [true]);
  // Another declaration at the same commit repaints the row in place: same row, new content, still no page rebuild.
  const section = u.$('details.cap-fold[data-fold="triggers"]');
  answer.current = { ...PROBLEMS, triggerSources: GOOD.triggerSources, triggerSourceProblems: [] };
  u.contents.refresh(); await flush();
  assert.equal(u.row(), row); assert.notEqual(u.row().querySelector('.source-quote'), group);
  assert.deepEqual(u.lines(), [{ text: ['harvest-branches: opened, updated', DESCRIPTION], notes: [] }]);
  assert.equal(u.$('details.cap-fold[data-fold="triggers"]'), section, 'the page was not rebuilt');
  assert.deepEqual(u.changes, [true]);
  // The declaration is gone: the row empties, the host is told, and the page drops it.
  const { triggerSources: _t, triggerSourceProblems: _p, ...older } = PROBLEMS;
  answer.current = older;
  u.contents.refresh(); await flush();
  assert.deepEqual(u.changes, [true, false]);
  assert.equal(u.row(), null); assert.equal(u.contents.triggerSources.childElementCount, 0);
  assert.deepEqual(u.folds(), ['used-by', 'source', 'files']);
  // Back again, then a gate (an external capability has no contents): the row leaves with the answer.
  answer.current = PROBLEMS;
  u.contents.refresh(); await flush();
  assert.equal(u.row(), row); assert.deepEqual(u.changes, [true, false, true]);
  u.contents.update({ row: { name: 'x', kind: 'external' }, cli, deployment: '/ws' });
  assert.deepEqual(u.changes, [true, false, true, false]);
  assert.equal(u.row(), null);
});

test('a re-read that brings the row never takes focus from the open file', async t => {
  const { triggerSources: _t, ...older } = GOOD;
  const answer = { current: { ...older, inject: { path: 'inject.md', bytes: 4, text: '# Hi', binary: false, truncated: false } } };
  const dom = new JSDOM('<!doctype html><body><main></main></body>', { pretendToBeVisual: true });
  const doc = dom.window.document, host = doc.querySelector('main');
  // The host as views/spawn.mjs is: the page rebuilt with the Contents' focus held across the move.
  const render = () => { const keep = contents.hold(); renderCapabilityPage(host, { row: rowOf(GOOD), status: null, instances: [], root: '/ws', onBack() {}, contents: contents.element, triggerSources: contents.triggerSources }); keep(); };
  const contents = createCapabilityContents(doc, { request: () => Promise.resolve(structuredClone(answer.current)), onProvidesChange: render });
  t.after(() => { contents.dispose(); dom.window.close(); });
  render(); contents.update({ row: rowOf(GOOD), cli, deployment: '/ws' }); await flush();
  const item = host.querySelector('[role=treeitem]'); item.focus();
  assert.equal(doc.activeElement, item);
  answer.current = { ...answer.current, triggerSources: GOOD.triggerSources };
  contents.refresh(); await flush();
  assert.ok(host.querySelector('.provides-card [data-provides="trigger-sources"]'), 'the row arrived');
  assert.equal(doc.activeElement, item, 'focus stayed on the open file');
});

test('both forms of the page show it: from the Capabilities table and from a soul', async t => {
  const soul = page(t, { current: GOOD }, { from: { label: 'dev' } });
  await soul.go();
  assert.equal(soul.$('.page-crumbs').textContent.includes('Souls'), true, 'the soul form');
  assert.deepEqual(soul.folds(), ['triggers', 'used-by', 'source', 'as-soul', 'files']);
  assert.deepEqual(soul.lines(), [{ text: ['harvest-branches: opened, updated', DESCRIPTION], notes: [] }]);
});

test('fillTriggerSourcesRow: pure over the view; kernel text that must not be shown is withheld, not relayed', () => {
  const doc = new JSDOM('<!doctype html><body></body>').window.document;
  const row = doc.createElement('div');
  for (const answer of [GOOD, PROBLEMS, NOT_OBJECT]) {
    fillTriggerSourcesRow(row, triggerSourcesView(capabilityShowData(answer, { selector: SELECTOR })));
    assert.equal(row.querySelector('dt > span').textContent, 'Trigger sources');
  }
  fillTriggerSourcesRow(row, null);
  assert.equal(row.childElementCount, 0, 'nothing declared: an empty row');
  fillTriggerSourcesRow(row, { unreadable: ['see https://user:pw@host/x', 'two\nlines\u202E', '   '] });
  assert.deepEqual([...row.querySelectorAll('.provides-unreadable-why')].map(n => n.textContent), ['[withheld]', 'two lines\uFFFD']);
  fillTriggerSourcesRow(row, { sources: [{ name: 'a', events: null, description: 'never shown for an unusable source', problems: ['token=abcdef', ''] }] });
  assert.deepEqual([...row.querySelectorAll('.source-quote-note')].map(n => n.textContent), ['declared, but not usable: [withheld]']);
  assert.deepEqual([...row.querySelectorAll('.source-quote-text')].map(n => n.textContent), ['a']);
});

/* ── through the real Workspace view (views/spawn.mjs) ─────────────────── */
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 4; i++) await tick(); };
const f2 = name => JSON.parse(readFileSync(new URL(`./fixtures/workspace-v2/f2/${name}.json`, import.meta.url), 'utf8'));
const dir = '/fixture/base/northwind-workspace';
const CLI = { ...f2('version'), ok: true, bin: '/fixture/bin/oats', operationsApi: 2, features: [...(f2('version').features || []), 'operations', 'capability-show', 'trigger-sources'], relations: true, capabilityShowApi: 1 };
const status = workspaceStatusData(f2('workspace-status'), dir), roster = deploymentStatusData(f2('status'), dir);
const agents = roster.agents.map(({ instances: _i, ...soul }) => ({ ...soul, agentsRoot: roster.root }));
/** The f2 catalog plus the row of the recorded answers' capability (acme.graph, at the recorded commit). */
const catalogWith = answer => ({ capabilitiesApi: 1, ...f2('capabilities').result,
  capabilities: [...f2('capabilities').result.capabilities, { ...SELECTOR, origin: `member ${SELECTOR.repoKey}`, commit: answer.commit, team: null, private: false, path: 'capabilities/acme.graph', layer: null, version: '0.0.0-workspace' }] });

async function workspace(t, shows) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div>', { url: 'http://localhost' });
  const saved = { document: globalThis.document, window: globalThis.window, setInterval: globalThis.setInterval, ws: currentWorkspace() };
  globalThis.document = dom.window.document; globalThis.window = dom.window; globalThis.setInterval = () => 0;
  const state = { catalog: catalogWith(GOOD) }; let emits = 0;
  const ctx = { hasWorkspaceSwitcher: true, api: async (path, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    if (path === '/api/cli') return CLI;
    if (path.startsWith('/api/agents')) return { agents };
    if (path.startsWith('/api/panel')) return { workspace: { id: currentWorkspace(), scope: currentWorkspace() }, workspaces: [], instances: [],
      deployment: { status: 'observed', root: roster.root, workspace: status.workspace, workspaceStatus: status, reachable: { reachable: true }, withheld: [] } };
    if (path.startsWith('/api/workspace-sync')) return { workspaceSyncApi: 1, status: 'ok', report: null, capabilities: state.catalog, reason: null };
    if (path.startsWith('/api/capabilities') && body?.action === 'show') return shows(body);
    if (path.startsWith('/api/servers')) return { servers: [] };
    throw new Error(`Unexpected fixture API request: ${path}`);
  } };
  const doc = dom.window.document;
  t.after(() => { spawn.unmount(); setWorkspace(saved.ws); globalThis.document = saved.document; globalThis.window = saved.window; globalThis.setInterval = saved.setInterval; dom.window.close(); });
  setWorkspace('/team'); await refreshCli({ api: async () => CLI });
  spawn.mount(doc.querySelector('#host'), ctx); await settle();
  doc.getElementById('workspace-tab-capabilities').click(); await settle();
  return { doc, state, q: sel => doc.querySelector(sel),
    // A CLI change re-reads the catalog (the page follows it in place).
    reread: async () => { emits++; await refreshCli({ api: async () => ({ ...CLI, version: `${CLI.version}-emit${emits}` }) }); await settle(); } };
}

test('Workspace: the open capability page gains the row when the answer lands, keeps it across catalog repaints, and loses it with the declaration', async t => {
  let answer = PROBLEMS; const asked = [];
  const u = await workspace(t, body => { asked.push(body); return structuredClone(answer); });
  u.state.catalog = catalogWith(PROBLEMS); await u.reread();
  u.q('.cap-row[data-capability="acme.graph"]').click(); await settle();
  assert.deepEqual(asked.at(-1), { action: 'show', capability: SELECTOR });
  assert.match(u.q('.oats-view > style').textContent, /\.source-quote-text/, "the quote's styles are the view's");
  const row = u.q('.capability-page .provides-card > [data-provides="trigger-sources"]');
  assert.ok(row, 'the page was rebuilt around the row');
  assert.equal(row.querySelector('.source-quote-lead').textContent, LEAD);
  assert.equal(row.querySelectorAll('.source-quote-line').length, 3);
  assert.equal(u.q('.cap-contents-nav .loading-failed'), null); assert.equal(u.q('.cap-contents-problems'), null);
  assert.ok(u.doc.activeElement.classList.contains('page-back'), 'focus is where opening the page put it');
  // A catalog repaint that changes the page's facts rebuilds the page; the row is the same node.
  const group = row.querySelector('.source-quote');
  const described = catalogWith(PROBLEMS); Object.assign(described.capabilities.at(-1), { description: 'Graph tools.', skills: ['graph'] });
  u.state.catalog = described; await u.reread();
  assert.equal(u.q('.capability-page .page-lede').textContent, 'Graph tools.');
  assert.equal(u.q('.capability-page .provides-card > [data-provides="trigger-sources"]'), row);
  assert.equal(row.querySelector('.source-quote'), group, 'not rebuilt: the answer is the same');
  assert.deepEqual([...u.doc.querySelectorAll('.capability-page .provides-card > .provides-row')].map(r => r.dataset.provides), ['trigger-sources']);
  // The capability moves to a commit whose manifest declares none (capability-show.json without the key): the row leaves.
  const { triggerSources: _t, ...older } = GOOD; answer = older;
  const moved = catalogWith(GOOD); Object.assign(moved.capabilities.at(-1), { description: 'Graph tools.', skills: ['graph'] });
  u.state.catalog = moved; await u.reread();
  assert.equal(u.q('.capability-page [data-provides="trigger-sources"]'), null);
  assert.equal(u.q('.capability-page details.cap-fold[data-fold="triggers"]'), null);
});
