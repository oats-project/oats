// Spec F, Parts 1 and 2, and slice 5 (the New agent form): a soul's open lands on the form's Task, the soul list
// opens first from Quick Open's key, and the form works from the keyboard — Enter in Task and Mod+Enter from any
// field, Tab in visual order, roving segmented controls, pickers that close first on Escape, and a soul combobox.
// Mounted in the real Workspace view with the kernel captures (helpers/spawn-dialog-host.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountSpawn, settle, catalogAgents, ROOT } from './helpers/spawn-dialog-host.mjs';
import * as spawn from '../renderer/views/spawn.mjs';
import { pinPlatform } from './helpers/platform.mjs';

const key = (u, target, k, fields = {}) => {
  const event = new u.dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...fields });
  target.dispatchEvent(event); return event;
};
const asMac = u => Object.defineProperty(u.dom.window.navigator, 'platform', { value: 'MacIntel', configurable: true });
const card = (u, name) => [...u.doc.querySelectorAll('.soul-card')].find(c => c.dataset.agent === name);
/** Where the form lands when it opens on a soul: Task. */
const firstField = u => u.q('.ftask');
/** Tab stops in DOM order (what Tab walks): enabled, tabIndex >= 0, not hidden, not in a closed <details>. */
function tabStops(u) {
  const dialog = u.dialog(), view = u.dom.window;
  return [...dialog.querySelectorAll('button, input, select, textarea, summary')].filter(el => {
    if (el.disabled || el.tabIndex < 0) return false;
    for (let n = el; n && n !== dialog.parentElement; n = n.parentElement) {
      if (n.hidden || view.getComputedStyle(n).display === 'none') return false;
      if (n.tagName === 'DETAILS' && !n.open && el !== n.querySelector('summary')) return false;
    }
    return true;
  });
}
const label = el => el.classList.contains('fpurpose') ? 'Name'
  : el.closest('.fharness') ? `Harness:${el.value}` : el.classList.contains('fmodel') ? 'Model'
  : el.matches('.spawn-model-controls .spawn-choice-trigger') ? 'Model choices' : el.closest('.spawn-team-list') ? `Team:${el.value || 'default'}`
  : el.classList.contains('ftask') ? 'Task' : el.matches('.spawn-advanced > summary') ? 'Advanced'
  : el.classList.contains('fcancel') ? 'Cancel' : el.classList.contains('fspawn') ? 'Start'
  : el.classList.contains('spawn-soul-current') ? 'Soul' : el.classList.contains('spawn-soul-search') ? 'Soul list' : el.classList.contains('close-act') ? 'Close'
  : el.classList.contains('spawn-details-toggle') ? 'Details' : el.className;

// ── Part 1: opening the form ─────────────────────────────────────────────

test('opened on a soul (a card, the palette, Quick Open\'s pick): the New agent form on that soul, focus on Task', async t => {
  const u = await mountSpawn(t);
  spawn.preselectSpawn({ name: 'release-manager', agentsRoot: ROOT, onDismiss: () => true }); await settle();
  const dialog = u.dialog(); assert.ok(dialog, 'the form is open');
  assert.equal(u.text('h2#spawn-dialog-title'), 'New agent');
  assert.equal(u.text('.spawn-soul-current strong'), 'release-manager');
  assert.equal(u.doc.activeElement, firstField(u), 'focus lands on Task');
  assert.equal(u.doc.querySelector('.workspace-soul-page').hidden, true, 'no soul page on the way');
});

test('dismissing the form returns to where the operator was; if that is gone, the form restores focus itself', async t => {
  const u = await mountSpawn(t);
  const returns = [];
  spawn.preselectSpawn({ name: 'release-manager', agentsRoot: ROOT, onDismiss: () => { returns.push('back'); return true; } }); await settle();
  key(u, u.q('.fpurpose'), 'Escape'); await settle();
  assert.equal(u.dialog(), null); assert.deepEqual(returns, ['back']);
  assert.notEqual(u.doc.activeElement, card(u, 'release-manager'), 'not to the card: the shell returned focus');
  // The operator moved on (the shell refuses the return): the form's own restore, the soul's card.
  spawn.preselectSpawn({ name: 'release-manager', agentsRoot: ROOT, onDismiss: () => false }); await settle();
  u.q('.fcancel').click(); await settle();
  assert.equal(u.doc.activeElement, card(u, 'release-manager'));
  // A successful spawn is not a dismissal: the return never runs.
});

