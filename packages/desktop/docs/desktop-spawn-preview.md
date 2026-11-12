# Spawn: API 2 observations and confirmed apply

All lifecycle effects go through a compatible installed OATS CLI. Desktop never
resolves placement/model defaults, computes a decision revision, imports the
kernel to mutate, or treats preview paths as filesystem/terminal authority.

## Independent capability fences

- **READ:** integer `spawnPreviewApi===2` AND `spawn-preview-2`.
- **Confirmed apply/retry:** integer `spawnPreviewApi===2`, integer
  `spawnApplyApi===1`, AND all of `spawn-preview-2`, `spawn-apply-2`,
  **`spawn-idempotency-2`**. The older `spawn-idempotency` name is insufficient:
  its replay could fail at the branch-existence check and lacked completion custody.

The full apply fence is checked at admission/confirmation and at the actual
process owner. Existing optional advertisements remain required too: harness and
backend lists, yolo launch option, launch-config and schedule (for wake input).
A version string or optimistic flag probe never enables a mode.
API 1 preview is never invoked: older parsers can ignore unknown flags and spawn.
Missing compatible CLI means observation-only. Every **local** spawn goes through
the confirmed transaction; an ordinary local `/api/spawn` body is refused
(`E_PLAN_REQUIRED`) whatever the CLI advertises. The ordinary body is accepted
only for an execution server (`serverId`), where the host decides defaults and
naming; decision fields (key, ref, revision) cannot enter it
(`E_UNSUPPORTED_OPTION`). There is no remote-to-local fallback.
`--name` (feature `spawn-name`) and a messaging identity (feature
`spawn-provider-payload`) are admitted only when advertised.

## Selector and choices

A selector is `{soul,agentsRoot}`, matched to one soul of the deployment's spawn
catalog (`oats souls --json`); a catalog that could not be read, or a name it
reports twice, refuses rather than falling back to the roster.
Choices include purpose **or** name (exclusive; the kernel owns naming rules and
refuses with `E_INSTANCE_NAME_INVALID`/`E_INSTANCE_NAME_TAKEN`). The spawn
dialog sends a typed name as `name`, lowercased and with nothing appended
(`finalName` in `renderer/spawn-dialog.mjs`), when the CLI advertises
`spawn-name` and, for a spawn on a server (`/api/spawn` with `serverId`), so
does that host: the CLI relays host features (`server-probe-features`) and the
server's registered roster group (`/api/team-members` `servers[].features`)
names `spawn-name` (`roleNamed`, read through `answeringFeatures`). Otherwise
(an older kernel on either side, a host whose features are unknown) it goes as
`purpose`; `/api/spawn` refuses both together. An empty name sends neither,
and the kernel numbers the instance, unless the dialog has a suggested name for
the task (below): then the choices carry that name as `name`. Also work
(`worktree` for a checkout soul), worktree-only branch/base, advertised
harness/backend, launchConfig, yolo, model, relation and identity.
`background` (feature `instance-background`, #1579) is the dialog's **Run in
background** switch: sent only when it differs from the soul's default (the
souls catalog's `background: true`, corrected by a preview read without the
flag), as `--background` / `--no-background`, the same to preview and apply.
The switch is shown only where this CLI lists the feature and, for another
machine, the host's `servers[].features` does too; there the soul's default is
not reported, so the switch is sent once it was switched, and `/api/spawn`
forwards it to `spawn --server` (a host without the feature refuses with
`E_REMOTE_INCOMPATIBLE`).
`identity` is `{provider, mode:"local"}` or `{provider, mode:"global", resident}`
(decision 27): `provider` is the soul's messaging capability as the preview
reported it (the one module on layer `messaging`), and the argv is
`--provider <cap> identity.mode=<mode>` [`--provider <cap> identity.resident=<r>`]
— there is no kernel flag. The kernel refuses a capability the soul does not
resolve (`E_CAPABILITY_MISSING`); the provider validates the resident. Models are
`{kind:"inherit"}`, `{kind:"native-default"}` or `{kind:"custom",value}`; the native
sentinel is reserved, not a custom model. Custom model text is advisory, not
restricted to a catalog. Relations are `{kind:"unrelated"}` or
`{kind:"child"|"sibling"|"parent",anchor:{instance,agent,agentsRoot,server:null}}`.
Shared admission checks anchor identity/incarnation and uniqueness of the public
CLI's name/root pair. No inferred ancestry or cross-host substitution.

No arbitrary repo/cwd/home/workDir/env/file authority comes from the renderer.
Remote/captured/attached transactions are unavailable, not translated to classic
local operations. Git and the kernel own ref validity and default naming.

## Read-only HTTP / process boundary

`POST /api/workspace-spawn-preview?ws=<workspace>` accepts exactly
`{action:"preview",selector,choices}`, at most **16 KiB**. Opening instruction and
wake configuration are absent; only a suggest read (below) carries the task. Missing/duplicate/extra workspace query selectors
refuse. CLI argv is fixed `execFile`, `shell:false`:

```text
spawn <admitted-soul> --dir <admitted-context> --agents-root <admitted-root> --preview
  [validated choices] --json
```

No task/file, expected-decision/key, no-launch workaround or fallback. Two reads
process-wide (a third refuses `E_BUSY`); exact invoker/CLI/workspace/subject/anchor/choice
duplicates coalesce before await. No unbounded queue. **30s / 4MiB CLI,
35s proxy**, clean exit and JSON-v1 envelope. Admission revalidation applies to
success and rejection.

**What travels of a kernel refusal.** The code, the message, and of `details`
the `fix` alone. The exec owner (`packages/client/spawn-preview-cli.mjs`)
answers a refusal in the kernel's own shape, `{code, message, details: {fix}}`;
the boundary reads it there and serves the three as the view's `reason`,
`{code, message, fix}`; the Electron proxy reads that reason again. Each of the
three decides with `previewFailure`: the kernel's message travels when it is
printable and at most 2,048 characters, and otherwise the reason holds the
sentence of the contract's table for that code; the `fix` travels only beside
the kernel's own message, printable and at most 1,024 characters. A reason
with a `fix` is therefore one whose `message` is the kernel's. A test of what
reaches the dialog starts from the CLI's printed envelope, through the exec
owner: the boundary's `invoke` seam is after it.

## The suggest read (feature `spawn-suggest-name`)

