// A spawn's words in the shared home (packages/client/spawn-messages.mjs, #855 6b-2): each problem's shared fact
// and the act that follows it (`next`, from a closed set), and each transaction outcome's words. A client says
// the fact as it is and `next` in its own words; the Desktop's own sentences are pinned in
// packages/desktop/test/spawn-words.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnProblem, cleanupOwedProblem, rolledBackProblem, outcomeWords, SPAWN_NEXT } from '../packages/client/spawn-messages.mjs';
import { WAKE_OUTCOME_UNKNOWN } from '../packages/client/spawn-apply-contract.mjs';

/** Every code the shared tables answer, at both stages (the Desktop-only E_FORBIDDEN_FRAME and E_PLAN_REQUIRED are the Desktop's). */
const CODES = ['E_BAD_ARGS', 'E_BUSY', 'E_PREVIEW_UNAVAILABLE', 'E_APPLY_UNAVAILABLE', 'E_WORKSPACE_UNKNOWN', 'E_SOUL_UNKNOWN', 'E_SOUL_AMBIGUOUS',
  'E_UNSUPPORTED_MODE', 'unsupported-remote-operation', 'E_UNSUPPORTED_OPTION', 'E_RELATIVE_AMBIGUOUS', 'E_SESSION_UNKNOWN', 'E_HOME_MISMATCH',
  'E_CHILD_SPAWNS_DISABLED', 'E_BRANCH_EXISTS', 'E_BASE_UNKNOWN', 'E_CLONE_MISSING', 'E_LAUNCH_ENV_MISSING', 'E_LAUNCH_EXECUTABLE',
  'E_LAUNCH_PROBE_UNSUPPORTED', 'E_LAUNCH_CONFIG_UNKNOWN', 'E_LAUNCH_CONFIG_AMBIGUOUS', 'E_HARNESS_UNAVAILABLE', 'E_LAUNCH_PREFERENCE_UNMATCHED',
  'E_MODEL_UNKNOWN', 'E_INSTANCE_NAME_INVALID', 'E_INSTANCE_NAME_TAKEN', 'E_PACKAGE_MISSING', 'E_PACKAGE_INTEGRITY', 'E_TARGET_CHANGED', 'E_PLAN_CHANGED',
  'E_CLI_TIMEOUT', 'E_CLI_OUTPUT_LIMIT', 'E_CLI_PROTOCOL', 'E_CLI_FAILED', 'E_DECISION_STALE', 'E_IDEMPOTENCY_CONFLICT', 'E_PLACEMENT_TAKEN',
  'E_INTENT_EXPIRED', 'E_PREFLIGHT_INCOMPLETE', 'E_BACKEND_UNAVAILABLE', 'E_INSTANCE_GONE', 'E_OUTCOME_UNKNOWN', 'E_SPAWN_INCOMPLETE', 'E_INPUT_PREPARATION'];
/** The spawn stage's own codes: at the preview they read the preview's fallback. */
const SPAWN_ONLY = ['E_DECISION_STALE', 'E_IDEMPOTENCY_CONFLICT', 'E_PLACEMENT_TAKEN', 'E_INTENT_EXPIRED', 'E_PREFLIGHT_INCOMPLETE', 'E_BACKEND_UNAVAILABLE',
  'E_INSTANCE_GONE', 'E_OUTCOME_UNKNOWN', 'E_SPAWN_INCOMPLETE', 'E_INPUT_PREPARATION'];
const FALLBACK = { preview: 'OATS couldn’t work out this soul’s defaults.', spawn: 'OATS couldn’t complete the spawn.' };
/** What names one client's own controls or places never enters a shared fact. */
const FURNITURE = /Developer settings|Advanced|press Spawn|Press Spawn|Spawn again|press Start|Press Start|Start again|Details|dialog|roster|\babove\b|Reopen|Check result|Workspace view|workspace menu|Schedules/;

test('the next codes are a closed, frozen set', () => {
  assert.deepEqual([...SPAWN_NEXT], ['change-options', 'review-again', 'check-result', 'update-oats', 'choose-workspace', 'sync-workspace', 'details',
    'retire', 'view-schedules', 'open-from-list']);
  assert.ok(Object.isFrozen(SPAWN_NEXT));
  assert.throws(() => { SPAWN_NEXT.push('x'); }, TypeError);
});