test('the soul list first (Quick Open\'s key): typing filters, Enter picks and moves to Task; Escape closes the sheet and returns', async t => {
  const u = await mountSpawn(t);
  const returns = [];
  spawn.preselectSpawn({ soulFirst: true, onDismiss: () => { returns.push('back'); return true; } }); await settle();
  assert.equal(u.dialog().dataset.step, 'soul'); assert.equal(u.text('h2#spawn-dialog-title'), 'New agent');
  const search = u.q('.spawn-soul-search');
  assert.equal(u.doc.activeElement, search); assert.equal(u.q('.fspawn').disabled, true, 'nothing to start before a soul');
  await u.type('.ftask', 'typed ahead'); search.focus();
  search.value = 'triager'; search.dispatchEvent(new u.dom.window.Event('input', { bubbles: true }));
  assert.equal(u.q('.spawn-soul-option').dataset.agent, 'support-triager', 'the best match first (Quick Open\'s matcher)');
  key(u, search, 'Enter'); await settle();
  assert.equal(u.text('.spawn-soul-current strong'), 'support-triager');
  assert.equal(u.doc.activeElement, firstField(u)); assert.equal(u.q('.ftask').value, 'typed ahead', 'what was typed goes with the pick');
  key(u, u.q('.ftask'), 'Escape'); await settle();
  assert.equal(u.dialog(), null); assert.deepEqual(returns, ['back'], 'the return target survives the pick');
  // With no soul chosen, Escape in the list is the sheet's.
  spawn.preselectSpawn({ soulFirst: true, onDismiss: () => { returns.push('again'); return true; } }); await settle();
  key(u, u.q('.spawn-soul-search'), 'Escape'); await settle();
  assert.equal(u.dialog(), null); assert.deepEqual(returns, ['back', 'again']);
});

test('the Soul field: typing on the chosen soul opens its filter; ↑↓ pass over a soul that can\'t be started; Enter picks, nothing typed is lost', async t => {
  const agents = [...catalogAgents(), { ...catalogAgents()[0], name: 'attached-helper', work: 'attached' }];
  const u = await mountSpawn(t, { agents });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  const current = u.q('.spawn-soul-current'); current.focus();
  key(u, current, 'a'); // typing on the chosen soul goes to the list's filter
  const search = u.q('.spawn-soul-search');
  assert.equal(u.doc.activeElement, search); assert.equal(search.value, 'a');
  search.value = 'attached-helper'; search.dispatchEvent(new u.dom.window.Event('input', { bubbles: true }));
  const attached = u.q('.spawn-soul-option[data-agent="attached-helper"]');
  assert.equal(attached.getAttribute('aria-disabled'), 'true'); assert.match(attached.textContent, /Attached only/);
  key(u, search, 'Enter'); await settle();
  assert.equal(u.q('.spawn-soul-search').hidden, false, 'an attached soul is never picked');
  search.value = ''; search.dispatchEvent(new u.dom.window.Event('input', { bubbles: true }));
  const active = () => u.doc.getElementById(search.getAttribute('aria-activedescendant'))?.dataset.agent;
  for (let i = 0; i < agents.length + 2; i++) { key(u, search, 'ArrowDown'); assert.notEqual(active(), 'attached-helper'); }
  key(u, search, 'ArrowUp'); const picked = active();
  key(u, search, 'Enter'); await settle();
  assert.equal(u.text('.spawn-soul-current strong'), picked);
  assert.equal(u.doc.activeElement, firstField(u)); assert.equal(u.q('.fpurpose').value, 'api-v2', 'nothing typed is lost');
});

test('an attached-only soul goes to its page (which explains why), never the dialog', async t => {
  const agents = [...catalogAgents(), { ...catalogAgents()[0], name: 'attached-helper', work: 'attached' }];
  const u = await mountSpawn(t, { agents });
  spawn.preselectSpawn({ name: 'attached-helper', agentsRoot: ROOT, onDismiss: () => assert.fail('no dialog to dismiss') }); await settle();
  assert.equal(u.dialog(), null);
  const page = u.doc.querySelector('.workspace-soul-page');
  assert.equal(page.hidden, false); assert.match(page.querySelector('.inspector-head h2').textContent, /attached-helper/);
});

