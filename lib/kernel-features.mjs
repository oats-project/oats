/** lib/kernel-features.mjs — the kernel features this binary implements: `features` in `version --json`
 *  (the Desktop API v1 probe) and in `status --json` (lib/roster-read.mjs), which a remote roster relays
 *  as the host's (feature server-probe-features, lib/servers.mjs hostFeatures). ONE list for both,
 *  emitted at output time, never stored, and frozen: an answer carries it by reference. A name must pass hostFeatures's check
 *  (test/cli-json-contract.test.mjs). Kernel-private, not exported from `./core`. Dependency-free. */
import { SESSION_RESUME_FEATURE } from "./session-resume-contract.mjs";

/** `oats spawn --task-file -` reads the task from standard input: how a routed spawn's task reaches
 *  its host (lib/servers.mjs routeCommand); a host that does not list this gets it as an argument. */
export const SPAWN_TASK_STDIN_FEATURE = "spawn-task-stdin";
/** Session providers (lib/session-providers.mjs): a session backend a capability supplies, beside the
 *  kernel's built-in ones. A host that lists this takes `--backend <provider>`, records and answers
 *  provider homes; one that does not refuses such a home's session verbs. */
export const SESSION_PROVIDERS_FEATURE = "session-providers";
/** A harness that runs in a provider home OATS recorded stopped is reported on the home's status
 *  row and its remote roster row: `outsideOats` (lib/session-providers.mjs outsideOatsOf). A row
 *  from a kernel that does not list this never carries the key, so its absence says nothing there. */
export const PROVIDER_OUTSIDE_OATS_FEATURE = "provider-outside-oats";
/** A session provider's `check` is handed the model of the launch that is planned (`launch.model`,
 *  only when the launch names one), and what a READY check warned of is relayed in the `warnings`
 *  of a spawn's preview and of a spawn's, a start's and a restart's answer (lib/session-providers.mjs
 *  launchReadiness). A kernel that does not list this hands no model and drops those warnings, so
 *  a provider gates on it what it can only judge from the model. */
export const LAUNCH_MODEL_CHECK_WARNINGS_FEATURE = "launch-model-and-check-warnings";
/** `oats session input` to a tmux home refuses E_SESSION_PROMPT_OPEN, nothing typed, while the
 *  session holds a `permission` claim (lib/core.mjs inputInstanceSession, #2125). On a kernel that
 *  does not list this, such an input is typed and its Enter answers the prompt: a client reads the
 *  refusal as "the prompt is open, nothing was sent" only where the feature is listed. */
export const SESSION_INPUT_PERMISSION_REFUSAL_FEATURE = "session-input-permission-refusal";
/** The kernel's built-in session backends: `sessionBackends` in `oats version --json`. A session
 *  provider is never listed there: it is a capability's, named by the homes and souls that have it. */
export const BUILTIN_SESSION_BACKENDS = Object.freeze(["tmux"]);
/** A session provider's name, and what `--backend` takes. */
export const SESSION_PROVIDER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const KERNEL_FEATURES = Object.freeze(["retire-home", "session-start", "session-restart", "launch-config", "schedule", "schedule-host-caps", "session-upload", "operations", "instance-git", "instance-git-remote", "souls-declarations", "lifecycle-plans", "retire-retention", "readiness", "spawn-preview", "instance-events", "instance-events-2", "schedule-history", "schedule-read-2", "spawn-preview-2", "spawn-idempotency", "spawn-idempotency-2", "spawn-apply-2", "workspace-v2", "instance-modules", "spawn-provider-payload", "served-identity", "packages-no-approval", "spawn-name", "settings-origins", "team-model-3", "settings-declared", "capabilities-private", "layers-from", "harness", "package-souls", "triggers", "automations", "desktop-facts", "launch-preference", "preview-composed-from", "observe-max-age", "spawn-preview-max-age", "launch-config-default", "capability-show", "capture-file", "workspace-identity", "server-connect", "capability-route", "servers-per-workspace", "operator-default-soul", "waiting-on-you", "automation-descriptions", "souls-capabilities", "soul-composed-instructions", "teams-conditional-default", "server-probe-features", "worktree-event", "trigger-sources", "session-attach-detach-key", "lifecycle-kernel-codes", "schedule-run-warnings", "lifecycle-claim-stop", "launch-prompt-dev-channel", "soul-launch", "retire-plan-own-worktree", "spawn-kernel-codes", "soul-skills", "roster-workspace-key", "spawn-apply-max-age", "status-retire-state", "session-inspect-size", "session-inspect-running", "deployments-list", "soul-composed-skills", "instance-color", "spawn-suggest-name", "instance-upgrade", "session-attach-no-status-line", "session-attach-prefix-scroll", "instance-suggest-name", "spawn-apply-suggest-name", SESSION_RESUME_FEATURE, "instance-background", "instance-pin", "instance-same-work", "instance-related-work", "warm-reader", "status-liveness", "lifecycle-claim-start", "wake-hold", "spawn-attribution", "workspace-tasks-payload", "settings-committed-only", "schedule-host-register-only", SPAWN_TASK_STDIN_FEATURE, "instance-board", SESSION_PROVIDERS_FEATURE, PROVIDER_OUTSIDE_OATS_FEATURE, LAUNCH_MODEL_CHECK_WARNINGS_FEATURE, SESSION_INPUT_PERMISSION_REFUSAL_FEATURE]);
/** The agent's board (feature instance-board, lib/instance-board.mjs): `boardApi` in the probe, the board
 *  file and the board commands' answers. */
export const BOARD_API = 1;
/** The warm reader's protocol (`oats reader --stdio`, lib/reader.mjs): `readerApi` in the probe and in the reader's hello. */
export const READER_API = 1;
