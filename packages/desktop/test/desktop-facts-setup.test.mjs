// Kernel #217 desktop facts on the Setup tab (views only): the workspace and
// membership files, this computer's clones, available package versions,
// disabled souls and the lock file, read from the real capture through the
// server projection. An older kernel reports none of them and Setup is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { workspaceStatusData } from '../../client/deployment-data.mjs';
import { renderSetup, setupCSS, teamsBox } from '../renderer/workspace-setup.mjs';

const DEPLOYMENT = '/fixture/base/northwind-workspace';
const capture = () => JSON.parse(readFileSync(new URL('./fixtures/workspace-v2/desktop-facts/workspace-status.json', import.meta.url), 'utf8'));
const statusOf = (edit = () => {}) => { const doc = capture(); edit(doc.result); return workspaceStatusData(doc, DEPLOYMENT); };
const host = () => { const doc = new JSDOM('<!doctype html><body></body>').window.document; return doc.body.appendChild(doc.createElement('div')); };
const local = root => Object.fromEntries([...root.querySelectorAll('[data-zone=here] .setup-facts .setup-fact')].map(r => [r.querySelector('dt').textContent, r.querySelector('dd')]));
const MARKETING = 'local//fixture/base/fx/remotes/marketing.git';
// The captured workspace commit (a fresh Northwind build each capture), shown short.
const SHORT = capture().result.workspace.commit.slice(0, 7);

test('Setup names the files the kernel reports, and links them only when they have a web address', () => {
  const plain = host();
  renderSetup(plain, { status: statusOf(), openExternal: () => assert.fail('no url, no link') });
  const where = plain.querySelector('.setup-lede-where');
  assert.match(where.textContent, new RegExp(`^Declared in agents's oats-workspace\\.yaml at ${SHORT}\\.$`));
  assert.equal(where.querySelector('button'), null, 'the capture has url: null, so the path is plain text');
  renderSetup(plain, { status: statusOf(), selected: MARKETING, onSelect() {}, openExternal: () => assert.fail() });
  const subs = [...plain.querySelectorAll('.setup-panel .setup-hand-sub')].map(s => s.textContent);
  assert.deepEqual(subs, ["in agents's oats-workspace.yaml", "The repo's oats-membership.yaml names this workspace"]);
  assert.equal(plain.querySelector('.setup-panel [data-verb=repo]'), null, 'no repository link without a web address');

  const opened = [], hosted = host();
  const status = statusOf(r => {
    r.workspace.file.url = `https://github.com/northwind/agents/blob/${SHORT}/oats-workspace.yaml`;
    const m = r.members.find(x => x.key === MARKETING);
    m.url = 'https://github.com/northwind/marketing/tree/abc'; m.membershipFile.url = 'https://github.com/northwind/marketing/blob/abc/oats-membership.yaml';
  });
  renderSetup(hosted, { status, selected: MARKETING, onSelect() {}, openExternal: url => opened.push(url) });
  hosted.querySelector('.setup-lede-where button.setup-file').click();
  hosted.querySelector('.setup-panel .setup-hand-sub button.setup-file[aria-label="Open oats-membership.yaml"]').click();
  hosted.querySelector('.setup-panel [data-verb=repo]').click();
  assert.deepEqual(opened, [status.workspace.file.url, status.members.find(x => x.key === MARKETING).membershipFile.url, 'https://github.com/northwind/marketing/tree/abc']);
});

