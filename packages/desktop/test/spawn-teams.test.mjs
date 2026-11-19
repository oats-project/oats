// F7 Part C: the spawn dialog's Teams row (teams contract; kernel #179). The
// workspace's default team is fixed; the soul's mapped teams are unchecked checkboxes;
// unmapped ones are greyed with the reason. The choice travels as
// `--provider <cap> join=<a,b>` and must come back bound (settings echo).
// Offered only when the provider DECLARES the spawn setting `join` — the
// kernel binds join= for any provider, so without the declared fact the row
// would promise joins an older provider ignores (captured: preview-no-join-sent).
// Kernel captures: test/fixtures/workspace-v2/f7 from main (#181's `declares`,
// feature settings-declared; contract bdd7e55e), with the stand-in providers
// oats.aweb (real, declares ["join"]) and the stand-in nw.chat (declares ["identity"]) — provenance `provider`, `standIn`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { previewChoices, previewData, choiceArgv } from '../../client/spawn-preview-contract.mjs';
import { mountSpawn, settle } from './helpers/spawn-dialog-host.mjs';
import { cli as CLI, target } from './helpers/spawn-preview-fixture.mjs';

const f7 = name => JSON.parse(readFileSync(new URL(`./fixtures/workspace-v2/f7/${name}.json`, import.meta.url), 'utf8'));
const provenance = f7('provenance');
const JOIN = { provider: 'oats.aweb', labels: ['engineering'] };
/** As captured: the kernel's messaging row declares `join` (oats.aweb). */
const declared = envelope => structuredClone(envelope);
/** A kernel before #181: no `declares` on the rows. */
const undeclared = envelope => { const v = structuredClone(envelope); for (const m of v.result.modules) delete m.declares; return v; };
const previewFor = choices => choices.join ? 'preview-teams-join' : 'preview-teams-default';
const argvOf = name => { const a = provenance.files[name].argv; return a.slice(a.indexOf('--purpose'), a.indexOf(name.startsWith('apply') ? '--expect-decision' : '--preview')); };

const DECLARED_CLI = () => ({ ...structuredClone(CLI), features: [...CLI.features, 'settings-declared'] });
async function dialog(t, { kernel = choices => declared(f7(previewFor(choices))), cli = DECLARED_CLI(), ...options } = {}) {
  const u = await mountSpawn(t, { kernel: (_c, { choices }) => kernel(choices), cli, ...options });
  await u.open(); await u.type('.fpurpose', 'teams'); await settle();
  return u;
}
const rows = u => [...u.dialog().querySelectorAll('.spawn-team')].map(r => {
  const box = r.querySelector('input');
  return [r.querySelector('.spawn-team-name').textContent, r.title, box.checked, box.disabled];
});

test('join choices: the mapped labels to join, as the provider spawn setting; anything else is refused', () => {
  assert.deepEqual(previewChoices({ join: JOIN }).join, JOIN);
  assert.deepEqual(previewChoices({ join: { provider: 'oats.aweb', labels: ['engineering', 'global'] } }).join.labels, ['engineering', 'global']);
  for (const bad of [{ provider: 'oats.aweb', labels: [] }, { provider: 'oats.aweb', labels: ['a', 'a'] }, { provider: 'oats.aweb', labels: ['a,b'] },
    { provider: 'oats.aweb', labels: ['-x'] }, { provider: '--dir', labels: ['a'] }, { provider: 'oats.aweb' }, { provider: 'oats.aweb', labels: ['a'], extra: 1 },
    { provider: 'oats.aweb', labels: Array.from({ length: 17 }, (_, i) => `t${i}`) }, ['engineering'], 'engineering', null])
    assert.equal(previewChoices({ join: bad }), null, JSON.stringify(bad));
});

test('the flags are the captured kernel argv: --provider <cap> join=<a,b>, the same for preview and apply', () => {
  assert.deepEqual(choiceArgv(previewChoices({ purpose: 'teams', join: JOIN })), argvOf('preview-teams-join'));
  assert.deepEqual(choiceArgv(previewChoices({ purpose: 'teams', join: JOIN })), argvOf('apply-teams-join'));
  assert.deepEqual(choiceArgv(previewChoices({ purpose: 'teams' })), argvOf('preview-teams-default'), 'nothing chosen, nothing sent');
});

