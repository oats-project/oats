# Desktop Stop and Retire confirmations

Stop and Retire are consumers of the installed CLI's **lifecycleApi1**. The
Desktop does not implement stopping, ancestry, retention, Git deletion, recovery
or lifecycle policy. It never signals a reported PID or creates a Stop+Retire
recipe. The kernel owns those actions and their per-target outcomes.

## Compatibility and admission

Before any command, require an accepted installed CLI, a real `features` array
containing `lifecycle-plans`, and **`lifecycleApi === 1`**. Retire apply also
requires `retire-retention` and `retire-home`. Neither a version number nor a
trial invocation establishes support: older `retire` ignores unknown `--plan`
and retires. Missing/malformed advertisement means unavailable, zero invocation.

**POST `/api/instance-lifecycle?ws=<id>`** is the only Desktop K3 route. It uses
loopback Host / POST Origin guards, exactly one advertised workspace and no
extra query arguments. The privileged proxy pins the entire body-addressed
instance family. Bodies are strict JSON objects up to64 KiB:

```json
{"action":"plan","operation":"stop","selector":{"instance":"dev-1","agent":"dev","agentsRoot":"/team/agents","server":null},"options":{"recursive":true}}
{"action":"plan","operation":"retire","selector":{"instance":"dev-1","agent":"dev","agentsRoot":"/team/agents","server":null},"options":{"discardWorktree":false}}
{"action":"apply","planRef":"<opaque server reference>"}
```

The selector matches one exact server-owned roster record. Home and scope come
from that record, never request paths. Unknown/duplicate/replaced targets
refuse; no local or old remote fallback. A remote row's plan and apply are
routed by `--server S --home H` (see
[desktop-deployment-model.md](desktop-deployment-model.md#remote-rows)). CLI, argv,
environment, revision/key and apply options cannot be supplied by the renderer.
The old **POST `/api/retire/<name>` returns `E_PLAN_REQUIRED`** before lookup or
invocation, even for remote callers.

Plan payloads validate the exact primary home/name, producer revision, all
bounded target identities, session/work states and ambiguity. Unestablished is
not idle; unobserved work is not clean; nullable comparisons are not zeros.
Ambiguous parent edges are shown as **not included**, with the reason (another
instance has the same parent name): Stop uses `plan.ambiguous`, Retire uses
`plan.facts.ambiguous`.

## Confirmation references, resource bounds and retry

The boundary is the shared home's (`packages/client/instance-lifecycle.mjs`,
`createLifecycleBoundary`): a client makes its own with its own terms, and the
Desktop's backend makes one, in `server/oats-web.mjs`, with `DESKTOP_TERMS`.
Two boundaries share nothing. Every bound below, and the one apply slot, holds
for one client's own requests; between clients, or a client and `oats` run by
hand, the kernel's answers hold (from 0.52.0 a stop and a retire of one home
refuse each other before any effect; a start, `worktree add` and status do not
see a retire in flight, #866). A backend that is replaced (workspace added:
`server-host.mjs` `replace`) starts with an empty boundary, so an open
confirmation's apply answers `E_PLAN_EXPIRED`.

Four distinct plan flights may run concurrently; equal reads coalesce. Each
confirmation gets a **different opaque planRef after that shared read**. A plan
reference binds exact workspace/scope/target, CLI contract, operation, options
and producer revision. At most32 pending references live for5 minutes. Plans
have a128-target total display limit and1 MiB output ceiling; an oversized plan
is refused, never truncated into a smaller executable action. Plan execution
is bounded to30 seconds; proxy35 seconds.

Changing any option obtains a new plan/reference and revokes the old controls.
Retire has one choice, the worktree: deleting it requires an owned worktree.
Retire no longer offers to delete a branch: retirement leaves branches to the
operator, and the kernel refuses the flag. A retire request whose options
hold any other key is refused before a command, and no retire command carries
`--delete-branch`. There is no force/self/keep-dir/grace override or “don't ask
again” shortcut.

On the FIRST explicit confirmation, the server reserves its **one global apply
slot**, mints the idempotency key and freezes the operation. Apply sends only
that reference. Duplicate HTTP attempts share its pending promise or recorded
result; no new key or second native command is created. The CLI receives fixed
argv, absolute binary, shell:false and server scope cwd:

```text
oats instance stop NAME --plan --home HOME --dir SCOPE [--no-recursive] --json
oats retire NAME --plan --home HOME --dir SCOPE --json

oats instance stop NAME --apply --plan-revision REV --idempotency-key KEY \
  --home HOME --dir SCOPE [--no-recursive] --json
oats retire NAME --plan-revision REV --idempotency-key KEY \
  --home HOME --dir SCOPE [--discard-worktree] --json
```