test('This computer shows the lock file, disabled souls and each member clone; a package with a newer catalog version says so', () => {
  const root = host();
  const status = statusOf(r => {
    r.packages.find(p => p.id === 'oats.okf').latest = { version: '4.0.0', ref: 'v4.0.0' };
    Object.assign(r.clones.find(c => c.name === 'data'), { path: null, rule: null });
    Object.assign(r.clones.find(c => c.name === 'marketing'), { path: null, rule: null, problem: { code: 'E_CLONE_MISMATCH', message: 'marketing is not a clone of this member' } });
  });
  renderSetup(root, { status });
  const kv = local(root);
  assert.equal(kv['Lock file'].textContent, 'oats-lock.json', 'relative to the deployment folder');
  assert.equal(kv['Lock file'].title, `${DEPLOYMENT}/oats-lock.json · lockfile version 3`);
  assert.equal(kv['Disabled souls'].textContent, 'campaign-writer');
  const clones = Object.fromEntries([...root.querySelectorAll('[data-zone=here] dl[aria-label="Member clones"] .setup-clone')].map(r => [r.querySelector('dt').textContent, r.querySelector('dd')]));
  assert.deepEqual(Object.keys(clones), ['agents', 'platform', 'data', 'marketing', 'nw-tools']);
  assert.equal(clones.agents.textContent, 'agents-repo');
  assert.equal(clones.agents.title, `${DEPLOYMENT}/agents-repo · beside the deployment`);
  assert.equal(clones.data.textContent, 'not cloned here');
  assert.equal(clones.marketing.textContent, 'marketing is not a clone of this member', 'the refusal a spawn would meet, verbatim');
  assert.ok(clones.marketing.classList.contains('warn') && clones.marketing.classList.contains('wrap'), 'a refusal wraps, never cropped');
  const ends = Object.fromEntries([...root.querySelectorAll('[data-box=Packages] .setup-row')].map(r => [r.dataset.package, r.querySelector('.setup-end').textContent]));
  assert.deepEqual(ends, { 'nw.tools': 'locked', 'oats.framework': 'locked', 'oats.okf': '4.0.0 available' });
  renderSetup(root, { status, selected: MARKETING, onSelect() {} });
  assert.equal(root.querySelector('.setup-panel [data-clone] p').textContent, 'marketing is not a clone of this member');
});

test('an older kernel (no desktop facts) keeps the generic words and shows no clones, lock file or disabled souls', () => {
  const root = host();
  const status = statusOf(r => { delete r.workspace.file; for (const m of r.members) { delete m.url; delete m.membershipFile; } for (const p of r.packages) delete p.latest; for (const k of ['defaults', 'clones', 'disabledSouls', 'lock']) delete r[k]; });
  renderSetup(root, { status });
  assert.match(root.querySelector('.setup-lede-where').textContent, new RegExp(`'s workspace file at ${SHORT}\\.$`));
  assert.equal(root.querySelector('dl[aria-label="Member clones"]'), null);
  assert.deepEqual(Object.keys(local(root)).filter(k => ['Lock file', 'Disabled souls'].includes(k)), []);
  renderSetup(root, { status, selected: MARKETING, onSelect() {} });
  assert.deepEqual([...root.querySelectorAll('.setup-panel .setup-hand-sub')].map(s => s.textContent), ["in agents's workspace file", "The repo's membership file names this workspace"]);
  assert.equal(root.querySelector('.setup-panel [data-clone]'), null);
});

test('Defaults shows the workspace slots and default capabilities as declared; each team says what it adds or turns off', () => {
  const root = host();
  const status = statusOf(r => r.defaults.byTeam.engineering.capabilities.push({ name: 'nw-house-style', from: null, off: true }));
  renderSetup(root, { status });
  // Teams moved to the Workspace's own Teams tab (human, 2026-09-28): Setup no longer has the box.
  assert.deepEqual([...root.querySelectorAll('[data-zone=shared] .setup-box')].map(b => b.dataset.box), ['Members', 'Packages', 'Defaults']);
  assert.equal(root.querySelector('[data-zone=here] .setup-sec-title').textContent, 'This computer');
  root.append(teamsBox(root.ownerDocument, { status }));
  const rows = Object.fromEntries([...root.querySelectorAll('[data-box=Defaults] .setup-def')].map(r => [r.dataset.slot, r.querySelector('dd')]));
  assert.deepEqual(Object.keys(rows), ['knowledge', 'messaging', 'tasks', 'capabilities']);
  assert.equal(rows.knowledge.textContent, 'oats.okfpackage');
  assert.equal(rows.messaging.textContent, 'none'); assert.ok(rows.messaging.classList.contains('muted'));
  assert.deepEqual([...rows.capabilities.querySelectorAll('.setup-def-cap')].map(c => [c.dataset.capability, c.querySelector('.setup-def-from').textContent]),
    [['nw-house-style', 'agents'], ['oats.core', 'package']], 'a member key reads as the member name');
  const team = label => root.querySelector(`[data-team-defaults="${label}"]`);
  assert.equal(team('global'), null, 'a team that adds nothing says nothing');
  assert.deepEqual([...team('engineering').children].map(part => part.firstChild.textContent), ['adds ', 'turns off ']);
  const off = team('engineering').querySelector('.setup-def-cap.off');
  assert.equal(off.dataset.capability, 'nw-house-style'); assert.equal(off.querySelector('.setup-def-from'), null, '"turns off" already says it');
  assert.equal(team('marketing').textContent, 'adds nw-brand-voicemarketing');
});

