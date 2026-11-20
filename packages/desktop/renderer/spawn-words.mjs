/** The Desktop's words for a spawn's problems and outcomes (#855, 6b-2). The shared home says what happened
 * (packages/client/spawn-messages.mjs: a problem's `fact`, an outcome's `outcomeWords`) and names the act that
 * follows as a `next` code; the words for that act are the Desktop's, because they name its controls (Developer
 * settings, the Spawn and Check result buttons, Details, the roster, Reopen spawn). Every sentence composed here
 * is the one the Desktop showed before the split, byte for byte (test/spawn-words.test.mjs pins them). */
import { outcomeWords } from '../../client/spawn-messages.mjs';

/** The Desktop-only codes, which no other client meets: the window guard, and the HTTP route's body check
 * (said at a press; at the preview it reads the general failure, as it always did). */
const OWN = { E_FORBIDDEN_FRAME: 'This window can’t start a spawn.' };
const OWN_AT_SPAWN = { E_PLAN_REQUIRED: 'Check the values and press Spawn to confirm.' };

/** The Desktop's words for each `next`, after the fact. change-options has none of its own: its words are the code's. */
const NEXT = Object.freeze({
  'review-again': 'Check the values and press Spawn again.',
  'check-result': 'Use Check result before spawning again.',
  'update-oats': 'Update OATS, then open this dialog again.',
  'choose-workspace': 'Choose it again from the workspace menu.',
  'sync-workspace': 'Run Sync in the Workspace view.',
  details: 'Try again, or see Details.',
  retire: instance => `Retire ${instance} from the roster to complete it.`,
});
/** Where the words differ by code: the option to change (change-options) is named by its control. */
const CHOOSE_ANOTHER = 'Choose another in Developer settings.';
const BY_CODE = Object.freeze({
  E_BAD_ARGS: 'Check the name and Developer settings.',
  E_CHILD_SPAWNS_DISABLED: 'Pick another one, or choose None.',
  E_BRANCH_EXISTS: 'Choose another branch in Developer settings.',
  E_BASE_UNKNOWN: 'Check it in Developer settings.',
  E_LAUNCH_ENV_MISSING: CHOOSE_ANOTHER,
  E_LAUNCH_EXECUTABLE: CHOOSE_ANOTHER,
  E_LAUNCH_PROBE_UNSUPPORTED: CHOOSE_ANOTHER,
  E_LAUNCH_CONFIG_UNKNOWN: CHOOSE_ANOTHER,
  E_BACKEND_UNAVAILABLE: CHOOSE_ANOTHER,
  E_LAUNCH_CONFIG_AMBIGUOUS: 'Choose one under Launch configuration in Developer settings.',
  E_HARNESS_UNAVAILABLE: 'Install it, or pick another harness above.',
  // Read only where the controls are above it and Details quote the kernel (the preview, with its fix).
  E_LAUNCH_PREFERENCE_UNMATCHED: 'To spawn now, pick a harness above, or a launch configuration in Developer settings. To fix it for every spawn, correct the preference (Details).',
});
/** Sentences that go on after a dash, in lower case: the fact's full stop gives way to " — ". Each is said for
 * its own `next` only: where the code reads another fact (a spawn's code at the preview), the general words follow. */
const DASHED = Object.freeze({
  E_DECISION_STALE: ['review-again', 'check the updated values and press Spawn again.'],
  E_IDEMPOTENCY_CONFLICT: ['review-again', 'check the updated values and press Spawn again.'],
  E_PLACEMENT_TAKEN: ['review-again', 'check the new name and press Spawn again.'],
  E_CLI_TIMEOUT: ['check-result', 'use Check result before spawning again.'],
  E_CLONE_MISSING: ['details', 'Details shows how.'],
  E_SANDBOX_PLACEMENT: ['details', 'Details says what to do instead.'],
});
const joined = (fact, words, dashed = false) => !words ? fact : dashed ? `${fact.replace(/\.$/, '')} — ${words}` : `${fact} ${words}`;

/** The Desktop's sentence for a problem (spawnProblem, rolledBackProblem, cleanupOwedProblem): the fact, then the
 * Desktop's words for its `next`. `stage` is the one the problem was made for ('preview' or 'spawn', as spawnProblem). */
export function spawnText(problem, stage = 'preview') {
  const own = OWN[problem?.code] ?? (stage === 'spawn' ? OWN_AT_SPAWN[problem?.code] : undefined);
  if (own) return own;
  const { fact, next, code } = problem;
  if (!next) return fact;
  if (Object.hasOwn(DASHED, code) && DASHED[code][0] === next) return joined(fact, DASHED[code][1], true);
  if (next === 'retire') return joined(fact, NEXT.retire(problem.instance));
  if (next === 'change-options') return joined(fact, Object.hasOwn(BY_CODE, code) ? BY_CODE[code] : null);
  return joined(fact, NEXT[next] ?? null);
}

/** The Desktop's words after an outcome's fact, by where it says them: the background store's notice, or the
 * dialog's own status line. view-schedules is the notice's button, and words only for a wake whose outcome is
 * unknown, which goes on after a dash, as the boundary said it. */
const OUTCOME = Object.freeze({
  notice: { drifted: 'Reopen spawn to check them.', 'never-submitted': 'Reopen spawn to spawn with these values.',
    'pending-expired': 'Check result again in a moment; nothing else was started.',
    created: 'Open its session from the roster.', 'not-yet-visible': 'Open it from the roster when it appears.' },
  dialog: { drifted: 'Check them and press Spawn again.', 'never-submitted': 'Press Spawn to spawn with the values shown.' },
});
/** The Desktop's sentence for a transaction outcome (outcomeWords), in the store's notice or the dialog ('notice' | 'dialog'). */
export function outcomeText(kind, view, instance, where = 'notice') {
  const words = outcomeWords(kind, view, instance);
  if (!words) return null;
  if (words.next === 'view-schedules' && view?.reason?.code === 'E_WAKE_OUTCOME_UNKNOWN') return joined(words.fact, 'check Schedules', true);
  if (!words.next || words.next === 'view-schedules') return words.fact;
  if (words.next === 'retire') return joined(words.fact, NEXT.retire(instance));
  return joined(words.fact, OUTCOME[where][kind] ?? null);
}