test('the projection carries the kernel\'s teams (primary first, no payloads), the bound join, and the declared fact', () => {
  const t = { ...target, selector: { ...target.selector } };
  const d = previewData(declared(f7('preview-teams-default')).result, t);
  assert.deepEqual(d.teams, [{ label: 'engineering', team: 'northwind:eng', mapped: true }, { label: 'global', team: null, mapped: false }]);
  assert.equal(d.messaging.provider, 'oats.aweb'); assert.equal(d.messaging.join, null); assert.equal(d.messaging.joinDeclared, true);
  assert.equal(previewData(declared(f7('preview-teams-join')).result, t).messaging.join, 'engineering');
  assert.deepEqual(f7('preview-teams-default').result.modules.find(m => m.layer === 'messaging').declares, ['delivery', 'identity', 'join', 'residents', 'root', 'roots', 'team'], 'the kernel\'s declared fact (#181): the real oats.aweb 1.16.0 settings, join among them');
  assert.equal(previewData(undeclared(f7('preview-teams-default')).result, t).messaging.joinDeclared, false, 'a kernel before #181 declares nothing');
  const chat = previewData(f7('preview-teams-no-join').result, t);
  assert.equal(chat.messaging.provider, 'nw.chat'); assert.equal(chat.messaging.joinDeclared, false);
  // The captured hazard: an undeclared provider still gets join= bound.
  assert.equal(previewData(f7('preview-no-join-sent').result, t).messaging.join, 'engineering');
  const once = previewData(declared(f7('preview-teams-join')).result, t);
  assert.deepEqual(previewData(once, t), once, "the renderer's re-validation of the server projection keeps it");
  for (const [label, mutate] of [
    ['bound and shown join disagree', v => { v.settings['oats.aweb'].join = 'global'; }],
    ['mapped without a team', v => { v.teams[0].team = null; }], ['unmapped with a team', v => { v.teams[1].team = 'x:y'; }],
    ['duplicate labels', v => { v.teams[1].label = 'engineering'; }], ['teams not a list', v => { v.teams = {}; }],
  ]) { const v = declared(f7('preview-teams-join')).result; mutate(v); assert.equal(previewData(v, t), null, label); }
  const older = f7('preview-teams-default').result; delete older.teams;
  assert.equal(previewData(older, t).teams, null, 'a kernel before #179 reports no teams');
});

test('the main form shows the Teams row — one line like Relationship: the default team fixed, the teams the soul has access to unchecked, unmapped not shown', async t => {
  const u = await dialog(t);
  const field = u.q('.spawn-teams');
  assert.equal(field.hidden, false); assert.equal(field.tagName, 'FIELDSET');
  assert.equal(field.closest('.spawn-advanced'), null, 'the main form, not Developer settings');
  assert.equal(field.querySelector('legend').firstChild.textContent, 'Teams', 'its jump chord is a separate, aria-hidden hint (Spec E)');
  assert.equal(u.text('.spawn-teams-hint'), "By default it's only in the workspace's default team. These are the teams release-manager has access to — tick the ones it should also join.");
  assert.deepEqual(rows(u), [['Default', "The workspace's default team — always. Every instance is in it.", true, true],
    ['engineering', 'Join engineering (northwind:eng)', false, false]], 'global is not mapped: not shown');
  const row = u.q('.spawn-teams-row');
  assert.ok(row.classList.contains('spawn-seg'), 'the Relationship segmented control, as toggles');
  assert.equal(row.querySelectorAll('.spawn-team').length, 2); assert.equal(row.parentElement, field);
  assert.ok(u.previews().every(p => !Object.hasOwn(p.choices, 'join')), 'by default nothing is sent');
  assert.equal(u.q('.fspawn').disabled, false);
});

