// The Desktop's spawn sentences are byte-identical after the split of #855 (6b-2): the shared home answers a fact
// and a `next` code (packages/client/spawn-messages.mjs), and the Desktop composes its sentence from them with its
// own words (renderer/spawn-words.mjs). Every sentence below is pinned as the base commit 643447e2 wrote it: its
// COMMON, PREVIEW and SPAWN tables copied here verbatim (comments left out), and each notice of spawn-jobs.mjs and
// the dialog written out. Nothing here is recomputed from the code under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnProblem, rolledBackProblem, cleanupOwedProblem } from '../../client/spawn-messages.mjs';
import { WAKE_OUTCOME_UNKNOWN } from '../../client/spawn-apply-contract.mjs';
import { spawnText, outcomeText } from '../renderer/spawn-words.mjs';
import { DRIFT_TEXT } from '../renderer/spawn-jobs.mjs';

const UNMATCHED = 'E_LAUNCH_PREFERENCE_UNMATCHED';
// ── 643447e2:packages/client/spawn-messages.mjs, the three tables
const BASE_COMMON = Object.freeze({
  E_BAD_ARGS: 'Some of these values can’t be used. Check the name and the options in Advanced.',
  E_BUSY: 'Another spawn is in progress. Try again in a moment.',
  E_FORBIDDEN_FRAME: 'This window can’t start a spawn.',
  E_PREVIEW_UNAVAILABLE: 'Spawning needs a newer OATS. Update OATS, then open this dialog again.',
  E_APPLY_UNAVAILABLE: 'Spawning needs a newer OATS. Update OATS, then open this dialog again.',
  E_WORKSPACE_UNKNOWN: 'This workspace isn’t available anymore. Choose it again from the workspace menu.',
  E_SOUL_UNKNOWN: 'This soul isn’t in the workspace anymore. Sync the workspace and try again.',
  E_SOUL_AMBIGUOUS: 'Two repositories declare a soul with this name, so it can’t be spawned until one is renamed.',
  E_UNSUPPORTED_MODE: 'This soul can’t be started on its own from here.',
  'unsupported-remote-operation': 'The execution server decides this soul’s defaults.',
  E_UNSUPPORTED_OPTION: 'One of the options you chose isn’t supported here. Set it back to the default and try again.',
  E_RELATIVE_AMBIGUOUS: 'The instance you picked for the relationship can’t be told apart from another one. Pick it again.',
  E_SESSION_UNKNOWN: 'The instance you picked for the relationship isn’t available anymore. Pick another one.',
  E_HOME_MISMATCH: 'The instance you picked for the relationship isn’t available anymore. Pick another one.',
  E_CHILD_SPAWNS_DISABLED: 'The parent you picked doesn’t allow child instances. Pick another one, or choose None.',
  E_BRANCH_EXISTS: 'That branch already exists. Choose another branch in Advanced.',
  E_BASE_UNKNOWN: 'That base isn’t a branch, tag or commit in this soul’s repository. Check it in Advanced.',
  E_CLONE_MISSING: 'This soul’s repository isn’t cloned on this machine yet. Clone it, then try again — Details shows how.',
  E_LAUNCH_ENV_MISSING: 'The chosen launch configuration can’t start on this machine. Choose another in Advanced.',
  E_LAUNCH_EXECUTABLE: 'The chosen launch configuration can’t start on this machine. Choose another in Advanced.',
  E_LAUNCH_PROBE_UNSUPPORTED: 'The chosen launch configuration can’t be checked safely. Choose another in Advanced.',
  E_LAUNCH_CONFIG_UNKNOWN: 'That launch configuration no longer exists. Choose another in Advanced.',
  E_LAUNCH_CONFIG_AMBIGUOUS: 'This machine has more than one launch configuration for this soul’s harness, and none is the default. Choose one under Launch configuration in Advanced.',
  E_HARNESS_UNAVAILABLE: 'The harness this soul would run isn’t installed on this machine. Install it, or pick another harness above.',
  [UNMATCHED]: 'This machine’s launch preferences name a soul this workspace doesn’t offer, so OATS won’t choose a launch for this soul. To spawn now, pick a harness above, or a launch configuration in Advanced. To fix it for every spawn, correct the preference (Details).',
  E_MODEL_UNKNOWN: 'That model isn’t available for this harness. Pick another model, or keep the default.',
  E_INSTANCE_NAME_INVALID: 'Use lowercase letters, numbers and dashes, at most 64 characters, and don’t reuse a soul’s name.',
  E_INSTANCE_NAME_TAKEN: 'An instance with this name already exists. Choose another name.',
  E_PACKAGE_MISSING: 'A package this soul uses isn’t installed yet. Run Sync in the Workspace view.',
  E_PACKAGE_INTEGRITY: 'A package this soul uses no longer matches the lock. Run Sync in the Workspace view.',
  E_TARGET_CHANGED: 'The workspace changed while this was loading. Reading it again…',
  E_PLAN_CHANGED: 'The workspace changed while this was loading. Check the values and press Start again.',
});
const BASE_PREVIEW = Object.freeze({
  E_CLI_TIMEOUT: 'OATS took too long to work out this soul’s defaults. Try again.',
  E_CLI_OUTPUT_LIMIT: 'OATS couldn’t work out this soul’s defaults. Try again, or see Details.',
  E_CLI_PROTOCOL: 'OATS couldn’t work out this soul’s defaults. Try again, or see Details.',
  E_CLI_FAILED: 'OATS couldn’t work out this soul’s defaults. Try again, or see Details.',
});
const BASE_SPAWN = Object.freeze({
  E_PLAN_REQUIRED: 'Check the values and press Start to confirm.',
  E_DECISION_STALE: 'Something changed before the spawn went through. Nothing was created — check the updated values and press Start again.',
  E_IDEMPOTENCY_CONFLICT: 'Something changed before the spawn went through. Nothing was created — check the updated values and press Start again.',
  E_PLACEMENT_TAKEN: 'Another spawn just took this name. Nothing was created — check the new name and press Start again.',
  E_INTENT_EXPIRED: 'This spawn request expired. Check the instance list before spawning again.',
  E_PREFLIGHT_INCOMPLETE: 'OATS couldn’t finish checking this spawn. Try again.',
  E_BACKEND_UNAVAILABLE: 'That session backend isn’t installed on this machine. Choose another in Advanced.',
  E_INSTANCE_GONE: 'The instance that was created isn’t there anymore. Check the instance list.',
  E_OUTCOME_UNKNOWN: 'We couldn’t confirm whether the instance was created. Use Check result before spawning again.',
  E_SPAWN_INCOMPLETE: 'The instance was created but didn’t finish starting. Open it from the instance list instead of spawning again.',
  E_INPUT_PREPARATION: 'The opening instruction couldn’t be prepared, so nothing was started. Try again.',
  E_CLI_TIMEOUT: 'OATS took too long to answer. The instance may already exist — use Check result before spawning again.',
  E_CLI_OUTPUT_LIMIT: 'OATS couldn’t confirm the spawn. Use Check result before spawning again.',
  E_CLI_PROTOCOL: 'OATS couldn’t complete the spawn. Try again, or see Details.',
  E_CLI_FAILED: 'OATS couldn’t complete the spawn. Try again, or see Details.',
  [UNMATCHED]: 'This machine’s launch preferences name a soul this workspace doesn’t offer, so OATS won’t choose a launch for this soul. To spawn now, pick a harness or a launch configuration for this spawn. To fix it for every spawn, correct the preference.',
});

