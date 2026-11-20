/**
 * The error codes the shared home writes itself: names of the kernel's shape (`E_` and capitals) that the
 * kernel's code does not write. A client reads them in the same places as the kernel's codes, and several
 * carry behaviour, so a kernel code that took one of these names would be read as the client's own.
 *
 * test/client-own-codes.test.mjs holds the list both ways: no name here is written in the kernel's code,
 * and every name of that shape written in this directory is here or is the kernel's. So a code of the
 * client's own that a table or a reader gains is added here in the same change. Nothing reads the list
 * when the client runs.
 */
export const CLIENT_OWN_CODES = Object.freeze([
  // The CLI, and the call that carries its answer.
  'E_CLI_FAILED', 'E_CLI_OUTPUT_LIMIT', 'E_CLI_PROTOCOL', 'E_CLI_TIMEOUT', 'E_CLI_UNAVAILABLE',
  // Reading a deployment, a workspace and another machine's roster.
  'E_CAPABILITY_SHOW_FEATURE', 'E_DEPLOYMENT_BUSY', 'E_DEPLOYMENT_FEATURE', 'E_DEPLOYMENT_SCOPE', 'E_DEPLOYMENT_STALE',
  'E_REMOTE_ROSTER', 'E_WORKSPACE_FEATURE', 'E_WORKSPACE_UNKNOWN',
  // This computer's deployments list (#1390): a CLI without it.
  'E_DEPLOYMENTS_FEATURE',
  // The machine's session resume sweep (#1559): a CLI without it.
  'E_RESUME_FEATURE',
  // A spawn: its preview, its apply and the wake saved with it; a suggest read a newer one ended (E_SUPERSEDED, #1421 §3).
  'E_APPLY_UNAVAILABLE', 'E_BACKEND_UNAVAILABLE', 'E_BUSY', 'E_FORBIDDEN_FRAME', 'E_INPUT_PREPARATION', 'E_INSTANCE_GONE',
  'E_INTENT_EXPIRED', 'E_OUTCOME_UNKNOWN', 'E_PREFLIGHT_INCOMPLETE', 'E_PREVIEW_UNAVAILABLE', 'E_SUPERSEDED', 'E_TARGET_CHANGED',
  'E_UNSUPPORTED_OPTION', 'E_WAKE_OUTCOME_UNKNOWN', 'E_WAKE_SAVE_FAILED',
  // Stop, start, restart and remove, and the plan a person confirms (a spawn's plan too).
  'E_LIFECYCLE_UNAVAILABLE', 'E_OPTION_UNAVAILABLE', 'E_PLAN_CHANGED', 'E_PLAN_EXPIRED', 'E_PLAN_LIMIT', 'E_PLAN_REQUIRED',
  'E_HOME_UNVERIFIED', 'E_START_UNCONFIRMED',
  // The warm reader's client (packages/client/warm-reader.mjs): why a reader stopped answering, or never started.
  // E_READER_STALE and E_READER_DEFECT are the reader's own refusal codes, the kernel's, and not here.
  'E_READER_EXIT', 'E_READER_HELLO_TIMEOUT', 'E_READER_MISMATCH', 'E_READER_OUTPUT_LIMIT', 'E_READER_PATH', 'E_READER_TIMEOUT',
  // keys.json (packages/client/keys-file.mjs): a write that could not keep every key, so none is made.
  'E_KEYS_UNWRITABLE',
  // An instance's Activity.
  'E_EVENTS_UNAVAILABLE', 'E_NOT_IN_SCOPE',
  // A terminal.
  'E_TERM_ATTACHMENT_FAILED', 'E_TERM_ATTACHMENT_INTERRUPTED', 'E_TERM_BAD_ARGS', 'E_TERM_BUSY', 'E_TERM_CAP',
  'E_TERM_CLOSE_PENDING', 'E_TERM_CLOSING', 'E_TERM_CONTEXT_CHANGED', 'E_TERM_FORBIDDEN_FRAME', 'E_TERM_INPUT_LIMIT',
  'E_TERM_LEASE', 'E_TERM_NOT_READY', 'E_TERM_OPEN_FAILED', 'E_TERM_OUTPUT_LIMIT', 'E_TERM_PREPARE_TIMEOUT',
  'E_TERM_READY_TIMEOUT', 'E_TERM_REMOTE_GONE', 'E_TERM_REMOTE_NO_ANSWER', 'E_TERM_REMOTE_NO_SSH',
  'E_TERM_REMOTE_UNREACHABLE', 'E_TERM_REUSED', 'E_TERM_TRANSPORT',
].sort());