test('every code of the table has a fact, at both stages, and a next from the set or none', () => {
  for (const stage of ['preview', 'spawn']) {
    for (const code of CODES) {
      // A missing harness with a message is said in the kernel's words (its own test, below): here, the table's.
      const message = code === 'E_HARNESS_UNAVAILABLE' ? undefined : 'kernel text';
      const p = spawnProblem({ code, message }, stage);
      assert.equal(p.code, code);
      assert.equal(typeof p.fact, 'string', `${stage} ${code}`); assert.ok(p.fact.length > 0);
      assert.match(p.fact, /[.…]$/, `${stage} ${code}: a whole sentence`);
      assert.ok(p.next === null || SPAWN_NEXT.includes(p.next), `${stage} ${code}: ${p.next}`);
      assert.doesNotMatch(p.fact, FURNITURE, `${stage} ${code}: no client's furniture in the shared fact`);
      assert.doesNotMatch(p.fact, /kernel text/, 'the kernel\'s message stays in detail');
      assert.equal(p.detail, message ? `${code} · ${message}` : code);
      if (stage === 'preview' && SPAWN_ONLY.includes(code)) assert.deepEqual([p.fact, p.next], [FALLBACK.preview, 'details']);
      else if (!['E_CLI_FAILED', 'E_CLI_PROTOCOL', 'E_CLI_OUTPUT_LIMIT'].includes(code)) assert.notEqual(p.fact, FALLBACK[stage], `${stage} ${code} has its own fact`);
    }
  }
});

test('some facts and next codes, as a client reads them', () => {
  const read = (code, stage = 'spawn') => { const p = spawnProblem({ code }, stage); return [p.fact, p.next]; };
  assert.deepEqual(read('E_BRANCH_EXISTS'), ['That branch already exists.', 'change-options']);
  assert.deepEqual(read('E_OUTCOME_UNKNOWN'), ['We couldn’t confirm whether the instance was created.', 'check-result']);
  assert.deepEqual(read('E_DECISION_STALE'), ['Something changed before the spawn went through. Nothing was created.', 'review-again']);
  assert.deepEqual(read('E_INTENT_EXPIRED'), ['This spawn request expired. Check the instance list before spawning again.', null]);
  assert.deepEqual(read('E_CLONE_MISSING'), ['This soul’s repository isn’t cloned on this machine yet. Clone it, then try again.', 'details']);
  assert.deepEqual(read('E_PACKAGE_MISSING', 'preview'), ['A package this soul uses isn’t installed yet.', 'sync-workspace']);
  assert.deepEqual(read('E_SOUL_UNKNOWN', 'preview'), ['This soul isn’t in the workspace anymore. Sync the workspace and try again.', null]);
  assert.deepEqual(read('E_CLI_TIMEOUT', 'preview'), ['OATS took too long to work out this soul’s defaults. Try again.', null]);
  assert.deepEqual(read('E_CLI_TIMEOUT'), ['OATS took too long to answer. The instance may already exist.', 'check-result']);
});

test('a code the tables do not know, and the Desktop-only codes, read the stage\'s fallback with their own code', () => {
  for (const stage of ['preview', 'spawn']) {
    for (const code of ['E_SOMETHING_NEW', 'E_FORBIDDEN_FRAME', 'E_PLAN_REQUIRED']) {
      const p = spawnProblem({ code }, stage);
      assert.deepEqual([p.fact, p.next, p.code], [FALLBACK[stage], 'details', code]);
    }
    const none = spawnProblem(null, stage);
    assert.deepEqual([none.fact, none.next, none.code, none.detail], [FALLBACK[stage], 'details', 'E_CLI_FAILED', 'E_CLI_FAILED']);
  }
});

test('the kernel\'s own words stay the fact, with no next: a missing harness, and the unmatched preference\'s kernel parts', () => {
  const harness = spawnProblem({ code: 'E_HARNESS_UNAVAILABLE', message: 'Pi is not installed.', fix: 'Install pi.' }, 'spawn');
  assert.deepEqual([harness.fact, harness.next], ['Pi is not installed: Install pi.', null]);
  const fallback = spawnProblem({ code: 'E_HARNESS_UNAVAILABLE' }, 'spawn');
  assert.deepEqual([fallback.fact, fallback.next], ['The harness this soul would run isn’t installed on this machine.', 'change-options']);
  const LEAD = 'This machine’s launch preferences name a soul this workspace doesn’t offer, so OATS won’t choose a launch for this soul.';
  const WHOLE = `${LEAD} To spawn now, pick a harness or a launch configuration for this spawn. To fix it for every spawn, correct the preference.`;
  const reason = { code: 'E_LAUNCH_PREFERENCE_UNMATCHED', message: 'souls.launch names "ghost".', fix: 'Remove it from oats-local.yaml.' };
  const atPreview = spawnProblem(reason, 'preview');
  assert.deepEqual([atPreview.fact, atPreview.next, atPreview.detail], [LEAD, 'change-options', 'E_LAUNCH_PREFERENCE_UNMATCHED']);
  assert.deepEqual(atPreview.kernel, { message: reason.message, fix: reason.fix });
  // Everywhere else the whole sentence is shared: nothing in it names a client's controls.
  const atSpawn = spawnProblem(reason, 'spawn');
  assert.deepEqual([atSpawn.fact, atSpawn.next], [WHOLE, null]); assert.deepEqual(atSpawn.kernel, atPreview.kernel);
  for (const stage of ['preview', 'spawn']) {
    const noFix = spawnProblem({ code: reason.code, message: reason.message }, stage);
    assert.deepEqual([noFix.fact, noFix.next, noFix.kernel], [WHOLE, null, undefined]);
  }
});

