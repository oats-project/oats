/** Kernel error with a stable machine-readable code (contract §4) and optional provenance. */
export function oatsError(code, message, provenance) {
  const e = new Error(message);
  e.code = code;
  if (provenance) e.provenance = provenance;
  return e;
}

/** Whether `code` has the shape of a kernel code (`E_` and upper-case letters, digits and
 *  underscores): the only codes an answer of the kernel carries. It tests the shape, not a list of
 *  known codes, and that is enough: no dependency of the kernel gives an error whose code has that
 *  shape, and neither does the system (`ENOENT`) or Node (`ERR_…`). An allow-list on purpose: what
 *  is not a kernel code is wrapped (asKernelError), whatever it is, so the next unknown code does
 *  not pass. */
export function isKernelCode(code) {
  return typeof code === "string" && /^E_[A-Z0-9_]+$/.test(code);
}
/** The two failures the kernel answers under their own names, which are not kernel codes: an OATS
 *  document with an unsafe mapping key, or value. Every command answers them so, and they are the
 *  one exception to the rule above: no door wraps them. */
export const OWN_NAME_FAILURES = new Set(["unsafe-config-key", "unsafe-config-value"]);
/** Whether `code` is one an answer carries as it is: a kernel code, or one of the two names. */
export function isAnswerCode(code) {
  return isKernelCode(code) || OWN_NAME_FAILURES.has(code);
}
/** The code `e` is answered with: its own when an answer carries it (isAnswerCode), else `fallback`. */
export function kernelCode(e, fallback) {
  return isAnswerCode(e?.code) ? e.code : fallback;
}
/** Whether `e` is a defect: something thrown by a mistake in the code, never written as an answer.
 *  It has no code, and it is one of the language's own error kinds, whose `name` is not "Error"
 *  (TypeError, ReferenceError, RangeError, SyntaxError…), or it is a thrown value that is no Error
 *  at all. A plain Error without a code is NOT one: the kernel writes many of its refusals that way,
 *  and a child process that exits non-zero (a tmux or git call) is reported that way too. */
export function isDefect(e) {
  if (typeof e?.code === "string" && e.code) return false;
  return !(e instanceof Error) || e.name !== "Error";
}
/** What an answer's `details.cause` says of an error that is not the kernel's: `{ code, syscall? }`
 *  for one that has a code (the system's, Node's, or one of the kernel's own names that is not a
 *  kernel code), `{ name }` for a defect (isDefect), and undefined for a plain Error without a
 *  code: a refusal has no cause to name, and its answer is the general code and its message alone. */
export function errorCause(e) {
  if (typeof e?.code === "string" && e.code) return { code: e.code, ...(typeof e.syscall === "string" && e.syscall ? { syscall: e.syscall } : {}) };
  if (!isDefect(e)) return undefined;
  return { name: e instanceof Error && typeof e.name === "string" && e.name ? e.name : "Error" };
}
/** The details of a spawn's refusal, by its code: the codes whose answer had details of its own
 *  before a spawn went through the door (awebai/oats#1047), each with exactly the keys it had. Every
 *  other code, and an error with none, carries the error's details only when `unconfirmed` is true
 *  (spawnFailedDetails): never a `home` taken from the error, which a consumer reads as retained
 *  effects. The table decides details, never the code. */