test('Defaults: a null slot reads "not set"; a standalone deployment (no defaults) and an older kernel show no Defaults box', () => {
  const root = host();
  renderSetup(root, { status: statusOf(r => { r.defaults.slots.tasks = null; }) });
  assert.equal(root.querySelector('[data-box=Defaults] [data-slot=tasks] dd').textContent, 'not set');
  renderSetup(root, { status: statusOf(r => { r.defaults = { slots: { knowledge: null, messaging: null, tasks: null }, capabilities: [], byTeam: {} }; }) });
  assert.equal(root.querySelector('[data-box=Defaults]'), null, 'standalone: the workspace declares no defaults');
  renderSetup(root, { status: statusOf(r => { delete r.defaults; }) });
  assert.equal(root.querySelector('[data-box=Defaults]'), null); assert.equal(root.querySelector('[data-team-defaults]'), null);
});


// Setup redesign (2026-10-14): one column, the lede (name, summary, where it is declared), an overview of what
// the host defines with the membership mechanics folded under "For developers", then Shared through Git
// (Members, Packages, Defaults) above the This computer zone (facts, clones, Machines). File names only as the
// kernel reports them.
const AGENTS = 'local//fixture/base/fx/remotes/agents.git';
const STATES = { platform: 'not-listed', data: 'no-backlink', marketing: 'backlink-elsewhere', 'nw-tools': 'cannot-read' };
const everyState = r => { for (const m of r.members) if (STATES[m.name]) m.status = STATES[m.name]; };

test('Setup list: one column, the lede, the overview, Shared through Git above This computer; no sidebar and no legend', () => {
  const root = host();
  renderSetup(root, { status: statusOf(), instances: [{ running: true }, { running: false }, {}], cli: { version: '0.55.0' } });
  const setup = root.querySelector('.setup[data-view=list]');
  assert.deepEqual([...setup.children].map(c => c.className), ['setup-lede', 'setup-explain', 'setup-sec', 'setup-zone']);
  assert.deepEqual([...setup.querySelectorAll('.setup-sec-title')].map(h => [h.tagName, h.textContent]), [['H3', 'Shared through Git'], ['H3', 'This computer']]);
  assert.deepEqual([...setup.querySelectorAll('.setup-sec-lead')].map(p => p.textContent),
    ['What the workspace declares: the same on every computer that runs it.', "Not shared: this deployment's own settings and clones. The computers it runs on are under Machines."]);
  assert.equal(root.querySelector('.setup-cols, .setup-col, .setup-legend, .setup-header, .setup-scope'), null, 'the right column, the legend and the scope chips are gone');
  assert.deepEqual([...root.querySelectorAll('[data-zone=shared] .setup-box-head')].map(h => [h.firstChild.tagName, h.textContent]), [
    ['H4', 'MembersEach repository and whether both of its links are in place.'],
    ['H4', 'PackagesVersioned bundles, pinned here and fingerprinted in the lock.'],
    ['H4', 'DefaultsEvery soul starts from these.']]);
  // The facts of this computer, the same values and titles, Agents (DESKTOP_NOUNS) "N, M running".
  const kv = local(root);
  assert.deepEqual(Object.fromEntries(Object.entries(kv).map(([k, dd]) => [k, dd.textContent])), {
    Folder: DEPLOYMENT, Settings: 'oats-local.yaml', Lock: 'current', 'Lock file': 'oats-lock.json', CLI: 'oats 0.55.0', Agents: '3, 1 running', 'Disabled souls': 'campaign-writer' });
  assert.equal(kv.Settings.title, `${DEPLOYMENT}/oats-local.yaml`);
  assert.deepEqual(['Lock', 'CLI', 'Agents'].map(k => kv[k].className), ['prim', 'prim', 'prim'], 'primary facts');
  assert.deepEqual(['Folder', 'Settings', 'Lock file', 'Disabled souls'].map(k => kv[k].className), ['mono', 'mono', 'mono', 'mono']);
  assert.equal(root.querySelector('[data-zone=here] h4').textContent, 'Member clones');
  renderSetup(root, { status: statusOf(r => { r.unsynced = ['nw.chat']; }) });
  assert.equal(local(root).Lock.textContent, 'out of date · 1 not locked'); assert.equal(local(root).Lock.className, 'prim warn');
  assert.equal(local(root).Agents.textContent, 'none yet');
});

