// Spec B: editing the spawn form never waits on the kernel. Previews read in the background
// (a newer choice starts its own read at once, only the latest ticket settles), the form stays
// interactive and the preview column keeps the last settled facts, marked Updating…, until the
// new ones land. A Spawn press before the preview for the choices on screen settled is kept as
// intent and continues on exactly that preview. Mounted in the real Workspace view, through the
// real preview boundary and apply broker (test/helpers/spawn-dialog-host.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountSpawn, settle, deferred, kernel } from './helpers/spawn-dialog-host.mjs';

/** A preview gate the test releases one read at a time, in any order. */
function gates() {
  const held = []; let on = false;
  return { held, hold() { on = true; }, open() { on = false; },
    gate: body => { if (!on) return undefined; const d = deferred(); held.push({ body, ...d }); return d.promise; } };
}
const input = (u, selector, value) => { const el = u.q(selector); el.value = value; el.dispatchEvent(new u.dom.window.Event('input', { bubbles: true })); return el; };
const facts = u => Object.fromEntries([...u.dialog().querySelectorAll('.spawn-preview-created dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent.trim()]));
const updating = u => u.q('.spawn-preview').getAttribute('aria-busy') === 'true' && !u.q('.spawn-preview-updating').hidden;
const formControls = u => [...u.dialog().querySelectorAll('.spawn-form :is(input, select, textarea, button)')]
  .map(el => ({ el, disabled: el.disabled, hidden: !!el.closest('[hidden]') }));
const created = name => kernel(name).result;

test('after the first settle, no field is disabled, hidden or rebuilt while a newer preview reads; focus and caret stay', async t => {
  const g = gates(); const u = await mountSpawn(t, { previewGate: g.gate });
  await u.open();
  assert.equal(u.q('.spawn-preview').closest('[hidden]'), null, 'the scoped preview column');
  const before = formControls(u);
  g.hold();
  const purpose = u.q('.fpurpose'); purpose.focus();
  input(u, '.fpurpose', 'api'); purpose.setSelectionRange(1, 2);
  await settle();
  assert.equal(g.held.length, 1, 'a read is in the air');
  assert.ok(updating(u)); assert.equal(u.q('.spawn-preview-skeleton'), null);
  const during = formControls(u);
  assert.equal(during.length, before.length, 'no control added or removed');
  during.forEach((c, i) => { assert.equal(c.el, before[i].el, 'the same element: not rebuilt'); assert.equal(c.disabled, before[i].disabled, c.el.className); assert.equal(c.hidden, before[i].hidden, c.el.className); });
  assert.equal(u.q('.fspawn').disabled, false, 'Spawn stays pressable while the preview reads');
  assert.equal(u.doc.activeElement, purpose); assert.deepEqual([purpose.selectionStart, purpose.selectionEnd], [1, 2]);
  // Other fields change while it reads: nothing waits.
  u.q('.spawn-seg input[value=child]').click(); u.q('.spawn-seg input[value=unrelated]').click();
  g.open(); for (const h of g.held) h.resolve(); await settle(20);
  formControls(u).forEach((c, i) => { assert.equal(c.el, before[i].el); assert.equal(c.disabled, before[i].disabled, c.el.className); });
  assert.equal(u.q('.spawn-preview').getAttribute('aria-busy'), 'false'); assert.equal(u.q('.spawn-preview-updating').hidden, true);
});

test('a newer choice starts its own read at once; only the latest settles, whichever answer lands first', async t => {
  for (const order of [[1, 0], [0, 1]]) {
    const g = gates(); const u = await mountSpawn(t, { previewGate: g.gate });
    await u.open(); g.hold();
    input(u, '.fpurpose', 'docs'); await settle();
    input(u, '.fpurpose', 'api-v2'); await settle();
    assert.deepEqual(g.held.map(h => h.body.choices.purpose), ['docs', 'api-v2'], 'the second read did not queue behind the first');
    assert.equal(facts(u).Name, 'release-manager-api-v2', 'the Name fact follows the form while both read');
    g.held[order[0]].resolve(); await settle(20);
    if (order[0] === 0) {
      assert.ok(updating(u), 'the superseded answer settles nothing'); assert.equal(facts(u).Name, 'release-manager-api-v2');
      assert.equal(u.text('.spawn-name-result strong'), 'release-manager-api-v2');
    } else assert.equal(updating(u), false, 'the latest settled');
    g.held[order[1]].resolve(); await settle(20);
    assert.equal(updating(u), false); assert.equal(facts(u).Name, created('preview-worktree-purpose').instance);
    assert.equal(u.text('.spawn-name-result strong'), created('preview-worktree-purpose').instance, 'never the superseded docs answer');
    assert.equal(u.text('.fstatus'), 'Preview ready');
  }
});

test('a failure for superseded choices is discarded; a failure for the choices on screen replaces the facts', async t => {
  const g = gates();
  const u = await mountSpawn(t, { previewGate: g.gate, previewName: (_soul, choices) => choices.purpose === 'broken' ? 'preview-clone-missing' : undefined });
  await u.open(); g.hold();
  input(u, '.fpurpose', 'broken'); await settle();
  input(u, '.fpurpose', 'api-v2'); await settle();
  g.held[0].resolve(); await settle(20);
  assert.equal(u.q('.spawn-preview-failure'), null, 'the stale refusal is never shown'); assert.equal(u.q('.fstatus').classList.contains('err'), false);
  assert.ok(updating(u)); assert.equal(facts(u).Name, 'release-manager-api-v2');
  g.held[1].resolve(); await settle(20);
  assert.equal(facts(u).Name, 'release-manager-api-v2'); assert.equal(u.text('.fstatus'), 'Preview ready');
  g.open(); input(u, '.fpurpose', 'broken'); await settle(20);
  assert.ok(u.q('.spawn-preview-failure'), 'a refusal for these choices replaces the facts');
  assert.equal(u.q('.fstatus').dataset.code, 'E_CLONE_MISSING'); assert.equal(u.q('.fspawn').disabled, true, 'a settled refusal cannot be spawned');
});

test('Spawn pressed while the preview reads is kept as intent: Checking…, then prepare and apply bind that preview', async t => {
  const g = gates(); const u = await mountSpawn(t, { previewGate: g.gate });
  await u.open(); g.hold();
  input(u, '.fpurpose', 'api-v2'); await settle();
  const spawn = u.q('.fspawn');
  assert.equal(spawn.disabled, false); spawn.click(); await settle();
  assert.equal(spawn.textContent, 'Checking…'); assert.equal(spawn.getAttribute('aria-busy'), 'true'); assert.equal(spawn.disabled, true);
  assert.equal(u.text('.fstatus'), 'Spawning…');
  assert.deepEqual(u.spawns(), [], 'nothing is prepared before the preview for these choices settled');
  g.open(); g.held[0].resolve(); await settle(30);
  assert.deepEqual(u.spawns().map(b => b.action), ['prepare', 'apply']);
  assert.deepEqual(u.spawns()[0].choices, { purpose: 'api-v2', model: { kind: 'inherit' }, relation: { kind: 'unrelated' } });
  assert.equal(u.applied.length, 1); assert.equal(u.applied[0].decision.revision, created('preview-worktree-purpose').decision.revision);
});

test('an edit while the press waits drops it: "Changed: press Start again", nothing spawns', async t => {
  for (const edit of [u => input(u, '.fpurpose', 'api-v3'), u => input(u, '.ftask', 'Cut 3.2'), u => { const r = u.q('.fruntime'); r.value = 'claude'; r.dispatchEvent(new u.dom.window.Event('change', { bubbles: true })); }]) {
    const g = gates(); const u = await mountSpawn(t, { previewGate: g.gate });
    await u.open(); g.hold();
    input(u, '.fpurpose', 'api-v2'); await settle();
    u.q('.fspawn').click(); await settle();
    assert.equal(u.q('.fspawn').textContent, 'Checking…');
    edit(u); await settle();
    assert.equal(u.text('.fstatus'), 'Changed: press Start again');
    assert.equal(u.q('.fspawn').textContent, 'Start'); assert.equal(u.q('.fspawn').getAttribute('aria-busy'), 'false');
    g.open(); for (const h of g.held) h.resolve(); await settle(30);
    assert.deepEqual(u.spawns(), [], 'the press belonged to the choices at press time');
  }
});

test('a pending press whose preview fails shows the failure, and the button returns to Spawn; nothing spawns', async t => {
  const g = gates();
  const u = await mountSpawn(t, { previewGate: g.gate, previewName: (_soul, choices) => choices.purpose === 'broken' ? 'preview-clone-missing' : undefined });
  await u.open(); g.hold();
  input(u, '.fpurpose', 'broken'); await settle();
  u.q('.fspawn').click(); await settle();
  assert.equal(u.q('.fspawn').textContent, 'Checking…');
  g.open(); g.held[0].resolve(); await settle(30);
  assert.equal(u.q('.fstatus').dataset.code, 'E_CLONE_MISSING'); assert.ok(u.q('.fstatus').classList.contains('err'));
  assert.equal(u.q('.fspawn').textContent, 'Start'); assert.equal(u.q('.fspawn').getAttribute('aria-busy'), 'false');
  assert.deepEqual(u.spawns(), []);
});

test('a pending press on a preview the world moved past (another spawn within the reuse window): prepare reads fresh and the drift flow shows the new values, nothing applied', async t => {
  const g = gates(); let n = 0;
  // The dialog's read answers the earlier observation; prepare's fresh read sees the next number.
  const u = await mountSpawn(t, { previewGate: g.gate, previewName: (_soul, choices) => choices.purpose ? (n++ === 0 ? 'preview-worktree-purpose' : 'preview-after-apply') : undefined });
  await u.open(); g.hold();
  input(u, '.fpurpose', 'api-v2'); await settle();
  u.q('.fspawn').click(); await settle();
  g.open(); g.held[0].resolve(); await settle(30);
  assert.deepEqual(u.spawns().map(b => b.action), ['prepare']); assert.equal(u.applied.length, 0);
  assert.match(u.text('.fstatus'), /changed since you last looked/);
  assert.equal(u.q('.spawn-name-result strong').textContent, 'release-manager-api-v2-2');
  assert.equal(u.q('.fspawn').textContent, 'Start'); assert.equal(u.q('.fspawn').disabled, false, 'another explicit Start applies the new values');
});

test('the busy budget: a read refused E_BUSY while this dialog\'s superseded reads hold both server slots retries as soon as one lands, never shown', async t => {
  const held = new Map();
  // Superseded choices whose kernel process is still running: the server's two-read budget is full.
  const u = await mountSpawn(t, { busyDelay: 60000, // no fallback timer here: only a landing read may retry
    kernel: async (_c, { choices }) => {
      if (['docs', 'race'].includes(choices.purpose)) { const d = deferred(); held.set(choices.purpose, d); await d.promise; }
      return kernel(choices.purpose === 'docs' ? 'preview-other' : choices.purpose === 'race' ? 'preview-race' : choices.purpose ? 'preview-worktree-purpose' : 'preview-worktree-default');
    } });
  await u.open();
  input(u, '.fpurpose', 'docs'); await settle();
  input(u, '.fpurpose', 'race'); await settle();
  input(u, '.fpurpose', 'api-v2'); await settle(20);
  assert.equal(held.size, 2); assert.equal(u.previews().length, 4, 'the latest read went out at once, and was refused busy');
  assert.ok(updating(u), 'still updating: the refusal is internal'); assert.equal(u.q('.fstatus').classList.contains('err'), false);
  assert.equal(u.q('.spawn-preview-failure'), null);
  held.get('docs').resolve(); await settle(30);
  assert.equal(u.previews().length, 5, 'retried when a superseded read landed');
  assert.equal(updating(u), false); assert.equal(facts(u).Name, 'release-manager-api-v2'); assert.equal(u.text('.fstatus'), 'Preview ready');
  held.get('race').resolve(); await settle(20);
  assert.equal(facts(u).Name, 'release-manager-api-v2', 'the superseded answer never shows');
});

// Review round 1.
const runPolls = async u => { for (const poll of u.polls) poll(); await settle(20); };
test('a read that cannot answer the pressed choices ends the press: it never spawns later on its own', async t => {
  const g = gates(); const u = await mountSpawn(t, { previewGate: g.gate });
  const CLI = structuredClone(u.ctx && (await u.ctx.api('/api/cli')));
  await u.open(); g.hold();
  input(u, '.fpurpose', 'api-v2'); await settle();
  u.q('.fspawn').click(); await settle();
  assert.equal(u.q('.fspawn').textContent, 'Checking…');
  // The CLI loses the preview under the waiting press: the read returns early (not previewable).
  await u.setCli({ ...CLI, spawnPreviewApi: null, features: CLI.features.filter(f => f !== 'spawn-preview-2') }); await runPolls(u);
  assert.equal(u.q('.fspawn').textContent, 'Start'); assert.equal(u.q('.fspawn').getAttribute('aria-busy'), 'false');
  assert.ok(u.q('.fstatus').classList.contains('err'), 'the failure shows');
  g.open(); for (const h of g.held) h.resolve(); await settle(20);
  await u.setCli(CLI); await runPolls(u);
  assert.deepEqual(u.spawns(), [], 'the press ended: no spawn without a new press');
  assert.equal(u.q('.fspawn').textContent, 'Start');
});

test('an invalid form reads nothing and the column says so: no Updating…, no aria-busy; before the first settle, why there is no preview', async t => {
  const g = gates(); const u = await mountSpawn(t, { previewGate: g.gate });
  await u.open(); const before = u.previews().length;
  input(u, '.fpurpose', 'a b'); await settle(20);
  assert.equal(u.previews().length, before);
  assert.equal(u.q('.spawn-preview').getAttribute('aria-busy'), 'false'); assert.equal(u.q('.spawn-preview-updating').hidden, true);
  assert.ok(u.q('.spawn-preview-facts'), 'the settled facts stay (never blanked)');
  const v = await mountSpawn(t, { previewGate: g.gate });
  g.hold(); await v.open();
  assert.ok(v.q('.spawn-preview-skeleton'), 'first read in the air');
  input(v, '.fpurpose', 'a b'); await settle();
  g.open(); for (const h of g.held) h.resolve(); await settle(20);
  assert.equal(v.q('.spawn-preview-skeleton'), null); assert.equal(v.q('.spawn-preview').getAttribute('aria-busy'), 'false');
  assert.equal(v.text('.spawn-preview-empty'), 'The preview reads once the form is valid.');
});

test('a failure for the choices on screen stays while a poll retries it: no flip to older facts, the footer keeps it', async t => {
  const g = gates();
  const u = await mountSpawn(t, { previewGate: g.gate, previewName: (_soul, choices) => choices.purpose === 'broken' ? 'preview-clone-missing' : undefined });
  await u.open();
  input(u, '.fpurpose', 'broken'); await settle(20);
  const said = u.text('.spawn-preview-failure'); assert.ok(said); assert.equal(u.q('.fstatus').dataset.code, 'E_CLONE_MISSING');
  g.hold(); await runPolls(u);
  assert.equal(g.held.length, 1, 'the poll retries the failed read');
  assert.equal(u.text('.spawn-preview-failure'), said, 'the failure stays'); assert.equal(u.q('.spawn-preview-facts'), null, 'never the previous choices\' facts');
  assert.equal(u.q('.fstatus').dataset.code, 'E_CLONE_MISSING', 'the footer keeps it while its retry reads');
  g.open(); g.held[0].resolve(); await settle(20);
  assert.equal(u.text('.spawn-preview-failure'), said);
});

test('"Reading defaults…" is the first read\'s only: after a first answer that is a refusal, edits do not say it', async t => {
  const g = gates(); const u = await mountSpawn(t, { previewGate: g.gate, previewName: () => 'preview-clone-missing' });
  await u.open(); assert.equal(u.q('.fstatus').dataset.code, 'E_CLONE_MISSING');
  g.hold(); input(u, '.fpurpose', 'x'); await settle();
  assert.equal(g.held.length, 1); assert.notEqual(u.text('.fstatus'), 'Reading defaults…');
  g.open(); g.held[0].resolve(); await settle(20);
});

test('another soul chosen while a press waits drops it', async t => {
  const g = gates(); const u = await mountSpawn(t, { previewGate: g.gate });
  await u.open(); g.hold();
  input(u, '.fpurpose', 'api-v2'); await settle();
  u.q('.fspawn').click(); await settle();
  assert.equal(u.q('.fspawn').textContent, 'Checking…');
  // Opening the Soul field and choosing another soul reopens the form on it: the held press goes with the old one.
  u.q('.spawn-soul-current').click(); u.q('.spawn-soul-option[data-agent="support-triager"]').click(); await settle();
  assert.equal(u.text('.spawn-soul-current strong'), 'support-triager'); assert.equal(u.q('.fspawn').textContent, 'Start');
  g.open(); for (const h of g.held) h.resolve(); await settle(30);
  assert.deepEqual(u.spawns(), []);
});