// ── Part 2: the dialog from the keyboard ─────────────────────────────────

for (const platform of ['mac', 'other']) {
  test(`Mod+Enter starts it from the name field and from a segmented control (${platform})`, async t => {
    for (const from of ['.fpurpose', '.fharness input:checked']) {
      const u = await mountSpawn(t);
      if (platform === 'mac') asMac(u);
      await u.open(); await u.type('.fpurpose', 'api-v2');
      const mod = platform === 'mac' ? { metaKey: true } : { ctrlKey: true };
      assert.equal(u.q('.fspawn').dataset.chord, platform === 'mac' ? '⌘↵' : 'Ctrl+Enter', 'the button shows the effective chord');
      const field = u.q(from); field.focus();
      key(u, field, 'Enter'); await settle();
      assert.equal(u.spawns().length, 0, 'plain Enter there never starts it');
      // The other platform's modifier is not the chord here.
      key(u, field, 'Enter', platform === 'mac' ? { ctrlKey: true } : { metaKey: true }); await settle();
      assert.equal(u.spawns().length, 0);
      const e = key(u, field, 'Enter', mod); await settle(20);
      assert.equal(e.defaultPrevented, true);
      assert.equal(u.spawns()[0]?.action, 'prepare', `started from ${from}`);
    }
  });
}

test('plain Enter in Name does not start it; Enter or Space on the focused Start button does', async t => {
  const u = await mountSpawn(t);
  await u.open(); await u.type('.fpurpose', 'api-v2');
  key(u, u.q('.fpurpose'), 'Enter'); await settle();
  assert.equal(u.spawns().length, 0);
  const button = u.q('.fspawn'); button.focus();
  key(u, button, 'Enter'); await settle(20);
  assert.equal(u.spawns()[0]?.action, 'prepare');
});

test('Tab walks the form in visual order: Soul, Task, Harness (one stop), Name, Advanced, Cancel, Start; the header first', async t => {
  const u = await mountSpawn(t, { spawnName: true });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  assert.deepEqual(tabStops(u).map(label), ['Close', 'Soul', 'Task', 'Harness:pi', 'Name', 'Advanced', 'Cancel', 'Start']);
  const pi = u.q('.fharness input:checked'); pi.focus();
  key(u, pi, 'ArrowLeft'); await settle();
  assert.equal(u.q('.fharness input:checked').value, 'codex', 'arrows choose, like native radios');
  assert.equal(u.doc.activeElement, u.q('.fharness input:checked'));
  assert.equal(tabStops(u).filter(el => label(el).startsWith('Harness:')).length, 1, 'a radio group is one tab stop');
  key(u, u.doc.activeElement, 'Home'); assert.equal(u.q('.fharness input:checked').value, 'claude');
  key(u, u.doc.activeElement, 'End'); assert.equal(u.q('.fharness input:checked').value, 'pi');
  await settle(20); // the preview for these choices settles and Start enables
  // The trap: Tab from Start wraps to the header, Shift+Tab from it back to Start.
  const start = u.q('.fspawn'); assert.equal(start.disabled, false); start.focus();
  key(u, start, 'Tab'); assert.equal(u.doc.activeElement, u.q('.close-act'));
  key(u, u.doc.activeElement, 'Tab', { shiftKey: true }); assert.equal(u.doc.activeElement, start);
});

test('the Model picker opens with Enter or Alt+Down; Escape closes it back to its trigger, and only then closes the form', async t => {
  const u = await mountSpawn(t);
  await u.open(); u.q('.spawn-advanced').open = true;
  const trigger = u.q('.spawn-model-controls .spawn-choice-trigger'), menu = () => u.q('#spawn-model-choices');
  for (const open of [['Enter'], ['ArrowDown', { altKey: true }]]) {
    trigger.focus(); key(u, trigger, ...open); await settle();
    assert.equal(menu().hidden, false, `${open[0]} opens it`);
    key(u, u.doc.activeElement, 'Escape'); await settle();
    assert.equal(menu().hidden, true); assert.equal(u.doc.activeElement, trigger, 'focus back on its trigger');
    assert.ok(u.dialog(), 'the form stays open');
  }
  key(u, trigger, 'Escape'); await settle();
  assert.equal(u.dialog(), null, 'Escape with no picker open closes the form');
});

// ── Spec E: focus on open, and the section keys ──────────────────────────