test('Setup lede: the summary counts members, those that need attention, packages and the lock, from workspace status', () => {
  const root = host();
  renderSetup(root, { status: statusOf() });
  const summary = () => root.querySelector('.setup-lede > .setup-summary');
  assert.equal(summary().textContent, '5 members; 3 packages; lock current.');
  assert.deepEqual([...summary().querySelectorAll('b')].map(b => [b.textContent, b.className]), [['5 members', ''], ['3 packages', ''], ['current', '']]);
  renderSetup(root, { status: statusOf(r => { everyState(r); r.unsynced = ['nw.chat']; }) });
  assert.equal(summary().textContent, '5 members, 4 need attention; 4 packages; lock out of date · 1 not locked.', 'the Packages box rows: locked and not locked yet');
  assert.deepEqual([...summary().querySelectorAll('b.warn')].map(b => b.textContent), ['4 need attention', 'out of date · 1 not locked']);
  renderSetup(root, { status: statusOf(r => { r.members[1].status = 'no-backlink'; r.packages.length = 1; r.members.length = 2; }) });
  assert.equal(summary().textContent, '2 members, 1 needs attention; 1 package; lock current.');
  assert.deepEqual([...root.querySelector('.setup-lede').children].map(c => c.className), ['', 'setup-summary', 'setup-lede-where'], 'the summary first');
});

test('Setup overview: the host defines the workspace; without a workspace key it says "the host repository"', () => {
  const root = host();
  renderSetup(root, { status: statusOf() });
  const explain = root.querySelector('.setup > section.setup-explain');
  assert.equal(explain.querySelector('h3').textContent, 'Overview');
  assert.equal(explain.querySelector('.setup-explain-ov').textContent, 'The host repository, agents, defines this OATS workspace: which repositories are its members and which packages it uses.');
  assert.equal(explain.querySelector('.setup-explain-ov b').textContent, 'agents', 'the host name the lede uses');
  const keyless = statusOf(); keyless.workspace = { ...keyless.workspace, key: null };
  renderSetup(root, { status: keyless });
  assert.equal(root.querySelector('.setup-explain-ov').textContent, 'The host repository defines this OATS workspace: which repositories are its members and which packages it uses.');
  assert.equal(root.querySelector('.setup-lede-where'), null, 'no key, no declaration line (as before)');
  // The list (its only view since the graph went): the lede, the overview, then the shared section and this computer.
  assert.deepEqual([...root.querySelector('.setup').children].map(c => c.className), ['setup-lede', 'setup-explain', 'setup-sec', 'setup-zone']);
});