const hookReceipt = (e) => ({ hooks: e.details?.hooks ?? [], ...(e.details?.unconfirmed === true ? { unconfirmed: true } : {}) });
const SPAWN_REFUSAL_DETAILS = Object.freeze({
  // A launch refusal is a fact about the selection: its own details, as the `E_LAUNCH_…` family's.
  E_MODEL_UNKNOWN: (e) => e.details,
  E_UNSUPPORTED_HARNESS: (e) => e.details,
  E_HARNESS_UNAVAILABLE: (e) => e.details,
  E_CLAUDE_CONFIG_REMOVED: (e) => e.details,
  E_CHILD_SPAWNS_DISABLED: (e) => ({ parent: e.parent, policy: e.policy }),
  E_BRANCH_EXISTS: () => undefined,
  E_BASE_UNKNOWN: () => undefined,
  // Interrupted while its worktree hooks ran (#796): rolled back, the message says how far.
  E_INTERRUPTED: (e) => e.details,
  // The hooks' receipt (paths only), and `unconfirmed` when the rollback could not confirm its effects.
  E_REQUIRED_HOOK_FAILED: hookReceipt,
  E_HOOK_ENVIRONMENT_CONTRACT: hookReceipt,
  // The observed base could not be fetched into the clone: the clone, the repository and the commit.
  E_REMOTE_UNREADABLE: (e) => (e.details?.commit ? e.details : spawnFailedDetails(e)),
  // K6b: the fresh decision travels with the refusal, so a client previews again.
  E_DECISION_STALE: (e) => ({ decision: e.decision }),
  E_IDEMPOTENCY_CONFLICT: (e) => ({ instance: e.instance, home: e.home }),
  E_PLACEMENT_TAKEN: (e) => ({ instance: e.instance, home: e.home }),
  E_INSTANCE_NAME_TAKEN: (e) => ({ instance: e.instance, home: e.home ?? null, ...(e.session ? { session: e.session } : {}) }),
  E_INSTANCE_NAME_INVALID: (e) => e.details,
  E_SPAWN_INCOMPLETE: (e) => ({ ...e.details, instance: e.instance, home: e.home, launched: e.launched }),
});
const spawnFailedDetails = (e) => (e?.details?.unconfirmed === true ? e.details : undefined);
/** The `details` of the answer to an error `e` of `oats spawn` (bin/oats.mjs spawnFail): the table's
 *  for a code it holds, a launch refusal's own (`E_LAUNCH_…`), else spawnFailedDetails. */
export function spawnRefusalDetails(e) {
  const code = kernelCode(e, null);
  if (code && Object.hasOwn(SPAWN_REFUSAL_DETAILS, code)) return SPAWN_REFUSAL_DETAILS[code](e);
  if (code?.startsWith("E_LAUNCH_")) return e.details;
  return spawnFailedDetails(e);
}
/** `e` as a kernel error. One whose code an answer carries (isAnswerCode) is returned as it is. Any other is wrapped:
 *  the code `fallback`, `message` (default: its own), `details.cause` when it has one (errorCause)
 *  and the error itself as `cause`, so that whoever prints the answer still has a defect's stack. */
export function asKernelError(e, fallback, message) {
  if (isAnswerCode(e?.code)) return e;
  const wrapped = new Error(message ?? String(e?.message ?? e), { cause: e });
  wrapped.code = fallback;
  const cause = errorCause(e);
  if (cause) wrapped.details = { cause };
  return wrapped;
}
/** The defect (isDefect) that `e` is or wraps (asKernelError), as `{ thrown }`, else undefined: the
 *  one error whose stack an answer must not swallow. It is boxed because anything can be thrown,
 *  `undefined`, `null`, `0` and `""` included: whether there is a defect is not whether its value
 *  is truthy. A wrapper holds what it wrapped as its own `cause`, whatever that value is. */
export function defectOf(e) {
  const thrown = isKernelCode(e?.code) && e.details?.cause && Object.hasOwn(e, "cause") ? e.cause : e;
  return isDefect(thrown) ? { thrown } : undefined;
}
/** Print on stderr the defect `e` is or wraps (defectOf), when there is one: its stack, or, for a
 *  thrown value that is no Error and so has none, a line that shows the value. For whoever ends an
 *  error's way up: the door that answers it, and a caller that turns it into data (a row of a
 *  stop's results), after which nobody else can print it. */
export function reportDefect(e) {
  const defect = defectOf(e);
  if (!defect) return;
  const { thrown } = defect;
  process.stderr.write(`${thrown instanceof Error ? thrown.stack || String(thrown) : `A value that is no Error was thrown: ${shownValue(thrown)}`}\n`);
}
/** A thrown value that is no Error, as one can read it in a log: a string quoted, anything else as
 *  the language prints it. */
function shownValue(value) {
  try { return typeof value === "string" ? JSON.stringify(value) : String(value); } catch { return `a ${typeof value} that cannot be printed`; }
}

/** What `error.details.holder` of an E_LIFECYCLE_BUSY says, a closed list (docs/desktop-cli-api.md):
 *  "running": the kernel established that a process with the recorded pid and start time is alive,
 *  and waiting ends it when that process is the `oats` command its file names (the kernel does
 *  not establish that it is: a claim's refusal says what to check when it does not end,
 *  ifItDoesNotEnd); "unknown": whether one still runs cannot be read; "none": nobody is running,
 *  and what a dead command left has to be dealt with. */