A plan read is a read: it runs in the backend's process group and its deadline
(30 s, 45 s routed) ends it. An apply is a change, and its deadline ends only
the wait (#889): the CLI runs in a session of its own (`detached`; the shared
home's `execFileInSession`, since `execFile` drops the option), with no
timeout and a 4 MiB output bound, so neither a deadline nor a signal to the
client's group (a Ctrl-C, a hang-up) ends it. The boundary waits
`APPLY_WAIT_MS` (600 s; the proxy, 610 s) and then answers `unknown` with
`running: { target, operation, since }` (`since` from the wall clock), keeping
the apply in flight: its reference, its key and its place as the one apply.
Check again on that reference is answered at once, never a second wait; the
late answer, whenever it comes, is kept like any other and repeated. Another
apply meanwhile is refused `E_LIFECYCLE_BUSY` with the same `running`, and no
`details`, so the kernel's busy holder is never read of it; the dialog words
it with `applyRunningSentence`. A CLI that never answers holds the Desktop's
applies until the backend restarts. A start runs in a session of its own too
(`cliStart`), with no deadline: `cliStart` waits `START_WAIT_MS` (60 s) for its
answer and then answers the code `E_START_UNCONFIRMED`, with no words. The
start route words it in the Desktop's own sentence
(`renderer/start-unconfirmed.mjs`: "OATS didn't confirm the start. It may still
be running: check the roster before you start it again."), shown under no
speaker. The start goes on, its output is still read, and an answer after the
wait is not kept (the roster shows the result, and a failed start reads the row
again). The quit path sends these children no
signal (`backend-quit-children.test.mjs`); `test/client-own-session.test.mjs`
holds the own session with real processes. At most 32 settled or
uncertain results are kept for 30 minutes, without expiring an in-flight action.
This is a bounded process-local transaction record, not a persistent journal.
A repeated cached result is marked `repeated`; it does not rewrite the kernel's
`replayed` fact. Replay of a recorded Retire result never resolves a newly
created same-name home. Lost server/reference/CLI identity requires a fresh
observation, not a silently minted retry key.

**Transport loss after dispatch means unknown outcome, not no effect.** Check
again resubmits the same planRef. An uncertain CLI result stays
uncertain rather than re-executing a mutation. Closing the dialog only closes
status; it does not cancel the dispatched operation or signal its process.

## Whose tree `work/` is

A retire keeps or deletes one tree: the instance's own. Whether `work/` is
that tree is answered in one place, `ownWorktreeOf(plan)` in
`packages/client/lifecycle-contract.mjs`, and every reader asks it: the check
of the discard choice (`lifecycleChoicesApplicable`, which the server runs
before an apply and the dialog before it enables Retire), the option, "What
will happen" and "Current state". It answers `{ own, from }`:

- **`from: 'fact'`**: the plan holds `facts.ownWorktree`, the kernel's answer
  of the one reading of `work/` that its retire acts on
  ([the retire plan](../../../docs/desktop-cli-api.md#retire), OATS 0.53.0,
  feature `retire-plan-own-worktree`). `own` is that boolean, whatever the
  record says.
- **`from: 'record'`**: the plan holds no fact, and `own` is whether the
  record's work mode says `worktree`. The record is a file the instance can
  write and can disagree with what is at `work/` (a link, or a directory of
  the home, under a record that says `worktree`). Without the fact the
  dialog cannot tell such a home from one with its own tree, so it words the
  plan from the record alone.

No other line of `packages/client` or `packages/desktop` compares a plan's
work mode with a word; `packages/desktop/test/lifecycle-own-worktree.test.mjs`
reads the sources for it. Neither `defaults.retainWorktree`, which is the
default of an option, nor a note of the plan is read for whose tree it is.

**The fact is read by the features of the kernel that made the plan.**
`lifecyclePlan` takes them (`{ features }`, from `answeringFeatures`, as the
receipt's decoder does):

| The answering kernel | The key | The plan read |
|---|---|---|
| lists `retire-plan-own-worktree` | a boolean | `facts.ownWorktree` is that boolean |
| lists it | missing, or not a boolean | no plan: malformed, as every other malformed fact |
| does not list it | anything | the key is not read: the plan has none |
| its features are not known | a boolean | read |
| its features are not known | missing, or not a boolean | the plan has none |

A plan authorizes a removal, so a kernel that promises the key and does not
send it has sent a malformed plan: the reader does not fall back to the
record. The server makes the three reads of a kernel's own plan (the plan, and
the fresh plan in `details.plan` of `E_PLAN_STALE` and of
`E_CHILDREN_RUNNING`) with the features of the kernel that answered. For a
plan relayed from a server those are its host's, never this computer's: a
relayed plan carries the key as its host answered it. The server's projection
then holds the key exactly when it was read, and the renderer, which reads
that projection with no features, reads the key when it is there. So the rule
is decided once, where the features are known. A stop plan carries no such
key and none is read.

**What the dialog says of the tree** follows from the function's answer and
from whether the plan observed `work/` (`facts.work.observed`):

| The plan | What will happen | Also delete the worktree |
|---|---|---|
| 1. the fact is `true`, `work/` observed | "Keeps its worktree, moved aside, on branch `<branch>`." With the choice: "Deletes its worktree. Branch `<branch>` stays in the repository." The branch is the tree's. | offered; its warning counts the tree's uncommitted changes and names its branch |
| 2. the fact is `true`, `work/` not observed | "Keeps its worktree, moved aside, if there is one. It couldn't be checked." With the choice: "Deletes its worktree, if there is one. It couldn't be checked." No branch is named. | offered; its warning: "Deletes the worktree folder, if there is one, with any uncommitted changes (a recovery copy is saved first). It couldn't be checked." |
| 3. the fact is `false` | "It has no worktree of its own, so no worktree is kept or deleted. A tree it links to is not touched." | not offered; a confirmation that carries it is refused with `E_OPTION_UNAVAILABLE` before any command |
| 4. no fact | from the record: the sentences of row 1 under a record that says `worktree` (naming the recorded branch when `work/` was not observed), and no worktree line under any other | offered under a record that says `worktree`; its warning names the recorded branch when `work/` was not observed |

- **Row 2 promises no tree.** The fact is the reading's answer and not a
  promise that a tree is there: it is `true` by the record where nothing, or
  a file, is at `work/`, and for a work directory whose Git entry is missing
  ([the retire plan](../../../docs/desktop-cli-api.md#retire)). For each of
  those homes the kernel's plan has `facts.work.observed: false`, which is
  what the dialog keys on. It reads no code of `facts.work.reason`: one
  wording for every reason. No branch is named because the only one known
  there is the record's, and branch actions use the tree's.
- **Row 3's sentence is true of every home the kernel answers `false` for:**
  an attached, a checkout or a workspace instance (its link goes with the
  home and what it leads to is not touched), a directory instance, and a
  link or a real directory under a record that says `worktree`. It names no
  owner and does not claim there is a link. What happens to what is at
  `work/` is the line above it, about the recovery copy and the home.
- **A choice still checked when the fact turns `false`** (a fresh plan after
  `E_PLAN_STALE`, or Check again): the choice stays on screen so that it can
  be undone, the status says "Only an instance with its own worktree can
  delete it. Review the choice again.", Retire is disabled, and no warning
  stands under the choice: it would count another tree's changes and promise
  a deletion that cannot be confirmed. This is for a plan that carries the
  fact: with no fact and a record that is not `worktree`, a stale choice
  keeps its warning.
- **Current state shows nothing of `facts.work` for a tree the kernel says
  is not the instance's.**
  `facts.work` is an observation through any link, so for an attached
  instance it is the state of its owner's tree, which this retire does not
  touch. When the fact is `false` the dialog shows no row of it: no
  "Uncommitted work", no "Branch", no sentence about the branch it was
  spawned on. It shows no pull request row either, and makes no Git or forge
  read for one: the row's `correlation` is null for such a plan, the one
  place that decides it, and a row on screen leaves when a fresh plan says
  the tree is not the instance's. When the fact is `true`, and for a plan
  with no fact, the rows are: "Uncommitted work" when `work/` was observed
  or the tree is the instance's own; "Branch", the drift sentence and the
  pull request row when it was observed. So from a kernel that does not list
  `retire-plan-own-worktree`, an attached instance shows the rows of the
  tree its link leads to.
- The plan's notes are not shown and not read.

## Effects are reported individually

- Stop processes the kernel's ordered targets. Nested `ok:false` remains partial
  even inside a successful envelope. Reported still-running PIDs are text only;
  no stronger-kill control. Home/work/transcript/launch remain retained.
- Retire stops recorded children first. `E_CHILDREN_RUNNING` displays
  `details.childrenStopped` and refuses retirement; **some children may already
  have stopped**, so “nothing retired” is not “nothing happened”. Read a fresh
  plan before a new confirmation; do not compose another Stop in Desktop.
- **A row is read as data, in one place.** A row of a stop's `results` or of a
  retire's `childrenStopped` is one of seven kinds (`stoppedRowKind` in
  `packages/client/lifecycle-contract.mjs`), and every line and every sentence
  above the rows is chosen from the kinds, never from the row's `message` or
  from the reply's `reason.message`:

  | Row | Kind | Its line, after the name |
  |---|---|---|
  | `ok: true`, `alreadyIdle: true` | `idle` | Was already stopped |
  | `ok: true` otherwise | `stopped` | Stopped |
  | `ok: false`, `code: E_INSTANCE_RETIRING` | `retiring` | Not stopped: it is being retired |
  | `ok: false`, `code: E_LIFECYCLE_BUSY` | `locked` | Not stopped: OATS couldn't lock its home (the kernel's sentence for that row under it) |
  | `ok: false`, `stillRunning` a non-empty list | `running` | Didn't stop (still running: …) |
  | `ok: false`, `stillRunning: []` | `unrecorded` | Stopped, but OATS couldn't record it |
  | `ok: false`, `stillRunning: null` | `unconfirmed` | Didn't stop |

  The two codes decide before `stillRunning` does and need no feature name: the
  kernel answers both only before any effect, so nothing was tried on that
  target, and "Didn't stop" would say that something was. A `locked` row is the
  only one whose kernel sentence is kept (it is the refusal of that child's own
  stop and names what ends it), through the display filter.

  When every failed row is `unrecorded`, the sentence above the rows says that
  the sessions stopped and the record failed: a stop reads "<name> stopped, but
  OATS couldn't record it." (one target) or "Every session stopped, but OATS
  couldn't record all of them:" (several), under the title "Stopped, but not
  recorded"; a retire refused with `E_CHILDREN_RUNNING` reads "The child
  instances stopped, but OATS couldn't record it for all of them, so nothing was
  retired." Any other mix keeps "Not every session stopped:" and "A child
  instance wouldn't stop, so nothing was retired. Other children may already
  have stopped." Either way it is a partial result or a refusal, never done.
- **`stillRunning: []` means "the harness exited" only from a kernel that says
  so** (feature `lifecycle-kernel-codes`; the kernel's rule is
  [`#still-running`](../../../docs/desktop-cli-api.md#still-running)). A kernel
  without the feature answers `[]` in a failed row for a session it did not
  see stop. So the server's decoder is told which kernel answered
  (`answeringFeatures`: the selected CLI's features for a local command; for a
  routed one the host's own list, known only when this computer's CLI lists
  `server-probe-features`, the roster group's `probe.ok` is `true` and
  `probe.features` is an array) and keeps a failed row's `[]` only when that
  list names the feature. Otherwise the decoded row, and the reply, carry
  `null`. An unknown list, or a caller that passes none, reads as without: the
  weaker claim. The dialog re-validates the rows the server decoded
  (`publicLifecycleReceipt`, `decodedStoppedTargets`) and never decodes a
  kernel's own row, so from the decoder on `[]` has one meaning.
- Retire accepts both the documented first raw receipt and enveloped replay,
  checking revision/key/name against the transaction. Home removal, worktree
  retention/removal and recovery are separate facts.
- Retire never deletes a branch and asks for no deletion, so a receipt,
  deferred or not, that reports a branch deletion or a skip (`branchDeleted: true`, or
  `retention.branchDeleted` or `retention.branchDeletionSkipped` present with
  any value) is not the answer to its request. It is refused whole, at the
  server and again in the dialog, and reported as an **unknown outcome** with
  Desktop's two fixed sentences (`E_OUTCOME_UNKNOWN`, then `E_CLI_PROTOCOL` as
  the cause): no field of that receipt is forwarded or shown. `branchDeleted`
  `false` or absent is accepted, and so is a plan whose `defaults.deleteBranch`
  is `false` or absent; any other value there is an invalid plan. No Desktop
  Git preflight is used.
- A home left by a failed spawn that still owes its branch stays incomplete
  (`E_RETIRE_INCOMPLETE`: "Retirement didn't finish cleaning up. Check what
  was kept before trying again.") while that branch exists, and Retire
  can no longer complete it: the person checks the branch and deletes it with
  Git, then removes the home again.
- **The one exception** (feature `worktree-event`, OATS 0.49.0): retiring the
  home of a spawn killed while its `worktree` hooks ran can finish that spawn's
  own compensation and delete the branch it created, when the branch still
  points at its creation commit. The kernel reports it only in the additive
  `spawnCompensation` (`{branch, branchDeleted: true}` or `{branch,
  branchDeleted: false, reason}`), never in `branchDeleted`, so the strict rule
  above is unchanged. It is projected tolerantly (`spawnCompensationOf` in
  `packages/client/lifecycle-contract.mjs`: anything malformed is ignored, never a
  refused receipt) and shown as one result line: "Branch <branch> deleted: an
  interrupted spawn left it, and it held no work." or "Branch <branch> kept:
  <reason>", branch and reason through `displayLine`.
- **`E_LIFECYCLE_BUSY` is read by which kernel answered.** The code's fixed
  sentence is "Another stop or retire is already running. Wait for it to
  finish, then review again."
  - **A kernel that lists `lifecycle-claim-stop`** says in
    `error.details.holder` whether waiting ends the refusal (the kernel's rule
    is in `docs/desktop-cli-api.md`), and the headline follows it, for an apply
    and for a plan read:

    | `holder` | Headline | The kernel's sentence |
    |---|---|---|
    | `running` | Another OATS command is already running. Wait for it to finish, then review again. | in Details |
    | `unknown` | Nothing was done. OATS can't tell whether another command is still running. | under "It says what to check:" |
    | `none` | Nothing was done, and there is no other command to wait for. | under "OATS says what to do:" |
    | absent, or any other value | Nothing was done: OATS refused this as busy. | under "It says:" |

    Only `running` promises that waiting ends it. For the others the kernel's
    sentence names the step that ends the refusal, so it is the main text: one
    line through the display filter, alone in its `<bdi>`, in the status live
    region after the headline (a screen reader gets it with the headline). A
    sentence the filter withholds is not introduced, and Details shows the
    filter's line. The field is read only under this code. When the refusal's
    `details.home` is a target of the stop plan other than the instance acted
    on (a recursive stop refused for a child's claim), one line names it: "This
    is about <name>, which is in this plan." The name is the plan's and is
    checked against the dialog's own plan snapshot; `details.instance` is never
    shown. With this feature the sentence below for a home a spawn left is not
    shown on any row: `holder` decides, and where the kernel offers `--force`
    its own sentence names the check and the command. A leftover whose hook
    group survived both signals is answered `E_RUNTIME_QUIESCE_FAILED` by such
    a kernel, an unknown outcome.
  - **A kernel that does not list it, or a host whose features are not known:**
    the fixed sentence, with one exception: a retire the kernel refuses as busy
    for a row with `rollbackIncomplete` (a local answer with a message) says
    "OATS can't confirm that the spawn which left this home has stopped, so it
    won't retire it yet. Check the process it names, then retire it from the
    CLI with --force.", with the kernel's message (it names the process) under
    it.
  - Desktop offers no `--force` and reads no `details.remedy`. Desktop's own
    busy (an apply slot or the plan cap) carries no kernel message and keeps
    the fixed sentence.
- `E_PLAN_STALE` displays the validated producer's fresh plan and a new reference;
  the operator must explicitly confirm again. It never auto-applies. It means
  "nothing happened" only in that shape: an `E_PLAN_STALE` without a plan that
  reads for this target (a kernel before 0.52.0 could answer one after a
  guarded retire's hooks had run, #895) is an unknown outcome. It is read by
  its own branch, never by `BEFORE_EFFECT_CODES`, which does not list it.
- Preservation/cleanup failure may follow earlier effects. Render retained/partial
  or unknown state honestly; never automatically add discard/force flags.
- An inspection refusal of Retire (`E_WORK_INSPECTION_FAILED`) is reported as
  an **unknown outcome** with its own fixed sentence, never as a refusal before
  any effect: the kernel can raise it after the children stop, the session
  stop and the retire hooks. The kernel's own message (it names the path and
  the remedy) is in Details, for a local refusal and a remote one alike.
- `E_RUNTIME_QUIESCE_FAILED` (a session window, or the hook group an
  interrupted spawn left, that OATS could not show gone) is an **unknown
  outcome** with its own fixed sentence as the cause: "OATS tried to end a
  session or a process and couldn't confirm that it ended." The kernel's
  message is in Details.
- `E_UNIDENTIFIED_INSTANCE_HOME` (a home the kernel cannot work from: its
  record is there and cannot be read
  ([desktop-cli-api.md](../../../docs/desktop-cli-api.md#unreadable-record)),
  its rollback marker cannot drive a retry, or it has neither a record nor a
  cleanup descriptor) is a **refusal** with its own fixed sentence: "OATS
  couldn't find or read what it needs in this instance's home folder, so
  nothing was done." The kernel answers it only before any effect, so it is in
  `BEFORE_EFFECT_CODES`: a plan read and an apply answered with it both read
  as refused, never as an unknown outcome. The kernel's message (it names the
  file or the folder, and the remedy where there is one) is in Details, for a
  local answer and a routed one. Where that message offers `--force`, it is
  the kernel's own word: Desktop offers none and adds nothing about it.
- `E_USAGE` (a stop or a retire missing its argument, which the kernel
  answers only before any effect, a routed one before it is sent) is a
  **refusal** with the sentence of `E_BAD_ARGS`, "Invalid lifecycle
  request.", and the kernel's usage line in Details. It is in
  `BEFORE_EFFECT_CODES`: an apply answered with it reads as refused, never as
  an unknown outcome.
- Malformed receipts and timeouts are closed local messages.
  An error envelope's `message` renders only through the display filter
  (`packages/client/display-text.mjs`; see
  [desktop-deployment-model.md](desktop-deployment-model.md#remote-rows)), in
  the dialog's Details as `CODE: message`, under Desktop's fixed sentence for
  the code. The headline is never the CLI's text; the one place the kernel's
  sentence is the main text is a busy answer, above. A local failure carries
  the message only when both hold:
  - **the kernel answered.** The adapter says so where it builds the envelope:
    `origin: 'kernel'` on an error the installed CLI printed
    (`packages/client/lifecycle-cli.mjs`). The boundary decides by that field
    (`kernelAnswered`), never by the envelope's shape: a failure Desktop's own
    adapter or boundary raises (`E_CLI_TIMEOUT`, `E_CLI_OUTPUT_LIMIT`,
    `E_CLI_PROTOCOL`, `E_CLI_FAILED`, `E_OUTCOME_UNKNOWN`, the plan and
    admission codes of the boundary) has the same shape, carries no origin and
    never carries a message, whatever came with it;
  - the code has its own sentence and is not one Desktop raises
    (`lifecycleDetailCode`), or it is a kernel code without a sentence, below.

  **A sentence about not reaching OATS is never shown for an answer the kernel
  gave.** A code the kernel answered that has no sentence here keeps its own
  code and reads "OATS answered with an error that Desktop has no description
  for.", with the code and the kernel's message in Details (the code alone
  when there is no message), for a local answer and a routed one. A code
  without a sentence is never in `BEFORE_EFFECT_CODES`, so an apply answered
  with one reads as an unknown outcome with that answer as its cause. The
  fallback is chosen
  by where the code came from, so by the boundary (`failureReason`):
  `lifecycleReason(code)` is given codes of every origin and keeps
  `E_CLI_FAILED` ("OATS couldn't be run for this.") for one it does not know.
  The kernel's code shape is only the guard for a system code (`ENOENT`) from a
  kernel that still answers one, which keeps `E_CLI_FAILED`'s sentence. Every
  code Desktop raises itself has its own sentence and never reaches the
  fallback; `test/lifecycle-kernel-answers.test.mjs` reads the adapter, the
  boundary, admission and main for the codes they raise and holds each to the
  table (main's frame code to its sentence in `renderer/lifecycle-frame.mjs`).
  It changes no status: `refused` and `unknown` are decided by
  `BEFORE_EFFECT_CODES` (exported by `packages/client/instance-lifecycle.mjs`, so that
  the kernel's tests can hold it inside the kernel's own list of codes
  answered only before any effect). "Before any effect" and the headlines'
  "Nothing was done." are about the instance: its sessions and its home. A
  guarded retire that answers one of these codes may already have appended its
  plan's `retire-planned` event to the workspace log (a stop never does), so
  Desktop never says that a refused retire recorded nothing.

  The server builds the reason (`failureReason`) and the dialog re-validates it
  (a display line, the same code rule; for the fallback, the fixed sentence and
  a kernel code without one: `undescribedRefusal`; for a busy answer,
  `busyRefusal`) before showing it: a detail is set as text, never parsed,
  linked or acted on. The dialog reads no `origin` from a reply. Raw stderr,
  exception stacks and every other field of an error still never render.

The kernel's Stop replay horizon is per key while its home exists. Retire
receipts live beside the instances directory and survive home removal. Desktop
cannot make those horizons stronger. Plan reads mutate no instance/session or
worktree; the kernel may append its documented `retire-planned` audit event.

## Quarantined and spawning rows

The roster says what a home is when it is not an ordinary instance, in text
(never colour alone):

- `spawnInProgress` (feature `worktree-event`): a spawn still running its
  `worktree` hooks, verified alive. **Setting up worktree…**, no actions at
  all (no Start, Stop, Retire or split; activating it opens nothing); its hover
  card's status is "Spawning (setting up worktree)". The kernel refuses its
  retire anyway (`E_LIFECYCLE_BUSY`).
- `rollbackIncomplete`: **Spawn didn't finish**, muted "Retire it to clean up".
- A retire in progress (#1247): the kernel's `retire` with state `running` or
  `unknown` (its holder's liveness can't be read), an older kernel's bare
  `retirePending`, or a retire this window applied and has not read the roster
  after: **Retiring…**, no muted line, never a failure.
- `retire` state `failed` (a self-retire's completion recorded an error):
  **Retire failed**, muted "Retire it again to finish". The kernel's recorded
  message (with its code), or its code alone when it recorded no message, is
  said after "OATS says:" through the display
  filter (the row's description, the hover card's status, the instance panel's
  action note, the overview's popover).
- `retire` state `interrupted` (a scheduled completion is gone with no
  outcome): **Retire didn't finish**, muted "Retire it again to complete".

These states offer **Retire instance…** only: no Start, Stop, Restart, split or
terminal. The kernel's retire completes the quarantined ones, through the
ordinary plan → apply dialog. While a retire runs, Retire is *secondary*
(`instanceActs`): it stays in the row's context menu (right-click, Shift+F10
or the ContextMenu key), enabled, behind its
confirmation (the kernel refuses a second one while the first runs), but it is
never the menu's first focus (the menu opens on itself; the arrows reach it)
and the instance panel draws no Retire button, its action note saying "<name>
is being retired." instead. A row never shows `spawnInProgress` and
`rollbackIncomplete` together; if both arrive, `rollbackIncomplete` wins, and a
live spawn wins over a retire. The kernel's `retire` is read again where the
row is projected (`retire-state.mjs`): a value out of the contract is absent.

The window's own retires in flight are held in the renderer
(`packages/client/retire-in-flight.mjs`, one tracker per window in `shell.mjs`).
The dialog begins one before the apply is sent and settles it with the answer,
also after the dialog closed. Each apply is held on its own: a second Retire
of the same row (offered while one runs) that the kernel refuses lets go of
that apply only, never of the first. A refusal (or a stale plan) lets its apply
go at once; any other answer keeps the row Retiring… until an observed roster
read begun after the answer lands (`refreshContextRoster`'s read generation is
the mark). That read must cover the row: the row's deployment (the dialog's
target `workspace`) is one the read observed live (`deploymentState`), so a
read of another workspace, or one whose deployment of the row is stale, not
reached or not observed, releases nothing. A failed read, or one served while a
newer observation is still running (`refreshing`), releases nothing either. Every surface draws rows through
`shownRows`, so the roster, the instance panel, the hover card and the overview
(through `ctx.retiringRows` and `ctx.subscribeRetires`) agree, and a change of
the held set repaints them without a read. An open terminal tab is left alone.

The retire plan of a `rollbackIncomplete` row says "Branches and pull requests
are not changed, except a branch an interrupted spawn left with no work, which
is deleted.": that retire finishes the spawn's compensation, and the result's
`spawnCompensation` line says whether the branch was deleted or kept. With
**Also delete the worktree** checked, its plan line and warning drop "Branch
… stays in the repository.", so that sentence is the plan's only word on
branches (the kernel deletes the branch only when the worktree is removed).
Every other retire plan keeps "Branches and pull requests are not changed."

## UI and ownership

The 420px confirmation surface follows the supplied layout, semantic theme
colors and keyboard focus language. Stop/Retire are separate from existing
Start/Restart/Inspect; the roster row's context menu says **Retire instance…**, the
context panel's footer **Stop…** and **Retire…**. Stop always requires explicit
confirmation. The Retire PR row is only an informational 2b overlay: exact
home/server/workspace, revision, branch and remote host/path must correlate. A
PR that is not known (disconnected, unmatched, failed) is left out, never shown
as "no PR"; Retire never closes or changes the remote PR. While a new plan is
read, the row stays only if the new plan has the same revision, branch and
remote host/path and the connection has not changed; it is then read again, and
a re-read that cannot confirm it drops it. Its link opens the PR on screen, not
the read that drew it, so a kept link stays usable (and keeps focus) until then.

### UI states

One phase decides which controls exist (`lifecycle-dialog.mjs`); a control
with no use in a phase is not rendered, and one that cannot act yet carries
its reason in the visible status line (`aria-describedby`).

What the dialog says, and which acts it may offer, is the shared home's
(`packages/client/lifecycle-confirmation.mjs`): `planView` and `outcomeView`
give every sentence as data, and `createLifecycleConfirmation` holds the
client's half of the transaction (the reference, the latest-intent token, the
closed set of states and the acts each offers). The dialog draws it, and words
only its own furniture: its button labels, "Details", the age line, the PR row,
"You can close this window" and the two next steps a view names by a code
(`check-roster`, `retire-with-force`). The phases below are its drawing states,
derived from the confirmation's (`reading`, `review`, `applying`, `settled`).

| Phase | Title | Body | Footer |
|---|---|---|---|
| loading | Retire X? / Stop X? | "Checking what retiring X will do…" (or "Reading from <server>…"); What will happen and Current state as skeletons, `aria-busy`; the option's place held by one skeleton line | Cancel · confirm (disabled, described by the status line) |
| review | same | What will happen (plain lines built from the plan), Current state, the option, "Observed <age>" with **Check again** | Cancel · **Retire instance** / **Stop session(s)** |
| updating | same | the previous facts stay on screen, `aria-busy`, until the new plan replaces them at once; "Updating for this choice…" or "Checking again…" | Cancel · confirm (disabled, described by the status line) |
| running | Retiring X… / Stopping X… | spinner and status; What will happen kept, muted; "You can close this window; retirement continues." | Close |
| done | X retired / X stopped / N sessions stopped | a short summary from the receipt (paths muted and selectable) | **Done** |
| result | per outcome | the fixed sentence (or a remote host's headline), the effects that did happen, Details | Check again (uncertain) or Review again · Close |

- **Cancel and Close.** Before anything is dispatched the secondary button is
  Cancel: nothing happened. After dispatch it is Close, and closing never
  cancels the operation. Esc does what the visible button does in each phase.
- **Option changes and Check again** revoke the reference on screen at once,
  keep the facts on screen and swap in the new plan when it lands; the latest
  choice wins (older answers are dropped by their ticket). The worktree option
  is shown only for an instance with its own worktree
  ([Whose tree `work/` is](#whose-tree-work-is)), or while that choice is
  still checked, so `E_OPTION_UNAVAILABLE` stays visible and undoable.
- **Results.** An uncertain outcome (`unknown`, `pending`, a deferred retire,
  transport loss, a refused receipt) offers **Check again**, which resubmits
  the same planRef. Anything else that did not succeed (a refusal, a partial
  receipt, a plan that could not be read) offers **Review again**, which reads
  a fresh plan and returns to loading, with Cancel. `E_PLAN_STALE` returns to
  review with the fresh plan and "Something changed since you opened this.
  Review it and confirm again."; it never applies by itself. A partial outcome
  is never shown as done.
- **Focus.** It starts on Cancel and does not move when a plan lands. Running
  and every result focus Close (never an action that resubmits); done focuses
  Done; stale focuses Cancel. A focused control that leaves (a PR link that is
  dropped, a button the next phase does not have) hands focus to the control
  that stays. On close, focus returns to the opener or a control with its
  identity (`focus-return.mjs` `restoreExact`), else to the roster (the row that
  followed a retired row, else the one before, else the roster's tab stop:
  `shell.mjs` `lifecycleFallbackFocus`, `successorRow`), else to the generic
  return near the opener; never `<body>`.
- **Copy.** Plain words, no timestamps and no kernel vocabulary: the plan's
  `at` is shown as an age, a session as Running / Not running / Unknown.
  Work the kernel did not observe reads "Unknown (couldn't be checked)", its
  reason (a code such as `E_NO_WORKTREE`) only in the row's title; which
  instances have an Uncommitted work row is under
  [Whose tree `work/` is](#whose-tree-work-is). The
  fixed sentences live in `packages/client/lifecycle-contract.mjs`, with the
  functions that choose a sentence from an answer's data (a row's kind and
  line, the sentence above a stop's rows, a refused retire's sentence, a busy
  answer's headline). The dialog lays them out and words none of them. One
  sentence is not there: main's refusal of a frame that is not the window's
  own page (`E_FORBIDDEN_FRAME`) is raised by the Desktop alone, and its
  sentence and the answer main sends are in `renderer/lifecycle-frame.mjs`.
  The shared table does not know that code.

Modal lifetime, workspace generation, target and request/operation tickets guard
success, rejection and cleanup. Old controls cannot close or confirm a new
modal. Connection generation separately invalidates only the informational PR
row. Workspace changes dispose the dialog; late receipts cannot close another
tab or steal its focus. Agent tmux/viewer/key/PTY paths remain untouched.

Tests use inert CLI/HTTP/IPC/dialog/DOM fixtures, caps/retry/expiry and adversarial
completion order, plus computed three-theme contrast. No native lifecycle action
or rendered/Electron acceptance is implied; final native acceptance is owned by
the operator/CI.
