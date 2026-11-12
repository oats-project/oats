// Spec F, Parts 1 and 2: Quick Open's pick opens the spawn dialog scoped to that soul, and the
// dialog works from the keyboard — Mod+Enter from any field, Tab in visual order, roving
// segmented controls, pickers that close first on Escape, and a soul listbox. Mounted in the
// real Workspace view with the kernel captures (helpers/spawn-dialog-host.mjs).
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
/** The form's first field, where the dialog lands: the Opening instruction. */
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
  : el.matches('.spawn-run label:first-child .spawn-choice-trigger') ? 'Harness' : el.classList.contains('fmodel') ? 'Model'
  : el.matches('.spawn-model-controls .spawn-choice-trigger') ? 'Model choices' : el.closest('.frelation') ? `Relationship:${el.value}`
  : el.classList.contains('frelto') ? 'Relationship target' : el.closest('.spawn-team-list') ? `Team:${el.value || 'default'}`
  : el.classList.contains('ftask') ? 'Opening instruction' : el.matches('.spawn-advanced > summary') ? 'Developer settings'
  : el.classList.contains('fcancel') ? 'Cancel' : el.classList.contains('fspawn') ? 'Spawn'
  : el.classList.contains('spawn-change-soul') ? 'Change soul' : el.classList.contains('close-act') ? 'Close'
  : el.classList.contains('spawn-details-toggle') ? 'Details' : el.className;

// ── Part 1: Quick Open → the scoped spawn dialog ─────────────────────────

test('Quick Open picks a soul: the spawn dialog opens scoped to it (header, preview, Change soul) with focus on its first field', async t => {
  const u = await mountSpawn(t);
  spawn.preselectSpawn({ name: 'release-manager', agentsRoot: ROOT, onDismiss: () => true }); await settle();
  const dialog = u.dialog(); assert.ok(dialog, 'the dialog is open');
  assert.equal(dialog.dataset.layout, 'scoped');
  assert.equal(u.text('h2#spawn-dialog-title'), 'Spawn release-manager');
  assert.equal(u.q('.spawn-preview').hidden, false); assert.equal(u.q('.spawn-change-soul').hidden, false);
  assert.equal(u.doc.activeElement, firstField(u), 'focus lands on the first field, the Opening instruction');
  assert.equal(u.doc.querySelector('.workspace-soul-page').hidden, true, 'no soul page on the way');
});

test('dismissing a Quick Open dialog returns to where the operator was; if that is gone, the dialog restores focus itself', async t => {
  const u = await mountSpawn(t);
  const returns = [];
  spawn.preselectSpawn({ name: 'release-manager', agentsRoot: ROOT, onDismiss: () => { returns.push('back'); return true; } }); await settle();
  key(u, u.q('.fpurpose'), 'Escape'); await settle();
  assert.equal(u.dialog(), null); assert.deepEqual(returns, ['back']);
  assert.notEqual(u.doc.activeElement, card(u, 'release-manager'), 'not to the card: the shell returned focus');
  // The operator moved on (the shell refuses the return): the dialog's own restore, the soul's card.
  spawn.preselectSpawn({ name: 'release-manager', agentsRoot: ROOT, onDismiss: () => false }); await settle();
  u.q('.fcancel').click(); await settle();
  assert.equal(u.doc.activeElement, card(u, 'release-manager'));
  // A successful spawn is not a dismissal: the return never runs.
});

test('the return target survives Change soul; Enter on a soul in the list picks it and moves to the first field', async t => {
  const u = await mountSpawn(t);
  const returns = [];
  spawn.preselectSpawn({ name: 'release-manager', agentsRoot: ROOT, onDismiss: () => { returns.push('back'); return true; } }); await settle();
  await u.type('.fpurpose', 'api-v2');
  u.q('.spawn-change-soul').click();
  const listbox = u.q('.spawn-soul-choices');
  assert.equal(listbox.getAttribute('role'), 'listbox');
  const selected = u.q('.spawn-choice[aria-selected=true]');
  assert.equal(selected.getAttribute('role'), 'option'); assert.equal(u.doc.activeElement, selected);
  key(u, selected, 'ArrowDown'); key(u, u.doc.activeElement, 'End'); key(u, u.doc.activeElement, 'Home');
  const first = u.doc.activeElement; assert.equal(first.getAttribute('role'), 'option');
  key(u, first, 'Enter'); await settle();
  assert.equal(u.text('h2'), 'Spawn instance', 'the picker layout stays');
  assert.equal(u.q('.spawn-choice[aria-selected=true]').dataset.agent, first.dataset.agent);
  assert.equal(u.doc.activeElement, firstField(u), 'Enter goes on to the first field');
  assert.equal(u.q('.fpurpose').value, 'api-v2', 'nothing typed is lost');
  u.q('.close-act').click(); await settle();
  assert.deepEqual(returns, ['back']);
});