export const BUSY_HOLDERS = Object.freeze(["running", "unknown", "none"]);
/** What a refusal says it did not do once something was ended before it (afterEndedSteps): then
 *  the words of every verb, in place of its own ("nothing was done", "nothing was stopped", "no
 *  tree was made"), which are true only before any effect. */
export const NOTHING_ELSE = "nothing else was done";
/** What a refusal's sentence says was not done: `own`, the verb's words, before any effect, and
 *  NOTHING_ELSE when `ended` names what was ended first. Whoever writes the sentence asks here: no
 *  message is rewritten after it was made. */
export function nothingAfter(ended, own = "nothing was done") {
  return ended?.length ? NOTHING_ELSE : own;
}
/** The answers afterEndedSteps made: one is never made twice. */
const answeredAfterEndedSteps = new WeakSet();
/** `refusal` as it is answered when `ended` names what was ended before it (clauses, in order: a
 *  takeover ends the step a dead holder recorded, lib/claim.mjs). With none, `refusal` as it is.
 *  With some it is no answer before any effect, whatever its code says: E_LIFECYCLE_FAILED, the
 *  clauses first, then `after that:` and the refusal's own sentence, with its details and its
 *  `cause`. Its sentence was written knowing `ended` (nothingAfter): nothing in it is replaced. */
export function afterEndedSteps(ended, refusal) {
  if (!ended?.length || answeredAfterEndedSteps.has(refusal)) return refusal;
  const failed = oatsError("E_LIFECYCLE_FAILED", `${ended.join("; ")}; after that: ${String(refusal?.message ?? refusal)}`);
  if (refusal?.details) failed.details = refusal.details;
  // Its own `cause`, whatever the value: a wrapper holds what it wrapped there, and a thrown
  // `undefined` is a defect whose report (defectOf) reads it from that property.
  if (refusal && Object.hasOwn(refusal, "cause")) failed.cause = refusal.cause;
  answeredAfterEndedSteps.add(failed);
  return failed;
}
/** E_LIFECYCLE_BUSY, the one way the kernel makes it (test/lifecycle-busy-holder.test.mjs pins that
 *  no site raises the code any other way): `said` is the refusal, one line that states its
 *  effects; `remedy` is the step that ends it, and the message is `<said> — <remedy>`. For
 *  "unknown" and "none" waiting ends nothing, so a remedy is required: the process to check, the
 *  file to inspect, the command to run. `details.holder` is `holder`, whatever `details` holds.
 *  `ended` is what was ended before this refusal, for the one caller that can have ended
 *  something (a claim's takeover): with it the code would say what is no longer true, and the
 *  answer is afterEndedSteps's, the same sentence and details after what was ended. `said` was
 *  written for it (nothingAfter). */
export function lifecycleBusy(holder, said, remedy, details, ended) {
  if (!BUSY_HOLDERS.includes(holder)) throw new TypeError(`lifecycleBusy: holder is ${JSON.stringify(holder)}, not one of ${BUSY_HOLDERS.join(", ")}`);
  const step = typeof remedy === "string" ? remedy.trim() : "";
  if (!step && holder !== "running") throw new TypeError(`lifecycleBusy: an answer whose holder is "${holder}" names the step that ends it`);
  return afterEndedSteps(ended, Object.assign(oatsError("E_LIFECYCLE_BUSY", step ? `${said} — ${step}` : said), { details: { ...details, holder } }));
}

/** The step that ends a refusal for "this process's start time cannot be read": the check a person
 *  runs in a shell, of the read the refusal's own reason names (lib/worktree-hooks.mjs readStart:
 *  /proc/<pid>/stat where there is a procfs, else the system `ps` with both columns). It sends
 *  nobody to the pid of the refused command, which is gone when the answer is read: `$$` is the
 *  reader's shell. */
export const OWN_START_REMEDY = "check by hand, in a shell on this host, the read that the reason names (`cat /proc/$$/stat` where there is a /proc; elsewhere `PATH=/usr/bin:/bin ps -o lstart= -o stat= -p $$`, which must print a start time and a state), then run the command again";

/** The check that ends a refusal naming, by its pid, the holder of the file `at`, when that process
 *  is not the command it is taken for (`what`, with its article: "an oats retire"). What the
 *  kernel establishes of a holder is that a process with the recorded pid and start time is alive,
 *  or that this cannot be read; never that the process is that command: the file can name any
 *  process. One text of the check: the whole step for a holder whose liveness cannot be read, and
 *  what follows for one that runs and does not end (ifItDoesNotEnd). */
