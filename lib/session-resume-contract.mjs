/** The names of the session-resume contract (feature session-resume, #1559): the strings a client
 *  reads in `sessionEnd`, in a `session start --resume` answer's `resume` object and in the rows of
 *  `oats session resume` (docs/desktop-cli-api.md). Both product sides settle them together
 *  (awebai/oats#1567): every producer, reader, test and doc takes them from here, so a change is made
 *  in one place. Each shape has one producer: `sessionEnd` lib/session-end.mjs `sessionEndOf`; the
 *  start's `resume` object lib/core.mjs `resumeAnswer`; the sweep's rows lib/session-resume.mjs
 *  (`rowFromStart`, `predicted` and the rows it answers without a start). Dependency-free. */

export const SESSION_RESUME_FEATURE = "session-resume";

/** `sessionEnd` on an `oats status --json` row of a launched home that does not run. */
export const SESSION_END = Object.freeze({ LOST: "lost", STOPPED: "stopped", EXITED: "exited" });

/** `resume.reason` of a start that opened a fresh conversation instead of continuing one; a sweep
 *  row `fresh` carries it as its `reason`. */
export const FRESH_REASON = Object.freeze({ NO_CONVERSATION: "no-conversation", NO_RECEIPTS: "no-receipts", RESUME_UNPROVEN: "resume-unproven" });

/** `resume.waiting` of a start that succeeded and waits for its human. */
export const RESUME_WAITING = Object.freeze({ RESUME_CONFIRMATION: "resume-confirmation" });

/** A sweep row's `outcome`. */
export const OUTCOME = Object.freeze({ RESUMED: "resumed", FRESH: "fresh", ALREADY_RUNNING: "already-running", SKIPPED: "skipped", BLOCKED: "blocked", REFUSED: "refused" });

/** A sweep row's `reason`, beside FRESH_REASON's for `fresh`. */
export const ROW_REASON = Object.freeze({
  UNKNOWN: "unknown", START_BUSY: "start-busy", NOT_LOST: "not-lost", NOT_SEEN_RECENTLY: "not-seen-recently",
  RESUME_CONFIRMATION: RESUME_WAITING.RESUME_CONFIRMATION, LAUNCH_PROMPT: "launch-prompt",
  START_REFUSED: "start-refused", START_REFUSED_RETRYING: "start-refused-retrying", KEEPS_GETTING_LOST: "keeps-getting-lost",
  LIFECYCLE_BUSY: "lifecycle-busy",
});

/** `deployments[].reason` of a deployment the sweep did not sweep. */
export const NOT_SWEPT = Object.freeze({ NOT_OK: "not-ok", UNREADABLE: "unreadable" });