test('a rolled-back spawn\'s fact is whole; one whose cleanup is owed names retire, with its instance', () => {
  const back = rolledBackProblem({ code: 'E_INTERRUPTED', message: 'hook log /x' }, 'dev-2');
  assert.deepEqual([back.fact, back.next], ['The spawn of dev-2 was interrupted while its worktree was being set up, and was rolled back. Nothing was created.', null]);
  assert.equal(rolledBackProblem({ code: 'E_REQUIRED_HOOK_FAILED' }, 'dev-2').fact, 'A capability couldn’t set up the worktree for dev-2, so the spawn was rolled back. Nothing was created.');
  const owed = cleanupOwedProblem({ code: 'E_REQUIRED_HOOK_FAILED', message: 'hook log /y' }, 'dev-2');
  assert.deepEqual([owed.fact, owed.next, owed.instance], ['The spawn of dev-2 was stopped, but its cleanup didn’t finish.', 'retire', 'dev-2']);
  assert.equal(owed.detail, 'E_REQUIRED_HOOK_FAILED · hook log /y');
  assert.equal(cleanupOwedProblem({ code: 'E_BRANCH_EXISTS' }, 'dev-2'), null);
});

test('outcomeWords: each kind\'s fact and next', () => {
  const words = (kind, view) => outcomeWords(kind, view, 'dev-2');
  assert.deepEqual(words('created', { status: 'complete', receipt: { launched: true } }), { fact: 'Created dev-2.', next: null });
  assert.deepEqual(words('created', { status: 'complete', receipt: { launched: false } }), { fact: 'Created dev-2 — not launched.', next: 'open-from-list' });
  // A wake whose outcome is unknown: the boundary's message ends in the Desktop's "check Schedules", which is
  // view-schedules here; one that was not saved is the reason's own words.
  const UNKNOWN_WAKE = { status: 'partial', receipt: { launched: true }, reason: { code: 'E_WAKE_OUTCOME_UNKNOWN', message: WAKE_OUTCOME_UNKNOWN } };
  assert.deepEqual(words('created', UNKNOWN_WAKE), { fact: 'Agent created; wake outcome unavailable.', next: 'view-schedules' });
  assert.deepEqual(words('created', { status: 'partial', receipt: { launched: true }, reason: { code: 'E_WAKE_SAVE_FAILED', message: 'The agent was created, but its wake schedule was not saved.' } }),
    { fact: 'The agent was created, but its wake schedule was not saved.', next: 'view-schedules' });
  assert.deepEqual(words('created', { status: 'incomplete', incomplete: { instance: 'dev-2' } }),
    { fact: 'dev-2 was created but didn’t finish starting. Open it from the instance list instead of spawning again.', next: null });
  assert.deepEqual(words('not-yet-visible'), { fact: 'Created dev-2 — not yet visible as a running session.', next: 'open-from-list' });
  assert.deepEqual(words('pending-expired'), { fact: 'The spawn is still running.', next: 'check-result' });
  assert.deepEqual(words('cleanup-owed', { reason: { code: 'E_INTERRUPTED' } }), { fact: 'The spawn of dev-2 was stopped, but its cleanup didn’t finish.', next: 'retire' });
  assert.deepEqual(words('rolled-back', { reason: { code: 'E_INTERRUPTED' } }),
    { fact: 'The spawn of dev-2 was interrupted while its worktree was being set up, and was rolled back. Nothing was created.', next: null });
  assert.deepEqual(words('never-submitted'), { fact: 'That spawn was never submitted.', next: 'review-again' });
  assert.deepEqual(words('drifted'), { fact: 'These values changed since you last looked.', next: 'review-again' });
  // Words that are a reason's: the client asks spawnProblem for the outcome's reason.
  assert.equal(words('unknown'), null); assert.equal(words('refused'), null);
  const VIEWS = [{ status: 'complete', receipt: { launched: false } }, { status: 'complete', receipt: { launched: true } }, UNKNOWN_WAKE,
    { status: 'incomplete', incomplete: { instance: 'dev-2' } }, { reason: { code: 'E_INTERRUPTED' } }];
  for (const kind of ['created', 'not-yet-visible', 'pending-expired', 'cleanup-owed', 'rolled-back', 'never-submitted', 'drifted']) {
    for (const view of VIEWS) {
      const w = words(kind, view);
      if (!w) continue;
      assert.ok(w.next === null || SPAWN_NEXT.includes(w.next)); assert.doesNotMatch(w.fact, FURNITURE, `${kind} ${JSON.stringify(view)}`);
    }
  }
});