/** The base commit's rule: the stage's table, then COMMON, then the stage's E_CLI_FAILED. */
const baseText = (code, stage) => (stage === 'spawn' ? BASE_SPAWN : BASE_PREVIEW)[code] ?? BASE_COMMON[code] ?? (stage === 'spawn' ? BASE_SPAWN : BASE_PREVIEW).E_CLI_FAILED;
const desktop = (reason, stage) => spawnText(spawnProblem(reason, stage), stage);
const CODES = [...new Set([...Object.keys(BASE_COMMON), ...Object.keys(BASE_PREVIEW), ...Object.keys(BASE_SPAWN)])];

test('the base tables were copied whole', () => {
  assert.equal(Object.keys(BASE_COMMON).length, 32); assert.equal(Object.keys(BASE_PREVIEW).length, 4); assert.equal(Object.keys(BASE_SPAWN).length, 16);
  for (const code of ['E_FORBIDDEN_FRAME', 'E_PLAN_REQUIRED', UNMATCHED, 'E_HARNESS_UNAVAILABLE']) assert.ok(CODES.includes(code), code);
});

test('every code of the base tables, at both stages, reads the base sentence', () => {
  for (const stage of ['preview', 'spawn']) {
    for (const code of CODES) {
      // The unmatched preference without the kernel's fix (the variant with it is below).
      const expected = code === UNMATCHED ? BASE_SPAWN[UNMATCHED] : baseText(code, stage);
      assert.equal(desktop({ code }, stage), expected, `${stage} ${code}`);
      assert.equal(desktop({ code, message: 'technical text' }, stage), code === 'E_HARNESS_UNAVAILABLE' ? 'technical text' : expected, `${stage} ${code} with a message`);
    }
    // A code no table holds, and no reason at all: the stage's general failure.
    assert.equal(desktop({ code: 'E_SOMETHING_NEW', message: 'raw' }, stage), baseText('E_SOMETHING_NEW', stage));
    assert.equal(desktop(undefined, stage), baseText('E_CLI_FAILED', stage));
  }
  // The Desktop-only codes in particular: the window guard at both stages, the route's body check at a press only.
  assert.equal(desktop({ code: 'E_FORBIDDEN_FRAME' }, 'preview'), 'This window can’t start a spawn.');
  assert.equal(desktop({ code: 'E_PLAN_REQUIRED' }, 'spawn'), 'Check the values and press Start to confirm.');
  assert.equal(desktop({ code: 'E_PLAN_REQUIRED' }, 'preview'), 'OATS couldn’t work out this soul’s defaults. Try again, or see Details.');
  // spawnText's stage defaults to spawnProblem's.
  assert.equal(spawnText(spawnProblem({ code: 'E_CLI_TIMEOUT' })), BASE_PREVIEW.E_CLI_TIMEOUT);
});

