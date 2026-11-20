import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { automationRows, groupRows, filterRows, taskParts, cronInWords, onSummary, placementText, ownerParts, hostLogin, soulOriginText, testResult, triggerStatus, templateLabel, localScheduleDefinition } from '../renderer/automation-rows.mjs';
import { createAutomationsView, automationsSupported } from '../renderer/views/automations.mjs';
import { scheduleDraft } from '../renderer/schedule-read-data.mjs';

// Schedules + Triggers (§2.3a, kernel 0.29.0 `automations`), read from the real captured
// kernel output (fixtures/automations/kernel, see provenance.json). The capture's members are
// local remotes, so it has no file links and nothing has run yet: those facts (origin.url,
// launchConfig, template, a last run and a fire history) are added where a test needs them.
const raw = name => JSON.parse(readFileSync(new URL(`./fixtures/automations/kernel/${name}.json`, import.meta.url), 'utf8'));
const fx = name => raw(name).result;
const NOW = Date.parse('2026-09-26T15:40:00.000Z');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
// The captured commit of agents/pr-review (a fresh Northwind build each capture).
const CAPTURED_COMMIT = fx('trigger-list').triggers.find(t => t.id === 'agents/pr-review').origin.commit;
const URL_215 = `https://github.com/northwind/agents/blob/${CAPTURED_COMMIT}/oats-triggers/pr-review.yaml`;
/** The trigger list with the facts the capture cannot have (a link, a run, the scheduler on). */
function triggers215() {
  const json = fx('trigger-list');
  json.scheduler = { installed: true, active: true, lastTick: '2026-09-26T15:39:00.000Z', maxConcurrent: 2 };
  const review = json.triggers.find(r => r.id === 'agents/pr-review');
  Object.assign(review.origin, { url: URL_215, localPath: '/fx/clones/agents/oats-triggers/pr-review.yaml' });
  Object.assign(review, { launchConfig: 'reviewers', template: { package: 'oats.okf', version: '0.4.0', commit: null, template: 'harvest-review' },
    nextDue: '2026-09-26T15:42:00.000Z', lastRun: { at: '2026-09-26T15:32:00.000Z', outcome: 'launched', number: 41 } });
  return json;
}
const STATUS = { triggers: [{ id: 'agents/pr-review', firedTotal: 3, liveCount: 1, live: [{ number: 41 }], concurrency: { max: 1 }, pending: [], fired: [{ key: 'k41', at: '2026-09-26T15:32:00.000Z', number: 41, event: 'opened' }] }] };