test('Setup "For developers": closed by default, open across re-renders, the kernel\'s file names (generic words otherwise), an aria-hidden drawing', () => {
  const root = host();
  renderSetup(root, { status: statusOf() });
  const dev = () => root.querySelector('.setup-explain details.setup-explain-dev');
  assert.equal(dev().open, false, 'closed by default');
  assert.equal(dev().querySelector('summary').textContent, 'For developers: how a repository becomes a member');
  assert.equal(dev().querySelector('summary svg').getAttribute('aria-hidden'), 'true');
  assert.equal(dev().querySelector('.setup-explain-body > p').textContent,
    "The host's oats-workspace.yaml lists each member, and each member's oats-membership.yaml names the workspace back. A member counts only when both links are in place.");
  dev().open = true;
  renderSetup(root, { status: statusOf() });
  assert.equal(dev().open, true, 'a re-render keeps it open');
  renderSetup(root, { status: statusOf(), selected: MARKETING, onSelect() {} });
  assert.equal(dev().open, true, 'and so does a member panel opening');
  root.replaceChildren(); // another tab drawn in the same host
  renderSetup(root, { status: statusOf() });
  assert.equal(dev().open, true);
  dev().open = false; renderSetup(root, { status: statusOf() });
  assert.equal(dev().open, false);
  assert.equal(host().appendChild(renderSetup(host(), { status: statusOf() })).querySelector('details').open, false, 'another tab host starts closed');
  // The drawing: the host lists an example member (the first confirmed one that isn't the host), which names it back.
  const drawing = dev().querySelector('figure.setup-hs');
  assert.equal(drawing.getAttribute('aria-hidden'), 'true', 'the paragraph carries the facts');
  assert.deepEqual([...drawing.querySelectorAll('.setup-hs-repo')].map(b => b.textContent), ['Hostagentsmembers: platform', 'Memberplatformworkspace: agents']);
  assert.deepEqual([...drawing.querySelectorAll('.setup-hs-arrow')].map(a => a.textContent), ['lists', 'names back']);
  renderSetup(root, { status: statusOf(r => { r.members.find(m => m.name === 'platform').status = 'no-backlink'; }) });
  assert.match(dev().querySelector('.setup-hs-repo').textContent, /members: data$/, 'a confirmed member first');
  renderSetup(root, { status: statusOf(r => { for (const m of r.members) if (m.name !== 'agents') m.status = 'no-backlink'; }) });
  assert.match(dev().querySelector('.setup-hs-repo').textContent, /members: platform$/, 'else the first that is not the host');
  renderSetup(root, { status: statusOf(r => { r.members.length = 1; }) });
  assert.match(dev().querySelector('.setup-hs-repo').textContent, /members: a member repo$/, 'else generic words');
  // An older kernel: no file names, so the generic words, never a guessed name.
  renderSetup(root, { status: statusOf(r => { delete r.workspace.file; for (const m of r.members) delete m.membershipFile; }) });
  assert.equal(dev().querySelector('.setup-explain-body > p').textContent,
    "The host's workspace file lists each member, and each member's membership file names the workspace back. A member counts only when both links are in place.");
});

test('Setup "For developers": a press survives the tab clearing its host and repainting before the queued toggle event', async () => {
  const root = host(), status = statusOf();
  // As workspace-discovery.mjs paints: it clears its body, then renders into it.
  const paint = () => { root.replaceChildren(); renderSetup(root, { status }); return root.querySelector('details.setup-explain-dev'); };
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));
  paint().querySelector('summary').click();
  assert.equal(paint().open, true, 'a poll lands before the toggle event: still open');
  await flush();
  assert.equal(paint().open, true, "the superseded element's late event changes nothing");
  paint().querySelector('summary span').click(); // a press on the summary's words closes it the same way
  await flush();
  assert.equal(paint().open, false);
  await flush();
  assert.equal(paint().open, false);
});