test('Spec E: Mod+5 jumps to the first team one can tick; every opt-in box says its aria-keyshortcuts', async t => {
  const u = await dialog(t);
  const box = u.q('.fteam[value="engineering"]');
  assert.equal(box.getAttribute('aria-keyshortcuts'), 'Control+5');
  assert.equal(u.q('.spawn-teams legend kbd.spawn-key-hint').textContent, 'Ctrl+5');
  assert.equal(u.q('.spawn-teams legend kbd.spawn-key-hint').getAttribute('aria-hidden'), 'true');
  u.q('.ftask').focus();
  const e = new u.dom.window.KeyboardEvent('keydown', { key: '5', ctrlKey: true, bubbles: true, cancelable: true });
  u.q('.ftask').dispatchEvent(e);
  assert.equal(e.defaultPrevented, true); assert.equal(u.doc.activeElement, box, 'not the fixed default (it cannot be ticked)');
  await u.change('.fteam[value="engineering"]', true); await settle();
  assert.equal(u.q('.fteam[value="engineering"]').getAttribute('aria-keyshortcuts'), 'Control+5', 'kept across the redraw');
});

test('ticking a team previews it, the kernel binds it, and the apply sends it by value', async t => {
  const applied = [];
  const u = await dialog(t, { apply: args => { applied.push(args); return { started: true, envelope: f7('apply-teams-join') }; } });
  await u.change('.fteam[value="engineering"]', true); await settle();
  assert.deepEqual(u.previews().at(-1).choices.join, JOIN);
  assert.equal(u.q('.fteam[value="engineering"]').checked, true, 'the tick survives the re-render');
  assert.equal(u.text('.spawn-teams-error'), '');
  assert.equal(u.q('.fspawn').disabled, false);
  await u.spawn(); await settle();
  assert.deepEqual(u.spawns()[0].choices.join, JOIN);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].decision.revision, f7('preview-teams-join').result.decision.revision, 'bound to the decision that carries the join');
  assert.deepEqual(choiceArgv(applied[0].choices), argvOf('apply-teams-join'));
  assert.match(u.text('.fstatus'), /^Created release-manager-teams/);
  // untick: nothing is sent again
  const v = await dialog(t);
  await v.change('.fteam[value="engineering"]', true); await v.change('.fteam[value="engineering"]', false); await settle();
  assert.equal(Object.hasOwn(v.previews().at(-1).choices, 'join'), false);
});

test('a preview that does not bind the ticked teams keeps Spawn off and says so', async t => {
  const u = await dialog(t, { kernel: () => declared(f7('preview-teams-default')) });
  await u.change('.fteam[value="engineering"]', true); await settle();
  assert.deepEqual(u.previews().at(-1).choices.join, JOIN);
  assert.equal(u.text('.spawn-teams-error'), "The kernel didn't bind the ticked teams. Spawn waits until it does.");
  assert.equal(u.q('.fspawn').disabled, true);
});

test('no row without the declared fact (a kernel before #181), for a provider that does not declare join, without spawn-provider-payload, or without settings-declared', async t => {
  const a = await dialog(t, { kernel: choices => undeclared(f7(previewFor(choices))) });
  assert.equal(a.q('.spawn-teams').hidden, true);
  const b = await dialog(t, { kernel: () => f7('preview-teams-no-join') });
  assert.equal(b.q('.spawn-teams').hidden, true);
  const c = await dialog(t, { cli: { ...DECLARED_CLI(), features: DECLARED_CLI().features.filter(f => f !== 'spawn-provider-payload') } });
  assert.equal(c.q('.spawn-teams').hidden, true);
  const d = await dialog(t, { cli: structuredClone(CLI) }); // declares present, but the CLI does not advertise settings-declared
  assert.equal(d.q('.spawn-teams').hidden, true);
  for (const u of [a, b, c, d]) assert.ok(u.previews().every(p => !Object.hasOwn(p.choices, 'join')));
});

test('a soul whose preview reports no teams shows no row, even with the declared fact', async t => {
  const u = await dialog(t, { kernel: choices => { const v = declared(f7(previewFor(choices))); v.result.teams = []; return v; } });
  assert.equal(u.q('.spawn-teams').hidden, true);
});

test('when the kernel\'s list changes under a tick, the redrawn row keeps it', async t => {
  let extra = false;
  const u = await dialog(t, { kernel: choices => {
    const v = declared(f7(previewFor(choices)));
    if (extra) v.result.teams.push({ label: 'platform', team: 'northwind:platform', mapped: true, payload: {} });
    return v;
  } });
  await u.change('.fteam[value="engineering"]', true); await settle();
  extra = true; await u.type('.fpurpose', 'teams'); await settle();
  assert.deepEqual(rows(u).map(r => r[0]), ['Default', 'engineering', 'platform'], 'redrawn from the kernel\'s new list');
  assert.equal(u.q('.fteam[value="engineering"]').checked, true);
  assert.equal(u.q('.fteam[value="platform"]').checked, false);
});