test('the unmatched launch preference, with and without the kernel\'s fix, at both stages', () => {
  const said = 'the file points "ghost" at a launch', fix = 'drop "ghost"';
  assert.equal(desktop({ code: UNMATCHED, message: said, fix }, 'preview'), BASE_COMMON[UNMATCHED]);
  assert.equal(desktop({ code: UNMATCHED, message: said, fix }, 'spawn'), BASE_SPAWN[UNMATCHED]);
  for (const stage of ['preview', 'spawn']) {
    assert.equal(desktop({ code: UNMATCHED, message: said }, stage), BASE_SPAWN[UNMATCHED]);
    assert.equal(desktop({ code: UNMATCHED }, stage), BASE_SPAWN[UNMATCHED]);
  }
});

test('a missing harness in the kernel\'s words, as the base commit joined them', () => {
  assert.equal(desktop({ code: 'E_HARNESS_UNAVAILABLE', message: 'Pi is not installed.', fix: 'Install pi.' }, 'spawn'), 'Pi is not installed: Install pi.');
  assert.equal(desktop({ code: 'E_HARNESS_UNAVAILABLE', message: 'Pi is not installed. Install pi.', fix: 'Install pi.' }, 'preview'), 'Pi is not installed. Install pi.');
  assert.equal(desktop({ code: 'E_HARNESS_UNAVAILABLE', message: 'Pi is not installed.' }, 'spawn'), 'Pi is not installed.');
});