test('the adapter reads the kernel rows as placed: groups come from runsHere/reason, never re-derived', () => {
  const t = automationRows(fx('trigger-list'), 'trigger');
  assert.deepEqual(t.host, { name: 'fixture-laptop', ghUser: { 'github.com': 'fixture-bot' } });
  assert.deepEqual([t.scheduler.installed, t.scheduler.active], [false, false], 'kernel #215: the trigger list carries the scheduler too');
  assert.deepEqual(t.snapshot, { takenAt: fx('trigger-list').snapshot.takenAt, problems: 1 }, 'snapshot.problems is a count'); assert.match(t.snapshot.takenAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(t.rows.map(r => [r.id, r.group]), [
    ['local/hotfix', 'here'], ['agents/docs-sync', 'elsewhere'], ['agents/pr-review', 'here'], ['agents/triage', 'attention']]);
  const [hotfix, , review] = t.rows;
  assert.equal(review.origin.kind, 'workspace'); assert.equal(review.origin.path, 'oats-triggers/pr-review.yaml');
  assert.equal(review.origin.url, null, 'no link in the capture: Open file stays disabled');
  assert.equal(review.soul.origin.kind, 'member'); assert.equal(review.run, 'spawn');
  assert.equal(hotfix.origin.kind, 'local'); assert.equal(hotfix.harness, 'codex');
  const r215 = automationRows(triggers215(), 'trigger').rows[2];
  assert.equal(r215.origin.url, URL_215, 'kernel #215: the file link'); assert.equal(r215.launchConfig, 'reviewers');
  assert.equal(templateLabel(r215.template), 'oats.okf:harvest-review');
  const s = automationRows(fx('schedule-list'), 'schedule');
  assert.deepEqual(s.rows.map(r => [r.id, r.group, r.run]), [['local/digest', 'here', 'command'], ['agents/nightly', 'here', 'spawn'], ['agents/weekly', 'elsewhere', 'command']],
    "the qualified id, even where the 0.28 row keeps a bare one; a schedule's kernel kind is its run");
  assert.deepEqual([s.scheduler.installed, s.scheduler.active], [false, false]);
  assert.equal(automationRows({ schedules: 'nope' }, 'schedule'), null); assert.equal(automationRows(fx('trigger-list'), 'other'), null);
});

test('a local schedule row gives back its stored definition for the editor, without the row facts', () => {
  const [digest, nightly] = automationRows(fx('schedule-list'), 'schedule').rows;
  const def = localScheduleDefinition(digest);
  assert.equal(def.id, 'digest'); assert.deepEqual([def.kind, def.cron, def.tz, def.argv], ['command', '30 8 * * 1-5', 'UTC', ['oats', 'status', '--json']]);
  for (const key of ['origin', 'runsHere', 'qualifiedId', 'nextDue', 'task', 'harness']) assert.equal(Object.hasOwn(def, key), false, key);
  assert.equal(localScheduleDefinition(nightly), null, 'a workspace schedule is edited in its repository');
  // The editor's closed field check (scheduleDraft) takes the definition, never the 0.29 row (name, origin, host, …).
  const list = fx('schedule-list'), { argv, cwd, ...rest } = list.schedules[0];
  list.schedules[0] = { ...rest, kind: 'wake', home: '/fx/home', message: 'Check.' };
  assert.deepEqual(scheduleDraft(localScheduleDefinition(automationRows(list, 'schedule').rows[0])),
    { id: 'digest', kind: 'wake', cron: '30 8 * * 1-5', tz: 'UTC', enabled: true, home: '/fx/home', message: 'Check.' });
});

test('groups in page order; the origin filter and search narrow them', () => {
  const rows = automationRows(fx('trigger-list'), 'trigger').rows;
  assert.deepEqual(groupRows(rows).map(g => [g.title, g.rows.map(r => r.id)]), [
    ['Runs on this computer', ['local/hotfix', 'agents/pr-review']], ['Needs attention here', ['agents/triage']], ['Runs elsewhere', ['agents/docs-sync']]]);
  assert.deepEqual(filterRows(rows, { origin: 'local' }).map(r => r.id), ['local/hotfix']);
  assert.deepEqual(filterRows(rows, { query: 'docs-server' }).map(r => r.id), ['agents/docs-sync'], 'search reaches where it runs');
  assert.deepEqual(filterRows(rows, { query: 'hotfix for' }).map(r => r.id), ['local/hotfix'], 'and the prompt');
});

test('kernel #215 facts: who gh is here, soul origins, both test shapes and a trigger status', () => {
  assert.equal(hostLogin({ ghUser: { 'github.com': 'fixture-bot' } }, 'github.com/someone-else'), 'github.com/fixture-bot');
  assert.equal(hostLogin({ ghUser: { 'github.com': null } }, 'github.com/fixture-bot'), 'not logged in');
  assert.equal(hostLogin({ ghUser: {} }, 'github.com/fixture-bot'), null, 'not reported: nothing shown');
  assert.match(soulOriginText({ kind: 'ambiguous', candidates: 2 }).long, /^2 souls answer to this name/);
  assert.equal(soulOriginText({ kind: 'external', repoKey: 'x', source: 'github.com/acme/souls@v1' }).long, 'An external soul from github.com/acme/souls@v1');
  assert.equal(soulOriginText(null).short, 'not found here');
  const here = testResult(fx('trigger-test'), 'trigger');
  assert.deepEqual([here.ok, here.account, here.wouldFire, here.problems[0]], [false, null, [], 'gh is not authenticated on this host']);
  assert.match(testResult(fx('trigger-test-mismatch'), 'trigger').problems[0], /^not run on this host \(owner-mismatch\)/);
  const sched = testResult(fx('schedule-test'), 'schedule');
  assert.deepEqual([sched.ok, sched.soul, sched.nextDue, sched.problems], [true, { resolves: true, error: null }, '2026-09-27T05:00:00.000Z', []]);
  const elsewhere = testResult(fx('schedule-test-elsewhere'), 'schedule'); assert.equal(elsewhere.ok, false);
  const st = triggerStatus(fx('trigger-status'), 'agents/pr-review');
  assert.deepEqual([st.liveCount, st.max, st.firedTotal, st.fired.length, st.pending.length], [0, 1, 0, 0, 0], 'captured: nothing fired yet');
  const fired = triggerStatus(STATUS, 'agents/pr-review');
  assert.deepEqual([fired.liveCount, fired.firedTotal, fired.fired.length], [1, 3, 1]);
  assert.equal(triggerStatus(fx('trigger-status'), 'nope'), null);
});

test('words: cron, the event, the owner, placement and the whitelisted task fields', () => {
  assert.equal(cronInWords('0 7 * * *'), 'Daily at 07:00'); assert.equal(cronInWords('30 8 * * 1-5'), 'Weekdays at 08:30');
  assert.equal(cronInWords('0 9 * * 1'), 'Mondays at 09:00'); assert.equal(cronInWords('*/15 * * * *'), 'Every 15 minutes');
  assert.equal(cronInWords('0 */2 * *'), null, 'anything else shows the cron itself');
  assert.deepEqual(onSummary(fx('trigger-list').triggers[0].on), { title: 'Pull request labeled', repo: 'northwind/storefront', labels: ['hotfix'], base: null, poll: '5m' });
  assert.deepEqual(ownerParts('github.com/fixture-bot'), { host: 'github.com', login: 'fixture-bot' });
  const [, docs, review, triage] = automationRows(fx('trigger-list'), 'trigger').rows;
  assert.equal(placementText(review, { name: 'fixture-laptop' }).label, 'This computer');
  assert.deepEqual(placementText(triage, {}), { label: 'Wrong account here', tone: 'warn', detail: triage.reasonDetail });
  assert.equal(placementText(docs, {}).label, 'docs-server');
  assert.deepEqual(taskParts('Review {repo}#{number} {title}.'), [{ text: 'Review ' }, { field: 'repo' }, { text: '#' }, { field: 'number' }, { text: ' {title}.' }],
    'only the whitelisted fields are tokens; anything else stays text');
});

function mount(t, kind, { act = null, openFile = null, json = fx(`${kind}-list`), status = null, ...more } = {}) {
  const dom = new JSDOM('<!doctype html><body><main></main></body>', { pretendToBeVisual: true });
  const host = dom.window.document.querySelector('main'), calls = [];
  const view = createAutomationsView(host, { kind, read: async () => json, act: act && (async (verb, row) => { calls.push([verb, row.id]); return act(verb, row); }), status, openFile, now: () => NOW, ...more });
  t.after(() => { view.dispose(); dom.window.close(); });
  const $ = s => host.querySelector(s), $$ = s => [...host.querySelectorAll(s)];
  return { dom, host, view, calls, $, $$ };
}

test('Triggers page: header, toolbar in the view, three groups of rows with placement and last/next', async t => {
  const u = mount(t, 'trigger', { act: () => ({ ok: true }), json: triggers215() }); await tick();
  assert.equal(u.$('.auto-header h2').textContent, 'Triggers4');
  assert.match(u.$('.auto-scheduler').textContent, /Scheduler on/, 'kernel #215: triggers run on the same tick');
  assert.deepEqual(u.$$('.auto-seg button').map(b => [b.dataset.origin, b.textContent, b.getAttribute('aria-pressed')]), [['all', 'All4', 'true'], ['workspace', 'Workspace3', 'false'], ['local', 'Local1', 'false']]);
  assert.deepEqual(u.$$('.auto-group').map(g => g.dataset.group), ['here', 'attention', 'elsewhere']);
  const row = id => u.$$('.auto-row').find(r => r.dataset.id === id);
  const review = row('agents/pr-review');
  assert.match(review.textContent, /Pull request opened, ready for review/);
  assert.match(review.textContent, /northwind\/storefront/);
  assert.match(review.textContent, /as @fixture-bot/); assert.match(review.textContent, /Next in 2 min/); assert.match(review.textContent, /Last 8 min ago · agent launched/);
  assert.equal(review.querySelector('.auto-switch').getAttribute('aria-checked'), 'true');
  assert.match(row('local/hotfix').textContent, /Polls at the next tick/, 'a trigger not yet polled says so');
  assert.match(row('agents/triage').querySelector('.auto-place').textContent, /Wrong account here/);
  assert.equal(row('agents/docs-sync').querySelector('.auto-switch'), null, 'no on/off here for another host\'s item');
  assert.match(u.$('.auto-foot').textContent, /1 discovery problem · Only members you can read in Git contribute\./);
  // Filter and search keep the search field (and its focus) across renders.
  const input = u.$('.auto-search input'); input.focus();
  input.value = 'triage'; input.dispatchEvent(new u.dom.window.Event('input')); await tick();
  assert.deepEqual(u.$$('.auto-row:not(.head)').map(r => r.dataset.id), ['agents/triage']);
  assert.equal(u.dom.window.document.activeElement, input);
});

test('the enabled-here switch and the menu act through the injected IO, then re-read', async t => {
  let reads = 0; const json = fx('trigger-list');
  const dom = new JSDOM('<!doctype html><body><main></main></body>'), host = dom.window.document.querySelector('main'), calls = [];
  const view = createAutomationsView(host, { kind: 'trigger', read: async () => { reads++; return json; }, act: async (verb, row) => { calls.push([verb, row.id]); return fx(`trigger-${verb}`); }, now: () => NOW });
  t.after(() => { view.dispose(); dom.window.close(); });
  await tick();
  host.querySelector('.auto-row[data-id="agents/pr-review"] .auto-switch').click(); await tick(); await tick();
  assert.deepEqual(calls, [['disable', 'agents/pr-review']]); assert.equal(reads, 2, 'a change re-reads the list');
  const menu = host.querySelector('.auto-row[data-id="local/hotfix"] .auto-menu');
  assert.deepEqual([...menu.querySelectorAll('button')].map(b => b.textContent), ['Open', 'Test', 'Turn off here']);
});

test('the served verbs limit the controls; extra row actions and header controls come from the page', async t => {
  const extra = []; let enabled = 0;
  const u = mount(t, 'schedule', { act: () => ({ ok: true }), verbs: ['enable', 'disable', 'run'], // a server without `schedule test`
    rowActions: row => row.origin.kind === 'local' ? [{ label: 'Edit', verb: 'edit', run: () => extra.push(row.id) }] : [],
    headerActions: doc => { const b = doc.createElement('button'); b.className = 'act primary x-new'; b.textContent = 'New schedule'; return [b]; },
    onEnableScheduler: () => { enabled++; } });
  await tick();
  assert.ok(u.$('.auto-header .x-new'), 'the header control sits in the header');
  const row = id => u.$$('.auto-row').find(r => r.dataset.id === id);
  assert.deepEqual([...row('local/digest').querySelectorAll('.auto-menu button')].map(b => b.textContent), ['Open', 'Run now', 'Turn off here', 'Edit'], 'no Test while `schedule test` is not served');
  row('local/digest').querySelector('.auto-menu button[data-verb=edit]').click(); assert.deepEqual(extra, ['local/digest']);
  assert.deepEqual([...row('agents/weekly').querySelectorAll('.auto-menu button')].map(b => b.textContent), ['Open'], 'another host\'s: no Run now, no on/off here');
  assert.match(u.$('.auto-banner').textContent, /scheduler is not running on this computer/);
  u.$('.auto-banner button').click(); assert.equal(enabled, 1);
  u.view.setNotice('digest: Agent launched'); assert.equal(u.$('.auto-notice').textContent, 'digest: Agent launched');
});

test('Schedules page: scheduler state in the header, cron in words and the next run', async t => {
  const u = mount(t, 'schedule', { act: () => ({ ok: true }), openFile: () => {} }); await tick();
  assert.match(u.$('.auto-scheduler').textContent, /Scheduler off/);
  const row = id => u.$$('.auto-row').find(r => r.dataset.id === id);
  assert.match(row('local/digest').textContent, /Weekdays at 08:30/); assert.match(row('local/digest').textContent, /Next in 2 d/);
  assert.match(row('agents/nightly').textContent, /Daily at 07:00/); assert.match(row('agents/nightly').textContent, /Nightly release check/);
  assert.equal(row('agents/weekly').dataset.group, 'elsewhere'); assert.match(row('agents/weekly').textContent, /reports-server/);
});

test('the detail page: prompt with highlighted fields, where it runs, where it comes from, Test result; Esc returns to the row', async t => {
  const opened = [];
  const u = mount(t, 'trigger', { json: triggers215(), act: verb => verb === 'test' ? fx('trigger-test') : { ok: true }, openFile: row => opened.push(row.origin.url), status: async () => STATUS });
  await tick();
  u.$('.auto-row[data-id="agents/pr-review"] .auto-open').click(); await tick();
  assert.equal(u.$('.auto-page').hidden, false); assert.equal(u.$('.auto-body').hidden, true); assert.equal(u.$('.auto-header').hidden, true, 'the page bar replaces the header');
  assert.equal(u.dom.window.document.activeElement, u.$('.page-back'));
  assert.deepEqual(u.$$('.auto-prompt .auto-token').map(s => s.textContent), ['{repo}', '{number}', '{url}']);
  assert.equal(u.$('.auto-prompt').textContent, 'Review storefront PR {repo}#{number} ({url}).', 'verbatim');
  const facts = card => Object.fromEntries([...u.$(`.page-card[data-card="${card}"]`).querySelectorAll('.page-kv')].map(r => [r.querySelector('dt').textContent, r.querySelector('dd').textContent]));
  assert.deepEqual(facts('Where it runs'), { 'Runs on': 'fixture-laptop', 'This computer': 'fixture-laptop', 'Acts as': 'github.com/fixture-bot', 'Logged in': 'github.com/fixture-bot' });
  await tick(); await tick();
  assert.match(u.$('.page-section[data-section="Recent fires"]').textContent, /1 of 1 live now · 3 fired in all/, 'trigger status: live and total');
  assert.equal(u.dom.window.document.activeElement, u.$('.page-back'), 'the status read keeps focus on Back');
  assert.deepEqual(facts('Comes from'), { Member: 'agents', Repo: 'local//fixture/base/fx/remotes/agents.git', Path: 'oats-triggers/pr-review.yaml', Commit: CAPTURED_COMMIT.slice(0, 7), Template: 'oats.okf:harvest-review v0.4.0' }, 'the package template it was made from');
  assert.equal(facts('Spawns')['Launch config'], 'reviewers');
  assert.deepEqual(u.$$('.page-bar-actions button').map(b => b.textContent), ['Open file', 'Test']);
  u.$('.page-bar-actions button[data-verb=file]').click(); assert.deepEqual(opened, [URL_215], 'opens the kernel-reported link');
  u.$('.page-bar-actions button[data-verb=test]').click(); await tick(); await tick();
  assert.match(u.$('.page-card[data-card="Test result"]').textContent, /Not ready on this computer\.gh is not authenticated on this host/);
  u.$('.auto-page').dispatchEvent(new u.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await tick();
  assert.equal(u.$('.auto-page').hidden, true);
  assert.equal(u.dom.window.document.activeElement, u.$('.auto-row[data-id="agents/pr-review"] .auto-open'), 'focus returns to the row');
});

test('Open file: the local file when the kernel reports one, else the web page, else disabled with the reason', async t => {
  const json = fx('trigger-list'), docs = json.triggers.find(r => r.id === 'agents/docs-sync');
  docs.origin.localPath = null; docs.origin.url = null; // a member with no clone here and no web address
  const opened = [], u = mount(t, 'trigger', { json, openFile: row => opened.push(row.origin.localPath) }); await tick();
  const fileButton = () => [...u.$('.page-card[data-card="Comes from"]').querySelectorAll('button')].find(b => b.textContent === 'Open file');
  u.view.open('agents/pr-review'); await tick();
  assert.equal(fileButton().disabled, false); assert.equal(fileButton().title, '/fixture/base/northwind-workspace/agents-repo/oats-triggers/pr-review.yaml');
  u.$('.page-bar-actions button[data-verb=file]').click(); assert.deepEqual(opened, [fileButton().title]);
  u.view.open('local/hotfix'); await tick();
  assert.equal(fileButton().disabled, false, 'a local item opens its file too');
  u.view.open('agents/docs-sync'); await tick();
  assert.equal(fileButton().disabled, true); assert.match(fileButton().title, /no clone of this member/);
  assert.equal(u.$('.page-bar-actions button[data-verb=file]'), null, 'no page-bar action without a file');
});

test('host-unnamed is one banner; an empty list explains both levels without naming a kernel file', async t => {
  const json = fx('trigger-list'); json.host = { name: null }; Object.assign(json.scheduler, { installed: true, active: true, registered: true });
  for (const r of json.triggers) if (r.origin.kind === 'workspace') { r.runsHere = false; r.reason = 'host-unnamed'; }
  const a = mount(t, 'trigger', { json }); await tick();
  assert.equal(a.$$('.auto-banner').length, 1); assert.match(a.$('.auto-banner').textContent, /no host name/);
  assert.deepEqual(a.$$('.auto-group').map(g => g.dataset.group), ['here', 'elsewhere']);
  const b = mount(t, 'schedule', { json: { schedules: [], host: { name: 'x' }, snapshot: null } }); await tick();
  assert.match(b.$('.auto-empty').textContent, /No schedules yet/);
  assert.doesNotMatch(b.host.textContent, /oats-local\.yaml|oats-workspace\.yaml|oats-schedules\.json/);
  assert.match(b.$('.auto-foot').textContent, /Workspace items appear after the next sync/);
});

test('the page gate: shown only for an OATS that reports automations', () => {
  assert.equal(automationsSupported({ ...raw('version'), ok: true }), true, 'the captured version');
  assert.equal(automationsSupported({ ok: true, features: ['schedule'], scheduleApi: 2 }), false);
  assert.equal(automationsSupported({ ok: true, features: ['automations'] }), false, 'the API version must match too');
  assert.equal(automationsSupported(null), false);
});

test('the mounted page: gates on the CLI, then reads and acts through POST /api/automations', async t => {
  const { mountAutomationsPage } = await import('../renderer/views/automations.mjs');
  const { setWorkspace } = await import('../renderer/views/common.mjs');
  const dom = new JSDOM('<!doctype html><body><main></main></body>', { pretendToBeVisual: true });
  const el = dom.window.document.querySelector('main'), bodies = [], opened = [];
  setWorkspace('/team');
  let cli = { ok: true, features: ['schedule'], scheduleApi: 2 }; const listeners = new Set();
  const ctx = { openFile: path => opened.push(path), openExternal: url => opened.push(url), api: async (path, opts) => {
    const body = JSON.parse(opts.body); bodies.push([path, body]);
    if (body.action === 'list') return { automationsViewApi: 1, status: 'ok', kind: 'trigger', action: 'list', result: triggers215(), reason: null };
    if (body.action === 'test') return { automationsViewApi: 1, status: 'unavailable', kind: 'trigger', action: 'test', result: null, reason: { code: 'E_X', message: 'gh is missing' } };
    return { automationsViewApi: 1, status: 'ok', kind: 'trigger', action: body.action, result: fx(`trigger-${body.action}`), reason: null };
  } };
  const page = mountAutomationsPage(el, ctx, 'trigger', undefined, { cli: () => cli, subscribeCli: fn => { listeners.add(fn); return () => listeners.delete(fn); } });
  t.after(() => { page.dispose(); dom.window.close(); });
  assert.match(el.textContent, /Triggers need OATS 0\.29 or later/); assert.equal(bodies.length, 0, 'nothing is read from an older OATS');
  cli = { ok: true, features: ['schedule', 'automations'], automationsApi: 1 }; for (const fn of listeners) fn(); await tick(); await tick();
  assert.deepEqual(bodies[0], ['/api/automations?ws=%2Fteam', { kind: 'trigger', action: 'list' }]);
  el.querySelector('.auto-row[data-id="agents/pr-review"] .auto-switch').click(); await tick(); await tick();
  assert.deepEqual(bodies[1][1], { kind: 'trigger', action: 'disable', key: 'agents/pr-review' }, 'the row\'s qualified id, as `key`');
  page.view.open('agents/pr-review'); el.querySelector('.page-bar-actions button[data-verb=file]').click();
  assert.deepEqual(opened, ['/fx/clones/agents/oats-triggers/pr-review.yaml'], 'Open file opens the clone\'s file read-only, before the web page');
  el.querySelector('.page-bar-actions button[data-verb=test]').click(); await tick(); await tick();
  assert.match(el.querySelector('.page-card[data-card="Test result"]').textContent, /gh is missing/, 'an unavailable reply shows its reason');
});

test('#1879: an accepted newer CLI with no automations API of a known shape, or with no workspace, gets its gate and the notice beside it; nothing is read', async t => {
  const { mountAutomationsPage } = await import('../renderer/views/automations.mjs');
  const { setWorkspace } = await import('../renderer/views/common.mjs');
  const cs = await import('../renderer/views/cli-status.mjs');
  const cli = (extra = {}) => ({ ok: true, bin: '/oats', version: '0.70.1', source: 'path', required: { desktopApi: 1, range: '>=0.26.0, tested through 0.69' }, tried: [],
    aboveTested: true, testedThrough: '0.69', features: ['schedule', 'automations'], ...extra });
  let probe = cli({ automationsApi: null });
  const bodies = [], ctx = { api: async (path, opts) => { if (path === '/api/cli') return probe; bodies.push([path, opts?.body]); return { status: 'ok', result: { triggers: [] } }; } };
  await cs.refreshCli(ctx);
  t.after(() => { cs.resetCliStateForTests(); setWorkspace('/team'); });
  setWorkspace('/team');
  const dom = new JSDOM('<!doctype html><body><main></main></body>', { pretendToBeVisual: true }), el = dom.window.document.querySelector('main');
  const page = mountAutomationsPage(el, ctx, 'trigger');
  t.after(() => { page.dispose(); dom.window.close(); });
  const notice = () => el.querySelector('.cli-above-tested:not([hidden]) .cli-notice')?.textContent.trim() ?? null;
  const sentence = /^This Desktop was tested with oats CLIs up to 0\.69; the installed CLI is 0\.70\.1\. /;
  assert.match(el.querySelector('.auto-gate').textContent, /Triggers need OATS 0\.29 or later/, 'an unknown API: the gate');
  assert.match(notice(), sentence, 'and the notice');
  assert.equal(el.querySelector('.cli-above-tested .cli-release').textContent, 'https://github.com/oats-project/oats/releases/tag/v0.70.1', 'with its release');

  probe = cli({ automationsApi: undefined }); delete probe.automationsApi; await cs.refreshCli(ctx); await tick();
  assert.match(el.querySelector('.auto-gate').textContent, /Triggers need OATS 0\.29 or later/, 'a missing API: the gate');
  assert.match(notice(), sentence, 'and the notice');

  probe = cli({ automationsApi: 1 }); setWorkspace(''); await cs.refreshCli(ctx); await tick();
  assert.match(el.querySelector('.auto-gate').textContent, /Choose a workspace/, 'no workspace: the gate');
  assert.match(notice(), sentence, 'and the notice');
  assert.equal(el.querySelectorAll('.cli-above-tested').length, 1, 'one notice, never one per build');
  assert.deepEqual(bodies, [], 'nothing is read behind a gate');

  probe = cli({ automationsApi: null, version: '0.69.25', aboveTested: undefined, testedThrough: undefined }); await cs.refreshCli(ctx); await tick();
  assert.match(el.querySelector('.auto-gate').textContent, /Triggers need OATS 0\.29 or later/);
  assert.equal(notice(), null, 'within the bound the gate stands alone');
});

// Spec F audit: the row menu closes with Escape (focus back on its summary), a chosen item
// returns focus to the summary (never <body>), and tabbing out closes it.
test('keyboard: the row menu closes on Escape and after an item, focus back on its summary', async t => {
  const json = fx('trigger-list');
  const dom = new JSDOM('<!doctype html><body><main></main><button id="after">after</button></body>'), host = dom.window.document.querySelector('main');
  const view = createAutomationsView(host, { kind: 'trigger', read: async () => json, act: async verb => fx(`trigger-${verb}`), now: () => NOW });
  t.after(() => { view.dispose(); dom.window.close(); });
  await tick();
  const doc = dom.window.document, menu = host.querySelector('.auto-row[data-id="local/hotfix"] .auto-menu'), summary = menu.querySelector('summary');
  menu.open = true; menu.querySelector('button').focus();
  menu.querySelector('button').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(menu.open, false); assert.equal(doc.activeElement, summary);
  menu.open = true; const test = menu.querySelector('button[data-verb=test]'); test.focus(); test.click(); await tick();
  assert.equal(host.querySelector('.auto-row[data-id="local/hotfix"] .auto-menu').open, false);
  assert.notEqual(doc.activeElement, doc.body);
  const again = host.querySelector('.auto-row[data-id="local/hotfix"] .auto-menu'); again.open = true;
  again.querySelector('button').dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true, relatedTarget: doc.getElementById('after') }));
  assert.equal(again.open, false, 'Tab out of it closes it');
});