test('a soul with no team it has access to (all unmapped) shows no row: there is nothing to choose', async t => {
  const u = await dialog(t, { kernel: choices => { const v = declared(f7(previewFor(choices))); v.result.teams = v.result.teams.map(x => ({ ...x, mapped: false, team: null })); return v; } });
  assert.equal(u.q('.spawn-teams').hidden, true);
  assert.ok(u.previews().every(p => !Object.hasOwn(p.choices, 'join')));
});

// Team model v2 (0.30, D2): the preview's rows are K1's TeamRow {label, team, default, from}
// (docs/desktop-cli-api.md "Team model v2", feat/030-team-model 8dd82158), shown here on the
// captured preview with K1's example rows until the 0.30 captures exist: the default first
// (fixed), then the others by label (unchecked boxes); a shared team with no id is shown, disabled.
const V2_ROWS = [{ label: 'builder-oats', team: 'builder-oats:alex.aweb.ai', default: true, from: 'local' },
  { label: 'oats', team: 'oats:oats.aweb.ai', default: false, from: 'shared' }, { label: 'reviewers', team: null, default: false, from: 'shared' }];
const v2 = (envelope, join = null) => {
  const v = declared(envelope); v.result.teams = structuredClone(V2_ROWS);
  v.result.defaultTeam = { label: 'builder-oats', team: 'builder-oats:alex.aweb.ai', from: 'deployment' };
  delete v.result.team;
  // The bound join (decision.effective.providers) and its settings echo move together, as the kernel sends them.
  for (const at of [v.result.settings?.['oats.aweb'], v.result.decision?.effective?.providers?.['oats.aweb']]) if (at) { if (join) at.join = join; else delete at.join; }
  return v;
};

test('v2: the default team is fixed by its name, each other team is an unchecked opt-in, a team with no id is shown disabled; no "primary"', async t => {
  const u = await dialog(t, { kernel: choices => v2(f7(previewFor(choices)), choices.join ? choices.join.labels.join(',') : null) });
  assert.equal(u.q('.spawn-teams').hidden, false);
  assert.deepEqual(rows(u), [
    ['builder-oats · default', "The default team (builder-oats:alex.aweb.ai): every instance of release-manager is in it and can't leave it.", true, true],
    ['oats', 'Join oats (oats:oats.aweb.ai)', false, false],
    ['reviewers', 'reviewers has no provider id yet: its owner runs oats aweb setup, then commits the id.', false, true]]);
  assert.equal(u.text('.spawn-teams-hint'), 'It joins its default team, builder-oats. Tick any other team it should also join.');
  assert.doesNotMatch(u.q('.spawn-teams').textContent, /primary|personal/i);
  assert.equal(u.q('.fteam[value="builder-oats"]'), null, 'the default is never a choice, so never sent');
  assert.ok(u.previews().every(p => !Object.hasOwn(p.choices, 'join')), 'unchecked by default: only the default team is joined');
  await u.change('.fteam[value="oats"]', true); await settle();
  assert.deepEqual(u.previews().at(-1).choices.join, { provider: 'oats.aweb', labels: ['oats'] }, 'the ticked team goes as join=oats');
  assert.equal(u.text('.spawn-teams-error'), ''); assert.equal(u.q('.fspawn').disabled, false);
});

test('v2: a soul with only its default team shows it, with nothing to tick', async t => {
  const only = envelope => { const v = v2(envelope); v.result.teams = [structuredClone(V2_ROWS[0])]; return v; };
  const u = await dialog(t, { kernel: choices => only(f7(previewFor(choices))) });
  assert.deepEqual(rows(u).map(r => r[0]), ['builder-oats · default']);
  assert.equal(u.text('.spawn-teams-hint'), 'It joins its default team, builder-oats. No other team is open to release-manager on this computer.');
});