test('the rolled-back and cleanup-owed sentences', () => {
  assert.equal(spawnText(rolledBackProblem({ code: 'E_INTERRUPTED' }, 'dev-2')),
    'The spawn of dev-2 was interrupted while its worktree was being set up, and was rolled back. Nothing was created.');
  for (const code of ['E_REQUIRED_HOOK_FAILED', 'E_HOOK_ENVIRONMENT_CONTRACT']) {
    assert.equal(spawnText(rolledBackProblem({ code }, 'dev-2')), 'A capability couldn’t set up the worktree for dev-2, so the spawn was rolled back. Nothing was created.');
  }
  const OWED = 'The spawn of dev-2 was stopped, but its cleanup didn’t finish. Retire dev-2 from the roster to complete it.';
  for (const code of ['E_INTERRUPTED', 'E_REQUIRED_HOOK_FAILED', 'E_HOOK_ENVIRONMENT_CONTRACT']) {
    assert.equal(spawnText(cleanupOwedProblem({ code, message: 'hook log' }, 'dev-2')), OWED);
    assert.equal(outcomeText('cleanup-owed', { reason: { code } }, 'dev-2'), OWED);
  }
  assert.equal(outcomeText('rolled-back', { reason: { code: 'E_INTERRUPTED' } }, 'dev-2'),
    'The spawn of dev-2 was interrupted while its worktree was being set up, and was rolled back. Nothing was created.');
});

test('every notice of the background store, as the base commit wrote it', () => {
  assert.equal(DRIFT_TEXT, 'These values changed since you last looked. Reopen spawn to check them.');
  assert.equal(outcomeText('drifted'), 'These values changed since you last looked. Reopen spawn to check them.');
  assert.equal(outcomeText('pending-expired'), 'The spawn is still running. Check result again in a moment; nothing else was started.');
  assert.equal(outcomeText('never-submitted'), 'That spawn was never submitted. Reopen spawn to spawn with these values.');
  assert.equal(outcomeText('created', { status: 'complete', receipt: { launched: false } }, 'dev-2'), 'Created dev-2 — not launched. Open its session from the roster.');
  assert.equal(outcomeText('not-yet-visible', null, 'dev-2'), 'Created dev-2 — not yet visible as a running session. Open it from the roster when it appears.');
  // A partial spawn: the reason's own words (its button says View schedules), else "Created <i>.".
  for (const where of ['notice', 'dialog']) {
    assert.equal(outcomeText('created', { status: 'partial', receipt: { launched: true }, reason: { code: 'E_WAKE_OUTCOME_UNKNOWN', message: WAKE_OUTCOME_UNKNOWN } }, 'dev-2', where),
      'Agent created; wake outcome unavailable — check Schedules');
    assert.equal(outcomeText('created', { status: 'partial', receipt: { launched: false }, reason: { code: 'E_WAKE_SAVE_FAILED', message: 'The agent was created, but its wake schedule was not saved.' } }, 'dev-2', where),
      'The agent was created, but its wake schedule was not saved.');
  }
  assert.equal(WAKE_OUTCOME_UNKNOWN, 'Agent created; wake outcome unavailable — check Schedules', 'the boundary\'s own message, unchanged');
  assert.equal(outcomeText('created', { status: 'partial', receipt: { launched: false }, reason: null }, 'dev-2'), 'Created dev-2.');
});

test('the dialog\'s own status sentences, as the base commit wrote them', () => {
  assert.equal(outcomeText('drifted', null, '', 'dialog'), 'These values changed since you last looked. Check them and press Start again.');
  assert.equal(outcomeText('never-submitted', null, '', 'dialog'), 'That spawn was never submitted. Press Start to start it with the values shown.');
  // Its line for a complete spawn names no place to open it from.
  assert.equal(outcomeText('created', { status: 'complete', receipt: { launched: true } }, 'dev-2', 'dialog'), 'Created dev-2.');
  assert.equal(outcomeText('created', { status: 'complete', receipt: { launched: false } }, 'dev-2', 'dialog'), 'Created dev-2 — not launched.');
});