test('the soul list filters as you type; Enter in its search picks the best match and moves to the first field', async t => {
  const u = await mountSpawn(t);
  await u.open(); u.q('.spawn-change-soul').click();
  const option = u.doc.activeElement;
  key(u, option, 's'); // typing on the list goes to its search
  const search = u.q('.spawn-soul-search');
  assert.equal(u.doc.activeElement, search); assert.equal(search.value, 's');
  search.value = 'triager'; search.dispatchEvent(new u.dom.window.Event('input', { bubbles: true }));
  assert.equal(u.text('.spawn-search-count'), '1 of 8');
  key(u, search, 'Enter'); await settle();
  assert.equal(u.q('.spawn-choice[aria-selected=true]').dataset.agent, 'support-triager');
  assert.equal(u.doc.activeElement, firstField(u));
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
  test(`Mod+Enter spawns from the instruction textarea and from a segmented control (${platform})`, async t => {
    for (const from of ['.ftask', '.frelation input:checked']) {
      const u = await mountSpawn(t);
      if (platform === 'mac') asMac(u);
      await u.open(); await u.type('.fpurpose', 'api-v2');
      const mod = platform === 'mac' ? { metaKey: true } : { ctrlKey: true };
      assert.equal(u.q('.fspawn').dataset.chord, platform === 'mac' ? '⌘↵' : 'Ctrl+Enter', 'the button shows the effective chord');
      const field = u.q(from); field.focus();
      key(u, field, 'Enter'); await settle();
      assert.equal(u.spawns().length, 0, 'plain Enter never spawns');
      // The other platform's modifier is not the chord here.
      key(u, field, 'Enter', platform === 'mac' ? { ctrlKey: true } : { metaKey: true }); await settle();
      assert.equal(u.spawns().length, 0);
      const e = key(u, field, 'Enter', mod); await settle(20);
      assert.equal(e.defaultPrevented, true);
      assert.equal(u.spawns()[0]?.action, 'prepare', `spawned from ${from}`);
    }
  });
}

test('plain Enter in Name does not spawn; Enter or Space on the focused Spawn button does', async t => {
  const u = await mountSpawn(t);
  await u.open(); await u.type('.fpurpose', 'api-v2');
  key(u, u.q('.fpurpose'), 'Enter'); await settle();
  assert.equal(u.spawns().length, 0);
  const button = u.q('.fspawn'); button.focus();
  key(u, button, 'Enter'); await settle(20);
  assert.equal(u.spawns()[0]?.action, 'prepare');
});

test('Tab walks the form in visual order: Instruction, Harness, Model, Relationship (one stop), its target, Name, Developer settings, Cancel, Spawn; the header after', async t => {
  const u = await mountSpawn(t, { spawnName: true });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  assert.deepEqual(tabStops(u).map(label), ['Change soul', 'Close', 'Opening instruction', 'Harness', 'Model', 'Model choices', 'Relationship:unrelated', 'Name', 'Developer settings', 'Cancel', 'Spawn']);
  // A relationship with a target: the target joins, right after the (one) Relationship stop.
  const independent = u.q('.frelation input:checked'); independent.focus();
  key(u, independent, 'ArrowRight'); await settle();
  assert.equal(u.q('.frelation input:checked').value, 'child', 'arrows choose, like native radios');
  assert.equal(u.doc.activeElement, u.q('.frelation input:checked'));
  const stops = tabStops(u).map(label);
  assert.deepEqual(stops.slice(stops.indexOf('Relationship:child'), stops.indexOf('Relationship:child') + 2), ['Relationship:child', 'Relationship target']);
  assert.equal(stops.filter(s => s.startsWith('Relationship:')).length, 1, 'a radio group is one tab stop');
  key(u, u.doc.activeElement, 'End'); assert.equal(u.q('.frelation input:checked').value, 'parent');
  key(u, u.doc.activeElement, 'Home'); assert.equal(u.q('.frelation input:checked').value, 'unrelated');
  await settle(20); // the preview for these choices settles and Spawn enables
  // The trap: Tab from Spawn wraps to the header, Shift+Tab from it back to Spawn.
  const spawnButton = u.q('.fspawn'); assert.equal(spawnButton.disabled, false); spawnButton.focus();
  key(u, spawnButton, 'Tab'); assert.equal(u.doc.activeElement, u.q('.spawn-change-soul'));
  key(u, u.doc.activeElement, 'Tab', { shiftKey: true }); assert.equal(u.doc.activeElement, spawnButton);
});

test('the Harness picker opens with Enter, Space or Alt+Down; Escape closes it back to its trigger, and only then closes the dialog', async t => {
  const u = await mountSpawn(t);
  await u.open();
  const trigger = u.q('.spawn-run label:first-child .spawn-choice-trigger'), menu = () => u.q('#spawn-runtime-choices');
  for (const open of [['Enter'], ['ArrowDown', { altKey: true }]]) {
    trigger.focus(); key(u, trigger, ...open); await settle();
    assert.equal(menu().hidden, false, `${open[0]} opens it`);
    key(u, u.doc.activeElement, 'Escape'); await settle();
    assert.equal(menu().hidden, true); assert.equal(u.doc.activeElement, trigger, 'focus back on its trigger');
    assert.ok(u.dialog(), 'the dialog stays open');
  }
  trigger.click(); await settle(); assert.equal(menu().hidden, false, 'Space is the button\'s own click');
  key(u, u.doc.activeElement, 'Escape'); await settle();
  key(u, trigger, 'Escape'); await settle();
  assert.equal(u.dialog(), null, 'Escape with no picker open closes the dialog');
});

// ── Spec E: focus on open, and the section keys ──────────────────────────

test('Spec E: Reopen spawn (a restored draft) lands on the instruction, caret at its end; Mod+6 reaches the restored name, caret at the end, nothing selected', async t => {
  const u = await mountSpawn(t, { spawnName: true }); asMac(u);
  spawn.preselectSpawn({ name: 'release-manager', agentsRoot: ROOT, draft: { layout: 'scoped', task: 'Cut 3.2', restore: { choices: { name: 'api-v2-manager' } } } }); await settle();
  const purpose = u.q('.fpurpose'), task = u.q('.ftask');
  assert.equal(u.dialog().dataset.layout, 'scoped'); assert.equal(purpose.value, 'api-v2-manager', 'the name as sent');
  assert.equal(u.doc.activeElement, task);
  assert.deepEqual([task.value, task.selectionStart, task.selectionEnd], ['Cut 3.2', 7, 7], 'the caret after the restored instruction, no select-all');
  key(u, task, '6', { metaKey: true });
  assert.equal(u.doc.activeElement, purpose);
  assert.deepEqual([purpose.selectionStart, purpose.selectionEnd], [14, 14], 'the caret after the restored name, no select-all');
});

test('Spec E: Change soul keeps today\'s focus in the list; a click pick goes on to the first field', async t => {
  const u = await mountSpawn(t);
  await u.open(); await u.type('.fpurpose', 'api-v2');
  u.q('.spawn-change-soul').click();
  assert.equal(u.doc.activeElement, u.q('.spawn-choice[aria-selected=true]'), 'the picker layout: the soul list, as before');
  [...u.doc.querySelectorAll('.spawn-choice')].find(b => b.dataset.agent === 'support-triager').click(); await settle();
  assert.equal(u.dialog().dataset.layout, 'picker');
  assert.equal(u.doc.activeElement, firstField(u), 'after the pick: the first field');
});

// The section keys follow the form's order: the instruction, its first field, is Mod+1; Name, its last before
// Developer settings, Mod+6.
const SECTIONS = [
  ['1', u => u.q('.ftask'), 'Opening instruction'],
  ['2', u => u.q('.spawn-run label:first-child .spawn-choice-trigger'), 'Harness'],
  ['3', u => u.q('.fmodel'), 'Model'],
  ['4', u => u.q('.frelation input:checked'), 'Relationship'],
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

test('Spec E: Mod+7 opens Developer settings on its first control, and again closes it back on its summary', async t => {
  const u = await mountSpawn(t);
  await u.open();
  const advanced = u.q('.spawn-advanced');
  assert.equal(advanced.open, false);
  key(u, u.q('.fpurpose'), '7', { ctrlKey: true });
  assert.equal(advanced.open, true);
  const first = u.doc.activeElement;
  assert.ok(u.q('.spawn-advanced-body').contains(first), 'focus inside Developer settings');
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
  assert.equal(hints.length, 7);
  for (const hint of hints) assert.equal(hint.getAttribute('aria-hidden'), 'true');
  const shown = hints.filter(h => !h.closest('[hidden]')).map(h => h.textContent);
  // In form order, the chords in order: the Opening instruction first, ⌘1; Name the last field before Developer settings, ⌘6.
  assert.deepEqual(shown, ['⌘1', '⌘2', '⌘3', '⌘4', '⌘6', '⌘7'], 'Teams is not offered here: its hint is in its hidden row');
  assert.equal(u.q('label[for=spawn-purpose] kbd').textContent, '⌘6', 'beside the Name label');
  assert.equal(u.q('.fpurpose').getAttribute('aria-keyshortcuts'), 'Meta+6');
  assert.equal(u.q('.spawn-run label:first-child .spawn-choice-trigger').getAttribute('aria-keyshortcuts'), 'Meta+2');
  assert.equal(u.q('.fmodel').getAttribute('aria-keyshortcuts'), 'Meta+3');
  assert.ok([...u.dialog().querySelectorAll('.frelation input')].every(i => i.getAttribute('aria-keyshortcuts') === 'Meta+4'));
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
    // As stored before the move: Harness on Mod+1 (Name moved off it), Developer settings on Mod+6.
    setBinding('spawn.jumpHarness', 'Mod+1'); setBinding('spawn.toggleAdvanced', 'Mod+6');
    await u.open();
    const mod = isMac ? { metaKey: true } : { ctrlKey: true };
    assert.equal(getBinding('spawn.jumpTask', isMac), 'Mod+1', 'the Opening instruction has Mod+1 by default now');
    assert.equal(getBinding('spawn.jumpName', isMac), 'Mod+6', 'and Name Mod+6');
    const clashes = keymapConflicts(isMac).filter(c => c.actions.every(a => a.id.startsWith('spawn.')))
      .map(c => c.actions.map(a => a.id).sort().join(' ')).sort();
    assert.deepEqual(clashes, ['spawn.jumpHarness spawn.jumpTask', 'spawn.jumpName spawn.toggleAdvanced'], 'the editor names both clashes');
    const harness = u.q('.spawn-run label:first-child .spawn-choice-trigger'), advanced = u.q('.spawn-advanced');
    u.q('.fpurpose').focus(); key(u, u.q('.fpurpose'), '1', mod);
    assert.equal(u.doc.activeElement, harness, 'Mod+1 is your Harness, not the Opening instruction that has it by default');
    assert.equal(advanced.open, false);
    key(u, harness, '6', mod);
    assert.equal(advanced.open, true, 'Mod+6 is your Developer settings, not Name that has it by default');
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
    assert.equal(u.doc.activeElement, u.q('.ftask'), 'nor the old one: Mod+1 is the instruction\'s');
  });
}

test('Spec E: the dialog keys are listed in the shortcuts editor under Spawn dialog, and shadow no global key', async () => {
  const { listActions, findConflict, registerAction } = await import('../renderer/keybindings.mjs');
  const { groupActions } = await import('../renderer/keybindings-editor.mjs');
  const { registerSpawnDialogKeys } = await import('../renderer/spawn-dialog-keys.mjs');
  registerSpawnDialogKeys(); registerSpawnDialogKeys(); // idempotent
  const ids = listActions().filter(a => a.context === 'spawn-dialog-local').map(a => a.id).sort();
  assert.deepEqual(ids, ['spawn.jumpHarness', 'spawn.jumpModel', 'spawn.jumpName', 'spawn.jumpRelationship', 'spawn.jumpTask', 'spawn.jumpTeams', 'spawn.submit', 'spawn.toggleAdvanced']);
  assert.equal(groupActions().find(g => g.context === 'spawn-dialog-local').label, 'Spawn dialog');
  const release = registerAction({ id: 'fixture.showActive', label: 'Show Active', context: 'global', defaultChord: 'Mod+1', run: () => {} });
  try {
    assert.equal(findConflict('Mod+1', 'spawn-dialog-local', 'spawn.jumpTask', true), null, 'the open dialog owns Mod+1; Active keeps it elsewhere');
    assert.equal(findConflict('Mod+1', 'global', 'fixture.showActive', true), null);
    assert.equal(findConflict('Mod+2', 'spawn-dialog-local', 'spawn.jumpTask', true)?.id, 'spawn.jumpHarness', 'within the dialog, a clash is a clash');
  } finally { release(); }
});

test('Spec E: a section key from an open Harness picker closes the picker and moves on; Escape then closes the dialog as usual', async t => {
  const u = await mountSpawn(t);
  await u.open();
  const trigger = u.q('.spawn-run label:first-child .spawn-choice-trigger'), menu = () => u.q('#spawn-runtime-choices');
  trigger.focus(); key(u, trigger, 'Enter'); await settle();
  assert.equal(menu().hidden, false, 'the picker is open');
  const e = key(u, u.doc.activeElement, '1', { ctrlKey: true });
  assert.equal(e.defaultPrevented, true);
  assert.equal(menu().hidden, true, 'closed by the jump, not left behind');
  assert.equal(u.doc.activeElement, u.q('.ftask'), 'focus moved on (not restored to the picker trigger)');
  key(u, u.q('.ftask'), 'Escape'); await settle();
  assert.equal(u.dialog(), null, 'no picker is open, so Escape closes the dialog');
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