test('v2: an unmapped default team blocks the spawn: the dialog says why and what to do, and Spawn is off (the lead\'s ruling)', async t => {
  const blocked = envelope => { const v = v2(envelope); v.result.teams[0].team = null; v.result.defaultTeam.team = null; return v; };
  const u = await dialog(t, { kernel: choices => blocked(f7(previewFor(choices))) });
  const home = u.q('.spawn-team[data-team="builder-oats"]');
  assert.ok(home.classList.contains('spawn-team-blocked')); assert.equal(home.title, 'The default team builder-oats has no provider id yet.');
  assert.equal(u.text('.spawn-teams-hint'), "The default team builder-oats has no provider id yet, so release-manager can't be spawned here. Its owner runs oats aweb setup, then commits the id; or choose another default in Workspace › Teams.");
  assert.ok(u.q('.spawn-teams-hint').classList.contains('err'));
  assert.equal(u.q('.fspawn').disabled, true, 'nothing to spawn into');
  assert.doesNotMatch(u.q('.spawn-teams').textContent, /Always on|primary|personal/i);
});

// The REAL 0.30 kernel (K1, feat/030-team-model @bba0a9b8; test/fixtures/team-model-v2, #269):
// release-manager's own default team, engineering, has no provider id yet, so its spawn is refused.
const v2cap = name => JSON.parse(readFileSync(new URL(`./fixtures/team-model-v2/${name}.json`, import.meta.url), 'utf8'));
test('real 0.30 preview: the soul\'s own default (engineering) has no provider id yet: the dialog says so, and Spawn is off', async t => {
  const u = await dialog(t, { kernel: () => v2cap('preview') });
  const preview = v2cap('preview').result;
  assert.deepEqual(preview.defaultTeam, { label: 'engineering', team: null, from: 'soul' }, 'the capture');
  assert.equal(u.q('.spawn-teams').hidden, false, 'shown although no provider declares join here: a disabled Spawn is never unexplained');
  assert.deepEqual(rows(u), [['engineering · default', 'The default team engineering has no provider id yet.', true, true]], 'the default only: no opt-ins while blocked');
  assert.equal(u.text('.spawn-teams-hint'), "The default team engineering has no provider id yet, so release-manager can't be spawned here. Its owner runs oats aweb setup, then commits the id; or choose another default for release-manager on its page (Teams here).");
  assert.equal(u.q('.fspawn').disabled, true);
});

test('Spec B: while a newer preview reads, the Teams and identity rows keep their settled content; a pending press never continues on a preview that did not bind the ticked teams', async t => {
  const { deferred } = await import('./helpers/spawn-preview-fixture.mjs');
  let gate = null;
  const u = await dialog(t, { kernel: () => declared(f7('preview-teams-default')), previewGate: () => gate?.promise });
  const settledRows = rows(u), list = u.q('.spawn-team-list');
  assert.equal(u.q('.spawn-teams').hidden, false); assert.equal(u.q('.spawn-identity').hidden, false);
  gate = deferred();
  const box = u.q('.fteam[value="engineering"]'); box.focus();
  box.checked = true; box.dispatchEvent(new u.dom.window.Event('change', { bubbles: true })); await settle();
  assert.deepEqual(u.previews().at(-1).choices.join, JOIN, 'a read for the ticked team is in the air');
  assert.equal(u.q('.spawn-teams').hidden, false, 'the row never vanishes while it reads'); assert.equal(u.q('.spawn-identity').hidden, false);
  assert.deepEqual(rows(u).map(r => r[0]), settledRows.map(r => r[0])); assert.equal(u.q('.spawn-team-list'), list);
  assert.equal(u.doc.activeElement, box, 'focus stays on the ticked team');
  u.q('.fspawn').click(); await settle();
  assert.equal(u.q('.fspawn').textContent, 'Checking…');
  gate.resolve(); gate = null; await settle(30);
  assert.deepEqual(u.spawns(), [], 'the preview did not bind engineering: the press waits for one that does, so nothing is prepared');
  assert.equal(u.text('.spawn-teams-error'), "The kernel didn't bind the ticked teams. Spawn waits until it does.");
  assert.equal(u.q('.fspawn').textContent, 'Spawn'); assert.equal(u.q('.fspawn').disabled, true);
});