The same route takes `{action:"suggest",selector,choices,task}`: a preview that
also names the instance from its task (awebai/oats#1421 §3). The choices carry no
`name` or `purpose`; the task is the apply's (never blank, at most 32 KiB), so
this action's body may take the apply's **64 KiB**, checked in the Electron
proxy (`spawn-preview-proxy.mjs`) and again by the route. Admission is the
preview's, and the CLI must advertise both `spawn-suggest-name` and
`spawn-name` (`suggestSupported`), else `E_UNSUPPORTED_OPTION`. The task goes
to the CLI in a private `0600` temporary file, as the apply's does, and the
file is removed on every path:

```text
spawn <soul> --dir <context> --agents-root <root> --preview --suggest-name
  --task-file <tmp> [validated choices] [--max-age 60] --json
```

The answer is the preview with `naming` projected (`namingOf`):
`{source:"suggested",ms,harness,model}` or `{source:"numbered",reason,ms}`, the
reason one of `no-task`, `unsupported-harness`, `timeout`, `harness-failed`,
`invalid-reply`. The kernel's `message` is not projected: it can carry an
exit code or a signal. An answer without `naming` is `E_CLI_PROTOCOL`.

**Its own lane.** Suggest reads are outside the previews' two slots: one per
workspace, and a newer one ends the older. The older read's `AbortSignal` ends
its CLI (`execFile` sends SIGTERM, and the kernel ends its naming call with
it), and it answers `E_SUPERSEDED`. There is no renderer cancel and no IPC for
it: the next read is the cancel. Closing the dialog ends nothing; the call ends
within the kernel's 20 s budget. Nothing of a suggest read is cached as such,
except that a `suggested` answer *is* the preview of `--name <instance>` (the
kernel's contract): it is held under that preview's identity, so the dialog's
next read and prepare take it without a second kernel call.

**The dialog** (`spawn-dialog.mjs`, rules in `packages/client/spawn-naming.mjs`)
asks only while the name field is empty and has never been typed in (for the
dialog's lifetime, restored with a draft), `SUGGEST_DEBOUNCE_MS` (300 ms) after
an edit leaves the task text with at least `SUGGEST_MIN_WORDS` (7) words: the
debounce only keeps typing from making one read per keystroke. It
keeps every answer by the exact task text and the soul (`namingKey`). A
suggestion for the current text becomes the choices' `name`, so the preview,
prepare and apply all bind it, and the placeholder shows the suggested name itself. With
no name yet, the preview's Name reads "named from its task" and the facts that
follow from the numbered name (its home and new branch) are left out
(`previewFacts`'s `unnamed`): Spawn would not create them.
Spawn with no suggestion for the text makes one suggest read ("Naming…"),
joining one in the air for the same text, with no word threshold; an empty
task makes none. A `numbered` answer spawns the numbered name, and the
background spawn says "Named <instance>: <reason in words>." when it is
created (`numberedLine`). A suggested name that a `--name` preview finds
taken is forgotten, and a waiting press names again.

## A spawn on another machine named from its task (features `instance-suggest-name`, `spawn-apply-suggest-name`)

A spawn on a server takes an exact name only where this CLI and the host
advertise `spawn-name` (`roleNamed`, the host's half from its roster group's
relayed `probe.features`, `answeringFeatures`). There, an empty, untouched
name is named from its task in one of three ways (awebai/oats#1490 §2, §3), and
the help under it says which before the press:

1. **Here** ("Left empty, the instance is named from its task."): this CLI
   advertises `instance-suggest-name` (`instanceSuggestSupported`) and the view
   has a deployment on this computer (`suggestDeployment`). The same route
   takes `{action:"suggest-name",soul,task,harness?,model?}`
   (`instanceSuggestRequest`): the soul is only a name (the host's, which
   needn't exist here), `harness` is the dialog's Harness choice, else the
   soul's default as its host reports it (a server-listed soul's row, or the
   Deployment field's catalog row), else omitted (the kernel's default), and
   `model` goes only with `pi`. It runs, with the task in a private temporary
   file and no `--launch-config` (the dialog's configurations are the host's):

   ```text
   instance suggest-name --soul <soul> --task-file <tmp> [--harness <h>] [--model <m>]
     --dir <local deployment> --json
   ```

   The answer is `{workspace, data:{name?, naming}}` (`instanceSuggestion`:
   `name`, a slug of at most 64, exactly when `naming.source` is `suggested`),
   re-validated by the Electron proxy, which also checks that `workspace` is
   the deployment it asked. Its lane is its own, one per deployment, the newer
   ending the older, as the suggest read's. The dialog asks exactly when and
   how a local suggestion is asked (debounce, seven words, one call in the air,
   "Naming…" at the press), and keeps answers by `namingKey` with the target
   server, so one host's answer never names a spawn on another. A suggestion is
   sent as `name`; nothing here makes it unique, and a host that finds it
   taken refuses it (`E_INSTANCE_NAME_TAKEN`, beside the field).
2. **On the host** ("Left empty, the instance is named from its task on
   <host>."): nothing was named here (no feature here, a numbered answer, or a
   failed read: a spawn is never failed or blocked over naming) and both this
   CLI and the host advertise `spawn-apply-suggest-name` (`hostNames`). The
   remote spawn sends `suggestName: true`, which `/api/spawn` passes as
   `--suggest-name` (never beside a name or a purpose: `E_BAD_ARGS`; without
   the feature here, `cli-no-apply-suggest-name`), with the CLI deadline
   extended by `NAMING_TIMEOUT_MS`. The result's `naming` is re-validated
   (`namingOf`) by the server and again by the view.
3. **Numbered on the host** ("Named by <host> when it spawns."): neither is
   sent. A name the field was typed in, then emptied, is always this case.

When the instance was numbered where it would have been named (the host's
`naming` is `numbered`, or this computer's answer was and nothing asked the
host), the view says "Named <instance>: <reason in words>." (`numberedLine`).

**The reuse window.** The preview and the apply broker are boundaries of the shared
home (`packages/client/spawn-preview.mjs`, `spawn-apply.mjs`) that a client creates
and owns: the backend makes one preview (`createSpawnPreview`) and one broker
(`createSpawnApplyBoundary`, reading through that preview's `prepareRead`), and
nothing in either module is shared between clients. The preview's two reads, this
route's and prepare's, share its two flight slots. This route and `/api/spawn`
prepare (below) answer from the preview's one bounded settled-answer cache:
64 entries, **60 s** for this route and **300 s** for prepare, keyed by the admission identity (workspace id and scope,
subject, soul work/repo/capability, anchor incarnation, choices and every CLI
field the admission reads). It holds `available` answers and the name refusals
`E_INSTANCE_NAME_TAKEN`/`E_INSTANCE_NAME_INVALID`, nothing else. A held answer is
returned only after the request is admitted against the current context, like a
fresh one, and costs no flight slot. Returning to choices the kernel answered
within the window (a toggle back, a retyped name, the dialog reopened for the
same soul) settles without a CLI call.

Invalidation drops a workspace's entries when Desktop performs a change that
can alter a preview: every `/api/spawn` apply (when it starts, before the kernel
runs, and again when it settles), a local lifecycle apply, a
workspace sync and instance start/restart (all through `observeMutation`), a
teams or soul-teams write, a launch-configuration `set`/`remove`, and a
capability run. A CLI re-probe that changes the CLI clears it all (its fields
are in the key anyway). The backend's workspace set is fixed per process: adding
a workspace replaces the backend, and its cache with it. A flight that started
before an invalidation never fills the cache, even when a later request joined
it (a monotonic clock stamps flight starts and invalidations). What Desktop does
not observe (a spawn by another window's backend or by the CLI, an on-disk edit)
may show an older answer for up to 60 s, and prepare may bind one up to 300 s old. That is safe: the apply passes the
decision's revision as `--expect-decision`, and the kernel refuses a decision
that no longer holds (`E_DECISION_STALE`) before it creates anything.

**Prepare reuses the dialog's answer** (Spec C). `/api/spawn` prepare reads
through the preview's `prepareRead`, the same cache: when the dialog already
holds a settled answer for exactly this admission identity (not invalidated,
younger than `PREPARE_REUSE_MS`, **300 s**: the prepared intent's own lifetime),
prepare binds it without a CLI call (well under 50 ms); otherwise it reads fresh
as before, and may coalesce onto an identical read in the air. The cache keeps
an answer for the longer of its two ages and answers each reader by its own, so
an operator who lingers over the form (a task typed for a minute or two) presses
Spawn without a second kernel preview (#1246, which measured 1.4–2.4 s for it).
`--expect-decision` at apply is the drift guard that makes this safe: a decision
the kernel no longer makes is refused there (`E_DECISION_STALE`), which reads as
drifted, with nothing created and the values read again. The apply-start
invalidation keeps a spawn's own decision from being reused by the next one.

**Member-head reuse (`--max-age`).** When the admitted CLI advertises the feature
`spawn-preview-max-age`, the dialog's reads pass `--max-age 60`, letting the
kernel answer from member heads it observed within 60 s (its reply may carry an
`observation {observedAt, reused, localRevision}` block, which the projection
drops and never shows). Prepare's own uncached read never passes it, and a
reusing read never coalesces with a live one (their flights are keyed apart).
Without the feature, no read passes it. The apply has its own gate,
`spawn-apply-max-age` ([Apply transport](#apply-transport-and-qualified-results)).

Response: `{spawnPreviewViewApi:1,status,target,data,reason}`. Success requires
API2, `preview:true`, byte-exact `subject{soul,agentsRoot,dir}` and consistent
`decision{instance,home,branch,base,revision}`. Revision is opaque24-hex producer data.
K6d additionally reports `decision.effective {repo,work,harness,model,launchConfig,
yolo,backend,childSpawns,relation}` (a released kernel without feature `harness`
reports `runtime`; the Desktop reads either and sends `--harness` or `--runtime`
by the feature: packages/client/harness-names.mjs). Child policy is boolean; relation is null or
`{kind,anchor{instance,agentsRoot}}`; model/config/yolo can be null. Old API2 READ
without effective remains an observation, never a synthesized executable plan.
With feature `instance-background` the effective decision binds `background: true`
exactly when the instance runs in the background (absent otherwise; any other value
refuses the preview), and the preview's top-level `background` (a boolean, always
present on such a kernel) must agree with it; `backgroundFrom` (`flag` or `soul`,
absent when neither declared it) is kept for the dialog. Absent `background` is an
older kernel, which the dialog offers no switch for.

Projection preserves bounded work/harness/model provenance, the `resolution`
binding (top-level facts cross-checked against `decision.effective`),
`messaging{provider, identity{mode,resident}|null, origin{kind,at}|null}` —
the identity `decision.effective.providers[<cap>]` binds, which must equal the
preview's `settings[<cap>]`, and where its mode came from
(`settingsOrigins[<cap>]['/identity/mode']`: `manifest-default` | `workspace` |
`soul` | `host` | `spawn`, or a newer kind shown as sent).
The dialog's identity **Default** option shows a mode only when the kernel
reported it: with feature `settings-origins`, `Default · <mode>` for a
manifest default and `Default · <mode> — from <origin>` otherwise (the hint
names `at`); without the feature, or with no identity in the payload, plain
`Default` (a bound global resident is shown from the identity itself). The
Desktop never supplies a mode the kernel did not report —
`backendStatus{name,installed,started:false}` and
`preflight{status:complete|timeout,budgetMs,elapsedMs}`. Installation is not daemon
reachability. Omitted yolo remains unknown.

`modules[{name, layer|null, from{kind, package?, version?, repoKey?}, composedFrom?}]` (kernel
`modules[]`, feature `instance-modules`) is the composition this spawn will
record, for the dialog's Core capabilities and Capabilities list: the same
composition `/api/capabilities` exposes, scoped to this spawn. Each string has a
fixed grammar (the capability-name grammar for `name` and `package`; bounded
`layer`, `kind`, `version` and `repoKey`); a row's `commit`, `integrity`,
`declares`, `private` and `changedSince` are not projected. More than 256 rows,
a duplicate name or a malformed row refuses the preview (`E_CLI_PROTOCOL`), and
the renderer re-validates the projection with its keys exact. A kernel without
`modules[]` projects `null`.

**Why each module is there.** `composedFrom` is the kernel's reason (feature
`preview-composed-from`, OATS 0.30.2; the same value `oats inspect --soul`
reports): `"soul"` (the soul declares it) or `"workspace"` (a `defaults.<slot>`
or `defaults.capabilities` entry). The server reads it only when the admitted CLI
advertises the feature (`previewComposedFrom(cli)`, the same `cli.features` check
as `desktop-facts`, passed to `previewData` as `{composedFrom}`); without the
feature no row carries it, whatever the kernel sent. It is kept only when it is
exactly `"soul"` or `"workspace"`: any other value, or none, is dropped and the row
still projects. It is optional in the projection's exact key list, so the proxy
and the renderer re-validate it the same way. It is provenance only and never
enters the decision the apply binds.

The dialog's Core capabilities and Capabilities are two bordered boxes of one
row grammar, the same at every column width: line 1 is the module in mono, which
may wrap anywhere; line 2 is its source chip and a reason tag, left-aligned and
wrapping as a group. Both chips use the same muted tag pair (`--muted` on
`--tag-bg`, one CSS rule), and the reason tag reads **Soul** or
**Workspace default**. Nothing in a row is right-justified. A core row leads with its slot (Knowledge, Messaging,
Tasks) as a fixed left column beside those two lines, so its reason never repeats it; an empty slot reads **None**, with no
chips (the preview does not project `capabilitiesOff`, so it cannot say whether
the soul emptied it). A module filling a core slot (`layer` knowledge,
messaging or tasks) is Core's only: never in the Capabilities list or its
count. The tag is plain text in the row, part of its accessible text. No
`composedFrom`, no tag: the Desktop never guesses a reason from the soul.
`test/fixtures/composed-from` is the real kernel's preview for a soul with both
origins (`capture-composed-from.mjs`).

`capabilities[]`, skills, settings, providers, task, environment, executable
recipes and unknown trees are not exposed. Missing/mismatched data is not empty success.

## Confirmed HTTP transaction

`POST /api/spawn?ws=<workspace>` has three strict action shapes:

1. **prepare:** `{action:"prepare",selector,choices,task?,wake?}`. Capture an
   immutable private draft; perform the read-only preview without task/wake/file
   flags. Only a complete strong preview and observed installed backend can mint
   an opaque server-owned `spawnRef`. Each requester gets a separate ref even if
   the underlying observation coalesces. Prepare neither creates files nor spawns.
2. **apply:** `{action:"apply",spawnRef}` only. No caller key, revision, target or
   changed payload. Re-admit context/CLI/soul/anchor, synchronously reserve one of
   at most **4** backend-wide apply slots (one per workspace and soul: a second
   apply of that soul answers `E_BUSY`, as does a fifth apply anywhere), and mint a
   separate64-hex key on **first confirmation**.
   Every allowed retry retains this exact original intent/key/revision.
3. **result:** `{action:"result",spawnRef}` only. Reads retained state, never
   invokes a CLI, re-previews, mints a key or guesses success from names.

Request limit **64KiB**; selector/choices16KiB, task32KiB UTF-8, wake message8KiB
with bounded cron/timezone. At most32 prepared refs/5min,32 submitted records/30min
and8MiB retained payload including outcome reservations. No unbounded queue or
active-entry eviction. Pending duplicates report pending without another command;
known complete/partial/incomplete/refused/stale results are retained. A prepared
ref is neither a kernel reservation nor a lease over future configuration.

The new view is `{spawnApplyViewApi:1,status,target,spawnRef,preview,receipt,reason}`
with a task-free `wakeRequested` indicator on prepared/pending/completed views.
The normalized `/api/spawn` classifier covers aliases and ordinary requests too.
Trusted mainFrame/navigation plus copied server/connection epoch guards precede
and follow both awaited outcomes. Origin/workspace pinning remains in `apiUrl`;
duplicate selectors are preserved for refusal, not silently normalized away.
Domain errors resolve with stable safe codes.

## Apply transport and qualified results

```text
spawn <admitted-soul> --dir <admitted-context> --agents-root <admitted-root>
  [original validated choices] --expect-decision <stored-revision> [--max-age 60]
  --idempotency-key <stored-key> --task-file <owned-temp>
  [--wake-file <owned-temp>] --json
```

`--max-age 60` goes only to a CLI that lists `spawn-apply-max-age` (#1246 K1): the
kernel may then reuse deployment observations up to 60 s old instead of reading
every member head again at the press; `--expect-decision` still refuses a
drifted decision (`E_DECISION_STALE`, read as drifted).

Private files are created0600 inside private directories; short writes refuse
before CLI dispatch rather than launch with truncated instructions. Cleanup is
attempted on all construction/settlement/error paths. Retries use new owned paths with the
same bytes, not expired temp paths. `PI_AGENTS_ROOT`, `OATS_DEPLOYMENT`,
`OATS_RESOLUTION` and test-only `OATS_PREVIEW_PREFLIGHT_BUDGET_MS` are stripped.
No shell, renderer recipe/env, direct kernel fallback, automatic acquire/trust,
`--no-launch`, or task text in argv/logs/replies. **4MiB CLI** output; the CLI
deadline is the broker's, from the confirmed preview (Long spawns, below), and the
`apply` request **answers within 50 s**, so the proxy's **65 s** never fires on a
healthy spawn; result lookup has a short10s proxy deadline, prepare35s.

The private adapter's `{started,envelope}` records possible dispatch, not creation
or rollback. The broker must qualify success: full returned decision equals the
confirmed decision (including effective), exact soul/name/home/work/repo/branch
and model/harness facts, and typed launched/replayed fields. Raw recipes, attach
commands, task content and warning text are dropped; only warning count crosses
(the preview shows the warnings before the press: see the preview column, Warnings).
The one exception is the optional `flagIgnored` key of a launched spawn where
Claude Code ignored the channel option (below, A spawn where Claude Code ignored
the channel option).
Malformed/mismatched receipts, transport loss and ambiguous post-dispatch failures
are **unknown**, not permission for a fresh spawn/key. A timeout does not prove
rollback or stop an already launched agent.

- `E_DECISION_STALE`, `E_IDEMPOTENCY_CONFLICT`, `E_PLACEMENT_TAKEN`,
  `E_INSTANCE_NAME_TAKEN` (an explicit `--name` taken since the preview): consume the
  attempt; any fresh decision/home is advisory. Full new review and explicit new
  confirmation are required. Never auto-suffix, change original refs or auto-apply.
- `E_SPAWN_INCOMPLETE`: a keyed home is recorded but launch/lineage completion is
  unconfirmed. No completed receipt, automatic terminal handoff or second spawn.
  Inspect its existing session through ordinary admitted surfaces.
- Wake result: `wake{requested,saved,error}`, with nullable booleans. Known failure
  means **created, wake not saved**, never retry-spawn. `saved:null` means
  **“Agent created; wake outcome unavailable — check Schedules”**. No inference
  from absence, and no raw provider error message. An explicit first-response
  `wakeScheduleError` can still establish a save failure if home recording failed.

### Long spawns (`worktree` hooks, #802)

From OATS 0.49.0 (feature `worktree-event`) a capability's `worktree` hook can set
up `./work` during the spawn, for up to 30 minutes per hook. The Desktop must not
be what ends it: a kernel answers our SIGTERM by interrupting the hooks and rolling
the spawn back.

- **Deadline.** With `worktree-event` and a confirmed preview whose
  `worktreeHooks` is a non-empty array of n hooks, the CLI deadline is
  **60 s + n × 30 min + 60 s** (`spawnApplyDeadlineMs`); otherwise **60 s**. The
  broker derives it at prepare from the preview the operator confirmed, reports it
  as `applyWithinMs` on its views and passes it to the CLI, which rereads nothing.
- **`pending` from apply.** The `apply` request answers within 50 s: the outcome if
  the CLI settled, else the `pending` view. The CLI keeps running in the broker,
  which owns the job by `spawnRef`; `result` reads its outcome when it settles, and
  the route refreshes the roster then.
- **A created answer carries its roster.** A `complete`, `partial` or
  `incomplete` answer (from `apply`, or from a `result` that found the apply
  settled) is sent once a live read of that one deployment has published into
  the roster, or after 5 s, never past the 50 s above
  ([desktop-load-path.md](desktop-load-path.md), the post-spawn read): the
  roster read that follows it usually shows the instance already.
- **Concurrency.** At most 4 applies run at once backend-wide, one per workspace
  and soul, so one 30-minute spawn does not make every other spawn `E_BUSY`. The
  32-record and 8 MiB bounds stay.
- **A session of its own.** The `oats spawn` child runs in a process session of
  its own (`detached: true` whatever exec a client gives; the default is
  `execFileInSession`), so a hang-up or a Ctrl-C in the terminal that started
  the client does not reach a spawn while its worktree hooks run. Only the
  deadline below ends it, and it signals the child alone.
- **A kill keeps its envelope.** For a `worktree-event` CLI the deadline is the
  transport's own timer, not the exec's (`execFile`'s timeout destroys the child's
  output before signalling it): at the deadline the CLI gets SIGTERM with its
  output still read, and SIGKILL only if it still runs 20 s later
  (`SIGTERM_GRACE_MS`). A complete envelope on stdout (the kernel prints
  `E_INTERRUPTED` after its rollback) is the outcome, failure or success (the
  broker still qualifies a receipt); only with none is it `E_CLI_TIMEOUT`
  (unknown). An older CLI keeps the exec's own timeout (`execFileInSession` arms
  its SIGTERM for a positive one): `E_CLI_TIMEOUT`.
- **Rolled back is known.** A dispatched failure with `E_INTERRUPTED`,
  `E_REQUIRED_HOOK_FAILED` or `E_HOOK_ENVIRONMENT_CONTRACT` and no
  `details.unconfirmed: true` was compensated by the kernel: **refused, nothing
  created**, with the kernel's message (it names the capability and its log). With
  the marker, its cleanup is owed: **unknown**, final (a re-apply of the same key
  cannot finish it; retiring the quarantined home does). Only these three codes:
  every other failure keeps the unknown-unless-proven rule above, `E_SPAWN_FAILED`
  included.
- Without `worktree-event` all of this is today's behaviour: 60 s, a kill is
  unknown, and the three codes are not interpreted.
- **Server spawns.** A spawn on an execution server (`--server`) keeps the legacy
  path: 60 s, no preview, no Check result. A server spawn whose worktree hooks take
  more than about a minute is not yet supported from the Desktop; use the CLI on
  the server.

## Recovery limits and modal ownership

The dialog previews in the background, so the operator reviews the kernel's own
values before pressing **Spawn** (or Mod+Enter) once.

**Editing never waits on the kernel.** Each change schedules a read (250 ms
debounce for typing, at once for a choice). A newer schedule starts its own read
without waiting for one in the air; only the latest ticket may settle, and a
superseded answer, success or failure, is discarded (every completion is
ownership-checked: dialog alive, same workspace mount, latest ticket). An
`E_BUSY` refusal (both server slots held, usually by this dialog's superseded
reads) is retried inside the dialog as soon as one of its reads lands, else
after 400 ms, for about the CLI's timeout, and is never shown while it retries.

### What will be created

Wide, it is the dialog's left column. Below 760px (one column) it follows the
form's last field (Name, then the folded Developer settings) in the form's own
scroll area, above the footer, which stays in view: the Opening instruction,
focused on open, is what shows first. It is moved in the document there, so
reading and Tab order follow the screen.

The column reads top to bottom:

1. **The instance.** Its name comes first and largest (mono, `--fg`). Under it
   is its home (mono, `--muted`), relative to the deployment (the preview's
   `subject.dir`) when the home lies inside it, else `…/` plus its last three
   segments. The full path is the home's `title`.
2. **The facts**, a label/value list in this order:
   - **Works in.** A worktree reads "worktree · branch `<branch>` from
     `<base ref>`"; every other mode keeps its phrase.
   - **Harness.** The badge, the harness and the model (or "default model").
     Where that choice came from sits on its own muted line beneath.
   - **Team.** "`<default>` · default", then a muted "may also join …" line
     naming the other teams in `teams`.
   - **Relationship.** Shown only when the spawn is not independent: "child of
     `<anchor>`".
   - **Setup.** Shown only when the preview's `worktreeHooks` is a non-empty
     array: the capabilities whose `worktree` hook will set up `./work`, in the
     order they run, "(required)" after required ones, then the muted line "Runs
     after the worktree is made. Can take several minutes." The preview reader
     projects `worktreeHooks` tolerantly: anything malformed reads as absent and
     never refuses the preview.
   - **Runs on.** Shown with two or more deployments; in the loading and refusal
     states it shows alone.

   Labels are 11.5px `--muted` and values 12.5px `--fg`. The preview is a size
   container: below 300px of content width the facts stack label-above-value.
3. **Launch prompts**, when the preview reports them (a 0.44 to 0.51 kernel):
   a full-width muted note after the facts, holding the policy sentence and its
   consent source verbatim (see Launch-prompt diagnostics). A 0.52 preview
   reports none, and nothing shows in its place.
4. **Warnings**, when the preview's `warnings` (OATS 0.49.0: strings, one per
   capability warning such as `hook-event-unsupported`, each at most 32 lines)
   holds any: a list after the launch prompts, each warning marked by the word
   "Warning" and an icon, then each of its lines as text, filtered by
   `displayLine`. No Details and no Open capability: a preview warning is only
   its message. A warning never blocks the spawn or changes the footer. At most
   32 show, then "and N more". An older kernel sends none, and nothing shows.

The footer keeps **Cancel** and **Spawn** together, right-aligned on one line, at
every width. The status beside them yields first: its text wraps, or the status
sits on its own line above them.

No field is disabled, hidden or rebuilt because a read is in the air; focus and
caret stay. Before the first settled answer the preview column shows the loading
shape and the footer says **Reading defaults…**. Afterwards the column keeps the
last settled facts, Core capabilities and Capabilities in place, marked
**Updating…** beside the "What will be created" title with `aria-busy="true"` on
the column (words in `--muted`, never faded text), until the answer for the
choices on screen lands; the footer stays quiet. The **Name** fact follows the
form at once: the kernel's name from a settled answer for the same name input,
else the name the form spells (the kernel may still number a taken one), else
"numbered by the kernel". Rows derived from the preview (teams, messaging
identity, defaults in Developer settings) read the last settled answer; the
harness and model defaults read it only while the harness, model and launch
configuration on screen are the ones it answered (desktop/loading-states item 9),
and the work text only for the same work, branch and base. A refusal for the
choices on screen replaces the facts, as does any failure, and stays (marked
Updating…, the footer unchanged) while a poll retries it. An invalid form reads
nothing, so nothing is marked: the settled facts stay without the marker (before
the first answer, the column says the preview reads once the form is valid).

**A press before the preview settled is kept as intent.** Spawn is pressable
whenever the form is valid, except on a settled refusal for exactly these
choices or a settled answer that does not bind the ticked teams. Pressed before
the answer for the choices on screen settled, the button reads **Checking…**
(busy) and nothing is sent. When that answer lands, the ordinary prepare/apply
flow continues with it as the reference for the drift check; if it failed, the
failure shows and nothing spawns; if it did not bind the ticked teams, nothing
spawns. Any edit while the press waits, or **Change soul**, drops it
(**Changed: press Spawn again**): the intent belonged to the choices at press
time. So does a read that cannot answer them (the form turned invalid under it,
or the CLI can no longer preview): the press ends there and never spawns later
without a new press. Sending prepare at
once was rejected: it duplicates the read in the air and turns a value the
operator just typed into a "values changed" drift. Spawn prepares, and the
server applies only if the prepared decision equals the one on screen; if the
kernel now decides differently, nothing is applied and the new values are shown
for another explicit Spawn. An unseen decision never continues into mutation. Any relevant draft,
selection, CLI/workspace or mount change revokes pending read/confirmation authority.
Older completion cannot clear a new task, re-enable a successor operation, steal
focus or navigate another workspace. Roster changes alone are not new user drafts.

The roster poll re-reads the preview (a read, never an apply) only when a fact it
depends on changed (the CLI's identity and features, the workspace, the relation
anchor's roster rows) or when the settled answer is a failure other than a name
refusal; a read in flight or a settled preview otherwise stands. That key does not
watch the rest of the roster or on-disk soul and team edits: this is safe, because
the decision check refuses at **Spawn** if they changed what the kernel decides.

**Check result** (on the pending roster row, below; in the dialog on the view
harness) reads the retained record. Only a prior settled **unknown** may
then invoke apply with the same ref/key as part of that explicit recovery click.
Pending and known outcomes never re-invoke. There is no timer-driven retry.

No Desktop instruction/key journal. Restart/expiry can lose the RAM ref mapping;
a lost submitted ref is unavailable/unknown and mints nothing. Kernel key custody
lasts only while its home survives. If that home is removed, same-key invocation
can follow the normal creation path: it is **not** a replay-only/read-only lookup.
Known retirement/disappearance is a roster question; prior positive keyed-home
observations can block retry after disappearance, but no roster read closes a
concurrent retire race. No lifetime exactly-once/no-resurrection promise.

A qualified completed receipt still needs the current **exact** composite roster
home/root/agent and running-session match before the new instance is reported
(the operator is taken to it, or its row says **New**; see Background spawn). Not-launched, partial, incomplete, unknown, stale or mismatched results
never offer a guessed terminal.
Existing anchored targets, linked-window viewers, locked keys and detach-only
closure remain unchanged. A changed submitted draft can check its original result
but cannot turn that old completion into authority over the new draft.

## Background spawn: the dialog closes on Spawn

Spec C. In the shell, a confirmed local press does not wait for the transaction:
the dialog hands it to the spawn-jobs store (`renderer/spawn-jobs.mjs`, created by
`shell.mjs` as `ctx.spawnJobs`) and closes in the same task as the press, focus
returning where the dialog was opened from. A press still waiting for its preview
(**Checking…**) closes when that preview settles. The dialog stays open only when
the press cannot proceed: an invalid form, a settled refusal, or an answer that
does not bind the ticked teams. Remote (server) spawns keep the in-dialog
transaction. A host without a store (the view harness) runs the same transaction
as the store in the dialog (`packages/client/spawn-transaction.mjs`), so its
outcomes read as the store's: an `E_INTENT_EXPIRED` after the press (the backend
restarted, and its record of the spawn is gone) is an unknown outcome with
**Check result**, never "Nothing was created".

**After the press** (Spec E): once the dialog has closed and returned focus, the
shell reveals the pending row (its ancestors expanded, scrolled into view in the
roster, and highlighted with the selection's fill) without taking focus or
cancelling anything pending. **Show its row** is the explicit request that
also moves focus to it.

The handoff carries the press token, the prepare input, the decision on screen,
the relation and the draft (name, every choice, teams, opening instruction,
wake). The store is single-flight per press token, so one press never starts two
spawns, and per soul (Spec D, #383): while a spawn of a soul is in flight in this
window (**Spawning…** or **Checking result…**), the store refuses another of the same
workspace and soul, and the dialog opened for that soul from any entry point keeps
Spawn disabled under a polite line, "A spawn of <soul> is in progress.", with **Show
its row** (focuses the pending row). It re-enables when the job settles: created,
refused, or unknown (an unknown outcome does not block, or a record lost to a backend
restart would block the soul for the life of the window). Another soul is never
blocked; a new spawn of the same soul afterwards is its own job with a fresh preview. The store then runs the same transaction: prepare (usually a cache hit),
the same decision check against what the operator saw, apply, and `result` for
recovery. Every completion checks that the store is alive and the job is still
its own.

**The pending row.** The job's workspace roster shows a row at once, under its
parent when there is a relation (the placement the kernel will record:
`pendingPlacement`), with the kernel's name from the decision. It reads
**Spawning…** beside a small spinner (the text carries the state; the spinner
stands still under reduced motion), is `aria-disabled` with no instance actions
and no hover card, and is announced once through the roster's polite live
region. It carries the real row's identity (`data-tree-instance` is the decided
home), so when the roster reports that home the real row replaces it in place
and a focused pending row stays focused. While the job is in flight, a reported
row for its home keeps the pending presentation: **Setting up worktree…** when the
roster says `spawnInProgress` (the spawn is running its `worktree` hooks, verified
alive), else **Spawning…**, so it never flashes to a stopped instance with
actions. Any roster row with `spawnInProgress`, whoever spawned it, reads
**Setting up worktree…** the same way, with a muted "since <local time>" when a
job of this window knows its start, and offers no actions. The head's count stays the kernel's
observation; pending rows are not counted. When a spawn is created the shell
reads the roster at once (the created answer comes once the backend has read
that deployment, above), then, while the instance is still awaited, every
700 ms (the dialog's former pace) instead of every 4 s, never two reads at
once (`followSpawns`).

**Window reload.** Pending rows are Desktop-local. A submitted job is kept in the
window's `sessionStorage` until its outcome has been reported: while in flight or
unknown, a failure until it is dismissed or reopened, and any other outcome until
its notification is posted (an outcome settled while another workspace is on
screen is held, and settling is not reporting). It is kept as `{workspace,
deployment, spawnRef, soul, selector, instance, home, placement, startedAt,
deadline, flagSaid}` (`flagSaid: true` once the notice that Claude Code ignored
the channel option was shown, absent before):
`workspace` is the view that owns the job (its pending row, its notices) and
`deployment` the one it spawns in, which every `/api/spawn` request and checked
reply is addressed to (#482; an entry without it is addressed to its view, as
before). Never the opening
instruction, and never the idempotency key, which the renderer does not hold (the
server keeps a `spawnRef` 30 minutes after it settles, bound to the workspace scope,
not to a frame). After a reload the store brings each one back as a pending row and
reads the existing `result` action (every 2 s while the server says pending, until
the job's own `deadline`, then **Outcome unknown**); the outcome is reported like
any other, held for its workspace like any other, and the entry dropped once
reported. A recovered failure's **Reopen spawn** restores the
soul and the exact name only. If the backend itself restarted, its records are gone:
the job reads **Outcome unknown** with Check result, never a guess. Closing the window
or quitting Desktop (a new session) loses the entries; a created instance still
appears through the roster as usual, but a failure is then not reported. The
server sends no signal to a running `oats spawn` child when it exits, so a spawn in
flight completes (at worst the CLI exits 1 after the instance exists, its progress
output having lost its pipe); its owner-only `/tmp/oats-desktop-task-*` directory
stays behind, since the cleanup never runs. A refusal
before apply (no `spawnRef` yet) and a record past the server's 30 minutes (read
as **Outcome unknown**) are the other limits.

**Outcomes.** Creation, roster presence and a live session are separate
observations. Success posts no notification; everything that needs the
operator's attention still does:

| Outcome | What the operator gets |
|---|---|
| `complete` | The row stays **Spawning…** until the roster reports the instance running with a session. Then the operator is **taken to it**: its terminal tab opens and its roster row is the selected one, as clicking the row does. No toast: arriving is the confirmation. When a guard holds (below), they stay where they are and the real row, which replaced the pending one in place, says **New** (text and a dot, never colour alone; AA) until that row is opened or its tab becomes the active one. Either way the roster's polite live region says "<name> spawned" once. Not seen running within 14 s: "Created <name> — not yet visible as a running session. Open it from the roster when it appears." |
| `partial` | The kernel's words (the wake was not saved, or its outcome is unknown) with **View schedules**. A launched one is then followed like `complete` (taken to it when no guard holds; no **New**, no second notice). |
| `incomplete` | "<name> was created but didn't finish starting. Open it from the instance list instead of spawning again." |
| Created, not launched | "Created <name> — not launched. Open its session from the roster." |
| Refused or failed (nothing was created) | The row goes, and a sticky notification gives the reason (the `spawnProblem` fact in the Desktop's words, `renderer/spawn-words.mjs` `spawnText`; Details behind a disclosure) with **Reopen spawn** ("Reopen spawn for <name>"), which reopens the dialog for that soul with the whole draft restored. Only `E_DECISION_STALE`, or a prepared decision that differs from the one the operator saw, reads "These values changed since you last looked. Reopen spawn to check them."; `E_IDEMPOTENCY_CONFLICT`, `E_PLACEMENT_TAKEN`, `E_INSTANCE_NAME_TAKEN` and every other refusal keep their own words. |
| `pending` | The CLI is still running (a long spawn, above). The row stays **Spawning…** (or **Setting up worktree…** once the roster reports the home) and the job reads `result` every 2 s until the outcome settles. Past the job's deadline (the CLI deadline plus 30 s, from the press) it reads **Outcome unknown**, as below. |
| Rolled back (`worktree-event`) | `E_INTERRUPTED`: "The spawn of <name> was interrupted while its worktree was being set up, and was rolled back. Nothing was created." `E_REQUIRED_HOOK_FAILED` / `E_HOOK_ENVIRONMENT_CONTRACT`: "A capability couldn't set up the worktree for <name>, so the spawn was rolled back. Nothing was created." Both as a failure (the row goes; sticky, **Reopen spawn**), with the kernel's message under Details. |
| Cleanup owed (the same codes with `unconfirmed`) | "The spawn of <name> was stopped, but its cleanup didn't finish. Retire <name> from the roster to complete it.", the kernel's message under Details. The pending row goes: the roster's own row (**Spawn didn't finish**) offers Retire, which completes it. No Check result. |
| `unknown` (also `E_INTENT_EXPIRED` after the press: a lost record proves nothing) | The row stays, reading **Outcome unknown**, with a visible **Check result** button ("Check result for <name>") that runs the recovery above. The notification says it once. The row never silently disappears. |

**Never a yank** (`renderer/spawn-follow.mjs`). Taking the operator to the new
instance must never take them from something they are doing, and they are doing
something only if they **acted since the press**. Where focus merely rests does
not count: the dialog's close returns focus to where it was opened from, often a
terminal (⌘N while working in an agent's terminal), and an operator who has not
touched anything since is taken to the new instance from there. They stay where
they are when, at the moment it runs:

- a modal or an overlay is open: a dialog, the palette, Quick Open, a
  lifecycle confirmation, the shortcuts editor, an open popover menu;
- they produced input since the press: a keydown other than a lone modifier
  (Shift, Control, Alt, Meta, Caps Lock…), `input`, `paste` or
  `compositionstart`, anywhere in the window. The shell watches them at the
  document in the capture phase (`watchOperator`), so a terminal that consumes
  its keys still counts them, as an input generation recorded at the press and
  compared later. Only operator-generated (trusted) events count; terminal
  output is not input;
- they moved focus since the press: it is no longer where the dialog returned
  it, after a pointer press of theirs (Tab is already input). Focus the app moves
  itself (the dialog's return landing after a stage switch, a terminal's
  readiness) is not theirs;
- they navigated since the press: opened or activated another tab or view, used
  the sidebar, switched workspace, or the connection changed. The press takes a
  selection-ownership ticket (`watch()`: unlike `begin()` it cancels nothing
  pending) and the connection generation, after the dialog's own focus return,
  and every explicit action supersedes the ticket.

The open resolves the instance against the roster read that showed it ready,
without reading `/api/panel` again, while no later roster read has started and
the workspace is the same (`shownRoster`, #1246); otherwise, and for every
other open, it reads the roster first. The reused answer keeps the read order of
the read that brought it, so a newer roster answer that shows the instance
retired still stops the open (#1237). The open itself is asynchronous (that
read, the terminal's key and readiness), so the same holds all through it: every step of the open, and the
terminal's readiness focus, goes on only while the operator still has not acted,
on the same connection and workspace. Any input during the open stops it,
nothing is selected and the row says **New**; so does any open that never
selects that terminal (refused, superseded or failed). Its tab is selected as
soon as it is made, before the terminal attaches: an operator who moves on while
it attaches was already taken there, so the row is not **New** (and readiness
takes no focus).

Only a spawn pressed in this window is followed; one recovered after a reload is
only marked **New**. Remote (server) spawns keep their own flow.

**Where outcomes appear.** An outcome belongs to its workspace: while another
workspace is on screen it is held, and posted on return. Failure notifications
are exempt from the notification cap and come back after a scope clear; more
than three collapse into one "N spawns failed" entry that expands. The draft is
kept until the spawn completes, Reopen takes it back into the dialog, or the
operator dismisses its failure (the × of that notification).

A CLI without the confirmed-apply fence can still preview but never spawn
locally; submitted uncertainty does not fall back. Launch readiness is not shown
in the dialog; soul readiness remains the soul inspector's (F3b).

Knowledge attachment, ADE auto-PR, branch enumeration, K5 signature verification
and K11 enrolment remain separate open contracts, not parity-complete. Qualification
uses inert CLI/HTTP/IPC/DOM fixtures and computed three-theme AA, not native GUI,
model/auth/lifecycle acceptance. Full root gates belong to PR CI; no operator
spawn/preview/signature fetch, install or restart is part of local testing.

### Launch-prompt diagnostics

An optional preview `launchPromptAnswers` reports the exact home's
`awebDevelopmentChannel` boolean and `consentSource` (string or null). The dialog
shows the development-channel confirmation or none, with available provenance.
Enabled policy also explains that a harness update can block launch until its
qualified prompt fixtures are refreshed, with no fallback key.
A CLI omitting the field makes no policy claim. This is read-only policy,
not observed input or readiness; workspace-trust prompt answering is not included.

Only a 0.44 to 0.51 kernel sends the field. The note is keyed on the decoded
field, never on the kernel's version or a feature. On a 0.52 kernel the dialog
says nothing about the confirmation before a spawn: the kernel now confirms the
prompt on every start that passes the development-channel flag, `oats spawn
--preview` cannot report whether this spawn will (the flag comes from the
provider's spawn hook, which a preview does not run; awebai/oats#912 is where
that changes), and the Desktop does not invent it. What the Desktop shows comes after a start: a home whose last start
stopped at a screen the kernel does not confirm carries the `launch-prompt`
warning in its [Readiness](desktop-readiness.md), and its Activity row says
what differed.

`E_SPAWN_INCOMPLETE` can carry additive `launchPrompts` diagnostics. The CLI,
broker and renderer preserve its retained home and incomplete outcome even if
these optional diagnostics are malformed. A bounded projection keeps blocked or
incomplete status, submitted answer facts, and audit-write outcomes/paths; raw
event rows and OS failure text do not cross this projection. Activity owns event
rendering. Target fields are inspection data only, never terminal input authority.

The `reason` is matched whole against a closed set
(`packages/client/launch-prompt-outcome.mjs`) and shown as the kernel wrote it;
any other string reads "Launch requires inspection". The set holds every reason
of 0.44 to 0.52: six no longer occur from 0.52 (the geometry and consent
reasons) and stay, for the kernels and recorded homes that still send them;
and the kernel's evidence-retention reason is there alone and as the suffix of
the three blocked reasons it can follow. An answer that was sent and whose
completion was not seen is `blocked: observation timeout` with the submitted
answer in `answers`, from every kernel since 0.44: the sentence then says that
an answer was submitted.

A blocked result of 0.52 can carry `differed {nearest, firstDifference {index,
expected, found}}`: the nearest tolerance entry and at most 40 UTF-16 units of
each normalized text from the first difference. `launchPromptDiffered` decodes
it to `{nearest, index, expected, found}`, each side one display line or null.
It is tolerant (a malformed value drops this one fact, never the outcome or the
retained home) and idempotent (the renderer reads again what the server
projected), and it is carried only on a `blocked` result. `found` is what a
terminal showed: untrusted text, shown as an attributed quote and never
compared, parsed or acted on. `differedLines` gives the words and
`launch-differed.mjs` the one component: the lead-in "Where the screen first
differed from the confirmation OATS answers:", then "OATS expected:" and "The
terminal showed:", each in the quote treatment; a side with no text reads "(no
visible text)". The dialog shows it under its status, never inside it, and adds
"Nearest entry <id>, first difference at <index>" to Details. The background
notice is plain text and cannot attribute a quote: with `differed` it adds "Its
Activity shows what OATS expected and what the terminal showed.", and none of
the terminal's text.

Both the dialog and background spawn notice show the reason and direct the
operator to inspect the existing pane, then use `oats session start --home` for
that home. No new spawn or key retry is offered. A submitted answer does not
confirm readiness; empty answers after audit failure do not prove no input was
sent. Result reads and repeated apply requests keep the same retained result.

### A spawn where Claude Code ignored the channel option

From 0.52 a launched spawn's successful answer carries `launchPrompts` in the
start's shape. With the status `flag-ignored` the spawn worked and the instance
has no channel delivery: mail and chat will not wake it. The Desktop says so in
the notice a start shows (`docs/desktop-instance-start.md`): the same reader,
the same two headlines, and "OATS says:" with at most 16 warnings, at most 4096
characters of them, and a count of the rest.

`spawnCreationReceipt` puts the reader's answer on the receipt as the optional
key `flagIgnored` (`{reason, warnings, omitted}`), for that status only, and
only when the answer says the spawn was launched. It is the one place where the
text of an apply's warnings crosses to the renderer: as bounded display lines,
none picked, matched or dropped by its words. Every other warning stays a
count. `spawnApplyView` rebuilds the receipt at each boundary (main's proxy,
the renderer) and reads the key again through the reader's decoder
(`flagIgnoredFact`). It is tolerant: a value that does not decode is dropped
and the receipt stands, and a side that does not know the key drops it the same
way. No fact is larger than `FLAG_IGNORED_BYTES`, which is under the bound of a
retained launch's diagnostics: the broker reserves the larger of the two for a
transaction's outcome, so its reservation is what it was.

A replayed spawn (`replayed: true`) is the home's own record, so it shows the
notice too, with whatever warnings the replay has. A `--no-launch` spawn, any
other status, an answer without `launchPrompts` and one that does not decode
read as before. A spawn routed to a server says nothing: that path reads no
receipt.

The place that ends the apply shows the notice, once per apply. In the shipped
app the spawn-jobs store ends every local spawn. It shows the notice when the
apply settles as created, in a slot of its own beside the job's notice, so a
partial apply shows both and neither replaces the other. It follows the store's
rule for every notice: held while another workspace is on screen, shown on
return. The start's notice differs: it is never shown after a workspace change.
A window reload settles a created job again from `result`, so the stored job
keeps `flagSaid: true` from the moment the notice was shown (never its text),
and a job that has it shows none. A dialog that runs its own apply (a host
without a store) shows the notice at its completion; a reply for a dialog that
is gone stays discarded, as before.

### An ambiguous launch configuration

OATS 0.52 refuses a spawn, and its preview, with `E_LAUNCH_CONFIG_AMBIGUOUS`
when the harness the spawn resolves to has more than one launch configuration
on this machine, none is `default: true`, and the spawn names none.

- **The sentence** is the dialog's, at both stages (the shared fact in
  `spawn-messages.mjs`, then the Desktop's words in `renderer/spawn-words.mjs`): "This machine has more than one launch configuration for this
  soul's harness, and none is the default. Choose one under Launch
  configuration in Developer settings." The kernel's message, which ends with
  its command-line fix, stays in Details with the code.
- **The first entry of the Launch configuration select** reads "No default:
  choose one" while the answer for the choices on screen is this refusal. It
  stays the selected entry, and selectable: it is the state the dialog is in. It
  reads "Default" (or "Default · <name>") again as soon as the answer for the
  choices on screen is anything else. Spawn is disabled as for any refused
  preview. The dialog offers no new choice: not the bare harness, and not
  marking a default.
- **The code is in the preview contract's fixed table** beside
  `E_LAUNCH_CONFIG_UNKNOWN`, so it survives where the kernel's message cannot
  travel: the apply's reason, and a message over the bound. When the file
  changed after the preview on screen, prepare's own read is refused and the
  dialog and the background notice say the same sentence, and that nothing was
  created.
- **A refusal from the apply's own CLI call** is an unknown outcome, as every
  kernel refusal at that stage is (see Apply transport and qualified results):
  the broker infers no rollback from a code it has no binding contract for.
- **A spawn routed to a server** reads no preview here and lists no
  configurations. Its refusal shows as any host refusal does: "Couldn't spawn
  on <server>: <the host's message>", the code behind Details, never the
  sentence above.
- **The soul's page and panel** show a launch `problem`, this one included, in
  their launch box (below).

### A soul's launch problem

`oats souls` and `oats inspect --soul` carry a soul's `Launch` report, and a
report's `problem` is `{code, message, fix}`: the kernel computes the report
for a spawn that names no launch, and sets a problem only where it would
refuse that spawn. The soul page and the soul panel show it in one box, by
one rule for every code (`soul-inspector.mjs` `launchProblem`):

- the Desktop's line, "A spawn of this soul with no launch chosen would be
  refused here.";
- the kernel's `message` and `fix`, each on its own line and through the
  display filter alone, the kernel's name before the first of them that has
  a line to show ("OATS says: <message>", then `<fix>`), by `kernelLines`
  (`packages/client/kernel-lines.mjs`);
- the code behind Details.

The line says what the box shows. It does not say that a soul without a box
will spawn: the report probes no model catalogue, so a spawn can be refused
for more than a report holds.

### An unmatched launch preference

OATS 0.53 refuses a spawn, and its preview, with
`E_LAUNCH_PREFERENCE_UNMATCHED` when `oats-local.yaml` `souls.launch` holds a
key that names no soul the workspace offers, the soul has no entry of its
own, and the spawn names no launch. The kernel sends a `message` and a `fix`,
each at most 1,024 characters.

- **As the dialog opens, the sentence is the Desktop's** (the shared lead in
  `spawn-messages.mjs`, then the Desktop's words in `renderer/spawn-words.mjs`),
  as the status and in the preview's place: "This machine's launch preferences
  name a soul this workspace doesn't offer, so OATS won't choose a launch for
  this soul. To spawn now, pick a harness above, or a launch configuration in
  Developer settings. To fix it for every spawn, correct the preference
  (Details)." Picking either names the launch, so the kernel no longer
  refuses the spawn; the key stays in the file and keeps refusing every other
  soul with no entry of its own.
- **Details hold the code, then the kernel's two texts, each on its own
  line**: "OATS says: <message>", then `<fix>`. `spawnProblem` answers them as
  parts (`kernel: { message, fix }`, with the code alone as `detail`), and the
  dialog draws them with `kernelLines` (`packages/client/kernel-lines.mjs`): each
  text through the display filter alone and whole, the kernel's name before
  the first of them that has a line to show, `[withheld]` with no name
  for a text the filter withholds. Nothing is taken out of the texts and
  nothing is compared: a remedy the kernel says in both is read in both.
  Details stay as the person left them while neither the detail nor a line
  changed.
- **The shorter sentence is read wherever Details hold no kernel text**: "…
  To spawn now, pick a harness or a launch configuration for this spawn. To
  fix it for every spawn, correct the preference." That is a press, and a
  preview whose reason carries no `fix` (a kernel that sends none, or a
  message over the reader's bound). Its Details read `code · message`
  as for any code. A `fix` decides it because `previewFailure` keeps one only
  beside the kernel's own message, never beside a sentence of its table.
- **The code is in the preview contract's fixed table**, so it survives a
  press. When the key appeared after the preview on screen settled, prepare's
  own read is refused: the dialog reads the preview again at once and shows
  the first sentence with the kernel's texts, and the background notice says
  the shorter one and that nothing was created.
- **A refusal from the apply's own CLI call** is an unknown outcome, as every
  kernel refusal at that stage is. The kernel's message says nothing was
  created; a client does not read that from a message.
- **A spawn routed to a server** shows the host's refusal as any host refusal
  does, neither sentence above.
- **Every soul with no entry of its own** carries the refusal as its launch
  `problem` while the key is in the file, and shows it in its launch box
  (above).