test('Setup "For developers": each state chip matches the chip its member row shows, with what it means', () => {
  const root = host();
  renderSetup(root, { status: statusOf(everyState) });
  const chips = [...root.querySelectorAll('.setup-explain-states > div')].map(d => [d.querySelector('dt .setup-state').dataset.state, d.querySelector('dt').textContent, d.querySelector('dd').textContent]);
  assert.deepEqual(chips, [['not-listed', 'not listed', "the host's link is missing"], ['no-backlink', 'no backlink', "the repo's link is missing"],
    ['backlink-elsewhere', 'points elsewhere', 'names another workspace'], ['cannot-read', "can't read", "your Git access can't check"]]);
  for (const [state, label] of chips) {
    const row = root.querySelector(`[data-box=Members] .setup-row .setup-state[data-state="${state}"]`);
    assert.equal(row.textContent, label, `${state}: the row's chip says the same`);
    assert.equal(row.className, root.querySelector(`.setup-explain-states .setup-state[data-state="${state}"]`).className);
  }
});

test('Setup list: the host row alone carries the Host tag (with its file); no row says Member; one line per member, state as a check or a chip', () => {
  const root = host();
  // The host listed last: the view still puts it first, the others in the kernel's order.
  renderSetup(root, { status: statusOf(r => { r.members.push(r.members.shift()); r.members[1].status = 'no-backlink'; }) });
  assert.equal(root.querySelector('.setup-badge.member'), null, 'no Member badge anywhere');
  const rows = [...root.querySelectorAll('[data-box=Members] .setup-rows[data-rows=members] > .setup-row[data-member]')];
  assert.deepEqual(rows.map(r => r.querySelector('.setup-name-text').textContent), ['agents', 'platform', 'data', 'marketing', 'nw-tools'], 'host first');
  assert.deepEqual(rows.map(r => [...r.querySelectorAll('.setup-badge')].map(b => b.textContent)), [['Host·oats-workspace.yaml'], [], [], [], []]);
  assert.equal(rows[0].dataset.member, AGENTS); assert.equal(rows[0].querySelector('.setup-name-text').title, AGENTS, 'the key as title');
  assert.equal(rows[0].querySelector('.setup-badge.host button'), null, 'no web address: the file name is plain text');
  assert.deepEqual(rows.map(r => r.children.length), [4, 4, 4, 4, 4], 'name, state, contribution, Why? or an empty cell');
  const confirmed = rows[0].querySelector('.setup-state');
  assert.equal(confirmed.textContent, 'confirmed'); assert.ok(confirmed.querySelector('svg')); assert.equal(confirmed.className, 'setup-state');
  const data = rows.find(r => r.dataset.member.endsWith('data.git'));
  assert.equal(data.querySelector('.setup-state').textContent, 'no backlink', 'the warn chip says its label, without the ○ glyph');
  assert.equal(data.querySelector('.setup-state').className, 'setup-state warn');
  assert.equal(data.querySelector('button.setup-link-act').getAttribute('aria-label'), "data: why it hasn't joined the workspace");
  assert.deepEqual(rows.map(r => r.querySelector('.setup-cell').textContent), ['2 souls · 2 capabilities', '2 souls', '1 soul hidden until it joins', '2 souls · 2 capabilities', '1 soul · 1 capability']);
  // External souls: a sub-heading, then each soul with its source and team.
  const sub = root.querySelector('[data-box=Members] .setup-sub');
  assert.equal(sub.textContent, 'External soulslisted by the workspace from repositories that are not members');
  const ext = root.querySelector('[data-box=Members] .setup-row[data-external="security-reviewer"]');
  assert.deepEqual([...ext.children].map(c => c.textContent), ['security-reviewer', 'external soul', 'experts, unassigned', '']);
  // Packages: name and version, origin, what it provides, the end cell.
  const pkg = root.querySelector('[data-box=Packages] .setup-row[data-package="oats.okf"]');
  assert.equal(pkg.querySelector('.setup-name-text').textContent, 'oats.okf'); assert.equal(pkg.querySelector('.setup-version').textContent, '2.1.3');
  assert.equal(pkg.children[1].textContent, 'official catalog');
  assert.match(pkg.children[2].title, /\(official catalog\)$/, 'the origin stays in the provides cell\'s title when narrow rows hide its column');
  assert.ok(!pkg.children[2].textContent.includes(' · '), 'capabilities joined with ", "');
});