test('Spec E: Reopen spawn (a restored draft) lands on Task, caret at its end; Mod+6 reaches the restored name, caret at the end, nothing selected', async t => {
  const u = await mountSpawn(t, { spawnName: true }); asMac(u);
  spawn.preselectSpawn({ name: 'release-manager', agentsRoot: ROOT, draft: { task: 'Cut 3.2', restore: { choices: { name: 'api-v2-manager' } } } }); await settle();
  const purpose = u.q('.fpurpose'), task = u.q('.ftask');
  assert.equal(purpose.value, 'api-v2-manager', 'the name as sent');
  assert.equal(u.doc.activeElement, task);
  assert.deepEqual([task.value, task.selectionStart, task.selectionEnd], ['Cut 3.2', 7, 7], 'the caret after the restored task, no select-all');
  key(u, task, '6', { metaKey: true });
  assert.equal(u.doc.activeElement, purpose);
  assert.deepEqual([purpose.selectionStart, purpose.selectionEnd], [14, 14], 'the caret after the restored name, no select-all');
});

test('Spec E: the Soul field opens its list on the chosen soul; a click pick goes on to Task', async t => {
  const u = await mountSpawn(t);
  await u.open(); await u.type('.fpurpose', 'api-v2');
  u.q('.spawn-soul-current').click();
  const search = u.q('.spawn-soul-search');
  assert.equal(u.doc.activeElement, search, 'the list\'s text field');
  assert.equal(u.doc.getElementById(search.getAttribute('aria-activedescendant')).dataset.agent, 'release-manager');
  u.q('.spawn-soul-option[data-agent="support-triager"]').click(); await settle();
  assert.equal(u.doc.activeElement, firstField(u), 'after the pick: Task');
});

// The section keys: Task Mod+1, Harness Mod+2, Model Mod+3 (in Advanced, which the jump opens), Name Mod+6.
// Mod+4 was Relationship's, which D6 removed.
const SECTIONS = [
  ['1', u => u.q('.ftask'), 'Task'],
  ['2', u => u.q('.fharness input:checked'), 'Harness'],
  ['3', u => u.q('.fmodel'), 'Model'],
  ['6', u => u.q('.fpurpose'), 'Name'],
];
for (const platform of ['mac', 'other']) {
  test(`Spec E: Mod+1–Mod+6 jump to their section, from any field, and never reach the shell behind the modal (${platform})`, async t => {
    const u = await mountSpawn(t);
    if (platform === 'mac') asMac(u);
    await u.open();
    const mod = platform === 'mac' ? { metaKey: true } : { ctrlKey: true };
    const behind = []; u.dom.window.addEventListener('keydown', e => behind.push(e.key));
    for (const [digit, target, name] of SECTIONS) {
      const from = u.q('.ftask') === target(u) ? u.q('.fpurpose') : u.q('.ftask'); from.focus();
      const e = key(u, from, digit, mod);
      assert.equal(e.defaultPrevented, true, `Mod+${digit} is the dialog's`);
      assert.equal(u.doc.activeElement, target(u), `Mod+${digit} → ${name}`);
    }
    assert.deepEqual(behind, [], 'the section keys stop at the dialog: nothing behind the modal sees them');
    // The other platform's modifier is not the chord here: it does nothing in the dialog.
    u.q('.ftask').focus(); key(u, u.q('.ftask'), '6', platform === 'mac' ? { ctrlKey: true } : { metaKey: true });
    assert.equal(u.doc.activeElement, u.q('.ftask'));
    behind.length = 0;
    // Teams is not offered here: Mod+5 moves nothing, and still never reaches the shell.
    const five = key(u, u.q('.ftask'), '5', mod);
    assert.equal(five.defaultPrevented, true); assert.equal(u.doc.activeElement, u.q('.ftask'));
    // A held key repeats: still the dialog's, and nothing moves.
    const held = key(u, u.q('.ftask'), '6', { ...mod, repeat: true });
    assert.equal(held.defaultPrevented, true); assert.equal(u.doc.activeElement, u.q('.ftask'));
    assert.deepEqual(behind, [], 'nothing propagated past the dialog');
    assert.ok(u.dialog(), 'the dialog stays open');
  });
}