export const checkHolderByHand = (what, at) => `check that pid by hand, and if it is not ${what}, remove ${at}, then retry`;
/** The step for a holder that runs, when waiting for it has not ended the refusal (checkHolderByHand). */
export const ifItDoesNotEnd = (what, at) => `if it does not end, ${checkHolderByHand(what, at)}`;

/** Per verb, the codes that verb answers only BEFORE any effect: a client reads each as "refused,
 *  nothing happened". The rule holds by construction, at the place of each verb that knows how far
 *  it got (lib/core.mjs retireFailure, lib/instance-lifecycle.mjs applyStop): a listed code raised
 *  after the verb's first effect is never answered (afterFirstEffect). The docs table of
 *  docs/desktop-cli-api.md is checked against this constant, and a client's own set must lie
 *  inside it (test/lifecycle-before-effect-codes.test.mjs). */
const BEFORE_EFFECT = Object.freeze(["E_BAD_ARGS", "E_USAGE", "E_PLAN_STALE", "E_INSTANCE_RETIRING", "E_LIFECYCLE_BUSY", "E_HOME_MISMATCH", "E_SESSION_UNKNOWN",
  "E_AMBIGUOUS_INSTANCE", "E_UNIDENTIFIED_INSTANCE_HOME", "E_REMOTE_INCOMPATIBLE", "E_AMBIGUOUS", "E_SNAPSHOT_UNKNOWN"]);
export const BEFORE_EFFECT_CODES = Object.freeze({ "instance stop": BEFORE_EFFECT, retire: BEFORE_EFFECT });
/** The defect afterFirstEffect makes. Its name is on the prototype, so that it is in the stack's
 *  first line whenever the engine writes that line (some write it when the error is made). */
class LateRefusal extends Error {}
LateRefusal.prototype.name = "LateRefusal";
/** `e` as `verb` ("instance stop", "retire") answers it once its first effect has happened, at
 *  `point` (how far it got, in a few words). An error whose code the verb does not list is returned
 *  as it is. A listed one is a kernel defect: its own message says that nothing happened, which is
 *  no longer true. → E_LIFECYCLE_FAILED, `<verb> answered <code> after its first effect (<point>):
 *  <its message>`, its details kept and `details.cause: { name: "LateRefusal" }`. It is a defect
 *  like any other the kernel wraps (asKernelError): whoever ends its way up prints its stack, with
 *  the code it had, on stderr (reportDefect). A net, never an answer: every known place that would
 *  be late has a code of its own. */
export function afterFirstEffect(e, verb, point) {
  if (!BEFORE_EFFECT_CODES[verb]?.includes(e?.code)) return e;
  const late = new LateRefusal(`oats ${verb} answered ${e.code} after its first effect (${point}): ${e.message}`);
  const failed = asKernelError(late, "E_LIFECYCLE_FAILED");
  failed.details = { ...e.details, ...failed.details };
  return failed;
}

/** Herdr was removed in 0.31.0: every place that meets it refuses with E_HERDR_REMOVED, this stem
 *  and what to do. */
export const HERDR_REMOVED = "Herdr is no longer supported by OATS (removed in 0.31.0); tmux is the only session backend.";
/** A flag or configuration value that selects Herdr: `what` names the flag (`--backend herdr was
 *  given`), or the file and key (`<file> sets spawn.backend: herdr`). */
export function herdrSettingRemoved(what) {
  return oatsError("E_HERDR_REMOVED", `${HERDR_REMOVED} ${what}. Remove it (or use tmux).`);
}
/** A session operation on an instance OATS opened in Herdr. */
export function herdrInstanceRemoved(name) {
  return oatsError("E_HERDR_REMOVED", `${HERDR_REMOVED} ${name} was opened in Herdr. Retire it (\`oats retire ${name}\`) and spawn a new instance; it opens in tmux.`);
}
/** Retiring an instance OATS opened in Herdr while processes still work in its home. */
export function herdrInstanceBusy(name, pids) {
  return oatsError("E_HERDR_REMOVED", `${HERDR_REMOVED} ${name} was opened in Herdr. A process still works in this home (pid ${pids.join(", ")}); stop its Herdr pane (for example \`herdr --session oats server stop\`), then retire.`);
}