test('Setup list: the Host tag links its file when the kernel gives a web address; an older kernel keeps generic words', () => {
  const opened = [], root = host();
  const url = `https://github.com/northwind/agents/blob/${SHORT}/oats-workspace.yaml`;
  renderSetup(root, { status: statusOf(r => { r.workspace.file.url = url; }), openExternal: u => opened.push(u) });
  const link = root.querySelector('[data-box=Members] .setup-badge.host button.setup-file');
  assert.equal(link.textContent, 'oats-workspace.yaml'); assert.equal(link.getAttribute('aria-label'), 'Open oats-workspace.yaml');
  link.click(); assert.deepEqual(opened, [url]);
  const old = host();
  renderSetup(old, { status: statusOf(r => { delete r.workspace.file; for (const m of r.members) delete m.membershipFile; }) });
  assert.doesNotMatch(old.querySelector('.setup').textContent, /oats-workspace\.yaml|oats-membership\.yaml/, 'never a guessed file name');
  assert.deepEqual([...old.querySelectorAll('[data-box=Members] .setup-row')[0].querySelectorAll('.setup-badge')].map(b => b.textContent), ['Host']);
});

test('Setup list: hostile names and file paths render literally', () => {
  const root = host(), hostile = '<img src=x onerror=alert(1)>';
  renderSetup(root, { status: statusOf(r => { r.workspace.file.path = hostile; r.members[0].name = hostile; r.members[1].membershipFile.path = hostile; }) });
  assert.equal(root.querySelector('img'), null);
  assert.ok(root.querySelector('.setup-explain-body > p').textContent.includes(hostile));
  assert.ok(root.querySelector('.setup-explain-ov').textContent.includes(hostile));
  assert.equal(root.querySelector('[data-box=Members] .setup-row .setup-name-text').textContent, hostile);
});

test('Setup list: the machines are not Setup\'s any more (the Workspace\'s Machines tab); This computer points there', () => {
  const root = host();
  renderSetup(root, { status: statusOf(), machines: root.ownerDocument.createElement('section') });
  assert.equal(root.querySelector('section:not(.setup-sec):not(.setup-zone):not(.setup-box):not(.setup-explain)'), null, 'no machines box, whatever is passed');
  assert.equal(root.querySelector('[data-zone=here] .setup-sec-lead').textContent, "Not shared: this deployment's own settings and clones. The computers it runs on are under Machines.");
});

test('Setup list: one line per row at 860px and wider (a grid per box, subgrid rows); two lines in a narrower box', () => {
  const rule = selector => { const m = setupCSS.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`, 'm')); assert.ok(m, selector); return m[1]; };
  assert.match(rule('.setup-box'), /container:setup-rows \/ inline-size/, 'the rows follow their own box');
  assert.match(rule('.setup-rows[data-rows=members]'), /grid-template-columns:minmax\(0,1\.2fr\) 128px minmax\(0,1fr\) 44px/);
  assert.match(rule('.setup-rows[data-rows=packages]'), /grid-template-columns:minmax\(0,1\.1fr\) 120px minmax\(0,1\.2fr\) 112px/);
  assert.match(rule('.setup-row'), /grid-column:1 \/ -1; display:grid; grid-template-columns:subgrid;/);
  assert.match(rule('.setup-name-text'), /white-space:nowrap; overflow:hidden; text-overflow:ellipsis/, 'a long name gives way, on one line');
  assert.match(setupCSS, /@container setup-rows \(max-width: 859\.98px\) \{\n \.setup-rows\[data-rows\] \{ grid-template-columns:minmax\(0,1fr\) auto; \}/);
  assert.match(setupCSS, /\.setup-rows\[data-rows=packages\] \.setup-row > :nth-child\(2\) \{ display:none; \}/, 'narrow: the origin column hides');
});