test('Spec E: Mod+7 opens Advanced on its first control, and again closes it back on its summary', async t => {
  const u = await mountSpawn(t);
  await u.open();
  const advanced = u.q('.spawn-advanced');
  assert.equal(advanced.open, false);
  key(u, u.q('.fpurpose'), '7', { ctrlKey: true });
  assert.equal(advanced.open, true);
  const first = u.doc.activeElement;
  assert.ok(u.q('.spawn-advanced-body').contains(first), 'focus inside Advanced');
  assert.ok(['INPUT', 'SELECT', 'BUTTON', 'TEXTAREA'].includes(first.tagName));
  key(u, first, '7', { ctrlKey: true });
  assert.equal(advanced.open, false); assert.equal(u.doc.activeElement, u.q('.spawn-advanced > summary'));
});

test('Spec E: each section shows its chord as a quiet hint (aria-hidden) and the control says aria-keyshortcuts; a rebind follows', async t => {
  const { setBinding, resetBinding } = await import('../renderer/keybindings.mjs');
  const u = await mountSpawn(t);
  asMac(u);
  await u.open();
  const hints = [...u.dialog().querySelectorAll('kbd.spawn-key-hint')];
  assert.equal(hints.length, 6);
  for (const hint of hints) assert.equal(hint.getAttribute('aria-hidden'), 'true');
  const shown = hints.filter(h => !h.closest('[hidden]')).map(h => h.textContent);
  // In the document's order: Task ⌘1, Harness ⌘2, Name ⌘6 (in the form on this kernel, which can't name from the task),
  // Advanced ⌘7, then Model ⌘3 inside it.
  assert.deepEqual(shown, ['⌘1', '⌘2', '⌘6', '⌘7', '⌘3'], 'Teams is not offered here: its hint is in its hidden row');
  assert.equal(u.q('label[for=spawn-purpose] kbd').textContent, '⌘6', 'beside the Name label');
  assert.equal(u.q('.fpurpose').getAttribute('aria-keyshortcuts'), 'Meta+6');
  assert.ok([...u.dialog().querySelectorAll('.fharness input')].every(i => i.getAttribute('aria-keyshortcuts') === 'Meta+2'));
  assert.equal(u.q('.fmodel').getAttribute('aria-keyshortcuts'), 'Meta+3');
  assert.equal(u.q('.ftask').getAttribute('aria-keyshortcuts'), 'Meta+1');
  assert.equal(u.q('.spawn-advanced > summary').getAttribute('aria-keyshortcuts'), 'Meta+7');
  assert.equal(u.q('label[for=spawn-purpose]').textContent.replace(u.q('label[for=spawn-purpose] kbd').textContent, ''), 'Name · optional');
  t.after(() => resetBinding('spawn.jumpName'));
  setBinding('spawn.jumpName', 'Mod+Shift+N');
  assert.equal(u.q('label[for=spawn-purpose] kbd').textContent, '⇧⌘N');
  assert.equal(u.q('.fpurpose').getAttribute('aria-keyshortcuts'), 'Meta+Shift+N');
  u.q('.ftask').focus(); key(u, u.q('.ftask'), 'N', { metaKey: true, shiftKey: true });
  assert.equal(u.doc.activeElement, u.q('.fpurpose'), 'the rebound chord jumps');
  u.q('.ftask').focus(); key(u, u.q('.ftask'), '6', { metaKey: true });
  assert.equal(u.doc.activeElement, u.q('.ftask'), 'the old chord no longer jumps');
  setBinding('spawn.jumpName', null);
  assert.equal(u.q('label[for=spawn-purpose] kbd').hidden, true, 'unbound: no hint');
  assert.equal(u.q('.fpurpose').hasAttribute('aria-keyshortcuts'), false);
});

// Where a rebind of yours now shares a chord with another section's new default, yours runs (resolveViewKey, as
// matchEvent and the editor say); and rebinds are kept by action id when a default moves.
for (const platform of ['mac', 'other']) {
  test(`Spec E: your rebinds win over a section that has the chord by default after the section keys moved (${platform})`, async t => {
    const { setBinding, resetBinding, getBinding, keymapConflicts } = await import('../renderer/keybindings.mjs');
    const isMac = platform === 'mac', navPlatform = isMac ? 'MacIntel' : 'Linux x86_64';
    pinPlatform(t, navPlatform);
    const u = await mountSpawn(t);
    Object.defineProperty(u.dom.window.navigator, 'platform', { value: navPlatform, configurable: true });
    for (const id of ['spawn.jumpHarness', 'spawn.toggleAdvanced']) t.after(() => resetBinding(id));
    // As stored before the move: Harness on Mod+1 (Name moved off it), Advanced on Mod+6.
    setBinding('spawn.jumpHarness', 'Mod+1'); setBinding('spawn.toggleAdvanced', 'Mod+6');
    await u.open();
    const mod = isMac ? { metaKey: true } : { ctrlKey: true };
    assert.equal(getBinding('spawn.jumpTask', isMac), 'Mod+1', 'Task has Mod+1 by default now');
    assert.equal(getBinding('spawn.jumpName', isMac), 'Mod+6', 'and Name Mod+6');
    const clashes = keymapConflicts(isMac).filter(c => c.actions.every(a => a.id.startsWith('spawn.')))
      .map(c => c.actions.map(a => a.id).sort().join(' ')).sort();
    assert.deepEqual(clashes, ['spawn.jumpHarness spawn.jumpTask', 'spawn.jumpName spawn.toggleAdvanced'], 'the editor names both clashes');
    const harness = u.q('.fharness input:checked'), advanced = u.q('.spawn-advanced');
    u.q('.fpurpose').focus(); key(u, u.q('.fpurpose'), '1', mod);
    assert.equal(u.doc.activeElement, harness, 'Mod+1 is your Harness, not Task that has it by default');
    assert.equal(advanced.open, false);
    key(u, harness, '6', mod);
    assert.equal(advanced.open, true, 'Mod+6 is your Advanced, not Name that has it by default');
    assert.ok(u.q('.spawn-advanced-body').contains(u.doc.activeElement));
  });

  test(`Spec E: a Name rebind stored under the old Mod+1 default survives the new registration (${platform})`, async t => {
    const { setBinding, resetBinding, getBinding, registerAction } = await import('../renderer/keybindings.mjs');
    const { SPAWN_JUMPS, SPAWN_DIALOG_CONTEXT } = await import('../renderer/spawn-dialog-keys.mjs');
    const isMac = platform === 'mac', navPlatform = isMac ? 'MacIntel' : 'Linux x86_64';
    pinPlatform(t, navPlatform);
    const name = SPAWN_JUMPS.find(j => j.id === 'spawn.jumpName');
    const register = defaultChord => registerAction({ id: name.id, label: name.label, context: SPAWN_DIALOG_CONTEXT, defaultChord, run: () => {} });
    // The app as it was: Name registered on Mod+1, and the user's rebind stored under that default.
    register('Mod+1');
    t.after(() => { resetBinding(name.id); register(name.defaultChord); });
    setBinding(name.id, 'Mod+Shift+N');
    // The new app registers Name on its new default; the stored rebind is by action id, untouched.
    register(name.defaultChord);
    assert.equal(name.defaultChord, 'Mod+6');
    assert.equal(getBinding(name.id, isMac), 'Mod+Shift+N', 'the rebind kept its chord');
    const u = await mountSpawn(t);
    Object.defineProperty(u.dom.window.navigator, 'platform', { value: navPlatform, configurable: true });
    await u.open();
    const mod = isMac ? { metaKey: true } : { ctrlKey: true };
    assert.equal(getBinding(name.id, isMac), 'Mod+Shift+N', 'and still after the dialog registered its keys');
    assert.equal(u.q('.fpurpose').getAttribute('aria-keyshortcuts'), isMac ? 'Meta+Shift+N' : 'Control+Shift+N', 'the hint says yours');
    u.q('.ftask').focus(); key(u, u.q('.ftask'), 'N', { ...mod, shiftKey: true });
    assert.equal(u.doc.activeElement, u.q('.fpurpose'), 'your chord jumps to Name');
    u.q('.ftask').focus(); key(u, u.q('.ftask'), '6', mod);
    assert.equal(u.doc.activeElement, u.q('.ftask'), 'the new default is not Name\'s while your rebind holds');
    key(u, u.q('.ftask'), '1', mod);
    assert.equal(u.doc.activeElement, u.q('.ftask'), 'nor the old one: Mod+1 is Task\'s');
  });
}

test('Spec E: the form\'s keys are listed in the shortcuts editor under New agent, and shadow no global key', async () => {
  const { listActions, findConflict, registerAction } = await import('../renderer/keybindings.mjs');
  const { groupActions } = await import('../renderer/keybindings-editor.mjs');
  const { registerSpawnDialogKeys } = await import('../renderer/spawn-dialog-keys.mjs');
  registerSpawnDialogKeys(); registerSpawnDialogKeys(); // idempotent
  const ids = listActions().filter(a => a.context === 'spawn-dialog-local').map(a => a.id).sort();
  assert.deepEqual(ids, ['spawn.jumpHarness', 'spawn.jumpModel', 'spawn.jumpName', 'spawn.jumpTask', 'spawn.jumpTeams', 'spawn.submit', 'spawn.toggleAdvanced'], 'Relationship\'s jump went with it (D6)');
  assert.equal(groupActions().find(g => g.context === 'spawn-dialog-local').label, 'New agent');
  const release = registerAction({ id: 'fixture.showActive', label: 'Show Active', context: 'global', defaultChord: 'Mod+1', run: () => {} });
  try {
    assert.equal(findConflict('Mod+1', 'spawn-dialog-local', 'spawn.jumpTask', true), null, 'the open dialog owns Mod+1; Active keeps it elsewhere');
    assert.equal(findConflict('Mod+1', 'global', 'fixture.showActive', true), null);
    assert.equal(findConflict('Mod+2', 'spawn-dialog-local', 'spawn.jumpTask', true)?.id, 'spawn.jumpHarness', 'within the dialog, a clash is a clash');
  } finally { release(); }
});

test('Spec E: a section key from an open Model picker closes the picker and moves on; Escape then closes the form as usual', async t => {
  const u = await mountSpawn(t);
  await u.open(); u.q('.spawn-advanced').open = true;
  const trigger = u.q('.spawn-model-controls .spawn-choice-trigger'), menu = () => u.q('#spawn-model-choices');
  trigger.focus(); key(u, trigger, 'Enter'); await settle();
  assert.equal(menu().hidden, false, 'the picker is open');
  const e = key(u, u.doc.activeElement, '1', { ctrlKey: true });
  assert.equal(e.defaultPrevented, true);
  assert.equal(menu().hidden, true, 'closed by the jump, not left behind');
  assert.equal(u.doc.activeElement, u.q('.ftask'), 'focus moved on (not restored to the picker trigger)');
  key(u, u.q('.ftask'), 'Escape'); await settle();
  assert.equal(u.dialog(), null, 'no picker is open, so Escape closes the form');
});

// Quick Open's pick from a terminal tab opens the dialog before the Workspace stage is on screen (the shell
// shows it right after): focus on the first field cannot land yet. It lands once the stage is shown, unless the
// operator focused something else in between. (Seen live: the dialog opened with focus on <body>.)
for (const [why, between, lands] of [
  ['the stage shows a frame later: the first field takes focus then', show => show(), true],
  ['the operator focused something else first: it stays theirs', (show, u) => { const b = u.doc.createElement('button'); u.doc.body.append(b); b.focus(); show(); }, false],
  ['the operator focused a control in the dialog first: it stays theirs', (show, u) => { show(); u.q('.fpurpose').focus(); }, false],
]) test(`opened before its stage is on screen: ${why}`, async t => {
  const u = await mountSpawn(t);
  const proto = u.dom.window.HTMLElement.prototype, focus = proto.focus;
  let offscreen = true; // a control under a hidden stage does not take focus
  proto.focus = function (...args) { if (offscreen && this.closest?.('.spawn-dialog')) return; return focus.apply(this, args); };
  t.after(() => { proto.focus = focus; });
  // The host collects setInterval (the view's polls), which jsdom's own frames run on: drive frames here.
  u.dom.window.requestAnimationFrame = f => setTimeout(f, 16);
  spawn.preselectSpawn({ name: 'release-manager', agentsRoot: ROOT, onDismiss: () => true });
  assert.ok(u.dialog(), 'the dialog is open'); assert.notEqual(u.doc.activeElement, firstField(u), 'not yet');
  between(() => { offscreen = false; }, u); // the stage is shown
  const other = u.doc.activeElement;
  await new Promise(r => setTimeout(r, 250)); // more than the 10 frames the retry may take
  if (lands) assert.equal(u.doc.activeElement, firstField(u), 'focus lands on the first field');
  else assert.equal(u.doc.activeElement, other, 'the operator\'s focus is not taken');
});
